// Reactive persistent store for locations, spots and observations.
// Persists to localStorage so the Markov model learns across sessions.
// Starts blank — no seeded demo data.

import { getTimeContext } from "./time";
import type { Observation, SpotState } from "./markov";

export interface Spot {
  id: string;
  locationId: string;
  name: string;
  createdAt: number;
}

export interface Location {
  id: string;
  name: string;
  createdAt: number;
}

interface Persisted {
  version: 1;
  locations: Location[];
  spots: Spot[];
  observations: Observation[];
}

const KEY = "parkov:v2";

function uid(prefix: string): string {
  const r =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${r}`;
}

function emptyStore(): Persisted {
  return { version: 1, locations: [], spots: [], observations: [] };
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      const empty = emptyStore();
      localStorage.setItem(KEY, JSON.stringify(empty));
      return empty;
    }
    const parsed = JSON.parse(raw) as Persisted;
    if (!parsed.locations || !parsed.spots || !parsed.observations) throw new Error("bad shape");
    // Backfill daytime phase for observations saved before phase existed.
    for (const o of parsed.observations) {
      if (!("phase" in o) || !(o as Observation).phase) {
        const h = typeof o.hour === "number" ? o.hour : new Date(o.ts).getHours();
        (o as Observation).phase =
          h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 22 ? "evening" : "night";
      }
    }
    return parsed;
  } catch {
    const empty = emptyStore();
    try {
      localStorage.setItem(KEY, JSON.stringify(empty));
    } catch {
      /* storage unavailable */
    }
    return empty;
  }
}

function persist(data: Persisted) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* ignore quota errors */
  }
}

// --- Svelte 5 reactive store (this file is `.svelte.ts` so runes work) ---

let locations = $state<Location[]>([]);
let spots = $state<Spot[]>([]);
let observations = $state<Observation[]>([]);
let ready = $state(false);

export function initStore() {
  if (ready) return;
  const data = load();
  locations = data.locations;
  spots = data.spots;
  observations = data.observations;
  ready = true;
}

function save() {
  persist({ version: 1, locations, spots, observations });
}

export function getStore() {
  return {
    get ready() {
      return ready;
    },
    get locations() {
      return locations;
    },
    get spots() {
      return spots;
    },
    get observations() {
      return observations;
    },
  };
}

export function spotsOf(locationId: string): Spot[] {
  return spots.filter((s) => s.locationId === locationId);
}

export function obsOfSpot(spotId: string): Observation[] {
  return observations.filter((o) => o.spotId === spotId);
}

export function recordObservation(
  locationId: string,
  spotId: string,
  state: SpotState,
  at: Date = new Date(),
): Observation {
  const ctx = getTimeContext(at);
  const obs: Observation = {
    id: uid("obs"),
    locationId,
    spotId,
    ts: at.getTime(),
    dow: ctx.dow,
    hour: at.getHours(),
    window: ctx.window,
    kind: ctx.kind,
    phase: ctx.phase,
    state,
  };
  observations = [...observations, obs];
  save();
  return obs;
}

export function undoObservation(id: string) {
  observations = observations.filter((o) => o.id !== id);
  save();
}

export function addLocation(name: string): Location {
  const loc: Location = { id: uid("loc"), name: name.trim() || "New location", createdAt: Date.now() };
  locations = [...locations, loc];
  save();
  return loc;
}

export function renameLocation(id: string, name: string) {
  const n = name.trim();
  if (!n) return;
  locations = locations.map((l) => (l.id === id ? { ...l, name: n } : l));
  save();
}

export function deleteLocation(id: string) {
  locations = locations.filter((l) => l.id !== id);
  const spotIds = new Set(spots.filter((s) => s.locationId === id).map((s) => s.id));
  spots = spots.filter((s) => s.locationId !== id);
  observations = observations.filter((o) => o.locationId !== id && !spotIds.has(o.spotId));
  save();
}

export function addSpot(locationId: string, name: string): Spot {
  const spot: Spot = {
    id: uid("spot"),
    locationId,
    name: name.trim() || `Spot ${spotsOf(locationId).length + 1}`,
    createdAt: Date.now(),
  };
  spots = [...spots, spot];
  save();
  return spot;
}

export function renameSpot(id: string, name: string) {
  const n = name.trim();
  if (!n) return;
  spots = spots.map((s) => (s.id === id ? { ...s, name: n } : s));
  save();
}

export function deleteSpot(id: string) {
  spots = spots.filter((s) => s.id !== id);
  observations = observations.filter((o) => o.spotId !== id);
  save();
}

export function resetAll() {
  const empty = emptyStore();
  locations = empty.locations;
  spots = empty.spots;
  observations = empty.observations;
  save();
}

/** @deprecated Use resetAll() — kept for backwards compat. */
export function resetDemo() {
  resetAll();
}

export function clearHistory(locationId?: string) {
  if (!locationId) observations = [];
  else {
    const spotIds = new Set(spotsOf(locationId).map((s) => s.id));
    observations = observations.filter((o) => o.locationId !== locationId && !spotIds.has(o.spotId));
  }
  save();
}

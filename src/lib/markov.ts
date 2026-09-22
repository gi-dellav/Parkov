// First-order 2-state Markov model per spot + hierarchical time backoff.
//
// States: "free" (you could park) vs "occupied" (you couldn't).
// For a fixed (spot, time-bucket) we collect the observation sequence
// ordered by time and count transitions F->F, F->O, O->F, O->O.
// With Laplace smoothing we get a transition matrix, and the stationary
// probability of Free is the context-conditional free-spot estimate.
//
  // Because per-(dow, window) data is sparse, we blend five levels:
//   L1 dow+window   e.g. "Mon 09–12"      (most specific)
//   L2 kind+window  e.g. "weekday 09–12"  (model-only, hidden in UI)
//   L3 phase+window e.g. "morning 09–12"
//   L4 window only  e.g. "09–12 any day"
//   L5 spot global  (all observations for the spot)
//   L0 uniform 0.5 prior
// Weights favour specific data when it exists, and fall back gracefully.

import type { TimeContext } from "./time";

export type SpotState = "free" | "occupied";

export interface Observation {
  id: string;
  locationId: string;
  spotId: string;
  ts: number;
  dow: number;
  hour: number;
  window: number;
  kind: "weekday" | "weekend";
  phase: "morning" | "afternoon" | "evening" | "night";
  state: SpotState;
}

export interface TransitionCounts {
  ff: number;
  fo: number;
  of: number;
  oo: number;
  freeCount: number;
  occCount: number;
  total: number;
}

export interface TransitionMatrix {
  pFF: number;
  pFO: number;
  pOF: number;
  pOO: number;
}

export const EMPTY_COUNTS: TransitionCounts = {
  ff: 0,
  fo: 0,
  of: 0,
  oo: 0,
  freeCount: 0,
  occCount: 0,
  total: 0,
};

export function countTransitions(sorted: Observation[]): TransitionCounts {
  const c: TransitionCounts = { ...EMPTY_COUNTS };
  for (const o of sorted) {
    if (o.state === "free") c.freeCount += 1;
    else c.occCount += 1;
  }
  c.total = sorted.length;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]?.state;
    const cur = sorted[i]?.state;
    if (prev === "free" && cur === "free") c.ff += 1;
    else if (prev === "free" && cur === "occupied") c.fo += 1;
    else if (prev === "occupied" && cur === "free") c.of += 1;
    else if (prev === "occupied" && cur === "occupied") c.oo += 1;
  }
  return c;
}

export function transitionMatrix(
  c: TransitionCounts,
  alpha = 1,
): TransitionMatrix {
  const fromFree = c.ff + c.fo;
  const fromOcc = c.of + c.oo;
  // Laplace smoothing: pretend we saw `alpha` of each transition.
  const pFF = (c.ff + alpha) / (fromFree + 2 * alpha);
  const pOF = (c.of + alpha) / (fromOcc + 2 * alpha);
  return { pFF, pFO: 1 - pFF, pOF, pOO: 1 - pOF };
}

/** Stationary P(Free) = pOF / (pOF + pFO). 0.5 when nothing learned. */
export function stationaryFree(m: TransitionMatrix): number {
  const denom = m.pOF + m.pFO;
  if (denom <= 0) return 0.5;
  return m.pOF / denom;
}

/** One-step prediction from a known current state. */
export function stepAhead(m: TransitionMatrix, from: SpotState): number {
  return from === "free" ? m.pFF : m.pOF;
}

export interface LevelEstimate {
  key: string;
  label: string;
  p: number;
  n: number;
  matrix: TransitionMatrix;
  counts: TransitionCounts;
  lastState: SpotState | null;
}

export interface SpotPrediction {
  pFree: number;
  confidence: "low" | "medium" | "high";
  levels: LevelEstimate[];
  weights: number[];
  lastState: SpotState | null;
  totalObs: number;
}

function level(
  allSorted: Observation[],
  filter: (o: Observation) => boolean,
  key: string,
  label: string,
): LevelEstimate {
  const seq = allSorted.filter(filter);
  const counts = countTransitions(seq);
  const matrix = transitionMatrix(counts);
  const p = seq.length === 0 ? 0.5 : stationaryFree(matrix);
  return {
    key,
    label,
    p,
    n: seq.length,
    matrix,
    counts,
    lastState: seq.length > 0 ? (seq[seq.length - 1]?.state ?? null) : null,
  };
}

const LEVEL_WEIGHT = [1, 0.5, 0.5, 0.25, 0.125];

export function predictFree(
  observations: Observation[],
  ctx: TimeContext,
): SpotPrediction {
  const sorted = [...observations].sort((a, b) => a.ts - b.ts);
  const dowKey = `${ctx.dow}@${ctx.window}`;
  const levels: LevelEstimate[] = [
    level(sorted, (o) => o.dow === ctx.dow && o.window === ctx.window, dowKey, "day + window"),
    level(sorted, (o) => o.kind === ctx.kind && o.window === ctx.window, `${ctx.kind}@${ctx.window}`, `${ctx.kind} + window`),
    level(sorted, (o) => o.phase === ctx.phase && o.window === ctx.window, `${ctx.phase}@${ctx.window}`, `${ctx.phase} + window`),
    level(sorted, (o) => o.window === ctx.window, `w${ctx.window}`, "window only"),
    level(sorted, () => true, "all", "spot overall"),
  ];

  // Weight = n * levelDiscount, plus a constant pull toward 0.5.
  const PRIOR_P = 0.5;
  const PRIOR_W = 2;
  const weights = levels.map((l, i) => l.n * (LEVEL_WEIGHT[i] ?? 0.1));
  let num = PRIOR_P * PRIOR_W;
  let den = PRIOR_W;
  levels.forEach((l, i) => {
    num += l.p * (weights[i] ?? 0);
    den += weights[i] ?? 0;
  });
  const pFree = den > 0 ? num / den : PRIOR_P;
  const specific = levels[0]?.n ?? 0;
  const totalObs = sorted.length;
  const confidence = specific >= 12 || totalObs >= 60 ? "high" : specific >= 4 || totalObs >= 15 ? "medium" : "low";
  return {
    pFree,
    confidence,
    levels,
    weights,
    lastState: sorted.length > 0 ? (sorted[sorted.length - 1]?.state ?? null) : null,
    totalObs,
  };
}

/** Rank spot ids best-first by predicted P(free). */
export function rankSpots(
  obsBySpot: Map<string, Observation[]>,
  spotIds: string[],
  ctx: TimeContext,
): { spotId: string; pFree: number }[] {
  return spotIds
    .map((spotId) => ({
      spotId,
      pFree: predictFree(obsBySpot.get(spotId) ?? [], ctx).pFree,
    }))
    .sort((a, b) => b.pFree - a.pFree);
}

export function formatPct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

<script lang="ts">
  import { onMount } from "svelte";
  import PwaUpdate from "./PwaUpdate.svelte";
  import {
    initStore,
    getStore,
    spotsOf,
    recordObservation,
    undoObservation,
    addLocation,
    deleteLocation,
    addSpot,
    deleteSpot,
    resetAll,
    clearHistory,
  } from "./lib/store.svelte";
  import type { SpotState } from "./lib/markov";
  import { predictFree, rankSpots, formatPct } from "./lib/markov";
  import { getTimeContext, formatContext } from "./lib/time";
  import type { TimeContext } from "./lib/time";

  initStore();
  const store = getStore();

  let now = $state(new Date());
  onMount(() => {
    const t = setInterval(() => (now = new Date()), 20_000);
    return () => clearInterval(t);
  });

  const ctx: TimeContext = $derived(getTimeContext(now));

  // --- selection ---
  let selectedLocationId = $state<string | null>(null);
  $effect(() => {
    const locs = store.locations;
    if (locs.length === 0) {
      if (selectedLocationId !== null) selectedLocationId = null;
      return;
    }
    if (!selectedLocationId || !locs.some((l) => l.id === selectedLocationId)) {
      selectedLocationId = locs[0]?.id ?? null;
    }
  });
  const location = $derived(store.locations.find((l) => l.id === selectedLocationId) ?? null);
  const locSpots = $derived(selectedLocationId ? spotsOf(selectedLocationId) : []);
  const locObs = $derived(
    selectedLocationId
      ? store.observations.filter((o) => o.locationId === selectedLocationId)
      : [],
  );

  // --- predictions ---
  const ranked = $derived.by(() => {
    const bySpot = new Map<string, typeof locObs>();
    for (const s of locSpots) bySpot.set(s.id, []);
    for (const o of locObs) {
      const arr = bySpot.get(o.spotId);
      if (arr) arr.push(o);
    }
    return rankSpots(bySpot, locSpots.map((s) => s.id), ctx);
  });

  function predFor(spotId: string) {
    return predictFree(
      locObs.filter((o) => o.spotId === spotId),
      ctx,
    );
  }

  // --- single-recommendation hunt ---
  // Only the top candidate is shown. Pressing "Full" logs "occupied"
  // and advances to the next candidate. A spot marked full in this hunt
  // is never re-suggested until the user parks somewhere (new hunt) or
  // every spot has been tried (exhausted state).
  let skippedIds = $state<string[]>([]);
  let parkedId = $state<string | null>(null);
  let showAll = $state(false);

  // --- feedback ---
  let lastFeedback = $state<{
    id: string;
    spotId: string;
    spotName: string;
    state: SpotState;
  } | null>(null);
  let feedbackTimer: ReturnType<typeof setTimeout> | null = null;

  // New location → fresh hunt.
  $effect(() => {
    void selectedLocationId;
    skippedIds = [];
    parkedId = null;
    showAll = false;
    lastFeedback = null;
  });

  const candidates = $derived(ranked.filter((r) => !skippedIds.includes(r.spotId)));
  const current = $derived(parkedId ? null : (candidates[0] ?? null));
  const currentSpot = $derived(
    current ? (locSpots.find((s) => s.id === current.spotId) ?? null) : null,
  );
  const currentPred = $derived(current ? predFor(current.spotId) : null);
  const exhausted = $derived(
    !parkedId && ranked.length > 0 && candidates.length === 0,
  );
  const parkedSpot = $derived(
    parkedId ? (locSpots.find((s) => s.id === parkedId) ?? null) : null,
  );
  const position = $derived(
    current ? ranked.findIndex((r) => r.spotId === current.spotId) + 1 : 0,
  );

  function flashFeedback(f: {
    id: string;
    spotId: string;
    spotName: string;
    state: SpotState;
  }) {
    lastFeedback = f;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => (lastFeedback = null), 8_000);
  }

  function logParked(spotId: string) {
    if (!selectedLocationId) return;
    const spot = locSpots.find((s) => s.id === spotId);
    if (!spot) return;
    const obs = recordObservation(selectedLocationId, spotId, "free", new Date());
    now = new Date();
    // A successful park ends the hunt: previously-full spots become
    // eligible again for the next hunt.
    parkedId = spotId;
    skippedIds = [];
    showAll = false;
    flashFeedback({ id: obs.id, spotId, spotName: spot.name, state: "free" });
  }

  function logFull(spotId: string) {
    if (!selectedLocationId) return;
    const spot = locSpots.find((s) => s.id === spotId);
    if (!spot) return;
    const obs = recordObservation(selectedLocationId, spotId, "occupied", new Date());
    now = new Date();
    if (!skippedIds.includes(spotId)) skippedIds = [...skippedIds, spotId];
    flashFeedback({ id: obs.id, spotId, spotName: spot.name, state: "occupied" });
  }

  function undoLast() {
    if (!lastFeedback) return;
    const { id, spotId, state } = lastFeedback;
    undoObservation(id);
    if (state === "occupied") {
      skippedIds = skippedIds.filter((s) => s !== spotId);
    } else {
      if (parkedId === spotId) parkedId = null;
    }
    lastFeedback = null;
  }

  function startOver() {
    skippedIds = [];
    parkedId = null;
    lastFeedback = null;
  }

  // --- forms ---
  let newLocName = $state("");
  let newSpotName = $state("");
  let showSettings = $state(false);
  let showAddSpot = $state(false);
  let aboutOpen = $state(false);

  function submitLocation() {
    const name = newLocName.trim();
    if (!name) return;
    const loc = addLocation(name);
    selectedLocationId = loc.id;
    newLocName = "";
  }

  function submitSpot() {
    if (!selectedLocationId) return;
    const name = newSpotName.trim();
    addSpot(selectedLocationId, name || `Spot ${locSpots.length + 1}`);
    newSpotName = "";
    showAddSpot = false;
  }
</script>

<main class="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center bg-white px-6 pt-16 pb-16 text-center text-black">
  <!-- header -->
  <header class="flex flex-col items-center">
    <p class="text-xs tracking-[0.3em] uppercase">Parkov</p>
    <p class="mt-4 text-sm">{formatContext(ctx)}</p>
  </header>

  {#if store.locations.length === 0}
    <!-- blank start -->
    <section class="mt-16 flex w-full flex-col items-center">
      <h1 class="text-3xl font-medium tracking-tight">Where will you park?</h1>
      <p class="mt-3 text-sm">Add a location to begin.</p>
      <form
        class="mt-8 flex w-full max-w-xs flex-col items-center gap-3"
        onsubmit={(e) => {
          e.preventDefault();
          submitLocation();
        }}
      >
        <input
          class="w-full rounded-full border border-black bg-white px-5 py-3 text-center text-sm outline-none placeholder:text-black/40"
          placeholder="e.g. Office Garage"
          bind:value={newLocName}
          maxlength={60}
        />
        <button type="submit" class="w-full rounded-full border border-black bg-black px-5 py-3 text-sm font-medium text-white">
          Add location
        </button>
      </form>
    </section>
  {:else}
    <!-- locations (only shown when there is a choice to make) -->
    {#if store.locations.length > 1}
    <nav class="mt-10 flex max-w-full flex-wrap items-center justify-center gap-2" aria-label="Locations">
      {#each store.locations as loc (loc.id)}
        <button
          type="button"
          aria-pressed={loc.id === selectedLocationId}
          onclick={() => (selectedLocationId = loc.id)}
          class="rounded-full border border-black px-4 py-1.5 text-sm transition {loc.id === selectedLocationId ? 'bg-black text-white' : 'bg-white text-black'}"
        >
          {loc.name}
        </button>
      {/each}
    </nav>
    {/if}

    {#if location}
      {#if parkedSpot}
        <!-- parked confirmation -->
        <section class="mt-14 flex w-full flex-col items-center" aria-label="Parked">
          <p class="text-xs tracking-[0.25em] uppercase">{location.name}</p>
          <h2 class="mt-4 text-4xl font-medium tracking-tight">{parkedSpot.name}</h2>
          <p class="mt-3 text-sm">Parked — nice.</p>
          <div class="mt-8 flex w-full max-w-xs flex-col gap-3">
            <button
              type="button"
              onclick={startOver}
              class="w-full rounded-full border border-black bg-black px-4 py-3.5 text-sm font-medium text-white active:scale-[0.99]"
            >
              Find another spot
            </button>
          </div>
          {#if lastFeedback}
            <p class="mt-4 text-xs">
              Logged Parked at {lastFeedback.spotName}
              <button type="button" class="ml-2 underline underline-offset-4" onclick={undoLast}>
                Undo
              </button>
            </p>
          {/if}
        </section>
      {:else if currentSpot && currentPred && current}
        <!-- single best bet -->
        <section class="mt-14 flex w-full flex-col items-center" aria-label="Best spot">
          <p class="text-xs tracking-[0.25em] uppercase">{location.name}</p>
          <h2 class="mt-4 text-4xl font-medium tracking-tight">{currentSpot.name}</h2>
          <p class="mt-2 text-7xl font-medium tabular-nums">{formatPct(currentPred.pFree)}</p>
          <p class="mt-3 text-xs">
            free · {currentPred.totalObs} logs
            {#if ranked.length > 1}
              <span class="text-black/50">· {position} of {ranked.length}</span>
            {/if}
          </p>

          <div class="mt-8 grid w-full max-w-xs grid-cols-2 gap-3">
            <button
              type="button"
              onclick={() => logParked(current.spotId)}
              class="rounded-full border border-black bg-black px-4 py-3.5 text-sm font-medium text-white active:scale-[0.99]"
            >
              Parked
            </button>
            <button
              type="button"
              onclick={() => logFull(current.spotId)}
              class="rounded-full border border-black bg-white px-4 py-3.5 text-sm font-medium text-black active:scale-[0.99]"
            >
              Full
            </button>
          </div>

          {#if lastFeedback}
            <p class="mt-4 text-xs">
              Logged {lastFeedback.state === "free" ? "Parked" : "Full"} at {lastFeedback.spotName}
              <button type="button" class="ml-2 underline underline-offset-4" onclick={undoLast}>
                Undo
              </button>
            </p>
          {/if}

          {#if skippedIds.length > 0}
            <p class="mt-3 text-[11px] text-black/50">
              Skipped {skippedIds.length} full spot{skippedIds.length === 1 ? "" : "s"}
            </p>
          {/if}

          <!-- optional full ranking -->
          {#if ranked.length > 1}
            <button
              type="button"
              class="mt-8 text-xs underline underline-offset-4"
              onclick={() => (showAll = !showAll)}
              aria-expanded={showAll}
            >
              {showAll ? "Hide all spots" : `See all spots (${ranked.length})`}
            </button>
            {#if showAll}
              <ul class="mt-4 flex w-full max-w-xs flex-col items-center">
                {#each candidates as r (r.spotId)}
                  {@const spot = locSpots.find((s) => s.id === r.spotId)}
                  {@const p = predFor(r.spotId)}
                  {#if spot}
                    <li class="w-full border-t border-black/15 py-4 last:border-b">
                      <p class="text-sm font-medium">
                        {spot.name}{r.spotId === current.spotId ? " · current" : ""}
                      </p>
                      <p class="mt-1 text-2xl tabular-nums">{formatPct(r.pFree)}</p>
                      <p class="mt-1 text-[11px] text-black/50">{p.totalObs} logs</p>
                      {#if r.spotId !== current.spotId}
                        <div class="mt-3 grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onclick={() => logParked(spot.id)}
                            class="rounded-full border border-black bg-white px-3 py-2 text-xs font-medium"
                          >
                            Parked
                          </button>
                          <button
                            type="button"
                            onclick={() => logFull(spot.id)}
                            class="rounded-full border border-black bg-white px-3 py-2 text-xs font-medium"
                          >
                            Full
                          </button>
                        </div>
                      {/if}
                    </li>
                  {/if}
                {/each}
              </ul>
            {/if}
          {/if}

          <!-- add spot -->
          <div class="mt-8 flex w-full max-w-xs flex-col items-center">
            {#if !showAddSpot}
              <button
                type="button"
                class="text-xs underline underline-offset-4"
                onclick={() => (showAddSpot = true)}
              >
                + Add spot
              </button>
            {:else}
              <form
                class="flex w-full flex-row items-center gap-2"
                onsubmit={(e) => {
                  e.preventDefault();
                  submitSpot();
                }}
              >
                <input
                  class="min-w-0 flex-1 rounded-full border border-black bg-white px-5 py-2.5 text-center text-sm outline-none placeholder:text-black/40"
                  placeholder="New spot name"
                  bind:value={newSpotName}
                  maxlength={60}
                />
                <button type="submit" class="shrink-0 rounded-full border border-black bg-black px-5 py-2.5 text-sm font-medium text-white">
                  Add
                </button>
                <button
                  type="button"
                  class="shrink-0 px-2 py-2 text-xs underline underline-offset-4"
                  onclick={() => {
                    showAddSpot = false;
                    newSpotName = "";
                  }}
                >
                  Cancel
                </button>
              </form>
            {/if}
          </div>
        </section>
      {:else if exhausted}
        <!-- every spot tried -->
        <section class="mt-14 flex w-full flex-col items-center" aria-label="All full">
          <p class="text-xs tracking-[0.25em] uppercase">{location.name}</p>
          <h2 class="mt-4 text-3xl font-medium tracking-tight">All spots full</h2>
          <p class="mt-3 text-sm text-black/60">You tried all {ranked.length} spots.</p>
          <div class="mt-8 flex w-full max-w-xs flex-col gap-3">
            <button
              type="button"
              onclick={startOver}
              class="w-full rounded-full border border-black bg-black px-4 py-3.5 text-sm font-medium text-white active:scale-[0.99]"
            >
              Start over
            </button>
          </div>
          {#if lastFeedback}
            <p class="mt-4 text-xs">
              Logged {lastFeedback.state === "free" ? "Parked" : "Full"} at {lastFeedback.spotName}
              <button type="button" class="ml-2 underline underline-offset-4" onclick={undoLast}>
                Undo
              </button>
            </p>
          {/if}
          <ul class="mt-8 flex w-full max-w-xs flex-col items-center">
            {#each ranked as r (r.spotId)}
              {@const spot = locSpots.find((s) => s.id === r.spotId)}
              {#if spot}
                <li class="flex w-full items-center justify-between border-t border-black/15 py-3 last:border-b">
                  <span class="text-sm">{spot.name}</span>
                  <button
                    type="button"
                    onclick={() => logParked(spot.id)}
                    class="rounded-full border border-black bg-white px-4 py-1.5 text-xs font-medium"
                  >
                    Parked here
                  </button>
                </li>
              {/if}
            {/each}
          </ul>
        </section>
      {:else}
        <!-- location has no spots yet -->
        <section class="mt-16 flex w-full flex-col items-center">
          <h2 class="text-2xl font-medium tracking-tight">{location.name}</h2>
          <p class="mt-3 text-sm">Add your first spot.</p>
          <form
            class="mt-8 flex w-full max-w-xs flex-col items-center gap-3"
            onsubmit={(e) => {
              e.preventDefault();
              submitSpot();
            }}
          >
            <input
              class="w-full rounded-full border border-black bg-white px-5 py-3 text-center text-sm outline-none placeholder:text-black/40"
              placeholder="e.g. P4"
              bind:value={newSpotName}
              maxlength={60}
            />
            <button type="submit" class="w-full rounded-full border border-black bg-black px-5 py-3 text-sm font-medium text-white">
              Add spot
            </button>
          </form>
        </section>
      {/if}

      <!-- settings -->
      <div class="mt-16 flex w-full max-w-xs flex-col items-center">
        <button
          type="button"
          class="text-xs underline underline-offset-4"
          onclick={() => (showSettings = !showSettings)}
          aria-expanded={showSettings}
        >
          {showSettings ? "Hide settings" : "Settings"}
        </button>
        {#if showSettings}
          <div class="mt-6 w-full rounded-3xl border border-black/15 px-5 py-6 text-left">
            <section aria-label="Locations">
              <h3 class="text-[11px] font-medium tracking-[0.2em] uppercase text-black/50">Locations</h3>
              <form
                class="mt-3 flex w-full flex-row items-center gap-2"
                onsubmit={(e) => {
                  e.preventDefault();
                  submitLocation();
                }}
              >
                <input
                  class="min-w-0 flex-1 rounded-full border border-black/25 bg-white px-4 py-2 text-sm outline-none placeholder:text-black/40 focus:border-black"
                  placeholder="New location"
                  bind:value={newLocName}
                  maxlength={60}
                />
                <button type="submit" class="shrink-0 rounded-full border border-black bg-white px-4 py-2 text-xs font-medium">
                  Add
                </button>
              </form>
            </section>

            {#if locSpots.length > 0}
              <section class="mt-6 border-t border-black/10 pt-5" aria-label="Spots">
                <h3 class="text-[11px] font-medium tracking-[0.2em] uppercase text-black/50">
                  Spots · {locSpots.length}
                </h3>
                <ul class="mt-2 divide-y divide-black/10">
                  {#each locSpots as s (s.id)}
                    <li class="flex items-center justify-between gap-3 py-2.5">
                      <span class="truncate text-sm">{s.name}</span>
                      <button
                        type="button"
                        class="shrink-0 text-xs text-black/50 underline underline-offset-4 hover:text-black"
                        onclick={() => {
                          if (confirm(`Delete spot "${s.name}"?`)) deleteSpot(s.id);
                        }}
                      >
                        Delete
                      </button>
                    </li>
                  {/each}
                </ul>
              </section>
            {/if}

            <section class="mt-6 border-t border-black/10 pt-5" aria-label="Danger zone">
              <h3 class="text-[11px] font-medium tracking-[0.2em] uppercase text-black/50">Data</h3>
              <div class="mt-3 flex flex-col gap-2">
                <button
                  type="button"
                  class="w-full rounded-full border border-black/25 bg-white px-4 py-2.5 text-xs"
                  onclick={() => {
                    if (confirm(`Delete "${location.name}" and all its spots + history?`)) deleteLocation(location.id);
                  }}
                >
                  Delete this location
                </button>
                <div class="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    class="rounded-full border border-black/25 bg-white px-4 py-2.5 text-xs"
                    onclick={() => {
                      if (confirm("Clear this location's history?")) clearHistory(selectedLocationId ?? undefined);
                    }}
                  >
                    Clear history
                  </button>
                  <button
                    type="button"
                    class="rounded-full border border-black/25 bg-white px-4 py-2.5 text-xs"
                    onclick={() => {
                      if (confirm("Delete everything and start blank?")) {
                        resetAll();
                        selectedLocationId = null;
                      }
                    }}
                  >
                    Reset all
                  </button>
                </div>
              </div>
            </section>
          </div>
        {/if}
      </div>
    {/if}
  {/if}

  <footer class="mt-16">
    <div class="info-wrap">
      <button
        type="button"
        class="info-text"
        aria-label="About Parkov"
        aria-expanded={aboutOpen}
        onclick={() => (aboutOpen = !aboutOpen)}
      >
        info
      </button>
      {#if aboutOpen}
        <div class="about-card-top" role="dialog" aria-label="About Parkov">
          <p class="about-title">Parkov</p>
          <p class="about-sub">Built by Giuseppe Della Vedova</p>
          <div class="about-links">
            <a
              class="about-link"
              href="https://github.com/gi-dellav/Parkov"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
            <a
              class="about-link"
              href="https://www.linkedin.com/in/giuseppe-della-vedova-a2890a413/"
              target="_blank"
              rel="noopener noreferrer"
            >
              LinkedIn
            </a>
          </div>
        </div>
      {/if}
    </div>
  </footer>
</main>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape") aboutOpen = false;
  }}
  onclick={(e) => {
    if (aboutOpen && !(e.target as HTMLElement).closest(".info-wrap")) aboutOpen = false;
  }}
/>

<PwaUpdate />

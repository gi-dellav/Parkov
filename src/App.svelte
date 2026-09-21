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
  const bestId = $derived(ranked[0]?.spotId ?? null);
  const bestSpot = $derived(locSpots.find((s) => s.id === bestId) ?? null);
  const bestPred = $derived(bestId ? predictFree(locObs.filter((o) => o.spotId === bestId), ctx) : null);

  function predFor(spotId: string) {
    return predictFree(
      locObs.filter((o) => o.spotId === spotId),
      ctx,
    );
  }

  // --- feedback ---
  let lastFeedback = $state<{ id: string; spotName: string; state: SpotState } | null>(null);
  let feedbackTimer: ReturnType<typeof setTimeout> | null = null;

  function flashFeedback(f: { id: string; spotName: string; state: SpotState }) {
    lastFeedback = f;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => (lastFeedback = null), 8_000);
  }

  function logResult(spotId: string, state: SpotState) {
    if (!selectedLocationId) return;
    const spot = locSpots.find((s) => s.id === spotId);
    if (!spot) return;
    const obs = recordObservation(selectedLocationId, spotId, state, new Date());
    now = new Date();
    flashFeedback({ id: obs.id, spotName: spot.name, state });
  }

  function undoLast() {
    if (!lastFeedback) return;
    undoObservation(lastFeedback.id);
    lastFeedback = null;
  }

  // --- forms ---
  let newLocName = $state("");
  let newSpotName = $state("");
  let showSettings = $state(false);

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
    <!-- locations -->
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

    {#if location}
      {#if bestSpot && bestPred}
        <!-- best bet -->
        <section class="mt-14 flex w-full flex-col items-center" aria-label="Best spot">
          <p class="text-xs tracking-[0.25em] uppercase">{location.name}</p>
          <h2 class="mt-4 text-4xl font-medium tracking-tight">{bestSpot.name}</h2>
          <p class="mt-2 text-7xl font-medium tabular-nums">{formatPct(bestPred.pFree)}</p>
          <p class="mt-3 text-xs">free · {bestPred.totalObs} logs</p>

          <div class="mt-8 grid w-full max-w-xs grid-cols-2 gap-3">
            <button
              type="button"
              onclick={() => bestId && logResult(bestId, "free")}
              class="rounded-full border border-black bg-black px-4 py-3.5 text-sm font-medium text-white active:scale-[0.99]"
            >
              Parked
            </button>
            <button
              type="button"
              onclick={() => bestId && logResult(bestId, "occupied")}
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
        </section>

        <!-- all spots -->
        <section class="mt-14 flex w-full flex-col items-center" aria-label="All spots">
          <ul class="flex w-full max-w-xs flex-col items-center">
            {#each ranked as r (r.spotId)}
              {@const spot = locSpots.find((s) => s.id === r.spotId)}
              {@const p = predFor(r.spotId)}
              {#if spot}
                <li class="w-full border-t border-black py-4 last:border-b">
                  <p class="text-sm font-medium">{spot.name}</p>
                  <p class="mt-1 text-2xl tabular-nums">{formatPct(r.pFree)}</p>
                  <div class="mt-3 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onclick={() => logResult(spot.id, "free")}
                      class="rounded-full border border-black bg-white px-3 py-2 text-xs font-medium"
                    >
                      Parked
                    </button>
                    <button
                      type="button"
                      onclick={() => logResult(spot.id, "occupied")}
                      class="rounded-full border border-black bg-white px-3 py-2 text-xs font-medium"
                    >
                      Full
                    </button>
                  </div>
                  <p class="mt-2 text-[11px]">{p.totalObs} logs</p>
                </li>
              {/if}
            {/each}
          </ul>

          <form
            class="mt-8 flex w-full max-w-xs flex-col items-center gap-3"
            onsubmit={(e) => {
              e.preventDefault();
              submitSpot();
            }}
          >
            <input
              class="w-full rounded-full border border-black bg-white px-5 py-2.5 text-center text-sm outline-none placeholder:text-black/40"
              placeholder="New spot"
              bind:value={newSpotName}
              maxlength={60}
            />
            <button type="submit" class="w-full rounded-full border border-black bg-white px-5 py-2.5 text-sm font-medium">
              Add spot
            </button>
          </form>
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

      <!-- compressed settings -->
      <div class="mt-16 flex w-full max-w-xs flex-col items-center">
        <button
          type="button"
          class="text-xs underline underline-offset-4"
          onclick={() => (showSettings = !showSettings)}
        >
          {showSettings ? "Hide settings" : "Settings"}
        </button>
        {#if showSettings}
          <div class="mt-6 flex w-full flex-col items-center gap-3">
            <form
              class="flex w-full flex-col items-center gap-3"
              onsubmit={(e) => {
                e.preventDefault();
                submitLocation();
              }}
            >
              <input
                class="w-full rounded-full border border-black bg-white px-5 py-2.5 text-center text-sm outline-none placeholder:text-black/40"
                placeholder="New location"
                bind:value={newLocName}
                maxlength={60}
              />
              <button type="submit" class="w-full rounded-full border border-black bg-white px-5 py-2.5 text-sm">
                Add location
              </button>
            </form>
            <button
              type="button"
              class="w-full rounded-full border border-black bg-white px-5 py-2.5 text-sm"
              onclick={() => {
                if (confirm(`Delete "${location.name}" and all its spots + history?`)) deleteLocation(location.id);
              }}
            >
              Delete this location
            </button>
            {#each locSpots as s (s.id)}
              <button
                type="button"
                class="text-xs underline underline-offset-4"
                onclick={() => {
                  if (confirm(`Delete spot "${s.name}"?`)) deleteSpot(s.id);
                }}
              >
                Delete {s.name}
              </button>
            {/each}
            <button
              type="button"
              class="text-xs underline underline-offset-4"
              onclick={() => {
                if (confirm("Clear this location's history?")) clearHistory(selectedLocationId ?? undefined);
              }}
            >
              Clear history
            </button>
            <button
              type="button"
              class="text-xs underline underline-offset-4"
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
        {/if}
      </div>
    {/if}
  {/if}

  <footer class="mt-16">
    <p class="text-[11px]">Parkov · data stays on this device</p>
  </footer>
</main>

<PwaUpdate />

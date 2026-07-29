/**
 * Bounded transcript retention: evicts hydrated `sessionMessages` transcripts that no
 * mounted surface or live consumer needs anymore, keeping app memory bounded by the
 * working set instead of by every session ever opened.
 *
 * Eligibility (ALL must hold before a transcript may be evicted):
 *  1. No mounted transcript consumer — SessionView anywhere in the nav stack (including
 *     hidden-but-mounted back-swipe targets) and detail routes hold mount-lifetime
 *     registrations in `sync/runtime/sessionRealtimeTranscriptConsumers.ts`.
 *  2. Not a live full-content consumer (visible / voice / SCM / explicit) per
 *     `resolveSessionLiveConsumption`.
 *  3. Not among the `recentKeepCount` most-recently-viewed unprotected sessions (LRU by
 *     `sessionLastViewed`; protected sessions do not consume keep slots).
 *  4. Idle for at least `graceMs` since last view / last protection release.
 *
 * Triggering is event-driven (consumer release, session becoming visible) — never a
 * polling interval. Sweeps are debounced; grace-deferred candidates schedule ONE
 * coalesced follow-up timer so memory is freed even when the user simply walks away.
 *
 * Eviction itself is delegated to the injected `evictSessionTranscript`, whose canonical
 * implementation removes the store entry (`evictSessionMessages`, which also clears the
 * per-session derived caches) and resets the sync-side per-session transcript state so a
 * re-open runs the first-open load pipeline.
 */

export type SessionTranscriptRetentionTuning = Readonly<{
    recentKeepCount: number;
    graceMs: number;
    sweepDebounceMs: number;
}>;

export type SessionTranscriptEvictionPlan = Readonly<{
    evictSessionIds: readonly string[];
    deferredSessionIds: readonly string[];
    /** Delay until the earliest grace-deferred candidate becomes evictable, or null. */
    nextSweepDelayMs: number | null;
}>;

export function planSessionTranscriptEviction(params: Readonly<{
    hydratedSessionIds: readonly string[];
    protectedSessionIds: ReadonlySet<string>;
    lastViewedAtBySessionId: Readonly<Record<string, number>>;
    /** Controller-stamped "unprotected since" timestamps (grace anchor). */
    idleSinceAtBySessionId: ReadonlyMap<string, number>;
    nowMs: number;
    recentKeepCount: number;
    graceMs: number;
}>): SessionTranscriptEvictionPlan {
    const candidates: Array<{ sessionId: string; lastViewedAt: number; idleSinceAt: number }> = [];
    const seen = new Set<string>();
    for (const sessionId of params.hydratedSessionIds) {
        if (!sessionId || seen.has(sessionId)) continue;
        seen.add(sessionId);
        if (params.protectedSessionIds.has(sessionId)) continue;
        const lastViewedAt = readFiniteTimestamp(params.lastViewedAtBySessionId[sessionId]);
        // A candidate without a stamp was first observed unprotected right now.
        const idleSinceAt = params.idleSinceAtBySessionId.get(sessionId) ?? params.nowMs;
        candidates.push({ sessionId, lastViewedAt, idleSinceAt });
    }

    // Most recently viewed first; protected sessions never consume keep slots.
    candidates.sort((a, b) => (
        b.lastViewedAt - a.lastViewedAt
        || b.idleSinceAt - a.idleSinceAt
        || a.sessionId.localeCompare(b.sessionId)
    ));

    const keepCount = Math.max(0, Math.trunc(params.recentKeepCount));
    const evictSessionIds: string[] = [];
    const deferredSessionIds: string[] = [];
    let nextSweepDelayMs: number | null = null;

    for (const candidate of candidates.slice(keepCount)) {
        const idleAnchorAt = Math.max(candidate.idleSinceAt, candidate.lastViewedAt);
        const idleForMs = params.nowMs - idleAnchorAt;
        if (idleForMs >= params.graceMs) {
            evictSessionIds.push(candidate.sessionId);
            continue;
        }
        deferredSessionIds.push(candidate.sessionId);
        const remainingMs = params.graceMs - idleForMs;
        nextSweepDelayMs = nextSweepDelayMs === null ? remainingMs : Math.min(nextSweepDelayMs, remainingMs);
    }

    return { evictSessionIds, deferredSessionIds, nextSweepDelayMs };
}

function readFiniteTimestamp(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export type SessionTranscriptRetentionController = Readonly<{
    /** Coalesced, debounced eviction sweep request. Safe to call at any frequency. */
    scheduleSweep: () => void;
    dispose: () => void;
}>;

export function createSessionTranscriptRetentionController(deps: Readonly<{
    readHydratedSessionIds: () => readonly string[];
    readProtectedSessionIds: () => ReadonlySet<string>;
    readLastViewedAtBySessionId: () => Readonly<Record<string, number>>;
    evictSessionTranscript: (sessionId: string) => void;
    tuning: SessionTranscriptRetentionTuning;
    now?: () => number;
}>): SessionTranscriptRetentionController {
    const now = deps.now ?? Date.now;
    const idleSinceAtBySessionId = new Map<string, number>();
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingTimerDueAtMs: number | null = null;
    let disposed = false;

    const clearPendingTimer = () => {
        if (pendingTimer !== null) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
            pendingTimerDueAtMs = null;
        }
    };

    const schedule = (delayMs: number) => {
        if (disposed) return;
        const dueAtMs = now() + Math.max(0, delayMs);
        if (pendingTimer !== null && pendingTimerDueAtMs !== null && pendingTimerDueAtMs <= dueAtMs) {
            // A sooner (or equal) sweep is already pending; coalesce into it.
            return;
        }
        clearPendingTimer();
        pendingTimerDueAtMs = dueAtMs;
        pendingTimer = setTimeout(() => {
            pendingTimer = null;
            pendingTimerDueAtMs = null;
            sweep();
        }, Math.max(0, delayMs));
    };

    const sweep = () => {
        if (disposed) return;
        const nowMs = now();
        const hydratedSessionIds = deps.readHydratedSessionIds();
        const protectedSessionIds = deps.readProtectedSessionIds();
        const lastViewedAtBySessionId = deps.readLastViewedAtBySessionId();

        // Maintain grace anchors: stamp newly-unprotected hydrated sessions, and drop
        // stamps for sessions that are protected again or no longer hydrated (so the
        // next release starts a fresh grace window).
        const hydratedSet = new Set(hydratedSessionIds);
        for (const sessionId of idleSinceAtBySessionId.keys()) {
            if (!hydratedSet.has(sessionId) || protectedSessionIds.has(sessionId)) {
                idleSinceAtBySessionId.delete(sessionId);
            }
        }
        for (const sessionId of hydratedSessionIds) {
            if (protectedSessionIds.has(sessionId)) continue;
            if (!idleSinceAtBySessionId.has(sessionId)) {
                idleSinceAtBySessionId.set(sessionId, nowMs);
            }
        }

        const plan = planSessionTranscriptEviction({
            hydratedSessionIds,
            protectedSessionIds,
            lastViewedAtBySessionId,
            idleSinceAtBySessionId,
            nowMs,
            recentKeepCount: deps.tuning.recentKeepCount,
            graceMs: deps.tuning.graceMs,
        });

        for (const sessionId of plan.evictSessionIds) {
            idleSinceAtBySessionId.delete(sessionId);
            deps.evictSessionTranscript(sessionId);
        }

        if (plan.nextSweepDelayMs !== null) {
            schedule(Math.max(plan.nextSweepDelayMs, deps.tuning.sweepDebounceMs));
        }
    };

    return {
        scheduleSweep: () => schedule(deps.tuning.sweepDebounceMs),
        dispose: () => {
            disposed = true;
            clearPendingTimer();
            idleSinceAtBySessionId.clear();
        },
    };
}

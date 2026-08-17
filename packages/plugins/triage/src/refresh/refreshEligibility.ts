import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

/**
 * The one shared process-local pacing policy for Triage provider refresh.
 *
 * Triage never persists a refresh cadence, a schedule, a queue, a lease, or a
 * durable health history: a refresh happens only because a named producer asked
 * for one (`core/CORPUS.md` §4.1). This module owns the single question every
 * producer must answer before a provider is read — *may this trigger read the
 * provider right now, and if not, when* — as pure functions over process-local
 * facts and an injected clock.
 *
 * It deliberately owns no timers, no promises, and no provider access. The
 * coordinator owns lifecycle; the SDK's `createCoalescedScheduler` owns
 * single-flight; this file owns only pacing.
 */

/**
 * The minimum interval between provider reads for one configured source
 * instance, measured from the last read *start*.
 *
 * A page can mount, focus, regain visibility, and observe recent user activity
 * within a second of itself; without one shared interval each of those becomes
 * its own provider read. The value is deliberately private implementation
 * discretion rather than a public or source-configurable contract: it is large
 * enough to collapse an interaction burst and small enough that it never
 * behaves like a polling cadence. Manual **Refresh** bypasses it entirely, so a
 * user who wants current data is never made to wait for it.
 */
export const TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS = 30_000;

/** First aggregate backoff ceiling after a provider-pacing failure. */
const TRIAGE_REFRESH_BACKOFF_BASE_MS = 5_000;

/** Ceiling cap: a longer wait would read as "the source is gone", not "busy". */
const TRIAGE_REFRESH_BACKOFF_CAP_MS = 300_000;

/** The named refresh producers of `core/CORPUS.md` §4.1. */
export type TriageRefreshTriggerV1 = 'sourceConfigured' | 'view' | 'manual';

/** Why a trigger may not read the provider yet. */
export type TriageRefreshPacingReasonV1 =
    | 'minimumInterval'
    | 'sourceRetryDeadline'
    | 'failureBackoff';

export type TriageRefreshEligibilityV1 =
    | Readonly<{ kind: 'eligible' }>
    | Readonly<{
        kind: 'blocked';
        reason: TriageRefreshPacingReasonV1;
        nextEligibleAtMs: number;
    }>;

/**
 * Process-local pacing evidence for one configured source instance.
 *
 * Every field disappears with the process. There is no durable generation,
 * receipt, queue, lease, heartbeat, or election behind any of them.
 */
export type TriageRefreshBackoffStateV1 = Readonly<{
    /** The source's own absolute epoch-millisecond "not before" statement. */
    retryNotBeforeMs: number | null;
    /** Our aggregate deadline after consecutive provider-pacing failures. */
    failureBackoffUntilMs: number | null;
    /** Consecutive provider-pacing failures since the last completed walk. */
    consecutivePacingFailures: number;
}>;

/** The state of an instance that has never failed, and of one that just completed a walk. */
export const TRIAGE_REFRESH_BACKOFF_IDLE_V1: TriageRefreshBackoffStateV1 = Object.freeze({
    retryNotBeforeMs: null,
    failureBackoffUntilMs: null,
    consecutivePacingFailures: 0,
});

/**
 * Whether repeating this failure class immediately would hammer the provider.
 *
 * `authentication`, `permission`, and `unsupportedContract` are user- or
 * source-actionable: the user fixes the connection and presses **Refresh**, and
 * making them wait out a backoff they have already resolved would be wrong. The
 * remaining classes describe a provider that is busy, throttling, or telling us
 * nothing useful, so retrying them at interaction speed is the hammering case.
 */
function isProviderPacingFailure(failure: TriageSourceFailureV1): boolean {
    return failure.class === 'transient'
        || failure.class === 'rateLimit'
        || failure.class === 'unknown';
}

/**
 * The next moment this trigger may read the provider, or `eligible` now.
 *
 * When more than one deadline applies, the latest one wins and names itself:
 * reporting the earlier of two active blocks would promise a refresh that the
 * next evaluation refuses again.
 */
export function evaluateRefreshEligibility(input: Readonly<{
    trigger: TriageRefreshTriggerV1;
    nowMs: number;
    /** When the last provider read for this instance *started*, not finished. */
    lastReadStartedAtMs: number | null;
    backoff: TriageRefreshBackoffStateV1;
}>): TriageRefreshEligibilityV1 {
    const blockers: readonly Readonly<{
        reason: TriageRefreshPacingReasonV1;
        deadlineMs: number;
    }>[] = [
        // A source-stated deadline is provider authority and outranks nothing
        // less than itself: manual Refresh honors it too, and surfaces the wait
        // rather than bypassing it.
        ...(input.backoff.retryNotBeforeMs === null
            ? []
            : [{ reason: 'sourceRetryDeadline' as const, deadlineMs: input.backoff.retryNotBeforeMs }]),
        ...(input.backoff.failureBackoffUntilMs === null
            ? []
            : [{ reason: 'failureBackoff' as const, deadlineMs: input.backoff.failureBackoffUntilMs }]),
        // Only view demand is paced. Explicit configuration and manual Refresh
        // are the user asking, and the user is never rate-limited by us.
        ...(input.trigger === 'view' && input.lastReadStartedAtMs !== null
            ? [{
                reason: 'minimumInterval' as const,
                deadlineMs: input.lastReadStartedAtMs + TRIAGE_VIEW_REFRESH_MIN_INTERVAL_MS,
            }]
            : []),
    ];

    const latest = blockers.reduce<Readonly<{
        reason: TriageRefreshPacingReasonV1;
        deadlineMs: number;
    }> | null>(
        (winner, candidate) => (winner === null || candidate.deadlineMs > winner.deadlineMs
            ? candidate
            : winner),
        null,
    );

    return latest === null || latest.deadlineMs <= input.nowMs
        ? { kind: 'eligible' }
        : { kind: 'blocked', reason: latest.reason, nextEligibleAtMs: latest.deadlineMs };
}

/**
 * Fold one settled provider failure into process-local pacing state.
 *
 * The source's own `retryNotBeforeMs` replaces ours because the latest provider
 * statement is the authoritative one; we never attempt before an outstanding
 * deadline, so there is no case where dropping an older deadline lets a trigger
 * through early.
 *
 * Full jitter — a uniform draw inside the exponential ceiling rather than the
 * ceiling itself — keeps two machines observing the same failing source from
 * lining up on the same retry moment. It schedules no wake: the deadline is
 * only ever read when a later named trigger arrives.
 */
export function recordRefreshFailure(input: Readonly<{
    backoff: TriageRefreshBackoffStateV1;
    failure: TriageSourceFailureV1;
    nowMs: number;
    random: () => number;
}>): TriageRefreshBackoffStateV1 {
    const retryNotBeforeMs = input.failure.retryNotBeforeMs ?? null;
    if (!isProviderPacingFailure(input.failure)) {
        return {
            retryNotBeforeMs,
            failureBackoffUntilMs: input.backoff.failureBackoffUntilMs,
            consecutivePacingFailures: input.backoff.consecutivePacingFailures,
        };
    }
    const consecutivePacingFailures = input.backoff.consecutivePacingFailures + 1;
    const ceilingMs = Math.min(
        TRIAGE_REFRESH_BACKOFF_CAP_MS,
        TRIAGE_REFRESH_BACKOFF_BASE_MS * 2 ** (consecutivePacingFailures - 1),
    );
    return {
        retryNotBeforeMs,
        failureBackoffUntilMs: input.nowMs + Math.floor(input.random() * ceilingMs),
        consecutivePacingFailures,
    };
}

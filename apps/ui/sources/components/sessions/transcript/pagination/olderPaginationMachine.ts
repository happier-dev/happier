/**
 * Pure reducer for user-triggered older-page (top) pagination.
 *
 * Single owner of the "should we load an older page now?" decision for both
 * ChatList and ChainTranscriptList. Replaces the duplicated dwell schedulers
 * whose guards could stay stuck near the top (evidence E6: burst pagination
 * while offsets sat <= 0) and whose missing-layout-metrics path optimistically
 * kept loading (ChainTranscriptList `shouldContinuePacedOlderPrefetchNearTop`).
 *
 * Rules encoded here:
 * - exactly one load in flight (`loading` phase is single-entry),
 * - arming requires an observed threshold EXIT -> ENTER transition; missing or
 *   invalid layout metrics count as OUTSIDE the threshold,
 * - loads are suspended while the offset is <= 0, while a viewport transaction
 *   is open, or while the initial fill is not done,
 * - a caller-timed cooldown follows every load (and every error) before any
 *   re-arm,
 * - hasMore=false is terminal until `reset` (session change).
 *
 * No timers, no React: callers own time (cooldownElapsed) and side effects.
 */

export type OlderPaginationPhase = 'idle' | 'armed' | 'loading' | 'cooldown';

export type OlderPaginationSuspendReason = 'negative-offset' | 'transaction-open' | 'fill-not-done';

export type OlderPaginationState = Readonly<{
    phase: OlderPaginationPhase;
    insideThreshold: boolean;
    /**
     * True when a threshold EXIT has been observed since the last load start
     * (or when no load happened yet). Required so an EXIT -> ENTER that lands
     * during `loading`/`cooldown` still re-arms at `cooldownElapsed`, while a
     * user parked inside the threshold never re-arms (anti-burst).
     */
    rearmEligible: boolean;
    hasMore: boolean;
    suspendedReasons: ReadonlySet<OlderPaginationSuspendReason>;
}>;

export type OlderPaginationScrollObservation = Readonly<{
    offsetY: number;
    thresholdPx: number;
    scrollable: boolean;
}>;

export type OlderPaginationEvent =
    | (Readonly<{ type: 'scrollObserved' }> & OlderPaginationScrollObservation)
    | Readonly<{ type: 'loadStarted' }>
    | Readonly<{ type: 'loadFinished'; loaded: number; hasMore: boolean; error?: boolean }>
    | Readonly<{ type: 'cooldownElapsed' }>
    | Readonly<{ type: 'suspend'; reason: OlderPaginationSuspendReason }>
    | Readonly<{ type: 'resume'; reason: OlderPaginationSuspendReason }>
    | Readonly<{ type: 'reset' }>;

const EMPTY_SUSPENDED_REASONS: ReadonlySet<OlderPaginationSuspendReason> = new Set();

export function createInitialOlderPaginationState(): OlderPaginationState {
    return {
        phase: 'idle',
        insideThreshold: false,
        rearmEligible: true,
        hasMore: true,
        suspendedReasons: EMPTY_SUSPENDED_REASONS,
    };
}

function withSuspendedReason(
    reasons: ReadonlySet<OlderPaginationSuspendReason>,
    reason: OlderPaginationSuspendReason,
    suspended: boolean,
): ReadonlySet<OlderPaginationSuspendReason> {
    if (reasons.has(reason) === suspended) return reasons;
    const next = new Set(reasons);
    if (suspended) {
        next.add(reason);
    } else {
        next.delete(reason);
    }
    return next;
}

function reduceScrollObserved(
    state: OlderPaginationState,
    observation: OlderPaginationScrollObservation,
): OlderPaginationState {
    const validMetrics =
        observation.scrollable === true &&
        Number.isFinite(observation.offsetY) &&
        Number.isFinite(observation.thresholdPx) &&
        observation.thresholdPx > 0;
    const inside = validMetrics && observation.offsetY <= observation.thresholdPx;
    const offsetNonPositive = !Number.isFinite(observation.offsetY) || observation.offsetY <= 0;

    const suspendedReasons = withSuspendedReason(state.suspendedReasons, 'negative-offset', offsetNonPositive);
    const exited = state.insideThreshold && !inside;
    const entered = !state.insideThreshold && inside;
    const rearmEligible = state.rearmEligible || exited;

    let phase = state.phase;
    if (phase === 'armed' && !inside) {
        phase = 'idle';
    }
    if (phase === 'idle' && entered && rearmEligible && state.hasMore) {
        phase = 'armed';
    }

    if (
        phase === state.phase &&
        inside === state.insideThreshold &&
        rearmEligible === state.rearmEligible &&
        suspendedReasons === state.suspendedReasons
    ) {
        return state;
    }
    return { ...state, phase, insideThreshold: inside, rearmEligible, suspendedReasons };
}

export function reduceOlderPagination(state: OlderPaginationState, event: OlderPaginationEvent): OlderPaginationState {
    switch (event.type) {
        case 'scrollObserved':
            return reduceScrollObserved(state, event);
        case 'loadStarted': {
            if (state.phase !== 'armed') return state;
            return { ...state, phase: 'loading', rearmEligible: false };
        }
        case 'loadFinished': {
            if (state.phase !== 'loading') return state;
            const hasMore = event.error === true ? state.hasMore : event.hasMore === true;
            return { ...state, phase: hasMore ? 'cooldown' : 'idle', hasMore };
        }
        case 'cooldownElapsed': {
            if (state.phase !== 'cooldown') return state;
            const rearm = state.insideThreshold && state.rearmEligible && state.hasMore;
            return { ...state, phase: rearm ? 'armed' : 'idle' };
        }
        case 'suspend': {
            const suspendedReasons = withSuspendedReason(state.suspendedReasons, event.reason, true);
            if (suspendedReasons === state.suspendedReasons) return state;
            return { ...state, suspendedReasons };
        }
        case 'resume': {
            const suspendedReasons = withSuspendedReason(state.suspendedReasons, event.reason, false);
            if (suspendedReasons === state.suspendedReasons) return state;
            return { ...state, suspendedReasons };
        }
        case 'reset':
            return createInitialOlderPaginationState();
    }
}

export function shouldLoadNow(state: OlderPaginationState): boolean {
    return state.phase === 'armed' && state.hasMore && state.suspendedReasons.size === 0;
}

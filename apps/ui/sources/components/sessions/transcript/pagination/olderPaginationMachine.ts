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
 * - loads are suspended while the offset is < 0, while passive scroll reports a
 *   near-top frame (offset within the genuine-top epsilon), while a viewport
 *   transaction is open, or while the initial fill is not done,
 * - explicit edge-reached triggers may use a near-top frame once so web callbacks
 *   that fire only at the genuine top do not starve. The genuine top is rarely
 *   EXACTLY `scrollTop === 0` (the browser reports integer-rounded / sub-pixel
 *   residues), so the exact-edge acceptance and the passive suspension share the
 *   same `TRANSCRIPT_WEB_GENUINE_TOP_EPSILON_PX` band the web classifier emits,
 * - a caller-timed cooldown follows every load (and every error) before any
 *   re-arm,
 * - hasMore=false is terminal until `reset` (session change).
 *
 * No timers, no React: callers own time (cooldownElapsed) and side effects.
 */

import { TRANSCRIPT_WEB_GENUINE_TOP_EPSILON_PX } from '@/components/sessions/transcript/_constants';

export type OlderPaginationPhase = 'idle' | 'armed' | 'loading' | 'cooldown';

export type OlderPaginationSuspendReason = 'negative-offset' | 'transaction-open' | 'fill-not-done';

export type OlderPaginationScrollTrigger = 'scroll' | 'edge-reached' | 'layout-committed';

export type OlderPaginationState = Readonly<{
    phase: OlderPaginationPhase;
    insideThreshold: boolean;
    /**
     * A committed list layout observed the viewport still physically at the
     * older edge while a load was in flight. This one-load latch bridges the
     * render-before-promise-settlement ordering without letting the initiating
     * edge callback create an unbounded page chain.
     */
    committedExactEdgeDuringLoad: boolean;
    /**
     * A successful positive-progress load settled before its first committed
     * projection layout. This provenance lets that one late commit authorize a
     * continuation without letting spinner/error/zero-progress commits re-arm.
     */
    successfulLoadAwaitingCommittedLayout: boolean;
    /**
     * True when a threshold EXIT has been observed since the last load start
     * (or when no load happened yet). Required so an EXIT -> ENTER that lands
     * during `loading`/`cooldown` still re-arms at `cooldownElapsed`, while a
     * user parked inside the threshold never re-arms (anti-burst).
     */
    rearmEligible: boolean;
    hasMore: boolean;
    /**
     * The last ATTEMPTED older read failed. Rows and the older cursor are retained, so the
     * exact same read can be retried. Distinct from `hasMore === false` (terminal) and from
     * a zero-row success: only a failure is user-actionable, and the automatic threshold
     * re-arm cannot be relied on because the reader may already be parked at the edge.
     */
    loadFailed: boolean;
    suspendedReasons: ReadonlySet<OlderPaginationSuspendReason>;
}>;

export type OlderPaginationScrollObservation = Readonly<{
    offsetY: number;
    thresholdPx: number;
    scrollable: boolean;
    trigger?: OlderPaginationScrollTrigger;
    /**
     * Estimate-immune edge proximity in ITEM units (count of loaded rows between the
     * viewport and the older edge, canonical oldest-first space — the fact-source
     * `getVisibleSourceRange().firstSourceIndex`). Native virtualized lists derive the
     * canonical px offset from ESTIMATED content height, whose error routinely swallows
     * the px threshold (loads fired only at the literal top) and can even go negative
     * (silent 'negative-offset' suspension). When this signal is valid it is the
     * AUTHORITATIVE proximity truth: threshold entry is px OR items, and the px-derived
     * suspensions (negative offset, parked-at-top band) do not apply. Absent/invalid
     * (web, or no reliable visible range yet) falls back to pure px semantics.
     */
    itemsToOlderEdge?: number | null;
    thresholdItems?: number | null;
}>;

export type OlderPaginationEvent =
    | (Readonly<{ type: 'scrollObserved' }> & OlderPaginationScrollObservation)
    | Readonly<{ type: 'loadStarted' }>
    /**
     * `error` backs off through the cooldown for ANY non-progress outcome (unmet
     * precondition, concurrent read, failure). `failed` is the narrower fact that the read
     * was attempted and FAILED — the only outcome the reader can act on.
     */
    | Readonly<{ type: 'loadFinished'; loaded: number; hasMore: boolean; error?: boolean; failed?: boolean }>
    | Readonly<{ type: 'cooldownElapsed' }>
    | Readonly<{ type: 'retryRequested' }>
    | Readonly<{ type: 'suspend'; reason: OlderPaginationSuspendReason }>
    | Readonly<{ type: 'resume'; reason: OlderPaginationSuspendReason }>
    | Readonly<{ type: 'reset' }>;

const EMPTY_SUSPENDED_REASONS: ReadonlySet<OlderPaginationSuspendReason> = new Set();

export function createInitialOlderPaginationState(): OlderPaginationState {
    return {
        phase: 'idle',
        insideThreshold: false,
        committedExactEdgeDuringLoad: false,
        successfulLoadAwaitingCommittedLayout: false,
        rearmEligible: true,
        hasMore: true,
        loadFailed: false,
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
    const validItemMetrics =
        observation.scrollable === true &&
        typeof observation.itemsToOlderEdge === 'number' &&
        Number.isFinite(observation.itemsToOlderEdge) &&
        observation.itemsToOlderEdge >= 0 &&
        typeof observation.thresholdItems === 'number' &&
        Number.isFinite(observation.thresholdItems) &&
        observation.thresholdItems > 0;
    const trigger = observation.trigger ?? 'scroll';
    // The genuine top is reported as a near-zero (integer-rounded / sub-pixel-residue) offset,
    // not exactly 0, so accept the same epsilon band the web genuine-top classifier emits.
    const atGenuineTop =
        Number.isFinite(observation.offsetY) &&
        observation.offsetY >= 0 &&
        observation.offsetY <= TRANSCRIPT_WEB_GENUINE_TOP_EPSILON_PX;
    const atItemEdge = validItemMetrics && observation.itemsToOlderEdge === 0;
    const physicallyAtExactEdge = validItemMetrics ? atItemEdge : atGenuineTop;
    const allowsExactEdge =
        (trigger === 'edge-reached' || trigger === 'layout-committed') &&
        physicallyAtExactEdge;
    const inside = isOlderPaginationObservationInsideThreshold(observation);
    const acceptsLateCommittedExactEdge =
        trigger === 'layout-committed' &&
        state.successfulLoadAwaitingCommittedLayout &&
        inside &&
        physicallyAtExactEdge;
    const committedExactEdgeDuringLoad =
        state.phase === 'loading'
            ? (
                trigger === 'layout-committed'
                    ? inside && physicallyAtExactEdge
                    : physicallyAtExactEdge
                        ? state.committedExactEdgeDuringLoad
                        : false
            )
            : state.phase === 'cooldown'
                ? (
                    state.committedExactEdgeDuringLoad ||
                    acceptsLateCommittedExactEdge
                ) && inside && physicallyAtExactEdge
                : false;
    const successfulLoadAwaitingCommittedLayout =
        state.successfulLoadAwaitingCommittedLayout &&
        trigger !== 'layout-committed' &&
        inside &&
        physicallyAtExactEdge;
    // A valid item signal is the authoritative proximity truth: the px offset on native is
    // estimate-derived, so its negative/parked-at-top artifacts must not suspend loading.
    const offsetSuspended =
        !validItemMetrics &&
        (
            !Number.isFinite(observation.offsetY) ||
            observation.offsetY < 0 ||
            (atGenuineTop && !allowsExactEdge)
        );

    const suspendedReasons = withSuspendedReason(state.suspendedReasons, 'negative-offset', offsetSuspended);
    const exited = state.insideThreshold && !inside;
    const entered = !state.insideThreshold && inside;
    const exactEdgeRetryEligible =
        allowsExactEdge &&
        inside &&
        state.insideThreshold &&
        state.hasMore &&
        (state.phase === 'cooldown' || state.phase === 'idle') &&
        (
            trigger === 'edge-reached' ||
            (state.phase === 'idle' && acceptsLateCommittedExactEdge)
        );
    const rearmEligible = state.rearmEligible || exited || exactEdgeRetryEligible;

    let phase = state.phase;
    if (phase === 'armed' && !inside) {
        phase = 'idle';
    }
    const enteredFromLiveViewportObservation =
        entered &&
        (trigger !== 'layout-committed' || allowsExactEdge);
    if (
        phase === 'idle' &&
        (enteredFromLiveViewportObservation || exactEdgeRetryEligible) &&
        rearmEligible &&
        state.hasMore
    ) {
        phase = 'armed';
    }

    if (
        phase === state.phase &&
        inside === state.insideThreshold &&
        committedExactEdgeDuringLoad === state.committedExactEdgeDuringLoad &&
        successfulLoadAwaitingCommittedLayout === state.successfulLoadAwaitingCommittedLayout &&
        rearmEligible === state.rearmEligible &&
        suspendedReasons === state.suspendedReasons
    ) {
        return state;
    }
    return {
        ...state,
        phase,
        insideThreshold: inside,
        committedExactEdgeDuringLoad,
        successfulLoadAwaitingCommittedLayout,
        rearmEligible,
        suspendedReasons,
    };
}

export function isOlderPaginationObservationInsideThreshold(
    observation: OlderPaginationScrollObservation,
): boolean {
    const insidePx =
        observation.scrollable === true &&
        Number.isFinite(observation.offsetY) &&
        Number.isFinite(observation.thresholdPx) &&
        observation.thresholdPx > 0 &&
        observation.offsetY <= observation.thresholdPx;
    const insideItems =
        observation.scrollable === true &&
        typeof observation.itemsToOlderEdge === 'number' &&
        Number.isFinite(observation.itemsToOlderEdge) &&
        observation.itemsToOlderEdge >= 0 &&
        typeof observation.thresholdItems === 'number' &&
        Number.isFinite(observation.thresholdItems) &&
        observation.thresholdItems > 0 &&
        observation.itemsToOlderEdge <= observation.thresholdItems;
    return insidePx || insideItems;
}

export function reduceOlderPagination(state: OlderPaginationState, event: OlderPaginationEvent): OlderPaginationState {
    switch (event.type) {
        case 'scrollObserved':
            return reduceScrollObserved(state, event);
        case 'loadStarted': {
            if (state.phase !== 'armed') return state;
            return {
                ...state,
                phase: 'loading',
                committedExactEdgeDuringLoad: false,
                successfulLoadAwaitingCommittedLayout: false,
                rearmEligible: false,
                loadFailed: false,
            };
        }
        case 'loadFinished': {
            if (state.phase !== 'loading') return state;
            const hasMore = event.error === true ? state.hasMore : event.hasMore === true;
            const successfulExactEdgeContinuation =
                event.error !== true &&
                event.loaded > 0 &&
                hasMore &&
                state.insideThreshold &&
                state.committedExactEdgeDuringLoad;
            const successfulLoadAwaitingCommittedLayout =
                event.error !== true &&
                event.loaded > 0 &&
                hasMore &&
                state.insideThreshold &&
                !state.committedExactEdgeDuringLoad;
            return {
                ...state,
                phase: hasMore ? 'cooldown' : 'idle',
                committedExactEdgeDuringLoad: successfulExactEdgeContinuation,
                successfulLoadAwaitingCommittedLayout,
                hasMore,
                loadFailed: event.failed === true,
            };
        }
        case 'cooldownElapsed': {
            if (state.phase !== 'cooldown') return state;
            const rearm =
                state.insideThreshold &&
                (state.rearmEligible || state.committedExactEdgeDuringLoad) &&
                state.hasMore;
            return {
                ...state,
                phase: rearm ? 'armed' : 'idle',
                committedExactEdgeDuringLoad: rearm
                    ? state.committedExactEdgeDuringLoad
                    : false,
                successfulLoadAwaitingCommittedLayout:
                    state.successfulLoadAwaitingCommittedLayout && !rearm,
            };
        }
        case 'retryRequested': {
            // The reader asked for this exact page again. Automatic re-arm requires a
            // threshold EXIT -> ENTER, which a reader parked at the older edge never
            // produces, so an explicit retry arms directly. Suspensions still apply:
            // `shouldLoadNow` remains the single gate on actually issuing the read.
            if (!state.loadFailed || !state.hasMore) return state;
            if (state.phase === 'loading' || state.phase === 'armed') return state;
            return {
                ...state,
                phase: 'armed',
                rearmEligible: true,
            };
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

/**
 * Resolve the estimate-immune item-space edge proximity from a canonical oldest-first
 * visible source range. Single owner of the signal-validity rule for every list that
 * feeds the machine:
 * - `null` range (web, or the driver cannot report a reliable range yet) → no signal.
 * - A range spanning the ENTIRE source set → no signal: a whole-range read is
 *   indistinguishable from a degenerate/unsettled virtualization report (and when
 *   everything truly fits the viewport the px metrics are accurate anyway), so it must
 *   never read as "at the older edge".
 */
function isValidVisibleSourceSubset(
    range: Readonly<{ firstSourceIndex: number; lastSourceIndex: number }> | null | undefined,
    sourceItemCount: number,
): range is Readonly<{ firstSourceIndex: number; lastSourceIndex: number }> {
    if (!range) return false;
    if (!Number.isInteger(sourceItemCount) || sourceItemCount <= 0) return false;
    if (!Number.isInteger(range.firstSourceIndex) || range.firstSourceIndex < 0) return false;
    if (
        !Number.isInteger(range.lastSourceIndex) ||
        range.lastSourceIndex < range.firstSourceIndex ||
        range.lastSourceIndex >= sourceItemCount
    ) return false;
    if (range.firstSourceIndex <= 0 && range.lastSourceIndex >= sourceItemCount - 1) return false;
    return true;
}

export function resolveItemsToOlderEdge(
    range: Readonly<{ firstSourceIndex: number; lastSourceIndex: number }> | null | undefined,
    sourceItemCount: number,
): number | null {
    if (!isValidVisibleSourceSubset(range, sourceItemCount)) return null;
    return range.firstSourceIndex;
}

export function resolveItemsToNewerEdge(
    range: Readonly<{ firstSourceIndex: number; lastSourceIndex: number }> | null | undefined,
    sourceItemCount: number,
): number | null {
    if (!isValidVisibleSourceSubset(range, sourceItemCount)) return null;
    return sourceItemCount - range.lastSourceIndex - 1;
}

/**
 * Continuous "older content is being brought in near the edge" signal for the loading
 * indicator. Spans the whole page chain — `loading`, the between-pages `cooldown`, and
 * the imminent `armed` hop — while more content exists, the viewport is inside the
 * threshold, and a follow-up load is actually coming (`rearmEligible`). A user parked
 * inside the threshold after a single page is NOT busy (anti-burst also means
 * anti-flicker: no follow-up load is coming, so the indicator settles with the load).
 */
export function isOlderPaginationBusyNearEdge(state: OlderPaginationState): boolean {
    if (state.phase === 'loading') return true;
    return (
        (state.phase === 'cooldown' || state.phase === 'armed') &&
        state.hasMore &&
        state.insideThreshold &&
        (
            state.rearmEligible ||
            state.committedExactEdgeDuringLoad ||
            state.successfulLoadAwaitingCommittedLayout
        )
    );
}

import * as React from 'react';

import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';

import {
    createInitialOlderPaginationState,
    isOlderPaginationBusyNearEdge,
    isOlderPaginationObservationInsideThreshold,
    reduceOlderPagination,
    shouldLoadNow,
    type OlderPaginationEvent,
    type OlderPaginationScrollTrigger,
    type OlderPaginationState,
    type OlderPaginationSuspendReason,
} from './olderPaginationMachine';

export type TranscriptOlderPaginationLoadStatus = 'loaded' | 'no_more' | 'not_ready' | 'in_flight';

export type TranscriptOlderPaginationLoadResult = Readonly<{
    status: TranscriptOlderPaginationLoadStatus;
    loaded: number;
    hasMore: boolean;
}>;

export type TranscriptOlderPaginationLoadTrigger = 'threshold-enter' | 'post-cooldown' | 'readiness-open';

export type TranscriptOlderPaginationLoadOptions = Readonly<{
    trigger: TranscriptOlderPaginationLoadTrigger;
}>;

export type TranscriptOlderPaginationScrollMetrics = Readonly<{
    offsetY: number;
    scrollable: boolean;
    trigger?: OlderPaginationScrollTrigger;
    /** Estimate-immune item-space edge proximity (see the machine observation contract). */
    itemsToOlderEdge?: number | null;
}>;

export type TranscriptOlderPaginationSnapshot = Readonly<{
    phase: OlderPaginationState['phase'];
    suspendedReasons: readonly OlderPaginationSuspendReason[];
    hasMore: boolean;
    insideThreshold: boolean;
}>;

export type UseTranscriptOlderPaginationInput = Readonly<{
    enabled: boolean;
    loadOlder: (options: TranscriptOlderPaginationLoadOptions) => Promise<TranscriptOlderPaginationLoadResult | null>;
    thresholdPx: number;
    /** Item-space arm threshold paired with `metrics.itemsToOlderEdge` (native lists). */
    thresholdItems?: number | null;
    cooldownMs: number;
    spinnerDelayMs: number;
    isFillDone: () => boolean;
    isTransactionOpen: () => boolean;
}>;

export type UseTranscriptOlderPaginationResult = Readonly<{
    onScrollObservation: (metrics: TranscriptOlderPaginationScrollMetrics) => void;
    isReadyForLoad: () => boolean;
    isNearOlderEdge: (metrics: TranscriptOlderPaginationScrollMetrics) => boolean;
    isLoadingOlder: boolean;
    hasMore: boolean;
    getSnapshot: () => TranscriptOlderPaginationSnapshot;
    reset: () => void;
}>;

type LoadFinishedEvent = Extract<OlderPaginationEvent, { type: 'loadFinished' }>;

function mapLoadResultToFinishedEvent(result: TranscriptOlderPaginationLoadResult | null): LoadFinishedEvent {
    if (!result) {
        return { type: 'loadFinished', loaded: 0, hasMore: true, error: true };
    }
    if (result.status === 'no_more') {
        return { type: 'loadFinished', loaded: Math.max(0, Math.trunc(result.loaded)), hasMore: false };
    }
    if (result.status === 'loaded') {
        return {
            type: 'loadFinished',
            loaded: Math.max(0, Math.trunc(result.loaded)),
            hasMore: result.hasMore !== false,
        };
    }
    // 'not_ready' | 'in_flight': nothing was loaded; back off through the cooldown.
    return { type: 'loadFinished', loaded: 0, hasMore: true, error: true };
}

function normalizeDelayMs(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * Single owner of user-triggered older-page (top) pagination for transcript
 * lists. Owns the pure {@link reduceOlderPagination} machine plus the only two
 * timers involved (cooldown and spinner delay). Generic over ChatList and
 * ChainTranscriptList: all dependencies are injected callbacks; the scroll
 * path stays ref-based (no per-frame setState).
 */
export function useTranscriptOlderPagination(input: UseTranscriptOlderPaginationInput): UseTranscriptOlderPaginationResult {
    const inputRef = React.useRef(input);
    useCommittedTranscriptRef(inputRef, input);

    const stateRef = React.useRef<OlderPaginationState>(createInitialOlderPaginationState());
    const cooldownTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const spinnerTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = React.useRef(true);
    const operationGenerationRef = React.useRef(0);

    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    const [hasMore, setHasMore] = React.useState(stateRef.current.hasMore);
    const settleSpinnerRef = React.useRef<() => void>(() => {});

    const dispatch = React.useCallback((event: OlderPaginationEvent) => {
        const previous = stateRef.current;
        const next = reduceOlderPagination(previous, event);
        stateRef.current = next;
        if (next.hasMore !== previous.hasMore && mountedRef.current) {
            setHasMore(next.hasMore);
        }
        // Single spinner SETTLE owner: the indicator settles only when the machine's
        // continuous busy-near-edge signal drops (load chain over, threshold exited, or
        // no more pages) — never between chained pages, so it does not flicker off
        // while a follow-up load is coming. The indicator START stays owned by
        // `loadStarted` (below) so single-load delay timing is unchanged.
        if (isOlderPaginationBusyNearEdge(previous) && !isOlderPaginationBusyNearEdge(next)) {
            settleSpinnerRef.current();
        }
    }, []);

    const clearCooldownTimeout = React.useCallback(() => {
        if (cooldownTimeoutRef.current == null) return;
        clearTimeout(cooldownTimeoutRef.current);
        cooldownTimeoutRef.current = null;
    }, []);

    const clearSpinnerTimeout = React.useCallback(() => {
        if (spinnerTimeoutRef.current == null) return;
        clearTimeout(spinnerTimeoutRef.current);
        spinnerTimeoutRef.current = null;
    }, []);

    const isOperationCurrent = React.useCallback((operationGeneration: number): boolean => (
        mountedRef.current && operationGenerationRef.current === operationGeneration
    ), []);

    const beginSpinnerDelay = React.useCallback((operationGeneration: number) => {
        clearSpinnerTimeout();
        const delayMs = normalizeDelayMs(inputRef.current.spinnerDelayMs);
        if (delayMs <= 0) {
            if (isOperationCurrent(operationGeneration)) setIsLoadingOlder(true);
            return;
        }
        spinnerTimeoutRef.current = setTimeout(() => {
            spinnerTimeoutRef.current = null;
            if (!isOperationCurrent(operationGeneration)) return;
            if (!isOlderPaginationBusyNearEdge(stateRef.current)) return;
            setIsLoadingOlder(true);
        }, delayMs);
    }, [clearSpinnerTimeout, isOperationCurrent]);

    const settleSpinner = React.useCallback(() => {
        clearSpinnerTimeout();
        if (mountedRef.current) setIsLoadingOlder(false);
    }, [clearSpinnerTimeout]);
    useCommittedTranscriptRef(settleSpinnerRef, settleSpinner);

    const syncDerivedSuspensions = React.useCallback(() => {
        const fillDone = inputRef.current.isFillDone() === true;
        const transactionOpen = inputRef.current.isTransactionOpen() === true;
        dispatch({ type: fillDone ? 'resume' : 'suspend', reason: 'fill-not-done' });
        dispatch({ type: transactionOpen ? 'suspend' : 'resume', reason: 'transaction-open' });
    }, [dispatch]);

    const maybeStartLoadRef = React.useRef<(trigger: TranscriptOlderPaginationLoadTrigger) => void>(() => {});

    const startCooldown = React.useCallback((operationGeneration: number) => {
        if (!isOperationCurrent(operationGeneration)) return;
        clearCooldownTimeout();
        if (stateRef.current.phase !== 'cooldown') return;
        const cooldownMs = normalizeDelayMs(inputRef.current.cooldownMs);
        cooldownTimeoutRef.current = setTimeout(() => {
            cooldownTimeoutRef.current = null;
            if (!isOperationCurrent(operationGeneration)) return;
            dispatch({ type: 'cooldownElapsed' });
            maybeStartLoadRef.current('post-cooldown');
        }, cooldownMs);
    }, [clearCooldownTimeout, dispatch, isOperationCurrent]);

    const maybeStartLoad = React.useCallback((trigger: TranscriptOlderPaginationLoadTrigger) => {
        if (inputRef.current.enabled !== true) return;
        syncDerivedSuspensions();
        if (!shouldLoadNow(stateRef.current)) return;
        dispatch({ type: 'loadStarted' });
        if (stateRef.current.phase !== 'loading') return;
        const operationGeneration = operationGenerationRef.current;
        beginSpinnerDelay(operationGeneration);
        void (async () => {
            let finished: LoadFinishedEvent;
            try {
                finished = mapLoadResultToFinishedEvent(await inputRef.current.loadOlder({ trigger }));
            } catch {
                finished = { type: 'loadFinished', loaded: 0, hasMore: true, error: true };
            }
            if (!isOperationCurrent(operationGeneration)) return;
            dispatch(finished);
            startCooldown(operationGeneration);
        })();
    }, [beginSpinnerDelay, dispatch, isOperationCurrent, startCooldown, syncDerivedSuspensions]);
    useCommittedTranscriptRef(maybeStartLoadRef, maybeStartLoad);

    // Readiness drain: the machine's own arm decision is executed on the next commit.
    // Arming is independent of readiness, so a threshold ENTER observed while the initial
    // fill is unfinished, a viewport transaction is open, or the pager is disabled leaves
    // the machine `armed` with nothing owed to it — the reader parks at the top and no
    // load starts until an unrelated scroll/layout/edge observation or a cooldown that is
    // not pending re-enters `maybeStartLoad`. This is the missing edge, not a retry: it
    // adds no timer and no second decision owner, `maybeStartLoad` re-reads the same
    // readiness inputs it always has, and `shouldLoadNow` (phase `armed`, single-entry
    // `loading`) still gates the start, so a commit can never burst or double-fire.
    React.useEffect(() => {
        if (stateRef.current.phase !== 'armed') return;
        maybeStartLoadRef.current('readiness-open');
    });

    const onScrollObservation = React.useCallback((metrics: TranscriptOlderPaginationScrollMetrics) => {
        if (inputRef.current.enabled !== true) return;
        dispatch({
            type: 'scrollObserved',
            offsetY: metrics.offsetY,
            thresholdPx: inputRef.current.thresholdPx,
            scrollable: metrics.scrollable,
            trigger: metrics.trigger,
            itemsToOlderEdge: metrics.itemsToOlderEdge ?? null,
            thresholdItems: inputRef.current.thresholdItems ?? null,
        });
        maybeStartLoad('threshold-enter');
    }, [dispatch, maybeStartLoad]);

    const isNearOlderEdge = React.useCallback((metrics: TranscriptOlderPaginationScrollMetrics): boolean => {
        return isOlderPaginationObservationInsideThreshold({
            offsetY: metrics.offsetY,
            thresholdPx: inputRef.current.thresholdPx,
            scrollable: metrics.scrollable,
            trigger: metrics.trigger,
            itemsToOlderEdge: metrics.itemsToOlderEdge ?? null,
            thresholdItems: inputRef.current.thresholdItems ?? null,
        });
    }, []);

    const isReadyForLoad = React.useCallback((): boolean => (
        inputRef.current.enabled === true &&
        inputRef.current.isFillDone() === true &&
        inputRef.current.isTransactionOpen() !== true
    ), []);

    const getSnapshot = React.useCallback((): TranscriptOlderPaginationSnapshot => {
        const state = stateRef.current;
        return {
            phase: state.phase,
            suspendedReasons: Array.from(state.suspendedReasons),
            hasMore: state.hasMore,
            insideThreshold: state.insideThreshold,
        };
    }, []);

    const reset = React.useCallback(() => {
        operationGenerationRef.current += 1;
        clearCooldownTimeout();
        clearSpinnerTimeout();
        dispatch({ type: 'reset' });
        if (mountedRef.current) setIsLoadingOlder(false);
    }, [clearCooldownTimeout, clearSpinnerTimeout, dispatch]);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            operationGenerationRef.current += 1;
            clearCooldownTimeout();
            clearSpinnerTimeout();
        };
    }, [clearCooldownTimeout, clearSpinnerTimeout]);

    return {
        onScrollObservation,
        isReadyForLoad,
        isNearOlderEdge,
        isLoadingOlder,
        hasMore,
        getSnapshot,
        reset,
    };
}

import * as React from 'react';

import {
    createInitialOlderPaginationState,
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

export type TranscriptOlderPaginationLoadTrigger = 'threshold-enter' | 'post-cooldown';

export type TranscriptOlderPaginationLoadOptions = Readonly<{
    trigger: TranscriptOlderPaginationLoadTrigger;
}>;

export type TranscriptOlderPaginationScrollMetrics = Readonly<{
    offsetY: number;
    scrollable: boolean;
    trigger?: OlderPaginationScrollTrigger;
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
    cooldownMs: number;
    spinnerDelayMs: number;
    isFillDone: () => boolean;
    isTransactionOpen: () => boolean;
}>;

export type UseTranscriptOlderPaginationResult = Readonly<{
    onScrollObservation: (metrics: TranscriptOlderPaginationScrollMetrics) => void;
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
    inputRef.current = input;

    const stateRef = React.useRef<OlderPaginationState>(createInitialOlderPaginationState());
    const cooldownTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const spinnerTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = React.useRef(true);

    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    const [hasMore, setHasMore] = React.useState(stateRef.current.hasMore);

    const dispatch = React.useCallback((event: OlderPaginationEvent) => {
        const previous = stateRef.current;
        const next = reduceOlderPagination(previous, event);
        stateRef.current = next;
        if (next.hasMore !== previous.hasMore && mountedRef.current) {
            setHasMore(next.hasMore);
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

    const beginSpinnerDelay = React.useCallback(() => {
        clearSpinnerTimeout();
        const delayMs = normalizeDelayMs(inputRef.current.spinnerDelayMs);
        if (delayMs <= 0) {
            if (mountedRef.current) setIsLoadingOlder(true);
            return;
        }
        spinnerTimeoutRef.current = setTimeout(() => {
            spinnerTimeoutRef.current = null;
            if (stateRef.current.phase !== 'loading') return;
            if (mountedRef.current) setIsLoadingOlder(true);
        }, delayMs);
    }, [clearSpinnerTimeout]);

    const settleSpinner = React.useCallback(() => {
        clearSpinnerTimeout();
        if (mountedRef.current) setIsLoadingOlder(false);
    }, [clearSpinnerTimeout]);

    const syncDerivedSuspensions = React.useCallback(() => {
        const fillDone = inputRef.current.isFillDone() === true;
        const transactionOpen = inputRef.current.isTransactionOpen() === true;
        dispatch({ type: fillDone ? 'resume' : 'suspend', reason: 'fill-not-done' });
        dispatch({ type: transactionOpen ? 'suspend' : 'resume', reason: 'transaction-open' });
    }, [dispatch]);

    const maybeStartLoadRef = React.useRef<(trigger: TranscriptOlderPaginationLoadTrigger) => void>(() => {});

    const startCooldown = React.useCallback(() => {
        clearCooldownTimeout();
        if (stateRef.current.phase !== 'cooldown') return;
        const cooldownMs = normalizeDelayMs(inputRef.current.cooldownMs);
        cooldownTimeoutRef.current = setTimeout(() => {
            cooldownTimeoutRef.current = null;
            dispatch({ type: 'cooldownElapsed' });
            maybeStartLoadRef.current('post-cooldown');
        }, cooldownMs);
    }, [clearCooldownTimeout, dispatch]);

    const maybeStartLoad = React.useCallback((trigger: TranscriptOlderPaginationLoadTrigger) => {
        if (inputRef.current.enabled !== true) return;
        syncDerivedSuspensions();
        if (!shouldLoadNow(stateRef.current)) return;
        dispatch({ type: 'loadStarted' });
        if (stateRef.current.phase !== 'loading') return;
        beginSpinnerDelay();
        void (async () => {
            let finished: LoadFinishedEvent;
            try {
                finished = mapLoadResultToFinishedEvent(await inputRef.current.loadOlder({ trigger }));
            } catch {
                finished = { type: 'loadFinished', loaded: 0, hasMore: true, error: true };
            }
            dispatch(finished);
            settleSpinner();
            startCooldown();
        })();
    }, [beginSpinnerDelay, dispatch, settleSpinner, startCooldown, syncDerivedSuspensions]);
    maybeStartLoadRef.current = maybeStartLoad;

    const onScrollObservation = React.useCallback((metrics: TranscriptOlderPaginationScrollMetrics) => {
        if (inputRef.current.enabled !== true) return;
        dispatch({
            type: 'scrollObserved',
            offsetY: metrics.offsetY,
            thresholdPx: inputRef.current.thresholdPx,
            scrollable: metrics.scrollable,
            trigger: metrics.trigger,
        });
        maybeStartLoad('threshold-enter');
    }, [dispatch, maybeStartLoad]);

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
        clearCooldownTimeout();
        clearSpinnerTimeout();
        dispatch({ type: 'reset' });
        if (mountedRef.current) setIsLoadingOlder(false);
    }, [clearCooldownTimeout, clearSpinnerTimeout, dispatch]);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            clearCooldownTimeout();
            clearSpinnerTimeout();
        };
    }, [clearCooldownTimeout, clearSpinnerTimeout]);

    return { onScrollObservation, isLoadingOlder, hasMore, getSnapshot, reset };
}

import * as React from 'react';

import { sync } from '@/sync/sync';
import type { TranscriptJumpTarget } from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';
import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';

type MutableRef<T> = { current: T };
type Direction = 'older' | 'newer';
type RetryTimeout = ReturnType<typeof setTimeout>;

export type TranscriptTargetWindowContinuationState = Readonly<{
    hasMoreNewer: boolean | null;
    hasMoreOlder: boolean | null;
    newerCursor: number | null;
    olderCursor: number | null;
    targetSeq: number | null;
    windowId: string | null;
}>;

export function useTranscriptTargetWindowContinuationOwner(params: Readonly<{
    activeTargetWindowTargetRef: MutableRef<TranscriptJumpTarget | null>;
    activeWindowState: TranscriptTargetWindowContinuationState | null;
    isReadyForLoad: () => boolean;
    isWarmKeepAliveInstance: boolean;
    sessionActive: boolean;
    sessionId: string;
    targetWindowEdgeLoadInFlightRef: MutableRef<Direction | null>;
}>): Readonly<{
    observeProximity(near: Readonly<Record<Direction, boolean>>): void;
    observeReachedEdge(direction: Direction): void;
}> {
    const nearEdgeRef = React.useRef<Record<Direction, boolean>>({
        newer: false,
        older: false,
    });
    const attemptKeyRef = React.useRef<Record<Direction, string | null>>({
        newer: null,
        older: null,
    });
    const retryTimeoutRef = React.useRef<Record<Direction, RetryTimeout | null>>({
        newer: null,
        older: null,
    });
    const observedWindowIdRef = React.useRef<string | null>(null);
    const mountedRef = React.useRef(true);
    const clearRetryTimeout = React.useCallback((direction: Direction) => {
        const timeout = retryTimeoutRef.current[direction];
        if (timeout == null) return;
        clearTimeout(timeout);
        retryTimeoutRef.current[direction] = null;
    }, []);
    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            clearRetryTimeout('older');
            clearRetryTimeout('newer');
        };
    }, [clearRetryTimeout]);
    const currentOwnerRef = React.useRef({
        activeTargetWindowTargetRef: params.activeTargetWindowTargetRef,
        activeWindowState: params.activeWindowState,
        sessionId: params.sessionId,
    });
    useCommittedTranscriptRef(currentOwnerRef, {
        activeTargetWindowTargetRef: params.activeTargetWindowTargetRef,
        activeWindowState: params.activeWindowState,
        sessionId: params.sessionId,
    });
    const drainRef = React.useRef<() => void>(() => {});

    const observeIdentity = React.useCallback((windowId: string | null | undefined): boolean => {
        const normalizedWindowId = typeof windowId === 'string' && windowId.length > 0
            ? windowId
            : null;
        if (observedWindowIdRef.current === normalizedWindowId) return normalizedWindowId !== null;
        observedWindowIdRef.current = normalizedWindowId;
        clearRetryTimeout('older');
        clearRetryTimeout('newer');
        nearEdgeRef.current = { newer: false, older: false };
        attemptKeyRef.current = { newer: null, older: null };
        return normalizedWindowId !== null;
    }, [clearRetryTimeout]);

    const resolveContinuationTarget = React.useCallback((): TranscriptJumpTarget | null => {
        const targetSeq = params.activeWindowState?.targetSeq;
        if (typeof targetSeq !== 'number' || !Number.isFinite(targetSeq)) return null;
        const normalizedTargetSeq = Math.trunc(targetSeq);
        const rememberedTarget = params.activeTargetWindowTargetRef.current;
        const rememberedTargetSeq = rememberedTarget?.kind === 'seq'
            ? rememberedTarget.seq
            : rememberedTarget?.seqHint;
        if (
            typeof rememberedTargetSeq === 'number' &&
            Number.isFinite(rememberedTargetSeq) &&
            Math.trunc(rememberedTargetSeq) === normalizedTargetSeq
        ) {
            return rememberedTarget;
        }
        return { kind: 'seq', seq: normalizedTargetSeq };
    }, [params.activeTargetWindowTargetRef, params.activeWindowState]);

    const drain: () => void = React.useCallback(() => {
        const state = params.activeWindowState;
        if (
            !mountedRef.current ||
            !state ||
            !params.sessionId ||
            !params.sessionActive ||
            params.isWarmKeepAliveInstance ||
            observedWindowIdRef.current !== state.windowId ||
            !params.isReadyForLoad() ||
            params.targetWindowEdgeLoadInFlightRef.current !== null
        ) return;
        const windowId = state.windowId;
        if (typeof windowId !== 'string' || windowId.length === 0) return;
        const direction = (['older', 'newer'] as const).find((candidate) => {
            if (!nearEdgeRef.current[candidate]) return false;
            const hasMore = candidate === 'older' ? state.hasMoreOlder : state.hasMoreNewer;
            if (hasMore !== true) return false;
            const cursor = candidate === 'older' ? state.olderCursor : state.newerCursor;
            const attemptKey = `${windowId}:${candidate}:${cursor == null ? 'null' : Math.trunc(cursor)}`;
            return attemptKeyRef.current[candidate] !== attemptKey;
        });
        if (!direction) return;
        const target = resolveContinuationTarget();
        if (!target) return;
        const cursor = direction === 'older' ? state.olderCursor : state.newerCursor;
        const attemptKey = `${windowId}:${direction}:${cursor == null ? 'null' : Math.trunc(cursor)}`;
        attemptKeyRef.current[direction] = attemptKey;
        params.targetWindowEdgeLoadInFlightRef.current = direction;
        void (async () => {
            try {
                const routeSeqHint =
                    target.kind === 'route-message-id' &&
                    typeof target.seqHint === 'number' &&
                    Number.isFinite(target.seqHint)
                        ? Math.trunc(target.seqHint)
                        : null;
                const loadTarget = target.kind === 'seq'
                    ? { kind: 'seq' as const, seq: Math.trunc(target.seq) }
                    : routeSeqHint != null
                        ? {
                            kind: 'route-message-id' as const,
                            routeMessageId: target.routeMessageId,
                            seqHint: routeSeqHint,
                        }
                        : null;
                if (!loadTarget) return;
                const result = await sync.loadTargetWindowMessages(
                    params.sessionId,
                    loadTarget,
                    { direction },
                );
                if (
                    result?.status === 'retryable_error' &&
                    mountedRef.current &&
                    observedWindowIdRef.current === windowId &&
                    nearEdgeRef.current[direction] &&
                    attemptKeyRef.current[direction] === attemptKey
                ) {
                    clearRetryTimeout(direction);
                    // Transport can fail while placement/fill readiness remains open, so
                    // readiness alone has no transition to re-drive this consumed cursor.
                    // Reuse the ordinary pager's bounded cooldown instead of retrying inline.
                    const configuredCooldownMs = sync.getSyncTuning().transcriptOlderLoadCooldownMs;
                    const cooldownMs = Number.isFinite(configuredCooldownMs)
                        ? Math.max(0, Math.trunc(configuredCooldownMs))
                        : 0;
                    retryTimeoutRef.current[direction] = setTimeout(() => {
                        retryTimeoutRef.current[direction] = null;
                        if (
                            !mountedRef.current ||
                            observedWindowIdRef.current !== windowId ||
                            !nearEdgeRef.current[direction] ||
                            attemptKeyRef.current[direction] !== attemptKey
                        ) return;
                        attemptKeyRef.current[direction] = null;
                        drainRef.current();
                    }, cooldownMs);
                }
                const currentOwner = currentOwnerRef.current;
                if (
                    mountedRef.current &&
                    result?.status === 'loaded' &&
                    result.targetPresent &&
                    currentOwner.sessionId === params.sessionId &&
                    currentOwner.activeWindowState?.windowId === windowId
                ) {
                    currentOwner.activeTargetWindowTargetRef.current = target;
                }
            } finally {
                if (params.targetWindowEdgeLoadInFlightRef.current === direction) {
                    params.targetWindowEdgeLoadInFlightRef.current = null;
                }
                // Release the single owner and drain from the latest committed
                // window state so an advanced cursor or opposite near edge can run.
                drainRef.current();
            }
        })();
    }, [
        params.activeTargetWindowTargetRef,
        params.activeWindowState,
        params.isReadyForLoad,
        params.isWarmKeepAliveInstance,
        params.sessionActive,
        params.sessionId,
        params.targetWindowEdgeLoadInFlightRef,
        clearRetryTimeout,
        resolveContinuationTarget,
    ]);
    useCommittedTranscriptRef(drainRef, drain);

    const readinessOpen = params.isReadyForLoad();
    React.useEffect(() => {
        if (!observeIdentity(params.activeWindowState?.windowId)) return;
        if (readinessOpen) drainRef.current();
    }, [
        observeIdentity,
        params.activeWindowState?.hasMoreNewer,
        params.activeWindowState?.hasMoreOlder,
        params.activeWindowState?.newerCursor,
        params.activeWindowState?.olderCursor,
        params.activeWindowState?.targetSeq,
        params.activeWindowState?.windowId,
        readinessOpen,
    ]);

    const observeProximity = React.useCallback((near: Readonly<Record<Direction, boolean>>) => {
        if (!observeIdentity(params.activeWindowState?.windowId)) return;
        for (const direction of ['older', 'newer'] as const) {
            const wasNear = nearEdgeRef.current[direction];
            nearEdgeRef.current[direction] = near[direction];
            if (wasNear && !near[direction]) {
                clearRetryTimeout(direction);
                attemptKeyRef.current[direction] = null;
            }
        }
        drain();
    }, [clearRetryTimeout, drain, observeIdentity, params.activeWindowState]);

    const observeReachedEdge = React.useCallback((direction: Direction) => {
        if (!observeIdentity(params.activeWindowState?.windowId)) return;
        nearEdgeRef.current[direction] = true;
        if (direction === 'newer' && params.activeWindowState?.hasMoreNewer === false) {
            sync.markSessionLiveTailIntent(params.sessionId);
            params.activeTargetWindowTargetRef.current = null;
            return;
        }
        drain();
    }, [
        drain,
        observeIdentity,
        params.activeTargetWindowTargetRef,
        params.activeWindowState,
        params.sessionId,
    ]);

    return React.useMemo(() => ({
        observeProximity,
        observeReachedEdge,
    }), [observeProximity, observeReachedEdge]);
}

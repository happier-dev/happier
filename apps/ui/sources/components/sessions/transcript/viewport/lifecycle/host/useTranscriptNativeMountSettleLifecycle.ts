import * as React from 'react';
import { sync } from '@/sync/sync';
import type { TranscriptLifecycleHost } from '@/components/sessions/transcript/viewport/lifecycle/lifecycleHost';
import type { SessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import {
    resolveNativeMountSettleIntervalDecision,
    type NativeMountSettleIntervalDecision,
} from '@/components/sessions/transcript/viewport/nativeBottomFollowObservationPolicy';

type MutableRef<T> = { current: T };

export function useTranscriptNativeMountSettleLifecycle(params: Readonly<{
    closeEntryViewportOwnership: (outcome: 'deadline') => void;
    composerInsetHeightRef: MutableRef<number>;
    flushPendingNativeMountSettleBottomPin: () => void;
    jumpToSeqActive: boolean;
    lastPinOffsetForIntentRef: MutableRef<number | null>;
    lifecycleHost: TranscriptLifecycleHost;
    listContentHeightRef: MutableRef<number>;
    listLayoutHeightRef: MutableRef<number>;
    nativeMountSettleAutoPinSuppressedRef: MutableRef<boolean>;
    nativeMountSettleDeadlineReachedRef: MutableRef<boolean>;
    pendingNativeMountSettleBottomPinHostRef: MutableRef<MutableRef<boolean> | null>;
    platformOS: string;
    scheduleNativePaintReleaseForEntryRestore: () => void;
    sessionId: string;
    sessionOpenLatch: SessionOpenLatch;
    setNativeMountSettleDeadlineReached: (value: boolean) => void;
    setNativeMountSettleStable: (value: boolean) => void;
    usesNativeFlashListBottomMaintenance: boolean;
}>) {
    const {
        closeEntryViewportOwnership,
        composerInsetHeightRef,
        flushPendingNativeMountSettleBottomPin,
        jumpToSeqActive,
        lastPinOffsetForIntentRef,
        lifecycleHost,
        listContentHeightRef,
        listLayoutHeightRef,
        nativeMountSettleAutoPinSuppressedRef,
        nativeMountSettleDeadlineReachedRef,
        pendingNativeMountSettleBottomPinHostRef,
        platformOS,
        scheduleNativePaintReleaseForEntryRestore,
        sessionId,
        sessionOpenLatch,
        setNativeMountSettleDeadlineReached,
        setNativeMountSettleStable,
        usesNativeFlashListBottomMaintenance,
    } = params;

    const observeMountSettleMetrics = React.useCallback((options: Readonly<{
        distanceFromBottom?: number;
        nowMs?: number;
    }> = {}) => {
        lifecycleHost.observeMountSettleMetrics({
            sessionId,
            nowMs: options.nowMs ?? Date.now(),
            initialFillStatus: sessionOpenLatch.initialFillStatus(),
            listContentHeight: listContentHeightRef.current,
            listLayoutHeight: listLayoutHeightRef.current,
            composerInsetHeight: composerInsetHeightRef.current,
            distanceFromBottom: options.distanceFromBottom ?? lastPinOffsetForIntentRef.current ?? 0,
        });
    }, [
        composerInsetHeightRef,
        lastPinOffsetForIntentRef,
        lifecycleHost,
        listContentHeightRef,
        listLayoutHeightRef,
        sessionId,
        sessionOpenLatch,
    ]);

    const applyNativeMountSettleIntervalDecision = React.useCallback((decisionParams: Readonly<{
        clearIntervalCallback: () => void;
        decision: NativeMountSettleIntervalDecision;
    }>): void => {
        const { clearIntervalCallback, decision } = decisionParams;
        if (decision.type === 'continue') return;
        closeEntryViewportOwnership('deadline');
        if (decision.type === 'stable') {
            setNativeMountSettleStable(true);
            nativeMountSettleDeadlineReachedRef.current = false;
            flushPendingNativeMountSettleBottomPin();
            clearIntervalCallback();
            return;
        }
        nativeMountSettleDeadlineReachedRef.current = true;
        setNativeMountSettleDeadlineReached(true);
        if (decision.requestPendingFlush && pendingNativeMountSettleBottomPinHostRef.current) {
            pendingNativeMountSettleBottomPinHostRef.current.current = true;
            flushPendingNativeMountSettleBottomPin();
        }
        clearIntervalCallback();
    }, [
        closeEntryViewportOwnership,
        flushPendingNativeMountSettleBottomPin,
        nativeMountSettleDeadlineReachedRef,
        pendingNativeMountSettleBottomPinHostRef,
        setNativeMountSettleDeadlineReached,
        setNativeMountSettleStable,
    ]);

    React.useEffect(() => {
        if (!usesNativeFlashListBottomMaintenance) return undefined;
        const tuning = sync.getSyncTuning();
        const intervalMs = tuning.transcriptMountSettleQuiescentWindowMs;
        const deadlineMs = Date.now() + tuning.transcriptInitialFillBudgetMs + intervalMs;
        const intervalId = setInterval(() => {
            const nowMs = Date.now();
            lifecycleHost.sampleMountSettle({ sessionId, nowMs });
            const mountSettleIntervalDecision = resolveNativeMountSettleIntervalDecision({
                autoPinSuppressed: nativeMountSettleAutoPinSuppressedRef.current,
                deadlineMs,
                nowMs,
                stableSettle: lifecycleHost.getMountSettleSnapshot().stableSettle,
            });
            applyNativeMountSettleIntervalDecision({
                clearIntervalCallback: () => clearInterval(intervalId),
                decision: mountSettleIntervalDecision,
            });
        }, intervalMs);
        return () => clearInterval(intervalId);
    }, [
        applyNativeMountSettleIntervalDecision,
        lifecycleHost,
        nativeMountSettleAutoPinSuppressedRef,
        sessionId,
        usesNativeFlashListBottomMaintenance,
    ]);

    const recordLayoutCommitObserved = React.useCallback(() => {
        const nowMs = Date.now();
        lifecycleHost.recordMountSettleLayoutCommitObserved({
            sessionId,
            nowMs,
        });
        observeMountSettleMetrics({ nowMs });
        scheduleNativePaintReleaseForEntryRestore();
    }, [lifecycleHost, observeMountSettleMetrics, scheduleNativePaintReleaseForEntryRestore, sessionId]);

    const shouldCommitContentHeightState = React.useCallback(() => {
        if (platformOS === 'web') return true;
        if (sessionOpenLatch.initialFillStatus() !== 'done') return true;
        return jumpToSeqActive;
    }, [jumpToSeqActive, platformOS, sessionOpenLatch]);

    return {
        observeMountSettleMetrics,
        recordLayoutCommitObserved,
        shouldCommitContentHeightState,
    };
}

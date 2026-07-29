import * as React from 'react';
import { sync } from '@/sync/sync';
import type { TranscriptLifecycleHost } from '@/components/sessions/transcript/viewport/lifecycle/lifecycleHost';
import type { SessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';

type MutableRef<T> = { current: T };

export function useTranscriptNativeMountSettleLifecycle(params: Readonly<{
    composerInsetHeightRef: MutableRef<number>;
    jumpToSeqActive: boolean;
    lastPinOffsetForIntentRef: MutableRef<number | null>;
    lifecycleHost: TranscriptLifecycleHost;
    listContentHeightRef: MutableRef<number>;
    listLayoutHeightRef: MutableRef<number>;
    nativeMountSettleDeadlineReachedRef: MutableRef<boolean>;
    platformOS: string;
    scheduleNativePaintReleaseForEntryRestore: () => void;
    sessionId: string;
    sessionOpenLatch: SessionOpenLatch;
    setNativeMountSettleDeadlineReached: (value: boolean) => void;
    setNativeMountSettleStable: (value: boolean) => void;
}>) {
    const {
        composerInsetHeightRef,
        jumpToSeqActive,
        lastPinOffsetForIntentRef,
        lifecycleHost,
        listContentHeightRef,
        listLayoutHeightRef,
        nativeMountSettleDeadlineReachedRef,
        platformOS,
        scheduleNativePaintReleaseForEntryRestore,
        sessionId,
        sessionOpenLatch,
        setNativeMountSettleDeadlineReached,
        setNativeMountSettleStable,
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

    // Mount settle is a native placement fact: its inputs are the list layout commit and composer
    // inset observations this host produces, whichever list renderer is mounted. Nothing else in
    // the package publishes `nativeMountSettleStable`, and the native reveal gate
    // (`resolveNativeFollowBottomObservationCanReleasePaint`) plus
    // `sessionOpenLatch.shouldShowNativeFirstPaintPlaceholder` both read it, so without this
    // producer the gate has no positive fact at all.
    //
    // The deadline below is the sole bound on that gate and must remain unconditional on native: it
    // fires as soon as `nowMs` passes `transcriptInitialFillBudgetMs +
    // transcriptMountSettleQuiescentWindowMs`, whatever the settle state, so a transcript can never
    // be withheld waiting for a signal that will not arrive.
    React.useEffect(() => {
        if (platformOS === 'web') return undefined;
        const tuning = sync.getSyncTuning();
        const intervalMs = tuning.transcriptMountSettleQuiescentWindowMs;
        const deadlineMs = Date.now() + tuning.transcriptInitialFillBudgetMs + intervalMs;
        const intervalId = setInterval(() => {
            const nowMs = Date.now();
            lifecycleHost.sampleMountSettle({ sessionId, nowMs });
            if (lifecycleHost.getMountSettleSnapshot().stableSettle) {
                setNativeMountSettleStable(true);
                nativeMountSettleDeadlineReachedRef.current = false;
                clearInterval(intervalId);
                return;
            }
            if (nowMs < deadlineMs) return;
            nativeMountSettleDeadlineReachedRef.current = true;
            setNativeMountSettleDeadlineReached(true);
            clearInterval(intervalId);
        }, intervalMs);
        return () => clearInterval(intervalId);
    }, [
        lifecycleHost,
        nativeMountSettleDeadlineReachedRef,
        platformOS,
        sessionId,
        setNativeMountSettleDeadlineReached,
        setNativeMountSettleStable,
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

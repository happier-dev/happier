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

    // Mount settle is a native placement fact, not a renderer fact: its inputs are the list layout
    // commit and composer inset observations, which the host produces identically under Legend and
    // FlashList. This producer used to install only when `usesNativeFlashListBottomMaintenance`
    // (`rendererKind === 'flashList' && !web`) was true, so under the shipped Legend renderer it
    // never ran: `nativeMountSettleStable` stayed false forever and the deadline never fired,
    // leaving the reveal gate it feeds with no facts at all.
    //
    // The deadline below is the sole bound on that gate. It must remain unconditional on native:
    // `resolveNativeMountSettleIntervalDecision` returns `deadline` as soon as `nowMs` passes
    // `transcriptInitialFillBudgetMs + transcriptMountSettleQuiescentWindowMs`, whatever the settle
    // state, so a transcript can never be withheld waiting for a signal that will not arrive.
    React.useEffect(() => {
        if (platformOS === 'web') return undefined;
        const tuning = sync.getSyncTuning();
        const intervalMs = tuning.transcriptMountSettleQuiescentWindowMs;
        const deadlineMs = Date.now() + tuning.transcriptInitialFillBudgetMs + intervalMs;

        // The check FOLLOWS the geometry instead of running on a fixed phase.
        //
        // Settle is "no meaningful change for `quiescentWindowMs`", and the scroll-ingress
        // path already samples on every real geometry observation — so a repeating interval
        // was a second sampler for one signal, ticking on a phase unrelated to when geometry
        // last moved. Detection therefore landed at the first tick at or after quiescence
        // completed, up to a full window late, and the thread was woken throughout the churn
        // for samples that could not possibly settle yet.
        //
        // Asking the coordinator when quiescence could next complete makes the wake exact and
        // keeps the schedule derived from the same fact the decision uses. Two invariants are
        // preserved deliberately:
        //  - The DEADLINE still bounds every wait, so the reveal gate this feeds can never
        //    hang on a signal that will not arrive.
        //  - While a precondition is unmet (`null`), it falls back to the previous cadence,
        //    because a precondition can be satisfied by something that does not sample.
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const clearPending = () => {
            if (timeoutId === null) return;
            clearTimeout(timeoutId);
            timeoutId = null;
        };
        const scheduleNext = () => {
            const nowMs = Date.now();
            const settleDelayMs = lifecycleHost.nextMountSettleCheckDelayMs(nowMs);
            const deadlineDelayMs = Math.max(0, deadlineMs - nowMs);
            const delayMs = Math.min(settleDelayMs ?? intervalMs, deadlineDelayMs);
            timeoutId = setTimeout(runCheck, Math.max(1, delayMs));
        };
        const runCheck = () => {
            timeoutId = null;
            const nowMs = Date.now();
            lifecycleHost.sampleMountSettle({ sessionId, nowMs });
            const mountSettleIntervalDecision = resolveNativeMountSettleIntervalDecision({
                autoPinSuppressed: nativeMountSettleAutoPinSuppressedRef.current,
                deadlineMs,
                nowMs,
                stableSettle: lifecycleHost.getMountSettleSnapshot().stableSettle,
            });
            applyNativeMountSettleIntervalDecision({
                clearIntervalCallback: clearPending,
                decision: mountSettleIntervalDecision,
            });
            if (mountSettleIntervalDecision.type === 'continue') scheduleNext();
        };
        scheduleNext();
        return clearPending;
    }, [
        applyNativeMountSettleIntervalDecision,
        lifecycleHost,
        nativeMountSettleAutoPinSuppressedRef,
        platformOS,
        sessionId,
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

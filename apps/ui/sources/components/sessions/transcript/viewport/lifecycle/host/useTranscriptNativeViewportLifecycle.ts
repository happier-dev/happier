import * as React from 'react';
import type {
    TranscriptLifecycleHost,
    TranscriptLifecycleHostNativeUserScrollTakeoverPlan,
    TranscriptLifecycleHostScrollObservationPlan,
} from '@/components/sessions/transcript/viewport/lifecycle/lifecycleHost';
import type { SessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import type { EntryRestoreOwner } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import type { SessionEntryViewportRefValue } from '@/components/sessions/transcript/viewport/entryRestore/host/useTranscriptSessionEntryLifecycle';
import type { TranscriptMeasurementHost } from '@/components/sessions/transcript/measurement/transcriptMeasurementHost';
import {
    shouldIgnoreNativeInvalidScrollObservation as resolveShouldIgnoreNativeInvalidScrollObservation,
} from '@/components/sessions/transcript/viewport/nativePassiveScrollPolicy';

type MutableRef<T> = { current: T };
type NativeUserScrollTakeoverApplyEffect =
    TranscriptLifecycleHostNativeUserScrollTakeoverPlan['nativeUserScrollTakeoverEffects'][number];

export function useTranscriptNativeViewportLifecycle(params: Readonly<{
    closeEntryViewportOwnership: (outcome: 'confirmed') => void;
    consumedSessionEntryViewportRef: MutableRef<{ entryKind: string; sessionId: string } | null>;
    entryRestoreOwner: EntryRestoreOwner;
    entrySliceWindowRef: MutableRef<{ sessionId: string; anchorRowId: string } | null>;
    lifecycleHost: TranscriptLifecycleHost;
    lastUserScrollIntentAtMsRef: MutableRef<number>;
    measurementHost: TranscriptMeasurementHost;
    nativeMountSettleAutoPinSuppressedRef: MutableRef<boolean>;
    nativeInitialViewportPendingObservationRef: MutableRef<boolean>;
    pendingNativeMountSettleBottomPinHostRef: MutableRef<MutableRef<boolean> | null>;
    platformOS: string;
    preemptEntryRestoreTransaction: () => void;
    sessionEntryViewportRef: MutableRef<SessionEntryViewportRefValue>;
    sessionId: string;
    sessionOpenLatch: SessionOpenLatch;
    setEntrySliceWindow: (value: { sessionId: string; anchorRowId: string } | null) => void;
    setNativeInitialViewportPendingObservation: (pending: boolean) => void;
}>) {
    const {
        closeEntryViewportOwnership,
        consumedSessionEntryViewportRef,
        entryRestoreOwner,
        entrySliceWindowRef,
        lifecycleHost,
        lastUserScrollIntentAtMsRef,
        measurementHost,
        nativeInitialViewportPendingObservationRef,
        nativeMountSettleAutoPinSuppressedRef,
        pendingNativeMountSettleBottomPinHostRef,
        platformOS,
        preemptEntryRestoreTransaction,
        sessionEntryViewportRef,
        sessionId,
        sessionOpenLatch,
        setEntrySliceWindow,
        setNativeInitialViewportPendingObservation,
    } = params;

    const updateNativeInitialViewportPendingObservation = React.useCallback((pending: boolean) => {
        if (platformOS === 'web') return;
        if (nativeInitialViewportPendingObservationRef.current === pending) return;
        nativeInitialViewportPendingObservationRef.current = pending;
        setNativeInitialViewportPendingObservation(pending);
    }, [nativeInitialViewportPendingObservationRef, platformOS, setNativeInitialViewportPendingObservation]);

    const applyNativeUserScrollTakeoverHostEffects = React.useCallback((
        effects: readonly NativeUserScrollTakeoverApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== sessionId) continue;
            switch (effect.type) {
                case 'native-user-scroll-preempt-entry-restore':
                    preemptEntryRestoreTransaction();
                    if (sessionEntryViewportRef.current?.sessionId === sessionId) {
                        consumedSessionEntryViewportRef.current = {
                            entryKind: sessionEntryViewportRef.current.entryKind,
                            sessionId,
                        };
                        sessionEntryViewportRef.current = null;
                        entrySliceWindowRef.current = null;
                        setEntrySliceWindow(null);
                    }
                    break;
                case 'native-user-scroll-cancel-native-mount-settle-bottom-pin':
                    if (pendingNativeMountSettleBottomPinHostRef.current) {
                        pendingNativeMountSettleBottomPinHostRef.current.current = false;
                    }
                    break;
                case 'native-user-scroll-suppress-native-mount-settle-auto-pin':
                    nativeMountSettleAutoPinSuppressedRef.current = true;
                    break;
                case 'native-user-scroll-clear-native-initial-viewport-pending-observation':
                    updateNativeInitialViewportPendingObservation(false);
                    break;
                case 'native-user-scroll-record-intent-timestamp':
                    lastUserScrollIntentAtMsRef.current = effect.timestampMs;
                    break;
            }
        }
    }, [
        consumedSessionEntryViewportRef,
        entrySliceWindowRef,
        lastUserScrollIntentAtMsRef,
        nativeMountSettleAutoPinSuppressedRef,
        pendingNativeMountSettleBottomPinHostRef,
        preemptEntryRestoreTransaction,
        sessionEntryViewportRef,
        sessionId,
        setEntrySliceWindow,
        updateNativeInitialViewportPendingObservation,
    ]);

    const recordNativeUserScrollIntent = React.useCallback((nowMs: number = Date.now()) => {
        if (platformOS === 'web') return;
        const plan = lifecycleHost.planNativeUserScrollTakeover({
            sessionId,
            timestampMs: nowMs,
        });
        applyNativeUserScrollTakeoverHostEffects(plan.nativeUserScrollTakeoverEffects);
    }, [
        applyNativeUserScrollTakeoverHostEffects,
        lifecycleHost,
        platformOS,
        sessionId,
    ]);

    const resetNativeSessionViewportLifecycle = React.useCallback((resetSessionId: string) => {
        if (platformOS === 'web') return;
        sessionOpenLatch.resetNativeInitialViewport(resetSessionId);
        updateNativeInitialViewportPendingObservation(false);
    }, [platformOS, sessionOpenLatch, updateNativeInitialViewportPendingObservation]);

    const hasNativeContentMeasurementForCurrentSession = React.useCallback((): boolean => {
        return measurementHost.hasNativeContentMeasurementForSession({
            platform: platformOS === 'web' ? 'web' : 'native',
            sessionId,
        });
    }, [measurementHost, platformOS, sessionId]);

    const hasNativeInitialViewportAppliedForCurrentSession = React.useCallback((): boolean => {
        if (platformOS === 'web') return true;
        return sessionOpenLatch.hasNativeInitialViewportApplied(sessionId);
    }, [platformOS, sessionId, sessionOpenLatch]);

    const markNativeInitialViewportAppliedForCurrentSession = React.useCallback((options?: Readonly<{
        entrySettleBaselineContentHeight?: number;
    }>) => {
        if (platformOS === 'web') return;
        const { wasApplied } = sessionOpenLatch.markNativeInitialViewportApplied(sessionId);
        updateNativeInitialViewportPendingObservation(false);
        if (!wasApplied && sessionEntryViewportRef.current?.shouldFollowBottom !== false) {
            lifecycleHost.armNativeEntrySettleConfirmation({
                baselineContentHeight: options?.entrySettleBaselineContentHeight,
                sessionId,
            });
        }
        if (!entryRestoreOwner.hasOpenTransaction(sessionId)) {
            closeEntryViewportOwnership('confirmed');
        }
    }, [
        closeEntryViewportOwnership,
        entryRestoreOwner,
        lifecycleHost,
        platformOS,
        sessionEntryViewportRef,
        sessionId,
        sessionOpenLatch,
        updateNativeInitialViewportPendingObservation,
    ]);

    const applyNativeBottomFollowCompletionHostEffects = React.useCallback((
        effects: TranscriptLifecycleHostScrollObservationPlan['nativeBottomFollowCompletionEffects'],
    ) => {
        for (const effect of effects) {
            if (
                effect.type !== 'complete-native-bottom-follow' ||
                effect.sessionId !== sessionId
            ) {
                continue;
            }
            if (pendingNativeMountSettleBottomPinHostRef.current) {
                pendingNativeMountSettleBottomPinHostRef.current.current = false;
            }
            markNativeInitialViewportAppliedForCurrentSession({
                entrySettleBaselineContentHeight: effect.entrySettleBaselineContentHeight,
            });
        }
    }, [
        markNativeInitialViewportAppliedForCurrentSession,
        pendingNativeMountSettleBottomPinHostRef,
        sessionId,
    ]);

    const shouldIgnoreNativeInvalidScrollObservation = React.useCallback((
        offsetY: number,
        distanceFromBottom: number,
    ): boolean => {
        return resolveShouldIgnoreNativeInvalidScrollObservation({
            distanceFromBottom,
            isWeb: platformOS === 'web',
            offsetY,
        });
    }, [platformOS]);

    return {
        applyNativeBottomFollowCompletionHostEffects,
        applyNativeUserScrollTakeoverHostEffects,
        hasNativeContentMeasurementForCurrentSession,
        hasNativeInitialViewportAppliedForCurrentSession,
        markNativeInitialViewportAppliedForCurrentSession,
        recordNativeUserScrollIntent,
        resetNativeSessionViewportLifecycle,
        shouldIgnoreNativeInvalidScrollObservation,
        updateNativeInitialViewportPendingObservation,
    };
}

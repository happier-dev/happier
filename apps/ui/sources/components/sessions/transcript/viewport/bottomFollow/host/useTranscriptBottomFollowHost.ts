import * as React from 'react';
import { Platform } from 'react-native';

import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';
import type {
    TranscriptViewportCommand,
    TranscriptViewportControllerInput,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type {
    NativeDragActiveMirrorApplyEffect,
} from '@/components/sessions/transcript/viewport/lifecycle/nativeActiveMirror';
import type {
    NativeExplicitJumpConfirmationEffect,
    TranscriptLifecycleHost,
} from '@/components/sessions/transcript/viewport/lifecycle/lifecycleHost';
import type {
    TranscriptBottomFollowModeState,
    TranscriptScrollPinState,
} from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import { resolveTranscriptScrollPinStateUpdate } from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import type {
    TranscriptViewportTelemetryScrollReason,
} from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import {
    planBottomFollowWriteSchedulerEvent,
    type BottomFollowAutomaticWriter,
    type BottomFollowWriteSchedulerEffect,
    type BottomFollowWriteSchedulerState,
} from '@/components/sessions/transcript/viewport/bottomFollow/writeScheduler';
import { useExplicitJumpWriteBarrier } from '@/components/sessions/transcript/viewport/bottomFollow/explicitJumpWriteBarrier';

type MutableRef<T> = { current: T };

type BottomFollowLifecycleHost = Pick<
    TranscriptLifecycleHost,
    | 'observeNativeScrollConfirmation'
    | 'planFollowBottomIntentTakeover'
>;

export type TranscriptBottomFollowHostDeps = Readonly<{
    applyFollowBottomIntentTakeoverApplyEffects(effects: readonly unknown[]): void;
    applyNativeExplicitJumpConfirmationEffects(effects: readonly NativeExplicitJumpConfirmationEffect[]): void;
    authorizeImmediateBottomFollowWriteRef: MutableRef<(
        writer: BottomFollowAutomaticWriter,
        reason: TranscriptViewportTelemetryScrollReason,
    ) => boolean>;
    commitBottomFollowModeState(next: TranscriptBottomFollowModeState): void;
    commitExplicitReturnToLiveTailState(reason: TranscriptViewportTelemetryScrollReason | 'follow-bottom-intent'): void;
    commitScrollPinState(next: TranscriptScrollPinState): void;
    currentBottomFollowModeStateRef: MutableRef<TranscriptBottomFollowModeState>;
    executeViewportCommand(command: TranscriptViewportCommand): boolean;
    followBottomIntentKey: string | number | null | undefined;
    invalidateViewportAnchorCapture(): void;
    isPinnedRef: MutableRef<boolean>;
    latestCommittedActivityKey: string | null | undefined;
    lifecycleHost: BottomFollowLifecycleHost;
    nativeMountSettleDeadlineReachedRef: MutableRef<boolean>;
    pinEnabled: boolean;
    pinThresholdPx: number;
    resolveViewportCommand(input: TranscriptViewportControllerInput): TranscriptViewportCommand;
    scrollPinRef: MutableRef<TranscriptScrollPinState>;
    sessionId: string;
    tryPinToBottomDom(): boolean;
    wantsPinnedRef: MutableRef<boolean>;
}>;

export type TranscriptBottomFollowHost = Readonly<{
    applyNativeDragActiveMirrorEffects(effects: readonly NativeDragActiveMirrorApplyEffect[]): void;
    beginExplicitJumpWriteBarrier(): void;
    endExplicitJumpWriteBarrier(): void;
    getGestureActive(): boolean;
    observeNativeConfirmation(params: Readonly<{
        contentHeight: number;
        distanceFromBottom: number;
        isTrusted: boolean;
        mountSettleStable: boolean;
    }>): boolean;
    pinToBottom(): boolean;
}>;

export function useTranscriptBottomFollowHost(deps: TranscriptBottomFollowHostDeps): TranscriptBottomFollowHost {
    const {
        applyFollowBottomIntentTakeoverApplyEffects,
        applyNativeExplicitJumpConfirmationEffects,
        authorizeImmediateBottomFollowWriteRef: externalAuthorizeImmediateBottomFollowWriteRef,
        commitBottomFollowModeState,
        commitExplicitReturnToLiveTailState,
        commitScrollPinState,
        currentBottomFollowModeStateRef,
        executeViewportCommand,
        followBottomIntentKey,
        invalidateViewportAnchorCapture,
        isPinnedRef,
        latestCommittedActivityKey,
        lifecycleHost,
        nativeMountSettleDeadlineReachedRef,
        pinEnabled,
        pinThresholdPx,
        resolveViewportCommand,
        scrollPinRef,
        sessionId,
        tryPinToBottomDom,
        wantsPinnedRef,
    } = deps;

    const bottomFollowWriteSchedulerStateRef = React.useRef<BottomFollowWriteSchedulerState>({
        explicitJumpActive: false,
        gestureActive: false,
    });

    const observeNativeConfirmation = React.useCallback((params: Readonly<{
        contentHeight: number;
        distanceFromBottom: number;
        isTrusted: boolean;
        mountSettleStable: boolean;
    }>): boolean => {
        if (Platform.OS === 'web') return false;
        const plan = lifecycleHost.observeNativeScrollConfirmation({
            bottomFollowMode: currentBottomFollowModeStateRef.current.mode,
            contentHeight: params.contentHeight,
            distanceFromBottom: params.distanceFromBottom,
            isTrusted: params.isTrusted,
            mountSettleDeadlineReached: nativeMountSettleDeadlineReachedRef.current,
            mountSettleStable: params.mountSettleStable,
            pinThresholdPx,
            sessionId,
            wantsPinned: wantsPinnedRef.current,
        });
        applyNativeExplicitJumpConfirmationEffects(plan.explicitJumpEffects);
        return plan.consumed;
    }, [
        applyNativeExplicitJumpConfirmationEffects,
        currentBottomFollowModeStateRef,
        lifecycleHost,
        nativeMountSettleDeadlineReachedRef,
        pinThresholdPx,
        sessionId,
        wantsPinnedRef,
    ]);

    const pinToBottom = React.useCallback((): boolean => {
        if (Platform.OS === 'web') {
            return tryPinToBottomDom();
        }
        return executeViewportCommand(resolveViewportCommand({
            type: 'jump-to-bottom',
            sessionId,
        }));
    }, [
        executeViewportCommand,
        resolveViewportCommand,
        sessionId,
        tryPinToBottomDom,
    ]);

    const applyAuthorizedBottomFollowWrite = React.useCallback((
        effect: Extract<BottomFollowWriteSchedulerEffect, { type: 'authorize-write' }>,
    ): boolean => {
        return executeViewportCommand(resolveViewportCommand({
            type: 'pin-bottom',
            sessionId,
            reason: effect.reason,
            mode: 'follow-bottom',
            force: true,
            animated: false,
        }));
    }, [
        executeViewportCommand,
        resolveViewportCommand,
        sessionId,
    ]);

    const applyBottomFollowWriteSchedulerEffects = React.useCallback((
        effects: readonly BottomFollowWriteSchedulerEffect[],
    ): void => {
        for (const effect of effects) {
            if (effect.type === 'authorize-write') {
                applyAuthorizedBottomFollowWrite(effect);
            }
        }
    }, [applyAuthorizedBottomFollowWrite]);

    const authorizeImmediateBottomFollowWrite = React.useCallback((
        writer: BottomFollowAutomaticWriter,
        reason: TranscriptViewportTelemetryScrollReason,
    ): boolean => {
        const plan = planBottomFollowWriteSchedulerEvent(bottomFollowWriteSchedulerStateRef.current, {
            reason,
            type: 'authorize-immediate-write',
            writer,
        });
        bottomFollowWriteSchedulerStateRef.current = plan.state;
        applyBottomFollowWriteSchedulerEffects(plan.effects);
        return plan.effects.some((effect) => effect.type === 'authorize-write');
    }, [applyBottomFollowWriteSchedulerEffects]);
    useCommittedTranscriptRef(
        externalAuthorizeImmediateBottomFollowWriteRef,
        authorizeImmediateBottomFollowWrite,
    );

    const [beginExplicitJumpWriteBarrier, endExplicitJumpWriteBarrier] = useExplicitJumpWriteBarrier({
        applyEffects: applyBottomFollowWriteSchedulerEffects,
        schedulerStateRef: bottomFollowWriteSchedulerStateRef,
    });

    const applyNativeDragActiveMirrorEffects = React.useCallback((
        effects: readonly NativeDragActiveMirrorApplyEffect[],
    ) => {
        for (const effect of effects) {
            if (effect.sessionId !== sessionId) continue;
            const plan = planBottomFollowWriteSchedulerEvent(
                bottomFollowWriteSchedulerStateRef.current,
                {
                    active: effect.active,
                    type: 'set-gesture-active',
                },
            );
            bottomFollowWriteSchedulerStateRef.current = plan.state;
            applyBottomFollowWriteSchedulerEffects(plan.effects);
        }
    }, [applyBottomFollowWriteSchedulerEffects, sessionId]);

    const lastFollowBottomIntentKeyRef = React.useRef<string | number | null>(followBottomIntentKey ?? null);
    React.useLayoutEffect(() => {
        const nextFollowBottomIntentKey = followBottomIntentKey ?? null;
        if (nextFollowBottomIntentKey == null) return;
        if (lastFollowBottomIntentKeyRef.current === nextFollowBottomIntentKey) return;
        lastFollowBottomIntentKeyRef.current = nextFollowBottomIntentKey;
        invalidateViewportAnchorCapture();
        const plan = lifecycleHost.planFollowBottomIntentTakeover({ sessionId });
        commitBottomFollowModeState(plan.state.bottomFollowState);
        applyFollowBottomIntentTakeoverApplyEffects(plan.followBottomIntentTakeoverEffects);
        pinToBottom();
        commitExplicitReturnToLiveTailState('follow-bottom-intent');
    }, [
        applyFollowBottomIntentTakeoverApplyEffects,
        commitBottomFollowModeState,
        commitExplicitReturnToLiveTailState,
        followBottomIntentKey,
        invalidateViewportAnchorCapture,
        lifecycleHost,
        pinToBottom,
        sessionId,
    ]);

    React.useLayoutEffect(() => {
        const nextScrollPin = resolveTranscriptScrollPinStateUpdate(
            { ...scrollPinRef.current, isPinned: isPinnedRef.current },
            {
                type: 'newActivity',
                enabled: pinEnabled,
                activityKey: latestCommittedActivityKey ?? null,
            },
        );
        if (nextScrollPin) {
            commitScrollPinState(nextScrollPin);
        }
    }, [
        commitScrollPinState,
        isPinnedRef,
        latestCommittedActivityKey,
        pinEnabled,
        scrollPinRef,
    ]);

    return React.useMemo(() => ({
        applyNativeDragActiveMirrorEffects,
        beginExplicitJumpWriteBarrier,
        endExplicitJumpWriteBarrier,
        getGestureActive: () => bottomFollowWriteSchedulerStateRef.current.gestureActive,
        observeNativeConfirmation,
        pinToBottom,
    }), [
        applyNativeDragActiveMirrorEffects,
        beginExplicitJumpWriteBarrier,
        endExplicitJumpWriteBarrier,
        observeNativeConfirmation,
        pinToBottom,
    ]);
}

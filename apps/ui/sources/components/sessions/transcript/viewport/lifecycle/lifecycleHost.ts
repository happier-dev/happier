import type { TranscriptViewportTelemetryScrollReason } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type {
    TranscriptBottomFollowMode,
} from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import type { TranscriptBottomFollowIntentResult } from '@/components/sessions/transcript/scroll/resolveTranscriptBottomFollowIntent';
import type { TranscriptViewportScrollReason } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';

import {
    resolveNativeBottomFollowCompletionEffects,
    type NativeBottomFollowCompletionEffect,
} from '../nativeBottomFollowObservationPolicy';
import {
    shouldIgnoreNativePassiveViewportScroll,
    shouldRecordNativePassiveUnpinnedMovement,
} from '../nativePassiveScrollPolicy';
import {
    createTranscriptViewportLifecycle,
    type TranscriptViewportExplicitJumpTakeoverReason,
    type TranscriptViewportLifecycle,
    type TranscriptViewportLifecycleEffect,
    type TranscriptViewportLifecycleState,
    type TranscriptViewportLifecycleTransition,
} from './lifecycle';
import {
    resolveExplicitJumpTakeoverApplyEffects,
    type ExplicitJumpTakeoverApplyEffect,
} from './explicitJumpTakeover';
import {
    resolveExplicitReturnToLiveTailApplyEffects,
    resolveExplicitReturnToLiveTailViewportEffects,
    type ExplicitReturnToLiveTailApplyEffect,
    type ExplicitReturnToLiveTailViewportEffect,
} from './explicitReturnToLiveTail';
import {
    resolveFollowBottomIntentTakeoverApplyEffects,
    type FollowBottomIntentTakeoverApplyEffect,
} from './followBottomIntentTakeover';
import {
    resolveLocalTranscriptInteractionIntentApplyEffects,
    type LocalTranscriptInteractionIntentApplyEffect,
} from './localTranscriptInteractionIntent';
import {
    resolveNativeDragActiveMirrorApplyEffects,
    resolveNativeMomentumActiveMirrorApplyEffects,
    type NativeDragActiveMirrorApplyEffect,
    type NativeMomentumActiveMirrorApplyEffect,
} from './nativeActiveMirror';
import {
    resolveNativeBottomFollowRearmResetEffects,
    type NativeBottomFollowRearmResetEffect,
} from './nativeBottomFollowRearmReset';
import {
    resolveGenericScrollObservationAnchorCaptureCancellationEffects,
    resolveGenericScrollObservationViewportStateEffects,
} from './genericScrollObservationViewportState';
import {
    resolveNativeObservedViewportStateGenericLifecycleEffects,
} from './nativeObservedViewportStateGenericEffect';
import {
    resolveNativeScrollAcceptedViewportPaintObservationEffects,
    type NativeScrollAcceptedViewportPaintEffect,
} from './nativeScrollAcceptedViewportPaint';
import {
    resolveNativeScrollObservationAnchorCaptureSuppression,
} from './nativeScrollAnchorCaptureSuppression';
import {
    resolveNativeScrollAwayGestureLiveTailBailDecision,
    resolveNativeScrollAwayGestureLiveTailBailEffects,
    type NativeScrollAwayGestureLiveTailBailEffect,
} from './nativeScrollAwayGestureLiveTailBail';
import {
    resolveNativeScrollFactsObservationEffects,
} from './nativeScrollFactsObservation';
import {
    resolveNativeScrollFollowIntent,
} from './nativeScrollFollowIntent';
import {
    resolveNativeScrollPassiveDriftBailDecision,
    resolveNativeScrollPassiveDriftBailGenericEffects,
} from './nativeScrollPassiveDriftBail';
import {
    resolveNativeScrollReadOnlyVisibleBottomDecision,
    resolveNativeScrollReadOnlyVisibleBottomGenericEffects,
} from './nativeScrollReadOnlyVisibleBottom';
import {
    resolveNativeScrollReleaseLiveTailGenericLifecycleEffects,
} from './nativeScrollReleaseLiveTailGenericEffect';
import {
    resolveNativeSettledReturnToLiveTailApplyEffects,
    type NativeSettledReturnToLiveTailApplyEffects,
} from './nativeReturnToLiveTail';
import {
    resolveNativeTouchIntentApplyEffects,
    type NativeTouchIntentApplyEffect,
} from './nativeTouchIntent';
import {
    resolveNativeUserScrollTakeoverApplyEffects,
    type NativeUserScrollTakeoverApplyEffect,
} from './nativeUserScrollTakeover';
import {
    resolveNativeTouchReleaseLiveTailStateEffects,
    type NativeTouchReleaseLiveTailStateEffect,
} from './nativeTouchReleaseLiveTail';
import {
    createNativeConfirmationOwner,
    type NativeConfirmationOwnerEntrySettleArmInput,
    type NativeConfirmationOwnerEntrySettleResetInput,
    type NativeConfirmationOwnerExplicitJumpArmInput,
    type NativeConfirmationOwnerExplicitJumpClearInput,
    type NativeConfirmationOwnerScrollInput,
    type NativeConfirmationOwnerScrollPlan,
} from './nativeConfirmationOwner';
import {
    createTranscriptMountSettlePinCoordinator,
    type TranscriptMountSettleMetrics,
    type TranscriptMountSettleSnapshot,
    type TranscriptMountSettleTuning,
} from './mountSettle';
import {
    resolveSessionEntryRenderResetEffects,
    type SessionEntryRenderResetEffects,
} from './sessionEntryRenderResetEffects';
import {
    resolveSessionEntryViewportApplyEffects,
    type SessionEntryViewportApplyEffect,
} from './sessionEntryViewport';
import {
    resolveActiveWebScrollFallbackObservationEffects,
} from './webScrollFallbackFollowIntent';
import {
    resolveWebScrollFactsObservationEffects,
} from './webScrollFactsObservation';
import {
    resolveWebScrollObservationGenericLifecycleEffects,
} from './webScrollObservationGenericEffect';
import {
    resolveWebUserScrollIntentTimestampApplyEffects,
    resolveWebUserScrollTakeoverApplyEffects,
} from './webUserScrollIntent';

export type {
    NativeEntrySettleConfirmationEffect,
    NativeExplicitJumpConfirmationEffect,
} from './nativeConfirmationOwner';

export type TranscriptLifecycleHostSessionEntryInput = Readonly<{
    entryDistanceFromLiveTailPx?: number | null;
    platform: 'native' | 'web';
    sessionId: string;
    shouldFollowLiveTail: boolean;
}>;

export type TranscriptLifecycleHostExplicitReturnInput = Readonly<{
    intent: 'follow-bottom-intent' | 'jump-to-bottom';
    sessionId: string;
}>;

export type TranscriptLifecycleHostNativeExplicitJumpConfirmationArmInput =
    NativeConfirmationOwnerExplicitJumpArmInput;

export type TranscriptLifecycleHostNativeExplicitJumpConfirmationClearInput =
    NativeConfirmationOwnerExplicitJumpClearInput;

export type TranscriptLifecycleHostNativeEntrySettleConfirmationArmInput =
    NativeConfirmationOwnerEntrySettleArmInput;

export type TranscriptLifecycleHostNativeEntrySettleConfirmationResetInput =
    NativeConfirmationOwnerEntrySettleResetInput;

export type TranscriptLifecycleHostNativeScrollConfirmationInput =
    NativeConfirmationOwnerScrollInput;

export type TranscriptLifecycleHostNativeScrollConfirmationPlan =
    NativeConfirmationOwnerScrollPlan;

type TranscriptLifecycleHostScrollObservationCommonInput = Readonly<{
    distanceFromLiveTailPx: number;
    isTrusted: boolean;
    movedAwayFromLiveTail: boolean;
    movedTowardLiveTail: boolean;
    nowMs: number;
    pinEnabled: boolean;
    pinThresholdPx: number;
    previousScrollOffsetPx: number | null;
    scrollOffsetPx: number;
    sessionId: string;
    wantsPinned: boolean;
}>;

export type TranscriptLifecycleHostWebScrollObservationInput =
    TranscriptLifecycleHostScrollObservationCommonInput & Readonly<{
        hasLiveWebMetrics?: boolean;
        platform: 'web';
        recentUserIntent?: boolean;
        /**
         * Web DOM observation attestation that `scrollTop` moved since the last
         * observed (landed) value. `false` marks the echo of the app's own
         * programmatic write — RN-web still reports such echoes `isTrusted: true`
         * (the Q1-WEB-1 trap), so the trusted-return fast path must not treat
         * them as a user returning to the live tail. Omitted when no live DOM
         * metrics were available to attest the frame.
         */
        webMovedSinceLastObservation?: boolean;
        webObservedUserScrollMovement: boolean;
    }>;

export type TranscriptLifecycleHostNativeScrollObservationInput =
    TranscriptLifecycleHostScrollObservationCommonInput & Readonly<{
        bottomFollowMode: TranscriptBottomFollowMode;
        configuredBottomDistanceNoiseFloorPx: number | null | undefined;
        contentHeightPx: number;
        distanceFromLiveTailForReleasePx: number;
        entryRestoreConfirmedByObservation: boolean;
        hasNativeContentMeasurement: boolean;
        hasNativeInitialViewportApplied: boolean;
        hasOpenTrustedAwayGesture: boolean;
        hasRenderedItems: boolean;
        hasTrustedDragSession: boolean;
        isLoaded: boolean;
        isWarmKeepAliveInstance: boolean;
        lastUserScrollIntentAtMs: number;
        layoutHeightPx: number;
        nativeListDragActive: boolean;
        nativeMomentumScrollActive: boolean;
        nativeMountSettleDeadlineReached: boolean;
        nativeMountSettleStable: boolean;
        platform: 'native';
        recentUserIntent: boolean;
        sessionEntrySessionId: string | null | undefined;
        sessionEntryShouldFollowBottom: boolean | null | undefined;
        userIntentRecentMs: number;
    }>;

export type TranscriptLifecycleHostScrollObservationInput =
    | TranscriptLifecycleHostNativeScrollObservationInput
    | TranscriptLifecycleHostWebScrollObservationInput;

export type TranscriptLifecycleHostScrollObservationDisposition =
    | 'consumed'
    | 'continue'
    | 'ignored';

export type TranscriptLifecycleHostScrollObservationStep =
    | Readonly<{
        lifecycleEffects: readonly TranscriptViewportLifecycleEffect[];
        type: 'web-user-scroll';
    }>
    | Readonly<{
        lifecycleEffects: readonly TranscriptViewportLifecycleEffect[];
        type: 'web-scroll-facts';
    }>
    | Readonly<{
        genericEffects: readonly TranscriptViewportLifecycleEffect[];
        type: 'web-generic-observation';
    }>
    | Readonly<{
        genericEffects: readonly TranscriptViewportLifecycleEffect[];
        type: 'web-fallback';
    }>
    | Readonly<{
        followIntent: TranscriptBottomFollowIntentResult;
        type: 'native-follow-intent';
    }>
    | Readonly<{
        lifecycleEffects: readonly TranscriptViewportLifecycleEffect[];
        type: 'native-scroll-facts';
    }>
    | Readonly<{
        bailEffects: readonly NativeScrollAwayGestureLiveTailBailEffect[];
        type: 'native-away-gesture-live-tail-bail';
    }>
    | Readonly<{
        reason: 'native-away-gesture-live-tail-bail';
        type: 'consume-observation';
    }>
    | Readonly<{
        acceptedViewportPaintEffects: readonly NativeScrollAcceptedViewportPaintEffect[];
        type: 'native-accepted-viewport-paint';
    }>
    | Readonly<{
        acceptedViewportPaintEffects: readonly NativeScrollAcceptedViewportPaintEffect[];
        nativeSettledReturnEffects: NativeSettledReturnToLiveTailApplyEffects;
        type: 'native-settled-return';
    }>
    | Readonly<{
        acceptedViewportPaintEffects: readonly NativeScrollAcceptedViewportPaintEffect[];
        genericEffects: readonly TranscriptViewportLifecycleEffect[];
        lifecycleEffects: readonly TranscriptViewportLifecycleEffect[];
        type: 'native-return-or-release';
    }>
    | Readonly<{
        acceptedViewportPaintEffects: readonly NativeScrollAcceptedViewportPaintEffect[];
        genericEffects: readonly TranscriptViewportLifecycleEffect[];
        lifecycleEffects: readonly TranscriptViewportLifecycleEffect[];
        type: 'native-observed-viewport-state';
    }>
    | Readonly<{
        genericEffects: readonly TranscriptViewportLifecycleEffect[];
        type: 'native-read-only-visible-bottom';
    }>
    | Readonly<{
        genericEffects: readonly TranscriptViewportLifecycleEffect[];
        type: 'native-passive-drift-bail';
    }>
    | Readonly<{
        acceptedViewportPaintEffects: readonly NativeScrollAcceptedViewportPaintEffect[];
        genericEffects: readonly TranscriptViewportLifecycleEffect[];
        type: 'generic-fallback';
    }>
    | Readonly<{
        effect: TranscriptLifecycleHostNativePassiveScrollObservationEffect;
        nativeUserScrollTakeoverEffects: readonly NativeUserScrollTakeoverApplyEffect[];
        type: 'native-passive-observation';
    }>;

type LifecycleHostPlanBase = Readonly<{
    lifecycleEffects: readonly TranscriptViewportLifecycleEffect[];
    state: TranscriptViewportLifecycleState;
}>;

export type TranscriptLifecycleHostSessionEntryPlan = LifecycleHostPlanBase & Readonly<{
    renderResetEffects: SessionEntryRenderResetEffects;
    viewportEffects: readonly SessionEntryViewportApplyEffect[];
}>;

export type TranscriptLifecycleHostExplicitJumpPlan = LifecycleHostPlanBase & Readonly<{
    explicitJumpTakeoverEffects: readonly ExplicitJumpTakeoverApplyEffect[];
}>;

export type TranscriptLifecycleHostExplicitReturnPlan = LifecycleHostPlanBase & Readonly<{
    explicitReturnEffects: readonly ExplicitReturnToLiveTailApplyEffect[];
    viewportEffects: readonly ExplicitReturnToLiveTailViewportEffect[];
}>;

export type TranscriptLifecycleHostFollowBottomIntentPlan = LifecycleHostPlanBase & Readonly<{
    followBottomIntentTakeoverEffects: readonly FollowBottomIntentTakeoverApplyEffect[];
}>;

export type TranscriptLifecycleHostLocalInteractionPlan = LifecycleHostPlanBase & Readonly<{
    localInteractionIntentEffects: readonly LocalTranscriptInteractionIntentApplyEffect[];
}>;

export type TranscriptLifecycleHostNativeGestureStartPlan = LifecycleHostPlanBase & Readonly<{
    nativeBottomFollowRearmResetEffects: readonly NativeBottomFollowRearmResetEffect[];
    nativeDragActiveMirrorEffects: readonly NativeDragActiveMirrorApplyEffect[];
    nativeMomentumActiveMirrorEffects: readonly NativeMomentumActiveMirrorApplyEffect[];
    nativeTouchIntentEffects: readonly NativeTouchIntentApplyEffect[];
    nativeUserScrollTakeoverEffects: readonly NativeUserScrollTakeoverApplyEffect[];
}>;

export type TranscriptLifecycleHostNativeGestureTakeoverPlan = LifecycleHostPlanBase & Readonly<{
    nativeBottomFollowRearmResetEffects: readonly NativeBottomFollowRearmResetEffect[];
    nativeDragActiveMirrorEffects: readonly NativeDragActiveMirrorApplyEffect[];
    nativeMomentumActiveMirrorEffects: readonly NativeMomentumActiveMirrorApplyEffect[];
    nativeUserScrollTakeoverEffects: readonly NativeUserScrollTakeoverApplyEffect[];
}>;

export type TranscriptLifecycleHostNativeUserScrollTakeoverPlan = LifecycleHostPlanBase & Readonly<{
    nativeUserScrollTakeoverEffects: readonly NativeUserScrollTakeoverApplyEffect[];
}>;

export type TranscriptLifecycleHostNativeTouchIntentPlan = LifecycleHostPlanBase & Readonly<{
    nativeTouchIntentEffects: readonly NativeTouchIntentApplyEffect[];
}>;

export type TranscriptLifecycleHostNativeTouchReleasePlan = LifecycleHostPlanBase & Readonly<{
    nativeBottomFollowRearmResetEffects: readonly NativeBottomFollowRearmResetEffect[];
    nativeTouchReleaseStateEffects: readonly NativeTouchReleaseLiveTailStateEffect[];
}>;

export type TranscriptLifecycleHostScrollObservationPlan = LifecycleHostPlanBase & Readonly<{
    acceptedViewportPaintEffects: readonly NativeScrollAcceptedViewportPaintEffect[];
    disposition: TranscriptLifecycleHostScrollObservationDisposition;
    followIntent: TranscriptBottomFollowIntentResult | null;
    genericEffects: readonly TranscriptViewportLifecycleEffect[];
    nativeBottomFollowCompletionEffects: readonly NativeBottomFollowCompletionEffect[];
    nativePassiveScrollObservationEffect: TranscriptLifecycleHostNativePassiveScrollObservationEffect | null;
    nativeSettledReturnEffects: NativeSettledReturnToLiveTailApplyEffects | null;
    nativeUserScrollTakeoverEffects: readonly NativeUserScrollTakeoverApplyEffect[];
    recentUserIntent: boolean;
    steps: readonly TranscriptLifecycleHostScrollObservationStep[];
}>;

export type TranscriptLifecycleHostNativePassiveScrollObservationEffect = Readonly<{
    consumeAfterBottomCompletion: boolean;
    markInitialViewportApplied: boolean;
    reason: 'observed' | 'skipped';
    sessionId: string;
    type: 'record-native-passive-scroll-observation';
}>;

export type TranscriptLifecycleHost = Readonly<{
    armNativeEntrySettleConfirmation(
        input: TranscriptLifecycleHostNativeEntrySettleConfirmationArmInput,
    ): void;
    armNativeExplicitJumpConfirmation(
        input: TranscriptLifecycleHostNativeExplicitJumpConfirmationArmInput,
    ): void;
    clearNativeExplicitJumpConfirmation(
        input: TranscriptLifecycleHostNativeExplicitJumpConfirmationClearInput,
    ): void;
    enterSession(input: TranscriptLifecycleHostSessionEntryInput): TranscriptLifecycleHostSessionEntryPlan;
    getMountSettleSnapshot(): TranscriptMountSettleSnapshot;
    getState(): TranscriptViewportLifecycleState;
    observeMountSettleMetrics(input: TranscriptMountSettleMetrics): void;
    observeNativeScrollConfirmation(
        input: TranscriptLifecycleHostNativeScrollConfirmationInput,
    ): TranscriptLifecycleHostNativeScrollConfirmationPlan;
    observeScroll(input: TranscriptLifecycleHostScrollObservationInput): TranscriptLifecycleHostScrollObservationPlan;
    planExplicitJumpTakeover(input: Readonly<{
        reason: TranscriptViewportExplicitJumpTakeoverReason;
        sessionId: string;
    }>): TranscriptLifecycleHostExplicitJumpPlan;
    planExplicitReturnToLiveTail(input: TranscriptLifecycleHostExplicitReturnInput): TranscriptLifecycleHostExplicitReturnPlan;
    planFollowBottomIntentTakeover(input: Readonly<{
        sessionId: string;
    }>): TranscriptLifecycleHostFollowBottomIntentPlan;
    planLocalInteractionIntent(input: Readonly<{
        sessionId: string;
        timestampMs: number;
    }>): TranscriptLifecycleHostLocalInteractionPlan;
    planNativeGestureStart(input: Readonly<{
        hasActiveNativeViewportRestore: boolean;
        sessionId: string;
        timestampMs: number;
    }>): TranscriptLifecycleHostNativeGestureStartPlan;
    planNativeGestureTakeover(input: Readonly<{
        sessionId: string;
        timestampMs: number;
    }>): TranscriptLifecycleHostNativeGestureTakeoverPlan;
    planNativeUserScrollTakeover(input: Readonly<{
        sessionId: string;
        timestampMs: number;
    }>): TranscriptLifecycleHostNativeUserScrollTakeoverPlan;
    planNativeTouchIntent(input: Readonly<{
        hasActiveNativeViewportRestore: boolean;
        sessionId: string;
        timestampMs: number;
    }>): TranscriptLifecycleHostNativeTouchIntentPlan;
    planNativeTouchRelease(input: Readonly<{
        distanceFromLiveTailPx: number;
        pinThresholdPx: number;
        sessionId: string;
    }>): TranscriptLifecycleHostNativeTouchReleasePlan;
    recordMountSettleFirstListPaint(input: Readonly<{ sessionId: string; nowMs: number }>): void;
    recordMountSettleLayoutCommitObserved(input: Readonly<{ sessionId: string; nowMs: number }>): void;
    resetNativeEntrySettleConfirmation(
        input: TranscriptLifecycleHostNativeEntrySettleConfirmationResetInput,
    ): void;
    resetMountSettle(input?: Readonly<{ reason?: 'session-change' | 'unmount' }>): void;
    sampleMountSettle(input: Readonly<{ sessionId: string; nowMs: number }>): void;
}>;

export function createTranscriptLifecycleHost(options: Readonly<{
    lifecycle?: TranscriptViewportLifecycle;
    mountSettleTuning?: TranscriptMountSettleTuning;
}> = {}): TranscriptLifecycleHost {
    const lifecycle = options.lifecycle ?? createTranscriptViewportLifecycle();
    const nativeConfirmationOwner = createNativeConfirmationOwner();
    const mountSettle = createTranscriptMountSettlePinCoordinator({
        tuning: options.mountSettleTuning ?? {
            bottomDistanceNoiseFloorPx: 0,
            dimensionNoiseFloorPx: 0,
            quiescentWindowMs: 0,
        },
    });

    const transitionPlan = (transition: TranscriptViewportLifecycleTransition): LifecycleHostPlanBase => ({
        lifecycleEffects: transition.effects,
        state: transition.state,
    });

    const planNativeUserScrollTakeover = (input: Readonly<{
        sessionId: string;
        timestampMs: number;
    }>): TranscriptLifecycleHostNativeUserScrollTakeoverPlan => {
        const userScrollTransition = lifecycle.dispatch({
            sessionId: input.sessionId,
            timestampMs: input.timestampMs,
            type: 'native-user-scroll-takeover',
        });
        return {
            ...transitionPlan(userScrollTransition),
            nativeUserScrollTakeoverEffects: resolveNativeUserScrollTakeoverApplyEffects({
                effects: userScrollTransition.effects,
                sessionId: input.sessionId,
            }),
        };
    };

    const planNativeGestureTakeover = (input: Readonly<{
        sessionId: string;
        timestampMs: number;
    }>): TranscriptLifecycleHostNativeGestureTakeoverPlan => {
        const userScrollPlan = planNativeUserScrollTakeover(input);
        const gestureTransition = lifecycle.dispatch({
            sessionId: input.sessionId,
            type: 'gesture-start',
        });
        const lifecycleEffects = [
            ...userScrollPlan.lifecycleEffects,
            ...gestureTransition.effects,
        ];
        return {
            lifecycleEffects,
            nativeBottomFollowRearmResetEffects: resolveNativeBottomFollowRearmResetEffects({
                effects: lifecycleEffects,
                sessionId: input.sessionId,
            }),
            nativeDragActiveMirrorEffects: resolveNativeDragActiveMirrorApplyEffects({
                effects: lifecycleEffects,
                sessionId: input.sessionId,
            }),
            nativeMomentumActiveMirrorEffects: resolveNativeMomentumActiveMirrorApplyEffects({
                effects: lifecycleEffects,
                sessionId: input.sessionId,
            }),
            nativeUserScrollTakeoverEffects: userScrollPlan.nativeUserScrollTakeoverEffects,
            state: gestureTransition.state,
        };
    };

    const planNativeTouchIntent = (input: Readonly<{
        hasActiveNativeViewportRestore: boolean;
        sessionId: string;
        timestampMs: number;
    }>): TranscriptLifecycleHostNativeTouchIntentPlan => {
        const touchTransition = lifecycle.dispatch({
            hasActiveNativeViewportRestore: input.hasActiveNativeViewportRestore,
            sessionId: input.sessionId,
            timestampMs: input.timestampMs,
            type: 'native-touch-intent',
        });
        return {
            ...transitionPlan(touchTransition),
            nativeTouchIntentEffects: resolveNativeTouchIntentApplyEffects({
                effects: touchTransition.effects,
                sessionId: input.sessionId,
            }),
        };
    };

    const observeNativeScrollFacts = (input: Readonly<{
        distanceFromLiveTailPx: number;
        isTrusted: boolean;
        movedAwayFromLiveTail: boolean;
        movedTowardLiveTail: boolean;
        pinThresholdPx: number;
        recentUserIntent: boolean;
        sessionId: string;
    }>): readonly TranscriptViewportLifecycleEffect[] => resolveNativeScrollFactsObservationEffects({
        dispatch: lifecycle.dispatch,
        distanceFromLiveTailPx: input.distanceFromLiveTailPx,
        isTrusted: input.isTrusted,
        movedAwayFromLiveTail: input.movedAwayFromLiveTail,
        movedTowardLiveTail: input.movedTowardLiveTail,
        pinThresholdPx: input.pinThresholdPx,
        recentUserIntent: input.recentUserIntent,
        sessionId: input.sessionId,
    });

    const observeScroll = (
        input: TranscriptLifecycleHostScrollObservationInput,
    ): TranscriptLifecycleHostScrollObservationPlan => {
        if (input.platform === 'web') {
            return planWebScrollObservation(lifecycle, input);
        }
        return planNativeScrollObservation(
            input,
            observeNativeScrollFacts,
            planNativeUserScrollTakeover,
            lifecycle.getState,
        );
    };

    return {
        armNativeEntrySettleConfirmation(input) {
            nativeConfirmationOwner.armEntrySettle(input);
        },
        armNativeExplicitJumpConfirmation(input) {
            nativeConfirmationOwner.armExplicitJump(input);
        },
        clearNativeExplicitJumpConfirmation(input) {
            nativeConfirmationOwner.clearExplicitJump(input);
        },
        enterSession(input) {
            const sessionEntryEvent = {
                platform: input.platform,
                sessionId: input.sessionId,
                shouldFollowLiveTail: input.shouldFollowLiveTail,
                type: 'session-entry',
                ...(input.entryDistanceFromLiveTailPx !== undefined
                    ? { entryDistanceFromLiveTailPx: input.entryDistanceFromLiveTailPx }
                    : {}),
            } as const;
            const transition = lifecycle.dispatch(sessionEntryEvent);
            return {
                ...transitionPlan(transition),
                renderResetEffects: resolveSessionEntryRenderResetEffects({
                    effects: transition.effects,
                    platform: input.platform,
                    sessionId: input.sessionId,
                }),
                viewportEffects: resolveSessionEntryViewportApplyEffects({
                    effects: transition.effects,
                    sessionId: input.sessionId,
                }),
            };
        },
        getMountSettleSnapshot() {
            return mountSettle.getSnapshot();
        },
        getState() {
            return lifecycle.getState();
        },
        observeMountSettleMetrics(input) {
            mountSettle.observeMetrics(input);
        },
        observeNativeScrollConfirmation(input) {
            return nativeConfirmationOwner.observeScroll(input);
        },
        observeScroll,
        planExplicitJumpTakeover(input) {
            const transition = lifecycle.dispatch({
                reason: input.reason,
                sessionId: input.sessionId,
                type: 'explicit-jump-takeover',
            });
            return {
                ...transitionPlan(transition),
                explicitJumpTakeoverEffects: resolveExplicitJumpTakeoverApplyEffects({
                    effects: transition.effects,
                    sessionId: input.sessionId,
                }),
            };
        },
        planExplicitReturnToLiveTail(input) {
            const transition = lifecycle.dispatch({
                intent: input.intent,
                sessionId: input.sessionId,
                type: 'return-to-live-tail-intent',
            });
            return {
                ...transitionPlan(transition),
                explicitReturnEffects: resolveExplicitReturnToLiveTailApplyEffects({
                    effects: transition.effects,
                    sessionId: input.sessionId,
                }),
                viewportEffects: resolveExplicitReturnToLiveTailViewportEffects({
                    effects: transition.effects,
                    sessionId: input.sessionId,
                }),
            };
        },
        planFollowBottomIntentTakeover(input) {
            const transition = lifecycle.dispatch({
                sessionId: input.sessionId,
                type: 'follow-bottom-intent-takeover',
            });
            return {
                ...transitionPlan(transition),
                followBottomIntentTakeoverEffects: resolveFollowBottomIntentTakeoverApplyEffects({
                    effects: transition.effects,
                    sessionId: input.sessionId,
                }),
            };
        },
        planLocalInteractionIntent(input) {
            const transition = lifecycle.dispatch({
                sessionId: input.sessionId,
                timestampMs: input.timestampMs,
                type: 'local-transcript-interaction-intent',
            });
            return {
                ...transitionPlan(transition),
                localInteractionIntentEffects: resolveLocalTranscriptInteractionIntentApplyEffects({
                    effects: transition.effects,
                    sessionId: input.sessionId,
                }),
            };
        },
        planNativeGestureStart(input) {
            const takeoverPlan = planNativeGestureTakeover(input);
            const touchIntentPlan = planNativeTouchIntent({
                hasActiveNativeViewportRestore: input.hasActiveNativeViewportRestore,
                sessionId: input.sessionId,
                timestampMs: input.timestampMs,
            });
            const lifecycleEffects = [
                ...takeoverPlan.lifecycleEffects,
                ...touchIntentPlan.lifecycleEffects,
            ];
            return {
                lifecycleEffects,
                nativeBottomFollowRearmResetEffects: resolveNativeBottomFollowRearmResetEffects({
                    effects: lifecycleEffects,
                    sessionId: input.sessionId,
                }),
                nativeDragActiveMirrorEffects: resolveNativeDragActiveMirrorApplyEffects({
                    effects: lifecycleEffects,
                    sessionId: input.sessionId,
                }),
                nativeMomentumActiveMirrorEffects: resolveNativeMomentumActiveMirrorApplyEffects({
                    effects: lifecycleEffects,
                    sessionId: input.sessionId,
                }),
                nativeTouchIntentEffects: resolveNativeTouchIntentApplyEffects({
                    effects: lifecycleEffects,
                    sessionId: input.sessionId,
                }),
                nativeUserScrollTakeoverEffects: resolveNativeUserScrollTakeoverApplyEffects({
                    effects: lifecycleEffects,
                    sessionId: input.sessionId,
                }),
                state: touchIntentPlan.state,
            };
        },
        planNativeGestureTakeover,
        planNativeTouchIntent,
        planNativeUserScrollTakeover,
        planNativeTouchRelease(input) {
            const transition = lifecycle.dispatch({
                distanceFromLiveTailPx: input.distanceFromLiveTailPx,
                movement: 'away-from-live-tail',
                pinThresholdPx: input.pinThresholdPx,
                sessionId: input.sessionId,
                source: 'native-touch-escape',
                trustedUserMovement: true,
                type: 'facts-observed',
            });
            return {
                ...transitionPlan(transition),
                nativeBottomFollowRearmResetEffects: resolveNativeBottomFollowRearmResetEffects({
                    effects: transition.effects,
                    sessionId: input.sessionId,
                }),
                nativeTouchReleaseStateEffects: resolveNativeTouchReleaseLiveTailStateEffects({
                    effects: transition.effects,
                    sessionId: input.sessionId,
                }),
            };
        },
        recordMountSettleFirstListPaint(input) {
            mountSettle.recordFirstListPaint(input);
        },
        recordMountSettleLayoutCommitObserved(input) {
            mountSettle.recordLayoutCommitObserved(input);
        },
        resetNativeEntrySettleConfirmation(input) {
            nativeConfirmationOwner.resetEntrySettle(input);
        },
        resetMountSettle(input) {
            mountSettle.reset(input);
        },
        sampleMountSettle(input) {
            mountSettle.sample(input);
        },
    };
}

type NativeScrollFactsObserver = (input: Readonly<{
    distanceFromLiveTailPx: number;
    isTrusted: boolean;
    movedAwayFromLiveTail: boolean;
    movedTowardLiveTail: boolean;
    pinThresholdPx: number;
    recentUserIntent: boolean;
    sessionId: string;
}>) => readonly TranscriptViewportLifecycleEffect[];

type NativeUserScrollTakeoverPlanner = (input: Readonly<{
    sessionId: string;
    timestampMs: number;
}>) => TranscriptLifecycleHostNativeUserScrollTakeoverPlan;

type NativePassiveScrollObservationPlan = Readonly<{
    anchorCaptureCancellationEffects: readonly TranscriptViewportLifecycleEffect[];
    effect: TranscriptLifecycleHostNativePassiveScrollObservationEffect;
    nativeUserScrollTakeoverEffects: readonly NativeUserScrollTakeoverApplyEffect[];
    recentUserIntent: boolean;
    shouldRecordPassiveUnpinnedMovement: boolean;
    suppressAnchorCapture: boolean;
}>;

function createScrollObservationPlan(params: Readonly<{
    acceptedViewportPaintEffects?: readonly NativeScrollAcceptedViewportPaintEffect[];
    disposition: TranscriptLifecycleHostScrollObservationDisposition;
    followIntent?: TranscriptBottomFollowIntentResult | null;
    genericEffects?: readonly TranscriptViewportLifecycleEffect[];
    lifecycleEffects?: readonly TranscriptViewportLifecycleEffect[];
    nativeBottomFollowCompletionEffects?: readonly NativeBottomFollowCompletionEffect[];
    nativePassiveScrollObservationEffect?: TranscriptLifecycleHostNativePassiveScrollObservationEffect | null;
    nativeSettledReturnEffects?: NativeSettledReturnToLiveTailApplyEffects | null;
    nativeUserScrollTakeoverEffects?: readonly NativeUserScrollTakeoverApplyEffect[];
    recentUserIntent?: boolean;
    state: TranscriptViewportLifecycleState;
    steps?: readonly TranscriptLifecycleHostScrollObservationStep[];
}>): TranscriptLifecycleHostScrollObservationPlan {
    return {
        acceptedViewportPaintEffects: params.acceptedViewportPaintEffects ?? [],
        disposition: params.disposition,
        followIntent: params.followIntent ?? null,
        genericEffects: params.genericEffects ?? [],
        lifecycleEffects: params.lifecycleEffects ?? [],
        nativeBottomFollowCompletionEffects: params.nativeBottomFollowCompletionEffects ?? [],
        nativePassiveScrollObservationEffect: params.nativePassiveScrollObservationEffect ?? null,
        nativeSettledReturnEffects: params.nativeSettledReturnEffects ?? null,
        nativeUserScrollTakeoverEffects: params.nativeUserScrollTakeoverEffects ?? [],
        recentUserIntent: params.recentUserIntent ?? false,
        state: params.state,
        steps: params.steps ?? [],
    };
}

function planWebScrollObservation(
    lifecycle: TranscriptViewportLifecycle,
    input: TranscriptLifecycleHostWebScrollObservationInput,
): TranscriptLifecycleHostScrollObservationPlan {
    if (!input.webObservedUserScrollMovement) {
        if (input.hasLiveWebMetrics === false) {
            const fallbackEffects = resolveActiveWebScrollFallbackObservationEffects({
                distanceFromLiveTailPx: input.distanceFromLiveTailPx,
                hasLiveWebMetrics: false,
                isWeb: true,
                pinEnabled: input.pinEnabled,
                pinThresholdPx: input.pinThresholdPx,
                previousScrollOffset: input.previousScrollOffsetPx,
                recentUserIntent: input.recentUserIntent ?? false,
                scrollOffset: input.scrollOffsetPx,
                sessionId: input.sessionId,
                wantsPinned: input.wantsPinned,
            });
            if (fallbackEffects.length > 0) {
                return createScrollObservationPlan({
                    disposition: 'continue',
                    genericEffects: fallbackEffects,
                    state: lifecycle.getState(),
                    steps: [{
                        genericEffects: fallbackEffects,
                        type: 'web-fallback',
                    }],
                });
            }
        }
        return createScrollObservationPlan({
            disposition: 'ignored',
            state: lifecycle.getState(),
        });
    }

    const timestampTransition = lifecycle.dispatch({
        sessionId: input.sessionId,
        timestampMs: input.nowMs,
        type: 'web-user-scroll-intent-timestamp',
    });
    const takeoverEffects = input.movedAwayFromLiveTail
        ? resolveWebUserScrollTakeoverApplyEffects({
            effects: lifecycle.dispatch({
                sessionId: input.sessionId,
                type: 'web-user-scroll-takeover',
            }).effects,
            sessionId: input.sessionId,
        })
        : [];
    const webUserScrollEffects = [
        ...takeoverEffects,
        ...resolveWebUserScrollIntentTimestampApplyEffects({
            effects: timestampTransition.effects,
            sessionId: input.sessionId,
        }),
    ];
    const factsEffects = resolveWebScrollFactsObservationEffects({
        dispatch: lifecycle.dispatch,
        distanceFromLiveTailPx: input.distanceFromLiveTailPx,
        movedAwayFromLiveTail: input.movedAwayFromLiveTail,
        movedTowardLiveTail: input.movedTowardLiveTail,
        pinThresholdPx: input.pinThresholdPx,
        sessionId: input.sessionId,
        webObservedUserScrollMovement: true,
    });
    const genericEffects = resolveWebScrollObservationGenericLifecycleEffects({
        effects: factsEffects,
        nextScrollOffsetPx: input.scrollOffsetPx,
        pinEnabled: input.pinEnabled,
        pinnedOffsetThresholdPx: input.pinThresholdPx,
        sessionId: input.sessionId,
    });
    const lifecycleEffects = [
        ...webUserScrollEffects,
        ...factsEffects,
    ];
    const steps: TranscriptLifecycleHostScrollObservationStep[] = [
        {
            lifecycleEffects: webUserScrollEffects,
            type: 'web-user-scroll',
        },
        {
            lifecycleEffects: factsEffects,
            type: 'web-scroll-facts',
        },
    ];
    if (genericEffects.length > 0) {
        steps.push({
            genericEffects,
            type: 'web-generic-observation',
        });
    }

    return createScrollObservationPlan({
        disposition: 'continue',
        genericEffects,
        lifecycleEffects,
        state: lifecycle.getState(),
        steps,
    });
}

function resolveNativePassiveScrollObservationPlan(
    input: TranscriptLifecycleHostNativeScrollObservationInput,
    planNativeUserScrollTakeover: NativeUserScrollTakeoverPlanner,
): NativePassiveScrollObservationPlan {
    const shouldRecordPassiveUnpinnedMovement = shouldRecordNativePassiveUnpinnedMovement({
        configuredBottomDistanceNoiseFloorPx: input.configuredBottomDistanceNoiseFloorPx,
        distanceFromBottom: input.distanceFromLiveTailPx,
        hasNativeContentMeasurement: input.hasNativeContentMeasurement,
        hasNativeInitialViewportApplied: input.hasNativeInitialViewportApplied,
        isWeb: false,
        pinThresholdPx: input.pinThresholdPx,
        wantsPinned: input.wantsPinned,
    });
    const shouldIgnorePassiveScroll = shouldIgnoreNativePassiveViewportScroll({
        configuredBottomDistanceNoiseFloorPx: input.configuredBottomDistanceNoiseFloorPx,
        currentSessionId: input.sessionId,
        distanceFromBottom: input.distanceFromLiveTailPx,
        entryViewportSessionId: input.sessionEntrySessionId ?? null,
        entryViewportShouldFollowBottom: input.sessionEntryShouldFollowBottom ?? null,
        hasNativeContentMeasurement: input.hasNativeContentMeasurement,
        hasNativeInitialViewportApplied: input.hasNativeInitialViewportApplied,
        isTrusted: input.isTrusted,
        isWeb: false,
        lastUserScrollIntentAtMs: input.lastUserScrollIntentAtMs,
        nowMs: input.nowMs,
        pinThresholdPx: input.pinThresholdPx,
        shouldRecordPassiveUnpinnedMovement,
        userIntentRecentMs: input.userIntentRecentMs,
        wantsPinned: input.wantsPinned,
    });
    const shouldRecordPassiveIntent =
        !input.entryRestoreConfirmedByObservation &&
        !input.isTrusted &&
        shouldRecordPassiveUnpinnedMovement;
    const shouldRefreshRecentPassiveIntent =
        !input.entryRestoreConfirmedByObservation &&
        !input.isTrusted &&
        !shouldIgnorePassiveScroll &&
        !shouldRecordPassiveIntent &&
        input.nowMs - input.lastUserScrollIntentAtMs < input.userIntentRecentMs;
    const shouldRecordNativeIntent =
        input.isTrusted ||
        shouldRecordPassiveIntent ||
        shouldRefreshRecentPassiveIntent;
    const nativeUserScrollTakeoverEffects = shouldRecordNativeIntent
        ? planNativeUserScrollTakeover({
            sessionId: input.sessionId,
            timestampMs: input.nowMs,
        }).nativeUserScrollTakeoverEffects
        : [];
    const shouldSuppressUntrustedUnpinnedAnchorCapture =
        !input.isTrusted &&
        !input.wantsPinned;
    const suppressAnchorCapture = resolveNativeScrollObservationAnchorCaptureSuppression({
        nativeMomentumScrollActive: input.nativeMomentumScrollActive,
        shouldSuppressNativeAnchorCapture:
            shouldRecordPassiveIntent ||
            shouldSuppressUntrustedUnpinnedAnchorCapture,
        trustedDragSessionActive: input.hasTrustedDragSession,
    });
    const anchorCaptureCancellationEffects =
        suppressAnchorCapture &&
        shouldSuppressUntrustedUnpinnedAnchorCapture
            ? resolveGenericScrollObservationAnchorCaptureCancellationEffects({
                reason: 'native-passive-untrusted',
                sessionId: input.sessionId,
            })
            : [];

    return {
        anchorCaptureCancellationEffects,
        effect: {
            consumeAfterBottomCompletion: shouldIgnorePassiveScroll,
            markInitialViewportApplied: input.isTrusted,
            reason: shouldIgnorePassiveScroll ? 'skipped' : 'observed',
            sessionId: input.sessionId,
            type: 'record-native-passive-scroll-observation',
        },
        nativeUserScrollTakeoverEffects,
        recentUserIntent: input.recentUserIntent || shouldRecordNativeIntent,
        shouldRecordPassiveUnpinnedMovement,
        suppressAnchorCapture,
    };
}

function planNativeScrollObservation(
    input: TranscriptLifecycleHostNativeScrollObservationInput,
    observeNativeScrollFacts: NativeScrollFactsObserver,
    planNativeUserScrollTakeover: NativeUserScrollTakeoverPlanner,
    getState: () => TranscriptViewportLifecycleState,
): TranscriptLifecycleHostScrollObservationPlan {
    const lifecycleEffects: TranscriptViewportLifecycleEffect[] = [];
    const genericEffects: TranscriptViewportLifecycleEffect[] = [];
    const steps: TranscriptLifecycleHostScrollObservationStep[] = [];
    const passiveObservation = resolveNativePassiveScrollObservationPlan(input, planNativeUserScrollTakeover);
    const nativeBottomFollowCompletionEffects = resolveNativeBottomFollowCompletionEffects({
        contentHeight: input.contentHeightPx,
        distanceFromBottom: input.distanceFromLiveTailForReleasePx,
        isNative: true,
        pinThresholdPx: input.pinThresholdPx,
        sessionId: input.sessionId,
        wantsPinned: input.wantsPinned,
    });
    const createNativeScrollObservationPlan = (
        params: Parameters<typeof createScrollObservationPlan>[0],
    ): TranscriptLifecycleHostScrollObservationPlan => createScrollObservationPlan({
        ...params,
        nativeBottomFollowCompletionEffects,
        nativePassiveScrollObservationEffect: passiveObservation.effect,
        nativeUserScrollTakeoverEffects: passiveObservation.nativeUserScrollTakeoverEffects,
        recentUserIntent: passiveObservation.recentUserIntent,
    });
    lifecycleEffects.push(...passiveObservation.nativeUserScrollTakeoverEffects);
    steps.push({
        effect: passiveObservation.effect,
        nativeUserScrollTakeoverEffects: passiveObservation.nativeUserScrollTakeoverEffects,
        type: 'native-passive-observation',
    });
    if (passiveObservation.effect.consumeAfterBottomCompletion) {
        return createNativeScrollObservationPlan({
            disposition: 'continue',
            lifecycleEffects,
            state: getState(),
            steps,
        });
    }

    const awayGestureBailDecision = resolveNativeScrollAwayGestureLiveTailBailDecision({
        distanceFromLiveTailPx: input.distanceFromLiveTailPx,
        hasOpenTrustedAwayGesture: input.hasOpenTrustedAwayGesture,
        isNative: true,
        isTrusted: input.isTrusted,
        pinThresholdPx: input.pinThresholdPx,
    });
    const awayGestureBailEffects = resolveNativeScrollAwayGestureLiveTailBailEffects({
        decision: awayGestureBailDecision,
        distanceFromLiveTailPx: input.distanceFromLiveTailPx,
        isTrusted: input.isTrusted,
        movedAwayFromLiveTail: input.movedAwayFromLiveTail,
        movedTowardLiveTail: input.movedTowardLiveTail,
        nativeListDragActive: input.nativeListDragActive,
        recentUserIntent: passiveObservation.recentUserIntent,
        sessionId: input.sessionId,
    });
    const requestedNativeFacts = awayGestureBailEffects.find((
        effect,
    ): effect is Extract<NativeScrollAwayGestureLiveTailBailEffect, { type: 'observe-native-scroll-facts' }> => (
        effect.type === 'observe-native-scroll-facts'
    ));
    if (requestedNativeFacts) {
        const factsEffects = observeNativeScrollFacts({
            distanceFromLiveTailPx: requestedNativeFacts.distanceFromLiveTailPx,
            isTrusted: requestedNativeFacts.isTrusted,
            movedAwayFromLiveTail: requestedNativeFacts.movedAwayFromLiveTail,
            movedTowardLiveTail: requestedNativeFacts.movedTowardLiveTail,
            pinThresholdPx: input.pinThresholdPx,
            recentUserIntent: passiveObservation.recentUserIntent || requestedNativeFacts.recentUserIntent,
            sessionId: requestedNativeFacts.sessionId,
        });
        lifecycleEffects.push(...factsEffects);
        steps.push({
            lifecycleEffects: factsEffects,
            type: 'native-scroll-facts',
        });
    }
    if (awayGestureBailEffects.length > 0) {
        steps.push({
            bailEffects: awayGestureBailEffects,
            type: 'native-away-gesture-live-tail-bail',
        });
    }
    if (awayGestureBailEffects.some((effect) => effect.type === 'consume-observation')) {
        steps.push({
            reason: 'native-away-gesture-live-tail-bail',
            type: 'consume-observation',
        });
        return createNativeScrollObservationPlan({
            disposition: 'consumed',
            lifecycleEffects,
            nativePassiveScrollObservationEffect: passiveObservation.effect,
            nativeUserScrollTakeoverEffects: passiveObservation.nativeUserScrollTakeoverEffects,
            recentUserIntent: passiveObservation.recentUserIntent,
            state: getState(),
            steps,
        });
    }

    const followIntent = resolveNativeScrollFollowIntent({
        distanceFromLiveTailForReleasePx: input.distanceFromLiveTailForReleasePx,
        distanceFromLiveTailPx: input.distanceFromLiveTailPx,
        hasOpenTrustedAwayGesture: input.hasOpenTrustedAwayGesture,
        hasTrustedDragSession: input.hasTrustedDragSession,
        isTrusted: input.isTrusted,
        movedTowardLiveTail: input.movedTowardLiveTail,
        nativeMomentumScrollActive: input.nativeMomentumScrollActive,
        pinThresholdPx: input.pinThresholdPx,
        previousScrollOffset: input.previousScrollOffsetPx,
        scrollOffset: input.scrollOffsetPx,
        wantsPinned: input.wantsPinned,
    });
    steps.push({
        followIntent,
        type: 'native-follow-intent',
    });

    const nativeFactsEffects = observeNativeScrollFacts({
        distanceFromLiveTailPx: followIntent.nextDistanceFromBottom,
        isTrusted: input.isTrusted,
        movedAwayFromLiveTail: input.movedAwayFromLiveTail,
        movedTowardLiveTail: input.movedTowardLiveTail,
        pinThresholdPx: input.pinThresholdPx,
        recentUserIntent: passiveObservation.recentUserIntent,
        sessionId: input.sessionId,
    });
    if (nativeFactsEffects.length > 0) {
        lifecycleEffects.push(...nativeFactsEffects);
        steps.push({
            lifecycleEffects: nativeFactsEffects,
            type: 'native-scroll-facts',
        });
    }

    const acceptedViewportPaintEffects = resolveNativeScrollAcceptedViewportPaintObservationEffects({
        distanceFromLiveTailPx: input.distanceFromLiveTailForReleasePx,
        entryRestoreConfirmedByObservation: input.entryRestoreConfirmedByObservation,
        fallbackMetrics: {
            contentHeight: input.contentHeightPx,
            distanceFromLiveTailPx: input.distanceFromLiveTailForReleasePx,
            layoutHeight: input.layoutHeightPx,
        },
        hasRenderedItems: input.hasRenderedItems,
        isLoaded: input.isLoaded,
        isNative: true,
        isTrusted: input.isTrusted,
        isWarmKeepAliveInstance: input.isWarmKeepAliveInstance,
        nativeMountSettleDeadlineReached: input.nativeMountSettleDeadlineReached,
        nativeMountSettleStable: input.nativeMountSettleStable,
        sessionEntryShouldFollowBottom: input.sessionEntryShouldFollowBottom,
        sessionId: input.sessionId,
        thresholdPx: followIntent.effectivePinnedOffsetThresholdPx,
        wantsPinned: input.wantsPinned,
    });
    const nativeSettledReturnEffects = resolveNativeSettledReturnToLiveTailApplyEffects({
        effects: nativeFactsEffects,
        sessionId: input.sessionId,
    });
    if (nativeSettledReturnEffects.returnEffects.length > 0) {
        steps.push({
            acceptedViewportPaintEffects,
            type: 'native-accepted-viewport-paint',
        });
        steps.push({
            acceptedViewportPaintEffects,
            nativeSettledReturnEffects,
            type: 'native-settled-return',
        });
        return createNativeScrollObservationPlan({
            acceptedViewportPaintEffects,
            disposition: 'continue',
            followIntent,
            lifecycleEffects,
            nativeSettledReturnEffects,
            state: getState(),
            steps,
        });
    }
    const releaseGenericEffects = resolveNativeScrollReleaseLiveTailGenericLifecycleEffects({
        effects: nativeFactsEffects,
        nextScrollOffsetPx: followIntent.nextScrollOffset,
        pinEnabled: input.pinEnabled,
        sessionId: input.sessionId,
    });
    if (releaseGenericEffects.length > 0) {
        genericEffects.push(...releaseGenericEffects);
        genericEffects.push(...passiveObservation.anchorCaptureCancellationEffects);
        steps.push({
            acceptedViewportPaintEffects,
            type: 'native-accepted-viewport-paint',
        });
        steps.push({
            acceptedViewportPaintEffects,
            genericEffects: releaseGenericEffects,
            lifecycleEffects: nativeFactsEffects,
            type: 'native-return-or-release',
        });
        return createNativeScrollObservationPlan({
            acceptedViewportPaintEffects,
            disposition: 'continue',
            followIntent,
            genericEffects,
            lifecycleEffects,
            state: getState(),
            steps,
        });
    }

    const observedGenericEffects = resolveNativeObservedViewportStateGenericLifecycleEffects({
        effects: nativeFactsEffects,
        nextScrollOffsetPx: followIntent.nextScrollOffset,
        pinEnabled: input.pinEnabled,
        sessionId: input.sessionId,
        suppressAnchorCapture: passiveObservation.suppressAnchorCapture,
    });
    if (observedGenericEffects.length > 0) {
        genericEffects.push(...observedGenericEffects);
        genericEffects.push(...passiveObservation.anchorCaptureCancellationEffects);
        steps.push({
            acceptedViewportPaintEffects,
            type: 'native-accepted-viewport-paint',
        });
        steps.push({
            acceptedViewportPaintEffects,
            genericEffects: observedGenericEffects,
            lifecycleEffects: nativeFactsEffects,
            type: 'native-observed-viewport-state',
        });
        return createNativeScrollObservationPlan({
            acceptedViewportPaintEffects,
            disposition: 'continue',
            followIntent,
            genericEffects,
            lifecycleEffects,
            state: getState(),
            steps,
        });
    }

    const readOnlyVisibleBottomDecision = resolveNativeScrollReadOnlyVisibleBottomDecision({
        bottomFollowMode: input.bottomFollowMode,
        distanceFromLiveTailPx: followIntent.nextDistanceFromBottom,
        followIntentIsPinned: followIntent.isPinned,
        followIntentWantsPinned: followIntent.wantsPinned,
        isNative: true,
        isTrusted: input.isTrusted,
        pinnedOffsetThresholdPx: followIntent.effectivePinnedOffsetThresholdPx,
    });
    const readOnlyVisibleBottomEffects = resolveNativeScrollReadOnlyVisibleBottomGenericEffects(
        readOnlyVisibleBottomDecision,
        {
            pinEnabled: input.pinEnabled,
            sessionId: input.sessionId,
        },
    );
    if (readOnlyVisibleBottomEffects.length > 0) {
        genericEffects.push(...readOnlyVisibleBottomEffects);
        steps.push({
            genericEffects: readOnlyVisibleBottomEffects,
            type: 'native-read-only-visible-bottom',
        });
        return createNativeScrollObservationPlan({
            disposition: 'consumed',
            followIntent,
            genericEffects,
            lifecycleEffects,
            state: getState(),
            steps,
        });
    }

    const passiveDriftDecision = resolveNativeScrollPassiveDriftBailDecision({
        bottomFollowMode: input.bottomFollowMode,
        followIntentIsPinned: followIntent.isPinned,
        followIntentWantsPinned: followIntent.wantsPinned,
        isNative: true,
        isTrusted: input.isTrusted,
    });
    const passiveDriftEffects = resolveNativeScrollPassiveDriftBailGenericEffects({
        decision: passiveDriftDecision,
        sessionId: input.sessionId,
    });
    if (passiveDriftEffects.length > 0) {
        genericEffects.push(...passiveDriftEffects);
        steps.push({
            genericEffects: passiveDriftEffects,
            type: 'native-passive-drift-bail',
        });
        return createNativeScrollObservationPlan({
            disposition: 'consumed',
            followIntent,
            genericEffects,
            lifecycleEffects,
            state: getState(),
            steps,
        });
    }

    const fallbackEffects = resolveGenericScrollObservationViewportStateEffects({
        followIntentIsPinned: followIntent.isPinned,
        followIntentNextDistanceFromLiveTailPx: followIntent.nextDistanceFromBottom,
        followIntentNextScrollOffsetPx: followIntent.nextScrollOffset,
        followIntentWantsPinned: followIntent.wantsPinned,
        pinEnabled: input.pinEnabled,
        pinnedOffsetThresholdPx: followIntent.effectivePinnedOffsetThresholdPx,
        sessionId: input.sessionId,
        suppressAnchorCapture: passiveObservation.suppressAnchorCapture,
        viewportDistanceFromLiveTailPx: input.distanceFromLiveTailPx,
    });
    genericEffects.push(...fallbackEffects);
    genericEffects.push(...passiveObservation.anchorCaptureCancellationEffects);
    steps.push({
        acceptedViewportPaintEffects,
        type: 'native-accepted-viewport-paint',
    });
    steps.push({
        acceptedViewportPaintEffects,
        genericEffects: fallbackEffects,
        type: 'generic-fallback',
    });

    return createNativeScrollObservationPlan({
        acceptedViewportPaintEffects,
        disposition: 'continue',
        followIntent,
        genericEffects,
        lifecycleEffects,
        state: getState(),
        steps,
    });
}

import type { TranscriptBottomFollowMode } from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import type { TranscriptBottomFollowIntentResult } from '@/components/sessions/transcript/scroll/resolveTranscriptBottomFollowIntent';
import {
    resolveNativeBottomFollowCompletionEffects,
    type NativeBottomFollowCompletionEffect,
} from '@/components/sessions/transcript/viewport/nativeBottomFollowObservationPolicy';

import {
    shouldIgnoreNativePassiveViewportScroll,
    shouldRecordNativePassiveUnpinnedMovement,
} from '../nativePassiveScrollPolicy';
import {
    createTranscriptViewportLifecycle,
    type TranscriptViewportLifecycle,
    type TranscriptViewportLifecycleEffect,
    type TranscriptViewportLifecycleEvent,
    type TranscriptViewportLifecycleState,
    type TranscriptViewportLifecycleTransition,
} from './lifecycle';
import {
    resolveGenericScrollObservationAnchorCaptureCancellationEffects,
    resolveGenericScrollObservationViewportStateEffects,
} from './genericScrollObservationViewportState';
import { resolveNativeObservedViewportStateGenericLifecycleEffects } from './nativeObservedViewportStateGenericEffect';
import {
    resolveNativeScrollAcceptedViewportPaintObservationEffects,
    type NativeScrollAcceptedViewportPaintEffect,
} from './nativeScrollAcceptedViewportPaint';
import { resolveNativeScrollObservationAnchorCaptureSuppression } from './nativeScrollAnchorCaptureSuppression';
import {
    resolveNativeScrollAwayGestureLiveTailBailDecision,
    resolveNativeScrollAwayGestureLiveTailBailEffects,
    type NativeScrollAwayGestureLiveTailBailEffect,
} from './nativeScrollAwayGestureLiveTailBail';
import { resolveNativeScrollFactsObservationEffects } from './nativeScrollFactsObservation';
import { resolveNativeScrollFollowIntent } from './nativeScrollFollowIntent';
import {
    resolveNativeScrollPassiveDriftBailDecision,
    resolveNativeScrollPassiveDriftBailGenericEffects,
} from './nativeScrollPassiveDriftBail';
import {
    resolveNativeScrollReadOnlyVisibleBottomDecision,
    resolveNativeScrollReadOnlyVisibleBottomGenericEffects,
} from './nativeScrollReadOnlyVisibleBottom';
import { resolveNativeScrollReleaseLiveTailGenericLifecycleEffects } from './nativeScrollReleaseLiveTailGenericEffect';
import {
    resolveNativeSettledReturnToLiveTailApplyEffects,
    type NativeSettledReturnToLiveTailApplyEffects,
} from './nativeReturnToLiveTail';
import {
    resolveNativeUserScrollTakeoverApplyEffects,
    type NativeUserScrollTakeoverApplyEffect,
} from './nativeUserScrollTakeover';
import { resolveActiveWebScrollFallbackObservationEffects } from './webScrollFallbackFollowIntent';
import { resolveWebScrollFactsObservationEffects } from './webScrollFactsObservation';
import { resolveWebScrollObservationGenericLifecycleEffects } from './webScrollObservationGenericEffect';
import {
    resolveWebUserScrollIntentTimestampApplyEffects,
    resolveWebUserScrollTakeoverApplyEffects,
} from './webUserScrollIntent';

export type TranscriptScrollObservationHostSessionEntryInput = Readonly<{
    entryDistanceFromLiveTailPx?: number | null;
    platform: 'native' | 'web';
    sessionId: string;
    shouldFollowLiveTail: boolean;
}>;

type TranscriptScrollObservationHostCommonInput = Readonly<{
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

export type TranscriptScrollObservationHostWebInput =
    TranscriptScrollObservationHostCommonInput & Readonly<{
        hasLiveWebMetrics?: boolean;
        platform: 'web';
        recentUserIntent?: boolean;
        webLiveTailCorrectionActive?: boolean;
        webMovedSinceLastObservation?: boolean | null;
        webObservedUserScrollMovement: boolean;
    }>;

export type TranscriptScrollObservationHostNativeInput =
    TranscriptScrollObservationHostCommonInput & Readonly<{
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
        lastNativePinOffset: number | null | undefined;
        lastUserScrollIntentAtMs: number;
        layoutHeightPx: number;
        nativeListDragActive: boolean;
        nativeMomentumScrollActive: boolean;
        nativeMountSettleDeadlineReached: boolean;
        nativeMountSettleStable: boolean;
        pendingBottomPin: boolean;
        platform: 'native';
        recentUserIntent: boolean;
        sessionEntrySessionId: string | null | undefined;
        sessionEntryShouldFollowBottom: boolean | null | undefined;
        userIntentRecentMs: number;
        usesNativeFlashListBottomMaintenance: boolean;
        visualBottomScrollOffset: number | null | undefined;
    }>;

export type TranscriptScrollObservationHostInput =
    | TranscriptScrollObservationHostNativeInput
    | TranscriptScrollObservationHostWebInput;

export type TranscriptScrollObservationHostDisposition =
    | 'consumed'
    | 'continue'
    | 'ignored';

export type TranscriptScrollObservationHostNativePassiveEffect = Readonly<{
    consumeAfterBottomCompletion: boolean;
    markInitialViewportApplied: boolean;
    reason: 'observed' | 'skipped';
    sessionId: string;
    type: 'record-native-passive-scroll-observation';
}>;

export type TranscriptScrollObservationHostWebPassiveLiveTailCorrectionEffect = Readonly<{
    reason: 'passive-drift';
    sessionId: string;
    type: 'apply-web-passive-live-tail-correction';
}>;

export type TranscriptScrollObservationHostStep =
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
        effect: TranscriptScrollObservationHostWebPassiveLiveTailCorrectionEffect;
        type: 'web-passive-live-tail-correction';
    }>
    | Readonly<{
        effect: TranscriptScrollObservationHostNativePassiveEffect;
        nativeUserScrollTakeoverEffects: readonly NativeUserScrollTakeoverApplyEffect[];
        type: 'native-passive-observation';
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
        followIntent: TranscriptBottomFollowIntentResult;
        type: 'native-follow-intent';
    }>
    | Readonly<{
        lifecycleEffects: readonly TranscriptViewportLifecycleEffect[];
        type: 'native-scroll-facts';
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
    }>;

export type TranscriptScrollObservationHostPlan = Readonly<{
    acceptedViewportPaintEffects: readonly NativeScrollAcceptedViewportPaintEffect[];
    disposition: TranscriptScrollObservationHostDisposition;
    followIntent: TranscriptBottomFollowIntentResult | null;
    genericEffects: readonly TranscriptViewportLifecycleEffect[];
    lifecycleEffects: readonly TranscriptViewportLifecycleEffect[];
    nativeBottomFollowCompletionEffects: readonly NativeBottomFollowCompletionEffect[];
    nativePassiveScrollObservationEffect: TranscriptScrollObservationHostNativePassiveEffect | null;
    nativeSettledReturnEffects: NativeSettledReturnToLiveTailApplyEffects | null;
    nativeUserScrollTakeoverEffects: readonly NativeUserScrollTakeoverApplyEffect[];
    recentUserIntent: boolean;
    state: TranscriptViewportLifecycleState;
    steps: readonly TranscriptScrollObservationHostStep[];
    webPassiveLiveTailCorrectionEffect: TranscriptScrollObservationHostWebPassiveLiveTailCorrectionEffect | null;
}>;

export type TranscriptScrollObservationHost = Readonly<{
    dispatch(event: TranscriptViewportLifecycleEvent): TranscriptViewportLifecycleTransition;
    enterSession(input: TranscriptScrollObservationHostSessionEntryInput): TranscriptViewportLifecycleTransition;
    getState(): TranscriptViewportLifecycleState;
    observeScroll(input: TranscriptScrollObservationHostInput): TranscriptScrollObservationHostPlan;
}>;

type NativePassiveScrollObservationPlan = Readonly<{
    anchorCaptureCancellationEffects: readonly TranscriptViewportLifecycleEffect[];
    effect: TranscriptScrollObservationHostNativePassiveEffect;
    nativeUserScrollTakeoverEffects: readonly NativeUserScrollTakeoverApplyEffect[];
    recentUserIntent: boolean;
    shouldRecordPassiveUnpinnedMovement: boolean;
    suppressAnchorCapture: boolean;
}>;

type NativeUserScrollTakeoverPlanner = (input: Readonly<{
    sessionId: string;
    timestampMs: number;
}>) => readonly NativeUserScrollTakeoverApplyEffect[];

type NativeScrollFactsObserver = (input: Readonly<{
    distanceFromLiveTailPx: number;
    isTrusted: boolean;
    movedAwayFromLiveTail: boolean;
    movedTowardLiveTail: boolean;
    pinThresholdPx: number;
    recentUserIntent: boolean;
    sessionId: string;
}>) => readonly TranscriptViewportLifecycleEffect[];

function createScrollObservationPlan(params: Readonly<{
    acceptedViewportPaintEffects?: readonly NativeScrollAcceptedViewportPaintEffect[];
    disposition: TranscriptScrollObservationHostDisposition;
    followIntent?: TranscriptBottomFollowIntentResult | null;
    genericEffects?: readonly TranscriptViewportLifecycleEffect[];
    lifecycleEffects?: readonly TranscriptViewportLifecycleEffect[];
    nativeBottomFollowCompletionEffects?: readonly NativeBottomFollowCompletionEffect[];
    nativePassiveScrollObservationEffect?: TranscriptScrollObservationHostNativePassiveEffect | null;
    nativeSettledReturnEffects?: NativeSettledReturnToLiveTailApplyEffects | null;
    nativeUserScrollTakeoverEffects?: readonly NativeUserScrollTakeoverApplyEffect[];
    recentUserIntent?: boolean;
    state: TranscriptViewportLifecycleState;
    steps?: readonly TranscriptScrollObservationHostStep[];
    webPassiveLiveTailCorrectionEffect?: TranscriptScrollObservationHostWebPassiveLiveTailCorrectionEffect | null;
}>): TranscriptScrollObservationHostPlan {
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
        webPassiveLiveTailCorrectionEffect: params.webPassiveLiveTailCorrectionEffect ?? null,
    };
}

export function createTranscriptScrollObservationHost(options: Readonly<{
    lifecycle?: TranscriptViewportLifecycle;
}> = {}): TranscriptScrollObservationHost {
    const lifecycle = options.lifecycle ?? createTranscriptViewportLifecycle();

    const planNativeUserScrollTakeover: NativeUserScrollTakeoverPlanner = (input) => {
        const transition = lifecycle.dispatch({
            sessionId: input.sessionId,
            timestampMs: input.timestampMs,
            type: 'native-user-scroll-takeover',
        });
        return resolveNativeUserScrollTakeoverApplyEffects({
            effects: transition.effects,
            sessionId: input.sessionId,
        });
    };

    const observeNativeScrollFacts: NativeScrollFactsObserver = (input) =>
        resolveNativeScrollFactsObservationEffects({
            dispatch: lifecycle.dispatch,
            distanceFromLiveTailPx: input.distanceFromLiveTailPx,
            isTrusted: input.isTrusted,
            movedAwayFromLiveTail: input.movedAwayFromLiveTail,
            movedTowardLiveTail: input.movedTowardLiveTail,
            pinThresholdPx: input.pinThresholdPx,
            recentUserIntent: input.recentUserIntent,
            sessionId: input.sessionId,
        });

    return {
        dispatch(event) {
            return lifecycle.dispatch(event);
        },
        enterSession(input) {
            return lifecycle.dispatch({
                platform: input.platform,
                sessionId: input.sessionId,
                shouldFollowLiveTail: input.shouldFollowLiveTail,
                type: 'session-entry',
                ...(input.entryDistanceFromLiveTailPx !== undefined
                    ? { entryDistanceFromLiveTailPx: input.entryDistanceFromLiveTailPx }
                    : {}),
            });
        },
        getState() {
            return lifecycle.getState();
        },
        observeScroll(input) {
            if (input.platform === 'web') {
                return planWebScrollObservation(lifecycle, input);
            }
            return planNativeScrollObservation(
                input,
                observeNativeScrollFacts,
                planNativeUserScrollTakeover,
                lifecycle.getState,
            );
        },
    };
}

function planWebScrollObservation(
    lifecycle: TranscriptViewportLifecycle,
    input: TranscriptScrollObservationHostWebInput,
): TranscriptScrollObservationHostPlan {
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
        const correctionEffect = resolveWebPassiveLiveTailCorrectionEffect(input);
        if (correctionEffect) {
            return createScrollObservationPlan({
                disposition: 'consumed',
                state: lifecycle.getState(),
                steps: [{
                    effect: correctionEffect,
                    type: 'web-passive-live-tail-correction',
                }],
                webPassiveLiveTailCorrectionEffect: correctionEffect,
            });
        }
        if (input.hasLiveWebMetrics === true) {
            const shouldSuppressTrustedReturnToLiveTail =
                input.isTrusted === true &&
                input.movedTowardLiveTail &&
                input.webMovedSinceLastObservation === false &&
                Math.max(0, input.distanceFromLiveTailPx) <= Math.max(0, input.pinThresholdPx);
            if (shouldSuppressTrustedReturnToLiveTail) {
                return createScrollObservationPlan({
                    disposition: 'ignored',
                    state: lifecycle.getState(),
                });
            }
            const factsEffects = resolveWebScrollFactsObservationEffects({
                dispatch: lifecycle.dispatch,
                distanceFromLiveTailPx: input.distanceFromLiveTailPx,
                movedAwayFromLiveTail: input.movedAwayFromLiveTail,
                movedTowardLiveTail: input.movedTowardLiveTail,
                pinThresholdPx: input.pinThresholdPx,
                sessionId: input.sessionId,
                webObservedUserScrollMovement: false,
            });
            const genericEffects = resolveWebScrollObservationGenericLifecycleEffects({
                effects: factsEffects,
                nextScrollOffsetPx: input.scrollOffsetPx,
                pinEnabled: input.pinEnabled,
                pinnedOffsetThresholdPx: input.pinThresholdPx,
                sessionId: input.sessionId,
            });
            if (genericEffects.length > 0 || factsEffects.length > 0) {
                const steps: TranscriptScrollObservationHostStep[] = [];
                if (factsEffects.length > 0) {
                    steps.push({
                        lifecycleEffects: factsEffects,
                        type: 'web-scroll-facts',
                    });
                }
                if (genericEffects.length > 0) {
                    steps.push({
                        genericEffects,
                        type: 'web-generic-observation',
                    });
                }
                return createScrollObservationPlan({
                    disposition: genericEffects.length > 0 ? 'continue' : 'ignored',
                    genericEffects,
                    lifecycleEffects: factsEffects,
                    state: lifecycle.getState(),
                    steps,
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
    const steps: TranscriptScrollObservationHostStep[] = [
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

function resolveWebPassiveLiveTailCorrectionEffect(
    input: TranscriptScrollObservationHostWebInput,
): TranscriptScrollObservationHostWebPassiveLiveTailCorrectionEffect | null {
    const distanceFromLiveTailPx = Math.max(0, input.distanceFromLiveTailPx);
    const pinThresholdPx = Math.max(0, input.pinThresholdPx);
    if (input.hasLiveWebMetrics !== true) return null;
    if (input.webLiveTailCorrectionActive !== true) return null;
    if (!input.pinEnabled || !input.wantsPinned) return null;
    if (distanceFromLiveTailPx <= 0 || distanceFromLiveTailPx > pinThresholdPx) return null;
    return {
        reason: 'passive-drift',
        sessionId: input.sessionId,
        type: 'apply-web-passive-live-tail-correction',
    };
}

function resolveNativePassiveScrollObservationPlan(
    input: TranscriptScrollObservationHostNativeInput,
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
        })
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
        shouldSuppressUntrustedUnpinnedAnchorCapture &&
        !input.nativeMomentumScrollActive
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
    input: TranscriptScrollObservationHostNativeInput,
    observeNativeScrollFacts: NativeScrollFactsObserver,
    planNativeUserScrollTakeover: NativeUserScrollTakeoverPlanner,
    getState: () => TranscriptViewportLifecycleState,
): TranscriptScrollObservationHostPlan {
    const lifecycleEffects: TranscriptViewportLifecycleEffect[] = [];
    const genericEffects: TranscriptViewportLifecycleEffect[] = [];
    const steps: TranscriptScrollObservationHostStep[] = [];
    const passiveObservation = resolveNativePassiveScrollObservationPlan(input, planNativeUserScrollTakeover);
    const nativeBottomFollowCompletionEffects = resolveNativeBottomFollowCompletionEffects({
        contentHeight: input.contentHeightPx,
        distanceFromBottom: input.distanceFromLiveTailForReleasePx,
        isNative: true,
        lastNativePinOffset: input.lastNativePinOffset,
        mountSettleDeadlineReached: input.nativeMountSettleDeadlineReached,
        mountSettleStable: input.nativeMountSettleStable,
        pendingBottomPin: input.pendingBottomPin,
        pinThresholdPx: input.pinThresholdPx,
        sessionId: input.sessionId,
        usesNativeFlashListBottomMaintenance: input.usesNativeFlashListBottomMaintenance,
        visualBottomScrollOffset: input.visualBottomScrollOffset,
        wantsPinned: input.wantsPinned,
    });
    const createNativeScrollObservationPlan = (
        params: Parameters<typeof createScrollObservationPlan>[0],
    ): TranscriptScrollObservationHostPlan => createScrollObservationPlan({
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
        usesNativeFlashListBottomMaintenance: input.usesNativeFlashListBottomMaintenance,
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

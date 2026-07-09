import {
    resolveTranscriptBottomFollowIntent,
    type TranscriptBottomFollowIntentResult,
} from '@/components/sessions/transcript/scroll/resolveTranscriptBottomFollowIntent';
import {
    resolveGenericScrollObservationAnchorCaptureCancellationEffects,
    resolveGenericScrollObservationViewportStateEffects,
} from './genericScrollObservationViewportState';
import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export function resolveWebScrollFallbackFollowIntent(params: Readonly<{
    distanceFromLiveTailPx: number;
    pinThresholdPx: number;
    previousScrollOffset: number | null;
    recentUserIntent: boolean;
    scrollOffset: number;
    wantsPinned: boolean;
}>): TranscriptBottomFollowIntentResult {
    return resolveTranscriptBottomFollowIntent({
        canRearmBottom: true,
        canRelease: params.recentUserIntent,
        direction: 'toward-max',
        distanceFromBottom: params.distanceFromLiveTailPx,
        pinThresholdPx: params.pinThresholdPx,
        previousScrollOffset: params.previousScrollOffset,
        scrollOffset: params.scrollOffset,
        wantsPinned: params.wantsPinned,
    });
}

function resolveWebScrollFallbackObservationEffectsForFollowIntent(params: Readonly<{
    distanceFromLiveTailPx: number;
    followIntent: TranscriptBottomFollowIntentResult;
    pinEnabled: boolean;
    sessionId: string;
    suppressAnchorCapture: boolean;
}>): readonly TranscriptViewportLifecycleEffect[] {
    return resolveGenericScrollObservationViewportStateEffects({
        followIntentIsPinned: params.followIntent.isPinned,
        followIntentNextDistanceFromLiveTailPx: params.followIntent.nextDistanceFromBottom,
        followIntentNextScrollOffsetPx: params.followIntent.nextScrollOffset,
        followIntentWantsPinned: params.followIntent.wantsPinned,
        pinEnabled: params.pinEnabled,
        pinnedOffsetThresholdPx: params.followIntent.effectivePinnedOffsetThresholdPx,
        sessionId: params.sessionId,
        suppressAnchorCapture: params.suppressAnchorCapture,
        viewportDistanceFromLiveTailPx: params.distanceFromLiveTailPx,
    });
}

export function resolveWebScrollFallbackObservationEffects(params: Readonly<{
    distanceFromLiveTailPx: number;
    pinEnabled: boolean;
    pinThresholdPx: number;
    previousScrollOffset: number | null;
    recentUserIntent: boolean;
    scrollOffset: number;
    sessionId: string;
    suppressAnchorCapture?: boolean;
    wantsPinned: boolean;
}>): readonly TranscriptViewportLifecycleEffect[] {
    const followIntent = resolveWebScrollFallbackFollowIntent({
        distanceFromLiveTailPx: params.distanceFromLiveTailPx,
        pinThresholdPx: params.pinThresholdPx,
        previousScrollOffset: params.previousScrollOffset,
        recentUserIntent: params.recentUserIntent,
        scrollOffset: params.scrollOffset,
        wantsPinned: params.wantsPinned,
    });
    return resolveWebScrollFallbackObservationEffectsForFollowIntent({
        distanceFromLiveTailPx: params.distanceFromLiveTailPx,
        followIntent,
        pinEnabled: params.pinEnabled,
        sessionId: params.sessionId,
        suppressAnchorCapture: params.suppressAnchorCapture === true,
    });
}

export function resolveActiveWebScrollFallbackObservationEffects(params: Readonly<{
    distanceFromLiveTailPx: number;
    hasLiveWebMetrics: boolean;
    isWeb: boolean;
    pinEnabled: boolean;
    pinThresholdPx: number;
    previousScrollOffset: number | null;
    recentUserIntent: boolean;
    scrollOffset: number;
    sessionId: string;
    wantsPinned: boolean;
}>): readonly TranscriptViewportLifecycleEffect[] {
    if (!params.isWeb || params.hasLiveWebMetrics) return [];
    const followIntent = resolveWebScrollFallbackFollowIntent({
        distanceFromLiveTailPx: params.distanceFromLiveTailPx,
        pinThresholdPx: params.pinThresholdPx,
        previousScrollOffset: params.previousScrollOffset,
        recentUserIntent: params.recentUserIntent,
        scrollOffset: params.scrollOffset,
        wantsPinned: params.wantsPinned,
    });
    const suppressAnchorCapture = !followIntent.wantsPinned;
    const fallbackEffects = resolveWebScrollFallbackObservationEffectsForFollowIntent({
        distanceFromLiveTailPx: params.distanceFromLiveTailPx,
        followIntent,
        pinEnabled: params.pinEnabled,
        sessionId: params.sessionId,
        suppressAnchorCapture,
    });
    if (!suppressAnchorCapture) return fallbackEffects;
    return [
        ...fallbackEffects,
        ...resolveGenericScrollObservationAnchorCaptureCancellationEffects({
            reason: 'web-no-live-metrics-fallback-release',
            sessionId: params.sessionId,
        }),
    ];
}

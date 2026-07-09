import {
    resolveGenericScrollObservationViewportStateEffects,
} from './genericScrollObservationViewportState';
import type { TranscriptViewportLifecycleEffect } from './lifecycle';

type WebObservedViewportStateEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'web-observed-viewport-state' }
>;

export function resolveWebObservedViewportStateGenericEffects(params: Readonly<{
    effect: WebObservedViewportStateEffect;
    nextScrollOffsetPx: number;
    pinEnabled: boolean;
}>): readonly TranscriptViewportLifecycleEffect[] {
    return resolveGenericScrollObservationViewportStateEffects({
        followIntentIsPinned: params.effect.isPinned,
        followIntentNextDistanceFromLiveTailPx: params.effect.distanceFromLiveTailPx,
        followIntentNextScrollOffsetPx: params.nextScrollOffsetPx,
        followIntentWantsPinned: params.effect.wantsPinned,
        pinEnabled: params.pinEnabled,
        pinnedOffsetThresholdPx: params.effect.pinnedOffsetThresholdPx,
        sessionId: params.effect.sessionId,
        suppressAnchorCapture: false,
        viewportDistanceFromLiveTailPx: params.effect.distanceFromLiveTailPx,
    });
}

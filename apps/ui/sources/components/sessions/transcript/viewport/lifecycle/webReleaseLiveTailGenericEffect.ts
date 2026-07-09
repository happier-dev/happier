import {
    resolveGenericScrollObservationViewportStateEffects,
} from './genericScrollObservationViewportState';
import type { TranscriptViewportLifecycleEffect } from './lifecycle';

type WebReleaseLiveTailEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'web-release-live-tail' }
>;

export function resolveWebReleaseLiveTailGenericEffects(params: Readonly<{
    effect: WebReleaseLiveTailEffect;
    nextScrollOffsetPx: number;
    pinEnabled: boolean;
}>): readonly TranscriptViewportLifecycleEffect[] {
    return resolveGenericScrollObservationViewportStateEffects({
        followIntentIsPinned: false,
        followIntentNextDistanceFromLiveTailPx: params.effect.distanceFromLiveTailPx,
        followIntentNextScrollOffsetPx: params.nextScrollOffsetPx,
        followIntentWantsPinned: false,
        pinEnabled: params.pinEnabled,
        pinnedOffsetThresholdPx: 0,
        sessionId: params.effect.sessionId,
        suppressAnchorCapture: false,
        viewportDistanceFromLiveTailPx: params.effect.distanceFromLiveTailPx,
    });
}

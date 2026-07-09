import {
    resolveGenericScrollObservationViewportStateEffects,
} from './genericScrollObservationViewportState';
import type { TranscriptViewportLifecycleEffect } from './lifecycle';

type NativeScrollReleaseLiveTailEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'native-scroll-release-live-tail' }
>;

function normalizeNextScrollOffsetPx(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function resolveNativeScrollReleaseLiveTailGenericEffects(params: Readonly<{
    effect: NativeScrollReleaseLiveTailEffect;
    nextScrollOffsetPx: number;
    pinEnabled: boolean;
}>): readonly TranscriptViewportLifecycleEffect[] {
    return resolveGenericScrollObservationViewportStateEffects({
        followIntentIsPinned: false,
        followIntentNextDistanceFromLiveTailPx: params.effect.distanceFromLiveTailPx,
        followIntentNextScrollOffsetPx: normalizeNextScrollOffsetPx(params.nextScrollOffsetPx),
        followIntentWantsPinned: false,
        pinEnabled: params.pinEnabled,
        pinnedOffsetThresholdPx: 0,
        sessionId: params.effect.sessionId,
        suppressAnchorCapture: false,
        viewportDistanceFromLiveTailPx: params.effect.distanceFromLiveTailPx,
    });
}

export function resolveNativeScrollReleaseLiveTailGenericLifecycleEffects(params: Readonly<{
    effects: readonly TranscriptViewportLifecycleEffect[];
    nextScrollOffsetPx: number;
    pinEnabled: boolean;
    sessionId: string;
}>): readonly TranscriptViewportLifecycleEffect[] {
    const releaseEffect = params.effects.find((
        effect,
    ): effect is NativeScrollReleaseLiveTailEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'native-scroll-release-live-tail'
    ));
    if (!releaseEffect) return [];
    return resolveNativeScrollReleaseLiveTailGenericEffects({
        effect: releaseEffect,
        nextScrollOffsetPx: params.nextScrollOffsetPx,
        pinEnabled: params.pinEnabled,
    });
}

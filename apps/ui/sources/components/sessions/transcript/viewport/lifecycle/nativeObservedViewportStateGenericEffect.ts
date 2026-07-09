import {
    resolveGenericScrollObservationViewportStateEffects,
} from './genericScrollObservationViewportState';
import type { TranscriptViewportLifecycleEffect } from './lifecycle';

type NativeObservedViewportStateEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'native-observed-viewport-state' }
>;

function normalizeNextScrollOffsetPx(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function resolveNativeObservedViewportStateGenericEffects(params: Readonly<{
    effect: NativeObservedViewportStateEffect;
    nextScrollOffsetPx: number;
    pinEnabled: boolean;
    suppressAnchorCapture: boolean;
}>): readonly TranscriptViewportLifecycleEffect[] {
    return resolveGenericScrollObservationViewportStateEffects({
        followIntentIsPinned: params.effect.isPinned,
        followIntentNextDistanceFromLiveTailPx: params.effect.distanceFromLiveTailPx,
        followIntentNextScrollOffsetPx: normalizeNextScrollOffsetPx(params.nextScrollOffsetPx),
        followIntentWantsPinned: params.effect.wantsPinned,
        pinEnabled: params.pinEnabled,
        pinnedOffsetThresholdPx: params.effect.pinnedOffsetThresholdPx,
        sessionId: params.effect.sessionId,
        suppressAnchorCapture: params.suppressAnchorCapture,
        viewportDistanceFromLiveTailPx: params.effect.distanceFromLiveTailPx,
    });
}

export function resolveNativeObservedViewportStateGenericLifecycleEffects(params: Readonly<{
    effects: readonly TranscriptViewportLifecycleEffect[];
    nextScrollOffsetPx: number;
    pinEnabled: boolean;
    sessionId: string;
    suppressAnchorCapture: boolean;
}>): readonly TranscriptViewportLifecycleEffect[] {
    const observedEffect = params.effects.find((
        effect,
    ): effect is NativeObservedViewportStateEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'native-observed-viewport-state'
    ));
    if (!observedEffect) return [];
    return resolveNativeObservedViewportStateGenericEffects({
        effect: observedEffect,
        nextScrollOffsetPx: params.nextScrollOffsetPx,
        pinEnabled: params.pinEnabled,
        suppressAnchorCapture: params.suppressAnchorCapture,
    });
}

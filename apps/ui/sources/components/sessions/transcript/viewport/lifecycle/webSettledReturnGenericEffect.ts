import {
    resolveGenericScrollObservationViewportStateEffects,
} from './genericScrollObservationViewportState';
import type { TranscriptViewportLifecycleEffect } from './lifecycle';

type WebSettledReturnViewportEffect = Readonly<{
    distanceFromLiveTailPx: number;
    isPinned: boolean;
    sessionId: string;
    source: Extract<TranscriptViewportLifecycleEffect, { type: 'viewport-change' }>['source'];
    type: 'viewport-change';
}>;

type WebSettledReturnDrainEffect = Readonly<{
    distanceFromLiveTailPx: number;
    isPinned: boolean;
    sessionId: string;
    type: 'drain-deferred-newer';
}>;

export function resolveWebSettledReturnGenericEffects(params: Readonly<{
    drainEffect: WebSettledReturnDrainEffect | null;
    nextScrollOffsetPx: number;
    pinEnabled: boolean;
    pinnedOffsetThresholdPx: number;
    viewportEffect: WebSettledReturnViewportEffect;
}>): readonly TranscriptViewportLifecycleEffect[] {
    if (
        params.viewportEffect.isPinned !== true ||
        params.drainEffect === null ||
        params.drainEffect.isPinned !== true ||
        params.drainEffect.sessionId !== params.viewportEffect.sessionId ||
        params.drainEffect.distanceFromLiveTailPx !== params.viewportEffect.distanceFromLiveTailPx
    ) {
        return [];
    }
    return resolveGenericScrollObservationViewportStateEffects({
        followIntentIsPinned: true,
        followIntentNextDistanceFromLiveTailPx: params.viewportEffect.distanceFromLiveTailPx,
        followIntentNextScrollOffsetPx: params.nextScrollOffsetPx,
        followIntentWantsPinned: true,
        pinEnabled: params.pinEnabled,
        pinnedOffsetThresholdPx: params.pinnedOffsetThresholdPx,
        sessionId: params.viewportEffect.sessionId,
        suppressAnchorCapture: false,
        viewportDistanceFromLiveTailPx: params.viewportEffect.distanceFromLiveTailPx,
    });
}

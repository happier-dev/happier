import type { TranscriptViewportLifecycleEffect } from './lifecycle';
import { resolveWebObservedViewportStateGenericEffects } from './webObservedViewportStateGenericEffect';
import { resolveWebReleaseLiveTailGenericEffects } from './webReleaseLiveTailGenericEffect';
import { resolveWebSettledReturnGenericEffects } from './webSettledReturnGenericEffect';

type WebSettledReturnViewportEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'viewport-change' }
>;

type WebSettledReturnDrainEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'drain-deferred-newer' }
>;

type WebReleaseLiveTailEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'web-release-live-tail' }
>;

type WebObservedViewportStateEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'web-observed-viewport-state' }
>;

export function resolveWebScrollObservationGenericLifecycleEffects(params: Readonly<{
    effects: readonly TranscriptViewportLifecycleEffect[];
    nextScrollOffsetPx: number;
    pinEnabled: boolean;
    pinnedOffsetThresholdPx: number;
    sessionId: string;
}>): readonly TranscriptViewportLifecycleEffect[] {
    const viewportEffect = params.effects.find((
        effect,
    ): effect is WebSettledReturnViewportEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'viewport-change'
    ));
    const drainEffect = params.effects.find((
        effect,
    ): effect is WebSettledReturnDrainEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'drain-deferred-newer' &&
        effect.isPinned === true
    ));
    if (viewportEffect) {
        const settledReturnEffects = resolveWebSettledReturnGenericEffects({
            drainEffect: drainEffect ?? null,
            nextScrollOffsetPx: params.nextScrollOffsetPx,
            pinEnabled: params.pinEnabled,
            pinnedOffsetThresholdPx: params.pinnedOffsetThresholdPx,
            viewportEffect,
        });
        if (settledReturnEffects.length > 0) return settledReturnEffects;
    }

    const releaseEffect = params.effects.find((
        effect,
    ): effect is WebReleaseLiveTailEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'web-release-live-tail'
    ));
    if (releaseEffect) {
        return resolveWebReleaseLiveTailGenericEffects({
            effect: releaseEffect,
            nextScrollOffsetPx: params.nextScrollOffsetPx,
            pinEnabled: params.pinEnabled,
        });
    }

    const observedEffect = params.effects.find((
        effect,
    ): effect is WebObservedViewportStateEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'web-observed-viewport-state'
    ));
    if (!observedEffect) return [];
    return resolveWebObservedViewportStateGenericEffects({
        effect: observedEffect,
        nextScrollOffsetPx: params.nextScrollOffsetPx,
        pinEnabled: params.pinEnabled,
    });
}

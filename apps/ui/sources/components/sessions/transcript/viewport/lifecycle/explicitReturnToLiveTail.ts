import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export type ExplicitReturnToLiveTailViewportEffect = Readonly<{
    distanceFromLiveTailPx: number;
    isPinned: true;
    sessionId: string;
    type: 'apply-explicit-return-to-live-tail-viewport';
}>;

export type ExplicitReturnToLiveTailClearUserScrollIntentEffect = Readonly<{
    sessionId: string;
    type: 'apply-explicit-return-clear-user-scroll-intent';
}>;

export type ExplicitReturnToLiveTailApplyEffect =
    | ExplicitReturnToLiveTailClearUserScrollIntentEffect
    | ExplicitReturnToLiveTailViewportEffect;

export function resolveExplicitReturnToLiveTailApplyEffects(params: Readonly<{
    effects: readonly TranscriptViewportLifecycleEffect[];
    sessionId: string;
}>): readonly ExplicitReturnToLiveTailApplyEffect[] {
    const applyEffects: ExplicitReturnToLiveTailApplyEffect[] = [];
    for (const effect of params.effects) {
        if (effect.sessionId !== params.sessionId) continue;
        if (effect.type === 'explicit-return-clear-user-scroll-intent') {
            applyEffects.push({
                sessionId: effect.sessionId,
                type: 'apply-explicit-return-clear-user-scroll-intent',
            });
            continue;
        }
        if (effect.type === 'viewport-change' && effect.source === 'explicit-return') {
            applyEffects.push({
                distanceFromLiveTailPx: effect.distanceFromLiveTailPx,
                isPinned: true,
                sessionId: effect.sessionId,
                type: 'apply-explicit-return-to-live-tail-viewport',
            });
        }
    }
    return applyEffects;
}

export function resolveExplicitReturnToLiveTailViewportEffects(params: Readonly<{
    effects: readonly TranscriptViewportLifecycleEffect[];
    sessionId: string;
}>): readonly ExplicitReturnToLiveTailViewportEffect[] {
    return resolveExplicitReturnToLiveTailApplyEffects(params).filter((
        effect,
    ): effect is ExplicitReturnToLiveTailViewportEffect => (
        effect.type === 'apply-explicit-return-to-live-tail-viewport'
    ));
}

import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export type WebImmediateReleaseLiveTailApplyEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'web-immediate-release-live-tail' }
>;

export function resolveWebImmediateReleaseLiveTailApplyEffects(params: Readonly<{
    effects: readonly Readonly<{ sessionId?: string; type: string }>[];
    sessionId: string;
}>): readonly WebImmediateReleaseLiveTailApplyEffect[] {
    return params.effects.filter((
        effect,
    ): effect is WebImmediateReleaseLiveTailApplyEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'web-immediate-release-live-tail'
    ));
}

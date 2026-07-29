import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export type LocalTranscriptInteractionIntentApplyEffect = Extract<
    TranscriptViewportLifecycleEffect,
    {
        type: 'local-interaction-record-intent-timestamp';
    }
>;

export function resolveLocalTranscriptInteractionIntentApplyEffects(params: Readonly<{
    effects: readonly Readonly<{ sessionId?: string; type: string }>[];
    sessionId: string;
}>): readonly LocalTranscriptInteractionIntentApplyEffect[] {
    return params.effects.filter((
        effect,
    ): effect is LocalTranscriptInteractionIntentApplyEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'local-interaction-record-intent-timestamp'
    ));
}

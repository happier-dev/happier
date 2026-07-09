import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export type LocalTranscriptInteractionAutoPinDeferralApplyEffect = Extract<
    TranscriptViewportLifecycleEffect,
    {
        type:
            | 'local-interaction-record-intent-timestamp'
            | 'local-interaction-suppress-native-mount-settle-auto-pin'
            | 'local-interaction-cancel-scheduled-pin';
    }
>;

export function resolveLocalTranscriptInteractionAutoPinDeferralApplyEffects(params: Readonly<{
    effects: readonly Readonly<{ sessionId?: string; type: string }>[];
    sessionId: string;
}>): readonly LocalTranscriptInteractionAutoPinDeferralApplyEffect[] {
    return params.effects.filter((
        effect,
    ): effect is LocalTranscriptInteractionAutoPinDeferralApplyEffect => (
        effect.sessionId === params.sessionId &&
        (
            effect.type === 'local-interaction-record-intent-timestamp' ||
            effect.type === 'local-interaction-suppress-native-mount-settle-auto-pin' ||
            effect.type === 'local-interaction-cancel-scheduled-pin'
        )
    ));
}

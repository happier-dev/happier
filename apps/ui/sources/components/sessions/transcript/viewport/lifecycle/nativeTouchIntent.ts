import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export type NativeTouchIntentApplyEffect = Extract<
    TranscriptViewportLifecycleEffect,
    {
        type: 'native-touch-record-intent-timestamp';
    }
>;

export function resolveNativeTouchIntentApplyEffects(params: Readonly<{
    effects: readonly Readonly<{ sessionId?: string; type: string }>[];
    sessionId: string;
}>): readonly NativeTouchIntentApplyEffect[] {
    return params.effects.filter((
        effect,
    ): effect is NativeTouchIntentApplyEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'native-touch-record-intent-timestamp'
    ));
}

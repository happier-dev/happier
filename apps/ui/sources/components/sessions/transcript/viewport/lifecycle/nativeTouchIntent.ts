import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export type NativeTouchIntentApplyEffect = Extract<
    TranscriptViewportLifecycleEffect,
    {
        type:
            | 'native-touch-record-intent-timestamp'
            | 'native-touch-suppress-native-mount-settle-auto-pin'
            | 'native-touch-cancel-native-mount-settle-bottom-pin'
            | 'native-touch-cancel-scheduled-pin';
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
        (
            effect.type === 'native-touch-record-intent-timestamp' ||
            effect.type === 'native-touch-suppress-native-mount-settle-auto-pin' ||
            effect.type === 'native-touch-cancel-native-mount-settle-bottom-pin' ||
            effect.type === 'native-touch-cancel-scheduled-pin'
        )
    ));
}

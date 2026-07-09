import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export type NativeUserScrollTakeoverApplyEffect = Extract<
    TranscriptViewportLifecycleEffect,
    {
        type:
            | 'native-user-scroll-preempt-entry-restore'
            | 'native-user-scroll-cancel-native-mount-settle-bottom-pin'
            | 'native-user-scroll-suppress-native-mount-settle-auto-pin'
            | 'native-user-scroll-clear-native-initial-viewport-pending-observation'
            | 'native-user-scroll-record-intent-timestamp';
    }
>;

export function resolveNativeUserScrollTakeoverApplyEffects(params: Readonly<{
    effects: readonly Readonly<{ sessionId?: string; type: string }>[];
    sessionId: string;
}>): readonly NativeUserScrollTakeoverApplyEffect[] {
    return params.effects.filter((
        effect,
    ): effect is NativeUserScrollTakeoverApplyEffect => (
        effect.sessionId === params.sessionId &&
        (
            effect.type === 'native-user-scroll-preempt-entry-restore' ||
            effect.type === 'native-user-scroll-cancel-native-mount-settle-bottom-pin' ||
            effect.type === 'native-user-scroll-suppress-native-mount-settle-auto-pin' ||
            effect.type === 'native-user-scroll-clear-native-initial-viewport-pending-observation' ||
            effect.type === 'native-user-scroll-record-intent-timestamp'
        )
    ));
}

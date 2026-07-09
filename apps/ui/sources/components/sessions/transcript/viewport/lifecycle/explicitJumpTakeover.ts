import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export type ExplicitJumpTakeoverApplyEffect = Extract<
    TranscriptViewportLifecycleEffect,
    {
        type:
            | 'explicit-jump-cancel-native-mount-settle-bottom-pin'
            | 'explicit-jump-suppress-entry-restore'
            | 'explicit-jump-preempt-entry-restore'
            | 'explicit-jump-clear-native-entry-restore-paint-release-timeout'
            | 'explicit-jump-invalidate-native-prepend-transaction'
            | 'explicit-jump-clear-native-restore-index-command-cache'
            | 'explicit-jump-close-native-prepend-transaction';
    }
>;

export function resolveExplicitJumpTakeoverApplyEffects(params: Readonly<{
    effects: readonly Readonly<{ sessionId?: string; type: string }>[];
    sessionId: string;
}>): readonly ExplicitJumpTakeoverApplyEffect[] {
    return params.effects.filter((
        effect,
    ): effect is ExplicitJumpTakeoverApplyEffect => (
        effect.sessionId === params.sessionId &&
        (
            effect.type === 'explicit-jump-cancel-native-mount-settle-bottom-pin' ||
            effect.type === 'explicit-jump-suppress-entry-restore' ||
            effect.type === 'explicit-jump-preempt-entry-restore' ||
            effect.type === 'explicit-jump-clear-native-entry-restore-paint-release-timeout' ||
            effect.type === 'explicit-jump-invalidate-native-prepend-transaction' ||
            effect.type === 'explicit-jump-clear-native-restore-index-command-cache' ||
            effect.type === 'explicit-jump-close-native-prepend-transaction'
        )
    ));
}

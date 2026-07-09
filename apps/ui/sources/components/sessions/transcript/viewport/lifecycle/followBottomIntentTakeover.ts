import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export type FollowBottomIntentTakeoverApplyEffect = Extract<
    TranscriptViewportLifecycleEffect,
    {
        type:
            | 'follow-bottom-intent-preempt-entry-restore'
            | 'follow-bottom-intent-clear-user-scroll-intent'
            | 'follow-bottom-intent-record-live-tail-pin-offset';
    }
>;

export function resolveFollowBottomIntentTakeoverApplyEffects(params: Readonly<{
    effects: readonly Readonly<{ sessionId?: string; type: string }>[];
    sessionId: string;
}>): readonly FollowBottomIntentTakeoverApplyEffect[] {
    return params.effects.filter((
        effect,
    ): effect is FollowBottomIntentTakeoverApplyEffect => (
        effect.sessionId === params.sessionId &&
        (
            effect.type === 'follow-bottom-intent-preempt-entry-restore' ||
            effect.type === 'follow-bottom-intent-clear-user-scroll-intent' ||
            effect.type === 'follow-bottom-intent-record-live-tail-pin-offset'
        )
    ));
}

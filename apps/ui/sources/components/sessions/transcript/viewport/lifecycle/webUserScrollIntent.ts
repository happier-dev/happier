import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export type WebUserScrollTakeoverApplyEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'web-user-scroll-preempt-entry-restore' }
>;

export type WebUserScrollIntentTimestampApplyEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'web-user-scroll-record-intent-timestamp' }
>;

export function resolveWebUserScrollTakeoverApplyEffects(params: Readonly<{
    effects: readonly Readonly<{ sessionId?: string; type: string }>[];
    sessionId: string;
}>): readonly WebUserScrollTakeoverApplyEffect[] {
    return params.effects.filter((
        effect,
    ): effect is WebUserScrollTakeoverApplyEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'web-user-scroll-preempt-entry-restore'
    ));
}

export function resolveWebUserScrollIntentTimestampApplyEffects(params: Readonly<{
    effects: readonly Readonly<{ sessionId?: string; type: string }>[];
    sessionId: string;
}>): readonly WebUserScrollIntentTimestampApplyEffect[] {
    return params.effects.filter((
        effect,
    ): effect is WebUserScrollIntentTimestampApplyEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'web-user-scroll-record-intent-timestamp'
    ));
}

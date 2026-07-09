import type { TranscriptViewportLifecycleEffect } from './lifecycle';

type ContentGrowthLiveTailCommandEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'command' }
>;

export type ContentGrowthLiveTailCommandApplyEffect = Readonly<{
    reason: ContentGrowthLiveTailCommandEffect['command']['reason'];
    sessionId: string;
    type: 'apply-content-growth-live-tail-command';
}>;

export function resolveContentGrowthLiveTailCommandApplyEffect(params: Readonly<{
    effects: readonly TranscriptViewportLifecycleEffect[];
    sessionId: string;
}>): ContentGrowthLiveTailCommandApplyEffect | null {
    for (const effect of params.effects) {
        if (
            effect.sessionId !== params.sessionId ||
            effect.type !== 'command' ||
            effect.command.type !== 'scroll-to-live-tail'
        ) {
            continue;
        }
        const commandEffect: ContentGrowthLiveTailCommandEffect = effect;
        return {
            reason: commandEffect.command.reason,
            sessionId: commandEffect.sessionId,
            type: 'apply-content-growth-live-tail-command',
        };
    }
    return null;
}

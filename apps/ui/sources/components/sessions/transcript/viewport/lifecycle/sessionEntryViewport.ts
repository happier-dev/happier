import type { TranscriptViewportLifecycleEffect } from './lifecycle';

type SessionEntryViewportLifecycleEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'session-entry-viewport' }
>;

export type SessionEntryViewportApplyEffect = Readonly<{
    distanceFromLiveTailPx: number | null;
    isPinned: boolean;
    jumpButtonDistanceFromLiveTailPx: number;
    sessionId: string;
    shouldEmitViewportChange: boolean;
    shouldRestoreViewport: boolean;
    shouldUseEntryAnchor: boolean;
    type: 'apply-session-entry-viewport';
}>;

export function resolveSessionEntryViewportApplyEffects(params: Readonly<{
    effects: readonly TranscriptViewportLifecycleEffect[];
    sessionId: string;
}>): readonly SessionEntryViewportApplyEffect[] {
    const applyEffects: SessionEntryViewportApplyEffect[] = [];
    for (const effect of params.effects) {
        if (effect.sessionId !== params.sessionId || effect.type !== 'session-entry-viewport') continue;
        const entryEffect: SessionEntryViewportLifecycleEffect = effect;
        applyEffects.push({
            distanceFromLiveTailPx: entryEffect.distanceFromLiveTailPx,
            isPinned: entryEffect.isPinned,
            jumpButtonDistanceFromLiveTailPx: entryEffect.distanceFromLiveTailPx ?? 0,
            sessionId: entryEffect.sessionId,
            shouldEmitViewportChange:
                entryEffect.distanceFromLiveTailPx !== null ||
                !entryEffect.shouldRestoreViewport,
            shouldRestoreViewport: entryEffect.shouldRestoreViewport,
            shouldUseEntryAnchor: entryEffect.shouldRestoreViewport,
            type: 'apply-session-entry-viewport',
        });
    }
    return applyEffects;
}

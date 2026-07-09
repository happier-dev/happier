import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export type NativeMomentumActiveMirrorApplyEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'native-momentum-active-mirror' }
>;

export type NativeDragActiveMirrorApplyEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'native-drag-active-mirror' }
>;

export function resolveNativeMomentumActiveMirrorApplyEffects(params: Readonly<{
    effects: readonly Readonly<{ sessionId?: string; type: string }>[];
    sessionId: string;
}>): readonly NativeMomentumActiveMirrorApplyEffect[] {
    return params.effects.filter((
        effect,
    ): effect is NativeMomentumActiveMirrorApplyEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'native-momentum-active-mirror'
    ));
}

export function resolveNativeDragActiveMirrorApplyEffects(params: Readonly<{
    effects: readonly Readonly<{ sessionId?: string; type: string }>[];
    sessionId: string;
}>): readonly NativeDragActiveMirrorApplyEffect[] {
    return params.effects.filter((
        effect,
    ): effect is NativeDragActiveMirrorApplyEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'native-drag-active-mirror'
    ));
}

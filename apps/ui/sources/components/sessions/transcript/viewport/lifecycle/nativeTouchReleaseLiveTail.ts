import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export type NativeTouchReleaseLiveTailInputEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'native-touch-release-live-tail' }
>;

export type NativeTouchReleaseLiveTailStateEffect = Readonly<{
    sessionId: string;
    type: 'apply-native-touch-release-live-tail-state';
}>;

export function resolveNativeTouchReleaseLiveTailStateEffects(params: Readonly<{
    effects: readonly TranscriptViewportLifecycleEffect[];
    sessionId: string;
}>): readonly NativeTouchReleaseLiveTailStateEffect[] {
    const releaseEffect = params.effects.find((
        effect,
    ): effect is NativeTouchReleaseLiveTailInputEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'native-touch-release-live-tail'
    ));
    if (!releaseEffect) return [];

    return [{
        sessionId: params.sessionId,
        type: 'apply-native-touch-release-live-tail-state',
    }];
}

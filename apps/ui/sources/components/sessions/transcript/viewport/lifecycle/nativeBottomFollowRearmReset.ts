import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export type NativeBottomFollowRearmResetInputEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'native-bottom-follow-rearm-reset' }
>;

export type NativeBottomFollowRearmResetEffect = Readonly<{
    sessionId: string;
    type: 'reset-native-bottom-follow-rearm';
}>;

export function resolveNativeBottomFollowRearmResetEffects(params: Readonly<{
    effects: readonly TranscriptViewportLifecycleEffect[];
    sessionId: string;
}>): readonly NativeBottomFollowRearmResetEffect[] {
    return params.effects.flatMap((effect): readonly NativeBottomFollowRearmResetEffect[] => {
        if (
            effect.sessionId !== params.sessionId ||
            effect.type !== 'native-bottom-follow-rearm-reset'
        ) {
            return [];
        }
        return [{
            sessionId: params.sessionId,
            type: 'reset-native-bottom-follow-rearm',
        }];
    });
}

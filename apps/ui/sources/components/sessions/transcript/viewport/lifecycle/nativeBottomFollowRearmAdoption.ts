import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export type NativeBottomFollowRearmAdoptionInputEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'native-bottom-follow-rearm' }
>;

export type NativeBottomFollowRearmAdoptionEffect = Readonly<{
    distanceFromLiveTailPx: number;
    sessionId: string;
    type: 'adopt-native-bottom-follow-rearm';
}>;

export type NativeBottomFollowRearmAdoptionDecision = Readonly<{
    consumed: boolean;
    effects: readonly NativeBottomFollowRearmAdoptionEffect[];
}>;

export function resolveNativeBottomFollowRearmAdoptionDecision(params: Readonly<{
    effects: readonly TranscriptViewportLifecycleEffect[];
    hasRearmedNativeBottomFollow: boolean;
    sessionId: string;
}>): NativeBottomFollowRearmAdoptionDecision {
    const rearmEffect = params.effects.find((
        effect,
    ): effect is NativeBottomFollowRearmAdoptionInputEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'native-bottom-follow-rearm'
    ));
    if (!rearmEffect) return { consumed: false, effects: [] };
    if (params.hasRearmedNativeBottomFollow) return { consumed: true, effects: [] };

    return {
        consumed: true,
        effects: [{
            distanceFromLiveTailPx: rearmEffect.distanceFromLiveTailPx,
            sessionId: params.sessionId,
            type: 'adopt-native-bottom-follow-rearm',
        }],
    };
}

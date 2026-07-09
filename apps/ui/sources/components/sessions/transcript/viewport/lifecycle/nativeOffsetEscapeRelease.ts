import type { TranscriptBottomFollowModeState } from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';

import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export type NativeOffsetEscapeReleaseBlockedReason =
    | 'non-native'
    | 'not-pinned'
    | 'active-native-viewport-restore'
    | 'rearmed-following'
    | 'following-without-user-ownership'
    | 'missing-distance'
    | 'inside-pin-threshold';

export type NativeOffsetEscapeReleaseDecision =
    | Readonly<{ type: 'release' }>
    | Readonly<{ reason: NativeOffsetEscapeReleaseBlockedReason; type: 'blocked' }>;

export function resolveNativeOffsetEscapeReleaseDecision(params: Readonly<{
    bottomFollowState: TranscriptBottomFollowModeState;
    distanceFromLiveTailPx: number | null;
    hasActiveNativeViewportRestore: boolean;
    hasNativeTouchStart: boolean;
    hasRearmedNativeBottomFollow: boolean;
    isNative: boolean;
    nativeMomentumScrollActive: boolean;
    pinThresholdPx: number;
    wantsPinned: boolean;
}>): NativeOffsetEscapeReleaseDecision {
    if (!params.isNative) return { reason: 'non-native', type: 'blocked' };
    if (!params.wantsPinned) return { reason: 'not-pinned', type: 'blocked' };
    if (params.hasActiveNativeViewportRestore) {
        return { reason: 'active-native-viewport-restore', type: 'blocked' };
    }
    if (params.hasRearmedNativeBottomFollow && params.bottomFollowState.mode === 'following') {
        return { reason: 'rearmed-following', type: 'blocked' };
    }
    if (
        params.bottomFollowState.mode === 'following' &&
        params.bottomFollowState.dragSession == null &&
        !params.nativeMomentumScrollActive &&
        !params.hasNativeTouchStart
    ) {
        return { reason: 'following-without-user-ownership', type: 'blocked' };
    }
    if (params.distanceFromLiveTailPx == null) return { reason: 'missing-distance', type: 'blocked' };
    if (params.distanceFromLiveTailPx <= params.pinThresholdPx) {
        return { reason: 'inside-pin-threshold', type: 'blocked' };
    }
    return { type: 'release' };
}

export type NativeOffsetReleaseLiveTailInputEffect = Extract<
    TranscriptViewportLifecycleEffect,
    { type: 'native-offset-release-live-tail' }
>;

export type NativeOffsetReleaseLiveTailStateEffect = Readonly<{
    bottomFollowState: TranscriptBottomFollowModeState;
    sessionId: string;
    type: 'apply-native-offset-release-live-tail-state';
}>;

export function resolveNativeOffsetReleaseLiveTailStateEffects(params: Readonly<{
    bottomFollowState: TranscriptBottomFollowModeState;
    effects: readonly TranscriptViewportLifecycleEffect[];
    sessionId: string;
}>): readonly NativeOffsetReleaseLiveTailStateEffect[] {
    const releaseEffect = params.effects.find((
        effect,
    ): effect is NativeOffsetReleaseLiveTailInputEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'native-offset-release-live-tail'
    ));
    if (!releaseEffect) return [];
    return [{
        bottomFollowState: params.bottomFollowState,
        sessionId: params.sessionId,
        type: 'apply-native-offset-release-live-tail-state',
    }];
}

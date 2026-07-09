import type { TranscriptBottomFollowMode } from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import {
    resolveGenericScrollObservationReadOnlyVisibleBottomEffects,
} from './genericScrollObservationViewportState';
import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export type NativeScrollReadOnlyVisibleBottomIgnoredReason =
    | 'not-native'
    | 'trusted-observation'
    | 'already-following'
    | 'not-visible-live-tail'
    | 'not-wants-pinned';

export type NativeScrollReadOnlyVisibleBottomDecision =
    | Readonly<{
        distanceFromLiveTailPx: number;
        pinnedOffsetThresholdPx: number;
        type: 'record-visible-bottom';
    }>
    | Readonly<{
        reason: NativeScrollReadOnlyVisibleBottomIgnoredReason;
        type: 'ignore';
    }>;

export function resolveNativeScrollReadOnlyVisibleBottomDecision(params: Readonly<{
    bottomFollowMode: TranscriptBottomFollowMode;
    distanceFromLiveTailPx: number;
    followIntentIsPinned: boolean;
    followIntentWantsPinned: boolean;
    isNative: boolean;
    isTrusted: boolean;
    pinnedOffsetThresholdPx: number;
}>): NativeScrollReadOnlyVisibleBottomDecision {
    if (!params.isNative) return { reason: 'not-native', type: 'ignore' };
    if (params.isTrusted) return { reason: 'trusted-observation', type: 'ignore' };
    if (params.bottomFollowMode === 'following') return { reason: 'already-following', type: 'ignore' };
    if (!params.followIntentIsPinned) return { reason: 'not-visible-live-tail', type: 'ignore' };
    if (!params.followIntentWantsPinned) return { reason: 'not-wants-pinned', type: 'ignore' };
    return {
        distanceFromLiveTailPx: params.distanceFromLiveTailPx,
        pinnedOffsetThresholdPx: params.pinnedOffsetThresholdPx,
        type: 'record-visible-bottom',
    };
}

export function resolveNativeScrollReadOnlyVisibleBottomGenericEffects(
    decision: NativeScrollReadOnlyVisibleBottomDecision,
    params: Readonly<{
        pinEnabled: boolean;
        sessionId: string;
    }>,
): readonly TranscriptViewportLifecycleEffect[] {
    if (decision.type !== 'record-visible-bottom') return [];

    return resolveGenericScrollObservationReadOnlyVisibleBottomEffects({
        distanceFromLiveTailPx: decision.distanceFromLiveTailPx,
        pinEnabled: params.pinEnabled,
        pinnedOffsetThresholdPx: decision.pinnedOffsetThresholdPx,
        sessionId: params.sessionId,
    });
}

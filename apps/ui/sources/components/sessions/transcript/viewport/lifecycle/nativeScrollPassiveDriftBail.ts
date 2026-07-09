import type { TranscriptBottomFollowMode } from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import {
    resolveGenericScrollObservationSuppressionEffects,
} from './genericScrollObservationViewportState';
import type { TranscriptViewportLifecycleEffect } from './lifecycle';

export type NativeScrollPassiveDriftBailDecision =
    | Readonly<{ type: 'suppress-generic-observation' }>
    | Readonly<{
        reason:
            | 'not-native'
            | 'trusted-observation'
            | 'not-following'
            | 'not-wants-live-tail'
            | 'visible-live-tail';
        type: 'continue';
    }>;

export function resolveNativeScrollPassiveDriftBailDecision(params: Readonly<{
    bottomFollowMode: TranscriptBottomFollowMode;
    followIntentIsPinned: boolean;
    followIntentWantsPinned: boolean;
    isNative: boolean;
    isTrusted: boolean;
}>): NativeScrollPassiveDriftBailDecision {
    if (!params.isNative) return { reason: 'not-native', type: 'continue' };
    if (params.isTrusted) return { reason: 'trusted-observation', type: 'continue' };
    if (params.bottomFollowMode !== 'following') return { reason: 'not-following', type: 'continue' };
    if (!params.followIntentWantsPinned) return { reason: 'not-wants-live-tail', type: 'continue' };
    if (params.followIntentIsPinned) return { reason: 'visible-live-tail', type: 'continue' };
    return { type: 'suppress-generic-observation' };
}

export function resolveNativeScrollPassiveDriftBailGenericEffects(params: Readonly<{
    decision: NativeScrollPassiveDriftBailDecision;
    sessionId: string;
}>): readonly TranscriptViewportLifecycleEffect[] {
    if (params.decision.type !== 'suppress-generic-observation') return [];
    return resolveGenericScrollObservationSuppressionEffects({
        reason: 'native-passive-drift',
        sessionId: params.sessionId,
    });
}

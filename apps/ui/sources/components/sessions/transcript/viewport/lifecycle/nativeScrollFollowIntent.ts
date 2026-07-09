import {
    resolveTranscriptBottomFollowIntent,
    type TranscriptBottomFollowIntentResult,
} from '@/components/sessions/transcript/scroll/resolveTranscriptBottomFollowIntent';

import {
    resolveNativeScrollFollowIntentReleaseDecision,
} from './nativeScrollFollowIntentRelease';
import { resolveNativeScrollFollowIntentRearmDecision } from './nativeScrollFollowIntentRearm';

export function resolveNativeScrollFollowIntent(params: Readonly<{
    distanceFromLiveTailForReleasePx: number;
    distanceFromLiveTailPx: number;
    hasOpenTrustedAwayGesture: boolean;
    hasTrustedDragSession: boolean;
    isTrusted: boolean;
    movedTowardLiveTail: boolean;
    nativeMomentumScrollActive: boolean;
    pinThresholdPx: number;
    previousScrollOffset: number | null;
    scrollOffset: number;
    wantsPinned: boolean;
}>): TranscriptBottomFollowIntentResult {
    const releaseDecision = resolveNativeScrollFollowIntentReleaseDecision({
        distanceFromLiveTailPx: params.distanceFromLiveTailForReleasePx,
        hasTrustedDragSession: params.hasTrustedDragSession,
        isTrusted: params.isTrusted,
        nativeMomentumScrollActive: params.nativeMomentumScrollActive,
        pinThresholdPx: params.pinThresholdPx,
    });
    const rearmDecision = resolveNativeScrollFollowIntentRearmDecision({
        hasOpenTrustedAwayGesture: params.hasOpenTrustedAwayGesture,
        isTrusted: params.isTrusted,
        movedTowardLiveTail: params.movedTowardLiveTail,
    });
    return resolveTranscriptBottomFollowIntent({
        canRearmBottom: rearmDecision.type === 'allow-rearm',
        canRelease: releaseDecision.type === 'allow-release',
        direction: 'toward-max',
        distanceFromBottom: params.distanceFromLiveTailPx,
        pinThresholdPx: params.pinThresholdPx,
        previousScrollOffset: params.previousScrollOffset,
        scrollOffset: params.scrollOffset,
        wantsPinned: params.wantsPinned,
    });
}

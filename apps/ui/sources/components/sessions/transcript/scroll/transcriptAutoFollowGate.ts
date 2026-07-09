import type { TranscriptViewportTelemetryScrollReason } from './transcriptViewportTelemetry';
import type { TranscriptBottomFollowMode } from './transcriptBottomFollowMode';

export function canAutoFollowTranscriptBottom(params: Readonly<{
    autoFollowWhenPinned: boolean;
    bottomFollowMode: TranscriptBottomFollowMode;
    isExplicitUserCommand: boolean;
    jumpToSeqActive: boolean;
    pinEnabled: boolean;
    reason: TranscriptViewportTelemetryScrollReason;
    targetWindowActive?: boolean;
    wantsPinned: boolean;
}>): boolean {
    if (params.isExplicitUserCommand) return true;
    if (params.targetWindowActive === true) return false;
    if (!params.pinEnabled || !params.autoFollowWhenPinned) return false;
    if (params.jumpToSeqActive) return false;
    if (!params.wantsPinned) return false;
    return params.bottomFollowMode === 'following';
}

export function isExplicitTranscriptBottomFollowCommand(reason: TranscriptViewportTelemetryScrollReason): boolean {
    return reason === 'jump-to-bottom' || reason === 'jump-to-seq';
}

export function resolveTranscriptAutoFollowPinWaitMs(params: Readonly<{
    autoPinDelayMs: number;
    canAutoFollow: boolean;
    hasRearmedBottomFollow: boolean;
    lastUserScrollIntentAtMs: number;
    nowMs: number;
}>): number | null {
    if (!params.canAutoFollow) return null;
    if (params.hasRearmedBottomFollow) return 0;
    const elapsedSinceUserIntentMs = params.nowMs - params.lastUserScrollIntentAtMs;
    if (elapsedSinceUserIntentMs >= params.autoPinDelayMs) return 0;
    return Math.max(0, params.autoPinDelayMs - elapsedSinceUserIntentMs);
}

import type { TranscriptViewportTelemetryScrollReason } from './transcriptViewportTelemetry';
import type { TranscriptBottomFollowMode } from './transcriptBottomFollowMode';

export function canAutoFollowTranscriptBottom(params: Readonly<{
    autoFollowWhenPinned: boolean;
    bottomFollowMode: TranscriptBottomFollowMode;
    isExplicitUserCommand: boolean;
    jumpToSeqActive: boolean;
    pinEnabled: boolean;
    reason: TranscriptViewportTelemetryScrollReason;
    wantsPinned: boolean;
}>): boolean {
    if (params.isExplicitUserCommand) return true;
    if (!params.pinEnabled || !params.autoFollowWhenPinned) return false;
    if (params.jumpToSeqActive) return false;
    if (!params.wantsPinned) return false;
    return params.bottomFollowMode === 'following';
}

export function isExplicitTranscriptBottomFollowCommand(reason: TranscriptViewportTelemetryScrollReason): boolean {
    return reason === 'jump-to-bottom' || reason === 'jump-to-seq';
}

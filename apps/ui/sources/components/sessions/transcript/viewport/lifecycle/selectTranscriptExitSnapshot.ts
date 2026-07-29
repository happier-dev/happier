import type { TranscriptExitSnapshotSelection } from './transcriptSameSessionHandoff';

export function selectTranscriptExitSnapshot(deps: Readonly<{
    capturePhysicalExit(): TranscriptExitSnapshotSelection | null;
    flushJumpPromotion(): TranscriptExitSnapshotSelection | null;
}>): TranscriptExitSnapshotSelection | null {
    return deps.flushJumpPromotion() ?? deps.capturePhysicalExit();
}

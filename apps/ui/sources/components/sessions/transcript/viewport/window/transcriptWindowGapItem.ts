import type {
    TranscriptWindowGapDescriptor,
    TranscriptWindowGapItem,
} from './transcriptTargetWindowTypes';

export function createTranscriptWindowGapItem(
    gap: TranscriptWindowGapDescriptor,
): TranscriptWindowGapItem {
    return {
        ...gap,
        kind: 'transcript-window-gap',
    };
}

import {
    isRecoveredHistoryTranscriptObservationProvenance,
    type SessionMessageDeliveryResolutionV1,
    type SessionTranscriptObservationProvenanceV1,
} from '@happier-dev/protocol';

export type TranscriptObservationMetadata = {
    sourceCreatedAt?: number;
    sourceUpdatedAt?: number;
    transcriptObservationProvenance?: SessionTranscriptObservationProvenanceV1;
    deliveryResolution?: SessionMessageDeliveryResolutionV1;
};

export function applyTranscriptObservationMetadata(
    target: TranscriptObservationMetadata,
    source: Readonly<TranscriptObservationMetadata> | null | undefined,
): void {
    if (source?.sourceCreatedAt !== undefined) {
        target.sourceCreatedAt = source.sourceCreatedAt;
    }
    if (source?.sourceUpdatedAt !== undefined) {
        target.sourceUpdatedAt = source.sourceUpdatedAt;
    }
    if (source?.transcriptObservationProvenance !== undefined) {
        target.transcriptObservationProvenance = source.transcriptObservationProvenance;
    }
    if (source?.deliveryResolution !== undefined) {
        target.deliveryResolution = source.deliveryResolution;
    }
}

export function isRecoveredHistoryTranscriptObservation(
    message: Readonly<Pick<TranscriptObservationMetadata, 'transcriptObservationProvenance'>> | null | undefined,
): boolean {
    return isRecoveredHistoryTranscriptObservationProvenance(message?.transcriptObservationProvenance);
}

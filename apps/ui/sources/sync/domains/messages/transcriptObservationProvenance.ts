import {
    isRecoveredHistoryTranscriptObservationProvenance,
    MessageActionReferenceV1Schema,
    type MessageActionReferenceV1,
    type SessionMessageDeliveryResolutionV1,
    type SessionTranscriptObservationProvenanceV1,
} from '@happier-dev/protocol';

export type TranscriptObservationMetadata = {
    sourceCreatedAt?: number;
    sourceUpdatedAt?: number;
    transcriptObservationProvenance?: SessionTranscriptObservationProvenanceV1;
    deliveryResolution?: SessionMessageDeliveryResolutionV1;
    /** Opaque server-issued identity; runtime resolves its current action state. */
    messageActionReference?: MessageActionReferenceV1;
};

export function applyTranscriptObservationMetadata(
    target: TranscriptObservationMetadata,
    source: Readonly<TranscriptObservationMetadata> | null | undefined,
): void {
    if (source?.sourceCreatedAt !== undefined) target.sourceCreatedAt = source.sourceCreatedAt;
    if (source?.sourceUpdatedAt !== undefined) target.sourceUpdatedAt = source.sourceUpdatedAt;
    if (source?.transcriptObservationProvenance !== undefined) {
        target.transcriptObservationProvenance = source.transcriptObservationProvenance;
    }
    if (source?.deliveryResolution !== undefined) target.deliveryResolution = source.deliveryResolution;
    if (source) {
        // Unlike descriptive observation metadata, this reference authorizes a
        // later action resolution. A known source that omits or corrupts it
        // revokes any previously retained reference.
        const messageActionReference = MessageActionReferenceV1Schema.safeParse(source.messageActionReference);
        if (messageActionReference.success) {
            target.messageActionReference = messageActionReference.data;
        } else {
            delete target.messageActionReference;
        }
    }
}

export function isRecoveredHistoryTranscriptObservation(
    message: Readonly<Pick<TranscriptObservationMetadata, 'transcriptObservationProvenance'>> | null | undefined,
): boolean {
    return isRecoveredHistoryTranscriptObservationProvenance(
        message?.transcriptObservationProvenance,
    );
}

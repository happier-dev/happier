import { isRecoveredHistoryTranscriptObservationProvenance } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { MessageActionReferenceV1Schema } from '@happier-dev/protocol/sessions/messages/messageActionReferenceV1';
import { FollowDeliveryProjectionV1Schema, type FollowDeliveryProjectionV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowDeliveryProjectionV1';
import type { MessageActionReferenceV1, SessionMessageDeliveryResolutionV1, SessionTranscriptObservationProvenanceV1 } from '@happier-dev/protocol';
import type { SessionMessageToolOutputAvailability } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import type { TranscriptAccountActorMetadata } from "./transcriptAccountActor.js";

/** Server row presentation metadata, independent of decrypted transcript content. */
export type TranscriptMessageMetadataUpdate = Readonly<{
    id: string;
    localId: string | null;
    seq?: number;
}> & TranscriptObservationMetadata & TranscriptAccountActorMetadata;

export type TranscriptObservationMetadata = {
    toolOutputAvailability?: SessionMessageToolOutputAvailability;
    sourceCreatedAt?: number;
    sourceUpdatedAt?: number;
    transcriptObservationProvenance?: SessionTranscriptObservationProvenanceV1;
    deliveryResolution?: SessionMessageDeliveryResolutionV1;
    followDeliveryProjection?: FollowDeliveryProjectionV1;
    /** Opaque server-issued identity; runtime resolves its current action state. */
    messageActionReference?: MessageActionReferenceV1;
};

export function applyTranscriptObservationMetadata(
    target: TranscriptObservationMetadata,
    source: Readonly<TranscriptObservationMetadata> | null | undefined,
): void {
    if (source?.toolOutputAvailability !== undefined) target.toolOutputAvailability = source.toolOutputAvailability;
    if (source?.sourceCreatedAt !== undefined) target.sourceCreatedAt = source.sourceCreatedAt;
    if (source?.sourceUpdatedAt !== undefined) target.sourceUpdatedAt = source.sourceUpdatedAt;
    if (source?.transcriptObservationProvenance !== undefined) {
        target.transcriptObservationProvenance = source.transcriptObservationProvenance;
    }
    if (source?.deliveryResolution !== undefined) target.deliveryResolution = source.deliveryResolution;
    if (source) {
        const projection = FollowDeliveryProjectionV1Schema.safeParse(source.followDeliveryProjection);
        if (projection.success) target.followDeliveryProjection = projection.data;
        else delete target.followDeliveryProjection;
    }
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

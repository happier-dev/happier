import { SESSION_METADATA_LAYOUT_VERSION_V1, SessionSharedMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionActionConfirmationsV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionActionConfirmationsV1';

export function readSharedMetadataPresentationCompletedRequests(
    metadata: unknown,
    metadataLayoutVersion: unknown,
): Record<string, unknown> | null {
    if (metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1) {
        return null;
    }
    const sharedMetadata = SessionSharedMetadataV1Schema.safeParse(metadata);
    if (!sharedMetadata.success) return null;
    const completedRequests = {
        ...(sharedMetadata.data.publicAgentState?.completedRequests ?? {}),
        ...(sharedMetadata.data.actionConfirmationsV1?.completedRequests ?? {}),
    };
    return Object.keys(completedRequests).length > 0 ? completedRequests : null;
}

export function readSharedMetadataActionConfirmationState(
    metadata: unknown,
    metadataLayoutVersion: unknown,
) {
    if (metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1) return null;
    const sharedMetadata = SessionSharedMetadataV1Schema.safeParse(metadata);
    if (sharedMetadata.success) return sharedMetadata.data.actionConfirmationsV1 ?? null;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const actionState = SessionActionConfirmationsV1Schema.safeParse(
        (metadata as Record<string, unknown>).actionConfirmationsV1,
    );
    return actionState.success ? actionState.data : null;
}

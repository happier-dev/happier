import {
    SESSION_METADATA_LAYOUT_VERSION_V1,
    SessionSharedMetadataV1Schema,
} from '@happier-dev/protocol';

import type { Session } from '@/sync/domains/state/storageTypes';

type PresentationSession = Pick<
    Session,
    'accessLevel' | 'agentState' | 'metadata' | 'metadataLayoutVersion'
>;

export function readSharedMetadataPresentationCompletedRequests(
    metadata: unknown,
    metadataLayoutVersion: unknown,
): Record<string, unknown> | null {
    if (metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1) {
        return null;
    }
    const sharedMetadata = SessionSharedMetadataV1Schema.safeParse(metadata);
    return sharedMetadata.success
        ? sharedMetadata.data.publicAgentState?.completedRequests ?? null
        : null;
}

/**
 * Completion facts used only to render transcript request state.
 *
 * Owners retain the canonical full AgentState. Shared recipients never gain
 * that authority: they may consume only the bounded, strict public projection
 * carried by layout-v1 shared metadata.
 */
export function readSessionPresentationCompletedRequests(
    session: PresentationSession,
): Record<string, unknown> | null {
    const isSharedRecipient =
        session.accessLevel === 'view'
        || session.accessLevel === 'edit'
        || session.accessLevel === 'admin';
    if (!isSharedRecipient) {
        return (session.agentState?.completedRequests as Record<string, unknown> | null | undefined) ?? null;
    }
    return readSharedMetadataPresentationCompletedRequests(
        session.metadata,
        session.metadataLayoutVersion,
    );
}

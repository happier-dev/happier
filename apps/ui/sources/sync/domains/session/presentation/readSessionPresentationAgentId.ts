import {
    resolveAgentIdFromSessionMetadata,
} from '@happier-dev/agents';
import {
    SESSION_METADATA_LAYOUT_VERSION_V1,
    SessionSharedMetadataV1Schema,
} from '@happier-dev/protocol';

import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

type SessionPresentationAgentIdInput = Readonly<{
    metadataLayoutVersion?: number;
    metadata?: unknown;
    ownerMetadataView?: unknown;
    accessLevel?: unknown;
}>;

export function readSessionPresentationAgentId(
    session: SessionPresentationAgentIdInput,
): string | null {
    const metadataLayoutVersion = session.metadataLayoutVersion ?? 0;
    if (metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1) {
        const sharedMetadata = SessionSharedMetadataV1Schema.safeParse(session.metadata);
        const sharedAgentId = sharedMetadata.success
            ? sharedMetadata.data.agentPresentation?.agentId
            : null;
        return sharedAgentId ?? null;
    }
    if (metadataLayoutVersion !== 0) {
        return null;
    }
    return resolveAgentIdFromSessionMetadata(readSessionOwnerMetadataView({
        metadataLayoutVersion,
        metadata: session.metadata ?? null,
        ownerMetadataView: session.ownerMetadataView,
    }));
}

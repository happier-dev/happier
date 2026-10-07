import {
    resolveAgentIdFromSessionMetadata,
} from '@happier-dev/agents';
import {
    SESSION_METADATA_LAYOUT_VERSION_V1,
    SessionSharedMetadataV1Schema,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';

type SessionPresentationAgentIdInput = Readonly<{
    metadataLayoutVersion?: number;
    metadata?: unknown;
    ownerMetadataView?: unknown;
    accessLevel?: unknown;
}>;

export function readSessionPresentationAgentId(
    session: SessionPresentationAgentIdInput,
): string | null {
    const metadataLayoutVersion = readSessionMetadataLayoutVersion(session.metadataLayoutVersion);
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
    // Legacy Agent identity is Session-readable even when the producer withholds a full owner view.
    return resolveAgentIdFromSessionMetadata(session.metadata ?? null);
}

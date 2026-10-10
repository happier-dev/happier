import { StoredSessionSharedMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { readSessionOwnerMetadataView } from './readSessionOwnerMetadataView';
import { isSessionAccessOwner, isSessionAccessRecipient, type NormalizedSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';
import {
    readBlockedSessionContentAvailability,
    readSessionContentAvailability,
    type SessionContentAvailability,
} from './encryptedContentAvailability';

type SessionRouteDataCandidate = Readonly<{
    metadataLayoutVersion?: number;
    metadataProjection?: 'sessionOnly';
    metadata?: unknown;
    ownerMetadataView?: unknown;
    accessLevel?: unknown;
    access?: NormalizedSessionAccessProjection | null;
    encryptionMode?: 'e2ee' | 'plain' | null;
    encryptedContentAvailability?: SessionContentAvailability | null;
}> | null | undefined;

/**
 * Returns whether a stored Session has the owner-authoritative metadata needed
 * by route consumers. Layout-1 owner list rows intentionally omit the owner
 * view and require exact-session hydration. An exact scoped producer may establish a
 * session-only projection without claiming the full owner view. Shared participants, identified by
 * their access level, are authoritative from the normalized stored shared projection and
 * must never be made to request owner data.
 */
export function hasAuthoritativeSessionRouteData(
    session: SessionRouteDataCandidate,
    options?: Readonly<{ hasSessionEncryption: boolean }>,
): boolean {
    if (!session) return false;
    const metadataLayoutVersion = readSessionMetadataLayoutVersion(session.metadataLayoutVersion);
    if (metadataLayoutVersion !== 0 && metadataLayoutVersion !== 1) return false;
    // A settled locked answer is authoritative on its own; an unsettled one still needs hydration.
    if (readBlockedSessionContentAvailability(readSessionContentAvailability(session)) !== null) return true;
    if (options && session.encryptionMode !== 'plain' && !options.hasSessionEncryption) return false;
    if (metadataLayoutVersion === 0) {
        return session.metadata != null;
    }
    if (metadataLayoutVersion !== 1) {
        return false;
    }
    if (session.metadataProjection === 'sessionOnly') {
        return session.access?.capabilities.readTranscript === true
            && StoredSessionSharedMetadataV1Schema.safeParse(session.metadata).success;
    }
    if (isSessionAccessRecipient(session.access, session.accessLevel)) {
        return StoredSessionSharedMetadataV1Schema.safeParse(session.metadata).success;
    }
    if (!isSessionAccessOwner(session.access, session.accessLevel)) {
        return false;
    }
    return readSessionOwnerMetadataView({
        metadataLayoutVersion,
        metadata: session.metadata ?? null,
        ownerMetadataView: session.ownerMetadataView,
    }) != null;
}

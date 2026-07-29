import { SessionSharedMetadataV1Schema } from '@happier-dev/protocol';

import { readSessionOwnerMetadataView } from './readSessionOwnerMetadataView';

type SessionRouteDataCandidate = Readonly<{
    metadataLayoutVersion?: number;
    metadata?: unknown;
    ownerMetadataView?: unknown;
    accessLevel?: unknown;
}> | null | undefined;

/**
 * Returns whether a stored Session has the owner-authoritative metadata needed
 * by route consumers. Layout-1 owner list rows intentionally omit the owner
 * view and require exact-session hydration. Shared participants, identified by
 * their access level, are authoritative from the strict shared projection and
 * must never be made to request owner data.
 */
export function hasAuthoritativeSessionRouteData(
    session: SessionRouteDataCandidate,
): boolean {
    if (!session) return false;
    const metadataLayoutVersion = session.metadataLayoutVersion ?? 0;
    if (metadataLayoutVersion === 0) {
        return session.metadata != null;
    }
    if (metadataLayoutVersion !== 1) {
        return false;
    }
    if (
        session.accessLevel === 'view'
        || session.accessLevel === 'edit'
        || session.accessLevel === 'admin'
    ) {
        return SessionSharedMetadataV1Schema.safeParse(session.metadata).success;
    }
    if (session.accessLevel != null) {
        return false;
    }
    return readSessionOwnerMetadataView({
        metadataLayoutVersion,
        metadata: session.metadata ?? null,
        ownerMetadataView: session.ownerMetadataView,
    }) != null;
}

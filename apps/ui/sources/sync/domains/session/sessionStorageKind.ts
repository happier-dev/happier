import { resolveLinkedExternalSessionAuthorityV1 } from '@happier-dev/protocol';

import type { Session } from '@/sync/domains/state/storageTypes';
import { resolveSessionOwnerMetadataViewRead } from './readSessionOwnerMetadataView';

export type SessionStorageKind = 'persisted' | 'direct';
export type SessionListStorageFilter = SessionStorageKind | 'all';

type SessionStorageMetadataShape = {
    metadata?: unknown;
    metadataLayoutVersion?: number;
    ownerMetadataView?: unknown;
};

type SessionStorageInput =
    | Pick<Session, 'metadata' | 'metadataLayoutVersion' | 'ownerMetadataView'>
    | SessionStorageMetadataShape
    | null
    | undefined;

export type SessionStorageAuthority =
    | Readonly<{ ok: true; storageKind: SessionStorageKind }>
    | Readonly<{
        ok: false;
        errorCode:
            | 'session_owner_metadata_unavailable'
            | 'linked_session_invalid'
            | 'linked_session_reconciliation_required';
    }>;

/**
 * Transcript-storage authority for one Session, for the client paths that stamp
 * an EFFECT with it rather than render it.
 *
 * `persisted` is a POSITIVE fact: this device read the owner view and it proves
 * no link was ever written. Three other answers exist and none of them is
 * `persisted` — an owner projection this device has not received, a link that
 * cannot be parsed, and dual rows only an explicit relink can settle. The
 * nullable read below flattens all four into `direct | persisted`, which is
 * correct for a list row and wrong for the handoff request that stops the
 * source and tells the target which storage to import into.
 */
export function resolveSessionStorageAuthority(
    session: SessionStorageInput,
): SessionStorageAuthority {
    if (!session) return { ok: false, errorCode: 'session_owner_metadata_unavailable' };
    const ownerMetadata = resolveSessionOwnerMetadataViewRead({
        metadata: session.metadata ?? null,
        metadataLayoutVersion: session.metadataLayoutVersion,
        ownerMetadataView: session.ownerMetadataView,
    });
    if (ownerMetadata.kind !== 'available') {
        return { ok: false, errorCode: 'session_owner_metadata_unavailable' };
    }
    const authority = resolveLinkedExternalSessionAuthorityV1(ownerMetadata.metadata);
    return authority.ok
        ? { ok: true, storageKind: authority.transcriptStorage }
        : { ok: false, errorCode: authority.error };
}

/**
 * Lenient projection for presentation: a list row, filter, or header must still
 * render for a Session whose owner view has not landed or whose link is
 * unusable. Never stamp an effect with this — use
 * {@link resolveSessionStorageAuthority}.
 */
export function getSessionStorageKind(session: SessionStorageInput): SessionStorageKind {
    const authority = resolveSessionStorageAuthority(session);
    return authority.ok ? authority.storageKind : 'persisted';
}

import { resolveLinkedExternalSessionAuthorityV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';

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

/**
 * Presentation projection: does this Session's transcript live with an external
 * Agent, or with us? A list row, filter, or header must still render for a
 * Session whose owner view has not landed or whose link cannot be resolved, so
 * every unreadable answer renders as `persisted`.
 *
 * This is the whole client-side contract. Transcript storage as an EFFECT —
 * which storage a handoff target imports into — is derived by the source daemon
 * from the owner metadata it loads itself; no client path stamps it, so there
 * is no second, stricter reader of this fact here.
 */
export function getSessionStorageKind(session: SessionStorageInput): SessionStorageKind {
    if (!session) return 'persisted';
    const ownerMetadata = resolveSessionOwnerMetadataViewRead({
        metadata: session.metadata ?? null,
        metadataLayoutVersion: session.metadataLayoutVersion,
        ownerMetadataView: session.ownerMetadataView,
    });
    if (ownerMetadata.kind !== 'available') return 'persisted';
    const authority = resolveLinkedExternalSessionAuthorityV1(ownerMetadata.metadata);
    return authority.ok ? authority.transcriptStorage : 'persisted';
}

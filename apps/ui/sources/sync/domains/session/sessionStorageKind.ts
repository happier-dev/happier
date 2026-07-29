import type { Session } from '@/sync/domains/state/storageTypes';
import { readExternalSessionLink } from './external/readExternalSessionLink';
import { readSessionOwnerMetadataView } from './readSessionOwnerMetadataView';

export type SessionStorageKind = 'persisted' | 'direct';
export type SessionListStorageFilter = SessionStorageKind | 'all';

type SessionStorageMetadataShape = {
    metadata?: unknown;
    metadataLayoutVersion?: number;
    ownerMetadataView?: unknown;
};

export function getSessionStorageKind(session: Pick<Session, 'metadata' | 'metadataLayoutVersion' | 'ownerMetadataView'> | SessionStorageMetadataShape | null | undefined): SessionStorageKind {
    if (!session) return 'persisted';
    return readExternalSessionLink(readSessionOwnerMetadataView({
        metadata: session.metadata ?? null,
        metadataLayoutVersion: session.metadataLayoutVersion,
        ownerMetadataView: session.ownerMetadataView,
    })) ? 'direct' : 'persisted';
}

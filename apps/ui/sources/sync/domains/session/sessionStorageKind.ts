import type { Session } from '@/sync/domains/state/storageTypes';

export type SessionStorageKind = 'persisted' | 'direct';
export type SessionListStorageFilter = SessionStorageKind | 'all';

type SessionStorageMetadataShape = {
    metadata?: {
        directSessionV1?: unknown;
    } | null;
};

function isDirectSessionMetadata(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const directSessionV1 = (value as { directSessionV1?: unknown }).directSessionV1;
    if (!directSessionV1 || typeof directSessionV1 !== 'object') return false;
    return (directSessionV1 as { v?: unknown }).v === 1;
}

export function getSessionStorageKind(session: Pick<Session, 'metadata'> | SessionStorageMetadataShape | null | undefined): SessionStorageKind {
    return isDirectSessionMetadata(session?.metadata) ? 'direct' : 'persisted';
}

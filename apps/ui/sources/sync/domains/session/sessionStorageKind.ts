import type { Session } from '@/sync/domains/state/storageTypes';

export type SessionStorageKind = 'persisted' | 'direct';
export type SessionListStorageFilter = SessionStorageKind | 'all';

type SessionStorageMetadataShape = {
    metadata?: {
        externalSessionV1?: unknown;
    } | null;
};

function isExternalSessionMetadata(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const externalSessionV1 = (value as { externalSessionV1?: unknown }).externalSessionV1;
    if (!externalSessionV1 || typeof externalSessionV1 !== 'object') return false;
    return (externalSessionV1 as { v?: unknown }).v === 1;
}

export function getSessionStorageKind(session: Pick<Session, 'metadata'> | SessionStorageMetadataShape | null | undefined): SessionStorageKind {
    return isExternalSessionMetadata(session?.metadata) ? 'direct' : 'persisted';
}

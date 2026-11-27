import type { Session } from '@/sync/domains/state/storageTypes';

export type SessionStorageKind = 'persisted' | 'direct';
export type SessionListStorageFilter = SessionStorageKind | 'persistedWithRetained' | 'all';

type SessionStorageMetadataShape = {
    cloudCopyLeftAt?: number | null;
    metadata?: {
        directTranscriptPendingV1?: unknown;
        directSessionV1?: unknown;
    } | null;
};

function isDirectSessionMetadata(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const { directTranscriptPendingV1, directSessionV1 } = value as NonNullable<SessionStorageMetadataShape['metadata']>;
    if (directTranscriptPendingV1 === true) return true;
    if (!directSessionV1 || typeof directSessionV1 !== 'object') return false;
    return (directSessionV1 as { v?: unknown }).v === 1;
}

export function getSessionStorageKind(session: Pick<Session, 'metadata' | 'cloudCopyLeftAt'> | SessionStorageMetadataShape | null | undefined): SessionStorageKind {
    return (session?.cloudCopyLeftAt != null || isDirectSessionMetadata(session?.metadata)) ? 'direct' : 'persisted';
}

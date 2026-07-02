import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';

export function buildSessionListRetentionKey(storageKind: SessionListStorageFilter | undefined): string {
    return `sessions-list:${storageKind ?? 'all'}`;
}

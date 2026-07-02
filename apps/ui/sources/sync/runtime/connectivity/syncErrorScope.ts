import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

type ServerScopedSyncError = Readonly<{
    serverId?: string | null;
}> | null | undefined;

export function selectSyncErrorForServer<T extends ServerScopedSyncError>(
    syncError: T,
    serverId: string | null | undefined,
): T | null {
    if (!syncError) {
        return null;
    }
    const syncErrorServerId = typeof syncError.serverId === 'string' ? syncError.serverId.trim() : '';
    if (!syncErrorServerId) {
        return syncError;
    }
    return areServerProfileIdentifiersEquivalent(syncErrorServerId, String(serverId ?? '').trim()) ? syncError : null;
}

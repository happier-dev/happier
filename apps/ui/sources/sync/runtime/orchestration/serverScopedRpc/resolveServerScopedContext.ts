import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

import type { ResolvedServerRpcContext, ScopedRpcEncryptionContext } from './serverScopedRpcTypes';

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

export async function resolveServerScopedContext(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    timeoutMs?: number;
}>): Promise<ResolvedServerRpcContext> {
    const machineId = normalizeId(params.machineId);
    const targetServerId = normalizeId(params.serverId);
    const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 30_000;
    const activeSnapshot = getActiveServerSnapshot();

    if (!targetServerId || targetServerId === normalizeId(activeSnapshot.serverId)) {
        return {
            scope: 'active',
            machineId,
            timeoutMs,
        };
    }

    const targetProfile = listServerProfiles().find((profile) => normalizeId(profile.id) === targetServerId) ?? null;
    if (!targetProfile) {
        throw new Error(`Target server profile not found for serverId "${targetServerId}"`);
    }

    const credentials = await TokenStorage.getCredentialsForServerUrl(targetProfile.serverUrl);
    if (!credentials) {
        throw new Error(`No authentication credentials for target server "${targetServerId}"`);
    }

    const encryption = await createEncryptionFromAuthCredentials(credentials) as ScopedRpcEncryptionContext;

    return {
        scope: 'scoped',
        machineId,
        timeoutMs,
        targetServerId,
        targetServerUrl: targetProfile.serverUrl,
        token: credentials.token,
        encryption,
    };
}

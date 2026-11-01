import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import {
    areServerProfileIdentifiersEquivalent,
    getServerProfileById,
    resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { parseToken } from '@/utils/auth/parseToken';

import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS, type ResolvedServerRpcContext, type ScopedRpcEncryptionContext } from './serverScopedRpcTypes';

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

export async function resolveServerScopedContext(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    accountId?: string | null;
    forceScoped?: boolean;
    timeoutMs?: number;
}>): Promise<ResolvedServerRpcContext> {
    const machineId = normalizeId(params.machineId);
    const targetServerId = normalizeId(params.serverId);
    const expectedAccountId = normalizeId(params.accountId);
    const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS;
    const activeSnapshot = getActiveServerSnapshot();
    const activeServerId = normalizeId(activeSnapshot.serverId);
    const shouldForceScoped = params.forceScoped === true || Boolean(expectedAccountId);

    if (!shouldForceScoped && (!targetServerId || areServerProfileIdentifiersEquivalent(targetServerId, activeServerId))) {
        return {
            scope: 'active',
            machineId,
            timeoutMs,
        };
    }

    const resolvedTargetServerId = resolveServerProfileScopeIdForIdentifier(targetServerId || activeServerId);
    const targetProfile = areServerProfileIdentifiersEquivalent(resolvedTargetServerId, activeServerId)
        ? {
            id: activeServerId,
            serverUrl: activeSnapshot.serverUrl,
            name: activeSnapshot.serverUrl,
        }
        : getServerProfileById(resolvedTargetServerId);
    if (!targetProfile) {
        throw new Error(`Target server profile not found for serverId "${resolvedTargetServerId}"`);
    }

    const credentials = await TokenStorage.getCredentialsForServerUrl(targetProfile.serverUrl, {
        serverId: resolvedTargetServerId,
    });
    if (!credentials) {
        throw new Error(`No authentication credentials for target server "${resolvedTargetServerId}"`);
    }

    if (expectedAccountId && parseToken(credentials.token) !== expectedAccountId) {
        throw new Error(`Scoped credentials do not match requested Account "${expectedAccountId}"`);
    }
    const encryption = await createEncryptionFromAuthCredentials(credentials) as ScopedRpcEncryptionContext;

    return {
        scope: 'scoped',
        machineId,
        timeoutMs,
        targetServerId: resolvedTargetServerId,
        targetServerUrl: targetProfile.serverUrl,
        token: credentials.token,
        encryption,
    };
}

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { resolveScopedAccountEncryption } from '@/sync/encryption/scopedAccountEncryption';
import {
    areServerProfileIdentifiersEquivalent,
    getServerProfileById,
    resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';
import {
    getAppliedActiveServerSnapshot,
    isAppliedActiveServerRuntimeAvailable,
} from '@/sync/runtime/orchestration/connectionManager';
import { parseToken } from '@/utils/auth/parseToken';
import { resolveServerScopedTransport } from './resolveServerScopedTransport';
import { createCapturedServerReadTransport } from './capturedServerReadTransport';
import { captureAccountEncryptionObservationForHome } from '@/sync/http/accountEncryptionObservationBinding';
import { readCredentialAuthorityKind } from '@/auth/context/credentialAuthority';

import {
    DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS,
    type ResolvedServerRpcContext,
    type ScopedServerRpcContext,
} from './serverScopedRpcTypes';

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
    const activeSnapshot = getAppliedActiveServerSnapshot();
    const activeServerId = normalizeId(activeSnapshot.serverId);
    const shouldForceScoped = params.forceScoped === true || Boolean(expectedAccountId);

    if (
        !shouldForceScoped
        && isAppliedActiveServerRuntimeAvailable()
        && (!targetServerId || areServerProfileIdentifiersEquivalent(targetServerId, activeServerId))
    ) {
        return {
            scope: 'active',
            machineId,
            timeoutMs,
        };
    }

    const resolvedTargetServerId = resolveServerProfileScopeIdForIdentifier(targetServerId || activeServerId);
    // During an incumbent-to-next Home transition the old applied snapshot is
    // still useful identity, but its singleton socket has already been torn
    // down. Preserve the profile's prepared carrier when the scoped fallback
    // reaches that incumbent directly (notably browser Iroh).
    const targetProfile = getServerProfileById(resolvedTargetServerId)
        ?? (areServerProfileIdentifiersEquivalent(resolvedTargetServerId, activeServerId)
            ? {
            id: activeServerId,
            serverUrl: activeSnapshot.serverUrl,
            canonicalServerUrl: activeSnapshot.serverUrl,
            name: activeSnapshot.serverUrl,
            }
            : null);
    if (!targetProfile) {
        throw new Error(`Target server profile not found for serverId "${resolvedTargetServerId}"`);
    }

    const credentials = await TokenStorage.getCredentialsForServerUrl(targetProfile.serverUrl, {
        serverId: resolvedTargetServerId,
    });
    if (!credentials) {
        throw new Error(`No authentication credentials for target server "${resolvedTargetServerId}"`);
    }

    const targetAccountId = parseToken(credentials.token);
    if (expectedAccountId && targetAccountId !== expectedAccountId) {
        throw new Error(`Scoped credentials do not match requested Account "${expectedAccountId}"`);
    }
    const encryption: ScopedServerRpcContext['encryption'] = await resolveScopedAccountEncryption({
        serverId: resolvedTargetServerId,
        serverUrl: targetProfile.canonicalServerUrl ?? targetProfile.serverUrl,
        credentials,
    });

    const transport = await resolveServerScopedTransport({
        profile: targetProfile,
        credentials,
    });
    const accountEncryptionObservation = readCredentialAuthorityKind(credentials.token) === 'api_token' ? undefined
        : captureAccountEncryptionObservationForHome({ serverId: resolvedTargetServerId,
            endpointUrl: transport.canonicalServerUrl, credentials });
    return {
        scope: 'scoped',
        machineId,
        timeoutMs,
        targetServerId: resolvedTargetServerId,
        targetServerUrl: transport.canonicalServerUrl,
        targetAccountId,
        runtimeOrigin: transport.runtimeOrigin,
        carrier: transport.carrier,
        ...(transport.homeCarrier ? { homeCarrier: transport.homeCarrier } : {}),
        release: transport.release,
        token: credentials.token,
        credentials,
        accountEncryptionObservation,
        readTransport: createCapturedServerReadTransport({ serverId: resolvedTargetServerId, profile: targetProfile, credentials, accountEncryptionObservation }),
        encryption,
    };
}

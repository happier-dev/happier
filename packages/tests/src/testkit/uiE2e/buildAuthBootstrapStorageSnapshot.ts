import { createHash } from 'node:crypto';

import type { TestAuth } from '../auth';
import {
    buildTestAccountCliAuthCredentials,
    type TestAccountCliAuthMode,
} from '../cliAuth';
import type { AuthBootstrapStorageSnapshot } from './readLegacyAuthSecretFromLocalStorage';
import {
    canonicalizeServerUrlForUiWeb,
    deriveUiServerIdFromUrl,
    scopedUiStorageId,
    uniqueNonEmptyStrings,
} from './uiWebStorageContract';

function sanitizeScopeToken(raw: string): string {
    const token = String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_').replace(/_+/g, '_');
    return token || 'default';
}

function hashScopeForNormalizedUrl(normalizedUrl: string): string | null {
    const normalized = String(normalizedUrl ?? '').trim();
    if (!normalized) return null;
    return createHash('sha256').update(normalized).digest('base64url');
}

function normalizeUrlLegacy(raw: string): string {
    return String(raw ?? '').trim().replace(/\/+$/, '');
}

function listCredentialScopeTokens(params: Readonly<{
    canonicalServerUrl: string;
    serverId: string;
    serverIdentityId?: string | null;
    legacyServerIds?: readonly string[];
}>): string[] {
    const tokens = new Set<string>();
    const appendId = (raw: string | null | undefined): void => {
        const value = String(raw ?? '').trim();
        if (!value) return;
        tokens.add(sanitizeScopeToken(value));
    };
    const appendHash = (raw: string | null | undefined): void => {
        const value = String(raw ?? '').trim();
        if (!value) return;
        const hash = hashScopeForNormalizedUrl(value);
        if (hash) tokens.add(hash);
    };

    appendId(params.serverIdentityId);
    appendId(params.serverId);
    for (const legacyServerId of params.legacyServerIds ?? []) {
        appendId(legacyServerId);
    }
    appendHash(params.canonicalServerUrl);

    try {
        const parsed = new URL(params.canonicalServerUrl);
        if (parsed.hostname.toLowerCase() === 'localhost') {
            parsed.hostname = '127.0.0.1';
            appendHash(normalizeUrlLegacy(parsed.toString()));
        }
    } catch {
        // ignore malformed compatibility URLs
    }

    return [...tokens];
}

function defaultServerNameFromUrl(serverUrl: string): string {
    try {
        const parsed = new URL(canonicalizeServerUrlForUiWeb(serverUrl));
        return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    } catch {
        return canonicalizeServerUrlForUiWeb(serverUrl) || String(serverUrl ?? '').trim();
    }
}

export function buildAuthBootstrapStorageSnapshot(params: Readonly<{
    serverUrl: string;
    auth: TestAuth;
    mode: TestAccountCliAuthMode;
    storageScope: string;
    serverIdentityId?: string | null;
    legacyServerIds?: readonly string[];
}>): AuthBootstrapStorageSnapshot {
    const now = Date.now();
    const canonicalServerUrl = canonicalizeServerUrlForUiWeb(params.serverUrl);
    const serverId = deriveUiServerIdFromUrl(canonicalServerUrl);
    const credentialPayload = JSON.stringify(buildTestAccountCliAuthCredentials({
        auth: params.auth,
        mode: params.mode,
    }));
    const legacyServerIds = uniqueNonEmptyStrings([
        ...(params.legacyServerIds ?? []),
        params.serverIdentityId ? serverId : null,
    ]);
    const serverState = JSON.stringify({
        activeServerId: serverId,
        servers: {
            [serverId]: {
                id: serverId,
                name: defaultServerNameFromUrl(canonicalServerUrl),
                serverUrl: canonicalServerUrl || params.serverUrl,
                ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
                ...(legacyServerIds.length > 0 ? { legacyServerIds } : {}),
                createdAt: now,
                updatedAt: now,
                lastUsedAt: now,
                source: 'manual',
            },
        },
    });

    const scoped = (key: string): string => scopedUiStorageId(key, params.storageScope);
    const scopedServerStateKey = `${scoped('server-profiles')}:server-state-v1`;
    const scopedAuthKey = scoped('auth_credentials');
    const credentialScopes = listCredentialScopeTokens({
        canonicalServerUrl,
        serverId,
        serverIdentityId: params.serverIdentityId,
        legacyServerIds,
    });
    const scopedAuthEntries: Record<string, string> = {};
    for (const scopeToken of credentialScopes) {
        const key = `auth_credentials__srv_${scopeToken}`;
        scopedAuthEntries[key] = credentialPayload;
        scopedAuthEntries[scoped(key)] = credentialPayload;
    }

    return {
        localStorage: {
            'server-profiles:server-state-v1': serverState,
            [scopedServerStateKey]: serverState,
            auth_credentials: credentialPayload,
            [scopedAuthKey]: credentialPayload,
            ...scopedAuthEntries,
        },
        sessionStorage: {
            activeServerId: serverId,
        },
    };
}

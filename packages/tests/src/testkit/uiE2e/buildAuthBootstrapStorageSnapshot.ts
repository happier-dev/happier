import type { AuthBootstrapStorageSnapshot } from './readLegacyAuthSecretFromLocalStorage';

export type AuthBootstrapCredentials =
    | Readonly<{
        token: string;
        secret: string;
    }>
    | Readonly<{
        token: string;
        encryption: Readonly<{
            publicKey: string;
            machineKey: string;
        }>;
    }>;

function canonicalizeServerUrlForUiWeb(rawServerUrl: string): string {
    const trimmed = String(rawServerUrl ?? '').trim().replace(/\/+$/, '');
    if (!trimmed) return '';

    try {
        const parsed = new URL(trimmed);
        const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
        const isLoopback =
            hostname === '127.0.0.1'
            || hostname === '::1'
            || hostname === '[::1]'
            || hostname === 'localhost'
            || hostname.endsWith('.localhost');

        const normalizedPath = parsed.pathname.replace(/\/+$/, '');
        const path = normalizedPath && normalizedPath !== '/' ? normalizedPath : '';
        const port = parsed.port ? `:${parsed.port}` : '';
        const auth = parsed.username
            ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
            : '';

        return `${parsed.protocol}//${auth}${isLoopback ? 'localhost' : hostname}${port}${path}${parsed.search}${parsed.hash}`
            .replace(/\/+$/, '');
    } catch {
        return trimmed;
    }
}

function deriveServerIdFromUrl(serverUrl: string): string {
    let hostname = '';
    let port = '';

    try {
        const parsed = new URL(canonicalizeServerUrlForUiWeb(serverUrl));
        hostname = parsed.hostname.toLowerCase();
        port = parsed.port ? `-${parsed.port}` : '';
    } catch {
        const normalized = canonicalizeServerUrlForUiWeb(serverUrl).toLowerCase();
        hostname = normalized.replace(/^[a-z]+:\/\//, '').replace(/\/+$/, '');
    }

    const base = `${hostname}${port}`.trim();
    const sanitized = base.replace(/[^a-z0-9._-]/g, '_').replace(/_+/g, '_');
    return sanitized || 'custom';
}

function scopedStorageId(baseId: string, scope: string | null): string {
    return scope ? `${baseId}__${scope}` : baseId;
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
    credentials: AuthBootstrapCredentials;
    storageScope: string;
}>): AuthBootstrapStorageSnapshot {
    const now = Date.now();
    const canonicalServerUrl = canonicalizeServerUrlForUiWeb(params.serverUrl);
    const serverId = deriveServerIdFromUrl(canonicalServerUrl);
    const credentialPayload = JSON.stringify(params.credentials);
    const serverState = JSON.stringify({
        activeServerId: serverId,
        servers: {
            [serverId]: {
                id: serverId,
                name: defaultServerNameFromUrl(canonicalServerUrl),
                serverUrl: canonicalServerUrl || params.serverUrl,
                createdAt: now,
                updatedAt: now,
                lastUsedAt: now,
                source: 'manual',
            },
        },
    });

    const scoped = (key: string): string => scopedStorageId(key, params.storageScope);
    const scopedServerStateKey = `${scoped('server-profiles')}:server-state-v1`;
    const scopedAuthKey = scoped('auth_credentials');
    const scopedServerAuthKey = scoped(`auth_credentials__srv_${serverId}`);

    return {
        localStorage: {
            'server-profiles:server-state-v1': serverState,
            [scopedServerStateKey]: serverState,
            auth_credentials: credentialPayload,
            [scopedAuthKey]: credentialPayload,
            [`auth_credentials__srv_${serverId}`]: credentialPayload,
            [scopedServerAuthKey]: credentialPayload,
        },
        sessionStorage: {
            activeServerId: serverId,
        },
    };
}

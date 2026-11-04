import axios from '@/api/client/credentialAxios';
import { randomUUID } from 'node:crypto';

import { buildCurrentSessionRunnerCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { createAuthenticationHttpStatusError, createHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

const ACCESS_KEY_BINDING_CACHE_TTL_MS = 30_000;
const MAX_ACCESS_KEY_BINDING_CACHE_ENTRIES = 2_048;

const accessKeyBindingInFlight = new Map<string, Promise<void>>();
const accessKeyBindingSuccessExpiresAt = new Map<string, number>();

function buildAccessKeyBindingCacheKey(params: Readonly<{
    serverUrl: string;
    sessionId: string;
    machineId: string;
}>): string {
    return `${params.serverUrl}\0${params.sessionId}\0${params.machineId}`;
}

function pruneAccessKeyBindingSuccessCache(now: number): void {
    for (const [key, expiresAt] of accessKeyBindingSuccessExpiresAt.entries()) {
        if (expiresAt <= now) accessKeyBindingSuccessExpiresAt.delete(key);
    }
    while (accessKeyBindingSuccessExpiresAt.size > MAX_ACCESS_KEY_BINDING_CACHE_ENTRIES) {
        const oldestKey = accessKeyBindingSuccessExpiresAt.keys().next().value as string | undefined;
        if (!oldestKey) return;
        accessKeyBindingSuccessExpiresAt.delete(oldestKey);
    }
}

export async function ensureSessionMachineAccessKeyBinding(params: Readonly<{
    serverUrl?: string;
    token: string;
    sessionId: string;
    machineId?: string;
    /** Host-private requester authorization; ordinary runners retain bearer auth. */
    authorizeRequest?: (request: Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown }>) => Readonly<Record<string, string>>;
}>): Promise<void> {
    if (!params.machineId) return;
    const serverUrl = params.serverUrl ?? resolveServerHttpBaseUrl();
    const cacheKey = buildAccessKeyBindingCacheKey({
        serverUrl,
        sessionId: params.sessionId,
        machineId: params.machineId,
    });
    const now = Date.now();
    const cachedSuccessExpiresAt = accessKeyBindingSuccessExpiresAt.get(cacheKey);
    if (typeof cachedSuccessExpiresAt === 'number' && cachedSuccessExpiresAt > now) return;
    if (typeof cachedSuccessExpiresAt === 'number') accessKeyBindingSuccessExpiresAt.delete(cacheKey);

    const existingInFlight = accessKeyBindingInFlight.get(cacheKey);
    if (existingInFlight) return await existingInFlight;

    const bindingPromise = ensureSessionMachineAccessKeyBindingUncached({ ...params, serverUrl, machineId: params.machineId })
        .then(() => {
            const completedAt = Date.now();
            accessKeyBindingSuccessExpiresAt.set(cacheKey, completedAt + ACCESS_KEY_BINDING_CACHE_TTL_MS);
            pruneAccessKeyBindingSuccessCache(completedAt);
        })
        .finally(() => {
            if (accessKeyBindingInFlight.get(cacheKey) === bindingPromise) accessKeyBindingInFlight.delete(cacheKey);
        });
    accessKeyBindingInFlight.set(cacheKey, bindingPromise);
    await bindingPromise;
}

async function ensureSessionMachineAccessKeyBindingUncached(params: Parameters<typeof ensureSessionMachineAccessKeyBinding>[0] & Readonly<{
    serverUrl: string;
    machineId: string;
}>): Promise<void> {
    const path = `/v1/access-keys/${encodeURIComponent(params.sessionId)}/${encodeURIComponent(params.machineId)}`;
    const requestConfig = (method: 'GET' | 'POST', body?: unknown) => ({
        headers: {
            'Content-Type': 'application/json',
            ...buildCurrentSessionRunnerCompatibilityHttpHeaders(),
            ...(params.authorizeRequest ? params.authorizeRequest({ method, path, ...(body !== undefined ? { body } : {}) })
                : { Authorization: `Bearer ${params.token}` }),
        },
        timeout: configuration.sessionControlHttpTimeoutMs,
        validateStatus: () => true,
    });
    const accessKeyUrl = `${params.serverUrl}${path}`;
    const existing = await axios.get(accessKeyUrl, requestConfig('GET'));
    if (existing.status === 200 && existing.data?.accessKey) return;
    if (isAuthenticationStatus(existing.status)) {
        throw createAuthenticationHttpStatusError(existing.status, 'Authentication failed while binding session machine control');
    }
    if (existing.status !== 200) throw createHttpStatusError(existing.status, 'Session machine access-key lookup failed');

    const body = {
        data: `session-machine-control:${randomUUID()}`,
    };
    const created = await axios.post(accessKeyUrl, body, requestConfig('POST', body));
    if (isAuthenticationStatus(created.status)) {
        throw createAuthenticationHttpStatusError(created.status, 'Authentication failed while binding session machine control');
    }
    if (created.status === 200 || created.status === 409) return;
    throw createHttpStatusError(created.status, 'Session machine access-key binding failed');
}

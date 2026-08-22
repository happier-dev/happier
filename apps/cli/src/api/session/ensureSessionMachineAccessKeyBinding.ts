import axios from 'axios';
import { randomUUID } from 'node:crypto';

import { buildCurrentSessionRunnerCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { createAuthenticationHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';

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
    serverUrl: string;
    token: string;
    sessionId: string;
    machineId?: string;
}>): Promise<void> {
    if (!params.machineId) return;
    const cacheKey = buildAccessKeyBindingCacheKey({
        serverUrl: params.serverUrl,
        sessionId: params.sessionId,
        machineId: params.machineId,
    });
    const now = Date.now();
    const cachedSuccessExpiresAt = accessKeyBindingSuccessExpiresAt.get(cacheKey);
    if (typeof cachedSuccessExpiresAt === 'number' && cachedSuccessExpiresAt > now) return;
    if (typeof cachedSuccessExpiresAt === 'number') accessKeyBindingSuccessExpiresAt.delete(cacheKey);

    const existingInFlight = accessKeyBindingInFlight.get(cacheKey);
    if (existingInFlight) return await existingInFlight;

    const bindingPromise = ensureSessionMachineAccessKeyBindingUncached({ ...params, machineId: params.machineId })
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

async function ensureSessionMachineAccessKeyBindingUncached(params: Readonly<{
    serverUrl: string;
    token: string;
    sessionId: string;
    machineId: string;
}>): Promise<void> {
    const requestConfig = {
        headers: {
            Authorization: `Bearer ${params.token}`,
            'Content-Type': 'application/json',
            ...buildCurrentSessionRunnerCompatibilityHttpHeaders(),
        },
        timeout: configuration.sessionControlHttpTimeoutMs,
        validateStatus: () => true,
    };
    const accessKeyUrl = `${params.serverUrl}/v1/access-keys/${encodeURIComponent(params.sessionId)}/${encodeURIComponent(params.machineId)}`;
    const existing = await axios.get(accessKeyUrl, requestConfig);
    if (existing.status === 200 && existing.data?.accessKey) return;
    if (isAuthenticationStatus(existing.status)) {
        throw createAuthenticationHttpStatusError(existing.status, 'Authentication failed while binding session machine control');
    }
    if (existing.status !== 200) throw new Error(`Unexpected status from ${accessKeyUrl}: ${existing.status}`);

    const created = await axios.post(accessKeyUrl, {
        data: `session-machine-control:${randomUUID()}`,
    }, requestConfig);
    if (isAuthenticationStatus(created.status)) {
        throw createAuthenticationHttpStatusError(created.status, 'Authentication failed while binding session machine control');
    }
    if (created.status === 200 || created.status === 409) return;
    throw new Error(`Unexpected status from ${accessKeyUrl}: ${created.status}`);
}

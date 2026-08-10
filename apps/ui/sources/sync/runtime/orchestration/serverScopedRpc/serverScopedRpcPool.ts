import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import {
    createNotAuthenticatedError,
    isAuthenticationResponseStatus,
    isTerminalAuthError,
} from '@/sync/runtime/connectivity/authErrors';

import { createScopedCacheTokenKeyRegistry } from './scopedCacheTokenKey';
import { createScopedResolutionSingleFlight } from './scopedResolutionSingleFlight';

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function toMachineDataKeyCacheKey(serverId: string, machineId: string, token: string): string {
    const tokenKey = machineTokenKeys.getOrCreate(token, readMaxMachineKeyCacheEntriesFromEnv());
    return `${serverId}::${machineId}::${tokenKey}`;
}

const machineDataKeyCache = new Map<string, Uint8Array | null>();
const machineDataKeyResolutions = createScopedResolutionSingleFlight<Uint8Array | null>();
const machineTokenKeys = createScopedCacheTokenKeyRegistry();

function readMaxMachineKeyCacheEntriesFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_MACHINE_KEY_CACHE_MAX ?? '').trim();
    if (!raw) return 256;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 256;
    return Math.max(1, Math.min(10_000, parsed));
}

function getMachineDataKeyFromCache(cacheKey: string): Uint8Array | null | undefined {
    const existing = machineDataKeyCache.get(cacheKey);
    if (existing === undefined) return undefined;
    // Refresh LRU ordering.
    machineDataKeyCache.delete(cacheKey);
    machineDataKeyCache.set(cacheKey, existing);
    return existing;
}

function setMachineDataKeyCache(cacheKey: string, value: Uint8Array | null): void {
    machineDataKeyCache.set(cacheKey, value);

    const max = readMaxMachineKeyCacheEntriesFromEnv();
    while (machineDataKeyCache.size > max) {
        const oldest = machineDataKeyCache.keys().next();
        if (oldest.done) break;
        machineDataKeyCache.delete(oldest.value);
    }
}

async function fetchMachineDataKey(params: Readonly<{
    serverUrl: string;
    token: string;
    machineId: string;
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    timeoutMs: number;
}>): Promise<Uint8Array | null> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller
        ? setTimeout(() => controller.abort(), Math.max(1, params.timeoutMs))
        : null;

    try {
        const response = await runtimeFetchWithServerReachability({
            serverUrl: params.serverUrl,
            token: params.token,
            url: `${params.serverUrl}/v1/machines`,
            init: {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${params.token}`,
                    'Content-Type': 'application/json',
                },
                ...(controller ? { signal: controller.signal } : {}),
            },
            timeoutMs: params.timeoutMs,
        });
        if (!response.ok) {
            if (isAuthenticationResponseStatus(response.status)) {
                throw createNotAuthenticatedError();
            }
            return null;
        }

        const machines = await response.json() as Array<{
            id: string;
            dataEncryptionKey?: string | null;
        }>;
        const machine = machines.find((item) => normalizeId(item.id) === params.machineId);
        if (!machine?.dataEncryptionKey) return null;

        return await params.decryptEncryptionKey(machine.dataEncryptionKey);
    } catch (error) {
        if (isTerminalAuthError(error)) {
            throw error;
        }
        return null;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

export async function resolveScopedMachineDataKey(params: Readonly<{
    serverId: string;
    serverUrl: string;
    token: string;
    machineId: string;
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    timeoutMs?: number;
}>): Promise<Uint8Array | null> {
    const machineId = normalizeId(params.machineId);
    const serverId = normalizeId(params.serverId);
    const token = String(params.token ?? '');
    const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 30_000;
    const keyCacheKey = toMachineDataKeyCacheKey(serverId, machineId, token);

    const cached = getMachineDataKeyFromCache(keyCacheKey);
    if (cached !== undefined) {
        return cached ?? null;
    }

    // Coalesce the burst. `keyCacheKey` covers the target server, the machine and the
    // bearer token, and the token determines the credentials the caller's
    // `decryptEncryptionKey` was built from — so joiners of one resolution always share
    // the caller inputs that decide the plaintext, and never adopt another machine's,
    // another server's or another account's key.
    const machineDataKey = await machineDataKeyResolutions.run(keyCacheKey, async () => {
        const resolved = await fetchMachineDataKey({
            serverUrl: params.serverUrl,
            token,
            machineId,
            decryptEncryptionKey: params.decryptEncryptionKey,
            timeoutMs,
        });
        // A missing key stays uncached so the next caller retries it for real.
        if (resolved) {
            setMachineDataKeyCache(keyCacheKey, resolved);
        }
        return resolved;
    });
    return machineDataKey ?? null;
}

export function resetScopedMachineDataKeyCacheForTests(): void {
    machineDataKeyCache.clear();
    machineDataKeyResolutions.reset();
    machineTokenKeys.reset();
}

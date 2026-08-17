import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import {
    createNotAuthenticatedError,
    isAuthenticationResponseStatus,
    isTerminalAuthError,
} from '@/sync/runtime/connectivity/authErrors';
import { isPlainMachineDataKeyMarker } from '@happier-dev/protocol';

import { getOrCreateScopedCacheTokenKey, resetScopedCacheTokenKeysForTests } from './scopedCacheTokenKey';
import { createScopedResolutionSingleFlight } from './scopedResolutionSingleFlight';

export type ScopedMachineTransport =
    | Readonly<{ mode: 'plain' }>
    | Readonly<{ mode: 'e2ee'; dataKey: Uint8Array | null }>;

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function toMachineTransportCacheKey(serverId: string, machineId: string, token: string): string {
    const tokenKey = getOrCreateScopedCacheTokenKey(token, readMaxMachineKeyCacheEntriesFromEnv());
    return `${serverId}::${machineId}::${tokenKey}`;
}

const machineTransportCache = new Map<string, ScopedMachineTransport>();
const machineTransportResolutions = createScopedResolutionSingleFlight<ScopedMachineTransport | null>();

function readMaxMachineKeyCacheEntriesFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_MACHINE_KEY_CACHE_MAX ?? '').trim();
    if (!raw) return 256;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 256;
    return Math.max(1, Math.min(10_000, parsed));
}

function getMachineTransportFromCache(cacheKey: string): ScopedMachineTransport | undefined {
    const existing = machineTransportCache.get(cacheKey);
    if (existing === undefined) return undefined;
    // Refresh LRU ordering.
    machineTransportCache.delete(cacheKey);
    machineTransportCache.set(cacheKey, existing);
    return existing;
}

function setMachineTransportCache(cacheKey: string, value: ScopedMachineTransport): void {
    machineTransportCache.set(cacheKey, value);

    const max = readMaxMachineKeyCacheEntriesFromEnv();
    while (machineTransportCache.size > max) {
        const oldest = machineTransportCache.keys().next();
        if (oldest.done) break;
        machineTransportCache.delete(oldest.value);
    }
}

async function fetchMachineTransport(params: Readonly<{
    serverUrl: string;
    token: string;
    machineId: string;
    decryptEncryptionKey?: (value: string) => Promise<Uint8Array | null>;
    timeoutMs: number;
}>): Promise<ScopedMachineTransport | null> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller
        ? setTimeout(() => controller.abort(), Math.max(1, params.timeoutMs))
        : null;

    try {
        const response = await runtimeFetchWithServerReachability({
            serverUrl: params.serverUrl,
            token: params.token,
            url: `${params.serverUrl}/v1/machines/${encodeURIComponent(params.machineId)}`,
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
                throw createNotAuthenticatedError(response.status);
            }
            return null;
        }

        const body = await response.json() as {
            machine?: {
                id?: unknown;
                dataEncryptionKey?: unknown;
            };
        };
        const machine = body?.machine;
        if (normalizeId(machine?.id) !== params.machineId) {
            return null;
        }
        if (!machine?.dataEncryptionKey) {
            return null;
        }
        if (
            typeof machine.dataEncryptionKey === 'string'
            && isPlainMachineDataKeyMarker(machine.dataEncryptionKey)
        ) {
            return { mode: 'plain' };
        }
        if (typeof machine.dataEncryptionKey !== 'string') return null;
        if (!params.decryptEncryptionKey) return null;

        const dataKey = await params.decryptEncryptionKey(machine.dataEncryptionKey);
        return dataKey ? { mode: 'e2ee', dataKey } : null;
    } catch (error) {
        if (isTerminalAuthError(error)) {
            throw error;
        }
        return null;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

export async function resolveScopedMachineTransport(params: Readonly<{
    serverId: string;
    serverUrl: string;
    token: string;
    machineId: string;
    decryptEncryptionKey?: (value: string) => Promise<Uint8Array | null>;
    timeoutMs?: number;
}>): Promise<ScopedMachineTransport | null> {
    const machineId = normalizeId(params.machineId);
    const serverId = normalizeId(params.serverId);
    const token = String(params.token ?? '');
    const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 30_000;
    const keyCacheKey = toMachineTransportCacheKey(serverId, machineId, token);

    const cached = getMachineTransportFromCache(keyCacheKey);
    if (cached !== undefined) {
        return cached;
    }

    // Coalesce the burst. The cache is read-await-write, so without this every concurrent
    // caller misses and repeats the whole machine lookup plus its asymmetric envelope
    // open; the new-session screen's capability preflights fan out ~8-10 of those against
    // one machine at once. `keyCacheKey` covers the target server, the machine and the
    // bearer token, and the token determines the credentials the caller's
    // `decryptEncryptionKey` was built from — so a joiner can only ever adopt a result
    // computed from its own inputs.
    const transport = await machineTransportResolutions.run(keyCacheKey, async () => {
        const resolved = await fetchMachineTransport({
            serverUrl: params.serverUrl,
            token,
            machineId,
            decryptEncryptionKey: params.decryptEncryptionKey,
            timeoutMs,
        });
        if (resolved && (resolved.mode === 'plain' || resolved.dataKey)) {
            setMachineTransportCache(keyCacheKey, resolved);
        }
        return resolved;
    });
    return transport ?? null;
}

export function resetScopedMachineTransportCacheForTests(): void {
    machineTransportCache.clear();
    machineTransportResolutions.reset();
    resetScopedCacheTokenKeysForTests();
}

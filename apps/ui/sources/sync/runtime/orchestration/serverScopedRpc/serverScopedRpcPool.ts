import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import {
    createNotAuthenticatedError,
    isAuthenticationResponseStatus,
    isTerminalAuthError,
} from '@/sync/runtime/connectivity/authErrors';

import { createScopedCacheTokenKeyRegistry } from './scopedCacheTokenKey';
import { createScopedResolutionSingleFlight } from './scopedResolutionSingleFlight';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from './serverScopedRpcTypes';
import { createRpcCallError, readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { t } from '@/text';
import { AccountEncryptionModeResponseSchema, isPlainMachineDataKeyMarker } from '@happier-dev/protocol';

type ScopedMachineEncryptionContext =
    | Readonly<{ mode: 'plain' }>
    | Readonly<{ mode: 'encrypted'; dataKey: Uint8Array | null }>;

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function toMachineDataKeyCacheKey(serverId: string, machineId: string, token: string): string {
    const tokenKey = machineTokenKeys.getOrCreate(token, readMaxMachineKeyCacheEntriesFromEnv());
    return `${serverId}::${machineId}::${tokenKey}`;
}

type MachineDataKeyCacheEntry = Readonly<{ envelope: string; dataKey: Uint8Array }>;
const machineDataKeyCache = new Map<string, MachineDataKeyCacheEntry>();
const machineDataKeyResolutions = createScopedResolutionSingleFlight<ScopedMachineEncryptionContext>();
const machineTokenKeys = createScopedCacheTokenKeyRegistry();

function readMaxMachineKeyCacheEntriesFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_MACHINE_KEY_CACHE_MAX ?? '').trim();
    if (!raw) return 256;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 256;
    return Math.max(1, Math.min(10_000, parsed));
}

function getMachineDataKeyFromCache(cacheKey: string): MachineDataKeyCacheEntry | undefined {
    const existing = machineDataKeyCache.get(cacheKey);
    if (existing === undefined) return undefined;
    // Refresh LRU ordering.
    machineDataKeyCache.delete(cacheKey);
    machineDataKeyCache.set(cacheKey, existing);
    return existing;
}

function setMachineDataKeyCache(cacheKey: string, value: MachineDataKeyCacheEntry): void {
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
    keyCacheKey: string;
}>): Promise<ScopedMachineEncryptionContext> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller
        ? setTimeout(() => controller.abort(), Math.max(1, params.timeoutMs))
        : null;

    try {
        const fetchResource = (path: string) => runtimeFetchWithServerReachability({
            serverUrl: params.serverUrl,
            token: params.token,
            url: `${params.serverUrl}${path}`,
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
        const response = await fetchResource('/v1/machines');
        if (!response.ok) {
            if (isAuthenticationResponseStatus(response.status)) {
                throw createNotAuthenticatedError();
            }
            throw createRpcCallError({ error: t('errors.machineRpcContextUnavailable'), errorCode: 'machine_rpc_context_unavailable' });
        }

        const machines = await response.json() as Array<{
            id: string;
            dataEncryptionKey?: unknown;
        }>;
        const machine = machines.find((item) => normalizeId(item.id) === params.machineId);
        if (!machine) throw createRpcCallError({ error: t('errors.machineRpcContextUnavailable'), errorCode: 'machine_rpc_context_unavailable' });
        if (typeof machine.dataEncryptionKey === 'string' && isPlainMachineDataKeyMarker(machine.dataEncryptionKey)) {
            machineDataKeyCache.delete(params.keyCacheKey);
            const modeResponse = await fetchResource('/v1/account/encryption');
            if (isAuthenticationResponseStatus(modeResponse.status)) throw createNotAuthenticatedError();
            const parsed = modeResponse.ok
                ? AccountEncryptionModeResponseSchema.safeParse(await modeResponse.json())
                : null;
            if (!parsed?.success || parsed.data.mode !== 'plain') {
                throw createRpcCallError({ error: t('errors.machineRpcContextUnavailable'), errorCode: 'machine_rpc_context_unavailable' });
            }
            return { mode: 'plain' };
        }
        if (machine.dataEncryptionKey === null || machine.dataEncryptionKey === undefined) {
            machineDataKeyCache.delete(params.keyCacheKey);
            return { mode: 'encrypted', dataKey: null };
        }
        if (typeof machine.dataEncryptionKey !== 'string' || machine.dataEncryptionKey.length === 0) {
            machineDataKeyCache.delete(params.keyCacheKey);
            throw createRpcCallError({ error: t('errors.machineRpcContextUnavailable'), errorCode: 'machine_rpc_context_unavailable' });
        }
        const cached = getMachineDataKeyFromCache(params.keyCacheKey);
        if (cached?.envelope === machine.dataEncryptionKey) return { mode: 'encrypted', dataKey: cached.dataKey };
        machineDataKeyCache.delete(params.keyCacheKey);
        const key = await params.decryptEncryptionKey(machine.dataEncryptionKey);
        if (!key) throw createRpcCallError({ error: t('errors.machineRpcDecryptionFailed'), errorCode: 'machine_rpc_decryption_failed' });
        setMachineDataKeyCache(params.keyCacheKey, { envelope: machine.dataEncryptionKey, dataKey: key });
        return { mode: 'encrypted', dataKey: key };
    } catch (error) {
        if (isTerminalAuthError(error) || readRpcErrorCode(error)) throw error;
        console.error('[scopedMachineRpc] Failed to resolve machine content', error);
        throw createRpcCallError({ error: t('errors.machineRpcContextUnavailable'), errorCode: 'machine_rpc_context_unavailable' });
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

export async function resolveScopedMachineEncryptionContext(params: Readonly<{
    serverId: string;
    serverUrl: string;
    token: string;
    machineId: string;
    decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
    timeoutMs?: number;
}>): Promise<ScopedMachineEncryptionContext> {
    const machineId = normalizeId(params.machineId);
    const serverId = normalizeId(params.serverId);
    const token = String(params.token ?? '');
    const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS;
    const keyCacheKey = toMachineDataKeyCacheKey(serverId, machineId, token);

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
            keyCacheKey,
        });
        // Every call revalidates the published envelope. Only its asymmetric open
        // is cached, so scoped calls observe conversions without an active socket.
        return resolved;
    });
    return machineDataKey;
}

export function resetScopedMachineDataKeyCacheForTests(): void {
    machineDataKeyCache.clear();
    machineDataKeyResolutions.reset();
    machineTokenKeys.reset();
}

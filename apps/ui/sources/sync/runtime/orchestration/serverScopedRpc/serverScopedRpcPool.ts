import { runtimeFetch } from '@/utils/system/runtimeFetch';

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function getOrCreateTokenCacheKey(token: string): string {
    // Avoid using the raw token in cache keys (accidental leaks in error/debug output),
    // but also avoid collision-prone hashing (which can cause cross-token cache reuse).
    let key = tokenCacheKeyByToken.get(token);
    if (key) return key;

    const cryptoAny = (globalThis as any).crypto as { randomUUID?: () => string } | undefined;
    key =
        typeof cryptoAny?.randomUUID === 'function'
            ? cryptoAny.randomUUID()
            : `tk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    tokenCacheKeyByToken.set(token, key);
    return key;
}

function toMachineDataKeyCacheKey(serverId: string, machineId: string, token: string): string {
    return `${serverId}::${machineId}::${getOrCreateTokenCacheKey(token)}`;
}

const machineDataKeyCache = new Map<string, Uint8Array | null>();
const tokenCacheKeyByToken = new Map<string, string>();

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
        const response = await runtimeFetch(`${params.serverUrl}/v1/machines`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${params.token}`,
                'Content-Type': 'application/json',
            },
            ...(controller ? { signal: controller.signal } : {}),
        });
        if (!response.ok) return null;

        const machines = await response.json() as Array<{
            id: string;
            dataEncryptionKey?: string | null;
        }>;
        const machine = machines.find((item) => normalizeId(item.id) === params.machineId);
        if (!machine?.dataEncryptionKey) return null;

        return await params.decryptEncryptionKey(machine.dataEncryptionKey);
    } catch {
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

    let machineDataKey = getMachineDataKeyFromCache(keyCacheKey);
    if (machineDataKey === undefined) {
        machineDataKey = await fetchMachineDataKey({
            serverUrl: params.serverUrl,
            token,
            machineId,
            decryptEncryptionKey: params.decryptEncryptionKey,
            timeoutMs,
        });
        setMachineDataKeyCache(keyCacheKey, machineDataKey ?? null);
    }
    return machineDataKey ?? null;
}

export function resetScopedMachineDataKeyCacheForTests(): void {
    machineDataKeyCache.clear();
    tokenCacheKeyByToken.clear();
}

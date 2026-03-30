import { normalizeAcpConfigOptionsArray, type AcpConfigOption } from '@/sync/acp/configOptionsControl';
import type { ProbedResourceSnapshot } from '@happier-dev/protocol';

import { createPersistentProbedResourceCache } from '@/sync/runtime/probedResources/createPersistentProbedResourceCache';

export type DynamicConfigOptionsProbeCacheEntry =
    | Readonly<{ kind: 'success'; updatedAt: number; expiresAt: number; value: readonly AcpConfigOption[] }>
    | Readonly<{ kind: 'error'; updatedAt: number; expiresAt: number }>;

export const DYNAMIC_CONFIG_OPTIONS_PROBE_SUCCESS_TTL_MS = 24 * 60 * 60_000;
export const DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS = 60_000;

const PERSIST_KEY = 'dynamic-config-options-probe-cache-v1';
const PERSIST_VERSION = 1;
const PERSIST_MAX_ENTRIES = 200;
const PERSIST_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

function normalizePersistedConfigOptions(input: unknown): readonly AcpConfigOption[] | null {
    if (Array.isArray(input) && input.length === 0) return [];
    const normalized = normalizeAcpConfigOptionsArray(input);
    return normalized ?? null;
}

const persistedCache = createPersistentProbedResourceCache<readonly AcpConfigOption[]>({
    cacheId: 'dynamic-config-options-probe-cache',
    persistKey: PERSIST_KEY,
    persistVersion: PERSIST_VERSION,
    persistMaxEntries: PERSIST_MAX_ENTRIES,
    persistMaxAgeMs: PERSIST_MAX_AGE_MS,
    staleTimeMs: DYNAMIC_CONFIG_OPTIONS_PROBE_SUCCESS_TTL_MS,
    errorCooldownMs: DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS,
    normalizePersistedValue: normalizePersistedConfigOptions,
    deleteOnPersistVersionMismatch: true,
});

export function resetDynamicConfigOptionsProbeCacheForTests(): void {
    persistedCache.resetForTests();
}

export function readDynamicConfigOptionsProbeCache(key: string): DynamicConfigOptionsProbeCacheEntry | null {
    const snap: ProbedResourceSnapshot<readonly AcpConfigOption[]> = persistedCache.getSnapshot(key);
    if (snap.dataUpdatedAt !== null && snap.data) {
        return {
            kind: 'success',
            updatedAt: snap.dataUpdatedAt,
            expiresAt: snap.dataUpdatedAt + DYNAMIC_CONFIG_OPTIONS_PROBE_SUCCESS_TTL_MS,
            value: snap.data,
        };
    }
    if (snap.errorUpdatedAt !== null) {
        return {
            kind: 'error',
            updatedAt: snap.errorUpdatedAt,
            expiresAt: snap.errorUpdatedAt + DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS,
        };
    }
    return null;
}

export function writeDynamicConfigOptionsProbeCacheSuccess(
    key: string,
    value: readonly AcpConfigOption[],
    nowMs = Date.now(),
): void {
    persistedCache.writeSuccess(key, value, nowMs);
}

export function writeDynamicConfigOptionsProbeCacheError(key: string, nowMs = Date.now()): void {
    persistedCache.writeError(key, new Error('dynamic-config-options-probe-failed'), nowMs);
}

export async function runDynamicConfigOptionsProbeDedupe<T>(
    key: string,
    run: () => Promise<T>,
): Promise<T> {
    return await persistedCache.runDedupe(key, run);
}

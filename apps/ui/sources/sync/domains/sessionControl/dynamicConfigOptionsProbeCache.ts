import { normalizeAcpConfigOptionsArray, type AcpConfigOption } from '@/sync/domains/sessionControl/configOptionsControl';
import type { ProbedResourceSnapshot } from '@happier-dev/protocol';

import { createPersistentProbedResourceCache } from '@/sync/runtime/probedResources/createPersistentProbedResourceCache';

export type DynamicConfigOptionsProbeCacheEntry =
    | Readonly<{
        kind: 'success';
        updatedAt: number;
        expiresAt: number;
        value: readonly AcpConfigOption[];
        unavailable?: boolean;
    }>
    | Readonly<{ kind: 'error'; updatedAt: number; expiresAt: number }>;

export const DYNAMIC_CONFIG_OPTIONS_PROBE_SUCCESS_TTL_MS = 24 * 60 * 60_000;
export const DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS = 60_000;

const PERSIST_KEY = 'dynamic-config-options-probe-cache-v1';
const PERSIST_VERSION = 1;
const PERSIST_MAX_ENTRIES = 200;
const PERSIST_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

const transientUnavailableByKey = new Map<string, Readonly<{
    updatedAt: number;
    expiresAt: number;
    value: readonly AcpConfigOption[];
}>>();

function normalizePersistedConfigOptions(input: unknown): readonly AcpConfigOption[] | null {
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
    transientUnavailableByKey.clear();
    persistedCache.resetForTests();
}

function readTransientUnavailable(key: string, nowMs = Date.now()): DynamicConfigOptionsProbeCacheEntry | null {
    const entry = transientUnavailableByKey.get(key) ?? null;
    if (!entry) return null;
    if (nowMs >= 0 && nowMs > entry.expiresAt) {
        transientUnavailableByKey.delete(key);
        return null;
    }
    return {
        kind: 'success',
        updatedAt: entry.updatedAt,
        expiresAt: entry.expiresAt,
        value: entry.value,
        unavailable: true,
    };
}

export function readDynamicConfigOptionsProbeCache(key: string): DynamicConfigOptionsProbeCacheEntry | null {
    const transientUnavailable = readTransientUnavailable(key);
    if (transientUnavailable) return transientUnavailable;
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
    transientUnavailableByKey.delete(key);
    persistedCache.writeSuccess(key, value, nowMs);
}

export function writeDynamicConfigOptionsProbeCacheError(key: string, nowMs = Date.now()): void {
    transientUnavailableByKey.delete(key);
    persistedCache.writeError(key, new Error('dynamic-config-options-probe-failed'), nowMs);
}

export function writeDynamicConfigOptionsProbeCacheUnavailable(key: string, nowMs = Date.now()): void {
    persistedCache.writeError(key, new Error('dynamic-config-options-probe-unavailable'), nowMs);
    transientUnavailableByKey.set(key, {
        updatedAt: nowMs,
        expiresAt: nowMs + DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS,
        value: [],
    });
}

export async function runDynamicConfigOptionsProbeDedupe<T>(
    key: string,
    run: () => Promise<T>,
): Promise<T> {
    return await persistedCache.runDedupe(key, run);
}

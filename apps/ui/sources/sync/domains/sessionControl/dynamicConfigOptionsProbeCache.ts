import { normalizeAcpConfigOptionsArray, type AcpConfigOption } from '@/sync/domains/sessionControl/configOptionsControl';
import type { ProbedResourceSnapshot } from '@happier-dev/protocol/common/probedResourceCache';

import { createPersistentProbedResourceCache, ProbedResourceError, type ProbedResourceFailure } from '@/sync/runtime/probedResources/createPersistentProbedResourceCache';

export type DynamicConfigOptionsProbeCacheEntry = ProbedResourceFailure & (
    | Readonly<{
        kind: 'success';
        updatedAt: number;
        expiresAt: number;
        value: readonly AcpConfigOption[];
        modelConfigOptionId?: string;
        unavailable?: boolean;
    }>
    | Readonly<{ kind: 'error'; updatedAt: number; expiresAt: number }>);

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

type ConfigOptionsCatalog = Readonly<{ configOptions: readonly AcpConfigOption[]; modelConfigOptionId?: string }>;

function normalizePersistedConfigOptions(input: unknown): ConfigOptionsCatalog | null {
    // Existing persisted entries were bare arrays and carry no selector identity.
    const record = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
    const configOptions = normalizeAcpConfigOptionsArray(record ? record.configOptions : input);
    if (!configOptions) return null;
    const modelConfigOptionId = typeof record?.modelConfigOptionId === 'string' && record.modelConfigOptionId.trim()
        ? record.modelConfigOptionId : undefined;
    return { configOptions, ...(modelConfigOptionId === undefined ? {} : { modelConfigOptionId }) };
}

const persistedCache = createPersistentProbedResourceCache<ConfigOptionsCatalog>({
    cacheId: 'dynamic-config-options-probe-cache',
    persistKey: PERSIST_KEY,
    persistVersion: PERSIST_VERSION,
    persistMaxEntries: PERSIST_MAX_ENTRIES,
    persistMaxAgeMs: PERSIST_MAX_AGE_MS,
    staleTimeMs: DYNAMIC_CONFIG_OPTIONS_PROBE_SUCCESS_TTL_MS,
    errorCooldownMs: DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS,
    normalizePersistedValue: normalizePersistedConfigOptions,
    deleteOnPersistVersionMismatch: true,
    onAccountRetired: () => transientUnavailableByKey.clear(),
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
    const snap: ProbedResourceSnapshot<ConfigOptionsCatalog> = persistedCache.getSnapshot(key);
    const failure = snap.error instanceof ProbedResourceError ? snap.error.failure : undefined;
    const transientUnavailable = readTransientUnavailable(key);
    if (transientUnavailable) return { ...transientUnavailable, ...failure };
    if (snap.dataUpdatedAt !== null && snap.data) {
        return {
            kind: 'success',
            updatedAt: snap.dataUpdatedAt,
            expiresAt: snap.dataUpdatedAt + DYNAMIC_CONFIG_OPTIONS_PROBE_SUCCESS_TTL_MS,
            value: snap.data.configOptions,
            ...(snap.data.modelConfigOptionId === undefined ? {} : { modelConfigOptionId: snap.data.modelConfigOptionId }),
            ...failure,
        };
    }
    if (snap.errorUpdatedAt !== null) {
        return {
            kind: 'error',
            updatedAt: snap.errorUpdatedAt,
            expiresAt: snap.errorUpdatedAt + DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS,
            ...failure,
        };
    }
    return null;
}

export function writeDynamicConfigOptionsProbeCacheSuccess(
    key: string,
    value: readonly AcpConfigOption[],
    nowMs = Date.now(),
    modelConfigOptionId?: string,
): void {
    transientUnavailableByKey.delete(key);
    persistedCache.writeSuccess(key, { configOptions: value, ...(modelConfigOptionId === undefined ? {} : { modelConfigOptionId }) }, nowMs);
}

export function writeDynamicConfigOptionsProbeCacheError(key: string, nowMs = Date.now(), failure?: ProbedResourceFailure): void {
    transientUnavailableByKey.delete(key);
    persistedCache.writeError(key, new ProbedResourceError('dynamic-config-options-probe-failed', failure), nowMs);
}

export function writeDynamicConfigOptionsProbeCacheUnavailable(key: string, nowMs = Date.now(), failure?: ProbedResourceFailure): void {
    persistedCache.writeError(key, new ProbedResourceError('dynamic-config-options-probe-unavailable', failure), nowMs);
    transientUnavailableByKey.set(key, {
        updatedAt: nowMs,
        expiresAt: nowMs + DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS,
        value: [],
    });
}

export async function runDynamicConfigOptionsProbeDedupe<T>(
    key: string,
    run: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    return await persistedCache.runDedupe(key, run, signal);
}

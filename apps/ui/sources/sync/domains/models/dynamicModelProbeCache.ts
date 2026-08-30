import { normalizeAcpConfigOptionsArray, type AcpConfigOption } from '@/sync/domains/sessionControl/configOptionsControl';
import { createUnavailablePreflightModelList, type PreflightModelList } from '@/sync/domains/models/modelOptions';
import type { ProbedResourceSnapshot } from '@happier-dev/protocol';

import { createPersistentProbedResourceCache } from '@/sync/runtime/probedResources/createPersistentProbedResourceCache';

export type DynamicModelProbeCacheEntry =
    | Readonly<{
        kind: 'success';
        updatedAt: number;
        expiresAt: number;
        value: PreflightModelList;
        cacheable?: boolean;
    }>
    | Readonly<{ kind: 'error'; updatedAt: number; expiresAt: number }>;

export const DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS = 24 * 60 * 60_000;
export const DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS = 60_000;
// When dynamic model probing temporarily falls back to a static list (no per-model options),
// retry quickly so users don't have to manually hit refresh to see things like Thinking/Speed.
export const DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS = 2_000;
export const DYNAMIC_MODEL_PROBE_TRANSIENT_SUCCESS_MAX_AGE_MS = 10 * 60_000;

const PERSIST_KEY = 'dynamic-model-probe-cache-v1';
const PERSIST_VERSION = 7;
const PERSIST_MAX_ENTRIES = 200;
const PERSIST_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

function normalizePersistedModelList(input: unknown): PreflightModelList | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const inputRecord = input as Record<string, unknown>;
    const modelsRaw = inputRecord.availableModels;
    const supportsFreeformRaw = inputRecord.supportsFreeform;
    if (!Array.isArray(modelsRaw)) return null;

    const normalizeModelOptions = (value: unknown): readonly AcpConfigOption[] | undefined => {
        const normalized = normalizeAcpConfigOptionsArray(value);
        return normalized && normalized.length > 0 ? normalized : undefined;
    };

    const models = modelsRaw.flatMap((rawModel) => {
        if (!rawModel || typeof rawModel !== 'object' || Array.isArray(rawModel)) return [];
        const modelRecord = rawModel as Record<string, unknown>;
        if (typeof modelRecord.id !== 'string' || typeof modelRecord.name !== 'string') return [];
        const modelOptions = normalizeModelOptions(modelRecord.modelOptions);
        return [{
            id: modelRecord.id,
            name: modelRecord.name,
            ...(typeof modelRecord.description === 'string' ? { description: modelRecord.description } : {}),
            ...(typeof modelRecord.extendedContextModelId === 'string'
                && modelRecord.extendedContextModelId.trim().length > 0
                ? { extendedContextModelId: modelRecord.extendedContextModelId.trim() }
                : {}),
            ...(modelOptions ? { modelOptions } : {}),
        }];
    });
    const supportsFreeform = Boolean(supportsFreeformRaw);
    if (models.length === 0 && supportsFreeform !== true) return null;
    return { availableModels: models, supportsFreeform };
}

const transientSuccessByKey = new Map<string, Readonly<{
    updatedAt: number;
    expiresAt: number;
    retainUntil: number;
    value: PreflightModelList;
}>>();

const transientUnavailableByKey = new Map<string, Readonly<{
    updatedAt: number;
    expiresAt: number;
    value: PreflightModelList;
}>>();

const persistedCache = createPersistentProbedResourceCache<PreflightModelList>({
    cacheId: 'dynamic-model-probe-cache',
    persistKey: PERSIST_KEY,
    persistVersion: PERSIST_VERSION,
    persistMaxEntries: PERSIST_MAX_ENTRIES,
    persistMaxAgeMs: PERSIST_MAX_AGE_MS,
    staleTimeMs: DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS,
    errorCooldownMs: DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS,
    normalizePersistedValue: normalizePersistedModelList,
    deleteOnPersistVersionMismatch: true,
});

export function resetDynamicModelProbeCacheForTests(): void {
    transientSuccessByKey.clear();
    transientUnavailableByKey.clear();
    persistedCache.resetForTests();
}

function readTransientSuccess(key: string, nowMs = Date.now()): DynamicModelProbeCacheEntry | null {
    const entry = transientSuccessByKey.get(key) ?? null;
    if (!entry) return null;
    if (nowMs >= 0 && nowMs > entry.retainUntil) {
        transientSuccessByKey.delete(key);
        return null;
    }
    return {
        kind: 'success',
        updatedAt: entry.updatedAt,
        expiresAt: entry.expiresAt,
        value: entry.value,
        cacheable: false,
    };
}

function readTransientUnavailable(key: string, nowMs = Date.now()): DynamicModelProbeCacheEntry | null {
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
        cacheable: false,
    };
}

export function readDynamicModelProbeCache(
    key: string,
    successMaxAgeMs = DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS,
): DynamicModelProbeCacheEntry | null {
    const snap: ProbedResourceSnapshot<PreflightModelList> = persistedCache.getSnapshot(key);
    if (snap.dataUpdatedAt !== null && snap.data) {
        return {
            kind: 'success',
            updatedAt: snap.dataUpdatedAt,
            expiresAt: snap.dataUpdatedAt + Math.min(DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS, successMaxAgeMs),
            value: snap.data,
            cacheable: true,
        };
    }
    const transientUnavailable = readTransientUnavailable(key);
    if (transientUnavailable) return transientUnavailable;
    const transient = readTransientSuccess(key);
    if (transient) return transient;
    if (snap.errorUpdatedAt !== null) {
        return {
            kind: 'error',
            updatedAt: snap.errorUpdatedAt,
            expiresAt: snap.errorUpdatedAt + DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS,
        };
    }
    return null;
}

export function writeDynamicModelProbeCacheSuccess(key: string, value: PreflightModelList, nowMs = Date.now()): void {
    transientSuccessByKey.delete(key);
    transientUnavailableByKey.delete(key);
    persistedCache.writeSuccess(key, value, nowMs);
}

export function writeDynamicModelProbeCacheTransientSuccess(
    key: string,
    value: PreflightModelList,
    nowMs = Date.now(),
): void {
    transientSuccessByKey.set(key, {
        updatedAt: nowMs,
        expiresAt: nowMs + DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS,
        retainUntil: nowMs + DYNAMIC_MODEL_PROBE_TRANSIENT_SUCCESS_MAX_AGE_MS,
        value,
    });
}

export function writeDynamicModelProbeCacheError(key: string, nowMs = Date.now()): void {
    transientUnavailableByKey.delete(key);
    persistedCache.writeError(key, new Error('dynamic-model-probe-failed'), nowMs);
}

export function writeDynamicModelProbeCacheUnavailable(key: string, nowMs = Date.now()): void {
    transientSuccessByKey.delete(key);
    persistedCache.writeError(key, new Error('dynamic-model-probe-unavailable'), nowMs);
    transientUnavailableByKey.set(key, {
        updatedAt: nowMs,
        expiresAt: nowMs + DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS,
        value: createUnavailablePreflightModelList(),
    });
}

export async function runDynamicModelProbeDedupe<T>(
    key: string,
    run: () => Promise<T>,
): Promise<T> {
    return await persistedCache.runDedupe(key, run);
}

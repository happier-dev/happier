import { normalizeAcpConfigOptionsArray, type AcpConfigOption } from '@/sync/acp/configOptionsControl';
import type { PreflightModelList } from '@/sync/domains/models/modelOptions';
import type { ProbedResourceSnapshot } from '@happier-dev/protocol';

import { createPersistentProbedResourceCache } from '@/sync/runtime/probedResources/createPersistentProbedResourceCache';

export type DynamicModelProbeCacheEntry =
    | Readonly<{ kind: 'success'; updatedAt: number; expiresAt: number; value: PreflightModelList }>
    | Readonly<{ kind: 'error'; updatedAt: number; expiresAt: number }>;

export const DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS = 24 * 60 * 60_000;
export const DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS = 60_000;

const PERSIST_KEY = 'dynamic-model-probe-cache-v1';
const PERSIST_VERSION = 4;
const PERSIST_MAX_ENTRIES = 200;
const PERSIST_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

function normalizePersistedModelList(input: unknown): PreflightModelList | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const modelsRaw = (input as any).availableModels;
    const supportsFreeformRaw = (input as any).supportsFreeform;
    if (!Array.isArray(modelsRaw)) return null;

    const normalizeModelOptions = (value: unknown): readonly AcpConfigOption[] | undefined => {
        const normalized = normalizeAcpConfigOptionsArray(value);
        return normalized && normalized.length > 0 ? normalized : undefined;
    };

    const models = modelsRaw
        .filter((m: any) => m && typeof m.id === 'string' && typeof m.name === 'string')
        .map((m: any) => {
            const modelOptions = normalizeModelOptions(m.modelOptions);
            return {
                id: String(m.id),
                name: String(m.name),
                ...(typeof m.description === 'string' ? { description: m.description } : {}),
                ...(modelOptions ? { modelOptions } : {}),
            };
        });
    const supportsFreeform = Boolean(supportsFreeformRaw);
    if (models.length === 0 && supportsFreeform !== true) return null;
    return { availableModels: models, supportsFreeform };
}

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
    persistedCache.resetForTests();
}

export function readDynamicModelProbeCache(key: string): DynamicModelProbeCacheEntry | null {
    const snap: ProbedResourceSnapshot<PreflightModelList> = persistedCache.getSnapshot(key);
    if (snap.dataUpdatedAt !== null && snap.data) {
        return {
            kind: 'success',
            updatedAt: snap.dataUpdatedAt,
            expiresAt: snap.dataUpdatedAt + DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS,
            value: snap.data,
        };
    }
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
    persistedCache.writeSuccess(key, value, nowMs);
}

export function writeDynamicModelProbeCacheError(key: string, nowMs = Date.now()): void {
    persistedCache.writeError(key, new Error('dynamic-model-probe-failed'), nowMs);
}

export async function runDynamicModelProbeDedupe<T>(
    key: string,
    run: () => Promise<T>,
): Promise<T> {
    return await persistedCache.runDedupe(key, run);
}

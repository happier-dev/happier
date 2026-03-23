import type { PreflightSessionModeList } from '@/sync/domains/sessionModes/sessionModeOptions';
import type { ProbedResourceSnapshot } from '@happier-dev/protocol';

import { createPersistentProbedResourceCache } from '@/sync/runtime/probedResources/createPersistentProbedResourceCache';

export type DynamicSessionModeProbeCacheEntry =
    | Readonly<{ kind: 'success'; updatedAt: number; expiresAt: number; value: PreflightSessionModeList }>
    | Readonly<{ kind: 'error'; updatedAt: number; expiresAt: number }>;

export const DYNAMIC_SESSION_MODE_PROBE_SUCCESS_TTL_MS = 24 * 60 * 60_000;
export const DYNAMIC_SESSION_MODE_PROBE_ERROR_BACKOFF_MS = 60_000;

const PERSIST_KEY = 'dynamic-session-mode-probe-cache-v1';
const PERSIST_VERSION = 2;
const PERSIST_MAX_ENTRIES = 200;
const PERSIST_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

function normalizePersistedModeList(input: unknown): PreflightSessionModeList | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const modesRaw = (input as any).availableModes;
    if (!Array.isArray(modesRaw) || modesRaw.length === 0) return null;

    const modes = modesRaw
        .filter((m: any) => m && typeof m.id === 'string' && typeof m.name === 'string')
        .map((m: any) => ({
            id: String(m.id),
            name: String(m.name),
            ...(typeof m.description === 'string' ? { description: m.description } : {}),
        }));
    if (modes.length === 0) return null;
    return { availableModes: modes };
}

const persistedCache = createPersistentProbedResourceCache<PreflightSessionModeList>({
    cacheId: 'dynamic-session-mode-probe-cache',
    persistKey: PERSIST_KEY,
    persistVersion: PERSIST_VERSION,
    persistMaxEntries: PERSIST_MAX_ENTRIES,
    persistMaxAgeMs: PERSIST_MAX_AGE_MS,
    staleTimeMs: DYNAMIC_SESSION_MODE_PROBE_SUCCESS_TTL_MS,
    errorCooldownMs: DYNAMIC_SESSION_MODE_PROBE_ERROR_BACKOFF_MS,
    normalizePersistedValue: normalizePersistedModeList,
});

export function resetDynamicSessionModeProbeCacheForTests(): void {
    persistedCache.resetForTests();
}

export function readDynamicSessionModeProbeCache(key: string): DynamicSessionModeProbeCacheEntry | null {
    const snap: ProbedResourceSnapshot<PreflightSessionModeList> = persistedCache.getSnapshot(key);
    if (snap.dataUpdatedAt !== null && snap.data) {
        return {
            kind: 'success',
            updatedAt: snap.dataUpdatedAt,
            expiresAt: snap.dataUpdatedAt + DYNAMIC_SESSION_MODE_PROBE_SUCCESS_TTL_MS,
            value: snap.data,
        };
    }
    if (snap.errorUpdatedAt !== null) {
        return {
            kind: 'error',
            updatedAt: snap.errorUpdatedAt,
            expiresAt: snap.errorUpdatedAt + DYNAMIC_SESSION_MODE_PROBE_ERROR_BACKOFF_MS,
        };
    }
    return null;
}

export function writeDynamicSessionModeProbeCacheSuccess(key: string, value: PreflightSessionModeList, nowMs = Date.now()): void {
    persistedCache.writeSuccess(key, value, nowMs);
}

export function writeDynamicSessionModeProbeCacheError(key: string, nowMs = Date.now()): void {
    persistedCache.writeError(key, new Error('dynamic-session-mode-probe-failed'), nowMs);
}

export async function runDynamicSessionModeProbeDedupe<T>(
    key: string,
    run: () => Promise<T>,
): Promise<T> {
    return await persistedCache.runDedupe(key, run);
}

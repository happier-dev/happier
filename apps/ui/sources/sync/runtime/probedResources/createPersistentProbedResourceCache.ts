import { ProbedResourceCache, type ProbedResourceSnapshot } from '@happier-dev/protocol';
import { MMKV } from 'react-native-mmkv';

import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

type PersistedEntry<T> = Readonly<{ updatedAt: number; value: T }>;
type PersistedState<T> = Readonly<{ version: number; entries: Record<string, PersistedEntry<T>> }>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function createPersistentProbedResourceCache<T>(params: Readonly<{
    cacheId: string;
    persistKey: string;
    persistVersion: number;
    persistMaxEntries: number;
    persistMaxAgeMs: number;
    staleTimeMs: number;
    errorCooldownMs: number;
    normalizePersistedValue: (raw: unknown) => T | null;
    deleteOnPersistVersionMismatch?: boolean;
}>): Readonly<{
    getSnapshot: (key: string) => ProbedResourceSnapshot<T>;
    writeSuccess: (key: string, value: T, nowMs?: number) => void;
    writeError: (key: string, error: Error, nowMs?: number) => void;
    runDedupe: <R>(key: string, run: () => Promise<R>) => Promise<R>;
    resetForTests: () => void;
}> {
    const cache = new ProbedResourceCache<T>({
        staleTimeMs: params.staleTimeMs,
        errorCooldownMs: params.errorCooldownMs,
    });

    const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';
    const storageScope = isWebRuntime ? null : readStorageScopeFromEnv();
    const storage = isWebRuntime
        ? null
        : (storageScope ? new MMKV({ id: scopedStorageId(params.cacheId, storageScope) }) : new MMKV());

    let persistedState: PersistedState<T> | null = null;
    const inflight = new Map<string, Promise<unknown>>();

    function readPersistedString(): string | null {
        if (isWebRuntime) {
            try {
                return typeof window?.localStorage?.getItem === 'function' ? window.localStorage.getItem(params.persistKey) : null;
            } catch {
                return null;
            }
        }
        try {
            return storage?.getString(params.persistKey) ?? null;
        } catch {
            return null;
        }
    }

    function writePersistedString(value: string): void {
        if (isWebRuntime) {
            try {
                if (typeof window?.localStorage?.setItem === 'function') window.localStorage.setItem(params.persistKey, value);
            } catch {
                // ignore
            }
            return;
        }
        try {
            storage?.set(params.persistKey, value);
        } catch {
            // ignore
        }
    }

    function deletePersistedString(): void {
        if (isWebRuntime) {
            try {
                if (typeof window?.localStorage?.removeItem === 'function') window.localStorage.removeItem(params.persistKey);
            } catch {
                // ignore
            }
            return;
        }
        try {
            storage?.delete(params.persistKey);
        } catch {
            // ignore
        }
    }

    function readPersistedState(): PersistedState<T> | null {
        const raw = readPersistedString();
        if (!raw) return null;
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return null;
        }
        if (!isRecord(parsed)) return null;
        if (parsed.version !== params.persistVersion) {
            if (params.deleteOnPersistVersionMismatch === true) {
                // Best-effort: schema changes should drop stale caches rather than pinning incomplete lists.
                deletePersistedString();
            }
            return null;
        }
        const entriesRaw = parsed.entries;
        if (!isRecord(entriesRaw)) return null;

        const now = Date.now();
        const out: Record<string, PersistedEntry<T>> = {};
        for (const [key, value] of Object.entries(entriesRaw)) {
            if (typeof key !== 'string' || !key) continue;
            if (!isRecord(value)) continue;
            const updatedAt = Number(value.updatedAt);
            if (!Number.isFinite(updatedAt) || updatedAt <= 0) continue;
            if (now >= 0 && now - updatedAt > params.persistMaxAgeMs) continue;
            const normalized = params.normalizePersistedValue(value.value);
            if (!normalized) continue;
            out[key] = { updatedAt, value: normalized };
        }
        return { version: params.persistVersion, entries: out };
    }

    function prunePersistedState(state: PersistedState<T>, nowMs = Date.now()): PersistedState<T> {
        const entries = Object.entries(state.entries)
            .filter(([, entry]) => !(nowMs >= 0 && nowMs - entry.updatedAt > params.persistMaxAgeMs))
            .sort((a, b) => b[1].updatedAt - a[1].updatedAt);

        const trimmed = entries.slice(0, params.persistMaxEntries);
        const nextEntries: Record<string, PersistedEntry<T>> = {};
        for (const [key, entry] of trimmed) nextEntries[key] = entry;
        return { version: params.persistVersion, entries: nextEntries };
    }

    function ensureHydrated(): void {
        if (persistedState) return;
        persistedState = prunePersistedState(readPersistedState() ?? { version: params.persistVersion, entries: {} });
        for (const [key, entry] of Object.entries(persistedState.entries)) {
            cache.setSuccess(key, entry.value, entry.updatedAt);
        }
    }

    function persistSuccess(key: string, value: T, updatedAt: number): void {
        ensureHydrated();
        const current = persistedState ?? { version: params.persistVersion, entries: {} };
        const next = prunePersistedState({
            version: params.persistVersion,
            entries: {
                ...current.entries,
                [key]: { updatedAt, value },
            },
        });
        persistedState = next;
        writePersistedString(JSON.stringify(next));
    }

    ensureHydrated();

    return {
        getSnapshot: (key: string) => {
            ensureHydrated();
            return cache.getSnapshot(key);
        },
        writeSuccess: (key: string, value: T, nowMs = Date.now()) => {
            ensureHydrated();
            cache.setSuccess(key, value, nowMs);
            persistSuccess(key, value, nowMs);
        },
        writeError: (key: string, error: Error, nowMs = Date.now()) => {
            ensureHydrated();
            cache.setError(key, error, nowMs);
        },
        runDedupe: async <R,>(key: string, run: () => Promise<R>): Promise<R> => {
            ensureHydrated();
            const pending = inflight.get(key) as Promise<R> | undefined;
            if (pending) return await pending;

            const p = (async () => {
                try {
                    return await run();
                } finally {
                    inflight.delete(key);
                }
            })();
            inflight.set(key, p);
            return await p;
        },
        resetForTests: () => {
            cache.clear();
            persistedState = null;
            deletePersistedString();
        },
    };
}

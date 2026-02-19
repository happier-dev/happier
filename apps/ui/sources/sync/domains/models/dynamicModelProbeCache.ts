import type { PreflightModelList } from '@/sync/domains/models/modelOptions';
import { ProbedResourceCache, type ProbedResourceSnapshot } from '@happier-dev/protocol';
import { MMKV } from 'react-native-mmkv';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

export type DynamicModelProbeCacheEntry =
    | Readonly<{ kind: 'success'; updatedAt: number; expiresAt: number; value: PreflightModelList }>
    | Readonly<{ kind: 'error'; updatedAt: number; expiresAt: number }>;

export const DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS = 24 * 60 * 60_000;
export const DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS = 60_000;

const cache = new ProbedResourceCache<PreflightModelList>({
    staleTimeMs: DYNAMIC_MODEL_PROBE_SUCCESS_TTL_MS,
    errorCooldownMs: DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS,
});

const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';
const storageScope = isWebRuntime ? null : readStorageScopeFromEnv();
const storage = isWebRuntime
    ? null
    : (storageScope ? new MMKV({ id: scopedStorageId('dynamic-model-probe-cache', storageScope) }) : new MMKV());
const PERSIST_KEY = 'dynamic-model-probe-cache-v1';
const PERSIST_VERSION = 1;
const PERSIST_MAX_ENTRIES = 200;
const PERSIST_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

type PersistedEntry = Readonly<{ updatedAt: number; value: PreflightModelList }>;
type PersistedState = Readonly<{ version: number; entries: Record<string, PersistedEntry> }>;

let persistedState: PersistedState | null = null;
const inflight = new Map<string, Promise<PreflightModelList | null>>();

function readPersistedString(): string | null {
    if (isWebRuntime) {
        try {
            return typeof window?.localStorage?.getItem === 'function' ? window.localStorage.getItem(PERSIST_KEY) : null;
        } catch {
            return null;
        }
    }
    try {
        return storage?.getString(PERSIST_KEY) ?? null;
    } catch {
        return null;
    }
}

function writePersistedString(value: string): void {
    if (isWebRuntime) {
        try {
            if (typeof window?.localStorage?.setItem === 'function') window.localStorage.setItem(PERSIST_KEY, value);
        } catch {
            // ignore
        }
        return;
    }
    try {
        storage?.set(PERSIST_KEY, value);
    } catch {
        // ignore
    }
}

function deletePersistedString(): void {
    if (isWebRuntime) {
        try {
            if (typeof window?.localStorage?.removeItem === 'function') window.localStorage.removeItem(PERSIST_KEY);
        } catch {
            // ignore
        }
        return;
    }
    try {
        storage?.delete(PERSIST_KEY);
    } catch {
        // ignore
    }
}

function normalizePersistedModelList(input: unknown): PreflightModelList | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const modelsRaw = (input as any).availableModels;
    const supportsFreeformRaw = (input as any).supportsFreeform;
    if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) return null;

    const models = modelsRaw
        .filter((m: any) => m && typeof m.id === 'string' && typeof m.name === 'string')
        .map((m: any) => ({
            id: String(m.id),
            name: String(m.name),
            ...(typeof m.description === 'string' ? { description: m.description } : {}),
        }));
    if (models.length === 0) return null;
    return { availableModels: models, supportsFreeform: Boolean(supportsFreeformRaw) };
}

function readPersistedState(): PersistedState | null {
    const raw = readPersistedString();
    if (!raw) return null;
    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.version !== PERSIST_VERSION) return null;
    const entriesRaw = parsed.entries;
    if (!entriesRaw || typeof entriesRaw !== 'object' || Array.isArray(entriesRaw)) return null;

    const now = Date.now();
    const out: Record<string, PersistedEntry> = {};
    for (const [key, value] of Object.entries(entriesRaw as Record<string, unknown>)) {
        if (typeof key !== 'string' || !key) continue;
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const updatedAt = Number((value as any).updatedAt);
        if (!Number.isFinite(updatedAt) || updatedAt <= 0) continue;
        if (now >= 0 && now - updatedAt > PERSIST_MAX_AGE_MS) continue;
        const list = normalizePersistedModelList((value as any).value);
        if (!list) continue;
        out[key] = { updatedAt, value: list };
    }
    return { version: PERSIST_VERSION, entries: out };
}

function prunePersistedState(state: PersistedState, nowMs = Date.now()): PersistedState {
    const entries = Object.entries(state.entries)
        .filter(([, entry]) => !(nowMs >= 0 && nowMs - entry.updatedAt > PERSIST_MAX_AGE_MS))
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt);

    const trimmed = entries.slice(0, PERSIST_MAX_ENTRIES);
    const nextEntries: Record<string, PersistedEntry> = {};
    for (const [key, entry] of trimmed) nextEntries[key] = entry;
    return { version: PERSIST_VERSION, entries: nextEntries };
}

function ensureHydrated(): void {
    if (persistedState) return;
    persistedState = prunePersistedState(readPersistedState() ?? { version: PERSIST_VERSION, entries: {} });
    for (const [key, entry] of Object.entries(persistedState.entries)) {
        cache.setSuccess(key, entry.value, entry.updatedAt);
    }
}

function persistSuccess(key: string, value: PreflightModelList, updatedAt: number): void {
    ensureHydrated();
    const current = persistedState ?? { version: PERSIST_VERSION, entries: {} };
    const next = prunePersistedState({
        version: PERSIST_VERSION,
        entries: {
            ...current.entries,
            [key]: { updatedAt, value },
        },
    });
    persistedState = next;
    writePersistedString(JSON.stringify(next));
}

ensureHydrated();

export function resetDynamicModelProbeCacheForTests(): void {
    cache.clear();
    persistedState = null;
    deletePersistedString();
}

export function readDynamicModelProbeCache(key: string): DynamicModelProbeCacheEntry | null {
    ensureHydrated();
    const snap: ProbedResourceSnapshot<PreflightModelList> = cache.getSnapshot(key);
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
    ensureHydrated();
    cache.setSuccess(key, value, nowMs);
    persistSuccess(key, value, nowMs);
}

export function writeDynamicModelProbeCacheError(key: string, nowMs = Date.now()): void {
    ensureHydrated();
    cache.setError(key, new Error('dynamic-model-probe-failed'), nowMs);
}

export async function runDynamicModelProbeDedupe(
    key: string,
    run: () => Promise<PreflightModelList | null>,
): Promise<PreflightModelList | null> {
    ensureHydrated();
    const pending = inflight.get(key);
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
}

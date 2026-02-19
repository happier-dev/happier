import type { PreflightSessionModeList } from '@/sync/domains/sessionModes/sessionModeOptions';
import { ProbedResourceCache, type ProbedResourceSnapshot } from '@happier-dev/protocol';
import { MMKV } from 'react-native-mmkv';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

export type DynamicSessionModeProbeCacheEntry =
    | Readonly<{ kind: 'success'; updatedAt: number; expiresAt: number; value: PreflightSessionModeList }>
    | Readonly<{ kind: 'error'; updatedAt: number; expiresAt: number }>;

export const DYNAMIC_SESSION_MODE_PROBE_SUCCESS_TTL_MS = 24 * 60 * 60_000;
export const DYNAMIC_SESSION_MODE_PROBE_ERROR_BACKOFF_MS = 60_000;

const cache = new ProbedResourceCache<PreflightSessionModeList>({
    staleTimeMs: DYNAMIC_SESSION_MODE_PROBE_SUCCESS_TTL_MS,
    errorCooldownMs: DYNAMIC_SESSION_MODE_PROBE_ERROR_BACKOFF_MS,
});

const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';
const storageScope = isWebRuntime ? null : readStorageScopeFromEnv();
const storage = isWebRuntime
    ? null
    : (storageScope ? new MMKV({ id: scopedStorageId('dynamic-session-mode-probe-cache', storageScope) }) : new MMKV());
const PERSIST_KEY = 'dynamic-session-mode-probe-cache-v1';
const PERSIST_VERSION = 1;
const PERSIST_MAX_ENTRIES = 200;
const PERSIST_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

type PersistedEntry = Readonly<{ updatedAt: number; value: PreflightSessionModeList }>;
type PersistedState = Readonly<{ version: number; entries: Record<string, PersistedEntry> }>;

let persistedState: PersistedState | null = null;
const inflight = new Map<string, Promise<PreflightSessionModeList | null>>();

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
        const list = normalizePersistedModeList((value as any).value);
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

function persistSuccess(key: string, value: PreflightSessionModeList, updatedAt: number): void {
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

export function resetDynamicSessionModeProbeCacheForTests(): void {
    cache.clear();
    persistedState = null;
    deletePersistedString();
}

export function readDynamicSessionModeProbeCache(key: string): DynamicSessionModeProbeCacheEntry | null {
    ensureHydrated();
    const snap: ProbedResourceSnapshot<PreflightSessionModeList> = cache.getSnapshot(key);
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
    ensureHydrated();
    cache.setSuccess(key, value, nowMs);
    persistSuccess(key, value, nowMs);
}

export function writeDynamicSessionModeProbeCacheError(key: string, nowMs = Date.now()): void {
    ensureHydrated();
    cache.setError(key, new Error('dynamic-session-mode-probe-failed'), nowMs);
}

export async function runDynamicSessionModeProbeDedupe(
    key: string,
    run: () => Promise<PreflightSessionModeList | null>,
): Promise<PreflightSessionModeList | null> {
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


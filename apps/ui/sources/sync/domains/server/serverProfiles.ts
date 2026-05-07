import { MMKV } from 'react-native-mmkv';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { isStackContext } from './serverContext';
import { canonicalizeServerUrl, createServerUrlComparableKey } from './url/serverUrlCanonical';
import { sanitizeServerUrlForShareableLink } from './url/shareableServerUrl';
import { readConfiguredServerUrlEnv, readConfiguredServerUrlEnvRaw } from './readConfiguredServerUrlEnv';

export type ServerProfileSource = 'manual' | 'url' | 'stack-env' | 'notification' | 'preconfigured';

export type ServerProfile = Readonly<{
    id: string;
    name: string;
    serverUrl: string;
    shareableServerUrl?: string | null;
    createdAt: number;
    updatedAt: number;
    lastUsedAt: number;
    source?: ServerProfileSource;
}>;

export type ActiveServerSnapshot = Readonly<{
    serverId: string;
    serverUrl: string;
    activeShareableServerUrl?: string | null;
    activeLocalRelayUrl?: string | null;
    generation: number;
}>;

type PersistedServerState = {
    activeServerIdIsExplicit?: boolean;
    activeServerId?: string;
    servers?: Record<string, ServerProfile>;
};

type PreconfiguredServer = Readonly<{
    name: string;
    source: ServerProfileSource;
    url: string;
    idSeed?: string;
}>;

const SESSION_STORAGE_ACTIVE_ID_KEY = 'activeServerId';
const STATE_KEY = 'server-state-v1';

let activeServerGeneration = 0;
const activeServerListeners = new Set<(snapshot: ActiveServerSnapshot) => void>();
let activeServerSnapshotCache: ActiveServerSnapshot | null = null;

function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function normalizeUrl(raw: string): string {
    return canonicalizeServerUrl(raw);
}

function normalizeServerId(raw: unknown): string | null {
    const id = String(raw ?? '').trim();
    return id || null;
}

function comparableUrlKey(rawUrl: string): string {
    return createServerUrlComparableKey(rawUrl);
}

function deriveServerIdFromUrl(serverUrl: string): string {
    const normalized = normalizeUrl(serverUrl);
    try {
        const url = new URL(normalized);
        const host = url.hostname.toLowerCase();
        const port = url.port ? `-${url.port}` : '';
        const base = `${host}${port}`;
        const sanitized = base.replace(/[^a-z0-9._-]/g, '_').replace(/_+/g, '_');
        return sanitized || 'custom';
    } catch {
        const fallback = normalized.toLowerCase().replace(/[^a-z0-9._-]/g, '_').replace(/_+/g, '_');
        return fallback || 'custom';
    }
}

function defaultServerNameFromUrl(serverUrl: string): string {
    const normalized = normalizeUrl(serverUrl);
    try {
        const parsed = new URL(normalized);
        const host = parsed.hostname;
        if (!host) return normalized;
        return parsed.port ? `${host}:${parsed.port}` : host;
    } catch {
        return normalized;
    }
}

function nowMs(): number {
    return Date.now();
}

function storageId(): string {
    const scope = readStorageScopeFromEnv();
    return scopedStorageId('server-profiles', scope);
}

type PersistedStateStorage = Readonly<{
    getString: (key: string) => string | undefined;
    set: (key: string, value: string) => void;
}>;

let persistedStateStorage: PersistedStateStorage | null = null;

function resolveWebStorageBackend(): Storage | null {
    const windowStorage = (globalThis as any).window?.localStorage;
    if (windowStorage && typeof windowStorage.getItem === 'function') return windowStorage as Storage;
    const localStorage = (globalThis as any).localStorage;
    if (localStorage && typeof localStorage.getItem === 'function') return localStorage as Storage;
    const sessionStorage = (globalThis as any).sessionStorage;
    if (sessionStorage && typeof sessionStorage.getItem === 'function') return sessionStorage as Storage;
    return null;
}

function createWebPersistedStateStorage(): PersistedStateStorage {
    const storage = resolveWebStorageBackend();
    const fallback = new Map<string, string>();
    const prefix = `${storageId()}:`;
    const resolveKey = (key: string) => `${prefix}${key}`;

    return {
        getString: (key: string) => {
            const resolvedKey = resolveKey(key);
            try {
                const value = storage?.getItem(resolvedKey) ?? null;
                return typeof value === 'string' ? value : fallback.get(resolvedKey);
            } catch {
                return fallback.get(resolvedKey);
            }
        },
        set: (key: string, value: string) => {
            const resolvedKey = resolveKey(key);
            try {
                storage?.setItem(resolvedKey, value);
            } catch {
                // ignore
            }
            fallback.set(resolvedKey, value);
        },
    };
}

function createNativePersistedStateStorage(): PersistedStateStorage {
    const storage = new MMKV({ id: storageId() });
    return {
        getString: (key: string) => storage.getString(key),
        set: (key: string, value: string) => storage.set(key, value),
    };
}

function getPersistedStateStorage(): PersistedStateStorage {
    if (persistedStateStorage) return persistedStateStorage;
    persistedStateStorage = isWebRuntime() ? createWebPersistedStateStorage() : createNativePersistedStateStorage();
    return persistedStateStorage;
}

function parsePreconfiguredServersFromEnv(): PreconfiguredServer[] {
    const entries: PreconfiguredServer[] = [];
    const seenUrlKeys = new Set<string>();

    const append = (
        urlRaw: unknown,
        nameRaw: unknown,
        source: ServerProfileSource,
        opts: Readonly<{ idSeed?: string }> = {},
    ): void => {
        const url = normalizeUrl(String(urlRaw ?? ''));
        if (!url) return;
        const key = comparableUrlKey(url);
        if (seenUrlKeys.has(key)) return;
        seenUrlKeys.add(key);
        const name = String(nameRaw ?? '').trim();
        entries.push({ name, source, url, ...(opts.idSeed ? { idSeed: opts.idSeed } : {}) });
    };

    const rawPreconfigured = String(process.env.EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS ?? '').trim();
    if (rawPreconfigured) {
        try {
            const parsed = JSON.parse(rawPreconfigured);
            if (Array.isArray(parsed)) {
                for (const entry of parsed) {
                    if (typeof entry === 'string') {
                        append(entry, '', 'preconfigured');
                        continue;
                    }
                    if (!entry || typeof entry !== 'object') continue;
                    const record = entry as Record<string, unknown>;
                    append(record.url ?? record.serverUrl ?? '', record.name ?? '', 'preconfigured');
                }
            }
        } catch {
            // ignore malformed preconfigured JSON
        }
    }

    const rawSingleUrl = normalizeUrl(readConfiguredServerUrlEnvRaw());
    const singleUrl = normalizeUrl(readConfiguredServerUrlEnv());
    if (singleUrl) {
        const inStack = isStackContext();
        const idSeed = rawSingleUrl && rawSingleUrl !== singleUrl ? deriveServerIdFromUrl(rawSingleUrl) : undefined;
        append(singleUrl, '', inStack ? 'stack-env' : 'url', inStack ? { idSeed } : {});
    }

    // On web with no explicitly configured server, fall back to same-origin so that
    // self-hosted deployments (e.g. https://happier.example.com) get a server profile
    // without needing EXPO_PUBLIC_HAPPIER_SERVER_URL set at build time.
    if (entries.length === 0) {
        const origin = getWebSameOriginServerUrl();
        if (origin) {
            append(origin, '', 'url');
        }
    }

    // On native builds, never start "serverless": seed Happier Cloud when no preconfigured server exists.
    if (entries.length === 0 && !isWebRuntime()) {
        append('https://api.happier.dev', 'Happier Cloud', 'preconfigured');
    }

    return entries;
}

function findProfileByEquivalentUrl(servers: Record<string, ServerProfile>, serverUrl: string): ServerProfile | null {
    const targetKey = comparableUrlKey(serverUrl);
    for (const profile of Object.values(servers)) {
        if (comparableUrlKey(profile.serverUrl) === targetKey) return profile;
    }
    return null;
}

function createUniqueServerId(
    servers: Record<string, ServerProfile>,
    baseIdRaw: string,
    serverUrl: string,
): string {
    const targetUrlKey = comparableUrlKey(serverUrl);
    const baseId = String(baseIdRaw ?? '').trim() || 'custom';
    let id = baseId;
    let suffix = 2;
    while (servers[id] && comparableUrlKey(servers[id]!.serverUrl) !== targetUrlKey) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
    }
    return id;
}

function applyRuntimeSeedPolicy(servers: Record<string, ServerProfile>): Record<string, ServerProfile> {
    const next = { ...servers };
    for (const configured of parsePreconfiguredServersFromEnv()) {
        const existing = findProfileByEquivalentUrl(next, configured.url);
        if (existing) continue;

        const idSeed = String(configured.idSeed ?? '').trim();
        if (idSeed && idSeed in next) {
            const current = next[idSeed]!;
            if (
                current.source === 'stack-env'
                && configured.source === 'stack-env'
                && comparableUrlKey(current.serverUrl) !== comparableUrlKey(configured.url)
            ) {
                const now = nowMs();
                next[idSeed] = {
                    ...current,
                    serverUrl: configured.url,
                    updatedAt: now,
                };
                continue;
            }
        }

        const id = createUniqueServerId(next, idSeed || deriveServerIdFromUrl(configured.url), configured.url);
        const now = nowMs();
        next[id] = {
            id,
            name: configured.name || defaultServerNameFromUrl(configured.url) || id,
            serverUrl: configured.url,
            createdAt: now,
            updatedAt: now,
            lastUsedAt: 0,
            source: configured.source,
        };
    }
    return next;
}

function getPrimaryPreconfiguredServerId(servers: Record<string, ServerProfile>): string | null {
    for (const configured of parsePreconfiguredServersFromEnv()) {
        const existing = findProfileByEquivalentUrl(servers, configured.url);
        if (existing) return existing.id;
    }
    return null;
}

function resolvePrimaryActiveServerId(servers: Record<string, ServerProfile>, desiredId: string | null): string {
    if (desiredId && desiredId in servers) return desiredId;
    const preconfiguredId = getPrimaryPreconfiguredServerId(servers);
    if (preconfiguredId) return preconfiguredId;
    const first = Object.keys(servers)[0];
    return first ?? '';
}

function parseProfile(id: string, value: unknown): ServerProfile | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const sid = String(record.id ?? id).trim();
    const name = String(record.name ?? '').trim();
    const serverUrl = normalizeUrl(String(record.serverUrl ?? ''));
    if (!sid || !name || !serverUrl) return null;

    const rawSource = String(record.source ?? '').trim().toLowerCase();
    const source: ServerProfileSource | undefined =
        rawSource === 'manual'
            || rawSource === 'url'
            || rawSource === 'stack-env'
            || rawSource === 'notification'
            || rawSource === 'preconfigured'
            ? rawSource
            : undefined;

    return {
        id: sid,
        name,
        serverUrl,
        ...(typeof record.shareableServerUrl === 'string'
            ? { shareableServerUrl: sanitizeServerUrlForShareableLink(record.shareableServerUrl) }
            : {}),
        createdAt: Number(record.createdAt ?? 0) || 0,
        updatedAt: Number(record.updatedAt ?? 0) || 0,
        lastUsedAt: Number(record.lastUsedAt ?? 0) || 0,
        source,
    };
}

function pickPreferredEquivalentProfile(
    profiles: readonly ServerProfile[],
    opts: Readonly<{ sameOriginServerUrl: string | null; preferredServerId: string | null }>,
): ServerProfile {
    if (profiles.length === 1) return profiles[0]!;

    const sameOrigin = opts.sameOriginServerUrl ? normalizeUrl(opts.sameOriginServerUrl) : '';
    if (sameOrigin) {
        const sameOriginMatch = profiles.find((p) => normalizeUrl(p.serverUrl) === sameOrigin);
        if (sameOriginMatch) return sameOriginMatch;
    }

    const preferredId = normalizeServerId(opts.preferredServerId);
    if (preferredId) {
        const preferredMatch = profiles.find((p) => normalizeServerId(p.id) === preferredId);
        if (preferredMatch) return preferredMatch;
    }

    const sourceRank: Record<ServerProfileSource, number> = {
        'stack-env': 0,
        preconfigured: 1,
        url: 2,
        notification: 3,
        manual: 4,
    };

    return [...profiles].sort((a, b) => {
        const aRank = a.source ? (sourceRank[a.source] ?? 10) : 10;
        const bRank = b.source ? (sourceRank[b.source] ?? 10) : 10;
        if (aRank !== bRank) return aRank - bRank;

        const aUsed = Number(a.lastUsedAt ?? 0) || 0;
        const bUsed = Number(b.lastUsedAt ?? 0) || 0;
        if (aUsed !== bUsed) return bUsed - aUsed;

        const aUpdated = Number(a.updatedAt ?? 0) || 0;
        const bUpdated = Number(b.updatedAt ?? 0) || 0;
        if (aUpdated !== bUpdated) return bUpdated - aUpdated;

        const aCreated = Number(a.createdAt ?? 0) || 0;
        const bCreated = Number(b.createdAt ?? 0) || 0;
        return aCreated - bCreated;
    })[0]!;
}

function dedupeEquivalentProfiles(params: Readonly<{
    servers: Record<string, ServerProfile>;
    sameOriginServerUrl: string | null;
    preferredServerId: string | null;
}>): Readonly<{
    servers: Record<string, ServerProfile>;
    idRewrite: Map<string, string>;
    changed: boolean;
}> {
    const groupsByKey = new Map<string, ServerProfile[]>();
    for (const profile of Object.values(params.servers)) {
        const key = comparableUrlKey(profile.serverUrl) || `id:${profile.id}`;
        const group = groupsByKey.get(key);
        if (group) group.push(profile);
        else groupsByKey.set(key, [profile]);
    }

    let changed = false;
    const idRewrite = new Map<string, string>();
    const next: Record<string, ServerProfile> = {};

    for (const group of groupsByKey.values()) {
        if (group.length === 1) {
            const only = group[0]!;
            next[only.id] = only;
            continue;
        }

        changed = true;
        const preferred = pickPreferredEquivalentProfile(group, {
            sameOriginServerUrl: params.sameOriginServerUrl,
            preferredServerId: params.preferredServerId,
        });
        const merged: ServerProfile = group.reduce<ServerProfile>((acc, current) => {
            if (current.id === acc.id) return acc;
            return {
                ...acc,
                createdAt: Math.min(acc.createdAt, current.createdAt),
                updatedAt: Math.max(acc.updatedAt, current.updatedAt),
                lastUsedAt: Math.max(acc.lastUsedAt, current.lastUsedAt),
                ...(acc.shareableServerUrl ?? current.shareableServerUrl
                    ? { shareableServerUrl: acc.shareableServerUrl ?? current.shareableServerUrl ?? null }
                    : {}),
            };
        }, preferred);

        next[merged.id] = merged;

        for (const current of group) {
            if (current.id === merged.id) continue;
            idRewrite.set(current.id, merged.id);
        }
    }

    return { servers: next, idRewrite, changed };
}

function readPersistedState(): Required<PersistedServerState> {
    const raw = getPersistedStateStorage().getString(STATE_KEY);
    if (!raw) {
        const seeded = applyRuntimeSeedPolicy({});
        return {
            activeServerIdIsExplicit: false,
            activeServerId: resolvePrimaryActiveServerId(seeded, null),
            servers: seeded,
        };
    }

    try {
        const parsed = JSON.parse(raw) as PersistedServerState;
        const serversRaw = parsed?.servers && typeof parsed.servers === 'object' ? parsed.servers : {};
        const servers: Record<string, ServerProfile> = {};
        for (const [id, value] of Object.entries(serversRaw)) {
            const profile = parseProfile(id, value);
            if (!profile) continue;
            servers[profile.id] = profile;
        }
        const desiredActive = normalizeServerId(parsed.activeServerId);
        const activeServerIdIsExplicit = parsed.activeServerIdIsExplicit === true;

        const deduped = dedupeEquivalentProfiles({
            servers,
            sameOriginServerUrl: getWebSameOriginServerUrl(),
            preferredServerId: desiredActive,
        });

        const rewrittenDesiredActive =
            desiredActive && deduped.idRewrite.has(desiredActive)
                ? deduped.idRewrite.get(desiredActive)!
                : desiredActive;
        const activeServerId = resolvePrimaryActiveServerId(deduped.servers, rewrittenDesiredActive);

        const state: Required<PersistedServerState> = {
            activeServerIdIsExplicit,
            activeServerId,
            servers: deduped.servers,
        };

        if (deduped.changed) {
            writePersistedState(state);
        }

        return state;
    } catch {
        const seeded = applyRuntimeSeedPolicy({});
        return {
            activeServerIdIsExplicit: false,
            activeServerId: resolvePrimaryActiveServerId(seeded, null),
            servers: seeded,
        };
    }
}

function writePersistedState(state: Required<PersistedServerState>): void {
    getPersistedStateStorage().set(STATE_KEY, JSON.stringify(state));
}

function readTabActiveServerId(): string | null {
    if (!isWebRuntime()) return null;
    try {
        const value = (globalThis as any).sessionStorage?.getItem?.(SESSION_STORAGE_ACTIVE_ID_KEY);
        const normalized = typeof value === 'string' ? value.trim() : '';
        return normalizeServerId(normalized);
    } catch {
        return null;
    }
}

function writeTabActiveServerId(id: string | null): void {
    if (!isWebRuntime()) return;
    try {
        const sessionStorage = (globalThis as any).sessionStorage;
        if (!sessionStorage) return;
        if (id) sessionStorage.setItem(SESSION_STORAGE_ACTIVE_ID_KEY, id);
        else sessionStorage.removeItem(SESSION_STORAGE_ACTIVE_ID_KEY);
    } catch {
        // ignore
    }
}

function getWebSameOriginServerUrl(): string | null {
    if (!isWebRuntime()) return null;
    const origin = (globalThis as any).window?.location?.origin;
    if (!origin || origin === 'null') return null;
    try {
        const parsed = new URL(origin);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        // Official hosted web app (app.happier.dev) is a static SPA; the API lives on api.happier.dev.
        // When builds are missing EXPO_PUBLIC_HAPPIER_SERVER_URL (and legacy aliases), this prevents the default server
        // from incorrectly pointing at the web host.
        if (parsed.hostname.toLowerCase() === 'app.happier.dev') {
            return 'https://api.happier.dev';
        }
        return origin;
    } catch {
        return null;
    }
}

function buildActiveSnapshotFromState(state: Required<PersistedServerState>): ActiveServerSnapshot {
    const tabId = readTabActiveServerId();
    const selectedId = tabId && state.servers[tabId]
        ? tabId
        : resolvePrimaryActiveServerId(state.servers, state.activeServerId);
    const selected = selectedId ? state.servers[selectedId] : null;
    const sameOriginUrl = getWebSameOriginServerUrl();

    if (selected) {
        return {
            serverId: selected.id,
            serverUrl: selected.serverUrl,
            activeShareableServerUrl: selected.shareableServerUrl ?? null,
            activeLocalRelayUrl: sameOriginUrl && comparableUrlKey(sameOriginUrl) !== comparableUrlKey(selected.serverUrl)
                ? sameOriginUrl
                : null,
            generation: activeServerGeneration,
        };
    }

    return {
        serverId: selectedId || '',
        serverUrl: sameOriginUrl ?? '',
        activeShareableServerUrl: null,
        activeLocalRelayUrl: sameOriginUrl,
        generation: activeServerGeneration,
    };
}

function getStableActiveServerSnapshot(next: ActiveServerSnapshot): ActiveServerSnapshot {
    const cached = activeServerSnapshotCache;
    if (
        cached
        && cached.serverId === next.serverId
        && cached.serverUrl === next.serverUrl
        && (cached.activeShareableServerUrl ?? null) === (next.activeShareableServerUrl ?? null)
        && (cached.activeLocalRelayUrl ?? null) === (next.activeLocalRelayUrl ?? null)
        && cached.generation === next.generation
    ) {
        return cached;
    }
    activeServerSnapshotCache = next;
    return next;
}

function emitActiveServerChanged(previous: ActiveServerSnapshot | null): void {
    const next = getActiveServerSnapshot();
    if (
        previous
        && previous.serverId === next.serverId
        && previous.serverUrl === next.serverUrl
        && (previous.activeShareableServerUrl ?? null) === (next.activeShareableServerUrl ?? null)
        && (previous.activeLocalRelayUrl ?? null) === (next.activeLocalRelayUrl ?? null)
    ) return;
    activeServerGeneration += 1;
    const emitted: ActiveServerSnapshot = getStableActiveServerSnapshot({ ...next, generation: activeServerGeneration });
    for (const listener of activeServerListeners) listener(emitted);
}

export function listServerProfiles(): ServerProfile[] {
    return Object.values(readPersistedState().servers);
}

export function getServerProfileById(idRaw: string): ServerProfile | null {
    const id = normalizeServerId(idRaw);
    if (!id) return null;
    return readPersistedState().servers[id] ?? null;
}

export function upsertServerProfile(
    params: Readonly<{
        serverUrl: string;
        name?: string;
        source?: ServerProfileSource;
        replaceEquivalentStoredUrl?: boolean;
    }>,
): ServerProfile {
    const url = normalizeUrl(params.serverUrl);
    if (!url) throw new Error('serverUrl is required');

    const state = readPersistedState();
    const existingEquivalent = findProfileByEquivalentUrl(state.servers, url);
    const id = existingEquivalent?.id
        ?? createUniqueServerId(state.servers, deriveServerIdFromUrl(url), url);
    const existing = state.servers[id];
    const now = nowMs();

    const profile: ServerProfile = {
        id,
        name: String(
            existingEquivalent?.name
            ?? params.name
            ?? existing?.name
            ?? defaultServerNameFromUrl(url)
            ?? id,
        ).trim() || id,
        serverUrl:
            existingEquivalent && params.replaceEquivalentStoredUrl !== true
                ? existingEquivalent.serverUrl
                : url,
        ...(existingEquivalent?.shareableServerUrl
            ? { shareableServerUrl: existingEquivalent.shareableServerUrl }
            : existing?.shareableServerUrl
                ? { shareableServerUrl: existing.shareableServerUrl }
                : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        lastUsedAt: existing?.lastUsedAt ?? 0,
        source: params.source ?? existing?.source ?? 'manual',
    };

    const previousSnapshot = getActiveServerSnapshot();
    writePersistedState({
        ...state,
        servers: {
            ...state.servers,
            [id]: profile,
        },
    });
    emitActiveServerChanged(previousSnapshot);
    return profile;
}

export function setActiveServerId(
    idRaw: string,
    opts: Readonly<{ scope: 'tab' | 'device' }> = { scope: 'device' },
): void {
    const id = normalizeServerId(idRaw);
    if (!id) throw new Error('server id is required');

    const state = readPersistedState();
    if (!(id in state.servers)) {
        if (opts.scope === 'tab') {
            const previousSnapshot = getActiveServerSnapshot();
            writeTabActiveServerId(null);
            emitActiveServerChanged(previousSnapshot);
        }
        return;
    }

    const previousSnapshot = getActiveServerSnapshot();
    if (opts.scope === 'tab') {
        writeTabActiveServerId(id);
        emitActiveServerChanged(previousSnapshot);
        return;
    }

    const now = nowMs();
    const existing = state.servers[id]!;
    writeTabActiveServerId(null);
    writePersistedState({
        ...state,
        activeServerIdIsExplicit: true,
        activeServerId: id,
        servers: {
            ...state.servers,
            [id]: { ...existing, lastUsedAt: now, updatedAt: now },
        },
    });
    emitActiveServerChanged(previousSnapshot);
}

export function getResetToDefaultServerId(): string {
    const state = readPersistedState();
    const preconfiguredId = getPrimaryPreconfiguredServerId(state.servers);
    if (preconfiguredId) return preconfiguredId;
    return Object.keys(state.servers)[0] ?? '';
}

export function getTabActiveServerId(): string | null {
    return readTabActiveServerId();
}

export function getDeviceDefaultServerId(): string {
    const state = readPersistedState();
    return resolvePrimaryActiveServerId(state.servers, state.activeServerId);
}

export function getActiveServerId(): string {
    const state = readPersistedState();
    const tab = readTabActiveServerId();
    if (tab && tab in state.servers) return tab;
    return resolvePrimaryActiveServerId(state.servers, state.activeServerId);
}

export function getActiveServerUrl(): string {
    const state = readPersistedState();
    const tab = readTabActiveServerId();
    if (tab && tab in state.servers) return state.servers[tab]!.serverUrl;

    if (state.activeServerIdIsExplicit && state.activeServerId in state.servers) {
        return state.servers[state.activeServerId]!.serverUrl;
    }

    const fallbackId = resolvePrimaryActiveServerId(state.servers, state.activeServerId);
    if (fallbackId && state.servers[fallbackId]) return state.servers[fallbackId]!.serverUrl;

    const sameOrigin = getWebSameOriginServerUrl();
    if (sameOrigin) return sameOrigin;

    return '';
}

export function getActiveServerSnapshot(): ActiveServerSnapshot {
    const state = readPersistedState();
    return getStableActiveServerSnapshot(buildActiveSnapshotFromState(state));
}

export function subscribeActiveServer(listener: (snapshot: ActiveServerSnapshot) => void): () => void {
    activeServerListeners.add(listener);
    return () => {
        activeServerListeners.delete(listener);
    };
}

export function removeServerProfile(idRaw: string): void {
    const id = normalizeServerId(idRaw);
    if (!id) throw new Error('server id is required');

    const state = readPersistedState();
    if (!(id in state.servers)) throw new Error(`Server profile not found: ${id}`);

    const previousSnapshot = getActiveServerSnapshot();
    const { [id]: _removed, ...rest } = state.servers;
    const nextActive = state.activeServerId === id
        ? resolvePrimaryActiveServerId(rest, null)
        : resolvePrimaryActiveServerId(rest, state.activeServerId);
    const tab = readTabActiveServerId();
    if (tab === id) writeTabActiveServerId(null);

    writePersistedState({
        ...state,
        activeServerId: nextActive,
        activeServerIdIsExplicit: true,
        servers: rest,
    });
    emitActiveServerChanged(previousSnapshot);
}

export function renameServerProfile(idRaw: string, nameRaw: string): void {
    const id = normalizeServerId(idRaw);
    const name = String(nameRaw ?? '').trim();
    if (!id) throw new Error('server id is required');
    if (!name) throw new Error('server name is required');

    const state = readPersistedState();
    const existing = state.servers[id];
    if (!existing) throw new Error(`Server profile not found: ${id}`);

    const previousSnapshot = getActiveServerSnapshot();
    const now = nowMs();
    const updated: ServerProfile = {
        ...existing,
        name,
        updatedAt: now,
    };
    writePersistedState({
        ...state,
        servers: {
            ...state.servers,
            [id]: updated,
        },
    });
    emitActiveServerChanged(previousSnapshot);
}

export function setServerProfileShareableUrl(idRaw: string, shareableServerUrl: string | null | undefined): void {
    const id = normalizeServerId(idRaw);
    if (!id) return;

    const normalized = sanitizeServerUrlForShareableLink(shareableServerUrl ?? null);
    const state = readPersistedState();
    const existing = state.servers[id];
    if (!existing) return;
    if ((existing.shareableServerUrl ?? null) === normalized) return;

    const previousSnapshot = getActiveServerSnapshot();
    writePersistedState({
        ...state,
        servers: {
            ...state.servers,
            [id]: {
                ...existing,
                shareableServerUrl: normalized,
                updatedAt: nowMs(),
            },
        },
    });
    emitActiveServerChanged(previousSnapshot);
}

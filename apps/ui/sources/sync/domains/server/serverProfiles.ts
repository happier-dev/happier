import { MMKV } from 'react-native-mmkv';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { isStackContext } from './serverContext';
import { canonicalizeServerUrl, createServerUrlComparableKey } from './url/serverUrlCanonical';

export type ServerProfileSource = 'manual' | 'url' | 'stack-env' | 'notification' | 'preconfigured';

export type ServerProfile = Readonly<{
    id: string;
    name: string;
    serverUrl: string;
    createdAt: number;
    updatedAt: number;
    lastUsedAt: number;
    source?: ServerProfileSource;
}>;

export type ActiveServerSnapshot = Readonly<{
    serverId: string;
    serverUrl: string;
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
}>;

const SESSION_STORAGE_ACTIVE_ID_KEY = 'activeServerId';
const STATE_KEY = 'server-state-v1';

let activeServerGeneration = 0;
const activeServerListeners = new Set<(snapshot: ActiveServerSnapshot) => void>();

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

const storage = new MMKV({ id: storageId() });

function parsePreconfiguredServersFromEnv(): PreconfiguredServer[] {
    const entries: PreconfiguredServer[] = [];
    const seenUrlKeys = new Set<string>();

    const append = (urlRaw: unknown, nameRaw: unknown, source: ServerProfileSource): void => {
        const url = normalizeUrl(String(urlRaw ?? ''));
        if (!url) return;
        const key = comparableUrlKey(url);
        if (seenUrlKeys.has(key)) return;
        seenUrlKeys.add(key);
        const name = String(nameRaw ?? '').trim();
        entries.push({ name, source, url });
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

    const singleUrl = normalizeUrl(String(process.env.EXPO_PUBLIC_HAPPY_SERVER_URL ?? ''));
    if (singleUrl) {
        append(singleUrl, '', isStackContext() ? 'stack-env' : 'url');
    }

    // On web with no explicitly configured server, fall back to same-origin so that
    // self-hosted deployments (e.g. https://happier.example.com) get a server profile
    // without needing EXPO_PUBLIC_HAPPY_SERVER_URL set at build time.
    if (entries.length === 0) {
        const origin = getWebSameOriginServerUrl();
        if (origin) {
            append(origin, '', 'url');
        }
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
        const id = createUniqueServerId(next, deriveServerIdFromUrl(configured.url), configured.url);
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
        createdAt: Number(record.createdAt ?? 0) || 0,
        updatedAt: Number(record.updatedAt ?? 0) || 0,
        lastUsedAt: Number(record.lastUsedAt ?? 0) || 0,
        source,
    };
}

function readPersistedState(): Required<PersistedServerState> {
    const raw = storage.getString(STATE_KEY);
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
        const activeServerId = resolvePrimaryActiveServerId(servers, desiredActive);
        const activeServerIdIsExplicit = parsed.activeServerIdIsExplicit === true;

        return {
            activeServerIdIsExplicit,
            activeServerId,
            servers,
        };
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
    storage.set(STATE_KEY, JSON.stringify(state));
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
        // When builds are missing EXPO_PUBLIC_HAPPY_SERVER_URL, this prevents the default server
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

    if (selected) {
        return {
            serverId: selected.id,
            serverUrl: selected.serverUrl,
            generation: activeServerGeneration,
        };
    }

    return {
        serverId: selectedId || '',
        serverUrl: getWebSameOriginServerUrl() ?? '',
        generation: activeServerGeneration,
    };
}

function emitActiveServerChanged(previous: ActiveServerSnapshot | null): void {
    const next = getActiveServerSnapshot();
    if (previous && previous.serverId === next.serverId && previous.serverUrl === next.serverUrl) return;
    activeServerGeneration += 1;
    const emitted: ActiveServerSnapshot = { ...next, generation: activeServerGeneration };
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
        serverUrl: existingEquivalent?.serverUrl ?? url,
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
    return buildActiveSnapshotFromState(state);
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

import { MMKV } from 'react-native-mmkv';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/storageScope';
import {
    OFFICIAL_SERVER_DISPLAY_NAME as OFFICIAL_SERVER_DISPLAY_NAME_VALUE,
    OFFICIAL_SERVER_ID,
    OFFICIAL_SERVER_URL,
} from './serverIdentity';

export type ServerProfileKind = 'cloud' | 'stack' | 'custom';
export type ServerProfileSource = 'manual' | 'url' | 'stack-env' | 'notification';

export type ServerProfile = Readonly<{
    id: string;
    name: string;
    serverUrl: string;
    createdAt: number;
    updatedAt: number;
    lastUsedAt: number;
    kind?: ServerProfileKind;
    managed?: boolean;
    stableKey?: string;
    source?: ServerProfileSource;
}>;

export type ActiveServerSnapshot = Readonly<{
    serverId: string;
    serverUrl: string;
    kind: ServerProfileKind;
    generation: number;
}>;

type PersistedServerState = {
    activeServerIdIsExplicit?: boolean;
    activeServerId?: string;
    servers?: Record<string, ServerProfile>;
};

const OFFICIAL_ID = OFFICIAL_SERVER_ID;
const OFFICIAL_DISPLAY_NAME = OFFICIAL_SERVER_DISPLAY_NAME_VALUE;
const SESSION_STORAGE_ACTIVE_ID_KEY = 'activeServerId';

let activeServerGeneration = 0;
const activeServerListeners = new Set<(snapshot: ActiveServerSnapshot) => void>();

function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function isStackContext(): boolean {
    const raw = String(process.env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT ?? '').trim().toLowerCase();
    return raw === 'stack';
}

function shouldSeedCloudProfile(): boolean {
    return !isStackContext();
}

function normalizeUrl(raw: string): string {
    return String(raw ?? '').trim().replace(/\/+$/, '');
}

function sanitizeStableKey(raw: string): string {
    return String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_').replace(/_+/g, '_');
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

function nowMs(): number {
    return Date.now();
}

function storageId(): string {
    const scope = readStorageScopeFromEnv();
    return scopedStorageId('server-profiles', scope);
}

const storage = new MMKV({ id: storageId() });
const STATE_KEY = 'server-state-v1';

function legacyServerConfigStorage(): MMKV {
    const scope = isWebRuntime() ? null : readStorageScopeFromEnv();
    return new MMKV({ id: scopedStorageId('server-config', scope) });
}

function getCloudProfileDefaults(): ServerProfile {
    return {
        id: OFFICIAL_ID,
        name: OFFICIAL_DISPLAY_NAME,
        serverUrl: OFFICIAL_SERVER_URL,
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
        kind: 'cloud',
        managed: true,
        source: 'manual',
    };
}

function ensureCloudProfile(servers: Record<string, ServerProfile>): Record<string, ServerProfile> {
    if (!shouldSeedCloudProfile()) return servers;
    if (servers[OFFICIAL_ID]) {
        const existing = servers[OFFICIAL_ID]!;
        return {
            ...servers,
            [OFFICIAL_ID]: {
                ...existing,
                kind: existing.kind ?? 'cloud',
                managed: existing.managed ?? true,
                name: existing.name || OFFICIAL_DISPLAY_NAME,
            },
        };
    }
    return { [OFFICIAL_ID]: getCloudProfileDefaults(), ...servers };
}

function resolvePrimaryActiveServerId(servers: Record<string, ServerProfile>, desiredId: string | null): string {
    if (desiredId && desiredId in servers) return desiredId;
    if (OFFICIAL_ID in servers) return OFFICIAL_ID;
    const first = Object.keys(servers)[0];
    return first ?? OFFICIAL_ID;
}

function defaultProfileKind(profile: Pick<ServerProfile, 'id' | 'stableKey'>): ServerProfileKind {
    if (profile.id === OFFICIAL_ID) return 'cloud';
    if (profile.stableKey) return 'stack';
    return 'custom';
}

function parseProfile(id: string, value: unknown): ServerProfile | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const sid = String(record.id ?? id).trim();
    const name = String(record.name ?? '').trim();
    const serverUrl = normalizeUrl(String(record.serverUrl ?? ''));
    if (!sid || !name || !serverUrl) return null;

    const rawKind = String(record.kind ?? '').trim().toLowerCase();
    const kind: ServerProfileKind | undefined =
        rawKind === 'cloud' || rawKind === 'stack' || rawKind === 'custom' ? rawKind : undefined;

    const stableKeyRaw = String(record.stableKey ?? '').trim();
    const stableKey = stableKeyRaw ? sanitizeStableKey(stableKeyRaw) : undefined;

    const rawSource = String(record.source ?? '').trim().toLowerCase();
    const source: ServerProfileSource | undefined =
        rawSource === 'manual' || rawSource === 'url' || rawSource === 'stack-env' || rawSource === 'notification'
            ? rawSource
            : undefined;

    return {
        id: sid,
        name,
        serverUrl,
        createdAt: Number(record.createdAt ?? 0) || 0,
        updatedAt: Number(record.updatedAt ?? 0) || 0,
        lastUsedAt: Number(record.lastUsedAt ?? 0) || 0,
        kind: kind ?? defaultProfileKind({ id: sid, stableKey }),
        managed: record.managed === true,
        stableKey,
        source,
    };
}

function readPersistedState(): Required<PersistedServerState> {
    const raw = storage.getString(STATE_KEY);
    if (!raw) {
        const seeded = ensureCloudProfile({});
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

        const nextServers = ensureCloudProfile(servers);
        const desiredActive = typeof parsed.activeServerId === 'string' ? parsed.activeServerId.trim() : null;
        const activeServerId = resolvePrimaryActiveServerId(nextServers, desiredActive);
        const activeServerIdIsExplicit = parsed.activeServerIdIsExplicit === true;

        return {
            activeServerIdIsExplicit,
            activeServerId,
            servers: nextServers,
        };
    } catch {
        const seeded = ensureCloudProfile({});
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

function migrateLegacyCustomServerUrlIfPresent(): void {
    const legacy = legacyServerConfigStorage();
    const legacyUrlRaw = legacy.getString('custom-server-url');
    const legacyUrl = normalizeUrl(legacyUrlRaw ?? '');
    if (!legacyUrl) return;

    const state = readPersistedState();
    const id = deriveServerIdFromUrl(legacyUrl);
    const existing = state.servers[id];
    const now = nowMs();
    const createdAt = existing?.createdAt ?? now;
    const nextProfile: ServerProfile = {
        id,
        name: existing?.name ?? id,
        serverUrl: legacyUrl,
        createdAt,
        updatedAt: now,
        lastUsedAt: now,
        kind: existing?.kind ?? 'custom',
        managed: existing?.managed ?? false,
        source: existing?.source ?? 'manual',
    };

    const nextServers = ensureCloudProfile({ ...state.servers, [id]: nextProfile });
    writePersistedState({
        ...state,
        activeServerIdIsExplicit: true,
        activeServerId: resolvePrimaryActiveServerId(nextServers, id),
        servers: nextServers,
    });

    legacy.delete('custom-server-url');
}

let migrated = false;
function ensureMigrated(): void {
    if (migrated) return;
    migrated = true;
    migrateLegacyCustomServerUrlIfPresent();
}

function readTabActiveServerId(): string | null {
    if (!isWebRuntime()) return null;
    try {
        const value = (globalThis as any).sessionStorage?.getItem?.(SESSION_STORAGE_ACTIVE_ID_KEY);
        const normalized = typeof value === 'string' ? value.trim() : '';
        return normalized || null;
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
        return origin;
    } catch {
        return null;
    }
}

function buildActiveSnapshotFromState(state: Required<PersistedServerState>): ActiveServerSnapshot {
    const tabId = readTabActiveServerId();
    const selectedId = tabId && state.servers[tabId] ? tabId : resolvePrimaryActiveServerId(state.servers, state.activeServerId);
    const selected = state.servers[selectedId];

    if (selected) {
        return {
            serverId: selected.id,
            serverUrl: selected.serverUrl,
            kind: selected.kind ?? defaultProfileKind(selected),
            generation: activeServerGeneration,
        };
    }

    const envUrl = normalizeUrl(String(process.env.EXPO_PUBLIC_HAPPY_SERVER_URL ?? ''));
    const fallbackUrl = envUrl || getWebSameOriginServerUrl() || OFFICIAL_SERVER_URL;
    return {
        serverId: selectedId,
        serverUrl: fallbackUrl,
        kind: defaultProfileKind({ id: selectedId, stableKey: undefined }),
        generation: activeServerGeneration,
    };
}

function emitActiveServerChanged(previous: ActiveServerSnapshot | null): void {
    const next = getActiveServerSnapshot();
    if (previous && previous.serverId === next.serverId && previous.serverUrl === next.serverUrl) {
        return;
    }
    activeServerGeneration += 1;
    const emitted: ActiveServerSnapshot = { ...next, generation: activeServerGeneration };
    for (const listener of activeServerListeners) {
        listener(emitted);
    }
}

function findProfileByStableKey(servers: Record<string, ServerProfile>, stableKey: string): ServerProfile | null {
    for (const profile of Object.values(servers)) {
        if (profile.stableKey && sanitizeStableKey(profile.stableKey) === stableKey) {
            return profile;
        }
    }
    return null;
}

export function listServerProfiles(): ServerProfile[] {
    ensureMigrated();
    return Object.values(readPersistedState().servers);
}

export function getServerProfileById(idRaw: string): ServerProfile | null {
    ensureMigrated();
    const id = String(idRaw ?? '').trim();
    if (!id) return null;
    return readPersistedState().servers[id] ?? null;
}

export function upsertServerProfile(
    params: Readonly<{
        serverUrl: string;
        name?: string;
        kind?: ServerProfileKind;
        managed?: boolean;
        stableKey?: string;
        source?: ServerProfileSource;
    }>,
): ServerProfile {
    ensureMigrated();
    const url = normalizeUrl(params.serverUrl);
    if (!url) throw new Error('serverUrl is required');

    const state = readPersistedState();
    const normalizedStableKey = params.stableKey ? sanitizeStableKey(params.stableKey) : '';
    const existingStable = normalizedStableKey ? findProfileByStableKey(state.servers, normalizedStableKey) : null;
    const id = existingStable?.id ?? (normalizedStableKey ? `stack_${normalizedStableKey}` : deriveServerIdFromUrl(url));
    const existing = state.servers[id];

    const now = nowMs();
    const createdAt = existing?.createdAt ?? now;
    const kind: ServerProfileKind = params.kind
        ?? existing?.kind
        ?? (normalizedStableKey ? 'stack' : id === OFFICIAL_ID ? 'cloud' : 'custom');
    const managed = params.managed ?? existing?.managed ?? (kind === 'stack');
    const source = params.source ?? existing?.source ?? 'manual';

    const profile: ServerProfile = {
        id,
        name: String(params.name ?? existing?.name ?? id).trim() || id,
        serverUrl: url,
        createdAt,
        updatedAt: now,
        lastUsedAt: existing?.lastUsedAt ?? 0,
        kind,
        managed,
        stableKey: normalizedStableKey || existing?.stableKey,
        source,
    };

    const previousSnapshot = getActiveServerSnapshot();
    writePersistedState({
        ...state,
        servers: ensureCloudProfile({ ...state.servers, [id]: profile }),
    });
    emitActiveServerChanged(previousSnapshot);
    return profile;
}

export function setActiveServerId(
    idRaw: string,
    opts: Readonly<{ scope: 'tab' | 'device' }> = { scope: 'device' },
): void {
    ensureMigrated();
    const id = String(idRaw ?? '').trim();
    if (!id) throw new Error('server id is required');

    const state = readPersistedState();
    if (!(id in state.servers)) throw new Error(`Unknown server id: ${id}`);

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

export function getActiveServerId(): string {
    ensureMigrated();
    const state = readPersistedState();
    const tab = readTabActiveServerId();
    if (tab && tab in state.servers) return tab;
    return resolvePrimaryActiveServerId(state.servers, state.activeServerId);
}

export function getActiveServerUrl(): string {
    ensureMigrated();
    const state = readPersistedState();

    const tab = readTabActiveServerId();
    if (tab && tab in state.servers) {
        return state.servers[tab]!.serverUrl;
    }

    if (state.activeServerIdIsExplicit && state.activeServerId in state.servers) {
        return state.servers[state.activeServerId]!.serverUrl;
    }

    const envUrl = normalizeUrl(String(process.env.EXPO_PUBLIC_HAPPY_SERVER_URL ?? ''));
    if (envUrl) return envUrl;

    const sameOrigin = getWebSameOriginServerUrl();
    if (sameOrigin) return sameOrigin;

    if (state.servers[OFFICIAL_ID]?.serverUrl) {
        return state.servers[OFFICIAL_ID]!.serverUrl;
    }

    return OFFICIAL_SERVER_URL;
}

export function getActiveServerSnapshot(): ActiveServerSnapshot {
    ensureMigrated();
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
    ensureMigrated();
    const id = String(idRaw ?? '').trim();
    if (!id) throw new Error('server id is required');
    if (id === OFFICIAL_ID) throw new Error('Cannot remove the Happier Cloud server profile');

    const state = readPersistedState();
    if (!(id in state.servers)) throw new Error(`Server profile not found: ${id}`);

    const previousSnapshot = getActiveServerSnapshot();
    const { [id]: _removed, ...rest } = state.servers;
    const nextServers = ensureCloudProfile(rest);
    const nextActive = state.activeServerId === id
        ? resolvePrimaryActiveServerId(nextServers, null)
        : resolvePrimaryActiveServerId(nextServers, state.activeServerId);

    const tab = readTabActiveServerId();
    if (tab === id) writeTabActiveServerId(null);

    writePersistedState({
        ...state,
        activeServerId: nextActive,
        activeServerIdIsExplicit: true,
        servers: nextServers,
    });
    emitActiveServerChanged(previousSnapshot);
}

export function renameServerProfile(idRaw: string, nameRaw: string): void {
    ensureMigrated();
    const id = String(idRaw ?? '').trim();
    const name = String(nameRaw ?? '').trim();
    if (!id) throw new Error('server id is required');
    if (!name) throw new Error('server name is required');
    if (id === OFFICIAL_ID) throw new Error('Cannot rename the Happier Cloud server profile');

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

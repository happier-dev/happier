import { MMKV } from 'react-native-mmkv';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/storageScope';

export type ServerProfile = Readonly<{
    id: string;
    name: string;
    serverUrl: string;
    createdAt: number;
    updatedAt: number;
    lastUsedAt: number;
}>;

type PersistedServerState = {
    // When true, the device selection should take priority over runtime env defaults.
    activeServerIdIsExplicit?: boolean;
    activeServerId?: string;
    servers?: Record<string, ServerProfile>;
};

const OFFICIAL_ID = 'official';
const OFFICIAL_SERVER_URL = 'https://api.happier.dev';
const SESSION_STORAGE_ACTIVE_ID_KEY = 'activeServerId';

function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function normalizeUrl(raw: string): string {
    return String(raw ?? '').trim().replace(/\/+$/, '');
}

function deriveServerIdFromUrl(serverUrl: string): string {
    const normalized = normalizeUrl(serverUrl);
    try {
        const url = new URL(normalized);
        const host = url.hostname.toLowerCase();
        const port = url.port ? `-${url.port}` : '';
        const base = `${host}${port}`;
        // Filesystem safe (and safe for MMKV/session keys)
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
    // Back-compat: serverConfig.ts historically used a different scoping strategy on web.
    const scope = isWebRuntime() ? null : readStorageScopeFromEnv();
    return new MMKV({ id: scopedStorageId('server-config', scope) });
}

function ensureOfficial(servers: Record<string, ServerProfile>): Record<string, ServerProfile> {
    if (servers[OFFICIAL_ID]) return servers;
    const official: ServerProfile = {
        id: OFFICIAL_ID,
        name: 'Happier (Official)',
        serverUrl: OFFICIAL_SERVER_URL,
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
    };
    return { [OFFICIAL_ID]: official, ...servers };
}

function readPersistedState(): Required<PersistedServerState> {
    const raw = storage.getString(STATE_KEY);
    if (!raw) {
        return {
            activeServerIdIsExplicit: false,
            activeServerId: OFFICIAL_ID,
            servers: ensureOfficial({}),
        };
    }

    try {
        const parsed = JSON.parse(raw) as PersistedServerState;
        const serversRaw = parsed?.servers && typeof parsed.servers === 'object' ? parsed.servers : {};
        const servers: Record<string, ServerProfile> = {};
        for (const [id, v] of Object.entries(serversRaw)) {
            if (!v || typeof v !== 'object') continue;
            const sid = String((v as any).id ?? id).trim();
            const name = String((v as any).name ?? '').trim();
            const serverUrl = normalizeUrl((v as any).serverUrl ?? '');
            if (!sid || !name || !serverUrl) continue;
            servers[sid] = {
                id: sid,
                name,
                serverUrl,
                createdAt: Number((v as any).createdAt ?? 0) || 0,
                updatedAt: Number((v as any).updatedAt ?? 0) || 0,
                lastUsedAt: Number((v as any).lastUsedAt ?? 0) || 0,
            };
        }

        const withOfficial = ensureOfficial(servers);
        const activeServerId = typeof parsed.activeServerId === 'string' && parsed.activeServerId.trim()
            ? parsed.activeServerId.trim()
            : OFFICIAL_ID;
        const activeServerIdIsExplicit = parsed.activeServerIdIsExplicit === true;

        return {
            activeServerIdIsExplicit,
            activeServerId: activeServerId in withOfficial ? activeServerId : OFFICIAL_ID,
            servers: withOfficial,
        };
    } catch {
        return {
            activeServerIdIsExplicit: false,
            activeServerId: OFFICIAL_ID,
            servers: ensureOfficial({}),
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
    };

    writePersistedState({
        ...state,
        activeServerIdIsExplicit: true,
        activeServerId: id,
        servers: ensureOfficial({ ...state.servers, [id]: nextProfile }),
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
        const v = (globalThis as any).sessionStorage?.getItem?.(SESSION_STORAGE_ACTIVE_ID_KEY);
        const s = typeof v === 'string' ? v.trim() : '';
        return s || null;
    } catch {
        return null;
    }
}

function writeTabActiveServerId(id: string | null): void {
    if (!isWebRuntime()) return;
    try {
        const ss = (globalThis as any).sessionStorage;
        if (!ss) return;
        if (id) ss.setItem(SESSION_STORAGE_ACTIVE_ID_KEY, id);
        else ss.removeItem(SESSION_STORAGE_ACTIVE_ID_KEY);
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

export function listServerProfiles(): ServerProfile[] {
    ensureMigrated();
    const state = readPersistedState();
    return Object.values(state.servers);
}

export function upsertServerProfile(params: Readonly<{ serverUrl: string; name?: string }>): ServerProfile {
    ensureMigrated();
    const url = normalizeUrl(params.serverUrl);
    if (!url) {
        throw new Error('serverUrl is required');
    }

    const id = deriveServerIdFromUrl(url);
    const state = readPersistedState();
    const existing = state.servers[id];
    const now = nowMs();
    const createdAt = existing?.createdAt ?? now;
    const profile: ServerProfile = {
        id,
        name: String(params.name ?? existing?.name ?? id).trim() || id,
        serverUrl: url,
        createdAt,
        updatedAt: now,
        lastUsedAt: existing?.lastUsedAt ?? 0,
    };

    writePersistedState({
        ...state,
        servers: ensureOfficial({ ...state.servers, [id]: profile }),
    });
    return profile;
}

export function setActiveServerId(
    idRaw: string,
    opts: Readonly<{ scope: 'tab' | 'device' }> = { scope: 'device' },
): void {
    ensureMigrated();
    const id = String(idRaw ?? '').trim();
    if (!id) throw new Error('server id is required');

    if (opts.scope === 'tab') {
        const state = readPersistedState();
        if (!(id in state.servers)) throw new Error(`Unknown server id: ${id}`);
        writeTabActiveServerId(id);
        return;
    }

    const state = readPersistedState();
    if (!(id in state.servers)) throw new Error(`Unknown server id: ${id}`);
    const now = nowMs();
    const existing = state.servers[id];
    writePersistedState({
        ...state,
        activeServerIdIsExplicit: true,
        activeServerId: id,
        servers: {
            ...state.servers,
            [id]: { ...existing, lastUsedAt: now, updatedAt: now },
        },
    });
}

export function getActiveServerId(): string {
    ensureMigrated();
    const state = readPersistedState();
    const tab = readTabActiveServerId();
    if (tab && tab in state.servers) return tab;
    return state.activeServerId;
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

    const envUrl = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL;
    if (typeof envUrl === 'string' && envUrl.trim()) {
        return normalizeUrl(envUrl);
    }

    const sameOrigin = getWebSameOriginServerUrl();
    if (sameOrigin) return sameOrigin;

    return OFFICIAL_SERVER_URL;
}

export function removeServerProfile(idRaw: string): void {
    ensureMigrated();
    const id = String(idRaw ?? '').trim();
    if (!id) throw new Error('server id is required');
    if (id === OFFICIAL_ID) throw new Error('Cannot remove the official server profile');

    const state = readPersistedState();
    if (!(id in state.servers)) throw new Error(`Server profile not found: ${id}`);

    const { [id]: _removed, ...rest } = state.servers;
    const nextServers = ensureOfficial(rest);
    const nextActive = state.activeServerId === id ? OFFICIAL_ID : state.activeServerId;
    const nextExplicit = state.activeServerId === id ? true : state.activeServerIdIsExplicit;

    // If the tab override pointed at this server, clear it.
    const tab = readTabActiveServerId();
    if (tab === id) writeTabActiveServerId(null);

    writePersistedState({
        ...state,
        activeServerId: nextActive in nextServers ? nextActive : OFFICIAL_ID,
        activeServerIdIsExplicit: nextExplicit,
        servers: nextServers,
    });
}

export function renameServerProfile(idRaw: string, nameRaw: string): void {
    ensureMigrated();
    const id = String(idRaw ?? '').trim();
    const name = String(nameRaw ?? '').trim();
    if (!id) throw new Error('server id is required');
    if (!name) throw new Error('server name is required');
    if (id === OFFICIAL_ID) throw new Error('Cannot rename the official server profile');

    const state = readPersistedState();
    const existing = state.servers[id];
    if (!existing) throw new Error(`Server profile not found: ${id}`);

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
}

import { MMKV } from 'react-native-mmkv';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import {
    CLOUD_SERVER_DISPLAY_NAME,
    CLOUD_SERVER_ID,
    CLOUD_SERVER_URL,
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

const CLOUD_ID = CLOUD_SERVER_ID;
const CLOUD_DISPLAY_NAME = CLOUD_SERVER_DISPLAY_NAME;
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

function normalizeServerId(raw: unknown): string | null {
    const id = String(raw ?? '').trim();
    if (!id) return null;
    return id;
}

function ensureStackEnvProfile(servers: Record<string, ServerProfile>): Record<string, ServerProfile> {
    if (!isStackContext()) return servers;
    const envUrl = normalizeUrl(String(process.env.EXPO_PUBLIC_HAPPY_SERVER_URL ?? ''));
    if (!envUrl) return servers;

    const existingEquivalent = findProfileByEquivalentUrl(servers, envUrl);
    const id = existingEquivalent?.id ?? deriveServerIdFromUrl(envUrl);
    const now = nowMs();
    const createdAt = existingEquivalent?.createdAt ?? now;
    const profile: ServerProfile = {
        id,
        name: existingEquivalent?.name ?? id,
        serverUrl: existingEquivalent?.serverUrl ?? envUrl,
        createdAt,
        updatedAt: now,
        lastUsedAt: existingEquivalent?.lastUsedAt ?? 0,
        kind: 'stack',
        managed: true,
        stableKey: existingEquivalent?.stableKey,
        source: 'stack-env',
    };
    return { ...servers, [id]: profile };
}

function normalizeLoopbackHost(rawHost: string): string {
    const host = String(rawHost ?? '').trim().toLowerCase();
    if (host === '127.0.0.1' || host === '::1' || host === '[::1]') {
        return 'localhost';
    }
    return host;
}

function comparableUrlKey(rawUrl: string): string {
    const normalized = normalizeUrl(rawUrl);
    try {
        const parsed = new URL(normalized);
        const protocol = parsed.protocol.toLowerCase();
        const host = normalizeLoopbackHost(parsed.hostname);
        const port = parsed.port ? `:${parsed.port}` : '';
        const path = parsed.pathname.replace(/\/+$/, '');
        const search = parsed.search;
        return `${protocol}//${host}${port}${path}${search}`;
    } catch {
        return normalized.toLowerCase();
    }
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

function getCloudProfileDefaults(): ServerProfile {
    return {
        id: CLOUD_ID,
        name: CLOUD_DISPLAY_NAME,
        serverUrl: CLOUD_SERVER_URL,
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
    if (servers[CLOUD_ID]) {
        const existing = servers[CLOUD_ID]!;
        return {
            ...servers,
            [CLOUD_ID]: {
                ...existing,
                kind: existing.kind ?? 'cloud',
                managed: existing.managed ?? true,
                name: existing.name || CLOUD_DISPLAY_NAME,
            },
        };
    }
    return { [CLOUD_ID]: getCloudProfileDefaults(), ...servers };
}

function applyCloudProfilePolicy(servers: Record<string, ServerProfile>): Record<string, ServerProfile> {
    if (shouldSeedCloudProfile()) return ensureCloudProfile(servers);
    // Stack context: do not auto-seed the cloud profile, but also do not delete it if the user already saved it.
    return servers;
}

function applyRuntimeSeedPolicy(servers: Record<string, ServerProfile>): Record<string, ServerProfile> {
    const withStackEnv = ensureStackEnvProfile(servers);
    return applyCloudProfilePolicy(withStackEnv);
}

function resolvePrimaryActiveServerId(servers: Record<string, ServerProfile>, desiredId: string | null): string {
    if (desiredId && desiredId in servers) return desiredId;
    if (CLOUD_ID in servers) return CLOUD_ID;
    const first = Object.keys(servers)[0];
    return first ?? CLOUD_ID;
}

function defaultProfileKind(profile: Pick<ServerProfile, 'id' | 'stableKey'>): ServerProfileKind {
    if (profile.id === CLOUD_ID) return 'cloud';
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

        const nextServers = applyRuntimeSeedPolicy(servers);
        const desiredActive = normalizeServerId(parsed.activeServerId);
        const activeServerId = resolvePrimaryActiveServerId(nextServers, desiredActive);
        const activeServerIdIsExplicit = parsed.activeServerIdIsExplicit === true;

        return {
            activeServerIdIsExplicit,
            activeServerId,
            servers: nextServers,
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
    const fallbackUrl = envUrl || getWebSameOriginServerUrl() || CLOUD_SERVER_URL;
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

function findProfileByEquivalentUrl(servers: Record<string, ServerProfile>, serverUrl: string): ServerProfile | null {
    const targetKey = comparableUrlKey(serverUrl);
    for (const profile of Object.values(servers)) {
        if (comparableUrlKey(profile.serverUrl) === targetKey) {
            return profile;
        }
    }
    return null;
}

export function listServerProfiles(): ServerProfile[] {
    return Object.values(readPersistedState().servers);
}

export function getServerProfileById(idRaw: string): ServerProfile | null {
    const id = normalizeServerId(idRaw);
    if (!id) return null;
    return readPersistedState().servers[id] ?? null;
}

export function isCloudServerProfileId(idRaw: string): boolean {
    return normalizeServerId(idRaw) === CLOUD_ID;
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
    const url = normalizeUrl(params.serverUrl);
    if (!url) throw new Error('serverUrl is required');

    const state = readPersistedState();
    const normalizedStableKey = params.stableKey ? sanitizeStableKey(params.stableKey) : '';
    const isCloudUrl = !normalizedStableKey && comparableUrlKey(url) === comparableUrlKey(CLOUD_SERVER_URL);
    const existingStable = normalizedStableKey ? findProfileByStableKey(state.servers, normalizedStableKey) : null;
    const existingEquivalent = normalizedStableKey ? null : findProfileByEquivalentUrl(state.servers, url);
    const id = existingStable?.id
        ?? existingEquivalent?.id
        ?? (normalizedStableKey ? `stack_${normalizedStableKey}` : isCloudUrl ? CLOUD_ID : deriveServerIdFromUrl(url));
    const existing = state.servers[id];

    const now = nowMs();
    const createdAt = existing?.createdAt ?? now;
    const kind: ServerProfileKind = params.kind
        ?? existing?.kind
        ?? (normalizedStableKey ? 'stack' : id === CLOUD_ID ? 'cloud' : 'custom');
    const managed = params.managed ?? existing?.managed ?? (kind === 'stack' || id === CLOUD_ID);
    const source = params.source ?? existing?.source ?? 'manual';
    const resolvedName = String(
        existingEquivalent?.name
        ?? params.name
        ?? existing?.name
        ?? (id === CLOUD_ID ? CLOUD_DISPLAY_NAME : id),
    ).trim() || id;

    const profile: ServerProfile = {
        id,
        name: id === CLOUD_ID ? CLOUD_DISPLAY_NAME : resolvedName,
        serverUrl: id === CLOUD_ID ? CLOUD_SERVER_URL : (existingEquivalent?.serverUrl ?? url),
        createdAt,
        updatedAt: now,
        lastUsedAt: existing?.lastUsedAt ?? 0,
        kind: id === CLOUD_ID ? 'cloud' : kind,
        managed: id === CLOUD_ID ? true : managed,
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
    const id = normalizeServerId(idRaw);
    if (!id) throw new Error('server id is required');

    const state = readPersistedState();
    if (!(id in state.servers)) {
        // Unknown ids can happen if a tab persisted a stale server id or if settings were corrupted.
        // We treat this as a no-op rather than crashing the UI.
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
    // In normal (non-stack) environments, resetting means returning to the Happier Cloud profile.
    if (shouldSeedCloudProfile()) return CLOUD_ID;

    // In stack context, "default" is the stack server URL from env (not the Cloud endpoint).
    const envUrl = normalizeUrl(String(process.env.EXPO_PUBLIC_HAPPY_SERVER_URL ?? ''));
    if (envUrl) {
        const profile = upsertServerProfile({ serverUrl: envUrl, kind: 'stack', managed: true, source: 'stack-env' });
        return profile.id;
    }

    // As a last resort, fall back to the first known profile if one exists.
    const state = readPersistedState();
    return Object.keys(state.servers)[0] ?? CLOUD_ID;
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

    if (state.servers[CLOUD_ID]?.serverUrl) {
        return state.servers[CLOUD_ID]!.serverUrl;
    }

    return CLOUD_SERVER_URL;
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
    if (id === CLOUD_ID) throw new Error('Cannot remove the Happier Cloud server profile');

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
    const id = normalizeServerId(idRaw);
    const name = String(nameRaw ?? '').trim();
    if (!id) throw new Error('server id is required');
    if (!name) throw new Error('server name is required');
    if (id === CLOUD_ID) throw new Error('Cannot rename the Happier Cloud server profile');

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

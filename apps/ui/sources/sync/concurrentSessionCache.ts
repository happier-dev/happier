import { io, Socket } from 'socket.io-client';
import { TokenStorage, type AuthCredentials } from '@/auth/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { Encryption } from './encryption/encryption';
import { fetchAndApplyMachines } from './engine/machines';
import { fetchAndApplySessions } from './engine/sessionsSnapshot';
import { getEffectiveServerSelection } from './multiServer';
import { listServerProfiles } from './serverProfiles';
import { getActiveServerSnapshot, subscribeActiveServer } from './serverRuntime';
import { buildSessionListViewData, type SessionListViewItem } from './sessionListViewData';
import { storage } from './storageStore';
import { setServerSessionListCache } from './store/sessionListCache';
import type { Machine, Session } from './storageTypes';

type ConcurrentTarget = Readonly<{
    id: string;
    serverUrl: string;
    serverName: string;
}>;

type ConcurrentSelectionSettings = Readonly<{
    multiServerEnabled: boolean;
    multiServerSelectedServerIds: string[];
    multiServerPresentation: 'grouped' | 'flat-with-badge';
    multiServerProfiles?: Array<{
        id: string;
        name: string;
        serverIds: string[];
        presentation?: 'grouped' | 'flat-with-badge';
    }>;
    multiServerActiveProfileId?: string | null;
}>;

type ManagedConcurrentServer = {
    id: string;
    serverUrl: string;
    serverName: string;
    credentials: AuthCredentials;
    socket: Socket;
    encryption: Encryption | null;
    refreshQueued: boolean;
    refreshInFlight: Promise<void> | null;
    refreshTimer: ReturnType<typeof setTimeout> | null;
};

const REFRESH_DEBOUNCE_MS = 600;
const REFRESH_INTERVAL_MS = 30000;

const managedServers = new Map<string, ManagedConcurrentServer>();
let started = false;
let storageUnsubscribe: (() => void) | null = null;
let activeServerUnsubscribe: (() => void) | null = null;
let periodicRefreshTimer: ReturnType<typeof setInterval> | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeServerUrl(url: string): string {
    return String(url ?? '').trim().replace(/\/+$/, '');
}

function createServerRequest(serverUrl: string): (path: string, init: RequestInit) => Promise<Response> {
    const normalized = normalizeServerUrl(serverUrl);
    return async (path: string, init: RequestInit) => {
        const requestPath = String(path ?? '').startsWith('/') ? String(path) : `/${String(path ?? '')}`;
        return await fetch(`${normalized}${requestPath}`, init);
    };
}

export function resolveConcurrentTargets(params: Readonly<{
    activeServerId: string;
    profiles: ReadonlyArray<Readonly<{ id: string; serverUrl: string; name: string }>>;
    settings: ConcurrentSelectionSettings;
}>): ConcurrentTarget[] {
    const selection = getEffectiveServerSelection({
        activeServerId: params.activeServerId,
        availableServerIds: params.profiles.map((profile) => profile.id),
        settings: params.settings,
    });
    const selected = new Set(selection.serverIds);
    selected.delete(params.activeServerId);
    if (selected.size === 0) {
        return [];
    }
    const targets: ConcurrentTarget[] = [];
    for (const profile of params.profiles) {
        if (!selected.has(profile.id)) continue;
        const serverUrl = normalizeServerUrl(profile.serverUrl);
        if (!serverUrl) continue;
        targets.push({
            id: profile.id,
            serverUrl,
            serverName: String(profile.name ?? profile.id).trim() || profile.id,
        });
    }
    return targets;
}

async function getOrCreateEncryption(entry: ManagedConcurrentServer): Promise<Encryption> {
    if (entry.encryption) return entry.encryption;
    const secret = decodeBase64(entry.credentials.secret, 'base64url');
    if (secret.length !== 32) {
        throw new Error(`Invalid secret key length: ${secret.length}, expected 32`);
    }
    entry.encryption = await Encryption.create(secret);
    return entry.encryption;
}

function updateConcurrentSessionListCache(serverId: string, sessionListViewData: SessionListViewItem[] | null): void {
    storage.setState((state) => ({
        ...state,
        sessionListViewDataByServerId: setServerSessionListCache(
            state.sessionListViewDataByServerId,
            serverId,
            sessionListViewData,
        ),
    }));
}

async function refreshServerSnapshot(entry: ManagedConcurrentServer): Promise<void> {
    const encryption = await getOrCreateEncryption(entry);
    const request = createServerRequest(entry.serverUrl);
    const sessionDataKeys = new Map<string, Uint8Array>();
    const machineDataKeys = new Map<string, Uint8Array>();
    let sessions: Session[] = [];
    let machines: Machine[] = [];

    await fetchAndApplySessions({
        credentials: entry.credentials,
        encryption,
        sessionDataKeys,
        request,
        applySessions: (nextSessions) => {
            sessions = nextSessions as Session[];
        },
        repairInvalidReadStateV1: async () => {},
        log: { log: () => {} },
    });

    await fetchAndApplyMachines({
        credentials: entry.credentials,
        encryption,
        machineDataKeys,
        request,
        applyMachines: (nextMachines) => {
            machines = nextMachines;
        },
    });

    const sessionsById: Record<string, Session> = {};
    for (const session of sessions) {
        sessionsById[session.id] = session;
    }

    const machinesById: Record<string, Machine> = {};
    for (const machine of machines) {
        machinesById[machine.id] = machine;
    }

    const sessionListViewData = buildSessionListViewData(
        sessionsById,
        machinesById,
        {
            groupInactiveSessionsByProject: Boolean(storage.getState().settings.groupInactiveSessionsByProject),
            serverScope: {
                serverId: entry.id,
                serverName: entry.serverName,
            },
        },
    );

    updateConcurrentSessionListCache(entry.id, sessionListViewData);
}

function queueRefresh(entry: ManagedConcurrentServer): void {
    if (entry.refreshTimer) return;
    entry.refreshTimer = setTimeout(() => {
        entry.refreshTimer = null;
        void runRefresh(entry);
    }, REFRESH_DEBOUNCE_MS);
}

async function runRefresh(entry: ManagedConcurrentServer): Promise<void> {
    if (entry.refreshInFlight) {
        entry.refreshQueued = true;
        return;
    }
    entry.refreshInFlight = (async () => {
        try {
            await refreshServerSnapshot(entry);
        } catch {
            // Keep best-effort behavior for non-active server cache refreshes.
        }
    })();
    try {
        await entry.refreshInFlight;
    } finally {
        entry.refreshInFlight = null;
        if (entry.refreshQueued) {
            entry.refreshQueued = false;
            queueRefresh(entry);
        }
    }
}

function stopManagedServer(serverId: string): void {
    const entry = managedServers.get(serverId);
    if (!entry) return;
    if (entry.refreshTimer) {
        clearTimeout(entry.refreshTimer);
    }
    entry.socket.disconnect();
    managedServers.delete(serverId);
}

function createManagedServer(target: ConcurrentTarget, credentials: AuthCredentials): ManagedConcurrentServer {
    const socket = io(target.serverUrl, {
        path: '/v1/updates',
        auth: {
            token: credentials.token,
            clientType: 'user-scoped' as const,
        },
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity,
    });

    const entry: ManagedConcurrentServer = {
        id: target.id,
        serverUrl: target.serverUrl,
        serverName: target.serverName,
        credentials,
        socket,
        encryption: null,
        refreshQueued: false,
        refreshInFlight: null,
        refreshTimer: null,
    };

    socket.on('connect', () => {
        queueRefresh(entry);
    });
    socket.onAny(() => {
        queueRefresh(entry);
    });

    return entry;
}

async function reconcileConcurrentServers(): Promise<void> {
    if (!started) return;
    const profiles = listServerProfiles();
    const activeServerId = getActiveServerSnapshot().serverId;
    const settings = storage.getState().settings;
    const targets = resolveConcurrentTargets({
        activeServerId,
        profiles: profiles.map((profile) => ({
            id: profile.id,
            serverUrl: profile.serverUrl,
            name: profile.name,
        })),
        settings: {
            multiServerEnabled: Boolean(settings.multiServerEnabled),
            multiServerSelectedServerIds: Array.isArray(settings.multiServerSelectedServerIds)
                ? settings.multiServerSelectedServerIds
                : [],
            multiServerPresentation:
                settings.multiServerPresentation === 'flat-with-badge' ? 'flat-with-badge' : 'grouped',
            multiServerProfiles: Array.isArray(settings.multiServerProfiles) ? (settings.multiServerProfiles as any) : [],
            multiServerActiveProfileId: typeof settings.multiServerActiveProfileId === 'string'
                ? settings.multiServerActiveProfileId
                : null,
        },
    });

    const desiredById = new Map(targets.map((target) => [target.id, target]));

    for (const existingId of Array.from(managedServers.keys())) {
        if (!desiredById.has(existingId)) {
            stopManagedServer(existingId);
        }
    }

    for (const target of targets) {
        const credentials = await TokenStorage.getCredentialsForServerUrl(target.serverUrl);
        if (!credentials) {
            stopManagedServer(target.id);
            updateConcurrentSessionListCache(target.id, null);
            continue;
        }

        const existing = managedServers.get(target.id);
        if (
            existing
            && existing.serverUrl === target.serverUrl
            && existing.credentials.token === credentials.token
            && existing.credentials.secret === credentials.secret
        ) {
            existing.serverName = target.serverName;
            continue;
        }

        if (existing) {
            stopManagedServer(target.id);
        }
        const next = createManagedServer(target, credentials);
        managedServers.set(target.id, next);
        queueRefresh(next);
    }
}

function scheduleReconcile(): void {
    if (!started) return;
    if (reconcileTimer) return;
    reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        void reconcileConcurrentServers();
    }, 0);
}

export function startConcurrentSessionCacheSync(): void {
    if (started) return;
    started = true;

    let lastConfigKey = '';
    storageUnsubscribe = storage.subscribe((state) => {
        const key = JSON.stringify({
            multiServerEnabled: Boolean(state.settings.multiServerEnabled),
            multiServerSelectedServerIds: Array.isArray(state.settings.multiServerSelectedServerIds)
                ? state.settings.multiServerSelectedServerIds
                : [],
            multiServerPresentation: state.settings.multiServerPresentation,
            multiServerProfiles: Array.isArray(state.settings.multiServerProfiles) ? state.settings.multiServerProfiles : [],
            multiServerActiveProfileId: state.settings.multiServerActiveProfileId ?? null,
        });
        if (key === lastConfigKey) return;
        lastConfigKey = key;
        scheduleReconcile();
    });

    activeServerUnsubscribe = subscribeActiveServer(() => {
        scheduleReconcile();
    });

    periodicRefreshTimer = setInterval(() => {
        for (const entry of managedServers.values()) {
            queueRefresh(entry);
        }
        scheduleReconcile();
    }, REFRESH_INTERVAL_MS);

    scheduleReconcile();
}

export function stopConcurrentSessionCacheSync(): void {
    if (!started) return;
    started = false;

    if (reconcileTimer) {
        clearTimeout(reconcileTimer);
        reconcileTimer = null;
    }
    if (periodicRefreshTimer) {
        clearInterval(periodicRefreshTimer);
        periodicRefreshTimer = null;
    }
    if (storageUnsubscribe) {
        storageUnsubscribe();
        storageUnsubscribe = null;
    }
    if (activeServerUnsubscribe) {
        activeServerUnsubscribe();
        activeServerUnsubscribe = null;
    }

    for (const serverId of Array.from(managedServers.keys())) {
        stopManagedServer(serverId);
    }
}

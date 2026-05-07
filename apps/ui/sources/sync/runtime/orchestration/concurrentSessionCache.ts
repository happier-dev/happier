import { TokenStorage, type AuthCredentials, isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';
import { Encryption } from '@/sync/encryption/encryption';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { fetchAndApplyMachines } from '@/sync/engine/machines/syncMachines';
import { fetchAndApplySessions } from '@/sync/engine/sessions/sessionSnapshot';
import { getEffectiveServerSelectionFromRawSettings } from '@/sync/domains/server/selection/serverSelectionResolution';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { buildSessionListViewData, type SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import { storage } from '@/sync/domains/state/storageStore';
import { setServerSessionListCache } from '@/sync/store/sessionListCache';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import {
    type ManagedConnectionState,
    type ManagedConnectionTransport,
    type TransportDisconnectEvent,
} from '@happier-dev/connection-supervisor';
import {
    reportServerUnreachable,
    startServerReachabilitySupervisor,
    stopServerReachabilitySupervisor,
    subscribeServerReachabilityState,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import {
    createConcurrentServerSocketTransport,
    type ConcurrentServerSocket,
} from './concurrentServerConnections/createConcurrentServerSocketTransport';

type ConcurrentTarget = Readonly<{
    id: string;
    serverUrl: string;
    serverName: string;
}>;

type ConcurrentSelectionSettings = Pick<
    Settings,
    | 'serverSelectionGroups'
    | 'serverSelectionActiveTargetKind'
    | 'serverSelectionActiveTargetId'
>;

type ManagedConcurrentServer = {
    id: string;
    serverUrl: string;
    serverName: string;
    credentials: AuthCredentials;
    socket: ConcurrentServerSocket | null;
    socketTransport: ManagedConnectionTransport | null;
    reachabilityUnsubscribe: (() => void) | null;
    reachabilityState: ManagedConnectionState;
    detachSocketTransportListeners: Array<() => void>;
    encryption: Encryption | null;
    sessionDataKeys: Map<string, Uint8Array>;
    sessionDataKeyEnvelopes: Map<string, string>;
    machineDataKeys: Map<string, Uint8Array>;
    refreshQueued: boolean;
    refreshInFlight: Promise<void> | null;
    refreshTimer: ReturnType<typeof setTimeout> | null;
};

const REFRESH_DEBOUNCE_MS = 600;
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;

function readRefreshIntervalMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_CONCURRENT_CACHE_REFRESH_INTERVAL_MS ?? '').trim();
    if (!raw) return DEFAULT_REFRESH_INTERVAL_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_REFRESH_INTERVAL_MS;
    return Math.max(10_000, Math.min(60 * 60_000, parsed));
}

const managedServers = new Map<string, ManagedConcurrentServer>();

function areAuthCredentialsEquivalent(a: AuthCredentials, b: AuthCredentials): boolean {
    if (a.token !== b.token) return false;
    const aLegacy = isLegacyAuthCredentials(a);
    const bLegacy = isLegacyAuthCredentials(b);
    if (aLegacy && bLegacy) return a.secret === b.secret;
    if (!aLegacy && !bLegacy) {
        return (
            a.encryption.publicKey === b.encryption.publicKey
            && a.encryption.machineKey === b.encryption.machineKey
        );
    }
    return false;
}
let started = false;
let storageUnsubscribe: (() => void) | null = null;
let activeServerUnsubscribe: (() => void) | null = null;
let periodicRefreshTimer: ReturnType<typeof setInterval> | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeServerUrl(url: string): string {
    return canonicalizeServerUrl(String(url ?? ''));
}

function createServerRequest(serverUrl: string, token: string): (path: string, init: RequestInit) => Promise<Response> {
    const normalized = normalizeServerUrl(serverUrl);
    return async (path: string, init: RequestInit) => {
        const requestPath = String(path ?? '').startsWith('/') ? String(path) : `/${String(path ?? '')}`;
        return await runtimeFetchWithServerReachability({
            serverUrl: normalized,
            token,
            url: `${normalized}${requestPath}`,
            init,
        });
    };
}

export function resolveConcurrentTargets(params: Readonly<{
    activeServerId: string;
    profiles: ReadonlyArray<Readonly<{ id: string; serverUrl: string; name: string }>>;
    settings: ConcurrentSelectionSettings;
}>): ConcurrentTarget[] {
    const selection = getEffectiveServerSelectionFromRawSettings({
        activeServerId: params.activeServerId,
        availableServerIds: params.profiles.map((profile) => profile.id),
        settings: params.settings,
    });
    if (!selection.enabled) {
        return [];
    }
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
    entry.encryption = await createEncryptionFromAuthCredentials(entry.credentials);
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

function updateConcurrentMachineListCache(input: {
    serverId: string;
    machines: Machine[] | null;
    status: 'idle' | 'loading' | 'signedOut' | 'error';
    authoritative?: boolean;
}): void {
    storage.setState((state) => ({
        ...state,
        machineListByServerId: {
            ...state.machineListByServerId,
            [input.serverId]: (() => {
                if (!Array.isArray(input.machines)) {
                    return input.machines;
                }

                if (input.authoritative) {
                    return input.machines;
                }

                const previous = state.machineListByServerId?.[input.serverId];
                if (!Array.isArray(previous) || previous.length === 0) {
                    return input.machines;
                }

                // SWR merge: keep older machines that are missing from this refresh response.
                // This avoids confusing "disappear then reappear" flicker if a server returns a
                // partial list transiently.
                const nextIds = new Set(input.machines.map((m) => m.id));
                if (nextIds.size === 0) {
                    return previous;
                }
                const merged: Machine[] = [...input.machines];
                for (const machine of previous) {
                    if (!nextIds.has(machine.id)) {
                        merged.push(machine);
                    }
                }
                return merged;
            })(),
        },
        machineListStatusByServerId: {
            ...state.machineListStatusByServerId,
            [input.serverId]: input.status,
        },
    }));
}

function clearConcurrentSessionListCache(serverIdRaw: string): void {
    const serverId = String(serverIdRaw ?? '').trim();
    if (!serverId) return;
    storage.setState((state) => {
        if (!(serverId in state.sessionListViewDataByServerId)) return state;
        const next = { ...state.sessionListViewDataByServerId };
        delete next[serverId];
        return {
            ...state,
            sessionListViewDataByServerId: next,
        };
    });
}

function clearConcurrentMachineListCache(serverIdRaw: string): void {
    const serverId = String(serverIdRaw ?? '').trim();
    if (!serverId) return;
    storage.setState((state) => {
        if (!(serverId in state.machineListByServerId) && !(serverId in state.machineListStatusByServerId)) {
            return state;
        }

        const nextMachines = { ...state.machineListByServerId };
        const nextStatuses = { ...state.machineListStatusByServerId };
        delete nextMachines[serverId];
        delete nextStatuses[serverId];

        return {
            ...state,
            machineListByServerId: nextMachines,
            machineListStatusByServerId: nextStatuses,
        };
    });
}

async function refreshServerSnapshot(entry: ManagedConcurrentServer): Promise<void> {
    const encryption = await getOrCreateEncryption(entry);
    const request = createServerRequest(entry.serverUrl, entry.credentials.token);
    let sessions: Session[] = [];
    let machines: Machine[] = [];

    await fetchAndApplySessions({
        serverId: entry.id,
        credentials: entry.credentials,
        encryption,
        sessionDataKeys: entry.sessionDataKeys,
        sessionDataKeyEnvelopes: entry.sessionDataKeyEnvelopes,
        request,
        getExistingSession: () => null,
        applySessions: (nextSessions) => {
            sessions = nextSessions as Session[];
        },
        repairInvalidReadStateV1: async () => {},
        log: { log: () => {} },
    });

    await fetchAndApplyMachines({
        credentials: entry.credentials,
        encryption,
        machineDataKeys: entry.machineDataKeys,
        request,
        throwOnError: false,
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

    // Guard against late async writes: a refresh can finish after this server is removed.
    if (managedServers.get(entry.id) !== entry) {
        return;
    }

    const sessionListViewData = buildSessionListViewData(
        sessionsById,
        machinesById,
        {
            groupInactiveSessionsByProject: Boolean(storage.getState().settings.groupInactiveSessionsByProject),
            activeGroupingV1: storage.getState().settings.sessionListActiveGroupingV1,
            inactiveGroupingV1: storage.getState().settings.sessionListInactiveGroupingV1,
            serverScope: {
                serverId: entry.id,
                serverName: entry.serverName,
            },
        },
    );

    updateConcurrentMachineListCache({
        serverId: entry.id,
        machines,
        status: 'idle',
        authoritative: true,
    });
    updateConcurrentSessionListCache(entry.id, sessionListViewData);
}

function isManagedServerActive(entry: ManagedConcurrentServer): boolean {
    return managedServers.get(entry.id) === entry;
}

function queueRefresh(entry: ManagedConcurrentServer): void {
    if (!isManagedServerActive(entry)) return;
    if (entry.reachabilityState.phase !== 'online') return;
    if (entry.refreshTimer) return;
    entry.refreshTimer = setTimeout(() => {
        entry.refreshTimer = null;
        void runRefresh(entry);
    }, REFRESH_DEBOUNCE_MS);
}

async function runRefresh(entry: ManagedConcurrentServer): Promise<void> {
    if (!isManagedServerActive(entry)) return;
    if (entry.reachabilityState.phase !== 'online') return;
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
        if (entry.refreshQueued && isManagedServerActive(entry)) {
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
    entry.reachabilityUnsubscribe?.();
    entry.reachabilityUnsubscribe = null;
    void stopServerReachabilitySupervisor(entry.serverUrl);
    entry.socket = null;
    for (const detach of entry.detachSocketTransportListeners.splice(0)) {
        detach();
    }
    const transport = entry.socketTransport;
    entry.socketTransport = null;
    void transport?.disconnect({ intentional: true });
    void transport?.destroy();
    managedServers.delete(serverId);
}

function createManagedServer(target: ConcurrentTarget, credentials: AuthCredentials): ManagedConcurrentServer {
    const normalizedServerUrl = normalizeServerUrl(target.serverUrl) || target.serverUrl;
    const entry: ManagedConcurrentServer = {
        id: target.id,
        serverUrl: normalizedServerUrl,
        serverName: target.serverName,
        credentials,
        socket: null,
        socketTransport: null,
        reachabilityUnsubscribe: null,
        reachabilityState: {
            phase: 'idle',
            reason: null,
            attempt: 0,
            nextRetryAt: null,
            lastConnectedAt: null,
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        },
        detachSocketTransportListeners: [],
        encryption: null,
        sessionDataKeys: new Map<string, Uint8Array>(),
        sessionDataKeyEnvelopes: new Map<string, string>(),
        machineDataKeys: new Map<string, Uint8Array>(),
        refreshQueued: false,
        refreshInFlight: null,
        refreshTimer: null,
    };
    // NOTE: Do not refresh full snapshots on user-scoped socket `update` events.
    // Those events can be high-frequency (presence/activity), and full refresh loops are
    // expensive + noisy. Periodic refresh handles eventual consistency for non-active servers.

    entry.reachabilityUnsubscribe = subscribeServerReachabilityState(normalizedServerUrl, (state) => {
        if (!isManagedServerActive(entry)) return;
        entry.reachabilityState = state;

        if (state.phase === 'auth_failed') {
            updateConcurrentSessionListCache(entry.id, null);
            updateConcurrentMachineListCache({
                serverId: entry.id,
                machines: null,
                status: 'signedOut',
            });
            void entry.socketTransport?.disconnect({ intentional: true });
            return;
        }

        if (state.phase !== 'online') {
            void entry.socketTransport?.disconnect({ intentional: true });
            return;
        }

        if (!entry.socketTransport) {
            const { socket, transport } = createConcurrentServerSocketTransport({
                serverUrl: normalizedServerUrl,
                token: credentials.token,
            });
            entry.socket = socket;
            entry.socketTransport = transport;

            entry.detachSocketTransportListeners = [
                transport.onConnected(() => {
                    queueRefresh(entry);
                }),
                transport.onDisconnected((event: TransportDisconnectEvent) => {
                    if (event.intentional) return;
                    reportServerUnreachable(normalizedServerUrl, event.error ?? new Error(event.reason ?? 'socket disconnect'));
                }),
                transport.onError((error: unknown) => {
                    reportServerUnreachable(normalizedServerUrl, error);
                }),
            ];
        }

        if (entry.socketTransport.isConnected() !== true) {
            void entry.socketTransport.connect();
        }
    });

    void startServerReachabilitySupervisor({ serverUrl: normalizedServerUrl, token: credentials.token });
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
            serverSelectionGroups: Array.isArray(settings.serverSelectionGroups)
                ? (settings.serverSelectionGroups as any)
                : [],
            serverSelectionActiveTargetKind:
                settings.serverSelectionActiveTargetKind === 'server'
                || settings.serverSelectionActiveTargetKind === 'group'
                    ? settings.serverSelectionActiveTargetKind
                    : null,
            serverSelectionActiveTargetId: typeof settings.serverSelectionActiveTargetId === 'string'
                ? settings.serverSelectionActiveTargetId
                : null,
        },
    });

    const desiredById = new Map(targets.map((target) => [target.id, target]));

    for (const existingId of Array.from(managedServers.keys())) {
        if (!desiredById.has(existingId)) {
            stopManagedServer(existingId);
            clearConcurrentSessionListCache(existingId);
            clearConcurrentMachineListCache(existingId);
        }
    }

    for (const target of targets) {
        const credentials = await TokenStorage.getCredentialsForServerUrl(target.serverUrl, { serverId: target.id });
        if (!credentials) {
            stopManagedServer(target.id);
            updateConcurrentSessionListCache(target.id, null);
            updateConcurrentMachineListCache({
                serverId: target.id,
                machines: null,
                status: 'signedOut',
            });
            continue;
        }

        const existing = managedServers.get(target.id);
        if (
            existing
            && existing.serverUrl === target.serverUrl
            && areAuthCredentialsEquivalent(existing.credentials, credentials)
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
            serverSelectionGroups: Array.isArray(state.settings.serverSelectionGroups)
                ? state.settings.serverSelectionGroups
                : [],
            serverSelectionActiveTargetKind: state.settings.serverSelectionActiveTargetKind ?? null,
            serverSelectionActiveTargetId: state.settings.serverSelectionActiveTargetId ?? null,
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
    }, readRefreshIntervalMs());

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

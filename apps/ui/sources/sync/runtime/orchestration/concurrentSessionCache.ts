import {
    TokenStorage,
    type AuthCredentials,
    isDataKeyAuthCredentials,
    isLegacyAuthCredentials,
    isTokenOnlyAuthCredentials,
} from '@/auth/storage/tokenStorage';
import { Encryption } from '@/sync/encryption/encryption';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { fetchAndApplyMachines, type MachineDataKeyCacheEntry } from '@/sync/engine/machines/syncMachines';
import { fetchAndApplySessions } from '@/sync/engine/sessions/sessionSnapshot';
import { getEffectiveServerSelectionFromRawSettings } from '@/sync/domains/server/selection/serverSelectionResolution';
import {
    areServerProfileIdentifiersEquivalent,
    listServerProfiles,
    resolveServerProfileScopeId,
} from '@/sync/domains/server/serverProfiles';
import {
    listServerProfileScopeIds,
    normalizeServerSelectionSettingsForProfileScopeIds,
} from '@/sync/domains/server/selection/serverSelectionProfileScopeIds';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import {
    invalidateCachedTransferRoutesForMachine,
    invalidateCachedTransferRoutesForServer,
} from '@/sync/domains/transfers/runtime/transferRouteCache';
import type { ConcurrentSessionListCacheEntry } from '@/sync/domains/session/listing/concurrentSessionListCache';
import { buildMachineDisplayRenderableFromMachine } from '@/sync/domains/machines/machineDisplayRenderable';
import {
    areSessionListRenderablesEqual,
    buildSessionListRenderableFromSession,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import { shouldRebuildSessionListIndexForRowStateChange } from '@/sync/domains/session/listing/sessionListIndexRebuildImpact';
import {
    buildMachineDisplaysByIdFromMachineList,
    buildSessionListIndexWithServerScope,
} from '@/sync/store/sessionListIndex/buildSessionListIndexWithServerScope';
import {
    type ManagedConnectionState,
    type ManagedConnectionTransport,
    type TransportDisconnectEvent,
} from '@happier-dev/connection-supervisor';
import {
    reportServerUnreachable,
    startServerReachabilitySupervisor,
    stopServerReachabilitySupervisor,
    subscribeServerReachabilityNetworkAllowed,
    subscribeServerReachabilityState,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { createSessionRequestForExplicitServerScope } from './serverScopedRpc/createSessionRequestWithServerScope';
import {
    createConcurrentServerSocketTransport,
    type ConcurrentServerSocket,
} from './concurrentServerConnections/createConcurrentServerSocketTransport';
import { shouldRefreshConcurrentSessionCacheForUpdate } from './concurrentSessionCacheUpdateClassifier';
import { startRuntimeActiveGatedInterval } from '@/utils/runtime/isRuntimeActive';
import { areStoredMachinesEqual, hasMachineDaemonStateAdvanced } from '@/sync/store/domains/areStoredMachinesEqual';
import { scheduleMachineListDisplayWarmCacheSave } from '@/sync/domains/state/machineDisplayWarmCacheWriter';
import { registerExternalSessionStatusDemandTransport } from './externalSessions/externalSessionStatusDemandCoordinator';

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
    machineDataKeys: Map<string, MachineDataKeyCacheEntry>;
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
    const aDataKey = isDataKeyAuthCredentials(a);
    const bDataKey = isDataKeyAuthCredentials(b);
    if (aDataKey && bDataKey) {
        return (
            a.encryption.publicKey === b.encryption.publicKey
            && a.encryption.machineKey === b.encryption.machineKey
        );
    }
    if (isTokenOnlyAuthCredentials(a) && isTokenOnlyAuthCredentials(b)) return true;
    return false;
}
let started = false;
let storageUnsubscribe: (() => void) | null = null;
let activeServerUnsubscribe: (() => void) | null = null;
let networkAllowedUnsubscribe: (() => void) | null = null;
let periodicRefreshStop: (() => void) | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeServerUrl(url: string): string {
    return canonicalizeServerUrl(String(url ?? ''));
}

function normalizeServerId(value: unknown): string {
    return String(value ?? '').trim();
}

function createServerRequest(serverUrl: string, token: string): (path: string, init: RequestInit) => Promise<Response> {
    const normalized = normalizeServerUrl(serverUrl);
    const request = createSessionRequestForExplicitServerScope({
        serverUrl: normalized,
        token,
    });
    return async (path: string, init: RequestInit) => {
        const requestPath = String(path ?? '').startsWith('/') ? String(path) : `/${String(path ?? '')}`;
        return await request(requestPath, init);
    };
}

export function resolveConcurrentTargets(params: Readonly<{
    activeServerId: string;
    profiles: ReadonlyArray<Readonly<{
        id: string;
        serverUrl: string;
        name: string;
        serverIdentityId?: string | null;
        legacyServerIds?: readonly string[];
    }>>;
    settings: ConcurrentSelectionSettings;
}>): ConcurrentTarget[] {
    const selection = getEffectiveServerSelectionFromRawSettings({
        activeServerId: params.activeServerId,
        availableServerIds: listServerProfileScopeIds(params.profiles),
        settings: normalizeServerSelectionSettingsForProfileScopeIds(params.settings, params.profiles),
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
        const scopeId = resolveServerProfileScopeId(profile);
        if (!selected.has(scopeId)) continue;
        const serverUrl = normalizeServerUrl(profile.serverUrl);
        if (!serverUrl) continue;
        targets.push({
            id: scopeId,
            serverUrl,
            serverName: String(profile.name ?? scopeId).trim() || scopeId,
        });
    }
    return targets;
}

async function getOrCreateEncryption(entry: ManagedConcurrentServer): Promise<Encryption | null> {
    if (entry.encryption) return entry.encryption;
    if (isTokenOnlyAuthCredentials(entry.credentials)) return null;
    entry.encryption = await createEncryptionFromAuthCredentials(entry.credentials);
    return entry.encryption;
}

function areConcurrentSessionListCacheSessionsEqual(
    previous: Readonly<Record<string, SessionListRenderableSession>> | null | undefined,
    next: Readonly<Record<string, SessionListRenderableSession>> | null | undefined,
): boolean {
    if (previous === next) return true;
    if (!previous || !next) return previous === next;

    const previousIds = Object.keys(previous);
    const nextIds = Object.keys(next);
    if (previousIds.length !== nextIds.length) return false;

    for (const sessionId of previousIds) {
        const previousSession = previous[sessionId];
        const nextSession = next[sessionId];
        if (!nextSession) return false;
        if (!areSessionListRenderablesEqual(previousSession, nextSession)) {
            return false;
        }
    }

    return true;
}

function compactSessionListRowsForViewData(
    input: Readonly<Record<string, SessionListRenderableSession | null | undefined>>,
): Record<string, SessionListRenderableSession> {
    const out: Record<string, SessionListRenderableSession> = {};
    for (const sessionId in input) {
        const row = input[sessionId];
        if (row) {
            out[sessionId] = row;
        }
    }
    return out;
}

function updateConcurrentSessionListCache(params: Readonly<{
    serverId: string;
    entry: ConcurrentSessionListCacheEntry | null;
}>): void {
    storage.setState((state) => {
        const serverId = normalizeServerId(params.serverId);
        if (!serverId) {
            return state;
        }

        const previous = state.concurrentSessionListCacheByServerId?.[serverId];
        const next = params.entry;

        if (previous === next) {
            return state;
        }

        if (previous && next) {
            const previousName = String(previous.serverName ?? '').trim() || null;
            const nextName = String(next.serverName ?? '').trim() || null;
            if (
                previousName === nextName
                && areConcurrentSessionListCacheSessionsEqual(previous.sessions, next.sessions)
            ) {
                return state;
            }
        }

        const nextRowStateByServerId = (() => {
            const previousRowStateByServerId = state.sessionListRowStateByServerId ?? {};
            const nextRows = next?.sessions ?? null;
            if (!nextRows) {
                if (!(serverId in previousRowStateByServerId)) {
                    return previousRowStateByServerId;
                }
                const { [serverId]: _, ...rest } = previousRowStateByServerId;
                return rest;
            }

            return previousRowStateByServerId[serverId] === nextRows
                ? previousRowStateByServerId
                : {
                    ...previousRowStateByServerId,
                    [serverId]: nextRows,
                };
        })();

        const nextIndexByServerId = (() => {
            const previousIndexByServerId = state.sessionListIndexByServerId ?? {};
            const nextRows = next?.sessions ?? null;
            if (!nextRows) {
                if (!(serverId in previousIndexByServerId)) {
                    return previousIndexByServerId;
                }
                const { [serverId]: _, ...rest } = previousIndexByServerId;
                return rest;
            }

            const previousRows = previous?.sessions ?? null;
            const previousName = String(previous?.serverName ?? '').trim() || null;
            const nextName = String(next?.serverName ?? '').trim() || null;
            const shouldRebuildIndex =
                previousIndexByServerId[serverId] == null
                || previousName !== nextName
                || shouldRebuildSessionListIndexForRowStateChange(previousRows, nextRows, {
                    groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject === true,
                    activeGroupingV1: state.settings.sessionListActiveGroupingV1,
                    inactiveGroupingV1: state.settings.sessionListInactiveGroupingV1,
                    sectionModeV1: state.settings.sessionListSectionModeV1,
                });

            if (!shouldRebuildIndex) {
                return previousIndexByServerId;
            }

            const index = buildSessionListIndexWithServerScope({
                sessions: nextRows,
                machines: buildMachineDisplaysByIdFromMachineList(state.machineListByServerId?.[serverId]),
                groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject === true,
                activeGroupingV1: state.settings.sessionListActiveGroupingV1,
                inactiveGroupingV1: state.settings.sessionListInactiveGroupingV1,
                sectionModeV1: state.settings.sessionListSectionModeV1,
                serverScope: {
                    serverId,
                    serverName: nextName ?? undefined,
                },
                previousIndex: previousIndexByServerId[serverId] ?? null,
            });

            return previousIndexByServerId[serverId] === index
                ? previousIndexByServerId
                : {
                    ...previousIndexByServerId,
                    [serverId]: index,
                };
        })();

        return {
            ...state,
            concurrentSessionListCacheByServerId: {
                ...state.concurrentSessionListCacheByServerId,
                [serverId]: next,
            },
            sessionListRowStateByServerId: nextRowStateByServerId,
            sessionListIndexByServerId: nextIndexByServerId,
        };
    });
}

function areMachineListsEqual(previous: Machine[] | null | undefined, next: Machine[] | null | undefined): boolean {
    if (previous === next) return true;
    if (!Array.isArray(previous) || !Array.isArray(next)) return previous === next;
    if (previous.length !== next.length) return false;

    for (let index = 0; index < previous.length; index += 1) {
        if (!areStoredMachinesEqual(previous[index], next[index])) return false;
    }

    return true;
}

function updateConcurrentMachineListCache(input: {
    serverId: string;
    machines: Machine[] | null;
    status: 'idle' | 'loading' | 'signedOut' | 'error';
    authoritative?: boolean;
}): void {
    storage.setState((state) => {
        const serverId = normalizeServerId(input.serverId);
        if (!serverId) {
            return state;
        }

        const nextMachineListByServerId = (() => {
            const previous = state.machineListByServerId?.[serverId];
            let nextMachines = input.machines;

            if (Array.isArray(input.machines) && !input.authoritative) {
                if (!Array.isArray(previous) || previous.length === 0) {
                    nextMachines = input.machines;
                } else {
                    // SWR merge: keep older machines that are missing from this refresh response.
                    // This avoids confusing "disappear then reappear" flicker if a server returns a
                    // partial list transiently.
                    const nextIds = new Set(input.machines.map((m) => m.id));
                    if (nextIds.size === 0) {
                        nextMachines = previous;
                    } else {
                        const merged: Machine[] = [...input.machines];
                        for (const machine of previous) {
                            if (!nextIds.has(machine.id)) {
                                merged.push(machine);
                            }
                        }
                        nextMachines = merged;
                    }
                }
            }

            if (previous !== undefined && areMachineListsEqual(previous, nextMachines)) {
                return state.machineListByServerId;
            }

            if (Array.isArray(nextMachines)) {
                const previousMachinesById = new Map(
                    (Array.isArray(previous) ? previous : []).map((machine) => [machine.id, machine]),
                );
                for (const machine of nextMachines) {
                    if (!hasMachineDaemonStateAdvanced(previousMachinesById.get(machine.id), machine)) continue;
                    invalidateCachedTransferRoutesForMachine({
                        serverId,
                        remoteMachineId: machine.id,
                    });
                }
            }

            return {
                ...state.machineListByServerId,
                [serverId]: nextMachines,
            };
        })();
        const nextMachinesForServer = nextMachineListByServerId?.[serverId];
        if (Array.isArray(nextMachinesForServer)) {
            scheduleMachineListDisplayWarmCacheSave({
                serverId,
                accountId: state.profile.id,
                machines: nextMachinesForServer,
            });
        }

        const nextMachineListStatusByServerId = state.machineListStatusByServerId?.[serverId] === input.status
            ? state.machineListStatusByServerId
            : {
                ...state.machineListStatusByServerId,
                [serverId]: input.status,
            };

        const nextIndexByServerId = (() => {
            if (nextMachineListByServerId === state.machineListByServerId) {
                return state.sessionListIndexByServerId;
            }

            const rows = state.sessionListRowStateByServerId?.[serverId] ?? null;
            if (!rows || typeof rows !== 'object') {
                return state.sessionListIndexByServerId;
            }

            const serverName = state.concurrentSessionListCacheByServerId?.[serverId]?.serverName ?? undefined;
            const previousIndexByServerId = state.sessionListIndexByServerId ?? {};
            const index = buildSessionListIndexWithServerScope({
                sessions: compactSessionListRowsForViewData(rows),
                machines: buildMachineDisplaysByIdFromMachineList(nextMachineListByServerId?.[serverId]),
                groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject === true,
                activeGroupingV1: state.settings.sessionListActiveGroupingV1,
                inactiveGroupingV1: state.settings.sessionListInactiveGroupingV1,
                sectionModeV1: state.settings.sessionListSectionModeV1,
                serverScope: {
                    serverId,
                    serverName,
                },
                previousIndex: previousIndexByServerId[serverId] ?? null,
            });
            if (previousIndexByServerId[serverId] === index) {
                return previousIndexByServerId;
            }
            return {
                ...previousIndexByServerId,
                [serverId]: index,
            };
        })();

        if (
            nextMachineListByServerId === state.machineListByServerId
            && nextMachineListStatusByServerId === state.machineListStatusByServerId
            && nextIndexByServerId === state.sessionListIndexByServerId
        ) {
            return state;
        }

        return {
            ...state,
            machineListByServerId: nextMachineListByServerId,
            machineListStatusByServerId: nextMachineListStatusByServerId,
            sessionListIndexByServerId: nextIndexByServerId,
        };
    });
}

function clearConcurrentSessionListCache(serverIdRaw: string): void {
    const serverId = normalizeServerId(serverIdRaw);
    if (!serverId) return;
    storage.setState((state) => {
        const current = state.concurrentSessionListCacheByServerId ?? {};
        if (!(serverId in current)) {
            return state;
        }

        const next = { ...current };
        delete next[serverId];

        const activeServerId = normalizeServerId(getActiveServerSnapshot().serverId);
        const shouldPruneCanonicalState = !areServerProfileIdentifiersEquivalent(serverId, activeServerId);

        const nextRowStateByServerId = shouldPruneCanonicalState && state.sessionListRowStateByServerId && (serverId in state.sessionListRowStateByServerId)
            ? (() => {
                const next = { ...state.sessionListRowStateByServerId };
                delete (next as any)[serverId];
                return next;
            })()
            : state.sessionListRowStateByServerId;

        const nextIndexByServerId = shouldPruneCanonicalState && state.sessionListIndexByServerId && (serverId in state.sessionListIndexByServerId)
            ? (() => {
                const next = { ...state.sessionListIndexByServerId };
                delete (next as any)[serverId];
                return next;
            })()
            : state.sessionListIndexByServerId;

        return {
            ...state,
            concurrentSessionListCacheByServerId: next,
            sessionListRowStateByServerId: nextRowStateByServerId,
            sessionListIndexByServerId: nextIndexByServerId,
        };
    });
}

function clearConcurrentMachineListCache(serverIdRaw: string): void {
    const serverId = normalizeServerId(serverIdRaw);
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

    // Guard against late async writes: a refresh can finish after this server is removed.
    if (managedServers.get(entry.id) !== entry) {
        return;
    }

    const previousCacheEntry = storage.getState().concurrentSessionListCacheByServerId?.[entry.id] ?? null;
    const previousSessions = previousCacheEntry && typeof previousCacheEntry === 'object'
        ? previousCacheEntry.sessions
        : null;
    const nextSessions: Record<string, SessionListRenderableSession> = {};
    for (const session of sessions) {
        nextSessions[session.id] = buildSessionListRenderableFromSession(
            session,
            previousSessions && typeof previousSessions === 'object' ? previousSessions[session.id] : undefined,
        );
    }

    updateConcurrentMachineListCache({
        serverId: entry.id,
        machines,
        status: 'idle',
        authoritative: true,
    });
    updateConcurrentSessionListCache({
        serverId: entry.id,
        entry: {
            serverName: String(entry.serverName ?? '').trim() || null,
            sessions: nextSessions,
        },
    });
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
    invalidateCachedTransferRoutesForServer({ serverId: entry.id });
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
        machineDataKeys: new Map<string, MachineDataKeyCacheEntry>(),
        refreshQueued: false,
        refreshInFlight: null,
        refreshTimer: null,
    };

    entry.reachabilityUnsubscribe = subscribeServerReachabilityState(normalizedServerUrl, (state) => {
        if (!isManagedServerActive(entry)) return;
        entry.reachabilityState = state;

        if (state.phase === 'auth_failed') {
            updateConcurrentSessionListCache({ serverId: entry.id, entry: null });
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
                ...(() => {
                    const active = getActiveServerSnapshot();
                    return areServerProfileIdentifiersEquivalent(active.serverId, entry.id)
                        ? { runtimeOrigin: active.runtimeOrigin, carrier: active.carrier }
                        : {};
                })(),
            });
            entry.socket = socket;
            entry.socketTransport = transport;
            const statusDemandTransport = registerExternalSessionStatusDemandTransport(
                entry.id,
                (event, payload) => {
                    if (socket.connected) {
                        socket.emit(event, payload);
                    }
                },
            );
            socket.on('update', (raw: unknown) => {
                if (!shouldRefreshConcurrentSessionCacheForUpdate(raw)) {
                    return;
                }
                queueRefresh(entry);
            });
            socket.on('ephemeral', (raw: unknown) => {
                statusDemandTransport.observeEphemeral(raw);
            });

            entry.detachSocketTransportListeners = [
                transport.onConnected(() => {
                    statusDemandTransport.resend();
                    queueRefresh(entry);
                }),
                transport.onDisconnected((event: TransportDisconnectEvent) => {
                    if (event.intentional) return;
                    reportServerUnreachable(normalizedServerUrl, event.error ?? new Error(event.reason ?? 'socket disconnect'));
                }),
                transport.onError((error: unknown) => {
                    reportServerUnreachable(normalizedServerUrl, error);
                }),
                () => statusDemandTransport.dispose(),
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
            serverIdentityId: profile.serverIdentityId,
            legacyServerIds: profile.legacyServerIds,
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
            updateConcurrentSessionListCache({ serverId: target.id, entry: null });
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

function pauseManagedServersForNetworkDisallowed(): void {
    for (const entry of managedServers.values()) {
        if (entry.refreshTimer) {
            clearTimeout(entry.refreshTimer);
            entry.refreshTimer = null;
        }
        void entry.socketTransport?.disconnect({ intentional: true });
    }
}

function resumeManagedServersForNetworkAllowed(): void {
    for (const entry of managedServers.values()) {
        void startServerReachabilitySupervisor({ serverUrl: entry.serverUrl, token: entry.credentials.token });
        if (entry.reachabilityState.phase === 'online' && entry.socketTransport?.isConnected() !== true) {
            void entry.socketTransport?.connect();
        }
        queueRefresh(entry);
    }
    scheduleReconcile();
}

export function startConcurrentSessionCacheSync(): void {
    if (started) return;
    started = true;
    let lastActiveServerSnapshot = getActiveServerSnapshot();

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

    activeServerUnsubscribe = subscribeActiveServer((nextSnapshot) => {
        const previousServerId = normalizeServerId(lastActiveServerSnapshot.serverId);
        const nextServerId = normalizeServerId(nextSnapshot.serverId);
        const activeServerChanged =
            previousServerId !== nextServerId
            || lastActiveServerSnapshot.generation !== nextSnapshot.generation;

        if (activeServerChanged) {
            if (previousServerId) {
                invalidateCachedTransferRoutesForServer({ serverId: previousServerId });
            }
            if (nextServerId && nextServerId !== previousServerId) {
                invalidateCachedTransferRoutesForServer({ serverId: nextServerId });
            }
        }
        lastActiveServerSnapshot = nextSnapshot;
        scheduleReconcile();
    });

    networkAllowedUnsubscribe = subscribeServerReachabilityNetworkAllowed((allowed) => {
        if (allowed) {
            resumeManagedServersForNetworkAllowed();
            return;
        }
        pauseManagedServersForNetworkDisallowed();
    });

    periodicRefreshStop = startRuntimeActiveGatedInterval(() => {
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
    if (periodicRefreshStop) {
        periodicRefreshStop();
        periodicRefreshStop = null;
    }
    if (storageUnsubscribe) {
        storageUnsubscribe();
        storageUnsubscribe = null;
    }
    if (activeServerUnsubscribe) {
        activeServerUnsubscribe();
        activeServerUnsubscribe = null;
    }
    if (networkAllowedUnsubscribe) {
        networkAllowedUnsubscribe();
        networkAllowedUnsubscribe = null;
    }

    for (const serverId of Array.from(managedServers.keys())) {
        stopManagedServer(serverId);
    }
}

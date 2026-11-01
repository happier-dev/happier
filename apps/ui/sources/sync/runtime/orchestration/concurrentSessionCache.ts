import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { attachManagedSessionHumanPresenceSocket } from '@/sync/domains/session/humanPresence/attachManagedSessionHumanPresenceSocket';
import { attachManagedSessionConsumptionSocket } from '@/sync/runtime/attachManagedSessionConsumptionSocket';
import { invalidateHomeAccountReadJoins, publishHomeAccountChange } from './homeAccountChange';
import { PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { EphemeralUpdateSchema, UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { notifyExecutionRunActivityFromUpdate, notifyExecutionRunActivityReconnect } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import {
    TokenStorage,
    areCredentialsEqual,
    type AuthCredentials,
    isTokenOnlyAuthCredentials,
    subscribeHomeCredentialMutations,
} from '@/auth/storage/tokenStorage';
import { Encryption, captureEncryptionGenerationCurrentness } from '@/sync/encryption/encryption';
import { getActionOperation } from '@/sync/ops/actionOperations';
import { resolveScopedAccountEncryption } from '@/sync/encryption/scopedAccountEncryption';
import { AccountEncryptionMaterialUnavailableError } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { fetchAndApplyMachines, type MachineDataKeyCacheEntry } from '@/sync/engine/machines/syncMachines';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { fetchAndApplySessions } from '@/sync/engine/sessions/sessionSnapshot';
import { ensureSessionDisplayProjectionsForRead } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { fetchAndApplySessionById } from '@/sync/engine/sessions/sessionById';
import { buildPendingChangedSessionPatch } from '@/sync/engine/socket/pendingChangedSessionPatch';
import { buildCacheOnlyDurableMessageProjectionPatch } from '@/sync/engine/socket/durableMessageProjection';
import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import { captureSessionListRetirementFence, wasSessionRetiredSinceFence } from '@/sync/store/domains/sessions';
import { readSessionDetailAccessProjectionVersion } from '@/sync/api/session/sessionDetailAccessProjection';
import { getScopedSessionByIdEncryption } from './serverScopedRpc/fetchSessionByIdWithServerScope';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { resolveUiClientEncryptionRequirementForScope } from '@/sync/domains/settings/clientEncryptionRequirement';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { captureMachinePresenceObservation, clearMachineRequestReachabilityForMachine, clearMachineRequestReachabilityForScope, withdrawMachinePresenceForScope } from '@/sync/domains/machines/reachability/machineReachability';
import {
    getEffectiveServerSelectionFromRawSettings,
    type RawServerSelectionSettings,
} from '@/sync/domains/server/selection/serverSelectionResolution';
import type { ServerSelectionSettingsLike } from '@/sync/domains/server/selection/serverSelectionTypes';
import {
    areServerProfileIdentifiersEquivalent,
    listServerProfiles,
    resolveServerProfileScopeId,
    resolveServerProfileScopeIdForIdentifier,
    subscribeServerProfiles,
} from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    loadEffectiveHomeViewState,
    subscribeEffectiveHomeViewState,
} from '@/sync/domains/server/selection/homeViewSelectionState';
import {
    listServerProfileScopeIds,
    normalizeServerSelectionSettingsForProfileScopeIds,
} from '@/sync/domains/server/selection/serverSelectionProfileScopeIds';
import {
    getAppliedActiveServerId,
    isAppliedActiveServerRuntimeAvailable,
    subscribeAppliedActiveServer,
    subscribeApplyingActiveServer,
} from '@/sync/runtime/orchestration/connectionManager';
import { storage } from '@/sync/domains/state/storageStore';
import { resolveWarmCacheAccountScope } from '@/sync/domains/state/warmCachePersistence';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import { invalidateCachedTransferRoutesForServer } from '@/sync/domains/transfers/runtime/transferRouteCache';
import type { ConcurrentSessionListCacheEntry } from '@/sync/domains/session/listing/concurrentSessionListCache';
import {
    areSessionListHomeObservationsEqual,
    type SessionListHomeObservation,
} from '@/sync/domains/session/listing/sessionListHomeObservation';
import { buildMachineDisplayRenderableFromMachine } from '@/sync/domains/machines/machineDisplayRenderable';
import {
    buildSessionListRenderableFromSession,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import {
    buildMachineDisplaysByIdFromMachineList,
    buildSessionListIndexWithServerScope,
} from '@/sync/store/sessionListIndex/buildSessionListIndexWithServerScope';
import {
    type ManagedConnectionState,
    type ManagedConnectionTransport,
    type ManagedConnectionSupervisor,
} from '@happier-dev/connection-supervisor';
import type { ClientEncryptionRequirement, HomeConnectionDescriptorV1 } from '@happier-dev/protocol';
import {
    acquireServerReachabilitySupervisor,
    invalidateServerReachabilitySupervisor,
    subscribeServerReachabilityNetworkAllowed,
    subscribeServerReachabilityState,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { createSocketConnectionSupervisor } from '@/sync/runtime/connectivity/createSocketConnectionSupervisor';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { bindAccountEncryptionObservation, matchesAccountEncryptionObservationCredentials, readAccountEncryptionObservationBinding, type AccountEncryptionObservationBinding } from '@/sync/http/accountEncryptionObservationBinding';
import { createSocketAccountEncryptionObservation } from '@/sync/api/account/apiAccountEncryptionMode';
import { createCapturedServerReadTransport, type CapturedServerReadTransport } from './serverScopedRpc/capturedServerReadTransport';
import {
    resolveServerScopedTransport,
    type ResolvedServerScopedTransport,
} from './serverScopedRpc/resolveServerScopedTransport';
import { startNativeLoopbackTunnelRuntimeAppStateLifecycle } from '@/sync/runtime/nativeLoopbackTunnels/runtime';
import { subscribeIrohHomeTunnelRecoveryRequired } from '@/sync/runtime/nativeIrohTunnels';
import {
    createConcurrentServerSocketTransport,
    type ConcurrentServerSocket,
} from './concurrentServerConnections/createConcurrentServerSocketTransport';
import {
    classifyConcurrentSessionCacheUpdate,
    isAccountChangeUpdate,
} from './concurrentSessionCacheUpdateClassifier';
import { startRuntimeActiveGatedInterval } from '@/utils/runtime/isRuntimeActive';
import { areStoredMachinesEqual } from '@/sync/store/domains/areStoredMachinesEqual';
import { registerExternalSessionStatusDemandTransport } from './externalSessions/externalSessionStatusDemandCoordinator';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import {
    schedulePushTokenReconciliation,
    startPushTokenReconciliation,
    stopPushTokenReconciliation,
} from '@/sync/engine/account/syncAccount';
import { refreshAuthenticatedServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import type { SessionListQueryPageRequest } from '@/sync/domains/session/listing/sessionListQueryController';
import { HappyError } from '@/utils/errors/errors';
import { parseToken } from '@/utils/auth/parseToken';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { normalizeActionOperationEphemeralIngress } from '@/sync/domains/actionOperations/actionOperationEphemeralIngress';
import { consumeActionOperationSnapshotPush } from '@/sync/domains/actionOperations/consumeActionOperationSnapshotPush';
import { actionOperationPresentationCoordinator } from '@/components/inbox/actionOperations/actionOperationPresentationRuntime';
import {
    advanceOrdinarySessionListFrontier,
    EMPTY_ORDINARY_SESSION_LIST_FRONTIER,
    resolveOrdinarySessionListContinuation,
    type OrdinarySessionListFrontier,
} from '@/sync/engine/sessions/ordinarySessionListFrontier';
import type { OrdinarySessionListLifecycle } from '@/sync/domains/session/listing/ordinarySessionListHomeState';
import { computeNextSessionSeqFromUpdate } from '@/sync/domains/session/sequence/realtimeSessionSeq';
import { invalidateSessionListQueryHome } from '@/sync/domains/session/listing/sessionListQueryInvalidation';
import { resolveSessionLiveConsumption } from '@/sync/runtime/sessionLiveConsumption';

type ConcurrentTarget = Readonly<{
    id: string;
    serverUrl: string;
    serverName: string;
    homeConnectionDescriptor?: HomeConnectionDescriptorV1;
    irohConfigKey?: string;
    canonicalServerUrl?: string;
}>;

type ConcurrentSelectionSettings = ServerSelectionSettingsLike;

function toRawConcurrentSelectionSettings(settings: ConcurrentSelectionSettings): RawServerSelectionSettings {
    return {
        serverSelectionGroups: settings.serverSelectionGroups ?? null,
        serverSelectionActiveTargetKind: settings.serverSelectionActiveTargetKind ?? null,
        serverSelectionActiveTargetId: settings.serverSelectionActiveTargetId ?? null,
    };
}

type ConcurrentRefreshIntent = 'machines' | 'refresh' | 'continue' | 'replace';

type ManagedConcurrentServer = {
    id: string;
    serverUrl: string;
    serverName: string;
    readonly homeConnectionDescriptor?: HomeConnectionDescriptorV1;
    credentials: AuthCredentials;
    socket: ConcurrentServerSocket | null;
    socketTransport: ManagedConnectionTransport | null;
    socketSupervisor: ManagedConnectionSupervisor | null;
    accountEncryptionObservation: ReturnType<typeof createSocketAccountEncryptionObservation> | null;
    reachabilityUnsubscribe: (() => void) | null;
    reachabilityRelease: (() => Promise<void>) | null;
    reachabilityAcquireGeneration: number;
    reachabilityState: ManagedConnectionState;
    detachSocketTransportListeners: Array<() => void>;
    encryption: Encryption | null;
    sessionDataKeys: Map<string, Uint8Array>;
    sessionDataKeyEnvelopes: Map<string, string>;
    machineDataKeys: Map<string, MachineDataKeyCacheEntry>;
    irohLease: ResolvedServerScopedTransport | null;
    irohConfigKey: string | null;
    refreshQueued: ConcurrentRefreshIntent | null;
    refreshInFlight: Promise<void> | null;
    refreshAbortController: AbortController | null;
    refreshTimer: ReturnType<typeof setTimeout> | null;
    refreshTimerIntent: ConcurrentRefreshIntent | null;
    sessionListFrontier: OrdinarySessionListFrontier;
    /** One applied ordinary page has landed for this Home since it was managed. */
    hasFetchedSessionListSnapshot: boolean;
    /**
     * Time of this Home's last successful ordinary Session-list observation. Kept in memory and
     * published to the store only on a phase transition, so a healthy Home refreshing every few
     * minutes never rewrites state for a timestamp nothing currently renders.
     */
    lastSessionListSuccessAt: number | null;
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

/** Identity discovery changes a Home's routing label, not its existing Account runtime. */
function getManagedServer(serverId: string): ManagedConcurrentServer | undefined {
    const canonicalId = resolveServerProfileScopeIdForIdentifier(serverId);
    return managedServers.get(canonicalId) ?? managedServers.get(serverId)
        ?? [...managedServers.values()].find(entry => areServerProfileIdentifiersEquivalent(entry.id, canonicalId));
}

/** Pending acquisitions and focused transfers can retain a projection without a transport. */
function readConcurrentHomeIds(): ReadonlySet<string> {
    return new Set([
        ...managedServers.keys(),
        ...Object.keys(storage.getState().concurrentSessionListCacheByServerId ?? {}),
    ]);
}

function readCredentialAccountId(credentials: AuthCredentials): string | null {
    try {
        return parseToken(credentials.token);
    } catch {
        return null;
    }
}

/**
 * Before the focused runtime is applied (a cold restore still preparing its carrier,
 * or a Home that cannot be reached), the focused Home's rows come only from Sync's
 * local warm-cache phase, which is keyed by the credential's own Account. That key
 * is the proof of their Account; without it the rows were cleared, and the empty
 * membership then deleted the persisted cache, so an offline reload came up empty.
 */
function readFocusedHomeLocalRowsAccountId(serverId: string): string | null {
    if (!areServerProfileIdentifiersEquivalent(getActiveServerSnapshot().serverId, serverId)) return null;
    return resolveWarmCacheAccountScope(null);
}

/** Retained rows are trusted only while an existing runtime (or Account-keyed local restore) proves their Account. */
function retireReplacedSessionListAccount(serverId: string, accountId: string | null): boolean {
    const entry = getManagedServer(serverId);
    const activeScope = entry ? null : getActiveServerAccountScope();
    const existingAccountId = entry
        ? readCredentialAccountId(entry.credentials)
        : activeScope && areServerProfileIdentifiersEquivalent(activeScope.serverId, serverId)
            ? activeScope.accountId
            : readFocusedHomeLocalRowsAccountId(serverId);
    if (accountId && existingAccountId === accountId) return false;
    // Stop the old publisher before withdrawing its rows, membership and frontier.
    // This also fences a late HTTP/hydration completion from the previous Account.
    if (entry) stopManagedServer(serverId);
    storage.getState().clearSessionListRowsForServerScope(serverId);
    clearConcurrentMachineListCache(serverId, { retireAccount: true });
    updateConcurrentSessionListCache({ serverId, entry: null });
    return entry !== undefined;
}

/** Validate a consumer binding through the runtime that owns the retained corpus. */
export function prepareSessionListAccountScope(scope: ServerAccountScope): void {
    const serverId = normalizeServerId(scope.serverId);
    if (!serverId) return;
    if (retireReplacedSessionListAccount(serverId, scope.accountId)) scheduleReconcile();
}

function areAuthCredentialsEquivalent(a: AuthCredentials, b: AuthCredentials): boolean {
    return a === b || resolveAuthCredentialsScopeKey(a) === resolveAuthCredentialsScopeKey(b);
}
let started = false;
let storageUnsubscribe: (() => void) | null = null;
let activeServerUnsubscribe: (() => void) | null = null;
let applyingActiveServerUnsubscribe: (() => void) | null = null;
let serverProfilesUnsubscribe: (() => void) | null = null;
let homeViewStateUnsubscribe: (() => void) | null = null;
let homeCredentialMutationsUnsubscribe: (() => void) | null = null;
let networkAllowedUnsubscribe: (() => void) | null = null;
let irohRecoveryUnsubscribe: (() => void) | null = null;
let periodicRefreshStop: (() => void) | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
let reconcileRequestRevision = 0;
let applyingActiveServerId = '';

function normalizeServerUrl(url: string): string {
    return canonicalizeServerUrl(String(url ?? ''));
}

function normalizeServerId(value: unknown): string {
    return String(value ?? '').trim();
}

function readConcurrentSelectionSettings(): ConcurrentSelectionSettings {
    const homeViewState = loadEffectiveHomeViewState();
    if (homeViewState) {
        return {
            serverSelectionGroups: homeViewState.groups,
            serverSelectionActiveTargetKind: homeViewState.activeTargetKind,
            serverSelectionActiveTargetId: homeViewState.activeTargetId,
        };
    }
    const settings = storage.getState().settings;
    return {
        serverSelectionGroups: Array.isArray(settings.serverSelectionGroups)
            ? settings.serverSelectionGroups
            : [],
        serverSelectionActiveTargetKind:
            settings.serverSelectionActiveTargetKind === 'server'
            || settings.serverSelectionActiveTargetKind === 'group'
                ? settings.serverSelectionActiveTargetKind
                : null,
        serverSelectionActiveTargetId: typeof settings.serverSelectionActiveTargetId === 'string'
            ? settings.serverSelectionActiveTargetId
            : null,
    };
}

function createServerRequest(
    entry: ManagedConcurrentServer,
    observeResponse: (response: Response) => void,
    signal?: AbortSignal,
): (path: string, init?: RequestInit) => Promise<Response> {
    const request = createServerFetchAtEndpoint({
        endpointUrl: entry.serverUrl,
        ...(entry.irohLease ? { runtimeOrigin: entry.irohLease.runtimeOrigin } : {}),
        ...(entry.irohLease?.homeCarrier ? { homeCarrier: entry.irohLease.homeCarrier } : {}),
        credentials: entry.credentials,
        superviseReachability: true,
        accountEncryptionObservation: entry.accountEncryptionObservation?.binding,
        serverId: entry.id,
        signal,
    });
    const observedRequest = async (path: string, init?: RequestInit) => {
        const requestPath = String(path ?? '').startsWith('/') ? String(path) : `/${String(path ?? '')}`;
        const response = await request(requestPath, init);
        observeResponse(response);
        return response;
    };
    return bindAccountEncryptionObservation(observedRequest, readAccountEncryptionObservationBinding(request, entry.credentials) ?? undefined);
}

/** Existing secondary runtime is the sole source of an admitted inactive Home binding. */
export function getConcurrentAccountEncryptionObservationBinding(
    serverId: string,
    credentials: AuthCredentials,
): AccountEncryptionObservationBinding | null {
    const binding = getManagedServer(serverId)?.accountEncryptionObservation?.binding;
    return binding && matchesAccountEncryptionObservationCredentials(binding, credentials) && binding.isCurrent() ? binding : null;
}

export function resolveConcurrentTargets(params: Readonly<{
    activeServerId: string;
    profiles: ReadonlyArray<Readonly<{
        id: string;
        serverUrl: string;
        name: string;
        serverIdentityId?: string | null;
        legacyServerIds?: readonly string[];
        homeConnectionDescriptor?: HomeConnectionDescriptorV1;
        canonicalServerUrl?: string;
    }>>;
    settings: ConcurrentSelectionSettings;
}>): ConcurrentTarget[] {
    const selection = getEffectiveServerSelectionFromRawSettings({
        activeServerId: params.activeServerId,
        availableServerIds: listServerProfileScopeIds(params.profiles),
        settings: normalizeServerSelectionSettingsForProfileScopeIds(
            toRawConcurrentSelectionSettings(params.settings),
            params.profiles,
        ),
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
        const serverUrl = normalizeServerUrl(profile.canonicalServerUrl ?? profile.serverUrl);
        if (!serverUrl) continue;
        targets.push({
            id: scopeId,
            serverUrl,
            serverName: resolveHomeDisplayLabel(profile, scopeId),
            ...(profile.canonicalServerUrl ? { canonicalServerUrl: serverUrl } : {}),
            ...(profile.homeConnectionDescriptor
                ? {
                    homeConnectionDescriptor: profile.homeConnectionDescriptor,
                    irohConfigKey: JSON.stringify(profile.homeConnectionDescriptor),
                    canonicalServerUrl: serverUrl,
                }
                : {}),
        });
    }
    return targets;
}

async function getOrCreateEncryption(entry: ManagedConcurrentServer): Promise<Encryption | null> {
    // A retained entry may still serve existing page demand while credential
    // reconciliation is queued. Keep its retired cipher fail-closed; never
    // register that entry's old material over a replacement Account owner.
    if (entry.encryption) return entry.encryption;
    if (isTokenOnlyAuthCredentials(entry.credentials)) return null;
    const capturedCredentialScopeKey = resolveAuthCredentialsScopeKey(entry.credentials);
    const credentials = await TokenStorage.getCredentialsForServerUrl(entry.serverUrl, { serverId: entry.id });
    if (!isManagedServerActive(entry) || !credentials
        || resolveAuthCredentialsScopeKey(entry.credentials) !== capturedCredentialScopeKey
        || !areCredentialsEqual(credentials, entry.credentials)) {
        throw new AccountEncryptionMaterialUnavailableError('The concurrent Home credential was retired');
    }
    entry.encryption = await resolveScopedAccountEncryption({
        serverId: entry.id, serverUrl: entry.serverUrl, credentials,
    });
    return entry.encryption;
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

function readOrdinarySessionListRowsForServer(
    state: ReturnType<typeof storage.getState>,
    serverId: string,
): Readonly<Record<string, SessionListRenderableSession>> {
    const rows = state.sessionListRowsByServerId?.[serverId] ?? {};
    const membership = state.ordinarySessionListMembershipByServerId?.[serverId] ?? [];
    if (membership.length === Object.keys(rows).length && membership.every((sessionId) => Boolean(rows[sessionId]))) {
        return rows;
    }
    return Object.fromEntries(membership.flatMap((sessionId) => {
        const row = rows[sessionId];
        return row ? [[sessionId, row] as const] : [];
    }));
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
                && areSessionListHomeObservationsEqual(previous.listObservation, next.listObservation)
            ) {
                return state;
            }
        }

        return {
            ...state,
            concurrentSessionListCacheByServerId: {
                ...state.concurrentSessionListCacheByServerId,
                [serverId]: next,
            },
        };
    });
}

/**
 * Publishes the exact Home's raw list observation. This is the ordinary-Home half of Lane 07's one
 * currentness fact: `SessionListQueryHomeState` supplies it for query-backed Homes, and every
 * surface projects both through `buildSessionContextFacts` rather than timing its own staleness.
 */
function publishConcurrentSessionListObservation(params: Readonly<{
    entry: ManagedConcurrentServer;
    phase: SessionListHomeObservation['phase'];
}>): void {
    const serverId = normalizeServerId(params.entry.id);
    if (!serverId) return;
    updateConcurrentSessionListCache({
        serverId,
        entry: {
            serverName: String(params.entry.serverName ?? '').trim() || null,
            listObservation: {
                phase: params.phase,
                lastSuccessAt: params.entry.lastSessionListSuccessAt,
            },
        },
    });
}

function publishConcurrentSessionListTargetObservation(params: Readonly<{
    target: ConcurrentTarget;
    phase: SessionListHomeObservation['phase'];
}>): void {
    const serverId = normalizeServerId(params.target.id);
    if (!serverId) return;
    const previous = storage.getState().concurrentSessionListCacheByServerId?.[serverId];
    updateConcurrentSessionListCache({
        serverId,
        entry: {
            serverName: String(params.target.serverName ?? '').trim() || null,
            listObservation: {
                phase: params.phase,
                lastSuccessAt: previous?.listObservation?.lastSuccessAt ?? null,
            },
        },
    });
}

/**
 * One successful Session-list observation for this exact Home. The timestamp always advances in
 * memory; the store is only rewritten when the published phase is not already `ready`, because a
 * current Home renders no last-updated words.
 */
function noteConcurrentSessionListObserved(entry: ManagedConcurrentServer): void {
    entry.lastSessionListSuccessAt = Date.now();
    const serverId = normalizeServerId(entry.id);
    if (!serverId) return;
    const published = storage.getState().concurrentSessionListCacheByServerId?.[serverId];
    if (
        published?.listObservation?.phase === 'ready'
        && (String(published.serverName ?? '').trim() || null) === (String(entry.serverName ?? '').trim() || null)
    ) {
        return;
    }
    publishConcurrentSessionListObservation({ entry, phase: 'ready' });
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
    inventoryChangedAtOwner?: boolean;
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

            return {
                ...state.machineListByServerId,
                [serverId]: nextMachines,
            };
        })();
        const nextMachineListStatusByServerId = state.machineListStatusByServerId?.[serverId] === input.status
            ? state.machineListStatusByServerId
            : {
                ...state.machineListStatusByServerId,
                [serverId]: input.status,
            };

        const nextIndexByServerId = (() => {
            if (nextMachineListByServerId === state.machineListByServerId && !input.inventoryChangedAtOwner) {
                return state.sessionListIndexByServerId;
            }

            const rows = readOrdinarySessionListRowsForServer(state, serverId);
            if (Object.keys(rows).length === 0) {
                return state.sessionListIndexByServerId;
            }

            const serverName = state.concurrentSessionListCacheByServerId?.[serverId]?.serverName ?? undefined;
            const previousIndexByServerId = state.sessionListIndexByServerId ?? {};
            const index = buildSessionListIndexWithServerScope({
                sessions: compactSessionListRowsForViewData(rows),
                machines: buildMachineDisplaysByIdFromMachineList(nextMachineListByServerId?.[serverId]),
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

function isFocusedHomeProjectionRetained(serverId: string): boolean {
    const activeServerId = normalizeServerId(getAppliedActiveServerId());
    const stagedServerId = normalizeServerId(getActiveServerSnapshot().serverId);
    // A profile notification can reconcile the staged destination before the
    // focused owner publishes "applying". Stop its secondary transport, but
    // retain its proven corpus for that transfer. Account replacement still
    // withdraws rows directly through retireReplacedSessionListAccount.
    if (areServerProfileIdentifiersEquivalent(serverId, applyingActiveServerId)) return true;
    if (stagedServerId
        && !areServerProfileIdentifiersEquivalent(stagedServerId, activeServerId)
        && areServerProfileIdentifiersEquivalent(serverId, stagedServerId)) return true;
    return (
        isAppliedActiveServerRuntimeAvailable()
        && areServerProfileIdentifiersEquivalent(serverId, activeServerId)
    );
}

function clearConcurrentSessionListCache(serverIdRaw: string): void {
    const serverId = normalizeServerId(serverIdRaw);
    if (!serverId || isFocusedHomeProjectionRetained(serverId)) return;
    storage.setState((state) => {
        const current = state.concurrentSessionListCacheByServerId ?? {};
        if (!(serverId in current)) return state;

        const next = { ...current };
        delete next[serverId];

        return {
            ...state,
            concurrentSessionListCacheByServerId: next,
        };
    });
    storage.getState().clearSessionListRowsForServerScope(serverId);
}

function clearConcurrentMachineListCache(serverIdRaw: string, options?: Readonly<{ retireAccount: true }>): void {
    const serverId = normalizeServerId(serverIdRaw);
    if (!serverId || !options?.retireAccount && isFocusedHomeProjectionRetained(serverId)) return;
    storage.setState((state) => {
        if (!(serverId in state.machineListByServerId)
            && !(serverId in state.machineListStatusByServerId)
            && !(serverId in state.machinePresenceByServerId)) {
            return state;
        }

        const nextMachines = { ...state.machineListByServerId };
        const nextStatuses = { ...state.machineListStatusByServerId };
        const nextPresence = { ...state.machinePresenceByServerId };
        delete nextMachines[serverId];
        delete nextStatuses[serverId];
        delete nextPresence[serverId];

        return {
            ...state,
            machineListByServerId: nextMachines,
            machineListStatusByServerId: nextStatuses,
            machinePresenceByServerId: nextPresence,
        };
    });
}

async function refreshServerSnapshot(
    entry: ManagedConcurrentServer,
    signal: AbortSignal,
    intent: ConcurrentRefreshIntent,
): Promise<void> {
    const startedAt = Date.now();
    const capturedReadTransport = createCapturedServerReadTransport({ serverId: entry.id, profile: entry, credentials: entry.credentials,
        accountEncryptionObservation: entry.accountEncryptionObservation?.binding, superviseReachability: true });
    let responseBytes = 0;
    const encryption = await getOrCreateEncryption(entry);
    const observeResponse = (response: Response) => {
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > 0) {
            responseBytes += contentLength;
        }
    };
    const request = createServerRequest(entry, observeResponse, signal);
    const readTransport: CapturedServerReadTransport = {
        get key() { return capturedReadTransport.key; },
        read(path, init, options, consumeResponse) {
            return capturedReadTransport.read(path, init, options, async response => {
                observeResponse(response);
                return await consumeResponse(response);
            });
        },
    };
    const shouldContinue = () => (
        !signal.aborted
        && managedServers.get(entry.id) === entry
        && entry.reachabilityState.phase === 'online'
    );
    const refreshMachines = async (): Promise<void> => {
        let machines: Machine[] = [];
        await fetchAndApplyMachines({
            credentials: entry.credentials,
            readAccountMode: async () => (await fetchAccountEncryptionMode(entry.credentials, { request, usage: 'identity' })).mode,
            encryption,
            machineDataKeys: entry.machineDataKeys,
            request,
            readTransport,
            signal,
            shouldContinue,
            throwOnError: true,
            sourceServerId: entry.id,
            replace: true,
            getMachineSnapshot: () => Object.fromEntries((storage.getState().machineListByServerId[entry.id] ?? []).map((machine) => [machine.id, machine])),
            applyMachines: (nextMachines, replace) => {
                if (replace !== false) { machines = nextMachines; return; }
                const current = new Map((storage.getState().machineListByServerId[entry.id] ?? []).map((machine) => [machine.id, machine]));
                for (const machine of nextMachines) current.set(machine.id, machine);
                machines = [...current.values()];
            },
        });
        if (!shouldContinue()) return;
        const previousMachines = storage.getState().machineListByServerId[entry.id] ?? null;
        storage.getState().applyMachines(machines, true, {
            sourceServerId: entry.id,
            sourceAccountId: readCredentialAccountId(entry.credentials),
        });
        const ownedMachines = storage.getState().machineListByServerId[entry.id] ?? null;
        updateConcurrentMachineListCache({
            serverId: entry.id,
            machines: ownedMachines,
            status: 'idle',
            authoritative: true,
            inventoryChangedAtOwner: ownedMachines !== previousMachines,
        });
    };
    if (intent === 'machines') {
        try {
            await refreshMachines();
        } finally {
            syncPerformanceTelemetry.recordDuration('sync.concurrent.refresh', Date.now() - startedAt, { responseBytes });
        }
        return;
    }
    const refreshSessions = async () => {
        let fallbackSessions: Session[] = [];
        let didApplySessionListRenderables = false;
        const previousFrontier = entry.sessionListFrontier;
        const continuation = intent === 'continue'
            ? resolveOrdinarySessionListContinuation(previousFrontier)
            : null;
        // A background refresh revalidates the head without discarding pages the
        // viewer already acquired or consuming their next cursor.
        const retainPages = intent === 'refresh' && entry.hasFetchedSessionListSnapshot;
        const retainedSessionIds = retainPages
            ? Object.keys(storage.getState().sessionListRowsByServerId[entry.id] ?? {})
            : [];
        const retainFrontier = retainPages && resolveOrdinarySessionListContinuation(previousFrontier) !== null;
        const appendRows = continuation !== null || retainPages;
        const result = await fetchAndApplySessions({
            clientEncryptionRequirement: resolveEntryClientEncryptionRequirement(entry),
            serverId: entry.id,
            sessionListCursor: continuation?.kind === 'ordinary' ? continuation.cursor : null,
            sessionListAttentionCursor: continuation?.kind === 'attention' ? continuation.cursor : null,
            sessionListAttentionMaxPages: continuation?.kind === 'attention' ? 1 : 0,
            includeActiveSessionRows: continuation === null,
            includeSessionListAttentionRows: continuation === null || continuation.kind === 'attention',
            credentials: entry.credentials,
            encryption,
            sessionDataKeys: entry.sessionDataKeys,
            sessionDataKeyEnvelopes: entry.sessionDataKeyEnvelopes,
            // Secondary-Home refresh owns the lightweight list projection only. Opening every
            // ordinary row's full Session metadata turns a retained multi-Home account into
            // continuous background work; active, attention, and explicitly demanded rows still
            // hydrate through the shared priority owner.
            sessionListBackgroundHydrationMaxRows: 0,
            request,
            getExistingSession: () => null,
            getCurrentSessionListRenderable: (sessionId) => (
                storage.getState().sessionListRowsByServerId?.[entry.id]?.[sessionId]
                ?? null
            ),
            shouldContinue,
            applySessionListRenderables: (nextRenderables) => {
                if (!shouldContinue()) return;
                didApplySessionListRenderables = true;
                storage.getState().applyServerScopedSessionListRows(entry.id, nextRenderables, {
                    source: 'ordinary',
                    mode: appendRows ? 'append' : 'replace',
                });
            },
            applySessionListRenderablePatches: (patches) => {
                if (!shouldContinue()) return;
                storage.getState().applyServerScopedSessionListRowPatches(entry.id, patches);
            },
            applySessions: (nextSessions) => {
                // Compatibility for focused test doubles and older adapters that
                // still exercise only the hydrated callback. Production applies
                // the lightweight renderable projection above.
                if (!didApplySessionListRenderables) fallbackSessions = nextSessions as Session[];
            },
            log: { log: () => {} },
        });
        if (!result.current || !shouldContinue()) return;
        // A partial head proves access only for the rows it returned. Older acquired
        // pages (including archived/query rows) need the canonical exact access read:
        // a Team/Group withdrawal wakes this Home without naming changed Session ids.
        const observedSessionIds = new Set(result.sessionIds);
        const projectionEncryption = getScopedSessionByIdEncryption(encryption);
        let reconciliationFailed = false;
        for (const sessionId of retainedSessionIds) {
            if (observedSessionIds.has(sessionId) || result.isSessionCurrent?.(sessionId) === false) continue;
            const exact = await fetchAndApplySessionById({
                sessionId,
                serverId: entry.id,
                contentDemand: 'list-projection',
                credentials: entry.credentials,
                encryption: projectionEncryption,
                sessionDataKeys: entry.sessionDataKeys,
                sessionDataKeyEnvelopes: entry.sessionDataKeyEnvelopes,
                request,
                readTransport,
                signal,
                clientEncryptionRequirement: resolveEntryClientEncryptionRequirement(entry),
                accessProjectionVersion: readSessionDetailAccessProjectionVersion(entry.id),
                includeTurnsProjection: false,
                isCurrent: () => shouldContinue() && result.isSessionCurrent?.(sessionId) !== false,
                getCurrentSessionListRenderable: (id) => storage.getState().sessionListRowsByServerId[entry.id]?.[id],
                applySessions: () => {},
                log: { log: () => {} },
            });
            if (!shouldContinue()) return;
            if (result.isSessionCurrent?.(sessionId) === false) continue;
            if (!exact.ok) {
                if (exact.errorCode === 'not_found') {
                    retireConcurrentSession(entry, sessionId);
                } else {
                    reconciliationFailed = true;
                }
                continue;
            }
            if (!exact.sessionListRenderable) {
                reconciliationFailed = true;
                continue;
            }
            storage.getState().applyServerScopedSessionListRows(entry.id, [exact.sessionListRenderable], {
                source: 'rowOnly', mode: 'append',
            });
        }
        if (!shouldContinue()) return;
        if (reconciliationFailed) throw new Error('Retained Session access reconciliation failed');
        entry.hasFetchedSessionListSnapshot = true;
        entry.sessionListFrontier = retainFrontier ? previousFrontier : advanceOrdinarySessionListFrontier({
            previous: continuation ? previousFrontier : EMPTY_ORDINARY_SESSION_LIST_FRONTIER,
            continuation,
            result,
        });
        noteConcurrentSessionListObserved(entry);

        await ensureSessionDisplayProjectionsForRead({ serverId: entry.id, credentials: entry.credentials,
            request: (path, init) => request(path, init), prefetched: result.prefetchedFullSessionReads,
            signal, isCurrent: shouldContinue });

        if (!didApplySessionListRenderables) {
            const previousRows = storage.getState().sessionListRowsByServerId?.[entry.id] ?? {};
            const nextRenderables = fallbackSessions.map((session) => (
                buildSessionListRenderableFromSession(session, previousRows[session.id])
            ));
            storage.getState().applyServerScopedSessionListRows(entry.id, nextRenderables, {
                source: 'ordinary',
                mode: appendRows ? 'append' : 'replace',
            });
        }
    };
    try {
        // A Session-list failure cannot suppress an independent Machine grant read.
        // Settle both readers before releasing this Home's refresh lifetime.
        const outcomes = await Promise.allSettled([refreshSessions(), refreshMachines()]);
        for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    } finally {
        syncPerformanceTelemetry.recordDuration(
            'sync.concurrent.refresh',
            Date.now() - startedAt,
            { responseBytes },
        );
    }
}

function retireConcurrentSession(entry: ManagedConcurrentServer, sessionId: string): void {
    if (!isManagedServerActive(entry)) return;
    getSyncSingleton().retireLocalSession(sessionId, entry.id);
    entry.sessionDataKeys.delete(sessionId);
    entry.sessionDataKeyEnvelopes.delete(sessionId);
    entry.encryption?.removeSessionEncryption(sessionId);
}

/**
 * Whether this runtime owns the Home's ordinary `/v2/sessions` corpus.
 *
 * Sync owns the applied active Home's ordinary corpus and this cache owns every
 * other managed Home's. A filter mounted on such a Home reads the incumbent
 * frontier through this seam instead of opening a second paginator over the
 * same membership.
 */
export function isConcurrentOrdinarySessionListHome(serverIdRaw: string): boolean {
    const serverId = normalizeServerId(serverIdRaw);
    return serverId.length > 0 && getManagedServer(serverId) !== undefined;
}

/** This Home's ordinary list lifecycle, in the shape its single projector reads. */
export function readConcurrentOrdinarySessionListLifecycle(
    serverIdRaw: string,
): OrdinarySessionListLifecycle {
    const serverId = normalizeServerId(serverIdRaw);
    const entry = getManagedServer(serverId);
    if (!entry) {
        return {
            serverId: serverId || null,
            hasFetchedSnapshot: false,
            fetchInFlight: false,
            fetchMoreInFlight: false,
            frontier: EMPTY_ORDINARY_SESSION_LIST_FRONTIER,
        };
    }
    // The list can finish before the same refresh's machine inventory tail.
    // Its published observation, not that shared promise, owns list readiness.
    const phase = storage.getState().concurrentSessionListCacheByServerId?.[entry.id]?.listObservation?.phase;
    const inFlight = entry.refreshInFlight !== null && (phase === 'loading' || phase === 'refreshing');
    return {
        serverId,
        hasFetchedSnapshot: entry.hasFetchedSessionListSnapshot,
        fetchInFlight: inFlight && !entry.hasFetchedSessionListSnapshot,
        fetchMoreInFlight: inFlight && entry.hasFetchedSessionListSnapshot,
        frontier: entry.sessionListFrontier,
    };
}

/** Advance this Home's incumbent ordinary frontier. There is no second cursor. */
export async function loadNextConcurrentOrdinarySessionListPage(serverIdRaw: string): Promise<void> {
    const entry = getManagedServer(serverIdRaw);
    if (!entry) return;
    const pending = entry.refreshInFlight;
    const requestedContinuation = resolveOrdinarySessionListContinuation(entry.sessionListFrontier);
    if (pending) await pending;
    if (getManagedServer(serverIdRaw) !== entry) return;
    const currentContinuation = resolveOrdinarySessionListContinuation(entry.sessionListFrontier);
    if (pending && requestedContinuation && (requestedContinuation.kind !== currentContinuation?.kind
        || requestedContinuation.cursor !== currentContinuation?.cursor)) return;
    if (entry.refreshInFlight) return entry.refreshInFlight;
    if (!resolveOrdinarySessionListContinuation(entry.sessionListFrontier)) return;
    await runRefresh(entry, 'other', 'continue');
}

/** Replace this Home's ordinary corpus from page one. */
export async function refreshConcurrentOrdinarySessionList(serverIdRaw: string): Promise<void> {
    const entry = getManagedServer(serverIdRaw);
    if (!entry) return;
    await runRefresh(entry, 'other', 'replace');
}

/** Manual inventory refresh uses this Home's incumbent Machine fetch/apply lifecycle. */
export async function refreshConcurrentMachineList(serverIdRaw: string): Promise<boolean> {
    const entry = getManagedServer(serverIdRaw);
    if (!entry) return false;
    await runRefresh(entry, 'other', 'machines');
    return true;
}

export function isConcurrentSessionListQueryHomeOnline(serverIdRaw: string): boolean {
    const serverId = normalizeServerId(serverIdRaw);
    const entry = getManagedServer(serverId);
    return Boolean(entry && entry.reachabilityState.phase === 'online');
}

export type ConcurrentSessionListQueryHomeAvailability = 'online' | 'pending' | 'offline';

/**
 * Query availability projected from this secondary runtime's existing reachability and
 * Session-list lifecycle. `pending` covers initial acquisition without inventing a second
 * transport-state owner for consumers.
 */
export function getConcurrentSessionListQueryHomeAvailability(
    serverIdRaw: string,
): ConcurrentSessionListQueryHomeAvailability {
    const serverId = normalizeServerId(serverIdRaw);
    const entry = getManagedServer(serverId);
    if (entry) {
        if (entry.reachabilityState.phase === 'online') return 'online';
        if (entry.reachabilityState.phase === 'idle' || entry.reachabilityState.phase === 'connecting') {
            if (!entry.irohLease && storage.getState().concurrentSessionListCacheByServerId?.[serverId]?.listObservation?.phase === 'offline') {
                return 'offline';
            }
            return 'pending';
        }
        return 'offline';
    }
    const phase = storage.getState().concurrentSessionListCacheByServerId?.[serverId]?.listObservation?.phase;
    return phase === 'loading' || phase === 'refreshing' ? 'pending' : 'offline';
}

/**
 * Explicit user retry for a secondary Home. The concurrent-cache owner keeps
 * its existing reachability lease and reconciliation lifecycle authoritative;
 * callers only ask it to invalidate that exact Home's probe and reconcile the
 * selected target set.
 */
export async function retryConcurrentSessionListQueryHome(serverIdRaw: string): Promise<void> {
    const serverId = normalizeServerId(serverIdRaw);
    if (!serverId) return;
    const entry = getManagedServer(serverId);
    if (entry) {
        await invalidateServerReachabilitySupervisor({
            serverUrl: entry.serverUrl,
            token: entry.credentials.token,
        });
        if (isManagedServerActive(entry) && entry.reachabilityState.phase === 'online') {
            queueRefresh(entry);
        }
    }
    scheduleReconcile();
}

export async function fetchConcurrentSessionListQueryPage(
    serverIdRaw: string,
    page: SessionListQueryPageRequest,
) {
    const serverId = normalizeServerId(serverIdRaw);
    const entry = getManagedServer(serverId);
    if (!entry || entry.reachabilityState.phase !== 'online') {
        throw new HappyError('Selected Home query runtime is unavailable', true, {
            kind: 'network',
            code: 'home_unavailable',
        });
    }
    const encryption = await getOrCreateEncryption(entry);
    const request = createServerRequest(entry, () => {}, page.signal);
    const shouldContinue = () => (
        !page.signal.aborted
        && managedServers.get(entry.id) === entry
        && entry.reachabilityState.phase === 'online'
    );
    const result = await fetchAndApplySessions({
        clientEncryptionRequirement: resolveEntryClientEncryptionRequirement(entry),
        serverId,
        source: page.source,
        signal: page.signal,
        sessionListPageSize: page.limit ?? (page.source.kind === 'query' ? page.source.body.limit : undefined),
        sessionListCursor: page.cursor,
        sessionListAttentionCursor: page.attentionCursor,
        sessionListMaxPages: 1,
        sessionListAttentionMaxPages: page.attentionCursor ? 1 : 0,
        requiredHydrationSessionIds: page.hydration === 'required' ? 'all' : undefined,
        candidateStartedBy: page.candidateStartedBy,
        awaitSessionListHydration: page.hydration === 'required',
        credentials: entry.credentials,
        encryption,
        sessionDataKeys: entry.sessionDataKeys,
        sessionDataKeyEnvelopes: entry.sessionDataKeyEnvelopes,
        request,
        getExistingSession: () => null,
        getCurrentSessionListRenderable: (sessionId) => (
            storage.getState().sessionListRowsByServerId?.[serverId]?.[sessionId]
            ?? null
        ),
        shouldContinue,
        applySessionListRenderables: (sessions) => {
            if (!shouldContinue()) return;
            storage.getState().applyServerScopedSessionListRows(serverId, sessions, {
                // Ordinary, archived and query pages share this pagination owner but
                // remain distinct canonical memberships in the store.
                source: page.membership,
                mode: page.cursor || page.attentionCursor ? 'append' : 'replace',
            });
        },
        applySessionListRenderablePatches: (patches) => {
            if (!shouldContinue()) return;
            storage.getState().applyServerScopedSessionListRowPatches(serverId, patches);
            // Row hydration from an ad-hoc Voice/Action read is not a list observation: it owns no
            // membership, so letting it advance this Home's currentness would make a one-off
            // command answer "how fresh is this Home's Session list" (Lane 07.2 §6, L07-I35).
            if (page.membership === 'ordinary') noteConcurrentSessionListObserved(entry);
        },
        applySessions: () => {},
        log: { log: () => {} },
    });
    await ensureSessionDisplayProjectionsForRead({ serverId, credentials: entry.credentials, request,
        prefetched: result.prefetchedFullSessionReads, signal: page.signal, isCurrent: shouldContinue });
    const { prefetchedFullSessionReads: _consumedFullReads, ...publishedResult } = result;
    return publishedResult;
}

/**
 * A concurrent Home is read under its own Account's encryption requirement, never
 * the focused Account's settings projection: switching focus must not change which
 * of this Home's Sessions its reader admits. An Account the credential cannot name
 * is read under the strictest requirement rather than borrowing another Account's.
 */
function resolveEntryClientEncryptionRequirement(entry: ManagedConcurrentServer): ClientEncryptionRequirement {
    const accountId = readCredentialAccountId(entry.credentials);
    const scope = createServerAccountScope(entry.id, accountId);
    return scope
        ? resolveUiClientEncryptionRequirementForScope({ scope, focusedSettings: storage.getState().settings })
        : 'require_e2ee';
}

function isManagedServerActive(entry: ManagedConcurrentServer): boolean {
    return managedServers.get(entry.id) === entry;
}

function mergeRefreshIntent(left: ConcurrentRefreshIntent | null, right: ConcurrentRefreshIntent): ConcurrentRefreshIntent {
    if (left === 'replace' || right === 'replace') return 'replace';
    if (left === 'continue' || right === 'continue') return 'continue';
    if (left === 'refresh' || right === 'refresh') return 'refresh';
    return 'machines';
}

function queueRefresh(
    entry: ManagedConcurrentServer,
    source: 'socket' | 'other' = 'other',
    intent: ConcurrentRefreshIntent = 'refresh',
): void {
    if (!isManagedServerActive(entry)) return;
    if (entry.reachabilityState.phase !== 'online') return;
    if (entry.refreshTimer) {
        entry.refreshTimerIntent = mergeRefreshIntent(entry.refreshTimerIntent, intent);
        if (source === 'socket') {
            syncPerformanceTelemetry.count('sync.concurrent.refresh.socket', { coalesced: 1 });
        }
        return;
    }
    entry.refreshTimerIntent = intent;
    if (source === 'socket') {
        syncPerformanceTelemetry.count('sync.concurrent.refresh.socket', { enqueued: 1 });
    }
    entry.refreshTimer = setTimeout(() => {
        entry.refreshTimer = null;
        const refreshIntent = entry.refreshTimerIntent ?? 'refresh';
        entry.refreshTimerIntent = null;
        void runRefresh(entry, source, refreshIntent);
    }, REFRESH_DEBOUNCE_MS);
}

async function runRefresh(
    entry: ManagedConcurrentServer,
    source: 'socket' | 'other',
    intent: ConcurrentRefreshIntent = 'refresh',
): Promise<void> {
    if (!isManagedServerActive(entry)) return;
    if (entry.reachabilityState.phase !== 'online') return;
    if (entry.refreshInFlight) {
        entry.refreshQueued = mergeRefreshIntent(entry.refreshQueued, intent);
        if (source === 'socket') {
            syncPerformanceTelemetry.count('sync.concurrent.refresh.socket', { inFlightQueued: 1 });
        }
        // The current attempt installs the coalesced replacement before settling.
        // A Refresh caller must await that replacement, not just the old page.
        return entry.refreshInFlight.then(() => entry.refreshInFlight ?? Promise.resolve());
    }
    if (intent === 'replace') {
        if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
        entry.refreshTimer = null;
        entry.sessionListFrontier = EMPTY_ORDINARY_SESSION_LIST_FRONTIER;
    }
    entry.refreshInFlight = (async () => {
        const abortController = new AbortController();
        entry.refreshAbortController = abortController;
        // One observation lifecycle per attempt: publish the attempt before the work so a Home
        // with retained rows reads as refreshing rather than current, and a Home that has never
        // been observed reads as loading rather than absent.
        const successAtBeforeRefresh = entry.lastSessionListSuccessAt;
        const refreshesSessions = intent !== 'machines';
        if (refreshesSessions) {
            publishConcurrentSessionListObservation({
                entry,
                phase: successAtBeforeRefresh === null ? 'loading' : 'refreshing',
            });
        }
        try {
            await refreshServerSnapshot(entry, abortController.signal, intent);
        } catch (error) {
            if (abortController.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
                return;
            }
            if (!isManagedServerActive(entry)) return;
            // The exact-token reachability owner already retired this Account's
            // projections. Its signed-out fact outranks this request's rejection.
            if (entry.reachabilityState.phase === 'auth_failed') return;
            const cachedMachines = storage.getState().machineListByServerId?.[entry.id] ?? null;
            updateConcurrentMachineListCache({
                serverId: entry.id,
                machines: cachedMachines,
                status: 'error',
            });
            // Only this attempt's own failure is publishable. A Session-list success that landed
            // during it and the reachability owner's `offline` fact are both more current than a
            // stale error, so neither is overwritten. The last success time is preserved either
            // way, so retained rows stay truthfully labelled.
            if (refreshesSessions &&
                entry.reachabilityState.phase === 'online'
                && entry.lastSessionListSuccessAt === successAtBeforeRefresh
            ) {
                publishConcurrentSessionListObservation({ entry, phase: 'error' });
            }
        } finally {
            if (entry.refreshAbortController === abortController) {
                entry.refreshAbortController = null;
            }
        }
    })().finally(() => {
        entry.refreshInFlight = null;
        if (entry.refreshQueued && isManagedServerActive(entry)) {
            const queuedIntent = entry.refreshQueued;
            entry.refreshQueued = null;
            if (queuedIntent === 'replace') void runRefresh(entry, 'other', 'replace');
            else queueRefresh(entry, 'other', queuedIntent);
        }
    });
    await entry.refreshInFlight;
}

async function disposeManagedServer(entry: ManagedConcurrentServer): Promise<void> {
    entry.accountEncryptionObservation?.dispose();
    entry.accountEncryptionObservation = null;
    entry.reachabilityAcquireGeneration += 1;
    entry.refreshQueued = null;
    entry.refreshAbortController?.abort('secondary-runtime-disposed');
    entry.refreshAbortController = null;
    if (entry.refreshTimer) {
        clearTimeout(entry.refreshTimer);
        entry.refreshTimer = null;
    }
    entry.refreshTimerIntent = null;
    entry.reachabilityUnsubscribe?.();
    entry.reachabilityUnsubscribe = null;
    const reachabilityRelease = entry.reachabilityRelease;
    entry.reachabilityRelease = null;
    entry.socket = null;
    for (const detach of entry.detachSocketTransportListeners.splice(0)) {
        detach();
    }
    const transport = entry.socketTransport;
    entry.socketTransport = null;
    const socketSupervisor = entry.socketSupervisor;
    entry.socketSupervisor = null;
    const irohLease = entry.irohLease;
    entry.irohLease = null;
    if (managedServers.get(entry.id) === entry) {
        // A replacement HTTP carrier can be online before its socket connects.
        // New page demand must not join work bound to this retired entry.
        invalidateHomeAccountReadJoins(entry.id);
        managedServers.delete(entry.id);
        reconcilePeriodicRefreshDemand();
    }
    invalidateCachedTransferRoutesForServer({ serverId: entry.id });
    await Promise.allSettled([
        reachabilityRelease?.(),
        socketSupervisor ? socketSupervisor.stop() : transport?.destroy(),
        irohLease?.release(),
    ].filter((pending): pending is Promise<void> => Boolean(pending)));
}

function stopManagedServer(serverId: string): void {
    const entry = getManagedServer(serverId);
    if (!entry) return;
    void disposeManagedServer(entry);
}

function reconcilePeriodicRefreshDemand(): void {
    if (!started || managedServers.size === 0) {
        periodicRefreshStop?.();
        periodicRefreshStop = null;
        return;
    }
    if (periodicRefreshStop) return;
    // Selected secondary Homes remain live in the background; saved Homes alone
    // are not refresh demand. Selection/credential/profile events acquire them.
    periodicRefreshStop = startRuntimeActiveGatedInterval(() => {
        for (const entry of managedServers.values()) {
            queueRefresh(entry);
        }
        scheduleReconcile();
    }, readRefreshIntervalMs());
}

function createManagedServer(
    target: ConcurrentTarget,
    credentials: AuthCredentials,
    previous: ManagedConcurrentServer | undefined,
): ManagedConcurrentServer {
    const normalizedServerUrl = normalizeServerUrl(target.serverUrl) || target.serverUrl;
    const entry: ManagedConcurrentServer = {
        id: target.id,
        serverUrl: normalizedServerUrl,
        serverName: target.serverName,
        homeConnectionDescriptor: target.homeConnectionDescriptor,
        credentials,
        socket: null,
        socketTransport: null,
        socketSupervisor: null,
        accountEncryptionObservation: null,
        reachabilityUnsubscribe: null,
        reachabilityRelease: null,
        reachabilityAcquireGeneration: 0,
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
        irohLease: null,
        irohConfigKey: target.irohConfigKey ?? null,
        refreshQueued: null,
        refreshInFlight: null,
        refreshAbortController: null,
        refreshTimer: null,
        refreshTimerIntent: null,
        sessionListFrontier: previous?.sessionListFrontier ?? EMPTY_ORDINARY_SESSION_LIST_FRONTIER,
        hasFetchedSessionListSnapshot: previous?.hasFetchedSessionListSnapshot ?? false,
        // Recreating the managed entry (credential rotation, carrier change) does not un-observe
        // this Home: its retained rows keep the success time already published for that exact
        // serverId, so the first attempt of the new entry cannot report "never observed".
        lastSessionListSuccessAt: storage.getState()
            .concurrentSessionListCacheByServerId?.[normalizeServerId(target.id)]
            ?.listObservation?.lastSuccessAt ?? null,
    };

    // This exact Account owns the retained corpus while its replacement carrier
    // is acquired. Idle entries admit no reads or socket ingress; the retired
    // transport is never kept alive as a fallback for an unverified carrier.
    managedServers.set(entry.id, entry);
    reconcilePeriodicRefreshDemand();
    publishConcurrentSessionListObservation({
        entry,
        phase: entry.lastSessionListSuccessAt === null ? 'loading' : 'refreshing',
    });
    return entry;
}

function applyConcurrentDurableMessageProjection(
    entry: ManagedConcurrentServer,
    update: ApiUpdateContainer,
    renderable: SessionListRenderableSession,
): void {
    if (update.body.t !== 'new-message' && update.body.t !== 'message-updated') return;
    storage.getState().applyServerScopedSessionListRowPatches(entry.id, [{
        sessionId: update.body.sid,
        patch: buildCacheOnlyDurableMessageProjectionPatch({
            renderable,
            updateData: update,
            rawMessage: update.body.message,
            messageSeq: update.body.message.seq,
        }),
    }]);
}

async function refreshConcurrentDurableMessageRow(
    entry: ManagedConcurrentServer,
    socket: ConcurrentServerSocket,
    update: ApiUpdateContainer,
): Promise<void> {
    if (update.body.t !== 'new-message' && update.body.t !== 'message-updated') return;
    const sessionId = update.body.sid;
    const retirementFence = captureSessionListRetirementFence();
    const credentials = entry.credentials;
    const shouldContinue = () => isManagedServerActive(entry)
        && entry.socket === socket && entry.credentials === credentials
        && entry.reachabilityState.phase === 'online'
        && !wasSessionRetiredSinceFence(retirementFence, entry.id, sessionId);
    const encryption = await getOrCreateEncryption(entry);
    if (!shouldContinue()) return;
    const result = await fetchAndApplySessionById({
        sessionId,
        serverId: entry.id,
        contentDemand: 'list-projection',
        credentials,
        encryption: getScopedSessionByIdEncryption(encryption),
        sessionDataKeys: entry.sessionDataKeys,
        sessionDataKeyEnvelopes: entry.sessionDataKeyEnvelopes,
        request: createServerRequest(entry, () => {}),
        // The canonical Session-parts owner shares concurrent exact reads and
        // batches distinct ids; the socket keeps no second pending-read map.
        readTransport: createCapturedServerReadTransport({ serverId: entry.id, profile: entry, credentials,
            accountEncryptionObservation: entry.accountEncryptionObservation?.binding, superviseReachability: true }),
        clientEncryptionRequirement: resolveEntryClientEncryptionRequirement(entry),
        accessProjectionVersion: readSessionDetailAccessProjectionVersion(entry.id),
        includeTurnsProjection: false,
        isCurrent: shouldContinue,
        getCurrentSessionListRenderable: id => storage.getState().sessionListRowsByServerId[entry.id]?.[id],
        applySessions: () => {},
        log: { log: () => {} },
    });
    if (!shouldContinue()) return;
    if (!result.ok) {
        if (result.errorCode === 'not_found') {
            retireConcurrentSession(entry, sessionId);
            return;
        }
        throw new Error(`Concurrent Session observation read failed: ${result.errorCode ?? 'unknown'}`);
    }
    const current = storage.getState().sessionListRowsByServerId[entry.id]?.[sessionId];
    const renderable = current ?? result.sessionListRenderable;
    if (!renderable) throw new Error('Concurrent Session observation read returned no row');
    if (!current) storage.getState().applyServerScopedSessionListRows(entry.id, [renderable], { source: 'rowOnly', mode: 'append' });
    applyConcurrentDurableMessageProjection(entry, update, renderable);
}

async function connectManagedServer(
    entry: ManagedConcurrentServer,
    irohLease: ResolvedServerScopedTransport,
): Promise<void> {
    const normalizedServerUrl = entry.serverUrl;
    const credentials = entry.credentials;
    entry.irohLease = irohLease;
    // The reachability subscription emits synchronously. The exact entry is
    // already published, and only its verified carrier can initialize it.
    entry.reachabilityUnsubscribe = subscribeServerReachabilityState(normalizedServerUrl, (state) => {
        if (!isManagedServerActive(entry)) return;
        const previousPhase = entry.reachabilityState.phase;
        entry.reachabilityState = state;
        if (state.phase !== 'online') void entry.socketSupervisor?.stop();

        if (state.phase === 'auth_failed') {
            updateConcurrentSessionListCache({ serverId: entry.id, entry: null });
            clearConcurrentSessionListCache(entry.id);
            updateConcurrentMachineListCache({
                serverId: entry.id,
                machines: null,
                status: 'signedOut',
            });
            return;
        }

        if (state.phase !== 'online') {
            const isInitialConnection = state.phase === 'idle' || state.phase === 'connecting';
            const cachedMachines = storage.getState().machineListByServerId?.[entry.id] ?? null;
            updateConcurrentMachineListCache({
                serverId: entry.id,
                machines: cachedMachines,
                status: isInitialConnection ? 'loading' : 'error',
            });
            // Retained rows stay visible; the shared context owner labels them as this Home's
            // last known truth rather than letting a surface guess or drop them.
            publishConcurrentSessionListObservation({
                entry,
                phase: isInitialConnection ? 'loading' : 'offline',
            });
            return;
        }

        // Reachability returning does not make this Home's rows current: the observation stays at
        // its last published phase until a real list observation lands and flips it to `ready`.
        if (previousPhase !== 'online') {
            schedulePushTokenReconciliation();
        }

        if (!entry.socketSupervisor) {
            const createTransport = () => {
                for (const detach of entry.detachSocketTransportListeners.splice(0)) detach();
                entry.accountEncryptionObservation?.dispose();
                const { socket, transport } = createConcurrentServerSocketTransport({
                    serverUrl: normalizedServerUrl,
                    token: credentials.token,
                    ...(entry.irohLease
                        ? { runtimeOrigin: entry.irohLease.runtimeOrigin, carrier: entry.irohLease.carrier }
                        : {}),
                    ...(entry.irohLease?.homeCarrier ? { homeCarrier: entry.irohLease.homeCarrier } : {}),
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
                let ingressAccountId: string | null = null;
                try {
                    ingressAccountId = parseToken(credentials.token);
                } catch {
                    // Authentication/reachability owns invalid credentials. Action ingress fails closed.
                }
                const accountEncryptionObservation = ingressAccountId ? createSocketAccountEncryptionObservation({
                    credentials, serverId: entry.id,
                    endpointUrl: entry.serverUrl,
                    runtimeOrigin: entry.irohLease?.runtimeOrigin ?? entry.serverUrl,
                    homeCarrierEndpointId: entry.irohLease?.homeCarrier?.endpointId ?? null,
                    request: createServerFetchAtEndpoint({ endpointUrl: entry.serverUrl, serverId: entry.id, credentials,
                        ...(entry.irohLease ? { runtimeOrigin: entry.irohLease.runtimeOrigin } : {}),
                        ...(entry.irohLease?.homeCarrier ? { homeCarrier: entry.irohLease.homeCarrier } : {}),
                    }),
                    isCurrent: () => isManagedServerActive(entry) && entry.socket === socket && entry.credentials === credentials,
                }) : null;
                entry.accountEncryptionObservation = accountEncryptionObservation;
                const captureSessionRealtimeScope = () => {
                    const encryption = entry.encryption;
                    const cipherLifetime = captureEncryptionGenerationCurrentness(encryption, { accountId: ingressAccountId ?? undefined, serverId: entry.id });
                    return { serverId: entry.id, encryption, credentials,
                        isCurrent: () => isManagedServerActive(entry) && entry.socket === socket && entry.credentials === credentials
                            && entry.encryption === encryption && cipherLifetime.isCurrent(),
                    };
                };
                socket.on('update', (raw: unknown) => {
                    if (!isManagedServerActive(entry) || entry.socket !== socket) return;
                    accountEncryptionObservation?.update(raw);
                    if (isAccountChangeUpdate(raw)) {
                        schedulePushTokenReconciliation();
                        publishHomeAccountChange(entry.id);
                    }
                    const impact = classifyConcurrentSessionCacheUpdate(raw);
                    if (impact === null) {
                        return;
                    }
                    if (impact === 'message') {
                        const update = UpdateContainerSchema.safeParse(raw);
                        if (update.success && (update.data.body.t === 'new-message' || update.data.body.t === 'message-updated')) {
                            fireAndForget(getSyncSingleton().consumeSessionRealtimeUpdateForHome({
                                ...captureSessionRealtimeScope(), update: update.data,
                            }), { tag: 'concurrentSessionCache.sessionRealtime' });
                            const sessionId = update.data.body.sid;
                            const renderable = storage.getState().sessionListRowsByServerId[entry.id]?.[sessionId];
                            if (renderable) {
                                applyConcurrentDurableMessageProjection(entry, update.data, renderable);
                            } else {
                                fireAndForget(refreshConcurrentDurableMessageRow(entry, socket, update.data), {
                                    tag: 'concurrentSessionCache.durableMessageRow',
                                });
                            }
                        }
                        return;
                    }
                    if (impact === 'snapshot') {
                        const update = UpdateContainerSchema.safeParse(raw);
                        if (update.success && update.data.body.t === 'pending-changed') {
                            const body = update.data.body;
                            const session = storage.getState().sessions[body.sid];
                            // The secondary transport owns only its Home. Reuse the same
                            // pending projection as the focused socket for an open Session;
                            // its lightweight list refresh does not hydrate that store row.
                            if (session && areServerProfileIdentifiersEquivalent(session.serverId, entry.id)) {
                                storage.getState().applySessions([{ ...session, ...buildPendingChangedSessionPatch(body) }], 'projection');
                            }
                        }
                    }
                    if (impact === 'delete' || impact === 'archive') {
                        const update = UpdateContainerSchema.safeParse(raw);
                        if (update.success && (update.data.body.t === 'delete-session'
                            || update.data.body.t === 'session-share-revoked')) {
                            // The shared retirement owner removes every membership for
                            // this exact Home and fences an older page still in flight.
                            const sessionId = update.data.body.t === 'delete-session'
                                ? update.data.body.sid
                                : update.data.body.sessionId;
                            retireConcurrentSession(entry, sessionId);
                            return;
                        }
                        if (update.success && update.data.body.t === 'update-session'
                            && update.data.body.archivedAt !== undefined) {
                            const body = update.data.body;
                            const currentRow = storage.getState().sessionListRowsByServerId[entry.id]?.[body.id];
                            if (currentRow) {
                                storage.getState().applyServerScopedSessionListRowPatches(entry.id, [{
                                    sessionId: body.id,
                                    patch: {
                                        archivedAt: body.archivedAt,
                                        updatedAt: update.data.createdAt,
                                        seq: computeNextSessionSeqFromUpdate({
                                            currentSessionSeq: currentRow.seq ?? 0,
                                            updateType: 'update-session',
                                            containerSeq: update.data.seq,
                                            messageSeq: undefined,
                                        }),
                                    },
                                }]);
                                fireAndForget(invalidateSessionListQueryHome(entry.id), {
                                    tag: 'concurrentSessionCache.archive.query',
                                });
                                return;
                            }
                        }
                    }
                    queueRefresh(entry, 'socket', impact === 'machines' ? 'machines' : 'refresh');
                });
                socket.on('ephemeral', (raw: unknown) => {
                    if (!isManagedServerActive(entry) || entry.socket !== socket) return;
                    const usage = EphemeralUpdateSchema.safeParse(raw);
                    if (usage.success && (usage.data.type === 'transcript-stream-segment' || usage.data.type === 'transcript-stream-segment-delta')) {
                        fireAndForget(getSyncSingleton().consumeSessionRealtimeEphemeralForHome({
                            ...captureSessionRealtimeScope(), update: usage.data,
                        }), { tag: 'concurrentSessionCache.sessionStream' });
                        return;
                    }
                    if (usage.success && usage.data.type === 'machine-activity' && ingressAccountId) {
                        const scope = { serverId: entry.id, accountId: ingressAccountId };
                        const update = usage.data;
                        const observe = captureMachinePresenceObservation(scope);
                        storage.getState().applyMachineActivityUpdates([
                            { id: update.id, active: update.active, activeAt: update.activeAt },
                        ], { sourceServerId: entry.id });
                        observe([update.id]);
                        if (update.active === true && update.reconnected === true) {
                            clearMachineRequestReachabilityForMachine(scope, update.id);
                        }
                    }
                    if (usage.success && (usage.data.type === 'usage' || usage.data.type === 'usage-sources-invalidated')) {
                        publishHomeAccountChange(entry.id, [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1]);
                        return;
                    }
                    statusDemandTransport.observeEphemeral(raw);
                    if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'execution-run-updated') {
                        notifyExecutionRunActivityFromUpdate(entry.id, raw);
                        return;
                    }
                    const update = normalizeActionOperationEphemeralIngress(raw);
                    const encryption = entry.encryption;
                    if (!update || !ingressAccountId) return;
                    const accountId = ingressAccountId;
                    const carrier = entry.irohLease;
                    const cipherLifetime = captureEncryptionGenerationCurrentness(encryption, { accountId, serverId: entry.id });
                    const isCurrent = () => isManagedServerActive(entry) && entry.credentials === credentials
                        && entry.encryption === encryption && entry.irohLease === carrier && cipherLifetime.isCurrent();
                    const request = createServerFetchAtEndpoint({ endpointUrl: entry.serverUrl, serverId: entry.id, credentials,
                        accountEncryptionObservation: entry.accountEncryptionObservation?.binding,
                        ...(carrier ? { runtimeOrigin: carrier.runtimeOrigin } : {}),
                        ...(carrier?.homeCarrier ? { homeCarrier: carrier.homeCarrier } : {}),
                    });
                    fireAndForget((async () => {
                        const mode = (await fetchAccountEncryptionMode(credentials, { request, usage: 'identity' })).mode;
                        if (!isCurrent()) return;
                        await consumeActionOperationSnapshotPush({ update, accountId, accountEncryptionMode: mode,
                            sourceServerId: entry.id,
                            ...(encryption ? { openSnapshot: (ciphertext: string) => encryption.openActionOperationSnapshotRaw(ciphertext) } : {}),
                            readSnapshot: operationId => getActionOperation({ operationId, machineId: update.machineId,
                                serverId: entry.id, accountId, requireCurrentDomainFacts: true }),
                            shouldContinue: isCurrent,
                            onSnapshot: operation => actionOperationPresentationCoordinator.observe(operation),
                        });
                    })(), { tag: 'concurrentSessionCache.actionOperationEphemeral' });
                });

                entry.detachSocketTransportListeners = [
                    attachManagedSessionHumanPresenceSocket({
                        serverId: entry.id, token: credentials.token, socket, transport,
                    }),
                    attachManagedSessionConsumptionSocket({ serverId: entry.id, socket, transport,
                        onLiveConsumptionAdmitted: sessionIds => {
                            const isCurrent = () => isManagedServerActive(entry) && entry.socket === socket && entry.credentials === credentials;
                            if (!isCurrent()) return;
                            getSyncSingleton().onSessionLiveConsumptionAdmittedForHome(entry.id, sessionIds, isCurrent);
                        },
                    }),
                    transport.onConnected(() => {
                        if (!isManagedServerActive(entry) || entry.socket !== socket) return;
                        accountEncryptionObservation?.connected();
                        if (ingressAccountId) clearMachineRequestReachabilityForScope({ serverId: entry.id, accountId: ingressAccountId });
                        notifyExecutionRunActivityReconnect(entry.id);
                        statusDemandTransport.resend();
                        // This content-free secondary transport has no changes
                        // cursor. Connecting may have missed writes since a reader's
                        // initial snapshot (including before the first connect), so
                        // invalidate this Home's reconstructible Account projections.
                        publishHomeAccountChange(entry.id, undefined, { source: 'connected' });
                        queueRefresh(entry);
                    }),
                    transport.onDisconnected(() => {
                        if (!isManagedServerActive(entry) || entry.socket !== socket) return;
                        if (ingressAccountId) withdrawMachinePresenceForScope({ serverId: entry.id, accountId: ingressAccountId });
                        accountEncryptionObservation?.disconnected();
                    }),
                    transport.onError(() => {
                        if (!isManagedServerActive(entry) || entry.socket !== socket) return;
                        if (ingressAccountId) withdrawMachinePresenceForScope({ serverId: entry.id, accountId: ingressAccountId });
                        accountEncryptionObservation?.disconnected();
                    }),
                    () => statusDemandTransport.dispose(),
                ];
                return transport;
            };
            // Keep initial construction synchronous so the existing cache
            // reconciliation catch can retire a partially constructed entry.
            // start() consumes this transport immediately, before awaiting its dial.
            let initialTransport: ManagedConnectionTransport | null = createTransport();
            entry.socketSupervisor = createSocketConnectionSupervisor({
                createTransport: () => {
                    const transport = initialTransport;
                    initialTransport = null;
                    return transport ?? createTransport();
                },
            });
        }
        fireAndForget(entry.socketSupervisor.start(), { tag: 'concurrentSessionCache.socket' });
    }, credentials.token);

    await acquireManagedServerReachability(entry);
}

async function acquireManagedServerReachability(entry: ManagedConcurrentServer): Promise<void> {
    if (!isManagedServerActive(entry) || !entry.irohLease) return;
    const acquireGeneration = entry.reachabilityAcquireGeneration + 1;
    entry.reachabilityAcquireGeneration = acquireGeneration;
    const lease = await acquireServerReachabilitySupervisor({
        serverUrl: entry.serverUrl,
        token: entry.credentials.token,
        ...(entry.irohLease && normalizeServerUrl(entry.irohLease.runtimeOrigin) !== entry.serverUrl
            ? { runtimeOrigin: entry.irohLease.runtimeOrigin }
            : {}),
        // An ingress-less secondary Home has no URL a platform fetch can probe,
        // so readiness is proven over the same carrier its requests will use.
        homeCarrier: entry.irohLease?.homeCarrier ?? null,
    });

    if (
        !started
        || managedServers.get(entry.id) !== entry
        || entry.reachabilityAcquireGeneration !== acquireGeneration
    ) {
        await lease.release().catch(() => undefined);
        return;
    }

    const previousRelease = entry.reachabilityRelease;
    entry.reachabilityRelease = lease.release;
    await previousRelease?.().catch(() => undefined);
}

async function acquireConcurrentHomeTransport(
    target: ConcurrentTarget,
    credentials: AuthCredentials,
): Promise<ResolvedServerScopedTransport> {
    // Reuse the existing single AppState owner for every native loopback
    // carrier; concurrent Homes do not create a second lifecycle mount.
    if (target.homeConnectionDescriptor?.endpoints.some((endpoint) => endpoint.kind === 'iroh')) {
        startNativeLoopbackTunnelRuntimeAppStateLifecycle();
    }
    return await resolveServerScopedTransport({
        profile: {
            serverUrl: target.serverUrl,
            canonicalServerUrl: target.canonicalServerUrl ?? target.serverUrl,
            homeConnectionDescriptor: target.homeConnectionDescriptor,
        },
        credentials,
    });
}

function resolveDesiredConcurrentTargets(): ConcurrentTarget[] {
    const profiles = listServerProfiles();
    const appliedServerId = getAppliedActiveServerId();
    // Once the focused switch begins, its old singleton has already been
    // retired. The applying Home is the only Home that must stay out of the
    // secondary cache; the former applied Home can now be reconciled there.
    const activeServerId = applyingActiveServerId || appliedServerId;
    const stagedActiveServerId = normalizeServerId(getActiveServerSnapshot().serverId);
    const hasUnappliedStagedTarget = stagedActiveServerId
        && !areServerProfileIdentifiersEquivalent(stagedActiveServerId, appliedServerId);
    const selectionSettings = readConcurrentSelectionSettings();
    return resolveConcurrentTargets({
        activeServerId,
        profiles: profiles.map((profile) => ({
            id: profile.id,
            serverUrl: profile.serverUrl,
            name: profile.name,
            serverIdentityId: profile.serverIdentityId,
            legacyServerIds: profile.legacyServerIds,
            homeConnectionDescriptor: profile.homeConnectionDescriptor,
            canonicalServerUrl: profile.canonicalServerUrl,
        })),
        settings: selectionSettings,
    }).filter((target) => (
        !areServerProfileIdentifiersEquivalent(target.id, applyingActiveServerId)
        && (!hasUnappliedStagedTarget || !areServerProfileIdentifiersEquivalent(target.id, stagedActiveServerId))
    ));
}

async function reconcileConcurrentServers(requestRevision: number): Promise<void> {
    if (!started || requestRevision !== reconcileRequestRevision) return;
    const targets = resolveDesiredConcurrentTargets();

    for (const target of targets) {
        if (!getManagedServer(target.id)) {
            publishConcurrentSessionListTargetObservation({ target, phase: 'loading' });
        }
    }

    const desiredById = new Map(targets.map((target) => [target.id, target]));

    for (const existingId of readConcurrentHomeIds()) {
        if (!desiredById.has(existingId)
            && !targets.some(target => areServerProfileIdentifiersEquivalent(target.id, existingId))) {
            stopManagedServer(existingId);
            clearConcurrentSessionListCache(existingId);
            clearConcurrentMachineListCache(existingId);
        }
    }

    // Each target has independent credential, carrier, reachability, socket and
    // feature owners. Starting them serially lets one slow/offline Home delay
    // every later Home, so reconcile the target-local lifecycles concurrently.
    await Promise.allSettled(targets.map(async (target) => {
        const credentials = await TokenStorage.getCredentialsForServerUrl(target.serverUrl, { serverId: target.id });
        if (!started || requestRevision !== reconcileRequestRevision) {
            return;
        }
        if (!credentials) {
            retireReplacedSessionListAccount(target.id, null);
            updateConcurrentMachineListCache({
                serverId: target.id,
                machines: null,
                status: 'signedOut',
            });
            return;
        }

        retireReplacedSessionListAccount(target.id, readCredentialAccountId(credentials));
        const existing = getManagedServer(target.id);
        if (
            existing
            && existing.serverUrl === target.serverUrl
            && areAuthCredentialsEquivalent(existing.credentials, credentials)
            && existing.irohConfigKey === (target.irohConfigKey ?? null)
            && existing.irohLease !== null
        ) {
            if (existing.serverName !== target.serverName) {
                existing.serverName = target.serverName;
                const cached = storage.getState().concurrentSessionListCacheByServerId?.[existing.id] ?? null;
                if (cached) {
                    updateConcurrentSessionListCache({
                        serverId: existing.id,
                        entry: {
                            ...cached,
                            serverName: target.serverName,
                        },
                    });
                }
            }
            return;
        }

        if (existing) {
            stopManagedServer(target.id);
        }
        const next = createManagedServer(target, credentials, existing);
        let irohLease: ResolvedServerScopedTransport;
        try {
            irohLease = await acquireConcurrentHomeTransport(target, credentials);
        } catch {
            if (!started || requestRevision !== reconcileRequestRevision || !isManagedServerActive(next)) {
                return;
            }
            // Unsafe Iroh verification failures fail this Home closed. Do not
            // create the ordinary HTTPS reachability/socket/refresh bypass.
            // Publish the failure as this Home's own status so consumers can
            // tell an unreachable Home from one that was never selected, and
            // keep its last known rows instead of blanking a hydrated list.
            updateConcurrentMachineListCache({
                serverId: target.id,
                machines: storage.getState().machineListByServerId?.[target.id] ?? null,
                status: 'error',
            });
            publishConcurrentSessionListTargetObservation({ target, phase: 'offline' });
            return;
        }
        if (!started || requestRevision !== reconcileRequestRevision || !isManagedServerActive(next)) {
            await irohLease.release().catch(() => undefined);
            return;
        }
        try {
            await connectManagedServer(next, irohLease);
        } catch {
            // Replace only this failed owner, before asynchronous cleanup. Its
            // Account/frontier remain proven, but none of its partial network
            // resources become the retained corpus's new publisher.
            const retained = isManagedServerActive(next)
                ? createManagedServer(target, credentials, next)
                : null;
            const disposing = disposeManagedServer(next);
            if (retained && isManagedServerActive(retained)) {
                publishConcurrentSessionListTargetObservation({ target, phase: 'offline' });
            }
            await disposing;
            return;
        }
        // Reconcile the complete descriptor through this secondary Home's
        // already-authenticated scoped carrier. Public capability discovery is
        // privacy-reduced and cannot establish a new canonical generation.
        await refreshAuthenticatedServerFeaturesSnapshot({
            credentials,
            force: true,
            serverId: target.id,
            scopedTransport: irohLease,
        });
        if (!started || requestRevision !== reconcileRequestRevision) {
            // The entry was published before feature acquisition so the
            // synchronous reachability owner can initialize it. A newer
            // reconcile may retain this same entry or replace it; stale work
            // therefore has no disposal authority by server id.
            return;
        }
        queueRefresh(next);
    }));
}

function scheduleReconcile(): void {
    if (!started) return;
    reconcileRequestRevision += 1;
    if (reconcileTimer) return;
    reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        void reconcileConcurrentServers(reconcileRequestRevision);
    }, 0);
}

function pauseManagedServersForNetworkDisallowed(): void {
    for (const entry of managedServers.values()) {
        if (entry.refreshTimer) {
            clearTimeout(entry.refreshTimer);
            entry.refreshTimer = null;
        }
        void entry.socketSupervisor?.stop();
    }
}

function resumeManagedServersForNetworkAllowed(): void {
    for (const entry of managedServers.values()) {
        void acquireManagedServerReachability(entry).catch(() => undefined);
        if (entry.reachabilityState.phase === 'online') {
            fireAndForget(entry.socketSupervisor?.start() ?? Promise.resolve(), { tag: 'concurrentSessionCache.socket.resume' });
        }
        queueRefresh(entry);
    }
    scheduleReconcile();
    schedulePushTokenReconciliation();
}

export function startConcurrentSessionCacheSync(): void {
    if (started) return;
    started = true;
    applyingActiveServerId = '';
    startPushTokenReconciliation();
    irohRecoveryUnsubscribe = subscribeIrohHomeTunnelRecoveryRequired((event) => {
        const entry = [...managedServers.values()].find((candidate) => candidate.irohLease?.leaseId === event.leaseId);
        if (!entry) return;
        stopManagedServer(entry.id);
        scheduleReconcile();
    });
    let lastAppliedActiveServerId = normalizeServerId(getAppliedActiveServerId());

    const releaseFocusedSecondaryOwnership = (serverIdRaw: string, clearProjection: boolean) => {
        const serverId = normalizeServerId(serverIdRaw);
        for (const managedServerId of Array.from(managedServers.keys())) {
            if (!areServerProfileIdentifiersEquivalent(managedServerId, serverId)) continue;
            stopManagedServer(managedServerId);
            if (clearProjection) {
                clearConcurrentSessionListCache(managedServerId);
                clearConcurrentMachineListCache(managedServerId);
            }
        }
    };

    let lastConfigKey = '';
    storageUnsubscribe = storage.subscribe((state) => {
        if (loadEffectiveHomeViewState()) return;
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

    applyingActiveServerUnsubscribe = subscribeApplyingActiveServer((nextServerId, _generation = -1) => {
        applyingActiveServerId = normalizeServerId(nextServerId);
        releaseFocusedSecondaryOwnership(nextServerId, false);
        for (const target of resolveDesiredConcurrentTargets()) {
            if (!getManagedServer(target.id)) {
                publishConcurrentSessionListTargetObservation({ target, phase: 'loading' });
            }
        }
        scheduleReconcile();
    });
    activeServerUnsubscribe = subscribeAppliedActiveServer((nextServerIdRaw, _generation = -1) => {
        const previousServerId = lastAppliedActiveServerId;
        const nextServerId = normalizeServerId(nextServerIdRaw);
        applyingActiveServerId = '';
        releaseFocusedSecondaryOwnership(nextServerId, true);
        if (previousServerId) {
            invalidateCachedTransferRoutesForServer({ serverId: previousServerId });
        }
        if (nextServerId && nextServerId !== previousServerId) {
            invalidateCachedTransferRoutesForServer({ serverId: nextServerId });
        }
        lastAppliedActiveServerId = nextServerId;
        scheduleReconcile();
    });

    serverProfilesUnsubscribe = subscribeServerProfiles(() => {
        scheduleReconcile();
        schedulePushTokenReconciliation();
    });
    homeViewStateUnsubscribe = subscribeEffectiveHomeViewState(() => {
        scheduleReconcile();
    });
    homeCredentialMutationsUnsubscribe = subscribeHomeCredentialMutations((event) => {
        // Withdraw a changed Account synchronously before its queued replacement.
        // Same-Account credential rotation keeps the canonical retained-corpus proof.
        const accountId = event.kind === 'credentials_set' && event.credentials
            ? readCredentialAccountId(event.credentials) : null;
        for (const serverId of readConcurrentHomeIds()) {
            if (areServerProfileIdentifiersEquivalent(serverId, event.serverId)) {
                retireReplacedSessionListAccount(serverId, accountId);
            }
        }
        scheduleReconcile();
        schedulePushTokenReconciliation();
    });

    networkAllowedUnsubscribe = subscribeServerReachabilityNetworkAllowed((allowed) => {
        if (allowed) {
            resumeManagedServersForNetworkAllowed();
            return;
        }
        pauseManagedServersForNetworkDisallowed();
    });

    scheduleReconcile();
    schedulePushTokenReconciliation();
}

export function stopConcurrentSessionCacheSync(): void {
    if (!started) return;
    started = false;
    applyingActiveServerId = '';
    stopPushTokenReconciliation();
    reconcileRequestRevision += 1;

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
    if (applyingActiveServerUnsubscribe) {
        applyingActiveServerUnsubscribe();
        applyingActiveServerUnsubscribe = null;
    }
    if (serverProfilesUnsubscribe) {
        serverProfilesUnsubscribe();
        serverProfilesUnsubscribe = null;
    }
    if (homeViewStateUnsubscribe) {
        homeViewStateUnsubscribe();
        homeViewStateUnsubscribe = null;
    }
    if (homeCredentialMutationsUnsubscribe) {
        homeCredentialMutationsUnsubscribe();
        homeCredentialMutationsUnsubscribe = null;
    }
    if (networkAllowedUnsubscribe) {
        networkAllowedUnsubscribe();
        networkAllowedUnsubscribe = null;
    }
    if (irohRecoveryUnsubscribe) {
        irohRecoveryUnsubscribe();
        irohRecoveryUnsubscribe = null;
    }

    for (const serverId of Array.from(managedServers.keys())) {
        stopManagedServer(serverId);
    }
}

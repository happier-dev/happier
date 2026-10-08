import { attachManagedSessionHumanPresenceSocket } from '@/sync/domains/session/humanPresence/attachManagedSessionHumanPresenceSocket';
import { notifyExecutionRunActivityReconnect } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import type { Socket } from 'socket.io-client';
import {
    callSocketRpc,
    createHappierSocket,
    createSocketRpcAbortError,
    emitWithAckCancellable,
    isSocketIoAckTimeoutError,
    markRpcRequestDisposition,
    readRpcRequestDisposition,
    socketRpcCodec,
    type HappierSocketRole,
    type SocketRpcContent,
} from '@happier-dev/sync-client';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { Encryption } from '@/sync/encryption/encryption';
import { observeServerTimestamp } from '@/sync/runtime/time';
import { MACHINE_LIVE_STREAM_SOCKET_EVENT, type MachineLiveStreamRelayEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { TRANSFER_RELAY_V2_SOCKET_EVENT } from '@happier-dev/protocol/transfers/relay/v2/socketEvents';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, buildAccountStoredContentCompatibilitySocketAuthV1 } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import type { TransferRelayV2SendEnvelope } from '@happier-dev/protocol/transfers/relay/v2/transferRelayEnvelopeSchema';
import { uiBrowserAutomationDispatchMethod } from '@happier-dev/protocol/browser/automation/reverseDispatchV1';
import { SOCKET_RPC_EVENTS, SocketRpcCancellationPayloadSchema, SocketRpcRequestIdSchema, type SessionTransferRoutingV1 } from '@happier-dev/protocol/socketRpc';
import {
    RPC_ERROR_CODES,
    RPC_ERROR_MESSAGES,
    RPC_METHODS,
    type SocketRpcAuthorizationContext,
} from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { handleUiBrowserRecordingCaptureFrameRequest } from '@/sync/domains/browser/recording/reverseCaptureHandler';
import {
    createServerFetchAtEndpoint,
    serverFetch,
    type ServerFetch,
    StaleServerGenerationError,
    type ServerFetchOptions,
} from '@/sync/http/client';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    areServerProfileIdentifiersEquivalent,
    getServerProfileById,
    subscribeActiveServerRuntimeOrigin,
} from '@/sync/domains/server/serverProfiles';
import { resolveSocketIoTransportsForCarrier } from '@/sync/runtime/socketIoTransports';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { storage } from '@/sync/domains/state/storage';
import {
    canonicalizeServerUrl,
} from '@/sync/domains/server/url/serverUrlCanonical';
import {
    type ManagedConnectionState,
    createManagedConnectionSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ManagedConnectionSupervisor,
    type ManagedConnectionTransport,
    type TransportDisconnectEvent,
} from '@happier-dev/connection-supervisor';
import {
    invalidateServerReachabilitySupervisor,
    reportServerUnreachable,
    reportServerRestarting,
    startServerReachabilitySupervisor,
    stopServerReachabilitySupervisor,
    subscribeServerReachabilityState,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { createNotAuthenticatedError } from '@/sync/runtime/connectivity/authErrors';
import { registerExternalSessionStatusDemandTransport } from '@/sync/runtime/orchestration/externalSessions/externalSessionStatusDemandCoordinator';
import { isServerRuntimeTransportPublished, resolveActiveServerRuntimeOrigin } from '@/sync/runtime/nativeLoopbackTunnels/runtimeOrigin';
import { getActiveServerHomeCarrier } from '@/sync/domains/server/serverRuntime';
import { ServerScopedTransportUnavailableError } from '@/sync/runtime/homeCarrier';
import { fetchAccountEncryptionCurrentness, getAccountEncryptionModeCacheRevision } from '@/sync/api/account/apiAccountEncryptionMode';
import { MachineLiveStreamPayloadErrorV1, type MachineLiveStreamContentV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';
import { createMachineLiveStreamSocketTransport } from '@/sync/domains/machines/peer/mediation/stream/socketTransport';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';

const STATIC_EXPO_PUBLIC_HAPPIER_SOCKET_ACK_AUTH_SETTLE_TIMEOUT_MS =
    process.env.EXPO_PUBLIC_HAPPIER_SOCKET_ACK_AUTH_SETTLE_TIMEOUT_MS;

function readSocketAckAuthSettleTimeoutMs(): number {
    const raw = String(STATIC_EXPO_PUBLIC_HAPPIER_SOCKET_ACK_AUTH_SETTLE_TIMEOUT_MS ?? '').trim();
    if (!raw) return 250;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 250;
    return Math.max(0, Math.min(5_000, parsed));
}

function readPlannedRestartRetryAfterMs(payload: unknown): number | undefined {
    if (typeof payload !== 'object' || payload === null) {
        return undefined;
    }
    const raw = (payload as { retryAfterMs?: unknown }).retryAfterMs;
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function readSessionEncryptionModeFromLocalState(sessionId: string): 'plain' | 'e2ee' | null {
    const sid = String(sessionId ?? '').trim();
    if (!sid) return null;
    try {
        const row = storage.getState().sessions[sid] ?? null;
        if (!row || typeof row !== 'object') return null;
        if (row.encryptionMode === 'plain') return 'plain';
        if (row.encryptionMode === 'e2ee') return 'e2ee';
        return null;
    } catch {
        return null;
    }
}

function readMachineStorageModeFromLocalState(machineId: string): 'plain' | 'e2ee' | null {
    const normalizedMachineId = String(machineId ?? '').trim();
    if (!normalizedMachineId) return null;
    try {
        const row = storage.getState().machines[normalizedMachineId] ?? null;
        if (row?.storageMode === 'plain') return 'plain';
        if (row?.storageMode === 'e2ee') return 'e2ee';
        return null;
    } catch {
        return null;
    }
}

const GLOBAL_IN_FLIGHT_HTTP_REQUESTS_KEY = '__HAPPIER_GLOBAL_IN_FLIGHT_HTTP_REQUESTS_BY_KEY__';
const GLOBAL_TOKEN_CACHE_KEY_BY_TOKEN_KEY = '__HAPPIER_GLOBAL_TOKEN_CACHE_KEY_BY_TOKEN__';
const GLOBAL_TOKEN_CACHE_KEY_MAX_ENTRIES = 512;

type RecoveredHttpRequestConfiguration = Readonly<{
    rejectedToken: string;
    recoveredToken: string;
    isCurrent: () => boolean;
}>;

type InFlightHttpRequestResult = Readonly<{
    response: Response;
    recovery?: RecoveredHttpRequestConfiguration;
}>;

function getInFlightHttpRequestsHost(): Record<string, unknown> {
    // Vitest module isolation can evaluate the same module graph under separate `globalThis` realms.
    // When available, prefer `process` as a stable cross-realm anchor so we still de-dupe in-flight
    // HTTP requests across module instances.
    const g = globalThis as unknown as Record<string, unknown>;
    // Prefer the Node global `process` symbol when present; `globalThis.process` may be a realm-local
    // shim/proxy under certain test runners.
    const p = typeof process !== 'undefined' ? (process as unknown) : null;
    if (p && typeof p === 'object') return p as Record<string, unknown>;

    const gp = g.process;
    if (gp && typeof gp === 'object') return gp as Record<string, unknown>;

    return g;
}

function getGlobalTokenCacheKeyByToken(): Map<string, string> {
    const host = getInFlightHttpRequestsHost();
    const existing = host[GLOBAL_TOKEN_CACHE_KEY_BY_TOKEN_KEY];
    // Cross-realm: `instanceof Map` can fail when the Map was created in a different JS realm.
    if (existing && Object.prototype.toString.call(existing) === '[object Map]') {
        return existing as Map<string, string>;
    }
    const created = new Map<string, string>();
    host[GLOBAL_TOKEN_CACHE_KEY_BY_TOKEN_KEY] = created;
    return created;
}

function getOrCreateTokenCacheKey(token: string): string {
    // Avoid using the raw token in cache keys (accidental leaks in error/debug output).
    const tokenCacheKeyByToken = getGlobalTokenCacheKeyByToken();
    let key = tokenCacheKeyByToken.get(token);
    if (key) {
        // Refresh LRU ordering.
        tokenCacheKeyByToken.delete(token);
        tokenCacheKeyByToken.set(token, key);
        return key;
    }

    const cryptoAny = (globalThis as any).crypto as { randomUUID?: () => string } | undefined;
    key =
        typeof cryptoAny?.randomUUID === 'function'
            ? cryptoAny.randomUUID()
            : `tk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    tokenCacheKeyByToken.set(token, key);

    while (tokenCacheKeyByToken.size > GLOBAL_TOKEN_CACHE_KEY_MAX_ENTRIES) {
        const oldest = tokenCacheKeyByToken.keys().next();
        if (oldest.done) break;
        tokenCacheKeyByToken.delete(oldest.value);
    }

    return key;
}

function getGlobalInFlightHttpRequestsByKey(): Map<string, Promise<InFlightHttpRequestResult>> {
    const host = getInFlightHttpRequestsHost();
    const existing = host[GLOBAL_IN_FLIGHT_HTTP_REQUESTS_KEY];
    // Cross-realm: `instanceof Map` can fail when the Map was created in a different JS realm.
    if (existing && Object.prototype.toString.call(existing) === '[object Map]') {
        return existing as Map<string, Promise<InFlightHttpRequestResult>>;
    }
    const created = new Map<string, Promise<InFlightHttpRequestResult>>();
    host[GLOBAL_IN_FLIGHT_HTTP_REQUESTS_KEY] = created;
    return created;
}

//
// Types
//

export interface SyncSocketConfig {
    endpoint: string;
    token: string;
    socketRole?: HappierSocketRole;
    /** An admitted frame authority has no stored credential or endpoint supervisor. */
    request?: ServerFetch;
    isCurrent?: () => boolean;
    onCredentialRejected?: () => void;
    serverId?: string;
    generation?: number;
    runtimeOrigin?: string;
    carrier?: 'https' | 'iroh';
    homeCarrier?: import('@/sync/runtime/homeCarrier').HomeCarrier | null;
}

/**
 * A direct HTTP consumer may retain this identity across an asynchronous
 * capability decision. It can issue only while the singleton still has the
 * same immutable prepared socket configuration.
 */
type PreparedSocketRequestTarget = Readonly<
    Pick<SyncSocketConfig, 'endpoint' | 'runtimeOrigin' | 'carrier' | 'homeCarrier'>
    & { serverId: string; generation: number }
>;

export interface SyncSocketState {
    isConnected: boolean;
    connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    lastError: Error | null;
}

export type SyncSocketListener = (state: SyncSocketState) => void;

/** Immutable origin of an inbound event from one concrete socket installation. */
export type SyncSocketMessageContext = Readonly<{
    serverId: string | null;
}>;

type SyncSocketMessageHandler = (data: any, context: SyncSocketMessageContext) => void;

/**
 * Inbound machine-scoped reverse-RPC handler. Receives the already-decrypted request params and
 * returns the response payload that this socket will re-encrypt (machine-scoped e2ee) for the ack.
 */
export type InboundMachineRpcHandler = (params: unknown, context?: Readonly<{ signal: AbortSignal }>) => Promise<unknown> | unknown;

//
// Main Class
//

class ApiSocket {

    // State
    private socket: Socket | null = null;
    private socketClientType: HappierSocketRole['clientType'] | null = null;
    private socketTransportKey: string | null = null;
    private config: SyncSocketConfig | null = null;
    private requestConfigurationAbortController = new AbortController();
    private encryption: Encryption | null = null;
    private liveStreamTransport: ReturnType<typeof createMachineLiveStreamSocketTransport> | null = null;
    private messageHandlers: Map<string, Set<SyncSocketMessageHandler>> = new Map();
    private reconnectedListeners: Set<() => void> = new Set();
    private statusListeners: Set<(status: 'disconnected' | 'connecting' | 'connected' | 'error') => void> = new Set();
    private connectionStateListeners: Set<(state: ManagedConnectionState) => void> = new Set();
    private errorListeners: Set<(error: Error | null) => void> = new Set();
    private currentStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
    private currentConnectionState: ManagedConnectionState = {
        phase: 'idle',
        reason: null,
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastErrorMessage: null,
    };
    private inFlightHttpRequestsByKey: Map<string, Promise<InFlightHttpRequestResult>> = getGlobalInFlightHttpRequestsByKey();
    private hasConnectedOnce = false;
    private pendingReconnectNotification = false;
    private reachabilityUnsubscribe: (() => void) | null = null;
    private reachabilityServerUrl: string | null = null;
    private reachabilityToken: string | null = null;
    private runtimeOriginUnsubscribe: (() => void) | null = null;
    private socketTransport: ManagedConnectionTransport | null = null;
    private scopedConnectionSupervisor: ManagedConnectionSupervisor | null = null;
    private detachSocketTransportListeners: Array<() => void> = [];
    // Inbound machine-scoped reverse-RPC handlers, keyed by the FULL prefixed method
    // (`<machineId>:<method>`). The daemon for `<machineId>` calls this method over its machine
    // socket; the server forwards it to whichever client joined the matching rpc room. Registering
    // here makes THIS user-scoped socket that client (room membership via `rpc-register`).
    private inboundMachineRpcHandlers: Map<string, InboundMachineRpcHandler> = new Map();
    private activeInboundMachineRpcRequests = new Map<AbortController, Readonly<{ socket: Socket; method: string; requestId?: string }>>();

    //
    // Initialization
    //

    initialize(config: SyncSocketConfig, encryption: Encryption | null) {
        if (this.config?.request || config.request) this.disconnect();
        this.requestConfigurationAbortController.abort('socket-reconfigured');
        this.requestConfigurationAbortController = new AbortController();
        this.config = config;
        this.encryption = encryption;
        this.connect();
    }

    //
    // Connection Management
    //

    connect() {
        if (!this.config) {
            return;
        }
        if (this.config.request) {
            const config = this.config;
            if (config.isCurrent?.() === false) return;
            if (!this.scopedConnectionSupervisor) {
                this.scopedConnectionSupervisor = createManagedConnectionSupervisor({
                    ...DEFAULT_MANAGED_CONNECTION_POLICY,
                    createTransport: () => { this.ensureSocketTransport(true); return this.socketTransport!; },
                    probeReadiness: async () => {
                        if (this.config !== config || config.isCurrent?.() === false) return { status: 'auth_failed' };
                        try {
                            const response = await config.request!('/v2/cursor');
                            if (response.status === 401) return { status: 'auth_failed', statusCode: 401 };
                            return response.ok ? { status: 'ready' } : { status: 'server_unreachable' };
                        } catch (error) {
                            return { status: 'server_unreachable', errorMessage: error instanceof Error ? error.message : String(error) };
                        }
                    },
                    classifyTransportErrorToProbeResult: (error) => {
                        // The canonical server Socket.IO rejection carries this structured data.
                        if (!error || typeof error !== 'object' || !('data' in error)) return null;
                        const data = error.data;
                        if (!data || typeof data !== 'object' || !('statusCode' in data) || data.statusCode !== 401) return null;
                        return { status: 'auth_failed', statusCode: 401 };
                    },
                    onAuthFailed: () => { if (this.config === config && config.isCurrent?.() !== false) config.onCredentialRejected?.(); },
                    onStateChange: (state) => { if (this.config === config) this.applyManagedConnectionState(state); },
                });
            }
            void this.scopedConnectionSupervisor.start().catch((error: unknown) => {
                if (this.config !== config || config.isCurrent?.() === false) return;
                this.setError(error instanceof Error ? error : new Error(String(error)));
                this.updateStatus('error');
            });
            return;
        }
        const endpoint = this.config.endpoint;
        const token = this.config.token;
        const snapshot = getActiveServerSnapshot();
        const serverUrl = canonicalizeServerUrl(endpoint) || endpoint;
        const hasCapturedServerTarget = Boolean(
            this.config.serverId && this.config.generation !== undefined,
        );
        const focusedProfile = getServerProfileById(this.config.serverId ?? snapshot.serverId);
        if (
            focusedProfile?.homeConnectionDescriptor
            && (!this.config.serverId || this.config.serverId === snapshot.serverId)
            && (this.config.generation === undefined || this.config.generation === snapshot.generation)
            && canonicalizeServerUrl(endpoint) === canonicalizeServerUrl(snapshot.serverUrl)
        ) {
            // A disconnected socket is not subscribed to publication changes.
            // Resume from the current owner, never its previously captured lease.
            this.config.carrier = snapshot.carrier;
            this.config.runtimeOrigin = snapshot.runtimeOrigin;
            this.config.homeCarrier = getActiveServerHomeCarrier();
        }
        // `carrier` is set by — and only by — a completed transport publication,
        // whether that published a runtime origin or a semantic carrier that has
        // none. Waiting on `runtimeOrigin` alone would strand a browser Home
        // whose verified carrier is exactly the thing without an origin.
        const carrier = this.config.carrier ?? (hasCapturedServerTarget ? undefined : snapshot.carrier);
        const awaitsVerifiedHomeCarrier = !isServerRuntimeTransportPublished({
            serverId: this.config.serverId ?? snapshot.serverId, carrier,
        });
        const runtimeOrigin = this.config.runtimeOrigin
            || (hasCapturedServerTarget || awaitsVerifiedHomeCarrier ? null : resolveActiveServerRuntimeOrigin(snapshot))
            || serverUrl;

        if (
            this.reachabilityUnsubscribe
            && this.reachabilityServerUrl
            && (this.reachabilityServerUrl !== serverUrl || this.reachabilityToken !== token)
        ) {
            const previousServerUrl = this.reachabilityServerUrl;
            const previousToken = this.reachabilityToken;
            this.reachabilityUnsubscribe();
            this.reachabilityUnsubscribe = null;
            this.reachabilityServerUrl = null;
            this.reachabilityToken = null;
            void stopServerReachabilitySupervisor(previousServerUrl, previousToken);
        }

        if (!this.reachabilityUnsubscribe) {
            this.reachabilityServerUrl = serverUrl;
            this.reachabilityToken = token;
            this.reachabilityUnsubscribe = subscribeServerReachabilityState(serverUrl, (state) => {
                this.applyManagedConnectionState(state);
                this.handleReachabilityStateChange(state);
            }, token);
        }

        if (!this.runtimeOriginUnsubscribe) {
            this.runtimeOriginUnsubscribe = subscribeActiveServerRuntimeOrigin((nextSnapshot) => {
                if (
                    !this.config
                    || (this.config.serverId && this.config.serverId !== nextSnapshot.serverId)
                    || (this.config.generation !== undefined && this.config.generation !== nextSnapshot.generation)
                    || canonicalizeServerUrl(this.config.endpoint) !== canonicalizeServerUrl(nextSnapshot.serverUrl)
                ) return;
                this.config.carrier = nextSnapshot.carrier;
                this.config.homeCarrier = getActiveServerHomeCarrier();
                if (!isServerRuntimeTransportPublished(nextSnapshot)) {
                    this.config.runtimeOrigin = undefined;
                    // Unpublication is not authority to select canonical HTTPS.
                    // The existing connection owner will publish its next policy
                    // decision; meanwhile stop readiness and its socket traffic.
                    void stopServerReachabilitySupervisor(this.config.endpoint, this.config.token);
                    return;
                }
                const nextRuntimeOrigin = resolveActiveServerRuntimeOrigin(nextSnapshot) || this.config.endpoint;
                this.config.runtimeOrigin = nextRuntimeOrigin;
                void startServerReachabilitySupervisor({
                    serverUrl: this.config.endpoint,
                    token: this.config.token,
                    ...(canonicalizeServerUrl(nextRuntimeOrigin) === canonicalizeServerUrl(this.config.endpoint)
                        ? {}
                        : { runtimeOrigin: nextRuntimeOrigin }),
                    homeCarrier: this.config.homeCarrier,
                }).then(() => {
                    if (this.currentConnectionState.phase === 'online') this.handleReachabilityStateChange(this.currentConnectionState);
                });
            });
        }

        if (awaitsVerifiedHomeCarrier) return;

        void startServerReachabilitySupervisor({
            serverUrl,
            token,
            ...(canonicalizeServerUrl(runtimeOrigin) === canonicalizeServerUrl(serverUrl) ? {} : { runtimeOrigin }),
            homeCarrier: 'homeCarrier' in this.config
                ? this.config.homeCarrier ?? null
                : getActiveServerHomeCarrier(),
        });
    }

    disconnect() {
        const scopedSupervisor = this.scopedConnectionSupervisor;
        this.scopedConnectionSupervisor = null;
        void scopedSupervisor?.stop();
        this.requestConfigurationAbortController.abort('socket-disconnected');
        const previousServerUrl = this.reachabilityServerUrl;
        const previousToken = this.reachabilityToken;
        this.reachabilityUnsubscribe?.();
        this.runtimeOriginUnsubscribe?.();
        this.runtimeOriginUnsubscribe = null;
        this.reachabilityUnsubscribe = null;
        this.reachabilityServerUrl = null;
        this.reachabilityToken = null;
        if (previousServerUrl) {
            void stopServerReachabilitySupervisor(previousServerUrl, previousToken);
        }
        // Intentional disconnects (app backgrounding, server switch, logout) must not be treated as a "reconnect".
        // Reset these flags so the next successful connect becomes a new baseline (no onReconnected callback).
        this.hasConnectedOnce = false;
        this.pendingReconnectNotification = false;
        for (const detach of this.detachSocketTransportListeners.splice(0)) {
            detach();
        }
        const transport = this.socketTransport;
        this.socketTransport = null;
        this.socketTransportKey = null;
        void transport?.disconnect({ intentional: true });
        void transport?.destroy();
        this.socket = null;
        this.socketClientType = null;
        // Unsubscribing above means the supervisor's own teardown state can no longer reach our listeners, so the
        // last state we published would stay `online` for the whole background window. Consumers would then read
        // "endpoint online, socket down" on resume and surface it as a server outage. A diagnosed problem
        // (offline / auth_failed) is left untouched: an intentional teardown must not erase it either.
        if (this.currentConnectionState.phase === 'online' || this.currentConnectionState.phase === 'connecting') {
            this.applyManagedConnectionState({
                ...this.currentConnectionState,
                phase: 'shutting_down',
                lastDisconnectedAt: Date.now(),
            });
        }
        this.updateStatus('disconnected');
    }

    /** Cancel direct HTTP that belongs to a retired socket configuration. */
    invalidateRequests(reason: string = 'server-switch'): void {
        this.requestConfigurationAbortController.abort(reason);
    }

    /** Release the frame bearer and cipher; ordinary Account disconnects retain their configuration. */
    disposeScopedAuthority(): void {
        if (!this.config?.request) return;
        this.disconnect();
        this.config = null;
        this.encryption = null;
    }

    getSessionScopedTarget(): string | null {
        return this.config?.request && this.config.socketRole?.clientType === 'session-scoped'
            ? this.config.socketRole.sessionId : null;
    }

    //
    // Listener Management
    //

    onReconnected = (listener: () => void) => {
        this.reconnectedListeners.add(listener);
        return () => this.reconnectedListeners.delete(listener);
    };

    onStatusChange = (listener: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void) => {
        this.statusListeners.add(listener);
        // Immediately notify with current status
        listener(this.currentStatus);
        return () => this.statusListeners.delete(listener);
    };

    onConnectionStateChange = (listener: (state: ManagedConnectionState) => void) => {
        this.connectionStateListeners.add(listener);
        listener(this.currentConnectionState);
        return () => this.connectionStateListeners.delete(listener);
    };

    onError = (listener: (error: Error | null) => void) => {
        this.errorListeners.add(listener);
        return () => this.errorListeners.delete(listener);
    };

    //
    // Message Handling
    //

    onMessage(event: string, handler: SyncSocketMessageHandler) {
        const handlers = this.messageHandlers.get(event) ?? new Set<SyncSocketMessageHandler>();
        handlers.add(handler);
        this.messageHandlers.set(event, handlers);
        return () => this.offMessage(event, handler);
    }

    offMessage(event: string, handler: SyncSocketMessageHandler) {
        const handlers = this.messageHandlers.get(event);
        if (!handlers) {
            return;
        }
        handlers.delete(handler);
        if (handlers.size === 0) {
            this.messageHandlers.delete(event);
        }
    }

    onTransferRelayV2Envelope(handler: (payload: TransferRelayV2SendEnvelope) => void) {
        return this.onMessage(TRANSFER_RELAY_V2_SOCKET_EVENT, handler);
    }

    sendTransferRelayV2Envelope(payload: TransferRelayV2SendEnvelope) {
        this.send(TRANSFER_RELAY_V2_SOCKET_EVENT, payload);
    }

    onMachineLiveStreamRelayEnvelope(handler: (payload: MachineLiveStreamRelayEnvelopeV1) => void) {
        return this.onMessage(MACHINE_LIVE_STREAM_SOCKET_EVENT, handler);
    }

    sendMachineLiveStreamRelayEnvelope(payload: MachineLiveStreamRelayEnvelopeV1) {
        if (this.config?.isCurrent?.() === false) throw new StaleServerGenerationError();
        if (!this.liveStreamTransport) throw new MachineLiveStreamPayloadErrorV1('stream_transport_unavailable');
        this.liveStreamTransport.send(payload);
    }

    /**
     * RPC call for sessions - uses session-specific encryption
     */
    async sessionRPC<R, A>(
        sessionId: string,
        method: string,
        params: A,
        options?: { timeoutMs?: number | null; onIssued?: () => void; signal?: AbortSignal; transferRouting?: SessionTransferRoutingV1 },
    ): Promise<R> {
        try {
            if (options?.signal?.aborted) throw createSocketRpcAbortError();
            const scopedTarget = this.getSessionScopedTarget();
            if (scopedTarget && sessionId !== scopedTarget) throw new StaleServerGenerationError();
            const sessionEncryptionMode = readSessionEncryptionModeFromLocalState(sessionId);
            const usePlaintextParams = sessionEncryptionMode === 'plain';
            const sessionEncryption = usePlaintextParams ? null : this.encryption?.getSessionEncryption(sessionId);
            if (!usePlaintextParams && !sessionEncryption) throw new Error(`Session encryption not found for ${sessionId}`);
            return await callSocketRpc<R>({
                socket: this.requireRpcSocket(),
                randomBytes: getRandomBytes,
                target: { kind: 'session', id: sessionId },
                method,
                params,
                content: usePlaintextParams
                    ? { mode: 'plain' }
                    : { mode: 'e2ee', cipher: sessionEncryption! },
                ...options,
            });
        } catch (error) {
            throw await this.coerceAckTimeoutAuthError(error);
        }
    }

    /**
     * RPC call for machines using the Machine's persisted content mode.
     */
    async machineRPC<R, A>(
        machineId: string,
        method: string,
        params: A,
        options?: {
            timeoutMs?: number | null;
            authorization?: SocketRpcAuthorizationContext;
            onIssued?: () => void;
            signal?: AbortSignal;
        },
    ): Promise<R> {
        try {
            if (options?.signal?.aborted) throw createSocketRpcAbortError();
            if (this.getSessionScopedTarget()) throw new Error('Machine RPC is unavailable to a Session-scoped viewer');
            const usePlaintextParams =
                readMachineStorageModeFromLocalState(machineId) === 'plain';
            const machineEncryption = usePlaintextParams
                ? null
                : this.encryption?.getMachineEncryption(machineId) ?? null;
            if (!usePlaintextParams && !machineEncryption) {
                throw new Error(`Machine encryption not found for ${machineId}`);
            }
            return await callSocketRpc<R>({
                socket: this.requireRpcSocket(),
                randomBytes: getRandomBytes,
                target: { kind: 'machine', id: machineId },
                method,
                params,
                content: usePlaintextParams
                    ? { mode: 'plain' }
                    : { mode: 'e2ee', cipher: machineEncryption! },
                ...options,
            });
        } catch (error) {
            throw await this.coerceAckTimeoutAuthError(error);
        }
    }

    send(event: string, data: any) {
        if (event === MACHINE_LIVE_STREAM_SOCKET_EVENT) {
            this.sendMachineLiveStreamRelayEnvelope(data);
            return true;
        }
        if (this.config?.isCurrent?.() === false) throw new StaleServerGenerationError();
        this.socket!.emit(event, data);
        return true;
    }

    /**
     * The current socket.io connection id, or '' when not connected. Used to target per-tab
     * live-stream relay delivery (`io.to(socketId)`) so a viewer's frames reach exactly this tab
     * (C4). It changes across reconnects, so callers must read it at relay-open time.
     */
    getSocketId(): string {
        return this.socket?.id ?? '';
    }

    /**
     * Register an inbound machine-scoped reverse-RPC handler (daemon -> server -> this UI).
     *
     * The daemon for `machineId` invokes `<machineId>:<method>` over its persistent machine socket;
     * the server forwards it to whichever client joined the matching rpc room. By emitting
     * `rpc-register` for the prefixed method this user-scoped socket joins that room and answers the
     * resulting `rpc-request` events from {@link handleInboundMachineRpcRequest}. Registration is
     * reconnect-safe: every (re)connect re-emits `rpc-register` for all installed handlers.
     *
     * Machine-scoped e2ee + fail-closed: request params are decrypted, and the ack re-encrypted, with
     * the per-machine key; a missing key, missing handler, or decrypt failure yields a fail-closed
     * error the calling daemon treats as "no UI reachable".
     *
     * @returns a disposer that unregisters the handler (leaving the rpc room when connected).
     */
    registerMachineScopedRpcHandler(
        machineId: string,
        method: string,
        handler: InboundMachineRpcHandler,
    ): () => void {
        const prefixedMethod = `${machineId}:${method}`;
        if (this.inboundMachineRpcHandlers.has(prefixedMethod)) {
            for (const [controller, request] of this.activeInboundMachineRpcRequests) {
                if (request.method === prefixedMethod) controller.abort('rpc-handler-replaced');
            }
        }
        this.inboundMachineRpcHandlers.set(prefixedMethod, handler);
        if (this.socketClientType === 'user-scoped') {
            this.socket?.emit(SOCKET_RPC_EVENTS.REGISTER, { method: prefixedMethod });
        }
        return () => {
            if (this.inboundMachineRpcHandlers.get(prefixedMethod) === handler) {
                this.inboundMachineRpcHandlers.delete(prefixedMethod);
                for (const [controller, request] of this.activeInboundMachineRpcRequests) {
                    if (request.method === prefixedMethod) controller.abort('rpc-handler-retired');
                }
                if (this.socketClientType === 'user-scoped') {
                    this.socket?.emit(SOCKET_RPC_EVENTS.UNREGISTER, { method: prefixedMethod });
                }
            }
        };
    }

    /**
     * Desktop reverse browser-recording capture (W2C-BA-1 / RU2 G1). Binds the already-built UI
     * capture handler to the machine-scoped `ui.browser.recording.captureFrame` reverse method so the
     * spawned cli daemon (a SEPARATE OS process that cannot `invokeDesktopHost` the desktop Wry WebView)
     * can ask THIS desktop UI to capture one reference-only frame from the view it owns. Without this
     * registration the reverse channel fails closed (`browser_recording_capture_adapter_missing`).
     *
     * Reference-only + fail-closed end to end (BRW-15): only a local file path + metadata cross back.
     *
     * @returns a disposer that unregisters the reverse-capture handler.
     */
    installBrowserRecordingReverseCapture(machineId: string): () => void {
        return this.registerMachineScopedRpcHandler(
            machineId,
            RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME,
            (params) => handleUiBrowserRecordingCaptureFrameRequest(params),
        );
    }

    installBrowserAutomationReverseDispatch(
        machineId: string,
        view: Readonly<{ browserSessionId: string; viewId: string; sessionId: string }>,
    ): () => void {
        return this.registerMachineScopedRpcHandler(machineId, uiBrowserAutomationDispatchMethod(view), async (params, context) => {
            const { handleUiBrowserAutomationDispatchRequest } = await import('@/sync/domains/browser/automation/reverseDispatchHandler');
            return handleUiBrowserAutomationDispatchRequest(params, view, context);
        });
    }

    async emitWithAck<T = any>(
        event: string,
        data: any,
        opts?: {
            timeoutMs?: number | null;
            onIssued?: () => void;
            signal?: AbortSignal;
            cancelRequestId?: string;
        },
    ): Promise<T> {
        try {
            return await emitWithAckCancellable<T>({
                socket: this.requireRpcSocket(),
                event,
                payload: data,
                timeoutMs: opts?.timeoutMs,
                onIssued: opts?.onIssued,
                signal: opts?.signal,
                requestId: opts?.cancelRequestId,
            });
        } catch (error) {
            throw await this.coerceAckTimeoutAuthError(error);
        }
    }

    private requireRpcSocket(): Socket {
        if (this.config?.isCurrent?.() === false) throw new StaleServerGenerationError();
        if (this.currentConnectionState.phase === 'auth_failed') {
            throw createNotAuthenticatedError();
        }
        const socket = this.socket;
        if (!socket || socket.connected === false) {
            throw new Error('Socket not connected');
        }
        return socket;
    }

    //
    // HTTP Requests
    //

    /**
     * Bind a direct request to one prepared socket configuration. This is the
     * sole direct-HTTP owner: callers may retain the returned request while
     * awaiting feature decisions, but cannot re-target it to a later socket
     * configuration.
     */
    createRequestForPreparedTarget(target: PreparedSocketRequestTarget): ServerFetch {
        return async (path, options, requestOptions) => {
            if (!this.isPreparedRequestTargetCurrent(target)) {
                throw new StaleServerGenerationError();
            }
            return await this.request(path, options, requestOptions);
        };
    }

    private isPreparedRequestTargetCurrent(target: PreparedSocketRequestTarget): boolean {
        const config = this.config;
        return Boolean(
            config
            && config.endpoint === target.endpoint
            && config.serverId === target.serverId
            && config.generation === target.generation
            && config.runtimeOrigin === target.runtimeOrigin
            && config.carrier === target.carrier
            && (config.homeCarrier ?? null) === (target.homeCarrier ?? null),
        );
    }

    async request(path: string, options?: RequestInit, requestOptions: ServerFetchOptions = {}): Promise<Response> {
        if (!this.config) {
            throw new Error('SyncSocket not initialized');
        }
        const config = this.config;
        if (config.request) {
            if (config.isCurrent?.() === false) throw new StaleServerGenerationError();
            const response = await config.request(path, options, requestOptions);
            if (this.config !== config || config.isCurrent?.() === false) throw new StaleServerGenerationError();
            return response;
        }
        const snapshot = getActiveServerSnapshot();
        const hasPreparedTarget = Boolean(
            config.serverId
            && config.generation !== undefined,
        );
        const endpoint = config.endpoint;
        const serverId = config.serverId ?? snapshot.serverId;
        const generation = config.generation ?? snapshot.generation;
        const url = `${endpoint}${path}`;
        const method = String(options?.method ?? 'GET').toUpperCase();
        let credentialsToken: string;
        let issueRequest: () => Promise<InFlightHttpRequestResult>;
        let isCurrent: () => boolean;
        let acceptsRecoveredConfiguration: ((recovery: RecoveredHttpRequestConfiguration) => boolean) | null = null;
        let acceptsRejectedConfiguration: (() => boolean) | null = null;
        let unsubscribeCredentialChanges: (() => void) | null = null;

        try {
            if (hasPreparedTarget) {
                const capturedServerId = config.serverId!;
                const capturedGeneration = config.generation!;
                const capturedToken = config.token;
                const capturedRuntimeOrigin = config.runtimeOrigin;
                const capturedCarrier = config.carrier;
                const capturedHomeCarrier = config.homeCarrier ?? null;
                const requestConfigurationAbortController = this.requestConfigurationAbortController;
                let recoveredToken: string | null = null;
                const isPreparedConfigOwned = () => (
                    this.config === config
                    && this.config.endpoint === endpoint
                    && this.config.serverId === capturedServerId
                    && this.config.generation === capturedGeneration
                    && this.config.token === capturedToken
                    && this.config.runtimeOrigin === capturedRuntimeOrigin
                    && this.config.carrier === capturedCarrier
                    && (this.config.homeCarrier ?? null) === capturedHomeCarrier
                    && this.requestConfigurationAbortController === requestConfigurationAbortController
                );
                const isPreparedConfigCurrent = () => (
                    isPreparedConfigOwned()
                    && !requestConfigurationAbortController.signal.aborted
                );
                let ownRejectedCredentialRemoved = false;
                let credentialReplaced = false;
                if (method !== 'GET' && method !== 'HEAD') {
                    unsubscribeCredentialChanges = subscribeHomeCredentialChange((event) => {
                        if (event.kind === 'credentials_set'
                            && areServerProfileIdentifiersEquivalent(event.serverId, capturedServerId)) {
                            credentialReplaced = true;
                        }
                    });
                    acceptsRejectedConfiguration = () => (
                        ownRejectedCredentialRemoved
                        && !credentialReplaced
                        && isPreparedConfigOwned()
                        && requestConfigurationAbortController.signal.aborted
                        && requestConfigurationAbortController.signal.reason === 'credentials-changed'
                    );
                }
                acceptsRecoveredConfiguration = (recovery) => (
                    recovery.rejectedToken === capturedToken
                    && this.config === config
                    && this.config.endpoint === endpoint
                    && this.config.serverId === capturedServerId
                    && this.config.generation === capturedGeneration
                    && this.config.runtimeOrigin === capturedRuntimeOrigin
                    && this.config.carrier === capturedCarrier
                    && (this.config.homeCarrier ?? null) === capturedHomeCarrier
                    && this.config.token === recovery.recoveredToken
                    && recovery.isCurrent()
                );
                if (capturedCarrier === 'iroh' && !capturedRuntimeOrigin && !capturedHomeCarrier) {
                    throw new ServerScopedTransportUnavailableError();
                }
                // The socket configuration remains the bearer authority, but a
                // target-scoped credential lookup is still an asynchronous
                // lifecycle boundary. A credential change may synchronously
                // reconfigure the socket while that lookup is in progress; fence
                // before any request can issue with the captured configuration.
                await TokenStorage.getCredentialsForServerUrl(endpoint, {
                    serverId: capturedServerId,
                });
                if (!isPreparedConfigCurrent()) {
                    throw new StaleServerGenerationError();
                }
                const requestAtPreparedTarget = createServerFetchAtEndpoint({
                    endpointUrl: endpoint,
                    ...(capturedRuntimeOrigin ? { runtimeOrigin: capturedRuntimeOrigin } : {}),
                    ...(capturedHomeCarrier ? { homeCarrier: capturedHomeCarrier } : {}),
                    credentials: { token: capturedToken },
                    serverId: capturedServerId,
                    signal: requestConfigurationAbortController.signal,
                    superviseReachability: true,
                    recoverStoredCredentials: true,
                    isCurrent: isPreparedConfigCurrent,
                    ...(acceptsRejectedConfiguration ? {
                        onRejectedStoredCredentials: (rejectedToken: string) => {
                            ownRejectedCredentialRemoved = rejectedToken === capturedToken;
                        },
                    } : {}),
                    onRecoveredCredentials: (credentials) => {
                        if (!isPreparedConfigCurrent()) return false;
                        recoveredToken = credentials.token;
                        return true;
                    },
                });
                isCurrent = isPreparedConfigCurrent;
                if (!isCurrent()) {
                    throw new StaleServerGenerationError();
                }
                credentialsToken = capturedToken;
                issueRequest = async () => {
                    try {
                        const response = await requestAtPreparedTarget(path, options, requestOptions);
                        let recovery: RecoveredHttpRequestConfiguration | undefined;
                        if (recoveredToken && recoveredToken !== capturedToken) {
                            if (!isPreparedConfigCurrent()) throw new StaleServerGenerationError();
                            const isRecoveredConfigurationCurrent = this.adoptRecoveredHttpToken({
                                config,
                                rejectedToken: capturedToken,
                                recoveredToken,
                            });
                            if (!isRecoveredConfigurationCurrent) throw new StaleServerGenerationError();
                            recovery = {
                                rejectedToken: capturedToken,
                                recoveredToken,
                                isCurrent: isRecoveredConfigurationCurrent,
                            };
                        }
                        return { response, ...(recovery ? { recovery } : {}) };
                    } catch (error) {
                        if (!isCurrent()) throw new StaleServerGenerationError();
                        throw error;
                    }
                };
            } else {
                // Legacy configuration without an immutable prepared target retains
                // its historical active-Home lookup behavior. Production Sync
                // initialization always supplies the prepared branch above.
                if (
                    serverId !== snapshot.serverId
                    || generation !== snapshot.generation
                ) {
                    throw new StaleServerGenerationError();
                }
                const endpointComparableKey = createServerUrlComparableKey(endpoint);
                const activeServerComparableKey = createServerUrlComparableKey(snapshot.serverUrl);
                const serverLookupOptions =
                    endpointComparableKey
                    && activeServerComparableKey
                    && endpointComparableKey === activeServerComparableKey
                    && serverId
                        ? { serverId }
                        : undefined;
                const credentials = await TokenStorage.getCredentialsForServerUrl(endpoint, serverLookupOptions);
                if (!credentials) {
                    throw new Error('No authentication credentials');
                }
                const afterCredentialRead = getActiveServerSnapshot();
                if (
                    afterCredentialRead.serverId !== serverId
                    || afterCredentialRead.generation !== generation
                ) {
                    throw new StaleServerGenerationError();
                }
                credentialsToken = credentials.token;
                isCurrent = () => {
                    const current = getActiveServerSnapshot();
                    return current.generation === generation && current.serverId === serverId;
                };
                issueRequest = async () => ({
                    response: await serverFetch(
                        url,
                        {
                            ...options,
                            headers: (() => {
                                const headers = new Headers(options?.headers);
                                headers.set('Authorization', `Bearer ${credentials.token}`);
                                return headers;
                            })(),
                        },
                        { includeAuth: false, ...requestOptions },
                    ),
                });
            }

            const hasBody = options?.body != null;
            const hasSignal = Boolean(options?.signal);

            const canDedupe =
                (method === 'GET' || method === 'HEAD')
                && !hasBody
                && !hasSignal
                && options?.cache !== 'no-store';

            const requestKey = canDedupe
                // Intentionally exclude `snapshot.generation` from the de-dupe key so concurrent callers still share
                // a single in-flight fetch even if the active server generation changes while bootstrapping.
                ? `${serverId ?? ''}:${method}:${url}:tk:${getOrCreateTokenCacheKey(credentialsToken)}`
                : null;

            let result: InFlightHttpRequestResult;
            if (requestKey) {
                const existing = this.inFlightHttpRequestsByKey.get(requestKey);
                if (existing) {
                    result = await existing;
                } else {
                    const promise = issueRequest();
                    this.inFlightHttpRequestsByKey.set(requestKey, promise);
                    try {
                        result = await promise;
                    } finally {
                        this.inFlightHttpRequestsByKey.delete(requestKey);
                    }
                }
                // Always return a clone when de-duping to keep bodies readable per caller.
                result = { ...result, response: result.response.clone() };
            } else {
                result = await issueRequest();
            }

            if (!isCurrent() && !(result.recovery && acceptsRecoveredConfiguration?.(result.recovery))) {
                // The exact write was definitively refused before its own rejected
                // bearer was removed. Preserve that no-commit outcome, never its
                // old body or authority; any replacement still takes the stale path.
                if (result.response.status === 401 && acceptsRejectedConfiguration?.()) {
                    return new Response(null, { status: 401 });
                }
                throw new StaleServerGenerationError();
            }

            const response = result.response;

            // Best-effort server time calibration using the HTTP Date header ("server now").
            // This avoids deriving "now" from potentially stale resource timestamps (e.g. session.updatedAt).
            try {
                const dateHeader = response.headers.get('date');
                if (dateHeader) {
                    const serverNow = Date.parse(dateHeader);
                    if (!Number.isNaN(serverNow)) {
                        observeServerTimestamp(serverNow);
                    }
                }
            } catch {
                // Best-effort only
            }

            return response;
        } finally {
            unsubscribeCredentialChanges?.();
        }
    }

    //
    // Token Management
    //

    updateToken(newToken: string) {
        if (this.config && this.config.token !== newToken) {
            this.requestConfigurationAbortController.abort('credentials-changed');
            this.config.token = newToken;

            if (this.socket) {
                this.disconnect();
            }
            this.requestConfigurationAbortController = new AbortController();
            this.connect();
        }
    }

    /**
     * A config-bound request recovered this exact Home credential. Keep future
     * HTTP on the recovered bearer and reconnect the owned socket when one is
     * live; an unrelated staged Home never participates in this decision.
     */
    private adoptRecoveredHttpToken(params: Readonly<{
        config: SyncSocketConfig;
        rejectedToken: string;
        recoveredToken: string;
    }>): (() => boolean) | null {
        if (
            this.config !== params.config
            || this.config.token !== params.rejectedToken
            || !params.recoveredToken
        ) {
            return null;
        }
        const previousRequestConfigurationAbortController = this.requestConfigurationAbortController;
        this.config.token = params.recoveredToken;
        if (this.socket || this.socketTransport) {
            this.disconnect();
            const recoveredRequestConfigurationAbortController = new AbortController();
            this.requestConfigurationAbortController = recoveredRequestConfigurationAbortController;
            this.connect();
            return () => (
                this.config === params.config
                && this.config.token === params.recoveredToken
                && this.requestConfigurationAbortController === recoveredRequestConfigurationAbortController
                && !recoveredRequestConfigurationAbortController.signal.aborted
            );
        }
        return () => (
            this.config === params.config
            && this.config.token === params.recoveredToken
            && this.requestConfigurationAbortController === previousRequestConfigurationAbortController
            && !previousRequestConfigurationAbortController.signal.aborted
        );
    }

    //
    // Private Methods
    //

    private updateStatus(status: 'disconnected' | 'connecting' | 'connected' | 'error') {
        if (this.currentStatus !== status) {
            this.currentStatus = status;
            this.statusListeners.forEach(listener => listener(status));
        }
    }

    private invalidateReachabilityAfterSocketTransportFailure(error: unknown): void {
        const config = this.config;
        if (!config) return;
        if (config.request) return;
        void invalidateServerReachabilitySupervisor({ serverUrl: config.endpoint, token: config.token }).catch(() => {
            reportServerUnreachable(config.endpoint, error, config.token);
        });
    }

    private handleReachabilityStateChange(state: ManagedConnectionState): void {
        if (!this.config) {
            return;
        }

        if (state.phase !== 'online') {
            if (this.hasConnectedOnce) {
                this.pendingReconnectNotification = true;
            }
            void this.socketTransport?.disconnect({ intentional: true });
            return;
        }

        try {
            this.ensureSocketTransport();
        } catch (error) {
            this.setError(error instanceof Error ? error : new Error(String(error)));
            this.updateStatus('error');
            return;
        }

        if (!this.socketTransport || this.socketTransport.isConnected()) {
            return;
        }

        this.updateStatus('connecting');
        void this.socketTransport.connect().catch((error) => {
            this.setError(error instanceof Error ? error : new Error(String(error)));
            this.updateStatus('error');
        });
    }

    private ensureSocketTransport(forceNew = false): void {
        if (!this.config) return;
        const snapshot = this.config.request ? { serverId: this.config.serverId ?? this.config.endpoint,
            serverUrl: this.config.endpoint, generation: this.config.generation ?? 0,
            carrier: 'https' as const, runtimeOrigin: this.config.endpoint } : getActiveServerSnapshot();
        const hasCapturedServerTarget = Boolean(
            this.config.serverId && this.config.generation !== undefined,
        );
        if (!this.config.request && !isServerRuntimeTransportPublished({
            serverId: this.config.serverId ?? snapshot.serverId,
            carrier: this.config.carrier ?? (hasCapturedServerTarget ? undefined : snapshot.carrier),
        })) throw new ServerScopedTransportUnavailableError();
        const transportEndpoint = this.config.runtimeOrigin
            || (hasCapturedServerTarget ? null : resolveActiveServerRuntimeOrigin(snapshot))
            || this.config.endpoint;
        // A replaced carrier is a replaced transport even when the endpoint URL
        // is unchanged — which is exactly the browser Iroh case, where the URL is
        // always the canonical Home URL — so it belongs in the identity key.
        const homeCarrier = 'homeCarrier' in this.config
            ? this.config.homeCarrier ?? null
            : this.config.request ? null : getActiveServerHomeCarrier();
        const socketRole: HappierSocketRole = this.config.socketRole ?? { clientType: 'user-scoped' };
        const roleKey = socketRole.clientType === 'user-scoped'
            ? socketRole.clientType
            : socketRole.clientType === 'session-scoped'
                ? JSON.stringify([socketRole.clientType, socketRole.sessionId, socketRole.machineId ?? null])
                : JSON.stringify([socketRole.clientType, socketRole.machineId]);
        const key = `${transportEndpoint}|${this.config.token}|${homeCarrier?.endpointId ?? ''}|${roleKey}`;
        // A managed reconnect asks for a new disposable transport after retiring
        // the previous one, even when its captured Session authority is unchanged.
        if (!forceNew && this.socketTransport && this.socketTransportKey === key && this.socket) {
            return;
        }

        for (const detach of this.detachSocketTransportListeners.splice(0)) {
            detach();
        }
        void this.socketTransport?.disconnect({ intentional: true });
        void this.socketTransport?.destroy();
        this.socketTransport = null;
        this.socket = null;
        this.socketClientType = null;

        const { socket, transport } = createHappierSocket({
            endpoint: transportEndpoint,
            token: this.config.token,
            ...socketRole,
            clientPurpose: 'sync',
            authExtras: buildAccountStoredContentCompatibilitySocketAuthV1(
                CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
            ),
            transports: resolveSocketIoTransportsForCarrier(
                this.config.carrier ?? (hasCapturedServerTarget ? undefined : snapshot.carrier),
            ),
            ...(homeCarrier ? { websocketFactory: homeCarrier.createWebSocket } : {}),
        });
        this.socket = socket;
        this.socketClientType = socketRole.clientType;
        this.socketTransport = transport;
        this.socketTransportKey = key;
        const accountScoped = socketRole.clientType === 'user-scoped';
        const statusDemandTransport = accountScoped ? registerExternalSessionStatusDemandTransport(
            this.config.serverId ?? getActiveServerSnapshot().serverId,
            (event, payload) => {
                if (socket.connected) {
                    socket.emit(event, payload);
                }
            },
        ) : null;
        const messageContext: SyncSocketMessageContext = Object.freeze({
            serverId: String(this.config.serverId ?? '').trim() || null,
        });
        const detachInboundRequests = this.installSocketEventHandlers(socket, statusDemandTransport?.observeEphemeral ?? (() => {}), messageContext, socketRole);
        const transportConfig = this.config;

        this.detachSocketTransportListeners = [
            detachInboundRequests,
            ...(accountScoped ? [attachManagedSessionHumanPresenceSocket({
                serverId: this.config.serverId ?? getActiveServerSnapshot().serverId,
                token: this.config.token, socket, transport,
            })] : []),
            transport.onConnected(() => {
                if (this.config !== transportConfig || transportConfig?.isCurrent?.() === false) return;
                this.clearError();
                this.updateStatus('connected');
                if (accountScoped) notifyExecutionRunActivityReconnect(transportConfig.serverId ?? getActiveServerSnapshot().serverId);
                // Reconnect-safe: re-join every inbound reverse-RPC room on each (re)connect so a
                // dropped socket does not silently stop answering daemon reverse calls.
                if (accountScoped) {
                    for (const prefixedMethod of this.inboundMachineRpcHandlers.keys()) {
                        socket.emit(SOCKET_RPC_EVENTS.REGISTER, { method: prefixedMethod });
                    }
                }
                statusDemandTransport?.resend();
                if (this.hasConnectedOnce && this.pendingReconnectNotification) {
                    this.reconnectedListeners.forEach((listener) => listener());
                }
                this.hasConnectedOnce = true;
                this.pendingReconnectNotification = false;
            }),
            transport.onDisconnected((event: TransportDisconnectEvent) => {
                if (this.config !== transportConfig || transportConfig?.isCurrent?.() === false) return;
                if (!event.intentional && event.reason === 'io server disconnect' && transportConfig?.request) {
                    // Revocation and expiry are server-forced disconnects, not transient transport loss.
                    const supervisor = this.scopedConnectionSupervisor;
                    if (supervisor?.reportProbeResult) {
                        supervisor.reportProbeResult(
                            { status: 'auth_failed', statusCode: 401 },
                            supervisor.captureProbeReportScope?.(),
                        );
                    } else {
                        transportConfig.onCredentialRejected?.();
                    }
                    return;
                }
                this.updateStatus('disconnected');
                if (event.intentional) {
                    return;
                }
                this.pendingReconnectNotification = true;
                this.invalidateReachabilityAfterSocketTransportFailure(event.error ?? new Error(event.reason ?? 'socket disconnect'));
            }),
            transport.onError((error: unknown) => {
                if (this.config !== transportConfig || transportConfig?.isCurrent?.() === false) return;
                this.setError(error instanceof Error ? error : new Error(String(error)));
                this.invalidateReachabilityAfterSocketTransportFailure(error);
            }),
            () => statusDemandTransport?.dispose(),
        ];
    }

    private installSocketEventHandlers(
        socket: Socket,
        observeStatusDemandEphemeral: (update: unknown) => void,
        messageContext: SyncSocketMessageContext,
        socketRole: HappierSocketRole,
    ) {
        const installedConfig = this.config;
        let modeRead: { revision: number; promise: Promise<'plain' | 'e2ee'> } | null = null;
        const liveStreamTransport = createMachineLiveStreamSocketTransport({
            emit: (wire) => socket.emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, wire),
            deliver: (decoded) => {
                for (const handler of Array.from(this.messageHandlers.get(MACHINE_LIVE_STREAM_SOCKET_EVENT) ?? [])) {
                    handler(decoded, messageContext);
                }
            },
            isCurrent: () => this.socket === socket && this.config === installedConfig && installedConfig?.isCurrent?.() !== false,
            onError: (error) => this.setError(error),
            resolveContent: async (machineId): Promise<MachineLiveStreamContentV1> => {
                if (!installedConfig) throw new MachineLiveStreamPayloadErrorV1('stream_transport_unavailable');
                const revision = getAccountEncryptionModeCacheRevision();
                if (!modeRead || modeRead.revision !== revision) {
                    modeRead = { revision, promise: fetchAccountEncryptionCurrentness({ token: installedConfig.token }, {
                        request: (path, init) => this.request(path, init),
                    }).then((currentness) => currentness.mode) };
                }
                let mode: 'plain' | 'e2ee';
                try { mode = await modeRead.promise; }
                catch (error) { modeRead = null; throw error; }
                if (this.socket !== socket || this.config !== installedConfig) throw new MachineLiveStreamPayloadErrorV1('stream_transport_unavailable');
                if (getAccountEncryptionModeCacheRevision() !== revision) throw new MachineLiveStreamPayloadErrorV1('stream_encryption_mode_unavailable');
                if (readMachineStorageModeFromLocalState(machineId) !== mode) throw new MachineLiveStreamPayloadErrorV1('stream_payload_mode_mismatch');
                if (mode === 'plain') return { mode };
                const cipher = this.encryption?.getMachineEncryption(machineId);
                if (!cipher) throw new MachineLiveStreamPayloadErrorV1('stream_encryption_material_unavailable');
                return { mode, cipher };
            },
        });
        this.liveStreamTransport = liveStreamTransport;
        const abortInboundRequests = () => {
            for (const [controller, request] of this.activeInboundMachineRpcRequests) {
                if (request.socket === socket) controller.abort('rpc-target-disconnected');
            }
        };
        socket.on?.('server:restarting', (payload: unknown) => {
            const config = this.config;
            if (!config) return;
            if (config.request) {
                const retryAfterMs = readPlannedRestartRetryAfterMs(payload);
                this.scopedConnectionSupervisor?.reportProbeResult?.({ status: 'retry_later', reason: 'server_restarting',
                    ...(retryAfterMs ? { retryAfterMs } : {}) });
                return;
            }
            reportServerRestarting(config.endpoint, readPlannedRestartRetryAfterMs(payload), config.token);
        });
        if (socketRole.clientType === 'user-scoped') {
            socket.on('disconnect', abortInboundRequests);
            socket.on(SOCKET_RPC_EVENTS.CANCEL, (payload: unknown) => {
                if (this.socket !== socket || this.config !== installedConfig) return;
                const parsed = SocketRpcCancellationPayloadSchema.safeParse(payload);
                if (!parsed.success) return;
                for (const [controller, request] of this.activeInboundMachineRpcRequests) {
                    if (request.socket === socket && request.requestId === parsed.data.requestId) controller.abort('rpc-caller-canceled');
                }
            });
            socket.on(
                SOCKET_RPC_EVENTS.REQUEST,
                async (
                    data: Readonly<{ method?: unknown; params?: unknown; requestId?: unknown }>,
                    callback: (response: unknown) => void,
                ) => {
                    if (this.socket !== socket || this.config !== installedConfig || installedConfig?.isCurrent?.() === false) {
                        callback({ error: 'RPC target transport retired', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
                        return;
                    }
                    const controller = new AbortController();
                    const requestId = SocketRpcRequestIdSchema.safeParse(data.requestId);
                    this.activeInboundMachineRpcRequests.set(controller, { socket,
                        method: typeof data.method === 'string' ? data.method : '',
                        ...(requestId.success ? { requestId: requestId.data } : {}),
                    });
                    try { callback(await this.handleInboundMachineRpcRequest(data, { signal: controller.signal })); }
                    finally { this.activeInboundMachineRpcRequests.delete(controller); }
                },
            );
        }
        socket.onAny((event, data) => {
            if (this.config !== installedConfig || installedConfig?.isCurrent?.() === false) return;
            if (event === MACHINE_LIVE_STREAM_SOCKET_EVENT) {
                liveStreamTransport.receive(data);
                return;
            }
            if (event === 'ephemeral') {
                observeStatusDemandEphemeral(data);
            }
            const handlers = this.messageHandlers.get(event);
            syncPerformanceTelemetry.measure(
                'sync.socket.event',
                { handlers: handlers?.size ?? 0 },
                () => {
                    if (!handlers || handlers.size === 0) {
                        return;
                    }
                    for (const handler of Array.from(handlers)) {
                        handler(data, messageContext);
                    }
                },
            );
        });
        return abortInboundRequests;
    }

    /**
     * Dispatch one inbound machine-scoped reverse-RPC request (the `rpc-request` ack body).
     *
     * Mirrors the daemon-side `RpcHandlerManager.handleRequest` contract so the daemon's
     * `callConnectedClientRpc` round-trips symmetrically: params arrive machine-encrypted, the
     * response is machine-encrypted back. Every failure mode (no machine key, unknown method, bad
     * params, handler throw) returns a fail-closed payload so the daemon treats it as "no UI" rather
     * than ever observing a fabricated success.
     */
    private async handleInboundMachineRpcRequest(
        request: Readonly<{ method?: unknown; params?: unknown }>,
        context?: Readonly<{ signal: AbortSignal }>,
    ): Promise<unknown> {
        const method = typeof request?.method === 'string' ? request.method : '';
        const separatorIndex = method.indexOf(':');
        const machineId = separatorIndex > 0 ? method.slice(0, separatorIndex) : '';
        const usePlaintextParams =
            readMachineStorageModeFromLocalState(machineId) === 'plain';
        const machineEncryption = machineId && !usePlaintextParams
            ? this.encryption?.getMachineEncryption(machineId) ?? null
            : null;
        if (!usePlaintextParams && !machineEncryption) {
            // Cannot speak the machine-scoped e2ee envelope — fail closed. The daemon cannot decrypt
            // this non-encrypted body and treats it as an unavailable UI.
            return { error: 'Machine encryption not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        }

        const content: SocketRpcContent = usePlaintextParams
            ? { mode: 'plain' }
            : { mode: 'e2ee', cipher: machineEncryption! };

        let callId: string | null = null;
        const respond = (value: unknown) => socketRpcCodec.encodeResponse(content, value, callId);
        let decryptedParams: unknown;
        try {
            const decoded = await socketRpcCodec.decodeRequestParams(content, request.params, method);
            decryptedParams = decoded.params;
            callId = decoded.callId;
        } catch (error) {
            return await respond({ error: error instanceof Error ? error.message : 'Unable to open RPC content',
                errorCode: readRpcErrorCode(error) ?? RPC_ERROR_CODES.UPDATE_REQUIRED });
        }

        const handler = this.inboundMachineRpcHandlers.get(method);
        if (!handler) {
            const response = {
                error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND,
                errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            };
            return await respond(response);
        }

        try {
            if (decryptedParams === null) {
                const response = { error: 'Invalid RPC params' };
                return await respond(response);
            }
            if (this.inboundMachineRpcHandlers.get(method) !== handler) {
                return await respond({ error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
            }
            const result = await handler(decryptedParams, context);
            return await respond(result);
        } catch (error) {
            const response = {
                error: error instanceof Error ? error.message : 'Unknown error',
                ...(readRpcErrorCode(error) ? { errorCode: readRpcErrorCode(error) } : {}),
            };
            return await respond(response);
        }
    }

    private applyManagedConnectionState(state: ManagedConnectionState) {
        this.currentConnectionState = state;
        for (const listener of this.connectionStateListeners) {
            listener(state);
        }
        switch (state.phase) {
            case 'connecting':
                this.updateStatus('connecting');
                return;
            case 'auth_failed':
                this.updateStatus('error');
                return;
            case 'online':
                if (this.socketTransport?.isConnected() === true) {
                    this.updateStatus('connected');
                } else if (this.currentStatus === 'disconnected') {
                    this.updateStatus('connecting');
                }
                return;
            case 'offline':
            case 'idle':
            case 'shutting_down':
                this.updateStatus('disconnected');
                return;
            default:
                this.updateStatus('disconnected');
        }
    }

    private clearError() {
        this.errorListeners.forEach(listener => listener(null));
    }

    private setError(error: Error) {
        this.errorListeners.forEach(listener => listener(error));
    }

    private async coerceAckTimeoutAuthError(error: unknown): Promise<unknown> {
        const existingDisposition = readRpcRequestDisposition(error);
        const disposition = existingDisposition ?? 'notSent';
        const classifiedError = existingDisposition === null
            ? markRpcRequestDisposition(error, disposition)
            : error;
        if (!isSocketIoAckTimeoutError(error)) {
            return classifiedError;
        }
        if (this.currentConnectionState.phase === 'auth_failed') {
            return markRpcRequestDisposition(createNotAuthenticatedError(), disposition);
        }

        const timeoutMs = readSocketAckAuthSettleTimeoutMs();
        if (timeoutMs <= 0) {
            return classifiedError;
        }

        const authFailed = await this.waitForConnectionAuthFailure(timeoutMs);
        return authFailed
            ? markRpcRequestDisposition(createNotAuthenticatedError(), disposition)
            : classifiedError;
    }

    private async waitForConnectionAuthFailure(timeoutMs: number): Promise<boolean> {
        if (this.currentConnectionState.phase === 'auth_failed') {
            return true;
        }

        return await new Promise<boolean>((resolve) => {
            let timeout: ReturnType<typeof setTimeout> | null = null;
            let listener: ((state: ManagedConnectionState) => void) | null = null;

            const finish = (value: boolean): void => {
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = null;
                }
                if (listener) {
                    this.connectionStateListeners.delete(listener);
                }
                resolve(value);
            };

            listener = (state: ManagedConnectionState): void => {
                if (state.phase === 'auth_failed') {
                    finish(true);
                }
            };

            this.connectionStateListeners.add(listener);
            timeout = setTimeout(() => finish(false), Math.max(0, timeoutMs));
        });
    }
}

//
// Singleton Export
//

export const apiSocket = new ApiSocket();

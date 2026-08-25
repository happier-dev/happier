import { Socket } from 'socket.io-client';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { Encryption } from '@/sync/encryption/encryption';
import { observeServerTimestamp } from '@/sync/runtime/time';
import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import {
    MACHINE_LIVE_STREAM_SOCKET_EVENT,
    TRANSFER_RELAY_V2_SOCKET_EVENT,
    type MachineLiveStreamRelayEnvelopeV1,
    type TransferRelayV2SendEnvelope,
} from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import {
    RPC_ERROR_CODES,
    RPC_ERROR_MESSAGES,
    RPC_METHODS,
    SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
    resolveSocketRpcSessionWriteAuthorizationMethod,
    type SocketRpcAuthorizationContext,
} from '@happier-dev/protocol/rpc';
import { handleUiBrowserRecordingCaptureFrameRequest } from '@/sync/domains/browser/recording/reverseCaptureHandler';
import { serverFetch, StaleServerGenerationError } from '@/sync/http/client';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveSocketIoTransports } from '@/sync/runtime/socketIoTransports';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { storage } from '@/sync/domains/state/storage';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import {
    type ManagedConnectionState,
    type ManagedConnectionTransport,
    type TransportDisconnectEvent,
} from '@happier-dev/connection-supervisor';
import { createSyncSocketTransport } from '@/sync/api/session/connection/createSyncSocketTransport';
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
import { isSocketIoAckTimeoutError, raceSocketIoAckTimeout } from '@/sync/runtime/socketIoAckTimeout';
import { registerExternalSessionStatusDemandTransport } from '@/sync/runtime/orchestration/externalSessions/externalSessionStatusDemandCoordinator';
import {
    createSocketRpcAbortError,
    createSocketRpcRequestId,
    issueSocketRpcCallWithCancellation,
} from '@/sync/runtime/socketRpcCallCancellation';
import {
    requireCurrentAccountStoredContentServerCompatibility,
} from '@/sync/api/capabilities/accountStoredContentCompatibility';

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
        const state: any = storage.getState();
        const row = state?.sessions?.[sid] ?? null;
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

function getGlobalInFlightHttpRequestsByKey(): Map<string, Promise<Response>> {
    const host = getInFlightHttpRequestsHost();
    const existing = host[GLOBAL_IN_FLIGHT_HTTP_REQUESTS_KEY];
    // Cross-realm: `instanceof Map` can fail when the Map was created in a different JS realm.
    if (existing && Object.prototype.toString.call(existing) === '[object Map]') {
        return existing as Map<string, Promise<Response>>;
    }
    const created = new Map<string, Promise<Response>>();
    host[GLOBAL_IN_FLIGHT_HTTP_REQUESTS_KEY] = created;
    return created;
}

function buildSocketRpcCallPayload(params: Readonly<{
    method: string;
    payload: unknown;
    timeoutMs?: number | null;
    requestId?: string;
    authorization?: SocketRpcAuthorizationContext;
}>): Readonly<{
    method: string;
    params: unknown;
    timeoutMs?: number;
    requestId?: string;
    authorization?: SocketRpcAuthorizationContext;
}> {
    if (typeof params.timeoutMs === 'number' && params.timeoutMs > 0) {
        return {
            method: params.method,
            params: params.payload,
            timeoutMs: params.timeoutMs,
            ...(params.requestId ? { requestId: params.requestId } : {}),
            ...(params.authorization ? { authorization: params.authorization } : {}),
        };
    }
    return {
        method: params.method,
        params: params.payload,
        ...(params.requestId ? { requestId: params.requestId } : {}),
        ...(params.authorization ? { authorization: params.authorization } : {}),
    };
}

//
// Types
//

export interface SyncSocketConfig {
    endpoint: string;
    token: string;
}

export interface SyncSocketState {
    isConnected: boolean;
    connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
    lastError: Error | null;
}

export type SyncSocketListener = (state: SyncSocketState) => void;

/**
 * Inbound machine-scoped reverse-RPC handler. Receives the already-decrypted request params and
 * returns the response payload that this socket will re-encrypt (machine-scoped e2ee) for the ack.
 */
export type InboundMachineRpcHandler = (params: unknown) => Promise<unknown> | unknown;

//
// Main Class
//

class ApiSocket {

    // State
    private socket: Socket | null = null;
    private socketTransportKey: string | null = null;
    private config: SyncSocketConfig | null = null;
    private encryption: Encryption | null = null;
    private messageHandlers: Map<string, Set<(data: any) => void>> = new Map();
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
    private inFlightHttpRequestsByKey: Map<string, Promise<Response>> = getGlobalInFlightHttpRequestsByKey();
    private hasConnectedOnce = false;
    private pendingReconnectNotification = false;
    private reachabilityUnsubscribe: (() => void) | null = null;
    private reachabilityServerUrl: string | null = null;
    private socketTransport: ManagedConnectionTransport | null = null;
    private detachSocketTransportListeners: Array<() => void> = [];
    // Inbound machine-scoped reverse-RPC handlers, keyed by the FULL prefixed method
    // (`<machineId>:<method>`). The daemon for `<machineId>` calls this method over its machine
    // socket; the server forwards it to whichever client joined the matching rpc room. Registering
    // here makes THIS user-scoped socket that client (room membership via `rpc-register`).
    private inboundMachineRpcHandlers: Map<string, InboundMachineRpcHandler> = new Map();

    //
    // Initialization
    //

    initialize(config: SyncSocketConfig, encryption: Encryption | null) {
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
        const endpoint = this.config.endpoint;
        const token = this.config.token;
        const serverUrl = canonicalizeServerUrl(endpoint) || endpoint;

        if (this.reachabilityUnsubscribe && this.reachabilityServerUrl && this.reachabilityServerUrl !== serverUrl) {
            const previousServerUrl = this.reachabilityServerUrl;
            this.reachabilityUnsubscribe();
            this.reachabilityUnsubscribe = null;
            this.reachabilityServerUrl = null;
            void stopServerReachabilitySupervisor(previousServerUrl);
        }

        if (!this.reachabilityUnsubscribe) {
            this.reachabilityServerUrl = serverUrl;
            this.reachabilityUnsubscribe = subscribeServerReachabilityState(serverUrl, (state) => {
                this.applyManagedConnectionState(state);
                this.handleReachabilityStateChange(state);
            });
        }

        void startServerReachabilitySupervisor({ serverUrl, token });
    }

    disconnect() {
        const previousServerUrl = this.reachabilityServerUrl;
        this.reachabilityUnsubscribe?.();
        this.reachabilityUnsubscribe = null;
        this.reachabilityServerUrl = null;
        if (previousServerUrl) {
            void stopServerReachabilitySupervisor(previousServerUrl);
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

    onMessage(event: string, handler: (data: any) => void) {
        const handlers = this.messageHandlers.get(event) ?? new Set<(data: any) => void>();
        handlers.add(handler);
        this.messageHandlers.set(event, handlers);
        return () => this.offMessage(event, handler);
    }

    offMessage(event: string, handler: (data: any) => void) {
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
        this.send(MACHINE_LIVE_STREAM_SOCKET_EVENT, payload);
    }

    /**
     * RPC call for sessions - uses session-specific encryption
     */
    async sessionRPC<R, A>(
        sessionId: string,
        method: string,
        params: A,
        options?: { timeoutMs?: number | null; onIssued?: () => void; signal?: AbortSignal },
    ): Promise<R> {
        if (options?.signal?.aborted) throw createSocketRpcAbortError();
        const sessionEncryptionMode = readSessionEncryptionModeFromLocalState(sessionId);
        const usePlaintextParams = sessionEncryptionMode === 'plain';
        const sessionEncryption = usePlaintextParams ? null : this.encryption?.getSessionEncryption(sessionId);
        if (!usePlaintextParams && !sessionEncryption) throw new Error(`Session encryption not found for ${sessionId}`);
        const scmDebug =
            __DEV__
            && process.env.EXPO_PUBLIC_HAPPIER_DEBUG_SCM_RPC === 'true'
            && method.startsWith('scm.');
        if (scmDebug) {
            // eslint-disable-next-line no-console
            console.log('[SCM_RPC][call]', { sessionId, method });
        }

        let encryptedParams: unknown = params;
        if (!usePlaintextParams) {
            if (!sessionEncryption) throw new Error(`Session encryption not found for ${sessionId}`);
            encryptedParams = await sessionEncryption.encryptRaw(params);
        }
        const requestId = options?.signal ? createSocketRpcRequestId() : undefined;
        const result: any = await this.emitWithAck(
            SOCKET_RPC_EVENTS.CALL,
            buildSocketRpcCallPayload({
                method: `${sessionId}:${method}`,
                payload: encryptedParams,
                timeoutMs: options?.timeoutMs,
                requestId,
                ...(resolveSocketRpcSessionWriteAuthorizationMethod(method)
                    ? {
                        authorization: {
                            kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
                            sessionId,
                        },
                    }
                    : {}),
            }),
            {
                ...options,
                ...(requestId ? { cancelRequestId: requestId } : {}),
            },
        );
        if (scmDebug) {
            const rawResult = result?.result;
            // eslint-disable-next-line no-console
            console.log('[SCM_RPC][ack]', {
                method,
                ok: Boolean(result?.ok),
                error: typeof result?.error === 'string' ? result.error : null,
                errorCode: typeof result?.errorCode === 'string' ? result.errorCode : null,
                resultType: typeof rawResult,
                resultIsArray: Array.isArray(rawResult),
                resultLength: typeof rawResult === 'string' ? rawResult.length : null,
            });
        }

        if (result.ok) {
            if (usePlaintextParams) return result.result as R;
            if (!sessionEncryption) throw new Error(`Session encryption not found for ${sessionId}`);
            const decrypted = await sessionEncryption.decryptRaw(result.result);
            if (scmDebug) {
                // eslint-disable-next-line no-console
                console.log('[SCM_RPC][decrypt]', {
                    method,
                    decryptedType: decrypted === null ? 'null' : typeof decrypted,
                    hasSuccessField: Boolean(decrypted && typeof decrypted === 'object' && 'success' in decrypted),
                    success: Boolean(
                        decrypted
                        && typeof decrypted === 'object'
                        && typeof (decrypted as { success?: unknown }).success === 'boolean'
                        && (decrypted as { success: boolean }).success
                    ),
                });
            }
            return decrypted as R;
        }
        throw createRpcCallError({
            error: typeof result.error === 'string' ? result.error : 'RPC call failed',
            errorCode: typeof result.errorCode === 'string' ? result.errorCode : undefined,
        });
    }

    /**
     * RPC call for machines using the Machine's persisted content mode.
     */
    async machineRPC<R, A>(
        machineId: string,
        method: string,
        params: A,
        options?: {
            timeoutMs?: number;
            authorization?: SocketRpcAuthorizationContext;
            onIssued?: () => void;
            signal?: AbortSignal;
        },
    ): Promise<R> {
        if (options?.signal?.aborted) throw createSocketRpcAbortError();
        const usePlaintextParams =
            readMachineStorageModeFromLocalState(machineId) === 'plain';
        if (usePlaintextParams) {
            await requireCurrentAccountStoredContentServerCompatibility();
        }
        const machineEncryption = usePlaintextParams
            ? null
            : this.encryption?.getMachineEncryption(machineId) ?? null;
        if (!usePlaintextParams && !machineEncryption) {
            throw new Error(`Machine encryption not found for ${machineId}`);
        }

        const encodedParams = usePlaintextParams
            ? params
            : await machineEncryption!.encryptRaw(params);
        const requestId = options?.signal ? createSocketRpcRequestId() : undefined;
        const result: any = await this.emitWithAck(
            SOCKET_RPC_EVENTS.CALL,
            buildSocketRpcCallPayload({
                method: `${machineId}:${method}`,
                payload: encodedParams,
                timeoutMs: options?.timeoutMs,
                requestId,
                authorization: options?.authorization,
            }),
            {
                ...options,
                ...(requestId ? { cancelRequestId: requestId } : {}),
            },
        );

        if (result.ok) {
            return usePlaintextParams
                ? result.result as R
                : await machineEncryption!.decryptRaw(result.result) as R;
        }
        throw createRpcCallError({
            error: typeof result.error === 'string' ? result.error : 'RPC call failed',
            errorCode: typeof result.errorCode === 'string' ? result.errorCode : undefined,
        });
    }

    send(event: string, data: any) {
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
        this.inboundMachineRpcHandlers.set(prefixedMethod, handler);
        this.socket?.emit(SOCKET_RPC_EVENTS.REGISTER, { method: prefixedMethod });
        return () => {
            if (this.inboundMachineRpcHandlers.get(prefixedMethod) === handler) {
                this.inboundMachineRpcHandlers.delete(prefixedMethod);
                this.socket?.emit(SOCKET_RPC_EVENTS.UNREGISTER, { method: prefixedMethod });
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
        if (this.currentConnectionState.phase === 'auth_failed') {
            throw createNotAuthenticatedError();
        }
        const socket = this.socket;
        if (!socket) {
            throw new Error('Socket not connected');
        }
        if (socket.connected === false) {
            throw new Error('Socket not connected');
        }
        const timeoutMs = opts?.timeoutMs;
        try {
            const socketEmission = typeof timeoutMs === 'number' && timeoutMs > 0
                ? socket.timeout(timeoutMs)
                : socket;
            return await issueSocketRpcCallWithCancellation({
                signal: opts?.signal,
                requestId: opts?.cancelRequestId,
                onIssued: opts?.onIssued,
                issue: async () => await raceSocketIoAckTimeout(
                    socketEmission.emitWithAck(event, data) as Promise<T>,
                    timeoutMs ?? undefined,
                ),
                emitCancel: (requestId) => {
                    socket.emit(SOCKET_RPC_EVENTS.CANCEL, { requestId });
                },
            });
        } catch (error) {
            throw await this.coerceAckTimeoutAuthError(error);
        }
    }

    //
    // HTTP Requests
    //

    async request(path: string, options?: RequestInit): Promise<Response> {
        if (!this.config) {
            throw new Error('SyncSocket not initialized');
        }
        const snapshot = getActiveServerSnapshot();
        const endpointComparableKey = createServerUrlComparableKey(this.config.endpoint);
        const activeServerComparableKey = createServerUrlComparableKey(snapshot.serverUrl);
        const serverLookupOptions =
            endpointComparableKey
            && activeServerComparableKey
            && endpointComparableKey === activeServerComparableKey
            && snapshot.serverId
                ? { serverId: snapshot.serverId }
                : undefined;

        const credentials = await TokenStorage.getCredentialsForServerUrl(this.config.endpoint, serverLookupOptions);
        if (!credentials) {
            throw new Error('No authentication credentials');
        }

        const url = `${this.config.endpoint}${path}`;
        const method = String(options?.method ?? 'GET').toUpperCase();
        const hasBody = options?.body != null;
        const hasSignal = Boolean(options?.signal);
        const headers = new Headers(options?.headers);
        headers.set('Authorization', `Bearer ${credentials.token}`);

        const canDedupe =
            (method === 'GET' || method === 'HEAD')
            && !hasBody
            && !hasSignal;

        const requestKey = canDedupe
            // Intentionally exclude `snapshot.generation` from the de-dupe key so concurrent callers still share
            // a single in-flight fetch even if the active server generation changes while bootstrapping.
            ? `${snapshot.serverId ?? ''}:${method}:${url}:tk:${getOrCreateTokenCacheKey(credentials.token)}`
            : null;

        let response: Response;
        if (requestKey) {
            const existing = this.inFlightHttpRequestsByKey.get(requestKey);
            if (existing) {
                response = await existing;
            } else {
                const promise = serverFetch(
                    url,
                    {
                        ...options,
                        headers,
                    },
                    { includeAuth: false },
                ) as Promise<Response>;
                this.inFlightHttpRequestsByKey.set(requestKey, promise);
                try {
                    response = await promise;
                } finally {
                    this.inFlightHttpRequestsByKey.delete(requestKey);
                }
            }
            // Always return a clone when de-duping to keep bodies readable per caller.
            response = response.clone();
        } else {
            response = await serverFetch(
                url,
                {
                    ...options,
                    headers,
                },
                { includeAuth: false },
            );
        }

        const current = getActiveServerSnapshot();
        if (current.generation !== snapshot.generation || current.serverId !== snapshot.serverId) {
            throw new StaleServerGenerationError();
        }

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
    }

    //
    // Token Management
    //

    updateToken(newToken: string) {
        if (this.config && this.config.token !== newToken) {
            this.config.token = newToken;

            const serverUrl = canonicalizeServerUrl(this.config.endpoint) || this.config.endpoint;
            void startServerReachabilitySupervisor({ serverUrl, token: newToken });

            if (this.socket) {
                this.disconnect();
                this.connect();
            }
        }
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
        void invalidateServerReachabilitySupervisor({ serverUrl: config.endpoint, token: config.token }).catch(() => {
            reportServerUnreachable(config.endpoint, error);
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

    private ensureSocketTransport(): void {
        if (!this.config) return;
        const key = `${this.config.endpoint}|${this.config.token}`;
        if (this.socketTransport && this.socketTransportKey === key && this.socket) {
            return;
        }

        for (const detach of this.detachSocketTransportListeners.splice(0)) {
            detach();
        }
        void this.socketTransport?.disconnect({ intentional: true });
        void this.socketTransport?.destroy();
        this.socketTransport = null;
        this.socket = null;

        const { socket, transport } = createSyncSocketTransport({
            endpoint: this.config.endpoint,
            token: this.config.token,
            transports: resolveSocketIoTransports(),
        });
        this.socket = socket;
        this.socketTransport = transport;
        this.socketTransportKey = key;
        const statusDemandTransport = registerExternalSessionStatusDemandTransport(
            getActiveServerSnapshot().serverId,
            (event, payload) => {
                if (socket.connected) {
                    socket.emit(event, payload);
                }
            },
        );
        this.installSocketEventHandlers(socket, statusDemandTransport.observeEphemeral);

        this.detachSocketTransportListeners = [
            transport.onConnected(() => {
                this.clearError();
                this.updateStatus('connected');
                // Reconnect-safe: re-join every inbound reverse-RPC room on each (re)connect so a
                // dropped socket does not silently stop answering daemon reverse calls.
                for (const prefixedMethod of this.inboundMachineRpcHandlers.keys()) {
                    socket.emit(SOCKET_RPC_EVENTS.REGISTER, { method: prefixedMethod });
                }
                statusDemandTransport.resend();
                if (this.hasConnectedOnce && this.pendingReconnectNotification) {
                    this.reconnectedListeners.forEach((listener) => listener());
                }
                this.hasConnectedOnce = true;
                this.pendingReconnectNotification = false;
            }),
            transport.onDisconnected((event: TransportDisconnectEvent) => {
                this.updateStatus('disconnected');
                if (event.intentional) {
                    return;
                }
                this.pendingReconnectNotification = true;
                this.invalidateReachabilityAfterSocketTransportFailure(event.error ?? new Error(event.reason ?? 'socket disconnect'));
            }),
            transport.onError((error: unknown) => {
                this.setError(error instanceof Error ? error : new Error(String(error)));
                this.invalidateReachabilityAfterSocketTransportFailure(error);
            }),
            () => statusDemandTransport.dispose(),
        ];
    }

    private installSocketEventHandlers(
        socket: Socket,
        observeStatusDemandEphemeral: (update: unknown) => void,
    ) {
        socket.on?.('server:restarting', (payload: unknown) => {
            const config = this.config;
            if (!config) return;
            reportServerRestarting(config.endpoint, readPlannedRestartRetryAfterMs(payload));
        });
        socket.on(
            SOCKET_RPC_EVENTS.REQUEST,
            async (
                data: Readonly<{ method?: unknown; params?: unknown }>,
                callback: (response: unknown) => void,
            ) => {
                callback(await this.handleInboundMachineRpcRequest(data));
            },
        );
        socket.onAny((event, data) => {
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
                        handler(data);
                    }
                },
            );
        });
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
    ): Promise<unknown> {
        const method = typeof request?.method === 'string' ? request.method : '';
        const separatorIndex = method.indexOf(':');
        const machineId = separatorIndex > 0 ? method.slice(0, separatorIndex) : '';
        const usePlaintextParams =
            readMachineStorageModeFromLocalState(machineId) === 'plain';
        if (usePlaintextParams) {
            try {
                await requireCurrentAccountStoredContentServerCompatibility();
            } catch (error) {
                return {
                    error: error instanceof Error
                        ? error.message
                        : 'Client upgrade required',
                    errorCode:
                        error
                        && typeof error === 'object'
                        && typeof (error as { code?: unknown }).code === 'string'
                            ? (error as { code: string }).code
                            : 'client-upgrade-required',
                    retryable: false,
                };
            }
        }
        const machineEncryption = machineId && !usePlaintextParams
            ? this.encryption?.getMachineEncryption(machineId) ?? null
            : null;
        if (!usePlaintextParams && !machineEncryption) {
            // Cannot speak the machine-scoped e2ee envelope — fail closed. The daemon cannot decrypt
            // this non-encrypted body and treats it as an unavailable UI.
            return { error: 'Machine encryption not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        }

        const handler = this.inboundMachineRpcHandlers.get(method);
        if (!handler) {
            const response = {
                error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND,
                errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            };
            return usePlaintextParams
                ? response
                : await machineEncryption!.encryptRaw(response);
        }

        try {
            const decryptedParams = usePlaintextParams
                ? request.params
                : typeof request.params === 'string'
                    ? await machineEncryption!.decryptRaw(request.params)
                    : null;
            if (decryptedParams === null) {
                const response = { error: 'Invalid RPC params' };
                return usePlaintextParams
                    ? response
                    : await machineEncryption!.encryptRaw(response);
            }
            const result = await handler(decryptedParams);
            return usePlaintextParams
                ? result
                : await machineEncryption!.encryptRaw(result);
        } catch (error) {
            const response = {
                error: error instanceof Error ? error.message : 'Unknown error',
            };
            return usePlaintextParams
                ? response
                : await machineEncryption!.encryptRaw(response);
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
        if (!isSocketIoAckTimeoutError(error)) {
            return error;
        }
        if (this.currentConnectionState.phase === 'auth_failed') {
            return createNotAuthenticatedError();
        }

        const timeoutMs = readSocketAckAuthSettleTimeoutMs();
        if (timeoutMs <= 0) {
            return error;
        }

        const authFailed = await this.waitForConnectionAuthFailure(timeoutMs);
        return authFailed ? createNotAuthenticatedError() : error;
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

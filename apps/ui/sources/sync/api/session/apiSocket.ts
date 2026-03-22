import { Socket } from 'socket.io-client';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { Encryption } from '@/sync/encryption/encryption';
import { observeServerTimestamp } from '@/sync/runtime/time';
import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { StaleServerGenerationError } from '@/sync/http/client';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { resolveSocketIoTransports } from '@/sync/runtime/socketIoTransports';
import { storage } from '@/sync/domains/state/storage';
import {
    createManagedConnectionSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ManagedConnectionState,
    type ManagedConnectionSupervisor,
} from '@happier-dev/connection-supervisor';
import { createSyncSocketReadinessProbe } from '@/sync/api/session/connection/createSyncSocketReadinessProbe';
import { createSyncSocketTransport } from '@/sync/api/session/connection/createSyncSocketTransport';

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

const GLOBAL_IN_FLIGHT_HTTP_REQUESTS_KEY = '__HAPPIER_GLOBAL_IN_FLIGHT_HTTP_REQUESTS_BY_KEY__';

function getInFlightHttpRequestsHost(): Record<string, unknown> {
    // Vitest module isolation can evaluate the same module graph under separate `globalThis` realms.
    // When available, prefer `process` as a stable cross-realm anchor so we still de-dupe in-flight
    // HTTP requests across module instances.
    const g = globalThis as unknown as Record<string, unknown>;
    // Prefer the Node global `process` symbol when present; `globalThis.process` may be a realm-local
    // shim/proxy under certain test runners.
    const p = typeof process !== 'undefined' ? (process as unknown) : null;
    if (p && typeof p === 'object') return p as Record<string, unknown>;

    const gp = (g as any)?.process;
    if (gp && typeof gp === 'object') return gp as Record<string, unknown>;

    return g;
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
    timeoutMs?: number;
}>): Readonly<{ method: string; params: unknown; timeoutMs?: number }> {
    if (typeof params.timeoutMs === 'number' && params.timeoutMs > 0) {
        return {
            method: params.method,
            params: params.payload,
            timeoutMs: params.timeoutMs,
        };
    }
    return {
        method: params.method,
        params: params.payload,
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

//
// Main Class
//

class ApiSocket {

    // State
    private socket: Socket | null = null;
    private config: SyncSocketConfig | null = null;
    private encryption: Encryption | null = null;
    private messageHandlers: Map<string, (data: any) => void> = new Map();
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
    private connectionSupervisor: ManagedConnectionSupervisor | null = null;
    private hasConnectedOnce = false;
    private pendingReconnectNotification = false;

    //
    // Initialization
    //

    initialize(config: SyncSocketConfig, encryption: Encryption) {
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

        if (!this.connectionSupervisor) {
            this.connectionSupervisor = createManagedConnectionSupervisor({
                ...DEFAULT_MANAGED_CONNECTION_POLICY,
                createTransport: () => {
                    const { socket, transport } = createSyncSocketTransport({
                        endpoint: this.config!.endpoint,
                        token: this.config!.token,
                        transports: resolveSocketIoTransports(),
                    });
                    this.socket = socket;
                    this.installSocketEventHandlers(socket);
                    return transport;
                },
                probeReadiness: async () => createSyncSocketReadinessProbe({
                    endpoint: this.config!.endpoint,
                    token: this.config!.token,
                })(),
                onStateChange: (state) => {
                    this.applyManagedConnectionState(state);
                },
                onConnected: async () => {
                    this.clearError();
                    if (this.hasConnectedOnce && this.pendingReconnectNotification) {
                        this.reconnectedListeners.forEach(listener => listener());
                    }
                    this.hasConnectedOnce = true;
                    this.pendingReconnectNotification = false;
                },
                onAuthFailed: async ({ probe }) => {
                    this.setError(new Error(probe.errorMessage ?? 'Authentication failed'));
                    this.updateStatus('error');
                },
            });
        }

        void this.connectionSupervisor.start();
    }

    disconnect() {
        void this.connectionSupervisor?.stop();
        this.socket = null;
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
        this.messageHandlers.set(event, handler);
        return () => this.messageHandlers.delete(event);
    }

    offMessage(event: string, handler: (data: any) => void) {
        this.messageHandlers.delete(event);
    }

    /**
     * RPC call for sessions - uses session-specific encryption
     */
    async sessionRPC<R, A>(sessionId: string, method: string, params: A, options?: { timeoutMs?: number }): Promise<R> {
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
        const result: any = await this.emitWithAck(
            SOCKET_RPC_EVENTS.CALL,
            buildSocketRpcCallPayload({
                method: `${sessionId}:${method}`,
                payload: encryptedParams,
                timeoutMs: options?.timeoutMs,
            }),
            options,
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
     * RPC call for machines - uses legacy/global encryption (for now)
     */
    async machineRPC<R, A>(
        machineId: string,
        method: string,
        params: A,
        options?: { timeoutMs?: number },
    ): Promise<R> {
        const machineEncryption = this.encryption!.getMachineEncryption(machineId);
        if (!machineEncryption) {
            throw new Error(`Machine encryption not found for ${machineId}`);
        }

        const result: any = await this.emitWithAck(
            SOCKET_RPC_EVENTS.CALL,
            buildSocketRpcCallPayload({
                method: `${machineId}:${method}`,
                payload: await machineEncryption.encryptRaw(params),
                timeoutMs: options?.timeoutMs,
            }),
            options,
        );

        if (result.ok) {
            return await machineEncryption.decryptRaw(result.result) as R;
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

    async emitWithAck<T = any>(event: string, data: any, opts?: { timeoutMs?: number }): Promise<T> {
        if (!this.socket) {
            throw new Error('Socket not connected');
        }
        const timeoutMs = opts?.timeoutMs;
        if (typeof timeoutMs === 'number' && timeoutMs > 0) {
            return await this.socket.timeout(timeoutMs).emitWithAck(event, data) as T;
        }
        return await this.socket.emitWithAck(event, data) as T;
    }

    //
    // HTTP Requests
    //

    async request(path: string, options?: RequestInit): Promise<Response> {
        if (!this.config) {
            throw new Error('SyncSocket not initialized');
        }
        const snapshot = getActiveServerSnapshot();

        const credentials = await TokenStorage.getCredentialsForServerUrl(this.config.endpoint);
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
            ? `${snapshot.serverId ?? ''}:${method}:${url}:token:${credentials.token}`
            : null;

        let response: Response;
        if (requestKey) {
            const existing = this.inFlightHttpRequestsByKey.get(requestKey);
            if (existing) {
                response = await existing;
            } else {
                const promise = runtimeFetch(url, {
                    ...options,
                    headers,
                }) as Promise<Response>;
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
            response = await runtimeFetch(url, {
                ...options,
                headers,
            });
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

    private installSocketEventHandlers(socket: Socket) {
        socket.on('connect_error', (error) => {
            this.setError(error instanceof Error ? error : new Error(String(error)));
        });

        socket.on('error', (error) => {
            this.setError(error instanceof Error ? error : new Error(String(error)));
        });

        socket.onAny((event, data) => {
            // console.log(`📥 SyncSocket: Received event '${event}':`, JSON.stringify(data).substring(0, 200));
            const handler = this.messageHandlers.get(event);
            if (handler) {
                // console.log(`📥 SyncSocket: Calling handler for '${event}'`);
                handler(data);
            } else {
                // console.log(`📥 SyncSocket: No handler registered for '${event}'`);
            }
        });
    }

    private applyManagedConnectionState(state: ManagedConnectionState) {
        this.currentConnectionState = state;
        for (const listener of this.connectionStateListeners) {
            listener(state);
        }
        if (state.phase === 'offline') {
            this.pendingReconnectNotification =
                state.reason !== 'manual_disconnect'
                && state.reason !== 'intentional_shutdown';
        } else if (state.phase === 'idle' || state.phase === 'shutting_down') {
            this.pendingReconnectNotification = false;
        }
        switch (state.phase) {
            case 'connecting':
                this.updateStatus('connecting');
                return;
            case 'online':
                this.updateStatus('connected');
                return;
            case 'auth_failed':
                this.updateStatus('error');
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
}

//
// Singleton Export
//

export const apiSocket = new ApiSocket();

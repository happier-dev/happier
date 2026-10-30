import { createHappierSocket, createSocketTransportAdapter, createSocketRpcAbortError } from '@happier-dev/sync-client';
import { createRpcCallError, MACHINE_RPC_TIMEOUT_ERROR_CODE, readRpcErrorCode, type ScopedRpcSocketConnectionPhase } from '@happier-dev/protocol/rpcErrors';
import { armDeadlineTimer } from '@happier-dev/protocol/common/deadlineTimer';
import { isTerminalAuthError } from '@/sync/runtime/connectivity/authErrors';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    buildAccountStoredContentCompatibilitySocketAuthV1,
} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';

import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { drainRetainedHomeCarrierReleases } from '@/sync/runtime/homeCarrierPolicy';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
    resolveSocketIoTransportsForCarrier,
} from '@/sync/runtime/socketIoTransports';
import {
    startServerReachabilitySupervisor,
    acquireServerReachabilitySupervisor,
    subscribeServerReachabilityNetworkAllowed,
    waitForServerReachable,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';

import {
    DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS,
    type ScopedSocketClient,
    type ScopedSocketConnectParams,
} from './serverScopedRpcTypes';

type SocketLike = Readonly<{
    connected: boolean;
    // socket.io-client assigns `id` once the connection handshake completes; it is undefined
    // while disconnected and changes across reconnects. Surfaced via `getSocketId()` so per-tab
    // transports can target this exact connection.
    id?: string;
    connect: () => void;
    disconnect: () => void;
    on: (event: string, cb: (...args: any[]) => void) => void;
    off: (event: string, cb: (...args: any[]) => void) => void;
    emitWithAck: (event: string, payload: any) => Promise<unknown>;
    timeout: (ms: number) => { emitWithAck: (event: string, payload: any) => Promise<unknown> };
    emit: (event: string, payload: any) => void;
}>;

type ReachabilityDeps = Readonly<{
    acquireReachability?: (params: Readonly<{ serverUrl: string; runtimeOrigin: string; token: string; homeCarrier?: HomeCarrier | null; signal?: AbortSignal }>) => Promise<Readonly<{ release: () => Promise<void> }>>;
    startReachability: (params: Readonly<{ serverUrl: string; token: string }>) => Promise<void>;
    waitForReachable: (params: Readonly<{ serverUrl: string; token: string; timeoutMs?: number; signal?: AbortSignal; homeIdentityId?: string; homeCarrier?: HomeCarrier | null }>) => Promise<void>;
    subscribeNetworkAllowed: (listener: (allowed: boolean) => void) => () => void;
}>;

type Deps = Readonly<{
    createSocket: (params: Readonly<{
        serverUrl: string;
        token: string;
        carrier: 'https' | 'iroh';
        homeCarrier?: HomeCarrier | null;
    }>) => SocketLike;
    reachability: ReachabilityDeps;
    now: () => number;
    readIdleDisconnectMs: () => number;
}>;

export class ScopedRpcSocketConnectionTimeoutError extends Error {
    readonly code = MACHINE_RPC_TIMEOUT_ERROR_CODE;
    readonly rpcErrorCode = this.code;

    constructor(readonly connectionPhase: ScopedRpcSocketConnectionPhase) {
        super('Scoped RPC socket connection timeout');
    }
}

type PoolEntry = {
    key: string;
    serverUrl: string;
    reachabilityServerUrl: string;
    homeIdentityId: string | null;
    token: string;
    carrier: 'https' | 'iroh';
    homeCarrier: HomeCarrier | null;
    socket: SocketLike;
    transport: ReturnType<typeof createSocketTransportAdapter>;
    inUseCount: number;
    connectInFlight: { result: Promise<void>; controller: AbortController; waiters: number; progress: { phase: ScopedRpcSocketConnectionPhase } } | null;
    idleDisconnectTimer: ReturnType<typeof setTimeout> | null;
    reachabilityRelease: (() => Promise<void>) | null;
    /**
     * Custody of the transport lease {@link homeCarrier} is carried by. The pool owns
     * it for as long as this entry can reuse the carrier, so it is released only once
     * the socket built on it is gone — never when one logical client disconnects.
     */
    carrierRelease: (() => Promise<void>) | null;
    backgroundTask: boolean;
    teardownRequested: boolean;
    teardownInFlight: Promise<void> | null;
};

function normalizeServerUrl(raw: unknown): string {
    const input = String(raw ?? '').trim();
    const canonical = canonicalizeServerUrl(input);
    return (canonical || input).replace(/\/+$/, '');
}

function readScopedRpcSocketIdleDisconnectMsFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_SOCKET_IDLE_DISCONNECT_MS ?? '').trim();
    if (!raw) return 5_000;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 5_000;
    return parsed;
}

async function connectSocket(transport: ReturnType<typeof createSocketTransportAdapter>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    try {
        // The shared adapter settles both connect_error and an engine close
        // before namespace admission. The pool owns cancellation and deadlines.
        await transport.connect();
    } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw readRpcErrorCode(error) || isTerminalAuthError(error) ? error : Object.assign(createRpcCallError({
            error: error instanceof Error ? error.message : 'Scoped RPC socket connection failed',
            errorCode: 'MACHINE_RPC_UNREACHABLE',
        }), { cause: error });
    }
}

export function createServerScopedRpcSocketPool(overrides?: Partial<Deps>): Readonly<{
    acquire: (params: ScopedSocketConnectParams) => Promise<ScopedSocketClient>;
    stopAll: () => Promise<void>;
    resetForTests: () => void;
}> {
    const createSocket = (params: Parameters<Deps['createSocket']>[0]) => {
        if (overrides?.createSocket) {
            const socket = overrides.createSocket(params);
            return { socket, transport: createSocketTransportAdapter(socket) };
        }
        return createHappierSocket({
            endpoint: params.serverUrl,
            token: params.token,
            clientType: 'user-scoped',
            clientPurpose: 'scoped-rpc',
            authExtras: buildAccountStoredContentCompatibilitySocketAuthV1(
                CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
            ),
            transports: resolveSocketIoTransportsForCarrier(params.carrier),
            ...(params.homeCarrier ? { websocketFactory: params.homeCarrier.createWebSocket } : {}),
        });
    };
    const deps: Omit<Deps, 'createSocket'> = {
        reachability: overrides?.reachability ?? {
            acquireReachability: async (params) => await acquireServerReachabilitySupervisor({
                serverUrl: params.serverUrl,
                runtimeOrigin: params.runtimeOrigin,
                token: params.token,
                homeCarrier: params.homeCarrier ?? null,
                signal: params.signal,
            }),
            startReachability: async (params) => {
                await startServerReachabilitySupervisor({ serverUrl: params.serverUrl, token: params.token });
            },
            waitForReachable: async (params) => {
                await waitForServerReachable({
                    serverUrl: params.serverUrl,
                    token: params.token,
                    timeoutMs: params.timeoutMs,
                    signal: params.signal,
                    ...(params.homeIdentityId ? { homeIdentityId: params.homeIdentityId } : {}),
                    homeCarrier: params.homeCarrier ?? null,
                });
            },
            subscribeNetworkAllowed: subscribeServerReachabilityNetworkAllowed,
        },
        now: overrides?.now ?? (() => Date.now()),
        readIdleDisconnectMs: overrides?.readIdleDisconnectMs ?? readScopedRpcSocketIdleDisconnectMsFromEnv,
    };

    const entriesByKey = new Map<string, PoolEntry>();
    let detachNetworkAllowedListener: (() => void) | null = null;

    // The pool is private in-memory custody and already retains the token on each live entry.
    // Key directly by that credential so unrelated token churn cannot split one live socket.
    const buildKey = (serverUrl: string, token: string) => JSON.stringify([serverUrl, token]);

    // A replaced carrier is a replaced transport even when the URL is unchanged,
    // which is exactly the browser Iroh case: its URL is always the canonical
    // Home URL. Its proven EndpointId therefore belongs in the entry identity.
    //
    // Two acquisitions that agree on the EndpointId are equivalent transports to the
    // same Home, so sharing one entry is correct — and safe, because a live entry
    // still holds its own carrier's lease, so the one it kept can never be the
    // released half of a genuine replacement. The second acquisition is redundant,
    // not a successor, and is released rather than swapped in.
    const buildEntryKey = (
        serverUrl: string,
        reachabilityServerUrl: string,
        homeIdentityId: string | null,
        token: string,
        carrier: 'https' | 'iroh',
        homeCarrier: HomeCarrier | null,
    ) => `${buildKey(reachabilityServerUrl, token)}::${homeIdentityId ?? ''}::${serverUrl}::${carrier}::${homeCarrier?.endpointId ?? ''}`;

    const disconnectEntrySocket = async (entry: PoolEntry): Promise<void> => {
        try {
            await entry.transport.disconnect({ intentional: true });
        } catch {
            // Teardown still owns releasing reachability and carrier custody.
        }
    };

    const stopEntrySocket = (entry: PoolEntry, remove: boolean): Promise<void> => {
        entry.teardownRequested ||= remove;
        if (entry.teardownInFlight) return entry.teardownInFlight;

        const run = (async () => {
            if (entry.idleDisconnectTimer) {
                clearTimeout(entry.idleDisconnectTimer);
                entry.idleDisconnectTimer = null;
            }
            entry.connectInFlight?.controller.abort(createRpcCallError({
                error: 'Scoped RPC socket stopped before connecting',
                errorCode: 'MACHINE_RPC_UNREACHABLE',
            }));
            await disconnectEntrySocket(entry);
            if (entry.teardownRequested) await entry.transport.destroy();
            const releaseReachability = entry.reachabilityRelease;
            if (releaseReachability) {
                await releaseReachability();
                if (entry.reachabilityRelease === releaseReachability) {
                    entry.reachabilityRelease = null;
                }
            }
            // Only now is the carrier certainly unused by this socket. A failure here
            // keeps custody — and the entry — so a later teardown/stop can retry.
            const releaseCarrier = entry.carrierRelease;
            if (releaseCarrier) {
                await releaseCarrier();
                if (entry.carrierRelease === releaseCarrier) {
                    entry.carrierRelease = null;
                }
            }
            if (entry.teardownRequested && entriesByKey.get(entry.key) === entry) {
                entriesByKey.delete(entry.key);
            }
        })();
        let tracked!: Promise<void>;
        tracked = run.finally(() => {
            if (entry.teardownInFlight === tracked) {
                entry.teardownInFlight = null;
            }
        });
        entry.teardownInFlight = tracked;
        return tracked;
    };

    const scheduleIdleDisconnect = (entry: PoolEntry): void => {
        if (entry.inUseCount > 0) return;
        const idleMs = Math.max(0, deps.readIdleDisconnectMs());
        if (entry.idleDisconnectTimer) {
            clearTimeout(entry.idleDisconnectTimer);
            entry.idleDisconnectTimer = null;
        }
        if (idleMs === 0) {
            fireAndForget(stopEntrySocket(entry, true), { tag: 'scoped-rpc-idle-disconnect' });
            return;
        }
        entry.idleDisconnectTimer = setTimeout(() => {
            entry.idleDisconnectTimer = null;
            if (entry.inUseCount > 0) return;
            fireAndForget(stopEntrySocket(entry, true), { tag: 'scoped-rpc-idle-disconnect' });
        }, idleMs);
    };

    const retainEntryUse = (entry: PoolEntry): void => {
        entry.inUseCount += 1;
        if (entry.idleDisconnectTimer) {
            clearTimeout(entry.idleDisconnectTimer);
            entry.idleDisconnectTimer = null;
        }
    };

    const releaseEntryUse = (entry: PoolEntry): void => {
        entry.inUseCount = Math.max(0, entry.inUseCount - 1);
        if (entry.inUseCount > 0 || entry.teardownRequested) return;
        if (entry.backgroundTask) {
            fireAndForget(stopEntrySocket(entry, true), { tag: 'scoped-rpc-background-disconnect' });
        } else {
            scheduleIdleDisconnect(entry);
        }
    };

    const createEntry = (
        serverUrl: string,
        reachabilityServerUrl: string,
        homeIdentityId: string | null,
        token: string,
        carrier: 'https' | 'iroh',
        homeCarrier: HomeCarrier | null,
        carrierRelease: (() => Promise<void>) | null,
        backgroundTask = false,
    ): PoolEntry => {
        const key = buildEntryKey(serverUrl, reachabilityServerUrl, homeIdentityId, token, carrier, homeCarrier);
        const { socket, transport } = createSocket({ serverUrl, token, carrier, homeCarrier });
        const entry: PoolEntry = {
            key,
            serverUrl,
            reachabilityServerUrl,
            homeIdentityId,
            token,
            carrier,
            homeCarrier,
            socket,
            transport,
            inUseCount: 0,
            connectInFlight: null,
            idleDisconnectTimer: null,
            reachabilityRelease: null,
            carrierRelease,
            backgroundTask,
            teardownRequested: false,
            teardownInFlight: null,
        };

        if (!backgroundTask) entriesByKey.set(key, entry);
        return entry;
    };

    const ensureConnected = async (entry: PoolEntry, deadlineAt: number, callerSignal?: AbortSignal): Promise<void> => {
        if (deadlineAt <= deps.now()) throw new ScopedRpcSocketConnectionTimeoutError('reachability-start');
        if (entry.socket.connected) return;
        if (!entry.connectInFlight) {
            const controller = new AbortController();
            const progress: { phase: ScopedRpcSocketConnectionPhase } = { phase: 'reachability-start' };
            const run = (async () => {
                if (!entry.backgroundTask) {
                    if (!entry.reachabilityRelease && deps.reachability.acquireReachability) {
                        const lease = await deps.reachability.acquireReachability({
                            serverUrl: entry.reachabilityServerUrl,
                            runtimeOrigin: entry.serverUrl,
                            token: entry.token,
                            homeCarrier: entry.homeCarrier,
                            signal: controller.signal,
                        });
                        if (controller.signal.aborted) {
                            await lease.release();
                            throw controller.signal.reason;
                        }
                        entry.reachabilityRelease = lease.release;
                    } else if (!entry.reachabilityRelease) {
                        await deps.reachability.startReachability({ serverUrl: entry.reachabilityServerUrl, token: entry.token });
                    }
                    if (controller.signal.aborted) throw controller.signal.reason;
                    progress.phase = 'reachability-wait';
                    await deps.reachability.waitForReachable({
                        serverUrl: entry.reachabilityServerUrl,
                        token: entry.token,
                        signal: controller.signal,
                        ...(entry.homeIdentityId ? { homeIdentityId: entry.homeIdentityId } : {}),
                        homeCarrier: entry.homeCarrier,
                    });
                }
                if (controller.signal.aborted) throw controller.signal.reason;
                progress.phase = 'socket-connect';
                await connectSocket(entry.transport, controller.signal);
            })();
            const result = run.finally(() => {
                if (entry.connectInFlight !== flight) return;
                entry.connectInFlight = null;
            });
            const flight = { result, controller, waiters: 0, progress };
            entry.connectInFlight = flight;
        }
        // Dialing belongs to the retained entry. One logical waiter's expiry
        // cannot shorten another waiter's budget or disconnect their transport.
        const connection = entry.connectInFlight;
        connection.waiters += 1;
        const signal = connection.controller.signal;
        try {
            await new Promise<void>((resolve, reject) => {
                let settled = false;
                const settle = (error?: unknown) => {
                    if (settled) return;
                    settled = true;
                    cancelTimer();
                    signal.removeEventListener('abort', onAbort);
                    callerSignal?.removeEventListener('abort', onCallerAbort);
                    if (error !== undefined) reject(error);
                    else resolve();
                };
                const onAbort = () => settle(signal.reason);
                const onCallerAbort = () => settle(createSocketRpcAbortError());
                const cancelTimer = armDeadlineTimer(Date.now() + Math.max(0, deadlineAt - deps.now()),
                    () => settle(new ScopedRpcSocketConnectionTimeoutError(connection.progress.phase)));
                signal.addEventListener('abort', onAbort, { once: true });
                callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
                if (signal.aborted) onAbort();
                if (callerSignal?.aborted) onCallerAbort();
                void connection.result.then(() => settle(), (error: unknown) => settle(error));
            });
        } finally {
            connection.waiters -= 1;
            if (entry.connectInFlight === connection && connection.waiters === 0 && !entry.socket.connected) {
                // No caller still owns a dial budget. A retained stream may keep
                // the entry alive, but must not retain a stalled handshake for
                // every later RPC. Reset through this same pool connection owner;
                // keep the carrier and logical holders for the next acquisition.
                entry.connectInFlight = null;
                connection.controller.abort(new ScopedRpcSocketConnectionTimeoutError(connection.progress.phase));
                await disconnectEntrySocket(entry);
            }
        }
    };

    const acquire = async (params: ScopedSocketConnectParams): Promise<ScopedSocketClient> => {
        let carrierRelease = params.releaseCarrier ?? null;
        let entryRetainsCarrierRelease = false;
        try {
            return await acquireWithCarrierCustody(
                params,
                (takenCarrierRelease) => {
                    carrierRelease = takenCarrierRelease;
                },
                () => {
                    entryRetainsCarrierRelease = true;
                },
            );
        } catch (error) {
            // No entry retains this lease, so settle the canonical owned release
            // here. Its Lane 06 owner retains a rejection for `stopAll` to drain;
            // the acquire failure remains the error the caller observes.
            if (carrierRelease && !entryRetainsCarrierRelease) {
                await carrierRelease().catch((releaseError: unknown) => {
                    console.error('[scoped-rpc] carrier release failed after acquire failure', releaseError);
                });
            }
            throw error;
        }
    };

    const acquireWithCarrierCustody = async (
        params: ScopedSocketConnectParams,
        onCarrierReleaseTaken: (releaseCarrier: (() => Promise<void>) | null) => void,
        onEntryRetainsCarrierRelease: () => void,
    ): Promise<ScopedSocketClient> => {
        if (params.signal?.aborted) throw createSocketRpcAbortError();
        const backgroundTask = params.networkMode === 'background-task';
        const serverUrl = normalizeServerUrl(params.serverUrl);
        const reachabilityServerUrl = normalizeServerUrl(params.reachabilityServerUrl ?? params.serverUrl);
        const token = String(params.token ?? '');
        const carrier = params.carrier === 'iroh' ? 'iroh' : 'https';
        const homeCarrier = params.homeCarrier ?? null;
        const releaseCarrier = params.releaseCarrier ?? null;
        const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS;
        const deadlineAt = deps.now() + timeoutMs;
        if (!serverUrl) {
            throw new Error('Missing server URL');
        }
        if (!token) {
            throw new Error('Missing token');
        }

        const key = buildEntryKey(serverUrl, reachabilityServerUrl, params.homeIdentityId ?? null, token, carrier, homeCarrier);
        let entry = backgroundTask ? undefined : entriesByKey.get(key);
        while (entry?.teardownRequested) {
            // A retiring socket cannot be revived: join (or retry) its canonical teardown,
            // then resolve the key again in case another waiter already installed its successor.
            await stopEntrySocket(entry, true);
            entry = entriesByKey.get(key);
        }
        // This caller acquired its own carrier before it could know an equivalent one
        // was already retained. The retained carrier keeps serving the live socket;
        // only the redundant acquisition is released.
        const redundantCarrierRelease = entry && releaseCarrier && releaseCarrier !== entry.carrierRelease
            ? releaseCarrier
            : null;
        if (!entry) {
            const takenCarrierRelease = releaseCarrier ?? params.takeCarrierRelease?.() ?? null;
            onCarrierReleaseTaken(takenCarrierRelease);
            entry = createEntry(
                serverUrl,
                reachabilityServerUrl,
                params.homeIdentityId ?? null,
                token,
                carrier,
                homeCarrier,
                takenCarrierRelease,
                backgroundTask,
            );
            onEntryRetainsCarrierRelease();
        }
        // Reserve this entry before anything below can await: an idle teardown that
        // ran in between would otherwise remove the entry this client is acquiring.
        retainEntryUse(entry);
        if (redundantCarrierRelease) {
            // Settled before this call returns, so no carrier release outlives the
            // acquire that started it. A failure is not this acquisition's failure;
            // the canonical Lane 06 owner retains it for the next explicit drain.
            await redundantCarrierRelease().catch((releaseError: unknown) => {
                console.error('[scoped-rpc] redundant carrier release failed', releaseError);
            });
        }

        let released = false;
        const releaseOnce = () => {
            if (released) return;
            released = true;
            params.signal?.removeEventListener('abort', releaseOnce);
            releaseEntryUse(entry);
        };

        params.signal?.addEventListener('abort', releaseOnce, { once: true });
        try {
            await ensureConnected(entry, deadlineAt, params.signal);
            if (params.signal?.aborted) throw createSocketRpcAbortError();
        } catch (error) {
            releaseOnce();
            if (params.signal?.aborted) throw createSocketRpcAbortError();
            throw error;
        }

        return {
            get connected() { return entry.socket.connected; },
            retain: () => {
                retainEntryUse(entry);
                return () => releaseEntryUse(entry);
            },
            emitWithAck: (...args: Parameters<SocketLike['emitWithAck']>) => entry.socket.emitWithAck(...args),
            timeout: (ms: number) => entry.socket.timeout(ms),
            emit: (event: string, payload: any) => entry.socket.emit(event, payload),
            on: (event: string, listener: (...args: any[]) => void) => entry.socket.on(event, listener),
            off: (event: string, listener: (...args: any[]) => void) => entry.socket.off(event, listener),
            getSocketId: () => entry.socket.id ?? '',
            disconnect: () => releaseOnce(),
        };
    };

    const stopAll = async (): Promise<void> => {
        const entries = Array.from(entriesByKey.values());
        await Promise.all([
            ...entries.map(async (entry) => {
                entry.inUseCount = 0;
                await stopEntrySocket(entry, true);
            }),
            drainRetainedHomeCarrierReleases(),
        ]);
    };

    const resetForTests = () => {
        detachNetworkAllowedListener?.();
        detachNetworkAllowedListener = null;
        for (const entry of entriesByKey.values()) {
            if (entry.idleDisconnectTimer) clearTimeout(entry.idleDisconnectTimer);
        }
        entriesByKey.clear();
    };

    detachNetworkAllowedListener = deps.reachability.subscribeNetworkAllowed((allowed) => {
        if (allowed) return;
        fireAndForget(stopAll(), { tag: 'scoped-rpc-network-disconnect' });
    });

    return { acquire, stopAll, resetForTests };
}

export const serverScopedRpcSocketPool = createServerScopedRpcSocketPool();

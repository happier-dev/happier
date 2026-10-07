import { createHappierSocket } from '@happier-dev/sync-client';
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
    reportServerUnreachable,
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
    acquireReachability?: (params: Readonly<{ serverUrl: string; runtimeOrigin: string; token: string; homeCarrier?: HomeCarrier | null }>) => Promise<Readonly<{ release: () => Promise<void> }>>;
    startReachability: (params: Readonly<{ serverUrl: string; token: string }>) => Promise<void>;
    waitForReachable: (params: Readonly<{ serverUrl: string; token: string; timeoutMs: number; homeIdentityId?: string; homeCarrier?: HomeCarrier | null }>) => Promise<void>;
    reportUnreachable: (serverUrl: string, error: unknown, token: string) => void;
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

type PoolEntry = {
    key: string;
    serverUrl: string;
    reachabilityServerUrl: string;
    homeIdentityId: string | null;
    token: string;
    carrier: 'https' | 'iroh';
    homeCarrier: HomeCarrier | null;
    socket: SocketLike;
    inUseCount: number;
    connectInFlight: Promise<void> | null;
    intentionalDisconnect: boolean;
    idleDisconnectTimer: ReturnType<typeof setTimeout> | null;
    reachabilityRelease: (() => Promise<void>) | null;
    /**
     * Custody of the transport lease {@link homeCarrier} is carried by. The pool owns
     * it for as long as this entry can reuse the carrier, so it is released only once
     * the socket built on it is gone — never when one logical client disconnects.
     */
    carrierRelease: (() => Promise<void>) | null;
    teardownRequested: boolean;
    teardownInFlight: Promise<void> | null;
};

const INTENTIONAL_DISCONNECT_FLAG_RESET_MS = 1_000;

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

async function connectSocketWithTimeout(socket: SocketLike, timeoutMs: number): Promise<void> {
    if (socket.connected) return;
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeoutId = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error('Scoped RPC socket connection timeout'));
        }, Math.max(1, timeoutMs));

        const cleanup = () => {
            clearTimeout(timeoutId);
            socket.off('connect', onConnect);
            socket.off('connect_error', onConnectError);
        };

        const onConnect = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
        };

        const onConnectError = (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error instanceof Error ? error : new Error('Scoped RPC socket connection failed'));
        };

        socket.on('connect', onConnect);
        socket.on('connect_error', onConnectError);
        try {
            socket.connect();
        } catch (error) {
            onConnectError(error);
        }
    });
}

export function createServerScopedRpcSocketPool(overrides?: Partial<Deps>): Readonly<{
    acquire: (params: ScopedSocketConnectParams) => Promise<ScopedSocketClient>;
    stopAll: () => Promise<void>;
    resetForTests: () => void;
}> {
    const deps: Deps = {
        createSocket: overrides?.createSocket ?? ((params) => {
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
            }).socket;
        }),
        reachability: overrides?.reachability ?? {
            acquireReachability: async (params) => await acquireServerReachabilitySupervisor({
                serverUrl: params.serverUrl,
                runtimeOrigin: params.runtimeOrigin,
                token: params.token,
                homeCarrier: params.homeCarrier ?? null,
            }),
            startReachability: async (params) => {
                await startServerReachabilitySupervisor({ serverUrl: params.serverUrl, token: params.token });
            },
            waitForReachable: async (params) => {
                await waitForServerReachable({
                    serverUrl: params.serverUrl,
                    token: params.token,
                    timeoutMs: params.timeoutMs,
                    ...(params.homeIdentityId ? { homeIdentityId: params.homeIdentityId } : {}),
                    homeCarrier: params.homeCarrier ?? null,
                });
            },
            reportUnreachable: (serverUrl, error, token) => reportServerUnreachable(serverUrl, error, token),
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

    const stopEntrySocket = (entry: PoolEntry, remove: boolean): Promise<void> => {
        entry.teardownRequested ||= remove;
        if (entry.teardownInFlight) return entry.teardownInFlight;

        const run = (async () => {
            if (entry.idleDisconnectTimer) {
                clearTimeout(entry.idleDisconnectTimer);
                entry.idleDisconnectTimer = null;
            }
            entry.intentionalDisconnect = true;
            try {
                entry.socket.disconnect();
            } catch {
                // ignore
            }
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
            // socket.io-client disconnect events are not guaranteed to be synchronous; keep the
            // intentional disconnect flag set briefly so we don't report an expected disconnect
            // as an unreachable server signal.
            setTimeout(() => {
                entry.intentionalDisconnect = false;
            }, INTENTIONAL_DISCONNECT_FLAG_RESET_MS);
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

    const createEntry = (
        serverUrl: string,
        reachabilityServerUrl: string,
        homeIdentityId: string | null,
        token: string,
        carrier: 'https' | 'iroh',
        homeCarrier: HomeCarrier | null,
        carrierRelease: (() => Promise<void>) | null,
    ): PoolEntry => {
        const key = buildEntryKey(serverUrl, reachabilityServerUrl, homeIdentityId, token, carrier, homeCarrier);
        const socket = deps.createSocket({ serverUrl, token, carrier, homeCarrier });
        const entry: PoolEntry = {
            key,
            serverUrl,
            reachabilityServerUrl,
            homeIdentityId,
            token,
            carrier,
            homeCarrier,
            socket,
            inUseCount: 0,
            connectInFlight: null,
            intentionalDisconnect: false,
            idleDisconnectTimer: null,
            reachabilityRelease: null,
            carrierRelease,
            teardownRequested: false,
            teardownInFlight: null,
        };

        socket.on('disconnect', (reason: unknown) => {
            if (entry.intentionalDisconnect) {
                entry.intentionalDisconnect = false;
                return;
            }
            deps.reachability.reportUnreachable(reachabilityServerUrl, new Error(typeof reason === 'string' ? reason : 'socket disconnect'), token);
        });
        socket.on('connect_error', (error: unknown) => {
            deps.reachability.reportUnreachable(reachabilityServerUrl, error, token);
        });
        socket.on('error', (error: unknown) => {
            deps.reachability.reportUnreachable(reachabilityServerUrl, error, token);
        });

        entriesByKey.set(key, entry);
        return entry;
    };

    const ensureConnected = async (entry: PoolEntry, timeoutMs: number): Promise<void> => {
        if (entry.socket.connected) return;
        if (entry.connectInFlight) {
            await entry.connectInFlight;
            return;
        }
        const run = (async () => {
            if (!entry.reachabilityRelease && deps.reachability.acquireReachability) {
                const lease = await deps.reachability.acquireReachability({
                    serverUrl: entry.reachabilityServerUrl,
                    runtimeOrigin: entry.serverUrl,
                    token: entry.token,
                    homeCarrier: entry.homeCarrier,
                });
                entry.reachabilityRelease = lease.release;
            } else if (!entry.reachabilityRelease) {
                await deps.reachability.startReachability({ serverUrl: entry.reachabilityServerUrl, token: entry.token });
            }
            await deps.reachability.waitForReachable({
                serverUrl: entry.reachabilityServerUrl,
                token: entry.token,
                timeoutMs,
                ...(entry.homeIdentityId ? { homeIdentityId: entry.homeIdentityId } : {}),
                homeCarrier: entry.homeCarrier,
            });
            await connectSocketWithTimeout(entry.socket, timeoutMs);
        })();
        entry.connectInFlight = run;
        try {
            await run;
        } finally {
            if (entry.connectInFlight === run) {
                entry.connectInFlight = null;
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
        const serverUrl = normalizeServerUrl(params.serverUrl);
        const reachabilityServerUrl = normalizeServerUrl(params.reachabilityServerUrl ?? params.serverUrl);
        const token = String(params.token ?? '');
        const carrier = params.carrier === 'iroh' ? 'iroh' : 'https';
        const homeCarrier = params.homeCarrier ?? null;
        const releaseCarrier = params.releaseCarrier ?? null;
        const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS;
        if (!serverUrl) {
            throw new Error('Missing server URL');
        }
        if (!token) {
            throw new Error('Missing token');
        }

        const key = buildEntryKey(serverUrl, reachabilityServerUrl, params.homeIdentityId ?? null, token, carrier, homeCarrier);
        let entry = entriesByKey.get(key);
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
            );
            onEntryRetainsCarrierRelease();
        }
        // Reserve this entry before anything below can await: an idle teardown that
        // ran in between would otherwise remove the entry this client is acquiring.
        entry.inUseCount += 1;
        if (entry.idleDisconnectTimer) {
            clearTimeout(entry.idleDisconnectTimer);
            entry.idleDisconnectTimer = null;
        }
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
            entry.inUseCount = Math.max(0, entry.inUseCount - 1);
            scheduleIdleDisconnect(entry);
        };

        try {
            await ensureConnected(entry, timeoutMs);
        } catch (error) {
            releaseOnce();
            throw error;
        }

        return {
            emitWithAck: (event: string, payload: any) => entry.socket.emitWithAck(event, payload),
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

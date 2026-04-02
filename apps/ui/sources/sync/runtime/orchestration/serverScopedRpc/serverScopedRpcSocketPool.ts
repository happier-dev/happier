import { io } from 'socket.io-client';

import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import { resolveSocketIoTransports } from '@/sync/runtime/socketIoTransports';
import {
    reportServerUnreachable,
    startServerReachabilitySupervisor,
    subscribeServerReachabilityNetworkAllowed,
    waitForServerReachable,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';

import type { ScopedSocketClient, ScopedSocketConnectParams } from './serverScopedRpcTypes';

type SocketLike = Readonly<{
    connected: boolean;
    connect: () => void;
    disconnect: () => void;
    on: (event: string, cb: (...args: any[]) => void) => void;
    off: (event: string, cb: (...args: any[]) => void) => void;
    timeout: (ms: number) => { emitWithAck: (event: string, payload: any) => Promise<unknown> };
    emit: (event: string, payload: any) => void;
}>;

type ReachabilityDeps = Readonly<{
    startReachability: (params: Readonly<{ serverUrl: string; token: string }>) => Promise<void>;
    waitForReachable: (params: Readonly<{ serverUrl: string; token: string; timeoutMs: number }>) => Promise<void>;
    reportUnreachable: (serverUrl: string, error: unknown) => void;
    subscribeNetworkAllowed: (listener: (allowed: boolean) => void) => () => void;
}>;

type Deps = Readonly<{
    createSocket: (params: Readonly<{ serverUrl: string; token: string }>) => SocketLike;
    reachability: ReachabilityDeps;
    now: () => number;
    readIdleDisconnectMs: () => number;
}>;

type PoolEntry = {
    serverUrl: string;
    token: string;
    socket: SocketLike;
    inUseCount: number;
    connectInFlight: Promise<void> | null;
    intentionalDisconnect: boolean;
    idleDisconnectTimer: ReturnType<typeof setTimeout> | null;
};

const INTENTIONAL_DISCONNECT_FLAG_RESET_MS = 1_000;

const GLOBAL_TOKEN_CACHE_KEY_BY_TOKEN_KEY = '__HAPPIER_GLOBAL_SCOPED_RPC_TOKEN_CACHE_KEY_BY_TOKEN__';
const GLOBAL_TOKEN_CACHE_KEY_MAX_ENTRIES = 512;

function getGlobalTokenCacheHost(): Record<string, unknown> {
    const g = globalThis as unknown as Record<string, unknown>;
    const p = typeof process !== 'undefined' ? (process as unknown) : null;
    if (p && typeof p === 'object') return p as Record<string, unknown>;
    const gp = g.process;
    if (gp && typeof gp === 'object') return gp as Record<string, unknown>;
    return g;
}

function getGlobalTokenCacheKeyByToken(): Map<string, string> {
    const host = getGlobalTokenCacheHost();
    const existing = host[GLOBAL_TOKEN_CACHE_KEY_BY_TOKEN_KEY];
    if (existing && Object.prototype.toString.call(existing) === '[object Map]') {
        return existing as Map<string, string>;
    }
    const created = new Map<string, string>();
    host[GLOBAL_TOKEN_CACHE_KEY_BY_TOKEN_KEY] = created;
    return created;
}

function getOrCreateTokenCacheKey(token: string): string {
    const tokenCacheKeyByToken = getGlobalTokenCacheKeyByToken();
    let key = tokenCacheKeyByToken.get(token);
    if (key) {
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
            const transports = resolveSocketIoTransports();
            return io(params.serverUrl, {
                path: '/v1/updates/',
                auth: {
                    token: params.token,
                    clientType: 'user-scoped' as const,
                    clientPurpose: 'scoped-rpc' as const,
                },
                forceNew: true,
                ...(transports ? { transports } : null),
                reconnection: false,
                withCredentials: false,
                autoConnect: false,
            }) as unknown as SocketLike;
        }),
        reachability: overrides?.reachability ?? {
            startReachability: async (params) => {
                await startServerReachabilitySupervisor({ serverUrl: params.serverUrl, token: params.token });
            },
            waitForReachable: async (params) => {
                await waitForServerReachable({
                    serverUrl: params.serverUrl,
                    token: params.token,
                    timeoutMs: params.timeoutMs,
                });
            },
            reportUnreachable: reportServerUnreachable,
            subscribeNetworkAllowed: subscribeServerReachabilityNetworkAllowed,
        },
        now: overrides?.now ?? (() => Date.now()),
        readIdleDisconnectMs: overrides?.readIdleDisconnectMs ?? readScopedRpcSocketIdleDisconnectMsFromEnv,
    };

    const entriesByKey = new Map<string, PoolEntry>();
    let detachNetworkAllowedListener: (() => void) | null = null;

    const buildKey = (serverUrl: string, token: string) => `${serverUrl}::${getOrCreateTokenCacheKey(token)}`;

    const stopEntrySocket = async (entry: PoolEntry): Promise<void> => {
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
        // socket.io-client disconnect events are not guaranteed to be synchronous; keep the
        // intentional disconnect flag set briefly so we don't report an expected disconnect
        // as an unreachable server signal.
        setTimeout(() => {
            entry.intentionalDisconnect = false;
        }, INTENTIONAL_DISCONNECT_FLAG_RESET_MS);
    };

    const scheduleIdleDisconnect = (entry: PoolEntry): void => {
        if (entry.inUseCount > 0) return;
        const idleMs = Math.max(0, deps.readIdleDisconnectMs());
        if (entry.idleDisconnectTimer) {
            clearTimeout(entry.idleDisconnectTimer);
            entry.idleDisconnectTimer = null;
        }
        if (idleMs === 0) {
            void stopEntrySocket(entry);
            return;
        }
        entry.idleDisconnectTimer = setTimeout(() => {
            entry.idleDisconnectTimer = null;
            if (entry.inUseCount > 0) return;
            void stopEntrySocket(entry);
        }, idleMs);
    };

    const getOrCreateEntry = (serverUrl: string, token: string): PoolEntry => {
        const key = buildKey(serverUrl, token);
        const existing = entriesByKey.get(key);
        if (existing) return existing;

        const socket = deps.createSocket({ serverUrl, token });
        const entry: PoolEntry = {
            serverUrl,
            token,
            socket,
            inUseCount: 0,
            connectInFlight: null,
            intentionalDisconnect: false,
            idleDisconnectTimer: null,
        };

        socket.on('disconnect', (reason: unknown) => {
            if (entry.intentionalDisconnect) {
                entry.intentionalDisconnect = false;
                return;
            }
            deps.reachability.reportUnreachable(serverUrl, new Error(typeof reason === 'string' ? reason : 'socket disconnect'));
        });
        socket.on('connect_error', (error: unknown) => {
            deps.reachability.reportUnreachable(serverUrl, error);
        });
        socket.on('error', (error: unknown) => {
            deps.reachability.reportUnreachable(serverUrl, error);
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
            await deps.reachability.startReachability({ serverUrl: entry.serverUrl, token: entry.token });
            await deps.reachability.waitForReachable({ serverUrl: entry.serverUrl, token: entry.token, timeoutMs });
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
        const serverUrl = normalizeServerUrl(params.serverUrl);
        const token = String(params.token ?? '');
        const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 30_000;
        if (!serverUrl) {
            throw new Error('Missing server URL');
        }
        if (!token) {
            throw new Error('Missing token');
        }

        const entry = getOrCreateEntry(serverUrl, token);
        entry.inUseCount += 1;
        if (entry.idleDisconnectTimer) {
            clearTimeout(entry.idleDisconnectTimer);
            entry.idleDisconnectTimer = null;
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
            timeout: (ms: number) => entry.socket.timeout(ms),
            emit: (event: string, payload: any) => entry.socket.emit(event, payload),
            disconnect: () => releaseOnce(),
        };
    };

    const stopAll = async (): Promise<void> => {
        const entries = Array.from(entriesByKey.values());
        await Promise.allSettled(entries.map(async (entry) => {
            entry.inUseCount = 0;
            await stopEntrySocket(entry);
        }));
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
        void stopAll();
    });

    return { acquire, stopAll, resetForTests };
}

export const serverScopedRpcSocketPool = createServerScopedRpcSocketPool();

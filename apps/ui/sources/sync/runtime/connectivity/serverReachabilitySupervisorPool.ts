import {
    createManagedConnectionSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ManagedConnectionState,
    type ManagedConnectionSupervisor,
    type ManagedConnectionTransport,
    type ReadinessProbeResult,
    type TransportDisconnectEvent,
} from '@happier-dev/connection-supervisor';

import { probeAuthenticatedServerAuthPingEndpoint } from '@/sync/api/capabilities/probeAuthenticatedServerAuthPingEndpoint';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import { runtimeFetch } from '@/utils/system/runtimeFetch';

import { readServerReachabilityBackgroundRetryMs, readServerReachabilityProbeTimeoutMs } from './serverReachabilityTuning';

export class ServerReachabilityWaitTimeoutError extends Error {
    constructor() {
        super('Timed out waiting for server reachability');
        this.name = 'ServerReachabilityWaitTimeoutError';
    }
}

let networkAllowed = true;
const networkAllowedListeners = new Set<(allowed: boolean) => void>();

export function setServerReachabilityNetworkAllowed(next: boolean): void {
    const allowed = next === true;
    if (allowed === networkAllowed) return;
    networkAllowed = allowed;
    networkAllowedListeners.forEach((listener) => listener(allowed));
}

export function isServerReachabilityNetworkAllowed(): boolean {
    return networkAllowed;
}

export function subscribeServerReachabilityNetworkAllowed(listener: (allowed: boolean) => void): () => void {
    networkAllowedListeners.add(listener);
    listener(networkAllowed);
    return () => networkAllowedListeners.delete(listener);
}

type TransportController = Readonly<{
    transport: ManagedConnectionTransport;
    emitDisconnect: (event: TransportDisconnectEvent) => void;
}>;

function createExternallyDisconnectableTransport(): TransportController {
    const connectedListeners = new Set<() => void>();
    const disconnectedListeners = new Set<(event: TransportDisconnectEvent) => void>();
    const errorListeners = new Set<(error: unknown) => void>();
    let connected = false;

    return {
        transport: {
            async connect() {
                connected = true;
                connectedListeners.forEach((listener) => listener());
            },
            async disconnect(params?: { intentional?: boolean }) {
                connected = false;
                disconnectedListeners.forEach((listener) =>
                    listener({
                        intentional: params?.intentional === true,
                        reason: params?.intentional === true ? 'manual' : 'disconnect',
                    }),
                );
            },
            async destroy() {
                connected = false;
                connectedListeners.clear();
                disconnectedListeners.clear();
                errorListeners.clear();
            },
            isConnected() {
                return connected;
            },
            onConnected(listener) {
                connectedListeners.add(listener);
                return () => connectedListeners.delete(listener);
            },
            onDisconnected(listener) {
                disconnectedListeners.add(listener);
                return () => disconnectedListeners.delete(listener);
            },
            onError(listener) {
                errorListeners.add(listener);
                return () => errorListeners.delete(listener);
            },
        },
        emitDisconnect(event) {
            connected = false;
            disconnectedListeners.forEach((listener) => listener(event));
        },
    };
}

function parseRetryAfterMs(headers: Headers): number | undefined {
    const raw = headers.get('Retry-After') ?? headers.get('retry-after');
    if (!raw) return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const seconds = Number.parseInt(trimmed, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
        return seconds * 1000;
    }
    const timestamp = Date.parse(trimmed);
    if (Number.isFinite(timestamp)) {
        const deltaMs = timestamp - Date.now();
        if (deltaMs > 0) return deltaMs;
    }
    return undefined;
}

async function runtimeFetchWithTimeout(
    input: RequestInfo | URL,
    init: RequestInit,
    timeoutMs: number,
): Promise<Response> {
    if (typeof AbortController !== 'function') {
        return await runtimeFetch(input, init);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, Math.max(0, timeoutMs));

    try {
        return await runtimeFetch(input, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

async function probeServerReadiness(params: Readonly<{ endpoint: string; token: string | null }>): Promise<ReadinessProbeResult> {
    const endpoint = params.endpoint.replace(/\/+$/, '');
    if (!networkAllowed) {
        return {
            status: 'retry_later',
            retryAfterMs: readServerReachabilityBackgroundRetryMs(),
            errorMessage: 'Network disabled while app is backgrounded',
        };
    }
    try {
        const healthResponse = await runtimeFetchWithTimeout(
            `${endpoint}/health`,
            {
                method: 'GET',
                headers: { Accept: 'application/json' },
            },
            readServerReachabilityProbeTimeoutMs(),
        );
        if (healthResponse.status === 429) {
            return {
                status: 'retry_later',
                retryAfterMs: parseRetryAfterMs(healthResponse.headers),
                errorMessage: `Health check returned ${healthResponse.status}`,
            };
        }
        if (healthResponse.status >= 500) {
            return {
                status: 'retry_later',
                errorMessage: `Health check returned ${healthResponse.status}`,
            };
        }
        if (!healthResponse.ok) {
            return {
                status: 'server_unreachable',
                errorMessage: `Health check returned ${healthResponse.status}`,
            };
        }
    } catch (error) {
        return {
            status: 'server_unreachable',
            errorMessage: error instanceof Error ? error.message : String(error),
        };
    }

    if (!params.token) {
        return { status: 'ready' };
    }

    if (typeof AbortController !== 'function') {
        return await probeAuthenticatedServerAuthPingEndpoint({ endpoint, token: params.token });
    }

    const controller = new AbortController();
    const timeoutMs = readServerReachabilityProbeTimeoutMs();
    const timeout = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
    try {
        return await probeAuthenticatedServerAuthPingEndpoint({
            endpoint,
            token: params.token,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}

type ReachabilitySupervisorEntry = {
    serverUrl: string;
    token: string | null;
    state: ManagedConnectionState;
    supervisor: ManagedConnectionSupervisor;
    currentTransportController: TransportController | null;
    subscribers: Set<(state: ManagedConnectionState) => void>;
    invalidateInFlight: Promise<void> | null;
    lastInvalidateAt: number;
};

const entriesByServerUrl = new Map<string, ReachabilitySupervisorEntry>();

let didInstallOnlineListener = false;

function ensureOnlineListenerInstalled(): void {
    if (didInstallOnlineListener) return;
    const w = (globalThis as unknown as { window?: unknown }).window;
    if (!w || typeof (w as any).addEventListener !== 'function') return;
    didInstallOnlineListener = true;
    (w as any).addEventListener('online', () => {
        void invalidateAllServerReachabilitySupervisors();
    });
}

function getOrCreateEntry(serverUrlRaw: string): ReachabilitySupervisorEntry {
    const serverUrl = canonicalizeServerUrl(String(serverUrlRaw ?? ''));
    if (!serverUrl) {
        throw new Error('Missing server URL');
    }
    ensureOnlineListenerInstalled();
    const existing = entriesByServerUrl.get(serverUrl);
    if (existing) return existing;

    const subscribers = new Set<(state: ManagedConnectionState) => void>();
    const entry: ReachabilitySupervisorEntry = {
        serverUrl,
        token: null,
        state: {
            phase: 'idle',
            reason: null,
            attempt: 0,
            nextRetryAt: null,
            lastConnectedAt: null,
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        },
        supervisor: createManagedConnectionSupervisor({
        ...DEFAULT_MANAGED_CONNECTION_POLICY,
        probeBeforeInitialConnect: true,
        createTransport: () => {
            const controller = createExternallyDisconnectableTransport();
            entry.currentTransportController = controller;
            return controller.transport;
        },
        probeReadiness: async () => probeServerReadiness({ endpoint: entry.serverUrl, token: entry.token }),
        onStateChange: (state) => {
            entry.state = state;
            subscribers.forEach((listener) => listener(state));
        },
        }),
        currentTransportController: null,
        subscribers,
        invalidateInFlight: null,
        lastInvalidateAt: Number.NEGATIVE_INFINITY,
    };

    entriesByServerUrl.set(serverUrl, entry);
    return entry;
}

function waitForState(params: Readonly<{
    entry: ReachabilitySupervisorEntry;
    predicate: (state: ManagedConnectionState) => boolean;
    signal?: AbortSignal;
    timeoutMs: number;
}>): Promise<void> {
    if (params.predicate(params.entry.state)) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
        const createAbortError = (): Error => {
            try {
                // DOMException exists in modern JS runtimes and provides a standard AbortError shape.
                // eslint-disable-next-line no-undef
                return new DOMException('Aborted', 'AbortError') as unknown as Error;
            } catch {
                const error = new Error('Aborted');
                (error as unknown as { name: string }).name = 'AbortError';
                return error;
            }
        };

        const timeout = setTimeout(() => {
            cleanup();
            reject(new ServerReachabilityWaitTimeoutError());
        }, Math.max(0, params.timeoutMs));

        const onAbort = () => {
            cleanup();
            reject(createAbortError());
        };

        const unsubscribe = subscribeServerReachabilityState(params.entry.serverUrl, (state) => {
            if (!params.predicate(state)) return;
            cleanup();
            resolve();
        });

        const cleanup = () => {
            clearTimeout(timeout);
            unsubscribe();
            params.signal?.removeEventListener('abort', onAbort);
        };

        if (params.signal) {
            if (params.signal.aborted) {
                cleanup();
                reject(createAbortError());
                return;
            }
            params.signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

async function waitForNetworkAllowed(params: Readonly<{ signal?: AbortSignal; timeoutMs: number }>): Promise<void> {
    if (networkAllowed) return;

    await new Promise<void>((resolve, reject) => {
        const createAbortError = (): Error => {
            try {
                // eslint-disable-next-line no-undef
                return new DOMException('Aborted', 'AbortError') as unknown as Error;
            } catch {
                const error = new Error('Aborted');
                (error as unknown as { name: string }).name = 'AbortError';
                return error;
            }
        };

        const timeout = setTimeout(() => {
            cleanup();
            reject(new ServerReachabilityWaitTimeoutError());
        }, Math.max(0, params.timeoutMs));

        const onAbort = () => {
            cleanup();
            reject(createAbortError());
        };

        const unsubscribe = subscribeServerReachabilityNetworkAllowed((allowed) => {
            if (!allowed) return;
            cleanup();
            resolve();
        });

        const cleanup = () => {
            clearTimeout(timeout);
            unsubscribe();
            params.signal?.removeEventListener('abort', onAbort);
        };

        if (params.signal) {
            if (params.signal.aborted) {
                cleanup();
                reject(createAbortError());
                return;
            }
            params.signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

export function subscribeServerReachabilityState(
    serverUrl: string,
    listener: (state: ManagedConnectionState) => void,
): () => void {
    const entry = getOrCreateEntry(serverUrl);
    entry.subscribers.add(listener);
    listener(entry.state);
    return () => entry.subscribers.delete(listener);
}

export function peekServerReachabilityToken(serverUrl: string): string | null | undefined {
    const normalized = canonicalizeServerUrl(String(serverUrl ?? ''));
    if (!normalized) return undefined;
    const entry = entriesByServerUrl.get(normalized);
    return entry ? entry.token : undefined;
}

export async function waitForServerReachable(params: Readonly<{
    serverUrl: string;
    token: string | null;
    signal?: AbortSignal;
    timeoutMs: number;
    acceptAuthFailed?: boolean;
}>): Promise<void> {
    await waitForNetworkAllowed({ signal: params.signal, timeoutMs: params.timeoutMs });
    const entry = getOrCreateEntry(params.serverUrl);
    const tokenChanged = entry.token !== params.token;
    entry.token = params.token;

    // IMPORTANT: `createManagedConnectionSupervisor.start()` will immediately create/connect a transport when the
    // supervisor is already started but currently offline/auth_failed. For reachability supervision we must not
    // bypass the existing probe/backoff schedule (otherwise each caller waiting for reachability can reset the
    // offline state and cause request storms).
    //
    // Only start when the supervisor has never been started (idle) or when it was explicitly stopped (shutting_down).
    // If we are stuck in auth_failed and the auth token changed, restart from a fresh initial probe.
    if (entry.state.phase === 'idle' || entry.state.phase === 'shutting_down') {
        await entry.supervisor.start();
    } else if (entry.state.phase === 'auth_failed' && tokenChanged) {
        await entry.supervisor.stop();
        await entry.supervisor.start();
    }
    await waitForState({
        entry,
        signal: params.signal,
        timeoutMs: params.timeoutMs,
        predicate: (state) => state.phase === 'online' || (params.acceptAuthFailed === true && state.phase === 'auth_failed'),
    });
}

export async function invalidateServerReachabilitySupervisor(params: Readonly<{
    serverUrl: string;
    token: string | null;
}>): Promise<void> {
    const entry = getOrCreateEntry(params.serverUrl);
    const tokenChanged = entry.token !== params.token;
    entry.token = params.token;

    if (!networkAllowed) {
        return;
    }

    if (entry.invalidateInFlight) {
        await entry.invalidateInFlight;
        return;
    }

    const now = Date.now();
    // Avoid repeated stop/start loops when multiple callers attempt to "force reconnect" at once.
    if (now - entry.lastInvalidateAt < 250) {
        return;
    }
    entry.lastInvalidateAt = now;

    const run = (async () => {
        if (entry.state.phase === 'online' || entry.state.phase === 'connecting') {
            return;
        }
        if (entry.state.phase === 'idle' || entry.state.phase === 'shutting_down') {
            await entry.supervisor.start();
            return;
        }
        if (entry.state.phase === 'auth_failed' && tokenChanged) {
            await entry.supervisor.stop();
            await entry.supervisor.start();
            return;
        }
        // Offline: intentionally bypass the existing backoff schedule when explicitly invalidated.
        if (entry.state.phase === 'offline') {
            await entry.supervisor.stop();
            await entry.supervisor.start();
        }
    })();

    entry.invalidateInFlight = run;
    try {
        await run;
    } finally {
        if (entry.invalidateInFlight === run) {
            entry.invalidateInFlight = null;
        }
    }
}

export async function invalidateAllServerReachabilitySupervisors(): Promise<void> {
    await Promise.allSettled(Array.from(entriesByServerUrl.values()).map((entry) =>
        invalidateServerReachabilitySupervisor({ serverUrl: entry.serverUrl, token: entry.token }),
    ));
}

export function reportServerUnreachable(serverUrl: string, error: unknown): void {
    const entry = entriesByServerUrl.get(canonicalizeServerUrl(serverUrl));
    if (!entry) return;
    if (entry.state.phase !== 'online' && entry.state.phase !== 'connecting') {
        return;
    }
    const controller = entry.currentTransportController;
    if (!controller) return;
    controller.emitDisconnect({
        intentional: false,
        reason: 'network_error',
        error,
    });
}

export async function stopServerReachabilitySupervisors(): Promise<void> {
    await Promise.allSettled(Array.from(entriesByServerUrl.values()).map((entry) => entry.supervisor.stop()));
}

export async function startServerReachabilitySupervisor(params: Readonly<{
    serverUrl: string;
    token: string | null;
}>): Promise<void> {
    const entry = getOrCreateEntry(params.serverUrl);
    const tokenChanged = entry.token !== params.token;
    entry.token = params.token;

    if (!networkAllowed) {
        return;
    }

    if (entry.state.phase === 'idle' || entry.state.phase === 'shutting_down') {
        await entry.supervisor.start();
    } else if (entry.state.phase === 'auth_failed' && tokenChanged) {
        await entry.supervisor.stop();
        await entry.supervisor.start();
    }
}

export async function stopServerReachabilitySupervisor(serverUrl: string): Promise<void> {
    const normalized = canonicalizeServerUrl(String(serverUrl ?? ''));
    const entry = normalized ? entriesByServerUrl.get(normalized) : null;
    if (!entry) return;
    await entry.supervisor.stop();
}

export async function resetServerReachabilitySupervisors(): Promise<void> {
    await stopServerReachabilitySupervisors();
    entriesByServerUrl.clear();
}

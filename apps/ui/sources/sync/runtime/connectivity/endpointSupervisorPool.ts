import type { ManagedConnectionState, ManagedEndpointSupervisor, ManagedEndpointSupervisorState, ManagedProbeReportScope } from '@happier-dev/connection-supervisor';
import { AppState } from 'react-native';

import { TokenStorage } from '@/auth/storage/tokenStorage';

import { readEndpointReadinessBlockedResult, readEndpointReadinessResultFromState } from './createEndpointReadinessProbe';
import {
    acquireServerReachabilitySupervisor,
    invalidateServerReachabilitySupervisor,
    peekServerReachabilityScope,
    reportServerReachabilityProbeResult,
    reportServerUnreachable,
    subscribeServerReachabilityState,
    waitForServerReachable,
    type ServerReachabilityLease,
} from './serverReachabilitySupervisorPool';

type EndpointSupervisorKeyParams = Readonly<{
    serverId: string;
    endpoint: string;
}>;

type AcquireEndpointSupervisorParams = EndpointSupervisorKeyParams & Readonly<{
    tokenOverride?: string | null;
}>;

type EndpointSupervisorPoolEntry = {
    key: string;
    supervisor: ManagedEndpointSupervisor;
    tokenRef: { current: string | null };
    refCount: number;
    idleStopTimer: ReturnType<typeof setTimeout> | null;
    stopInFlight: Promise<void> | null;
    startInFlight: Promise<void> | null;
};

type EndpointSupervisorHandle = Readonly<{
    supervisor: ManagedEndpointSupervisor;
    release: (options?: Readonly<{ immediate?: boolean }>) => Promise<void>;
}>;

type EndpointProbeReportScope = ManagedProbeReportScope & Readonly<{ token: string | null }>;

function readCapturedProbeToken(scope: ManagedProbeReportScope | undefined): string | null | undefined {
    if (!scope || !('token' in scope)) return undefined;
    return typeof scope.token === 'string' || scope.token === null ? scope.token : undefined;
}

const VITEST_RUNTIME_CLEANUPS_KEY = Symbol.for('happier.vitest.runtimeCleanups');

type RuntimeCleanupRegistryForTests = Map<string, () => Promise<void> | void>;

function registerRuntimeCleanupForTests(id: string, cleanup: () => Promise<void> | void): void {
    const globalWithRegistry = globalThis as unknown as {
        [key: symbol]: RuntimeCleanupRegistryForTests | undefined;
    };
    globalWithRegistry[VITEST_RUNTIME_CLEANUPS_KEY]?.set(id, cleanup);
}

const entriesByKey = new Map<string, EndpointSupervisorPoolEntry>();
let appStateSubscription: { remove: () => void } | null = null;
let visibilityDetach: (() => void) | null = null;

function isAppActive(state: string): boolean {
    const value = String(state ?? '').trim();
    if (!value) return true;
    return value === 'active';
}

function invalidateAllSupervisors(): void {
    for (const entry of entriesByKey.values()) {
        try {
            entry.supervisor.invalidate();
        } catch {
            // ignore
        }
    }
}

function ensureAppStateSubscription(): void {
    if (appStateSubscription) return;
    try {
        if (typeof AppState.addEventListener !== 'function') {
            return;
        }
        appStateSubscription = AppState.addEventListener('change', (next: string) => {
            if (!isAppActive(next)) return;
            invalidateAllSupervisors();
        });
    } catch {
        appStateSubscription = null;
    }
}

function ensureVisibilitySubscription(): void {
    if (visibilityDetach) return;
    const doc = (globalThis as unknown as { document?: any }).document;
    if (!doc || typeof doc.addEventListener !== 'function' || typeof doc.removeEventListener !== 'function') {
        return;
    }

    const handler = () => {
        invalidateAllSupervisors();
    };

    try {
        doc.addEventListener('visibilitychange', handler);
    } catch {
        return;
    }

    visibilityDetach = () => {
        try {
            doc.removeEventListener('visibilitychange', handler);
        } catch {
            // ignore
        }
    };
}

function maybeDetachAppStateSubscription(): void {
    if (!appStateSubscription) return;
    if (entriesByKey.size > 0) return;
    try {
        appStateSubscription.remove();
    } catch {
        // ignore
    }
    appStateSubscription = null;
}

function maybeDetachVisibilitySubscription(): void {
    if (!visibilityDetach) return;
    if (entriesByKey.size > 0) return;
    try {
        visibilityDetach();
    } catch {
        // ignore
    }
    visibilityDetach = null;
}

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function normalizeBaseUrl(raw: unknown): string {
    const value = String(raw ?? '').trim();
    if (!value) return '';
    try {
        const url = new URL(value);
        url.hash = '';
        url.search = '';
        return url.toString().replace(/\/+$/, '');
    } catch {
        return value.replace(/\/+$/, '');
    }
}

function normalizeToken(raw: unknown): string | null {
    const value = typeof raw === 'string' ? raw.trim() : '';
    return value.length > 0 ? value : null;
}

function buildKey(params: EndpointSupervisorKeyParams): string {
    const serverId = normalizeId(params.serverId);
    const endpoint = normalizeBaseUrl(params.endpoint);
    return `${serverId}:${endpoint}`;
}

export function getEndpointSupervisorForServer(params: Readonly<{ serverId: string; serverUrl: string }>): ManagedEndpointSupervisor | null {
    const key = buildKey({ serverId: params.serverId, endpoint: params.serverUrl });
    return entriesByKey.get(key)?.supervisor ?? null;
}

function readIdleStopDelayMs(): number {
    const raw =
        String(process.env.EXPO_PUBLIC_HAPPIER_ENDPOINT_SUPERVISOR_IDLE_TTL_MS ?? '').trim()
        || String(process.env.EXPO_PUBLIC_HAPPIER_ENDPOINT_SUPERVISOR_IDLE_STOP_DELAY_MS ?? '').trim();
    if (!raw) return 15_000;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 15_000;
    return Math.max(0, Math.min(5 * 60_000, parsed));
}

function createEndpointSupervisorFacade(endpoint: string, resolveToken: () => Promise<string | null>): ManagedEndpointSupervisor {
    let state: ManagedEndpointSupervisorState = {
        phase: 'idle', reason: null, attempt: 0, nextRetryAt: null,
        lastConnectedAt: null, lastDisconnectedAt: null, lastErrorMessage: null, lastProbe: null,
    };
    const listeners = new Set<(state: ManagedEndpointSupervisorState) => void>();
    let stopped = false;
    let refreshInFlight: Promise<void> | null = null;
    let binding: {
        token: string | null;
        lease: ServerReachabilityLease | null;
        leasePromise: Promise<ServerReachabilityLease>;
        unsubscribe: () => void;
    } | null = null;

    const publish = (next: ManagedEndpointSupervisorState) => {
        state = next;
        listeners.forEach((listener) => listener(state));
    };
    const publishBlocked = (probe: NonNullable<ReturnType<typeof readEndpointReadinessBlockedResult>>) => {
        publish({
            ...state,
            phase: 'offline',
            reason: probe.status === 'server_unreachable' ? 'server_unreachable' : 'probe_failed',
            nextRetryAt: null,
            lastErrorMessage: probe.status === 'ready' ? null : probe.errorMessage ?? null,
            lastProbe: probe,
        });
    };
    const publishCanonical = (next: ManagedConnectionState) => {
        const blocked = readEndpointReadinessBlockedResult(endpoint);
        if (blocked) {
            publishBlocked(blocked);
            return;
        }
        const lastProbe = readEndpointReadinessResultFromState(next);
        publish({ ...next, lastErrorMessage: lastProbe && lastProbe.status !== 'ready' ? lastProbe.errorMessage ?? null : next.lastErrorMessage, lastProbe });
    };
    const detachBinding = async () => {
        const previous = binding;
        binding = null;
        previous?.unsubscribe();
        // A pending acquisition releases when it completes; cancellation does
        // not stop another consumer's canonical Home probe.
        if (previous?.lease) await previous.lease.release();
    };
    const refresh = async (force: boolean): Promise<void> => {
        const blocked = readEndpointReadinessBlockedResult(endpoint);
        if (blocked) {
            publishBlocked(blocked);
            return;
        }
        if (refreshInFlight) {
            await refreshInFlight;
            return;
        }
        const run = (async () => {
            const token = await resolveToken();
            if (stopped) return;
            if (binding && binding.token !== token) await detachBinding();
            if (!binding) {
                const leasePromise = acquireServerReachabilitySupervisor({ serverUrl: endpoint, token });
                const nextBinding = { token, lease: null as ServerReachabilityLease | null, leasePromise, unsubscribe: () => {} };
                binding = nextBinding;
                nextBinding.unsubscribe = subscribeServerReachabilityState(endpoint, (next) => {
                    if (!stopped && binding === nextBinding) publishCanonical(next);
                }, token);
                void leasePromise.then(async (lease) => {
                    if (stopped || binding !== nextBinding) {
                        await lease.release();
                        return;
                    }
                    nextBinding.lease = lease;
                }).catch(() => {});
            } else if (force) {
                // The canonical owner completes its reprobe independently;
                // credential rebinding must not wait for that network response.
                void invalidateServerReachabilitySupervisor({ serverUrl: endpoint, token }).catch(() => {});
            }
        })();
        refreshInFlight = run;
        try {
            await run;
        } finally {
            if (refreshInFlight === run) refreshInFlight = null;
        }
    };

    return {
        async start() {
            stopped = false;
            await refresh(false);
            await binding?.leasePromise;
        },
        async stop() {
            stopped = true;
            publish({ ...state, phase: 'shutting_down', reason: 'intentional_shutdown', nextRetryAt: null });
            await detachBinding();
        },
        invalidate() {
            if (!stopped) void refresh(true).catch(() => {});
        },
        reportFailure(report) {
            if (binding && !stopped) reportServerUnreachable(endpoint, new Error(report.errorMessage ?? 'Network request failed'), binding.token);
        },
        captureProbeReportScope() {
            const capturedBinding = binding;
            const scope = capturedBinding ? peekServerReachabilityScope(endpoint, capturedBinding.token) : null;
            if (!scope || !capturedBinding) throw new Error('Endpoint readiness has no canonical report scope');
            // Carry the existing credential binding across the async request.
            // Generations remain owned and validated by the canonical pool.
            return { ...scope, token: capturedBinding.token } satisfies EndpointProbeReportScope;
        },
        reportProbeResult(probe, scope) {
            const token = readCapturedProbeToken(scope);
            if (!stopped && token !== undefined) reportServerReachabilityProbeResult(endpoint, probe, scope, token);
        },
        async waitUntilOnline(params) {
            if (state.phase === 'online') return;
            if (!binding) throw new Error('Endpoint readiness has no canonical Home demand');
            await waitForServerReachable({ serverUrl: endpoint, token: binding.token, timeoutMs: params?.timeoutMs });
        },
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            listener(state);
            return () => { listeners.delete(listener); };
        },
    };
}

async function ensureEntryStarted(entry: EndpointSupervisorPoolEntry): Promise<void> {
    if (entry.startInFlight) {
        await entry.startInFlight;
        return;
    }
    const promise = entry.supervisor.start();
    entry.startInFlight = promise.then(
        () => {
            entry.startInFlight = null;
        },
        () => {
            entry.startInFlight = null;
        },
    );
    await promise;
}

async function stopEntry(entry: EndpointSupervisorPoolEntry): Promise<void> {
    if (entry.idleStopTimer) {
        clearTimeout(entry.idleStopTimer);
        entry.idleStopTimer = null;
    }

    if (entry.stopInFlight) {
        await entry.stopInFlight;
        return;
    }

    entry.stopInFlight = entry.supervisor.stop().then(
        () => {
            entry.stopInFlight = null;
        },
        () => {
            entry.stopInFlight = null;
        },
    );
    await entry.stopInFlight;
}

export async function acquireEndpointSupervisor(params: AcquireEndpointSupervisorParams): Promise<EndpointSupervisorHandle> {
    ensureAppStateSubscription();
    ensureVisibilitySubscription();
    const normalizedEndpoint = normalizeBaseUrl(params.endpoint);
    const key = buildKey({ serverId: params.serverId, endpoint: normalizedEndpoint });
    const tokenOverride = normalizeToken(params.tokenOverride);

    const existing = entriesByKey.get(key);
    if (existing) {
        existing.refCount += 1;
        const tokenChanged = existing.tokenRef.current !== tokenOverride;
        existing.tokenRef.current = tokenOverride;
        if (existing.idleStopTimer) {
            clearTimeout(existing.idleStopTimer);
            existing.idleStopTimer = null;
        }
        if (existing.startInFlight) {
            await existing.startInFlight;
        }
        if (tokenChanged) await ensureEntryStarted(existing);
        let released = false;
        return {
            supervisor: existing.supervisor,
            release: async (options) => {
                if (released) return;
                released = true;
                await releaseEndpointSupervisorKey(key, options);
            },
        };
    }

    const tokenRef = { current: tokenOverride };
    const supervisor = createEndpointSupervisorFacade(normalizedEndpoint, async () => {
        try {
            const credentials = await TokenStorage.getCredentialsForServerUrl(normalizedEndpoint, {
                serverId: params.serverId,
            });
            const override = tokenRef.current;
            if (override) return override;
            return normalizeToken(credentials?.token);
        } catch {
            return tokenRef.current;
        }
    });

    const entry: EndpointSupervisorPoolEntry = {
        key,
        supervisor,
        tokenRef,
        refCount: 1,
        idleStopTimer: null,
        stopInFlight: null,
        startInFlight: null,
    };
    entriesByKey.set(key, entry);

    await ensureEntryStarted(entry);

    let released = false;
    return {
        supervisor,
        release: async (options) => {
            if (released) return;
            released = true;
            await releaseEndpointSupervisorKey(key, options);
        },
    };
}

async function releaseEndpointSupervisorKey(
    key: string,
    options?: Readonly<{ immediate?: boolean }>,
): Promise<void> {
    const entry = entriesByKey.get(key);
    if (!entry) return;

    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount > 0) return;

    if (options?.immediate) {
        entriesByKey.delete(key);
        await stopEntry(entry);
        maybeDetachAppStateSubscription();
        maybeDetachVisibilitySubscription();
        return;
    }

    if (entry.idleStopTimer) return;
    const delayMs = readIdleStopDelayMs();
    entry.idleStopTimer = setTimeout(() => {
        entry.idleStopTimer = null;
        if (entry.refCount > 0) return;
        if (entriesByKey.get(key) !== entry) return;
        entriesByKey.delete(key);
        void stopEntry(entry).catch(() => {});
        maybeDetachAppStateSubscription();
        maybeDetachVisibilitySubscription();
    }, delayMs);
}

export async function stopAllEndpointSupervisorsForTests(): Promise<void> {
    const entries = Array.from(entriesByKey.values());
    entriesByKey.clear();
    await Promise.all(entries.map((entry) => stopEntry(entry).catch(() => {})));
    maybeDetachAppStateSubscription();
    maybeDetachVisibilitySubscription();
}

export async function acquireEndpointSupervisorForServer(params: Readonly<{
    serverId: string;
    serverUrl: string;
    tokenOverride?: string | null;
}>): Promise<EndpointSupervisorHandle> {
    return await acquireEndpointSupervisor({
        serverId: params.serverId,
        endpoint: params.serverUrl,
        tokenOverride: params.tokenOverride,
    });
}

export async function resetEndpointSupervisorPoolForTests(): Promise<void> {
    await stopAllEndpointSupervisorsForTests();
}

registerRuntimeCleanupForTests('resetEndpointSupervisorPoolForTests', resetEndpointSupervisorPoolForTests);

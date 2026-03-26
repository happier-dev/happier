import {
    createManagedEndpointSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ManagedEndpointSupervisor,
} from '@happier-dev/connection-supervisor';
import { AppState } from 'react-native';

import { TokenStorage } from '@/auth/storage/tokenStorage';

import { createEndpointReadinessProbe } from './createEndpointReadinessProbe';

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
    detachRuntimeOnlineListener: () => void;
};

type EndpointSupervisorHandle = Readonly<{
    supervisor: ManagedEndpointSupervisor;
    release: (options?: Readonly<{ immediate?: boolean }>) => Promise<void>;
}>;

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

function bindSupervisorToRuntimeOnlineEvents(supervisor: ManagedEndpointSupervisor): () => void {
    const win =
        (typeof window !== 'undefined' ? window : null)
        ?? (globalThis as unknown as { window?: unknown }).window
        ?? null;
    if (!win) {
        return () => {};
    }
    const addEventListener = (win as { addEventListener?: unknown }).addEventListener;
    const removeEventListener = (win as { removeEventListener?: unknown }).removeEventListener;
    if (typeof addEventListener !== 'function' || typeof removeEventListener !== 'function') {
        return () => {};
    }

    const handler = () => {
        supervisor.invalidate();
    };

    try {
        (addEventListener as (event: string, listener: () => void) => void)('online', handler);
    } catch {
        return () => {};
    }

    return () => {
        try {
            (removeEventListener as (event: string, listener: () => void) => void)('online', handler);
        } catch {
            // ignore
        }
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

    try {
        entry.detachRuntimeOnlineListener();
    } catch {
        // ignore
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
        existing.tokenRef.current = tokenOverride;
        if (existing.idleStopTimer) {
            clearTimeout(existing.idleStopTimer);
            existing.idleStopTimer = null;
        }
        if (existing.startInFlight) {
            await existing.startInFlight;
        }
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
    const supervisor = createManagedEndpointSupervisor({
        ...DEFAULT_MANAGED_CONNECTION_POLICY,
        probeReadiness: createEndpointReadinessProbe({
            endpoint: normalizedEndpoint,
            token: async () => {
                try {
                    const credentials = await TokenStorage.getCredentialsForServerUrl(normalizedEndpoint, {
                        serverId: params.serverId,
                    });
                    const override = tokenRef.current;
                    if (override) {
                        return override;
                    }
                    return normalizeToken(credentials?.token);
                } catch {
                    return tokenRef.current;
                }
            },
        }),
    });

    const detachRuntimeOnlineListener = bindSupervisorToRuntimeOnlineEvents(supervisor);

    const entry: EndpointSupervisorPoolEntry = {
        key,
        supervisor,
        tokenRef,
        refCount: 1,
        idleStopTimer: null,
        stopInFlight: null,
        startInFlight: null,
        detachRuntimeOnlineListener,
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

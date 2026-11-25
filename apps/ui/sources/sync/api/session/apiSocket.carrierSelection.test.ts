import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';

vi.mock('socket.io-client', async () => {
    const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    return { io: () => createSocketIoBoundaryStub().socket };
});

// Prepare the source graph before the per-case mock/connection lifecycle.
await import('./apiSocket');
vi.resetModules();

// Security review 1125 §D H1 class: the Account bearer goes only to an address the
// carrier policy selected. A recovery signal (browser `online`, foreground, Retry) while
// apiSocket waits for the carrier must not start its observer entry against the canonical URL.

afterEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
    const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    resetRuntimeFetch();
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    await resetServerReachabilitySupervisors();
    // The next case imports its pool under its own profile mocks, not this cleanup's instance.
    vi.resetModules();
});

const irohProfile = {
    id: 'srv_home',
    name: 'Home',
    serverUrl: 'https://api.example.test',
    canonicalServerUrl: 'https://api.example.test',
    serverIdentityId: 'srv_home',
    homeConnectionDescriptor: {
        v: 1,
        homeServerIdentityId: 'srv_home',
        canonicalServerUrl: 'https://api.example.test',
        revision: 1,
        endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] }],
    },
    publicServerUrl: null,
};

let currentSnapshot: Record<string, unknown> = {};

describe('apiSocket reachability carrier selection', () => {
    async function initializeWithRealPool(params: Readonly<{
        profile: Record<string, unknown> | null;
        snapshot: Record<string, unknown>;
    }>) {
        currentSnapshot = params.snapshot;
        const originListenerRef: { current: ((snapshot: Record<string, unknown>) => void) | null } = { current: null };
        vi.doMock('@/sync/domains/server/serverRuntime', async (importOriginal) => ({
            ...await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>(),
            getActiveServerSnapshot: () => currentSnapshot,
            getActiveServerHomeCarrier: () => null,
        }));
        vi.doMock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
            return {
                ...actual,
                getServerProfileById: (id: unknown) => (params.profile && String(id) === params.profile.id ? params.profile : null),
                listServerProfiles: () => (params.profile ? [params.profile] : []),
                getActiveServerHomeCarrier: () => null,
                subscribeActiveServerRuntimeOrigin: (listener: (snapshot: Record<string, unknown>) => void) => {
                    originListenerRef.current = listener;
                    return () => {};
                },
            };
        });
        vi.doMock('socket.io-client', () => ({ io: vi.fn(() => createSocketIoBoundaryStub().socket) }));
        const bearerRequests: string[] = [];
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(async (input, init) => {
            const headers = new Headers(init?.headers);
            if (headers.has('Authorization')) bearerRequests.push(new URL(String(input)).origin);
            return Response.json({});
        });
        const pool = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        const { apiSocket } = await import('./apiSocket');
        apiSocket.initialize({ endpoint: String(params.snapshot.serverUrl), token: 'token-a' }, null);
        return { apiSocket, pool, bearerRequests, originListenerRef };
    }

    it('sends no bearer to the canonical URL when a recovery signal arrives while waiting for the carrier', async () => {
        const { apiSocket, pool, bearerRequests, originListenerRef } = await initializeWithRealPool({
            profile: irohProfile,
            snapshot: { serverId: 'srv_home', serverUrl: 'https://api.example.test', generation: 1 },
        });
        try {
            // Browser `online`, foreground and Retry all reach this one pool entry point.
            await pool.invalidateAllServerReachabilitySupervisors();
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(bearerRequests).toEqual([]);

            // The policy's publication is what selects an address; the probe follows it.
            currentSnapshot = { ...currentSnapshot, carrier: 'iroh', runtimeOrigin: 'http://127.0.0.1:43444' };
            originListenerRef.current?.(currentSnapshot);
            await vi.waitFor(() => expect(bearerRequests).toContain('http://127.0.0.1:43444'), { timeout: 10_000 });
            expect(bearerRequests.every((origin) => origin === 'http://127.0.0.1:43444')).toBe(true);
        } finally {
            apiSocket.disconnect();
            (await import('@/utils/system/runtimeFetch')).resetRuntimeFetch();
        }
    });

    it.each([
        ['a descriptor Home whose policy selected its HTTPS origin', irohProfile,
            { serverId: 'srv_home', serverUrl: 'https://api.example.test', carrier: 'https', runtimeOrigin: 'https://api.example.test', generation: 1 },
            'https://api.example.test'],
        ['a loopback Home with no descriptor', null,
            { serverId: 'srv_loopback', serverUrl: 'http://127.0.0.1:3010', generation: 1 },
            'http://127.0.0.1:3010'],
    ] as const)('still probes %s with the bearer after a recovery signal', async (_name, profile, snapshot, origin) => {
        const { apiSocket, pool, bearerRequests } = await initializeWithRealPool({ profile, snapshot });
        try {
            await vi.waitFor(() => expect(bearerRequests).toContain(origin), { timeout: 10_000 });
            bearerRequests.length = 0;
            await pool.invalidateAllServerReachabilitySupervisors();
            await vi.waitFor(() => expect(bearerRequests).toContain(origin), { timeout: 10_000 });
            expect(bearerRequests.every((value) => value === origin)).toBe(true);
        } finally {
            apiSocket.disconnect();
            (await import('@/utils/system/runtimeFetch')).resetRuntimeFetch();
        }
    });

    // Security review B18 M1: the existing-Session chooser's Retry waits on any Home, not only the
    // focused one, with no transport hint. A fresh entry for a non-focused descriptor Home must not
    // send the bearer to its canonical URL; a start that supplies the selected transport probes it.
    it('sends no bearer to a non-focused descriptor Home until a start selects its transport', async () => {
        const { apiSocket, pool, bearerRequests } = await initializeWithRealPool({
            profile: irohProfile,
            snapshot: { serverId: 'srv_loopback', serverUrl: 'http://127.0.0.1:3010', generation: 1 },
        });
        const controller = new AbortController();
        try {
            await vi.waitFor(() => expect(bearerRequests).toContain('http://127.0.0.1:3010'), { timeout: 10_000 });
            bearerRequests.length = 0;
            // The chooser Retry's call shape: canonical URL and token only.
            const waiting = pool.waitForServerReachable({ serverUrl: 'https://api.example.test', token: 'token-b', signal: controller.signal });
            await pool.invalidateAllServerReachabilitySupervisors();
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(bearerRequests).not.toContain('https://api.example.test');

            // A scoped-transport lease supplies the policy's selected origin; the waiter then completes over it.
            const lease = await pool.acquireServerReachabilitySupervisor({
                serverUrl: 'https://api.example.test', token: 'token-b', runtimeOrigin: 'http://127.0.0.1:43555',
            });
            await waiting;
            await lease.release();
            expect(bearerRequests).toContain('http://127.0.0.1:43555');
            expect(bearerRequests).not.toContain('https://api.example.test');
        } finally {
            controller.abort();
            apiSocket.disconnect();
            (await import('@/utils/system/runtimeFetch')).resetRuntimeFetch();
        }
    });

    it('still probes a non-focused Home with no descriptor from a hint-less wait', async () => {
        const { apiSocket, pool, bearerRequests } = await initializeWithRealPool({
            profile: null,
            snapshot: { serverId: 'srv_loopback', serverUrl: 'http://127.0.0.1:3010', generation: 1 },
        });
        try {
            await pool.waitForServerReachable({ serverUrl: 'http://127.0.0.1:3011', token: 'token-c' });
            expect(bearerRequests).toContain('http://127.0.0.1:3011');
        } finally {
            apiSocket.disconnect();
            (await import('@/utils/system/runtimeFetch')).resetRuntimeFetch();
        }
    });
});

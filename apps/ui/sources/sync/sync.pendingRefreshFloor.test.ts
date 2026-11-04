import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import type { ManagedEndpointSupervisor } from '@happier-dev/connection-supervisor';

type EndpointSupervisorLookup = typeof import('@/sync/runtime/connectivity/endpointSupervisorPool').getEndpointSupervisorForServer;
type EndpointSupervisorAcquire = typeof import('@/sync/runtime/connectivity/endpointSupervisorPool').acquireEndpointSupervisor;
type AssertServerReachabilityAuthenticated = typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool').assertServerReachabilityAuthenticated;
type EnsureSessionRuntimeForPendingInput = typeof import('@/sync/ops').ensureSessionRuntimeForPendingInput;

const appStateAddListener = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            Platform: {
                OS: 'web',
            },
            AppState: {
                addEventListener: appStateAddListener as any,
            },
        }
    );
});

const getEndpointSupervisorForServerMock = vi.hoisted(() => vi.fn<EndpointSupervisorLookup>(() => null));
const acquireEndpointSupervisorMock = vi.hoisted(() => vi.fn<EndpointSupervisorAcquire>());
vi.mock('@/sync/runtime/connectivity/endpointSupervisorPool', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/endpointSupervisorPool')>();
    return {
        ...actual,
        getEndpointSupervisorForServer: (...args: Parameters<typeof actual.getEndpointSupervisorForServer>) =>
            getEndpointSupervisorForServerMock(...args),
        acquireEndpointSupervisor: (...args: Parameters<typeof actual.acquireEndpointSupervisor>) =>
            acquireEndpointSupervisorMock(...args),
    };
});

const assertServerReachabilityAuthenticatedMock = vi.hoisted(() => vi.fn<AssertServerReachabilityAuthenticated>());
vi.mock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')>();
    return {
        ...actual,
        assertServerReachabilityAuthenticated: (...args: Parameters<typeof actual.assertServerReachabilityAuthenticated>) =>
            assertServerReachabilityAuthenticatedMock(...args),
    };
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onSessionFocus: vi.fn(),
        onSessionOffline: vi.fn(),
        onSessionOnline: vi.fn(),
        onMessages: vi.fn(),
        reportContextualUpdate: vi.fn(),
    },
}));

import { Encryption } from '@/sync/encryption/encryption';
import { storage } from './domains/state/storage';
import type { Session } from './domains/state/storageTypes';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { getActiveServerSnapshot } from './domains/server/serverRuntime';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { setRuntimeFetch } from '@/sync/http/client';

const initialStorageState = storage.getState();

function createSession(params: { sessionId: string }): Session {
    const now = Date.now();
    return {
        id: params.sessionId,
        seq: 0,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        // Mark as ready to avoid the 10s wait-for-ready timeout.
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
    };
}

function createReadyEndpointSupervisor(): ManagedEndpointSupervisor {
    const readState = (): ReturnType<ManagedEndpointSupervisor['getState']> => ({
        phase: 'online',
        reason: 'initial_connect',
        attempt: 1,
        nextRetryAt: null,
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: null,
        lastErrorMessage: null,
        lastProbe: { status: 'ready' },
    });

    return {
        start: async () => {},
        stop: async () => {},
        invalidate: vi.fn(),
        reportFailure: vi.fn(),
        waitUntilOnline: async () => {},
        getState: readState,
        subscribe: (listener) => {
            listener(readState());
            return vi.fn();
        },
    };
}

function usePendingSchedulerFakeTimers(): void {
    // Fake only the refresh scheduler's clock. IndexedDB's test implementation commits through
    // setImmediate; faking that system-boundary queue can strand an open transaction forever.
    vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
}

describe('sync.fetchPendingMessages refresh floor', () => {
    beforeEach(() => {
        resetServerFeaturesClientForTests();
        setRuntimeFetch(async () => Response.json(buildServerFeaturesResponse()));
        storage.setState(initialStorageState, true);
        const activeScope = {
            serverId: getActiveServerSnapshot().serverId,
            accountId: 'sync-test-account',
        } as const;
        storage.getState().activateProfileScope(activeScope);
        appStateAddListener.mockClear();
        getEndpointSupervisorForServerMock.mockReset();
        getEndpointSupervisorForServerMock.mockReturnValue(null);
        acquireEndpointSupervisorMock.mockReset();
        acquireEndpointSupervisorMock.mockResolvedValue({
            supervisor: createReadyEndpointSupervisor(),
            release: vi.fn(async () => {}),
        });
        assertServerReachabilityAuthenticatedMock.mockReset();
    });

    afterEach(() => {
        standardCleanup();
        vi.restoreAllMocks();
    });

    /**
     * The incident shape (#856): server pushes bump pendingVersion and the session refresh
     * re-triggers per bump, minting one server read per trigger.
     */
    it('collapses a server-driven refresh burst into one pending read per floor window plus one trailing read', async () => {
        usePendingSchedulerFakeTimers();
        try {
            const sessionId = 's_refresh_floor_burst';
            storage.getState().applySessions([createSession({ sessionId })]);
            const encryption = await Encryption.create(new Uint8Array(32).fill(9));
            await encryption.initializeSessions(new Map([[sessionId, null]]));

            let pendingReads = 0;
            vi.spyOn(apiSocket, 'request').mockImplementation(async (path: string) => {
                if (path.includes('/pending')) pendingReads += 1;
                return new Response(JSON.stringify({ pending: [] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            });

            const { sync } = await import('./sync');
            sync.encryption = encryption;
            sync.setMessageTransport({ emitWithAck: vi.fn(), send: vi.fn() });

            for (let bump = 1; bump <= 10; bump += 1) {
                storage.getState().applySessions([{
                    ...createSession({ sessionId }),
                    pendingVersion: bump,
                }]);
                await sync.fetchPendingMessages(sessionId, undefined, { serverDriven: true });
            }

            expect(pendingReads).toBe(1);

            await vi.advanceTimersByTimeAsync(1_100);
            // The trailing reconcile is fire-and-forget; drain the real macrotask queue (IndexedDB
            // commits through real setImmediate) before asserting on the read it issues.
            for (let drain = 0; drain < 5; drain += 1) {
                await new Promise<void>((resolve) => { setImmediate(resolve); });
            }
            expect(pendingReads).toBe(2);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('reads again immediately once the floor window has fully elapsed', async () => {
        usePendingSchedulerFakeTimers();
        try {
            const sessionId = 's_refresh_floor_elapsed';
            storage.getState().applySessions([createSession({ sessionId })]);
            const encryption = await Encryption.create(new Uint8Array(32).fill(9));
            await encryption.initializeSessions(new Map([[sessionId, null]]));

            let pendingReads = 0;
            vi.spyOn(apiSocket, 'request').mockImplementation(async (path: string) => {
                if (path.includes('/pending')) pendingReads += 1;
                return new Response(JSON.stringify({ pending: [] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            });

            const { sync } = await import('./sync');
            sync.encryption = encryption;
            sync.setMessageTransport({ emitWithAck: vi.fn(), send: vi.fn() });

            await sync.fetchPendingMessages(sessionId, undefined, { serverDriven: true });
            await vi.advanceTimersByTimeAsync(1_000);
            await sync.fetchPendingMessages(sessionId, undefined, { serverDriven: true });

            expect(pendingReads).toBe(2);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('keeps caller-initiated refreshes immediate inside the floor window', async () => {
        usePendingSchedulerFakeTimers();
        try {
            const sessionId = 's_refresh_floor_recovery';
            storage.getState().applySessions([createSession({ sessionId })]);
            const encryption = await Encryption.create(new Uint8Array(32).fill(9));
            await encryption.initializeSessions(new Map([[sessionId, null]]));

            let pendingReads = 0;
            vi.spyOn(apiSocket, 'request').mockImplementation(async (path: string) => {
                if (path.includes('/pending')) pendingReads += 1;
                return new Response(JSON.stringify({ pending: [] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            });

            const { sync } = await import('./sync');
            sync.encryption = encryption;
            sync.setMessageTransport({ emitWithAck: vi.fn(), send: vi.fn() });

            await sync.fetchPendingMessages(sessionId, undefined, { serverDriven: true });
            // A recovery caller (action-conflict reconcile, resume, catch-up) inside the window.
            await sync.fetchPendingMessages(sessionId);

            expect(pendingReads).toBe(2);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });
});

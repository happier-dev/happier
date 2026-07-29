import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManagedEndpointSupervisor, ManagedEndpointSupervisorState } from '@happier-dev/connection-supervisor';

import type { PauseController } from '@/utils/timing/pauseController';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

// Sync imports persistence, which instantiates MMKV. Mock it for deterministic tests.
const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

const appStateHandlers = vi.hoisted(() => new Set<(state: string) => void>());
const appStateCurrentState = vi.hoisted(() => ({ value: 'active' as string }));
const appStateAddListener = vi.hoisted(() => vi.fn((_event: string, handler: (state: string) => void) => {
    appStateHandlers.add(handler);
    return { remove: vi.fn(() => appStateHandlers.delete(handler)) };
}));

const tauriDesktopState = vi.hoisted(() => ({ value: false }));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
}));

const jsThreadLagTelemetrySummary = vi.hoisted(() => ({
    count: 1,
    p50Ms: 5,
    p99Ms: 5,
    maxMs: 5,
    thresholdExceededCount: 0,
    lastSampleAtMs: 10,
}));

const jsThreadLagTelemetryRuntime = vi.hoisted(() => ({
    start: vi.fn(() => true),
    stop: vi.fn(),
    reset: vi.fn(),
    isRunning: vi.fn(() => true),
    recordSample: vi.fn(),
    snapshot: vi.fn(() => jsThreadLagTelemetrySummary),
    flushSummary: vi.fn(() => jsThreadLagTelemetrySummary),
}));

const createJsThreadLagTelemetryMock = vi.hoisted(() => vi.fn(() => jsThreadLagTelemetryRuntime));

vi.mock('@/sync/runtime/performance/jsThreadLagTelemetry', () => ({
    createJsThreadLagTelemetry: createJsThreadLagTelemetryMock,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                        Platform: { OS: 'web' },
                        AppState: {
                            get currentState() {
                                return appStateCurrentState.value;
                            },
                            addEventListener: appStateAddListener as any,
                        },
                    }
    );
});

const apiSocketDisconnect = vi.hoisted(() => vi.fn());
const apiSocketConnect = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onError: vi.fn(),
        onReconnected: vi.fn(),
        onStatusChange: vi.fn(() => () => {}),
        onConnectionStateChange: vi.fn(() => () => {}),
        connect: apiSocketConnect,
        disconnect: apiSocketDisconnect,
        initialize: vi.fn(),
        request: vi.fn(async () => new Response('ok', { status: 200 })),
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('sync AppState pause/resume', () => {
    beforeEach(() => {
        vi.resetModules();
        kvStore.clear();
        appStateHandlers.clear();
        appStateAddListener.mockClear();
        appStateCurrentState.value = 'active';
        tauriDesktopState.value = false;
        apiSocketDisconnect.mockClear();
        apiSocketConnect.mockClear();
        createJsThreadLagTelemetryMock.mockClear();
        jsThreadLagTelemetryRuntime.start.mockClear();
        jsThreadLagTelemetryRuntime.stop.mockClear();
        jsThreadLagTelemetryRuntime.reset.mockClear();
        jsThreadLagTelemetryRuntime.isRunning.mockClear();
        jsThreadLagTelemetryRuntime.recordSample.mockClear();
        jsThreadLagTelemetryRuntime.snapshot.mockClear();
        jsThreadLagTelemetryRuntime.flushSummary.mockClear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('rearms only current-scope durable outbox sessions once without mounting a session route', async () => {
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { storage } = await import('./domains/state/storage');
        const { savePendingOutboxMessage } = await import('./domains/state/pendingOutboxPersistence');
        const profile = upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
        const activeScope = {
            serverId: String(getActiveServerSnapshot().serverId ?? profile.id),
            accountId: 'account-a',
        } as const;
        const otherScope = { ...activeScope, accountId: 'account-b' } as const;
        storage.getState().activateProfileScope(activeScope);

        const save = (sessionId: string, localId: string, scope: ServerAccountScope) => {
            savePendingOutboxMessage({
                sessionId,
                localId,
                createdAt: 100,
                text: localId,
                rawRecord: { role: 'user' },
                request: {
                    v: 1,
                    body: JSON.stringify({
                        localId,
                        content: { t: 'plain', v: { role: 'user' } },
                        messageRole: 'user',
                    }),
                },
            }, scope);
        };
        save('session-b', 'local-b', activeScope);
        save('session-a', 'local-a', activeScope);
        save('other-account-session', 'other-local', otherScope);

        const { sync } = await import('./sync');
        let releaseReplay!: () => void;
        const replayBarrier = new Promise<void>((resolve) => {
            releaseReplay = resolve;
        });
        const fetchPendingMessages = vi.spyOn(sync, 'fetchPendingMessages')
            .mockImplementation(async () => replayBarrier);

        const first = (sync as any).rearmPendingOutboxForActiveScope() as Promise<void>;
        const second = (sync as any).rearmPendingOutboxForActiveScope() as Promise<void>;
        await Promise.resolve();

        expect(second).toBe(first);
        expect(fetchPendingMessages.mock.calls).toEqual([
            ['session-a', activeScope],
            ['session-b', activeScope],
        ]);

        releaseReplay();
        await first;
    });

    it('invokes durable outbox rearm from both bootstrap and the foreground resume pipeline', async () => {
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { storage } = await import('./domains/state/storage');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
        storage.getState().activateProfileScope({
            serverId: String(getActiveServerSnapshot().serverId ?? ''),
            accountId: 'account-a',
        });

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: 'token', secret: 'secret' };
        (sync as any).serverID = 'account-a';
        const rearm = vi.spyOn(sync as any, 'rearmPendingOutboxForActiveScope').mockResolvedValue(undefined);
        const syncUnit = {
            invalidateCoalesced: vi.fn(),
            awaitQueue: vi.fn(async () => undefined),
        };
        for (const field of [
            'settingsSync',
            'profileSync',
            'accountPetsSync',
            'sessionsSync',
            'machinesSync',
            'purchasesSync',
            'artifactsSync',
            'automationsSync',
            'todosSync',
            'friendsSync',
            'friendRequestsSync',
            'feedSync',
            'pushTokenSync',
            'nativeUpdateSync',
        ]) {
            (sync as any)[field] = syncUnit;
        }

        await (sync as any).bootstrapSync();
        expect(rearm).toHaveBeenCalledTimes(1);

        storage.setState((state) => ({
            ...state,
            profile: { ...(state.profile ?? {}), id: 'account-a' },
        }), true);
        vi.spyOn(sync as any, 'resumeViaChanges').mockResolvedValue('aborted');
        await sync.resumeSync('app-foreground');
        expect(rearm).toHaveBeenCalledTimes(2);
    });

    it('pauses on background and resumes on active (disconnect/connect socket + invalidate endpoint)', async () => {
        const { sync } = await import('./sync');

        const onlineState: ManagedEndpointSupervisorState = {
            phase: 'online',
            reason: null,
            attempt: 0,
            nextRetryAt: null,
            lastConnectedAt: Date.now(),
            lastDisconnectedAt: null,
            lastErrorMessage: null,
            lastProbe: { status: 'ready' },
        };

        const invalidate = vi.fn();
        const supervisor: ManagedEndpointSupervisor = {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
            invalidate,
            reportFailure: vi.fn(),
            waitUntilOnline: vi.fn(async () => {}),
            getState: () => onlineState,
            subscribe: () => () => {},
        };

        sync.setActiveEndpointSupervisor(supervisor);

        expect(appStateAddListener).toHaveBeenCalled();
        const handler = Array.from(appStateHandlers)[0];
        expect(handler).toBeTruthy();

        const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
        expect(pauseController.isPaused()).toBe(false);

        handler!('background');
        expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
        expect(pauseController.isPaused()).toBe(true);

        handler!('active');
        expect(apiSocketConnect).toHaveBeenCalledTimes(1);
        expect(invalidate).toHaveBeenCalledTimes(1);
        expect(pauseController.isPaused()).toBe(false);
    });

    it('keeps Tauri desktop sync active when AppState reports background', async () => {
        tauriDesktopState.value = true;
        const { sync } = await import('./sync');

        expect(appStateAddListener).toHaveBeenCalled();
        const handler = Array.from(appStateHandlers)[0];
        expect(handler).toBeTruthy();

        const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
        expect(pauseController.isPaused()).toBe(false);

        handler!('background');

        expect(apiSocketDisconnect).not.toHaveBeenCalled();
        expect(pauseController.isPaused()).toBe(false);
    });

    it('quiesces native crypto worker dispatch on background and resumes it on active', async () => {
        const { Encryption } = await import('./encryption/encryption');
        const markQuiescentSpy = vi.spyOn(Encryption, 'markNativeCryptoWorkerQueueQuiescent');
        const markActiveSpy = vi
            .spyOn(Encryption, 'markNativeCryptoWorkerQueueActive')
            .mockResolvedValue();
        const { sync } = await import('./sync');

        try {
            const handler = Array.from(appStateHandlers)[0];
            expect(handler).toBeTruthy();

            handler!('background');

            expect(markQuiescentSpy).toHaveBeenCalledTimes(1);
            expect(markQuiescentSpy).toHaveBeenCalledWith({
                telemetryEnabled: false,
            });

            handler!('active');

            expect(markActiveSpy).toHaveBeenCalledTimes(1);
            expect(markActiveSpy).toHaveBeenCalledWith({
                telemetryEnabled: false,
                capabilityStalenessMs: 300_000,
                revalidationTimeoutMs: 5_000,
                revalidateCapabilities: undefined,
            });
            expect(sync).toBeTruthy();
        } finally {
            markActiveSpy.mockRestore();
            markQuiescentSpy.mockRestore();
        }
    });

    it('ties JS-thread lag telemetry to the sync performance lifecycle', async () => {
        const existingWindow = (globalThis as unknown as { window?: object }).window ?? {};
        const localStorage = {
            getItem: (key: string) => {
                if (key !== 'HAPPIER_SYNC_TUNING_JSON') return null;
                return JSON.stringify({
                    syncPerformanceTelemetryEnabled: true,
                    jsThreadLagTelemetrySampleIntervalMs: 7,
                    jsThreadLagTelemetryThresholdMs: 9,
                    jsThreadLagTelemetryMaxSamples: 11,
                });
            },
            setItem: vi.fn(),
            removeItem: vi.fn(),
            clear: vi.fn(),
        };
        vi.stubGlobal('window', { ...existingWindow, localStorage });

        const { sync } = await import('./sync');

        expect(createJsThreadLagTelemetryMock).toHaveBeenCalledWith(expect.objectContaining({
            sampleIntervalMs: 7,
            thresholdMs: 9,
            maxSamples: 11,
        }));
        expect(jsThreadLagTelemetryRuntime.start).toHaveBeenCalledTimes(1);

        sync.disconnectServer();

        expect(jsThreadLagTelemetryRuntime.snapshot).toHaveBeenCalledTimes(1);
        expect(jsThreadLagTelemetryRuntime.stop).toHaveBeenCalledTimes(1);
        expect(jsThreadLagTelemetryRuntime.flushSummary).toHaveBeenCalledTimes(1);
        expect(jsThreadLagTelemetryRuntime.reset).toHaveBeenCalledTimes(1);
    });

    it('seeds initial web visibility hidden as backgrounded (pauses immediately on startup)', async () => {
        const globalWithDocument = globalThis as unknown as { document?: unknown };
        const originalDocument = globalWithDocument.document;
        const handlers = new Map<string, Set<() => void>>();
        const documentStub = {
            visibilityState: 'hidden',
            addEventListener: (event: string, listener: () => void) => {
                const set = handlers.get(event) ?? new Set<() => void>();
                set.add(listener);
                handlers.set(event, set);
            },
            removeEventListener: (event: string, listener: () => void) => {
                handlers.get(event)?.delete(listener);
            },
            dispatchEvent: (_event: unknown) => {},
        };
        globalWithDocument.document = documentStub;

        try {
            const { sync } = await import('./sync');
            const { isServerReachabilityNetworkAllowed } = await import('./runtime/connectivity/serverReachabilitySupervisorPool');

            const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
            expect(pauseController.isPaused()).toBe(true);
            expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
            expect(isServerReachabilityNetworkAllowed()).toBe(false);
        } finally {
            globalWithDocument.document = originalDocument;
        }
    });

    it('does not treat Tauri desktop "hidden" visibility as backgrounded (keeps sync unpaused)', async () => {
        tauriDesktopState.value = true;

        const globalWithDocument = globalThis as unknown as { document?: unknown };
        const originalDocument = globalWithDocument.document;
        const handlers = new Map<string, Set<() => void>>();
        const documentStub = {
            visibilityState: 'hidden',
            addEventListener: (event: string, listener: () => void) => {
                const set = handlers.get(event) ?? new Set<() => void>();
                set.add(listener);
                handlers.set(event, set);
            },
            removeEventListener: (event: string, listener: () => void) => {
                handlers.get(event)?.delete(listener);
            },
            dispatchEvent: (_event: unknown) => {},
        };
        globalWithDocument.document = documentStub;

        try {
            const { sync } = await import('./sync');
            const { isServerReachabilityNetworkAllowed } = await import('./runtime/connectivity/serverReachabilitySupervisorPool');

            const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
            expect(pauseController.isPaused()).toBe(false);
            expect(apiSocketDisconnect).toHaveBeenCalledTimes(0);
            expect(isServerReachabilityNetworkAllowed()).toBe(true);
        } finally {
            globalWithDocument.document = originalDocument;
        }
    });

    it('treats Tauri desktop as foreground even when AppState is not active (keeps reachability enabled)', async () => {
        tauriDesktopState.value = true;
        appStateCurrentState.value = 'background';

        const { sync } = await import('./sync');
        const { isServerReachabilityNetworkAllowed } = await import('./runtime/connectivity/serverReachabilitySupervisorPool');

        const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
        expect(pauseController.isPaused()).toBe(false);
        expect(isServerReachabilityNetworkAllowed()).toBe(true);
    });

    it('resumes on web startup when the browser reports the page was discarded', async () => {
        const globalWithDocument = globalThis as unknown as { document?: unknown };
        const originalDocument = globalWithDocument.document;
        const documentStub = {
            visibilityState: 'visible',
            wasDiscarded: true,
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: (_event: unknown) => {},
        };
        globalWithDocument.document = documentStub;

        try {
            await import('./sync');

            expect(apiSocketConnect).toHaveBeenCalledTimes(1);
        } finally {
            globalWithDocument.document = originalDocument;
        }
    });

    it('pauses on web visibility hidden and resumes on visible', async () => {
        const globalWithDocument = globalThis as unknown as { document?: unknown };
        const originalDocument = globalWithDocument.document;
        const handlers = new Map<string, Set<() => void>>();
        const documentStub = {
            visibilityState: 'visible',
            addEventListener: (event: string, listener: () => void) => {
                const set = handlers.get(event) ?? new Set<() => void>();
                set.add(listener);
                handlers.set(event, set);
            },
            removeEventListener: (event: string, listener: () => void) => {
                handlers.get(event)?.delete(listener);
            },
            dispatchEvent: (_event: unknown) => {},
        };
        globalWithDocument.document = documentStub;

        try {
            const { sync } = await import('./sync');

            const onlineState: ManagedEndpointSupervisorState = {
                phase: 'online',
                reason: null,
                attempt: 0,
                nextRetryAt: null,
                lastConnectedAt: Date.now(),
                lastDisconnectedAt: null,
                lastErrorMessage: null,
                lastProbe: { status: 'ready' },
            };

            const invalidate = vi.fn();
            const supervisor: ManagedEndpointSupervisor = {
                start: vi.fn(async () => {}),
                stop: vi.fn(async () => {}),
                invalidate,
                reportFailure: vi.fn(),
                waitUntilOnline: vi.fn(async () => {}),
                getState: () => onlineState,
                subscribe: () => () => {},
            };

            sync.setActiveEndpointSupervisor(supervisor);

            const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
            expect(pauseController.isPaused()).toBe(false);
            expect(apiSocketDisconnect).toHaveBeenCalledTimes(0);

            documentStub.visibilityState = 'hidden';
            for (const handler of handlers.get('visibilitychange') ?? []) {
                handler();
            }
            expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
            expect(pauseController.isPaused()).toBe(true);

            documentStub.visibilityState = 'visible';
            for (const handler of handlers.get('visibilitychange') ?? []) {
                handler();
            }
            expect(apiSocketConnect).toHaveBeenCalledTimes(1);
            expect(invalidate).toHaveBeenCalledTimes(1);
            expect(pauseController.isPaused()).toBe(false);
        } finally {
            globalWithDocument.document = originalDocument;
        }
    });
});

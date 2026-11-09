import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';

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
const platformOs = vi.hoisted(() => ({ value: 'web' as 'web' | 'ios' }));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => tauriDesktopState.value,
    desktopHostKind: () => tauriDesktopState.value ? 'tauri' : null,
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
            Platform: {
                get OS() {
                    return platformOs.value;
                },
            },
            AppState: {
                get currentState() {
                    return appStateCurrentState.value;
                },
                addEventListener: appStateAddListener as any,
            },
        },
    );
});

const socketStatusHandlers = vi.hoisted(() => new Set<(status: 'disconnected' | 'connecting' | 'connected' | 'error') => void>());
const apiSocketDisconnect = vi.hoisted(() => vi.fn(() => {
    for (const handler of socketStatusHandlers) handler('disconnected');
}));
const apiSocketConnect = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onError: vi.fn(),
        onReconnected: vi.fn(),
        onStatusChange: vi.fn((handler: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void) => {
            socketStatusHandlers.add(handler);
            return () => socketStatusHandlers.delete(handler);
        }),
        onConnectionStateChange: vi.fn(() => () => {}),
        onSessionConsumptionAdmitted: vi.fn(() => () => {}),
        connect: apiSocketConnect,
        disconnect: apiSocketDisconnect,
        initialize: vi.fn(),
        invalidateRequests: vi.fn(),
        request: vi.fn(async () => new Response('ok', { status: 200 })),
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

await loadSyncSingletonForTests();

describe('sync AppState pause/resume', () => {
    beforeEach(() => {
        vi.resetModules();
        kvStore.clear();
        appStateHandlers.clear();
        socketStatusHandlers.clear();
        appStateAddListener.mockClear();
        appStateCurrentState.value = 'active';
        platformOs.value = 'web';
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

    it('keeps native socket connectivity during routine background while a Voice activity lease is active', async () => {
        platformOs.value = 'ios';
        await loadSyncSingletonForTests();
        const { sync } = await import('./sync');
        const { isServerReachabilityNetworkAllowed } = await import('./runtime/connectivity/serverReachabilitySupervisorPool');
        const releaseActivityLease = sync.acquireUserRequestLease();
        apiSocketDisconnect.mockClear();

        for (const handler of appStateHandlers) handler('background');

        expect(apiSocketDisconnect).not.toHaveBeenCalled();
        expect(isServerReachabilityNetworkAllowed()).toBe(true);

        releaseActivityLease();

        expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
        expect(isServerReachabilityNetworkAllowed()).toBe(false);
    });

    it('runs one changes-only catch-up after an intentional foreground connection reports subscribed', async () => {
        platformOs.value = 'ios';
        await loadSyncSingletonForTests();
        const { sync } = await import('./sync');
        (sync as unknown as { subscribeToUpdates(): void }).subscribeToUpdates();
        const resumeSync = vi.spyOn(sync, 'resumeSync').mockResolvedValue(undefined);
        apiSocketDisconnect.mockClear();

        for (const handler of socketStatusHandlers) handler('connected');
        for (const handler of appStateHandlers) handler('background');
        expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);

        for (const handler of appStateHandlers) handler('active');
        expect(resumeSync).toHaveBeenCalledWith('app-foreground');

        for (const handler of socketStatusHandlers) handler('connected');
        for (const handler of socketStatusHandlers) handler('connected');

        expect(resumeSync.mock.calls.map(([reason]) => reason)).toEqual([
            'app-foreground',
            'changes-catch-up',
        ]);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('rearms only current-scope durable outbox sessions once without mounting a session route', async () => {
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { storage } = await import('./domains/state/storage');
        const { savePendingOutboxMessage } = await import('./domains/state/pendingOutboxPersistence');
        const profile = await upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
        const activeScope = {
            serverId: String(getActiveServerSnapshot().serverId ?? profile.id),
            accountId: 'account-a',
        } as const;
        const otherScope = { ...activeScope, accountId: 'account-b' } as const;
        storage.getState().activateProfileScope(activeScope);

        const save = async (sessionId: string, localId: string, scope: ServerAccountScope) => {
            (await savePendingOutboxMessage({
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
            }, scope));
        };
        (await save('session-b', 'local-b', activeScope));
        (await save('session-a', 'local-a', activeScope));
        (await save('other-account-session', 'other-local', otherScope));

        await loadSyncSingletonForTests();

        const { sync } = await import('./sync');
        const { publishAppliedActiveServerSnapshot } = await import('./runtime/orchestration/appliedActiveServerRuntime');
        const { getActiveServerAccountScope } = await import('./domains/scope/activeServerAccountScope');
        // Configured Home selection alone does not establish a serving runtime.
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        expect(getActiveServerAccountScope()).toEqual(activeScope);
        let releaseReplay!: () => void;
        const replayBarrier = new Promise<void>((resolve) => {
            releaseReplay = resolve;
        });
        const fetchPendingMessages = vi.spyOn(sync, 'fetchPendingMessages')
            .mockImplementation(async () => replayBarrier);

        const owner = sync as unknown as { rearmPendingOutboxForActiveScope(): Promise<void> };
        const first = owner.rearmPendingOutboxForActiveScope();
        const second = owner.rearmPendingOutboxForActiveScope();
        try {
            expect(second).toBe(first);
            // IndexedDB completes on a later task, not the next microtask.
            await vi.waitFor(() => expect(fetchPendingMessages.mock.calls).toEqual([
                ['session-a', activeScope],
                ['session-b', activeScope],
            ]));
        } finally {
            releaseReplay();
            await Promise.all([first, second]);
        }
    });

    it('invokes durable outbox rearm from both bootstrap and the foreground resume pipeline', async () => {
        const { InvalidateSync } = await import('@/utils/sessions/sync');
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { storage } = await import('./domains/state/storage');
        upsertAndActivateServer({ serverUrl: 'http://localhost:53288', scope: 'tab' });
        storage.getState().activateProfileScope({
            serverId: String(getActiveServerSnapshot().serverId ?? ''),
            accountId: 'account-a',
        });

        await loadSyncSingletonForTests();

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: 'token', secret: 'secret' };
        (sync as any).serverID = 'account-a';
        const rearm = vi.spyOn(sync as any, 'rearmPendingOutboxForActiveScope').mockResolvedValue(undefined);
        const syncUnit = new InvalidateSync(async () => {});
        for (const field of [
            'settingsSync',
            'profileSync',
            'accountPetsSync',
            'sessionsSync',
            'machinesSync',
            'pluginAvailabilitySync',
            'purchasesSync',
            'artifactsSync',
            'automationsSync',
            'todosSync',
            'friendsSync',
            'feedSync',
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
        vi.spyOn(sync as any, 'resumeViaChanges').mockResolvedValue({
            status: 'aborted',
            refreshedByCatchUp: { sessions: false, machines: false },
        });
        await sync.resumeSync('app-foreground');
        expect(rearm).toHaveBeenCalledTimes(2);
    });

    it('resumes a paused bootstrap after core readiness when draft hydration is unavailable', async () => {
        const { InvalidateSync } = await import('@/utils/sessions/sync');
        await loadSyncSingletonForTests();
        const { sync } = await import('./sync');
        const { storage } = await import('./domains/state/storage');
        const events: string[] = [];
        const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;

        (sync as any).credentials = { token: 'token', secret: 'secret' };
        (sync as any).serverID = 'account-a';
        vi.spyOn(sync as any, 'ensureSessionDraftRepositoryRuntimeReady').mockRejectedValue(new Error('draft snapshot unavailable'));
        vi.spyOn(sync as any, 'rearmPendingOutboxForActiveScope').mockResolvedValue(undefined);
        vi.spyOn(storage.getState(), 'applyReady').mockImplementation(() => {
            events.push('ready');
        });

        for (const field of [
            'settingsSync',
            'profileSync',
            'accountPetsSync',
            'sessionsSync',
            'machinesSync',
            'pluginAvailabilitySync',
            'purchasesSync',
            'automationsSync',
            'todosSync',
            'friendsSync',
            'feedSync',
            'nativeUpdateSync',
        ]) {
            (sync as any)[field] = new InvalidateSync(async () => { events.push(field); });
        }
        (sync as any).artifactsSync = new InvalidateSync(async () => { events.push('artifacts'); });

        pauseController.pause();
        const bootstrap = (sync as any).bootstrapSync() as Promise<void>;
        await Promise.resolve();
        expect(events).toEqual([]);

        pauseController.resume();
        await bootstrap;

        // This isolated bootstrap harness has no mounted Artifact inventory consumer.
        // The real HTTP count contract lives in sync.artifactInventoryDemand.test.tsx.
        expect(events).toContain('ready');
    });

    it('pauses on background and resumes on active (disconnect/connect socket)', async () => {
        await loadSyncSingletonForTests();
        const { sync } = await import('./sync');

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
        expect(pauseController.isPaused()).toBe(false);
    });

    it('keeps Tauri desktop sync active when AppState reports background', async () => {
        tauriDesktopState.value = true;
        await loadSyncSingletonForTests();
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
        await loadSyncSingletonForTests();
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

        await loadSyncSingletonForTests();

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
        const browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
        vi.spyOn(browser.document, 'visibilityState', 'get').mockReturnValue('hidden');

        try {
            await loadSyncSingletonForTests();
            const { sync } = await import('./sync');
            const { isServerReachabilityNetworkAllowed } = await import('./runtime/connectivity/serverReachabilitySupervisorPool');

            const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
            expect(pauseController.isPaused()).toBe(true);
            expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
            expect(isServerReachabilityNetworkAllowed()).toBe(false);
        } finally {
            browser.restore();
        }
    });

    it('does not treat Tauri desktop "hidden" visibility as backgrounded (keeps sync unpaused)', async () => {
        tauriDesktopState.value = true;

        const browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
        vi.spyOn(browser.document, 'visibilityState', 'get').mockReturnValue('hidden');

        try {
            await loadSyncSingletonForTests();
            const { sync } = await import('./sync');
            const { isServerReachabilityNetworkAllowed } = await import('./runtime/connectivity/serverReachabilitySupervisorPool');

            const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
            expect(pauseController.isPaused()).toBe(false);
            expect(apiSocketDisconnect).toHaveBeenCalledTimes(0);
            expect(isServerReachabilityNetworkAllowed()).toBe(true);
        } finally {
            browser.restore();
        }
    });

    it('treats Tauri desktop as foreground even when AppState is not active (keeps reachability enabled)', async () => {
        tauriDesktopState.value = true;
        appStateCurrentState.value = 'background';

        await loadSyncSingletonForTests();

        const { sync } = await import('./sync');
        const { isServerReachabilityNetworkAllowed } = await import('./runtime/connectivity/serverReachabilitySupervisorPool');

        const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
        expect(pauseController.isPaused()).toBe(false);
        expect(isServerReachabilityNetworkAllowed()).toBe(true);
    });

    it('resumes on web startup when the browser reports the page was discarded', async () => {
        const browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
        Object.defineProperty(browser.document, 'wasDiscarded', { value: true });

        try {
            await loadSyncSingletonForTests();

            expect(apiSocketConnect).toHaveBeenCalledTimes(1);
        } finally {
            browser.restore();
        }
    });

    it('pauses on web visibility hidden and resumes on visible', async () => {
        const browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
        const visibility = vi.spyOn(browser.document, 'visibilityState', 'get').mockReturnValue('visible');

        try {
            await loadSyncSingletonForTests();
            const { sync } = await import('./sync');

            const pauseController = (sync as unknown as { pauseController: PauseController }).pauseController;
            expect(pauseController.isPaused()).toBe(false);
            expect(apiSocketDisconnect).toHaveBeenCalledTimes(0);

            visibility.mockReturnValue('hidden');
            browser.document.dispatchEvent(new browser.window.Event('visibilitychange'));
            expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
            expect(pauseController.isPaused()).toBe(true);

            visibility.mockReturnValue('visible');
            browser.document.dispatchEvent(new browser.window.Event('visibilitychange'));
            expect(apiSocketConnect).toHaveBeenCalledTimes(1);
            expect(pauseController.isPaused()).toBe(false);
        } finally {
            browser.restore();
        }
    });

    it('keeps socket reachability through routine hidden visibility until pre-accept leases settle', async () => {
        const browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
        const visibility = vi.spyOn(browser.document, 'visibilityState', 'get').mockReturnValue('visible');

        try {
            await loadSyncSingletonForTests();
            const { sync } = await import('./sync');
            const { isServerReachabilityNetworkAllowed } = await import('./runtime/connectivity/serverReachabilitySupervisorPool');
            const releaseAcceptanceLease = sync.acquireUserRequestLease();

            visibility.mockReturnValue('hidden');
            browser.document.dispatchEvent(new browser.window.Event('visibilitychange'));

            expect(apiSocketDisconnect).not.toHaveBeenCalled();
            expect(isServerReachabilityNetworkAllowed()).toBe(true);

            releaseAcceptanceLease();

            expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
            expect(isServerReachabilityNetworkAllowed()).toBe(false);
        } finally {
            browser.restore();
        }
    });

    it.each(['pagehide', 'freeze'] as const)('%s remains an immediate hard boundary during pre-accept', async (eventName) => {
        const browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
        const lifecycleHandlers = new Map<string, (event?: unknown) => void>();
        vi.stubGlobal('addEventListener', (event: string, listener: (event?: unknown) => void) => {
            lifecycleHandlers.set(event, listener);
        });

        try {
            await loadSyncSingletonForTests();
            const { sync } = await import('./sync');
            const { isServerReachabilityNetworkAllowed } = await import('./runtime/connectivity/serverReachabilitySupervisorPool');
            sync.acquireUserRequestLease();

            lifecycleHandlers.get(eventName)?.();

            expect(apiSocketDisconnect).toHaveBeenCalledTimes(1);
            expect(isServerReachabilityNetworkAllowed()).toBe(false);
        } finally {
            browser.restore();
        }
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reportServerUnreachableSpy = vi.fn<(...args: any[]) => void>();
const startServerReachabilitySupervisorSpy = vi.fn<(...args: any[]) => Promise<void>>(async () => {});

function onlineState() {
    return {
        phase: 'online',
        reason: 'initial_connect',
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: Date.now(),
        lastDisconnectedAt: null,
        lastErrorMessage: null,
    };
}

describe('concurrentSessionCache teardown ordering', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        reportServerUnreachableSpy.mockReset();
        startServerReachabilitySupervisorSpy.mockClear();
    });

    afterEach(async () => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.resetModules();
        vi.clearAllMocks();
        try {
            const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
            await resetServerReachabilitySupervisors();
        } catch {
            // ignore
        }
        delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
        delete process.env.EXPO_PUBLIC_HAPPIER_CONCURRENT_CACHE_REFRESH_INTERVAL_MS;
    });

    it('does not report server unreachable during intentional stop teardown', async () => {
        process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
        process.env.EXPO_PUBLIC_HAPPIER_CONCURRENT_CACHE_REFRESH_INTERVAL_MS = '600000';

        vi.doMock('@/sync/runtime/connectivity/serverReachabilitySupervisorPool', () => ({
            subscribeServerReachabilityState: (_serverUrl: string, listener: (state: any) => void) => {
                setTimeout(() => {
                    listener(onlineState());
                }, 0);
                return () => {};
            },
            startServerReachabilitySupervisor: startServerReachabilitySupervisorSpy,
            reportServerUnreachable: reportServerUnreachableSpy,
        }));

        vi.doMock('@/auth/storage/tokenStorage', () => ({
            TokenStorage: {
                getCredentialsForServerUrl: vi.fn(async () => ({ token: 'token-b', secret: 'secret-b' })),
            },
            isLegacyAuthCredentials: () => true,
        }));

        vi.doMock('@/sync/domains/server/serverProfiles', () => ({
            listServerProfiles: () => [
                { id: 'server-a', serverUrl: 'https://stack-a.example.test', name: 'Server A' },
                { id: 'server-b', serverUrl: 'https://stack-b.example.test', name: 'Server B' },
            ],
        }));

        vi.doMock('@/sync/domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({ serverId: 'server-a', serverUrl: 'https://stack-a.example.test', kind: 'stack', generation: 1 }),
            subscribeActiveServer: () => () => {},
        }));

        vi.doMock('@/sync/encryption/encryption', () => ({
            Encryption: {
                create: async () => ({}) as unknown,
            },
        }));

        vi.doMock('@/encryption/base64', () => ({
            decodeBase64: () => new Uint8Array(32),
        }));

        vi.doMock('@/sync/engine/sessions/sessionSnapshot', () => ({
            fetchAndApplySessions: async ({ applySessions }: { applySessions: (sessions: unknown[]) => void }) => {
                applySessions([]);
            },
        }));

        vi.doMock('@/sync/engine/machines/syncMachines', () => ({
            fetchAndApplyMachines: async ({ applyMachines }: { applyMachines: (machines: unknown[]) => void }) => {
                applyMachines([]);
            },
        }));

        vi.doMock('./concurrentServerConnections/createConcurrentServerSocketTransport', () => {
            const connectedListeners = new Set<() => void>();
            const disconnectedListeners = new Set<(event: any) => void>();
            const errorListeners = new Set<(error: unknown) => void>();
            let connected = false;

            const transport = {
                async connect() {
                    connected = true;
                    connectedListeners.forEach((listener) => listener());
                },
                async disconnect(params?: { intentional?: boolean }) {
                    connected = false;
                    disconnectedListeners.forEach((listener) => listener({
                        intentional: params?.intentional === true,
                        reason: params?.intentional === true ? 'manual' : 'disconnect',
                    }));
                },
                async destroy() {
                    // Simulate a buggy transport that emits a non-intentional disconnect during teardown.
                    disconnectedListeners.forEach((listener) => listener({ intentional: false, reason: 'destroy' }));
                    connected = false;
                    connectedListeners.clear();
                    disconnectedListeners.clear();
                    errorListeners.clear();
                },
                isConnected() {
                    return connected;
                },
                onConnected(listener: () => void) {
                    connectedListeners.add(listener);
                    return () => connectedListeners.delete(listener);
                },
                onDisconnected(listener: (event: any) => void) {
                    disconnectedListeners.add(listener);
                    return () => disconnectedListeners.delete(listener);
                },
                onError(listener: (error: unknown) => void) {
                    errorListeners.add(listener);
                    return () => errorListeners.delete(listener);
                },
            };

            return {
                createConcurrentServerSocketTransport: () => ({
                    socket: { on: vi.fn(), off: vi.fn(), onAny: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), removeAllListeners: vi.fn() },
                    transport,
                }),
            };
        });

        const { storage } = await import('@/sync/domains/state/storageStore');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        storage.setState((state) => ({
            ...state,
            settings: {
                ...state.settings,
                ...settingsDefaults,
                serverSelectionGroups: [
                    {
                        id: 'group-main',
                        name: 'Main',
                        serverIds: ['server-a', 'server-b'],
                        presentation: 'grouped',
                    },
                ],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'group-main',
            },
        }));

        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('./concurrentSessionCache');
        startConcurrentSessionCacheSync();
        await vi.advanceTimersByTimeAsync(1);

        stopConcurrentSessionCacheSync();

        expect(startServerReachabilitySupervisorSpy).toHaveBeenCalled();
        expect(reportServerUnreachableSpy).not.toHaveBeenCalled();
    });
});

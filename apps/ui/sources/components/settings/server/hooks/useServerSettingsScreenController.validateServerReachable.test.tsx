import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, flushHookEffects } from '@/dev/testkit';
import { installServerSettingsHooksCommonModuleMocks } from './serverSettingsHooksTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const runtimeFetchMock = vi.hoisted(() => vi.fn());
const tauriDesktopState = vi.hoisted(() => ({ enabled: false }));
const systemTaskRunnerState = vi.hoisted(() => {
    const state = {
        nextResult: null as import('@happier-dev/protocol').SystemTaskResult | null,
        startMock: vi.fn(async (_spec: unknown) => 'task_1'),
        cancelMock: vi.fn(async () => {}),
        respondMock: vi.fn(async () => {}),
        getSnapshotMock: vi.fn((taskId: string) => {
            const result = state.nextResult;
            if (!result || result.taskId !== taskId) {
                return null;
            }
            return {
                taskId,
                status: result.ok ? 'succeeded' : 'failed',
                currentStepId: null,
                latestMessage: result.ok ? null : result.error.message,
                awaitingInput: false,
                cancelRequested: false,
                events: [],
                result,
            };
        }),
        subscribeMock: vi.fn((taskId: string, _listenerOrOnEvent?: unknown, onResult?: (result: import('@happier-dev/protocol').SystemTaskResult) => void) => {
            const result = state.nextResult;
            if (result && typeof onResult === 'function') {
                queueMicrotask(() => {
                    onResult({ ...result, taskId });
                });
            }
            return () => {};
        }),
    };
    return state;
});

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => tauriDesktopState.enabled,
}));

vi.mock('@/components/systemTasks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/systemTasks')>();
    return {
        ...actual,
        getDefaultSystemTaskRunner: () => ({
            mode: 'tauri' as const,
            start: systemTaskRunnerState.startMock,
            cancel: systemTaskRunnerState.cancelMock,
            respond: systemTaskRunnerState.respondMock,
            getSnapshot: systemTaskRunnerState.getSnapshotMock,
            subscribe: systemTaskRunnerState.subscribeMock,
        }),
        useSystemTaskSnapshot: (runner: {
            subscribe: (taskId: string, onEvent?: ((event: unknown) => void) | undefined, onResult?: ((result: import('@happier-dev/protocol').SystemTaskResult) => void) | undefined) => () => void;
        }, taskId: string | null) => {
            const [snapshot, setSnapshot] = React.useState<import('@/components/systemTasks/types').SystemTaskRunState | null>(null);

            React.useEffect(() => {
                if (!taskId) {
                    setSnapshot(null);
                    return;
                }

                let disposed = false;
                setSnapshot({
                    taskId,
                    status: 'running',
                    currentStepId: null,
                    latestMessage: null,
                    awaitingInput: false,
                    cancelRequested: false,
                    events: [],
                    result: null,
                });

                const unsubscribe = runner.subscribe(taskId, undefined, (result) => {
                    if (disposed) return;
                    setSnapshot({
                        taskId,
                        status: result.ok ? 'succeeded' : 'failed',
                        currentStepId: null,
                        latestMessage: null,
                        awaitingInput: false,
                        cancelRequested: false,
                        events: [],
                        result,
                    });
                });

                return () => {
                    disposed = true;
                    unsubscribe();
                };
            }, [runner, taskId]);

            return snapshot;
        },
    };
});

const routerReplaceMock = vi.fn();
const modalAlertMock = vi.fn();
const modalConfirmMock = vi.fn(async () => true);

const settingsState = {
    serverSelectionGroups: [] as any[],
    serverSelectionActiveTargetKind: null as 'server' | 'group' | null,
    serverSelectionActiveTargetId: null as string | null,
};
const storageState = settingsState as Record<string, unknown>;
const useSettingMutableMock = ((key: string) => [
    storageState[key],
    (value: unknown) => {
        storageState[key] = value;
    },
]) as typeof import('@/sync/domains/state/storage')['useSettingMutable'];

installServerSettingsHooksCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { replace: routerReplaceMock },
            params: {},
        }).module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlertMock,
                confirm: modalConfirmMock,
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSettingMutable: useSettingMutableMock,
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: vi.fn(async () => {}) }),
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: vi.fn(async () => {}),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-a', serverUrl: 'https://a.example.test', generation: 1 }),
    listServerProfiles: () => [{ id: 'server-a', name: 'A', serverUrl: 'https://a.example.test', lastUsedAt: 0 }],
    getActiveServerId: () => 'server-a',
    getDeviceDefaultServerId: () => 'server-a',
    getTabActiveServerId: () => null,
    getResetToDefaultServerId: () => 'server-a',
    clearTabActiveServerId: vi.fn(),
    subscribeActiveServer: vi.fn(() => () => {}),
    setActiveServerId: vi.fn(),
    upsertServerProfile: vi.fn(() => ({ id: 'server-a', serverUrl: 'https://a.example.test', name: 'A' })),
    removeServerProfile: vi.fn(),
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    validateServerUrl: () => ({ valid: true, error: null }),
}));

vi.mock('@/sync/domains/server/url/serverUrlClassification', () => ({
    isInsecureRemoteHttpServerUrl: () => false,
}));

vi.mock('@/sync/domains/server/selection/serverSelectionMutations', () => ({
    normalizeStoredServerSelectionGroups: (raw: unknown) => (Array.isArray(raw) ? raw : []),
    filterServerSelectionGroupsToAvailableServers: (profiles: any) => profiles,
}));

vi.mock('@/components/settings/server/hooks/useServerAuthStatusByServerId', () => ({
    useServerAuthStatusByServerId: () => ({}),
}));

vi.mock('@/components/settings/server/hooks/useServerAutoAddFromRoute', () => ({
    useServerAutoAddFromRoute: () => {},
}));

vi.mock('@/components/settings/server/hooks/useServerSettingsServerProfileActions', () => ({
    useServerSettingsServerProfileActions: () => ({
        onSwitchServer: vi.fn(async () => {}),
        onRenameServer: vi.fn(async () => {}),
        onRemoveServer: vi.fn(async () => {}),
    }),
}));

vi.mock('@/components/settings/server/hooks/useServerSettingsGroupActions', () => ({
    useServerSettingsGroupActions: () => ({
        onSwitchGroup: vi.fn(async () => {}),
        onRenameGroup: vi.fn(async () => {}),
        onRemoveGroup: vi.fn(async () => {}),
        onCreateServerGroup: vi.fn(async () => false),
    }),
}));

vi.mock('@/components/settings/server/hooks/useServerSettingsConcurrentActions', () => ({
    useServerSettingsConcurrentActions: () => ({
        onTogglePresentation: vi.fn(),
        onToggleConcurrentServer: vi.fn(),
    }),
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: vi.fn(async () => ({ status: 'error', reason: 'network' })),
}));

function createNeverEndingFetch(): (url: unknown, init?: RequestInit) => Promise<Response> {
    return async (_url: unknown, init?: RequestInit) => {
        const signal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
            if (!signal) return;
            if (signal.aborted) {
                const error = new Error('Aborted');
                (error as any).name = 'AbortError';
                reject(error);
                return;
            }
            signal.addEventListener('abort', () => {
                const error = new Error('Aborted');
                (error as any).name = 'AbortError';
                reject(error);
            }, { once: true });
        });
    };
}

describe('useServerSettingsScreenController (server validation)', () => {
    afterEach(() => {
        runtimeFetchMock.mockReset();
        tauriDesktopState.enabled = false;
        systemTaskRunnerState.nextResult = null;
        systemTaskRunnerState.startMock.mockReset();
        systemTaskRunnerState.cancelMock.mockReset();
        systemTaskRunnerState.respondMock.mockReset();
        systemTaskRunnerState.getSnapshotMock.mockReset();
        systemTaskRunnerState.subscribeMock.mockReset();
        routerReplaceMock.mockReset();
        modalAlertMock.mockReset();
        modalConfirmMock.mockReset();
        storageState['serverSelectionGroups'] = [];
        storageState['serverSelectionActiveTargetKind'] = null;
        storageState['serverSelectionActiveTargetId'] = null;
        vi.useRealTimers();
        vi.clearAllMocks();
        vi.resetModules();
    });

    it('clears isValidating and shows an error when reachability validation times out', async () => {
        vi.useFakeTimers();
        runtimeFetchMock.mockImplementation(createNeverEndingFetch());

        const { useServerSettingsScreenController } = await import('./useServerSettingsScreenController');

        let value: any = null;
        function Probe() {
            value = useServerSettingsScreenController();
            return null;
        }

        await renderScreen(React.createElement(Probe));
        await act(async () => {
            value.onChangeUrl('https://unreachable.example.test');
        });

        await act(async () => {
            void value.onAddServer();
        });
        await flushHookEffects({ advanceTimersMs: 1 });
        expect(value.isValidating).toBe(true);

        await flushHookEffects({ advanceTimersMs: 5_000 });

        expect(value.isValidating).toBe(false);
        expect(value.error).toBe('server.failedToConnectToServer');
        expect(value.reachabilityRemediation).toBeNull();
    });

    it('cancels previous validation without clearing isValidating until the latest attempt settles', async () => {
        vi.useFakeTimers();
        runtimeFetchMock.mockImplementation(createNeverEndingFetch());

        const { useServerSettingsScreenController } = await import('./useServerSettingsScreenController');

        let value: any = null;
        function Probe() {
            value = useServerSettingsScreenController();
            return null;
        }

        await renderScreen(React.createElement(Probe));
        await act(async () => {
            value.onChangeUrl('https://unreachable.example.test');
        });

        await act(async () => {
            void value.onAddServer();
        });
        await flushHookEffects({ advanceTimersMs: 1 });
        expect(value.isValidating).toBe(true);
        expect(value.error).toBe(null);

        await act(async () => {
            void value.onAddServer();
        });
        await flushHookEffects({ advanceTimersMs: 1 });
        expect(value.isValidating).toBe(true);
        expect(value.error).toBe(null);

        await flushHookEffects({ advanceTimersMs: 5_000 });
        expect(value.isValidating).toBe(false);
        expect(value.error).toBe('server.failedToConnectToServer');
        expect(value.reachabilityRemediation).toBeNull();
    });

    it('treats a 401 response from /health as reachable (server requires auth but is online)', async () => {
        runtimeFetchMock.mockResolvedValueOnce({
            ok: false,
            status: 401,
            headers: new Headers(),
        });

        const { useServerSettingsScreenController } = await import('./useServerSettingsScreenController');

        let value: any = null;
        function Probe() {
            value = useServerSettingsScreenController();
            return null;
        }

        await renderScreen(React.createElement(Probe));
        await act(async () => {
            value.onChangeUrl('https://auth-required.example.test');
            value.onChangeName('Auth Required');
        });

        await act(async () => {
            await value.onAddServer();
        });

        expect(value.error).toBe(null);
        expect(value.reachabilityRemediation).toBeNull();
    });

    it('exposes Tailscale guidance when a ts.net relay is unreachable', async () => {
        vi.useFakeTimers();
        runtimeFetchMock.mockImplementation(createNeverEndingFetch());

        const { useServerSettingsScreenController } = await import('./useServerSettingsScreenController');

        let value: any = null;
        function Probe() {
            value = useServerSettingsScreenController();
            return null;
        }

        await renderScreen(React.createElement(Probe));
        await act(async () => {
            value.onChangeUrl('https://relay.example.ts.net');
        });

        await act(async () => {
            void value.onAddServer();
        });

        await flushHookEffects({ advanceTimersMs: 5_000 });

        expect(value.error).toBe('server.failedToConnectToServer');
        expect(value.reachabilityRemediation).toMatchObject({
            kind: 'tailscale_unreachable',
            titleKey: 'server.reachabilityRemediation.tailscale.title',
            bodyKey: 'server.reachabilityRemediation.tailscale.webBody',
        });
        expect(value.reachabilityRemediation.actions).toEqual([
            {
                id: 'install_tailscale',
                kind: 'external-url',
                labelKey: 'server.reachabilityRemediation.tailscale.installAction',
                url: 'https://tailscale.com/download',
            },
            {
                id: 'retry',
                kind: 'retry',
                labelKey: 'common.retry',
            },
        ]);
    });

    it('runs desktop tailscale remediation through the system-task runner and retries validation after success', async () => {
        vi.useFakeTimers();
        tauriDesktopState.enabled = true;
        runtimeFetchMock
            .mockImplementationOnce(createNeverEndingFetch())
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers(),
            });
        systemTaskRunnerState.startMock.mockResolvedValueOnce('task_prepare_tailscale_1');
        systemTaskRunnerState.nextResult = {
            protocolVersion: 1,
            taskId: 'task_prepare_tailscale_1',
            ok: true,
            data: {
                tailscaleInstalled: true,
                tailscaleLoggedIn: true,
                authUrl: null,
            },
        };

        const { useServerSettingsScreenController } = await import('./useServerSettingsScreenController');

        let value: any = null;
        function Probe() {
            value = useServerSettingsScreenController();
            return null;
        }

        await renderScreen(React.createElement(Probe));
        await act(async () => {
            value.onChangeUrl('https://relay.example.ts.net');
        });

        await act(async () => {
            void value.onAddServer();
        });

        await flushHookEffects({ advanceTimersMs: 5_000 });

        expect(value.reachabilityRemediation?.actions).toEqual([
            {
                id: 'prepare_tailscale',
                kind: 'callback',
                labelKey: 'server.reachabilityRemediation.tailscale.desktopPrepareAction',
                callbackSlot: 'tailscale.ensureReady',
            },
            {
                id: 'retry',
                kind: 'retry',
                labelKey: 'common.retry',
            },
        ]);

        await act(async () => {
            await value.onReachabilityRemediationAction('prepare_tailscale');
        });

        expect(systemTaskRunnerState.startMock).toHaveBeenCalledWith({
            protocolVersion: 1,
            kind: 'tailscale.ensureReady.v1',
            params: {
                installPolicy: 'installIfMissing',
                loginPolicy: 'interactive',
                mode: 'normalUser',
            },
        });
        expect(value.error).toBe(null);
        expect(value.reachabilityRemediation).toBe(null);
    });

    it('surfaces a desktop remediation task failure inline and keeps guidance visible', async () => {
        vi.useFakeTimers();
        tauriDesktopState.enabled = true;
        runtimeFetchMock.mockImplementationOnce(createNeverEndingFetch());
        systemTaskRunnerState.startMock.mockResolvedValueOnce('task_prepare_tailscale_2');
        systemTaskRunnerState.nextResult = {
            protocolVersion: 1,
            taskId: 'task_prepare_tailscale_2',
            ok: false,
            error: {
                code: 'prompt_required',
                message: 'Complete Tailscale sign-in before enabling secure access.',
            },
        };

        const { useServerSettingsScreenController } = await import('./useServerSettingsScreenController');

        let value: any = null;
        function Probe() {
            value = useServerSettingsScreenController();
            return null;
        }

        await renderScreen(React.createElement(Probe));
        await act(async () => {
            value.onChangeUrl('https://relay.example.ts.net');
        });

        await act(async () => {
            void value.onAddServer();
        });

        await flushHookEffects({ advanceTimersMs: 5_000 });

        await act(async () => {
            await value.onReachabilityRemediationAction('prepare_tailscale');
        });

        expect(value.error).toBe('Complete Tailscale sign-in before enabling secure access.');
        expect(value.reachabilityRemediation).toMatchObject({
            kind: 'tailscale_unreachable',
            bodyKey: 'server.reachabilityRemediation.tailscale.desktopBody',
        });
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    });
});

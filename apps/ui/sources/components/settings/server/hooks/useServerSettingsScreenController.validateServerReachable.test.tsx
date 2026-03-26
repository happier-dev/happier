import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, flushHookEffects } from '@/dev/testkit';
import { installServerSettingsHooksCommonModuleMocks } from './serverSettingsHooksTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const runtimeFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

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
    listServerProfiles: () => [{ id: 'server-a', name: 'A', serverUrl: 'https://a.example.test', lastUsedAt: 0 }],
    getActiveServerId: () => 'server-a',
    getDeviceDefaultServerId: () => 'server-a',
    getResetToDefaultServerId: () => 'server-a',
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
    });
});

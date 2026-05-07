import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installServerSettingsHooksCommonModuleMocks } from './serverSettingsHooksTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const runtimeFetchMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ ok: true })));
const routerReplaceMock = vi.fn();
const setActiveServerIdMock = vi.fn();
const switchConnectionToActiveServerMock = vi.fn(async () => {});
const refreshFromActiveServerMock = vi.fn(async () => {});
const promptSignedOutServerSwitchConfirmationMock = vi.hoisted(() => vi.fn(async () => true));
const activeServerSnapshot = {
    serverId: 'server-a',
    serverUrl: 'https://a.example.test',
    generation: 1,
};
const pendingTerminalConnectMock = vi.hoisted(() => ({
    current: null as { publicKeyB64Url: string; serverUrl: string } | null,
    set: vi.fn((value: { publicKeyB64Url: string; serverUrl: string }) => {
        pendingTerminalConnectMock.current = value;
    }),
}));

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

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: refreshFromActiveServerMock }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: vi.fn(async () => null),
    },
}));

vi.mock('@/components/settings/server/modals/ServerSwitchAuthPrompt', () => ({
    promptSignedOutServerSwitchConfirmation: promptSignedOutServerSwitchConfirmationMock,
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => pendingTerminalConnectMock.current,
    setPendingTerminalConnect: pendingTerminalConnectMock.set,
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: switchConnectionToActiveServerMock,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
    subscribeActiveServer: () => () => {},
    listServerProfiles: () => [],
    getActiveServerId: () => 'server-a',
    getDeviceDefaultServerId: () => 'server-a',
    getResetToDefaultServerId: () => 'server-a',
    setActiveServerId: (...args: unknown[]) => setActiveServerIdMock(...args),
    upsertServerProfile: vi.fn(() => ({
        id: 'server-correct',
        serverUrl: 'https://correct.example.test',
        name: 'Correct',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
    })),
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

describe('useServerSettingsScreenController (add server pending terminal)', () => {
    afterEach(() => {
        runtimeFetchMock.mockClear();
        routerReplaceMock.mockClear();
        setActiveServerIdMock.mockClear();
        switchConnectionToActiveServerMock.mockClear();
        refreshFromActiveServerMock.mockClear();
        promptSignedOutServerSwitchConfirmationMock.mockClear();
        pendingTerminalConnectMock.current = null;
        pendingTerminalConnectMock.set.mockClear();
        storageState.serverSelectionGroups = [];
        storageState.serverSelectionActiveTargetKind = null;
        storageState.serverSelectionActiveTargetId = null;
        vi.resetModules();
    });

    it('retargets the pending terminal connect and returns to auth when adding a signed-out relay', async () => {
        pendingTerminalConnectMock.current = {
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://wrong.example.test',
        };

        const { useServerSettingsScreenController } = await import('./useServerSettingsScreenController');

        let value: ReturnType<typeof useServerSettingsScreenController> | null = null;
        function Probe() {
            value = useServerSettingsScreenController();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        await act(async () => {
            value?.onChangeUrl('https://correct.example.test');
            value?.onChangeName('Correct');
        });

        await act(async () => {
            await value?.onAddServer();
        });

        expect(promptSignedOutServerSwitchConfirmationMock).toHaveBeenCalledTimes(1);
        expect(pendingTerminalConnectMock.set).toHaveBeenCalledWith({
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://correct.example.test',
        });
        expect(setActiveServerIdMock).toHaveBeenCalledWith('server-correct', { scope: 'device' });
        expect(storageState.serverSelectionActiveTargetKind).toBe('server');
        expect(storageState.serverSelectionActiveTargetId).toBe('server-correct');
        expect(switchConnectionToActiveServerMock).toHaveBeenCalledTimes(1);
        expect(refreshFromActiveServerMock).toHaveBeenCalledTimes(1);
        expect(routerReplaceMock).toHaveBeenLastCalledWith('/');
    });
});

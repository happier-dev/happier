import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installServerSettingsHooksCommonModuleMocks } from './serverSettingsHooksTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerReplaceMock = vi.fn();
const setActiveServerAndSwitchMock = vi.fn(async () => true);
const refreshFromActiveServerMock = vi.fn(async () => {});
const createEndpointReadinessProbeMock = vi.hoisted(() => vi.fn(() => async () => ({ status: 'ready' as const })));
const promptSignedOutServerSwitchConfirmationMock = vi.hoisted(() => vi.fn(async () => true));
const pendingTerminalConnectMock = vi.hoisted(() => ({
    current: null as { publicKeyB64Url: string; serverUrl: string } | null,
    set: vi.fn((value: { publicKeyB64Url: string; serverUrl: string }) => {
        pendingTerminalConnectMock.current = value;
    }),
}));
const addedServerProfile = {
    id: 'server-correct',
    serverUrl: 'https://correct.example.test',
    name: 'Correct',
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: 0,
};

const settingsState = {
    serverSelectionGroups: [] as unknown[],
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

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    setActiveServerAndSwitch: setActiveServerAndSwitchMock,
}));

vi.mock('@/sync/runtime/connectivity/createEndpointReadinessProbe', () => ({
    createEndpointReadinessProbe: (..._args: unknown[]) => createEndpointReadinessProbeMock(),
}));

vi.mock('@/components/settings/server/hooks/useEndpointReachabilityRemediationController', () => ({
    useEndpointReachabilityRemediationController: () => ({
        error: null,
        taskSnapshot: null,
        onAction: vi.fn(async () => {}),
    }),
}));

vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
    useRelayDriftBanner: () => null,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-a', serverUrl: 'https://a.example.test', generation: 1 }),
    listServerProfiles: () => [],
    getActiveServerId: () => 'server-a',
    getDeviceDefaultServerId: () => 'server-a',
    getTabActiveServerId: () => null,
    getResetToDefaultServerId: () => 'server-a',
    clearTabActiveServerId: vi.fn(),
    getServerProfileById: (serverId: string) =>
        serverId === addedServerProfile.id ? addedServerProfile : null,
    resolveServerProfileScopeId: (profile: { serverIdentityId?: string; id: string }) =>
        profile.serverIdentityId ?? profile.id,
    upsertServerProfile: vi.fn(() => addedServerProfile),
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
    filterServerSelectionGroupsToAvailableServers: (profiles: unknown) => profiles,
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
        routerReplaceMock.mockClear();
        setActiveServerAndSwitchMock.mockReset();
        setActiveServerAndSwitchMock.mockResolvedValue(true);
        refreshFromActiveServerMock.mockClear();
        createEndpointReadinessProbeMock.mockClear();
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
        expect(setActiveServerAndSwitchMock).toHaveBeenCalledWith({
            serverId: 'server-correct',
            scope: 'device',
            refreshAuth: refreshFromActiveServerMock,
        });
        expect(storageState.serverSelectionActiveTargetKind).toBe('server');
        expect(storageState.serverSelectionActiveTargetId).toBe('server-correct');
        expect(routerReplaceMock).toHaveBeenLastCalledWith('/?server=https%3A%2F%2Fcorrect.example.test');
    });

    it('does not retarget terminal or navigation state when marked custody blocks the switch', async () => {
        setActiveServerAndSwitchMock.mockResolvedValue(false);
        pendingTerminalConnectMock.current = {
            publicKeyB64Url: 'abc123',
            serverUrl: 'https://active.example.test',
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

        expect(setActiveServerAndSwitchMock).toHaveBeenCalledTimes(1);
        expect(pendingTerminalConnectMock.set).not.toHaveBeenCalled();
        expect(storageState.serverSelectionActiveTargetKind).toBeNull();
        expect(storageState.serverSelectionActiveTargetId).toBeNull();
        expect(routerReplaceMock).not.toHaveBeenCalled();
    });
});

import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { installServerSettingsHooksCommonModuleMocks } from './serverSettingsHooksTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const storageState: Record<string, unknown> = {};
const useSettingMutableMock = ((key: string) => [
    storageState[key],
    (value: unknown) => {
        storageState[key] = value;
    },
]) as typeof import('@/sync/domains/state/storage')['useSettingMutable'];

const routerReplaceMock = vi.fn();

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: vi.fn(async () => {}) }),
}));

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
});

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: vi.fn(async () => {}),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => ([
        { id: 'server-a', name: 'A', serverUrl: 'https://a.example.test', lastUsedAt: 0, createdAt: 0, updatedAt: 0 },
        { id: 'server-b', name: 'B', serverUrl: 'https://b.example.test', lastUsedAt: 0, createdAt: 0, updatedAt: 0 },
    ]),
    getActiveServerId: () => 'server-a',
    getDeviceDefaultServerId: () => 'server-a',
    getResetToDefaultServerId: () => 'server-a',
    setActiveServerId: vi.fn(),
    upsertServerProfile: vi.fn(() => ({ id: 'server-a' })),
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    validateServerUrl: () => ({ valid: true, error: null }),
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

describe('useServerSettingsScreenController.setGroupSelectionEnabled', () => {
    beforeEach(() => {
        routerReplaceMock.mockReset();
        Object.keys(storageState).forEach((key) => delete storageState[key]);
        storageState.serverSelectionGroups = [
            { id: 'grp-b', name: 'Server B only', serverIds: ['server-b'], presentation: 'grouped' },
            { id: 'grp-ab', name: 'Servers A+B', serverIds: ['server-a', 'server-b'], presentation: 'grouped' },
        ];
        storageState.serverSelectionActiveTargetKind = 'server';
        storageState.serverSelectionActiveTargetId = 'server-a';
        vi.clearAllMocks();
    });

    afterEach(async () => {
        vi.resetModules();
    });

    it('prefers a group containing the active server when enabling concurrent view', async () => {
        const { useServerSettingsScreenController } = await import('./useServerSettingsScreenController');

        let controller: any = null;
        function Probe() {
            controller = useServerSettingsScreenController();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        await act(async () => {
            controller.setGroupSelectionEnabled(true);
        });

        expect(storageState.serverSelectionActiveTargetKind).toBe('group');
        expect(storageState.serverSelectionActiveTargetId).toBe('grp-ab');
    });

    it('prefers a multi-server group when multiple groups contain the active server', async () => {
        storageState.serverSelectionGroups = [
            { id: 'grp-a', name: 'Server A only', serverIds: ['server-a'], presentation: 'grouped' },
            { id: 'grp-ab', name: 'Servers A+B', serverIds: ['server-a', 'server-b'], presentation: 'grouped' },
        ];
        storageState.serverSelectionActiveTargetKind = 'server';
        storageState.serverSelectionActiveTargetId = 'server-a';

        const { useServerSettingsScreenController } = await import('./useServerSettingsScreenController');

        let controller: any = null;
        function Probe() {
            controller = useServerSettingsScreenController();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        await act(async () => {
            controller.setGroupSelectionEnabled(true);
        });

        expect(storageState.serverSelectionActiveTargetKind).toBe('group');
        expect(storageState.serverSelectionActiveTargetId).toBe('grp-ab');
    });
});

import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installServerSettingsHooksCommonModuleMocks } from './serverSettingsHooksTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const settingsState = {
    serverSelectionGroups: [] as any[],
    serverSelectionActiveTargetKind: 'server' as 'server' | 'group' | null,
    serverSelectionActiveTargetId: 'server-a' as string | null,
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
        const routerMock = createExpoRouterMock({
            router: { replace: vi.fn() },
            params: {},
        });
        return routerMock.module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                confirm: vi.fn(async () => false),
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSettingMutable: useSettingMutableMock,
        });
    },
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: vi.fn(async () => {}) }),
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: vi.fn(async () => {}),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    // Intentionally not sorted by recency.
    listServerProfiles: () => ([
        { id: 'server-a', name: 'A', serverUrl: 'https://a.example.test', lastUsedAt: 1 },
        { id: 'server-b', name: 'B', serverUrl: 'https://b.example.test', lastUsedAt: 999 },
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

describe('useServerSettingsScreenController', () => {
    it('does not reorder servers by lastUsedAt in server configuration list', async () => {
        const { useServerSettingsScreenController } = await import('./useServerSettingsScreenController');

        let value: any = null;
        function Probe() {
            value = useServerSettingsScreenController();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(value.servers.map((srv: any) => srv.id)).toEqual(['server-a', 'server-b']);
    });
});

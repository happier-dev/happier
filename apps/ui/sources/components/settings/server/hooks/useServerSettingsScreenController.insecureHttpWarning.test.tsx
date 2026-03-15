import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const replaceMock = vi.fn();
vi.mock('expo-router', () => ({
    useRouter: () => ({ replace: replaceMock }),
    useLocalSearchParams: () => ({}),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: vi.fn(async () => {}) }),
}));

const modalConfirmMock = vi.fn(async (..._args: unknown[]) => false);
vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
        confirm: (...args: unknown[]) => modalConfirmMock(...args),
        prompt: vi.fn(async () => null),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: vi.fn(async () => {}),
}));

const upsertServerProfileMock = vi.fn((..._args: unknown[]) => ({
    id: 'p0',
    serverUrl: 'http://example.test',
    name: 'Example',
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: 0,
}));
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => [],
    getActiveServerId: () => '',
    getDeviceDefaultServerId: () => '',
    getResetToDefaultServerId: () => '',
    setActiveServerId: vi.fn(),
    upsertServerProfile: (...args: unknown[]) => upsertServerProfileMock(...args),
    removeServerProfile: vi.fn(),
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    validateServerUrl: () => ({ valid: true, error: null }),
}));

vi.mock('@/sync/domains/server/selection/serverSelectionMutations', () => ({
    normalizeStoredServerSelectionGroups: (raw: unknown) => (Array.isArray(raw) ? raw : []),
    filterServerSelectionGroupsToAvailableServers: (profiles: unknown) => profiles,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: () => [[], vi.fn()],
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

const runtimeFetchMock = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...args),
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: vi.fn(async () => {
        throw new Error('not used');
    }),
}));

describe('useServerSettingsScreenController (insecure http warning)', () => {
    it('warns and aborts when adding an http:// non-local server URL and user cancels', async () => {
        upsertServerProfileMock.mockReturnValue({ id: 'p1', serverUrl: 'http://public.example.test:3005', name: 'Public', createdAt: 0, updatedAt: 0, lastUsedAt: 0 });

        const { useServerSettingsScreenController } = await import('./useServerSettingsScreenController');

        let value: any = null;
        function Probe() {
            value = useServerSettingsScreenController();
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
        });

        await act(async () => {
            value.onChangeUrl('http://public.example.test:3005');
            value.onChangeName('Public');
        });

        await act(async () => {
            await value.onAddServer();
        });

        expect(modalConfirmMock).toHaveBeenCalledWith(
            'server.insecureHttpUrlTitle',
            'server.insecureHttpUrlBody',
            expect.objectContaining({ confirmText: 'common.ok', cancelText: 'common.cancel' }),
        );
        expect(upsertServerProfileMock).not.toHaveBeenCalled();
    });
});

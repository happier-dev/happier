import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const replaceMock = vi.fn();
vi.mock('expo-router', () => ({
    useRouter: () => ({ replace: replaceMock }),
    useLocalSearchParams: () => ({}),
}));

const refreshFromActiveServerMock = vi.fn(async () => {});
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: refreshFromActiveServerMock }),
}));

const modalConfirmMock = vi.fn(async (..._args: unknown[]) => true);
vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
        confirm: (...args: unknown[]) => modalConfirmMock(...args),
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
const removeServerProfileMock = vi.fn((..._args: unknown[]) => undefined);
const setActiveServerIdMock = vi.fn((..._args: unknown[]) => undefined);
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => [],
    getActiveServerId: () => '',
    getDeviceDefaultServerId: () => '',
    getResetToDefaultServerId: () => '',
    setActiveServerId: (...args: unknown[]) => setActiveServerIdMock(...args),
    upsertServerProfile: (...args: unknown[]) => upsertServerProfileMock(...args),
    removeServerProfile: (...args: unknown[]) => removeServerProfileMock(...args),
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    validateServerUrl: () => ({ valid: true, error: null }),
}));

vi.mock('@/sync/domains/server/selection/serverSelectionMutations', () => ({
    normalizeStoredServerSelectionGroups: (raw: unknown) => (Array.isArray(raw) ? raw : []),
    filterServerSelectionGroupsToAvailableServers: (profiles: any) => profiles,
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

const getServerFeaturesSnapshotMock = vi.fn(async (..._args: unknown[]) => ({
    status: 'ready',
    features: {
        features: {},
        capabilities: {
            server: {
                canonicalServerUrl: 'https://canonical.example.test',
            },
        },
    },
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: (...args: unknown[]) => getServerFeaturesSnapshotMock(...args),
}));

describe('useServerSettingsScreenController (canonical URL adoption)', () => {
    it('offers to adopt canonicalServerUrl from /v1/features and migrates the stored profile', async () => {
        upsertServerProfileMock
            .mockReturnValueOnce({ id: 'p1', serverUrl: 'http://127.0.0.1:3005', name: 'Local', createdAt: 0, updatedAt: 0, lastUsedAt: 0 })
            .mockReturnValueOnce({ id: 'p2', serverUrl: 'https://canonical.example.test', name: 'Local', createdAt: 0, updatedAt: 0, lastUsedAt: 0 });

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
            value.onChangeUrl('http://127.0.0.1:3005');
            value.onChangeName('Local');
        });

        await act(async () => {
            await value.onAddServer();
        });

        expect(getServerFeaturesSnapshotMock).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'p1' }));
        expect(modalConfirmMock).toHaveBeenCalled();
        expect(upsertServerProfileMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ serverUrl: 'https://canonical.example.test' }),
        );
        expect(removeServerProfileMock).toHaveBeenCalledWith('p1');
        expect(setActiveServerIdMock).toHaveBeenCalledWith('p2', expect.anything());
    });
});

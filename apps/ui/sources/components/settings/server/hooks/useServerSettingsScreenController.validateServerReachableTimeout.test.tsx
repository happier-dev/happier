import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installServerSettingsHooksCommonModuleMocks } from './serverSettingsHooksTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const replaceMock = vi.fn();
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: vi.fn(async () => {}) }),
}));

installServerSettingsHooksCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { replace: replaceMock },
            params: {},
        });
        return routerMock.module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                confirm: vi.fn(async () => true),
                prompt: vi.fn(async () => null),
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
            useSettingMutable: () => [[], vi.fn()],
        });
    },
});

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: vi.fn(async () => {}),
}));

const upsertServerProfileMock = vi.fn((..._args: unknown[]) => ({
    id: 'p0',
    serverUrl: 'https://example.test',
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

describe('useServerSettingsScreenController (server validation timeout)', () => {
    it('passes an AbortSignal and installs a probe timeout when validating /v1/version', async () => {
        const prev = process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_PROBE_TIMEOUT_MS;
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_PROBE_TIMEOUT_MS = '1234';

        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

        try {
            const { useServerSettingsScreenController } = await import('./useServerSettingsScreenController');

            let value: any = null;
            function Probe() {
                value = useServerSettingsScreenController();
                return null;
            }

            await renderScreen(React.createElement(Probe));

            await act(async () => {
                value.onChangeUrl('https://example.test');
                value.onChangeName('Example');
            });

            await act(async () => {
                await value.onAddServer();
            });

            expect(upsertServerProfileMock).toHaveBeenCalled();
            expect(value.isValidating).toBe(false);

            const init = runtimeFetchMock.mock.calls[0]?.[1] as { signal?: unknown } | undefined;
            expect(init?.signal).toBeTruthy();
            expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1234);
        } finally {
            setTimeoutSpy.mockRestore();
            process.env.EXPO_PUBLIC_HAPPIER_SERVER_REACHABILITY_PROBE_TIMEOUT_MS = prev;
        }
    });
});

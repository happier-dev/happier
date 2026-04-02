import * as React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { renderScreen, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const featureGateState = vi.hoisted(() => ({
    managementEnabled: true,
    secretMaterialEnabled: false,
}));
const remoteHostsState = vi.hoisted(() => ({
    value: [] as Array<{
        id: string;
        name: string;
        ssh: {
            target: string;
            port: number | null;
            authMode: 'agent' | 'password' | 'keyfile';
        };
        linkedMachineId: string | null;
        linkedRelayProfileId: string | null;
        createdAt: number;
        updatedAt: number;
        lastUsedAt: number | null;
    }>,
}));
const startMock = vi.hoisted(() => vi.fn(async (_spec: any) => 'task_1'));
const itemRowActionsSpy = vi.hoisted(() => ({ props: null as any }));

function setTauriDesktop(enabled: boolean) {
    if (enabled) {
        (globalThis as any).__TAURI_INTERNALS__ = { invoke: () => null };
        return;
    }
    delete (globalThis as any).__TAURI_INTERNALS__;
}

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web' },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    textSecondary: '#666',
                    accent: { orange: '#f90' },
                    surface: '#fff',
                    header: { background: '#fff', tint: '#000' },
                },
                margins: { sm: 4, lg: 16 },
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSettings: () => ({} as any),
            useSettingMutable: (key: any) => {
                if (key === 'remoteHostsV1') {
                    return [remoteHostsState.value, vi.fn()] as any;
                }
                return [undefined, vi.fn()] as any;
            },
        });
    },
});

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useEffectiveServerSelection: () => ({
        enabled: false,
        serverIds: [],
        presentation: 'grouped',
    }),
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/features/featureDecisionRuntime')>('@/sync/domains/features/featureDecisionRuntime');
    const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
    const features = () => createRootLayoutFeaturesResponse({
        features: {
            remoteHosts: {
                management: { enabled: featureGateState.managementEnabled },
                secretMaterial: { enabled: featureGateState.secretMaterialEnabled },
            },
        },
    });
    return {
        ...actual,
        useServerFeaturesRuntimeSnapshot: () => ({
            status: 'ready',
            features: features(),
        }),
        useServerFeaturesMainSelectionSnapshot: () => ({
            status: 'ready',
            features: features(),
        }),
        useServerFeaturesSnapshotForServerId: () => ({
            status: 'ready',
            features: features(),
        }),
    };
});

vi.mock('@/components/systemTasks', () => ({
    getDefaultSystemTaskRunner: () => ({
        mode: 'tauri',
        start: startMock,
        cancel: vi.fn(async () => {}),
        respond: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
    }),
}));

vi.mock('@/components/systemTasks/useSystemTaskSnapshot', () => ({
    useSystemTaskSnapshot: (_runner: unknown, taskId: string | null) =>
        (taskId ? { taskId, status: 'running', currentStepId: null, latestMessage: null, awaitingInput: false, cancelRequested: false, events: [], result: null } : null),
}));

vi.mock('@/components/systemTasks/SystemTaskProgressCard', () => ({
    SystemTaskProgressCard: (props: Record<string, unknown>) => React.createElement('SystemTaskProgressCard', props),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        decryptSecretValue: () => null,
        encryptSecretValue: () => ({ __brand: 'SecretString', value: 'enc' }),
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: any) => React.createElement('ItemList', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.children, props.rightElement),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: any) => {
        itemRowActionsSpy.props = props;
        return React.createElement('ItemRowActions', props);
    },
}));

	    afterEach(() => {
	    setTauriDesktop(false);
	    featureGateState.managementEnabled = true;
	    featureGateState.secretMaterialEnabled = false;
	    remoteHostsState.value = [];
	        startMock.mockReset();
	        itemRowActionsSpy.props = null;
	        standardCleanup();
	    });

	describe('RemoteHostsScreen', () => {
	    it('renders a desktop-only notice when not running on desktop', async () => {
	        setTauriDesktop(false);
	        const { RemoteHostsScreen } = await import('./RemoteHostsScreen');
	        const screen = await renderScreen(React.createElement(RemoteHostsScreen));

	        expect(screen.findByTestId('settings.remoteHosts.desktopOnly')).toBeTruthy();
	    });

	    it('renders a management-disabled notice when the gate is disabled', async () => {
	        setTauriDesktop(true);
	        featureGateState.managementEnabled = false;

	        const { RemoteHostsScreen } = await import('./RemoteHostsScreen');
	        const screen = await renderScreen(React.createElement(RemoteHostsScreen));

	        expect(screen.findByTestId('settings.remoteHosts.managementDisabled')).toBeTruthy();
	    });

	    it('starts a SystemTask when running the test connection action', async () => {
	        setTauriDesktop(true);
	        featureGateState.managementEnabled = true;
	        remoteHostsState.value = [
	            {
	                id: 'host-a',
                name: 'Dev box',
                ssh: {
                    target: 'dev@10.0.0.1',
                    port: 2222,
                    authMode: 'agent',
                },
                linkedMachineId: null,
                linkedRelayProfileId: null,
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: null,
            },
        ];

        const { RemoteHostsScreen } = await import('./RemoteHostsScreen');
        const screen = await renderScreen(React.createElement(RemoteHostsScreen));

        expect(screen.findByTestId('settings.remoteHosts.desktopOnly')).toBeNull();
        expect(screen.findByTestId('settings.remoteHosts.managementDisabled')).toBeNull();
        expect(screen.findByTestId('settings.remoteHosts.hostRow.host-a')).toBeTruthy();

        const rowActionsProps = itemRowActionsSpy.props as { actions?: Array<{ id: string; onPress: () => void }> } | null;
        expect(rowActionsProps?.actions).toBeTruthy();
        const actions = rowActionsProps!.actions!;
        const testConnection = actions.find((action) => action.id === 'testConnection');
        expect(testConnection).toBeTruthy();

        testConnection!.onPress();
        await flushHookEffects({ cycles: 1, turns: 6 });

        expect(startMock).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'remote.ssh.manageHost.v1',
            params: expect.objectContaining({
                action: 'testConnection',
                channel: 'stable',
                ssh: expect.objectContaining({
                    target: 'dev@10.0.0.1',
                    port: 2222,
                    auth: 'agent',
                }),
            }),
        }));
    });

    it('does not include a plaintext password in the SystemTask spec when secret material is disabled (password auth prompts instead)', async () => {
        setTauriDesktop(true);
        featureGateState.managementEnabled = true;
        featureGateState.secretMaterialEnabled = false;
        remoteHostsState.value = [
            {
                id: 'host-password',
                name: 'Password Host',
                ssh: {
                    target: 'dev@10.0.0.2',
                    port: 22,
                    authMode: 'password',
                },
                linkedMachineId: null,
                linkedRelayProfileId: null,
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: null,
            },
        ];

        const { RemoteHostsScreen } = await import('./RemoteHostsScreen');
        const screen = await renderScreen(React.createElement(RemoteHostsScreen));

        expect(screen.findByTestId('settings.remoteHosts.hostRow.host-password')).toBeTruthy();

        const rowActionsProps = itemRowActionsSpy.props as { actions?: Array<{ id: string; onPress: () => void }> } | null;
        expect(rowActionsProps?.actions).toBeTruthy();
        const actions = rowActionsProps!.actions!;
        const testConnection = actions.find((action) => action.id === 'testConnection');
        expect(testConnection).toBeTruthy();

        testConnection!.onPress();
        await flushHookEffects({ cycles: 1, turns: 6 });

        expect(startMock).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'remote.ssh.manageHost.v1',
            params: expect.objectContaining({
                action: 'testConnection',
                channel: 'stable',
                ssh: expect.objectContaining({
                    target: 'dev@10.0.0.2',
                    port: 22,
                    auth: 'password',
                }),
            }),
        }));

        const spec = startMock.mock.calls[0]?.[0] as any;
        expect(spec).toBeTruthy();
        expect(spec.params.ssh).not.toHaveProperty('password');
    });
});

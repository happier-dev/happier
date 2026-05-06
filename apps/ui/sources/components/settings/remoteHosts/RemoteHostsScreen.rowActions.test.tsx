import * as React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const featureGateState = vi.hoisted(() => ({
    managementEnabled: true,
    secretMaterialEnabled: false,
}));
const remoteHostsState = vi.hoisted(() => ({
    value: [
        {
            id: 'host-a',
            name: 'Dev box',
            ssh: {
                target: 'dev@10.0.0.1',
                port: 2222,
                authMode: 'agent' as const,
            },
            linkedMachineId: null,
            linkedRelayProfileId: null,
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: null,
        },
    ],
}));
const startMock = vi.hoisted(() => vi.fn(async (_spec: any) => 'task_1'));

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
            useWindowDimensions: () => ({ width: 1200, height: 800 }),
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
                    text: '#111',
                    textSecondary: '#666',
                    deleteAction: '#c00',
                    button: { secondary: { tint: '#333' } },
                    accent: { blue: '#06f', orange: '#f90' },
                    surface: '#fff',
                    header: { background: '#fff', tint: '#000' },
                },
                margins: { sm: 4, lg: 16 },
                dark: false,
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

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('FloatingOverlay', props, props.children),
}));

vi.mock('@/components/ui/popover', () => ({
    usePopoverBoundaryRef: () => null,
    PopoverScope: (props: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, props.children),
    Popover: (props: Record<string, any>) => {
        if (!props.open) return null;
        return React.createElement(
            'Popover',
            props,
            props.children({
                maxHeight: 400,
                maxWidth: 400,
                placement: props.placement ?? 'left',
            }),
        );
    },
}));

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useEffectiveServerSelection: () => ({
        enabled: false,
        serverIds: [],
        presentation: 'grouped',
    }),
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({
        serverId: 'server-1',
        serverUrl: 'https://server.example.test',
        activeShareableServerUrl: 'https://share.example.test',
        activeShareableServerUrlValidatedAgainstServerUrl: 'https://server.example.test',
        generation: 1,
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
    useSystemTaskSnapshot: (_runner: unknown, taskId: string | null) =>
        (taskId ? { taskId, status: 'running', currentStepId: null, latestMessage: null, awaitingInput: false, cancelRequested: false, events: [], result: null } : null),
    SystemTaskProgressCard: (props: Record<string, unknown>) => React.createElement('SystemTaskProgressCard', props),
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

afterEach(() => {
    setTauriDesktop(false);
    featureGateState.managementEnabled = true;
    featureGateState.secretMaterialEnabled = false;
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
    startMock.mockReset();
    standardCleanup();
});

describe('RemoteHostsScreen row actions', () => {
    it('renders only eligible outcome actions inline on wide desktop rows and keeps maintenance actions in overflow', async () => {
        setTauriDesktop(true);

        const { RemoteHostsScreen } = await import('./RemoteHostsScreen');
        const screen = await renderScreen(React.createElement(RemoteHostsScreen));

        expect(screen.findByTestId('settings.remoteHosts.action.setupAsMachine.host-a')).toBeTruthy();
        expect(screen.findByTestId('settings.remoteHosts.action.connectFromThisDevice.host-a')).toBeTruthy();
        expect(screen.findByTestId('settings.remoteHosts.action.useAsRelayHost.host-a')).toBeTruthy();
        expect(screen.findByTestId('settings.remoteHosts.action.configureAccess.host-a')).toBeTruthy();

        expect(screen.findByTestId('settings.remoteHosts.action.testConnection')).toBeNull();
        expect(screen.findByTestId('settings.remoteHosts.action.installOrUpdateCli')).toBeNull();
        expect(screen.findByTestId('settings.remoteHosts.action.edit.host-a')).toBeNull();

        const overflowTrigger = screen.findByTestId('settings.remoteHosts.actions.more.host-a');
        expect(overflowTrigger).toBeTruthy();

        await screen.pressByTestIdAsync('settings.remoteHosts.actions.more.host-a');

        expect(screen.findByTestId('testConnection')).toBeTruthy();
        expect(screen.findByTestId('installOrUpdateCli')).toBeTruthy();
        expect(screen.findByTestId('edit')).toBeTruthy();
        expect(screen.findByTestId('remove')).toBeTruthy();
    });
});

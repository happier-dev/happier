import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from './machinesSettingsTestHelpers';

installMachinesSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'web',
                select: (options: Record<string, unknown>) => options?.web ?? options?.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    accent: {
                        blue: 'blue',
                        orange: 'orange',
                        indigo: 'indigo',
                    },
                },
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) =>
        React.createElement('Group', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

vi.mock('@/components/settings/machines/localControl/LocalDaemonControlSection', () => ({
    LocalDaemonControlSection: (props: Record<string, unknown>) => React.createElement('LocalDaemonControlSection', props),
}));
vi.mock('@/components/settings/server/localControl/LocalRelayRuntimeControlSection', () => ({
    LocalRelayRuntimeControlSection: (props: Record<string, unknown>) => React.createElement('LocalRelayRuntimeControlSection', props),
}));
vi.mock('@/components/settings/server/localControl/LocalTailscaleSecureAccessSection', () => ({
    LocalTailscaleSecureAccessSection: (props: Record<string, unknown>) => React.createElement('LocalTailscaleSecureAccessSection', props),
}));
vi.mock('@/components/settings/machines/RemoteSshMachineSetupSection', () => ({
    RemoteSshMachineSetupSection: (props: Record<string, unknown>) => React.createElement('RemoteSshMachineSetupSection', props),
}));
vi.mock('@/components/systemTasks', () => ({
    SystemTaskProgressCard: (props: Record<string, unknown>) => React.createElement('SystemTaskProgressCard', props),
    getDefaultSystemTaskRunner: () => ({ mode: 'unavailable', start: async () => '', cancel: async () => {}, subscribe: async () => () => {} }),
    useSystemTaskSnapshot: () => null,
}));
vi.mock('@/components/systemTasks/useThisComputerSetupTask', () => ({
    resolveThisComputerSetupFollowUp: () => null,
    useThisComputerSetupTask: () => ({
        activeTaskSnapshot: null,
        cancel: async () => {},
        completedMachineId: null,
        start: async () => {},
        startError: null,
    }),
}));
vi.mock('@/components/settings/providers/setup/ProviderSetupFlow', () => ({
    ProviderSetupFlow: (props: Record<string, unknown>) => React.createElement('ProviderSetupFlow', props),
}));
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'relay-web',
        serverUrl: 'https://relay.example.test',
        activeLocalRelayUrl: null,
        activeShareableServerUrl: null,
        generation: 1,
    }),
}));

describe('MachineSetupFlowScreen web gating', () => {
    afterEach(() => {
        // Keep Tauri detection isolated per test.
        delete (globalThis as any).__TAURI_INTERNALS__;
    });

    it('keeps the local-machine route web-safe without rendering desktop-only controls', async () => {
        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { mode: 'localOnly' }));

        expect(screen.findAllByType('LocalDaemonControlSection' as never)).toHaveLength(0);
        expect(screen.findAllByType('LocalRelayRuntimeControlSection' as never)).toHaveLength(0);
        expect(screen.findAllByType('LocalTailscaleSecureAccessSection' as never)).toHaveLength(0);
        expect(screen.findAllByType('RemoteSshMachineSetupSection' as never)).toHaveLength(0);
        expect(screen.findByTestId('settings.machineSetup.desktopOnlyNotice')?.props.title).toBe('setupOnboarding.webDesktopOnlyTitle');
        expect(screen.findByTestId('settings.machineSetup.desktopOnlyNotice')?.props.subtitle).toBe('setupOnboarding.webDesktopOnlyBody');
    });

    it('renders desktop-only controls when running inside the Tauri desktop webview', async () => {
        (globalThis as any).__TAURI_INTERNALS__ = { invoke: () => undefined };

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { mode: 'localOnly' }));

        expect(screen.findByTestId('settings.machineSetup.desktopOnlyNotice')).toBeNull();
        expect(screen.findAllByType('LocalDaemonControlSection' as never)).toHaveLength(1);
        expect(screen.findAllByType('LocalRelayRuntimeControlSection' as never)).toHaveLength(1);
        expect(screen.findAllByType('LocalTailscaleSecureAccessSection' as never)).toHaveLength(1);
    });

    it('shows a desktop-only notice instead of setup actions when browser web code passes a runner', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const runner = createSystemTaskRunner({
            bridge: {
                async start() {
                    return 'task-web';
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, {
            mode: 'localOnly',
            runner,
        }));

        expect(screen.findByTestId('settings.machineSetup.desktopOnlyNotice')).toBeTruthy();
        expect(screen.findByTestId('settings.machineSetup.startLocalTask')).toBeNull();
        expect(screen.findByTestId('settings.machineSetup.startRemoteTask')).toBeNull();
        expect(screen.findByTestId('settings.machineSetup.remoteSshTargetInput')).toBeNull();
        expect(screen.findAllByType('LocalRelayRuntimeControlSection' as never)).toHaveLength(0);
        expect(screen.findAllByType('RemoteSshMachineSetupSection' as never)).toHaveLength(0);
    });

    it('keeps the remote-machine route web-safe without rendering the SSH bootstrap form', async () => {
        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { mode: 'remoteOnly' }));

        expect(screen.findAllByType('LocalDaemonControlSection' as never)).toHaveLength(0);
        expect(screen.findAllByType('LocalRelayRuntimeControlSection' as never)).toHaveLength(0);
        expect(screen.findAllByType('LocalTailscaleSecureAccessSection' as never)).toHaveLength(0);
        expect(screen.findAllByType('RemoteSshMachineSetupSection' as never)).toHaveLength(0);
        expect(screen.findByTestId('settings.machineSetup.desktopOnlyNotice')?.props.title).toBe('setupOnboarding.webDesktopOnlyTitle');
        expect(screen.findByTestId('settings.machineSetup.desktopOnlyNotice')?.props.subtitle).toBe('setupOnboarding.webDesktopOnlyBody');
    });

    it('does not render ProviderSetupFlow on browser web even when a machine id is provided', async () => {
        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, {
            mode: 'localOnly',
            initialProviderMachineId: 'machine_web_1',
        }));

        expect(screen.findAllByType('ProviderSetupFlow' as never)).toHaveLength(0);
    });
});

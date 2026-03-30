import * as React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from './machinesSettingsTestHelpers';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const activeServerSnapshot = vi.hoisted(() => ({
    serverId: 'relay-example',
    serverUrl: 'https://relay.example.test',
    activeLocalRelayUrl: null as string | null,
    generation: 1,
}));

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

vi.mock('@/components/settings/providers/setup/ProviderSetupFlow', () => ({
    ProviderSetupFlow: (props: Record<string, unknown>) => React.createElement('ProviderSetupFlow', props),
}));

vi.mock('@/sync/domains/server/serverProfiles', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/server/serverProfiles')>('@/sync/domains/server/serverProfiles');
    return {
        ...actual,
        getActiveServerSnapshot: () => activeServerSnapshot,
    };
});

vi.mock('@/components/settings/server/localControl/buildLocalTailscaleSecureAccessSystemTaskSpec', () => ({
    buildLocalTailscaleSecureAccessSystemTaskSpec: vi.fn(() => ({
        protocolVersion: 1,
        kind: 'test.local.tailscale.secureAccess.v1',
        params: {},
    })),
}));

describe('MachineSetupFlowScreen local control follow-up', () => {
    beforeEach(() => {
        (globalThis as any).__TAURI_INTERNALS__ = { invoke: () => undefined };
        activeServerSnapshot.serverId = 'relay-example';
        activeServerSnapshot.serverUrl = 'https://relay.example.test';
        activeServerSnapshot.activeLocalRelayUrl = null;
        activeServerSnapshot.generation = 1;
    });

    afterEach(() => {
        delete (globalThis as any).__TAURI_INTERNALS__;
    });

    it('shows the local relay control sections even before a new local setup task completes', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    return `task_${nextTaskId++}:${parsed.kind}`;
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        expect(screen.findByTestId('settings.localRelayRuntime.status')).toBeTruthy();
        expect(screen.findByTestId('settings.localTailscale.status')).toBeTruthy();
        expect(screen.findByTestId('settings.localDaemonControl.status')).toBeTruthy();
    });

    it('hides local relay controls and opens the remote SSH form in remote-only mode', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');

        const runner = createSystemTaskRunner({
            bridge: {
                async start() {
                    return 'task-1';
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
            mode: 'remoteOnly',
            runner,
        }));

        expect(screen.findByTestId('settings.machineSetup.startLocalTask')).toBeNull();
        expect(screen.findByTestId('settings.localRelayRuntime.status')).toBeNull();
        expect(screen.findByTestId('settings.localTailscale.status')).toBeNull();
        expect(screen.findByTestId('settings.localDaemonControl.status')).toBeNull();
        expect(screen.findByTestId('settings.machineSetup.remoteSshTargetInput')).toBeTruthy();
    });

    it('keeps the this-computer route focused on local control in local-only mode', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');

        const runner = createSystemTaskRunner({
            bridge: {
                async start() {
                    return 'task-1';
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

        expect(screen.findByTestId('settings.machineSetup.startLocalTask')).toBeNull();
        expect(screen.findByTestId('settings.machineSetup.startRemoteTask')).toBeNull();
        expect(screen.findByTestId('settings.machineSetup.remoteSshTargetInput')).toBeNull();
        expect(screen.findByTestId('settings.localDaemonControl.status')).toBeTruthy();
        expect(screen.findByTestId('settings.localRelayRuntime.status')).toBeTruthy();
        expect(screen.findByTestId('settings.localTailscale.status')).toBeTruthy();
    });

    it('passes the active local relay alias to secure access when the active relay is public', async () => {
        activeServerSnapshot.activeLocalRelayUrl = 'http://127.0.0.1:4555';

        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { buildLocalTailscaleSecureAccessSystemTaskSpec } = await import('@/components/settings/server/localControl/buildLocalTailscaleSecureAccessSystemTaskSpec');

        const runner = createSystemTaskRunner({
            bridge: {
                async start() {
                    return 'task-1';
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        await screen.pressByTestIdAsync('settings.localTailscale.enable');

        expect(buildLocalTailscaleSecureAccessSystemTaskSpec).toHaveBeenCalledWith({
            upstreamUrl: 'http://127.0.0.1:4555',
        });
    });

    it('renders local relay runtime and Tailscale sections after this-computer setup succeeds', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    return `task_${nextTaskId++}:${parsed.kind}`;
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { MachineSetupFlowScreen } = await import('./MachineSetupFlowScreen');
        const screen = await renderScreen(React.createElement(MachineSetupFlowScreen, { runner }));

        await screen.pressByTestIdAsync('settings.machineSetup.startLocalTask');
        const localSetupTaskId = [...listeners.keys()].find((taskId) => taskId.endsWith(':setup.thisComputer.v1'));
        if (!localSetupTaskId) {
            throw new Error('Expected a setup.thisComputer.v1 task to be started');
        }

        await renderer.act(async () => {
            listeners.get(localSetupTaskId)?.onResult({
                protocolVersion: 1,
                taskId: localSetupTaskId,
                ok: true,
                data: {
                    machineId: 'machine-1',
                },
            });
        });

        expect(screen.findByTestId('settings.localRelayRuntime.status')).toBeTruthy();
        expect(screen.findByTestId('settings.localTailscale.status')).toBeTruthy();
        expect(screen.findAllByType('ProviderSetupFlow' as any)).toHaveLength(1);
    });
});

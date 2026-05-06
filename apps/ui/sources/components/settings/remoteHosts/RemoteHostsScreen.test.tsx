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
const systemTaskState = vi.hoisted(() => ({
    mode: 'tauri' as 'tauri' | 'native' | 'dev' | 'unavailable',
    nextTaskNumber: 1,
    snapshots: new Map<string, unknown>(),
    sshTunnelSnapshots: [] as Array<{
        tunnelKey: string;
        httpBaseUrl: string;
        wsBaseUrl?: string;
        localPort: number;
        remoteHost: string;
        remotePort: number;
        purpose: 'remote-host-access' | 'relay-access-local-bridge' | 'bootstrap' | 'diagnostic';
        remoteHostId?: string;
        status: 'available' | 'starting' | 'unavailable' | 'needs-auth' | 'unknown';
        leaseCount: number;
        createdAt: string;
        lastProbeAt: string | null;
    }>,
}));
const startMock = vi.hoisted(() => vi.fn(async (spec: { kind?: string }) => {
    const taskId = `task_${systemTaskState.nextTaskNumber++}`;
    if (spec.kind === 'daemon.sshTunnel.list.v1') {
        systemTaskState.snapshots.set(taskId, {
            taskId,
            status: 'succeeded',
            currentStepId: null,
            latestMessage: null,
            awaitingInput: false,
            cancelRequested: false,
            events: [],
            result: {
                protocolVersion: 1,
                taskId,
                ok: true,
                data: {
                    ok: true,
                    tunnels: systemTaskState.sshTunnelSnapshots,
                },
            },
        });
    }
    if (spec.kind === 'daemon.sshTunnel.ensure.v1') {
        systemTaskState.snapshots.set(taskId, {
            taskId,
            status: 'succeeded',
            currentStepId: null,
            latestMessage: null,
            awaitingInput: false,
            cancelRequested: false,
            events: [],
            result: {
                protocolVersion: 1,
                taskId,
                ok: true,
                data: {
                    ok: true,
                    lease: {
                        leaseId: 'lease-1',
                        tunnelKey: 'remote-host-access:host-a',
                        httpBaseUrl: 'http://127.0.0.1:49152',
                        wsBaseUrl: 'ws://127.0.0.1:49152',
                        localPort: 49152,
                        remoteHost: '127.0.0.1',
                        remotePort: 3005,
                        expiresAt: null,
                        status: 'available',
                    },
                },
            },
        });
        systemTaskState.sshTunnelSnapshots = [{
            tunnelKey: 'remote-host-access:host-a',
            httpBaseUrl: 'http://127.0.0.1:49152',
            wsBaseUrl: 'ws://127.0.0.1:49152',
            localPort: 49152,
            remoteHost: '127.0.0.1',
            remotePort: 3005,
            purpose: 'remote-host-access',
            remoteHostId: 'host-a',
            status: 'available',
            leaseCount: 1,
            createdAt: '2026-05-06T10:00:00.000Z',
            lastProbeAt: '2026-05-06T10:01:00.000Z',
        }];
    }
    if (spec.kind === 'daemon.sshTunnel.stop.v1') {
        systemTaskState.snapshots.set(taskId, {
            taskId,
            status: 'succeeded',
            currentStepId: null,
            latestMessage: null,
            awaitingInput: false,
            cancelRequested: false,
            events: [],
            result: {
                protocolVersion: 1,
                taskId,
                ok: true,
                data: {
                    ok: true,
                },
            },
        });
    }
    return taskId;
}));
const itemRowActionsSpy = vi.hoisted(() => ({ props: null as any }));
const modalSpies = vi.hoisted(() => ({
    show: vi.fn(),
    alert: vi.fn(async () => undefined),
    confirm: vi.fn(async () => true),
}));
const activeServerState = vi.hoisted(() => ({
    snapshot: {
        serverId: 'server-1',
        serverUrl: 'https://server.example.test',
        activeShareableServerUrl: 'https://share.example.test',
        activeShareableServerUrlValidatedAgainstServerUrl: 'https://server.example.test',
        generation: 1,
    },
}));

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
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            confirmResult: true,
            spies: {
                show: modalSpies.show,
                alert: modalSpies.alert,
                confirm: modalSpies.confirm,
            },
        }).module;
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    textSecondary: '#666',
                    deleteAction: '#c00',
                    button: { secondary: { tint: '#333' } },
                    accent: { blue: '#06f', orange: '#f90' },
                    surface: '#fff',
                    overlay: { scrimWizard: '#fff' },
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

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useEffectiveServerSelection: () => ({
        enabled: false,
        serverIds: [],
        presentation: 'grouped',
    }),
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => activeServerState.snapshot,
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
        mode: systemTaskState.mode,
        start: startMock,
        cancel: vi.fn(async () => {}),
        respond: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
    }),
    useSystemTaskSnapshot: (_runner: unknown, taskId: string | null) =>
        (taskId ? systemTaskState.snapshots.get(taskId) ?? { taskId, status: 'running', currentStepId: null, latestMessage: null, awaitingInput: false, cancelRequested: false, events: [], result: null } : null),
    SystemTaskProgressCard: (props: Record<string, unknown>) => React.createElement('SystemTaskProgressCard', props),
}));

vi.mock('@/components/systemTasks/useSystemTaskSnapshot', () => ({
    useSystemTaskSnapshot: (_runner: unknown, taskId: string | null) =>
        (taskId ? systemTaskState.snapshots.get(taskId) ?? { taskId, status: 'running', currentStepId: null, latestMessage: null, awaitingInput: false, cancelRequested: false, events: [], result: null } : null),
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
            systemTaskState.nextTaskNumber = 1;
            systemTaskState.mode = 'tauri';
            systemTaskState.snapshots.clear();
            systemTaskState.sshTunnelSnapshots = [];
            activeServerState.snapshot = {
                serverId: 'server-1',
                serverUrl: 'https://server.example.test',
                activeShareableServerUrl: 'https://share.example.test',
                activeShareableServerUrlValidatedAgainstServerUrl: 'https://server.example.test',
                generation: 1,
            };
	        startMock.mockReset();
	        itemRowActionsSpy.props = null;
            modalSpies.show.mockReset();
            modalSpies.alert.mockReset();
            modalSpies.confirm.mockReset();
            modalSpies.confirm.mockResolvedValue(true);
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

        const spec = startMock.mock.calls
            .map((call) => call[0])
            .find((candidate) => candidate?.kind === 'remote.ssh.manageHost.v1') as any;
        expect(spec).toBeTruthy();
        expect(spec.params.ssh).not.toHaveProperty('password');
    });

    it('keeps add host as a creation flow separate from the saved hosts list', async () => {
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

        const addHost = screen.findByTestId('settings.remoteHosts.addHost');
        expect(addHost).toBeTruthy();
        expect(screen.findByTestId('settings.remoteHosts.hostRow.host-a')).toBeTruthy();

        addHost!.props.onPress();

        expect(modalSpies.show).toHaveBeenCalledWith(expect.objectContaining({
            component: expect.anything(),
            props: expect.objectContaining({
                remoteHost: null,
                savedRemoteHosts: remoteHostsState.value,
            }),
        }));
    });

    it('pins outcome actions and keeps maintenance actions in overflow', async () => {
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
        await renderScreen(React.createElement(RemoteHostsScreen));

        const rowActionsProps = itemRowActionsSpy.props as {
            actions?: Array<{ id: string }>;
            compactActionIds?: string[];
            pinnedActionIds?: string[];
        } | null;
        expect(rowActionsProps?.actions?.map((action) => action.id)).toEqual(expect.arrayContaining([
            'setupAsMachine',
            'useAsRelayHost',
            'configureAccess',
            'testConnection',
            'installOrUpdateCli',
            'edit',
            'remove',
        ]));
        expect(rowActionsProps?.compactActionIds).toEqual([
            'setupAsMachine',
            'connectFromThisDevice',
            'useAsRelayHost',
            'configureAccess',
        ]);
        expect(rowActionsProps?.pinnedActionIds).toEqual([
            'setupAsMachine',
            'connectFromThisDevice',
            'useAsRelayHost',
            'configureAccess',
        ]);
        expect(rowActionsProps?.compactActionIds).not.toContain('testConnection');
        expect(rowActionsProps?.compactActionIds).not.toContain('installOrUpdateCli');
    });

    it('starts the remote SSH bootstrap task when setting a host up as a Happier machine', async () => {
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
        await renderScreen(React.createElement(RemoteHostsScreen));

        const rowActionsProps = itemRowActionsSpy.props as { actions?: Array<{ id: string; onPress: () => void }> } | null;
        const setupAsMachine = rowActionsProps?.actions?.find((action) => action.id === 'setupAsMachine');
        expect(setupAsMachine).toBeTruthy();

        setupAsMachine!.onPress();
        await flushHookEffects({ cycles: 1, turns: 6 });

        expect(startMock).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'remote.ssh.bootstrapMachine.v1',
            params: expect.objectContaining({
                ssh: expect.objectContaining({
                    target: 'dev@10.0.0.1',
                    port: 2222,
                    auth: 'agent',
                }),
                relay: expect.objectContaining({
                    relayUrl: 'https://share.example.test',
                    webappUrl: 'https://server.example.test',
                    publicRelayUrl: 'https://share.example.test',
                }),
            }),
        }));
    });

    it('opens relay access for the saved SSH target without starting a tunnel or relay-runtime maintenance task', async () => {
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

        const rowActionsProps = itemRowActionsSpy.props as { actions?: Array<{ id: string; onPress: () => void }> } | null;
        const useAsRelayHost = rowActionsProps?.actions?.find((action) => action.id === 'useAsRelayHost');
        expect(useAsRelayHost).toBeTruthy();

        useAsRelayHost!.onPress();
        await flushHookEffects({ cycles: 2, turns: 6 });

        expect(screen.findByTestId('settings.remoteHosts.relayAccess.host-a')).toBeTruthy();
        expect(startMock).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'relay.access.status.v1',
            params: {
                target: {
                    kind: 'ssh',
                    ssh: {
                        target: 'dev@10.0.0.1',
                        port: 2222,
                        auth: 'agent',
                    },
                },
            },
        }));
        const startedSpecs = startMock.mock.calls.map((call) => call[0]);
        expect(startedSpecs).not.toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'daemon.sshTunnel.ensure.v1',
            }),
            expect.objectContaining({
                kind: 'remote.ssh.manageHost.v1',
                params: expect.objectContaining({
                    action: expect.stringContaining('relayRuntime'),
                }),
            }),
        ]));
        expect(JSON.stringify(startedSpecs)).not.toContain('sshTunnelProvider');
    });

    it('opens configure access on the existing relay-access control for the saved SSH target', async () => {
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

        const rowActionsProps = itemRowActionsSpy.props as { actions?: Array<{ id: string; onPress: () => void }> } | null;
        const configureAccess = rowActionsProps?.actions?.find((action) => action.id === 'configureAccess');
        expect(configureAccess).toBeTruthy();

        configureAccess!.onPress();
        await flushHookEffects({ cycles: 2, turns: 6 });

        expect(screen.findByTestId('settings.remoteHosts.relayAccess.host-a')).toBeTruthy();
        expect(startMock).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'relay.access.status.v1',
            params: expect.objectContaining({
                target: expect.objectContaining({
                    kind: 'ssh',
                }),
            }),
        }));
    });

    it('does not expose the desktop daemon SSH tunnel launcher as a native access channel', async () => {
        setTauriDesktop(false);
        systemTaskState.mode = 'native';
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
        await renderScreen(React.createElement(RemoteHostsScreen));

        const rowActionsProps = itemRowActionsSpy.props as { actions?: Array<{
            id: string;
            title?: string;
            subtitle?: string;
            onPress: () => void;
        }> } | null;
        const connectFromThisDevice = rowActionsProps?.actions?.find((action) => action.id === 'connectFromThisDevice');
        await flushHookEffects({ cycles: 2, turns: 6 });

        expect(connectFromThisDevice).toBeUndefined();
        const startedSpecs = startMock.mock.calls.map((call) => call[0]);
        expect(startedSpecs).not.toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'daemon.sshTunnel.ensure.v1',
            }),
        ]));
        expect(startedSpecs).not.toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'remote.ssh.manageHost.v1',
            }),
        ]));
        expect(JSON.stringify(startedSpecs)).not.toContain('providerId');
        expect(JSON.stringify(startedSpecs)).not.toContain('sshTunnelProvider');
        expect(startedSpecs.filter((spec) => spec.kind === 'daemon.sshTunnel.list.v1')).toHaveLength(0);
    });

    it('shows active supervised SSH tunnel status and stops it through the local daemon control system task', async () => {
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
        systemTaskState.sshTunnelSnapshots = [{
            tunnelKey: 'remote-host-access:host-a',
            httpBaseUrl: 'http://127.0.0.1:49152',
            wsBaseUrl: 'ws://127.0.0.1:49152',
            localPort: 49152,
            remoteHost: '127.0.0.1',
            remotePort: 3005,
            purpose: 'remote-host-access',
            remoteHostId: 'host-a',
            status: 'available',
            leaseCount: 1,
            createdAt: '2026-05-06T10:00:00.000Z',
            lastProbeAt: '2026-05-06T10:01:00.000Z',
        }];

        const { RemoteHostsScreen } = await import('./RemoteHostsScreen');
        const screen = await renderScreen(React.createElement(RemoteHostsScreen));
        await flushHookEffects({ cycles: 3, turns: 6 });

        expect(startMock).toHaveBeenCalledWith({
            protocolVersion: 1,
            kind: 'daemon.sshTunnel.list.v1',
            params: {},
        });
        expect(screen.findByTestId('settings.remoteHosts.sshTunnel.host-a')).toBeTruthy();
        expect(screen.findByTestId('settings.remoteHosts.sshTunnel.stop.host-a')).toBeTruthy();

        screen.findByTestId('settings.remoteHosts.sshTunnel.stop.host-a')!.props.onPress();
        await flushHookEffects({ cycles: 3, turns: 6 });

        expect(startMock).toHaveBeenCalledWith({
            protocolVersion: 1,
            kind: 'daemon.sshTunnel.stop.v1',
            params: {
                tunnelKey: 'remote-host-access:host-a',
            },
        });
    });
});

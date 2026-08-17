import * as React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act } from 'react-test-renderer';

import type { AccountSettingsDefaults } from '@happier-dev/protocol';
import { renderScreen, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const featureGateState = vi.hoisted(() => ({
    managementEnabled: true,
    secretMaterialEnabled: false,
}));
type RemoteHostsRaw = AccountSettingsDefaults['remoteHostsV1'];

const remoteHostsState = vi.hoisted(() => ({
    value: [] as RemoteHostsRaw,
    setValue: vi.fn(),
}));
const systemTaskState = vi.hoisted(() => ({
    mode: 'tauri' as 'tauri' | 'native' | 'dev' | 'unavailable',
    nativeSshAvailable: false,
    nativeSshSupportsLoopbackTunnel: true,
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
    prompt: vi.fn(async () => null as string | null),
}));
const secretState = vi.hoisted(() => ({
    decryptedSecretValue: null as string | null,
}));
const nativeTunnelState = vi.hoisted(() => ({
    credentialsByRemoteHostId: new Map<string, unknown>(),
    hostKeyPromptResolver: null as ((event: {
        host: string;
        fingerprintSha256: string;
        status?: 'unknown' | 'changed';
        existingFingerprintSha256?: string;
    }) => Promise<unknown>) | null,
    authPromptResolver: null as ((event: {
        kind: 'private-key-passphrase';
        host: string;
        promptId: string;
        requestId: string;
        port: number;
        username: string;
    }) => Promise<unknown>) | null,
    setHostKeyPromptResolver: vi.fn((resolver: ((event: {
        host: string;
        fingerprintSha256: string;
        status?: 'unknown' | 'changed';
        existingFingerprintSha256?: string;
    }) => Promise<unknown>) | null) => {
        nativeTunnelState.hostKeyPromptResolver = resolver;
    }),
    setAuthPromptResolver: vi.fn((resolver: ((event: {
        kind: 'private-key-passphrase';
        host: string;
        promptId: string;
        requestId: string;
        port: number;
        username: string;
    }) => Promise<unknown>) | null) => {
        nativeTunnelState.authPromptResolver = resolver;
    }),
    leases: [] as Array<{
        leaseId: string;
        key: string;
        remoteHostId: string;
        localUrl: string;
        channelMode: 'loopback-port';
        purpose: 'server-http';
        status: 'ready' | 'failed' | 'degraded';
        startedAt: string;
    }>,
    startLifecycle: vi.fn(),
    listener: null as (() => void) | null,
    ensureTunnel: vi.fn(async () => {
        const lease = {
            leaseId: 'native-lease-1',
            key: 'native-key-a',
            remoteHostId: 'host-a',
            localUrl: 'http://127.0.0.1:49154',
            channelMode: 'loopback-port' as const,
            purpose: 'server-http' as const,
            status: 'ready' as const,
            startedAt: '2026-05-06T10:00:00.000Z',
        };
        nativeTunnelState.leases = [lease];
        nativeTunnelState.listener?.();
        return lease;
    }),
    releaseTunnel: vi.fn(async (leaseId: string) => {
        nativeTunnelState.leases = nativeTunnelState.leases.filter((lease) => lease.leaseId !== leaseId);
        nativeTunnelState.listener?.();
    }),
}));
const nativeBootstrapInterruptionState = vi.hoisted(() => ({
    markers: new Map<string, {
        taskId: string;
        key: string;
        startedAtMs: number;
    }>(),
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
                prompt: modalSpies.prompt,
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
                    return [remoteHostsState.value, remoteHostsState.setValue] as any;
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
        capabilities: systemTaskState.mode === 'native' ? {
            nativeSsh: {
                available: systemTaskState.nativeSshAvailable,
                supportedTaskKinds: ['remote.ssh.bootstrapMachine.v1'],
                supportsLoopbackTunnel: systemTaskState.nativeSshSupportsLoopbackTunnel,
                ...(!systemTaskState.nativeSshAvailable ? { unavailableReason: 'engine-unavailable' } : {}),
            },
        } : {},
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
        decryptSecretValue: () => secretState.decryptedSecretValue,
        encryptSecretValue: () => ({ __brand: 'SecretString', value: 'enc' }),
    },
}));

vi.mock('@/sync/runtime/nativeSshTunnels/runtime', () => ({
    getNativeSshTunnelRuntime: () => ({
        ensureTunnel: nativeTunnelState.ensureTunnel,
        listTunnels: () => ({ leases: nativeTunnelState.leases, platformLimitations: [] }),
        releaseTunnel: nativeTunnelState.releaseTunnel,
        markSuspended: vi.fn(),
        markForeground: vi.fn(async () => undefined),
        subscribe: vi.fn((listener: () => void) => {
            nativeTunnelState.listener = listener;
            return () => {
                if (nativeTunnelState.listener === listener) {
                    nativeTunnelState.listener = null;
                }
            };
        }),
    }),
    setNativeSshTunnelCredentialResolution: (credentialsRef: { remoteHostId: string }, credentials: unknown) => {
        nativeTunnelState.credentialsByRemoteHostId.set(credentialsRef.remoteHostId, credentials);
    },
    setNativeSshTunnelHostKeyPromptResolver: nativeTunnelState.setHostKeyPromptResolver,
    setNativeSshTunnelAuthPromptResolver: nativeTunnelState.setAuthPromptResolver,
    startNativeSshTunnelRuntimeAppStateLifecycle: nativeTunnelState.startLifecycle,
}));

vi.mock('@/components/systemTasks/nativeSshBridgeInterruptionStore', () => ({
    createDefaultNativeSshBridgeInterruptionStore: () => ({
        read: (key: string) => nativeBootstrapInterruptionState.markers.get(key) ?? null,
        write: (marker: { key: string }) => {
            nativeBootstrapInterruptionState.markers.set(marker.key, marker as {
                taskId: string;
                key: string;
                startedAtMs: number;
            });
        },
        remove: (key: string) => {
            nativeBootstrapInterruptionState.markers.delete(key);
        },
        list: () => [...nativeBootstrapInterruptionState.markers.values()],
    }),
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
            remoteHostsState.setValue.mockReset();
            systemTaskState.nextTaskNumber = 1;
            systemTaskState.mode = 'tauri';
            systemTaskState.nativeSshAvailable = false;
            systemTaskState.nativeSshSupportsLoopbackTunnel = true;
            systemTaskState.snapshots.clear();
            systemTaskState.sshTunnelSnapshots = [];
            secretState.decryptedSecretValue = null;
            nativeTunnelState.credentialsByRemoteHostId.clear();
            nativeTunnelState.leases = [];
            nativeTunnelState.listener = null;
            nativeTunnelState.startLifecycle.mockClear();
            nativeTunnelState.ensureTunnel.mockClear();
            nativeTunnelState.releaseTunnel.mockClear();
            nativeTunnelState.hostKeyPromptResolver = null;
            nativeTunnelState.setHostKeyPromptResolver.mockClear();
            nativeTunnelState.authPromptResolver = null;
            nativeTunnelState.setAuthPromptResolver.mockClear();
            nativeBootstrapInterruptionState.markers.clear();
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
            modalSpies.prompt.mockReset();
            modalSpies.prompt.mockResolvedValue(null);
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

    it('preserves opaque legacy rows when the settings form upserts or removes a current host', async () => {
        setTauriDesktop(true);
        featureGateState.managementEnabled = true;
        const currentHost = {
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
        };
        const opaqueFutureHost = {
            v: 2,
            id: 'future-host',
            transport: 'future-transport',
            futureData: { retained: true },
        };
        remoteHostsState.value = [currentHost, opaqueFutureHost];

        const { RemoteHostsScreen } = await import('./RemoteHostsScreen');
        const screen = await renderScreen(React.createElement(RemoteHostsScreen));
        screen.findByTestId('settings.remoteHosts.addHost')?.props.onPress();

        const formProps = modalSpies.show.mock.calls.at(-1)?.[0]?.props;
        if (!formProps) {
            throw new Error('Expected remote-host form props');
        }
        const addedHost = {
            ...currentHost,
            id: 'host-b',
            name: 'Build box',
        };
        formProps.onSave({ remoteHost: addedHost, localOverrides: null });

        const afterUpsert = remoteHostsState.setValue.mock.calls.at(-1)?.[0];
        expect(afterUpsert).toHaveLength(3);
        expect(afterUpsert[1]).toBe(opaqueFutureHost);
        expect(afterUpsert).toContainEqual(addedHost);

        formProps.onDelete(currentHost.id);

        const afterRemove = remoteHostsState.setValue.mock.calls.at(-1)?.[0];
        expect(afterRemove).toHaveLength(1);
        expect(afterRemove[0]).toBe(opaqueFutureHost);
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

    it('starts a native SSH tunnel from the remote host action when running on native with stored password material', async () => {
        setTauriDesktop(true);
        systemTaskState.mode = 'native';
        systemTaskState.nativeSshAvailable = true;
        featureGateState.managementEnabled = true;
        featureGateState.secretMaterialEnabled = true;
        secretState.decryptedSecretValue = 'secret';
        remoteHostsState.value = [
            {
                id: 'host-a',
                name: 'Dev box',
                ssh: {
                    target: 'dev@10.0.0.1',
                    port: 2222,
                    authMode: 'password',
                    passwordEnc: { __brand: 'SecretString', value: 'enc' },
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
        const connectFromThisDevice = rowActionsProps?.actions?.find((action) => action.id === 'connectFromThisDevice');
        expect(connectFromThisDevice).toBeTruthy();

        connectFromThisDevice!.onPress();
        await flushHookEffects({ cycles: 2, turns: 6 });

        expect(nativeTunnelState.startLifecycle).toHaveBeenCalledTimes(1);
        expect(nativeTunnelState.ensureTunnel).toHaveBeenCalledWith({
            remoteHostId: 'host-a',
            sshTarget: 'dev@10.0.0.1',
            sshPort: 2222,
            destinationHost: '127.0.0.1',
            destinationPort: 3005,
            purpose: 'server-http',
            credentialsRef: {
                remoteHostId: 'host-a',
                credentialId: 'remote-host:host-a:ssh',
                storage: 'session-memory',
            },
        });
        expect(nativeTunnelState.credentialsByRemoteHostId.get('host-a')).toEqual({
            auth: {
                username: 'dev',
                password: 'secret',
            },
        });
        expect(nativeTunnelState.setHostKeyPromptResolver).toHaveBeenCalledWith(expect.any(Function));
        await expect(nativeTunnelState.hostKeyPromptResolver?.({
            host: '10.0.0.1',
            fingerprintSha256: 'SHA256:abc',
        })).resolves.toEqual({
            decision: 'accept-once',
            fingerprintSha256: 'SHA256:abc',
        });
        modalSpies.confirm.mockClear();
        await expect(nativeTunnelState.hostKeyPromptResolver?.({
            host: '10.0.0.1',
            fingerprintSha256: 'SHA256:new',
            existingFingerprintSha256: 'SHA256:old',
            status: 'changed',
        })).resolves.toEqual({
            decision: 'accept-once',
            fingerprintSha256: 'SHA256:new',
        });
        expect(modalSpies.confirm).toHaveBeenCalledWith(
            'settings.remoteHostsReplaceHostKeyTitle',
            expect.stringContaining('settings.remoteHostsHostKeyCurrentFingerprintLabel: SHA256:old'),
            expect.objectContaining({
                confirmText: 'settings.remoteHostsReplaceHostKeyAction',
            }),
        );
        expect(modalSpies.confirm).toHaveBeenCalledWith(
            'settings.remoteHostsReplaceHostKeyTitle',
            expect.stringContaining('settings.remoteHostsHostKeyNewFingerprintLabel: SHA256:new'),
            expect.any(Object),
        );
        expect(nativeTunnelState.setAuthPromptResolver).toHaveBeenCalledWith(expect.any(Function));
        modalSpies.prompt.mockResolvedValueOnce('secret phrase');
        await expect(nativeTunnelState.authPromptResolver?.({
            requestId: 'native-ssh-tunnel:host-a',
            promptId: 'auth-passphrase-1',
            kind: 'private-key-passphrase',
            host: '10.0.0.1',
            port: 2222,
            username: 'dev',
        })).resolves.toEqual({
            decision: 'submit',
            value: 'secret phrase',
        });
        expect(modalSpies.prompt).toHaveBeenCalledWith(
            'settings.remoteHostsPrivateKeyPassphraseTitle',
            '10.0.0.1',
            expect.objectContaining({ inputType: 'secure-text' }),
        );
        expect(startMock).not.toHaveBeenCalledWith(expect.objectContaining({
            kind: 'daemon.sshTunnel.ensure.v1',
        }));
    });

    it('shows native SSH tunnel access channels after connecting from this device', async () => {
        setTauriDesktop(false);
        systemTaskState.mode = 'native';
        systemTaskState.nativeSshAvailable = true;
        featureGateState.managementEnabled = true;
        featureGateState.secretMaterialEnabled = true;
        secretState.decryptedSecretValue = 'secret';
        remoteHostsState.value = [
            {
                id: 'host-a',
                name: 'Dev box',
                ssh: {
                    target: 'dev@10.0.0.1',
                    port: 2222,
                    authMode: 'password',
                    passwordEnc: { __brand: 'SecretString', value: 'enc' },
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
        const connectFromThisDevice = rowActionsProps?.actions?.find((action) => action.id === 'connectFromThisDevice');
        expect(connectFromThisDevice).toBeTruthy();

        connectFromThisDevice!.onPress();
        await flushHookEffects({ cycles: 2, turns: 6 });
        await screen.update(React.createElement(RemoteHostsScreen));

        expect(screen.findByTestId('settings.server.accessEndpoints.channel:access-channel:ssh-tunnel-native:host-a:native-key-a')).toBeTruthy();
        expect(screen.findByTestId('settings.server.accessEndpoints.channel:access-channel:ssh-tunnel-native:host-a:native-key-a.recommendedUse')?.props.title).toBe(
            'settings.accessEndpoints.recommendedUse.native-this-device',
        );
        expect(screen.findByTestId('settings.server.accessEndpoints.channel:access-channel:ssh-tunnel-native:host-a:native-key-a.action:ssh-tunnel-native:native-lease-1:stop')).toBeTruthy();
    });

    it('surfaces native SSH tunnel stop failures from access channel remediation', async () => {
        setTauriDesktop(false);
        systemTaskState.mode = 'native';
        systemTaskState.nativeSshAvailable = true;
        systemTaskState.nativeSshSupportsLoopbackTunnel = true;
        featureGateState.managementEnabled = true;
        nativeTunnelState.leases = [{
            leaseId: 'native-lease-failed',
            key: 'native-key-failed',
            remoteHostId: 'host-a',
            localUrl: 'http://127.0.0.1:49154',
            channelMode: 'loopback-port',
            purpose: 'server-http',
            status: 'failed',
            startedAt: '2026-05-06T10:00:00.000Z',
        }];
        nativeTunnelState.releaseTunnel.mockRejectedValueOnce(new Error('native_stop_failed'));

        const { RemoteHostsScreen } = await import('./RemoteHostsScreen');
        const screen = await renderScreen(React.createElement(RemoteHostsScreen));

        const action = screen.findByTestId(
            'settings.server.accessEndpoints.channel:access-channel:ssh-tunnel-native:host-a:native-key-failed.action:ssh-tunnel-native:native-lease-failed:stop',
        );
        expect(action).toBeTruthy();

        action!.props.onPress();
        await flushHookEffects({ cycles: 2, turns: 6 });

        expect(nativeTunnelState.releaseTunnel).toHaveBeenCalledWith('native-lease-failed');
        expect(modalSpies.alert).toHaveBeenCalledWith('common.error', 'native_stop_failed');
    });

    it('surfaces interrupted native SSH bootstrap markers after app restart and lets the user clear them', async () => {
        setTauriDesktop(false);
        systemTaskState.mode = 'native';
        systemTaskState.nativeSshAvailable = true;
        featureGateState.managementEnabled = true;
        remoteHostsState.value = [
            {
                id: 'host-a',
                name: 'Dev box',
                ssh: {
                    target: 'dev@10.0.0.1',
                    port: 2222,
                    authMode: 'password',
                    passwordEnc: { __brand: 'SecretString', value: 'enc' },
                },
                linkedMachineId: null,
                linkedRelayProfileId: null,
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: null,
            },
        ];
        const markerKey = 'native-ssh-interrupted:host-a:remote.ssh.bootstrapMachine.v1';
        nativeBootstrapInterruptionState.markers.set(markerKey, {
            taskId: 'native_ssh_task_stale',
            key: markerKey,
            startedAtMs: 1760000000000,
        });

        const { RemoteHostsScreen } = await import('./RemoteHostsScreen');
        const screen = await renderScreen(React.createElement(RemoteHostsScreen));

        expect(screen.findByTestId('settings.remoteHosts.interruptedBootstrap.host-a')).toBeTruthy();
        const actions = itemRowActionsSpy.props as { actions?: Array<{ id: string; onPress: () => void }> } | null;
        const clearAction = actions?.actions?.find((action) => action.id === 'clearInterruptedBootstrap');
        expect(clearAction).toBeTruthy();

        await act(async () => {
            clearAction!.onPress();
        });
        await flushHookEffects({ cycles: 2, turns: 4 });

        expect(nativeBootstrapInterruptionState.markers.has(markerKey)).toBe(false);
        await screen.update(React.createElement(RemoteHostsScreen));
        expect(screen.findByTestId('settings.remoteHosts.interruptedBootstrap.host-a')).toBeNull();
    });

    it('does not surface the active native SSH bootstrap marker as interrupted', async () => {
        setTauriDesktop(false);
        systemTaskState.mode = 'native';
        systemTaskState.nativeSshAvailable = true;
        featureGateState.managementEnabled = true;
        featureGateState.secretMaterialEnabled = true;
        remoteHostsState.value = [
            {
                id: 'host-a',
                name: 'Dev box',
                ssh: {
                    target: 'dev@10.0.0.1',
                    port: 2222,
                    authMode: 'password',
                    passwordEnc: { __brand: 'SecretString', value: 'enc' },
                },
                linkedMachineId: null,
                linkedRelayProfileId: null,
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: null,
            },
        ];
        const markerKey = 'native-ssh-interrupted:host-a:remote.ssh.bootstrapMachine.v1';
        startMock.mockImplementationOnce(async () => {
            const taskId = 'native_ssh_task_live';
            systemTaskState.snapshots.set(taskId, {
                taskId,
                status: 'running',
                currentStepId: null,
                latestMessage: null,
                awaitingInput: false,
                cancelRequested: false,
                events: [],
                result: null,
            });
            nativeBootstrapInterruptionState.markers.set(markerKey, {
                taskId,
                key: markerKey,
                startedAtMs: 1760000000000,
            });
            return taskId;
        });

        const { RemoteHostsScreen } = await import('./RemoteHostsScreen');
        const screen = await renderScreen(React.createElement(RemoteHostsScreen));
        const rowActionsProps = itemRowActionsSpy.props as { actions?: Array<{ id: string; onPress: () => void }> } | null;
        const setupAsMachine = rowActionsProps?.actions?.find((action) => action.id === 'setupAsMachine');
        expect(setupAsMachine).toBeTruthy();

        setupAsMachine!.onPress();
        await flushHookEffects({ cycles: 2, turns: 6 });
        remoteHostsState.value = [...remoteHostsState.value];
        await screen.update(React.createElement(RemoteHostsScreen));

        expect(screen.findByTestId('settings.remoteHosts.interruptedBootstrap.host-a')).toBeNull();
        expect(nativeBootstrapInterruptionState.markers.has(markerKey)).toBe(true);
    });

    it('hides native SSH tunnel actions when the native module cannot provide loopback tunnels', async () => {
        setTauriDesktop(false);
        systemTaskState.mode = 'native';
        systemTaskState.nativeSshAvailable = true;
        systemTaskState.nativeSshSupportsLoopbackTunnel = false;
        featureGateState.managementEnabled = true;
        featureGateState.secretMaterialEnabled = true;
        remoteHostsState.value = [
            {
                id: 'host-a',
                name: 'Dev box',
                ssh: {
                    target: 'dev@10.0.0.1',
                    port: 2222,
                    authMode: 'password',
                    passwordEnc: { __brand: 'SecretString', value: 'enc' },
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

        const rowActionsProps = itemRowActionsSpy.props as { actions?: Array<{ id: string }> } | null;
        expect(rowActionsProps?.actions?.map((action) => action.id)).not.toContain('connectFromThisDevice');
        expect(nativeTunnelState.listener).toBeNull();
    });

    it('hides native SSH tunnel actions for credentials the native client cannot use from mobile', async () => {
        setTauriDesktop(false);
        systemTaskState.mode = 'native';
        systemTaskState.nativeSshAvailable = true;
        systemTaskState.nativeSshSupportsLoopbackTunnel = true;
        featureGateState.managementEnabled = true;
        featureGateState.secretMaterialEnabled = true;
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

        const rowActionsProps = itemRowActionsSpy.props as { actions?: Array<{ id: string }> } | null;
        expect(rowActionsProps?.actions?.map((action) => action.id)).not.toContain('connectFromThisDevice');
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

    it('hides unsupported native access and maintenance actions when the native SSH engine is unavailable', async () => {
        setTauriDesktop(false);
        systemTaskState.mode = 'native';
        systemTaskState.nativeSshAvailable = false;
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
        expect(screen.findByTestId('settings.remoteHosts.hostRow.host-a')).toBeTruthy();

        const rowActionsProps = itemRowActionsSpy.props as { actions?: Array<{
            id: string;
            title?: string;
            subtitle?: string;
            onPress: () => void;
        }> } | null;
        const actionIds = rowActionsProps?.actions?.map((action) => action.id) ?? [];
        expect(actionIds).not.toContain('connectFromThisDevice');
        expect(actionIds).not.toContain('testConnection');
        expect(actionIds).not.toContain('installOrUpdateCli');
        expect(actionIds).not.toContain('daemonService.installOrUpdate');
        expect(actionIds).not.toContain('relayRuntime.installOrUpdate');

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
        expect(modalSpies.alert).not.toHaveBeenCalled();
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

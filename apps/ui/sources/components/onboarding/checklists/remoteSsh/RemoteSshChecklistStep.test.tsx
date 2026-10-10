import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import type { SystemTaskSpec } from '@happier-dev/protocol';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';

import type { RemoteSshChecklistMode } from './types';

const featureGateState = vi.hoisted(() => ({
    managementEnabled: true,
    secretMaterialEnabled: true,
}));

const tauriState = vi.hoisted(() => ({
    isDesktop: false,
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let disposeNativeStorage: (() => void) | undefined;
afterAll(() => { disposeNativeStorage?.(); });

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemGroup', null, children),
}));
vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => {
        const items = Array.isArray((props as any).items) ? (props as any).items : [];
        const selectedId = (props as any).selectedId;
        const selectedItem = items.find((item: any) => item?.id === selectedId) ?? null;
        const trigger = typeof (props as any).trigger === 'function'
            ? (props as any).trigger({
                toggle: () => (props as any).onOpenChange?.(!(props as any).open),
                selectedItem,
            })
            : null;
        return React.createElement('DropdownMenu', props, trigger);
    },
}));

// Desktop identity is a native boundary; retain the canonical bridge exports
// used by real task owners while controlling this suite's renderer host.
vi.mock('@/utils/platform/desktopHost', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    isDesktopHost: () => tauriState.isDesktop,
    desktopHostKind: () => tauriState.isDesktop ? 'tauri' as const : null,
}));

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

function createRunner({
    snapshot,
    snapshotsByTaskId,
    startBehavior,
}: Readonly<{
    snapshot?: SystemTaskRunState | null;
    snapshotsByTaskId?: Readonly<Record<string, SystemTaskRunState | null>>;
    startBehavior?: (
        spec: SystemTaskSpec,
        taskId: string,
        callIndex: number,
    ) => void | Readonly<{ taskId?: string; snapshot?: SystemTaskRunState | null }>;
}> = {}): Readonly<{
    runner: SystemTaskRunner;
    startSpy: ReturnType<typeof vi.fn>;
    respondSpy: ReturnType<typeof vi.fn>;
    cancelSpy: ReturnType<typeof vi.fn>;
    setSnapshot: (taskId: string, snapshot: SystemTaskRunState | null) => void;
}> {
    const snapshotById = new Map<string, SystemTaskRunState | null>();
    const subscribers = new Map<string, Set<() => void>>();
    let defaultSnapshotAssigned = false;
    const setSnapshot = (taskId: string, taskSnapshot: SystemTaskRunState | null) => {
        snapshotById.set(taskId, taskSnapshot);
        subscribers.get(taskId)?.forEach((notify) => notify());
    };
    if (snapshotsByTaskId) {
        for (const [taskId, taskSnapshot] of Object.entries(snapshotsByTaskId)) {
            setSnapshot(taskId, taskSnapshot);
        }
    }

    const startSpy = vi.fn(async (spec: SystemTaskSpec) => {
        const callIndex = startSpy.mock.calls.length + 1;
        const defaultTaskId = `task-${callIndex}`;
        const startResult = startBehavior?.(spec, defaultTaskId, callIndex);
        const taskId = startResult?.taskId ?? defaultTaskId;
        if (startResult && 'snapshot' in startResult) {
            setSnapshot(taskId, startResult.snapshot ?? null);
        } else if (snapshot !== undefined && !defaultSnapshotAssigned && !snapshotById.has(taskId)) {
            defaultSnapshotAssigned = true;
            setSnapshot(taskId, snapshot);
        }
        return taskId;
    });
    const respondSpy = vi.fn(async () => undefined);
    const cancelSpy = vi.fn(async () => undefined);

    const subscribe: SystemTaskRunner['subscribe'] = (id: string, arg1?: any) => {
        const notify: () => void = typeof arg1 === 'function' ? arg1 : () => {};
        const set = subscribers.get(id) ?? new Set();
        set.add(notify);
        subscribers.set(id, set);
        return () => {
            const next = subscribers.get(id);
            next?.delete(notify);
            if (next && next.size === 0) {
                subscribers.delete(id);
            }
        };
    };

    const runner: SystemTaskRunner = {
        ...createManualSystemTaskRunner('dev').runner,
        mode: 'dev',
        start: startSpy,
        respond: respondSpy,
        cancel: cancelSpy,
        subscribe,
        getSnapshot: (id) => snapshotById.get(id) ?? null,
    };

    return {
        runner,
        startSpy,
        respondSpy,
        cancelSpy,
        setSnapshot,
    };
}

async function resetProfileRegistry(): Promise<void> {
    const profiles = await import('@/sync/domains/server/serverProfiles');
    profiles.clearTabActiveServerId();
    for (const profile of profiles.listServerProfiles()) await profiles.removeServerProfile(profile.id);
}

describe('RemoteSshChecklistStep', () => {
    beforeEach(async () => {
        await resetProfileRegistry();
    });

    afterEach(async () => {
        standardCleanup();
        const catalog = await import('@/sync/engine/settings/remoteHostCatalogEngine');
        catalog.resetRemoteHostCatalogEngineForTests();
        const snapshots = await import('@/sync/store/settings/remoteHostCatalogSnapshot');
        snapshots.resetRemoteHostCatalogSnapshotsForTests();
        await connection?.dispose();
        connection = null;
        await homes.reset();
        featureGateState.managementEnabled = true;
        featureGateState.secretMaterialEnabled = true;
        tauriState.isDesktop = false;
        await resetProfileRegistry();
    });

    it('does not trigger a maximum update depth loop when wired to the wizard chrome override store', async () => {
        const { RemoteSshChecklistStep } = await import('./RemoteSshChecklistStep');
        const { useWizardChromeOverrides } = await import('@/components/onboarding/hooks/useWizardChromeOverrides');
        const runnerHarness = createRunner();

        const Harness = () => {
            const overrides = useWizardChromeOverrides('host_relay_remote');
            return React.createElement(RemoteSshChecklistStep, {
                testID: 'remote-ssh-step',
                mode: 'remoteRelayHost',
                relayUrl: 'https://relay.example.test',
                runner: runnerHarness.runner,
                initialDraft: {
                    username: 'dev',
                    host: 'example.test',
                },
                onWizardPrimaryChange: overrides.setWizardPrimaryOverride,
                onWizardBackChange: overrides.setWizardBackOverride,
                onWizardSkipChange: overrides.setWizardSkipOverride,
                onRequestAdvance: () => undefined,
            });
        };

        let error: unknown = null;
        try {
            await renderScreen(React.createElement(React.StrictMode, null, React.createElement(Harness)));
        } catch (err) {
            error = err;
        }

        expect(error).toBeNull();
    });

    it('defaults save-host off on non-desktop platforms (so password saving is never preselected)', async () => {
        const { RemoteSshChecklistStep } = await import('./RemoteSshChecklistStep');
        const runnerHarness = createRunner();

        const screen = await renderScreen(React.createElement(RemoteSshChecklistStep, {
            testID: 'remote-ssh-step',
            mode: 'remoteRelayHost',
            relayUrl: 'https://relay.example.test',
            runner: runnerHarness.runner,
            initialDraft: {
                username: 'dev',
                host: 'example.test',
            },
        }));

        const passwordAuthChoice = screen.findByProps({ testID: 'remote-ssh-step-ssh-sshAuthMethod:password' }) as unknown as { props: { onPress?: () => void } };
        await act(async () => {
            passwordAuthChoice.props.onPress?.();
        });

        expect(screen.findAllByTestId('remote-ssh-step-save-password')).toHaveLength(0);
    });

    it('defaults save-host on for desktop (so users can opt-in to saving secrets after selecting password auth)', async () => {
        tauriState.isDesktop = true;

        const { RemoteSshChecklistStep } = await import('./RemoteSshChecklistStep');
        const runnerHarness = createRunner();

        const screen = await renderScreen(React.createElement(RemoteSshChecklistStep, {
            testID: 'remote-ssh-step',
            mode: 'remoteRelayHost',
            relayUrl: 'https://relay.example.test',
            runner: runnerHarness.runner,
            initialDraft: {
                username: 'dev',
                host: 'example.test',
            },
        }));

        const passwordAuthChoice = screen.findByProps({ testID: 'remote-ssh-step-ssh-sshAuthMethod:password' }) as unknown as { props: { onPress?: () => void } };
        await act(async () => {
            passwordAuthChoice.props.onPress?.();
        });

        expect(screen.findByTestId('remote-ssh-step-save-password')).toBeTruthy();
    });

    it('defaults save-host on for desktop (so users can opt-in to saving a private key after selecting keyfile auth)', async () => {
        tauriState.isDesktop = true;

        const { RemoteSshChecklistStep } = await import('./RemoteSshChecklistStep');
        const runnerHarness = createRunner();

        const screen = await renderScreen(React.createElement(RemoteSshChecklistStep, {
            testID: 'remote-ssh-step',
            mode: 'remoteRelayHost',
            relayUrl: 'https://relay.example.test',
            runner: runnerHarness.runner,
            initialDraft: {
                username: 'dev',
                host: 'example.test',
            },
        }));

        const keyfileAuthChoice = screen.findByProps({ testID: 'remote-ssh-step-ssh-sshAuthMethod:keyfile' }) as unknown as { props: { onPress?: () => void } };
        await act(async () => {
            keyfileAuthChoice.props.onPress?.();
        });

        expect(screen.findByTestId('remote-ssh-step-save-private-key')).toBeTruthy();
        expect(screen.findAllByTestId('remote-ssh-step-save-password')).toHaveLength(0);
    });

    it('hides the saved-host picker when remote host management is disabled', async () => {
        featureGateState.managementEnabled = false;

        const { RemoteSshChecklistStep } = await import('./RemoteSshChecklistStep');
        const runnerHarness = createRunner();

        const screen = await renderScreen(React.createElement(RemoteSshChecklistStep, {
            testID: 'remote-ssh-step',
            mode: 'remoteRelayHost',
            relayUrl: 'https://relay.example.test',
            runner: runnerHarness.runner,
            initialDraft: {
                username: 'dev',
                host: 'example.test',
            },
        }));

        expect(screen.findAllByTestId('remote-ssh-step-remote-host-picker')).toHaveLength(0);
        expect(screen.findByProps({ testID: 'remote-ssh-step-ssh-sshAuthMethod:agent' })).toBeTruthy();
    });

    it('forwards an encrypted private key from the wizard form into the bootstrap task spec when keyfile auth is selected', async () => {
        tauriState.isDesktop = true;

        const { RemoteSshChecklistStep } = await import('./RemoteSshChecklistStep');
        const runnerHarness = createRunner();

        let primary: { onPress: (() => void) | (() => Promise<void>); disabled: boolean } | null = null;

        const screen = await renderScreen(React.createElement(RemoteSshChecklistStep, {
            testID: 'remote-ssh-step',
            mode: 'remoteRelayHost',
            relayUrl: 'https://relay.example.test',
            runner: runnerHarness.runner,
            initialDraft: {
                username: 'dev',
                host: 'example.test',
            },
            onWizardPrimaryChange: (state) => {
                primary = state as any;
            },
        }));

        const requirePrimary = () => {
            if (!primary) {
                throw new Error('Expected wizard primary override');
            }
            return primary;
        };

        const keyfileAuthChoice = screen.findByProps({ testID: 'remote-ssh-step-ssh-sshAuthMethod:keyfile' }) as unknown as { props: { onPress?: () => void } };
        await act(async () => {
            keyfileAuthChoice.props.onPress?.();
        });

        await act(async () => {
            screen.changeTextByTestId('remote-ssh-step-ssh-sshPrivateKeyMaterialInput', 'MY_PRIVATE_KEY');
        });

        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });
        await flushHookEffects({ cycles: 3, turns: 3 });
        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });

        expect(runnerHarness.startSpy).toHaveBeenCalledTimes(1);
        const spec = runnerHarness.startSpy.mock.calls[0]?.[0] as SystemTaskSpec | undefined;
        expect((spec?.params as any)?.ssh?.auth).toBe('keyfile');
        expect((spec?.params as any)?.ssh?.identityPrivateKey).toBe('MY_PRIVATE_KEY');
    });

    it('can bootstrap from the Account catalog and saved password reference without putting material in the SSH draft', async () => {
        const now = Date.now();
        const host = {
                    id: 'rh1',
                    name: 'Prod box',
                    ssh: {
                        target: 'dev@example.test',
                        port: 2222,
                        authMode: 'password' as const,
                        passwordSecretRef: 'happier:shared-secret:v1:ssh-password',
                    },
                    createdAt: now,
                    updatedAt: now,
                    lastUsedAt: 0,
                };
        const source = await homes.addHome({ name: 'Source Home', serverUrl: 'https://source.example', accountId: 'source-account' });
        homes.answer(source, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 4 }) });
        homes.answer(source, '/v2/account/settings', { body: { version: 4, content: { t: 'plain', v: {} } } });
        homes.answer(source, '/v2/account/settings/history', { body: { snapshots: [] } });
        homes.answer(source, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
        homes.answer(source, '/v1/account/entity-rows/remote-hosts', { body: { status: 'present', revision: 4,
            content: { t: 'plain', v: { v: 1, hosts: [host] } } } });
        homes.answer(source, '/v1/features', { body: createRootLayoutFeaturesResponse({ features: { remoteHosts: {
            management: { enabled: true }, secretMaterial: { enabled: true } } } }) });
        homes.answer(source, '/v1/account/saved-secrets/resources/materials', { body: { resources: [{ resourceId: 'ssh-password',
            encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: { t: 'plain', v: { v: 1, name: 'SSH password', kind: 'password', value: 'private-password' } },
            entry: { ref: host.ssh.passwordSecretRef, source: 'shared_resource', relationship: 'owner', name: 'SSH password', kind: 'password', revision: 1,
                materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } } }] } });
        await loadSyncSingletonForTests();
        const native = await loadVitestModuleForNodeRequire(pathToFileURL(createRequire(import.meta.url).resolve('react-native-mmkv')),
            () => import('react-native-mmkv'));
        disposeNativeStorage = native.dispose;
        connection = await restoreServerAccountForTest({ serverUrl: 'https://source.example', accountId: 'source-account', request: homes.request });
        const catalog = await import('@/sync/engine/settings/remoteHostCatalogEngine');
        await catalog.refreshRemoteHostCatalog({ serverId: source, accountId: 'source-account' });

        const { RemoteSshChecklistStep } = await import('./RemoteSshChecklistStep');
        const runnerHarness = createRunner();

        let primary: { onPress: (() => void) | (() => Promise<void>); disabled: boolean } | null = null;

        const screen = await renderScreen(React.createElement(RemoteSshChecklistStep, {
            testID: 'remote-ssh-step',
            mode: 'remoteRelayHost',
            relayUrl: 'https://relay.example.test',
            runner: runnerHarness.runner,
            onWizardPrimaryChange: (state) => {
                primary = state as any;
            },
        }));

        const requirePrimary = () => {
            if (!primary) {
                throw new Error('Expected wizard primary override');
            }
            return primary;
        };

        const hostPicker = screen.findByType('DropdownMenu' as never) as unknown as { props: { onSelect: (id: string) => void } };
        await act(async () => {
            hostPicker.props.onSelect('rh1');
        });

        expect(screen.findAllByTestId('remote-ssh-step-ssh-sshUsernameInput')).toHaveLength(0);
        expect(requirePrimary().disabled).toBe(false);

        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });
        await flushHookEffects({ cycles: 3, turns: 3 });
        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });

        expect(runnerHarness.startSpy).toHaveBeenCalledTimes(1);
        const spec = runnerHarness.startSpy.mock.calls[0]?.[0] as SystemTaskSpec | undefined;
        expect((spec?.params as any)?.ssh?.target).toBe('dev@example.test');
        expect((spec?.params as any)?.ssh?.port).toBe(2222);
        expect((spec?.params as any)?.ssh?.auth).toBe('password');
        expect((spec?.params as any)?.ssh?.password).toBe('private-password');

        expect(runnerHarness.respondSpy).toHaveBeenCalledTimes(0);
    });

    it('prefills the inline SSH form from a configured-host suggestion without selecting a saved host', async () => {
        tauriState.isDesktop = true;
        const { RemoteSshChecklistStep } = await import('./RemoteSshChecklistStep');
        const runnerHarness = createRunner({
            startBehavior: (spec, taskId) => {
                if (spec.kind !== 'local.ssh.discoverConfiguredHosts.v1') {
                    return undefined;
                }
                return {
                    taskId,
                    snapshot: {
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
                            data: [
                                {
                                    id: 'ssh-config:devbox',
                                    alias: 'devbox',
                                    hostname: '10.0.0.5',
                                    port: 2222,
                                    username: 'ubuntu',
                                    source: 'ssh-config',
                                    sourcePath: '/Users/test/.ssh/config',
                                },
                            ],
                        },
                    } as SystemTaskRunState,
                };
            },
        });

        const screen = await renderScreen(React.createElement(RemoteSshChecklistStep, {
            testID: 'remote-ssh-step',
            mode: 'remoteRelayHost',
            relayUrl: 'https://relay.example.test',
            runner: { ...runnerHarness.runner, mode: 'tauri' },
        }));

        await flushHookEffects({ cycles: 3, turns: 3 });

        const menu = screen.findByTestId('remote-ssh-step-configured-host-picker-menu') as unknown as {
            props: { onSelect: (id: string) => void };
        } | null;
        expect(menu).toBeTruthy();

        await act(async () => {
            menu?.props.onSelect('ssh-config:devbox');
        });

        expect(screen.findByTestId('remote-ssh-step-ssh-sshUsernameInput')?.props.value).toBe('ubuntu');
        expect(screen.findByTestId('remote-ssh-step-ssh-sshHostInput')?.props.value).toBe('devbox');
        expect(screen.findByTestId('remote-ssh-step-ssh-sshPortInput')?.props.value).toBe('2222');
        expect(screen.findAllByTestId('remote-ssh-step-remote-host-picker')).toHaveLength(0);
    });

    it('routes the remote Personal Home plan through the canonical remote host action', async () => {
        const { RemoteSshChecklistStep } = await import('./RemoteSshChecklistStep');
        const runnerHarness = createRunner();
        let primary: { onPress: (() => void) | (() => Promise<void>); disabled: boolean } | null = null;

        const screen = await renderScreen(React.createElement(RemoteSshChecklistStep, {
            testID: 'remote-ssh-step',
            mode: 'remoteRelayHost',
            relayUrl: 'https://relay.example.test',
            runner: runnerHarness.runner,
            initialDraft: {
                username: 'dev',
                host: 'example.test',
            },
            onWizardPrimaryChange: (state) => {
                primary = state as any;
            },
        }));

        const requirePrimary = () => {
            if (!primary) {
                throw new Error('Expected wizard primary override');
            }
            return primary;
        };

        expect(screen.findAllByType('ItemGroup' as never)).toHaveLength(0);
        expect(screen.findByTestId('remote-ssh-step-ssh-sshUsernameInput')).toBeTruthy();
        expect(requirePrimary().disabled).toBe(false);

        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });
        expect(screen.findByTestId('remote-ssh-step-plan')).toBeTruthy();
        const planStatusSlot = screen.findByTestId('remote-ssh-step-plan-row-install_relay_runtime-status-slot');
        if (!planStatusSlot) {
            throw new Error('Expected remote SSH plan status slot');
        }
        expect(screen.findByTestId('remote-ssh-step-plan-row-install_relay_runtime')).toBeTruthy();
        expect(screen.findAllByTestId('remote-ssh-step-plan-row-install_daemon')).toHaveLength(0);
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(requirePrimary().disabled).toBe(false);

        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });

        expect(runnerHarness.startSpy).toHaveBeenCalledTimes(1);
        const spec = runnerHarness.startSpy.mock.calls[0]?.[0] as SystemTaskSpec | undefined;
        expect(spec).toMatchObject({
            kind: 'remote.ssh.manageHost.v1',
            params: {
                action: 'personalHome.create',
                relayRuntime: { mode: 'user' },
                pairDevice: true,
                enrollInvokingClient: true,
                ssh: { target: 'dev@example.test', auth: 'agent' },
            },
        });
        expect(runnerHarness.startSpy.mock.calls.some(
            ([candidate]) => candidate.kind === 'remote.ssh.bootstrapMachine.v1',
        )).toBe(false);
        const executionStatusSlot = screen.findByTestId('remote-ssh-step-execution-row-install_relay_runtime-status-slot');
        if (!executionStatusSlot) {
            throw new Error('Expected remote SSH execution status slot');
        }
        expect(screen.findByTestId('remote-ssh-step-execution')).toBeTruthy();
    });

    it('prefers the explicit public relay URL when completing remote relay hosting', async () => {
        const { RemoteSshChecklistStep } = await import('./RemoteSshChecklistStep');
        const runnerHarness = createRunner({
            snapshot: {
                status: 'running',
                currentStepId: 'relay.runtime.install',
                latestMessage: 'Done',
                awaitingInput: false,
                events: [],
                result: {
                    ok: true,
                    data: {
                        relayRuntime: {
                            relayUrl: 'http://127.0.0.1:53288',
                        },
                    },
                },
            } as any,
        });
        const completed: Array<{
            machineId: string | null;
            relayRuntimeUrl: string | null;
            relayAccessTarget: RelayAccessTaskTarget | null;
            mode: RemoteSshChecklistMode;
        }> = [];
        let primary: { onPress: (() => void) | (() => Promise<void>); disabled: boolean } | null = null;

        const screen = await renderScreen(React.createElement(RemoteSshChecklistStep, {
            testID: 'remote-ssh-step',
            mode: 'remoteRelayHost',
            relayUrl: 'https://relay.example.test',
            publicRelayUrl: 'https://public-relay.example.test',
            runner: runnerHarness.runner,
            initialDraft: {
                username: 'dev',
                host: 'example.test',
            },
            onCompleted: (payload) => {
                completed.push(payload);
            },
            onWizardPrimaryChange: (state) => {
                primary = state as any;
            },
        }));

        const requirePrimary = () => {
            if (!primary) {
                throw new Error('Expected wizard primary override');
            }
            return primary;
        };

        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });
        await flushHookEffects({ cycles: 3, turns: 3 });
        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });
        await flushHookEffects({ cycles: 3, turns: 3 });

        expect(completed).toEqual([
            expect.objectContaining({
                relayRuntimeUrl: 'https://public-relay.example.test',
                relayAccessTarget: {
                    kind: 'ssh',
                    ssh: {
                        target: 'dev@example.test',
                        auth: 'agent',
                    },
                },
            }),
        ]);
        const profiles = await import('@/sync/domains/server/serverProfiles');
        expect(profiles.listServerProfiles().filter(
            (profile) => profile.serverUrl === 'https://public-relay.example.test',
        )).toEqual([
            expect.objectContaining({
                canonicalServerUrl: 'https://public-relay.example.test',
                source: 'manual',
            }),
        ]);
        const completeStatusSlot = screen.findByTestId('remote-ssh-step-complete-checklist-row-install_relay_runtime-status-slot');
        if (!completeStatusSlot) {
            throw new Error('Expected remote SSH completion status slot');
        }
        expect(screen.findByTestId('remote-ssh-step-complete-checklist-row-install_relay_runtime')).toBeTruthy();
        expect(screen.getTextContent()).toContain('https://public-relay.example.test');
        expect(screen.getTextContent()).not.toContain('http://127.0.0.1:53288');
    });

    it('does not emit a loopback relay URL when remote relay hosting only discovers a local bind URL', async () => {
        const { RemoteSshChecklistStep } = await import('./RemoteSshChecklistStep');
        const runnerHarness = createRunner({
            snapshot: {
                status: 'running',
                currentStepId: 'relay.runtime.install',
                latestMessage: 'Done',
                awaitingInput: false,
                events: [],
                result: {
                    ok: true,
                    data: {
                        relayRuntime: {
                            relayUrl: 'http://127.0.0.1:53288',
                        },
                    },
                },
            } as any,
        });
        const completed: Array<{
            machineId: string | null;
            relayRuntimeUrl: string | null;
            relayAccessTarget: RelayAccessTaskTarget | null;
            mode: RemoteSshChecklistMode;
        }> = [];
        let primary: { onPress: (() => void) | (() => Promise<void>); disabled: boolean } | null = null;

        const screen = await renderScreen(React.createElement(RemoteSshChecklistStep, {
            testID: 'remote-ssh-step',
            mode: 'remoteRelayHost',
            relayUrl: 'https://relay.example.test',
            runner: runnerHarness.runner,
            initialDraft: {
                username: 'dev',
                host: 'example.test',
            },
            onCompleted: (payload) => {
                completed.push(payload);
            },
            onWizardPrimaryChange: (state) => {
                primary = state as any;
            },
        }));

        const requirePrimary = () => {
            if (!primary) {
                throw new Error('Expected wizard primary override');
            }
            return primary;
        };

        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });
        await flushHookEffects({ cycles: 3, turns: 3 });
        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });
        await flushHookEffects({ cycles: 3, turns: 3 });

        expect(completed).toEqual([
            expect.objectContaining({
                relayRuntimeUrl: null,
            }),
        ]);
        expect(screen.getTextContent()).not.toContain('127.0.0.1:53288');
    });

    it('uses wizard chrome actions for SSH password prompts', async () => {
        const { RemoteSshChecklistStep } = await import('./RemoteSshChecklistStep');
        const runnerHarness = createRunner({
            snapshot: {
                status: 'running',
                currentStepId: 'relay.runtime.install',
                latestMessage: 'Password required',
                awaitingInput: true,
                events: [
                    {
                        type: 'prompt',
                        stepId: 'ssh.password',
                        message: 'Enter password',
                        data: { kind: 'ssh.password', target: 'lima' },
                    },
                ],
                result: null,
            } as any,
        });

        let primary: { label?: string; onPress: (() => void) | (() => Promise<void>); disabled: boolean } | null = null;
        let skip: { label?: React.ReactNode; hidden?: boolean; disabled?: boolean; onPress?: () => void } | null = null;
        const handlePrimaryChange = (state: unknown) => {
            primary = state as any;
        };
        const handleSkipChange = (state: unknown) => {
            skip = state as any;
        };
        const requirePrimary = () => {
            if (!primary) {
                throw new Error('Expected wizard primary override');
            }
            return primary;
        };
        const requireSkip = () => {
            if (!skip) {
                throw new Error('Expected wizard skip override');
            }
            return skip;
        };

        const makeElement = () => React.createElement(RemoteSshChecklistStep, {
            testID: 'remote-ssh-step',
            mode: 'remoteRelayHost',
            relayUrl: 'https://relay.example.test',
            runner: runnerHarness.runner,
            initialDraft: {
                username: 'dev',
                host: 'example.test',
                authMode: 'password',
            },
            onWizardPrimaryChange: handlePrimaryChange,
            onWizardSkipChange: handleSkipChange,
        });

        const screen = await renderScreen(makeElement());

        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });
        await flushHookEffects({ cycles: 3, turns: 3 });
        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });

        expect(runnerHarness.startSpy).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('remote-ssh-step-execution')).toBeTruthy();

        expect(requireSkip().hidden).not.toBe(true);
        expect(requirePrimary().disabled).toBe(true);
        expect(screen.findByTestId('remote-ssh-step-prompt-password')).toBeTruthy();

        await act(async () => {
            screen.changeTextByTestId('remote-ssh-step-prompt-password', 'hunter2');
        });
        expect(requirePrimary().disabled).toBe(false);

        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });

        expect(runnerHarness.respondSpy).toHaveBeenCalledTimes(1);

        await act(async () => {
            requireSkip().onPress?.();
        });
        expect(runnerHarness.cancelSpy).toHaveBeenCalledTimes(1);
    });

    it('answers remote background service replacement prompts through wizard chrome actions', async () => {
        const { RemoteSshChecklistStep } = await import('./RemoteSshChecklistStep');
        const runnerHarness = createRunner({
            snapshot: {
                status: 'running',
                currentStepId: 'daemon.service.preflight',
                latestMessage: 'Existing background services detected',
                awaitingInput: true,
                events: [
                    {
                        type: 'prompt',
                        stepId: 'daemon.service.preflight',
                        message: 'Remote machine already has Happier background services. Replace them with the selected release channel?',
                        data: {
                            kind: 'daemon.replaceRemoteBackgroundServices',
                            targetServerUrl: 'https://relay.example.test',
                            targetReleaseChannel: 'preview',
                            services: [
                                { label: 'happier-daemon.stable', releaseChannel: 'stable', targetMode: 'pinned', running: true },
                            ],
                        },
                    },
                ],
                result: null,
            } as any,
        });

        let primary: { label?: string; onPress: (() => void) | (() => Promise<void>); disabled: boolean } | null = null;
        let skip: { label?: React.ReactNode; hidden?: boolean; disabled?: boolean; onPress?: () => void } | null = null;
        const screen = await renderScreen(React.createElement(RemoteSshChecklistStep, {
            testID: 'remote-ssh-step',
            mode: 'remoteMachine',
            relayUrl: 'https://relay.example.test',
            runner: runnerHarness.runner,
            initialDraft: {
                username: 'dev',
                host: 'example.test',
            },
            onWizardPrimaryChange: (state) => {
                primary = state as any;
            },
            onWizardSkipChange: (state) => {
                skip = state as any;
            },
        }));

        const requirePrimary = () => {
            if (!primary) throw new Error('Expected wizard primary override');
            return primary;
        };
        const requireSkip = () => {
            if (!skip) throw new Error('Expected wizard skip override');
            return skip;
        };

        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });
        await flushHookEffects({ cycles: 3, turns: 3 });
        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });

        expect(screen.findByTestId('remote-ssh-step-prompt-password')).toBeTruthy();
        // Declining stops setup, so the secondary says Cancel like both modals do.
        expect(requireSkip().label).toBe('Cancel');
        expect(requirePrimary().label).toBe('Replace services');

        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });

        expect(runnerHarness.respondSpy).toHaveBeenCalledWith(expect.any(String), { replaceExistingServices: true });
    });

    it('answers a declined remote release-channel switch instead of cancelling the task', async () => {
        const { RemoteSshChecklistStep } = await import('./RemoteSshChecklistStep');
        const runnerHarness = createRunner({
            snapshot: {
                status: 'running',
                currentStepId: 'personal_home.release_channel_preflight',
                latestMessage: 'Switch the remote default release channel?',
                awaitingInput: true,
                events: [{
                    type: 'prompt',
                    stepId: 'personal_home.release_channel_preflight',
                    message: 'Switch the remote default release channel?',
                    data: {
                        kind: 'releaseChannel.switchDefaultForSetup',
                        targetReleaseChannel: 'preview',
                        currentDefaultReleaseChannel: 'stable',
                        targetServerUrl: null,
                        managedReleaseChannels: [],
                    },
                }],
                result: null,
            } as any,
        });

        let primary: { label?: string; onPress: (() => void) | (() => Promise<void>); disabled: boolean } | null = null;
        let skip: { label?: React.ReactNode; hidden?: boolean; disabled?: boolean; onPress?: () => void } | null = null;
        await renderScreen(React.createElement(RemoteSshChecklistStep, {
            testID: 'remote-ssh-step',
            mode: 'remoteRelayHost',
            relayUrl: 'https://relay.example.test',
            runner: runnerHarness.runner,
            initialDraft: { username: 'dev', host: 'example.test' },
            onWizardPrimaryChange: (state) => { primary = state as any; },
            onWizardSkipChange: (state) => { skip = state as any; },
        }));

        const requirePrimary = () => {
            if (!primary) throw new Error('Expected wizard primary override');
            return primary;
        };
        const requireSkip = () => {
            if (!skip) throw new Error('Expected wizard skip override');
            return skip;
        };

        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });
        await flushHookEffects({ cycles: 3, turns: 3 });
        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });

        expect(requirePrimary().label).toBe('Continue');
        expect(requireSkip().label).toBe('Cancel');

        await act(async () => {
            await (requirePrimary().onPress as any)?.();
        });
        expect(runnerHarness.respondSpy).toHaveBeenCalledWith(expect.any(String), { switchDefaultReleaseChannel: true });
        runnerHarness.respondSpy.mockClear();

        await act(async () => {
            requireSkip().onPress?.();
        });

        expect(runnerHarness.respondSpy).toHaveBeenCalledWith(expect.any(String), { switchDefaultReleaseChannel: false });
        expect(runnerHarness.cancelSpy).not.toHaveBeenCalled();
    });
});

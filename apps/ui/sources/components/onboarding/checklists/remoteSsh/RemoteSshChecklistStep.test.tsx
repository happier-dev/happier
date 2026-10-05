import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import type { SystemTaskJsonObject, SystemTaskSpec } from '@happier-dev/protocol';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';
import { getStorage } from '@/sync/domains/state/storageStore';

import type { RemoteSshChecklistMode } from './types';

const featureGateState = vi.hoisted(() => ({
    managementEnabled: true,
    secretMaterialEnabled: true,
}));

const tauriState = vi.hoisted(() => ({
    isDesktop: false,
}));

const syncSingletonState = vi.hoisted(() => ({
    applySettings: vi.fn(),
    decryptSecretValue: vi.fn(() => null),
    encryptSecretValue: vi.fn(() => null),
}));

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({
        applySettings: syncSingletonState.applySettings,
        decryptSecretValue: syncSingletonState.decryptSecretValue,
        encryptSecretValue: syncSingletonState.encryptSecretValue,
    }),
}));

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

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => tauriState.isDesktop,
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

function createSucceededSnapshot(
    taskId: string,
    params: Readonly<{
        currentStepId: string;
        latestMessage: string;
        data?: SystemTaskJsonObject;
    }>,
): SystemTaskRunState {
    return {
        taskId,
        status: 'succeeded',
        currentStepId: params.currentStepId,
        latestMessage: params.latestMessage,
        awaitingInput: false,
        cancelRequested: false,
        events: [],
        result: {
            protocolVersion: 1,
            taskId,
            ok: true,
            ...(params.data ? { data: params.data } : {}),
        },
    };
}

function flattenStyle(style: unknown): Record<string, unknown> {
    return Array.isArray(style)
        ? Object.assign({}, ...style.filter(Boolean) as Array<Record<string, unknown>>)
        : (style as Record<string, unknown>);
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
        act(() => {
            getStorage().getState().applySettingsLocal({ remoteHostsV1: [] });
        });
        featureGateState.managementEnabled = true;
        featureGateState.secretMaterialEnabled = true;
        tauriState.isDesktop = false;
        syncSingletonState.applySettings.mockReset();
        syncSingletonState.decryptSecretValue.mockReset();
        syncSingletonState.decryptSecretValue.mockReturnValue(null);
        syncSingletonState.encryptSecretValue.mockReset();
        syncSingletonState.encryptSecretValue.mockReturnValue(null);
        await resetProfileRegistry();
    });

    it('adopts a discovered relay through the Home owner without changing focus or groups, then links the saved host', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const focusedHome = await profiles.upsertServerProfile({
            serverUrl: 'https://focused-home.example',
            name: 'Focused Home',
            source: 'manual',
        });
        await profiles.setActiveServerId(focusedHome.id);
        await profiles.saveHomeViewState({
            version: 1,
            groups: [{ id: 'visible-homes', name: 'Visible Homes', serverIds: [focusedHome.id] }],
            activeTargetKind: 'server',
            activeTargetId: focusedHome.id,
        });
        const focusedBefore = profiles.getActiveServerSnapshot();
        const homeViewBefore = profiles.loadHomeViewState();
        const { persistRemoteHostAfterRemoteSshCompletion } = await import('./persistRemoteHostAfterRemoteSshCompletion');

        await persistRemoteHostAfterRemoteSshCompletion({
            managementEnabled: true,
            secretMaterialEnabled: true,
            remoteHostsRaw: [],
            selectedSavedRemoteHostId: '__new__',
            runContext: {
                selectedSavedRemoteHostId: '__new__',
                saveHost: true,
                saveSecretMaterial: false,
            },
            newHostSentinelId: '__new__',
            draft: {
                username: 'dev',
                host: 'remote.example',
                port: '22',
                authMode: 'agent',
                identityFilePath: '',
                password: '',
            },
            privateKeyMaterialDraft: '',
            completion: {
                machineId: 'machine-remote',
                relayRuntimeUrl: 'https://relay.remote.example',
            },
        });

        const relayProfiles = profiles.listServerProfiles().filter((profile) => profile.serverUrl === 'https://relay.remote.example');
        expect(relayProfiles).toHaveLength(1);
        expect(relayProfiles[0]).toMatchObject({
            canonicalServerUrl: 'https://relay.remote.example',
            source: 'manual',
        });
        const writtenHost = syncSingletonState.applySettings.mock.calls.at(-1)?.[0]?.remoteHostsV1?.[0];
        expect(writtenHost).toMatchObject({
            linkedMachineId: 'machine-remote',
            linkedRelayProfileId: relayProfiles[0]!.id,
        });
        expect(profiles.getActiveServerSnapshot()).toMatchObject({
            serverId: focusedBefore.serverId,
            serverUrl: focusedBefore.serverUrl,
            isSelectionExplicit: focusedBefore.isSelectionExplicit,
        });
        expect(profiles.loadHomeViewState()).toEqual(homeViewBefore);
    });

    it('rejects a malformed discovered relay before linking or persisting a remote host', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const before = profiles.listServerProfiles();
        const { persistRemoteHostAfterRemoteSshCompletion } = await import('./persistRemoteHostAfterRemoteSshCompletion');

        await expect(persistRemoteHostAfterRemoteSshCompletion({
            managementEnabled: true,
            secretMaterialEnabled: false,
            remoteHostsRaw: [],
            selectedSavedRemoteHostId: '__new__',
            runContext: {
                selectedSavedRemoteHostId: '__new__',
                saveHost: true,
                saveSecretMaterial: false,
            },
            newHostSentinelId: '__new__',
            draft: {
                username: 'dev',
                host: 'remote.example',
                port: '',
                authMode: 'agent',
                identityFilePath: '',
                password: '',
            },
            privateKeyMaterialDraft: '',
            completion: { machineId: null, relayRuntimeUrl: 'ssh://not-a-home' },
        })).rejects.toThrow('Invalid Home connection URL');

        expect(profiles.listServerProfiles()).toEqual(before);
        expect(syncSingletonState.applySettings).not.toHaveBeenCalled();
    });

    it('still adopts a discovered relay when remote-host management is disabled', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { persistRemoteHostAfterRemoteSshCompletion } = await import('./persistRemoteHostAfterRemoteSshCompletion');

        await persistRemoteHostAfterRemoteSshCompletion({
            managementEnabled: false,
            secretMaterialEnabled: false,
            remoteHostsRaw: [],
            selectedSavedRemoteHostId: '__new__',
            runContext: null,
            newHostSentinelId: '__new__',
            draft: {
                username: 'dev',
                host: 'remote.example',
                port: '',
                authMode: 'agent',
                identityFilePath: '',
                password: '',
            },
            privateKeyMaterialDraft: '',
            completion: {
                machineId: null,
                relayRuntimeUrl: 'https://unmanaged-relay.remote.example',
            },
        });

        expect(profiles.listServerProfiles().filter(
            (profile) => profile.serverUrl === 'https://unmanaged-relay.remote.example',
        )).toEqual([
            expect.objectContaining({
                serverUrl: 'https://unmanaged-relay.remote.example',
                canonicalServerUrl: 'https://unmanaged-relay.remote.example',
                source: 'manual',
            }),
        ]);
        expect(syncSingletonState.applySettings).not.toHaveBeenCalled();
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
        act(() => {
            getStorage().getState().applySettingsLocal({
                remoteHostsV1: [
                    {
                        id: 'host-1',
                        name: 'Test Host',
                        ssh: {
                            target: 'dev@example.test',
                            port: 22,
                            authMode: 'agent',
                        },
                        createdAt: 1,
                        updatedAt: 1,
                        lastUsedAt: 1,
                    },
                ],
            });
        });
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

    it('can bootstrap using a saved remote host (hides the inline SSH form) and uses passwordEnc automatically without extra user clicks', async () => {
        const now = Date.now();
        getStorage().getState().applySettingsLocal({
            remoteHostsV1: [
                {
                    id: 'rh1',
                    name: 'Prod box',
                    ssh: {
                        target: 'dev@example.test',
                        port: 2222,
                        authMode: 'password',
                        passwordEnc: { _isSecretValue: true, value: 'hunter2' },
                    },
                    createdAt: now,
                    updatedAt: now,
                    lastUsedAt: 0,
                },
            ],
        });

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
        expect((spec?.params as any)?.ssh?.password).toBe('hunter2');

        expect(runnerHarness.respondSpy).toHaveBeenCalledTimes(0);
    });

    it('preserves opaque remote-host rows when onboarding updates the selected saved host', async () => {
        const currentHost = {
            id: 'host-1',
            name: 'Developer workstation',
            ssh: {
                target: 'dev@example.test',
                authMode: 'agent' as const,
            },
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
        };
        const opaqueFutureHost = {
            v: 2,
            id: 'future-host',
            transport: 'future-transport',
            futureData: { retained: true },
        };
        act(() => {
            getStorage().getState().applySettingsLocal({
                remoteHostsV1: [currentHost, opaqueFutureHost],
            });
        });

        const runnerHarness = createRunner({
            startBehavior: (spec, taskId) => spec.kind === 'remote.ssh.bootstrapMachine.v1'
                ? {
                    taskId,
                    snapshot: createSucceededSnapshot(taskId, {
                        currentStepId: 'ssh.complete',
                        latestMessage: 'Complete',
                        data: { machineId: 'machine-1' },
                    }),
                }
                : undefined,
        });
        let primary: { onPress: (() => void) | (() => Promise<void>); disabled: boolean } | null = null;

        const { RemoteSshChecklistStep } = await import('./RemoteSshChecklistStep');
        const screen = await renderScreen(React.createElement(RemoteSshChecklistStep, {
            testID: 'remote-ssh-step',
            mode: 'remoteMachine',
            relayUrl: 'https://relay.example.test',
            runner: runnerHarness.runner,
            onWizardPrimaryChange: (state) => {
                primary = state as typeof primary;
            },
        }));

        const requirePrimary = () => {
            if (!primary) {
                throw new Error('Expected wizard primary override');
            }
            return primary;
        };

        const hostPicker = screen.findByType('DropdownMenu' as never) as unknown as {
            props: { onSelect: (id: string) => void };
        };
        await act(async () => {
            hostPicker.props.onSelect(currentHost.id);
        });
        await act(async () => {
            await requirePrimary().onPress();
        });
        await flushHookEffects({ cycles: 3, turns: 3 });
        await act(async () => {
            await requirePrimary().onPress();
        });
        await flushHookEffects({ cycles: 3, turns: 3 });

        const writtenSettings = syncSingletonState.applySettings.mock.calls.at(-1)?.[0];
        expect(writtenSettings?.remoteHostsV1).toHaveLength(2);
        expect(writtenSettings?.remoteHostsV1[0]).toMatchObject({
            id: currentHost.id,
            linkedMachineId: 'machine-1',
        });
        expect(writtenSettings?.remoteHostsV1[1]).toStrictEqual(opaqueFutureHost);
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
        const flattenedPlanStatusSlotStyle = flattenStyle(planStatusSlot.props.style);
        expect(flattenedPlanStatusSlotStyle.borderWidth).toBe(1);
        expect(Number(flattenedPlanStatusSlotStyle.width)).toBeGreaterThan(26);
        expect(Number(flattenedPlanStatusSlotStyle.height)).toBeGreaterThan(26);
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
        const flattenedExecutionStatusSlotStyle = flattenStyle(executionStatusSlot.props.style);
        expect(flattenedExecutionStatusSlotStyle.borderWidth).toBe(1);
        expect(Number(flattenedExecutionStatusSlotStyle.width)).toBeGreaterThan(26);
        expect(Number(flattenedExecutionStatusSlotStyle.height)).toBeGreaterThan(26);
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
        const flattenedCompleteStatusSlotStyle = flattenStyle(completeStatusSlot.props.style);
        expect(flattenedCompleteStatusSlotStyle.borderWidth).toBe(1);
        expect(Number(flattenedCompleteStatusSlotStyle.width)).toBeGreaterThan(26);
        expect(Number(flattenedCompleteStatusSlotStyle.height)).toBeGreaterThan(26);
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

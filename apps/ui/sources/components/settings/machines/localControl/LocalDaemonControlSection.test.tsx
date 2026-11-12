import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';
import * as React from 'react';
import { Item } from '@/components/ui/lists/Item';
import renderer from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, findTestInstanceByTypeWithProps } from '@/dev/testkit';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { storage } from '@/sync/domains/state/storageStore';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

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

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();

// Plan 71 §4: mounted setup controls use the real signed-in Action path. Waive only
// configurable Action approval here; the native Account-move decision stays real.
async function selectHome(serverUrl: string, name: string) {
    const serverId = await homes.addHome({ serverUrl, name, accountId: 'acct_app' });
    storage.setState({ settingsScope: { serverId, accountId: 'acct_app' }, profileScope: { serverId, accountId: 'acct_app' },
        profile: { ...storage.getState().profile, id: 'acct_app' } });
    const settings = { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({
        v: 1, approvalWaivedSurfaces: { 'machines.add.local.start': ['ui'],
            'machines.local.service.start': ['ui'], 'machines.local.service.update': ['ui'] },
    }) };
    storage.getState().applySettingsForScope({ serverId, accountId: 'acct_app' }, settings, 2);
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 2 } });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    return serverId;
}

// Read the same installed text boundary as the connection presenters.
const { t: localizedText } = await import('@/text');

describe('LocalDaemonControlSection', () => {
    // The component's cold module graph is large; loading it once here (after the module mocks above
    // are installed) keeps that one-time cost out of the first test's own timeout, where it timed out
    // under load (93 s observed on a shared host). Every test's `await import` then reuses it.
    beforeAll(async () => {
        const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
        await loadSyncSingletonForTests();
        await import('./LocalDaemonControlSection');
    }, 300_000);

    beforeEach(async () => {
        // Desktop authentication uses OS custody, including the real Action entry below.
        const secureStorage = createDesktopSecureStorageBoundary();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: secureStorage.invoke });
        vi.stubGlobal('isTauri', true);
        await homes.reset();
        await selectHome('https://relay.example.test', 'Home A');
    });

    afterEach(() => { standardCleanup(); publishAppliedActiveServerRuntimeAvailability(false); vi.unstubAllGlobals(); });

    it('loads daemon status on mount and starts the local daemon service from the control row', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema} = await import('@happier-dev/protocol/system/tasks/spec');

        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();
        const starts: unknown[] = [];

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push(parsed);
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

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));

        // R10 D3: the mount read addresses the daemon serving the app's own server.
        expect(starts[0]).toMatchObject({
            kind: 'daemon.service.status.v1',
            params: {
                target: { kind: 'local' },
                surface: 'desktop.ui',
                mode: 'user',
                relayUrl: 'https://relay.example.test',
            },
        });

        await renderer.act(async () => {
            listeners.get('task_1:daemon.service.status.v1')?.onResult({
                protocolVersion: 1,
                taskId: 'task_1:daemon.service.status.v1',
                ok: true,
                data: {
                    serviceInstalled: true,
                    daemonRunning: false,
                    needsAuth: false,
                    machineId: 'machine-local-1',
                    daemonServerUrl: 'https://relay.example.test',
                },
            });
        });

        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'settings.localDaemonControl.status' })?.props.subtitle)
            .toBe(localizedText('machine.thisComputer.description.daemon_not_running', { home: 'Home A' }));
        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'settings.localDaemonControl.machineId' })?.props.subtitle).toBe('machine-local-1');

        await screen.pressByTestIdAsync('settings.localDaemonControl.start');

        expect(starts.find((entry) => (entry as { kind?: unknown }).kind === 'daemon.service.start.v1'))
            .toMatchObject({ params: { relayUrl: 'https://relay.example.test' } });
    });

    // S11 + R10 D1: a daemon signed in to another account on this Home is not "likely alive" for
    // this user. The section names both accounts, offers the one switch, and asks before moving it.
    it('names a daemon of another account and asks before switching it', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema} = await import('@happier-dev/protocol/system/tasks/spec');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        const { Modal } = await import('@/modal');
        storage.setState({ profile: { ...profileDefaults, id: 'acct_app', username: 'leeroy' } });

        let nextTaskId = 1;
        const listeners = new Map<string, { onEvent: (payload: unknown) => void; onResult: (payload: unknown) => void }>();
        const starts: Array<{ kind: string }> = [];
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push(parsed);
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

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await renderer.act(async () => {
            listeners.get('task_1:daemon.service.status.v1')?.onResult({
                protocolVersion: 1,
                taskId: 'task_1:daemon.service.status.v1',
                ok: true,
                data: {
                    serviceInstalled: true,
                    daemonRunning: true,
                    needsAuth: false,
                    machineId: 'machine-of-other-account',
                    daemonServerUrl: 'https://relay.example.test',
                    daemonAccountId: 'acct_other',
                    daemonAccountLabel: 'robin',
                },
            });
        });

        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'settings.localDaemonControl.status' })?.props.subtitle)
            .toBe(localizedText('machine.thisComputer.description.daemon_account_mismatch', {
                home: 'Home A', daemonAccount: 'robin', appAccount: 'leeroy',
            }));
        expect(findTestInstanceByTypeWithProps(screen, RoundButton, { testID: 'settings.localDaemonControl.repair' })?.props.title)
            .toBe(localizedText('machine.thisComputer.action.daemon_account_mismatch', { appAccount: 'leeroy' }));

        const confirm = vi.mocked(Modal.confirm);
        confirm.mockClear();
        confirm.mockResolvedValueOnce(false);
        await screen.pressByTestIdAsync('settings.localDaemonControl.repair');
        await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
        expect(starts.some((entry) => entry.kind === 'setup.repairThisComputer.v1')).toBe(false);
        storage.setState({ profile: { ...profileDefaults } });
    });

    // R17: Settings › This computer names the CLI version and offers exactly one Update when the
    // CLI's own check reports a newer managed build; a CLI the app did not install shows its origin.
    it('offers one CLI update for a managed CLI and names the origin of one it did not install', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema} = await import('@happier-dev/protocol/system/tasks/spec');
        let nextTaskId = 1;
        const listeners = new Map<string, { onEvent: (payload: unknown) => void; onResult: (payload: unknown) => void }>();
        const starts: Array<{ kind: string }> = [];
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push(parsed);
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
        const statusData = (cliUpdate: Record<string, unknown>) => ({
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            machineId: 'machine-local-1',
            daemonServerUrl: 'https://relay.example.test',
            cliUpdate,
        });

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await renderer.act(async () => {
            listeners.get('task_1:daemon.service.status.v1')?.onResult({
                protocolVersion: 1,
                taskId: 'task_1:daemon.service.status.v1',
                ok: true,
                data: statusData({ currentVersion: '0.3.0', latestVersion: '0.3.1', updateAvailable: true, managed: true }),
            });
        });

        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'settings.localDaemonControl.cliVersion' })?.props.title)
            .toBe('machine.thisComputer.cli.updateAvailable');
        await screen.pressByTestIdAsync('settings.localDaemonControl.cliUpdate');
        // The update restarts the app's own server's service, not the terminal's.
        expect(starts.find((entry) => entry.kind === 'cli.update.v1'))
            .toMatchObject({ params: { relayUrl: 'https://relay.example.test' } });

        // The update answers with versions, never a status; the owner re-reads status after it.
        const updateTaskId = [...listeners.keys()].find((id) => id.endsWith('cli.update.v1'))!;
        await renderer.act(async () => {
            listeners.get(updateTaskId)?.onResult({
                protocolVersion: 1,
                taskId: updateTaskId,
                ok: true,
                data: { previousVersion: '0.3.0', version: '0.3.1', restarted: true },
            });
        });
        const refreshTaskId = [...listeners.keys()].filter((id) => id.endsWith('daemon.service.status.v1')).at(-1)!;
        expect(refreshTaskId).not.toBe('task_1:daemon.service.status.v1');
        expect(starts.filter((entry) => entry.kind === 'daemon.service.status.v1').at(-1))
            .toMatchObject({ params: { relayUrl: 'https://relay.example.test' } });
        await renderer.act(async () => {
            listeners.get(refreshTaskId)?.onResult({
                protocolVersion: 1,
                taskId: refreshTaskId,
                ok: true,
                data: statusData({
                    currentVersion: '0.3.0',
                    latestVersion: '0.3.1',
                    updateAvailable: true,
                    managed: false,
                    origin: '/opt/homebrew/bin/happier',
                }),
            });
        });
        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'settings.localDaemonControl.cliVersion' })?.props.subtitle)
            .toBe('machine.thisComputer.cli.notManaged');
        expect(findTestInstanceByTypeWithProps(screen, RoundButton, { testID: 'settings.localDaemonControl.cliUpdate' })).toBeUndefined();
    });

    it('shares one CLI update run and one status across every surface that offers it (S-10)', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema} = await import('@happier-dev/protocol/system/tasks/spec');
        let nextTaskId = 1;
        const listeners = new Map<string, { onEvent: (payload: unknown) => void; onResult: (payload: unknown) => void }>();
        const starts: Array<{ kind: string }> = [];
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push(parsed);
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
        const statusData = (currentVersion: string) => ({
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            machineId: 'machine-local-1',
            daemonServerUrl: 'https://relay.example.test',
            cliUpdate: { currentVersion, latestVersion: '0.3.1', updateAvailable: currentVersion !== '0.3.1', managed: true },
        });
        const deliver = async (taskId: string, data: unknown) => {
            await renderer.act(async () => {
                listeners.get(taskId)?.onResult({ protocolVersion: 1, taskId, ok: true, data });
            });
        };

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(React.Fragment, null,
            React.createElement(LocalDaemonControlSection, { runner, key: 'settings' }),
            React.createElement(LocalDaemonControlSection, { runner, key: 'updates' }),
        ));
        // One surface's status read is every surface's status.
        await deliver('task_1:daemon.service.status.v1', statusData('0.3.0'));
        const updateButtons = () => screen.findAllByType(RoundButton).filter((node) => node.props.testID === 'settings.localDaemonControl.cliUpdate');
        expect(updateButtons()).toHaveLength(2);

        await renderer.act(async () => {
            updateButtons()[0]!.props.onPress();
        });
        await renderer.act(async () => {
            updateButtons()[1]?.props.onPress();
        });
        expect(starts.filter((entry) => entry.kind === 'cli.update.v1')).toHaveLength(1);
        // The other surface sees the same run in flight.
        expect(updateButtons().every((node) => node.props.disabled === true)).toBe(true);

        const updateTaskId = [...listeners.keys()].find((id) => id.endsWith('cli.update.v1'))!;
        const statusReadsBefore = starts.filter((entry) => entry.kind === 'daemon.service.status.v1').length;
        await deliver(updateTaskId, { previousVersion: '0.3.0', version: '0.3.1', restarted: true });
        // Success is re-read once for every surface, never inferred from the exit code.
        const statusReads = starts.filter((entry) => entry.kind === 'daemon.service.status.v1');
        expect(statusReads).toHaveLength(statusReadsBefore + 1);
        const refreshTaskId = [...listeners.keys()].filter((id) => id.endsWith('daemon.service.status.v1')).at(-1)!;
        await deliver(refreshTaskId, statusData('0.3.1'));
        expect(screen.findAllByType(Item).filter((node) => node.props.testID === 'settings.localDaemonControl.cliVersion')
            .map((node) => node.props.title)).toEqual(['machine.thisComputer.cli.version', 'machine.thisComputer.cli.version']);
    });

    it('shows an install background service CTA when the service is not installed (desktop only)', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema} = await import('@happier-dev/protocol/system/tasks/spec');

        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();
        const starts: unknown[] = [];

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push(parsed);
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

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));

        await renderer.act(async () => {
            listeners.get('task_1:daemon.service.status.v1')?.onResult({
                protocolVersion: 1,
                taskId: 'task_1:daemon.service.status.v1',
                ok: true,
                data: {
                    serviceInstalled: false,
                    daemonRunning: false,
                    needsAuth: false,
                    machineId: null,
                },
            });
        });

        expect(findTestInstanceByTypeWithProps(screen, RoundButton, { testID: 'settings.localDaemonControl.install' })).toBeTruthy();

        await screen.pressByTestIdAsync('settings.localDaemonControl.install');

        expect(starts).toContainEqual(expect.objectContaining({
            kind: 'setup.repairThisComputer.v1',
            params: expect.objectContaining({
                activeRelayUrl: 'https://relay.example.test',
                activeWebappUrl: 'https://relay.example.test',
                activeLocalRelayUrl: null,
                surface: 'desktop.ui',
            }),
        }));
    });

    it('does not show the install background service CTA when system tasks are not running in tauri mode', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');

        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();

        const runner = createSystemTaskRunner({
            mode: 'dev',
            bridge: {
                async start(spec) {
                    return `task_${nextTaskId++}:${(spec as { kind?: string }).kind ?? 'unknown'}`;
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

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));

        await renderer.act(async () => {
            listeners.get('task_1:daemon.service.status.v1')?.onResult({
                protocolVersion: 1,
                taskId: 'task_1:daemon.service.status.v1',
                ok: true,
                data: {
                    serviceInstalled: false,
                    daemonRunning: false,
                    needsAuth: false,
                    machineId: null,
                },
            });
        });

        expect(findTestInstanceByTypeWithProps(screen, RoundButton, { testID: 'settings.localDaemonControl.install' })).toBeUndefined();
    });

    it('says who manages the command line, shows the old copy, and reasks the one-CLI question (R12)', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema} = await import('@happier-dev/protocol/system/tasks/spec');
        let nextTaskId = 1;
        const listeners = new Map<string, { onEvent: (payload: unknown) => void; onResult: (payload: unknown) => void }>();
        const starts: Array<{ kind: string; params?: unknown }> = [];
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push(parsed);
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
        const statusData = (cliChoice: Record<string, unknown> | null) => ({
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            machineId: 'machine-local-1',
            daemonServerUrl: 'https://relay.example.test',
            cliUpdate: { currentVersion: '0.3.0', latestVersion: '0.3.0', updateAvailable: false, managed: cliChoice?.mode !== 'own' },
            cliChoice,
        });

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await renderer.act(async () => {
            listeners.get('task_1:daemon.service.status.v1')?.onResult({
                protocolVersion: 1,
                taskId: 'task_1:daemon.service.status.v1',
                ok: true,
                data: statusData({
                    mode: 'managed',
                    otherCli: {
                        command: '/usr/local/bin/happier',
                        origin: 'npm',
                        removalCommand: 'npm uninstall -g @happier-dev/cli',
                        updateCommand: 'npm install -g @happier-dev/cli@latest',
                    },
                }),
            });
        });

        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'settings.localDaemonControl.cliVersion' })?.props.subtitle)
            .toBe('machine.thisComputer.cliChoice.managed');
        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'settings.localDaemonControl.oldCli' })?.props).toMatchObject({
            title: 'machine.thisComputer.cliChoice.oldCopyTitle',
            subtitle: 'machine.thisComputer.cliChoice.oldCopyRemove',
            copy: 'npm uninstall -g @happier-dev/cli',
        });

        await screen.pressByTestIdAsync('settings.localDaemonControl.changeCli');
        expect(starts.find((entry) => entry.kind === 'setup.thisComputer.v1')).toMatchObject({
            params: expect.objectContaining({
                activeRelayUrl: 'https://relay.example.test',
                reconsiderCli: true,
            }),
        });
    });

    it('names the kept command line and offers no change when no other CLI exists (R12)', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema} = await import('@happier-dev/protocol/system/tasks/spec');
        const listeners = new Map<string, { onEvent: (payload: unknown) => void; onResult: (payload: unknown) => void }>();
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    return `task_1:${SystemTaskSpecSchema.parse(spec).kind}`;
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });
        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await renderer.act(async () => {
            listeners.get('task_1:daemon.service.status.v1')?.onResult({
                protocolVersion: 1,
                taskId: 'task_1:daemon.service.status.v1',
                ok: true,
                data: {
                    serviceInstalled: true,
                    daemonRunning: true,
                    needsAuth: false,
                    machineId: 'machine-local-1',
                    cliUpdate: { currentVersion: '0.3.0', managed: false, origin: '/usr/local/bin/happier' },
                    cliChoice: { mode: 'own', otherCli: null },
                },
            });
        });
        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'settings.localDaemonControl.cliVersion' })?.props.subtitle)
            .toBe('machine.thisComputer.cliChoice.own');
        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'settings.localDaemonControl.oldCli' })).toBeUndefined();
        expect(findTestInstanceByTypeWithProps(screen, RoundButton, { testID: 'settings.localDaemonControl.changeCli' })).toBeUndefined();
    });

    it('gives the exact command that updates the command line the person kept (A11-08)', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema} = await import('@happier-dev/protocol/system/tasks/spec');
        const listeners = new Map<string, { onEvent: (payload: unknown) => void; onResult: (payload: unknown) => void }>();
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    return `task_1:${SystemTaskSpecSchema.parse(spec).kind}`;
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });
        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await renderer.act(async () => {
            listeners.get('task_1:daemon.service.status.v1')?.onResult({
                protocolVersion: 1,
                taskId: 'task_1:daemon.service.status.v1',
                ok: true,
                data: {
                    serviceInstalled: true,
                    daemonRunning: true,
                    needsAuth: false,
                    machineId: 'machine-local-1',
                    cliUpdate: { currentVersion: '0.3.0', latestVersion: '0.3.1', updateAvailable: true, managed: false, origin: '/usr/local/bin/happier' },
                    cliChoice: {
                        mode: 'own',
                        otherCli: { command: '/usr/local/bin/happier', origin: 'npm', removalCommand: 'npm uninstall -g @happier-dev/cli', updateCommand: 'npm install -g @happier-dev/cli@latest' },
                    },
                },
            });
        });
        const row = findTestInstanceByTypeWithProps(screen, Item, { testID: 'settings.localDaemonControl.keptCliUpdate' });
        expect(row?.props.copy).toBe('npm install -g @happier-dev/cli@latest');
        expect(row?.props.subtitle).toBe('machine.thisComputer.cliChoice.keptUpdate');
        // Happier's own CLI update never runs on a command line the person kept.
        expect(findTestInstanceByTypeWithProps(screen, RoundButton, { testID: 'settings.localDaemonControl.cliUpdate' })).toBeUndefined();
    });

    it('starts the canonical background-service repair task against the active relay, for the app\'s own account (A11-06)', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        storage.setState({ profile: { ...profileDefaults, id: 'acct_app', username: 'leeroy' } });

        const manual = createManualSystemTaskRunner();

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner: manual.runner }));

        const { resolveThisComputerRepairTitle } = await import('./thisComputerConnectionPresentation');
        expect(findTestInstanceByTypeWithProps(screen, RoundButton, { testID: 'settings.localDaemonControl.repair' })?.props.title).toBe(resolveThisComputerRepairTitle(null));

        await renderer.act(async () => manual.emitResult('personal-home-task-1', {
            protocolVersion: 1, taskId: 'personal-home-task-1', ok: true,
            data: { serviceInstalled: false, daemonRunning: false, needsAuth: false, machineId: null },
        }));

        await screen.pressByTestIdAsync('settings.localDaemonControl.repair');

        expect(manual.bridge.start).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'setup.repairThisComputer.v1',
            params: expect.objectContaining({
                activeRelayUrl: 'https://relay.example.test',
                activeWebappUrl: 'https://relay.example.test',
                activeLocalRelayUrl: null,
                activeAccountId: 'acct_app',
                surface: 'desktop.ui',
            }),
        }));
        storage.setState({ profile: { ...profileDefaults } });
    });

    it('answers the repair task\'s token-only pairing prompt through the explicit-target approval owner', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        homes.answer(serverId, '/v1/auth/request/status', { body: { status: 'pending', supportsV2: true } });
        homes.answer(serverId, '/v1/auth/response', { body: { success: true } });

        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        let nextTaskId = 1;
        const respondMock = vi.fn(async (_taskId: string, _answer: unknown) => {});
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    return `task_${nextTaskId++}:${(spec as { kind: string }).kind}`;
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel() {},
                respond: respondMock,
            },
        });

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        await renderer.act(async () => {
            listeners.get('task_1:daemon.service.status.v1')?.onResult({
                protocolVersion: 1, taskId: 'task_1:daemon.service.status.v1', ok: true,
                data: { serviceInstalled: false, daemonRunning: false, needsAuth: false, machineId: null },
            });
        });
        await screen.pressByTestIdAsync('settings.localDaemonControl.repair');

        const repairTaskId = [...listeners.keys()].find((taskId) => taskId.endsWith('setup.repairThisComputer.v1'));
        expect(repairTaskId).toBeTruthy();
        await renderer.act(async () => {
            listeners.get(repairTaskId!)?.onEvent({
                protocolVersion: 1,
                taskId: repairTaskId,
                tsMs: 120,
                type: 'prompt',
                stepId: 'setup.repairThisComputer.authRequest',
                message: 'Approve pairing request',
                data: {
                    kind: 'authRequest',
                    publicKey: 'pub-key-b64',
                    response: 'opaque-token-only-response-b64',
                    responseKind: 'tokenOnly',
                    relayUrl: 'https://relay.example.test',
                    webappUrl: 'https://relay.example.test',
                    cliProvenance: 'managed',
                },
            });
            await Promise.resolve();
            await Promise.resolve();
        });

        await vi.waitFor(() => expect(respondMock).toHaveBeenCalledWith(repairTaskId, { approved: true }));
        expect(homes.requestsFor('/v1/auth/response')).toMatchObject([{ serverId,
            input: { publicKey: 'pub-key-b64', responseKind: 'tokenOnly' } }]);
    });

    it('surfaces a recoverable status error without disabling daemon repair', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const startMock = vi.fn(async () => {
            throw new Error('daemon status request failed');
        });

        const runner = createSystemTaskRunner({
            bridge: {
                start: startMock,
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));

        await renderer.act(async () => {});

        expect(startMock).toHaveBeenCalledTimes(1);
        expect(findTestInstanceByTypeWithProps(screen, Item, { testID: 'settings.localDaemonControl.status' })?.props.subtitle).toBe('machine.daemonStatus.unknown');
        expect(screen.findByProps({ subtitle: 'daemon status request failed' })).toBeTruthy();
        expect(findTestInstanceByTypeWithProps(screen, RoundButton, { testID: 'settings.localDaemonControl.repair' })?.props.disabled).toBe(false);
    });

    it('summarizes a service whose status cannot be read as needing repair, for compact surfaces (owner 11-11)', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const runner = createSystemTaskRunner({
            bridge: {
                start: vi.fn(async () => { throw new Error("Cannot find module 'proper-lockfile'"); }),
                async subscribe() { return () => {}; },
                async cancel() {},
                async respond() {},
            },
        });
        const { useThisComputerServiceSummary } = await import('./useThisComputerServiceSummary');
        const { resolveThisComputerRepairTitle } = await import('./thisComputerConnectionPresentation');
        let summary: ReturnType<typeof useThisComputerServiceSummary> | undefined;
        function Probe() { summary = useThisComputerServiceSummary({ runner }); return null; }
        await renderScreen(React.createElement(Probe));
        await renderer.act(async () => {});
        expect(summary).toMatchObject({ needsYou: true,
            error: "Cannot find module 'proper-lockfile'", action: { label: resolveThisComputerRepairTitle(null), disabled: false } });
        expect(summary?.title).toBeTruthy();
    });

    it('uses the latest active relay url when starting a repair after a server switch', async () => {
        const manual = createManualSystemTaskRunner();

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner: manual.runner }));
        await renderer.act(async () => manual.emitResult('personal-home-task-1', {
            protocolVersion: 1, taskId: 'personal-home-task-1', ok: true,
            data: { serviceInstalled: false, daemonRunning: false, needsAuth: false, machineId: null },
        }));

        await renderer.act(async () => {
            await selectHome('https://relay-updated.example.test', 'Home B');
        });

        await screen.pressByTestIdAsync('settings.localDaemonControl.repair');

        expect(manual.bridge.start).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'setup.repairThisComputer.v1',
            params: expect.objectContaining({
                activeRelayUrl: 'https://relay-updated.example.test',
            }),
        }));
    });
    // R15 d / R13C-F4: the section lists every Home this computer serves from the status it already
    // read (the executor's rows), with no second read of this computer's services.
    it('lists every Home this computer serves with its state from the one status read', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema} = await import('@happier-dev/protocol/system/tasks/spec');
        let nextTaskId = 1;
        const listeners = new Map<string, { onEvent: (payload: unknown) => void; onResult: (payload: unknown) => void }>();
        const starts: Array<{ kind: string; params: Record<string, unknown> }> = [];
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push(parsed as { kind: string; params: Record<string, unknown> });
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

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));
        const row = (relayUrl: string, state: string) => ({ relayUrl, state, appManaged: true, serviceTargetMode: 'pinned', actions: [] });

        await renderer.act(async () => {
            listeners.get('task_1:daemon.service.status.v1')?.onResult({
                protocolVersion: 1,
                taskId: 'task_1:daemon.service.status.v1',
                ok: true,
                data: {
                    serviceInstalled: true,
                    daemonRunning: true,
                    needsAuth: false,
                    machineId: 'machine-local-1',
                    daemonAccountId: 'acct_company',
                    daemonServerUrl: 'https://relay.example.test',
                    serviceRowsComplete: true,
                    serviceRows: [
                        row('https://company.example.test', 'connected'),
                        row('https://personal.example.test', 'offline'),
                        row('https://broken.example.test', 'needs_attention'),
                    ],
                },
            });
        });

        expect(starts.map((start) => start.kind)).toEqual(['daemon.service.status.v1']);
        expect([0, 1, 2].map((index) => findTestInstanceByTypeWithProps(screen, Item, { testID: `settings.localDaemonControl.servers.${index}` })?.props.subtitle)).toEqual([
            localizedText('machine.thisComputer.servers.connected'),
            localizedText('machine.thisComputer.servers.offline'),
            localizedText('machine.thisComputer.servers.attention'),
        ]);
    });
});

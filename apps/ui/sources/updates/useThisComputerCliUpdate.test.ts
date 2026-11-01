import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { SYSTEM_TASK_PROTOCOL_VERSION } from '@happier-dev/protocol';

import { renderHook } from '@/dev/testkit';
import { createSystemTaskRunner } from '@/components/systemTasks/createSystemTaskRunner';
import type { SystemTaskBridgeListenerSet, SystemTaskRunner } from '@/components/systemTasks/types';
import { desktopSetupCoordinator } from '@/setup/desktopSetupCoordinator';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import * as tauri from '@/utils/platform/tauri';

import { readUnseenUpdateCompletions } from './updateCompletions';
import { readUpdateBatch, runUpdateBatch, useUpdateBatch } from './machineUpdateRuns';
import { useThisComputerCliUpdate } from './useThisComputerCliUpdate';

// The app-wide system-task runner is the process boundary; a case that needs a specific answer
// from this computer points it at its own bridge, every other case keeps the real one.
const runnerRef = vi.hoisted(() => ({ current: null as SystemTaskRunner | null }));
vi.mock('@/components/systemTasks/systemTasksRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/systemTasks/systemTasksRuntime')>();
    return { ...actual, getSystemTasksRunner: () => runnerRef.current ?? actual.getSystemTasksRunner() };
});

afterEach(() => {
    runnerRef.current = null;
    storage.setState({ profileScope: null });
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

it('retains Update-all until the local CLI settles after its view closes and another account opens Updates', async () => {
    // The existing deterministic desktop bridge is the process boundary; task lifecycle,
    // inspection, storage and update observers remain real.
    vi.spyOn(tauri, 'isTauriDesktop').mockReturnValue(true);
    const { serverId, serverUrl } = getActiveServerSnapshot();
    const accountA = { serverId, accountId: 'local-update-a' };
    const accountB = { serverId, accountId: 'local-update-b' };
    storage.setState({ profileScope: accountA });
    let updateListener: SystemTaskBridgeListenerSet | undefined;
    let updateStarts = 0;
    let statusListener: SystemTaskBridgeListenerSet | undefined;
    let statusTaskId = '';
    let delayStatus = false;
    const statusData = {
        acquisition: { command: '/managed/happier', provenance: 'managed', version: '0.2.12' },
        server: { serverUrl, publicServerUrl: serverUrl, localServerUrl: null, comparableKey: null },
        auth: { credentialState: 'valid', validatedAccountId: accountA.accountId, accountId: accountA.accountId, machineId: 'machine-local-1' },
        service: { installed: true, running: true, autostart: 'at-login', targetMode: 'default-following' },
        runtimeConvergence: { controlReachable: true, serviceOwnsRunningDaemon: true, machineIdMatches: true, cliVersionMatches: true },
        cli: { update: { currentVersion: '0.2.12', latestVersion: '0.2.14', updateAvailable: true, managed: true }, choice: null },
    };
    runnerRef.current = createSystemTaskRunner({ bridge: {
        async start(spec) {
            if (spec.kind === 'cli.update.v1') { updateStarts++; return 'batch-local-update'; }
            return 'batch-local-status';
        },
        async subscribe(taskId, listeners) {
            if (taskId === 'batch-local-update') updateListener = listeners;
            else if (delayStatus) { statusListener = listeners; statusTaskId = taskId; }
            else queueMicrotask(() => listeners.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId, ok: true,
                data: statusData,
            }));
            return () => {};
        },
        async cancel() {},
        async respond() {},
    } });
    await desktopSetupCoordinator.inspect({ fresh: true });

    const firstObserver = await renderHook(() => useThisComputerCliUpdate());
    const queuedRun = firstObserver.getCurrent().run;
    const item = firstObserver.getCurrent().item;
    if (!item) throw new Error('The inspected local CLI must be available for this batch');
    expect(item.state).toBe('available');
    await firstObserver.unmount();
    await act(async () => { storage.setState({ profileScope: accountB }); });
    const laterObserver = await renderHook(() => ({
        cli: useThisComputerCliUpdate(),
        originalBatch: useUpdateBatch(accountA, [item], () => queuedRun()),
    }));
    let batchRun = Promise.resolve();
    await act(async () => { batchRun = runUpdateBatch(accountA, [item], () => queuedRun()); });
    expect(laterObserver.getCurrent().cli.item?.state).toBe('running');
    expect(laterObserver.getCurrent().originalBatch.batch).toEqual({ done: 0, total: 1, stopping: false });
    await laterObserver.unmount();
    const reopened = await renderHook(() => ({ ...useUpdateBatch(accountA, [item], () => queuedRun()), cli: useThisComputerCliUpdate() }));
    expect(reopened.getCurrent().batch).toEqual({ done: 0, total: 1, stopping: false });
    let duplicateExecutions = 0;
    await act(async () => {
        await runUpdateBatch(accountA, [item], async () => { duplicateExecutions++; await queuedRun(); });
    });
    expect(duplicateExecutions).toBe(0);
    delayStatus = true;
    await act(async () => {
        updateListener?.onResult({ protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: 'batch-local-update', ok: true, data: {} });
    });
    const duringRefresh = reopened.getCurrent().cli.item?.state;
    const batchDuringRefresh = readUpdateBatch(accountA);
    await act(async () => {
        statusListener?.onResult({ protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: statusTaskId, ok: true,
            data: { ...statusData, acquisition: { ...statusData.acquisition, version: '0.2.14' },
                cli: { ...statusData.cli, update: { ...statusData.cli.update, currentVersion: '0.2.14', updateAvailable: false } } } });
        await batchRun;
    });
    expect(duringRefresh).toBe('running');
    expect(batchDuringRefresh).toEqual({ done: 0, total: 1, stopping: false });

    expect(readUpdateBatch(accountA)).toBeNull();
    expect(reopened.getCurrent().cli.item).toMatchObject({ currentVersion: '0.2.14', action: { kind: 'none' } });
    expect(updateStarts).toBe(1);
    expect(readUnseenUpdateCompletions(accountB).size).toBe(0);
    expect(readUnseenUpdateCompletions(accountA).get('machine-local-1:happier-cli')).toBe('done');
    await reopened.unmount();
});

it('names the exact command that updates the command line the person kept (R12)', async () => {
    vi.spyOn(tauri, 'isTauriDesktop').mockReturnValue(true);
    const relayUrl = getActiveServerSnapshot().serverUrl;
    // "Keep my own": this computer runs the person's npm install, which the app never replaces.
    const statusData = {
        acquisition: { command: '/usr/local/bin/happier', provenance: 'override', version: '0.2.10' },
        server: { serverUrl: relayUrl, publicServerUrl: relayUrl, localServerUrl: null, comparableKey: null },
        auth: { credentialState: 'valid', validatedAccountId: 'acct_app', accountId: 'acct_app', machineId: 'machine-own' },
        service: { installed: true, running: true, autostart: 'at-login', targetMode: 'default-following' },
        runtimeConvergence: { controlReachable: true, serviceOwnsRunningDaemon: true, machineIdMatches: true, cliVersionMatches: true },
        cli: {
            update: { currentVersion: '0.2.10', latestVersion: '0.2.13', updateAvailable: true, managed: false },
            choice: {
                mode: 'own',
                otherCli: { command: '/usr/local/bin/happier', origin: 'npm', removalCommand: null, updateCommand: 'npm install -g @happier-dev/cli@latest' },
            },
        },
    };
    runnerRef.current = createSystemTaskRunner({
        bridge: {
            async start() { return 'task_status_own'; },
            async subscribe(taskId, listeners) {
                queueMicrotask(() => listeners.onResult({ protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId, ok: true, data: statusData as never }));
                return () => {};
            },
            async cancel() {},
            async respond() {},
        },
    });
    await desktopSetupCoordinator.inspect({ fresh: true });

    const hook = await renderHook(() => useThisComputerCliUpdate());

    expect(hook.getCurrent().item).toMatchObject({
        state: 'available',
        managedBy: 'user',
        action: { kind: 'manual', command: 'npm install -g @happier-dev/cli@latest' },
    });
    await hook.unmount();
});

it('still offers this computer\'s one command line when the app relay\'s own service could not be read', async () => {
    vi.spyOn(tauri, 'isTauriDesktop').mockReturnValue(true);
    const appRelay = getActiveServerSnapshot().serverUrl;
    // The default-following daemon serves another relay; the app relay's pin is listed but unreadable.
    const statusData = {
        acquisition: { command: '/managed/happier', provenance: 'managed', version: '0.2.12' },
        server: { serverUrl: 'https://other.example.test', publicServerUrl: 'https://other.example.test', localServerUrl: null, comparableKey: null },
        auth: { credentialState: 'valid', validatedAccountId: 'acct_app', accountId: 'acct_app', machineId: 'machine-default' },
        service: { installed: true, running: true, autostart: 'at-login', targetMode: 'default-following' },
        runtimeConvergence: { controlReachable: true, serviceOwnsRunningDaemon: true, machineIdMatches: true, cliVersionMatches: true },
        cli: { update: { currentVersion: '0.2.12', latestVersion: '0.2.13', updateAvailable: true, managed: true }, choice: null },
        pinnedServices: { complete: false, coexistence: true, services: [], unreadable: [{ relayUrl: appRelay, code: 'invalid_cli_response', message: 'x' }] },
        serviceRows: [{ relayUrl: 'https://other.example.test', state: 'connected', appManaged: true, serving: 'default-following', actions: ['restart', 'stop'] }],
    };
    runnerRef.current = createSystemTaskRunner({
        bridge: {
            async start() { return 'task_status_unreadable'; },
            async subscribe(taskId, listeners) {
                queueMicrotask(() => listeners.onResult({ protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId, ok: true, data: statusData as never }));
                return () => {};
            },
            async cancel() {},
            async respond() {},
        },
    });
    await desktopSetupCoordinator.inspect({ fresh: true });

    const hook = await renderHook(() => useThisComputerCliUpdate());

    // The CLI is this computer's, whichever service reports it; only the machine stays unknown.
    expect(hook.getCurrent().item).toMatchObject({ state: 'available', action: { kind: 'run', verb: 'update' } });
    expect(hook.getCurrent().machineId).toBeNull();
    await hook.unmount();
});

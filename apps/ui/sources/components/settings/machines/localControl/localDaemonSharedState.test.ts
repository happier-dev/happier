import { afterEach, expect, it, vi } from 'vitest';
import type { SystemTaskSpec } from '@happier-dev/protocol';
import { useThisComputerCliUpdate } from '@/updates/useThisComputerCliUpdate';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import { createSystemTaskRunner } from '@/components/systemTasks/createSystemTaskRunner';
import { createDeterministicSystemTaskBridge } from '@/components/systemTasks/createDeterministicSystemTaskBridge';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { restoreConnectionToActiveServer, disconnectActiveServerConnection } from '@/sync/runtime/orchestration/connectionManager';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { storage } from '@/sync/domains/state/storageStore';
import { readUnseenUpdateCompletions } from '@/updates/updateCompletions';
import { publishLocalDaemonStatus, startLocalCliUpdate, startLocalComputerSetup } from './localDaemonSharedState';
import { readLocalDaemonStatusData } from './useLocalDaemonControl';
import { useLocalDaemonControl } from './useLocalDaemonControl';
import { readLocalDaemonSharedState } from './localDaemonSharedState';
import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { act } from 'react-test-renderer';
import type { IModal } from '@/modal';
import { useThisComputerSetupTask } from '@/components/systemTasks/useThisComputerSetupTask';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import * as React from 'react';
import { renderScreen } from '@/dev/testkit';
import type { SetupThisComputerWizardPrimaryState } from '@/components/onboarding/checklists/setupThisComputer/SetupThisComputerChecklistStep';

// Only the canonical JS → native event transport is substituted; host selection, native bridge and runner stay real.
const nativeEvents = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock('@/utils/platform/desktopHost', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/platform/desktopHost')>();
    return { ...actual, listenDesktopHostEvent: async (event: string, handler: (payload: unknown) => void) => {
        nativeEvents.set(event, (hostEvent) => handler(hostEvent.payload));
        return () => { nativeEvents.delete(event); };
    } };
});

const modalSpies = vi.hoisted(() => ({ confirm: vi.fn(async () => true), alertAsync: vi.fn(async (
    ...args: Parameters<IModal['alertAsync']>
) => { args[2]?.at(-1)?.onPress?.(); }) }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: modalSpies }).module;
});

vi.mock('socket.io-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('socket.io-client')>();
    return { ...actual, io: (...args: Parameters<typeof actual.io>) => {
        const socket = actual.io(...args);
        // Only prevent the external connection; keep Socket and Sync lifecycle real.
        vi.spyOn(socket, 'connect').mockReturnValue(socket);
        return socket;
    } };
});
afterEach(async () => {
    // Even a failed assertion must settle the shell task before clearing its SDK listeners.
    await act(async () => {
        for (const [event, emit] of [...nativeEvents]) {
            if (!event.endsWith('/result')) continue;
            const taskId = event.slice('systemTasks://task/'.length, -'/result'.length);
            emit({ payload: { protocolVersion: 1, taskId, ok: false,
                error: { code: 'test_cancelled', message: 'Native fixture teardown' } } });
        }
        await flushHookEffects();
    });
    standardCleanup();
    vi.useRealTimers();
    await disconnectActiveServerConnection();
    storage.setState({ profileScope: null });
    resetRuntimeFetch();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    nativeEvents.clear();
});

it('retains checklist failure when Home and account change during admission and the task settles before returning', async () => {
    const { SetupThisComputerChecklistStep } = await import('@/components/onboarding/checklists/setupThisComputer/SetupThisComputerChecklistStep');
    const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
    const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');
    const home = await upsertAndActivateServer({ serverUrl: 'https://checklist-retained-origin.example', name: 'Origin' });
    const previousProfile = storage.getState().profile;
    storage.setState({ profile: { ...profileDefaults, id: 'checklist-owner-a' } });
    const starts: SystemTaskSpec[] = [];
    const taskId = 'checklist-pending-admission';
    const responses: unknown[] = [];
    let finishStart!: (value: { taskId: string }) => void;
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
        if (command === 'start_system_task') {
            const spec = SystemTaskSpecSchema.parse(JSON.parse(String(args?.specJson)));
            starts.push(spec);
            return spec.kind === 'setup.thisComputer.v1'
                ? new Promise<{ taskId: string }>((resolve) => { finishStart = resolve; })
                : { taskId: `checklist-status-${starts.length}` };
        }
        if (command === 'get_system_task_snapshot') return { events: [], result: args?.taskId === taskId ? null : {
            protocolVersion: 1, taskId: args?.taskId, ok: true,
            data: { serviceInstalled: false, daemonRunning: false, needsAuth: true, machineId: null },
        } };
        if (command === 'respond_system_task_prompt') {
            responses.push(JSON.parse(String(args?.answerJson)));
            return;
        }
        throw new Error(`Unexpected desktop command: ${command}`);
    } });
    const runner = getSystemTasksRunner();
    const primary: { current: SetupThisComputerWizardPrimaryState | null } = { current: null };
    const onPrimaryChange = (state: SetupThisComputerWizardPrimaryState | null) => { primary.current = state; };
    const screen = await renderScreen(React.createElement(SetupThisComputerChecklistStep, {
        testID: 'retained-checklist', onWizardPrimaryChange: onPrimaryChange,
    }));
    let admission!: Promise<void>;
    try {
        await act(async () => {
            admission = Promise.resolve(primary.current?.onPress());
            await flushHookEffects();
        });
        expect(runner.getActiveSetupTask()).toMatchObject({ taskId: null });
        expect(starts.find((spec) => spec.kind === 'setup.thisComputer.v1')?.params).toMatchObject({
            activeRelayUrl: home.serverUrl, activeAccountId: 'checklist-owner-a',
        });
        await screen.unmount();
        await act(async () => {
            await upsertAndActivateServer({ serverUrl: 'https://checklist-retained-other.example', name: 'Other' });
            storage.setState({ profile: { ...profileDefaults, id: 'checklist-owner-b' } });
        });
        const other = await renderHook(() => useLocalDaemonControl({ runner }));
        await act(async () => { finishStart({ taskId }); await admission; });
        expect(other.getCurrent().activeTaskSnapshot).toBeNull();
        const readCredentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: 'e30.' + Buffer.from(JSON.stringify({ sub: 'checklist-owner-b' })).toString('base64url') + '.signature',
        });
        await act(async () => {
            nativeEvents.get(`systemTasks://task/${taskId}/event`)?.({ payload: {
                protocolVersion: 1, taskId, tsMs: 1, type: 'prompt', message: 'Pair original Home', data: {
                    kind: 'authRequest', responseKind: 'tokenOnly', publicKey: 'request-key', response: 'opaque-response',
                    relayUrl: home.serverUrl, cliProvenance: 'managed',
                },
            } });
            await vi.waitFor(() => expect(responses).toContainEqual({ approved: false, reason: 'credentials_unavailable' }));
        });
        expect(readCredentials).toHaveBeenCalledWith(home.serverUrl, { serverId: home.id });
        await act(async () => {
            nativeEvents.get(`systemTasks://task/${taskId}/event`)?.({ payload: {
                protocolVersion: 1, taskId, tsMs: 2, type: 'progress',
                stepId: 'setup.thisComputer.ensureCli', message: 'Installing command line',
            } });
            nativeEvents.get(`systemTasks://task/${taskId}/result`)?.({ payload: {
                protocolVersion: 1, taskId, ok: false,
                error: { code: 'checklist_install_failed', message: 'Original Home command line failed' },
            } });
            await flushHookEffects();
        });
        expect(runner.getSnapshot(taskId)?.status).toBe('failed');
        expect(other.getCurrent().lastErrorMessage).toBeNull();
        await other.unmount();
        await act(async () => {
            await setActiveServer({ serverId: home.id });
            storage.setState({ profile: { ...profileDefaults, id: 'checklist-owner-a' } });
        });
        const returned = await renderScreen(React.createElement(SetupThisComputerChecklistStep, {
            testID: 'retained-checklist', onWizardPrimaryChange: onPrimaryChange,
        }));
        expect(primary.current).toMatchObject({ label: 'Retry', disabled: false });
        await returned.pressByTestIdAsync('retained-checklist-checklist-row-setup.thisComputer.stage.installTools-details-toggle');
        expect(returned.getTextContent()).toContain('Original Home command line failed');
        const settings = await renderHook(() => useLocalDaemonControl({ runner }));
        expect(settings.getCurrent().lastErrorMessage).toBe('Original Home command line failed');
        expect(settings.getCurrent().canRepair).toBe(true);
        expect(starts.filter((spec) => spec.kind === 'setup.thisComputer.v1')).toHaveLength(1);
    } finally {
        await act(async () => { storage.setState({ profile: previousProfile }); });
    }
});

it.each(['repair', 'command-line'] as const)('retains Settings %s prompts and progress after navigation and surfaces terminal failure on return', async (intent) => {
    const home = await upsertAndActivateServer({ serverUrl: `https://retained-${intent}.example`, name: 'Home' });
    const manual = createManualSystemTaskRunner();
    const mounted = await renderHook(() => useLocalDaemonControl({ runner: manual.runner }));
    let finishStart!: (taskId: string) => void;
    manual.bridge.start.mockImplementationOnce(() => new Promise<string>((resolve) => { finishStart = resolve; }));
    let starting!: Promise<string | null>;
    await act(async () => {
        starting = intent === 'repair' ? mounted.getCurrent().repairBackgroundService() : mounted.getCurrent().changeCommandLine();
    });
    await mounted.unmount();
    const waiting = await renderHook(() => useLocalDaemonControl({ runner: manual.runner }));
    expect(waiting.getCurrent().isBusy).toBe(true);
    let taskId: string | null = null;
    await act(async () => { finishStart('delayed-setup'); taskId = await starting; });
    expect(waiting.getCurrent().activeTaskSnapshot?.taskId).toBe(taskId);
    await waiting.unmount();
    manual.emitEvent(taskId!, { type: 'progress', message: 'Preparing computer' });
    manual.emitEvent(taskId!, { type: 'prompt', message: 'Choose command line', data: {
        kind: 'setup.cliChoice', command: '/usr/local/bin/happier', version: '0.3.1', origin: 'npm',
        removalCommand: null, updateCommand: null, belowSetupFloor: false, missing: false, keepBlockedBy: null,
    } });
    await flushHookEffects();
    expect(manual.bridge.respond).toHaveBeenCalledWith(taskId, { choice: 'managed' });
    // A request for another Home fails closed using the initiating Home even with no Settings mounted.
    manual.emitEvent(taskId!, { type: 'prompt', message: 'Pair computer', data: {
        kind: 'authRequest', responseKind: 'tokenOnly', publicKey: 'request-key', response: 'opaque-response',
        relayUrl: 'https://different-home.example', cliProvenance: 'managed',
    } });
    await flushHookEffects();
    expect(manual.bridge.respond).toHaveBeenCalledWith(taskId, { approved: false, reason: 'relay_mismatch' });
    const returned = await renderHook(() => useLocalDaemonControl({ runner: manual.runner }));
    expect(returned.getCurrent().activeTaskSnapshot?.taskId).toBe(taskId);
    expect(returned.getCurrent().isBusy).toBe(true);
    await act(async () => { await returned.getCurrent().repairBackgroundService(); });
    expect(readLocalDaemonSharedState(manual.runner).setup.taskId).toBe(taskId);
    expect(manual.bridge.start.mock.calls.filter(([spec]) => spec.kind.startsWith('setup.'))).toHaveLength(1);
    await act(async () => {
        await upsertAndActivateServer({ serverUrl: 'https://other-settings-home.example', name: 'Other' });
    });
    expect(returned.getCurrent().activeTaskSnapshot).toBeNull();
    expect(returned.getCurrent().isBusy).toBe(true);
    let otherRun: string | null = null;
    await act(async () => { otherRun = await returned.getCurrent().repairBackgroundService(); });
    expect(otherRun).toBeNull();
    await act(async () => {
        await upsertAndActivateServer({ serverUrl: `https://retained-${intent}.example`, name: 'Home' });
    });
    expect(returned.getCurrent().activeTaskSnapshot?.taskId).toBe(taskId);
    await returned.unmount();
    manual.emitResult(taskId!, { protocolVersion: 1, taskId: taskId!, ok: false,
        error: { code: 'test_setup_failure', message: 'Named setup failure' } });
    await flushHookEffects();
    const failed = await renderHook(() => useLocalDaemonControl({ runner: manual.runner }));
    expect(failed.getCurrent().lastErrorMessage).toBe('Named setup failure');
    expect(failed.getCurrent().isBusy).toBe(false);
    expect(readLocalDaemonSharedState(manual.runner).setup.scope?.serverId).toBe(home.id);
});

it.each(['known-identity', 'url-only'] as const)('rereads a successful setup at its initiating Home (%s) while preventing its result from replacing another account scope', async (identityKind) => {
    const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
    const home = await upsertAndActivateServer({ serverUrl: 'https://setup-origin.example', name: 'Origin' });
    const serverIdentityId = identityKind === 'known-identity' ? 'srv_setup_origin_backend_identity' : null;
    if (serverIdentityId) await adoptHomeProfile({ descriptor: {
        serverUrl: 'https://setup-origin.example', homeServerIdentityId: serverIdentityId,
    }, source: 'manual' });
    const manual = createManualSystemTaskRunner();
    const taskId = await startLocalComputerSetup(manual.runner, { protocolVersion: 1, kind: 'setup.thisComputer.v1', params: {
        activeRelayUrl: 'https://setup-origin.example', activeAccountId: 'owner-a',
        ...(serverIdentityId ? { activeServerIdentityId: serverIdentityId } : {}),
    } }, { expectedRelayUrl: 'https://setup-origin.example', serverId: home.id }, readLocalDaemonStatusData);
    const other = await upsertAndActivateServer({ serverUrl: 'https://setup-other.example', name: 'Other' });
    await adoptHomeProfile({ descriptor: {
        serverUrl: 'https://setup-other.example', homeServerIdentityId: 'srv_setup_other_backend_identity',
    }, source: 'manual' });
    storage.setState({ profileScope: { serverId: other.id, accountId: 'owner-b' } });
    const otherStatus = { serviceInstalled: true, daemonRunning: true, needsAuth: false, machineId: 'other-machine' };
    publishLocalDaemonStatus(manual.runner, otherStatus);
    manual.emitResult(taskId!, { protocolVersion: 1, taskId: taskId!, ok: true, data: { machineId: 'original-machine' } });
    await flushHookEffects();
    expect(readLocalDaemonSharedState(manual.runner).setup.rereading).toBe(true);
    const [statusSpec] = manual.bridge.start.mock.calls.at(-1)!;
    expect(statusSpec.kind).toBe('daemon.service.status.v1');
    expect(statusSpec.params).toMatchObject({ relayUrl: 'https://setup-origin.example' });
    if (serverIdentityId) expect(statusSpec.params).toMatchObject({ serverIdentityId });
    else expect(statusSpec.params).not.toHaveProperty('serverIdentityId');
    manual.emitResult('personal-home-task-2', { protocolVersion: 1, taskId: 'personal-home-task-2', ok: true,
        data: { serviceInstalled: true, daemonRunning: true, needsAuth: false, machineId: 'original-machine' } });
    await flushHookEffects();
    expect(readLocalDaemonSharedState(manual.runner).setup.rereading).toBe(false);
    expect(readLocalDaemonSharedState(manual.runner).status).toBe(otherStatus);
});


it('a generic successful setup publishes scoped readback after its initiating observer leaves, using the backend identity alias', async () => {
    const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
    const home = await upsertAndActivateServer({ serverUrl: 'https://setup-alias.example', name: 'Alias Home' });
    const serverIdentityId = 'srv_setup_alias_backend_identity';
    await adoptHomeProfile({ descriptor: { serverUrl: home.serverUrl, homeServerIdentityId: serverIdentityId }, source: 'manual' });
    const credentials = { token: 'e30.' + Buffer.from(JSON.stringify({ sub: 'owner-a' })).toString('base64url') + '.signature' };
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
    setRuntimeFetch(async (url) => new Response('{}', { status: new URL(String(url)).pathname === '/v1/auth/ping' ? 200 : 404 }));
    await restoreConnectionToActiveServer(credentials);
    storage.setState({ profileScope: { serverId: serverIdentityId, accountId: 'owner-a' } });
    expect(getActiveServerAccountScope()).toEqual({ serverId: serverIdentityId, accountId: 'owner-a' });
    const manual = createManualSystemTaskRunner();
    const previousProfile = storage.getState().profile;
    storage.setState({ profile: { ...profileDefaults, id: 'owner-a' } });
    const generic = await renderHook(() => useThisComputerSetupTask({ runner: manual.runner, authRequestApproval: {
        expectedRelayUrl: home.serverUrl, serverId: home.id, expectedAccountId: 'owner-a',
    } }));
    let taskId = '';
    await act(async () => { taskId = await generic.getCurrent().start({ protocolVersion: 1, kind: 'setup.thisComputer.v1', params: {
        activeRelayUrl: home.serverUrl, activeServerIdentityId: serverIdentityId, activeAccountId: 'owner-a',
    } }); });
    try {
        await generic.unmount();
        expect(readLocalDaemonSharedState(manual.runner).setup.taskId).toBe(taskId);
        manual.emitResult(taskId, { protocolVersion: 1, taskId, ok: true, data: {} });
        await flushHookEffects();
        expect(readLocalDaemonSharedState(manual.runner).setup.rereading).toBe(true);
        expect(manual.bridge.start.mock.calls.at(-1)?.[0].params).toMatchObject({ relayUrl: home.serverUrl, serverIdentityId });
        const statusTaskId = manual.runner.listActiveTasks?.().at(-1)?.taskId;
        expect(statusTaskId).toBeDefined();
        manual.emitResult(statusTaskId!, { protocolVersion: 1, taskId: statusTaskId!, ok: true, data: {
            serviceInstalled: true, daemonRunning: true, needsAuth: false, machineId: 'same-account-machine',
        } });
        await flushHookEffects();
        const reopened = await renderHook(() => useLocalDaemonControl({ runner: manual.runner }));
        expect(reopened.getCurrent().status?.machineId).toBe('same-account-machine');
        expect(reopened.getCurrent().isBusy).toBe(false);
    } finally {
        await act(async () => { storage.setState({ profile: previousProfile }); });
    }
});

it.each(['Home', 'account'] as const)('retains a queued Updates CLI target and account after navigation and a %s switch, rereading the original scope without replacing current status', async (switchKind) => {
    const original = await upsertAndActivateServer({ serverUrl: `https://queued-cli-${switchKind.toLowerCase()}-original.example`, name: 'Original Home' });
    const originalScope = { serverId: original.id, accountId: 'queued-original-account' };
    storage.setState({ profileScope: originalScope });
    const starts: SystemTaskSpec[] = [];
    const cliTaskId = `queued-cli-${switchKind}`;
    const statusTaskId = `queued-status-${switchKind}`;
    const originalStatus = readLocalDaemonStatusData({ protocolVersion: 1, taskId: 'original-status', ok: true, data: {
        serviceInstalled: true, daemonRunning: true, needsAuth: false, machineId: 'queued-original-machine',
        daemonServerUrl: original.serverUrl, cliUpdate: { currentVersion: '0.3.0', latestVersion: '0.3.1', managed: true, updateAvailable: true },
    } })!;
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
        if (command === 'start_system_task') {
            const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');
            const spec = SystemTaskSpecSchema.parse(JSON.parse(String(args?.specJson)));
            starts.push(spec);
            return { taskId: spec.kind === 'cli.update.v1' ? cliTaskId : statusTaskId };
        }
        if (command === 'get_system_task_snapshot') return {
            events: [], result: args?.taskId === statusTaskId
                ? { protocolVersion: 1, taskId: statusTaskId, ok: true, data: originalStatus }
                : null,
        };
        throw new Error(`Unexpected desktop command: ${command}`);
    } });
    const runner = getSystemTasksRunner();
    publishLocalDaemonStatus(runner, originalStatus);
    const initial = await renderHook(() => useThisComputerCliUpdate());
    const queuedRun = initial.getCurrent().run;
    await initial.unmount();
    const current = switchKind === 'Home'
        ? await upsertAndActivateServer({ serverUrl: 'https://queued-cli-current.example', name: 'Current Home' })
        : original;
    const currentScope = { serverId: current.id, accountId: 'queued-current-account' };
    storage.setState({ profileScope: currentScope });
    const currentStatus = { ...originalStatus, machineId: 'queued-current-machine', daemonServerUrl: current.serverUrl };
    publishLocalDaemonStatus(runner, currentStatus);
    const reopened = await renderHook(() => useThisComputerCliUpdate());
    let completion!: Promise<void>;
    await act(async () => { completion = queuedRun(); });
    expect(reopened.getCurrent().item?.state).toBe('running');
    await act(async () => {
        await vi.waitFor(() => expect(nativeEvents.has(`systemTasks://task/${cliTaskId}/result`), JSON.stringify({
            mode: runner.mode, snapshot: runner.getSnapshot(cliTaskId), starts: starts.length,
            cliUpdate: readLocalDaemonSharedState(runner).cliUpdate, events: [...nativeEvents.keys()],
        })).toBe(true));
    });
    await act(async () => {
        nativeEvents.get(`systemTasks://task/${cliTaskId}/result`)?.({ payload: { protocolVersion: 1, taskId: cliTaskId, ok: true, data: {} } });
        await vi.waitFor(() => expect(runner.getSnapshot(cliTaskId)?.result).toMatchObject({ ok: true }));
        await completion;
    });
    expect(starts[0]?.params).toMatchObject({ relayUrl: original.serverUrl });
    expect(starts[1]?.params).toEqual(starts[0]?.params);
    expect(runner.getSnapshot(statusTaskId)?.result).toMatchObject({ ok: true });
    expect(readUnseenUpdateCompletions(originalScope).get('queued-original-machine:happier-cli')).toBe('done');
    expect(readUnseenUpdateCompletions(currentScope).size).toBe(0);
    expect(readLocalDaemonSharedState(runner).status).toBe(currentStatus);
    expect(reopened.getCurrent().machineId).toBe('queued-current-machine');
    await reopened.unmount();
});

it('uses a refreshed Home endpoint for the next mounted CLI action without changing its account, server identity or machine', async () => {
    const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const originalUrl = 'https://cli-context-before.example';
    const refreshedUrl = 'https://cli-context-after.example';
    const backendIdentity = 'srv_cli_context_refresh';
    await upsertAndActivateServer({ serverUrl: originalUrl, name: 'CLI Home' });
    await adoptHomeProfile({ descriptor: { serverUrl: originalUrl, homeServerIdentityId: backendIdentity }, source: 'manual' });
    expect(getActiveServerAccountScope()).toBeNull();
    const credentials = { token: 'e30.' + Buffer.from(JSON.stringify({ sub: 'endpoint-refresh-account' })).toString('base64url') + '.signature' };
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
    setRuntimeFetch(async (url) => new Response('{}', { status: new URL(String(url)).pathname === '/v1/auth/ping' ? 200 : 404 }));
    await restoreConnectionToActiveServer(credentials);
    const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'endpoint-refresh-account' };
    storage.setState({ profileScope: scope });
    expect(getActiveServerAccountScope()).toEqual(scope);
    const status = readLocalDaemonStatusData({ protocolVersion: 1, taskId: 'endpoint-before', ok: true, data: {
        serviceInstalled: true, daemonRunning: true, needsAuth: false, machineId: 'endpoint-machine', daemonServerUrl: originalUrl,
        cliUpdate: { currentVersion: '0.3.0', latestVersion: '0.3.1', managed: true, updateAvailable: true },
    } })!;
    const starts: SystemTaskSpec[] = [];
    const cliTaskId = 'endpoint-cli';
    const statusTaskId = 'endpoint-status';
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
        if (command === 'start_system_task') {
            const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');
            const spec = SystemTaskSpecSchema.parse(JSON.parse(String(args?.specJson)));
            starts.push(spec);
            return { taskId: spec.kind === 'cli.update.v1' ? cliTaskId : statusTaskId };
        }
        if (command === 'get_system_task_snapshot') return {
            events: [], result: args?.taskId === statusTaskId
                ? { protocolVersion: 1, taskId: statusTaskId, ok: true, data: { ...status, daemonServerUrl: refreshedUrl } }
                : null,
        };
        throw new Error(`Unexpected desktop command: ${command}`);
    } });
    const runner = getSystemTasksRunner();
    publishLocalDaemonStatus(runner, status);
    const mounted = await renderHook(() => useThisComputerCliUpdate());
    await act(async () => {
        await adoptHomeProfile({ descriptor: { serverUrl: refreshedUrl, homeServerIdentityId: backendIdentity }, source: 'manual' });
    });
    expect(getActiveServerSnapshot()).toMatchObject({ serverId: scope.serverId, serverUrl: refreshedUrl });
    let completion!: Promise<void>;
    await act(async () => {
        completion = mounted.getCurrent().run();
        await vi.waitFor(() => expect(nativeEvents.has(`systemTasks://task/${cliTaskId}/result`)).toBe(true));
    });
    expect(starts[0]?.params).toMatchObject({ relayUrl: refreshedUrl, serverIdentityId: backendIdentity });
    await act(async () => {
        nativeEvents.get(`systemTasks://task/${cliTaskId}/result`)?.({ payload: { protocolVersion: 1, taskId: cliTaskId, ok: true, data: {} } });
        await completion;
    });
    expect(starts[1]?.params).toEqual(starts[0]?.params);
    expect(runner.getSnapshot(statusTaskId)?.result).toMatchObject({ ok: true });
    expect(readUnseenUpdateCompletions(scope).get('endpoint-machine:happier-cli')).toBe('done');
    expect(readLocalDaemonSharedState(runner).status).toMatchObject({ machineId: 'endpoint-machine', daemonServerUrl: refreshedUrl });
    await mounted.unmount();
});

it('records a shared update only at successful settlement for its initiating account, without an Updates observer', async () => {
    // The existing deterministic bridge substitutes the desktop process only.
    const home = await upsertAndActivateServer({ serverUrl: 'https://local-update-owner.example', name: 'Home' });
    const credentials = { token: 'e30.' + Buffer.from(JSON.stringify({ sub: 'owner-a' })).toString('base64url') + '.signature' };
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
    setRuntimeFetch(async (url) => new Response('{}', { status: new URL(String(url)).pathname === '/v1/auth/ping' ? 200 : 404 }));
    await restoreConnectionToActiveServer(credentials);
    vi.useFakeTimers();
    const runner = createSystemTaskRunner({ bridge: createDeterministicSystemTaskBridge(), mode: 'dev' });
    const serverId = home.id;
    const accountA = { serverId, accountId: 'owner-a' };
    const accountB = { serverId, accountId: 'owner-b' };
    expect(getActiveServerAccountScope()).toEqual(accountA);
    publishLocalDaemonStatus(runner, { machineId: 'machine-local-1' });
    const started = startLocalCliUpdate(runner, readLocalDaemonStatusData);
    await vi.advanceTimersByTimeAsync(0);
    storage.setState({ profileScope: accountB });
    await startLocalCliUpdate(runner, readLocalDaemonStatusData);
    expect(readUnseenUpdateCompletions(accountA).size).toBe(0);
    expect(readUnseenUpdateCompletions(accountB).size).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    await started;
    expect(readUnseenUpdateCompletions(accountA).get('machine-local-1:happier-cli')).toBe('done');
    expect(readUnseenUpdateCompletions(accountB).size).toBe(0);
});

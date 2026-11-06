import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createDeferred } from '@/dev/testkit';
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { withHomeMutationAuthority } from '@/sync/domains/server/homeMutationLock';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerId, setActiveServerId, upsertServerProfile, removeServerProfile } = await import('@/sync/domains/server/serverProfiles');
const { readMachineAddFlowDraft, updateMachineAddFlowDraft } = await import('./machineAddFlowStore');
const { createManualSystemTaskRunner } = await import('@/dev/testkit/harness/manualSystemTaskRunner');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { createAccountSettingsScope } = await import('@/sync/domains/settings/scope/accountSettingsScope');
const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
// Substitute Metro's loader only; admission and task execution remain real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

// Native navigation is an external boundary; this test never navigates.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
vi.mock('expo-router/build/link/href', () => ({ resolveHref: vi.fn() }));
vi.mock('@/config', () => ({ config: { variant: 'production', identityVariant: 'stable' } }));
// Canonical UI presentation boundaries; internal task/feed/arrival decisions remain real.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
const { useMachineAddFlow, useMachineAddDraftRow, discardMachineAdd } = await import('./useMachineAddFlow');
const sshPolicy = { v: 1 as const, actions: {}, approvalWaivedSurfaces: { 'machines.add.ssh.start': ['ui' as const], 'machines.add.ssh.respond': ['ui' as const], 'machines.add.local.start': ['ui' as const] } };

async function admitSsh(serverId: string, accountId: string) {
    const scope = createAccountSettingsScope(serverId, accountId);
    if (!scope) throw new Error('Invalid SSH fixture Account scope');
    await storage.getState().activateSettingsScope(scope);
    storage.getState().activateProfileScope(scope);
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1: sshPolicy } }, version: 1 } });
    storage.setState({ settingsScope: { serverId, accountId }, profileScope: { serverId, accountId },
        settings: { ...storage.getState().settings, actionsSettingsV1: sshPolicy }, machineListByServerId: { [serverId]: [] } });
}

beforeEach(async () => { await harness.reset(); await selectActiveTestHomeForTests(); });
afterEach(async () => { await act(async () => discardMachineAdd()); publishAppliedActiveServerRuntimeAvailability(false); vi.useRealTimers(); standardCleanup(); });
describe('machine add flow lifetime', () => {
    it.each(['another_account', 'read_failed'] as const)('reads cold local daemon facts before an agent can move This computer away from another Account (%s)', async outcome => {
        const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
        const { normalizeActionsSettingsV1 } = await import('@happier-dev/protocol/actions/actionSettings');
        const { createMachineConnectionActionDeps } = await import('@/sync/ops/actions/machineConnectionActionDeps');
        const previous = storage.getState();
        const serverId = await harness.addHome({ serverUrl: 'https://cold-local.example.test', name: 'Cold local', accountId: 'alice' });
        const manual = createManualSystemTaskRunner('tauri');
        try {
            await setActiveServerId(serverId);
            await admitSsh(serverId, 'alice');
            const executor = createActionExecutor(createActionExecutorBoundaryFixture(createMachineConnectionActionDeps({ runner: manual.runner })));
            const actionsSettings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'machines.add.local.start': ['agent'] } });
            const execution = executor.execute('machines.add.local.start', { serverId }, { surface: 'agent', authority: 'account_automation', serverId, actionsSettings });
            await vi.waitFor(() => expect(manual.bridge.start).toHaveBeenCalledWith(expect.objectContaining({ kind: 'daemon.service.status.v1' })));
            manual.emitResult('personal-home-task-1', outcome === 'read_failed'
                ? { protocolVersion: 1, taskId: 'personal-home-task-1', ok: false,
                    error: { code: 'service_inventory_unavailable', message: 'Service inventory unavailable' } }
                : { protocolVersion: 1, taskId: 'personal-home-task-1', ok: true,
                data: { serviceInstalled: true, daemonRunning: true, needsAuth: false, machineId: 'bobs-machine',
                    daemonServerUrl: 'https://cold-local.example.test', daemonAccountId: 'bob', daemonAccountLabel: 'Bob' } });
            expect(await execution).toMatchObject({ ok: false, errorCode: outcome === 'read_failed' ? 'machine_enroll_not_started' : 'cancelled' });
            expect(manual.bridge.start.mock.calls.some(([spec]) => spec.kind === 'setup.thisComputer.v1')).toBe(false);
        } finally { await act(async () => discardMachineAdd()); storage.setState(previous); }
    });

    it('admits This computer setup through the same client Action for agents and retains the private native task', async () => {
        const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
        const { normalizeActionsSettingsV1 } = await import('@happier-dev/protocol/actions/actionSettings');
        const { createMachineConnectionActionDeps } = await import('@/sync/ops/actions/machineConnectionActionDeps');
        const { publishLocalDaemonStatus } = await import('@/components/settings/machines/localControl/localDaemonSharedState');
        const { Modal } = await import('@/modal');
        const previous = storage.getState();
        const serverId = await harness.addHome({ serverUrl: 'https://local-action.example.test', name: 'Local setup', accountId: 'alice' });
        const manual = createManualSystemTaskRunner('tauri');
        try {
            await setActiveServerId(serverId);
            await admitSsh(serverId, 'alice');
            const executor = createActionExecutor(createActionExecutorBoundaryFixture(createMachineConnectionActionDeps({ runner: manual.runner })));
            const context = { surface: 'agent', authority: 'account_automation', serverId } as const;
            expect(await executor.execute('machines.add.local.start', { serverId }, context))
                .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
            expect(manual.bridge.start).not.toHaveBeenCalled();
            const actionsSettings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'machines.add.local.start': ['agent'] } });
            expect(await executor.execute('machines.add.local.start', { serverId, password: 'private' }, { ...context, actionsSettings }))
                .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
            publishLocalDaemonStatus(manual.runner, { serviceInstalled: true, daemonRunning: true, needsAuth: false,
                daemonServerUrl: 'https://local-action.example.test', daemonAccountId: 'bob', daemonAccountLabel: 'Bob' });
            expect(await executor.execute('machines.add.local.start', { serverId }, { ...context, actionsSettings }))
                .toMatchObject({ ok: false, errorCode: 'cancelled' });
            expect(manual.bridge.start).not.toHaveBeenCalled();
            vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
            expect(await executor.execute('machines.add.local.start', { serverId }, { ...context, actionsSettings }))
                .toEqual({ ok: true, result: { taskId: 'personal-home-task-1' } });
            expect(manual.bridge.start).toHaveBeenCalledOnce();
            expect(manual.bridge.start.mock.calls[0]?.[0]).toMatchObject({ kind: 'setup.thisComputer.v1', params: {
                activeRelayUrl: 'https://local-action.example.test', activeAccountId: 'alice', installService: true, startService: true, verifyService: true,
            } });
            expect(readMachineAddFlowDraft()).toMatchObject({ serverId, path: 'thisComputer', thisComputerTask: { taskId: 'personal-home-task-1', starting: false } });
            expect(await executor.execute('machines.add.local.cancel', { taskId: 'another-task' }, context))
                .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
            expect(await executor.execute('machines.add.local.cancel', { taskId: 'personal-home-task-1' }, { ...context, expectedAccountId: 'bob' }))
                .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
            expect(manual.bridge.cancel).not.toHaveBeenCalled();
            expect(await executor.execute('machines.add.local.cancel', { taskId: 'personal-home-task-1' }, context))
                .toEqual({ ok: true, result: { taskId: 'personal-home-task-1' } });
            expect(manual.bridge.cancel).toHaveBeenCalledWith('personal-home-task-1');
            expect(readMachineAddFlowDraft().startedAtMs).toBeNull();
        } finally { await act(async () => discardMachineAdd()); storage.setState(previous); }
    });

    it('reconsiders CLI management through the admitted local setup Action without accepting arbitrary native tasks', async () => {
        const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
        const { normalizeActionsSettingsV1 } = await import('@happier-dev/protocol/actions/actionSettings');
        const { createMachineConnectionActionDeps } = await import('@/sync/ops/actions/machineConnectionActionDeps');
        const { publishLocalDaemonStatus } = await import('@/components/settings/machines/localControl/localDaemonSharedState');
        const previous = storage.getState();
        const serverId = await harness.addHome({ serverUrl: 'https://cli-choice.example.test', name: 'CLI choice', accountId: 'alice' });
        const manual = createManualSystemTaskRunner('tauri');
        try {
            await setActiveServerId(serverId);
            await admitSsh(serverId, 'alice');
            publishLocalDaemonStatus(manual.runner, { serviceInstalled: true, daemonRunning: true, needsAuth: false,
                daemonServerUrl: 'https://cli-choice.example.test', daemonAccountId: 'alice' });
            const executor = createActionExecutor(createActionExecutorBoundaryFixture(createMachineConnectionActionDeps({ runner: manual.runner })));
            const actionsSettings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'machines.add.local.start': ['agent'] } });
            const context = { surface: 'agent', authority: 'account_automation', serverId, actionsSettings } as const;
            for (const input of [{ serverId, reconsiderCli: 'yes' }, { serverId, reconsiderCli: true, command: 'arbitrary' },
                { serverId, reconsiderCli: true, installService: false }]) {
                expect(await executor.execute('machines.add.local.start', input, context))
                    .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
            }
            expect(manual.bridge.start).not.toHaveBeenCalled();
            expect(await executor.execute('machines.add.local.start', { serverId, reconsiderCli: true }, context))
                .toEqual({ ok: true, result: { taskId: 'personal-home-task-1' } });
            expect(manual.bridge.start.mock.calls[0]?.[0]).toMatchObject({ kind: 'setup.thisComputer.v1', params: {
                activeRelayUrl: 'https://cli-choice.example.test', activeAccountId: 'alice', reconsiderCli: true,
                installService: true, startService: true, verifyService: true,
            } });
        } finally { await act(async () => discardMachineAdd()); storage.setState(previous); }
    });

    it('runs admitted This computer setup through the mounted executor and keeps its task after leaving the presenter', async () => {
        const previous = storage.getState();
        const serverId = await harness.addHome({ serverUrl: 'https://mounted-local.example.test', name: 'Mounted local', accountId: 'alice' });
        vi.stubGlobal('isTauri', true);
        const manual = createManualSystemTaskRunner('tauri');
        try {
            await setActiveServerId(serverId);
            await admitSsh(serverId, 'alice');
            const hook = await renderHook(() => useMachineAddFlow({ runner: manual.runner, initialPath: 'thisComputer' }));
            // The real page offers setup after its existing native preflight settles.
            await act(async () => manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: true,
                data: { serviceInstalled: false, daemonRunning: false, needsAuth: true, machineId: null } }));
            await act(async () => hook.getCurrent().startThisComputer());
            await vi.waitFor(() => expect(readMachineAddFlowDraft().thisComputerTask?.taskId).toBeTruthy());
            const taskId = readMachineAddFlowDraft().thisComputerTask!.taskId!;
            expect(manual.bridge.start.mock.calls.filter(([spec]) => spec.kind === 'setup.thisComputer.v1')).toHaveLength(1);
            await hook.unmount();
            expect(readMachineAddFlowDraft().thisComputerTask?.taskId).toBe(taskId);
            expect(manual.bridge.cancel).not.toHaveBeenCalledWith(taskId);
        } finally { await act(async () => discardMachineAdd()); storage.setState(previous); vi.unstubAllGlobals(); }
    });

    it('enforces disabled This computer Action policy before the mounted Add flow starts setup', async () => {
        const previous = storage.getState();
        const serverId = await harness.addHome({ serverUrl: 'https://disabled-local.example.test', name: 'Disabled local', accountId: 'alice' });
        vi.stubGlobal('isTauri', true);
        const manual = createManualSystemTaskRunner('tauri');
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'machines.add.local.start': { enabled: false } } });
        try {
            await setActiveServerId(serverId);
            await admitSsh(serverId, 'alice');
            harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1 } }, version: 2 } });
            storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1 } });
            const hook = await renderHook(() => useMachineAddFlow({ runner: manual.runner, initialPath: 'thisComputer' }));
            await act(async () => hook.getCurrent().startThisComputer());
            await vi.waitFor(() => expect(readMachineAddFlowDraft().thisComputerTask?.startError).toBe('action_disabled'));
            expect(manual.bridge.start.mock.calls.some(([spec]) => spec.kind === 'setup.thisComputer.v1')).toBe(false);
            await hook.unmount();
        } finally { await act(async () => discardMachineAdd()); storage.setState(previous); vi.unstubAllGlobals(); }
    });

    it.each([
        { kind: 'auth.approveRemoteProvisioning', approved: true },
        { kind: 'daemon.replaceRemoteBackgroundServices', replaceExistingServices: true },
        { kind: 'releaseChannel.switchDefaultForSetup', switchDefaultReleaseChannel: true },
    ] as const)('honors a user waiver for the SSH $kind answer without requiring present-user authority', async answer => {
        const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
        const { normalizeActionsSettingsV1 } = await import('@happier-dev/protocol/actions/actionSettings');
        const { createMachineAddSshTaskAction } = await import('./machineAddSshTaskAction');
        const previous = storage.getState();
        const serverId = await harness.addHome({ serverUrl: 'https://ssh-waiver.example.test', name: 'SSH waiver', accountId: 'alice' });
        const manual = createManualSystemTaskRunner('native');
        vi.stubGlobal('isTauri', true);
        try {
            await setActiveServerId(serverId);
            await admitSsh(serverId, 'alice');
            const hook = await renderHook(() => useMachineAddFlow({ runner: manual.runner, initialPath: 'ssh' }));
            await act(async () => hook.getCurrent().ssh.setDraft({ ...hook.getCurrent().ssh.draft, host: 'box' }));
            await act(async () => hook.getCurrent().startSsh());
            await vi.waitFor(() => expect(readMachineAddFlowDraft().sshTask?.taskId).toBeTruthy());
            const taskId = readMachineAddFlowDraft().sshTask!.taskId!;
            await act(async () => manual.emitEvent(taskId, { type: 'prompt', message: 'Review setup', data: { kind: answer.kind,
                ...(answer.kind === 'releaseChannel.switchDefaultForSetup' ? { targetReleaseChannel: 'stable' } : { publicKey: 'remote-key' }) } }));
            // The OS bridge and Home HTTP are boundaries; policy, executor and retained task are real.
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({ machineAddSshTaskAction: createMachineAddSshTaskAction() }));
            const input = { taskId, answer };
            const context = { surface: 'agent', authority: 'account_automation', serverId } as const;
            expect(await executor.execute('machines.add.ssh.respond', input, context))
                .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
            expect(manual.bridge.respond).not.toHaveBeenCalled();
            const settings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'machines.add.ssh.respond': ['agent'] } });
            let response: unknown;
            await act(async () => { response = await executor.execute('machines.add.ssh.respond', input, { ...context, actionsSettings: settings }); });
            expect(response).toEqual({ ok: true, result: { taskId } });
            expect(manual.runner.getSnapshot(taskId)?.cancelRequested).toBe(false);
            expect(manual.bridge.respond.mock.calls.at(-1)).toEqual([taskId, Object.fromEntries(Object.entries(answer).filter(([key]) => key !== 'kind'))]);
            await hook.unmount();
        } finally { await act(async () => discardMachineAdd()); storage.setState(previous); vi.unstubAllGlobals(); }
    });
    it('resumes its canonical SSH password prompt after remount and waits for the Home feed, not just task success', async () => {
        const previous = storage.getState();
        const previousServerId = getActiveServerId();
        const home = { id: await harness.addHome({ serverUrl: 'https://ssh-flow.example.test', name: 'SSH Home', accountId: 'fixture-account' }) };
        const manual = createManualSystemTaskRunner('native');
        vi.stubGlobal('isTauri', true); // Desktop identity is an environment boundary; paths remain real.
        try {
            await setActiveServerId(home.id);
            await admitSsh(home.id, 'fixture-account');
            const first = await renderHook(() => useMachineAddFlow({ runner: manual.runner, initialPath: 'ssh' }));
            await act(async () => { first.getCurrent().ssh.setDraft({ ...first.getCurrent().ssh.draft, host: 'build-box', password: 'fixture-first-password' }); });
            await act(async () => { first.getCurrent().startSsh(); first.getCurrent().startSsh(); });
            await vi.waitFor(() => expect(readMachineAddFlowDraft().sshTask?.taskId).toBeTruthy());
            expect(first.getCurrent().run?.failure).toBeNull();
            const taskId = readMachineAddFlowDraft().sshTask?.taskId;
            expect(taskId).toBeTruthy();
            await act(async () => manual.emitEvent(taskId!, { type: 'prompt', message: 'Password needed', data: { kind: 'ssh.password', target: 'build-box' } }));
            expect(manual.bridge.respond).toHaveBeenCalledWith(taskId, { password: 'fixture-first-password' });
            await first.unmount();
            await act(async () => manual.emitEvent(taskId!, { type: 'prompt', message: 'Password needed', data: { kind: 'ssh.password', target: 'build-box' } }));
            const resumed = await renderHook(() => useMachineAddFlow({ runner: manual.runner }));
            expect(resumed.getCurrent().run?.prompt).toMatchObject({ kind: 'ssh.password' });
            await act(async () => { resumed.getCurrent().ssh.setDraft({ ...resumed.getCurrent().ssh.draft, password: 'fixture-password' }); });
            await act(async () => resumed.getCurrent().continueSshPrompt());
            await vi.waitFor(() => expect(manual.bridge.respond).toHaveBeenCalledWith(taskId, { password: 'fixture-password' }));
            expect(manual.bridge.respond).toHaveBeenCalledWith(taskId, { password: 'fixture-password' });
            await act(async () => manual.emitResult(taskId!, { protocolVersion: 1, taskId: taskId!, ok: true, data: { machineId: 'ssh-joined' } }));
            expect(resumed.getCurrent().arrived).toBeNull();
            expect(resumed.getCurrent().watch.status).toBe('watching');
            await act(async () => storage.setState({ machineListByServerId: { [home.id]: [createMachineFixture({ id: 'ssh-joined', activeAt: Date.now() })] } }));
            expect(resumed.getCurrent().arrived?.machineId).toBe('ssh-joined');
            expect(manual.bridge.start.mock.calls.filter(([spec]) => spec.kind === 'remote.ssh.bootstrapMachine.v1')).toHaveLength(1);
            await resumed.unmount();
        } finally {
            await act(async () => discardMachineAdd());
            storage.setState(previous);
            await setActiveServerId(previousServerId);
            await removeServerProfile(home.id);
            vi.unstubAllGlobals();
        }
    });
    it('cancels an OS start that resolves after Discard instead of resurrecting its draft', async () => {
        const previous = storage.getState();
        const previousServerId = getActiveServerId();
        const home = { id: await harness.addHome({ serverUrl: 'https://pending-flow.example.test', name: 'Pending Home', accountId: 'fixture-account' }) };
        const manual = createManualSystemTaskRunner('native');
        let finishStart!: (id: string) => void;
        const pendingStart = new Promise<string>((resolve) => { finishStart = resolve; });
        const originalStart = manual.bridge.start.getMockImplementation()!;
        manual.bridge.start.mockImplementation((spec) => spec.kind === 'remote.ssh.bootstrapMachine.v1' ? pendingStart : originalStart(spec));
        vi.stubGlobal('isTauri', true);
        try {
            await setActiveServerId(home.id);
            await admitSsh(home.id, 'fixture-account');
            const hook = await renderHook(() => useMachineAddFlow({ runner: manual.runner, initialPath: 'ssh' }));
            await act(async () => hook.getCurrent().ssh.setDraft({ ...hook.getCurrent().ssh.draft, host: 'pending-box' }));
            await act(async () => hook.getCurrent().startSsh());
            await vi.waitFor(() => expect(readMachineAddFlowDraft().sshTask?.starting).toBe(true));
            expect(hook.getCurrent().run?.running).toBe(true);
            await act(async () => discardMachineAdd());
            await act(async () => finishStart('pending-ssh-task'));
            expect(manual.bridge.cancel).toHaveBeenCalledWith('pending-ssh-task');
            expect(hook.getCurrent().draftRow).toBeNull();
            expect(hook.getCurrent().watch.status).toBe('idle');
            await hook.unmount();
        } finally {
            await act(async () => discardMachineAdd());
            storage.setState(previous);
            await setActiveServerId(previousServerId);
            await removeServerProfile(home.id);
            vi.unstubAllGlobals();
        }
    });
    it.each((['ssh', 'thisComputer'] as const).flatMap(path => (['cancel', 'discard', 'addAnother'] as const).map(operation => ({ path, operation }))))('applies $path cancel policy to pending $operation and cancels its eventual native task only after admission', async ({ path, operation }) => {
        const previous = storage.getState();
        const serverId = await harness.addHome({ serverUrl: 'https://pending-cancel.example.test', name: 'Pending cancel', accountId: 'alice' });
        await admitSsh(serverId, 'alice');
        const manual = createManualSystemTaskRunner('tauri');
        vi.stubGlobal('isTauri', true);
        let finishStart!: (id: string) => void;
        const pending = new Promise<string>(resolve => { finishStart = resolve; });
        const originalStart = manual.bridge.start.getMockImplementation()!;
        manual.bridge.start.mockImplementation(spec => spec.kind === 'remote.ssh.bootstrapMachine.v1' || spec.kind === 'setup.thisComputer.v1' ? pending : originalStart(spec));
        const cancelAction = path === 'ssh' ? 'machines.add.ssh.cancel' : 'machines.add.local.cancel';
        const key = path === 'ssh' ? 'sshTask' : 'thisComputerTask';
        const policy = ActionsSettingsV1Schema.parse({ ...sshPolicy, actions: { [cancelAction]: { enabled: false } } });
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1: policy } }, version: 1 } });
        storage.getState().applySettingsForScope({ serverId, accountId: 'alice' }, { ...storage.getState().settings, actionsSettingsV1: policy }, 1);
        try {
            const hook = await renderHook(() => useMachineAddFlow({ runner: manual.runner, initialPath: path }));
            if (path === 'ssh') {
                await act(async () => hook.getCurrent().ssh.setDraft({ ...hook.getCurrent().ssh.draft, host: 'pending-box' }));
                await act(async () => hook.getCurrent().startSsh());
            } else {
                await act(async () => manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: true,
                    data: { serviceInstalled: false, daemonRunning: false, needsAuth: true, machineId: null } }));
                await act(async () => hook.getCurrent().startThisComputer());
            }
            await vi.waitFor(() => expect(manual.bridge.start.mock.calls.some(([spec]) => spec.kind === (path === 'ssh' ? 'remote.ssh.bootstrapMachine.v1' : 'setup.thisComputer.v1'))).toBe(true));
            if (operation === 'addAnother') {
                // Arrival can precede the native setup result; the visible Add another still retires that task.
                await act(async () => storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'joined-while-starting', activeAt: Date.now() })] } }));
                expect(hook.getCurrent().arrived?.machineId).toBe('joined-while-starting');
            }
            const promise = readMachineAddFlowDraft()[key]?.startPromise;
            await act(async () => { await hook.getCurrent()[operation](); });
            await vi.waitFor(() => expect(readMachineAddFlowDraft()[key]?.startError).toBe('action_disabled'));
            expect(readMachineAddFlowDraft()[key]?.startPromise).toBe(promise);
            harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1: sshPolicy } }, version: 2 } });
            await act(async () => { storage.getState().applySettingsForScope({ serverId, accountId: 'alice' }, { ...storage.getState().settings, actionsSettingsV1: sshPolicy }, 2); });
            await act(async () => { await hook.getCurrent()[operation](); });
            await vi.waitFor(() => expect(readMachineAddFlowDraft()[key]).toBeNull());
            await act(async () => finishStart('pending-cancel-task'));
            await vi.waitFor(() => expect(manual.bridge.cancel).toHaveBeenCalledWith('pending-cancel-task'));
            expect(hook.getCurrent().watch.status).toBe('idle');
            expect(hook.getCurrent().run).toBeNull();
            await hook.unmount();
        } finally { finishStart('pending-cancel-task'); await act(async () => discardMachineAdd()); storage.setState(previous); vi.unstubAllGlobals(); }
    });
    it('enforces disabled SSH Action policy before the mounted Add flow starts a task', async () => {
        const previous = storage.getState();
        const serverId = await harness.addHome({ serverUrl: 'https://disabled-ssh.example.test', name: 'Disabled SSH', accountId: 'alice' });
        vi.stubGlobal('isTauri', true);
        const manual = createManualSystemTaskRunner('native');
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'machines.add.ssh.start': { enabled: false } } });
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1 } }, version: 1 } });
        storage.setState({ settingsScope: { serverId, accountId: 'alice' }, profileScope: { serverId, accountId: 'alice' }, settings: { ...previous.settings, actionsSettingsV1 }, machineListByServerId: { [serverId]: [] } });
        try {
            const hook = await renderHook(() => useMachineAddFlow({ runner: manual.runner, initialPath: 'ssh' }));
            await act(async () => hook.getCurrent().ssh.setDraft({ ...hook.getCurrent().ssh.draft, host: 'box' }));
            await act(async () => hook.getCurrent().startSsh());
            await vi.waitFor(() => expect(readMachineAddFlowDraft().sshTask?.startError).toBe('action_disabled'));
            expect(manual.bridge.start.mock.calls.some(([spec]) => spec.kind === 'remote.ssh.bootstrapMachine.v1')).toBe(false);
            await hook.unmount();
        } finally { storage.setState(previous); vi.unstubAllGlobals(); }
    });
    it('waits for the credential-backed Action binding before presenting SSH start as ready', async () => {
        const previous = storage.getState();
        const serverUrl = 'https://ssh-binding.example.test';
        const serverId = await harness.addHome({ serverUrl, name: 'SSH binding', accountId: 'alice' });
        await admitSsh(serverId, 'alice');
        vi.stubGlobal('isTauri', true);
        const manual = createManualSystemTaskRunner('native');
        const blockedCredentials = createDeferred<void>();
        const lockAcquired = createDeferred<void>();
        // A pending device write holds the real Home storage lock. Credential
        // lookup and Account binding must wait through their normal owners.
        const pendingStorageWrite = withHomeMutationAuthority(undefined, async () => {
            lockAcquired.resolve();
            await blockedCredentials.promise;
        });
        await lockAcquired.promise;
        try {
            const hook = await renderHook(() => useMachineAddFlow({ runner: manual.runner, initialPath: 'ssh' }));
            await act(async () => hook.getCurrent().ssh.setDraft({ ...hook.getCurrent().ssh.draft, host: 'box' }));
            expect(hook.getCurrent().ssh.ready).toBe(false);
            await act(async () => blockedCredentials.resolve());
            await vi.waitFor(() => expect(hook.getCurrent().ssh.ready).toBe(true));
            await act(async () => hook.getCurrent().startSsh());
            await vi.waitFor(() => expect(readMachineAddFlowDraft().sshTask?.taskId).toBeTruthy());
            await hook.unmount();
        } finally {
            blockedCredentials.resolve();
            await pendingStorageWrite;
            await act(async () => discardMachineAdd());
            storage.setState(previous); vi.unstubAllGlobals();
        }
    });
    it('publishes the initial Create choice atomically without a temporary connection draft', async () => {
        const serverId = await harness.addHome({ serverUrl: 'https://initial-create.example.test', name: 'Create', accountId: 'alice' });
        const { t } = await import('@/text');
        const manual = createManualSystemTaskRunner('native');
        const frames: (ReturnType<typeof useMachineAddDraftRow>)[] = [];
        const rail = await renderHook(() => { const row = useMachineAddDraftRow(); frames.push(row); return row; });
        let initialCreating: boolean | null = null;
        const flow = await renderHook(() => {
            const options = { serverId, runner: manual.runner, initialCreating };
            return useMachineAddFlow(options);
        });
        try {
            expect(readMachineAddFlowDraft().path).toBeNull();
            expect(rail.getCurrent()).toBeNull();
            initialCreating = true;
            await flow.rerender();
            expect(rail.getCurrent()).toMatchObject({ status: t('managedMachines.add.choosingCreate'), tone: 'draft' });
            expect(frames.filter(row => row !== null).every(row => row.status === t('managedMachines.add.choosingCreate'))).toBe(true);
            await flow.unmount();
            await rail.rerender();
            expect(rail.getCurrent()).toMatchObject({ status: t('managedMachines.add.choosingCreate'), tone: 'draft' });
        } finally { await flow.unmount(); await rail.unmount(); }
    });

    it('keeps an idle add draft idle across rail remounts until arrival watching starts', async () => {
        const { t } = await import('@/text');
        await act(async () => updateMachineAddFlowDraft((draft) => ({ ...draft, path: 'anotherComputer' })));
        const first = await renderHook(() => useMachineAddDraftRow());
        expect(first.getCurrent()).toMatchObject({ status: t('common.draft'), tone: 'draft' });
        await first.unmount();
        const resumed = await renderHook(() => useMachineAddDraftRow());
        try {
            expect(resumed.getCurrent()).toMatchObject({ status: t('common.draft'), tone: 'draft' });
            await act(async () => updateMachineAddFlowDraft((draft) => ({ ...draft, startedAtMs: Date.now() })));
            expect(resumed.getCurrent()).toMatchObject({ status: t('machineAdd.waiting'), tone: 'waiting' });
            await act(async () => updateMachineAddFlowDraft((draft) => ({ ...draft, startedAtMs: null, creating: true })));
            expect(resumed.getCurrent()).toMatchObject({ status: t('managedMachines.add.choosingCreate'), tone: 'draft' });
        } finally { await resumed.unmount(); }
    });
    it('projects the retained SSH run in the rail without mounting the flow or reacting to password edits', async () => {
        const manual = createManualSystemTaskRunner('native');
        let renders = 0;
        const row = await renderHook(() => { renders++; return useMachineAddDraftRow(); });
        expect(row.getCurrent()).toBeNull();
        const taskId = await manual.runner.start({ protocolVersion: 1, kind: 'remote.ssh.bootstrapMachine.v1', params: {
            ssh: { target: 'box', auth: 'password' }, relay: { relayUrl: 'https://rail.test', webappUrl: 'https://rail.test' }, channel: 'stable', serviceMode: 'user', knownHostsMode: 'app',
        } });
        await act(async () => updateMachineAddFlowDraft((draft) => ({ ...draft, path: 'ssh', sshDraft: { ...draft.sshDraft, host: 'box' }, sshTask: { runner: manual.runner, taskId, starting: false, startError: null } })));
        expect(row.getCurrent()).toMatchObject({ title: 'box', tone: 'running' });
        const beforePassword = renders;
        await act(async () => updateMachineAddFlowDraft((draft) => ({ ...draft, sshDraft: { ...draft.sshDraft, password: 'secret' } })));
        expect(renders).toBe(beforePassword);
        await act(async () => manual.emitResult(taskId, { protocolVersion: 1, taskId, ok: false, error: { code: 'connection-failed', message: 'Connection refused' } }));
        expect(row.getCurrent()?.tone).toBe('failed');
        await act(async () => discardMachineAdd());
        expect(row.getCurrent()).toBeNull();
        await row.unmount();
    });
    it('keeps its Home and arrival baseline when the presenter leaves and remounts', async () => {
        const previous = storage.getState();
        const home = await upsertServerProfile({ serverUrl: 'https://flow-home.example.test', name: 'Flow Home' });
        let discard: (() => void) | undefined;
        try {
            storage.setState({ machineListByServerId: { [home.id]: [createMachineFixture({ id: 'existing', activeAt: Date.now() })] } });
            const first = await renderHook(() => useMachineAddFlow({ serverId: home.id }));
            discard = first.getCurrent().discard;
            await act(async () => { first.getCurrent().choosePath('anotherComputer'); first.getCurrent().startWatching(); });
            const startedAtMs = first.getCurrent().watch.startedAtMs;
            expect(first.getCurrent().watch.status).toBe('watching');
            await first.unmount();
            storage.setState({ machineListByServerId: { [home.id]: [
                createMachineFixture({ id: 'existing', activeAt: Date.now() }),
                createMachineFixture({ id: 'new-computer', activeAt: Date.now() }),
            ] } });
            const resumed = await renderHook(() => useMachineAddFlow({ serverId: home.id }));
            expect(resumed.getCurrent().path).toBe('anotherComputer');
            expect(resumed.getCurrent().watch).toMatchObject({ status: 'arrived', startedAtMs });
            expect(resumed.getCurrent().arrived?.machineId).toBe('new-computer');
            await act(async () => { await resumed.getCurrent().discard(); });
            expect(resumed.getCurrent().watch.status).toBe('idle');
            await resumed.unmount();
        } finally {
            await act(async () => discard?.());
            storage.setState(previous);
            await removeServerProfile(home.id);
        }
    });
    it('reports not-seeing after five minutes without abandoning the watch, and discard stops it', async () => {
        const previous = storage.getState();
        const home = await upsertServerProfile({ serverUrl: 'https://flow-clock.example.test', name: 'Clock Home' });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        let discard: (() => void) | undefined;
        try {
            storage.setState({ machineListByServerId: { [home.id]: [] } });
            const hook = await renderHook(() => useMachineAddFlow({ serverId: home.id }));
            discard = hook.getCurrent().discard;
            await act(async () => { hook.getCurrent().choosePath('anotherComputer'); hook.getCurrent().startWatching(); });
            await act(async () => { vi.advanceTimersByTime(5 * 60_000 - 1); });
            expect(hook.getCurrent().watch.notSeeing).toBe(false);
            await act(async () => { vi.advanceTimersByTime(1); });
            expect(hook.getCurrent().watch).toMatchObject({ status: 'watching', notSeeing: true });
            await act(async () => { await hook.getCurrent().discard(); });
            expect(hook.getCurrent().watch).toMatchObject({ status: 'idle', notSeeing: false });
            await act(async () => storage.setState({ machineListByServerId: { [home.id]: [createMachineFixture({ id: 'late', activeAt: Date.now() })] } }));
            expect(hook.getCurrent().watch.status).toBe('idle');
            await hook.unmount();
        } finally {
            await act(async () => discard?.());
            vi.useRealTimers();
            storage.setState(previous);
            await removeServerProfile(home.id);
        }
    });
});

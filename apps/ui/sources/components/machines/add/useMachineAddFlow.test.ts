import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createDeferred } from '@/dev/testkit';
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
const sshPolicy = { v: 1 as const, actions: {}, approvalWaivedSurfaces: { 'machines.add.ssh.start': ['ui' as const], 'machines.add.ssh.respond': ['ui' as const] } };

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

beforeEach(async () => { await harness.reset(); });
afterEach(async () => { await act(async () => discardMachineAdd()); publishAppliedActiveServerRuntimeAvailability(false); vi.useRealTimers(); standardCleanup(); });
describe('machine add flow lifetime', () => {
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
    it.each(['cancel', 'discard', 'addAnother'] as const)('applies SSH cancel policy to pending %s and cancels its eventual native task only after admission', async (operation) => {
        const previous = storage.getState();
        const serverId = await harness.addHome({ serverUrl: 'https://pending-cancel.example.test', name: 'Pending cancel', accountId: 'alice' });
        await admitSsh(serverId, 'alice');
        const manual = createManualSystemTaskRunner('native');
        vi.stubGlobal('isTauri', true);
        let finishStart!: (id: string) => void;
        const pending = new Promise<string>(resolve => { finishStart = resolve; });
        const originalStart = manual.bridge.start.getMockImplementation()!;
        manual.bridge.start.mockImplementation(spec => spec.kind === 'remote.ssh.bootstrapMachine.v1' ? pending : originalStart(spec));
        const policy = ActionsSettingsV1Schema.parse({ ...sshPolicy, actions: { 'machines.add.ssh.cancel': { enabled: false } } });
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1: policy } }, version: 1 } });
        storage.getState().applySettingsForScope({ serverId, accountId: 'alice' }, { ...storage.getState().settings, actionsSettingsV1: policy }, 1);
        try {
            const hook = await renderHook(() => useMachineAddFlow({ runner: manual.runner, initialPath: 'ssh' }));
            await act(async () => hook.getCurrent().ssh.setDraft({ ...hook.getCurrent().ssh.draft, host: 'pending-box' }));
            await act(async () => hook.getCurrent().startSsh());
            await vi.waitFor(() => expect(manual.bridge.start.mock.calls.some(([spec]) => spec.kind === 'remote.ssh.bootstrapMachine.v1')).toBe(true));
            if (operation === 'addAnother') {
                // Arrival can precede the native setup result; the visible Add another still retires that task.
                await act(async () => storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'joined-while-starting', activeAt: Date.now() })] } }));
                expect(hook.getCurrent().arrived?.machineId).toBe('joined-while-starting');
            }
            const promise = readMachineAddFlowDraft().sshTask?.startPromise;
            await act(async () => { await hook.getCurrent()[operation](); });
            await vi.waitFor(() => expect(readMachineAddFlowDraft().sshTask?.startError).toBe('action_disabled'));
            expect(readMachineAddFlowDraft().sshTask?.startPromise).toBe(promise);
            harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1: sshPolicy } }, version: 2 } });
            await act(async () => { storage.getState().applySettingsForScope({ serverId, accountId: 'alice' }, { ...storage.getState().settings, actionsSettingsV1: sshPolicy }, 2); });
            await act(async () => { await hook.getCurrent()[operation](); });
            await vi.waitFor(() => expect(readMachineAddFlowDraft().sshTask).toBeNull());
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

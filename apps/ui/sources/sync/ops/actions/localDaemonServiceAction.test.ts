import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storageStore';
import { readLocalDaemonSharedState, publishLocalDaemonStatus } from '@/components/settings/machines/localControl/localDaemonSharedState';
import type { LocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { markUpdateCompletionsSeen, readUnseenUpdateCompletions } from '@/updates/updateCompletions';
import { buildUpdateItemId } from '@/updates/items/updateItem';
import { resolveServerProfileScopeIdForIdentifier, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { setDesktopLoginStartMode } from '@/components/settings/desktop/desktopLoginStart';
import { createDeferred, renderHook } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
vi.mock('expo-router/build/link/href', () => ({ resolveHref: vi.fn() }));
vi.mock('@/config', () => ({ config: { variant: 'production', identityVariant: 'stable' } }));
vi.mock('@/text', async () => ({ ...(await import('@/dev/testkit/mocks/text')).createTextModuleMock() }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();

afterEach(() => { standardCleanup(); publishAppliedActiveServerRuntimeAvailability(false); vi.unstubAllGlobals(); });

const status: LocalDaemonStatusData = {
    serviceInstalled: true, daemonRunning: true, needsAuth: false, machineId: 'local-desktop',
    serviceAutostart: 'on-demand', managedServiceInstalled: true,
};

async function fixture(mode: 'tauri' | 'native' = 'tauri') {
    await harness.reset();
    const serverId = await harness.addHome({ name: 'Local service Home', serverUrl: 'https://service-home.test', serverIdentityId: 'srv_local-service', accountId: 'alice' });
    storage.setState({ settingsScope: { serverId, accountId: 'alice' }, profileScope: { serverId, accountId: 'alice' } });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    const manual = createManualSystemTaskRunner(mode);
    publishLocalDaemonStatus(manual.runner, status);
    vi.stubGlobal('isTauri', true);
    const executor = createDefaultActionExecutor({ homeRuntimeRunner: manual.runner });
    return { serverId, manual, executor, context: { surface: 'ui', authority: 'present_user', serverId } as const };
}

describe('local daemon service Actions through the native task owner', () => {
    it('does not display or cancel another Home service start in Settings', async () => {
        const { serverId, manual, executor, context } = await fixture();
        const pending = executor.execute('machines.local.service.start', { serverId }, context);
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe('daemon.service.start.v1'));
        const otherId = await harness.addHome({ name: 'Other Home', serverUrl: 'https://other-local-service.test', accountId: 'bob' });
        storage.setState({ settingsScope: { serverId: otherId, accountId: 'bob' }, profileScope: { serverId: otherId, accountId: 'bob' } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
        const { useLocalDaemonControl } = await import('@/components/settings/machines/localControl/useLocalDaemonControl');
        const hook = await renderHook(() => useLocalDaemonControl({ runner: manual.runner }));
        try {
            expect(hook.getCurrent().activeTaskSnapshot).toBeNull();
            await act(async () => { hook.getCurrent().cancel(); });
            expect(manual.bridge.cancel).not.toHaveBeenCalled();
        } finally {
            manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: false,
                error: { code: 'canceled', message: 'Canceled original Home task' } });
            await pending;
            await hook.unmount();
        }
    });

    it('keeps admitted Settings start progress and cancellation attached to the native task', async () => {
        const { manual } = await fixture();
        const { useLocalDaemonControl } = await import('@/components/settings/machines/localControl/useLocalDaemonControl');
        const hook = await renderHook(() => useLocalDaemonControl({ runner: manual.runner }));
        await act(async () => {
            manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: true, data: status });
        });
        let pending!: Promise<unknown>;
        await act(async () => { pending = hook.getCurrent().startDaemonService(); });
        await act(async () => {
            await vi.waitFor(() => expect(manual.bridge.start.mock.calls[1]?.[0].kind).toBe('daemon.service.start.v1'));
        });
        await act(async () => {
            manual.emitEvent('personal-home-task-2', { type: 'progress', message: 'Starting background service' });
        });
        expect(hook.getCurrent().activeTaskSnapshot?.taskId).toBe('personal-home-task-2');
        expect(manual.bridge.start.mock.calls[1]?.[0].params).toMatchObject({ relayUrl: 'https://service-home.test' });
        await act(async () => {
            hook.getCurrent().cancel();
            manual.emitResult('personal-home-task-2', { protocolVersion: 1, taskId: 'personal-home-task-2', ok: false,
                error: { code: 'canceled', message: 'Canceled' } });
            await pending;
        });
        expect(manual.bridge.cancel).toHaveBeenCalledWith('personal-home-task-2');
        expect(hook.getCurrent().isBusy).toBe(false);
        await hook.unmount();
    });

    it.each(['startDaemonService', 'updateCli'] as const)('refuses the Settings %s effect when its Action is disabled', async callback => {
        const { serverId, manual } = await fixture();
        const actionId = callback === 'startDaemonService' ? 'machines.local.service.start' : 'machines.local.service.update';
        const settings = { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({
            v: 1, actions: { [actionId]: { enabled: false } },
        }) };
        storage.getState().applySettingsForScope({ serverId, accountId: 'alice' }, settings, 2);
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 2 } });
        const { useLocalDaemonControl } = await import('@/components/settings/machines/localControl/useLocalDaemonControl');
        const hook = await renderHook(() => useLocalDaemonControl({ runner: manual.runner }));
        await act(async () => {
            manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: true, data: status });
        });
        let pending!: Promise<unknown>;
        await act(async () => { pending = hook.getCurrent()[callback](); });
        try {
            expect(manual.bridge.start.mock.calls.map(([spec]) => spec.kind)).toEqual(['daemon.service.status.v1']);
            await act(async () => { await pending; });
            expect(manual.bridge.start.mock.calls.map(([spec]) => spec.kind)).toEqual(['daemon.service.status.v1']);
            expect(hook.getCurrent().lastErrorMessage).toBeTruthy();
        } finally { await hook.unmount(); }
    });

    // Plan 71 §4 keeps native consent while requiring repair/reconsideration to enter Action admission.
    it.each(['changeCommandLine', 'repairBackgroundService'] as const)('refuses Settings %s before native setup when its local setup Action is disabled', async callback => {
        const { serverId, manual } = await fixture();
        const settings = { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({
            v: 1, actions: { 'machines.add.local.start': { enabled: false } },
        }) };
        storage.getState().applySettingsForScope({ serverId, accountId: 'alice' }, settings, 2);
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 2 } });
        const { useLocalDaemonControl } = await import('@/components/settings/machines/localControl/useLocalDaemonControl');
        const hook = await renderHook(() => useLocalDaemonControl({ runner: manual.runner }));
        await act(async () => {
            manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: true, data: status });
        });
        try {
            await act(async () => { await hook.getCurrent()[callback](); });
            expect(manual.bridge.start.mock.calls.map(([spec]) => spec.kind)).toEqual(['daemon.service.status.v1']);
            expect(hook.getCurrent().lastErrorMessage).toBeTruthy();
        } finally { await hook.unmount(); }
    });

    // Plan 71 §4 retains specialized native consent while replacing raw calls with Actions.
    // These signed-in journeys replace the unauthenticated shared-state setup variants.
    it.each([
        ['changeCommandLine', 'setup.thisComputer.v1'],
        ['repairBackgroundService', 'setup.repairThisComputer.v1'],
    ] as const)('retains admitted Settings %s prompts and progress after navigation and surfaces terminal failure on return', async (callback, kind) => {
        const { serverId, manual } = await fixture();
        const previousProfile = storage.getState().profile;
        // Settings observes the hydrated profile id; Action admission reads the Account scope.
        storage.setState({ profile: AccountProfileSchema.parse({ id: 'alice' }) });
        const settings = { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({
            v: 1, approvalWaivedSurfaces: { 'machines.add.local.start': ['ui'] },
        }) };
        storage.getState().applySettingsForScope({ serverId, accountId: 'alice' }, settings, 2);
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 2 } });
        const { useLocalDaemonControl } = await import('@/components/settings/machines/localControl/useLocalDaemonControl');
        const { discardMachineAdd } = await import('@/components/machines/add/useMachineAddFlow');
        const { Modal } = await import('@/modal');
        const mounted = await renderHook(() => useLocalDaemonControl({ runner: manual.runner }));
        await act(async () => manual.emitResult('personal-home-task-1', {
            protocolVersion: 1, taskId: 'personal-home-task-1', ok: true, data: status,
        }));
        let finishStart!: (taskId: string) => void;
        manual.bridge.start.mockImplementationOnce(() => new Promise<string>(resolve => { finishStart = resolve; }));
        let starting!: Promise<string | null>;
        try {
            await act(async () => {
                starting = mounted.getCurrent()[callback]();
                await vi.waitFor(() => expect(manual.bridge.start.mock.calls[1]?.[0].kind).toBe(kind));
            });
            expect(manual.bridge.start.mock.calls[1]?.[0].params).toMatchObject({
                activeRelayUrl: 'https://service-home.test', activeServerIdentityId: 'srv_local-service',
                activeAccountId: 'alice', surface: 'desktop.ui',
                ...(callback === 'changeCommandLine' ? { reconsiderCli: true } : {}),
            });
            await mounted.unmount();
            const waiting = await renderHook(() => useLocalDaemonControl({ runner: manual.runner }));
            expect(waiting.getCurrent().isBusy).toBe(true);
            let taskId: string | null = null;
            await act(async () => { finishStart('delayed-setup'); taskId = await starting; });
            expect(waiting.getCurrent().activeTaskSnapshot?.taskId).toBe(taskId);
            await waiting.unmount();
            expect(manual.bridge.cancel).not.toHaveBeenCalledWith(taskId);
            manual.emitEvent(taskId!, { type: 'progress', message: 'Preparing computer' });
            vi.mocked(Modal.alertAsync).mockImplementationOnce(async (_title, _message, buttons) => {
                buttons?.at(-1)?.onPress?.();
            });
            manual.emitEvent(taskId!, { type: 'prompt', message: 'Choose command line', data: {
                kind: 'setup.cliChoice', command: '/usr/local/bin/happier', version: '0.3.1', origin: 'npm',
                removalCommand: null, updateCommand: null, belowSetupFloor: false, missing: false, keepBlockedBy: null,
            } });
            await flushHookEffects();
            expect(manual.bridge.respond).toHaveBeenCalledWith(taskId, { choice: 'managed' });
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
                const otherId = await harness.addHome({ name: 'Other Settings Home', serverUrl: 'https://other-settings-home.test', accountId: 'bob' });
                storage.setState({ settingsScope: { serverId: otherId, accountId: 'bob' }, profileScope: { serverId: otherId, accountId: 'bob' },
                    profile: AccountProfileSchema.parse({ id: 'bob' }) });
                publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
            });
            expect(returned.getCurrent().activeTaskSnapshot).toBeNull();
            expect(returned.getCurrent().isBusy).toBe(true);
            let otherRun: string | null = null;
            await act(async () => { otherRun = await returned.getCurrent().repairBackgroundService(); });
            expect(otherRun).toBeNull();
            await act(async () => {
                await setActiveServerId(serverId);
                storage.setState({ settingsScope: { serverId, accountId: 'alice' }, profileScope: { serverId, accountId: 'alice' },
                    profile: AccountProfileSchema.parse({ id: 'alice' }) });
                publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
            });
            expect(returned.getCurrent().activeTaskSnapshot?.taskId).toBe(taskId);
            await returned.unmount();
            manual.emitResult(taskId!, { protocolVersion: 1, taskId: taskId!, ok: false,
                error: { code: 'test_setup_failure', message: 'Named setup failure' } });
            await flushHookEffects();
            const failed = await renderHook(() => useLocalDaemonControl({ runner: manual.runner }));
            expect(failed.getCurrent().lastErrorMessage).toBe('Named setup failure');
            expect(failed.getCurrent().isBusy).toBe(false);
            // thisComputerSetupScope.ts:19–22 prefers the published Home identity over its local URL alias.
            expect(readLocalDaemonSharedState(manual.runner).setup.scope?.serverId)
                .toBe(resolveServerProfileScopeIdForIdentifier(serverId));
            await failed.unmount();
        } finally {
            await act(async () => discardMachineAdd());
            storage.setState({ profile: previousProfile });
        }
    });

    it('refuses competing CLI reconsideration in an exact relay repair before starting any native task', async () => {
        const { serverId, manual, executor, context } = await fixture();
        expect(await executor.execute('machines.add.local.start', { serverId, purpose: 'relay_repair', reconsiderCli: true }, context))
            .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(manual.bridge.start).not.toHaveBeenCalled();
    });

    it.each([
        ['reconsideration', { reconsiderCli: true }, 'setup.thisComputer.v1'],
        ['relay repair', { purpose: 'relay_repair' }, 'setup.repairThisComputer.v1'],
    ] as const)('keeps %s independent of an unrelated pending Add task and its draft', async (_purpose, input, kind) => {
        const { serverId, manual, executor, context } = await fixture();
        const settings = { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({
            v: 1, approvalWaivedSurfaces: { 'machines.add.local.start': ['ui'] },
        }) };
        storage.getState().applySettingsForScope({ serverId, accountId: 'alice' }, settings, 2);
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 2 } });
        const { readMachineAddFlowDraft, updateMachineAddFlowDraft, discardMachineAddFlowDraft } =
            await import('@/components/machines/add/machineAddFlowStore');
        const { startMachineAddTask } = await import('@/components/machines/add/machineAddTaskLifetime');
        const held = createDeferred<string | null>();
        updateMachineAddFlowDraft(draft => ({ ...draft, serverId, path: 'ssh',
            sshDraft: { ...draft.sshDraft, host: 'unfinished-add.example' } }));
        const unrelated = startMachineAddTask('ssh', manual.runner, () => held.promise);
        const draft = readMachineAddFlowDraft();
        try {
            expect(await executor.execute('machines.add.local.start', { serverId, ...input }, context))
                .toMatchObject({ ok: true, result: { taskId: 'personal-home-task-1' } });
            expect(manual.bridge.start.mock.calls.map(([spec]) => spec.kind)).toEqual([kind]);
            expect(readMachineAddFlowDraft()).toBe(draft);
            expect(manual.bridge.cancel).not.toHaveBeenCalled();
        } finally {
            held.resolve(null);
            await unrelated;
            manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: false,
                error: { code: 'canceled', message: 'Fixture complete' } });
            discardMachineAddFlowDraft();
        }
    });

    it.each(['agent', 'mcp', 'cli'] as const)('lets %s read the same native service status owner', async surface => {
        const { serverId, manual, executor, context } = await fixture();
        const pending = executor.execute('machines.local.service.status', { serverId },
            { ...context, surface, authority: 'account_automation' });
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe('daemon.service.status.v1'));
        manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: true, data: status });
        expect(await pending).toMatchObject({ ok: true, result: { taskId: 'personal-home-task-1', result: { ok: true } } });
        expect(readLocalDaemonSharedState<LocalDaemonStatusData>(manual.runner).status?.machineId).toBe('local-desktop');
    });

    it.each([
        ['status', 'daemon.service.status.v1'], ['start', 'daemon.service.start.v1'],
        ['stop', 'daemon.service.stop.v1'], ['restart', 'daemon.service.restart.v1'],
        ['autostart.set', 'daemon.service.autostart.set.v1'], ['update', 'cli.update.v1'],
        ['disconnect', 'daemon.service.relay.disconnect.v1'],
    ] as const)('settles %s on the exact Home and publishes its native status', async (operation, kind) => {
        const { serverId, manual, executor, context } = await fixture();
        const actionId = `machines.local.service.${operation}` as const;
        const pending = executor.execute(actionId, { serverId, ...(operation === 'autostart.set' ? { autostart: 'at-login' } : {}) }, context);
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe(kind));
        expect(manual.bridge.start.mock.calls[0]?.[0].params).toMatchObject({ target: { kind: 'local' }, mode: 'user' });
        if (operation === 'autostart.set') {
            expect(manual.bridge.start.mock.calls[0]?.[0].params).not.toHaveProperty('relayUrl');
        } else {
            expect(manual.bridge.start.mock.calls[0]?.[0].params).toMatchObject({ relayUrl: 'https://service-home.test', serverIdentityId: 'srv_local-service' });
        }
        if (operation === 'update') expect(readLocalDaemonSharedState(manual.runner).cliUpdate.taskId).toBe('personal-home-task-1');
        manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: true,
            data: operation === 'status' ? status : operation === 'disconnect' ? { outcome: 'removed' } : {} });
        if (operation !== 'status') {
            await vi.waitFor(() => expect(manual.bridge.start.mock.calls[1]?.[0].kind).toBe('daemon.service.status.v1'));
            manual.emitResult('personal-home-task-2', { protocolVersion: 1, taskId: 'personal-home-task-2', ok: true,
                data: { ...status, serviceAutostart: operation === 'autostart.set' ? 'at-login' : 'on-demand' } });
        }
        expect(await pending).toMatchObject({ ok: true, result: operation === 'disconnect'
            ? { outcome: 'removed' } : { taskId: 'personal-home-task-1', result: { ok: true } } });
        expect(readLocalDaemonSharedState<LocalDaemonStatusData>(manual.runner).status?.serviceAutostart)
            .toBe(operation === 'autostart.set' ? 'at-login' : 'on-demand');
    });

    it('refuses a phone bridge and a mismatching Home before native mutation', async () => {
        const { serverId, manual, executor, context } = await fixture('native');
        expect(await executor.execute('machines.local.service.start', { serverId }, context)).toMatchObject({ ok: false, errorCode: 'local_service_unavailable' });
        expect(manual.bridge.start).not.toHaveBeenCalled();
        const desktop = await fixture();
        expect(await desktop.executor.execute('machines.local.service.start', { serverId: 'another-home' }, desktop.context))
            .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
        expect(desktop.manual.bridge.start).not.toHaveBeenCalled();
    });

    it('preserves native failure codes without reporting task failure as successful control', async () => {
        const { serverId, manual, executor, context } = await fixture();
        const pending = executor.execute('machines.local.service.restart', { serverId }, context);
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe('daemon.service.restart.v1'));
        manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: false,
            error: { code: 'service_restart_failed', message: 'Service manager refused restart' } });
        expect(await pending).toMatchObject({ ok: false, errorCode: 'service_restart_failed' });
        expect(manual.bridge.start.mock.calls).toHaveLength(1);
    });

    it('cancels the admitted service task when the invocation aborts', async () => {
        const { serverId, manual, executor, context } = await fixture();
        const controller = new AbortController();
        const pending = executor.execute('machines.local.service.start', { serverId }, { ...context, signal: controller.signal });
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe('daemon.service.start.v1'));
        controller.abort();
        await pending;
        expect(manual.bridge.cancel).toHaveBeenCalledWith('personal-home-task-1');
        expect(manual.bridge.start.mock.calls).toHaveLength(1);
    });

    it('cancels the admitted status readback when the invocation aborts after mutation', async () => {
        const { serverId, manual, executor, context } = await fixture();
        const controller = new AbortController();
        const pending = executor.execute('machines.local.service.start', { serverId }, { ...context, signal: controller.signal });
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe('daemon.service.start.v1'));
        manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: true, data: {} });
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[1]?.[0].kind).toBe('daemon.service.status.v1'));
        controller.abort();
        await pending;
        expect(manual.bridge.cancel).toHaveBeenCalledWith('personal-home-task-2');
    });

    it('changes the common login mode while its signed-in Home runtime is offline without publishing another scope', async () => {
        const { serverId, manual, executor, context } = await fixture();
        publishAppliedActiveServerRuntimeAvailability(false);
        const pending = executor.execute('machines.local.service.autostart.set', { serverId, autostart: 'at-login' }, context);
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe('daemon.service.autostart.set.v1'));
        manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: true, data: {} });
        expect(await pending).toMatchObject({ ok: true, result: { taskId: 'personal-home-task-1' } });
        expect(manual.bridge.start.mock.calls).toHaveLength(1);
        expect(readLocalDaemonSharedState<LocalDaemonStatusData>(manual.runner).status?.serviceAutostart).toBe('on-demand');
    });

    it('keeps the existing desktop row readback on the current Home when global login-start settles after a Home switch', async () => {
        const { manual } = await fixture();
        const pending = setDesktopLoginStartMode(manual.runner, 'at-login');
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe('daemon.service.autostart.set.v1'));
        await harness.addHome({ name: 'Current Home', serverUrl: 'https://current-service-home.test', accountId: 'bob' });
        manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: true, data: {} });
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[1]?.[0].kind).toBe('daemon.service.status.v1'));
        const readback = manual.bridge.start.mock.calls[1]?.[0];
        manual.emitResult('personal-home-task-2', { protocolVersion: 1, taskId: 'personal-home-task-2', ok: true, data: status });
        await pending;
        expect(readback?.params).toMatchObject({ relayUrl: 'https://current-service-home.test' });
    });

    it('uses the shared CLI-update admission instead of starting a second update', async () => {
        const { serverId, manual, executor, context } = await fixture();
        const first = executor.execute('machines.local.service.update', { serverId }, context);
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe('cli.update.v1'));
        expect(await executor.execute('machines.local.service.update', { serverId }, context)).toMatchObject({ ok: false, errorCode: 'cli_update_in_progress' });
        expect(manual.bridge.start.mock.calls).toHaveLength(1);
        manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: false, error: { code: 'cli_not_managed', message: 'User-owned CLI' } });
        expect(await first).toMatchObject({ ok: false, errorCode: 'cli_not_managed' });
    });

    it('does not misreport native update launch failure as an update already running', async () => {
        const { serverId, manual, executor, context } = await fixture();
        manual.bridge.start.mockRejectedValueOnce(new Error('system_tasks_unavailable'));
        expect(await executor.execute('machines.local.service.update', { serverId }, context))
            .toMatchObject({ ok: false, errorCode: 'local_service_update_failed' });
        expect(readLocalDaemonSharedState(manual.runner).cliUpdate.starting).toBe(false);
    });

    it('records local-computer update completion for the initiating Home without attributing another Home machine id', async () => {
        const { serverId, manual, executor, context } = await fixture();
        const initiating = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'alice' };
        markUpdateCompletionsSeen(initiating);
        const otherId = await harness.addHome({ name: 'Other Home', serverUrl: 'https://other-service-home.test', accountId: 'bob' });
        storage.setState({ settingsScope: { serverId: otherId, accountId: 'bob' }, profileScope: { serverId: otherId, accountId: 'bob' } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
        publishLocalDaemonStatus(manual.runner, { ...status, machineId: 'other-home-machine' });
        const other = { serverId: resolveServerProfileScopeIdForIdentifier(otherId), accountId: 'bob' };
        markUpdateCompletionsSeen(other);
        const pending = executor.execute('machines.local.service.update', { serverId }, context);
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[0]?.[0].kind).toBe('cli.update.v1'));
        expect(manual.bridge.start.mock.calls[0]?.[0].params).toMatchObject({ target: { kind: 'local' }, relayUrl: 'https://service-home.test' });
        manual.emitResult('personal-home-task-1', { protocolVersion: 1, taskId: 'personal-home-task-1', ok: true, data: {} });
        await vi.waitFor(() => expect(manual.bridge.start.mock.calls[1]?.[0].kind).toBe('daemon.service.status.v1'));
        manual.emitResult('personal-home-task-2', { protocolVersion: 1, taskId: 'personal-home-task-2', ok: true, data: status });
        expect(await pending).toMatchObject({ ok: true });
        expect(readUnseenUpdateCompletions(initiating).get(buildUpdateItemId('this-computer', { kind: 'happier-cli' }))).toBe('done');
        expect(readUnseenUpdateCompletions(initiating).has(buildUpdateItemId('other-home-machine', { kind: 'happier-cli' }))).toBe(false);
        expect(readUnseenUpdateCompletions(other).size).toBe(0);
        expect(readLocalDaemonSharedState<LocalDaemonStatusData>(manual.runner).status?.machineId).toBe('other-home-machine');
    });
});

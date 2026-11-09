import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { UpdatesSnapshotResultSchema } from '@happier-dev/protocol/actions/updatesActionFamily';
import { act } from 'react-test-renderer';
import { createMachineFixture, flushHookEffects, renderHook } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { UpdateItem } from '@/updates/items/updateItem';
import type { UpdatesGroup } from '@/updates/buildMachineUpdateGroups';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';

vi.mock('@/modal', async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness'))
    .createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary(socket => {
    configureConnectedServerSocketBoundary(socket);
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockResolvedValue({ ok: true, result: {} });
});

const rpc = vi.hoisted(() => vi.fn());
// Only the daemon network boundary is replaced; admission, selectors, batch and update owners run.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Updates reached unrelated Session envelope API'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { registerUpdatesActionOwner } = await import('@/updates/updatesActionRuntime');
const { runMachineItemUpdate, readMachineUpdateRuns, observeMachineUpdateRun } = await import('@/updates/machineUpdateRuns');
const { useUpdatesContentModel } = await import('@/updates/useUpdatesContentModel');
const { storage } = await import('@/sync/domains/state/storageStore');
const initialStorage = storage.getState();
let unregister: (() => void) | undefined;
let webLocks: ReturnType<typeof installWebLockManagerMock>;
beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    await homes.reset(); rpc.mockReset();
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(homes.request);
    const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
    await loadSyncSingletonForTests();
});
afterEach(async () => {
    unregister?.(); unregister = undefined;
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    await homes.reset();
    const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    resetRuntimeFetch();
    webLocks.restore(); standardCleanup(); storage.setState(initialStorage, true);
});

const cli: UpdateItem = {
    id: 'studio:happier-cli', subject: { kind: 'happier-cli' }, machineId: 'studio', title: 'Happier CLI',
    currentVersion: '1.0.0', latestVersion: '1.1.0', state: 'available', progressPercent: null, step: null,
    managedBy: 'happier', action: { kind: 'run', verb: 'update' }, failure: null, skipped: false,
};

async function installOwner() {
    const serverUrl = 'https://updates-action.test';
    const serverId = await homes.addHome({ name: 'Updates', serverUrl, serverIdentityId: 'srv_updates_action', accountId: 'alice', currentAccount: true });
    await installOwnMachineApprovalReplayBoundary({ harness: homes, serverId, accountId: 'alice', machineId: 'studio' });
    const approvalActions = ['updates.batch.start', 'machines.cli.update', 'machines.capabilities.install'] as const;
    await homes.requireUiApproval(serverId, approvalActions);
    homes.answer(serverId, '/v2/cursor', { body: { cursor: '0' } });
    const token = homes.findByServerUrl(serverUrl)?.token;
    if (!token) throw new Error('Expected Updates Account credential fixture');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer({ token });
    // Publish the Account policy after restoration has applied its Settings
    // baseline, so bootstrap cannot overwrite the fixture's Ask-first policy.
    await homes.requireUiApproval(serverId, approvalActions);
    const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    const scope = getActiveServerAccountScope();
    if (!scope) throw new Error('Expected applied Updates Account runtime');
    expect(scope).toEqual({ serverId: 'srv_updates_action', accountId: 'alice' });
    let items: readonly UpdateItem[] = [cli];
    const groups = (): UpdatesGroup[] => [{ id: 'machine:studio', kind: 'machine', machineId: 'studio', machineName: 'Studio',
        online: true, lastSeenAt: null, items }];
    unregister = registerUpdatesActionOwner(() => ({ scope, groups: groups(), check: async () => {},
        executeItem: async item => { await runMachineItemUpdate(item, { scope }); } }));
    rpc.mockImplementation(async ({ method, payload }) => {
        if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {} };
        if (method !== RPC_METHODS.CAPABILITIES_INVOKE) throw new Error(`Unexpected Updates RPC: ${method}`);
        return { ok: true, result: payload.method === 'start' ? { taskId: 'update-task' }
            : payload.method === 'poll' ? { result: { ok: true } } : {} };
    });
    return { scope, replaceItems: (next: readonly UpdateItem[]) => { items = next; } };
}
const starts = () => rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.CAPABILITIES_INVOKE);

describe('Updates Actions through current UI update owners', () => {
    it('reads the mounted model, admits a selected batch, and stops after the in-flight machine task', async () => {
        const { scope } = await installOwner();
        unregister?.(); unregister = undefined;
        const base = createMachineFixture();
        const machine = createMachineFixture({ id: 'studio', activeAt: Date.now(), storageMode: 'plain', metadata: {
            ...base.metadata!, happyCliVersion: '0.2.12', cliUpdate: { currentVersion: '0.2.12', latestVersion: '0.2.13',
                channel: 'stable', installSource: 'managed', updateCommand: 'happier self update', canUpdateRemotely: true,
                lastUpdate: null },
        } });
        storage.setState(state => ({ profileScope: scope, profile: { ...state.profile, id: scope.accountId },
            machines: { [machine.id]: machine }, machineListByServerId: { [scope.serverId]: [machine] },
            machineListStatusByServerId: { [scope.serverId]: 'idle' } }));
        let releasePoll!: () => void;
        const pendingPoll = new Promise<void>(resolve => { releasePoll = resolve; });
        let enterPoll!: () => void;
        const pollEntered = new Promise<void>(resolve => { enterPoll = resolve; });
        const normalRpc = rpc.getMockImplementation()!;
        rpc.mockImplementation(async request => {
            if (request.method === RPC_METHODS.CAPABILITIES_INVOKE && request.payload?.method === 'poll') {
                enterPoll(); await pendingPoll;
            }
            return normalRpc(request);
        });
        const hook = await renderHook(() => useUpdatesContentModel());
        try {
            await flushHookEffects();
            const executor = createDefaultActionExecutor();
            const context = { surface: 'ui' as const, serverId: scope.serverId, expectedAccountId: scope.accountId };
            const readSnapshot = async () => {
                const response = await executor.execute('updates.get', {}, context);
                if (!response.ok) throw new Error(response.errorCode);
                return UpdatesSnapshotResultSchema.parse(response.result);
            };
            const item = (await readSnapshot()).groups.find(group => group.groupId === 'machine:studio')?.items
                .find(row => row.itemId === 'studio:happier-cli');
            expect(item).toMatchObject({ state: 'available', batchEligible: true, subject: { kind: 'happier-cli' } });
            const admitted = await executor.execute('updates.batch.start', {
                groupId: 'machine:studio', itemIds: [item!.itemId],
            }, context);
            if (!admitted.ok) throw new Error(admitted.errorCode);
            const approval = ActionApprovalRequestCreatedResultSchema.parse(admitted.result);
            expect(starts()).toEqual([]);
            const replay = executor.execute('approval.request.decide', { artifactId: approval.artifactId, decision: 'approve' }, context);
            expect(await Promise.race([
                pollEntered.then(() => ({ kind: 'dispatched' as const })),
                replay.then(result => ({ kind: 'settled' as const, result })),
            ])).toEqual({ kind: 'dispatched' });
            expect((await readSnapshot()).batch).toMatchObject({ done: 0, total: 1, stopping: false });
            expect(await executor.execute('updates.batch.stop', {}, context)).toEqual({ ok: true, result: { status: 'requested' } });
            expect((await readSnapshot()).batch?.stopping).toBe(true);
            releasePoll();
            expect(await replay).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result: { status: 'requested' } } } });
            expect(starts().map(([request]) => [request.serverId, request.accountId, request.machineId, request.payload.method]))
                .toEqual([[scope.serverId, scope.accountId, machine.id, 'start'], [scope.serverId, scope.accountId, machine.id, 'poll']]);
        } finally { releasePoll(); await act(() => hook.unmount()); }
    });
    it('keeps a helper update and its batch busy through the fresh daemon facts', async () => {
        const { scope } = await installOwner();
        const helper: UpdateItem = { ...cli, id: 'studio:installable:gh', subject: { kind: 'installable', key: 'gh' } };
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        let entered!: () => void;
        const reading = new Promise<void>(resolve => { entered = resolve; });
        const boundary = rpc.getMockImplementation()!;
        rpc.mockImplementation(async request => {
            if (request.method === RPC_METHODS.CAPABILITIES_DETECT) { entered(); await pending; }
            return boundary(request);
        });
        const { runUpdateBatch, readUpdateBatch } = await import('@/updates/machineUpdateRuns');
        const completion = runUpdateBatch(scope, [helper], item => runMachineItemUpdate(item, { scope }));
        await reading;
        const during = observeMachineUpdateRun(readMachineUpdateRuns(scope.serverId), helper.id).running;
        const batch = readUpdateBatch(scope);
        release(); await completion;
        expect(during).toBe(true);
        expect(batch).toEqual({ done: 0, total: 1, stopping: false });
    });

    it('reads exact current selectors and refuses an unmounted owner', async () => {
        const { scope } = await installOwner();
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, serverId: scope.serverId, expectedAccountId: scope.accountId };
        expect(await executor.execute('updates.get', {}, context)).toMatchObject({ ok: true, result: {
            groups: [{ groupId: 'machine:studio', target: { kind: 'machine', machineId: 'studio' }, items: [{
                itemId: cli.id, subject: { kind: 'happier-cli' }, currentVersion: cli.currentVersion,
                latestVersion: cli.latestVersion, action: 'update', batchEligible: true,
            }] }], batch: null,
        } });
        unregister?.(); unregister = undefined;
        expect(await executor.execute('updates.get', {}, context)).toMatchObject({ ok: false, errorCode: 'update_target_unavailable' });
        expect(starts()).toEqual([]);
    });
    it('projects helper progress only after approval dispatch and retains its real failure for retry', async () => {
        const { scope, replaceItems } = await installOwner();
        const helper: UpdateItem = { ...cli, id: 'studio:installable:gh', subject: { kind: 'installable', key: 'gh' } };
        replaceItems([helper]);
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, serverId: scope.serverId, expectedAccountId: scope.accountId };
        const initial = await executor.execute('machines.capabilities.install', { machineId: 'studio', capabilityId: 'dep.gh', method: 'upgrade' }, context);
        if (!initial.ok) throw new Error(JSON.stringify(initial));
        const approval = ActionApprovalRequestCreatedResultSchema.parse(initial.result);
        expect(observeMachineUpdateRun(readMachineUpdateRuns(scope.serverId), helper.id).running).toBe(false);
        expect(starts()).toEqual([]);
        let release!: () => void;
        const installing = new Promise<void>(resolve => { release = resolve; });
        let entered!: () => void;
        const dispatched = new Promise<void>(resolve => { entered = resolve; });
        const boundary = rpc.getMockImplementation()!;
        rpc.mockImplementation(async request => {
            if (request.payload?.method === 'upgrade') {
                entered(); await installing;
                return { ok: false, error: { code: 'update-not-verified', message: 'Update failed.' }, logPath: '/logs/update.log' };
            }
            return boundary(request);
        });
        const replay = executor.execute('approval.request.decide', { artifactId: approval.artifactId, decision: 'approve' }, context);
        const admission = await Promise.race([
            dispatched.then(() => ({ kind: 'dispatched' as const })),
            replay.then(result => ({ kind: 'settled' as const, result })),
        ]);
        expect(admission).toEqual({ kind: 'dispatched' });
        expect(observeMachineUpdateRun(readMachineUpdateRuns(scope.serverId), helper.id)).toMatchObject({ running: true });
        release();
        await replay;
        expect(observeMachineUpdateRun(readMachineUpdateRuns(scope.serverId), helper.id)).toMatchObject({
            running: false, errorMessage: 'Update failed.', logPath: '/logs/update.log',
        });
    });
    it('keeps Account Ask-first policy before effects, then replays the exact target through the existing remote updater', async () => {
        const { scope } = await installOwner();
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, serverId: scope.serverId, expectedAccountId: scope.accountId };
        const initial = await executor.execute('machines.cli.update', { target: { kind: 'machine', machineId: 'studio' } }, context);
        if (!initial.ok) throw new Error(JSON.stringify(initial));
        const approval = ActionApprovalRequestCreatedResultSchema.parse(initial.result);
        expect(starts()).toEqual([]);
        expect(await executor.execute('approval.request.decide', { artifactId: approval.artifactId, decision: 'approve' }, context))
            .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result: { status: 'requested' } } } });
        expect(starts().map(([request]) => [request.serverId, request.accountId, request.machineId, request.payload.method]))
            .toEqual([[scope.serverId, 'alice', 'studio', 'start'], [scope.serverId, 'alice', 'studio', 'poll']]);
    });

    it('refuses withdrawn or foreign targets after approval without starting an updater', async () => {
        const { scope, replaceItems } = await installOwner();
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, serverId: scope.serverId, expectedAccountId: scope.accountId };
        const initial = await executor.execute('updates.batch.start', { groupId: 'machine:studio', itemIds: [cli.id] }, context);
        if (!initial.ok) throw new Error(JSON.stringify(initial));
        const approval = ActionApprovalRequestCreatedResultSchema.parse(initial.result);
        replaceItems([{ ...cli, state: 'upToDate', action: { kind: 'none' } }]);
        expect(await executor.execute('approval.request.decide', { artifactId: approval.artifactId, decision: 'approve' }, context))
            .toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false, errorCode: 'update_target_unavailable' } } });
        const foreign = await executor.execute('machines.cli.update', { target: { kind: 'machine', machineId: 'other' } }, context);
        if (!foreign.ok) throw new Error(JSON.stringify(foreign));
        const foreignApproval = ActionApprovalRequestCreatedResultSchema.parse(foreign.result);
        expect(starts()).toEqual([]);
        expect(await executor.execute('approval.request.decide', { artifactId: foreignApproval.artifactId, decision: 'approve' }, context))
            .toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false, errorCode: 'update_target_unavailable' } } });
        expect(starts()).toEqual([]);
    });

    it('uses the existing helper-before-CLI batch order and refuses a caller-authored row', async () => {
        const { scope, replaceItems } = await installOwner();
        const helper: UpdateItem = { ...cli, id: 'studio:installable:gh', subject: { kind: 'installable', key: 'gh' } };
        replaceItems([cli, helper]);
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, serverId: scope.serverId, expectedAccountId: scope.accountId };
        const invalid = await executor.execute('updates.batch.start', { groupId: 'machine:studio', itemIds: ['made-up'] }, context);
        if (!invalid.ok) throw new Error(JSON.stringify(invalid));
        const invalidApproval = ActionApprovalRequestCreatedResultSchema.parse(invalid.result);
        expect(starts()).toEqual([]);
        expect(await executor.execute('approval.request.decide', { artifactId: invalidApproval.artifactId, decision: 'approve' }, context))
            .toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false, errorCode: 'update_target_unavailable' } } });
        expect(starts()).toEqual([]);
        const valid = await executor.execute('updates.batch.start', { groupId: 'machine:studio', itemIds: [cli.id, helper.id] }, context);
        if (!valid.ok) throw new Error(JSON.stringify(valid));
        const validApproval = ActionApprovalRequestCreatedResultSchema.parse(valid.result);
        expect(starts()).toEqual([]);
        expect(await executor.execute('approval.request.decide', { artifactId: validApproval.artifactId, decision: 'approve' }, context))
            .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true, result: { status: 'requested' } } } });
        expect(starts().map(([request]) => request.payload.method)).toEqual(['upgrade', 'start', 'poll']);
    });
});

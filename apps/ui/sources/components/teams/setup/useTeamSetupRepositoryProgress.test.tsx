import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ActionOperationSnapshotV1Schema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import 'fake-indexeddb/auto';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';

// The Socket.IO port supplies daemon answers; Machine routing, credential
// currentness and operation observation remain in the production owners.
const daemonReply = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const daemonRequests = installSessionActionRpcBoundary((request, context) => daemonReply(request, context));
const { useTeamSetupRepositoryProgress } = await import('./useTeamSetupRepositoryProgress');
const { useTeamSetupBatchProgress } = await import('./useTeamSetupBatchProgress');
import type { TeamSetupBatch } from './useTeamSetupPlan';
await import('@/sync/domains/actionOperations/observeActionOperationByRequestId');
const { captureServerCredentialAccountScopeLifetime, resolveServerCredentialAccountScope } =
    await import('@/sync/domains/scope/serverCredentialAccountScope');
let lifetime: ServerAccountScopeLifetime;
beforeEach(async () => {
    await homes.reset();
    daemonRequests.length = 0;
    daemonReply.mockReset();
    const profileId = await homes.addHome({ name: 'Team Home', serverUrl: 'https://team-home.test',
        serverIdentityId: 'team-home', accountId: 'member', currentAccount: true });
    query.serverId = profileId;
    preparedResult = preparedResultFixture();
    homes.answer(profileId, '/v1/machines/member-machine', { body: { machine: createPlainMachineRowFixture({
        id: 'member-machine', accountId: 'member',
    }) } });
    const resolution = await resolveServerCredentialAccountScope(profileId);
    if (resolution.kind !== 'bound') throw new Error(`Expected bound Home Account, received ${resolution.kind}`);
    lifetime = captureServerCredentialAccountScopeLifetime(resolution);
});
afterEach(async () => {
    standardCleanup();
    actionOperationStore.reset();
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
});
const query = { serverId: 'team-home', accountId: 'member', machineId: 'member-machine', sourceId: 'source' };
function opening(overrides: Partial<ActionOperationSnapshotV1> = {}): ActionOperationSnapshotV1 {
    const createdAt = overrides.createdAt ?? 1;
    return ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'open', revision: 1, actionId: 'projects.open', state: 'running',
        scope: { accountId: 'member', machineId: 'member-machine' }, title: 'Open', createdAt, startedAt: createdAt,
        cancellation: 'unsupported', domainRef: { kind: 'projectOpen', sourceId: 'source' }, ...overrides });
}
function selectedBatch(): TeamSetupBatch {
    return { selection: { team: { serverId: query.serverId, teamId: 'team' }, lifetime,
        target: { serverId: query.serverId, homeId: 'home', machineId: query.machineId },
        repositories: [
            { repositoryId: 'source', source: { id: 'source', revision: 2, name: 'Shared repository' }, requestId: 'selected-request' },
            { repositoryId: 'next', source: { id: 'next', revision: 1, name: 'Next repository' }, requestId: 'next-request' },
        ] }, dispatched: new Set(['source']), running: true, settlement: null };
}
function preparedResultFixture() {
    return OpenProjectResultV1Schema.parse({ kind: 'opened', setup: 'prepared', directory: '/repo',
        workspace: { serverId: query.serverId, machineId: query.machineId, workspaceId: 'repo', rootPath: '/repo' } });
}
let preparedResult = preparedResultFixture();
function setupOperation(overrides: Partial<ActionOperationSnapshotV1> = {}): ActionOperationSnapshotV1 {
    return ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'setup', revision: 1, actionId: 'projects.prepare',
        state: 'running', scope: { accountId: query.accountId, machineId: query.machineId }, title: 'Prepare',
        createdAt: 3, startedAt: 3, cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'setup',
            serverId: query.serverId, machineId: query.machineId, workspaceRefId: 'repo', cwd: '/repo',
            sourceWorkspace: { serverId: query.serverId, machineId: query.machineId, workspaceId: 'repo', rootPath: '/repo' } },
        ...overrides });
}
describe('selected Team batch progress', () => {
    it('queues only explicit pending selection and stops queuing when its runner settles', async () => {
        const batch = selectedBatch();
        let current: TeamSetupBatch | null = batch;
        const hook = await renderHook(() => ({
            pending: useTeamSetupBatchProgress(current, 'next'),
            unrelated: useTeamSetupBatchProgress(current, 'unrelated'),
        }));
        expect(hook.getCurrent().pending).toMatchObject({ phase: 'queued', queued: true, ready: false, dispatched: false,
            source: { id: 'next', revision: 1, name: 'Next repository' } });
        expect(hook.getCurrent().unrelated).toBeNull();
        expect(daemonReply).not.toHaveBeenCalled();
        current = { ...batch, running: false, settlement: { machine: { ok: false, errorCode: 'setup_failed', error: 'Setup failed' },
            machineSettlement: null, repositories: [] } };
        await hook.rerender();
        expect(hook.getCurrent().pending).toMatchObject({ phase: 'failed', queued: false, ready: false,
            settlement: { machine: { ok: false, errorCode: 'setup_failed' } } });
        current = null;
        await hook.rerender();
        expect(hook.getCurrent().pending).toBeNull();
        await hook.unmount();
    });
    it('requires actual setup success, retains native failure, and announces only a live ready transition', async () => {
        daemonReply.mockReturnValue(new Promise(() => {}));
        const batch = selectedBatch();
        const onReady = vi.fn();
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshotComplete: true,
            snapshots: [opening({ requestId: 'selected-request', state: 'succeeded', settledAt: 2, result: preparedResult })] }));
        const hook = await renderHook(() => useTeamSetupBatchProgress(batch, 'source', onReady));
        expect(hook.getCurrent()).toMatchObject({ phase: 'prepared', queued: false, ready: false });
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [setupOperation()] }));
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [setupOperation({ revision: 2,
            state: 'failed', settledAt: 4, error: { errorCode: 'setup_exit_nonzero', error: 'Setup failed' } })] }));
        expect(hook.getCurrent()).toMatchObject({ phase: 'failed', ready: false,
            progress: { setupOperation: { snapshot: { state: 'failed', error: { errorCode: 'setup_exit_nonzero' } } } } });
        expect(onReady).not.toHaveBeenCalled();
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [setupOperation({
            operationId: 'retry', createdAt: 5, startedAt: 5 })] }));
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [setupOperation({
            operationId: 'retry', revision: 2, createdAt: 5, startedAt: 5, state: 'succeeded', settledAt: 6 })] }));
        expect(hook.getCurrent()?.ready).toBe(true);
        expect(hook.getCurrent()?.phase).toBe('ready');
        expect(onReady).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: batch.selection.repositories[0]!.source }));
        act(() => actionOperationStore.setMachineObservation(query, 'reconnecting'));
        act(() => actionOperationStore.setMachineObservation(query, 'available'));
        expect(onReady).toHaveBeenCalledTimes(1);
        await hook.unmount();
        const reopened = await renderHook(() => useTeamSetupBatchProgress(batch, 'source', onReady));
        expect(reopened.getCurrent()?.ready).toBe(true);
        expect(onReady).toHaveBeenCalledTimes(1);
        await reopened.unmount();
    });
    it('does not announce an old terminal summary when its native full result hydrates', async () => {
        const full = createDeferred<unknown>();
        daemonReply.mockReturnValue(full.promise);
        const batch = selectedBatch();
        const onReady = vi.fn();
        const summary = opening({ requestId: 'selected-request', state: 'succeeded', settledAt: 2 });
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [summary] }));
        const hook = await renderHook(() => useTeamSetupBatchProgress(batch, 'source', onReady));
        expect(hook.getCurrent()?.ready).toBe(false);
        full.resolve({ kind: 'found', operation: { ...summary, result: { ...preparedResult, setup: 'notRequired' } } });
        await vi.waitFor(() => expect(hook.getCurrent()?.ready).toBe(true));
        expect(onReady).not.toHaveBeenCalled();
        await hook.unmount();
    });
    it('does not replay completion received through reconnect', async () => {
        daemonReply.mockReturnValue(new Promise(() => {}));
        const batch = selectedBatch();
        const onReady = vi.fn();
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [opening({ requestId: 'selected-request' })] }));
        const hook = await renderHook(() => useTeamSetupBatchProgress(batch, 'source', onReady));
        act(() => actionOperationStore.setMachineObservation(query, 'reconnecting'));
        expect(hook.getCurrent()?.phase).toBe('unavailable');
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshotComplete: true,
            snapshots: [opening({ requestId: 'selected-request', revision: 2, state: 'succeeded', settledAt: 2,
                result: { ...preparedResult, setup: 'notRequired' } })] }));
        act(() => actionOperationStore.setMachineObservation(query, 'available'));
        expect(hook.getCurrent()?.ready).toBe(true);
        expect(onReady).not.toHaveBeenCalled();
        await hook.unmount();
    });
    it.each([
        { machine: { ok: true as const, result: { kind: 'approval_request_created' as const, artifactId: 'approval', actionId: 'machines.setup.apply' as const } }, phase: 'approval' },
        { machine: null, phase: 'stopped' },
    ])('leaves undispatched selection $phase when its native prerequisite stops the runner', async ({ machine, phase }) => {
        const batch: TeamSetupBatch = { ...selectedBatch(), running: false, settlement: {
            machine, machineSettlement: null, repositories: [],
        } };
        const hook = await renderHook(() => useTeamSetupBatchProgress(batch, 'next'));
        expect(hook.getCurrent()).toMatchObject({ phase, queued: false, ready: false });
        await hook.unmount();
    });
    it('announces a locally dispatched native no-setup completion once, without replay on reopening', async () => {
        daemonReply.mockReturnValue(new Promise(() => {}));
        let batch: TeamSetupBatch | null = null;
        const onReady = vi.fn();
        const hook = await renderHook(() => useTeamSetupBatchProgress(batch, 'source', onReady));
        batch = selectedBatch();
        await hook.rerender();
        batch = { ...batch, running: false, settlement: { machine: null, machineSettlement: null, repositories: [
            { id: 'source', result: { ok: true, result: { ...preparedResult, setup: 'notRequired' } } },
        ] } };
        await hook.rerender();
        expect(hook.getCurrent()).toMatchObject({ phase: 'ready', ready: true });
        expect(onReady).toHaveBeenCalledTimes(1);
        await hook.unmount();
        const reopened = await renderHook(() => useTeamSetupBatchProgress(batch, 'source', onReady));
        expect(reopened.getCurrent()?.ready).toBe(true);
        expect(onReady).toHaveBeenCalledTimes(1);
        await reopened.unmount();
    });
});
describe('Team repository setup progress', () => {
    it('joins only the selected native request on the exact Source and target', async () => {
        const discovery = createDeferred<unknown>();
        daemonReply.mockReturnValue(new Promise(() => {})).mockReturnValueOnce(discovery.promise);
        const selectedQuery = { ...query, requestId: 'selected-request' };
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshotComplete: true,
            snapshots: [opening({ operationId: 'previous-open', requestId: 'previous-request', state: 'succeeded', settledAt: 2,
                result: { kind: 'opened', setup: 'notRequired', directory: '/old',
                    workspace: { serverId: query.serverId, machineId: query.machineId, workspaceId: 'old', rootPath: '/old' } } })] }));
        const hook = await renderHook(() => useTeamSetupRepositoryProgress(selectedQuery, lifetime));
        expect(hook.getCurrent().openOperation).toBeNull();
        await vi.waitFor(() => expect(daemonRequests).toContainEqual(expect.objectContaining({
            method: expect.stringContaining(`${query.machineId}:`),
            params: { requestIdentity: { actionId: 'projects.open', requestId: 'selected-request' } },
        })));
        discovery.resolve({ items: [opening({ operationId: 'selected-open', requestId: 'selected-request', createdAt: 3 })], nextCursor: null });
        await vi.waitFor(() => expect(hook.getCurrent().openOperation?.snapshot.operationId).toBe('selected-open'));
        // The first matching snapshot joins this same observer instead of starting an operation-id reader too.
        await vi.waitFor(() => expect(daemonReply).toHaveBeenCalledTimes(2));
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [
            opening({ operationId: 'concurrent-open', requestId: 'other-request', createdAt: 4 }),
            opening({ operationId: 'wrong-target', requestId: 'selected-request', createdAt: 5,
                scope: { accountId: query.accountId, machineId: 'other-machine' } }),
        ] }));
        expect(hook.getCurrent().openOperation?.snapshot.operationId).toBe('selected-open');
        await hook.unmount();
    });
    it('observes in-flight Open before its checkout exists, then rejoins its full result and pushed setup after navigation', async () => {
        const terminal = createDeferred<unknown>();
        daemonReply.mockReturnValue(terminal.promise);
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [opening()] }));
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useTeamSetupRepositoryProgress(query, lifetime); });
        expect(hook.getCurrent()).toMatchObject({ openOperation: { snapshot: { state: 'running' } }, result: null, setupOperation: null });
        await vi.waitFor(() => expect(daemonReply).toHaveBeenCalledTimes(1));
        const before = renders;
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [
            opening({ operationId: 'foreign-account', createdAt: 20, scope: { accountId: 'other', machineId: 'member-machine' } }),
            opening({ operationId: 'foreign-machine', createdAt: 30, scope: { accountId: 'member', machineId: 'other' } }),
            opening({ operationId: 'foreign-source', createdAt: 40, domainRef: { kind: 'projectOpen', sourceId: 'other' } }),
        ] }));
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'other-home', snapshots: [opening({ createdAt: 50 })] }));
        expect(renders).toBe(before);
        await hook.unmount();
        const summary = opening({ revision: 2, state: 'succeeded', settledAt: 10 });
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [summary] }));
        const opened = OpenProjectResultV1Schema.parse({ kind: 'opened', setup: 'prepared', directory: '/repo',
            workspace: { serverId: query.serverId, machineId: 'member-machine', workspaceId: 'repo', rootPath: '/repo' } });
        daemonReply.mockResolvedValue({ kind: 'found', operation: { ...summary, result: opened } });
        const reopened = await renderHook(() => useTeamSetupRepositoryProgress(query, lifetime));
        await vi.waitFor(() => expect(reopened.getCurrent().result).toEqual(opened));
        const setup = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'setup', revision: 1,
            actionId: 'projects.prepare', state: 'running', scope: { accountId: 'member', machineId: 'member-machine' },
            title: 'Prepare', createdAt: 11, startedAt: 11, cancellation: 'supported',
            domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: query.serverId, machineId: 'member-machine',
                workspaceRefId: 'repo', cwd: '/repo', sourceWorkspace: opened.kind === 'opened' && 'machineId' in opened.workspace ? opened.workspace : undefined } });
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [setup] }));
        expect(reopened.getCurrent().setupOperation?.snapshot.state).toBe('running');
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshots: [{ ...setup, revision: 2,
            state: 'failed', settledAt: 12, error: { errorCode: 'setup_exit_nonzero', error: 'Setup failed' } }] }));
        expect(reopened.getCurrent().setupOperation?.snapshot).toMatchObject({ state: 'failed', error: { errorCode: 'setup_exit_nonzero' } });
        expect(reopened.getCurrent().result).toEqual(opened);
        await reopened.unmount();
    });
    it.each([
        { kind: 'refused', code: 'destination_exists', effectAttempted: false },
        { kind: 'outcomeUnknown', operationId: 'open' },
        { kind: 'opened', setup: 'failed', directory: '/repo', workspace: { serverId: query.serverId, machineId: 'member-machine', workspaceId: 'repo', rootPath: '/repo' } },
    ])('preserves the canonical $kind result without inventing readiness', async value => {
        const result = OpenProjectResultV1Schema.parse({ ...value,
            ...('workspace' in value ? { workspace: { ...value.workspace, serverId: query.serverId } } : {}) });
        daemonReply.mockReturnValue(new Promise(() => {}));
        const outcome = result.kind === 'refused'
            ? { state: 'failed' as const, settledAt: 2, error: { errorCode: result.code, error: result.code } }
            : result.kind === 'outcomeUnknown'
                ? { observation: { kind: 'outcome_uncertain' as const, code: 'action_outcome_unknown' } }
                : { state: 'succeeded' as const, settledAt: 2 };
        act(() => actionOperationStore.mergeSnapshots({ serverId: query.serverId, snapshotComplete: true,
            snapshots: [opening({ ...outcome, result })] }));
        const hook = await renderHook(() => useTeamSetupRepositoryProgress(query, lifetime));
        expect(hook.getCurrent()).toMatchObject({ result, setupOperation: null });
        await hook.unmount();
    });
});

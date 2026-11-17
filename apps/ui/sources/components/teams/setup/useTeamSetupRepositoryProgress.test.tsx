import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ActionOperationSnapshotV1Schema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
const operationRpc = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());
// Only the Machine transport is replaced; owner reading, subscriptions and selectors stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: operationRpc }));
const { useTeamSetupRepositoryProgress } = await import('./useTeamSetupRepositoryProgress');
await import('@/sync/domains/actionOperations/observeActionOperationByRequestId');
afterEach(() => { standardCleanup(); actionOperationStore.reset(); operationRpc.mockReset(); });
const query = { serverId: 'team-home', accountId: 'member', machineId: 'member-machine', sourceId: 'source' };
const lifetime: ServerAccountScopeLifetime = { scope: { serverId: 'team-home', accountId: 'member' },
    isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
function opening(overrides: Partial<ActionOperationSnapshotV1> = {}): ActionOperationSnapshotV1 {
    const createdAt = overrides.createdAt ?? 1;
    return ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'open', revision: 1, actionId: 'projects.open', state: 'running',
        scope: { accountId: 'member', machineId: 'member-machine' }, title: 'Open', createdAt, startedAt: createdAt,
        cancellation: 'unsupported', domainRef: { kind: 'projectOpen', sourceId: 'source' }, ...overrides });
}
describe('Team repository setup progress', () => {
    it('observes in-flight Open before its checkout exists, then rejoins its full result and pushed setup after navigation', async () => {
        const terminal = createDeferred<unknown>();
        operationRpc.mockReturnValue(terminal.promise);
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'team-home', snapshots: [opening()] }));
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useTeamSetupRepositoryProgress(query, lifetime); });
        expect(hook.getCurrent()).toMatchObject({ openOperation: { snapshot: { state: 'running' } }, result: null, setupOperation: null });
        await vi.waitFor(() => expect(operationRpc).toHaveBeenCalledTimes(1));
        const before = renders;
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'team-home', snapshots: [
            opening({ operationId: 'foreign-account', createdAt: 20, scope: { accountId: 'other', machineId: 'member-machine' } }),
            opening({ operationId: 'foreign-machine', createdAt: 30, scope: { accountId: 'member', machineId: 'other' } }),
            opening({ operationId: 'foreign-source', createdAt: 40, domainRef: { kind: 'projectOpen', sourceId: 'other' } }),
        ] }));
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'other-home', snapshots: [opening({ createdAt: 50 })] }));
        expect(renders).toBe(before);
        await hook.unmount();
        const summary = opening({ revision: 2, state: 'succeeded', settledAt: 10 });
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'team-home', snapshots: [summary] }));
        const opened = OpenProjectResultV1Schema.parse({ kind: 'opened', setup: 'prepared', directory: '/repo',
            workspace: { serverId: 'team-home', machineId: 'member-machine', workspaceId: 'repo', rootPath: '/repo' } });
        operationRpc.mockResolvedValue({ kind: 'found', operation: { ...summary, result: opened } });
        const reopened = await renderHook(() => useTeamSetupRepositoryProgress(query, lifetime));
        await vi.waitFor(() => expect(reopened.getCurrent().result).toEqual(opened));
        const setup: ActionOperationSnapshotV1 = { version: 1, operationId: 'setup', revision: 1,
            actionId: 'projects.prepare', state: 'running', scope: { accountId: 'member', machineId: 'member-machine' },
            title: 'Prepare', createdAt: 11, startedAt: 11, cancellation: 'supported',
            domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: 'team-home', machineId: 'member-machine',
                workspaceRefId: 'repo', cwd: '/repo', sourceWorkspace: opened.kind === 'opened' && 'machineId' in opened.workspace ? opened.workspace : undefined } };
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'team-home', snapshots: [setup] }));
        expect(reopened.getCurrent().setupOperation?.snapshot.state).toBe('running');
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'team-home', snapshots: [{ ...setup, revision: 2,
            state: 'failed', settledAt: 12, error: { errorCode: 'setup_exit_nonzero', error: 'Setup failed' } }] }));
        expect(reopened.getCurrent().setupOperation?.snapshot).toMatchObject({ state: 'failed', error: { errorCode: 'setup_exit_nonzero' } });
        expect(reopened.getCurrent().result).toEqual(opened);
        await reopened.unmount();
    });
    it.each([
        { kind: 'refused', code: 'destination_exists', effectAttempted: false },
        { kind: 'outcomeUnknown', operationId: 'open' },
        { kind: 'opened', setup: 'failed', directory: '/repo', workspace: { serverId: 'team-home', machineId: 'member-machine', workspaceId: 'repo', rootPath: '/repo' } },
    ])('preserves the canonical $kind result without inventing readiness', async value => {
        const result = OpenProjectResultV1Schema.parse(value);
        operationRpc.mockReturnValue(new Promise(() => {}));
        const outcome = result.kind === 'refused'
            ? { state: 'failed' as const, settledAt: 2, error: { errorCode: result.code, error: result.code } }
            : result.kind === 'outcomeUnknown'
                ? { observation: { kind: 'outcome_uncertain' as const, code: 'action_outcome_unknown' } }
                : { state: 'succeeded' as const, settledAt: 2 };
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'team-home', snapshotComplete: true,
            snapshots: [opening({ ...outcome, result })] }));
        const hook = await renderHook(() => useTeamSetupRepositoryProgress(query, lifetime));
        expect(hook.getCurrent()).toMatchObject({ result, setupOperation: null });
        await hook.unmount();
    });
});

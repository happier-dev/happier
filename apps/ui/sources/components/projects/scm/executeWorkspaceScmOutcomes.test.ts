import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN, type ScmOperationOutcome, type ScmRemoteResponse } from '@happier-dev/protocol/scm';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { EMPTY_SCM_CAPABILITIES } from '@/scm/core/snapshotMappers';
import type { machineScmCommitCreate, machineScmCommitUndoLast } from '@/sync/ops/scm/machineScm';
import { Modal } from '@/modal';

const { commit, undo, push, removeIndexLock } = vi.hoisted(() => ({
    commit: vi.fn<typeof machineScmCommitCreate>(),
    undo: vi.fn<typeof machineScmCommitUndoLast>(),
    push: vi.fn<() => Promise<ScmRemoteResponse>>(),
    removeIndexLock: vi.fn(async () => ({ success: true, removed: true, lockPath: '/repo/.git/index.lock' })),
}));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});
// Machine RPC is the system boundary; storage, projectManager and internal SCM logic stay real.
vi.mock('@/sync/ops/scm/machineScm', () => ({ machineScmCommitCreate: commit, machineScmCommitUndoLast: undo, machineScmRemotePush: push, machineScmRepositoryRemoveIndexLock: removeIndexLock }));

import { storage } from '@/sync/domains/state/storage';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { selectScmWriteOperation } from '@/scm/operations/selectScmWriteOperation';
import { executeWorkspaceScmCommit, executeWorkspaceScmCommitUndoLast } from './executeWorkspaceScmCommit';
import { executeWorkspaceScmRemoteOperation } from './executeWorkspaceScmRemoteOperation';
import { runWorkspaceScmMutation } from '@/scm/operations/runSessionScmMutation';

const scope = { serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo' };
const snapshot = {
    projectKey: 'server-1:machine-1:/repo', fetchedAt: 1,
    repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
    capabilities: { ...EMPTY_SCM_CAPABILITIES, writeRemotePush: true },
    branch: { head: 'main', upstream: 'origin/main', ahead: 1, behind: 0, detached: false },
    hasConflicts: false, entries: [],
    totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
} satisfies ScmWorkingSnapshot;
const input = () => ({
    scope, commitMessage: 'Commit message', scmCommitStrategy: 'atomic' as const,
    commitSelectionPaths: ['a.ts'], commitSelectionPatches: [],
    refreshScmData: vi.fn(async () => {}), setScmOperationBusy: vi.fn(), setScmOperationStatus: vi.fn(), tracking: null,
});
const pushInput = () => ({
    ...input(), kind: 'push' as const, scmSnapshot: snapshot, scmWriteEnabled: true,
    scmRemoteConfirmPolicy: 'never' as const, scmPushRejectPolicy: 'prompt_fetch' as const,
});
const outcomeLine = () => selectScmWriteOperation({
    inFlight: storage.getState().getWorkspaceScmInFlightOperation(scope),
    log: storage.getState().getWorkspaceScmOperationLog(scope), machineReachable: true,
});

describe('workspace SCM public write outcomes', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        projectManager.clear();
        commit.mockReset().mockResolvedValue({ success: true, commitSha: 'commit-1' });
        undo.mockReset().mockResolvedValue({ success: true, undoneCommitSha: 'a'.repeat(40), headOid: 'b'.repeat(40), outcome: {
            v: 1, kind: 'succeeded', effect: { kind: 'branch', name: 'HEAD', headOid: 'b'.repeat(40) }, repositoryState: { headOid: 'b'.repeat(40), hasConflicts: false, operation: null }, nextActions: [{ kind: 'refresh' }],
        } });
        push.mockReset().mockResolvedValue({ success: true });
        removeIndexLock.mockClear();
        vi.mocked(Modal.alert).mockClear();
        storage.getState().markWorkspaceScmCommitSelectionPaths(scope, ['a.ts']);
        storage.getState().updateWorkspaceScmSnapshotError(scope, null);
    });
    it('passes the captured server scope to a successful commit and clears real selection', async () => {
        const request = input();
        request.commitSelectionPaths = [];
        expect(await executeWorkspaceScmCommit(request)).toEqual({ ok: true });
        expect(commit).toHaveBeenCalledWith('machine-1', { cwd: '/repo', message: 'Commit message', scope: { kind: 'all-pending' } }, { serverId: 'server-1' });
        expect(storage.getState().getWorkspaceScmCommitSelectionPaths(scope)).toEqual([]);
    });
    it('undoes exactly the displayed workspace commit through the canonical lock and leaves selection staged', async () => {
        const request = { scope, expectedHeadOid: 'a'.repeat(40), refreshScmData: vi.fn(async () => {}) };
        await executeWorkspaceScmCommitUndoLast(request);
        expect(undo).toHaveBeenCalledWith('machine-1', { cwd: '/repo', expectedHeadOid: 'a'.repeat(40) }, { serverId: 'server-1' });
        expect(outcomeLine()).toMatchObject({ phase: 'succeeded', action: 'commit_undo', outcome: { repositoryState: { headOid: 'b'.repeat(40) } } });
        expect(storage.getState().getWorkspaceScmCommitSelectionPaths(scope)).toEqual(['a.ts']);
        expect(request.refreshScmData).toHaveBeenCalled();
        expect(storage.getState().getWorkspaceScmInFlightOperation(scope)).toBeNull();
    });
    it('preserves an undo refusal and refreshes neither repository nor selection', async () => {
        const outcome: ScmOperationOutcome = { v: 1, kind: 'needs_input', errorCode: 'COMMIT_UNDO_HEAD_CHANGED', nextActions: [{ kind: 'refresh' }] };
        undo.mockResolvedValue({ success: false, outcome });
        const request = { scope, expectedHeadOid: 'a'.repeat(40), refreshScmData: vi.fn(async () => {}) };
        await executeWorkspaceScmCommitUndoLast(request);
        expect(outcomeLine()).toMatchObject({ phase: 'needs_input', action: 'commit_undo', outcome });
        expect(request.refreshScmData).not.toHaveBeenCalled();
        expect(storage.getState().getWorkspaceScmCommitSelectionPaths(scope)).toEqual(['a.ts']);
    });
    it('keeps an applied undo visible when the snapshot controller retains a refresh failure', async () => {
        await executeWorkspaceScmCommitUndoLast({
            scope, expectedHeadOid: 'a'.repeat(40),
            refreshScmData: async () => {
                storage.getState().updateWorkspaceScmSnapshotError(scope, { message: 'status unavailable', at: 1 });
            },
        });
        expect(outcomeLine()).toMatchObject({
            phase: 'effect_applied_with_warning', action: 'commit_undo',
            outcome: { errorCode: 'REPOSITORY_REFRESH_FAILED', effect: { kind: 'branch', name: 'HEAD', headOid: 'b'.repeat(40) }, nextActions: [{ kind: 'refresh' }] },
        });
        expect(storage.getState().getWorkspaceScmCommitSelectionPaths(scope)).toEqual(['a.ts']);
    });
    it('offers stale index-lock recovery and retries the same scoped push', async () => {
        push.mockResolvedValueOnce({ success: false, errorCode: 'COMMAND_FAILED', error: "fatal: Unable to create '/repo/.git/index.lock': File exists." });
        await executeWorkspaceScmRemoteOperation(pushInput());
        expect(removeIndexLock).toHaveBeenCalledWith('machine-1', { cwd: '/repo', confirmed: true, confirmationToken: REMOVE_INDEX_LOCK_CONFIRMATION_TOKEN }, { serverId: 'server-1' });
        expect(push).toHaveBeenCalledTimes(2);
        expect(push).toHaveBeenCalledWith('machine-1', { cwd: '/repo', remote: 'origin', branch: 'main' }, { serverId: 'server-1' });
        expect(outcomeLine()).toMatchObject({ phase: 'succeeded' });
    });
    it('keeps a commit warning authoritative over the legacy success bit and retires its landed selection', async () => {
        const outcome: ScmOperationOutcome = { v: 1, kind: 'effect_applied_with_warning', errorCode: 'INDEX_RECONCILIATION_FAILED', effect: { kind: 'commit', commitSha: 'commit-1' }, nextActions: [{ kind: 'reconcile_index' }] };
        commit.mockResolvedValue({ success: true, commitSha: 'commit-1', outcome });
        expect(await executeWorkspaceScmCommit(input())).toEqual({ ok: false });
        expect(outcomeLine()).toMatchObject({ phase: outcome.kind, outcome });
        expect(storage.getState().getWorkspaceScmCommitSelectionPaths(scope)).toEqual([]);
        expect(Modal.alert).not.toHaveBeenCalled();
    });
    it('shows a published candidate without the legacy SHA and only refreshes the repository', async () => {
        const candidateOid = 'b'.repeat(40);
        commit.mockResolvedValue({ success: false, errorCode: 'INDEX_RECONCILIATION_FAILED', publication: { state: 'published', candidateOid, expectedHeadOid: 'a'.repeat(40), expectedRef: 'refs/heads/main', indexReconciliation: 'failed' } });
        const request = input();
        expect(await executeWorkspaceScmCommit(request)).toEqual({ ok: false });
        expect(outcomeLine()).toMatchObject({ phase: 'effect_applied_with_warning', result: { sha: candidateOid } });
        expect(request.refreshScmData).toHaveBeenCalledTimes(1);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(storage.getState().getWorkspaceScmCommitSelectionPaths(scope)).toEqual([]);
    });
    it('records transport loss as unknown and keeps commit selection', async () => {
        commit.mockRejectedValue(new Error('socket closed'));
        expect(await executeWorkspaceScmCommit(input())).toEqual({ ok: false });
        expect(outcomeLine()).toMatchObject({ phase: 'outcome_unknown', outcome: { reconciliation: { kind: 'repository_status', cwd: '/repo' }, nextActions: [{ kind: 'refresh' }] } });
        expect(storage.getState().getWorkspaceScmCommitSelectionPaths(scope)).toEqual(['a.ts']);
    });
    it('retains the successful commit and reports the applied effect when refresh fails', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1);
        commit.mockResolvedValue({ success: true, outcome: { v: 1, kind: 'succeeded', effect: { kind: 'commit', commitSha: 'commit-1' }, nextActions: [] } });
        const request = input();
        request.refreshScmData.mockRejectedValue(new Error('status unavailable'));
        expect(await executeWorkspaceScmCommit(request)).toEqual({ ok: true });
        expect(outcomeLine()).toMatchObject({ phase: 'effect_applied_with_warning', outcome: { errorCode: 'REPOSITORY_REFRESH_FAILED', effect: { kind: 'commit', commitSha: 'commit-1' }, nextActions: [{ kind: 'refresh' }] } });
        expect(storage.getState().getWorkspaceScmCommitSelectionPaths(scope)).toEqual([]);
        expect(Modal.alert).not.toHaveBeenCalled();
    });
    it('keeps remote warnings and their exact recovery actions', async () => {
        const outcome: ScmOperationOutcome = { v: 1, kind: 'effect_applied_with_warning', errorCode: 'REPOSITORY_REFRESH_FAILED', effect: { kind: 'remote', remote: 'origin', branch: 'main' }, nextActions: [{ kind: 'refresh' }] };
        push.mockResolvedValue({ success: false, outcome });
        await executeWorkspaceScmRemoteOperation(pushInput());
        expect(outcomeLine()).toMatchObject({ phase: outcome.kind, outcome });
    });
    it('uses the observed upstream identity for a workspace force-with-lease push and preserves typed rejection', async () => {
        const outcome: ScmOperationOutcome = { v: 1, kind: 'needs_input', errorCode: 'REMOTE_REJECTED', nextActions: [{ kind: 'refresh' }] };
        push.mockResolvedValue({ success: false, outcome });
        await executeWorkspaceScmRemoteOperation({
            ...pushInput(),
            scmSnapshot: {
                ...snapshot,
                capabilities: { ...snapshot.capabilities, writeRemotePolicies: true, writeRemoteForceWithLease: true },
                branch: { ...snapshot.branch, upstreamOid: 'a'.repeat(40) },
            },
            policy: { pushMode: 'force_with_lease', expectedRemoteOid: 'a'.repeat(40) },
        });
        expect(push).toHaveBeenCalledWith('machine-1', {
            cwd: '/repo', remote: 'origin', branch: 'main',
            pushMode: 'force_with_lease', expectedRemoteOid: 'a'.repeat(40),
        }, { serverId: 'server-1' });
        expect(outcomeLine()).toMatchObject({ phase: 'needs_input', outcome });
        expect(Modal.alert).not.toHaveBeenCalled();
    });
    it('keeps an unknown push result and its remote reconciliation target', async () => {
        push.mockRejectedValue(new Error('socket closed'));
        await executeWorkspaceScmRemoteOperation(pushInput());
        expect(outcomeLine()).toMatchObject({ phase: 'outcome_unknown', outcome: { reconciliation: { kind: 'remote_ref', remote: 'origin', branch: 'main' }, nextActions: [{ kind: 'refresh' }] } });
    });
    it('keeps an applied remote effect when refresh fails', async () => {
        const request = pushInput();
        request.refreshScmData.mockRejectedValue(new Error('status unavailable'));
        await executeWorkspaceScmRemoteOperation(request);
        expect(outcomeLine()).toMatchObject({ phase: 'effect_applied_with_warning', outcome: { errorCode: 'REPOSITORY_REFRESH_FAILED', effect: { kind: 'remote', remote: 'origin', branch: 'main' }, nextActions: [{ kind: 'refresh' }] } });
    });
    it('records workspace branch warnings through the same mutation owner as sessions without replaying applied effects', async () => {
        const outcome: ScmOperationOutcome = { v: 1, kind: 'effect_applied_with_warning', errorCode: 'INDEX_RECONCILIATION_FAILED', effect: { kind: 'branch', name: 'feature' }, nextActions: [{ kind: 'reconcile_index' }] };
        const run = vi.fn(async () => ({ success: false, outcome, error: "Unable to create '/repo/.git/index.lock': File exists" }));
        const result = await runWorkspaceScmMutation({ state: storage.getState(), scope, cwd: '/repo', operation: 'branch_merge', fallbackError: 'Merge failed', run });
        expect(result.started).toBe(true);
        expect(outcomeLine()).toMatchObject({ phase: outcome.kind, outcome });
        expect(run).toHaveBeenCalledTimes(1);
    });
    it('classifies a missing branch result as unknown and releases the real workspace lock', async () => {
        await runWorkspaceScmMutation({ state: storage.getState(), scope, cwd: '/repo', operation: 'branch_merge', fallbackError: 'Merge failed', run: async () => { throw new Error('socket closed'); } });
        expect(outcomeLine()).toMatchObject({ phase: 'outcome_unknown', outcome: { reconciliation: { kind: 'repository_status', cwd: '/repo' }, nextActions: [{ kind: 'refresh' }] } });
        expect(storage.getState().getWorkspaceScmInFlightOperation(scope)).toBeNull();
    });
    it('leaves an existing operation and its busy presentation intact when the workspace lock denies another write', async () => {
        const held = storage.getState().beginWorkspaceScmOperation(scope, 'push');
        const run = vi.fn(async () => ({ success: true }));
        const setScmOperationBusy = vi.fn();
        const result = await runWorkspaceScmMutation({ state: storage.getState(), scope, cwd: '/repo', operation: 'branch_merge', fallbackError: 'Merge failed', run, setScmOperationBusy });
        expect(result.started).toBe(false);
        expect(run).not.toHaveBeenCalled();
        expect(setScmOperationBusy).not.toHaveBeenCalled();
        expect(storage.getState().getWorkspaceScmInFlightOperation(scope)).toEqual(held.started ? held.operation : null);
    });
});

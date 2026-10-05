import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderHook } from '@/dev/testkit';
import { EMPTY_SCM_CAPABILITIES } from '@/scm/core/snapshotMappers';

// System boundaries only: the machine RPCs and the modal. The operation lock, log and store are real.
const { confirm, rpc } = vi.hoisted(() => ({
    confirm: vi.fn(async () => true),
    rpc: {
        sessionScmCommitUndoLast: vi.fn(),
        sessionScmRemoteAdd: vi.fn(),
        sessionScmBranchMerge: vi.fn(),
        sessionScmBranchOperationSkip: vi.fn(),
        sessionScmRepositoryRemoveIndexLock: vi.fn(),
        sessionScmStatusSnapshot: vi.fn(),
    },
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/sync/ops/sessions', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({ importOriginal, overrides: {
        sessionScmCommitUndoLast: (...args: unknown[]) => rpc.sessionScmCommitUndoLast(...args),
        sessionScmRemoteAdd: (...args: unknown[]) => rpc.sessionScmRemoteAdd(...args),
        sessionScmBranchMerge: (...args: unknown[]) => rpc.sessionScmBranchMerge(...args),
        sessionScmBranchOperationSkip: (...args: unknown[]) => rpc.sessionScmBranchOperationSkip(...args),
        sessionScmRepositoryRemoveIndexLock: (...args: unknown[]) => rpc.sessionScmRepositoryRemoveIndexLock(...args),
        sessionScmStatusSnapshot: (...args: unknown[]) => rpc.sessionScmStatusSnapshot(...args),
    } });
});

// Unrelated key-envelope HTTP API must never be called by repository mutation tests.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unexpected = () => { throw new Error('Unexpected session key-envelope HTTP request in Git'); };
    return { createSessionDataKeyEnvelopeClient: unexpected, readSessionDataKeyEnvelopeCollectionPage: unexpected,
        prepareSessionDataKeyEnvelopesForScope: unexpected, prepareSessionDataKeyEnvelopesDetached: unexpected };
});
vi.mock('@/sync/ops/sessionScm', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({ importOriginal, overrides: {
        sessionScmRepositoryRemoveIndexLock: (...args: unknown[]) => rpc.sessionScmRepositoryRemoveIndexLock(...args),
        sessionScmStatusSnapshot: (...args: unknown[]) => rpc.sessionScmStatusSnapshot(...args),
    } });
});

const { storage } = await import('@/sync/domains/state/storage');
const { projectManager } = await import('@/sync/runtime/orchestration/projectManager');
const { useSessionGitRepositoryMutations } = await import('./useSessionGitRepositoryMutations');

async function mutations(refreshAfterUndo?: () => Promise<void>) {
    const hook = await renderHook(() => useSessionGitRepositoryMutations({ sessionId: 's1', sessionPath: '/tmp/repo', refreshAfterUndo }));
    return hook.getCurrent();
}

describe('useSessionGitRepositoryMutations', () => {
    beforeEach(() => {
        storage.setState(storage.getInitialState(), true);
        projectManager.clear();
        storage.getState().applySessions([createSessionFixture({ id: 's1', active: true, metadata: { path: '/tmp/repo', host: 'localhost', machineId: 'machine-1' } })]);
        rpc.sessionScmRemoteAdd.mockReset().mockResolvedValue({ success: true });
        rpc.sessionScmCommitUndoLast.mockReset().mockResolvedValue({ success: true, outcome: { v: 1, kind: 'succeeded', nextActions: [] } });
        rpc.sessionScmBranchMerge.mockReset().mockResolvedValue({ success: true, stdout: 'merged' });
        rpc.sessionScmBranchOperationSkip.mockReset().mockResolvedValue({ success: true, outcome: { v: 1, kind: 'succeeded', nextActions: [] } });
        rpc.sessionScmRepositoryRemoveIndexLock.mockReset();
        rpc.sessionScmStatusSnapshot.mockReset().mockResolvedValue({ success: true, snapshot: {
            projectKey: 'machine-1:/tmp/repo', fetchedAt: 1,
            repo: { isRepo: true, rootPath: '/tmp/repo', backendId: 'git', mode: '.git' },
            capabilities: EMPTY_SCM_CAPABILITIES,
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
            hasConflicts: false, entries: [],
            totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
        } });
        confirm.mockClear();
    });

    it('undoes the observed commit under the same project lock and retains typed unsafe-head refusals', async () => {
        const owner = await mutations();
        const expectedHeadOid = 'a'.repeat(40);
        const refusal = { success: false, errorCode: 'COMMIT_UNDO_PUBLISHED', outcome: { v: 1, kind: 'needs_input', errorCode: 'COMMIT_UNDO_PUBLISHED', nextActions: [] } };
        rpc.sessionScmCommitUndoLast.mockImplementationOnce(async () => {
            expect(storage.getState().getSessionProjectScmInFlightOperation('s1')).toMatchObject({ operation: 'commit_undo' });
            return refusal;
        });
        expect(await owner.undoLastCommit(expectedHeadOid)).toEqual(refusal);
        expect(rpc.sessionScmCommitUndoLast).toHaveBeenCalledWith('s1', { expectedHeadOid }, undefined);
        expect(storage.getState().getSessionProjectScmOperationLog('s1')).toEqual(expect.arrayContaining([
            expect.objectContaining({ operation: 'commit_undo', outcome: expect.objectContaining({ kind: 'needs_input', errorCode: 'COMMIT_UNDO_PUBLISHED' }) }),
        ]));
        expect(storage.getState().getSessionProjectScmInFlightOperation('s1')).toBeNull();
    });

    it('keeps undo applied when the refresh resolves with a stored repository error', async () => {
        const effect = { kind: 'branch', name: 'HEAD', headOid: 'b'.repeat(40) };
        rpc.sessionScmCommitUndoLast.mockResolvedValueOnce({ success: true, outcome: { v: 1, kind: 'succeeded', effect, nextActions: [] } });
        const owner = await mutations(async () => {
            storage.getState().updateSessionProjectScmSnapshotError('s1', { message: 'Machine unavailable', at: Date.now(), errorCode: 'BACKEND_UNAVAILABLE' });
        });
        await owner.undoLastCommit('a'.repeat(40));
        expect(storage.getState().getSessionProjectScmOperationLog('s1')[0]).toMatchObject({
            operation: 'commit_undo', outcome: { kind: 'effect_applied_with_warning', effect, errorCode: 'REPOSITORY_REFRESH_FAILED' },
        });
        expect(rpc.sessionScmCommitUndoLast).toHaveBeenCalledTimes(1);
    });

    it('holds the project operation lock before remote add reaches the machine and rejects a competing write', async () => {
        const held = storage.getState().beginSessionProjectScmOperation('s1', 'push');
        expect(held.started).toBe(true);
        if (!held.started) throw new Error('Fixture could not acquire the project lock');

        const owner = await mutations();
        const blocked = await owner.addRemote({ name: 'origin', fetchUrl: 'git@example.com:repo.git' });

        expect(rpc.sessionScmRemoteAdd).not.toHaveBeenCalled();
        expect(blocked.success).toBe(false);
        storage.getState().finishSessionProjectScmOperation('s1', held.operation.id);
        let operationDuringRpc: unknown;
        let competingWriteStarted: boolean | undefined;
        rpc.sessionScmRemoteAdd.mockImplementationOnce(async () => {
            operationDuringRpc = storage.getState().getSessionProjectScmInFlightOperation('s1');
            competingWriteStarted = storage.getState().beginSessionProjectScmOperation('s1', 'push').started;
            return { success: true };
        });

        const response = await owner.addRemote({ name: 'origin', fetchUrl: 'git@example.com:repo.git' });

        expect(response.success).toBe(true);
        expect(operationDuringRpc).toMatchObject({ operation: 'remote_add' });
        expect(competingWriteStarted).toBe(false);
        expect(storage.getState().getSessionProjectScmInFlightOperation('s1')).toBeNull();
    });

    it('reports a merge to the operation log the pane outcome line reads, and releases the lock', async () => {
        const response = await (await mutations()).mergeBranch('feature/review');

        expect(response).toEqual({ success: true, stdout: 'merged', outcome: { v: 1, kind: 'succeeded', nextActions: [] } });
        expect(storage.getState().getSessionProjectScmOperationLog('s1')).toEqual(expect.arrayContaining([
            expect.objectContaining({ operation: 'branch_merge', status: 'success' }),
        ]));
        expect(storage.getState().getSessionProjectScmInFlightOperation('s1')).toBeNull();
    });

    it('recovers a stale index lock once (confirmed) and retries the write exactly once', async () => {
        rpc.sessionScmRemoteAdd
            .mockResolvedValueOnce({ success: false, errorCode: 'COMMAND_FAILED', error: "fatal: Unable to create '/tmp/repo/.git/index.lock': File exists." })
            .mockResolvedValueOnce({ success: true });
        rpc.sessionScmRepositoryRemoveIndexLock.mockResolvedValueOnce({ success: true, removed: true, lockPath: '/tmp/repo/.git/index.lock' });

        const response = await (await mutations()).addRemote({ name: 'origin', fetchUrl: 'git@example.com:repo.git' });

        expect(confirm).toHaveBeenCalledTimes(1);
        expect(rpc.sessionScmRepositoryRemoveIndexLock).toHaveBeenCalledWith('s1', expect.objectContaining({ cwd: '/tmp/repo', confirmed: true }), undefined);
        expect(rpc.sessionScmRemoteAdd).toHaveBeenCalledTimes(2);
        expect(response).toEqual({ success: true, outcome: { v: 1, kind: 'succeeded', nextActions: [] } });
    });

    it('records skipping a replayed commit with its canonical outcome and releases the operation lock', async () => {
        const response = await (await mutations()).skipBranchOperation('cherry_pick');

        expect(response).toMatchObject({ success: true, outcome: { kind: 'succeeded' } });
        expect(rpc.sessionScmBranchOperationSkip).toHaveBeenCalledWith('s1', { operation: 'cherry_pick' }, undefined);
        expect(storage.getState().getSessionProjectScmOperationLog('s1')).toEqual(expect.arrayContaining([
            expect.objectContaining({ operation: 'branch_operation_skip', status: 'success', outcome: { v: 1, kind: 'succeeded', nextActions: [] } }),
        ]));
        expect(storage.getState().getSessionProjectScmInFlightOperation('s1')).toBeNull();
    });
});

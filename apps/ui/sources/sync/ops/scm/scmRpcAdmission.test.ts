import { describe, expect, it, vi } from 'vitest';
import { createScmCapabilities, ScmStatusSnapshotResponseSchema, type ScmStatusSnapshotTransportResponse } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { runScmRpcWithAdmission } from './scmRpcAdmission';
import { snapshotToScmStatusFiles } from '@/scm/scmStatusFiles';
import { mapProtocolSnapshotToUiSnapshot } from '@/scm/core/snapshotMappers';

describe('SCM producer policy admission', () => {
    it('preserves a typed transport refusal from the shared describe read', async () => {
        const refusal = { ok: false as const, errorCode: 'permission_denied', error: 'Permission denied',
            details: { reason: 'machine_access_denied' } };
        expect(await runScmRpcWithAdmission({ method: RPC_METHODS.SCM_BACKEND_DESCRIBE, request: { cwd: '/repo' },
            describeScope: 'account:machine:refused-repo', call: async () => refusal })).toEqual(refusal);
    });

    it('normalizes compact status facts before Git pane and file consumers receive them', async () => {
        const wire = { success: true, snapshot: {
                projectKey: 'machine:/repo', fetchedAt: 1,
                repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', worktrees: [], remotes: [] },
                capabilities: createScmCapabilities(),
                branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
                hasConflicts: false,
                hostingProvider: { id: 'scm.github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                pullRequestStatus: {
                    provider: { id: 'scm.github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    headBranch: 'feature', baseBranch: 'main', openPullRequest: null,
                },
                entries: [
                    { path: 'new.txt', kind: 'untracked', includeStatus: '?', pendingStatus: '?', hasPendingDelta: true, stats: { pendingAdded: 2, isComplete: false } },
                    { path: 'renamed.txt', previousPath: 'old.txt', kind: 'renamed', includeStatus: 'R', pendingStatus: '.', hasIncludedDelta: true },
                    { path: 'binary.bin', kind: 'modified', includeStatus: '.', pendingStatus: 'M', hasPendingDelta: true, stats: { isBinary: true, isComplete: false } },
                    { path: 'both.txt', kind: 'modified', includeStatus: 'M', pendingStatus: 'M', hasIncludedDelta: true, hasPendingDelta: true, stats: { includedAdded: 3, includedRemoved: 4, pendingAdded: 5, pendingRemoved: 6, isComplete: true } },
                ],
                totals: { includedFiles: 0, pendingFiles: 1, untrackedFiles: 1, includedAdded: 0, includedRemoved: 0, pendingAdded: 2, pendingRemoved: 0, isComplete: false },
            } };
        const response = await runScmRpcWithAdmission<ScmStatusSnapshotTransportResponse>({
            method: RPC_METHODS.SCM_STATUS_SNAPSHOT, request: {},
            // RPC is the boundary; the existing UI mapper restores presentation defaults.
            call: async () => wire,
        });
        expect(response).toBe(wire);
        if (!('success' in response) || !response.success || !('snapshot' in response) || !response.snapshot) throw new Error('Expected status snapshot');
        const mapped = mapProtocolSnapshotToUiSnapshot(response.snapshot, 'machine:/repo');
        expect(mapped.entries).toEqual(ScmStatusSnapshotResponseSchema.parse(wire).snapshot?.entries);
        expect(mapped.hostingProvider).toMatchObject({ urlSafety: { allowedSchemes: ['https:'] } });
        expect(mapped.pullRequestStatus?.provider).toMatchObject({ urlSafety: { allowedSchemes: ['https:'] } });
        expect(wire.snapshot.hostingProvider).not.toHaveProperty('urlSafety');
        expect(mapped.entries[0]).toEqual({
            path: 'new.txt', previousPath: null, kind: 'untracked', includeStatus: '?', pendingStatus: '?', hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 2, pendingRemoved: 0, isBinary: false, isComplete: false },
        });
        expect(response.snapshot?.totals.isComplete).toBe(false);
        const files = snapshotToScmStatusFiles(mapped);
        expect(files.includedFiles).toMatchObject([{ fullPath: 'renamed.txt' }, { fullPath: 'both.txt', linesAdded: 3, linesRemoved: 4 }]);
        expect(files.pendingFiles).toMatchObject([
            { fullPath: 'new.txt', linesAdded: 2, linesRemoved: 0, isBinary: false, isComplete: false },
            { fullPath: 'binary.bin', linesAdded: 0, linesRemoved: 0, isBinary: true, isComplete: false },
            { fullPath: 'both.txt', linesAdded: 5, linesRemoved: 6, isBinary: false, isComplete: true },
        ]);
    });

    it('shares one in-flight describe between the open commit view and write admission', async () => {
        let complete!: (value: unknown) => void;
        const description = new Promise<unknown>(resolve => { complete = resolve; });
        const call = vi.fn(async (method: string) => method === RPC_METHODS.SCM_BACKEND_DESCRIBE ? description : { success: true });
        const common = { call, describeScope: 'account:machine:repo', request: { cwd: '/repo' } };
        const view = runScmRpcWithAdmission({ ...common, method: RPC_METHODS.SCM_BACKEND_DESCRIBE });
        const write = runScmRpcWithAdmission({ ...common, method: RPC_METHODS.SCM_COMMIT_CREATE, request: { ...common.request, mode: 'amend' as const } });
        expect(call.mock.calls.filter(([method]) => method === RPC_METHODS.SCM_BACKEND_DESCRIBE)).toHaveLength(1);
        complete({ success: true, capabilities: createScmCapabilities({ writeCommitAmend: true }) });
        expect(await view).toMatchObject({ success: true });
        expect(await write).toMatchObject({ success: true });
    });

    it('prevents an older daemon from silently ignoring advanced write policy', async () => {
        const cases = [
            { method: RPC_METHODS.SCM_COMMIT_UNDO_LAST, request: { expectedHeadOid: 'a'.repeat(40) } },
            { method: RPC_METHODS.SCM_COMMIT_CREATE, request: { mode: 'amend' as const } },
            { method: RPC_METHODS.SCM_COMMIT_CREATE, request: { signOff: true } },
            { method: RPC_METHODS.SCM_REMOTE_PUSH, request: { pushMode: 'force_with_lease' as const } },
            { method: RPC_METHODS.SCM_REMOTE_PULL, request: { dirtyPolicy: 'autostash' as const, reconcile: 'rebase' as const } },
        ];
        for (const input of cases) {
            const dispatched: string[] = [];
            const response = await runScmRpcWithAdmission({ ...input, call: async (method) => { dispatched.push(method); return { success: true }; } });
            expect(response).toMatchObject({ success: false, errorCode: 'FEATURE_UNSUPPORTED' });
            expect(dispatched).toEqual([RPC_METHODS.SCM_BACKEND_DESCRIBE]);
        }
    });

    it('uses the exact target descriptor before forwarding supported policy and leaves defaults query-free', async () => {
        const call = vi.fn(async () => ({ success: true, capabilities: createScmCapabilities({ writeCommitAmend: true }) }));
        const backendPreference = { kind: 'prefer' as const, backendId: 'acme.scm/git' };
        const request = { cwd: '/selected-repo', backendPreference, mode: 'amend' as const };
        expect(await runScmRpcWithAdmission({ method: RPC_METHODS.SCM_COMMIT_CREATE, request, call })).toMatchObject({ success: true });
        expect(call.mock.calls).toEqual([
            [RPC_METHODS.SCM_BACKEND_DESCRIBE, { cwd: '/selected-repo', backendPreference }],
            [RPC_METHODS.SCM_COMMIT_CREATE, request],
        ]);
        call.mockClear();
        await runScmRpcWithAdmission({ method: RPC_METHODS.SCM_COMMIT_CREATE, request: { cwd: '/selected-repo' }, call });
        expect(call.mock.calls).toEqual([[RPC_METHODS.SCM_COMMIT_CREATE, { cwd: '/selected-repo' }]]);
    });

    it('dispatches undo only with the exact target capability and keeps the HEAD guard', async () => {
        const request = { cwd: '/selected-repo', expectedHeadOid: 'a'.repeat(40) };
        const call = vi.fn(async (method: string) => method === RPC_METHODS.SCM_BACKEND_DESCRIBE
            ? { success: true, capabilities: createScmCapabilities({ writeCommitUndoLast: true }) }
            : { success: true, undoneCommitSha: request.expectedHeadOid });
        expect(await runScmRpcWithAdmission({ method: RPC_METHODS.SCM_COMMIT_UNDO_LAST, request, call }))
            .toMatchObject({ success: true, undoneCommitSha: request.expectedHeadOid });
        expect(call.mock.calls).toEqual([
            [RPC_METHODS.SCM_BACKEND_DESCRIBE, { cwd: '/selected-repo' }],
            [RPC_METHODS.SCM_COMMIT_UNDO_LAST, request],
        ]);
    });

    it('does not dispatch an advanced mutation when its exact-target descriptor is unavailable', async () => {
        const dispatched: string[] = [];
        const response = await runScmRpcWithAdmission({ method: RPC_METHODS.SCM_REMOTE_PULL, request: { reconcile: 'rebase' }, call: async (method) => { dispatched.push(method); throw new Error('descriptor unavailable'); } });
        expect(response).toMatchObject({ success: false, errorCode: 'FEATURE_UNSUPPORTED' });
        expect(dispatched).toEqual([RPC_METHODS.SCM_BACKEND_DESCRIBE]);
    });
});

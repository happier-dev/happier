import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

const { mockSessionRPC } = vi.hoisted(() => ({
    mockSessionRPC: vi.fn(),
}));

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: mockSessionRPC,
    },
}));

// sessions ops import sync for non-SCM helpers; keep this test node-safe.
vi.mock('../sync', () => ({
    sync: {
        encryption: {
            getSessionEncryption: () => null,
            getMachineEncryption: () => null,
        },
    },
}));

import {
    sessionScmCommitCreate,
    sessionScmCommitBackout,
    sessionScmLogList,
    sessionScmRemoteFetch,
    sessionScmRemotePull,
    sessionScmRemotePush,
    sessionScmChangeInclude,
    sessionScmStatusSnapshot,
} from './sessions';
import { createGitSessionRpcHarness, git, initRepo } from './__tests__/gitRepoHarness';
import { storage } from '../domains/state/storage';

describe('session scm ops integration (git backend)', () => {
    beforeEach(() => {
        mockSessionRPC.mockReset();
        storage.getState().applySettingsLocal({ scmGitRepoPreferredBackend: 'git' } as any);
    });

    it('injects sapling backend preference when configured', async () => {
        storage.getState().applySettingsLocal({ scmGitRepoPreferredBackend: 'sapling' } as any);
        mockSessionRPC.mockResolvedValue({
            success: true,
            snapshot: {
                projectKey: 'local:/repo',
                fetchedAt: Date.now(),
                repo: { isRepo: false, rootPath: null, backendId: null, mode: null },
                capabilities: {
                    readStatus: false,
                    readDiffFile: false,
                    readDiffCommit: false,
                    readLog: false,
                    writeInclude: false,
                    writeExclude: false,
                    writeCommit: false,
                    writeBackout: false,
                    writeRemoteFetch: false,
                    writeRemotePull: false,
                    writeRemotePush: false,
                    workspaceWorktreeCreate: false,
                    changeSetModel: 'working-copy',
                    supportedDiffAreas: ['pending'],
                },
                branch: { head: null, upstream: null, ahead: 0, behind: 0, detached: false },
                hasConflicts: false,
                entries: [],
                totals: {
                    includedFiles: 0,
                    pendingFiles: 0,
                    untrackedFiles: 0,
                    includedAdded: 0,
                    includedRemoved: 0,
                    pendingAdded: 0,
                    pendingRemoved: 0,
                },
            },
        });

        await sessionScmStatusSnapshot('session-1', { cwd: '.' });

        const request = mockSessionRPC.mock.calls[0]?.[2];
        expect(request.backendPreference).toEqual({
            kind: 'prefer',
            backendId: 'sapling',
        });
    });

    it('stages, commits, and lists history through session git RPC methods', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-int-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nupdate\n');

        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const stage = await sessionScmChangeInclude('session-1', {
            cwd: '.',
            paths: ['a.txt'],
        });
        expect(stage.success).toBe(true);
        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('a.txt');

        const stagedSnapshot = await sessionScmStatusSnapshot('session-1', { cwd: '.' });
        expect(stagedSnapshot.success).toBe(true);
        expect(stagedSnapshot.snapshot?.totals.includedFiles).toBe(1);
        expect(stagedSnapshot.snapshot?.totals.pendingFiles).toBe(0);

        const commit = await sessionScmCommitCreate('session-1', {
            cwd: '.',
            message: 'feat: update a',
        });
        expect(commit.success).toBe(true);
        expect(commit.commitSha).toBeTruthy();

        const log = await sessionScmLogList('session-1', {
            cwd: '.',
            limit: 1,
            skip: 0,
        });
        expect(log.success).toBe(true);
        expect(log.entries?.[0]?.subject).toBe('feat: update a');

        const status = await sessionScmStatusSnapshot('session-1', { cwd: '.' });
        expect(status.success).toBe(true);
        expect(status.snapshot?.totals.includedFiles).toBe(0);
        expect(status.snapshot?.totals.pendingFiles).toBe(0);
    });

    it('commits all pending tracked and untracked changes with all-pending scope', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-int-atomic-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);

        writeFileSync(join(workspace, 'a.txt'), 'base\ntracked-pending\n');
        writeFileSync(join(workspace, 'untracked.txt'), 'untracked\n');

        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const commit = await sessionScmCommitCreate('session-1', {
            cwd: '.',
            message: 'feat: atomic all pending',
            scope: { kind: 'all-pending' },
        });
        expect(commit.success).toBe(true);
        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toContain('a.txt');
        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toContain('untracked.txt');

        const status = await sessionScmStatusSnapshot('session-1', { cwd: '.' });
        expect(status.success).toBe(true);
        expect(status.snapshot?.totals.pendingFiles).toBe(0);
        expect(status.snapshot?.totals.untrackedFiles).toBe(0);
    });

    it('fetches remote updates through sessionScmRemoteFetch against a real remote', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branch]);

        const other = mkdtempSync(join(tmpdir(), 'happier-ui-git-other-'));
        git(other, ['clone', remote, '.']);
        git(other, ['config', 'user.email', 'other@example.com']);
        git(other, ['config', 'user.name', 'Other User']);
        writeFileSync(join(other, 'remote.txt'), 'remote\n');
        git(other, ['add', 'remote.txt']);
        git(other, ['commit', '-m', 'remote update']);
        git(other, ['push', 'origin', branch]);
        const remoteHead = git(other, ['rev-parse', 'HEAD']);

        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const fetch = await sessionScmRemoteFetch('session-1', {
            cwd: '.',
            remote: 'origin',
        });
        expect(fetch.success).toBe(true);
        expect(git(workspace, ['rev-parse', `origin/${branch}`])).toBe(remoteHead);
    });

    it('rejects push when local branch is behind upstream', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branch]);

        const other = mkdtempSync(join(tmpdir(), 'happier-ui-git-other-'));
        git(other, ['clone', remote, '.']);
        git(other, ['config', 'user.email', 'other@example.com']);
        git(other, ['config', 'user.name', 'Other User']);
        writeFileSync(join(other, 'remote.txt'), 'remote\n');
        git(other, ['add', 'remote.txt']);
        git(other, ['commit', '-m', 'remote update']);
        git(other, ['push', 'origin', branch]);

        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const fetch = await sessionScmRemoteFetch('session-1', {
            cwd: '.',
            remote: 'origin',
        });
        expect(fetch.success).toBe(true);

        const push = await sessionScmRemotePush('session-1', { cwd: '.' });
        expect(push.success).toBe(false);
        expect(push.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD);
    });

    it('rejects pull when worktree is dirty', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branch]);
        writeFileSync(join(workspace, 'a.txt'), 'base\ndirty\n');

        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const pull = await sessionScmRemotePull('session-1', { cwd: '.' });
        expect(pull.success).toBe(false);
        expect(pull.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
    });

    it('pushes successfully when local branch is ahead of upstream', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branch]);

        writeFileSync(join(workspace, 'ahead.txt'), 'ahead\n');
        git(workspace, ['add', 'ahead.txt']);
        git(workspace, ['commit', '-m', 'ahead']);
        const localHead = git(workspace, ['rev-parse', 'HEAD']);

        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const push = await sessionScmRemotePush('session-1', { cwd: '.' });
        expect(push.success).toBe(true);
        expect(git(workspace, ['rev-parse', `origin/${branch}`])).toBe(localHead);
    });

    it('returns REMOTE_FF_ONLY_REQUIRED when pull cannot fast-forward', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branch]);

        writeFileSync(join(workspace, 'local.txt'), 'local\n');
        git(workspace, ['add', 'local.txt']);
        git(workspace, ['commit', '-m', 'local change']);

        const other = mkdtempSync(join(tmpdir(), 'happier-ui-git-other-'));
        git(other, ['clone', remote, '.']);
        git(other, ['config', 'user.email', 'other@example.com']);
        git(other, ['config', 'user.name', 'Other User']);
        writeFileSync(join(other, 'remote.txt'), 'remote\n');
        git(other, ['add', 'remote.txt']);
        git(other, ['commit', '-m', 'remote change']);
        git(other, ['push', 'origin', branch]);

        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const fetch = await sessionScmRemoteFetch('session-1', {
            cwd: '.',
            remote: 'origin',
        });
        expect(fetch.success).toBe(true);

        const pull = await sessionScmRemotePull('session-1', { cwd: '.' });
        expect(pull.success).toBe(false);
        expect(pull.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_FF_ONLY_REQUIRED);
    });

    it('blocks push without upstream when remote/branch are not provided', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);

        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const push = await sessionScmRemotePush('session-1', { cwd: '.' });
        expect(push.success).toBe(false);
        expect(push.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
    });

    it('blocks pull without upstream when remote/branch are not provided', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);

        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const pull = await sessionScmRemotePull('session-1', { cwd: '.' });
        expect(pull.success).toBe(false);
        expect(pull.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
    });

    it('pushes with explicit remote/branch even when upstream is not configured', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);

        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const localHead = git(workspace, ['rev-parse', 'HEAD']);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const push = await sessionScmRemotePush('session-1', {
            cwd: '.',
            remote: 'origin',
            branch,
        });
        expect(push.success).toBe(true);
        expect(git(workspace, ['rev-parse', `origin/${branch}`])).toBe(localHead);
    });

    it('pulls with explicit remote/branch even when upstream is not configured', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', 'origin', branch]);

        const other = mkdtempSync(join(tmpdir(), 'happier-ui-git-other-'));
        git(other, ['clone', remote, '.']);
        git(other, ['config', 'user.email', 'other@example.com']);
        git(other, ['config', 'user.name', 'Other User']);
        writeFileSync(join(other, 'remote.txt'), 'remote\n');
        git(other, ['add', 'remote.txt']);
        git(other, ['commit', '-m', 'remote update']);
        git(other, ['push', 'origin', branch]);
        const remoteHead = git(other, ['rev-parse', 'HEAD']);

        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const pull = await sessionScmRemotePull('session-1', {
            cwd: '.',
            remote: 'origin',
            branch,
        });
        expect(pull.success).toBe(true);
        expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(remoteHead);
    });

    it('blocks push while HEAD is detached', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branch]);
        git(workspace, ['checkout', '--detach']);

        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const push = await sessionScmRemotePush('session-1', {
            cwd: '.',
            remote: 'origin',
            branch,
        });
        expect(push.success).toBe(false);
        expect(push.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });

    it('blocks pull while HEAD is detached', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branch]);
        git(workspace, ['checkout', '--detach']);

        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const pull = await sessionScmRemotePull('session-1', {
            cwd: '.',
            remote: 'origin',
            branch,
        });
        expect(pull.success).toBe(false);
        expect(pull.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });

    it('returns CHANGE_APPLY_FAILED when selected patch no longer matches index state', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-int-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'a\nb\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'X\nB\n');
        git(workspace, ['add', 'a.txt']);

        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const patch = [
            'diff --git a/a.txt b/a.txt',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1 @@',
            '-a',
            '+A',
            '',
        ].join('\n');

        const stage = await sessionScmChangeInclude('session-1', {
            cwd: '.',
            patch,
        });
        expect(stage.success).toBe(false);
        expect(stage.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED);
    });

    it('returns NOT_REPOSITORY for operations outside a repository and keeps snapshot responses safe', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-empty-'));
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const stage = await sessionScmChangeInclude('session-1', {
            cwd: '.',
            paths: ['a.txt'],
        });
        expect(stage.success).toBe(false);
        expect(stage.errorCode).toBe(SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY);

        const snapshot = await sessionScmStatusSnapshot('session-1', { cwd: '.' });
        expect(snapshot.success).toBe(true);
        expect(snapshot.snapshot?.repo.isRepo).toBe(false);
        expect(snapshot.snapshot?.entries).toEqual([]);
    });

    it('maps sessionRPC transport failures to COMMAND_FAILED fallback responses', async () => {
        mockSessionRPC.mockRejectedValue(new Error('socket disconnected'));

        const result = await sessionScmRemotePull('session-1', { cwd: '.' });
        expect(result.success).toBe(false);
        expect(result.errorCode).toBe(SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
        expect(result.error).toContain('socket disconnected');
    });

    it('reverts a regular commit successfully', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-revert-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'changed\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'feature change']);
        const targetSha = git(workspace, ['rev-parse', 'HEAD']);

        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const response = await sessionScmCommitBackout('session-1', {
            cwd: '.',
            commit: targetSha,
        });
        expect(response.success).toBe(true);
        expect(git(workspace, ['log', '-1', '--pretty=%s']).toLowerCase()).toContain('revert');
        expect(git(workspace, ['show', 'HEAD:a.txt'])).toBe('base');
    });

    it('blocks revert when worktree has local changes', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-revert-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'changed\n');

        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const response = await sessionScmCommitBackout('session-1', {
            cwd: '.',
            commit: 'HEAD',
        });
        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
    });

    it('returns deterministic error for reverting a merge commit', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-revert-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        const defaultBranch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['checkout', '-b', 'feature']);
        writeFileSync(join(workspace, 'feature.txt'), 'feature\n');
        git(workspace, ['add', 'feature.txt']);
        git(workspace, ['commit', '-m', 'feature']);
        git(workspace, ['checkout', defaultBranch]);
        writeFileSync(join(workspace, 'main.txt'), 'main\n');
        git(workspace, ['add', 'main.txt']);
        git(workspace, ['commit', '-m', 'main']);
        git(workspace, ['merge', '--no-ff', 'feature', '-m', 'merge feature']);
        const mergeSha = git(workspace, ['rev-parse', 'HEAD']);

        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const response = await sessionScmCommitBackout('session-1', {
            cwd: '.',
            commit: mergeSha,
        });
        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
        expect((response.error || '').toLowerCase()).toContain('merge commit');
    });

    it('blocks revert while HEAD is detached', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-revert-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['checkout', '--detach']);

        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const response = await sessionScmCommitBackout('session-1', {
            cwd: '.',
            commit: 'HEAD',
        });
        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });
});

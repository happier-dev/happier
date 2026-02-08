import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GIT_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

const { mockSessionRPC } = vi.hoisted(() => ({
    mockSessionRPC: vi.fn(),
}));

vi.mock('../apiSocket', () => ({
    apiSocket: {
        sessionRPC: mockSessionRPC,
    },
}));

// sessions ops import sync for non-git helpers; keep this test node-safe.
vi.mock('../sync', () => ({
    sync: {
        encryption: {
            getSessionEncryption: () => null,
            getMachineEncryption: () => null,
        },
    },
}));

import {
    sessionGitCommitCreate,
    sessionGitCommitRevert,
    sessionGitLogList,
    sessionGitRemoteFetch,
    sessionGitRemotePull,
    sessionGitRemotePush,
    sessionGitStageApply,
    sessionGitStatusSnapshot,
} from './sessions';
import { createGitSessionRpcHarness, git, initRepo } from './__tests__/gitRepoHarness';

describe('session git ops integration', () => {
    beforeEach(() => {
        mockSessionRPC.mockReset();
    });

    it('stages, commits, and lists history through session git RPC methods', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-int-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nupdate\n');

        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const stage = await sessionGitStageApply('session-1', {
            cwd: '.',
            paths: ['a.txt'],
        });
        expect(stage.success).toBe(true);
        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('a.txt');

        const stagedSnapshot = await sessionGitStatusSnapshot('session-1', { cwd: '.' });
        expect(stagedSnapshot.success).toBe(true);
        expect(stagedSnapshot.snapshot?.totals.stagedFiles).toBe(1);
        expect(stagedSnapshot.snapshot?.totals.unstagedFiles).toBe(0);

        const commit = await sessionGitCommitCreate('session-1', {
            cwd: '.',
            message: 'feat: update a',
        });
        expect(commit.success).toBe(true);
        expect(commit.commitSha).toBeTruthy();

        const log = await sessionGitLogList('session-1', {
            cwd: '.',
            limit: 1,
            skip: 0,
        });
        expect(log.success).toBe(true);
        expect(log.entries?.[0]?.subject).toBe('feat: update a');

        const status = await sessionGitStatusSnapshot('session-1', { cwd: '.' });
        expect(status.success).toBe(true);
        expect(status.snapshot?.totals.stagedFiles).toBe(0);
        expect(status.snapshot?.totals.unstagedFiles).toBe(0);
    });

    it('fetches remote updates through sessionGitRemoteFetch against a real remote', async () => {
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

        const fetch = await sessionGitRemoteFetch('session-1', {
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

        const fetch = await sessionGitRemoteFetch('session-1', {
            cwd: '.',
            remote: 'origin',
        });
        expect(fetch.success).toBe(true);

        const push = await sessionGitRemotePush('session-1', { cwd: '.' });
        expect(push.success).toBe(false);
        expect(push.errorCode).toBe(GIT_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD);
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

        const pull = await sessionGitRemotePull('session-1', { cwd: '.' });
        expect(pull.success).toBe(false);
        expect(pull.errorCode).toBe(GIT_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
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

        const push = await sessionGitRemotePush('session-1', { cwd: '.' });
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

        const fetch = await sessionGitRemoteFetch('session-1', {
            cwd: '.',
            remote: 'origin',
        });
        expect(fetch.success).toBe(true);

        const pull = await sessionGitRemotePull('session-1', { cwd: '.' });
        expect(pull.success).toBe(false);
        expect(pull.errorCode).toBe(GIT_OPERATION_ERROR_CODES.REMOTE_FF_ONLY_REQUIRED);
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

        const push = await sessionGitRemotePush('session-1', { cwd: '.' });
        expect(push.success).toBe(false);
        expect(push.errorCode).toBe(GIT_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
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

        const pull = await sessionGitRemotePull('session-1', { cwd: '.' });
        expect(pull.success).toBe(false);
        expect(pull.errorCode).toBe(GIT_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
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

        const push = await sessionGitRemotePush('session-1', {
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

        const pull = await sessionGitRemotePull('session-1', {
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

        const push = await sessionGitRemotePush('session-1', {
            cwd: '.',
            remote: 'origin',
            branch,
        });
        expect(push.success).toBe(false);
        expect(push.errorCode).toBe(GIT_OPERATION_ERROR_CODES.INVALID_REQUEST);
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

        const pull = await sessionGitRemotePull('session-1', {
            cwd: '.',
            remote: 'origin',
            branch,
        });
        expect(pull.success).toBe(false);
        expect(pull.errorCode).toBe(GIT_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });

    it('returns PATCH_APPLY_FAILED when selected patch no longer matches index state', async () => {
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

        const stage = await sessionGitStageApply('session-1', {
            cwd: '.',
            patch,
        });
        expect(stage.success).toBe(false);
        expect(stage.errorCode).toBe(GIT_OPERATION_ERROR_CODES.PATCH_APPLY_FAILED);
    });

    it('returns NOT_GIT_REPO for operations outside a repository and keeps snapshot responses safe', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-empty-'));
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const stage = await sessionGitStageApply('session-1', {
            cwd: '.',
            paths: ['a.txt'],
        });
        expect(stage.success).toBe(false);
        expect(stage.errorCode).toBe(GIT_OPERATION_ERROR_CODES.NOT_GIT_REPO);

        const snapshot = await sessionGitStatusSnapshot('session-1', { cwd: '.' });
        expect(snapshot.success).toBe(true);
        expect(snapshot.snapshot?.repo.isGitRepo).toBe(false);
        expect(snapshot.snapshot?.entries).toEqual([]);
    });

    it('maps sessionRPC transport failures to COMMAND_FAILED fallback responses', async () => {
        mockSessionRPC.mockRejectedValue(new Error('socket disconnected'));

        const result = await sessionGitRemotePull('session-1', { cwd: '.' });
        expect(result.success).toBe(false);
        expect(result.errorCode).toBe(GIT_OPERATION_ERROR_CODES.COMMAND_FAILED);
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

        const response = await sessionGitCommitRevert('session-1', {
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

        const response = await sessionGitCommitRevert('session-1', {
            cwd: '.',
            commit: 'HEAD',
        });
        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
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

        const response = await sessionGitCommitRevert('session-1', {
            cwd: '.',
            commit: mergeSha,
        });
        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.INVALID_REQUEST);
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

        const response = await sessionGitCommitRevert('session-1', {
            cwd: '.',
            commit: 'HEAD',
        });
        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });
});

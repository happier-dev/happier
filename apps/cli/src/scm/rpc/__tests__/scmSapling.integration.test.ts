import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it } from 'vitest';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createTestRpcManager, runGit, runSapling } from './testRpcHarness';

function createSaplingWorkspace(): string {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-sl-'));
    runSapling(workspace, ['init']);
    runSapling(workspace, ['config', '--local', 'ui.username', 'Test User <test@example.com>']);
    return workspace;
}

describe('sapling backend integration', () => {
    it('uses sapling backend for .git repos only when explicit preference is set', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-git-'));
        runGit(workspace, ['init']);
        runGit(workspace, ['config', 'user.email', 'test@example.com']);
        runGit(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'hello\\n');
        runGit(workspace, ['add', 'a.txt']);
        runGit(workspace, ['commit', '-m', 'init']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const defaultStatus = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: '.' });
        const preferredStatus = await call<any, { cwd?: string; backendPreference?: any }>(
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            {
                cwd: '.',
                backendPreference: {
                    kind: 'prefer',
                    backendId: 'sapling',
                },
            }
        );

        expect(defaultStatus.success).toBe(true);
        expect(defaultStatus.snapshot.repo.backendId).toBe('git');
        expect(preferredStatus.success).toBe(true);
        expect(preferredStatus.snapshot.repo.backendId).toBe('sapling');
    });

    it('reads status snapshot and identifies sapling backend for .sl repositories', async () => {
        const workspace = createSaplingWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');
        runSapling(workspace, ['add', 'a.txt']);
        runSapling(workspace, ['commit', '-m', 'init']);
        writeFileSync(join(workspace, 'a.txt'), 'hello2\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const status = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: '.' });

        expect(status.success).toBe(true);
        expect(status.snapshot.repo.isRepo).toBe(true);
        expect(status.snapshot.repo.backendId).toBe('sapling');
        expect(status.snapshot.repo.mode).toBe('.sl');
        expect(status.snapshot.totals.pendingFiles).toBeGreaterThan(0);
    });

    it('reports unresolved merge conflicts in status snapshots', async () => {
        const workspace = createSaplingWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        runSapling(workspace, ['commit', '-A', '-m', 'base']);
        const base = runSapling(workspace, ['whereami']);

        writeFileSync(join(workspace, 'a.txt'), 'one\n');
        runSapling(workspace, ['commit', '-A', '-m', 'one']);
        const one = runSapling(workspace, ['whereami']);

        runSapling(workspace, ['goto', base]);
        writeFileSync(join(workspace, 'a.txt'), 'two\n');
        runSapling(workspace, ['commit', '-A', '-m', 'two']);
        const two = runSapling(workspace, ['whereami']);

        runSapling(workspace, ['goto', one]);
        try {
            runSapling(workspace, ['merge', two]);
        } catch {
            // Merge exits non-zero when conflicts remain, which is expected here.
        }

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const status = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: '.' });

        expect(status.success).toBe(true);
        expect(status.snapshot.hasConflicts).toBe(true);
        expect(status.snapshot.entries.some((entry: any) => entry.path === 'a.txt' && entry.kind === 'conflicted')).toBe(true);
    });

    it('returns feature unsupported for include/exclude operations', async () => {
        const workspace = createSaplingWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const include = await call<any, { cwd?: string; paths?: string[] }>(RPC_METHODS.SCM_CHANGE_INCLUDE, {
            cwd: '.',
            paths: ['a.txt'],
        });
        const exclude = await call<any, { cwd?: string; paths?: string[] }>(RPC_METHODS.SCM_CHANGE_EXCLUDE, {
            cwd: '.',
            paths: ['a.txt'],
        });

        expect(include.success).toBe(false);
        expect(include.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
        expect(exclude.success).toBe(false);
        expect(exclude.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
    });

    it('creates commits and returns commit sha', async () => {
        const workspace = createSaplingWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const commit = await call<any, { cwd?: string; message: string }>(RPC_METHODS.SCM_COMMIT_CREATE, {
            cwd: '.',
            message: 'init',
        });

        expect(commit.success).toBe(true);
        expect(typeof commit.commitSha).toBe('string');
        expect((commit.commitSha as string).length).toBeGreaterThanOrEqual(12);

        const status = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.success).toBe(true);
        expect(status.snapshot.totals.pendingFiles).toBe(0);
    });

    it('lists commit history entries', async () => {
        const workspace = createSaplingWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const commit = await call<any, { cwd?: string; message: string }>(RPC_METHODS.SCM_COMMIT_CREATE, {
            cwd: '.',
            message: 'init',
        });
        expect(commit.success).toBe(true);

        const log = await call<any, { cwd?: string; limit?: number; skip?: number }>(RPC_METHODS.SCM_LOG_LIST, {
            cwd: '.',
            limit: 10,
            skip: 0,
        });
        expect(log.success).toBe(true);
        expect(log.entries?.[0]?.subject).toBe('init');
    });

    it('supports log pagination with skip and limit', async () => {
        const workspace = createSaplingWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'one\n');
        runSapling(workspace, ['commit', '-A', '-m', 'one']);
        writeFileSync(join(workspace, 'a.txt'), 'two\n');
        runSapling(workspace, ['commit', '-A', '-m', 'two']);
        writeFileSync(join(workspace, 'a.txt'), 'three\n');
        runSapling(workspace, ['commit', '-A', '-m', 'three']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const firstPage = await call<any, { cwd?: string; limit?: number; skip?: number }>(RPC_METHODS.SCM_LOG_LIST, {
            cwd: '.',
            limit: 1,
            skip: 0,
        });
        const secondPage = await call<any, { cwd?: string; limit?: number; skip?: number }>(RPC_METHODS.SCM_LOG_LIST, {
            cwd: '.',
            limit: 1,
            skip: 1,
        });

        expect(firstPage.success).toBe(true);
        expect(secondPage.success).toBe(true);
        expect(firstPage.entries?.[0]?.subject).toBe('three');
        expect(secondPage.entries?.[0]?.subject).toBe('two');
    });

    it('supports path-scoped commit requests', async () => {
        const workspace = createSaplingWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');
        writeFileSync(join(workspace, 'b.txt'), 'world\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const commit = await call<any, { cwd?: string; message: string; scope: { kind: 'paths'; include: string[] } }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'scoped',
                scope: {
                    kind: 'paths',
                    include: ['a.txt'],
                },
            },
        );

        expect(commit.success).toBe(true);

        const status = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.success).toBe(true);
        const pendingPaths = (status.snapshot.entries as Array<{ path: string }>).map((entry) => entry.path);
        expect(pendingPaths).toContain('b.txt');
        expect(pendingPaths).not.toContain('a.txt');
    });

    it('supports directory-scoped commit requests', async () => {
        const workspace = createSaplingWorkspace();
        mkdirSync(join(workspace, 'src'), { recursive: true });
        mkdirSync(join(workspace, 'docs'), { recursive: true });
        writeFileSync(join(workspace, 'src', 'a.txt'), 'hello\n');
        writeFileSync(join(workspace, 'src', 'b.txt'), 'world\n');
        writeFileSync(join(workspace, 'docs', 'c.txt'), 'notes\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const commit = await call<any, { cwd?: string; message: string; scope: { kind: 'paths'; include: string[] } }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'scoped directory',
                scope: {
                    kind: 'paths',
                    include: ['src'],
                },
            },
        );

        expect(commit.success).toBe(true);

        const status = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.success).toBe(true);
        const pendingPaths = (status.snapshot.entries as Array<{ path: string }>).map((entry) => entry.path).sort();
        expect(pendingPaths).toEqual(['docs/c.txt']);
    });

    it('returns feature unsupported for patch-based commit requests', async () => {
        const workspace = createSaplingWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const commit = await call<any, { cwd?: string; message: string; patches: Array<{ path: string; patch: string }> }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'patch commit',
                patches: [{
                    path: 'a.txt',
                    patch: 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-hello\n+hello2\n',
                }],
            },
        );

        expect(commit.success).toBe(false);
        expect(commit.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
    });

    it('renders file and commit diffs through sapling backend', async () => {
        const workspace = createSaplingWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');
        runSapling(workspace, ['add', 'a.txt']);
        runSapling(workspace, ['commit', '-m', 'init']);
        const base = runSapling(workspace, ['whereami']);
        writeFileSync(join(workspace, 'a.txt'), 'hello2\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const fileDiff = await call<any, { cwd?: string; path: string; area?: 'pending' | 'both' | 'included' }>(
            RPC_METHODS.SCM_DIFF_FILE,
            {
                cwd: '.',
                path: 'a.txt',
                area: 'pending',
            }
        );
        const commitDiff = await call<any, { cwd?: string; commit: string }>(RPC_METHODS.SCM_DIFF_COMMIT, {
            cwd: '.',
            commit: base,
        });

        expect(fileDiff.success).toBe(true);
        expect(fileDiff.diff).toContain('diff --git a/a.txt b/a.txt');
        expect(commitDiff.success).toBe(true);
        expect(commitDiff.diff).toContain('diff --git a/a.txt b/a.txt');
    });

    it('backs out a non-merge commit in sapling backend', async () => {
        const workspace = createSaplingWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');
        runSapling(workspace, ['add', 'a.txt']);
        runSapling(workspace, ['commit', '-m', 'init']);

        writeFileSync(join(workspace, 'a.txt'), 'hello2\n');
        runSapling(workspace, ['commit', '-A', '-m', 'update']);
        const commitToBackout = runSapling(workspace, ['whereami']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; commit: string }>(RPC_METHODS.SCM_COMMIT_BACKOUT, {
            cwd: '.',
            commit: commitToBackout,
        });

        expect(response.success).toBe(true);

        const status = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.success).toBe(true);
        expect(status.snapshot.totals.pendingFiles).toBe(0);
    });

    it('fetches, pulls, and pushes with branch shorthand against git remotes', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-scm-sl-remote-'));
        runGit(remote, ['init', '--bare']);
        // Ensure clones of this temporary remote have a deterministic default branch.
        // Without this, `git clone` may produce a repo without a local `main` branch, and
        // `git push origin main` will fail even if `refs/heads/main` exists on the remote.
        runGit(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

        const workspace = createSaplingWorkspace();
        runSapling(workspace, ['path', '--add', 'origin', remote]);
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');
        runSapling(workspace, ['commit', '-A', '-m', 'init']);
        runSapling(workspace, ['push', 'origin', '--to', 'main', '--create']);

        const other = mkdtempSync(join(tmpdir(), 'happier-scm-sl-other-'));
        runGit(other, ['clone', remote, '.']);
        runGit(other, ['config', 'user.email', 'other@example.com']);
        runGit(other, ['config', 'user.name', 'Other User']);
        writeFileSync(join(other, 'remote.txt'), 'remote\n');
        runGit(other, ['add', 'remote.txt']);
        runGit(other, ['commit', '-m', 'remote update']);
        runGit(other, ['push', 'origin', 'main']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const fetch = await call<any, { cwd?: string; remote?: string }>(RPC_METHODS.SCM_REMOTE_FETCH, {
            cwd: '.',
            remote: 'origin',
        });
        expect(fetch.success).toBe(true);

        const pull = await call<any, { cwd?: string; remote?: string; branch?: string }>(RPC_METHODS.SCM_REMOTE_PULL, {
            cwd: '.',
            remote: 'origin',
            branch: 'main',
        });
        expect(pull.success).toBe(true);
        expect(readFileSync(join(workspace, 'remote.txt'), 'utf8')).toBe('remote\n');

        writeFileSync(join(workspace, 'local.txt'), 'local\n');
        runSapling(workspace, ['commit', '-A', '-m', 'local update']);

        const push = await call<any, { cwd?: string; remote?: string; branch?: string }>(RPC_METHODS.SCM_REMOTE_PUSH, {
            cwd: '.',
            remote: 'origin',
            branch: 'main',
        });
        expect(push.success).toBe(true);

        const remoteHead = runGit(remote, ['rev-parse', 'refs/heads/main']);
        const localHead = runSapling(workspace, ['whereami']);
        expect(remoteHead).toBe(localHead);
    });

    it('returns deterministic upstream-required errors for pull/push without bookmark target', async () => {
        const workspace = createSaplingWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');
        runSapling(workspace, ['commit', '-A', '-m', 'init']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const pull = await call<any, { cwd?: string }>(RPC_METHODS.SCM_REMOTE_PULL, { cwd: '.' });
        const push = await call<any, { cwd?: string }>(RPC_METHODS.SCM_REMOTE_PUSH, { cwd: '.' });

        expect(pull.success).toBe(false);
        expect(pull.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
        expect(push.success).toBe(false);
        expect(push.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
    });

    it('does not infer a push destination branch from active commit hash', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-scm-sl-remote-no-branch-'));
        runGit(remote, ['init', '--bare']);

        const workspace = createSaplingWorkspace();
        runSapling(workspace, ['path', '--add', 'origin', remote]);
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');
        runSapling(workspace, ['commit', '-A', '-m', 'init']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const push = await call<any, { cwd?: string; remote?: string }>(RPC_METHODS.SCM_REMOTE_PUSH, {
            cwd: '.',
            remote: 'origin',
        });

        expect(push.success).toBe(false);
        expect(push.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
    });

    it('blocks pull with deterministic conflicting-worktree error when sapling workspace is dirty', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-scm-sl-remote-dirty-pull-'));
        runGit(remote, ['init', '--bare']);

        const workspace = createSaplingWorkspace();
        runSapling(workspace, ['path', '--add', 'origin', remote]);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        runSapling(workspace, ['commit', '-A', '-m', 'base']);
        runSapling(workspace, ['push', 'origin', '--to', 'main', '--create']);

        writeFileSync(join(workspace, 'a.txt'), 'base\ndirty\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const pull = await call<any, { cwd?: string; remote?: string; branch?: string }>(RPC_METHODS.SCM_REMOTE_PULL, {
            cwd: '.',
            remote: 'origin',
            branch: 'main',
        });

        expect(pull.success).toBe(false);
        expect(pull.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
    });

    it('blocks push with deterministic conflicting-worktree error when sapling repository has unresolved conflicts', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-scm-sl-remote-conflict-push-'));
        runGit(remote, ['init', '--bare']);

        const workspace = createSaplingWorkspace();
        runSapling(workspace, ['path', '--add', 'origin', remote]);

        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        runSapling(workspace, ['commit', '-A', '-m', 'base']);
        runSapling(workspace, ['push', 'origin', '--to', 'main', '--create']);
        const base = runSapling(workspace, ['whereami']);

        writeFileSync(join(workspace, 'a.txt'), 'one\n');
        runSapling(workspace, ['commit', '-A', '-m', 'one']);
        const one = runSapling(workspace, ['whereami']);

        runSapling(workspace, ['goto', base]);
        writeFileSync(join(workspace, 'a.txt'), 'two\n');
        runSapling(workspace, ['commit', '-A', '-m', 'two']);
        const two = runSapling(workspace, ['whereami']);

        runSapling(workspace, ['goto', one]);
        try {
            runSapling(workspace, ['merge', two]);
        } catch {
            // Merge exits non-zero when conflicts remain.
        }

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const push = await call<any, { cwd?: string; remote?: string; branch?: string }>(RPC_METHODS.SCM_REMOTE_PUSH, {
            cwd: '.',
            remote: 'origin',
            branch: 'main',
        });

        expect(push.success).toBe(false);
        expect(push.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
    });
});

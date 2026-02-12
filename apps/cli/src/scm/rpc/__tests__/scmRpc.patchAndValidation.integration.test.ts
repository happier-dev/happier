import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { createTestRpcManager, runGit as git } from './testRpcHarness';

describe('git RPC handlers', () => {
    it('stages file-level changes and reports them in snapshot totals', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'init']);
        writeFileSync(join(workspace, 'a.txt'), 'hello world\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });

        const stage = await call<any, { cwd?: string; paths: string[] }>(RPC_METHODS.SCM_CHANGE_INCLUDE, {
            cwd: '.',
            paths: ['a.txt'],
        });
        expect(stage.success).toBe(true);

        const status = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.success).toBe(true);
        expect(status.snapshot.totals.includedFiles).toBeGreaterThan(0);
    }, 20_000);

    it('stages a selected hunk patch and leaves remaining lines unstaged', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'a\nb\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'init']);
        writeFileSync(join(workspace, 'a.txt'), 'A\nB\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const patch = [
            'diff --git a/a.txt b/a.txt',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1 @@',
            '-a',
            '+A',
            '',
        ].join('\n');

        const stage = await call<any, { cwd?: string; patch?: string }>(RPC_METHODS.SCM_CHANGE_INCLUDE, {
            cwd: '.',
            patch,
        });
        expect(stage.success).toBe(true);

        const status = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.success).toBe(true);
        expect(status.snapshot.totals.includedFiles).toBe(1);
        expect(status.snapshot.totals.pendingFiles).toBe(1);
        const entry = status.snapshot.entries.find((value: any) => value.path === 'a.txt');
        expect(entry).toBeDefined();
        expect(entry.hasIncludedDelta).toBe(true);
        expect(entry.hasPendingDelta).toBe(true);
    });

    it('returns CHANGE_APPLY_FAILED when selected hunk patch no longer matches worktree', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'a\nb\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'init']);
        writeFileSync(join(workspace, 'a.txt'), 'X\nB\n');
        git(workspace, ['add', 'a.txt']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const patch = [
            'diff --git a/a.txt b/a.txt',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1 @@',
            '-a',
            '+A',
            '',
        ].join('\n');

        const stage = await call<any, { cwd?: string; patch?: string }>(RPC_METHODS.SCM_CHANGE_INCLUDE, {
            cwd: '.',
            patch,
        });
        expect(stage.success).toBe(false);
        expect(stage.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED);
    });

    it('stages selected patch lines with no-newline markers', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'a');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'init']);
        writeFileSync(join(workspace, 'a.txt'), 'A');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const patch = [
            'diff --git a/a.txt b/a.txt',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1 @@',
            '-a',
            '\\ No newline at end of file',
            '+A',
            '\\ No newline at end of file',
            '',
        ].join('\n');

        const stage = await call<any, { cwd?: string; patch?: string }>(RPC_METHODS.SCM_CHANGE_INCLUDE, {
            cwd: '.',
            patch,
        });
        expect(stage.success).toBe(true);

        const stagedDiff = git(workspace, ['diff', '--cached', '--', 'a.txt']);
        expect(stagedDiff).toContain('+A');
        expect(stagedDiff).toContain('\\ No newline at end of file');
    });

    it('unstages selected patch lines with no-newline markers', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'a');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'init']);
        writeFileSync(join(workspace, 'a.txt'), 'A');
        git(workspace, ['add', 'a.txt']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const patch = [
            'diff --git a/a.txt b/a.txt',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1 @@',
            '-a',
            '\\ No newline at end of file',
            '+A',
            '\\ No newline at end of file',
            '',
        ].join('\n');

        const unstage = await call<any, { cwd?: string; patch?: string }>(RPC_METHODS.SCM_CHANGE_EXCLUDE, {
            cwd: '.',
            patch,
        });
        expect(unstage.success).toBe(true);

        const stagedDiff = git(workspace, ['diff', '--cached', '--', 'a.txt']);
        expect(stagedDiff).toBe('');
        const unstagedDiff = git(workspace, ['diff', '--', 'a.txt']);
        expect(unstagedDiff).toContain('+A');
    });

    it('stages selected hunk patches regardless of apply.whitespace repo config', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        git(workspace, ['config', 'apply.whitespace', 'error']);
        writeFileSync(join(workspace, 'a.txt'), 'a\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'init']);
        writeFileSync(join(workspace, 'a.txt'), 'A  \n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const patch = [
            'diff --git a/a.txt b/a.txt',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1 @@',
            '-a',
            '+A  ',
            '',
        ].join('\n');

        const stage = await call<any, { cwd?: string; patch?: string }>(RPC_METHODS.SCM_CHANGE_INCLUDE, {
            cwd: '.',
            patch,
        });

        expect(stage.success).toBe(true);
        const stagedNames = git(workspace, ['diff', '--cached', '--name-only']);
        expect(stagedNames).toContain('a.txt');
    });

    it('rejects unsafe commit refs for diff-commit requests', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'init']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; commit: string }>(RPC_METHODS.SCM_DIFF_COMMIT, {
            cwd: '.',
            commit: '--name-only',
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });

    it('rejects unsafe commit refs for commit-revert requests', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'init']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; commit: string }>(RPC_METHODS.SCM_COMMIT_BACKOUT, {
            cwd: '.',
            commit: '--abort',
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
    }, 20_000);
});

import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { createTestRpcManager, runGit as git } from './testRpcHarness';

describe('git RPC handlers', () => {
    it('returns a non-repository snapshot when cwd is outside a git repository', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        const { call } = createTestRpcManager({ workingDirectory: workspace });

        const result = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: '.' });

        expect(result.success).toBe(true);
        expect(result.snapshot.repo.isRepo).toBe(false);
        expect(result.snapshot.entries).toEqual([]);
    });

    it('returns NOT_REPOSITORY for file diff requests outside a git repository', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; path: string; area?: 'included' | 'pending' | 'both' }>(
            RPC_METHODS.SCM_DIFF_FILE,
            {
                cwd: '.',
                path: 'a.txt',
                area: 'pending',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY);
    });

    it('returns NOT_REPOSITORY for commit diff requests outside a git repository', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; commit: string }>(
            RPC_METHODS.SCM_DIFF_COMMIT,
            {
                cwd: '.',
                commit: 'HEAD',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY);
    });

    it('loads file diffs even when diff.external is configured to fail', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'external-diff.sh'), '#!/bin/sh\nexit 1\n');
        chmodSync(join(workspace, 'external-diff.sh'), 0o755);
        git(workspace, ['add', 'external-diff.sh']);
        git(workspace, ['commit', '-m', 'bootstrap']);
        writeFileSync(join(workspace, 'a.txt'), 'before\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'add file']);
        writeFileSync(join(workspace, 'a.txt'), 'after\n');
        git(workspace, ['config', 'diff.external', './external-diff.sh']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const diff = await call<any, { cwd?: string; path: string; area?: 'included' | 'pending' | 'both' }>(
            RPC_METHODS.SCM_DIFF_FILE,
            {
                cwd: '.',
                path: 'a.txt',
                area: 'pending',
            },
        );

        expect(diff.success).toBe(true);
        expect(diff.diff).toContain('diff --git a/a.txt b/a.txt');
        expect(diff.diff).toContain('+after');
    });

    it('loads repo-root relative diffs when the working directory is a subdirectory', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-subdir-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);

        mkdirSync(join(workspace, '.github', 'workflows'), { recursive: true });
        const filePath = '.github/workflows/workflow.yml';
        writeFileSync(join(workspace, filePath), 'before\n');
        git(workspace, ['add', filePath]);
        git(workspace, ['commit', '-m', 'init']);

        writeFileSync(join(workspace, filePath), 'after\n');

        // Simulate a session that was started in a subdirectory of the repository.
        mkdirSync(join(workspace, 'subdir'), { recursive: true });
        const { call } = createTestRpcManager({ workingDirectory: join(workspace, 'subdir') });

        const diff = await call<any, { cwd?: string; path: string; area?: 'included' | 'pending' | 'both' }>(
            RPC_METHODS.SCM_DIFF_FILE,
            {
                path: filePath,
                area: 'pending',
            },
        );

        expect(diff.success).toBe(true);
        expect(diff.diff).toContain(`diff --git a/${filePath} b/${filePath}`);
        expect(diff.diff).toContain('+after');
    });

    it('loads commit diffs even when diff.external is configured to fail', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'external-diff.sh'), '#!/bin/sh\nexit 1\n');
        chmodSync(join(workspace, 'external-diff.sh'), 0o755);
        git(workspace, ['add', 'external-diff.sh']);
        git(workspace, ['commit', '-m', 'bootstrap']);
        writeFileSync(join(workspace, 'a.txt'), 'before\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'add file']);
        writeFileSync(join(workspace, 'a.txt'), 'after\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'update file']);
        git(workspace, ['config', 'diff.external', './external-diff.sh']);
        const sha = git(workspace, ['rev-parse', 'HEAD']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const diff = await call<any, { cwd?: string; commit: string }>(RPC_METHODS.SCM_DIFF_COMMIT, {
            cwd: '.',
            commit: sha,
        });

        expect(diff.success).toBe(true);
        expect(diff.diff).toContain('commit');
        expect(diff.diff).toContain('+after');
    });

    it('returns newline-containing paths in status snapshots', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        const newlinePath = 'dir/new\nline.txt';
        mkdirSync(join(workspace, 'dir'), { recursive: true });
        writeFileSync(join(workspace, newlinePath), 'before\n');
        git(workspace, ['add', newlinePath]);
        git(workspace, ['commit', '-m', 'init']);
        writeFileSync(join(workspace, newlinePath), 'after\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const status = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: '.' });

        expect(status.success).toBe(true);
        const entry = status.snapshot.entries.find((value: any) => value.path === newlinePath);
        expect(entry).toBeDefined();
        expect(entry.hasPendingDelta).toBe(true);
        expect(status.snapshot.totals.pendingFiles).toBeGreaterThan(0);
    });

    it('preserves rename previousPath for newline-containing paths', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);

        const oldPath = 'dir/old\nname.txt';
        const newPath = 'dir/new\nname.txt';
        mkdirSync(join(workspace, 'dir'), { recursive: true });
        writeFileSync(join(workspace, oldPath), 'content\n');
        git(workspace, ['add', oldPath]);
        git(workspace, ['commit', '-m', 'init']);

        git(workspace, ['mv', oldPath, newPath]);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const status = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: '.' });

        expect(status.success).toBe(true);
        const entry = status.snapshot.entries.find((value: any) => value.path === newPath);
        expect(entry).toBeDefined();
        expect(entry.kind).toBe('renamed');
        expect(entry.previousPath).toBe(oldPath);
    }, 20_000);

    it('returns tab-containing paths in status snapshots', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        const tabPath = 'dir/tab\tname.txt';
        mkdirSync(join(workspace, 'dir'), { recursive: true });
        writeFileSync(join(workspace, tabPath), 'before\n');
        git(workspace, ['add', tabPath]);
        git(workspace, ['commit', '-m', 'init']);
        writeFileSync(join(workspace, tabPath), 'after\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const status = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: '.' });

        expect(status.success).toBe(true);
        const entry = status.snapshot.entries.find((value: any) => value.path === tabPath);
        expect(entry).toBeDefined();
        expect(entry.hasPendingDelta).toBe(true);
    });

    it('returns unicode paths in status snapshots', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        const unicodePath = 'dir/unicodé.txt';
        mkdirSync(join(workspace, 'dir'), { recursive: true });
        writeFileSync(join(workspace, unicodePath), 'before\n');
        git(workspace, ['add', unicodePath]);
        git(workspace, ['commit', '-m', 'init']);
        writeFileSync(join(workspace, unicodePath), 'after\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const status = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: '.' });

        expect(status.success).toBe(true);
        const entry = status.snapshot.entries.find((value: any) => value.path === unicodePath);
        expect(entry).toBeDefined();
        expect(entry.hasPendingDelta).toBe(true);
    });

});

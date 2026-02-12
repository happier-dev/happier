import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    SCM_COMMIT_MESSAGE_MAX_LENGTH,
    SCM_COMMIT_PATCH_MAX_COUNT,
    SCM_COMMIT_PATCH_MAX_LENGTH,
    SCM_OPERATION_ERROR_CODES,
} from '@happier-dev/protocol';
import { createTestRpcManager, runGit as git } from './testRpcHarness';

describe('git RPC handlers', () => {
    it('rejects commit creation when message exceeds max length', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; message: string }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'x'.repeat(SCM_COMMIT_MESSAGE_MAX_LENGTH + 1),
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });

    it('supports all-pending scope for commit creation by staging pending files first', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'updated\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const commit = await call<any, { cwd?: string; message: string; scope: { kind: 'all-pending' } }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'scoped commit',
                scope: {
                    kind: 'all-pending',
                },
            },
        );
        expect(commit.success).toBe(true);

        const status = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.success).toBe(true);
        expect(status.snapshot.totals.pendingFiles).toBe(0);
    });

    it('includes unstaged, pre-staged, and untracked changes in all-pending atomic commits', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\n');
        git(workspace, ['add', 'a.txt', 'b.txt']);
        git(workspace, ['commit', '-m', 'base']);

        writeFileSync(join(workspace, 'a.txt'), 'base-a\nnext-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\nnext-b\n');
        writeFileSync(join(workspace, 'c.txt'), 'new-c\n');
        git(workspace, ['add', 'b.txt']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const commit = await call<any, { cwd?: string; message: string; scope: { kind: 'all-pending' } }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'all pending',
                scope: { kind: 'all-pending' },
            },
        );
        expect(commit.success).toBe(true);

        const committedPaths = git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])
            .split('\n')
            .map((path) => path.trim())
            .filter(Boolean)
            .sort();
        expect(committedPaths).toEqual(['a.txt', 'b.txt', 'c.txt']);
        expect(git(workspace, ['diff', '--name-only'])).toBe('');
        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('');
    });

    it('reports deterministic failure when post-commit live-index sync fails', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nnext\n');
        writeFileSync(join(workspace, '.git', 'index.lock'), '');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; message: string; scope: { kind: 'all-pending' } }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'commit while lock exists',
                scope: { kind: 'all-pending' },
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
        expect(response.error).toContain('live index');
        expect(git(workspace, ['log', '-1', '--pretty=%s'])).toBe('commit while lock exists');
    });

    it('rejects commit creation when message is missing', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, any>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
        expect(response.error).toContain('Commit message cannot be empty');
    });

    it('creates path-scoped commit without consuming unrelated pre-staged changes', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\n');
        git(workspace, ['add', 'a.txt', 'b.txt']);
        git(workspace, ['commit', '-m', 'base']);

        writeFileSync(join(workspace, 'a.txt'), 'next-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'next-b\n');
        git(workspace, ['add', 'b.txt']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; message: string; scope: { kind: 'paths'; include: string[] } }>(
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

        expect(response.success).toBe(true);
        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('a.txt');
        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('b.txt');
    });

    it('supports patch-based commit requests for virtual line selection', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nline-one\nline-two\n');

        const patch = [
            'diff --git a/a.txt b/a.txt',
            'index df967b9..9f0e218 100644',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1,2 @@',
            ' base',
            '+line-one',
            '',
        ].join('\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; message: string; patches: Array<{ path: string; patch: string }> }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'virtual line selection commit',
                patches: [{ path: 'a.txt', patch }],
            },
        );

        expect(response.success).toBe(true);
        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toContain('a.txt');
        expect(git(workspace, ['show', '--pretty=', 'HEAD'])).toContain('line-one');
        expect(git(workspace, ['show', '--pretty=', 'HEAD'])).not.toContain('line-two');
        expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('base\nline-one\nline-two\n');
    });

    it('creates patch-based commit without consuming unrelated pre-staged changes', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\n');
        git(workspace, ['add', 'a.txt', 'b.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nline-one\nline-two\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\nnext-b\n');
        git(workspace, ['add', 'b.txt']);

        const patch = [
            'diff --git a/a.txt b/a.txt',
            'index df967b9..9f0e218 100644',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1,2 @@',
            ' base',
            '+line-one',
            '',
        ].join('\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; message: string; patches: Array<{ path: string; patch: string }> }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'virtual line selection commit',
                patches: [{ path: 'a.txt', patch }],
            },
        );

        expect(response.success).toBe(true);
        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('a.txt');
        expect(git(workspace, ['show', '--pretty=', 'HEAD'])).toContain('line-one');
        expect(git(workspace, ['show', '--pretty=', 'HEAD'])).not.toContain('line-two');
        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('b.txt');
    });

    it('does not unstage pre-staged changes on the same path during patch-based atomic commits', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);

        // Pre-stage a superset of changes on the same file.
        writeFileSync(join(workspace, 'a.txt'), 'base\nline-one\nline-two\n');
        git(workspace, ['add', 'a.txt']);

        const patch = [
            'diff --git a/a.txt b/a.txt',
            'index df967b9..9f0e218 100644',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1,2 @@',
            ' base',
            '+line-one',
            '',
        ].join('\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; message: string; patches: Array<{ path: string; patch: string }> }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'partial commit preserves staged remainder',
                patches: [{ path: 'a.txt', patch }],
            },
        );

        expect(response.success).toBe(true);
        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('a.txt');

        // The live index should keep the staged-but-uncommitted remainder.
        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('a.txt');
        const cachedDiff = git(workspace, ['diff', '--cached']);
        expect(cachedDiff).toContain('+line-two');
        expect(cachedDiff).not.toContain('+line-one');
    });

    it('allows mixed path scope and patch selection by preferring patch selection for overlapping files', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\n');
        git(workspace, ['add', 'a.txt', 'b.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nline-one\nline-two\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\nline-b\n');

        const patch = [
            'diff --git a/a.txt b/a.txt',
            'index df967b9..9f0e218 100644',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1,2 @@',
            ' base',
            '+line-one',
            '',
        ].join('\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, {
            cwd?: string;
            message: string;
            scope: { kind: 'paths'; include: string[] };
            patches: Array<{ path: string; patch: string }>;
        }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'mixed selection commit',
                scope: {
                    kind: 'paths',
                    include: ['a.txt', 'b.txt'],
                },
                patches: [{ path: 'a.txt', patch }],
            },
        );

        expect(response.success).toBe(true);
        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('a.txt\nb.txt');
        expect(git(workspace, ['show', '--pretty=', 'HEAD'])).toContain('+line-one');
        expect(git(workspace, ['show', '--pretty=', 'HEAD'])).not.toContain('+line-two');
        expect(git(workspace, ['show', '--pretty=', 'HEAD'])).toContain('+line-b');
        expect(git(workspace, ['diff', '--name-only'])).toBe('a.txt');
    });

    it('rejects patch-based commit when declared path does not match patch header paths', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nline-one\n');

        const patch = [
            'diff --git a/a.txt b/a.txt',
            'index df967b9..9f0e218 100644',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1,2 @@',
            ' base',
            '+line-one',
            '',
        ].join('\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; message: string; patches: Array<{ path: string; patch: string }> }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'invalid path binding',
                patches: [{ path: 'b.txt', patch }],
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });

    it('rejects commit patch requests that exceed protocol patch count limit', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nline-one\n');

        const patch = [
            'diff --git a/a.txt b/a.txt',
            'index df967b9..9f0e218 100644',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1,2 @@',
            ' base',
            '+line-one',
            '',
        ].join('\n');

        const patches = Array.from({ length: SCM_COMMIT_PATCH_MAX_COUNT + 1 }, () => ({
            path: 'a.txt',
            patch,
        }));

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; message: string; patches: Array<{ path: string; patch: string }> }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'too many patches',
                patches,
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });

    it('rejects commit patch requests that exceed protocol patch length limit', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; message: string; patches: Array<{ path: string; patch: string }> }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'too large patch',
                patches: [{ path: 'a.txt', patch: 'x'.repeat(SCM_COMMIT_PATCH_MAX_LENGTH + 1) }],
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });

    it('returns a deterministic pre-check error when included-change inspection fails', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'next\n');
        git(workspace, ['add', 'a.txt']);

        // Corrupt index to force git diff --cached --quiet to fail deterministically.
        writeFileSync(join(workspace, '.git', 'index'), 'not-a-valid-index');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; message: string }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'commit after corruption',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
        expect(response.error).toContain('Failed to inspect included changes');
    });
});

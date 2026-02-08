import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcRequest } from '@/api/rpc/types';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { registerSessionHandlers } from '../../registerSessionHandlers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { GIT_COMMIT_MESSAGE_MAX_LENGTH, GIT_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

function createTestRpcManager(params?: { scopePrefix?: string; workingDirectory?: string }) {
    const encryptionKey = new Uint8Array(32).fill(7);
    const encryptionVariant = 'legacy' as const;
    const scopePrefix = params?.scopePrefix ?? 'machine-test';
    const workingDirectory = params?.workingDirectory ?? process.cwd();

    const manager = new RpcHandlerManager({
        scopePrefix,
        encryptionKey,
        encryptionVariant,
        logger: () => undefined,
    });

    registerSessionHandlers(manager, workingDirectory);

    async function call<TResponse, TRequest>(method: string, request: TRequest): Promise<TResponse> {
        const encryptedParams = encodeBase64(encrypt(encryptionKey, encryptionVariant, request));
        const rpcRequest: RpcRequest = {
            method: `${scopePrefix}:${method}`,
            params: encryptedParams,
        };
        const encryptedResponse = await manager.handleRequest(rpcRequest);
        const decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(encryptedResponse));
        return decrypted as TResponse;
    }

    return { call };
}

function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

describe('git RPC handlers', () => {
    it('returns a non-repository snapshot when cwd is outside a git repository', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        const { call } = createTestRpcManager({ workingDirectory: workspace });

        const result = await call<any, { cwd?: string }>(RPC_METHODS.GIT_STATUS_SNAPSHOT, { cwd: '.' });

        expect(result.success).toBe(true);
        expect(result.snapshot.repo.isGitRepo).toBe(false);
        expect(result.snapshot.entries).toEqual([]);
    });

    it('returns NOT_GIT_REPO for file diff requests outside a git repository', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; path: string; mode?: 'staged' | 'unstaged' | 'both' }>(
            RPC_METHODS.GIT_DIFF_FILE,
            {
                cwd: '.',
                path: 'a.txt',
                mode: 'unstaged',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.NOT_GIT_REPO);
    });

    it('returns NOT_GIT_REPO for commit diff requests outside a git repository', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; commit: string }>(
            RPC_METHODS.GIT_DIFF_COMMIT,
            {
                cwd: '.',
                commit: 'HEAD',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.NOT_GIT_REPO);
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
        const status = await call<any, { cwd?: string }>(RPC_METHODS.GIT_STATUS_SNAPSHOT, { cwd: '.' });

        expect(status.success).toBe(true);
        const entry = status.snapshot.entries.find((value: any) => value.path === newlinePath);
        expect(entry).toBeDefined();
        expect(entry.hasUnstagedDelta).toBe(true);
        expect(status.snapshot.totals.unstagedFiles).toBeGreaterThan(0);
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
        const status = await call<any, { cwd?: string }>(RPC_METHODS.GIT_STATUS_SNAPSHOT, { cwd: '.' });

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
        const status = await call<any, { cwd?: string }>(RPC_METHODS.GIT_STATUS_SNAPSHOT, { cwd: '.' });

        expect(status.success).toBe(true);
        const entry = status.snapshot.entries.find((value: any) => value.path === tabPath);
        expect(entry).toBeDefined();
        expect(entry.hasUnstagedDelta).toBe(true);
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
        const status = await call<any, { cwd?: string }>(RPC_METHODS.GIT_STATUS_SNAPSHOT, { cwd: '.' });

        expect(status.success).toBe(true);
        const entry = status.snapshot.entries.find((value: any) => value.path === unicodePath);
        expect(entry).toBeDefined();
        expect(entry.hasUnstagedDelta).toBe(true);
    });

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

        const stage = await call<any, { cwd?: string; paths: string[] }>(RPC_METHODS.GIT_STAGE_APPLY, {
            cwd: '.',
            paths: ['a.txt'],
        });
        expect(stage.success).toBe(true);

        const status = await call<any, { cwd?: string }>(RPC_METHODS.GIT_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.success).toBe(true);
        expect(status.snapshot.totals.stagedFiles).toBeGreaterThan(0);
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

        const stage = await call<any, { cwd?: string; patch?: string }>(RPC_METHODS.GIT_STAGE_APPLY, {
            cwd: '.',
            patch,
        });
        expect(stage.success).toBe(true);

        const status = await call<any, { cwd?: string }>(RPC_METHODS.GIT_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.success).toBe(true);
        expect(status.snapshot.totals.stagedFiles).toBe(1);
        expect(status.snapshot.totals.unstagedFiles).toBe(1);
        const entry = status.snapshot.entries.find((value: any) => value.path === 'a.txt');
        expect(entry).toBeDefined();
        expect(entry.hasStagedDelta).toBe(true);
        expect(entry.hasUnstagedDelta).toBe(true);
    });

    it('returns PATCH_APPLY_FAILED when selected hunk patch no longer matches worktree', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'a\nb\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'init']);
        writeFileSync(join(workspace, 'a.txt'), 'X\nB\n');
        // Simulate index drift: selected-lines patch was built against an older index state.
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

        const stage = await call<any, { cwd?: string; patch?: string }>(RPC_METHODS.GIT_STAGE_APPLY, {
            cwd: '.',
            patch,
        });
        expect(stage.success).toBe(false);
        expect(stage.errorCode).toBe(GIT_OPERATION_ERROR_CODES.PATCH_APPLY_FAILED);
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
        const response = await call<any, { cwd?: string; commit: string }>(RPC_METHODS.GIT_DIFF_COMMIT, {
            cwd: '.',
            commit: '--name-only',
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.INVALID_REQUEST);
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
        const response = await call<any, { cwd?: string; commit: string }>(RPC_METHODS.GIT_COMMIT_REVERT, {
            cwd: '.',
            commit: '--abort',
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.INVALID_REQUEST);
    }, 20_000);

    it('rejects unsafe remote values for push requests', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.GIT_REMOTE_PUSH,
            {
                cwd: '.',
                remote: '--force',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });

    it('returns NOT_GIT_REPO for push outside a git repository', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.GIT_REMOTE_PUSH,
            {
                cwd: '.',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.NOT_GIT_REPO);
    });

    it('rejects unsafe branch values for pull requests', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.GIT_REMOTE_PULL,
            {
                cwd: '.',
                branch: '--rebase',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });

    it('returns NOT_GIT_REPO for pull outside a git repository', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.GIT_REMOTE_PULL,
            {
                cwd: '.',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.NOT_GIT_REPO);
    });

    it('maps unknown remote failures for fetch requests', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'init']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string }>(RPC_METHODS.GIT_REMOTE_FETCH, {
            cwd: '.',
            remote: 'missing-remote',
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND);
    });

    it('returns NOT_GIT_REPO for fetch outside a git repository', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string }>(RPC_METHODS.GIT_REMOTE_FETCH, {
            cwd: '.',
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.NOT_GIT_REPO);
    });

    it('rejects unsafe remote values for fetch requests', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string }>(RPC_METHODS.GIT_REMOTE_FETCH, {
            cwd: '.',
            remote: '--upload-pack=hack',
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });

    it('fetches remote updates successfully', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-git-rpc-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branchName = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branchName]);

        const other = mkdtempSync(join(tmpdir(), 'happier-git-rpc-other-'));
        git(other, ['clone', remote, '.']);
        git(other, ['config', 'user.email', 'test@example.com']);
        git(other, ['config', 'user.name', 'Other User']);
        writeFileSync(join(other, 'remote.txt'), 'remote\n');
        git(other, ['add', 'remote.txt']);
        git(other, ['commit', '-m', 'remote update']);
        git(other, ['push', 'origin', branchName]);
        const remoteHead = git(other, ['rev-parse', 'HEAD']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string }>(RPC_METHODS.GIT_REMOTE_FETCH, {
            cwd: '.',
            remote: 'origin',
        });

        expect(response.success).toBe(true);
        const fetchedHead = git(workspace, ['rev-parse', `origin/${branchName}`]);
        expect(fetchedHead).toBe(remoteHead);
    }, 20_000);

    it('preserves commits with empty bodies when listing history', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);

        writeFileSync(join(workspace, 'a.txt'), 'one\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'first']);

        writeFileSync(join(workspace, 'a.txt'), 'two\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'second', '-m', 'second body']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; limit?: number; skip?: number }>(
            RPC_METHODS.GIT_LOG_LIST,
            {
                cwd: '.',
                limit: 2,
                skip: 0,
            },
        );

        expect(response.success).toBe(true);
        expect(response.entries).toHaveLength(2);
        expect(response.entries[0].subject).toBe('second');
        expect(response.entries[0].body).toContain('second body');
        expect(response.entries[1].subject).toBe('first');
        expect(response.entries[1].body).toBe('');
    });

    it('returns a deterministic error when reverting a merge commit', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);

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

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; commit: string }>(RPC_METHODS.GIT_COMMIT_REVERT, {
            cwd: '.',
            commit: mergeSha,
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.INVALID_REQUEST);
        expect((response.error || '').toLowerCase()).toContain('merge commit');
    }, 20_000);

    it('reverts a regular commit successfully', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'updated\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'feature change']);
        const targetSha = git(workspace, ['rev-parse', 'HEAD']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; commit: string }>(RPC_METHODS.GIT_COMMIT_REVERT, {
            cwd: '.',
            commit: targetSha,
        });

        expect(response.success).toBe(true);
        const headSubject = git(workspace, ['log', '-1', '--pretty=%s']);
        expect(headSubject.toLowerCase()).toContain('revert');
        const content = readFileSync(join(workspace, 'a.txt'), 'utf8');
        expect(content).toBe('base\n');
    });

    it('returns NOT_GIT_REPO for commit creation outside a git repository', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; message: string }>(
            RPC_METHODS.GIT_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'test',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.NOT_GIT_REPO);
    });

    it('returns NOT_GIT_REPO for commit history outside a git repository', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; limit?: number; skip?: number }>(
            RPC_METHODS.GIT_LOG_LIST,
            {
                cwd: '.',
                limit: 20,
                skip: 0,
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.NOT_GIT_REPO);
    });

    it('returns NOT_GIT_REPO for commit revert outside a git repository', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; commit: string }>(
            RPC_METHODS.GIT_COMMIT_REVERT,
            {
                cwd: '.',
                commit: 'HEAD',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.NOT_GIT_REPO);
    });

    it('blocks revert when worktree has local changes', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'dirty\n');

        const sha = git(workspace, ['rev-parse', 'HEAD']);
        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; commit: string }>(RPC_METHODS.GIT_COMMIT_REVERT, {
            cwd: '.',
            commit: sha,
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
    });

    it('blocks revert while HEAD is detached', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        const sha = git(workspace, ['rev-parse', 'HEAD']);
        git(workspace, ['checkout', '--detach']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; commit: string }>(RPC_METHODS.GIT_COMMIT_REVERT, {
            cwd: '.',
            commit: sha,
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.INVALID_REQUEST);
        expect((response.error || '').toLowerCase()).toContain('detached');
    });

    it('blocks push from detached HEAD with a deterministic error', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-git-rpc-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branchName = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branchName]);
        git(workspace, ['checkout', '--detach']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.GIT_REMOTE_PUSH,
            {
                cwd: '.',
                remote: 'origin',
                branch: branchName,
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.INVALID_REQUEST);
        expect((response.error || '').toLowerCase()).toContain('detached');
    });

    it('pushes local commits when ahead of upstream', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-git-rpc-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branchName = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branchName]);

        writeFileSync(join(workspace, 'local.txt'), 'local\n');
        git(workspace, ['add', 'local.txt']);
        git(workspace, ['commit', '-m', 'local update']);
        const localHead = git(workspace, ['rev-parse', 'HEAD']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.GIT_REMOTE_PUSH,
            {
                cwd: '.',
                remote: 'origin',
                branch: branchName,
            },
        );

        expect(response.success).toBe(true);
        const remoteHead = git(workspace, ['ls-remote', '--heads', remote, branchName]).split('\t')[0];
        expect(remoteHead).toBe(localHead);
    });

    it('blocks push when local branch is behind upstream', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-git-rpc-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branchName = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branchName]);

        const other = mkdtempSync(join(tmpdir(), 'happier-git-rpc-other-'));
        git(other, ['clone', remote, '.']);
        git(other, ['config', 'user.email', 'test@example.com']);
        git(other, ['config', 'user.name', 'Other User']);
        writeFileSync(join(other, 'other.txt'), 'other\n');
        git(other, ['add', 'other.txt']);
        git(other, ['commit', '-m', 'other']);
        git(other, ['push', 'origin', branchName]);

        git(workspace, ['fetch', 'origin']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.GIT_REMOTE_PUSH,
            {
                cwd: '.',
                remote: 'origin',
                branch: branchName,
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD);
        expect((response.error || '').toLowerCase()).toContain('behind');
    });

    it('blocks pull from detached HEAD with a deterministic error', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-git-rpc-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branchName = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branchName]);
        git(workspace, ['checkout', '--detach']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.GIT_REMOTE_PULL,
            {
                cwd: '.',
                remote: 'origin',
                branch: branchName,
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.INVALID_REQUEST);
        expect((response.error || '').toLowerCase()).toContain('detached');
    });

    it('blocks pull without upstream tracking branch with a deterministic error', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-git-rpc-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.GIT_REMOTE_PULL,
            {
                cwd: '.',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
    });

    it('blocks pull when worktree is dirty', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-git-rpc-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branchName = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branchName]);

        // Local uncommitted change should block pull.
        writeFileSync(join(workspace, 'a.txt'), 'dirty\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.GIT_REMOTE_PULL,
            {
                cwd: '.',
                remote: 'origin',
                branch: branchName,
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
    });

    it('pulls fast-forward updates when worktree is clean', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-git-rpc-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branchName = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branchName]);

        const other = mkdtempSync(join(tmpdir(), 'happier-git-rpc-other-'));
        git(other, ['clone', remote, '.']);
        git(other, ['config', 'user.email', 'test@example.com']);
        git(other, ['config', 'user.name', 'Other User']);
        writeFileSync(join(other, 'remote.txt'), 'from-remote\n');
        git(other, ['add', 'remote.txt']);
        git(other, ['commit', '-m', 'remote update']);
        git(other, ['push', 'origin', branchName]);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.GIT_REMOTE_PULL,
            {
                cwd: '.',
                remote: 'origin',
                branch: branchName,
            },
        );

        expect(response.success).toBe(true);
        const pulledFile = execFileSync('cat', [join(workspace, 'remote.txt')], { encoding: 'utf8' });
        expect(pulledFile).toBe('from-remote\n');
    });

    it('returns ff-only error when local and remote branches diverge', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-git-rpc-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'base.txt'), 'base\n');
        git(workspace, ['add', 'base.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branchName = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branchName]);

        // Local-only commit.
        writeFileSync(join(workspace, 'local.txt'), 'local\n');
        git(workspace, ['add', 'local.txt']);
        git(workspace, ['commit', '-m', 'local']);

        // Remote-only commit from another clone.
        const other = mkdtempSync(join(tmpdir(), 'happier-git-rpc-other-'));
        git(other, ['clone', remote, '.']);
        git(other, ['config', 'user.email', 'test@example.com']);
        git(other, ['config', 'user.name', 'Other User']);
        writeFileSync(join(other, 'remote.txt'), 'remote\n');
        git(other, ['add', 'remote.txt']);
        git(other, ['commit', '-m', 'remote']);
        git(other, ['push', 'origin', branchName]);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.GIT_REMOTE_PULL,
            {
                cwd: '.',
                remote: 'origin',
                branch: branchName,
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.REMOTE_FF_ONLY_REQUIRED);
    });

    it('pulls with explicit remote/branch even when upstream is not configured', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-git-rpc-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branchName = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        // Push without tracking configuration.
        git(workspace, ['push', 'origin', branchName]);

        const upstream = mkdtempSync(join(tmpdir(), 'happier-git-rpc-other-'));
        git(upstream, ['clone', remote, '.']);
        git(upstream, ['config', 'user.email', 'test@example.com']);
        git(upstream, ['config', 'user.name', 'Other User']);
        writeFileSync(join(upstream, 'from-remote.txt'), 'remote\n');
        git(upstream, ['add', 'from-remote.txt']);
        git(upstream, ['commit', '-m', 'remote update']);
        git(upstream, ['push', 'origin', branchName]);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.GIT_REMOTE_PULL,
            {
                cwd: '.',
                remote: 'origin',
                branch: branchName,
            },
        );

        expect(response.success).toBe(true);
        const pulledFile = execFileSync('cat', [join(workspace, 'from-remote.txt')], { encoding: 'utf8' });
        expect(pulledFile).toBe('remote\n');
    });

    it('pushes with explicit remote/branch even when upstream is not configured', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-git-rpc-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branchName = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', 'origin', branchName]);

        writeFileSync(join(workspace, 'local-explicit.txt'), 'local\n');
        git(workspace, ['add', 'local-explicit.txt']);
        git(workspace, ['commit', '-m', 'local update']);
        const localHead = git(workspace, ['rev-parse', 'HEAD']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.GIT_REMOTE_PUSH,
            {
                cwd: '.',
                remote: 'origin',
                branch: branchName,
            },
        );

        expect(response.success).toBe(true);
        const remoteHead = git(workspace, ['ls-remote', '--heads', remote, branchName]).split('\t')[0];
        expect(remoteHead).toBe(localHead);
    });

    it('blocks push when the repository has unresolved merge conflicts', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-git-rpc-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branchName = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branchName]);

        const other = mkdtempSync(join(tmpdir(), 'happier-git-rpc-other-'));
        git(other, ['clone', remote, '.']);
        git(other, ['config', 'user.email', 'test@example.com']);
        git(other, ['config', 'user.name', 'Other User']);
        writeFileSync(join(other, 'a.txt'), 'remote-change\n');
        git(other, ['add', 'a.txt']);
        git(other, ['commit', '-m', 'remote change']);
        git(other, ['push', 'origin', branchName]);

        writeFileSync(join(workspace, 'a.txt'), 'local-change\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'local change']);
        git(workspace, ['fetch', 'origin']);
        try {
            git(workspace, ['merge', `origin/${branchName}`]);
        } catch {
            // Expected merge conflict state.
        }

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.GIT_REMOTE_PUSH,
            {
                cwd: '.',
                remote: 'origin',
                branch: branchName,
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
    });

    it('rejects commit creation when message exceeds max length', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; message: string }>(
            RPC_METHODS.GIT_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'x'.repeat(GIT_COMMIT_MESSAGE_MAX_LENGTH + 1),
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.INVALID_REQUEST);
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
            RPC_METHODS.GIT_COMMIT_CREATE,
            {
                cwd: '.',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(GIT_OPERATION_ERROR_CODES.INVALID_REQUEST);
        expect(response.error).toContain('Commit message cannot be empty');
    });
});

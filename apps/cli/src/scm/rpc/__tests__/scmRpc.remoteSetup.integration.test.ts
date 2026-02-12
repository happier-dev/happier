import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SCM_COMMIT_MESSAGE_MAX_LENGTH, SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { createTestRpcManager, runGit as git } from './testRpcHarness';

describe('git RPC handlers', () => {
    it('rejects unsafe remote values for push requests', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.SCM_REMOTE_PUSH,
            {
                cwd: '.',
                remote: '--force',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });

    it('returns NOT_REPOSITORY for push outside a git repository', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.SCM_REMOTE_PUSH,
            {
                cwd: '.',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY);
    });

    it('rejects unsafe branch values for pull requests', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.SCM_REMOTE_PULL,
            {
                cwd: '.',
                branch: '--rebase',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });

    it('returns NOT_REPOSITORY for pull outside a git repository', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.SCM_REMOTE_PULL,
            {
                cwd: '.',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY);
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
        const response = await call<any, { cwd?: string; remote?: string }>(RPC_METHODS.SCM_REMOTE_FETCH, {
            cwd: '.',
            remote: 'missing-remote',
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND);
    });

    it('returns NOT_REPOSITORY for fetch outside a git repository', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string }>(RPC_METHODS.SCM_REMOTE_FETCH, {
            cwd: '.',
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY);
    });

    it('rejects unsafe remote values for fetch requests', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-'));
        git(workspace, ['init']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string }>(RPC_METHODS.SCM_REMOTE_FETCH, {
            cwd: '.',
            remote: '--upload-pack=hack',
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
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
        const response = await call<any, { cwd?: string; remote?: string }>(RPC_METHODS.SCM_REMOTE_FETCH, {
            cwd: '.',
            remote: 'origin',
        });

        expect(response.success).toBe(true);
        const fetchedHead = git(workspace, ['rev-parse', `origin/${branchName}`]);
        expect(fetchedHead).toBe(remoteHead);
    }, 20_000);
});

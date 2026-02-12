import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { createTestRpcManager, runGit as git } from './testRpcHarness';

describe('git RPC handlers', () => {
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
            RPC_METHODS.SCM_REMOTE_PUSH,
            {
                cwd: '.',
                remote: 'origin',
                branch: branchName,
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
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
            RPC_METHODS.SCM_REMOTE_PUSH,
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
            RPC_METHODS.SCM_REMOTE_PUSH,
            {
                cwd: '.',
                remote: 'origin',
                branch: branchName,
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD);
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
            RPC_METHODS.SCM_REMOTE_PULL,
            {
                cwd: '.',
                remote: 'origin',
                branch: branchName,
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
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
            RPC_METHODS.SCM_REMOTE_PULL,
            {
                cwd: '.',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
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

        writeFileSync(join(workspace, 'a.txt'), 'dirty\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; remote?: string; branch?: string }>(
            RPC_METHODS.SCM_REMOTE_PULL,
            {
                cwd: '.',
                remote: 'origin',
                branch: branchName,
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
    });

});

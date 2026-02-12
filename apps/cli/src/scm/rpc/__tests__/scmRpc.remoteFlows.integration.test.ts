import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { createTestRpcManager, runGit as git } from './testRpcHarness';

describe('git RPC handlers', () => {
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
            RPC_METHODS.SCM_REMOTE_PULL,
            {
                cwd: '.',
                remote: 'origin',
                branch: branchName,
            },
        );

        expect(response.success).toBe(true);
        const pulledFile = readFileSync(join(workspace, 'remote.txt'), 'utf8');
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

        writeFileSync(join(workspace, 'local.txt'), 'local\n');
        git(workspace, ['add', 'local.txt']);
        git(workspace, ['commit', '-m', 'local']);

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
            RPC_METHODS.SCM_REMOTE_PULL,
            {
                cwd: '.',
                remote: 'origin',
                branch: branchName,
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_FF_ONLY_REQUIRED);
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
            RPC_METHODS.SCM_REMOTE_PULL,
            {
                cwd: '.',
                remote: 'origin',
                branch: branchName,
            },
        );

        expect(response.success).toBe(true);
        const pulledFile = readFileSync(join(workspace, 'from-remote.txt'), 'utf8');
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
            RPC_METHODS.SCM_REMOTE_PUSH,
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

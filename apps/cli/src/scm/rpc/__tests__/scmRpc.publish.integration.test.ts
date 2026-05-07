import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createTestRpcManager, runGit as git } from './testRpcHarness';

describe('git RPC handlers (publish)', () => {
    it('reports configured remotes in status snapshots', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-git-status-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-status-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['remote', 'add', 'origin', remote]);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const status = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: '.' });

        expect(status.success).toBe(true);
        expect(status.snapshot.repo.remotes).toEqual([
            {
                name: 'origin',
                fetchUrl: remote,
                pushUrl: remote,
            },
        ]);
    });

    it('publishes the current branch by setting upstream and pushing', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-git-publish-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-publish-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);

        git(workspace, ['checkout', '-b', 'publish-branch']);
        const branchName = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const publish = await call<any, { cwd?: string; remote?: string }>(RPC_METHODS.SCM_REMOTE_PUBLISH, {
            cwd: '.',
            remote: 'origin',
        });

        expect(publish.success).toBe(true);

        const upstream = git(workspace, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
        expect(upstream).toBe(`origin/${branchName}`);
        expect(git(workspace, ['ls-remote', '--heads', remote, branchName])).toContain('\trefs/heads/');
    });

    it('rejects publish with a clear no-remote error before setting upstream', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-publish-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['checkout', '-b', 'publish-branch']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const publish = await call<any, { cwd?: string; remote?: string }>(RPC_METHODS.SCM_REMOTE_PUBLISH, {
            cwd: '.',
        });

        expect(publish).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND,
        });
        expect(publish.error).toContain('Add a Git remote before publishing');
        expect(() =>
            git(workspace, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
        ).toThrow(/no upstream configured/i);
    });

    it('rejects option-like remote names before running git push', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-git-publish-remote-'));
        git(remote, ['init', '--bare']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-publish-rpc-'));
        git(workspace, ['init']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);

        git(workspace, ['checkout', '-b', 'publish-branch']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const publish = await call<any, { cwd?: string; remote?: string }>(RPC_METHODS.SCM_REMOTE_PUBLISH, {
            cwd: '.',
            remote: '--upload-pack=hack',
        });

        expect(publish).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: 'Remote name cannot start with "-"',
        });
        expect(() =>
            git(workspace, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
        ).toThrow(/no upstream configured/i);
    });
});

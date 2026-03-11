import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createTestRpcManager, runGit as git } from './testRpcHarness';

describe('git RPC handlers (publish)', () => {
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
});


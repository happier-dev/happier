import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createTestRpcManager, runGit as git } from './testRpcHarness';

function initGitWorkspace(): { workspace: string; head: string } {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-git-branches-rpc-'));
    git(workspace, ['init']);
    git(workspace, ['config', 'user.email', 'test@example.com']);
    git(workspace, ['config', 'user.name', 'Test User']);
    writeFileSync(join(workspace, 'a.txt'), 'base-1\nbase-2\nbase-3\n');
    git(workspace, ['add', 'a.txt']);
    git(workspace, ['commit', '-m', 'base']);
    const head = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return { workspace, head };
}

describe('git RPC handlers (branches + stash)', () => {
    it('lists local branches and indicates current branch', async () => {
        const { workspace, head } = initGitWorkspace();
        git(workspace, ['branch', 'feature']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; includeRemotes?: boolean }>(
            RPC_METHODS.SCM_BRANCH_LIST,
            {
                cwd: '.',
                includeRemotes: false,
            },
        );

        expect(response.success).toBe(true);
        expect(response.branches?.some((branch: any) => branch.name === head && branch.isCurrent)).toBe(true);
        expect(response.branches?.some((branch: any) => branch.name === 'feature')).toBe(true);
    });

    it('lists remote branches when requested', async () => {
        const { workspace, head } = initGitWorkspace();
        const remote = mkdtempSync(join(tmpdir(), 'happier-git-branches-remote-'));
        git(remote, ['init', '--bare']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        git(workspace, ['push', '--set-upstream', 'origin', head]);
        git(workspace, ['branch', 'feature']);
        git(workspace, ['push', 'origin', 'feature']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; includeRemotes?: boolean }>(
            RPC_METHODS.SCM_BRANCH_LIST,
            {
                cwd: '.',
                includeRemotes: true,
            },
        );

        expect(response.success).toBe(true);
        expect(response.branches?.some((branch: any) => branch.type === 'remote' && branch.name === `origin/${head}`)).toBe(true);
        expect(response.branches?.some((branch: any) => branch.type === 'remote' && branch.name === 'origin/feature')).toBe(true);
    });

    it('creates and checks out branches when requested', async () => {
        const { workspace } = initGitWorkspace();

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const create = await call<any, { cwd?: string; name: string; checkout?: boolean }>(
            RPC_METHODS.SCM_BRANCH_CREATE,
            {
                cwd: '.',
                name: 'new-branch',
                checkout: true,
            },
        );

        expect(create.success).toBe(true);
        const list = await call<any, { cwd?: string; includeRemotes?: boolean }>(RPC_METHODS.SCM_BRANCH_LIST, {
            cwd: '.',
        });
        expect(list.success).toBe(true);
        expect(list.branches?.some((branch: any) => branch.name === 'new-branch' && branch.isCurrent)).toBe(true);
    });

    it('creates a worktree through SCM worktree RPCs', async () => {
        const { workspace } = initGitWorkspace();

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const create = await call<any, { cwd?: string; displayName?: string; baseRef?: string }>(
            RPC_METHODS.SCM_WORKTREE_CREATE,
            {
                cwd: '.',
                displayName: 'feature-auth',
                baseRef: 'HEAD',
            },
        );

        expect(create.success).toBe(true);
        expect(create.branchName).toBe('feature-auth');
        expect(create.worktreePath).toContain('/.dev/worktree/feature-auth');
        expect(git(workspace, ['worktree', 'list', '--porcelain'])).toContain(`worktree ${create.worktreePath}`);
        expect(git(create.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feature-auth');
    });

    it('stashes on current branch when switching with stash strategy', async () => {
        const { workspace } = initGitWorkspace();
        git(workspace, ['switch', '-c', 'feature>stash']);
        git(workspace, ['branch', 'other']);
        writeFileSync(join(workspace, 'untracked.txt'), 'hello\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const checkout = await call<any, { cwd?: string; name: string; strategy: string }>(
            RPC_METHODS.SCM_BRANCH_CHECKOUT,
            {
                cwd: '.',
                name: 'other',
                strategy: 'stash_on_current_branch',
            },
        );

        expect(checkout.success).toBe(true);
        expect(git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('other');
        expect(git(workspace, ['status', '--porcelain'])).toBe('');

        const stashList = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STASH_LIST, { cwd: '.' });
        expect(stashList.success).toBe(true);
        expect(stashList.managedCount).toBe(1);
        expect(stashList.managedStashes?.[0]).toEqual(
            expect.objectContaining({
                kind: 'branch',
                branch: 'feature>stash',
            }),
        );
    });

    it('brings changes by using a transient stash when checkout is blocked', async () => {
        const { workspace } = initGitWorkspace();
        git(workspace, ['branch', 'other']);
        git(workspace, ['switch', 'other']);
        writeFileSync(join(workspace, 'a.txt'), 'base-1\nbase-2\nother-3\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'other update']);
        git(workspace, ['switch', '-']);

        writeFileSync(join(workspace, 'a.txt'), 'local-1\nbase-2\nbase-3\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const checkout = await call<any, { cwd?: string; name: string; strategy: string }>(
            RPC_METHODS.SCM_BRANCH_CHECKOUT,
            {
                cwd: '.',
                name: 'other',
                strategy: 'bring_changes',
            },
        );

        expect(checkout.success).toBe(true);
        expect(git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('other');
        const content = readFileSync(join(workspace, 'a.txt'), 'utf8');
        expect(content).toContain('local-1');
        expect(content).toContain('other-3');
        expect(git(workspace, ['stash', 'list'])).not.toContain('!!HappierTransient<other>');
    });

    it('keeps the transient stash when stash pop conflicts', async () => {
        const { workspace } = initGitWorkspace();
        git(workspace, ['branch', 'other>target']);
        git(workspace, ['switch', 'other>target']);
        writeFileSync(join(workspace, 'a.txt'), 'other\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'other update']);
        git(workspace, ['switch', '-']);

        writeFileSync(join(workspace, 'a.txt'), 'local\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const checkout = await call<any, { cwd?: string; name: string; strategy: string }>(
            RPC_METHODS.SCM_BRANCH_CHECKOUT,
            {
                cwd: '.',
                name: 'other>target',
                strategy: 'bring_changes',
            },
        );

        expect(checkout.success).toBe(false);
        expect(checkout.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED);

        const stashList = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STASH_LIST, { cwd: '.' });
        expect(stashList.success).toBe(true);
        expect(stashList.managedCount).toBe(1);
        expect(stashList.managedStashes?.[0]).toEqual(
            expect.objectContaining({
                kind: 'transient',
                branch: 'other>target',
            }),
        );
    });

    it('removes sibling worktrees through SCM worktree RPCs', async () => {
        const { workspace } = initGitWorkspace();
        const worktreePath = join(workspace, '.dev', 'worktree', 'feature-auth');
        git(workspace, ['worktree', 'add', worktreePath, '-b', 'feature-auth']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const remove = await call<any, { cwd?: string; worktreePath: string }>(
            RPC_METHODS.SCM_WORKTREE_REMOVE,
            {
                cwd: '.',
                worktreePath,
            },
        );

        expect(remove.success).toBe(true);
        expect(git(workspace, ['worktree', 'list', '--porcelain'])).not.toContain(`worktree ${worktreePath}`);
    });

    it('prunes stale sibling worktrees through SCM worktree RPCs', async () => {
        const { workspace } = initGitWorkspace();
        const worktreePath = join(workspace, '.dev', 'worktree', 'feature-prune');
        git(workspace, ['worktree', 'add', worktreePath, '-b', 'feature-prune']);
        rmSync(worktreePath, { recursive: true, force: true });

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const prune = await call<any, { cwd?: string }>(
            RPC_METHODS.SCM_WORKTREE_PRUNE,
            {
                cwd: '.',
            },
        );

        expect(prune.success).toBe(true);
        expect(git(workspace, ['worktree', 'list', '--porcelain'])).not.toContain(`worktree ${worktreePath}`);
    });
});

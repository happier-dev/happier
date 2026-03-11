import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createTestRpcManager, runGit as git } from './testRpcHarness';
import { buildHappierBranchStashMarker } from '../../backends/git/operations/stashOperations';

function initGitWorkspace(): { workspace: string; head: string } {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-git-stash-rpc-'));
    git(workspace, ['init']);
    git(workspace, ['config', 'user.email', 'test@example.com']);
    git(workspace, ['config', 'user.name', 'Test User']);
    writeFileSync(join(workspace, 'a.txt'), 'base\n');
    git(workspace, ['add', 'a.txt']);
    git(workspace, ['commit', '-m', 'base']);
    const head = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return { workspace, head };
}

describe('git RPC handlers (stash)', () => {
    it('lists only managed stashes and reports counts', async () => {
        const { workspace, head } = initGitWorkspace();

        writeFileSync(join(workspace, 'unmanaged.txt'), 'unmanaged\n');
        git(workspace, ['stash', 'push', '-u', '-m', 'unmanaged']);

        writeFileSync(join(workspace, 'managed.txt'), 'managed\n');
        git(workspace, ['stash', 'push', '-u', '-m', `!!Happier<${head}>`]);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const list = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STASH_LIST, { cwd: '.' });

        expect(list.success).toBe(true);
        expect(list.totalCount).toBe(2);
        expect(list.managedCount).toBe(1);
        expect(list.managedStashes).toHaveLength(1);
        expect(list.managedStashes?.[0]?.stashRef).toMatch(/^stash@\{\d+\}$/);
        expect(list.managedStashes?.[0]?.branch).toBe(head);
    });

    it('shows and drops a managed stash', async () => {
        const { workspace, head } = initGitWorkspace();

        writeFileSync(join(workspace, 'managed.txt'), 'managed\n');
        git(workspace, ['stash', 'push', '-u', '-m', `!!Happier<${head}>`]);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const list = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STASH_LIST, { cwd: '.' });
        expect(list.success).toBe(true);
        const stashRef = list.managedStashes?.[0]?.stashRef;
        expect(typeof stashRef).toBe('string');
        if (typeof stashRef !== 'string') {
            throw new Error('expected stashRef');
        }

        const show = await call<any, { cwd?: string; stashRef: string; maxBytes?: number }>(
            RPC_METHODS.SCM_STASH_SHOW,
            {
                cwd: '.',
                stashRef,
                maxBytes: 200_000,
            },
        );
        expect(show.success).toBe(true);
        expect(show.diff).toContain('diff --git');

        const drop = await call<any, { cwd?: string; stashRef: string }>(RPC_METHODS.SCM_STASH_DROP, {
            cwd: '.',
            stashRef,
        });
        expect(drop.success).toBe(true);

        const after = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STASH_LIST, { cwd: '.' });
        expect(after.success).toBe(true);
        expect(after.managedCount).toBe(0);
    });

    it('pops a managed stash and restores its files', async () => {
        const { workspace, head } = initGitWorkspace();

        writeFileSync(join(workspace, 'pop.txt'), 'pop\n');
        git(workspace, ['stash', 'push', '-u', '-m', `!!Happier<${head}>`]);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const list = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STASH_LIST, { cwd: '.' });
        expect(list.success).toBe(true);
        const stashRef = list.managedStashes?.[0]?.stashRef;
        expect(typeof stashRef).toBe('string');
        if (typeof stashRef !== 'string') {
            throw new Error('expected stashRef');
        }

        const pop = await call<any, { cwd?: string; stashRef: string }>(RPC_METHODS.SCM_STASH_POP, {
            cwd: '.',
            stashRef,
        });
        expect(pop.success).toBe(true);
        expect(existsSync(join(workspace, 'pop.txt'))).toBe(true);
        expect(readFileSync(join(workspace, 'pop.txt'), 'utf8')).toBe('pop\n');

        const after = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STASH_LIST, { cwd: '.' });
        expect(after.success).toBe(true);
        expect(after.managedCount).toBe(0);
    });

    it('applies a managed stash without removing it from the stash list', async () => {
        const { workspace, head } = initGitWorkspace();

        writeFileSync(join(workspace, 'apply.txt'), 'apply\n');
        git(workspace, ['stash', 'push', '-u', '-m', `!!Happier<${head}>`]);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const list = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STASH_LIST, { cwd: '.' });
        expect(list.success).toBe(true);
        const stashRef = list.managedStashes?.[0]?.stashRef;
        expect(typeof stashRef).toBe('string');
        if (typeof stashRef !== 'string') {
            throw new Error('expected stashRef');
        }

        const apply = await call<any, { cwd?: string; stashRef: string }>(RPC_METHODS.SCM_STASH_APPLY, {
            cwd: '.',
            stashRef,
        });
        expect(apply.success).toBe(true);
        expect(existsSync(join(workspace, 'apply.txt'))).toBe(true);
        expect(readFileSync(join(workspace, 'apply.txt'), 'utf8')).toBe('apply\n');

        const after = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STASH_LIST, { cwd: '.' });
        expect(after.success).toBe(true);
        expect(after.managedCount).toBe(1);
        expect(after.managedStashes?.[0]?.stashRef).toBe(stashRef);
    });

    it('returns the actual created stash ref when using branch checkout with stash strategy', async () => {
        const { workspace, head } = initGitWorkspace();

        // Create an unmanaged stash first so stash@{0} won't be our managed stash
        writeFileSync(join(workspace, 'unmanaged.txt'), 'unmanaged\n');
        git(workspace, ['stash', 'push', '-u', '-m', 'unmanaged']);

        // Create a branch to switch to
        git(workspace, ['branch', 'other']);

        // Create a file that will be stashed when we switch branches
        writeFileSync(join(workspace, 'managed.txt'), 'managed\n');

        // Switch branches with stash strategy - this calls createGitStashPush
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
        expect(checkout.didCreateStash).toBe(true);
        expect(checkout.stashRef).toBeDefined();

        // Verify the stash list to see where our managed stash actually is
        const stashList = git(workspace, ['stash', 'list']);
        const lines = stashList.split('\n').filter(Boolean);
        expect(lines.length).toBe(2);

        // Find which index has our managed stash
        const managedIndex = lines.findIndex((line) => line.includes(`!!Happier<${head}>`));
        expect(managedIndex).toBeGreaterThanOrEqual(0);

        // The returned stashRef should match the actual position of our managed stash
        const expectedRef = `stash@{${managedIndex}}`;
        expect(checkout.stashRef).toBe(expectedRef);

        // Verify we can actually show the correct stash using the returned ref
        const show = await call<any, { cwd?: string; stashRef: string; maxBytes?: number }>(
            RPC_METHODS.SCM_STASH_SHOW,
            {
                cwd: '.',
                stashRef: checkout.stashRef ?? '',
                maxBytes: 200_000,
            },
        );
        expect(show.success).toBe(true);
        expect(show.diff).toContain('managed.txt');
    });

    it('lists a managed stash for branch names containing > using the decoded branch name', async () => {
        const { workspace } = initGitWorkspace();
        const complexBranch = 'feature>qa%branch';
        git(workspace, ['branch', '-m', complexBranch]);

        writeFileSync(join(workspace, 'encoded.txt'), 'encoded\n');
        git(workspace, ['stash', 'push', '-u', '-m', buildHappierBranchStashMarker(complexBranch)]);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const list = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STASH_LIST, { cwd: '.' });

        expect(list.success).toBe(true);
        expect(list.managedCount).toBe(1);
        expect(list.managedStashes?.[0]?.branch).toBe(complexBranch);
    });
});

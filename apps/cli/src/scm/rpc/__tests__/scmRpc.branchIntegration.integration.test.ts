import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { createTestRpcManager, runGit as git } from './testRpcHarness';

const SCM_BRANCH_MERGE = 'scm.branch.merge';
const SCM_BRANCH_REBASE = 'scm.branch.rebase';
const SCM_BRANCH_OPERATION_CONTINUE = 'scm.branch.operation.continue';
const SCM_BRANCH_OPERATION_ABORT = 'scm.branch.operation.abort';
const SCM_STATUS_SNAPSHOT = 'scm.status.snapshot';

function initWorkspace(): string {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-git-branch-integration-rpc-'));
    git(workspace, ['init']);
    git(workspace, ['config', 'user.email', 'test@example.com']);
    git(workspace, ['config', 'user.name', 'Test User']);
    writeFileSync(join(workspace, 'a.txt'), 'base\n');
    git(workspace, ['add', 'a.txt']);
    git(workspace, ['commit', '-m', 'base']);
    return workspace;
}

function createDivergedBranches(workspace: string): void {
    git(workspace, ['checkout', '-b', 'feature']);
    writeFileSync(join(workspace, 'feature.txt'), 'feature\n');
    git(workspace, ['add', 'feature.txt']);
    git(workspace, ['commit', '-m', 'feature']);
    git(workspace, ['checkout', '-']);
    writeFileSync(join(workspace, 'main.txt'), 'main\n');
    git(workspace, ['add', 'main.txt']);
    git(workspace, ['commit', '-m', 'main']);
}

function createConflictingBranches(workspace: string): void {
    git(workspace, ['checkout', '-b', 'feature']);
    writeFileSync(join(workspace, 'a.txt'), 'feature\n');
    git(workspace, ['add', 'a.txt']);
    git(workspace, ['commit', '-m', 'feature']);
    git(workspace, ['checkout', '-']);
    writeFileSync(join(workspace, 'a.txt'), 'main\n');
    git(workspace, ['add', 'a.txt']);
    git(workspace, ['commit', '-m', 'main']);
}

describe('git RPC handlers (branch integration)', () => {
    it('merges a local branch into the current branch', async () => {
        const workspace = initWorkspace();
        createDivergedBranches(workspace);
        const mainHead = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const merge = await call<any, { cwd?: string; sourceRef: string }>(SCM_BRANCH_MERGE, {
            cwd: '.',
            sourceRef: 'feature',
        });

        expect(merge.success).toBe(true);
        expect(git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(mainHead);
        expect(readFileSync(join(workspace, 'feature.txt'), 'utf8')).toBe('feature\n');
    });

    it('merges a remote-tracking branch into the current branch', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-git-branch-integration-remote-'));
        git(remote, ['init', '--bare']);

        const seed = mkdtempSync(join(tmpdir(), 'happier-git-branch-integration-seed-'));
        git(seed, ['clone', remote, '.']);
        git(seed, ['config', 'user.email', 'test@example.com']);
        git(seed, ['config', 'user.name', 'Test User']);
        writeFileSync(join(seed, 'a.txt'), 'base\n');
        git(seed, ['add', 'a.txt']);
        git(seed, ['commit', '-m', 'base']);
        const branchName = git(seed, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(seed, ['push', '-u', 'origin', branchName]);
        git(seed, ['checkout', '-b', 'feature']);
        writeFileSync(join(seed, 'remote-feature.txt'), 'remote feature\n');
        git(seed, ['add', 'remote-feature.txt']);
        git(seed, ['commit', '-m', 'remote feature']);
        git(seed, ['push', 'origin', 'feature']);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-branch-integration-clone-'));
        git(workspace, ['clone', remote, '.']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        git(workspace, ['fetch', 'origin']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const merge = await call<any, { cwd?: string; sourceRef: string }>(SCM_BRANCH_MERGE, {
            cwd: '.',
            sourceRef: 'origin/feature',
        });

        expect(merge.success).toBe(true);
        expect(readFileSync(join(workspace, 'remote-feature.txt'), 'utf8')).toBe('remote feature\n');
    });

    it('rebases the current branch onto the selected source ref', async () => {
        const workspace = initWorkspace();
        const baseBranch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        createDivergedBranches(workspace);
        const baseBranchHead = git(workspace, ['rev-parse', baseBranch]);
        git(workspace, ['checkout', 'feature']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const rebase = await call<any, { cwd?: string; sourceRef: string }>(SCM_BRANCH_REBASE, {
            cwd: '.',
            sourceRef: baseBranch,
        });

        expect(rebase.success).toBe(true);
        const parent = git(workspace, ['rev-parse', 'HEAD^']);
        expect(parent).toBe(baseBranchHead);
    });

    it('rejects merge when the worktree is dirty', async () => {
        const workspace = initWorkspace();
        git(workspace, ['branch', 'feature']);
        writeFileSync(join(workspace, 'dirty.txt'), 'dirty\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const merge = await call<any, { cwd?: string; sourceRef: string }>(SCM_BRANCH_MERGE, {
            cwd: '.',
            sourceRef: 'feature',
        });

        expect(merge).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
        });
    });

    it('rejects rebase from detached HEAD', async () => {
        const workspace = initWorkspace();
        git(workspace, ['branch', 'feature']);
        git(workspace, ['checkout', '--detach']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const rebase = await call<any, { cwd?: string; sourceRef: string }>(SCM_BRANCH_REBASE, {
            cwd: '.',
            sourceRef: 'feature',
        });

        expect(rebase).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
    });

    it('rejects starting branch integration while another operation is in progress', async () => {
        const workspace = initWorkspace();
        createConflictingBranches(workspace);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        await call<any, { cwd?: string; sourceRef: string }>(SCM_BRANCH_MERGE, {
            cwd: '.',
            sourceRef: 'feature',
        });

        const rebase = await call<any, { cwd?: string; sourceRef: string }>(SCM_BRANCH_REBASE, {
            cwd: '.',
            sourceRef: 'feature',
        });

        expect(rebase).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.BRANCH_OPERATION_IN_PROGRESS,
            operationState: {
                kind: 'merge',
            },
        });
    });

    it('returns not-in-progress for branch operation control without matching state', async () => {
        const workspace = initWorkspace();

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const continued = await call<any, { cwd?: string; operation: 'merge' }>(SCM_BRANCH_OPERATION_CONTINUE, {
            cwd: '.',
            operation: 'merge',
        });

        expect(continued).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.BRANCH_OPERATION_NOT_IN_PROGRESS,
        });
    });

    it('continues a merge after conflict resolution and clears operation state', async () => {
        const workspace = initWorkspace();
        createConflictingBranches(workspace);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const merge = await call<any, { cwd?: string; sourceRef: string }>(SCM_BRANCH_MERGE, {
            cwd: '.',
            sourceRef: 'feature',
        });

        expect(merge.success).toBe(false);
        expect(merge.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);

        const conflictedStatus = await call<any, { cwd?: string }>(SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(conflictedStatus.snapshot.operationState).toMatchObject({
            kind: 'merge',
            canContinue: true,
            canAbort: true,
        });

        writeFileSync(join(workspace, 'a.txt'), 'main\nfeature\n');
        git(workspace, ['add', 'a.txt']);

        const continued = await call<any, { cwd?: string; operation: 'merge' }>(SCM_BRANCH_OPERATION_CONTINUE, {
            cwd: '.',
            operation: 'merge',
        });
        expect(continued.success).toBe(true);

        const status = await call<any, { cwd?: string }>(SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.snapshot.operationState).toBeNull();
        expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('main\nfeature\n');
    });

    it('aborts a merge conflict operation and clears operation state', async () => {
        const workspace = initWorkspace();
        createConflictingBranches(workspace);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        await call<any, { cwd?: string; sourceRef: string }>(SCM_BRANCH_MERGE, {
            cwd: '.',
            sourceRef: 'feature',
        });

        const abort = await call<any, { cwd?: string; operation: 'merge' }>(SCM_BRANCH_OPERATION_ABORT, {
            cwd: '.',
            operation: 'merge',
        });
        expect(abort.success).toBe(true);

        const status = await call<any, { cwd?: string }>(SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.snapshot.operationState).toBeNull();
        expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('main\n');
    });

    it('continues a rebase after conflict resolution and clears operation state', async () => {
        const workspace = initWorkspace();
        const baseBranch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        createConflictingBranches(workspace);
        git(workspace, ['checkout', 'feature']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const rebase = await call<any, { cwd?: string; sourceRef: string }>(SCM_BRANCH_REBASE, {
            cwd: '.',
            sourceRef: baseBranch,
        });

        expect(rebase.success).toBe(false);
        expect(rebase.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);

        const conflictedStatus = await call<any, { cwd?: string }>(SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(conflictedStatus.snapshot.operationState).toMatchObject({
            kind: 'rebase',
            canContinue: true,
            canAbort: true,
        });

        writeFileSync(join(workspace, 'a.txt'), 'main\nfeature\n');
        git(workspace, ['add', 'a.txt']);

        const continued = await call<any, { cwd?: string; operation: 'rebase' }>(SCM_BRANCH_OPERATION_CONTINUE, {
            cwd: '.',
            operation: 'rebase',
        });
        expect(continued.success).toBe(true);

        const status = await call<any, { cwd?: string }>(SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.snapshot.operationState).toBeNull();
        expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('main\nfeature\n');
    });

    it('aborts a rebase conflict operation and clears operation state', async () => {
        const workspace = initWorkspace();
        const baseBranch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        createConflictingBranches(workspace);
        git(workspace, ['checkout', 'feature']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        await call<any, { cwd?: string; sourceRef: string }>(SCM_BRANCH_REBASE, {
            cwd: '.',
            sourceRef: baseBranch,
        });

        const abort = await call<any, { cwd?: string; operation: 'rebase' }>(SCM_BRANCH_OPERATION_ABORT, {
            cwd: '.',
            operation: 'rebase',
        });
        expect(abort.success).toBe(true);

        const status = await call<any, { cwd?: string }>(SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.snapshot.operationState).toBeNull();
        expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('feature\n');
    });
});

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    ScmBranchIntegrationRequest,
    ScmBranchIntegrationResponse,
    ScmBranchOperationControlRequest,
    ScmStatusSnapshotRequest,
    ScmStatusSnapshotResponse,
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it } from 'vitest';

import { createTestRpcManager, runGit as git } from './testRpcHarness';

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
        const currentBranch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const merge = await call<ScmBranchIntegrationResponse, ScmBranchIntegrationRequest>(
            RPC_METHODS.SCM_BRANCH_MERGE,
            {
                cwd: '.',
                sourceRef: 'feature',
            },
        );

        expect(merge.success).toBe(true);
        expect(git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(currentBranch);
        expect(readFileSync(join(workspace, 'feature.txt'), 'utf8')).toBe('feature\n');
    });

    it('rebases the current branch onto the selected source ref', async () => {
        const workspace = initWorkspace();
        const baseBranch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        createDivergedBranches(workspace);
        const baseBranchHead = git(workspace, ['rev-parse', baseBranch]);
        git(workspace, ['checkout', 'feature']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const rebase = await call<ScmBranchIntegrationResponse, ScmBranchIntegrationRequest>(
            RPC_METHODS.SCM_BRANCH_REBASE,
            {
                cwd: '.',
                sourceRef: baseBranch,
            },
        );

        expect(rebase.success).toBe(true);
        expect(git(workspace, ['rev-parse', 'HEAD^'])).toBe(baseBranchHead);
    });

    it('rejects merge when the worktree is dirty', async () => {
        const workspace = initWorkspace();
        git(workspace, ['branch', 'feature']);
        writeFileSync(join(workspace, 'dirty.txt'), 'dirty\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const merge = await call<ScmBranchIntegrationResponse, ScmBranchIntegrationRequest>(
            RPC_METHODS.SCM_BRANCH_MERGE,
            {
                cwd: '.',
                sourceRef: 'feature',
            },
        );

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
        const rebase = await call<ScmBranchIntegrationResponse, ScmBranchIntegrationRequest>(
            RPC_METHODS.SCM_BRANCH_REBASE,
            {
                cwd: '.',
                sourceRef: 'feature',
            },
        );

        expect(rebase).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
    });

    it('detects and aborts a merge conflict operation', async () => {
        const workspace = initWorkspace();
        createConflictingBranches(workspace);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const merge = await call<ScmBranchIntegrationResponse, ScmBranchIntegrationRequest>(
            RPC_METHODS.SCM_BRANCH_MERGE,
            {
                cwd: '.',
                sourceRef: 'feature',
            },
        );

        expect(merge).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
            operationState: {
                kind: 'merge',
                canContinue: true,
                canAbort: true,
            },
        });

        const conflictedStatus = await call<ScmStatusSnapshotResponse, ScmStatusSnapshotRequest>(
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            { cwd: '.' },
        );
        expect(conflictedStatus.snapshot?.operationState).toMatchObject({
            kind: 'merge',
            canContinue: true,
            canAbort: true,
        });

        const abort = await call<ScmBranchIntegrationResponse, ScmBranchOperationControlRequest>(
            RPC_METHODS.SCM_BRANCH_OPERATION_ABORT,
            {
                cwd: '.',
                operation: 'merge',
            },
        );
        expect(abort.success).toBe(true);

        const status = await call<ScmStatusSnapshotResponse, ScmStatusSnapshotRequest>(
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            { cwd: '.' },
        );
        expect(status.snapshot?.operationState).toBeNull();
        expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('main\n');
    });

    it('returns not-in-progress for branch operation control without matching state', async () => {
        const workspace = initWorkspace();

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const continued = await call<ScmBranchIntegrationResponse, ScmBranchOperationControlRequest>(
            RPC_METHODS.SCM_BRANCH_OPERATION_CONTINUE,
            {
                cwd: '.',
                operation: 'merge',
            },
        );

        expect(continued).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.BRANCH_OPERATION_NOT_IN_PROGRESS,
        });
    });
});

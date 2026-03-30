import { afterEach, describe, expect, it, vi } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const getStateMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
        getState: getStateMock,
    },
});
});

describe('machineScm', () => {
    afterEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        getStateMock.mockReset();
    });

    it('runs SCM status snapshot through server-scoped machine RPC with the requested cwd and backend preference', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'sapling',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({
            success: true,
            snapshot: undefined,
        });

        const { machineScmStatusSnapshot } = await import('./machineScm');
        const response = await machineScmStatusSnapshot('machine-1', {
            cwd: '/repo',
        });

        expect(response.success).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_STATUS_SNAPSHOT,
            payload: {
                cwd: '/repo',
                backendPreference: {
                    kind: 'prefer',
                    backendId: 'sapling',
                },
            },
            timeoutMs: undefined,
        });
    });

    it('maps unavailable machine-rpc failures to the standard backend unavailable SCM response', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockRejectedValue(
            Object.assign(new Error(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }),
        );

        const { machineScmBranchList } = await import('./machineScm');
        const response = await machineScmBranchList('machine-1', {
            cwd: '/repo',
            includeRemotes: true,
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE);
        expect(response.error).toBe(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE);
    });

    it('routes worktree create, remove, and prune through canonical machine SCM RPCs', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, stdout: '', stderr: '' });

        const { machineScmWorktreeCreate, machineScmWorktreePrune, machineScmWorktreeRemove } = await import('./machineScm');
        const createResponse = await machineScmWorktreeCreate('machine-1', {
            cwd: '/repo',
            displayName: 'feature-auth',
            baseRef: 'main',
        });
        const removeResponse = await machineScmWorktreeRemove('machine-1', {
            cwd: '/repo',
            worktreePath: '/repo/.dev/worktree/feature-auth',
        });
        const pruneResponse = await machineScmWorktreePrune('machine-1', {
            cwd: '/repo',
        });

        expect(createResponse.success).toBe(true);
        expect(removeResponse.success).toBe(true);
        expect(pruneResponse.success).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            1,
            {
                machineId: 'machine-1',
                method: RPC_METHODS.SCM_WORKTREE_CREATE,
                payload: {
                    cwd: '/repo',
                    displayName: 'feature-auth',
                    baseRef: 'main',
                },
                timeoutMs: undefined,
            },
        );
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            2,
            {
                machineId: 'machine-1',
                method: RPC_METHODS.SCM_WORKTREE_REMOVE,
                payload: {
                    cwd: '/repo',
                    worktreePath: '/repo/.dev/worktree/feature-auth',
                },
                timeoutMs: undefined,
            },
        );
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            3,
            {
                machineId: 'machine-1',
                method: RPC_METHODS.SCM_WORKTREE_PRUNE,
                payload: {
                    cwd: '/repo',
                },
                timeoutMs: undefined,
            },
        );
    });

    it('passes the SCM diff-commit timeout through the canonical machine RPC wrapper', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({
            success: true,
            diff: '',
        });

        const { machineScmDiffCommit } = await import('./machineScm');
        await machineScmDiffCommit('machine-1', {
            cwd: '/repo',
            commit: 'abc123',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_DIFF_COMMIT,
            payload: {
                cwd: '/repo',
                commit: 'abc123',
            },
            timeoutMs: 120_000,
        });
    });
});

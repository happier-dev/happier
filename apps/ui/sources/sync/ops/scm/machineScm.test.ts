import { afterEach, describe, expect, it, vi } from 'vitest';

import { SCM_OPERATION_ERROR_CODES, SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const getStateMock = vi.hoisted(() => vi.fn());

type MachineScmTestCall = (machineId: string, request: Record<string, unknown>) => Promise<unknown>;

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: getStateMock,
    },
}));

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

    it('forwards a projected packed backend preference through the canonical SCM request', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
                scmGitRepoPreferredBackendQualifiedId: 'acme.scm/stacked',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, snapshot: undefined });

        const { machineScmStatusSnapshot } = await import('./machineScm');
        await machineScmStatusSnapshot('machine-1', { cwd: '/repo' });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: {
                cwd: '/repo',
                backendPreference: {
                    kind: 'prefer',
                    backendId: 'acme.scm/stacked',
                },
            },
        }));
    });

    it('keeps qualified first-party preferences compatible with legacy CLI backend ids', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'sapling',
                scmGitRepoPreferredBackendQualifiedId: 'happier.scm.backend.git/git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, snapshot: undefined });

        const { machineScmStatusSnapshot } = await import('./machineScm');
        await machineScmStatusSnapshot('machine-1', { cwd: '/repo' });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: { cwd: '/repo' },
        }));
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
            confirmed: true,
            authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN,
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
                    confirmed: true,
                    authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN,
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

    it('passes the requested server scope through worktree creation RPCs', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, stdout: '', stderr: '' });

        const { machineScmWorktreeCreate } = await import('./machineScm');
        const response = await machineScmWorktreeCreate(
            'machine-1',
            {
                cwd: '/repo',
                displayName: 'feature-auth',
            },
            { serverId: 'server-b' },
        );

        expect(response.success).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_WORKTREE_CREATE,
            serverId: 'server-b',
            payload: expect.objectContaining({
                cwd: '/repo',
                displayName: 'feature-auth',
            }),
        }));
    });

    it('passes the requested server scope through non-worktree machine SCM RPCs', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, stdout: '', stderr: '' });

        const { machineScmBranchCreate } = await import('./machineScm');
        const response = await machineScmBranchCreate(
            'machine-1',
            {
                cwd: '/repo',
                name: 'feature/auth',
                checkout: true,
            },
            { serverId: 'server-b' },
        );

        expect(response.success).toBe(true);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_BRANCH_CREATE,
            serverId: 'server-b',
            payload: expect.objectContaining({
                cwd: '/repo',
                name: 'feature/auth',
                checkout: true,
            }),
        }));
    });

    it('routes remote management and branch integration through canonical machine SCM RPCs', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, stdout: '', stderr: '' });

        const module = await import('./machineScm');
        const machineScmRemoteAdd = (module as unknown as {
            machineScmRemoteAdd: MachineScmTestCall;
        }).machineScmRemoteAdd;
        const machineScmRemoteSetUrl = (module as unknown as {
            machineScmRemoteSetUrl: MachineScmTestCall;
        }).machineScmRemoteSetUrl;
        const machineScmBranchMerge = (module as unknown as {
            machineScmBranchMerge: MachineScmTestCall;
        }).machineScmBranchMerge;
        const machineScmBranchOperationAbort = (module as unknown as {
            machineScmBranchOperationAbort: MachineScmTestCall;
        }).machineScmBranchOperationAbort;

        await machineScmRemoteAdd('machine-1', {
            cwd: '/repo',
            name: 'origin',
            fetchUrl: '/tmp/remote.git',
        });
        await machineScmRemoteSetUrl('machine-1', {
            cwd: '/repo',
            name: 'origin',
            pushUrl: null,
        });
        await machineScmBranchMerge('machine-1', {
            cwd: '/repo',
            sourceRef: 'feature',
        });
        await machineScmBranchOperationAbort('machine-1', {
            cwd: '/repo',
            operation: 'merge',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            1,
            {
                machineId: 'machine-1',
                method: RPC_METHODS.SCM_REMOTE_ADD,
                payload: {
                    cwd: '/repo',
                    name: 'origin',
                    fetchUrl: '/tmp/remote.git',
                },
                timeoutMs: undefined,
            },
        );
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            2,
            {
                machineId: 'machine-1',
                method: RPC_METHODS.SCM_REMOTE_SET_URL,
                payload: {
                    cwd: '/repo',
                    name: 'origin',
                    pushUrl: null,
                },
                timeoutMs: undefined,
            },
        );
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            3,
            {
                machineId: 'machine-1',
                method: RPC_METHODS.SCM_BRANCH_MERGE,
                payload: {
                    cwd: '/repo',
                    sourceRef: 'feature',
                },
                timeoutMs: undefined,
            },
        );
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(
            4,
            {
                machineId: 'machine-1',
                method: RPC_METHODS.SCM_BRANCH_OPERATION_ABORT,
                payload: {
                    cwd: '/repo',
                    operation: 'merge',
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

    it('routes remove index-lock through the canonical machine SCM RPC', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({
            success: true,
            removed: true,
            reason: 'removed',
            lockPath: '/repo/.git/index.lock',
        });

        const { machineScmRepositoryRemoveIndexLock } = await import('./machineScm');
        const response = await machineScmRepositoryRemoveIndexLock('machine-1', {
            cwd: '/repo',
            confirmed: true,
            confirmationToken: 'remove-stale-index-lock',
        });

        expect(response).toMatchObject({
            success: true,
            removed: true,
            reason: 'removed',
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK,
            payload: {
                cwd: '/repo',
                confirmed: true,
                confirmationToken: 'remove-stale-index-lock',
            },
            timeoutMs: undefined,
        });
    });

    it('maps remove index-lock missing machine RPC to feature unsupported response', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockRejectedValue(
            Object.assign(new Error(RPC_ERROR_MESSAGES.METHOD_NOT_FOUND), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            }),
        );

        const { machineScmRepositoryRemoveIndexLock } = await import('./machineScm');
        const response = await machineScmRepositoryRemoveIndexLock('machine-1', {
            cwd: '/repo',
            confirmed: true,
            confirmationToken: 'remove-stale-index-lock',
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
        expect(response.error).toBe(RPC_ERROR_MESSAGES.METHOD_NOT_FOUND);
    });

    it('routes pull-request read and compose operations through canonical machine SCM RPCs', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({
            success: true,
            pullRequests: [],
        });

        const module = await import('./machineScm');
        await module.machineScmPullRequestList('machine-1', {
            cwd: '/repo',
            base: 'main',
            head: 'feature/pr-cache',
            state: 'open',
        });
        await module.machineScmPullRequestGet('machine-1', {
            cwd: '/repo',
            prReference: { number: 42 },
        });
        await module.machineScmPullRequestOpenCompose('machine-1', {
            cwd: '/repo',
            base: 'main',
            head: 'feature/pr-cache',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, {
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_PULL_REQUEST_LIST,
            payload: {
                cwd: '/repo',
                base: 'main',
                head: 'feature/pr-cache',
                state: 'open',
            },
            timeoutMs: undefined,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, {
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_PULL_REQUEST_GET,
            payload: {
                cwd: '/repo',
                prReference: { number: 42 },
            },
            timeoutMs: undefined,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(3, {
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE,
            payload: {
                cwd: '/repo',
                base: 'main',
                head: 'feature/pr-cache',
            },
            timeoutMs: undefined,
        });
    });

    it('routes pull-request open-or-reuse and repository provisioning through canonical machine SCM RPCs', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true });

        const module = await import('./machineScm');
        expect(module.machineScmPullRequestOpenOrReuse).toBeTypeOf('function');
        expect(module.machineScmRepositoryInit).toBeTypeOf('function');
        expect(module.machineScmHostingRepositoryDescribePublishTargets).toBeTypeOf('function');
        expect(module.machineScmHostingRepositoryPublish).toBeTypeOf('function');

        await module.machineScmPullRequestOpenOrReuse('machine-1', {
            cwd: '/repo',
            base: 'trunk',
            head: 'feature/pr-cache',
        });
        await module.machineScmRepositoryInit('machine-1', {
            cwd: '/repo',
        });
        await module.machineScmHostingRepositoryDescribePublishTargets('machine-1', {
            cwd: '/repo',
            providerKind: 'github',
        });
        await module.machineScmHostingRepositoryPublish('machine-1', {
            cwd: '/repo',
            providerKind: 'github',
            owner: 'acme',
            repositoryName: 'repo',
            visibility: 'private',
            remoteName: 'origin',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, {
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
            payload: {
                cwd: '/repo',
                base: 'trunk',
                head: 'feature/pr-cache',
            },
            timeoutMs: undefined,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, {
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_REPOSITORY_INIT,
            payload: {
                cwd: '/repo',
            },
            timeoutMs: undefined,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(3, {
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS,
            payload: {
                cwd: '/repo',
                providerKind: 'github',
            },
            timeoutMs: undefined,
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(4, {
            machineId: 'machine-1',
            method: RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH,
            payload: {
                cwd: '/repo',
                providerKind: 'github',
                owner: 'acme',
                repositoryName: 'repo',
                visibility: 'private',
                remoteName: 'origin',
            },
            timeoutMs: undefined,
        });
    });
});

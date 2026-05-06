import { afterEach, describe, expect, it, vi } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';

const sessionRpcMock = vi.hoisted(() => vi.fn());
const machineRpcMock = vi.hoisted(() => vi.fn());
const getStateMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn());

type SessionScmTestCall = (sessionId: string, request: Record<string, unknown>) => Promise<unknown>;

vi.mock('@/sync/api/session/apiSocket', () => ({
  apiSocket: {
        machineRPC: machineRpcMock,
  },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (params: unknown) => sessionRpcMock(params),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdMock(sessionId),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
        getState: getStateMock,
    },
});
});

describe('sessionScm', () => {
    afterEach(() => {
        sessionRpcMock.mockReset();
        machineRpcMock.mockReset();
        getStateMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-owned');
    });

    it('fails closed when machine target is unavailable', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE);
        expect(response.error).toBe(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE);
    });

    it('prefers machine RPC when a session has an attached machine', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
            sessions: {
                'session-1': {
                    active: true,
                    metadata: {
                        path: '~/repo',
                        homeDir: '/Users/tester',
                        machineId: 'machine-1',
                    },
                },
            },
        });
        machineRpcMock.mockResolvedValue({
            success: true,
            snapshot: undefined,
        });

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(true);
        expect(machineRpcMock).toHaveBeenCalledWith(
            'machine-1',
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            {
                cwd: '~/repo',
            },
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('applies sapling backend preference when configured (machine RPC)', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'sapling',
            },
            sessions: {
                'session-1': {
                    active: true,
                    metadata: {
                        path: '~/repo',
                        homeDir: '/Users/tester',
                        machineId: 'machine-1',
                    },
                },
            },
        });
        machineRpcMock.mockResolvedValue({
            success: true,
            snapshot: undefined,
        });

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        await sessionScmStatusSnapshot('session-1', {});

        expect(machineRpcMock).toHaveBeenCalledWith(
            'machine-1',
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            {
                cwd: '~/repo',
                backendPreference: {
                    kind: 'prefer',
                    backendId: 'sapling',
                },
            },
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('does not fall back to session RPC when machine RPC reports method not found', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
            sessions: {
                'session-1': {
                    active: true,
                    metadata: {
                        path: '~/repo',
                        homeDir: '/Users/tester',
                        machineId: 'machine-1',
                    },
                },
            },
        });
        machineRpcMock.mockRejectedValue(
            Object.assign(new Error(RPC_ERROR_MESSAGES.METHOD_NOT_FOUND), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            }),
        );

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
        expect(machineRpcMock).toHaveBeenCalledTimes(1);
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('returns unsupported when machine RPC reports method not found for inactive sessions', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
            sessions: {
                'session-1': {
                    active: false,
                    metadata: {
                        path: '~/repo',
                        homeDir: '/Users/tester',
                        machineId: 'machine-1',
                    },
                },
            },
        });
        machineRpcMock.mockRejectedValue(
            Object.assign(new Error(RPC_ERROR_MESSAGES.METHOD_NOT_FOUND), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            }),
        );

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
        expect(machineRpcMock).toHaveBeenCalledTimes(1);
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('resolves machine target from project fallback for inactive sessions', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
            sessions: {
                'session-1': {
                    active: false,
                    metadata: {
                        path: '',
                        machineId: '',
                    },
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 'session-1'
                    ? {
                        key: {
                            machineId: 'machine-1',
                            rootPath: '~/repo',
                        },
                    }
                    : null,
        });
        machineRpcMock.mockResolvedValue({
            success: true,
            snapshot: undefined,
        });

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(true);
        expect(machineRpcMock).toHaveBeenCalledWith(
            'machine-1',
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            { cwd: '~/repo' },
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('prefers machine RPC for linked direct sessions without top-level machine metadata', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
            sessions: {
                'session-1': {
                    active: false,
                    metadata: {
                        path: '~/repo',
                        homeDir: '/Users/tester',
                        directSessionV1: {
                            v: 1,
                            providerId: 'codex',
                            machineId: 'machine-direct',
                            remoteSessionId: 'remote-1',
                            source: { kind: 'codexHome', home: 'user' },
                        },
                    },
                },
            },
            machines: {
                'machine-other': {
                    id: 'machine-other',
                    active: true,
                    activeAt: 20,
                    metadata: { host: 'other.local' },
                },
                'machine-direct': {
                    id: 'machine-direct',
                    active: false,
                    activeAt: 1,
                    metadata: { host: 'direct.local' },
                },
            },
            getProjectForSession: () => null,
        });
        machineRpcMock.mockResolvedValue({
            success: true,
            snapshot: undefined,
        });

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(true);
        expect(machineRpcMock).toHaveBeenCalledWith(
            'machine-direct',
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            { cwd: '~/repo' },
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('fails closed for inactive sessions when machine target is unavailable', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
            sessions: {
                'session-1': {
                    active: false,
                    metadata: {
                        path: '',
                        machineId: '',
                    },
                },
            },
            getProjectForSession: () => null,
        });
        sessionRpcMock.mockResolvedValue({
            success: true,
            snapshot: undefined,
        });

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE);
        expect(machineRpcMock).not.toHaveBeenCalled();
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('routes remote management and branch integration through the attached machine target', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
            sessions: {
                'session-1': {
                    active: true,
                    metadata: {
                        path: '~/repo',
                        homeDir: '/Users/tester',
                        machineId: 'machine-1',
                    },
                },
            },
        });
        machineRpcMock.mockResolvedValue({ success: true, stdout: '', stderr: '' });

        const module = await import('./sessionScm');
        const sessionScmRemoteAdd = (module as unknown as {
            sessionScmRemoteAdd: SessionScmTestCall;
        }).sessionScmRemoteAdd;
        const sessionScmBranchRebase = (module as unknown as {
            sessionScmBranchRebase: SessionScmTestCall;
        }).sessionScmBranchRebase;

        await sessionScmRemoteAdd('session-1', {
            cwd: '.',
            name: 'origin',
            fetchUrl: '/tmp/remote.git',
        });
        await sessionScmBranchRebase('session-1', {
            cwd: '.',
            sourceRef: 'main',
        });

        expect(machineRpcMock).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            RPC_METHODS.SCM_REMOTE_ADD,
            {
                cwd: '~/repo',
                name: 'origin',
                fetchUrl: '/tmp/remote.git',
            },
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );
        expect(machineRpcMock).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            RPC_METHODS.SCM_BRANCH_REBASE,
            {
                cwd: '~/repo',
                sourceRef: 'main',
            },
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('routes remove index-lock through the attached machine target', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
            sessions: {
                'session-1': {
                    active: true,
                    metadata: {
                        path: '~/repo',
                        homeDir: '/Users/tester',
                        machineId: 'machine-1',
                    },
                },
            },
        });
        machineRpcMock.mockResolvedValue({
            success: true,
            removed: true,
            reason: 'removed',
            lockPath: '/Users/tester/repo/.git/index.lock',
        });

        const { sessionScmRepositoryRemoveIndexLock } = await import('./sessionScm');
        const response = await sessionScmRepositoryRemoveIndexLock('session-1', {
            cwd: '.',
            confirmed: true,
            confirmationToken: 'remove-stale-index-lock',
        });

        expect(response).toMatchObject({
            success: true,
            removed: true,
            reason: 'removed',
        });
        expect(machineRpcMock).toHaveBeenCalledWith(
            'machine-1',
            RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK,
            {
                cwd: '~/repo',
                confirmed: true,
                confirmationToken: 'remove-stale-index-lock',
            },
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('maps remove index-lock missing machine RPC to feature unsupported response', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
            sessions: {
                'session-1': {
                    active: true,
                    metadata: {
                        path: '~/repo',
                        homeDir: '/Users/tester',
                        machineId: 'machine-1',
                    },
                },
            },
        });
        machineRpcMock.mockRejectedValue(
            Object.assign(new Error(RPC_ERROR_MESSAGES.METHOD_NOT_FOUND), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            }),
        );

        const { sessionScmRepositoryRemoveIndexLock } = await import('./sessionScm');
        const response = await sessionScmRepositoryRemoveIndexLock('session-1', {
            cwd: '.',
            confirmed: true,
            confirmationToken: 'remove-stale-index-lock',
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
        expect(response.error).toBe(RPC_ERROR_MESSAGES.METHOD_NOT_FOUND);
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('routes pull-request read and compose operations through the attached machine target', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
            sessions: {
                'session-1': {
                    active: true,
                    metadata: {
                        path: '~/repo',
                        homeDir: '/Users/tester',
                        machineId: 'machine-1',
                    },
                },
            },
        });
        machineRpcMock.mockResolvedValue({ success: true, pullRequests: [] });

        const module = await import('./sessionScm');
        await module.sessionScmPullRequestList('session-1', {
            cwd: '.',
            base: 'main',
            head: 'feature/pr-cache',
            state: 'open',
        });
        await module.sessionScmPullRequestGet('session-1', {
            cwd: '.',
            prReference: { number: 42 },
        });
        await module.sessionScmPullRequestOpenCompose('session-1', {
            cwd: '.',
            base: 'main',
            head: 'feature/pr-cache',
        });

        expect(machineRpcMock).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            RPC_METHODS.SCM_PULL_REQUEST_LIST,
            {
                cwd: '~/repo',
                base: 'main',
                head: 'feature/pr-cache',
                state: 'open',
            },
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );
        expect(machineRpcMock).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            RPC_METHODS.SCM_PULL_REQUEST_GET,
            {
                cwd: '~/repo',
                prReference: { number: 42 },
            },
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );
        expect(machineRpcMock).toHaveBeenNthCalledWith(
            3,
            'machine-1',
            RPC_METHODS.SCM_PULL_REQUEST_OPEN_COMPOSE,
            {
                cwd: '~/repo',
                base: 'main',
                head: 'feature/pr-cache',
            },
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';

const sessionRpcMock = vi.hoisted(() => vi.fn());
const machineRpcMock = vi.hoisted(() => vi.fn());
const getStateMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn());

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
});

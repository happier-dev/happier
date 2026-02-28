import { afterEach, describe, expect, it, vi } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';

const sessionRpcMock = vi.hoisted(() => vi.fn());
const machineRpcMock = vi.hoisted(() => vi.fn());
const getStateMock = vi.hoisted(() => vi.fn());

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: sessionRpcMock,
        machineRPC: machineRpcMock,
    },
}));

vi.mock('../domains/state/storage', () => ({
    storage: {
        getState: getStateMock,
    },
}));

describe('sessionScm', () => {
    afterEach(() => {
        sessionRpcMock.mockReset();
        machineRpcMock.mockReset();
        getStateMock.mockReset();
    });

    it('returns unsupported fallback when status snapshot rpc payload is null', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        sessionRpcMock.mockResolvedValue(null);

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
        expect(response.error).toBe(RPC_ERROR_MESSAGES.METHOD_NOT_FOUND);
    });

    it('prefers machine RPC when a session has an attached machine', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
            sessions: {
                'session-1': {
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
            }
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
            }
        );
        expect(sessionRpcMock).not.toHaveBeenCalled();
    });

    it('falls back to session RPC when machine RPC reports method not available', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
            sessions: {
                'session-1': {
                    metadata: {
                        path: '~/repo',
                        homeDir: '/Users/tester',
                        machineId: 'machine-1',
                    },
                },
            },
        });
        machineRpcMock.mockRejectedValue(
            Object.assign(new Error(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }),
        );
        sessionRpcMock.mockResolvedValue({
            success: true,
            snapshot: undefined,
        });

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(true);
        expect(machineRpcMock).toHaveBeenCalledTimes(1);
        expect(sessionRpcMock).toHaveBeenCalledTimes(1);
    });
});

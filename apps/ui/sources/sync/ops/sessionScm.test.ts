import { afterEach, describe, expect, it, vi } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';

const sessionRpcMock = vi.hoisted(() => vi.fn());
const getStateMock = vi.hoisted(() => vi.fn());

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: sessionRpcMock,
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

    it('applies sapling backend preference when configured', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'sapling',
            },
        });
        sessionRpcMock.mockResolvedValue({
            success: true,
            snapshot: undefined,
        });

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        await sessionScmStatusSnapshot('session-1', {});

        expect(sessionRpcMock).toHaveBeenCalledWith(
            'session-1',
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            {
                backendPreference: {
                    kind: 'prefer',
                    backendId: 'sapling',
                },
            }
        );
    });

    it('returns unsupported fallback when rpc reports method not available', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        sessionRpcMock.mockRejectedValue(
            Object.assign(new Error(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            })
        );

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE);
        expect(response.error).toBe(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE);
    });

    it('returns unsupported fallback when rpc reports method not found', async () => {
        getStateMock.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: 'git',
            },
        });
        sessionRpcMock.mockRejectedValue(
            Object.assign(new Error(RPC_ERROR_MESSAGES.METHOD_NOT_FOUND), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            })
        );

        const { sessionScmStatusSnapshot } = await import('./sessionScm');
        const response = await sessionScmStatusSnapshot('session-1', {});

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
        expect(response.error).toBe(RPC_ERROR_MESSAGES.METHOD_NOT_FOUND);
    });
});

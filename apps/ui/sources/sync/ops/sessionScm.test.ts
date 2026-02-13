import { afterEach, describe, expect, it, vi } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

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
        expect(response.error).toBe('RPC method not available');
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
});

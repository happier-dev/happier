import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const mockMachineRPC = vi.fn();
const mockSessionRPC = vi.fn();
const getStateSpy = vi.fn();

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        machineRPC: mockMachineRPC,
        sessionRPC: mockSessionRPC,
    },
}));

vi.mock('../domains/state/storage', () => ({
    storage: {
        getState: () => getStateSpy(),
    },
}));

describe('sessionScm (rpc timeouts)', () => {
    it('uses an extended machine RPC timeout for commit diffs', async () => {
        const { sessionScmDiffCommit } = await import('./sessionScm');

        getStateSpy.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: null,
            },
            sessions: {
                s1: {
                    metadata: {
                        machineId: 'm1',
                        path: '/repo',
                    },
                },
            },
        });

        mockMachineRPC.mockResolvedValue({
            success: true,
            diff: 'diff --git a/a.txt b/a.txt',
        });

        await sessionScmDiffCommit('s1', { cwd: '.', commit: 'abc' });

        expect(mockMachineRPC).toHaveBeenCalledWith(
            'm1',
            RPC_METHODS.SCM_DIFF_COMMIT,
            expect.any(Object),
            { timeoutMs: 120_000 },
        );
    });
});

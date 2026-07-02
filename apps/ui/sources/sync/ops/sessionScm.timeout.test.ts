import { afterEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const getStateSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: getStateSpy,
        },
    });
});

describe('sessionScm (rpc timeouts)', () => {
    afterEach(() => {
        getStateSpy.mockReset();
        machineRpcWithServerScopeMock.mockReset();
    });

    it('uses an extended machine RPC timeout for commit diffs', async () => {
        const { sessionScmDiffCommit } = await import('./sessionScm');

        getStateSpy.mockReturnValue({
            settings: {
                scmGitRepoPreferredBackend: null,
            },
            sessions: {
                s1: createSessionFixture({
                    id: 's1',
                    active: true,
                    metadata: {
                        machineId: 'm1',
                        path: '/repo',
                        host: 'tester.local',
                    },
                }),
            },
            machines: {
                m1: createMachineFixture({ id: 'm1' }),
            },
        });

        machineRpcWithServerScopeMock.mockResolvedValue({
            success: true,
            diff: 'diff --git a/a.txt b/a.txt',
        });

        await sessionScmDiffCommit('s1', { cwd: '.', commit: 'abc' });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'm1',
            method: RPC_METHODS.SCM_DIFF_COMMIT,
            payload: {
                cwd: '/repo',
                commit: 'abc',
            },
            timeoutMs: 120_000,
        });
    });
});

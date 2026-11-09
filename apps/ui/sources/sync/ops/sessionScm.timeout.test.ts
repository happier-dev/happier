import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const boundary = vi.hoisted(() => ({
    request: vi.fn(),
    timeout: vi.fn(),
}));

vi.mock('socket.io-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('socket.io-client')>();
    const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
    return { ...actual, io: () => {
        const { socket } = createSocketIoBoundaryStub();
        socket.timeout.mockImplementation((timeoutMs) => {
            boundary.timeout(timeoutMs);
            return { emitWithAck: socket.emitWithAck };
        });
        socket.emitWithAck.mockImplementation(async (event, payload) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
            return { ok: true, result: await boundary.request(payload) };
        });
        return socket;
    } };
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { getStorage } = await import('@/sync/domains/state/storage');
beforeAll(async () => { await import('@/sync/domains/state/storageStore'); });

describe('sessionScm (rpc timeouts)', () => {
    afterEach(() => {
        boundary.request.mockReset();
        boundary.timeout.mockReset();
        vi.restoreAllMocks();
    });

    it('uses an extended machine RPC timeout for commit diffs', async () => {
        const { sessionScmDiffCommit } = await import('./sessionScm');

        await harness.reset();
        const serverId = await harness.addHome({ serverUrl: 'https://scm-timeout.test', name: 'SCM Home',
            accountId: 'scm-account', currentAccount: true, active: false });
        getStorage().getState().activateProfileScope({ serverId, accountId: 'scm-account' });
        const machine = createMachineFixture({ id: 'm1' });
        getStorage().setState({
            sessions: {
                s1: createSessionFixture({
                    id: 's1',
                    serverId,
                    active: true,
                    metadata: {
                        machineId: 'm1',
                        path: '/repo',
                        host: 'tester.local',
                    },
                }),
            },
            machines: {
                m1: machine,
            },
            machineListByServerId: { [serverId]: [machine] },
        });

        harness.answer(serverId, '/v1/auth/ping', { body: { ok: true } });
        harness.answer(serverId, '/v1/machines/m1', {
            body: { machine: createPlainMachineRowFixture({ id: 'm1', accountId: 'scm-account' }) },
        });
        // Hold the clock boundary still so the remaining RPC budget is exact.
        vi.spyOn(Date, 'now').mockReturnValue(1_000);
        boundary.request.mockResolvedValue({
            success: true,
            diff: 'diff --git a/a.txt b/a.txt',
        });

        const response = await sessionScmDiffCommit('s1', { cwd: '.', commit: 'abc' }, serverId);
        expect(response, JSON.stringify(response)).toMatchObject({ success: true });

        expect(boundary.request).toHaveBeenCalledWith(expect.objectContaining({
            method: `m1:${RPC_METHODS.SCM_DIFF_COMMIT}`,
            params: {
                cwd: '/repo',
                commit: 'abc',
                outcomeVersion: 1,
            },
        }));
        expect(boundary.timeout).toHaveBeenCalledWith(120_000);
    });
});

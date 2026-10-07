import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getStorage } from '@/sync/domains/state/storage';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

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

beforeAll(async () => { await import('@/sync/domains/state/storageStore'); });

describe('sessionScm (rpc timeouts)', () => {
    afterEach(() => {
        boundary.request.mockReset();
        boundary.timeout.mockReset();
        resetRuntimeFetch();
        vi.restoreAllMocks();
    });

    it('uses an extended machine RPC timeout for commit diffs', async () => {
        const { sessionScmDiffCommit } = await import('./sessionScm');

        const home = await upsertAndActivateServer({ serverUrl: 'https://scm-timeout.test', name: 'SCM Home' });
        getStorage().getState().activateProfileScope({ serverId: home.id, accountId: 'scm-account' });
        const machine = createMachineFixture({ id: 'm1' });
        getStorage().setState({
            sessions: {
                s1: createSessionFixture({
                    id: 's1',
                    serverId: home.id,
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
            machineListByServerId: { [home.id]: [machine] },
        });

        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: createAccountTokenForTests('scm-account') });
        setRuntimeFetch(async (url) => {
            const pathname = new URL(String(url)).pathname;
            if (pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (pathname === '/v1/machines/m1') {
                return Response.json({ machine: { id: 'm1', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
            }
            throw new Error(`Unexpected SCM transport request: ${pathname}`);
        });
        // Hold the clock boundary still so the remaining RPC budget is exact.
        vi.spyOn(Date, 'now').mockReturnValue(1_000);
        boundary.request.mockResolvedValue({
            success: true,
            diff: 'diff --git a/a.txt b/a.txt',
        });

        await expect(sessionScmDiffCommit('s1', { cwd: '.', commit: 'abc' }, home.id)).resolves.toMatchObject({ success: true });

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

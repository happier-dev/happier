import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// The authenticated machine connection is the network boundary; response decoding and error classification stay real.
const network = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(network.execute);
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes); installDisconnectedServerSocketBoundary();
const { fetchMachineProcessesViaMachineRpc, watchMachineProcessesViaMachineRpc } = await import('./machineProcessesRpc');

const key = { serverId: 'home', machineId: 'machine', scope: 'happier' as const, view: 'tree' as const };
// Load the real Sync/Action graph during collection, outside each test's setup deadline.
await loadSyncSingletonForTests();
beforeEach(async () => {
    await homes.reset(); await loadSyncSingletonForTests(); network.execute.mockReset();
    key.serverId = await homes.addHome({ name: 'Processes', serverUrl: 'https://process-read.test', accountId: 'owner', currentAccount: true });
});
afterEach(async () => { await homes.reset(); });

it('distinguishes unavailable transport from an unregistered predecessor operation on both initial reads and parked watches', async () => {
    for (const errorCode of [RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, RPC_ERROR_CODES.METHOD_NOT_FOUND]) {
        network.execute.mockRejectedValue(new RpcError('Unavailable operation', errorCode));
        const reason = errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND ? 'older_happier' : 'request_failed';
        expect(await fetchMachineProcessesViaMachineRpc(key)).toMatchObject({ ok: false, reason });
        expect(await watchMachineProcessesViaMachineRpc(key)).toMatchObject({ ok: false, reason });
    }
});

it('keeps access refusal and transport failure distinct from a missing predecessor operation', async () => {
    for (const error of [new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN), new Error('Socket not connected')]) {
        network.execute.mockRejectedValue(error);
        expect(await fetchMachineProcessesViaMachineRpc(key)).toMatchObject({ ok: false, reason: 'request_failed' });
        expect(await watchMachineProcessesViaMachineRpc(key)).toMatchObject({ ok: false, reason: 'request_failed' });
    }
    network.execute.mockResolvedValue({ changed: true });
    expect(await watchMachineProcessesViaMachineRpc(key)).toMatchObject({ ok: false, reason: 'invalid_response' });
});

it('carries the typed cause through Action reads and direct parked watches', async () => {
    const failureCause = { phase: 'dispatch' as const, errorClass: 'RpcError', errorCode: RPC_ERROR_CODES.FORBIDDEN, httpStatus: 403 };
    network.execute.mockRejectedValue(new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN, failureCause));
    const expected = { ok: false, reason: 'request_failed', errorCode: RPC_ERROR_CODES.FORBIDDEN, failureCause };
    expect(await fetchMachineProcessesViaMachineRpc(key)).toEqual(expected);
    expect(await watchMachineProcessesViaMachineRpc(key)).toEqual(expected);
});

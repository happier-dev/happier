import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

const rpc = vi.hoisted(() => vi.fn());
// Only the Session RPC network boundary is substituted; target and snapshot readers stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async (importOriginal) => {
    const { createServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedSessionRpcModuleMock({ importOriginal, overrides: {
        sessionRpcWithServerAccountScope: rpc, sessionRpcWithServerScope: rpc,
    } });
});
const homes = createHomeGovernanceHarness();
const boundary = { ...homes, request: createSessionReadBatchFetchBoundary(homes.request) };
installHomeGovernanceBoundaries(boundary);
installDisconnectedServerSocketBoundary();
const { sessionExecutionRunStart } = await import('./sessionExecutionRuns');
const { getStorage } = await import('@/sync/domains/state/storage');
const initial = getStorage().getState();
beforeEach(async () => { await homes.reset(); installHomeGovernanceBoundaries(boundary); rpc.mockReset(); });
afterEach(() => { getStorage().setState(initial, true); standardCleanup(); });

it.each([
    { expectedMachineId: 'machine-1', active: true },
    { expectedMachineId: 'different-machine', active: true },
    { expectedMachineId: 'machine-1', active: false },
])('reads a cold Session target before comparing $expectedMachineId (active=$active)', async ({ expectedMachineId, active }) => {
    const serverId = await homes.addHome({ name: 'Cold Run', serverUrl: 'https://cold-run.test', accountId: 'alice', currentAccount: true });
    const session = createSessionFixture({ id: 'cold-session', active,
        metadata: { ...createSessionFixture().metadata!, machineId: 'machine-1', path: '/accepted/checkout' } });
    homes.answer(serverId, `/v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
    expect(getStorage().getState().sessions[session.id]).toBeUndefined();
    rpc.mockResolvedValue({ ok: true, runId: 'run-1', callId: 'call-1', sidechainId: 'side-1' });
    const result = await sessionExecutionRunStart(session.id, {
        intent: 'delegate', backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        instructions: 'Inspect', permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
    }, { serverId, expectedMachineId });
    if (!active) {
        expect(result).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        expect(rpc).not.toHaveBeenCalled();
    } else if (expectedMachineId === 'machine-1') {
        expect(result).toMatchObject({ ok: true, runId: 'run-1' });
        expect(rpc).toHaveBeenCalledOnce();
    } else {
        expect(result).toMatchObject({ ok: false, errorCode: 'execution_run_target_changed',
            details: { executionRunStart: { runCreation: 'noRunCreated' } } });
        expect(rpc).not.toHaveBeenCalled();
    }
    expect(getStorage().getState().sessions[session.id]).toBeUndefined();
    // The canonical batch fixture adapter records each served detail at its scalar route.
    expect(homes.requests.filter(request => request.path === `/v2/sessions/${session.id}`)).toHaveLength(1);
});

import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

const homes = createHomeGovernanceHarness();
const network = await installSessionOpsNetworkBoundary();
installHomeGovernanceBoundaries(homes);
const machineTransport = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
const sessionTransport = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

beforeEach(async () => {
    network.resetRequests();
    await homes.reset();
    installHomeGovernanceBoundaries(homes);
});
afterAll(async () => {
    await homes.reset();
    network.dispose();
});

it('targets the admitted Account on a saved Home for Machine hook and Session work reads', async () => {
    const accountId = 'scope-reader';
    const serverId = await homes.addHome({ name: 'Saved Home', serverUrl: 'https://action-read-scope.test',
        accountId, currentAccount: true, accountEncryptionMode: 'plain' });
    const machineId = 'hook-machine';
    const sessionId = 'work-session';
    homes.answer(serverId, `/v1/machines/${machineId}`, {
        body: { machine: createPlainMachineRowFixture({ id: machineId, accountId }) },
    });
    homes.answer(serverId, `GET /v2/sessions/${sessionId}`, {
        body: createPlainSessionByIdResponseFixture(createSessionFixture({ id: sessionId, encryptionMode: 'plain' })),
    });
    const status = { ok: true, rows: [], nextCursor: null, diagnostics: [] };
    const work = { workState: { v: 1, backendId: 'codex', updatedAt: 1, items: [] } };
    network.respond(RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET, status);
    network.respond(SESSION_RPC_METHODS.SESSION_WORK_STATE_GET, work);
    const executor = createDefaultActionExecutor();
    const context = { surface: 'ui' as const, serverId, expectedAccountId: accountId };

    // Observe the explicit scope passed to both real transports. The Home
    // boundary above supplies their actual replies.
    const machineRpc = vi.spyOn(machineTransport, 'machineRpcWithServerScope');
    const sessionRpc = vi.spyOn(sessionTransport, 'sessionRpcWithServerAccountScope');
    try {
        await expect(executor.execute('plugins.sessionHooks.status.get', { machineId, intent: 'passive_inventory' }, context))
            .resolves.toEqual({ ok: true, result: status });
        await expect(executor.execute('session.work_state.get', { sessionId }, context))
            .resolves.toEqual({ ok: true, result: work });
        expect.soft(machineRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET, accountId, serverId,
        }));
        expect.soft(sessionRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: SESSION_RPC_METHODS.SESSION_WORK_STATE_GET, scope: { serverId, accountId },
        }));
    } finally {
        machineRpc.mockRestore();
        sessionRpc.mockRestore();
    }
});

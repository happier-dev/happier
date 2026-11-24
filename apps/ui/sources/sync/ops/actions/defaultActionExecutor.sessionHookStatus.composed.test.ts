import { afterAll, beforeEach, expect, it } from 'vitest';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createPlainMachineRowFixture } from "@/dev/testkit/fixtures/machineFixtures";

const homes = createHomeGovernanceHarness();
const network = await installSessionOpsNetworkBoundary();
installHomeGovernanceBoundaries(homes);
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

it('reads hook status for the exact Machine and preserves Home’s typed refusal', async () => {
    const serverId = await homes.addHome({ name: 'Hook status Home', serverUrl: 'https://hook-status.test',
        accountId: 'reader', currentAccount: true, accountEncryptionMode: 'plain' });
    const visible = 'selected-machine';
    const foreign = 'foreign-machine';
    for (const machineId of [visible, foreign]) {
        homes.answer(serverId, `/v1/machines/${machineId}`, {
            body: { machine: createPlainMachineRowFixture({ id: machineId, accountId: 'reader' }) },
        });
    }
    const status = { ok: true, rows: [], nextCursor: null, diagnostics: [] };
    network.setRpcAckResponder(async ({ targetId, method }) => {
        expect(method).toBe(RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET);
        return targetId === visible ? { ok: true, result: status }
            : { ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN, error: 'Access denied' };
    });
    const executor = createDefaultActionExecutor();
    const execute = (machineId: string) => executor.execute('plugins.sessionHooks.status.get',
        { machineId, intent: 'passive_inventory' }, { surface: 'ui', serverId, expectedAccountId: 'reader' });
    expect(await execute(visible)).toEqual({ ok: true, result: status });
    expect(await execute(foreign)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
});

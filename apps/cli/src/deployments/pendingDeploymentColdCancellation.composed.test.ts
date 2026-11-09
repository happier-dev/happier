import { expect, it } from 'vitest';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { createActionOperationCancellationFixture } from '@/daemon/actionOperations/actionOperationCancellation.testkit';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';

// Empty operation custody represents a receiving daemon after reload. The
// production cancellation handler and fresh requester are real; only Home HTTP
// is substituted. The server's pending-storage integration suite owns its CAS.
it.each(['plain', 'e2ee'] as const)('cancels cold pending through the reviewed Address (%s)', async mode => {
    const serverId = 'srv_cold_cancel';
    const machineId = 'machine';
    const accountId = 'requester';
    const operationId = 'retained-cold-operation';
    let installationId = '';
    const operations = createHostActionOperationRuntime({ serverId, machineId, resolveAccountId: async () => 'custodian',
        custodyBinding: { serverId, get installationId() { return installationId; } } });
    let pending = true;
    const requests: unknown[] = [];
    const fixture = await createActionOperationCancellationFixture({ mode, accountId,
        address: { serverId, machineId, operationId }, store: operations.store, runner: operations.runner,
        handlers: operations.handlers,
        async requestHttp(request) {
            expect(request.method).toBe('POST');
            expect(new URL(request.url).pathname).toBe('/v1/deployments/pending/cancel');
            expect(request.options?.headers).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: fixture.root.token });
            requests.push(request.body);
            pending = false;
            return { status: 200, data: { kind: 'requested' } };
        } });
    installationId = fixture.installation.installationId;
    expect(operations.store.get({ accountId, machineId }, operationId)).toBeNull();
    expect(await fixture.cancel(operationId), JSON.stringify(fixture.diagnostics)).toEqual({ kind: 'requested' });
    expect(requests).toEqual([{ serverId, machineId, operationId }]);
    expect(pending).toBe(false);
    expect(operations.store.list({ accountId, machineId }).items).toEqual([]);
});

import { describe, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentHeaderV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { readDeploymentActivityPageV1, type DeploymentActivityReadOwnersV1 } from './deploymentActivityPage.js';

const scope = { serverId: 'home', accountId: 'account-owner' };
const environment = createDeploymentEnvironmentHeaderV1();
const receipt = (id: string, at: number) => ({ ...createDeploymentReceiptHeaderV1({ id,
    environmentId: environment.id, requestedAtMs: at, actionOperationId: `operation-${id}` }), machineIds: ['machine-a'] });
const operation = (operationId: string, createdAt: number): ActionOperationSnapshotV1 => ({
    version: 1, operationId, revision: 1, actionId: 'machines.reboot', state: 'succeeded',
    scope: { accountId: scope.accountId, machineId: 'machine-a' }, title: 'Restart Machine',
    createdAt, startedAt: createdAt, settledAt: createdAt + 1, cancellation: 'unsupported',
});
function owners() {
    return {
        listEnvironments: vi.fn(async () => ({ items: [environment], nextCursor: null })),
        listReceipts: vi.fn(async (_environmentId: string, cursor?: string) => ({
            items: cursor ? [receipt('old', 10)] : [receipt('new', 30)], nextCursor: cursor ? null : 'older',
        })),
        listOperations: vi.fn(async () => ({ items: [operation('restart', 20)], nextCursor: null })),
    } satisfies DeploymentActivityReadOwnersV1;
}
describe('deployment Activity history read', () => {
    it('merges owner history into stable pages without draining receipt history for the first page', async () => {
        const source = owners();
        const first = await readDeploymentActivityPageV1({ scope, owners: source, machineIds: ['machine-a'], query: { limit: 1 } });
        expect(first.items.map(item => item.id)).toEqual(['receipt:new']);
        expect(source.listReceipts).toHaveBeenCalledTimes(1);
        const second = await readDeploymentActivityPageV1({ scope, owners: source, machineIds: ['machine-a'],
            query: { limit: 1, cursor: first.nextCursor! } });
        expect(second.items.map(item => item.id)).toEqual(['operation:machine-a:restart']);
        const third = await readDeploymentActivityPageV1({ scope, owners: source, machineIds: ['machine-a'],
            query: { limit: 1, cursor: second.nextCursor! } });
        expect(third.items.map(item => item.id)).toEqual(['receipt:old']);
        expect(third.nextCursor).toBeNull();
    });
    it('uses historical receipt placement and exact domain references for Project, Environment and Machine filters', async () => {
        const source = owners();
        source.listOperations.mockResolvedValue({ items: [operation('restart', 20), {
            ...operation('operation-new', 40), actionId: 'deployments.deploy',
            domainRef: { kind: 'deployment', serverId: 'home', environmentId: environment.id, deploymentId: 'new' },
        }, { ...operation('foreign', 50), scope: { accountId: 'another-account', machineId: 'machine-a' } }], nextCursor: null });
        const page = await readDeploymentActivityPageV1({ scope, owners: source, machineIds: ['machine-a', 'machine-b'],
            query: { limit: 10, projectSourceId: environment.projectSourceId, environmentId: environment.id, machineId: 'machine-a' } });
        expect(page.items.map(item => item.id)).toEqual(['receipt:new', 'receipt:old']);
        expect(source.listOperations).toHaveBeenCalledTimes(1);
    });
    it('reports failed sources while retaining readable history and never classifies Inbox attention', async () => {
        const source = owners();
        source.listOperations.mockRejectedValue(Object.assign(new Error('Disconnected'), { code: 'machine_rpc_unavailable' }));
        const page = await readDeploymentActivityPageV1({ scope, owners: source, machineIds: ['machine-a'], query: { limit: 10 } });
        expect(page.items).toHaveLength(2);
        expect(page.unavailableSources).toEqual([{ kind: 'machine', id: 'machine-a', code: 'machine_rpc_unavailable' }]);
        expect(page.coverage).toBe('partial');
    });
    it('keeps independent deploy operations even when they reference an existing deployment', async () => {
        const source = owners();
        source.listOperations.mockResolvedValue({ items: [{ ...operation('backup', 40), actionId: 'deployments.backups.run',
            domainRef: { kind: 'deployment', serverId: 'home', environmentId: environment.id, deploymentId: 'new' } }], nextCursor: null });
        const page = await readDeploymentActivityPageV1({ scope, owners: source, machineIds: ['machine-a'],
            query: { limit: 10, environmentId: environment.id } });
        expect(page.items.map(item => item.id)).toEqual(['operation:machine-a:backup', 'receipt:new', 'receipt:old']);
    });
    it('does no reads for a cancelled demand', async () => {
        const source = owners();
        const abort = new AbortController();
        abort.abort();
        await expect(readDeploymentActivityPageV1({ scope, owners: source, machineIds: ['machine-a'],
            query: { limit: 10 }, signal: abort.signal })).rejects.toThrow();
        expect(source.listEnvironments).not.toHaveBeenCalled();
        expect(source.listOperations).not.toHaveBeenCalled();
    });
});

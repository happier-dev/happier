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
    it('passes requester and time selection to each history owner before paging and selects one item kind', async () => {
        const filters = { actorAccountId: scope.accountId, requestedAtFromMs: 10, requestedAtToMs: 30 };
        const source = owners();
        const page = await readDeploymentActivityPageV1({ scope, owners: source, machineIds: ['machine-a'],
            query: { limit: 1, kind: 'operation', ...filters } });
        expect(page.items.map(item => item.id)).toEqual(['operation:machine-a:restart']);
        expect(source.listReceipts).toHaveBeenCalledWith(environment.id, undefined, filters);
        expect(source.listOperations).toHaveBeenCalledWith('machine-a', undefined, {
            actorAccountId: scope.accountId, createdAtFromMs: 10, createdAtToMs: 30,
        });
        const receiptsOnly = owners();
        const receipts = await readDeploymentActivityPageV1({ scope, owners: receiptsOnly, machineIds: ['machine-a'],
            query: { limit: 1, kind: 'receipt' } });
        expect(receipts.items.map(item => item.id)).toEqual(['receipt:new']);
        expect(receiptsOnly.listOperations).not.toHaveBeenCalled();
    });
    it('keeps operation-only pages independent of unseen receipt pages and retains independent operations', async () => {
        const source = owners();
        const deploymentRef = { kind: 'deployment' as const, serverId: 'home', environmentId: environment.id, deploymentId: 'old' };
        source.listOperations.mockResolvedValue({ items: [
            { ...operation('older-root', 50), actionId: 'deployments.teardown', domainRef: deploymentRef },
            { ...operation('backup', 40), actionId: 'deployments.backups.run', domainRef: deploymentRef },
            { ...operation('unadmitted-root', 30), actionId: 'deployments.deploy', state: 'failed' },
            { ...operation('template-root', 20), actionId: 'deployments.templates.instantiate', domainRef: deploymentRef },
        ], nextCursor: null });
        const page = await readDeploymentActivityPageV1({ scope, owners: source, machineIds: ['machine-a'],
            query: { limit: 10, kind: 'operation' } });
        expect(page.items.map(item => item.id)).toEqual([
            'operation:machine-a:older-root', 'operation:machine-a:backup',
            'operation:machine-a:unadmitted-root', 'operation:machine-a:template-root',
        ]);
        expect(source.listReceipts).toHaveBeenCalledTimes(1);
        expect(page.nextCursor).toBeNull();
    });
    it.each([undefined, 'operation'] as const)('keeps a repeated teardown with its own operation and requester visible for kind %s', async kind => {
        const source = owners();
        source.listReceipts.mockImplementation(async (_environmentId, cursor) => ({
            items: cursor ? [] : [{ ...receipt('reused-teardown', 10),
                actionOperationId: 'original-teardown', requestedByAccountId: 'original-requester' }],
            nextCursor: cursor ? null : 'older',
        }));
        source.listOperations.mockResolvedValue({ items: [{ ...operation('repeated-teardown', 40),
            actionId: 'deployments.teardown', domainRef: { kind: 'deployment', serverId: 'home',
                environmentId: environment.id, deploymentId: 'reused-teardown' } }], nextCursor: null });
        const page = await readDeploymentActivityPageV1({ scope, owners: source, machineIds: ['machine-a'],
            query: { limit: 10, ...(kind ? { kind } : {}) } });
        expect(page.items.map(item => item.id)).toEqual(kind === 'operation'
            ? ['operation:machine-a:repeated-teardown']
            : ['operation:machine-a:repeated-teardown', 'receipt:reused-teardown']);
        expect(source.listReceipts).toHaveBeenCalledTimes(kind === 'operation' ? 1 : 2);
        expect(page.nextCursor).toBeNull();
    });
});

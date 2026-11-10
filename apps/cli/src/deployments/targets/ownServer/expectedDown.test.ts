import { expect, it } from 'vitest';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { createOwnServerExpectedDownPublisher } from './expectedDown';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

it('publishes exact native subjects through the strict operation reader and clears them after resume', async () => {
    const store = createActionOperationStore();
    const spec = getActionSpec('deployments.backups.run');
    const scope = { accountId: 'account', machineId: 'machine' };
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'backup',
        resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation }) });
    await runner.observe({ actionId: spec.id, scope, input: {}, execute: async ({ publishOwnerUpdate }) => {
        const publish = createOwnServerExpectedDownPublisher({ serverId: 'home', environmentId: 'environment', targetLinkId: 'link',
            deploymentId: 'deployment', machineId: 'machine', installationId: 'installation',
            environmentInstanceId: 'instance', operation: 'backup',
            context: { operationOwnerUpdate: { update: publishOwnerUpdate } },
            async readDomains() { return [{ environmentId: 'environment', targetLinkId: 'link', domainId: 'domain',
                machineId: 'machine', installationId: 'installation' }]; } });
        await publish(['web']);
        const snapshot = ActionOperationSnapshotV1Schema.parse(store.get(scope, 'backup'));
        expect(snapshot.domainRef).toMatchObject({ kind: 'deployment', expectedDown: { operation: 'backup',
            serviceIds: ['instance/web'], domains: [{ environmentId: 'environment', targetLinkId: 'link', domainId: 'domain' }] } });
        await publish([]);
        expect(store.get(scope, 'backup')?.domainRef).toEqual({ kind: 'deployment', serverId: 'home',
            environmentId: 'environment', deploymentId: 'deployment' });
        return { ok: true, result: {} };
    } });
});

it('does no Domain read without an operation consumer and never invents unavailable Domain subjects', async () => {
    let reads = 0;
    const input = { serverId: 'home', environmentId: 'environment', targetLinkId: 'link', deploymentId: 'deployment', machineId: 'machine',
        installationId: 'installation', environmentInstanceId: 'instance', operation: 'backup' as const,
        async readDomains(): Promise<null> { reads++; throw new Error('Domain inventory unavailable'); } };
    await createOwnServerExpectedDownPublisher({ ...input, context: {} })(['web']);
    expect(reads).toBe(0);
    const store = createActionOperationStore();
    const spec = getActionSpec('deployments.backups.run');
    const scope = { accountId: 'account', machineId: 'machine' };
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'backup',
        resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation }) });
    await runner.observe({ actionId: spec.id, scope, input: {}, execute: async ({ publishOwnerUpdate }) => {
        await createOwnServerExpectedDownPublisher({ ...input,
            context: { operationOwnerUpdate: { update: publishOwnerUpdate } } })(['web']);
        expect(store.get(scope, 'backup')?.domainRef).toMatchObject({ expectedDown: { serviceIds: ['instance/web'], domains: [] } });
        return { ok: true, result: {} };
    } });
});

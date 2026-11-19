import { expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import {
    createDeploymentReceiptHeaderV1, createDeploymentSecretVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { DeploymentReadTransportV1 } from './deploymentReadControllerTypes.js';
import { createDeploymentReadControllerV1 } from './createDeploymentReadControllerV1.js';

it('projects the serving generation revision from already demanded receipts rather than a failed destination approval', async () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const binding = createDeploymentSecretVariableBindingV1({ name: 'TOKEN', phase: 'runtime', resourceId: 'credential', resourceRevision: 1 });
    const desired = { ...detail, content: { ...detail.content, bindings: [binding] },
        savedSecretRevisions: [{ resourceId: 'credential', revision: 2 }] };
    const original = createDeploymentReceiptDetailV1();
    const basis = { v: 1 as const, environmentId: detail.environment.id, environmentRevision: 1,
        targetLinkId: original.deployment.targetLinkId, targetLinkRevision: 1, sourceIntent: original.content.sourceIntent,
        manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'project', toolVersion: '2.40.1',
        services: ['app'], profiles: [], members: [{ machineId: 'machine-a', installationId: 'installation-a' }],
        bindings: [binding], images: [] };
    const running = { ...original, content: { ...original.content, ownServer: { approvedInputBasis: basis } } };
    const failed = createDeploymentReceiptDetailV1({
        deployment: createDeploymentReceiptHeaderV1({ id: 'failed-newer', state: 'failed', requestedAtMs: 2000,
            startedAtMs: 2001, settledAtMs: 2002 }),
        content: { ...original.content, machineResults: [{ ...original.content.machineResults[0]!,
            activation: 'failed', restoration: 'succeeded', currentDeploymentId: running.deployment.id }],
            ownServer: { approvedInputBasis: { ...basis, bindings: [{ ...binding,
                source: { ...binding.source, resourceRevision: 2 } }] } } },
    });
    const readEnvironment = vi.fn<DeploymentReadTransportV1['readEnvironment']>().mockResolvedValue({ ok: true, value: desired });
    const readReceipt = vi.fn<DeploymentReadTransportV1['readReceipt']>().mockImplementation(async (_scope, _environment, id) =>
        ({ ok: true, value: id === failed.deployment.id ? failed : running }));
    const listHistory = vi.fn<DeploymentReadTransportV1['listHistory']>();
    const controller = createDeploymentReadControllerV1({ scope: { serverId: 'home', accountId: 'account' }, transport: {
        readEnvironment, readReceipt, listHistory, listEnvironments: vi.fn(),
    } });
    const demand = { mounted: true, visible: true, focused: true };
    const environment = controller.acquireEnvironment(detail.environment.id, demand);
    const receipts = [running, failed].map(receipt => controller.acquireReceipt(detail.environment.id, receipt.deployment.id, demand));
    try {
        await Promise.all([environment.refresh(), ...receipts.map(receipt => receipt.refresh())]);
        expect(environment.getSnapshot()).toMatchObject({ status: 'ready', value: { secretRevisions: [{
            machineId: 'machine-a', installationId: 'installation-a', facts: [{ name: 'TOKEN', phase: 'runtime',
                runningRevision: 1, currentRevision: 2, status: 'redeploy_required' }],
        }] } });
        expect(readEnvironment).toHaveBeenCalledTimes(1);
        expect(readReceipt).toHaveBeenCalledTimes(2);
        expect(listHistory).not.toHaveBeenCalled();
    } finally {
        environment.release();
        receipts.forEach(receipt => receipt.release());
        controller.retire();
    }
});

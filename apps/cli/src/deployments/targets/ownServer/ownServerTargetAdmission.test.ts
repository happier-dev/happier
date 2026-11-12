import { describe, expect, it } from 'vitest';
import { createDeploymentReceiptDetailV1, createDeploymentReceiptHeaderV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { admitOwnServerDeploymentTargetLink, selectOwnServerRetainedServingSource } from './ownServerTargetAdmission';

describe('own-server catalog admission', () => {
    it('admits only the fixed host target and preserves target-member placement', () => {
        const link = createDeploymentTargetLinkHeaderV1();
        expect(() => admitOwnServerDeploymentTargetLink(link, 'machine-a')).not.toThrow();
        for (const invalid of [
            { ...link, source: { kind: 'host' as const, id: 'other-host' } },
            { ...link, targetKind: 'other-kind' },
            createDeploymentTargetLinkHeaderV1({
                source: { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'own-server' } },
                targetKind: 'ownServer', machines: [], members: [],
            }),
        ]) {
            expect(() => admitOwnServerDeploymentTargetLink(invalid, 'machine-a', 'machine-a'))
                .toThrow(expect.objectContaining({ code: 'target_mismatch' }));
        }
        expect(() => admitOwnServerDeploymentTargetLink(link, 'foreign-machine'))
            .toThrow(expect.objectContaining({ code: 'target_mismatch' }));
    });

    it('requires the admitted coordinator for multi-member execution', () => {
        const link = createDeploymentTargetLinkHeaderV1({ machines: ['machine-a', 'machine-b'], members: [
            { machineId: 'machine-a', installationId: 'installation-a', state: 'active' },
            { machineId: 'machine-b', installationId: 'installation-b', state: 'active' },
        ] });
        expect(() => admitOwnServerDeploymentTargetLink(link, 'machine-a'))
            .toThrow(expect.objectContaining({ code: 'unsupported' }));
        expect(() => admitOwnServerDeploymentTargetLink(link, 'controller', 'controller')).not.toThrow();
        expect(() => admitOwnServerDeploymentTargetLink(link, 'controller', 'other-controller'))
            .toThrow(expect.objectContaining({ code: 'target_mismatch' }));
    });
});


it('selects only exact current serving U for a joining deploy, including a successor membership link', () => {
    const receipt = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({
        id: 'serving-u', environmentId: 'environment', targetLinkId: 'predecessor', state: 'succeeded' }) });
    const link = createDeploymentTargetLinkHeaderV1({ id: 'membership-successor', environmentId: 'environment',
        activeDeploymentId: receipt.deployment.id, machines: ['machine-a', 'machine-d'], members: [
            { machineId: 'machine-a', installationId: 'installation-a', state: 'active' },
            { machineId: 'machine-d', installationId: 'installation-d', state: 'joining' },
        ] });
    const input = { actionId: 'deployments.deploy' as const, environmentId: 'environment', link,
        sourceIntent: receipt.content.sourceIntent, servingReceipt: receipt };
    expect(selectOwnServerRetainedServingSource(input)).toEqual(receipt.content.sourceIntent);
    expect(selectOwnServerRetainedServingSource({ ...input, actionId: 'deployments.promote' })).toBeNull();
    expect(selectOwnServerRetainedServingSource({ ...input, environmentId: 'foreign' })).toBeNull();
    expect(selectOwnServerRetainedServingSource({ ...input, link: { ...link, activeDeploymentId: 'other' } })).toBeNull();
    expect(selectOwnServerRetainedServingSource({ ...input, link: { ...link,
        members: link.members.map(member => ({ ...member, state: 'active' as const })) } })).toBeNull();
    expect(selectOwnServerRetainedServingSource({ ...input, servingReceipt: { ...receipt,
        deployment: { ...receipt.deployment, state: 'failed' } } })).toBeNull();
    const other = { ...receipt.content.sourceIntent, compose: { path: 'other.yaml', profiles: [], services: [] } };
    expect(selectOwnServerRetainedServingSource({ ...input, sourceIntent: other })).toBeNull();
});

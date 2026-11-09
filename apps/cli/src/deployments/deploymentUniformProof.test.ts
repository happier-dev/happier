import { describe, expect, it } from 'vitest';
import { createDeploymentReceiptDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentContentV1Schema } from '@happier-dev/deployment-protocol';
import { readDeploymentUniformTargetLinkRevisionV1 } from './deploymentUniformProof';

describe('installation-signed uniform receipt proof', () => {
    it('requires final version evidence for every current installation rather than copying target membership', () => {
        const receipt = createDeploymentReceiptDetailV1();
        const first = receipt.content.machineResults[0]!;
        const members = [
            { machineId: first.machineId, installationId: first.installationId, state: 'active' as const },
            { machineId: 'machine-b', installationId: 'installation-b', state: 'joining' as const },
        ];
        const targetLink = createDeploymentTargetLinkHeaderV1({ machines: members.map(member => member.machineId), members });
        const content = DeploymentContentV1Schema.parse({ ...receipt.content, machines: targetLink.machines });
        const input = { deploymentId: receipt.deployment.id, targetLink, content };
        expect(readDeploymentUniformTargetLinkRevisionV1(input), 'one activation cannot attest an unvisited peer').toBeNull();
        const peer = { ...first, machineId: 'machine-b', installationId: 'installation-b' };
        const complete = { ...content, machineResults: [first, peer] };
        expect(readDeploymentUniformTargetLinkRevisionV1({ ...input, content: complete })).toBe(targetLink.revision);
        expect(readDeploymentUniformTargetLinkRevisionV1({ ...input, content: { ...complete, machineResults: [first, {
            ...peer, restoration: 'succeeded', previousDeploymentId: receipt.deployment.id, currentDeploymentId: 'uniform-u1',
        }] } }), 'successful compensation proves U1, not the attempted version').toBeNull();
        expect(readDeploymentUniformTargetLinkRevisionV1({ ...input, content: { ...complete, machineResults: [first, {
            ...peer, activation: 'outcome_unknown',
        }] } })).toBeNull();
        expect(readDeploymentUniformTargetLinkRevisionV1({ ...input, content: { ...complete, machineResults: [first, {
            ...peer, installationId: 'retired-installation',
        }] } })).toBeNull();
    });
});

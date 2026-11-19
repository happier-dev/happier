import { describe, expect, it } from 'vitest';
import { createDeploymentReceiptDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { DeploymentContentV1Schema } from '@happier-dev/deployments/contracts/v1';
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
        expect(readDeploymentUniformTargetLinkRevisionV1({ ...input, content: complete })).toEqual({ expectedTargetLinkRevision: targetLink.revision });
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
    it('attests an observed retained serving release for a join without inventing new native versions', () => {
        const receipt = createDeploymentReceiptDetailV1();
        const servingDeploymentId = 'uniform-u1';
        const targetLink = createDeploymentTargetLinkHeaderV1({ activeDeploymentId: servingDeploymentId,
            machines: ['machine-a', 'machine-b'], members: [
                { machineId: 'machine-a', installationId: 'installation-a', state: 'active' },
                { machineId: 'machine-b', installationId: 'installation-b', state: 'joining' },
            ] });
        const content = DeploymentContentV1Schema.parse({ ...receipt.content, machines: targetLink.machines,
            ownServer: { approvedInputBasis: { v: 1, environmentId: receipt.deployment.environmentId,
                environmentRevision: 1, targetLinkId: targetLink.id, targetLinkRevision: targetLink.revision,
                sourceIntent: receipt.content.sourceIntent, manifestFingerprint: 'manifest', configInputDigests: [],
                physicalProjectName: 'project', toolVersion: '2.40.1', services: ['app'], profiles: [],
                members: targetLink.members.map(({ machineId, installationId }) => ({ machineId, installationId })),
                bindings: [], images: receipt.content.images },
                rollbackTarget: { deploymentId: servingDeploymentId, revision: { kind: 'repository', sha: 'a'.repeat(40) } } },
            machineResults: targetLink.members.map(member => ({ machineId: member.machineId,
                installationId: member.installationId, actionOperationId: receipt.deployment.actionOperationId,
                currentDeploymentId: servingDeploymentId, activation: 'pending', health: 'healthy', steps: [],
                ...(member.state === 'joining' ? { restoration: 'succeeded' } : {}) })) });
        const input = { deploymentId: receipt.deployment.id, actionOperationId: receipt.deployment.actionOperationId, targetLink, content };
        expect(readDeploymentUniformTargetLinkRevisionV1(input)).toEqual({ expectedTargetLinkRevision: targetLink.revision, servingDeploymentId });
        expect(readDeploymentUniformTargetLinkRevisionV1({ ...input, content: { ...content, machineResults: content.machineResults.map((row, index) =>
            index ? { ...row, currentDeploymentId: 'partial-v2' } : row) } })).toBeNull();
        expect(readDeploymentUniformTargetLinkRevisionV1({ ...input, content: { ...content, machineResults: content.machineResults.map((row, index) =>
            index ? { ...row, health: 'unknown' as const } : row) } })).toBeNull();
        expect(readDeploymentUniformTargetLinkRevisionV1({ ...input, targetLink: { ...targetLink, activeDeploymentId: 'changed-serving' } })).toBeNull();
        expect(readDeploymentUniformTargetLinkRevisionV1({ ...input, actionOperationId: 'stale-operation' })).toBeNull();
    });
});

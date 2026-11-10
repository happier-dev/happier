import { describe, expect, it } from 'vitest';
import { projectOwnServerDeploymentReview } from './ownServerDeploymentReview';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { OwnServerDeploymentInputBasisV1Schema } from '@happier-dev/deployment-protocol/v1';

describe('own-server deployment review reference changes', () => {
    it('compares the rendered reference with the exact serving launch and leaves absent evidence unknown', () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        const link = environment.targetLinks[0]!.targetLink;
        const inputBasis = OwnServerDeploymentInputBasisV1Schema.parse({ v: 1,
            environmentId: environment.environment.id, environmentRevision: environment.environment.revision,
            targetLinkId: link.id, targetLinkRevision: link.revision, sourceIntent: receipt.content.sourceIntent,
            members: link.members.map(({ machineId, installationId }) => ({ machineId, installationId })),
            bindings: [], images: receipt.content.images, manifestFingerprint: 'review-fixture', configInputDigests: [],
            physicalProjectName: 'review-fixture', toolVersion: '2.39.4', services: ['app'], profiles: [] });
        const address = { machineId: 'builder-c', installationId: 'installation-c', name: 'DATABASE_URL',
            phase: 'runtime' as const, source: { kind: 'reference' as const, environmentId: 'source-database',
                export: 'database', via: 'privateNetwork' as const }, address: 'postgres://100.64.0.7:25432' };
        receipt.content.ownServer = { approvedInputBasis: inputBasis, referenceAddresses: [address] };
        const changedAddress = { ...address, address: 'postgres://100.64.0.7:35432' };
        const input = { machineId: 'builder-c', environment, inputBasis, servingReceipt: receipt,
            nativeReview: { inspection: 'complete' as const, services: [], risks: [] },
            target: { engine: 'native' as const, requiresAwakeComputerAndDockerDesktop: false,
                domains: 'notDetermined' as const },
            referenceAddresses: [changedAddress] };
        expect(projectOwnServerDeploymentReview(input)).toMatchObject({
            referenceChanges: [{ name: 'DATABASE_URL', phase: 'runtime' }],
        });
        for (const referenceAddresses of [[address], [{ ...changedAddress, installationId: 'new-installation' }],
            [{ ...changedAddress, source: { ...address.source, export: 'other-database' } }]]) {
            expect(projectOwnServerDeploymentReview({ ...input, referenceAddresses })).not.toHaveProperty('referenceChanges');
        }
        receipt.content.ownServer!.referenceAddresses.push({ ...address, address: 'postgres://100.64.0.7:45432' });
        expect(projectOwnServerDeploymentReview(input)).not.toHaveProperty('referenceChanges');
        delete receipt.content.ownServer!.referenceAddresses;
        expect(projectOwnServerDeploymentReview(input)).not.toHaveProperty('referenceChanges');
        expect(projectOwnServerDeploymentReview({ ...input, servingReceipt: null })).not.toHaveProperty('referenceChanges');
    });

    it('carries the resolver\'s route for a changed Happier network reference, and none for a native one', () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        const link = environment.targetLinks[0]!.targetLink;
        const inputBasis = OwnServerDeploymentInputBasisV1Schema.parse({ v: 1,
            environmentId: environment.environment.id, environmentRevision: environment.environment.revision,
            targetLinkId: link.id, targetLinkRevision: link.revision, sourceIntent: receipt.content.sourceIntent,
            members: link.members.map(({ machineId, installationId }) => ({ machineId, installationId })),
            bindings: [], images: receipt.content.images, manifestFingerprint: 'review-fixture', configInputDigests: [],
            physicalProjectName: 'review-fixture', toolVersion: '2.39.4', services: ['app'], profiles: [] });
        const reference = (name: string, address: string) => ({ machineId: 'builder-c', installationId: 'installation-c', name,
            phase: 'runtime' as const, source: { kind: 'reference' as const, environmentId: 'source-database',
                export: name, via: 'auto' as const }, address });
        receipt.content.ownServer = { approvedInputBasis: inputBasis, referenceAddresses: [
            reference('DATABASE_URL', 'postgres://127.0.0.1:41000'), reference('CACHE_URL', 'redis://100.64.0.7:6379')] };
        const review = projectOwnServerDeploymentReview({ machineId: 'builder-c', environment, inputBasis, servingReceipt: receipt,
            nativeReview: { inspection: 'complete' as const, services: [], risks: [] },
            target: { engine: 'native' as const, requiresAwakeComputerAndDockerDesktop: false, domains: 'notDetermined' as const },
            referenceAddresses: [{ ...reference('DATABASE_URL', 'postgres://127.0.0.1:41001'),
                route: { kind: 'iroh', observedPath: 'relay' } }, reference('CACHE_URL', 'redis://100.64.0.8:6379')] });
        expect(review.referenceChanges).toEqual([
            { name: 'DATABASE_URL', phase: 'runtime', route: { kind: 'iroh', observedPath: 'relay' } },
            { name: 'CACHE_URL', phase: 'runtime' },
        ]);
    });
});

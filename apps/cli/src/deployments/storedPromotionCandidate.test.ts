import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createStoredPromotionReceiptContentForHost, prepareStoredPromotionCandidate, readStoredPromotionCandidateForHost } from './storedPromotionCandidate';
import { projectDeploymentFailure } from './deploymentFailure';
import { readDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';

const definition = (document: string, contentRevision: number) => ({ kind: 'stored' as const, document, contentRevision,
    composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app'] });

describe('stored promotion destination candidate', () => {
    it('names the missing destination builder and allows the same running-unverified receipt after configuring it', async () => {
        const source = createDeploymentReceiptDetailV1();
        source.deployment.state = 'running_unverified';
        source.content.sourceIntent = definition('{"services":{"app":{"image":"app:receipt"}}}', 1);
        const destination = createDeploymentEnvironmentDetailV1();
        destination.content.definition = definition('{"services":{"app":{"image":"app:old"}}}', 1);
        delete destination.environment.buildMachineId;
        destination.environment.runtimeTargetLinkId = destination.targetLinks[0].targetLink.id;
        const request = { input: { serverId: destination.environment.serverId, environmentId: destination.environment.id,
            sourceEnvironmentId: source.deployment.environmentId, sourceDeploymentId: source.deployment.id,
            artifact: 'image' as const }, context: {} };
        // Persisted Environment/Receipt reads are the boundary; preparation and failure presentation stay real.
        const readers = { async readEnvironmentMetadata() { return { ...destination.environment, id: source.deployment.environmentId }; },
            async readEnvironment() { return destination; }, async readReceipt() { return source; } };
        const failure = await readStoredPromotionCandidateForHost(request, readers).then(() => null,
            error => projectDeploymentFailure(error.code, error));
        expect(failure).toMatchObject({ ok: false, errorCode: 'required_fact_unavailable', details: { requiredFact: 'buildMachineId' } });
        if (!failure) throw new Error('Missing builder must refuse preparation');
        expect(readDeploymentFailureRecoveryV1(failure.errorCode, failure.details)).toMatchObject({
            requiredFact: 'buildMachineId', nextAction: { kind: 'navigate', destination: 'settings' } });
        destination.environment.buildMachineId = 'configured-builder';
        expect(await readStoredPromotionCandidateForHost(request, readers)).toMatchObject({ buildMachineId: 'configured-builder',
            sourceReceipt: { deployment: { id: source.deployment.id, state: 'running_unverified' } } });
    });

    it.each(['repository', 'folder', 'stored'] as const)('pins the %s release and retained images for the Production review', async kind => {
        const source = createDeploymentReceiptDetailV1();
        const destination = createDeploymentEnvironmentDetailV1();
        destination.environment.id = 'production';
        destination.environment.protection = 'production';
        destination.environment.runtimeTargetLinkId = destination.targetLinks[0].targetLink.id;
        destination.targetLinks[0].targetLink.environmentId = destination.environment.id;
        if (source.content.sourceIntent.kind !== 'repository') throw new Error('Expected repository fixture');
        const compose = { path: 'compose.release.yml', profiles: [], services: ['app'] };
        source.content.sourceIntent = kind === 'repository' ? { ...source.content.sourceIntent, projectSourceId: destination.environment.projectSourceId,
            sha: 'a'.repeat(40), sourceRevision: 12, compose }
            : kind === 'folder' ? { kind, workspaceId: 'reviewed-folder', manifestFingerprint: `sha256:${'f'.repeat(64)}`,
                fileCount: 2, totalBytes: 128, excludedPaths: [], compose }
                : definition('{"services":{"app":{"image":"app:captured"}}}', 19);
        destination.environment.capabilities.manage = false;
        const sourceEnvironment = { ...destination.environment, id: source.deployment.environmentId, protection: 'nonProduction' as const };
        const request = { input: {
            serverId: destination.environment.serverId, environmentId: destination.environment.id,
            sourceEnvironmentId: sourceEnvironment.id, sourceDeploymentId: source.deployment.id, artifact: 'image' as const,
        }, context: {} };
        const readers = {
            async readEnvironmentMetadata() { return sourceEnvironment; },
            async readEnvironment() { return destination; },
            async readReceipt() { return source; },
        };
        const candidate = await readStoredPromotionCandidateForHost(request, readers);
        expect(candidate.candidateEnvironmentContent).toEqual(destination.content);
        expect(createStoredPromotionReceiptContentForHost(candidate, 'rollbackAll')).toMatchObject({
            sourceIntent: source.content.sourceIntent, images: source.content.images,
        });
        await expect(readStoredPromotionCandidateForHost(request, { ...readers,
            async readEnvironmentMetadata() { return { ...sourceEnvironment, projectSourceId: 'different-app' }; },
        })).rejects.toMatchObject({ code: 'target_mismatch' });
    });

    it('copies the captured receipt definition while retaining every destination-owned choice', () => {
        const source = createDeploymentReceiptDetailV1();
        source.content.sourceIntent = definition('{"services":{"app":{"image":"app:receipt-X"}}}', 19);
        const destination = createDeploymentEnvironmentDetailV1();
        destination.content.definition = definition('{"services":{"app":{"image":"app:incumbent"}}}', 3);
        destination.content.bindings = [{ purpose: 'variable', name: 'DESTINATION_ONLY', phase: 'runtime',
            source: { kind: 'value', value: 'production' } }];
        destination.content.ownServer = { rollout: 'startFirst', autoRestorePreviousRelease: false };
        const before = structuredClone(destination);
        const candidate = prepareStoredPromotionCandidate(source, destination);
        expect(candidate).toEqual({ ...destination.content,
            definition: { ...source.content.sourceIntent, contentRevision: 4 } });
        expect(destination).toEqual(before);
        expect(candidate.bindings).toBe(destination.content.bindings);
        expect(candidate.ownServer).toBe(destination.content.ownServer);
    });
    it('keeps the destination definition revision for equal captured bytes and refuses a deployer-only writer at admission', async () => {
        const source = createDeploymentReceiptDetailV1();
        const destination = createDeploymentEnvironmentDetailV1();
        source.content.sourceIntent = definition('{"services":{"app":{"image":"app:X"}}}', 19);
        destination.content.definition = { ...source.content.sourceIntent, contentRevision: 3 };
        expect(prepareStoredPromotionCandidate(source, destination).definition).toEqual(destination.content.definition);
        destination.environment.capabilities.manage = false;
        await expect(readStoredPromotionCandidateForHost({ input: {
            serverId: destination.environment.serverId, environmentId: destination.environment.id,
            sourceEnvironmentId: source.deployment.environmentId, sourceDeploymentId: source.deployment.id, artifact: 'image',
        }, context: {} }, {
            async readEnvironmentMetadata() { return { ...destination.environment, capabilities: { ...destination.environment.capabilities, deploy: true } }; },
            async readEnvironment() { return destination; }, async readReceipt() { return source; },
        })).rejects.toMatchObject({ code: 'deployment_access_denied' });
    });
});

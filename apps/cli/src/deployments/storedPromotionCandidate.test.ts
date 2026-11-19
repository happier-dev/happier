import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { prepareStoredPromotionCandidate, readStoredPromotionCandidateForHost } from './storedPromotionCandidate';
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

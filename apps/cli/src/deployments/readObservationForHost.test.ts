import { expect, it } from 'vitest';
import { createDeploymentEnvironmentHeaderV1, createDeploymentTargetLinkHeaderV1,
    createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1,
    DeploymentPlatformContentV1Schema, type DeploymentArtifactDocumentV1 } from '@happier-dev/deployment-protocol';
import { readDeploymentObservationForHost } from './readObservationForHost';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { settleActionOutput } from '@happier-dev/protocol/actions/executor/resultProjection';

function fixture() {
    const environment = createDeploymentEnvironmentHeaderV1();
    const targetLink = createDeploymentTargetLinkHeaderV1({ source: { kind: 'plugin',
        contribution: { pluginId: 'happier.deploy.cloudflare', localId: 'workers' } },
        targetKind: 'cloudflare-workers', machines: [], members: [], state: 'provisioned' });
    const principal = { kind: 'account' as const, accountId: 'owner', purpose: {
        consumer: { pluginId: 'happier.deploy.cloudflare', localId: 'workers-deploy' }, purpose: 'deploy.manage' },
        target: { kind: 'account' as const, account: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'provider' } } };
    const native = { credentialPrincipal: principal, providerIdentity: { providerAccountId: 'a'.repeat(32),
        providerResourceId: 'worker', providerEnvironment: 'script:app' },
        providerEnvironment: { kind: 'script' as const, scriptName: 'app' } };
    const baseline = createDeploymentReceiptDetailV1();
    const detail = createDeploymentReceiptDetailV1({ content: DeploymentPlatformContentV1Schema.parse({
        sourceIntent: baseline.content.sourceIntent, sourceMethod: 'gitIntegration', machines: [], images: [], machineResults: [], steps: [],
        platform: { ...native, targetLinkRevision: targetLink.revision,
            observation: { v: 1, state: 'failed', providerDeploymentId: 'native-1', observedAtMs: 1100 } },
    }) });
    const documents = new Map<string, DeploymentArtifactDocumentV1>([
        [targetLink.contentArtifactId, { artifactId: targetLink.contentArtifactId,
            revision: { headerVersion: targetLink.contentHeaderVersion, bodyVersion: targetLink.contentBodyVersion },
            header: { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: 'Worker' }, body: JSON.stringify(native) }],
        [detail.deployment.contentArtifactId, { artifactId: detail.deployment.contentArtifactId,
            revision: { headerVersion: detail.deployment.contentHeaderVersion, bodyVersion: detail.deployment.contentBodyVersion },
            header: { kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'Deployment' }, body: JSON.stringify(detail.content) }],
    ]);
    const opened: string[] = [];
    // The metadata transport and private Artifact store are system boundaries.
    // Production parsers and exact-reference validation remain real.
    const host = {
        async readEnvironment() { return { ok: true as const, environment, targetLinks: [targetLink] }; },
        async readReceipt() { return { ok: true as const, deployment: detail.deployment }; },
        async open(id: string) { opened.push(id); return documents.get(id) ?? null; },
        async assertCurrent() {},
    };
    const input = { serverId: 'home', environmentId: environment.id, targetLinkId: targetLink.id };
    return { environment, targetLink, principal, detail, documents, opened, host, input };
}

it('projects the recorded principal and exact receipt identity through real private-content readers', async () => {
    const h = fixture();
    expect(await readDeploymentObservationForHost(h.input, {}, h.host)).toMatchObject({ ok: true,
        credentialPrincipal: h.principal, environment: { id: h.environment.id }, targetLink: { id: h.targetLink.id } });
    expect(h.opened).toEqual([h.targetLink.contentArtifactId]);
    h.opened.length = 0;
    expect(await readDeploymentObservationForHost({ ...h.input, deploymentId: h.detail.deployment.id }, {}, h.host))
        .toMatchObject({ ok: true, credentialPrincipal: h.principal,
            receipt: { deployment: { id: h.detail.deployment.id }, providerDeploymentId: 'native-1' } });
    expect(h.opened).toEqual([h.targetLink.contentArtifactId, h.detail.deployment.contentArtifactId]);
});

it.each([false, true])('identifies unsupported own-server observations and the working receipt read (receipt=%s)', async withReceipt => {
    const h = fixture();
    Object.assign(h.targetLink, createDeploymentTargetLinkHeaderV1({ id: h.targetLink.id,
        environmentId: h.environment.id }));
    h.documents.delete(h.targetLink.contentArtifactId);
    const result = await readDeploymentObservationForHost({ ...h.input,
        ...(withReceipt ? { deploymentId: h.detail.deployment.id } : {}) }, {}, h.host);
    expect(settleActionOutput('deployments.observation.get', ActionExecuteFailureSchema.parse(result))).toMatchObject({ ok: false,
        errorCode: 'unsupported_action', details: { reason: 'target_not_supported', targetKind: 'ownServer',
            requiredFact: 'providerDeploymentObservation', supportedAction: 'deployments.receipts.get',
            remedy: expect.stringMatching(/\S/) } });
    expect(h.opened).toEqual([]);
});

it('refuses unreadable or mismatched addresses before opening any private content', async () => {
    const h = fixture();
    h.environment.capabilities.read = false;
    expect(await readDeploymentObservationForHost(h.input, {}, h.host)).toEqual({ ok: false, error: 'deployment_access_denied' });
    h.environment.capabilities.read = true;
    await expect(readDeploymentObservationForHost({ ...h.input, environmentId: 'another-environment' }, {}, h.host))
        .rejects.toMatchObject({ code: 'target_mismatch' });
    await expect(readDeploymentObservationForHost({ ...h.input, targetLinkId: 'another-link' }, {}, h.host))
        .rejects.toMatchObject({ code: 'target_mismatch' });
    h.detail.deployment.targetLinkId = 'another-link';
    await expect(readDeploymentObservationForHost({ ...h.input, deploymentId: h.detail.deployment.id }, {}, h.host))
        .rejects.toMatchObject({ code: 'target_mismatch' });
    expect(h.opened).toEqual([]);
});

it('preserves exact private content reference failures instead of returning an unbound principal', async () => {
    const h = fixture();
    h.targetLink.contentBodyVersion += 1;
    expect(await readDeploymentObservationForHost(h.input, {}, h.host)).toEqual({ ok: false, error: 'deployment_conflict' });
});


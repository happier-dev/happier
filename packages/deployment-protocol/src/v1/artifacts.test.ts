import { describe, expect, it } from 'vitest';
import { ArtifactDocumentV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1, createDeploymentReceiptDetailV1 } from '../testing/v1.js';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
    readDeploymentEnvironmentArtifactHeaderV1, readDeploymentEnvironmentArtifactV1, readDeploymentTargetLinkArtifactV1,
    createDeploymentReceiptArtifactHeaderV1, readDeploymentReceiptArtifactHeaderV1, readDeploymentReceiptArtifactV1 } from './artifacts.js';
import { readDeploymentDomainArtifactV1 } from './artifacts.js';

describe('deployment Artifact content boundary', () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const reference = detail.environment;
    const artifact = ArtifactDocumentV1Schema.parse({
        artifactId: reference.contentArtifactId, ownerAccountId: 'account-owner',
        access: 'owner', publicAudience: 'none',
        header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Staging', excerpt: 'canonical metadata' },
        body: JSON.stringify(detail.content), revision: { headerVersion: 1, bodyVersion: 1 },
        seq: 1, createdAt: 1000, updatedAt: 1000,
    });
    it('opens provider identity through the existing mode-opened Artifact boundary and exact revisions', () => {
        const reference = createDeploymentTargetLinkHeaderV1();
        const content = { providerIdentity: { providerAccountId: 'provider-account', providerResourceId: 'project', providerEnvironment: 'production' } };
        const targetArtifact = ArtifactDocumentV1Schema.parse({ ...artifact, artifactId: reference.contentArtifactId,
            header: { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: 'Production provider link' }, body: JSON.stringify(content) });
        expect(readDeploymentTargetLinkArtifactV1(reference, targetArtifact)).toEqual({ ok: true, content, title: 'Production provider link' });
        expect(readDeploymentTargetLinkArtifactV1(reference, { ...targetArtifact, revision: { headerVersion: 1, bodyVersion: 2 } }))
            .toEqual({ ok: false, error: 'deployment_conflict' });
        expect(readDeploymentTargetLinkArtifactV1(reference, { ...targetArtifact,
            body: JSON.stringify({ ...content, providerIdentity: { ...content.providerIdentity, credentialId: 'private-credential' } }) }))
            .toEqual({ ok: false, error: 'deployment_content_unavailable' });
    });
    it('opens strict direct content while preserving generic Artifact metadata', () => {
        expect(readDeploymentEnvironmentArtifactV1(reference, artifact)).toEqual({ ok: true, content: detail.content, title: 'Staging' });
        const { body: _body, ...header } = artifact;
        expect(readDeploymentEnvironmentArtifactHeaderV1(reference, header)).toEqual({ ok: true, title: 'Staging' });
    });
    it('opens only the exact private Domain revision without accepting credentials or missing health input', () => {
        const content = { hostname: 'app.example.test', target: { service: 'web', containerPort: 3000, redirectTo: 'example.test' },
            healthCheck: { path: '/ready', expectStatus: 204 }, tls: { kind: 'custom' },
            basicAuth: { username: 'operator' } };
        const domain = { ...artifact, header: { kind: 'deployment-domain.v1', title: 'Application' },
            body: JSON.stringify(content) };
        expect(readDeploymentDomainArtifactV1(reference, domain)).toEqual({ ok: true, content, title: 'Application' });
        expect(readDeploymentDomainArtifactV1(reference, { ...domain, revision: { headerVersion: 1, bodyVersion: 2 } }))
            .toEqual({ ok: false, error: 'deployment_conflict' });
        for (const body of [{ ...content, healthCheck: undefined }, { ...content, tls: { kind: 'custom', privateKeyPem: 'private' } },
            { ...content, basicAuth: { username: 'operator', password: 'private' } },
            { ...content, redirectTo: 'https://example.test' }]) {
            expect(readDeploymentDomainArtifactV1(reference, { ...domain, body: JSON.stringify(body) }))
                .toEqual({ ok: false, error: 'deployment_content_unavailable' });
        }
        expect(readDeploymentDomainArtifactV1(reference, { ...domain, header: artifact.header }))
            .toEqual({ ok: false, error: 'deployment_content_unavailable' });
    });
    it('reads writer-produced receipt steps with exact versions, generic metadata and explicit legacy unknown', () => {
        const receipt = createDeploymentReceiptDetailV1();
        receipt.content.steps = [{ id: 'native', label: 'Native deployment', state: 'running' }];
        receipt.content.failure = { code: 'deployment_failed', phase: 'activate' };
        receipt.content.commitSubject = 'Repair worker startup';
        const projected = createDeploymentReceiptArtifactHeaderV1('Exact A', receipt.content);
        const header = { artifactId: receipt.deployment.contentArtifactId, revision: { headerVersion: 1, bodyVersion: 1 },
            header: { ...projected, excerpt: 'generic Artifact metadata' } };
        expect(readDeploymentReceiptArtifactHeaderV1(receipt.deployment, header))
            .toEqual({ ok: true, title: 'Exact A', steps: receipt.content.steps });
        expect(readDeploymentReceiptArtifactV1(receipt.deployment, { ...header, body: JSON.stringify(receipt.content) }))
            .toEqual({ ok: true, title: 'Exact A', content: receipt.content });
        expect(header.header).not.toHaveProperty('failure');
        expect(header.header).not.toHaveProperty('commitSubject');
        expect(readDeploymentReceiptArtifactHeaderV1(receipt.deployment, { ...header,
            header: { ...header.header, steps: undefined } })).toEqual({ ok: true, title: 'Exact A', steps: null });
        expect(readDeploymentReceiptArtifactHeaderV1(receipt.deployment, { ...header,
            revision: { headerVersion: 1, bodyVersion: 2 } })).toEqual({ ok: false, error: 'deployment_conflict' });
        expect(readDeploymentReceiptArtifactHeaderV1(receipt.deployment, { ...header,
            header: { ...header.header, steps: [{ ...receipt.content.steps[0], state: 'invented' }] } }))
            .toEqual({ ok: false, error: 'deployment_content_unavailable' });
    });
    it('refuses stale identity, revisions, wrong private kinds and stored wrappers', () => {
        expect(readDeploymentEnvironmentArtifactV1(reference, { ...artifact, artifactId: 'other' })).toEqual({ ok: false, error: 'deployment_conflict' });
        expect(readDeploymentEnvironmentArtifactV1(reference, { ...artifact, revision: { headerVersion: 2, bodyVersion: 1 } })).toEqual({ ok: false, error: 'deployment_conflict' });
        expect(readDeploymentEnvironmentArtifactHeaderV1(reference, { ...artifact, revision: { headerVersion: 1, bodyVersion: 2 } })).toEqual({ ok: false, error: 'deployment_conflict' });
        expect(readDeploymentEnvironmentArtifactV1(reference, { ...artifact, header: { ...artifact.header, kind: 'other' } }).ok).toBe(false);
        expect(readDeploymentEnvironmentArtifactV1(reference, { ...artifact, body: JSON.stringify({ t: 'plain', v: detail.content }) }).ok).toBe(false);
        expect(readDeploymentEnvironmentArtifactV1(reference, { ...artifact, body: JSON.stringify({ ...detail.content, unknown: 'secret' }) }).ok).toBe(false);
        expect(readDeploymentEnvironmentArtifactV1(reference, { ...artifact, body: '{malformed' }).ok).toBe(false);
        expect(readDeploymentEnvironmentArtifactV1(reference, { ...artifact, body: null }).ok).toBe(false);
        expect(readDeploymentEnvironmentArtifactV1(reference, null).ok).toBe(false);
    });
});

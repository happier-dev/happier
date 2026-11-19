import { describe, expect, it } from 'vitest';
import { readDeploymentDomainArtifactV1, type DeploymentArtifactDocumentV1 } from './deploymentArtifacts.js';

describe('protected Domain Cloudflare preparation', () => {
    const reference = { contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 2 };
    const content = { hostname: 'app.example.test', target: { service: 'web', containerPort: 8080 },
        healthCheck: { path: '/health', expectStatus: 200 } };
    const connector = { machineId: 'receiver', installationId: 'installed',
        imageRef: 'cloudflare/cloudflared:2026.10.0', version: '2026.10.0',
        networkName: 'environment_default', grantRef: 'opaque-home-issued-grant' };
    const owned = [{ hostname: content.hostname, expectedService: 'http://172.18.0.2:9381' }];
    function artifact(body: unknown): DeploymentArtifactDocumentV1 {
        return { artifactId: reference.contentArtifactId, header: { kind: 'deployment-domain.v1', title: 'App' },
            body: JSON.stringify(body), revision: { headerVersion: 1, bodyVersion: 2 } };
    }

    it.each([undefined, 'created', 'adopted'] as const)('reopens saved provenance %s and every captured target grant from the pinned private Artifact', tunnelOwnership => {
        const prepared = { ...content, cloudflarePreparation: { tunnelId: 'vendor-tunnel', owned,
            ...(tunnelOwnership ? { tunnelOwnership } : {}),
            dnsOwnership: [{ hostname: content.hostname, recordId: 'vendor-record' }], connectors: [connector, { ...connector, machineId: 'receiver-b', installationId: 'installed-b', grantRef: 'other-target-grant' }] } };
        expect(readDeploymentDomainArtifactV1(reference, artifact(prepared)))
            .toEqual({ ok: true, title: 'App', content: prepared });
        expect(readDeploymentDomainArtifactV1({ ...reference, contentBodyVersion: 1 }, artifact(prepared)))
            .toMatchObject({ ok: false, error: 'deployment_conflict',
                failureCause: { phase: 'deployment.artifact.revision', errorCode: 'deployment_conflict' } });
        expect(readDeploymentDomainArtifactV1(reference, artifact({ ...prepared,
            cloudflarePreparation: { ...prepared.cloudflarePreparation, connectors: [{ ...connector, token: 'never-persist-this' }] },
        }))).toMatchObject({ ok: false, error: 'deployment_content_unavailable',
            failureCause: { phase: 'deployment.artifact.content', errorCode: 'deployment_content_unavailable' } });
    });

    it('retains acknowledged vendor coordinates without claiming a connector grant after unknown preparation', () => {
        const recovery = { ...content, cloudflarePreparation: { tunnelId: 'vendor-tunnel', owned,
            dnsOwnership: [{ hostname: content.hostname, recordId: 'acknowledged-record' }] } };
        expect(readDeploymentDomainArtifactV1(reference, artifact(recovery)))
            .toEqual({ ok: true, title: 'App', content: recovery });
    });
});

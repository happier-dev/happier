import { describe, expect, expectTypeOf, it } from 'vitest';

import {
    createDeploymentReceiptDetailV1,
    createDeploymentEnvironmentHeaderV1,
    createDeploymentTargetLinkHeaderV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import {
    readDeploymentReceiptArtifactV1 as canonicalReadReceipt,
    readDeploymentTargetLinkArtifactV1 as canonicalReadTargetLink,
} from '@happier-dev/deployment-protocol/v1';

import * as publicProtocol from './protocol/index.js';
import * as browserProtocol from './protocol/index.browser.js';

describe.each([
    ['public', publicProtocol],
    ['browser', browserProtocol],
] as const)('deployment Artifact readers through the %s SDK protocol entry', (_entry, protocol) => {
    const revisionFailure = {
        ok: false, error: 'deployment_conflict',
        failureCause: { phase: 'deployment.artifact.revision', errorClass: 'TypeError',
            errorCode: 'deployment_conflict', httpStatus: null },
    } satisfies publicProtocol.DeploymentArtifactReadFailureV1;
    const contentFailure = {
        ok: false, error: 'deployment_content_unavailable',
        failureCause: { phase: 'deployment.artifact.content', errorClass: 'TypeError',
            errorCode: 'deployment_content_unavailable', httpStatus: null },
    } satisfies publicProtocol.DeploymentArtifactReadFailureV1;

    it('opens exact receipts and refuses stale references and invalid content', () => {
        expectTypeOf(protocol.readDeploymentReceiptArtifactV1).toEqualTypeOf<typeof canonicalReadReceipt>();
        const receipt = createDeploymentReceiptDetailV1();
        const artifact = {
            artifactId: receipt.deployment.contentArtifactId,
            revision: { headerVersion: 1, bodyVersion: 1 },
            header: { kind: 'deployment-receipt.v1', title: 'Deployment' },
            body: JSON.stringify(receipt.content),
        };
        expect(protocol.readDeploymentReceiptArtifactV1(receipt.deployment, artifact))
            .toEqual({ ok: true, title: 'Deployment', content: receipt.content });
        expect(protocol.readDeploymentReceiptArtifactV1(receipt.deployment, { ...artifact, artifactId: 'another-receipt' }))
            .toEqual(revisionFailure);
        expect(protocol.readDeploymentReceiptArtifactV1(receipt.deployment, { ...artifact, body: '{}' }))
            .toEqual(contentFailure);
    });

    it('opens exact target links and preserves canonical content and revision refusals', () => {
        expectTypeOf(protocol.readDeploymentTargetLinkArtifactV1).toEqualTypeOf<typeof canonicalReadTargetLink>();
        const reference = createDeploymentTargetLinkHeaderV1();
        const content = { providerIdentity: { providerAccountId: 'account', providerResourceId: 'worker', providerEnvironment: 'production' } };
        const artifact = {
            artifactId: reference.contentArtifactId,
            revision: { headerVersion: 1, bodyVersion: 1 },
            header: { kind: 'deployment-target-link.v1', title: 'Cloudflare' },
            body: JSON.stringify(content),
        };
        expect(protocol.readDeploymentTargetLinkArtifactV1(reference, artifact))
            .toEqual({ ok: true, title: 'Cloudflare', content });
        expect(protocol.readDeploymentTargetLinkArtifactV1(reference, { ...artifact, revision: { headerVersion: 1, bodyVersion: 2 } }))
            .toEqual(revisionFailure);
        expect(protocol.readDeploymentTargetLinkArtifactV1(reference, { ...artifact,
            body: JSON.stringify({ ...content, credentialId: 'private-credential' }) }))
            .toEqual(contentFailure);
    });

    it('accepts the producer-owned Environment secret scope through both public SDK projections', () => {
        const environment = createDeploymentEnvironmentHeaderV1();
        const targetLink = createDeploymentTargetLinkHeaderV1({ environmentId: environment.id });
        const parsed = protocol.ProtocolDeploymentEnvironmentGetResultV1Schema.safeParse({
            ok: true,
            environment,
            secretScope: { status: 'ready', reason: 'secret_scope_current', requiredGrantCount: 0, missingGrantCount: 0 },
            targetLinks: [targetLink],
        });
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.ok).toBe(true);
            if (parsed.data.ok) expect(parsed.data.secretScope?.status).toBe('ready');
        }
        expect(protocol.ProtocolDeploymentEnvironmentGetResultV1Schema.safeParse({
            ok: true, environment, targetLinks: [targetLink], unexpected: true,
        }).success).toBe(false);
    });
});

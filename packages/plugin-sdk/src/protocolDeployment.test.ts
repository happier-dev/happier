import { describe, expect, expectTypeOf, it } from 'vitest';

import {
    DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1,
    DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
} from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import {
    readDeploymentReceiptArtifactV1 as canonicalReadReceipt,
    type DeploymentContentV1,
} from '@happier-dev/protocol/deployments/deploymentReceiptContentV1';
import {
    readDeploymentTargetLinkArtifactV1 as canonicalReadTargetLink,
} from '@happier-dev/protocol/deployments/deploymentTargetLinkContentV1';
import {
    DeploymentEnvironmentHeaderV1Schema,
    DeploymentTargetLinkHeaderV1Schema,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';

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
    const kindFailure = {
        ...contentFailure,
        failureCause: { ...contentFailure.failureCause, phase: 'deployment.artifact.kind' },
    } satisfies publicProtocol.DeploymentArtifactReadFailureV1;
    const reference = {
        contentArtifactId: 'artifact',
        contentHeaderVersion: 1,
        contentBodyVersion: 1,
    } satisfies publicProtocol.DeploymentArtifactContentReferenceV1;

    it('opens exact receipts and refuses stale references and invalid content', () => {
        expectTypeOf(protocol.readDeploymentReceiptArtifactV1).toEqualTypeOf<typeof canonicalReadReceipt>();
        const content = {
            sourceIntent: {
                kind: 'repository', projectSourceId: 'source-app', sourceRevision: 1,
                sha: 'a'.repeat(40), compose: { path: 'compose.yaml', profiles: [], services: [] },
            },
            machines: ['machine-a'], buildMachineId: 'machine-a', onFailure: 'rollbackAll',
            images: [], machineResults: [], steps: [],
        } satisfies DeploymentContentV1;
        const artifact = {
            artifactId: reference.contentArtifactId,
            revision: { headerVersion: 1, bodyVersion: 1 },
            header: { kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'Deployment' },
            body: JSON.stringify(content),
        };
        expect(protocol.readDeploymentReceiptArtifactV1(reference, artifact))
            .toEqual({ ok: true, title: 'Deployment', content });
        expect(protocol.readDeploymentReceiptArtifactV1(reference, { ...artifact, artifactId: 'another-receipt' }))
            .toEqual(revisionFailure);
        expect(protocol.readDeploymentReceiptArtifactV1(reference, { ...artifact,
            revision: { ...artifact.revision, headerVersion: 2 } })).toEqual(revisionFailure);
        expect(protocol.readDeploymentReceiptArtifactV1(reference, { ...artifact,
            header: { ...artifact.header, kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } })).toEqual(kindFailure);
        expect(protocol.readDeploymentReceiptArtifactV1(reference, { ...artifact, body: '{}' }))
            .toEqual(contentFailure);
    });

    it('opens exact target links and preserves canonical content and revision refusals', () => {
        expectTypeOf(protocol.readDeploymentTargetLinkArtifactV1).toEqualTypeOf<typeof canonicalReadTargetLink>();
        const content = { providerIdentity: { providerAccountId: 'account', providerResourceId: 'worker', providerEnvironment: 'production' } };
        const artifact = {
            artifactId: reference.contentArtifactId,
            revision: { headerVersion: 1, bodyVersion: 1 },
            header: { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: 'Cloudflare' },
            body: JSON.stringify(content),
        };
        expect(protocol.readDeploymentTargetLinkArtifactV1(reference, artifact))
            .toEqual({ ok: true, title: 'Cloudflare', content });
        expect(protocol.readDeploymentTargetLinkArtifactV1(reference, { ...artifact, artifactId: 'another-link' }))
            .toEqual(revisionFailure);
        expect(protocol.readDeploymentTargetLinkArtifactV1(reference, { ...artifact, revision: { headerVersion: 1, bodyVersion: 2 } }))
            .toEqual(revisionFailure);
        expect(protocol.readDeploymentTargetLinkArtifactV1(reference, { ...artifact,
            header: { ...artifact.header, kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } })).toEqual(kindFailure);
        expect(protocol.readDeploymentTargetLinkArtifactV1(reference, { ...artifact,
            body: JSON.stringify({ ...content, credentialId: 'private-credential' }) }))
            .toEqual(contentFailure);
    });

    it('accepts the producer-owned Environment secret scope through both public SDK projections', () => {
        const environment = DeploymentEnvironmentHeaderV1Schema.parse({
            ...reference, v: 1, id: 'environment', serverId: 'home', projectSourceId: 'source', revision: 1,
            owner: { kind: 'account', accountId: 'owner' }, protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', dataEditorMode: 'off', dataAgentAccess: 'read', controllerMachineId: 'machine',
            createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1,
            capabilities: { role: 'manager', read: true, deploy: true, editData: false, manage: true,
                manageBindings: true, manageTargets: true, delete: true },
        });
        const targetLink = DeploymentTargetLinkHeaderV1Schema.parse({
            ...reference, v: 1, id: 'target-link', environmentId: environment.id, revision: 1,
            role: 'runtime', source: { kind: 'host', id: 'own-server' }, targetKind: 'ownServer', state: 'deployed',
            machines: ['machine'], members: [{ machineId: 'machine', installationId: 'installation', state: 'active' }],
            createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1,
        });
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

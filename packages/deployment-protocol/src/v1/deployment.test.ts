import { describe, expect, it } from 'vitest';
import { createDeploymentReceiptDetailV1, createDeploymentV1 } from '../testing/v1.js';
import { canTransitionDeploymentV1, DeploymentContentV1Schema, DeploymentV1Schema,
    DeploymentPlatformContentV1Schema } from './deployment.js';
import { DeploymentTargetRoleFailureV1Schema } from '@happier-dev/protocol/plugins/contributions/v2';

describe('receipt structural integrity', () => {
    it('admits provider-built repository source without admitting a native receipt without Compose', () => {
        const { content } = createDeploymentReceiptDetailV1();
        const sourceIntent = { kind: 'repository', projectSourceId: 'source', sourceRevision: 1, sha: 'a'.repeat(40) };
        const platform = { sourceIntent, sourceMethod: 'gitIntegration', machines: [], images: [], machineResults: [], steps: [],
            platform: { credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
                consumer: { pluginId: 'happier.deployment-vercel', localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' },
                target: { kind: 'account', account: { service: { pluginId: 'happier.machine-vercel', localId: 'vercel' }, accountId: 'connected' } } },
                providerIdentity: { providerAccountId: 'team', providerResourceId: 'project', providerEnvironment: 'production' },
                providerEnvironment: { kind: 'production' }, targetLinkRevision: 1,
                observation: { v: 1, state: 'queued', observedAtMs: 1000 } } };
        expect(DeploymentPlatformContentV1Schema.safeParse(platform).success).toBe(true);
        expect(DeploymentContentV1Schema.safeParse({ ...content, sourceIntent }).success).toBe(false);
    });
    it('retains canonical provider failure phases in serialized receipt content', () => {
        const { content } = createDeploymentReceiptDetailV1();
        const provider = DeploymentTargetRoleFailureV1Schema.parse({ v: 1,
            code: 'provider_request_failed', phase: 'send', retryable: false });
        const failure = { code: provider.code, phase: provider.phase };
        expect(DeploymentContentV1Schema.parse(JSON.parse(JSON.stringify({ ...content, failure }))))
            .toMatchObject({ failure });
        expect(DeploymentContentV1Schema.parse({ ...content, failure: { code: 'native_failed', phase: 'activate' } }))
            .toMatchObject({ failure: { code: 'native_failed', phase: 'activate' } });
        expect(DeploymentContentV1Schema.safeParse({ ...content, failure: { ...failure, phase: 'invented' } }).success).toBe(false);
    });
    it('retains data cleanup custody without inventing runtime source provenance', () => {
        const credentialRef = { service: { pluginId: 'happier.deployment-supabase', localId: 'supabase' }, accountId: 'connected-A' };
        const content = { machines: [], images: [], machineResults: [], steps: [], platform: {
            credentialPrincipal: { kind: 'account', accountId: 'account-A', purpose: {
                consumer: { pluginId: 'happier.deployment-supabase', localId: 'projects-link' }, purpose: 'deploy-manage' },
                target: { kind: 'account', account: credentialRef } },
            providerIdentity: { providerAccountId: 'organization-A', providerResourceId: 'parent-A', providerEnvironment: 'child-A' },
            providerEnvironment: { kind: 'custom', id: 'child-A' }, targetLinkRevision: 2,
            observation: { v: 1, state: 'queued', observedAtMs: 1000 }, dataCreation: { retainedProviderResource: true, reference: { runId: 'run-A', invocationId: 'invocation-A' },
                deleteAction: { pluginId: 'happier.deployment-supabase', localId: 'branches-delete' }, operands: {} } } };
        expect(DeploymentContentV1Schema.parse(content)).toEqual(content);
        expect(DeploymentContentV1Schema.safeParse({ ...content, platform: { ...content.platform, dataCreation: undefined } }).success).toBe(false);
    });
    it('never promotes an unknown outcome to success after the effect slot is released', () => {
        expect(canTransitionDeploymentV1('running', 'succeeded')).toBe(true);
        expect(canTransitionDeploymentV1('running', 'running_unverified')).toBe(true);
        expect(canTransitionDeploymentV1('outcome_unknown', 'running')).toBe(false);
        expect(canTransitionDeploymentV1('outcome_unknown', 'succeeded')).toBe(false);
        expect(canTransitionDeploymentV1('outcome_unknown', 'running_unverified')).toBe(false);
        expect(canTransitionDeploymentV1('outcome_unknown', 'outcome_unknown')).toBe(true);
        expect(canTransitionDeploymentV1('outcome_unknown', 'failed')).toBe(true);
        expect(canTransitionDeploymentV1('outcome_unknown', 'cancelled')).toBe(true);
    });
    it('retains display-only Forge correlations in protected receipt content, never as approval gates', () => {
        const receipt = createDeploymentV1();
        if (receipt.content.t !== 'plain') throw new Error('Expected opened receipt fixture');
        const correlations = [
            { kind: 'forgeRun', url: 'https://forge.example/project/runs/1' },
            { kind: 'forgeCheck', url: 'https://forge.example/project/checks/2' },
            { kind: 'githubReview', url: 'https://github.com/example/app/pull/3#pullrequestreview-4' },
        ];
        const content = { ...receipt.content.v, correlations };
        expect(DeploymentContentV1Schema.parse(JSON.parse(JSON.stringify(content)))).toMatchObject({ correlations });
        for (const correlation of [{ ...correlations[0], approvalId: 'gate' },
            { kind: 'githubGate', url: correlations[2]!.url }, { kind: 'forgeRun', url: 'javascript:alert(1)' }]) {
            expect(DeploymentContentV1Schema.safeParse({ ...content, correlations: [correlation] }).success).toBe(false);
        }
        expect(DeploymentV1Schema.safeParse({ ...receipt, correlations }).success).toBe(false);
        expect(DeploymentV1Schema.parse(receipt)).toEqual(receipt);
    });

    it('retains exact archive holder and raw transport identity with the receipt image', () => {
        const { content } = createDeploymentReceiptDetailV1();
        const image = content.images[0]!;
        const imageArchives = [{ image, holder: { serverId: 'home', machineId: 'builder', installationId: 'builder-installation',
            rootPath: '/deployment/instance/image-archives/release', path: '/deployment/instance/image-archives/release/image.tar' },
            sizeBytes: 4096, sha256: 'c'.repeat(64) }];
        const approvedInputBasis = { v: 1, environmentId: 'environment-staging', environmentRevision: 1,
            targetLinkId: 'target-link', targetLinkRevision: 1, sourceIntent: content.sourceIntent,
            manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'project', toolVersion: '2.39.4',
            services: ['app'], profiles: [], members: [{ machineId: 'machine-a', installationId: 'installation-a' }],
            bindings: [], images: content.images, health: [{ service: 'app', participates: false }] };
        const stored = { ...content, ownServer: { approvedInputBasis, imageArchives } };
        const stageLogs = [{ machineId: content.buildMachineId, installationId: 'builder-installation',
            relativePath: '.happier/deploy.log' }];
        expect(DeploymentContentV1Schema.safeParse({ ...stored, ownServer: { ...stored.ownServer, stageLogs } }))
            .toMatchObject({ success: true, data: { ownServer: { stageLogs } } });
        expect(DeploymentContentV1Schema.safeParse({ ...stored, ownServer: { ...stored.ownServer,
            stageLogs: [{ ...stageLogs[0], relativePath: '../foreign' }] } }).success).toBe(false);
        expect(DeploymentContentV1Schema.safeParse({ ...stored, ownServer: { ...stored.ownServer,
            stageLogs: [...stageLogs, ...stageLogs] } }).success).toBe(false);
        expect(DeploymentContentV1Schema.safeParse(stored)).toMatchObject({ success: true, data: { ownServer: { imageArchives } } });
        expect(DeploymentContentV1Schema.parse(JSON.parse(JSON.stringify(stored))).ownServer?.approvedInputBasis.health)
            .toEqual(approvedInputBasis.health);
        expect(DeploymentContentV1Schema.safeParse({ ...stored, ownServer: { ...stored.ownServer,
            approvedInputBasis: { ...approvedInputBasis, health: [{ service: 'app', participates: 'false' }] } } }).success).toBe(false);
        expect(DeploymentContentV1Schema.safeParse({ ...stored, ownServer: { ...stored.ownServer,
            imageArchives: [{ ...imageArchives[0], sha256: `sha256:${'c'.repeat(64)}` }] } }).success).toBe(false);
        expect(DeploymentContentV1Schema.safeParse({ ...stored, images: [{ ...image, configDigest: `sha256:${'d'.repeat(64)}` }] }).success).toBe(false);
        const buildSecretRevisions = [{ service: image.service, machineId: content.buildMachineId,
            installationId: 'builder-installation', bindings: [] }];
        expect(DeploymentContentV1Schema.safeParse({ ...stored, ownServer: { ...stored.ownServer, buildSecretRevisions } }))
            .toMatchObject({ success: true, data: { ownServer: { buildSecretRevisions } } });
        expect(DeploymentContentV1Schema.safeParse({ ...stored, ownServer: { ...stored.ownServer,
            buildSecretRevisions: [{ ...buildSecretRevisions[0], bindings: [{ ref: 'personal', resourceRevision: 1 }] }] } }).success).toBe(false);
        expect(DeploymentContentV1Schema.safeParse({ ...stored, ownServer: { ...stored.ownServer,
            buildSecretRevisions: [...buildSecretRevisions, ...buildSecretRevisions] } }).success).toBe(false);
    });
    it('rejects impossible receipt chronology and self-referencing lineage at the public boundary', () => {
        const receipt = createDeploymentV1();
        expect(DeploymentV1Schema.safeParse({ ...receipt, startedAtMs: receipt.requestedAtMs - 1 }).success).toBe(false);
        expect(DeploymentV1Schema.safeParse({ ...receipt, settledAtMs: receipt.requestedAtMs - 1 }).success).toBe(false);
        expect(DeploymentV1Schema.safeParse({ ...receipt, predecessorDeploymentId: receipt.id }).success).toBe(false);
        expect(DeploymentV1Schema.safeParse({ ...receipt, operation: 'rollback', rollbackOfDeploymentId: receipt.id }).success).toBe(false);
        expect(DeploymentV1Schema.safeParse({ ...receipt, operation: 'promote', promotedFromDeploymentId: receipt.id }).success).toBe(false);
    });
});

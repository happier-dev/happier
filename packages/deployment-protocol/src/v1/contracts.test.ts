import { describe, expect, it } from 'vitest';

import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1, createDeploymentEnvironmentV1, createDeploymentReceiptHeaderV1, createDeploymentTargetLinkHeaderV1, createDeploymentTargetLinkV1, createDeploymentTargetLinksListResultV1, createDeploymentTargetV1, createDeploymentV1 } from '../testing/v1.js';
import { DeploymentEnvironmentContentV1Schema, DeploymentEnvironmentListResultV1Schema, DeploymentEnvironmentV1Schema, EnvironmentSecretBindingV1Schema } from './environment.js';
import { DeploymentSourceIntentV1Schema, DeploymentStateV1Schema, DeploymentV1Schema, canTransitionDeploymentV1, isDeploymentSettledV1 } from './deployment.js';
import { DeploymentOwnServerTargetLinkContentV1Schema, DeploymentTargetLinkContentV1Schema, DeploymentTargetLinkV1Schema, DeploymentTargetLinksListResultV1Schema, DeploymentTargetV1Schema } from './target.js';
import { DeploymentEnvironmentDetailV1Schema } from './details.js';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentReceiptGetResultV1Schema } from './operations.js';
import { DeploymentTargetRoleInputSchemasV1, DeploymentTargetRoleResultV1Schema, DeploymentTargetRoleFailureV1Schema,
    DeploymentTargetCredentialPrincipalV1Schema, DeploymentTargetPreparedNativeV1Schema } from './target.js';

describe('S0 deployment wire contracts', () => {
    it('uses the canonical SCM branch grammar for captured Preview branches', () => {
        for (const gitBranch of ['feature/x', 'fix/abc-123', 'release/1.2']) {
            const prepared = { projectName: 'worker', gitBranch };
            expect(DeploymentTargetPreparedNativeV1Schema.parse(prepared)).toEqual(prepared);
        }
        for (const gitBranch of ['feature/../x', 'feature/with space']) {
            expect(DeploymentTargetPreparedNativeV1Schema.safeParse({ projectName: 'worker', gitBranch }).success).toBe(false);
        }
    });
    it('retains only the captured native Compose origin while keeping ordinary own-server links empty', () => {
        const content = { nativeOrigin: { projectName: 'existing-app', dockerEndpoint: 'unix:///var/run/docker.sock',
            workingDirectory: '/srv/existing-app' } };
        expect(DeploymentOwnServerTargetLinkContentV1Schema.parse({})).toEqual({});
        expect(DeploymentOwnServerTargetLinkContentV1Schema.parse(content)).toEqual(content);
        expect(DeploymentTargetLinkContentV1Schema.parse(content)).toEqual(content);
        for (const extra of [{ volumes: ['data'] }, { bindSource: '/srv/data' }, { configFiles: ['/srv/compose.yml'] },
            { document: 'services: {}' }, { providerIdentity: { providerResourceId: 'existing-app' } }]) {
            expect(DeploymentTargetLinkContentV1Schema.safeParse({ nativeOrigin: { ...content.nativeOrigin, ...extra } }).success).toBe(false);
        }
        expect(DeploymentTargetLinkContentV1Schema.safeParse({ nativeOrigin: { projectName: 'existing-app' } }).success).toBe(false);
    });
    it('admits receipt-free preparation and pins each lifecycle role without invented source operands', () => {
        const credentialRef = { service: { pluginId: 'example.accounts', localId: 'platform' }, accountId: 'work' };
        const purpose = { consumer: { pluginId: 'example.deploy', localId: 'runtime' }, purpose: 'deployment' };
        const common = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
            credentialRef, credentialPrincipal: { kind: 'account', accountId: 'owner', purpose,
                target: { kind: 'account', account: credentialRef } },
            providerIdentity: { providerAccountId: 'provider-account', providerResourceId: 'project', providerEnvironment: 'production' },
            providerEnvironment: { kind: 'production' } };
        const custody = { ...common, targetLinkId: 'link', expectedTargetLinkRevision: 1,
            deploymentId: 'deployment', expectedDeploymentRevision: 1, actionOperationId: 'operation' };
        const receipt = createDeploymentV1();
        if (receipt.content.t !== 'plain') throw new Error('Expected opened source fixture');
        const source = { sourceIntent: receipt.content.v.sourceIntent, sourceMethod: 'gitIntegration' };
        for (const role of ['inspect', 'link'] as const) {
            const schema = DeploymentTargetRoleInputSchemasV1[role];
            expect(schema.safeParse(common).success).toBe(true);
            expect(schema.safeParse({ ...common, targetLinkId: 'link', expectedTargetLinkRevision: 1 }).success).toBe(true);
            expect(schema.safeParse({ ...common, targetLinkId: 'link' }).success).toBe(false);
            expect(schema.safeParse(custody).success).toBe(false);
            const { providerIdentity: _identity, ...initial } = common;
            expect(schema.safeParse({ ...initial, providerAccountId: 'provider-account' }).success).toBe(true);
        }
        for (const role of ['observe', 'cancel', 'teardown'] as const) {
            expect(DeploymentTargetRoleInputSchemasV1[role].parse(custody)).toEqual(custody);
            expect(DeploymentTargetRoleInputSchemasV1[role].safeParse({ ...custody, ...source }).success).toBe(false);
        }
        for (const role of ['rollback', 'promote'] as const) {
            expect(DeploymentTargetRoleInputSchemasV1[role].safeParse(custody).success).toBe(false);
            expect(DeploymentTargetRoleInputSchemasV1[role].safeParse({ ...custody, priorDeployment: {
                environmentId: 'source-environment', deploymentId: 'source-deployment', expectedRevision: 2,
                providerDeploymentId: 'prior-native-deployment' } }).success).toBe(true);
            expect(DeploymentTargetRoleInputSchemasV1[role].safeParse({ ...custody, priorProviderDeploymentId: 'prior-native-deployment' }).success).toBe(false);
            expect(DeploymentTargetRoleInputSchemasV1[role].safeParse({ ...custody, providerDeploymentId: 'current-native-deployment' }).success).toBe(false);
        }
        expect(DeploymentTargetRoleInputSchemasV1.deploy.safeParse({ ...custody, ...source }).success).toBe(true);
        expect(DeploymentTargetRoleInputSchemasV1.deploy.safeParse(custody).success).toBe(false);
        expect(DeploymentTargetRoleInputSchemasV1.deploy.safeParse({ ...custody, ...source, sourceMethod: 'upload' }).success).toBe(false);
        expect(DeploymentTargetRoleInputSchemasV1.uploadDeploy.safeParse({ ...custody, ...source, sourceMethod: 'upload' }).success).toBe(true);
        const team = { kind: 'team', teamId: 'team', purpose, selection: {
            source: 'team_resource', resourceId: 'team-credential', deliveryMode: 'brokered' } };
        expect(DeploymentTargetCredentialPrincipalV1Schema.parse(team)).toEqual(team);
        expect(DeploymentTargetCredentialPrincipalV1Schema.safeParse({ ...team, accountId: 'borrowed-owner' }).success).toBe(false);
        const group = { kind: 'account', accountId: 'owner', purpose,
            target: { kind: 'group', service: credentialRef.service, groupId: 'deployment-group' } };
        expect(DeploymentTargetCredentialPrincipalV1Schema.parse(group)).toEqual(group);
        const result = { v: 1, state: 'outcome_unknown', observedAtMs: 1000, providerDeploymentId: 'provider-deployment',
            steps: [{ id: 'send', label: 'Send deployment', state: 'outcome_unknown' }] };
        expect(DeploymentTargetRoleResultV1Schema.parse(result)).toEqual(result);
        expect(DeploymentTargetRoleResultV1Schema.safeParse({ ...result, credentials: credentialRef }).success).toBe(false);
        expect(DeploymentTargetRoleFailureV1Schema.parse({ v: 1, code: 'provider_request_failed', phase: 'send', retryable: false }))
            .toEqual({ v: 1, code: 'provider_request_failed', phase: 'send', retryable: false });
        expect(DeploymentTargetRoleFailureV1Schema.safeParse({ v: 1, code: 'arbitrary-vendor-error', phase: 'send', retryable: false }).success).toBe(false);
    });
    it('retains recorded platform principal and exact native scope without fabricated native Machines', () => {
        const providerIdentity = { providerAccountId: 'provider-account', providerResourceId: 'worker', providerEnvironment: 'preview:worker:pr-1' };
        const credentialPrincipal = { kind: 'account', accountId: 'owner',
            purpose: { consumer: { pluginId: 'example.deploy', localId: 'runtime' }, purpose: 'deployment' },
            target: { kind: 'account', account: { service: { pluginId: 'example.accounts', localId: 'platform' }, accountId: 'work' } },
        };
        const providerEnvironment = { kind: 'preview', scriptName: 'worker', previewName: 'pr-1' };
        const preparedNative = { projectName: 'captured-project', gitSource: { type: 'github', repoId: '123' },
            triggerUuid: 'captured-trigger-uuid', previewId: 'captured-preview-id', gitBranch: 'feature/x',
            workerTag: 'captured-worker-tag', scriptName: 'captured-script-name' };
        const linkContent = { providerIdentity, credentialPrincipal, providerEnvironment, preparedNative,
            repositoryAccess: { status: 'needsGitAccess', repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/repo' },
                grantUrl: 'https://example.test/grant' } };
        expect(DeploymentTargetLinkContentV1Schema.safeParse(linkContent).success).toBe(true);
        expect(DeploymentTargetLinkContentV1Schema.parse(linkContent)).toEqual(linkContent);
        expect(DeploymentTargetLinkContentV1Schema.safeParse({ ...linkContent,
            preparedNative: { ...preparedNative, gitSource: { ...preparedNative.gitSource, token: 'not-native-metadata' } } }).success).toBe(false);
        expect(DeploymentTargetLinkContentV1Schema.safeParse({ ...linkContent,
            providerEnvironment: { kind: 'preview', previewName: 'pr-1' } }).success).toBe(false);
        expect(DeploymentTargetLinkContentV1Schema.safeParse({ ...linkContent,
            repositoryAccess: { ...linkContent.repositoryAccess, status: 'ready' } }).success).toBe(false);
        const receipt = createDeploymentV1();
        if (receipt.content.t !== 'plain') throw new Error('Expected opened receipt fixture');
        const platformContent = { sourceIntent: receipt.content.v.sourceIntent, sourceMethod: 'gitIntegration',
            machines: [], images: [], machineResults: [], steps: [],
            platform: { targetLinkRevision: 1, credentialPrincipal, providerIdentity, providerEnvironment, preparedNative,
                repositoryAccess: linkContent.repositoryAccess,
                observation: { v: 1, state: 'succeeded', providerDeploymentId: 'native-deployment', observedAtMs: 1002 } } };
        expect(DeploymentV1Schema.safeParse({ ...receipt, content: { t: 'plain', v: platformContent } }).success).toBe(true);
        expect(DeploymentV1Schema.parse({ ...receipt, content: { t: 'plain', v: platformContent } }).content)
            .toEqual({ t: 'plain', v: platformContent });
        const lifecycle = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
            credentialRef: credentialPrincipal.target.account, credentialPrincipal, providerIdentity, providerEnvironment,
            preparedNative, repositoryAccess: linkContent.repositoryAccess, targetLinkId: 'link', expectedTargetLinkRevision: 1,
            deploymentId: 'deployment', expectedDeploymentRevision: 1, actionOperationId: 'operation',
            sourceIntent: platformContent.sourceIntent, sourceMethod: 'gitIntegration' };
        expect(DeploymentTargetRoleInputSchemasV1.deploy.parse(lifecycle)).toEqual(lifecycle);
        expect(DeploymentV1Schema.safeParse({ ...receipt, content: { t: 'plain', v: { ...platformContent, sourceMethod: undefined } } }).success).toBe(false);
        expect(DeploymentV1Schema.safeParse({ ...receipt, content: { t: 'plain', v: { ...platformContent, buildMachineId: 'fabricated' } } }).success).toBe(false);
        expect(DeploymentV1Schema.safeParse({ ...receipt, content: { t: 'plain', v: { ...platformContent, machines: ['fabricated'] } } }).success).toBe(false);
        expect(DeploymentV1Schema.parse(receipt)).toEqual(receipt);
    });
    it('keeps admitted live and retiring links in header-only cursor pages', () => {
        const page = createDeploymentTargetLinksListResultV1();
        if (!page.ok) throw new Error('Expected a successful readable-link page');
        const first = page.items[0]!;
        const retiring = { ...first, targetLink: { ...first.targetLink, id: 'retiring-link', predecessorTargetLinkId: 'earlier-link' } };
        expect(DeploymentTargetLinksListResultV1Schema.parse({ ...page, items: [first, retiring], nextCursor: 'retiring-link' }))
            .toMatchObject({ items: [first, retiring], nextCursor: 'retiring-link', coverage: 'complete' });
        expect(DeploymentTargetLinksListResultV1Schema.safeParse({ ...page, items: [{ ...first,
            targetLink: { ...first.targetLink, environmentId: 'foreign-environment' } }] }).success).toBe(false);
        expect(DeploymentTargetLinksListResultV1Schema.safeParse({ ...page, items: [{ ...first,
            content: { providerIdentity: { providerAccountId: 'private', providerResourceId: 'resource', providerEnvironment: 'production' } } }] }).success)
            .toBe(false);
    });
    it('retains normalized provider identity only in private target-link content', () => {
        const providerIdentity = { providerAccountId: 'provider-account', providerResourceId: 'provider-project', providerEnvironment: 'production' };
        const content = { providerIdentity };
        expect(DeploymentTargetLinkContentV1Schema.parse(content)).toEqual(content);
        for (const invalid of [{ ...providerIdentity, credentialId: 'credential' },
            { ...providerIdentity, providerResourceId: '' }, { providerAccountId: 'provider-account', providerResourceId: 'project' }]) {
            expect(DeploymentTargetLinkContentV1Schema.safeParse({ providerIdentity: invalid }).success).toBe(false);
        }
        const link = createDeploymentTargetLinkV1({ source: { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'platform' } },
            targetKind: 'platform', machines: [], members: [], content: { t: 'plain', v: content } });
        expect(link.content).toEqual({ t: 'plain', v: content });
        expect(DeploymentTargetLinkV1Schema.safeParse({ ...link, providerIdentity }).success).toBe(false);
        expect(DeploymentTargetLinkV1Schema.parse({ ...link, content: { t: 'encrypted', c: 'sealed-link-content' } }).content)
            .toEqual({ t: 'encrypted', c: 'sealed-link-content' });
        expect(createDeploymentTargetLinkV1().content).toEqual({ t: 'plain', v: {} });
    });
    it('retains the exact value-free own-server approval basis and rejects secret-model additions', () => {
        const receipt = createDeploymentV1();
        if (receipt.content.t !== 'plain') throw new Error('Expected opened fixture content');
        const approvedInputBasis = { v: 1, environmentId: receipt.environmentId, environmentRevision: 1,
            targetLinkId: receipt.targetLinkId, targetLinkRevision: 1, sourceIntent: receipt.content.v.sourceIntent,
            manifestFingerprint: 'manifest-a', configInputDigests: [{ path: 'compose.yaml', digest: `sha256:${'c'.repeat(64)}` }],
            physicalProjectName: 'happier-environment', toolVersion: '2.39.4', services: ['app'], profiles: [],
            members: [{ machineId: 'machine-a', installationId: 'installation-a' }], bindings: [], images: receipt.content.v.images };
        const withBasis = { ...receipt, content: { t: 'plain', v: { ...receipt.content.v, ownServer: { approvedInputBasis } } } };
        expect(DeploymentV1Schema.safeParse(withBasis).success).toBe(true);
        expect(DeploymentV1Schema.safeParse({ ...withBasis, content: { t: 'plain', v: { ...withBasis.content.v,
            ownServer: { approvedInputBasis: { ...approvedInputBasis, renderedModelDigest: 'secret-derived' } } } } }).success).toBe(false);
    });
    it('preserves private immutable provenance for A, B and a distinct rollback receipt', () => {
        const a = createDeploymentV1();
        if (a.content.t !== 'plain' || a.content.v.sourceIntent.kind !== 'repository') throw new Error('Expected repository fixture');
        const b = createDeploymentV1({ id: 'deployment-b', requestKey: 'request-b', predecessorDeploymentId: a.id,
            content: { t: 'plain', v: { ...a.content.v, sourceIntent: { ...a.content.v.sourceIntent, sha: 'b'.repeat(40) } } } });
        const rollback = createDeploymentV1({ id: 'deployment-rollback', requestKey: 'request-rollback', operation: 'rollback', rollbackOfDeploymentId: a.id, predecessorDeploymentId: b.id });
        expect(rollback.id).not.toBe(a.id);
        expect(rollback.rollbackOfDeploymentId).toBe(a.id);
        if (rollback.content.t !== 'plain') throw new Error('Expected opened fixture content');
        expect(rollback.content.v.sourceIntent).toEqual(a.content.v.sourceIntent);
        expect(rollback.content.v.images).toEqual(a.content.v.images);
        expect(b.content).not.toEqual(a.content);
        expect(DeploymentV1Schema.parse(a)).toEqual(a);
        expect(DeploymentV1Schema.safeParse({ ...a, sha: 'private-sha' }).success).toBe(false);
        expect(DeploymentV1Schema.safeParse({ ...a, rollbackAllTargetDeploymentId: a.id }).success).toBe(false);
    });

    it('separates unopened storage headers from explicitly opened Artifact content', () => {
        const header = createDeploymentEnvironmentHeaderV1();
        const detail = createDeploymentEnvironmentDetailV1();
        const listed = DeploymentEnvironmentListResultV1Schema.parse({ ok: true, items: [header], nextCursor: null });
        expect(listed.ok && listed.items).toEqual([header]);
        expect(DeploymentEnvironmentListResultV1Schema.safeParse({ ok: true, items: [{ ...header, content: detail.content }], nextCursor: null }).success).toBe(false);
        expect(DeploymentEnvironmentDetailV1Schema.parse(detail)).toEqual(detail);
        const unopenedLinks = { ...detail, targetLinks: detail.targetLinks.map(({ targetLink }) => ({ targetLink })) };
        expect(DeploymentEnvironmentDetailV1Schema.parse(unopenedLinks)).toEqual(unopenedLinks);
        expect(DeploymentEnvironmentDetailV1Schema.safeParse({ ...detail, content: { t: 'plain', v: detail.content } }).success).toBe(false);
    });

    it('carries only declared Action references on the consumed host target', () => {
        const target = createDeploymentTargetV1();
        expect(DeploymentTargetV1Schema.parse(target)).toEqual(target);
        expect(target.targetSchema).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
        expect(target.targetSchema).not.toHaveProperty('properties.providerIdentity');
        expect(DeploymentTargetV1Schema.safeParse({ ...target, actions: { ...target.actions, inspect: { kind: 'host', actionId: 'invented.action' } } }).success).toBe(false);
        expect(DeploymentTargetV1Schema.safeParse({ ...target, actions: { ...target.actions, rollback: { kind: 'plugin', actionId: 'rollback' } } }).success).toBe(false);
    });

    it('keeps Source-derived owner and capability facts on reads without a second active pointer', () => {
        const environment = createDeploymentEnvironmentV1();
        expect(environment.owner).toEqual({ kind: 'account', accountId: 'account-owner' });
        expect(DeploymentEnvironmentV1Schema.safeParse({ ...environment, teamId: 'team' }).success).toBe(false);
        expect(DeploymentEnvironmentV1Schema.safeParse({ ...environment, activeDeploymentId: 'receipt' }).success).toBe(false);
        expect(DeploymentEnvironmentV1Schema.safeParse({ ...environment, content: { t: 'encrypted', c: 'sealed-content' } }).success).toBe(true);
        expect(DeploymentEnvironmentV1Schema.safeParse({ ...environment, content: { t: 'plain', c: 'sealed-content' } }).success).toBe(false);
        expect(DeploymentEnvironmentV1Schema.safeParse({ ...environment, content: { t: 'plain', v: { name: 'Staging', secrets: 'raw' } } }).success).toBe(false);
    });

    it('projects ordered membership from one relation and rejects scalar or contradictory placement', () => {
        const link = createDeploymentTargetLinkV1();
        expect(DeploymentTargetLinkV1Schema.safeParse({ ...link, machineId: 'machine-a' }).success).toBe(false);
        expect(DeploymentTargetLinkV1Schema.safeParse({ ...link, machines: [] }).success).toBe(false);
        expect(DeploymentTargetLinkV1Schema.safeParse({ ...link, machines: ['machine-a', 'machine-a'] }).success).toBe(false);
        expect(DeploymentTargetLinkV1Schema.safeParse({ ...link, members: [{ machineId: 'different', installationId: 'install-a', state: 'active' }] }).success).toBe(false);
        const header = createDeploymentTargetLinkHeaderV1();
        expect(DeploymentEnvironmentGetResultV1Schema.safeParse({ ok: true, environment: createDeploymentEnvironmentHeaderV1(),
            targetLinks: [{ ...header, machines: ['machine-a', 'machine-a'] }] }).success).toBe(false);
    });

    it('admits exact shared Saved Secret revisions and rejects personal refs and purpose-less rows', () => {
        const binding = { purpose: 'variable', name: 'TOKEN', phase: 'runtime', source: { kind: 'secret', ref: 'happier:shared-secret:v1:resource-a', resourceRevision: 2 } };
        expect(EnvironmentSecretBindingV1Schema.parse(binding)).toEqual(binding);
        expect(EnvironmentSecretBindingV1Schema.safeParse({ ...binding, source: { ...binding.source, ref: 'personal-a' } }).success).toBe(false);
        expect(EnvironmentSecretBindingV1Schema.safeParse({ ...binding, source: { ...binding.source, resourceRevision: 0 } }).success).toBe(false);
        expect(EnvironmentSecretBindingV1Schema.safeParse({ name: binding.name, phase: binding.phase, source: binding.source }).success).toBe(false);
        expect(EnvironmentSecretBindingV1Schema.safeParse({ ...binding, source: { kind: 'value', value: 'ordinary-visible-value' } }).success).toBe(true);
        expect(EnvironmentSecretBindingV1Schema.safeParse({ ...binding, source: { kind: 'reference', environmentId: 'data', export: 'db', via: 'privateNetwork' } }).success).toBe(true);
    });

    it('rejects conflicting sources at one variable phase/name while allowing explicit build and runtime rows', () => {
        const environment = createDeploymentEnvironmentV1();
        if (environment.content.t !== 'plain') throw new Error('Expected opened fixture content');
        const runtime = { purpose: 'variable', name: 'TOKEN', phase: 'runtime',
            source: { kind: 'secret', ref: 'happier:shared-secret:v1:resource-a', resourceRevision: 1 } };
        expect(DeploymentEnvironmentContentV1Schema.safeParse({ ...environment.content.v,
            bindings: [runtime, { ...runtime, source: { kind: 'value', value: 'shadow' } }] }).success).toBe(false);
        expect(DeploymentEnvironmentContentV1Schema.safeParse({ ...environment.content.v,
            bindings: [runtime, { ...runtime, phase: 'build' }] }).success).toBe(true);
    });

    it('requires immutable repository SHA and keeps stored snapshots independent of repository selectors', () => {
        const receipt = createDeploymentV1();
        if (receipt.content.t !== 'plain') throw new Error('Expected schema-backed plain fixture');
        const source = receipt.content.v.sourceIntent;
        expect(DeploymentSourceIntentV1Schema.safeParse({ ...source, sha: 'main' }).success).toBe(false);
        if (source.kind !== 'repository') throw new Error('Expected repository fixture');
        expect(DeploymentSourceIntentV1Schema.safeParse({ ...source, compose: { ...source.compose, path: '../outside/compose.yaml' } }).success).toBe(false);
        expect(DeploymentSourceIntentV1Schema.safeParse({ kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}`, document: 'services: {}', profiles: [], services: [], pullRequestHead: { number: 1 } }).success).toBe(false);
    });

    it('pins ordered Machine ids and one image identity per service/platform in receipt content', () => {
        const receipt = createDeploymentV1();
        if (receipt.content.t !== 'plain') throw new Error('Expected schema-backed plain fixture');
        const content = receipt.content.v;
        expect(DeploymentV1Schema.safeParse({ ...receipt, content: { t: 'plain', v: { ...content, machines: ['machine-a'] } } }).success).toBe(true);
        expect(DeploymentV1Schema.safeParse({ ...receipt, content: { t: 'plain', v: { ...content, images: [...content.images, ...content.images] } } }).success).toBe(false);
    });

    it('reserves receipts only after approval and does not reopen settled receipts', () => {
        const receipt = createDeploymentV1();
        const header = createDeploymentReceiptHeaderV1();
        expect(DeploymentStateV1Schema.safeParse('waitingApproval').success).toBe(false);
        for (const approval of [{}, { approvalId: 'approval-a' }]) {
            expect(DeploymentV1Schema.safeParse({ ...receipt, state: 'waitingApproval', ...approval, settledAtMs: undefined }).success).toBe(false);
            expect(DeploymentReceiptGetResultV1Schema.safeParse({ ok: true,
                deployment: { ...header, state: 'waitingApproval', ...approval, settledAtMs: undefined } }).success).toBe(false);
        }
        for (const state of ['queued', 'running', 'running_unverified', 'succeeded', 'failed', 'cancelled', 'outcome_unknown'] as const) {
            expect(DeploymentV1Schema.safeParse({ ...receipt, state }).success).toBe(true);
            expect(DeploymentReceiptGetResultV1Schema.safeParse({ ok: true, deployment: { ...header, state } }).success).toBe(true);
            expect(DeploymentTargetRoleResultV1Schema.safeParse({ v: 1, state, observedAtMs: 1000 }).success).toBe(true);
            expect(DeploymentV1Schema.safeParse({ ...receipt, state, approvalId: 'approval-a' }).success).toBe(false);
            expect(DeploymentReceiptGetResultV1Schema.safeParse({ ok: true,
                deployment: { ...header, state, approvalId: 'approval-a' } }).success).toBe(false);
        }
        expect(DeploymentTargetRoleResultV1Schema.safeParse({ v: 1, state: 'waitingApproval', observedAtMs: 1000 }).success).toBe(false);
        expect(isDeploymentSettledV1('running_unverified')).toBe(true);
        expect(isDeploymentSettledV1('outcome_unknown')).toBe(false);
        expect(canTransitionDeploymentV1('succeeded', 'running')).toBe(false);
        expect(canTransitionDeploymentV1('outcome_unknown', 'succeeded')).toBe(false);
        expect(canTransitionDeploymentV1('queued', 'running')).toBe(true);
    });
});

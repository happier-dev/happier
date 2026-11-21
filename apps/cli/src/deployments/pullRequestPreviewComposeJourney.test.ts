import axios from 'axios';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { DeploymentEnvironmentCreateInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol';
import { normalizeScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encryptWithDataKey, encodeBase64 } from '@/api/encryption';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import type { StoredCredentials } from '@/persistence';
import * as supabase from '../../../../packages/plugins/deployment-supabase/src/index';
import { createWorkflowDataPluginRuntimeFixture } from './targets/workflowDataPluginRuntime.testkit';
import { WorkflowDataCreationResultSchema } from './targets/workflowDataCreationResult';
import { createPullRequestPreviewDataCreationJourneyFixture, createPullRequestPreviewEnvironmentContent } from './pullRequestPreviewComposeJourney.testkit';

describe('accepted preview Workflow data-create composition', () => {
    let mounted: Awaited<ReturnType<typeof createWorkflowDataPluginRuntimeFixture>>;
    beforeAll(async () => {
        mounted = await createWorkflowDataPluginRuntimeFixture();
    });
    afterAll(async () => { await mounted?.dispose(); });
    afterEach(() => { vi.restoreAllMocks(); });

    it.each([{ encrypted: false, reviewed: false }, { encrypted: true, reviewed: false },
        { encrypted: false, reviewed: true }, { encrypted: true, reviewed: true }])(
        'refuses a prepared fork preview before effects when fork previews are off (encrypted=$encrypted, reviewed=$reviewed)', async ({ encrypted, reviewed }) => {
        const mode = encrypted ? 'e2ee' : 'plain';
        const credentials: StoredCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-A' })).toString('base64url')}.signature`,
            encryption: encrypted ? { type: 'legacy', secret: new Uint8Array(32).fill(23) } : null };
        const key = await createResourceDataKey({ credentials, mode });
        const encode = (value: unknown) => key.mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : encodeBase64(encryptWithDataKey(value, key.dataKey));
        const repository = normalizeScmHostingRepositoryIdentity({ kind: 'github', deployment: 'https://forge.example/enterprise', repository: 'owner/app' });
        const headRepository = normalizeScmHostingRepositoryIdentity({ kind: 'github', deployment: 'https://forge.example/enterprise', repository: 'contributor/app' });
        if (!repository || !headRepository) throw new Error('Canonical repository identities required');
        const input = DeploymentEnvironmentCreateInputV1Schema.parse({ serverId: 'home', requestKey: 'fork-preview-create',
            contentArtifactId: 'preview-content', contentHeaderVersion: 1, contentBodyVersion: 1,
            projectSourceId: 'repository-source', protection: 'nonProduction', purpose: 'preview',
            deployerMode: 'managers', controllerMachineId: 'host', preview: { templateEnvironmentId: 'template-A',
                expectedTemplateRevision: 1, pullRequestId: '17', runtimeTargetLinkId: 'template-runtime' } });
        const baseline = createDeploymentEnvironmentDetailV1().content;
        let content = createPullRequestPreviewEnvironmentContent({ baseContent: baseline, input,
            acceptedInputs: { pullRequest: { repository, headRepository, headSha: 'a'.repeat(40) } } });
        const template = createDeploymentEnvironmentHeaderV1({ id: 'template-A', owner: { kind: 'account', accountId: 'account-A' },
            projectSourceId: 'repository-source', runtimeTargetLinkId: 'template-runtime', controllerMachineId: 'host',
            contentArtifactId: 'template-content' });
        const templateContent = DeploymentEnvironmentContentV1Schema.parse({ ...baseline, previewTemplate: { v: 1, enabled: true, forkPreviews: 'off', repository,
            runtimeTargetLinkId: 'template-runtime', domain: null, bindingBlueprints: [], data: [] } });
        const templateMetadata = DeploymentEnvironmentGetResultV1Schema.parse({ ok: true, environment: template,
            targetLinks: [createDeploymentTargetLinkHeaderV1({ id: 'template-runtime', environmentId: template.id,
                machines: ['host'], members: [{ machineId: 'host', installationId: 'installation-host', state: 'active' }] })] });
        const mutations: unknown[] = [];
        const reads: string[] = [];
        const nativeAcquire = vi.fn(async () => { throw new Error('Fork refusal must precede native runtime acquisition'); });
        const registryAcquire = vi.fn(async () => { throw new Error('Fork refusal must precede plugin registry acquisition'); });
        const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Fork refusal must precede provider HTTP'); });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(url).pathname;
            reads.push(`GET ${path}`);
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 0 } };
            const id = path === '/v1/artifacts/preview-content' ? 'preview-content' : 'template-content';
            expect(path).toBe(`/v1/artifacts/${id}`);
            return { status: 200, data: { id, ownerAccountId: 'account-A', access: 'owner', publicAudience: 'none', encryptionMode: mode,
                dataEncryptionKey: key.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : key.dataEncryptionKey,
                header: encode({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Preview' }),
                body: encode({ body: JSON.stringify(id === 'preview-content' ? content : templateContent) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(request.url!).pathname;
            reads.push(`${request.method} ${path}`);
            if (request.method === 'GET' && path === '/v1/deployments/environments/template-A') return { status: 200,
                data: templateMetadata };
            mutations.push(request);
            return { status: 200, data: { ok: true, environmentId: 'environment-A', revision: 1 } };
        });
        const owner = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://preview-home.invalid',
            machineId: 'host', resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
            runtime: { acquire: nativeAcquire }, acquirePluginRuntimeRegistryLease: registryAcquire });
        const context: ActionExecutorContext = {
            surface: 'cli', authority: 'present_user', runtimeAccountId: 'account-A', serverId: 'home', serverIdentityId: 'home',
            actionCaller: { kind: 'host' }, machineAdmission: { actorAccountId: 'account-A', custodianAccountId: 'account-A',
                machineId: 'host', installationId: 'installation-host', role: 'manage', encryptionMode: mode },
            verifyMachineAdmissionCurrent: async () => true,
        };
        let result: unknown;
        if (reviewed) {
            // A genuine accepted Workflow review must not turn fork opt-out
            // into permission to execute code from a different repository.
            await expect(createPullRequestPreviewDataCreationJourneyFixture({ contributes: mounted.registry.contributes,
                encrypted, headRepository, createEnvironment: async (prepared, issued, acceptedInputs) => {
                    content = createPullRequestPreviewEnvironmentContent({ baseContent: baseline, input: prepared, acceptedInputs });
                    result = await owner.deploymentAction('deployments.environments.create', prepared, {
                        ...issued, machineAdmission: context.machineAdmission, verifyMachineAdmissionCurrent: context.verifyMachineAdmissionCurrent,
                    });
                    return result;
                } })).rejects.toThrow('preview_environment_creation_failed');
        } else result = await owner.deploymentAction('deployments.environments.create', input, context);
        expect(result, JSON.stringify({ result, reads, mutations })).toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
        expect(mutations).toEqual([]);
        expect(nativeAcquire).not.toHaveBeenCalled();
        expect(registryAcquire).not.toHaveBeenCalled();
        expect(provider).not.toHaveBeenCalled();
    });

    it.each([false, true])('retains the exact reviewed child result after reopening %s encrypted Workflow storage', async encrypted => {
        const mode = encrypted ? 'e2ee' : 'plain';
        const credentials: StoredCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-A' })).toString('base64url')}.signature`,
            encryption: encrypted ? { type: 'legacy', secret: new Uint8Array(32).fill(23) } : null };
        const key = await createResourceDataKey({ credentials, mode });
        const encode = (value: unknown) => key.mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : encodeBase64(encryptWithDataKey(value, key.dataKey));
        let content = createDeploymentEnvironmentDetailV1().content;
        const template = createDeploymentEnvironmentHeaderV1({ id: 'template-A', owner: { kind: 'account', accountId: 'account-A' },
            projectSourceId: 'repository-source', runtimeTargetLinkId: 'template-runtime', controllerMachineId: 'host',
            contentArtifactId: 'template-content' });
        const templateContent = DeploymentEnvironmentContentV1Schema.parse({ ...content, previewTemplate: { v: 1, enabled: true,
            forkPreviews: 'off', repository: { kind: 'github', deployment: 'https://forge.example/enterprise', repository: 'owner/app' },
            runtimeTargetLinkId: 'template-runtime', domain: null, bindingBlueprints: [], data: [] } });
        const templateMetadata = DeploymentEnvironmentGetResultV1Schema.parse({ ok: true, environment: template,
            targetLinks: [createDeploymentTargetLinkHeaderV1({ id: 'template-runtime', environmentId: template.id,
                machines: ['host'], members: [{ machineId: 'host', installationId: 'installation-host', state: 'active' }] })] });
        const environmentWrites: unknown[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 0 } };
            const id = path === '/v1/artifacts/preview-content' ? 'preview-content' : 'template-content';
            expect(path).toBe(`/v1/artifacts/${id}`);
            return { status: 200, data: { id, ownerAccountId: 'account-A', access: 'owner', publicAudience: 'none',
                encryptionMode: mode, dataEncryptionKey: key.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : key.dataEncryptionKey,
                header: encode({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'PR 17' }),
                body: encode({ body: JSON.stringify(id === 'preview-content' ? content : templateContent) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (request.method === 'GET' && new URL(request.url!).pathname === '/v1/deployments/environments/template-A')
                return { status: 200, data: templateMetadata };
            expect(request.method).toBe('POST');
            expect(new URL(request.url!).pathname).toBe('/v1/deployments/environments');
            environmentWrites.push(request.data);
            return { status: 200, data: { ok: true, environmentId: 'environment-A', revision: 1 } };
        });
        const owner = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://preview-home.invalid',
            machineId: 'host', resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
            runtime: { async acquire() { throw new Error('Environment creation has no native runtime effect'); } } });
        const fixture = await createPullRequestPreviewDataCreationJourneyFixture({ contributes: mounted.registry.contributes, encrypted,
            createEnvironment: (input, context, acceptedInputs) => {
                content = createPullRequestPreviewEnvironmentContent({ baseContent: content, input, acceptedInputs });
                return owner.deploymentAction('deployments.environments.create', input, {
                    ...context, machineAdmission: { actorAccountId: 'account-A', custodianAccountId: 'account-A', machineId: 'host',
                        installationId: 'installation-host', role: 'manage', encryptionMode: mode },
                    verifyMachineAdmissionCurrent: async () => true,
                });
            },
        });
        expect(fixture.environmentResult).toEqual({ ok: true, environmentId: fixture.input.environmentId, revision: 1 });
        expect(environmentWrites).toEqual([fixture.parent.input]);
        expect(content.previewProvenance?.repository).toEqual(fixture.pullRequest.repository);
        expect(content.definition).toMatchObject({ kind: 'repository', ref: fixture.pullRequest.headSha });
        expect(fixture.accepted.inputs).toEqual({ pullRequest: fixture.pullRequest });
        expect(fixture.accepted.approvedOperation?.parent).toEqual(fixture.parent);
        expect(fixture.accepted.materializedLeaves).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'action', actionId: fixture.qualified, actionInput: fixture.input }),
        ]));
        expect(fixture.requests).toEqual([{ method: 'POST', pathname: '/v1/projects/parent-project-A/branches',
            body: { branch_name: 'pr-17', git_branch: fixture.pullRequest.headSha, persistent: false, with_data: false } }]);
        expect(fixture.invocation.index).toMatchObject({ runId: fixture.reference.runId, id: fixture.reference.invocationId, lifecycle: 'completed' });
        expect(fixture.invocation.progress.execution).toMatchObject({ kind: 'action', actionId: fixture.qualified, input: fixture.input,
            output: { kind: 'deployment_data_created', source: { pluginId: supabase.manifest.id, localId: 'database' },
                deleteAction: { pluginId: supabase.manifest.id, localId: 'branches-delete' },
                providerEnvironment: { kind: 'native', selection: { branchId: 'child-project-A' } } } });
        expect(WorkflowDataCreationResultSchema.parse(fixture.captured).providerIdentity).toEqual({
            providerAccountId: 'organization-A', providerResourceId: 'parent-project-A', providerEnvironment: 'child-project-A' });
        expect(JSON.stringify(fixture.invocation.progress)).not.toMatch(/provider-private-echo|db_pass/);
        expect(fixture.admissionChecks).toEqual({ changedCommit: null, changedPullRequest: null,
            wrongActor: null, wrongInvocation: null });
        expect(await fixture.readWorkflowInvocation()).toMatchObject({ invocation: fixture.invocation });
        expect(fixture.requests).toHaveLength(1);
    });
});

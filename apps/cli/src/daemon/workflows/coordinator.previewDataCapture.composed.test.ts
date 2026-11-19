import { resolve } from 'node:path';
import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { DeploymentEnvironmentCreateInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1,
    sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
    openWorkflowProgressStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1 }
    from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import * as supabase from '../../../../../packages/plugins/deployment-supabase/src/index';
import * as neon from '../../../../../packages/plugins/deployment-neon/src/index';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { createWorkflowDataPluginRuntimeFixture } from '@/deployments/targets/workflowDataPluginRuntime.testkit';
import { prepareWorkflowDataCreationResultCapture } from '@/deployments/targets/workflowDataCreationResult';
import { createCommittedContributedActionInvoker, createCommittedContributedActionSchemaReader,
    listRuntimeContributedActionDefinitions } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createPurposeTargetResolver } from '@/daemon/connectedServices/purposeBindings/resolveTarget';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';
import { DurableWorkflowCoordinatorStore } from './production';
import { createWorkflowCoordinator } from './coordinator';
import { buildWorkflowActionContext } from './workflowActionContext';
import { accountSettingsParse, ApprovalRequestV2Schema } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { actionSpecToActionDefinitionV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentTargetLinkInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readDeploymentTargetLinkArtifactV1 } from '@happier-dev/deployment-protocol';
import { DeploymentTargetLinkProviderContentV1Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { resolveDeploymentPreviewWorkflowSourceForHost } from '@/deployments/previewWorkflowSourceForHost';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createWorkflowRunActionOwner } from '@/session/actions/workflowRunActions';
import { WorkflowActionInputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';

// Node's provider HTTP uses Undici; share the fixture boundary with portable fetch.
vi.mock('undici', async importOriginal => ({
    ...await importOriginal<typeof import('undici')>(),
    fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Only Home persistence and vendor HTTP are replaced. The public Account
 * artifact loader, reviewed child, Action executor and durable coordinator run. */
describe('Workflow preview data creation capture composition', () => {
    it.each([{ plugin: supabase, folder: 'deployment-supabase' }, { plugin: neon, folder: 'deployment-neon' }])(
        'keeps branch creation and deletion discoverable on their supported surfaces: $folder', async ({ plugin, folder }) => {
            const accountId = 'account-A', origin = 'https://data-surface-home.test';
            const app = fastify();
            await registerAuthoredAccountActionRelease(app, accountId, { primary: { manifest: plugin.manifest,
                projectRoot: resolve(import.meta.dirname, `../../../../../packages/plugins/${folder}`),
                entryPath: resolve(import.meta.dirname, `../../../../../packages/plugins/${folder}/src/index.ts`) } });
            app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 0 }));
            app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
            app.get('/v1/account/profile', async () => ({ id: accountId }));
            app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
            vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
                if (new URL(String(url)).origin !== origin) throw new Error('Discovery must not call a provider');
                return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'home' } } });
            });
            await app.ready();
            const restoreHttp = installAxiosFastifyAdapter({ app, origin });
            const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
            const mounted = await createWorkflowDataPluginRuntimeFixture({ accountExecution: {
                credentials: { token, encryption: null }, serverUrl: origin, serverId: 'home', machineId: 'host',
                isCurrent: async () => true }, resolveCurrentMachineId: () => 'host' });
            try {
                const list: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['listContributedActionDefinitions']> =
                    selection => listRuntimeContributedActionDefinitions(mounted.registry, selection);
                const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
                    listContributedActionDefinitions: list, readContributedActionSchemas: createCommittedContributedActionSchemaReader(list) });
                for (const surface of ['agent', 'cli', 'plugin'] as const) for (const localId of ['branches-create', 'branches-delete']) {
                    const result = await executor.execute('action.spec.get', { id: `${plugin.manifest.id}/actions/${localId}` },
                        { surface, authority: 'account_automation', ...(surface === 'plugin' ? { actionCaller: {
                            kind: 'plugin' as const, pluginId: plugin.manifest.id, contributionLocalId: 'database',
                            materialization: { machineId: 'host', materializationId: `${plugin.manifest.id}-source`, pluginId: plugin.manifest.id },
                        } } : {}) });
                    expect(result, `${surface}/${localId}: ${JSON.stringify(result)}`).toMatchObject({ ok: true });
                }
            } finally { await mounted.dispose(); restoreHttp(); await app.close(); }
        });

    it('executes saved managed data intent through the preview factory before holding deployment approval', async () => {
        const accountId = 'account-A', runId = 'ca00a439-791a-4bde-b332-d310c218799e';
        const origin = 'https://preview-capture-home.test', machineId = 'host';
        const app = fastify();
        const authored = await registerAuthoredAccountActionRelease(app, accountId, { primary: {
            manifest: supabase.manifest,
            projectRoot: resolve(import.meta.dirname, '../../../../../packages/plugins/deployment-supabase'),
            entryPath: resolve(import.meta.dirname, '../../../../../packages/plugins/deployment-supabase/src/index.ts'),
        } });
        const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null };
        const action = { pluginId: supabase.manifest.id, localId: 'branches-create' };
        const actionId = `${action.pluginId}/actions/${action.localId}`;
        const declaration = supabase.manifest.contributes.actions?.find(candidate => candidate.id === action.localId);
        const descriptor = supabase.manifest.contributes.connectedAccountDescriptors?.[0];
        if (!declaration || !descriptor) throw new Error('Supabase declarations required');
        const credentialRef = { service: { pluginId: supabase.manifest.id, localId: descriptor.id }, accountId: 'connected-A' };
        const provider = DeploymentTargetLinkProviderContentV1Schema.parse({ credentialPrincipal: { kind: 'account', accountId,
            purpose: { consumer: action, purpose: 'deploy-manage' }, target: { kind: 'account', account: credentialRef } },
            providerIdentity: { providerAccountId: 'organization-A', providerResourceId: 'root-project-A', providerEnvironment: 'parent-project-A' },
            providerEnvironment: { kind: 'custom', id: 'parent-project-A' } });
        const repository = { kind: 'github' as const, deployment: 'https://forge.example/enterprise', repository: 'owner/app' };
        const event = { id: '17', number: 17, action: 'opened' as const, headSha: 'a'.repeat(40), headRef: 'feature/data', baseRef: 'main',
            baseRepository: repository, headRepository: repository, author: { id: 'contributor', login: 'contributor', kind: 'human' as const } };
        const baseline = createDeploymentEnvironmentDetailV1();
        const template = createDeploymentEnvironmentHeaderV1({ id: 'template-A', serverId: 'home', createdByAccountId: accountId, projectSourceId: 'repository-source',
            owner: { kind: 'account', accountId }, controllerMachineId: machineId, runtimeTargetLinkId: 'template-runtime',
            contentArtifactId: 'template-content' });
        const runtime = createDeploymentTargetLinkHeaderV1({ id: 'template-runtime', environmentId: template.id, createdByAccountId: accountId,
            machines: [machineId], members: [{ machineId, installationId: 'installation-host', state: 'active' }],
            contentArtifactId: 'template-runtime-content' });
        const data = createDeploymentTargetLinkHeaderV1({ id: 'template-data', environmentId: template.id, createdByAccountId: accountId,
            role: 'data', targetKind: 'supabase', machines: [], members: [], contentArtifactId: 'template-data-content',
            source: { kind: 'plugin', contribution: { pluginId: supabase.manifest.id, localId: 'database' } } });
        // Supabase's selected parent project ref and branch UUID differ from the root linked project.
        const content = { ...baseline.content, definition: { kind: 'repository' as const, ref: 'main', compose: {
            path: 'compose.yaml', profiles: [], services: ['app'], primaryService: 'app' } },
            previewTemplate: { v: 1 as const, enabled: true, forkPreviews: 'off' as const, repository,
                runtimeTargetLinkId: runtime.id, domain: null, bindingBlueprints: [], data: [{ kind: 'managed' as const,
                    dataTargetLinkId: data.id, ownership: 'providerNative' as const,
                    parentBranchRef: { providerProjectId: 'parent-project-A', branchId: 'parent-branch-A' } }] } };
        const seed = (id: string, kind: string, value: unknown) => authored.artifacts.seed(id,
            encodePlainArtifactStoredContent({ kind, title: 'Preview' }), encodePlainArtifactStoredContent({ body: JSON.stringify(value) }));
        seed(template.contentArtifactId, 'deployment-environment.v1', content);
        seed(runtime.contentArtifactId, 'deployment-target-link.v1', {});
        seed(data.contentArtifactId, 'deployment-target-link.v1', provider);
        type Metadata = Extract<ReturnType<typeof DeploymentEnvironmentGetResultV1Schema.parse>, { ok: true }>;
        const environments = new Map<string, Metadata>([[template.id, DeploymentEnvironmentGetResultV1Schema.parse({
            ok: true, environment: template, targetLinks: [runtime, data] }) as Metadata]]);
        const mutations: string[] = [];
        const homeErrors: { path: string; message: string }[] = [];
        app.addHook('onError', async (request, _reply, error) => { homeErrors.push({ path: request.url, message: error.message }); });
        app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 0 }));
        app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
        app.get('/v1/account/profile', async () => ({ id: accountId }));
        app.post(managedMachineActionEndpointPathV1('machines.managed.list'), async request => {
            expect(request.body).toEqual({ homeId: 'home', enrolledMachineId: machineId });
            return { machines: [] };
        });
        app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
        app.get('/v1/projects/sources/repository-source', async () => ({ ok: true, canManage: true, source: {
            id: 'repository-source', revision: 1, name: 'App', owner: { kind: 'account', accountId }, audience: [], createdByAccountId: accountId } }));
        app.get('/v1/projects/repository-source/deployment-defaults', async () => ({ ok: true,
            projectSourceId: 'repository-source', sourceRevision: 1, revision: 0, content: null }));
        app.get<{ Querystring: { previewCompanionOfEnvironmentId?: string } }>('/v1/deployments/environments', async request => ({ ok: true,
            items: [...environments.values()].filter(row => request.query.previewCompanionOfEnvironmentId
                ? row.environment.previewCompanionOfEnvironmentId === request.query.previewCompanionOfEnvironmentId
                : row.environment.purpose === 'preview').map(row => row.environment),
            nextCursor: null, coverage: 'complete' }));
        app.get<{ Params: { environmentId: string } }>('/v1/deployments/environments/:environmentId', async request => {
            const found = environments.get(request.params.environmentId);
            if (!found) throw new Error('Unknown fixture environment');
            return found;
        });
        app.post('/v1/deployments/targets/list', async () => ({ ok: true, items: [], nextCursor: null, coverage: 'complete' }));
        app.post('/v1/deployments/environments', async request => {
            const input = DeploymentEnvironmentCreateInputV1Schema.parse(request.body);
            if (!input.firstTargetLink || !input.previewDataTargetLinks?.length) throw new Error('Real host preview bootstrap required');
            const environment = createDeploymentEnvironmentHeaderV1({ id: 'environment-A', serverId: 'home', createdByAccountId: accountId,
                owner: { kind: 'account', accountId }, projectSourceId: input.projectSourceId, controllerMachineId: machineId, revision: 3,
                contentArtifactId: input.contentArtifactId, contentHeaderVersion: input.contentHeaderVersion,
                contentBodyVersion: input.contentBodyVersion, runtimeTargetLinkId: 'preview-runtime', purpose: 'preview',
                previewTemplateEnvironmentId: template.id, previewRepositoryId: 'repository-identity',
                previewPullRequestId: event.id, previewTargetLinkId: runtime.id });
            const childRuntime = createDeploymentTargetLinkHeaderV1({ ...runtime, ...input.firstTargetLink,
                id: 'preview-runtime', environmentId: environment.id, machines: input.firstTargetLink.machines.map(member => member.machineId),
                members: input.firstTargetLink.machines.map(member => ({ ...member, state: 'active' })) });
            const copy = input.previewDataTargetLinks[0]!;
            const { templateDataTargetLinkId: _templateLinkId, expectedTemplateTargetLinkRevision: _templateRevision, ...contentReference } = copy;
            const childData = createDeploymentTargetLinkHeaderV1({ ...data, ...contentReference,
                id: 'preview-data', environmentId: environment.id });
            environments.set(environment.id, { ok: true, environment, targetLinks: [childRuntime, childData] });
            mutations.push('create');
            return { ok: true, environmentId: environment.id, revision: environment.revision, runtimeTargetLinkId: childRuntime.id,
                previewDataTargets: [{ templateDataTargetLinkId: data.id, targetLinkId: childData.id, targetLinkRevision: childData.revision }] };
        });
        app.post<{ Params: { environmentId: string } }>('/v1/deployments/environments/:environmentId/targets', async request => {
            const input = DeploymentTargetLinkInputV1Schema.parse(request.body);
            const current = environments.get(request.params.environmentId);
            if (!current) throw new Error('Missing child');
            expect(input).toMatchObject({ replacesLinkId: 'preview-data', expectedTargetLinkRevision: 1, expectedRevision: 3, role: 'data' });
            const linked = createDeploymentTargetLinkHeaderV1({ ...data, contentArtifactId: input.contentArtifactId,
                contentHeaderVersion: input.contentHeaderVersion, contentBodyVersion: input.contentBodyVersion,
                id: 'preview-data', environmentId: current.environment.id, machines: [], members: [], revision: 2 });
            current.environment = { ...current.environment, revision: current.environment.revision + 1 };
            current.targetLinks = [...current.targetLinks.filter(link => link.id !== input.replacesLinkId), linked];
            mutations.push('link');
            return { ok: true, environmentId: current.environment.id, revision: current.environment.revision,
                targetLinkId: linked.id, targetLinkRevision: linked.revision };
        });
        const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: credentialRef, status: 'connected', authenticationModeId: 'token',
            revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuv', configurationReady: true,
            configurationRevision: null, kind: 'token', expiresAt: null, displayName: 'Original Supabase', scopes: [] });
        const purposeOwner = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: accountId,
            store: { read: async () => ({ v: 1, bindings: [] }), update: async () => { throw new Error('No preference writes'); },
                subscribe: () => ({ dispose() {} }) }, selectTarget: async () => { throw new Error('No interactive selection'); },
            resolveTarget: createPurposeTargetResolver({ available: true,
                resolveService: async () => ({ service: credentialRef.service, authentication: descriptor.authentication }), listAccounts: async () => [profile] }),
            resolveCredentialRevision: async () => profile.credentialRevision,
            materializeAccount: async request => { request.credentialRevisionBasis?.captureCredentialRevision(profile.credentialRevision!);
                return { kind: 'httpHeaders', headers: { authorization: 'Bearer original-A' } }; },
            projectTargetAccounts: async () => [], assertTargetAccountMaterializable: async () => undefined });
        const providerRequests: { pathname: string; body: unknown; authorization: string | null }[] = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
            const parsed = new URL(String(url));
            if (parsed.origin === origin) return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'home' } } });
            if (parsed.hostname !== 'api.supabase.com' || init?.method !== 'POST'
                || parsed.pathname !== '/v1/projects/parent-project-A/branches') throw new Error(`Unexpected vendor request ${parsed.pathname}`);
            mutations.push('branch');
            providerRequests.push({ pathname: parsed.pathname, body: await new Response(init.body).json(),
                authorization: new Headers(init.headers).get('authorization') });
            return Response.json({ id: 'e242cf8e-9562-4e0b-9082-a10ae56879c6', project_ref: 'child-project-A',
                parent_project_ref: 'parent-project-A', name: 'pr-17', persistent: false, with_data: false,
                status: 'CREATING', db_pass: 'provider-private-echo' }, { status: 201 });
        });
        await app.ready();
        const restoreHttp = installAxiosFastifyAdapter({ app, origin });
        const mounted = await createWorkflowDataPluginRuntimeFixture({ connectedAccounts: purposeOwner, actionFormConnectedAccounts: purposeOwner,
            accountExecution: { credentials, serverUrl: origin, serverId: 'home', serverIdentityId: 'home', machineId, isCurrent: async () => true },
            resolveCurrentMachineId: () => machineId });
        const artifacts = createCredentialedAccountArtifactStore(credentials);
        const open = (id: string) => runWithServerHttpBaseUrl(origin, () => artifacts.read(id, { prepareRecipients: false, includeSharedAudience: false }));
        try {
            const operation = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: origin,
                snapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
                    scopeKey: resolveAccountSettingsScopeKey(credentials), settingsSecretsReadKeys: [] }, isCurrent: async () => true });
            const native = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl: origin, machineId,
                savedSecretOperationContext: operation, resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                runtime: { async acquire() { throw new Error('Deployment holds before native preflight in this proof'); } } });
            const list: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['listContributedActionDefinitions']> =
                selection => listRuntimeContributedActionDefinitions(mounted.registry, selection);
            let approvalAction: string | undefined;
            let approvalRequest: ReturnType<typeof ApprovalRequestV2Schema.parse> | null = null;
            // Raw deploy intent uses the normal policy hold. Native deploy preflight/execution is a separate composed gate.
            const fixtureHost = { token, credentials, sessionId: '', mode: 'plain', ctx: null,
                serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: origin, runtimeActionMachineId: machineId,
            } satisfies Parameters<typeof createCliActionExecutorHarness>[0];
            const { executor } = createCliActionExecutorHarness(fixtureHost,
            { ...createUnavailableActionTransportDeps(), deploymentAction: native.deploymentAction,
                managedMachineAction: createAccountServerActionDeps({ token, credentials, serverId: 'home',
                    serverIdentityId: 'home', serverHttpBaseUrl: origin }).managedMachineAction,
                prepareDeploymentEnvironmentCreate: native.prepareDeploymentEnvironmentCreate,
                resolveEnvironmentApprovalScope: native.resolveEnvironmentApprovalScope,
                approvalsCreate: async ({ request }) => {
                    approvalAction = request.actionId;
                    approvalRequest = ApprovalRequestV2Schema.parse(request);
                    return { artifactId: 'preview-deploy-approval' };
                },
                approvalsGet: async () => approvalRequest,
                listContributedActionDefinitions: list, readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
                invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () => {
                    const lease = mounted.controller.tryAcquireRuntimeRegistry(); if (!lease) throw new Error('Fixture registry unavailable'); return lease;
                }, requestCurrentIntent: async ({ fingerprint }) => ({ status: 'approved', fingerprint }) }) });
            const composed = await resolveDeploymentPreviewWorkflowSourceForHost({
                templateRef: { serverId: 'home', environmentId: template.id }, event,
                occurrenceKey: 'pull-request-17-head-a', executor, credentials, serverHttpBaseUrl: origin,
                contributes: mounted.registry.contributes });
            if (composed.kind !== 'available') throw new Error(composed.reason);
            const workspace = { machineId, directory: '/repo', checkoutRootPath: '/repo' };
            const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition: composed.definition,
                context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' }, workspaceTarget: { project: workspace },
                    origin: { kind: 'direct', originSessionId: 'person-session', authenticatedStarterV1: {
                        requestRef: 'person-started-preview', requester: { serverId: 'home', accountId } } },
                    authorization: { principal: { kind: 'host' } } }, admission: { kind: 'user' },
                effects: { resolveTargetAvailability: async () => true, readActionContract: async id => id === actionId
                    ? freezeWorkflowActionContractV1({ ...declaration, outputSchema: declaration.resultSchema })
                    : freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))) } });
            if (!materialized.ok) throw new Error(materialized.error.code);
            const accepted = materialized.snapshot;
            const stored = createWorkflowRunStorageTestkit({ runId, machineId, accountId, origin: { kind: 'direct' },
                acceptedEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                    binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted })) });
            const rootRecordId = 'root';
            const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId, nextSequence: '1', frontier: { nextBlockOrdinal: 0, paused: false } };
            await stored.execute({ operation: 'initialize', runId, expectedRevision: 0,
                checkpointEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
                    binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint })),
                rootInvocation: { id: rootRecordId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
                    binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootRecordId,
                        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' }, progress: { kind: 'happier.workflow-progress.v1',
                        blockKind: 'root', attempt: '0', invocationPath: { blockId: '$root', scope: [] }, logicalInvocationRecordId: rootRecordId } })) } });
            const encryption = { witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' as const } };
            const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0, rootRecordId,
                checkpoint, encryption, storage: stored, revision: stored.run().revision });
            const coordinator = createWorkflowCoordinator({ store, rootInvocationRecordId: rootRecordId,
                executeStep: async () => { throw new Error('No Session steps'); }, resolveWorkspace: async () => ({ ok: true, workspace }),
                action: { executor, buildContext: async request => ({ ...buildWorkflowActionContext(request), runtimeAccountId: accountId,
                    serverId: 'home', serverIdentityId: 'home', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
                        approvalRequiredSurfaces: { 'deployments.deploy': ['agent'] }, approvalWaivedSurfaces: {
                            'deployments.environments.create': ['agent'], 'deployments.targets.link': ['agent'], [actionId]: ['agent'] } }),
                    machineAdmission: { actorAccountId: accountId, custodianAccountId: accountId, machineId,
                        installationId: 'installation-host', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true }),
                    prepareResultCapture: async id => prepareWorkflowDataCreationResultCapture(id, mounted.registry.contributes),
                    observeRun: async () => { throw new Error('No detached Runs'); } } });
            const outcome = await coordinator.run({ ...accepted, runId });
            const progress = stored.rows().map(row => {
                const result = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId,
                    recordId: row.index.id, sequence: row.index.sequence, parentRecordId: row.index.parentRecordId,
                    memberOrdinal: row.index.memberOrdinal, attempt: row.index.attempt }, envelope: parseWorkflowStoredContentEnvelopeV1(row.contentEnvelope) });
                if (result.kind !== 'available') throw new Error('Retained progress unavailable');
                return result.content;
            });
            expect(outcome, JSON.stringify({ outcome, mutations, homeErrors, progress: progress.map(row => ({ blockId: row.invocationPath.blockId,
                reason: row.reason, execution: row.execution })) })).toMatchObject({ state: 'paused', reason: 'approval_required' });
            expect(approvalAction).toBe('deployments.deploy');
            expect(mutations).toEqual(['create', 'branch', 'link']);
            expect(providerRequests).toEqual([{ pathname: '/v1/projects/parent-project-A/branches',
                body: { branch_name: 'pr-17', git_branch: event.headRef, persistent: false, with_data: false }, authorization: 'Bearer original-A' }]);
            const captured = progress.find(row => row.invocationPath.blockId === 'preview-data-0')?.execution;
            expect(captured).toMatchObject({ kind: 'action', actionId, input: { environmentId: 'environment-A', targetLinkId: 'preview-data' },
                output: { kind: 'deployment_data_created', source: { pluginId: supabase.manifest.id, localId: 'database' },
                    deleteAction: { pluginId: supabase.manifest.id, localId: 'branches-delete' },
                    providerIdentity: { providerAccountId: 'organization-A', providerResourceId: 'parent-project-A', providerEnvironment: 'child-project-A' },
                    providerEnvironment: { kind: 'custom', id: 'child-project-A' }, operands: {} } });
            expect(JSON.stringify(captured)).not.toContain('provider-private-echo');
            const child = environments.get('environment-A')!;
            const linked = child.targetLinks.find(link => link.id === 'preview-data')!;
            const actualProvider = readDeploymentTargetLinkArtifactV1(linked, await open(linked.contentArtifactId));
            expect(actualProvider).toMatchObject({ ok: true, content: { credentialPrincipal: provider.credentialPrincipal,
                providerIdentity: { providerAccountId: 'organization-A', providerResourceId: 'parent-project-A', providerEnvironment: 'child-project-A' },
                providerEnvironment: { kind: 'custom', id: 'child-project-A' } } });
            const workflowReads = createWorkflowRunActionOwner({ storage: stored, resolveAccountId: async () => accountId,
                definitions: { get: async () => { throw new Error('No saved Workflow definition is read'); } },
                resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }) });
            const { executor: closeExecutor } = createCliActionExecutorHarness(fixtureHost,
                { ...createUnavailableActionTransportDeps(), deploymentAction: native.deploymentAction,
                resolveEnvironmentApprovalScope: native.resolveEnvironmentApprovalScope,
                workflowAction: async request => {
                    if (request.actionId !== 'workflow.run.invocations.list') throw new Error('Close reads only captured invocations');
                    return workflowReads.execute({ actionId: request.actionId,
                        input: WorkflowActionInputSchemasV1[request.actionId].parse(request.input), context: request.context });
                } });
            const closed = await resolveDeploymentPreviewWorkflowSourceForHost({
                templateRef: { serverId: 'home', environmentId: template.id }, event: { ...event, action: 'closed' },
                occurrenceKey: 'pull-request-17-closed', executor: closeExecutor, credentials, serverHttpBaseUrl: origin,
                contributes: mounted.registry.contributes });
            if (closed.kind !== 'available') throw new Error(closed.reason);
            const captureIndex = progress.findIndex(row => row.invocationPath.blockId === 'preview-data-0');
            const captureInvocationId = stored.rows()[captureIndex]!.index.id;
            expect(closed.definition.blocks).toMatchObject([
                { actionId: 'deployments.teardown', input: {
                    environmentId: { kind: 'literal', value: child.environment.id },
                    targetLinkId: { kind: 'literal', value: linked.id },
                    expectedRevision: { kind: 'literal', value: 4 },
                    expectedTargetLinkRevision: { kind: 'literal', value: 2 },
                    dataCreation: { kind: 'literal', value: { runId, invocationId: captureInvocationId } },
                    reason: { kind: 'literal', value: 'previewClosed' },
                } },
                { actionId: 'deployments.teardown', input: {
                    environmentId: { kind: 'literal', value: child.environment.id },
                    removeEnvironment: { kind: 'literal', value: true },
                } },
            ]);
        } finally { await mounted.dispose(); restoreHttp(); await app.close(); }
    });
});

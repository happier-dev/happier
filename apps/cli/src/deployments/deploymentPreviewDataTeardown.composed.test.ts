import { resolve } from 'node:path';
import fastify from 'fastify';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as undici from 'undici';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { WorkflowActionInputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { encodeBase64, DeploymentTransitionInputV1Schema } from '@happier-dev/protocol';
import { encodePlainArtifactStoredContent, decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { DeploymentDataTeardownContentV1Schema } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1, createDeploymentTargetLinkHeaderV1,
    createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { createPurposeTargetResolver } from '@/daemon/connectedServices/purposeBindings/resolveTarget';
import * as installationStore from '@/daemon/identity/store';
import { QualifiedConnectedAccountProfileV4Schema, QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountConfigurationSnapshotV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import * as supabase from '../../../../packages/plugins/deployment-supabase/src/index';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createConnectedAccountPurposeMaterializer } from '@happier-dev/cli-common/connectedAccounts';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createCommittedContributedActionInvoker, createCommittedContributedActionSchemaReader, listRuntimeContributedActionDefinitions }
    from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createWorkflowDataPluginRuntimeFixture } from './targets/workflowDataPluginRuntime.testkit';
import { createPullRequestPreviewDataCreationJourneyFixture, createPullRequestPreviewEnvironmentContent }
    from './pullRequestPreviewComposeJourney.testkit';

// Genuine vendor HTTP boundary; the production Undici Agent and host services remain real.
vi.mock('undici', async importOriginal => {
    const runtime = await importOriginal<typeof import('undici')>();
    return { ...runtime, fetch: vi.fn(runtime.fetch) };
});

afterEach(() => { vi.restoreAllMocks(); vi.mocked(undici.fetch).mockReset(); vi.unstubAllGlobals(); });

/** Home HTTP/artifact persistence and vendor HTTP are replaced; Account activation,
 * reviewed child dispatch, role admission and Workflow getters stay real. */
describe('ordinary preview data teardown composition', () => {
    it.each(['retained A', 'encrypted retained A', 'provider refusal', 'provider refusal after retained resume', 'native volume operand', 'wrong invocation', 'wrong result', 'another person', 'unknown creation'] as const)(
        'tears down only the accepted resource and principal after the live link moves to B: %s', async scenario => {
            const providerRefusal = scenario === 'provider refusal' || scenario === 'provider refusal after retained resume';
            const accountId = 'account-A', origin = 'https://preview-home.test';
            const app = fastify();
            const homeRequests: string[] = [];
            app.addHook('onRequest', async request => { homeRequests.push(`${request.method} ${request.url}`); });
            const authored = await registerAuthoredAccountActionRelease(app, accountId, { primary: {
                manifest: supabase.manifest,
                projectRoot: resolve(import.meta.dirname, '../../../../packages/plugins/deployment-supabase'),
                entryPath: resolve(import.meta.dirname, '../../../../packages/plugins/deployment-supabase/src/index.ts'),
            } });
            const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
            const credentials = { token, encryption: null };
            const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(81));
            vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
                installationId: 'host-installation', createdAt: 1, publicKey: encodeBase64(installation.publicKey, 'base64url'),
                privateKey: encodeBase64(installation.secretKey, 'base64url') });
            const baseline = createDeploymentEnvironmentDetailV1();
            const environment = createDeploymentEnvironmentHeaderV1({ id: 'environment-A', serverId: 'home',
                owner: { kind: 'account', accountId }, controllerMachineId: 'host', purpose: 'preview',
                previewTemplateEnvironmentId: 'template-A', previewRepositoryId: 'repository-source',
                previewPullRequestId: '17', previewTargetLinkId: 'template-runtime' });
            const link = createDeploymentTargetLinkHeaderV1({ id: 'data-link', environmentId: environment.id,
                createdByAccountId: accountId, role: 'data', revision: 2, targetKind: 'supabase', machines: [], members: [],
                contentArtifactId: 'artifact-data-link',
                source: { kind: 'plugin', contribution: { pluginId: supabase.manifest.id, localId: 'database' } } });
            const seed = (id: string, kind: string, content: unknown) => authored.artifacts.seed(id,
                encodePlainArtifactStoredContent({ kind, title: 'Preview' }),
                encodePlainArtifactStoredContent({ body: JSON.stringify(content) }));
            seed(environment.contentArtifactId, 'deployment-environment.v1', baseline.content);
            for (const row of baseline.targetLinks) seed(row.targetLink.contentArtifactId, 'deployment-target-link.v1', row.content);
            const template = createDeploymentEnvironmentHeaderV1({ id: 'template-A', serverId: 'home',
                owner: { kind: 'account', accountId }, projectSourceId: 'repository-source', controllerMachineId: 'host',
                runtimeTargetLinkId: 'template-runtime', contentArtifactId: 'template-content' });
            seed(template.contentArtifactId, 'deployment-environment.v1', { ...baseline.content, previewTemplate: {
                v: 1, enabled: true, forkPreviews: 'off',
                repository: { kind: 'github', deployment: 'https://forge.example/enterprise', repository: 'owner/app' },
                runtimeTargetLinkId: 'template-runtime', domain: null, bindingBlueprints: [], data: [],
            } });
            const templateRuntime = createDeploymentTargetLinkHeaderV1({ id: 'template-runtime', environmentId: template.id,
                machines: ['host'], members: [{ machineId: 'host', installationId: 'host-installation', state: 'active' }] });
            const descriptor = supabase.manifest.contributes.connectedAccountDescriptors?.[0];
            if (!descriptor) throw new Error('Supabase connected Account declaration required');
            const service = { pluginId: supabase.manifest.id, localId: descriptor.id };
            const credentialRef = { service, accountId: 'connected-A' };
            const credentialRevision = 'csr_abcdefghijklmnopqrstuv';
            const configurationRevision = 'supabase-configuration';
            const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: credentialRef, status: 'connected',
                authenticationModeId: 'token', revisionSemantics: 'revisioned', credentialRevision,
                configurationReady: true, configurationRevision, kind: 'token', expiresAt: null,
                displayName: 'Original Supabase', scopes: [] });
            const providerRequests: { method: string; pathname: string; authorization: string | null }[] = [];
            const materializations: unknown[] = [];
            let establishedRuntime: ReturnType<typeof createQualifiedConnectedAccountEstablishedRuntimeOwner>;
            const materializeSelectedAccount = createConnectedAccountPurposeMaterializer({
                invokeWithReceipt: request => establishedRuntime.invokeWithReceipt(request),
            });
            const purposeOwner = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: accountId,
                store: { read: async () => ({ v: 1, bindings: [] }), update: async () => { throw new Error('No Account preference writes'); },
                    subscribe: () => ({ dispose() {} }) },
                selectTarget: async () => { throw new Error('No Account selection during teardown'); },
                resolveTarget: createPurposeTargetResolver({ available: true,
                    resolveService: async () => ({ service, authentication: descriptor.authentication }), listAccounts: async () => [profile] }),
                resolveCredentialRevision: async () => credentialRevision,
                materializeAccount: async request => {
                    materializations.push(request.account);
                    return materializeSelectedAccount(request);
                },
                projectTargetAccounts: async () => [], assertTargetAccountMaterializable: async () => undefined,
            });
            const providerFetch: typeof globalThis.fetch = async (url, init) => {
                const parsed = new URL(String(url));
                if (parsed.origin === origin) return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'home' } } });
                if (parsed.hostname !== 'api.supabase.com') throw new Error(`Unexpected provider ${parsed.pathname}`);
                providerRequests.push({ method: init?.method ?? 'GET', pathname: parsed.pathname,
                    authorization: new Headers(init?.headers).get('authorization') });
                if ((init?.method ?? 'GET') === 'GET' && parsed.pathname === '/v1/projects/parent-project-A/branches')
                    return Response.json([{ id: 'branch-A', name: 'pr-17', project_ref: 'child-project-A',
                        parent_project_ref: 'parent-project-A', persistent: false }]);
                if (init?.method === 'DELETE' && parsed.pathname === '/v1/branches/child-project-A')
                    return providerRefusal ? Response.json({ message: 'forbidden' }, { status: 403 })
                        : Response.json({ message: 'ok' });
                throw new Error(`Unexpected Supabase request ${init?.method ?? 'GET'} ${parsed.pathname}`);
            };
            vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch);
            // Node source uses the package's dispatcher-aware fetch instead of global fetch.
            vi.mocked(undici.fetch).mockImplementation(providerFetch as unknown as typeof undici.fetch);
            let receipt = createDeploymentReceiptHeaderV1({ id: 'teardown-A', environmentId: environment.id, targetLinkId: link.id,
                operation: 'teardown', requestKey: 'preview-close', actionOperationId: 'close-operation',
                state: scenario === 'provider refusal after retained resume' ? 'running' : 'queued',
                startedAtMs: scenario === 'provider refusal after retained resume' ? 1001 : undefined, settledAtMs: undefined,
                acceptedExecution: { v: 1, controller: { machineId: 'host', installationId: 'host-installation' } } });
            const transitions: unknown[] = [];
            const environmentWrites: unknown[] = [];
            let admitted = false;
            app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 0 }));
            app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
            app.get('/v1/account/profile', async () => ({ id: accountId }));
            app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
            app.post('/v1/deployments/environments', async request => {
                environmentWrites.push(request.body);
                return { ok: true, environmentId: environment.id, revision: environment.revision };
            });
            app.get<{ Params: { environmentId: string } }>('/v1/deployments/environments/:environmentId', async request =>
                request.params.environmentId === template.id ? { ok: true, environment: template, targetLinks: [templateRuntime] }
                    : { ok: true, environment, targetLinks: [...baseline.targetLinks.map(row => row.targetLink), link] });
            app.get('/v1/deployments/environments/:environmentId/domains', async () => ({ ok: true,
                environmentId: environment.id, revision: environment.revision, domains: [], nextCursor: null }));
            app.get('/v1/deployments/receipts/:deploymentId', async () => ({ ok: true, deployment: receipt }));
            app.get('/v1/deployments/environments/:environmentId/deployments', async () => ({ ok: true,
                items: admitted ? [receipt] : [], nextCursor: null }));
            app.post('/v1/deployments/environments/:environmentId/teardown', async (request, reply) => {
                const body = request.body as { contentArtifactId: string };
                // Home's existing requestKey fingerprint includes prepared Artifact identity.
                if (admitted && receipt.contentArtifactId !== body.contentArtifactId)
                    return reply.code(409).send({ ok: false, error: 'deployment_conflict' });
                receipt = { ...receipt, contentArtifactId: body.contentArtifactId };
                admitted = true;
                return { ok: true, environmentId: environment.id, revision: 1,
                    deploymentId: receipt.id, deploymentRevision: receipt.revision, state: receipt.state };
            });
            app.post('/v1/deployments/environments/:environmentId/deployments/:deploymentId/transitions', async request => {
                const body = DeploymentTransitionInputV1Schema.parse(request.body);
                transitions.push(body);
                if (body.contentUpdate) {
                    if (!body.contentArtifactId) throw new Error('Receipt content update requires its admitted Artifact');
                    const stored = authored.artifacts.read(body.contentArtifactId);
                    if (!stored) throw new Error('Expected the admitted receipt Artifact');
                    authored.artifacts.seed(body.contentArtifactId,
                        body.contentUpdate.header ?? stored.header, body.contentUpdate.body ?? stored.body);
                }
                receipt = { ...receipt, state: body.state, revision: receipt.revision + 1 };
                return { ok: true, environmentId: environment.id, revision: 1,
                    deploymentId: receipt.id, deploymentRevision: receipt.revision, state: body.state };
            });
            await app.ready();
            const restoreHttp = installAxiosFastifyAdapter({ app, origin });
            const mounted = await createWorkflowDataPluginRuntimeFixture({
                connectedAccounts: purposeOwner, actionFormConnectedAccounts: purposeOwner,
                accountExecution: { credentials, serverUrl: origin, serverId: 'home', serverIdentityId: 'home', machineId: 'host', isCurrent: async () => true },
                resolveCurrentMachineId: () => 'host' });
            // Only persisted credential/configuration transport is supplied. The
            // real established owner opens it and invokes Supabase's token reader.
            establishedRuntime = createQualifiedConnectedAccountEstablishedRuntimeOwner({
                reloadController: mounted.controller, credentials, getAccountEncryptionMode: async () => 'plain',
                isAccountRuntimeCurrent: async () => true,
                readCredential: async ({ ref }) => ref.accountId === credentialRef.accountId
                    && ref.service.pluginId === service.pluginId && ref.service.localId === service.localId
                    ? QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
                        ref, authenticationModeId: 'token', revisionSemantics: 'revisioned', credentialRevision, configurationRevision,
                        content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
                            payload: { v: 1, values: { token: 'original-A' } }, randomBytes: length => new Uint8Array(length) }),
                        metadata: { displayName: 'Original Supabase', scopes: [] },
                    }) : null,
                readConfiguration: async () => QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({
                    target: { kind: 'account', ref: credentialRef }, authenticationModeId: 'token', revisionSemantics: 'revisioned',
                    credentialRevision, configurationRevision,
                    configurationContent: sealQualifiedConnectedAccountContentEnvelope({ kind: 'configuration', accountMode: 'plain',
                        payload: { values: { organizationSlug: 'organization-A', projectRef: 'parent-project-A' }, secretRefs: {} },
                        randomBytes: length => new Uint8Array(length) }),
                }),
                configuration: { read: async () => null, secrets: { admit: async () => {}, has: async () => false, read: async () => null } },
            });
            try {
                const deps = createDaemonDeploymentActionDeps({ credentials: { token, encryption: null }, serverId: 'home',
                    serverHttpBaseUrl: origin, machineId: 'host',
                    resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                    runtime: { async acquire() { throw new Error('Data teardown must not acquire native runtime'); } },
                    acquirePluginRuntimeRegistryLease: () => mounted.controller.acquireRuntimeRegistry({
                        resolveRuntimeRegistry: async () => mounted.registry }),
                });
                const createEnvironment: NonNullable<Parameters<typeof createPullRequestPreviewDataCreationJourneyFixture>[0]['createEnvironment']> =
                    async (input, context, acceptedInputs) => {
                        const content = createPullRequestPreviewEnvironmentContent({ baseContent: baseline.content, input, acceptedInputs });
                        seed(input.contentArtifactId, 'deployment-environment.v1', content);
                        seed(environment.contentArtifactId, 'deployment-environment.v1', content);
                        return deps.deploymentAction('deployments.environments.create', input, { ...context,
                            machineAdmission: { actorAccountId: accountId, custodianAccountId: accountId, machineId: 'host',
                                installationId: 'host-installation', role: 'manage', encryptionMode: 'plain' },
                            verifyMachineAdmissionCurrent: async () => true });
                    };
                const created = await createPullRequestPreviewDataCreationJourneyFixture({ contributes: mounted.registry.contributes,
                    encrypted: scenario === 'encrypted retained A',
                    ...(scenario === 'another person' ? { accountId: 'account-B', readableByAccountIds: [accountId] } : {}),
                    ...(scenario === 'unknown creation' ? { createOutcome: 'outcome_unknown' } : {}),
                    ...(scenario === 'retained A' || scenario === 'encrypted retained A' || providerRefusal || scenario === 'native volume operand' || scenario === 'wrong result' ? { createEnvironment } : {}),
                });
                link.source = { kind: 'plugin', contribution: { pluginId: created.input.credentialRef.service.pluginId, localId: 'database' } };
                seed(link.contentArtifactId, 'deployment-target-link.v1', {
                    credentialPrincipal: { ...created.input.credentialPrincipal, target: { kind: 'account', account: {
                        ...created.input.credentialRef, accountId: 'connected-B' } } },
                    providerIdentity: { providerAccountId: 'organization-B', providerResourceId: 'parent-project-B', providerEnvironment: 'child-project-B' },
                    providerEnvironment: { kind: 'custom', id: 'child-project-B' },
                });
                const list: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['listContributedActionDefinitions']> =
                    selection => listRuntimeContributedActionDefinitions(mounted.registry, selection);
                const childResults: unknown[] = [];
                const invokeContributedAction = createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () => {
                    const lease = mounted.controller.tryAcquireRuntimeRegistry();
                    if (!lease) throw new Error('Fixture registry unavailable');
                    return lease;
                }, requestCurrentIntent: async ({ fingerprint }) => ({ status: 'approved', fingerprint }) });
                const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps,
                    workflowAction: request => created.readWorkflowInvocation(
                        WorkflowActionInputSchemasV1['workflow.run.invocations.get'].parse(request.input), request.context),
                    listContributedActionDefinitions: list,
                    readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
                    invokeContributedAction: async request => {
                        const result = await invokeContributedAction(request);
                        childResults.push(result);
                        return result;
                    },
                });
                const teardownInput: Record<string, JsonValue> = { serverId: 'home', environmentId: 'environment-A',
                    expectedRevision: 1, targetLinkId: 'data-link', expectedTargetLinkRevision: 2,
                    requestKey: 'preview-close', reason: 'previewClosed',
                    ...(scenario === 'native volume operand' ? { volumes: [{ name: 'app_data', disposition: 'delete', confirmation: 'app_data' }] } : {}),
                    dataCreation: { ...created.reference,
                        invocationId: scenario === 'wrong invocation' ? 'unrelated-invocation'
                            : scenario === 'wrong result' ? 'preview-environment-create' : created.reference.invocationId } };
                const execute = () => executor.execute('deployments.teardown', teardownInput,
                { surface: 'cli', authority: 'present_user', runtimeAccountId: accountId,
                    actionCaller: { kind: 'host' }, serverId: 'home', serverIdentityId: 'home',
                    actionsSettings: normalizeActionsSettingsV1(undefined),
                    presentUserConfirmation: { actionId: 'deployments.teardown' },
                    operationAcceptance: { operationId: 'close-operation', accept() {} } });
                const result = await execute();
                const diagnostic = JSON.stringify({ result, childResults, homeRequests, providerRequests, materializations });
                if (scenario === 'native volume operand') {
                    expect(result, diagnostic).toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
                    expect(providerRequests).toEqual([]);
                    expect(materializations).toEqual([]);
                    expect(transitions).toEqual([]);
                    return;
                }
                if (scenario === 'retained A' || scenario === 'encrypted retained A' || providerRefusal || scenario === 'wrong result') {
                    expect(created.environmentResult).toEqual({ ok: true, environmentId: created.input.environmentId, revision: 1 });
                    expect(environmentWrites).toEqual([created.parent.input]);
                }
                if (providerRefusal) {
                    expect(providerRequests.map(request => request.method), diagnostic).toEqual(['GET', 'DELETE']);
                    const stored = authored.artifacts.read(receipt.contentArtifactId);
                    if (!stored?.body) throw new Error('Expected persisted teardown receipt');
                    const body = decodePlainArtifactStoredContent(stored.body);
                    if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') {
                        throw new Error('Expected plain receipt body');
                    }
                    const content = DeploymentDataTeardownContentV1Schema.parse(JSON.parse(body.body));
                    expect(content.failure, diagnostic).toMatchObject({ code: 'deployment_access_denied',
                        failureCause: { errorCode: 'deployment_access_denied' } });
                    expect(receipt.state).toBe(content.failure?.effectAttempted === true ? 'outcome_unknown' : 'failed');
                    expect(result, diagnostic).toMatchObject({ ok: false, errorCode: 'deployment_access_denied',
                        failureCause: content.failure?.failureCause, details: { serverId: 'home', environmentId: environment.id,
                            targetLinkId: link.id, deploymentId: receipt.id, failure: content.failure } });
                    return;
                }
                if (scenario !== 'retained A' && scenario !== 'encrypted retained A') {
                    expect(result, diagnostic).toMatchObject({ ok: false,
                        errorCode: scenario === 'another person' ? 'deployment_access_denied'
                            : scenario === 'wrong invocation' ? 'run_not_found' : 'deployment_content_unavailable' });
                    expect(providerRequests).toEqual([]);
                    expect(materializations).toEqual([]);
                    expect(transitions).toEqual([]);
                    return;
                }
                expect(result, diagnostic).toMatchObject({ ok: true, result: { state: 'succeeded' } });
                expect(await execute()).toMatchObject({ ok: true, result: { state: 'succeeded', deploymentId: receipt.id } });
                expect(homeRequests.filter(request => request === 'POST /v1/artifacts')).toHaveLength(1);
                expect(providerRequests).toEqual([
                    { method: 'GET', pathname: '/v1/projects/parent-project-A/branches', authorization: 'Bearer original-A' },
                    { method: 'DELETE', pathname: '/v1/branches/child-project-A', authorization: 'Bearer original-A' },
                ]);
                expect(materializations).toEqual([created.input.credentialRef]);
                expect(transitions).toEqual([expect.objectContaining({ state: 'succeeded', teardownProof: expect.objectContaining({ retainedProviderResource: true }) })]);
            } finally { await mounted.dispose(); restoreHttp(); await app.close(); }
    });
});

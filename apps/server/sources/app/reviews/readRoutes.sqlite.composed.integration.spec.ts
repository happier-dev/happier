import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ReviewListResponseV1Schema } from '@happier-dev/protocol/reviews/reviewListV1';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListPageV1';
import { createAccountServerActionDeps } from '../../../../cli/src/api/accountServerActionDeps';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import type { Fastify as AppFastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { registerReviewReadRoutes } from './readRoutes';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { createReviewRecordPortV1, ReviewRoundBindingV1Schema } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { readReviewStartActionResultV1 } from '@happier-dev/protocol/actions/specs/executionRunCompletion';
import { createCredentialedAccountArtifactStore, createAcknowledgedAccountArtifactTransport } from '../../../../cli/src/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '../../../../cli/src/api/client/serverHttpBaseUrl';
import { createReviewRunCommentService } from '../../../../cli/src/agent/executionRuns/profiles/review/reviewComments';
import { ReviewProfile } from '../../../../cli/src/agent/executionRuns/profiles/review/ReviewProfile';
import { finishExecutionRun } from '../../../../cli/src/agent/runtime/bridges/executionRun/finishExecutionRun';
import { resolveExecutionRunRuntimeBackendTarget, resolveExecutionRunRuntimeBackendId } from '../../../../cli/src/agent/runtime/bridges/executionRun/backendTargets';
import type { ExecutionRunState } from '../../../../cli/src/agent/runtime/bridges/executionRun/executionRunTypes';
import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '@happier-dev/protocol/account/settings/sessionAgentSpawnPolicyV1';
import { createCliActionDeps } from '../../../../cli/src/session/actions/createCliActionDeps';
import { registerProjectAccountRowRoutes } from '@/app/api/routes/projects/registerProjectAccountRowRoutes';
import { registerSessionListingRoutes } from '@/app/api/routes/session/registerSessionListingRoutes';
import { featuresRoutes } from '@/app/api/routes/features/featuresRoutes';
import { registerReviewHumanRoutes } from './reviewHumanRoutes';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { inTx } from '@/storage/inTx';
import { setArtifactAccessGrantInTx } from '@/app/artifacts/artifactAccessService';
import { setTeamPolicyInTx } from '@/app/teams/policy';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1,
    sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
    type WorkflowDefinitionV1, type WorkflowProgressEnvelopeV1 } from '@happier-dev/protocol';
import { createProductionWorkflowRunCoordinator } from '../../../../cli/src/daemon/workflows/production';
import { createWorkflowRunStorageTestkit } from '../../../../cli/src/daemon/workflows/workflowRunStorage.testkit';
import { createCliActionExecutor } from '../../../../cli/src/session/actions/createCliActionExecutor';
import tweetnacl from 'tweetnacl';
import { AutomationStoredWorkflowDefinitionRecipeV2Schema, AutomationTriggerIdSchema,
    AutomationSourceSelectorIdV1Schema, AutomationRunPluginEventTriggerEvidenceV1Schema,
    buildAutomationPluginEventOccurrenceEvidenceV1, deriveAutomationOccurrenceKeyV1,
    encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { createPullRequestReviewWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/pullRequestReview';
import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { createWorkflowMaterializationHostV1 } from '@happier-dev/protocol/actions/executor/workflowMaterializationHost';
import { createWorkflowAccountRunActionOwner } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/triage/src/manifest';
import { createTriagePullRequestReviewActionTestkit, TESTKIT_OBSERVED_REVISION } from '../../../../../packages/plugins/triage/src/sessions/testkit/entrySessionTestkit.test-support';
import { normalizeGithubRepositoryEventForAutomation } from '../../../../../packages/plugins/scm-github/src/observations/githubRepositoryEventNormalization';
import { capturedRepositoryPullRequestEvent } from '../../../../../packages/plugins/scm-github/src/observations/testkit/githubRepositoryPullRequestEvent.fixture';
import { GITHUB_AUTOMATION_EVENT_LOCAL_IDS } from '../../../../../packages/plugins/scm-github/src/githubAutomationEvents';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { normalizePluginManifestV2 } from '../../../../cli/src/plugins/manifest/normalize';
import { projectLoadedPluginContributes } from '../../../../cli/src/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '../../../../cli/src/plugins/projection/registry/createResolvedContributionRegistry';
import { buildPluginWorkflowMaterializationProjectionV2 } from '../../../../cli/src/plugins/projection/registry/projection/v2';
import { createPluginInvocationActionsService } from '../../../../cli/src/plugins/runtime/invocation/services/actions';
import { createPluginActionCallerMaterializationFixture } from '../../../../cli/src/plugins/runtime/invocation/services/actionCaller.testkit';
import { createPluginRuntimeOccurrenceId } from '../../../../cli/src/plugins/runtime/runtimeSlots';
import { buildWorkflowActionContext } from '../../../../cli/src/daemon/workflows/workflowActionContext';
import { fetchServerFeaturesSnapshot } from '../../../../cli/src/features/serverFeaturesClient';
import { createCredentialedWorkflowAcceptedAuthorizationCurrentness } from '../../../../cli/src/daemon/workflows/daemonRuntime';
import { prepareWorkflowAcceptedWorkspaceTarget } from '../../../../cli/src/daemon/workflows/resolveWorkflowWorkspace';
import { createWorkflowRunStorageClient } from '../../../../cli/src/daemon/workflows/workflowRunStorageClient';
import type { WorkflowClaimForCoordination } from '../../../../cli/src/daemon/workflows/worker';
import { createAutomation, runAutomationNow } from '@/app/automations/automationCrudService';
import { admitAutomationRunTx } from '@/app/automations/automationRunAdmissionService';
import { claimAutomationRun, toAutomationV3WorkerClaimResponse } from '@/app/automations/automationClaimService';
import { cancelAutomationRun } from '@/app/automations/automationRunService';
import { fetchAutomationAccountCurrentnessWitnessTx } from '@/app/automations/automationAccountCurrentness';
import { registerWorkflowRunStorageRoutes } from '@/app/api/routes/automations/registerWorkflowRunStorageRoutes';
import { registerAutomationActionIndexRoutes } from '@/app/api/routes/automations/registerAutomationActionIndexRoutes';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { createTrustedMachineInstallation, createSignedPluginInstallationPublisherHeader } from '@/testkit/pluginInstallationPublisherTestkit';
import * as machineRpc from '../../../../cli/src/session/transport/rpc/machineRpc';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { ScmComparisonCaptureInputSchema, ScmComparisonCaptureOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';

describe('Review read Actions through authenticated HTTP', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    let app: AppFastify;
    let origin: string;
    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'happier-review-read-actions-', initAuth: true, initEncrypt: true });
        app = Fastify().withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        enableAuthentication(app);
        registerReviewReadRoutes(app);
        artifactsRoutes(app);
        registerAccountEncryptionRoutes(app);
        registerProjectAccountRowRoutes(app);
        registerSessionListingRoutes(app);
        registerReviewHumanRoutes(app);
        registerWorkflowRunStorageRoutes(app);
        registerAutomationActionIndexRoutes(app);
        machinesRoutes(app);
        featuresRoutes(app);
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Expected HTTP listener');
        origin = `http://127.0.0.1:${address.port}`;
    }, 180_000);
    afterAll(async () => { await app?.close(); await harness?.close(); });

    it('serves a full Review page and its continuation through authenticated HTTP', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const ids = Array.from({ length: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 + 1 }, () => randomUUID());
        await db.artifact.createMany({ data: ids.map(id => ({ id, accountId: owner.id,
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array() })) });
        await db.reviewMetadata.createMany({ data: ids.map(artifactId => ({ artifactId,
            subjectKind: 'comparison', sourceKind: 'direct', state: 'completed', currentRoundOrdinal: 1, startedAt: new Date() })) });
        const request = async (cursor?: string) => {
            const response = await app.inject({ method: 'POST', url: '/v1/reviews/list',
                headers: { authorization: `Bearer ${token}` }, payload: { limit: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1, ...(cursor ? { cursor } : {}) } });
            expect(response.statusCode, response.body).toBe(200);
            return ReviewListResponseV1Schema.parse(response.json());
        };
        const first = await request();
        expect(first.items).toHaveLength(ARTIFACT_LIST_PAGE_MAX_ITEMS_V1);
        expect(first.cursor).toEqual(expect.any(String));
        const second = await request(first.cursor!);
        expect(second.items).toHaveLength(1);
        expect(second.cursor).toBeNull();
        expect(new Set([...first.items, ...second.items].map(row => row.reviewId))).toEqual(new Set(ids));
    });

    it('consumes retained Account PR occurrences through production holds and actual Review HTTP starts', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const credentials = { token, encryption: null };
        const machineId = randomUUID();
        const installationId = randomUUID();
        const keyPair = tweetnacl.sign.keyPair();
        await createTrustedMachineInstallation({ accountId: owner.id, machineId, installationId, keyPair });
        await db.machine.update({ where: { id: machineId }, data: {
            metadata: encodePlainMachineStoredContent({ host: 'fixture', platform: 'linux', happyCliVersion: '0.3.0',
                homeDir: harness.baseDir, happyHomeDir: harness.baseDir }),
            dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
        } });
        const metadata = { path: harness.baseDir, machineId, host: 'fixture' };
        const ownerMetadata = createSessionOwnerMetadataV1({ metadata });
        if (!ownerMetadata.ok) throw new Error('Expected canonical Session owner metadata');
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain',
            metadataLayoutVersion: 1, metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
            ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata.ownerMetadata)) } });
        await runWithServerHttpBaseUrl(origin, async () => {
            let childActions: ReturnType<typeof createPluginInvocationActionsService>;
            const source = await createTriagePullRequestReviewActionTestkit({ executeReview: async input =>
                childActions.execute('review.start', projectNativeJsonValueForTransport(input)) });
            // Native SCM is outside this HTTP fixture. Retained comparisons are
            // exact-Machine reads; only a fresh live capture writes the Session.
            const nativeScm = vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
                expect(request.machineId).toBe(machineId);
                if (request.method !== RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE) throw new Error(`unexpected_machine_effect:${request.method}`);
                const envelope = TargetedActionRpcRequestV1Schema.parse(request.request);
                expect(envelope.target).toEqual({ kind: 'machine', machineId,
                    project: { machineId, directory: harness.baseDir } });
                const input = ScmComparisonCaptureInputSchema.parse(envelope.input);
                expect(input.sessionId).toBe(session.id);
                if (input.comparisonId) expect(request.authorization).toBeUndefined();
                else expect(request.authorization).toEqual({ kind: 'session.write', sessionId: session.id });
                const captured = await source.context.services.actions.execute('scm.diffSummary.capture', projectNativeJsonValueForTransport(input));
                if (!captured || typeof captured !== 'object' || !('comparison' in captured)) throw new Error('Missing native comparison');
                const comparison = ScmComparisonSchema.parse(captured.comparison);
                if (input.comparisonId) expect(comparison.id).toBe(input.comparisonId);
                return ScmComparisonCaptureOutputSchema.parse({ success: true, comparison,
                    metadata: { source: comparison.source, sourceKey: comparison.id } });
            });
            onTestFinished(() => nativeScm.mockRestore());
            const caller = createPluginActionCallerMaterializationFixture(PLUGIN_MANIFEST.id, { machineId });
            const occurrenceId = createPluginRuntimeOccurrenceId(PLUGIN_MANIFEST.id);
            const definitions = PLUGIN_MANIFEST.contributes.actions.map(action => ActionDefinitionV1Schema.parse({
                kindVersion: 1, id: `${PLUGIN_MANIFEST.id}/actions/${action.id}`, title: resolvePluginLocalizedStringV2Text(action.title),
                description: null, safety: action.dangerLevel === 'safe' ? 'safe' : 'danger', placements: [], slash: null, bindings: null,
                examples: null, surfaces: { agent: true }, inputHints: null, inputSchema: action.inputSchema, outputSchema: action.resultSchema,
            }));
            const executor = createCliActionExecutor({ token, credentials, sessionId: session.id, mode: 'plain', ctx: null,
                serverId: origin, serverHttpBaseUrl: origin, pluginActionExecutionOwner: 'current_process',
                accountServerActionDeps: createAccountServerActionDeps({ token, credentials, machineId,
                    serverId: origin, serverHttpBaseUrl: origin }),
                listContributedActionDefinitions: () => definitions,
                resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: origin }),
                invokeContributedAction: async request => {
                    childActions = createPluginInvocationActionsService({ seed: {
                        plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
                        contribution: { id: request.action.localId, qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${request.action.localId}` },
                        occurrenceId, sourceCustody: { kind: 'development', registeredRootId: 'triage-root-1' },
                        surface: 'agent', initiatingActionCaller: request.context.actionCaller, approvalContext: request.context,
                        resolveCurrentPluginMaterializationRef: caller.resolveCurrentPluginMaterializationRef,
                        signal: request.signal ?? new AbortController().signal, isOccurrenceCurrent: () => true,
                    }, actionExecutor: executor,
                    invokeContributedAction: async () => { throw new Error('No nested contributed Action'); } });
                    return { ok: true, result: await source.invoke(request.action.localId, projectNativeJsonValueForTransport(request.input)) };
                },
                // The SCM operation is the source's native/process boundary. Its
                // real Triage preparation, Action executor and Review port stay on path.
                runtimeActionExecute: async request => {
                    if (request.actionId !== 'scm.diffSummary.capture') throw new Error(`unexpected_native_effect:${request.actionId}`);
                    return source.context.services.actions.execute('scm.diffSummary.capture', projectNativeJsonValueForTransport(request.input));
                },
            });
            const event = { pluginId: 'example.forge', localId: 'pull-request' };
            const definition = createPullRequestReviewWorkflowV1(event);
            const { v: _version, reviewTarget, ...saved } = source.savedInput;
            const people = [{ kind: 'person', principal: { kind: 'account', accountId: owner.id }, required: true }];
            const selectedWorkspace = { serverId: origin, machineId, rootPath: harness.baseDir };
            source.preparedWorkspace.repositoryPath = harness.baseDir;
            const inputs = { ...saved, request: { ...saved.request, workspace: selectedWorkspace },
                prepareReviewWorkspaceSelection: { ...saved.prepareReviewWorkspaceSelection, input: {
                    ...saved.prepareReviewWorkspaceSelection.input, workspace: selectedWorkspace } }, sessionId: session.id,
                quickReview: { reviewers: people, instructions: 'Quick composition' },
                standardReview: { reviewers: people, instructions: 'Standard composition' } };
            const automation = await createAutomation({ accountId: owner.id, recipeFeaturePolicy: { workflowsEnabled: true }, input: {
                automationId: randomUUID(), name: 'PR occurrence persistence', enabled: true, triggers: [], assignments: [{ machineId }],
                executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: 1, triggerEvidence: null,
                    workflow: { t: 'plain', v: { workspace: { directory: harness.baseDir }, executionTarget: { kind: 'session' },
                        inlineDefinition: definition, inputs } } }),
            } });
            const triggerId = AutomationTriggerIdSchema.parse(randomUUID());
            const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(randomUUID());
            await db.automationTrigger.create({ data: { id: triggerId, automationId: automation.id, kind: 'pluginEvent', enabled: true,
                eventPluginId: event.pluginId, eventLocalId: event.localId, sourceSelectorId, sourceContractVersion: 1,
                observationTransport: 'checkpointedPull', watcherMachineId: machineId, watcherMachineInstallationId: installationId,
                watcherPluginId: event.pluginId, watcherMaterializationId: 'selected-pr-source',
                definitionEnvelope: JSON.stringify({ t: 'plain', v: {} }) } });
            const admit = async (association: 'external' | 'unknown' | 'internal', headSha: string, number: number) => {
                const nativeAssociation = association === 'internal' ? 'MEMBER' : association === 'external' ? 'CONTRIBUTOR' : undefined;
                const normalized = normalizeGithubRepositoryEventForAutomation({ ...capturedRepositoryPullRequestEvent, payload: {
                    ...capturedRepositoryPullRequestEvent.payload, pull_request: { ...capturedRepositoryPullRequestEvent.payload.pull_request,
                        number, author_association: nativeAssociation,
                        head: { ...capturedRepositoryPullRequestEvent.payload.pull_request.head, sha: headSha } },
                } }, { v: 1, repositoryId: '77', owner: 'acme', name: 'widgets', nameWithOwner: 'acme/widgets' },
                GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestLifecycle).observation;
                if (!normalized || !('pullRequest' in normalized.payload)) throw new Error('Missing native PR occurrence');
                // The selected source/SCM adapter boundary is the same canonical
                // testkit as the PR coordinator suite, retaining native author/head facts.
                const evidence = buildAutomationPluginEventOccurrenceEvidenceV1({ eventRef: event, sourceSelectorId,
                    occurrenceId: randomUUID(), occurredAt: Date.now(), payload: { pullRequest: normalized.payload.pullRequest,
                        reviewTarget: { ...reviewTarget, entryRef: { ...reviewTarget.entryRef, entryId: String(number) },
                            comparisonSource: { ...reviewTarget.comparisonSource, locator: { ...reviewTarget.comparisonSource.locator, number, headOid: headSha } } } } });
                const frozen = JSON.stringify({ t: 'plain', v: AutomationRunPluginEventTriggerEvidenceV1Schema.parse({ ...evidence,
                    sourceInstanceId: 'selected-pr-source', sourceContractVersion: 1, observationReceivedAt: Date.now(),
                    filter: { version: null, result: 'matched' } }) });
                const admitted = await inTx(tx => admitAutomationRunTx({ tx, accountId: owner.id, automationId: automation.id,
                    now: new Date(), recipeFeaturePolicy: { workflowsEnabled: true }, triggerEvidenceEnvelope: frozen,
                    executionTriggerEvidenceEnvelope: frozen, cause: { kind: 'trigger', triggerId, triggerRevision: 0,
                        triggerKind: 'pluginEvent', occurredAt: evidence.occurredAt,
                        occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence }), evidence: { eventRef: event, sourceSelectorId } } }));
                if (admitted.kind !== 'admitted') throw new Error(JSON.stringify(admitted));
                return admitted.run.id;
            };
            const storage = createWorkflowRunStorageClient({ token, machineId, serverHttpBaseUrl: origin,
                createPublisherHeader: async ({ path, body }) => createSignedPluginInstallationPublisherHeader({
                    keyPair, machineId, installationId, path, body, nonce: randomUUID() }) });
            const encryption = async () => {
                const witness = await fetchAutomationAccountCurrentnessWitnessTx(db, owner.id);
                if (!witness) throw new Error('Missing actual Account currentness');
                return { kind: 'available' as const, witness };
            };
            const registry = createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: { diagnosticsByPluginId: {}, loadedPlugins: [{ pluginId: PLUGIN_MANIFEST.id,
                    pluginRootPath: harness.baseDir, manifestPath: `${harness.baseDir}/plugin.json`,
                    daemonEntryPath: null, devDaemonEntryPath: null,
                    sourceSpec: { kind: 'path', locator: harness.baseDir, trustPolicy: 'local_trusted', installPolicy: 'link' },
                    manifest: normalizePluginManifestV2(PLUGIN_MANIFEST) }] }, provenance: 'first_party',
            }));
            const projection = buildPluginWorkflowMaterializationProjectionV2({ generation: 1,
                registry: { ...registry, occurrenceIdsByPluginId: { [PLUGIN_MANIFEST.id]: occurrenceId } } });
            const materializer = createWorkflowMaterializationHostV1({ serverId: origin,
                readAuthorizedSession: async () => { throw new Error('No Session leaf'); }, isHomeEquivalent: id => id === origin,
                callMachineAction: async ({ method, request }) => {
                    if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                        return { protocolVersion: 1, projection };
                    }
                    if (method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) {
                        const identity = (request as { qualifiedActionId: string }).qualifiedActionId;
                        const action = PLUGIN_MANIFEST.contributes.actions.find(item => `${PLUGIN_MANIFEST.id}/${item.id}` === identity);
                        if (action) return { ok: true, inputSchema: action.inputSchema, outputSchema: action.resultSchema };
                    }
                    throw new Error(`No native leaf admission:${method}`);
                },
                readRoleSelection: async () => { throw new Error('No Role selection'); }, readLaunchProfile: async () => null,
                readWorkflowDefinition: async () => { throw new Error('The admitted definition is inline'); },
                readHostActionContract: async id => { const action = definitions.find(item => item.id === id);
                    return action ? freezeWorkflowActionContractV1(action) : null; },
            });
            const context = (input: Parameters<typeof buildWorkflowActionContext>[0]) => ({ ...buildWorkflowActionContext(input),
                serverId: origin, bypassApprovals: true, defaultSessionMachineId: machineId,
                externalActionTarget: { kind: 'machine' as const, machineId, project: { machineId, directory: harness.baseDir } } });
            const coordinate = createProductionWorkflowRunCoordinator({ token, accountId: owner.id, machineId, storage,
                resolveAccountEncryption: encryption, isAcceptedAuthorizationCurrent: createCredentialedWorkflowAcceptedAuthorizationCurrentness({
                    credentials, accountId: owner.id, serverId: origin, serverHttpBaseUrl: origin }),
                resolveControllerContext: async () => ({ surface: 'cli', authority: 'present_user' }),
                resolveMaterializationHost: async target => ({ ...await materializer({ ...target, machineId }),
                    admitLeaf: async () => { throw new Error('No native leaf'); } }),
                prepareAcceptedWorkspaceTarget: input => prepareWorkflowAcceptedWorkspaceTarget({ ...input,
                    inspectLocation: async () => null }),
                workspaceScm: { inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
                execution: { credentials, serverId: origin,
                    machineAdmissionTransport: async () => { throw new Error('No native Session admission'); },
                    resolveExistingSessionConversation: async () => null,
                    detachedRun: { actionExecutor: executor, buildActionContext: context },
                    action: { executor, buildContext: async input => context(input),
                        observeRun: async () => { throw new Error('Human-only Review has no native Run'); } } },
            });
            const claim = async (expectedRunId: string): Promise<WorkflowClaimForCoordination> => {
                const claimed = toAutomationV3WorkerClaimResponse(await claimAutomationRun({ accountId: owner.id, machineId,
                    leaseDurationMs: 30_000, scope: 'workflow', recipeFeaturePolicy: { workflowsEnabled: true } }), owner.id);
                expect(claimed.run?.id).toBe(expectedRunId);
                if (!claimed.run || !claimed.automation || !claimed.accountCurrentness || !claimed.run.executionInputEnvelope) throw new Error('Missing real claim');
                return { runId: claimed.run.id, automationId: claimed.run.automationId, automationName: claimed.automation.name,
                    attempt: claimed.run.attempt, expectedRevision: claimed.run.revision, accountCurrentness: claimed.accountCurrentness,
                    definitionEnvelope: claimed.run.executionInputEnvelope, acceptedEnvelope: claimed.run.workflowAcceptedSnapshotEnvelope,
                    workflowDefinitionId: claimed.automation.workflowDefinitionId, scopeSessionId: claimed.automation.scopeSessionId,
                    causeWorkDepth: claimed.run.causeWorkDepth, automationEvidenceEnvelope: claimed.run.automationEvidenceEnvelope,
                    automationCause: claimed.run.cause };
            };
            const first = await claim(await admit('external', TESTKIT_OBSERVED_REVISION.headSha, 17));
            const firstResult = await coordinate(first);
            expect(firstResult, JSON.stringify(firstResult)).toMatchObject({ state: 'waiting_for_review' });
            const headB = 'e'.repeat(40);
            const second = await claim(await admit('unknown', headB, 17));
            expect(await coordinate(second)).toMatchObject({ state: 'waiting_for_review' });
            expect(source.events).toEqual([]);
            expect(source.prepareInputs).toEqual([]);
            expect(source.captureInputs).toEqual([]);
            expect(await db.reviewMetadata.count({ where: { artifact: { accountId: owner.id } } })).toBe(0);
            expect(await cancelAutomationRun({ accountId: owner.id, runId: first.runId })).toMatchObject({ state: 'cancelled' });
            expect(source.events).toEqual([]);
            const headC = 'f'.repeat(40);
            source.setRevision({ ...TESTKIT_OBSERVED_REVISION, headSha: headC, nativeRevision: 'head-c' });
            source.setPullRequestNumber(18);
            const third = await claim(await admit('internal', headC, 18));
            const thirdResult = await coordinate(third);
            expect(thirdResult).toMatchObject({ state: 'succeeded' });
            const records = () => createReviewRecordPortV1(createAcknowledgedAccountArtifactTransport(createCredentialedAccountArtifactStore(credentials)));
            const firstReview = await db.reviewMetadata.findFirstOrThrow({ where: { workflowRunId: third.runId } });
            expect((await records().read(firstReview.artifactId))?.rounds[0]?.comparisonCapture).toMatchObject({
                input: { source: { kind: 'pullRequest', locator: { number: 18, headOid: headC } } } });
            const runs = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => owner.id, resolveEncryption: encryption,
                definitions: { get: async () => { throw new Error('No saved definition'); } }, normalizeAbsolutePath: path => path,
                randomBytes, storage });
            const held = await db.workflowRunInvocation.findFirstOrThrow({ where: { runId: second.runId, lifecycle: 'waiting_for_review' } });
            expect(await runs.execute({ actionId: 'workflow.run.invocations.complete_review', input: {
                runId: second.runId, invocation: { recordId: held.id }, expectedContentRevision: held.contentRevision.toString(), mode: 'use_result',
            }, context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'yolo' } })).toMatchObject({ disposition: 'completed' });
            source.setRevision({ ...TESTKIT_OBSERVED_REVISION, headSha: headB, nativeRevision: 'head-b' });
            source.setPullRequestNumber(17);
            const resumedResult = await coordinate(await claim(second.runId)).catch(error => {
                throw new Error('Approved PR head resume failed', { cause: error });
            });
            expect(resumedResult).toMatchObject({ state: 'succeeded' });
            const secondReview = await db.reviewMetadata.findFirstOrThrow({ where: { workflowRunId: second.runId } });
            expect((await records().read(secondReview.artifactId))?.rounds[0]?.comparisonCapture).toMatchObject({
                input: { source: { kind: 'pullRequest', locator: { number: 17, headOid: headB } } } });
            expect(source.prepareInputs).toHaveLength(2);
            expect(await db.reviewMetadata.count({ where: { artifact: { accountId: owner.id } } })).toBe(2);
            const manual = await runAutomationNow({ accountId: owner.id, automationId: automation.id, idempotencyKey: randomUUID(),
                recipeFeaturePolicy: { workflowsEnabled: true } });
            if (!manual) throw new Error('Missing manual occurrence');
            const manualResult = await coordinate(await claim(manual.id)).catch(error => {
                throw new Error('Manual PR template start failed', { cause: error });
            });
            // The event template's active-PR branch has no event on a manual wake.
            // The separate manual PR workflow resolves its own selected target.
            expect(manualResult).toMatchObject({ state: 'succeeded' });
            expect(await db.workflowRunInvocation.count({ where: { runId: manual.id, lifecycle: 'failed' } })).toBe(0);
            expect(source.prepareInputs).toHaveLength(2);
            expect(await db.reviewMetadata.count({ where: { artifact: { accountId: owner.id } } })).toBe(2);
        });
    });

    it.each(['completed', 'failed', 'cancelled'] as const)('reloads a direct %s empty Review after actual terminal settlement through authenticated HTTP', async outcome => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', seq: 7 } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const recordsFor = () => createReviewRecordPortV1(createAcknowledgedAccountArtifactTransport(
            createCredentialedAccountArtifactStore({ token, encryption: null })));
        await runWithServerHttpBaseUrl(origin, async () => {
            const records = recordsFor();
            const starts: ExecutionRunState[] = [];
            const executor = createActionExecutor({
                ...createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }),
                reviewRecords: () => records,
                // The daemon's inventory/start RPC is the OS process boundary; no vendor is launched.
                reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex', enabled: true,
                    capabilities: { structuredNarration: true } }] }),
                executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: 'clean-review-machine' }),
                executionRunStart: async (sessionId, input) => {
                    const request = ExecutionRunStartRequestSchema.parse(input);
                    const backendTarget = resolveExecutionRunRuntimeBackendTarget(request.backendTarget);
                    if (!backendTarget) throw new Error('Expected the admitted engine target');
                    const run: ExecutionRunState = { runId: randomUUID(), callId: randomUUID(), sidechainId: randomUUID(), sessionId,
                        depth: 0, intent: 'review', backendId: resolveExecutionRunRuntimeBackendId(backendTarget), backendTarget,
                        instructions: request.instructions ?? '', permissionMode: request.permissionMode,
                        retentionPolicy: request.retentionPolicy, runClass: request.runClass, ioMode: request.ioMode,
                        status: 'running', startedAtMs: Date.now(), intentInput: request.intentInput };
                    starts.push(run);
                    return { runId: run.runId, callId: run.callId, sidechainId: run.sidechainId };
                },
            });
            const started = await executor.execute('review.start', { sessionId: session.id, scope: 'repository',
                instructions: 'Review the repository.', reviewers: [{ kind: 'engine', engineId: 'codex' }] }, {
                surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true, defaultSessionId: session.id,
                callerPermissionMode: 'read-only', sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
                agentStartContext: { caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
                    baseline: { machineId: 'clean-review-machine', directory: harness.baseDir }, roles: {}, ledSubtreeSessionIds: [],
                    workDepthLimit: 4, callerPermissionCeiling: 'read-only' },
            });
            expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
            if (!started.ok) throw new Error(started.error);
            const receipt = readReviewStartActionResultV1(started.result, { reviewers: [{ kind: 'engine', engineId: 'codex' }] });
            expect(receipt.kind).toBe('native');
            if (receipt.kind !== 'native') throw new Error('Expected the native Review admission receipt');
            const binding = ReviewRoundBindingV1Schema.parse(receipt.reviewRound);
            expect(starts).toHaveLength(1);
            const run = starts[0]!;
            expect(run.intentInput).toMatchObject({ reviewRound: binding, reviewRoundSettlement: 'execution' });
            const comments = createReviewRunCommentService({ cwd: harness.baseDir,
                scope: { workspace: { machineId: 'clean-review-machine', path: harness.baseDir } }, reviewRecords: records,
                execute: async () => { throw new Error('A clean result must not create a Review comment'); } });
            const payload = { reviewOutcome: 'complete', summary: 'No findings.', findings: [] };
            const completion = outcome === 'completed'
                ? ReviewProfile.onBoundedComplete({ start: run, rawText: JSON.stringify(payload), finishedAtMs: Date.now() }) : null;
            if (completion) expect(completion.status).toBe('succeeded');
            const status = outcome === 'completed' ? 'succeeded' : outcome;
            const runs = new Map([[run.runId, run]]);
            expect(await finishExecutionRun({ runId: run.runId,
                next: { status, summary: completion?.summary ?? outcome, finishedAtMs: Date.now(),
                    ...(outcome === 'failed' ? { error: { code: 'resource_forbidden', message: 'The native reviewer refused access.' } } : {}) },
                toolResult: { output: completion?.toolResultOutput ?? {}, meta: completion?.toolResultMeta ?? {} },
                structuredMeta: completion?.structuredMeta,
                runs, controllers: new Map(), budgetRegistry: null, parentProvider: 'claude', sendAcp: async () => {},
                enqueueMarkerWrite: async (_id, write) => { await write(); }, terminalMarkerWritePromises: new Map(),
                reviewComments: comments })).toBe(true);
            expect(runs.get(run.runId)?.status).toBe(status);
            if (outcome === 'failed') expect(runs.get(run.runId)?.error?.code).toBe('resource_forbidden');
            expect(await db.reviewComment.count({ where: { reviewId: binding.reviewId } })).toBe(0);
            // Discard the port and Action executor: all following reads cross HTTP from fresh transport owners.
            expect(await recordsFor().read(binding.reviewId)).toMatchObject({ reviewId: binding.reviewId,
                rounds: [{ ordinal: 1, state: outcome, runs: [{ kind: 'execution', runId: run.runId }] }] });
            const reloaded = createActionExecutor(createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }));
            expect(await reloaded.execute('review.get', { reviewId: binding.reviewId },
                { surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true }))
                .toMatchObject({ ok: true, result: { review: { reviewId: binding.reviewId, state: outcome,
                    sourceSessionId: session.id, sourceSessionSeq: 7, counts: { total: 0, needsDecision: 0 } } } });
        });
    });

    it.each(['failed', 'cancelled'] as const)('reloads a Workflow %s empty Review after actual coordinator terminal settlement', async outcome => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}' } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const runId = randomUUID();
        const machineId = 'workflow-review-machine';
        const rootRecordId = randomUUID();
        const witness = { mode: 'plain', version: 1, contentKeyFingerprint: null } as const;
        await runWithServerHttpBaseUrl(origin, async () => {
            const recordsFor = () => createReviewRecordPortV1(createAcknowledgedAccountArtifactTransport(
                createCredentialedAccountArtifactStore({ token, encryption: null })));
            const records = recordsFor();
            const reviewRound = await records.start({ reviewId: randomUUID(), title: 'Workflow terminal Review',
                subjectKind: 'repository', sourceKind: 'workflow', reviewerIds: ['reviewer'], startedAt: 1 });
            const definition: WorkflowDefinitionV1 = { version: 1,
                inputs: [{ name: 'reviewRound', valueType: 'json', required: true }], defaults: {},
                blocks: outcome === 'failed'
                    ? [{ kind: 'step', id: 'review', document: { text: 'Review', references: [], attachments: [] }, input: [] }]
                    : [{ kind: 'wait', id: 'review', document: { text: 'Continue', references: [], attachments: [] } }],
            };
            const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'accepted_snapshot', accountId: owner.id, runId }, acceptedSnapshot: {
                    definition, authoredDefinition: definition, startedBy: 'user', workDepth: 0, frozenChildren: {}, metadata: null,
                    inputs: { reviewRound }, machineId, executionTarget: { kind: 'session' },
                    workspaceTarget: { project: { machineId, directory: harness.baseDir, checkoutRootPath: harness.baseDir } },
                    authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
                    materializedLeaves: [{ authoredWorkspace: { kind: 'inherit' }, sourceKey: '$root', blockId: 'review',
                        kind: outcome === 'failed' ? 'step' : 'wait', selection: {}, executionTarget: { kind: 'session' } }],
                    source: { kind: 'inline' }, origin: { kind: 'direct' },
                } }));
            // The canonical fake stores opaque Workflow envelopes/indexes at the
            // remote storage boundary. Review writes below still cross real HTTP/SQL.
            const storage = createWorkflowRunStorageTestkit({ runId, accountId: owner.id, machineId, acceptedEnvelope,
                origin: { kind: 'direct' }, invocationPageSize: 1 });
            const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, purpose: 'checkpoint', accountId: owner.id, runId }, checkpoint: {
                    kind: 'happier.workflow-checkpoint.v1', rootRecordId, nextSequence: '2',
                    frontier: { nextBlockOrdinal: 0, paused: false },
                } }));
            const progress = (recordId: string, sequence: string, parentRecordId: string | null,
                value: Omit<WorkflowProgressEnvelopeV1, 'logicalInvocationRecordId'>) =>
                serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
                    binding: { v: 1, purpose: 'invocation_progress', accountId: owner.id, runId, recordId,
                        sequence, parentRecordId, memberOrdinal: '0', attempt: '0' },
                    progress: { ...value, logicalInvocationRecordId: recordId } }));
            await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, parentAttempt: 0,
                accountCurrentness: witness, checkpointEnvelope, rootInvocation: { id: rootRecordId,
                    contentEnvelope: progress(rootRecordId, '0', null, { kind: 'happier.workflow-progress.v1',
                        invocationPath: { blockId: '$root', scope: [] }, blockKind: 'root', attempt: '0' }) } });
            if (outcome === 'failed') {
                const contentEnvelope = progress('reviewer', '1', rootRecordId, { kind: 'happier.workflow-progress.v1',
                    invocationPath: { blockId: 'review', scope: [] }, blockKind: 'step', attempt: '0',
                    input: { document: { text: 'Review', references: [], attachments: [] }, input: [
                        { reviewRound }, { kind: 'review_session.v1', reviewerId: 'reviewer' }] },
                    // A missing reference is a terminal Workflow input failure; ordinary
                    // access refusals retain the invocation for explicit recovery.
                    reason: { code: 'missing_reference' },
                });
                await storage.execute({ operation: 'invocations.admit', runId, parentAttempt: 0, accountCurrentness: witness,
                    expectedRevision: storage.run().revision, checkpointEnvelope,
                    invocations: [{ id: 'reviewer', sequence: '1', parentRecordId: rootRecordId, memberOrdinal: '0', contentEnvelope }] });
                const admitted = storage.rowById('reviewer')!.index;
                await storage.execute({ operation: 'invocations.fact', runId, invocationId: admitted.id, invocationAttempt: admitted.attempt,
                    expectedLifecycle: admitted.lifecycle, expectedContentRevision: admitted.contentRevision,
                    lifecycle: 'failed', contentEnvelope });
            } else storage.requestControl('cancel_requested');
            const executor = createCliActionExecutor({ token,
                credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
                sessionId: session.id, mode: 'plain', ctx: null, serverId: origin, serverHttpBaseUrl: origin });
            const coordinate = createProductionWorkflowRunCoordinator({ token, accountId: owner.id, machineId, storage,
                workspaceScm: { inspectLocation: async () => ({ inspection: { rootPath: harness.baseDir } }),
                    verifyRecordedWorkspace: async () => 'available' },
                resolveAccountEncryption: async () => ({ kind: 'available', witness }), isAcceptedAuthorizationCurrent: async () => true,
                resolveControllerContext: async () => ({ surface: 'cli', authority: 'present_user' }),
                execution: { credentials: { token, encryption: null }, serverId: origin,
                    machineAdmissionTransport: async () => { throw new Error('Terminal recovery must not admit native input'); },
                    sessionInput: { enqueue: async () => { throw new Error('Terminal recovery must not enqueue input'); },
                        observe: async () => { throw new Error('The persisted terminal invocation needs no conversation read'); } },
                    detachedRun: { actionExecutor: executor,
                        buildActionContext: () => ({ surface: 'cli', authority: 'present_user' }) } },
            });
            const coordinated = await coordinate({ runId, attempt: 0, expectedRevision: storage.run().revision,
                accountCurrentness: witness, acceptedEnvelope });
            expect(coordinated, JSON.stringify(coordinated)).toMatchObject({ state: outcome });
            expect((await recordsFor().read(reviewRound.reviewId))?.rounds)
                .toMatchObject([{ ordinal: 1, state: outcome, runs: [{ kind: 'workflow', runId }],
                    ...(outcome === 'failed' ? { reviewerOutcomes: [{ reviewerId: 'reviewer', outcome: 'failed',
                        reason: { run: 'failed', errorCode: 'missing_reference' } }] } : {}),
                }]);
            expect(await db.reviewComment.count({ where: { reviewId: reviewRound.reviewId } })).toBe(0);
            const reloaded = createActionExecutor(createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }));
            expect(await reloaded.execute('review.get', { reviewId: reviewRound.reviewId },
                { surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true }))
                .toMatchObject({ ok: true, result: { review: { reviewId: reviewRound.reviewId, state: outcome,
                    counts: { total: 0, needsDecision: 0 } } } });
        });
    });

    it.each((['private_default', 'team_default', 'team_required'] as const).flatMap(reviewCreationPolicy =>
        (['engine', 'person'] as const).map(reviewerKind => ({ reviewCreationPolicy, reviewerKind }))))(
        'applies the selected Session Project policy through review.start ($reviewCreationPolicy/$reviewerKind)', async ({ reviewCreationPolicy, reviewerKind }) => {
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
            await makeShareEligibleForTest(owner.id, [outsider.id]);
            const team = await db.team.create({ data: { name: 'Action Review Team', reviewCreationPolicy, externalSharingPolicy: 'disabled' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
            const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
                serverId: origin, requestKey: randomUUID(), name: 'Action Project', owner: { kind: 'team', teamId: team.id }, audience: [],
            }));
            if (!source.ok) throw new Error(source.error);
            const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
            const headers = { authorization: `Bearer ${token}` };
            const workspaceId = randomUUID();
            const machineId = randomUUID();
            const key = { kind: 'workspace-ref', serverId: origin, id: workspaceId };
            const graphKey = { kind: 'relationship-graph' };
            expect((await app.inject({ method: 'POST', url: '/v1/account/project-rows/mutate', headers, payload: {
                mutations: [{ key, expectedRevision: 'absent', content: { t: 'plain', v: { key, value: {
                    id: workspaceId, serverId: origin, machineId, rootPath: harness.baseDir, createdAtMs: 1,
                    source: { sourceId: source.source.id, revision: source.source.revision },
                } } } }, { key: graphKey, expectedRevision: 'absent', content: { t: 'plain', v: { key: graphKey, value: { relationships: [] } } } }],
                expectedRefs: [], topologyChange: true,
            } })).json()).toMatchObject({ status: 'updated' });
            const metadata = { path: harness.baseDir, host: 'fixture', machineId, workspaceId, projectId: workspaceId };
            const ownerMetadata = createSessionOwnerMetadataV1({ metadata });
            if (!ownerMetadata.ok) throw new Error('Expected canonical owner metadata');
            const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: 'plain',
                metadataLayoutVersion: 1, metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
                ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata.ownerMetadata)) } });
            await runWithServerHttpBaseUrl(origin, async () => {
                const credentials = { token, encryption: null };
                const deps = createCliActionDeps({ token, credentials, sessionId: session.id, mode: 'plain', ctx: null,
                    serverId: origin, serverIdentityId: origin, serverHttpBaseUrl: origin });
                const executor = createActionExecutor({
                    ...createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }),
                    sessionStatusGet: deps.sessionStatusGet,
                    projectWorkspaceRefs: deps.projectWorkspaceRefs,
                    reviewRecords: deps.reviewRecords,
                    // Only the external daemon process is substituted; Account/Session reads and Record writes stay real.
                    reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex', enabled: true,
                        capabilities: { structuredNarration: true } }] }),
                    executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: machineId }),
                    executionRunStart: async () => ({ runId: randomUUID(), callId: randomUUID(), sidechainId: randomUUID() }),
                });
                const reviewers = reviewerKind === 'engine' ? [{ kind: 'engine' as const, engineId: 'codex' }]
                    : [{ kind: 'person' as const, principal: { kind: 'account' as const, accountId: owner.id }, required: true }];
                const input = { sessionId: session.id, scope: 'repository' as const, instructions: 'Review the repository.', reviewers };
                const context = {
                    surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true,
                    defaultSessionId: session.id, defaultSessionMachineId: machineId, callerPermissionMode: 'read-only',
                    sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
                    agentStartContext: { caller: { kind: 'session', sessionId: session.id, starterDepth: 0, turnDepth: 0 },
                        baseline: { machineId, directory: harness.baseDir }, roles: {}, ledSubtreeSessionIds: [],
                        workDepthLimit: 4, callerPermissionCeiling: 'read-only' },
                } as const;
                const result = await executor.execute('review.start', input, context);
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
                if (!result.ok) throw new Error(result.error);
                const receipt = readReviewStartActionResultV1(result.result, { reviewers });
                if (receipt.kind !== 'native' || !receipt.reviewRound) throw new Error('Expected the admitted Review');
                const artifactId = receipt.reviewRound.reviewId;
                expect(await db.reviewMetadata.findUnique({ where: { artifactId } })).toMatchObject({ projectSourceId: source.source.id });
                const grants = await db.artifactGrant.findMany({ where: { artifactId } });
                expect(grants).toMatchObject(reviewCreationPolicy === 'private_default' ? [] : [{ teamId: team.id,
                    accessLevel: 'edit', requiredByTeamPolicy: reviewCreationPolicy === 'team_required' }]);
                expect(grants).toHaveLength(reviewCreationPolicy === 'private_default' ? 0 : 1);
                const grant = { actorAccountId: owner.id, artifactId, principal: { kind: 'account' as const, accountId: outsider.id }, accessLevel: 'view' as const };
                expect(await inTx(tx => setArtifactAccessGrantInTx(tx, grant))).toMatchObject({ ok: false, error: 'artifact_access_forbidden' });
                expect(await db.artifactGrant.findMany({ where: { artifactId } })).toEqual(grants);
                expect(await inTx(tx => setTeamPolicyInTx(tx, { actorAccountId: owner.id, teamId: team.id, externalSharingPolicy: 'allowed' }))).toMatchObject({ ok: true });
                expect(await inTx(tx => setArtifactAccessGrantInTx(tx, grant))).toMatchObject({ ok: true });
                if (reviewCreationPolicy === 'team_required' && reviewerKind === 'engine') {
                    // A stamped but inaccessible checkout cannot turn the next Review into a private Record.
                    const missing = createSessionOwnerMetadataV1({ metadata: { ...metadata, workspaceId: randomUUID() } });
                    if (!missing.ok) throw new Error('Expected canonical owner metadata');
                    await db.session.update({ where: { id: session.id }, data: {
                        ownerMetadata: JSON.stringify(createPlainSessionOwnerMetadataEnvelopeV1(missing.ownerMetadata)),
                    } });
                    const before = await db.reviewMetadata.count();
                    expect(await executor.execute('review.start', input, context)).toMatchObject({
                        ok: false, errorCode: 'project_association_unavailable',
                    });
                    expect(await db.reviewMetadata.count()).toBe(before);
                }
            });
        });

    it.each(['plain', 'e2ee'] as const)('reads the admitted aggregate and refuses another Account (%s)', async encryptionMode => {
        const owner = await db.account.create({ data: { encryptionMode } });
        const outsider = await db.account.create({ data: { encryptionMode } });
        const reviewId = randomUUID();
        await db.artifact.create({ data: { id: reviewId, accountId: owner.id,
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array(),
            reviewMetadata: { create: { subjectKind: 'repository', sourceKind: 'direct', state: 'completed',
                currentRoundOrdinal: 1, startedAt: new Date(1000), finishedAt: new Date(2000) } } } });
        const executeFor = async (accountId: string) => {
            const token = await auth.createToken(accountId, undefined, { kind: 'account', authority: 'present_user' });
            return createActionExecutor(createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }))
                .execute('review.get', { reviewId }, { surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true });
        };
        expect(await executeFor(owner.id)).toMatchObject({ ok: true, result: {
            review: { reviewId, currentRoundOrdinal: 1, state: 'completed', counts: { total: 0, needsDecision: 0 } },
            human: { reviewId, roundOrdinal: 1, requests: [], verdicts: [], needsYou: { needsYou: false } },
        } });
        expect(await executeFor(outsider.id)).toMatchObject({ ok: false, errorCode: 'review_not_found' });
    });

    it('reads persisted findings beyond one page and only the current requested-person verdict', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reviewId = randomUUID();
        await db.artifact.create({ data: { id: reviewId, accountId: owner.id,
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array(),
            reviewMetadata: { create: { subjectKind: 'repository', sourceKind: 'workflow', state: 'completed',
                currentRoundOrdinal: 2, startedAt: new Date(1000), finishedAt: new Date(2000) } } } });
        // Persisted boundary fixtures: this read must count roots, independently of body paging and appearances.
        const findings = Array.from({ length: 51 }, (_, index) => {
            const id = randomUUID();
            return { id, accountId: owner.id, reviewId, findingIdentity: `finding-${index}`,
                threadId: id, state: 'open', reviewTriageStatus: index === 50 ? null : 'reject',
                flagsJson: '{}', anchorJson: '{}', snapshotEnvelopeJson: '{}', bodyEnvelopeJson: '{}',
                bodyVersion: 1, authorJson: '{}', editsJson: '[]', dispositionsJson: '{}', transitionsJson: '[]',
                serverRevision: 1, createdAt: BigInt(index), updatedAt: BigInt(index) };
        });
        await db.reviewComment.createMany({ data: findings });
        const pending = findings[50]!;
        await db.reviewCommentAppearance.createMany({ data: ['first', 'second'].map(reviewerId => ({
            reviewId, commentId: pending.id, roundOrdinal: 2, runId: 'review-run', reviewerId, sourceKey: reviewerId,
        })) });
        await db.reviewRequestedReviewer.create({ data: { reviewId, roundOrdinal: 2,
            principalKey: `account:${owner.id}`, principal: { kind: 'account', accountId: owner.id }, required: true,
            eligibleAccounts: { create: { accountId: owner.id } } } });
        await db.reviewVerdict.create({ data: { reviewId, roundOrdinal: 1, accountId: owner.id, verdict: 'approve' } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const executor = createActionExecutor(createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }));
        const read = () => executor.execute('review.get', { reviewId },
            { surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true });
        expect(await read()).toMatchObject({ ok: true, result: {
            review: { state: 'completed', currentRoundOrdinal: 2, counts: { total: 51, needsDecision: 1 } },
            human: { roundOrdinal: 2, requests: [{ required: true, roundOrdinal: 2 }],
                verdicts: [{ roundOrdinal: 1, verdict: 'approve' }], needsYou: { requestedVerdict: true, needsYou: true } },
        } });
        await db.reviewVerdict.create({ data: { reviewId, roundOrdinal: 2, accountId: owner.id, verdict: 'request_changes' } });
        await db.reviewComment.update({ where: { id: pending.id }, data: { reviewTriageStatus: 'reject' } });
        expect(await read()).toMatchObject({ ok: true, result: {
            review: { state: 'completed', counts: { total: 51, needsDecision: 0 } },
            human: { verdicts: [{ roundOrdinal: 1, verdict: 'approve' }, { roundOrdinal: 2, verdict: 'request_changes' }],
                needsYou: { requestedVerdict: false, needsYou: false } },
        } });
    });

    it.each(['plain', 'e2ee'] as const)('reads only the caller’s demanded metadata page and authorized history (%s)', async encryptionMode => {
        const owner = await db.account.create({ data: { encryptionMode } });
        const outsider = await db.account.create({ data: { encryptionMode } });
        const workflowId = randomUUID();
        const make = async (accountId: string, sequence: number) => {
            const id = randomUUID();
            const at = new Date(sequence * 1000);
            await db.artifact.create({ data: { id, accountId, header: new Uint8Array(), body: new Uint8Array(),
                dataEncryptionKey: new Uint8Array(), createdAt: at, updatedAt: at } });
            await db.reviewMetadata.create({ data: { artifactId: id, workflowId, subjectKind: 'repository',
                sourceKind: 'workflow', state: 'completed', currentRoundOrdinal: 1, startedAt: at } });
            return id;
        };
        const previous = await make(owner.id, 1);
        const current = await make(owner.id, 2);
        const hidden = await make(outsider.id, 3);
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const executor = createActionExecutor(createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }));
        const context = { surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true } as const;
        const first = await executor.execute('reviews.list', { limit: 1, workflowId }, context);
        expect(first, JSON.stringify(first)).toMatchObject({ ok: true, result: { items: [{ reviewId: current, counts: { total: 0, needsDecision: 0 } }], cursor: expect.any(String) } });
        if (!first.ok) throw new Error('Expected owner read');
        const page = ReviewListResponseV1Schema.parse(first.result);
        expect(page.items).toHaveLength(1);
        const second = await executor.execute('reviews.list', { limit: 1, workflowId, cursor: page.cursor }, context);
        expect(second).toMatchObject({ ok: true, result: { items: [{ reviewId: previous }], cursor: null } });
        expect(await executor.execute('review.history.list', { workflowId, reviewId: current }, context))
            .toMatchObject({ ok: true, result: { previousReviewId: previous, items: [] } });
        expect(await executor.execute('review.history.list', { workflowId, reviewId: hidden }, context))
            .toMatchObject({ ok: true, result: { previousReviewId: null, items: [] } });
        const unauthenticated = await app.inject({ method: 'POST', url: '/v1/reviews/list', payload: { limit: 1 } });
        expect(unauthenticated.statusCode).toBe(401);
        const invalid = await app.inject({ method: 'POST', url: '/v1/reviews/list', headers: { authorization: `Bearer ${token}` },
            payload: { limit: 1, actorAccountId: outsider.id } });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json()).toEqual({ error: 'review_comment_invalid_request' });
    });
});

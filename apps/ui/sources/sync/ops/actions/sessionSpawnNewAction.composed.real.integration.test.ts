import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { basename, delimiter, join } from 'node:path';
import { spawn, ChildProcess, type SpawnOptions } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { io } from 'socket.io-client';
import { Server as SocketIoServer, type Socket as SocketIoSocket } from 'socket.io';
import Fastify from 'fastify';
import axios from 'axios';
import type { Fastify as AppFastify } from '../../../../../server/sources/app/api/types';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, ExternalActionDaemonDispatchRequestSchema,
    ExternalActionExecutionAuthorizationRequestV1Schema,
    ExternalActionRequestEnvelopeV1Schema,
    computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { projectSessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { readSessionSpawnNewActionResultV1, SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import { decodeBase64} from '@happier-dev/protocol/crypto/base64';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER} from '@happier-dev/protocol/machines/machineStoredContent';
import {
    signMachineInstallationProof} from '@happier-dev/protocol/machines/identity/installationIdentity';
import { SessionSpawnNewInputV2Schema} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewResultV1Schema} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import {
    MachineOperationProtocolCapabilitiesV1Schema} from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { SessionTurnsProjectionV1Schema} from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import {
    SessionTurnMutationActionV1Schema, SessionTurnMutationDecisionV1Schema, SessionTurnMutationV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1 } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2 } from '@happier-dev/protocol/sessions/messages/sessionPendingExecutionRunMachineAdmissionV2';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler, RpcHandlerRegistrar } from '../../../../../cli/src/api/rpc/types';
import type { VerifyExternalActionExecutionAuthorization } from '../../../../../cli/src/daemon/externalActions/executeExternalAction';
import type { PluginTargetActivationFact } from '../../../../../cli/src/plugins/runtime/lifecycle/activation/facts';
import { ApiClient } from '../../../../../cli/src/api/api';
import type { ApiMachineClient } from '../../../../../cli/src/api/apiMachine';
import { commitDaemonLaunchSession } from '../../../../../cli/src/daemon/spawn/commitDaemonLaunchSession';
import { projectSessionSpawnFailure } from '../../../../../cli/src/session/creation/projectSessionSpawnFailure';
import { createSessionAttachFile } from '../../../../../cli/src/daemon/sessionAttachFile';
import { createBaseSessionForAttach } from '../../../../../cli/src/agent/runtime/createBaseSessionForAttach';
import { createInitialHostRuntimeActivityMutation } from '../../../../../cli/src/agent/runtime/session/activity/createHostRuntimeActivityProjection';
import { ApiSessionClient } from '../../../../../cli/src/api/session/sessionClient';
import { createTestApiSessionClient } from '../../../../../cli/src/testkit/backends/createTestApiSessionClient';
import { createAccountSessionClientTransport } from '../../../../../cli/src/api/client/createAccountSessionClientTransport';
import { readCredentials, updateSettings, writeCredentialsTokenOnly, writeDaemonState, type StoredCredentials } from '../../../../../cli/src/persistence';
import { logger } from '../../../../../cli/src/ui/logger';
import { configuration } from '../../../../../cli/src/configuration';
import { readInstallationIdentityIfExistsSync } from '../../../../../cli/src/daemon/identity/store';
import { isCanonicalAbsolutePathInsideRoot } from '../../../../../cli/src/utils/path/expandHomeDirPath';
import { createRequesterSessionRuntimeContext } from '../../../../../cli/src/daemon/sessionEncryption/createRequesterSessionRuntimeContext';
import type { TrackedSession } from '../../../../../cli/src/daemon/types';
import { createOnHappySessionWebhook } from '../../../../../cli/src/daemon/sessions/onHappySessionWebhook';
import { createAgentSessionRunnerFactoryBinding } from '../../../../../cli/src/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority } from '../../../../../cli/src/daemon/agentRuntime/sessionBridgeAuthorization';
import { openCurrentRunnerTeamCredentialProviderBinding } from '../../../../../cli/src/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient';
import { classifyPrimarySessionRuntimeIssue } from '../../../../../cli/src/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { awaitTrackedRunnerAgentSessionOpen, recordTrackedRunnerAgentSessionOpenAttestation } from '../../../../../cli/src/daemon/agentRuntime/runnerAgentSessionOpenAttestation';
import { resolveSessionRunnerEntrypointIdentityFromProcessCommand } from '../../../../../cli/src/daemon/sessionRunnerRuntime/resolveRunnerEntrypointIdentity';
import { hashProcessCommand, writeSessionMarker } from '../../../../../cli/src/daemon/sessionRegistry';
import { readProcessIdentityByPid } from '../../../../../cli/src/daemon/processIdentity';
import * as processIdentityBoundary from '../../../../../cli/src/daemon/processIdentity';
import { readOrCreateDeviceLocalSecretStorage } from '../../../../../cli/src/daemon/deviceLocalSecretStorage';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '../../../../../cli/src/plugins/testkit/admittedRuntime';
import { startInProcessAgentSessionRunner } from '../../../../../cli/src/testkit/backends/inProcessAgentSessionRunner';
import { bootstrapAccountSettingsContext } from '../../../../../cli/src/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveSessionStartAccountSettingsContext } from '../../../../../cli/src/settings/accountSettings/resolveSessionStartAccountSettingsContext';
import { createCliPromptLibraryStore } from '../../../../../cli/src/settings/prompts/promptLibraryStore';
import { refreshActivePromptLibraryCatalogAfterChange } from '../../../../../cli/src/settings/prompts/hydratePromptLibraryCatalog';
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '../../../../../cli/src/settings/accountSettings/activeAccountSettingsSnapshot';
import { PromptLibraryRecordV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { readPromptLibraryCatalogRecordV1, type PromptLibraryCatalogSnapshotV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { buildPluginSessionBindingInput } from '../../../../../cli/src/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY } from '../../../../../cli/src/daemon/agentRuntime/sessionBridgeAuthorization';
import { buildHappyCliSubprocessLaunchSpec, resolveTsxImportHookPath } from '../../../../../cli/src/utils/spawnHappyCLI';
import { partitionProviderSessionArgs } from '../../../../../cli/src/cli/providerSessionArgPartition';
import { pluginReloadController } from '../../../../../cli/src/plugins/runtime/reload/singleton';
import { readRequesterSessionCredentialsForChild, REQUESTER_SESSION_ID_ENV, bindRequesterSessionRuntimeMachineAdmissionCurrentness, type RequesterSessionRuntimeContext } from '../../../../../cli/src/daemon/sessionEncryption/requesterSessionCredentials';
import { AgentRuntimeRunnerBootstrapV1Schema, HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY } from '../../../../../cli/src/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { resolveSessionStartupTimeoutMs } from '../../../../../cli/src/daemon/spawn/waitForSessionWebhook';
import { DEFAULT_SESSION_SPAWN_OPERATION_TIMEOUT_MS } from '@happier-dev/protocol/sessions/creation/sessionSpawnBudget';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { createSessionTurnLifecycle } from '../../../../../cli/src/agent/runtime/session/turn/lifecycle';
import { projectRuntimeTranscriptEvent } from '../../../../../cli/src/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { UserMessageSchema } from '../../../../../cli/src/api/types';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { runWithServerHttpBaseUrl } from '../../../../../cli/src/api/client/serverHttpBaseUrl';
import { registerExternalActionRpcHandler } from '../../../../../cli/src/rpc/handlers/externalAction';
import { registerWorkflowRunStorageRoutes } from '../../../../../server/sources/app/api/routes/automations/registerWorkflowRunStorageRoutes';
import { createMachineSessionDirectTargetTransport } from '../../../../../cli/src/rpc/handlers/sessionServerStartLifecycleAdapter';
import { createSpawnNewSessionLifecycleActionHandler } from '../../../../../cli/src/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler';
import { createRequesterSessionControlRuntimeFixture } from '../../../../../cli/src/daemon/testkit/requesterSessionControlRuntimeFixture';
import { installDaemonMachineAdmissionTransport } from '../../../../../cli/src/daemon/machineAdmissionTransport';
import { ConnectedServiceRuntimeRegistry } from '../../../../../cli/src/daemon/connectedServices/runtimeRegistry/registry';
import { createTestMetadata } from '../../../../../cli/src/testkit/backends/sessionMetadata';
import { seedTestServerProfile } from '../../../../../cli/src/testkit/serverProfiles';
import { resolveServerProfileHomeIdentityId } from '../../../../../cli/src/server/serverProfiles';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { enableSchemaValidation } from '../../../../../server/sources/app/api/utils/enableSchemaValidation';
import { enableErrorHandlers } from '../../../../../server/sources/app/api/utils/enableErrorHandlers';
import { enableAuthentication } from '../../../../../server/sources/app/api/utils/enableAuthentication';
import { enableMonitoring } from '../../../../../server/sources/app/api/utils/enableMonitoring';
import { enableOptionalStatics } from '../../../../../server/sources/app/api/utils/enableOptionalStatics';
import { registerAuthPingRoute } from '../../../../../server/sources/app/api/routes/auth/registerAuthPingRoute';
import { registerAccountApiTokenManagementRoutes } from '../../../../../server/sources/app/api/routes/auth/registerAccountApiTokenManagementRoutes';
import { registerAccountSecurityRoutes } from '../../../../../server/sources/app/api/routes/auth/registerAccountSecurityRoutes';
import { currentAccountStoredContentCompatibilitySocketAuth } from '../../../../../server/sources/app/api/testkit/accountStoredContentCompatibility';
import { auth } from '../../../../../server/sources/app/auth/auth';
import { db } from '../../../../../server/sources/storage/db';
import { getOrCreateServerIdentityId, initializeServerIdentityCache } from '../../../../../server/sources/app/serverIdentity/serverIdentity';
import { createCurrentMachineExecutionOriginContextResolver } from '../../../../../cli/src/api/machine/resolveCurrentMachineExecutionOriginContext';
import { isOriginalAccountExecutionAction } from '../../../../../server/sources/app/auth/externalActionExecutionAuthorization';
import { resolveMachineAdmission } from '../../../../../server/sources/app/machines/machineAccess';
import { accountRoutes } from '../../../../../server/sources/app/api/routes/account/accountRoutes';
import { changesRoutes } from '../../../../../server/sources/app/api/routes/changes/changesRoutes';
import { registerPluginAvailabilityRoutes } from '../../../../../server/sources/app/plugins/availability/routes';
import { sessionRoutes } from '../../../../../server/sources/app/api/routes/session/sessionRoutes';
import { sessionPendingRoutes } from '../../../../../server/sources/app/api/routes/session/pendingRoutes';
import { accessKeysRoutes } from '../../../../../server/sources/app/api/routes/accessKeys/accessKeysRoutes';
import { machinesRoutes } from '../../../../../server/sources/app/api/routes/machines/machinesRoutes';
import { registerExternalActionRoutes } from '../../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes';
import { featuresRoutes } from '../../../../../server/sources/app/api/routes/features/featuresRoutes';
import { artifactsRoutes } from '../../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import { createCredentialedAccountArtifactStore } from '../../../../../cli/src/api/artifacts/accountArtifactStore';
import { readSessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';
import { PromptDocArtifactHeaderV1Schema, PromptDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptDocV2';
import { startSocket } from '../../../../../server/sources/app/api/socket';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { TokenStorage, type HomeCredentialWriteRollback } from '@/auth/storage/tokenStorage';
import { removeServerProfile, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import { buildManualSessionCreationKey, executeSessionSpawnNewAction, executeManualSessionSpawnNewAction } from './sessionSpawnNewAction';
import { resolveSessionSpawnNewResultFailureMessageKey, resolveSessionSpawnNewResultFailureMessage } from './sessionSpawnFailurePresentation';
import { createSessionDraftRepository } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { readNewSessionAttachmentDrafts, writeNewSessionAttachmentDrafts, clearNewSessionAttachmentDrafts } from '@/components/sessions/new/attachments/newSessionAttachmentDraftStore';
import { readSpawnAttemptCustodyState } from '@/sync/domains/session/spawn/spawnAttemptNonceStore';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { SpawnCapabilitiesPreviewOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { EPHEMERAL_RUNNER_UNMATERIALIZED_MACHINE_ID_V1 } from '@happier-dev/protocol/ephemeralRunner/runnerMcpMaterial';
import { McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { writeMcpServerCatalogInContext } from '@/sync/api/account/apiMcpServerCatalog';
import { writePromptLibraryRecordInContext } from '@/sync/api/account/apiPromptLibraryCatalog';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { createSessionSpawnConversationFixture } from './sessionSpawnConversation.testkit';
import { buildNewSessionAuthoringDraftFromResolvedInputs, buildSessionSpawnNewInputV2FromAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { createHiddenVoiceStartCanary } from '@/dev/testkit/harness/hiddenVoiceStartCanary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { resetServerFeaturesClientForTests } from '../../../../../cli/src/features/serverFeaturesClient';
import { registerDeploymentRoutes } from '../../../../../server/sources/app/api/routes/deployments/deploymentRoutes';

// The two requester-custody slices omit a physical control listener. The full
// retained-runner case serves the actual daemon HTTP routes on an ephemeral port.
const composedControl = vi.hoisted(() => ({ real: false, port: 0, token: '' }));
vi.mock('../../../../../cli/src/daemon/controlServer', () => ({
    startDaemonControlServer: async (...args: Parameters<typeof import('../../../../../cli/src/daemon/controlServer')['startDaemonControlServer']>) => {
        if (!composedControl.real) return { port: 44322, stop: async () => {} };
        // The real listener imports SessionHostBridge too. Load it only after
        // collection settles, rather than self-waiting in an async mock factory.
        const actual = await vi.importActual<typeof import('../../../../../cli/src/daemon/controlServer')>(
            '../../../../../cli/src/daemon/controlServer');
        const control = await actual.startDaemonControlServer(...args);
        composedControl.port = control.port;
        composedControl.token = args[0].controlToken;
        return control;
    },
}));
const physicalRunner = vi.hoisted(() => ({ launch: null as null | ((args: string[], options: SpawnOptions) => ChildProcess) }));

describe('Account currentness through the real API creation and UI sink owners', () => {
    it.for([
        { reason: 'timeout', retryable: true },
        { reason: 'invalid_response', retryable: false },
    ] as const)('keeps Account currentness $reason at the actual UI spawn refusal sink', async failure => {
        // Currentness refuses before a Session POST. Its canonical API owner
        // needs neither a database nor an authenticated Home fixture to prove it.
        const endpoint = 'https://currentness-canary.invalid';
        resetServerFeaturesClientForTests();
        onTestFinished(resetServerFeaturesClientForTests);
        const originalFetch = globalThis.fetch.bind(globalThis);
        const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            if (String(input) === `${endpoint}/v1/features`) return Response.json(createRootLayoutFeaturesResponse({
                capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } },
            }));
            return await originalFetch(input, init);
        });
        const originalGet = axios.get.bind(axios);
        let currentnessReads = 0;
        // Only external HTTP is substituted. API creation, typed daemon
        // refusal, strict Action projection and the UI presenter remain real.
        const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            if (url === `${endpoint}/v1/account/encryption/currentness`) {
                currentnessReads += 1;
                if (failure.reason === 'timeout') throw Object.assign(new Error('Currentness read timed out'), { code: 'ECONNABORTED' });
                return { status: 200, data: {}, statusText: 'OK', headers: {}, config: { headers: new axios.AxiosHeaders() } };
            }
            return await originalGet(url, config);
        });
        const post = vi.spyOn(axios, 'post');
        onTestFinished(() => { network.mockRestore(); get.mockRestore(); post.mockRestore(); });
        const credentials = { token: '', encryption: null };
        const directory = process.cwd();
        const committed = await runWithServerHttpBaseUrl(endpoint, () => commitDaemonLaunchSession({
            api: new ApiClient(credentials), credentials, options: { directory }, directory, accountSettings: {},
        }));
        expect(committed).toMatchObject({ ok: false, result: { type: 'error', errorCode: 'SPAWN_FAILED', errorDetail: {
            kind: 'session_creation_currentness_unavailable', code: 'currentness_unavailable',
            reason: failure.reason, retryable: failure.retryable,
        } } });
        if (committed.ok) throw new Error('Currentness refusal unexpectedly created a Session');
        const result = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure(committed.result));
        expect(result).toMatchObject({ type: 'error', code: 'spawn_failed', retryable: failure.retryable,
            launchError: { code: 'currentness_unavailable', currentnessFailure: {
                reason: failure.reason, retryable: failure.retryable,
            } } });
        expect(currentnessReads).toBe(1);
        const sessionPosts = post.mock.calls.filter(([url]) => url === `${endpoint}/v1/sessions`).length;
        expect(sessionPosts).toBe(0);
        if (result.type !== 'error') throw new Error('Currentness failure did not settle');
        // The safe originating reason must reach the person, but its exact
        // localization or raw spelling is not this canary's copy contract.
        const generic = SessionSpawnNewResultV1Schema.parse({ type: 'error', code: 'spawn_failed', retryable: result.retryable });
        if (generic.type !== 'error') throw new Error('Invalid generic refusal control');
        expect(resolveSessionSpawnNewResultFailureMessage(result))
            .not.toBe(resolveSessionSpawnNewResultFailureMessage(generic));
        expect(currentnessReads).toBe(1);
        console.info('SESSIONOPEN currentness typed sink verified', JSON.stringify({
            code: result.launchError?.code, reason: failure.reason, retryable: result.retryable,
            currentnessReads, currentnessRePolls: currentnessReads - 1, sessionPosts,
        }));
    });
});

describe('shared Machine spawn through the real UI, Home, daemon and SQLite owners', () => {
    let database: LightSqliteHarness;
    let app: AppFastify;
    let endpoint: string;
    let unavailableArtifactId: string | null = null;
    let unavailableArtifactReads = 0;
    let requiredAccountArtifactId: string | null = null;
    let requiredAccountArtifactReads = 0;
    let onRequiredAccountArtifactResponse: (() => void) | null = null;
    const sourceRuntimeFixtures: Array<Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>> = [];
    beforeAll(async () => {
        database = await createLightSqliteHarness({ tempDirPrefix: 'happier-r35-shared-spawn-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
        if (!await initializeServerIdentityCache()) throw new Error('Fixture Home identity did not initialize');
        // Each slice uses the same real Home and transport route.
        app = Fastify({ logger: false }) as unknown as AppFastify;
        app.addHook('onRequest', async (request, reply) => {
            if (requiredAccountArtifactId && request.method === 'GET'
                && request.url.split('?')[0] === `/v1/artifacts/${requiredAccountArtifactId}`) {
                requiredAccountArtifactReads += 1;
            }
            if (unavailableArtifactId && request.method === 'GET'
                && request.url.split('?')[0] === `/v1/artifacts/${unavailableArtifactId}`) {
                unavailableArtifactReads += 1;
                return await reply.code(503).send({ error: 'fixture_artifact_transport_unavailable' });
            }
        });
        app.addHook('onSend', async (request, reply, payload) => {
            if (requiredAccountArtifactId && request.method === 'GET' && reply.statusCode === 200
                && request.url.split('?')[0] === `/v1/artifacts/${requiredAccountArtifactId}`) {
                onRequiredAccountArtifactResponse?.();
            }
            if (request.method === 'POST' && /^\/v1\/sessions\/[^/]+\/turns\/mutations$/.test(request.url)) {
                const action = request.body && typeof request.body === 'object' ? Reflect.get(request.body, 'action') : null;
                const anchors = request.body && typeof request.body === 'object' ? Reflect.get(request.body, 'transcriptAnchors') : null;
                let response: unknown = null;
                try { if (typeof payload === 'string') response = JSON.parse(payload); } catch { /* Observation cannot change the response. */ }
                const code = response && typeof response === 'object' ? Reflect.get(response, 'code') : null;
                const applied = response && typeof response === 'object' ? Reflect.get(response, 'applied') : null;
                const receipt = response && typeof response === 'object' ? Reflect.get(response, 'receipt') : null;
                const decision = receipt && typeof receipt === 'object' ? Reflect.get(receipt, 'decision') : null;
                const observedAction = SessionTurnMutationActionV1Schema.safeParse(action);
                const observedDecision = SessionTurnMutationDecisionV1Schema.safeParse(decision);
                const observedMutation = SessionTurnMutationV1Schema.safeParse(request.body);
                console.info('SESSIONOPEN actual turn mutation outcome', JSON.stringify({
                    action: observedAction.success ? observedAction.data : null, statusCode: reply.statusCode,
                    code: typeof code === 'string' ? code : null,
                    applied: typeof applied === 'boolean' ? applied : null,
                    decision: observedDecision.success ? observedDecision.data : null,
                    hasStart: Boolean(anchors && typeof anchors === 'object' && typeof Reflect.get(anchors, 'startSeqInclusive') === 'number'),
                    hasEnd: Boolean(anchors && typeof anchors === 'object' && typeof Reflect.get(anchors, 'endSeqInclusive') === 'number'),
                    hasFinal: Boolean(anchors && typeof anchors === 'object' && typeof Reflect.get(anchors, 'finalAssistantMessageSeq') === 'number'),
                    schemaIssues: observedMutation.success ? [] : observedMutation.error.issues.map(issue => ({
                        code: issue.code, path: issue.path, message: issue.message,
                    })),
                }));
            }
            return payload;
        });
        enableSchemaValidation(app);
        enableErrorHandlers(app);
        enableAuthentication(app);
        enableMonitoring(app);
        enableOptionalStatics(app);
        registerAuthPingRoute(app);
        registerAccountApiTokenManagementRoutes(app);
        registerAccountSecurityRoutes(app);
        accountRoutes(app);
        changesRoutes(app);
        registerPluginAvailabilityRoutes(app);
        featuresRoutes(app);
        artifactsRoutes(app);
        sessionRoutes(app);
        sessionPendingRoutes(app);
        accessKeysRoutes(app);
        machinesRoutes(app);
        startSocket(app);
        registerExternalActionRoutes(app);
        registerWorkflowRunStorageRoutes(app);
        registerDeploymentRoutes(app);
        endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    }, 180_000);
    afterAll(async () => {
        // These fixtures share the actual process-wide controller. Release
        // every suite lease before its owning fixture shuts that controller down.
        await Promise.all(sourceRuntimeFixtures.map(fixture => fixture.lease.release()));
        for (const fixture of sourceRuntimeFixtures) await fixture.dispose();
        // Socket.IO attaches its own listener to this test-owned HTTP server.
        // Production closes it via process shutdown, not Fastify's onClose.
        const sockets = app?.machineDaemonPresence;
        if (sockets instanceof SocketIoServer) await sockets.close();
        await app?.close();
        if (database) await database.close();
    });

    it('keeps approved deployment logs agent-safe across real UI and CLI Account HTTP daemon hops', async () => {
        const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
        const { ApprovalRequestV2Schema } = await import('@happier-dev/protocol/approvals/approvalRequestV1');
        const { buildActionExecuteResultFromRecordedApprovalExecution } = await import('@happier-dev/protocol/actions/actionExecutor');
        const { createCliApprovalsArtifactStore } = await import('../../../../../cli/src/session/actions/approvals/artifactStore');
        const { createCliActionExecutorFromCredentials } = await import('../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials');
        const { writeStoredCredentialsForServerId, readStoredCredentialsForServerId } = await import('../../../../../cli/src/persistence');
        const { DeploymentEnvironmentGetResultV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
        const { createProjectSourceInTx } = await import('../../../../../server/sources/app/projects/sources/projectSourceService');
        const { inTx } = await import('../../../../../server/sources/storage/inTx');
        const { createOwnServerDockerBoundary } = await import('../../../../../cli/src/deployments/targets/ownServer/ownServerDeployment.testkit');
        const { resolveOwnServerDeploymentIdentityForHost, resolveDeploymentSourcePathForHost } = await import('../../../../../cli/src/deployments/targets/ownServer/paths');
        const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'deployments.logs.read': { approvalRequiredSurfaces: ['agent'] },
        } });
        const owner = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 1,
            settings: JSON.stringify({ t: 'plain', v: { actionsSettingsV1: actionsSettings } }) } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const terminalToken = await auth.createToken(owner.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const homeId = await getOrCreateServerIdentityId();
        const daemonHome = join(database.baseDir, 'deployment-replay-daemon');
        // The daemon and terminal consume persistence-produced sign-in custody;
        // the browser retains its independent Account credential.
        let terminalCredentials: StoredCredentials;
        const previousServersDir = configuration.serversDir;
        try {
            configuration.serversDir = join(daemonHome, 'servers');
            await writeStoredCredentialsForServerId(homeId, { token: terminalToken, encryption: null });
            const stored = await readStoredCredentialsForServerId(homeId);
            if (!stored) throw new Error('Missing persisted terminal credentials');
            terminalCredentials = stored;
        } finally { configuration.serversDir = previousServersDir; }
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, active: true,
            metadata: encodePlainMachineStoredContent({ host: 'deployment-replay', platform: 'linux', happyCliVersion: '0.3',
                homeDir: daemonHome, happyHomeDir: daemonHome }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({ externalActionExecutionAuthorization: { protocolVersions: [1] } }) } });
        let apiMachine: ApiMachineClient | null = null;
        const daemon = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: daemonHome,
            activeServerDir: join(daemonHome, 'servers', homeId), serverId: homeId, serverHttpBaseUrl: endpoint,
            machineId: machine.id, custodianAccountId: owner.id, credentials: terminalCredentials,
            connectedServicesMaterializationBaseDir: join(daemonHome, 'connected-services'),
            registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: new Map(), getRequester: () => null,
            getApiMachineForSessions: () => apiMachine, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
            beforeStartup: async () => {
                await seedTestServerProfile({ id: homeId, homeId, serverUrl: endpoint });
                const runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: daemonHome,
                    controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
                sourceRuntimeFixtures.push(runtime);
            }, startup: { resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
                serverUrl: endpoint, resolveCurrentMachineId: () => machine.id,
            }) },
        });
        onTestFinished(daemon.dispose);
        if (!daemon.installation || !daemon.runtime.externalActionIngressOwner) throw new Error('Missing installed deployment ingress');
        const installation = daemon.installation;
        await db.machine.update({ where: { id: machine.id }, data: { installationId: installation.installationId,
            installationPublicKey: new Uint8Array(decodeBase64(installation.publicKey, 'base64url')) } });
        await mkdir(configuration.activeServerDir, { recursive: true });
        await updateSettings(settings => ({ ...settings, machineIdByServerId: { ...settings.machineIdByServerId, [homeId]: machine.id },
            machineIdByServerIdByAccountId: { ...settings.machineIdByServerIdByAccountId, [homeId]: { [owner.id]: machine.id } },
            lastTokenSubByServerId: { ...settings.lastTokenSubByServerId, [homeId]: owner.id } }));
        const api = await runWithServerHttpBaseUrl(endpoint, () => ApiClient.create(terminalCredentials));
        const published = await runWithServerHttpBaseUrl(endpoint, () => api.getMachine(machine.id));
        if (!published) throw new Error('Missing installed Machine');
        apiMachine = await runWithServerHttpBaseUrl(endpoint, () => api.machineSyncClient(published));
        const installed = apiMachine;
        installed.setRPCHandlers({ spawnSession: daemon.runtime.spawnSession, stopSession: daemon.runtime.stopSession,
            requestShutdown: () => { throw new Error('Unexpected shutdown'); } },
        { externalActionIngressOwner: daemon.runtime.externalActionIngressOwner });
        onTestFinished(installed.onConnectedServicesProjection(daemon.runtime.reconcileConnectedServicesProjection));
        onTestFinished(async () => { await installed.shutdown(); });
        const daemonLogAuthorities: string[] = [];
        const serverSocket = app.machineDaemonPresence;
        if (!(serverSocket instanceof SocketIoServer)) throw new Error('Missing real Machine socket server');
        const observeMachine = (socket: SocketIoSocket) => {
            if (socket.handshake.auth.machineId !== machine.id) return;
            socket.onAnyOutgoing((event: string, packet: unknown) => {
                if (event !== SOCKET_RPC_EVENTS.REQUEST || !packet || typeof packet !== 'object'
                    || Reflect.get(packet, 'method') !== `${machine.id}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`) return;
                const carried = ExternalActionDaemonDispatchRequestSchema.parse(Reflect.get(packet, 'params'));
                if (carried.actionId === 'deployments.logs.read') daemonLogAuthorities.push(carried.principal.authority);
            });
        };
        serverSocket.on('connection', observeMachine);
        onTestFinished(() => { serverSocket.off('connection', observeMachine); });
        await new Promise<void>((resolve, reject) => {
            void Promise.resolve(runWithServerHttpBaseUrl(endpoint, () => installed.connect({ onConnect: resolve }))).catch(reject);
        });
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: endpoint, accountId: owner.id,
            serverIdentityId: homeId, currentAccount: true, credentials: { token } }],
            route: async request => fetch(request.url, { method: request.method, headers: request.headers,
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }), signal: request.signal }) });
        onTestFinished(() => homes.dispose());
        setRuntimeFetch((input, init) => fetch(input, init));
        const serverId = homes.homes.home!.id;
        const account = await captureLazyActionAccountContext(serverId);
        onTestFinished(() => account.dispose());
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId: homeId,
            requestKey: crypto.randomUUID(), name: 'Runtime log approval', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const content = async (kind: string) => {
            const artifact = await account.createArtifactDocument({ header: { kind, title: 'Runtime log approval' }, body: '{}' });
            return { contentArtifactId: artifact.artifactId, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, controllerMachineId: machine.id, protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', ...await content('deployment-environment.v1') } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'deployed', ...await content('deployment-target-link.v1') } });
        await db.deploymentTargetLinkMachine.create({ data: { targetLinkId: link.id, machineId: machine.id,
            installationId: installation.installationId, position: 0, state: 'active' } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
        const deployment = await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: link.id,
            operation: 'deploy', state: 'succeeded', requestKey: crypto.randomUUID(), requestedByAccountId: owner.id,
            actionOperationId: crypto.randomUUID(), ...await content('deployment-receipt.v1') } });
        const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: daemonHome,
            serverId: homeId, environmentId: environment.id });
        const release = resolveDeploymentSourcePathForHost({ ...identity, deploymentId: deployment.id });
        await mkdir(release, { recursive: true });
        const docker = await createOwnServerDockerBoundary(join(daemonHome, 'tools'));
        const oldPath = process.env.PATH;
        process.env.PATH = `${join(daemonHome, 'tools')}${delimiter}${oldPath ?? ''}`;
        onTestFinished(() => { process.env.PATH = oldPath; });
        const image = await docker.registerImage('web', 'retained-generation');
        const sentinel = 'approval-hop-original-secret-83614';
        const compose = join(release, 'compose.yaml');
        // Simulate only the external Docker state surviving daemon restart.
        // All selection, authority, HTTP, RPC, native log and Artifact owners are real.
        await writeFile(compose, JSON.stringify({ services: { web: { image: image.registryReference,
            pull_policy: 'never', environment: { SECRET: sentinel, PORT: '3000' } } } }));
        await new Promise<void>((resolve, reject) => {
            const child = spawn(docker.executablePath, ['compose', '--project-name', identity.projectName,
                '--project-directory', release, '--file', compose, 'up', '--detach', '--no-build', '--pull', 'never'], { stdio: 'pipe' });
            child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Docker fixture activation failed')));
        });
        await docker.emitRuntimeLogFromEnvironment('web', 'SECRET');
        const metadataResponse = await account.request(`/v1/deployments/environments/${environment.id}?serverId=${encodeURIComponent(homeId)}`);
        const metadata = DeploymentEnvironmentGetResultV1Schema.parse(await metadataResponse.json());
        if (!metadata.ok) throw new Error(metadata.error);
        const input = { serverId: metadata.environment.serverId, environmentId: environment.id, targetLinkId: link.id, deploymentId: deployment.id,
            machineId: machine.id, installationId: installation.installationId, kind: 'runtime' as const,
            service: { kind: 'deployment' as const, machineId: machine.id, environmentId: environment.id,
                environmentInstanceId: identity.environmentInstanceId, serviceId: `${identity.environmentInstanceId}/web`, composeService: 'web' } };
        const ui = createDefaultActionExecutor();
        const person = await ui.execute('deployments.logs.read', input, { surface: 'ui', authority: 'present_user',
            actionCaller: { kind: 'host' }, serverId, actionRequestId: crypto.randomUUID() });
        expect(person, JSON.stringify(person)).toMatchObject({ ok: true });
        expect(JSON.stringify(person)).toContain('secret masking may be incomplete until the next deploy');
        expect(daemonLogAuthorities).toEqual(['present_user']);
        const approvals = createCliApprovalsArtifactStore({ credentials: { token, encryption: null }, serverId: homeId, serverHttpBaseUrl: endpoint });
        const cli = createCliActionExecutorFromCredentials({ credentials: terminalCredentials, externalActionClient: true,
            serverId: homeId, serverApiUrl: endpoint, serverIdentityId: homeId, machineId: machine.id,
            readCredentials: () => readStoredCredentialsForServerId(homeId) });
        for (const surface of ['ui', 'cli'] as const) {
            const proposed = await ui.execute('deployments.logs.read', input, { surface: 'agent', authority: 'account_automation',
                actionCaller: { kind: 'host' }, serverId, serverIdentityId: homeId, runtimeAccountId: owner.id,
                defaultSessionId: 'log-requesting-agent', defaultSessionMachineId: machine.id,
                externalActionTarget: { kind: 'machine', machineId: machine.id }, actionRequestId: crypto.randomUUID(), actionsSettings });
            expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            if (!proposed.ok || !proposed.result || typeof proposed.result !== 'object' || !('artifactId' in proposed.result)
                || typeof proposed.result.artifactId !== 'string') throw new Error('Missing approval Artifact');
            const artifactId = proposed.result.artifactId;
            const before = (await docker.readInvocations()).filter(row => row.args[0] === 'logs').length;
            const beforeHops = daemonLogAuthorities.length;
            const decision = await runWithServerHttpBaseUrl(endpoint, () => (surface === 'ui' ? ui : cli).execute('approval.request.decide',
                { artifactId, decision: 'approve' }, { surface, authority: 'present_user', actionCaller: { kind: 'host' },
                    serverId: surface === 'ui' ? serverId : homeId, serverIdentityId: homeId, runtimeAccountId: owner.id }));
            const settled = ApprovalRequestV2Schema.parse(await runWithServerHttpBaseUrl(endpoint, () => approvals.approvalsGet({ artifactId })));
            const agentResult = buildActionExecuteResultFromRecordedApprovalExecution(settled);
            expect.soft({ decision, agentResult, execution: settled.execution,
                nativeLogReads: (await docker.readInvocations()).filter(row => row.args[0] === 'logs').length - before,
                authorities: daemonLogAuthorities.slice(beforeHops),
                disclosed: JSON.stringify({ agentResult, execution: settled.execution }).includes(sentinel) }, `${surface}: ${JSON.stringify(decision)}`)
                .toMatchObject({ decision: { ok: true, result: { status: 'failed' } },
                    agentResult: { ok: false, errorCode: 'secret_redaction_unavailable' },
                    execution: { ok: false, errorCode: 'secret_redaction_unavailable' }, nativeLogReads: 0,
                    authorities: ['account_automation'], disclosed: false });
        }
        // Allowed agents skip Ask, but the browser credential must not promote
        // their invocation into the person's incomplete-masking exception.
        await account.mutateRawSettings(raw => ({ ...raw, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'deployments.logs.read': ['agent'] } }) }));
        const beforeWaivedLogs = (await docker.readInvocations()).filter(row => row.args[0] === 'logs').length;
        const beforeWaivedHops = daemonLogAuthorities.length;
        const waived = await ui.execute('deployments.logs.read', input, { surface: 'agent', authority: 'account_automation',
            actionCaller: { kind: 'host' }, serverId, actionRequestId: crypto.randomUUID() });
        expect.soft({ result: waived,
            nativeLogReads: (await docker.readInvocations()).filter(row => row.args[0] === 'logs').length - beforeWaivedLogs,
            authorities: daemonLogAuthorities.slice(beforeWaivedHops), disclosed: JSON.stringify(waived).includes(sentinel) }, 'waived agent')
            .toMatchObject({ result: { ok: false, errorCode: 'secret_redaction_unavailable' }, nativeLogReads: 0,
                authorities: ['account_automation'], disclosed: false });
    });

    it('previews a temporary-computer draft through the real UI Action and Account HTTP SQLite catalogs', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: endpoint, accountId: owner.id, currentAccount: true }],
            route: async request => fetch(request.url, { method: request.method, headers: request.headers,
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }), signal: request.signal }) });
        onTestFinished(() => homes.dispose());
        const serverId = homes.homes.home!.id;
        await TokenStorage.setCredentialsForServerUrl(endpoint, { serverId }, { token });
        // This existing Home fixture supplies native storage; every Account request here reaches the real HTTP listener.
        setRuntimeFetch((input, init) => fetch(input, init));
        const account = await captureLazyActionAccountContext(serverId);
        onTestFinished(() => account.dispose());
        const created = await account.createArtifactDocument({ header: { v: 1, kind: 'prompt_bundle.v2', title: 'Review', bundleSchemaId: 'skills.skill_md_v1' },
            body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
                contentBase64: Buffer.from('---\nname: review\ndescription: Review changes\n---\nRead the changes.').toString('base64') }] }) });
        const skillId = created.artifactId;
        expect(await writePromptLibraryRecordInContext(account, { expectedRevision: 'absent', sourceSettingsVersion: 0,
            record: { key: 'skill-rules', value: { v: 1, rules: [{ id: 'review-everywhere', skillId, enabled: true,
                target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] } } })).toMatchObject({ status: 'updated' });
        expect(await writeMcpServerCatalogInContext(account, { expectedRevision: 'absent', sourceSettingsVersion: 0,
            catalog: McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'portable-server', name: 'portable',
                transport: 'http', remote: { url: 'https://portable.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 }],
                bindings: [{ id: 'portable-everywhere', serverId: 'portable-server', enabled: true,
                    target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] }) })).toMatchObject({ status: 'updated' });
        const preview = async (removed: boolean) => {
            const receipt = await createDefaultActionExecutor().execute('sessions.spawn.capabilities.preview', {
                machineId: EPHEMERAL_RUNNER_UNMATERIALIZED_MACHINE_ID_V1, agentId: 'codex',
                ...(removed ? { capabilitySelection: { skills: { forceExcludeSkillIds: [skillId] } } } : {}),
            }, { surface: 'ui', authority: 'present_user', serverId });
            return SpawnCapabilitiesPreviewOutputV1Schema.parse(receipt.ok ? receipt.result : undefined);
        };
        expect(await preview(false)).toMatchObject({ ok: true, machinePlatform: null,
            skills: { items: expect.arrayContaining([expect.objectContaining({ id: skillId, selected: true, reason: 'rule_on' })]) },
            mcp: { items: [expect.objectContaining({ id: 'portable-server', selected: true,
                preview: expect.objectContaining({ serverId: 'portable-server', portability: 'portable' }) })] } });
        expect(await preview(true)).toMatchObject({ ok: true,
            skills: { items: expect.arrayContaining([expect.objectContaining({ id: skillId, selected: false, reason: 'session_removed' })]) },
            mcp: { items: [expect.objectContaining({ id: 'portable-server', selected: true })] } });
        expect(await db.machine.count({ where: { accountId: owner.id } })).toBe(0);
    });

    it('admits the original requester resume Action without opening private raw spawn', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            installationId: crypto.randomUUID(), active: true,
            metadata: encodePlainMachineStoredContent({ host: 'r35-resume', platform: 'linux', happyCliVersion: '0.3',
                homeDir: database.baseDir, happyHomeDir: database.baseDir }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
        await db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: requester.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const actor = { actorAccountId: requester.id, machineId: machine.id };
        expect(await resolveMachineAdmission(actor)).toMatchObject({ kind: 'admitted', role: 'use' });
        expect({ originalAccountRoot: isOriginalAccountExecutionAction('session.open'),
            admission: await resolveMachineAdmission({ ...actor, actionId: 'session.open' }),
            raw: await resolveMachineAdmission({ ...actor, actionId: 'session.open', rpcMethod: RPC_METHODS.SPAWN_HAPPY_SESSION }) })
            .toMatchObject({ originalAccountRoot: true, admission: { kind: 'admitted', role: 'use' },
                raw: { kind: 'denied', code: 'unsupported_operation' } });
    });

    it.for([
        ['selected Claude birth', 'shared'],
        ['own-Account selected Claude birth committed observation', 'owner'],
        ['own-Account selected Claude birth late Team reconnect', 'owner'],
        ['full isolated Claude host runtime', 'shared'],
        ['retained in-process Agent first reply', 'shared'],
        ['retained in-process Agent optional prompt unavailable', 'shared'],
        ['own-Account retained in-process Agent first reply', 'owner'],
        ['own-Account retained in-process Agent optional prompt unavailable', 'owner'],
        ['own-Account retained in-process Agent reply wiring sensitivity', 'owner'],
        ['own-Account retained in-process Agent registration removal sensitivity', 'owner'],
        ['own-Account retained in-process Agent late Account plan withdrawal', 'owner'],
        ['own-Account Bot birth with lazy Instructions', 'owner'],
        ['own-Account Voice hidden carrier start and native resume', 'owner'],
    ] as const)(
        '%s preserves initial-input admission and native reply wiring', { timeout: DEFAULT_SESSION_SPAWN_OPERATION_TIMEOUT_MS }, async ([journey, requesterKind], context) => {
        const ownAccount = requesterKind === 'owner';
        const lateTeamReconnect = journey === 'own-Account selected Claude birth late Team reconnect';
        const observeCommitted = journey === 'own-Account selected Claude birth committed observation' || lateTeamReconnect;
        const disconnectNativeReplyEvents = journey === 'own-Account retained in-process Agent reply wiring sensitivity';
        const disconnectAgentRegistration = journey === 'own-Account retained in-process Agent registration removal sensitivity';
        const withdrawPreparedAccountPlan = journey === 'own-Account retained in-process Agent late Account plan withdrawal';
        const botBirth = journey === 'own-Account Bot birth with lazy Instructions';
        const hiddenVoice = journey === 'own-Account Voice hidden carrier start and native resume';
        let accountPlanWithdrawals = 0;
        let withdrawalHookStage = 'unobserved';
        let observedWithdrawal: { code: string; status: string; contextSource: string } | null = null;
        const readObservedWithdrawal = () => observedWithdrawal;
        const observeExpectedWithdrawal = (error: unknown) => {
            if (!withdrawPreparedAccountPlan || accountPlanWithdrawals !== 1 || !error || typeof error !== 'object'
                || Reflect.get(error, 'code') !== 'context_source_unavailable'
                || Reflect.get(error, 'status') !== 'preparation_pending'
                || Reflect.get(error, 'contextSource') !== 'account_lifetime') return false;
            observedWithdrawal = { code: 'context_source_unavailable', status: 'preparation_pending', contextSource: 'account_lifetime' };
            return true;
        };
        let withdrawalAccount: { scopeKey: string; lifetimeToken: number } | null = null;
        let withdrawalAdmittedCatalog: PromptLibraryCatalogSnapshotV1 | null = null;
        const retainedRunner = journey === 'retained in-process Agent first reply'
            || journey === 'retained in-process Agent optional prompt unavailable'
            || journey === 'own-Account retained in-process Agent first reply'
            || journey === 'own-Account retained in-process Agent optional prompt unavailable'
            || disconnectNativeReplyEvents || disconnectAgentRegistration || withdrawPreparedAccountPlan || botBirth || hiddenVoice;
        // Windows startup cancellation invokes its exact OS process adapter.
        // A virtual runner sharing this worker's PID cannot prove that custody.
        if (retainedRunner && process.platform === 'win32') context.skip();
        const optionalPromptUnavailable = journey === 'retained in-process Agent optional prompt unavailable'
            || journey === 'own-Account retained in-process Agent optional prompt unavailable' || botBirth;
        unavailableArtifactId = null;
        unavailableArtifactReads = 0;
        requiredAccountArtifactId = null;
        requiredAccountArtifactReads = 0;
        onTestFinished(() => { unavailableArtifactId = null; });
        onTestFinished(() => { requiredAccountArtifactId = null; });
        const fullHostRuntime = journey !== 'selected Claude birth' && !observeCommitted;
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const requester = ownAccount ? owner : await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const ownerToken = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const requesterToken = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user' });
        const outsiderToken = await auth.createToken(outsider.id, undefined, { kind: 'account', authority: 'present_user' });
        const homeId = await getOrCreateServerIdentityId();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, active: true,
            metadata: encodePlainMachineStoredContent({ host: 'r35-host', platform: 'linux', happyCliVersion: '0.3',
                homeDir: database.baseDir, happyHomeDir: database.baseDir }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: MachineOperationProtocolCapabilitiesV1Schema.parse({
                sessionSpawn: { protocolVersions: observeCommitted ? [1, 2, 3] : [1, 2] },
                sessionInputAdmission: { protocolVersions: [1, 2] },
                externalActionExecutionAuthorization: { protocolVersions: [1] },
            }) } });
        if (!ownAccount) await db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: requester.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        let physicalLaunches = 0;
        let nativeReplyLaunches = 0;
        let daemonReceipts = 0;
        let inputAdmissionRequests = 0;
        let nativeTracked: TrackedSession | null = null;
        let nativeFailure: ReturnType<typeof classifyPrimarySessionRuntimeIssue> | null = null;
        let nativeBindingRequests = 0;
        let nativeFailureCode: string | undefined;
        let nativeStartupRevision: number | undefined;
        let releaseObservedStartup!: () => void;
        const observedStartup = new Promise<void>(resolve => { releaseObservedStartup = resolve; });
        onTestFinished(releaseObservedStartup);
        let hostSpawnResult: unknown;
        let rejectChildStartup!: (error: unknown) => void;
        const childStartupFailure = new Promise<never>((_resolve, reject) => { rejectChildStartup = reject; });
        void childStartupFailure.catch(() => undefined);
        let apiMachine: ApiMachineClient | null = null;
        let runnerClient: ApiSessionClient | null = null;
        let requesterRuntime: RequesterSessionRuntimeContext | null = null;
        const readRunnerClient = () => runnerClient;
        const selectedServices = { v: 2 as const, bindingsByServiceId: fullHostRuntime ? {} : {
            'happier.agent.claude/claude-subscription': { source: 'team_resource' as const,
                resourceId: crypto.randomUUID(), deliveryMode: 'brokered' as const },
        } };
        const trackedSessions = new Map<number, TrackedSession>();
        const awaiters = new Map<number, (session: TrackedSession) => void>();
        const connectedServiceRegistry = new ConnectedServiceRuntimeRegistry();
        const runtimeId = crypto.randomUUID();
        const runnerStages: Array<{ stage: string; elapsedMs: number }> = [];
        let inProcessRunner: Awaited<ReturnType<typeof startInProcessAgentSessionRunner>> | null = null;
        const readInProcessRunner = () => inProcessRunner;
        const conversationFixture = retainedRunner ? await createSessionSpawnConversationFixture({ ownAccount,
            disconnectNativeReplyEvents, disconnectAgentRegistration,
            ...(hiddenVoice ? { voiceNativeStorePath: join(database.baseDir, 'voice-native-conversation.json') } : {}) }) : null;
        const fixturePluginId = conversationFixture?.pluginId ?? 'acme.native-runtime-proof';
        const fixtureLocalId = conversationFixture?.localId ?? 'novel-native-agent';
        const fixtureEntrypoint = fileURLToPath(new URL('../../../../../cli/bin/happier.mjs', import.meta.url));
        if (fullHostRuntime) {
            // Declare the executable launcher at the OS boundary. Its virtual
            // child below runs current source in-process, not a built release.
            const previous = process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT;
            process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT = fixtureEntrypoint;
            onTestFinished(() => {
                if (previous === undefined) delete process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT;
                else process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT = previous;
            });
        }
        composedControl.real = retainedRunner;
        onTestFinished(() => { composedControl.real = false; });
        const startRunner = async (api: ApiClient, credentials: StoredCredentials, sessionId: string, attachPath: string) => {
            const baseSession = await createBaseSessionForAttach({ existingSessionId: sessionId,
                metadata: createTestMetadata(), state: { controlledByUser: false }, sessionAttachFilePath: attachPath });
            const client = await runWithServerHttpBaseUrl(endpoint, async () => createTestApiSessionClient(ApiSessionClient, credentials.token, baseSession, {
                // The simulated OS child receives this issued credential as its
                // persistence boundary input. Session transport/owners remain real.
                transport: { ...createAccountSessionClientTransport(credentials.token), resolveToken: async () => credentials.token },
                metadataAuthority: { kind: 'owner', credentials, readCurrentCredentials: async () => credentials },
                localMachineId: machine.id,
                getAccountEncryptionCurrentness: async () => await api.getAccountEncryptionCurrentness(),
                initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({
                    sessionId: baseSession.id, agentRuntimeApplicability: 'not_applicable',
                })], durableMutationDeliveryInitiallyActive: false,
            }));
            runnerClient = client;
            onTestFinished(async () => { await client.close(); });
            expect(await client.claimCurrentSessionPublisherAuthorityForStartup()).toEqual({ status: 'claimed' });
            await client.activateDurableMutationDelivery();
            if (observeCommitted) await client.flushDurableMutationDelivery();
            return baseSession;
        };
        const spawnLifecycleHandler = createSpawnNewSessionLifecycleActionHandler({ serverId: homeId,
            ...(observeCommitted ? {
                stopSession: (sessionId, options) => readDaemonRuntime().stopSession(sessionId, options),
                awaitAgentSessionOpen: request => awaitTrackedRunnerAgentSessionOpen({ ...request,
                    getTrackedSessions: () => nativeTracked ? [nativeTracked] : [],
                    readStartupFailure: async () => nativeFailure }),
            } : retainedRunner ? {
                stopSession: (sessionId, options) => readDaemonRuntime().stopSession(sessionId, options),
                awaitAgentSessionOpen: request => readDaemonRuntime().awaitAgentSessionOpen(request),
            } : {}),
            spawnSession: async options => {
                // Both journeys receive the production-issued requester bootstrap.
                // Empty-service Claude consumes the complete host launch root; the selected-Claude
                // slice proves only installed ingress and committed birth/service carry.
                const bootstrap = options.requesterSessionBootstrap;
                if (retainedRunner) {
                    const result = await readDaemonRuntime().spawnSession(options);
                    hostSpawnResult = result;
                    return result;
                }
                if (!ownAccount || bootstrap) {
                    expect(bootstrap?.attribution).toMatchObject({ accountId: requester.id, machineId: machine.id, serverId: homeId });
                    if (!bootstrap) throw new Error('Missing requester spawn custody');
                    expect(await bootstrap.isCurrent()).toBe(true);
                }
                if (!options.sessionCreationTag) throw new Error('Missing creation identity');
                if (fullHostRuntime) {
                    const result = await readDaemonRuntime().spawnSession(options);
                    hostSpawnResult = result;
                    return result;
                }
                const launchCredentials = bootstrap?.credentials ?? { token: ownerToken, encryption: null };
                const api = await runWithServerHttpBaseUrl(endpoint, () => ApiClient.create(launchCredentials));
                expect(options.connectedServices).toEqual(selectedServices);
                const committed = await runWithServerHttpBaseUrl(endpoint, () => commitDaemonLaunchSession({
                    api, credentials: launchCredentials, options: { ...options,
                        runtimeDescriptorV1: RuntimeDescriptorV1Schema.parse({ v: 1, agentId: 'claude', agent: {} }),
                    }, directory: options.directory,
                }));
                expect(committed).toMatchObject({ ok: true });
                if (!committed.ok) throw new Error('Session creation did not settle');
                expect(committed.session.options.existingSessionId).toBe(committed.session.sessionId);
                expect(committed.session.attachPayload.snapshot?.ownerMetadata?.connectedServices?.connectedServices).toEqual(selectedServices);
                const attachFile = await createSessionAttachFile({ happySessionId: committed.session.sessionId,
                    payload: committed.session.attachPayload });
                onTestFinished(attachFile.cleanup);
                if (observeCommitted) await observedStartup;
                await startRunner(api, launchCredentials, committed.session.options.existingSessionId!, attachFile.filePath);
                if (observeCommitted) {
                    nativeStartupRevision = (await db.session.findUniqueOrThrow({ where: { id: committed.session.sessionId },
                        select: { runtimeActivityRevision: true } })).runtimeActivityRevision;
                    // Native Agent process/HTTP are the substituted boundaries.
                    // Authority files, marker/attestation writers, classification,
                    // startup observation and launch-error projection stay real.
                    const realIdentity = await readProcessIdentityByPid(process.pid);
                    if (!realIdentity) throw new Error('Missing native boundary process generation');
                    const command = `${process.execPath} ${fileURLToPath(new URL('../../../../../cli/src/index.ts', import.meta.url))} claude`;
                    const entrypoint = resolveSessionRunnerEntrypointIdentityFromProcessCommand(command);
                    if (entrypoint.status !== 'known') throw new Error('Missing native source entrypoint identity');
                    const runner = { pid: process.pid, processStartTimeMs: realIdentity.processStartTimeMs,
                        processCommandHash: hashProcessCommand(command), snapshotIdentity: entrypoint.comparableId };
                    const readRealProcess = processIdentityBoundary.readProcessIdentityByPid;
                    const identity = vi.spyOn(processIdentityBoundary, 'readProcessIdentityByPid').mockImplementation(async (pid, deps) =>
                        pid === runner.pid ? { ...realIdentity, command } : await readRealProcess(pid, deps));
                    onTestFinished(() => identity.mockRestore());
                    const retainedAgent = createAgentSessionRunnerFactoryBinding({ v: 1,
                        pluginId: 'happier.agent.claude', pluginVersion: '0.3.0', agentId: 'claude', localAgentId: 'claude',
                        sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
                        locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
                        normalizedModulePath: join(database.baseDir, 'native-agent/runtime.mjs'), loadMode: 'immutable-js' });
                    const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
                        path: await createAgentRuntimeDaemonServiceAuthorityPath(configuration),
                        sessionId: committed.session.sessionId, runner, retainedAgent };
                    await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31_001 });
                    const child = new ChildProcess();
                    nativeTracked = { startedBy: 'daemon', pid: runner.pid, happySessionId: authority.sessionId,
                        runnerProcessIdentity: runner, processStartTimeMs: runner.processStartTimeMs,
                        processCommandHash: runner.processCommandHash, childProcess: child,
                        agentRuntimeDaemonServiceAuthorityFilePath: authority.path,
                        runnerAgentSourceCustodyV1: retainedAgent.sourceCustody };
                    physicalLaunches += 1;
                    if (lateTeamReconnect) {
                        const realFetch = globalThis.fetch;
                        const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
                            if (String(url).startsWith('http://127.0.0.1:31001/')) {
                                nativeBindingRequests += 1;
                                return new Response(JSON.stringify({ ok: false, error: {
                                    code: 'connected_service_credential_reconnect_required', message: 'PRIVATE_NATIVE_DIAGNOSTIC' },
                                }), { status: 200, headers: { 'content-type': 'application/json' } });
                            }
                            return await realFetch(url, init);
                        });
                        try {
                            const failure = await openCurrentRunnerTeamCredentialProviderBinding({ authority, operation: {
                                kind: 'provider_broker.binding.open', resourceId: 'native-team-resource', expectedResourceRevision: 1,
                                agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'native-model' },
                            }).then(() => null, (error: unknown) => error);
                            nativeFailure = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: failure,
                                occurredAt: Date.now() });
                            nativeFailureCode = nativeFailure?.code;
                        } finally { transport.mockRestore(); }
                        Object.defineProperty(child, 'exitCode', { value: 1 });
                    } else {
                        await writeSessionMarker({ pid: runner.pid, happySessionId: authority.sessionId,
                            startedBy: 'daemon', processStartTimeMs: runner.processStartTimeMs,
                            processCommandHash: runner.processCommandHash, agentRuntimeDaemonServiceAuthorityFilePath: authority.path,
                            runnerAgentSourceCustodyV1: retainedAgent.sourceCustody });
                        expect(await recordTrackedRunnerAgentSessionOpenAttestation({ tracked: nativeTracked, runner, retainedAgent,
                            request: { kind: 'create', sessionId: authority.sessionId, cwd: options.directory }, providerSessionId: null }))
                            .not.toBeNull();
                    }
                    if (lateTeamReconnect) return { type: 'success', sessionId: committed.session.sessionId,
                        sessionCreationOutcome: committed.session.sessionCreationOutcome };
                }
                if (!observeCommitted) physicalLaunches += 1;
                return { type: 'success', sessionId: committed.session.sessionId,
                    sessionCreationOutcome: committed.session.sessionCreationOutcome };
            } });
        const transport = createMachineSessionDirectTargetTransport({ machineId: machine.id,
            spawnLifecycleHandler: async (request, rpcContext) => {
                const result = await spawnLifecycleHandler(request, rpcContext);
                if (retainedRunner && result && typeof result === 'object' && Reflect.get(result, 'type') === 'error') {
                    console.info('SESSIONOPEN lifecycle refusal', JSON.stringify({
                        code: Reflect.get(result, 'errorCode'),
                        messageClass: Reflect.get(result, 'errorMessage') === 'Requester Machine admission unavailable' ? 'requester_machine_admission'
                            : Reflect.get(result, 'errorMessage') === 'Requester Session credential unavailable' ? 'requester_session_credential'
                            : Reflect.get(result, 'errorMessage') === 'Requester Account runtime unavailable' ? 'requester_account_runtime'
                            : Reflect.get(result, 'errorMessage') === 'Requester Account settings unavailable' ? 'requester_account_settings' : 'other',
                        hasMachineAdmission: Boolean(rpcContext?.machineAdmission),
                        hasRequesterBootstrap: Boolean(rpcContext?.requesterSessionBootstrap),
                        requesterHomeMatches: rpcContext?.requesterSessionBootstrap?.attribution.serverId === homeId,
                        requesterMachineMatches: rpcContext?.requesterSessionBootstrap?.attribution.machineId === machine.id,
                    }));
                }
                return result;
            } });
        const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({ path: join(database.baseDir, journey, 'device-local-key.json') });
        const report = createOnHappySessionWebhook({ pidToTrackedSession: trackedSessions, pidToAwaiter: awaiters, deviceLocalSecretStorage });
        const daemonHomeDir = retainedRunner ? join(database.baseDir, 'daemon', journey) : join(database.baseDir, 'daemon');
        if (retainedRunner) {
            // startDaemon installs this authenticated Machine socket before
            // composing Session control. This narrower source harness must
            // retain the same production input-admission transport.
            onTestFinished(installDaemonMachineAdmissionTransport({ serverId: homeId,
                transport: async (request, options) => {
                    if (!apiMachine) return { status: 'rejected', code: 'session_input_target_unavailable' };
                    return await apiMachine.enqueueSessionPendingByMachine(request, options);
                } }));
        }
        const daemon: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: daemonHomeDir,
            activeServerDir: join(daemonHomeDir, 'servers', homeId), serverId: homeId, serverHttpBaseUrl: endpoint,
            machineId: machine.id, custodianAccountId: owner.id, credentials: { token: ownerToken, encryption: null },
            connectedServicesMaterializationBaseDir: join(database.baseDir, 'connected-services'), registry: connectedServiceRegistry,
            trackedSessions, pidToAwaiter: awaiters, getRequester: () => requesterRuntime, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
            getApiMachineForSessions: () => apiMachine,
            processEnv: { NODE_ENV: 'test', HAPPIER_CLAUDE_PATH: process.execPath,
                ...(fullHostRuntime ? { HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: fixtureEntrypoint } : {}),
                [resolveAgentCliOverrideEnvKey(`${fixturePluginId}/${fixtureLocalId}`)]: process.execPath },
            beforeStartup: async () => {
                if (!fullHostRuntime) return;
                if (retainedRunner) {
                    if (!conversationFixture) throw new Error('Missing retained conversation fixture');
                    const sourceRuntime = await createAuthoredAdmittedPluginRuntimeFixture({
                        happyHomeDir: daemonHomeDir, controller: pluginReloadController,
                        plugins: [{ manifest: conversationFixture.manifest, files: conversationFixture.files }],
                        ...(disconnectAgentRegistration ? { coldStart: true }
                            : { runtimeOptions: { pluginIds: [fixturePluginId] } }),
                    });
                    sourceRuntimeFixtures.push(sourceRuntime);
                    if (!disconnectAgentRegistration) {
                        await sourceRuntime.registry.activateContributionsOnDemand([
                            { pluginId: fixturePluginId, family: 'agents', localId: fixtureLocalId },
                        ]);
                        expect(sourceRuntime.registry.targetActivationFacts?.filter((fact: PluginTargetActivationFact) => fact.pluginId === fixturePluginId))
                            .toEqual(expect.arrayContaining([expect.objectContaining({ status: 'active' })]));
                    }
                    return;
                }
                const sourceRuntime = await createAdmittedPluginRuntimeFixture({
                    happyHomeDir: daemonHomeDir, controller: pluginReloadController,
                    runtimeOptions: { pluginIds: ['happier.agent.claude'] },
                });
                sourceRuntimeFixtures.push(sourceRuntime);
                await sourceRuntime.registry.activateContributionsOnDemand([
                    { pluginId: 'happier.agent.claude', family: 'agents', localId: 'claude' },
                ]);
            },
            startup: { resolveSessionSpawnDirectTargetTransport: () => transport,
                deviceLocalSecretStorage, onHappySessionWebhook: report,
                createRequesterSessionRuntimeContext: async bootstrap => {
                    expect(bootstrap.serverHttpBaseUrl).toBe(endpoint);
                    bindRequesterSessionRuntimeMachineAdmissionCurrentness({ bootstrap, boundary: {
                        machineId: machine.id, daemonToken: ownerToken,
                        isHomeCurrent: () => configuration.activeServerId === homeId
                            && bootstrap.attribution.serverId === homeId
                            && bootstrap.attribution.machineId === machine.id,
                        readInstallation: readInstallationIdentityIfExistsSync,
                    } });
                    const context = await createRequesterSessionRuntimeContext({ bootstrap,
                        activeServerDir: join(daemonHomeDir, 'servers', homeId),
                        connectedServicesMaterializationBaseDir: join(database.baseDir, 'connected-services'),
                        resolveQualifiedConnectedAccountV4Support: () => 'advertised',
                        coordinatorInput: {
                            happyHomeDir: daemonHomeDir, machineId: machine.id,
                            machineIdProvider: () => machine.id, runtimeId, logger, processEnv: { NODE_ENV: 'test' },
                            pidToTrackedSession: trackedSessions, connectedServiceRuntimeRegistry: connectedServiceRegistry,
                            connectedServiceAuthGroupPreTurnSwitchCoordinator: readDaemonRuntime().connectedServiceAuthGroupPreTurnSwitchCoordinator,
                            connectedServicePredictiveSwitchGuard: readDaemonRuntime().connectedServicePredictiveSwitchGuard,
                            consumeCommittedAuthGroupGeneration: readDaemonRuntime().consumeCommittedAuthGroupGeneration,
                        },
                    });
                    expect(context, 'Real requester Account runtime did not initialize').not.toBeNull();
                    requesterRuntime = context;
                    if (context) onTestFinished(context.dispose);
                    return context;
                },
                resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
                    serverUrl: endpoint, resolveCurrentMachineId: () => machine.id,
                }) } });
        onTestFinished(daemon.dispose);
        if (retainedRunner) {
            await mkdir(configuration.activeServerDir, { recursive: true });
            await writeCredentialsTokenOnly({ token: ownerToken });
            await updateSettings(settings => ({ ...settings, machineIdByServerId: {
                ...settings.machineIdByServerId, [homeId]: machine.id,
            }, machineIdByServerIdByAccountId: { ...settings.machineIdByServerIdByAccountId,
                [homeId]: { ...settings.machineIdByServerIdByAccountId?.[homeId], [owner.id]: machine.id } },
            lastTokenSubByServerId: { ...settings.lastTokenSubByServerId, [homeId]: owner.id },
            }));
            await seedTestServerProfile({ id: homeId, homeId, serverUrl: endpoint });
            expect(await resolveServerProfileHomeIdentityId(homeId)).toBe(homeId);
            await writeDaemonState({ pid: process.pid, httpPort: composedControl.port,
                controlToken: composedControl.token, startedAt: Date.now(), startedWithCliVersion: 'test' });
            const actualProcessIdentity = await readProcessIdentityByPid(process.pid);
            if (!actualProcessIdentity) throw new Error('Missing composed test process generation');
            const tsxHook = resolveTsxImportHookPath();
            if (!tsxHook) throw new Error('Missing current-source CLI runtime loader');
            // This is the virtual runner's loaded source process, not the
            // launcher's command. Keep process/snapshot recognition real.
            const launch = buildHappyCliSubprocessLaunchSpec(['daemon', 'start-sync'], {
                runtimeDecision: { runtime: 'node', argvPrefix: ['--import', tsxHook,
                    fileURLToPath(new URL('../../../../../cli/src/index.ts', import.meta.url))] },
            });
            const command = [launch.filePath, ...launch.args].join(' ');
            // Only the OS child identity is simulated. The daemon bearer,
            // source custody, open attestation and turn admission remain real.
            const readActualProcessIdentity = processIdentityBoundary.readProcessIdentityByPid;
            const identitySpy = vi.spyOn(processIdentityBoundary, 'readProcessIdentityByPid')
                .mockImplementation(async (pid, dependencies) => pid === process.pid
                    ? { ...actualProcessIdentity, command }
                    : await readActualProcessIdentity(pid, dependencies));
            onTestFinished(() => { identitySpy.mockRestore(); });
            const realKill = process.kill;
            const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
                if (signal !== 0) throw new Error('In-process runner attempted a real OS signal');
                return realKill(pid, signal);
            });
            onTestFinished(() => { killSpy.mockRestore(); });
            if (optionalPromptUnavailable || withdrawPreparedAccountPlan) {
                const store = createCredentialedAccountArtifactStore({ token: requesterToken, encryption: null });
                const created = await runWithServerHttpBaseUrl(endpoint, () => store.create({
                    header: PromptDocArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_doc.v2',
                        title: withdrawPreparedAccountPlan ? 'Required Account context' : 'Optional context' }),
                    body: JSON.stringify(PromptDocBodyV1Schema.parse({ v: 1,
                        markdown: withdrawPreparedAccountPlan ? 'Required Account context for this fixture' : 'Optional context',
                        createdAtMs: 0, updatedAtMs: 0 })),
                }));
                if (withdrawPreparedAccountPlan) requiredAccountArtifactId = created.artifactId;
                else unavailableArtifactId = created.artifactId;
            }
        }
        if (fullHostRuntime) {
            physicalRunner.launch = (_args, options) => {
                if (retainedRunner) {
                    const child = new ChildProcess();
                    const childCredentialEnvironment = new Map<string, string | undefined>();
                    Object.defineProperties(child, {
                        pid: { value: process.pid },
                        stderr: { value: new PassThrough() },
                        stdout: { value: new PassThrough() },
                    });
                    child.kill = () => true;
                    onTestFinished(async () => {
                        physicalRunner.launch = null;
                        try {
                            if (withdrawPreparedAccountPlan) console.info('SESSIONOPEN withdrawal cleanup', JSON.stringify({ stage: 'stop_started' }));
                            await inProcessRunner?.stop().catch(error => {
                                if (!observeExpectedWithdrawal(error)) throw error;
                            });
                            if (withdrawPreparedAccountPlan) console.info('SESSIONOPEN withdrawal cleanup', JSON.stringify({ stage: 'stop_settled' }));
                        }
                        finally {
                            for (const [key, previous] of childCredentialEnvironment) {
                                if (previous === undefined) delete process.env[key];
                                else process.env[key] = previous;
                            }
                        }
                    });
                    void Promise.resolve().then(async () => {
                        const sessionOptions = partitionProviderSessionArgs({ args: _args });
                        const attachPath = options.env?.HAPPIER_SESSION_ATTACH_FILE;
                        const bootstrapPath = options.env?.[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY];
                        const authorityPath = options.env?.[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY];
                        const credentialPath = options.env?.HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE;
                        const sessionId = options.env?.HAPPIER_SESSION_REQUESTER_SESSION_ID;
                        if (!bootstrapPath || !authorityPath)
                            throw new Error('Missing retained runner launch custody');
                        if ((!credentialPath || !sessionId) && !ownAccount)
                            throw new Error('Missing retained requester runner launch custody');
                        // These keys are also consumed by the real attach-ACK
                        // guard; passing file paths to the bridge alone is not
                        // an OS child environment.
                        for (const key of [HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY,
                            HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]) {
                            childCredentialEnvironment.set(key, process.env[key]);
                            process.env[key] = options.env![key];
                        }
                        // The virtual OS child retains its issued environment
                        // for all later credential-currentness reads, just as
                        // a separate child process does. Never install its token
                        // into the daemon's Account credential store.
                        let credentials: StoredCredentials | null;
                        if (credentialPath && sessionId) {
                            for (const [key, value] of [[REQUESTER_SESSION_ID_ENV, sessionId],
                                ['HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE', credentialPath]]) {
                                childCredentialEnvironment.set(key, process.env[key]);
                                process.env[key] = value;
                            }
                            credentials = await readRequesterSessionCredentialsForChild(credentialPath);
                        } else {
                            // Only the named own-Account scenario reads the
                            // fixture's actual persisted Account credential.
                            credentials = await readCredentials();
                        }
                        if (!credentials) throw new Error('Retained requester child credential was not admitted');
                        const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(bootstrapPath, 'utf8')));
                        inProcessRunner = await runWithServerHttpBaseUrl(endpoint, async () => {
                            const bootstrapSnapshot = await bootstrapAccountSettingsContext({ credentials, mode: 'fast' });
                            if (withdrawPreparedAccountPlan) {
                                if (!requiredAccountArtifactId) throw new Error('Missing required Account prompt Artifact');
                                const library = createCliPromptLibraryStore({ credentials });
                                const source = await library.readSourceSnapshot();
                                const catalog = await library.readPromptLibraryCatalog(undefined, { maintainSource: false });
                                const currentCoding = readPromptLibraryCatalogRecordV1({ catalog, key: 'coding', rawSettings: source.raw });
                                if (currentCoding.status !== 'ready') throw new Error('Coding prompt catalog fixture was not readable');
                                const written = await library.writeRecord({ expectedRevision: currentCoding.revision,
                                    ...(currentCoding.revision === 'absent' ? { sourceSettingsVersion: source.version } : {}),
                                    record: PromptLibraryRecordV1Schema.parse({ key: 'coding', value: {
                                        v: 1, scope: { kind: 'coding' }, entries: [{ id: 'required-account-context',
                                            ref: { kind: 'doc', artifactId: requiredAccountArtifactId }, enabled: true,
                                            required: true, placement: 'system_append' }],
                                    } }) });
                                expect(written.status).toBe('updated');
                                const writtenAccount = getActiveAccountSettingsSnapshot();
                                if (!writtenAccount?.scopeKey) throw new Error('Required Account prompt scope was not admitted');
                                withdrawalAdmittedCatalog = await refreshActivePromptLibraryCatalogAfterChange({ credentials,
                                    scopeKey: writtenAccount.scopeKey, lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() });
                            }
                            const activeSnapshot = withdrawPreparedAccountPlan ? getActiveAccountSettingsSnapshot() : null;
                            if (withdrawPreparedAccountPlan && !activeSnapshot) throw new Error('Required Account settings snapshot was not admitted');
                            // This is the settled active snapshot after the awaited catalog write, not a pending bootstrap refresh.
                            const snapshot = activeSnapshot ? { ...activeSnapshot, whenRefreshed: null } : bootstrapSnapshot;
                            if (withdrawPreparedAccountPlan) {
                                if (!snapshot?.scopeKey) throw new Error('Required Account prompt scope was not admitted');
                                withdrawalAccount = { scopeKey: snapshot.scopeKey,
                                    lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
                            }
                            if (!snapshot) throw new Error('Account settings snapshot was not admitted');
                            const accountSettingsContext = await resolveSessionStartAccountSettingsContext({ startedBy: 'daemon', snapshot });
                            return await startInProcessAgentSessionRunner({
                            backendId: bootstrap.descriptor.backendId,
                            agentTarget: { kind: 'agent', identity: { pluginId: fixturePluginId, localId: fixtureLocalId } },
                            happyHomeDir: configuration.happyHomeDir,
                            binding: buildPluginSessionBindingInput({ ...sessionOptions, credentials,
                                accountSettingsContext,
                                environmentVariables: Object.fromEntries(Object.entries(options.env ?? {})
                                    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
                                startedBy: 'daemon', directory: database.baseDir,
                                sessionAttachFilePath: attachPath, runtimeDescriptorV1: bootstrap.launch?.runtimeDescriptorV1 }),
                            bootstrapFilePath: bootstrapPath, authorityFilePath: authorityPath,
                            onSessionInitialized: ({ session }: { session: ApiSessionClient }) => {
                                runnerClient = session;
                            },
                            onStage: (stage, elapsedMs) => runnerStages.push({ stage, elapsedMs }),
                            });
                        });
                        void inProcessRunner.run.catch(error => {
                            console.info('SESSIONOPEN runner withdrawal', JSON.stringify({ journey,
                                code: error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined,
                                reason: error && typeof error === 'object' ? Reflect.get(error, 'reason') : undefined,
                            }));
                            if (!observeExpectedWithdrawal(error)) rejectChildStartup(error);
                        });
                        await inProcessRunner.ready;
                    }).catch(error => {
                        rejectChildStartup(error);
                        child.stderr?.emit('data', Buffer.from(String(error)));
                        child.emit('exit', 1, null);
                    });
                    return child;
                }
                const isolatedHome = options.env?.CLAUDE_CONFIG_DIR;
                expect(typeof isolatedHome === 'string'
                    && isCanonicalAbsolutePathInsideRoot(database.baseDir, isolatedHome)).toBe(true);
                // A harmless real child preserves process-generation and exit custody;
                // the external Agent executable and its output are simulated here.
                const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'pipe'] });
                onTestFinished(async () => {
                    physicalRunner.launch = null;
                    if (child.exitCode === null && child.signalCode === null) {
                        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
                        child.kill();
                        await exited;
                    }
                });
                void Promise.resolve().then(async () => {
                    const sessionId = options.env?.HAPPIER_SESSION_REQUESTER_SESSION_ID;
                    const attachPath = options.env?.HAPPIER_SESSION_ATTACH_FILE;
                    const credentialPath = options.env?.HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE;
                    const bootstrapPath = options.env?.[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY];
                    if (!sessionId || !attachPath || !credentialPath || !bootstrapPath || !child.pid)
                        throw new Error('Host launch dropped committed requester custody');
                    const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(bootstrapPath, 'utf8')));
                    expect(bootstrap.launch?.runtimeDescriptorV1?.agentId).toBe('claude');
                    const previous = process.env[REQUESTER_SESSION_ID_ENV];
                    let credentials: StoredCredentials | null;
                    try {
                        process.env[REQUESTER_SESSION_ID_ENV] = sessionId;
                        credentials = await readRequesterSessionCredentialsForChild(credentialPath);
                    } finally {
                        if (previous === undefined) delete process.env[REQUESTER_SESSION_ID_ENV];
                        else process.env[REQUESTER_SESSION_ID_ENV] = previous;
                    }
                    if (!credentials) throw new Error('Requester child credential was not admitted');
                    const api = await runWithServerHttpBaseUrl(endpoint, () => ApiClient.create(credentials));
                    const base = await startRunner(api, credentials, sessionId, attachPath);
                    await vi.waitFor(() => expect(awaiters.has(child.pid!)).toBe(true), { timeout: resolveSessionStartupTimeoutMs() });
                    const identity = await readProcessIdentityByPid(child.pid);
                    if (!identity) throw new Error('Child process generation unavailable');
                    await report(sessionId, { ...base.metadata, hostPid: child.pid,
                        hostProcessStartTimeMs: identity.processStartTimeMs });
                }).catch(error => {
                    child.stderr?.emit('data', Buffer.from(error instanceof Error ? error.message : String(error)));
                    child.kill();
                });
                return child;
            };
            // Native-required host modules can reach a second module identity
            // for the CLI helper. Intercept the actual OS boundary, identified
            // by the production-issued private runner bootstrap, not an
            // internal Session/runtime service. Other tooling spawns stay real.
            const realSpawn = childProcess.spawn;
            const osSpawn = vi.spyOn(childProcess, 'spawn').mockImplementation((command, argv, options) => {
                if (options?.env?.[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]) {
                    const controlIndex = argv.indexOf('--happy-starting-mode');
                    if (controlIndex < 1 || !physicalRunner.launch) throw new Error('Unexpected runner OS launch');
                    physicalLaunches += 1;
                    return physicalRunner.launch(Array.from(argv).slice(controlIndex - 1), options);
                }
                if (/^git(?:\.exe)?$/i.test(basename(command)) && argv.length === 1 && argv[0] === '--version') {
                    nativeReplyLaunches += 1;
                }
                return realSpawn(command, argv, options);
            });
            syncBuiltinESMExports();
            onTestFinished(() => { osSpawn.mockRestore(); syncBuiltinESMExports(); });
        }
        function readDaemonRuntime() {
            if (!daemon.runtime) throw new Error('Missing installed daemon runtime');
            return daemon.runtime;
        }
        const daemonRuntime = readDaemonRuntime();
        if (!daemon.installation || !daemonRuntime.externalActionIngressOwner) throw new Error('Missing installed production Action ingress');
        const installation = daemon.installation;
        await db.machine.update({ where: { id: machine.id }, data: { installationId: installation.installationId,
            installationPublicKey: new Uint8Array(decodeBase64(installation.publicKey, 'base64url')) } });
        // Canonical registrar erases request generics at the Socket.IO boundary; the real registered handler validates its packet.
        const handlers = new Map<string, RpcHandler>();
        const registerHandler: RpcHandlerRegistrar['registerHandler'] = (method, handler) => { handlers.set(method, handler); };
        if (!retainedRunner) registerExternalActionRpcHandler({ registerHandler }, {
            ...daemonRuntime.externalActionIngressOwner,
            machineId: machine.id, resolveAccountId: async () => owner.id, resolveInstallationId: () => installation.installationId,
            verifyExecutionAuthorization: async (input: Parameters<VerifyExternalActionExecutionAuthorization>[0]) => {
                const { verifyExternalActionExecutionAuthorizationCurrent } = await import('../../../../../cli/src/api/externalActionExecutionAuthorization');
                return await verifyExternalActionExecutionAuthorizationCurrent({ ...input, serverHttpBaseUrl: endpoint,
                    installationId: installation.installationId, privateKey: installation.privateKey });
            },
        });
        const socket = io(endpoint, { path: '/v1/updates', transports: ['websocket'], reconnection: false, autoConnect: false,
            auth: { ...currentAccountStoredContentCompatibilitySocketAuth, token: ownerToken, clientType: 'machine-scoped', machineId: machine.id, installationId: installation.installationId,
                installationPublicKey: installation.publicKey, installationProof: signMachineInstallationProof({
                    payload: { version: 1, installationId: installation.installationId, machineId: machine.id, accountId: owner.id },
                    privateKey: installation.privateKey }) } });
        socket.onAnyOutgoing(event => {
            if (event === SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1 || event === SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2) {
                inputAdmissionRequests += 1;
            }
        });
        onTestFinished(() => { socket.disconnect(); });
        const ownerApi = await runWithServerHttpBaseUrl(endpoint, () => ApiClient.create({ token: ownerToken, encryption: null }));
        const publishedMachine = await runWithServerHttpBaseUrl(endpoint, () => ownerApi.getMachine(machine.id));
        if (!publishedMachine) throw new Error('Machine read did not settle');
        apiMachine = await runWithServerHttpBaseUrl(endpoint, async () => ownerApi.machineSyncClient(publishedMachine));
        onTestFinished(apiMachine.onConnectedServicesProjection(daemonRuntime.reconcileConnectedServicesProjection));
        if (observeCommitted || retainedRunner) apiMachine.setRPCHandlers({
            spawnSession: daemonRuntime.spawnSession, stopSession: daemonRuntime.stopSession,
            ...(retainedRunner ? { sessionSpawnV1OutcomeRequired: true,
                isSessionActive: daemonRuntime.isSessionAlreadyRunning } : {}),
            requestShutdown: () => { throw new Error('Unexpected daemon shutdown request'); },
        }, { externalActionIngressOwner: daemonRuntime.externalActionIngressOwner });
        const currentApiMachine = apiMachine;
        onTestFinished(async () => { await currentApiMachine.shutdown(); });
        // Retained source rows consume the production socket factory and RPC
        // manager. The small historical slices retain their transport fixture.
        if (!retainedRunner) (apiMachine as unknown as { socket: typeof socket }).socket = socket;
        if (!retainedRunner) socket.on(SOCKET_RPC_EVENTS.REQUEST, (request: SocketRpcRequestPayload, acknowledge: (reply: unknown) => void) => {
            daemonReceipts += 1;
            const carried = ExternalActionDaemonDispatchRequestSchema.parse(request.params);
            expect(carried.envelope.v).toBe(1);
            if (carried.envelope.v !== 1) throw new Error('Expected the original plaintext fixture envelope');
            expect(carried.executionAuthorization?.binding.accountEncryptionMode).toBe('plain');
            expect(carried.executionAuthorization?.binding.requestEnvelopeDigest)
                .toBe(computeExternalActionRequestEnvelopeDigestV1(carried.envelope));
            expect(carried.executionAuthorization?.binding.accountId).toBe(carried.principal.accountId);
            const binding = carried.executionAuthorization?.binding;
            if ('authentication' in carried.principal && binding && 'authentication' in binding) expect(sameStrictJsonValue(
                binding.authentication, carried.principal.authentication)).toBe(true);
            const handler = handlers.get(request.method.slice(machine.id.length + 1));
            if (!handler) { acknowledge({ error: 'method_not_available' }); return; }
            void Promise.resolve(handler(request.params, { signal: new AbortController().signal,
                authorization: request.authorization })).then(acknowledge,
                    () => acknowledge({ error: 'daemon_effect_failed' }));
        });
        let homes: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
        let realCredentials: HomeCredentialWriteRollback | null = null;
        let learnedProfileId: string | undefined;
        let homeCleanup: Promise<void> | undefined;
        const disposeHomes = () => homeCleanup ??= (async () => {
            if (realCredentials && !await realCredentials.rollback()) throw new Error('Requester token rollback failed');
            await homes?.dispose();
            if (learnedProfileId) await removeServerProfile(learnedProfileId);
            else if (homes?.homes.home) await removeServerProfile(homes.homes.home.id);
        })();
        onTestFinished(disposeHomes);
        const httpResults: Array<{ path: string; status: number; code?: string }> = [];
        const spawnEnvelopes: Array<{ path: string; requestId: string; digest: string; observeSessionCommit: boolean;
            creationKey: unknown; initialInput: unknown; waitForTerminal: unknown }> = [];
        try {
            if (retainedRunner) {
                const serverSocket = app.machineDaemonPresence;
                if (!(serverSocket instanceof SocketIoServer)) throw new Error('Missing real Machine socket server');
                const observeMachineConnection = (connected: SocketIoSocket) => {
                    if (connected.handshake.auth.machineId !== machine.id) return;
                    connected.onAny(event => {
                        if (event === SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1 || event === SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2) {
                            inputAdmissionRequests += 1;
                        }
                    });
                    connected.onAnyOutgoing((event: string, packet: unknown) => {
                        if (event !== SOCKET_RPC_EVENTS.REQUEST || !packet || typeof packet !== 'object'
                            || Reflect.get(packet, 'method') !== `${machine.id}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`) return;
                        const carried = ExternalActionDaemonDispatchRequestSchema.parse(Reflect.get(packet, 'params'));
                        expect(carried.principal.accountId).toBe(requester.id);
                        expect(carried.envelope.v).toBe(1);
                        if (carried.envelope.v === 1 && Reflect.get(carried, 'actionId') === 'session.spawn_new') {
                            expect(SessionSpawnNewInputV2Schema.parse(carried.envelope.input).agentTarget?.identity.pluginId).toBe(fixturePluginId);
                        }
                        daemonReceipts += 1;
                    });
                };
                serverSocket.on('connection', observeMachineConnection);
                onTestFinished(() => { serverSocket.off('connection', observeMachineConnection); });
                await new Promise<void>((resolve, reject) => {
                    void Promise.resolve(runWithServerHttpBaseUrl(endpoint,
                        () => currentApiMachine.connect({ onConnect: resolve }))).catch(reject);
                });
            } else {
                await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
                await new Promise<void>(resolve => {
                    socket.once(SOCKET_RPC_EVENTS.REGISTERED, () => resolve());
                    socket.emit(SOCKET_RPC_EVENTS.REGISTER, { method: `${machine.id}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}` });
                });
            }
            homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: endpoint, accountId: requester.id, currentAccount: true,
                // Activation performs authenticated reads immediately. Give the
                // real Home its issued credentials before restoring connection.
                serverIdentityId: homeId, credentials: { token: requesterToken },
            }],
                route: async request => {
                    if (request.url.pathname.startsWith('/v1/actions/session.spawn_new')
                        || observeCommitted && request.url.pathname.startsWith('/v1/actions/action.operations.get')) {
                        const wrapped = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(request.body);
                        const envelope = retainedRunner && request.url.pathname === '/v1/actions/session.spawn_new' && !wrapped.success
                            ? ExternalActionRequestEnvelopeV1Schema.parse(request.body)
                            : ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.body).envelope;
                        expect(envelope.v).toBe(1);
                        if (observeCommitted) spawnEnvelopes.push({ path: request.url.pathname, requestId: envelope.requestId,
                            digest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                            creationKey: envelope.input && typeof envelope.input === 'object' ? Reflect.get(envelope.input, 'creationKey') : undefined,
                            initialInput: envelope.input && typeof envelope.input === 'object' ? Reflect.get(envelope.input, 'initialInput') : undefined,
                            waitForTerminal: envelope.input && typeof envelope.input === 'object' ? Reflect.get(envelope.input, 'waitForTerminal') : undefined,
                            observeSessionCommit: Boolean(envelope.input && typeof envelope.input === 'object'
                                && Reflect.get(envelope.input, 'observeSessionCommit') === true) });
                    }
                    const method = request.method;
                    if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'PATCH'
                        && method !== 'DELETE' && method !== 'HEAD' && method !== 'OPTIONS') throw new Error('Unsupported fixture HTTP method');
                    const response = await app.inject({ method, url: request.url.pathname + request.url.search,
                        headers: Object.fromEntries(request.headers), ...(request.body === undefined ? {} : { payload: JSON.stringify(request.body) }) });
                    const error = response.statusCode >= 400 && response.body.length > 0
                        && String(response.headers['content-type'] ?? '').includes('application/json') ? response.json() : null;
                    httpResults.push({ path: request.url.pathname, status: response.statusCode,
                        ...(typeof error?.code === 'string' ? { code: error.code } : {}) });
                    return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
                } });
            const learnedProfile = await setServerProfileIdentityForUrl(endpoint, homeId);
            expect(learnedProfile).not.toBeNull();
            if (!learnedProfile) throw new Error('Home identity was not learned');
            learnedProfileId = learnedProfile.id;
            realCredentials = await TokenStorage.setCredentialsForServerUrlWithRollback(endpoint,
                { serverId: learnedProfile.id }, { token: requesterToken });
            if (!realCredentials) throw new Error('Could not store the real requester token');
            if (hiddenVoice) {
                if (!conversationFixture) throw new Error('Missing native Voice fixture');
                const voice = await createHiddenVoiceStartCanary({ serverUrl: endpoint, serverIdentityId: homeId,
                    accountId: requester.id, credentials: { token: requesterToken }, machineId: machine.id,
                    agentIdentity: { pluginId: fixturePluginId, localId: fixtureLocalId },
                    request: async (url, init) => await fetch(url, init) });
                onTestFinished(voice.dispose);
                expect(await db.session.count({ where: { accountId: requester.id } })).toBe(1);
                const first = await voice.send(conversationFixture.firstInput);
                const firstNative: unknown = JSON.parse(first.assistantText);
                expect(firstNative).toMatchObject({ nativeOpen: { kind: 'create',
                    providerSessionId: 'voice-canary-native-conversation' }, nativeHistoryTurns: 0,
                    answer: expect.stringMatching(/^git version \S+/) });
                expect(first.assistantText).not.toContain(conversationFixture.firstInput);
                const firstTurns = await app.inject({ method: 'GET', url: `/v1/sessions/${voice.carrierSessionId}/turns`,
                    headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                expect(firstTurns.statusCode).toBe(200);
                expect(SessionTurnsProjectionV1Schema.parse(firstTurns.json()).turns)
                    .toEqual([expect.objectContaining({ status: 'completed', transcriptAnchors: expect.objectContaining({
                        finalAssistantMessageSeq: expect.any(Number) }) })]);
                expect(await db.sessionPendingMessage.count({ where: { sessionId: voice.carrierSessionId } })).toBe(0);
                await voice.resume();
                const second = await voice.send(conversationFixture.firstInput);
                const secondNative: unknown = JSON.parse(second.assistantText);
                expect(secondNative).toMatchObject({ nativeOpen: { kind: 'resume',
                    providerSessionId: 'voice-canary-native-conversation' }, nativeHistoryTurns: 1,
                    answer: expect.stringMatching(/^git version \S+/) });
                expect(second.assistantText).not.toContain(conversationFixture.firstInput);
                const firstInputIds = firstNative && typeof firstNative === 'object' ? Reflect.get(firstNative, 'inputIds') : undefined;
                const secondInputIds = secondNative && typeof secondNative === 'object' ? Reflect.get(secondNative, 'inputIds') : undefined;
                expect(firstInputIds).toEqual([expect.any(String)]);
                expect(secondInputIds).toEqual([expect.any(String)]);
                expect(secondInputIds).not.toEqual(firstInputIds);
                expect(await db.session.count({ where: { accountId: requester.id } })).toBe(1);
                expect(await db.sessionPendingMessage.count({ where: { sessionId: voice.carrierSessionId } })).toBe(0);
                return;
            }
            const requestId = crypto.randomUUID();
            const creationKey = buildManualSessionCreationKey(requestId);
            const schemaInput = { ...SessionSpawnNewInputV2Schema.parse({ creationKey,
                executionTarget: { serverId: homeId, machineId: machine.id },
                // Ordinary no-folder creation isolates the observer contract
                // from the separate raw shared-Machine directory preflight.
                directory: observeCommitted ? { kind: 'managed' } : { kind: 'path', path: database.baseDir },
                connectedServices: selectedServices,
                ...(botBirth ? { title: 'First conversation Bot', identity: { bot: { kind: 'bot' }, createdAsBot: true } } : {}),
                ...(unavailableArtifactId ? { promptStack: [{ id: botBirth ? 'session.instructions' : 'optional-context',
                    ref: { kind: 'doc', artifactId: unavailableArtifactId, ...(botBirth ? { serverId: homeId } : {}) },
                    enabled: true, placement: 'system_append', required: false }] } : {}),
                initialInput: { text: conversationFixture?.firstInput ?? 'Reply with recipient input accepted.' },
                agentTarget: { kind: 'agent', identity: retainedRunner
                    ? { pluginId: fixturePluginId, localId: fixtureLocalId }
                    : { pluginId: 'happier.agent.claude', localId: 'claude' } } }), creationKey };
            const input = botBirth ? buildSessionSpawnNewInputV2FromAuthoringDraft({ creationKey,
                initialMessage: schemaInput.initialInput?.text,
                permissionMode: 'default', configurationUpdatedAtMs: Date.now(),
                draft: buildNewSessionAuthoringDraftFromResolvedInputs({ directory: database.baseDir,
                    executionTarget: { kind: 'machine', target: schemaInput.executionTarget },
                    prompt: schemaInput.initialInput?.text ?? '', connectedServices: selectedServices,
                    agentTarget: schemaInput.agentTarget, sessionName: schemaInput.title,
                    initialSessionFacts: schemaInput.identity, promptStack: schemaInput.promptStack }),
            }) : schemaInput;
            const initialInputText = input.initialInput?.text;
            if (typeof initialInputText !== 'string') throw new Error('Missing authored fixture input text');
            const scope = { serverId: homeId, accountId: requester.id };
            const draftId = crypto.randomUUID();
            const draftValues = new Map<string, string>();
            const drafts = createSessionDraftRepository({ storage: { getString: key => draftValues.get(key), getAllKeys: () => [...draftValues.keys()],
                set: (key, value) => { draftValues.set(key, value); }, delete: key => { draftValues.delete(key); } }, syncEnabled: false });
            const attachmentSource = { kind: 'memory' as const, bytes: new Uint8Array([11, 22, 33]), name: 'first-turn.txt' };
            const attachments = [{ id: 'first-turn-attachment', status: 'pending' as const, source: attachmentSource }];
            if (lateTeamReconnect) {
                drafts.writeNewSessionDraft({ scope, draftId, materializationIntent: 'userEdit',
                    patch: { text: initialInputText, attachments: [{ id: attachments[0]!.id }] } });
                writeNewSessionAttachmentDrafts(draftId, attachments);
                onTestFinished(() => clearNewSessionAttachmentDrafts(draftId));
            }
            const draftBefore = drafts.getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
            if (withdrawPreparedAccountPlan) {
                // Retire the actual Settings fact while the required document
                // response is in flight, before native open or input custody
                // can commit a user transcript. The Home and reader stay real.
                onRequiredAccountArtifactResponse = () => {
                    // Catalog migration may inspect document headers before
                    // the runner captures its admission. Withdraw only from
                    // the subsequent real preparation read of that capture.
                    if (accountPlanWithdrawals !== 0 || !withdrawalAccount) return;
                    try {
                        withdrawalHookStage = 'required_artifact_read';
                        expect(requiredAccountArtifactReads).toBeGreaterThan(0);
                        const current = getActiveAccountSettingsSnapshot();
                        withdrawalHookStage = 'account_present';
                        if (!withdrawalAccount || !current || !withdrawalAdmittedCatalog)
                            throw new Error('Prepared Account prompt catalog was not observed');
                        withdrawalHookStage = 'account_scope';
                        expect(current.scopeKey).toBe(withdrawalAccount.scopeKey);
                        withdrawalHookStage = 'account_lifetime';
                        expect(getActiveAccountSettingsSnapshotLifetimeToken()).toBe(withdrawalAccount.lifetimeToken);
                        // Current global catalogue maintenance cannot replace
                        // the admission facts retained by this preparation.
                        const coding = readPromptLibraryCatalogRecordV1({ catalog: withdrawalAdmittedCatalog, key: 'coding' });
                        withdrawalHookStage = 'coding_inventory';
                        expect(coding).toMatchObject({ status: 'ready', record: { key: 'coding', value: {
                            entries: [expect.objectContaining({ required: true,
                                ref: { kind: 'doc', artifactId: requiredAccountArtifactId } })],
                        } } });
                        // Account logout retires the actual captured lifetime.
                        // A preference or catalog refresh is not withdrawal.
                        withdrawalHookStage = 'account_retirement';
                        clearActiveAccountSettingsSnapshot();
                        expect(getActiveAccountSettingsSnapshot()).toBeNull();
                        expect(getActiveAccountSettingsSnapshotLifetimeToken()).not.toBe(withdrawalAccount.lifetimeToken);
                        accountPlanWithdrawals += 1;
                        withdrawalHookStage = 'published';
                        console.info('SESSIONOPEN withdrawal publication', JSON.stringify({ reason: 'account-lifetime-retired', accountPlanWithdrawals }));
                    } catch (error) {
                        // A fixture assertion must not disappear inside the real
                        // transport's unavailable handling and become a five-minute wait.
                        rejectChildStartup(new Error(`Late withdrawal fixture hook failed at ${withdrawalHookStage}`));
                        throw error;
                    }
                };
                onTestFinished(() => { onRequiredAccountArtifactResponse = null; });
            }
            const openStartedAt = performance.now();
            const openStartedAtMs = Date.now();
            const committedSessions: string[] = [];
            let physicalLaunchesAtCommitted: number | undefined;
            const observerAccount = observeCommitted ? await captureLazyActionAccountContext(learnedProfile.id) : null;
            if (observerAccount) onTestFinished(() => observerAccount.dispose());
            // The default UI owner correctly uses direct RPC for its own Machine.
            // Its supported host port lets this slice exercise the real signed
            // Home carrier without inventing shared-Machine isolation support.
            const observerExecutor: Parameters<typeof executeSessionSpawnNewAction>[2] = observerAccount ? {
                execute: async (actionId, payload, actionContext) => {
                    if (actionId !== 'session.spawn_new' && actionId !== 'action.operations.get') throw new Error('Unexpected committed observer Action');
                    expect(actionContext?.actionRequestId).toBe(requestId);
                    return await executeOriginalAccountMachineAction({ account: observerAccount,
                        actionId, requestId, machineId: machine.id, input: payload, authority: 'present_user',
                        invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' },
                        signal: actionContext?.signal });
                },
            } : undefined;
            if (retainedRunner) console.info('SESSIONOPEN composed open started', { journey, openStartedAtMs });
            const observe = observeCommitted ? {
                operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1, 2, 3] } },
                onCommitted: (receipt: Readonly<{ sessionId: string }>) => {
                    physicalLaunchesAtCommitted = physicalLaunches;
                    committedSessions.push(receipt.sessionId);
                    releaseObservedStartup();
                },
            } : undefined;
            const actionContext = { surface: 'ui' as const, authority: 'present_user' as const, actionRequestId: requestId };
            const manualParams = { scope, machineHomeDir: database.baseDir, userAttemptId: requestId,
                seedNonce: `late-native-${requestId}`, observation: observe,
                executeAction: (payload: Parameters<typeof executeSessionSpawnNewAction>[0],
                    context: Parameters<typeof executeSessionSpawnNewAction>[1],
                    observation?: Parameters<typeof executeSessionSpawnNewAction>[3]) =>
                    executeSessionSpawnNewAction(payload, context, observerExecutor, observation) };
            const manual = lateTeamReconnect ? await executeManualSessionSpawnNewAction(input, actionContext, manualParams) : null;
            if (manual && manual.status !== 'executed') throw new Error('Manual launch custody unavailable');
            const outcome = manual?.status === 'executed' ? manual.action : retainedRunner ? await Promise.race([childStartupFailure, (async () => {
                // The shared recipient's Account Action enters the same real
                // installed ingress and retained runner as the composer path.
                const account = await captureLazyActionAccountContext(learnedProfile.id);
                try {
                    const execution = await executeOriginalAccountMachineAction({ account,
                        actionId: 'session.spawn_new', requestId, machineId: machine.id,
                        input: projectSessionSpawnNewActionInputV2(input), authority: 'present_user' });
                    return execution.ok ? { ok: true as const,
                        result: readSessionSpawnNewActionResultV1(SessionSpawnNewActionResultV1Schema.parse(execution.result)) } : execution;
                } finally { account.dispose(); }
            })()]) : await executeSessionSpawnNewAction(input, actionContext, observerExecutor ?? createDefaultActionExecutor(), observe);
            if (disconnectAgentRegistration) {
                // Sensitivity is decided at the same real UI entry output as
                // the positive, never by a fixture activation assertion.
                expect(outcome).toMatchObject({ ok: true, result: { type: 'error' } });
                expect(outcome).not.toMatchObject({ result: { code: 'incompatible_target',
                    incompatibleTarget: { reason: 'daemon_rpc_unavailable' } } });
                expect(daemonReceipts).toBe(1);
                expect(nativeReplyLaunches).toBe(0);
                console.info('SESSIONOPEN registration removal real entry refused', JSON.stringify({
                    code: outcome.ok && outcome.result.type === 'error' ? outcome.result.code : null,
                    physicalLaunches, nativeReplyLaunches,
                }));
                return;
            }
            if (lateTeamReconnect) {
                expect(outcome, JSON.stringify({ outcome, httpResults, physicalLaunches, daemonReceipts, nativeFailureCode }))
                    .toMatchObject({ ok: true, result: { type: 'error', code: 'spawn_failed', retryable: false,
                        launchError: { code: 'connected_service_credential_reconnect_required' } } });
                if (!outcome.ok || outcome.result.type !== 'error') throw new Error('Missing native startup refusal');
                expect(nativeBindingRequests).toBe(1);
                expect(inputAdmissionRequests).toBe(0);
                expect(nativeStartupRevision).toBeGreaterThan(0);
                expect(physicalLaunchesAtCommitted).toBe(0);
                expect(committedSessions).toHaveLength(1);
                expect(physicalLaunches).toBe(1);
                expect(readRunnerClient()).not.toBeNull();
                expect(await db.sessionPendingMessage.count({ where: { sessionId: committedSessions[0] } })).toBe(0);
                expect(await db.sessionMessage.count({ where: { sessionId: committedSessions[0], messageRole: 'user' } })).toBe(0);
                expect(resolveSessionSpawnNewResultFailureMessageKey(outcome.result))
                    .toBe('connectedServices.diagnostics.body.connected_service_credential_reconnect_required');
                expect(resolveSessionSpawnNewResultFailureMessage(outcome.result)).toContain('connected_service_credential_reconnect_required');
                expect(resolveSessionSpawnNewResultFailureMessage(outcome.result)).not.toContain('PRIVATE_NATIVE_DIAGNOSTIC');
                if (!manual || manual.status !== 'executed') throw new Error('Missing committed manual custody');
                const custody = manual.custody;
                expect(custody).toMatchObject({ createdSessionId: committedSessions[0],
                    attachmentMessageLocalId: custody.firstTurnLocalId });
                const beforeReobserve = readSpawnAttemptCustodyState(scope);
                expect(beforeReobserve.status).toBe('valid');
                expect(drafts.getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })).toBe(draftBefore);
                expect(readNewSessionAttachmentDrafts(draftId)).toEqual(attachments);
                expect(readNewSessionAttachmentDrafts(draftId)[0]?.source).toBe(attachmentSource);
                expect(attachmentSource.bytes).toEqual(new Uint8Array([11, 22, 33]));
                // Reconcile the retained terminal observation, not a new user Retry intent.
                const requestsBeforeReobserve = spawnEnvelopes.length;
                const reobserved = await executeManualSessionSpawnNewAction(input, actionContext, { ...manualParams, observation: undefined });
                expect(reobserved).toMatchObject({ status: 'executed', action: outcome, custody: {
                    nonce: custody.nonce, firstTurnLocalId: custody.firstTurnLocalId, createdSessionId: committedSessions[0] } });
                expect(physicalLaunches).toBe(1);
                expect(nativeBindingRequests).toBe(1);
                expect(inputAdmissionRequests).toBe(0);
                expect(spawnEnvelopes).toHaveLength(requestsBeforeReobserve);
                expect(await db.sessionPendingMessage.count({ where: { sessionId: committedSessions[0] } })).toBe(0);
                expect(await db.sessionMessage.count({ where: { sessionId: committedSessions[0], messageRole: 'user' } })).toBe(0);
                expect(readSpawnAttemptCustodyState(scope)).toEqual(beforeReobserve);
                expect(drafts.getSessionDraftSnapshot(scope, { kind: 'newSession', draftId })).toBe(draftBefore);
                expect(readNewSessionAttachmentDrafts(draftId)[0]?.source).toBe(attachmentSource);
                expect(attachmentSource.bytes).toEqual(new Uint8Array([11, 22, 33]));
                expect(httpResults.filter(({ path }) => path === '/v1/actions/action.operations.get')).toHaveLength(1);
                const executions = spawnEnvelopes.filter(({ path }) => path === '/v1/actions/session.spawn_new');
                const observations = spawnEnvelopes.filter(({ path }) => path === '/v1/actions/action.operations.get');
                const authorizations = spawnEnvelopes.filter(({ path }) => path.endsWith('/execution-authorization'));
                expect(executions.map(({ requestId: id, creationKey: key, initialInput: initial, observeSessionCommit }) =>
                    ({ id, key, initial, observeSessionCommit }))).toEqual([
                    { id: requestId, key: creationKey, initial: input.initialInput, observeSessionCommit: true },
                ]);
                expect(observations).toEqual([expect.objectContaining({ requestId, waitForTerminal: true })]);
                expect(authorizations.map(({ digest }) => digest)).toEqual(spawnEnvelopes
                    .filter(({ path }) => !path.endsWith('/execution-authorization')).map(({ digest }) => digest));
                return;
            }
            expect(outcome, JSON.stringify({ outcome, httpResults, physicalLaunches, daemonReceipts, hostSpawnResult }))
                .toMatchObject({ ok: true, result: { type: 'success' } });
            if (!outcome.ok || outcome.result.type !== 'success') throw new Error('Spawn was not committed');
            if (observeCommitted) {
                expect(physicalLaunchesAtCommitted).toBe(0);
                expect(committedSessions).toEqual([outcome.result.sessionId]);
                const requests = spawnEnvelopes.filter(envelope => envelope.path === '/v1/actions/session.spawn_new');
                const observations = spawnEnvelopes.filter(envelope => envelope.path === '/v1/actions/action.operations.get');
                const authorizations = spawnEnvelopes.filter(envelope => envelope.path.endsWith('/execution-authorization'));
                expect(requests.map(({ requestId: id, observeSessionCommit }) => ({ requestId: id, observeSessionCommit })))
                    .toEqual([{ requestId, observeSessionCommit: true }]);
                expect(observations).toEqual([expect.objectContaining({ requestId, waitForTerminal: true })]);
                const observedRequests = spawnEnvelopes.filter(({ path }) => !path.endsWith('/execution-authorization'));
                expect(authorizations.map(({ digest }) => digest)).toEqual(observedRequests.map(({ digest }) => digest));
                expect(new Set(observedRequests.map(({ digest }) => digest)).size).toBe(2);
                expect(physicalLaunches).toBe(1);
            }
            const spawnResult = outcome.result;
            expect(SessionSpawnNewResultV1Schema.parse(outcome.result)).toMatchObject({ executionTarget: input.executionTarget });
            expect(outcome.result.initialInput).toMatchObject({ status: 'accepted' });
            // Creation rejoin can observe the committed Session before the
            // outstanding daemon launch reports readiness. Observe that same
            // root's completed startup, not just the early birth fact.
            if (fullHostRuntime) {
                await Promise.race([childStartupFailure, vi.waitFor(() => {
                    expect(hostSpawnResult).toBeDefined();
                }, { timeout: resolveSessionStartupTimeoutMs() })]);
                expect(hostSpawnResult, JSON.stringify(hostSpawnResult)).toMatchObject({ type: 'success', sessionId: outcome.result.sessionId });
                expect(physicalLaunches).toBe(1);
            }
            if (retainedRunner) {
                // The daemon ACK precedes the host's initialized callback.
                // Join that real runner stage before inspecting its client.
                const child = readInProcessRunner();
                if (!child) throw new Error('Missing physically launched retained runner');
                await Promise.race([childStartupFailure, child.ready]);
            }
            const currentRunner = readRunnerClient();
            if (!currentRunner) throw new Error('Missing requester runner');
            if (observeCommitted) {
                const initial = outcome.result.initialInput;
                if (initial.status !== 'accepted') throw new Error('Missing original input admission');
                expect(await db.sessionPendingMessage.findMany({ where: { sessionId: outcome.result.sessionId },
                    select: { localId: true } })).toEqual([{ localId: initial.localId }]);
                expect(await db.sessionMessage.count({ where: { sessionId: outcome.result.sessionId, messageRole: 'user' } })).toBe(0);
                expect(daemonReceipts).toBe(2);
                expect(httpResults.filter(({ path }) => path === '/v1/actions/action.operations.get')).toHaveLength(1);
                return;
            }
            if (retainedRunner) {
                expect(await currentRunner.ensureMetadataSnapshot({ timeoutMs: resolveSessionStartupTimeoutMs() }))
                    .toMatchObject({ runtimeDescriptorV1: { agentId: `${fixturePluginId}/${fixtureLocalId}` } });
                if (botBirth) {
                    expect(input).toMatchObject({ identity: { bot: { kind: 'bot' }, createdAsBot: true },
                        promptStack: [{ id: 'session.instructions', required: false }] });
                    expect(await currentRunner.ensureMetadataSnapshot({ timeoutMs: resolveSessionStartupTimeoutMs() }))
                        .toMatchObject({ bot: { kind: 'bot' }, createdAsBot: true,
                            work: { promptStack: [expect.objectContaining({ id: 'session.instructions',
                                ref: { kind: 'doc', artifactId: unavailableArtifactId, serverId: homeId } })] } });
                }
                const acceptedInput = outcome.result.initialInput;
                if (acceptedInput.status !== 'accepted') throw new Error('Runner input lacks committed admission identity');
                const acceptedInputLocalId = acceptedInput.localId;
                if (!acceptedInputLocalId) throw new Error('Runner input lacks its exact local identity');
                if (withdrawPreparedAccountPlan) {
                    let observedTurns: Array<{ status: string; code?: string; source?: string; causeCode?: string }> = [];
                    try {
                        await Promise.race([childStartupFailure, vi.waitFor(async () => {
                            const turns = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/turns`,
                                headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                            expect(turns.statusCode).toBe(200);
                            const projection = SessionTurnsProjectionV1Schema.parse(turns.json());
                            observedTurns = projection.turns.map(turn => ({ status: turn.status,
                                ...(turn.lastRuntimeIssue ? { code: turn.lastRuntimeIssue.code, source: turn.lastRuntimeIssue.source,
                                    ...(turn.lastRuntimeIssue.failureCause?.code ? { causeCode: turn.lastRuntimeIssue.failureCause.code } : {}) } : {}) }));
                            expect(accountPlanWithdrawals).toBe(1);
                            expect(observedWithdrawal).toEqual({ code: 'context_source_unavailable', status: 'preparation_pending', contextSource: 'account_lifetime' });
                            expect(projection.turns).toEqual(expect.arrayContaining([
                                expect.objectContaining({ status: 'failed', lastRuntimeIssue: expect.objectContaining({
                                    source: 'dependency_failure',
                                }) }),
                            ]));
                            expect(projection.turns.some(turn => turn.status === 'completed')).toBe(false);
                        }, { timeout: resolveSessionStartupTimeoutMs() })]);
                    } catch (error) {
                        console.info('SESSIONOPEN late withdrawal diagnostics', JSON.stringify({
                            accountPlanWithdrawals, requiredAccountArtifactReads, withdrawalHookStage,
                            withdrawal: observedWithdrawal, turns: observedTurns,
                            runnerStages,
                        }));
                        throw error;
                    }
                    await currentRunner.flushDurableMutationDelivery();
                    expect(currentRunner.getCommittedUserMessageSeq(acceptedInputLocalId)).toBeNull();
                    expect(await db.sessionMessage.findUnique({ where: { sessionId_localId: {
                        sessionId: currentRunner.sessionId, localId: acceptedInputLocalId,
                    } } })).toBeNull();
                    const transcript = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/messages`,
                        headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                    expect(transcript.statusCode).toBe(200);
                    expect(transcript.json().messages).not.toEqual(expect.arrayContaining([
                        expect.objectContaining({ messageRole: 'user' }),
                    ]));
                    expect(transcript.json().messages.some((row: { messageRole: string; content: unknown }) =>
                        row.messageRole === 'agent' && JSON.stringify(row.content).includes(initialInputText))).toBe(false);
                    expect(physicalLaunches).toBe(1);
                    expect(daemonReceipts).toBe(1);
                    expect(nativeReplyLaunches).toBe(0);
                    console.info('SESSIONOPEN withdrawal no-effect verified', JSON.stringify({ turns: observedTurns,
                        requiredAccountArtifactReads, withdrawalHookStage }));
                    const failedTurns = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/turns`,
                        headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                    expect(failedTurns.statusCode).toBe(200);
                    const failed = SessionTurnsProjectionV1Schema.parse(failedTurns.json()).turns.find(turn => turn.status === 'failed');
                    const producerCause = readObservedWithdrawal();
                    if (!producerCause || !failed?.lastRuntimeIssue) throw new Error('Missing real withdrawal producer or public failed-Turn sink');
                    // Both existing public carriers are typed and content-free.
                    // A generic preparation state cannot satisfy this cause gate.
                    expect(failed.lastRuntimeIssue.failureCause?.code ?? failed.lastRuntimeIssue.code,
                        'The public failed Turn must retain the actual Account withdrawal cause').toBe(producerCause.code);
                    return;
                }
                if (disconnectNativeReplyEvents) {
                    await Promise.race([childStartupFailure, vi.waitFor(async () => {
                        const transcript = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/messages`,
                            headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                        expect(transcript.statusCode).toBe(200);
                        expect(transcript.json().messages).toEqual(expect.arrayContaining([
                            expect.objectContaining({ messageRole: 'user', content: { t: 'plain', v: expect.objectContaining({
                                content: { type: 'text', text: initialInputText },
                            }) } }),
                        ]));
                    }, { timeout: resolveSessionStartupTimeoutMs() })]);
                    const committedUser = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: {
                        sessionId: currentRunner.sessionId, localId: acceptedInputLocalId,
                    } } });
                    await vi.waitFor(async () => {
                        const turns = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/turns`,
                            headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                        expect(turns.statusCode).toBe(200);
                        expect(SessionTurnsProjectionV1Schema.parse(turns.json()).turns).toEqual(expect.arrayContaining([
                            expect.objectContaining({ status: 'completed', transcriptAnchors: expect.objectContaining({
                                startUserMessageSeq: committedUser.seq, userMessageSeqs: [committedUser.seq],
                            }) }),
                        ]));
                        expect(SessionTurnsProjectionV1Schema.parse(turns.json()).turns[0]?.transcriptAnchors?.finalAssistantMessageSeq)
                            .not.toEqual(expect.any(Number));
                    }, { timeout: resolveSessionStartupTimeoutMs() });
                    const terminalTranscript = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/messages`,
                        headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                    expect(terminalTranscript.statusCode).toBe(200);
                    expect(await db.sessionMessage.findUnique({ where: { sessionId_localId: {
                        sessionId: currentRunner.sessionId, localId: `${acceptedInputLocalId}:assistant`,
                    } } })).toBeNull();
                    expect(await db.sessionPendingMessage.count({ where: { sessionId: currentRunner.sessionId } })).toBe(0);
                    expect(await db.session.count({ where: { accountId: requester.id } })).toBe(1);
                    expect(nativeReplyLaunches).toBe(1);
                    expect(physicalLaunches).toBe(1);
                    expect(runnerStages.some(({ stage }) => stage === 'runner_settled')).toBe(false);
                    console.info('SESSIONOPEN reply wiring sensitivity', JSON.stringify({ journey,
                        nativeAssistantEvent: 'disconnected', userMessageSeq: committedUser.seq,
                        turnStatus: 'completed', matchingAssistantReply: false }));
                    return;
                }
                let firstReplyStoredCreatedAtMs: number | null = null;
                let firstReplyStoredMessageId: string | null = null;
                // The host's completion contract waits for transcript ACKs.
                // Once this turn settles, missing required output is a failure,
                // not a future row to poll for after terminal admission.
                await Promise.race([childStartupFailure, vi.waitFor(async () => {
                    const turns = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/turns`,
                        headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                    expect(turns.statusCode).toBe(200);
                    const projection = SessionTurnsProjectionV1Schema.parse(turns.json());
                    expect(projection.turns).toHaveLength(1);
                    expect(projection.turns[0]?.status).not.toBe('in_progress');
                }, { timeout: resolveSessionStartupTimeoutMs() })]);
                const settled = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/turns`,
                    headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                expect(SessionTurnsProjectionV1Schema.parse(settled.json()).turns[0]).toMatchObject({ status: 'completed' });
                // Only read the resulting transcript. Pending consumption, native
                // send, lifecycle, transcript commit and turn anchors come from
                // the production host runner, never test orchestration.
                await Promise.race([childStartupFailure, (async () => {
                    const transcript = await app.inject({ method: 'GET', url: `/v1/sessions/${spawnResult.sessionId}/messages`,
                        headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                    expect(transcript.statusCode).toBe(200);
                    expect(transcript.json().messages).toEqual(expect.arrayContaining([
                        expect.objectContaining({ messageRole: 'user', content: { t: 'plain', v: expect.objectContaining({
                            content: { type: 'text', text: initialInputText },
                        }) } }),
                        expect.objectContaining({ messageRole: 'agent', content: { t: 'plain', v: expect.objectContaining({
                            content: expect.objectContaining({ data: expect.objectContaining({
                                message: ownAccount ? expect.stringMatching(/^git version \S+/) : expect.stringContaining(initialInputText),
                            }) }),
                        }) } }),
                    ]));
                    const rows: unknown = transcript.json().messages;
                    if (Array.isArray(rows)) {
                        const reply = rows.find(row => row && typeof row === 'object'
                            && Reflect.get(row, 'messageRole') === 'agent'
                            && JSON.stringify(Reflect.get(row, 'content')).includes(ownAccount ? 'git version ' : initialInputText));
                        const createdAt = reply && typeof reply === 'object' ? Reflect.get(reply, 'createdAt') : null;
                        firstReplyStoredCreatedAtMs = typeof createdAt === 'number' ? createdAt : null;
                        const messageId = reply && typeof reply === 'object' ? Reflect.get(reply, 'id') : null;
                        firstReplyStoredMessageId = typeof messageId === 'string' ? messageId : null;
                    }
                })()]);
                const openToFirstReplyObservedMs = performance.now() - openStartedAt;
                const committedUser = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: {
                    sessionId: currentRunner.sessionId, localId: acceptedInputLocalId,
                } } });
                if (!firstReplyStoredMessageId) throw new Error('Committed assistant reply lacks its server transcript identity');
                const committedReply = await db.sessionMessage.findUniqueOrThrow({ where: { id: firstReplyStoredMessageId } });
                expect(committedReply.sessionId).toBe(currentRunner.sessionId);
                expect(committedReply.localId).toBe(`${acceptedInputLocalId}:assistant`);
                expect(committedUser.messageRole).toBe('user');
                expect(committedReply.messageRole).toBe('agent');
                expect(committedUser.sidechainId).toBeNull();
                expect(committedReply.sidechainId).toBeNull();
                if (ownAccount) {
                    const stored = SessionStoredMessageContentSchema.parse(typeof committedReply.content === 'string'
                        ? JSON.parse(committedReply.content) : committedReply.content);
                    expect(stored).toMatchObject({ t: 'plain', v: { content: { data: {
                        message: expect.stringMatching(/^git version \S+/),
                    } } } });
                    expect(JSON.stringify(stored)).not.toContain(initialInputText);
                    expect(nativeReplyLaunches).toBe(1);
                }
                expect(await db.sessionMessage.count({ where: { sessionId: currentRunner.sessionId, messageRole: 'user' } })).toBe(1);
                expect(await db.sessionPendingMessage.count({ where: { sessionId: currentRunner.sessionId } })).toBe(0);
                console.info('SESSIONOPEN composed timings', JSON.stringify({
                    journey, entry: 'executeOriginalAccountMachineAction/session.spawn_new',
                    openToFirstReplyObservedMs, openStartedAtMs, firstReplyStoredCreatedAtMs,
                    openToFirstReplyStoredCreatedMs: firstReplyStoredCreatedAtMs === null ? null : firstReplyStoredCreatedAtMs - openStartedAtMs,
                    runnerStages,
                }));
                const initialTurns = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/turns`,
                    headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                console.info('SESSIONOPEN actual turn projection', JSON.stringify({ journey,
                    statusCode: initialTurns.statusCode, projection: initialTurns.json(),
                    committedUserSeq: committedUser.seq, committedReplySeq: committedReply.seq,
                    assistantIsMainChain: committedReply.sidechainId === null }));
                // Completion follows transcript commit. Read the canonical
                // strict projection and require anchors for these exact rows.
                await vi.waitFor(async () => {
                    const turns = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/turns`,
                        headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                    expect(turns.statusCode).toBe(200);
                    expect(SessionTurnsProjectionV1Schema.parse(turns.json()).turns).toEqual(expect.arrayContaining([
                        expect.objectContaining({ status: 'completed', transcriptAnchors: expect.objectContaining({
                            startUserMessageSeq: committedUser.seq, userMessageSeqs: [committedUser.seq],
                            startSeqInclusive: committedUser.seq, endSeqInclusive: committedReply.seq,
                            finalAssistantMessageSeq: committedReply.seq,
                        }) }),
                    ]));
                }, { timeout: resolveSessionStartupTimeoutMs() });
                expect(await db.session.findUniqueOrThrow({ where: { id: outcome.result.sessionId } }))
                    .toMatchObject({ accountId: requester.id });
                expect(await db.session.count({ where: { accountId: requester.id } })).toBe(1);
                if (optionalPromptUnavailable) {
                    expect(unavailableArtifactReads).toBeGreaterThan(0);
                    const transcript = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/messages`,
                        headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
                    const notices = transcript.json().messages.flatMap((row: { content: unknown }) => {
                        const stored = SessionStoredMessageContentSchema.parse(row.content);
                        if (typeof stored === 'string' || stored.t !== 'plain') return [];
                        const event = stored.v && typeof stored.v === 'object' && 'content' in stored.v ? stored.v.content : null;
                        const data = event && typeof event === 'object' && 'data' in event ? event.data : null;
                        return readSessionCapabilityNoticeV1(data)?.items ?? [];
                    });
                    expect(notices).toContainEqual({ kind: 'prompt_library', name: 'Prompt library', code: 'prompt_library_unavailable' });
                    expect(JSON.stringify(notices)).not.toContain(unavailableArtifactId);
                    expect(JSON.stringify(notices)).not.toContain(ownerToken);
                }
                expect(physicalLaunches).toBe(1);
                expect(daemonReceipts).toBe(1);
                return;
            }
            const consumed = await currentRunner.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
            expect(consumed).toMatchObject({ type: 'materialized' });
            if (consumed.type !== 'materialized') throw new Error('Initial input was not consumed');
            const storedPrompt = SessionStoredMessageContentSchema.parse(consumed.content);
            if (typeof storedPrompt === 'string' || storedPrompt.t !== 'plain') throw new Error('Expected Plain requester input');
            expect(storedPrompt.t).toBe('plain');
            const prompt = UserMessageSchema.parse(storedPrompt.v);
            expect(prompt.content).toEqual({ type: 'text', text: initialInputText });
            const provider = 'claude';
            const turnId = `session-turn:${crypto.randomUUID()}`;
            const replyId = `${consumed.localId}:assistant`;
            const lifecycle = createSessionTurnLifecycle({ session: currentRunner, agentId: provider,
                readTurnFacts: () => ({ initiator: 'user', workDepth: 0 }) });
            lifecycle.observeRuntimeEvent(AgentSessionRuntimeEventSchema.parse({ sequence: 1,
                sessionId: currentRunner.sessionId, emittedAtMs: Date.now(), kind: 'turn-start', turnId, startedBy: 'host' }));
            await lifecycle.drainAcceptedLifecycle();
            // Current pending admission can return seq:null until the external
            // Agent acknowledges this claimed prompt into the transcript.
            expect(await projectRuntimeTranscriptEvent({ session: currentRunner, provider,
                event: AgentSessionRuntimeEventSchema.parse({ sequence: 2, sessionId: currentRunner.sessionId,
                    emittedAtMs: Date.now(), kind: 'transcript-message-committed', turnId,
                    messageId: consumed.localId, role: 'user', text: prompt.content.text }),
            })).toEqual({ projected: true, kind: 'transcript-message-committed' });
            const committedUser = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: {
                sessionId: currentRunner.sessionId, localId: consumed.localId,
            } } });
            // The external Agent responds to this consumed prompt. Its strict event
            // enters the production transcript projector on the same primary turn.
            expect(await projectRuntimeTranscriptEvent({ session: currentRunner, provider,
                event: AgentSessionRuntimeEventSchema.parse({ sequence: 3, sessionId: currentRunner.sessionId,
                    emittedAtMs: Date.now(), kind: 'transcript-message-committed', turnId,
                    messageId: replyId, role: 'assistant', text: 'recipient input accepted' }),
            })).toEqual({ projected: true, kind: 'transcript-message-committed' });
            const transcript = await app.inject({ method: 'GET', url: `/v1/sessions/${outcome.result.sessionId}/messages`,
                headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
            expect(transcript.statusCode).toBe(200);
            expect(transcript.json().messages).toEqual(expect.arrayContaining([
                expect.objectContaining({ messageRole: 'user', content: { t: 'plain', v: expect.objectContaining({
                    content: { type: 'text', text: initialInputText },
                }) } }),
                expect.objectContaining({ messageRole: 'agent', content: { t: 'plain', v: expect.objectContaining({
                    content: expect.objectContaining({ data: { type: 'message', message: 'recipient input accepted' } }),
                }) } }),
            ]));
            const reply = await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: {
                sessionId: currentRunner.sessionId, localId: replyId,
            } } });
            // Test orchestration supplies causal transcript anchors using the
            // public turn mutation owner; this is not Agent-native anchor evidence.
            await currentRunner.enqueueSessionTurnMutation({ v: 1, sessionId: currentRunner.sessionId,
                mutationId: crypto.randomUUID(), observedAt: Date.now(), agentId: provider,
                action: 'append_transcript_anchors', turnId, transcriptAnchors: {
                    startUserMessageSeq: committedUser.seq, userMessageSeqs: [committedUser.seq],
                    startSeqInclusive: committedUser.seq, endSeqInclusive: reply.seq, finalAssistantMessageSeq: reply.seq,
                } });
            // Anchors are admitted while the turn is active. The retained
            // runner cases supply them through the actual host terminal owner.
            lifecycle.observeRuntimeEvent(AgentSessionRuntimeEventSchema.parse({ sequence: 4,
                sessionId: currentRunner.sessionId, emittedAtMs: Date.now(), kind: 'turn-complete', turnId }));
            await lifecycle.drainAcceptedLifecycle();
            await currentRunner.flushDurableMutationDelivery();
            const turns = await app.inject({ method: 'GET', url: `/v1/sessions/${currentRunner.sessionId}/turns`,
                headers: { authorization: `Bearer ${requesterToken}`, 'x-happier-account-stored-content-protocol': '4' } });
            expect(turns.statusCode).toBe(200);
            expect(turns.json().turns).toEqual(expect.arrayContaining([expect.objectContaining({ turnId,
                status: 'completed', transcriptAnchors: expect.objectContaining({ startUserMessageSeq: committedUser.seq,
                    finalAssistantMessageSeq: reply.seq }) })]));
            expect(await db.session.findUniqueOrThrow({ where: { id: outcome.result.sessionId } })).toMatchObject({ accountId: requester.id });
            expect(physicalLaunches).toBe(1);
            expect(daemonReceipts).toBe(1);
            const requesterSocket = io(endpoint, { path: '/v1/updates', transports: ['websocket'], reconnection: false,
                autoConnect: false, auth: { ...currentAccountStoredContentCompatibilitySocketAuth, token: requesterToken, clientType: 'user-scoped' } });
            onTestFinished(() => { requesterSocket.disconnect(); });
            await new Promise<void>((resolve, reject) => {
                requesterSocket.once('connect', resolve); requesterSocket.once('connect_error', reject); requesterSocket.connect();
            });
            for (const rpcMethod of [RPC_METHODS.SPAWN_HAPPY_SESSION, RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE, RPC_METHODS.SESSION_SPAWN_NEW]) {
                const raw = await new Promise<unknown>(resolve => requesterSocket.emit(SOCKET_RPC_EVENTS.CALL, {
                    method: `${machine.id}:${rpcMethod}`, params: 'opaque-private-spawn',
                }, resolve));
                expect(raw).toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });
            }
            for (const token of [outsiderToken, requesterToken]) {
                if (token === requesterToken) await db.machineAccountGrant.delete({ where: { machineId_accountId: {
                    machineId: machine.id, accountId: requester.id } } });
                const envelope = { v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId: machine.id }, input };
                const denied = await app.inject({ method: 'POST', url: '/v1/actions/session.spawn_new/execution-authorization',
                    headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: machine.id, envelope } });
                expect(denied.statusCode).toBe(409);
            }
            expect(physicalLaunches).toBe(1);
        } finally {
            await disposeHomes();
        }
    });
});

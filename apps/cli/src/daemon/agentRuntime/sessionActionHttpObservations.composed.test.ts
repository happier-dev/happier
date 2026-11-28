import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createDeploymentEnvironmentHeaderV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { createCliProjectAdmission } from '@/session/actions/cliActionDeps/projectAdmission';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import {
  accountSettingsParse, normalizeActionsSettingsV1, SessionListQueryV1Schema,
  FeaturesResponseSchema, type ActionsSettingsV1,
} from '@happier-dev/protocol';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionActionIdV1Schema, projectExternalActionHttpError } from '@happier-dev/protocol/actions/externalActionApi';
import { FILESYSTEM_BROWSER_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { UiActionDispatchRequestV1Schema } from '@happier-dev/protocol/actions/clientDispatchV1';
import { createClientActionReverseDispatcher } from '@/session/actions/clientActionReverseDispatch';
import { executeAdmittedClientActionChild } from '@/session/actions/admittedClientActionChildren';
import { ACCOUNT_SECURITY_PATH_V1, AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { connectedServiceProfileKey } from '@happier-dev/protocol/connect/connectedServiceProfilePreferences';
import { ConnectedPresentationRowReadResponseV1Schema, ConnectedAcknowledgementsRowReadResponseV1Schema,
  ConnectedPresentationRowMutationV1Schema, ConnectedMetadataRowMutationResponseV1Schema,
  CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1,
} from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { readExternalActionSessionSpawnAdmission, verifyExternalActionMachineRpcExecution } from '../../../../server/sources/app/auth/externalActionExecutionAuthorization';
import { parseSessionListQueryActionResultV1 } from '@happier-dev/protocol/sessions/awareness/action';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1, SessionMetadataOwnerPatchV1Schema,
  SessionMetadataTuplePatchSuccessV1Schema, type SessionMetadataOwnerPatchV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { auth } from '../../../../server/sources/app/auth/auth';
import { readSessionAccessAuthenticationFromRequest } from '../../../../server/sources/app/session/access/sessionAccessAuthentication';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { installedSessionExternalActionStorage as storage } from '../../../../server/sources/app/api/testkit/installedSessionExternalActionStorage';
import { registerExternalActionRoutes } from '../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes';
import type { Fastify } from '../../../../server/sources/app/api/types';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { stubUndiciFetch } from '@/testkit/http/stubUndiciFetch';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture, createCompactSessionListQueryResponseFixture, createSessionReadBatchResponseFixture } from '@/testkit/backends/sessionFixtures';
import { createExternalActionAuthorizedRequestHeaders, prepareExternalActionRequesterAccountAuthorizationResult, resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { projectSessionActionIssuerRefusal } from '@/api/externalActionIssuerRefusal';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createActionAutomationHttpPortV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, ActionAutomationIndexV1Schema } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { createSessionListActionDeps } from '@/session/actions/sessionListActionDependency';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createSessionFollowSourceKeyPreparationAfterSet } from '@/agent/runtime/session/follow/createSessionFollowSourceKeyPreparationAfterSet';
import { logger } from '@/ui/logger';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createDaemonSessionAccountActionExecutor } from './createDaemonSessionAccountActionExecutor';
import { AgentRuntimeDaemonServiceRequestV1Schema, type AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { configuration } from '@/configuration';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { hashPrivateBearer } from '@/daemon/privateBearerFile';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned } from './sessionBridgeAuthorization';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { prepareInstalledRequesterAccountActionContext, prepareRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionProjection";
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import * as installationStore from '@/daemon/identity/store';
import { updateMachineRegistration } from '@/daemon/machineIdentity/machineRegistrationStore';
import { writeJsonAtomicSync } from '@/utils/fs/writeJsonAtomicSync';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeStoredCredentials } from '@/persistence';
import { registerSessionLifecycleRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import { createMachineSessionStopLifecycleActionExecutor } from '@/session/actions/sessionLifecycleActions';
import { MACHINE_SESSION_STOP_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';
import type { AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { projectAgentRuntimeDaemonServiceTurnWitnessV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceTurnWitness';
import { createNativeAgentRuntimeSessionPlanFixture, createNativeSessionClientTestPort,
  createExternalContributionFixtures, createLease, createSessionHostServiceOwners } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { resolveCliAgentStartContextV1 } from '@/session/actions/resolveCliAgentStartContextV1';
import { resolveRolesSnapshotV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { inheritedCodexInput } from '@/session/actions/sessionSpawnNew.agent.testkit';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionCurrentSessionScopeFailureDetailsV1Schema, isLedSubtreeSessionLifecycleActionId } from '@happier-dev/protocol/actions/executor/sessionListAccess';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import { bindDiscussionDraftReply } from '@/discussions/bindDiscussionDraftReply';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { readStoredCredentialsForServerId, writeStoredCredentialsForServerId, updateSettings } from '@/persistence';
import { createDaemonSessionAccountActionAuthorizationPreparer } from '@/daemon/startup/createDaemonSessionAccountActionAuthorizationPreparer';
import { createDaemonApprovalExecutionAuthorizationPreparer } from '@/daemon/externalActions/approvalExecutionAuthorization';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { registerPlainArtifactRoutes } from '@/session/actions/widgetApproval.testkit';
import { createCredentialedAccountArtifactStore, createAcknowledgedAccountArtifactTransport } from '@/api/artifacts/accountArtifactStore';
import { createReviewRecordPortV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { ReviewCommentV1Schema } from '@happier-dev/protocol/reviews/comments/v1';
import { splitReviewCommentV1, sealReviewCommentSensitiveEnvelopeV1 } from '@happier-dev/protocol/reviews/comments/content';
import * as daemonControlHttp from '@/daemon/controlHttp';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { executeAppliedDaemonPluginActionWithController } from '@/plugins/daemon/controlRoutes';
import { createCommittedContributedActionInvoker, createCommittedContributedActionDefinitionLister,
  createCommittedContributedActionSchemaReader } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { PLUGIN_MANIFEST as triageManifest } from '@happier-dev/plugins-triage/manifest';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createClientActionMachineRpcExecutor } from '@/plugins/runtime/invocation/actions/clientActionMachineRpc';
import { UiContributedActionExecuteRequestV1Schema } from '@happier-dev/protocol/plugins/actions/clientInvocationV1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { StrictJsonValueSchema, projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { createCliActionDeps, type SessionActionRpcTransport } from '@/session/actions/createCliActionDeps';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { BasePermissionHandler } from '@/agent/permissions/BasePermissionHandler';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { MachineOperationProtocolCapabilitiesV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { PublicProfileOwnerReadV1Schema, PublicProfilePreparedRequestV1Schema, DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { DiscussionSummaryV1Schema } from '@happier-dev/protocol/discussions/models';
import { DiscussionMessagesQueryV1Schema, DiscussionRouteDiscussionParamsV1Schema } from '@happier-dev/protocol/discussions/api';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { DaemonPluginUiTargetedContributionsReadResponseSchema, DaemonPluginTargetedSourceDeclarationV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { DaemonPluginStructuredMessageActionExecuteRequestSchema } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createConfidentialActionInputsExecutor } from '@/daemon/surfaces/confidentialSecretFill';
import { createCliPersonalSavedSecretActionExecute } from '@/settings/secrets/personalSavedSecretActionHost';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { SharedSavedSecretCreateInputV1Schema, SHARED_SAVED_SECRET_ACTION_PATHS_V1 } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { requirePresentUser } from '../../../../server/sources/app/api/utils/requirePresentUser';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { projectAdmittedExternalActionMachineContext } from '@/daemon/externalActions/execution';
import { createSessionDaemonAuthorityFixture } from '@/mcp/runtime/sessionDaemonAuthority.testkit';
import * as processIdentity from '@/daemon/processIdentity';

// Only database I/O and HTTP delivery are substituted. Home issuance, signature
// verification, Session custody, scope admission and the transport readers run.
vi.mock('../../../../server/sources/storage/db', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../server/sources/storage/db')>(),
  db: (await import('../../../../server/sources/app/api/testkit/installedSessionExternalActionStorage')).installedSessionExternalActionStorage.db,
}));

const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
const sessionId = 'c123456789012345678901230';
const childId = 'c123456789012345678901231';
const serverId = 'signed-session-home';
const serverHttpBaseUrl = 'https://signed-session.test';
type Operation = Extract<AgentRuntimeDaemonServiceRequestV1['operation'], { kind: 'action.execute' }>;

beforeAll(async () => {
  // This canonical database boundary implements PostgreSQL snapshot commands.
  vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
  vi.stubEnv('HANDY_MASTER_SECRET', 'session-observation-test-secret');
  vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
  await auth.init();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });
afterAll(() => vi.unstubAllEnvs());

async function admittedClientActionFixture() {
  let effects = 0;
  const bundled = loadCurrentBundledPluginLocatorResult();
  const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({ loadResult: {
    loadedPlugins: bundled.loadedPlugins.filter(plugin => plugin.pluginId === triageManifest.id)
      .map(plugin => ({ ...plugin, manifest: normalizePluginManifestV2(triageManifest) })), diagnosticsByPluginId: {},
  }, provenance: 'first_party' }));
  const executeClientAction = createClientActionMachineRpcExecutor(() => ({
    hasConnectedClientRpcHandler: () => true,
    // Only the answering UI socket is substituted. Its public ingress schema,
    // Machine-side source admission, descriptor and invocation remain real.
    callConnectedClientRpc: async (_method, raw, options) => {
      UiContributedActionExecuteRequestV1Schema.parse(JSON.parse(JSON.stringify(raw)));
      options.onIssued();
      effects++;
      return { ok: true, result: { ok: true, result: { v: 1, kind: 'createTask', draftId: 'client-draft' } } };
    },
  }));
  const runtime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
    contributes, pluginIds: [triageManifest.id], executeClientAction,
  } });
  return { runtime, action: { pluginId: triageManifest.id, localId: 'tasks/open-create-v1' }, effects: () => effects };
}

it('FX217 keeps wire-only Project discovery separate from private Account projection', async () => {
  const f = await fixture();
  try {
    const op = f.operation('projects.list', {});
    const prepared = await f.prepare(op, { v: 1, caller: op.witness.agentStartCaller,
      sourceTurnId: 'turn', callerPermissionMode: null, requestId: op.requestId });
    if (!prepared) throw new Error('Missing Home-minted Project discovery authorization');
    expect(prepared.authorization.requesterHttpProjection).toBeDefined();
    // Home mints a wire root, not a local Account reader. The installed parent
    // positive lives in startDaemonSessionControlRuntime.projectLaunch's real
    // Session Action producer; ordinary credentials here cannot replace it.
    expect(prepared.authorization.requesterAccountProjection).toBeUndefined();
    const admission = createCliProjectAdmission({ credentials: f.credentials, serverId, serverHttpBaseUrl }, {
      projectHomeId: serverId, actionHomeId: storage.state.homeId,
      executionRunActionFailure: errorCode => ({ ok: false, errorCode, error: errorCode }),
    });
    expect(await admission.projectAccountAdmission(undefined, { surface: 'agent',
      externalActionExecutionAuthorization: prepared.authorization })).toMatchObject({
        ok: false, errorCode: 'project_requester_authority_unavailable',
      });
  } finally { await f.close(); }
});

it.each(['projects.execution.output.read', 'projects.execution.output.copy'] as const)('FX217 admits both retained Script output phases through Home under %s', async actionId => {
  const f = await fixture();
  try {
    const operationId = 'bd63318b-646f-4476-9e44-6cba58570229';
    storage.state.operationProtocolCapabilities = MachineOperationProtocolCapabilitiesV1Schema.parse({
      requesterExecutionIsolation: { protocolVersions: [1] },
    });
    storage.state.operationProtocolCapabilitiesRevision = 1;
    const op = f.operation(actionId, { serverId, machineId: storage.state.machineId, operationId, byteOffset: 7 });
    const issued = await f.prepareResult(op, { v: 1, caller: op.witness.agentStartCaller,
      sourceTurnId: 'turn', callerPermissionMode: null, requestId: op.requestId });
    if ('ok' in issued) throw new Error(`Missing Home-minted Project output authorization: ${JSON.stringify(issued)}`);
    const prepared = { authorization: issued.authorization, target: { kind: 'machine' as const, machineId: storage.state.machineId } };
    const { ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
    const operation = { version: 1, operationId, revision: 1, actionId: 'projects.script.run', state: 'succeeded',
      scope: { accountId: storage.account.id, machineId: storage.state.machineId }, title: 'Build', createdAt: 1,
      startedAt: 1, settledAt: 2, cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'script',
        serverId, machineId: storage.state.machineId, workspaceRefId: 'workspace', cwd: '/project', terminalId: 'retained-terminal' },
    } satisfies ActionOperationSnapshotV1;
    const output = { ok: true as const, terminalId: 'retained-terminal', frames: [], nextByteOffset: 7,
      availableByteOffset: 7, droppedBeforeByteOffset: 7, done: true };
    const admittedMethods: string[] = [];
    const result = await executeActionOperationActionV1({ actionId,
      input: { serverId, machineId: storage.state.machineId, operationId, byteOffset: 7 },
      transport: async request => {
        const method = `${request.machineId}:${request.method}`;
        const execution = { v: 1 as const, authorization: prepared.authorization, effectActionId: actionId,
          target: prepared.target, installationId: storage.state.installationId,
          machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: prepared.authorization.token,
            effectActionId: actionId, target: prepared.target, installationId: storage.state.installationId,
            method, requestId: op.requestId, params: request.payload, privateKey: installation.secretKey }) };
        expect((await verifyExternalActionMachineRpcExecution(execution, { method, params: request.payload,
          requestId: op.requestId, resolveCurrentSessionMachine: async () => storage.state.machineId })) !== null, request.method).toBe(true);
        // Full method/body signatures and the current original Session remain
        // deciding; composite purpose is not a general terminal/operation grant.
        expect((await verifyExternalActionMachineRpcExecution(execution, { method, params: { terminalId: 'other-terminal' },
          requestId: op.requestId, resolveCurrentSessionMachine: async () => storage.state.machineId })) === null).toBe(true);
        expect((await verifyExternalActionMachineRpcExecution(execution, { method, params: request.payload,
          requestId: op.requestId, resolveCurrentSessionMachine: async () => null })) === null).toBe(true);
        admittedMethods.push(request.method);
        if (request.method === ACTION_OPERATION_RPC_METHODS_V2.get) {
          expect(request.payload).toEqual({ operationId });
          return { kind: 'found', operation };
        }
        expect(request.method).toBe(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES);
        expect(request.payload).toEqual({ terminalId: operation.domainRef.terminalId, byteOffset: 7 });
        return output;
      } });
    expect(result).toEqual(actionId === 'projects.execution.output.read' ? output : { kind: 'bytes', output });
    expect(admittedMethods).toEqual([ACTION_OPERATION_RPC_METHODS_V2.get, RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES]);
  } finally { await f.close(); }
});

it.each(['projects.execution.output.read', 'projects.execution.output.copy'] as const)('uses the Session requester Account for shared-Machine %s', async actionId => {
  const f = await fixture();
  const machineId = 'shared-worker';
  const operationId = '44adc451-ec3d-4ce7-b24a-7aecbf517eb9';
  const input = { serverId, machineId, operationId, byteOffset: 7 };
  const operation = { version: 1, operationId, revision: 1, actionId: 'projects.script.run', state: 'succeeded',
    scope: { accountId: storage.account.id, machineId }, title: 'Build', createdAt: 1, startedAt: 1,
    settledAt: 2, cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'script',
      serverId, machineId, workspaceRefId: 'workspace', cwd: '/project', terminalId: 'retained-terminal' },
  } satisfies ActionOperationSnapshotV1;
  const terminalId = operation.domainRef.terminalId;
  const output = { ok: true as const, terminalId, frames: [{ t: 'bytes', terminalId, seq: 0, byteOffset: 7,
    byteLength: 5, encoding: 'base64', data: Buffer.from('hello').toString('base64') }],
    nextByteOffset: 12, availableByteOffset: 12, droppedBeforeByteOffset: 7, done: true };
  const { ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
  let operationVisible = true;
  let byteReads = 0;
  // The remote Machine transport is the I/O boundary. The Session executor,
  // Action policy, operation lookup and attachment-to-byte routing stay real.
  vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
    expect(request).toMatchObject({ machineId, credentials: f.credentials, authorityCeiling: 'account_automation' });
    expect(request.externalAction).toBeUndefined();
    if (request.method === ACTION_OPERATION_RPC_METHODS_V2.get) {
      expect(request.request).toEqual({ operationId });
      return operationVisible ? { kind: 'found', operation } : { kind: 'not_found' };
    }
    expect(request.method).toBe(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES);
    expect(request.request).toEqual({ terminalId, byteOffset: 7 });
    byteReads++;
    return output;
  });
  try {
    const refusal = projectExternalActionHttpError('target_unavailable', f.operation(actionId, input).requestId);
    f.failAuthorization(409, undefined, refusal.payload);
    const execute = () => f.execute({ ...f.operation(actionId, input), surface: 'mcp' }, { sessionId, isCurrent: async () => true });
    const result = actionId === 'projects.execution.output.read' ? output : { kind: 'bytes', output };
    const execution = await execute();
    expect(execution, execution.ok ? undefined : execution.errorCode).toMatchObject({ ok: true, result });
    operationVisible = false;
    expect(await execute()).toMatchObject({ ok: false, errorCode: 'operation_not_found' });
    expect(byteReads).toBe(1);
    expect(f.observations.filter(row => row.path === bindExternalActionExecutionAuthorizationHttpPathV1(actionId))).toEqual([]);
  } finally { await f.close(); }
});

function installClientMachineControlHttp(clientAction: Pick<Awaited<ReturnType<typeof admittedClientActionFixture>>, 'runtime'>) {
  const list = createCommittedContributedActionDefinitionLister({
    tryAcquireRuntimeRegistryLease: () => clientAction.runtime.lease,
  });
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
    listContributedActionDefinitions: list,
    readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
    invokeContributedAction: createCommittedContributedActionInvoker({
      acquireRuntimeRegistryLease: () => clientAction.runtime.controller.acquireRuntimeRegistry(),
    }),
  });
  // Mirror only controlServer.ts's HTTP dispatch branch: its three supported
  // built-ins enter the full core executor; qualified effects use the final
  // contributed dispatcher. All metadata, admission and policy remain real.
  vi.spyOn(daemonControlHttp, 'daemonPost').mockImplementation(async (_path, body) => {
    if (!body || typeof body !== 'object' || !('actionId' in body) || typeof body.actionId !== 'string'
      || !('input' in body) || !('surface' in body)
      || (body.surface !== 'agent' && body.surface !== 'mcp' && body.surface !== 'cli')) throw new Error('Expected plugin control request');
    if (body.actionId === 'action.spec.search' || body.actionId === 'action.spec.get' || body.actionId === 'action.invoke') {
      const outcome = await executor.execute(body.actionId, body.input, {
        surface: body.surface,
        authority: resolveInvocationAuthority({ credential: 'terminal', surface: body.surface }),
        actionCaller: { kind: 'host' },
        ...('defaultSessionId' in body && typeof body.defaultSessionId === 'string' ? { defaultSessionId: body.defaultSessionId } : {}),
      });
      return { matched: true, result: outcome.ok ? { ok: true, result: StrictJsonValueSchema.parse(outcome.result) }
        : { ok: false, errorCode: outcome.errorCode, error: outcome.error } };
    }
    return await executeAppliedDaemonPluginActionWithController({ actionId: body.actionId, input: body.input, surface: body.surface,
      ...('defaultSessionId' in body && typeof body.defaultSessionId === 'string' ? { defaultSessionId: body.defaultSessionId } : {}),
    }, clientAction.runtime.controller);
  });
}

function installEmptyActionAutomationIndex(app: Fastify) {
  app.get(AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, { preHandler: app.authenticate },
    async () => ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }));
}

async function fixture(metadataLayout: 0 | 1 = 1, observeSubtreeQuery?: () => Promise<void>, bypassActionInterception = false,
  accountRelease = false, accountCurrentProcess = true,
  clientAction?: Awaited<ReturnType<typeof admittedClientActionFixture>>,
  accountMachine?: Readonly<{ sessionMachineId: string; executionRunTargetMachineId?: string }>,
  clientActionExecute?: ActionExecutorDeps['clientActionExecute'], registerArtifacts?: (app: Fastify) => void) {
  storage.state.sessionId = sessionId;
  storage.state.bound = true;
  storage.state.publisherBound = true;
  storage.state.revokedAt = null;
  storage.state.publicKey = installation.publicKey;
  storage.state.operationProtocolCapabilities = {};
  storage.state.operationProtocolCapabilitiesRevision = 0;
  storage.state.sessionIds = new Set([childId]);
  storage.state.sessionAccessKeyIds = new Set();
  storage.state.directReportSessionIds = new Set([childId]);
  await seedTestServerProfile({ id: serverId, homeId: storage.state.homeId, serverUrl: serverHttpBaseUrl });
  const token = await auth.createToken(storage.account.id, undefined, { kind: 'account', authority: 'present_user' });
  const credentials = { token, encryption: null };
  const scopeKey = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKey(credentials));
  let rawSettings: Readonly<Record<string, unknown>> = {};
  let authorizationStatus: 401 | 403 | 409 | 503 | undefined;
  let authorizationBody: unknown;
  let onAuthorizationMint: (() => void) | undefined;
  let settingsVersion = 0;
  const publishSettings = () => setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(rawSettings), rawSettings, scopeKey,
    settingsVersion: ++settingsVersion, loadedAtMs: 1, settingsSecretsReadKeys: [], promptLibraryCatalog: { status: 'loading' } });
  publishSettings();
  const actionsSettingsProvider = createActionSettingsProvider({ scopeKey });
  const app: Fastify = createAuthenticatedTestApp({ authentication: 'real' });
  installEmptyActionAutomationIndex(app);
  app.addHook('onRequest', async (request, reply) => {
    if (accountRelease && (request.url.startsWith('/v1/artifacts') || request.url.includes('account.plugins.availability'))) {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
    }
    if (request.url.endsWith('/execution-authorization') && authorizationStatus) {
      const status = authorizationStatus;
      const body = authorizationBody ?? { error: 'private-error-body' };
      onAuthorizationMint?.();
      return reply.code(status).send(body);
    }
  });
  app.decorate('resolveCurrentSessionMachine', async () => storage.state.bound ? storage.state.machineId : null);
  registerExternalActionRoutes(app, { dispatch: async () => { throw new Error('Unexpected external dispatch'); } });
  const observations: { method: string; path: string; status: number; code?: string; signed: boolean; bearer: boolean; sessionIds?: string[] }[] = [];
  app.addHook('onSend', async (request, reply, payload) => {
    let code: string | undefined;
    if (reply.statusCode >= 400 && typeof payload === 'string') {
      const body: unknown = JSON.parse(payload);
      const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
      if (error === 'invalid_token' || error === 'credential_scope_denied') code = error;
    }
    const batch = request.url === '/v2/sessions/read-batch' ? SessionReadBatchRequestV1Schema.safeParse(request.body) : null;
    observations.push({ method: request.method, path: request.url, status: reply.statusCode,
      ...(code ? { code } : {}),
      ...(batch?.success ? { sessionIds: batch.data.sessionIds } : {}),
      signed: typeof request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === 'string',
      bearer: request.headers.authorization !== undefined });
    return payload;
  });
  const members = storage.state.directReportSessionIds;
  let currentnessRefused = false;
  let accountEncryptionCurrentness = createAccountEncryptionCurrentnessFixture();
  let subtreeRefused: number | undefined;
  let nextSubtreeStatus: number | undefined;
  const observeScopeRead = async () => {
    await observeSubtreeQuery?.();
    const status = nextSubtreeStatus ?? subtreeRefused;
    nextSubtreeStatus = undefined;
    return status;
  };
  let callerWorkspaceMissing = false;
  let inactive = false;
  const activeSessions = new Set<string>();
  const archivedSessions = new Set<string>();
  const ownerTuples = new Map<string, SessionMetadataOwnerPatchV1>();
  let nestedReportId: string | undefined;
  const lifecycleEffects: string[] = [];
  const row = (id: string) => {
    const metadata = { machineId: storage.state.machineId,
      ...(id === sessionId && callerWorkspaceMissing ? {} : { path: '/workspace' }), flavor: 'codex' };
    const owner = createSessionOwnerMetadataV1({ metadata });
    if (!owner.ok) throw new Error('Invalid caller metadata fixture');
    const tuple = ownerTuples.get(id);
    return { ...createSessionNotificationContextFixture(id), encryptionMode: 'plain' as const, share: null,
      active: !inactive || activeSessions.has(id),
      archivedAt: archivedSessions.has(id) ? 123 : null,
      ...(metadataLayout === 0 ? { metadata: JSON.stringify(metadata) } : {
        metadataLayoutVersion: 1,
        metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
        ownerMetadata: { t: 'plain' as const, v: owner.ownerMetadata },
      }),
      ...(tuple ? { metadata: tuple.sharedMetadata.ciphertext, ownerMetadata: tuple.ownerMetadata,
        metadataVersion: tuple.sharedMetadata.expectedVersion + 1, agentState: tuple.agentState.ciphertext,
        agentStateVersion: tuple.agentState.expectedVersion + 1 } : {}),
      ...(id === childId ? { manager: { sessionId } }
        : id === nestedReportId ? { manager: { sessionId: childId } } : {}) };
  };
  app.get('/v1/account/encryption/currentness', { preHandler: app.authenticate }, async (_request, reply) =>
    currentnessRefused ? reply.code(401).send({ error: 'private-error-body' }) : accountEncryptionCurrentness);
  app.get('/v2/account/settings', { preHandler: app.authenticate }, async () => ({ version: settingsVersion, content: { t: 'plain', v: rawSettings } }));
  app.get('/v1/account/profile', { preHandler: app.authenticate }, async () => ({ id: storage.account.id }));
  if (accountRelease) app.get(ACCOUNT_SECURITY_PATH_V1, { preHandler: app.authenticate }, async () => AccountSecurityGetResponseV1Schema.parse({
    v: 1, encryptionMode: 'plain', nativeEmail: null,
    password: { status: 'not_enrolled', revision: null },
  }));
  app.get('/v1/machines/:id', { preHandler: app.authenticate }, async request => ({
    machine: { id: (request.params as { id: string }).id },
  }));
  const authoredAccount = accountRelease ? await registerAuthoredAccountActionRelease(app, storage.account.id) : null;
  if (registerArtifacts) registerArtifacts(app);
  else if (!authoredAccount) app.get('/v1/artifacts', { preHandler: app.authenticate }, async () => []);
  if (authoredAccount) app.get('/v1/account/encryption', { preHandler: app.authenticate }, async () => ({ mode: 'plain', updatedAt: 1 }));
  app.get('/v1/account/entity-rows/acp', { preHandler: app.authenticate }, async () =>
    AcpCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
      content: { t: 'plain', v: { v: 1, definitions: [] } } }));
  app.get('/v1/account/entity-rows/prompt-library', { preHandler: app.authenticate }, async () =>
    PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
      key, revision: 1, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) },
    })) }));
  app.post('/v2/sessions/query', { preHandler: app.authenticate }, async (request, reply) => {
    const query = SessionListQueryV1Schema.parse(request.body);
    expect(query.underSessionId === undefined || query.underSessionId === sessionId
      || (members.has(childId) && query.underSessionId === childId)).toBe(true);
    const status = await observeScopeRead();
    if (status !== undefined) return reply.code(status).send({ error: 'private-error-body' });
    const candidates = query.underSessionId === childId ? (nestedReportId ? [nestedReportId] : [])
      : [...members, ...(nestedReportId && members.has(childId) ? [nestedReportId] : [])];
    return createCompactSessionListQueryResponseFixture({ sessions: candidates.filter(id =>
      query.storage === (archivedSessions.has(id) ? 'archived' : 'active')).map(row),
      nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false });
  });
  app.post('/v2/sessions/read-batch', { preHandler: app.authenticate }, async (request, reply) => {
    const status = await observeScopeRead();
    if (status !== undefined) return reply.code(status).send({ error: 'private-error-body' });
    return createSessionReadBatchResponseFixture({ request: request.body,
      sessions: [sessionId, ...members, ...(nestedReportId ? [nestedReportId] : [])].map(row) });
  });
  app.get('/v2/sessions/:sessionId', { preHandler: app.authenticate,
    config: { apiTokenSessionAction: 'session.transcript.get', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
  }, async request => ({ session: row((request.params as { sessionId: string }).sessionId) }));
  // Persist the native Stop owner's tuple at the HTTP/DB boundary; signing,
  // metadata projection and Stop-intent admission remain production logic.
  app.patch('/v2/sessions/:sessionId', { preHandler: app.authenticate,
    config: { restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
  }, async request => {
    const patch = SessionMetadataOwnerPatchV1Schema.parse(request.body);
    ownerTuples.set((request.params as { sessionId: string }).sessionId, patch);
    return SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: patch.sharedMetadata.expectedVersion + 1 },
      agentState: { version: patch.agentState.expectedVersion + 1 } });
  });
  app.get('/v1/sessions/:sessionId/messages', { preHandler: app.authenticate,
    config: { apiTokenSessionAction: 'session.messages.recent.get', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
  }, async () => ({ messages: [{ id: 'message-child', seq: 1, localId: null, sidechainId: null, createdAt: 1, updatedAt: 1,
    messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Child ready' } } } }],
    hasMore: false, nextBeforeSeq: null, nextAfterSeq: null }));
  app.post('/v2/sessions/:sessionId/archive', { preHandler: app.authenticate,
    config: { apiTokenSessionAction: 'session.archive', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
  }, async (request, reply) => {
    if (row((request.params as { sessionId: string }).sessionId).active) {
      return reply.code(409).send({ error: 'session-active' });
    }
    lifecycleEffects.push(request.url);
    archivedSessions.add((request.params as { sessionId: string }).sessionId);
    return { success: true, archivedAt: 123 };
  });
  app.post('/v2/sessions/:sessionId/unarchive', { preHandler: app.authenticate,
    config: { apiTokenSessionAction: 'session.unarchive', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
  }, async request => {
    lifecycleEffects.push(request.url);
    archivedSessions.delete((request.params as { sessionId: string }).sessionId);
    return { success: true, archivedAt: null };
  });
  const restore = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
  const target = { kind: 'machine' as const, machineId: storage.state.machineId };
  const prepareResult = (operation: Pick<Operation, 'actionId' | 'input' | 'requestId'>,
    sessionActionOrigin: Parameters<typeof prepareExternalActionRequesterAccountAuthorizationResult>[0]['sessionActionOrigin'],
    signal?: AbortSignal) => prepareExternalActionRequesterAccountAuthorizationResult({ ...operation,
      target, machineId: storage.state.machineId, sourceMachineId: storage.state.machineId,
      accountId: storage.account.id, accountEncryptionMode: 'plain', tokenEpochHint: 1, token,
      serverId, serverIdentityId: storage.state.homeId, serverHttpBaseUrl,
      installationId: storage.state.installationId, privateKey: installation.secretKey, sessionActionOrigin,
      ...(signal ? { signal } : {}) });
  const prepare = async (...args: Parameters<typeof prepareResult>) => {
    const result = await prepareResult(...args);
    if ('ok' in result) return null;
    ExternalActionExecutionAuthorizationV1Schema.parse(result.authorization);
    return { authorization: result.authorization, target };
  };
  let sessionActionRpcTransport: SessionActionRpcTransport | undefined;
  let resolveServerFeaturesSnapshot: Parameters<typeof createCliActionExecutor>[0]['resolveServerFeaturesSnapshot'];
  const execute = createDaemonSessionAccountActionExecutor({ serverId, serverHttpBaseUrl, token, credentials,
    ...(accountMachine ? { machineId: accountMachine.sessionMachineId } : {}),
    ...(accountRelease ? {} : { machineId: storage.state.machineId,
      prepareExternalActionAuthorization: async ({ operation, sessionActionOrigin, authority }: Parameters<NonNullable<Parameters<typeof createDaemonSessionAccountActionExecutor>[0]['prepareExternalActionAuthorization']>>[0]) => {
        // The production preparer leaves private client Actions on their existing Session channel.
        if (!ExternalActionActionIdV1Schema.safeParse(operation.actionId).success) return undefined;
        const result = await prepareResult(operation, sessionActionOrigin, authority.signal);
        return 'ok' in result ? projectSessionActionIssuerRefusal(result, storage.state.machineId, authority.signal)
          : { authorization: result.authorization, target };
      } }),
    createExecutor: (_depth, _current, _post, options) => {
      const accountPorts = createAccountServerActionDeps({ token, credentials, serverId,
        serverIdentityId: storage.state.homeId, serverHttpBaseUrl,
        externalActionMachineRequestPrivateKey: installation.secretKey,
        externalActionMachineInstallationId: storage.state.installationId });
      const executor = createCliActionExecutor({ token, credentials, sessionId: '', mode: 'plain', ctx: null,
        serverId, serverIdentityId: storage.state.homeId, serverHttpBaseUrl,
        accountServerActionDeps: { usageActions: accountPorts.usageActions,
          homeDomainAction: accountPorts.homeDomainAction, publicProfileActions: accountPorts.publicProfileActions },
        externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: storage.state.installationId,
        actionsSettingsProvider,
        ...(resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot } : {}),
        ...(sessionActionRpcTransport ? { sessionActionRpcTransport } : {}),
        ...(clientActionExecute ? { clientActionExecute } : {}),
        ...(accountRelease && accountCurrentProcess ? { pluginActionExecutionOwner: 'current_process' as const,
          invokeContributedAction: createCommittedContributedActionInvoker() } : {}),
        ...(clientAction ? {
          listContributedActionDefinitions: createCommittedContributedActionDefinitionLister({
            tryAcquireRuntimeRegistryLease: () => clientAction.runtime.lease,
          }),
          invokeContributedAction: createCommittedContributedActionInvoker({
            acquireRuntimeRegistryLease: () => clientAction.runtime.controller.acquireRuntimeRegistry(),
          }),
        } : {}),
        ...options,
      });
      return { execute: (actionId, input, context) => executor.execute(actionId, input,
        { ...context, ...(bypassActionInterception ? { bypassActionInterception: true } : {}),
          ...(accountMachine?.executionRunTargetMachineId ? { executionRunTargetMachineId: accountMachine.executionRunTargetMachineId } : {}) }) };
    },
  });
  const operation = (actionId: Operation['actionId'], input: Operation['input']): Operation => ({ kind: 'action.execute',
    actionId, input, requestId: 'signed-observation', surface: 'agent',
    witness: { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 0, callerPermissionMode: 'default',
      agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 } } });
  return { credentials, app, observations, members, prepare, prepareResult, execute, operation, actionsSettingsProvider, lifecycleEffects, authoredAccount,
    setServerFeatureReader: (read: NonNullable<typeof resolveServerFeaturesSnapshot>) => { resolveServerFeaturesSnapshot = read; },
    setSessionActionRpcTransport: (transport: SessionActionRpcTransport) => { sessionActionRpcTransport = transport; },
    failAuthorization: (status?: 401 | 403 | 409 | 503, onMint?: () => void, body?: unknown) => {
      authorizationStatus = status;
      onAuthorizationMint = onMint;
      authorizationBody = body;
    },
    setActionsSettings: (actionsSettingsV1: ActionsSettingsV1) => { rawSettings = { actionsSettingsV1 }; publishSettings(); },
    setRawSettings: (value: Readonly<Record<string, unknown>>) => { rawSettings = value; publishSettings(); },
    markInactive: () => { inactive = true; },
    markChildArchived: () => { archivedSessions.add(childId); },
    addNestedReport: (id: string) => { nestedReportId = id; storage.state.sessionIds.add(id); },
    markSessionActive: (id: string) => { activeSessions.add(id); },
    markSessionInactive: (id: string) => { activeSessions.delete(id); },
    refuseCurrentness: () => { currentnessRefused = true; },
    setAccountEncryptionCurrentness: (value: ReturnType<typeof createAccountEncryptionCurrentnessFixture>) => { accountEncryptionCurrentness = value; },
    refuseSubtree: (status = 401) => { subtreeRefused = status; },
    allowSubtree: () => { subtreeRefused = undefined; },
    failNextSubtree: (status: number) => { nextSubtreeStatus = status; },
    omitCallerWorkspace: () => { callerWorkspaceMissing = true; },
    close: async () => { restore(); await app.close(); } };
}

it('admits an owner cross-Session Review apply and replays its admitted Session input after approval', async () => {
  await withTempDir('owner-session-review-apply-', async homeDir => {
    const previousEnv = process.env;
    process.env = { ...previousEnv, HAPPIER_HOME_DIR: homeDir };
    reloadConfiguration();
    const f = await fixture(1, undefined, false, false, true, undefined, undefined, undefined,
      app => { registerPlainArtifactRoutes(app, storage.account.id); });
    storage.state.sessionAccessKeyIds.add(childId);
    const installed = { version: 1 as const, installationId: storage.state.installationId, createdAt: 1,
      publicKey: Buffer.from(installation.publicKey).toString('base64url'),
      privateKey: Buffer.from(installation.secretKey).toString('base64url') };
    writeJsonAtomicSync(configuration.installationIdentityFile, installed);
    await updateMachineRegistration(current => ({ ...current,
      machineId: storage.state.machineId, accountId: storage.account.id,
      machineIdByAccountId: { ...current.machineIdByAccountId, [storage.account.id]: storage.state.machineId },
    }));
    const features = FeaturesResponseSchema.parse({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: storage.state.homeId } } });
    vi.stubGlobal('fetch', async () => Response.json(features));
    // Persisted credentials, Installation and Home HTTP/DB are boundaries. The
    // Session origin, signed mint, custody projection and CLI guard remain real.
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [serverId]: {
      id: serverId, name: 'Home', serverUrl: serverHttpBaseUrl, webappUrl: serverHttpBaseUrl,
      createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
      homeConnectionDescriptor: { v: 1, homeServerIdentityId: storage.state.homeId,
        canonicalServerUrl: serverHttpBaseUrl, revision: 1, endpoints: [{ kind: 'https', url: serverHttpBaseUrl }] },
    } } }));
    const terminalCredentials = { token: await auth.createToken(storage.account.id, undefined,
      { kind: 'terminal', authority: 'account_automation' }), encryption: null };
    await writeStoredCredentialsForServerId(serverId, terminalCredentials);
    const credentials = await readStoredCredentialsForServerId(serverId);
    if (!credentials) throw new Error('Expected the persisted owner sign-in');
    f.app.addHook('onSend', async (request, _reply, payload) => request.url === `/v1/machines/${storage.state.machineId}`
      ? JSON.stringify({ machine: MachinePublishedRowV1Schema.parse({ id: storage.state.machineId,
        installationId: storage.state.installationId, managedMachineRef: null, metadata: null, metadataVersion: 0,
        kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
        daemonState: null, daemonStateVersion: 0, access: { custodian: { accountId: storage.account.id, displayName: 'Owner' },
          role: 'manage', resourceMode: 'plain', accessState: 'ready' } }) }) : payload);
    f.app.get('/v1/artifacts/missing-review', { preHandler: f.app.authenticate }, async (_request, reply) =>
      reply.code(404).send({ error: 'not_found' }));
    f.app.get('/v1/account/encryption', { preHandler: f.app.authenticate }, async () => ({ mode: 'plain', updatedAt: 1 }));
    const reviewId = '00000000-0000-4000-8000-000000000018';
    const comment = ReviewCommentV1Schema.parse({ v: 1, id: 'accepted-finding', reviewId, accountId: storage.account.id,
      sessionId: childId, runId: 'review-run', findingId: 'finding', findingIdentity: 'a'.repeat(64), roundOrdinal: 1,
      finding: { id: 'finding', title: 'Accepted finding', severity: 'low', category: 'style', filePath: 'example.ts', summary: 'Verify this finding.' },
      anchor: { kind: 'file', filePath: 'example.ts' }, snapshot: { kind: 'none', capturedAt: 1 }, body: 'Verify this finding.',
      bodyVersion: 1, edits: [], author: { kind: 'user', userId: storage.account.id }, state: 'open', reviewTriageStatus: 'accept',
      flags: {}, dispositions: {}, threadId: 'accepted-finding', transitions: [], createdAt: 1, updatedAt: 1, serverRevision: 1 });
    const { structural, sensitive } = splitReviewCommentV1(comment);
    const storedComment = { v: 1, structural, sensitiveEnvelope: sealReviewCommentSensitiveEnvelopeV1({ structural, sensitive, mode: 'plain' }) };
    // Home storage/HTTP are boundaries; the Review codec, selection, child Action,
    // signed Ask and approval replay remain the production implementations.
    f.app.get('/v1/reviews/comments', { preHandler: f.app.authenticate }, async () => ({ items: [storedComment], cursor: null }));
    const prepare = createDaemonSessionAccountActionAuthorizationPreparer({ credentials,
      requesterRuntime: null, serverHttpBaseUrl, serverId, machineId: storage.state.machineId,
      externalActionAccountId: storage.account.id,
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: storage.state.homeId, machineId: storage.state.machineId }),
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }),
      isSessionCallerCurrent: async () => true, isRuntimeCurrent: () => true, readTrackedSessionAttribution: () => undefined });
    const channel = await createRequesterCurrentnessSocketHarness();
    const currentOrigin = async () => ({ serverIdentityId: storage.state.homeId, machineId: storage.state.machineId });
    const prepareReplay = createDaemonApprovalExecutionAuthorizationPreparer({ machineId: storage.state.machineId,
      serverId, serverBaseUrl: serverHttpBaseUrl, daemonWorkSignal: new AbortController().signal,
      resolveCurrentMachineExecutionOriginContext: currentOrigin,
      prepareRequesterAccountContext: request => prepareInstalledRequesterAccountActionContext({ ...request,
        purpose: { kind: 'external_action' }, machineId: storage.state.machineId, serverId, serverHttpBaseUrl,
        resolveCurrentMachineExecutionOriginContext: currentOrigin,
        // Tracked Session-process custody is the host boundary. The installed
        // projector still verifies its exact Account/Home/Session/installation.
        resolveRequesterSessionBootstrap: async (id, attribution) => id === sessionId ? {
          credentials, attribution, serverHttpBaseUrl, getBoundSessionId: () => sessionId,
          isCurrent: async () => storage.state.bound, release: async () => {},
        } : null,
        createExecutor: admitted => createCliActionExecutorFromCredentials({ credentials: admitted.credentials,
          serverId, serverApiUrl: serverHttpBaseUrl, serverIdentityId: storage.state.homeId, machineId: storage.state.machineId,
          savedSecretOperationContext: admitted.savedSecretOperationContext }),
      }),
    });
    const isApprovalCurrent = createDaemonApprovalExecutionOriginCurrentness({ accountId: storage.account.id,
      machineId: storage.state.machineId, serverId, resolveCurrentMachineExecutionOriginContext: currentOrigin,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: serverHttpBaseUrl }),
      isAccountCurrent: async () => storage.account.status === 'active', listAccountApiTokens: async () => ({ tokens: [] }),
      isSessionCallerCurrent: async () => storage.state.bound, resolveCurrentPermissionMode: async () => 'default',
      resolveCurrentSessionAgentSpawnPolicyV1: async () => getActiveAccountSettingsSnapshot()?.settings.sessionAgentSpawnPolicyV1 ?? null,
      externalActionMachinePublicKey: installation.publicKey,
      verifyExternalExecutionAuthorization: args => verifyExternalActionExecutionAuthorizationCurrent({ ...args,
        serverHttpBaseUrl, installationId: storage.state.installationId, privateKey: installation.secretKey }),
    });
    const deliveredInputs: unknown[] = [];
    const executor = createCliActionExecutor({ token: credentials.token, credentials,
      sessionId: '', mode: 'plain', ctx: null, serverId, serverIdentityId: storage.state.homeId,
      serverHttpBaseUrl, actionsSettingsProvider: f.actionsSettingsProvider,
      externalActionMachineRequestPrivateKey: installation.secretKey,
      externalActionMachineInstallationId: storage.state.installationId,
      isApprovalExecutionOriginCurrent: isApprovalCurrent, prepareApprovalExecutionAuthorization: prepareReplay,
      // The remote input transport is the boundary; issuance, durable Ask,
      // decision replay and Session input admission execute their real owners.
      machineAdmissionTransport: async (request, options) => {
        expect(request.sessionId).toBe(childId);
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(options?.callerInputAuthorization);
        const event = 'session-pending-enqueue-by-machine-v1' as const;
        const target = { kind: 'session' as const, sessionId: request.sessionId };
        const execution = { v: 1 as const, authorization, effectActionId: 'session.message.send', target,
          installationId: storage.state.installationId,
          machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
            effectActionId: 'session.message.send', target, installationId: storage.state.installationId,
            event, method: event, requestId: authorization.binding.requestId, params: request,
            privateKey: installation.secretKey }) };
        expect(await verifyExternalActionMachineRpcExecution(execution, { event, method: event,
          requestId: authorization.binding.requestId, params: request,
          resolveCurrentSessionMachine: async () => storage.state.machineId })).not.toBeNull();
        expect(await verifyExternalActionMachineRpcExecution(execution, { event, method: event,
          requestId: authorization.binding.requestId, params: { ...request, sessionId: 'foreign-session' },
          resolveCurrentSessionMachine: async () => storage.state.machineId })).toBeNull();
        expect(await verifyExternalActionMachineRpcExecution({ ...execution,
          target: { kind: 'session', sessionId } }, { event, method: event,
          requestId: authorization.binding.requestId, params: request,
          resolveCurrentSessionMachine: async () => storage.state.machineId })).toBeNull();
        expect(await verifyExternalActionMachineRpcExecution(execution, { event, method: event,
          requestId: authorization.binding.requestId,
          params: { ...request, content: { t: 'plain', v: 'changed message' } },
          resolveCurrentSessionMachine: async () => storage.state.machineId })).toBeNull();
        deliveredInputs.push(request.content);
        return { status: 'accepted', localId: request.localId };
      } });
    let admittedContext: Parameters<typeof executor.execute>[2];
    const execute = createDaemonSessionAccountActionExecutor({ serverId, serverHttpBaseUrl,
      token: credentials.token, credentials, machineId: storage.state.machineId,
      prepareExternalActionAuthorization: prepare, createExecutor: () => ({ execute: (id, input, context) => {
        admittedContext = context;
        return executor.execute(id, input, context);
      } }) });
    try {
      const outcome = await execute(f.operation('review.apply', { sessionId: childId, reviewId: 'missing-review' }),
        { sessionId, isCurrent: async () => true });
      expect(admittedContext?.sessionActionOrigin, JSON.stringify({ outcome, observations: f.observations }))
        .toMatchObject({ caller: { kind: 'session', sessionId }, sourceTurnId: 'turn' });
      // The Session's ordinary Ask default remains active. The installed host
      // signs and persists it; admission does not silently waive consent.
      expect(outcome, JSON.stringify({ outcome, observations: f.observations }))
        .toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId: 'review.apply' } });
      // The same admitted custody opens the Review port. Its real HTTP miss
      // discriminates credential admission without sending a Session message.
      const services = await executor.resolveReviewServices!(admittedContext);
      expect(services.comments).toBeTypeOf('function');
      await expect(services.comments!({ actionId: 'reviews.comments.list', input: { reviewId: 'missing-review' } }))
        .rejects.toMatchObject({ code: 'review_comment_encryption_material_unavailable' });
      expect(f.observations.some(row => row.path === '/v1/artifacts/missing-review')).toBe(true);
      if (!admittedContext?.externalActionExecutionAuthorization || !admittedContext.sessionActionOrigin) {
        throw new Error('Expected the real Session issuer custody');
      }
      const admitted = admittedContext;
      const rawAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(admitted.externalActionExecutionAuthorization);
      const foreignMachinePath = '/v1/machines/foreign-machine';
      const foreignMachineRead = await f.app.inject({ method: 'GET', url: foreignMachinePath,
        headers: createExternalActionAuthorizedRequestHeaders({ authorization: rawAuthorization,
          effectActionId: 'review.apply', target: { kind: 'machine', machineId: storage.state.machineId },
          installationId: storage.state.installationId, privateKey: installation.secretKey,
          method: 'GET', path: foreignMachinePath }) });
      expect(foreignMachineRead.statusCode).toBe(401);
      expect(foreignMachineRead.json()).toMatchObject({ error: 'invalid_token' });
      const restrictedCredential = { accountId: storage.account.id, principalId: storage.account.id,
        credentialId: '00000000-0000-4000-8000-000000000001',
        grant: ApiTokenGrantV1Schema.parse({ v: 1, actions: { families: [], ids: ['reviews.comments.list'] },
          targets: { sessions: [], machines: [storage.state.machineId] }, approve: false,
          origins: [], models: null, permissionModes: null, create: null }) };
      const deniedContexts: Array<NonNullable<typeof admittedContext>> = [
        { ...admitted, externalActionExecutionAuthorization: rawAuthorization },
        { ...admitted, sessionActionOrigin: { ...admitted.sessionActionOrigin,
          caller: { kind: 'session', sessionId: childId } } },
        { ...admitted, rpcSessionAuthorization: { kind: 'session.write', sessionId } },
        { ...admitted, externalActionCredential: restrictedCredential },
      ];
      const readsBeforeDenials = f.observations.filter(row => row.path === '/v1/artifacts/missing-review').length;
      for (const context of deniedContexts) {
        await expect(executor.execute('review.apply', { sessionId: childId, reviewId: 'missing-review' }, context))
          .resolves.toMatchObject({ ok: false, errorCode: 'review_comment_account_custody_denied' });
        await expect(executor.resolveReviewServices!(context)).resolves.toEqual({});
      }
      const foreignToken = await auth.createToken('other-account', undefined, { kind: 'terminal', authority: 'account_automation' });
      const foreignExecutor = createCliActionExecutor({ token: foreignToken, credentials: { token: foreignToken, encryption: null },
        sessionId: '', mode: 'plain', ctx: null, serverId, serverIdentityId: storage.state.homeId,
        serverHttpBaseUrl, actionsSettingsProvider: f.actionsSettingsProvider });
      await expect(foreignExecutor.execute('review.apply', { sessionId: childId, reviewId: 'missing-review' }, admitted))
        .resolves.toMatchObject({ ok: false, errorCode: 'review_comment_account_custody_denied' });
      await expect(foreignExecutor.resolveReviewServices!(admitted)).resolves.toEqual({});
      expect(f.observations.filter(row => row.path === '/v1/artifacts/missing-review')).toHaveLength(readsBeforeDenials);

      await runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
        const records = createReviewRecordPortV1(createAcknowledgedAccountArtifactTransport(createCredentialedAccountArtifactStore(credentials)));
        await records.start({ reviewId, title: 'Accepted finding', subjectKind: 'repository', sourceKind: 'direct',
          sourceSessionId: childId, reviewerIds: ['reviewer'], startedAt: 1 });
      });
      const reviewOperation = f.operation('review.apply', { sessionId: childId, reviewId, commentIds: [comment.id] });
      const requested = await execute({ ...reviewOperation, requestId: 'approved-review-apply', witness: { ...reviewOperation.witness,
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
      }, reviewCommentPrincipal: { actor: { kind: 'agent', agentId: 'happier.agent.claude/claude', sessionId } } },
      { sessionId, isCurrent: async () => true });
      expect(requested, JSON.stringify(requested)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      if (!requested.ok || !requested.result || typeof requested.result !== 'object'
        || !('artifactId' in requested.result) || typeof requested.result.artifactId !== 'string') {
        throw new Error('Expected the persisted Review apply Ask');
      }
      expect(deliveredInputs).toEqual([]);
      const decision = await executor.execute('approval.request.decide', {
        artifactId: requested.result.artifactId, decision: 'approve',
      }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
        runtimeAccountId: storage.account.id, serverId, serverIdentityId: storage.state.homeId });
      expect(decision, JSON.stringify({ decision, observations: f.observations })).toMatchObject({
        ok: true, result: { status: 'executed', execution: { ok: true, result: {
          status: 'accepted',
        } } },
      });
      expect(deliveredInputs).toMatchObject([{ t: 'plain', v: { meta: { happierInputRequestV1: {
        caller: { kind: 'host' }, sourceSession: { sourceSessionId: sessionId,
          sourceTurnId: 'turn', sourceInputId: 'input' },
      } } } }]);
    } finally { await channel.close(); await f.close(); process.env = previousEnv; reloadConfiguration(); }
  });
});

it('lists internal Tasks through the Session agent Account provider', async () => {
  const f = await fixture();
  f.app.get('/v1/kv/:key', { preHandler: f.app.authenticate }, async (_request, reply) => reply.code(404).send({ error: 'not_found' }));
  f.app.get('/v1/tasks', { preHandler: f.app.authenticate }, async () => ({ tasks: [] }));
  try {
    const outcome = await f.execute(f.operation('tasks.internal.list', {}), { sessionId, isCurrent: async () => true });
    expect(outcome, JSON.stringify({ outcome, observations: f.observations })).toMatchObject({
      ok: true, result: { status: 'ok', todos: [], undoneOrder: [], completedOrder: [] },
    });
  } finally { await f.close(); }
});

it('lists Fleet Activity through the Session requester Account and refuses another Home', async () => {
  const f = await fixture();
  f.app.get('/v1/account/encryption', { preHandler: f.app.authenticate }, async () => ({ mode: 'plain', updatedAt: 1 }));
  f.setActionsSettings(normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
    'machines.activity.list': ['agent'],
  } }));
  const refusedRoot = projectExternalActionHttpError('target_unavailable', 'signed-observation');
  f.failAuthorization(409, undefined, refusedRoot.payload);
  const environment = createDeploymentEnvironmentHeaderV1({ serverId });
  const receipt = createDeploymentReceiptHeaderV1({ environmentId: environment.id, contentArtifactId: null });
  f.app.get('/v1/deployments/environments', { preHandler: f.app.authenticate }, async () =>
    ({ ok: true, items: [environment], nextCursor: null }));
  f.app.get(`/v1/deployments/environments/${environment.id}/deployments`, { preHandler: f.app.authenticate }, async () =>
    ({ ok: true, items: [receipt], nextCursor: null }));
  const caller = { sessionId, isCurrent: async () => true };
  try {
    const outcome = await f.execute(f.operation('machines.activity.list', { serverId, kind: 'receipt', limit: 1 }), caller);
    expect(outcome, JSON.stringify({ outcome, observations: f.observations })).toMatchObject({
      ok: true, result: { items: [{ kind: 'receipt', receipt: { id: receipt.id } }], coverage: 'complete' },
    });
    expect(f.observations.filter(row => row.path.startsWith('/v1/deployments/'))).toMatchObject([
      { status: 200, signed: false, bearer: true }, { status: 200, signed: false, bearer: true },
    ]);
    const foreign = await f.execute(f.operation('machines.activity.list', { serverId: 'other-home', kind: 'receipt', limit: 1 }), caller);
    expect(foreign).toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
  } finally { await f.close(); }
});

it('stores a privately approved agent secret through the original Home authority without disclosing its value', async () => {
  const f = await fixture();
  const input = { name: 'Replay3 disposable secret' };
  const material = 'SECRET-AUTH-synthetic-private-value';
  const history: unknown[] = [];
  const staleReasons: string[] = [];
  const deliveredMessages: string[] = [];
  let approval: ApprovalRequest | undefined;
  let saved: ReturnType<typeof SharedSavedSecretCreateInputV1Schema.parse> | undefined;
  let requester: Awaited<ReturnType<typeof f.prepare>>;
  // Storage is the boundary; Home authentication and the person-class guard are real.
  f.app.get('/v1/account/encryption', { preHandler: f.app.authenticate }, async () => ({ mode: 'plain', updatedAt: 1 }));
  f.app.post(SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create'], {
    preHandler: [f.app.authenticate, requirePresentUser],
  }, async request => {
    saved = SharedSavedSecretCreateInputV1Schema.parse(request.body);
    return { resourceId: saved.resourceId, revision: 1 };
  });
  for (const id of ['secrets.shared.update', 'secrets.shared.delete', 'secrets.shared.grants.set'] as const) {
    f.app.post(SHARED_SAVED_SECRET_ACTION_PATHS_V1[id], { preHandler: [f.app.authenticate, requirePresentUser] },
      async () => { throw new Error('An unrelated Saved Secret mutation reached storage'); });
  }
  const scopeKey = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKey(f.credentials));
  const snapshot = getActiveAccountSettingsSnapshot()!;
  const accountPorts = createAccountServerActionDeps({ token: f.credentials.token, credentials: f.credentials,
    serverId, serverIdentityId: storage.state.homeId, serverHttpBaseUrl,
    externalActionMachineRequestPrivateKey: installation.secretKey,
    externalActionMachineInstallationId: storage.state.installationId });
  const originCurrent = createDaemonApprovalExecutionOriginCurrentness({
    accountId: storage.account.id, machineId: storage.state.machineId, serverId,
    // Installed identity and the tracked Session/permission snapshot are host boundaries.
    resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: storage.state.machineId, serverIdentityId: storage.state.homeId }),
    resolveTarget: createDaemonExternalActionTargetResolver({ credentials: f.credentials, serverApiUrl: serverHttpBaseUrl }),
    isAccountCurrent: async () => storage.account.status === 'active', listAccountApiTokens: async () => ({ tokens: [] }),
    isSessionCallerCurrent: async () => storage.state.bound,
    resolveCurrentPermissionMode: async () => 'default',
    resolveCurrentSessionAgentSpawnPolicyV1: async () => getActiveAccountSettingsSnapshot()?.settings.sessionAgentSpawnPolicyV1 ?? null,
    externalActionMachinePublicKey: installation.publicKey,
    verifyExternalExecutionAuthorization: args => verifyExternalActionExecutionAuthorizationCurrent({ ...args,
      serverHttpBaseUrl, installationId: storage.state.installationId, privateKey: installation.secretKey }),
  });
  const executor = createActionExecutor({
    actionAutomations: createActionAutomationHttpPortV1({ accountId: storage.account.id, async request(path, init) {
      const response = await f.app.inject({ method: init.method, url: path,
        headers: { authorization: `Bearer ${f.credentials.token}` } });
      expect(response.statusCode).toBe(200);
      return response.json();
    } }),
    // The originating Session's message delivery is the transport boundary.
    sessionSendMessage: async ({ sessionId: targetSessionId, message, localId }) => {
      expect(targetSessionId).toBe(sessionId); deliveredMessages.push(message);
      return { status: 'accepted', localId };
    },
    approvalsCreate: async ({ request }) => { approval = ApprovalRequestV2Schema.parse(request); history.push(structuredClone(approval)); return { artifactId: 'private-secret' }; },
    approvalsGet: async () => structuredClone(approval),
    approvalsUpdate: async ({ request, expectedStatus }) => {
      if (!approval) throw new Error('Missing approval');
      const next = ApprovalRequestV2Schema.parse(request);
      const transition = decideApprovalRequestTransition(approval, next, { expectedStatus });
      if (!transition.ok) return transition;
      approval = next; history.push(structuredClone(next)); return { ok: true };
    },
    isApprovalExecutionOriginCurrent: args => originCurrent({ ...args, reportStale: reason => {
      staleReasons.push(reason); args.reportStale?.(reason);
    } }),
    confidentialActionInputs: createConfidentialActionInputsExecutor({ expectedScopeKey: scopeKey!,
      expectedAccountId: storage.account.id, serverId, machineId: storage.state.machineId, readAccountMode: async () => 'plain' }),
    personalSavedSecretActionExecute: createCliPersonalSavedSecretActionExecute({ credentials: f.credentials,
      operationContext: createInvocationSavedSecretOperationContextV1({ credentials: f.credentials, snapshot,
        serverHttpBaseUrl, isCurrent: async () => storage.state.bound }), home: accountPorts.homeDomainAction! }),
  });
  const execute = createDaemonSessionAccountActionExecutor({ serverId, serverHttpBaseUrl,
    token: f.credentials.token, credentials: f.credentials, machineId: storage.state.machineId,
    prepareExternalActionAuthorization: async ({ operation, sessionActionOrigin }) => {
      requester = await f.prepare(operation, sessionActionOrigin);
      return requester;
    },
    createExecutor: () => {
      const withHost = (context: Parameters<typeof executor.execute>[2]) => ({ ...context,
        serverIdentityId: storage.state.homeId, runtimeAccountId: storage.account.id,
        signExternalActionApprovalInput: (request: Parameters<NonNullable<NonNullable<Parameters<typeof executor.execute>[2]>['signExternalActionApprovalInput']>>[0]) =>
          signExternalActionApprovalInputV1({ ...request, authorizationToken: request.authorization.token, privateKey: installation.secretKey }),
      });
      return { execute: (id, args, context) => executor.execute(id, args, withHost(context)),
        prepare: (id, args, context, options) => executor.prepare(id, args, withHost(context), options) };
    },
  });
  try {
    const requested = await execute(f.operation('secrets.create', input), { sessionId, isCurrent: async () => true });
    expect(requested).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(approval).toMatchObject({ actionArgs: input, preview: { confidentialInputs: { paths: ['value'] } } });
    const result = await executor.continueConfidentialApprovalRequest({ v: 1, kind: 'action_inputs', artifactId: 'private-secret',
      requestId: 'signed-observation', actionId: 'secrets.create', request: input, serverId,
      machineId: storage.state.machineId, accountEncryptionMode: 'plain',
      choices: [{ path: 'value', choice: { kind: 'once', value: material } }],
    }, { surface: 'ui', authority: 'present_user', serverId, serverIdentityId: storage.state.homeId, runtimeAccountId: storage.account.id });
    expect(result.ok, JSON.stringify({ failure: result.ok ? undefined : result, status: approval?.status,
      execution: approval?.execution, staleReasons, http: f.observations })).toBe(true);
    expect(f.observations.filter(row => row.path === SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create']))
      .toMatchObject([{ status: 200, signed: true, bearer: false }]);
    expect(result).toMatchObject({ ok: true, result: { secretId: expect.any(String) } });
    expect(saved).toBeDefined();
    expect(openSavedSecretResourceStoredContentV1({ resourceId: saved!.resourceId, mode: 'plain', storedContent: saved!.storedContent }))
      .toMatchObject({ name: input.name, value: material });
    expect(approval).toMatchObject({ status: 'executed' });
    expect(JSON.stringify({ requested, result, history, deliveredMessages })).not.toContain(material);
    expect(deliveredMessages.length).toBeGreaterThan(0);
    if (!requester || !saved) throw new Error('Missing admitted requester or stored resource');
    const admitted = requester;
    const sign = (actionId: keyof typeof SHARED_SAVED_SECRET_ACTION_PATHS_V1, body: unknown) => createExternalActionAuthorizedRequestHeaders({
      authorization: admitted.authorization, effectActionId: actionId, target: admitted.target,
      installationId: storage.state.installationId, method: 'POST', path: SHARED_SAVED_SECRET_ACTION_PATHS_V1[actionId],
      body, privateKey: installation.secretKey,
    });
    const siblingMutations = [
      ['secrets.shared.update', { resourceId: saved.resourceId, expectedRevision: 1,
        displayName: saved.displayName, kind: saved.kind, storedContent: saved.storedContent }],
      ['secrets.shared.delete', { resourceId: saved.resourceId, expectedRevision: 1, expectedSettingsVersion: 0,
        referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 0, rows: [] } } }],
      ['secrets.shared.grants.set', { resourceId: saved.resourceId, expectedRevision: 1,
        accountGrants: [], teamGrants: [], groupGrants: [] }],
    ] as const;
    for (const [id, body] of siblingMutations) {
      expect((await f.app.inject({ method: 'POST', url: SHARED_SAVED_SECRET_ACTION_PATHS_V1[id],
        payload: body, headers: sign(id, body) })).statusCode).toBe(401);
    }
    expect((await f.app.inject({ method: 'POST', url: SHARED_SAVED_SECRET_ACTION_PATHS_V1['secrets.shared.create'],
      payload: { ...saved, displayName: 'Changed after signing' }, headers: sign('secrets.shared.create', saved) })).statusCode).toBe(401);
  } finally { await f.close(); }
});

it('preserves the incumbent refusal of an unsupported asynchronous Session browser child after its mounted command returns', async () => {
  let mountedRequest: ReturnType<typeof UiActionDispatchRequestV1Schema.parse> | undefined;
  const dispatch = createClientActionReverseDispatcher(() => ({
    hasConnectedClientRpcHandler: () => true,
    // The connected App socket is the boundary. Native Session admission,
    // caller projection and the daemon child owner remain real.
    callConnectedClientRpc: async (_method, raw, options) => {
      mountedRequest = UiActionDispatchRequestV1Schema.parse(raw);
      options.onIssued();
      return { ok: true, result: { v: 1, execution: { ok: true, result: { value: null } } } };
    },
  }));
  const f = await fixture(1, undefined, false, false, true, undefined, undefined, dispatch);
  try {
    const parentActionId = 'ui.current_context.command.invoke';
    const readActionId = FILESYSTEM_BROWSER_ACTION_IDS_V1.browseDirectory;
    f.setActionsSettings(normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
      [parentActionId]: ['agent'], [readActionId]: ['agent'],
    } }));
    const operation = f.operation(parentActionId, { commandId: 'mounted-directory-open' });
    const opened = await f.execute(operation, { sessionId, isCurrent: async () => true });
    expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true });
    expect(mountedRequest?.context).toMatchObject({ surface: 'agent', authority: 'account_automation',
      actionCaller: { kind: 'session', sessionId }, actionRequestId: operation.requestId });
    // A chooser's initial read and later warming start after its open command
    // acknowledges. The incumbent child carrier has no supported continuation.
    const read = await executeAdmittedClientActionChild({ v: 1, parentRequestId: operation.requestId,
      sessionId, actionId: readActionId, input: { path: '/workspace' } }, {
      machineAdmission: { actorAccountId: storage.account.id, custodianAccountId: storage.account.id,
        machineId: storage.state.machineId, installationId: storage.state.installationId,
        role: 'manage', encryptionMode: 'plain' },
    });
    expect(read.execution, JSON.stringify(read.execution)).toMatchObject({ ok: false, errorCode: 'invalid_action_input' });
  } finally { await f.close(); }
});

function publicProfileAccountingFixture(body: unknown) {
  const query = UsageAnalyticsQueryRequestSchema.parse(body);
  expect(query.population).toBe('public_eligible_personal');
  const range = query.dateRange;
  if (range?.startMs === undefined || range.endMs === undefined) throw new Error('Expected finite profile fixture query');
  const { startMs, endMs } = range;
  const tokens = { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 };
  const cost = { reportedUsd: 98765, estimatedUsd: 87654, currency: 'USD' };
  // Publication needs admitted contribution/coverage evidence, not totals alone.
  // This is the real HTTP response grammar used by the captured Account test.
  return UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1, tokens, cost },
    contributions: [{ id: 'fixture-private-request', observedAtMs: startMs + 1,
      sessionId: 'fixture-private-session', turnId: 'fixture-private-turn', agentId: 'codex',
      modelId: null, machineId: null, projectKey: 'fixture-private-project', workspaceId: null,
      source: 'runtime', eventCount: 1, sourceContext: { path: 'runtime', execution: 'happier' }, tokens, cost }],
    coverage: { status: 'partial', reasons: ['incomplete_history'], sources: [{ source: 'runtime', path: 'runtime',
      status: 'available', eventCount: 1, asOfMs: endMs, historyComplete: false }],
      missingDimensions: [], ranked: [], range: { startMs, endMs, complete: false } },
  });
}

it('prepares a public-profile preview through the signed Session Account binding', async () => {
  const f = await fixture();
  const startMs = Date.parse('2026-10-20T00:00:00Z');
  const endMs = startMs + 86_400_000;
  const owner = PublicProfileOwnerReadV1Schema.parse({ kind: 'absent', context: { handle: 'qa-profile', identity: {},
    service: null, urls: null } });
  f.app.get('/v1/account/public-profile', { preHandler: f.app.authenticate }, async request => {
    expect(request.userId).toBe(storage.account.id);
    expect(request.headers.authorization).toBeUndefined();
    return owner;
  });
  f.app.post('/v2/usage/query', { preHandler: f.app.authenticate }, async request => {
    expect(request.userId).toBe(storage.account.id);
    expect(request.headers.authorization).toBeUndefined();
    return publicProfileAccountingFixture(request.body);
  });
  try {
    const outcome = await f.execute(f.operation('account.public_profile.preview', projectNativeJsonValueForTransport({
      policy: { indexable: false, fields: Object.fromEntries(Object.keys(DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields)
        .map(field => [field, field === 'tokens'])) }, metadataSelection: {},
      query: normalizeUsageQuery({ period: { startMs, endMs }, includeSessionEvidence: false,
        includeTranscriptEvidence: false, includeWorkEvidence: false, includeQuotaHistory: false }),
      layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
    })), { sessionId, isCurrent: async () => true });
    expect(outcome, JSON.stringify({ outcome, observations: f.observations })).toMatchObject({ ok: true,
      result: { kind: 'ready', view: { snapshot: { facts: { tokens: 12 } } } } });
    expect(JSON.stringify(outcome)).not.toMatch(/fixture-private-|98765|87654/);
    for (const path of ['/v1/account/public-profile', '/v2/usage/query']) {
      expect(f.observations).toContainEqual(expect.objectContaining({ path, status: 200, signed: true, bearer: false }));
    }
    expect(f.observations.filter(row => row.path === '/v1/account/public-profile' || row.path === '/v2/usage/query')
      .every(row => row.status === 200 && row.signed && !row.bearer)).toBe(true);
  } finally { await f.close(); }
});

it.each([false, true])('retains signed Account authority for atomic public-profile widening without borrowing refresh consent (refreshApproved=%s)', async refreshApproved => {
  const f = await fixture();
  const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, population: 'public_eligible_personal' });
  const policy = { indexable: false, fields: Object.fromEntries(Object.keys(DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields)
    .map(field => [field, field === 'tokens'])) };
  const owner = PublicProfileOwnerReadV1Schema.parse({ kind: 'ready', context: { handle: 'qa-profile', identity: {},
    service: { displayName: 'Home', publicBaseUrl: serverHttpBaseUrl }, urls: {
      page: `${serverHttpBaseUrl}/@qa-profile`, json: `${serverHttpBaseUrl}/@qa-profile/json`,
      badgeBase: `${serverHttpBaseUrl}/@qa-profile/badge`, card: `${serverHttpBaseUrl}/@qa-profile/card.svg`,
      og: `${serverHttpBaseUrl}/@qa-profile/og.png`, report: 'mailto:operator@example.test',
    } }, record: { state: 'published', policy: { ...policy,
      fields: Object.fromEntries(Object.keys(DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields).map(field => [field, false])) },
      metadata: {}, projectSelections: [], query, snapshot: null,
      layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
      updatedAtMs: 1, publishedAtMs: 1, restriction: null } });
  if (owner.kind !== 'ready') throw new Error('Expected published owner fixture');
  const effects: unknown[] = [];
  f.app.get('/v1/account/public-profile', { preHandler: f.app.authenticate }, async () => owner);
  f.app.post('/v2/usage/query', { preHandler: f.app.authenticate }, async request => {
    return publicProfileAccountingFixture(request.body);
  });
  for (const [operation, path] of [['update', 'policy'], ['refresh', 'snapshot']] as const) {
    f.app.put(`/v1/account/public-profile/${path}`, { preHandler: f.app.authenticate }, async request => {
      const prepared = PublicProfilePreparedRequestV1Schema.parse({ operation, body: request.body });
      effects.push(prepared);
      if (prepared.operation === 'update') owner.record = { ...owner.record, ...prepared.body, updatedAtMs: 2 };
      return { kind: 'updated', record: owner.record };
    });
  }
  // The canonical preparation owner includes widened facts in the reviewed
  // Update. An independently configured Refresh must not become a child effect.
  f.setActionsSettings(normalizeActionsSettingsV1({ v: 1,
    actions: { 'account.public_profile.refresh': { approvalRequiredSurfaces: ['agent'] } },
    approvalWaivedSurfaces: {
    'account.public_profile.update': ['agent'], ...(refreshApproved ? { 'account.public_profile.refresh': ['agent'] } : {}),
  } }));
  try {
    const outcome = await f.execute(f.operation('account.public_profile.update', projectNativeJsonValueForTransport({ policy })),
      { sessionId, isCurrent: async () => true });
    expect(outcome, JSON.stringify({ outcome, observations: f.observations })).toMatchObject({ ok: true,
      result: { kind: 'updated', record: { policy, snapshot: { facts: { tokens: 12 } } } } });
    expect(effects).toEqual([expect.objectContaining({ operation: 'update',
      body: expect.objectContaining({ policy, snapshot: expect.objectContaining({ facts: { tokens: 12 } }) }) })]);
    expect(f.observations.filter(row => row.path.startsWith('/v1/account/public-profile') || row.path === '/v2/usage/query')
      .every(row => row.status === 200 && row.signed && !row.bearer)).toBe(true);
  } finally { await f.close(); }
});

it.each(['present', 'absent'] as const)('writes an allowed subscription price through authenticated native Agent Account custody (%s)', async initial => {
  const f = await fixture();
  const account = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'personal' };
  const sibling = { ...account, accountId: 'work' };
  f.setRawSettings({ actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
    approvalWaivedSurfaces: { 'connectedServices.subscription.price.set': ['agent'] } }),
    connectedServicesProfileLabelByKey: Object.fromEntries([account, sibling].map(ref => [
      connectedServiceProfileKey({ serviceId: 'openai-codex', profileId: ref.accountId }), ref.accountId,
    ])) });
  f.app.addHook('onSend', async (request, reply, payload) => request.url === '/v1/account/profile' && reply.statusCode === 200
    ? JSON.stringify(AccountProfileSchema.parse({ id: storage.account.id, connectedAccountsV4: [account, sibling].map(ref => ({ ref,
      status: 'connected', authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null,
      revisionSemantics: 'legacy_unfenced', credentialRevision: null })) })) : payload);
  let presentation = ConnectedPresentationRowReadResponseV1Schema.parse(initial === 'absent' ? { status: 'absent' }
    : { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1,
      entries: [account, sibling].map(ref => ({ v: 1, subject: { kind: 'account', account: ref }, label: ref.accountId })) } } });
  f.app.get(CONNECTED_PRESENTATION_ROWS_ROUTE_V1, { preHandler: f.app.authenticate }, async () => presentation);
  f.app.get(CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1, { preHandler: f.app.authenticate }, async () =>
    ConnectedAcknowledgementsRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
      content: { t: 'plain', v: { v: 1, entries: [] } } }));
  f.app.post(CONNECTED_PRESENTATION_ROWS_ROUTE_V1, { preHandler: f.app.authenticate }, async request => {
    expect(request.userId).toBe(storage.account.id);
    expect(request.headers.authorization).toBeUndefined();
    const mutation = ConnectedPresentationRowMutationV1Schema.parse(request.body);
    expect(mutation.expectedRevision).toBe(initial === 'absent' ? 'absent' : 1);
    expect(mutation.sourceSettingsVersion === undefined).toBe(initial !== 'absent');
    // A finite price mutation includes its effect in the first presentation CAS;
    // it does not run the independent source transfer/cleanup lifecycle first.
    expect(mutation.content).toMatchObject({ t: 'plain', v: { entries: expect.arrayContaining([
      expect.objectContaining({ subject: { kind: 'account', account }, label: 'personal',
        subscriptionMonthlyPrice: { amount: 17, currency: 'EUR', enteredAtMs: expect.any(Number) } }),
      { v: 1, subject: { kind: 'account', account: sibling }, label: 'work' },
    ]) } });
    presentation = ConnectedPresentationRowReadResponseV1Schema.parse({ status: 'present', revision: 2, content: mutation.content });
    return ConnectedMetadataRowMutationResponseV1Schema.parse({ status: 'updated', revision: 2, cursor: 2 });
  });
  for (const path of ['/v2/account/settings', CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1,
    '/v2/account/settings/history/normalize', '/v1/kv']) {
    f.app.post(path, { preHandler: f.app.authenticate }, async () => ({ unexpected: 'admitted' }));
  }
  try {
    const outcome = await f.execute(f.operation('connectedServices.subscription.price.set', {
      account, price: { amount: 17, currency: 'EUR' },
    }), { sessionId, isCurrent: async () => true });
    expect(outcome, JSON.stringify({ outcome, observations: f.observations })).toMatchObject({ ok: true, result: { applied: true } });
    expect(presentation).toMatchObject({ content: { t: 'plain', v: { entries: expect.arrayContaining([
      expect.objectContaining({ subject: { kind: 'account', account }, label: 'personal',
        subscriptionMonthlyPrice: { amount: 17, currency: 'EUR', enteredAtMs: expect.any(Number) } }),
      { v: 1, subject: { kind: 'account', account: sibling }, label: 'work' },
    ]) } } });
    expect(f.observations.filter(row => row.method === 'POST' && row.path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1))
      .toEqual([expect.objectContaining({ status: 200, signed: true, bearer: false })]);
    const op = f.operation('connectedServices.subscription.price.set', { account, price: { amount: 17, currency: 'EUR' } });
    const prepared = await f.prepare(op, { v: 1, caller: op.witness.agentStartCaller,
      sourceTurnId: 'turn', callerPermissionMode: null, requestId: op.requestId });
    if (!prepared) throw new Error('Missing price Home root');
    const sign = (path: string, body: unknown, effectActionId = op.actionId) =>
      createExternalActionAuthorizedRequestHeaders({ authorization: prepared.authorization, effectActionId,
        target: prepared.target, installationId: storage.state.installationId, method: 'POST', path, body,
        privateKey: installation.secretKey });
    for (const path of ['/v2/account/settings', CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1,
      '/v2/account/settings/history/normalize', '/v1/kv']) {
      expect((await f.app.inject({ method: 'POST', url: path, payload: {}, headers: sign(path, {}) })).statusCode).toBe(401);
    }
    const path = CONNECTED_PRESENTATION_ROWS_ROUTE_V1;
    const body = ConnectedPresentationRowMutationV1Schema.parse({ expectedRevision: 2,
      content: { t: 'plain', v: { v: 1, entries: [] } } });
    expect((await f.app.inject({ method: 'POST', url: path, payload: body,
      headers: sign(path, body, 'connectedServices.quota.get') })).statusCode).toBe(401);
    expect((await f.app.inject({ method: 'POST', url: path, payload: {}, headers: sign(path, {}) })).statusCode).toBe(401);
    expect((await f.app.inject({ method: 'POST', url: path, payload: { ...body, expectedRevision: 3 },
      headers: sign(path, body) })).statusCode).toBe(401);
    const siblingOp = { ...f.operation('usage.query', { queries: [{ includeAccounting: true,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
      includeQuotaHistory: false, includeInsights: false }] }), requestId: 'sibling-price-refusal' };
    const siblingPrepared = await f.prepare(siblingOp, { v: 1, caller: siblingOp.witness.agentStartCaller,
      sourceTurnId: 'turn', callerPermissionMode: null, requestId: siblingOp.requestId });
    if (!siblingPrepared) throw new Error('Missing sibling Home root');
    expect((await f.app.inject({ method: 'POST', url: path, payload: body,
      headers: createExternalActionAuthorizedRequestHeaders({ authorization: siblingPrepared.authorization,
        effectActionId: siblingOp.actionId, target: siblingPrepared.target,
        installationId: storage.state.installationId, method: 'POST', path, body,
        privateKey: installation.secretKey }) })).statusCode).toBe(401);
  } finally { await f.close(); }
});

it('lists saved Connected Accounts through the agent Session signed inventory root', async () => {
  const f = await fixture();
  const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'saved' };
  f.app.addHook('onSend', async (request, reply, payload) => request.url === '/v1/account/profile' && reply.statusCode === 200
    ? JSON.stringify(AccountProfileSchema.parse({ id: storage.account.id, connectedAccountsV4: [{ ref,
      status: 'connected', authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null,
      revisionSemantics: 'legacy_unfenced', credentialRevision: null }], connectedAccountGroupsV4: [] })) : payload);
  try {
    const outcome = await f.execute(f.operation('connectedServices.accounts.list', {}),
      { sessionId, isCurrent: async () => true });
    expect(outcome, JSON.stringify({ outcome, observations: f.observations })).toMatchObject({ ok: true,
      result: { accounts: [{ account: { ref } }], pools: [] } });
    const reads = f.observations.filter(row => row.path === '/v1/account/profile');
    expect(reads).toContainEqual(expect.objectContaining({ method: 'GET', status: 200, signed: true, bearer: false }));
    expect(reads.every(row => row.status === 200 && row.signed && !row.bearer)).toBe(true);
  } finally { await f.close(); }
});

it.each(['usage.query', 'usage.recap.private.compose', 'usage.recap.private.export'] as const)(
  'reads personal accounting through the Session Action daemon and signed Home authentication: %s', async actionId => {
  const f = await fixture();
  f.app.post('/v2/usage/query', { preHandler: f.app.authenticate }, async request => {
    UsageAnalyticsQueryRequestSchema.parse(request.body);
    expect(request.userId).toBe(storage.account.id);
    expect(request.headers.authorization).toBeUndefined();
    return { v: 1, totals: { eventCount: 1,
      tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
      cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } };
  });
  try {
    const query = {
      includeAccounting: true, includeSessionEvidence: false, includeTranscriptEvidence: false,
      includeWorkEvidence: false, includeQuotaHistory: false, includeInsights: false,
    };
    const outcome = await f.execute(f.operation(actionId, actionId === 'usage.query'
      ? { queries: [query] } : { query: { ...query, period: { startMs: 100, endMs: 200 } }, selectedFields: ['tokens'] }),
    { sessionId, isCurrent: async () => true });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (actionId === 'usage.query') {
      const batch = UsageQueryBatchResultSchema.parse(outcome.ok ? outcome.result : null);
      expect(batch.results[0]?.accounting?.totals.tokens.total).toBe(12);
    } else {
      const compose = { kind: 'composed', facts: { tokens: { total: 12 } } };
      expect(outcome).toMatchObject({ ok: true, result: actionId === 'usage.recap.private.compose'
        ? compose : { kind: 'unavailable', reason: 'render_target_unavailable', compose } });
    }
    expect(f.observations).toContainEqual(expect.objectContaining({
      path: '/v2/usage/query', status: 200, signed: true, bearer: false,
    }));
    // A finite recap also reads its preceding comparison population. Every
    // consumed read must retain the original signed root, never borrow bearer auth.
    expect(f.observations.filter(row => row.path === '/v2/usage/query')
      .every(row => row.status === 200 && row.signed && !row.bearer)).toBe(true);
  } finally { await f.close(); }
});

it.each(['none', 'wait', 'return'] as const)('admits a native message (%s) with the resolved receiver Session under its original Home root', async reply => {
  const f = await fixture();
  const channel = await createRequesterCurrentnessSocketHarness();
  try {
    storage.state.sessionAccessKeyIds.add(childId);
    f.app.get('/v2/sessions/:sessionId/delivery-mutes', { preHandler: f.app.authenticate,
      config: { apiTokenSessionAction: 'session.delivery.mute.list', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
    }, async () => ({ scopes: [] }));
    f.app.get('/v2/sessions/:sessionId/messages/reply-capability', { preHandler: f.app.authenticate,
      config: { apiTokenSessionAction: 'session.status.get', restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
    }, async () => ({ v: 1, protocolVersions: [1] }));
    const operation = f.operation('session.message.send', { sessionId: childId, message: 'Message the receiver', reply });
    const prepared = await f.prepare(operation, { v: 1, caller: operation.witness.agentStartCaller,
      sourceTurnId: 'turn', sourceInputId: 'input', callerPermissionMode: 'default', requestId: operation.requestId });
    expect(prepared).not.toBeNull();
    if (!prepared) throw new Error('Missing Home root');
    const admitted: string[] = [];
    const observer = new AbortController();
    const deps = createCliActionDeps({ token: f.credentials.token, credentials: f.credentials, sessionId: '', mode: 'plain', ctx: null,
      serverId, serverIdentityId: storage.state.homeId, serverHttpBaseUrl,
      externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: storage.state.installationId,
      getCurrentTurnWorkDepth: () => 0,
      sessionActionRpcTransport: async request => {
        expect(request.sessionId).toBe(sessionId);
        expect(request.method).toBe('session.message.reply.observe.v1');
        return { v: 1, ok: true, progress: { v: 1, mode: reply === 'none' ? 'wait' : reply,
          sourceSession: { sourceSessionId: sessionId, sourceTurnId: 'turn', sourceInputId: 'input', via: 'action' }, disposition: 'released' } };
      },
      // The receiver Machine is the network boundary. Home minting, signature
      // verification, Session-key admission and the send owner remain real.
      machineAdmissionTransport: async request => {
        expect(request.content).toMatchObject({ t: 'plain', v: { meta: { happierInputRequestV1: {
          sourceSession: { sourceSessionId: sessionId, sourceTurnId: 'turn', sourceInputId: 'input', via: 'action' },
        } } } });
        admitted.push(request.sessionId);
        // The tool observer may end after durable acceptance; it must not undo
        // the input. Reply/result custody itself has its existing composed tests.
        if (reply === 'wait') observer.abort();
        return { status: 'accepted', localId: request.localId };
      },
    });
    const send = (signal?: AbortSignal) => runWithServerHttpBaseUrl(serverHttpBaseUrl, () => deps.sessionSendMessage({
      sessionId: childId, message: 'Message the receiver', reply, requestedAction: { v: 1, kind: 'enqueue' },
      ...(signal ? { signal } : {}),
      actionCaller: operation.witness.agentStartCaller, callerSurface: 'agent',
      sessionInputSource: { sourceSessionId: sessionId, sourceTurnId: 'turn', sourceInputId: 'input', via: 'action',
        causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } },
      context: { surface: 'agent', authority: 'account_automation', serverId,
        actionCaller: operation.witness.agentStartCaller, actionRequestId: operation.requestId,
        callerPermissionMode: 'default',
        sessionInputSource: { sourceSessionId: sessionId, sourceTurnId: 'turn', sourceInputId: 'input', via: 'action' },
        externalActionExecutionAuthorization: prepared.authorization, externalActionTarget: prepared.target },
    }));
    const outcome = await send(reply === 'wait' ? observer.signal : undefined);
    expect(outcome, JSON.stringify(outcome)).toMatchObject(reply === 'wait'
      ? { ok: false, errorCode: 'cancelled', details: { admission: { status: 'accepted' } } }
      : { status: 'accepted' });
    expect(admitted).toEqual([childId]);
    expect(f.observations.filter(row => row.signed && row.status >= 400)).toEqual([]);
    storage.state.sessionAccessKeyIds.delete(childId);
    // Home's typed refusal of the withdrawn Session access reaches the caller unchanged.
    await expect(send()).rejects.toMatchObject({ code: 'action_forbidden', authorizationRefusal: 'original_target',
      failure: { failureCause: { phase: 'home.authorization.original_target', httpStatus: 401 } } });
    expect(admitted).toEqual([childId]);
    if (reply === 'none') {
      storage.state.sessionAccessKeyIds.add(childId);
      storage.state.revokedAt = new Date(1);
      await expect(send()).rejects.toMatchObject({ code: 'action_forbidden',
        failure: { failureCause: { phase: 'home.authorization.original_target', httpStatus: 401 } } });
      expect(admitted).toEqual([childId]);
    }
  } finally { await channel.close(); await f.close(); }
});

it.each(['bound', 'restricted', 'stopped-at-raise', 'foreign-witness', 'wrong-handler'] as const)(
  'answers a worker question through MCP and the source daemon origin: %s', async binding => {
  const f = await fixture();
  let managerAvailable = binding !== 'stopped-at-raise';
  const worker = createMutableApiSessionClientFixture({ sessionId: childId,
    serverBinding: { serverId, serverUrl: serverHttpBaseUrl },
    metadataPermissionMode: 'default',
    agentState: { requests: {}, completedRequests: {} },
    overrides: { readQuestionSessionSnapshot: async id => ({ sessionId: id, accountId: storage.account.id,
      managerSessionId: id === childId ? sessionId : null,
      available: id !== sessionId || managerAvailable, answersWorkerQuestions: true }) },
  });
  class QuestionHandler extends BasePermissionHandler { protected getLogPrefix() { return '[C7 answer]'; } }
  new QuestionHandler(worker);
  const workerMcp = createHappierMcpServer({ ...worker,
    getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
    getActiveTurnPermissionWitness: () => ({ turnId: 'worker-turn', inputId: 'worker-input',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } }),
  }, { authorityScope: 'session', sessionCredentials: { token: 'worker-session-token', encryption: null },
    actionsSettingsProvider: f.actionsSettingsProvider });
  const command = 'node /runtime/.runner-snapshots/manager-answer/dist/index.mjs';
  const runner = { pid: process.pid, processStartTimeMs: 23349,
    processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:manager-answer' };
  vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockResolvedValue({ ...runner, command });
  const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
  const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
    path, sessionId, runner, retainedAgent: createAgentSessionRunnerFactoryBinding({
      v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
      sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
      locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js',
    }) };
  await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31004, capability: 'C'.repeat(43) });
  vi.stubEnv('HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE', path);
  const witness = { turnId: 'manager-turn', inputId: 'manager-input', userMessageSeq: 1, userMessageSeqs: [1],
    callerPermissionMode: 'default' as const,
    causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const },
    agentStartCaller: { kind: 'session' as const,
      sessionId: binding === 'foreign-witness' ? childId : sessionId, starterDepth: 0, turnDepth: 0 } };
  // IPC and the Session socket are genuine process/network boundaries. Keep
  // daemon custody, authenticated Home reads, strict RPC and question owners real.
  stubUndiciFetch(async (_url: unknown, init?: RequestInit) => {
    const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
    expect(request.context).toEqual({ token: 'C'.repeat(43), sessionId });
    if (request.operation.kind !== 'action.execute') throw new Error('Expected Action envelope');
    expect(request.operation.toolCallId).toBe('native-manager-answer');
    const outcome = await f.execute(request.operation, { sessionId, isCurrent: async () => true });
    return Response.json({ ok: true, result: { kind: 'action.execution', requestId: request.operation.requestId, outcome } });
  });
  const transport = vi.fn<SessionActionRpcTransport>(async request => {
    expect(request.origin).toMatchObject({ caller: { sessionId }, sourceTurnId: 'manager-turn',
      sourceInputId: 'manager-input', callerPermissionMode: 'default' });
    // Substitute the authenticated Machine→Home→Session network only. The
    // actual source origin is produced by daemon custody and the strict reader.
    return await worker.rpcHandlerManager.handleRequest({ method: `${request.sessionId}:${request.method}`,
      requestId: 'answer-receiver', params: request.input,
      callerAuthority: 'account_automation', sessionActionOrigin: request.origin,
      authorization: { kind: 'session.permission.respond', sessionId: childId,
        actor: { kind: 'accountUser', accountId: storage.account.id, relationship: 'owner' } } });
  });
  f.setSessionActionRpcTransport(transport);
  const runtime = createHappierMcpServer({ sessionId,
    getServerBinding: () => ({ serverId, serverUrl: serverHttpBaseUrl }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
    updateMetadata() {}, getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0, getPermissionMode: () => 'default',
    getActiveTurnAdmissionWitness: () => witness, getActiveTurnPermissionWitness: () => witness,
  }, { credentials: f.credentials, isCredentialCurrent: async () => true, mcpToolCallIdMetaKey: 'callId',
    ...(binding === 'restricted' ? { authorityScope: 'session' as const, sessionCredentials: f.credentials } : {}),
    actionsSettingsProvider: f.actionsSettingsProvider });
  const client = new Client({ name: 'c7-manager-answer', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const workerClient = new Client({ name: 'c7-worker-question', version: '1' });
  const [workerClientTransport, workerServerTransport] = InMemoryTransport.createLinkedPair();
  try {
    await workerMcp.mcp.connect(workerServerTransport);
    await workerClient.connect(workerClientTransport);
    const raised = await workerClient.callTool({ name: 'action_execute', arguments: { actionId: 'session.needs_you.raise',
      input: { mode: 'continue', assumption: 'Proceed', lasting: false, type: 'decision',
        questions: [{ id: 'choose', prompt: 'Continue?', type: 'text' }] } } });
    const requestId = Object.keys(worker.getAgentStateSnapshot()?.requests ?? {})[0];
    expect(requestId, JSON.stringify(raised)).toBeTruthy();
    expect(worker.getAgentStateSnapshot()?.requests?.[requestId!]).toMatchObject({
      currentHandler: binding === 'stopped-at-raise' ? { kind: 'person' } : { kind: 'session', sessionId },
    });
    // Resuming the manager cannot transfer a question already assigned to the person.
    managerAvailable = true;
    if (binding === 'wrong-handler') worker.updateAgentState(state => ({ ...state, requests: { ...state.requests,
      [requestId!]: { ...state.requests![requestId!]!, currentHandler: { kind: 'session', sessionId: 'another-manager' } } } }));
    await runtime.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
      actionId: 'session.user_action.answer', input: { sessionId: childId, requestId,
        answers: [{ question: 'choose', values: ['yes'] }] },
    }, _meta: { callId: 'native-manager-answer' } }));
    if (binding === 'bound' || binding === 'restricted') {
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(worker.getAgentStateSnapshot()?.completedRequests?.[requestId!]).toMatchObject({
        answeredBy: { kind: 'session', sessionId }, structuredAnswersV1: { choose: ['yes'] } });
      expect(worker.getAgentStateSnapshot()?.requests?.[requestId!]).toBeUndefined();
      expect(f.observations).not.toContainEqual(expect.objectContaining({
        path: '/v1/actions/session.user_action.answer/execution-authorization' }));
    } else {
      expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining(
        binding === 'foreign-witness' ? 'target_unavailable' : 'present_user_required') }] });
      expect(worker.getAgentStateSnapshot()?.completedRequests?.[requestId!]).toBeUndefined();
      expect(worker.getAgentStateSnapshot()?.requests?.[requestId!]).toBeDefined();
      if (binding === 'stopped-at-raise') {
        await expect(transport.mock.results[0]?.value).resolves.toMatchObject({
          ok: false, errorCode: 'present_user_required', requestId,
        });
        expect(worker.getAgentStateSnapshot()?.requests?.[requestId!])
          .toMatchObject({ currentHandler: { kind: 'person' } });
      }
      if (binding === 'foreign-witness') expect(transport).not.toHaveBeenCalled();
    }
  } finally {
    await client.close(); await runtime.mcp.close(); await workerClient.close(); await workerMcp.mcp.close();
    await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority, capabilityDigest: hashPrivateBearer('C'.repeat(43)) });
    await f.close();
  }
});

it('retains the worker question refusal through the Session Action and its MCP result', async () => {
  const f = await fixture();
  const requestId = 'worker-question';
  const worker = createMutableApiSessionClientFixture({ sessionId: childId, agentState: { requests: {
    [requestId]: { tool: 'AskUserQuestion', kind: 'user_action', createdAt: 100,
      arguments: { questions: [{ question: 'Continue?' }] }, questionV1: { mode: 'wait', lasting: false },
      currentHandler: { kind: 'session', sessionId } },
  } }, overrides: { readQuestionSessionSnapshot: async () => null } });
  new ProviderEnforcedPermissionHandler(worker, { logPrefix: '[Manager question refusal]' });
  // Home's authenticated socket is the boundary here. The SQLite socket
  // integration separately exercises the real actor minting and snapshot read.
  const transport = vi.fn<SessionActionRpcTransport>(request => worker.rpcHandlerManager.handleRequest({
    method: `${request.sessionId}:${request.method}`, params: request.input,
    callerAuthority: 'account_automation', sessionActionOrigin: request.origin,
    authorization: { kind: 'session.permission.respond', sessionId: childId,
      actor: { kind: 'accountUser', accountId: storage.account.id, relationship: 'owner' } },
  }, undefined, 'authenticated_home_socket'));
  f.setSessionActionRpcTransport(transport);
  const execute = vi.fn<Parameters<typeof createActionToolExecutorBridge>[0]['executor']['execute']>(
    (actionId, input, context) => f.execute(f.operation(actionId, input as Operation['input']),
      { sessionId, isCurrent: async () => true, signal: context.signal }));
  const bridge = createActionToolExecutorBridge({ executor: { execute }, surface: 'agent' });
  const server = new McpServer({ name: 'manager-refusal', version: '1' });
  registerHappierMcpBuiltInTools(server, { sessionId, surface: 'agent', deps: { ...bridge,
    changeTitle: async () => { throw new Error('Unexpected title change'); } } });
  const client = new Client({ name: 'manager', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const toolResult = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
      actionId: 'session.user_action.answer', input: { sessionId: childId, requestId,
        answers: [{ question: 'Continue?', values: ['Yes'] }] },
    } }));
    const failureCause = { phase: 'rpc.handler.manager_question.admission_refused',
      errorCode: 'present_user_required', errorClass: 'RpcError', httpStatus: null };
    await expect(transport.mock.results[0]?.value).resolves.toMatchObject({ ok: false, errorCode: 'present_user_required', requestId, failureCause });
    await expect(execute.mock.results[0]?.value).resolves.toMatchObject({ ok: false, errorCode: 'present_user_required', failureCause });
    const payload = toolResult.content[0];
    expect(toolResult.isError).toBe(true);
    expect(payload?.type === 'text' && JSON.parse(payload.text)).toMatchObject({ errorCode: 'present_user_required', failureCause });
  } finally { await client.close(); await server.close(); await f.close(); }
});

it('reads the active Discussion source through its original signed transcript root', async () => {
  const f = await fixture();
  const discussionId = 'source-discussion';
  const messageId = 'message-child';
  const discussionAddressing = { discussionId, messageId: 'question', throughSeq: 1, participantSessionId: sessionId };
  const question = { id: 'question', discussionId, localId: 'question', seq: 1,
    authorAccountId: storage.account.id, accountActor: { v: 1, accountId: storage.account.id, profile: null },
    producerV1: null, content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Check the source' }] } },
    mentionedAccountIds: [], createdAt: 1 };
  const summary = DiscussionSummaryV1Schema.parse({ id: discussionId, ownerAccountId: storage.account.id,
    encryptionMode: 'plain', anchor: { kind: 'session', sessionId: childId, messageId },
    access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: 'source-discussion-create',
    titleContent: { t: 'plain', v: { v: 1, title: 'Source' } },
    latestMessage: { id: question.id, localId: question.localId, seq: question.seq, authorAccountId: question.authorAccountId,
      accountActor: question.accountActor, producerV1: null, createdAt: 1 }, messageSeq: 1, lastReadSeq: 0, unreadCount: 1,
    unreadMentionCount: 0, recentAuthorAccountIds: [storage.account.id], archivedAt: null,
    capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true,
      sendToSession: true, manageAccess: true, leave: false } });
  let readable = true;
  f.members.delete(childId);
  f.setServerFeatureReader(() => ({ status: 'ready', features: FeaturesResponseSchema.parse({
    features: { sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } }, capabilities: {},
  }) }));
  f.app.addHook('onSend', async (request, _reply, payload) => {
    if (request.url.startsWith(`/v1/sessions/${childId}/messages`)) {
      expect(readSessionAccessAuthenticationFromRequest(request).contentDisclosureSessionId).toBe(sessionId);
    }
    return payload;
  });
  f.app.get('/v1/discussions/:discussionId', { preHandler: f.app.authenticate, config: { allowApiToken: true },
    schema: { params: DiscussionRouteDiscussionParamsV1Schema } }, async () => ({ discussion: summary }));
  f.app.get('/v1/discussions/:discussionId/messages', { preHandler: f.app.authenticate, config: { allowApiToken: true },
    schema: { params: DiscussionRouteDiscussionParamsV1Schema, querystring: DiscussionMessagesQueryV1Schema } }, async (request, reply) => {
    expect(request.query).toMatchObject({ messageId: discussionAddressing.messageId, throughSeq: 1 });
    return readable ? { messages: [question], messageSeq: 1, hasMoreOlder: false }
      : reply.code(403).send({ error: 'discussion_access_forbidden' });
  });
  try {
    const operation = f.operation('session.transcript.get', { sessionId: childId, messageId });
    operation.witness = { ...operation.witness, discussionAddressing };
    const invoke = () => f.execute(operation, { sessionId, isCurrent: async () => true });
    expect(await invoke(), JSON.stringify(f.observations)).toMatchObject({ ok: true,
      result: { sessionId: childId, items: [{ id: messageId, text: 'Child ready' }] } });
    const sourceReads = () => f.observations.filter(row => row.path.startsWith(`/v1/sessions/${childId}/messages`));
    expect(sourceReads()).toHaveLength(1);
    expect(f.observations.filter(row => row.path.startsWith('/v1/discussions/'))).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'GET', path: `/v1/discussions/${discussionId}`, status: 200, signed: true, bearer: false }),
      expect.objectContaining({ method: 'GET', status: 200, signed: true, bearer: false }),
    ]));
    readable = false;
    expect(await invoke()).toMatchObject({ ok: false });
    expect(sourceReads()).toHaveLength(1);
  } finally { await f.close(); }
});

it('preserves the addressed reply policy admission under its original signed Account root', async () => {
  const f = await fixture();
  const admissionFailures: Array<{ name: string; frames: string[] }> = [];
  f.app.addHook('onError', async (_request, _reply, error) => {
    admissionFailures.push({ name: error.name, frames: error.stack?.split('\n').slice(1, 6) ?? [] });
  });
  const discussionId = 'addressed-discussion';
  const path = `/v1/discussions/${discussionId}/participants`;
  let answerPolicy: 'when_addressed' | 'drafts_for_approval' = 'when_addressed';
  // Only the resource database response is fixed. Authentication, Home root
  // issuance, signatures, HTTP admission and the real reply binder all run.
  f.app.get('/v1/discussions/:discussionId/participants', { preHandler: f.app.authenticate,
    config: { allowApiToken: true } }, async () => ({ discussionId, ownerAccountId: storage.account.id,
    access: 'owner', grants: [], participants: [{ participant: { kind: 'session', sessionId },
      answerPolicy, createdAt: 1 }] }));
  try {
    const input = { discussionId, localId: 'explicit-reply', replyTarget: { kind: 'message', messageId: 'question' },
      content: { v: 1, parts: [{ t: 'text', text: 'The quoted arithmetic is correct.' }] } };
    const op = f.operation('discussion.reply', input);
    const prepared = await f.prepare(op, { v: 1, caller: op.witness.agentStartCaller,
      sourceTurnId: 'turn', sourceInputId: 'input', callerPermissionMode: null, requestId: op.requestId }).catch(error => {
        throw new Error(`Signed Discussion original admission failed: ${JSON.stringify({ observations: f.observations, admissionFailures })}`, { cause: error });
      });
    if (!prepared) throw new Error('Missing original Discussion reply root');
    const source = { sourceSessionId: sessionId, sourceTurnId: 'turn', sourceInputId: 'input', via: 'action' as const,
      discussionAddressing: { discussionId, messageId: 'question', throughSeq: 2, participantSessionId: sessionId } };
    const context = { surface: 'agent' as const, authority: 'account_automation' as const, serverId,
      defaultSessionId: sessionId, actionCaller: op.witness.agentStartCaller, sessionInputSource: source,
      externalActionExecutionAuthorization: prepared.authorization, externalActionTarget: prepared.target };
    const { discussionAction } = createDiscussionActionDeps({ credentials: f.credentials, serverId,
      serverHttpBaseUrl, serverIdentityId: storage.state.homeId,
      externalActionMachineRequestPrivateKey: installation.secretKey,
      externalActionMachineInstallationId: storage.state.installationId,
      resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
        features: { sessions: { enabled: true, conversations: { enabled: true } },
          sharing: { enabled: true, session: { enabled: true } } }, capabilities: {},
      }) }),
    });
    const bound = await bindDiscussionDraftReply({ actionId: op.actionId, input, context, serverId, discussionAction });
    const reads = f.observations.filter(row => row.path === path);
    expect({ bound, reads }).toMatchObject({ bound: { actionId: 'discussion.reply', input, context },
      reads: [] });
    expect(bound).not.toHaveProperty('failure');
    // A policy change applies at the next publication admission. Binding an
    // already signed original neither rereads policy nor rewrites its operands.
    answerPolicy = 'drafts_for_approval';
    const changed = await bindDiscussionDraftReply({ actionId: op.actionId, input, context, serverId, discussionAction });
    expect(changed).toEqual({ actionId: 'discussion.reply', input, context });
    expect(f.observations.filter(row => row.path === path)).toEqual([]);
  } finally { await f.close(); }
});

it('classifies the actual contributed Account definition before requiring Machine authorization at the capability receiver', async () => {
  const f = await fixture(1, undefined, false, true, false);
  vi.stubGlobal('fetch', async () => Response.json(FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } },
    capabilities: { serverIdentity: { serverIdentityId: storage.state.homeId } } })));
  try {
    const outcome = await f.execute(f.operation('action.invoke', {
      action: { pluginId: f.authoredAccount!.pluginId, localId: 'echo' }, input: { key: 'receiver' },
    }), { sessionId, isCurrent: async () => true });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: { key: 'receiver', surface: 'agent' } });
    expect(f.observations.some(observation => observation.path.includes('action.invoke/execution-authorization'))).toBe(false);
  } finally { await f.close(); }
});

it.each([
  { executionRunTargetMachineId: undefined, expectedMachineId: 'session-source-machine' },
  { executionRunTargetMachineId: 'run-source-machine', expectedMachineId: 'run-source-machine' },
])('retains the host-selected Machine for a Session Account aggregate source ($expectedMachineId)', async ({ executionRunTargetMachineId, expectedMachineId }) => {
  const f = await fixture(1, undefined, false, true, true, undefined,
    { sessionMachineId: 'session-source-machine', ...(executionRunTargetMachineId ? { executionRunTargetMachineId } : {}) });
  const inputSchema = defineProtocolObject({ key: defineProtocolString() }, { policy: 'closed' });
  const resultSchema = defineProtocolObject({ key: defineProtocolString(), machine: defineProtocolLiteral(true) }, { policy: 'closed' });
  const protocol = defineContributionProtocol({ id: 'session-account-machine-read', version: 1, operations: {
    read: { required: true, input: { kind: 'protocolDefined', schema: inputSchema }, resultSchema,
      action: { surfaces: ['plugin'], dangerLevel: 'safe' } },
  } });
  const provider = definePlugin({ id: 'acme.account-source-provider', version: '1.0.0', actions: {
    read: { title: 'Read Session provider', surfaces: ['plugin'], dangerLevel: 'safe', inputSchema, resultSchema,
      run: async ({ key }) => ({ key, machine: true as const }) },
  }, contributesTo: { 'acme.account-actions': { sources: {
    provider: protocol.contribute({ operations: { read: protocol.operations.read.bind('read') } }),
  } } } });
  const manifest = normalizePluginManifestV2(provider.manifest);
  const source = DaemonPluginTargetedSourceDeclarationV1Schema.parse({ manifest: { id: manifest.id, contributes: {
    actions: manifest.contributes.actions, pluginContributionPoints: [],
    targetedPluginContributions: manifest.contributes.targetedPluginContributions, ui: { renderers: [] },
  } }, occurrenceId: 'session-provider-occurrence', sourceCustody: {
    kind: 'managed', immutableGenerationId: 'session-provider-generation', installSource: 'archive',
  } });
  let sourceReads = 0;
  const selectedMachines: string[] = [];
  // Machine RPC is the external boundary. The authored Account handler,
  // source declarations, placement, caller admission and strict wire stay real.
  vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
    selectedMachines.push(request.machineId);
    expect(request.requireCurrentMachine).toBe(true);
    if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) {
      return DaemonPluginUiTargetedContributionsReadResponseSchema.parse({ status: 'sourceDeclarations',
        pluginId: f.authoredAccount!.pluginId, sourceDeclarations: [source] });
    }
    expect(request.method).toBe(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request.request)).toMatchObject({
      machineId: expectedMachineId, qualifiedActionId: `${manifest.id}/read`,
      input: { key: 'pr-status' }, expectedContributorOccurrenceId: source.occurrenceId,
      invocation: { kind: 'clientPluginAction', clientActionBinding: { pluginId: f.authoredAccount!.pluginId,
        contributionLocalId: 'source', sourceCustody: { kind: 'account_release' } } },
    });
    sourceReads++;
    return { ok: true, result: { key: 'pr-status', machine: true } };
  });
  vi.stubGlobal('fetch', async () => Response.json(FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } },
    capabilities: { serverIdentity: { serverIdentityId: storage.state.homeId } } })));
  try {
    const outcome = await f.execute(f.operation('action.invoke', {
      action: { pluginId: f.authoredAccount!.pluginId, localId: 'source' }, input: { key: 'pr-status' },
    }), { sessionId, isCurrent: async () => true });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: { key: 'pr-status', machine: true } });
    expect(selectedMachines.length).toBeGreaterThan(0);
    expect(selectedMachines.every(machineId => machineId === expectedMachineId)).toBe(true);
    expect(sourceReads).toBe(1);
    expect(f.observations.some(observation => observation.path.includes('action.invoke/execution-authorization'))).toBe(false);
  } finally { await f.close(); }
});

it.each(['search', 'get'] as const)('reads the enabled Account Action through the current-process capability factory (%s)', async operation => {
  const f = await fixture(1, undefined, false, true);
  try {
    const id = `${f.authoredAccount!.pluginId}/actions/echo`;
    const outcome = await f.execute(f.operation(operation === 'search' ? 'action.spec.search' : 'action.spec.get',
      operation === 'search' ? { query: id } : { id }), { sessionId, isCurrent: async () => true });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: operation === 'search'
      ? { actionSpecs: expect.arrayContaining([expect.objectContaining({ id, executionPlacement: 'account' })]) }
      : { actionSpec: { id, executionPlacement: 'account' } } });
  } finally { await f.close(); }
});

it('keeps a real client descriptor readable without granting client invocation Account placement', async () => {
  const clientAction = await admittedClientActionFixture();
  const f = await fixture(1, undefined, false, true, true, clientAction);
  vi.stubGlobal('fetch', async () => Response.json(FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } },
    capabilities: { serverIdentity: { serverIdentityId: storage.state.homeId } } })));
  try {
    const id = `${clientAction.action.pluginId}/actions/${clientAction.action.localId}`;
    const descriptor = await f.execute(f.operation('action.spec.get', { id }), { sessionId, isCurrent: async () => true });
    expect(descriptor, JSON.stringify(descriptor)).toMatchObject({ ok: true, result: { actionSpec: { id, executionPlacement: 'client' } } });
    expect(await f.execute(f.operation('action.invoke', { action: clientAction.action, input: {} }),
      { sessionId, isCurrent: async () => true }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', details: { reason: 'external_authorization_missing' } });
    expect(clientAction.effects()).toBe(0);
  } finally { await clientAction.runtime.dispose(); await f.close(); }
});

it('preserves an existing client Action at the credentialed native Agent entry', async () => {
  await withTempDir('credentialed-agent-client-', async homeDir => {
    const previousEnv = process.env;
    process.env = { ...previousEnv, HAPPIER_HOME_DIR: homeDir };
    reloadConfiguration();
    const clientAction = await admittedClientActionFixture();
    const f = await fixture(1, undefined, false, true, true, clientAction);
    const terminalCredentials = { token: await auth.createToken(storage.account.id, undefined,
      { kind: 'terminal', authority: 'account_automation' }), encryption: null };
    await writeStoredCredentialsForServerId(serverId, terminalCredentials);
    const credentials = await readStoredCredentialsForServerId(serverId);
    if (!credentials) throw new Error('Missing captured Account credentials');
    installClientMachineControlHttp(clientAction);
    const features = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } },
      capabilities: { serverIdentity: { serverIdentityId: storage.state.homeId } } });
    vi.stubGlobal('fetch', async () => Response.json(features));
    const witness = { ...f.operation('action.invoke', {}).witness, turnId: 'native-client-turn',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' } };
    const daemon = await createSessionDaemonAuthorityFixture({ sessionId,
      execute: operation => f.execute(operation, { sessionId, isCurrent: async () => true }),
    });
    const runtime = createHappierMcpServer({ sessionId,
      getServerBinding: () => ({ serverId, serverUrl: serverHttpBaseUrl }),
      getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }), updateMetadata() {},
      getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0, getPermissionMode: () => 'default',
      getActiveTurnAdmissionWitness: () => witness, getActiveTurnPermissionWitness: () => witness,
    }, { credentials, actionsSettingsProvider: f.actionsSettingsProvider, pluginToolCatalog: [] });
    try {
      const outcome = await runtime.executeTool({ toolName: 'action_execute', args: {
        actionId: 'action.invoke', input: { action: clientAction.action, input: {} },
      } });
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: { v: 1, kind: 'createTask', draftId: 'client-draft' } });
      expect(clientAction.effects()).toBe(1);
    } finally {
      await runtime.mcp.close(); await daemon.close(); await clientAction.runtime.dispose(); await f.close();
      process.env = previousEnv; reloadConfiguration();
    }
  });
});

it.each(['direct daemon', 'native agent'] as const)('retains original Home authorization for an actual Machine Action via %s', async entry => {
  const f = await fixture(1, undefined, false, true);
  vi.stubGlobal('fetch', async () => Response.json(FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } },
    capabilities: { serverIdentity: { serverIdentityId: storage.state.homeId } } })));
  const pluginId = f.authoredAccount!.pluginId;
  const machine = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{
    includeAvailability: true,
    manifest: createPluginManifestV2Fixture({ id: pluginId, engines: { happier: '^0.3.0' }, contributes: { actions: [{ id: 'echo', title: 'Machine echo',
      scopes: ['global'], surfaces: ['agent', 'cli'], dangerLevel: 'safe', execution: { target: 'daemon' },
      inputSchema: { type: 'object', properties: { key: { type: 'string' }, machineId: { type: 'string' } }, required: ['key'], additionalProperties: false },
      inputHints: { fields: [{ path: 'key', title: 'Key', widget: 'select', options: [{ value: 'machine', label: 'Machine' }] }] },
    }] } }),
    files: { 'daemon.mjs': `let effects = 0;
function refuse(code) {
  throw Object.assign(new Error(code), { name: 'PluginError', code, retryable: false, data: { name: 'PluginError', code } });
}
export function activate(api) {
  api.actions.register('echo', async (input, context) => {
    if (input.machineId) {
      if (!context.chosenMachine || !context.requesterAccount) {
        refuse('plugin_service_unavailable');
      }
      if (input.machineId !== context.chosenMachine.machineId) {
        refuse('target_unavailable');
      }
      return { key: input.key, machine: context.chosenMachine, accountId: context.requesterAccount.accountId, agentCaller: context.agentCaller };
    }
    return { key: input.key, surface: context.surface, effects: ++effects };
  });
}` },
  }] });
  const list = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () => machine.controller.tryAcquireRuntimeRegistry() });
  const invoke = createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: () => machine.controller.acquireRuntimeRegistry() });
  const createExecutor = (options?: Readonly<{ accountPluginActions: true }>,
    pluginActionExecutionOwner: 'current_process' | 'daemon_control' = 'current_process') => createCliActionExecutor({
    token: f.credentials.token, credentials: f.credentials, sessionId: '', mode: 'plain', ctx: null,
    serverId, serverIdentityId: storage.state.homeId, serverHttpBaseUrl,
    externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: storage.state.installationId,
    actionsSettingsProvider: f.actionsSettingsProvider, pluginActionExecutionOwner,
    listContributedActionDefinitions: list, invokeContributedAction: invoke, ...options,
  });
  const receiver = (authorized: boolean) => createDaemonSessionAccountActionExecutor({ serverId, serverHttpBaseUrl,
    credentials: f.credentials, token: f.credentials.token, machineId: storage.state.machineId,
    ...(authorized ? { prepareExternalActionAuthorization: async ({ operation, sessionActionOrigin, isCallerCurrent }) => {
      if (operation.actionId !== 'action.invoke') return undefined;
      const admitted = await f.prepare(operation, sessionActionOrigin);
      return admitted && { ...admitted, verifyMachineAdmissionCurrent: isCallerCurrent };
    } } : {}),
    createExecutor: (_depth, _current, _post, options) => ({
      execute: (id, input, context) => createExecutor(options).execute(id, input,
        projectAdmittedExternalActionMachineContext(context, storage.state.machineId, 'plain')),
      prepare: (id, input, context, prepareOptions) => createExecutor(options).prepare(id, input,
        projectAdmittedExternalActionMachineContext(context, storage.state.machineId, 'plain'), prepareOptions),
    }),
  });
  const operation = f.operation('action.invoke', { action: { pluginId, localId: 'echo' }, input: { key: 'machine' } });
  try {
    if (entry === 'native agent') {
      const qualifiedId = `${pluginId}/actions/echo`;
      expect(list({ id: qualifiedId })).toMatchObject([{ id: qualifiedId, executionPlacement: 'machine' }]);
      f.authoredAccount!.setBundledFallback();
      const daemon = await createSessionDaemonAuthorityFixture({ sessionId,
        execute: request => receiver(true)(request, { sessionId, isCurrent: async () => true }),
      });
      const witness = operation.witness;
      const runtime = createHappierMcpServer({ sessionId,
        getServerBinding: () => ({ serverId, serverUrl: serverHttpBaseUrl }),
        rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
        updateMetadata() {}, getActiveTurnAdmissionWitness: () => witness,
      }, { authorityScope: 'session', actionsSettingsProvider: f.actionsSettingsProvider,
        pluginRuntimeRegistryLease: machine.lease });
      const invoke = (actionId: string, input: unknown) => runtime.executeTool({
        toolName: 'action_execute', args: { actionId, input },
      });
      try {
        const input = { key: 'machine', machineId: storage.state.machineId };
        const result = await invoke(qualifiedId, input);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
          machine: { machineId: storage.state.machineId, installationId: storage.state.installationId },
          accountId: storage.account.id, agentCaller: true,
        } });
        const action = { pluginId, localId: 'echo' };
        expect(await invoke('action.invoke', { action, input })).toEqual(result);
        expect(await invoke('action.invoke', { action, input: { ...input, machineId: 'foreign-machine' } }))
          .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
      } finally {
        await runtime.mcp.close();
        await daemon.close();
      }
      return;
    }
    expect(await f.execute(f.operation('action.spec.get', { id: `${pluginId}/actions/echo` }),
      { sessionId, isCurrent: async () => true })).toMatchObject({ ok: true, result: { actionSpec: { executionPlacement: 'account' } } });
    // A real Account selection can disappear after classification while an
    // independently admitted Machine handler still owns the same public id.
    f.authoredAccount!.setBundledFallback();
    // An independently committed Machine declaration remains usable when the
    // Account selection disappears; unavailable or Account-only placement cannot borrow it.
    expect(await createExecutor({ accountPluginActions: true }).execute('action.invoke', operation.input,
      { surface: 'agent', authority: 'account_automation', defaultSessionId: sessionId }))
      .toMatchObject({ ok: true, result: { key: 'machine', surface: 'agent', effects: 1 } });
    expect(await receiver(false)(operation, { sessionId, isCurrent: async () => true }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable', details: { reason: 'external_authorization_missing' } });
    const outcome = await receiver(true)(operation, { sessionId, isCurrent: async () => true });
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: { key: 'machine', surface: 'agent', effects: 2 } });
    installClientMachineControlHttp({ runtime: machine });
    const choices = await createExecutor(undefined, 'daemon_control').execute('action.options.resolve', {
      actionId: `${pluginId}/actions/echo`, fieldPath: 'key',
    }, { surface: 'agent', defaultSessionId: sessionId });
    expect(choices, JSON.stringify(choices)).toMatchObject({ ok: true, result: {
      actionId: `${pluginId}/actions/echo`, fieldPath: 'key', options: [{ value: 'machine', label: 'Machine' }],
    } });
  } finally { await machine.dispose(); await f.close(); }
});

it('executes an authored Account Action through restricted Agent capability custody without a selected Machine', async () => {
  await withTempDir('restricted-agent-account-', async homeDir => {
    const previousEnv = process.env;
    process.env = { ...previousEnv, HAPPIER_HOME_DIR: homeDir };
    reloadConfiguration();
    const clientAction = await admittedClientActionFixture();
    const f = await fixture(1, undefined, false, true, true, clientAction);
    const command = 'node /runtime/.runner-snapshots/restricted-account/dist/index.mjs';
    const runner = { pid: process.pid, processStartTimeMs: 23349,
      processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:restricted-account' };
    vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockResolvedValue({ pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command });
    const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
    const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
      path, sessionId, runner, retainedAgent: createAgentSessionRunnerFactoryBinding({
        v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
        sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
        locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
        normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js',
      }) };
    await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31002, capability: 'B'.repeat(43) });
    process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE = path;
    await writeStoredCredentialsForServerId(serverId, f.credentials);
    const runnerCredentials = { token: await auth.createToken(storage.account.id, { sessionId },
      { kind: 'ephemeral_session_runner', authority: 'session_runtime' }), encryption: null };
    // The daemon-control HTTP boundary exposes only its actual Machine catalog:
    // this external plugin is enabled in Home, not installed on a Machine.
    installClientMachineControlHttp(clientAction);
    let current = true;
    const capabilities: AgentRuntimeDaemonServiceRequestV1[] = [];
    const features = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } },
      capabilities: { serverIdentity: { serverIdentityId: storage.state.homeId } } });
    vi.stubGlobal('fetch', async () => Response.json(features));
    stubUndiciFetch(async (_url: unknown, init?: RequestInit) => {
      if (!init?.body) return Response.json(features);
      const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init.body)));
      capabilities.push(request);
      expect(request.context).toEqual({ token: 'B'.repeat(43), sessionId });
      if (request.operation.kind !== 'action.execute') throw new Error('Expected Action capability');
      const outcome = await f.execute(request.operation, { sessionId, isCurrent: async () => current });
      return Response.json({ ok: true, result: { kind: 'action.execution', requestId: request.operation.requestId, outcome } });
    });
    const witness = { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1], callerPermissionMode: 'default',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' },
      agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 } };
    const runtime = createHappierMcpServer({ sessionId,
      getServerBinding: () => ({ serverId, serverUrl: serverHttpBaseUrl }),
      getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features }),
      rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
      updateMetadata() {}, getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0, getPermissionMode: () => 'default',
      getActiveTurnAdmissionWitness: () => witness, getActiveTurnPermissionWitness: () => witness,
    }, { authorityScope: 'session', sessionCredentials: runnerCredentials, actionsSettingsProvider: f.actionsSettingsProvider });
    try {
      const invoke = () => runtime.executeTool({ toolName: 'action_execute', args: {
        actionId: 'action.invoke', input: { action: { pluginId: f.authoredAccount!.pluginId, localId: 'echo' }, input: { key: 'restricted' } },
      } });
      const outcome = await invoke();
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: { key: 'restricted', surface: 'agent' } });
      expect(capabilities[0]?.operation).toMatchObject({ kind: 'action.execute', actionId: 'action.spec.get' });
      expect(capabilities.some(request => request.operation.kind === 'action.execute' && request.operation.actionId === 'action.invoke')).toBe(true);
      expect(f.observations.some(observation => observation.path.includes('action.invoke/execution-authorization'))).toBe(false);
      const clientStart = capabilities.length;
      const clientOutcome = await runtime.executeTool({ toolName: 'action_execute', args: {
        actionId: 'action.invoke', input: { action: clientAction.action, input: {} },
      } });
      expect(clientOutcome, JSON.stringify(clientOutcome)).toMatchObject({ ok: true, result: { v: 1, kind: 'createTask', draftId: 'client-draft' } });
      expect(clientAction.effects()).toBe(1);
      expect(capabilities.slice(clientStart).every(request => request.operation.kind === 'action.execute'
        && request.operation.actionId === 'action.spec.get')).toBe(true);
      current = false;
      expect(await invoke()).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    } finally {
      await runtime.mcp.close();
      await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority, capabilityDigest: hashPrivateBearer('B'.repeat(43)) });
      await clientAction.runtime.dispose();
      await f.close();
      process.env = previousEnv;
      reloadConfiguration();
    }
  });
});

it.each([503, 401, 403] as const)('keeps Home mint availability distinct from authorization denial (%s), then recovers', async status => {
  const f = await fixture();
  f.markInactive();
  try {
    f.setActionsSettings(normalizeActionsSettingsV1({ v: 1, actions: { 'session.archive': { disabledSurfaces: [] } } }));
    f.failAuthorization(status);
    const outcome = await f.execute(f.operation('session.archive', { sessionId: childId }), { sessionId, isCurrent: async () => true });
    expect(outcome).toMatchObject(status === 503
      ? { ok: false, errorCode: 'project_requester_home_unavailable',
        failureCause: { nativeErrorReason: 'server_unreachable', httpStatus: null } }
      : { ok: false, errorCode: 'invalid_token', details: { reason: 'external_authorization_refused',
        phase: 'session.authorization.mint', requiredFact: 'home_minted_authorization' } });
    expect(ActionExecuteFailureSchema.parse(outcome)).toEqual(outcome);
    expect(f.lifecycleEffects).toEqual([]);
    f.failAuthorization();
    const recovered = await f.execute(f.operation('session.archive', { sessionId: childId }), { sessionId, isCurrent: async () => true });
    expect(recovered, recovered.ok ? undefined : JSON.stringify({
      errorCode: recovered.errorCode, failureCause: recovered.failureCause,
    })).toMatchObject({ ok: true });
  } finally { await f.close(); }
});

it.each([
  { conflictFirst: false, expectedRequests: 1, scenario: 'settles an explicit Browser Session mint refusal after exactly one request' },
  { conflictFirst: true, expectedRequests: 2, scenario: 'remints after a generic 409 without a typed Home refusal' },
])('$scenario', async ({ conflictFirst, expectedRequests }) => {
  const f = await fixture();
  const controller = new AbortController();
  const actionId = 'browser.recording.start';
  const operation = f.operation(actionId, {
    browserSessionId: 'browser-session', viewId: 'view', profileId: 'profile',
    targetKind: 'externalUrl', adapterKind: 'chromiumSidecar', renderEngineKind: 'electronWebContentsView',
    captureKind: 'cdpScreencast', fidelity: 'cdp', navigationGeneration: 1,
    mimeType: 'video/webm', retentionClass: 'preSend',
  });
  const refusal = projectExternalActionHttpError('target_unavailable', operation.requestId);
  const settings = normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { disabledSurfaces: [] } } });
  const bridge = createActionToolExecutorBridge({
    actionsSettings: settings,
    executor: { execute: (id, input, context) =>
      f.execute(f.operation(id, StrictJsonValueSchema.parse(input)), { sessionId,
        ...(context.signal ? { signal: context.signal } : {}), isCurrent: async () => true }) },
  });
  let mints = 0;
  try {
    f.setActionsSettings(settings);
    // Abort an unexpected extra mint so the regression can finish even with lifetime retries.
    const onTypedMint = () => { if (++mints > expectedRequests) controller.abort(); };
    if (conflictFirst) f.failAuthorization(409, () => {
      mints++;
      f.failAuthorization(409, onTypedMint, refusal.payload);
    });
    else f.failAuthorization(409, onTypedMint, refusal.payload);
    const outcome = await bridge.executeActionByToolName('action_execute', { actionId, input: operation.input },
      sessionId, { signal: controller.signal });
    const mintPath = bindExternalActionExecutionAuthorizationHttpPathV1(actionId);
    expect.soft(f.observations.filter(row => row.path === mintPath)).toHaveLength(expectedRequests);
    expect(outcome).toMatchObject({ ok: false, errorCode: 'target_unavailable', requestId: operation.requestId });
  } finally { await f.close(); }
});

it('keeps cancellation distinct when Home authorization becomes unavailable', async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    f.failAuthorization(503, () => controller.abort());
    expect(await f.execute(f.operation('session.archive', { sessionId: childId }), {
      sessionId, signal: controller.signal, isCurrent: async () => true,
    })).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(f.lifecycleEffects).toEqual([]);
  } finally { await f.close(); }
});

it('admits cont6 inherited spawn through MCP, daemon custody and signed Home minting', async () => {
  const f = await fixture();
  const selectedTarget = { kind: 'machine' as const, machineId: storage.state.machineId };
  const envelope = { v: 1 as const, requestId: 'inherited-spawn-binding', target: selectedTarget,
    input: inheritedCodexInput };
  expect(readExternalActionSessionSpawnAdmission(envelope, { serverId: storage.state.homeId, target: selectedTarget }))
    .toMatchObject({ executionTarget: { serverId: storage.state.homeId, machineId: storage.state.machineId } });
  // Binding an omitted destination must never replace an explicit destination:
  // its existing Machine admission still owns whether that target is accessible.
  const explicitTarget = { serverId: storage.state.homeId, machineId: 'other-machine' };
  expect(readExternalActionSessionSpawnAdmission({ ...envelope,
    input: { ...inheritedCodexInput, executionTarget: explicitTarget } },
  { serverId: storage.state.homeId, target: selectedTarget })).toMatchObject({ executionTarget: explicitTarget });
  const command = 'node /runtime/.runner-snapshots/inherited-spawn/dist/index.mjs';
  const runner = { pid: process.pid, processStartTimeMs: 23348,
    processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:inherited-spawn' };
  vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockResolvedValue({ pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command });
  const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
  const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
    path, sessionId, runner, retainedAgent: createAgentSessionRunnerFactoryBinding({
      v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
      sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
      locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js',
    }) };
  await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31002, capability: 'B'.repeat(43) });
  const previousAuthorityPath = process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
  process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE = path;
  const backendTarget = resolveBackendTargetFromSessionMetadata({ flavor: 'codex' });
  if (!backendTarget) throw new Error('Missing native Agent target fixture');
  const startContext = resolveCliAgentStartContextV1({ sessionId, machineId: storage.state.machineId,
    directory: '/tmp', backendTarget,
    metadata: {}, starterDepth: 0, turnDepth: 0, callerPermissionMode: 'default', settings: accountSettingsParse({}),
    appliedChildSelection: { status: 'applied', backendTarget, modelId: inheritedCodexInput.modelSelection.ref.modelId,
      modelSelection: inheritedCodexInput.modelSelection.ref, connectedServices: null },
    roles: resolveRolesSnapshotV1({ defaultEngine: { agentTargetKey: inheritedCodexInput.modelSelection.ref.agentTargetKey,
      modelId: inheritedCodexInput.modelSelection.ref.modelId } }),
  });
  if (!startContext || 'ok' in startContext) throw new Error('Missing real CLI caller facts');
  // Native process creation is the effect boundary. Keep both parsers, caller
  // projection, admission, requester producer and actual Home authorization real.
  const spawn = vi.fn<ActionExecutorDeps['sessionSpawnNew']>(async () => ({
    type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted',
  }));
  const execute = createDaemonSessionAccountActionExecutor({ serverId, serverHttpBaseUrl,
    token: f.credentials.token, machineId: storage.state.machineId,
    prepareExternalActionAuthorization: async ({ operation, sessionActionOrigin }) => {
      const minted = await f.prepareResult(operation, sessionActionOrigin);
      return 'ok' in minted ? projectSessionActionIssuerRefusal(minted, storage.state.machineId)
        : { authorization: minted.authorization, target: { kind: 'machine', machineId: storage.state.machineId } };
    },
    createExecutor: () => {
      const executor = createActionExecutor({ sessionSpawnNew: spawn, observeActionExecution: async () => {},
        actionAutomations: createActionAutomationHttpPortV1({ accountId: storage.account.id, async request(path, init) {
          const response = await f.app.inject({ method: init.method, url: path,
            headers: { authorization: `Bearer ${f.credentials.token}` } });
          expect(response.statusCode).toBe(200);
          return response.json();
        } }),
      } as unknown as ActionExecutorDeps);
      const withCaller = (context: Parameters<typeof executor.execute>[2]) => ({
        ...context, runtimeAccountId: storage.account.id, agentStartContext: startContext,
      });
      return { execute: (actionId, input, context) => executor.execute(actionId, input, withCaller(context)),
        prepare: (actionId, input, context, options) => executor.prepare(actionId, input, withCaller(context), options) };
    },
  });
  stubUndiciFetch(async (_url: unknown, init?: RequestInit) => {
    const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
    expect(request.context).toEqual({ token: 'B'.repeat(43), sessionId });
    if (request.operation.kind === 'agent_start.policy.read') {
      // The runner-hosted MCP reads the requester's Account start policy from the daemon.
      const settings = accountSettingsParse({});
      return Response.json({ ok: true, result: { kind: 'agent_start.policy', policy: { workDepthLimit: settings.workDepthLimit,
        sessionAgentStartAllowListsV1: settings.sessionAgentStartAllowListsV1,
        sessionAgentSpawnPolicyV1: settings.sessionAgentSpawnPolicyV1 } } });
    }
    if (request.operation.kind !== 'action.execute') throw new Error('Expected Action envelope');
    const outcome = await execute(request.operation, { sessionId, isCurrent: async () => true });
    return Response.json({ ok: true, result: { kind: 'action.execution', requestId: request.operation.requestId, outcome } });
  });
  const witness = { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1], callerPermissionMode: 'default',
    causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' },
    agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 } };
  const runtime = createHappierMcpServer({ sessionId,
    getServerBinding: () => ({ serverId, serverUrl: serverHttpBaseUrl }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
    updateMetadata() {}, getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0, getPermissionMode: () => 'default',
    getActiveTurnAdmissionWitness: () => witness, getActiveTurnPermissionWitness: () => witness,
  }, { authorityScope: 'session', actionsSettingsProvider: f.actionsSettingsProvider });
  const client = new Client({ name: 'inherited-spawn', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await runtime.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const response = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
      arguments: { actionId: 'session.spawn_new', input: inheritedCodexInput } }));
    const content = response.content.find(block => block.type === 'text');
    if (content?.type !== 'text') throw new Error('Missing MCP result');
    expect(response.isError, content.text).not.toBe(true);
    expect(JSON.parse(content.text)).toMatchObject({ type: 'pending', outcome: 'accepted' });
    const child = spawn.mock.calls[0]?.[0];
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(SessionSpawnNewInputV2Schema.safeParse({ ...inheritedCodexInput, executionTarget: child?.executionTarget,
      agentTarget: child?.agentTarget, manager: child?.manager }).success).toBe(true);
    expect(child).toMatchObject({ executionTarget: { serverId, machineId: storage.state.machineId },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, manager: { sessionId } });
    expect(f.observations).toContainEqual(expect.objectContaining({
      path: '/v1/actions/session.spawn_new/execution-authorization', status: 200,
    }));
    // createDaemonSessionAccountActionAuthorizationPreparer retains local
    // ingress currentness after Home mint. The native process boundary
    // consumes that finite root without another authority decision.
    expect(f.observations.filter(row => row.path === '/v1/actions/session.spawn_new/execution-authorization/verify')).toEqual([]);
  } finally {
    await client.close(); await runtime.mcp.close();
    await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority, capabilityDigest: hashPrivateBearer('B'.repeat(43)) });
    if (previousAuthorityPath === undefined) delete process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
    else process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE = previousAuthorityPath;
    await f.close();
  }
});

it('reuses admitted Stop custody while Home authorizes each signed observation', async () => {
  const f = await fixture();
  const channel = await createRequesterCurrentnessSocketHarness();
  const installed = { version: 1 as const, installationId: storage.state.installationId, createdAt: 1,
    publicKey: Buffer.from(installation.publicKey).toString('base64url'),
    privateKey: Buffer.from(installation.secretKey).toString('base64url') };
  const localInstallation = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(installed);
  // Home feature delivery and installation storage are system boundaries.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(FeaturesResponseSchema.parse({
    features: {}, capabilities: { serverIdentity: { serverIdentityId: storage.state.homeId } },
  })));
  let prepared: Awaited<ReturnType<typeof prepareInstalledRequesterAccountActionContext>> = null;
  try {
    const op = f.operation('session.stop', { sessionId: childId });
    const original = await f.prepare(op, { v: 1, caller: op.witness.agentStartCaller,
      sourceTurnId: 'turn', callerPermissionMode: null, requestId: op.requestId });
    if (!original) throw new Error('Missing original Stop root');
    const purpose = { kind: 'machine_rpc', method: RPC_METHODS.STOP_SESSION, params: { sessionId: childId } } as const;
    const sealed = sealExternalActionRequesterAccountContextV1({ authorization: original.authorization, purpose,
      credentials: encodeStoredCredentials(f.credentials), installationPublicKey: installation.publicKey, randomBytes: nacl.randomBytes });
    const admissionStart = f.observations.length;
    const prepare = () => prepareInstalledRequesterAccountActionContext({ authorization: sealed, purpose,
      machineId: storage.state.machineId, serverId, serverHttpBaseUrl,
      resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
        serverUrl: serverHttpBaseUrl, resolveCurrentMachineId: () => storage.state.machineId,
      }),
      createExecutor: admitted => createCliActionExecutorFromCredentials({ credentials: admitted.credentials,
        serverId, serverApiUrl: serverHttpBaseUrl, serverIdentityId: storage.state.homeId, machineId: storage.state.machineId,
        pluginActionExecutionOwner: 'current_process', savedSecretOperationContext: admitted.savedSecretOperationContext }),
    });
    prepared = await prepare();
    const custody = readRequesterAccountActionContext(prepared?.authorization);
    const http = prepared?.authorization.requesterHttpProjection;
    if (!prepared || !custody || !http) throw new Error('Missing installed Stop custody');
    const verifyReads = () => f.observations.slice(admissionStart).filter(row => row.path.endsWith('/execution-authorization/verify')).length;
    expect(verifyReads()).toBe(1);
    const query = { v: 1 as const, storage: 'active' as const, includeInactive: true, scope: 'all_accessible' as const,
      attention: 'any' as const, audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, underSessionId: sessionId };
    const headers = await http.createRequestHeaders({ effectActionId: 'session.stop', method: 'POST', path: '/v2/sessions/query', body: query });
    if (!headers) throw new Error('Missing signed subtree request');
    expect((await f.app.inject({ method: 'POST', url: '/v2/sessions/query', headers, payload: query })).statusCode).toBe(200);
    expect(verifyReads()).toBe(1);
    expect(await custody.isCurrent()).toBe(true);
    expect(verifyReads()).toBe(1);
    // Finite work keeps its admitted local custody. Home still authorizes the
    // next signed request and refuses it after the binding is withdrawn.
    storage.state.bound = false;
    expect(await custody.isCurrent()).toBe(true);
    expect(verifyReads()).toBe(1);
    expect((await f.app.inject({ method: 'POST', url: '/v2/sessions/query', headers, payload: query })).statusCode).toBe(401);
    storage.state.bound = true;
    localInstallation.mockReturnValue({ ...installed, installationId: 'replaced' });
    expect(await custody.isCurrent()).toBe(true);
    expect(await http.createRequestHeaders({ effectActionId: 'session.stop', method: 'POST', path: '/v2/sessions/query', body: query })).not.toBeNull();
    expect(await prepare()).toBeNull();
    localInstallation.mockReturnValue(installed);
    const changedCurrentness = createAccountEncryptionCurrentnessFixture({ mode: 'e2ee' });
    f.setAccountEncryptionCurrentness(changedCurrentness);
    await channel.push(storage.account.id, changedCurrentness);
    // A changed encryption mode retires incompatible Account material even
    // for already-admitted work; it cannot be reinterpreted as plaintext.
    expect(await custody.isCurrent()).toBe(false);
    expect(await http.createRequestHeaders({ effectActionId: 'session.stop', method: 'POST', path: '/v2/sessions/query', body: query })).toBeNull();
    expect(await prepare()).toBeNull();
    await prepared.dispose();
    expect(await custody.isCurrent()).toBe(false);
  } finally { await prepared?.dispose(); await channel.close(); await f.close(); }
});

it('stops a led child through the real requester RPC receiver and preserves receiver refusals', async () => {
  const f = await fixture();
  const channel = await createRequesterCurrentnessSocketHarness();
  const effects: string[] = [];
  const receiverResults: unknown[] = [];
  const requesterResults: unknown[] = [];
  const rpc = new RpcHandlerManager({ scopePrefix: storage.state.machineId, localMachineId: storage.state.machineId,
    encryptionMode: 'plain', logger: () => {},
    // Home signature admission is exercised at the transport boundary below.
    authorizeRequest: async () => ({ ok: true }),
    prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ ...request,
      purpose: request.purpose ?? { kind: 'external_action' },
      machineId: storage.state.machineId, installationId: storage.state.installationId,
      installationPrivateKey: installation.secretKey, serverId, serverIdentityId: storage.state.homeId,
      serverHttpBaseUrl, isCurrent: async () => storage.state.bound,
      createExecutor: admitted => {
        const executor = createCliActionExecutorFromCredentials({ credentials: admitted.credentials,
          serverId, serverApiUrl: serverHttpBaseUrl, serverIdentityId: storage.state.homeId, machineId: storage.state.machineId,
          pluginActionExecutionOwner: 'current_process',
          readCredentials: async () => await admitted.isCurrent() ? admitted.credentials : null,
          savedSecretOperationContext: admitted.savedSecretOperationContext,
          actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(admitted.accountSettingsContext.settings.actionsSettingsV1),
            getAccountSettings: () => admitted.accountSettingsContext.settings },
          externalActionMachineRequestPrivateKey: installation.secretKey,
          externalActionMachineInstallationId: storage.state.installationId,
          // Use the installed Machine transport, rather than replacing the
          // Session Stop service. Only physical process delivery is substituted.
          machineActionDirectTargetTransport: { machineId: storage.state.machineId,
            invoke: async (method, request) => {
              expect(method).toBe(RPC_METHODS.STOP_SESSION);
              const receiver = createMachineSessionStopLifecycleActionExecutor({ stopSession: async target => {
                effects.push(target); f.markInactive(); return { status: 'stopped' };
              } });
              const result = await receiver.execute('session.stop', request);
              if (!result.ok) throw new Error(result.errorCode);
              return result.result;
            },
          },
        });
        return { execute: async (id, input, context) => {
          const result = await executor.execute(id, input, context);
          requesterResults.push(result);
          return result;
        } };
      },
    }),
  });
  registerSessionLifecycleRpcHandlers({ rpcHandlerManager: rpc, scopes: MACHINE_SESSION_STOP_RPC_SCOPES,
    actionExecutor: createMachineSessionStopLifecycleActionExecutor({ stopSession: async target => {
      effects.push(target); f.markInactive(); return { status: 'stopped' };
    } }),
  });
  let receiverDisabled = false;
  let receiverMembershipLost = false;
  const transport = vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async request => {
    if (transport.mock.calls.length > 1) throw new Error('Stop recursively redispatched to its receiver');
    const external = request.externalAction;
    if (!external) throw new Error('Missing original stop authority');
    const authorization = external.context.externalActionExecutionAuthorization;
    if (!authorization) throw new Error('Missing original stop root');
    if (!(external.privateKey instanceof Uint8Array)) throw new Error('Expected fixture installation key');
    const method = `${request.machineId}:${request.method}`;
    const execution = { v: 1 as const, authorization, effectActionId: external.effectActionId,
      target: authorization.binding.target, installationId: external.installationId,
      machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
        effectActionId: external.effectActionId, target: authorization.binding.target,
        installationId: external.installationId, method, requestId: 'stop-receiver', params: request.request,
        privateKey: external.privateKey }) };
    expect(await verifyExternalActionMachineRpcExecution(execution, { method, params: request.request,
      requestId: 'stop-receiver', resolveCurrentSessionMachine: async () => storage.state.machineId })).not.toBeNull();
    const root = sealExternalActionRequesterAccountContextV1({ authorization,
      credentials: encodeStoredCredentials(f.credentials), purpose: { kind: 'machine_rpc', method: request.method, params: request.request },
      installationPublicKey: installation.publicKey, randomBytes: nacl.randomBytes });
    if (receiverDisabled) f.setActionsSettings(normalizeActionsSettingsV1({ v: 1,
      actions: { 'session.stop': { disabledSurfaces: ['agent'] } } }));
    if (receiverMembershipLost) f.members.clear();
    const result = await rpc.handleRequest({ method, params: request.request, requestId: 'stop-receiver',
      callerInputAuthorization: root, sessionActionOrigin: authorization.binding.sessionActionOrigin,
      callerAuthority: 'account_automation', machineAdmission: { actorAccountId: storage.account.id,
        custodianAccountId: storage.account.id, machineId: storage.state.machineId,
        installationId: storage.state.installationId, role: 'use', encryptionMode: 'plain' } });
    receiverResults.push(result);
    return result;
  });
  const run = () => f.execute(f.operation('session.stop', { sessionId: childId }), { sessionId, isCurrent: async () => true });
  const enable = () => f.setActionsSettings(normalizeActionsSettingsV1({ v: 1, actions: { 'session.stop': { disabledSurfaces: [] } } }));
  try {
    expect(await run()).toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(effects).toEqual([]);
    enable();
    expect(await run(), JSON.stringify({ receiverResults, requesterResults })).toMatchObject({ ok: true, result: { stopped: true } });
    expect(effects).toEqual([childId]);
    expect(requesterResults).toContainEqual({ ok: true, result: { ok: true, sessionId: childId, stopped: true } });
    receiverDisabled = true;
    transport.mockClear();
    const disabledResult = await run();
    expect(disabledResult, JSON.stringify({ disabledResult, receiverResults, requesterResults, observations: f.observations.slice(-12) }))
      .toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(effects).toEqual([childId]);
    receiverDisabled = false;
    receiverMembershipLost = true;
    enable();
    transport.mockClear();
    expect(await run()).toMatchObject({ ok: false, errorCode: 'unsupported_action', details: { cause: 'target_outside_led_subtree' } });
    expect(effects).toEqual([childId]);
  } finally { await channel.close(); await f.close(); }
});

it.each(['session.stop', 'session.archive', 'session.unarchive'] as const)(
  'admits only fresh led lifecycle targets through MCP and signed Home admission: %s', async actionId => {
  const f = await fixture();
  f.markInactive();
  if (actionId === 'session.unarchive') f.markChildArchived();
  // Defaults stay disabled. Only this isolated in-memory Account fixture opts in.
  expect(await f.execute(f.operation(actionId, { sessionId: childId }), { sessionId, isCurrent: async () => true }))
    .toMatchObject({ ok: false, errorCode: 'action_disabled' });
  f.setActionsSettings(normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { disabledSurfaces: [] } } }));
  const command = 'node /runtime/.runner-snapshots/signed-lifecycle/dist/index.mjs';
  const runner = { pid: process.pid, processStartTimeMs: 23347,
    processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:signed-lifecycle' };
  vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockResolvedValue({ pid: runner.pid, processStartTimeMs: runner.processStartTimeMs, command });
  const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
  const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
    path, sessionId, runner, retainedAgent: createAgentSessionRunnerFactoryBinding({
      v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
      sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
      locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js',
    }) };
  await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31002, capability: 'B'.repeat(43) });
  const previousAuthorityPath = process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
  process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE = path;
  const stop = vi.spyOn(machineRpc, 'callMachineRpc').mockResolvedValue({ status: 'not_found' });
  stubUndiciFetch(async (_url: unknown, init?: RequestInit) => {
    const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
    expect(request.context).toEqual({ token: 'B'.repeat(43), sessionId });
    if (request.operation.kind !== 'action.execute') throw new Error('Expected Action envelope');
    const outcome = await f.execute(request.operation, { sessionId, isCurrent: async () => true });
    return Response.json({ ok: true, result: { kind: 'action.execution', requestId: request.operation.requestId, outcome } });
  });
  const witness = { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1],
    callerPermissionMode: 'default',
    causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' },
    agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 } };
  const runtime = createHappierMcpServer({ sessionId,
    getServerBinding: () => ({ serverId, serverUrl: serverHttpBaseUrl }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
    updateMetadata() {}, getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
    getPermissionMode: () => 'default',
    getActiveTurnAdmissionWitness: () => witness,
    getActiveTurnPermissionWitness: () => witness,
  }, { authorityScope: 'session', actionsSettingsProvider: f.actionsSettingsProvider });
  const client = new Client({ name: 'signed-lifecycle', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const invoke = async (target: string, alsoArchiveReports?: boolean) => {
    const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
      arguments: { actionId, input: { sessionId: target, ...(alsoArchiveReports === undefined ? {} : { alsoArchiveReports }) } } }));
    const content = result.content.find(block => block.type === 'text');
    if (content?.type !== 'text') throw new Error('Missing MCP result');
    return { failed: result.isError === true, value: JSON.parse(content.text) as unknown };
  };
  const effectCount = () => stop.mock.calls.length + f.lifecycleEffects.length;
  try {
    await runtime.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    expect(effectCount()).toBe(0);
    const admissionStart = f.observations.length;
    if (actionId === 'session.archive') {
      f.markSessionActive(sessionId);
      const selfArchive = await invoke(sessionId);
      expect(selfArchive, JSON.stringify({ selfArchive, observations: f.observations.slice(-10) }))
        .toMatchObject({ failed: true, value: { errorCode: 'unsupported_action', error: 'self_stop_forbidden' } });
      expect(effectCount()).toBe(0);
      f.markSessionInactive(sessionId);
      const grandchildId = 'c123456789012345678901232';
      f.addNestedReport(grandchildId);
      f.markSessionActive(grandchildId);
      const stopAdmissions: Array<{ root: string; effect: string; admitted: boolean }> = [];
      stop.mockImplementation(async request => {
        if (request.method !== RPC_METHODS.STOP_SESSION) throw new Error('Unexpected cascade machine request');
        const external = request.externalAction;
        const authorization = external?.context.externalActionExecutionAuthorization;
        if (!external || !authorization || !(external.privateKey instanceof Uint8Array)) throw new Error('Missing cascade Stop root');
        const method = `${request.machineId}:${request.method}`;
        const requestId = 'archive-cascade-stop';
        const execution = { v: 1 as const, authorization, effectActionId: external.effectActionId,
          target: authorization.binding.target, installationId: external.installationId,
          machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
            effectActionId: external.effectActionId, target: authorization.binding.target,
            installationId: external.installationId, method, requestId, params: request.request,
            privateKey: external.privateKey }) };
        const admitted = await verifyExternalActionMachineRpcExecution(execution, { method, params: request.request,
          requestId, resolveCurrentSessionMachine: async () => storage.state.machineId });
        stopAdmissions.push({ root: authorization.binding.actionId, effect: external.effectActionId, admitted: admitted !== null });
        expect(admitted).not.toBeNull();
        f.markSessionInactive(grandchildId);
        return { status: 'stopped' };
      });
      const readEdges = storage.db.sessionFollowEdge.findMany;
      // Extend only the real database boundary: recursive membership stays with
      // the Home's canonical subtree reader, including this second-level edge.
      vi.spyOn(storage.db.sessionFollowEdge, 'findMany').mockImplementation(async query => {
        const existing = await readEdges(query);
        return query.where.relation === 'manager' && query.where.destinationSessionId.in.includes(childId)
          ? [...existing, { sourceSessionId: grandchildId }] : existing;
      });
      const cascade = await invoke(sessionId, true);
      expect(cascade, JSON.stringify(cascade)).toMatchObject({ failed: false, value: { success: true, sessionId,
        reports: [{ sessionId: childId, status: 'archived' }] } });
      expect(getActionSpec('session.archive').outputSchema.parse(cascade.value)).toEqual(cascade.value);
      expect(f.lifecycleEffects).not.toContain(`/v2/sessions/${grandchildId}/archive`);
      const nestedCascade = await invoke(childId, true);
      expect(nestedCascade, JSON.stringify({ nestedCascade, observations: f.observations.slice(-12), stopAdmissions })).toMatchObject({ failed: false, value: { success: true, sessionId: childId,
        reports: [{ sessionId: grandchildId, status: 'archived' }] } });
      expect(getActionSpec('session.archive').outputSchema.parse(nestedCascade.value)).toEqual(nestedCascade.value);
      expect(stopAdmissions).toEqual([{ root: 'session.archive', effect: 'session.stop', admitted: true }]);
      expect(f.lifecycleEffects).toContain(`/v2/sessions/${grandchildId}/archive`);
    }
    for (const target of actionId === 'session.stop' ? [childId] : [sessionId, childId]) {
      const result = await invoke(target);
      expect(result.failed, JSON.stringify({ result, observations: f.observations.slice(-8) })).toBe(false);
      expect(result.value).toMatchObject(actionId === 'session.stop'
        ? { ok: true, sessionId: target, stopOutcome: { status: 'already_stopped' } }
        : actionId === 'session.archive' ? { success: true, sessionId: target, archivedAt: 123 }
        : { ok: true, sessionId: target, archivedAt: null });
    }
    // Lifecycle scope needs fresh caller/subtree facts, not Role authoring or
    // Agent launch catalogs. Each catalog read fans out through requester custody.
    expect(f.observations.slice(admissionStart).filter(row =>
      row.path === '/v1/artifacts' || row.path === '/v1/account/entity-rows/acp'
      || row.path === '/v1/account/entity-rows/prompt-library')).toEqual([]);
    const signed = f.observations.filter(row => row.signed);
    expect(signed.some(row => row.path === '/v2/sessions/read-batch')).toBe(true);
    expect(signed.every(row => !row.bearer && (row.status === 200
      || actionId === 'session.archive' && row.path.endsWith('/archive') && row.status === 409)), JSON.stringify(signed)).toBe(true);
    const targetReads = f.observations.filter(row => row.path === `/v2/sessions/${childId}`
      || row.path === '/v2/sessions/read-batch' && row.sessionIds?.includes(childId));
    expect(targetReads.length).toBeGreaterThan(0);
    expect(targetReads.every(row => row.signed && !row.bearer)).toBe(true);
    if (actionId === 'session.stop') {
      expect(stop).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.STOP_SESSION,
        request: { sessionId: childId }, externalAction: expect.objectContaining({ effectActionId: actionId }) }));
    } else {
      expect(f.observations).toContainEqual(expect.objectContaining({ path: `/v2/sessions/${childId}/${actionId === 'session.archive' ? 'archive' : 'unarchive'}`,
        status: 200, signed: true, bearer: false }));
    }
    const effects = effectCount();
    f.members.clear();
    expect(await invoke(childId)).toMatchObject({ failed: true, value: { errorCode: 'unsupported_action', details: { cause: 'target_outside_led_subtree' } } });
    expect(await invoke('c123456789012345678901239')).toMatchObject({ failed: true, value: { errorCode: 'unsupported_action' } });
    expect(effectCount()).toBe(effects);
    f.members.add(childId);
    f.setActionsSettings(normalizeActionsSettingsV1({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['agent'] } } }));
    expect(await invoke(childId)).toMatchObject({ failed: true });
    expect(effectCount()).toBe(effects);
    f.setActionsSettings(normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { disabledSurfaces: [] } } }));
    storage.state.bound = false;
    expect(await invoke(childId)).toMatchObject({ failed: true });
    expect(effectCount()).toBe(effects);
  } finally {
    await client.close();
    await runtime.mcp.close();
    await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority, capabilityDigest: hashPrivateBearer('B'.repeat(43)) });
    if (previousAuthorityPath === undefined) delete process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
    else process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE = previousAuthorityPath;
    await f.close();
  }
});

it.each(['active', 'archived'] as const)(
  'retains the native status Action through a transient %s subtree read inside its admitted lifetime', async storage => {
  const f = await fixture();
  const controller = new AbortController();
  if (storage === 'archived') f.markChildArchived();
  f.failNextSubtree(503);
  try {
    const run = () => f.execute(f.operation('session.status.get', { sessionId: childId }),
      { sessionId, isCurrent: async () => true, signal: controller.signal });
    expect(await run()).toMatchObject({ ok: true, result: { session: { id: childId } } });
    const queries = f.observations.filter(row => row.path === '/v2/sessions/read-batch');
    expect(queries.some(row => row.status === 503)).toBe(true);
    expect(queries.some(row => row.status === 200)).toBe(true);
    expect(queries.every(row => row.signed && !row.bearer)).toBe(true);
    // Recovery observes membership again; an earlier successful read is not a grant.
    f.members.clear();
    expect(await run()).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'target_outside_led_subtree' } });
  } finally { controller.abort(); await f.close(); }
});

it('keeps definitive subtree denial terminal and honours cancellation during observation', async () => {
  const controller = new AbortController();
  const f = await fixture(1, async () => { if (cancelRead) controller.abort(); });
  let cancelRead = false;
  const run = () => f.execute(f.operation('session.status.get', { sessionId: childId }),
    { sessionId, isCurrent: async () => true, signal: controller.signal });
  try {
    f.failNextSubtree(403);
    expect(await run()).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'subtree_observation_unavailable' } });
    const denied = f.observations.filter(row => row.path === '/v2/sessions/read-batch');
    expect(denied).toHaveLength(1);
    expect(denied.some(row => row.status === 403)).toBe(true);
    cancelRead = true;
    f.failNextSubtree(503);
    expect(await run()).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(f.lifecycleEffects).toEqual([]);
  } finally { controller.abort(); await f.close(); }
});

it.each([false, true])('resolves one lifecycle caller snapshot per Action while reobserving led membership (direct=%s)', async direct => {
  const f = await fixture(1, undefined, direct);
  f.markInactive();
  f.setActionsSettings(normalizeActionsSettingsV1({ v: 1,
    actions: { 'session.archive': { disabledSurfaces: [] } } }));
  const diagnostics = vi.spyOn(logger, 'debugLocalFile');
  const callerPhases = () => diagnostics.mock.calls.flatMap(([label, data]) => label === '[external-action-stage]'
    && data && typeof data === 'object' && 'phase' in data && data.phase === 'caller_session' && 'elapsedMs' in data
    ? [data.elapsedMs] : []);
  const run = () => f.execute({ ...f.operation('session.archive', { sessionId: childId }),
    requestId: '11600000-0000-4000-8000-000000000001' }, { sessionId, isCurrent: async () => true });
  try {
    expect(await run()).toMatchObject({ ok: true });
    console.info('DF116 caller snapshot elapsedMs', { direct, phases: callerPhases() });
    expect(callerPhases()).toHaveLength(1);
    expect(f.observations.filter(row => row.path === '/v2/sessions/read-batch')).toHaveLength(1);
    f.members.clear();
    expect(await run()).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'target_outside_led_subtree' } });
    expect(f.lifecycleEffects).toHaveLength(1);
    f.members.add(childId);
    f.omitCallerWorkspace();
    expect(await run()).toMatchObject({ ok: false, details: { cause: 'caller_context_unavailable' } });
    expect(f.lifecycleEffects).toHaveLength(1);
  } finally { await f.close(); }
});

it.each(['session.stop', 'session.archive', 'session.unarchive'] as const)(
  'reports unavailable lifecycle scope as retryable without authorizing an effect: %s', async actionId => {
  const f = await fixture();
  const stop = vi.spyOn(machineRpc, 'callMachineRpc').mockResolvedValue({ status: 'not_found' });
  f.markInactive();
  f.setActionsSettings(normalizeActionsSettingsV1({ v: 1, actions: { [actionId]: { disabledSurfaces: [] } } }));
  f.refuseSubtree(503);
  try {
    const failure = ActionExecuteFailureSchema.parse(await f.execute(f.operation(actionId, { sessionId: childId }),
      { sessionId, isCurrent: async () => true }));
    expect(ActionCurrentSessionScopeFailureDetailsV1Schema.parse(failure.details))
      .toEqual({ cause: 'subtree_observation_unavailable', retryable: true });
    expect(failure)
      .toMatchObject({ ok: false, errorCode: 'target_unavailable',
        details: { cause: 'subtree_observation_unavailable', retryable: true } });
    expect(stop).not.toHaveBeenCalled();
    expect(f.lifecycleEffects).toEqual([]);
    f.allowSubtree();
    expect(await f.execute(f.operation(actionId, { sessionId: childId }), { sessionId, isCurrent: async () => true }))
      .toMatchObject({ ok: true });
  } finally { await f.close(); }
});

it('overlaps active and archived Home scope reads for a workers selector before unarchive', async () => {
  let inFlight = 0;
  let maximumInFlight = 0;
  const f = await fixture(1, async () => {
    maximumInFlight = Math.max(maximumInFlight, ++inFlight);
    await new Promise(resolve => setTimeout(resolve, 20));
    inFlight--;
  });
  f.markInactive();
  f.markChildArchived();
  f.setActionsSettings(normalizeActionsSettingsV1({ v: 1,
    actions: { 'session.unarchive': { disabledSurfaces: [] } } }));
  try {
    const result = await f.execute(f.operation('session.unarchive', { sessionId: { selector: 'workers' } }),
      { sessionId, isCurrent: async () => true });
    expect(result, JSON.stringify({ result, observations: f.observations })).toMatchObject({ ok: true });
    expect(maximumInFlight).toBe(2);
    expect(inFlight).toBe(0);
    const queries = f.observations.filter(row => row.path === '/v2/sessions/query');
    expect(queries).toHaveLength(2);
    expect(queries.every(row => row.status === 200 && row.signed && !row.bearer)).toBe(true);
    expect(f.lifecycleEffects).toEqual([`/v2/sessions/${childId}/unarchive`]);
  } finally { await f.close(); }
});

it.each([
  { actionId: 'session.status.get', metadataLayout: 0 },
  { actionId: 'session.messages.recent.get', metadataLayout: 0 },
  { actionId: 'session.status.get', metadataLayout: 1 },
  { actionId: 'session.messages.recent.get', metadataLayout: 1 },
] as const)(
  'admits fresh subtree observation through real caller resolution: $actionId, layout $metadataLayout', async ({ actionId, metadataLayout }) => {
  const f = await fixture(metadataLayout);
  try {
    const run = () => f.execute(f.operation(actionId, { sessionId: childId }), { sessionId, isCurrent: async () => true });
    const result = await run();
    expect(result, JSON.stringify({ result, observations: f.observations })).toMatchObject(actionId === 'session.status.get'
      ? { ok: true, result: { session: { id: childId } } }
      : { ok: true, result: { sessionId: childId, items: [{ text: 'Child ready' }] } });
    const queries = f.observations.filter(row => row.path === '/v2/sessions/read-batch');
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every(row => row.status === 200 && row.signed && !row.bearer)).toBe(true);
    const diagnostics = vi.spyOn(logger, 'warnLocalFile');
    f.members.clear();
    expect(await run()).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'target_outside_led_subtree' } });
    f.refuseSubtree();
    expect(await run()).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'subtree_observation_unavailable' } });
    f.omitCallerWorkspace();
    expect(await run()).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'caller_context_unavailable' } });
    expect(diagnostics).toHaveBeenCalledWith('[Session Account Action] Refused', expect.objectContaining({
      errorCode: 'unsupported_action', scopeFailureCause: 'caller_context_unavailable',
      refusalPhase: 'agent_start_context', refusalReason: 'caller_workspace_unavailable',
    }));
    expect(diagnostics).toHaveBeenCalledWith('[Session Account Action] Refused', expect.objectContaining({
      errorCode: 'unsupported_action', scopeFailureCause: 'subtree_observation_unavailable',
    }));
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('private-error-body');
  } finally { await f.close(); }
});

it('admits child reads from the native factory witness through real caller resolution', async () => {
  const f = await fixture();
  const agentId = 'native-reader';
  const contributions = createExternalContributionFixtures(agentId);
  const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
  let permissionMode: 'default' | 'read-only' | undefined = 'default';
  let sequence = 0;
  // The vendor runtime is the external boundary. Native host witness ownership,
  // daemon execution, caller reconstruction and signed Home reads remain real.
  const native: AgentSessionRuntime = {
    send: async request => {
      for (const listener of listeners) {
        listener({ kind: 'input-accepted', sessionId, sequence: ++sequence, emittedAtMs: 1,
          inputIds: request.inputIds, delivery: request.delivery });
        listener({ kind: 'turn-start', sessionId, sequence: ++sequence, emittedAtMs: 2,
          turnId: request.delivery.turnId, startedBy: 'host' });
      }
      return { status: 'admitted' };
    },
    watch: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    dispose() {},
  };
  const plan = await createNativeAgentRuntimeSessionPlanFixture({
    runtime: { sessions: { open: async () => native } },
    lease: createLease(agentId), backend: contributions.backend, agent: contributions.agent,
    createSessionHostServiceOwners,
    sessionInput: buildPluginSessionBindingInput({ credentials: f.credentials, directory: '/workspace' }),
  });
  // Canonical factory testkit supplies the process/transport shell for this host.
  const created = await plan.config.createSessionRuntime({ directory: '/workspace', metadata: {},
    machineId: storage.state.machineId, session: createNativeSessionClientTestPort(sessionId),
    transcriptSession: {}, messageBuffer: {}, mcpServers: {}, permissionHandler: {},
    getPermissionMode: () => permissionMode, setThinking() {}, memoryRecallGuidanceEnabled: false,
  } as never);
  const unsubscribe = created.operations.subscribeRuntimeEvents(() => undefined);
  try {
    await created.operations.sendTurnPrompt('Read own child', { turnId: 'native-read-turn', localId: 'native-read-input',
      userMessageSeq: 1, userMessageSeqs: [1], agentStartCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' } });
    const invoke = async (actionId: 'session.status.get' | 'session.messages.recent.get') => {
      const witness = created.operations.readActiveTurnAdmissionWitness?.();
      if (!witness) throw new Error('Missing active native host witness');
      return await f.execute({ ...f.operation(actionId, { sessionId: childId }),
        witness: projectAgentRuntimeDaemonServiceTurnWitnessV1(witness) }, { sessionId, isCurrent: async () => true });
    };
    const status = await invoke('session.status.get');
    expect(status, JSON.stringify(status)).toMatchObject({ ok: true, result: { session: { id: childId } } });
    permissionMode = 'read-only';
    expect(await invoke('session.messages.recent.get')).toMatchObject({ ok: true,
      result: { sessionId: childId, items: [{ text: 'Child ready' }] } });
    const queries = f.observations.filter(row => row.path === '/v2/sessions/read-batch');
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every(row => row.status === 200 && row.signed && !row.bearer)).toBe(true);
    f.members.clear();
    expect(await invoke('session.status.get')).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'target_outside_led_subtree' } });
    f.members.add(childId);
    permissionMode = undefined;
    expect(await invoke('session.status.get')).toMatchObject({ ok: false, errorCode: 'unsupported_action',
      details: { cause: 'caller_context_unavailable' } });
  } finally {
    unsubscribe?.();
    await created.operations.resetOrDisposeRuntime();
    await f.close();
  }
});

it.each(['session.status.get', 'session.messages.recent.get', 'session.stop', 'session.archive', 'session.unarchive'] as const)(
  'signs the policy subtree read as %s at the production list owner', async actionId => {
  const f = await fixture();
  try {
    const op = f.operation(actionId, { sessionId: childId });
    const prepared = await f.prepare(op, { v: 1, caller: op.witness.agentStartCaller,
      sourceTurnId: 'turn', callerPermissionMode: null, requestId: op.requestId });
    if (!prepared) throw new Error('Missing original root');
    const { sessionList: list } = createSessionListActionDeps({ credentials: f.credentials, serverId,
      serverIdentityId: storage.state.homeId, serverHttpBaseUrl,
      resolveAccountSettings: () => accountSettingsParse({}),
      externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: storage.state.installationId });
    const query = SessionListQueryV1Schema.parse({ v: 1, storage: 'active', includeInactive: true,
      scope: 'all_accessible', attention: 'any', audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, underSessionId: sessionId });
    const context = { surface: 'agent' as const, defaultSessionId: sessionId, serverId,
      externalActionExecutionAuthorization: prepared.authorization, externalActionTarget: prepared.target };
    const result = parseSessionListQueryActionResultV1(await list({ context, query }));
    expect(result, JSON.stringify(f.observations)).toMatchObject({ sessions: [{ id: childId }], hasNext: false });
    const signed = f.observations.filter(row => row.signed);
    expect(signed.length).toBeGreaterThan(0);
    expect(signed.every(row => row.status === 200 && !row.bearer)).toBe(true);
    for (const path of [`/v2/sessions/${childId}`,
      ...(actionId === 'session.messages.recent.get' ? [`/v1/sessions/${childId}/messages`] : [])]) {
      const authorization = resolveExternalActionServerRequestHeaders({ context, effectActionId: actionId, method: 'GET', path,
        daemonToken: f.credentials.token, serverIdentityId: storage.state.homeId,
        privateKey: installation.secretKey, installationId: storage.state.installationId });
      if (!authorization.ok) throw new Error('Missing reader signature');
      const response = await f.app.inject({ method: 'GET', url: path, headers: authorization.headers });
      expect(response.statusCode, JSON.stringify(f.observations)).toBe(200);
    }
    if (actionId === 'session.stop' || actionId === 'session.archive' || actionId === 'session.unarchive') {
      // Native Machine RPC must read its exact content codec before it can emit
      // the lifecycle effect. Use the production Machine HTTP signature producer;
      // the MCP lifecycle test substitutes that process/transport boundary.
      const readMachine = (machineId: string) => {
        const path = `/v1/machines/${encodeURIComponent(machineId)}`;
        const headers = createExternalActionAuthorizedRequestHeaders({ authorization: prepared.authorization,
          effectActionId: actionId, target: prepared.target, installationId: storage.state.installationId,
          method: 'GET', path, privateKey: installation.secretKey });
        return f.app.inject({ method: 'GET', url: path, headers });
      };
      expect((await readMachine(storage.state.machineId)).statusCode, JSON.stringify(f.observations)).toBe(200);
      expect((await readMachine('another-machine')).statusCode).toBe(401);
      storage.state.bound = false;
      expect((await readMachine(storage.state.machineId)).statusCode).toBe(401);
      storage.state.bound = true;
      const path = `/v2/sessions/${childId}/${actionId === 'session.archive' ? 'unarchive' : 'archive'}`;
      const body = {};
      const headers = resolveExternalActionServerRequestHeaders({ context, effectActionId: actionId,
        method: 'POST', path, body, daemonToken: f.credentials.token, serverIdentityId: storage.state.homeId,
        privateKey: installation.secretKey, installationId: storage.state.installationId });
      if (!headers.ok) throw new Error('Missing lifecycle signature');
      expect((await f.app.inject({ method: 'POST', url: path, payload: body, headers: headers.headers })).statusCode).toBe(401);
    }
    if (actionId === 'session.stop' || actionId === 'session.archive') {
      const method = `${storage.state.machineId}:${RPC_METHODS.STOP_SESSION}`;
      const params = { sessionId: childId };
      const execution = { v: 1 as const, authorization: prepared.authorization, effectActionId: 'session.stop',
        target: prepared.target, installationId: storage.state.installationId,
        machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: prepared.authorization.token,
          effectActionId: 'session.stop', target: prepared.target, installationId: storage.state.installationId,
          method, requestId: op.requestId, params, privateKey: installation.secretKey }) };
      expect(await verifyExternalActionMachineRpcExecution(execution, { method, params, requestId: op.requestId,
        resolveCurrentSessionMachine: async () => storage.state.bound ? storage.state.machineId : null })).not.toBeNull();
      expect(await verifyExternalActionMachineRpcExecution(execution, { method,
        params: { sessionId: sessionId }, requestId: op.requestId,
        resolveCurrentSessionMachine: async () => storage.state.machineId })).toBeNull();
    }
    const signedQuery = async (body: unknown, effectActionId = op.actionId) => {
      const authorization = resolveExternalActionServerRequestHeaders({ context,
        effectActionId, method: 'POST', path: '/v2/sessions/query', body, daemonToken: f.credentials.token,
        serverIdentityId: storage.state.homeId, privateKey: installation.secretKey, installationId: storage.state.installationId });
      if (!authorization.ok) throw new Error('Missing query signature');
      return f.app.inject({ method: 'POST', url: '/v2/sessions/query', payload: body, headers: authorization.headers });
    };
    const { underSessionId: _root, ...unscopedQuery } = query;
    // Installed lifecycle roots observe their caller's proved subtree. Other
    // declared Session operands retain their own selector preparation purpose.
    expect((await signedQuery(unscopedQuery)).statusCode).toBe(isLedSubtreeSessionLifecycleActionId(actionId) ? 401 : 200);
    if (actionId === 'session.status.get') {
      expect((await signedQuery({ ...query, underSessionId: childId })).statusCode).toBe(200);
    }
    if (isLedSubtreeSessionLifecycleActionId(actionId)) {
      // The unchanged lifecycle root may observe a still-led nested cascade.
      expect((await signedQuery({ ...query, underSessionId: childId })).statusCode).toBe(200);
      if (actionId === 'session.archive') {
        // The named Stop phase is admitted only by the narrower subtree purpose.
        expect((await signedQuery({ ...query, underSessionId: childId }, 'session.stop')).statusCode).toBe(200);
        f.members.delete(childId);
        expect((await signedQuery({ ...query, underSessionId: childId }, 'session.stop')).statusCode).toBe(401);
        f.members.add(childId);
      }
    }
    // A different effect Action never borrows the root's preparation admission.
    const refused = await signedQuery(query, 'session.list');
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({ error: 'invalid_token' });
    storage.state.bound = false;
    expect((await signedQuery(query)).statusCode).toBe(401);
  } finally { await f.close(); }
});

it.each(['session.spawn_new', 'follow.set', 'session.manager.set'] as const)(
  'uses the original %s root for post-commit source/destination transport reads', async actionId => {
  const f = await fixture();
  try {
    const sourceSessionId = actionId === 'session.manager.set' ? sessionId : childId;
    const destinationSessionId = actionId === 'session.manager.set' ? childId : sessionId;
    const operation = f.operation(actionId, actionId === 'session.spawn_new'
      ? { creationKey: 'signed-source-key-child', executionTarget: { serverId, machineId: storage.state.machineId },
        directory: { kind: 'path', path: '/workspace' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        manager: { sessionId } }
      : actionId === 'follow.set' ? { receiver: { kind: 'session', sessionId: destinationSessionId },
        source: { kind: 'session', sessionId: sourceSessionId }, policy: { preset: 'important' } }
        : { sessionId: sourceSessionId, leadSessionId: destinationSessionId, expectedLeadSessionId: null });
    const prepared = await f.prepare(operation, { v: 1, caller: operation.witness.agentStartCaller,
      sourceTurnId: 'turn', callerPermissionMode: null, requestId: operation.requestId });
    expect(prepared, JSON.stringify(f.observations)).not.toBeNull();
    if (!prepared) throw new Error('Missing Home root');
    const context = { surface: 'agent' as const, defaultSessionId: sessionId, serverId,
      externalActionExecutionAuthorization: prepared.authorization, externalActionTarget: prepared.target };
    const preparation = createSessionFollowSourceKeyPreparationAfterSet({ credentials: f.credentials,
      effectActionId: actionId, serverHttpBaseUrl, serverIdentityId: storage.state.homeId,
      externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: storage.state.installationId });
    expect(await preparation({ sourceSessionId, destinationSessionId, context }), JSON.stringify(f.observations))
      .toEqual({ kind: 'not_needed' });
    const diagnostics = vi.spyOn(logger, 'warnLocalFile');
    f.refuseCurrentness();
    expect(await preparation({ sourceSessionId, destinationSessionId, context }))
      .toEqual({ kind: 'waiting', reason: 'runner_unreachable', cause: 'source_transport_exception' });
    expect(diagnostics).toHaveBeenCalledWith('[Session Follow source-key preparation] Transport refused', {
      cause: 'source_transport_exception', httpStatus: 401, errorCode: 'not_authenticated',
    });
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('private-error-body');
    // The root cannot be spent on unrelated Account operations or Session writes.
    for (const request of [{ method: 'GET', path: '/v2/account/settings' },
      { method: 'POST', path: `/v2/sessions/${sessionId}/archive` }]) {
      const headers = resolveExternalActionServerRequestHeaders({ context, effectActionId: actionId, ...request,
        daemonToken: f.credentials.token, serverIdentityId: storage.state.homeId,
        privateKey: installation.secretKey, installationId: storage.state.installationId });
      if (!headers.ok) throw new Error('Missing signed headers');
      const response = await f.app.inject({ method: request.method as 'GET' | 'POST', url: request.path, headers: headers.headers });
      expect(response.statusCode).toBe(401);
    }
  } finally { await f.close(); }
});

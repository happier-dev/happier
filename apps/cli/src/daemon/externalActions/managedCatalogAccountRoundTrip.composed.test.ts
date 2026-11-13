import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import '../../../../ui/sources/dev/vitestSetup';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import { PLUGIN_MANIFEST as MACHINE_RECIPES_MANIFEST } from '../../../../../packages/plugins/machine-recipes/src/manifest';
import { Server } from 'socket.io';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AccountSettingsSchema, FeaturesResponseSchema, AUTHORITY_CEILING_HEADER_V1, PluginManifestV2Schema } from '@happier-dev/protocol';
import { ApprovalQueueListResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { ApprovalExecutionV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { MachineProvisionersListResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { MachinePresetActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { MachineSetupApplyInputV1Schema, MachineSetupCombinedPlanInputV1Schema, MachineSetupCombinedPlanResultV1Schema, MachineSetupPlanResultV1Schema,
  machineSetupApplyTargetFromPlanV1, ManagedAdmissionOutputV1Schema, ManagedAcceptedV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityActionOutputSchemasV1 } from '@happier-dev/protocol/plugins/availability/actions';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { wrapApiTokenEncryptionAccessV1 } from '@happier-dev/protocol/crypto/apiTokenEncryptionAccess';
import { formatAccountApiTokenCredentialV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { connect } from '@happier-dev/sdk';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { createExternalActionDaemonDispatchResponse, ExternalActionRequestEnvelopeSchema, normalizeActionsSettingsV1,
  sealExternalActionRequestV2, openExternalActionRequestV2, openExternalActionResponseV2, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions';
import { openExternalActionRequesterAccountContextV1, openManagedControllerActionCodecV1,
  isReviewedMachineSetupCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '@happier-dev/protocol/bots/templates/botTemplateActionIdsV1';
import { EXTERNAL_ACTION_REVIEWED_CHILD_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { readHostReviewedChildrenPlanV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleApproval';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { logger } from '@/ui/logger';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { reportSessionToDaemonIfRunning } from '@/agent/runtime/startupSideEffects';
import { createOnHappySessionWebhook } from '../sessions/onHappySessionWebhook';
import { buildCommittedLaunchMetadata, createSessionMetadata, captureSessionLaunchControlMetadata } from '@/agent/runtime/createSessionMetadata';
import { getOrCreateSessionByTag } from '@/session/transport/http/sessionsHttp';
import type { DirectSpawnedSessionTransport } from '@/session/services/createSpawnedSession';
import { prepareSessionCreationTarget } from '@/session/creation/prepareSessionCreationTarget';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, loadManagedProvisionerCatalogForTests } from '../../../../ui/sources/dev/testkit/harness/homeGovernanceHarness';
import { createRootLayoutFeaturesResponse } from '../../../../ui/sources/dev/testkit/fixtures/featureFixtures';
import { settingsDefaults } from '../../../../ui/sources/sync/domains/settings/settings';
import type { FetchedMachineRow } from '../../../../ui/sources/sync/engine/machines/syncMachines';
import { createLightSqliteHarness, createAccountTokenForTests, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { enableAuthentication } from '../../../../server/sources/app/api/utils/enableAuthentication';
import { enableErrorHandlers } from '../../../../server/sources/app/api/utils/enableErrorHandlers';
import { registerAccountEncryptionRoutes } from '../../../../server/sources/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerAccountSettingsRoutes } from '../../../../server/sources/app/api/routes/account/registerAccountSettingsRoutes';
import { registerConnectedAccountConfigurationRowsRoutes } from '../../../../server/sources/app/account/connectedAccounts/registerConfigurationRowsRoutes';
import { registerApiTokenIntrospectionRoute } from '../../../../server/sources/app/api/routes/auth/registerApiTokenIntrospectionRoute';
import { registerAccountApiTokenManagementRoutes } from '../../../../server/sources/app/api/routes/auth/registerAccountApiTokenManagementRoutes';
import { registerPromptLibraryRoutes } from '../../../../server/sources/app/account/prompts/registerPromptLibraryRoutes';
import { registerProjectAccountRowRoutes } from '../../../../server/sources/app/api/routes/projects/registerProjectAccountRowRoutes';
import { registerAccountProfileRoute } from '../../../../server/sources/app/api/routes/account/registerAccountProfileRoute';
import { registerExternalActionRoutes } from '../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes';
import { machinesRoutes } from '../../../../server/sources/app/api/routes/machines/machinesRoutes';
import { artifactsRoutes } from '../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import { admitManagedAcquire } from '../../../../server/sources/app/machines/managed/managedAcquire';
import { registerPluginAvailabilityRoutes } from '../../../../server/sources/app/plugins/availability/routes';
import { createReleaseLessDeclarationV1 } from '../../../../server/sources/app/plugins/availability/currentDeclaration';
import { createExternalActionDaemonDispatcher } from '../../../../server/sources/app/api/socket/externalActionDispatcher';
import { db } from '../../../../server/sources/storage/db';
import { registerWorkflowRunStorageRoutes } from '../../../../server/sources/app/api/routes/automations/registerWorkflowRunStorageRoutes';
import { registerAutomationV3Routes } from '../../../../server/sources/app/api/routes/automations/registerAutomationV3Routes';
import { AutomationV3WorkerClaimResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { startAutomationWorker } from '@/daemon/automation/automationWorker';
import { getOrCreateServerIdentityId } from '../../../../server/sources/app/serverIdentity/serverIdentity';
import { prepareRequesterAccountActionContext } from "../sessionEncryption/requesterAccountActionProjection";
import { readRequesterAccountActionContext, type RequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { executeExternalAction } from './executeExternalAction';
import { registerMachineAccessLossReceiver } from './registerMachineAccessLossReceiver';
import { MACHINE_ACCESS_LOSS_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import { createDaemonExternalActionTargetResolver, createDaemonApprovalExecutionOriginCurrentness } from './daemonExternalActionTargetResolver';
import { fetchAccountProfile } from '@/api/accountProfile';
import { prepareAccountSettingsV2Content } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createDaemonManagedMachineActionAdapter } from '../startup/managedMachineActionAdapter';
import { fixture as nativeFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createManagedProviderOperationAuthority } from '../connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { mintExternalActionExecutionAuthorization, verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { updateSettings, type StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { admitDaemonForegroundAgentRuntime } from '@/daemon/controlClient';
import { claimDaemonForegroundAgentRuntimeEnvironment } from '@/agent/runtime/session/process/foregroundAgentRuntimeAdmissionClient';
import { HAPPIER_FOREGROUND_AGENT_RUNTIME_ADMISSION_FILE_ENV_KEY } from '@/agent/runtime/session/process/agentRuntimeRunnerEnvironment';
import { installForegroundAgentCliFixture } from '@/daemon/agentRuntime/foregroundAdmission.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAuthoredAdmittedPluginRuntimeFixture, retireAdmittedPluginRuntimeRegistry } from '@/plugins/testkit/admittedRuntime';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createMachineRecipeReadAction } from '@/machines/setup/machineRecipeActionDeps';
import { createMachineServicesRuntime } from '../local/services/launch/machineServices';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createHostActionOperationRuntime } from '../actionOperations/createHostActionOperationRuntime';
import { registerDaemonContributionRegistryProjectionHandler } from '@/rpc/handlers/daemonContributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DAEMON_PLUGIN_UI_RESOURCE_WATCH_MIN_WAIT_MS } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { MachineServicesDetailResultV1Schema, type MachineMetadataFieldReadV1 } from '@happier-dev/protocol';
import { createBrowserSidecarCdpControlAdapter, type BrowserSidecarCdpControlTransport } from '../browser/sidecar/controlAdapter';
import { createBrowserAutomationDaemonService } from '../browser/automation/service';
import { createBrowserAutomationCdpAdapter } from '../browser/automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../browser/automation/adapters/controlBridge';
import { createBrowserDaemonControlBroker } from '../browser/control/broker';
import { createBrowserDaemonControlRoutes } from '../browser/control/routes';
import { createBrowserDaemonRuntimeActionExecutor } from '../browser/actions/runtimeActionExecutor';
import { createBrowserDaemonFeatureGate } from '../browser/featureGate';
import { browserControlActionId } from '../../../../ui/sources/sync/domains/browser/actions/controlActionId';
import type { BrowserCommandV1 } from '@happier-dev/protocol/browser/control/v1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import axios from 'axios';
import { createNativeSoftwareInstallFixture } from '@/testkit/machines/nativeSoftwareInstall';
import { createFakeSocket, getSocketHandler } from '../../../../server/sources/app/api/testkit/socketHarness';
import { machineUpdateHandler } from '../../../../server/sources/app/api/socket/machineUpdateHandler';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from '../../../../server/sources/app/api/socket/machineSocketInstallationProof';
import { resolveExternalSessionOperationSocketBatchLimitsForMaxHttpBufferSize } from '../../../../server/sources/app/api/socket';
import { qualifyCurrentAccountStoredContentSocket } from '../../../../server/sources/app/api/testkit/accountStoredContentCompatibility';
import { SessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { readSessionInputRequest, readSessionInputAuthority, readSessionMessageProvenance } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { ApiClient } from '@/api/api';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionOwnerMetadata, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { BotTemplateReleaseV1Schema, projectBotTemplateArtifactHeaderV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { BotTemplateInstantiateInputV1Schema, BotTemplateUpdateDiffResultV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { BotTemplateUpdateApplyInputV1Schema } from '@happier-dev/protocol/bots/templates/templateUpdateActionsV1';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { sessionRoutes } from '../../../../server/sources/app/api/routes/session/sessionRoutes';
import { sessionPendingRoutes } from '../../../../server/sources/app/api/routes/session/pendingRoutes';
import { accessKeysRoutes } from '../../../../server/sources/app/api/routes/accessKeys/accessKeysRoutes';
import { registerAuthPingRoute } from '../../../../server/sources/app/api/routes/auth/registerAuthPingRoute';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { MCP_REQUESTER_SDK_FIXTURE_KEY, startMcpRequesterParent } from '@/agent/runtime/session/loop/runHostSessionRuntime.mcpRequester.testkit';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { WORKFLOW_RUN_STORAGE_HTTP_PATH } from '@/daemon/workflows/workflowRunStorageClient';
import { prepareWorkflowRunStartV1, WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows';
import { projectAcceptedWorkflowRunTarget } from '../../../../ui/sources/components/workflows/run/projectAcceptedWorkflowRunTarget';
import { makeShareEligibleForTest } from '../../../../server/sources/testkit/shareEligibility.testkit';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { resolveMachineAdmission, setMachineAccessGrantInTx } from '../../../../server/sources/app/machines/machineAccess';
import { inTx } from '../../../../server/sources/storage/inTx';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import type { TrackedSession } from '@/daemon/types';
import * as processIdentity from '@/daemon/processIdentity';
import { hashProcessCommand, writeSessionMarker } from '@/daemon/sessionRegistry';
import { resolveSessionRunnerEntrypointIdentityFromProcessCommand } from '@/daemon/sessionRunnerRuntime/resolveRunnerEntrypointIdentity';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  readCurrentRunnerAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { dispatchCurrentAgentRuntimeDaemonServiceRequest } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient';
import { projectAgentRuntimeDaemonServiceTurnWitnessV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceTurnWitness';
import { resolveTrackedAgentRuntimeDaemonServiceAuthority } from '@/daemon/controlServer';
import { createRequesterSessionCredentialCustody, createRequesterSessionRuntimeContextResolver, resolveRequesterSessionBootstrapFromCustody, releaseUnretainedRequesterSessionRuntimeContext, type ResolveRequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createRequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/createRequesterSessionRuntimeContext';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { auth } from '../../../../server/sources/app/auth/auth';
import { eventRouter, type UserScopedConnection } from '../../../../server/sources/app/events/eventRouter';
import { sessionUpdateHandler } from '../../../../server/sources/app/api/socket/sessionUpdateHandler';
import { createSessionPublisherPresence } from '../../../../server/sources/app/presence/sessionPublisherPresence';
import { resolveSessionProtocolCapabilitiesFeature } from '../../../../server/sources/app/features/sessionProtocolCapabilitiesFeature';
import { resolveMachineRpcFeature } from '../../../../server/sources/app/features/machineRpcFeature';
import { evaluateAccountStoredContentSocketCompatibility, writeAccountStoredContentCompatibilityForSocket } from '../../../../server/sources/app/clientCompatibility/accountStoredContentCompatibility';
import { verifyExternalActionMachineRpcExecution } from '../../../../server/sources/app/auth/externalActionExecutionAuthorization';
import { registerManagedActivityRpcHandlers } from '@/api/machine/rpcHandlers.managedActivity';
import { createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD, ManagedIntentResultSchema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import type { ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { ExternalActionMachineRpcExecutionV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import { legacyPidSessionTrackingKey, trackedSessionForSingleSessionProcess, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
// Load runtime consumers only after the canonical transport boundaries are installed.
const { TokenStorage } = await import('../../../../ui/sources/auth/storage/tokenStorage');
const provisionerCatalog = await loadManagedProvisionerCatalogForTests();
const { captureLazyActionAccountContext } = await import('../../../../ui/sources/sync/ops/actions/actionAccountContext');
const { executeOriginalAccountMachineAction } = await import('../../../../ui/sources/sync/api/externalActionAccountTransport');

describe('managed catalog original Account transport', () => {
  let database: LightSqliteHarness;
  let channel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>;
  beforeAll(async () => { database = await createLightSqliteHarness({ tempDirPrefix: 'happier-fx16-catalog-', initAuth: true, initEncrypt: true,
    env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } }); }, 120_000);
  beforeEach(async () => { await home.reset(); provisionerCatalog.reset(); channel = await createRequesterCurrentnessSocketHarness(); });
  afterEach(async () => { await channel.close(); vi.restoreAllMocks(); });
  afterAll(async () => { await pluginReloadController.shutdown(); await home.reset(); await database.close(); });

  it.each(([
    { mode: 'e2ee', installFails: false, surface: 'agent', kind: 'software', realRunner: true },
    ...([
    { mode: 'plain', installFails: false }, { mode: 'e2ee', installFails: false },
    { mode: 'plain', installFails: true }, { mode: 'e2ee', installFails: true },
    ] as const).flatMap(value => (['UI', 'agent'] as const).map(surface => ({ ...value, surface, kind: 'software' as const }))),
    { mode: 'plain', installFails: false, surface: 'UI', kind: 'copy' },
    { mode: 'plain', installFails: false, surface: 'agent', kind: 'copy', launchRefusal: 'returned' },
    { mode: 'plain', installFails: false, surface: 'agent', kind: 'copy', launchRefusal: 'nonce' },
    { mode: 'plain', installFails: false, surface: 'agent', kind: 'copy', launchRefusal: 'agent-missing' },
    { mode: 'plain', installFails: false, surface: 'agent', kind: 'copy' },
    { mode: 'e2ee', installFails: false, surface: 'agent', kind: 'copy' },
    { mode: 'plain', installFails: false, surface: 'agent', kind: 'plan' },
    { mode: 'plain', installFails: false, surface: 'UI', kind: 'copy-software' },
    { mode: 'plain', installFails: false, surface: 'agent', kind: 'copy-software' },
    { mode: 'plain', installFails: false, surface: 'pat', kind: 'copy' },
    { mode: 'plain', installFails: false, surface: 'pat', kind: 'copy-software' },
    { mode: 'plain', installFails: false, surface: 'pat', kind: 'copy-software', r18Pat: 'scoped' },
    { mode: 'plain', installFails: false, surface: 'pat', kind: 'copy-software', r18Pat: 'scoped-manager' },
    { mode: 'plain', installFails: false, surface: 'pat', kind: 'copy-software', r18Pat: 'scoped-manager-input' },
    { mode: 'plain', installFails: false, surface: 'pat', kind: 'copy-software', r18Pat: 'unrestricted' },
    { mode: 'e2ee', installFails: false, surface: 'pat', kind: 'copy-software', r18Pat: 'unrestricted', protectedPat: true },
    { mode: 'e2ee', installFails: false, surface: 'pat', kind: 'copy-software', r18Pat: 'scoped-manager-input', protectedPat: true },
    { mode: 'e2ee', installFails: false, surface: 'pat', kind: 'copy-software', r18Pat: 'scoped-manager-input', protectedPat: true, adminAccessDisabled: true },
    { mode: 'e2ee', installFails: false, surface: 'pat', kind: 'copy-software', r18Pat: 'unrestricted', keylessPat: true },
    { mode: 'plain', installFails: false, surface: 'pat', kind: 'copy-software', denied: 'missing-plan-grant' },
    { mode: 'plain', installFails: false, surface: 'pat', kind: 'copy-software', denied: 'missing-apply-grant' },
    { mode: 'plain', installFails: false, surface: 'pat', kind: 'software' },
    { mode: 'plain', installFails: true, surface: 'pat', kind: 'software' },
    { mode: 'plain', installFails: true, surface: 'pat', kind: 'software', rerunSetup: true },
    { mode: 'e2ee', installFails: true, surface: 'pat', kind: 'software', protectedPat: true },
    { mode: 'e2ee', installFails: true, surface: 'pat', kind: 'software', protectedPat: true, rerunSetup: true },
    { mode: 'plain', installFails: false, surface: 'pat', kind: 'identity' },
    { mode: 'plain', installFails: false, surface: 'pat', kind: 'pat-setup' },
    { mode: 'e2ee', installFails: false, surface: 'pat', kind: 'pat-setup', protectedPat: true },
    { mode: 'e2ee', installFails: false, surface: 'pat', kind: 'pat-setup', keylessPat: true },
    { mode: 'plain', installFails: false, surface: 'pat', kind: 'pat-setup', unrestrictedPat: true },
    { mode: 'plain', installFails: false, surface: 'pat', kind: 'pat-setup', reviewedSetupChild: true },
    { mode: 'plain', installFails: false, surface: 'pat', kind: 'pat-setup', denied: 'missing-grant' },
    { mode: 'plain', installFails: false, surface: 'pat', kind: 'pat-setup', reviewedSetupChild: true, denied: 'missing-child-grant' },
    { mode: 'plain', installFails: false, surface: 'pat', kind: 'pat-setup', denied: 'revoked-root' },
    { mode: 'plain', installFails: false, surface: 'pat', kind: 'pat-setup', denied: 'foreign-machine' },
    { mode: 'plain', installFails: false, surface: 'voice', kind: 'copy-software' },
    { mode: 'plain', installFails: false, surface: 'voice', kind: 'software' },
    { mode: 'plain', installFails: false, surface: 'voice', kind: 'software', requireVoiceApproval: true },
    { mode: 'plain', installFails: false, surface: 'UI', kind: 'identity' },
    { mode: 'plain', installFails: false, surface: 'agent', kind: 'identity' },
    { mode: 'plain', installFails: false, surface: 'UI', kind: 'spawn' },
    { mode: 'plain', installFails: true, surface: 'UI', kind: 'spawn' },
    { mode: 'e2ee', installFails: false, surface: 'UI', kind: 'spawn' },
    { mode: 'e2ee', installFails: true, surface: 'UI', kind: 'spawn' },
    { mode: 'plain', installFails: false, surface: 'UI', kind: 'spawn-use' },
    { mode: 'plain', installFails: false, surface: 'UI', kind: 'spawn', sharedAccess: 'admin' },
    { mode: 'plain', installFails: false, surface: 'UI', kind: 'spawn', sharedAccess: 'view' },
    { mode: 'plain', installFails: false, surface: 'UI', kind: 'spawn', sharedAccess: 'none' },
  ] as const).filter(row => !('realRunner' in row) || process.env.HAPPIER_COMPOSED_SOURCE_RUNNER === '1')
    .map(row => ({ ...row, runnerBoundary: 'realRunner' in row
      ? 'foreground producer, claimed bootstrap and native input; SDK substitute'
      : row.surface === 'agent' ? 'supplied signed origin and runner authority'
        : 'Account transport with OS substitutes' })))(
    'settles foreign-template content and approval replay with explicit producer coverage %j', async (scenario) => {
    const { mode, installFails, surface, kind } = scenario;
    const sharedSpawn = kind === 'spawn-use' || 'sharedAccess' in scenario;
    const sharedAccess = kind === 'spawn-use' ? 'view' : 'sharedAccess' in scenario ? scenario.sharedAccess : undefined;
    const realRunner = 'realRunner' in scenario;
    let restoreForegroundAgentCli: (() => void) | undefined;
    let foregroundRunnerBootstrap: Parameters<typeof startMcpRequesterParent>[0]['foregroundRunnerBootstrap'];
    const launchRefusal = 'launchRefusal' in scenario ? scenario.launchRefusal : null;
    let refusedSessionId: string | undefined;
    const phaseFailures: Array<{ phase?: string; errorClass?: string; errorCode?: string | null;
      refusalBranch?: string; stackFrames?: readonly { file: string; line: number; column: number }[] }> = [];
    const originalWarnLocalFile = logger.warnLocalFile.bind(logger);
    vi.spyOn(logger, 'warnLocalFile').mockImplementation((message, ...args) => {
      if (message === '[external-action-phase]' && args[0] && typeof args[0] === 'object') {
        const diagnostic = args[0] as typeof phaseFailures[number];
        phaseFailures.push({ phase: diagnostic.phase, errorClass: diagnostic.errorClass,
          errorCode: diagnostic.errorCode, refusalBranch: diagnostic.refusalBranch,
          stackFrames: diagnostic.stackFrames });
      }
      originalWarnLocalFile(message, ...args);
    });
    const nativeRefusal = { type: 'error', errorCode: launchRefusal === 'agent-missing'
      ? SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING : SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'PRIVATE_POOL_TOKEN /private/profile',
      ...(launchRefusal === 'agent-missing' ? {} : {
        errorDetail: { kind: 'launch_error', code: 'no_eligible_member', message: 'PRIVATE_POOL_TOKEN /private/profile' },
      }) } as const;
    const requireVoiceApproval = 'requireVoiceApproval' in scenario && scenario.requireVoiceApproval === true;
    let releaseInstaller = () => {};
    let releaseRetryInstaller = () => {};
    let retryInstallerGate: Promise<void> | undefined;
    let settledResult: unknown;
    let agentStarts = 0;
    let voiceReadbacks = 0;
    let resetVoiceSession: (() => void) | undefined;
    let installerStarts = 0;
    let assertSoftwareInstalled: (() => Promise<void>) | undefined;
    let launchFixtureAgent: DirectSpawnedSessionTransport['spawn'] | undefined;
    let markInstallerStarted = () => {};
    let markRetryInstallerStarted = () => {};
    const installerGate = new Promise<void>(resolve => { releaseInstaller = resolve; });
    const installerStarted = new Promise<void>(resolve => { markInstallerStarted = resolve; });
    const retryInstallerStarted = new Promise<void>(resolve => { markRetryInstallerStarted = resolve; });
    const machineKey = new Uint8Array(32).fill(23);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const authorMachineKey = new Uint8Array(32).fill(31);
    const authorPublicKey = tweetnacl.box.keyPair.fromSecretKey(authorMachineKey).publicKey;
    const createAccount = async (contentPublicKey: Uint8Array) => {
      const signing = tweetnacl.sign.keyPair();
      return db.account.create({ data: { encryptionMode: mode, publicKey: Buffer.from(signing.publicKey).toString('hex'),
        ...(mode === 'e2ee' ? { contentPublicKey,
          contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey }) } : {}) } });
    };
    const author = await createAccount(authorPublicKey);
    const recipient = await createAccount(publicKey);
    const machineCustodian = sharedSpawn || 'denied' in scenario && scenario.denied === 'foreign-machine' ? author : recipient;
    await makeShareEligibleForTest(author.id, recipient.id);
    const homeId = await getOrCreateServerIdentityId();
    const createPatEncryption = (tokenId: string, wrappingSecret = crypto.getRandomValues(new Uint8Array(32))) => ({ access: wrapApiTokenEncryptionAccessV1({
      context: { serverIdentityId: homeId, accountId: recipient.id, tokenId,
        contentPublicKey: encodeBase64(publicKey) },
      wrappingSecret, contentPrivateKey: machineKey,
      randomBytes: length => crypto.getRandomValues(new Uint8Array(length)),
    }) });
    const serverUrl = channel.serverUrl;
    const machineId = `template-settlement-${mode}-${crypto.randomUUID()}`;
    const userToken = await createAccountTokenForTests(recipient.id, { kind: 'account', authority: 'present_user' });
    const installedToken = await createAccountTokenForTests(machineCustodian.id, { kind: 'terminal', authority: 'account_automation' });
    const authorToken = await createAccountTokenForTests(author.id, { kind: 'account', authority: 'present_user' });
    const trackedSessions = new Map<SessionTrackingKey, TrackedSession>();
    let resolveRequesterRuntime: ResolveRequesterSessionRuntimeContext;
    let credentialCustody: Awaited<ReturnType<typeof createRequesterSessionCredentialCustody>> | undefined;
    const software = await createNativeSoftwareInstallFixture({ scenario: 'native-confirm', packageName: 'hello', accountEncryptionMode: mode,
      ...('adminAccessDisabled' in scenario ? { adminAccessMode: 'none' } : {}),
      accountId: machineCustodian.id, machineId, homeId, token: userToken, installedToken, serverHttpBaseUrl: serverUrl,
      sessionStartup: { trackedSessions,
        useRealSessionSpawn: realRunner || 'rerunSetup' in scenario || kind === 'copy' || kind === 'copy-software' || kind === 'spawn' || sharedSpawn || kind === 'plan'
          || kind === 'pat-setup' && 'reviewedSetupChild' in scenario,
        startup: {
          ...(realRunner ? { onHappySessionWebhook: createOnHappySessionWebhook({
            trackedSessionsByKey: trackedSessions, spawnAwaiterByKey: new Map(),
          }) } : {}),
          ...(surface === 'agent' ? {
            resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl, token: installedToken,
              projection: 'authenticated' }),
          } : {}),
          // Substitute only the physical runner process. Directory preparation,
          // daemon Action ingress, content-before-launch and Home birth stay real.
          ...(realRunner || kind === 'spawn' || kind === 'spawn-use' || kind === 'copy' || kind === 'copy-software'
            || kind === 'pat-setup' && 'reviewedSetupChild' in scenario ? {
          resolveSessionSpawnDirectTargetTransport: () => ({ machineId,
            prepare: (request, options) => prepareSessionCreationTarget({ request, signal: options?.signal }),
            spawnedSession: {
              spawn: async (request, options) => { agentStarts++;
                if (kind !== 'copy' && !realRunner) await assertSoftwareInstalled?.();
                return await launchFixtureAgent!(request, options); },
              resolveSpawnSessionByNonce: async () => launchRefusal === 'nonce'
                ? { status: 'error' as const, errorCode: nativeRefusal.errorCode,
                  errorMessage: nativeRefusal.errorMessage, errorDetail: nativeRefusal.errorDetail }
                : { status: 'not_found' as const },
            },
          }),
          } : {}),
        },
        resolveRequesterSessionRuntimeContext: (...args) => resolveRequesterRuntime(...args),
        releaseRequesterSessionRuntimeContext: context => releaseUnretainedRequesterSessionRuntimeContext(context,
          [...trackedSessions.values()].map(value => value.requesterSessionRuntimeContext)),
      },
      ...(kind === 'spawn-use' ? { additionalPlugins: [{ files: {}, manifest: MACHINE_RECIPES_MANIFEST }] }
        : surface === 'agent' ? { additionalPlugins: [{
        manifest: createPluginManifestV2Fixture({ id: 'acme.template-update-agent', contributes: { agents: [{
          id: 'agent', title: 'Template update Agent', runtime: { kind: 'custom' }, primary: 'sessions',
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: !realRunner } },
        }] } }),
        files: {
          'agent.mjs': realRunner
            ? `export function factory() { return { sessions: { open(request, context) { return globalThis[Symbol.for(${JSON.stringify(MCP_REQUESTER_SDK_FIXTURE_KEY)})](request, context); } } }; }`
            : `export function factory() { return { sessions: { open() { throw new Error('No provider turn in Account action test'); } } }; }`,
          'daemon.mjs': `import { factory } from './agent.mjs'; export function activate(api) { api.agents.register('agent', factory, { sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 } }); }`,
        },
      }] } : {}),
      installFails, beforeInstall: async () => {
        installerStarts++;
        if (installerStarts === 1) { markInstallerStarted(); await installerGate; }
        else if (retryInstallerGate) { markRetryInstallerStarted(); await retryInstallerGate; }
      } });
    assertSoftwareInstalled = async () => { expect(await software.readInstalled()).toMatchObject({ installed: true }); };
    launchFixtureAgent = async (request, options) => {
      // Keep native managed-directory materialization real before substituting
      // the OS process, as executeSpawnSessionRequest does before runner launch.
      const directories = createManagedSessionDirectories();
      const requesterCredentials = options?.requesterSessionBootstrap?.credentials ?? software.credentials;
      const existingSession = request.existingSessionId ? await fetchSessionById({ token: requesterCredentials.token,
        sessionId: request.existingSessionId, serverUrl, reason: 'session-action' }) : null;
      const existingOwnerMetadata = existingSession ? tryDecryptSessionOwnerMetadata({ credentials: requesterCredentials,
        rawSession: existingSession, accountEncryptionMode: mode }) : null;
      const managedDirectory = request.directoryKind === 'managed'
        ? await directories.prepareForSpawn({ ...request,
          existingSessionCreationTag: existingOwnerMetadata?.system?.sessionCreationCorrespondenceV1?.sessionCreationTag }) : null;
      if (managedDirectory) {
        expect(managedDirectory.ok).toBe(true);
        if (!managedDirectory.ok) throw new Error(managedDirectory.errorCode);
        expect(managedDirectory.directory).toBe(request.directory);
      }
      if (launchRefusal) {
        expect(request.existingSessionId, 'The creator must commit its child before native prelaunch refusal').toBeTruthy();
        refusedSessionId = request.existingSessionId;
        return launchRefusal === 'nonce' ? { type: 'success', spawnNonce: request.spawnNonce, sessionIdStatus: 'pending' }
          : nativeRefusal;
      }
      // Simulate the process's Home handshake through the real metadata/create
      // owners. Template content commits its Session before the runner starts.
      const created = await getOrCreateSessionByTag({ credentials: requesterCredentials,
        tag: request.sessionCreationTag!, metadata: buildCommittedLaunchMetadata({ options: request, directory: request.directory }),
        agentState: null, accountEncryptionCurrentness: software.accountEncryptionCurrentness,
        ...(options?.creationAuthorization ? { creationAuthorizationToken: options.creationAuthorization.token,
          prepareCreationAuthorizationProof: options.creationAuthorization.prepareRequestProof } : {}),
      });
      if (request.existingSessionId) {
        expect(created.session.id).toBe(request.existingSessionId);
        expect((await stat(request.directory)).isDirectory()).toBe(true);
      } else {
        expect(created.creationConfirmed).toBe(true);
      }
      expect(created.organizationPlacement).toBeDefined();
      if (managedDirectory?.ok) await directories.bind({ allocationId: managedDirectory.allocationId, sessionId: created.session.id });
      return { type: 'success', sessionId: created.session.id, sessionCreationOutcome: {
        disposition: created.created ? 'created' : 'rejoined', organizationPlacement: created.organizationPlacement,
      } };
    };
    // The fixture normally owns Home IO. This composed lane replaces that leaf
    // with the real authenticated HTTP routes and real SQLite persistence.
    vi.mocked(axios.get).mockRestore();
    const installationId = software.installation.installationId;
    const installedServerId = configuration.activeServerId;
    resolveRequesterRuntime = createRequesterSessionRuntimeContextResolver({ trackedSessions,
      getCreateRuntime: () => async (bootstrap, signal) => createRequesterSessionRuntimeContext({ bootstrap, signal,
        providerAccountUsageStore: software.sessionControlRuntime()!.resolveProviderAccountUsageStore(bootstrap.attribution),
        activeServerDir: configuration.activeServerDir,
        connectedServicesMaterializationBaseDir: join(configuration.happyHomeDir, 'connected-services'),
        resolveQualifiedConnectedAccountV4Support: () => 'indeterminate', coordinatorInput: {
          machineId, machineIdProvider: () => machineId, runtimeId: 'template-update-requester', happyHomeDir: configuration.happyHomeDir,
          logger, processEnv: { HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
          trackedSessionsByKey: trackedSessions, connectedServiceRuntimeRegistry: software.connectedServiceRegistry,
          connectedServiceAuthGroupPreTurnSwitchCoordinator: software.sessionControlRuntime()!.connectedServiceAuthGroupPreTurnSwitchCoordinator,
        } }),
      recoverBootstrap: ({ sessionId, attribution, signal, onRecoveryRefused }) => resolveRequesterSessionBootstrapFromCustody({
        happyHomeDir: configuration.happyHomeDir, sessionId, serverId: configuration.activeServerId, serverHttpBaseUrl: serverUrl,
        expectedAttribution: attribution, legacyOwnerCredentials: software.credentials, signal, onRecoveryRefused,
        machineAdmissionBoundary: { machineId, daemonToken: installedToken, readInstallation: () => software.installation,
          getObservedServerIdentityId: () => homeId, isHomeCurrent: () =>
            configuration.activeServerId === installedServerId && configuration.apiServerUrl === serverUrl
              ? isServerProfileHomeIdentity(installedServerId, homeId) : false },
      }),
    });
    await db.machine.create({ data: { id: machineId, accountId: machineCustodian.id, installationId,
      installationPublicKey: software.pair.publicKey, metadata: software.readHomeMachine().metadata,
      dataEncryptionKey: Buffer.from(software.readHomeMachine().dataEncryptionKey!, 'base64'),
      metadataVersion: 1, active: true, lastActiveAt: new Date(),
      operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
    if (sharedAccess && sharedAccess !== 'none') {
      expect(await inTx(tx => setMachineAccessGrantInTx(tx, { machineId, actorAccountId: machineCustodian.id,
        principal: { kind: 'account', accountId: recipient.id }, level: sharedAccess }))).toMatchObject({ kind: 'saved' });
    }
    const uiCredentials = mode === 'plain' ? { token: userToken } : {
      token: userToken, encryption: { machineKey: encodeBase64(machineKey), publicKey: encodeBase64(publicKey) },
    } as const;
    const uiServerId = await home.addHome({ name: 'Template recipient', serverUrl, serverIdentityId: homeId,
      accountId: recipient.id, accountEncryptionMode: mode, currentAccount: true, credentials: uiCredentials, botsEnabled: true });
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(uiCredentials);
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    let approvalRootToken: string | undefined;
    let diagnosticPatBearer: string | undefined;
    const httpOutcomes: Array<{ method: string; url: string; status: number; error?: unknown;
      effectActionId?: string; authorityCeiling?: string | null; usedInstalledAccountBearer?: boolean;
      usedOriginalPatRoot?: boolean; hasAuthorizationBearer?: boolean; usedRawPatBearer?: boolean;
      authenticatedKind?: string; signedEffectAdmitted?: boolean; workflowOperation?: string;
      hasReviewedChildProof?: boolean }> = [];
    const expectSignedPatSettlement = (start: number, actionId: string, artifactId: string) => {
      const verifiedAt = httpOutcomes.findIndex((value, index) => index >= start && value.method === 'POST'
        && value.url === `/v1/actions/${actionId}/execution-authorization/verify` && value.status === 200);
      expect(verifiedAt, 'Approved PAT root must be verified before its durable settlement').toBeGreaterThanOrEqual(start);
      const settlement = httpOutcomes.slice(verifiedAt + 1).filter(value => value.url === `/v1/artifacts/${artifactId}`
        && (value.method === 'GET' || value.method === 'POST'));
      expect(settlement.some(value => value.method === 'POST'), 'Approved PAT parent must settle its Artifact').toBe(true);
      expect(settlement.every(value => value.usedInstalledAccountBearer === false),
        'PAT effect settlement must not borrow the installed daemon Account bearer').toBe(true);
      return verifiedAt;
    };
    const admittedRunIds: string[] = [];
    const claimedRunIds: string[] = [];
    let signalWorkflowAdmitted = () => {};
    let workflowAdmitted = new Promise<void>(resolve => { signalWorkflowAdmitted = resolve; });
    app.addHook('onSend', async (request, reply, payload) => {
      let error: unknown;
      if (reply.statusCode >= 400 && typeof payload === 'string') {
        try { const body = JSON.parse(payload); error = { code: body.code, error: body.error, ...(body.diagnostic ? { diagnostic: body.diagnostic } : {}) }; } catch {}
      }
      const effectActionId = request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER];
      httpOutcomes.push({ method: request.method, url: request.url, status: reply.statusCode, ...(error ? { error } : {}),
        ...(request.url === '/v1/sessions' || request.url === '/v1/account/encryption/currentness'
          || request.method === 'GET' && request.url === `/v1/machines/${machineId}`
          ? { authenticatedKind: request.authTokenKind,
          signedEffectAdmitted: request.externalActionExecutionAuthorized === true,
          hasReviewedChildProof: typeof request.headers[EXTERNAL_ACTION_REVIEWED_CHILD_HEADER] === 'string',
          usedRawPatBearer: diagnosticPatBearer !== undefined
            && request.headers.authorization === `Bearer ${diagnosticPatBearer}` } : {}),
        ...(approvalRootToken ? {
          usedOriginalPatRoot: request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === approvalRootToken,
          hasAuthorizationBearer: typeof request.headers.authorization === 'string',
        } : {}),
        ...(request.url === WORKFLOW_RUN_STORAGE_HTTP_PATH && request.body && typeof request.body === 'object'
          && 'operation' in request.body && typeof request.body.operation === 'string'
          ? { workflowOperation: request.body.operation } : {}),
        ...((kind === 'spawn-use' || request.url === '/v1/account/encryption/currentness'
          || request.method === 'GET' && request.url === `/v1/machines/${machineId}`)
          && typeof effectActionId === 'string' ? { effectActionId } : {}),
        ...(request.url.startsWith('/v1/actions/') || request.url.startsWith('/v1/artifacts') ? { usedInstalledAccountBearer:
          request.headers.authorization === `Bearer ${installedToken}`, authorityCeiling:
          typeof request.headers[AUTHORITY_CEILING_HEADER_V1] === 'string'
            ? request.headers[AUTHORITY_CEILING_HEADER_V1] : null } : {}) });
      if (request.url === WORKFLOW_RUN_STORAGE_HTTP_PATH && reply.statusCode < 400 && request.body
        && typeof request.body === 'object' && 'operation' in request.body && request.body.operation === 'admit'
        && 'runId' in request.body && typeof request.body.runId === 'string') {
        admittedRunIds.push(request.body.runId);
        signalWorkflowAdmitted();
      }
      if (request.method === 'POST' && request.url === '/v3/automations/runs/claim' && reply.statusCode < 400
        && typeof payload === 'string') {
        const claim = AutomationV3WorkerClaimResponseSchema.parse(JSON.parse(payload));
        if (claim.run) claimedRunIds.push(claim.run.id);
      }
      return payload;
    });
    let liveSessionId: string | null = null;
    app.decorate('resolveCurrentSessionMachine', async ({ accountId, sessionId }: { accountId: string; sessionId: string }) => {
      return accountId === recipient.id && sessionId === liveSessionId ? machineId : null;
    });
    app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    enableErrorHandlers(app); enableAuthentication(app);
    registerAccountEncryptionRoutes(app); registerAccountSettingsRoutes(app); registerPromptLibraryRoutes(app);
    registerConnectedAccountConfigurationRowsRoutes(app);
    registerApiTokenIntrospectionRoute(app); registerAccountApiTokenManagementRoutes(app);
    registerProjectAccountRowRoutes(app);
    machinesRoutes(app); artifactsRoutes(app); sessionRoutes(app); accessKeysRoutes(app);
    sessionPendingRoutes(app);
    registerAuthPingRoute(app); registerAccountProfileRoute(app); registerPluginAvailabilityRoutes(app);
    const featurePayload = FeaturesResponseSchema.parse(createRootLayoutFeaturesResponse({
      features: { bots: { enabled: true }, automations: { enabled: true }, workflows: { enabled: true },
        ...(surface === 'voice' ? { voice: { enabled: true } } : {}) },
      capabilities: { ...resolveSessionProtocolCapabilitiesFeature().capabilities,
        ...(sharedSpawn ? resolveMachineRpcFeature(process.env).capabilities : {}),
        serverIdentity: { serverIdentityId: homeId }, encryption: { storagePolicy: 'optional' } } }));
    app.get('/v1/features', async () => featurePayload);
    app.get('/v1/features/authenticated', { preHandler: app.authenticate }, async () => featurePayload);
    registerWorkflowRunStorageRoutes(app);
    registerAutomationV3Routes(app);
    // The loopback network substitutes Home's socket endpoint. Register its
    // genuinely authenticated peers with the real DB event publisher so Run
    // observations receive the same content-free Account wake as production.
    const publisherPresence = createSessionPublisherPresence();
    // The installed daemon's Home socket is the transport boundary. Use the
    // real admitted Machine handler for input custody, not a metadata-only ACK.
    const machinePeer = Object.assign(createFakeSocket({ nsp: { server: channel.server }, data: {
      clientType: 'machine-scoped', machineId,
      [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: installationId,
    } }), { handshake: { auth: { token: installedToken } } });
    const machineCredential = await auth.verifyTokenForRoute(installedToken);
    if (!machineCredential) throw new Error('Installed Machine socket credential was not admitted');
    Object.assign(machinePeer.data!, { authTokenKind: machineCredential.authTokenKind,
      authAuthority: machineCredential.authority, authTokenAuthenticationEvidence: machineCredential.authenticationEvidence });
    qualifyCurrentAccountStoredContentSocket(machinePeer);
    // Canonical testkit substitutes Socket.IO only; all authorization and DB
    // admission beneath the established transport stay real.
    machineUpdateHandler(machineCustodian.id, machinePeer as unknown as import('socket.io').Socket, {
      operationSocketBatchLimits: resolveExternalSessionOperationSocketBatchLimitsForMaxHttpBufferSize(channel.server.engine.opts.maxHttpBufferSize),
    });
    software.setMachineSocketHomeEvent((event, payload) => new Promise((resolve, reject) => {
      void Promise.resolve(getSocketHandler(machinePeer, event)(payload, resolve)).catch(reject);
    }));
    const sessionRpcPeers = new Map<string, import('socket.io').Socket>();
    const rpcDeliveryFailures: Array<{ method: string; errorClass: string; message: string; code?: string | number;
      reason?: string; signedExecution?: boolean; rootActionId?: string; originKind?: string;
      machineAdmission?: boolean }> = [];
    const registerAccountPeer = async (peer: import('socket.io').Socket) => {
      const token: unknown = peer.handshake.auth.token;
      const verified = typeof token === 'string' ? await auth.verifyTokenForRoute(token) : null;
      if (!verified) throw new Error('Loopback Account socket authentication failed');
      peer.data.authTokenKind = verified.authTokenKind;
      peer.data.authAuthority = verified.authority;
      peer.data.authTokenAuthenticationEvidence = verified.authenticationEvidence;
      writeAccountStoredContentCompatibilityForSocket(peer,
        evaluateAccountStoredContentSocketCompatibility(peer.handshake.auth));
      peer.on(SOCKET_RPC_EVENTS.CALL, (packet: SocketRpcRequestPayload, acknowledge: (response: unknown) => void) => {
        // The loopback Home sends Session RPCs to the admitted original host
        // socket; its registered RpcHandlerManager performs the real read.
        const methodSeparator = packet.method.indexOf(':');
        const sessionTarget = methodSeparator > 0 ? sessionRpcPeers.get(packet.method.slice(0, methodSeparator)) : undefined;
        if (sessionTarget) {
          sessionTarget.emit(SOCKET_RPC_EVENTS.REQUEST, packet, result => acknowledge({ ok: true, result }));
          return;
        }
        let deliveryAdmissionPresent = false;
        const deliver = async () => {
          let machineAdmission: SocketRpcMachineAdmissionContextV1 | undefined;
          if (!packet.externalActionExecution) {
            const admission = await resolveMachineAdmission({ actorAccountId: verified.userId, machineId,
              rpcMethod: packet.method.slice(packet.method.indexOf(':') + 1), callerAuthority: verified.authority });
            if (admission.kind !== 'admitted') return { ok: false, result: { errorCode: admission.code } };
            const { kind: _kind, ...context } = admission;
            machineAdmission = context;
          }
          deliveryAdmissionPresent = machineAdmission !== undefined;
          return software.receiveRpc(packet.externalActionExecution ? packet
            : { ...packet, callerAuthority: verified.authority }, machineAdmission);
        };
        void deliver().then(response => {
          const result: unknown = response.result;
          const code: unknown = result && typeof result === 'object' ? Reflect.get(result, 'errorCode') : undefined;
          if (typeof code === 'string') {
            const details: unknown = Reflect.get(result as object, 'details');
            const reason: unknown = details && typeof details === 'object' ? Reflect.get(details, 'reason') : undefined;
            const binding = packet.externalActionExecution?.authorization.binding;
            rpcDeliveryFailures.push({ method: packet.method, errorClass: 'RpcResponseError',
              message: 'Native RPC owner refused delivery', code,
              ...(typeof reason === 'string' ? { reason } : {}),
              signedExecution: packet.externalActionExecution !== undefined,
              ...(binding ? { rootActionId: binding.actionId, originKind: binding.sessionActionOrigin
                ? 'session' : binding.workflowActionOrigin ? 'workflow' : 'host' } : {}),
              machineAdmission: deliveryAdmissionPresent });
          }
          acknowledge(response);
        }, error => {
          const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
          rpcDeliveryFailures.push({ method: packet.method,
            errorClass: error instanceof Error ? error.name : 'UnknownError',
            message: error instanceof Error ? error.message : 'unknown_failure',
            ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}) });
          acknowledge({ ok: false, errorCode: 'fixture_rpc_delivery_failed' });
        });
      });
      if (peer.handshake.auth.clientType === 'session-scoped') {
        const sessionId: unknown = peer.handshake.auth.sessionId;
        const requestedMachineId: unknown = peer.handshake.auth.machineId;
        if (typeof sessionId !== 'string' || typeof requestedMachineId !== 'string'
          || verified.userId !== recipient.id || requestedMachineId !== machineId
          || !await db.accessKey.findFirst({ where: { accountId: recipient.id, sessionId, machineId } })) {
          throw new Error('Loopback Session socket admission failed');
        }
        const connection = { connectionType: 'session-scoped' as const, socket: peer,
          userId: verified.userId, sessionId, machineId };
        sessionRpcPeers.set(sessionId, peer);
        eventRouter.addConnection(verified.userId, connection);
        sessionUpdateHandler(verified.userId, peer, connection, {
          presence: publisherPresence, binding: { accountId: verified.userId, machineId, sessionId } });
        peer.once('disconnect', () => {
          if (sessionRpcPeers.get(sessionId) === peer) sessionRpcPeers.delete(sessionId);
          eventRouter.removeConnection(verified.userId, connection);
        });
        return;
      }
      const connection: UserScopedConnection = { connectionType: 'user-scoped', socket: peer, userId: verified.userId };
      eventRouter.addConnection(verified.userId, connection);
      peer.once('disconnect', () => eventRouter.removeConnection(verified.userId, connection));
    };
    await Promise.all([...channel.server.sockets.sockets.values()].map(registerAccountPeer));
    channel.server.use((peer, next) => { void registerAccountPeer(peer).then(() => next(), error => next(error)); });
    const io = new Server(createServer());
    const nativeExecutions: Array<{ actionId: string; execution: unknown }> = [];
    const nativeInvocationFacts: Array<Readonly<{ actionId: string; sealedContext: boolean; opened: boolean;
      invocation: boolean; surface?: string; authority?: string; callerKind?: string; confirmation: boolean;
      confirmationActionMatches?: boolean; confirmationRequestMatches?: boolean; confirmationAccountMatches?: boolean;
      confirmationServerMatches?: boolean; confirmationTargetKind?: string | null; confirmationTargetMatches?: boolean;
      inputOpened: boolean; confirmationInputDigestMatches?: boolean; reviewedParent: boolean;
      bindingAuthKind?: string; principalAccountId?: string; principalId?: string; credentialId?: string }>> = [];
    registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io, forwardRpc: async request => {
      const { ExternalActionDaemonDispatchRequestSchema } = await import('@happier-dev/protocol/actions');
      const admitted = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
      if (admitted.actionId === 'machines.setup.apply') {
        const binding = admitted.executionAuthorization.binding;
        const opened = openExternalActionRequesterAccountContextV1({ authorization: admitted.executionAuthorization,
          purpose: { kind: 'external_action' }, machineId, installationId, serverIdentityId: homeId,
          installationPrivateKey: software.pair.secretKey, includeInvocation: true });
        const requestInput = admitted.envelope.v === 1 ? { input: admitted.envelope.input }
          : openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: admitted.envelope,
            binding: { serverIdentityId: binding.serverIdentityId, accountId: binding.accountId,
              actionId: admitted.actionId, requestId: binding.requestId, target: binding.target,
              ...('authentication' in binding ? { authentication: binding.authentication } : {
                principalId: binding.principalId, credentialId: binding.credentialId,
              }) }, material: { type: 'dataKey', machineKey } });
        const invocation = opened?.invocation;
        const confirmation = invocation?.presentUserConfirmation;
        nativeInvocationFacts.push({ actionId: admitted.actionId,
          sealedContext: Boolean(admitted.executionAuthorization.requesterAccountContext), opened: opened !== null,
          invocation: invocation !== undefined, ...(invocation ? { surface: invocation.surface,
            authority: invocation.authority, callerKind: invocation.caller.kind } : {}),
          confirmation: confirmation !== undefined,
          ...(confirmation ? { confirmationActionMatches: confirmation.actionId === admitted.actionId,
            confirmationRequestMatches: confirmation.requestId === binding.requestId,
            confirmationAccountMatches: confirmation.accountId === binding.accountId,
            confirmationServerMatches: confirmation.serverId === binding.serverIdentityId,
            confirmationTargetKind: confirmation.target?.kind ?? null,
            confirmationTargetMatches: sameStrictJsonValue(confirmation.target, binding.target),
            ...(requestInput ? { confirmationInputDigestMatches: confirmation.inputDigest
              === computeActionInputApprovalDigestV1(admitted.actionId, requestInput.input) } : {}) } : {}),
          inputOpened: requestInput !== null,
          reviewedParent: invocation?.reviewedParent !== undefined,
          ...('authentication' in binding ? { bindingAuthKind: binding.authentication.kind }
            : { principalAccountId: binding.accountId, principalId: binding.principalId, credentialId: binding.credentialId }),
        });
      }
      const result = await software.receiveDispatch(admitted);
      const binding = admitted.executionAuthorization.binding;
      const responseMaterial = isReviewedMachineSetupCodecV1(binding)
        ? openManagedControllerActionCodecV1({ authorization: admitted.executionAuthorization, machineId,
          installationId: software.installation.installationId, serverIdentityId: binding.serverIdentityId,
          installationPrivateKey: software.pair.secretKey })
        : { type: 'dataKey' as const, machineKey };
      const execution = admitted.envelope.v === 2 && result.prepared.response.v === 2 && 'authentication' in binding && responseMaterial
        ? openExternalActionResponseV2({ envelope: result.prepared.response, request: admitted.envelope,
          material: responseMaterial, binding: {
            serverIdentityId: binding.serverIdentityId, accountId: binding.accountId, actionId: admitted.actionId,
            requestId: admitted.envelope.requestId, target: admitted.envelope.target,
            authentication: { kind: binding.authentication.kind, tokenEpoch: binding.authentication.tokenEpoch },
          } }) : result.prepared.response.v === 1 ? result.prepared.response.execution : null;
      nativeExecutions.push({ actionId: admitted.actionId, execution });
      return { ok: true, result: createExternalActionDaemonDispatchResponse(result.prepared) };
    } }) });
    if (surface === 'voice' || kind === 'plan' || 'rerunSetup' in scenario) {
      const content = prepareAccountSettingsV2Content({ credentials: software.credentials, envelopeKind: mode === 'e2ee' ? 'encrypted' : 'plain',
        raw: { ...(surface === 'voice' ? { voice: { ...settingsDefaults.voice, canApproveRequests: true } } : {}),
          ...(kind === 'plan' ? { actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
            actions: { [SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action]: { approvalRequiredSurfaces: ['agent'] } } }) } : {}),
          ...('rerunSetup' in scenario ? { actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
            actions: { 'machines.setup.apply': { approvalRequiredSurfaces: ['agent'] } } }) } : {}),
          ...(requireVoiceApproval ? { actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
            actions: { 'machines.setup.apply': { approvalRequiredSurfaces: ['voice'] } } }) } : {}) } });
      const written = await app.inject({ method: 'POST', url: '/v2/account/settings',
        headers: { authorization: `Bearer ${userToken}`, ...buildCurrentAccountStoredContentCompatibilityHttpHeaders() },
        payload: { expectedVersion: 0, content } });
      expect(written.statusCode, written.payload).toBe(200);
      // The UI testkit's Home network boundary must read the same stored Home
      // version that the real Settings route just accepted.
      home.answer(uiServerId, 'GET /v2/account/settings', { select: async (_input, request) => {
        const response = await app.inject({ method: 'GET', url: '/v2/account/settings',
          headers: Object.fromEntries(new Headers(request.init?.headers).entries()) });
        return { status: response.statusCode, body: JSON.parse(response.payload) };
      } });
    }
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: serverUrl });
    if ('rerunSetup' in scenario) {
      home.answer(uiServerId, 'POST /v1/machines/read-batch', { select: async (value, request) => {
        const response = await app.inject({ method: 'POST', url: '/v1/machines/read-batch',
          headers: Object.fromEntries(new Headers(request.init?.headers).entries()), payload: value });
        return { status: response.statusCode, body: response.json() };
      } });
    }
    const { setRuntimeFetch, resetRuntimeFetch } = await import('../../../../ui/sources/utils/system/runtimeFetch');
    const nativeFetch = globalThis.fetch;
    const fetchHome = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === software.controlHttpOrigin()) return nativeFetch(input, init);
      const response = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'PATCH',
        url: `${url.pathname}${url.search}`, headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === 'string' ? { payload: init.body } : {}) });
      return new Response(response.payload, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    };
    setRuntimeFetch(fetchHome); vi.spyOn(globalThis, 'fetch').mockImplementation(fetchHome);
    let captured: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
    let restoreRunnerIdentity: (() => void) | undefined;
    let liveParent: Awaited<ReturnType<typeof startMcpRequesterParent>> | undefined;
    let parentRegistryLease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>> | undefined;
    let automationWorker: ReturnType<typeof startAutomationWorker> | undefined;
    let workflowWake: Promise<void> | undefined;
    let recipientStore: ReturnType<typeof createCredentialedAccountArtifactStore> | undefined;
    try {
      await software.startInstalledRuntime();
      if (kind === 'software' || kind === 'copy-software' || kind === 'pat-setup' || kind === 'spawn' || kind === 'spawn-use') {
        automationWorker = startAutomationWorker({ token: installedToken, credentials: software.credentials, machineId,
          requesterHomeServerIdentityId: homeId,
          requesterWorkAttributionV1: { serverId: installedServerId, accountId: machineCustodian.id, machineId, installationId },
          coordinateWorkflowRun: (claim, requester) => software.coordinateWorkflowClaim(claim, requester) });
        workflowWake = workflowAdmitted.then(() => automationWorker!.catchUp());
        void workflowWake.catch(() => {});
      }
      if (sharedSpawn) await software.client.refreshProviderBrokerIngressAdvertisement(featurePayload);
      if (realRunner || 'rerunSetup' in scenario || (surface === 'agent' || surface === 'pat') && (kind === 'copy' || kind === 'copy-software') || sharedSpawn || kind === 'plan'
        || kind === 'pat-setup' && 'reviewedSetupChild' in scenario) {
        // The loopback Machine socket retains the native publication in its
        // testkit. Materialize that exact snapshot in Home for spawn preflight.
        const published = software.readHomeMachine();
        expect(published.operationProtocolCapabilities).toMatchObject({ sessionSpawn: { protocolVersions: expect.any(Array) } });
        if (sharedSpawn) expect(published.operationProtocolCapabilities).toMatchObject({
          requesterExecutionIsolation: { protocolVersions: expect.arrayContaining([1]) },
        });
        await db.machine.update({ where: { id: machineId }, data: {
          operationProtocolCapabilities: published.operationProtocolCapabilities,
          operationProtocolCapabilitiesRevision: published.operationProtocolCapabilitiesRevision,
        } });
      }
      if (sharedAccess === 'view' || sharedAccess === 'none') {
        if (sharedAccess === 'view') expect(await resolveMachineAdmission({ actorAccountId: recipient.id, machineId,
          actionId: 'session.spawn_new', callerAuthority: 'present_user' })).toMatchObject({ kind: 'admitted', role: 'use' });
        const { loadSyncSingletonForTests } = await import('../../../../ui/sources/dev/testkit/harness/syncSingletonLoader');
        await loadSyncSingletonForTests();
        const { createDefaultActionExecutor } = await import('../../../../ui/sources/sync/ops/actions/defaultActionExecutor');
        const result = await createDefaultActionExecutor().executeConfirmed('session.spawn_new', {
          creationKey: crypto.randomUUID(), executionTarget: { serverId: uiServerId, machineId },
          directory: { kind: 'managed' }, memoryEnabled: false,
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
          connectedServices: { v: 2, bindingsByServiceId: {} },
          machineSetupPlanInput: { homeId, machineId, sources: kind === 'spawn-use' ? [{ kind: 'direct', setup: { items: [{
            kind: 'softwareRecipe', selection: { ref: { pluginId: 'happier.machine.recipes', recipeId: 'docker-engine', revision: '1' }, inputs: {} },
          }] } }] : software.sources },
        }, { surface: 'ui', authority: 'present_user', serverId: uiServerId });
        expect(result, JSON.stringify({ result, httpOutcomes, nativeExecutions })).toMatchObject({
          ok: false, errorCode: sharedAccess === 'none' ? 'admission_unavailable' : 'target_unavailable',
          ...(sharedAccess === 'view' ? { details: { reason: 'machine_setup_requires_manage',
            requiredFact: 'machine_manage_role', remedy: 'request_machine_manage_access' } } : {}) });
        if (sharedAccess === 'view') expect(httpOutcomes).toContainEqual(expect.objectContaining({ method: 'POST',
          url: '/v1/actions/session.spawn_new/execution-authorization', status: 409,
          error: expect.objectContaining({ error: 'invalid_request', code: 'target_unavailable',
            ...(sharedAccess === 'view' ? { diagnostic: { reason: 'machine_setup_requires_manage',
              requiredFact: 'machine_manage_role', remedy: 'request_machine_manage_access' } } : {}) }) }));
        if (sharedAccess === 'none') expect(httpOutcomes.filter(value => value.url.startsWith('/v1/actions/'))).toEqual([]);
        expect(nativeExecutions.filter(value => value.actionId === 'session.spawn_new')).toHaveLength(0);
        expect(admittedRunIds).toEqual([]);
        expect((await db.machine.findUniqueOrThrow({ where: { id: machineId } })).accountId).toBe(machineCustodian.id);
        expect(software.rootLaunches).toEqual([]);
        expect(installerStarts).toBe(0);
        expect(agentStarts).toBe(0);
        return;
      }
      const encryption = mode === 'plain' ? null : { type: 'dataKey' as const, machineKey, publicKey };
      const authorStore = createCredentialedAccountArtifactStore({ token: authorToken,
        encryption: mode === 'plain' ? null : { type: 'dataKey', machineKey: authorMachineKey, publicKey: authorPublicKey } });
      recipientStore = createCredentialedAccountArtifactStore({ token: userToken, encryption });
      const base = BotTemplateReleaseV1Schema.parse({ v: 1, version: '1.1.9', changelog: '', releasedAtMs: 1,
        content: { v: 1, identity: { name: 'Received helper', description: '' }, instructions: { markdown: 'Helper' },
          memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } });
      const recipe = { pluginId: 'com.example.public-package', recipeId: 'hello', revision: '1' };
      const upstream = BotTemplateReleaseV1Schema.parse({ ...base, version: '1.1.11', content: { ...base.content,
        identity: { ...base.content.identity, name: kind === 'identity' || realRunner ? 'Updated helper' : base.content.identity.name,
          ...(kind === 'identity' || realRunner ? { face: { style: 'solid', body: 'crab', seed: 'theirs' } } : {}) },
        needs: { ...base.content.needs, software: kind === 'software' || kind === 'copy-software'
          ? [{ key: 'hello', name: 'GNU hello', purpose: 'Greet', skipConsequence: '', requirement: 'required', recipe }] : [] } } });
      const createRelease = async (store: typeof authorStore, release: typeof base) => {
        const value = { v: 1 as const, state: 'released' as const, release };
        return runWithServerHttpBaseUrl(serverUrl, () => store.create({ header: projectBotTemplateArtifactHeaderV1(value), body: JSON.stringify(value) }));
      };
      const source = await createRelease(authorStore, upstream);
      const accepted = await createRelease(recipientStore, base);
      const foreignCopySource = realRunner ? await createRelease(authorStore, base) : null;
      if (foreignCopySource) {
        await runWithServerHttpBaseUrl(serverUrl, () => authorStore.accessGrants.set({ artifactId: foreignCopySource.artifactId,
          principal: { kind: 'account', accountId: recipient.id }, accessLevel: 'view' }));
        expect(await runWithServerHttpBaseUrl(serverUrl, () => recipientStore.read(foreignCopySource.artifactId)))
          .toMatchObject({ ownerAccountId: author.id, access: 'view' });
      }
      await runWithServerHttpBaseUrl(serverUrl, () => authorStore.accessGrants.set({ artifactId: source.artifactId,
        principal: { kind: 'account', accountId: recipient.id }, accessLevel: 'view' }));
      expect(await runWithServerHttpBaseUrl(serverUrl, () => recipientStore.read(source.artifactId)))
        .toMatchObject({ ownerAccountId: author.id, access: 'view' });
      const foregroundDefinition = realRunner ? [...software.runtime.registry.contributes.agentDefinitionsById.values()]
        .find(value => value.identity.pluginId === 'acme.template-update-agent') : undefined;
      if (realRunner && !foregroundDefinition) throw new Error('Foreground authored Agent unavailable');
      const parentAgentId = foregroundDefinition?.id ?? 'codex';
      const foregroundProcess = realRunner ? await processIdentity.readProcessIdentityByPid(process.pid) : null;
      if (realRunner && !foregroundProcess) throw new Error('Physical foreground process unavailable');
      const metadata = createTestMetadata({ machineId, flavor: parentAgentId, permissionMode: 'default',
        ...(realRunner ? createSessionMetadata({ machineId, flavor: parentAgentId,
          runtimeDescriptorV1: { v: 1, agentId: parentAgentId, agent: {} },
          directory: configuration.happyHomeDir, startedBy: 'terminal', permissionMode: 'default',
          hostProcessStartTimeMs: foregroundProcess?.processStartTimeMs,
          launchControlMetadata: captureSessionLaunchControlMetadata({ processEnvironment: {} }),
        }).metadata : {}),
        ...(surface === 'agent' && kind === 'copy-software' ? { bot: { kind: 'bot' }, createdAsBot: true } : {}),
        work: { templateInstance: { v: 1,
        source: { kind: 'artifact', serverId: homeId, artifactId: source.artifactId }, acceptedVersion: '1.1.9',
        acceptedBase: { serverId: homeId, artifactId: accepted.artifactId }, skillIds: {}, mcpServerIds: {}, follow: true } } });
      const api = await ApiClient.create(software.credentials);
      api.setLocalMachineId(machineId);
      const session = await api.getOrCreateSession({ tag: crypto.randomUUID(), metadata, state: null });
      expect(session).not.toBeNull();
      if (!session) throw new Error('Recipient Session creation unavailable');
      liveSessionId = session.id;
      if (surface === 'agent') {
        // Native Account Sessions have no requester birth file. Exercise that
        // ordinary lifecycle rather than lending replay fixture-created custody.
        const ordinarySession = kind === 'copy' || kind === 'copy-software' || kind === 'identity' || kind === 'software' || kind === 'plan';
        if (!ordinarySession) credentialCustody = await createRequesterSessionCredentialCustody({ happyHomeDir: configuration.happyHomeDir,
          sessionId: session.id, attribution: { serverId: configuration.activeServerId, accountId: recipient.id, machineId, installationId },
          credentials: software.credentials, homeServerIdentityId: homeId,
          machineAdmission: { custodianAccountId: recipient.id, role: 'manage' } });
        if (realRunner) {
          restoreForegroundAgentCli = await installForegroundAgentCliFixture(software.runtime.registry, configuration.happyHomeDir);
          const attemptId = crypto.randomUUID();
          const admitted = await admitDaemonForegroundAgentRuntime({ v: 1, attemptId,
            sessionId: session.id, existingSessionId: session.id, foregroundPid: process.pid,
            directory: metadata.path, agentId: parentAgentId,
            backendTarget: { kind: 'backend', backendId: parentAgentId, sourceKind: 'built_in' } });
          expect(admitted.ok, `Foreground admission: ${admitted.ok ? 'admitted' : admitted.error.code}`).toBe(true);
          if (!admitted.ok) throw new Error(admitted.error.code);
          // The real CLI initializes/reports its canonical Session before its
          // late-environment claim. The daemon owns tracking and marker writes.
          await reportSessionToDaemonIfRunning({ sessionId: session.id, metadata, requireDaemonAck: true });
          const claimed = await claimDaemonForegroundAgentRuntimeEnvironment({
            env: { [HAPPIER_FOREGROUND_AGENT_RUNTIME_ADMISSION_FILE_ENV_KEY]: admitted.capability.admissionFilePath },
            provisionalSessionId: session.id, canonicalSessionId: session.id, attemptId, foregroundPid: process.pid,
            foregroundSatisfiedProfileSecretRequirementNames: [],
          });
          expect(claimed.ok, `Foreground claim: ${claimed.ok ? 'claimed' : claimed.error.code}`).toBe(true);
          if (!claimed.ok) throw new Error(claimed.error.code);
          foregroundRunnerBootstrap = { agentId: parentAgentId,
            bootstrapFilePath: admitted.capability.bootstrapFilePath,
            authorityFilePath: admitted.capability.authorityFilePath };
          const tracked = trackedSessionForSingleSessionProcess(trackedSessions, process.pid);
          expect(tracked).toMatchObject({ happySessionId: session.id, sessionRunnerPid: process.pid });
          const actualProcess = await processIdentity.readProcessIdentityByPid(process.pid);
          if (!actualProcess) throw new Error('Foreground process identity unavailable');
          expect(tracked?.processStartTimeMs).toBe(actualProcess.processStartTimeMs);
          expect(tracked?.processCommandHash).toBe(hashProcessCommand(actualProcess.command));
          expect(resolveSessionRunnerEntrypointIdentityFromProcessCommand(actualProcess.command).status).toBe('known');
          expect(await resolveTrackedAgentRuntimeDaemonServiceAuthority(tracked!, session.id)).not.toBeNull();
        } else {
        // These older rows supply a signed origin and runner authority. They
        // cover downstream Home/daemon replay, not foreground/bootstrap production.
        const definition = [...software.runtime.registry.contributes.agentDefinitionsById.values()]
          .find(value => value.identity.pluginId === 'acme.template-update-agent');
        if (!definition) throw new Error('Authored Session Agent was not admitted');
        await software.runtime.registry.activateContributionsOnDemand([{ ...definition.identity, family: 'agents' }]);
        const retainedAgent = software.runtime.registry.agentRuntimesByAgentId.get(definition.id)?.sessionRunnerFactoryBinding;
        if (!retainedAgent) throw new Error('Authored Session Agent did not publish its runner binding');
        const actualProcessIdentity = await processIdentity.readProcessIdentityByPid(process.pid);
        if (!actualProcessIdentity || actualProcessIdentity.processStartTimeMs === undefined)
          throw new Error('Session runner process identity unavailable');
        // Model only the OS runner command at the test-worker boundary. The
        // capability file, daemon listener, admission and Action path stay real.
        const runnerCommand = 'node /runtime/.runner-snapshots/template-update-test-runner/dist/index.mjs';
        const entrypoint = resolveSessionRunnerEntrypointIdentityFromProcessCommand(runnerCommand);
        if (entrypoint.status !== 'known') throw new Error('Fixture runner entrypoint identity unavailable');
        const readActualProcessIdentity = processIdentity.readProcessIdentityByPid;
        const identitySpy = vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockImplementation(async pid =>
          pid === process.pid ? { ...actualProcessIdentity, command: runnerCommand } : readActualProcessIdentity(pid));
        restoreRunnerIdentity = () => identitySpy.mockRestore();
        const runner = { pid: process.pid, processStartTimeMs: actualProcessIdentity.processStartTimeMs,
          processCommandHash: hashProcessCommand(runnerCommand), snapshotIdentity: entrypoint.comparableId };
        const authorityFilePath = await createAgentRuntimeDaemonServiceAuthorityPath({
          happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing });
        const authority = await publishAgentRuntimeDaemonServiceAuthority({
          happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
          path: authorityFilePath, sessionId: session.id, runner, retainedAgent,
          httpPort: software.sessionControlRuntime()!.controlPort });
        const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(runner.pid), pid: runner.pid, sessionRunnerPid: runner.pid, startedBy: 'daemon',
          happySessionId: session.id, happySessionMetadataFromLocalWebhook: metadata,
          processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash,
          runnerAgentSourceCustodyV1: retainedAgent.sourceCustody,
          runnerAgentInvocationContext: { cwd: configuration.happyHomeDir, environment: {}, providerBindingActive: false },
          agentRuntimeDaemonServiceAuthorityFilePath: authorityFilePath,
          agentRuntimeDaemonServiceCapabilityHash: authority.capabilityDigest };
        trackedSessions.set(tracked.trackingKey, tracked);
        await writeSessionMarker({ trackingKey: tracked.trackingKey, pid: runner.pid, happySessionId: session.id, startedBy: 'daemon',
          cwd: configuration.happyHomeDir, processStartTimeMs: runner.processStartTimeMs,
          processCommandHash: runner.processCommandHash, processCommand: runnerCommand,
          agentRuntimeDaemonServiceAuthorityFilePath: authorityFilePath,
          runnerAgentSourceCustodyV1: retainedAgent.sourceCustody });
        expect(await resolveTrackedAgentRuntimeDaemonServiceAuthority(tracked, session.id)).not.toBeNull();
        }
        const restoredRequester = await resolveRequesterRuntime(session.id, {
          serverId: installedServerId, accountId: recipient.id, machineId, installationId });
        if (ordinarySession) expect(restoredRequester, 'Native Account Sessions must use ordinary Account custody').toBeNull();
        else {
          expect(restoredRequester, 'Original Agent Session protected custody must be recoverable').not.toBeNull();
          expect(await restoredRequester?.isCurrent()).toBe(true);
        }
        if (kind === 'copy' || kind === 'copy-software' || kind === 'software' || kind === 'plan') {
          const backendTarget = resolveBackendTargetFromSessionMetadata(metadata);
          if (!backendTarget) throw new Error('Original Session has no canonical Agent target');
          const snapshot = await runWithServerHttpBaseUrl(serverUrl, () => bootstrapAccountSettingsContext({
            credentials: software.credentials, mode: 'blocking' }));
          parentRegistryLease = await acquireAuthoritativePluginRuntimeRegistryLease({
            controller: software.runtime.controller, happyHomeDir: software.runtime.happyHomeDir });
          const hostSession = api.sessionSyncClient(session);
          liveParent = await startMcpRequesterParent({ credentials: software.credentials, session: hostSession, sessionRow: session, api, machineId,
            snapshot, pluginRuntimeRegistryLease: parentRegistryLease, backendTarget, nativeParentSelection: true,
            ...(foregroundRunnerBootstrap ? { foregroundRunnerBootstrap } : {}),
            agentConfig: { flavor: parentAgentId, policyAgentId: parentAgentId, backendDisplayName: 'Codex',
              providerName: 'Codex', uiLogPrefix: '[Template Copy parent]', waitingForCommandLabel: 'Codex',
              agentMessageType: 'codex' } });
          expect(liveParent.mcpSession.getBackendTarget?.()).toEqual(backendTarget);
          const applied = await liveParent.readControls()?.readAppliedChildSelection?.();
          expect(applied).toMatchObject({ status: 'applied' });
        }
      }
      const readMetadata = async () => {
        const rawSession = await fetchSessionById({ token: software.credentials.token, sessionId: session.id, serverUrl, reason: 'session-action' });
        if (!rawSession) throw new Error('Recipient Session read unavailable');
        return tryDecryptSessionOwnerMetadataView({ credentials: software.credentials, accountEncryptionMode: mode, rawSession });
      };
      expect(await readMetadata()).toMatchObject({ work: { templateInstance: { acceptedVersion: '1.1.9' } } });
      const { loadSyncSingletonForTests } = await import('../../../../ui/sources/dev/testkit/harness/syncSingletonLoader');
      await loadSyncSingletonForTests();
      const { createDefaultActionExecutor } = await import('../../../../ui/sources/sync/ops/actions/defaultActionExecutor');
      const ui = createDefaultActionExecutor();
      let invokeVoice: ((actionId: 'template.instantiate' | 'template.updates.apply', input: unknown) => Promise<ActionExecuteResult>) | undefined;
      if (surface === 'voice') {
        const { setVoiceSessionSnapshot, resetVoiceSessionStoreForTests, getVoiceSessionSpokenActionConfirmation } =
          await import('../../../../ui/sources/voice/session/voiceSessionStore');
        const { createVoiceToolHandlers } = await import('../../../../ui/sources/voice/tools/handlers');
        setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'template-person-call',
          status: 'connected', mode: 'listening', canStop: true });
        resetVoiceSession = resetVoiceSessionStoreForTests;
        const handlers = createVoiceToolHandlers({ resolveSessionId: () => null, currentServerId: uiServerId,
          playHostText: async ({ text }) => {
            expect(text).toBe(getVoiceSessionSpokenActionConfirmation()?.readPending()?.operation.summary);
            voiceReadbacks++;
            return { status: 'completed' as const };
          } });
        invokeVoice = async (actionId, input) => ActionExecuteResultSchema.parse(JSON.parse(await handlers.action_execute!({ actionId, input },
          { serverId: uiServerId, effectId: `template-person-${crypto.randomUUID()}`,
            signal: new AbortController().signal, turnOrigin: 'person' })));
      }
      const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: uiServerId };
      const sessionRef = { serverId: uiServerId, sessionId: session.id };
      captured = await captureLazyActionAccountContext(uiServerId);
      const accountEncryption = await captured.resolveAccountEncryption();
      expect(accountEncryption.accountMode).toBe(mode);
      if (surface === 'voice') {
        const storedSettings = await captured.readSettings();
        const liveSettings = captured.readLiveSettings();
        expect(captured.credentialAuthorityKind, 'Voice requires the installed Account credential').toBe('account');
        expect(storedSettings.voice.canApproveRequests,
          'The Voice Action must consume the Account setting enabled through Home').toBe(true);
        expect(liveSettings?.voice.canApproveRequests ?? storedSettings.voice.canApproveRequests,
          `The Voice Action must use the enabled setting (live=${liveSettings?.voice.canApproveRequests ?? 'absent'})`).toBe(true);
      }
      if (mode === 'e2ee') expect(accountEncryption.encryption?.getContentPrivateKey()).toHaveLength(32);
      if (kind === 'pat-setup') {
        const reviewedSetupChild = 'reviewedSetupChild' in scenario;
        const protectedPat = 'protectedPat' in scenario;
        const keylessPat = 'keylessPat' in scenario;
        const denied = 'denied' in scenario ? scenario.denied : undefined;
        const grant = ApiTokenGrantV1Schema.parse('unrestrictedPat' in scenario && scenario.unrestrictedPat ? API_TOKEN_FULL_GRANT_V1 : { ...API_TOKEN_FULL_GRANT_V1,
          actions: { families: [], ids: [SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action,
            ...(denied === 'missing-grant' || denied === 'missing-child-grant' ? [] : [SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action]),
            ...(reviewedSetupChild ? ['session.spawn_new'] : [])] },
          targets: { sessions: [], machines: [machineId] }, approve: false });
        const patTokenId = crypto.randomUUID();
        const patWrappingSecret = crypto.getRandomValues(new Uint8Array(32));
        const pat = await auth.createApiToken({ accountId: recipient.id, tokenId: patTokenId,
          label: 'Ordinary Machine setup requester', grant,
          ...(mode === 'e2ee' ? { encryption: createPatEncryption(patTokenId, patWrappingSecret) } : {}) });
        const protectedCredential = protectedPat ? formatAccountApiTokenCredentialV1({ bearer: pat.token,
          wrappingSecret: encodeBase64(patWrappingSecret, 'base64url'), serverIdentityId: homeId,
          accountId: recipient.id, contentPublicKey: encodeBase64(publicKey) }) : null;
        const post = async (actionId: string, input: unknown, expectedStatus = 200) => {
          if (protectedCredential) {
            const client = connect({ endpoint: software.controlHttpOrigin()!, token: protectedCredential });
            try {
              const machine = client.machine(machineId);
              const result = actionId === SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action
                ? await machine.actions.machines.setup.plan(MachineSetupCombinedPlanInputV1Schema.parse(input))
                : await machine.actions.machines.setup.apply(MachineSetupApplyInputV1Schema.parse(input));
              return { execution: { ok: true, result } };
            } finally { await client.close(); }
          }
          const response = await fetch(`${software.controlHttpOrigin()}/v1/actions/${actionId}`, {
            method: 'POST', headers: { authorization: `Bearer ${pat.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId }, input }),
          });
          const output: unknown = await response.json();
          expect(response.status, JSON.stringify(output)).toBe(expectedStatus);
          return output;
        };
        if (denied === 'foreign-machine') {
          const foreignPlanInput = { homeId, machineId,
            targets: [{ homeId, machineId, sources: software.sources, mode: 'effects' }] };
          // The author-installed daemon accepts only its own Account's PATs.
          expect(await post(SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action,
            foreignPlanInput, 401)).toMatchObject({ error: 'invalid_token' });
          // Home authenticates the recipient PAT itself, then refuses admission
          // to the author's Machine without disclosing its access state.
          const mint = await app.inject({ method: 'POST',
            url: `/v1/actions/${SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action}/execution-authorization`,
            headers: { authorization: `Bearer ${pat.token}` },
            payload: { v: 1, machineId, envelope: { v: 1, requestId: crypto.randomUUID(),
              target: { kind: 'machine', machineId }, input: foreignPlanInput } } });
          expect(mint.statusCode, mint.payload).toBe(409);
          expect(mint.json()).toMatchObject({ error: 'invalid_request', code: 'target_unavailable' });
          expect(installerStarts).toBe(0);
          expect(admittedRunIds).toEqual([]);
          return;
        }
        const planned = await post(SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action,
          { homeId, machineId, targets: [{ homeId, machineId, sources: software.sources, mode: 'effects' }] });
        expect(planned, JSON.stringify(planned)).toMatchObject({ execution: { ok: true } });
        const plan = MachineSetupCombinedPlanResultV1Schema.parse(Reflect.get(Reflect.get(planned as object, 'execution'), 'result'));
        const target = plan.targets.find(value => value.machineId === machineId && 'plan' in value);
        if (!target || !('plan' in target)) throw new Error('Ordinary PAT Setup Plan did not resolve the selected Machine');
        const applyInput = MachineSetupApplyInputV1Schema.parse({ homeId, machineId,
          targets: [machineSetupApplyTargetFromPlanV1({ homeId, machineId }, target.plan)] });
        if (denied === 'missing-grant') {
          expect(await post(SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action, applyInput, 403))
            .toMatchObject({ error: 'credential_scope_denied' });
          expect(installerStarts).toBe(0);
          expect(admittedRunIds).toEqual([]);
          return;
        }
        const proposalActionId = reviewedSetupChild ? 'session.spawn_new' : SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action;
        const { projectSessionSpawnNewApiRequest } = await import('@happier-dev/protocol/actions/specs/session/lifecycle');
        const artifactCountBeforeProposal = await db.artifact.count({ where: { accountId: recipient.id } });
        const proposed = await post(proposalActionId, reviewedSetupChild ? projectSessionSpawnNewApiRequest({
          creationKey: crypto.randomUUID(), executionTarget: { serverId: homeId, machineId },
          directory: { kind: 'managed' }, memoryEnabled: false,
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
          connectedServices: { v: 2, bindingsByServiceId: {} },
          machineSetupPlanInput: { homeId, machineId, sources: software.sources },
        }).input : applyInput);
        if (keylessPat) {
          expect(proposed, 'A raw PAT cannot supply E2EE content access for approval').toMatchObject({
            execution: { ok: false, errorCode: 'content_unavailable' },
          });
          expect(await db.artifact.count({ where: { accountId: recipient.id } })).toBe(artifactCountBeforeProposal);
          expect(installerStarts).toBe(0);
          expect(admittedRunIds).toEqual([]);
          return;
        }
        expect(proposed, JSON.stringify(proposed)).toMatchObject({ execution: { ok: true, result: {
          kind: 'approval_request_created', actionId: proposalActionId,
          artifactId: expect.any(String) } } });
        const card = ActionApprovalRequestCreatedResultSchema.parse(Reflect.get(Reflect.get(proposed as object, 'execution'), 'result'));
        const stored = await runWithServerHttpBaseUrl(serverUrl, () => recipientStore!.read(card.artifactId));
        const approval = ApprovalRequestV2Schema.parse(JSON.parse(stored!.body as string));
        const originalRoot = approval.executionOriginV1.externalActionExecutionAuthorization;
        expect(originalRoot?.binding).toMatchObject({ credentialId: patTokenId, accountId: recipient.id,
          machineId, installationId, admittedMachineRole: 'manage', grant });
        if (!originalRoot || !('principalId' in originalRoot.binding)) throw new Error('Expected original PAT root');
        approvalRootToken = originalRoot!.token;
        expect(admittedRunIds).toEqual([]);
        expect(claimedRunIds).toEqual([]);
        expect(installerStarts).toBe(0);
        const homeRequestsBeforeDecision = httpOutcomes.length;
        if (denied === 'missing-child-grant') {
          await ui.executeConfirmed('approval.request.decide', { artifactId: card.artifactId, decision: 'approve' }, context);
          const settled = await runWithServerHttpBaseUrl(serverUrl, () => recipientStore!.read(card.artifactId));
          expect(ApprovalRequestV2Schema.parse(JSON.parse(settled!.body as string)))
            .toMatchObject({ execution: { ok: false, errorCode: 'credential_scope_denied' } });
          expect(installerStarts).toBe(0);
          expect(admittedRunIds).toEqual([]);
          return;
        }
        if (denied === 'revoked-root') {
          await auth.revokeApiToken({ accountId: recipient.id, tokenId: patTokenId });
          await ui.executeConfirmed('approval.request.decide', { artifactId: card.artifactId, decision: 'approve' }, context);
          const settled = await runWithServerHttpBaseUrl(serverUrl, () => recipientStore!.read(card.artifactId));
          expect(ApprovalRequestV2Schema.parse(JSON.parse(settled!.body as string)))
            .toMatchObject({ execution: { ok: false, errorCode: 'approval_stale' } });
          expect(installerStarts).toBe(0);
          expect(admittedRunIds).toEqual([]);
          return;
        }
        const deciding = ui.executeConfirmed('approval.request.decide', { artifactId: card.artifactId,
          decision: 'approve' }, context);
        const stoppedBeforeInstall = workflowWake?.then(async () => {
          const coordinatorResult = await software.waitForWorkflowCoordinator();
          throw new Error(`PAT Setup worker settled before installer: ${JSON.stringify({
            state: coordinatorResult?.state, reason: coordinatorResult?.reason,
            workflow: software.workflowDiagnostic(),
          })}`);
        });
        void stoppedBeforeInstall?.catch(() => {});
        if (reviewedSetupChild) {
          await Promise.race([installerStarted, ...(stoppedBeforeInstall ? [stoppedBeforeInstall] : []), deciding.then(result => {
            throw new Error(`Reviewed PAT Setup decision settled before installer: ${JSON.stringify({ result, httpOutcomes, nativeExecutions })}`);
          })]);
        } else {
          // Direct Apply returns its admitted Run before the worker finishes.
          const directDecision = await deciding;
          expect(directDecision, JSON.stringify({ directDecision,
            refusals: httpOutcomes.slice(homeRequestsBeforeDecision).filter(value => value.status >= 400),
            admittedRunIds, claimedRunIds, installerStarts })).toMatchObject({ ok: true, result: { status: 'executed', execution: {
            ok: true, result: { operationId: expect.any(String), runId: expect.any(String) },
          } } });
          await Promise.race([installerStarted, ...(stoppedBeforeInstall ? [stoppedBeforeInstall] : [])]);
        }
        releaseInstaller();
        const decided = await deciding;
        expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed',
          execution: { ok: true } } });
        await software.waitForWorkflowCoordinator();
        expect(admittedRunIds).toHaveLength(1);
        expect(claimedRunIds).toEqual(admittedRunIds);
        expect(await software.readInstalled()).toMatchObject({ installed: true, effects: ['apt-get'] });
        expect(agentStarts).toBe(reviewedSetupChild ? 1 : 0);
        const verifiedAt = expectSignedPatSettlement(homeRequestsBeforeDecision, proposalActionId, card.artifactId);
        const settlements = httpOutcomes.slice(verifiedAt + 1).filter(value => value.url === `/v1/artifacts/${card.artifactId}`
          && value.method === 'POST');
        expect(settlements.length).toBeGreaterThan(0);
        expect(settlements.every(value => value.usedOriginalPatRoot && !value.hasAuthorizationBearer),
          'Setup replay settlement must retain the original signed PAT, without any Account or raw PAT bearer').toBe(true);
        expect(nativeExecutions.filter(value => value.actionId === SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action))
          .toHaveLength(1);
        expect(nativeInvocationFacts.filter(value => value.actionId === SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action))
          .toEqual([expect.objectContaining({ principalAccountId: recipient.id,
            principalId: originalRoot.binding.principalId, credentialId: patTokenId })]);
        expect(nativeInvocationFacts.every(value => value.bindingAuthKind === undefined)).toBe(true);
        return;
      }
      if (kind === 'spawn') {
        const artifactCount = await db.artifact.count({ where: { accountId: recipient.id } });
        const spawnInput = {
          creationKey: crypto.randomUUID(), executionTarget: { serverId: uiServerId, machineId },
          directory: { kind: 'managed' }, memoryEnabled: false,
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
          connectedServices: { v: 2, bindingsByServiceId: {} },
          machineSetupPlanInput: { homeId, machineId, sources: software.sources },
        };
        const review = await ui.prepare('session.spawn_new', spawnInput, context, { reviewOnly: true });
        expect(review.kind, JSON.stringify(review)).toBe('ready');
        if (review.kind === 'ready') expect(review.operation?.normalizedInput).toMatchObject({
          machineSetupPlanInput: spawnInput.machineSetupPlanInput,
        });
        const applying = ui.executeConfirmed('session.spawn_new', spawnInput, context);
        await Promise.race([workflowWake?.then(() => installerStarted) ?? installerStarted, applying.then(result => {
          settledResult = result;
          throw new Error(`Ordinary spawn settled before installer terminal: ${JSON.stringify({ result, httpOutcomes, nativeExecutions })}`);
        })]);
        expect(agentStarts).toBe(0);
        releaseInstaller();
        const result = await applying;
        await software.waitForWorkflowCoordinator();
        if (sharedSpawn) {
          const signedApplies = nativeExecutions.filter(value => value.actionId === 'machines.setup.apply');
          expect(signedApplies).toHaveLength(1);
          expect(signedApplies[0]).toMatchObject({ execution: { ok: true,
            result: { operationId: expect.any(String) } } });
          expect(software.workflowDiagnostic()).toMatchObject({ coordinateState: 'succeeded',
            rootResults: [{ status: 'applied', completedStepIds: ['hello'] }] });
          expect(await software.readInstalled()).toMatchObject({ installed: true, effects: ['apt-get'] });
          expect(admittedRunIds).toHaveLength(1);
          expect(claimedRunIds).toEqual(admittedRunIds);
          expect(await db.automationRun.findUniqueOrThrow({ where: { id: claimedRunIds[0]! } }))
            .toMatchObject({ accountId: recipient.id, state: 'succeeded', workflowCustodyState: 'settled' });
        } else {
          const operations = await software.operations.handlers.listV2({}, software.context('machines.setup.apply'));
          const nativeSetupOperation = operations.items.find(value => value.domainRef?.kind === 'machineSetup');
          expect(nativeSetupOperation).toMatchObject({ state: installFails ? 'failed' : 'succeeded' });
          // Startup consumes the terminal Apply receipt and its typed native failure.
          const setupOperations = operations.items.filter(value => value.actionId === 'machines.setup.apply' && !value.domainRef);
          expect(setupOperations).toHaveLength(1);
          const setupOperation = setupOperations[0];
          expect(setupOperation).toMatchObject(installFails
            ? { state: 'failed', error: { errorCode: 'native_effect_failed', failureCause: {
                phase: 'dispatch', errorClass: 'RpcError', errorCode: 'native_effect_failed', httpStatus: null } } }
            : { state: 'succeeded' });
          if (installFails) {
            const nativeFailure = { kind: 'machineSetup', failure: { kind: 'native_effect_failed',
              reason: 'native_effect_failed', phase: 'apply', remedy: expect.stringMatching(/\S/),
              nativeCommand: { command: 'apt-get', phase: 'install', exitCode: 1, category: 'command_failed' } } };
            expect(nativeSetupOperation).toMatchObject({ error: { errorCode: 'native_effect_failed', details: nativeFailure } });
            expect(setupOperation).toMatchObject({ error: { details: nativeFailure } });
            expect(result).toMatchObject({ ok: false, errorCode: 'native_effect_failed', details: nativeFailure });
          }
        }
        expect(result, JSON.stringify({ result, nativeExecutions })).toMatchObject(installFails
          ? { ok: false, errorCode: 'native_effect_failed' }
          : { ok: true, result: { type: 'success', sessionId: expect.any(String) } });
        expect(agentStarts).toBe(installFails ? 0 : 1);
        // One native confirmation above; setup creates no extra approval.
        expect(await db.artifact.count({ where: { accountId: recipient.id } })).toBe(artifactCount);
        expect(nativeExecutions.filter(value => value.actionId === 'session.spawn_new')).toHaveLength(1);
        expect(software.rootLaunches).toHaveLength(1);
        expect((await db.machine.findUniqueOrThrow({ where: { id: machineId } })).accountId).toBe(machineCustodian.id);
        return;
      }
      const { ensureSessionDisplayProjectionsForRead } = await import('../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority');
      expect(await ensureSessionDisplayProjectionsForRead({ serverId: uiServerId, credentials: captured.credentials,
        request: captured.request, sessionIds: [session.id], isCurrent: captured.accountLifetime.isCurrent })).toBe(true);
      const invokeAgent = async (actionId: 'template.instantiate' | 'template.updates.apply' | typeof SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action, input: unknown) => {
        const tracked = trackedSessionForSingleSessionProcess(trackedSessions, process.pid);
        if (!tracked?.agentRuntimeDaemonServiceAuthorityFilePath) throw new Error('Original Agent runner authority missing');
        const previousAuthorityPath = process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
        process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE = tracked.agentRuntimeDaemonServiceAuthorityFilePath;
        const fixtureWitness = { turnId: 'template-update-turn', inputId: 'template-update-input', userMessageSeq: 1, userMessageSeqs: [1],
          callerPermissionMode: 'default' as const,
          causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' as const },
          agentStartCaller: { kind: 'session' as const, sessionId: session.id, starterDepth: 0, turnDepth: 0 } };
        const witness = liveParent ? liveParent.mcpSession.getActiveTurnAdmissionWitness?.() : fixtureWitness;
        if (!witness) throw new Error('Copy requires the host-admitted caller turn');
        const runnerAuthority = await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
          happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
          path: tracked.agentRuntimeDaemonServiceAuthorityFilePath, expectedSessionId: session.id });
        expect(runnerAuthority, 'Original Agent runner authority must pass OS identity').not.toBeNull();
        if (!runnerAuthority) throw new Error('Original Agent runner authority unavailable');
        if (!realRunner) {
        const admitted = await dispatchCurrentAgentRuntimeDaemonServiceRequest({ authority: {
          happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
          path: tracked.agentRuntimeDaemonServiceAuthorityFilePath, sessionId: session.id,
          runner: runnerAuthority.runner, retainedAgent: runnerAuthority.retainedAgent },
          createRequest: capability => ({ v: 1, context: { token: capability, sessionId: session.id },
            operation: { kind: 'turn.admission.authorize', requestId: crypto.randomUUID(),
              witness: projectAgentRuntimeDaemonServiceTurnWitnessV1(witness) } }),
        });
        expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true, result: { kind: 'turn.admission', status: 'admitted' } });
        }
        if (liveParent) {
          expect(liveParent.mcpSession.getBackendTarget?.()).toEqual(resolveBackendTargetFromSessionMetadata(metadata));
          await vi.waitFor(async () => {
            const selection = await liveParent?.mcpSession.getSessionRoleContext?.().readAppliedChildSelection?.();
            expect(selection).toMatchObject({ status: 'applied' });
          }, { timeout: 15_000 });
        }
        const runtime = createHappierMcpServer({ sessionId: session.id, updateMetadata() {},
          getServerBinding: () => ({ serverId: installedServerId, serverUrl }),
          getServerFeaturesSnapshot: () => ({ status: 'ready' as const, provenance: 'authenticated' as const, features: featurePayload }),
          getMetadataSnapshot: () => metadata, getWorkDepth: () => 0, getHostTurnWorkDepth: () => 0,
          ...(liveParent ? { getBackendTarget: () => liveParent.mcpSession.getBackendTarget?.() ?? null,
            getPermissionMode: () => liveParent.mcpSession.getPermissionMode?.() ?? null,
            getSessionRoleContext: () => liveParent.mcpSession.getSessionRoleContext!(),
            readRoleSources: (...args: Parameters<NonNullable<typeof liveParent.mcpSession.readRoleSources>>) =>
              liveParent.mcpSession.readRoleSources!(...args) } : {}),
          getActiveTurnAdmissionWitness: () => liveParent
            ? liveParent.mcpSession.getActiveTurnAdmissionWitness?.() ?? null : fixtureWitness,
          getActiveTurnPermissionWitness: () => liveParent
            ? liveParent.mcpSession.getActiveTurnPermissionWitness?.() ?? null : fixtureWitness,
        }, { authorityScope: 'session', credentials: null,
          sessionCredentials: { token: installedToken, encryption: null },
          accountSettings: AccountSettingsSchema.parse({ actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
            actions: { 'template.instantiate': { toolExposureModes: { agent: 'direct' } },
              'template.updates.apply': { toolExposureModes: { agent: 'direct' } } },
          }) }) });
        const client = new Client({ name: 'template-recipient-agent', version: '1' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        try {
          await runtime.mcp.connect(serverTransport);
          await client.connect(clientTransport);
          if (kind === 'copy-software') {
            const response = await runtime.executeTool({ toolName: 'action_execute', toolCallId: crypto.randomUUID(),
              args: { actionId, input } });
            expect(response, JSON.stringify(response)).toMatchObject({ ok: true });
            if (!response.ok) throw new Error(response.errorCode);
            return ActionApprovalRequestCreatedResultSchema.parse(response.result);
          }
          const response = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: { actionId, input } }));
          expect(response.isError, JSON.stringify(response)).not.toBe(true);
          const block = response.content.find(value => value.type === 'text');
          if (!block || block.type !== 'text') throw new Error('Agent Action tool returned no result');
          return ActionApprovalRequestCreatedResultSchema.parse(JSON.parse(block.text));
        } finally {
          await client.close();
          await runtime.mcp.close();
          if (previousAuthorityPath === undefined) delete process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE;
          else process.env.HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE = previousAuthorityPath;
        }
      };
      if (kind === 'plan') {
        if (!liveParent) throw new Error('Plan continuation requires its real native parent');
        liveParent.submitUserPrompt('Plan the GNU hello setup.');
        await vi.waitFor(() => expect(liveParent?.mcpSession.getActiveTurnAdmissionWitness?.()).toBeTruthy(), { timeout: 15_000 });
        const proposed = await invokeAgent(SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action,
          { homeId, machineId, sources: software.sources, mode: 'effects' });
        liveParent.completeCurrentTurn();
        await vi.waitFor(() => expect(liveParent?.mcpSession.getActiveTurnAdmissionWitness?.()).toBeFalsy(), { timeout: 15_000 });
        expect(liveParent.readProviderInputs()).toHaveLength(1);
        const replayed = await ui.executeConfirmed('approval.request.decide', {
          artifactId: proposed.artifactId, decision: 'approve',
        }, { ...context, callerPermissionMode: 'yolo' });
        const approved = ApprovalRequestV2Schema.parse(JSON.parse((await runWithServerHttpBaseUrl(serverUrl,
          () => recipientStore.read(proposed.artifactId)))!.body as string));
        expect(approved.status, JSON.stringify({ replayed,
          httpFailures: httpOutcomes.filter(value => value.status >= 400), rpcDeliveryFailures })).toBe('executed');
        expect(approved.execution).toMatchObject({ ok: true });
        expect(replayed, JSON.stringify({ replayed, httpFailures: httpOutcomes.filter(value => value.status >= 400), rpcDeliveryFailures }))
          .toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
        const plan = MachineSetupPlanResultV1Schema.parse(approved.execution?.result);
        expect(plan.review?.target.machineId).toBe(machineId);
        expect(installerStarts).toBe(0);
        await vi.waitFor(() => expect(liveParent?.readProviderInputs(),
          'A recorded approved Plan result must reach the ended-turn parent as a new input').toHaveLength(2), { timeout: 15_000 });
        const input = liveParent.readProviderInputs()[1];
        expect(input.delivery.turnId).not.toBe(liveParent.readProviderInputs()[0].delivery.turnId);
        expect(JSON.stringify(input)).toContain(proposed.artifactId);
        expect(JSON.stringify(input)).toContain('hello');
        expect(JSON.stringify(input).includes(userToken) || JSON.stringify(input).includes(installedToken)).toBe(false);
        const delivered = await db.sessionMessage.findUniqueOrThrow({ where: {
          sessionId_localId: { sessionId: session.id, localId: `approval-result:${proposed.artifactId}` },
        } });
        const content = SessionStoredMessageContentEnvelopeSchema.parse(delivered.content);
        if (content.t !== 'plain' || !content.v || typeof content.v !== 'object') {
          throw new Error('Plain Plan result must retain its original content envelope');
        }
        const meta: unknown = Reflect.get(content.v, 'meta');
        expect(readSessionInputRequest(meta, 'stored')).toBeNull();
        const authority = readSessionInputAuthority(meta, 'stored');
        expect(authority).toMatchObject({
          v: 1, producer: 'happierMcp', caller: { kind: 'host' },
        });
        expect(authority?.permission).toEqual({ admittedPermissionCeiling: 'default' });
        expect(readSessionMessageProvenance(meta, 'stored')).toEqual({ v: 1, kind: 'host', producer: 'happierMcp' });
        expect(liveParent.mcpSession.getActiveTurnAdmissionWitness?.()).toBeTruthy();
        const repeated = await ui.executeConfirmed('approval.request.decide', {
          artifactId: proposed.artifactId, decision: 'approve',
        }, { ...context, callerPermissionMode: 'yolo' });
        expect(repeated, JSON.stringify(repeated)).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(liveParent.readProviderInputs()).toHaveLength(2);
        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(0);
        return;
      }
      if (kind === 'copy' || kind === 'copy-software' || realRunner) {
        const actionServerId = surface === 'agent' || surface === 'pat' ? homeId : uiServerId;
        const r18Pat = 'r18Pat' in scenario ? scenario.r18Pat : undefined;
        const copiedArtifact = foreignCopySource ?? source;
        const copiedRelease = realRunner ? base : upstream;
        const copyInput = {
          source: { kind: 'artifact', serverId: actionServerId, artifactId: copiedArtifact.artifactId },
          expectedVersion: copiedRelease.version,
          expectedRevision: copiedArtifact.revision,
          setup: { software: kind === 'copy-software'
            ? [{ key: 'hello', selection: { action: 'install' as const, inputs: {} } }] : [], accounts: [], mcpServers: [] },
          creation: { creationKey: crypto.randomUUID(), executionTarget: { serverId: actionServerId, machineId },
            directory: { kind: 'managed' },
            ...(surface === 'agent' || r18Pat ? { manager: { sessionId: session.id } } : {}),
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            memoryEnabled: false,
            ...(r18Pat || surface === 'agent' && kind === 'copy-software' ? { modelSelection: { v: 1 as const,
              ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null,
                modelId: 'gpt-6-luna' }, updatedAt: Date.now() } } : {}),
            ...(r18Pat ? { connectedServices: { v: 2 as const, bindingsByServiceId: {
                'happier.agent.codex/openai-codex': { source: 'native' as const },
              } } } : {}) },
        } as const;
        if (surface === 'pat') {
          const protectedPat = 'protectedPat' in scenario;
          const keylessPat = 'keylessPat' in scenario;
          const denied = 'denied' in scenario ? scenario.denied : undefined;
          const grant = ApiTokenGrantV1Schema.parse(r18Pat === 'unrestricted' ? API_TOKEN_FULL_GRANT_V1 : { ...API_TOKEN_FULL_GRANT_V1,
            actions: { families: [], ids: kind === 'copy-software'
              ? [BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1,
                ...(r18Pat ? ['template.updates.apply', 'action.operations.get'] : []),
                ...(r18Pat === 'scoped-manager-input' ? ['session.message.send'] : []),
                ...(denied === 'missing-plan-grant' ? [] : [SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action]),
                ...(denied === 'missing-apply-grant' ? [] : [SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action])]
              : [BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1] },
            targets: { sessions: r18Pat === 'scoped-manager' || r18Pat === 'scoped-manager-input'
              ? [session.id] : [], machines: [machineId] }, approve: false });
          const patTokenId = crypto.randomUUID();
          const patWrappingSecret = crypto.getRandomValues(new Uint8Array(32));
          const pat = await auth.createApiToken({ accountId: recipient.id, tokenId: patTokenId,
            label: 'Composed Machine setup requester', grant,
            ...(mode === 'e2ee' ? { encryption: createPatEncryption(patTokenId, patWrappingSecret) } : {}) });
          if (r18Pat) diagnosticPatBearer = pat.token;
          const homeRequestsBefore = httpOutcomes.length;
          const sessionsBeforeRequest = await db.session.count({ where: { accountId: recipient.id } });
          const artifactIdsBeforeRequest = new Set((await db.artifact.findMany({ where: { accountId: recipient.id },
            select: { id: true } })).map(value => value.id));
          const assertNoCopyEffects = async (expectedNewArtifactIds: string[]) => {
            const newArtifactIds = (await db.artifact.findMany({ where: { accountId: recipient.id }, select: { id: true } }))
              .map(value => value.id).filter(id => !artifactIdsBeforeRequest.has(id)).sort();
            expect({ bornSessions: await db.session.count({ where: { accountId: recipient.id } }) - sessionsBeforeRequest,
              newArtifactIds, installerStarts, admittedRunIds, claimedRunIds, agentStarts,
              nativeApplyCount: nativeInvocationFacts.filter(value => value.actionId ===
                SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action).length }).toEqual({
              bornSessions: 0, newArtifactIds: [...expectedNewArtifactIds].sort(), installerStarts: 0,
              admittedRunIds: [], claimedRunIds: [], agentStarts: 0, nativeApplyCount: 0,
            });
          };
          const protectedResult = protectedPat ? await (async () => {
            const credential = formatAccountApiTokenCredentialV1({ bearer: pat.token,
              wrappingSecret: encodeBase64(patWrappingSecret, 'base64url'), serverIdentityId: homeId,
              accountId: recipient.id, contentPublicKey: encodeBase64(publicKey) });
            const client = connect({ endpoint: software.controlHttpOrigin()!, token: credential });
            try { return await client.machine(machineId).actions.template.instantiate(BotTemplateInstantiateInputV1Schema.parse(copyInput)); }
            finally { await client.close(); }
          })() : null;
          const publicResponse = protectedPat ? null : await fetch(`${software.controlHttpOrigin()}/v1/actions/${BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1}`, {
            method: 'POST', headers: { authorization: `Bearer ${pat.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId }, input: copyInput }),
          });
          const publicResult: unknown = protectedPat ? { execution: { ok: true, result: protectedResult } } : await publicResponse!.json();
          const initialExecution = publicResult && typeof publicResult === 'object' && 'execution' in publicResult
            ? publicResult.execution : null;
          if (r18Pat === 'scoped' || r18Pat === 'scoped-manager') {
            expect(publicResponse?.status, JSON.stringify(publicResult)).toBe(200);
            expect(publicResult, JSON.stringify(publicResult)).toMatchObject({ execution: {
              ok: false, errorCode: 'credential_scope_denied',
              details: { actionId: 'session.message.send' },
            } });
            await assertNoCopyEffects([]);
            expect(httpOutcomes.slice(homeRequestsBefore).filter(value =>
              value.method === 'POST' && value.url === '/v1/sessions')).toEqual([]);
            return;
          }
          if (keylessPat) {
            expect(publicResponse?.status, JSON.stringify(publicResult)).toBe(200);
            expect(publicResult, 'A raw PAT cannot supply E2EE content access for approval')
              .toMatchObject({ execution: { ok: false, errorCode: 'content_unavailable' } });
            await assertNoCopyEffects([]);
            return;
          }
          if ((denied === 'missing-plan-grant' || denied === 'missing-apply-grant') && publicResult
            && initialExecution && typeof initialExecution === 'object' && 'ok' in initialExecution
            && initialExecution.ok === false) {
            expect(publicResult, JSON.stringify(publicResult)).toMatchObject({ execution: {
              ok: false, errorCode: 'credential_scope_denied',
            } });
            await assertNoCopyEffects([]);
            return;
          }
          if (!protectedPat) expect(publicResponse?.status, JSON.stringify({ publicResult, phaseFailures })).toBe(200);
          expect(publicResult).toMatchObject({ execution: { ok: true, result: {
            kind: 'approval_request_created', actionId: BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1,
            artifactId: expect.any(String) } } });
          const publicExecution = Reflect.get(publicResult as object, 'execution') as object;
          const parentCard = ActionApprovalRequestCreatedResultSchema.parse(Reflect.get(publicExecution, 'result'));
          const parentStored = await runWithServerHttpBaseUrl(serverUrl, () => recipientStore.read(parentCard.artifactId));
          const parentApproval = ApprovalRequestV2Schema.parse(JSON.parse(parentStored!.body as string));
          expect(parentApproval).toMatchObject({ actionId: BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 });
          const originalRoot = parentApproval.executionOriginV1.externalActionExecutionAuthorization;
          expect(originalRoot?.binding).toMatchObject({ accountId: recipient.id, principalId: recipient.id,
            credentialId: patTokenId, grant, admittedMachineRole: 'manage' });
          if (mode === 'plain' && kind === 'copy') {
            expect(parentApproval.executionOriginV1.originalActionEnvelope).toMatchObject({
              v: 1,
              target: { kind: 'machine', machineId }, input: copyInput,
            });
          }
          if (!originalRoot || !('principalId' in originalRoot.binding)) throw new Error('Expected original PAT Copy root');
          approvalRootToken = originalRoot.token;
          expect(installerStarts).toBe(0);
          expect(admittedRunIds).toEqual([]);
          expect(agentStarts).toBe(0);
          const homeRequestsBeforeDecision = httpOutcomes.length;
          const replaying = executeOriginalAccountMachineAction({ account: captured!, actionId: 'approval.request.decide', machineId,
            requestId: `approve-${crypto.randomUUID()}`, input: { artifactId: parentCard.artifactId, decision: 'approve' } });
          if (denied === 'missing-plan-grant' || denied === 'missing-apply-grant') {
            const first = await Promise.race([installerStarted.then(() => 'installer' as const),
              replaying.then(() => 'replay' as const)]);
            if (first === 'installer') releaseInstaller();
          }
          if (kind === 'copy-software' && !denied && !('adminAccessDisabled' in scenario) && !(r18Pat
            && (r18Pat !== 'unrestricted' && r18Pat !== 'scoped-manager-input' || mode === 'e2ee' && !protectedPat))) {
            await Promise.race([workflowWake?.then(() => installerStarted) ?? installerStarted, replaying.then(result => {
              throw new Error(`Scoped PAT Template Copy settled before installer terminal: ${JSON.stringify({ result, httpOutcomes, nativeExecutions })}`);
            })]);
            expect(agentStarts).toBe(0);
            releaseInstaller();
          }
          const replayed = await replaying;
          if ('adminAccessDisabled' in scenario) {
            const failure = { errorCode: 'mode_none',
              error: expect.stringMatching(/administrator access is disabled/i) };
            expect(replayed, JSON.stringify(replayed)).toMatchObject({ ok: true, result: {
              status: 'failed', execution: { ok: false, ...failure },
            } });
            const stored = await runWithServerHttpBaseUrl(serverUrl, () => recipientStore.read(parentCard.artifactId));
            expect(ApprovalRequestV2Schema.parse(JSON.parse(stored!.body as string))).toMatchObject({
              status: 'failed', execution: { ok: false, ...failure },
            });
            await software.waitForWorkflowCoordinator();
            const operations = await software.operations.handlers.listV2({}, software.context('machines.setup.apply'));
            expect(operations.items.find(value => value.domainRef?.kind === 'machineSetup')).toMatchObject({
              state: 'failed', error: failure,
            });
            expect(await software.readInstalled()).toMatchObject({ installed: false, effects: [] });
            expect(installerStarts).toBe(0);
            expect(agentStarts).toBe(0);
            expect(nativeInvocationFacts.filter(value => value.actionId === SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action))
              .toContainEqual(expect.objectContaining({ principalAccountId: recipient.id, principalId: recipient.id,
                credentialId: patTokenId }));
            return;
          }
          if (r18Pat) {
            const sessionBirths = httpOutcomes.slice(homeRequestsBeforeDecision).filter(value =>
              value.method === 'POST' && value.url === '/v1/sessions');
            expect(sessionBirths, JSON.stringify({ sessionBirths, replayed })).toContainEqual(
              expect.objectContaining({ status: 200, usedOriginalPatRoot: true,
                hasAuthorizationBearer: false, signedEffectAdmitted: true }));
          }
          if (denied === 'missing-plan-grant' || denied === 'missing-apply-grant') {
            expect(replayed, JSON.stringify(replayed)).toMatchObject({ ok: true, result: { status: 'failed', execution: {
              ok: false, errorCode: 'credential_scope_denied',
            } } });
            await assertNoCopyEffects([parentCard.artifactId]);
            return;
          }
          expect(replayed, JSON.stringify(replayed)).toMatchObject({ ok: true, result: { status: 'executed', execution: {
            ok: true, result: { type: 'success', sessionId: expect.any(String) } } } });
          const createdSessionId = Reflect.get(Reflect.get(Reflect.get(replayed, 'result'), 'execution'), 'result') as { sessionId: string };
          expect(await fetchSessionById({ token: userToken, sessionId: createdSessionId.sessionId, serverUrl,
            reason: 'session-action' })).not.toBeNull();
          if (kind === 'copy-software') {
            await software.waitForWorkflowCoordinator();
            expect(admittedRunIds).toHaveLength(1);
            expect(claimedRunIds).toEqual(admittedRunIds);
            expect(await software.readInstalled()).toMatchObject({ installed: true, effects: ['apt-get'] });
            expect(nativeExecutions.filter(value => value.actionId === SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action))
              .toHaveLength(1);
            expect(nativeInvocationFacts.filter(value => value.actionId === SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action))
              .toEqual([expect.objectContaining({ principalAccountId: recipient.id,
                principalId: originalRoot.binding.principalId, credentialId: patTokenId })]);
            const admissions = httpOutcomes.slice(homeRequestsBeforeDecision).filter(value =>
              value.url === WORKFLOW_RUN_STORAGE_HTTP_PATH && value.workflowOperation === 'admit');
            expect(admissions).toHaveLength(1);
            expect(admissions[0]).toMatchObject({ status: 200, usedOriginalPatRoot: true, hasAuthorizationBearer: false });
            expect(nativeInvocationFacts.every(value => value.bindingAuthKind === undefined),
              'PAT Copy native effects must retain the PAT principal rather than an installed Account').toBe(true);
          } else {
            expect(installerStarts).toBe(0);
            expect(admittedRunIds).toEqual([]);
            expect(claimedRunIds).toEqual([]);
          }
          expect(httpOutcomes.slice(homeRequestsBefore, homeRequestsBeforeDecision)
            .filter(value => value.url.startsWith('/v1/actions/') || value.url.startsWith('/v1/artifacts'))
            .every(value => value.usedInstalledAccountBearer === false)).toBe(true);
          expectSignedPatSettlement(homeRequestsBeforeDecision, BOT_TEMPLATE_INSTANTIATE_ACTION_ID_V1, parentCard.artifactId);
          if (kind === 'copy') expect(httpOutcomes.filter(value => value.method === 'POST'
            && (value.url === `/v1/actions/${SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action}`
              || value.url === `/v1/actions/${SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action}`))).toEqual([]);
          return;
        }
        if (surface === 'UI' || surface === 'voice') {
          const copying = surface === 'voice' ? invokeVoice!('template.instantiate', copyInput)
            : ui.executeConfirmed('template.instantiate', copyInput, context);
          if (kind === 'copy-software') {
            await Promise.race([workflowWake?.then(() => installerStarted) ?? installerStarted, copying.then(result => {
              throw new Error(`Template Copy settled before installer terminal: ${JSON.stringify({ result, httpOutcomes, nativeExecutions })}`);
            })]);
            expect(agentStarts).toBe(0);
            releaseInstaller();
          }
          const copied = await copying;
          if (surface === 'voice') expect(voiceReadbacks).toBe(1);
          if (kind === 'copy-software') {
            await software.waitForWorkflowCoordinator();
            expect(admittedRunIds).toHaveLength(1);
            expect(claimedRunIds).toEqual(admittedRunIds);
            expect(await software.readInstalled()).toMatchObject({ installed: true, effects: ['apt-get'] });
          }
          expect(copied, JSON.stringify(copied)).toMatchObject({ ok: true, result: { type: 'success', sessionId: expect.any(String) } });
          if (!copied.ok) throw new Error(copied.errorCode);
          const creation = SessionSpawnNewActionResultV1Schema.parse(copied.result);
          if (creation.type !== 'success') throw new Error('Template Copy did not launch');
          const created = await fetchSessionById({ token: userToken, sessionId: creation.sessionId, serverUrl, reason: 'session-action' });
          expect(created, 'Template Copy must leave an ordinary Home Session').not.toBeNull();
          if (!created) throw new Error('Template Copy Session read unavailable');
          expect(tryDecryptSessionOwnerMetadataView({ credentials: software.credentials, accountEncryptionMode: mode, rawSession: created }))
            .toMatchObject({ summary: { text: upstream.content.identity.name },
              work: { templateInstance: { acceptedVersion: upstream.version,
                source: { kind: 'artifact', artifactId: source.artifactId } } } });
          return;
        }
        liveParent?.submitUserPrompt('Copy the offered template.', kind === 'copy-software' ? 'yolo' : 'default');
        await vi.waitFor(() => expect(liveParent?.mcpSession.getActiveTurnAdmissionWitness?.(),
          'The host must admit the provider turn before the Agent tool executes')
          .toBeTruthy(), { timeout: 15_000 });
        expect(liveParent?.mcpSession.getActiveTurnPermissionWitness?.()?.turnId)
          .toBe(liveParent?.mcpSession.getActiveTurnAdmissionWitness?.()?.turnId);
        const proposed = await invokeAgent('template.instantiate', copyInput);
        const stored = await runWithServerHttpBaseUrl(serverUrl, () => recipientStore.read(proposed.artifactId));
        const approval = ApprovalRequestV2Schema.parse(JSON.parse(stored!.body as string));
        expect(approval).toMatchObject({ actionId: 'template.instantiate', createdBy: { surface: 'agent', sessionId: session.id } });
        const copyRoot = approval.executionOriginV1.externalActionExecutionAuthorization?.binding;
        expect(copyRoot ? { actionId: copyRoot.actionId, target: copyRoot.target,
          credentialBound: 'credentialId' in copyRoot,
          callerSessionId: copyRoot.sessionActionOrigin?.caller.sessionId } : null)
          .toMatchObject({ actionId: 'template.instantiate', target: { kind: 'machine', machineId },
            credentialBound: false, callerSessionId: session.id });
        // Real Agents finish their proposal turn before the person opens and
        // approves the card. Keep the Session alive, as in the loaded journey.
        liveParent?.completeCurrentTurn();
        await vi.waitFor(() => expect(liveParent?.mcpSession.getActiveTurnAdmissionWitness?.()).toBeFalsy(),
          { timeout: 15_000 });
        const homeRequestsBeforeCopyApproval = httpOutcomes.length;
        const replaying = ui.executeConfirmed('approval.request.decide', {
          artifactId: proposed.artifactId, decision: 'approve',
        }, context);
        if (kind === 'copy-software') {
          await Promise.race([workflowWake?.then(() => installerStarted) ?? installerStarted, replaying.then(result => {
            throw new Error(`Agent Template Copy settled before installer terminal: ${JSON.stringify({ result, httpOutcomes, nativeExecutions })}`);
          })]);
          expect(agentStarts).toBe(0);
          releaseInstaller();
        }
        const replayed = await replaying;
        if (launchRefusal) {
          expect(replayed, JSON.stringify(replayed)).toMatchObject({ ok: true, result: { status: 'executed', execution: {
            ok: true, result: { type: 'error', code: 'spawn_failed', launchError: {
              code: launchRefusal === 'agent-missing' ? SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING : 'no_eligible_member',
            } } } } });
          if (!refusedSessionId) throw new Error('Missing committed refused child');
          const refused = await fetchSessionById({ token: userToken, sessionId: refusedSessionId, serverUrl, reason: 'session-action' });
          expect(refused).toMatchObject({ id: refusedSessionId, latestTurnStatus: 'failed',
            runtimeActivityActiveCount: 0, lastRuntimeIssue: {
              code: launchRefusal === 'agent-missing' ? SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING : 'no_eligible_member', status: 'failed',
            } });
          expect(JSON.stringify(refused?.lastRuntimeIssue)).not.toMatch(/PRIVATE_|\/private\//);
          expect(await db.sessionTurn.findMany({ where: { sessionId: refusedSessionId }, select: { status: true } }))
            .toEqual([{ status: 'failed' }]);
          const unchangedParent = await fetchSessionById({ token: userToken, sessionId: session.id, serverUrl, reason: 'session-action' });
          expect(unchangedParent?.lastRuntimeIssue).toBeNull();
          expect(await db.sessionTurn.findMany({ where: { sessionId: session.id, status: 'failed' }, select: { status: true } }))
            .toEqual([]);
          expect(agentStarts).toBe(1);
          return;
        }
        if (kind === 'copy-software') {
          await software.waitForWorkflowCoordinator();
          expect(admittedRunIds).toHaveLength(1);
          expect(claimedRunIds).toEqual(admittedRunIds);
          expect(await software.readInstalled()).toMatchObject({ installed: true, effects: ['apt-get'] });
        }
        expect(replayed, JSON.stringify(replayed)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true,
          result: { type: 'success', sessionId: expect.any(String) } } } });
        if (kind === 'copy') {
          const machineRead = httpOutcomes.slice(homeRequestsBeforeCopyApproval).find(value => value.method === 'GET'
            && value.url === `/v1/machines/${machineId}`);
          expect(machineRead).toMatchObject({ status: 200, signedEffectAdmitted: false,
            hasReviewedChildProof: false, usedRawPatBearer: false });
          expect(machineRead).not.toHaveProperty('effectActionId');
        }
        if (!replayed.ok) throw new Error(replayed.errorCode);
        const approved = ApprovalRequestV2Schema.parse(JSON.parse((await runWithServerHttpBaseUrl(serverUrl,
          () => recipientStore.read(proposed.artifactId)))!.body as string));
        const creation = SessionSpawnNewActionResultV1Schema.parse(approved.execution?.result);
        if (creation.type !== 'success') throw new Error('Agent-approved Template Copy did not launch');
        expect(creation.sourceKeyPreparation).toEqual({ kind: 'not_needed' });
        const created = await fetchSessionById({ token: userToken, sessionId: creation.sessionId, serverUrl, reason: 'session-action' });
        expect(created, 'Agent-approved Template Copy must leave an ordinary Home Session').not.toBeNull();
        if (!created) throw new Error('Agent Copy Session read unavailable');
        expect(created.lastRuntimeIssue).toBeNull();
        expect(await db.sessionTurn.findMany({ where: { sessionId: creation.sessionId }, select: { status: true } }))
          .toEqual([]);
        expect(tryDecryptSessionOwnerMetadataView({ credentials: software.credentials, accountEncryptionMode: mode, rawSession: created }))
          .toMatchObject({ path: expect.stringMatching(/\S/), machineId,
            summary: { text: copiedRelease.content.identity.name },
            work: { templateInstance: { acceptedVersion: copiedRelease.version,
              source: { kind: 'artifact', artifactId: copiedArtifact.artifactId } } } });
        const ownerMetadata = tryDecryptSessionOwnerMetadataView({ credentials: software.credentials, accountEncryptionMode: mode, rawSession: created });
        expect((await stat(String(ownerMetadata?.path))).isDirectory()).toBe(true);
        expect(agentStarts, 'Accepted Copy must reach the daemon runner launch before returning success').toBe(1);
        if (!realRunner) return;
        // The approved Copy returns as a real host input. Finish that delivered
        // provider turn before offering a separate human Update prompt.
        await vi.waitFor(() => expect(liveParent?.readProviderInputs()).toHaveLength(2), { timeout: 15_000 });
        liveParent?.completeCurrentTurn();
        await vi.waitFor(() => expect(liveParent?.mcpSession.getActiveTurnAdmissionWitness?.()).toBeFalsy(), { timeout: 15_000 });
      }
      const reviewed = await ui.execute('template.updates.diff', { sessionRef }, context);
      expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ ok: true });
      if (!reviewed.ok) throw new Error(reviewed.errorCode);
      const review = BotTemplateUpdateDiffResultV1Schema.parse(reviewed.result);
      const input = { sessionRef: surface === 'agent' || surface === 'pat' ? { serverId: homeId, sessionId: session.id } : sessionRef,
        expectedVersion: '1.1.11', expectedRevision: review.upstream.revision,
        ...(kind === 'identity' || realRunner ? { takeIdentity: true } : {}),
        setup: { software: kind === 'software' ? [{ key: 'hello', selection: { action: 'install' as const, inputs: {} } }] : [],
          accounts: [], mcpServers: [] } };
      if (surface === 'pat') {
        const protectedPat = 'protectedPat' in scenario;
        const grant = ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1,
          actions: { families: [], ids: kind === 'software'
            ? ['template.updates.apply', SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action,
              SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action]
            : ['template.updates.apply'] },
          targets: { sessions: [], machines: [machineId] }, approve: false });
        const patTokenId = crypto.randomUUID();
        const patWrappingSecret = crypto.getRandomValues(new Uint8Array(32));
        const pat = await auth.createApiToken({ accountId: recipient.id, tokenId: patTokenId,
          label: 'Composed Template update approval', grant,
          ...(mode === 'e2ee' ? { encryption: createPatEncryption(patTokenId, patWrappingSecret) } : {}) });
        const protectedCredential = protectedPat ? formatAccountApiTokenCredentialV1({ bearer: pat.token,
          wrappingSecret: encodeBase64(patWrappingSecret, 'base64url'), serverIdentityId: homeId,
          accountId: recipient.id, contentPublicKey: encodeBase64(publicKey) }) : null;
        const postUpdate = async (reviewInput: unknown) => {
          if (protectedCredential) {
            const client = connect({ endpoint: software.controlHttpOrigin()!, token: protectedCredential });
            try {
              const result = await client.machine(machineId).actions.template.updates.apply(
                BotTemplateUpdateApplyInputV1Schema.parse(reviewInput));
              return { execution: { ok: true, result } };
            } finally { await client.close(); }
          }
          const response = await fetch(`${software.controlHttpOrigin()}/v1/actions/template.updates.apply`, {
            method: 'POST', headers: { authorization: `Bearer ${pat.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ v: 1, requestId: crypto.randomUUID(), target: { kind: 'machine', machineId }, input: reviewInput }),
          });
          const result: unknown = await response.json();
          expect(response.status, JSON.stringify(result)).toBe(200);
          return result;
        };
        const homeRequestsBefore = httpOutcomes.length;
        const publicResult: unknown = await postUpdate(input);
        expect(publicResult).toMatchObject({ execution: { ok: true, result: {
          kind: 'approval_request_created', actionId: 'template.updates.apply', artifactId: expect.any(String) } } });
        const proposed = ActionApprovalRequestCreatedResultSchema.parse(Reflect.get(Reflect.get(publicResult as object,
          'execution') as object, 'result'));
        const stored = await runWithServerHttpBaseUrl(serverUrl, () => recipientStore.read(proposed.artifactId));
        const approval = ApprovalRequestV2Schema.parse(JSON.parse(stored!.body as string));
        expect(approval).toMatchObject({ actionId: 'template.updates.apply', executionOriginV1: {
          externalActionExecutionAuthorization: { binding: { accountId: recipient.id, principalId: recipient.id,
            credentialId: patTokenId, admittedMachineRole: 'manage', grant } },
        } });
        expect(await readMetadata()).toMatchObject({ work: { templateInstance: { acceptedVersion: '1.1.9' } } });
        expect(admittedRunIds).toEqual([]);
        expect(installerStarts).toBe(0);
        const homeRequestsBeforeDecision = httpOutcomes.length;
        const replaying = ui.executeConfirmed('approval.request.decide',
          { artifactId: proposed.artifactId, decision: 'approve' }, context);
        if (kind === 'software') {
          await Promise.race([workflowWake?.then(() => installerStarted) ?? installerStarted, replaying.then(result => {
            throw new Error(`Scoped PAT Template Update settled before installer terminal: ${JSON.stringify({ result, httpOutcomes, nativeExecutions })}`);
          })]);
          expect(await readMetadata()).toMatchObject({ work: { templateInstance: { acceptedVersion: '1.1.9' } } });
          releaseInstaller();
        }
        const replayed = await replaying;
        if (installFails) {
          expect(replayed, JSON.stringify(replayed)).toMatchObject({ ok: true, result: { status: 'failed', execution: {
            ok: false, errorCode: 'native_effect_failed',
          } } });
          await software.waitForWorkflowCoordinator();
          expect(admittedRunIds).toHaveLength(1);
          expect(claimedRunIds).toEqual(admittedRunIds);
          expect(await software.readInstalled()).toMatchObject({ installed: false, effects: [] });
          expect(await readMetadata()).toMatchObject({ work: { templateInstance: { acceptedVersion: '1.1.9' } } });
          expect(nativeExecutions.filter(value => value.actionId === SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action))
            .toHaveLength(1);
          const operations = await software.operations.handlers.listV2({}, software.context('machines.setup.apply'));
          expect(operations.items.find(value => value.domainRef?.kind === 'machineSetup'))
            .toMatchObject({ state: 'failed', error: { details: { kind: 'machineSetup', failure: {
              kind: 'native_effect_failed', nativeCommand: {
                command: 'apt-get', phase: 'install', exitCode: 1, category: 'command_failed',
              },
            } } } });
          await software.setInstallerFailure(false);
          if ('rerunSetup' in scenario) {
            const originalRunId = admittedRunIds[0]!;
            const original = await ui.execute('workflow.run.get', { runId: originalRunId }, context);
            expect(original, JSON.stringify(original)).toMatchObject({ ok: true });
            if (!original.ok) throw new Error(original.errorCode);
            const prior = WorkflowActionOutputSchemasV1['workflow.run.get'].parse(original.result);
            expect(prior.run).toMatchObject({ state: 'failed', machineId });
            if (!prior.definition || !prior.acceptedContext) throw new Error('Accepted Setup unavailable');
            const { project, definition: _definition, originSessionId, ...start } = prepareWorkflowRunStartV1({ definition: prior.definition,
              acceptedContext: prior.acceptedContext, replay: { runId: originalRunId } });
            if (!project) throw new Error('Accepted Setup target unavailable');
            const runId = crypto.randomUUID();
            const started = await ui.execute('workflow.run.start', { ...start, runId }, {
              ...context, defaultSessionMachineId: machineId,
              ...(originSessionId ? { defaultSessionId: originSessionId } : {}), externalActionTarget: { kind: 'machine', machineId,
                project: projectAcceptedWorkflowRunTarget(project) },
            });
            expect(started, JSON.stringify({ started, refusals: httpOutcomes.filter(outcome => outcome.status >= 400) }))
              .toMatchObject({ ok: true, result: { run: { id: runId, machineId } } });
            await automationWorker!.catchUp();
            await software.waitForWorkflowCoordinator();
            const queue = await ui.execute('approval.request.list', { workflowRunId: runId,
              actionId: 'machines.setup.apply', status: 'open' }, context);
            expect(queue, JSON.stringify(queue)).toMatchObject({ ok: true });
            if (!queue.ok) throw new Error(queue.errorCode);
            const cards = ApprovalQueueListResultV1Schema.parse(queue.result).items;
            expect(cards, JSON.stringify(queue)).toHaveLength(1);
            workflowAdmitted = new Promise<void>(resolve => { signalWorkflowAdmitted = resolve; });
            const setupWake = workflowAdmitted.then(() => automationWorker!.catchUp());
            void setupWake.catch(() => {});
            const approved = await ui.executeConfirmed('approval.request.decide',
              { artifactId: cards[0]!.artifactId, decision: 'approve' }, context);
            expect(approved, JSON.stringify(approved)).toMatchObject({ ok: true,
              result: { status: 'executed', execution: { ok: true } } });
            await setupWake;
            await automationWorker!.catchUp();
            await software.waitForWorkflowCoordinator();
            // This fixture coordinates worker claims but has no parked-Run
            // recovery subscription. Assert the actual Setup child effect,
            // rather than the parent's later approval-settlement observation.
            expect(admittedRunIds).toHaveLength(3);
            const childRunId = admittedRunIds.find(id => id !== originalRunId && id !== runId)!;
            expect(claimedRunIds).toContain(childRunId);
            const completed = await ui.execute('workflow.run.get', { runId: childRunId }, context);
            expect(completed).toMatchObject({ ok: true,
              result: { run: { id: childRunId, machineId, state: 'succeeded' } } });
            expect(await software.readInstalled()).toMatchObject({ installed: true, effects: ['apt-get'] });
            expect(await db.automationRun.findUniqueOrThrow({ where: { id: originalRunId } }))
              .toMatchObject({ state: 'failed' });
            return;
          }
          retryInstallerGate = new Promise<void>(resolve => { releaseRetryInstaller = resolve; });
          workflowAdmitted = new Promise<void>(resolve => { signalWorkflowAdmitted = resolve; });
          const retryWorkflowWake = workflowAdmitted.then(() => automationWorker!.catchUp());
          void retryWorkflowWake.catch(() => {});
          const freshReview = await ui.execute('template.updates.diff', { sessionRef }, context);
          expect(freshReview, JSON.stringify(freshReview)).toMatchObject({ ok: true });
          if (!freshReview.ok) throw new Error(freshReview.errorCode);
          const retryInput = { ...input, expectedRevision: BotTemplateUpdateDiffResultV1Schema.parse(freshReview.result).upstream.revision };
          const retryPublicResult: unknown = await postUpdate(retryInput);
          const retryExecution = Reflect.get(retryPublicResult as object, 'execution') as object;
          const retryCard = ActionApprovalRequestCreatedResultSchema.parse(Reflect.get(retryExecution, 'result'));
          expect(retryCard).toMatchObject({ actionId: 'template.updates.apply' });
          expect(retryCard.artifactId).not.toBe(proposed.artifactId);
          expect(installerStarts).toBe(1);
          const homeRequestsBeforeRetryDecision = httpOutcomes.length;
          const retrying = ui.executeConfirmed('approval.request.decide',
            { artifactId: retryCard.artifactId, decision: 'approve' }, context);
          await Promise.race([retryWorkflowWake.then(() => retryInstallerStarted), retrying.then(result => {
            throw new Error(`Scoped PAT Template retry settled before installer terminal: ${JSON.stringify({ result, httpOutcomes, nativeExecutions })}`);
          })]);
          expect(await readMetadata()).toMatchObject({ work: { templateInstance: { acceptedVersion: '1.1.9' } } });
          releaseRetryInstaller();
          const retried = await retrying;
          expect(retried, JSON.stringify(retried)).toMatchObject({ ok: true, result: { status: 'executed', execution: {
            ok: true, result: { acceptedVersion: '1.1.11' },
          } } });
          await software.waitForWorkflowCoordinator();
          expect(admittedRunIds).toHaveLength(2);
          expect(claimedRunIds).toEqual(admittedRunIds);
          expect(await software.readInstalled()).toMatchObject({ installed: true, effects: ['apt-get'] });
          expect(await readMetadata()).toMatchObject({ work: { templateInstance: { acceptedVersion: '1.1.11' } } });
          expect(nativeInvocationFacts.filter(value => value.actionId === SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action))
            .toEqual([expect.objectContaining({ principalAccountId: recipient.id, principalId: recipient.id,
              credentialId: patTokenId }), expect.objectContaining({ principalAccountId: recipient.id,
              principalId: recipient.id, credentialId: patTokenId })]);
          expectSignedPatSettlement(homeRequestsBeforeRetryDecision, 'template.updates.apply', retryCard.artifactId);
          return;
        }
        expect(replayed, JSON.stringify(replayed)).toMatchObject({ ok: true, result: { status: 'executed', execution: {
          ok: true, result: { acceptedVersion: '1.1.11' } } } });
        expect(await readMetadata()).toMatchObject({ work: { templateInstance: { acceptedVersion: '1.1.11' } } });
        if (kind === 'software') {
          await software.waitForWorkflowCoordinator();
          expect(admittedRunIds).toHaveLength(1);
          expect(claimedRunIds).toEqual(admittedRunIds);
          expect(await software.readInstalled()).toMatchObject({ installed: true, effects: ['apt-get'] });
          expect(nativeExecutions.filter(value => value.actionId === SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action))
            .toHaveLength(1);
        } else {
          expect(nativeExecutions.map(value => value.actionId)).not.toContain('machines.setup.apply');
          expect(admittedRunIds).toEqual([]);
          expect(claimedRunIds).toEqual([]);
          expect(installerStarts).toBe(0);
        }
        expect(httpOutcomes.slice(homeRequestsBefore, homeRequestsBeforeDecision)
          .filter(value => value.url.startsWith('/v1/actions/') || value.url.startsWith('/v1/artifacts'))
          .every(value => value.usedInstalledAccountBearer === false)).toBe(true);
        expectSignedPatSettlement(homeRequestsBeforeDecision, 'template.updates.apply', proposed.artifactId);
        return;
      }
      const beginApply = async () => {
        if (surface === 'UI') return ui.executeConfirmed('template.updates.apply', input, context);
        if (surface === 'voice') return invokeVoice!('template.updates.apply', input);
        if (kind === 'identity' || kind === 'software') {
          if (kind === 'software') {
            liveParent?.submitUserPrompt('Apply the offered template update with GNU hello.');
            if (realRunner) await vi.waitFor(() => expect(liveParent?.readProviderInputs()).toHaveLength(3), { timeout: 15_000 });
            await vi.waitFor(() => expect(liveParent?.mcpSession.getActiveTurnAdmissionWitness?.(),
              'The host must admit the provider turn before the Agent tool executes')
              .toBeTruthy(), { timeout: 15_000 });
            expect(liveParent?.mcpSession.getActiveTurnPermissionWitness?.()?.turnId)
              .toBe(liveParent?.mcpSession.getActiveTurnAdmissionWitness?.()?.turnId);
          }
          const proposed = await invokeAgent('template.updates.apply', input);
          const stored = await runWithServerHttpBaseUrl(serverUrl, () => recipientStore.read(proposed.artifactId));
          const approval = ApprovalRequestV2Schema.parse(JSON.parse(stored!.body as string));
          expect(approval).toMatchObject({ actionId: 'template.updates.apply', createdBy: { surface: 'agent', sessionId: session.id } });
          if (kind === 'software') expect(approval).toMatchObject({
            preview: { hostReviewedContent: { offer: 'available', upstream: { release: { version: '1.1.11' } },
              instance: { acceptedVersion: '1.1.9' }, softwarePlan: { recipePlans: [expect.objectContaining({
                plan: expect.objectContaining({ steps: [expect.objectContaining({ kind: 'package',
                  packages: [expect.objectContaining({ name: 'hello' })] })] }),
              })] } } },
          });
          expect(await readMetadata()).toMatchObject({ work: { templateInstance: { acceptedVersion: '1.1.9' } } });
          return kind === 'identity'
            ? ui.executeConfirmed('approval.request.decide', { artifactId: proposed.artifactId, decision: 'approve' }, context)
            : executeOriginalAccountMachineAction({ account: captured!, actionId: 'approval.request.decide', machineId,
              requestId: `approve-${crypto.randomUUID()}`, input: { artifactId: proposed.artifactId, decision: 'approve' } });
        }
      };
      let applying: Promise<unknown> = beginApply();
      if (kind === 'identity') {
        const result = await applying;
        expect(result, JSON.stringify({ result, nativeExecutions })).toMatchObject(surface === 'agent'
          ? { ok: true, result: { ok: true, status: 'executed', execution: { ok: true, result: { acceptedVersion: '1.1.11' } } } }
          : { ok: true, result: { acceptedVersion: '1.1.11' } });
        expect(await readMetadata()).toMatchObject({ work: { templateInstance: { acceptedVersion: '1.1.11' } } });
        expect(await readMetadata()).toMatchObject({ summary: { text: upstream.content.identity.name },
          botFace: upstream.content.identity.face });
        expect(nativeExecutions.map(value => value.actionId)).toEqual([]);
        return;
      }
      if (requireVoiceApproval) {
        const parentCard = await applying;
        expect(parentCard).toMatchObject({ ok: true, result: { kind: 'approval_request_created',
          actionId: 'template.updates.apply', artifactId: expect.any(String) } });
        const parentArtifactId = Reflect.get(Reflect.get(parentCard as object, 'result') as object, 'artifactId') as string;
        const parentStored = await runWithServerHttpBaseUrl(serverUrl, () => recipientStore.read(parentArtifactId));
        const parentRequest = ApprovalRequestV2Schema.parse(JSON.parse(parentStored!.body as string));
        const parentPreview = parentRequest.preview && typeof parentRequest.preview === 'object'
          ? Reflect.get(parentRequest.preview, 'hostReviewedChildren') : undefined;
        const reviewedChildren = readHostReviewedChildrenPlanV1(parentPreview);
        expect(parentRequest).toMatchObject({ actionId: 'template.updates.apply', requestedSurface: 'voice',
          preview: { hostReviewedContent: { softwarePlan: { recipePlans: [expect.objectContaining({
            plan: expect.objectContaining({ steps: [expect.objectContaining({ kind: 'package',
              packages: [expect.objectContaining({ name: 'hello' })] })] }),
          })] } } } });
        expect(reviewedChildren?.children).toEqual(expect.arrayContaining([
          expect.objectContaining({ action: SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action,
            input: expect.objectContaining({ homeId, machineId, targets: [expect.objectContaining({ homeId, machineId,
              recipePlans: [expect.objectContaining({ plan: expect.objectContaining({
                steps: [expect.objectContaining({ kind: 'package',
                  packages: [expect.objectContaining({ name: 'hello' })] })],
              }) })],
            })] }) }),
        ]));
        expect(await readMetadata()).toMatchObject({ work: { templateInstance: { acceptedVersion: '1.1.9' } } });
        expect(nativeExecutions.map(value => value.actionId)).not.toContain(SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action);
        expect(admittedRunIds).toEqual([]);
        expect(installerStarts).toBe(0);
        applying = ui.executeConfirmed('approval.request.decide',
          { artifactId: parentArtifactId, decision: 'approve' }, context);
      }
      await Promise.race([workflowWake?.then(() => installerStarted) ?? installerStarted, applying.then(result => {
        settledResult = result;
        throw new Error('Template update settled before installer terminal');
      })]);
      if (requireVoiceApproval) expect(nativeExecutions.find(value =>
        value.actionId === SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action))
        .toMatchObject({ execution: { ok: true, result: { operationId: expect.any(String), runId: expect.any(String) } } });
      expect(await readMetadata()).toMatchObject({ work: { templateInstance: { acceptedVersion: '1.1.9' } } });
      releaseInstaller();
      const result = await applying;
      if (surface === 'voice') expect(voiceReadbacks).toBe(1);
      await software.waitForWorkflowCoordinator();
      expect(admittedRunIds).toHaveLength(1);
      expect(claimedRunIds).toEqual(admittedRunIds);
      if (realRunner) expect(await readMetadata()).toMatchObject({ summary: { text: upstream.content.identity.name },
        botFace: upstream.content.identity.face, work: { templateInstance: { acceptedVersion: upstream.version } } });
      const persistedRun = await db.automationRun.findUniqueOrThrow({ where: { id: claimedRunIds[0]! } });
      expect(persistedRun).toMatchObject(installFails
        ? { state: 'outcome_uncertain', workflowCustodyState: 'pending' }
        : { state: 'succeeded', workflowCustodyState: 'settled' });
      expect(software.workflowDiagnostic().rootResults).toMatchObject([{ status: installFails ? 'failed' : 'applied' }]);
      const operations = await software.operations.handlers.listV2({}, software.context('machines.setup.apply'));
      const nativeOperation = operations.items.find(value => value.domainRef?.kind === 'machineSetup');
      expect(nativeOperation, JSON.stringify({ result, nativeExecutions })).toMatchObject({ state: installFails ? 'failed' : 'succeeded' });
      if (installFails) {
        expect(result, JSON.stringify({ result, nativeExecutions })).toMatchObject(surface === 'agent'
          ? { ok: true, result: { ok: true, status: 'failed', execution: { ok: false } } } : { ok: false });
        expect(await readMetadata()).toMatchObject({ work: { templateInstance: { acceptedVersion: '1.1.9' } } });
        expect(await software.readInstalled()).toMatchObject({ installed: false, effects: [] });
      } else {
        expect(result, JSON.stringify({ result, nativeExecutions })).toMatchObject(requireVoiceApproval
          ? { ok: true, result: { status: 'executed', execution: { ok: true, result: { acceptedVersion: '1.1.11' } } } }
          : surface === 'agent'
          ? { ok: true, result: { ok: true, status: 'executed', execution: { ok: true, result: { acceptedVersion: '1.1.11' } } } }
          : { ok: true, result: { acceptedVersion: '1.1.11' } });
        expect(await readMetadata()).toMatchObject({ work: { templateInstance: { acceptedVersion: '1.1.11' } } });
        expect(await software.readInstalled()).toMatchObject({ installed: true, effects: ['apt-get'] });
      }
      expect(software.rootLaunches).toHaveLength(1);
      if (installFails && surface === 'UI' && mode === 'plain') {
        await software.setInstallerFailure(false);
        retryInstallerGate = new Promise<void>(resolve => { releaseRetryInstaller = resolve; });
        workflowAdmitted = new Promise<void>(resolve => { signalWorkflowAdmitted = resolve; });
        const retryWorkflowWake = workflowAdmitted.then(() => automationWorker!.catchUp());
        void retryWorkflowWake.catch(() => {});
        const reviewedRetry = await ui.execute('template.updates.diff', { sessionRef }, context);
        expect(reviewedRetry).toMatchObject({ ok: true });
        if (!reviewedRetry.ok) throw new Error(reviewedRetry.errorCode);
        const retryReview = BotTemplateUpdateDiffResultV1Schema.parse(reviewedRetry.result);
        const retrying = ui.executeConfirmed('template.updates.apply', {
          ...input, expectedRevision: retryReview.upstream.revision,
        }, context);
        await Promise.race([retryWorkflowWake.then(() => retryInstallerStarted), retrying.then(result => {
          throw new Error(`Template retry settled before installer terminal: ${JSON.stringify({ result, httpOutcomes, nativeExecutions })}`);
        })]);
        expect(await readMetadata()).toMatchObject({ work: { templateInstance: { acceptedVersion: '1.1.9' } } });
        releaseRetryInstaller();
        const retried = await retrying;
        await software.waitForWorkflowCoordinator();
        expect(retried).toMatchObject({ ok: true, result: { acceptedVersion: '1.1.11' } });
        expect(await readMetadata()).toMatchObject({ work: { templateInstance: { acceptedVersion: '1.1.11' } } });
        expect(admittedRunIds).toHaveLength(2);
        expect(claimedRunIds).toEqual(admittedRunIds);
        expect(await software.readInstalled()).toMatchObject({ installed: true, effects: ['apt-get'] });
      }
    } catch (error) {
      console.error('Template settlement failure:', JSON.stringify({ surface, mode, installFails, voiceReadbacks,
        agentStarts, installerStarts, phaseFailures,
        message: error instanceof Error ? error.message : 'unknown_failure', settledResult,
        nativeExecutions: nativeExecutions.map(value => {
          if (!value.execution || typeof value.execution !== 'object') return { actionId: value.actionId };
          const result = Reflect.get(value.execution, 'result');
          return { actionId: value.actionId, ok: Reflect.get(value.execution, 'ok'),
            errorCode: Reflect.get(value.execution, 'errorCode'), details: Reflect.get(value.execution, 'details'),
            ...(result && typeof result === 'object' ? { resultKind: Reflect.get(result, 'kind'),
              resultStatus: Reflect.get(result, 'status'), resultErrorCode: Reflect.get(result, 'errorCode'),
              artifactId: Reflect.get(result, 'artifactId') } : {}) };
        }),
        workflow: software.workflowDiagnostic(), admittedRunIds, claimedRunIds,
        persistedRuns: await db.automationRun.findMany({ where: { id: { in: admittedRunIds } },
          select: { id: true, state: true, revision: true, attempt: true, workflowCustodyState: true,
            executionDispatchState: true, errorCode: true } }),
        nativeInvocationFacts, rpcDeliveryFailures,
        workflowHttp: httpOutcomes.filter(value => value.url === WORKFLOW_RUN_STORAGE_HTTP_PATH
          || value.url === '/v3/automations/runs/claim').map(value => ({ method: value.method,
          status: value.status, operation: value.workflowOperation,
          errorCode: value.error && typeof value.error === 'object' && 'code' in value.error
            && typeof value.error.code === 'string' ? value.error.code : undefined })),
        actionHttp: httpOutcomes.filter(value => value.authorityCeiling !== undefined),
        machineHttp: httpOutcomes.filter(value => value.method === 'GET' && value.url.startsWith('/v1/machines/')),
        httpErrors: httpOutcomes.filter(value => value.status >= 400) }));
      throw error;
    } finally {
      releaseInstaller(); releaseRetryInstaller(); captured?.dispose();
      resetVoiceSession?.();
      automationWorker?.stop();
      await liveParent?.stop();
      await parentRegistryLease?.release();
      restoreRunnerIdentity?.();
      restoreForegroundAgentCli?.();
      const { serverScopedRpcSocketPool } = await import('../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
      await serverScopedRpcSocketPool.stopAll();
      for (const tracked of trackedSessions.values()) await tracked.requesterSessionRuntimeContext?.dispose();
      await credentialCustody?.cleanup();
      await software.dispose(); await app.close(); await io.close();
      resetRuntimeFetch(); restoreHttp();
    }
  }, 120_000);

  it('admits original Account Browser UI controls directly while agent, MCP and saved UI Ask retain approval custody', async () => {
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const homeId = await getOrCreateServerIdentityId();
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(61));
    const machineId = 'browser-ui-machine';
    const installationId = 'browser-ui-installation';
    const serverUrl = 'https://browser-ui-home.example';
    await db.machine.create({ data: { id: machineId, accountId: account.id, installationId,
      installationPublicKey: installation.publicKey, metadata: encodePlainMachineStoredContent({}),
      dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'), metadataVersion: 1, active: true,
      lastActiveAt: new Date(), operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } },
      operationProtocolCapabilitiesRevision: 1 } });
    const token = await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
    const credentials: StoredCredentials = { token, encryption: null };
    const serverId = await home.addHome({ name: 'Browser UI', serverUrl, serverIdentityId: homeId,
      accountId: account.id, accountEncryptionMode: 'plain', currentAccount: true });
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
    const browserSessionId = 'browser-ui-session';
    const viewId = 'browser-ui-view';
    const history = [{ id: 1, url: 'https://browser.test/a' }, { id: 2, url: 'https://browser.test/b' },
      { id: 3, url: 'https://browser.test/c' }];
    const nativeCommands: Array<{ method: string; params?: Record<string, unknown> }> = [];
    // CDP is the native boundary. HTTP admission, credential provenance, policy,
    // Artifact persistence, control routes and the sidecar adapter remain real.
    const transport: BrowserSidecarCdpControlTransport = {
      openPage: async () => ({ targetId: 'target', sessionId: 'page' }),
      dispatchBrowserCommand: async () => ({}),
      dispatchPageCommand: async command => {
        nativeCommands.push(command);
        if (command.method === 'Page.getNavigationHistory') return { currentIndex: 1, entries: history };
        if (command.method === 'Page.getFrameTree') return { frameTree: { frame: {
          id: 'frame', loaderId: 'initial', url: history[1]!.url } } };
        if (command.method === 'Runtime.evaluate') return { result: { value: 'complete' } };
        return {};
      },
    };
    const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId, sidecarId: 'browser-ui', transport });
    await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', browserSessionId, viewId,
      target: { kind: 'externalUrl', targetId: 'browser-ui-target', url: history[1]!.url }, platform: 'web' });
    const broker = createBrowserDaemonControlBroker();
    broker.registerAdapter(adapter);
    const gate = createBrowserDaemonFeatureGate({ env: { NODE_ENV: 'test' }, resolveServerFeaturesSnapshot: () => ({ status: 'ready',
      features: FeaturesResponseSchema.parse({ features: { browser: { enabled: true, viewTargets: { enabled: true },
        internal: { enabled: true }, sidecar: { enabled: true } } } }),
    }) });
    await gate.refresh();
    const automation = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
      transport: createControlAdapterAutomationTransport({ adapter, contextCapture: {
        transport, resolvePageHandle: adapter.resolvePageHandle, getNavigationState: adapter.getNavigationState } }),
    }), subscribeViewLifecycle: adapter.subscribeViewLifecycle });
    const runtimeActionExecute = createBrowserDaemonRuntimeActionExecutor({
      control: createBrowserDaemonControlRoutes({ broker, automation: () => automation }), featureGate: gate, ownsAutomationView: broker.ownsView });
    const settings = normalizeActionsSettingsV1({ v: 1 });
    const executor = (admitted?: RequesterAccountActionContext) => createCliActionExecutorFromCredentials({
      credentials: admitted?.credentials ?? credentials, machineId, serverId: configuration.activeServerId,
      serverApiUrl: serverUrl, serverIdentityId: homeId,
      externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: installationId,
      actionsSettingsProvider: { getActionsSettings: () => admitted
        ? normalizeActionsSettingsV1(admitted.accountSettingsContext.settings.actionsSettingsV1) : settings,
        getAccountSettings: () => admitted?.accountSettingsContext.settings ?? accountSettingsParse({ actionsSettingsV1: settings }) },
      runtimeActionExecute,
    });
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    const io = new Server(createServer());
    app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    enableErrorHandlers(app); enableAuthentication(app);
    registerAccountEncryptionRoutes(app); registerAccountSettingsRoutes(app); machinesRoutes(app); artifactsRoutes(app);
    app.get('/v1/account/profile', async () => ({ id: account.id }));
    app.get('/v1/features', async () => FeaturesResponseSchema.parse({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: homeId } } }));
    registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io, forwardRpc: async request => {
      const { ExternalActionDaemonDispatchRequestSchema } = await import('@happier-dev/protocol/actions');
      const admitted = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
      const result = await executeExternalAction({ actionId: admitted.actionId, envelope: admitted.envelope,
        principal: admitted.principal, executionAuthorization: admitted.executionAuthorization,
        currentMachineId: machineId, currentInstallationId: installationId, currentServerId: configuration.activeServerId,
        currentServerHttpBaseUrl: serverUrl, currentAccountId: account.id,
        externalActionMachineRequestPrivateKey: installation.secretKey,
        verifyExecutionAuthorization: input => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
          installationId, privateKey: installation.secretKey, serverHttpBaseUrl: serverUrl }),
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor: executor(),
        prepareRequesterAccountContext: input => prepareRequesterAccountActionContext({ authorization: input.authorization,
          purpose: { kind: 'external_action' }, machineId, installationId, installationPrivateKey: installation.secretKey,
          serverId: configuration.activeServerId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl,
          ownCredentials: credentials, isCurrent: async () => true, createExecutor: admitted => executor(admitted) }),
      });
      return { ok: true, result: result.kind === 'response' ? createExternalActionDaemonDispatchResponse(result.prepared) : result };
    } }) });
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: serverUrl });
    let captured: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname !== '/v1/features') return home.request(input, init);
        const response = await app.inject({ method: 'GET', url: url.pathname });
        return new Response(response.payload, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
      });
      home.answer(serverId, 'POST /v1/machines/read-batch', { select: async (value, request) => {
        const response = await app.inject({ method: 'POST', url: '/v1/machines/read-batch',
          headers: Object.fromEntries(new Headers(request.init?.headers).entries()), payload: value });
        return { status: response.statusCode, body: response.json() };
      } });
      const commands: BrowserCommandV1[] = [
        { kind: 'goBack', commandId: 'back', browserSessionId, viewId },
        { kind: 'goForward', commandId: 'forward', browserSessionId, viewId },
        { kind: 'reload', commandId: 'reload', browserSessionId, viewId },
        { kind: 'stop', commandId: 'stop', browserSessionId, viewId },
        { kind: 'navigate', commandId: 'address-enter', browserSessionId, viewId, url: 'https://browser.test/typed' },
        { kind: 'setViewport', commandId: 'viewport', browserSessionId, viewId, emulation: { kind: 'preset', presetId: 'laptop' } },
        { kind: 'takeControl', commandId: 'take', browserSessionId, viewId },
        { kind: 'handBack', commandId: 'hand-back', browserSessionId, viewId },
      ];
      for (const actionId of new Set(commands.map(browserControlActionId))) {
        for (const path of [`/v1/actions/${actionId}`, `/v1/actions/${actionId}/execution-authorization`]) {
          home.answer(serverId, path, { select: async (value, request) => {
            const response = await app.inject({ method: 'POST', url: path,
              headers: Object.fromEntries(new Headers(request.init?.headers).entries()), payload: value });
            return { status: response.statusCode, body: response.json() };
          } });
        }
      }
      captured = await captureLazyActionAccountContext(serverId);
      const invoke = (command: BrowserCommandV1, surface?: 'agent' | 'mcp') => executeOriginalAccountMachineAction({
        account: captured!, actionId: browserControlActionId(command), machineId, requestId: crypto.randomUUID(),
        input: command, actionCaller: { kind: 'host' }, authority: surface ? 'account_automation' : 'present_user',
        ...(surface ? { invocation: { caller: { kind: 'host' }, surface, authority: 'account_automation' } as const } : {}),
      });
      nativeCommands.length = 0;
      for (const command of commands) {
        const result = await invoke(command);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'dispatched', commandId: command.commandId } });
      }
      expect(await db.artifact.count({ where: { accountId: account.id } })).toBe(0);
      expect(nativeCommands.filter(command => command.method === 'Page.navigateToHistoryEntry').map(command => command.params?.entryId)).toEqual([1, 3]);
      expect(nativeCommands.filter(command => command.method === 'Page.reload')).toHaveLength(1);
      expect(nativeCommands.filter(command => command.method === 'Page.stopLoading')).toHaveLength(1);
      expect(nativeCommands.find(command => command.method === 'Page.navigate')?.params?.url).toBe('https://browser.test/typed');
      const effectCount = nativeCommands.length;
      for (const surface of ['agent', 'mcp'] as const) {
        const result = await invoke(commands[0]!, surface);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId: 'browser.goBack' } });
      }
      // Agent-authored HTML uses the UI surface without an invocation; the
      // authenticated Account authority ceiling must still retain approval custody.
      const automationUi = await executeOriginalAccountMachineAction({
        account: captured!, actionId: 'browser.goBack', machineId, requestId: crypto.randomUUID(),
        input: commands[0]!, actionCaller: { kind: 'host' }, authority: 'account_automation',
      });
      expect(automationUi, JSON.stringify(automationUi)).toMatchObject({
        ok: true, result: { kind: 'approval_request_created', actionId: 'browser.goBack' },
      });
      expect(await db.artifact.count({ where: { accountId: account.id } })).toBe(3);
      expect(nativeCommands).toHaveLength(effectCount);
      // Persist Require at the real Account owner: requester admission reads
      // that Home's current settings, not the installed executor's fallback.
      const settingsWritten = await app.inject({ method: 'POST', url: '/v2/account/settings',
        headers: { authorization: `Bearer ${token}`, ...buildCurrentAccountStoredContentCompatibilityHttpHeaders() },
        payload: { expectedVersion: 0, content: { t: 'plain', v: { actionsSettingsV1: normalizeActionsSettingsV1({
          v: 1, actions: { 'browser.goBack': { approvalRequiredSurfaces: ['ui'] } },
        }) } } } });
      expect(settingsWritten.statusCode, settingsWritten.payload).toBe(200);
      const required = await invoke(commands[0]!);
      expect(required, JSON.stringify(required)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId: 'browser.goBack' } });
      expect(await db.artifact.count({ where: { accountId: account.id } })).toBe(4);
      expect(nativeCommands).toHaveLength(effectCount);
    } finally {
      captured?.dispose(); restoreHttp(); automation.dispose(); adapter.dispose(); await app.close(); await io.close();
    }
  });

  it.each(['plain', 'e2ee', 'unavailable', 'cancel-watch', 'denied', 'read-authority'] as const)('continues original Account logs after real Ask approval through the registered Resource watch (%s)', async scenario => {
    const mode = scenario === 'e2ee' || scenario === 'cancel-watch' ? 'e2ee' : 'plain';
    const phaseLog = vi.spyOn(logger, 'warnLocalFile');
    const logsPolicy = normalizeActionsSettingsV1({ v: 1, actions: {
      'machines.services.logs.read': { approvalRequiredSurfaces: ['ui'] },
    } });
    const secret = mode === 'e2ee' ? new Uint8Array(32).fill(scenario === 'cancel-watch' ? 33 : 32) : null;
    const machineKey = secret ? deriveAccountMachineKeyFromRecoverySecret(secret) : null;
    const signing = secret ? tweetnacl.sign.keyPair.fromSeed(secret) : null;
    const publicKey = machineKey ? tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey : null;
    const account = await db.account.create({ data: { encryptionMode: mode,
      ...(signing && publicKey ? { publicKey: Buffer.from(signing.publicKey).toString('hex'), contentPublicKey: publicKey,
        contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: publicKey }) } : {}) } });
    const homeId = await getOrCreateServerIdentityId();
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    const target = { serverId: configuration.activeServerId, machineId: `logs-account-machine-${scenario}` };
    const installationId = `logs-account-installation-${scenario}`;
    await db.machine.create({ data: { id: target.machineId, accountId: account.id, installationId,
      installationPublicKey: installation.publicKey, metadata: mode === 'plain' ? encodePlainMachineStoredContent({}) : 'opaque',
      dataEncryptionKey: mode === 'plain' ? Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') : null, metadataVersion: 1, active: true,
      lastActiveAt: new Date(), operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } },
      operationProtocolCapabilitiesRevision: 1 } });
    const token = await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
    const installedCredentials: StoredCredentials = { token: await createAccountTokenForTests(account.id,
      { kind: 'terminal', authority: 'account_automation' }),
      encryption: machineKey && publicKey ? { type: 'dataKey', machineKey, publicKey } : null };
    const settingsContent = prepareAccountSettingsV2Content({ credentials: installedCredentials,
      raw: { actionsSettingsV1: logsPolicy }, envelopeKind: mode === 'plain' ? 'plain' : 'encrypted' });
    const serverUrl = 'https://logs-account-home.example';
    const uiServerId = await home.addHome({ name: 'Logs Account', serverUrl, serverIdentityId: homeId,
      accountId: account.id, accountEncryptionMode: mode, currentAccount: true });
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(secret
      ? { token, secret: encodeBase64(secret, 'base64url') } : { token });
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [target.serverId]: {
      id: target.serverId, name: 'Logs Account', serverUrl, webappUrl: serverUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
      homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId,
        canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] },
    } } }));
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-account-logs-'));
    const pluginRoot = join(happyHomeDir, 'native-plugin');
    const nativeState = join(happyHomeDir, 'native.json');
    const pluginId = 'acme.account-logs';
    const adapter = { pluginId, localId: 'native' };
    const metadata: MachineMetadataFieldReadV1 = { status: 'ready', metadataVersion: 1, metadata: {
      serviceWatchesV1: { v: 1, watches: [{ v: 1, watchId: 'account-watch', name: 'Account worker', adapter,
        nativeResourceId: 'user/account-worker.service', lifecyclePurpose: 'deployment' }] },
    } };
    const runtime = createMachineServicesRuntime({ target, readMetadata: () => metadata,
      captureMetadataPort: () => ({ read: async () => metadata, compareAndSwap: async () => ({ status: 'unavailable' }) }) });
    let registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    const io = new Server(createServer());
    let resourceContext: RpcHandlerContext | undefined;
    let rootCurrentness: 'current' | 'unavailable' | 'expired' = 'current';
    let currentnessRefusals = 0;
    let restoreHttp = () => {};
    let captured: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
    const invocationLifetime = new AbortController();
    let pending: Promise<unknown> | undefined;
    let releaseNativeEvent = () => {};
    let nativeWatchEntered = () => {};
    const nativeWatchReady = new Promise<void>(resolve => { nativeWatchEntered = resolve; });
    const nativeBoundary = createServer((request, response) => {
      if (request.url !== '/watch') { response.writeHead(404).end(); return; }
      releaseNativeEvent = () => response.end('followed original Account bytes');
      nativeWatchEntered();
    });
    try {
      await new Promise<void>(resolve => nativeBoundary.listen(0, '127.0.0.1', resolve));
      const nativeAddress = nativeBoundary.address();
      if (!nativeAddress || typeof nativeAddress === 'string') throw new Error('Expected native log event boundary');
      await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
      await writeFile(nativeState, JSON.stringify({ reads: 0, watches: 0, disposals: 0 }));
      await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({ schemaVersion: 2,
        id: pluginId, version: '1.0.0', displayName: 'Account logs fixture', engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
        contributes: { projectNativeAdapters: [{ id: 'native', files: ['native.json'], roles: ['nativeServiceLifecycle'] }] },
      }));
      // The adapter supplies native OS log bytes; host admission, supervision,
      // Action execution and Resource registration remain the production owners.
      await writeFile(join(pluginRoot, 'daemon.mjs'), [
        "import { readFile, writeFile } from 'node:fs/promises';",
        "import { get } from 'node:http';",
        `const statePath = ${JSON.stringify(nativeState)};`,
        `const watchUrl = ${JSON.stringify(`http://127.0.0.1:${nativeAddress.port}/watch`)};`,
        "async function count(key) { const state = JSON.parse(await readFile(statePath, 'utf8')); state[key]++; await writeFile(statePath, JSON.stringify(state)); }",
        'export function activate(api) {',
        "api.projectNativeAdapters.register('native', { nativeServiceLifecycle: {",
        "async inspect() { return { phase: 'running', readiness: 'not_reported', endpoint: null }; },",
        "async stop() { return { status: 'unsupported' }; },",
        "async logs(instance, request) { const page = { kind: 'page', page: { sourceRevision: instance.nativeResourceId, text: 'original Account native bytes', nextCursor: null, truncated: false } }; if (request.kind === 'watch') { await count('watches'); let completed; const settled = new Promise(resolve => { completed = resolve; }); const native = get(watchUrl, response => { let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => { request.emit({ ...page, page: { ...page.page, text } }); }); }); native.on('error', completed); native.on('close', completed); return { async dispose() { native.destroy(); await settled; await count('disposals'); } }; } await count('reads'); return page; },",
        '} }); }',
      ].join('\n'));
      await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: '1.0.0' });
      const loaded = await loadInstalledPlugins({ happyHomeDir });
      expect(loaded.diagnosticsByPluginId[pluginId] ?? []).toEqual([]);
      const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({ loadResult: loaded,
        provenance: 'external', existingAgentIds: new Set() }));
      const generationAuthority = await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({ happyHomeDir }), {});
      if (!generationAuthority) throw new Error('Expected installed logs adapter generation');
      registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, contributes, generationAuthority, generation: 1 });
      expect(await pluginReloadController.adoptPreparedRuntimeRegistry({ registry, changedPluginIds: [pluginId],
        runningSessionDisposition: 'retainRunningSessions' })).toMatchObject({ ok: true });
      const operations = createHostActionOperationRuntime({ machineId: target.machineId, resolveAccountId: async () => account.id });
      const executor = (admitted?: RequesterAccountActionContext) => {
        const credentials = admitted?.credentials ?? installedCredentials;
        const originCurrentness = createDaemonApprovalExecutionOriginCurrentness({ accountId: account.id,
          machineId: target.machineId, serverId: target.serverId,
          resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
            serverUrl, resolveCurrentMachineId: () => target.machineId }),
          resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
          isAccountCurrent: async signal => (await fetchAccountProfile({ token: credentials.token,
            ...(signal ? { signal } : {}) })).id === account.id,
          // This journey is Account-authenticated; a PAT census is never its admission owner.
          listAccountApiTokens: async () => { throw new Error('Account logs must not enumerate API tokens'); },
          externalActionMachinePublicKey: installation.publicKey,
          verifyExternalExecutionAuthorization: input => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
            installationId, privateKey: installation.secretKey, serverHttpBaseUrl: serverUrl }),
        });
        return createCliActionExecutorHarness({ credentials, token: credentials.token,
          mode: mode === 'plain' ? 'plain' : 'dataKey', ctx: mode === 'plain' ? null : machineKey,
          sessionId: 'cli-global', serverId: target.serverId, serverHttpBaseUrl: serverUrl,
          actionsSettingsProvider: {
            getActionsSettings: () => normalizeActionsSettingsV1(admitted?.accountSettingsContext.settings.actionsSettingsV1),
            ...(admitted ? { getAccountSettings: () => admitted.accountSettingsContext.settings } : {}),
          }, machineActionDirectTargetTransport: { machineId: target.machineId, machineServiceAction: runtime.execute,
            invoke: async () => { throw new Error('Account logs must use the local service owner'); } },
        }, { runActionOperation: operations.runActionOperation,
          isApprovalExecutionOriginCurrent: originCurrentness }).executor;
      };
      const handlers = new Map<string, RpcHandler<unknown, unknown>>();
      registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) {
        handlers.set(method, handler as RpcHandler<unknown, unknown>);
      } }, { resolveRuntimeRegistry: async () => registry!, resolveHostActionExecutor: () => executor(),
        readHostResourceAccountId: () => account.id });
      registerMachineAccessLossReceiver({ registerHandler(method, handler) {
        handlers.set(method, handler as RpcHandler<unknown, unknown>);
      } }, { serverId: target.serverId, machineId: target.machineId, resolveInstallationId: () => installationId,
        cleanupRequesterMachineResources: async ({ requesterAccountId }) => {
          await pluginReloadController.retireHostResourceWatches(requesterAccountId);
          return { kind: 'settled' };
        } });
      app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
      enableErrorHandlers(app); enableAuthentication(app);
      app.addHook('onRequest', async (request, reply) => {
        if (request.url !== '/v1/actions/machines.services.logs.read/execution-authorization/verify'
          || rootCurrentness === 'current') return;
        currentnessRefusals++;
        // The actual Home HTTP boundary distinguishes a transient outage from
        // a closed verification refusal; all successful issuance stays real.
        return reply.code(rootCurrentness === 'unavailable' ? 503 : 401).send({
          error: rootCurrentness === 'unavailable' ? 'server_unreachable' : 'invalid_token',
        });
      });
      registerAccountEncryptionRoutes(app); registerAccountSettingsRoutes(app); machinesRoutes(app); artifactsRoutes(app);
      app.get('/v1/account/profile', async () => ({ id: account.id }));
      app.get('/v1/features', async () => FeaturesResponseSchema.parse({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: homeId } } }));
      let approvalCreated: (artifactId: string) => void = () => {};
      const created = new Promise<string>(resolve => { approvalCreated = resolve; });
      app.addHook('onResponse', async (request: FastifyRequest) => {
        if (request.method === 'POST' && request.url === '/v1/artifacts' && request.body
          && typeof request.body === 'object' && 'id' in request.body && typeof request.body.id === 'string') {
          approvalCreated(request.body.id);
        }
      });
      registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io, forwardRpc: async request => {
        const { ExternalActionDaemonDispatchRequestSchema } = await import('@happier-dev/protocol/actions');
        const admitted = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
        if (admitted.envelope.v === 2) {
          if (!machineKey) throw new Error('Plain Account must not acquire E2EE material');
          const root = admitted.executionAuthorization.binding;
          if (!root.authentication) throw new Error('Expected authenticated Account encryption binding');
          expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: admitted.envelope, material: { type: 'dataKey', machineKey },
            binding: { serverIdentityId: root.serverIdentityId, accountId: root.accountId, authentication: root.authentication,
              actionId: admitted.actionId, requestId: root.requestId, target: root.target } }),
          'The real UI sealed envelope must open under genuine installed Account material').not.toBeNull();
        }
        const dispatchOptions = { actionId: admitted.actionId, envelope: admitted.envelope, principal: admitted.principal,
          executionAuthorization: admitted.executionAuthorization, currentMachineId: target.machineId,
          currentInstallationId: installationId, currentServerId: target.serverId,
          currentServerHttpBaseUrl: serverUrl, currentAccountId: account.id,
          signal: invocationLifetime.signal,
          externalActionMachineRequestPrivateKey: installation.secretKey,
          verifyExecutionAuthorization: (input: Parameters<NonNullable<Parameters<typeof executeExternalAction>[0]['verifyExecutionAuthorization']>>[0]) =>
            verifyExternalActionExecutionAuthorizationCurrent({ ...input, installationId, privateKey: installation.secretKey,
              serverHttpBaseUrl: serverUrl }),
          resolveTarget: createDaemonExternalActionTargetResolver({ credentials: installedCredentials }), executor: executor(),
          prepareRequesterAccountContext: async (input: Parameters<NonNullable<Parameters<typeof executeExternalAction>[0]['prepareRequesterAccountContext']>>[0]) =>
            prepareRequesterAccountActionContext({ authorization: input.authorization, purpose: { kind: 'external_action' },
              machineId: target.machineId, installationId, installationPrivateKey: installation.secretKey,
              serverId: target.serverId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl, ownCredentials: installedCredentials,
              isCurrent: async () => true, createExecutor: context => executor(context) }),
          // This is the existing Machine RPC transport boundary. The new bridge
          // must select its actual registered handler after Account admission.
          invokeResource: async (method: string, params: unknown, context: RpcHandlerContext) => {
            // A retired/missing current ApiMachine is a transport-boundary
            // refusal before the Resource handler can install any observer.
            if (scenario === 'unavailable') throw new PluginError({ code: 'service_admission_unavailable' });
            const handler = handlers.get(method);
            if (!handler) throw new Error(`Missing registered Resource handler: ${method}`);
            if (method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN) resourceContext = context;
            return handler(params, context);
          },
        };
        const result = await executeExternalAction(dispatchOptions);
        return { ok: true, result: result.kind === 'response' ? createExternalActionDaemonDispatchResponse(result.prepared) : result };
      } }) });
      restoreHttp = installAxiosFastifyAdapter({ app, origin: serverUrl });
      // Exercise the actual mode-aware Home writer. Account.settings retains
      // ciphertext alone in E2EE mode, not JSON of the HTTP content envelope.
      const settingsWritten = await app.inject({ method: 'POST', url: '/v2/account/settings',
        headers: { authorization: `Bearer ${token}`, ...buildCurrentAccountStoredContentCompatibilityHttpHeaders() },
        payload: { expectedVersion: 0, content: settingsContent } });
      expect(settingsWritten.statusCode).toBe(200);
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname !== '/v1/features') return home.request(input, init);
        const response = await app.inject({ method: 'GET', url: url.pathname });
        return new Response(response.payload, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
      });
      home.answer(uiServerId, 'POST /v1/machines/read-batch', { select: async (value, request) => {
        const response = await app.inject({ method: 'POST', url: '/v1/machines/read-batch',
          headers: Object.fromEntries(new Headers(request.init?.headers).entries()), payload: value });
        return { status: response.statusCode, body: response.json() };
      } });
      for (const actionId of ['machines.services.logs.read', 'approval.request.decide']) {
        for (const path of [`/v1/actions/${actionId}`, `/v1/actions/${actionId}/execution-authorization`]) home.answer(uiServerId, path, { select: async (value, request) => {
          const response = await app.inject({ method: 'POST', url: path,
            headers: Object.fromEntries(new Headers(request.init?.headers).entries()), payload: value });
          return { status: response.statusCode, body: response.json() };
        } });
      }
      captured = await captureLazyActionAccountContext(uiServerId);
      const detail = MachineServicesDetailResultV1Schema.parse(await runtime.execute({ actionId: 'machines.services.detail',
        input: { ...target, serviceId: 'account-watch' }, context: { surface: 'ui', authority: 'present_user' } }));
      if (detail.kind !== 'service' || !detail.service.generation) throw new Error('Expected actual admitted native service');
      const actionInput = { ...target, serviceId: detail.service.serviceId };
      const request = { account: captured, actionId: 'machines.services.logs.read' as const, machineId: target.machineId,
        input: actionInput, authority: 'present_user' as const, signal: invocationLifetime.signal };
      const page = { kind: 'page', page: { sourceRevision: 'user/account-worker.service',
        text: 'original Account native bytes', nextCursor: null, truncated: false } };
      const subscriptionId = 'original-account-logs';
      const bootstrapResource = { hostRead: 'machines.services.logs', input: actionInput,
        expectedGeneration: detail.service.generation, sourceRevision: page.page.sourceRevision };
      expect(JSON.parse(await readFile(nativeState, 'utf8'))).toEqual({ reads: 0, watches: 0, disposals: 0 });
      // A Resource starts with the complete source reference supplied by the
      // preceding finite read. Subscribe independently revalidates its policy.
      const bootstrapRequest = { ...request, requestId: 'account-logs-open', resourceContinuation: {
        method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN,
        params: { machineId: target.machineId, subscriptionId, resource: bootstrapResource },
      } };
      if (scenario === 'unavailable') {
        expect(await executeOriginalAccountMachineAction(bootstrapRequest))
          .toMatchObject({ ok: false, errorCode: 'service_admission_unavailable' });
        expect(JSON.parse(await readFile(nativeState, 'utf8'))).toEqual({ reads: 0, watches: 0, disposals: 0 });
        return;
      }
      pending = executeOriginalAccountMachineAction(bootstrapRequest);
      const first = await Promise.race([created.then(artifactId => ({ kind: 'created' as const, artifactId })),
        pending.then(result => ({ kind: 'settled' as const, result }))]);
      const phases = phaseLog.mock.calls.filter(call => call[0] === '[external-action-phase]').map(call => {
        const fact = call[1] as Readonly<{ phase?: string; refusalBranch?: string; errorClass?: string }>;
        return { phase: fact.phase, refusalBranch: fact.refusalBranch, errorClass: fact.errorClass };
      });
      expect(first, first.kind === 'settled' ? JSON.stringify({ result: first.result, phases }) : undefined)
        .toMatchObject({ kind: 'created', artifactId: expect.any(String) });
      if (first.kind !== 'created') throw new Error('Expected real pending logs approval Artifact');
      const coordinator = getSharedBlockingApprovalCoordinator();
      const held = await Promise.race([pending.then(result => ({ kind: 'settled' as const, result })),
        vi.waitFor(() => expect(coordinator.getLiveWaiterCount(first.artifactId)).toBe(1))
          .then(() => ({ kind: 'waiting' as const }))]);
      expect(held).toEqual({ kind: 'waiting' });
      expect(JSON.parse(await readFile(nativeState, 'utf8'))).toEqual({ reads: 0, watches: 0, disposals: 0 });
      // The person decision re-enters the same authenticated Home and installed
      // receiver; its authority comes from the Account bearer at that boundary.
      expect(await executeOriginalAccountMachineAction({ account: captured, actionId: 'approval.request.decide',
        machineId: target.machineId, requestId: 'account-logs-approve',
        input: { artifactId: first.artifactId, decision: scenario === 'denied' ? 'reject' : 'approve' }, signal: invocationLifetime.signal }))
        .toMatchObject({ ok: true });
      const opened = await pending;
      if (scenario === 'denied') {
        expect(opened).toMatchObject({ ok: true, result: { ok: false, code: 'approval_rejected' } });
        expect(JSON.parse(await readFile(nativeState, 'utf8'))).toEqual({ reads: 0, watches: 0, disposals: 0 });
        return;
      }
      expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true, result: { ok: true, subscriptionId, digest: expect.any(String) } });
      expect(JSON.parse(await readFile(nativeState, 'utf8'))).toEqual({ reads: 1, watches: 1, disposals: 0 });
      const resource = bootstrapResource;
      const watchTarget = { machineId: target.machineId, subscriptionId, resource };
      const continueResource = (requestId: string, method:
        | typeof RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ
        | typeof RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN
        | typeof RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT
        | typeof RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE, params: unknown) => {
        const continuation = { ...request, requestId, resourceContinuation: { method, params } };
        return executeOriginalAccountMachineAction(continuation);
      };
      // OPEN's Home response has settled, including original invocation cleanup.
      // Only now may the genuine native event exercise retained requester ports.
      await nativeWatchReady;
      releaseNativeEvent();
      expect(await continueResource('account-logs-next', RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT, watchTarget))
        .toMatchObject({ ok: true, result: { ok: true, status: 'event', event: { kind: 'invalidated' } } });
      expect(JSON.parse(await readFile(nativeState, 'utf8'))).toEqual({ reads: 1, watches: 1, disposals: 0 });
      expect(await db.artifact.count({ where: { accountId: account.id } })).toBe(1);
      if (scenario === 'read-authority') {
        if (!resourceContext) throw new Error('Expected genuine original Account Resource admission');
        const read = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ);
        const next = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT);
        const close = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE);
        if (!read || !next || !close) throw new Error('Expected registered native Resource handlers');
        const readTarget = { machineId: target.machineId, resource };
        // Reuse the real retained OPEN context, not copied private symbols or
        // a new root that Home could reject before reaching Resource admission.
        expect(await read(readTarget, resourceContext)).toMatchObject({ ok: true });
        const beforeAuthorityLoss = JSON.parse(await readFile(nativeState, 'utf8'));
        // These handler calls retain the OPEN invocation's admitted execution;
        // they do not mint new finite Action requests or require native rereads.
        expect(beforeAuthorityLoss).toEqual({ reads: 1, watches: 1, disposals: 0 });
        rootCurrentness = 'expired';
        const accessLoss = handlers.get(RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS);
        if (!accessLoss) throw new Error('Expected installed Machine access-loss receiver');
        expect(await accessLoss({ v: 1, subjectAccountId: account.id }, {
          signal: new AbortController().signal, authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN,
          machineAdmission: { actorAccountId: account.id, custodianAccountId: account.id,
            machineId: target.machineId, installationId, role: 'manage', encryptionMode: mode },
        })).toEqual({ kind: 'settled' });
        expect(JSON.parse(await readFile(nativeState, 'utf8')))
          .toEqual({ reads: beforeAuthorityLoss.reads, watches: beforeAuthorityLoss.watches, disposals: 1 });
        // A fresh continuation is refused at Home. Releasing the watch also
        // retires its private requester custody, so the old context refuses.
        expect(await continueResource('account-logs-after-loss', RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ, readTarget))
          .toMatchObject({ ok: false });
        expect(currentnessRefusals).toBeGreaterThan(0);
        expect.soft(await next({ ...watchTarget, waitMs: DAEMON_PLUGIN_UI_RESOURCE_WATCH_MIN_WAIT_MS }, resourceContext))
          .toMatchObject({ ok: false, code: 'expired_resource' });
        await vi.waitFor(async () => expect(JSON.parse(await readFile(nativeState, 'utf8')))
          .toEqual({ reads: beforeAuthorityLoss.reads, watches: beforeAuthorityLoss.watches, disposals: 1 }));
        // CLOSE releases retained custody without minting a new root or
        // requiring yesterday's disclosure authority to become current again.
        expect(await close(watchTarget, resourceContext)).toMatchObject({ ok: true, closed: false });
        expect(JSON.parse(await readFile(nativeState, 'utf8')))
          .toEqual({ reads: beforeAuthorityLoss.reads, watches: beforeAuthorityLoss.watches, disposals: 1 });
        expect(await db.artifact.count({ where: { accountId: account.id } })).toBe(1);
        return;
      }
      if (scenario === 'cancel-watch') {
        invocationLifetime.abort();
        await vi.waitFor(async () => expect(JSON.parse(await readFile(nativeState, 'utf8')))
          .toEqual({ reads: 1, watches: 1, disposals: 1 }));
        return;
      }
      expect(await continueResource('account-logs-close', RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE, watchTarget))
        .toMatchObject({ ok: true, result: { ok: true, closed: true } });
      expect(JSON.parse(await readFile(nativeState, 'utf8'))).toEqual({ reads: 1, watches: 1, disposals: 1 });
      const staleRequest = { ...request, requestId: 'account-logs-stale',
        machineServiceLogsGeneration: { expectedGeneration: 'retired-generation' } };
      expect(await executeOriginalAccountMachineAction(staleRequest)).toMatchObject({ ok: false, errorCode: 'service_generation_changed' });
      expect(JSON.parse(await readFile(nativeState, 'utf8'))).toEqual({ reads: 1, watches: 1, disposals: 1 });
      expect(await db.artifact.count({ where: { accountId: account.id } })).toBe(1);
    } finally {
      invocationLifetime.abort();
      await pending?.catch(() => undefined);
      captured?.dispose(); restoreHttp(); await app.close(); await io.close();
      await runtime.dispose();
      if (registry) await retireAdmittedPluginRuntimeRegistry({ controller: pluginReloadController, registry, happyHomeDir });
      await registry?.dispose();
      nativeBoundary.closeAllConnections();
      if (nativeBoundary.listening) await new Promise<void>((resolve, reject) =>
        nativeBoundary.close(error => error ? reject(error) : resolve()));
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it.each(['account', 'terminal'] as const)('round-trips the real provisioner catalog through Home minting and installed daemon admission with recovery-key crypto for %s credentials', async kind => {
    const secret = new Uint8Array(32).fill(kind === 'account' ? 29 : 30);
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
    const signing = tweetnacl.sign.keyPair.fromSeed(secret);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const account = await db.account.create({ data: { publicKey: Buffer.from(signing.publicKey).toString('hex'), encryptionMode: 'e2ee',
      contentPublicKey: publicKey, contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: publicKey }) } });
    const homeId = await getOrCreateServerIdentityId();
    const controller = { machineId: `fx18-${kind}-controller`, installationId: `fx18-${kind}-installation` };
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(22));
    await db.machine.create({ data: { id: controller.machineId, accountId: account.id, installationId: controller.installationId,
      installationPublicKey: installation.publicKey, metadata: 'opaque', metadataVersion: 1,
      active: true, lastActiveAt: new Date(), operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
    const token = await createAccountTokenForTests(account.id, { kind,
      authority: kind === 'account' ? 'present_user' : 'account_automation' });
    const credentials: StoredCredentials = { token, encryption: { type: 'legacy', secret } };
    // Terminal pairing provisions the installed daemon with the Account data key,
    // while the browser retains its recovery-key credential.
    const installedCredentials: StoredCredentials = { token: await createAccountTokenForTests(account.id, {
      kind: 'terminal', authority: 'account_automation',
    }), encryption: { type: 'dataKey', machineKey, publicKey } };
    const serverUrl = 'https://fx16-home.example';
    const uiServerId = await home.addHome({ name: 'FX16', serverUrl, serverIdentityId: homeId, accountId: account.id,
      accountEncryptionMode: 'e2ee', currentAccount: true });
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token, secret: encodeBase64(secret, 'base64url') });
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [configuration.activeServerId]: {
      id: configuration.activeServerId, name: 'FX16', serverUrl, webappUrl: serverUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
      homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: serverUrl,
        revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] },
    } } }));
    const machineRow = { id: controller.machineId, kind: 'persistent', installationId: controller.installationId, active: true, activeAt: Date.now(),
      revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null, storageMode: 'e2ee', metadata: 'opaque', metadataVersion: 1,
      daemonState: null, daemonStateVersion: 0, keyBasis: { dataEncryptionKey: null, metadataVersion: 1, daemonStateVersion: 0 },
      seq: 1, createdAt: 1, updatedAt: 1, access: { custodian: { accountId: account.id, displayName: 'Owner' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' },
    } as const satisfies FetchedMachineRow;
    home.answer(uiServerId, '/v1/machines', { body: [machineRow] });
    // Substitute plugin module loading through the existing native testkit;
    // the real registry and catalog producer must carry this declaration through the relay.
    const provisioner = nativeFixture({ credentialPurposes: [] });
    const registry = provisioner.runtimeRegistry;
    const unavailable = async (): Promise<never> => { throw new Error('Catalog reads must not materialize credentials'); };
    const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
      purposeBindingOwner: createConnectedAccountPurposeBindingOwner({ store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable,
        subscribe: () => ({ dispose() {} }) }, selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
        projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable }),
      requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
      createRedactionLease: () => ({ add() {}, close() {} }),
    });
    const resolveCurrentMachineExecutionOriginContext = createCurrentMachineExecutionOriginContextResolver({ serverUrl,
      resolveCurrentMachineId: () => controller.machineId });
    const native = createDaemonManagedMachineActionAdapter({ credentials, machineId: controller.machineId, serverBaseUrl: serverUrl,
      serverId: configuration.activeServerId, installationIdentity: { installationId: controller.installationId, privateKey: installation.secretKey },
      managedProviderOperationAuthority: authority,
      resolveCurrentMachineExecutionOriginContext,
      acquireRuntimeRegistryLease: async () => ({ registry, source: 'active', durableRevision: 1, release: async () => {} }),
    });
    const softwareRuntime = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{ files: {}, manifest: {
      schemaVersion: 2, id: 'acme.software', version: '1.0.0', displayName: 'Software', runtime: { apiVersion: 1 },
      contributes: { machineRecipes: [{ id: 'fonts', revision: '1', title: 'Fonts', software: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        steps: [{ id: 'fonts', kind: 'package', manager: 'apt', packages: [{ name: 'fonts-dejavu-core' }] }],
      }] },
    } }] });
    let softwareReads = 0;
    const machineRecipesRead = createMachineRecipeReadAction({ homeId, machineId: controller.machineId,
      readMachineMetadataSnapshot: () => ({ status: 'ready', metadataVersion: 1, metadata: { platform: 'linux', arch: 'x64' } }),
      acquirePluginRuntimeRegistryLease: async () => {
        softwareReads++;
        return acquireAuthoritativePluginRuntimeRegistryLease({ controller: softwareRuntime.controller, happyHomeDir: softwareRuntime.happyHomeDir });
      },
      isCurrent: async context => context.externalActionExecutionAuthorization?.binding.serverIdentityId === homeId,
    });
    const executor = (admitted?: RequesterAccountActionContext) => createCliActionExecutorFromCredentials({
      credentials: installedCredentials, readCredentials: async () => installedCredentials, machineId: controller.machineId, serverId: configuration.activeServerId,
      serverApiUrl: serverUrl, serverIdentityId: homeId, managedMachineAction: native, machineRecipesRead,
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(admitted?.accountSettingsContext.settings.actionsSettingsV1),
        ...(admitted ? { getAccountSettings: () => admitted.accountSettingsContext.settings } : {}) },
    });
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    enableErrorHandlers(app);
    enableAuthentication(app);
    const homeResponses: Array<{ path: string; status: number }> = [];
    app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
      homeResponses.push({ path: request.url, status: reply.statusCode });
    });
    registerAccountEncryptionRoutes(app);
    registerAccountSettingsRoutes(app);
    app.get('/v1/account/profile', async () => ({ id: account.id }));
    app.get('/v1/features', async () => FeaturesResponseSchema.parse({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: homeId } } }));
    const io = new Server(createServer());
    let admissionResult: Awaited<ReturnType<typeof executeExternalAction>> | undefined;
    let authorizationVerified = false;
    let requesterContextPrepared = false;
    const dispatch = createExternalActionDaemonDispatcher({ io, forwardRpc: async request => {
      const raw = request.callParams;
      if (!raw || typeof raw !== 'object' || !('envelope' in raw) || !('executionAuthorization' in raw) || !('principal' in raw)) throw new Error('Missing dispatch');
      const { ExternalActionDaemonDispatchRequestSchema } = await import('@happier-dev/protocol/actions');
      const admitted = ExternalActionDaemonDispatchRequestSchema.parse(raw);
      admissionResult = await executeExternalAction({ actionId: admitted.actionId, envelope: admitted.envelope, principal: admitted.principal,
        executionAuthorization: admitted.executionAuthorization, currentMachineId: controller.machineId, currentInstallationId: controller.installationId,
        currentServerId: configuration.activeServerId, externalActionMachineRequestPrivateKey: installation.secretKey,
        verifyExecutionAuthorization: async input => {
          authorizationVerified = await verifyExternalActionExecutionAuthorizationCurrent({ ...input,
            installationId: controller.installationId, privateKey: installation.secretKey, serverHttpBaseUrl: serverUrl });
          return authorizationVerified;
        },
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor: executor(),
        // Installed credential custody is the OS fixture, as in daemon startup.
        // Resolve the actual Home identity and retain real recovery-key crypto.
        resolveEncryption: async signal => {
          const origin = await resolveCurrentMachineExecutionOriginContext(signal);
          return origin?.machineId === controller.machineId
            ? { serverIdentityId: origin.serverIdentityId, material: { type: 'dataKey', machineKey } }
            : null;
        },
        prepareRequesterAccountContext: async input => {
          const prepared = await prepareRequesterAccountActionContext({ authorization: input.authorization, purpose: { kind: 'external_action' },
            machineId: controller.machineId, installationId: controller.installationId, installationPrivateKey: installation.secretKey,
            serverId: configuration.activeServerId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl, ownCredentials: installedCredentials,
            // Installed custody and its retained credential are the OS fixture.
            // Account mode, settings, authorization and crypto stay real.
            isCurrent: async () => true, createExecutor: executor });
          requesterContextPrepared = prepared !== null;
          return prepared;
        },
      });
      return { ok: true, result: admissionResult.kind === 'response' ? createExternalActionDaemonDispatchResponse(admissionResult.prepared) : admissionResult };
    } });
    registerExternalActionRoutes(app, { dispatch });
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: serverUrl });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe(serverUrl);
      if (url.pathname !== '/v1/features') return home.request(input, init);
      const response = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
      return new Response(response.payload, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    });
    home.answer(uiServerId, '/v1/actions/machines.provisioners.list', { select: async value => {
      expect(ExternalActionRequestEnvelopeSchema.parse(value).v).toBe(2);
      const response = await app.inject({ method: 'POST', url: '/v1/actions/machines.provisioners.list',
        headers: { authorization: `Bearer ${token}` }, payload: value });
      return { status: response.statusCode, body: response.json() };
    } });
    for (const path of ['/v1/actions/action.options.resolve', '/v1/actions/action.options.resolve/execution-authorization']) {
      home.answer(uiServerId, path, { select: async (value, request) => {
        const response = await app.inject({ method: 'POST', url: path,
          headers: Object.fromEntries(new Headers(request.init?.headers).entries()), payload: value });
        return { status: response.statusCode, body: response.json() };
      } });
    }
    let softwareAccount: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
    try {
      const result = kind === 'account'
        ? await provisionerCatalog.read({ serverId: uiServerId, accountId: account.id }, { homeId, controller,
            contribution: { pluginId: 'acme.compute', localId: 'vm' } })
        : await (async () => {
          // Paired CLI credentials use the real authorization client. UI login
          // deliberately requires an Account token rather than a terminal token.
          const binding = { serverIdentityId: homeId, accountId: account.id, actionId: 'machines.provisioners.list',
            requestId: 'fx18-terminal-catalog', target: { kind: 'machine' as const, machineId: controller.machineId },
            authentication: { kind: 'terminal' as const, tokenEpoch: account.tokenEpoch } };
          const material = { type: 'dataKey' as const, machineKey };
          const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: { homeId, controller }, material,
            randomBytes: length => new Uint8Array(length).fill(17) });
          const minted = await mintExternalActionExecutionAuthorization({ actionId: binding.actionId, envelope,
            machineId: controller.machineId, pat: token, serverHttpBaseUrl: serverUrl });
          expect(minted).toMatchObject({ ok: true });
          if (!minted.ok) throw new Error(`Catalog authorization rejected: ${minted.code}`);
          const response = await app.inject({ method: 'POST', url: '/v1/actions/machines.provisioners.list',
            headers: { authorization: `Bearer ${token}`, [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' },
            payload: { v: 1, machineId: controller.machineId, envelope, executionAuthorization: minted.authorization } });
          expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
          const execution = openExternalActionResponseV2({ envelope: response.json(), binding, material, request: envelope });
          return execution?.ok ? { kind: 'succeeded', value: execution.result } : { kind: 'failed', execution };
        })();
      expect(admissionResult, JSON.stringify({ admissionResult, authorizationVerified, requesterContextPrepared, homeResponses, result }))
        .toMatchObject({ kind: 'response', response: { v: 2 } });
      expect(result.kind).toBe('succeeded');
      if (result.kind !== 'succeeded') throw new Error('Catalog transport failed');
      const catalog = MachineProvisionersListResultV1Schema.parse(result.value);
      expect(catalog.controller).toEqual(controller);
      expect(catalog.provisioners).toHaveLength(1);
      expect(catalog.provisioners[0]).toMatchObject({ contribution: { pluginId: 'acme.compute', localId: 'vm' },
        descriptor: { title: 'Virtual machine' } });
      expect(MachineProvisionersListResultV1Schema.safeParse({ ...catalog, unexpected: true }).success).toBe(false);
      if (kind === 'account') {
        // This must traverse the same UI -> encrypted Home -> installed daemon
        // owner. Dropping the contribution at any seam would return the VM.
        const missing = await provisionerCatalog.read({ serverId: uiServerId, accountId: account.id }, {
          homeId, controller, contribution: { pluginId: 'acme.compute', localId: 'missing' },
        });
        expect(missing).toMatchObject({ kind: 'succeeded', value: { controller, provisioners: [] } });
      }
      softwareAccount = kind === 'account' ? await captureLazyActionAccountContext(uiServerId) : undefined;
      const readSoftware = async (draftHomeId: string, requestId: string) => {
        const actionId = 'action.options.resolve' as const;
        const input = { optionsSourceId: 'machines.setup.software.available',
          draftInput: { homeId: draftHomeId, machineId: controller.machineId } };
        if (softwareAccount) return executeOriginalAccountMachineAction({ account: softwareAccount, actionId,
          machineId: controller.machineId, input, requestId, authority: 'present_user' });
        const binding = { serverIdentityId: homeId, accountId: account.id, actionId, requestId,
          target: { kind: 'machine' as const, machineId: controller.machineId },
          authentication: { kind: 'terminal' as const, tokenEpoch: account.tokenEpoch } };
        const material = { type: 'dataKey' as const, machineKey };
        const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input, material,
          randomBytes: length => new Uint8Array(length).fill(18) });
        const minted = await mintExternalActionExecutionAuthorization({ actionId, envelope, machineId: controller.machineId,
          pat: token, serverHttpBaseUrl: serverUrl });
        if (!minted.ok) throw new Error(`Software authorization rejected: ${minted.code}`);
        const response = await app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
          headers: { authorization: `Bearer ${token}`, [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' },
          payload: { v: 1, machineId: controller.machineId, envelope, executionAuthorization: minted.authorization } });
        expect(response.statusCode).toBe(200);
        return openExternalActionResponseV2({ envelope: response.json(), binding, material, request: envelope });
      };
      expect(await readSoftware(homeId, `software-portable-${kind}`)).toMatchObject({ ok: true, result: {
        options: expect.arrayContaining([{ value: { pluginId: 'acme.software', recipeId: 'fonts', revision: '1' },
          label: 'Fonts', version: '1.0.0' }]),
      } });
      expect(softwareReads).toBe(1);
      expect(await readSoftware(uiServerId, `software-profile-${kind}`)).toMatchObject({ ok: false, errorCode: 'unavailable' });
      expect(softwareReads).toBe(1);
    } finally { softwareAccount?.dispose(); await softwareRuntime.dispose(); restoreHttp(); await app.close(); await io.close(); }
  });

  it.each(([
    { mode: 'plain', credentialKind: 'account' },
    { mode: 'e2ee', credentialKind: 'account' },
    { mode: 'plain', credentialKind: 'terminal' },
    { mode: 'e2ee', credentialKind: 'terminal' },
  ] as const).flatMap(scenario => (['stop', 'suspend'] as const).map(intent => ({ ...scenario, intent }))))('executes deferred power through CLI approval and installed controller settlement ($mode/$credentialKind/$intent)', async ({ mode, credentialKind, intent }) => {
    const machineKey = new Uint8Array(32).fill(37);
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const createAccount = async () => {
      const signing = tweetnacl.sign.keyPair();
      return db.account.create({ data: { encryptionMode: mode, publicKey: Buffer.from(signing.publicKey).toString('hex'),
        ...(mode === 'e2ee' ? { contentPublicKey: publicKey,
          contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: publicKey }) } : {}) } });
    };
    const account = await createAccount();
    const homeId = await getOrCreateServerIdentityId();
    const token = await createAccountTokenForTests(account.id, credentialKind === 'terminal'
      ? { kind: 'terminal', authority: 'account_automation' } : { kind: 'account', authority: 'present_user' });
    const credentials: StoredCredentials = { token, credentialProvenance: 'stored_session', encryption: mode === 'plain' ? null
      : { type: 'dataKey', machineKey, publicKey } };
    const identityDirectory = await mkdtemp(join(tmpdir(), 'happier-deferred-identity-'));
    const identityPath = join(identityDirectory, 'installation-identity.json');
    const identity = await readOrCreateInstallationIdentity(identityPath);
    const controller = { machineId: `deferred-controller-${mode}-${credentialKind}-${intent}`,
      installationId: identity.installationId };
    const installation = tweetnacl.sign.keyPair.fromSecretKey(Buffer.from(identity.privateKey, 'base64url'));
    const guestInstallation = tweetnacl.sign.keyPair();
    const guestId = `deferred-guest-${mode}-${credentialKind}-${intent}`;
    const guestInstallationId = `${guestId}-installation`;
    const nativeObservation: ProviderObservationV1 = { observedAt: Date.now(), availability: 'present', power: 'running', storage: 'retained' };
    const nativeIntents: unknown[] = [];
    const provisioner = nativeFixture({ credentialPurposes: [], privateNative: true,
      supportedIntents: ['start', 'stop', 'suspend', 'resume', 'delete'], nativeRoleResults: { inspect: nativeObservation },
      onNativeRole: (role, input) => {
        if (role !== 'power') return;
        const intent = input && typeof input === 'object' && !Array.isArray(input) ? input.intent : undefined;
        nativeIntents.push(intent);
        Object.assign(nativeObservation, { observedAt: Date.now(), power: intent === 'stop' ? 'stopped' : 'suspended' });
      } });
    const manifest = PluginManifestV2Schema.parse(provisioner.runtimeRegistry.contributes.activationTargets[0]!.manifest);
    const declaration = createReleaseLessDeclarationV1(manifest);
    await db.machine.create({ data: { id: controller.machineId, accountId: account.id, installationId: controller.installationId,
      installationPublicKey: installation.publicKey, active: true, lastActiveAt: new Date(),
      metadata: mode === 'plain' ? encodePlainMachineStoredContent({}) : 'opaque',
      dataEncryptionKey: mode === 'plain' ? Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') : null,
      operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } },
      operationProtocolCapabilitiesRevision: 1, pluginMaterializationRevision: BigInt(1) } });
    await db.machine.create({ data: { id: guestId, accountId: account.id, installationId: guestInstallationId,
      installationPublicKey: guestInstallation.publicKey, active: true, lastActiveAt: new Date(),
      metadata: mode === 'plain' ? encodePlainMachineStoredContent({}) : 'opaque',
      dataEncryptionKey: mode === 'plain' ? Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') : null } });
    await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId: homeId,
      machineId: controller.machineId, materializationId: controller.installationId, pluginId: manifest.id,
      version: manifest.version, sourceClass: 'bundledFirstParty', portableRelease: false,
      archiveDigestSha256: declaration.manifestDigestSha256, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
    const io = channel.server;
    const serverUrl = 'https://deferred-power.example';
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [configuration.activeServerId]: {
      id: configuration.activeServerId, name: 'Deferred power', serverUrl, webappUrl: serverUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
      homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId,
        canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] },
    } } }));
    const inventory = createManagedActivityInventory({ producers: [{ read: () => ({ coverage: 'complete', items: [] }), subscribe: () => () => {} }] });
    const drain = createDaemonAdmissionDrain();
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    enableErrorHandlers(app); enableAuthentication(app);
    registerAccountEncryptionRoutes(app); registerAccountSettingsRoutes(app);
    registerPluginAvailabilityRoutes(app); machinesRoutes(app); artifactsRoutes(app);
    registerAccountProfileRoute(app);
    app.get('/v1/features/authenticated', { preHandler: app.authenticate }, async () => FeaturesResponseSchema.parse({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: homeId } } }));
    app.get('/v1/features', async () => FeaturesResponseSchema.parse({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: homeId } } }));
    const homeResponses: Array<{ path: string; status: number; authority?: string; kind?: string; signed?: boolean }> = [];
    app.addHook('onResponse', async (request, reply) => { homeResponses.push({ path: request.url, status: reply.statusCode,
      authority: request.authAuthority, kind: request.authTokenKind, signed: request.externalActionExecutionAuthorized }); });
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: serverUrl });
    // Home discovery uses fetch while Account storage uses Axios. Both network
    // boundaries reach the same real routes, including approval currentness.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== serverUrl) throw new Error(`Unexpected deferred Home origin: ${url.origin}`);
      const response = await app.inject({ method: request.method as 'GET' | 'POST' | 'PATCH',
        url: `${url.pathname}${url.search}`, headers: Object.fromEntries(request.headers.entries()),
        ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { payload: await request.text() }) });
      return new Response(response.payload, { status: response.statusCode,
        headers: { 'content-type': 'application/json' } });
    });
    const policy = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'machines.presets.create': ['cli'] } });
    const installedCredentials: StoredCredentials = { ...credentials,
      token: await createAccountTokenForTests(account.id, { kind: 'terminal', authority: 'account_automation' }) };
    const unavailable = async (): Promise<never> => { throw new Error('Deferred power must not acquire provider credentials'); };
    const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
      purposeBindingOwner: createConnectedAccountPurposeBindingOwner({ store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable,
        subscribe: () => ({ dispose() {} }) }, selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
        projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable }),
      requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
      createRedactionLease: () => ({ add() {}, close() {} }) });
    const operations = createHostActionOperationRuntime({ machineId: controller.machineId, resolveAccountId: async () => account.id });
    const createMachineRpc = (machineId: string, installationId: string, privateKey: Uint8Array) => new RpcHandlerManager({
      scopePrefix: machineId, localMachineId: machineId,
      ...(mode === 'plain' ? { encryptionMode: 'plain' as const }
        : { encryptionMode: 'e2ee' as const, encryptionKey: machineKey, encryptionVariant: 'dataKey' as const }),
      authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, {
        machineId, resolveHomeServerIdentityId: async () => homeId,
        resolveCustodianAccountId: async () => account.id, resolveInstallationId: () => installationId,
        verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, privateKey,
          daemonToken: installedCredentials.token, serverHttpBaseUrl: serverUrl }),
      }, source),
    });
    const controllerRpc = createMachineRpc(controller.machineId, controller.installationId, installation.secretKey);
    const guestRpc = createMachineRpc(guestId, guestInstallationId, guestInstallation.secretKey);
    registerManagedActivityRpcHandlers({ activity: inventory, admissionDrain: drain, rpcHandlerManager: guestRpc,
      commitIdleEvidence: (managedTarget, idle, context) => {
        if (!context.machineAdmission || !drain.isQuiescing()) return null;
        const method = `${guestId}:${MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD}`;
        const decision = { ...idle, confirmedAt: Date.now() };
        return { context: context.machineAdmission, method, managedTarget, decision,
          proof: signMachineInstallationProof({ privateKey: guestInstallation.secretKey, payload: {
            version: 1, machineId: guestId, installationId: guestInstallationId, accountId: account.id,
            rpcAdmission: { context: context.machineAdmission, method, managedTarget, managedIdleDecision: decision },
          } }) };
      } });
    const native = createDaemonManagedMachineActionAdapter({ credentials: installedCredentials, machineId: controller.machineId,
      serverBaseUrl: serverUrl, serverId: configuration.activeServerId,
      installationIdentity: { installationId: controller.installationId, privateKey: installation.secretKey },
      managedProviderOperationAuthority: authority, observeActionExecution: operations.observeExecution,
      resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({ serverUrl,
        resolveCurrentMachineId: () => controller.machineId }),
      acquireRuntimeRegistryLease: async () => ({ registry: provisioner.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }) });
    const daemonExecutor = (admitted?: RequesterAccountActionContext) => createCliActionExecutorFromCredentials({
      credentials: installedCredentials, readCredentials: async () => installedCredentials,
      machineId: controller.machineId, serverId: configuration.activeServerId, serverApiUrl: serverUrl, serverIdentityId: homeId,
      externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: controller.installationId,
      machineActionDirectTargetTransport: { machineId: controller.machineId,
        invoke: (method, input, options) => controllerRpc.invokeLocal(method, input, options) },
      managedMachineAction: native,
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(admitted?.accountSettingsContext.settings.actionsSettingsV1 ?? policy),
        getAccountSettings: () => admitted?.accountSettingsContext.settings ?? AccountSettingsSchema.parse({ actionsSettingsV1: policy }) } });
    registerApprovalRpcHandlers({ rpcHandlerManager: controllerRpc, actionExecutor: daemonExecutor() });
    const rpcFailures: string[] = [];
    // Loopback substitutes authenticated Home delivery. Both endpoints retain
    // their real RPC codecs, admission owners, and registered domain handlers.
    io.on('connection', socket => socket.on(SOCKET_RPC_EVENTS.CALL, (request: SocketRpcRequestPayload, reply: (value: unknown) => void) => {
      void (async () => {
        const token: unknown = socket.handshake.auth.token;
        const actor = typeof token === 'string' ? await auth.verifyTokenForRoute(token) : null;
        if (!actor) throw new Error('Loopback Account socket authentication failed');
        const separator = request.method.indexOf(':');
        const machineId = request.method.slice(0, separator);
        const rpcMethod = request.method.slice(separator + 1);
        if (machineId !== controller.machineId && machineId !== guestId) throw new Error('Unknown loopback Machine');
        if (machineId === guestId) {
          const admitted = await verifyExternalActionMachineRpcExecution(ExternalActionMachineRpcExecutionV1Schema.parse(request.externalActionExecution), {
            method: request.method, requestId: request.requestId, params: request.params, event: SOCKET_RPC_EVENTS.CALL,
          });
          if (admitted?.managedGuestActivity?.machineId !== guestId) throw new Error('Guest activity was not admitted');
        }
        const admitted = await resolveMachineAdmission({ actorAccountId: actor.userId, machineId, rpcMethod,
          callerAuthority: actor.authority });
        if (admitted.kind !== 'admitted') throw new Error(`Loopback Machine admission refused: ${admitted.code}`);
        const { kind: _kind, ...machineAdmission } = admitted;
        const manager = machineId === controller.machineId ? controllerRpc : guestRpc;
        return { ok: true, result: await manager.handleRequest({ method: request.method, params: request.params,
          requestId: request.requestId, callerAuthority: actor.authority, machineAdmission }, undefined, 'authenticated_home_socket') };
      })().then(reply, error => { rpcFailures.push(String(error)); reply({ ok: false, error: String(error) }); });
    }));
    registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io, forwardRpc: async request => {
      const { ExternalActionDaemonDispatchRequestSchema } = await import('@happier-dev/protocol/actions');
      const admitted = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
      const result = await executeExternalAction({ actionId: admitted.actionId, envelope: admitted.envelope,
        principal: admitted.principal, executionAuthorization: admitted.executionAuthorization,
        currentMachineId: controller.machineId, currentInstallationId: controller.installationId,
        currentServerId: configuration.activeServerId, currentServerHttpBaseUrl: serverUrl, currentAccountId: account.id,
        externalActionMachineRequestPrivateKey: installation.secretKey,
        verifyExecutionAuthorization: input => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
          installationId: controller.installationId, privateKey: installation.secretKey, serverHttpBaseUrl: serverUrl }),
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: installedCredentials }), executor: daemonExecutor(),
        resolveEncryption: async () => ({ serverIdentityId: homeId,
          material: { type: 'dataKey', machineKey } }),
        prepareRequesterAccountContext: input => prepareRequesterAccountActionContext({ authorization: input.authorization,
          purpose: { kind: 'external_action' }, machineId: controller.machineId, installationId: controller.installationId,
          installationPrivateKey: installation.secretKey, serverId: configuration.activeServerId, serverIdentityId: homeId,
          serverHttpBaseUrl: serverUrl, ownCredentials: installedCredentials, isCurrent: async () => true, createExecutor: daemonExecutor }),
      });
      return { ok: true, result: result.kind === 'response' ? createExternalActionDaemonDispatchResponse(result.prepared) : result };
    } }) });
    const makeExecutor = (credentials: StoredCredentials) => createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
      serverId: configuration.activeServerId, serverApiUrl: serverUrl, serverIdentityId: homeId,
      machineId: controller.machineId,
      resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl, token: credentials.token,
        fetchImpl: async (url, init) => {
          const target = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
          const response = await app.inject({ method: 'GET', url: `${target.pathname}${target.search}`,
            headers: Object.fromEntries(new Headers(init?.headers).entries()) });
          return new Response(response.payload, { status: response.statusCode,
            headers: { 'content-type': 'application/json' } });
        } }),
      actionsSettingsProvider: { getActionsSettings: () => policy,
        getAccountSettings: () => AccountSettingsSchema.parse({ actionsSettingsV1: policy }) } });
    const executor = makeExecutor(credentials);
    const context = { surface: 'cli', authority: 'present_user', serverId: configuration.activeServerId } as const;
    const identityPathDescriptor = Object.getOwnPropertyDescriptor(configuration, 'installationIdentityFile')!;
    Object.defineProperty(configuration, 'installationIdentityFile', { ...identityPathDescriptor, value: identityPath });
    try {
      const claim = await app.inject({ method: 'POST', url: PluginAvailabilityActionHttpPathsV1['account.plugins.availability.collectionWriters.claim'],
        headers: { authorization: `Bearer ${token}` }, payload: { manifest } });
      expect(claim.statusCode, claim.payload).toBe(200);
      const presetId = `deferred-preset-${mode}-${credentialKind}-${intent}`;
      expect(await executor.execute('machines.presets.create', { id: presetId, homeId, name: 'Deferred guest',
        owner: { kind: 'account', accountId: account.id }, controller,
        launch: { provider: { pluginId: manifest.id, localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false }, context)).toMatchObject({ ok: true });
      const admitted = ManagedAdmissionOutputV1Schema.parse(await admitManagedAcquire({ custodianAccountId: account.id,
        requesterAccountId: account.id, requestEnvelopeDigest: 'deferred-power-fixture', input: {
          requestId: `deferred-acquire-${mode}-${credentialKind}-${intent}`, continuationPresent: false, input: {
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
            selection: { kind: 'preset', homeId, id: presetId, revision: 0 },
            controller, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
          },
        } }));
      // The retained native resource is the OS boundary; no VM/process runs in this test.
      await db.managedMachine.update({ where: { id: admitted.machine.id }, data: { allocation: 'bound', creationState: 'active',
        enrolledMachineId: guestId,
        resource: { contributionRef: admitted.machine.launch.provider, schemaVersion: 1, value: {} } } });
      let intentRevision = 0;
      for (const permitted of [true, false]) {
        const actorAccount = permitted ? account : await createAccount();
        const actorCredentials = permitted ? credentials : { ...credentials, token: await createAccountTokenForTests(
          actorAccount.id, credentialKind === 'terminal' ? { kind: 'terminal', authority: 'account_automation' }
            : { kind: 'account', authority: 'present_user' }) };
        const actor = permitted ? executor : makeExecutor(actorCredentials);
        const proposed = await actor.execute('machines.managed.power.set', {
          homeId, managedId: admitted.machine.id, when: 'after-idle', intent,
        }, { ...context, authority: 'account_automation', actionRequestId: `deferred-${intent}-${mode}-${credentialKind}-${permitted}` });
        if (!permitted && !proposed.ok) {
          expect(proposed).toMatchObject({ ok: false, errorCode: 'permission_denied', failureCause: {
            phase: 'machines.managed.power.set', errorClass: 'ManagedMachineControllerError',
            errorCode: 'permission_denied', httpStatus: 403,
          } });
          expect(nativeIntents).toEqual([intent]);
          continue;
        }
        expect(proposed, JSON.stringify({ proposed, homeResponses })).toMatchObject({ ok: true,
          result: { kind: 'approval_request_created', actionId: 'machines.managed.power.set' } });
        if (!proposed.ok || !proposed.result || typeof proposed.result !== 'object' || !('artifactId' in proposed.result)
          || typeof proposed.result.artifactId !== 'string') throw new Error('Missing deferred approval');
        const artifactId = proposed.result.artifactId;
        const approval = await runWithServerHttpBaseUrl(serverUrl, () => createCliApprovalsArtifactStore({
          credentials: actorCredentials, serverId: configuration.activeServerId, serverHttpBaseUrl: serverUrl,
        }).approvalsGet({ artifactId }));
        expect(approval).toMatchObject({ v: 2, approval: { flow: 'deferred' }, executionOriginV1: { authority: 'account_automation' } });
        if (permitted) {
          expect(await db.managedMachine.findUniqueOrThrow({ where: { id: admitted.machine.id } }))
            .toMatchObject({ intentRevision: 0 });
        }
        // The automation's origin stays on the proposal; a signed-in person
        // makes the approval decision, including for terminal-origin requests.
        const decider = makeExecutor({ ...actorCredentials, token: await createAccountTokenForTests(
          actorAccount.id, { kind: 'account', authority: 'present_user' }) });
        const decided = await decider.execute('approval.request.decide', {
          artifactId, decision: 'approve',
        }, context);
        if (permitted) intentRevision += 1;
        expect(decided, JSON.stringify({ decided, homeResponses, rpcFailures })).toMatchObject({ ok: true, result: permitted
          ? { status: 'executed', execution: { ok: true, result: { kind: 'accepted', managedId: admitted.machine.id, intentRevision } } }
          : { status: 'failed', execution: { ok: false, errorCode: 'permission_denied', failureCause: {
            phase: 'machines.managed.power.set', errorClass: 'ManagedMachineControllerError', errorCode: 'permission_denied', httpStatus: 403,
          } } } });
        if (permitted) {
          if (!decided.ok || !decided.result || typeof decided.result !== 'object' || !('execution' in decided.result)) {
            throw new Error('Missing approved deferred power execution');
          }
          const execution = ApprovalExecutionV2Schema.parse(decided.result.execution);
          if (!execution.ok) throw new Error(execution.errorCode);
          const accepted = ManagedIntentResultSchema.parse(execution.result);
          if (accepted.kind !== 'accepted') throw new Error('Deferred power was not accepted');
          expect(accepted.operation?.operationId).toBeTruthy();
          if (!accepted.operation) throw new Error('Deferred power has no live controller operation');
          expect(await operations.handlers.getV2({ operationId: accepted.operation.operationId, waitForTerminal: true }))
            .toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
          expect(approval).toMatchObject({ executionOriginV1: { machineId: controller.machineId,
            target: { kind: 'machine', machineId: controller.machineId },
          } });
        }
        const observed = await executor.execute('machines.managed.get', { homeId, managedId: admitted.machine.id }, context);
        expect(observed).toMatchObject({ ok: true, result: { desired: intent, desiredWhen: 'after-idle', intentRevision,
            observation: { availability: 'present', power: intent === 'stop' ? 'stopped' : 'suspended' },
        } });
        if (!observed.ok) throw new Error(observed.errorCode);
        expect(ManagedMachineV1Schema.parse(observed.result).submittedNativeEffect).toBeUndefined();
        expect(nativeIntents).toEqual([intent]);
      }
      expect(homeResponses.filter(response => response.path.endsWith('/admit-control') && response.status === 200)).toHaveLength(1);
      expect(homeResponses.filter(response => response.path.endsWith('/submit-intent') && response.status === 200))
        .toMatchObject([{ signed: true }]);
      const nativeSubmit = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/submit-intent',
        headers: { authorization: `Bearer ${token}` }, payload: { homeId, managedId: admitted.machine.id,
          expectedIntentRevision: intentRevision, requestId: `deferred-${intent}-${mode}-${credentialKind}-true` } });
      expect(nativeSubmit.statusCode, nativeSubmit.payload).toBe(403);
      expect(nativeSubmit.json()).toMatchObject({ code: 'permission_denied' });
      const terminalToken = await createAccountTokenForTests(account.id, { kind: 'terminal', authority: 'account_automation' });
      const terminalSubmit = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/submit-intent',
        headers: { authorization: `Bearer ${terminalToken}` }, payload: { homeId, managedId: admitted.machine.id,
          expectedIntentRevision: intentRevision, requestId: `deferred-${intent}-${mode}-${credentialKind}-true` } });
      expect(terminalSubmit.statusCode, terminalSubmit.payload).toBe(403);
      expect(terminalSubmit.json()).toMatchObject({ code: 'permission_denied' });
      expect(homeResponses.filter(response => /\/report-intent$/.test(response.path))).toMatchObject([
        { status: 200, signed: true },
      ]);
    } finally {
      Object.defineProperty(configuration, 'installationIdentityFile', identityPathDescriptor);
      await rm(identityDirectory, { recursive: true, force: true });
      inventory.dispose(); restoreHttp(); await app.close();
    }
  });

  it.each([
    { memberMode: 'plain', credentialKind: 'account', identityKind: 'guestProcess' },
    { memberMode: 'e2ee', credentialKind: 'account', identityKind: 'guestProcess' },
    { memberMode: 'e2ee', credentialKind: 'terminal', identityKind: 'guestProcess' },
    { memberMode: 'e2ee', credentialKind: 'account', identityKind: 'dedicatedDaemonUser' },
    { memberMode: 'e2ee', credentialKind: 'terminal', identityKind: 'dedicatedDaemonUser' },
    { memberMode: 'e2ee', credentialKind: 'account', identityKind: 'dedicatedDaemonUser', requireChildReview: true },
  ] as const)('delivers a named delegated preset acquire through installed controller admission ($credentialKind/$memberMode/$identityKind/$requireChildReview)', async (vector) => {
    const { memberMode, credentialKind, identityKind } = vector;
    const requireChildReview = 'requireChildReview' in vector && vector.requireChildReview;
    const machineKey = new Uint8Array(32).fill(49);
    const signing = tweetnacl.sign.keyPair();
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const member = await db.account.create({ data: memberMode === 'plain' ? { encryptionMode: 'plain' } : { encryptionMode: 'e2ee', publicKey: Buffer.from(signing.publicKey).toString('hex'),
      contentPublicKey: publicKey, contentPublicKeySig: signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: publicKey }) } });
    const team = await db.team.create({ data: { name: 'Named delegated acquire' } });
    await db.teamMembership.createMany({ data: [{ teamId: team.id, accountId: owner.id, role: 'admin' },
      { teamId: team.id, accountId: member.id, role: 'member' }] });
    const homeId = await getOrCreateServerIdentityId();
    const installation = tweetnacl.sign.keyPair();
    const fixtureId = `${credentialKind}-${memberMode}-${identityKind}-${requireChildReview ? 'require' : 'default'}`;
    const controller = { machineId: `named-preset-controller-${fixtureId}`, installationId: `named-preset-installation-${fixtureId}` };
    const nativeLaunches: unknown[] = [];
    // The external provider refuses acquisition; all Home/controller owners stay real.
    const provisioner = nativeFixture({ credentialPurposes: [],
      nativeRoleResults: { acquire: { kind: 'rejected', code: 'provider_unavailable' } },
      onNativeRole: (role, input) => { if (role === 'acquire') nativeLaunches.push(input); } });
    const manifest = PluginManifestV2Schema.parse(provisioner.runtimeRegistry.contributes.activationTargets[0]!.manifest);
    const declaration = createReleaseLessDeclarationV1(manifest);
    await db.machine.create({ data: { id: controller.machineId, accountId: owner.id, installationId: controller.installationId,
      installationPublicKey: installation.publicKey, metadata: encodePlainMachineStoredContent({}),
      dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'), active: true, lastActiveAt: new Date(),
      operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } },
      operationProtocolCapabilitiesRevision: 1, pluginMaterializationRevision: BigInt(1) } });
    await db.pluginMachineMaterialization.create({ data: { accountId: owner.id, serverIdentityId: homeId,
      machineId: controller.machineId, materializationId: controller.installationId, pluginId: manifest.id,
      version: manifest.version, sourceClass: 'bundledFirstParty', portableRelease: false,
      archiveDigestSha256: declaration.manifestDigestSha256, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
    const serverUrl = 'https://named-delegated-preset.example';
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    enableErrorHandlers(app); enableAuthentication(app);
    registerAccountEncryptionRoutes(app); registerAccountSettingsRoutes(app); registerAccountProfileRoute(app);
    registerPluginAvailabilityRoutes(app); machinesRoutes(app);
    app.get('/v1/features', async () => FeaturesResponseSchema.parse({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: homeId } } }));
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: serverUrl });
    const ownerToken = await createAccountTokenForTests(owner.id, { kind: 'account', authority: 'present_user' });
    const memberToken = await createAccountTokenForTests(member.id, { kind: credentialKind,
      authority: credentialKind === 'terminal' ? 'account_automation' : 'present_user' });
    const policy = normalizeActionsSettingsV1({ v: 1, ...(requireChildReview ? { actions: {
      'machines.agentIsolation.set': { approvalRequiredSurfaces: ['cli'] } } } : {}), approvalWaivedSurfaces: { 'machines.presets.create': ['cli'], 'machines.managed.acquire': ['cli'] } });
    const makeExecutor = (credentials: StoredCredentials) => createCliActionExecutorFromCredentials({
      credentials, readCredentials: async () => credentials, serverId: configuration.activeServerId,
      serverApiUrl: serverUrl, serverIdentityId: homeId,
      resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl, token: credentials.token,
        fetchImpl: async (url, init) => {
          const target = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
          const response = await app.inject({ method: 'GET', url: `${target.pathname}${target.search}`,
            headers: Object.fromEntries(new Headers(init?.headers).entries()) });
          return new Response(response.payload, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
        } }),
      actionsSettingsProvider: { getActionsSettings: () => policy,
        getAccountSettings: () => AccountSettingsSchema.parse({ actionsSettingsV1: policy }) } });
    const installedCredentials: StoredCredentials = { token: await createAccountTokenForTests(owner.id,
      { kind: 'terminal', authority: 'account_automation' }), encryption: null };
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [configuration.activeServerId]: {
      id: configuration.activeServerId, name: 'Delegated acquire', serverUrl, webappUrl: serverUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
      homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId,
        canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] },
    } } }));
    const unavailable = async (): Promise<never> => { throw new Error('This provider has no credential purposes'); };
    const providerAuthority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
      purposeBindingOwner: createConnectedAccountPurposeBindingOwner({ store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable,
        subscribe: () => ({ dispose() {} }) }, selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
        projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable }),
      requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
      createRedactionLease: () => ({ add() {}, close() {} }) });
    const operations = createHostActionOperationRuntime({ machineId: controller.machineId,
      custodyBinding: { serverId: configuration.activeServerId, installationId: controller.installationId },
      resolveAccountId: async () => owner.id });
    const native = createDaemonManagedMachineActionAdapter({ credentials: installedCredentials, machineId: controller.machineId,
      serverBaseUrl: serverUrl, serverId: configuration.activeServerId,
      installationIdentity: { installationId: controller.installationId, privateKey: installation.secretKey },
      managedProviderOperationAuthority: providerAuthority, observeActionExecution: operations.observeExecution,
      resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({ serverUrl,
        resolveCurrentServerIdentityId: () => homeId, resolveCurrentMachineId: () => controller.machineId }),
      acquireRuntimeRegistryLease: async () => ({ registry: provisioner.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }) });
    const daemonExecutor = (admitted?: RequesterAccountActionContext) => createCliActionExecutorFromCredentials({
      credentials: installedCredentials, readCredentials: async () => installedCredentials,
      machineId: controller.machineId, serverId: configuration.activeServerId, serverApiUrl: serverUrl, serverIdentityId: homeId,
      externalActionMachineRequestPrivateKey: installation.secretKey, externalActionMachineInstallationId: controller.installationId,
      managedMachineAction: native,
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(admitted?.accountSettingsContext.settings.actionsSettingsV1 ?? policy),
        getAccountSettings: () => admitted?.accountSettingsContext.settings ?? AccountSettingsSchema.parse({ actionsSettingsV1: policy }) } });
    registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io: channel.server, forwardRpc: async request => {
      const { ExternalActionDaemonDispatchRequestSchema } = await import('@happier-dev/protocol/actions');
      const admitted = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
      // The network substitute must run the real relay guard, which captures
      // the Machine admission carried by live RPC ingress.
      const recipient = createFakeSocket({ data: { clientType: 'machine-scoped', userId: owner.id,
        machineId: controller.machineId, [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: controller.installationId } });
      if (!request.targetGuard || (await request.targetGuard.filterTargets([recipient])).length !== 1)
        throw new Error('Controller transport was not admitted');
      const machineAdmission = await request.createMachineAdmission?.();
      const result = await executeExternalAction({ actionId: admitted.actionId, envelope: admitted.envelope,
        principal: admitted.principal, executionAuthorization: admitted.executionAuthorization,
        currentMachineId: controller.machineId, currentInstallationId: controller.installationId,
        ...(machineAdmission ? { machineAdmission } : {}),
        currentServerId: configuration.activeServerId, currentServerHttpBaseUrl: serverUrl, currentAccountId: owner.id,
        externalActionMachineRequestPrivateKey: installation.secretKey,
        verifyExecutionAuthorization: input => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
          installationId: controller.installationId, privateKey: installation.secretKey, serverHttpBaseUrl: serverUrl }),
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: installedCredentials }), executor: daemonExecutor(),
        resolveEncryption: async () => ({ serverIdentityId: homeId, material: { type: 'dataKey', machineKey } }),
        prepareRequesterAccountContext: input => prepareRequesterAccountActionContext({ authorization: input.authorization,
          purpose: { kind: 'external_action' }, machineId: controller.machineId, installationId: controller.installationId,
          installationPrivateKey: installation.secretKey, serverId: configuration.activeServerId, serverIdentityId: homeId,
          serverHttpBaseUrl: serverUrl, ownCredentials: installedCredentials, isCurrent: async () => true, createExecutor: daemonExecutor }),
      });
      return { ok: true, result: result.kind === 'response' ? createExternalActionDaemonDispatchResponse(result.prepared) : result };
    } }) });
    const context = { surface: 'cli', authority: 'present_user', serverId: configuration.activeServerId } as const;
    const presetId = `named-delegated-preset-${fixtureId}`;
    try {
      const claim = await app.inject({ method: 'POST', url: PluginAvailabilityActionHttpPathsV1['account.plugins.availability.collectionWriters.claim'],
        headers: { authorization: `Bearer ${ownerToken}` }, payload: { manifest } });
      expect(claim.statusCode, claim.payload).toBe(200);
      expect(await makeExecutor({ token: ownerToken, encryption: null }).execute('machines.presets.create', {
        id: presetId, homeId, name: 'Reusable preset', owner: { kind: 'team', teamId: team.id }, controller,
        launch: { provider: { pluginId: manifest.id, localId: 'vm' }, schemaVersion: 1, name: 'Saved launch', choices: {} },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, teamAcquireDelegated: true,
      }, context)).toMatchObject({ ok: true, result: { kind: 'saved' } });
      const memberExecutor = makeExecutor({ token: memberToken, encryption: memberMode === 'plain' ? null : { type: 'dataKey', machineKey, publicKey } });
      for (const name of [undefined, 'fix-g1-provider-1112']) {
        const requestId = `${name ? 'named' : 'default'}-delegated-acquire-${fixtureId}`;
        const result = await memberExecutor.execute('machines.managed.acquire', {
          selection: { kind: 'preset', homeId, id: presetId, revision: 0, ...(name ? { name } : {}) },
          retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
          enrollmentIdentity: identityKind === 'guestProcess' ? { kind: 'guestProcess', role: 'sandbox' }
            : { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'none' },
        }, { ...context, actionRequestId: requestId });
        if (requireChildReview) {
          // An admitted parent never waives explicit child Require or moves
          // the requester's private Ask into the controller's Account.
          expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
          expect(nativeLaunches).toHaveLength(0);
          expect(await db.artifact.count({ where: { accountId: owner.id } })).toBe(0);
          return;
        }
        expect(result, JSON.stringify(result)).not.toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        if (!result.ok) throw new Error(result.errorCode);
        const accepted = ManagedAcceptedV1Schema.parse(result.result);
        if (!accepted.operation) throw new Error('Acquisition has no controller operation');
        expect(await operations.handlers.getV2({ operationId: accepted.operation.operationId, waitForTerminal: true }))
          .toMatchObject({ kind: 'found', operation: { state: 'failed' } });
        expect(nativeLaunches, JSON.stringify(result)).toHaveLength(name ? 2 : 1);
        const retained = await db.managedMachine.findFirst({ where: { homeId, admittedActionRequestId: requestId },
          select: { custodianAccountId: true, admittedInput: true, launch: true, reviewedFacts: true } });
        expect(retained, JSON.stringify({ requestId, result })).toMatchObject({
          custodianAccountId: owner.id, admittedInput: { enrollmentAccountId: member.id },
          ...(name ? { launch: { name }, reviewedFacts: { launch: { name } } } : {}),
        });
      }
    } finally { restoreHttp(); await app.close(); }
  });

  it('claims a release-less provisioner, saves a preset through the real Home Action adapter, and preserves it through disable/re-enable', async () => {
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const homeId = await getOrCreateServerIdentityId();
    const token = await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
    const credentials: StoredCredentials = { token, encryption: null };
    const controller = { machineId: 'preset-seam-controller', installationId: 'preset-seam-installation' };
    const provisioner = nativeFixture({ credentialPurposes: [] });
    const manifest = PluginManifestV2Schema.parse(provisioner.runtimeRegistry.contributes.activationTargets[0]!.manifest);
    const declaration = createReleaseLessDeclarationV1(manifest);
    await db.machine.create({ data: { id: controller.machineId, accountId: account.id, installationId: controller.installationId,
      metadata: '{}', pluginMaterializationRevision: BigInt(1) } });
    // Installed Machine inventory is the external daemon-report boundary.
    await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId: homeId,
      machineId: controller.machineId, materializationId: controller.installationId, pluginId: manifest.id,
      version: manifest.version, sourceClass: 'bundledFirstParty', portableRelease: false,
      archiveDigestSha256: declaration.manifestDigestSha256, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
    const serverUrl = 'https://preset-seam.example';
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
    enableErrorHandlers(app); enableAuthentication(app);
    registerAccountEncryptionRoutes(app); registerAccountSettingsRoutes(app);
    registerPluginAvailabilityRoutes(app); machinesRoutes(app);
    app.get('/v1/features', async () => FeaturesResponseSchema.parse({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: homeId } } }));
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: serverUrl });
    const policy = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
      'machines.presets.create': ['cli'],
    } });
    const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
      serverId: configuration.activeServerId, serverApiUrl: serverUrl, serverIdentityId: homeId,
      actionsSettingsProvider: { getActionsSettings: () => policy,
        getAccountSettings: () => AccountSettingsSchema.parse({ actionsSettingsV1: policy }) } });
    const context = { surface: 'cli', authority: 'present_user', serverId: configuration.activeServerId } as const;
    const input = { id: 'preset-seam', homeId, name: 'Future guest', owner: { kind: 'account', accountId: account.id }, controller,
      launch: { provider: { pluginId: manifest.id, localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      environment: { scripts: [{ body: 'echo setup' }] }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } as const;
    try {
      // Availability's private host protocol is not a public Action id. Use its
      // real authenticated route rather than inventing a public executor path.
      const claimId = 'account.plugins.availability.collectionWriters.claim';
      const claimed = await app.inject({ method: 'POST', url: PluginAvailabilityActionHttpPathsV1[claimId],
        headers: { authorization: `Bearer ${token}` }, payload: { manifest } });
      expect(claimed.statusCode, claimed.payload).toBe(200);
      expect(PluginAvailabilityActionOutputSchemasV1[claimId].parse(claimed.json()))
        .toMatchObject({ intent: { pluginId: manifest.id, desiredVersion: null, enabled: true, revision: '0' } });
      const created = await executor.execute('machines.presets.create', input, context);
      expect(created).toMatchObject({ ok: true });
      if (!created.ok) throw new Error(`Preset refused: ${created.errorCode}`);
      const saved = MachinePresetActionOutputSchemasV1['machines.presets.create'].parse(created.result);
      expect(saved).toEqual({ kind: 'saved', preset: { ...input, revision: 0 } });
      expect(await db.managedMachine.count({ where: { custodianAccountId: account.id } })).toBe(0);
      expect((await db.managedMachinePreset.findUniqueOrThrow({ where: { id: input.id } })).launch).toEqual(input.launch);
      const changeIntent = async (enabled: boolean, expectedRevision: string) => {
        const actionId = 'account.plugins.availability.intent.set';
        const response = await app.inject({ method: 'POST', url: PluginAvailabilityActionHttpPathsV1[actionId],
          headers: { authorization: `Bearer ${token}` }, payload: {
            pluginId: manifest.id, desiredVersion: null, enabled, offlineUiHosting: 'disabled', writableCollections: [], expectedRevision,
          } });
        expect(response.statusCode, response.payload).toBe(200);
        return PluginAvailabilityActionOutputSchemasV1[actionId].parse(response.json());
      };
      expect(await changeIntent(false, '0')).toMatchObject({ intent: { enabled: false, revision: '1' } });
      expect(await executor.execute('machines.presets.get', { homeId, id: input.id }, context))
        .toEqual({ ok: true, result: { kind: 'found', preset: { ...input, revision: 0 } } });
      expect(await executor.execute('machines.presets.create', { ...input, id: 'disabled-preset' }, context))
        .toEqual({ ok: true, result: { kind: 'refused', code: 'provider_unavailable' } });
      expect(await changeIntent(true, '1')).toMatchObject({ intent: { enabled: true, revision: '2' } });
      expect((await db.accountPluginIntent.findUniqueOrThrow({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } } })).releaseLessDeclaration)
        .toEqual(declaration);
      expect(await executor.execute('machines.presets.create', { ...input, id: 'reenabled-preset' }, context))
        .toEqual({ ok: true, result: { kind: 'saved', preset: { ...input, id: 'reenabled-preset', revision: 0 } } });
      expect(MachinePresetActionOutputSchemasV1['machines.presets.create'].safeParse({ ...saved, unexpected: true }).success).toBe(false);
      const admitted = ManagedAdmissionOutputV1Schema.parse(await admitManagedAcquire({ custodianAccountId: account.id,
        requesterAccountId: account.id, requestEnvelopeDigest: 'preset-seam-reviewed', input: {
          requestId: 'preset-seam-acquire', continuationPresent: false, input: {
            enrollmentIdentity: { kind: 'existingUser', role: 'personal' },
            selection: { kind: 'preset', homeId, id: input.id, revision: 0 }, controller,
            retention: input.retention, wakeOnAcceptedMessage: false,
          },
        } }));
      const current = ManagedMachineV1Schema.parse(admitted.machine);
      expect(current).toMatchObject({ preset: { id: input.id, revision: 0 }, launch: input.launch,
        machineSetup: { environment: input.environment, state: 'pending' } });
      expect(await executor.execute('machines.managed.get', { homeId, managedId: current.id }, context))
        .toEqual({ ok: true, result: current });
    } finally { restoreHttp(); await app.close(); }
  });
});

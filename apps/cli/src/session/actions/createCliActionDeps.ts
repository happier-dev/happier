import { homedir } from 'node:os';
import { projectCurrentSessionPresentationActionResult } from '@/session/presentation/currentSessionPresentationService';
import { flattenWidgetLayoutWidgetsV1 } from '@happier-dev/protocol/widgets';
import axios from 'axios';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readMachineReferenceCensusV1, type MachineReferenceCensusV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { ManagedGetInputV1Schema, ManagedGetOutputV1Schema, ManagedDeleteInputV1Schema,
  managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachinePoolListOutputV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { listAutomationDefinitions } from '@/api/automations';
import { createCliProfileStore, createCliProfileStoreForOperation } from '@/settings/profiles/profileStore';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { NotificationChannelCatalogSnapshotV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { refreshActiveProfileCatalog } from '@/settings/profiles/hydrateProfileCatalog';
import type { ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { withdrawPendingQueueV2Message } from '@/api/session/pendingQueueV2Transport';
import { createServerUrlComparableKey } from '@happier-dev/protocol/server/urls/serverUrlComparableKey';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { ArtifactAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { StoredContentPublicSharesListResponseV1Schema } from '@happier-dev/protocol/sharing/storedContentPublicShareV1';
import { PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS, PROJECT_DEFINITION_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { ProjectWorkerActionInputSchemasV1, ProjectWorkerActionOutputSchemasV1 } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { updatePersonalProjectContextV1 } from '@happier-dev/protocol/projects/projectContextV1';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { readProjectAccountRows, createProjectAccountSnapshotMutation, mutateProjectAccountOrganization, mutateProjectAccountRows,
  type OpenedProjectAccountRowMutationRequest, type ProjectAccountRowsInput } from '@/workspaces/projectAccountRows';
import { readProjectLastOpenedMemoryMap } from '@/workspaces/projectLastOpenedMemory';
import { buildProjectLastOpenedMemoryKeyV1 } from '@happier-dev/protocol/account/authoringMemory';
import { projectProjectListV1 } from '@happier-dev/protocol/workspaces';
import { setProjectVisibilityV1 } from '@happier-dev/protocol/projects/projectVisibilityV1';
import { postWebhookJsonAsync, WebhookDestinationAdmissionError } from '@/notifications/activity/sendWebhookActivityNotification';
import { createCliSettingsDeclarationAction } from './settingsDeclarationAction';
import { createCliPromptLibraryStore } from '@/settings/prompts/promptLibraryStore';
import { getServerProfile } from '@/server/serverProfiles';
import { MachineAdministrationTargetV1Schema } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { readCliMemoryInheritedContext, readCliMemoryScopeContext } from './readCliMemoryInheritedContext';
import { createCliProjectTrustAction } from './projectTrustAction';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1, PROJECT_ACTION_OUTPUT_SCHEMAS_V1, PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { resolveProjectActionMachineV1 } from '@happier-dev/protocol/actions/executor/projectActionPlacement';
import { createCliProjectSourceActionDeps } from './projectSourceActionDeps';
import { admitSessionContextIntentV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { admitDeclaredSessionVoicePreferenceV1 } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { withCliPromptLibraryArtifactReader, resolveCliPromptStackSystemAppendBlocks } from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import { PromptStackPreparationError } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { applyTodoSessionLinkV1, TodoSessionLinkErrorV1, TodoSessionLinkInputV1Schema, projectTodoSessionLinkFailureV1 } from '@happier-dev/protocol/todos/todoSessionLinkV1';
import { createCliAccountKvJsonTransport } from '@/api/client/accountKvJsonTransport';
import { readCliWidgetCatalogProjectionV1, cliWidgetCatalogEntryV1 } from './widgetCatalogProjection';
import { createCliWidgetInputActionDepsV1 } from './widgetInputActionDeps';
import { createCliWidgetAreaActionDepsV1 } from './widgetAreaActionDeps';
import { createCliWidgetDefinitionActionDepsV1 } from './widgetDefinitionActionDeps';
import { BUILTIN_WIDGET_DESCRIPTORS_V1, countWidgetInstancesV1, isSameWidgetDefinitionV1, widgetCandidateDefinitionV1 } from '@happier-dev/protocol/widgets/builtinWidgetDescriptorV1';
import { readWidgetActionSurfacePortV1 } from '@happier-dev/protocol/widgets/executeWidgetInstanceActionV1';
import { createHomeHubArtifactPortV1 } from '@happier-dev/protocol/home/homeHubArtifactV1';
import type { HomeHubLayoutValue } from '@happier-dev/protocol/home';
import { SessionWorkerPublishInputV1Schema, workerDeliverablesBelongToSessionV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';
import type { SessionWorkerPublishInputV1 } from '@happier-dev/protocol';
import { SessionAwarenessProjectionV1Schema } from '@happier-dev/protocol/sessions/awareness/projectionV1';
import { projectSessionAwarenessV1 } from '@happier-dev/protocol/sessions/awareness/projectV1';
import { waitForSessionAwarenessV1 } from '@happier-dev/protocol/sessions/awareness/waitV1';
import { openSessionEventSource } from '@/session/transport/socket/sessionSocketAgentState';
import { createCliConnectedServiceAction } from './connectedServiceActionDeps';
import { createCliProfileActionExecuteV1 } from './cliActionDeps/createCliProfileActionDeps';
import { createCliMcpServerActionExecuteV1 } from './cliActionDeps/createCliMcpServerActionDeps';
import { createCliProviderActionExecuteV1 } from './cliActionDeps/createCliProviderActionDeps';
import { createUsageSourceActionPort } from '@happier-dev/protocol/actions/executor/usageSourceActions';
import { createCliRemoteHostActionExecuteV1 } from './cliActionDeps/createCliRemoteHostActionDeps';
import { randomUUID } from 'node:crypto';
import { admitScmRemotePolicy } from '@happier-dev/protocol/scm/remotePolicy';
import { admitScmCommitPolicy, admitScmCommitUndoLast } from '@happier-dev/protocol/scm/capabilities';
import { ScmBackendDescribeResponseSchema, ScmRemoteRequestSchema, ScmCommitCreateRequestSchema } from '@happier-dev/protocol/scm';
import type { ScmCapabilities } from '@happier-dev/protocol/scm';
import { ScmPullRequestOpenOrReuseResponseSchema } from '@happier-dev/protocol/scm/pullRequests';
import { SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1, SessionPullRequestBindingResultV1Schema,
  type SessionPullRequestBindingInputV1 } from '@happier-dev/channels-protocol/v1';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { createUnavailableRuntimeActionExecutor } from '@happier-dev/protocol/actions/executor/dispatch';
import { DaemonLocalServiceLauncherStartRequestV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { LocalServiceActionRequestV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { resolveLocalServiceActionKindForRuntimeActionId } from '@happier-dev/protocol/actions/specs/localServices';
import type { RpcLocalActionContext } from '@/api/rpc/types';
import { resolveFilesystemAccessPolicy, type FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { resolveCwd } from '@/scm/runtime';
import type { SessionActionRpcOriginV1 } from '@happier-dev/protocol/socketRpc';
import { resolveSessionRoleRpcOrigin } from './sessionRoleRpcOrigin';
import { isWorkflowRunExecutorStorageOperationV1 } from '@happier-dev/protocol/workflows/workflowRunStorageV1';

import { AGENT_SIGN_IN_PREPARE_RPC_METHOD, AGENT_SIGN_IN_STATUS_RPC_METHOD, AgentSignInStatusResponseSchema } from '@happier-dev/protocol/daemon/agentSignIn';
import { readAgentStartCallerWorkDepthV1, AgentStartSessionCallerV1Schema, AgentStartRefusalV1Schema } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { isTerminalAutomationRunStateV3 } from '@happier-dev/protocol/automations/automationRunStateV3';
import { isExecutionRunTerminalStatus } from '@happier-dev/protocol/execution/runs/waitForTerminal';
import { createArtifactAccessActionsV1 } from '@happier-dev/protocol/actions/executor/artifactAccessActions';
import { createLaunchProfilePublisherV1 } from '@happier-dev/protocol/launchProfiles/publishLaunchProfile';
import { createWorkBoardArtifactPortV1 } from '@happier-dev/protocol/boards/workBoardArtifactV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { resolveWorkflowRunDataKeyV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { resolveWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionResolverV1';
import { formatWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';
import { buildSessionPermissionRespondRpcParamsV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { SESSION_PERMISSION_MODES } from '@happier-dev/protocol/sessions/metadata/permission-modes';
import { isPermissionModeGrantedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ConnectedAccountAttemptResponseSchema, CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { startMachineAgentSignIn, cancelMachineAgentSignIn, restartMachineAgentSignIn } from '@happier-dev/protocol/daemon/startAgentSignIn';
import { buildMachineAgentsDetectRequest, buildMachineAgentInventoryDescriptors, projectMachineAgentsDetectResponse, MachineAgentInventoryUnavailableError } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { DaemonAgentInstallStartResponseSchema, DaemonAgentInstallReadResponseSchema, DaemonAgentInstallCancelResponseSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { DaemonTerminalEnsureResponseSchema, DaemonTerminalListResponseV1Schema, DaemonTerminalCloseResponseSchema } from '@happier-dev/protocol/daemon/terminal';
import { DaemonWorkspaceFileSearchResponseSchema } from '@happier-dev/protocol/machines/workspaceFiles';
import { projectSessionActivityCompatibilityV1, SESSION_LIST_AWARENESS_VIEW_V1 } from '@happier-dev/protocol/sessions/awareness/action';
import { projectSessionFollowSourceKeyPreparationAfterSetV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import type { SessionFollowSourceKeyPreparationResultV1, ResolvedRolesSnapshotV1, PluginRoleContributionV1, SpawnConfigOptionValue, SessionBridgeLifecycleHookEventIdV1, SessionModelSelectionV1, SessionUsageLimitRecoveryResumePromptModeV1, SessionUsageLimitRecoveryV1, ActionExecutorDeps, ActionExecutorContext, BackendTargetRefV2, ScmDiffSummaryGenerateInput, PromptRegistryFetchedItemV1, SessionSpawnNewInputV2, SessionSpawnNewResultV1, SessionCreationDirectoryApprovalV1, SessionCreationTargetPreparationRequestV1, SessionCreationTargetPreparationResultV1, AgentExecutionTargetV1, ActionCaller, ComposerAttachmentInputV1, SessionInputAdmissionResultV1, SessionMessageSendResultV1 } from '@happier-dev/protocol';
import { AcpConfigOptionOverridesV1Schema, buildAcpConfigOptionOverridesV1 } from '@happier-dev/protocol/sessions/metadata/overrides';
import { AccountSettingMutationV1Schema } from '@happier-dev/protocol/account/settings/accountSettingMutationV1';
import { BackendTargetRefV2Schema, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { derivePluginSessionInputLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { isMemoryDocumentSearchHitV1, negotiateMemorySearchV1 } from '@happier-dev/protocol/memory/memorySearch';
import { MemoryStatusV1Schema } from '@happier-dev/protocol/memory/memoryStatus';
import { MemoryWindowV1Schema } from '@happier-dev/protocol/memory/memoryWindow';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { WorkflowStepExecutionSelectionSchema, WorkflowIngressContextV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ProjectAccountWorkspaceRefV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { resolveProjectAccountWorkspaceRefRemovalV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import type { ProjectWorkspaceUpdateInputV1, ProjectWorkspaceUpdateOutputV1,
  ProjectWorkspaceForgetInputV1, ProjectWorkspaceForgetOutputV1 } from '@happier-dev/protocol/projects/projectWorkspaceActionsV1';
import { WorkflowMachineCommandOutputV1Schema } from '@happier-dev/protocol/workflows/stepActionsV1';
import { MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES } from '@happier-dev/protocol/automations/automationStoredContentEnvelopeV1';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import type { PromptExternalLinksV1 } from '@happier-dev/protocol/prompts/library/promptExternalLinksV1';
import { exportPromptLibraryArtifact, installPromptRegistryItemInLibrary, updatePromptBundleInLibrary, updatePromptDocInLibrary, readPromptDocInLibrary, createPromptDocInLibrary, setPromptDocFavorite, listPromptLibrary } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { listPromptInvocationsInLibrary, resolvePromptInvocationInLibrary } from '@happier-dev/protocol/prompts/library/promptInvocationActionOperations';
import { readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { SessionMcpSelectionV1Schema } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import { SessionAccessErrorCodeV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import { SessionCreationCorrespondenceV1Schema, normalizeSessionCreationOrganizationPlacementV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionCreationTargetPreparationResultV1Schema, SessionCreationDirectoryApprovalV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import { SessionModelSelectionV1Schema, SessionModelSelectionResolutionError, isNativeAutomaticModelSelectionInputV1, resolveSessionModelSelectionInputRefV1 } from '@happier-dev/protocol/providers/model-selection';
import { HandoffTargetReplacementPreflightResultV1Schema, WorkspaceSyncRelationshipsListRpcResultV1Schema, WorkspaceSyncConflictPageV1Schema, WorkspaceSyncConflictInspectRpcResultV1Schema, WorkspaceSyncConflictResolutionResultV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { deriveWorkspaceSyncTopology } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { SessionAuthoringTerminalV1Schema } from '@happier-dev/protocol/sessions/authoring/creationFieldsV1';
import { normalizeSpawnSessionErrorDetail, SPAWN_SESSION_ERROR_DETAIL_KINDS, isSessionCreationCorrespondenceConflictSpawnErrorDetail, isSessionCreationOrganizationInvalidSpawnErrorDetail } from '@happier-dev/protocol/spawnSession';
import { normalizeSpawnSessionNonceResolution } from '@happier-dev/protocol/sessions/spawnSessionNonce';
import { supportsMachineOperationProtocolCapabilityV1, supportsMachineSessionSpawnProtocolVersionV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { resolveExplicitSessionSpawnMachineTarget } from '@happier-dev/protocol/actions/sessionSpawnMachineTarget';
import { mergeSpawnConfigOptionAliases } from '@happier-dev/protocol/actions/sessionSpawnConfigOptions';
import { resolveActionBackendTargetSelection } from '@happier-dev/protocol/actions/resolveActionBackendTargetSelection';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import { withExecutionRunStartFailureDetails, ExecutionRunGetResponseSchema, ExecutionRunGetRequestSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { RoleActionInputSchemasV1, RoleActionOutputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { assertAccountRoleArtifactDeletionV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import { readSessionWorkspaceWritesV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveActionAgentStartContextV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import type { PromptAssetAdapter } from '@happier-dev/plugin-sdk/resources';
import { requestDaemonSignedRootActionExecution } from '@/daemon/controlClient';
import { doesWorkflowImmediateEligibleStepTargetSession } from '@/daemon/workflows/coordinator';
import { SpawnSessionTerminalSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { createStableSpawnNonce } from '@/session/shared/spawnNonce';
import {
  AGENT_IDS,
  DEFAULT_AGENT_ID,
  parsePermissionIntentAlias,
  resolvePermissionIntentFromSessionMetadata,
  resolveCanonicalAgentIdFromFlavor,
  resolveAgentIdFromSessionMetadata,
  isBundledAgentId,
  type AgentId,
  type PermissionIntent,
} from '@happier-dev/agents';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { AdmittedRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { projectRequesterSessionCredentialDisclosure } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { MachineAdmissionTransportUnavailableError } from '@/daemon/machineAdmissionTransport';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { readSessionCreationTerminalSpawnErrorDetail } from '@/api/session/sessionCreationTerminalSpawnErrorDetail';
import { readMachineOperationProtocolCapabilitiesV1 } from '@/api/machine/machineOperationProtocolCapabilities';
import {
  SessionInitialAccessEnvelopeHostError,
  SessionInitialAccessUpdateRequiredError,
} from '@/api/session/sessionCreationInitialAccess';
import { getPreferredHostName } from '@/daemon/machine/metadata';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { createAcknowledgedAccountArtifactTransport, createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createCliArtifactActions } from './artifactActions';
import { createWorkflowDefinitionActions } from './workflowDefinitions';
import { createCliWorkflowTriggerActions } from './workflowTriggers';
import { getWorkflowStarterExamplesV1 } from '@happier-dev/protocol/workflows/builtins/examples';
import { createRoleActionExecutor, type RoleWorkspaceWritesPolicyPreparer } from './roleActions';
import { createRoleSourceReader, type RoleSourceReader } from '@/session/roles/roleSources';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { createWorkflowActionExecutor, normalizeWorkflowActionThrownError } from './workflowActionExecutor';
import { createSessionFollowSourceKeyPreparationAfterSet } from '@/agent/runtime/session/follow/createSessionFollowSourceKeyPreparationAfterSet';
import { createWorkflowRunActionOwner } from './workflowRunActions';
import { createCommittedInputTypeDeps } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createCredentialedWorkflowMaterializationHostV1 } from './workflowMaterializationHost';
import { createWorkflowRunStorageClient } from '@/daemon/workflows/workflowRunStorageClient';
import { createWorkflowInvocationRecoveryObserver, observeWorkflowInvocationRecoveryEvidence } from '@/daemon/workflows/invocationRecoveryObserver';
import { createWorkflowInvocationRecoveryFactWriter } from '@/daemon/workflows/recovery';
import { createWorkflowRunPushNotificationClient } from '@/daemon/workflows/production';
import { createWorkflowRunReviewEntryNotificationHandler } from '@/notifications/activity/dispatchWorkflowRunUpdateNotification';
import type { WorkflowAccountRunActionDeps } from '@happier-dev/protocol';
import { isWorkflowRuntimeEnabled } from '@/daemon/automation/workflowFeatureGate';
import { listCurrentAccountMachines, resolveCurrentAccountMachineTarget } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { resolveFilesystemTransferCustodyFailure } from './filesystemTransferCustody';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { prepareWorkflowAcceptedWorkspaceTarget, restoreRecordedWorkflowWorkspace } from '@/daemon/workflows/resolveWorkflowWorkspace';
import {
  createAutomationAccountEncryptionMaterialSnapshotV1,
  resolveValidatedAutomationAccountEncryptionV1,
} from '@/plugins/runtime/automations/automationAccountCurrentness';
import { fetchChangesAccountId } from '@/api/changes';
import { readSettings, type StoredCredentials } from '@/persistence';
import {
  createSpawnedSession,
  type DirectSpawnedSessionTransport,
  type ReplaySeededSessionCreationV1,
} from '@/session/services/createSpawnedSession';
import { resolveSessionHandoffSourceAuthority } from '@/session/handoff/resolveSessionHandoffSourceAuthority';
import { buildReplaySeededSpawnRecipe } from '@/session/replay/buildReplaySeededSpawnRecipe';
import { resolveReplaySourceContextAuthority } from '@/session/replay/resolveReplaySourceContextAuthority';
import {
  type ResolveSpawnConnectedServicesTeamResourceCatalog,
  mergeSessionTeamCredentialBindingIntents,
  resolveSessionSpawnConnectedServicesDefaultsPayload,
} from '@/session/services/spawnConnectedServicesDefaults';
import { getSessionEvents } from '@/session/services/getSessionEvents';
import { getSessionTranscript } from '@/session/services/getSessionTranscript';
import { buildCliSessionAwarenessInputV1 } from '@/cli/output/session/sessionAwareness';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { getSessionStatus } from '@/session/services/getSessionStatus';
import { createSessionBoardActionDeps } from '@/session/board/sessionBoardActionDeps';
import { createSessionDiscussionActionDeps } from '@/session/discussions/sessionDiscussionActionDeps';
import { createSessionListActionDependency } from './sessionListActionDependency';
import { resolveCliAgentStartContextV1 } from './resolveCliAgentStartContextV1';
import { createCliBoundSessionMetadataReader, resolveCliActionCallerSession } from './resolveCliActionCallerSession';
import {
  dispatchOriginalAccountAction,
  resolveExternalActionServerRequestHeaders,
  type ExternalActionHomeBinding,
} from '@/api/externalActionExecutionAuthorization';
import { requestSessionStop } from '@/session/services/requestSessionStop';
import {
  admitPluginSessionInputAttachmentsV1,
  buildPluginSessionInputAttachmentDraftsV1,
} from '@/session/composer/admitPluginSessionInputAttachmentsV1';

type SessionSpawnNewErrorResult = Extract<SessionSpawnNewResultV1, Readonly<{ type: 'error' }>>;

/**
 * Keeps physical-host and atomic-create initial-access failures on the strict spawn
 * settlement instead of erasing Lane 04/Lane 06 recovery meaning behind a
 * generic process failure. The projection carries no key or response body.
 */
export function projectSessionInitialAccessEnvelopeHostErrorResult(
  error: unknown,
): SessionSpawnNewErrorResult | null {
  const code = error instanceof SessionInitialAccessEnvelopeHostError
    ? error.code
    : error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null;
  const parsedSessionAccessError = SessionAccessErrorCodeV1Schema.safeParse(code);
  if (parsedSessionAccessError.success) {
    return {
      type: 'error',
      code: parsedSessionAccessError.data,
      retryable: false,
    };
  }
  switch (code) {
    case 'not_authenticated':
      return { type: 'error', code: 'permission_denied', retryable: false };
    case 'session_data_key_unavailable':
      return { type: 'error', code, retryable: false };
    case 'session_access_request_failed':
      return { type: 'error', code, retryable: true };
    case 'unsupported_action':
      return { type: 'error', code: 'incompatible_target', retryable: false };
    default:
      return null;
  }
}
import type { ComposerAttachmentSendPreparationRegistryV1 } from '@/session/composer/prepareComposerAttachmentDraftsForSendV1';
import { notifyComposerAttachmentsAfterMessageAccepted } from '@/session/composer/notifyComposerAttachmentsAfterMessageAccepted';
import {
  sendSessionMessage,
  type SendSessionMessageResult,
} from '@/session/services/sendSessionMessage';
import { findPersistedSessionUserMessageAdmission } from '@/api/session/client/transcript/sessionUserMessageAdmissionRejoin';
import { validateComposerAttachmentRejoinCorrespondenceV1 } from '@/session/services/admitSessionStructuredInputV1';
import {
  buildCausalSessionInputAdmissionV1,
  buildSessionSpawnInitialInputAdmissionForLocalIdV1,
  buildPluginSessionInputAdmissionV1,
  requiresMachineAdmissionForSessionInput,
} from '@/session/services/sessionInputAdmissionIdentity';
import {
  indexAgentRoutingIdsByContributionIdentity,
  readAgentRoutingIdForContributionIdentity,
} from '@/plugins/projection/registry/agentRoutingIdentity';
import { resolveSessionCreationAgentTarget } from '@/session/creation/resolveSessionCreationAgentTarget';
import { setSessionArchivedState } from '@/session/services/setSessionArchivedState';
import { setSessionModel } from '@/session/services/setSessionModel';
import { setSessionMode } from '@/session/services/setSessionMode';
import { setSessionPermissionMode } from '@/session/services/setSessionPermissionMode';
import { updateSessionStateFieldForTarget } from '@/session/services/updateSessionStateFieldForTarget';
import { waitForSessionIdle } from '@/session/services/waitForSessionIdle';
import { requestInactiveSessionResume } from '@/session/services/requestInactiveSessionResume';
import { resolveSessionMachineWorkspacePath } from '@/session/machineControlLocality';
import {
  resolveCurrentSessionCapabilityBinding,
  resolveCurrentSessionUiBinding,
} from '@/session/presentation/currentSessionUiBindings';

import type {
  SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionStoredContentCodec';
import type { SessionTransportEncryptionMaterial } from '@/session/transport/encryption/sessionEncryptionContext';
import {
  cancelExecutionRunStream,
  ensureExecutionRun,
  ensureOrStartExecutionRun,
  executeExecutionRunAction,
  getExecutionRun,
  listExecutionRuns,
  readExecutionRunStream,
  startExecutionRun,
  startExecutionRunStream,
  stopExecutionRun,
  waitForExecutionRun,
} from '@/session/services/executionRuns';
import { buildPluginInstallApprovalPreview } from '@/plugins/devLoop/installApprovalPreview';
import {
  normalizeExecutionRunWaitTimeoutMs,
} from '@/session/services/executionRunWaitTiming';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { readSessionOwnerLocality, tryDecryptSessionMetadata, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { updateSessionMetadataForTarget } from '@/session/services/updateSessionMetadataForTarget';
import { fetchSessionById, fetchSessionByIdCompat, fetchSessionTurnsProjection, fetchSessionsQueryPage, setSessionAttentionStanding, setSessionOrganizationPin, setSessionReportsTo, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { callSessionRpc, resolveSessionRpcContent } from '@/session/transport/rpc/sessionRpc';
import {
  callExactMachineRpc,
  callMachineRpc,
  readMachineRpcRequestDisposition,
} from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, isRpcMethodNotFoundResult, RPC_ERROR_CODES, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { routeSessionCatalogControl } from '@/session/catalogControls/sessionCatalogControlRouter';
import { routeSessionGoalControl } from '@/session/goalControls/sessionGoalControlRouter';
import {
  normalizeUsageLimitRecoveryOperationResult,
} from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryOperationResult';
import { executePluginDevLoopAction } from '@/plugins/devLoop/actions';
import { executePluginSettingsAdministrationAction } from '@/plugins/settings/administration';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { createCliActionInventoryDeps } from './cliActionDeps/createCliActionInventoryDeps';
import {
  readSessionAgentState,
} from './cliActionDeps/sessionStateReaders';
import {
  HostSubagentStoreError,
  hostSubagentStore,
  type HostSubagentActor,
} from '@/session/subagents/hostSubagentStore';
import {
  resolveUsageLimitRecoveryEnabled,
  usageLimitRecoveryDisabledResult,
} from '@/features/usageLimitRecoveryFeatureGate';
import { createPromptAssetAdapterRegistry } from '@/prompts/assets/createPromptAssetAdapterRegistry';
import {
  deletePromptAsset,
  discoverPromptAssets,
  writePromptAsset,
} from '@/prompts/assets/actions';
import { createPromptRegistryAdapterRegistry } from '@/prompts/registries/createPromptRegistryAdapterRegistry';
import {
  fetchPromptRegistryItem,
  installPromptRegistryItem,
  scanPromptRegistrySource,
} from '@/prompts/registries/actions';
import { createPluginPermissionGrantActionExecutor } from '@/plugins/runtime/lifecycle/permissions/pluginPermissionGrantActionExecutor';
import { createPluginWebhookActionExecutor } from '@/plugins/runtime/webhooks/pluginWebhookActionExecutor';
import { createAutomationConversationActionExecutor } from '@/plugins/runtime/automations/automationConversationActionExecutor';
import {
  createAutomationEventActionExecutor,
  type ResolveAutomationEventAdoptedDefinitionSetV1,
} from '@/plugins/runtime/automations/automationEventActionExecutor';
import type {
  RevalidatePluginActionCallerOccurrence,
  RevalidatePluginActionCallerMaterialization,
} from '@/plugins/runtime/invocation/services/actionCaller';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import { createCliScmReviewedMarkAction, clearCliScmReviewedMarks } from '@/scm/actions/executeScmReviewedMarkAction';
import { executeScmDiffSummaryAction } from '@/scm/actions/executeScmDiffSummaryAction';
import { createRepositoryCheckpointTranscriptPageReader } from '@/scm/checkpoints/readRepositoryCheckpointTranscriptPage';
import type { ReadPullRequestComparisonPage } from '@/scm/comparisons/readPullRequestComparisonPage';
import { createCliReviewCommentActionExecutorFromCredentials } from '@/agent/reviews/comments/executor';
import { executePluginExternalSessionAction } from './externalSessions/pluginExternalSessionActionExecutor';
import { createHostExternalSessionActionTransport } from './externalSessions/hostExternalSessionActionTransport';
import type {
  ExternalSessionPluginAdmissionOwner,
} from './externalSessions/pluginExternalSessionAdmissionOwner';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { fetchAccountProfile } from '@/api/accountProfile';
import { PushNotificationClient } from '@/api/pushNotifications';
import { dispatchActivityNotificationAsync, listActivityNotificationChannels,
  NotificationChannelCatalogUnavailableError } from '@/notifications/activity/dispatchActivityNotification';
import { createCliNotificationChannelStore } from '@/settings/notifications/notificationChannelStore';
import { hydrateNotificationChannelCatalogForActiveAccount } from '@/settings/notifications/hydrateNotificationChannelCatalog';
import { createSavedSecretMaterializerFromSnapshotV1, SavedSecretResolutionError } from '@/settings/secrets/savedSecretCatalog';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';
import { createActionSettingsProvider, type RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, isActiveAccountSettingsSnapshotLifetimeCurrent } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliConnectedAccountCatalogStore } from '@/settings/connectedAccounts/connectedAccountCatalogStore';
import { readActiveConnectedAccountCatalog } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';
import { prepareActiveAccountRoleOverrides, refreshActivePromptLibraryCatalogAfterChange } from '@/settings/prompts/hydratePromptLibraryCatalog';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveWorkspaceRefById } from '@/workspaces/workspaceRefsV1';
import { projectWorkspaceRefV1, resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { buildProjectAccountRowPhysicalKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createCliAcpCatalogStore } from '@/agent/acp/catalog/acpCatalogStore';

/**
 * Projects the low-level send wrapper onto the one public Action result.
 * Admission evidence is authoritative even when acknowledgement or waiting
 * failed after a durable effect. A successful unprotected send predates the
 * admission envelope, so its resolved local id is projected as accepted.
 */
function projectSessionMessageSendActionResult(
  result: SendSessionMessageResult,
): SessionMessageSendResultV1 | null {
  if (!result.ok && result.settlementResult) return result.settlementResult;
  if (result.admissionResult) return result.admissionResult;
  if (result.ok) return { status: 'accepted', localId: result.localId };
  return null;
}

function notSupported(): never {
  throw new Error('action_not_supported_in_cli');
}

type PromptExternalLinkPersistenceSettlement =
  | Readonly<{
    status: 'applied';
    version: number;
  }>
  | Readonly<{
    status: 'conflict';
    currentVersion: number;
  }>
  | Readonly<{
    status: 'outcomeUnknown';
    lastKnownVersion: number;
  }>
  | Readonly<{
    status: 'cancelled';
    submitted: false;
  }>
  | Readonly<{
    status: 'locked';
    reason: 'encryptionMaterialUnavailable' | 'modeMismatch' | 'contentUnreadable';
  }>
  | Readonly<{
    status: 'invalid';
    reason: 'unknownKey' | 'invalidValue' | 'duplicateKey' | 'tooLarge' | 'tooDeep';
  }>
  | Readonly<{
    status: 'unavailable';
    retryable: boolean;
  }>;

function serializeHostSubagentStoreError(error: unknown): Readonly<{ ok: false; errorCode: string; error: string }> {
  if (error instanceof HostSubagentStoreError) {
    return { ok: false, errorCode: error.code, error: error.code };
  }
  throw error;
}

function deriveHostSubagentActor(caller: ActionCaller): HostSubagentActor {
  if (caller.kind !== 'plugin' || !caller.contributionLocalId?.trim()) {
    return { kind: 'externalRpc' };
  }
  return {
    kind: 'plugin',
    pluginId: caller.pluginId,
    agentId: caller.contributionLocalId,
  };
}

function normalizeStringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function executionRunActionFailure(
  code: string,
  message?: string,
  details?: unknown,
): Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }> {
  return {
    ok: false,
    errorCode: code,
    error: message ?? code,
    ...(details !== undefined ? { details } : {}),
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isExecutionRunActionAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || readRecord(error).name === 'AbortError';
}

function hasPossiblyAcceptedSpawnNonce(error: unknown): boolean {
  const details = readRecord(readRecord(error).details);
  return typeof details.spawnNonce === 'string' && details.spawnNonce.trim().length > 0;
}

/**
 * The Action surface consumes only the protocol-owned terminal detail, never
 * daemon/server wording. Direct daemon-control failures carry it at
 * `details.errorDetail`; the awaiter path nests the original response once.
 */
function hasSessionCreationOrganizationInvalidDetail(error: unknown): boolean {
  const details = readRecord(readRecord(error).details);
  return isSessionCreationOrganizationInvalidSpawnErrorDetail(
    details.errorDetail,
  ) || isSessionCreationOrganizationInvalidSpawnErrorDetail(
    readRecord(details.spawnResponse).errorDetail,
  );
}

function hasSessionCreationCorrespondenceConflictDetail(error: unknown): boolean {
  const details = readRecord(readRecord(error).details);
  return isSessionCreationCorrespondenceConflictSpawnErrorDetail(
    details.errorDetail,
  ) || isSessionCreationCorrespondenceConflictSpawnErrorDetail(
    readRecord(details.spawnResponse).errorDetail,
  );
}

function readResumePromptMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 | undefined {
  return value === 'standard' || value === 'off' || value === 'custom' ? value : undefined;
}

export type ResumeInactiveSessionWhenUsageLimitReady = (input: Readonly<{
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
}>) => Promise<boolean>;

export type ScheduleInactiveSessionUsageLimitRecoveryCheck = (input: Readonly<{
  sessionId: string;
  recovery: SessionUsageLimitRecoveryV1;
  runCheckNow: () => Promise<unknown>;
}>) => Promise<void> | void;

export type CancelInactiveSessionUsageLimitRecoveryCheck = (input: Readonly<{
  sessionId: string;
  issueFingerprint: string;
  armedAtMs: number;
  runtimeAuthRecoveryAttemptId?: string;
}>) => Promise<void> | void;

/**
 * Reads the current record from the inactive usage-limit recovery lifecycle owner so an
 * in-flight readiness probe can be fenced against a cancellation, exhaustion or replacement
 * that landed while it was running.
 */
export type ReadInactiveSessionUsageLimitRecovery = (input: Readonly<{
  sessionId: string;
}>) => SessionUsageLimitRecoveryV1 | null;

export type CancelConnectedServiceRuntimeAuthRecovery = (input: Readonly<{
  sessionId: string;
  attemptId: string;
}>) => Promise<unknown> | unknown;

export type RetryTemporaryThrottleNow = (input: Readonly<{
  sessionId: string;
}>) => Promise<unknown> | unknown;

/**
 * Host-private exact-daemon path used only after the public V2 Action owner
 * has admitted an already server-stamped request. It replaces transport, not
 * Session creation policy, normalization, or lifecycle ownership.
 */
export type SessionSpawnDirectTargetTransport = Readonly<{
  machineId: string;
  prepare: (
    request: SessionCreationTargetPreparationRequestV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<SessionCreationTargetPreparationResultV1>;
  spawnedSession: DirectSpawnedSessionTransport;
}>;

/** The daemon's already authenticated Machine socket; never the Account user socket. */
export type SessionActionRpcTransport = (request: Readonly<{
  sessionId: string;
  method: string;
  input: unknown;
  content: import('@happier-dev/sync-client').SocketRpcContent;
  origin: SessionActionRpcOriginV1;
  signal?: AbortSignal;
}>) => Promise<unknown>;

export type MachineActionDirectTargetTransport = Readonly<{
  machineId: string;
  invoke: (
    method: string,
    request: unknown,
    options?: Readonly<{
      signal?: AbortSignal;
      executionRunPermissionRequestStore?: unknown;
      executionRunWorkflowObservationSink?: unknown;
      executionRunWorkflowRunId?: string;
      localActionContext?: RpcLocalActionContext;
    }>,
  ) => Promise<unknown>;
}>;

type CurrentMachineControlIdentity = Readonly<{
  machineId: string | null;
  host: string | null;
  homeDir: string | null;
}>;

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, entryValue]) => typeof entryValue === 'string')) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function readConfigOptionsRecord(value: unknown): Record<string, SpawnConfigOptionValue> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, entryValue]) => (
    typeof entryValue === 'string'
    || typeof entryValue === 'number' && Number.isFinite(entryValue)
    || typeof entryValue === 'boolean'
    || entryValue === null
  ))) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, SpawnConfigOptionValue>;
}

async function resolveSpawnConnectedServicesDefaultPayload(params: Readonly<{
  backendTarget: NonNullable<ReturnType<typeof readBackendTargetRefV2>>;
  credentials: StoredCredentials;
  operationContext?: SavedSecretOperationContextV1;
  resolveTeamCredentialResourceCatalog?: ResolveSpawnConnectedServicesTeamResourceCatalog;
}>): Promise<Awaited<ReturnType<typeof resolveSessionSpawnConnectedServicesDefaultsPayload>>> {
  if (params.backendTarget.sourceKind !== 'built_in') return null;
  // ONE defaulting owner (QA2-F02): session spawn and execution-run start resolve defaults
  // through the same fresh-bootstrap owner; no local settings-snapshot path.
  return await resolveSessionSpawnConnectedServicesDefaultsPayload({
    agentId: params.backendTarget.backendId,
    credentials: params.credentials,
    ...(params.operationContext ? { operationContext: params.operationContext } : {}),
    ...(params.resolveTeamCredentialResourceCatalog
      ? { resolveTeamCredentialResourceCatalog: params.resolveTeamCredentialResourceCatalog }
      : {}),
  });
}

type PendingAgentRequestKind = 'permission' | 'user_action';

/**
 * The Action-executor dependency contract owns the V2-only capability
 * requirement; this transport only consumes it, so it is read back from that
 * declaration instead of being restated here.
 */
type ExecutionRunProtocolV2Requirement = Parameters<
  NonNullable<ActionExecutorDeps['executionRunCheckProtocolV2']>
>[1];

function permissionRequestNotFoundResult(sessionId: string) {
  return {
    ok: false,
    errorCode: 'permission_request_not_found',
    errorMessage: 'permission_request_not_found',
    sessionId,
  } as const;
}

function isKnownCompletedRequestId(params: Readonly<{
  rawSession: Readonly<{ agentState?: unknown }>;
  requestId: string;
  kind: PendingAgentRequestKind;
}> & SessionStoredContentCryptoContext): boolean {
  const agentState = readSessionAgentState(params);
  const completedRequests = agentState?.completedRequests;
  if (!completedRequests || typeof completedRequests !== 'object' || Array.isArray(completedRequests)) {
    return false;
  }

  const completed = (completedRequests as Record<string, unknown>)[params.requestId];
  if (!completed || typeof completed !== 'object' || Array.isArray(completed)) {
    return false;
  }

  const requestKind = (completed as Record<string, unknown>).kind;
  if (params.kind === 'user_action') return requestKind === 'user_action';
  return requestKind === 'permission' || typeof requestKind === 'undefined';
}

const DETACHED_EXECUTION_RUN_CALLER_LIFECYCLE_METHODS = new Set<string>([
  SESSION_RPC_METHODS.EXECUTION_RUN_START,
  SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
  SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
  SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
  SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
  SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
  SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2,
  SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
  SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
  SESSION_RPC_METHODS.EXECUTION_RUN_WAIT,
]);

/**
 * An exact Action Home is one target: its server id and its base URL are bound
 * together or not at all. The Home-bound dependency owners already refuse a
 * half-bound target, so callers express the same pair here instead of letting
 * one half reach an owner that would fall back to the configured active Home.
 */
export type CliActionExactHomeTarget =
  | Readonly<{ serverId?: undefined; serverHttpBaseUrl?: undefined }>
  | Readonly<{ serverId: string; serverHttpBaseUrl: string }>;

export function createCliActionDeps(params: Readonly<{
  token: string;
  /** Local delivery only; a host without a link consumer refuses creation before HTTP. */
  onPublicLinkIssued?: (link: import('@happier-dev/protocol').ArtifactPublicLinkIssuedV1) => void | Promise<void>;
  credentials?: StoredCredentials;
  /** Currentness of this composition's already-captured credential. */
  isCredentialCurrent?: () => boolean | Promise<boolean>;
  onRequesterSessionCredentialDisclosure?: Parameters<typeof dispatchOriginalAccountAction>[0]['onRequesterSessionCredentialDisclosure'];
  requesterSessionBootstrap?: AdmittedRequesterSessionBootstrap;
  /** Private invocation custody, never a daemon Account snapshot or a fake Session. */
  savedSecretOperationContext?: SavedSecretOperationContextV1;
  /** Installed exact-target Project producer; absent hosts retain Trust-only behavior. */
  projectAction?: ActionExecutorDeps['projectAction'];
  /** Machine-owned policy intersects the selected Session's confined SCM root. */
  scmFilesystemAccessPolicy?: FilesystemAccessPolicy;
  /** The daemon binds its canonical local file owner; clients use exact Machine transport. */
  projectDefinitionAction?: ActionExecutorDeps['projectDefinitionAction'];
  /** Account row/policy ports share the family with exact-Machine status and retirement. */
  projectWorkerAccountAction?: ActionExecutorDeps['projectWorkerAction'];
  stageWorkStateMutation?: (mutation: import('@/api/session/client/transport/mutations/sessionClientDurableMutationTypes').DaemonWorkStateFieldMutation) => Promise<void>;
  stageSessionStateMutation?: (mutation: import('@/api/session/client/transport/mutations/sessionClientDurableMutationTypes').RegisteredSessionStateFieldMutationV1) => Promise<void>;
  publishWorkerReport?: (report: SessionWorkerPublishInputV1) => Promise<Readonly<{ persisted: boolean; localId?: string }>>;
  sessionId: string;
  rawSession?: Readonly<{
    metadata?: unknown;
    metadataLayoutVersion?: unknown;
    path?: unknown;
    host?: unknown;
    machineId?: unknown;
    workDepth?: unknown;
  }> | null;
  getCurrentSessionBackendTarget?: (() => BackendTargetRefV2 | null | undefined) | null;
  getCurrentSessionMetadata?: () => Readonly<Record<string, unknown>> | null;
  getCurrentSessionWorkDepth?: () => number | undefined;
  getAgentStartRunCaller?: () => import('./resolveCliAgentStartContextV1').AgentStartRunCallerBinding | null;
  getCurrentTurnWorkDepth?: (expectedTurnId?: string) => number | undefined;
  getCurrentResolvedRoles?: () => ResolvedRolesSnapshotV1;
  getCurrentWorkspaceWrites?: () => 'allow' | 'deny' | undefined;
  readRoleSources?: RoleSourceReader;
  readPluginRoles?: () => readonly PluginRoleContributionV1[];
  /** Already-admitted declarations from this host's current executable registry lease; never wakes a daemon. */
  readPluginVoiceProviders?: () => readonly Readonly<{
    identity: Readonly<{ pluginId: string; localId: string }>;
    definition: unknown;
  }>[];
  prepareWorkspaceWritesPolicy?: RoleWorkspaceWritesPolicyPreparer;
  happyHomeDir?: string;
  readRegisteredPromptAssetAdapters?: () => ReadonlyMap<string, PromptAssetAdapter>;
  resolveAutomationEventAdoptedDefinitionSet?: ResolveAutomationEventAdoptedDefinitionSetV1;
  revalidatePluginActionCallerMaterialization?: RevalidatePluginActionCallerMaterialization;
  revalidatePluginActionCallerOccurrence?: RevalidatePluginActionCallerOccurrence;
  isUsageLimitRecoveryEnabled?: (() => Promise<boolean> | boolean) | null;
  externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
  machineAdmissionTransport?: NonNullable<
    Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']
  >;
  sessionSpawnDirectTargetTransport?: SessionSpawnDirectTargetTransport;
  machineActionDirectTargetTransport?: MachineActionDirectTargetTransport;
  sessionActionRpcTransport?: SessionActionRpcTransport;
  /**
   * Read at dispatch time so the plugin runtime's declared Composer attachments
   * are reachable from the Session-input writer. It is absent for hosts that
   * run no plugin runtime, in which case a declared attachment is refused
   * rather than dropped.
   */
  resolveComposerAttachmentSendPreparation?: () => ComposerAttachmentSendPreparationRegistryV1 | null;
  /** Reads the daemon's already-retained snapshot for this exact Home. */
  resolveServerFeaturesSnapshot?: () =>
    | CliServerFeaturesSnapshot
    | undefined
    | Promise<CliServerFeaturesSnapshot | undefined>;
  /** Exact Home-bound policy/settings snapshot owned by the runtime constructor. */
  actionsSettingsProvider?: RuntimeActionSettingsProvider;
  /** Existing Account workflow family owner, shared with notification link checks. */
  workflowAction?: ActionExecutorDeps['workflowAction'];
  /** Exact committed contributed-Action owner supplied by this host constructor. */
  invokeContributedAction?: ActionExecutorDeps['invokeContributedAction'];
  /** Current plugin notification owner from this host's executable registry lease. */
  resolvePluginNotifications?: () => Parameters<typeof dispatchActivityNotificationAsync>[0]['pluginNotifications'];
  resolveTeamCredentialResourceCatalog?: ResolveSpawnConnectedServicesTeamResourceCatalog;
  /**
   * Stored-content material this composition already holds for one exact
   * Session, for a host whose credentials carry no Account encryption material.
   * Passed straight to the Session-scoped Action owners that need it.
   */
  resolveExactSessionEncryptionMaterial?: (sessionId: string) => SessionTransportEncryptionMaterial | null;
  /** Existing daemon authority owner shared with coordinator effect currentness. */
  workflowAcceptedAuthorizationCurrentness?: (input: Readonly<{
    authorization: import('@happier-dev/protocol').WorkflowAcceptedAuthorizationV1;
    signal?: AbortSignal;
  }>) => boolean | Promise<boolean>;
}> & SessionStoredContentCryptoContext & ExternalActionHomeBinding & CliActionExactHomeTarget): ActionExecutorDeps {
  const roleAccountScopeKey = params.serverHttpBaseUrl
    ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => resolveAccountSettingsScopeKeyForToken(params.token))
    : resolveAccountSettingsScopeKeyForToken(params.token);
  const roleAccountLifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const readNotificationContext = async (signal?: AbortSignal) => {
    const credentials = params.credentials;
    if (!credentials) throw new NotificationChannelCatalogUnavailableError('unauthorized');
    const operation = params.savedSecretOperationContext;
    const home = operation?.serverHttpBaseUrl ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
    const scopeKey = runWithServerHttpBaseUrl(home, () => resolveAccountSettingsScopeKeyForToken(credentials.token));
    const readSnapshot = () => operation ? operation.readSnapshot() : getActiveAccountSettingsSnapshot();
    if (!operation && !readSnapshot()) {
      await runWithServerHttpBaseUrl(home, () => bootstrapAccountSettingsContext({ credentials, mode: 'blocking' }));
    }
    const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
    const isCurrent = async () => !signal?.aborted && readSnapshot()?.scopeKey === scopeKey
      && (operation ? operation.credentials.token === credentials.token && await operation.isCurrent()
        : isActiveAccountSettingsSnapshotLifetimeCurrent({ scopeKey, lifetimeToken }))
      && (!params.isCredentialCurrent || await params.isCredentialCurrent());
    const assertCurrent = async () => {
      signal?.throwIfAborted();
      if (!await isCurrent()) throw new NotificationChannelCatalogUnavailableError('scope-retired');
    };
    await assertCurrent();
    let snapshot = readSnapshot();
    if (!snapshot) throw new NotificationChannelCatalogUnavailableError('scope-retired');
    if (!snapshot.notificationChannelCatalog || snapshot.notificationChannelCatalog.status === 'loading') {
      if (operation) {
        const commit = async (catalog: NotificationChannelCatalogSnapshotV1) => {
          await assertCurrent();
          const captured = operation.readSnapshot();
          if (!captured || !await operation.commitNotificationChannelCatalog({ expectedSettingsVersion: captured.settingsVersion, catalog })) {
            throw new NotificationChannelCatalogUnavailableError('scope-retired');
          }
        };
        const catalog = await createCliNotificationChannelStore({ credentials, operationContext: operation, signal })
          .readNotificationChannelCatalog(commit);
        await commit(catalog);
      } else {
        await runWithServerHttpBaseUrl(home, () => hydrateNotificationChannelCatalogForActiveAccount({ credentials, scopeKey, lifetimeToken, signal }));
      }
      await assertCurrent();
      snapshot = readSnapshot();
    }
    if (!snapshot) throw new NotificationChannelCatalogUnavailableError('scope-retired');
    const captured = snapshot;
    return { settings: captured.settings, notificationChannelCatalog: captured.notificationChannelCatalog ?? { status: 'loading' as const },
      savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(captured,
        operation ? { isCurrent: () => operation.readSnapshot() === captured } : undefined), isCurrent };
  };
  const notificationFailure = (error: unknown) => {
    if (error instanceof NotificationChannelCatalogUnavailableError) return { ok: false as const,
      errorCode: error.code, error: 'Notification channel catalog is unavailable', details: { reason: error.reason } };
    if (error instanceof SavedSecretResolutionError) return { ok: false as const,
      errorCode: error.code, error: 'Notification signing material is unavailable', details: { reason: error.status } };
    throw error;
  };
  const roleSettingsProvider = params.actionsSettingsProvider ?? createActionSettingsProvider({ scopeKey: roleAccountScopeKey });
  const readAccountRoleOverrides = () => roleSettingsProvider.getAccountRoleOverrides?.()
    ?? { status: 'unavailable' as const, reason: 'source-unavailable' };
  const prepareAccountRoleOverrides = async (signal?: AbortSignal): Promise<void> => {
    const credentials = params.credentials;
    if (!credentials) return;
    const prepare = () => prepareActiveAccountRoleOverrides({ credentials,
      scopeKey: roleAccountScopeKey, lifetimeToken: roleAccountLifetimeToken, signal });
    const prepared = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, prepare) : prepare());
    if (prepared.status === 'unavailable' && prepared.reason === 'scope-retired') {
      throw Object.assign(new Error('account_role_overrides_unavailable'), {
        code: 'account_role_overrides_unavailable', reason: 'scope-retired',
      });
    }
  };
  // Re-formed once so the proven pair travels to every Home-bound owner
  // together; the two params fields decorrelate as soon as they are spread apart.
  const exactHome: CliActionExactHomeTarget =
    params.serverId !== undefined && params.serverHttpBaseUrl !== undefined
      ? { serverId: params.serverId, serverHttpBaseUrl: params.serverHttpBaseUrl }
      : {};
  const readServerFeaturesSnapshot = async (): Promise<CliServerFeaturesSnapshot | undefined> =>
    await params.resolveServerFeaturesSnapshot?.();
  const projectHomeId = params.serverId ?? configuration.activeServerId;
  const projectHomeAdmission = (serverId?: string, context?: ActionExecutorContext) => {
    if ((serverId !== undefined && serverId.trim() !== projectHomeId)
      || (context?.serverId && context.serverId !== projectHomeId)
      || (params.serverId === undefined && configuration.activeServerId !== projectHomeId)) {
      return executionRunActionFailure('server_scope_mismatch');
    }
    return null;
  };
  const projectAccountAdmission = (serverId?: string, context?: ActionExecutorContext) => {
    const homeDenied = projectHomeAdmission(serverId, context);
    if (homeDenied) return homeDenied;
    const authorization = context?.externalActionExecutionAuthorization;
    if (authorization) {
      const account = authorization.requesterAccountProjection;
      const http = authorization.requesterHttpProjection;
      if (!account || !http || account.accountId !== authorization.binding.accountId || http.accountId !== account.accountId
        || account.serverId !== projectHomeId || http.serverId !== projectHomeId
        || http.serverHttpBaseUrl.replace(/\/+$/, '') !== (params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, '')
        || context?.externalActionCredential && context.externalActionCredential.accountId !== account.accountId
        || context?.runtimeAccountId && context.runtimeAccountId !== account.accountId) {
        return executionRunActionFailure('project_requester_authority_unavailable');
      }
      return null;
    }
    // Public principal equality does not establish private requester custody.
    // External actions must arrive with the admitted host-private projection.
    if (context?.externalActionCredential) return executionRunActionFailure('project_requester_authority_unavailable');
    if (!params.credentials) return executionRunActionFailure('not_authenticated');
    const accountId = readAccountIdFromToken(params.credentials.token);
    if (context?.rpcSessionAuthorization && !context.runtimeAccountId) {
      return executionRunActionFailure('project_requester_authority_unavailable');
    }
    if (context?.runtimeAccountId && context.runtimeAccountId !== accountId) {
      return executionRunActionFailure('project_requester_authority_unavailable');
    }
    return null;
  };
  const withProjectHome = <T>(operation: () => Promise<T>): Promise<T> => runWithServerHttpBaseUrl(
    params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(), operation,
  );
  const projectRowsAuthority = (context?: ActionExecutorContext, effectActionId?: string, signal?: AbortSignal): ProjectAccountRowsInput => {
    const authorization = context?.externalActionExecutionAuthorization;
    if (authorization) return { authorization, effectActionId: effectActionId ?? authorization.binding.actionId,
      serverId: projectHomeId, ...(signal ? { signal } : {}) };
    if (!params.credentials) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
    return { credentials: params.credentials, serverId: projectHomeId, ...(signal ? { signal } : {}) };
  };
  const assertProjectRequesterCurrent = async (context?: ActionExecutorContext) => {
    const authorization = context?.externalActionExecutionAuthorization;
    if (!authorization) return;
    if (projectAccountAdmission(projectHomeId, context)
      || !await authorization.requesterAccountProjection!.isCurrent() || !await authorization.requesterHttpProjection!.isCurrent()) {
      throw Object.assign(new Error('project_requester_authority_unavailable'), { code: 'project_requester_authority_unavailable' });
    }
    context?.signal?.throwIfAborted();
  };
  const readProjectRows = async (signal?: AbortSignal, context?: ActionExecutorContext, effectActionId?: string) => {
    return await withProjectHome(() => readProjectAccountRows(projectRowsAuthority(context, effectActionId, signal)));
  };
  const readProjectRequesterArtifact = async (ref: Parameters<NonNullable<ExternalActionExecutionAuthorizationV1['requesterAccountProjection']>['readArtifact']>[0],
    options: Readonly<{ signal?: AbortSignal }> | undefined, context: ActionExecutorContext) => {
    const authorization = context.externalActionExecutionAuthorization;
    if (!authorization) return null;
    await assertProjectRequesterCurrent(context);
    if (ref.serverId !== authorization.requesterAccountProjection!.serverId) return null;
    const artifact = await authorization.requesterAccountProjection!.readArtifact(ref, options);
    await assertProjectRequesterCurrent(context);
    return artifact?.artifactId === ref.artifactId ? artifact : null;
  };
  const resolveServerRequestHeaders = (
    context: ActionExecutorContext | undefined,
    effectActionId: string,
    request: Readonly<{ method: string; path: string; body?: unknown }>,
  ): Readonly<Record<string, string>> | null => {
    const resolved = resolveExternalActionServerRequestHeaders({
      context,
      effectActionId,
      method: request.method,
      path: request.path,
      ...(request.body === undefined ? {} : { body: request.body }),
      daemonToken: params.token,
      serverIdentityId: params.serverIdentityId,
      ...(params.externalActionMachineRequestPrivateKey
        ? { privateKey: params.externalActionMachineRequestPrivateKey }
        : {}),
      ...(params.externalActionMachineInstallationId
        ? { installationId: params.externalActionMachineInstallationId }
        : {}),
    });
    return resolved.ok ? resolved.headers : null;
  };
  const prepareSourceKeyAfterCommit = async (input: Readonly<{
    effectActionId: 'session.reports_to.set' | 'session.spawn_new';
    sourceSessionId: string;
    destinationSessionId: string;
    context?: ActionExecutorContext;
    signal?: AbortSignal;
  }>): Promise<SessionFollowSourceKeyPreparationResultV1> => {
    if (!params.credentials || !input.context) return { kind: 'waiting', reason: 'runner_unreachable' };
    try {
      return await createSessionFollowSourceKeyPreparationAfterSet({
        credentials: params.credentials,
        effectActionId: input.effectActionId,
        ...(params.serverHttpBaseUrl ? { serverHttpBaseUrl: params.serverHttpBaseUrl } : {}),
        ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
        ...(params.resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot } : {}),
        ...(params.externalActionMachineRequestPrivateKey ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey } : {}),
        ...(params.externalActionMachineInstallationId ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId } : {}),
      })({ sourceSessionId: input.sourceSessionId, destinationSessionId: input.destinationSessionId,
        context: input.context, ...(input.signal ? { signal: input.signal } : {}) });
    } catch {
      return { kind: 'waiting', reason: 'runner_unreachable' };
    }
  };
  const roleArtifactStore = params.credentials ? createCredentialedAccountArtifactStore(params.credentials) : undefined;
  const homeAccountId = params.credentials ? readAccountIdFromToken(params.credentials.token) : null;
  const accountCallerContext = (context: ActionExecutorContext): ActionExecutorContext => ({ ...context,
    ...(homeAccountId ? { runtimeAccountId: homeAccountId } : {}) });
  const artifactCallerContext = (context: ActionExecutorContext): ActionExecutorContext => ({ ...accountCallerContext(context),
    ...(!context.defaultSessionId && params.sessionId ? { defaultSessionId: params.sessionId } : {}) });
  const todoHomeServerId = params.serverId ?? configuration.activeServerId;
  const todoHomeBaseUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const homeHubArtifactPort = roleArtifactStore && homeAccountId ? createHomeHubArtifactPortV1(createAcknowledgedAccountArtifactTransport(roleArtifactStore), {
    accountId: homeAccountId, readWidgets: (signal, layout) => readHomeWidgets(signal, layout),
  }) : null;
  const artifactAccessAction = roleArtifactStore ? createArtifactAccessActionsV1({
    read: roleArtifactStore.read, transport: roleArtifactStore.accessGrants,
  }) : undefined;
  const readRawRoleSettings = params.credentials ? async (options?: Readonly<{ requireCurrentNetwork: boolean }>) => {
    if (params.savedSecretOperationContext && !await params.savedSecretOperationContext.isCurrent()) {
      throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
    }
    const current = await bootstrapAccountSettingsContext({ credentials: params.credentials!, mode: 'blocking',
      ...(params.savedSecretOperationContext ? { publication: 'invocation' as const, refresh: 'force' as const, honorAccountSettingsModeEnv: false } : {}),
      ...(options?.requireCurrentNetwork ? { refresh: 'force', publication: 'invocation', honorAccountSettingsModeEnv: false } as const : {}) });
    if (!current.rawSettings || (options?.requireCurrentNetwork && current.source !== 'network')) {
      throw Object.assign(new Error('account_settings_content_unavailable'), { code: 'account_settings_content_unavailable' });
    }
    return current.rawSettings;
  } : undefined;
  const machineReferenceServerUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const managedMachineReferences: NonNullable<ActionExecutorDeps['managedMachineReferences']> = async ({ input, context, signal }) => {
    const unavailable = (reason: MachineReferenceCensusV1['unavailable'][number]): MachineReferenceCensusV1 => ({
      homeId: input.homeId, machineId: null, coverage: 'partial', references: [], unavailable: [reason],
    });
    if (projectAccountAdmission(projectHomeId, context) || !params.credentials || !roleArtifactStore || !readRawRoleSettings) {
      return unavailable('requester_authority');
    }
    return await runWithServerHttpBaseUrl(machineReferenceServerUrl, async () => {
      const headers = { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${params.credentials!.token}` };
      let machine: ReturnType<typeof ManagedGetOutputV1Schema.parse>;
      try {
        const response = await axios.post(`${machineReferenceServerUrl}${managedMachineActionEndpointPathV1('machines.managed.get')}`,
          ManagedGetInputV1Schema.parse({ homeId: input.homeId, managedId: input.managedId }), { headers, signal });
        machine = ManagedGetOutputV1Schema.parse(response.data);
        if (machine.homeId !== input.homeId || machine.id !== input.managedId) return unavailable('target');
      } catch { return unavailable('target'); }
      let profileStore: ReturnType<typeof createCliProfileStore> | undefined;
      return await readMachineReferenceCensusV1({ homeId: input.homeId, machineId: machine.enrolledMachineId ?? null,
        homeAliases: [projectHomeId], signal }, {
        artifacts: roleArtifactStore,
        readSettings: async () => {
          await readRawRoleSettings();
          profileStore = params.savedSecretOperationContext
            ? createCliProfileStoreForOperation({ operationContext: params.savedSecretOperationContext, signal })
            : createCliProfileStore({ credentials: params.credentials!, signal });
          return (await profileStore.readSourceSnapshot()).raw;
        },
        readProfileCatalog: async () => {
          if (!profileStore) throw new Error('profile_catalog_unavailable');
          return await profileStore.readProfileCatalog();
        },
        readPools: async () => {
          const response = await axios.post(`${machineReferenceServerUrl}${machinePoolActionEndpointPathV1('machines.pools.list')}`, {}, { headers, signal });
          return MachinePoolListOutputV1Schema.parse(response.data);
        },
        readAssignments: cursor => listAutomationDefinitions({ token: params.credentials!.token, ...(cursor ? { cursor } : {}) }),
      });
    });
  };
  const launchProfilePublicationServerUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const sourceReader = params.readRoleSources ?? createRoleSourceReader({
    artifactStore: roleArtifactStore, readPluginRoles: params.readPluginRoles,
    accountId: params.credentials ? readAccountIdFromToken(params.credentials.token) ?? undefined : undefined,
    readRawAccountSettings: readRawRoleSettings,
  });
  const readRoleSources: RoleSourceReader = (signal) => params.serverHttpBaseUrl
    ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => sourceReader(signal)) : sourceReader(signal);
  const resolveActionCallerSession = async (context: ActionExecutorContext) => await resolveCliActionCallerSession({
    context, credentials: params.credentials, boundSessionId: params.sessionId, resolveTransportForSession,
    readBoundSession: async () => {
      const metadata = await readCurrentSessionMetadata();
      return { metadata, workDepth: params.getCurrentSessionWorkDepth?.() ?? params.rawSession?.workDepth,
        backendTarget: params.getCurrentSessionBackendTarget?.() ?? resolveBackendTargetFromSessionMetadata(metadata),
        machineId: await resolveCurrentSessionValue('machineId'), directory: await resolveCurrentSessionValue('path') };
    },
  });
  const resolveAgentStartContext: NonNullable<ActionExecutorDeps['resolveAgentStartContext']> = async (context) => {
    const session = await resolveActionCallerSession(context);
    if (!session) return null;
    const runCaller = params.getAgentStartRunCaller?.();
    if (params.getAgentStartRunCaller && !runCaller) return null;
    const caller = context.actionCaller;
    const admittedCaller = caller?.kind === 'session'
      ? AgentStartSessionCallerV1Schema.safeParse(caller)
      : null;
    if (admittedCaller && !admittedCaller.success) return null;
    let starterDepth: unknown = admittedCaller?.success ? admittedCaller.data.starterDepth : session.workDepth;
    if (starterDepth === undefined && !runCaller) {
      try {
        const persisted = await fetchSessionById({ token: params.token, sessionId: session.sessionId });
        if (persisted && 'workDepth' in persisted) starterDepth = persisted.workDepth;
      } catch { return null; }
    }
    const turnId = context.sessionInputSource && typeof context.sessionInputSource === 'object'
      && 'sourceTurnId' in context.sessionInputSource && typeof context.sessionInputSource.sourceTurnId === 'string'
      ? context.sessionInputSource.sourceTurnId : undefined;
    const turnDepth = (admittedCaller?.success ? admittedCaller.data.turnDepth : params.getCurrentTurnWorkDepth?.(turnId))
      ?? (context.actionCaller?.kind !== 'session' && session.sessionId === params.sessionId
        && !params.getCurrentTurnWorkDepth ? 0 : undefined);
    if (turnDepth === undefined) return null;
    await prepareAccountRoleOverrides(context.signal);
    const roleSources = await readRoleSources(context.signal);
    const settings = params.actionsSettingsProvider?.getAccountSettings?.()
      ?? (params.credentials ? (await bootstrapAccountSettingsContext({ credentials: params.credentials, mode: 'blocking' })).settings : null);
    return resolveCliAgentStartContextV1({
      sessionId: session.sessionId,
      machineId: session.machineId, directory: session.directory,
      backendTarget: session.backendTarget ?? null,
      metadata: session.metadata, starterDepth: typeof starterDepth === 'number' ? starterDepth : undefined, runCaller,
      turnDepth,
      callerPermissionMode: context.callerPermissionMode ?? null, settings,
      accountRoleOverrides: readAccountRoleOverrides(),
      availableAgentTargetKeys: (await inventoryDeps.agentsBackendsList({ includeDisabled: false })).items
        .filter((item) => item.enabled).map((item) => item.targetKey),
      roleSourceInventory: roleSources,
    });
  };
  const approvalsStore = params.credentials ? createCliApprovalsArtifactStore({ credentials: params.credentials,
    serverId: params.serverId ?? configuration.activeServerId }) : null;
  const readPromptInvocations = async (signal?: AbortSignal): Promise<Readonly<{ invocations: unknown; assertCurrent: () => void }> | null> => {
    signal?.throwIfAborted();
    const credentials = params.credentials;
    if (!credentials) return null;
    const read = async () => {
      const store = createCliPromptLibraryStore({ credentials, signal });
      const catalog = await store.readPromptLibraryCatalog();
      const absent = (catalog.status === 'ready' || catalog.status === 'partial')
        && !catalog.rows.some(row => row.record.key === 'invocations')
        && !catalog.tombstones.some(row => row.key === 'invocations')
        && !catalog.diagnostics.some(row => row.key === 'invocations');
      const source = absent ? await store.readSourceSnapshot() : null;
      const current = readPromptLibraryCatalogRecordV1({ catalog, key: 'invocations', ...(source ? { rawSettings: source.raw } : {}) });
      store.assertCurrent();
      return current.status === 'ready' && current.record.key === 'invocations'
        ? { invocations: current.record.value, assertCurrent: store.assertCurrent } : null;
    };
    try { return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, read) : read()); }
    catch { signal?.throwIfAborted(); return null; }
  };
  const resolveSessionAgentIdentity = (metadata: Record<string, unknown> | null | undefined, backendTarget?: BackendTargetRefV2 | null) => {
    const agentId = backendTarget?.sourceKind === 'built_in'
      ? backendTarget.backendId : resolveAgentIdFromSessionMetadata(metadata);
    return agentId ? (backendTarget?.sourceKind === 'built_in' && isBundledAgentId(agentId) ? BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId]
      : readAgentCatalogSnapshot().agentDefinitionsById.get(agentId)?.identity) : undefined;
  };
  const invokeSessionPullRequestBinding = async (input: SessionPullRequestBindingInputV1, caller?: ActionExecutorContext) => {
    caller?.signal?.throwIfAborted();
    const transport = await resolveTransportForSession(input.sessionId, caller?.signal);
    if (!transport.ok) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
    const metadata = readTransportSessionOwnerMetadata(transport);
    const machineId = normalizeStringValue(transport.rawSession.machineId) ?? normalizeStringValue(metadata?.machineId);
    if (!machineId) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
    const action = { pluginId: 'happier.channels', localId: SESSION_PULL_REQUEST_BINDING_ACTION_ID_V1 };
    // The Account collection owns the link. Keep the actual invoking host's
    // caller/target authority; the Session identifies the binding, not a new principal.
    const context: ActionExecutorContext = { ...caller, defaultSessionId: input.sessionId };
    let response: unknown;
    if (params.invokeContributedAction) {
      const result = await params.invokeContributedAction({ action, input, context, ...(caller?.signal ? { signal: caller.signal } : {}) });
      if (!result.ok) throw Object.assign(new Error(result.errorCode), { code: result.errorCode });
      response = result.result;
    } else {
      if ((caller?.actionCaller && caller.actionCaller.kind !== 'host') || caller?.surface === 'agent' || caller?.surface === 'mcp') {
        throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
      }
      response = await callMachineAction({ machineId, method: 'action.invoke',
        request: createTargetedActionRpcRequestV1({ action, input }, { kind: 'machine', machineId }, { defaultSessionId: input.sessionId }),
        ...(caller?.signal ? { signal: caller.signal } : {}) });
    }
    caller?.signal?.throwIfAborted();
    if (response !== null && typeof response === 'object' && 'ok' in response && response.ok === false) {
      const code = 'errorCode' in response && typeof response.errorCode === 'string' ? response.errorCode : 'target_unavailable';
      throw Object.assign(new Error(code), { code });
    }
    const parsed = SessionPullRequestBindingResultV1Schema.safeParse(response);
    if (!parsed.success) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
    if (parsed.data.kind === 'links' && parsed.data.sessionId !== input.sessionId) {
      throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
    }
    return parsed.data;
  };
  const sessionList: ActionExecutorDeps['sessionList'] = params.credentials
    ? createSessionListActionDependency({
        credentials: params.credentials,
        ...(params.actionsSettingsProvider?.getAccountSettings
          ? { resolveAccountSettings: params.actionsSettingsProvider.getAccountSettings }
          : {}),
        ...(params.serverId ? { serverId: params.serverId } : {}),
        ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
        ...(params.serverHttpBaseUrl ? { serverHttpBaseUrl: params.serverHttpBaseUrl } : {}),
        ...(params.externalActionMachineRequestPrivateKey
          ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
          : {}),
        ...(params.externalActionMachineInstallationId
          ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
          : {}),
      })
    : async () => ({ ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' });
  let workflowTriggers: ReturnType<typeof createCliWorkflowTriggerActions> | null = null;
  let resolveWorkflowMaterializer: ReturnType<typeof createCredentialedWorkflowMaterializationHostV1> | null = null;
  const workflowDefinitions = params.credentials
    ? createWorkflowDefinitionActions({ artifactStore: roleArtifactStore!,
      readWorkflowTriggerSummaries: () => {
        if (!workflowTriggers) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
        return workflowTriggers.readWorkflowSummaries();
      },
      resolveMaterializer: (target) => {
        if (!resolveWorkflowMaterializer) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
        return resolveWorkflowMaterializer(target);
      },
      removeWorkflowTriggers: async (definitionId) => {
        if (!workflowTriggers) throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
        await workflowTriggers.removeForWorkflow(definitionId);
      } })
    : null;
  if (params.credentials && workflowDefinitions) {
    workflowTriggers = createCliWorkflowTriggerActions({ credentials: params.credentials,
      sessionList,
      pullRequests: {
        listLinks: async (sessionId, caller) => {
          const result = await invokeSessionPullRequestBinding({ kind: 'list', sessionId }, caller);
          if (result.kind !== 'links') throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
          return [...result.pullRequestLinks];
        },
        attach: async ({ sessionId, pullRequest, ...target }, caller) => {
          const result = await invokeSessionPullRequestBinding({ kind: 'attach', sessionId, pullRequest, target }, caller);
          if (result.kind !== 'attached') throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
        },
        removeTrigger: async (input, caller) => {
          const result = await invokeSessionPullRequestBinding({ kind: 'removeTrigger', ...input }, caller);
          if (result.kind !== 'removed') throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
        },
      },
      ...(params.serverHttpBaseUrl ? { serverHttpBaseUrl: params.serverHttpBaseUrl } : {}),
      resolveWorkflow: async (ref) => {
        const resolved = await resolveWorkflowDefinitionRefV1(ref, {
          readPluginWorkflows: workflowDefinitions.readPluginWorkflows,
          readArtifact: (definitionId, signal) => workflowDefinitions.get({ definitionId, ...(signal ? { signal } : {}) }),
        });
        if (!resolved) throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
        return resolved.definition;
      },
      resolveSession: async (sessionId, caller, options) => {
        const transport = await resolveTransportForSession(sessionId, caller?.signal);
        if (!transport.ok) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
        const metadata = readTransportSessionOwnerMetadata(transport);
        const machineId = normalizeStringValue(transport.rawSession.machineId) ?? normalizeStringValue(metadata?.machineId);
        const directory = normalizeStringValue(metadata?.path) ?? normalizeStringValue(transport.rawSession.path);
        if (!machineId || !directory) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
        let nativeGoalOwner: boolean | null = transport.rawSession.active === true ? null : false;
        if (options?.checkNativeGoalOwner === true && transport.rawSession.active === true) {
          const result = await callSessionRpcForTransport(transport, SESSION_RPC_METHODS.SESSION_GOAL_GET, { capabilitiesOnly: true });
          if (result !== null && typeof result === 'object' && 'nativeGoalOwner' in result && typeof result.nativeGoalOwner === 'boolean') {
            nativeGoalOwner = result.nativeGoalOwner;
          }
        }
        const identity = resolveSessionAgentIdentity(metadata, resolveBackendTargetFromSessionMetadata(metadata));
        const selection = identity ? WorkflowStepExecutionSelectionSchema.safeParse({
          agentTarget: { kind: 'agent', identity }, ...(metadata?.permissionMode ? { permissionMode: metadata.permissionMode } : {}),
        }) : null;
        return { project: { machineId, directory }, nativeGoalOwner,
          ...(selection?.success ? { executionSelection: selection.data } : {}) };
      },
      resolveMaterializer: async (target, caller) => {
        if (!resolveWorkflowMaterializer) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
        return resolveWorkflowMaterializer({ ...target, signal: caller.signal });
      },
      resolveRunTrigger: async (runId) => {
        const raw = await workflowRunStorage.execute({ operation: 'get', runId });
        const run = raw !== null && typeof raw === 'object' && 'run' in raw ? WorkflowRunSummaryV1Schema.safeParse(raw.run) : null;
        if (!run?.success || run.data.origin.kind !== 'automation') return null;
        const origin = run.data.origin;
        return origin.originSessionId && origin.cause && 'triggerId' in origin.cause && origin.cause.triggerId
          ? { sessionId: origin.originSessionId, triggerId: origin.cause.triggerId } : null;
      },
      resolveRunSource: async (source, caller) => {
        if (source.kind === 'workflow_run') {
          const raw = await workflowRunStorage.execute({ operation: 'get', runId: source.runId,
            ...(caller?.signal ? { signal: caller.signal } : {}) });
          const run = raw !== null && typeof raw === 'object' && 'run' in raw ? WorkflowRunSummaryV1Schema.safeParse(raw.run) : null;
          if (!run?.success || run.data.id !== source.runId) throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
          return { terminal: isTerminalAutomationRunStateV3(run.data.state) };
        }
        let raw: unknown;
        if (source.sessionId) {
          const transport = await resolveTransportForSession(source.sessionId);
          if (!transport.ok || readExecutionRunTransportMachineId(transport) !== source.machineId) {
            throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
          }
          raw = await getExecutionRun({ ...transport, token: params.token, sessionId: transport.sessionId,
            request: { runId: source.runId }, ...(caller?.signal ? { signal: caller.signal } : {}) });
        } else {
          raw = await callDetachedExecutionRunRpc(null, SESSION_RPC_METHODS.EXECUTION_RUN_GET,
            { runId: source.runId }, { targetMachineId: source.machineId, ...(caller?.signal ? { signal: caller.signal } : {}) });
        }
        const result = ExecutionRunGetResponseSchema.safeParse(raw);
        if (!result.success || result.data.run.runId !== source.runId) {
          throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
        }
        return { terminal: isExecutionRunTerminalStatus(result.data.run.status) };
      },
    });
  }
  const pluginPermissionGrantAction = params.credentials
    ? createPluginPermissionGrantActionExecutor({
      credentials: params.credentials,
      ...(params.revalidatePluginActionCallerMaterialization
        ? { revalidateCallerMaterialization: params.revalidatePluginActionCallerMaterialization }
        : {}),
    })
    : null;
  const pluginWebhookAction = params.credentials
    ? createPluginWebhookActionExecutor({
      credentials: params.credentials,
      ...(params.revalidatePluginActionCallerMaterialization
        ? { revalidateCallerMaterialization: params.revalidatePluginActionCallerMaterialization }
        : {}),
    })
    : null;
  const automationConversationAction = params.credentials
    ? createAutomationConversationActionExecutor({
      credentials: params.credentials,
      ...(params.revalidatePluginActionCallerMaterialization
        ? { revalidateCallerMaterialization: params.revalidatePluginActionCallerMaterialization }
        : {}),
      ...(params.revalidatePluginActionCallerOccurrence
        ? { revalidateCallerOccurrence: params.revalidatePluginActionCallerOccurrence }
        : {}),
    })
    : null;
  const automationEventAction = params.credentials && params.resolveAutomationEventAdoptedDefinitionSet
    ? createAutomationEventActionExecutor({
      credentials: params.credentials,
      resolveAdoptedDefinitionSet: params.resolveAutomationEventAdoptedDefinitionSet,
      ...(params.revalidatePluginActionCallerMaterialization
        ? { revalidateCallerMaterialization: params.revalidatePluginActionCallerMaterialization }
        : {}),
      ...(params.revalidatePluginActionCallerOccurrence
        ? { revalidateCallerOccurrence: params.revalidatePluginActionCallerOccurrence }
        : {}),
    })
    : null;
  const reviewCommentAction = params.credentials
    ? createCliReviewCommentActionExecutorFromCredentials({ credentials: params.credentials })
    : null;
  const promptAssetAdapterRegistry = createPromptAssetAdapterRegistry({
    ...(params.readRegisteredPromptAssetAdapters
      ? { readRegisteredAdapters: params.readRegisteredPromptAssetAdapters }
      : {}),
  });
  const promptRegistryAdapterRegistry = createPromptRegistryAdapterRegistry();
  type ResolvedSessionTransport = Extract<
    Awaited<ReturnType<typeof resolveSessionTransportContext>>,
    Readonly<{ ok: true }>
  >;
  const readTransportSessionOwnerMetadata = (transport: ResolvedSessionTransport) => params.credentials
    ? tryDecryptSessionOwnerMetadataView({ credentials: params.credentials,
        accountEncryptionMode: transport.accountEncryptionCurrentness.mode, rawSession: transport.rawSession })
    : null;
  type LifecycleHookSessionContext = Readonly<{
    machineId?: string;
    cwd?: string;
    workspaceId?: string;
  }>;

  const sessionTransportCache = new Map<string, ResolvedSessionTransport>();
  const ambiguousSpawnActionRequestIds = new Set<string>();
  const isMachineActionServerScopeCurrent = (serverId?: string | null): boolean =>
    !serverId || serverId === (params.serverId ?? configuration.activeServerId);
  const callMachineAction = async (input: Readonly<{
    machineId: string;
    authority?: ActionExecutorContext['authority'];
    serverId?: string;
    method: string;
    request: unknown;
    authorization?: ActionExecutorContext['rpcSessionAuthorization'];
    signal?: AbortSignal;
    timeoutMs?: number | null;
    exactMachine?: true;
    context?: ActionExecutorContext & Pick<RpcLocalActionContext, 'requesterWorkAttributionV1' | 'operationReview'>;
    effectActionId?: string;
  }>): Promise<unknown> => {
    if (!isMachineActionServerScopeCurrent(input.serverId)) {
      throw Object.assign(new Error('server_scope_mismatch'), { code: 'server_scope_mismatch' });
    }
    const direct = params.machineActionDirectTargetTransport;
    const externalRequest = input.context?.externalActionCredential !== undefined
      || input.context?.externalActionExecutionAuthorization !== undefined;
    if (externalRequest && (!params.externalActionMachineRequestPrivateKey || !params.externalActionMachineInstallationId
      || !input.effectActionId || !input.context?.externalActionExecutionAuthorization || !input.context.externalActionTarget)) {
      throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
    }
    if (direct?.machineId === input.machineId && !externalRequest && input.method !== RPC_METHODS.MACHINES_WORK_SUMMARY_GET) {
      const localActionContext: RpcLocalActionContext = {
        ...(input.authority ? { authority: input.authority } : {}),
        ...(input.context?.actionRequestId ? { actionRequestId: input.context.actionRequestId } : {}),
        ...(input.context?.executionRunWorkflowRunId ? { executionRunWorkflowRunId: input.context.executionRunWorkflowRunId } : {}),
        ...(input.context?.executionRunTargetMachineId ? { executionRunTargetMachineId: input.context.executionRunTargetMachineId } : {}),
        ...(input.context?.operationProgress ? { operationProgress: input.context.operationProgress } : {}),
        ...(input.context?.operationOwnerUpdate ? { operationOwnerUpdate: input.context.operationOwnerUpdate } : {}),
        ...(input.context?.operationAcceptance ? { operationAcceptance: input.context.operationAcceptance } : {}),
        ...(input.context?.operationCancellation ? { operationCancellation: input.context.operationCancellation } : {}),
        ...(input.context?.operationReview ? { operationReview: input.context.operationReview } : {}),
        ...(input.context?.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: input.context.requesterWorkAttributionV1 } : {}),
      };
      const hasLocalActionContext = Object.keys(localActionContext).length > 0;
      return await direct.invoke(
        input.method,
        input.request,
        input.signal || hasLocalActionContext ? {
          ...(input.signal ? { signal: input.signal } : {}),
          ...(hasLocalActionContext ? { localActionContext } : {}),
        } : undefined,
      );
    }
    const invoke = input.exactMachine ? callExactMachineRpc : callMachineRpc;
    return await invoke({
      credentials: params.credentials!,
      machineId: input.machineId,
      method: input.method,
      request: input.request,
      ...(input.context?.actionRequestId ? { requestId: input.context.actionRequestId } : {}),
      ...(externalRequest && input.context && input.effectActionId && params.externalActionMachineInstallationId
        && params.externalActionMachineRequestPrivateKey ? { externalAction: { context: input.context, effectActionId: input.effectActionId,
          installationId: params.externalActionMachineInstallationId, privateKey: params.externalActionMachineRequestPrivateKey } } : {}),
      ...(input.authorization ? { authorization: input.authorization } : {}),
      ...executionRunAuthorityCeiling(input),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
  };

  const readWidgetProjection = async (signal?: AbortSignal, sessionRef?: Readonly<{ serverId: string; sessionId: string }>) => {
    signal?.throwIfAborted();
    if (sessionRef && sessionRef.serverId !== (params.serverId ?? configuration.activeServerId)) {
      throw Object.assign(new Error('server_scope_mismatch'), { code: 'server_scope_mismatch' });
    }
    const transport = sessionRef ? await resolveTransportForSession(sessionRef.sessionId, signal) : null;
    if (transport && (!transport.ok || transport.sessionId !== sessionRef!.sessionId)) {
      throw Object.assign(new Error('widget_catalog_unavailable'), { code: 'widget_catalog_unavailable' });
    }
    const machineId = transport?.ok
      ? normalizeStringValue(readTransportSessionOwnerMetadata(transport)?.machineId)
      : params.machineActionDirectTargetTransport?.machineId ?? normalizeStringValue(await resolveCurrentSessionValue('machineId'));
    if (!machineId) return null;
    const result = DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(await callMachineAction({
      machineId, serverId: params.serverId ?? configuration.activeServerId,
      method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
      request: { machineId }, ...(signal ? { signal } : {}),
    }));
    signal?.throwIfAborted();
    if (!result.success) throw Object.assign(new Error('widget_catalog_unavailable'), { code: 'widget_catalog_unavailable' });
    return result.data.projection;
  };
  const readWidgetCandidates = async (signal?: AbortSignal, sessionRef?: Readonly<{ serverId: string; sessionId: string }>) => {
    const projection = await readWidgetProjection(signal, sessionRef);
    return projection ? readCliWidgetCatalogProjectionV1(projection)
      : BUILTIN_WIDGET_DESCRIPTORS_V1.map(candidate => ({ ...candidate, fields: candidate.inputs?.fields ?? [], connectedAccountPurposeBindings: [] }));
  };
  const readHomeWidgets = async (signal?: AbortSignal, layout?: HomeHubLayoutValue) => {
    const candidates = await readWidgetCandidates(signal);
    const referenced = new Set(layout ? flattenWidgetLayoutWidgetsV1(layout.items).flatMap(({ instance }) => instance.definition.kind === 'artifact' ? [instance.definition.artifactId] : []) : []);
    if (referenced.size === 0) return candidates;
    const definitions = await actionDeps.widgetDefinitionArtifacts?.list(signal) ?? [];
    return [...candidates, ...definitions.filter(summary => referenced.has(summary.artifactId)).map(summary => ({
      key: `artifact:${summary.artifactId}`, homeDefault: 'available' as const,
      definition: { kind: 'artifact' as const, artifactId: summary.artifactId }, sizeDeclaration: summary.sizeDeclaration,
    }))];
  };

  const inventoryDeps = createCliActionInventoryDeps({ ...params, callMachineAction,
    readCurrentSessionMetadata: () => readCurrentSessionMetadata(),
    resolveTransportForSession: (id) => resolveTransportForSession(id),
  });
  const signInOperations = (target: Readonly<{ machineId: string; serverId?: string; signal?: AbortSignal }>): Parameters<typeof restartMachineAgentSignIn>[1] => {
    const { machineId, serverId, signal } = target;
    return {
      signal,
      prepare: (request) => callMachineAction({ machineId, serverId, method: AGENT_SIGN_IN_PREPARE_RPC_METHOD, request, signal }),
      beginConnect: async (command) => ConnectedAccountAttemptResponseSchema.parse(await callMachineAction({
        machineId, serverId, method: CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD, request: { v: 1, machineId, command }, signal,
      })),
      ensureTerminal: async (request) => DaemonTerminalEnsureResponseSchema.parse(await callMachineAction({
        machineId, serverId, method: RPC_METHODS.DAEMON_TERMINAL_ENSURE, request,
      })),
      listTerminals: async () => DaemonTerminalListResponseV1Schema.parse(await callMachineAction({
        machineId, serverId, method: RPC_METHODS.DAEMON_TERMINAL_LIST, request: {}, signal,
      })),
      // Cleanup must retain an acquired process even after the initiating request aborts.
      closeTerminal: async (terminalId) => DaemonTerminalCloseResponseSchema.parse(await callMachineAction({
        machineId, serverId, method: RPC_METHODS.DAEMON_TERMINAL_CLOSE, request: { terminalId },
      })),
    };
  };

  resolveWorkflowMaterializer = params.credentials && workflowDefinitions
    ? createCredentialedWorkflowMaterializationHostV1({
      credentials: params.credentials, readRoleSources,
      ...(params.serverHttpBaseUrl ? { serverHttpBaseUrl: params.serverHttpBaseUrl } : {}),
      callMachineAction,
      readHostActionContract: async (actionId, target) => {
        const result = await requestDaemonSignedRootActionExecution({ actionId: 'action.spec.get', input: { id: actionId },
          target: { kind: 'machine', machineId: target.machineId, project: { machineId: target.machineId, directory: target.directory } },
        }, target.signal ? { signal: target.signal } : {});
        if (!result.ok || !result.result || typeof result.result !== 'object') return null;
        const action = ActionDefinitionV1Schema.safeParse(Reflect.get(result.result, 'actionSpec'));
        if (!action.success) return null;
        const inputSchema = StrictJsonValueSchema.safeParse(action.data.inputSchema);
        const outputSchema = StrictJsonValueSchema.safeParse(action.data.outputSchema);
        return inputSchema.success && outputSchema.success ? { inputSchema: inputSchema.data, outputSchema: outputSchema.data } : null;
      },
      readWorkflowDefinition: (ref, signal) => resolveWorkflowDefinitionRefV1(formatWorkflowDefinitionRefV1(ref), {
        readPluginWorkflows: workflowDefinitions.readPluginWorkflows,
        readArtifact: (definitionId, readSignal) => workflowDefinitions.get({ definitionId, ...(readSignal ? { signal: readSignal } : {}) }),
        ...(signal ? { signal } : {}),
      }),
    }) : null;

  const resolveWorkspaceSyncReadController = async (input: Readonly<{
    controllerMachineId?: string;
    workspaceRefId?: string;
    relationshipId?: string;
  }>, signal?: AbortSignal): Promise<string> => {
    if (!params.credentials) {
      throw Object.assign(new Error('Workspace sync read requires an authenticated Account'), { code: 'not_authenticated' });
    }
    const current = await readProjectRows(signal);
    const currentServerId = params.serverId ?? configuration.activeServerId;
    const workspaceRefs = current.workspaceRefs;
    const relationships = current.relationships;
    let resolvedController: string | undefined;
    if (input.workspaceRefId) {
      const topology = deriveWorkspaceSyncTopology({ workspaceRefs, relationships, serverId: currentServerId });
      const matching = topology.sets.filter((set) => set.relationships.some((relationship) => (
        relationship.alphaWorkspaceRefId === input.workspaceRefId
        || relationship.betaWorkspaceRefId === input.workspaceRefId
      )));
      if (matching.length !== 1 || topology.issues.some((issue) => issue.workspaceRefIds.includes(input.workspaceRefId!))) {
        throw Object.assign(new Error('Workspace sync membership is unavailable'), { code: 'workspace_sync_topology_invalid' });
      }
      const set = matching[0]!;
      const memberIds = new Set(set.relationships.flatMap((relationship) => [
        relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId,
      ]));
      if ([...memberIds].some((id) => !resolveWorkspaceRefById(workspaceRefs, id, currentServerId))) {
        throw Object.assign(new Error('Workspace sync membership belongs to another Home'), { code: 'workspace_ref_not_ready' });
      }
      resolvedController = set.controllerMachineId;
    }
    if (input.relationshipId) {
      const relationship = relationships.find((entry) => entry.relationshipId === input.relationshipId);
      if (!relationship || [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId]
        .some((id) => !resolveWorkspaceRefById(workspaceRefs, id, currentServerId))) {
        throw Object.assign(new Error('Workspace sync relationship is unavailable'), { code: 'relationship_not_ready' });
      }
      if (resolvedController && resolvedController !== relationship.controllerMachineId) {
        throw Object.assign(new Error('Workspace sync relationship changed'), { code: 'relationship_changed' });
      }
      resolvedController = relationship.controllerMachineId;
    }
    if (input.controllerMachineId && resolvedController && input.controllerMachineId !== resolvedController) {
      throw Object.assign(new Error('Workspace sync controller changed'), { code: 'relationship_changed' });
    }
    return resolvedController ?? input.controllerMachineId
      ?? (() => { throw Object.assign(new Error('Workspace sync controller is unavailable'), { code: 'relationship_not_ready' }); })();
  };

  const readCurrentSessionMetadata = createCliBoundSessionMetadataReader({ ...params,
    // Transport resolution is lazy; the owner is constructed later in this composition.
    resolveTransportForSession: (id) => resolveTransportForSession(id),
  });

  const resolveCurrentSessionValue = async (key: 'path' | 'host' | 'machineId'): Promise<string | null> => {
    const rawValue = params.rawSession?.[key];
    if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
      return rawValue.trim();
    }

    const metadata = await readCurrentSessionMetadata();
    const metadataValue = metadata?.[key];
    return typeof metadataValue === 'string' && metadataValue.trim().length > 0
      ? metadataValue.trim()
      : null;
  };

  const resolveWorkflowIngressContext = async (
    context: ActionExecutorContext,
  ): Promise<ReturnType<typeof WorkflowIngressContextV1Schema.parse> | undefined> => {
    const session = await resolveActionCallerSession(context);
    if (!session) return undefined;

    // The live Session client is the canonical current Agent authority for the
    // hosting Session. The synced Session record is a fallback for a field the
    // live context does not supply, never an unconditional prerequisite.
    const agentIdentity = resolveSessionAgentIdentity(session.metadata, session.backendTarget);
    const { machineId, directory } = session;
    return WorkflowIngressContextV1Schema.parse({
      ...(agentIdentity ? { agentTarget: { kind: 'agent', identity: agentIdentity } } : {}),
      ...(machineId ? { machineId } : {}),
      ...(directory ? { directory } : {}),
    });
  };

  const workflowRunServerHttpBaseUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const workflowRunStorage: WorkflowAccountRunActionDeps['storage'] = {
    observeChanges: (runId, onChange, onError) => createWorkflowRunStorageClient({
      token: params.token,
      serverHttpBaseUrl: workflowRunServerHttpBaseUrl,
    }).observeChanges(runId, onChange, onError),
    execute: async (operation, options) => {
      let machineId: string | undefined;
      if (isWorkflowRunExecutorStorageOperationV1(operation.operation)) {
        const publisherMachineId = normalizeStringValue(options?.publisherMachineId);
        const operationMachineId = publisherMachineId ?? (typeof operation.machineId === 'string' && operation.machineId.trim()
          ? operation.machineId.trim()
          : null);
        const settingsMachineId = operationMachineId ? null : normalizeStringValue((await readSettings()).machineId);
        const resolvedMachineId = operationMachineId ?? settingsMachineId ?? await resolveCurrentSessionValue('machineId');
        if (!resolvedMachineId) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
        machineId = resolvedMachineId;
      }
      return await createWorkflowRunStorageClient({
        token: params.token,
        ...(machineId ? { machineId } : {}),
        serverHttpBaseUrl: workflowRunServerHttpBaseUrl,
      }).execute(
        operation as Parameters<ReturnType<typeof createWorkflowRunStorageClient>['execute']>[0],
        options?.signal ? { signal: options.signal } : {},
      );
    },
  };
  const resolveWorkflowRunEncryption: WorkflowAccountRunActionDeps['resolveEncryption'] = async (signal) => {
    const resolved = await resolveValidatedAutomationAccountEncryptionV1({
      signal: signal ?? new AbortController().signal,
      resolveAccountEncryptionCurrentness: async (currentnessSignal) => await fetchAccountEncryptionCurrentness({
        token: params.token,
        ...(currentnessSignal ? { signal: currentnessSignal } : {}),
      }),
      resolveAccountEncryptionMaterial: async () => createAutomationAccountEncryptionMaterialSnapshotV1(params.credentials!),
    });
    if (resolved.kind !== 'available') throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
    return resolved;
  };

  const workflowAction = params.workflowAction ?? (workflowDefinitions && params.credentials
    ? createWorkflowActionExecutor({
        isWorkflowFeatureEnabled: async () => {
          try {
            return isWorkflowRuntimeEnabled(process.env, await readServerFeaturesSnapshot());
          } catch {
            return false;
          }
        },
        resolveIngressContext: async (args) => await resolveWorkflowIngressContext(args.context),
        resolveTargetValidation: async (args) => {
          try {
            const machines = await listCurrentAccountMachines({
              token: params.token,
              ...(params.serverHttpBaseUrl ? { serverHttpBaseUrl: params.serverHttpBaseUrl } : {}),
              ...(args.context.signal ? { signal: args.context.signal } : {}),
            });
            const target = resolveExplicitSessionSpawnMachineTarget({
              machineId: args.input.target?.machineId,
              machines: machines.map((machine) => ({ machineId: machine.id })),
            });
            if (target.kind === 'resolved') return { targetValidation: 'checked' as const };
          } catch {
            // The canonical inventory owner reported an unavailable observation.
          }
          return {
            targetValidation: 'unavailable' as const,
            targetIssues: [{
              code: 'target_unavailable' as const,
              path: '/target/machineId',
              message: 'The requested Workflow target is unavailable.',
              severity: 'error' as const,
            }],
          };
        },
        definitions: workflowDefinitions,
        ...(workflowTriggers ? { triggers: workflowTriggers } : {}),
        runs: createWorkflowRunActionOwner({
          resolveAgentStartContext,
          inputTypeDeps: createCommittedInputTypeDeps(),
          resolveMaterializationContext: async (args, target) => {
            if (!resolveWorkflowMaterializer) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
            const metadata = await readCurrentSessionMetadata();
            const baseline = (await resolveActionAgentStartContextV1({ resolveAgentStartContext }, args.context))?.baseline.configuration;
            return await resolveWorkflowMaterializer({ ...target, signal: args.context.signal,
              roleSelection: {
                sessionRoles: readSessionRolesV1(metadata) ?? undefined,
                ...(baseline?.agentTarget ? { defaultEngine: { agentTargetKey: buildBackendTargetKeyV2(baseline.agentTarget),
                  ...(baseline.modelSelection ? { modelId: 'ref' in baseline.modelSelection
                    ? baseline.modelSelection.ref.modelId : baseline.modelSelection.modelId } : {}) } } : {}),
              },
            });
          },
          doesImmediateEligibleStepTargetSession: doesWorkflowImmediateEligibleStepTargetSession,
          resolveAccountId: async (signal) => await fetchChangesAccountId({
            token: params.token,
            ...(signal ? { signal } : {}),
          }),
          storage: workflowRunStorage,
          definitions: workflowDefinitions,
          readPluginWorkflows: workflowDefinitions.readPluginWorkflows,
          resolveEncryption: resolveWorkflowRunEncryption,
          observeRecovery: async ({ run, progress, signal }) => await observeWorkflowInvocationRecoveryEvidence({
            credentials: params.credentials!, machineId: run.machineId, progress,
            getOperation: async (operation) => await callMachineAction({ serverId: operation.serverId,
              machineId: operation.machineId, method: ACTION_OPERATION_RPC_METHODS_V2.get,
              request: { operationId: operation.operationId }, exactMachine: true, ...(signal ? { signal } : {}) }),
            getRun: async (request) => await callDetachedExecutionRunRpc(null, SESSION_RPC_METHODS.EXECUTION_RUN_GET,
              request, { exactMachineId: run.machineId, ...(signal ? { signal } : {}) }),
            ...(signal ? { signal } : {}),
          }),
          reattachInvocation: async ({ run, index, signal }) => {
            const census = WorkflowRunRecipientCensusResponseV1Schema.parse(await workflowRunStorage.execute({
              operation: 'run-key.census', runId: run.id,
            }, signal ? { signal } : {}));
            const resolved = resolveWorkflowRunDataKeyV1({ encryption: await resolveWorkflowRunEncryption(signal), census });
            if (resolved.kind !== 'available') throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
            const writer = createWorkflowInvocationRecoveryFactWriter({ accountId: census.ownerAccountId, run, expectedRevision: run.revision,
              encryption: resolved.encryption,
              onReviewEntered: createWorkflowRunReviewEntryNotificationHandler({
                expoPushSender: createWorkflowRunPushNotificationClient(params.token),
              }),
              storage: { execute: async (operation, options) => await workflowRunStorage.execute(operation, {
                ...options, publisherMachineId: run.machineId,
              }) },
              ...(signal ? { signal } : {}),
            });
            const invocation = await writer.readInvocation(index.id);
            if (!invocation || invocation.index.attempt !== index.attempt || invocation.index.lifecycle !== index.lifecycle) {
              throw Object.assign(new Error('workflow_invocation_fact_conflict'), { code: 'workflow_invocation_fact_conflict' });
            }
            const observe = createWorkflowInvocationRecoveryObserver({ credentials: params.credentials!, machineId: run.machineId,
              nativeActionOperations: {
                get: async (operation, observationSignal) => await callMachineAction({ serverId: operation.serverId,
                  machineId: operation.machineId, method: ACTION_OPERATION_RPC_METHODS_V2.get,
                  request: { operationId: operation.operationId }, exactMachine: true, ...(observationSignal ? { signal: observationSignal } : {}) }),
                cancel: async () => { throw Object.assign(new Error('workflow_observation_only'), { code: 'workflow_observation_only' }); },
                wait: async () => { throw Object.assign(new Error('workflow_observation_only'), { code: 'workflow_observation_only' }); },
              },
              nativeActionRuns: {
                get: async (runId, observationSignal) => await callDetachedExecutionRunRpc(null, SESSION_RPC_METHODS.EXECUTION_RUN_GET,
                  { runId, includeStructured: true }, { exactMachineId: run.machineId,
                    ...(observationSignal ? { signal: observationSignal } : {}) }),
                stop: async () => { throw Object.assign(new Error('workflow_observation_only'), { code: 'workflow_observation_only' }); },
                wait: async () => { throw Object.assign(new Error('workflow_observation_only'), { code: 'workflow_observation_only' }); },
              },
              actionExecutor: { execute: async (actionId, request, context) => {
                // This port is intentionally read-only: observation reattach
                // cannot reach the stop/send/start/resume effects.
                if (actionId !== 'execution.run.get') return { ok: false, errorCode: 'workflow_observation_only' };
                const native = await callDetachedExecutionRunRpc(null, SESSION_RPC_METHODS.EXECUTION_RUN_GET,
                  { runId: request.runId, includeStructured: false }, {
                    exactMachineId: run.machineId, ...(context.signal ? { signal: context.signal } : {}),
                  });
                return { ok: true, result: native };
              } },
            });
            const observation = await observe({ progress: invocation.progress, terminalParent: false,
              ...(invocation.progress.execution?.kind === 'action'
                ? { frozenActionContract: await writer.resolveFrozenActionContract(invocation) } : {}),
              cancellationRequested: invocation.index.lifecycle === 'cancel_requested', observationOnly: true,
              ...(signal ? { signal } : {}),
            });
            await writer.commitObservation(invocation, observation);
          },
          prepareWorkspace: async ({ projectTarget, definition }) => {
            if (!projectTarget.workspaceRefId) {
              return await prepareWorkflowAcceptedWorkspaceTarget({ projectTarget, definition });
            }
            const rows = await readProjectRows();
            return await prepareWorkflowAcceptedWorkspaceTarget({
              projectTarget,
              definition,
              currentServerId: params.serverId ?? configuration.activeServerId,
              resolveWorkspaceRef: (workspaceRefId) => resolveWorkspaceRefById(
                rows.workspaceRefs,
                workspaceRefId,
                params.serverId ?? configuration.activeServerId,
              ),
            });
          },
          restoreWorkspace: async (workspace) => await restoreRecordedWorkflowWorkspace({ workspace }),
          ...(params.workflowAcceptedAuthorizationCurrentness
            ? { isAcceptedAuthorizationCurrent: params.workflowAcceptedAuthorizationCurrentness }
            : {}),
        }),
      })
    : null);

  let currentMachineControlIdentityPromise: Promise<CurrentMachineControlIdentity> | null = null;

  const readCurrentMachineControlIdentity = async (): Promise<CurrentMachineControlIdentity> => {
    currentMachineControlIdentityPromise ??= (async () => {
      let machineId: string | null = null;
      try {
        machineId = normalizeStringValue((await readSettings()).machineId);
      } catch {
        machineId = null;
      }

      let host: string | null = null;
      try {
        host = normalizeStringValue(await getPreferredHostName());
      } catch {
        host = null;
      }

      return {
        machineId,
        host,
        homeDir: normalizeStringValue(homedir()),
      };
    })();
    return await currentMachineControlIdentityPromise;
  };

  const resolveSessionSpawnAgentInventorySelection: NonNullable<
    ActionExecutorDeps['resolveSessionSpawnAgentInventorySelection']
  > = ({ agentTarget }) => {
    const resolvedTarget = resolveSessionCreationAgentTarget(agentTarget);
    return resolvedTarget
      ? {
          agentId: resolvedTarget.agentId,
          backendTargetKey: buildBackendTargetKeyV2(resolvedTarget.backendTarget),
        }
      : null;
  };

  const requireLocalPromptActionMachine = async (machineId: string): Promise<Readonly<{
    ok: true;
  }> | Readonly<{
    ok: false;
    errorCode: 'machine_not_found';
    error: 'machine_not_found';
  }>> => {
    const current = await readCurrentMachineControlIdentity();
    return current.machineId === machineId
      ? { ok: true }
      : { ok: false, errorCode: 'machine_not_found', error: 'machine_not_found' };
  };

  const capturePromptExternalLinkAccount = (signal?: AbortSignal) => {
    const credentials = params.credentials;
    if (!credentials) return notSupported();
    const capture = () => ({ credentials, scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
      lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), store: createCliPromptLibraryStore({ credentials, signal }) });
    return params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, capture) : capture();
  };
  const resolvePromptExternalLinkMachineContext = async (machineId: string) => {
    let serverIdentityId = params.serverIdentityId;
    if (!serverIdentityId) {
      try {
        const profile = await getServerProfile(projectHomeId);
        if (profile.homeConnectionDescriptorAuthority === 'exact') {
          serverIdentityId = profile.homeConnectionDescriptor?.homeServerIdentityId;
        }
      } catch { return null; }
    }
    const target = MachineAdministrationTargetV1Schema.safeParse({ serverIdentityId, machineId });
    // These Actions execute only on this host's admitted local Machine; its
    // Home is also the captured library Home. Routing profile ids are not identity.
    return target.success ? { machineTarget: target.data, libraryServerIdentityId: target.data.serverIdentityId } : null;
  };
  const readPromptExternalLinks = async (account: ReturnType<typeof capturePromptExternalLinkAccount>, signal?: AbortSignal) => {
    try {
      const catalog = await account.store.readPromptLibraryCatalog();
      const absent = (catalog.status === 'ready' || catalog.status === 'partial')
        && !catalog.rows.some(row => row.record.key === 'external-links')
        && !catalog.tombstones.some(row => row.key === 'external-links')
        && !catalog.diagnostics.some(row => row.key === 'external-links');
      const source = absent ? await account.store.readSourceSnapshot() : null;
      const current = readPromptLibraryCatalogRecordV1({ catalog, key: 'external-links', ...(source ? { rawSettings: source.raw } : {}) });
      account.store.assertCurrent();
      if (current.status !== 'ready' || current.record.key !== 'external-links') return null;
      const lastKnownVersion = current.revision === 'absent' ? source?.version : current.revision;
      if (lastKnownVersion === undefined) return null;
      return { account, value: current.record.value, revision: current.revision,
        sourceSettingsVersion: source?.version, lastKnownVersion };
    } catch { signal?.throwIfAborted(); return null; }
  };

  const persistPromptExternalLink = async (
    nextLinks: PromptExternalLinksV1 | undefined,
    source: NonNullable<Awaited<ReturnType<typeof readPromptExternalLinks>>>,
    signal?: AbortSignal,
  ): Promise<PromptExternalLinkPersistenceSettlement | undefined> => {
    if (!nextLinks) return undefined;
    const nextLink = nextLinks.links.at(-1);
    if (!nextLink) return undefined;
    try {
      source.account.store.assertCurrent();
      signal?.throwIfAborted();
      const result = await source.account.store.writeRecord({ record: { key: 'external-links', value: nextLinks },
        expectedRevision: source.revision,
        ...(source.sourceSettingsVersion === undefined ? {} : { sourceSettingsVersion: source.sourceSettingsVersion }) });
      if (result.status === 'updated') {
        // This receipt describes the acknowledged effect even if its captured
        // Account retires before the incumbent projection can be refreshed.
        try {
          const refresh = () => refreshActivePromptLibraryCatalogAfterChange(source.account);
          await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, refresh) : refresh());
        } catch { /* Projection failure cannot undo an acknowledged row CAS. */ }
        return { status: 'applied', version: result.revision };
      }
      if (result.status === 'conflict' || result.status === 'settings-conflict') return { status: 'conflict', currentVersion: result.revision };
      if (result.status === 'account-mode-mismatch') return { status: 'locked', reason: 'modeMismatch' };
      if (result.status === 'invalid-stored-content') return { status: 'invalid', reason: 'invalidValue' };
      return { status: 'unavailable', retryable: false };
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'outcome_unknown') return { status: 'outcomeUnknown', lastKnownVersion: source.lastKnownVersion };
      if (signal?.aborted) return { status: 'cancelled', submitted: false };
      // The external effect already succeeded. Refusal or loss of the captured
      // Account must not rewrite that effect as failure or restore Settings.
      return Object.freeze({ status: 'unavailable' as const, retryable: false });
    }
  };

  const resolveTransportForSession = async (idOrPrefix: string, signal?: AbortSignal): Promise<ResolvedSessionTransport | Readonly<{
    ok: false;
    code: string;
    candidates?: string[];
  }>> => {
    signal?.throwIfAborted();
    if (!params.credentials) {
      return { ok: false, code: 'not_authenticated' };
    }

    const normalized = String(idOrPrefix ?? '').trim();
    if (!normalized) {
      return { ok: false, code: 'session_not_found' };
    }
    const cachedTransport = sessionTransportCache.get(normalized);
    if (cachedTransport) return cachedTransport;

    const serverFeaturesSnapshot = await readServerFeaturesSnapshot();
    const resolved = await resolveSessionTransportContext({
      credentials: params.credentials,
      idOrPrefix: normalized,
      ...(signal ? { signal } : {}),
      ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
    });
    if (!resolved.ok) {
      return {
        ok: false,
        code: resolved.code,
        ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
      };
    }

    const cached: ResolvedSessionTransport = resolved;
    sessionTransportCache.set(resolved.sessionId, cached);
    // If the input is already a full id, also cache by that literal.
    sessionTransportCache.set(normalized, cached);
    return cached;
  };

  const resumeInactiveSessionTransport = async (input: Readonly<{
    transport: ResolvedSessionTransport;
    localId: string;
    signal?: AbortSignal;
    waitForReady?: boolean;
    approvedNewDirectoryCreation?: boolean;
  }>) => {
    if (input.transport.rawSession.active === true) {
      return { ok: true } as const;
    }
    if (!params.credentials) {
      return {
        ok: false,
        code: 'unsupported',
        message: 'Inactive session resume requires authentication',
      } as const;
    }
    const metadata = readTransportSessionOwnerMetadata(input.transport) ?? {};
    return await requestInactiveSessionResume({
      credentials: params.credentials,
      sessionId: input.transport.sessionId,
      localId: input.localId,
      rawSession: input.transport.rawSession,
      metadata,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.waitForReady === true ? { waitForReady: true } : {}),
      ...(input.approvedNewDirectoryCreation === true ? { approvedNewDirectoryCreation: true } : {}),
    });
  };

  type ExecutionRunActionTransportOptions = Readonly<{
    authority?: ActionExecutorContext['authority'];
    workDepth?: number;
    workspaceWrites?: 'allow' | 'deny';
    agentStartContext?: ActionExecutorContext['agentStartContext'];
    sessionAgentSpawnPolicyV1?: unknown;
    causalPermissionAuthority?: ActionExecutorContext['causalPermissionAuthority'];
    serverId?: string | null;
    originSessionId?: string | null;
    targetMachineId?: string | null;
    exactMachineId?: string | null;
    signal?: AbortSignal;
    permissionRequestStore?: unknown;
    workflowObservationSink?: unknown;
    workflowRunId?: string;
    requesterWorkAttributionV1?: RpcLocalActionContext['requesterWorkAttributionV1'];
  }>;
  function executionRunAuthorityCeiling(opts?: Pick<ExecutionRunActionTransportOptions, 'authority'>): Readonly<{
    authorityCeiling?: 'account_automation';
  }> {
    return opts?.authority === 'account_automation' ? { authorityCeiling: 'account_automation' } : {};
  }
  type ExecutionRunMachineTarget =
    | Readonly<{ ok: true; machineId: string }>
    | Readonly<{ ok: false; errorCode: 'execution_run_target_not_selected' | 'execution_run_target_unavailable' }>;

  const readExecutionRunTransportMachineId = (transport: ResolvedSessionTransport): string | null => {
    const metadata = readTransportSessionOwnerMetadata(transport);
    return normalizeStringValue(transport.rawSession.machineId)
      ?? normalizeStringValue(metadata?.machineId);
  };

  /**
   * Scope selection is authoritative before this point. This only resolves the
   * already-selected Session's daemon (or the caller's current device outside
   * a Session); it never scans, falls back, or accepts a machine id from Action
   * input.
   */
  const resolveExecutionRunMachineTarget = async (
    sessionId: string | null,
    opts?: ExecutionRunActionTransportOptions,
  ): Promise<ExecutionRunMachineTarget> => {
    const preflightMachineId = normalizeStringValue(opts?.exactMachineId);
    if (preflightMachineId) return { ok: true, machineId: preflightMachineId };

    // A bound host admits this target before Action dispatch. It is neither
    // mutable Action input nor a fallback candidate: V2 capability preflight
    // must interrogate this exact daemon before the resulting exactMachineId
    // pins every later control.
    const admittedMachineId = normalizeStringValue(opts?.targetMachineId);
    if (admittedMachineId) return { ok: true, machineId: admittedMachineId };

    const originSessionId = normalizeStringValue(opts?.originSessionId);
    const ownSessionId = params.sessionId !== 'cli-global' && params.sessionId !== 'plugin-global'
      ? normalizeStringValue(params.sessionId)
      : null;
    const targetSessionId = sessionId ?? originSessionId ?? ownSessionId;

    if (targetSessionId) {
      const transport = await resolveTransportForSession(targetSessionId);
      if (!transport.ok) return { ok: false, errorCode: 'execution_run_target_unavailable' };
      const machineId = readExecutionRunTransportMachineId(transport);
      return machineId
        ? { ok: true, machineId }
        : { ok: false, errorCode: 'execution_run_target_unavailable' };
    }

    const local = await readCurrentMachineControlIdentity();
    return local.machineId
      ? { ok: true, machineId: local.machineId }
      : { ok: false, errorCode: 'execution_run_target_not_selected' };
  };

  const requiresDirectExecutionRunTransport = (opts?: ExecutionRunActionTransportOptions) =>
    opts?.workDepth !== undefined || opts?.workspaceWrites !== undefined || opts?.permissionRequestStore !== undefined
      || opts?.workflowObservationSink !== undefined || opts?.workflowRunId !== undefined
      || opts?.requesterWorkAttributionV1 !== undefined;

  const callDetachedExecutionRunRpc = async (
    sessionId: string | null,
    method: string,
    request: unknown,
    opts?: ExecutionRunActionTransportOptions,
  ): Promise<unknown> => {
    const isStart = method === SESSION_RPC_METHODS.EXECUTION_RUN_START;
    const failure = (code: string, runCreation: 'noRunCreated' | 'outcomeUnknown', message?: string) => ({
      ok: false as const,
      code,
      ...(message ? { message } : {}),
      ...(isStart
        ? { details: withExecutionRunStartFailureDetails(undefined, runCreation) }
        : {}),
    });
    if (!params.credentials) {
      return failure('not_authenticated', 'noRunCreated');
    }
    const target = await resolveExecutionRunMachineTarget(sessionId, opts);
    if (!target.ok) return failure(target.errorCode, 'noRunCreated');
    try {
      if (opts && requiresDirectExecutionRunTransport(opts)) {
        const direct = params.machineActionDirectTargetTransport;
        if (!direct || direct.machineId !== target.machineId) {
          return failure('execution_run_target_unavailable', 'noRunCreated');
        }
        return await direct.invoke(method, request, {
          ...(opts.signal ? { signal: opts.signal } : {}),
          localActionContext: {
            ...(opts.authority ? { authority: opts.authority } : {}),
            ...(opts.workDepth === undefined ? {} : {
              surface: 'agent' as const,
              authority: 'account_automation' as const,
              agentStartWorkDepth: opts.workDepth,
              agentStartContext: opts.agentStartContext,
              sessionAgentSpawnPolicyV1: opts.sessionAgentSpawnPolicyV1,
              callerPermissionMode: opts.agentStartContext?.callerPermissionCeiling,
              causalPermissionAuthority: opts.causalPermissionAuthority,
            }),
            ...(opts.workspaceWrites === undefined ? {} : { agentStartWorkspaceWrites: opts.workspaceWrites }),
            ...(opts.permissionRequestStore === undefined ? {} : { executionRunPermissionRequestStore: opts.permissionRequestStore }),
            ...(opts.workflowObservationSink === undefined ? {} : { executionRunWorkflowObservationSink: opts.workflowObservationSink }),
            ...(opts.workflowRunId ? { executionRunWorkflowRunId: opts.workflowRunId } : {}),
            ...(opts.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: opts.requesterWorkAttributionV1 } : {}),
          },
          ...(opts.permissionRequestStore === undefined
            ? {}
            : { executionRunPermissionRequestStore: opts.permissionRequestStore }),
          ...(opts.workflowObservationSink === undefined
            ? {}
            : { executionRunWorkflowObservationSink: opts.workflowObservationSink }),
          ...(opts.workflowRunId ? { executionRunWorkflowRunId: opts.workflowRunId } : {}),
        });
      }
      const getRequest = method === SESSION_RPC_METHODS.EXECUTION_RUN_GET
        ? ExecutionRunGetRequestSchema.safeParse(request)
        : null;
      return await callMachineRpc({
        credentials: params.credentials,
        machineId: target.machineId,
        method,
        request,
        ...executionRunAuthorityCeiling(opts),
        ...(DETACHED_EXECUTION_RUN_CALLER_LIFECYCLE_METHODS.has(method)
          || getRequest?.success && Boolean(getRequest.data.waitForInputId || getRequest.data.waitForOutput)
          || method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ
            && request !== null && typeof request === 'object' && 'waitForEvents' in request && request.waitForEvents === true
          ? { timeoutMs: null }
          : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    } catch (error) {
      const requestDisposition = readMachineRpcRequestDisposition(error);
      const runCreation = requestDisposition === 'notSent'
        ? 'noRunCreated'
        : 'outcomeUnknown';
      if (
        method === SESSION_RPC_METHODS.EXECUTION_RUN_SEND
        && requestDisposition !== 'notSent'
      ) {
        return failure(
          'execution_run_send_outcome_unknown',
          'outcomeUnknown',
          'The execution-run input may have been accepted before its response failed',
        );
      }
      if (isExecutionRunActionAbort(error, opts?.signal)) {
        return failure('cancelled', runCreation);
      }
      return failure('execution_run_target_unavailable', runCreation);
    }
  };

  const readExecutionRunProtocolV2 = async (
    sessionId: string | null,
    requirement: ExecutionRunProtocolV2Requirement,
    opts?: ExecutionRunActionTransportOptions,
  ): Promise<
    | Readonly<{ ok: true; exactMachineId: string }>
    | Readonly<{ ok: false; errorCode: string; error: string }>
  > => {
    if (!params.credentials) {
      return executionRunActionFailure('not_authenticated');
    }
    if (opts?.signal?.aborted) {
      return executionRunActionFailure('cancelled');
    }
    const target = await resolveExecutionRunMachineTarget(sessionId, opts);
    if (!target.ok) return executionRunActionFailure(target.errorCode);
    try {
      const response = await callMachineAction({
        machineId: target.machineId,
        method: RPC_METHODS.CAPABILITIES_DETECT,
        request: { requests: [{ id: 'tool.executionRuns' }] },
        ...(opts?.authority ? { authority: opts.authority } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      const result = readRecord(readRecord(response).results)['tool.executionRuns'];
      const data = readRecord(readRecord(result).data);
      const features = readRecord(data.features);
      if (
        readRecord(result).ok !== true
        || data.protocolVersion !== 2
        || (requirement.detachedScope && features.detachedScope !== true)
        || (requirement.startAndWait && features.startAndWait !== true)
        || (requirement.exactInputResults && features.exactInputResults !== true)
        || (requirement.runScopedAgentBindings && features.runScopedAgentBindings !== true)
        || (requirement.secretReferenceOverlay && features.secretReferenceOverlay !== true)
      ) {
        return executionRunActionFailure('execution_run_protocol_unsupported');
      }
      return { ok: true, exactMachineId: target.machineId };
    } catch (error) {
      if (isExecutionRunActionAbort(error, opts?.signal)) {
        return executionRunActionFailure('cancelled');
      }
      if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
        return executionRunActionFailure('execution_run_protocol_unsupported');
      }
      return executionRunActionFailure('execution_run_target_unavailable');
    }
  };

  const callSessionRpcForTransport = async (
    transport: ResolvedSessionTransport,
    methodSuffix: string,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (!params.credentials) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }

    try {
      return await callSessionRpc({
        ...transport,
        token: params.credentials.token,
        sessionId: transport.sessionId,
        method: `${transport.sessionId}:${methodSuffix}`,
        request,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const errorCode = readRpcErrorCode(error) ?? 'session_rpc_failed';
      return {
        ok: false,
        errorCode,
        error: errorCode,
        errorMessage: error instanceof Error ? error.message : errorCode,
        sessionId: transport.sessionId,
      };
    }
  };

  const callSessionRoleRpc = async (
    transport: ResolvedSessionTransport,
    method: string,
    input: unknown,
    context: ActionExecutorContext,
  ): Promise<unknown> => {
    if (context.authority === 'present_user') return await callSessionRpcForTransport(transport, method, input, context.signal);
    const origin = resolveSessionRoleRpcOrigin(context);
    if (!params.sessionActionRpcTransport) {
      throw Object.assign(new Error('role_rpc_origin_unavailable'), { code: 'role_rpc_origin_unavailable' });
    }
    context.signal?.throwIfAborted();
    return await params.sessionActionRpcTransport({ sessionId: transport.sessionId, method, input,
      content: resolveSessionRpcContent(transport), origin,
      ...(context.signal ? { signal: context.signal } : {}),
    });
  };

  const normalizeLifecycleHookSessionContext = (context: Readonly<{
    machineId?: unknown;
    cwd?: unknown;
    workspaceId?: unknown;
  }>): LifecycleHookSessionContext => {
    const machineId = normalizeStringValue(context.machineId);
    const cwd = normalizeStringValue(context.cwd);
    const workspaceId = normalizeStringValue(context.workspaceId);
    return {
      ...(machineId ? { machineId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    };
  };

  const resolveLifecycleHookSessionContext = async (event: Readonly<{
    happySessionId: string;
    exactSessionContext?: LifecycleHookSessionContext;
  }>): Promise<LifecycleHookSessionContext> => {
    if (event.exactSessionContext !== undefined) {
      return normalizeLifecycleHookSessionContext(event.exactSessionContext);
    }

    if (event.happySessionId === params.sessionId) {
      const metadata = await readCurrentSessionMetadata();
      return normalizeLifecycleHookSessionContext({
        machineId: await resolveCurrentSessionValue('machineId'),
        cwd: await resolveCurrentSessionValue('path'),
        workspaceId: metadata?.workspaceId,
      });
    }

    try {
      const transport = await resolveTransportForSession(event.happySessionId);
      if (!transport.ok) return {};
      const metadata = readTransportSessionOwnerMetadata(transport);
      return normalizeLifecycleHookSessionContext({
        machineId: normalizeStringValue(transport.rawSession.machineId) ?? metadata?.machineId,
        cwd: normalizeStringValue(transport.rawSession.path) ?? metadata?.path,
        workspaceId: metadata?.workspaceId,
      });
    } catch {
      return {};
    }
  };

  const dispatchSessionLifecycleHookEvent = async (event: Readonly<{
    eventId: SessionBridgeLifecycleHookEventIdV1;
    happySessionId: string;
    backendTarget?: string;
    exactSessionContext?: LifecycleHookSessionContext;
    payload: Record<string, unknown>;
  }>): Promise<void> => {
    const happyHomeDir = typeof params.happyHomeDir === 'string' && params.happyHomeDir.trim().length > 0
      ? params.happyHomeDir.trim()
      : null;
    if (!happyHomeDir) {
      return;
    }
    const sessionContext = await resolveLifecycleHookSessionContext(event);

    await getSessionHostBridge().emitLifecycleHookEvent({
      happyHomeDir,
      eventId: event.eventId,
      happySessionId: event.happySessionId,
      ...sessionContext,
      ...(event.backendTarget ? { backendTarget: event.backendTarget } : {}),
      payload: event.payload,
    });
  };

  const callResolvedSessionRpc = async (
    sessionId: string,
    method: string,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (!params.credentials) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }
    const transport = await resolveTransportForSession(sessionId);
    if (!transport.ok) {
      return { ok: false, errorCode: transport.code, error: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
    }
    return await callSessionRpcForTransport(transport, method, request, signal);
  };

  const isUsageLimitRecoveryEnabled = async (): Promise<boolean> => {
    if (typeof params.isUsageLimitRecoveryEnabled === 'function') {
      return await params.isUsageLimitRecoveryEnabled();
    }
    return await resolveUsageLimitRecoveryEnabled();
  };

  const callRoutedSessionGoalControl = async (
    sessionId: string,
    operation: 'get' | 'set' | 'clear',
    request: Record<string, unknown>,
  ): Promise<unknown> => {
    if (!params.credentials) {
      return normalizeUsageLimitRecoveryOperationResult(
        { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },
        { sessionId },
      );
    }

    const transport = await resolveTransportForSession(sessionId);
    if (!transport.ok) {
      return normalizeUsageLimitRecoveryOperationResult(
        {
          ok: false,
          errorCode: transport.code,
          error: transport.code,
        },
        { sessionId },
      );
    }

    const metadata = readTransportSessionOwnerMetadata(transport);
    const currentMachineIdentity = await readCurrentMachineControlIdentity();
    return await routeSessionGoalControl({
      ...transport,
      token: params.credentials.token,
      credentials: params.credentials,
      sessionId: transport.sessionId,
      rawSession: transport.rawSession,
      metadata,
      currentMachineId: currentMachineIdentity.machineId,
      currentMachineHost: currentMachineIdentity.host,
      currentMachineHomeDir: currentMachineIdentity.homeDir,
      operation,
      stageWorkStateMutation: params.stageWorkStateMutation,
      ...(operation === 'set' ? { request } : {}),
      callLiveSessionRpc: async () => await callSessionRpcForTransport(
        transport,
        operation === 'get'
          ? SESSION_RPC_METHODS.SESSION_GOAL_GET
          : operation === 'clear'
            ? SESSION_RPC_METHODS.SESSION_GOAL_CLEAR
            : SESSION_RPC_METHODS.SESSION_GOAL_SET,
        request,
      ),
    });
  };

  const callRoutedSessionCatalogControl = async (
    sessionId: string,
    operation: 'vendorPlugins' | 'skills',
    request: Readonly<{ cwd?: string }>,
  ): Promise<unknown> => {
    if (!params.credentials) {
      return operation === 'vendorPlugins'
        ? { unsupported: true, vendorPlugins: [], diagnostic: 'not_authenticated' }
        : { unsupported: true, skills: [], diagnostic: 'not_authenticated' };
    }

    const transport = await resolveTransportForSession(sessionId);
    if (!transport.ok) {
      return operation === 'vendorPlugins'
        ? { unsupported: true, vendorPlugins: [], diagnostic: transport.code }
        : { unsupported: true, skills: [], diagnostic: transport.code };
    }

    const metadata = readTransportSessionOwnerMetadata(transport);
    const currentMachineIdentity = await readCurrentMachineControlIdentity();
    const method = operation === 'vendorPlugins'
      ? SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST
      : SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST;
    const rpcRequest = {
      ...(typeof request.cwd === 'string' && request.cwd.trim().length > 0 ? { cwd: request.cwd.trim() } : {}),
    };
    return await routeSessionCatalogControl({
      ...transport,
      token: params.credentials.token,
      credentials: params.credentials,
      sessionId: transport.sessionId,
      rawSession: transport.rawSession,
      metadata,
      currentMachineId: currentMachineIdentity.machineId,
      currentMachineHost: currentMachineIdentity.host,
      currentMachineHomeDir: currentMachineIdentity.homeDir,
      operation,
      ...('cwd' in rpcRequest ? { cwd: rpcRequest.cwd } : {}),
      callLiveSessionRpc: async () => await callSessionRpcForTransport(
        transport,
        method,
        rpcRequest,
      ),
    });
  };

  const callRoutedUsageLimitRecoveryControl = async (
    sessionId: string,
    operation: 'enable' | 'cancel' | 'checkNow' | 'switchAccountNow' | 'consumeResetCredit',
    request: Record<string, unknown>,
  ): Promise<unknown> => {
    if (!params.credentials) {
      return normalizeUsageLimitRecoveryOperationResult(
        { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },
        { sessionId },
      );
    }

    const transport = await resolveTransportForSession(sessionId);
    if (!transport.ok) {
      return normalizeUsageLimitRecoveryOperationResult(
        {
          ok: false,
          errorCode: transport.code,
          error: transport.code,
        },
        { sessionId },
      );
    }

    const metadata = readTransportSessionOwnerMetadata(transport);
    if (transport.rawSession.active === true) {
      return normalizeUsageLimitRecoveryOperationResult(await callSessionRpcForTransport(
        transport,
        operation === 'enable'
          ? SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE
          : operation === 'cancel'
            ? SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL
            : operation === 'consumeResetCredit'
              ? SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT
              : SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
        request,
      ), { sessionId: transport.sessionId });
    }

    const rawMachineId = normalizeStringValue(transport.rawSession.machineId);
    const metadataMachineId = normalizeStringValue(metadata?.machineId);
    if (rawMachineId && metadataMachineId && rawMachineId !== metadataMachineId) {
      return normalizeUsageLimitRecoveryOperationResult({
        ok: false,
        errorCode: 'session_usage_limit_recovery_control_target_machine_mismatch',
        error: 'session_usage_limit_recovery_control_target_machine_mismatch',
      }, { sessionId: transport.sessionId });
    }
    const machineId = rawMachineId ?? metadataMachineId;
    if (!machineId) {
      return normalizeUsageLimitRecoveryOperationResult({
        ok: false,
        errorCode: 'session_usage_limit_recovery_control_target_machine_unavailable',
        error: 'session_usage_limit_recovery_control_target_machine_unavailable',
      }, { sessionId: transport.sessionId });
    }

    const method = operation === 'enable'
      ? RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE
      : operation === 'cancel'
        ? RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL
        : operation === 'consumeResetCredit'
          ? RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT
          : RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW;
    try {
      return normalizeUsageLimitRecoveryOperationResult(await callMachineRpc({
        credentials: params.credentials,
        machineId,
        method,
        request,
      }), { sessionId: transport.sessionId });
    } catch {
      return normalizeUsageLimitRecoveryOperationResult({
        ok: false,
        errorCode: 'session_usage_limit_recovery_control_target_machine_unavailable',
        error: 'session_usage_limit_recovery_control_target_machine_unavailable',
      }, { sessionId: transport.sessionId });
    }
  };

  const executeSessionBoundScmAction: NonNullable<ActionExecutorDeps['scmActionExecute']> = async ({
    actionId,
    input,
    context,
    executeCanonicalAction,
  }) => {
    const localReviewHomeCurrent = () => {
      if (context.serverId && context.serverId !== configuration.activeServerId) return false;
      if (params.serverId && params.serverId !== configuration.activeServerId) return false;
      if (!params.serverHttpBaseUrl) return true;
      try {
        const selected = createServerUrlComparableKey(params.serverHttpBaseUrl);
        return Boolean(selected && [configuration.serverUrl, configuration.apiServerUrl]
          .some(url => createServerUrlComparableKey(url) === selected));
      } catch { return false; }
    };
    const localReviewContext = { ...context, serverId: params.serverId ?? configuration.activeServerId };
    const requesterAccountId = context.externalActionCredential?.accountId ?? context.runtimeAccountId;
    const accountMarksDeps = params.credentials ? {
      executeReviewedMarks: (comparison: import('@happier-dev/protocol').ScmComparison, request: import('@happier-dev/protocol').ScmReviewedMarkInput, reviewed: boolean) => createCliScmReviewedMarkAction({
        credentials: params.credentials!, comparison, changeRefs: request.changeRefs, reviewed,
        ...(requesterAccountId ? { requesterAccountId } : {}),
        ...(params.serverHttpBaseUrl ? { serverBaseUrl: params.serverHttpBaseUrl } : {}),
        resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, actionId, request),
        ...(context.signal ? { signal: context.signal } : {}),
      }),
      clearReviewedMarks: (comparison: import('@happier-dev/protocol').ScmComparison) => clearCliScmReviewedMarks({
        credentials: params.credentials!, comparison,
        ...(requesterAccountId ? { requesterAccountId } : {}),
        ...(params.serverHttpBaseUrl ? { serverBaseUrl: params.serverHttpBaseUrl } : {}),
        resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, actionId, request),
        ...(context.signal ? { signal: context.signal } : {}),
      }),
    } : {};
    const attachSuccessfulPullRequest = async (response: unknown) => {
      const sessionId = normalizeStringValue(context.defaultSessionId);
      if (actionId !== 'scm.pullRequest.openOrReuse' || !sessionId) return response;
      const parsed = ScmPullRequestOpenOrReuseResponseSchema.safeParse(response);
      if (!parsed.success || !parsed.data.success || !parsed.data.pullRequest) return response;
      const pr = parsed.data.pullRequest;
      if (pr.provider.kind !== 'github' || !pr.provider.nameWithOwner || !pr.number) return response;
      try {
        const result = await invokeSessionPullRequestBinding({ kind: 'attach', sessionId,
          pullRequest: { repository: pr.provider.nameWithOwner, number: pr.number } }, context);
        if (result.kind !== 'attached') throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
        return response;
      } catch (error) {
        const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code : 'target_unavailable';
        return { ok: false, errorCode: code, error: code, details: { pullRequest: pr, scmEffectCommitted: true } };
      }
    };
    const inputRecord = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Readonly<Record<string, unknown>>
      : {};
    const resolveScmBackendTarget = (metadata: Record<string, unknown> | null) => {
      const selector = inputRecord.modelSelector;
      const selectorRecord = selector && typeof selector === 'object' && !Array.isArray(selector)
        ? selector as Readonly<Record<string, unknown>> : {};
      const targetKey = normalizeStringValue(selectorRecord.backendTargetKey);
      if (!targetKey) return resolveBackendTargetFromSessionMetadata(metadata);
      try {
        const target = parseBackendTargetKeyV2(targetKey);
        if (target.kind === 'backend') return target;
        const catalog = readAgentCatalogSnapshot();
        const agentId = readAgentRoutingIdForContributionIdentity(
          indexAgentRoutingIdsByContributionIdentity([...catalog.agentDefinitionsById.values()]), target.identity);
        return agentId ? BackendTargetRefV2Schema.parse({ kind: 'backend', backendId: agentId, sourceKind: 'built_in' }) : null;
      } catch { return null; }
    };
    const readComparisonTranscriptPage = params.credentials ? createRepositoryCheckpointTranscriptPageReader({
      credentials: params.credentials,
      resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, 'session.transcript.get', request),
      ...(context.signal ? { signal: context.signal } : {}),
    }) : undefined;
    const readPullRequestComparisonPage: ReadPullRequestComparisonPage = async ({ sourceAction, continuation }) => {
      const input = sourceAction.input;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Pull-request source Action requires object input');
      const selectedSourceInput = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'continuation'));
      const result = await executeCanonicalAction('action.invoke', {
        action: sourceAction.action,
        input: { ...selectedSourceInput, comparison: true, ...(continuation ? { continuation } : {}) },
      }, { requiredContributedActionDangerLevel: 'safe' });
      if (!result.ok) throw new Error(`Pull-request source Action unavailable: ${result.errorCode}`);
      return result.result;
    };
    const machineInventory = actionId === 'scm.diffSummary.result.list' || actionId === 'scm.diffSummary.result.clear'
      || actionId === 'scm.hostingRepository.resolveAddress';
    if (machineInventory && context.externalActionTarget?.kind !== 'machine') {
      return { ok: false, errorCode: 'machine_not_selected', error: 'machine_not_selected' };
    }
    if (context.externalActionTarget?.kind === 'machine') {
      const machineId = normalizeStringValue(context.externalActionTarget.machineId);
      const cwd = normalizeStringValue(actionId === 'scm.repository.clone'
        ? inputRecord.destinationParentPath
        : inputRecord.cwd);
      const method = getActionSpec(actionId).bindings?.rpcMethod;
      if (!machineId || (!machineInventory && !cwd) || !method || actionId === 'scm.reviewWorkspace.materializePrepared') {
        return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
      }
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      if (!isMachineActionServerScopeCurrent(context.serverId)) return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      if (params.credentials && actionId.startsWith('scm.diffSummary.')) {
        const currentMachine = await readCurrentMachineControlIdentity();
        if (currentMachine.machineId === machineId) {
          if (!localReviewHomeCurrent()) return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
          return executeScmActionOperation({ actionId, input: inputRecord, workingDirectory: cwd ?? process.cwd(),
            accessPolicy: params.scmFilesystemAccessPolicy ?? resolveFilesystemAccessPolicy(),
            ...(readComparisonTranscriptPage ? { readComparisonTranscriptPage } : {}), readPullRequestComparisonPage,
            authorizeSession: async sessionId => context.rpcSessionAuthorization?.sessionId === sessionId,
            executeCanonicalAction, actionContext: localReviewContext, ...accountMarksDeps, ...(context.signal ? { signal: context.signal } : {}),
            executeDiffSummary: async ({ request }) => await executeScmDiffSummaryAction({
              request: request as ScmDiffSummaryGenerateInput, machineId,
              ...(readComparisonTranscriptPage ? { readTranscriptPage: readComparisonTranscriptPage } : {}), readPullRequestComparisonPage,
              backendTarget: resolveScmBackendTarget(null), executeCanonicalAction,
              ...(context.signal ? { signal: context.signal } : {}),
            }),
          });
        }
      }
      const admitPolicy = actionId === 'scm.commit.create'
        ? (capabilities?: ScmCapabilities) => admitScmCommitPolicy(ScmCommitCreateRequestSchema.parse(inputRecord), capabilities)
        : actionId === 'scm.commit.undoLast'
          ? (capabilities?: ScmCapabilities) => admitScmCommitUndoLast(capabilities)
          : actionId === 'scm.remote.fetch' || actionId === 'scm.remote.pull' || actionId === 'scm.remote.push'
            ? (capabilities?: ScmCapabilities) => admitScmRemotePolicy(ScmRemoteRequestSchema.parse(inputRecord), capabilities)
            : undefined;
      if (admitPolicy && !admitPolicy().success) {
        let capabilities: ScmCapabilities | undefined;
        try {
          const description = ScmBackendDescribeResponseSchema.safeParse(await callMachineAction({
            machineId, method: 'scm.backend.describe',
            request: { cwd, ...(inputRecord.backendPreference ? { backendPreference: inputRecord.backendPreference } : {}), outcomeVersion: 1 },
            ...(context.signal ? { signal: context.signal } : {}),
          }));
          if (description.success && description.data.success) capabilities = description.data.capabilities;
        } catch {
          // An unproven exact-target capability is not permission to send fields
          // a predecessor daemon could silently ignore.
        }
        const admission = admitPolicy(capabilities);
        if (!admission.success) return admission;
      }
      return await attachSuccessfulPullRequest(await callMachineAction({ machineId, method, request: {
        ...inputRecord,
        ...(actionId.startsWith('scm.diffSummary.') || actionId === 'scm.hostingRepository.resolveAddress'
          ? {}
          : { outcomeVersion: 1 }),
        ...(actionId === 'scm.status.snapshot' ? { operationStateVersion: 1 } : {}),
      }, ...(context.rpcSessionAuthorization ? { authorization: context.rpcSessionAuthorization } : {}),
        ...(context.signal ? { signal: context.signal } : {}) }));
    }
    if (!params.credentials) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }
    if (actionId === 'scm.reviewWorkspace.materializePrepared') {
      const selectedRoot = normalizeStringValue(inputRecord.cwd);
      if (!selectedRoot) {
        return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
      }
      return await executeScmActionOperation({
        actionId,
        input: inputRecord,
        workingDirectory: selectedRoot,
        accessPolicy: { kind: 'restrictedRoots', roots: [selectedRoot] },
        ...(context.signal ? { signal: context.signal } : {}),
      });
    }
    const sessionId = normalizeStringValue(context.defaultSessionId);
    if (!sessionId) {
      return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
    }
    const transport = await resolveTransportForSession(sessionId);
    if (!transport.ok) {
      return { ok: false, errorCode: transport.code, error: transport.code };
    }

    const metadata = readTransportSessionOwnerMetadata(transport);
    const persistedWorkingDirectory = normalizeStringValue(metadata?.path);
    if (!persistedWorkingDirectory) {
      return {
        ok: false,
        errorCode: 'scm_action_worktree_unavailable',
        error: 'scm_action_worktree_unavailable',
      };
    }

    const currentMachine = await readCurrentMachineControlIdentity();
    const workingDirectory = metadata
      ? resolveSessionMachineWorkspacePath({
          metadata,
          currentMachineId: currentMachine.machineId,
          candidatePath: persistedWorkingDirectory,
        }) ?? persistedWorkingDirectory
      : persistedWorkingDirectory;
    const sessionMachineId = normalizeStringValue(transport.rawSession.machineId)
      ?? normalizeStringValue(metadata?.machineId);
    const sessionHost = normalizeStringValue(transport.rawSession.host)
      ?? normalizeStringValue(metadata?.host);
    const machineMismatch = Boolean(
      sessionMachineId
      && currentMachine.machineId
      && sessionMachineId !== currentMachine.machineId,
    );
    const hostMismatch = Boolean(
      !sessionMachineId
      && sessionHost
      && currentMachine.host
      && sessionHost !== currentMachine.host,
    );
    if (machineMismatch || hostMismatch) {
      return {
        ok: false,
        errorCode: 'scm_action_session_not_local',
        error: 'scm_action_session_not_local',
      };
    }

    if (params.scmFilesystemAccessPolicy) {
      const authorized = resolveCwd(workingDirectory, workingDirectory, params.scmFilesystemAccessPolicy);
      if (!authorized.ok) return { ok: false, errorCode: 'scm_action_path_denied', error: authorized.error };
    }

    const sessionBoundInput = actionId === 'scm.repository.clone'
      ? inputRecord
      : actionId === 'scm.pullRequest.prepareWorktree'
        ? { ...inputRecord, cwd: workingDirectory, sourcePath: workingDirectory }
        : { ...inputRecord, cwd: workingDirectory,
            ...(actionId === 'scm.diffSummary.capture' ? { sessionId: transport.sessionId } : {}),
          };
    const backendTarget = actionId === 'scm.diffSummary.generate' ? resolveScmBackendTarget(metadata) : null;

    if (actionId.startsWith('scm.diffSummary.') && !localReviewHomeCurrent()) {
      return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
    }

    return await attachSuccessfulPullRequest(await executeScmActionOperation({
      actionId,
      input: sessionBoundInput,
      workingDirectory,
      accessPolicy: { kind: 'restrictedRoots', roots: [workingDirectory] },
      ...(readComparisonTranscriptPage ? { readComparisonTranscriptPage } : {}),
      readPullRequestComparisonPage,
      sessionId: transport.sessionId,
      authorizeSession: async selectedSessionId => {
        const snapshot = await fetchSessionById({ token: params.token, sessionId: selectedSessionId,
          ...(params.serverHttpBaseUrl ? { serverUrl: params.serverHttpBaseUrl } : {}),
          resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, actionId, request),
          ...(context.signal ? { signal: context.signal } : {}),
        }).catch(() => null);
        return snapshot?.id === selectedSessionId;
      },
      executeCanonicalAction,
      actionContext: localReviewContext,
      ...accountMarksDeps,
      ...(context.signal ? { signal: context.signal } : {}),
      executeDiffSummary: async ({ request }) => await executeScmDiffSummaryAction({
        request: request as ScmDiffSummaryGenerateInput,
        sessionId: transport.sessionId,
        ...(readComparisonTranscriptPage ? { readTranscriptPage: readComparisonTranscriptPage } : {}),
        readPullRequestComparisonPage,
        backendTarget,
        executeCanonicalAction,
        ...(context.signal ? { signal: context.signal } : {}),
      }),
    }));
  };

  type SessionSpawnTargetPreparation =
    | Readonly<{
        ok: true;
        preparedTarget: Extract<
          SessionCreationTargetPreparationResultV1,
          Readonly<{ ok: true }>
        >;
      }>
    | Readonly<{
        ok: false;
        result: Extract<SessionSpawnNewResultV1, Readonly<{ type: 'error' }>>;
      }>;

  /**
   * A direct transport is installed only by the authenticated exact-machine
   * receiver. Once that receiver has selected this daemon, its local profile
   * id is not an Account-routing identity: retain the portable server id in
   * the Action input and approval artifact instead of comparing it to that
   * profile-local value.
   */
  const isCurrentSessionSpawnExecutionTarget = (executionTarget: Readonly<{
    serverId: string;
    machineId: string;
  }>): boolean => {
    const directTargetTransport = params.sessionSpawnDirectTargetTransport;
    if (directTargetTransport?.machineId === executionTarget.machineId) {
      return true;
    }
    const activeServerId = String(configuration.activeServerId ?? '').trim();
    return Boolean(activeServerId && executionTarget.serverId === activeServerId);
  };

  /**
   * One exact-target bridge to the daemon-owned preparation RPC. Both the
   * Action approval probe and the eventual V2 spawn consume this owner; no
   * caller resolves a remote path or synthesizes its directory state.
   */
  const prepareSessionSpawnTarget = async (input: Readonly<{
    executionTarget: Readonly<{ serverId: string; machineId: string }>;
    directory: SessionCreationTargetPreparationRequestV1['directory'];
    sessionCreationTag?: SessionCreationTargetPreparationRequestV1['sessionCreationTag'];
    checkoutCreationDraft?: SessionCreationTargetPreparationRequestV1['checkoutCreationDraft'];
    signal?: AbortSignal;
  }>): Promise<SessionSpawnTargetPreparation> => {
    if (!params.credentials) {
      return {
        ok: false,
        result: { type: 'error', code: 'permission_denied', retryable: false },
      };
    }
    if (input.signal?.aborted) {
      return {
        ok: false,
        result: { type: 'error', code: 'cancelled', retryable: true },
      };
    }

    const directTargetTransport = params.sessionSpawnDirectTargetTransport;
    if (
      directTargetTransport
      && directTargetTransport.machineId !== input.executionTarget.machineId
    ) {
      return {
        ok: false,
        result: { type: 'error', code: 'target_unavailable', retryable: false },
      };
    }

    let rawPreparedTarget: unknown;
    try {
      rawPreparedTarget = directTargetTransport
        ? await directTargetTransport.prepare(
          {
            directory: input.directory,
            ...(input.sessionCreationTag ? { sessionCreationTag: input.sessionCreationTag } : {}),
            ...(input.checkoutCreationDraft !== undefined
              ? { checkoutCreationDraft: input.checkoutCreationDraft }
              : {}),
          },
          input.signal ? { signal: input.signal } : undefined,
        )
        : await callMachineAction({
            machineId: input.executionTarget.machineId,
            method: RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE,
            request: {
              directory: input.directory,
              ...(input.sessionCreationTag ? { sessionCreationTag: input.sessionCreationTag } : {}),
              ...(input.checkoutCreationDraft !== undefined
                ? { checkoutCreationDraft: input.checkoutCreationDraft }
                : {}),
            },
            ...(input.signal ? { signal: input.signal } : {}),
          });
    } catch (error) {
      if (input.signal?.aborted) {
        return {
          ok: false,
          result: { type: 'error', code: 'cancelled', retryable: true },
        };
      }
      if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
        return {
          ok: false,
          result: { type: 'error', code: 'incompatible_target', retryable: false },
        };
      }
      if (isAuthenticationError(error)) {
        return {
          ok: false,
          result: { type: 'error', code: 'permission_denied', retryable: false },
        };
      }
      return {
        ok: false,
        result: { type: 'error', code: 'machine_offline', retryable: true },
      };
    }

    const preparedTarget = SessionCreationTargetPreparationResultV1Schema.safeParse(rawPreparedTarget);
    if (!preparedTarget.success) {
      return {
        ok: false,
        result: { type: 'error', code: 'incompatible_target', retryable: false },
      };
    }
    if (!preparedTarget.data.ok) {
      if (preparedTarget.data.code === 'invalid_directory') {
        return {
          ok: false,
          result: { type: 'error', code: 'invalid_input', retryable: false },
        };
      }
      if (preparedTarget.data.code === 'checkout_unavailable') {
        return {
          ok: false,
          result: { type: 'error', code: 'incompatible_target', retryable: false },
        };
      }
      return {
        ok: false,
        result: { type: 'error', code: 'spawn_failed', retryable: true },
      };
    }
    return { ok: true, preparedTarget: preparedTarget.data };
  };

  const widgetBoardDeps = params.credentials ? createSessionBoardActionDeps({
    credentials: params.credentials,
    ...(params.resolveExactSessionEncryptionMaterial ? { resolveExactSessionEncryptionMaterial: params.resolveExactSessionEncryptionMaterial } : {}),
    ...(params.resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot } : {}),
    ...exactHome,
    ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
    ...(params.externalActionMachineRequestPrivateKey ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey } : {}),
    ...(params.externalActionMachineInstallationId ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId } : {}),
  }) : null;
  const actionDeps: ActionExecutorDeps = {
    ...(approvalsStore?.promptLibraryStore.organization ? { artifactFolders: approvalsStore.promptLibraryStore.organization } : {}),
    runtimeActionExecute: async (args) => {
      const isStart = args.actionId === 'localServices.launcher.start';
      const controlKind = resolveLocalServiceActionKindForRuntimeActionId(args.actionId);
      // The daemon's Copy/Open receipt grants eligibility; it does not perform
      // the answering client's clipboard/navigation effect. This host is headless.
      if (!isStart && (!controlKind || controlKind === 'copy_url' || controlKind === 'open_preview')) {
        return createUnavailableRuntimeActionExecutor()(args);
      }
      const spec = getActionSpec(args.actionId);
      const admittedInput = spec.inputSchema.safeParse(args.input);
      if (!admittedInput.success) return executionRunActionFailure('invalid_parameters');
      const parsed = isStart
        ? DaemonLocalServiceLauncherStartRequestV1Schema.safeParse(admittedInput.data)
        : LocalServiceActionRequestV1Schema.safeParse(admittedInput.data);
      if (!parsed.success) return executionRunActionFailure('invalid_parameters');
      const request = parsed.data;
      const machineId = 'target' in request ? request.target.machineId : request.machineId;
      const denied = projectHomeAdmission('workspace' in request ? request.workspace?.serverId : undefined, args.context);
      if (denied) return denied;
      const method = spec.bindings?.rpcMethod;
      if (!method) return executionRunActionFailure('runtime_action_disabled');
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return executionRunActionFailure('not_authenticated');
      }
      args.context.signal?.throwIfAborted();
      return await withProjectHome(() => callMachineAction({ machineId, serverId: projectHomeId,
        method, request: createTargetedActionRpcRequestV1(request, { kind: 'machine', machineId },
          { defaultSessionId: args.context.defaultSessionId }),
        authority: args.context.authority, authorization: args.context.rpcSessionAuthorization,
        context: args.context, effectActionId: args.actionId, exactMachine: true, timeoutMs: null,
        ...(args.context.signal ? { signal: args.context.signal } : {}),
      }));
    },
    ...(approvalsStore ? { memoryLibrary: {
      serverId: params.serverId ?? configuration.activeServerId,
      store: approvalsStore.promptLibraryStore, randomId: randomUUID,
      readExposure: async (artifactId, context) => {
        if (!actionDeps.artifactAccessAction || !actionDeps.artifactAction) throw Object.assign(new Error('memory_exposure_unavailable'), { code: 'memory_exposure_unavailable' });
        const grants = ArtifactAccessGrantsListResponseV1Schema.parse(await actionDeps.artifactAccessAction({
          actionId: 'artifact.access.grants.list', input: { artifactId }, context, signal: context.signal }));
        const publicShares = grants.access === 'owner' ? StoredContentPublicSharesListResponseV1Schema.parse(await actionDeps.artifactAction({
          actionId: 'artifact.public_link.list', input: { artifactId }, context, signal: context.signal })) : null;
        return { grants, publicShares };
      },
      readSession: async (ref, context) => {
        if (!params.credentials) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
        const read = async () => {
          const target = await resolveSessionTransportContext({ credentials: params.credentials!, idOrPrefix: ref.sessionId,
            signal: context.signal, resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, 'memory.remember', request) });
          if (!target.ok || target.sessionId !== ref.sessionId) throw Object.assign(new Error('session_target_unavailable'), { code: 'session_target_unavailable' });
          const metadata = readTransportSessionOwnerMetadata(target);
          if (!metadata) throw Object.assign(new Error('session_target_unavailable'), { code: 'session_target_unavailable' });
          const machineId = readSessionOwnerLocality({ metadata, rawSession: target.rawSession })?.machineId;
          return { metadata, revision: target.rawSession.metadataVersion, ...(machineId ? { machineId } : {}) };
        };
        return params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, read) : read();
      },
      readInheritedContext: async (snapshot, context) => {
        if (!params.credentials) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
        const read = () => readCliMemoryInheritedContext({ credentials: params.credentials!,
          serverId: params.serverId ?? configuration.activeServerId, snapshot, context });
        return params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, read) : read();
      },
      readScopeContext: async (target, context) => {
        if (!params.credentials) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
        if (target.scope === 'project' && projectAccountAdmission(target.projectRef.serverId, context)) {
          throw Object.assign(new Error('project_context_access_denied'), { code: 'project_context_access_denied' });
        }
        if (!actionDeps.projectsContextUpdate || !actionDeps.projectSourcesRead || !actionDeps.projectSourcesUpdate) {
          throw Object.assign(new Error('project_context_unavailable'), { code: 'project_context_unavailable' });
        }
        const read = () => readCliMemoryScopeContext({ credentials: params.credentials!,
          serverId: todoHomeServerId, target, context,
          readProjectRows: () => readProjectRows(context.signal, context, 'memory.remember'),
          projectsContextUpdate: actionDeps.projectsContextUpdate!, projectSourcesRead: actionDeps.projectSourcesRead!,
          projectSourcesUpdate: actionDeps.projectSourcesUpdate!,
        });
        return runWithServerHttpBaseUrl(todoHomeBaseUrl, read);
      },
      readArtifactHeaders: async (refs, context) => {
        const serverId = params.credentials?.requesterSessionCredentialScope?.serverId
          ?? params.serverId ?? configuration.activeServerId;
        if ((params.credentials?.requesterSessionCredentialScope || context.externalActionCredential
          || context.externalActionExecutionAuthorization)
          && refs.some(ref => ref.serverId?.trim() && ref.serverId.trim() !== serverId)) {
          throw Object.assign(new Error('server_target_mismatch'), { code: 'server_target_mismatch' });
        }
        return withCliPromptLibraryArtifactReader(reader => Promise.all(refs.map(async ref =>
          (await reader.readArtifactHeader(ref))?.header ?? null)), {
          credentials: params.credentials, serverId, signal: context.signal,
        });
      },
    } } : {}),
    projectsWorkspaceUpdate: async ({ serverId, workspaceId, label, pinned }: ProjectWorkspaceUpdateInputV1,
      context?: ActionExecutorContext): Promise<ProjectWorkspaceUpdateOutputV1> => {
      const refused = projectAccountAdmission(serverId, context);
      if (refused) return refused;
      const operationSignal = context?.signal;
      try {
        const before = await readProjectRows(operationSignal, context, 'projects.workspace.update');
        const resolved = resolveWorkspaceRefV1(before.workspaceRefs, { serverId, id: workspaceId });
        if (resolved.kind !== 'resolved') return executionRunActionFailure(resolved.kind === 'missing' ? 'not_found' : `workspace_ref_${resolved.kind}`);
        const ref = resolved.ref;
        const mutations: OpenedProjectAccountRowMutationRequest['mutations'][number][] = [];
        const key = { kind: 'workspace-ref' as const, serverId: ref.serverId, id: ref.id };
        const revisionFor = (rowKey: Parameters<typeof buildProjectAccountRowPhysicalKeyV1>[0]) => before.rows.find(
          row => buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(rowKey),
        )?.revision ?? 'absent';
        if (label !== undefined && label !== ref.label) {
          const workspaceRef = ProjectAccountWorkspaceRefV1Schema.parse({ ...ref, label });
          mutations.push({ key, expectedRevision: revisionFor(key), payload: { key, value: workspaceRef } });
        }
        const target = projectWorkspaceRefV1(ref);
        const organizationKey = { kind: 'project-organization' as const, ...target };
        const organization = before.organizations.find(row => row.key.serverId === target.serverId && row.key.projectKey === target.projectKey)?.value ?? {};
        let acknowledgedWorkspaceRef = ref;
        let acknowledgedOrganization = organization;
        if (pinned !== undefined && pinned !== (organization.pinned === true)) {
          mutations.push({ key: organizationKey, expectedRevision: revisionFor(organizationKey),
            payload: { key: organizationKey, value: { ...organization, pinned } } });
        }
        if (mutations.length > 0) {
          const result = await withProjectHome(() => mutateProjectAccountRows({ ...projectRowsAuthority(context, 'projects.workspace.update', operationSignal),
            request: { mutations, expectedRefs: [], topologyChange: false }, ...(operationSignal ? { signal: operationSignal } : {}) }));
          if (result.status !== 'updated') return executionRunActionFailure(result.status === 'conflict' ? 'project_account_rows_conflict' : `project_account_rows_${result.status}`);
          for (const row of result.openedRows) {
            if (!row.payload) continue;
            if (row.key.kind === 'workspace-ref' && 'id' in row.payload.value) acknowledgedWorkspaceRef = row.payload.value;
            if (row.key.kind === 'project-organization' && !('id' in row.payload.value) && !('relationships' in row.payload.value)) {
              acknowledgedOrganization = row.payload.value;
            }
          }
        }
        return { ok: true, workspaceRef: acknowledgedWorkspaceRef, organization: acknowledgedOrganization };
      } catch (error) {
        if (isExecutionRunActionAbort(error, operationSignal)) return executionRunActionFailure('cancelled');
        return executionRunActionFailure(readRpcErrorCode(error) ?? 'project_account_rows_unavailable');
      }
    },
    projectsWorkspaceForget: async ({ serverId, workspaceId }: ProjectWorkspaceForgetInputV1,
      context?: ActionExecutorContext): Promise<ProjectWorkspaceForgetOutputV1> => {
      const refused = projectAccountAdmission(serverId, context);
      if (refused) return refused;
      try {
        const result = await withProjectHome(() => createProjectAccountSnapshotMutation(projectRowsAuthority(context, 'projects.workspace.forget', context?.signal))(snapshot => {
          return { ...snapshot, workspaceRefs: resolveProjectAccountWorkspaceRefRemovalV1(snapshot,
            { serverId, workspaceRefId: workspaceId }) };
        }, context?.signal));
        if (result.status !== 'applied' && result.status !== 'unchanged') return executionRunActionFailure(`project_account_rows_${result.status}`);
        return { ok: true, workspaceId };
      } catch (error) {
        if (isExecutionRunActionAbort(error, context?.signal)) return executionRunActionFailure('cancelled');
        const details = error instanceof Error && 'relationshipIds' in error && Array.isArray(error.relationshipIds)
          && error.relationshipIds.every((id: unknown) => typeof id === 'string')
          ? { relationshipIds: error.relationshipIds } : undefined;
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code : readRpcErrorCode(error);
        return executionRunActionFailure(code ?? 'project_account_rows_unavailable', undefined, details);
      }
    },
    ...createCliProjectSourceActionDeps({
      serverHttpBaseUrl: todoHomeBaseUrl,
      admitAccount: async (serverId, context) => {
        const denied = projectHomeAdmission(serverId, context);
        if (denied) return denied;
        // Shared Source metadata uses the admitted requester HTTP authority;
        // the canonical header owner validates its Home/target/signing context.
        if (context.externalActionExecutionAuthorization) {
          const http = context.externalActionExecutionAuthorization.requesterHttpProjection;
          if (http && (http.accountId !== context.externalActionExecutionAuthorization.binding.accountId
            || http.serverId !== projectHomeId || http.serverHttpBaseUrl.replace(/\/+$/, '') !== todoHomeBaseUrl.replace(/\/+$/, '')
            || !await http.isCurrent())) return executionRunActionFailure('project_requester_authority_unavailable');
          return null;
        }
        const accountDenied = projectAccountAdmission(serverId, context);
        if (accountDenied) return accountDenied;
        if (params.token !== params.credentials?.token) return executionRunActionFailure('not_authenticated');
        if (!params.serverId && configuration.activeServerId !== projectHomeId) return executionRunActionFailure('server_scope_mismatch');
        return null;
      },
      resolveRequestHeaders: async (context, effectActionId, request) => {
        const projection = context.externalActionExecutionAuthorization?.requesterHttpProjection;
        if (!projection) return resolveServerRequestHeaders(context, effectActionId, request);
        return projection.createRequestHeaders({ ...request, effectActionId, ...(context.signal ? { signal: context.signal } : {}) });
      },
      readArtifact: async (ref, options, context) => {
        if (context.externalActionExecutionAuthorization) return readProjectRequesterArtifact(ref, options, context);
        if (projectAccountAdmission(projectHomeId, context) || !roleArtifactStore) return null;
        if (ref.serverId === projectHomeId) {
          return runWithServerHttpBaseUrl(todoHomeBaseUrl, () => roleArtifactStore.read(ref.artifactId, options));
        }
        // Signed Source HTTP authority carries no foreign Home Artifact reader;
        // it cannot borrow the custodian's saved-profile credentials.
        if (context.externalActionCredential || context.externalActionExecutionAuthorization) return null;
        return withCliPromptLibraryArtifactReader(async reader => {
          const artifact = await reader.readArtifact(ref);
          return artifact ? { artifactId: artifact.id, header: artifact.header } : null;
        }, { serverId: projectHomeId, signal: options?.signal });
      },
    }),
    ...(roleArtifactStore && homeAccountId ? createCliWidgetAreaActionDepsV1({
      transport: createAcknowledgedAccountArtifactTransport({
        read: (id, options) => runWithServerHttpBaseUrl(todoHomeBaseUrl, () => roleArtifactStore.read(id, options)),
        create: args => runWithServerHttpBaseUrl(todoHomeBaseUrl, () => roleArtifactStore.create(args)),
        update: args => runWithServerHttpBaseUrl(todoHomeBaseUrl, () => roleArtifactStore.update(args)),
        list: args => runWithServerHttpBaseUrl(todoHomeBaseUrl, () => roleArtifactStore.list(args)),
        delete: (id, options) => runWithServerHttpBaseUrl(todoHomeBaseUrl, () => roleArtifactStore.delete(id, options)),
      }), scope: { serverId: params.serverId ?? configuration.activeServerId, accountId: homeAccountId },
      // A CLI invocation captures its credentials and explicit Home; only ambient invocations follow active Home changes.
      isCurrent: () => !!params.serverId || configuration.activeServerId === todoHomeServerId,
    }) : {}),
    ...(roleArtifactStore && homeAccountId ? createCliWidgetDefinitionActionDepsV1({
      transport: roleArtifactStore, accountId: homeAccountId, serverHttpBaseUrl: params.serverHttpBaseUrl,
      getDeps: () => actionDeps, readCandidates: readWidgetCandidates,
    }) : {}),
    ...createCliWidgetInputActionDepsV1({
      serverId: params.serverId ?? configuration.activeServerId, accountId: homeAccountId,
      getDeps: () => actionDeps, readCandidates: readWidgetCandidates,
      readResources: async (signal, session) => {
        const projection = await readWidgetProjection(signal, session);
        return { resources: Object.values(projection?.resourcesById ?? {}),
          connectedAccountDescriptors: Object.values(projection?.familiesById.connectedAccounts?.entriesById ?? {}) };
      },
      readViewerPurposeContext: async (signal, context) => {
        if (!params.credentials || !homeAccountId) return null;
        const credentials = params.credentials;
        const operationContext = params.savedSecretOperationContext;
        const home = operationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
        const read = async () => {
          const authorizeRequest = (request: Readonly<{ method: string; path: string; body?: unknown }>) =>
            resolveServerRequestHeaders(context, context.externalActionExecutionAuthorization?.binding.actionId ?? 'widgets.catalog.list', request);
          const catalogInput = { credentials, signal, operationContext, authorizeRequest };
          const store = createCliConnectedAccountCatalogStore(catalogInput);
          store.assertCurrent();
          const purpose = await readActiveConnectedAccountCatalog({ ...catalogInput, key: 'purposes' });
          store.assertCurrent();
          if (purpose.status !== 'ready' || purpose.record.key !== 'purposes') return null;
          const profile = await fetchAccountProfile({ token: credentials.token, signal, authorizeRequest });
          store.assertCurrent();
          if (operationContext && !await operationContext.isCurrent()
            || params.isCredentialCurrent && !await params.isCredentialCurrent()) return null;
          store.assertCurrent();
          return profile.id === homeAccountId ? { profile, purposeBindings: purpose.record.value } : null;
        };
        return runWithServerHttpBaseUrl(home, read);
      },
      validateSession: async (session, signal) => {
        if (session.serverId !== (params.serverId ?? configuration.activeServerId)) return false;
        const transport = await resolveTransportForSession(session.sessionId, signal);
        return transport.ok && transport.sessionId === session.sessionId;
      },
    }),
    widgetAccountScope: () => {
      const accountId = params.credentials ? readAccountIdFromToken(params.credentials.token) : null;
      return accountId ? { serverId: params.serverId ?? configuration.activeServerId, accountId } : null;
    },
    widgetCatalog: { list: async (surface, _context, signal, boundSession) => {
      const port = readWidgetActionSurfacePortV1(actionDeps, surface);
      if (!port) return { ok: false, errorCode: 'unsupported_widget_surface', error: 'unsupported_widget_surface' };
      const sessionRef = boundSession ?? (surface.owner.kind === 'sessionBoard' ? { serverId: surface.serverId, sessionId: surface.owner.sessionId } : undefined);
      const candidates = await readWidgetCandidates(signal, sessionRef);
      const read = await port.read(surface, _context, signal);
      if ('ok' in read) return read;
      const instances = read.instances.map(entry => entry.instance);
      const entries = candidates.map(candidate => cliWidgetCatalogEntryV1(candidate, countWidgetInstancesV1(instances, widgetCandidateDefinitionV1(candidate))));
      for (const summary of await actionDeps.widgetDefinitionArtifacts?.list(signal) ?? []) {
        const reference = { kind: 'artifact' as const, artifactId: summary.artifactId };
        entries.push({ definition: reference, title: summary.name, fields: [...summary.inputs.fields],
          sizeDeclaration: summary.sizeDeclaration,
          availability: summary.bodyKind === 'declarative' || summary.sourceDefinition && candidates.some(candidate => candidate.availability === 'available'
            && isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), summary.sourceDefinition!)) ? 'available' : 'unavailable',
          instanceCount: countWidgetInstancesV1(instances, reference) });
      }
      return entries;
    } },
    artifactAction: async (args) => {
      if (!roleArtifactStore) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const execute = createCliArtifactActions({ store: roleArtifactStore, onPublicLinkIssued: params.onPublicLinkIssued,
        beforeDelete: async ({ artifactId, signal }) => {
          signal?.throwIfAborted();
          const assertCurrent = () => {
            if (!isActiveAccountSettingsSnapshotLifetimeCurrent({ scopeKey: roleAccountScopeKey, lifetimeToken: roleAccountLifetimeToken })) {
              throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
            }
          };
          assertCurrent();
          if (!homeAccountId || !readRawRoleSettings) {
            throw Object.assign(new Error('account_settings_content_unavailable'), { code: 'account_settings_content_unavailable' });
          }
          const rawSettings = await readRawRoleSettings({ requireCurrentNetwork: true });
          signal?.throwIfAborted();
          assertCurrent();
          await assertAccountRoleArtifactDeletionV1({ artifactId, accountId: homeAccountId, rawSettings,
            readTargetArtifactKind: async () => {
              const artifact = await roleArtifactStore.read(artifactId, { signal, includeSharedAudience: false });
              signal?.throwIfAborted();
              assertCurrent();
              return typeof artifact?.header.kind === 'string' ? artifact.header.kind : undefined;
            } });
        }, resolvePublishCaller: async (context) => {
        const caller = await resolveActionCallerSession(context);
        if (!caller?.directory || !caller.machineId || !(await requireLocalPromptActionMachine(caller.machineId)).ok) return null;
        return { sessionId: caller.sessionId, machineId: caller.machineId, directory: caller.directory,
          ...(context.runtimeRunId ? { runId: context.runtimeRunId } : {}) };
      } });
      return params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => execute({ ...args, context: artifactCallerContext(args.context) }))
        : execute({ ...args, context: artifactCallerContext(args.context) });
    },
    artifactAccessAction: async (args) => {
      if (!artifactAccessAction) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      return params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => artifactAccessAction(args)) : artifactAccessAction(args);
    },
    connectedServiceAction: params.credentials ? createCliConnectedServiceAction({
      credentials: params.credentials, ...exactHome, resolveHeaders: resolveServerRequestHeaders, callMachineAction,
    }) : undefined,
    profileActionExecute: params.credentials ? createCliProfileActionExecuteV1({
      credentials: params.credentials, serverId: projectHomeId,
      serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
      ...(params.savedSecretOperationContext ? { operationContext: params.savedSecretOperationContext } : {}),
      callMachineAction,
    }) : undefined,
    mcpServerAction: params.credentials ? createCliMcpServerActionExecuteV1({
      credentials: params.credentials, serverId: projectHomeId,
      serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
      ...(params.savedSecretOperationContext ? { operationContext: params.savedSecretOperationContext } : {}),
      callMachineAction,
    }) : undefined,
    providerActionExecute: params.credentials ? createCliProviderActionExecuteV1({
      credentials: params.credentials, serverId: projectHomeId,
      serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
      ...(params.savedSecretOperationContext ? { operationContext: params.savedSecretOperationContext } : {}),
      callMachineAction,
    }) : undefined,
    remoteHostActionExecute: params.credentials ? createCliRemoteHostActionExecuteV1({
      credentials: params.credentials, serverId: projectHomeId,
      serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
      ...(params.savedSecretOperationContext ? { operationContext: params.savedSecretOperationContext } : {}),
    }) : undefined,
    launchProfilePublish: async (input, context) => {
      const credentials = params.credentials;
      if (!roleArtifactStore || !credentials) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
      const denied = projectAccountAdmission(undefined, context?.context);
      if (denied) throw Object.assign(new Error(denied.errorCode), { code: denied.errorCode });
      return await runWithServerHttpBaseUrl(launchProfilePublicationServerUrl, async () => {
        context?.signal?.throwIfAborted();
        if (!params.savedSecretOperationContext && !getActiveAccountSettingsSnapshot()) await bootstrapAccountSettingsContext({ credentials, mode: 'blocking' });
        const profileStore = params.savedSecretOperationContext
          ? createCliProfileStoreForOperation({ operationContext: params.savedSecretOperationContext, signal: context?.signal })
          : createCliProfileStore({ credentials, signal: context?.signal });
        const refreshCatalog = () => refreshActiveProfileCatalog({ credentials, signal: context?.signal,
          ...(params.savedSecretOperationContext ? { operationContext: params.savedSecretOperationContext } : {}) });
        await refreshCatalog();
        profileStore.assertCurrent();
        let capturedRow: Readonly<{ record: ProfileRecordV1; revision: number }> | null = null;
        return await createLaunchProfilePublisherV1({
          profileStore: {
            read: async profileId => {
              const catalog = await profileStore.readProfileCatalog();
              profileStore.assertCurrent();
              if (catalog.status !== 'ready' || catalog.source !== 'destination') {
                throw Object.assign(new Error('profile_catalog_unavailable'), { code: 'profile_catalog_unavailable' });
              }
              capturedRow = catalog.records.find(row => row.record.id === profileId) ?? null;
              return capturedRow;
            },
            updateDefinition: async ({ profileId, expectedRevision, artifactId }) => {
              profileStore.assertCurrent();
              if (!capturedRow || capturedRow.record.id !== profileId || capturedRow.revision !== expectedRevision) {
                throw Object.assign(new Error('profile_revision_conflict'), { code: 'profile_revision_conflict' });
              }
              const result = await profileStore.writeRecord({
                record: { ...capturedRow.record, definition: { kind: 'artifact', artifactId } },
                expectedRevision, operation: 'update',
              });
              if (result.status !== 'updated') {
                throw Object.assign(new Error(`profile_row_${result.status}`), { code: `profile_row_${result.status}` });
              }
              await refreshCatalog().catch(() => undefined);
            },
          },
          artifactStore: {
            read: (id, signal) => {
              profileStore.assertCurrent();
              return roleArtifactStore.read(id, signal ? { signal } : undefined);
            },
            create: input => {
              profileStore.assertCurrent();
              return roleArtifactStore.create(input);
            },
          },
        }).publish(input, { ...context,
          context: artifactCallerContext(context?.context ?? { surface: 'cli', authority: 'present_user' }) });
      });
    },
    resolveSessionSpawnAgentInventorySelection,
    notificationChannelsList: async (context) => {
      if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      context.signal?.throwIfAborted();
      try {
        const items = await listActivityNotificationChannels({ ...await readNotificationContext(context.signal),
          pushTokenReader: new PushNotificationClient(params.credentials.token,
            params.savedSecretOperationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl ?? configuration.serverUrl,
            params.serverId ?? configuration.activeServerId),
          ...(params.resolvePluginNotifications ? { pluginNotifications: params.resolvePluginNotifications() } : {}) });
        context.signal?.throwIfAborted();
        return { items };
      } catch (error) { return notificationFailure(error); }
    },
    webhookCall: async (input, context) => {
      context.signal?.throwIfAborted();
      let result: Awaited<ReturnType<typeof postWebhookJsonAsync>>;
      try {
        result = await postWebhookJsonAsync({ ...input,
          idempotencyKey: context.actionRequestId ?? randomUUID(),
          ...(context.signal ? { signal: context.signal } : {}) });
      } catch (error) {
        if (error instanceof WebhookDestinationAdmissionError) {
          return { ok: false, errorCode: 'webhook_destination_rejected', error: 'Webhook destination rejected' };
        }
        throw error;
      }
      return result.status >= 300
        ? { ok: false, errorCode: 'webhook_failed', error: 'Webhook failed', details: result } : result;
    },
    notificationsNotifyMe: async (input, context) => {
      if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      context.signal?.throwIfAborted();
      if (input.open?.kind === 'session') {
        const session = await fetchSessionById({ token: params.credentials.token, sessionId: input.open.sessionId,
          ...(params.savedSecretOperationContext?.serverHttpBaseUrl || params.serverHttpBaseUrl
            ? { serverUrl: params.savedSecretOperationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl } : {}),
          ...(context.signal ? { signal: context.signal } : {}), accessProjectionVersion: 1 });
        if (session?.id !== input.open.sessionId || !session.effectiveAccess?.capabilities.readTranscript) {
          return { ok: false, errorCode: 'session_not_found', error: 'session_not_found' };
        }
      } else if (input.open?.kind === 'workflow_run') {
        if (!workflowAction) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
        const visible = await workflowAction({ actionId: 'workflow.run.get', input: { runId: input.open.runId }, context });
        if ('ok' in visible && visible.ok === false) return visible;
      }
      context.signal?.throwIfAborted();
      try {
      return await dispatchActivityNotificationAsync({
        ...await readNotificationContext(context.signal),
        expoPushSender: new PushNotificationClient(params.credentials.token,
          params.savedSecretOperationContext?.serverHttpBaseUrl ?? params.serverHttpBaseUrl ?? configuration.serverUrl,
          params.serverId ?? configuration.activeServerId),
        ...(params.resolvePluginNotifications ? { pluginNotifications: params.resolvePluginNotifications() } : {}),
        ...(input.channels ? { channels: input.channels } : {}),
        event: { topic: 'notify_me', message: input.message,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.open ? { open: input.open } : {}),
          ...(context.actionRequestId ? { actionRequestId: context.actionRequestId } : {}) },
      });
      } catch (error) { return notificationFailure(error); }
    },
    machineCommandRun: async (input, context) => {
      context.signal?.throwIfAborted();
      const target = context.externalActionTarget;
      if (target?.kind !== 'machine' || !target.project || target.project.machineId !== target.machineId) {
        return { ok: false, errorCode: 'command_target_required', error: 'Command machine and workspace are required' };
      }
      if (!isMachineActionServerScopeCurrent(context.serverId ?? undefined)) {
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      }
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== target.machineId) {
        return { ok: false, errorCode: 'command_transport_unavailable', error: 'Command machine transport is unavailable' };
      }
      const raw = await callMachineAction({
        machineId: target.machineId,
        serverId: context.serverId ?? undefined,
        authority: context.authority,
        method: RPC_METHODS.BASH,
        request: { command: input.command, ...(input.env ? { env: input.env } : {}),
          cwd: target.project.directory, cwdMode: 'explicit', timeout: 0,
          ...(context.actionCaller?.kind === 'workflowRun'
            ? { outputTailMaxBytes: MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES } : {}) },
        timeoutMs: null,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !('success' in raw) || typeof raw.success !== 'boolean') {
        return { ok: false, errorCode: 'action_failed', error: 'Command result is invalid' };
      }
      const response = raw as Record<string, unknown>;
      // Pre-process refusals may omit output; a successful command must carry
      // complete output rather than fabricating an empty result after an effect.
      const output = WorkflowMachineCommandOutputV1Schema.safeParse({
        exitCode: response.exitCode === undefined && !response.success ? -1 : response.exitCode,
        stdout: response.stdout === undefined && !response.success ? '' : response.stdout,
        stderr: response.stderr === undefined && !response.success ? '' : response.stderr,
        ...(response.stdoutTruncated === undefined ? {} : { stdoutTruncated: response.stdoutTruncated }),
        ...(response.stderrTruncated === undefined ? {} : { stderrTruncated: response.stderrTruncated }),
      });
      if (!output.success) return { ok: false, errorCode: 'action_failed', error: 'Command result is invalid' };
      if (response.success) return output.data;
      const cancelled = response.error === 'Command cancelled';
      return { ok: false, errorCode: cancelled ? 'command_cancelled' : 'command_failed',
        error: cancelled ? 'Command cancelled' : 'Command failed', details: output.data };
    },
    getCurrentWorkspaceWrites: params.getCurrentWorkspaceWrites ?? (params.getCurrentSessionMetadata ? () => {
      const read = readAccountRoleOverrides();
      return read.status === 'ready' ? readSessionWorkspaceWritesV1(params.getCurrentSessionMetadata?.(), {
        settingsOverrides: read.overrides, settingsRoles: params.getCurrentResolvedRoles?.(),
      }) : 'deny';
    } : undefined),
    roleActionExecute: ((createHost: (sessionId: string, readMetadata: typeof params.getCurrentSessionMetadata) =>
      NonNullable<ActionExecutorDeps['roleActionExecute']>): NonNullable<ActionExecutorDeps['roleActionExecute']> =>
      async (initialRequest) => {
        const operation = async () => {
        let request = { ...initialRequest, context: artifactCallerContext(initialRequest.context) };
        const input = RoleActionInputSchemasV1[request.actionId].parse(request.input);
        if (request.context.authority !== 'present_user'
          && (request.actionId === 'session.roles.apply_to_reports' || ('sessionId' in input && input.sessionId !== params.sessionId))
          && (request.context.actionCaller?.kind !== 'session' || !params.sessionActionRpcTransport)) {
          throw Object.assign(new Error('role_rpc_origin_unavailable'), { code: 'role_rpc_origin_unavailable' });
        }
        await prepareAccountRoleOverrides(request.context.signal);
        let execute = createHost(params.sessionId, params.getCurrentSessionMetadata);
        if (request.context.actionCaller?.kind === 'session' && request.context.authority !== 'present_user') {
          const caller = await resolveActionCallerSession(request.context);
          if (!caller?.metadata) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
          const roleSources = await readRoleSources(request.context.signal);
          const overridesRead = readAccountRoleOverrides();
          if (overridesRead.status !== 'ready') throw Object.assign(new Error('account_role_overrides_unavailable'), { code: 'account_role_overrides_unavailable' });
          const currentWrites = readSessionWorkspaceWritesV1(caller.metadata, {
            roleSourceInventory: roleSources,
            settingsOverrides: overridesRead.overrides,
          });
          request = { ...request, context: { ...request.context,
            workspaceWrites: currentWrites === 'deny' || request.context.workspaceWrites === 'deny' ? 'deny' : currentWrites } };
        }
        // The source daemon owns the authenticated origin. Expand report copies
        // there through the same role owner, rather than asking a target Session
        // to impersonate the caller's Machine on a second forwarding hop.
        if (request.actionId === 'session.roles.apply_to_reports' && request.context.actionCaller?.kind === 'session'
          && request.context.authority !== 'present_user') {
          const input = RoleActionInputSchemasV1['session.roles.apply_to_reports'].parse(request.input);
          const target = await resolveTransportForSession(input.sessionId);
          if (!target.ok || target.rawSession.effectiveAccess?.level !== 'owner' || !params.credentials) {
            throw Object.assign(new Error('session_target_unavailable'), { code: 'session_target_unavailable' });
          }
          const metadata = tryDecryptSessionOwnerMetadataView({ credentials: params.credentials,
            accountEncryptionMode: target.accountEncryptionCurrentness.mode, rawSession: target.rawSession });
          if (!metadata) throw Object.assign(new Error('session_target_unavailable'), { code: 'session_target_unavailable' });
          execute = createHost(input.sessionId, () => metadata);
        }
        const result = await execute(request);
        if (params.credentials && (request.actionId === 'roles.list' || request.actionId === 'roles.get')
          && !isActiveAccountSettingsSnapshotLifetimeCurrent({ scopeKey: roleAccountScopeKey, lifetimeToken: roleAccountLifetimeToken })) {
          throw Object.assign(new Error('account_role_overrides_unavailable'), {
            code: 'account_role_overrides_unavailable', reason: 'scope-retired',
          });
        }
        return result;
        };
        return params.serverHttpBaseUrl
          ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, operation) : operation();
      })((sessionId, readSessionMetadata) => createRoleActionExecutor({
      sessionId,
      readSessionMetadata,
      stageSessionStateMutation: params.stageSessionStateMutation,
      readRoleSources,
      readPluginRoles: params.readPluginRoles,
      prepareWorkspaceWritesPolicy: params.prepareWorkspaceWritesPolicy,
      forwardSessionRoleAction: async ({ actionId, input, context }) => {
        const request = RoleActionInputSchemasV1[actionId].parse(input);
        if (!('sessionId' in request)) throw Object.assign(new Error('session_target_unavailable'), { code: 'session_target_unavailable' });
        const transport = await resolveTransportForSession(request.sessionId);
        if ('ok' in transport && transport.ok === false) throw Object.assign(new Error(transport.code), { code: transport.code });
        const response = await callSessionRoleRpc(transport, actionId, input, context);
        if (response && typeof response === 'object' && 'ok' in response && response.ok === false) return response;
        const parsed = RoleActionOutputSchemasV1[actionId].safeParse(response);
        if (parsed.success) return parsed.data;
        throw Object.assign(new Error('session_target_unavailable'), { code: 'session_target_unavailable' });
      },
      artifactStore: roleArtifactStore,
      readSettingsOverrides: readAccountRoleOverrides,
      ...(params.credentials ? {
        accountId: readAccountIdFromToken(params.credentials.token) ?? undefined,
        listReportSessions: async (leadSessionId, context) => {
          const accountId = readAccountIdFromToken(params.credentials!.token);
          if (!accountId) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
          const reports: { sessionId: string; ownerAccountId: string }[] = [];
          for (const storage of ['active', 'archived'] as const) {
            let cursor: string | undefined;
            do {
              const read = () => fetchSessionsQueryPage({ token: params.credentials!.token,
                query: { v: 1, storage, includeInactive: true, scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [],
                  underSessionId: leadSessionId, ...(cursor ? { cursor } : {}) },
                ...(context.signal ? { signal: context.signal } : {}),
                resolveAuthorizationHeaders: (request) => resolveServerRequestHeaders(context, 'session.roles.apply_to_reports', request),
              });
              const page = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, read) : read());
              for (const session of page.sessions) {
                if (session.reportsTo?.sessionId === leadSessionId && session.effectiveAccess.level === 'owner') {
                  reports.push({ sessionId: session.id, ownerAccountId: accountId });
                }
              }
              if (page.hasNext && (!page.nextCursor || page.nextCursor === cursor)) {
                throw Object.assign(new Error('session_list_cursor_invalid'), { code: 'session_list_cursor_invalid' });
              }
              cursor = page.hasNext ? page.nextCursor ?? undefined : undefined;
            } while (cursor);
          }
          return reports;
        },
        writeReportSessionRoles: async (sessionId, configuration, context) => {
          const transport = await resolveTransportForSession(sessionId);
          if ('ok' in transport && transport.ok === false) throw Object.assign(new Error(transport.code), { code: transport.code });
          const result = await callSessionRoleRpc(transport, SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET,
            { sessionId, configuration }, context);
          if (!result || typeof result !== 'object' || !('updated' in result) || result.updated !== true) {
            const code = result && typeof result === 'object' && 'errorCode' in result && typeof result.errorCode === 'string'
              ? result.errorCode : 'session_target_unavailable';
            throw Object.assign(new Error(code), { code });
          }
        },
        readRawAccountSettings: readRawRoleSettings,
        mutateAccountRoleOverrides: async (mutation, context) => {
          await createCliPromptLibraryStore({ credentials: params.credentials!, signal: context.signal }).mutateRoleOverride(mutation);
        },
      } : {}),
    })),
    scmActionExecute: executeSessionBoundScmAction,
    executionRunCheckProtocolV2: async (sessionId, requirement, opts) => {
      if (
        !requirement.detachedScope
        && !requirement.startAndWait
        && !requirement.exactInputResults
        && !requirement.runScopedAgentBindings
        && !requirement.secretReferenceOverlay
      ) {
        return { ok: true };
      }
      return await readExecutionRunProtocolV2(sessionId, requirement, opts);
    },
    executionRunStart: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_START,
          request,
          opts,
        );
      }
      // Public Session RPC cannot authenticate a host-private admission stamp.
      // Refuse before resuming/sending instead of losing the admitted ceiling.
      if (opts?.workDepth !== undefined || opts?.workspaceWrites !== undefined) {
        return { ok: false, code: 'execution_run_target_unavailable',
          details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated') };
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return {
          ok: false,
          code: transport.code,
          ...(transport.candidates ? { candidates: transport.candidates } : {}),
          details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated'),
        };
      }
      const admittedMachineId = normalizeStringValue(opts?.exactMachineId);
      if (
        admittedMachineId
        && readExecutionRunTransportMachineId(transport) !== admittedMachineId
      ) {
        return {
          ok: false,
          code: 'execution_run_target_unavailable',
          details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated'),
        };
      }
      const resumed = await resumeInactiveSessionTransport({
        transport,
        localId: `execution.run.start:${randomUUID()}`,
        ...(opts?.signal ? { signal: opts.signal } : {}),
        waitForReady: true,
      });
      if (!resumed.ok) {
        return {
          ok: false,
          code: 'execution_run_target_unavailable',
          message: resumed.message,
          details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated'),
        };
      }
      return await startExecutionRun({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunList: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_LIST,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      return await listExecutionRuns({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        skipLiveRpc: transport.rawSession.active === false,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunGet: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_GET,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      return await getExecutionRun({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    detachedExecutionRunSend: async (sessionId, request, opts) =>
      await callDetachedExecutionRunRpc(
        sessionId,
        SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
        request,
        opts,
      ),
    executionRunEnsure: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { details: transport.candidates } : {}) };
      }
      return await ensureExecutionRun({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunEnsureOrStart: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { details: transport.candidates } : {}) };
      }
      return await ensureOrStartExecutionRun({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunStreamStart: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { details: transport.candidates } : {}) };
      }
      return await startExecutionRunStream({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunStreamRead: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { details: transport.candidates } : {}) };
      }
      return await readExecutionRunStream({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunStreamCancel: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { details: transport.candidates } : {}) };
      }
      return await cancelExecutionRunStream({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunCancelTurn: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(sessionId, SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1, request, opts);
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) return { ok: false, code: transport.code };
      return await callSessionRpc({
        ...transport, token: params.token, sessionId: transport.sessionId,
        method: SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1, request,
        ...executionRunAuthorityCeiling(opts),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunStop: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      return await stopExecutionRun({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunAction: async (sessionId, request, opts) => {
      if (sessionId === null) {
        return await callDetachedExecutionRunRpc(
          sessionId,
          SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
          request,
          opts,
        );
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }
      return await executeExecutionRunAction({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        request,
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    executionRunPermissionRespond: async (request, context) => {
      if (!isMachineActionServerScopeCurrent(context.serverId ?? undefined)) {
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      }
      const target = await resolveExecutionRunMachineTarget(null, {
        targetMachineId: context.executionRunTargetMachineId,
        originSessionId: context.defaultSessionId,
        serverId: context.serverId,
      });
      if (!target.ok) return { ok: false, errorCode: target.errorCode, error: target.errorCode };
      const direct = params.machineActionDirectTargetTransport;
      if (direct?.machineId === target.machineId) {
        return await direct.invoke(RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND, request, {
          ...(context.signal ? { signal: context.signal } : {}),
          localActionContext: context,
        });
      }
      if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      return await callExactMachineRpc({
        credentials: params.credentials,
        machineId: target.machineId,
        serverUrl: params.serverHttpBaseUrl ?? configuration.serverUrl,
        method: RPC_METHODS.DAEMON_EXECUTION_RUN_PERMISSION_RESPOND,
        request,
        ...executionRunAuthorityCeiling(context),
        ...(context.signal ? { signal: context.signal } : {}),
      });
    },
    executionRunWait: async (sessionId, request, opts) => {
      if (sessionId === null) {
        if (!params.credentials) return { ok: false, code: 'not_authenticated' };
        const target = await resolveExecutionRunMachineTarget(sessionId, opts);
        if (!target.ok) return { ok: false, code: target.errorCode };
        return await waitForExecutionRun({ credentials: params.credentials, machineId: target.machineId,
          serverUrl: params.serverHttpBaseUrl ?? configuration.serverUrl,
          ...executionRunAuthorityCeiling(opts), runId: request.runId,
          timeoutMs: normalizeExecutionRunWaitTimeoutMs(request.timeoutSeconds),
          ...(request.condition ? { condition: request.condition } : {}),
          ...(request.after ? { after: ExecutionRunGetResponseSchema.parse(request.after) } : {}),
          ...(opts?.onSnapshot ? { onSnapshot: opts.onSnapshot } : {}),
          ...(opts?.signal ? { signal: opts.signal } : {}),
          ...(requiresDirectExecutionRunTransport(opts) ? { invokeWait: (request: unknown, signal?: AbortSignal) =>
            callDetachedExecutionRunRpc(null, SESSION_RPC_METHODS.EXECUTION_RUN_WAIT, request,
              { ...opts, exactMachineId: target.machineId, ...(signal ? { signal } : {}) }) } : {}),
        });
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, code: transport.code, ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      }

      return await waitForExecutionRun({
        ...transport,
        token: params.token,
        sessionId: transport.sessionId,
        ...executionRunAuthorityCeiling(opts),
        runId: request.runId,
        timeoutMs: normalizeExecutionRunWaitTimeoutMs(request.timeoutSeconds),
        ...(request.condition ? { condition: request.condition } : {}),
        ...(request.after ? { after: ExecutionRunGetResponseSchema.parse(request.after) } : {}),
        ...(opts?.onSnapshot ? { onSnapshot: opts.onSnapshot } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
    ...(reviewCommentAction
      ? {
        reviewCommentAction: async ({ actionId, input, reviewCommentPrincipal, signal }) =>
          await reviewCommentAction(actionId, input, {
            ...(reviewCommentPrincipal ? { principal: reviewCommentPrincipal } : {}),
            ...(signal ? { signal } : {}),
          }),
      }
      : {}),

    daemonMemorySearch: async ({ machineId, query, serverId, signal }) => {
      const credentials = params.credentials;
      if (!credentials) return notSupported();
      const documentsRequested = query.corpora?.includes('documents') === true;
      if (documentsRequested && !isMachineActionServerScopeCurrent(serverId ?? undefined)) {
        return { v: 1, ok: false, errorCode: 'memory_invalid_query', error: 'Exact Home scope is unavailable.' };
      }
      // A capability on one daemon cannot authorize a successor or another
      // Home. Keep released transcript-only target replacement unchanged.
      const serverUrl = params.serverHttpBaseUrl ?? configuration.serverUrl;
      const callMemoryRpc = (method: string, request: unknown) =>
        (documentsRequested ? callExactMachineRpc : callMachineRpc)({
          credentials, machineId, method, request,
          ...(documentsRequested ? { serverUrl } : {}),
          ...(signal ? { signal } : {}),
        });
      const result = await negotiateMemorySearchV1({
        query,
        readDocumentSearchSupport: async () => MemoryStatusV1Schema.parse(
          await callMemoryRpc(RPC_METHODS.DAEMON_MEMORY_STATUS, {}),
        ).documentSearchSupported === true,
        search: async (request) => await callMemoryRpc(RPC_METHODS.DAEMON_MEMORY_SEARCH, request),
        ...(signal ? { signal } : {}),
      });
      if (!result.ok) return result;

      const visibleThroughSeqBySessionId = new Map<string, number>();
      await Promise.all([...new Set(result.hits.flatMap((hit) =>
        isMemoryDocumentSearchHitV1(hit) ? [] : [hit.sessionId],
      ))].map(async (sessionId) => {
        try {
          const session = await fetchSessionById({
            token: credentials.token,
            sessionId,
            ...(documentsRequested ? { serverUrl } : {}),
            ...(signal ? { signal } : {}),
          });
          if (session && Number.isSafeInteger(session.seq) && session.seq >= 0) {
            visibleThroughSeqBySessionId.set(sessionId, session.seq);
          }
        } catch {
          signal?.throwIfAborted();
          // The daemon index is derived state. An unreadable Session cannot be
          // returned as Action data, even when its retained summary still exists.
        }
      }));
      signal?.throwIfAborted();
      return {
        ...result,
        hits: result.hits.filter((hit) => {
          // The daemon Artifact owner authorizes qualified document hits; this
          // Session read applies only to retained transcript ranges.
          if (isMemoryDocumentSearchHitV1(hit)) return true;
          const visibleThroughSeq = visibleThroughSeqBySessionId.get(hit.sessionId);
          return visibleThroughSeq !== undefined
            && hit.seqFrom <= visibleThroughSeq
            && hit.seqTo <= visibleThroughSeq;
        }),
      };
    },
    daemonMemoryGetWindow: async ({ machineId, sessionId, seqFrom, seqTo, signal }) => {
      if (!params.credentials) return notSupported();
      const session = await fetchSessionById({
        token: params.credentials.token,
        sessionId,
        ...(signal ? { signal } : {}),
      });
      const visibleThroughSeq = session?.seq;
      if (
        typeof visibleThroughSeq !== 'number'
        || !Number.isSafeInteger(visibleThroughSeq)
        || visibleThroughSeq < 0
        || seqFrom > visibleThroughSeq
        || seqTo > visibleThroughSeq
      ) {
        throw Object.assign(
          new Error('Memory window is outside the current Session projection.'),
          { code: 'not_authenticated' as const },
        );
      }
      return MemoryWindowV1Schema.parse(await callMachineRpc({
        credentials: params.credentials,
        machineId,
        method: RPC_METHODS.DAEMON_MEMORY_GET_WINDOW,
        request: { v: 1, sessionId, seqFrom, seqTo },
        ...(signal ? { signal } : {}),
      }));
    },
    daemonMemoryEnsureUpToDate: async ({ machineId, sessionId }) => {
      if (!params.credentials) return notSupported();
      return await callMachineRpc({
        credentials: params.credentials,
        machineId,
        method: RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE,
        request: sessionId ? { sessionId } : {},
      });
    },
    daemonPromptAssetsDiscover: async ({ request, signal }) => await discoverPromptAssets({
      registry: promptAssetAdapterRegistry,
      request,
      ...(signal ? { signal } : {}),
    }),
    daemonPromptAssetsDelete: async ({ request, signal }) => await deletePromptAsset({
      registry: promptAssetAdapterRegistry,
      request,
      ...(signal ? { signal } : {}),
    }),
    daemonPromptRegistryScanSource: async ({ request }) => await scanPromptRegistrySource({
      registry: promptRegistryAdapterRegistry,
      request,
    }),
    daemonPromptRegistryInstall: async ({ request, signal }) => await installPromptRegistryItem({
      registry: promptRegistryAdapterRegistry,
      assetRegistry: promptAssetAdapterRegistry,
      request,
      ...(signal ? { signal } : {}),
    }),
    ...(homeHubArtifactPort ? { homeHubArtifacts: {
      read: signal => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => homeHubArtifactPort.read(signal)) : homeHubArtifactPort.read(signal),
      apply: (intent, signal) => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => homeHubArtifactPort.apply(intent, signal)) : homeHubArtifactPort.apply(intent, signal),
      describe: (layout, signal) => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => homeHubArtifactPort.describe(layout, signal)) : homeHubArtifactPort.describe(layout, signal),
      captureWidgetPresentation: (layout, instanceId, signal) => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => homeHubArtifactPort.captureWidgetPresentation(layout, instanceId, signal))
        : homeHubArtifactPort.captureWidgetPresentation(layout, instanceId, signal),
    } } : {}),
    ...(roleArtifactStore ? { workBoardArtifacts: {
      readBoardAccess: (boardId, signal) => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => createWorkBoardArtifactPortV1(roleArtifactStore).readBoardAccess(boardId, signal))
        : createWorkBoardArtifactPortV1(roleArtifactStore).readBoardAccess(boardId, signal),
      readBoard: (boardId, signal) => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => createWorkBoardArtifactPortV1(roleArtifactStore).readBoard(boardId, signal))
        : createWorkBoardArtifactPortV1(roleArtifactStore).readBoard(boardId, signal),
      read: (signal) => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => createWorkBoardArtifactPortV1(roleArtifactStore).read(signal))
        : createWorkBoardArtifactPortV1(roleArtifactStore).read(signal),
      apply: (intent, signal, context) => params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => createWorkBoardArtifactPortV1(roleArtifactStore).apply(intent, signal, context ? artifactCallerContext(context) : undefined))
        : createWorkBoardArtifactPortV1(roleArtifactStore).apply(intent, signal, context ? artifactCallerContext(context) : undefined),
    } } : {}),
    todoSessionLink: async ({ input, context, signal }) => {
      const parsed = TodoSessionLinkInputV1Schema.safeParse(input);
      if (!parsed.success) return { status: 'refused', reason: 'invalid_input' };
      if (!params.credentials || !homeAccountId) return { status: 'unavailable' };
      // The executor's captured Home/credentials are the Account authority, not a caller-supplied URL.
      const requireCurrent = () => {
        if (signal?.aborted || parsed.data.scope.serverId !== todoHomeServerId || parsed.data.scope.accountId !== homeAccountId
          || (params.serverId === undefined && configuration.activeServerId !== todoHomeServerId)) {
          throw new TodoSessionLinkErrorV1('task_scope_mismatch');
        }
      };
      try {
        requireCurrent();
        await applyTodoSessionLinkV1(parsed.data, createCliAccountKvJsonTransport({
          credentials: params.credentials, key: `todo.${parsed.data.taskId}`,
          serverBaseUrl: todoHomeBaseUrl,
          ...(signal ? { signal } : {}),
          resolveAuthorizationHeaders: request => {
            requireCurrent();
            return resolveServerRequestHeaders(context, 'todos.session.link', request);
          },
        }), { requireCurrent });
        return { status: 'linked' };
      } catch (error) { return projectTodoSessionLinkFailureV1(error); }
    },
    updateAccountAcpCatalogSettings: async ({ mutate, signal, expectedRevision, sourceSettingsVersion }) => {
      if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      return await runWithServerHttpBaseUrl(params.savedSecretOperationContext?.serverHttpBaseUrl ?? todoHomeBaseUrl, async () => {
        try {
          if (!params.savedSecretOperationContext && getActiveAccountSettingsSnapshot()?.scopeKey
            !== resolveAccountSettingsScopeKeyForToken(params.credentials!.token)) {
            await bootstrapAccountSettingsContext({ credentials: params.credentials!, mode: 'blocking' });
          }
          const result = await createCliAcpCatalogStore({ credentials: params.credentials!, signal,
            operationContext: params.savedSecretOperationContext }).updateCatalog(mutate, { expectedRevision, sourceSettingsVersion });
          // Publication may retire after acknowledgement; the durable row receipt still succeeds.
          if (result.status === 'updated' || result.status === 'unchanged') return { ok: true as const };
          const details = { ...('revision' in result ? { revision: result.revision } : {}), ...('reason' in result ? { reason: result.reason } : {}) };
          const errorCode = result.status === 'conflict' ? 'conflict' : `acp_catalog_${result.status}`;
          return { ok: false as const, errorCode, error: errorCode, ...(Object.keys(details).length > 0 ? { details } : {}) };
        } catch (error) {
          const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code
            : signal?.aborted ? 'cancelled' : 'acp_catalog_unavailable';
          return { ok: false as const, errorCode: code, error: code };
        }
      });
    },
    projectsContextUpdate: async (input, context) => {
      if (projectAccountAdmission(input.target.serverId, context)) {
        return { ok: false, errorCode: 'project_context_access_denied' };
      }
      const accountId = context?.externalActionExecutionAuthorization?.binding.accountId ?? homeAccountId;
      if (!accountId) return { ok: false, errorCode: 'project_context_access_denied' };
      const run = () => updatePersonalProjectContextV1({
        accountScope: () => params.serverId === undefined && configuration.activeServerId !== todoHomeServerId
          ? null : { serverId: todoHomeServerId, accountId },
        readArtifact: async (ref, options) => {
          if (context?.externalActionExecutionAuthorization) {
            const artifact = await readProjectRequesterArtifact({ ...ref, serverId: ref.serverId ?? todoHomeServerId }, options, context);
            return artifact?.promptLibraryArtifact ?? null;
          }
          if (!approvalsStore) return null;
          if (!ref.serverId || ref.serverId === todoHomeServerId) return approvalsStore.promptLibraryStore.read(ref.artifactId, options);
          // Delegated provenance cannot borrow the user's saved foreign Home.
          if (context?.externalActionCredential || context?.externalActionExecutionAuthorization) return null;
          // The reader captures that Home's actual saved credential. Do not pass
          // this Action's credential override: the focused Home may be foreign.
          return withCliPromptLibraryArtifactReader(reader => reader.readArtifact(ref), {
            serverId: todoHomeServerId, signal: options?.signal,
          });
        },
        mutateOrganization: (mutation) => mutateProjectAccountOrganization({ ...mutation,
          ...projectRowsAuthority(context, 'projects.context.update', mutation.signal), serverId: mutation.serverId }),
      }, input, context);
      return runWithServerHttpBaseUrl(todoHomeBaseUrl, run);
    },
    projectAction: async (args) => {
      if (args.actionId === 'projects.trust.list' || args.actionId === 'projects.trust.revoke') {
        return await createCliProjectTrustAction({ token: params.token, credentials: params.credentials,
          accountId: homeAccountId, ...exactHome })(args);
      }
      if (params.projectAction) return await params.projectAction(args);
      const { actionId, input, context } = args;
      const parsed = PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
      if (!parsed.success) return executionRunActionFailure('invalid_parameters');
      const workspace = parsed.data.workspace;
      if (!isMachineActionServerScopeCurrent(workspace.serverId) || !isMachineActionServerScopeCurrent(context.serverId)) {
        return executionRunActionFailure('server_scope_mismatch');
      }
      const placement = await resolveProjectActionMachineV1({ actionId, input: parsed.data, context,
        executeCanonicalAction: args.executeCanonicalAction, createRequestKey: randomUUID });
      if (!placement.ok) return placement;
      const { machineId } = placement;
      if (context.externalActionTarget && (context.externalActionTarget.kind !== 'machine'
        || context.externalActionTarget.machineId !== machineId)) return executionRunActionFailure('target_not_local');
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return executionRunActionFailure('not_authenticated');
      }
      context.signal?.throwIfAborted();
      const originalAccount = params.credentials && !params.machineActionDirectTargetTransport
        && !context.externalActionCredential && !context.externalActionExecutionAuthorization
        && !context.rpcSessionAuthorization && (!context.actionCaller || context.actionCaller.kind === 'host');
      if (originalAccount) {
        if (context.surface !== 'cli' || !context.actionRequestId
          || (context.runtimeAccountId && context.runtimeAccountId !== homeAccountId)) {
          return executionRunActionFailure('admission_unavailable');
        }
        const execution = await dispatchOriginalAccountAction({ actionId, input: parsed.data, requestId: context.actionRequestId,
          target: { kind: 'machine', machineId }, credentials: params.credentials!, authority: context.authority,
          serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
          ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
          ...(params.onRequesterSessionCredentialDisclosure
            ? { onRequesterSessionCredentialDisclosure: params.onRequesterSessionCredentialDisclosure } : {}),
          ...(params.isCredentialCurrent ? { isCurrent: params.isCredentialCurrent } : {}),
          ...(context.signal ? { signal: context.signal } : {}) });
        if (!execution.ok) return execution;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
        if (approval.success && approval.data.actionId === actionId) return approval.data;
        const output = PROJECT_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(execution.result);
        return output.success ? output.data : executionRunActionFailure('invalid_action_output');
      }
      if (params.machineActionDirectTargetTransport?.machineId !== machineId && !context.externalActionCredential
        && !context.externalActionExecutionAuthorization && !context.rpcSessionAuthorization) {
        return executionRunActionFailure('admission_unavailable');
      }
      const call = () => callMachineAction({ machineId, serverId: workspace.serverId,
        method: PROJECT_FINITE_ACTION_RPC_METHODS_V1[actionId], request: parsed.data, authority: context.authority,
        ...(context.rpcSessionAuthorization ? { authorization: context.rpcSessionAuthorization } : {}),
        exactMachine: true, context, effectActionId: actionId, timeoutMs: null,
        ...(context.signal ? { signal: context.signal } : {}) });
      const raw = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, call) : call());
      // A received finite acknowledgement retains its operation custody even
      // if observation is cancelled while consuming it. Cancellation before
      // issue and strict output validation remain unchanged; this is not Stop.
      const failure = ActionExecuteFailureSchema.safeParse(raw);
      if (failure.success) return failure.data;
      const approval = ActionApprovalRequestCreatedResultSchema.safeParse(raw);
      if (approval.success && approval.data.actionId === actionId) return approval.data;
      const output = PROJECT_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(raw);
      return output.success ? output.data : executionRunActionFailure('invalid_action_output');
    },
    promptDocGet: async ({ artifactId, signal }) => {
      if (!approvalsStore) return notSupported();
      return await readPromptDocInLibrary({ store: approvalsStore.promptLibraryStore, artifactId, ...(signal ? { signal } : {}) });
    },
    promptDocCreate: async ({ signal, ...request }) => {
      if (!approvalsStore) return notSupported();
      return createPromptDocInLibrary({ store: approvalsStore.promptLibraryStore, request, signal });
    },
    promptDocFavoriteSet: async ({ signal, ...request }) => {
      if (!approvalsStore) return notSupported();
      return setPromptDocFavorite({ store: approvalsStore.promptLibraryStore, request, signal });
    },
    promptsLibraryList: async ({ signal, ...request }) => {
      if (!approvalsStore) return notSupported();
      return listPromptLibrary({ store: approvalsStore.promptLibraryStore, request, signal });
    },
    promptInvocationsList: async (request) => {
      request.signal?.throwIfAborted();
      const source = await readPromptInvocations(request.signal);
      const unavailable = { items: [], coverage: 'unavailable' as const };
      if (!source) return unavailable;
      try {
        source.assertCurrent();
        const result = listPromptInvocationsInLibrary({ invocations: source.invocations, request });
        source.assertCurrent();
        return result;
      } catch { request.signal?.throwIfAborted(); return unavailable; }
    },
    promptInvocationResolve: async ({ sessionId, signal, ...request }) => {
      if (!approvalsStore) return notSupported();
      const source = await readPromptInvocations(signal);
      const unavailable = { status: 'unavailable' as const, invocationId: request.invocationId.trim() };
      if (!source) return unavailable;
      try {
        source.assertCurrent();
        const result = await withCliPromptLibraryArtifactReader((reader) => resolvePromptInvocationInLibrary({ invocations: source.invocations,
          store: approvalsStore.promptLibraryStore, readArtifact: async (ref) => {
            source.assertCurrent();
            const artifact = await reader.readArtifact(ref);
            source.assertCurrent();
            return artifact;
          }, request, sessionId: sessionId ?? null, signal }), { credentials: params.credentials, serverId: projectHomeId, signal });
        source.assertCurrent();
        return result;
      } catch { signal?.throwIfAborted(); return unavailable; }
    },
    promptDocUpdate: async ({ signal, ...request }) => {
      if (!approvalsStore) return notSupported();
      return await updatePromptDocInLibrary({
        store: approvalsStore.promptLibraryStore,
        request,
        ...(signal ? { signal } : {}),
      });
    },
    promptBundleUpdate: async ({ signal, ...request }) => {
      if (!approvalsStore) return notSupported();
      return await updatePromptBundleInLibrary({
        store: approvalsStore.promptLibraryStore,
        request,
        ...(signal ? { signal } : {}),
      });
    },
    promptAssetExport: async ({ signal, ...request }) => {
      if (!approvalsStore) return notSupported();
      const account = capturePromptExternalLinkAccount(signal);
      const localMachine = await requireLocalPromptActionMachine(request.machineId);
      if (!localMachine.ok) return localMachine;
      const linkContext = await resolvePromptExternalLinkMachineContext(request.machineId);
      account.store.assertCurrent();
      if (!linkContext) return { ok: false, errorCode: 'prompt_catalog_unavailable', error: 'Prompt external link Home unavailable' };
      const promptExternalLinks = await readPromptExternalLinks(account, signal);
      if (!promptExternalLinks) return { ok: false, errorCode: 'prompt_catalog_unavailable', error: 'Prompt external link catalog unavailable' };
      const result = await exportPromptLibraryArtifact({
        ...linkContext,
        store: { ...approvalsStore.promptLibraryStore, read: async (artifactId, options) => {
          account.store.assertCurrent();
          const read = () => approvalsStore.promptLibraryStore.read(artifactId, options);
          const artifact = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, read) : read());
          account.store.assertCurrent();
          return artifact;
        } },
        write: async ({ request: writeRequest, signal: writeSignal }) => {
          account.store.assertCurrent();
          return await writePromptAsset({ registry: promptAssetAdapterRegistry, request: writeRequest,
            ...(writeSignal ? { signal: writeSignal } : {}) });
        },
        request: {
          ...request,
          workspacePath: request.directory ?? null,
          targetInput: request.targetPath ?? request.targetName ?? '',
          promptExternalLinks: promptExternalLinks.value,
        },
        randomId: randomUUID,
        ...(signal ? { signal } : {}),
      });
      if (!result.ok) return result;
      const externalLinkPersistence = await persistPromptExternalLink(
        result.nextPromptExternalLinks,
        promptExternalLinks,
        signal,
      );
      return {
        ...result,
        ...(externalLinkPersistence ? { externalLinkPersistence } : {}),
      };
    },
    promptRegistryInstall: async ({ signal, ...request }) => {
      if (!approvalsStore) return notSupported();
      const account = capturePromptExternalLinkAccount(signal);
      const localMachine = await requireLocalPromptActionMachine(request.machineId);
      if (!localMachine.ok) return localMachine;
      const linkContext = await resolvePromptExternalLinkMachineContext(request.machineId);
      account.store.assertCurrent();
      if (!linkContext) return { ok: false, errorCode: 'prompt_catalog_unavailable', error: 'Prompt external link Home unavailable' };
      let fetchedItem: PromptRegistryFetchedItemV1 | null = null;
      const promptExternalLinks = await readPromptExternalLinks(account, signal);
      if (!promptExternalLinks) return { ok: false, errorCode: 'prompt_catalog_unavailable', error: 'Prompt external link catalog unavailable' };
      const result = await installPromptRegistryItemInLibrary({
        ...linkContext,
        store: { ...approvalsStore.promptLibraryStore, create: async input => {
          account.store.assertCurrent();
          const create = approvalsStore.promptLibraryStore.create;
          if (!create) throw new Error('prompt_library_artifact_create_unavailable');
          const write = () => create(input);
          return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, write) : write());
        } },
        fetchItem: async ({ sourceId, itemId, configuredSources, signal: fetchSignal }) => {
          account.store.assertCurrent();
          const fetched = await fetchPromptRegistryItem({
            registry: promptRegistryAdapterRegistry,
            sourceId,
            itemId,
            configuredSources,
            ...(fetchSignal ? { signal: fetchSignal } : {}),
          });
          account.store.assertCurrent();
          if (fetched.ok) fetchedItem = fetched.item;
          return fetched;
        },
        install: async ({ request: installRequest, signal: installSignal }) => {
          account.store.assertCurrent();
          return await installPromptRegistryItem({ registry: promptRegistryAdapterRegistry, assetRegistry: promptAssetAdapterRegistry,
            request: installRequest, ...(fetchedItem ? { fetchedItem } : {}), ...(installSignal ? { signal: installSignal } : {}) });
        },
        request: {
          ...request,
          promptExternalLinks: promptExternalLinks.value,
        },
        randomId: randomUUID,
        ...(signal ? { signal } : {}),
      });
      if (!result.ok) return {
        ...result,
        ...(result.exported === true && result.response ? { details: {
          exported: true,
          response: result.response,
          ...(result.artifactId ? { artifactId: result.artifactId } : {}),
        } } : {}),
      };
      const externalLinkPersistence = await persistPromptExternalLink(
        result.nextPromptExternalLinks,
        promptExternalLinks,
        signal,
      );
      return {
        ...result,
        ...(externalLinkPersistence ? { externalLinkPersistence } : {}),
      };
    },

    sessionOpen: async ({ sessionId, serverId, actionRequestId, signal, approvedNewDirectoryCreation }) => {
      if (!params.credentials) return notSupported();
      const exactServerId = normalizeStringValue(serverId);
      const boundServerId = normalizeStringValue(params.serverId);
      if (!exactServerId || !boundServerId || exactServerId !== boundServerId) {
        return { ok: false, errorCode: 'session_not_found', error: 'session_not_found' };
      }
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, errorCode: transport.code, error: transport.code };
      }
      if (transport.rawSession.active === true) {
        return {
          ok: true,
          status: 'opened',
          sessionId: transport.sessionId,
          serverId: exactServerId,
          address: { serverId: exactServerId, sessionId: transport.sessionId },
        };
      }
      const localId = normalizeStringValue(actionRequestId) ?? `session.open:${transport.sessionId}`;
      const resumed = await resumeInactiveSessionTransport({
        transport,
        localId,
        ...(approvedNewDirectoryCreation === true ? { approvedNewDirectoryCreation: true } : {}),
        ...(signal ? { signal } : {}),
      });
      return resumed.ok
        ? {
            ok: true,
            status: 'opened',
            sessionId: transport.sessionId,
            serverId: exactServerId,
            address: { serverId: exactServerId, sessionId: transport.sessionId },
          }
        : { ok: false, errorCode: resumed.code, error: resumed.message };
    },
    sessionFork: async ({
      sessionId,
      forkPoint,
      strategy,
      replaySummaryRunner,
      replayMaxSeedChars,
      requestId,
      signal,
    }) => {
      if (!params.credentials) return notSupported();
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, errorCode: transport.code, error: transport.code };
      }
      const metadata = readTransportSessionOwnerMetadata(transport);
      const machineId = normalizeStringValue(transport.rawSession.machineId)
        ?? normalizeStringValue(metadata?.machineId);
      if (!machineId) {
        return { ok: false, errorCode: 'machine_not_found', error: 'machine_not_found' };
      }
      return await callMachineAction({
        machineId,
        method: RPC_METHODS.SESSION_FORK,
        request: {
          parentSessionId: transport.sessionId,
          forkPoint,
          ...(strategy ? { strategy } : {}),
          ...(replaySummaryRunner ? { replaySummaryRunner } : {}),
          ...(replayMaxSeedChars !== undefined ? { replayMaxSeedChars } : {}),
          ...(requestId ? { requestId } : {}),
        },
        ...(signal ? { signal } : {}),
      });
    },
    sessionContinueWithReplay: async (args) => {
      if (!params.credentials) return notSupported();
      const machineId = (await readCurrentMachineControlIdentity()).machineId;
      if (!machineId) {
        return { ok: false, errorCode: 'machine_not_found', error: 'machine_not_found' };
      }
      const { signal, ...request } = args;
      return await callMachineRpc({
        credentials: params.credentials,
        machineId,
        method: RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY,
        request,
        ...(signal ? { signal } : {}),
      });
    },
    sessionRollback: async ({ sessionId, target, signal }) => await callResolvedSessionRpc(
      sessionId,
      SESSION_RPC_METHODS.SESSION_ROLLBACK,
      { sessionId, ...(target ? { target } : {}) },
      signal,
    ),
    checkpointCodeRollback: async ({ request, signal }) => await callResolvedSessionRpc(
      request.sessionId,
      SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK,
      request,
      signal,
    ),
    sessionCheckpoint: async ({ request, signal }) => await callResolvedSessionRpc(
      request.sessionId,
      SESSION_RPC_METHODS.SESSION_CHECKPOINT,
      request,
      signal,
    ),
    sessionRestore: async ({ request, signal }) => await callResolvedSessionRpc(
      request.sessionId,
      SESSION_RPC_METHODS.SESSION_RESTORE,
      request,
      signal,
    ),
    // One destination-approval preflight for both destination-choosing Action
    // families. Handoff expresses its intent through a workspace action; direct
    // Project linking has no Session and states its intent and mode explicitly.
    sessionHandoffTargetReplacementApprovalPreflight: async ({
      targetMachineId,
      targetPath,
      workspaceAction,
      activatesExactMirror,
      destinationIntent,
      serverId,
      operationId,
      signal,
    }) => {
      const handoffChoosesDestination = workspaceAction?.kind === 'copy_once'
        || workspaceAction?.kind === 'create_relationship';
      if (!handoffChoosesDestination && destinationIntent === undefined) {
        return { type: 'not_required' as const };
      }
      if (!params.credentials || !targetPath?.trim() || !serverId?.trim() || !operationId.trim()) {
        return { type: 'error' as const, result: { ok: false, errorCode: 'invalid_input', error: 'invalid_input' } };
      }
      const mirrors = activatesExactMirror
        ?? (workspaceAction?.kind === 'create_relationship' && workspaceAction.mode === 'mirror_exactly');
      try {
        return HandoffTargetReplacementPreflightResultV1Schema.parse(await callMachineAction({
          machineId: targetMachineId,
          method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT,
          request: {
            v: 1,
            serverId: serverId.trim(),
            machineId: targetMachineId,
            operationId: operationId.trim(),
            targetPath: targetPath.trim(),
            ...(mirrors ? { activatesExactMirror: true } : {}),
            ...(destinationIntent ? { destinationIntent } : {}),
          },
          ...(signal ? { signal } : {}),
        }));
      } catch (error) {
        const errorCode = readRpcErrorCode(error) ?? 'target_unavailable';
        return { type: 'error' as const, result: { ok: false, errorCode, error: errorCode } };
      }
    },
    workspaceSyncRelationshipCreate: async ({
      input,
      operationId,
      serverId,
      targetReplacementApproval,
      targetReplacementApprovalReceiptId,
      signal,
    }) => {
      if (!params.credentials) return notSupported();
      // Linking runs on the machine that hosts the selected source Workspace.
      // Its address comes from current Account rows, never from the caller.
      const currentServerId = normalizeStringValue(serverId) ?? params.serverId ?? configuration.activeServerId;
      if (currentServerId !== (params.serverId ?? configuration.activeServerId)) {
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      }
      const rows = await readProjectRows(signal);
      const source = resolveWorkspaceRefById(rows.workspaceRefs, input.sourceWorkspaceRefId, currentServerId);
      if (!source) {
        return { ok: false, errorCode: 'workspace_ref_not_ready', error: 'workspace_ref_not_ready' };
      }
      return await callMachineAction({
        machineId: source.machineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE,
        request: {
          v: 1,
          operationId,
          actionInput: input,
          ...(targetReplacementApproval && targetReplacementApprovalReceiptId
            ? { targetReplacementApproval, targetReplacementApprovalReceiptId }
            : {}),
        },
        ...(signal ? { signal } : {}),
      });
    },
    workspaceSyncConflictResolve: async ({ actionReceiptId, input, signal }) => {
      if (!params.credentials) {
        throw Object.assign(new Error('Workspace sync resolution requires an authenticated Account'), { code: 'not_authenticated' });
      }
      try {
        return WorkspaceSyncConflictResolutionResultV1Schema.parse(await callMachineAction({
          machineId: input.controllerMachineId,
          method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_RESOLVE,
          request: { actionReceiptId, actionInput: input },
          ...(signal ? { signal } : {}),
        }));
      } catch (error) {
        if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) {
          throw Object.assign(new Error('Controller must be updated for workspace conflict resolution'), {
            code: 'workspace_sync_update_required',
          });
        }
        throw error;
      }
    },
    workspaceSyncRelationshipsList: async ({ input, signal }) => {
      const machineId = await resolveWorkspaceSyncReadController(input, signal);
      return WorkspaceSyncRelationshipsListRpcResultV1Schema.parse(await callMachineAction({
        machineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST,
        request: input.workspaceRefId ? { workspaceRefId: input.workspaceRefId } : {},
        ...(signal ? { signal } : {}),
      }));
    },
    workspaceSyncConflictsList: async ({ input, signal }) => {
      const machineId = await resolveWorkspaceSyncReadController(input, signal);
      return WorkspaceSyncConflictPageV1Schema.parse(await callMachineAction({
        machineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST,
        request: { relationshipId: input.relationshipId, limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) },
        ...(signal ? { signal } : {}),
      }));
    },
    workspaceSyncConflictInspect: async ({ input, signal }) => {
      const machineId = await resolveWorkspaceSyncReadController(input, signal);
      return WorkspaceSyncConflictInspectRpcResultV1Schema.parse(await callMachineAction({
        machineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT,
        request: {
          workspaceRefId: input.workspaceRefId,
          path: input.path,
          ...(input.preview ? { preview: input.preview } : {}),
        },
        ...(signal ? { signal } : {}),
      }));
    },
    sessionHandoffStart: async ({
      sessionId,
      targetMachineId,
      targetPath,
      targetSessionStorageMode,
      workspaceAction,
      serverId,
      actionRequestId,
      handoffTargetReplacementApproval,
      handoffTargetReplacementApprovalReceiptId,
      handoffTargetReplacementApprovalActionInput,
      signal,
    }) => {
      if (!params.credentials) return notSupported();
      const transport = await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return { ok: false, errorCode: transport.code, error: transport.code };
      }
      // One owner for the handoff source facts, shared with the daemon's tracked
      // coordinator: machine custody and transcript-storage authority both come
      // from OWNER metadata, and an unresolved link refuses here rather than
      // being stamped as `persisted` on a request that stops the source.
      const source = resolveSessionHandoffSourceAuthority({
        credentials: params.credentials,
        rawSession: transport.rawSession,
        accountEncryptionMode: transport.accountEncryptionCurrentness.mode,
      });
      if (!source.ok) {
        return { ok: false, errorCode: source.errorCode, error: source.error };
      }
      const sourceMachineId = source.sourceMachineId;
      return await callMachineAction({
        machineId: sourceMachineId,
        method: RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3,
        request: {
          sessionId: transport.sessionId,
          sourceMachineId,
          targetMachineId,
          sessionStorageMode: source.sessionStorageMode,
          ...(targetPath ? { targetPath } : {}),
          ...(targetSessionStorageMode ? { targetSessionStorageMode } : {}),
          preferredTransportStrategies: ['direct_peer', 'server_routed_stream'],
          ...(workspaceAction ? { workspaceAction } : {}),
          ...(serverId ? { accountServerId: serverId } : {}),
          ...(actionRequestId ? { actionRequestId } : {}),
          ...(handoffTargetReplacementApproval ? { handoffTargetReplacementApproval } : {}),
          ...(handoffTargetReplacementApprovalReceiptId ? {
            handoffTargetReplacementApprovalReceiptId,
            handoffTargetReplacementApprovalActionInput,
          } : {}),
        },
        ...(signal ? { signal } : {}),
      });
    },
    resolveAgentStartContext,
    sessionSpawnNewDirectoryApprovalPreflight: async ({ input, signal }) => {
      if (!params.credentials) {
        return {
          type: 'error' as const,
          result: { type: 'error' as const, code: 'permission_denied' as const, retryable: false },
        };
      }
      if (signal?.aborted) {
        return {
          type: 'error' as const,
          result: { type: 'error' as const, code: 'cancelled' as const, retryable: true },
        };
      }
      if (!isCurrentSessionSpawnExecutionTarget(input.executionTarget)) {
        return {
          type: 'error' as const,
          result: { type: 'error' as const, code: 'target_unavailable' as const, retryable: false },
        };
      }
      if (input.directory.kind === 'managed' || input.checkoutCreationDraft) {
        // A worktree is materialized by the SCM owner, not by the raw
        // directory-creation authorization path.
        return { type: 'not_required' as const };
      }

      const preparation = await prepareSessionSpawnTarget({
        executionTarget: input.executionTarget,
        directory: input.directory,
        ...(signal ? { signal } : {}),
      });
      if (!preparation.ok) {
        return { type: 'error' as const, result: preparation.result };
      }
      if (!preparation.preparedTarget.directoryCreationRequired) {
        return { type: 'not_required' as const };
      }
      const approval: SessionCreationDirectoryApprovalV1 = {
        v: 1,
        executionTarget: input.executionTarget,
        directory: preparation.preparedTarget.directory,
      };
      return { type: 'approval_required' as const, approval };
    },
    sessionSpawnNew: async ({
      context,
      creationAuthorization,
      callerInputConstraints,
      executionTarget,
      directory,
      initialAccess,
      initialTriggers,
      initialSessionRolesV1,
      reportsTo,
      primaryTeamId,
      teamCredentialBindings,
      organizationPlacement,
      placementOrigin,
      agentTarget,
      modelSelection,
      profileId,
      secretReferenceOverlay,
      permissionMode,
      agentModeId,
      configuration: configurationSnapshot,
      connectedServices,
      mcpSelection,
      transcriptStorage,
      terminal,
      checkoutCreationDraft,
      title,
      identity,
      memoryEnabled,
      promptStack,
      initialInput,
      agentSessionStartupInstructionsV1,
      environmentVariables,
      sessionCreationTag,
      sourceContext,
      legacyMetadataLabel,
      actionCaller,
      callerSurface,
      actionRequestId,
      resumeActionRequest,
      sessionCreationDirectoryApproval,
      workDepth,
      originKind,
      originSessionId,
      originRunId,
      signal,
    }) => {
      if (!params.credentials) {
        return { type: 'error', code: 'permission_denied', retryable: false };
      }
      if (signal?.aborted) {
        return { type: 'error', code: 'cancelled', retryable: true };
      }
      if ((initialInput?.attachments?.length ?? 0) > 0 && actionCaller.kind !== 'plugin') {
        return { type: 'error', code: 'invalid_input', retryable: false };
      }
      if (initialInput && !params.machineAdmissionTransport) {
        const externalRequest = context?.externalActionCredential !== undefined
          || context?.externalActionExecutionAuthorization !== undefined;
        const authorizationHeaders = externalRequest
          ? resolveServerRequestHeaders(context, 'session.spawn_new', {
              method: 'GET', path: '/v1/account/encryption/currentness',
            })
          : null;
        if (externalRequest && !authorizationHeaders) {
          return { type: 'error', code: 'permission_denied', retryable: false };
        }
        // New Sessions use persisted Account mode, never the parent's mode or
        // credential key presence. Existing Session sends read their own mode.
        const currentness = await fetchAccountEncryptionCurrentness({
          token: params.credentials.token,
          ...(params.serverHttpBaseUrl ? { serverBaseUrl: params.serverHttpBaseUrl } : {}),
          ...(authorizationHeaders ? { authorizationHeaders } : {}),
          ...(signal ? { signal } : {}),
        });
        const { inputAdmission } = buildSessionSpawnInitialInputAdmissionForLocalIdV1({
          actionCaller,
          callerSurface,
          // Only admission facts are inspected here; the creator owns the
          // actual first-input local id after settling the Session identity.
          localId: sessionCreationTag,
        });
        if (requiresMachineAdmissionForSessionInput({
          request: inputAdmission.request,
          mode: currentness.mode,
          ...(context?.externalActionExecutionAuthorization
            ? { callerInputAuthorization: context.externalActionExecutionAuthorization }
            : {}),
        })) {
          const cause = new MachineAdmissionTransportUnavailableError();
          // Refuse unadmittable protected input before a Session exists.
          throw Object.assign(new Error(cause.message, { cause }), {
            code: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
          });
        }
      }

      if (!isCurrentSessionSpawnExecutionTarget(executionTarget)) {
        return { type: 'error', code: 'target_unavailable', retryable: false };
      }
      const normalizedActionRequestId = normalizeStringValue(actionRequestId);
      if (resumeActionRequest === true && !normalizedActionRequestId) {
        return { type: 'error', code: 'invalid_input', retryable: false };
      }
      const spawnNonce = normalizedActionRequestId
        ? createStableSpawnNonce('session.spawn_new.action', { actionRequestId: normalizedActionRequestId })
        : undefined;

      const directTargetTransport = params.sessionSpawnDirectTargetTransport;
      let placementOriginSupported = Boolean(directTargetTransport);
      let secretReferenceOverlaySupported = Boolean(directTargetTransport);
      if (
        directTargetTransport
        && directTargetTransport.machineId !== executionTarget.machineId
      ) {
        return { type: 'error', code: 'target_unavailable', retryable: false };
      }
      if (!directTargetTransport) {
        let targetCapabilityProjection: Awaited<ReturnType<typeof readMachineOperationProtocolCapabilitiesV1>>;
        try {
          targetCapabilityProjection = await readMachineOperationProtocolCapabilitiesV1({
            credentials: params.credentials,
            machineId: executionTarget.machineId,
            ...(signal ? { signal } : {}),
          });
        } catch (error) {
          const spawnMayHaveBeenAccepted = hasPossiblyAcceptedSpawnNonce(error);
          if (signal?.aborted) {
            if (spawnMayHaveBeenAccepted) {
              return {
                type: 'pending',
                retryWithSameCreationKey: true,
                outcome: 'unknown',
              };
            }
            return { type: 'error', code: 'cancelled', retryable: true };
          }
          if (isAuthenticationError(error)) {
            return { type: 'error', code: 'permission_denied', retryable: false };
          }
          return { type: 'error', code: 'machine_offline', retryable: true };
        }
        if (
          !targetCapabilityProjection
          || !supportsMachineOperationProtocolCapabilityV1(
            targetCapabilityProjection.capabilities,
            'sessionSpawn',
          )
        ) {
          if (initialSessionRolesV1 !== undefined) {
            return {
              type: 'error', code: 'update_required', retryable: false,
              details: {
                kind: 'update_required', operation: 'session.spawn_new', component: 'daemon',
                reason: 'session_roles_snapshot_update_required',
              },
            };
          }
          if (initialAccess !== undefined || primaryTeamId !== undefined) {
            return {
              type: 'error', code: 'update_required', retryable: false,
              details: new SessionInitialAccessUpdateRequiredError('daemon').details,
            };
          }
          return { type: 'error', code: 'incompatible_target', retryable: false };
        }
        placementOriginSupported = supportsMachineOperationProtocolCapabilityV1(
          targetCapabilityProjection.capabilities,
          'sessionSpawnPlacementOrigin',
        );
        secretReferenceOverlaySupported = supportsMachineSessionSpawnProtocolVersionV1(
          targetCapabilityProjection.capabilities,
          2,
        );
      }
      if (secretReferenceOverlay && !secretReferenceOverlaySupported) {
        return {
          type: 'error',
          code: 'update_required',
          retryable: false,
          details: {
            kind: 'update_required',
            operation: 'session.spawn_new',
            component: 'daemon',
            reason: 'session_secret_reference_overlay_update_required',
          },
        };
      }

      const resolvedAgentTarget = resolveSessionCreationAgentTarget(agentTarget);
      if (!resolvedAgentTarget) {
        return { type: 'error', code: 'target_unavailable', retryable: false };
      }
      const { backendTarget } = resolvedAgentTarget;
      const connectedServicesDefaults = connectedServices === undefined
        ? await resolveSpawnConnectedServicesDefaultPayload({
            credentials: params.credentials,
            backendTarget,
            ...(params.savedSecretOperationContext ? { operationContext: params.savedSecretOperationContext } : {}),
            ...(params.resolveTeamCredentialResourceCatalog
              ? { resolveTeamCredentialResourceCatalog: params.resolveTeamCredentialResourceCatalog }
              : {}),
          })
        : null;
      if (signal?.aborted) {
        return { type: 'error', code: 'cancelled', retryable: true };
      }
      const resolvedConnectedServices = connectedServices
        ?? connectedServicesDefaults?.connectedServices;
      const resolvedConnectedServicesUpdatedAt = connectedServicesDefaults?.connectedServicesUpdatedAt;
      // Defaulted Team targets reach the Session only through its own Team
      // slot bindings; an explicit slot choice wins.
      const resolvedTeamCredentialBindings = mergeSessionTeamCredentialBindingIntents({
        explicit: teamCredentialBindings,
        admitted: connectedServicesDefaults?.teamCredentialBindings ?? null,
      });
      const normalizedPlacement =
        normalizeSessionCreationOrganizationPlacementV1(organizationPlacement);
      const normalizedTerminal = terminal === undefined
        ? undefined
        : SessionAuthoringTerminalV1Schema.safeParse(terminal);
      if (normalizedTerminal !== undefined && !normalizedTerminal.success) {
        return { type: 'error', code: 'invalid_input', retryable: false };
      }
      const spawnTerminal = normalizedTerminal === undefined
        ? undefined
        : SpawnSessionTerminalSchema.safeParse(normalizedTerminal.data);
      if (spawnTerminal !== undefined && !spawnTerminal.success) {
        return { type: 'error', code: 'invalid_input', retryable: false };
      }
      const windowsTerminal = normalizedTerminal?.data.windows;
      const normalizedConfigurationOverrides = configurationSnapshot
        ? buildAcpConfigOptionOverridesV1({
            updatedAt: Math.max(
              configurationSnapshot.mode.updatedAtMs,
              configurationSnapshot.model.updatedAtMs,
              configurationSnapshot.permissionIntent.updatedAtMs,
              ...Object.values(configurationSnapshot.options).map((entry) => entry.updatedAtMs),
            ),
            overrides: Object.fromEntries(
              Object.entries(configurationSnapshot.options).map(([key, entry]) => [
                key,
                { updatedAt: entry.updatedAtMs, value: entry.value },
              ]),
            ),
          })
        : undefined;
      const resolvedModelSelection = modelSelection
        ?? (configurationSnapshot?.model.value
          ? SessionModelSelectionV1Schema.parse({
              v: 1,
              updatedAt: configurationSnapshot.model.updatedAtMs,
              ref: {
                agentTargetKey: buildBackendTargetKeyV2(backendTarget),
                providerConnectionId: null,
                modelId: configurationSnapshot.model.value,
              },
            })
          : undefined);
      const requestedPermissionMode = permissionMode
        ?? configurationSnapshot?.permissionIntent.value
        ?? undefined;
      const resolvedPermissionMode = requestedPermissionMode
        ? parsePermissionIntentAlias(requestedPermissionMode)
        : undefined;
      if (requestedPermissionMode && !resolvedPermissionMode) {
        return { type: 'error', code: 'invalid_input', retryable: false };
      }
      const resolvedAgentModeId = agentModeId
        ?? configurationSnapshot?.mode.value
        ?? undefined;
      const startupInstructionsMarker = agentSessionStartupInstructionsV1
        ? {
            v: agentSessionStartupInstructionsV1.v,
            id: agentSessionStartupInstructionsV1.id,
            revision: agentSessionStartupInstructionsV1.revision,
          }
        : null;
      const targetPreparation = await prepareSessionSpawnTarget({
        executionTarget,
        directory,
        sessionCreationTag,
        ...(checkoutCreationDraft !== undefined ? { checkoutCreationDraft } : {}),
        ...(signal ? { signal } : {}),
      });
      if (!targetPreparation.ok) return targetPreparation.result;
      const preparedTarget = targetPreparation.preparedTarget;
      // A created receipt is not current exclusive custody. Pre-spawn failures
      // retain the checkout; deleting files remains an explicit SCM operation.
      if (signal?.aborted) {
        return { type: 'error', code: 'cancelled', retryable: true };
      }
      const directoryApproval = SessionCreationDirectoryApprovalV1Schema.safeParse(
        sessionCreationDirectoryApproval,
      );
      if (
        preparedTarget.directoryCreationRequired
        && (
          !directoryApproval.success
          || directoryApproval.data.executionTarget.serverId !== executionTarget.serverId
          || directoryApproval.data.executionTarget.machineId !== executionTarget.machineId
          || directoryApproval.data.directory !== preparedTarget.directory
        )
      ) {
        return { type: 'error', code: 'permission_denied', retryable: false };
      }
      const normalizedDirectory = preparedTarget.directory;
      const initialTriggerPreparationState: { failure?: unknown } = {};
      const prepareInitialTriggers: Parameters<typeof createSpawnedSession>[0]['prepareInitialTriggers'] =
        identity?.bot?.kind === 'bot' || (initialTriggers && initialTriggers.length > 0) ? async () => {
          try {
            const preparedDrafts = [...(initialTriggers ?? [])];
            if (identity?.bot?.kind === 'bot') {
              const settings = roleSettingsProvider.getAccountSettings?.();
              if (!settings) throw Object.assign(new Error('account_settings_content_unavailable'), { code: 'account_settings_content_unavailable' });
              if (settings.memoryUpkeepInNewBots) {
                const upkeep = getWorkflowStarterExamplesV1().find((example) => example.key === 'memory-upkeep-in-session');
                if (upkeep?.triggerSeed?.kind !== 'schedule') throw Object.assign(new Error('source_unavailable'), { code: 'source_unavailable' });
                preparedDrafts.push({ target: { kind: 'inline', definition: upkeep.definition },
                  executionTarget: { kind: 'session' }, trigger: upkeep.triggerSeed });
              }
            }
            if (preparedDrafts.length === 0) return [];
            if (!workflowTriggers) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
            return await workflowTriggers.prepareSessionInitialTriggers({
              project: { machineId: executionTarget.machineId, directory: normalizedDirectory },
              initialTriggers: preparedDrafts,
              caller: {
                ...context,
                ...(actionCaller ? { actionCaller } : {}),
                ...(callerSurface ? { surface: callerSurface } : {}),
                ...(signal ? { signal } : {}),
              },
            });
          } catch (error) {
            initialTriggerPreparationState.failure = error;
            throw error;
          }
        } : undefined;
      const immutableCheckout = preparedTarget.checkout
        ? {
            kind: preparedTarget.checkout.kind,
            finalDirectory: preparedTarget.checkout.finalDirectory,
            baseRef: preparedTarget.checkout.baseRef,
            branchMode: preparedTarget.checkout.branchMode,
          }
        : null;
      const correspondence = SessionCreationCorrespondenceV1Schema.parse({
        v: 1,
        sessionCreationTag,
        recipe: {
          execution: {
            machineId: executionTarget.machineId,
            directory: directory.kind === 'managed' ? directory : { kind: 'path', path: normalizedDirectory },
          },
          organization: normalizedPlacement,
          agentTarget,
          modelSelection: resolvedModelSelection ?? null,
          profileId: profileId ?? null,
          ...(identity !== undefined ? { identity } : {}),
          ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
          ...(promptStack !== undefined ? { promptStack } : {}),
          ...(secretReferenceOverlay ? { secretReferenceOverlay } : {}),
          requestedPermissionMode: resolvedPermissionMode ?? null,
          agentModeId: resolvedAgentModeId ?? null,
          configuration: configurationSnapshot ?? null,
          connectedServices: resolvedConnectedServices ?? null,
          mcpSelection: mcpSelection ?? null,
          transcriptStorage: transcriptStorage ?? null,
          terminal: normalizedTerminal?.data ?? null,
          agentSessionStartupInstructionsMarkerV1: startupInstructionsMarker,
          checkout: immutableCheckout,
        },
      });
      // A source recipe is required semantics, not a hint: it is resolved to an
      // exact cutoff before any Session row exists, and a failure creates no
      // child so the authoring draft and its chip stay intact.
      let replaySeededCreation: ReplaySeededSessionCreationV1 | undefined;
      let managedDirectorySeed: Parameters<typeof createSpawnedSession>[0]['managedDirectorySeed'];
      if (sourceContext && resumeActionRequest !== true) {
        let sourceAuthority: Awaited<ReturnType<typeof resolveReplaySourceContextAuthority>>;
        try {
          sourceAuthority = await resolveReplaySourceContextAuthority({
            credentials: params.credentials,
            sourceSessionId: sourceContext.sourceSessionId,
          });
        } catch (error) {
          return isAuthenticationError(error)
            ? { type: 'error', code: 'permission_denied', retryable: false }
            : { type: 'error', code: 'spawn_failed', retryable: true };
        }
        if (sourceAuthority.status !== 'owned') {
          return sourceAuthority.status === 'not_owned'
            ? { type: 'error', code: 'permission_denied', retryable: false }
            : { type: 'error', code: 'spawn_failed', retryable: true };
        }
        const sameMachine = sourceAuthority.sourceMachineId === executionTarget.machineId;
        if (directory.kind === 'managed' && sourceAuthority.managedSource && (
          sourceAuthority.sourceMachineId === null || (sameMachine && !sourceAuthority.managedDirectorySeed)
        )) {
          // A managed fork promises proven local file continuity or an explicit
          // cross-machine empty folder. Unknown locality cannot satisfy either.
          return { type: 'error', code: 'spawn_failed', retryable: true };
        }
        if (directory.kind === 'managed' && sameMachine) managedDirectorySeed = sourceAuthority.managedDirectorySeed;
        const filesNotCopied = directory.kind === 'managed' && sourceAuthority.sourceMachineId !== null && !sameMachine
          ? { reason: 'cross_machine' as const } : undefined;
        const recipeResult = await buildReplaySeededSpawnRecipe({
          credentials: params.credentials,
          cwd: normalizedDirectory,
          source: {
            sourceSessionId: sourceContext.sourceSessionId,
            forkPoint: sourceContext.forkPoint,
          },
          agentHintAgentId: resolvedAgentTarget.agentId,
          // Source-local media survives only when the source and selected child
          // target are proven to be the same exact machine and this process is
          // directly preparing that target. A replacement relation or a direct
          // transport alone does not make an old workspace path usable.
          mediaContinuityUsableOnCreatingMachine:
            Boolean(directTargetTransport)
            && sourceAuthority.sourceMachineId === executionTarget.machineId,
        });
        if (!recipeResult.ok) {
          // The two recipe failures — an unhydratable source and an empty seed —
          // are not distinguishable at this owner, and neither created a child.
          // Report the retryable form so a transient source read does not strand
          // an otherwise valid authoring attempt.
          return { type: 'error', code: 'spawn_failed', retryable: true };
        }
        replaySeededCreation = {
          tag: sessionCreationTag,
          flavor: resolvedAgentTarget.agentId,
          metadata: {
            ...recipeResult.recipe.metadata,
            ...(filesNotCopied ? { forkV1: {
              ...(recipeResult.recipe.metadata.forkV1 && typeof recipeResult.recipe.metadata.forkV1 === 'object'
                ? recipeResult.recipe.metadata.forkV1 : {}),
              filesNotCopied,
            } } : {}),
            sessionCreationCorrespondenceV1: correspondence,
          },
          sourceRecipe: {
            sourceSessionId: sourceContext.sourceSessionId,
            cutoffSeqInclusive: recipeResult.recipe.cutoffSeqInclusive,
          },
        };
      }
      try {
        const created = await createSpawnedSession({
          ...(creationAuthorization ? { creationAuthorization } : {}),
          ...(callerInputConstraints ? { callerInputConstraints } : {}),
          credentials: params.credentials,
          ...(params.actionsSettingsProvider?.getAccountSettings
            ? { accountSettings: params.actionsSettingsProvider.getAccountSettings() ?? undefined } : {}),
          ...(workDepth !== undefined ? { workDepth, originKind, originSessionId, originRunId } : {}),
          directory: normalizedDirectory,
          directoryKind: preparedTarget.directoryKind,
          ...(managedDirectorySeed ? { managedDirectorySeed } : {}),
          ...(initialAccess !== undefined ? { initialAccess } : {}),
          ...(prepareInitialTriggers ? { prepareInitialTriggers } : {}),
          ...((promptStack?.length ?? 0) > 0 ? { preparePromptStack: async () => {
            await resolveCliPromptStackSystemAppendBlocks({ surface: 'coding', sessionEntries: promptStack,
              credentials: params.credentials, serverId: executionTarget.serverId, ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
              ...(signal ? { signal } : {}) });
          } } : {}),
          ...(initialSessionRolesV1 !== undefined ? { initialSessionRolesV1 } : {}),
          ...(reportsTo !== undefined ? { reportsTo } : {}),
          ...(primaryTeamId !== undefined ? { primaryTeamId } : {}),
          ...(resolvedTeamCredentialBindings !== undefined
            ? { teamCredentialBindings: resolvedTeamCredentialBindings }
            : {}),
          machineId: executionTarget.machineId,
          backendTarget,
          sessionCreationTag,
          ...(replaySeededCreation ? { replaySeededCreation } : {}),
          ...(sourceContext ? { sourceContext } : {}),
          approvedNewDirectoryCreation: preparedTarget.directoryCreationRequired,
          ...(legacyMetadataLabel ? { legacyMetadataLabel } : {}),
          sessionCreationCorrespondence: correspondence,
          organizationPlacement: normalizedPlacement,
          ...(placementOrigin && placementOriginSupported ? { placementOrigin } : {}),
          ...(resolvedModelSelection ? { modelSelection: resolvedModelSelection } : {}),
          ...(profileId ? { profileId } : {}),
          ...(secretReferenceOverlay ? { secretReferenceOverlay } : {}),
          // Raw launch environment is deliberately absent from the
          // server-visible creation correspondence above; it reaches only this
          // direct-to-daemon spawn.
          ...(environmentVariables ? { environmentVariables } : {}),
          ...(resolvedPermissionMode ? { permissionMode: resolvedPermissionMode } : {}),
          ...(resolvedAgentModeId ? { agentModeId: resolvedAgentModeId } : {}),
          ...(normalizedConfigurationOverrides
            ? { sessionConfigOptionOverrides: normalizedConfigurationOverrides }
            : {}),
          ...(resolvedConnectedServices ? { connectedServices: resolvedConnectedServices } : {}),
          ...(resolvedConnectedServicesUpdatedAt !== undefined
            ? { connectedServicesUpdatedAt: resolvedConnectedServicesUpdatedAt }
            : {}),
          ...(mcpSelection ? { mcpSelection } : {}),
          ...(transcriptStorage ? { transcriptStorage } : {}),
          ...(spawnTerminal?.data ? { terminal: spawnTerminal.data } : {}),
          ...(windowsTerminal?.launchMode
            ? { windowsRemoteSessionLaunchMode: windowsTerminal.launchMode }
            : {}),
          ...(windowsTerminal?.console
            ? { windowsRemoteSessionConsole: windowsTerminal.console }
            : {}),
          ...(windowsTerminal?.windowName
            ? { windowsTerminalWindowName: windowsTerminal.windowName }
            : {}),
          ...(configurationSnapshot?.providerSessionResume
            ? { resume: configurationSnapshot.providerSessionResume.providerSessionId }
            : {}),
          ...(title ? { initialTitle: title } : {}),
          ...(identity !== undefined ? { identity } : {}),
          ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
          ...(promptStack !== undefined ? { promptStack } : {}),
          ...(initialInput ? { initialInput } : {}),
          ...(initialInput
            ? {
                buildInitialInputHandoff: (localId: string) => {
                  const admission = buildSessionSpawnInitialInputAdmissionForLocalIdV1({
                    actionCaller,
                    callerSurface,
                    localId,
                  });
                  const attachments = initialInput.attachments ?? [];
                  const authoredComposerAttachments = attachments.length > 0 && actionCaller.kind === 'plugin'
                    ? buildPluginSessionInputAttachmentDraftsV1({
                        pluginId: actionCaller.pluginId,
                        messageLocalId: localId,
                        authored: attachments,
                      })
                    : [];
                  const structuredInput = initialInput.structuredInput;
                  if (!structuredInput && authoredComposerAttachments.length === 0) {
                    return admission;
                  }
                  return {
                    ...admission,
                    meta: {
                      [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
                        ...(structuredInput ?? { v: 1 }),
                        ...(authoredComposerAttachments.length > 0
                          ? { composerAttachments: [
                              ...(structuredInput?.composerAttachments ?? []),
                              ...authoredComposerAttachments,
                            ] }
                          : {}),
                      },
                    },
                  };
                },
              }
            : {}),
          ...(params.machineAdmissionTransport
            ? { machineAdmissionTransport: params.machineAdmissionTransport }
            : {}),
          ...(directTargetTransport
            ? { directTransport: directTargetTransport.spawnedSession }
            : {}),
          ...(params.machineActionDirectTargetTransport?.machineId === executionTarget.machineId
            ? {
                machineActionTransport: params.machineActionDirectTargetTransport.invoke,
              }
            : {}),
          ...(agentSessionStartupInstructionsV1
            ? { agentSessionStartupInstructionsV1 }
            : {}),
          ...(spawnNonce ? { spawnNonce } : {}),
          ...(resumeActionRequest === true ? { resumeOnly: true } : {}),
          ...(signal ? { signal } : {}),
        });
        const committed: Extract<SessionSpawnNewResultV1, { type: 'success' }> = {
          type: 'success',
          disposition: created.disposition,
          sessionId: created.sessionId,
          executionTarget,
          organizationPlacement: created.organizationPlacement,
          initialInput: created.initialInput,
          ...(created.filesNotCopied ? { filesNotCopied: created.filesNotCopied } : {}),
        };
        if (!reportsTo) return committed;
        const preparation = await prepareSourceKeyAfterCommit({ effectActionId: 'session.spawn_new',
          sourceSessionId: created.sessionId, destinationSessionId: reportsTo.sessionId,
          ...(context ? { context } : {}), ...(signal ? { signal } : {}) });
        const projected = projectSessionFollowSourceKeyPreparationAfterSetV1({ source: committed }, preparation);
        return 'ok' in projected ? projected : committed;
      } catch (error) {
        // A proven pre-persistence failure creates no Session, but does not
        // establish that the checkout still has no other consumer.
        if (error instanceof PromptStackPreparationError) throw error;
        if ('failure' in initialTriggerPreparationState && initialTriggerPreparationState.failure === error) {
          const code = readRecord(error).code;
          if (signal?.aborted || code === 'cancelled') {
            return { type: 'error', code: 'cancelled', retryable: true };
          }
          if (isAuthenticationError(error) || code === 'permission_denied' || code === 'run_access_denied'
            || code === 'visible_team_not_granted') {
            return { type: 'error', code: 'permission_denied', retryable: false };
          }
          if (code === 'invalid_input') {
            return { type: 'error', code: 'invalid_input', retryable: false };
          }
          const policyRefusal = AgentStartRefusalV1Schema.safeParse({ code });
          if (policyRefusal.success && code !== 'target_unavailable' && code !== 'role_target_unavailable') {
            return { type: 'error', code: 'permission_denied', retryable: false };
          }
          if (code === 'source_unavailable' || code === 'content_unavailable' || code === 'target_unavailable'
            || code === 'role_target_unavailable' || code === 'feature_disabled'
            || code === 'account_settings_content_unavailable') {
            return { type: 'error', code: 'target_unavailable', retryable: false };
          }
          return { type: 'error', code: 'spawn_failed', retryable: true };
        }
        const details = readRecord(readRecord(error).details);
        const spawnErrorDetails = [readSessionCreationTerminalSpawnErrorDetail(error), details, details.errorDetail, readRecord(details.spawnResponse).errorDetail]
          .map(normalizeSpawnSessionErrorDetail);
        const initialTriggerRefusal = spawnErrorDetails.find(
          (detail) => detail?.kind === SPAWN_SESSION_ERROR_DETAIL_KINDS.SESSION_CREATION_INITIAL_TRIGGER_REFUSED,
        );
        // This typed witness proves no Session was born, even when caller
        // cancellation arrives with the response. Unknown outcomes retain checkout custody.
        if (initialTriggerRefusal?.kind === SPAWN_SESSION_ERROR_DETAIL_KINDS.SESSION_CREATION_INITIAL_TRIGGER_REFUSED) {
          return { type: 'error', code: initialTriggerRefusal.code === 'feature_disabled' ? 'target_unavailable' : initialTriggerRefusal.code, retryable: false };
        }
        const initialAccessFailure = projectSessionInitialAccessEnvelopeHostErrorResult(error);
        if (initialAccessFailure) return initialAccessFailure;
        const code = error && typeof error === 'object'
          && typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : '';
        if (isAuthenticationError(error)) {
          return { type: 'error', code: 'permission_denied', retryable: false };
        }
        if (hasSessionCreationOrganizationInvalidDetail(error)) {
          return { type: 'error', code: 'organization_invalid', retryable: false };
        }
        if (code === SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST) {
          return { type: 'error', code: 'invalid_input', retryable: false };
        }
        if (code === 'creation_conflict' || hasSessionCreationCorrespondenceConflictDetail(error)) {
          return { type: 'error', code: 'creation_conflict', retryable: false };
        }
        if (
          code === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
          || code === 'MACHINE_RPC_TIMEOUT'
        ) {
          return {
            type: 'pending',
            retryWithSameCreationKey: true,
            outcome: 'unknown',
          };
        }
        if (signal?.aborted) {
          return { type: 'error', code: 'cancelled', retryable: true };
        }
        if (code === SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE) {
          return { type: 'error', code: 'incompatible_target', retryable: false };
        }
        for (const detail of spawnErrorDetails) {
          if (detail?.kind === SPAWN_SESSION_ERROR_DETAIL_KINDS.TERMINAL_HOST_UNAVAILABLE) {
            return { type: 'error', code: 'incompatible_target', retryable: false, terminalHostError: detail };
          }
          if (detail?.kind === SPAWN_SESSION_ERROR_DETAIL_KINDS.SESSION_CREATION_ACCESS_REFUSED) {
            return { type: 'error', code: detail.code, retryable: false };
          }
          if (detail?.kind === 'update_required') {
            return { type: 'error', code: 'update_required', retryable: false, details: detail };
          }
          if (detail?.kind === SPAWN_SESSION_ERROR_DETAIL_KINDS.PROVIDER_ERROR) {
            return {
              type: 'error', code: 'spawn_failed',
              retryable: detail.providerError.retryable,
              providerError: detail.providerError,
            };
          }
        }
        const normalizedFailure = normalizeSpawnSessionNonceResolution({
          status: 'error', errorCode: code, errorMessage: readRecord(error).message,
          agentId: details.agentId ?? readRecord(details.spawnResponse).agentId,
        });
        if (normalizedFailure.status === 'error' && normalizedFailure.agentId
          && (normalizedFailure.errorCode === SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING
            || normalizedFailure.errorCode === SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT)) {
          return { type: 'error', code: normalizedFailure.errorCode,
            agentId: normalizedFailure.agentId, retryable: false };
        }
        return { type: 'error', code: 'spawn_failed', retryable: true };
      }
    },
    ...(approvalsStore ?? {}),
    ...inventoryDeps,
    projectsVisibilitySet: async (input, context) => {
      if (projectAccountAdmission(input.target.serverId, context)) {
        return { ok: false, errorCode: 'project_visibility_access_denied' };
      }
      const accountId = context?.externalActionExecutionAuthorization?.binding.accountId ?? homeAccountId;
      if (!accountId) return { ok: false, errorCode: 'project_visibility_access_denied' };
      return runWithServerHttpBaseUrl(todoHomeBaseUrl, () => setProjectVisibilityV1({
        accountScope: () => params.serverId === undefined && configuration.activeServerId !== todoHomeServerId
          ? null : { serverId: todoHomeServerId, accountId },
        mutateOrganization: mutation => mutateProjectAccountOrganization({ ...mutation,
          ...projectRowsAuthority(context, 'projects.visibility.set', mutation.signal), serverId: mutation.serverId }),
      }, input, context));
    },
    projectsList: async (args, context) => {
      const refused = projectAccountAdmission(args.serverId, context);
      if (refused) return refused;
      if ((args.serverId !== undefined && args.serverId !== todoHomeServerId)
        || (context?.serverId && context.serverId !== todoHomeServerId)
        || (params.serverId === undefined && configuration.activeServerId !== todoHomeServerId)) {
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      }
      return runWithServerHttpBaseUrl(todoHomeBaseUrl, async () => {
        const authority = projectRowsAuthority(context, 'projects.list', context?.signal);
        const snapshot = await readProjectAccountRows(authority);
        const recency = await readProjectLastOpenedMemoryMap(authority);
        const workspaceRefs = snapshot.workspaceRefs.map(ref => {
          const lastOpenedAtMs = recency.get(buildProjectLastOpenedMemoryKeyV1({ serverId: ref.serverId, projectKey: ref.projectKey ?? ref.id }));
          return lastOpenedAtMs === undefined ? ref : { ...ref, lastOpenedAtMs };
        });
        const projected = projectProjectListV1({ ...args, serverId: todoHomeServerId,
          workspaceRefs, organizations: snapshot.organizations, coverage: 'complete' });
        let machines: Awaited<ReturnType<typeof listCurrentAccountMachines>> | null;
        try { machines = await listCurrentAccountMachines({ ...(authority.authorization
          ? { authorization: authority.authorization, effectActionId: authority.effectActionId }
          : { token: authority.credentials.token }), serverHttpBaseUrl: todoHomeBaseUrl, signal: context?.signal }); }
        catch { context?.signal?.throwIfAborted(); machines = null; }
        await assertProjectRequesterCurrent(context);
        const items = projected.items.map(({ ref, ...item }) => {
          const machine = machines?.find(candidate => candidate.id === ref.machineId);
          return { ...item, serverId: ref.serverId, machineId: ref.machineId, rootPath: ref.rootPath,
            ...(ref.label ? { label: ref.label } : {}),
            reachable: machines === null ? null : Boolean(machine?.active && machine.revokedAt === null && machine.replacedByMachineId === null),
            ...(ref.repositoryIdentity ? { forge: ref.repositoryIdentity } : {}), worktrees: [] };
        });
        return { items, truncated: projected.truncated, coverage: projected.coverage };
      });
    },
    projectWorkerAction: async (args) => {
      const { actionId, input, context, signal } = args;
      if (actionId !== 'projects.worker.status' && actionId !== 'projects.worker.copy.retire') {
        return params.projectWorkerAccountAction ? await params.projectWorkerAccountAction(args)
          : { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      }
      const request = ProjectWorkerActionInputSchemasV1[actionId].parse(input);
      const machineId = 'destination' in request ? request.destination.machineId : request.machineId;
      if (!isMachineActionServerScopeCurrent(request.workspace.serverId) || !isMachineActionServerScopeCurrent(context.serverId)) {
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      }
      if (context.externalActionTarget && (context.externalActionTarget.kind !== 'machine'
        || context.externalActionTarget.machineId !== machineId)) {
        return { ok: false, errorCode: 'target_not_local', error: 'target_not_local' };
      }
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      signal?.throwIfAborted();
      const spec = getActionSpec(actionId);
      const method = spec.bindings?.rpcMethod;
      if (!method) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      const call = () => callMachineAction({ machineId, serverId: request.workspace.serverId, method,
        request, authority: context.authority, exactMachine: true, context, effectActionId: actionId,
        ...(signal ? { signal } : {}) });
      const raw = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, call) : call());
      // Cancellation retires a read, not an already received write acknowledgement.
      if (actionId === 'projects.worker.status') signal?.throwIfAborted();
      const failure = ActionExecuteFailureSchema.safeParse(raw);
      if (failure.success) return failure.data;
      const deferred = ActionApprovalRequestCreatedResultSchema.safeParse(raw);
      if (deferred.success && deferred.data.actionId === actionId) return deferred.data;
      const output = ProjectWorkerActionOutputSchemasV1[actionId].safeParse(raw);
      if (!output.success || ('candidate' in output.data && output.data.eligible
        && (output.data.candidate.serverId !== request.workspace.serverId || output.data.candidate.machineId !== machineId))) {
        const errorCode = actionId === 'projects.worker.copy.retire' ? 'outcome_unknown' : 'invalid_action_output';
        return { ok: false, errorCode, error: errorCode };
      }
      return output.data;
    },
    projectDefinitionAction: params.projectDefinitionAction ?? (async ({ actionId, input, context }) => {
      const parsed = PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS[actionId].safeParse(input);
      if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      const workspace = parsed.data.workspace;
      if (!isMachineActionServerScopeCurrent(workspace.serverId) || !isMachineActionServerScopeCurrent(context.serverId)) {
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      }
      if (context.externalActionTarget && (context.externalActionTarget.kind !== 'machine'
        || context.externalActionTarget.machineId !== workspace.machineId)) {
        return { ok: false, errorCode: 'target_not_local', error: 'target_not_local' };
      }
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== workspace.machineId) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      context.signal?.throwIfAborted();
      const call = () => callMachineAction({ machineId: workspace.machineId, serverId: workspace.serverId,
        method: getActionSpec(actionId).bindings!.rpcMethod!, request: parsed.data, authority: context.authority,
        exactMachine: true, context, effectActionId: actionId, timeoutMs: null,
        ...(context.signal ? { signal: context.signal } : {}) });
      const raw = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, call) : call());
      context.signal?.throwIfAborted();
      const failure = ActionExecuteFailureSchema.safeParse(raw);
      if (failure.success) return failure.data;
      const deferred = ActionApprovalRequestCreatedResultSchema.safeParse(raw);
      if (deferred.success && deferred.data.actionId === actionId) return deferred.data;
      const output = PROJECT_DEFINITION_ACTION_OUTPUT_SCHEMAS[actionId].safeParse(raw);
      return output.success ? output.data : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    }),
    machineWorkSummaryGet: async ({ input, context, signal }) => {
      if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const read = () => callMachineAction({ machineId: input.machineId, serverId: input.serverId,
        method: RPC_METHODS.MACHINES_WORK_SUMMARY_GET, request: input, authority: context.authority,
        context, effectActionId: 'machines.work.summary.get', exactMachine: true, ...(signal ? { signal } : {}) });
      return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, read) : read());
    },
    usageSourceAction: createUsageSourceActionPort({
      assertCurrent: context => {
        context.signal?.throwIfAborted();
        if (context.serverId && context.serverId !== projectHomeId) throw Object.assign(new Error('server_target_mismatch'), { code: 'server_target_mismatch' });
      },
      rpc: async (request, context) => {
        if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        const call = () => callMachineAction({ machineId: request.input.machineId, serverId: request.input.serverId,
          method: request.actionId, request: request.input, authority: context.authority, authorization: context.rpcSessionAuthorization,
          context, effectActionId: request.actionId, exactMachine: true, ...(context.signal ? { signal: context.signal } : {}) });
        return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, call) : call());
      },
    }),
    projectsOpen: async (input, context) => {
      const { OpenProjectResultV1Schema } = await import('@happier-dev/protocol/projects/openProjectV1');
      const open = async () => OpenProjectResultV1Schema.parse(await callMachineAction({
        machineId: input.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.PROJECTS_OPEN,
        request: input,
        authority: context.authority,
        context,
        effectActionId: 'projects.open',
        exactMachine: true,
        timeoutMs: null,
        ...(context.signal ? { signal: context.signal } : {}),
      }));
      try { return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, open) : open()); }
      catch (error) {
        if (readRpcRequestDisposition(error) === 'notSent') return { kind: 'refused', code: 'machine_unreachable' };
        throw error;
      }
    },
    filesystemActionExecute: async ({ actionId, input, context }) => {
      const custodyFailure = resolveFilesystemTransferCustodyFailure(actionId, context);
      if (custodyFailure) return custodyFailure;
      const target = context.externalActionTarget;
      if (target?.kind !== 'machine' || !target.machineId) {
        return { ok: false, errorCode: 'machine_not_selected', error: 'machine_not_selected' };
      }
      const machineId = target.machineId;
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      if (!isMachineActionServerScopeCurrent(context.serverId)) {
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      }
      const method = getActionSpec(actionId).bindings?.rpcMethod;
      if (!method) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      // Semantic RPCs re-enter the daemon's canonical Action admission owner.
      // Preserve signed requester provenance and the exact captured target/root.
      const preparedCopy = actionId === 'daemon.filesystem.copy'
        && readRecord(input).kind === 'prepared_transfer';
      const execute = () => callMachineAction({
        machineId, serverId: context.serverId, method, request: input, authority: context.authority,
        context, effectActionId: actionId, exactMachine: true,
        ...(actionId === 'daemon.filesystem.upload' || actionId === 'daemon.filesystem.download' || preparedCopy
          ? { timeoutMs: null } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const result = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, execute) : execute());
      return isRpcMethodNotFoundResult(result) && !('success' in result)
        ? { ok: false, errorCode: result.errorCode ?? RPC_ERROR_CODES.METHOD_NOT_FOUND, error: result.error }
        : result;
    },
    workspaceFilesSearch: async ({ machineId, ...request }, context) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'workspace_file_search_unavailable', error: 'An authenticated machine transport is required.' };
      }
      try {
        const search = async () => DaemonWorkspaceFileSearchResponseSchema.parse(await callMachineAction({
          machineId, serverId: context.serverId ?? undefined, method: RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH, request,
          ...(context.signal ? { signal: context.signal } : {}),
        }));
        return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, search) : search());
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'server_scope_mismatch') {
          return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
        }
        throw error;
      }
    },
    machinesAgentsList: async (args, context) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== args.machineId) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      try {
        const readInventory = async () => {
          const roster = DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(await callMachineAction({
            machineId: args.machineId,
            serverId: args.serverId,
            method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            request: { machineId: args.machineId, selection: 'agents' },
            ...(context.signal ? { signal: context.signal } : {}),
          }));
          if (!roster.success) throw new MachineAgentInventoryUnavailableError(args.agentId ?? 'unknown');
          const agents = buildMachineAgentInventoryDescriptors(roster.data.projection)
            .filter(({ agentId }) => !args.agentId || args.agentId === agentId);
          if (agents.length === 0) return { items: [] };
          const response = await callMachineAction({
            machineId: args.machineId,
            serverId: args.serverId,
            method: RPC_METHODS.CAPABILITIES_DETECT,
            request: buildMachineAgentsDetectRequest({ agents, refresh: args.refresh }),
            ...(context.signal ? { signal: context.signal } : {}),
          });
          return projectMachineAgentsDetectResponse({ agents, response });
        };
        return await (params.serverHttpBaseUrl
          ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, readInventory)
          : readInventory());
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'server_scope_mismatch') {
          return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
        }
        if (error instanceof MachineAgentInventoryUnavailableError) {
          return { ok: false, errorCode: error.code, error: error.message };
        }
        throw error;
      }
    },
    machineAgentSignInStart: async ({ machineId, signal, serverId, ...request }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'sign_in_unavailable', error: 'An authenticated machine transport is required.' };
      }
      return startMachineAgentSignIn({ ...request, machineId }, signInOperations({ machineId, serverId, signal }));
    },
    machineAgentSignInStatus: async ({ machineId, signal, serverId, agentId }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        throw Object.assign(new Error('An authenticated machine transport is required.'), { code: 'sign_in_unavailable' });
      }
      return AgentSignInStatusResponseSchema.parse(await callMachineAction({
        machineId, serverId, method: AGENT_SIGN_IN_STATUS_RPC_METHOD, request: { agentId }, signal,
      }));
    },
    machineAgentSignInCancel: async ({ machineId, serverId, signal, ...request }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'sign_in_unavailable', error: 'An authenticated machine transport is required.' };
      }
      return await cancelMachineAgentSignIn({ ...request, machineId }, signInOperations({ machineId, serverId, signal }));
    },
    machineAgentSignInRestart: async ({ machineId, serverId, signal, ...request }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'sign_in_unavailable', error: 'An authenticated machine transport is required.' };
      }
      return await restartMachineAgentSignIn({ ...request, machineId }, signInOperations({ machineId, serverId, signal }));
    },
    actionOperationAction: async ({ actionId, input, context, signal }) => executeActionOperationActionV1({
      actionId, input, ...(signal ? { signal } : {}),
      transport: async ({ serverId, machineId, method, payload, signal: requestSignal }) => {
        if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
          return { ok: false, errorCode: 'operation_transport_unavailable', error: 'An authenticated machine transport is required.' };
        }
        return await callMachineAction({ serverId, machineId, method, request: payload,
          authority: context.authority, exactMachine: true, ...(requestSignal ? { signal: requestSignal } : {}),
          ...(actionId === 'action.operations.get' && 'waitForTerminal' in input && input.waitForTerminal
            ? { timeoutMs: null } : {}),
        });
      },
    }),
    machineTerminalAction: async ({ actionId, input, context, signal }) => {
      const { machineId, serverId, ...request } = input;
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'terminal_transport_unavailable', error: 'An authenticated machine transport is required.' };
      }
      const spec = getActionSpec(actionId);
      const method = spec.bindings?.rpcMethod;
      if (!method) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      try {
        return spec.outputSchema.parse(await callMachineAction({
          machineId, serverId, method, request, context, effectActionId: actionId,
          authority: context.authority, exactMachine: true,
          ...(signal ? { signal } : {}),
        }));
      } catch (error) {
        if (actionId === 'machines.terminal.list' && isRpcMethodNotAvailableError(error)) return null;
        throw error;
      }
    },
    machineAgentInstallStart: async ({ machineId, signal, serverId, ...request }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'install_unavailable', error: 'An authenticated machine transport is required.' };
      }
      return DaemonAgentInstallStartResponseSchema.parse(await callMachineAction({
        machineId, serverId, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_START, request,
        ...(signal ? { signal } : {}),
      }));
    },
    machineAgentInstallRead: async ({ machineId, signal, serverId, ...request }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'install_unavailable', error: 'An authenticated machine transport is required.' };
      }
      return DaemonAgentInstallReadResponseSchema.parse(await callMachineAction({
        machineId, serverId, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_READ, request,
        ...(signal ? { signal } : {}),
      }));
    },
    machineAgentInstallCancel: async ({ machineId, signal, serverId, ...request }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'install_unavailable', error: 'An authenticated machine transport is required.' };
      }
      return DaemonAgentInstallCancelResponseSchema.parse(await callMachineAction({
        machineId, serverId, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL, request,
        ...(signal ? { signal } : {}),
      }));
    },
    sessionSendMessage: async ({
      callerInputConstraints,
      context,
      sessionId,
      message,
      recipient,
      displayText,
      messageMeta,
      requestedAction,
      actionCaller,
      idempotencyKey,
      localId,
      source,
      attachments,
      wait,
      timeoutSeconds,
      permissionModeOverride,
      modelOverride,
      providerConnectionId,
      sessionInputSource,
      callerSurface,
      signal,
    }) => {
      const pluginCaller = actionCaller?.kind === 'plugin' ? actionCaller : null;
      if (callerInputConstraints && typeof permissionModeOverride === 'string' && permissionModeOverride.trim()) {
        const requestedMode = SESSION_PERMISSION_MODES.find((mode) => mode === permissionModeOverride.trim());
        if (!requestedMode || !isPermissionModeGrantedV1(callerInputConstraints, requestedMode)) {
          return { status: 'rejected' as const, code: 'session_input_invalid' as const };
        }
      }
      if (pluginCaller && typeof permissionModeOverride === 'string' && permissionModeOverride.trim().length > 0) {
        return {
          status: 'rejected' as const,
          code: 'session_input_invalid' as const,
        };
      }
      if (!params.credentials) {
        return pluginCaller
          ? { status: 'rejected' as const, code: 'session_input_unauthorized' as const }
          : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }

      const normalizedWait = typeof wait === 'boolean' ? wait : false;
      const normalizedTimeoutSeconds =
        typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
          ? Math.min(3600, timeoutSeconds)
          : 300;
      const normalizedPermissionModeOverride = typeof permissionModeOverride === 'string' && permissionModeOverride.trim().length > 0
        ? permissionModeOverride.trim()
        : undefined;
      const normalizedProviderConnectionId = providerConnectionId === null
        ? null
        : providerConnectionId === undefined
          ? undefined
          : ProviderConnectionIdSchema.parse(providerConnectionId);
      const normalizedModelOverride = modelOverride === null
        ? null
        : typeof modelOverride === 'string' && modelOverride.trim().length > 0
          ? modelOverride.trim()
          : undefined;
      if (normalizedProviderConnectionId !== undefined
        && normalizedProviderConnectionId !== null
        && (normalizedModelOverride === undefined || normalizedModelOverride === null)) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      // `--model default` (and its canonical `modelOverride: null` binding) is
      // the Agent-native reset, not a model named `default`. The structured
      // per-message ref cannot carry a reset — the canonical selection owner
      // rejects a native `default` ref outright — so the same owner's
      // native-automatic predicate decides which of the two existing carriers
      // this send uses, instead of the reset being re-derived here as a
      // provider-bound literal a provider never published.
      const nativeModelReset = normalizedModelOverride !== undefined
        && isNativeAutomaticModelSelectionInputV1({
          providerConnectionId: normalizedProviderConnectionId ?? null,
          modelId: normalizedModelOverride,
        });
      const modelSelectionInput = normalizedModelOverride === undefined || nativeModelReset
        ? undefined
        : {
            ...(normalizedProviderConnectionId !== undefined
              ? { providerConnectionId: normalizedProviderConnectionId }
              : {}),
            modelId: normalizedModelOverride,
          };

      const externalActionRequest = context?.externalActionCredential !== undefined
        || context?.externalActionExecutionAuthorization !== undefined;
      const resolveAuthorizationHeaders = externalActionRequest
        ? (request: Readonly<{ method: string; path: string; body?: unknown }>) =>
            resolveServerRequestHeaders(context, 'session.message.send', request)
        : undefined;
      if (resolveAuthorizationHeaders && !resolveAuthorizationHeaders({
          method: 'GET',
          path: '/v1/account/encryption/currentness',
        })) {
        return {
          status: 'rejected' as const,
          code: 'session_input_unauthorized' as const,
        };
      }

      if (
        pluginCaller
        && (
          typeof pluginCaller.contributionLocalId !== 'string'
          || typeof idempotencyKey !== 'string'
        )
      ) {
        return {
          status: 'rejected' as const,
          code: 'session_input_untrusted_assertion' as const,
        };
      }
      const pluginLocalId = pluginCaller
        ? derivePluginSessionInputLocalIdV1({
            caller: pluginCaller,
            sessionId,
            idempotencyKey: idempotencyKey!,
          })
        : undefined;
      const pluginInputAdmission = pluginCaller
        ? buildPluginSessionInputAdmissionV1({
            caller: pluginCaller,
            surface: callerSurface,
            ...(source ? { source } : {}),
          })
        : undefined;
      const turnDepth = sessionInputSource ? params.getCurrentTurnWorkDepth?.(sessionInputSource.sourceTurnId) : undefined;
      const starterDepth = sessionInputSource ? params.getCurrentSessionWorkDepth?.() : undefined;
      if (sessionInputSource && (turnDepth === undefined || starterDepth === undefined)) {
        return { status: 'rejected' as const, code: 'session_input_untrusted_assertion' as const };
      }
      // A user turn resets turn depth to zero, but cannot reset the Session or
      // background Run's immutable starter depth when it sends to another Session.
      const callerDepth = turnDepth !== undefined && starterDepth !== undefined
        ? readAgentStartCallerWorkDepthV1({ kind: 'session', sessionId: params.sessionId, starterDepth, turnDepth })
        : undefined;
      const causalSessionInputAdmission = sessionInputSource && callerDepth !== undefined
        ? buildCausalSessionInputAdmissionV1({ ...sessionInputSource, callerDepth })
        : undefined;

      const authoredMessageText = String(message ?? '');

      // Declared attachments reach the canonical structured-input admission
      // owner before the Session writer, exactly as a Composer-authored draft
      // does. A retry first consults the durable Pending/transcript owner: the
      // plugin preparation callback is not an idempotent boundary and must not
      // run again after an outcome-unknown write.
      let admittedAttachmentMeta: Record<string, unknown> | undefined;
      let admittedComposerAttachments: readonly ComposerAttachmentInputV1[] = [];
      let admittedMessageText = authoredMessageText;
      let rejoinedMessageMeta: Record<string, unknown> | undefined;
      const composerAttachmentRegistry = params.resolveComposerAttachmentSendPreparation?.() ?? null;
      if (attachments && attachments.length > 0) {
        if (!pluginCaller || !pluginLocalId) {
          return {
            status: 'rejected' as const,
            code: 'session_input_untrusted_assertion' as const,
          };
        }
        const transport = await resolveTransportForSession(sessionId);
        if (!transport.ok) {
          return {
            status: 'rejected' as const,
            code: 'session_input_target_unavailable' as const,
          };
        }
        const rawAttachmentMeta = {
          [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
            v: 1 as const,
            composerAttachments: buildPluginSessionInputAttachmentDraftsV1({
              pluginId: pluginCaller.pluginId,
              messageLocalId: pluginLocalId,
              authored: attachments,
            }),
          },
        };
        let persisted: Awaited<ReturnType<typeof findPersistedSessionUserMessageAdmission>>;
        try {
          persisted = await findPersistedSessionUserMessageAdmission({
            token: params.credentials.token,
            sessionId: transport.sessionId,
            localId: pluginLocalId,
            queryContext: transport.mode === 'plain'
              ? { encryptionMode: 'plain' }
              : {
                  encryptionMode: 'e2ee',
                  encryptionKey: transport.ctx.encryptionKey,
                  encryptionVariant: transport.ctx.encryptionVariant,
                },
          });
        } catch {
          return {
            status: 'outcomeUnknown' as const,
            localId: pluginLocalId,
            code: 'session_input_rejoin_unavailable',
          };
        }
        if (persisted) {
          try {
            validateComposerAttachmentRejoinCorrespondenceV1({
              meta: rawAttachmentMeta,
              preparedComposerAttachments: persisted.composerAttachments,
            });
          } catch {
            return {
              status: 'rejected' as const,
              code: 'session_input_idempotency_conflict' as const,
            };
          }
          admittedMessageText = persisted.text;
          rejoinedMessageMeta = persisted.meta;
          admittedComposerAttachments = persisted.composerAttachments;
        } else {
          const attachmentAdmission = await admitPluginSessionInputAttachmentsV1({
            attachments: composerAttachmentRegistry,
            pluginId: pluginCaller.pluginId,
            sessionId: transport.sessionId,
            messageLocalId: pluginLocalId,
            text: authoredMessageText,
            authored: attachments,
            ...(signal ? { signal } : {}),
          });
          if (attachmentAdmission.status === 'rejected') {
            return { status: 'rejected' as const, code: attachmentAdmission.code };
          }
          admittedAttachmentMeta = attachmentAdmission.meta;
          admittedComposerAttachments = attachmentAdmission.attachments;
        }
      }

      const dispatchMessageHook = async (canonicalSessionId: string, source: 'plugin' | 'user') => {
        try {
          await dispatchSessionLifecycleHookEvent({
            eventId: 'session.message.send',
            happySessionId: canonicalSessionId,
            payload: {
              sessionId: canonicalSessionId,
              text: admittedMessageText,
              source,
            },
          });
        } catch {
          // Hook dispatch is best-effort so a misbehaving plugin cannot break message send.
        }
      };

      // Both admissions resolve the Session again inside the send service, so
      // the exact Home's feature snapshot this dependency is already bound to
      // must travel with them; without it that second resolution decides
      // `sharing.session` for a Home it never observed.
      const sendServerFeaturesSnapshot = await readServerFeaturesSnapshot();
      const sendModelSelection = {
        ...(sendServerFeaturesSnapshot ? { serverFeaturesSnapshot: sendServerFeaturesSnapshot } : {}),
        ...(modelSelectionInput
          ? { modelSelectionInput }
          : nativeModelReset
            ? { modelOverride: null }
            : {}),
      } as const;

      const protectedInputAdmission = pluginInputAdmission ?? causalSessionInputAdmission;
      if (protectedInputAdmission) {
        const protectedResult = await sendSessionMessage({
          ...(context?.externalActionExecutionAuthorization ? { callerInputAuthorization: context.externalActionExecutionAuthorization } : {}),
          credentials: params.credentials,
          idOrPrefix: sessionId,
          message: admittedMessageText,
          ...(recipient ? { recipient } : {}),
          requestedAction,
          wait: normalizedWait,
          timeoutMs: normalizedTimeoutSeconds * 1000,
          ...(pluginLocalId
            ? { localId: pluginLocalId }
            : typeof localId === 'string' && localId.trim().length > 0
              ? { localId }
              : {}),
          inputAdmission: protectedInputAdmission,
          ...(rejoinedMessageMeta
            ? { messageMeta: rejoinedMessageMeta }
            : (admittedAttachmentMeta || messageMeta || displayText)
            ? {
                messageMeta: {
                  ...(messageMeta ?? {}),
                  ...(admittedAttachmentMeta ?? {}),
                  ...(displayText ? { displayText } : {}),
                },
              }
            : {}),
          ...(params.machineAdmissionTransport
            ? { machineAdmissionTransport: params.machineAdmissionTransport }
            : {}),
          ...(resolveAuthorizationHeaders ? { resolveAuthorizationHeaders } : {}),
          ...(params.machineActionDirectTargetTransport
            ? { machineResumeTransport: params.machineActionDirectTargetTransport.invoke }
            : {}),
          ...sendModelSelection,
          ...(signal ? { signal } : {}),
        });
        if (!protectedResult.ok && protectedResult.code === 'machine_admission_transport_unavailable') {
          return {
            ok: false,
            errorCode: protectedResult.code,
            error: protectedResult.message ?? protectedResult.code,
          };
        }
        const admissionResult = projectSessionMessageSendActionResult(protectedResult);
        if (!admissionResult) {
          return { status: 'rejected' as const, code: 'session_input_target_unavailable' as const };
        }
        if (!protectedResult.ok) return admissionResult;
        const canonicalSessionId = typeof protectedResult.sessionId === 'string'
          && protectedResult.sessionId.trim().length > 0
          ? protectedResult.sessionId
          : sessionId;
        if (
          composerAttachmentRegistry
          && (admissionResult.status === 'accepted' || admissionResult.status === 'alreadyAccepted')
        ) {
          notifyComposerAttachmentsAfterMessageAccepted({
            sessionId: canonicalSessionId,
            localId: admissionResult.localId,
            attachments: admittedComposerAttachments,
            notify: ({ attachment, event, signal: notificationSignal }) => (
              composerAttachmentRegistry.afterMessageAccepted({
                attachment,
                event,
                signal: notificationSignal,
              })
            ),
            signal: signal ?? new AbortController().signal,
          });
        }
        await dispatchMessageHook(canonicalSessionId, pluginCaller ? 'plugin' : 'user');
        return admissionResult;
      }

      const executionRunLocalId = recipient?.kind === 'execution_run'
        ? (typeof localId === 'string' && localId.trim().length > 0 ? localId : randomUUID())
        : undefined;
      const result = await sendSessionMessage({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        message: String(message ?? ''),
        ...(recipient ? { recipient } : {}),
        ...(messageMeta || displayText ? {
          messageMeta: { ...(messageMeta ?? {}), ...(displayText ? { displayText } : {}) },
        } : {}),
        requestedAction,
        wait: normalizedWait,
        timeoutMs: normalizedTimeoutSeconds * 1000,
        // A caller-retained localId makes an ambiguous send retryable: the
        // durable pending queue is keyed by it, so resubmitting rejoins the
        // existing input instead of enqueuing a second message.
        ...(executionRunLocalId
          ? { localId: executionRunLocalId }
          : typeof localId === 'string' && localId.trim().length > 0
            ? { localId }
            : {}),
        ...(normalizedPermissionModeOverride ? { permissionModeOverride: normalizedPermissionModeOverride } : {}),
        ...sendModelSelection,
        ...(resolveAuthorizationHeaders ? { resolveAuthorizationHeaders } : {}),
        ...(params.machineActionDirectTargetTransport
          ? { machineResumeTransport: params.machineActionDirectTargetTransport.invoke }
          : {}),
        ...(signal ? { signal } : {}),
      });
      const admissionResult = projectSessionMessageSendActionResult(result);
      if (!result.ok) {
        if (admissionResult) return admissionResult;
        return {
          ok: false,
          errorCode: result.code,
          error: result.code,
          ...(result.candidates ? { candidates: result.candidates } : {}),
          ...(result.message ? { message: result.message } : {}),
          ...(result.providerError ? { details: result.providerError } : {}),
        };
      }
      const canonicalSessionId = typeof result.sessionId === 'string' && result.sessionId.trim().length > 0
        ? result.sessionId
        : sessionId;
      await dispatchMessageHook(canonicalSessionId, 'user');
      // A successful send always projects an accepted admission from its
      // resolved local id, even for the legacy unprotected writer response.
      if (!admissionResult) throw new Error('Successful Session send is missing its admission projection');
      return admissionResult;
    },

    sessionStop: async ({ sessionId }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      return await requestSessionStop({ credentials: params.credentials, idOrPrefix: sessionId });
    },

    sessionWorkerPublish: async ({ context, ...input }) => {
      const caller = params.getAgentStartRunCaller?.();
      if (caller && 'runId' in caller) {
        return { ok: false, errorCode: 'session_worker_run_step_requires_publish_draft', error: 'session_worker_run_step_requires_publish_draft' };
      }
      if (!params.publishWorkerReport) return { ok: false, errorCode: 'session_worker_publisher_unavailable', error: 'session_worker_publisher_unavailable' };
      const read = () => fetchSessionById({
        token: params.token, sessionId: params.sessionId,
        ...(context.signal ? { signal: context.signal } : {}),
        resolveAuthorizationHeaders: (request) => resolveServerRequestHeaders(context, 'session.worker.publish', request),
      });
      const current = params.serverHttpBaseUrl ? await runWithServerHttpBaseUrl(params.serverHttpBaseUrl, read) : await read();
      if (current?.origin?.kind === 'run_step') return { ok: false, errorCode: 'session_worker_run_step_requires_publish_draft', error: 'session_worker_run_step_requires_publish_draft' };
      const leadSessionId = current?.reportsTo?.sessionId;
      if (!leadSessionId) return { ok: false, errorCode: 'session_worker_requires_reports_to', error: 'session_worker_requires_reports_to' };
      const report = SessionWorkerPublishInputV1Schema.safeParse(input);
      if (!report.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      if (!workerDeliverablesBelongToSessionV1(report.data.deliverables, params.sessionId)) {
        return { ok: false, errorCode: 'session_worker_deliverable_scope_mismatch', error: 'session_worker_deliverable_scope_mismatch' };
      }
      const committed = await params.publishWorkerReport(report.data);
      if (!committed.persisted || !committed.localId) return { ok: false, errorCode: 'session_worker_report_not_committed', error: 'session_worker_report_not_committed' };
      return { sessionId: params.sessionId, leadSessionId, localId: committed.localId };
    },

    sessionReportsToSet: async ({ context, sessionId, leadSessionId, expectedLeadSessionId, serverId, signal }) => {
      const credentials = params.credentials;
      if (!credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      if (params.serverId !== undefined && serverId != null && params.serverId !== serverId) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      const mutate = () => setSessionReportsTo({
        token: credentials.token, sessionId, leadSessionId, expectedLeadSessionId,
        ...(signal ? { signal } : {}),
        resolveAuthorizationHeaders: (request) => resolveServerRequestHeaders(context, 'session.reports_to.set', request),
      });
      const committed = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, mutate) : mutate());
      if (!committed.ok || leadSessionId === null) return committed;
      const preparation = await prepareSourceKeyAfterCommit({ effectActionId: 'session.reports_to.set',
        sourceSessionId: sessionId, destinationSessionId: leadSessionId, context, ...(signal ? { signal } : {}) });
      const projected = projectSessionFollowSourceKeyPreparationAfterSetV1({ source: committed }, preparation);
      return 'ok' in projected ? projected : committed;
    },

    sessionOrganizationPinSet: async ({ context, sessionId, request, serverId, signal }) => {
      const credentials = params.credentials;
      if (!credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      if (params.serverId !== undefined && serverId != null && params.serverId !== serverId) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      const mutate = async () => {
        signal?.throwIfAborted();
        if (request.pinned && request.surface === 'rail') {
          // Re-read on every addition: a cached transport could retain a demoted Bot marker.
          const serverFeaturesSnapshot = await readServerFeaturesSnapshot();
          const transport = await resolveSessionTransportContext({ credentials, idOrPrefix: sessionId,
            resolveAuthorizationHeaders: (httpRequest) => resolveServerRequestHeaders(context, 'session.organization.pin.set', httpRequest),
            ...(signal ? { signal } : {}),
            ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
          });
          if (!transport.ok) return { ok: false, errorCode: transport.code, error: transport.code };
          const metadata = tryDecryptSessionMetadata({ credentials, rawSession: transport.rawSession });
          if (!metadata) return { ok: false, errorCode: 'session_metadata_unavailable', error: 'session_metadata_unavailable' };
          if (!readSessionBotV1(metadata.bot)) return { ok: false, errorCode: 'session_not_bot', error: 'session_not_bot' };
        }
        signal?.throwIfAborted();
        return await setSessionOrganizationPin({ token: credentials.token, sessionId, request,
          ...(signal ? { signal } : {}),
          resolveAuthorizationHeaders: (httpRequest) => resolveServerRequestHeaders(context, 'session.organization.pin.set', httpRequest),
        });
      };
      return params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, mutate) : mutate();
    },

    sessionAttentionSet: async ({ context, sessionId, request, serverId, signal }) => {
      if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      if (params.serverId !== undefined && serverId != null && params.serverId !== serverId) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      const credentials = params.credentials;
      const mutate = () => setSessionAttentionStanding({
        token: credentials.token, sessionId, request,
        ...(signal ? { signal } : {}),
        resolveAuthorizationHeaders: (httpRequest) => resolveServerRequestHeaders(context, 'session.attention.set', httpRequest),
      });
      return params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, mutate) : mutate();
    },

    sessionApprovalReviewerSet: async ({ context, sessionId, enabled, serverId }) => {
      const credentials = params.credentials;
      if (!credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      if (params.serverId !== undefined && serverId != null && params.serverId !== serverId) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      const mutate = () => updateSessionMetadataForTarget({
        credentials, idOrPrefix: sessionId,
        resolveAuthorizationHeaders: (request) => resolveServerRequestHeaders(context, 'session.approval_reviewer.set', request),
        updater: (metadata) => ({ ...metadata, approvalReviewerEnabled: enabled }),
      });
      const result = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, mutate) : mutate());
      return result.ok ? { updated: true } : { ok: false, errorCode: result.code, error: result.code };
    },

    sessionStateFieldSet: async (write) => {
      const { context, actionId, sessionId, fieldId, value, serverId } = write;
      const credentials = params.credentials;
      if (!credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      if (params.serverId !== undefined && serverId != null && params.serverId !== serverId)
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      const resolveAuthorizationHeaders = (request: Readonly<{
        method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown;
      }>) => resolveServerRequestHeaders(context, actionId, request);
      if (!resolveAuthorizationHeaders({
        method: 'GET', path: '/v1/account/encryption/currentness',
      })) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      if (fieldId === 'intent.context') {
        await withCliPromptLibraryArtifactReader(reader => admitSessionContextIntentV1(value, reader.readArtifactHeader), {
          credentials, serverId, signal: context.signal,
        });
        context.signal?.throwIfAborted();
      }
      if (fieldId === 'intent.voicePreference' && value !== null) {
        // Running hosts consume their admitted lease. Standalone CLI uses the
        // same current manifest projection owner without activating plugins.
        const voiceProviders = params.readPluginVoiceProviders
          ? params.readPluginVoiceProviders()
          : (await (await import('@/plugins/projection/registry/createResolvedContributionRegistry'))
            .resolveMergedContributionRegistry({ happyHomeDir: params.happyHomeDir })).voiceProviders;
        context.signal?.throwIfAborted();
        const entry = voiceProviders.find(entry => buildQualifiedPluginContributionKey(entry.identity) === value.providerContributionId);
        const parsed = VoiceProviderContributionSchema.safeParse(entry?.definition);
        if (!parsed.success) return { ok: false, errorCode: 'override_unsupported', error: 'override_unsupported' };
        const providerConfig = Object.fromEntries((parsed.data.settings?.fields ?? []).map(field => [field.id, field.default ?? null]));
        const admitted = admitDeclaredSessionVoicePreferenceV1({ providerContributionId: value.providerContributionId,
          declaration: parsed.data, providerConfig, preference: value });
        if (admitted.kind === 'unavailable') return { ok: false, errorCode: admitted.reason, error: admitted.reason };
      }
      const mutate = () => updateSessionStateFieldForTarget({
        credentials,
        idOrPrefix: sessionId,
        fieldId,
        value: fieldId === 'display.title' ? { title: String(value), staleBehavior: 'bump-if-value-changed' as const } : value,
        metadataReason: `cli-${actionId}`,
        ...('expectedMetadataRevision' in write ? { expectedMetadataRevision: write.expectedMetadataRevision } : {}),
        currentness: { signal: context.signal },
        resolveAuthorizationHeaders,
      });
      const res = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, mutate) : mutate());
      if (!res.ok) {
        return { ok: false, errorCode: res.code, error: res.code, ...(res.candidates ? { candidates: res.candidates } : {}) };
      }
      return { ok: true, sessionId: res.sessionId, ...(fieldId === 'display.title' ? { title: value }
        : fieldId === 'display.bot' ? { bot: value } : fieldId === 'intent.memoryEnabled' ? { enabled: value }
        : fieldId === 'intent.voicePreference' ? { preference: value }
        : fieldId === 'intent.context' ? { work: res.metadata.work } : { showToolCalls: value }), version: res.version };
    },

    sessionPermissionModeSet: async ({ context, callerInputConstraints, sessionId, permissionMode }) => {
      const credentials = params.credentials;
      if (!credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const parsed = parsePermissionIntentAlias(String(permissionMode ?? '').trim());
      if (!parsed) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const updatedAt = Date.now();
      const externalRequest = Boolean(context?.externalActionCredential || context?.externalActionExecutionAuthorization);
      const resolveAuthorizationHeaders = (request: Readonly<{ method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown }>) =>
        resolveServerRequestHeaders(context, 'session.permission_mode.set', request);
      if (externalRequest && !resolveAuthorizationHeaders({ method: 'GET', path: '/v1/account/encryption/currentness' })) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const mutate = () => setSessionPermissionMode({
        credentials,
        idOrPrefix: sessionId,
        permissionMode: parsed as PermissionIntent,
        updatedAt,
        ...(callerInputConstraints ? { callerInputConstraints } : {}),
        ...(externalRequest ? { resolveAuthorizationHeaders } : {}),
      });
      const res = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, mutate) : mutate());
      if (!res.ok) {
        return { ok: false, errorCode: res.code, error: res.code, ...('candidates' in res && res.candidates ? { candidates: res.candidates } : {}) };
      }
      return { ok: true, sessionId: res.sessionId, permissionMode: parsed, updatedAt };
    },

    sessionModelSet: async ({ context, callerInputConstraints, sessionId, modelId, providerConnectionId, teamCredentialModel, teamVisibilityGrantConsent }) => {
      const credentials = params.credentials;
      if (!credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const normalizedModelId = String(modelId ?? '').trim();
      if (!normalizedModelId && teamCredentialModel === undefined) {
        return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      }
      const externalRequest = Boolean(context?.externalActionCredential || context?.externalActionExecutionAuthorization);
      const resolveAuthorizationHeaders = (request: Readonly<{ method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown }>) =>
        resolveServerRequestHeaders(context, 'session.model.set', request);
      if (externalRequest && (!params.externalActionMachineInstallationId || !params.externalActionMachineRequestPrivateKey
        || !resolveAuthorizationHeaders({ method: 'GET', path: '/v1/account/encryption/currentness' }))) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const mutate = () => setSessionModel({
        credentials,
        idOrPrefix: sessionId,
        ...(normalizedModelId ? { modelId: normalizedModelId } : {}),
        ...(providerConnectionId !== undefined ? { providerConnectionId } : {}),
        ...(teamCredentialModel !== undefined ? { teamCredentialModel } : {}),
        ...(teamVisibilityGrantConsent !== undefined ? { teamVisibilityGrantConsent } : {}),
        ...(callerInputConstraints ? { callerInputConstraints } : {}),
        ...(externalRequest ? { resolveAuthorizationHeaders } : {}),
        ...(externalRequest && context && params.externalActionMachineInstallationId && params.externalActionMachineRequestPrivateKey ? {
          externalAction: { context, effectActionId: 'session.model.set',
            installationId: params.externalActionMachineInstallationId, privateKey: params.externalActionMachineRequestPrivateKey },
        } : {}),
      });
      const res = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, mutate) : mutate());
      if (!res.ok) {
        const errorCode = 'code' in res ? res.code : res.status;
        return {
          ok: false,
          errorCode,
          error: errorCode,
          ...('candidates' in res && res.candidates ? { candidates: res.candidates } : {}),
          ...('status' in res
            ? {
                details: {
                  status: res.status,
                  activeSelection: 'activeSelection' in res ? res.activeSelection : undefined,
                  requestedSelection: 'requestedSelection' in res ? res.requestedSelection : undefined,
                  requestedTeamSelection: 'requestedTeamSelection' in res ? res.requestedTeamSelection : undefined,
                  ...('reason' in res && res.reason ? { reason: res.reason } : {}),
                },
              }
            : {}),
        };
      }
      if (res.status === 'intent_updated') {
        return {
          ok: true,
          status: res.status,
          sessionId: res.sessionId,
          modelId: 'ref' in res.selection ? res.selection.ref.modelId : res.selection.modelId,
          selection: res.selection,
          updatedAt: res.updatedAt,
        };
      }
      return {
        ...res,
        modelId: res.activeSelection.modelId,
      };
    },

    sessionArchiveSet: async ({ sessionId, archived }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      return await setSessionArchivedState({ credentials: params.credentials, idOrPrefix: sessionId, archived: archived === true });
    },

    sessionStatusGet: async ({ sessionId, live }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      return await getSessionStatus({ credentials: params.credentials, idOrPrefix: sessionId, live: live === true });
    },

    sessionWorkStateGet: async ({ sessionId }) => {
      return await callResolvedSessionRpc(sessionId, SESSION_RPC_METHODS.SESSION_WORK_STATE_GET, {});
    },

    sessionTerminalComposerClear: async ({ sessionId, expectedStateAtMs }) => {
      return await callResolvedSessionRpc(sessionId, SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR, {
        sessionId,
        ...(typeof expectedStateAtMs === 'number' ? { expectedStateAtMs } : {}),
      });
    },

    sessionPendingInputInterruptAndRun: async ({ sessionId, localId, expectedStateAtMs }) => {
      return await callResolvedSessionRpc(sessionId, SESSION_RPC_METHODS.SESSION_PENDING_INPUT_INTERRUPT_AND_RUN, {
        sessionId,
        localId,
        ...(typeof expectedStateAtMs === 'number' ? { expectedStateAtMs } : {}),
      });
    },
    sessionPendingWithdraw: async ({ sessionId, localId, serverId, targetExecutionRunId, context }) => {
      const denied = projectHomeAdmission(serverId, context);
      if (denied) return denied;
      return withProjectHome(() => withdrawPendingQueueV2Message({ token: params.token, sessionId, localId,
        ...(targetExecutionRunId ? { targetExecutionRunId } : {}), ...(context.signal ? { signal: context.signal } : {}),
        resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, 'session.pending.withdraw', request),
      }));
    },

    sessionGoalGet: async ({ sessionId }) => {
      return await callRoutedSessionGoalControl(sessionId, 'get', {});
    },

    sessionGoalSet: async ({ sessionId, objective, status, tokenBudget }) => {
      return await callRoutedSessionGoalControl(sessionId, 'set', {
        ...(typeof objective === 'string' ? { objective } : {}),
        ...(typeof status === 'string' && status.trim().length > 0 ? { status: status.trim() } : {}),
        ...(typeof tokenBudget !== 'undefined' ? { tokenBudget: tokenBudget ?? null } : {}),
      });
    },

    sessionGoalClear: async ({ sessionId }) => {
      return await callRoutedSessionGoalControl(sessionId, 'clear', {});
    },

    sessionUsageLimitWaitResumeEnable: async ({ sessionId, issueFingerprint, remember, resumePromptMode }) => {
      if (!await isUsageLimitRecoveryEnabled()) {
        return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), { sessionId });
      }
      const normalizedResumePromptMode = readResumePromptMode(resumePromptMode);
      const request = {
        sessionId,
        ...(typeof issueFingerprint === 'string' ? { issueFingerprint } : {}),
        ...(remember === true ? { rememberPreference: true } : {}),
        ...(normalizedResumePromptMode ? { resumePromptMode: normalizedResumePromptMode } : {}),
      };
      return await callRoutedUsageLimitRecoveryControl(sessionId, 'enable', request);
    },

    sessionUsageLimitWaitResumeCancel: async ({ sessionId, issueFingerprint, armedAtMs, runtimeAuthRecoveryAttemptId }) => {
      if (!await isUsageLimitRecoveryEnabled()) {
        return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), { sessionId });
      }
      const request = {
        sessionId,
        ...(issueFingerprint !== undefined ? { issueFingerprint } : {}),
        ...(typeof armedAtMs === 'number' && Number.isFinite(armedAtMs)
          ? { armedAtMs: Math.trunc(armedAtMs) }
          : {}),
        ...(typeof runtimeAuthRecoveryAttemptId === 'string' && runtimeAuthRecoveryAttemptId.trim().length > 0
          ? { runtimeAuthRecoveryAttemptId: runtimeAuthRecoveryAttemptId.trim() }
          : {}),
      };
      return await callRoutedUsageLimitRecoveryControl(sessionId, 'cancel', request);
    },

    sessionUsageLimitCheckNow: async ({ sessionId, agentId, resumePromptMode }) => {
      if (!await isUsageLimitRecoveryEnabled()) {
        return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), { sessionId });
      }
      const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
      const normalizedResumePromptMode = readResumePromptMode(resumePromptMode);
      return await callRoutedUsageLimitRecoveryControl(sessionId, 'checkNow', {
        sessionId,
        ...(normalizedAgentId.length > 0 ? { agentId: normalizedAgentId } : {}),
        ...(normalizedResumePromptMode ? { resumePromptMode: normalizedResumePromptMode } : {}),
      });
    },

    sessionUsageLimitSwitchAccountNow: async ({ sessionId, agentId, resumePromptMode }) => {
      if (!await isUsageLimitRecoveryEnabled()) {
        return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), { sessionId });
      }
      const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
      const normalizedResumePromptMode = readResumePromptMode(resumePromptMode);
      return await callRoutedUsageLimitRecoveryControl(sessionId, 'switchAccountNow', {
        sessionId,
        operation: 'switch_account_now',
        ...(normalizedAgentId.length > 0 ? { agentId: normalizedAgentId } : {}),
        ...(normalizedResumePromptMode ? { resumePromptMode: normalizedResumePromptMode } : {}),
      });
    },

    sessionUsageLimitConsumeResetCredit: async ({ sessionId, agentId, issueFingerprint, resumePromptMode }) => {
      if (!await isUsageLimitRecoveryEnabled()) {
        return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), { sessionId });
      }
      const normalizedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
      const normalizedIssueFingerprint = typeof issueFingerprint === 'string' ? issueFingerprint.trim() : '';
      const normalizedResumePromptMode = readResumePromptMode(resumePromptMode);
      return await callRoutedUsageLimitRecoveryControl(sessionId, 'consumeResetCredit', {
        sessionId,
        operation: 'consume_reset_credit',
        ...(normalizedAgentId.length > 0 ? { agentId: normalizedAgentId } : {}),
        ...(normalizedIssueFingerprint.length > 0 ? { issueFingerprint: normalizedIssueFingerprint } : {}),
        ...(normalizedResumePromptMode ? { resumePromptMode: normalizedResumePromptMode } : {}),
      });
    },

    sessionVendorPluginCatalogList: async ({ sessionId, cwd }) => {
      return await callRoutedSessionCatalogControl(sessionId, 'vendorPlugins', { cwd });
    },

    sessionSkillCatalogList: async ({ sessionId, cwd }) => {
      return await callRoutedSessionCatalogControl(sessionId, 'skills', { cwd });
    },

    sessionHistoryGet: async ({ sessionId, limit, format, includeMeta, includeStructuredPayload }) => {
	      if (!params.credentials) {
	        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
	      }
	      const normalizedLimit =
	        typeof limit === 'number' && Number.isFinite(limit) && limit > 0
	          ? Math.min(1000, Math.floor(limit))
	          : 50;
	      const normalizedFormat = format === 'raw' || format === 'compact' ? format : 'compact';
	      return await getSessionEvents({
	        credentials: params.credentials,
	        idOrPrefix: sessionId,
	        limit: normalizedLimit,
	        format: normalizedFormat,
	        includeMeta: includeMeta === true,
	        includeStructuredPayload: includeStructuredPayload === true,
	      });
	    },

    sessionTranscriptGet: async ({
      context,
      sessionId,
      projection,
      callerPluginId,
      limit,
      cursor,
      direction,
      scope,
      sidechainId,
      roles,
      includeTools,
      includeReasoning,
      includeEvents,
      includeMeta,
      includeRaw,
      includeStructuredPayload,
      maxCharsPerMessage,
      maxRawPayloadChars,
      signal,
    }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }
      const resolveAuthorizationHeaders = (request: Readonly<{
        method: 'GET' | 'POST'; path: string; body?: unknown;
      }>) => resolveServerRequestHeaders(context, 'session.transcript.get', request);
      if (!resolveAuthorizationHeaders({
        method: 'GET', path: '/v1/account/encryption/currentness',
      })) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }
      return await getSessionTranscript({
        credentials: params.credentials,
        resolveAuthorizationHeaders,
        idOrPrefix: sessionId,
        ...(projection ? { projection } : {}),
        ...(callerPluginId ? { callerPluginId } : {}),
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(direction ? { direction } : {}),
        ...(scope ? { scope } : {}),
        ...(sidechainId !== undefined ? { sidechainId } : {}),
        ...(roles ? { roles } : {}),
        ...(typeof includeTools === 'boolean' ? { includeTools } : {}),
        ...(typeof includeReasoning === 'boolean' ? { includeReasoning } : {}),
        ...(typeof includeEvents === 'boolean' ? { includeEvents } : {}),
        ...(typeof includeMeta === 'boolean' ? { includeMeta } : {}),
        ...(typeof includeRaw === 'boolean' ? { includeRaw } : {}),
        ...(typeof includeStructuredPayload === 'boolean' ? { includeStructuredPayload } : {}),
        ...(maxCharsPerMessage !== undefined ? { maxCharsPerMessage } : {}),
        ...(maxRawPayloadChars !== undefined ? { maxRawPayloadChars } : {}),
        ...(signal ? { signal } : {}),
      });
    },

    sessionEventsGet: async ({
      sessionId,
      limit,
      cursor,
      direction,
      scope,
      sidechainId,
      roles,
      kinds,
      format,
      includeMeta,
      includeRaw,
      includeStructuredPayload,
      maxTextChars,
      maxPayloadChars,
    }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }
      return await getSessionEvents({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(direction ? { direction } : {}),
        ...(scope ? { scope } : {}),
        ...(sidechainId !== undefined ? { sidechainId } : {}),
        ...(roles ? { roles } : {}),
        ...(kinds ? { kinds } : {}),
        ...(format ? { format } : {}),
        ...(typeof includeMeta === 'boolean' ? { includeMeta } : {}),
        ...(typeof includeRaw === 'boolean' ? { includeRaw } : {}),
        ...(typeof includeStructuredPayload === 'boolean' ? { includeStructuredPayload } : {}),
        ...(typeof maxTextChars === 'number' ? { maxTextChars } : {}),
        ...(typeof maxPayloadChars === 'number' ? { maxPayloadChars } : {}),
      });
    },

	    sessionWaitIdle: async ({ sessionId, timeoutSeconds, signal }) => {
	      if (!params.credentials) {
	        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
	      }
	      const normalizedTimeoutSeconds =
	        typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
	          ? Math.min(3600, timeoutSeconds)
	          : 300;
	      return await waitForSessionIdle({
	        credentials: params.credentials,
	        idOrPrefix: sessionId,
	        timeoutMs: Math.max(1, Math.floor(normalizedTimeoutSeconds * 1000)),
	        ...(signal ? { signal } : {}),
	      });
	    },

    sessionPermissionRemoteAction: async (args) => {
      const rejectUnavailable = (
        code: 'canceled' | 'mediationStateUnavailable' | 'ownerMachineUnavailable',
      ) => args.actionId === 'session.permission.remote.pending.list'
        ? { ok: false as const, errorCode: code, error: code }
        : args.actionId === 'session.permission.remote.grants.list'
          ? { ok: false as const, errorCode: code, error: code }
        : { status: 'rejected' as const, code };

      if (args.signal?.aborted) {
        return rejectUnavailable('canceled');
      }

      // The existing current-session binding is the only live owner lookup.
      // Do not fall back to the Action deps' construction session, a registry,
      // or a Session RPC: a remote decision must reach the exact active owner.
      const binding = resolveCurrentSessionCapabilityBinding(args.input.sessionId);
      if (!binding) {
        return rejectUnavailable('ownerMachineUnavailable');
      }
      const bindingIsStillCurrent = (): boolean => {
        if (args.signal?.aborted || binding.signal.aborted) return false;
        try {
          if (binding.isCurrent() !== true) return false;
        } catch {
          return false;
        }
        return resolveCurrentSessionCapabilityBinding(args.input.sessionId)?.scopeId === binding.scopeId;
      };
      if (!bindingIsStillCurrent()) {
        return rejectUnavailable('ownerMachineUnavailable');
      }

      const permissionHandler = binding.permissionHandler;
      if (!permissionHandler) {
        return rejectUnavailable('mediationStateUnavailable');
      }

      if (args.actionId === 'session.permission.remote.pending.list') {
        if (args.caller.kind !== 'plugin') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const list = permissionHandler.listMediatedPendingRequests;
        if (typeof list !== 'function') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const result = list.call(permissionHandler, {
          mediatorPluginId: args.caller.pluginId,
          sourceRef: args.input.sourceRef,
          sourceRevisionOrEpoch: args.input.sourceRevisionOrEpoch,
          ...('cursor' in args.input && args.input.cursor !== undefined
            ? { cursor: args.input.cursor }
            : {}),
        });
        if (args.signal?.aborted) {
          return rejectUnavailable('canceled');
        }
        return bindingIsStillCurrent()
          ? result
          : rejectUnavailable('ownerMachineUnavailable');
      }

      if (args.actionId === 'session.permission.remote.respond') {
        if (args.caller.kind !== 'plugin') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const contributionLocalId = args.caller.contributionLocalId;
        if (!contributionLocalId?.trim()) {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const respond = permissionHandler.respondToMediatedPendingPermission;
        if (typeof respond !== 'function') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const result = await respond.call(permissionHandler, {
          sessionId: args.input.sessionId,
          turnId: args.input.turnId,
          requestId: args.input.requestId,
          sourceRef: args.input.sourceRef,
          sourceRevisionOrEpoch: args.input.sourceRevisionOrEpoch,
          idempotencyKey: args.input.idempotencyKey,
          actor: args.input.actor,
          decision: args.input.decision,
          scope: args.input.scope,
          mediator: {
            pluginId: args.caller.pluginId,
            contributionLocalId,
          },
          ...(args.signal ? { signal: args.signal } : {}),
        });
        if (args.signal?.aborted) {
          return rejectUnavailable('canceled');
        }
        return bindingIsStillCurrent()
          ? result
          : rejectUnavailable('ownerMachineUnavailable');
      }

      if (args.actionId === 'session.user_action.remote.answer') {
        if (args.caller.kind !== 'plugin') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const contributionLocalId = args.caller.contributionLocalId;
        if (!contributionLocalId?.trim()) {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const answer = permissionHandler.respondToMediatedPendingUserAction;
        if (typeof answer !== 'function') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const result = await answer.call(permissionHandler, {
          sessionId: args.input.sessionId,
          turnId: args.input.turnId,
          requestId: args.input.requestId,
          sourceRef: args.input.sourceRef,
          sourceRevisionOrEpoch: args.input.sourceRevisionOrEpoch,
          answers: args.input.answers,
          mediator: {
            pluginId: args.caller.pluginId,
            contributionLocalId,
          },
          ...(args.signal ? { signal: args.signal } : {}),
        });
        if (args.signal?.aborted) {
          return rejectUnavailable('canceled');
        }
        return bindingIsStillCurrent()
          ? result
          : rejectUnavailable('ownerMachineUnavailable');
      }

      const viewer = args.caller.kind === 'plugin'
        ? { kind: 'mediatorPlugin' as const, pluginId: args.caller.pluginId }
        : args.caller.kind === 'host'
          ? { kind: 'host' as const }
          : null;
      if (!viewer) {
        return rejectUnavailable('mediationStateUnavailable');
      }

      if (args.actionId === 'session.permission.remote.grants.list') {
        const listGrants = permissionHandler.listMediatedPermissionGrants;
        if (typeof listGrants !== 'function') {
          return rejectUnavailable('mediationStateUnavailable');
        }
        const result = await listGrants.call(permissionHandler, {
          viewer,
          limit: args.input.limit,
          ...(args.input.cursor !== undefined ? { cursor: args.input.cursor } : {}),
          ...(args.signal ? { signal: args.signal } : {}),
        });
        if (args.signal?.aborted) {
          return rejectUnavailable('canceled');
        }
        if (!bindingIsStillCurrent()) {
          return rejectUnavailable('ownerMachineUnavailable');
        }
        return result ?? rejectUnavailable('mediationStateUnavailable');
      }

      const revoke = permissionHandler.revokeMediatedPermissionGrant;
      if (typeof revoke !== 'function') {
        return rejectUnavailable('mediationStateUnavailable');
      }
      const result = await revoke.call(permissionHandler, {
        turnId: args.input.turnId,
        requestId: args.input.requestId,
        grantId: args.input.grantId,
        caller: viewer,
        ...(args.signal ? { signal: args.signal } : {}),
      });
      if (args.signal?.aborted) {
        return rejectUnavailable('canceled');
      }
      return bindingIsStillCurrent()
        ? result
        : rejectUnavailable('ownerMachineUnavailable');
    },

    sessionPermissionRespond: async ({
      sessionId,
      context,
      decision,
      requestId,
      turnId,
      mode,
      reason,
      answers,
      allowedTools,
      updatedPermissions,
      execPolicyAmendment,
      signal,
    }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }

      const reqId = String(requestId ?? '').trim();
      if (!reqId) {
        return { ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found', sessionId };
      }

      const externalRequest = context?.externalActionCredential !== undefined
        || context?.externalActionExecutionAuthorization !== undefined;
      const resolveAuthorizationHeaders = externalRequest && context
        ? (request: Readonly<{ method: string; path: string; body?: unknown }>) =>
            resolveServerRequestHeaders(context, 'session.permission.respond', request)
        : undefined;
      if (externalRequest && (!context || !params.externalActionMachineRequestPrivateKey
        || !params.externalActionMachineInstallationId
        || !resolveAuthorizationHeaders?.({ method: 'GET', path: '/v1/account/encryption/currentness' }))) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated', sessionId };
      }
      const transport = resolveAuthorizationHeaders
        ? await resolveSessionTransportContext({
            credentials: params.credentials,
            idOrPrefix: sessionId,
            resolveAuthorizationHeaders,
            ...(signal ? { signal } : {}),
          })
        : await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return {
          ok: false,
          errorCode: transport.code,
          errorMessage: transport.code,
          ...(transport.candidates ? { candidates: transport.candidates } : {}),
        };
      }
      try {
        return await callSessionRpc({
          ...transport,
          token: params.credentials.token,
          sessionId: transport.sessionId,
          method: `${transport.sessionId}:session.permission.respond`,
          ...(externalRequest && context && params.externalActionMachineRequestPrivateKey
            && params.externalActionMachineInstallationId ? { externalAction: {
              context, effectActionId: 'session.permission.respond',
              installationId: params.externalActionMachineInstallationId,
              privateKey: params.externalActionMachineRequestPrivateKey,
            } } : {}),
          request: buildSessionPermissionRespondRpcParamsV1({
            id: reqId,
            ...(typeof turnId === 'string' && turnId.trim().length > 0 ? { turnId: turnId.trim() } : {}),
            decision,
            ...(mode === undefined ? {} : { mode }),
            ...(reason === undefined ? {} : { reason }),
            ...(answers === undefined ? {} : { answers }),
            ...(Array.isArray(allowedTools) ? { allowedTools: [...allowedTools] } : {}),
            ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
            ...(typeof execPolicyAmendment !== 'undefined' ? { execPolicyAmendment } : {}),
          }),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        return {
          ok: false,
          errorCode: readRpcErrorCode(error) ?? 'permission_update_failed',
          errorMessage: error instanceof Error ? error.message : 'permission_update_failed',
          sessionId: transport.sessionId,
        };
      }
    },
    sessionUserActionAnswer: async ({
      sessionId,
      context,
      requestId,
      answers,
      decision,
      reason,
      updatedPermissions,
      allowedTools,
      execPolicyAmendment,
      signal,
    }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }

      const reqId = String(requestId ?? '').trim();
      if (!reqId) {
        return { ok: false, errorCode: 'permission_request_not_found', errorMessage: 'permission_request_not_found', sessionId };
      }

      const externalRequest = context?.externalActionCredential !== undefined
        || context?.externalActionExecutionAuthorization !== undefined;
      const resolveAuthorizationHeaders = externalRequest && context
        ? (request: Readonly<{ method: string; path: string; body?: unknown }>) =>
            resolveServerRequestHeaders(context, 'session.user_action.answer', request)
        : undefined;
      if (externalRequest && (!context || !params.externalActionMachineRequestPrivateKey
        || !params.externalActionMachineInstallationId
        || !resolveAuthorizationHeaders?.({ method: 'GET', path: '/v1/account/encryption/currentness' }))) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated', sessionId };
      }
      const transport = resolveAuthorizationHeaders
        ? await resolveSessionTransportContext({
            credentials: params.credentials,
            idOrPrefix: sessionId,
            resolveAuthorizationHeaders,
            ...(signal ? { signal } : {}),
          })
        : await resolveTransportForSession(sessionId);
      if (!transport.ok) {
        return {
          ok: false,
          errorCode: transport.code,
          errorMessage: transport.code,
          ...(transport.candidates ? { candidates: transport.candidates } : {}),
        };
      }
      if (isKnownCompletedRequestId({
        ...transport,
        rawSession: transport.rawSession,
        requestId: reqId,
        kind: 'user_action',
      })) {
        return permissionRequestNotFoundResult(transport.sessionId);
      }
      const normalizedAnswers = Object.create(null) as Record<string, readonly string[]>;
      for (const entry of Array.isArray(answers) ? answers : []) {
        const question = String(entry?.question ?? '');
        if (question.trim().length > 0 && entry.values.length > 0) {
          normalizedAnswers[question] = [...entry.values];
        }
      }
      if (!decision && Object.keys(normalizedAnswers).length === 0) {
        return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'invalid_parameters', sessionId: transport.sessionId };
      }

      const approved = decision ? decision === 'approve' : true;
      const legacyDecision =
        decision === 'reject'
          ? 'denied'
          : decision === 'request_changes'
            ? 'abort'
            : 'approved';
      try {
        return await callSessionRpc({
          ...transport,
          token: params.credentials.token,
          sessionId: transport.sessionId,
          method: `${transport.sessionId}:session.user_action.answer`,
          ...(externalRequest && context && params.externalActionMachineRequestPrivateKey
            && params.externalActionMachineInstallationId ? { externalAction: {
              context, effectActionId: 'session.user_action.answer',
              installationId: params.externalActionMachineInstallationId,
              privateKey: params.externalActionMachineRequestPrivateKey,
            } } : {}),
          request: {
            id: reqId,
            approved,
            decision: legacyDecision,
            ...(decision ? { actionDecision: decision } : {}),
            ...(Object.keys(normalizedAnswers).length > 0 ? { answers: normalizedAnswers } : {}),
            ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
            ...(typeof updatedPermissions !== 'undefined' ? { updatedPermissions } : {}),
            ...(Array.isArray(allowedTools) ? { allowedTools } : {}),
            ...(typeof execPolicyAmendment !== 'undefined' ? { execPolicyAmendment } : {}),
          },
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        return {
          ok: false,
          errorCode: readRpcErrorCode(error) ?? 'permission_update_failed',
          errorMessage: error instanceof Error ? error.message : 'permission_update_failed',
          sessionId: transport.sessionId,
        };
      }
    },
    sessionModeSet: async ({ sessionId, modeId }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }

      const normalizedModeId = String(modeId ?? '').trim();
      const updatedAt = Date.now();
      const res = await setSessionMode({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        modeId: normalizedModeId,
        updatedAt,
      });
      if (!res.ok) {
        return { ok: false, errorCode: res.code, error: res.code, ...(res.candidates ? { candidates: res.candidates } : {}) };
      }
      return { ok: true, sessionId: res.sessionId, modeId: normalizedModeId, updatedAt };
    },
    sessionBoardAction: widgetBoardDeps?.sessionBoardAction
      ?? (async () => ({ ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' })),

    currentSessionPresentationApply: async ({ input, context, signal }) => {
      const sessionId = normalizeStringValue(context.defaultSessionId);
      if (!sessionId) {
        return { ok: false, errorCode: 'session_not_selected', error: 'session_not_selected' };
      }
      const operationId = normalizeStringValue(context.actionRequestId);
      if (!operationId) {
        return { ok: false, errorCode: 'action_request_id_required', error: 'action_request_id_required' };
      }
      const presentation = resolveCurrentSessionUiBinding(sessionId)?.presentation;
      if (!presentation) {
        return {
          ok: false,
          errorCode: 'current_session_presentation_unavailable',
          error: 'current_session_presentation_unavailable',
        };
      }

      const result = await presentation.present(
        { operationId, intent: input.intent },
        signal ? { signal } : undefined,
      );
      return projectCurrentSessionPresentationActionResult(result);
    },

    sessionDiscussionAction: params.credentials
      ? createSessionDiscussionActionDeps({
          credentials: params.credentials,
          ...(params.resolveExactSessionEncryptionMaterial
            ? { resolveExactSessionEncryptionMaterial: params.resolveExactSessionEncryptionMaterial }
            : {}),
          ...(params.resolveServerFeaturesSnapshot
            ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot }
            : {}),
          ...exactHome,
          ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
          ...(params.externalActionMachineRequestPrivateKey
            ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
            : {}),
          ...(params.externalActionMachineInstallationId
            ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
            : {}),
        }).sessionDiscussionAction
      : async () => ({ ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' }),

    sessionList,

    sessionAwarenessWait: async ({ context, input, options, readAwareness }) => {
      if (input.target.kind !== 'session') return { disposition: 'unsupported_condition' };
      if (!params.credentials) return { disposition: 'permission_denied' };
      if (!params.serverId || input.target.serverId !== params.serverId) return { disposition: 'permission_denied' };
      const sessionId = input.target.sessionId;
      return waitForSessionAwarenessV1({
        condition: input.condition, deadlineMs: options.deadlineMs,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onSnapshot ? { onSnapshot: options.onSnapshot } : {}),
        read: async () => {
          const raw = await readAwareness();
          const parsed = SessionAwarenessProjectionV1Schema.safeParse(raw);
          if (!parsed.success) {
            if (raw && typeof raw === 'object' && 'ok' in raw && raw.ok === false) throw raw;
            throw new Error('session_awareness_wait_result_invalid');
          }
          if (input.condition.kind !== 'turn_terminal') return { awareness: parsed.data };
          const turns = await fetchSessionTurnsProjection({ token: params.token, sessionId,
            ...(options.signal ? { signal: options.signal } : {}),
            resolveAuthorizationHeaders: (request) => resolveServerRequestHeaders(context, 'session.activity.get', request),
          });
          if (!turns) return null;
          const turn = turns.turns.find((entry) => input.condition.kind === 'turn_terminal' && entry.turnId === input.condition.turnId);
          return { awareness: parsed.data, ...(turn ? { turn } : {}) };
        },
        open: () => openSessionEventSource({ token: params.token, sessionId, scope: 'user' }),
      });
    },

    sessionActivityGet: async ({ context, sessionId, view, windowSeconds, signal }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      if (windowSeconds !== undefined) {
        return {
          ok: false,
          errorCode: 'unsupported_action',
          error: 'unsupported_action:session.activity.get.windowSeconds',
        };
      }
      const resolveAuthorizationHeaders = (request: Readonly<{
        method: 'GET'; path: string;
      }>) => resolveServerRequestHeaders(context, 'session.activity.get', request);
      const currentnessAuthorizationHeaders = resolveAuthorizationHeaders({
        method: 'GET', path: '/v1/account/encryption/currentness',
      });
      if (!currentnessAuthorizationHeaders) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      signal?.throwIfAborted();
      const serverFeaturesSnapshot = await readServerFeaturesSnapshot();
      signal?.throwIfAborted();
      const session = await fetchSessionByIdCompat({
        token: params.credentials.token,
        sessionId,
        resolveAuthorizationHeaders,
        ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
        signal,
      });
      if (!session) {
        return { ok: false, errorCode: 'session_not_found', error: 'session_not_found', sessionId };
      }
      const currentness = await fetchAccountEncryptionCurrentness({
        token: params.credentials.token,
        authorizationHeaders: currentnessAuthorizationHeaders,
        signal,
      });
      signal?.throwIfAborted();
      const awarenessInput = buildCliSessionAwarenessInputV1({
        credentials: params.credentials,
        accountEncryption: currentness,
        row: session,
        nowMs: Date.now(),
      });
      const awareness = projectSessionAwarenessV1(awarenessInput);
      // The requested representation, from the one projector this Action already derives its
      // released booleans from. Omission keeps the compatibility digest below.
      if (view === SESSION_LIST_AWARENESS_VIEW_V1) return awareness;
      return {
        ...projectSessionActivityCompatibilityV1({
          awareness,
          facts: {
            presence: awarenessInput.runtime.presence === 'unknown' ? null : awarenessInput.runtime.presence,
            active: session.active,
            thinking: session.thinking === true,
            updatedAt: session.updatedAt,
            // No `permissionRequestIds`: this path reads a V2 row, which carries pending counts
            // but no request identities. The released CLI/daemon response never had the field.
          },
        }),
        // cli-v0.2.11 and the current 0.2 daemon expose these ancillary raw counts.
        // Keep that response seam while status meaning comes only from awareness.
        pendingCount: session.pendingCount ?? 0,
        pendingPermissionRequestCount: session.pendingPermissionRequestCount ?? 0,
        pendingUserActionRequestCount: session.pendingUserActionRequestCount ?? 0,
      };
    },

    sessionRecentMessagesGet: async ({ sessionId, limit, cursor, includeUser, includeAssistant, maxCharsPerMessage }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', errorMessage: 'not_authenticated' };
      }
      return await getSessionTranscript({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(Object.prototype.hasOwnProperty.call({ cursor }, 'cursor') ? { cursor: cursor ?? null } : {}),
        roles: [
          ...(includeUser === false ? [] : ['user' as const]),
          ...(includeAssistant === false ? [] : ['assistant' as const]),
        ],
        ...(Object.prototype.hasOwnProperty.call({ maxCharsPerMessage }, 'maxCharsPerMessage') ? { maxCharsPerMessage: maxCharsPerMessage ?? null } : {}),
      });
    },

    subagentsList: async (args) => {
      return await hostSubagentStore.list(args);
    },

    subagentsGet: async (args) => {
      return await hostSubagentStore.get(args);
    },

    subagentsWatch: async (args) => {
      try {
        return await new Promise((resolve, reject) => {
          try {
            let subscription: Readonly<{ unsubscribe(): void }> | null = null;
            let unsubscribeAfterRegister = false;
            subscription = hostSubagentStore.watch(args, (event) => {
              if (event.kind !== 'snapshot') return;
              resolve({
                kind: 'snapshot',
                subagents: event.subagents ?? [],
              });
              if (subscription) {
                subscription.unsubscribe();
              } else {
                unsubscribeAfterRegister = true;
              }
            });
            if (unsubscribeAfterRegister) {
              subscription.unsubscribe();
            }
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        return serializeHostSubagentStoreError(error);
      }
    },

    subagentsUpsert: async ({ input, caller }) => {
      try {
        return await hostSubagentStore.upsert({
          actor: deriveHostSubagentActor(caller),
          input,
        });
      } catch (error) {
        return serializeHostSubagentStoreError(error);
      }
    },

    subagentsUpdateStatus: async ({ input, caller }) => {
      try {
        return await hostSubagentStore.updateStatus({
          ...input,
          actor: deriveHostSubagentActor(caller),
        });
      } catch (error) {
        return serializeHostSubagentStoreError(error);
      }
    },

    subagentsComplete: async ({ input, caller }) => {
      try {
        return await hostSubagentStore.complete({
          ...input,
          actor: deriveHostSubagentActor(caller),
        });
      } catch (error) {
        return serializeHostSubagentStoreError(error);
      }
    },

    pluginsDevLoopAction: async ({ actionId, input, context }) => await executePluginDevLoopAction({
      actionId,
      input,
      happyHomeDir: params.happyHomeDir,
      workspaceRoot: await resolveCurrentSessionValue('path') ?? undefined,
      context,
    }),

    pluginSettingsAdministrationAction: async ({ actionId, input, context }) => (
      await executePluginSettingsAdministrationAction({
        actionId,
        input,
        happyHomeDir: params.happyHomeDir,
        ...(context.actionCaller ? { actionCaller: context.actionCaller } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      })
    ),

    pluginPermissionGrantAction: async (args) => pluginPermissionGrantAction
      ? await pluginPermissionGrantAction(args)
      : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },

    pluginWebhookAction: async (args) => pluginWebhookAction
      ? await pluginWebhookAction(args)
      : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },

    ...(automationEventAction ? {
      automationEventAction: async (args) => await automationEventAction(args),
    } : {}),

    workflowAction: async (args) => {
      if (!workflowAction) {
        return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
      }
      try {
        // A Machine/Account host's bound id is not a Workflow origin Session.
        // Keep Session identity explicit at ingress; only enrich Account identity.
        let context = accountCallerContext(args.context);
        const isTrustedCallingSession = normalizeStringValue(args.context.defaultSessionId) === normalizeStringValue(params.sessionId);
        if (args.actionId === 'workflow.run.start'
          && isTrustedCallingSession
          && !(context.externalActionTarget?.kind === 'machine' && context.externalActionTarget.project)) {
          const [machineId, directory] = await Promise.all([
            resolveCurrentSessionValue('machineId'),
            resolveCurrentSessionValue('path'),
          ]);
          if (!machineId || !directory) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
          context = {
            ...context,
            externalActionTarget: {
              kind: 'machine',
              machineId,
              project: { machineId, directory },
            },
          };
        }
        return await workflowAction({ ...args, context } as Parameters<typeof workflowAction>[0]);
      } catch (error) {
        return normalizeWorkflowActionThrownError(error);
      }
    },

    automationConversationAction: async (args) => automationConversationAction
      ? await automationConversationAction(args)
      : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },

    pluginSessionHookManagementAction: async (args) => {
      const hookManagementAction =
        params.externalSessionPluginAdmissionOwner?.hookManagementAction;
      if (!hookManagementAction) {
        return {
          ok: false,
          errorCode: 'unsupported_action',
          error: `unsupported_action:${args.actionId}`,
        };
      }
      const execution = await hookManagementAction(
        args.actionId,
        args.input,
        {
          surface: 'action',
          ...(args.signal ? { signal: args.signal } : {}),
        },
      );
      return execution.ok ? execution.result : execution;
    },

    resolveApiTokenGrantSessionMachineId: async ({ actionId, sessionId, context }) => {
      if (!params.credentials || !context.externalActionCredential) return null;
      const transport = await resolveSessionTransportContext({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, actionId, request),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (!transport.ok || transport.sessionId !== sessionId || transport.rawSession.id !== sessionId) return null;
      return readSessionOwnerLocality({ metadata: readTransportSessionOwnerMetadata(transport),
        rawSession: transport.rawSession })?.machineId ?? null;
    },

    hostExternalSessionAction: params.credentials ? createHostExternalSessionActionTransport({
      credentials: params.credentials,
      serverId: params.serverId ?? configuration.activeServerId,
      serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
      resolveSessionMachineId: async (sessionId, signal) => {
        const transport = await resolveTransportForSession(sessionId, signal);
        return transport.ok ? normalizeStringValue(readTransportSessionOwnerMetadata(transport)?.machineId) : null;
      },
    }) : undefined,

    externalSessionAction: async (args) => params.credentials
      ? await executePluginExternalSessionAction(
          { ...args, credentials: params.credentials },
          params.externalSessionPluginAdmissionOwner?.materializeStart
            ? {
                materializeStart:
                  params.externalSessionPluginAdmissionOwner.materializeStart,
              }
            : {},
        )
      : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },

    managedMachineReferences,
    machineEnvironmentApply: async ({ input, context, signal }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== input.machineId) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      return await callMachineAction({ machineId: input.machineId, serverId: context.serverId ?? params.serverId,
        method: 'machines.environment.apply', request: input, context, effectActionId: 'machines.environment.apply',
        authority: context.authority, exactMachine: true, timeoutMs: null, ...(signal ? { signal } : {}) });
    },
    buildApprovalPreview: async ({ actionId, input, context, defaultPreview, machineReferences }) => {
      if (actionId === 'machines.managed.delete') {
        const references = machineReferences ?? await managedMachineReferences({ input: ManagedDeleteInputV1Schema.parse(input),
          context, signal: context.signal });
        return { ...defaultPreview, machineReferences: references };
      }
      if (actionId === 'session.spawn_new' && params.requesterSessionBootstrap
        && await params.requesterSessionBootstrap.isCurrent()) {
        const bootstrap = params.requesterSessionBootstrap;
        const parsed = SessionSpawnNewInputV2Schema.safeParse(input);
        if (parsed.success && parsed.data.executionTarget.serverId === bootstrap.attribution.serverId
          && parsed.data.executionTarget.machineId === bootstrap.attribution.machineId) {
          return { ...defaultPreview, requesterCredentialDisclosure: projectRequesterSessionCredentialDisclosure({
            disposition: 'ordinary_requester', accountId: bootstrap.attribution.accountId,
            machineId: bootstrap.attribution.machineId,
          }) };
        }
      }
      if (actionId === 'plugins.install') {
        return await buildPluginInstallApprovalPreview({
          input,
          defaultPreview,
          workspaceRoot: await resolveCurrentSessionValue('path') ?? undefined,
        });
      }
      return defaultPreview;
    },

    settingsDeclarationAction: createCliSettingsDeclarationAction({ credentials: params.credentials,
      serverHttpBaseUrl: params.serverHttpBaseUrl }),
    resetGlobalVoiceAgent: () => {},
  };
  return actionDeps;
}

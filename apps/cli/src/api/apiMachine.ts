import { publishDaemonHostEvent } from '@/daemon/events/publishDaemonHostEvent';
import { MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1 } from '@happier-dev/protocol/plugins/events/machineServiceObservationV1';
import { resolveSessionTargetWorkspace } from '@/daemon/sessions/sessionTargetWorkspaces';
import { z } from 'zod/mini';
import type { CapabilitiesDetectRequest } from '@/capabilities/types';
import { acquireDeploymentRestoreUpload } from '@/transfers/targets/deploymentRestoreUpload';
/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import axios from '@/api/client/credentialAxios';
import { settleMachineCaddyFirewallForHost, settleMachinePrivateWorkloadFirewallForHost } from '@/machines/reachability/machineReachabilityHost';
import { observeOwnDaemonReachability } from '@/machines/reachability/observeOwnDaemonReachability';
import { PluginWebhookHeartbeatReceiptEphemeralV1Schema, type PluginWebhookHeartbeatReceiptHintV1 } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import type { AutomationEventSourcesInvalidatedHostEventV1 } from '@happier-dev/protocol/plugins/events/hostReferencesV1';
import { join } from 'node:path';
import { admitDeploymentArchiveFilesystemForHost } from '@/deployments/targets/ownServer/archiveFilesystemAdmission';
import type { ExecutionRunMachineActivityV1 } from '@happier-dev/protocol/execution/runs/activityV1';
import { SCM_DIFF_SUMMARY_RESULT_UPDATED_EVENT, type ScmDiffSummaryResultRevisionHint } from '@happier-dev/protocol/scm/diffSummaryResult';
import type { ExecutionRunResumeMaterializationAuthority } from '@/agent/runtime/bridges/executionRun/resumeBackendController';
import type { ProviderBrokerRetainedCurrentnessInvalidation } from '@/providers/broker/brokerRetainedCurrentnessInvalidation';
import { ACCOUNT_CHANGES_PAGE_LIMIT_V1, changeRowsAlreadyHeld, isChangesPageFull, readConnectedServicesAccountChangeV1, readProviderAccountUsageRefreshRecordIdV1 } from '@happier-dev/protocol/changes';
import type { QualifiedConnectedAccountServiceRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { PluginDomainChangeEntrySchema } from '@happier-dev/protocol/changes/pluginDomain';
import { ManagedMachinePolicyChangeHintV1Schema } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { ManagedWakeTargetV1Schema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { isProjectWorkspaceSyncOpenActionV1, isProjectWorkspaceSyncPreparationActionV1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import { createDiscussionReplyReturnPublisher } from '@/discussions/discussionReplyReturnPublisher';
import { readDiscussionChangeHintV1 } from '@happier-dev/protocol/discussions';
import { DISCUSSION_AGENT_POST_EVENT_V1, DiscussionMachinePublicationV2Schema,
    DiscussionAgentApprovedReplayResponseV1Schema, type DiscussionAgentPostPublicationV1,
    type DiscussionAgentPostResponseV1, type DiscussionWorkflowPostPublicationV1 } from '@happier-dev/protocol/discussions/api';
import { SESSION_PENDING_RESET_START_RELEASE_EVENT_V1, PendingResetStartReleaseRequestV1Schema, PendingResetStartReleaseResponseV1Schema, type PendingResetStartBindingV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { createMachineDaemonStatePublication, projectMachineDaemonRunningState } from './machine/machineDaemonStatePublication';
import { projectMachineSetupAppliedObservation, projectMachineSetupUpdatesObservation } from './machine/machineSetupObservation';
import { projectMachineMetadataChange, publishMachineMetadataOnce, publishMachineMetadataUpdate, readOpenedMachineMetadataSnapshot, type MachineMetadataChange } from './machine/machineMetadataPublication';
import { createApiMachineServicesBinding } from './machine/machineServicesBinding';
import { machineServiceAdmissionFailure } from '@/daemon/local/services/launch/machineServiceFailure';
import type { MachineServiceActionDirectTargetInvocation } from '@/session/actions/createCliActionDeps';
import { readAgentIsolationSnapshot, type AgentIsolationSnapshot } from '@/daemon/agentIsolation/agentIsolationPolicy';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { registerDaemonCommittedServiceHealthDeliveryRpcHandler } from '@/notifications/activity/committedServiceHealthDelivery';
import type { AgentIsolationEffectDependencies } from '@/daemon/agentIsolation/agentIsolationProvisioner';
import { readAgentIsolationMemberLaunchIdentity } from '@/daemon/agentIsolation/memberBindings';
import { observeAgentIsolationMemberLaunchReadiness, observeUnqualifiedAgentIsolationNativeReadiness } from '@/daemon/agentIsolation/agentIsolationReadiness';
import { readMachineAgentIsolationPolicyV1, type MachineAgentIsolationOwnStatusV1 } from '@happier-dev/protocol/machines/agentIsolationV1';
import { createAgentIsolationMemberOperations, type AgentIsolationMemberOperations } from '@/daemon/agentIsolation/createAgentIsolationMemberOperations';
import type { HostAgentIsolationLaunchContext, HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { prepareRequesterNativeOperation, type PrepareRequesterNativeOperationInput } from '@/daemon/agentIsolation/prepareNativeOperation';
import { createSessionAgentIsolationMemberPreparation } from '@/daemon/agentIsolation/sessionPreparation';
import { prepareDaemonAgentIsolationIdentity } from '@/daemon/spawn/prepareDaemonAgentIsolationIdentity';
import { registerDaemonMachineAdminAccessRpcHandlers, type DaemonMachineAdminAccessRoutes } from '@/rpc/handlers/daemonMachineAdminAccess';
import { MACHINE_ADMIN_ACCESS_ACTION_IDS } from '@happier-dev/protocol/machines/adminAccessActionIdsV1';
import { MACHINE_ROLES_ACTION_IDS } from '@happier-dev/protocol/actions/specs/machineRolesActionIdsV1';
import { MACHINE_ISOLATION_ACTION_IDS } from '@happier-dev/protocol/actions/specs/machineIsolationActionIdsV1';
import { MACHINE_AGENT_ISOLATION_ACTION_IDS } from '@happier-dev/protocol/actions/specs/machine/agentIsolationActionIdsV1';
import { MACHINE_REACHABILITY_ACTION_IDS_V1 } from '@happier-dev/protocol/machines/reachability/actionIdsV1';
import { MACHINE_GUARD_ACTION_IDS } from '@happier-dev/protocol/machines/guard/actionIdsV1';
import { MACHINE_SETUP_PLAN_ACTION_ID_V1, MACHINE_SETUP_APPLY_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { registerDaemonMachineReachabilityRpcHandlers, executeDaemonMachineReachabilityAction,
    prepareDaemonMachineReachabilityReviewedChildren, type DaemonMachineReachabilityRoutes } from '@/machines/reachability/createDaemonMachineReachabilityRoutes';
import type { MachineDaemonRightsV1 } from '@happier-dev/protocol';
import type { MachineElevationDependencies } from '@/machines/adminAccess/runElevatedEffect';
import { resolveMachineEffectCli } from '@/machines/adminAccess/machineEffectCli';
import { createMachineRebootAction, type DaemonMachineRebootRoutes, type MachineRebootDirectTargetInvocation } from '@/daemon/lifecycle/machineReboot';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import type { MachineMetadataFieldReadV1, MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import { getMachineSetupDesiredV1, mutateMachineSetupDesiredV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { getMachineAdminAccessV1 } from '@happier-dev/protocol/machines/adminAccessV1';
import type { MountedAccountPluginExecutionSelectionResolver } from '@/plugins/runtime/invocation/mountedPluginInvocationCaller';
import { registerDaemonMachineResourcesPolicyRpcHandlers, type DaemonMachineResourcesPolicyRoutes } from '@/rpc/handlers/daemonMachineResourcesPolicy';
import { registerDaemonMachineRolesRpcHandlers, type DaemonMachineRolesRoutes } from '@/rpc/handlers/daemonMachineRoles';
import { registerDaemonMachineIsolationRpcHandlers, type DaemonMachineIsolationRoutes } from '@/rpc/handlers/daemonMachineIsolation';
import { registerDaemonMachineGuardRpcHandlers, type DaemonMachineGuardRoutes } from '@/rpc/handlers/daemonMachineGuard';
import { createMachineAgentInventoryPublication, type MachineAgentInventoryObservation } from '@/capabilities/snapshots/machineAgentInventory';
import { dispatchActionFromRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { registerDaemonStorageRpcHandlers, type DaemonStorageRoutes } from '@/rpc/handlers/storage';
import { StoredMachinePublishedMetadataV1Schema, StoredMachinePublishedDaemonStateV1Schema, projectMachinePublishedMetadataFromRowV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1, TeamCredentialExternalProviderOperationRetireV1Schema, TeamCredentialExternalProviderOperationRetireResponseV1Schema } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import { MachineLiveStreamDecodedEnvelopeV1Schema, MachineLiveStreamRelayEnvelopeV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { hasMachineLiveStreamSensitiveContentV1, sealMachineLiveStreamEnvelopeV1, openMachineLiveStreamEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';
import type { MachineLiveStreamPayloadErrorCodeV1, MachineLiveStreamWireEnvelopeV1 } from '@happier-dev/protocol';
import { isDeepStrictEqual } from 'node:util';
import { sameProviderConnectionsDirectMaterial } from '@/providers/lifecycle/currentAccountSettingsSnapshot';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readStoredCredentials, readStoredCredentialsForServerId, sameStoredCredentials, type StoredCredentials } from '@/persistence';
import { createExecutionRunRpcApprovalDeps } from '@/rpc/handlers/executionRuns/createExecutionRunRpcApprovalDeps';
import { createAccountScopedProviderModelProjectionReader } from '@/providers/modelManagement/remoteProjection';
import { createExecutionRunManagedProviderEndpointPreparer } from '@/agent/runtime/bridges/executionRun/runtime/managedProvider';
import { registerMachineAccessLossReceiver } from '@/daemon/externalActions/registerMachineAccessLossReceiver';
import {
    readCurrentMessageActionReferenceRowV1,
    resolveMessageActionReferenceSnapshotV1,
} from '@/api/session/messageActionReference';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { EXTERNAL_SESSION_SOURCE_UNAVAILABLE_OCCURRENCE_EVENT_V1 } from '@happier-dev/protocol/sessions/external/secureRefreshV1';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import type { FeaturesResponse, IrohEndpointDescriptorV1, ActionOperationRevisionEphemeralV1, ConnectedServiceExecutionAuthorityV1, ExternalSessionSourceUnavailableOccurrenceV1 } from '@happier-dev/protocol';
import type { MachineSetupTargetUnavailableFailureV1 } from '@happier-dev/protocol/actions/operations/v1';
import { signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { fetchAccountProfile } from './accountProfile';
import { fetchAccountEncryptionCurrentness, AccountEncryptionCurrentnessUnavailableError } from './client/connectedServiceCredentialApi';
import { acquireRequesterAccountEncryptionCurrentness, waitForObservation } from './client/accountEncryptionCurrentnessObservation';
import { logger } from '@/ui/logger';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';
import { configuration } from '@/configuration';
import { projectRpcRequesterWorkAttribution } from '@/daemon/lifecycle/requesterWorkAttribution';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { classifyTransportErrorToProbeResult } from '@/api/connection/classifyTransportErrorToProbeResult';
import { resolveMachinePendingResetStartCapability, resolveMachineSessionInputAdmissionCapability } from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import { createCurrentMachineExecutionOriginContextResolver } from './machine/resolveCurrentMachineExecutionOriginContext';
import { assertResolvedHomeTargetIdentity, HomeTargetResolutionError } from '@happier-dev/cli-common/homeTarget';
import { resolveCliHomeTarget } from '@/server/homeTarget';
import { MachineInstallationPublicIdentityV1Schema, type MachineInstallationPublicIdentityV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { ProjectWorkerDependencyV1Schema } from '@happier-dev/protocol/workspaces/projectWorkerExecutionV1';
import { isWorkspaceSyncSourceWriterCleanupPhaseV1 } from '@happier-dev/protocol/socketRpc';
import { WorkspaceSyncCommittedCopyPreviewResultV1Schema, WorkspaceSyncCommittedCopyTargetResultV1Schema, WorkspaceSyncCommittedCopyInspectV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncCommittedCopyV1';
import { USAGE_SOURCES_INVALIDATION_EVENT_V1, type UsageSourcesInvalidationV1 } from '@happier-dev/protocol/usage/usageSources';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readRequesterAccountActionContext, type RequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { prepareAcquiredFileDownload } from '@/machines/transfer/prepareWorkspaceFileExport';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { resolveSessionRpcContent } from '@/session/transport/rpc/sessionRpc';
import { isV2ChangesSyncEnabled } from '@/api/session/sessionChangesSyncOnConnect';
import { createMachineSkillHostService, resolveMachineSkillInstallTarget } from '@/prompts/skills/machineInstall/machineSkillHost';
import { createMachineSkillActionExecutor } from '@/prompts/skills/machineInstall/machineSkillActionExecutor';
import { createExternalActionMachineRpcExecution, verifyExternalActionExecutionAuthorizationCurrent } from './externalActionExecutionAuthorization';
import { externalActionTargetsEqualV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { PendingActivationRequestedEphemeralV1Schema, type SessionInputMachineTargetV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1, SessionMessageReplyMachineMutationV1Schema,
    SessionMessageReplyMutationResultV1Schema, SessionMessageReplyPendingHintV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { recoverSessionMessageRepliesForMachine } from '@/session/services/sessionMessageReply';

import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import { callSocketRpc, isSocketIoAckTimeoutError, markRpcRequestDisposition, type RpcRequestDisposition, type SocketRpcContent } from '@happier-dev/sync-client';
import type { SessionActionRpcTransport } from '@/session/actions/createCliActionDeps';
import { readRpcErrorCode, RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncTargetRoutingV1Schema,
    WorkspaceSyncSeedRoutingV1Schema, type WorkspaceSyncSeedRoutingV1,
    WorkspaceSyncSourceWriterTargetRoutingV1Schema, type WorkspaceSyncSourceWriterTargetRoutingV1,
    type WorkspaceSyncSourceRoutingV1, type WorkspaceSyncTargetRoutingV1 } from '@happier-dev/protocol/socketRpc';
import { createWorkspaceSyncTargetContent } from './rpc/workspaceSyncTargetContent';
import { createWorkspaceSyncSourceOperationContinuation } from './rpc/workspaceSyncOperationContinuation';
import { WorkspaceSyncHandoffSourcePhaseRequestV1Schema, WorkspaceSyncHandoffSourcePhaseResultV1Schema,
    HandoffTargetReplacementPreflightResultV1Schema, WorkspaceSyncTargetBootstrapPrepareResultV1Schema,
    WorkspaceSyncTargetBootstrapReleaseResultV1Schema,
    type WorkspaceSyncHandoffSourcePhaseRequestV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { WorkspaceSyncSeedExportPrepareV1Schema, type WorkspaceSyncSeedExportPrepareV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { buildActionExecutorContextForRpc, projectWorkspaceSyncPhysicalContextFromActionContext, type RpcActionExecutor, type RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { isExternalActionAuthorizationBoundToEnvelope } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { isWorkspaceSyncRelationshipWriteActionId } from '@happier-dev/protocol/actions/actionIds';
import { OpenProjectInputV1Schema, OpenProjectResultV1Schema, ProjectOpenSyncMaterializationResultV1Schema, type OpenProjectInputV1, type OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { WorkspaceSyncPrepareBetweenRequestV1Schema, WorkspaceSyncPrepareBetweenResultV1Schema, type WorkspaceSyncPrepareBetweenRequestV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { decodeBase64 } from './encryption';
import { resolveWorkspaceSyncTransportAddress } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { readWorkspaceSyncChildMachineFacts } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { readWorkspaceSyncSourceAdmissionV1, deriveWorkspaceSyncRelationshipId } from '@happier-dev/protocol/actions/externalActionApi';
import type { WorkspaceSyncTargetPhaseDescriptor } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { applyWorkspaceFileReplace, previewWorkspaceFileReplace } from '@/rpc/handlers/workspaceFileReplace';
import { registerLanguageIntelligenceHandlers } from '@/rpc/handlers/languageIntelligence';
import { createMachineSharedProviderGatewayResolver } from '@/providers/lifecycle/sharedGatewayIdentity';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import { registerAutomationReplyHandoffRpcHandler } from '@/rpc/handlers/automationReplyHandoff';
import { createWorkflowRunStorageClient } from '@/daemon/workflows/workflowRunStorageClient';
import {
    resolveExternalSessionOperationAccountScope,
    type ExternalSessionOperationAccountScope,
} from '@/session/actions/externalSessions/operationRecordStore';
import { callExactMachineRpc, callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { createSessionHandoffPreflightMachineRpc } from '@/session/handoff/sessionHandoffPreflightMachineRpc';
import { createSessionHandoffSourceExportStore } from '@/session/handoff/state/sessionHandoffSourceExportStore';
import {
    createTrackedSessionHandoffCoordinator,
    createHostActionOperationRuntime,
    runHostActionOperation,
    type HostActionOperationRuntime,
} from '@/daemon/actionOperations';
import type { WorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import {
    registerDaemonLocalServicePreviewSnapshotHandler,
} from '@/rpc/handlers/daemonLocalServicePreviewSnapshot';
import {
    registerDaemonLocalServicesMachineRpcHandlers,
    type DaemonLocalServicesMachineRpcRoutes,
} from '@/rpc/handlers/daemonLocalServices';
import {
    registerDaemonMachineVitalsRpcHandlers,
    type DaemonMachineVitalsRoutes,
} from '@/rpc/handlers/daemonMachineVitals';
import { registerDaemonScheduledRpcHandlers } from '@/rpc/handlers/daemonScheduled';
import { registerDaemonProcessesRpcHandlers, type DaemonProcessesRoutes } from '@/rpc/handlers/daemonProcesses';
import { registerDaemonDeploymentChildRpcHandler } from '@/deployments/daemonDeploymentChildRpc';
import {
    registerDaemonBrowserControlHandler,
    registerDaemonBrowserViewWatchHandler,
} from '@/rpc/handlers/daemonBrowserControl';
import { registerDaemonComputerHandler } from '@/rpc/handlers/daemonComputer';
import { registerMachineLiveStreamSourceAdmissionHandler } from '@/daemon/peer/mediation/stream/sourceAdmission';
import { registerManagedFiniteWake } from '@/rpc/handlers/managedFiniteWake';
import {
    registerDaemonBrowserContextHandler,
} from '@/rpc/handlers/daemonBrowserContext';
import {
    registerDaemonBrowserDiagnosticsSnapshotHandler,
} from '@/rpc/handlers/daemonBrowserDiagnosticsSnapshot';
import {
    registerDaemonBrowserRecordingHandlers,
} from '@/rpc/handlers/daemonBrowserRecording';
import {
    registerDaemonSimulatorPreviewHandlers,
} from '@/rpc/handlers/daemonSimulatorPreview';
import {
    registerDaemonLiveStreamRelayHandlers,
    type DaemonLiveStreamRelayRoutes,
} from '@/rpc/handlers/daemonLiveStreamRelay';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem';
import { prepareNativeFilesystemEffect } from '@/rpc/handlers/fileSystem/prepareNativeFilesystemEffect';
import { createFilesystemEffectRpcOwner, createFilesystemEffectTransferAdapter } from '@/rpc/handlers/fileSystem/filesystemEffectChannel';
import type { FilesystemEffectRequester } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import type { NativeTransferSessionOwner } from '@happier-dev/transfers/node';
import { isHostRequesterUnrestrictedOwner, resolveHostRequesterAgentPlacementForHost } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { resolveServerRoutedTransferMaxBytes } from '@/transfers/policy/serverRoutedTransferPolicy';
import { createProjectDefinitionAction, registerProjectDefinitionHandlers } from '@/rpc/handlers/projectDefinitions';
import { projectNativeSystemIo } from '@/workspaces/projectSetup/projectNativeSystemIo';
import { executeFilesystemMutationAction } from '@/rpc/handlers/fileSystem/pathMutationHandlers';
import { projectVerifiedExternalActionRequesterContext } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { createReadFileRpcActionExecutor } from '@/rpc/handlers/fileSystem/readFileHandler';
import { currentWorkspaceSource, runWithWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { createWriteFileRpcActionExecutor } from '@/rpc/handlers/fileSystem/writeFileHandler';
import { createDirectoryRpcActionExecutor } from '@/rpc/handlers/fileSystem/directoryHandlers';
import { FILESYSTEM_BROWSER_ACTION_IDS_V1, FILESYSTEM_MUTATION_ACTION_IDS } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { createPreparedFilesystemTransferActionExecutor, projectPreparedFilesystemActionResult } from '@/machines/transfer/createPreparedFilesystemTransferActionExecutor';
import type { DirectTransferServerLifecycle } from '@/machines/transfer/directTransferServerLifecycle';
import { deliverScmFileAtRevision, prepareScmFileBytesExport } from '@/scm/actions/deliverScmFileAtRevision';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { registerMachineFileBrowserHandlers } from '@/rpc/handlers/machineFileBrowser/registerMachineFileBrowserHandlers';
import { registerWorkspaceAnchorHandlers } from '@/rpc/handlers/workspaceAnchors/registerWorkspaceAnchorHandlers';
import { registerWorkspaceFaviconHandlers } from '@/rpc/handlers/workspaceFavicon/registerWorkspaceFaviconHandlers';
import { backoff } from '@/utils/time';
import { createConnectedServicesProjectionRetryScheduler } from './connectedServices/connectedServicesProjectionRetryScheduler';
import { isConnectedServiceGenerationReconciliationNotAcknowledgeableError } from '@/daemon/connectedServices/accountGroups/generation/reconcileConnectedServiceAuthGroupGenerations';
import {
    RpcHandlerManager,
    type RpcHandlerRegistrationReadiness,
} from './rpc/RpcHandlerManager';
import type { RpcHandlerActiveExecution, RpcHandlerContext, RpcLocalActionContext } from './rpc/types';
import type { PeerMachineRpcDirectHandlerManager } from '@/daemon/peer/mediation/rpc/registerRoutes';
import { SOCKET_RPC_EVENTS, type SocketRpcAnsweringClientV1 } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SessionCreationTargetPreparationRequestV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import { SocketRpcAnsweringClientCandidatesV1Schema, type SocketRpcAnsweringClientCandidateV1 } from '@happier-dev/protocol/socketRpc';
import { isCurrentUiContextClientRpcMethod } from '@happier-dev/protocol/actions/clientDispatchV1';
import { EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1 } from '@happier-dev/protocol/sessions/external/operationActionsV1';
import { EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1 } from '@happier-dev/protocol/sessions/external/statusDemandV1';
import { MACHINE_LIVE_STREAM_SOCKET_EVENT } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT } from '@happier-dev/protocol/machines/peer/mediation/tunnel/relay';
import { TRANSFER_RELAY_V2_SOCKET_EVENT } from '@happier-dev/protocol/transfers/relay/v2/socketEvents';
import type { ExternalSessionTranscriptInvalidationV1, ExternalSessionOperationSocketCommandV1, ExternalSessionOperationSocketResponseV1, ExternalSessionStatusDemandDaemonMessageV1, MachineLiveStreamRelayEnvelopeV1, MachineTransferReceiveEnvelope, MachineTransferSendEnvelope, PeerTcpTunnelRelayEnvelope, ExactSessionTurnEndMutationV1, TransferRelayV2SendEnvelope } from '@happier-dev/protocol';
import { fetchChanges, fetchChangesAccountId } from './changes';
import { hasUsablePushedChangesPage, MACHINE_ACCOUNT_CHANGE_KINDS, readPushedChangesPage, takePushedChangesPage, type QueuedPushedChangesPage } from './machine/machineAccountChangePages';
import { buildProjectAccountRowPhysicalKeyV1, ProjectAccountRowChangeHintV1Schema, type ProjectAccountRowKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { readAccountChangesCursor, writeAccountChangesCursor } from '@/persistence';
import {
    publishPluginAccountCollectionWatchInvalidation,
    publishPluginAccountAvailabilityChanges,
    publishPluginAccountSettingsWatchInvalidation,
    notePluginAccountSettingsChangeFeedRunning,
    readPluginAccountCollectionWatchInvalidations,
    readPluginAccountSettingsWatchInvalidations,
    retirePluginAccountCollectionWatchScope,
} from '@/plugins/runtime/context/pluginAccountSettingsChangeBroker';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { hydrateSavedSecretCatalog } from "@/settings/secrets/savedSecretCatalogRead";
import { createExecutionRunAccountSettingsSnapshotResolver } from './machine/resolveExecutionRunAccountSettingsSnapshot';
import { changesRequireSavedSecretCatalogRefresh } from '@/settings/secrets/savedSecretCatalogChangeInvalidation';
import { isProfileCatalogAccountChangeEntityIdV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { refreshDemandedActiveProfileCatalog, refreshDemandedActiveApprovalProfileCatalog } from '@/settings/profiles/hydrateProfileCatalog';
import { artifactKindsMayIncludeKindV1, readArtifactKindsChangeHintV1 } from '@happier-dev/protocol/changes';
import { launchProfileArtifactSharingAdapterV1 } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import { APPROVAL_PROFILE_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/actions/approvalProfileArtifactV1';
import { parsePromptLibraryPhysicalKeyV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { prepareActivePromptLibraryRecord, readActiveMachineSkillInstallArtifactIds, refreshDemandedActivePromptLibraryCatalog,
    type MachineSkillInstallCatalogDemand } from '@/settings/prompts/hydratePromptLibraryCatalog';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
    isActiveAccountSettingsSnapshotLifetimeCurrent } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { refreshDemandedActiveProviderConnectionsCatalog } from '@/providers/settings/hydrate';
import { PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { refreshDemandedActiveMcpServerCatalog } from '@/settings/mcp/hydrateMcpServerCatalog';
import { MCP_SERVER_CATALOG_ACCOUNT_KEY_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { refreshDemandedActiveNotificationChannelCatalog } from '@/settings/notifications/hydrateNotificationChannelCatalog';
import { ACP_CATALOG_ACCOUNT_ROW_KEY_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { refreshDemandedActiveAcpCatalog } from '@/agent/acp/catalog/hydrateAcpCatalog';
import { refreshDemandedActiveConnectedAccountCatalogs } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';
import { parseConnectedAccountCatalogPhysicalKeyV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { refreshDemandedActiveConnectedMetadataCatalog } from '@/settings/connected/hydrateConnectedMetadataCatalog';
import {
    captureServerHttpBaseUrl,
    resolveServerHttpBaseUrl,
    resolveServerSocketIoTransports,
    runWithServerHttpBaseUrl,
} from './client/serverHttpBaseUrl';
import { createAuthenticationHttpStatusError, isAuthenticationError, isAuthenticationStatus, readHttpStatus } from './client/httpStatusError';
import { classifyServerEndpointError } from './client/classifyServerEndpointError';
import { serializeAxiosErrorForLog } from './client/serializeAxiosErrorForLog';
import { handleRequestAuthenticationFailure } from '@/api/connection/requestSupervision/reportRequestOutcomeToSupervisor';
import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import {
    createSessionSyncPendingInputServerContractController,
    type SessionSyncPendingInputServerContractResult,
} from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import { MACHINE_HEARTBEAT_INTERVAL_MS } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { createTransientSessionMediaReadAllowance } from '@/session/media/readAllowance';
import type { LocalServicePreviewRoutes } from '@/daemon/local/services/preview/routes';
import type { DevicesRoleMachineRoutes } from '@/daemon/roles/devices/types';
import type { ConnectedAccountDaemonRuntime } from '@/daemon/connectedServices/ConnectedAccountDaemonRuntime';
import type { DaemonConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { prepareRequesterOperationMaterial } from '@/daemon/connectedServices/purposeBindings/requesterOperationMaterial';
import { prepareFiniteConnectedAccountProcessEnvironment, type SessionConnectedAccountProcessEnvironmentProducer } from '@/daemon/connectedServices/materialize/processConnectedAccountEnvironment';
import { resolveSystemToolLaunchPurposeDeclarations } from '@/daemon/connectedServices/requestAuth/agentPurposeDeclarations';
import type { AgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';

import type { DaemonToServerEvents, ServerToDaemonEvents } from './machine/socketTypes';
import { isMachineProjectionChangeKindV1, readAuthoritativeSessionDeletionChangeV1, readSessionTranscriptChangeHintV1, readSessionTranscriptRevisedV1, readSessionFollowSourceChangedV1, readSessionFollowReceiverAvailabilityChangedV1, readSessionMemoryInputsChangedV1, readSessionMemoryPushedFactsV1, TEAM_CREDENTIAL_MATERIAL_ACCOUNT_CHANGE_ENTITY_ID_V1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import {
    registerMachineRpcHandlers,
    type MachineRpcHandlerDeps,
    type MachineRpcHandlers,
    type MachineRpcLifecycleRegistration,
} from './machine/rpcHandlers';
import type { ExternalActionIngressOwner } from '@/rpc/handlers/externalAction';
import {
    createMachineContentCodec,
    type MachineContentCodec,
} from './machine/machineStoredContent';
import { resolveMachineLiveStreamFramePayloadByteLimit } from './machine/liveStreamFrameBudget';
import {
    registerMachineConnectedAccountRpcHandlers,
    type ConnectedServicePoolSelectionRead,
} from './machine/rpcHandlers.connectedAccounts';
import { authorizeMachineRpcRequest,
    readMachineRpcAdmissionCurrent, doesWorkspaceSyncSourceRootMatchRouting, doesWorkspaceSyncSourceWriterTargetRootMatchRouting, doesWorkspaceSyncSeedRootMatchRouting,
    doesWorkspaceSyncTargetRequestMatchRouting, doesWorkspaceSyncTargetRoutingMatchWriterTarget,
    readWorkspaceSyncTargetMethod, admitSameMachineWorkspaceSyncTargetPhase, type MachineRpcAdmissionBoundary } from './machine/machineRpcAuthorization';
import type { MachineTerminalAccountReadRuntime, MachineTerminalOwnSessionReadRuntime } from './machine/rpcHandlers.terminal';
import { resolvePrivateWorkspaceSyncTargetExecution } from './machine/rpcHandlers.workspaceSync';
import { resolveAdmittedRequesterAccountReadRuntime } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { inspectProjectSetupFromRuntime, readProjectEffectiveDefinitionFromRuntime } from '@/workspaces/projectSetup/projectSetupReadiness';
import type { ManagedActivityRpcOwner } from './machine/rpcHandlers.managedActivity';
import type { MachineWorkSummaryRpcOwner } from './machine/rpcHandlers.machineWorkSummary';
import { createAccountServerActionDeps } from './accountServerActionDeps';
import { createLiveWorkProducerGroup, type LiveWorkInventoryV1 } from '@/daemon/lifecycle/managedActivity';
import { createExecutionBudgetRegistry } from '@/daemon/executionBudget/createExecutionBudgetRegistry';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { projectIncomingMachineRpcDebugPayload } from './machine/projectIncomingMachineRpcDebugPayload';
import { projectMachineRpcTransportAcknowledgement } from './machine/projectMachineRpcTransportAcknowledgement';
import { resolveMachineRpcWorkingDirectory } from './machine/resolveMachineRpcWorkingDirectory';
import {
    resolveFilesystemAccessPolicy,
    type FilesystemAccessPolicy,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { createTransferSessionLifecycle } from '@happier-dev/transfers/node';
import { isAgentInventoryRead, assertFilesystemEffectCurrent, createFilesystemEffectAdmission, createFilesystemEffectRpcRegistrar } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createActiveDaemonComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';
import type { TransferRelayV2DownloadSessionOwner } from '@/machines/transfer/transferRelayV2DownloadSessionTransport';
import type { Socket } from 'socket.io-client';
import {
    createManagedConnectionSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ManagedConnectionState,
    type ManagedConnectionSupervisor,
    type ReadinessProbeResult,
} from '@happier-dev/connection-supervisor';
import { createLoopbackReadinessProbe } from '@/api/connection/createLoopbackReadinessProbe';
import { createMachineSocketTransport } from '@/api/machine/connection/createMachineSocketTransport';
import {
    CURRENT_SESSION_RUNTIME_OPERATION_PROTOCOL_CAPABILITIES_V1,
    publishMachineOperationProtocolCapabilitiesOnSocket,
} from '@/api/machine/publishMachineOperationProtocolCapabilities';
import { publishSessionFollowWakeInvalidation } from '@/agent/runtime/session/follow/sessionFollowWakeSignal';
import { readSessionFollowReceiverChangeV1 } from '@happier-dev/protocol/sessions/follow/changes';
import { readMachineOwnerConflictFromSocketError, type MachineOwnerConflictDetails } from '@/api/machine/machineOwnerConflict';
import { readAccountSettingsVersionFromHint } from '@/settings/accountSettings/accountSettingsVersion';
import { buildInstallationProofForMachine } from '@/daemon/identity/proof';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import {
    emitSocketWithAck,
    SocketAckAbortError,
    SocketAckError,
} from '@/session/transport/shared/socketAck';
import { resolveSessionControlSocketAckTimeoutMs, resolveSessionMessageAdmissionTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import {
    createDaemonSessionClientDurableMutationOutbox,
    type DaemonSessionClientDurableMutationOutbox,
} from './session/client/transport/mutations/createDaemonSessionClientDurableMutationOutbox';
import {
    discoverDaemonSessionClientDurableMutationJournalSessionIds,
} from './session/client/transport/mutations/sessionClientDurableMutationPersistence';
import { MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1, MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1, MachineSessionTerminalCaptureResponseV1Schema, MachineSessionTerminalFinalizeResponseV1Schema } from '@happier-dev/protocol/sessions/control/machineSessionTerminalV1';
import { SESSION_SERVER_START_DAEMON_RPC_METHOD_V1, SESSION_SERVER_START_INGRESS_EVENT_V1, SessionServerStartDispatchResultV1Schema, SessionServerStartIngressRequestV1Schema, SessionServerStartIngressResponseV1Schema } from '@happier-dev/protocol/sessions/creation/sessionServerStartV1';
import { SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, SessionPendingEnqueueByMachineRequestV1Schema, SessionPendingEnqueueByMachineResponseV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2, SessionPendingExecutionRunEnqueueByMachineRequestV2Schema, SessionPendingExecutionRunEnqueueByMachineResponseV2Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingExecutionRunMachineAdmissionV2';
import type { SessionPendingExecutionRunEnqueueByMachineRequestV2, MachineOperationProtocolCapabilitiesV1, MachineSessionTerminalAuthorityV1, MachineSessionTerminalCaptureResponseV1, MachineSessionTerminalFinalizeResponseV1, SessionPendingEnqueueByMachineRequestV1, SessionServerStartDispatchResultV1, SessionServerStartIngressRequestV1 } from '@happier-dev/protocol';
import type { SessionInputEnqueueResultV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { ACCOUNT_STORED_CONTENT_SESSION_SPAWN_PLACEMENT_ORIGIN_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';

import { createActionOperationSnapshotPublisher, emitActionOperationSnapshotV1 } from './machine/actionOperationSnapshotPublisher';
export { createActionOperationSnapshotPublisher, emitActionOperationSnapshotV1 } from './machine/actionOperationSnapshotPublisher';

export type AccountSettingsVersionHintSource = 'changes' | 'cursor-gone' | 'page-limit';

const REQUIRED_MACHINE_CONTROL_RPC_METHODS = Object.freeze([
    RPC_METHODS.SPAWN_HAPPY_SESSION,
    RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    RPC_METHODS.SESSION_SPAWN_NEW,
    RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
    RPC_METHODS.STOP_SESSION,
    SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
    RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET,
]);
const MACHINE_CONTROL_RPC_REGISTRATION_TIMEOUT_MS = 10_000;

// Published only after the authenticated Machine enqueue and exact target
// settlement paths are both installed. The server uses this leaf as a strict
// admission prerequisite, so absent/older daemons continue to fail closed.
export const CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1:
    MachineOperationProtocolCapabilitiesV1 = Object.freeze({
        ...CURRENT_SESSION_RUNTIME_OPERATION_PROTOCOL_CAPABILITIES_V1,
        // Ordinary and restricted Session construction always installs the exact
        // Session/reconnect -> process Follow wake consumer. AccountChange adds
        // completeness invalidation when its optional feed is enabled.
        sessionFollow: { contextV1: true, wakeOnHumanChangeV1: true },
        sessionInputAdmission: { protocolVersions: [1, 2, 3] as const },
        sessionSpawn: { protocolVersions: [1, 2] as const },
        pluginWebhookClaim: { protocolVersions: [1] },
        externalActionExecutionAuthorization: { protocolVersions: [1] },
    });

export type AccountSettingsVersionHintNotification = Readonly<{
    settingsVersion: number | null;
    source: AccountSettingsVersionHintSource;
}>;

export type AccountProjectRowsChangeNotification = Readonly<{
    source: 'changes' | 'connect' | 'reconnect' | 'cursor-gone' | 'page-limit';
    signal: AbortSignal;
    /** Present only for complete live pages; recovery notifications require a complete read. */
    keys?: readonly ProjectAccountRowKeyV1[];
}>;

export type PendingSessionActivationHintNotification = Readonly<{
    sessionId: string;
    requestId: string;
    pendingVersion: number;
    source: 'changes' | 'live';
    target?: SessionInputMachineTargetV1;
    requestedAt?: number;
}>;

export type SessionTranscriptRevisionNotification = Readonly<{
    sessionId: string;
    seq: number;
    messageId?: string;
    cursor: number;
}>;

export type SessionChangeNotification = Readonly<{
    sessionId: string;
    cursor: number;
    /** The consumed Account range proves that only a non-source projection changed. */
    followSourceChanged?: false;
    /** Absent on older servers; false excludes unrelated receiver publications. */
    followReceiverAvailabilityChanged?: boolean;
    /** The consumed Account range proves daemon Memory inputs unchanged (activity/presence/ready only). */
    memoryInputsChanged?: false;
    /** Memory facts the change row carries (`readSessionMemoryPushedFactsV1`). */
    pushed?: Readonly<{ transcriptSeq?: number; localityUnchanged?: true }>;
    /** A removal callback in this batch owns derived-state cleanup. */
    removed?: true;
}>;

export type SessionDeletedChangeNotification = Readonly<{
    sessionId: string;
    cursor: number;
    /**
     * Pinned operation scope of the authenticated Account whose changes feed
     * delivered this durable deletion fact. Authoritative cleanup targets
     * exactly this Account's partition even if the ambient credentials rotate
     * before the listener runs.
     */
    accountScope: ExternalSessionOperationAccountScope;
}>;

/**
 * Durable Account-relative loss of access to a Session, proven by the
 * `/v2/changes` Session-access witness. Unlike a physical deletion it carries
 * no lifecycle hint: the witness itself is the authority. Consumers that hold
 * derived local state for the Session must clear it before the Account change
 * cursor advances, so the fact replays when their cleanup fails.
 */
export type SessionAccessRevokedNotification = Readonly<{
    sessionId: string;
    cursor: number;
}>;

/**
 * The Account change cursor is no longer replayable. Consumers with finite
 * derived Session state must re-check that retained set before the replacement
 * cursor is acknowledged.
 */
export type SessionAccessResetNotification = Readonly<{
    cursor: number;
}>;

export type ManagedProviderRetainedCurrentnessInvalidation = ProviderBrokerRetainedCurrentnessInvalidation & Readonly<{
    source: 'connect' | 'reconnect' | 'changes' | 'page-limit' | 'cursor-gone';
    signal: AbortSignal;
}>;

export type ConnectedServicesProjectionNotification = Readonly<{
    source: AccountSettingsVersionHintSource | 'startup' | 'reconnect' | 'live';
    executionAuthority: ConnectedServiceExecutionAuthorityV1;
    signal: AbortSignal;
    connectedServicesV2: unknown;
    connectedServiceCredentialRevisionsV1: unknown;
    /** Absent means all services (including startup, reconnect and retained self hints). */
    connectedServiceRefs?: readonly QualifiedConnectedAccountServiceRef[];
    quotaRefreshRecordIds?: readonly string[];
    quotaRefreshOnly?: boolean;
}>;

export type ApiMachineClientLifecycleDependencies = Readonly<{
    acquireServiceExportForward?: import('@/deployments/targets/ownServer/ownServerDeploymentHostRuntime').OwnServerDeploymentRuntimeHostInput['acquireServiceExportForward'];
    /** The operation owner retains Project Open receipts in its existing device-local storage. */
    projectOpenReceiptPersistence?: Parameters<typeof createHostActionOperationRuntime>[0]['projectOpenReceiptPersistence'];
    /** The authenticated daemon's captured credential owner for admitted deployment children. */
    installedCredentials?: StoredCredentials;
    /** Current daemon control listener port, published only after machine-control readiness. */
    controlPort?: number;
    /** Publish this client’s acknowledged control readiness to daemon-local status. */
    onMachineControlReadinessChange?: (ready: boolean) => void;
    /** A committed Workflow original return wakes the incumbent custody reader. */
    onWorkflowReplyReturned?: (workflowRunId: string) => Promise<void>;
    /** The daemon's one outside-install copy owner consumes current Prompt Library reads. */
    machineSkillInstalls?: MachineSkillInstallCatalogDemand & Readonly<{
        refresh(input: Readonly<{ signal: AbortSignal; artifactIds?: readonly string[] }>): Promise<void>;
    }>;
    readSpawnFailureLimits?: MachineRpcHandlerDeps['readSpawnFailureLimits'];
    ownerRemainder?: MachineRpcHandlerDeps['ownerRemainder'];
    agentIsolation?: MachineRpcHandlerDeps['agentIsolation'];
    readMachineEffectiveCores?: MachineRpcHandlerDeps['readMachineEffectiveCores'];
    requesterSessionRuntime?: MachineRpcHandlerDeps['requesterSessionRuntime'];
    requesterBootstrapBoundary?: MachineRpcHandlerDeps['requesterBootstrapBoundary'];
    managedActivity?: Pick<ManagedActivityRpcOwner, 'activity' | 'admissionDrain'>;
    /** Same installed lifecycle owners. Policy and installation remain ApiMachine-owned. */
    machineReboot?: Omit<DaemonMachineRebootRoutes, 'target' | 'inventory' | 'admissionDrain'> & Readonly<{
        spawnElevation?: MachineElevationDependencies['spawn'];
    }>;
    /** Pure observation of the daemon's incumbent Project admission. */
    readProjectFiniteLoad?: MachineWorkSummaryRpcOwner['readFiniteLoad'];
    createProjectFiniteRuntime?: MachineRpcHandlerDeps['createProjectFiniteRuntime'];
    /** Reference to the daemon's incumbent prepared-transfer lifecycle, never a second owner. */
    directPeerServerLifecycle?: DirectTransferServerLifecycle;
    /** The authenticated ApiClient owns published-key resolution and decoding. */
    loadMachine?: (options?: Readonly<{ signal?: AbortSignal }>) => Promise<Machine | null>;
    /** Invalidate demanded consumers after opened metadata changes or its context retires. */
    onMachineMetadataChanged?: () => void;
    /** Authorized finite-operation inspection reevaluates the incumbent admission queue. */
    onProjectOperationInspection?: Parameters<typeof createHostActionOperationRuntime>[0]['onInspection'];
    liveStreamCaptureRegistry?: import('@/daemon/peer/mediation/stream/captureRegistry').MachineLiveStreamCaptureRegistry;
    resolveHostedSessionWorkingDirectory?: (sessionId: string) => Promise<string | null>;
    isDaemonQuiescing?: () => boolean;
    /** Pure read of the incumbent daemon feature store; projection pages never refresh it. */
    getServerFeaturesSnapshot?: () => Awaited<ReturnType<typeof fetchServerFeaturesSnapshot>> | undefined;
    resolveServerFeaturesSnapshot?: () => Promise<Awaited<ReturnType<typeof fetchServerFeaturesSnapshot>> | undefined>;
    /** Existing authenticated connection projection; never fetch or infer Home per input frame. */
    resolveCurrentServerIdentityId?: () => string | null;
    createCapabilitiesApiClient?: MachineRpcHandlerDeps['createCapabilitiesApiClient'];
    /** Test seam for the canonical Resource lifecycle owner. */
    resourceSessionLifecycle?: Pick<
        PluginReloadController,
        'applyResourceSessionAccessWitness'
    >;
    /** Daemon-owned workspace-sync adapter shared with the canonical handoff coordinator. */
    workspaceSyncHandoffAdapter?: WorkspaceSyncHandoffAdapter;
    /** Daemon-owned workspace-sync controller and target-local RPC authority. */
    workspaceSync?: MachineRpcHandlerDeps['workspaceSync'];
}>;

export type ApiMachineDaemonStatePublicationOptions = Readonly<{
    allowWhileQuiescing?: boolean;
    /** Only the canonical activity subscription supplies this non-persisted hint. */
    managedActivityChanged?: true;
}>;

export type MachinePublicationOutcome = 'published' | 'unchanged' | 'suppressed';

/** Host-local classification; Machine activity is not a new policy scheduling fact. */
export type ManagedMachinePolicyInvalidation = Readonly<{ kind: 'currentness' }>
    | Readonly<{ kind: 'machines'; machineIds: readonly string[] }>
    | Readonly<{ kind: 'managed'; managedIds: readonly string[] }>;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readSocketConnectErrorDiagnostic(error: unknown): Readonly<{
    message?: string;
    name?: string;
    code?: string;
    statusCode?: number;
}> {
    const record = asRecord(error);
    const data = asRecord(record?.data);
    const statusRaw = data?.statusCode ?? data?.status;
    const statusCode = typeof statusRaw === 'number' && Number.isFinite(statusRaw)
        ? statusRaw
        : null;
    return {
        ...(typeof record?.message === 'string' && record.message.trim() ? { message: record.message.trim() } : {}),
        ...(typeof record?.name === 'string' && record.name.trim() ? { name: record.name.trim() } : {}),
        ...(typeof record?.code === 'string' && record.code.trim() ? { code: record.code.trim() } : {}),
        ...(statusCode !== null ? { statusCode } : {}),
    };
}

type SessionFollowSourceInvalidation = Readonly<{ full: boolean; workflowRunIds: readonly string[]; discussionIds?: readonly string[];
    receiverSessionIds?: readonly string[]; continuityReset?: true }>;

function readMachineSocketRetirementReason(error: unknown): 'replaced' | 'revoked' | null {
    const record = asRecord(error);
    const data = asRecord(record?.data);
    const errorCode = typeof data?.error === 'string' ? data.error.trim() : '';
    const message = typeof record?.message === 'string' ? record.message.trim() : '';
    const statusRaw = data?.statusCode ?? data?.status;
    const statusCode = typeof statusRaw === 'number' && Number.isFinite(statusRaw) ? statusRaw : null;
    if (statusCode !== 410) return null;
    if (errorCode === 'machine_revoked') return 'revoked';
    return errorCode === 'machine-replaced' || errorCode === 'machine_replaced' || message === 'machine-replaced'
        ? 'replaced' : null;
}

type AccountChangesSyncDemand = {
    reason: 'connect' | 'reconnect' | 'live';
    requestedCursor?: number;
    /**
     * Transport whose connect/reconnect recovery this demand already completed.
     * Retries of the same demand on that transport retry only the feed; a new
     * transport (the next natural boundary) recovers again.
     */
    recoveredTransportGeneration?: number;
    /** Pages the server read for this socket at fan-out; applied only from a matching cursor. */
    pushedPages?: QueuedPushedChangesPage[];
};

/** `update-machine` fields the live handler applies to held Machine content. */
const UPDATE_MACHINE_CONTENT_FIELDS_APPLIED_LIVE: ReadonlySet<string> = new Set([
    't', 'machineId', 'metadata', 'daemonState', 'devcontainerChild', 'keyBasis', 'dataEncryptionKey',
]);

export class ApiMachineClient {
    private socket: Socket<ServerToDaemonEvents, DaemonToServerEvents> | null = null;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private rpcHandlerManager: RpcHandlerManager;
    private readonly machineRpcAdmissionBoundary: MachineRpcAdmissionBoundary;
    private readonly connectedClientRpcMethods = new Set<string>();
    private hasConnectedOnce = false;
    private accountIdPromise: Promise<string> | null = null;
    private accountEncryptionCurrentness: ReturnType<typeof acquireRequesterAccountEncryptionCurrentness> | null = null;
    private readonly connectedServicesProjectionRetry = createConnectedServicesProjectionRetryScheduler();
    private pendingChangesSyncDemand: AccountChangesSyncDemand | null = null;
    private projectionSchedulingClosed = false;
    private accountChangesObserverTransportGeneration: number | null = null;
    private updateListeners = new Set<(update: Update) => boolean | void>();
    private accountSettingsVersionHintListeners = new Set<(hint: AccountSettingsVersionHintNotification) => void | Promise<void>>();
    private readonly sessionFollowRulesChangedListeners = new Set<(change?: SessionFollowSourceInvalidation) => void | Promise<void>>();
    private accountProjectRowsChangeListeners = new Set<(change: AccountProjectRowsChangeNotification) => void | Promise<void>>();
    private automationEventSourcesInvalidationListeners = new Set<(payload: AutomationEventSourcesInvalidatedHostEventV1) => void | Promise<void>>();
    private readonly healthCheckHeartbeatReceiptListeners = new Set<(receipt: PluginWebhookHeartbeatReceiptHintV1) => void>();
    private automationWorkInvalidationListeners = new Set<() => void | Promise<void>>();
    private pluginWebhookInvalidationListeners = new Set<() => void | Promise<void>>();
    private managedMachinePolicyInvalidationListeners = new Set<(change?: ManagedMachinePolicyInvalidation) => void | Promise<void>>();
    private pendingSessionActivationHintListeners = new Set<(
        hint: PendingSessionActivationHintNotification,
    ) => void | Promise<void>>();
    private sessionDeletedChangeListeners = new Set<(
        change: SessionDeletedChangeNotification,
    ) => void | Promise<void>>();
    private sessionTranscriptRevisionListeners = new Set<(
        change: SessionTranscriptRevisionNotification,
    ) => void | Promise<void>>();
    private sessionChangeListeners = new Set<(
        change: SessionChangeNotification,
    ) => void | Promise<void>>();
    private sessionAccessRevokedListeners = new Set<(
        change: SessionAccessRevokedNotification,
    ) => void | Promise<void>>();
    private sessionAccessResetListeners = new Set<(
        change: SessionAccessResetNotification,
    ) => void | Promise<void>>();
    private managedProviderRetainedCurrentnessListeners = new Set<(
        change: ManagedProviderRetainedCurrentnessInvalidation,
    ) => void | Promise<void>>();
    private connectedServicesProjectionListener: ((notification: ConnectedServicesProjectionNotification) => void | Promise<void>) | null = null;
    private machineTransferListeners = new Set<(payload: MachineTransferReceiveEnvelope) => void>();
    private transferRelayV2Listeners = new Set<(payload: TransferRelayV2SendEnvelope) => void>();
    private peerTcpTunnelRelayListeners = new Set<(payload: PeerTcpTunnelRelayEnvelope) => void>();
    private machineLiveStreamRelayListeners = new Set<(payload: MachineLiveStreamRelayEnvelopeV1) => void>();
    private liveStreamRelayRoutes: DaemonLiveStreamRelayRoutes | null = null;
    private externalSessionStatusDemandListeners = new Set<(payload: ExternalSessionStatusDemandDaemonMessageV1) => void>();
    private connectionStateListeners = new Set<(state: ManagedConnectionState) => void>();
    private connectionSupervisor: ManagedConnectionSupervisor | null = null;
    private daemonTerminalSessionMutationOutboxes = new Map<string, DaemonSessionClientDurableMutationOutbox>();
    private readonly machineRpcWorkingDirectory: string;
    private readonly filesystemAccessPolicy: FilesystemAccessPolicy;
    private externalActionIngressOwner: ExternalActionIngressOwner | null = null;
    private machineGuardLocalAction: ActionExecutorDeps['machineGuardAction'] | null = null;
    private additionalAllowedReadDirs: string[] = [];
    private additionalAllowedWriteDirs: string[] = [];
    private readonly transientSessionMediaReadAllowance = createTransientSessionMediaReadAllowance();
    private readonly fileSystemTransferRelayOwner: TransferRelayV2DownloadSessionOwner;
    private readonly hostLocalUploadRpc: import('./rpc/types').RpcHandlerInvoker;
    private readonly rawTransferHandlers: ReturnType<typeof registerFileSystemHandlers>['rawTransferHandlers'];
    private readonly rpcLifecycleRegistrations: MachineRpcLifecycleRegistration[] = [];
    private executionRunAccountSnapshots: ReturnType<typeof createExecutionRunAccountSettingsSnapshotResolver> | null = null;
    private readonly executionBudgetRegistry = createExecutionBudgetRegistry();
    private readonly readMachineRuntimeServerHttpBaseUrl: () => string;

    private get machineRuntimeServerHttpBaseUrl(): string {
        return this.readMachineRuntimeServerHttpBaseUrl();
    }
    private readonly machineRuntimeServerId = configuration.activeServerId;
    private readonly filesystemEffectAdmission = createFilesystemEffectAdmission({
        readAgentIsolation: () => this.lifecycleDependencies.agentIsolation?.read(),
        // Sessions placed on a target: their Files/Git run in the target, never on this Machine's disk.
        resolveWorkspaceTarget: resolveSessionTargetWorkspace,
        // Filesystem effects consume the receiving connection's authenticated
        // Home, like generic Machine admission, not an advisory saved descriptor.
        resolveHomeServerIdentityId: () => this.machineRpcAdmissionBoundary.resolveHomeServerIdentityId?.()
            ?? Promise.resolve(null),
        resolveHostIdentity: async signal => {
            const installationId = this.machineRpcAdmissionBoundary.resolveInstallationId();
            const custodianAccountId = await this.machineRpcAdmissionBoundary.resolveCustodianAccountId(signal);
            return installationId && custodianAccountId ? { machineId: this.machine.id, installationId, custodianAccountId } : null;
        },
        resolveSessionRequester: async (sessionId, signal) => {
            const owner = this.lifecycleDependencies.requesterSessionRuntime;
            if (!owner || owner.serverId !== this.machineRuntimeServerId) return null;
            const runtime = await owner.resolve(sessionId, undefined, signal);
            if (!runtime) return null;
            const birth = runtime.bootstrap;
            if (birth.getBoundSessionId() !== sessionId || birth.attribution.machineId !== this.machine.id
                || birth.attribution.installationId !== this.machineRuntimeInstallationId
                || signal?.aborted) { await owner.release(runtime); return null; }
            return { bootstrap: birth, dispose: () => owner.release(runtime) };
        },
        executeNativeRpc: async ({ method, input, context, requester, identity }) => {
            // Parse explicit launch intent before native preparation can mutate.
            // The same folder RPC without intent remains a background read.
            const preparation = method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT
                ? SessionCreationTargetPreparationRequestV1Schema.parse(input) : undefined;
            // The capability service already expanded the effective request.
            // Agent inventory consumes an existing member binding; other native
            // capabilities retain their established preparation behavior.
            const agentInventoryRead = isAgentInventoryRead(method, input);
            const channel = await this.openNativeFilesystemChannel({ requester, identity,
                operationKey: context.localActionContext?.operationAcceptance?.operationId
                    ?? context.localActionContext?.actionRequestId ?? context.transportRequestId ?? '',
                signal: context.signal, ingress: context,
                ...(agentInventoryRead || preparation && preparation.prepareAgentIsolationMember !== true
                    ? { allowMemberPreparation: false as const } : {}) });
            try { return await channel.request({ kind: 'filesystem.rpc', method, input }); }
            finally { await channel.dispose(); }
        },
    });
    private readonly machineRuntimeInstallationId = readInstallationIdentityIfExistsSync()?.installationId ?? null;
    private managedActivityPublicationCleanup: (() => void) | null = null;
    private readonly publishDaemonState = createMachineDaemonStatePublication({
        getMachine: () => this.machine,
        shouldSuppress: allowWhileQuiescing => this.shouldSuppressMachinePublication(allowWhileQuiescing),
        prepareWrite: async () => {
            if (!this.machineContentReady) {
                await this.refreshMachineFromServer();
                if (!this.machineContentReady) throw new Error('Machine content key is unavailable');
            }
            if (!this.socket) throw new Error('Machine socket is not connected');
            const codec = this.machineContentCodec;
            return { socket: this.socket, codec, expectedDataEncryptionKey: this.readOwnerEnvelopeForWrite(),
                isCurrent: () => this.machineContentReady && this.machineContentCodec === codec };
        },
        retireAndRefreshContent: async () => { this.retireMachineContent(); await this.refreshMachineFromServer(); },
        needsPersistedIrohEndpointWithdrawal: () => this.pendingPersistedIrohEndpointWithdrawal,
        acknowledgeDaemonStatePublication: () => { this.pendingPersistedIrohEndpointWithdrawal = false; },
        discardUnverifiedIrohEndpoint: state => this.discardUnverifiedIrohEndpoint(state),
        synchronizeIrohMachineEndpointAuthority: (state, hadEndpoint) => this.synchronizeIrohMachineEndpointAuthority(state, hadEndpoint),
    });
    private machineServicesBinding: ReturnType<typeof createApiMachineServicesBinding> | null = null;
    private scheduledObservation: ReturnType<typeof registerDaemonScheduledRpcHandlers> | null = null;
    private machineRebootAction: ReturnType<typeof createMachineRebootAction> | null = null;
    private localServiceStartObservationCleanup: (() => void) | null = null;
    private readonly liveWorkProducer = createLiveWorkProducerGroup(() => {
        const registration = this.rpcLifecycleRegistrations.at(-1);
        return registration?.liveWorkProducers
            ? [this.actionOperationRuntime.activity, ...registration.liveWorkProducers]
            : null;
    });

    getLiveWorkProducer() { return this.liveWorkProducer; }

    /** Borrow the requester already held by this installed Workflow controller. */
    captureExecutionRunWorkflowRequester(runId: string): ReturnType<NonNullable<MachineRpcLifecycleRegistration['captureExecutionRunWorkflowRequester']>> {
        if (this.projectionSchedulingClosed) return null;
        const registration = this.rpcLifecycleRegistrations.at(-1);
        const requester = registration?.captureExecutionRunWorkflowRequester?.(runId);
        return requester ? Object.freeze({ ...requester,
            isCurrent: () => !this.projectionSchedulingClosed && this.rpcLifecycleRegistrations.at(-1) === registration
                && requester.isCurrent() }) : null;
    }

    /** Project the installed detached Run owner's exact active resume attempt. */
    captureExecutionRunResumeMaterialization(runId: string, occurrenceId: string): ExecutionRunResumeMaterializationAuthority | null {
        if (this.projectionSchedulingClosed) return null;
        const registration = this.rpcLifecycleRegistrations.at(-1);
        const authority = registration?.captureExecutionRunResumeMaterialization?.(runId, occurrenceId);
        if (!authority) return null;
        return Object.freeze({ occurrenceId: authority.occurrenceId,
            isCurrent: () => !this.projectionSchedulingClosed
                && this.rpcLifecycleRegistrations.at(-1) === registration && authority.isCurrent() });
    }

    /** Host-private port to the installed terminal/output owner. */
    getFiniteTerminalSessions() {
        return this.projectionSchedulingClosed ? null : this.rpcLifecycleRegistrations.at(-1)?.getFiniteTerminalSessions() ?? null;
    }

    /** Host-private C42 input; requester display authority remains with C41 ingress. */
    async readLiveWorkInventory(): Promise<LiveWorkInventoryV1> {
        return await this.lifecycleDependencies.managedActivity?.activity.read()
            ?? { coverage: 'unknown', items: [] };
    }

    /** Host effect port, backed by the currently installed finite PTY/operation owner. */
    async resolveProjectFiniteRuntime(ingress: RpcHandlerContext) {
        const registration = this.rpcLifecycleRegistrations.at(-1);
        if (!registration?.resolveProjectFiniteRuntime) {
            logger.debug('[ProjectFinite] Runtime resolution refused', {
                reason: registration ? 'finite_registration_unavailable' : 'machine_registration_unavailable',
                machineId: this.machine.id,
                ...(ingress.requesterSessionBootstrap?.getBoundSessionId()
                    ? { sessionId: ingress.requesterSessionBootstrap.getBoundSessionId() } : {}),
            });
            return null;
        }
        return await registration?.resolveProjectFiniteRuntime?.(ingress) ?? null;
    }

    /** Host-private Account provenance for observation/wakes, never effect admission. */
    async resolveInstalledAccountObservationRuntime(signal: AbortSignal): Promise<MachineTerminalAccountReadRuntime | null> {
        return this.resolveInstalledAccountRuntime(signal);
    }

    /** Host-private setup custody. The Action owner, not this port, admits effects. */
    async resolveMachineSetupRuntime(ingress: Pick<RpcHandlerContext, 'machineAdmission' | 'verifyMachineAdmissionCurrent'> & Readonly<{
        signal?: AbortSignal;
        onUnavailable?: (reason: NonNullable<MachineSetupTargetUnavailableFailureV1['reason']>) => void;
    }>): Promise<(MachineTerminalAccountReadRuntime & Readonly<{ isCustodyCurrent(): Promise<boolean> }>) | null> {
        return this.resolveInstalledMachineAccountRuntime(ingress);
    }

    /** Private Session/Project reads never borrow an installed custodian's Account. */
    async resolveOwnSessionRuntime(ingress: RpcHandlerContext): Promise<MachineTerminalOwnSessionReadRuntime | null> {
        if (ingress.callerInputAuthorization) {
            try {
                if (!this.machineRuntimeInstallationId
                    || readInstallationIdentityIfExistsSync()?.installationId !== this.machineRuntimeInstallationId) return null;
                return await resolveAdmittedRequesterAccountReadRuntime({ ingress, serverId: this.machineRuntimeServerId,
                    machineId: this.machine.id, installationId: this.machineRuntimeInstallationId,
                    isInstalledCurrent: () => !this.projectionSchedulingClosed
                        && configuration.activeServerId === this.machineRuntimeServerId });
            } catch { return null; }
        }
        if (ingress.machineAdmission?.actorAccountId !== ingress.machineAdmission?.custodianAccountId) return null;
        return this.resolveInstalledMachineAccountRuntime(ingress);
    }

    private async resolveInstalledMachineAccountRuntime(ingress: Parameters<ApiMachineClient['resolveMachineSetupRuntime']>[0]): Promise<(MachineTerminalAccountReadRuntime & Readonly<{ isCustodyCurrent(): Promise<boolean> }>) | null> {
        const unavailable = (reason: Parameters<NonNullable<typeof ingress.onUnavailable>>[0]) => {
            ingress.onUnavailable?.(reason);
            return null;
        };
        const admission = ingress.machineAdmission;
        if (!admission || !ingress.verifyMachineAdmissionCurrent
            || admission.machineId !== this.machine.id
            || !this.machineRuntimeInstallationId
            || admission.installationId !== this.machineRuntimeInstallationId) return unavailable('admission');
        try {
            if (!ingress.signal || ingress.signal.aborted) return unavailable('lifetime');
            const runtime = await this.resolveInstalledAccountRuntime(ingress.signal, admission.custodianAccountId, ingress.onUnavailable);
            if (!runtime) return null;
            if (!await runtime.isCurrent()) return unavailable('runtime_closed');
            // The ingress already admitted this finite operation. Retain its
            // local lifetime without re-reading Home admission.
            return runtime;
        } catch { return unavailable('exception'); }
    }

    private async resolveInstalledAccountRuntime(signal: AbortSignal, expectedAccountId?: string,
        onUnavailable?: Parameters<ApiMachineClient['resolveMachineSetupRuntime']>[0]['onUnavailable'],
        capturedCredentials?: StoredCredentials): Promise<(MachineTerminalAccountReadRuntime & Readonly<{ isCurrent(): Promise<boolean>; isCustodyCurrent(): Promise<boolean> }>) | null> {
        const unavailable = (reason: Parameters<NonNullable<typeof onUnavailable>>[0]) => {
            onUnavailable?.(reason);
            return null;
        };
        if (!this.machineRuntimeInstallationId) return unavailable('installation');
        const ownerCurrent = () => !this.projectionSchedulingClosed
            && configuration.activeServerId === this.machineRuntimeServerId;
        try {
            if (signal.aborted) return unavailable('lifetime');
            if (!ownerCurrent()) return unavailable('runtime_closed');
            if (readInstallationIdentityIfExistsSync()?.installationId !== this.machineRuntimeInstallationId) return unavailable('installation');
            const accountId = await runWithServerHttpBaseUrl(this.machineRuntimeServerHttpBaseUrl,
                () => this.getAccountId(signal));
            if (!accountId || expectedAccountId !== undefined && accountId !== expectedAccountId) return unavailable('account');
            if (!ownerCurrent()) return unavailable('runtime_closed');
            const credentials = capturedCredentials ?? await readStoredCredentialsForServerId(this.machineRuntimeServerId);
            // Credentials are admitted once for this finite operation. Effects
            // that require current installed custody use isCustodyCurrent.
            if (!credentials || credentials.token !== this.token) return unavailable('credentials');
            if (signal.aborted) return unavailable('lifetime');
            if (!ownerCurrent()) return unavailable('runtime_closed');
            const credentialsCurrent = async () => ownerCurrent() && sameStoredCredentials(credentials,
                await readStoredCredentialsForServerId(this.machineRuntimeServerId).catch(() => null)) && ownerCurrent();
            const isCurrent = async () => !signal.aborted && ownerCurrent();
            return { serverId: this.machineRuntimeServerId, machineId: this.machine.id, accountId,
                credentials, serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl, isCurrent, isCustodyCurrent: credentialsCurrent };
        } catch { return unavailable('exception'); }
    }

    /** Both mounted Action ingresses read the same current installed Account custody. */
    readonly resolveAccountPluginExecutionSelection: MountedAccountPluginExecutionSelectionResolver = async (pluginId, signal) => {
        const unavailable = { kind: 'unavailable' as const, code: 'plugin_account_execution_unavailable' as const };
        const runtime = await this.resolveInstalledAccountRuntime(signal ?? new AbortController().signal);
        if (!runtime || !await runtime.isCurrent()) return unavailable;
        const { readCurrentMountedAccountPluginExecutionSelection } = await import('@/plugins/runtime/accountPluginActivationSource');
        return await readCurrentMountedAccountPluginExecutionSelection({ pluginId, runtime, ...(signal ? { signal } : {}) });
    };

    /** Trusted host custody delegates to the actual registered PTY owners. */
    async cleanupRequesterMachineTerminals(input: Parameters<MachineRpcLifecycleRegistration['cleanupRequesterMachineTerminals']>[0]) {
        let incomplete = false;
        for (const registration of this.rpcLifecycleRegistrations) {
            const result = await registration.cleanupRequesterMachineTerminals(input);
            if (result.kind !== 'settled') incomplete = true;
        }
        return { kind: incomplete ? 'incomplete' as const : 'settled' as const };
    }
    private connectedAccountDaemonRuntime: ConnectedAccountDaemonRuntime | null = null;
    private connectedServicePoolSelectionRead: ConnectedServicePoolSelectionRead | null = null;
    private connectedAccountPurposeBindingRuntime: Pick<
        DaemonConnectedAccountPurposeBindingRuntime,
        'activatePurposeBindings' | 'listActionFormConnectedAccountOptions' | 'owner' | 'readSessionPurposeBindingSnapshot'
        | 'resolveCurrentSessionPurposeBindingSnapshot' | 'admitActionPurposeBindings'
    > & Readonly<{ materializeSessionProcessEnvironment?: SessionConnectedAccountProcessEnvironmentProducer }> | null = null;
    private readonly activateCapabilitiesPurposeBindings: DaemonConnectedAccountPurposeBindingRuntime['activatePurposeBindings'] = (input) => {
        const runtime = this.connectedAccountPurposeBindingRuntime;
        if (!runtime) {
            throw new Error('Connected Account purpose authority is unavailable for this capability probe');
        }
        return runtime.activatePurposeBindings(input);
    };
    private sessionSpawnV1OutcomeRequired = false;
    private sessionPendingResetStartInstalled = false;
    private externalActionExecutionAuthorizationV1OutcomeRequired = false;
    private currentIrohMachineEndpoint: IrohEndpointDescriptorV1 | null = null;
    private localServicePreviewNativeAccessLive = false;
    private projectFiniteExecutionLive = false;
    private pendingPersistedIrohEndpointWithdrawal = false;
    private pendingIrohEndpointCapabilityWithdrawal = false;
    /** Reflects only an installed provider-broker application handler; the
     * composition root owns the fact, this client only publishes it. */
    private providerBrokerIngressAdvertised = false;
    private providerBrokerAccountConnectionIngressLive = false;
    private providerBrokerActionOperationIngressLive = false;
    private agentCatalogObservation: AgentProviderCatalogObservationService | null = null;
    private readonly projectAgentInventoryPublication = createMachineAgentInventoryPublication();
    private activeTransportGeneration = 0;
    private machineAdminAccessRoutes: DaemonMachineAdminAccessRoutes | null = null;
    private machineAdminAccessInspectedTransport: Readonly<{ generation: number; codec: MachineContentCodec }> | null = null;
    private sessionMessageReplyRecovery: {
        socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
        generation: number;
        controller: AbortController;
        requested: Map<string | null, boolean>;
        promise: Promise<void> | null;
        isCurrent?: () => Promise<boolean>;
    } | null = null;
    private sessionMessageReplyRecoverySupported = false;
    private advertisedOperationProtocolCapabilitiesGeneration: number | null = null;
    /**
     * A publication that did not land is retried on the live socket. Socket.IO
     * ping/pong and the socket's own disconnect remain the only liveness
     * signal: a slow or rejected acknowledgement never ends the connection.
     */
    private readonly machineControlReadinessRetry = createConnectedServicesProjectionRetryScheduler();
    private machineControlRunningGeneration: number | null = null;
    private machineControlReadinessPublication: Readonly<{
        generation: number;
        promise: Promise<boolean>;
    }> | null = null;
    private readonly sessionSyncPendingInputServerContractController:
        ReturnType<typeof createSessionSyncPendingInputServerContractController>;
    private sessionSyncPendingInputServerContractResult:
        SessionSyncPendingInputServerContractResult | null = null;
    private currentConnectionState: ManagedConnectionState = {
        phase: 'idle',
        reason: null,
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastErrorMessage: null,
    };
    private readonly ownershipMetadata: Readonly<{
        runtimeId?: string;
        cliVersion?: string;
        publicReleaseChannel?: string;
        startupSource?: string;
        serviceManaged?: boolean;
        serviceLabel?: string;
    }>;
    private readonly lifecycleDependencies: ApiMachineClientLifecycleDependencies;
    private readonly prepareMachineRecipientEnvelopes: (machineIds: readonly string[], signal: AbortSignal) => Promise<void>;
    private readonly prepareSessionRecipientEnvelopes: (sessionIds: readonly string[], signal: AbortSignal) => Promise<void>;
    private machineContentContext: Readonly<{ codec: MachineContentCodec; ready: boolean }>;
    private get machineContentCodec(): MachineContentCodec { return this.machineContentContext.codec; }
    private get machineContentReady(): boolean { return this.machineContentContext.ready; }
    /**
     * Highest Account change cursor of an `update-machine` for this Machine that its
     * content already holds. The Home coalesces one change row per Machine at its
     * latest cursor, so the feed's row for a write this client already applied
     * (its own, echoed back) carries nothing new and needs no Machine re-read.
     */
    private heldOwnMachineChangeCursor: number | undefined;
    private readonly actionOperationRuntime: HostActionOperationRuntime;
    private agentIsolationMemberOperations: AgentIsolationMemberOperations | null = null;
    private agentIsolationEffects: AgentIsolationEffectDependencies | null = null;

    /** Member whose own folder holds this path; null off a separate-users Machine or outside member folders. */
    async readMemberFolderOwner(path: string) {
        return await this.agentIsolationMemberOperations?.readWorkspaceOwner(path) ?? null;
    }

    async readAgentIsolationMember(input: Parameters<NonNullable<HostAgentIsolationLaunchContext['readMember']>>[0]) {
        if (!this.agentIsolationMemberOperations) throw Object.assign(new PluginError({
            code: 'agent_isolation_unavailable', message: 'Member execution requires owner setup', retryable: false,
            details: { reason: 'member_setup_required', phase: 'native_identity_binding' },
        }), { rpcErrorCode: 'agent_isolation_unavailable' });
        return this.agentIsolationMemberOperations.read(input);
    }

    async prepareAgentIsolationMember(input: Parameters<NonNullable<HostAgentIsolationLaunchContext['prepareMember']>>[0]) {
        const result = await this.agentIsolationMemberOperations?.prepare(input);
        const readinessCode = result?.kind === 'not_ready' ? result.readinessCode : undefined;
        if (result?.kind !== 'ready') throw Object.assign(new PluginError({
            code: 'agent_isolation_unavailable', message: readinessCode
                ? 'Member execution launch qualification failed' : 'Member execution requires owner setup', retryable: false,
            details: { reason: readinessCode ?? 'member_setup_required', phase: 'native_execution_preparation',
                ...(!readinessCode ? { remedy: (input.requesterMachineRole ?? input.rpcContext?.machineAdmission?.role) === 'manage'
                    ? { kind: 'open_machine_security', target: { serverId: input.requesterIdentity.requester.serverId,
                        machineId: input.requesterIdentity.requester.machineId } }
                    : { kind: 'ask_machine_manager' } } : {}),
                ...(result?.kind === 'not_ready' ? { outcome: result.result.outcome,
                    ...('reasonCode' in result.result ? { reasonCode: result.result.reasonCode } : {}),
                    ...('failure' in result.result && result.result.failure ? { nativeFailure: result.result.failure } : {}),
                    ...(result.probeFailure ? { probeFailure: result.probeFailure } : {}),
                    ...(result.readinessCode ? { readinessCode: result.readinessCode } : {}),
                    ...(result.operationErrorCode ? { operationErrorCode: result.operationErrorCode } : {}) } : {}),
            },
        }), { rpcErrorCode: 'agent_isolation_unavailable' });
        return { identity: result.identity, daemonObservation: result.daemonObservation,
            ...(result.repaired ? { repaired: result.repaired } : {}) };
    }

    /** Source acquisition consumes the incumbent physical filesystem requester owner. */
    async resolveDeploymentSourceRequesterIdentity(context: import('@happier-dev/protocol').ActionExecutorContext): Promise<HostRequesterExecutionIdentity> {
        if (!this.filesystemEffectAdmission.resolveActionRequester) {
            throw Object.assign(new Error('agent_isolation_unavailable'), { code: 'agent_isolation_unavailable' });
        }
        const requester = await this.filesystemEffectAdmission.resolveActionRequester(context);
        try { return requester.identity; } finally { await requester.dispose(); }
    }

    /** Session preparation retains the exact requester/native fact selected at
     * birth. The incumbent filesystem owner supplies its existing policy. */
    prepareNativeSessionFilesystemEffect(input: Readonly<{
        preparedIdentity: import('@/daemon/agentIsolation/prepareNativeOperation').PreparedRequesterNativeIdentity;
        operationKey: string;
        signal: AbortSignal;
    }>) {
        return prepareNativeFilesystemEffect({ prepareNativeOperation: args => this.prepareNativeOperation(args),
            identity: input.preparedIdentity.requesterIdentity, preparedIdentity: input.preparedIdentity,
            operationKey: input.operationKey, signal: input.signal,
            configuration: this.filesystemEffectConfiguration(input.preparedIdentity.requesterIdentity.requester.accountId) });
    }

    /** Consumes the already admitted requester and existing selected-material lease. */
    async prepareNativeOperation(input: PrepareRequesterNativeOperationInput) {
        return prepareRequesterNativeOperation(input, {
            machine: this.lifecycleDependencies.agentIsolation,
            homeServerIdentityId: this.lifecycleDependencies.resolveCurrentServerIdentityId?.(),
            machineId: this.machine.id,
            installationId: this.machineRpcAdmissionBoundary.resolveInstallationId(),
            reloadController: pluginReloadController,
        });
    }

    /** Host-private process admission; no credential value enters an Action operand. */
    async prepareConnectedAccountProcessEnvironment(input: Readonly<{
        authorization?: import('@happier-dev/protocol').ExternalActionExecutionAuthorizationV1;
        sessionId?: string;
        requesterAccountId: string;
        requesterMaterial?: Pick<Awaited<ReturnType<typeof prepareRequesterOperationMaterial>>, 'readRuntime'>;
        operationId: string;
        actionId: import('@happier-dev/protocol/actions').ActionId;
        signal: AbortSignal;
    }>) {
        const installed = this.connectedAccountPurposeBindingRuntime;
        if (input.sessionId) {
            const materialize = installed?.materializeSessionProcessEnvironment;
            if (!materialize) throw new PluginError({ code: 'credential_unavailable', message: 'Session credential bindings are unavailable', retryable: false });
            return { produce: async (environment: Readonly<Record<string, string>>, signal: AbortSignal) =>
                await materialize({ sessionId: input.sessionId!, requesterAccountId: input.requesterAccountId, environment, signal }),
                dispose: async () => {} };
        }
        const registry = pluginReloadController.getState().activeRegistry;
        const declarations = registry ? resolveSystemToolLaunchPurposeDeclarations(registry.contributes) : [];
        if (!declarations.length) return { produce: async (environment: Readonly<Record<string, string>>) => ({ environment, secretValues: [] as readonly string[] }), dispose: async () => {} };
        const account = readRequesterAccountActionContext(input.authorization);
        const material = account && !input.requesterMaterial ? await prepareRequesterOperationMaterial({ requesterAccount: account,
            reloadController: pluginReloadController, signal: input.signal }) : undefined;
        try {
            const requesterMaterial = input.requesterMaterial ?? material;
            const runtime = requesterMaterial ? (await requesterMaterial.readRuntime(input.signal)).purposes : installed;
            if (!runtime) throw new PluginError({ code: 'credential_unavailable', message: 'Process credential bindings are unavailable', retryable: false });
            if (!account && input.requesterAccountId !== readAccountIdFromToken(this.token)) throw new PluginError({ code: 'credential_unavailable', message: 'Requester credential bindings are unavailable', retryable: false });
            const prepared = await prepareFiniteConnectedAccountProcessEnvironment({ runtime, declarations,
                subject: { kind: 'action_operation', operationId: input.operationId, actionId: input.actionId,
                    pluginVersion: configuration.currentCliVersion, isCurrent: () => !input.signal.aborted }, signal: input.signal });
            return { produce: prepared.produce, dispose: async () => { prepared.dispose(); await material?.dispose(); } };
        } catch (error) { await material?.dispose(); throw error; }
    }

    observeActionExecution(request: Parameters<HostActionOperationRuntime['observeExecution']>[0]) {
        return this.actionOperationRuntime.observeExecution(request);
    }

    waitForActionOperationCompletion(...args: Parameters<HostActionOperationRuntime['runner']['waitForCompletion']>) {
        return this.actionOperationRuntime.runner.waitForCompletion(...args);
    }

    runActionOperation(request: Parameters<HostActionOperationRuntime['runActionOperation']>[0]) {
        return runHostActionOperation(observed => this.observeActionExecution(observed), request);
    }

    preparePendingDeploymentObservation(request: Parameters<HostActionOperationRuntime['preparePendingDeploymentObservation']>[0]) {
        return this.actionOperationRuntime.preparePendingDeploymentObservation(request);
    }

    readRestorePreparation(request: Parameters<HostActionOperationRuntime['readRestorePreparation']>[0]) {
        return this.actionOperationRuntime.readRestorePreparation(request);
    }

    readDeploymentBackupOperations(request: Parameters<HostActionOperationRuntime['readDeploymentBackupOperations']>[0]) {
        return this.actionOperationRuntime.readDeploymentBackupOperations(request);
    }

    async acquireDeploymentRestoreUpload(input: Readonly<{ transferId: string; environmentId: string }>,
        context: import('@happier-dev/protocol').ActionExecutorContext) {
        const accountId = context.externalActionExecutionAuthorization?.binding.accountId ?? context.runtimeAccountId;
        if (!accountId) return null;
        return acquireDeploymentRestoreUpload(this.fileSystemTransferRelayOwner.store, { ...input, accountId });
    }

    /** Installed content transport facts, independent of the invoking Account's mode. */
    getMachineEncryptionMode(): 'plain' | 'e2ee' {
        return this.machine.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    }

    private shouldSuppressMachinePublication(allowWhileQuiescing = false): boolean {
        return !allowWhileQuiescing
            && this.lifecycleDependencies.isDaemonQuiescing?.() === true;
    }

    private teardownActiveSocket(): void {
        this.machineAdminAccessInspectedTransport = null;
        this.sessionMessageReplyRecovery?.controller.abort();
        this.sessionMessageReplyRecovery = null;
        this.sessionMessageReplyRecoverySupported = false;
        this.connectedClientRpcMethods.clear();
        if (!this.socket) {
            this.sessionSyncPendingInputServerContractResult = null;
            return;
        }
        this.sessionSyncPendingInputServerContractResult =
            this.sessionSyncPendingInputServerContractController.invalidate({
                sessionConnectionEpoch: this.activeTransportGeneration,
                socket: this.socket,
            });
        this.rpcHandlerManager.onSocketDisconnect();
        this.machineControlReadinessRetry.cancel();
        this.stopKeepAlive();
        const wasReady = this.isMachineControlRegistrationReady();
        this.socket = null;
        if (wasReady) this.lifecycleDependencies.onMachineControlReadinessChange?.(false);
    }

    /** The existing requester visitor reopens only its retained exact Session custody. */
    async requestSessionMessageReplyRecoveryForSession(sessionId: string,
        options?: Readonly<{ retryFailedPublications?: boolean }>): Promise<void> {
        const socket = this.socket;
        if (!socket) return;
        await this.requestSessionMessageReplyRecovery(socket, this.activeTransportGeneration, sessionId, options?.retryFailedPublications);
    }

    private requestSessionMessageReplyRecovery(socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>, generation: number,
        requesterSessionId: string | null = null, retryFailedPublications = false): Promise<void> | undefined {
        if (this.projectionSchedulingClosed || this.socket !== socket || !socket.connected
            || !this.isActiveTransportGeneration(generation)
            || this.machineControlRunningGeneration !== generation) return;
        let recovery = this.sessionMessageReplyRecovery;
        if (!recovery || recovery.socket !== socket || recovery.generation !== generation) {
            recovery?.controller.abort();
            recovery = { socket, generation, controller: new AbortController(), requested: new Map(), promise: null };
            this.sessionMessageReplyRecovery = recovery;
        }
        // Coalesce read invalidations, never payloads or delivery custody. Null is
        // the installed Account; requester scopes must resolve their own lifetime.
        recovery.requested.set(requesterSessionId, retryFailedPublications || recovery.requested.get(requesterSessionId) === true);
        if (recovery.promise) return recovery.promise;
        const active = recovery;
        const transportCurrent = () => !this.projectionSchedulingClosed && !active.controller.signal.aborted
            && this.sessionMessageReplyRecovery === active && this.socket === socket && socket.connected
            && this.isActiveTransportGeneration(generation);
        active.promise = (async () => {
            while (active.requested.size && transportCurrent()) {
                const next = active.requested.entries().next();
                if (next.done) break;
                const [scope, retryFailedPublications] = next.value;
                active.requested.delete(scope);
                const requesterPort = this.lifecycleDependencies.requesterSessionRuntime;
                let requester: Awaited<ReturnType<NonNullable<typeof requesterPort>['resolve']>> = null;
                try {
                    if (scope !== null) requester = await requesterPort?.resolve(scope) ?? null;
                    const requesterCurrent = async () => {
                        const bootstrap = requester?.bootstrap;
                        return !!bootstrap && requesterPort?.serverId === this.machineRuntimeServerId
                            && bootstrap.getBoundSessionId() === scope
                            && bootstrap.attribution.serverId === this.machineRuntimeServerId
                            && bootstrap.attribution.machineId === this.machine.id
                            && bootstrap.attribution.installationId === this.machineRuntimeInstallationId
                            && bootstrap.serverHttpBaseUrl === this.machineRuntimeServerHttpBaseUrl
                            && configuration.activeServerId === this.machineRuntimeServerId
                            && readInstallationIdentityIfExistsSync()?.installationId === this.machineRuntimeInstallationId
                            && await requester!.isCurrent(active.controller.signal);
                    };
                    const runtime = scope === null ? await this.resolveInstalledAccountRuntime(active.controller.signal)
                        : requester && await requesterCurrent() ? { credentials: requester.bootstrap.credentials,
                            serverId: requester.bootstrap.attribution.serverId, serverHttpBaseUrl: requester.bootstrap.serverHttpBaseUrl,
                            isCurrent: requesterCurrent } : null;
                    if (!runtime || !transportCurrent()) continue;
                    const isCurrent = async () => transportCurrent() && await runtime.isCurrent() && transportCurrent();
                    // The advertised installed-Account capability must not retain
                    // a temporary requester context which release will retire.
                    if (scope === null) active.isCurrent = isCurrent;
                    await runWithServerHttpBaseUrl(runtime.serverHttpBaseUrl, () => recoverSessionMessageRepliesForMachine({
                        machineId: this.machine.id, serverId: runtime.serverId, credentials: runtime.credentials,
                        retryFailedPublications,
                        ...(scope === null ? {} : { requesterSessionId: scope }),
                        signal: active.controller.signal, isCurrent,
                        onSupported: async () => {
                            if (scope !== null || this.sessionMessageReplyRecoverySupported || !await isCurrent()) return;
                            this.sessionMessageReplyRecoverySupported = true;
                            try { await this.refreshOperationProtocolCapabilitiesAdvertisement(); }
                            catch {
                                // The inventory already proved support. A lost/refused
                                // publication must not erase that fact: reply admission
                                // cannot create the Pending hint which would retry it.
                                if (transportCurrent()) this.machineControlReadinessRetry.schedule(async () => {
                                    if (transportCurrent()) await this.refreshOperationProtocolCapabilitiesAdvertisement();
                                });
                                logger.warn('[API MACHINE] Session reply capability publication remains unavailable');
                            }
                        },
                        machineAdmissionTransport: (request, options) => this.enqueueSessionPendingByMachine(request, options),
                        publishDiscussionReply: createDiscussionReplyReturnPublisher({ credentials: runtime.credentials,
                            machineId: this.machine.id,
                            serverId: runtime.serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl,
                            ...(requester ? { actionsSettingsProvider: createActionSettingsProvider({
                                scopeKey: resolveAccountSettingsScopeKeyForToken(runtime.credentials.token),
                                getAccountSettings: () => {
                                    const snapshot = requester!.readAccountSettingsSnapshot();
                                    return snapshot.source === 'none' ? null : snapshot.settings;
                                },
                            }) } : {}),
                            signal: active.controller.signal, isCurrent }),
                        markReturned: async request => {
                            if (scope !== null || !await isCurrent()) return { v: 1, ok: false, error: 'unavailable' };
                            const payload = SessionMessageReplyMachineMutationV1Schema.parse({ v: 1, machineId: this.machine.id,
                                requestSessionId: request.requestSessionId, requestLocalId: request.requestLocalId,
                                operation: { kind: 'returned', returnedInputLocalId: request.returnedInputLocalId } });
                            return SessionMessageReplyMutationResultV1Schema.parse(await emitSocketWithAck({ socket,
                                event: SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1, payload, signal: active.controller.signal }));
                        },
                    }));
                } catch {
                    if (transportCurrent()) logger.warn('[API MACHINE] Session reply recovery remains pending in original input custody');
                } finally {
                    if (requester) await requesterPort!.release(requester);
                }
            }
        })().catch(() => {
            if (transportCurrent()) logger.warn('[API MACHINE] Session reply recovery could not acquire current Account custody');
        }).finally(() => { active.promise = null; });
        return active.promise;
    }

    private async publishMachineControlReadinessWhenReady(params: Readonly<{
        socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
        transportGeneration: number;
        timeoutMs: number;
    }>): Promise<Readonly<{
        ready: boolean;
        readiness: RpcHandlerRegistrationReadiness;
    }>> {
        const { socket, transportGeneration, timeoutMs } = params;
        const requiredMethods = this.requiredMachineControlRpcMethods();
        const missingCoreHandlers = requiredMethods.filter(
            (method) => !this.rpcHandlerManager.hasHandler(method),
        );
        if (missingCoreHandlers.length > 0) {
            return {
                ready: false,
                readiness: { status: 'disconnected', missingMethods: missingCoreHandlers },
            };
        }

        const readiness = await this.rpcHandlerManager.waitForRegisteredHandlers(
            requiredMethods,
            { timeoutMs },
        );
        if (
            readiness.status !== 'ready'
            || this.socket !== socket
            || this.activeTransportGeneration !== transportGeneration
            || socket.connected !== true
        ) {
            return { ready: false, readiness };
        }
        if (this.machineControlRunningGeneration === transportGeneration) {
            return { ready: true, readiness };
        }
        if (this.machineControlReadinessPublication?.generation === transportGeneration) {
            const published = await this.machineControlReadinessPublication.promise;
            return { ready: published, readiness };
        }

        // A successful core registration receipt proves that the server has
        // installed its post-authentication RPC listener. Replay the manager's
        // complete current set once for this readiness publication so optional
        // registrations emitted during the admission fence are not silently
        // lost. The guards above prevent later optional acknowledgements from
        // repeatedly replaying the remaining set.
        this.rpcHandlerManager.replayUnacknowledgedHandlerRegistrations();

        const promise = (async () => {
            const capabilities = await timeWebLatencyPhase('machine.startup.resolveCapabilities',
                () => this.resolveCurrentMachineOperationProtocolCapabilitiesForPublication());
            if (
                capabilities !== null
                && this.advertisedOperationProtocolCapabilitiesGeneration !== transportGeneration
            ) {
                // A rejected publication leaves the server's projection unknown, so it is
                // deliberately not recorded as advertised and is allowed to reject this
                // whole publication: without the running mark, the next registration
                // acknowledgement re-enters here and publishes the capabilities again.
                await timeWebLatencyPhase('machine.startup.publishCapabilities',
                    () => this.publishOperationProtocolCapabilitiesOnSocket(socket, capabilities));
                this.advertisedOperationProtocolCapabilitiesGeneration = transportGeneration;
            }
            if (
                this.socket !== socket
                || this.activeTransportGeneration !== transportGeneration
                || socket.connected !== true
            ) {
                return false;
            }
            await timeWebLatencyPhase('machine.startup.publishRunning', () => this.updateDaemonState((state) => ({
                ...projectMachineDaemonRunningState(state, this.ownershipMetadata.runtimeId, this.getAgentIsolationSnapshot().enabled),
                ...(this.ownershipMetadata.cliVersion !== undefined ? { cliVersion: this.ownershipMetadata.cliVersion } : {}),
                contributionRegistryProjectionRevision: state?.contributionRegistryProjectionRevision ?? 0,
                ...(this.lifecycleDependencies.controlPort !== undefined ? { httpPort: this.lifecycleDependencies.controlPort } : {}),
                ...(this.lifecycleDependencies.managedActivity ? {
                    managedActivity: this.lifecycleDependencies.managedActivity.activity.getCurrentDecision(),
                } : {}),
            })));
            if (
                this.socket === socket
                && this.activeTransportGeneration === transportGeneration
                && socket.connected === true
            ) {
                this.machineControlRunningGeneration = transportGeneration;
                this.lifecycleDependencies.onMachineControlReadinessChange?.(true);
                this.observeStartupMachineAdminAccess();
                this.qualifyStartupAgentIsolation();
                // Connect precedes server-side asynchronous admission. Existing
                // registration readiness proves its Machine listeners are mounted.
                this.requestSessionMessageReplyRecovery(socket, transportGeneration, null, true);
                // Pairs with the unready warning below: an operator reading the daemon log
                // can tell a connection that recovered from one that never did.
                logger.info('[API MACHINE] Core machine-control RPC registration ready', {
                    advertisesOperationProtocolCapabilities: capabilities !== null,
                });
            }
            return true;
        })().catch((error) => {
            logger.warn('[API MACHINE] Failed to publish machine-control readiness; session spawn stays unadvertised until the retry on this connection lands', {
                message: error instanceof Error ? error.message : String(error),
            });
            return false;
        }).finally(() => {
            if (this.machineControlReadinessPublication?.generation === transportGeneration) {
                this.machineControlReadinessPublication = null;
            }
        });
        this.machineControlReadinessPublication = { generation: transportGeneration, promise };
        const published = await promise;
        return { ready: published, readiness };
    }

    private isCurrentConnectionState(state: ManagedConnectionState): boolean {
        return this.currentConnectionState.phase === state.phase
            && this.currentConnectionState.reason === state.reason
            && this.currentConnectionState.attempt === state.attempt
            && this.currentConnectionState.nextRetryAt === state.nextRetryAt
            && this.currentConnectionState.lastConnectedAt === state.lastConnectedAt
            && this.currentConnectionState.lastDisconnectedAt === state.lastDisconnectedAt
            && this.currentConnectionState.lastErrorMessage === state.lastErrorMessage;
    }

    private retryMachineControlReadinessPublication(params: Readonly<{
        socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
        transportGeneration: number;
    }>): void {
        const { socket, transportGeneration } = params;
        const isCurrentTransport = () => (
            this.socket === socket
            && this.activeTransportGeneration === transportGeneration
            && socket.connected === true
        );
        if (!isCurrentTransport()) return;
        this.machineControlReadinessRetry.schedule(async () => {
            if (!isCurrentTransport()) return;
            const result = await this.publishMachineControlReadinessWhenReady({
                socket,
                transportGeneration,
                timeoutMs: 0,
            });
            // Unready registrations are driven by their own acknowledgements; only a
            // publication that failed after readiness was proven is retried here.
            if (result.readiness.status === 'ready' && !result.ready && isCurrentTransport()) {
                throw new Error('Machine capability publication did not establish readiness');
            }
        });
    }

    private isActiveTransportGeneration(generation: number): boolean {
        return generation === this.activeTransportGeneration;
    }

    private handleTransportSocketDisconnect(socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>, generation: number): void {
        logger.debug('[API MACHINE] Disconnected from server');
        if (!this.isActiveTransportGeneration(generation) || this.socket !== socket) {
            return;
        }
        this.teardownActiveSocket();
    }

    private normalizeMachineScopedRpcMethod(method: string): string | null {
        const trimmed = method.trim();
        if (!trimmed) return null;
        return trimmed.includes(':') ? trimmed : `${this.machine.id}:${trimmed}`;
    }

    private normalizeConnectedClientRpcAvailabilityMethod(method: unknown): string | null {
        if (typeof method !== 'string') return null;
        const trimmed = method.trim();
        const prefix = `${this.machine.id}:`;
        if (!trimmed.startsWith(prefix)) return null;
        const unprefixedMethod = trimmed.slice(prefix.length).trim();
        if (!unprefixedMethod) return null;
        if (this.rpcHandlerManager.hasHandler(unprefixedMethod)) return null;
        return `${this.machine.id}:${unprefixedMethod}`;
    }

    constructor(
        private token: string,
        private machine: Machine,
        ownershipMetadata?: Readonly<{
            runtimeId?: string;
            cliVersion?: string;
            publicReleaseChannel?: string;
            startupSource?: string;
            serviceManaged?: boolean;
            serviceLabel?: string;
        }>,
        lifecycleDependencies?: ApiMachineClientLifecycleDependencies,
    ) {
        this.machine.daemonState = this.discardUnverifiedIrohEndpoint(this.machine.daemonState);
        this.ownershipMetadata = ownershipMetadata ?? {};
        this.lifecycleDependencies = lifecycleDependencies ?? {};
        const machineRuntimeServerId = configuration.activeServerId;
        this.readMachineRuntimeServerHttpBaseUrl = captureServerHttpBaseUrl();
        const readMachineRuntimeServerHttpBaseUrl = this.readMachineRuntimeServerHttpBaseUrl;
        const captureRecipientPreparationAuthority = async (signal: AbortSignal) => {
            const transportGeneration = this.activeTransportGeneration;
            const credential = await readStoredCredentialsForServerId(machineRuntimeServerId).catch(() => null);
            const accountId = readAccountIdFromToken(this.token);
            if (!credential || credential.token !== this.token || !accountId || signal.aborted || this.projectionSchedulingClosed) return null;
            const isCurrent = async () => !signal.aborted && !this.projectionSchedulingClosed
                && this.isActiveTransportGeneration(transportGeneration)
                && configuration.activeServerId === machineRuntimeServerId
                && isDeepStrictEqual(await readStoredCredentialsForServerId(machineRuntimeServerId).catch(() => null), credential);
            return await isCurrent() ? { credential, accountId, isCurrent, transportGeneration } : null;
        };
        this.prepareMachineRecipientEnvelopes = async (machineIds, signal) => {
            if (machineIds.length === 0) return;
            const authority = await captureRecipientPreparationAuthority(signal);
            if (!authority) return;
            const { credential, accountId, isCurrent } = authority;
            const [{ prepareMachineAccessKeyEnvelopes }, { runSessionDataKeyPreparationDetached }] = await Promise.all([
                import('./machineAccessGrantEnvelopeHost'),
                import('@happier-dev/protocol/sessions/encryption/sessionDataKeyPreparationPass'),
            ]);
            for (const machineId of new Set(machineIds)) {
                if (!await isCurrent()) return;
                await runSessionDataKeyPreparationDetached(JSON.stringify([machineRuntimeServerId, accountId, 'machine-data-key-envelopes', machineId]),
                    () => prepareMachineAccessKeyEnvelopes({ credentials: credential, serverId: machineRuntimeServerId,
                        serverHttpBaseUrl: readMachineRuntimeServerHttpBaseUrl(), machineId, signal, isCredentialCurrent: isCurrent }));
            }
        };
        this.prepareSessionRecipientEnvelopes = async (sessionIds, signal) => {
            if (sessionIds.length === 0) return;
            const authority = await captureRecipientPreparationAuthority(signal);
            // A Plain Account holds no content key, so it has nothing to deliver.
            if (!authority?.credential.encryption) return;
            const { credential, accountId, isCurrent, transportGeneration } = authority;
            const [{ prepareSessionRecipientEnvelopes }, { runSessionDataKeyPreparationDetached }] = await Promise.all([
                import('./sessionAccessGrantEnvelopeHost'),
                import('@happier-dev/protocol/sessions/encryption/sessionDataKeyPreparationPass'),
            ]);
            for (const sessionId of new Set(sessionIds)) {
                if (!await isCurrent()) return;
                try {
                    await runSessionDataKeyPreparationDetached(JSON.stringify([machineRuntimeServerId, accountId, 'session-data-key-envelopes', sessionId]),
                        () => prepareSessionRecipientEnvelopes({ credentials: credential, sessionId, signal,
                            serverHttpBaseUrl: readMachineRuntimeServerHttpBaseUrl(),
                            isScopeCurrent: () => !this.projectionSchedulingClosed && this.isActiveTransportGeneration(transportGeneration) }));
                } catch (error) {
                    signal.throwIfAborted();
                    // Delivery never holds the Account cursor: a queued `share` can outlive this
                    // holder's Manage access, and an undelivered key stays visibly pending.
                    logger.warn('[API MACHINE] Session recipient key delivery stopped', {
                        sessionId, code: error instanceof Error && 'code' in error ? error.code : 'unknown',
                    });
                }
            }
        };
        this.machineContentContext = { codec: createMachineContentCodec(this.machine), ready: true };
        this.sessionSyncPendingInputServerContractController =
            createSessionSyncPendingInputServerContractController({
                get serverUrl() { return readMachineRuntimeServerHttpBaseUrl(); },
                token: this.token,
            });
        const rpcTransportConfig = this.machine.encryptionMode === 'plain'
            ? { encryptionMode: 'plain' as const }
            : {
                encryptionMode: 'e2ee' as const,
                encryptionKey: this.machine.encryptionKey,
                encryptionVariant: this.machine.encryptionVariant,
            };
        const resolveCurrentMachineExecutionOriginContext = createCurrentMachineExecutionOriginContextResolver({
            get serverUrl() { return readMachineRuntimeServerHttpBaseUrl(); }, resolveCurrentMachineId: () => this.machine.id,
            ...(this.lifecycleDependencies.resolveCurrentServerIdentityId
                ? { resolveCurrentServerIdentityId: this.lifecycleDependencies.resolveCurrentServerIdentityId } : {}),
        });
        this.machineRpcAdmissionBoundary = {
            machineId: this.machine.id,
            resolvePrivateWorkspaceSyncTargetExecution: input => {
                const adapter = this.lifecycleDependencies.workspaceSyncHandoffAdapter;
                return resolvePrivateWorkspaceSyncTargetExecution({
                    resolvePrivateExecution: adapter?.resolvePrivateExecution,
                    hasRetainedRecoveryAdmission: this.lifecycleDependencies.workspaceSync?.hasRetainedRecoveryAdmission,
                }, input);
            },
            resolveHomeServerIdentityId: async signal => (await resolveCurrentMachineExecutionOriginContext(signal))?.serverIdentityId ?? null,
            resolveCustodianAccountId: (signal) => runWithServerHttpBaseUrl(readMachineRuntimeServerHttpBaseUrl(), () => this.getAccountId(signal)),
            resolveInstallationId: () => readInstallationIdentityIfExistsSync()?.installationId ?? null,
            verifyMachineAdmission: async ({ context, method, signal, custodySubjectAccountId, workspaceSyncSourceRouting, workspaceSyncSourceExecution, workspaceSyncTargetRouting, workspaceSyncSourceWriterTargetRouting, workspaceSyncSeedRouting, callerInputAuthorization }) => {
                const installation = readInstallationIdentityIfExistsSync();
                if (!installation || !workspaceSyncSourceRouting && !workspaceSyncTargetRouting && !workspaceSyncSourceWriterTargetRouting && !workspaceSyncSeedRouting
                    && installation.installationId !== context.installationId) return false;
                return readMachineRpcAdmissionCurrent({ context, method,
                    ...(workspaceSyncSeedRouting ? { workspaceSyncSeedRouting,
                        workspaceSyncSeedReceiver: { machineId: this.machine.id, installationId: installation.installationId,
                            accountId: readAccountIdFromToken(this.token) ?? '' },
                        ...(callerInputAuthorization ? { callerInputAuthorization } : {}) } : {}),
                    ...(workspaceSyncSourceExecution ? { workspaceSyncSourceExecution } : {}),
                    ...(workspaceSyncSourceExecution?.originalActionEnvelope && callerInputAuthorization ? { callerInputAuthorization } : {}),
                    ...(custodySubjectAccountId !== undefined ? { custodySubjectAccountId } : {}),
                    ...(workspaceSyncSourceRouting ? { workspaceSyncSourceRouting,
                        workspaceSyncSourceReceiver: { machineId: this.machine.id, installationId: installation.installationId,
                            accountId: readAccountIdFromToken(this.token) ?? '' },
                        ...(callerInputAuthorization ? { callerInputAuthorization } : {}) } : {}),
                    ...(workspaceSyncTargetRouting ? { workspaceSyncTargetRouting,
                        workspaceSyncTargetReceiver: { machineId: this.machine.id, installationId: installation.installationId,
                            accountId: readAccountIdFromToken(this.token) ?? '' } } : {}),
                    ...(workspaceSyncSourceWriterTargetRouting ? { workspaceSyncSourceWriterTargetRouting,
                        ...(!workspaceSyncTargetRouting ? { workspaceSyncSourceWriterTargetReceiver: {
                            machineId: this.machine.id, installationId: installation.installationId,
                            accountId: readAccountIdFromToken(this.token) ?? '' } } : {}),
                        ...(callerInputAuthorization ? { callerInputAuthorization } : {}) } : {}),
                    privateKey: installation.privateKey, daemonToken: this.token,
                    serverHttpBaseUrl: readMachineRuntimeServerHttpBaseUrl(),
                    ...(signal ? { signal } : {}),
                });
            },
        };
        // Socket and signed direct ingress share the same installed Machine boundary.
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            localMachineId: this.machine.id,
            ...rpcTransportConfig,
            resolveSessionDecisionContext: async ({ authorization, signal }) => {
                const credentials = await readStoredCredentialsForServerId(machineRuntimeServerId).catch(() => null);
                const accountId = readAccountIdFromToken(this.token);
                const installation = readInstallationIdentityIfExistsSync();
                if (!credentials || credentials.token !== this.token || !accountId || !installation || !authorization.authentication || signal.aborted
                    || this.projectionSchedulingClosed) return null;
                // Home admitted this decision request (its approver and Session) before relaying it over
                // the authenticated Machine socket; the daemon keeps only its own binding facts here.
                const isCurrent = async () => !signal.aborted && !this.projectionSchedulingClosed
                    && sameStoredCredentials(credentials, await readStoredCredentialsForServerId(machineRuntimeServerId).catch(() => null))
                    && readInstallationIdentityIfExistsSync()?.installationId === installation.installationId;
                if (!await isCurrent()) return null;
                const transport = await runWithServerHttpBaseUrl(readMachineRuntimeServerHttpBaseUrl(), () => resolveSessionTransportContext({
                    reason: 'session-control',
                    credentials, idOrPrefix: authorization.sessionId, signal,
                }));
                if (!transport.ok || transport.sessionId !== authorization.sessionId) return null;
                return { content: resolveSessionRpcContent(transport), isCurrent };
            },
            resolveSessionBrowserContent: async ({ authorization, signal }) => {
                if (signal.aborted || this.projectionSchedulingClosed) return null;
                const requesterOwner = this.lifecycleDependencies.requesterSessionRuntime;
                const requester = requesterOwner?.serverId === machineRuntimeServerId
                    ? await requesterOwner.resolve(authorization.sessionId, undefined, signal) : null;
                try {
                    const birth = requester?.bootstrap;
                    if (birth && (birth.getBoundSessionId() !== authorization.sessionId
                        || birth.attribution.serverId !== machineRuntimeServerId
                        || birth.attribution.machineId !== this.machine.id
                        || birth.attribution.installationId !== this.machineRuntimeInstallationId
                        || birth.serverHttpBaseUrl !== readMachineRuntimeServerHttpBaseUrl())) return null;
                    const credentials = birth?.credentials ?? await readStoredCredentialsForServerId(machineRuntimeServerId).catch(() => null);
                    if (!credentials || !birth && credentials.token !== this.token) return null;
                    const transport = await runWithServerHttpBaseUrl(birth?.serverHttpBaseUrl ?? readMachineRuntimeServerHttpBaseUrl(), () => resolveSessionTransportContext({
                        reason: 'session-control', credentials, idOrPrefix: authorization.sessionId, exact: true, signal,
                    }));
                    return !transport.ok ? null : createMachineContentCodec(transport.mode === 'plain'
                        ? { encryptionMode: 'plain' } : transport.ctx);
                } finally {
                    if (requester) await requesterOwner!.release(requester);
                }
            },
            prepareRequesterAccountContext: (input) => this.externalActionIngressOwner?.prepareRequesterAccountContext?.(input)
                ?? Promise.resolve(null),
            resolveExternalActionEncryption: (signal, authorization) => this.resolveExternalActionEncryption(signal, authorization),
            authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, this.machineRpcAdmissionBoundary, source),
            projectTransportAcknowledgement: projectMachineRpcTransportAcknowledgement,
            onRegistrationError: (error) => {
                const probe = classifyTransportErrorToProbeResult(error);
                const supervisor = this.connectionSupervisor;
                const scope = supervisor?.captureProbeReportScope?.();
                if (probe && scope) {
                    supervisor?.reportProbeResult?.(probe, scope);
                }
            },
            onRegistrationAcknowledged: () => {
                const socket = this.socket;
                if (!socket) {
                    return;
                }
                const transportGeneration = this.activeTransportGeneration;
                void this.publishMachineControlReadinessWhenReady({
                    socket,
                    transportGeneration,
                    timeoutMs: 0,
                }).then((result) => {
                    if (result.readiness.status === 'ready' && !result.ready) {
                        this.retryMachineControlReadinessPublication({ socket, transportGeneration });
                    }
                });
            },
        });
        registerMachineLiveStreamSourceAdmissionHandler(this.rpcHandlerManager, {
            machineId: this.machine.id,
            resolveComputer: () => this.devicesRoleRoutes?.resolveComputer?.() ?? null,
            resolveBrowser: () => this.devicesRoleRoutes?.browserControl ?? null,
            readHomeServerIdentityId: () => this.lifecycleDependencies.resolveCurrentServerIdentityId?.(),
            readInstallationIdentity: readInstallationIdentityIfExistsSync,
        });
        registerDaemonMachineAgentIsolationRpcHandlers(this.rpcHandlerManager, {
            runActionOperation: request => this.runActionOperation(request),
            read: () => this.getAgentIsolationSnapshot(),
            readCanonicalHomeServerIdentityId: () => this.lifecycleDependencies.resolveCurrentServerIdentityId?.() ?? null,
            target: () => {
                const custodianAccountId = readAccountIdFromToken(this.token);
                const installationId = this.machineRuntimeInstallationId;
                return custodianAccountId && installationId ? { serverId: this.machineRuntimeServerId,
                    machineId: this.machine.id, installationId, custodianAccountId } : null;
            },
        });
        registerDaemonCommittedServiceHealthDeliveryRpcHandler(this.rpcHandlerManager, {
            target: () => {
                const custodianAccountId = readAccountIdFromToken(this.token);
                const installationId = this.machineRuntimeInstallationId;
                return custodianAccountId && installationId ? { serverId: this.machineRuntimeServerId,
                    machineId: this.machine.id, installationId, custodianAccountId } : null;
            },
            resolveRuntime: async ingress => {
                const runtime = await this.resolveOwnSessionRuntime(ingress);
                const isCurrent = runtime?.isCurrent;
                return runtime?.credentials && isCurrent ? { credentials: runtime.credentials, accountId: runtime.accountId,
                    serverId: runtime.serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl,
                    machineId: runtime.machineId, isCurrent } : null;
            },
        });
        const operationInstallation = readInstallationIdentityIfExistsSync();
        const actionOperationPublisher = createActionOperationSnapshotPublisher({
            resolveAccountId: async () => await this.getAccountId(),
            get serverBaseUrl() { return readMachineRuntimeServerHttpBaseUrl(); },
            readCredentials: async () => this.projectionSchedulingClosed || configuration.activeServerId !== machineRuntimeServerId
                ? null : await readStoredCredentialsForServerId(machineRuntimeServerId),
            publishContent: content => { emitActionOperationSnapshotV1({ socket: this.socket, machineId: this.machine.id, content }); },
            publishContentAcknowledged: async content => await emitActionOperationSnapshotV1({
                socket: this.socket, machineId: this.machine.id, content, acknowledge: true,
            }) === true,
        });
        this.actionOperationRuntime = createHostActionOperationRuntime({
            ...(this.lifecycleDependencies.projectOpenReceiptPersistence !== undefined
                ? { projectOpenReceiptPersistence: this.lifecycleDependencies.projectOpenReceiptPersistence } : {}),
            serverId: configuration.activeServerId,
            machineId: this.machine.id,
            ...(operationInstallation ? { custodyBinding: {
                serverId: machineRuntimeServerId, installationId: operationInstallation.installationId,
            } } : {}),
            resolveAccountId: async () => await this.getAccountId(),
            ...(this.lifecycleDependencies.onProjectOperationInspection
                ? { onInspection: this.lifecycleDependencies.onProjectOperationInspection } : {}),
            onBackupOutcome: (payload, scope) => {
                // Account-scoped broker facts must stay with the connection Account.
                void this.getAccountId().then(accountId => {
                    if (accountId !== scope.accountId) return;
                    publishDaemonHostEvent({ eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1,
                        scope: { kind: 'account' }, payload }, () => this.projectionSchedulingClosed);
                }).catch(error => logger.warn('Backup outcome event publication failed', error));
            },
            publishSnapshot: actionOperationPublisher,
            publishSnapshotAcknowledged: actionOperationPublisher.acknowledge,
            supportsCoreCancellation: (actionId, input) => {
                if (actionId !== 'session.spawn_new') return true;
                if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
                const executionTarget = (input as Readonly<Record<string, unknown>>).executionTarget;
                return Boolean(
                    executionTarget
                    && typeof executionTarget === 'object'
                    && !Array.isArray(executionTarget)
                    && (executionTarget as Readonly<Record<string, unknown>>).machineId === this.machine.id,
                );
            },
        });

        this.scheduledObservation = registerDaemonScheduledRpcHandlers(this.rpcHandlerManager, {
            machineId: this.machine.id, accountId: readAccountIdFromToken(this.token) ?? undefined,
        });
        this.machineRpcWorkingDirectory = resolveMachineRpcWorkingDirectory();
        const reboot = this.lifecycleDependencies.machineReboot;
        const managedActivity = this.lifecycleDependencies.managedActivity;
        if (reboot && managedActivity) {
            const routes: DaemonMachineRebootRoutes = { ...reboot,
                inventory: managedActivity.activity, admissionDrain: managedActivity.admissionDrain,
                target: () => {
                    const installationId = this.machineRuntimeInstallationId;
                    const custodianAccountId = readAccountIdFromToken(this.token);
                    return !this.projectionSchedulingClosed && this.machineContentReady && installationId && custodianAccountId
                        && configuration.activeServerId === this.machineRuntimeServerId
                        && readInstallationIdentityIfExistsSync()?.installationId === installationId
                        ? { serverId: this.machineRuntimeServerId, machineId: this.machine.id, installationId, custodianAccountId } : null;
                },
            };
            this.machineRebootAction = createMachineRebootAction({ routes, operations: this.actionOperationRuntime,
                captureElevation: () => {
                    const installationId = routes.target()?.installationId;
                    if (!installationId) throw new Error('admission_unavailable');
                    return { ...this.captureMachineAdminAccess(), installationId, ...resolveMachineEffectCli(),
                        ...(reboot.spawnElevation ? { spawn: reboot.spawnElevation } : {}) };
                },
            });
        }
        // Always register independently of service observation/launcher presence.
        // Resolution is late through the incumbent receiving credential factory;
        // no raw power handler or self-invocation is installed alongside it.
        registerActionSpecRpcHandlers<'machines.reboot'>({
            rpcHandlerManager: this.rpcHandlerManager, actionIds: ['machines.reboot'],
            targetMachineId: this.machine.id, defaultMachineTarget: true,
            observeExecution: this.actionOperationRuntime.observeExecution,
            resolveActionExecutor: request => this.hostResourceRoutes?.resolveLauncherActionExecutor?.(request)
                ?? { execute: async () => ({ ok: false as const, errorCode: 'admission_unavailable', error: 'admission_unavailable' }) },
        });
        this.filesystemAccessPolicy = resolveFilesystemAccessPolicy();
        const resolveWorkspaceMutationActionExecutor = (): RpcActionExecutor | null => this.externalActionIngressOwner && !this.projectionSchedulingClosed ? {
                execute: async (actionId, input, context) => {
                    const owner = this.externalActionIngressOwner;
                    if (!owner || this.projectionSchedulingClosed) return {
                        ok: false, errorCode: 'workspace_file_replace_action_owner_unavailable', error: 'Workspace replacement Action admission is unavailable',
                    };
                    if (context?.serverId && context.serverId !== owner.currentServerId) return {
                        ok: false, errorCode: 'target_unavailable', error: 'Workspace replacement target is unavailable',
                    };
                    const requesterAccountId = context?.runtimeAccountId?.trim()
                        || context?.externalActionCredential?.accountId.trim();
                    if (!requesterAccountId) return {
                        ok: false, errorCode: 'workspace_file_replace_requester_unavailable', error: 'The verified workspace replacement requester is unavailable',
                    };
                    // The owner admits signed-root Actions only; a human-secret or internal Action id is refused here.
                    const signedRootActionId = SignedRootActionIdSchema.safeParse(actionId);
                    if (!signedRootActionId.success) return {
                        ok: false, errorCode: 'workspace_action_not_admitted', error: 'The Action is not admitted on this Machine',
                    };
                    return await owner.executor.execute(signedRootActionId.data, input, { ...context, serverId: owner.currentServerId,
                        externalActionTarget: { kind: 'machine', machineId: this.machine.id }, runtimeAccountId: requesterAccountId });
                },
            } : null;
        registerSessionHandlers(this.rpcHandlerManager, this.machineRpcWorkingDirectory, {
            // The devices Machine role owns these families here (`replaceDevicesRoleRoutes`).
            registerDeviceFamilies: false,
            nativeOperationRuntime: { prepareNativeOperation: input => this.prepareNativeOperation(input) },
            resolveHostHomeServerIdentityId: async signal => (await resolveCurrentMachineExecutionOriginContext(signal))?.serverIdentityId ?? null,
            filesystemEffectAdmission: this.filesystemEffectAdmission,
            workspaceFileReplaceMachineId: this.machine.id,
            resolveWorkspaceFileReplaceActionExecutor: resolveWorkspaceMutationActionExecutor,
            executionBudgetRegistry: this.executionBudgetRegistry,
            admissionDrain: this.lifecycleDependencies.managedActivity?.admissionDrain,
            accessPolicy: this.filesystemAccessPolicy,
            ...(this.lifecycleDependencies.createCapabilitiesApiClient
                ? {
                    createCapabilitiesApiClient:
                        this.lifecycleDependencies.createCapabilitiesApiClient,
                }
                : {}),
            activateCapabilitiesPurposeBindings: this.activateCapabilitiesPurposeBindings,
            getAgentCatalogObservation: () => this.agentCatalogObservation
                ? { machineId: this.machine.id, service: this.agentCatalogObservation }
                : null,
            machineAdmissionTransport: async (request, options) =>
                await this.enqueueSessionPendingByMachine(request, options),
            // G-RC4: thread the live server-features snapshot into the plugin-UI-tier projection so
            // a server that disables `plugins`/`plugins.ui` cascades the tiers OFF in the daemon
            // projection (master §3.5 "server disables X → daemon refuses"). Reuses the one fetch
            // source — no fresh probe path is introduced.
            daemonPluginInvocationLogs: {
                resolveCurrentTarget: async ({ signal }) => await resolveCurrentMachineExecutionOriginContext(signal),
            },
            daemonContributionRegistryProjection: {
                readMachineMetadataSnapshot: machineId => machineId === this.machine.id
                    ? this.getMachineMetadataSnapshot() : undefined,
                resolveHostActionExecutor: request => this.hostResourceRoutes?.resolveLauncherActionExecutor?.(request)
                    ?? { execute: async () => ({ ok: false as const, errorCode: 'service_admission_unavailable', error: 'service_admission_unavailable' }) },
                readHostResourceAccountId: () => this.hostResourceRoutes?.accountId ?? null,
                resolveAccountPluginExecutionSelection: this.resolveAccountPluginExecutionSelection,
                requestCurrentIntent: async request => {
                    const reportUnavailable: NonNullable<typeof request.reportUnavailable> = reason => {
                        logger.debug('[RPC] Target Action current intent unavailable', {
                            code: 'plugin_action_current_intent_unavailable', reason,
                        });
                    };
                    const unavailable = (reason: Parameters<typeof reportUnavailable>[0]) => {
                        reportUnavailable(reason);
                        return { status: 'unavailable' as const, code: 'plugin_action_current_intent_unavailable' };
                    };
                    const runtime = await this.resolveInstalledAccountRuntime(request.signal ?? new AbortController().signal);
                    if (!runtime) return unavailable('installed_account_unavailable');
                    let factory: typeof import('@/session/actions/approvals/credentialedTargetActionCurrentIntent');
                    try { factory = await import('@/session/actions/approvals/credentialedTargetActionCurrentIntent'); }
                    catch { return unavailable('approval_factory_unavailable'); }
                    if (!await runtime.isCurrent()) return unavailable('installed_account_retired');
                    const result = await runWithServerHttpBaseUrl(runtime.serverHttpBaseUrl,
                        () => factory.createCredentialedTargetActionCurrentIntent(runtime.credentials)({ ...request, reportUnavailable }));
                    return await runtime.isCurrent() ? result : unavailable('installed_account_retired');
                },
                resolveCaptureRegistry: () => this.lifecycleDependencies.liveStreamCaptureRegistry ?? null,
                observePluginExecution: this.actionOperationRuntime.observePluginExecution,
                createFileDownloadPublisher: context => this.createFileDownloadPublisher(this.machineRuntimeServerId,
                    buildActionExecutorContextForRpc({ ...context, serverId: this.machineRuntimeServerId,
                        externalActionTarget: { kind: 'machine', machineId: this.machine.id } })),
                resolveServerFeaturesSnapshot: async () => this.lifecycleDependencies.getServerFeaturesSnapshot
                    ? this.lifecycleDependencies.getServerFeaturesSnapshot()
                    : (
                        await this.lifecycleDependencies.resolveServerFeaturesSnapshot?.()
                        ?? await fetchServerFeaturesSnapshot({ serverUrl: resolveServerHttpBaseUrl() })
                    ),
                resolvePluginProjectionExecutionOriginContext: async () =>
                    await resolveCurrentMachineExecutionOriginContext(),
                resolveMessageActionReference: async ({ reference, signal }) => {
                    const credentials = await readStoredCredentials().catch(() => null);
                    signal?.throwIfAborted();
                    if (!credentials) return { status: 'unavailable' as const };
                    return await resolveMessageActionReferenceSnapshotV1({
                        token: this.token,
                        reference,
                        ...(signal ? { signal } : {}),
                        readCurrentMessage: async ({ reference, durableMessage, signal: rowSignal }) =>
                            await readCurrentMessageActionReferenceRowV1({
                                credentials,
                                token: this.token,
                                reference,
                                durableMessage,
                                ...(rowSignal ? { signal: rowSignal } : {}),
                            }),
                    });
                },
                resolveConnectedAccountPurposeBindingRuntime: () => (
                    this.connectedAccountPurposeBindingRuntime
                ),
            },
        });
        registerLanguageIntelligenceHandlers(this.rpcHandlerManager, this.machineRpcWorkingDirectory, {
            effectAdmission: this.filesystemEffectAdmission,
            accessPolicy: this.filesystemAccessPolicy,
            serverId: this.machineRuntimeServerId,
            resolveHomeServerIdentityId: this.machineRpcAdmissionBoundary.resolveHomeServerIdentityId,
            machineId: this.machine.id, resolveActionExecutor: resolveWorkspaceMutationActionExecutor,
            inlineSuggestionDependencies: {
                getServerFeaturesSnapshot: async () => await this.lifecycleDependencies.resolveServerFeaturesSnapshot?.()
                    ?? await fetchServerFeaturesSnapshot({ serverUrl: resolveServerHttpBaseUrl() }),
                resolveSharedGateway: createMachineSharedProviderGatewayResolver({ machineId: this.machine.id,
                    readAccountId: () => readAccountIdFromToken(this.token), readOrigin: resolveCurrentMachineExecutionOriginContext }),
            },
        });
        registerAutomationReplyHandoffRpcHandler(this.rpcHandlerManager, {
            machineId: this.machine.id,
            workflowRunStorage: createWorkflowRunStorageClient({ token: this.token, machineId: this.machine.id }),
            resolveAccountId: async (signal) => await this.getAccountId(signal),
            resolveInstallationId: () =>
                readInstallationIdentityIfExistsSync()?.installationId ?? null,
            resolveAccountEncryptionCurrentness: async (signal) =>
                await fetchAccountEncryptionCurrentness({
                    token: this.token,
                    ...(signal ? { signal } : {}),
                }),
            resolveAccountEncryptionMaterial: async (signal) => {
                const credentials = await readStoredCredentials().catch(() => null);
                signal?.throwIfAborted();
                if (!credentials || credentials.token !== this.token || !credentials.encryption) {
                    return null;
                }
                try {
                    return credentials.encryption.type === 'legacy'
                        ? createAccountScopedCryptoMaterialSnapshotV1({
                            accountEncryptionMode: 'e2ee',
                            material: {
                                type: 'legacy',
                                secret: credentials.encryption.secret,
                            },
                        })
                        : createAccountScopedCryptoMaterialSnapshotV1({
                            accountEncryptionMode: 'e2ee',
                            material: {
                                type: 'dataKey',
                                machineKey: credentials.encryption.machineKey,
                            },
                            dataKeyPublicKey: credentials.encryption.publicKey,
                        });
                } catch {
                    return null;
                }
            },
        });
        const composerMediaStageStore = createActiveDaemonComposerMediaStageStore({
            machineId: this.machine.id,
        });
        const fileSystemHandlers = registerFileSystemHandlers(this.rpcHandlerManager, this.machineRpcWorkingDirectory, {
            effectAdmission: this.filesystemEffectAdmission,
            prepareNativeTransfer: context => this.prepareNativeFilesystemTransfer(context),
            resolveSessionWorkingDirectory: this.lifecycleDependencies.resolveHostedSessionWorkingDirectory,
            accessPolicy: this.filesystemAccessPolicy,
            getAdditionalAllowedReadDirs: () => this.additionalAllowedReadDirs,
            getAdditionalAllowedReadFiles: () => this.transientSessionMediaReadAllowance.readAllowedReadFiles(),
            getAdditionalAllowedWriteDirs: () => this.additionalAllowedWriteDirs,
            mutationMachineId: this.machine.id,
            resolveMutationActionExecutor: () => this.externalActionIngressOwner && !this.projectionSchedulingClosed ? {
                execute: async (actionId, input, context) => {
                    const owner = this.externalActionIngressOwner;
                    if (!owner || this.projectionSchedulingClosed) return {
                        ok: false, errorCode: 'filesystem_action_owner_unavailable',
                        error: 'The current filesystem Action owner is unavailable',
                    };
                    if (context?.serverId && context.serverId !== owner.currentServerId) return {
                        ok: false, errorCode: 'target_unavailable', error: 'Filesystem target is unavailable',
                    };
                    const requesterAccountId = context?.runtimeAccountId?.trim()
                        || context?.externalActionCredential?.accountId.trim();
                    if (!requesterAccountId) return {
                        ok: false, errorCode: 'filesystem_requester_unavailable',
                        error: 'The verified filesystem requester is unavailable',
                    };
                    return await owner.executor.execute(actionId, input, {
                        ...context, serverId: owner.currentServerId,
                        externalActionTarget: { kind: 'machine', machineId: this.machine.id },
                        runtimeAccountId: requesterAccountId,
                    });
                },
            } : null,
            composerMediaStage: {
                executionTarget: {
                    serverId: configuration.activeServerId,
                    machineId: this.machine.id,
                },
                store: composerMediaStageStore,
            },
        });
        this.hostLocalUploadRpc = fileSystemHandlers.localUploadRpc;
        this.rawTransferHandlers = fileSystemHandlers.rawTransferHandlers;
        this.fileSystemTransferRelayOwner = {
            store: fileSystemHandlers.transferSessionStore,
            lifecycle: createTransferSessionLifecycle({
                store: fileSystemHandlers.transferSessionStore,
                chunkSizeBytes: configuration.filesTransferChunkBytes,
            }),
        };
        registerMachineFileBrowserHandlers({
            rpcHandlerManager: this.rpcHandlerManager,
            effectAdmission: this.filesystemEffectAdmission,
            workingDirectory: this.machineRpcWorkingDirectory,
            accessPolicy: this.filesystemAccessPolicy,
        });
        registerWorkspaceAnchorHandlers(createFilesystemEffectRpcRegistrar(this.rpcHandlerManager, this.filesystemEffectAdmission), {
            defaultDirectory: this.machineRpcWorkingDirectory,
            accessPolicy: this.filesystemAccessPolicy,
        });
        registerWorkspaceFaviconHandlers(createFilesystemEffectRpcRegistrar(this.rpcHandlerManager, this.filesystemEffectAdmission), {
            defaultDirectory: this.machineRpcWorkingDirectory,
            accessPolicy: this.filesystemAccessPolicy,
        });
        registerMachineConnectedAccountRpcHandlers({
            rpcHandlerManager: this.rpcHandlerManager,
            machineId: this.machine.id,
            getRuntime: () => this.connectedAccountDaemonRuntime,
            getPoolSelectionRead: () => this.connectedServicePoolSelectionRead,
        });
        // SCM must be machine-scoped so the UI can view diffs/logs and perform staging/commit operations
        // even when no session is currently active.
        registerScmHandlers(this.rpcHandlerManager, this.machineRpcWorkingDirectory, {
            resolveProjectRuntime: ingress => this.resolveProjectFiniteRuntime(ingress),
            accessPolicy: this.filesystemAccessPolicy,
            machineId: this.machine.id,
            selectWorkspaceSource: (context, input) => this.filesystemEffectAdmission.selectWorkspaceSource(context, input),
            resolveRequester: this.filesystemEffectAdmission.resolveRpcRequester,
            nativeOperationRuntime: { prepareNativeOperation: input => this.prepareNativeOperation(input),
                readMemberFolderOwner: path => this.readMemberFolderOwner(path) },
            deliverFileAtRevision: async (request, response, signal) => await deliverScmFileAtRevision({ request, response, signal,
                ...(this.lifecycleDependencies.directPeerServerLifecycle ? { lifecycle: this.lifecycleDependencies.directPeerServerLifecycle } : {}) }),
            prepareFileBytesExport: async input => {
                const lifecycle = this.lifecycleDependencies.directPeerServerLifecycle;
                if (!lifecycle) throw Object.assign(new Error('Prepared file delivery is unavailable'), { errorCode: 'unsupported' });
                return await prepareScmFileBytesExport({ ...input, lifecycle });
            },
        });
    }

    setRPCHandlers({
        spawnSession,
        sessionSpawnV1OutcomeRequired,
        resolveSpawnSessionByNonce,
        stopSession,
        isSessionActive,
        loadLocalSessionMetadata,
        requestShutdown,
        memory,
        daemonServerWorkScheduler,
        machineTransferChannel,
        transferRelayV2Channel,
        directPeerTransfer,
        directTransferImport,
        directTransferExport,
        preparedMachineTransfer,
    }: MachineRpcHandlers, deps?: Omit<MachineRpcHandlerDeps, 'externalAction'> & Readonly<{
        externalActionIngressOwner?: ExternalActionIngressOwner;
        sessionPendingResetStartInstalled?: boolean;
    }>): MachineRpcLifecycleRegistration {
        const readMachineRuntimeServerHttpBaseUrl = this.readMachineRuntimeServerHttpBaseUrl;
        const executionRunRuntimeAccountId = readAccountIdFromToken(this.token) ?? undefined;
        const executionRunServerId = this.machineRuntimeServerId;
        const executionRunAccountOwnerCurrent = () => !this.projectionSchedulingClosed
            && configuration.activeServerId === executionRunServerId;
        const readExecutionRunAccountCredentials = async () => {
            if (!executionRunAccountOwnerCurrent()) return null;
            const credentials = await readStoredCredentialsForServerId(executionRunServerId).catch(() => null);
            return credentials?.token === this.token && executionRunAccountOwnerCurrent() ? credentials : null;
        };
        const readHandoffSourceInstallation = () => {
            const installation = readInstallationIdentityIfExistsSync();
            return !this.projectionSchedulingClosed && configuration.activeServerId === this.machineRuntimeServerId
                && installation?.installationId === this.machineRuntimeInstallationId
                ? { machineId: this.machine.id, installationId: installation.installationId, privateKey: installation.privateKey }
                : null;
        };
        const callHandoffMachine: typeof callMachineRpc = async input => {
            const privateBootstrap = input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3
                || input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_WORKSPACE_CAPTURE_V3;
            const preflight = privateBootstrap || input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET;
            // Native preflight bootstrap needs Home-stamped admission even for a local target.
            if (input.machineId === this.machine.id && !input.externalAction && !privateBootstrap) {
                return await this.rpcHandlerManager.invokeLocal(input.method, input.request,
                    input.signal ? { signal: input.signal } : undefined);
            }
            return preflight ? await callExactMachineRpc(input) : await callMachineRpc(input);
        };
        let executionRunAccountSettings: Awaited<ReturnType<typeof bootstrapAccountSettingsContext>>['settings'] | null = null;
        // Qualify the physical host once for this transport lifetime. An admitted
        // Run still selects its own requester from its private Account holder.
        const readExecutionRunHomeIdentity = () => this.lifecycleDependencies.resolveCurrentServerIdentityId
            ? this.lifecycleDependencies.resolveCurrentServerIdentityId()
            : resolveServerProfileHomeIdentityId(executionRunServerId);
        const executionRunHomeIdentity = readExecutionRunHomeIdentity();
        let hostExecutionCustody: Promise<import('@/daemon/agentIsolation/agentIsolationLaunchPolicy').HostRequesterExecutionIdentity> | undefined;
        let hostExecutionCredentials: StoredCredentials | null = null;
        const hostExecutionCurrent = async () => executionRunAccountOwnerCurrent()
            && Boolean(await executionRunHomeIdentity) && await readExecutionRunHomeIdentity() === await executionRunHomeIdentity
            && readInstallationIdentityIfExistsSync()?.installationId === this.machineRuntimeInstallationId
            && hostExecutionCredentials !== null
            && sameStoredCredentials(hostExecutionCredentials, await readExecutionRunAccountCredentials());
        const readHostAgentExecutionContext: NonNullable<import('@/settings/accountSettings/activeAccountSettingsSnapshot').AccountSettingsSnapshotResolver['readAgentExecutionContext']> = async signal => {
            signal?.throwIfAborted();
            if (!hostExecutionCustody) {
                hostExecutionCustody = (async () => {
                    hostExecutionCredentials = await readExecutionRunAccountCredentials();
                    // Load only after host initialization: this owner reaches the
                    // public SDK and must not introduce a transport import cycle.
                    const { readHostAccountExecutionIdentity } = await import('@/daemon/agentIsolation/agentIsolationAccountCustody');
                    return await readHostAccountExecutionIdentity({ kind: 'agent', credentials: hostExecutionCredentials,
                        catalogCredentials: hostExecutionCredentials, machineId: this.machine.id,
                        hostHomeServerIdentityId: await executionRunHomeIdentity,
                        serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl,
                        isCurrent: hostExecutionCurrent, signal });
                })();
            }
            const requesterIdentity = await hostExecutionCustody.catch(error => {
                hostExecutionCustody = undefined;
                throw error;
            });
            signal?.throwIfAborted();
            if (requesterIdentity.kind === 'unknown') { hostExecutionCustody = undefined; return null; }
            if (!await hostExecutionCurrent()) return null;
            if (requesterIdentity.kind === 'owner_person') return null;
            return { requesterIdentity, isolationEnabled: this.getAgentIsolationSnapshot().enabled };
        };
        const resolveExecutionRunAccountSettingsSnapshot = createExecutionRunAccountSettingsSnapshotResolver({
            machineId: this.machine.id, get serverHttpBaseUrl() { return readMachineRuntimeServerHttpBaseUrl(); },
            readCredentials: readExecutionRunAccountCredentials, isOwnerCurrent: executionRunAccountOwnerCurrent,
            readHostAgentExecutionContext,
            onSettings: settings => { executionRunAccountSettings = settings; },
        });
        const previousAccountSnapshots = this.executionRunAccountSnapshots;
        this.executionRunAccountSnapshots = resolveExecutionRunAccountSettingsSnapshot;
        void previousAccountSnapshots?.dispose();
        const workSummaryInstallation = readInstallationIdentityIfExistsSync();
        const readWorkSummaryAccess = () => createAccountServerActionDeps({ token: this.token,
            serverId: executionRunServerId, serverHttpBaseUrl: readMachineRuntimeServerHttpBaseUrl(),
            isCredentialCurrent: async () => (await readStoredCredentialsForServerId(executionRunServerId).catch(() => null))?.token === this.token,
        });
        const executionRunApprovalDeps = createExecutionRunRpcApprovalDeps({ readCredentials: async () => {
            const credentials = await readStoredCredentialsForServerId(executionRunServerId).catch(() => null);
            return credentials?.token === this.token ? credentials : null;
        } });
        const actionsSettingsProvider = deps?.actionsSettingsProvider ?? createActionSettingsProvider({
            scopeKey: resolveAccountSettingsScopeKeyForToken(this.token),
        });
        this.sessionSpawnV1OutcomeRequired = sessionSpawnV1OutcomeRequired === true;
        this.sessionPendingResetStartInstalled = deps?.sessionPendingResetStartInstalled === true;
        this.externalActionExecutionAuthorizationV1OutcomeRequired =
            deps?.externalActionIngressOwner?.externalActionMachineRequestPrivateKey !== undefined;
        this.agentCatalogObservation = deps?.agentCatalogObservation ?? null;
        const resolveExternalActionOrigin = createCurrentMachineExecutionOriginContextResolver({
            get serverUrl() { return readMachineRuntimeServerHttpBaseUrl(); },
            resolveCurrentMachineId: () => this.machine.id,
            ...(this.lifecycleDependencies.resolveCurrentServerIdentityId
                ? { resolveCurrentServerIdentityId: this.lifecycleDependencies.resolveCurrentServerIdentityId } : {}),
        });
        // The raw registrar admits through the same physical filesystem owner;
        // retain that exact ingress through every later byte/mutation phase.
        const rawFilesystemScope = (rootPath: string, context?: import('./rpc/types').RpcHandlerContext) => {
            if (!context?.machineAdmission || !context.verifyMachineAdmissionCurrent) throw Object.assign(
                new Error('Requester-bound filesystem IO is unavailable on this Machine'),
                { errorCode: 'filesystem_identity_custody_unavailable' });
            return { rootPath, requesterAccountId: context.machineAdmission.actorAccountId,
                assertCurrentAuthority: async () => {
                    context.signal.throwIfAborted();
                    if (!await context.verifyMachineAdmissionCurrent!()) throw Object.assign(
                        new Error('Filesystem requester admission is no longer current'),
                        { errorCode: 'filesystem_identity_custody_unavailable' });
                    context.signal.throwIfAborted();
                } };
        };
        const machineRpcLifecycleRegistration = registerMachineRpcHandlers({
            rpcHandlerManager: this.rpcHandlerManager,
            handlers: {
                spawnSession,
                ...(sessionSpawnV1OutcomeRequired === true
                    ? { sessionSpawnV1OutcomeRequired: true }
                    : {}),
                ...(resolveSpawnSessionByNonce ? { resolveSpawnSessionByNonce } : {}),
                stopSession,
                ...(isSessionActive ? { isSessionActive } : {}),
                ...(loadLocalSessionMetadata ? { loadLocalSessionMetadata } : {}),
                requestShutdown,
                ...(memory ? { memory } : {}),
                ...(daemonServerWorkScheduler ? { daemonServerWorkScheduler } : {}),
                ...(machineTransferChannel ? { machineTransferChannel } : {}),
                ...(transferRelayV2Channel ? { transferRelayV2Channel } : {}),
                ...(directPeerTransfer ? { directPeerTransfer } : {}),
                ...(directTransferImport ? { directTransferImport } : {}),
                ...(directTransferExport ? { directTransferExport } : {}),
                ...(preparedMachineTransfer ? { preparedMachineTransfer: {
                    ...preparedMachineTransfer, rawTransferHandlers: this.rawTransferHandlers,
                } } : {}),
            },
            deps: {
                ...deps,
                observeCapabilitiesCliSnapshot: async (observation) => {
                    await this.updateMachineMetadata(metadata => {
                        const current = metadata ?? this.machine.metadata;
                        if (!current) throw new Error('Machine metadata is unavailable for Agent install facts.');
                        return current;
                    }, { agentInventoryObservation: observation });
                },
                sessionHandoffPreflight: {
                    readCredentials: readExecutionRunAccountCredentials,
                    callMachine: createSessionHandoffPreflightMachineRpc({ callMachine: callHandoffMachine,
                        authorization: { get serverHttpBaseUrl() { return readMachineRuntimeServerHttpBaseUrl(); },
                            readSourceInstallation: readHandoffSourceInstallation } }),
                },
                ...(deps?.deviceLocalSecretStorage && workSummaryInstallation && executionRunRuntimeAccountId ? {
                    nativeUsage: {
                        authority: { serverId: executionRunServerId, accountId: executionRunRuntimeAccountId, machineId: this.machine.id },
                        installationId: workSummaryInstallation.installationId,
                        activeServerDir: configuration.activeServerDir,
                        get serverHttpBaseUrl() { return readMachineRuntimeServerHttpBaseUrl(); },
                        token: this.token,
                        storage: deps.deviceLocalSecretStorage,
                        readCredentials: async () => this.projectionSchedulingClosed
                            ? null : await readStoredCredentialsForServerId(executionRunServerId),
                        invalidateSources: () => this.emitUsageSourcesInvalidated(),
                    },
                } : {}),
                accountReadRuntime: (ingress) => this.resolveOwnSessionRuntime(ingress),
                readSpawnFailureLimits: this.lifecycleDependencies.readSpawnFailureLimits,
                ownerRemainder: this.lifecycleDependencies.ownerRemainder,
                agentIsolation: this.lifecycleDependencies.agentIsolation,
                prepareManagedSessionHandoffDirectoryPlacement: async (request, context) => {
                    const signal = context?.signal ?? new AbortController().signal;
                    const prepareMember = createSessionAgentIsolationMemberPreparation({
                        machineId: this.machine.id, custodianAccountId: readAccountIdFromToken(this.token),
                        agentIsolation: this.lifecycleDependencies.agentIsolation,
                        resolveCurrentMachineExecutionOriginContext: resolveExternalActionOrigin,
                    })(context?.requesterSessionBootstrap ? { bootstrap: context.requesterSessionBootstrap } : null, signal);
                    const placement = await prepareDaemonAgentIsolationIdentity({ hasAgentRuntime: true,
                        prepareAgentIsolationMember: prepareMember,
                        requesterWorkAttributionV1: context?.requesterSessionBootstrap?.attribution, signal,
                        managedDirectory: { directory: request.targetPath, workspaceRoots: this.lifecycleDependencies.agentIsolation?.read()?.workspaceRoots ?? [] },
                    });
                    if (!placement.ok) throw new PluginError({ code: 'agent_isolation_unavailable',
                        message: 'Choose an accepted Workspace or path for this Session', retryable: false });
                    return placement.payloadPlacement;
                },
                nativeOperationRuntime: { prepareNativeOperation: input => this.prepareNativeOperation(input),
                    readMemberFolderOwner: path => this.readMemberFolderOwner(path),
                    prepareConnectedAccountProcessEnvironment: input => this.prepareConnectedAccountProcessEnvironment(input) },
                resolveHostHomeServerIdentityId: async signal => (await resolveExternalActionOrigin(signal))?.serverIdentityId ?? null,
                mcpServers: { ...deps?.mcpServers, readCredentials: readExecutionRunAccountCredentials,
                    nativeOperationRuntime: { prepareNativeOperation: input => this.prepareNativeOperation(input) },
                    get serverHttpBaseUrl() { return readMachineRuntimeServerHttpBaseUrl(); } },
                filesystemEffectAdmission: this.filesystemEffectAdmission,
                createFilesystemTransferScope: rawFilesystemScope,
                readMachineEffectiveCores: this.lifecycleDependencies.readMachineEffectiveCores,
                executionBudgetRegistry: this.executionBudgetRegistry,
                ...(this.lifecycleDependencies.managedActivity && workSummaryInstallation && executionRunRuntimeAccountId ? {
                    machineWorkSummary: {
                        target: { serverId: executionRunServerId, machineId: this.machine.id, installationId: workSummaryInstallation.installationId },
                        custodianAccountId: executionRunRuntimeAccountId,
                        activity: this.lifecycleDependencies.managedActivity.activity,
                        summaryActivity: this.getLiveWorkProducer(),
                        ...(this.lifecycleDependencies.readProjectFiniteLoad
                            ? { readFiniteLoad: this.lifecycleDependencies.readProjectFiniteLoad } : {}),
                        readAccess: async (signal) => await readWorkSummaryAccess().machineAccessAction!({ actionId: 'machines.access.grants.list',
                            input: { serverId: executionRunServerId, machineId: this.machine.id }, context: { surface: 'cli', serverId: executionRunServerId }, signal }),
                    },
                } : {}),
                ...(this.lifecycleDependencies.managedActivity ? {
                    managedActivity: {
                        ...this.lifecycleDependencies.managedActivity,
                        commitIdleEvidence: (managedTarget, idle, context) => {
                            const installation = readInstallationIdentityIfExistsSync();
                            if (!context.machineAdmission || !installation
                                || context.signal.aborted
                                || installation.installationId !== context.machineAdmission.installationId
                                || context.machineAdmission.machineId !== this.machine.id
                                || !this.lifecycleDependencies.managedActivity?.admissionDrain.isQuiescing()
                                || this.lifecycleDependencies.managedActivity.admissionDrain.isFinalShutdown()) return null;
                            const method = `${this.machine.id}:${MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD}`;
                            const decision = { ...idle, confirmedAt: Date.now() };
                            return { context: context.machineAdmission, method, managedTarget, decision,
                                proof: signMachineInstallationProof({ privateKey: installation.privateKey, payload: {
                                    version: 1, machineId: this.machine.id, installationId: installation.installationId,
                                    accountId: context.machineAdmission.custodianAccountId,
                                    rpcAdmission: { context: context.machineAdmission, method, managedTarget, managedIdleDecision: decision },
                                } }),
                            };
                        },
                    } satisfies ManagedActivityRpcOwner,
                } : {}),
                ...(this.lifecycleDependencies.createProjectFiniteRuntime ? {
                    createProjectFiniteRuntime: this.lifecycleDependencies.createProjectFiniteRuntime,
                    beforeProjectFiniteRetire: async () => {
                        await this.setProjectFiniteExecutionLive(false).catch((error) => {
                            logger.debug('[API MACHINE] Failed to acknowledge finite execution withdrawal', {
                                error: serializeAxiosErrorForLog(error),
                            });
                        });
                    },
                } : {}),
                actionsSettingsProvider,
                currentMachineId: this.machine.id,
                readMachineMetadataSnapshot: () => this.getMachineMetadataSnapshot(),
                ...(workSummaryInstallation ? { sessionCreationInstallation: workSummaryInstallation } : {}),
                ...(this.lifecycleDependencies.requesterSessionRuntime ? { requesterSessionRuntime: this.lifecycleDependencies.requesterSessionRuntime } : {}),
                requesterBootstrapBoundary: this.lifecycleDependencies.requesterBootstrapBoundary ?? {
                    serverId: this.machineRuntimeServerId,
                    get serverHttpBaseUrl() { return readMachineRuntimeServerHttpBaseUrl(); },
                    happyHomeDir: configuration.happyHomeDir,
                    getObservedServerIdentityId: async () => (await resolveExternalActionOrigin())?.serverIdentityId ?? null,
                    readInstallation: async () => {
                        const identity = readInstallationIdentityIfExistsSync();
                        return identity && !this.projectionSchedulingClosed
                            && identity.installationId === this.machineRuntimeInstallationId
                            && configuration.activeServerId === this.machineRuntimeServerId
                            ? { machineId: this.machine.id, identity } : null;
                    },
                },
                currentServerId: configuration.activeServerId,
                ...(executionRunRuntimeAccountId ? { executionRunRuntimeAccountId } : {}),
                executionRunApprovalDeps,
                executionRunAccountSettings: {
                    get serverUrl() { return readMachineRuntimeServerHttpBaseUrl(); },
                    resolveAccountSettings: async () => (await resolveExecutionRunAccountSettingsSnapshot()).settings,
                    resolveAccountSettingsSnapshot: resolveExecutionRunAccountSettingsSnapshot,
                    readModelProjection: createAccountScopedProviderModelProjectionReader({
                        get serverUrl() { return readMachineRuntimeServerHttpBaseUrl(); },
                        readCredentials: readExecutionRunAccountCredentials,
                        readAccountSettingsSnapshot: resolveExecutionRunAccountSettingsSnapshot,
                        isCurrent: executionRunAccountOwnerCurrent,
                    }),
                    ...(deps?.resolveManagedPurposeBindingIntent ? {
                        resolveManagedPurposeBindingIntent: deps.resolveManagedPurposeBindingIntent,
                        ...(deps.openAccountConnectionManagedConsumerSource && executionRunRuntimeAccountId ? {
                            prepareManagedEndpoint: createExecutionRunManagedProviderEndpointPreparer({
                                machineId: this.machine.id,
                                accountId: executionRunRuntimeAccountId,
                                readAccountSettingsSnapshot: resolveExecutionRunAccountSettingsSnapshot,
                                resolveManagedPurposeBindingIntent: deps.resolveManagedPurposeBindingIntent,
                                openSource: deps.openAccountConnectionManagedConsumerSource,
                            }),
                        } : {}),
                    } : {}),
                    actionsSettingsProvider: createActionSettingsProvider({
                        scopeKey: resolveAccountSettingsScopeKeyForToken(this.token),
                        getAccountSettings: () => executionRunAccountSettings,
                    }),
                },
                ...(executionRunRuntimeAccountId ? {
                    projectOpen: {
                        ...deps?.projectOpen,
                        privateCheckout: { prepareNativeOperation: input => this.prepareNativeOperation(input) },
                        serverId: executionRunServerId,
                        serverHttpBaseUrl: resolveServerHttpBaseUrl(),
                        machineId: this.machine.id,
                        accountId: executionRunRuntimeAccountId,
                        setupPreparation: deps?.projectOpen?.setupPreparation ?? {
                            nativeIo: projectNativeSystemIo,
                            platform: { os: process.platform === 'win32' ? 'windows' : process.platform, arch: process.arch },
                            successHomeDir: configuration.happyHomeDir,
                        },
                        ...(this.lifecycleDependencies.workspaceSyncHandoffAdapter ? {
                            workspaceSyncAdapter: this.lifecycleDependencies.workspaceSyncHandoffAdapter,
                        } : {}),
                        readCredentials: async () => {
                            if (configuration.activeServerId !== executionRunServerId) return null;
                            const credentials = await readStoredCredentialsForServerId(executionRunServerId).catch(() => null);
                            return credentials?.token === this.token ? credentials : null;
                        },
                        callWorkspaceSource: async request => {
                            const credentials = await readStoredCredentialsForServerId(executionRunServerId).catch(() => null);
                            if (!credentials || credentials.token !== this.token || configuration.activeServerId !== executionRunServerId) {
                                throw Object.assign(new Error('Installed Project SOURCE transport is unavailable'), { code: 'peer_unavailable' });
                            }
                            return this.callWorkspaceSyncProjectSource({ ...request, credentials });
                        },
                    },
                } : {}),
                ...(deps?.externalActionIngressOwner
                    ? {
                        externalAction: {
                            ...deps.externalActionIngressOwner,
                            get currentServerHttpBaseUrl() { return deps?.externalActionIngressOwner?.currentServerHttpBaseUrl; },
                            resolveEncryption: (signal, authorization) => this.resolveExternalActionEncryption(signal, authorization),
                            machineId: this.machine.id,
                            resolveAccountId: async (signal) => await this.getAccountId(signal),
                            resolveInstallationId: () => readInstallationIdentityIfExistsSync()?.installationId ?? null,
                            verifyExecutionAuthorization: async (input) => {
                                const installation = readInstallationIdentityIfExistsSync();
                                if (!installation || installation.installationId !== input.authorization.binding.installationId) return false;
                                return await verifyExternalActionExecutionAuthorizationCurrent({
                                    ...input,
                                    privateKey: installation.privateKey,
                                    installationId: installation.installationId,
                                    serverHttpBaseUrl: readMachineRuntimeServerHttpBaseUrl(),
                                });
                            },
                        },
                    }
                    : {}),
                actionOperations: {
                    store: this.actionOperationRuntime.store,
                    runner: this.actionOperationRuntime.runner,
                    attachOwner: this.actionOperationRuntime.attachOwner,
                    handlers: this.actionOperationRuntime.handlers,
                    observeExecution: this.actionOperationRuntime.observeExecution,
                    decideSetupReview: this.actionOperationRuntime.decideSetupReview,
                    waitForProjectTerminalAttachment: this.actionOperationRuntime.waitForProjectTerminalAttachment,
                    retireProjectFiniteOperations: this.actionOperationRuntime.retireProjectFiniteOperations,
                },
                ...(this.lifecycleDependencies.workspaceSync
                    ? { workspaceSync: this.lifecycleDependencies.workspaceSync }
                    : {}),
                ...(this.lifecycleDependencies.resolveServerFeaturesSnapshot
                    ? { resolveServerFeaturesSnapshot: this.lifecycleDependencies.resolveServerFeaturesSnapshot }
                    : {}),
                ...(this.lifecycleDependencies.workspaceSyncHandoffAdapter
                    ? {
                        sessionHandoffCoordinator: createTrackedSessionHandoffCoordinator({
                            expectedAccountServerId: configuration.activeServerId,
                            resolveWorkspaceAccountServerId: async (signal, options) => await this.readWorkspaceSyncHomeIdentity({
                                effectful: true, requireFreshHome: options?.requireFreshHome ?? true, ...(signal ? { signal } : {}),
                            }),
                            readCredentials: readExecutionRunAccountCredentials,
                            handoffAuthorization: {
                                sourceExportStore: createSessionHandoffSourceExportStore({ activeServerDir: configuration.activeServerDir }),
                                serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl,
                                readSourceInstallation: readHandoffSourceInstallation,
                            },
                            callWorkspaceSourcePhase: async (descriptor, context) => {
                                const credentials = await readStoredCredentialsForServerId(this.machineRuntimeServerId);
                                if (!credentials) throw Object.assign(new Error('Workspace source transport is unavailable'), { code: 'peer_unavailable' });
                                return await this.callWorkspaceSyncHandoffSourcePhase({ ...descriptor, context, credentials });
                            },
                            callMachine: callHandoffMachine,
                            workspaceSyncAdapter:
                                this.lifecycleDependencies.workspaceSyncHandoffAdapter,
                        }),
                    }
                    : {}),
                ...(this.lifecycleDependencies.createCapabilitiesApiClient
                    ? {
                        createCapabilitiesApiClient:
                            this.lifecycleDependencies.createCapabilitiesApiClient,
                    }
                    : {}),
                activateCapabilitiesPurposeBindings: this.activateCapabilitiesPurposeBindings,
                sessionServerStart: {
                    machineId: this.machine.id,
                    readMachineMetadataSnapshot: () => this.getMachineMetadataSnapshot(),
                    token: this.token,
                    readCredentials: async () => await readStoredCredentials().catch(() => null),
                    resolveAccountId: async (signal) => await this.getAccountId(signal),
                    resolveInstallationId: () =>
                        readInstallationIdentityIfExistsSync()?.installationId ?? null,
                    resolveAccountEncryptionCurrentness: async (signal) =>
                        await fetchAccountEncryptionCurrentness({
                            token: this.token,
                            ...(signal ? { signal } : {}),
                        }),
                    machineAdmissionTransport: async (request, options) =>
                        await this.enqueueSessionPendingByMachine(request, options),
                },
                externalSessionStatusDemandChannel: this,
                subscribeSessionArchivedStateChanges:
                    deps?.subscribeSessionArchivedStateChanges
                    ?? ((listener) => this.onSessionArchivedStateChange(listener)),
                subscribeSessionDeletedChanges: (listener) =>
                    this.onSessionDeletedChange(listener),
                workingDirectory: deps?.workingDirectory ?? this.machineRpcWorkingDirectory,
                filesystemAccessPolicy: deps?.filesystemAccessPolicy ?? this.filesystemAccessPolicy,
                getAdditionalAllowedWriteDirs: deps?.getAdditionalAllowedWriteDirs ?? (() => this.additionalAllowedWriteDirs),
                transientMediaReadAllowance: deps?.transientMediaReadAllowance ?? this.transientSessionMediaReadAllowance,
                extraTransferRelayV2DownloadOwners: [
                    this.fileSystemTransferRelayOwner,
                    ...(deps?.extraTransferRelayV2DownloadOwners ?? []),
                ],
            },
        });
        this.rpcLifecycleRegistrations.push(machineRpcLifecycleRegistration);
        this.liveWorkProducer.notifyChanged();
        if (!this.managedActivityPublicationCleanup && this.lifecycleDependencies.managedActivity) {
            const activity = this.lifecycleDependencies.managedActivity.activity;
            const stopDecision = activity.subscribe((decision) => {
                void this.updateDaemonState((state) => ({ ...(state ?? { status: 'running' as const }), managedActivity: decision }),
                    { managedActivityChanged: true })
                    .catch((error) => logger.debug('[API MACHINE] Managed activity publication failed', { error: serializeAxiosErrorForLog(error) }));
            });
            const stopFacts = activity.subscribeFacts(() => {
                if (this.projectionSchedulingClosed || !this.socket?.connected) return;
                this.socket.emit('machine-alive', { machineId: this.machine.id, time: Date.now(), workSummaryChanged: true });
            });
            this.managedActivityPublicationCleanup = () => { stopFacts(); stopDecision(); };
        }
        void this.setProjectFiniteExecutionLive(machineRpcLifecycleRegistration.projectFiniteExecutionInstalled)
            .catch((error) => logger.warn('[API MACHINE] Finite execution capability publication failed', error));
        this.rpcHandlerManager.replaceOwnedHandlers('machine-project-definitions', () => {
            if (deps?.externalActionIngressOwner) registerProjectDefinitionHandlers({
                rpcHandlerManager: this.rpcHandlerManager,
                machineId: this.machine.id,
                actionExecutor: deps.externalActionIngressOwner.executor,
            });
        });
        this.externalActionIngressOwner = deps?.externalActionIngressOwner ?? null;
        return machineRpcLifecycleRegistration;
    }

    /** Effect dependency consumed only after the daemon's full Action admission. */
    createProjectDefinitionAction(serverId: string, ingress?: RpcHandlerContext): ReturnType<typeof createProjectDefinitionAction> {
        return createProjectDefinitionAction({
            serverId, machineId: this.machine.id, workingDirectory: this.machineRpcWorkingDirectory,
            accessPolicy: this.filesystemAccessPolicy,
            acquirePluginRuntime: acquireAuthoritativePluginRuntimeRegistryLease,
            getTerminalSessions: () => this.getFiniteTerminalSessions(),
            readActiveProjectCommands: () => this.projectionSchedulingClosed ? null
                : this.rpcLifecycleRegistrations.at(-1)?.readActiveProjectCommands?.() ?? null,
            ...(ingress ? { readEffectiveDefinition: async ({ workspace, context, repositorySnapshot, reviewSharedSetup }) => {
                const runtime = await this.resolveProjectFiniteRuntime(ingress);
                if (!runtime) throw Object.assign(new Error('project_setup_runtime_unavailable'), { code: 'project_setup_runtime_unavailable' });
                return await readProjectEffectiveDefinitionFromRuntime({ runtime, ingress, workspace, context, repositorySnapshot, reviewSharedSetup });
            }, inspectSetup: async ({ workspace, context, reviewSetupConsent }) => {
                const startedAt = performance.now();
                const runtime = await this.resolveProjectFiniteRuntime(ingress);
                logger.debug('[ProjectSetup] inspection phase', { phase: 'runtime',
                    requestId: context.actionRequestId ?? ingress.transportRequestId,
                    durationMs: Math.round(performance.now() - startedAt), status: runtime ? 'completed' : 'refused' });
                return runtime ? inspectProjectSetupFromRuntime({ runtime, ingress, workspace, context, reviewSetupConsent })
                    : { setupReadiness: { kind: 'unknown' as const, code: 'project_setup_runtime_unavailable' } };
            } } : {}),
        });
    }

    /** Device-local profile ids can differ on an approved replay of this same Home. */
    private async isNativeWorkspaceHomeCurrent(serverId: string, context: RpcActionExecutorContext,
        heldHome = this.lifecycleDependencies.resolveCurrentServerIdentityId?.() ?? null): Promise<boolean> {
        const owner = this.externalActionIngressOwner;
        if (!owner || this.projectionSchedulingClosed || owner.currentServerId !== serverId) return false;
        context.signal?.throwIfAborted();
        if (areServerProfileIdentifiersEquivalent(context.serverId, serverId, id =>
            id === serverId || id === heldHome ? heldHome : undefined)) return true;
        if (heldHome) return context.serverIdentityId === heldHome;
        if (!context.serverIdentityId || !owner.resolvePluginExecutionOriginContext) return false;
        try {
            // Reuse the ingress owner's canonical fresh Home/Machine witness,
            // not the requesting device's profile id or an approval flag.
            const current = await owner.resolvePluginExecutionOriginContext();
            context.signal?.throwIfAborted();
            return this.externalActionIngressOwner === owner && !this.projectionSchedulingClosed
                && current?.serverIdentityId === context.serverIdentityId && current.machineId === this.machine.id;
        } catch (error) {
            if (context.signal?.aborted) throw error;
            return false;
        }
    }

    private filesystemEffectConfiguration(requesterAccountId?: string): import('@/rpc/handlers/fileSystem/filesystemEffectOperation').FilesystemEffectConfiguration {
        return { machineId: this.machine.id, ...(requesterAccountId === undefined ? {} : { requesterAccountId }), workingDirectory: this.machineRpcWorkingDirectory,
            accessPolicy: this.filesystemAccessPolicy, additionalAllowedReadDirs: [...this.additionalAllowedReadDirs],
            additionalAllowedWriteDirs: [...this.additionalAllowedWriteDirs],
            additionalAllowedReadFiles: [...this.transientSessionMediaReadAllowance.readAllowedReadFiles()],
            sessionRpcTransferMaxBytes: resolveServerRoutedTransferMaxBytes() };
    }

    /** File effects keep the already admitted Action's local cancellation signal. */
    private openNativeFilesystemChannel(input: Readonly<{ requester: FilesystemEffectRequester;
        identity: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }>; operationKey: string;
        signal: AbortSignal; ingress?: RpcHandlerContext; allowMemberPreparation?: false }>) {
        const account = readRequesterAccountActionContext(input.ingress?.callerInputAuthorization
            ?? input.ingress?.localActionContext?.externalActionExecutionAuthorization);
        const releaseAccount = account?.retain();
        return prepareNativeFilesystemEffect({ prepareNativeOperation: args => this.prepareNativeOperation(args),
            identity: input.identity, operationKey: input.operationKey, signal: input.signal,
            ...(input.allowMemberPreparation === false ? { allowMemberPreparation: false as const } : {}),
            ...(input.ingress ? { ingress: input.ingress } : {}),
            configuration: { ...this.filesystemEffectConfiguration(input.identity.requester.accountId),
                ...(input.ingress?.capabilitySessionFactories ? { capabilitySessionFactories: input.ingress.capabilitySessionFactories } : {}),
                ...(input.ingress?.callerAuthority ? { callerAuthority: input.ingress.callerAuthority } : {}) },
            releaseRequester: async () => { await input.requester.dispose(); await releaseAccount?.(); } });
    }

    private async prepareNativeFilesystemTransfer(context?: RpcHandlerContext): Promise<NativeTransferSessionOwner | null> {
        const requester = await this.filesystemEffectAdmission.resolveRpcRequester?.(context);
        if (!requester || requester.identity.kind === 'unknown' || !context) {
            await requester?.dispose();
            throw Object.assign(new Error('Filesystem requester is unavailable'), { code: 'filesystem_identity_custody_unavailable' });
        }
        const identity = requester.identity;
        if (isHostRequesterUnrestrictedOwner(identity) || identity.kind === 'isolated'
            && resolveHostRequesterAgentPlacementForHost({ identity,
                snapshot: this.lifecycleDependencies.agentIsolation?.read() }) === 'daemon') {
            await requester.dispose(); return null;
        }
        if (identity.kind !== 'isolated') { await requester.dispose(); return null; }
        const controller = new AbortController();
        const cancelInitialization = () => { controller.abort(context.signal.reason); };
        context.signal.addEventListener('abort', cancelInitialization, { once: true });
        if (context.signal.aborted) cancelInitialization();
        try {
            const channel = await this.openNativeFilesystemChannel({ requester, identity, signal: controller.signal, ingress: context,
                operationKey: context.localActionContext?.operationAcceptance?.operationId
                    ?? context.localActionContext?.actionRequestId ?? context.transportRequestId ?? '' });
            return createFilesystemEffectRpcOwner({ request: request => channel.request(request), dispose: async () => {
                context.signal.removeEventListener('abort', cancelInitialization); await channel.dispose();
            } }, async incoming => {
                // Both inputs are host-owned transport contexts, never transfer DTOs.
                const admission: unknown = incoming && typeof incoming === 'object' ? Reflect.get(incoming, 'machineAdmission') : undefined;
                const scopeUserId: unknown = incoming && typeof incoming === 'object' ? Reflect.get(incoming, 'scopeUserId') : undefined;
                const sameRpc = admission && typeof admission === 'object'
                    && Reflect.get(admission, 'actorAccountId') === identity.requester.accountId
                    && Reflect.get(admission, 'machineId') === identity.requester.machineId
                    && Reflect.get(admission, 'installationId') === identity.requester.installationId;
                if (!sameRpc && scopeUserId !== identity.requester.accountId) throw Object.assign(
                    new Error('Transfer belongs to another requester'), { code: 'FILESYSTEM_TRANSFER_SCOPE_MISMATCH' });
            }, () => { context.signal.throwIfAborted(); context.signal.removeEventListener('abort', cancelInitialization); });
        } catch (error) {
            context.signal.removeEventListener('abort', cancelInitialization);
            await requester.dispose();
            throw error;
        }
    }

    /** File effects keep the already admitted Action's local cancellation signal. */
    private captureFilesystemActionCurrentness(context: RpcActionExecutorContext): () => Promise<void> {
        return () => assertFilesystemEffectCurrent(context);
    }

    /** Preview reads locally after admission rather than re-entering its registered RPC. */
    createWorkspaceFileReplacePreviewActionExecutor(serverId: string): NonNullable<ActionExecutorDeps['workspaceFilesReplacePreview']> {
        return async ({ machineId, ...request }, context) => {
            const custodyFailure = await this.filesystemEffectAdmission.action(context);
            if (custodyFailure) return { ok: false, ...custodyFailure };
            const target = context.externalActionTarget;
            if (machineId !== this.machine.id || target?.kind !== 'machine' || target.machineId !== machineId
                || !await this.isNativeWorkspaceHomeCurrent(serverId, context)) {
                return { ok: false, errorCode: 'target_unavailable', error: 'Workspace replacement target is unavailable' };
            }
            return previewWorkspaceFileReplace(request, this.machineRpcWorkingDirectory, this.filesystemAccessPolicy,
                { signal: context.signal });
        };
    }

    /** Replacement and Undo share this native effect after canonical Action admission. */
    createWorkspaceFileReplaceActionExecutor(serverId: string): NonNullable<ActionExecutorDeps['workspaceFilesReplace']> {
        return async ({ machineId, ...request }, context) => {
            const custodyFailure = await this.filesystemEffectAdmission.action(context);
            if (custodyFailure) return { ok: false, ...custodyFailure };
            const target = context.externalActionTarget;
            if (machineId !== this.machine.id || target?.kind !== 'machine' || target.machineId !== machineId
                || !await this.isNativeWorkspaceHomeCurrent(serverId, context)) {
                return { ok: false, errorCode: 'target_unavailable', error: 'Workspace replacement target is unavailable' };
            }
            if (context.operationAcceptance?.actionId === 'workspace.files.replace') {
                context.operationAcceptance.accept({ operation: { operationId: context.operationAcceptance.operationId } });
            }
            return await applyWorkspaceFileReplace(request, this.machineRpcWorkingDirectory, this.filesystemAccessPolicy,
                { signal: context.signal });
        };
    }

    createLanguageIntelligenceApplyActionExecutor(serverId: string): NonNullable<ActionExecutorDeps['languageIntelligenceApply']> {
        return async ({ machineId, request }, context) => {
            const custodyFailure = await this.filesystemEffectAdmission.action(context);
            if (custodyFailure) return { ok: false, ...custodyFailure };
            const target = context.externalActionTarget;
            if (machineId !== this.machine.id || target?.kind !== 'machine' || target.machineId !== machineId
                || !await this.isNativeWorkspaceHomeCurrent(serverId, context)) {
                return { ok: false, errorCode: 'target_unavailable', error: 'Language Action target is unavailable' };
            }
            const { getLanguageServerHost } = await import('@/lsp/languageServerHost');
            context.signal?.throwIfAborted();
            const root = authorizeFilesystemPath({ targetPath: request.rootPath, defaultDirectory: this.machineRpcWorkingDirectory, accessPolicy: this.filesystemAccessPolicy });
            if (!root.valid) return { status: 'error', errorCode: 'path_not_allowed' };
            return getLanguageServerHost().apply({ ...request, rootPath: root.resolvedPath }, {
                signal: context.signal, requesterWorkAttributionV1: projectRpcRequesterWorkAttribution(context,
                    this.lifecycleDependencies.resolveCurrentServerIdentityId?.() ?? context.serverIdentityId),
            });
        };
    }

    /** Private byte effect of an admitted provider Action, not a nested filesystem Action. */
    createFileDownloadPublisher(serverId: string, context: RpcActionExecutorContext): NonNullable<RpcActionExecutorContext['prepareFileDownload']> {
        return async (input, options) => {
            const lifecycle = this.lifecycleDependencies.directPeerServerLifecycle;
            const owner = this.externalActionIngressOwner;
            const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
            const requesterAccountId = requester?.authorization.binding.accountId;
            const target = context.externalActionTarget;
            const acceptance = options.operationAcceptance;
            const ownerUpdate = options.operationOwnerUpdate;
            if (!lifecycle || !owner || !requester || !requesterAccountId || !acceptance || !ownerUpdate || target?.kind !== 'machine' || target.machineId !== this.machine.id) {
                return { success: false, status: 'failed', errorCode: 'filesystem_transfer_custody_required', error: 'File download custody is unavailable.' };
            }
            const recordOutcome = (outcome: import('@happier-dev/protocol/actions/filesystemActionFamily').FileDownloadResultV1) => {
                ownerUpdate.update({ cancellation: 'unsupported', outcome: outcome.success ? { ok: true, result: outcome }
                    : { ok: false, errorCode: outcome.status === 'cancelled' ? 'cancelled'
                        : outcome.status === 'unknown' ? 'indeterminate' : outcome.errorCode ?? 'filesystem_transfer_failed', error: outcome.error } });
                return outcome;
            };
            const release = requester.retain();
            // The RPC receipt caller can end after early acceptance. Per-read
            // authority follows the retained requester and occurrence instead;
            // options.signal still carries the actual operation cancellation.
            const retainedContext = { ...context, signal: undefined };
            const sourceId = context.actionRequestId ?? acceptance.operationId;
            const receipt = await prepareAcquiredFileDownload({ lifecycle, input, requesterAccountId,
                sourceId, operationId: acceptance.operationId,
                retirementSignal: options.retirementSignal, ...(options.signal ? { signal: options.signal } : {}),
                onDispose: release, assertCurrentAuthority: async () => {
                    if (!options.isOccurrenceCurrent() || this.externalActionIngressOwner !== owner || this.projectionSchedulingClosed
                        || !await requester.isCurrent()
                        || !await this.isNativeWorkspaceHomeCurrent(serverId, retainedContext)) {
                        throw new Error('File download authority is no longer current');
                    }
                } });
            if (!receipt.success || receipt.status !== 'accepted') return recordOutcome(receipt);
            const scope = { kind: 'acquired' as const, sourceId, requesterAccountId, destinationId: input.destination.destinationId };
            const settlement = lifecycle.waitForFilesystemExportSettlement(receipt.prepared.transferId, scope);
            const cancel = () => {
                lifecycle.clearPublishedTransfer(receipt.prepared.transferId, scope);
                ownerUpdate.update({ cancellation: 'unsupported' });
            };
            ownerUpdate.update({ cancellation: 'supported' });
            options.signal?.addEventListener('abort', cancel, { once: true });
            if (options.signal?.aborted) cancel();
            acceptance.accept(receipt);
            try {
                const result = await settlement;
                return recordOutcome(result.success ? { success: true, status: 'completed', transferId: receipt.prepared.transferId,
                    destinationId: receipt.destinationId, name: receipt.prepared.name, sizeBytes: result.sizeBytes,
                    sha256: result.manifestHash.slice('sha256:'.length) }
                    : { success: false, status: result.errorCode === 'cancelled' ? 'cancelled' : result.errorCode === 'indeterminate' ? 'unknown' : 'failed',
                        error: result.error, ...(result.errorCode ? { errorCode: result.errorCode } : {}) });
            } finally { options.signal?.removeEventListener('abort', cancel); }
        };
    }

    /** The incumbent contributed-Action operation owner, shared by every admitted ingress. */
    observePluginActionExecution(request: Parameters<HostActionOperationRuntime['observePluginExecution']>[0]) {
        return this.actionOperationRuntime.observePluginExecution(request);
    }

    /** Effect dependency reached only after the canonical Action admission. */
    createMachineSkillActionExecutor(params: Readonly<{ credentials: StoredCredentials;
        operationContext?: import('@/settings/secrets/hydrateSavedSecretCatalog').SavedSecretOperationContextV1;
    }>): NonNullable<ActionExecutorDeps['skillMachineActionExecute']> {
        return async request => {
            if (!request.input || typeof request.input !== 'object' || Reflect.get(request.input, 'machineId') !== this.machine.id) {
                return { ok: false, errorCode: 'machine_target_mismatch', error: 'machine_target_mismatch' };
            }
            try {
                request.context.signal?.throwIfAborted();
                const operation = params.operationContext;
                const isCurrent = async () => !this.projectionSchedulingClosed && (operation
                    ? sameStoredCredentials(operation.credentials, params.credentials)
                        && operation.serverHttpBaseUrl.replace(/\/+$/, '') === this.machineRuntimeServerHttpBaseUrl.replace(/\/+$/, '')
                        && await operation.isCurrent()
                    : sameStoredCredentials(params.credentials, await readStoredCredentialsForServerId(this.machineRuntimeServerId)));
                if (!await isCurrent()) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
                const target = await resolveMachineSkillInstallTarget({ serverId: this.machineRuntimeServerId,
                    serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl, machineId: this.machine.id, signal: request.context.signal });
                if (!target) throw Object.assign(new Error('machine_skill_home_unavailable'), { code: 'machine_skill_home_unavailable' });
                if (!await isCurrent()) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
                request.context.signal?.throwIfAborted();
                const service = createMachineSkillHostService({ credentials: params.credentials, target,
                    serverId: this.machineRuntimeServerId, serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl,
                    ...(operation ? { operationContext: operation } : {}) });
                return await createMachineSkillActionExecutor({ machineId: this.machine.id, service })(request);
            } catch (error) {
                const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
                const errorCode = typeof code === 'string' ? code : 'skill_install_unavailable';
                return { ok: false, errorCode, error: errorCode };
            }
        };
    }

    /** Effect dependency reached only after the canonical Action admission. */
    createFilesystemActionExecutor(serverId: string): NonNullable<ActionExecutorDeps['filesystemActionExecute']> {
        const filesystemDeps = {
            workingDirectory: this.machineRpcWorkingDirectory, accessPolicy: this.filesystemAccessPolicy,
            getAdditionalAllowedReadDirs: () => this.additionalAllowedReadDirs,
            getAdditionalAllowedWriteDirs: () => this.additionalAllowedWriteDirs,
        };
        const readFile = createReadFileRpcActionExecutor({ ...filesystemDeps,
            getAdditionalAllowedReadFiles: () => this.transientSessionMediaReadAllowance.readAllowedReadFiles() });
        const writeFile = createWriteFileRpcActionExecutor(filesystemDeps);
        const directory = createDirectoryRpcActionExecutor({ ...filesystemDeps, limits: {
            listMaxEntries: configuration.filesDirectoryListMaxEntries,
            treeMaxDepth: configuration.filesDirectoryTreeMaxDepth,
            treeMaxNodes: configuration.filesDirectoryTreeMaxNodes,
        } });
        const lifecycle = this.lifecycleDependencies.directPeerServerLifecycle;
        const transfer = lifecycle ? createPreparedFilesystemTransferActionExecutor({ lifecycle,
            admissionDrain: this.lifecycleDependencies.managedActivity?.admissionDrain,
            workingDirectory: this.machineRpcWorkingDirectory, accessPolicy: this.filesystemAccessPolicy,
            getAdditionalAllowedReadDirs: () => this.additionalAllowedReadDirs,
            getAdditionalAllowedWriteDirs: () => this.additionalAllowedWriteDirs }) : null;
        // The workspace source is chosen once per admitted Action; every effect below reads it.
        return async (request) => runWithWorkspaceSource(this.filesystemEffectAdmission.selectWorkspaceSource(request.context, request.input), async () => {
            const requester = await this.filesystemEffectAdmission.resolveActionRequester?.(request.context);
            const source = currentWorkspaceSource();
            // A member of a target Session is served by the target's source (owner ruling 2026-11-12);
            // the admission below checks the Session access. Only this Machine's disk uses the native channel.
            if (requester && source.kind === 'local' && requester.identity.kind === 'isolated' && !isHostRequesterUnrestrictedOwner(requester.identity)
                && resolveHostRequesterAgentPlacementForHost({ identity: requester.identity,
                    snapshot: this.lifecycleDependencies.agentIsolation?.read() }) !== 'daemon') {
                let channel: Awaited<ReturnType<typeof prepareNativeFilesystemEffect>> | undefined;
                try {
                    const target = request.context.externalActionTarget;
                    const owner = this.externalActionIngressOwner;
                    const heldHome = this.lifecycleDependencies.resolveCurrentServerIdentityId?.();
                    if (target?.kind !== 'machine' || target.machineId !== this.machine.id
                        || !owner || this.projectionSchedulingClosed || owner.currentServerId !== serverId
                        || request.context.serverIdentityId && request.context.serverIdentityId !== heldHome
                        || !request.context.serverIdentityId && request.context.serverId !== serverId)
                        return { ok: false, errorCode: 'target_unavailable', error: 'Filesystem target is unavailable' };
                    if (request.actionId === 'daemon.filesystem.copy' && request.input && typeof request.input === 'object'
                        && 'kind' in request.input && request.input.kind === 'target_copy')
                        return { ok: false, errorCode: 'filesystem_transfer_custody_required', error: 'Target copy requires a mounted caller byte driver' };
                    const isTransfer = request.actionId === 'daemon.filesystem.upload' || request.actionId === 'daemon.filesystem.download'
                        || request.actionId === 'daemon.filesystem.transfer.cancel' || request.actionId === 'daemon.filesystem.copy'
                        && request.input && typeof request.input === 'object' && 'kind' in request.input && request.input.kind === 'prepared_transfer';
                    if (isTransfer && !transfer) return { ok: false, errorCode: 'machine_carrier_unavailable', error: 'Prepared filesystem transfer owner is unavailable' };
                    if (request.actionId !== 'daemon.filesystem.transfer.cancel') channel = await this.openNativeFilesystemChannel({
                        requester, identity: requester.identity,
                        operationKey: request.context.operationAcceptance?.operationId ?? request.context.actionRequestId ?? '',
                        signal: request.context.signal ?? new AbortController().signal,
                        ingress: { ...request.context, signal: request.context.signal ?? new AbortController().signal,
                            callerAuthority: request.context.authority, callerInputAuthorization: request.context.externalActionExecutionAuthorization },
                    });
                    if (request.actionId === 'daemon.filesystem.upload' || request.actionId === 'daemon.filesystem.download'
                        || request.actionId === 'daemon.filesystem.transfer.cancel' || request.actionId === 'daemon.filesystem.copy' && isTransfer) {
                        if (!transfer) return { ok: false, errorCode: 'machine_carrier_unavailable', error: 'Prepared filesystem transfer owner is unavailable' };
                        const result = await transfer({ ...request, actionId: request.actionId,
                            ...(channel ? { nativeFilesystem: createFilesystemEffectTransferAdapter(channel) } : {}),
                            assertCurrentAuthority: async () => { request.context.signal?.throwIfAborted(); } });
                        return result.success ? result : projectPreparedFilesystemActionResult(result);
                    }
                    if (!channel) throw new Error('Native filesystem channel is unavailable');
                    return await channel.request({ kind: 'action', actionId: request.actionId, input: request.input });
                } finally { await channel?.dispose(); await requester.dispose(); }
            }
            await requester?.dispose();
            const custodyFailure = await this.filesystemEffectAdmission.action(request.context, requester?.identity, currentWorkspaceSource());
            const admittedOwner = this.externalActionIngressOwner;
            if (!admittedOwner || this.projectionSchedulingClosed) {
                return { ok: false, errorCode: 'filesystem_action_owner_unavailable', error: 'The current filesystem Action owner is unavailable' };
            }
            const target = request.context.externalActionTarget;
            if (target?.kind !== 'machine' || target.machineId !== this.machine.id
                || !await this.isNativeWorkspaceHomeCurrent(serverId, request.context)) {
                return { ok: false, errorCode: 'target_unavailable', error: 'Filesystem target is unavailable' };
            }
            // A present physical owner already holds ordinary host IO rights on
            // every supported platform. Only a protected requester needs the
            // separately retained exact archive descriptor/typed destination.
            const deploymentArchive = custodyFailure ? await admitDeploymentArchiveFilesystemForHost({ actionId: request.actionId,
                value: request.input, context: request.context, machineId: this.machine.id,
                serverId, happierHomeDir: configuration.happyHomeDir }) : null;
            try {
            if (custodyFailure && !deploymentArchive) return { ok: false, ...custodyFailure };
            // The immutable invocation's Home was checked above. Each physical
            // phase retains its owner/target checks without a Home read per file.
            const assertAdmittedActionCurrent = this.captureFilesystemActionCurrentness(request.context);
            const assertCurrentAuthority = async () => {
                await assertAdmittedActionCurrent();
                await deploymentArchive?.assertCurrent();
            };
            if (request.actionId === 'daemon.filesystem.copy' && request.input && typeof request.input === 'object'
                && 'kind' in request.input && request.input.kind === 'target_copy') {
                return { ok: false, errorCode: 'filesystem_transfer_custody_required', error: 'Target copy requires a mounted caller byte driver' };
            }
            if (request.actionId === 'daemon.filesystem.upload' || request.actionId === 'daemon.filesystem.download'
                || request.actionId === 'daemon.filesystem.transfer.cancel'
                || (request.actionId === 'daemon.filesystem.copy' && request.input && typeof request.input === 'object'
                    && 'kind' in request.input && request.input.kind === 'prepared_transfer')) {
                if (!transfer) return { ok: false, errorCode: 'machine_carrier_unavailable', error: 'Prepared filesystem transfer owner is unavailable' };
                const result = await transfer({ ...request, actionId: request.actionId, assertCurrentAuthority,
                    ...(deploymentArchive ? { requesterAccountId: deploymentArchive.requesterAccountId } : {}),
                    ...(deploymentArchive?.readFile ? { admittedReadFile: deploymentArchive.readFile } : {}) });
                return result.success ? result : projectPreparedFilesystemActionResult(result);
            }
            // Reuse the incumbent effects without re-entering full Action admission.
            const inline = request.actionId === 'daemon.filesystem.readFile' ? readFile
                : request.actionId === 'daemon.filesystem.writeFile' ? writeFile
                : request.actionId === 'daemon.filesystem.listDirectory' || request.actionId === 'daemon.filesystem.getDirectoryTree'
                    ? directory : null;
            if (inline) {
                await assertCurrentAuthority();
                const result = await inline.execute(request.actionId, request.input, { ...request.context,
                    verifyMachineAdmissionCurrent: async () => { await assertCurrentAuthority(); return true; } });
                return result.ok ? result.result : result;
            }
            // The file browser family (folder picker, Code tree, filename search) has one effect owner; this
            // admitted daemon path reaches it with the same configuration the native channel carries (RU2 19:25Z).
            if (request.actionId === FILESYSTEM_BROWSER_ACTION_IDS_V1.listRoots || request.actionId === FILESYSTEM_BROWSER_ACTION_IDS_V1.browseDirectory
                || request.actionId === FILESYSTEM_BROWSER_ACTION_IDS_V1.listFiles) {
                await assertCurrentAuthority();
                const { executeConfiguredFilesystemEffect } = await import('@/rpc/handlers/fileSystem/filesystemEffectOperation');
                return await executeConfiguredFilesystemEffect(this.filesystemEffectConfiguration(),
                    { actionId: request.actionId, input: request.input }, request.context.signal);
            }
            const actionId = FILESYSTEM_MUTATION_ACTION_IDS.find(id => id === request.actionId);
            if (!actionId) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
            const result = await executeFilesystemMutationAction({ actionId, input: request.input,
                workingDirectory: this.machineRpcWorkingDirectory, accessPolicy: this.filesystemAccessPolicy,
                getAdditionalAllowedReadDirs: () => this.additionalAllowedReadDirs,
                getAdditionalAllowedWriteDirs: () => this.additionalAllowedWriteDirs,
                signal: request.context.signal, operationId: request.context.operationAcceptance?.operationId,
                assertCurrentAuthority });
            if (request.actionId === 'daemon.filesystem.copy' && !result.success && 'status' in result && result.status === 'unknown') {
                return projectPreparedFilesystemActionResult(result);
            }
            return result;
            } finally {
                // The source exporter normally closes its retained descriptor;
                // cover rejection/cancellation before that owner is reached too.
                await deploymentArchive?.readFile?.handle.close().catch(() => undefined);
            }
        });
    }

    /** Machine role entries register their RPC families here (daemon/roles/machineRoleRuntime.ts). */
    getMachineRoleRpcHandlerManager(): RpcHandlerManager {
        return this.rpcHandlerManager;
    }

    getPeerMediationMachineRpcHandlerManager(): PeerMachineRpcDirectHandlerManager {
        return {
            invokeLocal: async (method, params, options) => {
                const forbidden = () => ({ error: RPC_ERROR_MESSAGES.FORBIDDEN, errorCode: RPC_ERROR_CODES.FORBIDDEN });
                const signal = options?.signal ?? new AbortController().signal;
                if (!options?.verifiedPeerAccountId || signal.aborted) return forbidden();
                const custodianAccountId = await this.machineRpcAdmissionBoundary.resolveCustodianAccountId(signal);
                const installationId = this.machineRpcAdmissionBoundary.resolveInstallationId();
                // Direct grants are already bound to this loopback Account. A public
                // request supplies neither a Machine role nor installation identity.
                if (!custodianAccountId || options.verifiedPeerAccountId !== custodianAccountId || !installationId) return forbidden();
                const machineAdmission = Object.freeze({ actorAccountId: options.verifiedPeerAccountId,
                    custodianAccountId, machineId: this.machine.id, installationId,
                    role: 'manage' as const, encryptionMode: this.machineContentCodec.mode });
                const request = { method: `${this.machine.id}:${method}`, params, machineAdmission, signal,
                    callerAuthority: options.verifiedPeerAuthority ?? 'account_automation' as const };
                // The admission owner turns boundary failures into a typed refusal; anything it
                // throws is a defect the direct route reports as a handler failure (flow.errored).
                const admissionResult = await authorizeMachineRpcRequest(request, this.machineRpcAdmissionBoundary);
                if (signal.aborted) return forbidden();
                if (!admissionResult.ok) {
                    // This path refuses before the RPC manager's request log; an unavailable
                    // admission check is not an access decision, so record it here.
                    if (admissionResult.admissionPredicate === 'authorization_unavailable') {
                        logger.warn('[API MACHINE] Direct peer RPC admission unavailable', { method });
                    }
                    return { error: admissionResult.error, errorCode: admissionResult.errorCode ?? RPC_ERROR_CODES.FORBIDDEN,
                        ...(admissionResult.failureCause ? { failureCause: admissionResult.failureCause } : {}) };
                }
                return await this.rpcHandlerManager.invokeLocal(method, params, { signal, admissionResult,
                    rpcContext: { machineAdmission, verifyMachineAdmissionCurrent: async () => !signal.aborted,
                        callerAuthority: options.verifiedPeerAuthority ?? 'account_automation' } });
            },
        };
    }

    registerMachineAccessLossReceiver(options: Omit<Parameters<typeof registerMachineAccessLossReceiver>[1],
        'machineId' | 'cleanupRequesterMachineTerminals' | 'memberOperations'>): void {
        const client = this;
        registerMachineAccessLossReceiver(this.rpcHandlerManager, { ...options, machineId: this.machine.id,
            get memberOperations() { return client.agentIsolationMemberOperations ?? undefined; },
            cleanupRequesterMachineTerminals: input => this.cleanupRequesterMachineTerminals({
                ...input, serverId: options.serverId,
            }),
        });
    }

    /** Host uploads share the filesystem lifecycle independently of public prepared RPC registration. */
    getHostLocalTransferRpcHandler(): import('./rpc/types').RpcHandlerInvoker {
        return {
            invokeLocal: (method, input, options) => {
                switch (method) {
                    case RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT:
                    case RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK:
                    case RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE:
                    case RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT:
                        return this.rpcHandlerManager.invokeLocalHandler(method, input,
                            () => this.hostLocalUploadRpc.invokeLocal(method, input, options), options);
                    default:
                        return this.invokeLocalMachineAction(method, input, options);
                }
            },
        };
    }

    /** Host-private exact-daemon Action transport; local context never reaches Socket.IO. */
    async invokeLocalMachineAction(
        method: string,
        request: unknown,
        options?: Readonly<{
            signal?: AbortSignal;
            executionRunPermissionRequestStore?: unknown;
            executionRunWorkflowObservationSink?: unknown;
            executionRunWorkflowRunId?: string;
            executionRunWorkflowScope?: RpcLocalActionContext['executionRunWorkflowScope'];
            localActionContext?: RpcLocalActionContext;
            /** Existing requester custody for host-owned exact-daemon replay. */
            rpcContext?: NonNullable<Parameters<RpcHandlerManager['invokeLocal']>[2]>['rpcContext'];
            admissionResult?: NonNullable<Parameters<RpcHandlerManager['invokeLocal']>[2]>['admissionResult'];
        }>,
    ): Promise<unknown> {
        return await this.rpcHandlerManager.invokeLocal(method, request, {
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(options?.admissionResult ? { admissionResult: options.admissionResult } : {}),
            ...(options?.rpcContext ? { rpcContext: options.rpcContext } : {}),
            ...(options?.executionRunPermissionRequestStore === undefined
                && options?.executionRunWorkflowObservationSink === undefined
                && options?.executionRunWorkflowRunId === undefined
                && options?.executionRunWorkflowScope === undefined
                && options?.localActionContext === undefined
                ? {}
                : {
                    localActionContext: {
                        ...options?.localActionContext,
                        ...(options?.executionRunWorkflowRunId ? { executionRunWorkflowRunId: options.executionRunWorkflowRunId } : {}),
                        ...(options?.executionRunWorkflowScope ? { executionRunWorkflowScope: options.executionRunWorkflowScope } : {}),
                        ...(options?.executionRunPermissionRequestStore === undefined
                            ? {}
                            : { executionRunPermissionRequestStore: options.executionRunPermissionRequestStore }),
                        ...(options?.executionRunWorkflowObservationSink === undefined
                            ? {}
                            : { executionRunWorkflowObservationSink: options.executionRunWorkflowObservationSink }),
                    },
                }),
        });
    }

    registerLocalServicesPreviewRoutes(localServicesPreview: LocalServicePreviewRoutes): void {
        registerDaemonLocalServicePreviewSnapshotHandler(this.rpcHandlerManager, {
            localServicesPreview,
        });
    }

    private hostResourceRoutes: DaemonLocalServicesMachineRpcRoutes | null = null;

    registerLocalServicesRoutes(localServices: DaemonLocalServicesMachineRpcRoutes): void {
        this.hostResourceRoutes = localServices;
        this.localServiceStartObservationCleanup?.();
        this.localServiceStartObservationCleanup = !this.projectionSchedulingClosed && localServices.accountId
            ? localServices.localServicesLauncher?.bindStartOperations?.(this.actionOperationRuntime.store, localServices.accountId) ?? null : null;
        registerDaemonLocalServicesMachineRpcHandlers(this.rpcHandlerManager, localServices);
        if (!this.projectionSchedulingClosed) this.getMachineServicesBinding().start();
    }

    private getMachineServicesBinding() {
        return this.machineServicesBinding ??= createApiMachineServicesBinding({ profileId: this.machineRuntimeServerId,
            machineId: this.machine.id, readMetadata: () => this.getMachineMetadataSnapshot(),
            captureMetadataPort: () => this.captureMachineMetadataFieldPort(),
            onConnectionStateChange: listener => this.onConnectionStateChange(listener),
            publishSummary: managedServices => {
                void this.updateDaemonState(state => ({ ...(state ?? { status: 'running' as const }), managedServices }))
                    .catch(() => logger.warn('[API MACHINE] Machine service summary publication failed'));
            },
            restoreEnvironmentServices: async (owner, signal, observations) => {
                const installationId = this.machineRuntimeInstallationId;
                const serverId = await resolveServerProfileHomeIdentityId(this.machineRuntimeServerId);
                if (!installationId || !serverId) throw machineServiceAdmissionFailure(
                    !installationId ? 'service.installation' : 'service.home_identity');
                const { restoreOwnServerServicesForHost } = await import('@/deployments/targets/ownServer/restoreOwnServerServicesForHost');
                return await restoreOwnServerServicesForHost({ ...observations, serverId, machineId: this.machine.id, installationId, owner, signal,
                    acquireServiceExportForward: this.lifecycleDependencies.acquireServiceExportForward,
                    resolveRuntime: async workSignal => {
                        let reason = 'unavailable';
                        const runtime = await this.resolveInstalledAccountRuntime(workSignal, undefined,
                            unavailable => { reason = unavailable; });
                        if (!runtime) throw machineServiceAdmissionFailure(`service.account.${reason}`);
                        return runtime;
                    },
                    isCurrent: () => !this.projectionSchedulingClosed && !signal.aborted
                        && configuration.activeServerId === this.machineRuntimeServerId
                        && readInstallationIdentityIfExistsSync()?.installationId === installationId });
            } });
    }

    /** Read-only first-use adoption joins the same owner as Machine Services. */
    async ensureEnvironmentServices(scope?: import('@/plugins/runtime/invocation/services/environmentServiceRecovery').EnvironmentServiceRecoveryScope): Promise<void> {
        if (this.projectionSchedulingClosed) throw Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
        await this.getMachineServicesBinding().ensureEnvironmentServices(scope);
    }

    async executeMachineServiceAction(request: MachineServiceActionDirectTargetInvocation) {
        if (this.projectionSchedulingClosed) return machineServiceAdmissionFailure('service.runtime.closed');
        return await this.getMachineServicesBinding().execute(request);
    }

    /** Native leaf of the original admitted Session deletion, before its Home row disappears. */
    async executeSessionDeleteAction(request: Parameters<NonNullable<import('@happier-dev/protocol/actions').ActionExecutorDeps['sessionDelete']>>[0],
        ingress: RpcHandlerContext): Promise<unknown> {
        const registration = this.rpcLifecycleRegistrations.at(-1);
        if (this.projectionSchedulingClosed || !registration?.isSessionActive) {
            return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
        }
        const { createNativeSessionDeleteAction } = await import('@/daemon/sessions/sessionDeleteAction');
        return createNativeSessionDeleteAction({ ingress,
            resolveRuntime: context => this.resolveProjectFiniteRuntime(context),
            isSessionActive: registration.isSessionActive,
            retireRequesterCustody: async sessionId => {
                const { retireRequesterSessionCredentialCustody } = await import('@/daemon/sessionEncryption/requesterSessionCredentials');
                return retireRequesterSessionCredentialCustody({ happyHomeDir: configuration.happyHomeDir,
                    serverId: this.machineRuntimeServerId, sessionId });
            },
            nativeOperationRuntime: { prepareNativeOperation: input => this.prepareNativeOperation(input),
                readMemberFolderOwner: path => this.readMemberFolderOwner(path) },
        })(request);
    }

    /** Private installed target port, invoked only after public Action admission. */
    async executeMachineRebootAction(request: MachineRebootDirectTargetInvocation): Promise<unknown> {
        if (this.projectionSchedulingClosed || !this.machineRebootAction) return { kind: 'unavailable', reason: 'admission_unavailable' };
        return await this.machineRebootAction(request);
    }

    async sampleMachineServiceUsage() {
        return this.getMachineServicesBinding().sampleUsage();
    }

    registerMachineVitalsRoutes(options: DaemonMachineVitalsRoutes): void {
        registerDaemonMachineVitalsRpcHandlers(this.rpcHandlerManager, { ...options,
            canReadServiceHistory: (serviceId, ingress) => this.getMachineServicesBinding().canReadHistory(serviceId, {
                requesterAccountId: ingress.machineAdmission?.actorAccountId,
                context: ingress.localActionContext,
                canReadEnvironments: async environmentIds => {
                    const visible = await Promise.all(environmentIds.map(async environmentId =>
                        await this.canReadMachineServiceEnvironment({ serverId: this.machineRuntimeServerId, environmentId }, ingress) ? environmentId : null));
                    return new Set(visible.filter((id): id is string => id !== null));
                },
            }),
        });
    }

    registerDeploymentChildRoutes(daemonWorkSignal: AbortSignal,
        executeManagedSnapshot?: import('@/deployments/daemonDeploymentNativeSnapshot').ExecuteManagedNativeSnapshot): void {
        registerDaemonDeploymentChildRpcHandler(this.rpcHandlerManager, {
            machineId: this.machine.id, signal: daemonWorkSignal,
            ...(executeManagedSnapshot ? { executeManagedSnapshot } : {}),
            ensureServiceObservations: scope => this.ensureEnvironmentServices(scope),
            captureNativeSetup: () => {
                const desired = this.captureMachineSetupDesired();
                const elevation = this.captureMachineAdminAccess();
                const port = this.captureMachineMetadataFieldPort();
                return { readDesired: desired.read, elevation,
                    settleCaddyFirewall: input => settleMachineCaddyFirewallForHost({ ...input, port,
                        readDaemonProof: () => observeOwnDaemonReachability({ client: this, signal: input.signal }) }),
                    settlePrivateWorkloadFirewall: input => settleMachinePrivateWorkloadFirewallForHost({ ...input, port,
                        readDaemonProof: () => observeOwnDaemonReachability({ client: this, signal: input.signal }) }),
                };
            },
            resolveRequesterIdentity: context => this.resolveDeploymentSourceRequesterIdentity(context),
            resolveProjectRuntime: ingress => this.resolveProjectFiniteRuntime(ingress),
            resolveProjectRuntime: ingress => this.resolveProjectFiniteRuntime(ingress),
            resolveRequesterRuntime: async ingress => {
                if (!this.machineRuntimeInstallationId) return null;
                return resolveAdmittedRequesterAccountReadRuntime({ ingress, serverId: this.machineRuntimeServerId,
                    machineId: this.machine.id, installationId: this.machineRuntimeInstallationId,
                    isInstalledCurrent: () => !this.projectionSchedulingClosed
                        && configuration.activeServerId === this.machineRuntimeServerId
                        && readInstallationIdentityIfExistsSync()?.installationId === this.machineRuntimeInstallationId });
            },
            resolveInstalledRuntime: (signal, accountId) => {
                const credentials = this.lifecycleDependencies.installedCredentials;
                return credentials ? this.resolveInstalledAccountRuntime(signal, accountId, undefined, credentials) : Promise.resolve(null);
            },
            acquirePluginRuntimeRegistryLease: () => acquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir: configuration.happyHomeDir }),
        });
    }

    private async canReadMachineServiceEnvironment(target: Readonly<{ serverId: string; environmentId: string }>, ingress: RpcHandlerContext): Promise<boolean> {
                // Raw app/watch reads use the same admitted requester Account
                // runtime as other private Machine reads, never a global bearer.
                const runtime = await this.resolveOwnSessionRuntime(ingress);
                const verifyCurrent = runtime?.isCurrent;
                if (!runtime || !verifyCurrent || runtime.machineId !== this.machine.id
                    || runtime.accountId !== ingress.machineAdmission?.actorAccountId
                    || !await isServerProfileHomeIdentity(runtime.serverId, target.serverId)) return false;
                const current = async () => !ingress.signal.aborted && await verifyCurrent() && !ingress.signal.aborted;
                if (!await current()) return false;
                const [{ createCliDeploymentActionDeps }, { DeploymentEnvironmentGetResultV1Schema }] = await Promise.all([
                    import('@/deployments/createCliDeploymentActionDeps'), import('@happier-dev/protocol/deployments/deploymentActionsV1'),
                ]);
                const authorization = runtime.accountAuthorization;
                const failure = () => ({ ok: false as const, errorCode: 'action_forbidden', error: 'action_forbidden' });
                const { deploymentAction } = createCliDeploymentActionDeps({ serverHttpBaseUrl: runtime.serverHttpBaseUrl,
                    admitAccount: async serverId => await current() && await isServerProfileHomeIdentity(runtime.serverId, serverId) ? null : failure(),
                    resolveRequestHeaders: async (_context, actionId, request) => {
                        if (!await current()) return null;
                        if (authorization) {
                            const http = authorization.requesterHttpProjection;
                            if (!http || !await http.isCurrent()) return null;
                            const headers = await http.createRequestHeaders({ ...request, effectActionId: actionId, signal: ingress.signal });
                            return headers && await current() ? { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...headers } : null;
                        }
                        return runtime.credentials ? { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${runtime.credentials.token}` } : null;
                    },
                    dispatchReceipt: async () => failure(),
                });
                const opened = DeploymentEnvironmentGetResultV1Schema.safeParse(await deploymentAction!('deployments.environments.get', {
                    serverId: runtime.serverId, environmentId: target.environmentId,
                }, { signal: ingress.signal, ...(authorization ? { externalActionExecutionAuthorization: authorization } : {}) }));
                return opened.success && opened.data.ok && opened.data.environment.id === target.environmentId
                    && opened.data.environment.capabilities.read && await current();
    }

    registerMachineProcessesRoutes(options: DaemonProcessesRoutes): void {
        registerDaemonProcessesRpcHandlers(this.rpcHandlerManager, { ...options,
            readEnvironment: (target, ingress) => this.canReadMachineServiceEnvironment(target, ingress),
        });
    }

    registerMachineResourcesPolicyRoutes(options: DaemonMachineResourcesPolicyRoutes): void {
        registerDaemonMachineResourcesPolicyRpcHandlers(this.rpcHandlerManager, options);
    }

    registerMachineRolesRoutes(options: DaemonMachineRolesRoutes): void {
        registerDaemonMachineRolesRpcHandlers(this.rpcHandlerManager, options);
    }

    registerMachineIsolationRoutes(options: DaemonMachineIsolationRoutes): void {
        registerDaemonMachineIsolationRpcHandlers(this.rpcHandlerManager, { ...options,
            captureMetadataPort: () => this.captureMachineMetadataFieldPort(),
            validateConfiguredSandboxes: async (entries, ingress) => {
                const runtime = await this.resolveOwnSessionRuntime(ingress);
                const installationId = ingress.machineAdmission?.installationId;
                if (!runtime || !installationId) return 'unavailable';
                const homeId = runtime.accountAuthorization?.binding.serverIdentityId
                    ?? await resolveServerProfileHomeIdentityId(runtime.serverId);
                if (!homeId) return 'unavailable';
                const [{ tryAcquireAuthoritativePluginRuntimeRegistryLease }, { validateMachineIsolationConfiguredSandboxes }] = await Promise.all([
                    import('@/plugins/runtime/reload/runtimeLease'), import('@/machines/managed/isolationPolicyReferences'),
                ]);
                const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir: configuration.happyHomeDir });
                if (!lease) return 'unavailable';
                try {
                    return await validateMachineIsolationConfiguredSandboxes({ entries, runtime,
                        target: { homeId, machineId: this.machine.id, installationId },
                        provisioners: lease.registry.contributes.machineProvisioners ?? [], signal: ingress.signal });
                } finally { await lease.release(); }
            },
        });
    }

    private machineReachabilityRoutes: DaemonMachineReachabilityRoutes | null = null;

    private readMachineReachabilityRoutesForRequest(input: unknown, ingress: RpcHandlerContext) {
        const routes = this.machineReachabilityRoutes;
        const machineId = input && typeof input === 'object' && 'machineId' in input ? input.machineId : undefined;
        const verifyMachineAdmissionCurrent = ingress.verifyMachineAdmissionCurrent;
        if (!routes || this.projectionSchedulingClosed || !ingress.machineAdmission || !verifyMachineAdmissionCurrent
            || machineId !== this.machine.id) return null;
        return { routes, verifyMachineAdmissionCurrent };
    }

    async prepareMachineReachabilityReviewedChildren(request: Parameters<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>>[0],
        ingress: RpcHandlerContext): ReturnType<NonNullable<ActionExecutorDeps['prepareHostReviewedChildren']>> {
        if (request.actionId !== 'machines.reachability.inspect' && request.actionId !== 'machines.reachability.configure') return null;
        const admitted = this.readMachineReachabilityRoutesForRequest(request.input, ingress);
        if (!admitted) return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
        return prepareDaemonMachineReachabilityReviewedChildren({ ...admitted.routes,
            captureMetadataPort: () => this.captureMachineMetadataFieldPort() }, request, ingress);
    }

    async executeMachineReachabilityAction(request: Parameters<NonNullable<ActionExecutorDeps['machineReachabilityAction']>>[0], ingress: RpcHandlerContext): Promise<unknown> {
        const admitted = this.readMachineReachabilityRoutesForRequest(request.input, ingress);
        if (!admitted) {
            return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
        }
        return executeDaemonMachineReachabilityAction({ ...admitted.routes,
            captureMetadataPort: () => this.captureMachineMetadataFieldPort() }, request, ingress);
    }

    registerMachineReachabilityRoutes(options: DaemonMachineReachabilityRoutes): void {
        const routes: DaemonMachineReachabilityRoutes = { ...options,
            target: () => {
                const target = options.target();
                return target?.machineId === this.machine.id && target.serverId === this.machineRuntimeServerId ? target : null;
            },
        };
        const installed = this.machineReachabilityRoutes !== null;
        this.machineReachabilityRoutes = routes;
        // Preparation and attachment share this receiver; execution reads the current routes above.
        if (installed) return;
        registerDaemonMachineReachabilityRpcHandlers(this.rpcHandlerManager, { ...routes,
            captureMetadataPort: () => this.captureMachineMetadataFieldPort(),
            observeExecution: this.actionOperationRuntime.observeExecution,
            resolveActionExecutor: () => ({ execute: async (actionId, input, context) => {
                const owner = this.externalActionIngressOwner;
                const signed = SignedRootActionIdSchema.safeParse(actionId);
                const heldHome = this.lifecycleDependencies.resolveCurrentServerIdentityId?.() ?? null;
                if (!owner || this.projectionSchedulingClosed || !signed.success
                    || context?.serverId && !await this.isNativeWorkspaceHomeCurrent(owner.currentServerId, context, heldHome)
                    || !context?.runtimeAccountId) return {
                        ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable',
                    };
                return owner.executor.execute(signed.data, input, { ...context, serverId: owner.currentServerId,
                    ...(heldHome ? { serverIdentityId: heldHome } : {}),
                    externalActionTarget: { kind: 'machine', machineId: this.machine.id } });
            } }),
        });
    }

    registerMachineAdminAccessRoutes(options: DaemonMachineAdminAccessRoutes): void {
        if (this.machineAdminAccessRoutes !== options) this.machineAdminAccessInspectedTransport = null;
        this.machineAdminAccessRoutes = options;
        registerDaemonMachineAdminAccessRpcHandlers(this.rpcHandlerManager, { ...options,
            runActionOperation: request => this.runActionOperation(request),
            target: () => {
                const target = options.target();
                return target?.machineId === this.machine.id && target.serverId === this.machineRuntimeServerId ? target : null;
            },
            captureMetadataPort: () => this.captureMachineMetadataFieldPort(),
            observer: { ...options.observer, inspect: () => this.inspectMachineAdminAccess(options) },
        });
        this.observeStartupMachineAdminAccess();
    }

    private observeStartupMachineAdminAccess(): void {
        const routes = this.machineAdminAccessRoutes;
        if (!routes || !this.socket?.connected
            || this.machineControlRunningGeneration !== this.activeTransportGeneration
            || this.getMachineAdminAccessRights().freshness === 'current') return;
        // Optional native facts settle independently of ordinary daemon readiness.
        // The observer owns coalescing and publishes only changed facts.
        void this.inspectMachineAdminAccess(routes).catch(() => {
            logger.warn('[API MACHINE] Startup administrator observation publication unavailable');
        });
    }

    private qualifyStartupAgentIsolation(): void {
        const effects = this.agentIsolationEffects;
        const socket = this.socket;
        const generation = this.activeTransportGeneration;
        if (!effects || !socket?.connected || this.machineControlRunningGeneration !== generation) return;
        const snapshot = this.getAgentIsolationSnapshot();
        void observeUnqualifiedAgentIsolationNativeReadiness({ snapshot, effects }).then(async status => {
            if (!status) return;
            await this.publishAgentIsolationStatus(status, () => {
                const current = this.getAgentIsolationSnapshot();
                // Startup proof cannot overwrite a later Apply, policy change,
                // or another connection's publication.
                return this.socket === socket && this.activeTransportGeneration === generation
                    && this.agentIsolationEffects === effects && current.enabled === snapshot.enabled
                    && current.memberProvisioning === snapshot.memberProvisioning
                    && isDeepStrictEqual(current.status, snapshot.status);
            });
        }).catch(() => logger.warn('[API MACHINE] Startup Agent isolation qualification unavailable'));
    }

    private async inspectMachineAdminAccess(options: DaemonMachineAdminAccessRoutes) {
        const generation = this.activeTransportGeneration;
        const codec = this.machineContentCodec;
        this.machineAdminAccessInspectedTransport = null;
        const result = await options.observer.inspect();
        if (this.machineAdminAccessRoutes === options && this.activeTransportGeneration === generation
            && this.machineContentCodec === codec && this.machineContentReady && this.socket?.connected
            && !this.projectionSchedulingClosed) this.machineAdminAccessInspectedTransport = { generation, codec };
        return result;
    }

    registerMachineAgentIsolationRoutes(effects: AgentIsolationEffectDependencies): void {
        this.agentIsolationEffects = effects;
        this.agentIsolationMemberOperations = createAgentIsolationMemberOperations({
            effects, activeServerDir: configuration.activeServerDir, serverId: this.machineRuntimeServerId,
            operations: this.actionOperationRuntime,
            observeExecution: request => this.observeActionExecution(request),
            readActivityInventory: () => this.lifecycleDependencies.managedActivity?.activity ?? null,
            captureMetadataPort: () => this.captureMachineMetadataFieldPort(),
            target: () => {
                const custodianAccountId = readAccountIdFromToken(this.token);
                const homeServerIdentityId = this.lifecycleDependencies.resolveCurrentServerIdentityId?.();
                return custodianAccountId && homeServerIdentityId && this.machineRuntimeInstallationId
                    && !this.projectionSchedulingClosed ? {
                        custodianAccountId, homeServerIdentityId, machineId: this.machine.id,
                        installationId: this.machineRuntimeInstallationId, encryptionMode: this.getMachineEncryptionMode(),
                    } : null;
            },
        });
        registerDaemonMachineAgentIsolationRpcHandlers(this.rpcHandlerManager, {
            runActionOperation: request => this.runActionOperation(request),
            read: () => this.getAgentIsolationSnapshot(), effects,
            readCanonicalHomeServerIdentityId: () => this.lifecycleDependencies.resolveCurrentServerIdentityId?.() ?? null,
            captureMetadataPort: () => this.captureMachineMetadataFieldPort(),
            inspectOwn: async ({ requesterIdentity, homeServerIdentityId, signal }) => {
                const unavailable = (code: 'metadata_unavailable' | 'provisioning_unavailable' | 'agent_user_missing') => ({
                    protection: 'unavailable' as const, status: { kind: 'unavailable' as const, code },
                });
                signal?.throwIfAborted();
                // Admission supplied the held canonical Home once. The field
                // port supplies only current local transport/content custody.
                const metadata = await this.captureMachineMetadataFieldPort().read();
                if (metadata.status !== 'ready') return unavailable('metadata_unavailable');
                const policy = readMachineAgentIsolationPolicyV1(metadata.metadata);
                if (policy.status !== 'ready') return unavailable('metadata_unavailable');
                if (!policy.policy.enabled) return { protection: 'setup_pending', status: { kind: 'disabled' } };
                const snapshot = this.getAgentIsolationSnapshot();
                if (snapshot.status.kind === 'unavailable'
                    && (snapshot.status.code === 'metadata_unavailable' || snapshot.status.code === 'unsupported_platform'))
                    return { protection: 'unavailable', status: snapshot.status };
                if (snapshot.status.kind === 'applying') return { protection: 'setup_pending', status: snapshot.status };
                const shared = (): Exclude<MachineAgentIsolationOwnStatusV1, { protection: 'trusted_administrator' }> =>
                    snapshot.status.kind === 'effective' ? { protection: 'shared_user', status: snapshot.status }
                        : snapshot.status.kind === 'unavailable' ? { protection: 'unavailable', status: snapshot.status }
                            : { protection: 'setup_pending', status: snapshot.status };
                // Historical enablement is not owner consent to create users
                // and cannot be upgraded to private readiness by this read.
                if (policy.policy.memberProvisioning !== 'linuxUsersV1') return shared();
                if (effects.platform !== 'linux') return { protection: 'unavailable',
                    status: { kind: 'unavailable', code: 'unsupported_platform' } };
                if (this.projectionSchedulingClosed || requesterIdentity.requester.machineId !== this.machine.id
                    || requesterIdentity.requester.installationId !== this.machineRuntimeInstallationId)
                    return unavailable('provisioning_unavailable');
                const daemon = effects.readDaemonObservation?.();
                if (!daemon || daemon.daemonIdentity !== 'nonRoot' || daemon.daemonUid === null || daemon.daemonUid <= 0
                    || !daemon.daemonUsername || !daemon.daemonPrimaryGroup) return unavailable('provisioning_unavailable');
                try {
                    const memberIdentity = await readAgentIsolationMemberLaunchIdentity({
                        activeServerDir: configuration.activeServerDir,
                        requesterIdentity: { ...requesterIdentity, homeServerIdentityId }, signal,
                    }, effects.backend);
                    const ready = await observeAgentIsolationMemberLaunchReadiness({ installedCli: effects.installedCli,
                        memberIdentity, signal, system: effects.nativeReadiness?.system });
                    signal?.throwIfAborted();
                    return ready.kind === 'member_native_ready'
                        ? { protection: 'member_separated', status: ready.status, directories: ready.directories }
                        : { protection: 'unavailable', status: ready };
                } catch {
                    signal?.throwIfAborted();
                    return unavailable('agent_user_missing');
                }
            },
            target: () => {
                const custodianAccountId = readAccountIdFromToken(this.token);
                return custodianAccountId && this.machineRuntimeInstallationId ? {
                    serverId: this.machineRuntimeServerId, machineId: this.machine.id,
                    installationId: this.machineRuntimeInstallationId, custodianAccountId,
                } : null;
            },
        });
        this.qualifyStartupAgentIsolation();
    }

    /** Held host facts only. A restored projection is never current proof. */
    getMachineAdminAccessRights(): MachineDaemonRightsV1 {
        const held = this.machineAdminAccessRoutes?.observer.read() ?? null;
        const observation = held ?? (this.machineContentReady ? this.machine.daemonState?.adminAccess ?? null : null);
        const inspected = this.machineAdminAccessInspectedTransport;
        const current = held !== null && inspected !== null && inspected.generation === this.activeTransportGeneration
            && inspected.codec === this.machineContentCodec && this.machineContentReady
            && this.socket?.connected === true && !this.projectionSchedulingClosed;
        return { observation, freshness: current ? 'current' : 'stale' };
    }

    registerMachineGuardRoutes(options: DaemonMachineGuardRoutes): void {
        this.machineGuardLocalAction = registerDaemonMachineGuardRpcHandlers(this.rpcHandlerManager, { ...options,
            dispatchUndoAction: options.dispatchUndoAction ?? (async (input, context) => {
                const owner = this.externalActionIngressOwner;
                const target = options.target();
                if (!owner || this.projectionSchedulingClosed || !target || target.serverId !== owner.currentServerId) {
                    return { ok: false, errorCode: 'scope-retired', error: 'scope-retired' };
                }
                // The target admits the outer Undo once; its local Activity owner selects
                // the original effect through the core's private host-child callback.
                return dispatchActionFromRpc({ actionId: 'machines.guard.activity.undo', input, executor: owner.executor,
                    serverId: target.serverId, externalActionTarget: { kind: 'machine', machineId: target.machineId },
                    signal: context.signal, callerAuthority: context.callerAuthority,
                    localActionContext: context.localActionContext, sessionActionOrigin: context.sessionActionOrigin,
                    callerInputConstraints: context.callerInputConstraints, callerInputAuthorization: context.callerInputAuthorization,
                    machineAdmission: context.machineAdmission, verifyMachineAdmissionCurrent: context.verifyMachineAdmissionCurrent,
                    runtimeAccountId: context.machineAdmission?.actorAccountId,
                });
            }),
        });
    }

    executeMachineGuardAction(args: Parameters<NonNullable<ActionExecutorDeps['machineGuardAction']>>[0]): Promise<unknown> {
        if (this.projectionSchedulingClosed || !this.machineGuardLocalAction) {
            return Promise.resolve({ ok: false, errorCode: 'scope-retired', error: 'scope-retired' });
        }
        return this.machineGuardLocalAction(args);
    }

    registerStorageRoutes(options: DaemonStorageRoutes): void {
        registerDaemonStorageRpcHandlers(this.rpcHandlerManager, { ...options,
            observeActionExecution: request => this.actionOperationRuntime.observeExecution(request) });
    }

    registerConnectedAccountDaemonRuntime(runtime: ConnectedAccountDaemonRuntime): void {
        if (this.connectedAccountDaemonRuntime === runtime) return;
        this.connectedAccountDaemonRuntime = runtime;
        void this.refreshOperationProtocolCapabilitiesAdvertisement()
            .catch((error) => logger.warn('[API MACHINE] Connected Account capability publication failed', { error: serializeAxiosErrorForLog(error) }));
    }

    registerConnectedServicePoolSelectionRead(read: ConnectedServicePoolSelectionRead): void {
        this.connectedServicePoolSelectionRead = read;
    }

    registerConnectedAccountPurposeBindingRuntime(runtime: Pick<
        DaemonConnectedAccountPurposeBindingRuntime,
        'activatePurposeBindings' | 'listActionFormConnectedAccountOptions' | 'owner' | 'readSessionPurposeBindingSnapshot'
        | 'resolveCurrentSessionPurposeBindingSnapshot' | 'admitActionPurposeBindings'
    > & Readonly<{ materializeSessionProcessEnvironment?: SessionConnectedAccountProcessEnvironmentProducer }>): void {
        this.connectedAccountPurposeBindingRuntime = runtime;
    }

    /**
     * The `devices` Machine role's RPC families (computer, browser, simulator preview): one owned
     * set built from the routes the active devices role published, replaced as a whole. `null`
     * (role inactive or stopped) registers none of them, so their namespaces answer
     * `machine_role_inactive`.
     */
    private devicesRoleRoutes: DevicesRoleMachineRoutes | null = null;

    replaceDevicesRoleRoutes(routes: DevicesRoleMachineRoutes | null): void {
        this.devicesRoleRoutes = routes;
        this.rpcHandlerManager.replaceOwnedHandlers('machine-role:devices', () => {
            if (!routes) return;
            const resolveBrowserControl = () => this.devicesRoleRoutes?.browserControl ?? null;
            // Native-view imports are available independently of managed Chromium startup.
            registerDaemonBrowserControlHandler(this.rpcHandlerManager, {
                ...(routes.browserControl ? { browserControl: routes.browserControl } : {}),
                getNativeClient: () => this,
            });
            if (routes.resolveComputer) registerDaemonComputerHandler(this.rpcHandlerManager, { resolveComputer: routes.resolveComputer });
            if (routes.browserViewDiscovery) registerDaemonBrowserViewWatchHandler(this.rpcHandlerManager, routes.browserViewDiscovery);
            if (routes.browserContext) registerDaemonBrowserContextHandler(this.rpcHandlerManager, { browserContext: routes.browserContext, resolveBrowserControl });
            if (routes.browserDiagnostics) {
                registerDaemonBrowserDiagnosticsSnapshotHandler(this.rpcHandlerManager, { browserDiagnostics: routes.browserDiagnostics, resolveBrowserControl });
            }
            if (routes.browserRecording) registerDaemonBrowserRecordingHandlers(this.rpcHandlerManager, { browserRecording: routes.browserRecording, resolveBrowserControl });
            if (routes.simulatorPreview) registerDaemonSimulatorPreviewHandlers(this.rpcHandlerManager, { simulatorPreview: routes.simulatorPreview });
        });
    }

    registerManagedFiniteWake(input: Parameters<typeof registerManagedFiniteWake>[1]): void {
        registerManagedFiniteWake(this.rpcHandlerManager, input);
    }

    registerLiveStreamRelayRoutes(relay: DaemonLiveStreamRelayRoutes): void {
        this.liveStreamRelayRoutes = relay;
        registerDaemonLiveStreamRelayHandlers(this.rpcHandlerManager, {
            relay,
        });
    }

    onUpdate(listener: (update: Update) => boolean | void): () => void {
        this.updateListeners.add(listener);
        return () => {
            this.updateListeners.delete(listener);
        };
    }

    onAccountSettingsVersionHint(listener: (hint: AccountSettingsVersionHintNotification) => void | Promise<void>): () => void {
        this.accountSettingsVersionHintListeners.add(listener);
        return () => {
            this.accountSettingsVersionHintListeners.delete(listener);
        };
    }

    /** Content-free invalidation on the already-consumed Account feed; no second socket or cursor. */
    onSessionFollowRulesChanged(listener: (change?: SessionFollowSourceInvalidation) => void | Promise<void>): () => void {
        this.sessionFollowRulesChangedListeners.add(listener);
        return () => { this.sessionFollowRulesChangedListeners.delete(listener); };
    }

    private async notifySessionFollowRulesChanged(change: SessionFollowSourceInvalidation): Promise<void> {
        // Start synchronous projection invalidations before any subscriber's
        // awaited recovery resumes. One failed consumer must not prevent a
        // later cache from observing the same committed change.
        const outcomes = await Promise.allSettled([...this.sessionFollowRulesChangedListeners]
            .map(async listener => listener(change)));
        // Keep cursor acknowledgement behind every subscriber, including when
        // an earlier listener failed. Preserve the first registered failure.
        for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    }

    onAccountProjectRowsChanged(listener: (change: AccountProjectRowsChangeNotification) => void | Promise<void>): () => void {
        this.accountProjectRowsChangeListeners.add(listener);
        return () => { this.accountProjectRowsChangeListeners.delete(listener); };
    }

    onAutomationEventSourcesInvalidated(listener: (payload: AutomationEventSourcesInvalidatedHostEventV1) => void | Promise<void>): () => void {
        this.automationEventSourcesInvalidationListeners.add(listener);
        return () => { this.automationEventSourcesInvalidationListeners.delete(listener); };
    }

    private async notifyAutomationEventSourcesInvalidated(signal: AbortSignal, payload: AutomationEventSourcesInvalidatedHostEventV1 = {}): Promise<void> {
        for (const listener of this.automationEventSourcesInvalidationListeners) {
            signal.throwIfAborted();
            await listener(payload);
        }
    }

    /** Content-free receipt delivered only to this source's current observation Machine. */
    onHealthCheckHeartbeatReceived(listener: (receipt: PluginWebhookHeartbeatReceiptHintV1) => void): () => void {
        this.healthCheckHeartbeatReceiptListeners.add(listener);
        return () => { this.healthCheckHeartbeatReceiptListeners.delete(listener); };
    }

    /** Queued-work recovery, distinct from broad source/catalog invalidation. */
    onAutomationWorkInvalidated(listener: () => void | Promise<void>): () => void {
        this.automationWorkInvalidationListeners.add(listener);
        return () => { this.automationWorkInvalidationListeners.delete(listener); };
    }

    private async notifyAutomationWorkInvalidated(signal: AbortSignal): Promise<void> {
        for (const listener of this.automationWorkInvalidationListeners) {
            signal.throwIfAborted();
            await listener();
        }
    }

    /** Queue/endpoint and Availability wakes from the one consumed Account feed. */
    onPluginWebhookInvalidated(listener: () => void | Promise<void>): () => void {
        this.pluginWebhookInvalidationListeners.add(listener);
        return () => { this.pluginWebhookInvalidationListeners.delete(listener); };
    }

    private async notifyPluginWebhookInvalidated(signal: AbortSignal): Promise<void> {
        for (const listener of this.pluginWebhookInvalidationListeners) {
            signal.throwIfAborted();
            await listener();
        }
    }

    /** Controller-specific managed rows and accepted-work hints from the existing transport. */
    onManagedMachinePolicyInvalidated(listener: (change?: ManagedMachinePolicyInvalidation) => void | Promise<void>): () => void {
        this.managedMachinePolicyInvalidationListeners.add(listener);
        return () => { this.managedMachinePolicyInvalidationListeners.delete(listener); };
    }

    private async notifyManagedMachinePolicyInvalidated(signal?: AbortSignal, change?: ManagedMachinePolicyInvalidation): Promise<void> {
        for (const listener of this.managedMachinePolicyInvalidationListeners) {
            signal?.throwIfAborted();
            await listener(change);
        }
    }

    onPendingSessionActivationHint(
        listener: (hint: PendingSessionActivationHintNotification) => void | Promise<void>,
    ): () => void {
        this.pendingSessionActivationHintListeners.add(listener);
        return () => {
            this.pendingSessionActivationHintListeners.delete(listener);
        };
    }

    onSessionDeletedChange(
        listener: (
            change: SessionDeletedChangeNotification,
        ) => void | Promise<void>,
    ): () => void {
        this.sessionDeletedChangeListeners.add(listener);
        return () => {
            this.sessionDeletedChangeListeners.delete(listener);
        };
    }

    onSessionTranscriptRevised(
        listener: (change: SessionTranscriptRevisionNotification) => void | Promise<void>,
    ): () => void {
        this.sessionTranscriptRevisionListeners.add(listener);
        return () => { this.sessionTranscriptRevisionListeners.delete(listener); };
    }

    onSessionChanged(
        listener: (change: SessionChangeNotification) => void | Promise<void>,
    ): () => void {
        this.sessionChangeListeners.add(listener);
        return () => { this.sessionChangeListeners.delete(listener); };
    }

    getSessionSyncPendingInputServerContractResult():
        SessionSyncPendingInputServerContractResult | null {
        const result = this.sessionSyncPendingInputServerContractResult;
        return (
            result
            && result.sessionConnectionEpoch === this.activeTransportGeneration
            && result.socket === this.socket
            && result.socket.connected === true
        )
            ? result
            : null;
    }

    private async notifyPendingSessionActivationHint(
        hint: PendingSessionActivationHintNotification,
    ): Promise<void> {
        for (const listener of this.pendingSessionActivationHintListeners) {
            try {
                await Promise.resolve(listener(hint));
            } catch (error) {
                logger.warn('[API MACHINE] Pending session activation listener failed; Pending custody retained', {
                    sessionId: hint.sessionId,
                    requestId: hint.requestId,
                    source: hint.source,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    private async notifySessionDeletedChange(
        change: SessionDeletedChangeNotification,
    ): Promise<void> {
        for (const listener of this.sessionDeletedChangeListeners) {
            await Promise.resolve(listener(change));
        }
    }

    onSessionAccessRevoked(
        listener: (
            change: SessionAccessRevokedNotification,
        ) => void | Promise<void>,
    ): () => void {
        this.sessionAccessRevokedListeners.add(listener);
        return () => {
            this.sessionAccessRevokedListeners.delete(listener);
        };
    }

    private async notifySessionAccessRevoked(
        change: SessionAccessRevokedNotification,
    ): Promise<void> {
        for (const listener of this.sessionAccessRevokedListeners) {
            await Promise.resolve(listener(change));
        }
    }

    onSessionAccessReset(
        listener: (change: SessionAccessResetNotification) => void | Promise<void>,
    ): () => void {
        this.sessionAccessResetListeners.add(listener);
        return () => {
            this.sessionAccessResetListeners.delete(listener);
        };
    }

    private async notifySessionAccessReset(
        change: SessionAccessResetNotification,
    ): Promise<void> {
        for (const listener of this.sessionAccessResetListeners) {
            await Promise.resolve(listener(change));
        }
    }

    onManagedProviderRetainedCurrentnessInvalidation(
        listener: (
            change: ManagedProviderRetainedCurrentnessInvalidation,
        ) => void | Promise<void>,
    ): () => void {
        this.managedProviderRetainedCurrentnessListeners.add(listener);
        return () => {
            this.managedProviderRetainedCurrentnessListeners.delete(listener);
        };
    }

    private async notifyManagedProviderRetainedCurrentnessInvalidation(
        change: ManagedProviderRetainedCurrentnessInvalidation,
    ): Promise<void> {
        for (const listener of this.managedProviderRetainedCurrentnessListeners) {
            await Promise.resolve(listener(change));
        }
    }

    /**
     * Live archive-state transitions from the incumbent Session update stream.
     * This is the one archive-state seam; the machine RPC handlers and the
     * daemon memory owner both consume it rather than reading `update-session`
     * themselves.
     */
    onSessionArchivedStateChange(
        listener: (
            change: Readonly<{ sessionId: string; archived: boolean }>,
        ) => void | Promise<void>,
    ): () => void {
        return this.onUpdate((update) => {
            const body = update.body;
            if (body.t !== 'update-session' || body.archivedAt === undefined) {
                return false;
            }
            const change = { sessionId: body.id, archived: body.archivedAt !== null } as const;
            void Promise.resolve(listener(change)).catch((error) => {
                logger.warn('[API MACHINE] Session archive-state listener failed', {
                    sessionId: change.sessionId,
                    archived: change.archived,
                    message: error instanceof Error ? error.message : String(error),
                });
            });
            return true;
        });
    }

    /** A retained inventory requires the live, supported changes reader and its consumer. */
    hasCurrentAccountChangesObserver(): boolean {
        return !this.projectionSchedulingClosed
            && this.connectedServicesProjectionListener !== null
            && this.socket?.connected === true
            && this.accountChangesObserverTransportGeneration === this.activeTransportGeneration;
    }

    onConnectedServicesProjection(
        listener: (notification: ConnectedServicesProjectionNotification) => void | Promise<void>,
    ): () => void {
        if (this.connectedServicesProjectionListener) {
            throw new Error('Connected-services projection reconciliation already has an owner');
        }
        this.connectedServicesProjectionListener = listener;
        return () => {
            if (this.connectedServicesProjectionListener === listener) {
                this.connectedServicesProjectionListener = null;
            }
        };
    }

    private async reconcileConnectedServicesProjection(
        notification: Omit<
            ConnectedServicesProjectionNotification,
            | 'signal'
            | 'connectedServicesV2'
            | 'connectedServiceCredentialRevisionsV1'
        >,
        signal: AbortSignal,
    ): Promise<void> {
        signal.throwIfAborted();
        if (!this.connectedServicesProjectionListener) {
            throw new Error('connected_services_projection_reconciler_unavailable');
        }
        // Exact quota Refresh demand has no credential projection to reconcile.
        const profile = notification.quotaRefreshOnly === true
            ? null : await fetchAccountProfile({ token: this.token, signal });
        signal.throwIfAborted();
        try {
            await this.connectedServicesProjectionListener({
                ...notification,
                signal,
                connectedServicesV2: profile?.connectedServicesV2,
                connectedServiceCredentialRevisionsV1: profile?.connectedServiceCredentialRevisionsV1,
            });
        } catch (error) {
            if (!isConnectedServiceGenerationReconciliationNotAcknowledgeableError(error)) throw error;
            logger.debug('[API MACHINE] Connected-services generation reconciliation awaits another domain event', {
                source: notification.source,
            });
        }
        signal.throwIfAborted();
    }

    private async notifyAccountSettingsVersionHint(hint: AccountSettingsVersionHintNotification): Promise<void> {
        for (const listener of this.accountSettingsVersionHintListeners) {
            try {
                await Promise.resolve(listener(hint));
            } catch (error) {
                logger.warn('[API MACHINE] Account settings version hint listener failed; continuing changes catch-up', {
                    settingsVersion: hint.settingsVersion,
                    source: hint.source,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    private async notifyAccountProjectRowsChanged(change: AccountProjectRowsChangeNotification): Promise<void> {
        for (const listener of this.accountProjectRowsChangeListeners) {
            change.signal.throwIfAborted();
            // The opened rows must be published before this durable feed page
            // is acknowledged. Refusal leaves the cursor for the retry owner.
            await listener(change);
        }
        change.signal.throwIfAborted();
    }

    onMachineTransferEnvelope(listener: (payload: MachineTransferReceiveEnvelope) => void): () => void {
        this.machineTransferListeners.add(listener);
        return () => {
            this.machineTransferListeners.delete(listener);
        };
    }

    onTransferRelayV2Envelope(listener: (payload: TransferRelayV2SendEnvelope) => void): () => void {
        this.transferRelayV2Listeners.add(listener);
        return () => {
            this.transferRelayV2Listeners.delete(listener);
        };
    }

    onPeerTcpTunnelRelayEnvelope(listener: (payload: PeerTcpTunnelRelayEnvelope) => void): () => void {
        this.peerTcpTunnelRelayListeners.add(listener);
        return () => {
            this.peerTcpTunnelRelayListeners.delete(listener);
        };
    }

    onMachineLiveStreamRelayEnvelope(listener: (payload: MachineLiveStreamRelayEnvelopeV1) => void): () => void {
        this.machineLiveStreamRelayListeners.add(listener);
        return () => {
            this.machineLiveStreamRelayListeners.delete(listener);
        };
    }

    onExternalSessionStatusDemand(
        listener: (payload: ExternalSessionStatusDemandDaemonMessageV1) => void,
    ): () => void {
        this.externalSessionStatusDemandListeners.add(listener);
        return () => {
            this.externalSessionStatusDemandListeners.delete(listener);
        };
    }

    onConnectionStateChange(listener: (state: ManagedConnectionState) => void): () => void {
        this.connectionStateListeners.add(listener);
        listener(this.currentConnectionState);
        return () => {
            this.connectionStateListeners.delete(listener);
        };
    }

    /**
     * Whether this daemon can currently serve the machine-control RPCs the server dispatches
     * to it: an active transport whose registration reached the readiness publication.
     *
     * This is the only fact that separated a working daemon from the 56-minute pid-26058
     * outage — the process, its heartbeat, its control-server ping and its socket were all
     * healthy while every machine RPC was unreachable. Registration transitions publish
     * it to local status immediately; the heartbeat also samples this same owner.
     */
    isMachineControlRegistrationReady(): boolean {
        return this.machineContentReady && this.socket !== null
            && this.machineControlRunningGeneration === this.activeTransportGeneration;
    }

    sendMachineTransferEnvelope(payload: MachineTransferSendEnvelope): void {
        if (!this.socket) return;
        this.socket.emit(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, payload);
    }

    hasConnectedClientRpcHandler(method: string): boolean {
        const normalized = this.normalizeMachineScopedRpcMethod(method);
        const available = normalized ? this.connectedClientRpcMethods.has(normalized) : false;
        if (isCurrentUiContextClientRpcMethod(method)) {
            logger.warn('[API MACHINE] Current UI RPC availability checked', {
                machineId: this.machine.id,
                method,
                normalizedMethod: normalized,
                available,
                transportGeneration: this.activeTransportGeneration,
                socketConnected: this.socket?.connected === true,
            });
        }
        return available;
    }

    sendTransferRelayV2Envelope(payload: TransferRelayV2SendEnvelope): void {
        if (!this.socket) return;
        this.socket.emit(TRANSFER_RELAY_V2_SOCKET_EVENT, payload);
    }

    sendPeerTcpTunnelRelayEnvelope(payload: PeerTcpTunnelRelayEnvelope): void {
        if (!this.socket) return;
        this.socket.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, payload);
    }

    private readLiveStreamContentCodec(envelope: MachineLiveStreamRelayEnvelopeV1 | MachineLiveStreamWireEnvelopeV1): MachineContentCodec {
        const message = envelope.message;
        const streamId = message.kind === 'frame' ? message.frame.streamId
            : message.kind === 'sideband_control' ? message.control.streamId : undefined;
        return (streamId ? this.liveStreamRelayRoutes?.getContentCodec?.(streamId) : undefined) ?? this.machineContentCodec;
    }

    getMachineLiveStreamFramePayloadByteLimit(envelope: MachineLiveStreamRelayEnvelopeV1, maxFrameBytes: number): number {
        return resolveMachineLiveStreamFramePayloadByteLimit({ envelope, maxFrameBytes, codec: this.readLiveStreamContentCodec(envelope) });
    }

    async sendMachineLiveStreamRelayEnvelope(payload: MachineLiveStreamRelayEnvelopeV1): Promise<
        Readonly<{ ok: true } | { ok: false; code: MachineLiveStreamPayloadErrorCodeV1 }>
    > {
        const socket = this.socket;
        if (!socket || !this.machineContentReady) return { ok: false, code: 'stream_transport_unavailable' };
        const parsed = MachineLiveStreamDecodedEnvelopeV1Schema.safeParse(payload);
        if (!parsed.success) return { ok: false, code: 'stream_payload_invalid' };
        if (!hasMachineLiveStreamSensitiveContentV1(parsed.data)) {
            socket.emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, MachineLiveStreamRelayEnvelopeV1Schema.parse(parsed.data));
            return { ok: true };
        }
        const machineCodec = this.machineContentCodec;
        const codec = this.readLiveStreamContentCodec(parsed.data);
        const sealed = await sealMachineLiveStreamEnvelopeV1(parsed.data, {
            mode: codec.mode,
            ...(codec.mode === 'e2ee' ? { cipher: {
                encryptRaw: (value: unknown) => codec.encodeRpc(value),
                decryptRaw: (value: string) => codec.decodeRpc(value),
            } } : {}),
        });
        if (!sealed.ok) {
            this.failMachineLiveStreamPayload(parsed.data, sealed.code);
            return sealed;
        }
        if (this.socket !== socket || machineCodec !== this.machineContentCodec || !this.machineContentReady) return { ok: false, code: 'stream_transport_unavailable' };
        socket.emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, sealed.value);
        return { ok: true };
    }

    private failMachineLiveStreamPayload(envelope: MachineLiveStreamRelayEnvelopeV1 | MachineLiveStreamWireEnvelopeV1, code: MachineLiveStreamPayloadErrorCodeV1): void {
        logger.warn('[API MACHINE] Live-stream payload rejected', { code });
        const message = envelope.message;
        if (message.kind !== 'frame' && message.kind !== 'sideband_control') return;
        const stopped = { ...envelope, message: {
            kind: 'control' as const, control: { v: 1 as const,
                streamId: message.kind === 'frame' ? message.frame.streamId : message.control.streamId,
                kind: 'stop' as const, reasonCode: code,
            },
        } } satisfies MachineLiveStreamRelayEnvelopeV1;
        this.socket?.emit(MACHINE_LIVE_STREAM_SOCKET_EVENT, stopped);
        for (const listener of this.machineLiveStreamRelayListeners) {
            try { listener(stopped); } catch { logger.warn('[API MACHINE] Live-stream stop listener threw'); }
        }
    }

    emitExternalSessionTranscriptUpdate(payload: ExternalSessionTranscriptInvalidationV1): void {
        if (!this.socket) return;
        this.socket.emit('external-session-transcript-invalidated', payload);
    }

    emitUsageSourcesInvalidated(): void {
        const installationId = this.machineRuntimeInstallationId;
        if (!this.socket?.connected || this.projectionSchedulingClosed
            || configuration.activeServerId !== this.machineRuntimeServerId || !installationId
            || readInstallationIdentityIfExistsSync()?.installationId !== installationId) return;
        const payload: UsageSourcesInvalidationV1 = {
            type: USAGE_SOURCES_INVALIDATION_EVENT_V1,
            machineId: this.machine.id,
            installationId,
        };
        this.socket.emit(USAGE_SOURCES_INVALIDATION_EVENT_V1, payload);
    }

    emitExecutionRunSourceUpdated(runId: string): void {
        const installationId = this.machineRuntimeInstallationId;
        if (!this.socket?.connected || this.projectionSchedulingClosed
            || configuration.activeServerId !== this.machineRuntimeServerId || !installationId
            || readInstallationIdentityIfExistsSync()?.installationId !== installationId) return;
        const payload: ExecutionRunMachineActivityV1 = { machineId: this.machine.id, installationId, runId };
        this.socket.emit('execution-run-updated', payload);
    }

    emitScmDiffSummaryResultUpdated(change: ScmDiffSummaryResultRevisionHint): void {
        const installationId = this.machineRuntimeInstallationId;
        if (!this.socket?.connected || this.projectionSchedulingClosed
            || configuration.activeServerId !== this.machineRuntimeServerId || !installationId
            || readInstallationIdentityIfExistsSync()?.installationId !== installationId) return;
        this.socket.emit(SCM_DIFF_SUMMARY_RESULT_UPDATED_EVENT, { ...change, machineId: this.machine.id, installationId });
    }

    emitExternalSessionSourceUnavailableOccurrence(
        payload: ExternalSessionSourceUnavailableOccurrenceV1,
    ): void {
        if (!this.socket) return;
        this.socket.emit(EXTERNAL_SESSION_SOURCE_UNAVAILABLE_OCCURRENCE_EVENT_V1, payload);
    }

    async retireTeamCredentialExternalProviderOperation(input: Readonly<{
        externalApiKeyId: string;
        operationId: string;
    }>): Promise<void> {
        if (!this.socket?.connected) throw new Error('Machine socket is unavailable for broker retirement.');
        const request = TeamCredentialExternalProviderOperationRetireV1Schema.parse({ v: 1, ...input });
        const response = await this.socket.timeout(resolveSessionControlSocketAckTimeoutMs())
            .emitWithAck(TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1, request);
        const result = TeamCredentialExternalProviderOperationRetireResponseV1Schema.parse(response);
        if (!result.ok) throw new Error('Broker operation retirement was not authorized.');
    }

    async executeExternalSessionHistoricalImportCommand(
        command: ExternalSessionOperationSocketCommandV1,
    ): Promise<ExternalSessionOperationSocketResponseV1> {
        if (!this.socket) {
            return {
                v: 1,
                kind: 'error',
                errorCode: 'internal_error',
                message: 'Machine socket is unavailable.',
            };
        }
        const socket = this.socket;
        const timeoutMs = resolveSessionControlSocketAckTimeoutMs();
        return await new Promise<ExternalSessionOperationSocketResponseV1>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('External session historical import command timed out.'));
            }, timeoutMs);
            socket.emit(EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1, command, (response) => {
                clearTimeout(timeout);
                resolve(response);
            });
        });
    }

    /**
     * Reverse (daemon -> connected client/UI) RPC call over the persistent machine socket (W2C-BA-1).
     *
     * The spawned cli daemon runs in a SEPARATE OS process and cannot drive client-owned surfaces
     * (e.g. the desktop Wry WebView) directly. This emits a machine-scoped `rpc-call` for
     * `<machineId>:<method>` exactly the way the client emits forward machine RPC, so the server
     * routes it to whichever connected client socket (the desktop UI) registered the method. Params +
     * result use the Machine's canonical content mode. Fails closed
     * (never throws) when the socket is down, the call times out, or no client is registered, so the
     * caller stays fail-safe.
     */
    async callConnectedClientRpc<TResult = unknown>(
        method: string,
        params: unknown,
        options?: Readonly<{ timeoutMs?: number | null; signal?: AbortSignal; onIssued?: () => void;
            answeringClient?: SocketRpcAnsweringClientV1 }>,
    ): Promise<Readonly<{ ok: true; result: TResult; answeringClientId?: string; answeringClientIds?: readonly string[]; answeringClients?: readonly SocketRpcAnsweringClientCandidateV1[] }> | Readonly<{ ok: false; error?: string; errorCode?: string; answeringClients?: readonly SocketRpcAnsweringClientCandidateV1[] }>> {
        const socket = this.socket;
        if (!socket || !this.machineContentReady) {
            return { ok: false, errorCode: 'machine_socket_unavailable' };
        }
        const timeoutMs = options?.timeoutMs === null ? null
            : options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 20_000;
        // Caller-lifetime reverse operations have no shorter ACK deadline. The
        // existing server advertisement retires their last answering handler.
        const handlerRetirement = timeoutMs === null ? new AbortController() : null;
        const signal = handlerRetirement
            ? options?.signal ? AbortSignal.any([options.signal, handlerRetirement.signal]) : handlerRetirement.signal
            : options?.signal;
        const onUnregistered = (data: unknown): void => {
            const retiredMethod = data && typeof data === 'object' && 'method' in data ? data.method : undefined;
            if (this.normalizeConnectedClientRpcAvailabilityMethod(retiredMethod)
                === this.normalizeMachineScopedRpcMethod(method)) handlerRetirement?.abort();
        };
        const codec = this.machineContentCodec;
        let resultDecodeFailed = false;
        const content: SocketRpcContent = codec.mode === 'plain' ? { mode: 'plain' } : {
            mode: 'e2ee',
            cipher: {
                encryptRaw: async (value) => codec.encodeRpc(value),
                decryptRaw: async (ciphertext) => {
                    try { return codec.decodeRpc(ciphertext); }
                    catch (error) { resultDecodeFailed = true; throw error; }
                },
            },
        };
        if (handlerRetirement) socket.on(SOCKET_RPC_EVENTS.UNREGISTERED, onUnregistered);
        let answeringClients: readonly SocketRpcAnsweringClientCandidateV1[] | undefined;
        try {
            let answeringClientId: string | undefined;
            let answeringClientIds: readonly string[] | undefined;
            const result = await callSocketRpc<TResult>({
                socket,
                target: { kind: 'machine', id: this.machine.id },
                method,
                params,
                content,
                timeoutMs,
                signal,
                onIssued: options?.onIssued,
                answeringClient: options?.answeringClient,
                onResponse: response => {
                    if (response && typeof response === 'object' && 'answeringClients' in response) {
                        const candidates = SocketRpcAnsweringClientCandidatesV1Schema.safeParse(response.answeringClients);
                        if (candidates.success) answeringClients = candidates.data;
                    }
                    if (response && typeof response === 'object' && 'answeringClientId' in response
                        && typeof response.answeringClientId === 'string') answeringClientId = response.answeringClientId;
                    if (response && typeof response === 'object' && 'answeringClientIds' in response
                        && Array.isArray(response.answeringClientIds) && response.answeringClientIds.every(id => typeof id === 'string')) {
                        answeringClientIds = response.answeringClientIds;
                    }
                },
            });
            // The decoded ACK is already a known receipt. A later socket state
            // cannot turn that completion back into an uncertain effect.
            return { ok: true, result, ...(answeringClientId ? { answeringClientId } : {}), ...(answeringClientIds ? { answeringClientIds } : {}), ...(answeringClients ? { answeringClients } : {}) };
        } catch (error) {
            if (resultDecodeFailed) return { ok: false, errorCode: 'machine_rpc_result_decrypt_failed' };
            const errorCode = readRpcErrorCode(error);
            return {
                ok: false,
                error: isSocketIoAckTimeoutError(error) ? 'RPC call timeout' : error instanceof Error ? error.message : 'RPC call failed',
                ...(errorCode ? { errorCode } : {}),
                ...(errorCode === RPC_ERROR_CODES.CLIENT_AMBIGUOUS && answeringClients ? { answeringClients } : {}),
            };
        } finally {
            if (handlerRetirement) socket.off(SOCKET_RPC_EVENTS.UNREGISTERED, onUnregistered);
        }
    }

    /** Source Session custody is admitted by the daemon before using this verified Machine socket. */
    async callSessionActionRpc(request: Parameters<SessionActionRpcTransport>[0]): Promise<unknown> {
        const socket = this.socket;
        if (!socket?.connected) throw Object.assign(new Error('machine_socket_unavailable'), { code: 'machine_socket_unavailable' });
        const authorization = request.executionAuthorization;
        const installation = authorization ? readInstallationIdentityIfExistsSync() : null;
        if (authorization && (!installation || authorization.binding.machineId !== this.machine.id
            || authorization.binding.installationId !== installation.installationId
            || authorization.binding.target.kind !== 'session' || authorization.binding.target.sessionId !== request.sessionId
            || !authorization.binding.workflowActionOrigin?.sessionAuthority)) {
            throw Object.assign(new Error('role_rpc_origin_unavailable'), { code: 'role_rpc_origin_unavailable' });
        }
        return await callSocketRpc({
            socket, target: { kind: 'session', id: request.sessionId }, method: request.method,
            params: request.input, content: request.content,
            ...(request.origin ? { authorization: { kind: 'session.action' as const, sessionId: request.sessionId, origin: request.origin } } : {}),
            ...(authorization && installation ? { createExternalActionExecution: wire => {
                const execution = createExternalActionMachineRpcExecution({
                    context: { externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target },
                    effectActionId: authorization.binding.actionId, installationId: installation.installationId,
                    method: wire.method, requestId: wire.requestId, params: wire.params, privateKey: installation.privateKey });
                if (!execution) throw new Error('role_rpc_origin_unavailable');
                return execution;
            } } : {}),
            timeoutMs: null,
            ...(request.signal ? { signal: request.signal } : {}),
        });
    }

    /** The installed chosen Project child retains its actual envelope and original SOURCE namespace. */
    async callWorkspaceSyncProjectSource(input: Readonly<{ machineId: string; operationId: string;
        sourceWorkspace: WorkspaceRefV1; context: RpcHandlerContext;
        credentials: import('@/persistence').StoredCredentials }> & (
            Readonly<{ method?: typeof RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN; request: OpenProjectInputV1 }>
            | Readonly<{ method: typeof RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN; request: WorkspaceSyncPrepareBetweenRequestV1 }>
        )): Promise<unknown> {
        const authorization = input.context.callerInputAuthorization;
        const envelope = ExternalActionRequestEnvelopeSchema.safeParse(input.context.originalActionEnvelope);
        const preparation = input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN;
        const actionId = authorization?.binding.actionId;
        const serverId = input.sourceWorkspace.serverId;
        if (!authorization || !envelope.success || !input.context.machineAdmission
            || (preparation ? !isProjectWorkspaceSyncPreparationActionV1(actionId) : !isProjectWorkspaceSyncOpenActionV1(actionId))
            || input.context.machineAdmission.machineId !== this.machine.id
            || !isExternalActionAuthorizationBoundToEnvelope(authorization.binding,
                { actionId: authorization.binding.actionId, machineId: this.machine.id, envelope: envelope.data })) {
            throw markRpcRequestDisposition(Object.assign(new Error('Original Project SOURCE envelope is unavailable'),
                { code: 'peer_unavailable' }), 'notSent');
        }
        const syncAction = 'materialization' in input.request && input.request.materialization.kind === 'sync'
            ? input.request.materialization.workspaceAction : undefined;
        const admitted = readWorkspaceSyncSourceAdmissionV1(authorization.binding, { serverId,
            relationshipId: preparation ? authorization.binding.workspaceSyncAdmission?.relationshipId ?? ''
                : syncAction?.kind === 'relationship' ? syncAction.relationshipId
                : deriveWorkspaceSyncRelationshipId(input.operationId),
            machineId: input.sourceWorkspace.machineId, workspaceRefId: input.sourceWorkspace.id });
        if (!admitted) {
            throw markRpcRequestDisposition(Object.assign(new Error('Original Project SOURCE admission is unavailable'),
                { code: 'workspace_sync_source_admission_unavailable' }), 'notSent');
        }
        const source = admitted.source;
        const facts = await readWorkspaceSyncChildMachineFacts({ serverId,
            serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl, machineIds: [source.machineId], purpose: 'admitted_mapping',
            relationshipId: admitted.relationshipId,
            authorization, effectActionId: authorization.binding.actionId, signal: input.context.signal })
            .catch(error => { throw markRpcRequestDisposition(error, 'notSent'); });
        const address = resolveWorkspaceSyncTransportAddress({ namespace: input.sourceWorkspace, childMachines: facts });
        if (!preparation && (!address.ok || address.address.machineId !== input.machineId)) {
            throw markRpcRequestDisposition(Object.assign(new Error('Original Project SOURCE controller is unavailable'),
                { code: 'peer_unavailable' }), 'notSent');
        }
        const context = buildActionExecutorContextForRpc({ ...input.context, serverId,
            externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target });
        const workspaceSyncSourceRouting = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare',
            operationId: input.operationId, accountServerId: serverId, sourceMachineId: source.machineId,
            sourceRootPath: input.sourceWorkspace.rootPath, originalActionEnvelope: envelope.data,
            sourceContext: { ...projectWorkspaceSyncPhysicalContextFromActionContext(context), machineAdmission: source } });
        const result = await this.callWorkspaceSyncPhysicalMachineRpc({
            machineId: input.machineId, context, credentials: input.credentials, request: input.request,
            originalMachineId: this.machine.id, accountServerId: serverId, requireCurrentAdmission: true,
            signedEffectActionId: authorization.binding.actionId, method: input.method ?? RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN,
            ...(!preparation && address.ok && address.address.installationId ? { physicalEndpointInstallationId: address.address.installationId } : {}),
            routing: { workspaceSyncSourceRouting }, signal: input.context.signal,
        });
        return preparation ? WorkspaceSyncPrepareBetweenResultV1Schema.parse(result) : ProjectOpenSyncMaterializationResultV1Schema.parse(result);
    }

    /** The installed child's existing socket attests its admitted workspace effect, never parent Account authority. */
    async callWorkspaceSyncHandoffSourcePhase(input: Readonly<{
        machineId: string;
        physicalEndpoint?: MachineInstallationPublicIdentityV1;
        credentials: import('@/persistence').StoredCredentials;
        context: RpcActionExecutorContext;
        request: WorkspaceSyncHandoffSourcePhaseRequestV1;
        signal?: AbortSignal;
    }>): Promise<unknown> {
        const request = WorkspaceSyncHandoffSourcePhaseRequestV1Schema.parse(input.request);
        const workspaceSyncSourceRouting = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1,
            phase: request.phase, operationId: request.input.operationId, accountServerId: request.input.accountServerId,
            sourceMachineId: request.input.sourceMachineId, sourceRootPath: request.input.sourceRootPath,
            ...(request.input.sourceSessionId ? { sourceSessionId: request.input.sourceSessionId } : {}),
            sourceContext: projectWorkspaceSyncPhysicalContextFromActionContext(input.context) });
        const effectful = request.phase === 'prepare' || request.phase === 'finalize';
        return WorkspaceSyncHandoffSourcePhaseResultV1Schema.parse(await this.callWorkspaceSyncPhysicalMachineRpc({ ...input,
            method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE, request,
            originalMachineId: request.input.sourceMachineId, accountServerId: request.input.accountServerId,
            requireCurrentAdmission: effectful, signedEffectActionId: 'session.handoff',
            routing: { workspaceSyncSourceRouting },
        }));
    }

    async preflightWorkspaceSyncRelationshipTarget(
        request: import('@happier-dev/protocol').HandoffTargetReplacementPreflightV1,
        context: RpcHandlerContext,
    ): Promise<import('@happier-dev/protocol').HandoffTargetReplacementPreflightResultV1> {
        const preflight = this.lifecycleDependencies.workspaceSync?.preflightRelationshipTarget;
        if (!preflight) throw Object.assign(new Error('Workspace Sync source preflight is unavailable'), { code: 'workspace_sync_unavailable' });
        return preflight(request, context);
    }

    /** Only the installed chosen target can attest its own admitted namespace to the physical writer. */
    async callWorkspaceSyncTargetPhase(input: WorkspaceSyncTargetPhaseDescriptor & Readonly<{
        credentials: import('@/persistence').StoredCredentials;
        context: RpcActionExecutorContext;
    }>): Promise<unknown> {
        if (input.context.workspaceSyncSourceWriterTargetRouting) {
            const workspaceSyncSourceWriterTargetRouting = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(
                input.context.workspaceSyncSourceWriterTargetRouting);
            if (isWorkspaceSyncSourceWriterCleanupPhaseV1(input.routing.phase) && input.routing.phase !== 'release') {
                return await this.callWorkspaceSyncPhysicalMachineRpc({ ...input,
                    originalMachineId: this.machine.id, accountServerId: input.routing.accountServerId,
                    requireCurrentAdmission: false, routing: { workspaceSyncSourceWriterTargetRouting } });
            }
            if (input.routing.phase === 'release' && input.physicalEndpoint) {
                const physicalEndpoint = MachineInstallationPublicIdentityV1Schema.parse(input.physicalEndpoint);
                if (input.method !== RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE
                    || input.machineId !== physicalEndpoint.machineId
                    || !isDeepStrictEqual(input.routing, workspaceSyncSourceWriterTargetRouting.target)
                    || ('workspaceSyncTargetRouting' in input.context && input.context.workspaceSyncTargetRouting !== undefined)
                    || input.context.callerInputAuthorization || input.context.externalActionExecutionAuthorization
                    || !doesWorkspaceSyncTargetRequestMatchRouting(input.request, { ...input.routing,
                        targetContext: workspaceSyncSourceWriterTargetRouting.source.sourceContext })) {
                    throw Object.assign(new Error('Workspace target cleanup authority is unavailable'), { code: 'peer_unavailable' });
                }
                return await this.callWorkspaceSyncPhysicalMachineRpc({ ...input, physicalEndpoint,
                    originalMachineId: this.machine.id, accountServerId: input.routing.accountServerId,
                    requireCurrentAdmission: false, routing: { workspaceSyncSourceWriterTargetRouting } });
            }
            const admittedContext = projectWorkspaceSyncPhysicalContextFromActionContext(input.context);
            const workspaceSyncTargetRouting = WorkspaceSyncTargetRoutingV1Schema.parse({ ...input.routing,
                targetContext: { ...workspaceSyncSourceWriterTargetRouting.source.sourceContext,
                    machineAdmission: admittedContext.machineAdmission } });
            if (input.method !== readWorkspaceSyncTargetMethod(input.routing.phase)
                || !doesWorkspaceSyncTargetRoutingMatchWriterTarget(workspaceSyncTargetRouting, workspaceSyncSourceWriterTargetRouting)
                || admittedContext.callerAuthority !== workspaceSyncTargetRouting.targetContext.callerAuthority
                || !isDeepStrictEqual(admittedContext.sessionActionOrigin, workspaceSyncTargetRouting.targetContext.sessionActionOrigin)
                || !isDeepStrictEqual(admittedContext.callerInputConstraints, workspaceSyncTargetRouting.targetContext.callerInputConstraints)
                || !doesWorkspaceSyncTargetRequestMatchRouting(input.request, workspaceSyncTargetRouting)) {
                throw Object.assign(new Error('Workspace target authority is unavailable'), { code: 'peer_unavailable' });
            }
            return await this.callWorkspaceSyncPhysicalMachineRpc({ ...input,
                originalMachineId: workspaceSyncTargetRouting.targetMachineId,
                accountServerId: workspaceSyncTargetRouting.accountServerId, requireCurrentAdmission: input.routing.phase !== 'release',
                signedEffectActionId: input.context.callerInputAuthorization?.binding.actionId,
                routing: { workspaceSyncSourceWriterTargetRouting, workspaceSyncTargetRouting } });
        }
        if (input.context.workspaceSyncSourceRouting && input.context.callerInputAuthorization) {
            const installation = readInstallationIdentityIfExistsSync();
            if (!installation) throw Object.assign(new Error('Workspace target authority is unavailable'), { code: 'peer_unavailable' });
            const workspaceSyncSourceWriterTargetRouting = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1,
                source: input.context.workspaceSyncSourceRouting, target: input.routing,
                sourceWriter: { machineId: this.machine.id, installationId: installation.installationId } });
            if (input.method !== readWorkspaceSyncTargetMethod(input.routing.phase)
                || !doesWorkspaceSyncTargetRequestMatchRouting(input.request, { ...input.routing,
                    targetContext: workspaceSyncSourceWriterTargetRouting.source.sourceContext })) {
                throw Object.assign(new Error('Workspace target authority is unavailable'), { code: 'peer_unavailable' });
            }
            // Home never routes a daemon's signed call back to its own socket: a
            // same-Machine TARGET phase is admitted in-process by the ingress owner.
            const admitted = input.routing.targetMachineId === this.machine.id ? admitSameMachineWorkspaceSyncTargetPhase({
                routing: workspaceSyncSourceWriterTargetRouting,
                callerInputAuthorization: isWorkspaceSyncSourceWriterCleanupPhaseV1(input.routing.phase)
                    ? input.callerInputAuthorization : input.context.callerInputAuthorization,
                request: input.request,
                resolvePrivateCapture: admission => this.machineRpcAdmissionBoundary.resolvePrivateWorkspaceSyncTargetExecution?.(admission)
                    ?? { kind: 'no_private_capture' } }) : null;
            if (admitted && !admitted.ok) {
                throw Object.assign(new Error(admitted.error), { code: admitted.errorCode ?? 'peer_unavailable' });
            }
            const result = admitted?.ok
                ? await this.rpcHandlerManager.invokeLocal(input.method, input.request, {
                    ...(input.signal ?? input.context.signal ? { signal: input.signal ?? input.context.signal } : {}),
                    ...(input.context.localActionContext ? { localActionContext: input.context.localActionContext } : {}),
                    admissionResult: { ok: true, ...(admitted.workspaceSyncPrivateExecution
                        ? { workspaceSyncPrivateExecution: admitted.workspaceSyncPrivateExecution } : {}) },
                    rpcContext: { machineAdmission: admitted.machineAdmission,
                        verifyMachineAdmissionCurrent: input.context.verifyMachineAdmissionCurrent,
                        ...(admitted.callerInputAuthorization ? { callerInputAuthorization: admitted.callerInputAuthorization } : {}),
                        callerAuthority: input.context.authority ?? 'account_automation',
                        ...(input.context.callerInputConstraints ? { callerInputConstraints: input.context.callerInputConstraints } : {}),
                        ...(input.context.sessionActionOrigin ? { sessionActionOrigin: input.context.sessionActionOrigin } : {}),
                        ...(input.context.originalActionEnvelope ? { originalActionEnvelope: input.context.originalActionEnvelope } : {}),
                        workspaceSyncSourceWriterTargetRouting } })
                : await this.callWorkspaceSyncPhysicalMachineRpc({ ...input,
                originalMachineId: workspaceSyncSourceWriterTargetRouting.source.sourceMachineId,
                accountServerId: input.routing.accountServerId, requireCurrentAdmission: input.routing.phase !== 'release',
                signedEffectActionId: input.context.callerInputAuthorization.binding.actionId, routing: { workspaceSyncSourceWriterTargetRouting } });
            // Copy and dependency phases return to their owner's result reader unparsed.
            return input.routing.phase === 'preflight' ? HandoffTargetReplacementPreflightResultV1Schema.parse(result)
                : input.routing.phase === 'prepare' ? WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse(result)
                : input.routing.phase === 'release' ? WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse(result) : result;
        }
        const workspaceSyncTargetRouting = WorkspaceSyncTargetRoutingV1Schema.parse({ ...input.routing,
            targetContext: projectWorkspaceSyncPhysicalContextFromActionContext(input.context) });
        if (input.method !== readWorkspaceSyncTargetMethod(workspaceSyncTargetRouting.phase)
            || !doesWorkspaceSyncTargetRequestMatchRouting(input.request, workspaceSyncTargetRouting)) {
            throw Object.assign(new Error('Workspace target authority is unavailable'), { code: 'peer_unavailable' });
        }
        const result = await this.callWorkspaceSyncPhysicalMachineRpc({ ...input,
            originalMachineId: workspaceSyncTargetRouting.targetMachineId, accountServerId: workspaceSyncTargetRouting.accountServerId,
            requireCurrentAdmission: workspaceSyncTargetRouting.phase !== 'release',
            ...(input.context.externalActionExecutionAuthorization
                ? { signedEffectActionId: input.context.externalActionExecutionAuthorization.binding.actionId } : {}),
            routing: { workspaceSyncTargetRouting },
        });
        switch (workspaceSyncTargetRouting.phase) {
            case 'preflight': return HandoffTargetReplacementPreflightResultV1Schema.parse(result);
            case 'prepare': return WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse(result);
            case 'release': return WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse(result);
            case 'inspect': return 'kind' in WorkspaceSyncCommittedCopyInspectV1Schema.parse(input.request)
                ? WorkspaceSyncCommittedCopyPreviewResultV1Schema.parse(result) : WorkspaceSyncCommittedCopyTargetResultV1Schema.parse(result);
            case 'dependencies': return z.array(ProjectWorkerDependencyV1Schema).parse(result);
            case 'remove': return WorkspaceSyncCommittedCopyTargetResultV1Schema.parse(result);
        }
    }

    private async resolveExternalActionEncryption(signal?: AbortSignal,
        authorization?: import('@happier-dev/protocol/actions/externalActionApi').ExternalActionExecutionAuthorizationV1)
        : Promise<Awaited<ReturnType<import('@/daemon/externalActions/executeExternalAction').ResolveExternalActionEncryption>>> {
        if (authorization && authorization.binding.accountId !== authorization.binding.custodianAccountId
            && authorization.binding.target.kind === 'machine') {
            const context = this.machineContentContext;
            const machine = this.machine;
            if (!context.ready || machine.encryptionMode === 'plain' || machine.encryptionVariant !== 'dataKey') return null;
            const origin = await createCurrentMachineExecutionOriginContextResolver({
                serverUrl: this.machineRuntimeServerHttpBaseUrl, resolveCurrentMachineId: () => this.machine.id,
            })(signal);
            return origin && context === this.machineContentContext ? {
                serverIdentityId: origin.serverIdentityId,
                material: { type: 'dataKey', machineKey: machine.encryptionKey },
            } : null;
        }
        return await this.externalActionIngressOwner?.resolveEncryption?.(signal, authorization) ?? null;
    }

    private async readWorkspaceSyncHomeIdentity(input: Readonly<{ effectful: true; requireFreshHome?: boolean; signal?: AbortSignal }>
        | Readonly<{ effectful: false; originalHomeId: string; signal?: AbortSignal }>): Promise<string> {
        const target = await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: this.machineRuntimeServerId }).catch(error => {
            if (!(error instanceof HomeTargetResolutionError) || error.code !== 'profile_missing') throw error;
            return resolveCliHomeTarget({ kind: 'https_url', url: this.machineRuntimeServerHttpBaseUrl });
        });
        if (!input.effectful) {
            // Release has no new feature/Session/native prerequisite. The actual installed socket and
            // receiving Home proof authenticate cleanup against the parent's exact retained operation.
            return target.homeServerIdentityId ?? input.originalHomeId;
        }
        if (input.requireFreshHome === false && target.homeServerIdentityId) return target.homeServerIdentityId;
        const observed = await createCurrentMachineExecutionOriginContextResolver({
            serverUrl: this.machineRuntimeServerHttpBaseUrl,
            resolveCurrentMachineId: () => this.machine.id,
        })(input.signal);
        if (!observed) throw new Error('Current workspace Home identity is unavailable');
        return assertResolvedHomeTargetIdentity(target, observed.serverIdentityId);
    }

    /** This installed target consumes the already Home-admitted root through its registered owner. */
    async callProjectOpen(input: Readonly<{
        input: OpenProjectInputV1;
        context: RpcActionExecutorContext;
        rpcContext: import('@/api/rpc/types').RpcHandlerContext;
    }>): Promise<OpenProjectResultV1> {
        const request = OpenProjectInputV1Schema.parse(input.input);
        const context = input.context;
        const authorization = context.externalActionExecutionAuthorization;
        const requesterAuthorization = input.rpcContext.callerInputAuthorization;
        const admission = context.machineAdmission;
        const envelope = context.originalActionEnvelope;
        const installation = readInstallationIdentityIfExistsSync();
        const socket = this.socket;
        const unavailable = () => Object.assign(new Error('Installed Project root authority is unavailable'), { code: 'peer_unavailable' });
        if (!socket?.connected || !installation || !authorization || !requesterAuthorization || !admission || !envelope
            || requesterAuthorization.token !== authorization.token || !isDeepStrictEqual(requesterAuthorization.binding, authorization.binding)
            || !requesterAuthorization.requesterAccountProjection || !requesterAuthorization.requesterHttpProjection
            || request.machineId !== this.machine.id || authorization.binding.actionId !== 'projects.open'
            || authorization.binding.machineId !== this.machine.id
            || authorization.binding.installationId !== installation.installationId
            || admission.machineId !== this.machine.id || admission.installationId !== installation.installationId
            || admission.actorAccountId !== authorization.binding.accountId
            || admission.custodianAccountId !== readAccountIdFromToken(this.token)
            || configuration.activeServerId !== this.machineRuntimeServerId
            || !isExternalActionAuthorizationBoundToEnvelope(authorization.binding,
                { actionId: 'projects.open', machineId: this.machine.id, envelope })
            || envelope.v === 1 && !sameStrictJsonValue(envelope.input, request)
            || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()) throw unavailable();
        const homeId = await this.readWorkspaceSyncHomeIdentity({ effectful: true, ...(context.signal ? { signal: context.signal } : {}) });
        if (homeId !== authorization.binding.serverIdentityId
            || !await isServerProfileHomeIdentity(this.machineRuntimeServerId, request.serverId)
            || this.socket !== socket || !socket.connected
            || configuration.activeServerId !== this.machineRuntimeServerId
            || readInstallationIdentityIfExistsSync()?.installationId !== installation.installationId) throw unavailable();
        return OpenProjectResultV1Schema.parse(await this.rpcHandlerManager.invokeLocal(RPC_METHODS.PROJECTS_OPEN, request, {
            ...(context.signal ? { signal: context.signal } : {}), localActionContext: context,
            rpcContext: { ...input.rpcContext, originalActionEnvelope: envelope },
        }));
    }

    /** The installed physical target requests only the active SOURCE operation's finite seed. */
    async callWorkspaceSyncSeedExport(input: Readonly<{
        machineId: string;
        request: WorkspaceSyncSeedExportPrepareV1;
        credentials: StoredCredentials;
        context: RpcActionExecutorContext;
        signal?: AbortSignal;
    }>): Promise<unknown> {
        const request = WorkspaceSyncSeedExportPrepareV1Schema.parse(input.request);
        const b = input.context.workspaceSyncSourceWriterTargetRouting;
        const target = input.context.workspaceSyncTargetRouting;
        if (!b || !target
            || request.targetMachineId !== this.machine.id || input.machineId !== b.sourceWriter.machineId) {
            throw Object.assign(new Error('Workspace seed authority is unavailable'), { code: 'peer_unavailable' });
        }
        const workspaceSyncSeedRouting = WorkspaceSyncSeedRoutingV1Schema.parse({ v: 1, sourceWriterTarget: b, target });
        if (!input.context.callerInputAuthorization || !doesWorkspaceSyncSeedRootMatchRouting(
            input.context.callerInputAuthorization, workspaceSyncSeedRouting,
            input.context.workspaceSyncSourceExecution, request.operationId)) {
            throw Object.assign(new Error('Workspace seed authority is unavailable'), { code: 'peer_unavailable' });
        }
        return await this.callWorkspaceSyncPhysicalMachineRpc({ ...input, request,
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
            originalMachineId: b.source.sourceMachineId, accountServerId: b.source.accountServerId,
            requireCurrentAdmission: true, routing: { workspaceSyncSeedRouting } });
    }

    private async callWorkspaceSyncPhysicalMachineRpc(input: Readonly<{
        machineId: string;
        credentials: import('@/persistence').StoredCredentials;
        context: RpcActionExecutorContext;
        request: unknown;
        method: string;
        originalMachineId: string;
        accountServerId: string;
        requireCurrentAdmission: boolean;
        signedEffectActionId?: string;
        physicalEndpoint?: MachineInstallationPublicIdentityV1;
        physicalEndpointInstallationId?: string;
        routing: Readonly<{ workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1 }>
            | Readonly<{ workspaceSyncSeedRouting: WorkspaceSyncSeedRoutingV1 }>
            | Readonly<{ workspaceSyncTargetRouting: WorkspaceSyncTargetRoutingV1 }>
            | Readonly<{ workspaceSyncSourceWriterTargetRouting: WorkspaceSyncSourceWriterTargetRoutingV1;
                workspaceSyncTargetRouting?: WorkspaceSyncTargetRoutingV1 }>;
        signal?: AbortSignal;
    }>): Promise<unknown> {
        const socket = this.socket;
        const admission = input.context.machineAdmission;
        const installation = readInstallationIdentityIfExistsSync();
        const custodianAccountId = readAccountIdFromToken(this.token);
        const forwardWork = input.requireCurrentAdmission;
        const seedRouting = 'workspaceSyncSeedRouting' in input.routing ? input.routing.workspaceSyncSeedRouting : undefined;
        const writerTarget = 'workspaceSyncSourceWriterTargetRouting' in input.routing ? input.routing.workspaceSyncSourceWriterTargetRouting : undefined;
        const targetRouting = 'workspaceSyncTargetRouting' in input.routing ? input.routing.workspaceSyncTargetRouting : undefined;
        const jointTarget = writerTarget && targetRouting;
        const signedAuthorization = writerTarget || seedRouting ? input.context.callerInputAuthorization : input.context.externalActionExecutionAuthorization;
        const originalSourceRouting = 'workspaceSyncSourceRouting' in input.routing ? input.routing.workspaceSyncSourceRouting : undefined;
        const admittedSourceRoot = forwardWork && !writerTarget && originalSourceRouting !== undefined
            && (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE
                || input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN
                || input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN)
            && signedAuthorization !== undefined && input.context.callerInputAuthorization?.token === signedAuthorization.token
            && isDeepStrictEqual(input.context.callerInputAuthorization?.binding, signedAuthorization.binding)
            && doesWorkspaceSyncSourceRootMatchRouting(signedAuthorization, originalSourceRouting);
        const retainedWriterRelease = !forwardWork && writerTarget !== undefined && !targetRouting && writerTarget.target.phase === 'release'
            && input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE && input.physicalEndpoint !== undefined
            && !signedAuthorization && !input.context.externalActionExecutionAuthorization;
        const retainedWriterCopyPhase = !forwardWork && writerTarget !== undefined
            && isWorkspaceSyncSourceWriterCleanupPhaseV1(writerTarget.target.phase) && writerTarget.target.phase !== 'release' && !targetRouting
            && input.method === readWorkspaceSyncTargetMethod(writerTarget.target.phase);
        const signedBinding = signedAuthorization?.binding;
        const admittedWriterSource = forwardWork && writerTarget && !jointTarget && signedBinding
            ? readWorkspaceSyncSourceAdmissionV1(signedBinding, { serverId: writerTarget.source.accountServerId,
                relationshipId: signedBinding.workspaceSyncAdmission?.relationshipId ?? '',
                machineId: writerTarget.source.sourceMachineId }) : null;
        const sourceAlreadyAdmitted = admittedWriterSource !== null
            && isDeepStrictEqual(admittedWriterSource.source, admission);
        // Admission/signing refusals precede dispatch. A failed response binding
        // below explicitly retains uncertainty about effects on the receiver.
        const unavailable = (disposition: RpcRequestDisposition = 'notSent') => markRpcRequestDisposition(Object.assign(
            new Error('Workspace source authority is unavailable'), { code: 'peer_unavailable' }), disposition);
        if (!socket?.connected || !admission || !installation || !custodianAccountId
            || forwardWork && input.context.callerInputAuthorization && !writerTarget && !seedRouting && !admittedSourceRoot
            || forwardWork && writerTarget && !jointTarget && signedBinding
                && isProjectWorkspaceSyncOpenActionV1(signedBinding.actionId) && !sourceAlreadyAdmitted
            || seedRouting && (!forwardWork || input.method !== RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE
                || !signedAuthorization
                || !isDeepStrictEqual(admission, seedRouting.target.targetContext.machineAdmission)
                || !isDeepStrictEqual(input.context.workspaceSyncSourceWriterTargetRouting, seedRouting.sourceWriterTarget)
                || !isDeepStrictEqual(input.context.workspaceSyncTargetRouting, seedRouting.target))
            || writerTarget && (retainedWriterRelease || retainedWriterCopyPhase
                ? writerTarget.sourceWriter.machineId !== this.machine.id || writerTarget.sourceWriter.installationId !== installation.installationId
                    || admission.machineId !== this.machine.id || admission.installationId !== installation.installationId
                    || admission.actorAccountId !== custodianAccountId || admission.role !== 'manage'
                    || input.context.authority !== 'present_user' || input.originalMachineId !== this.machine.id
                : !signedAuthorization || !doesWorkspaceSyncSourceWriterTargetRootMatchRouting(signedAuthorization, writerTarget,
                    jointTarget ? admission : undefined)
                || input.originalMachineId !== admission.machineId
                || (jointTarget
                    ? admission.machineId !== this.machine.id || admission.installationId !== installation.installationId
                        || this.machine.id !== writerTarget.target.targetMachineId
                        || !doesWorkspaceSyncTargetRoutingMatchWriterTarget(targetRouting, writerTarget)
                        || !isDeepStrictEqual(targetRouting.targetContext.machineAdmission, admission)
                    : writerTarget.sourceWriter.machineId !== this.machine.id || writerTarget.sourceWriter.installationId !== installation.installationId
                        || !isDeepStrictEqual(writerTarget.source.sourceContext.machineAdmission, admission)))
            || !writerTarget && !seedRouting && (admission.machineId !== this.machine.id || input.originalMachineId !== this.machine.id
                || admission.installationId !== installation.installationId)
            || !seedRouting && admission.custodianAccountId !== custodianAccountId
            || readAccountIdFromToken(input.credentials.token) !== custodianAccountId
            || configuration.activeServerId !== this.machineRuntimeServerId
            || forwardWork && !sourceAlreadyAdmitted
                && (!input.context.verifyMachineAdmissionCurrent || !await input.context.verifyMachineAdmissionCurrent())) {
            throw unavailable();
        }
        try {
            const homeId = await this.readWorkspaceSyncHomeIdentity(forwardWork
                ? { effectful: true, ...(input.signal ? { signal: input.signal } : {}) }
                : { effectful: false, originalHomeId: input.accountServerId, ...(input.signal ? { signal: input.signal } : {}) });
            if (homeId !== input.accountServerId || configuration.activeServerId !== this.machineRuntimeServerId
                || this.socket !== socket || !socket.connected
                || readInstallationIdentityIfExistsSync()?.installationId !== installation.installationId) throw unavailable();
        } catch { throw unavailable(); }
        if (forwardWork && signedBinding && !writerTarget && !seedRouting && (signedBinding.actionId !== input.signedEffectActionId
            || signedBinding.machineId !== admission.machineId || signedBinding.installationId !== installation.installationId
            || signedBinding.accountId !== admission.actorAccountId || signedBinding.custodianAccountId !== custodianAccountId
            || !input.context.externalActionTarget || !externalActionTargetsEqualV1(signedBinding.target, input.context.externalActionTarget))) {
            throw unavailable();
        }
        if (seedRouting) {
            const packet = input.context.workspaceSyncSourceExecution;
            if (!signedAuthorization) throw unavailable();
            const verified = await readMachineRpcAdmissionCurrent({ context: seedRouting.sourceWriterTarget.source.sourceContext.machineAdmission,
                method: `${input.machineId}:${input.method}`, workspaceSyncSeedRouting: seedRouting,
                callerInputAuthorization: signedAuthorization, ...(packet ? { workspaceSyncSourceExecution: packet } : {}),
                workspaceSyncSeedReceiver: { machineId: this.machine.id, installationId: installation.installationId,
                    accountId: custodianAccountId, destinationMachineId: input.machineId },
                privateKey: installation.privateKey, daemonToken: this.token, serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl,
                ...(input.signal ? { signal: input.signal } : {}) });
            const destination = verified?.destinationInstallation;
            if (!destination || destination.machineId !== seedRouting.sourceWriterTarget.sourceWriter.machineId
                || destination.machineId !== input.machineId
                || destination.installationId !== seedRouting.sourceWriterTarget.sourceWriter.installationId
                || this.socket !== socket || !socket.connected || configuration.activeServerId !== this.machineRuntimeServerId
                || readInstallationIdentityIfExistsSync()?.installationId !== installation.installationId) throw unavailable();
            return readMachineActionRpcResult(await callSocketRpc({ socket, target: { kind: 'machine', id: input.machineId }, method: input.method,
                params: input.request, content: createWorkspaceSyncTargetContent({ destination, method: `${input.machineId}:${input.method}`, routing: seedRouting }),
                workspaceSyncSeedRouting: seedRouting, ...(packet ? { workspaceSyncSourceExecution: packet } : {}), timeoutMs: null,
                createExternalActionExecution: wire => {
                    const execution = createExternalActionMachineRpcExecution({ context: { ...input.context,
                        externalActionExecutionAuthorization: signedAuthorization, externalActionTarget: signedAuthorization.binding.target },
                        effectActionId: signedAuthorization.binding.actionId, installationId: installation.installationId,
                        method: wire.method, requestId: wire.requestId, params: wire.params,
                        workspaceSyncSeedRouting: seedRouting, privateKey: installation.privateKey });
                    if (!execution) throw unavailable();
                    return execution;
                }, ...(input.signal ? { signal: input.signal } : {}) }));
        }
        if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN
            || input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN) {
            if (!admittedSourceRoot || !originalSourceRouting?.sourceContext || !signedAuthorization) throw unavailable();
            const verified = await readMachineRpcAdmissionCurrent({ context: originalSourceRouting.sourceContext.machineAdmission,
                method: `${input.machineId}:${input.method}`, workspaceSyncSourceRouting: originalSourceRouting,
                callerInputAuthorization: signedAuthorization, workspaceSyncSourceReceiver: {
                    machineId: this.machine.id, installationId: installation.installationId,
                    accountId: custodianAccountId, destinationMachineId: input.machineId },
                privateKey: installation.privateKey, daemonToken: this.token, serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl,
                ...(input.signal ? { signal: input.signal } : {}) });
            const destination = verified?.destinationInstallation;
            if (!destination || destination.machineId !== input.machineId
                || input.physicalEndpointInstallationId && destination.installationId !== input.physicalEndpointInstallationId
                || this.socket !== socket || !socket.connected || configuration.activeServerId !== this.machineRuntimeServerId
                || readInstallationIdentityIfExistsSync()?.installationId !== installation.installationId) throw unavailable();
            const forwardedAuthorization = input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN
                ? await signedAuthorization.requesterAccountProjection?.sealRequesterAccountContext?.({ authorization: signedAuthorization,
                    purpose: { kind: 'workspace_sync_prepare', controller: { machineId: destination.machineId,
                        installationId: destination.installationId }, request: WorkspaceSyncPrepareBetweenRequestV1Schema.parse(input.request) },
                    installationPublicKey: decodeBase64(destination.installationPublicKey, 'base64url') })
                : signedAuthorization;
            if (!forwardedAuthorization || !await input.context.verifyMachineAdmissionCurrent?.()) throw unavailable();
            return readMachineActionRpcResult(await callSocketRpc({ socket, target: { kind: 'machine', id: input.machineId }, method: input.method,
                params: input.request, content: createWorkspaceSyncTargetContent({ destination,
                    method: `${input.machineId}:${input.method}`, routing: originalSourceRouting }),
                workspaceSyncSourceRouting: originalSourceRouting, timeoutMs: null,
                createExternalActionExecution: wire => {
                    const execution = createExternalActionMachineRpcExecution({ context: { ...input.context,
                        externalActionExecutionAuthorization: forwardedAuthorization }, effectActionId: signedAuthorization.binding.actionId,
                        installationId: installation.installationId, method: wire.method, requestId: wire.requestId, params: wire.params,
                        workspaceSyncSourceRouting: originalSourceRouting, privateKey: installation.privateKey });
                    if (!execution) throw unavailable();
                    return execution;
                }, ...(input.signal ? { signal: input.signal } : {}) }));
        }
        if (writerTarget) {
            const projectSourceExecution = forwardWork && signedAuthorization?.binding.actionId === 'projects.open'
                ? input.context.workspaceSyncSourceExecution : undefined;
            if (forwardWork && signedAuthorization?.binding.actionId === 'projects.open' && !projectSourceExecution) throw unavailable();
            // Key discovery is an effectful first-hop purpose. Cleanup already
            // holds its Home-witnessed recipient; the current installed source
            // socket and the recipient's signed Home proof authenticate release.
            const verified = retainedWriterRelease ? null : await readMachineRpcAdmissionCurrent({ context: admission,
                method: `${input.machineId}:${input.method}`, workspaceSyncSourceWriterTargetRouting: writerTarget,
                ...(signedAuthorization ? { callerInputAuthorization: signedAuthorization } : {}),
                ...(projectSourceExecution ? { workspaceSyncSourceExecution: projectSourceExecution } : {}),
                ...(jointTarget ? { workspaceSyncTargetRouting: targetRouting,
                    workspaceSyncTargetReceiver: { machineId: this.machine.id, installationId: installation.installationId,
                        destinationMachineId: input.machineId } }
                    : { workspaceSyncSourceWriterTargetReceiver: { machineId: this.machine.id, installationId: installation.installationId,
                        accountId: custodianAccountId, destinationMachineId: input.machineId } }),
                privateKey: installation.privateKey, daemonToken: this.token, serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl,
                ...(input.signal ? { signal: input.signal } : {}) });
            const destination = retainedWriterRelease ? input.physicalEndpoint : verified?.destinationInstallation;
            if (!retainedWriterRelease && !verified || !destination || destination.machineId !== input.machineId
                || !retainedWriterRelease && !retainedWriterCopyPhase && input.machineId === writerTarget.target.targetMachineId
                    && !isWorkspaceSyncRelationshipWriteActionId(signedAuthorization?.binding.actionId)
                    && destination.installationId !== (signedAuthorization?.binding.actionId === 'projects.open'
                        ? signedAuthorization.binding.installationId : signedAuthorization?.binding.handoffAdmission?.targetInstallationId)
                || configuration.activeServerId !== this.machineRuntimeServerId || this.socket !== socket || !socket.connected
                || readInstallationIdentityIfExistsSync()?.installationId !== installation.installationId) throw unavailable();
            const content = createWorkspaceSyncTargetContent({ destination, method: `${input.machineId}:${input.method}`, routing: writerTarget });
            const result = readMachineActionRpcResult(await callSocketRpc({ socket, target: { kind: 'machine', id: input.machineId }, method: input.method,
                params: input.request, content, workspaceSyncSourceWriterTargetRouting: writerTarget,
                ...(writerTarget.target.phase === 'remove' && input.context.localActionContext
                    ? { onContinuation: createWorkspaceSyncSourceOperationContinuation(input.context.localActionContext), waitForResultOnCancel: true } : {}),
                ...(projectSourceExecution ? { workspaceSyncSourceExecution: projectSourceExecution } : {}),
                ...(jointTarget ? { workspaceSyncTargetRouting: targetRouting } : {}), timeoutMs: null,
                ...((forwardWork || retainedWriterCopyPhase) && signedAuthorization ? { createExternalActionExecution: wire => {
                    const execution = createExternalActionMachineRpcExecution({ context: { ...input.context,
                        externalActionExecutionAuthorization: signedAuthorization, externalActionTarget: signedAuthorization.binding.target },
                        effectActionId: signedAuthorization.binding.actionId, installationId: installation.installationId,
                        method: wire.method, requestId: wire.requestId, params: wire.params,
                        workspaceSyncSourceWriterTargetRouting: writerTarget, privateKey: installation.privateKey });
                    if (!execution) throw unavailable();
                    return execution;
                } } : {}), ...(input.signal ? { signal: input.signal } : {}) }));
            if (writerTarget.target.phase === 'release') return WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse(result);
            if (writerTarget.target.phase === 'dependencies') return z.array(ProjectWorkerDependencyV1Schema).parse(result);
            if (writerTarget.target.phase === 'remove') return WorkspaceSyncCommittedCopyTargetResultV1Schema.parse(result);
            if (writerTarget.target.phase === 'inspect') return 'kind' in WorkspaceSyncCommittedCopyInspectV1Schema.parse(input.request)
                ? WorkspaceSyncCommittedCopyPreviewResultV1Schema.parse(result) : WorkspaceSyncCommittedCopyTargetResultV1Schema.parse(result);
            const parsed = writerTarget.target.phase === 'preflight'
                ? HandoffTargetReplacementPreflightResultV1Schema.parse(result)
                : WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse(result);
            // P1's first-hop witness names D. It supplies the physical endpoint
            // only when D owns the admitted workspace; a bound D must retain
            // its independently verified P2 result instead.
            if (!jointTarget && parsed.targetWorkspace?.machineId !== destination.machineId) return parsed;
            if (parsed.physicalEndpoint && !isDeepStrictEqual(parsed.physicalEndpoint, destination)) throw unavailable('outcomeUnknown');
            return { ...parsed, physicalEndpoint: destination };
        }
        let content: SocketRpcContent;
        if (input.physicalEndpoint) {
            const destination = MachineInstallationPublicIdentityV1Schema.parse(input.physicalEndpoint);
            const routing = 'workspaceSyncSourceRouting' in input.routing ? input.routing.workspaceSyncSourceRouting
                : 'workspaceSyncTargetRouting' in input.routing ? input.routing.workspaceSyncTargetRouting : null;
            if (!routing || destination.machineId !== input.machineId
                || input.physicalEndpointInstallationId && destination.installationId !== input.physicalEndpointInstallationId) throw unavailable();
            // This public identity is retained by the existing prepared operation.
            // Its codec supplies confidentiality, never authority: Home verifies the
            // exact logical child route at the receiving installed controller.
            content = createWorkspaceSyncTargetContent({ destination, method: `${input.machineId}:${input.method}`, routing });
        } else {
            const { ApiClient } = await import('./api');
            const parent = await runWithServerHttpBaseUrl(this.machineRuntimeServerHttpBaseUrl, async () =>
                await (await ApiClient.create(input.credentials)).getMachine(input.machineId,
                    input.signal ? { signal: input.signal } : undefined));
            if (!parent || this.socket !== socket || !socket.connected
                || readInstallationIdentityIfExistsSync()?.installationId !== installation.installationId) throw unavailable();
            const codec = createMachineContentCodec(parent);
            content = codec.mode === 'plain' ? { mode: 'plain' } : { mode: 'e2ee', cipher: {
                encryptRaw: async value => codec.encodeRpc(value), decryptRaw: async value => codec.decodeRpc(value),
            } };
        }
        return readMachineActionRpcResult(await callSocketRpc({ socket,
            target: { kind: 'machine', id: input.machineId }, method: input.method,
            params: input.request, content, ...input.routing, timeoutMs: null,
            ...(input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_REMOVE && input.context.localActionContext
                ? { onContinuation: createWorkspaceSyncSourceOperationContinuation(input.context.localActionContext), waitForResultOnCancel: true } : {}),
            // Forward work exercises the original signed credential. Cleanup releases retained custody
            // under the current installed child's socket and exact captured context, even after borrower revocation.
            ...(forwardWork && signedAuthorization ? { createExternalActionExecution: (wire) => {
                const execution = createExternalActionMachineRpcExecution({ context: input.context,
                    effectActionId: input.signedEffectActionId ?? signedAuthorization.binding.actionId, installationId: installation.installationId,
                    method: wire.method, requestId: wire.requestId, params: wire.params, privateKey: installation.privateKey });
                if (!execution) throw unavailable();
                return execution;
            } } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
        }));
    }

    private dispatchUpdate(update: Update): boolean {
        let handled = false;
        for (const listener of this.updateListeners) {
            try {
                if (listener(update) === true) {
                    handled = true;
                }
            } catch (error) {
                logger.warn('[API MACHINE] Update listener threw (ignored)', {
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return handled;
    }

    /** The same trusted publisher for reviewed bodies and accepted Workflow returns after runner exit. */
    async postAgentDiscussionMessage(
        publication: DiscussionAgentPostPublicationV1 | DiscussionWorkflowPostPublicationV1,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<DiscussionAgentPostResponseV1> {
        options?.signal?.throwIfAborted();
        const socket = this.socket;
        if (!socket?.connected || this.projectionSchedulingClosed) {
            return { v: 1 as const, ok: false as const, error: 'discussions_unavailable' as const };
        }
        const operation = 'producer' in publication ? 'workflow_result'
            : !publication.draftReview && publication.terminalReturn && publication.replyReturn?.workflow ? 'terminal_return' : 'approved_replay';
        const request = DiscussionMachinePublicationV2Schema.safeParse({
            v: operation === 'terminal_return' ? 2 : 1, operation,
            machineId: this.machine.id, publication,
        });
        if (!request.success) return { v: 1 as const, ok: false as const, error: 'discussion_machine_publication_invalid' as const };
        const raw = await emitSocketWithAck({ socket, event: DISCUSSION_AGENT_POST_EVENT_V1,
            payload: request.data, timeoutMs: null, ...(options?.signal ? { signal: options.signal } : {}) });
        const result = DiscussionAgentApprovedReplayResponseV1Schema.parse(raw);
        if (!result.ok && result.error === 'outcome_unknown') {
            // The canonical Action owner records uncertainty; it must not be
            // converted into a no-effect refusal or left awaiting a lost ACK.
            throw Object.assign(new Error('outcome_unknown'), { code: 'outcome_unknown' });
        }
        if (result.ok && 'replyReturn' in publication && publication.replyReturn?.workflow
            && !this.projectionSchedulingClosed && this.socket === socket) {
            // Approval replay may finish after the coordinator and its last
            // recovery pass exited. Never await recovery from its own publisher.
            void this.lifecycleDependencies.onWorkflowReplyReturned?.(publication.replyReturn.workflow.runId).catch(error => {
                logger.warn('[API MACHINE] Workflow return recovery failed; pending custody retained', serializeAxiosErrorForLog(error));
            });
        }
        return result;
    }

    async captureMachineSessionTerminal(
        sessionId: string,
    ): Promise<MachineSessionTerminalCaptureResponseV1> {
        if (!this.socket) {
            throw new Error('Machine socket is not connected');
        }
        const raw = await emitSocketWithAck({
            socket: this.socket,
            event: MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1,
            payload: { v: 1, sessionId },
            // Stop owns the lifetime; a slow durable close must not time out
            // independently while the same transport still awaits its outcome.
            timeoutMs: null,
        });
        return MachineSessionTerminalCaptureResponseV1Schema.parse(raw);
    }

    async finalizeMachineSessionTerminal(
        target: Readonly<{ sessionId: string; authority: MachineSessionTerminalAuthorityV1 }>,
    ): Promise<MachineSessionTerminalFinalizeResponseV1> {
        if (!this.socket) {
            throw new Error('Machine socket is not connected');
        }
        const raw = await emitSocketWithAck({
            socket: this.socket,
            event: MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1,
            payload: {
                v: 1,
                sessionId: target.sessionId,
                authority: target.authority,
            },
            timeoutMs: null,
        });
        return MachineSessionTerminalFinalizeResponseV1Schema.parse(raw);
    }

    /**
     * Publishes one complete, content-free exact-target capability projection.
     * A successful response is the server-assigned monotonic projection revision.
     */
    async publishOperationProtocolCapabilities(
        capabilities: MachineOperationProtocolCapabilitiesV1,
    ): Promise<number> {
        const socket = this.socket;
        if (!socket) {
            throw new Error('Machine socket is not connected');
        }
        return await this.publishOperationProtocolCapabilitiesOnSocket(
            socket,
            capabilities,
        );
    }

    async releasePendingResetStart(request: Readonly<{ sessionId: string; localId: string; reset: PendingResetStartBindingV1 }>): Promise<void> {
        if (!this.socket) throw new Error('Machine socket is not connected');
        const payload = PendingResetStartReleaseRequestV1Schema.parse({ v: 1, ...request });
        const response = PendingResetStartReleaseResponseV1Schema.parse(await emitSocketWithAck({
            socket: this.socket, event: SESSION_PENDING_RESET_START_RELEASE_EVENT_V1, payload,
        }));
        if (!response.ok) throw Object.assign(new Error(response.reason), { code: response.reason });
    }

    async enqueueSessionPendingByMachine(
        request: SessionPendingEnqueueByMachineRequestV1 | SessionPendingExecutionRunEnqueueByMachineRequestV2,
        options?: Readonly<{
            signal?: AbortSignal;
            timeoutMs?: number;
            callerInputAuthorization?: import('@happier-dev/protocol').ExternalActionExecutionAuthorizationV1;
        }>,
    ): Promise<SessionInputEnqueueResultV1> {
        if (options?.signal?.aborted) {
            return { status: 'rejected', code: 'session_input_cancelled' };
        }
        const socket = this.socket;
        if (!socket) {
            return {
                status: 'rejected',
                code: 'session_input_target_unavailable',
            };
        }
        const parsed = request.v === 2
            ? SessionPendingExecutionRunEnqueueByMachineRequestV2Schema.parse(request)
            : SessionPendingEnqueueByMachineRequestV1Schema.parse(request);
        // Caller-authored network proof is never the producer's signing input.
        const { externalAction: _incomingProof, ...unsignedPayload } = parsed;
        const event = unsignedPayload.v === 2
            ? SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2
            : SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1;
        const authorization = options?.callerInputAuthorization;
        const installation = authorization ? readInstallationIdentityIfExistsSync() : null;
        if (authorization && (!installation || authorization.binding.machineId !== this.machine.id)) {
            return { status: 'rejected', code: 'session_input_unauthorized' };
        }
        const target = { kind: 'session' as const, sessionId: unsignedPayload.sessionId };
        const externalAction = authorization && installation ? {
            v: 1 as const,
            authorization,
            effectActionId: 'session.message.send',
            target,
            installationId: installation.installationId,
            machineSignature: signExternalActionMachineRpcRequestV1({
                authorizationToken: authorization.token, effectActionId: 'session.message.send',
                requesterAccountContext: authorization.requesterAccountContext,
                target, installationId: installation.installationId, event, method: event,
                requestId: authorization.binding.requestId, params: unsignedPayload,
                privateKey: installation.privateKey,
            }),
        } : undefined;
        const payload = { ...unsignedPayload, ...(externalAction ? { externalAction } : {}) };
        const timeoutMs = options?.timeoutMs ?? resolveSessionMessageAdmissionTimeoutMs();
        try {
            // Keep the Socket.IO event and payload correlated for each protocol
            // version. Passing their unions through the generic ACK helper loses
            // that relationship and makes the real typed Machine socket invalid.
            const raw = payload.v === 2
                ? await emitSocketWithAck({
                    socket,
                    event: SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2,
                    payload,
                    timeoutMs,
                    ...(options?.signal ? { signal: options.signal } : {}),
                })
                : await emitSocketWithAck({
                    socket,
                    event: SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1,
                    payload,
                    timeoutMs,
                    ...(options?.signal ? { signal: options.signal } : {}),
                });
            const parsed = payload.v === 2
                ? SessionPendingExecutionRunEnqueueByMachineResponseV2Schema.safeParse(raw)
                : SessionPendingEnqueueByMachineResponseV1Schema.safeParse(raw);
            return parsed.success
                ? parsed.data.result
                : {
                    status: 'outcomeUnknown',
                    localId: request.localId,
                    code: 'machine_admission_response_invalid',
                };
        } catch (error) {
            if (error instanceof SocketAckError && error.code === 'socket_not_connected') {
                return { status: 'rejected', code: 'session_input_target_unavailable' };
            }
            const code = error instanceof SocketAckAbortError
                ? 'machine_admission_cancelled_after_emit'
                : error instanceof SocketAckError && error.code === 'socket_ack_timeout'
                    ? 'machine_socket_ack_timeout'
                    : 'machine_socket_disconnected';
            return { status: 'outcomeUnknown', localId: request.localId, code };
        }
    }

    /**
     * Session-owned Automation ingress. The daemon sends only the frozen Run
     * correspondence and opaque plain V2 request to its authenticated server;
     * the server rederives authority and chooses direct/local versus exact
     * cross-machine dispatch. Automation never receives that routing choice.
     */
    async dispatchSessionServerStart(
        request: SessionServerStartIngressRequestV1,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<SessionServerStartDispatchResultV1> {
        if (options?.signal?.aborted) {
            return { type: 'error', code: 'cancelled', retryable: true };
        }
        const socket = this.socket;
        if (!socket) {
            return { type: 'error', code: 'machine_offline', retryable: true };
        }
        const payload = SessionServerStartIngressRequestV1Schema.safeParse(request);
        if (!payload.success) {
            return { type: 'error', code: 'invalid_input', retryable: false };
        }

        try {
            const raw = await emitSocketWithAck({
                socket,
                event: SESSION_SERVER_START_INGRESS_EVENT_V1,
                payload: payload.data,
                ...(options?.signal ? { signal: options.signal } : {}),
            });
            const response = SessionServerStartIngressResponseV1Schema.safeParse(raw);
            if (!response.success) {
                // The server may have already submitted the effect, so only the
                // canonical creation key can resolve a malformed acknowledgement.
                return { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' };
            }
            if (response.data.kind === 'result') return response.data.result;

            const local = await this.rpcHandlerManager.invokeLocal(
                SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
                response.data.dispatch,
                options?.signal ? { signal: options.signal } : undefined,
            );
            const result = SessionServerStartDispatchResultV1Schema.safeParse(local);
            return result.success
                ? result.data
                : { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' };
        } catch (error) {
            if (error instanceof SocketAckError && error.code === 'socket_not_connected') {
                return { type: 'error', code: 'machine_offline', retryable: true };
            }
            // A socket acknowledgement can be lost after the server receives
            // the ingress. Retrying the same immutable Session creation key is
            // the sole rejoin path; do not fabricate a local fallback.
            if (error instanceof SocketAckAbortError || error instanceof SocketAckError) {
                return { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' };
            }
            return options?.signal?.aborted
                ? { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' }
                : { type: 'error', code: 'spawn_failed', retryable: true };
        }
    }

    private async publishOperationProtocolCapabilitiesOnSocket(
        socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>,
        capabilities: MachineOperationProtocolCapabilitiesV1,
    ): Promise<number> {
        const revision = await publishMachineOperationProtocolCapabilitiesOnSocket({
            socket,
            machineId: this.machine.id,
            capabilities,
        });
        return revision;
    }

    /**
     * Machine-control methods that must be registered before the Machine reports running. Methods
     * owned by an inactive Machine role are refused by design (`machine_role_inactive`), not missing.
     */
    private requiredMachineControlRpcMethods(): readonly string[] {
        // Managed enrollment consumes this same readiness fact before its Setup
        // children. Installed Setup receivers must be acknowledged, including on
        // server-role Machines whose Session creation namespaces are inactive.
        const setupMethods = [
            ...MACHINE_ADMIN_ACCESS_ACTION_IDS, ...MACHINE_ROLES_ACTION_IDS, ...MACHINE_ISOLATION_ACTION_IDS,
            ...MACHINE_AGENT_ISOLATION_ACTION_IDS, ...MACHINE_REACHABILITY_ACTION_IDS_V1, ...MACHINE_GUARD_ACTION_IDS,
            MACHINE_SETUP_PLAN_ACTION_ID_V1, MACHINE_SETUP_APPLY_ACTION_ID_V1,
        ].filter(method => this.rpcHandlerManager.hasHandler(method));
        return [...REQUIRED_MACHINE_CONTROL_RPC_METHODS, ...setupMethods]
            .filter(method => !this.rpcHandlerManager.inactiveRoleIdFor(method));
    }

    private currentMachineOperationProtocolCapabilities(
        includeSessionCapabilities = true,
    ): MachineOperationProtocolCapabilitiesV1 | null {
        const {
            externalActionExecutionAuthorization: _externalActionExecutionAuthorization,
            sessionSpawn,
            ...sessionCapabilities
        } = CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1;
        const capabilities: MachineOperationProtocolCapabilitiesV1 = {
            ...(this.sessionMessageReplyRecoverySupported ? { sessionMessageReply: { protocolVersions: [1] } } : {}),
            ...(includeSessionCapabilities && this.sessionSpawnV1OutcomeRequired
                ? {
                    ...sessionCapabilities,
                    // A Machine whose sessions role is off starts no Session, so placement never picks it.
                    ...(this.rpcHandlerManager.inactiveRoleIdFor(RPC_METHODS.SPAWN_HAPPY_SESSION) ? {} : { sessionSpawn }),
                }
                : {}),
            ...(this.externalActionExecutionAuthorizationV1OutcomeRequired
                ? { externalActionExecutionAuthorization: { protocolVersions: [1] } }
                : {}),
            ...(this.currentIrohMachineEndpoint
                ? {
                    irohMachineEndpoint: {
                        protocolVersions: [1],
                        ...this.currentIrohMachineEndpoint,
                    },
                }
                : {}),
            ...(this.localServicePreviewNativeAccessLive
                ? { localServicePreviewNativeAccess: { protocolVersions: [1] } }
                : {}),
            ...(this.projectFiniteExecutionLive
                ? { projectFiniteExecution: { protocolVersions: [1] } }
                : {}),
            ...(this.providerBrokerIngressAdvertised
                ? { providerBrokerIngress: { protocolVersions: [1] } }
                : {}),
        };
        return Object.keys(capabilities).length > 0 ? capabilities : null;
    }

    private async resolveCurrentMachineOperationProtocolCapabilitiesForPublication(
        includeSessionCapabilities = true,
        currentServerFeatures?: FeaturesResponse,
    ): Promise<MachineOperationProtocolCapabilitiesV1 | null> {
        // Resolve Home support before sampling the live handlers. A delayed
        // feature read must not later replace a newly admitted reply target
        // with the capability snapshot from before that target became ready.
        const snapshot = currentServerFeatures
            ? { status: 'ready' as const, features: currentServerFeatures }
            : await this.lifecycleDependencies.resolveServerFeaturesSnapshot?.();
        let capabilities = this.currentMachineOperationProtocolCapabilities(includeSessionCapabilities);

        if (capabilities?.sessionMessageReply && !await this.sessionMessageReplyRecovery?.isCurrent?.()) {
            const { sessionMessageReply: _retiredReply, ...currentCapabilities } = capabilities;
            capabilities = Object.keys(currentCapabilities).length > 0 ? currentCapabilities : null;
        }

        // The Home's resolved server feature bit is both product enablement and
        // proof that its strict Machine projection accepts this new leaf. Older,
        // malformed, disabled, or dependency-disabled Homes therefore keep the
        // handler installed locally but receive no incompatible advertisement.
        // The common requester guards enforce or refuse independently of native
        // readiness. Publish only to a Home that accepts this protocol leaf.
        if (snapshot?.status === 'ready'
            && snapshot.features.capabilities?.machines?.requesterExecutionIsolation?.protocolVersions.includes(1) === true) {
            capabilities = { ...capabilities, requesterExecutionIsolation: { protocolVersions: [1] } };
        }
        if (this.connectedAccountDaemonRuntime
            && snapshot?.status === 'ready'
            && snapshot.features.capabilities.machines.connectedAccountAuthentication?.protocolVersions.includes(1) === true) {
            capabilities = { ...capabilities, connectedAccountAuthentication: { protocolVersions: [1] } };
        }
        // SCM handlers are installed by this client. Publish their paging support
        // only when Home accepts the leaf in its strict complete projection.
        if (snapshot?.status === 'ready'
            && snapshot.features.capabilities.machines.scmComparisonIndexPaging?.protocolVersions.includes(1) === true) {
            capabilities = { ...capabilities, scmComparisonIndexPaging: { protocolVersions: [1] } };
        }
        if (snapshot?.status === 'ready'
            && snapshot.features.capabilities.machines.scmStatusSnapshotPaging?.protocolVersions.includes(1) === true) {
            capabilities = { ...capabilities, scmStatusSnapshotPaging: { protocolVersions: [1] } };
        }
        if (!capabilities) return null;
        const personalBroker = this.providerBrokerAccountConnectionIngressLive
            && snapshot?.status === 'ready'
            && readServerEnabledBit(snapshot.features, 'providers') === true
            && snapshot.features.capabilities.providerBroker?.protocolVersions.includes(2) === true;
        const actionBroker = this.providerBrokerActionOperationIngressLive
            && snapshot?.status === 'ready'
            && readServerEnabledBit(snapshot.features, 'teams.credentialResources') === true
            && snapshot.features.capabilities.providerBroker?.actionProtocolVersions?.includes(3) === true;
        if (capabilities.providerBrokerIngress && (personalBroker || actionBroker)) {
            capabilities = { ...capabilities, providerBrokerIngress: { protocolVersions: actionBroker
                ? personalBroker ? [1, 2, 3] : [1, 3] : [1, 2] } };
        }
        if (
            capabilities.providerBrokerIngress
            && (
                snapshot?.status !== 'ready'
                || (readServerEnabledBit(snapshot.features, 'teams.credentialResources') !== true && !personalBroker)
            )
        ) {
            const { providerBrokerIngress: _providerBrokerIngress, ...compatibleCapabilities } = capabilities;
            capabilities = Object.keys(compatibleCapabilities).length > 0
                ? compatibleCapabilities
                : null;
        }
        if (!capabilities) return null;
        if (!capabilities?.sessionSpawn) return capabilities;
        // The Home validates complete Machine publications strictly. Older Homes
        // retain the ordinary spawn epochs instead of receiving an unknown one.
        if (snapshot?.status === 'ready'
            && snapshot.features.capabilities.machines?.sessionSpawn?.protocolVersions.some(version => version === 4) === true) {
            capabilities = { ...capabilities, sessionSpawn: { protocolVersions: [1, 2, 3, 4] } };
        } else if (snapshot?.status === 'ready'
            && snapshot.features.capabilities.machines?.sessionSpawn?.protocolVersions.some(version => version === 3) === true) {
            capabilities = { ...capabilities, sessionSpawn: { protocolVersions: [1, 2, 3] } };
        }

        // Reuse the snapshot already resolved through daemon composition's
        // feature-refresh owner. Absence is unknown; do not issue an independent
        // request or advertise a target route an older server cannot own.
        const sessionInputAdmission = resolveMachineSessionInputAdmissionCapability(snapshot);
        const sessionPendingResetStart = resolveMachinePendingResetStartCapability(snapshot, this.sessionPendingResetStartInstalled);
        const requirements = snapshot?.status === 'ready'
            ? snapshot.features.capabilities.accountStoredContentCompatibility
            : undefined;
        const negotiatedCapabilities = {
            ...capabilities,
            sessionInputAdmission,
            ...(sessionPendingResetStart ? { sessionPendingResetStart } : {}),
        };
        if (
            !requirements
            || requirements.currentProtocolVersion
                < ACCOUNT_STORED_CONTENT_SESSION_SPAWN_PLACEMENT_ORIGIN_PROTOCOL_VERSION
        ) return negotiatedCapabilities;

        return {
            ...negotiatedCapabilities,
            sessionSpawnPlacementOrigin: { protocolVersions: [1] },
            sessionSpawnAuthoringOrigin: { protocolVersions: [1] },
        };
    }

    private async synchronizeIrohMachineEndpointAuthority(
        state: DaemonState | null,
        withdrewPersistedEndpoint = false,
    ): Promise<void> {
        const nextEndpoint = state?.peerMediation?.iroh?.endpoint ?? null;
        if (isDeepStrictEqual(nextEndpoint, this.currentIrohMachineEndpoint)
            && !((withdrewPersistedEndpoint || this.pendingIrohEndpointCapabilityWithdrawal)
                && nextEndpoint === null)) return;
        const previousEndpoint = this.currentIrohMachineEndpoint;
        this.currentIrohMachineEndpoint = nextEndpoint;

        const socket = this.socket;
        if (!socket || socket.connected !== true) return;
        // The server stores this as a replace-all projection. Endpoint changes
        // therefore have to republish the complete capability set; publishing
        // only the endpoint while readiness is still being established would
        // silently withdraw session and plugin capabilities.
        const capabilities = await this.resolveCurrentMachineOperationProtocolCapabilitiesForPublication() ?? {};
        try {
            await this.publishOperationProtocolCapabilitiesOnSocket(socket, capabilities);
        } catch (error) {
            this.currentIrohMachineEndpoint = previousEndpoint;
            throw error;
        }
        if (this.socket === socket && socket.connected === true) {
            this.pendingIrohEndpointCapabilityWithdrawal = false;
            this.advertisedOperationProtocolCapabilitiesGeneration = this.activeTransportGeneration;
        }
    }

    private discardUnverifiedIrohEndpoint(state: DaemonState | null): DaemonState | null {
        const peerMediation = state?.peerMediation;
        if (!state || !peerMediation?.iroh
            || isDeepStrictEqual(peerMediation.iroh.endpoint, this.currentIrohMachineEndpoint)) return state;
        // A stored endpoint is not proof of this process's live acceptor. This
        // also applies when a version-mismatch reloads older server state.
        this.pendingPersistedIrohEndpointWithdrawal = true;
        this.pendingIrohEndpointCapabilityWithdrawal = true;
        return { ...state, peerMediation: { ...peerMediation, iroh: undefined } };
    }

    /**
     * Publishes or withdraws the broker application capability. The composition
     * root calls this only when the exact provider-broker application handler
     * is installed; absence keeps the leaf withdrawn so every Machine stays
     * ineligible as a broker (fail closed).
     */
    async setProviderBrokerIngressLive(live: boolean, accountConnectionIngress = false, actionOperationIngress = false): Promise<void> {
        if (this.providerBrokerIngressAdvertised === live && this.providerBrokerAccountConnectionIngressLive === (live && accountConnectionIngress)
            && this.providerBrokerActionOperationIngressLive === (live && actionOperationIngress)) return;
        const previous = this.providerBrokerIngressAdvertised;
        const previousPersonal = this.providerBrokerAccountConnectionIngressLive;
        const previousAction = this.providerBrokerActionOperationIngressLive;
        this.providerBrokerIngressAdvertised = live;
        this.providerBrokerAccountConnectionIngressLive = live && accountConnectionIngress;
        this.providerBrokerActionOperationIngressLive = live && actionOperationIngress;
        try {
            await this.refreshProviderBrokerIngressAdvertisement();
        } catch (error) {
            this.providerBrokerIngressAdvertised = previous;
            this.providerBrokerAccountConnectionIngressLive = previousPersonal;
            this.providerBrokerActionOperationIngressLive = previousAction;
            throw error;
        }
    }

    /** Re-evaluates Home support after the canonical feature snapshot changes. */
    async refreshProviderBrokerIngressAdvertisement(currentServerFeatures?: FeaturesResponse): Promise<void> {
        await this.refreshOperationProtocolCapabilitiesAdvertisement(currentServerFeatures);
    }

    /** Composition supplies the live native acceptor plus preview application fact. */
    async setLocalServicePreviewNativeAccessLive(live: boolean): Promise<void> {
        // Local adapter availability remains truthful even if Home acknowledgement
        // fails; reconnect publishes this same complete projection again.
        this.localServicePreviewNativeAccessLive = live;
        await this.refreshOperationProtocolCapabilitiesAdvertisement();
    }

    /** The finite ingress lifetime supplies this fact; Home publication ACK proves support. */
    async setProjectFiniteExecutionLive(live: boolean): Promise<void> {
        this.projectFiniteExecutionLive = live;
        await this.refreshOperationProtocolCapabilitiesAdvertisement();
    }

    isProjectFiniteExecutionLive(): boolean {
        return this.projectFiniteExecutionLive;
    }

    private async refreshOperationProtocolCapabilitiesAdvertisement(currentServerFeatures?: FeaturesResponse): Promise<void> {
        const socket = this.socket;
        if (!socket || socket.connected !== true) return;
        // Replace-all projection: republish the complete capability set so the
        // readiness changes never withdraw unrelated session or endpoint capabilities.
        const capabilities = await this.resolveCurrentMachineOperationProtocolCapabilitiesForPublication(
            true,
            currentServerFeatures,
        ) ?? {};
        await this.publishOperationProtocolCapabilitiesOnSocket(socket, capabilities);
        if (this.socket === socket && socket.connected === true) {
            this.advertisedOperationProtocolCapabilitiesGeneration = this.activeTransportGeneration;
        }
    }

    async updateMachineMetadata(
        handler: (metadata: MachineMetadata | null) => MachineMetadata,
        options?: Readonly<{ agentInventoryObservation?: MachineAgentInventoryObservation }>,
    ): Promise<MachinePublicationOutcome> {
        if (this.shouldSuppressMachinePublication()) {
            return 'suppressed';
        }
        this.readOwnerEnvelopeForWrite();
        const outcome = await publishMachineMetadataUpdate({
            getMachine: () => this.machine,
            shouldSuppress: () => this.shouldSuppressMachinePublication(),
            prepareWrite: async () => {
                if (!this.socket) throw new Error('Machine socket is not connected');
                if (!this.machineContentReady) {
                    await this.refreshMachineFromServer();
                    if (!this.machineContentReady) throw new Error('Machine content key is unavailable');
                }
            },
            publishAttempt: input => this.publishMachineMetadataAttempt(input),
        }, currentMetadata => {
            let candidate = handler(currentMetadata);
            if (options?.agentInventoryObservation) candidate = { ...candidate,
                agentInventory: this.projectAgentInventoryPublication(options.agentInventoryObservation, currentMetadata?.agentInventory) };
            return candidate;
        });
        if (outcome === 'published') logger.debug('[API MACHINE] Metadata updated successfully');
        return outcome;
    }

    getMachineMetadataSnapshot(): MachineMetadataFieldReadV1 {
        return readOpenedMachineMetadataSnapshot(this.machine, this.machineContentReady);
    }

    getMachineSetupObservationSnapshot(): import('@happier-dev/protocol').MachineSetupObservationV1 | undefined {
        return this.machine.daemonState?.setup;
    }

    /** One publication consumes the settled Apply; current reads never rerun native effects. */
    async publishMachineSetupApplied(plans: readonly import('@happier-dev/protocol/machines/setup/machineRecipeV1').MachineSetupEffectPlanV1[]): Promise<MachinePublicationOutcome> {
        return this.updateDaemonState(state => {
            if (!state) throw new Error('Machine daemon state is unavailable');
            return { ...state, setup: projectMachineSetupAppliedObservation(state.setup, this.machine.metadata, plans) };
        });
    }

    /** Setup-native observations are published through the Machine state owner. */
    async publishMachineSetupUpdates(
        updates: NonNullable<import('@happier-dev/protocol').MachineSetupObservationV1['updates']>,
    ): Promise<MachinePublicationOutcome> {
        return this.updateDaemonState(state => {
            if (!state) throw new Error('Machine daemon state is unavailable');
            return { ...state, setup: projectMachineSetupUpdatesObservation(state.setup, this.machine.metadata, updates) };
        });
    }

    /** Native demand produces facts; the existing publisher suppresses equal observations. */
    async refreshMachineSetupUpdates(options: Readonly<{
        signal?: AbortSignal;
        runNative?: (command: import('@happier-dev/cli-common/machineSetup').MachineSetupNativeCommand)
            => Promise<import('@happier-dev/cli-common/machineSetup').MachineSetupNativeCommandResult>;
    }> = {}): Promise<NonNullable<import('@happier-dev/protocol').MachineSetupObservationV1['updates']>> {
        const { observeNativeUpdates, runMachineSetupNativeCommand } = await import('@happier-dev/cli-common/machineSetup');
        const { observation } = await observeNativeUpdates({ run: (executable, args, env) => {
            options.signal?.throwIfAborted();
            return (options.runNative ?? runMachineSetupNativeCommand)({ executable, args,
                ...(env ? { env } : {}), ...(options.signal ? { signal: options.signal } : {}) });
        } });
        await this.publishMachineSetupUpdates(observation);
        return observation;
    }

    getMachineSetupDesiredSnapshot(): ReturnType<typeof getMachineSetupDesiredV1> {
        return getMachineSetupDesiredV1(this.captureMachineMetadataFieldPort());
    }

    /** Setup uses the same captured policy and fresh P10 observer as its routes. */
    captureMachineAdminAccess(): Readonly<Pick<MachineElevationDependencies, 'readPolicy' | 'observe'>> {
        const port = this.captureMachineMetadataFieldPort();
        const routes = this.machineAdminAccessRoutes;
        const unavailable = () => Object.assign(new Error('admin_access_unavailable'), { code: 'admin_access_unavailable' });
        const assertCurrent = async () => {
            if (!routes || this.machineAdminAccessRoutes !== routes || (await port.read()).status !== 'ready') throw unavailable();
        };
        return {
            readPolicy: async () => {
                await assertCurrent();
                const current = await getMachineAdminAccessV1(port);
                if (current.status !== 'ready') throw unavailable();
                return current.policy;
            },
            observe: async () => {
                await assertCurrent();
                const result = await this.inspectMachineAdminAccess(routes!);
                await assertCurrent();
                return result.observation;
            },
        };
    }

    /** Setup preparation and publication share the incumbent captured field port. */
    captureMachineSetupDesired(): Readonly<{
        read(): ReturnType<typeof getMachineSetupDesiredV1>;
        apply(input: Parameters<typeof mutateMachineSetupDesiredV1>[0],
            options?: Parameters<typeof mutateMachineSetupDesiredV1>[2]): ReturnType<typeof mutateMachineSetupDesiredV1>;
    }> {
        const port = this.captureMachineMetadataFieldPort();
        return {
            read: () => getMachineSetupDesiredV1(port),
            apply: (input: Parameters<typeof mutateMachineSetupDesiredV1>[0],
                options?: Parameters<typeof mutateMachineSetupDesiredV1>[2]) => mutateMachineSetupDesiredV1(input, port, options),
        };
    }

    /** One action's read and CAS remain on its receiving transport/content basis. */
    private captureMachineMetadataFieldPort(): MachineMetadataFieldPortV1 {
        const codec = this.machineContentCodec;
        const generation = this.activeTransportGeneration;
        const socket = this.socket;
        const retired = () => {
            if (!this.machineContentReady || this.machineContentCodec !== codec) return { status: 'locked' as const };
            if (this.projectionSchedulingClosed || this.activeTransportGeneration !== generation
                || this.socket !== socket || !socket?.connected) return { status: 'unavailable' as const };
            return null;
        };
        return {
            read: async () => retired() ?? this.getMachineMetadataSnapshot(),
            compareAndSwap: async input => retired() ?? this.compareAndSwapMachineMetadata(input),
        };
    }

    private agentIsolationPublicationFailed = false;

    getAgentIsolationSnapshot(): AgentIsolationSnapshot {
        // Ingress already admitted these blobs. Launch reads only the isolation
        // leaf instead of reparsing unrelated Machine fields on every spawn.
        const metadata: MachineMetadataFieldReadV1 = !this.machineContentReady ? { status: 'locked' }
            : this.machine.metadata === null ? { status: 'unavailable' }
            : { status: 'ready', metadata: this.machine.metadata, metadataVersion: this.machine.metadataVersion };
        return readAgentIsolationSnapshot({ metadata, daemonState: this.machine.daemonState,
            runtimeId: this.ownershipMetadata.runtimeId, platform: process.platform,
            publicationFailed: this.agentIsolationPublicationFailed });
    }

    async publishAgentIsolationStatus(
        status: AgentIsolationSnapshot['status'],
        shouldPublish?: (state: DaemonState) => boolean,
    ): Promise<void> {
        let accepted = false;
        try {
            const outcome = await this.updateDaemonState(state => {
                if (!state) throw new Error('machine_agent_isolation_publication_unavailable');
                accepted = shouldPublish?.(state) ?? true;
                if (!accepted) return state;
                return { ...state, agentIsolation: status };
            });
            if (outcome === 'suppressed') throw new Error('machine_agent_isolation_publication_unavailable');
            if (accepted) this.agentIsolationPublicationFailed = false;
        } catch (error) {
            // Settle public own-status without inventing a successful receipt or
            // changing the last acknowledged CAS basis. A later status write recovers.
            this.agentIsolationPublicationFailed = true;
            throw error;
        }
    }

    async compareAndSwapMachineMetadata(
        input: Parameters<MachineMetadataFieldPortV1['compareAndSwap']>[0],
    ): Promise<Awaited<ReturnType<MachineMetadataFieldPortV1['compareAndSwap']>>> {
        if (this.shouldSuppressMachinePublication() || !this.socket) return { status: 'unavailable' };
        if (!this.machineContentReady) return { status: 'locked' };
        const codec = this.machineContentCodec;
        try { return await this.publishMachineMetadataAttempt(input); }
        catch { return { status: this.machineContentReady && this.machineContentCodec === codec ? 'outcomeUnknown' : 'locked' }; }
    }

    private async publishMachineMetadataAttempt(input: Parameters<MachineMetadataFieldPortV1['compareAndSwap']>[0]) {
        if (!this.socket) throw new Error('Machine socket is not connected');
        const codec = this.machineContentCodec;
        return publishMachineMetadataOnce({
            getMachine: () => this.machine, socket: this.socket, codec, expectedDataEncryptionKey: this.readOwnerEnvelopeForWrite(),
            isContentCurrent: () => this.machineContentReady && this.machineContentCodec === codec,
            retireAndRefreshContent: async () => { this.retireMachineContent(); await this.refreshMachineFromServer(); },
            notifyMetadataChanged: change => this.notifyMachineMetadataChanged(change),
        }, input);
    }

    /** The currently published projection fact; invalidation owns its advancement. */
    getContributionRegistryProjectionRevision(): number {
        return this.machine.daemonState?.contributionRegistryProjectionRevision ?? 0;
    }

    /** Publish daemon-owned facts through the Machine's single in-flight drain. */
    async updateDaemonState(
        handler: (state: DaemonState | null) => DaemonState,
        options?: ApiMachineDaemonStatePublicationOptions,
    ): Promise<MachinePublicationOutcome> {
        if (this.shouldSuppressMachinePublication(options?.allowWhileQuiescing)) {
            return 'suppressed';
        }
        this.readOwnerEnvelopeForWrite();
        return await this.publishDaemonState(handler, options);
    }

    private getDaemonTerminalSessionMutationOutbox(
        sessionId: string,
        isShuttingDown: (() => boolean) | undefined = this.lifecycleDependencies.isDaemonQuiescing,
    ): DaemonSessionClientDurableMutationOutbox {
        const existing = this.daemonTerminalSessionMutationOutboxes.get(sessionId);
        if (existing) return existing;

        const outbox = createDaemonSessionClientDurableMutationOutbox({
            token: this.token,
            sessionId,
            getSocket: () => null,
            getSessionTurnServerContractMode: () => (
                this.getSessionSyncPendingInputServerContractResult()?.mode ?? null
            ),
            requestReconnect: () => undefined,
            ...(isShuttingDown ? { isShuttingDown } : {}),
        });
        this.daemonTerminalSessionMutationOutboxes.set(sessionId, outbox);
        return outbox;
    }

    async enqueueDaemonTerminalExactTurnEnd(mutation: ExactSessionTurnEndMutationV1): Promise<void> {
        await this.getDaemonTerminalSessionMutationOutbox(mutation.sessionId).enqueueExactTurnEnd(mutation);
    }

    async recoverDaemonTerminalSessionMutationJournals(params: Readonly<{
        bindUsageLimitRecoveryJournals: (sessionIds: readonly string[]) => Promise<Readonly<{
            boundSessionIds: readonly string[];
            retainedSessionIds: readonly string[];
        }>>;
        isShuttingDown?: () => boolean;
    }>): Promise<Readonly<{ recoveredSessionIds: readonly string[]; retainedSessionIds: readonly string[] }>> {
        const recoveredSessionIds: string[] = [];
        let retainedSessionIds: readonly string[] = [];
        const isShuttingDown = (): boolean => params.isShuttingDown?.() === true;
        if (isShuttingDown()) {
            return { recoveredSessionIds, retainedSessionIds };
        }
        const sessionIds = await discoverDaemonSessionClientDurableMutationJournalSessionIds(
            configuration.activeServerDir,
        );
        if (isShuttingDown()) {
            return { recoveredSessionIds, retainedSessionIds };
        }
        const usageBindings = await params.bindUsageLimitRecoveryJournals(sessionIds);
        retainedSessionIds = usageBindings.retainedSessionIds;
        for (const sessionId of sessionIds) {
            if (isShuttingDown()) break;
            const outbox = this.getDaemonTerminalSessionMutationOutbox(sessionId, isShuttingDown);
            if (isShuttingDown()) break;
            await outbox.awaitReady();
            if (isShuttingDown()) break;
            await outbox.flush('startup');
            recoveredSessionIds.push(sessionId);
        }
        return {
            recoveredSessionIds,
            retainedSessionIds,
        };
    }

    connect(params?: {
        takeover?: boolean;
        onConnect?: () => void | Promise<void>;
        onOwnershipConflict?: (conflict: { owner: MachineOwnerConflictDetails }) => void;
        onMachineReplaced?: (event: { machineId: string; reason?: 'revoked' }) => void;
        prepareServerTransportForReconnect?: () => Promise<ReadinessProbeResult>;
    }) {
        logger.debug(`[API MACHINE] Connecting to ${resolveServerHttpBaseUrl()}`);
        let takeoverOnNextConnect = params?.takeover === true;

        if (!this.connectionSupervisor) {
            this.connectionSupervisor = createManagedConnectionSupervisor({
                ...DEFAULT_MANAGED_CONNECTION_POLICY,
                classifyTransportErrorToProbeResult,
                createTransport: () => {
                    const serverUrl = this.machineRuntimeServerHttpBaseUrl;
                    const transportGeneration = this.activeTransportGeneration + 1;
                    this.activeTransportGeneration = transportGeneration;
                    const installationIdentity = configuration.installationIdentityFile
                        ? readInstallationIdentityIfExistsSync()
                        : null;
                    const installationProof = installationIdentity
                        ? buildInstallationProofForMachine({
                            identity: installationIdentity,
                            machineId: this.machine.id,
                            token: this.token,
                        })
                        : null;
                    const { socket, transport } = createMachineSocketTransport({
                        serverUrl,
                        token: this.token,
                        machineId: this.machine.id,
                        ...(installationProof
                            ? {
                                installationId: installationProof.installationId,
                                installationPublicKey: installationProof.installationPublicKey,
                                installationProof: installationProof.installationProof,
                            }
                            : null),
                        ...this.ownershipMetadata,
                        takeover: takeoverOnNextConnect,
                        transports: resolveServerSocketIoTransports(),
                        env: process.env,
                    });
                    this.connectedClientRpcMethods.clear();
                    this.socket = socket;
                    this.installSocketEventHandlers(
                        socket,
                        transportGeneration,
                        params,
                    );
                    socket.on('disconnect', () => {
                        this.handleTransportSocketDisconnect(socket, transportGeneration);
                    });
                    return transport;
                },
                probeReadiness: async () => {
                    const prepared = await params?.prepareServerTransportForReconnect?.();
                    if (prepared && prepared.status !== 'ready') return prepared;
                    return await createLoopbackReadinessProbe({
                        serverUrl: resolveServerHttpBaseUrl(),
                        token: this.token,
                    })();
                },
                onStateChange: (state) => {
                    this.currentConnectionState = state;
                    for (const listener of this.connectionStateListeners) {
                        listener(state);
                    }
                },
                onConnected: async () => {
                    logger.debug('[API MACHINE] Connected to server');
                    const isReconnect = this.hasConnectedOnce;
                    this.hasConnectedOnce = true;
                    takeoverOnNextConnect = false;

                    const socket = this.socket;
                    const transportGeneration =
                        this.activeTransportGeneration;
                    if (isReconnect && this.lifecycleDependencies.loadMachine) {
                        this.retireMachineContent();
                        await timeWebLatencyPhase('machine.startup.refreshContent', () => this.refreshMachineFromServer());
                        if (!this.machineContentReady || this.socket !== socket || this.activeTransportGeneration !== transportGeneration) return;
                    }
                    // Registration carries no execution authority. The server holds early
                    // packets through admission; request authority checks stay unchanged.
                    if (socket) this.rpcHandlerManager.onSocketConnect(socket);
                    // Account observation remains connection-owned, including without a
                    // changes-feed consumer, but does not serialize RPC registration.
                    if (readAccountIdFromToken(this.token)) {
                        await timeWebLatencyPhase('machine.startup.accountIdentity', () => this.getAccountId());
                    }
                    const missingCoreHandlers = this.requiredMachineControlRpcMethods().filter(
                        (method) => !this.rpcHandlerManager.hasHandler(method),
                    );
                    if (socket) {
                        // A persisted projection replaces rather than merges, so publishing an
                        // empty one withdraws sessionSpawn until something republishes it.
                        // Publish it only when it is true of this daemon — the exact-target
                        // handlers are absent, or the creation-outcome attestation is missing —
                        // which is the server's fail-closed input. Otherwise leave the server's
                        // projection alone and let the readiness publication below assert the
                        // real capabilities: a daemon that holds the capability must never
                        // advertise itself as capability-less, because every path that would
                        // undo that can fail.
                        if (
                            missingCoreHandlers.length > 0
                            || this.currentMachineOperationProtocolCapabilities() === null
                        ) {
                            const failClosedCapabilities =
                                this.currentMachineOperationProtocolCapabilities(false) ?? {};
                            await this
                                .publishOperationProtocolCapabilitiesOnSocket(socket, failClosedCapabilities)
                                .catch(() => {
                                    logger.warn('[API MACHINE] Failed to publish the fail-closed operation protocol capability projection on connect');
                                });
                        }
                        const contractResult =
                            await timeWebLatencyPhase('machine.startup.pendingInputContract', () => this
                                .sessionSyncPendingInputServerContractController.resolve({
                                    sessionConnectionEpoch:
                                        transportGeneration,
                                    socket,
                                    machineId: this.machine.id,
                                }));
                        if (
                            this.socket === socket
                            && this.activeTransportGeneration
                                === transportGeneration
                            && socket.connected === true
                        ) {
                            this.sessionSyncPendingInputServerContractResult =
                                contractResult;
                            for (const outbox of this.daemonTerminalSessionMutationOutboxes.values()) {
                                void outbox.flush('connect').catch((error) => {
                                    logger.warn('[API MACHINE] Daemon terminal mutation reconnect flush failed', {
                                        error: serializeAxiosErrorForLog(error),
                                    });
                                });
                            }
                        }
                    }

                    if (missingCoreHandlers.length > 0) {
                        logger.warn('[API MACHINE] Core machine-control RPC handlers are not installed', {
                            missingMethods: missingCoreHandlers,
                        });
                    } else if (socket) {
                        // Deliberately not awaited. The deadline below bounds how long this
                        // attempt watches for the server's registration acknowledgements before
                        // reporting them as outstanding; it is not a functional cutoff, because
                        // every later acknowledgement re-enters the same publication. Awaiting
                        // it here would only delay keep-alive and changes sync by the deadline.
                        void (async () => {
                            let registrationResult =
                                await timeWebLatencyPhase('machine.startup.coreRegistration', () => this.publishMachineControlReadinessWhenReady({
                                    socket,
                                    transportGeneration,
                                    timeoutMs: MACHINE_CONTROL_RPC_REGISTRATION_TIMEOUT_MS,
                                }));
                            const isCurrentTransport = () => (
                                this.socket === socket
                                && this.activeTransportGeneration === transportGeneration
                                && socket.connected === true
                            );
                            if (
                                registrationResult.readiness.status === 'timeout'
                                && isCurrentTransport()
                            ) {
                                this.rpcHandlerManager.replayUnacknowledgedHandlerRegistrations();
                                registrationResult =
                                    await timeWebLatencyPhase('machine.startup.coreRegistrationReplay', () => this.publishMachineControlReadinessWhenReady({
                                        socket,
                                        transportGeneration,
                                        timeoutMs: MACHINE_CONTROL_RPC_REGISTRATION_TIMEOUT_MS,
                                    }));
                            }
                            if (
                                registrationResult.readiness.status === 'ready'
                                && !registrationResult.ready
                                && isCurrentTransport()
                            ) {
                                this.retryMachineControlReadinessPublication({
                                    socket,
                                    transportGeneration,
                                });
                                return;
                            }
                            if (
                                registrationResult.readiness.status === 'timeout'
                                && isCurrentTransport()
                            ) {
                                logger.warn('[API MACHINE] Core machine-control RPC registration did not become ready', {
                                    status: registrationResult.readiness.status,
                                    missingMethods: registrationResult.readiness.missingMethods,
                                });
                            }
                        })().catch((error) => {
                            logger.warn('[API MACHINE] Machine-control readiness publication failed', {
                                message: error instanceof Error ? error.message : String(error),
                            });
                        });
                    }

                    this.startChangesSyncWithRetry({ reason: isReconnect ? 'reconnect' : 'connect' });
                    this.startKeepAlive();

                    if (params?.onConnect) {
                        await Promise.resolve(params.onConnect()).catch((error: unknown) => {
                            logger.warn('[API MACHINE] Machine connect hook failed', {
                                message: error instanceof Error ? error.message : String(error),
                            });
                        });
                    }
                },
                onDisconnected: async () => {
                    // The transport socket that actually disconnected owns teardown via its
                    // socket-scoped disconnect handler. This avoids stale callbacks from an
                    // older transport clearing a newer active socket.
                },
                onAuthFailed: async (ctx) => {
                    logger.debug('[API MACHINE] Auth failed');
                    if (!this.isCurrentConnectionState(ctx.state)) {
                        return;
                    }
                    this.teardownActiveSocket();
                },
            });
        }

        void this.connectionSupervisor.start().catch((error) => {
            logger.warn('[API MACHINE] Failed to start machine connection supervisor', {
                message: error instanceof Error ? error.message : String(error),
            });
        });
    }

    requestServerTransportReconnect(): boolean {
        const supervisor = this.connectionSupervisor;
        const scope = supervisor?.captureProbeReportScope?.();
        if (!supervisor?.reportProbeResult || !scope) return false;
        supervisor.reportProbeResult({
            status: 'server_unreachable',
            errorMessage: 'The active Home transport descriptor changed',
        }, scope);
        return true;
    }

    private warnRetiredRpcTransport(
        request: { method: string; requestId?: unknown; traceId?: unknown },
        phase: 'before-handler' | 'after-handler',
        socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>,
        transportGeneration: number,
    ): void {
        logger.warnLocalFile('[API MACHINE] RPC transport retired before acknowledgement', {
            ...this.rpcHandlerManager.projectRequestDiagnostic(request),
            phase,
            transportGeneration,
            activeTransportGeneration: this.activeTransportGeneration,
            connected: socket.connected === true,
            sameSocket: socket === this.socket,
        });
    }

    private installSocketEventHandlers(
        socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>,
        transportGeneration: number,
        params?: {
            takeover?: boolean;
            onConnect?: () => void | Promise<void>;
            onOwnershipConflict?: (conflict: { owner: MachineOwnerConflictDetails }) => void;
            onMachineReplaced?: (event: { machineId: string; reason?: 'revoked' }) => void;
        },
    ) {
        socket.on('connect_error', (error: unknown) => {
            if (!this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) {
                return;
            }
            const ownershipConflict = readMachineOwnerConflictFromSocketError(error);
            if (!ownershipConflict) {
                const diagnostic = readSocketConnectErrorDiagnostic(error);
                logger.warn('[API MACHINE] Machine socket connect error', diagnostic);
                const retirementReason = readMachineSocketRetirementReason(error);
                if (retirementReason) {
                    void this.connectionSupervisor?.stop().catch(() => {});
                    params?.onMachineReplaced?.({ machineId: this.machine.id,
                        ...(retirementReason === 'revoked' ? { reason: 'revoked' } : {}) });
                }
                return;
            }
            void this.connectionSupervisor?.stop().catch(() => {});
            params?.onOwnershipConflict?.(ownershipConflict);
        });

        socket.on(SOCKET_RPC_EVENTS.REQUEST, async (data: { method: string, params: unknown }, callback: (response: unknown) => void) => {
            const isCurrentTransport = () => (
                this.isActiveTransportGeneration(transportGeneration)
                && socket === this.socket
            );
            if (!isCurrentTransport()) {
                this.warnRetiredRpcTransport(data, 'before-handler', socket, transportGeneration);
                return;
            }
            logger.debugLargeJson(
                `[API MACHINE] Received RPC request:`,
                projectIncomingMachineRpcDebugPayload(data),
            );
            // Only this authenticated, current Home socket can supply transport
            // provenance. Direct/peer ingress retains its own Home verification.
            await this.rpcHandlerManager.handleRequest(data, callback, 'authenticated_home_socket');
            if (!isCurrentTransport()) {
                this.warnRetiredRpcTransport(data, 'after-handler', socket, transportGeneration);
            }
            // The manager retains the admitted transport's callback and suppresses
            // abandoned replies without transferring custody to a newer connection.
        });

        socket.on(SOCKET_RPC_EVENTS.REGISTERED, (data: { method: string }) => {
            if (!this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) {
                return;
            }
            const method = this.normalizeConnectedClientRpcAvailabilityMethod(data.method);
            const separatorIndex = data.method.indexOf(':');
            const rpcMethod = separatorIndex === -1 ? data.method : data.method.slice(separatorIndex + 1);
            if (isCurrentUiContextClientRpcMethod(rpcMethod)) {
                logger.debug('[API MACHINE] Current UI RPC availability received', {
                    machineId: this.machine.id,
                    method: data.method,
                    accepted: method !== null,
                    transportGeneration,
                });
            }
            if (method) {
                this.connectedClientRpcMethods.add(method);
            }
        });

        socket.on(SOCKET_RPC_EVENTS.UNREGISTERED, (data: { method: string }) => {
            if (!this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) {
                return;
            }
            const method = this.normalizeConnectedClientRpcAvailabilityMethod(data.method);
            if (method) {
                this.connectedClientRpcMethods.delete(method);
            }
        });

        socket.on(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, (data: MachineTransferReceiveEnvelope) => {
            for (const listener of this.machineTransferListeners) {
                try {
                    listener(data);
                } catch (error) {
                    logger.warn('[API MACHINE] Machine transfer listener threw (ignored)', {
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        });

        socket.on(TRANSFER_RELAY_V2_SOCKET_EVENT, (data: TransferRelayV2SendEnvelope) => {
            for (const listener of this.transferRelayV2Listeners) {
                try {
                    listener(data);
                } catch (error) {
                    logger.warn('[API MACHINE] Transfer relay v2 listener threw (ignored)', {
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        });

        socket.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (data: PeerTcpTunnelRelayEnvelope) => {
            for (const listener of this.peerTcpTunnelRelayListeners) {
                try {
                    listener(data);
                } catch (error) {
                    logger.warn('[API MACHINE] Peer TCP tunnel relay listener threw (ignored)', {
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        });

        socket.on(MACHINE_LIVE_STREAM_SOCKET_EVENT, async (raw: unknown) => {
            if (!this.machineContentReady) return;
            const parsed = MachineLiveStreamRelayEnvelopeV1Schema.safeParse(raw);
            if (!parsed.success) {
                logger.warn('[API MACHINE] Live-stream payload rejected', { code: 'stream_payload_invalid' });
                return;
            }
            const machineCodec = this.machineContentCodec;
            const codec = this.readLiveStreamContentCodec(parsed.data);
            const opened = hasMachineLiveStreamSensitiveContentV1(parsed.data)
                ? await openMachineLiveStreamEnvelopeV1(parsed.data, {
                    mode: codec.mode,
                    ...(codec.mode === 'e2ee' ? { cipher: {
                        encryptRaw: (value: unknown) => codec.encodeRpc(value),
                        decryptRaw: (value: string) => codec.decodeRpc(value),
                    } } : {}),
                })
                : { ok: true as const, value: MachineLiveStreamDecodedEnvelopeV1Schema.parse(parsed.data) };
            if (!this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket
                || machineCodec !== this.machineContentCodec || !this.machineContentReady) return;
            if (!opened.ok) {
                this.failMachineLiveStreamPayload(parsed.data, opened.code);
                return;
            }
            const data = opened.value;
            for (const listener of this.machineLiveStreamRelayListeners) {
                try {
                    listener(data);
                } catch (error) {
                    logger.warn('[API MACHINE] Machine live-stream relay listener threw (ignored)', {
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        });

        socket.on(
            EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
            (data: ExternalSessionStatusDemandDaemonMessageV1) => {
                if (!this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) {
                    return;
                }
                for (const listener of this.externalSessionStatusDemandListeners) {
                    try {
                        listener(data);
                    } catch (error) {
                        logger.warn('[API MACHINE] External-session status-demand listener threw (ignored)', {
                            message: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
            },
        );

        socket.on('ephemeral', (raw: unknown) => {
            if (this.projectionSchedulingClosed || !this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) return;
            const receipt = PluginWebhookHeartbeatReceiptEphemeralV1Schema.safeParse(raw);
            if (receipt.success) {
                const { type: _type, ...payload } = receipt.data;
                for (const listener of this.healthCheckHeartbeatReceiptListeners) {
                    try {
                        listener(payload);
                    } catch (error) {
                        logger.warn('[API MACHINE] Health-check heartbeat listener threw (ignored)', {
                            message: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
                return;
            }
            const replyHint = SessionMessageReplyPendingHintV1Schema.safeParse(raw);
            if (replyHint.success) {
                this.requestSessionMessageReplyRecovery(socket, transportGeneration);
                this.requestSessionMessageReplyRecovery(socket, transportGeneration, replyHint.data.sessionId);
                if (replyHint.data.workflowRunId) {
                    // A real approval decision can retire publication custody
                    // without appending a reply or changing its native outcome.
                    void this.lifecycleDependencies.onWorkflowReplyReturned?.(replyHint.data.workflowRunId).catch(error => {
                        logger.warn('[API MACHINE] Workflow return recovery failed; pending custody retained', serializeAxiosErrorForLog(error));
                    });
                }
                return;
            }
            const hint = PendingActivationRequestedEphemeralV1Schema.safeParse(raw);
            if (!hint.success || hint.data.target.machineId !== this.machine.id) return;
            void this.notifyPendingSessionActivationHint({ sessionId: hint.data.target.sessionId,
                target: hint.data.target, requestId: hint.data.requestId, requestedAt: hint.data.requestedAt,
                pendingVersion: hint.data.pendingVersion, source: 'live' });
        });

        socket.on('update', (data: Update) => {
            if (this.projectionSchedulingClosed || !this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) {
                return;
            }
            if (data.body.t === 'update-machine' && (data.body as UpdateMachineBody).machineId === this.machine.id) {
                const update = data.body as UpdateMachineBody;

                const publication = asRecord(update);
                const nextBasis = asRecord(publication?.keyBasis);
                const hasKeyHint = nextBasis !== null || publication?.dataEncryptionKey !== undefined;
                const hintedKey = nextBasis ? nextBasis.dataEncryptionKey : publication?.dataEncryptionKey;
                const currentKey = this.machine.keyBasis ? this.machine.keyBasis.dataEncryptionKey : this.machine.dataEncryptionKey ?? null;
                const isOlder = (update.metadata?.version ?? this.machine.metadataVersion) < this.machine.metadataVersion
                    || (update.daemonState?.version ?? this.machine.daemonStateVersion) < this.machine.daemonStateVersion;
                if (hasKeyHint && hintedKey !== currentKey) {
                    if (!isOlder) {
                        this.retireMachineContent();
                        void this.refreshMachineFromServer();
                    }
                    return;
                }
                if (!this.machineContentReady) {
                    void this.refreshMachineFromServer();
                    return;
                }

                if (update.metadata && update.metadata.version > this.machine.metadataVersion) {
                    logger.debug('[API MACHINE] Received external metadata update');
                    const publication = projectMachineMetadataChange(this.machine.metadata,
                        projectMachinePublishedMetadataFromRowV1(StoredMachinePublishedMetadataV1Schema.parse(this.machineContentCodec.decodeStored(update.metadata.value)), update.devcontainerChild));
                    this.machine.metadata = publication.metadata;
                    this.machine.metadataVersion = update.metadata.version;
                    if (this.machine.keyBasis) this.machine.keyBasis = { ...this.machine.keyBasis, metadataVersion: update.metadata.version };
                    this.notifyMachineMetadataChanged(publication.change);
                }

                // A blob CAS acknowledgement can precede its same-version
                // echo; the retained-row fact is independent of that version.
                if (update.devcontainerChild !== undefined) {
                    const metadata = projectMachinePublishedMetadataFromRowV1(this.machine.metadata, update.devcontainerChild);
                    if (metadata !== this.machine.metadata) {
                        this.machine.metadata = metadata;
                        this.notifyMachineMetadataChanged({ serviceWatchesChanged: false });
                    }
                }

                if (update.daemonState && update.daemonState.version > this.machine.daemonStateVersion) {
                    logger.debug('[API MACHINE] Received external daemon state update');
                    this.machine.daemonState = update.daemonState.value === null ? null
                        : StoredMachinePublishedDaemonStateV1Schema.parse(this.machineContentCodec.decodeStored(update.daemonState.value));
                    this.machine.daemonStateVersion = update.daemonState.version;
                    if (this.machine.keyBasis) this.machine.keyBasis = { ...this.machine.keyBasis, daemonStateVersion: update.daemonState.version };
                }
                // Same key and ready content: when this publication carries only fields applied
                // above, this write (or a newer one) is now held. Lifecycle fields (revocation,
                // replacement, managed runtime) still reach the Machine read through the feed.
                if (Number.isSafeInteger(data.seq) && data.seq > (this.heldOwnMachineChangeCursor ?? -1)
                    && Object.keys(update).every(field => UPDATE_MACHINE_CONTENT_FIELDS_APPLIED_LIVE.has(field))) {
                    this.heldOwnMachineChangeCursor = data.seq;
                }
                return;
            }

            const handled = this.dispatchUpdate(data);
            if ((data.body.t === 'pending-changed' || data.body.t === 'automation-run-updated')
                && data.body.managedWakeTargetV1 !== undefined) {
                const target = ManagedWakeTargetV1Schema.safeParse(data.body.managedWakeTargetV1);
                if (target.success && (!target.data.controller || target.data.controller.machineId === this.machine.id)) {
                    void this.notifyManagedMachinePolicyInvalidated().catch(() => {
                        logger.warn('[API MACHINE] Managed policy wake listener failed');
                    });
                }
            }
            if (data.body.t === 'pending-changed') {
                const requestId = typeof data.body.pendingActivationRequestId === 'string'
                    ? data.body.pendingActivationRequestId.trim()
                    : '';
                const sessionId = typeof data.body.sessionId === 'string'
                    ? data.body.sessionId.trim()
                    : data.body.sid.trim();
                if (requestId && sessionId) {
                    void this.notifyPendingSessionActivationHint({
                        sessionId,
                        requestId,
                        pendingVersion: data.body.pendingVersion,
                        source: 'live',
                    });
                }
            }
            if (
                data.body.t === 'account-change'
                || (
                    data.body.t === 'update-account'
                    && 'connectedServices' in data.body
                    && data.body.connectedServices !== undefined
                )
            ) {
                const pushed = data.body.t === 'account-change' ? readPushedChangesPage(data.body) : undefined;
                if (pushed === null) logger.warn('[API MACHINE] Malformed pushed Account change page; reading the feed');
                this.startChangesSyncWithRetry({ reason: 'live',
                    ...(data.body.t === 'account-change' && Number.isSafeInteger(data.seq) && data.seq >= 0
                        ? { requestedCursor: data.seq } : {}),
                    ...(pushed ? { pushedPages: [{ transportGeneration, pushed }] } : {}),
                });
            }
            if (!handled && process.env.DEBUG) {
                logger.debug(`[API MACHINE] Ignored update type: ${(data.body as any).t}`);
            }
        });
    }

    private startKeepAlive() {
        this.stopKeepAlive();
        this.keepAliveInterval = setInterval(() => {
            if (!this.socket) {
                return;
            }
            const payload = {
                machineId: this.machine.id,
                time: Date.now()
            };
            if (process.env.DEBUG) { // too verbose for production
                logger.debugLargeJson(`[API MACHINE] Emitting machine-alive`, payload);
            }
            this.socket.emit('machine-alive', payload);
        }, MACHINE_HEARTBEAT_INTERVAL_MS);
        logger.debug('[API MACHINE] Keep-alive started (60s interval)');
    }

    private stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger.debug('[API MACHINE] Keep-alive stopped');
        }
    }

    /** Final host retirement phase, before plugin/PTY/root disposal; not temporary drain. */
    async retireProjectFiniteExecution(): Promise<void> {
        // Each occurrence closes fresh ingress synchronously. The shared runner
        // then performs one memoized Stop/wait pass while get/cancel and Home
        // remain reachable; an unconfirmed process outcome keeps this pending.
        await Promise.all(this.rpcLifecycleRegistrations.map(registration => registration.retireFiniteExecution()));
        if (this.projectFiniteExecutionLive) {
            await this.setProjectFiniteExecutionLive(false).catch((error) => {
                logger.debug('[API MACHINE] Failed to acknowledge finite execution withdrawal', {
                    error: serializeAxiosErrorForLog(error),
                });
            });
        }
    }

    async shutdown() {
        logger.debug('[API MACHINE] Shutting down');
        await this.retireProjectFiniteExecution();
        this.externalActionIngressOwner = null;
        // Socket reconnects retain this Account scope; process-terminal
        // shutdown is the canonical point that retires its Collection cursor
        // retention and active local observers.
        retirePluginAccountCollectionWatchScope(resolveAccountSettingsScopeKeyForToken(this.token));
        this.projectionSchedulingClosed = true;
        this.localServiceStartObservationCleanup?.();
        this.localServiceStartObservationCleanup = null;
        this.scheduledObservation?.dispose();
        this.scheduledObservation = null;
        await this.machineServicesBinding?.dispose();
        await this.accountEncryptionCurrentness?.dispose();
        this.accountEncryptionCurrentness = null;
        await this.executionRunAccountSnapshots?.dispose();
        this.executionRunAccountSnapshots = null;
        this.activeTransportGeneration += 1;
        this.teardownActiveSocket();
        this.connectedServicesProjectionRetry.close();
        this.pendingChangesSyncDemand = null;
        this.machineControlReadinessRetry.close();
        if (this.connectionSupervisor) {
            await this.connectionSupervisor.stop();
        }
        await this.connectedServicesProjectionRetry.waitForIdle();
        await this.rpcHandlerManager.waitForIdle();
        await this.disposeRpcLifecycleRegistrations();
        await this.fileSystemTransferRelayOwner.store.dispose();
        const daemonTerminalOutboxes = Array.from(this.daemonTerminalSessionMutationOutboxes.values());
        this.daemonTerminalSessionMutationOutboxes.clear();
        await Promise.all(daemonTerminalOutboxes.map(async (outbox) => {
            try {
                await outbox.close();
            } catch (error) {
                logger.debug('[API MACHINE] Failed to close session-end mutation outbox', {
                    error: serializeAxiosErrorForLog(error),
                });
            }
        }));
    }

    private async disposeRpcLifecycleRegistrations(): Promise<void> {
        this.machineRebootAction = null;
        this.managedActivityPublicationCleanup?.();
        this.managedActivityPublicationCleanup = null;
        this.liveWorkProducer.dispose();
        const registrations = this.rpcLifecycleRegistrations.splice(0);
        await Promise.all(registrations.map(async (registration) => {
            try {
                await registration.dispose();
            } catch (error) {
                logger.debug('[API MACHINE] Failed to dispose RPC lifecycle registration', {
                    error: serializeAxiosErrorForLog(error),
                });
            }
        }));
    }

    async awaitPendingRpcRequests(): Promise<void> {
        await this.rpcHandlerManager.waitForIdle();
    }

    getActiveRpcHandlerExecutions(): readonly RpcHandlerActiveExecution[] {
        return this.rpcHandlerManager.getActiveHandlerExecutions();
    }

    /**
     * Resolves one exact Session access fact through the incumbent Account
     * change carrier. The returned cursor is admission evidence only: this
     * method never persists or acknowledges it as consumed feed progress.
     */
    async resolvePluginResourceSessionAccess(params: Readonly<{
        accountId: string;
        sessionId: string;
        signal: AbortSignal;
    }>): Promise<Readonly<{
        accountId: string;
        throughCursor: number;
        status: 'available' | 'unavailable';
    }>> {
        params.signal.throwIfAborted();
        const accountId = await this.getAccountId(params.signal);
        params.signal.throwIfAborted();
        if (!accountId || accountId !== params.accountId) {
            throw new Error('plugin_resource_session_access_unavailable');
        }
        const result = await fetchChanges({
            token: this.token,
            after: 0,
            limit: 1,
            sessionAccessSessionId: params.sessionId,
            signal: params.signal,
        });
        params.signal.throwIfAborted();
        if (result.status !== 'ok') {
            throw new Error('plugin_resource_session_access_unavailable');
        }
        const probe = result.response.sessionAccessProbe;
        if (!probe || probe.sessionId !== params.sessionId) {
            // Supported older servers omit the additive exact proof. The
            // affected Session-scoped operation fails closed without changing
            // global Account Resources or the ordinary change cursor.
            throw new Error('plugin_resource_session_access_unavailable');
        }
        return Object.freeze({
            accountId,
            throughCursor: probe.throughCursor,
            status: probe.status,
        });
    }

    /** The Profile-verified Account id this Machine connection admitted; one read per lifetime. */
    async resolveAuthenticatedAccountId(signal?: AbortSignal): Promise<string | null> {
        return await runWithServerHttpBaseUrl(this.machineRuntimeServerHttpBaseUrl, () => this.getAccountId(signal));
    }

    private async getAccountId(signal?: AbortSignal): Promise<string | null> {
        signal?.throwIfAborted();
        if (this.accountIdPromise) {
            const pending = this.accountIdPromise.catch((error) => {
                if (isAuthenticationError(error)) {
                    if (this.connectionSupervisor) {
                        return null;
                    }
                    throw error;
                }
                return null;
            });
            // A joining admission owns its wait, not the acquisition another
            // caller started (which can also be awaiting Account currentness).
            return await (signal ? waitForObservation(pending, signal) : pending);
        }

        const request = () => fetchChangesAccountId({ token: this.token,
            serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl, ...(signal ? { signal } : {}) });
        const supervisor = this.connectionSupervisor;
        const authenticated = supervisor
            ? runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request,
            })
            : request();
        const p = authenticated.then(async accountId => {
            // The authenticated Profile, not an unverified JWT subject, admits this lifetime.
            if (!this.projectionSchedulingClosed && readAccountIdFromToken(this.token) === accountId) {
                const observation = acquireRequesterAccountEncryptionCurrentness({ accountId, token: this.token,
                    serverBaseUrl: this.machineRuntimeServerHttpBaseUrl });
                this.accountEncryptionCurrentness = observation;
                // This catch-up already reads every follow-relevant kind of this Account feed per wake;
                // the shared observation consumes its pages instead of a second read per wake.
                if (isV2ChangesSyncEnabled(process.env.HAPPY_ENABLE_V2_CHANGES)) observation.attachFeedOwner();
                try { await observation.read(signal); }
                catch (error) {
                    // A missing route on older Homes retains existing HTTP readers. Transient
                    // failures stay unknown at the observer and recover on its next read/reconnect.
                    if (readHttpStatus(error instanceof AccountEncryptionCurrentnessUnavailableError ? error.cause : error) === 404) {
                        await observation.dispose();
                        if (this.accountEncryptionCurrentness === observation) this.accountEncryptionCurrentness = null;
                    }
                }
            }
            return accountId;
        });

        this.accountIdPromise = p;
        const result = p.catch((error) => {
            this.accountIdPromise = null;
            if (isAuthenticationError(error)) {
                if (supervisor) {
                    return null;
                }
                throw error;
            }
            return null;
        });
        // Only acquisition failure clears the shared promise; cancellation of
        // this reader must not invalidate another reader's pending acquisition.
        return await (signal ? waitForObservation(result, signal) : result);
    }

    private notifyMachineMetadataChanged(change: MachineMetadataChange): void {
        this.machineServicesBinding?.notifyMetadataChanged(change);
        try {
            this.lifecycleDependencies.onMachineMetadataChanged?.();
        } catch {
            logger.warn('[API MACHINE] Machine metadata listener threw (ignored)');
        }
    }

    private retireMachineContent(): void {
        const serviceWatchesChanged = this.machineContentReady;
        this.heldOwnMachineChangeCursor = undefined;
        this.machineContentContext = { codec: this.machineContentCodec, ready: false };
        this.rpcHandlerManager.retireEncryptionContext();
        this.notifyMachineMetadataChanged({ serviceWatchesChanged });
    }

    private readOwnerEnvelopeForWrite(): string | null {
        if (this.machine.keyBasis) return this.machine.keyBasis.dataEncryptionKey;
        if (this.machine.access && this.machine.access.custodian.accountId !== readAccountIdFromToken(this.token)) {
            throw new Error('Shared Machine owner key basis is unavailable');
        }
        return this.machine.dataEncryptionKey ?? null;
    }

    private async refreshMachineFromServer(signal?: AbortSignal): Promise<void> {
        const loadMachine = this.lifecycleDependencies.loadMachine;
        if (!loadMachine) return;
        const previousContext = this.machineContentContext;
        const transportGeneration = this.activeTransportGeneration;
        try {
            const request = () => loadMachine(signal ? { signal } : undefined);
            const next = this.connectionSupervisor
                ? await runSupervisedRequest({
                    supervisor: this.connectionSupervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request,
                })
                : await request();
            signal?.throwIfAborted();
            if (previousContext !== this.machineContentContext || transportGeneration !== this.activeTransportGeneration) return;
            if (!next || next.id !== this.machine.id) {
                this.retireMachineContent();
                return;
            }
            if (next.metadataVersion < this.machine.metadataVersion || next.daemonStateVersion < this.machine.daemonStateVersion) return;
            const retainCodec = this.machineContentReady
                && (this.machine.encryptionMode ?? 'e2ee') === (next.encryptionMode ?? 'e2ee')
                && this.machine.encryptionVariant === next.encryptionVariant
                && isDeepStrictEqual(this.machine.encryptionKey, next.encryptionKey)
                && (this.machine.dataEncryptionKey ?? null) === (next.dataEncryptionKey ?? null)
                && (this.machine.keyBasis ? this.machine.keyBasis.dataEncryptionKey : this.machine.dataEncryptionKey ?? null)
                    === (next.keyBasis ? next.keyBasis.dataEncryptionKey : next.dataEncryptionKey ?? null);
            // A fresh same-key snapshot must not retire admitted publication ACKs.
            // Still replace the snapshot context so older refreshes cannot install it.
            const codec = retainCodec ? this.machineContentCodec : createMachineContentCodec(next);
            const publication = projectMachineMetadataChange(this.machine.metadata, next.metadata);
            // Install decoded content, owner write basis, and RPC codec as one context.
            this.machine = { ...next, metadata: publication.metadata, daemonState: this.discardUnverifiedIrohEndpoint(next.daemonState) };
            this.machineContentContext = { codec, ready: true };
            this.rpcHandlerManager.adoptEncryptionContext(this.machine);
            this.notifyMachineMetadataChanged({ serviceWatchesChanged: !previousContext.ready || publication.change.serviceWatchesChanged });
        } catch (error) {
            // Transient reads provide no contrary key/owner evidence. Preserve
            // the admitted context; an already retired context stays retired.
            if (!classifyServerEndpointError(error).retryable
                && previousContext === this.machineContentContext
                && transportGeneration === this.activeTransportGeneration) this.retireMachineContent();
            logger.debug('[API MACHINE] Failed to refresh machine snapshot', {
                error: serializeAxiosErrorForLog(error),
            });
        }
    }

    /** The Account-change carrier is the only source of Session access proof. */
    private applyResourceSessionAccessWitness(
        params: Parameters<PluginReloadController['applyResourceSessionAccessWitness']>[0],
    ): void {
        const lifecycle = this.lifecycleDependencies.resourceSessionLifecycle
            ?? pluginReloadController;
        lifecycle.applyResourceSessionAccessWitness(params);
    }

    /**
     * The Home resource read authorizes private and granted Saved Secrets.
     * It does not consume features; refreshing them here would also invoke
     * authenticated-ready hydration before repeating the same resource read.
     */
    private async synchronizeSavedSecretCatalog(signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        await hydrateSavedSecretCatalog({
            token: this.token,
            signal,
        });
    }

    private async refreshDemandedPromptLibraryCatalog(input: Readonly<{
        signal: AbortSignal; initializeMachineInstallDemand?: boolean; artifactIds?: readonly string[];
    }>): Promise<void> {
        const installs = this.lifecycleDependencies.machineSkillInstalls;
        const machineInstallDemand = installs?.target.machineId === this.machine.id ? installs : undefined;
        const active = getActiveAccountSettingsSnapshot();
        const captured = active?.scopeKey ? { scopeKey: active.scopeKey,
            lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() } : null;
        const transportGeneration = this.activeTransportGeneration;
        // A new daemon must observe the existing receipt row before it can know
        // which installs demand the catalog. This is the same key-demand owner.
        let prepared = false;
        if (machineInstallDemand && input.initializeMachineInstallDemand && captured
            && active?.promptLibraryCatalog === undefined
            && captured.scopeKey === resolveAccountSettingsScopeKeyForToken(this.token)) {
            const credentials = await readStoredCredentials();
            input.signal.throwIfAborted();
            if (credentials?.token === this.token) {
                await prepareActivePromptLibraryRecord({ credentials, ...captured, key: 'external-links', signal: input.signal });
                prepared = true;
            }
        }
        const catalog = prepared ? getActiveAccountSettingsSnapshot()?.promptLibraryCatalog
            : await refreshDemandedActivePromptLibraryCatalog({ token: this.token, signal: input.signal,
                ...(machineInstallDemand ? { machineInstallDemand } : {}) });
        input.signal.throwIfAborted();
        if (!machineInstallDemand || !captured || !isActiveAccountSettingsSnapshotLifetimeCurrent(captured)
            || !this.isActiveTransportGeneration(transportGeneration)
            || (catalog?.status !== 'ready' && catalog?.status !== 'partial')
            || readActiveMachineSkillInstallArtifactIds({ token: this.token, machineInstallDemand }).length === 0) return;
        await machineInstallDemand.refresh({ signal: input.signal,
            ...(input.artifactIds ? { artifactIds: input.artifactIds } : {}) });
        input.signal.throwIfAborted();
    }

    private async refreshAllDemandedAccountCatalogs(input: {
        token: string;
        signal: AbortSignal;
        serverHttpBaseUrl: string;
    }): Promise<void> {
        input.signal.throwIfAborted();
        await refreshDemandedActiveProfileCatalog(input);
        await refreshDemandedActiveApprovalProfileCatalog(input);
        await this.refreshDemandedPromptLibraryCatalog({ signal: input.signal, initializeMachineInstallDemand: true });
        await refreshDemandedActiveProviderConnectionsCatalog(input);
        await refreshDemandedActiveMcpServerCatalog(input);
        await refreshDemandedActiveAcpCatalog(input);
        await refreshDemandedActiveConnectedAccountCatalogs(input);
        await refreshDemandedActiveConnectedMetadataCatalog(input);
        await refreshDemandedActiveNotificationChannelCatalog(input);
        input.signal.throwIfAborted();
    }

    private async syncChangesOnConnect(
        opts: AccountChangesSyncDemand,
        signal: AbortSignal = new AbortController().signal,
    ): Promise<void> {
        notePluginAccountSettingsChangeFeedRunning();
        // Startup/reconnect recover the full projection; live wakes classify the changes page first.
        const executionAuthority = opts.reason === 'live'
            ? 'runtime_recovery' as const
            : 'passive_projection' as const;
        const requestSupervisionScope = this.connectionSupervisor?.captureProbeReportScope?.();
        const transportGeneration = this.activeTransportGeneration;
        signal.throwIfAborted();
        const transportRecovered = opts.recoveredTransportGeneration === transportGeneration;
        if (opts.reason !== 'live' && !transportRecovered) {
            try {
                await this.reconcileConnectedServicesProjection({
                    source: opts.reason === 'connect' ? 'startup' : 'reconnect',
                    executionAuthority,
                }, signal);
                opts.recoveredTransportGeneration = transportGeneration;
            } catch (error) {
                if (handleRequestAuthenticationFailure({
                    supervisor: this.connectionSupervisor,
                    error,
                    hadAuth: true,
                    scope: requestSupervisionScope,
                })) {
                    return;
                }
                throw error;
            }
        }

        if (!isV2ChangesSyncEnabled(process.env.HAPPY_ENABLE_V2_CHANGES)) {
            if (this.isActiveTransportGeneration(transportGeneration)) {
                this.accountChangesObserverTransportGeneration = null;
            }
            if (opts.reason !== 'live') {
                await this.notifyAccountProjectRowsChanged({ source: opts.reason, signal });
                await this.refreshAllDemandedAccountCatalogs({ token: this.token, signal, serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl });
                await this.notifyPluginWebhookInvalidated(signal);
                await this.notifyManagedMachinePolicyInvalidated(signal);
            }
            return;
        }

        signal.throwIfAborted();
        const accountId = await this.getAccountId(signal);
        signal.throwIfAborted();
        if (!accountId) throw new Error('account_changes_account_id_unavailable');
        const accountScopeKey = resolveAccountSettingsScopeKeyForToken(this.token);

        const CHANGES_PAGE_LIMIT = ACCOUNT_CHANGES_PAGE_LIMIT_V1;
        let after = await readAccountChangesCursor(accountId);
        // The post-commit producer's seq is this durable cursor, not a domain
        // event count. An equal acknowledged wake has no remaining feed work.
        // Lower values still query: a restore can rebase the cursor domain.
        if (opts.reason === 'live' && opts.requestedCursor === after
            && this.accountChangesObserverTransportGeneration === transportGeneration) return;
        const persistedCursor = after;
        let consumedPage = false;
        let automationWorkInvalidated = false;
        let reason = opts.reason;
        try {
            while (!this.projectionSchedulingClosed && this.isActiveTransportGeneration(transportGeneration)) {
                signal.throwIfAborted();
                // The server authorized this socket's page at fan-out: apply it directly. Reconnect
                // catch-up, a gap, a full page or no pushed page reads the feed.
                const pushed = reason === 'live'
                    ? takePushedChangesPage(opts.pushedPages ?? [], after, transportGeneration) : null;
                const result = pushed ? { status: 'ok' as const, response: pushed.page }
                    : await fetchChanges({ token: this.token, after, limit: CHANGES_PAGE_LIMIT,
                        kinds: MACHINE_ACCOUNT_CHANGE_KINDS, signal });
                signal.throwIfAborted();
                if (this.projectionSchedulingClosed || !this.isActiveTransportGeneration(transportGeneration)) return;
                if (result.status !== 'ok' && result.status !== 'cursor-gone'
                    && this.isActiveTransportGeneration(transportGeneration)) {
                    this.accountChangesObserverTransportGeneration = null;
                }

                if (result.status === 'cursor-gone') {
                    void this.notifySessionFollowRulesChanged({ full: true, workflowRunIds: [], continuityReset: true });
                    publishSessionFollowWakeInvalidation();
                    this.applyResourceSessionAccessWitness({ accountId });
                    signal.throwIfAborted();
                    await this.notifySessionAccessReset({ cursor: result.currentCursor });
                    signal.throwIfAborted();
                    await this.refreshMachineFromServer(signal);
                    signal.throwIfAborted();
                    await this.prepareMachineRecipientEnvelopes([this.machine.id], signal);
                    signal.throwIfAborted();
                    await this.notifyAccountProjectRowsChanged({ source: 'cursor-gone', signal });
                    await this.notifyAccountSettingsVersionHint({ settingsVersion: null, source: 'cursor-gone' });
                    await this.refreshAllDemandedAccountCatalogs({ token: this.token, signal, serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl });
                    signal.throwIfAborted();
                    publishPluginAccountSettingsWatchInvalidation({ kind: 'full' });
                    publishPluginAccountCollectionWatchInvalidation({
                        accountScopeKey,
                        kind: 'reset',
                        changeCursor: result.currentCursor,
                    });
                    await this.reconcileConnectedServicesProjection({ source: 'cursor-gone', executionAuthority }, signal);
                    signal.throwIfAborted();
                    await this.synchronizeSavedSecretCatalog(signal);
                    signal.throwIfAborted();
                    await this.notifyManagedProviderRetainedCurrentnessInvalidation({
                        source: 'cursor-gone',
                        signal,
                        facts: ['all'],
                    });
                    await this.notifyAutomationEventSourcesInvalidated(signal, opts.reason === 'reconnect' ? { reason: 'reconnect' } : {});
                    await this.notifyPluginWebhookInvalidated(signal);
                    await this.notifyManagedMachinePolicyInvalidated(signal);
                    signal.throwIfAborted();
                    after = result.currentCursor;
                    consumedPage = true;
                    automationWorkInvalidated = true;
                    return;
                }
                if (result.status !== 'ok') {
                    if (handleRequestAuthenticationFailure({
                        supervisor: this.connectionSupervisor,
                        error: result.error,
                        hadAuth: true,
                        scope: requestSupervisionScope,
                    })) {
                        return;
                    }

                    // Backwards compatibility: old servers may not support /v2/changes yet (e.g. 404).
                    // On reconnect, fall back to a snapshot refresh.
                    const changesEndpointUnavailable = asRecord(result.error)?.status === 404;
                    if (changesEndpointUnavailable) {
                        this.applyResourceSessionAccessWitness({ accountId });
                        signal.throwIfAborted();
                    }
                    // Live wakes refresh per wake; a retried reconnect already refreshed on this transport.
                    if (opts.reason === 'reconnect' && !transportRecovered || opts.reason === 'live') {
                        await this.refreshMachineFromServer(signal);
                    }
                    if (changesEndpointUnavailable) {
                        await this.notifyAccountProjectRowsChanged({
                            source: opts.reason === 'live' ? 'changes' : opts.reason,
                            signal,
                        });
                        await this.refreshAllDemandedAccountCatalogs({ token: this.token, signal, serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl });
                        await this.notifyPluginWebhookInvalidated(signal);
                        await this.notifyManagedMachinePolicyInvalidated(signal);
                        return;
                    }

                    // A snapshot does not acknowledge a transient changes-feed failure.
                    // Let the canonical retry owner retain and retry the current work.
                    throw result.error;
                }

                const changes = result.response.changes;
                const nextCursor = result.response.nextCursor;
                const pageFull = pushed ? pushed.full : isChangesPageFull(result.response, CHANGES_PAGE_LIMIT);
                if (pageFull && nextCursor <= after) {
                    throw new Error('account_changes_cursor_not_advanced');
                }
                const followSourcesFull = reason !== 'live' || changes.some(change => change.kind === 'account'
                    && asRecord(change.hint)?.sessionFollows === true);
                const workflowRunIds = changes.flatMap(change => change.kind === 'account' && change.entityId.startsWith('workflow-run:')
                    ? [change.entityId.slice('workflow-run:'.length)] : []);
                const discussionIds = changes.flatMap(change => {
                    if (change.kind !== 'discussion') return [];
                    const hint = readDiscussionChangeHintV1(change.hint);
                    // A private read cursor cannot make source custody or a
                    // message available. Unknown/coalesced resource hints keep
                    // the existing canonical reread behavior.
                    return hint?.changes.readState === true && hint.changes.resource !== true ? [] : [change.entityId];
                });
                // Reconnect replays retained demand hints, not pending work.
                // The daemon's Account-scoped pending-receiver read owns that
                // recovery. Keep the operation reason across every feed page;
                // `reason` becomes live after the first page for projections.
                const receiverSessionIds = opts.reason === 'live' ? changes.flatMap(change => {
                    const receiver = readSessionFollowReceiverChangeV1(change);
                    return receiver === null ? [] : [receiver];
                }) : [];
                if (followSourcesFull || workflowRunIds.length || discussionIds.length || receiverSessionIds.length)
                    await this.notifySessionFollowRulesChanged({ full: followSourcesFull, workflowRunIds, discussionIds,
                        ...(reason !== 'live' ? { continuityReset: true as const } : {}),
                        ...(receiverSessionIds.length ? { receiverSessionIds } : {}) });
                if (reason !== 'live' || changes.some((change) => change.kind === 'session')) {
                    publishSessionFollowWakeInvalidation();
                }
                this.applyResourceSessionAccessWitness({
                    accountId,
                    ...(result.response.sessionAccessWitness === undefined
                        ? {}
                        : { witness: result.response.sessionAccessWitness }),
                });
                signal.throwIfAborted();
                const pluginAccountSettingsInvalidations = readPluginAccountSettingsWatchInvalidations(changes);
                const pluginAccountCollectionInvalidations = readPluginAccountCollectionWatchInvalidations(changes);

                const ownMachineChanges = changes.filter(c => c.kind === 'machine' && c.entityId === this.machine.id);
                const hasRelevantMachineChange = ownMachineChanges.length > 0 && !changeRowsAlreadyHeld(
                    ownMachineChanges.map(change => change.entityId),
                    Object.fromEntries(ownMachineChanges.map(change => [change.entityId, change.cursor])),
                    () => true, () => this.heldOwnMachineChangeCursor,
                );
                const managedPolicyIds = changes.flatMap(change => {
                    if (change.kind !== 'account' || asRecord(change.hint)?.managedMachinePolicy !== true) return [];
                    const hint = ManagedMachinePolicyChangeHintV1Schema.safeParse(change.hint);
                    return hint.success && (hint.data.machineId === undefined || hint.data.machineId === this.machine.id) ? [change.entityId] : [];
                });
                const accountSettingsVersions = changes
                    .filter((c) => c.kind === 'account' && c.entityId === 'self')
                    .map((c) => readAccountSettingsVersionFromHint(c.hint))
                    .filter((version): version is number => version !== null);
                const highestAccountSettingsVersion = accountSettingsVersions.length > 0
                    ? Math.max(...accountSettingsVersions)
                    : null;
                const connectedServicesChanges = changes.flatMap(change => {
                    const scope = readConnectedServicesAccountChangeV1(change);
                    return scope ? [{ ...scope, cursor: change.cursor }] : [];
                });
                const hasConnectedServicesChange = connectedServicesChanges.length > 0;
                const connectedServiceRefs = connectedServicesChanges.some(change => change.scope === 'all') ? undefined
                    : connectedServicesChanges.flatMap(change => change.scope === 'service' ? [change.ref] : []);
                // Classification is not acknowledgement. Keep these payload-free
                // witnesses paired so replay can be distinguished from a new fact
                // without logging Account/credential identities or feed bodies.
                const connectedServicesPageDiagnostic = hasConnectedServicesChange ? {
                    afterCursor: after,
                    nextCursor,
                    changeCursors: connectedServicesChanges.map(change => change.cursor),
                    allServices: connectedServicesChanges.some(change => change.scope === 'all'),
                    serviceKinds: [...new Set(connectedServicesChanges.flatMap(change =>
                        change.scope === 'service' ? [change.ref.localId] : []))],
                } : null;
                if (connectedServicesPageDiagnostic) {
                    logger.debug('[API MACHINE] Connected service Account page', {
                        phase: 'classified', ...connectedServicesPageDiagnostic,
                    });
                }
                const quotaRefreshRecordIds = [...new Set(changes.flatMap(change => {
                    const recordId = readProviderAccountUsageRefreshRecordIdV1(change);
                    return recordId === null ? [] : [recordId];
                }))];
                const hasAutomationSourceChange = changes.some(change => change.kind === 'automation'
                    && change.entityId !== 'automation-source-status');
                const webhookAdmissionPluginIds = [...new Set(changes.flatMap(change => {
                    const parsed = PluginDomainChangeEntrySchema.safeParse(change);
                    return parsed.success && (parsed.data.hint.pluginDomain === 'webhook'
                        || parsed.data.hint.pluginDomain === 'availability') ? [parsed.data.hint.pluginId] : [];
                }))];
                const hasWebhookAdmissionChange = webhookAdmissionPluginIds.length > 0;
                const changedProjectRowKeys = changes.flatMap((change) => {
                    if (change.kind !== 'account') return [];
                    const hint = ProjectAccountRowChangeHintV1Schema.safeParse(change.hint);
                    return hint.success
                        && change.entityId === buildProjectAccountRowPhysicalKeyV1(hint.data.key) ? [hint.data.key] : [];
                });
                const hasSavedSecretCatalogChange = changesRequireSavedSecretCatalogRefresh(changes);
                const hasConnectedMetadataCatalogChange = changes.some(change => change.kind === 'account'
                    && (change.entityId === CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1
                        || change.entityId === CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1));
                const hasNotificationChannelCatalogChange = changes.some(change => change.kind === 'account'
                    && change.entityId === NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1);
                const hasProfileCatalogChange = changes.some((change) => change.kind === 'account'
                    && isProfileCatalogAccountChangeEntityIdV1(change.entityId)
                    || change.kind === 'artifact' && artifactKindsMayIncludeKindV1(readArtifactKindsChangeHintV1(change.hint),
                        [launchProfileArtifactSharingAdapterV1.kind]));
                const approvalProfileChanges = changes.filter(change => change.kind === 'artifact'
                    && artifactKindsMayIncludeKindV1(readArtifactKindsChangeHintV1(change.hint), [APPROVAL_PROFILE_ARTIFACT_KIND_V1]));
                const hasPromptLibraryRowChange = changes.some((change) => change.kind === 'account'
                    && parsePromptLibraryPhysicalKeyV1(change.entityId) !== null);
                const machineSkillInstalls = this.lifecycleDependencies.machineSkillInstalls;
                const installedArtifactIds = new Set(machineSkillInstalls?.target.machineId === this.machine.id
                    ? readActiveMachineSkillInstallArtifactIds({ token: this.token, machineInstallDemand: machineSkillInstalls }) : []);
                const changedInstalledArtifactIds = [...new Set(changes.filter(change => change.kind === 'artifact'
                    && installedArtifactIds.has(change.entityId)).map(change => change.entityId))];
                const hasPromptLibraryChange = hasPromptLibraryRowChange || changedInstalledArtifactIds.length > 0;
                const hasProviderConnectionsChange = changes.some((change) => change.kind === 'account'
                    && change.entityId === PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1);
                const hasAcpCatalogChange = changes.some((change) => change.kind === 'account'
                    && change.entityId === ACP_CATALOG_ACCOUNT_ROW_KEY_V1);
                const hasMcpServerCatalogChange = changes.some((change) => change.kind === 'account'
                    && change.entityId === MCP_SERVER_CATALOG_ACCOUNT_KEY_V1);
                const hasConnectedAccountCatalogChange = changes.some((change) => change.kind === 'account'
                    && parseConnectedAccountCatalogPhysicalKeyV1(change.entityId) !== null);
                const hasTeamChange = changes.some((change) => (
                    change.kind === 'account'
                    && change.entityId === TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1
                ));
                const hasTeamCredentialMaterialChange = changes.some(change => change.kind === 'account'
                    && change.entityId === TEAM_CREDENTIAL_MATERIAL_ACCOUNT_CHANGE_ENTITY_ID_V1);
                const pendingActivationHints = changes.flatMap((change): PendingSessionActivationHintNotification[] => {
                    if (change.kind !== 'session') return [];
                    const hint = asRecord(change.hint);
                    if (!hint) return [];
                    const requestId = typeof hint.pendingActivationRequestId === 'string'
                        ? hint.pendingActivationRequestId.trim()
                        : '';
                    const sessionId = change.entityId.trim();
                    const pendingVersion = hint.pendingVersion;
                    if (
                        !requestId
                        || !sessionId
                        || typeof pendingVersion !== 'number'
                        || !Number.isSafeInteger(pendingVersion)
                        || pendingVersion < 0
                    ) return [];
                    return [{ sessionId, requestId, pendingVersion, source: 'changes' }];
                });
                const deletedSessionChangeNotifications = changes.flatMap((change) => {
                    const deletion = readAuthoritativeSessionDeletionChangeV1(change);
                    if (!deletion) return [];
                    // A durable Session-deletion fact is delivered only by the
                    // authenticated Account whose changes feed produced it. Pin that
                    // Account's operation scope onto the notification so cleanup
                    // targets exactly the partition owning the deleted Session's
                    // operation records, even if the ambient credentials rotate
                    // before the listener runs. Fail closed when the delivering
                    // Account cannot be established: the cursor stays untouched and
                    // the fact replays.
                    const accountScope = resolveExternalSessionOperationAccountScope(
                        configuration.activeServerDir,
                        this.token,
                    );
                    if (!accountScope) {
                        throw new Error('account_changes_account_scope_unavailable');
                    }
                    return [{ ...deletion, accountScope }];
                });

                if (hasRelevantMachineChange) {
                    await this.refreshMachineFromServer(signal);
                    signal.throwIfAborted();
                }
                // The existing grant/Team Account-change producer wakes current Manage holders. The
                // worklist reauthorizes these exact resources; a wake never grants key or access authority.
                // An own `machine` row this daemon already holds is its own content write (the same
                // proof that skips the refresh above): it changed no recipient.
                await this.prepareMachineRecipientEnvelopes([
                    ...(reason !== 'live' ? [this.machine.id] : []),
                    ...changes.filter(change => isMachineProjectionChangeKindV1(change.kind)
                        && !(change.kind === 'machine' && change.entityId === this.machine.id && !hasRelevantMachineChange))
                        .map(change => change.entityId),
                ], signal);
                signal.throwIfAborted();
                await this.prepareSessionRecipientEnvelopes(
                    changes.filter(change => change.kind === 'share').map(change => change.entityId), signal);
                signal.throwIfAborted();
                if (reason !== 'live' || changedProjectRowKeys.length > 0) {
                    await this.notifyAccountProjectRowsChanged({
                        source: reason === 'live' ? 'changes' : reason,
                        signal,
                        ...(reason === 'live' ? { keys: changedProjectRowKeys } : {}),
                    });
                }
                if (reason !== 'live' || hasProfileCatalogChange) {
                    await refreshDemandedActiveProfileCatalog({ token: this.token, signal });
                    signal.throwIfAborted();
                }
                if (reason !== 'live' || approvalProfileChanges.length > 0) {
                    await refreshDemandedActiveApprovalProfileCatalog({ token: this.token, signal,
                        ...(reason === 'live' && approvalProfileChanges.every(change =>
                            !artifactKindsMayIncludeKindV1(readArtifactKindsChangeHintV1(change.hint), []))
                            ? { artifactIds: [...new Set(approvalProfileChanges.map(change => change.entityId))] } : {}) });
                    signal.throwIfAborted();
                }
                const sourceSnapshotBeforeSettings = getActiveAccountSettingsSnapshot();
                const providerCatalogBeforeSettings = sourceSnapshotBeforeSettings?.providerConnectionsCatalog;
                const providerAccountLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
                if (highestAccountSettingsVersion !== null) {
                    await this.notifyAccountSettingsVersionHint({
                        settingsVersion: highestAccountSettingsVersion,
                        source: 'changes',
                    });
                }
                if (reason !== 'live' || hasPromptLibraryChange || highestAccountSettingsVersion !== null) {
                    await this.refreshDemandedPromptLibraryCatalog({ signal, initializeMachineInstallDemand: reason !== 'live',
                        ...(reason === 'live' && !hasPromptLibraryRowChange && highestAccountSettingsVersion === null
                            ? { artifactIds: changedInstalledArtifactIds } : {}) });
                    signal.throwIfAborted();
                }
                const providerSource = getActiveAccountSettingsSnapshot()?.rawSettings;
                if (reason !== 'live' || hasProviderConnectionsChange
                    || providerAccountLifetime !== getActiveAccountSettingsSnapshotLifetimeToken()
                    || highestAccountSettingsVersion !== null && providerSource && Object.hasOwn(providerSource, 'providerSettingsV1')) {
                    await refreshDemandedActiveProviderConnectionsCatalog({ token: this.token, signal });
                    signal.throwIfAborted();
                }
                if (reason !== 'live' || hasAcpCatalogChange || highestAccountSettingsVersion !== null) {
                    await refreshDemandedActiveAcpCatalog({ token: this.token, signal });
                    signal.throwIfAborted();
                }
                if (reason !== 'live' || hasMcpServerCatalogChange || highestAccountSettingsVersion !== null) {
                    await refreshDemandedActiveMcpServerCatalog({ token: this.token, signal });
                    try {
                        await this.executionRunAccountSnapshots?.refreshDemandedMcpCatalog(signal);
                    } catch (error) {
                        signal.throwIfAborted();
                        if (asRecord(error)?.code === 'provider_authorization_changed') throw error;
                        logger.debug('[API MACHINE] Captured MCP catalog refresh unavailable');
                    }
                    signal.throwIfAborted();
                }
                if (reason !== 'live' || hasConnectedAccountCatalogChange || highestAccountSettingsVersion !== null) {
                    await refreshDemandedActiveConnectedAccountCatalogs({ token: this.token, signal });
                    signal.throwIfAborted();
                }
                publishPluginAccountAvailabilityChanges(accountScopeKey, changes,
                    reason === 'live' ? undefined : { accountReadable: true });
                for (const invalidation of pluginAccountSettingsInvalidations) {
                    publishPluginAccountSettingsWatchInvalidation(invalidation);
                }
                for (const invalidation of pluginAccountCollectionInvalidations) {
                    publishPluginAccountCollectionWatchInvalidation({
                        ...invalidation,
                        accountScopeKey,
                    });
                }
                signal.throwIfAborted();

                if (hasConnectedServicesChange || quotaRefreshRecordIds.length > 0) {
                    await this.reconcileConnectedServicesProjection({
                        source: 'changes',
                        executionAuthority,
                        ...(hasConnectedServicesChange && connectedServiceRefs ? { connectedServiceRefs } : {}),
                        ...(quotaRefreshRecordIds.length > 0 ? { quotaRefreshRecordIds } : {}),
                        quotaRefreshOnly: !hasConnectedServicesChange && !hasConnectedAccountCatalogChange,
                    }, signal);
                }
                if (reason !== 'live' || hasSavedSecretCatalogChange) {
                    await this.synchronizeSavedSecretCatalog(signal);
                    signal.throwIfAborted();
                }
                if (reason !== 'live' || hasNotificationChannelCatalogChange || highestAccountSettingsVersion !== null) {
                    await refreshDemandedActiveNotificationChannelCatalog({ token: this.token, signal });
                    signal.throwIfAborted();
                }
                if (reason !== 'live' || hasConnectedMetadataCatalogChange || highestAccountSettingsVersion !== null) {
                    await refreshDemandedActiveConnectedMetadataCatalog({ token: this.token, signal, serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl });
                    signal.throwIfAborted();
                }
                for (const activationHint of pendingActivationHints) {
                    signal.throwIfAborted();
                    await this.notifyPendingSessionActivationHint(activationHint);
                }
                const removedSessionIds = new Set([
                    ...deletedSessionChangeNotifications.map(change => change.sessionId),
                    ...(result.response.sessionAccessWitness?.entries ?? [])
                        .filter(entry => entry.status === 'unavailable').map(entry => entry.sessionId),
                ]);
                for (const change of changes) {
                    const sessionId = change.entityId.trim();
                    if (change.kind === 'session' && sessionId) {
                        signal.throwIfAborted();
                        const availabilityChanged = readSessionFollowReceiverAvailabilityChangedV1(change, after);
                        // Consume this exact durable invalidation before advancing the
                        // Account cursor. Failure replays it through the existing feed.
                        for (const listener of this.sessionChangeListeners) {
                            await listener({ sessionId, cursor: change.cursor,
                                ...(availabilityChanged === undefined ? {} : { followReceiverAvailabilityChanged: availabilityChanged }),
                                ...(removedSessionIds.has(sessionId) ? { removed: true as const }
                                    : {
                                        ...(readSessionFollowSourceChangedV1(change, after) ? {} : { followSourceChanged: false as const }),
                                        ...(readSessionMemoryInputsChangedV1(change, after) ? { pushed: readSessionMemoryPushedFactsV1(change, after) }
                                            : { memoryInputsChanged: false as const }),
                                    }) });
                            signal.throwIfAborted();
                        }
                    }
                    const transcript = readSessionTranscriptChangeHintV1(change);
                    if (!transcript || !sessionId || removedSessionIds.has(sessionId)) continue;
                    // A plain append reaches Memory through its Session change (pushed
                    // transcript seq). Only a row revision since this read invalidates
                    // retained rows; coalescing keeps that revision's own cursor.
                    if (!readSessionTranscriptRevisedV1(change, after)) continue;
                    signal.throwIfAborted();
                    for (const listener of this.sessionTranscriptRevisionListeners) {
                        await listener({ sessionId, ...transcript, cursor: change.cursor });
                    }
                }
                const deliveredRemovalIds = new Set<string>();
                for (const deletion of deletedSessionChangeNotifications) {
                    if (deliveredRemovalIds.has(deletion.sessionId)) continue;
                    signal.throwIfAborted();
                    // Cleanup is part of consuming this durable deletion fact. A
                    // listener failure leaves the Account cursor untouched so the
                    // incumbent changes retry owner replays the exact same deletion.
                    await this.notifySessionDeletedChange(deletion);
                    deliveredRemovalIds.add(deletion.sessionId);
                }
                for (const entry of result.response.sessionAccessWitness?.entries ?? []) {
                    if (entry.status !== 'unavailable' || deliveredRemovalIds.has(entry.sessionId)) continue;
                    signal.throwIfAborted();
                    // Same custody rule as deletion: derived local state for a Session
                    // the Account can no longer reach is cleared before the cursor
                    // advances, so a failed purge replays instead of being lost.
                    await this.notifySessionAccessRevoked({
                        sessionId: entry.sessionId,
                        cursor: entry.cursor,
                    });
                    deliveredRemovalIds.add(entry.sessionId);
                }

                const sourceSnapshot = getActiveAccountSettingsSnapshot();
                const facts: ProviderBrokerRetainedCurrentnessInvalidation['facts'][number][] = [];
                if (reason !== 'live'
                    || providerAccountLifetime !== getActiveAccountSettingsSnapshotLifetimeToken()
                    || !isDeepStrictEqual(sourceSnapshotBeforeSettings?.settingsSecretsReadKeys, sourceSnapshot?.settingsSecretsReadKeys)
                    || !isDeepStrictEqual(sourceSnapshotBeforeSettings?.settings.secrets, sourceSnapshot?.settings.secrets)) {
                    facts.push('all');
                }
                // Keep Home-owned facts explicit even when material authority also
                // changed: direct delivery consumes those facts independently of
                // its snapshot subscription, while retained checks consume `all`.
                if (hasTeamChange) facts.push('teams');
                if (hasTeamCredentialMaterialChange) facts.push('team-credential-material');
                if (hasConnectedServicesChange) facts.push('connected-services');
                if (!facts.includes('all')) {
                    if (hasConnectedAccountCatalogChange) facts.push('connected-catalog');
                    if (hasSavedSecretCatalogChange && (sourceSnapshotBeforeSettings?.savedSecretResources !== sourceSnapshot?.savedSecretResources
                        || sourceSnapshotBeforeSettings?.savedSecretCatalogState !== sourceSnapshot?.savedSecretCatalogState)) facts.push('saved-secrets');
                    if (hasProviderConnectionsChange && (providerCatalogBeforeSettings?.status !== 'ready'
                        || !sameProviderConnectionsDirectMaterial(providerCatalogBeforeSettings,
                            sourceSnapshot?.providerConnectionsCatalog))) facts.push('provider-connections');
                }
                if (facts.length > 0) {
                    signal.throwIfAborted();
                    await this.notifyManagedProviderRetainedCurrentnessInvalidation({
                        source: reason === 'live' ? 'changes' : reason,
                        signal,
                        facts,
                        ...(hasConnectedServicesChange && connectedServiceRefs ? { connectedServiceRefs } : {}),
                    });
                }

                if (reason !== 'live'
                    || hasAutomationSourceChange || hasConnectedServicesChange || hasConnectedAccountCatalogChange
                    || hasWebhookAdmissionChange
                    || highestAccountSettingsVersion !== null) {
                    // Credential/settings wakes can unpark observers without changing
                    // the admitted definition set. Only the feed owner classifies this.
                    // A plugin's availability/webhook change can change only that plugin's
                    // admitted definitions; every other observer keeps its adopted catalog.
                    const onlyPluginScopedChange = reason === 'live' && hasWebhookAdmissionChange
                        && !hasAutomationSourceChange && !hasConnectedServicesChange
                        && !hasConnectedAccountCatalogChange && highestAccountSettingsVersion === null;
                    await this.notifyAutomationEventSourcesInvalidated(signal, {
                        ...(reason === 'reconnect' ? { reason: 'reconnect' as const } : {}),
                        ...(reason === 'live' && !hasAutomationSourceChange && !hasWebhookAdmissionChange
                            ? { definitionsChanged: false } : {}),
                        ...(onlyPluginScopedChange ? { pluginIds: webhookAdmissionPluginIds } : {}),
                    });
                }
                if (reason !== 'live'
                    || hasWebhookAdmissionChange || hasTeamChange) {
                    await this.notifyPluginWebhookInvalidated(signal);
                }
                if (reason !== 'live' || hasTeamChange) {
                    await this.notifyManagedMachinePolicyInvalidated(signal);
                } else if (hasRelevantMachineChange) {
                    // Controller withdrawal applies to every held target. A
                    // mixed page also schedules its changed managed policies.
                    await this.notifyManagedMachinePolicyInvalidated(signal,
                        managedPolicyIds.length ? undefined : { kind: 'currentness' });
                } else if (managedPolicyIds.length) {
                    await this.notifyManagedMachinePolicyInvalidated(signal, { kind: 'managed', managedIds: managedPolicyIds });
                } else {
                    const machineIds = changes.filter(change => change.kind === 'machine' && change.entityId !== this.machine.id)
                        .map(change => change.entityId);
                    if (machineIds.length) await this.notifyManagedMachinePolicyInvalidated(signal, { kind: 'machines', machineIds });
                }
                signal.throwIfAborted();
                if (this.projectionSchedulingClosed || !this.isActiveTransportGeneration(transportGeneration)) return;
                this.accountEncryptionCurrentness?.consumeOwnedFeedPage({ after, changes, nextCursor });
                after = nextCursor;
                consumedPage = true;
                automationWorkInvalidated ||= hasAutomationSourceChange || workflowRunIds.length > 0;
                if (connectedServicesPageDiagnostic) {
                    logger.debug('[API MACHINE] Connected service Account page', {
                        phase: 'settled', ...connectedServicesPageDiagnostic,
                    });
                }
                if (!pageFull
                    && !hasUsablePushedChangesPage(opts.pushedPages ?? [], after, transportGeneration)) return;
                // Classify subsequent pages without repeating reconnect recovery.
                reason = 'live';
            }
        } finally {
            // Retain work demand before acknowledging a consumed prefix, even
            // when a later page fails. The incumbent feed retry owns refusal.
            if (automationWorkInvalidated && !signal.aborted && !this.projectionSchedulingClosed
                && this.isActiveTransportGeneration(transportGeneration)) {
                await this.notifyAutomationWorkInvalidated(signal);
            }
            // Publish once at the operation boundary, including on failure or
            // cancellation, and never acknowledge a partially materialized page.
            // A crash before publication replays from the previous checkpoint.
            if (after !== persistedCursor) await writeAccountChangesCursor(accountId, after);
            signal.throwIfAborted();
            if (consumedPage && this.isActiveTransportGeneration(transportGeneration)) {
                this.accountChangesObserverTransportGeneration = transportGeneration;
            }
        }
    }

    private startChangesSyncWithRetry(opts: AccountChangesSyncDemand): void {
        if (this.projectionSchedulingClosed) return;
        const demand = this.pendingChangesSyncDemand ?? { ...opts };
        if (this.pendingChangesSyncDemand) {
            if (opts.reason !== 'live') demand.reason = opts.reason;
            if (demand.reason !== 'live' || demand.requestedCursor === undefined || opts.requestedCursor === undefined
                || opts.requestedCursor < demand.requestedCursor) {
                // Legacy/reconnect demand and a backwards cursor require a
                // genuine catch-up, never equality suppression.
                delete demand.requestedCursor;
            } else demand.requestedCursor = Math.max(demand.requestedCursor, opts.requestedCursor);
            if (opts.pushedPages) demand.pushedPages = [...demand.pushedPages ?? [], ...opts.pushedPages];
        }
        this.pendingChangesSyncDemand = demand;
        this.connectedServicesProjectionRetry.schedule(async (signal) => {
            if (this.pendingChangesSyncDemand === demand) this.pendingChangesSyncDemand = null;
            try {
                await this.syncChangesOnConnect(demand, signal);
            } catch (error) {
                // The retry owner can prefer newer queued work, including a
                // wake arriving during backoff. Retain that recovery demand in
                // the same pending work until the incumbent retry starts.
                if (!signal.aborted && !this.projectionSchedulingClosed) {
                    const retryDemand = this.pendingChangesSyncDemand ?? demand;
                    if (demand.reason !== 'live') retryDemand.reason = demand.reason;
                    delete retryDemand.requestedCursor;
                    // A retry reads the feed: a held page's snapshot may predate the failure.
                    delete retryDemand.pushedPages;
                    this.pendingChangesSyncDemand = retryDemand;
                }
                if (!signal.aborted) {
                    logger.warn('[API MACHINE] /v2/changes sync failed; retry scheduled', {
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
                throw error;
            }
        }, { runImmediately: true });
    }
}

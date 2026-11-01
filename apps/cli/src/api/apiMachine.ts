/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import axios from 'axios';
import type { AutomationEventSourcesInvalidatedHostEventV1 } from '@happier-dev/protocol/plugins/events/hostReferencesV1';
import { readConnectedServicesAccountChangeV1, readProviderAccountUsageRefreshRecordIdV1 } from '@happier-dev/protocol/changes';
import type { QualifiedConnectedAccountServiceRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type { ProviderBrokerRetainedCurrentnessInvalidation } from '@/providers/broker/brokerRetainedCurrentnessInvalidation';
import { sameProviderConnectionsDirectMaterial } from '@/providers/lifecycle/currentAccountSettingsSnapshot';
import { PluginDomainChangeEntrySchema } from '@happier-dev/protocol/changes/pluginDomain';
import { ManagedMachinePolicyChangeHintV1Schema } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { ManagedWakeTargetV1Schema } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { isProjectWorkspaceSyncPreparationActionV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { createDiscussionReplyReturnPublisher } from '@/discussions/discussionReplyReturnPublisher';
import { DISCUSSION_AGENT_POST_EVENT_V1, DiscussionMachinePublicationV2Schema,
    DiscussionAgentApprovedReplayResponseV1Schema, type DiscussionAgentPostPublicationV1,
    type DiscussionAgentPostResponseV1, type DiscussionWorkflowPostPublicationV1 } from '@happier-dev/protocol/discussions/api';
import { SESSION_PENDING_RESET_START_RELEASE_EVENT_V1, PendingResetStartReleaseRequestV1Schema, PendingResetStartReleaseResponseV1Schema, type PendingResetStartBindingV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { MachineUpdateStateResponseSchema } from '@happier-dev/protocol/machines/metadataUpdate';
import { publishMachineMetadataOnce, readOpenedMachineMetadataSnapshot } from './machine/machineMetadataPublication';
import type { MachineMetadataFieldReadV1, MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import type { MountedAccountPluginExecutionSelectionResolver } from '@/plugins/runtime/invocation/mountedPluginInvocationCaller';
import { registerDaemonMachineResourcesPolicyRpcHandlers, type DaemonMachineResourcesPolicyRoutes } from '@/rpc/handlers/daemonMachineResourcesPolicy';
import { registerDaemonMachineGuardRpcHandlers, type DaemonMachineGuardRoutes } from '@/rpc/handlers/daemonMachineGuard';
import { createMachineAgentInventoryPublication, type MachineAgentInventoryObservation } from '@/capabilities/snapshots/machineAgentInventory';
import { dispatchActionFromRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { registerDaemonStorageRpcHandlers, type DaemonStorageRoutes } from '@/rpc/handlers/storage';
import { parseMachinePublishedMetadataV1, parseMachinePublishedDaemonStateV1, StoredMachinePublishedMetadataV1Schema, StoredMachinePublishedDaemonStateV1Schema, projectMachinePublishedMetadataFromRowV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1, TeamCredentialExternalProviderOperationRetireV1Schema, TeamCredentialExternalProviderOperationRetireResponseV1Schema } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import { randomBytes } from 'node:crypto';
import { MachineLiveStreamDecodedEnvelopeV1Schema, MachineLiveStreamRelayEnvelopeV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { hasMachineLiveStreamSensitiveContentV1, sealMachineLiveStreamEnvelopeV1, openMachineLiveStreamEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';
import type { MachineLiveStreamPayloadErrorCodeV1, MachineLiveStreamWireEnvelopeV1 } from '@happier-dev/protocol';
import { isDeepStrictEqual } from 'node:util';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
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
import { createAccountScopedCryptoMaterialSnapshotV1, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { EXTERNAL_SESSION_SOURCE_UNAVAILABLE_OCCURRENCE_EVENT_V1 } from '@happier-dev/protocol/sessions/external/secureRefreshV1';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import type { FeaturesResponse, IrohEndpointDescriptorV1, ActionOperationRevisionEphemeralV1, ConnectedServiceExecutionAuthorityV1, ExternalSessionSourceUnavailableOccurrenceV1 } from '@happier-dev/protocol';
import { ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1, projectActionOperationSnapshotForV1Reader } from '@happier-dev/protocol/actions/operations/v1';
import { signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { fetchAccountProfile } from './accountProfile';
import { fetchAccountEncryptionCurrentness, AccountEncryptionCurrentnessUnavailableError } from './client/connectedServiceCredentialApi';
import { readAccountEncryptionModeOnce } from './client/accountEncryptionMode';
import { acquireRequesterAccountEncryptionCurrentness, waitForObservation } from './client/accountEncryptionCurrentnessObservation';
import { resolveConnectedServicesServerApiTimeoutMs } from './client/connectedServicesServerApiTimeout';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { projectRpcRequesterWorkAttribution } from '@/daemon/lifecycle/requesterWorkAttribution';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { classifyTransportErrorToProbeResult } from '@/api/connection/classifyTransportErrorToProbeResult';
import { resolveMachinePendingResetStartCapability, resolveMachineSessionInputAdmissionCapability } from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import { createCurrentMachineExecutionOriginContextResolver } from './machine/resolveCurrentMachineExecutionOriginContext';
import { assertResolvedHomeTargetIdentity, HomeTargetResolutionError } from '@happier-dev/cli-common/homeTarget';
import { resolveCliHomeTarget } from '@/server/homeTarget';
import { MachineInstallationPublicIdentityV1Schema, type MachineInstallationPublicIdentityV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { USAGE_SOURCES_INVALIDATION_EVENT_V1, type UsageSourcesInvalidationV1 } from '@happier-dev/protocol/usage/usageSources';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { resolveSessionRpcContent } from '@/session/transport/rpc/sessionRpc';
import { createMachineSkillHostService, resolveMachineSkillInstallTarget } from '@/prompts/skills/machineInstall/machineSkillHost';
import { createMachineSkillActionExecutor } from '@/prompts/skills/machineInstall/machineSkillActionExecutor';
import { createExternalActionMachineRpcExecution, verifyExternalActionExecutionAuthorizationCurrent } from './externalActionExecutionAuthorization';
import { externalActionTargetsEqualV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { PendingActivationRequestedEphemeralV1Schema, type SessionInputMachineTargetV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1, SessionMessageReplyMachineMutationV1Schema,
    SessionMessageReplyMutationResultV1Schema, SessionMessageReplyPendingHintV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { recoverSessionMessageRepliesForMachine } from '@/session/services/sessionMessageReply';

import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import { callSocketRpc, isSocketIoAckTimeoutError, type SocketRpcContent } from '@happier-dev/sync-client';
import type { SessionActionRpcTransport } from '@/session/actions/createCliActionDeps';
import { readRpcErrorCode, RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncTargetRoutingV1Schema,
    WorkspaceSyncSeedRoutingV1Schema, type WorkspaceSyncSeedRoutingV1,
    WorkspaceSyncSourceWriterTargetRoutingV1Schema, type WorkspaceSyncSourceWriterTargetRoutingV1,
    type WorkspaceSyncSourceRoutingV1, type WorkspaceSyncTargetRoutingV1 } from '@happier-dev/protocol/socketRpc';
import { createWorkspaceSyncTargetContent } from './rpc/workspaceSyncTargetContent';
import { WorkspaceSyncHandoffSourcePhaseRequestV1Schema, WorkspaceSyncHandoffSourcePhaseResultV1Schema,
    HandoffTargetReplacementPreflightResultV1Schema, WorkspaceSyncTargetBootstrapPrepareResultV1Schema,
    WorkspaceSyncTargetBootstrapReleaseResultV1Schema,
    type WorkspaceSyncHandoffSourcePhaseRequestV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { WorkspaceSyncSeedExportPrepareV1Schema, type WorkspaceSyncSeedExportPrepareV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { buildActionExecutorContextForRpc, projectWorkspaceSyncPhysicalContextFromActionContext, type RpcActionExecutor, type RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { isExternalActionAuthorizationBoundToEnvelope } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { OpenProjectInputV1Schema, OpenProjectResultV1Schema, ProjectOpenSyncMaterializationResultV1Schema, type OpenProjectInputV1, type OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { WorkspaceSyncPrepareBetweenRequestV1Schema, WorkspaceSyncPrepareBetweenResultV1Schema, type WorkspaceSyncPrepareBetweenRequestV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { decodeBase64 } from './encryption';
import { resolveWorkspaceSyncTransportAddress } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { readWorkspaceSyncChildMachineFacts } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import type { WorkspaceSyncTargetPhaseDescriptor } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { applyWorkspaceFileReplace, previewWorkspaceFileReplace } from '@/rpc/handlers/workspaceFileReplace';
import { registerLanguageIntelligenceHandlers } from '@/rpc/handlers/languageIntelligence';
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
import { registerDaemonProcessesRpcHandlers, type DaemonProcessesRoutes } from '@/rpc/handlers/daemonProcesses';
import {
    registerDaemonBrowserControlHandler,
} from '@/rpc/handlers/daemonBrowserControl';
import { registerDaemonComputerHandler } from '@/rpc/handlers/daemonComputer';
import { registerManagedFiniteWake } from '@/rpc/handlers/managedFiniteWake';
import type { ComputerRoutes } from '@/daemon/computer/routes';
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
import { createProjectDefinitionAction, registerProjectDefinitionHandlers } from '@/rpc/handlers/projectDefinitions';
import { projectNativeSystemIo } from '@/workspaces/projectSetup/projectNativeSystemIo';
import { executeFilesystemMutationAction } from '@/rpc/handlers/fileSystem/pathMutationHandlers';
import { createReadFileRpcActionExecutor } from '@/rpc/handlers/fileSystem/readFileHandler';
import { createWriteFileRpcActionExecutor } from '@/rpc/handlers/fileSystem/writeFileHandler';
import { createDirectoryRpcActionExecutor } from '@/rpc/handlers/fileSystem/directoryHandlers';
import { FILESYSTEM_MUTATION_ACTION_IDS } from '@happier-dev/protocol/actions/filesystemActionFamily';
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
import { SocketRpcAnsweringClientCandidatesV1Schema, type SocketRpcAnsweringClientCandidateV1 } from '@happier-dev/protocol/socketRpc';
import { isCurrentUiContextClientRpcMethod } from '@happier-dev/protocol/actions/clientDispatchV1';
import { EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1 } from '@happier-dev/protocol/sessions/external/operationActionsV1';
import { EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1 } from '@happier-dev/protocol/sessions/external/statusDemandV1';
import { MACHINE_LIVE_STREAM_SOCKET_EVENT } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT } from '@happier-dev/protocol/machines/peer/mediation/tunnel/relay';
import { TRANSFER_RELAY_V2_SOCKET_EVENT } from '@happier-dev/protocol/transfers/relay/v2/socketEvents';
import type { ExternalSessionTranscriptInvalidationV1, ExternalSessionOperationSocketCommandV1, ExternalSessionOperationSocketResponseV1, ExternalSessionStatusDemandDaemonMessageV1, MachineLiveStreamRelayEnvelopeV1, MachineTransferReceiveEnvelope, MachineTransferSendEnvelope, PeerTcpTunnelRelayEnvelope, ExactSessionTurnEndMutationV1, TransferRelayV2SendEnvelope } from '@happier-dev/protocol';
import { fetchChanges, fetchChangesAccountId } from './changes';
import { buildProjectAccountRowPhysicalKeyV1, ProjectAccountRowChangeHintV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { readAccountChangesCursor, writeAccountChangesCursor } from '@/persistence';
import {
    publishPluginAccountCollectionWatchInvalidation,
    publishPluginAccountAvailabilityChanges,
    publishPluginAccountSettingsWatchInvalidation,
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
import { refreshDemandedActiveProfileCatalog } from '@/settings/profiles/hydrateProfileCatalog';
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
import { createTransientSessionMediaReadAllowance } from '@/session/media/readAllowance';
import type { LocalServicePreviewRoutes } from '@/daemon/local/services/preview/routes';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import type { BrowserContextRoutes } from '@/daemon/browser/context/routes';
import type { BrowserDiagnosticsRoutes } from '@/daemon/browser/diagnostics/routes';
import type { BrowserRecordingRoutes } from '@/daemon/browser/recording/routes';
import type { SimulatorPreviewRoutes } from '@/daemon/devices/simulator/previewRoutes.types';
import type { ConnectedAccountDaemonRuntime } from '@/daemon/connectedServices/ConnectedAccountDaemonRuntime';
import type { DaemonConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import type { AgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';

import type { DaemonToServerEvents, ServerToDaemonEvents } from './machine/socketTypes';
import { readAuthoritativeSessionDeletionChangeV1, readSessionTranscriptChangeHintV1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
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
import {
    registerMachineConnectedAccountRpcHandlers,
    type ConnectedServicePoolSelectionRead,
} from './machine/rpcHandlers.connectedAccounts';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent, verifyManagedActivityTargetCurrent,
    readMachineRpcAdmissionCurrent, doesWorkspaceSyncSourceRootMatchRouting, doesWorkspaceSyncSourceWriterTargetRootMatchRouting,
    doesWorkspaceSyncTargetRequestMatchRouting, doesWorkspaceSyncTargetRoutingMatchWriterTarget,
    readWorkspaceSyncTargetMethod, type MachineRpcAdmissionBoundary } from './machine/machineRpcAuthorization';
import type { MachineTerminalAccountReadRuntime, MachineTerminalOwnSessionReadRuntime } from './machine/rpcHandlers.terminal';
import { resolveAdmittedRequesterAccountReadRuntime } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { inspectProjectSetupFromRuntime } from '@/workspaces/projectSetup/projectSetupReadiness';
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

export type AccountSettingsVersionHintSource = 'changes' | 'cursor-gone' | 'page-limit';

export function emitActionOperationSnapshotV1(params: Readonly<{
    socket: Pick<Socket<ServerToDaemonEvents, DaemonToServerEvents>, 'emit'> | null;
    machineId: string;
    content: import('@happier-dev/protocol/actions/operations/v1').ActionOperationRevisionEphemeralV1['content'];
}>): void {
    params.socket?.emit(ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1, {
        type: ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1,
        machineId: params.machineId,
        content: params.content,
    });
}

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
        sessionInputAdmission: { protocolVersions: [1, 2] as const },
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
    /** Current daemon control listener port, published only after machine-control readiness. */
    controlPort?: number;
    /** The daemon's one outside-install copy owner consumes current Prompt Library reads. */
    machineSkillInstalls?: MachineSkillInstallCatalogDemand & Readonly<{
        refresh(input: Readonly<{ signal: AbortSignal; artifactIds?: readonly string[] }>): Promise<void>;
    }>;
    readSpawnFailureLimits?: MachineRpcHandlerDeps['readSpawnFailureLimits'];
    ownerRemainder?: MachineRpcHandlerDeps['ownerRemainder'];
    readMachineEffectiveCores?: MachineRpcHandlerDeps['readMachineEffectiveCores'];
    requesterSessionRuntime?: MachineRpcHandlerDeps['requesterSessionRuntime'];
    requesterBootstrapBoundary?: MachineRpcHandlerDeps['requesterBootstrapBoundary'];
    managedActivity?: Pick<ManagedActivityRpcOwner, 'activity' | 'admissionDrain'>;
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
    resolveServerFeaturesSnapshot?: () => Promise<Awaited<ReturnType<typeof fetchServerFeaturesSnapshot>> | undefined>;
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
}>;

export type MachinePublicationOutcome = 'published' | 'unchanged' | 'suppressed';

/** Host-local classification; Machine activity is not a new policy scheduling fact. */
export type ManagedMachinePolicyInvalidation = Readonly<{ kind: 'currentness' }>
    | Readonly<{ kind: 'machines'; machineIds: readonly string[] }>;

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

type SessionFollowSourceInvalidation = Readonly<{ full: boolean; workflowRunIds: readonly string[]; discussionIds?: readonly string[] }>;

function isMachineReplacedSocketError(error: unknown): boolean {
    const record = asRecord(error);
    const data = asRecord(record?.data);
    const errorCode = typeof data?.error === 'string' ? data.error.trim() : '';
    const message = typeof record?.message === 'string' ? record.message.trim() : '';
    const statusRaw = data?.statusCode ?? data?.status;
    const statusCode = typeof statusRaw === 'number' && Number.isFinite(statusRaw) ? statusRaw : null;
    return statusCode === 410 && (errorCode === 'machine-replaced' || errorCode === 'machine_replaced' || message === 'machine-replaced');
}

/** Serialize the consumed machine activity stream through one Account encryption boundary. */
export function createActionOperationSnapshotPublisher(input: Readonly<{
    resolveAccountId(): Promise<string | null>;
    serverBaseUrl: string;
    readCredentials: typeof readStoredCredentials;
    publishContent(content: import('@happier-dev/protocol/actions/operations/v1').ActionOperationRevisionEphemeralV1['content']): void;
}>) {
    type Snapshot = import('@happier-dev/protocol/actions').ActionOperationSnapshotV1;
    const queued = new Map<string, Snapshot>();
    let draining: Promise<void> | null = null;
    const publishBatch = async (snapshots: readonly Snapshot[]): Promise<void> => {
        const credentials = await input.readCredentials().catch(() => null);
        if (!credentials) return;
        const accountId = await input.resolveAccountId();
        if (!accountId || readAccountIdFromToken(credentials.token) !== accountId) {
            logger.warn('Withheld Action operation snapshot because the credential Account differs from the machine connection Account');
            return;
        }
        const admitted = snapshots.filter(snapshot => snapshot.scope.accountId === accountId);
        if (admitted.length !== snapshots.length) {
            logger.warn('Withheld Action operation snapshot because the credential Account differs from the machine connection Account');
        }
        if (admitted.length === 0) return;
        const accountMode = await readAccountEncryptionModeOnce({ scope: { token: credentials.token, serverBaseUrl: input.serverBaseUrl }, request: () => axios.get(
            `${input.serverBaseUrl.replace(/\/+$/, '')}/v1/account/encryption`, {
                headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${credentials.token}` },
                timeout: resolveConnectedServicesServerApiTimeoutMs(), validateStatus: () => true,
            },
        ) });
        if (accountMode.kind !== 'resolved') return;
        const currentCredentials = await input.readCredentials().catch(() => null);
        if (!isDeepStrictEqual(currentCredentials, credentials)) {
            if (currentCredentials && readAccountIdFromToken(currentCredentials.token) !== accountId) {
                logger.warn('Withheld Action operation snapshot because the credential Account differs from the machine connection Account');
            }
            return;
        }
        if (accountMode.mode === 'plain') {
            for (const snapshot of admitted) {
                input.publishContent({ t: 'plain', v: projectActionOperationSnapshotForV1Reader(snapshot) });
            }
            return;
        }
        if (!credentials.encryption) return;
        const material = credentials.encryption.type === 'legacy'
            ? { type: 'legacy' as const, secret: credentials.encryption.secret }
            : { type: 'dataKey' as const, machineKey: credentials.encryption.machineKey };
        for (const snapshot of admitted) {
            input.publishContent({ t: 'encrypted', c: sealAccountScopedBlobCiphertext({
                kind: 'action_operation_snapshot', material, payload: projectActionOperationSnapshotForV1Reader(snapshot),
                randomBytes: (length) => new Uint8Array(randomBytes(length)),
            }) });
        }
    };
    const drain = async (): Promise<void> => {
        while (queued.size > 0) {
            const batch = [...queued.values()];
            queued.clear();
            try {
                await publishBatch(batch);
            } catch (error) {
                logger.warn('Failed to publish Action operation snapshot', { error: serializeAxiosErrorForLog(error) });
            }
        }
    };
    const ensureDrain = (): Promise<void> => {
        if (draining) return draining;
        draining = drain().then(async () => {
            draining = null;
            // A revision queued between the drain's final empty check and this
            // continuation belongs to the same publication promise.
            if (queued.size > 0) await ensureDrain();
        });
        return draining;
    };
    return (snapshot: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1): Promise<void> => {
        const queuedSnapshot = queued.get(snapshot.operationId);
        if (!queuedSnapshot || snapshot.revision > queuedSnapshot.revision) queued.set(snapshot.operationId, snapshot);
        return ensureDrain();
    };
}

type AccountChangesSyncDemand = {
    reason: 'connect' | 'reconnect' | 'live';
    requestedCursor?: number;
};

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
    private readonly rpcLifecycleRegistrations: MachineRpcLifecycleRegistration[] = [];
    private executionRunAccountSnapshots: ReturnType<typeof createExecutionRunAccountSettingsSnapshotResolver> | null = null;
    private readonly executionBudgetRegistry = createExecutionBudgetRegistry();
    private readonly machineRuntimeServerHttpBaseUrl: string;
    private readonly machineRuntimeServerId = configuration.activeServerId;
    private readonly machineRuntimeInstallationId = readInstallationIdentityIfExistsSync()?.installationId ?? null;
    private managedActivityPublicationCleanup: (() => void) | null = null;
    private readonly liveWorkProducer = createLiveWorkProducerGroup(() => {
        const registration = this.rpcLifecycleRegistrations.at(-1);
        return registration?.liveWorkProducers
            ? [this.actionOperationRuntime.activity, ...registration.liveWorkProducers]
            : null;
    });

    getLiveWorkProducer() { return this.liveWorkProducer; }

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
    async resolveMachineEnvironmentRuntime(ingress: RpcHandlerContext): Promise<(MachineTerminalAccountReadRuntime & Readonly<{ isCustodyCurrent(): Promise<boolean> }>) | null> {
        return this.resolveInstalledMachineAccountRuntime(ingress);
    }

    /** Private Session/Project reads never borrow an installed custodian's Account. */
    async resolveOwnSessionRuntime(ingress: RpcHandlerContext): Promise<MachineTerminalOwnSessionReadRuntime | null> {
        if (ingress.callerInputAuthorization) {
            if (!this.machineRuntimeInstallationId) return null;
            return await resolveAdmittedRequesterAccountReadRuntime({ ingress, serverId: this.machineRuntimeServerId,
                machineId: this.machine.id, installationId: this.machineRuntimeInstallationId,
                isInstalledCurrent: () => !this.projectionSchedulingClosed
                    && configuration.activeServerId === this.machineRuntimeServerId
                    && readInstallationIdentityIfExistsSync()?.installationId === this.machineRuntimeInstallationId });
        }
        if (ingress.machineAdmission?.actorAccountId !== ingress.machineAdmission?.custodianAccountId) return null;
        return this.resolveInstalledMachineAccountRuntime(ingress);
    }

    private async resolveInstalledMachineAccountRuntime(ingress: RpcHandlerContext): Promise<(MachineTerminalAccountReadRuntime & Readonly<{ isCustodyCurrent(): Promise<boolean> }>) | null> {
        const admission = ingress.machineAdmission;
        if (!admission || !ingress.verifyMachineAdmissionCurrent
            || admission.machineId !== this.machine.id
            || !this.machineRuntimeInstallationId
            || admission.installationId !== this.machineRuntimeInstallationId) return null;
        try {
            if (ingress.signal.aborted || !await ingress.verifyMachineAdmissionCurrent()) return null;
            const runtime = await this.resolveInstalledAccountRuntime(ingress.signal, admission.custodianAccountId);
            if (!runtime) return null;
            const isCurrent = async () => await runtime.isCurrent() && await ingress.verifyMachineAdmissionCurrent!()
                && await runtime.isCurrent();
            if (!await isCurrent()) return null;
            return { ...runtime, isCurrent };
        } catch { return null; }
    }

    private async resolveInstalledAccountRuntime(signal: AbortSignal, expectedAccountId?: string): Promise<(MachineTerminalAccountReadRuntime & Readonly<{ isCurrent(): Promise<boolean>; isCustodyCurrent(): Promise<boolean> }>) | null> {
        if (!this.machineRuntimeInstallationId) return null;
        const ownerCurrent = () => !this.projectionSchedulingClosed
            && configuration.activeServerId === this.machineRuntimeServerId
            && readInstallationIdentityIfExistsSync()?.installationId === this.machineRuntimeInstallationId;
        try {
            if (signal.aborted || !ownerCurrent()) return null;
            const accountId = await runWithServerHttpBaseUrl(this.machineRuntimeServerHttpBaseUrl,
                () => this.getAccountId(signal));
            if (!accountId || !ownerCurrent() || expectedAccountId !== undefined && accountId !== expectedAccountId) return null;
            const credentials = await readStoredCredentialsForServerId(this.machineRuntimeServerId);
            if (!credentials || credentials.token !== this.token) return null;
            const credentialsCurrent = async () => ownerCurrent() && sameStoredCredentials(credentials,
                await readStoredCredentialsForServerId(this.machineRuntimeServerId).catch(() => null)) && ownerCurrent();
            const isCurrent = async () => !signal.aborted && await credentialsCurrent() && !signal.aborted;
            if (!await isCurrent()) return null;
            return { serverId: this.machineRuntimeServerId, machineId: this.machine.id, accountId,
                credentials, serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl, isCurrent, isCustodyCurrent: credentialsCurrent };
        } catch { return null; }
    }

    /** Both mounted Action ingresses read the same current installed Account custody. */
    readonly resolveAccountPluginExecutionSelection: MountedAccountPluginExecutionSelectionResolver = async (pluginId, registry, signal) => {
        const unavailable = { kind: 'unavailable' as const, code: 'plugin_account_execution_unavailable' as const };
        const runtime = await this.resolveInstalledAccountRuntime(signal ?? new AbortController().signal);
        if (!runtime || !await runtime.isCurrent()) return unavailable;
        const { readCurrentMountedAccountPluginExecutionSelection } = await import('@/plugins/runtime/accountPluginActivationSource');
        return await readCurrentMountedAccountPluginExecutionSelection({ pluginId, registry, runtime, ...(signal ? { signal } : {}) });
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
        'activatePurposeBindings' | 'listActionFormConnectedAccountOptions'
    > | null = null;
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
    /** Reflects only an installed provider-broker application handler; the
     * composition root owns the fact, this client only publishes it. */
    private providerBrokerIngressAdvertised = false;
    private providerBrokerAccountConnectionIngressLive = false;
    private agentCatalogObservation: AgentProviderCatalogObservationService | null = null;
    private readonly projectAgentInventoryPublication = createMachineAgentInventoryPublication();
    private activeTransportGeneration = 0;
    private sessionMessageReplyRecovery: {
        socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
        generation: number;
        controller: AbortController;
        requested: Set<string | null>;
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
    private readonly actionOperationRuntime: HostActionOperationRuntime;

    observeActionExecution(request: Parameters<HostActionOperationRuntime['observeExecution']>[0]) {
        return this.actionOperationRuntime.observeExecution(request);
    }

    runActionOperation(request: Parameters<HostActionOperationRuntime['runActionOperation']>[0]) {
        return runHostActionOperation(observed => this.observeActionExecution(observed), request);
    }

    /** Installed content transport facts, independent of the invoking Account's mode. */
    getMachineEncryptionMode(): 'plain' | 'e2ee' {
        return this.machine.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    }

    cleanupRequesterMachineOperations(input: Parameters<HostActionOperationRuntime['cleanupRequesterMachineOperations']>[0]) {
        return this.actionOperationRuntime.cleanupRequesterMachineOperations(input);
    }

    private shouldSuppressMachinePublication(allowWhileQuiescing = false): boolean {
        return !allowWhileQuiescing
            && this.lifecycleDependencies.isDaemonQuiescing?.() === true;
    }

    private teardownActiveSocket(): void {
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
        this.socket = null;
    }

    /** The existing requester visitor reopens only its retained exact Session custody. */
    async requestSessionMessageReplyRecoveryForSession(sessionId: string): Promise<void> {
        const socket = this.socket;
        if (!socket) return;
        await this.requestSessionMessageReplyRecovery(socket, this.activeTransportGeneration, sessionId);
    }

    private requestSessionMessageReplyRecovery(socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>, generation: number,
        requesterSessionId: string | null = null): Promise<void> | undefined {
        if (this.projectionSchedulingClosed || this.socket !== socket || !socket.connected
            || !this.isActiveTransportGeneration(generation)
            || this.machineControlRunningGeneration !== generation) return;
        let recovery = this.sessionMessageReplyRecovery;
        if (!recovery || recovery.socket !== socket || recovery.generation !== generation) {
            recovery?.controller.abort();
            recovery = { socket, generation, controller: new AbortController(), requested: new Set(), promise: null };
            this.sessionMessageReplyRecovery = recovery;
        }
        // Coalesce read invalidations, never payloads or delivery custody. Null is
        // the installed Account; requester scopes must resolve their own lifetime.
        recovery.requested.add(requesterSessionId);
        if (recovery.promise) return recovery.promise;
        const active = recovery;
        const transportCurrent = () => !this.projectionSchedulingClosed && !active.controller.signal.aborted
            && this.sessionMessageReplyRecovery === active && this.socket === socket && socket.connected
            && this.isActiveTransportGeneration(generation);
        active.promise = (async () => {
            while (active.requested.size && transportCurrent()) {
                const next = active.requested.values().next();
                if (next.done) break;
                const scope = next.value;
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
        const missingCoreHandlers = REQUIRED_MACHINE_CONTROL_RPC_METHODS.filter(
            (method) => !this.rpcHandlerManager.hasHandler(method),
        );
        if (missingCoreHandlers.length > 0) {
            return {
                ready: false,
                readiness: { status: 'disconnected', missingMethods: missingCoreHandlers },
            };
        }

        const readiness = await this.rpcHandlerManager.waitForRegisteredHandlers(
            REQUIRED_MACHINE_CONTROL_RPC_METHODS,
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
            const capabilities = await this.resolveCurrentMachineOperationProtocolCapabilitiesForPublication();
            if (
                capabilities !== null
                && this.advertisedOperationProtocolCapabilitiesGeneration !== transportGeneration
            ) {
                // A rejected publication leaves the server's projection unknown, so it is
                // deliberately not recorded as advertised and is allowed to reject this
                // whole publication: without the running mark, the next registration
                // acknowledgement re-enters here and publishes the capabilities again.
                await this.publishOperationProtocolCapabilitiesOnSocket(socket, capabilities);
                this.advertisedOperationProtocolCapabilitiesGeneration = transportGeneration;
            }
            if (
                this.socket !== socket
                || this.activeTransportGeneration !== transportGeneration
                || socket.connected !== true
            ) {
                return false;
            }
            await this.updateDaemonState((state) => ({
                ...state,
                status: 'running',
                pid: process.pid,
                contributionRegistryProjectionRevision: state?.contributionRegistryProjectionRevision ?? 0,
                httpPort: this.lifecycleDependencies.controlPort ?? state?.httpPort,
                // A socket reconnect of this process is not a restart; readers treat a new startedAt as a replaced daemon.
                startedAt: state?.pid === process.pid && typeof state.startedAt === 'number' ? state.startedAt : Date.now(),
            }));
            if (
                this.socket === socket
                && this.activeTransportGeneration === transportGeneration
                && socket.connected === true
            ) {
                this.machineControlRunningGeneration = transportGeneration;
                // Connect precedes server-side asynchronous admission. Existing
                // registration readiness proves its Machine listeners are mounted.
                this.requestSessionMessageReplyRecovery(socket, transportGeneration);
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
        const machineRuntimeServerHttpBaseUrl = resolveServerHttpBaseUrl();
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
                        serverHttpBaseUrl: machineRuntimeServerHttpBaseUrl, machineId, signal, isCredentialCurrent: isCurrent }));
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
                            serverHttpBaseUrl: machineRuntimeServerHttpBaseUrl,
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
        this.machineRuntimeServerHttpBaseUrl = machineRuntimeServerHttpBaseUrl;
        this.machineContentContext = { codec: createMachineContentCodec(this.machine), ready: true };
        this.sessionSyncPendingInputServerContractController =
            createSessionSyncPendingInputServerContractController({
                serverUrl: resolveServerHttpBaseUrl(),
                token: this.token,
            });
        const rpcTransportConfig = this.machine.encryptionMode === 'plain'
            ? { encryptionMode: 'plain' as const }
            : {
                encryptionMode: 'e2ee' as const,
                encryptionKey: this.machine.encryptionKey,
                encryptionVariant: this.machine.encryptionVariant,
            };
        this.machineRpcAdmissionBoundary = {
            machineId: this.machine.id,
            resolveCustodianAccountId: (signal) => runWithServerHttpBaseUrl(machineRuntimeServerHttpBaseUrl, () => this.getAccountId(signal)),
            resolveInstallationId: () => readInstallationIdentityIfExistsSync()?.installationId ?? null,
            verifyMachineAdmission: async ({ context, method, signal, custodySubjectAccountId, workspaceSyncSourceRouting, workspaceSyncSourceExecution, workspaceSyncTargetRouting, workspaceSyncSourceWriterTargetRouting, workspaceSyncSeedRouting, callerInputAuthorization }) => {
                const installation = readInstallationIdentityIfExistsSync();
                if (!installation || !workspaceSyncSourceRouting && !workspaceSyncTargetRouting && !workspaceSyncSourceWriterTargetRouting && !workspaceSyncSeedRouting
                    && installation.installationId !== context.installationId) return false;
                return verifyMachineRpcAdmissionCurrent({ context, method,
                    ...(workspaceSyncSeedRouting ? { workspaceSyncSeedRouting,
                        workspaceSyncSeedReceiver: { machineId: this.machine.id, installationId: installation.installationId,
                            accountId: readAccountIdFromToken(this.token) ?? '' },
                        ...(callerInputAuthorization ? { callerInputAuthorization } : {}) } : {}),
                    ...(workspaceSyncSourceExecution ? { workspaceSyncSourceExecution } : {}),
                    ...(workspaceSyncSourceExecution?.originalActionEnvelope && callerInputAuthorization ? { callerInputAuthorization } : {}),
                    ...(custodySubjectAccountId !== undefined ? { custodySubjectAccountId } : {}),
                    ...(workspaceSyncSourceRouting ? { workspaceSyncSourceRouting,
                        workspaceSyncSourceReceiver: { machineId: this.machine.id, installationId: installation.installationId },
                        ...(callerInputAuthorization ? { callerInputAuthorization } : {}) } : {}),
                    ...(workspaceSyncTargetRouting ? { workspaceSyncTargetRouting,
                        workspaceSyncTargetReceiver: { machineId: this.machine.id, installationId: installation.installationId } } : {}),
                    ...(workspaceSyncSourceWriterTargetRouting ? { workspaceSyncSourceWriterTargetRouting,
                        ...(!workspaceSyncTargetRouting ? { workspaceSyncSourceWriterTargetReceiver: {
                            machineId: this.machine.id, installationId: installation.installationId,
                            accountId: readAccountIdFromToken(this.token) ?? '' } } : {}),
                        ...(callerInputAuthorization ? { callerInputAuthorization } : {}) } : {}),
                    privateKey: installation.privateKey, daemonToken: this.token,
                    serverHttpBaseUrl: machineRuntimeServerHttpBaseUrl,
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
                const context = { actorAccountId: accountId, custodianAccountId: accountId, machineId: this.machine.id,
                    installationId: installation.installationId, role: 'manage' as const, encryptionMode: this.machine.encryptionMode ?? 'e2ee' };
                const sessionDecision = { sessionId: authorization.sessionId, actor: authorization.actor,
                    authentication: authorization.authentication };
                const isCurrent = async () => !signal.aborted && !this.projectionSchedulingClosed
                    && sameStoredCredentials(credentials, await readStoredCredentialsForServerId(machineRuntimeServerId).catch(() => null))
                    && readInstallationIdentityIfExistsSync()?.installationId === installation.installationId
                    && await verifyMachineRpcAdmissionCurrent({ context,
                        method: `${authorization.sessionId}:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`, sessionDecision,
                        privateKey: installation.privateKey, daemonToken: credentials.token,
                        serverHttpBaseUrl: machineRuntimeServerHttpBaseUrl, signal });
                if (!await isCurrent()) return null;
                const transport = await runWithServerHttpBaseUrl(machineRuntimeServerHttpBaseUrl, () => resolveSessionTransportContext({
                    credentials, idOrPrefix: authorization.sessionId, signal,
                }));
                if (!transport.ok || transport.sessionId !== authorization.sessionId) return null;
                return { content: resolveSessionRpcContent(transport), isCurrent };
            },
            prepareRequesterAccountContext: (input) => this.externalActionIngressOwner?.prepareRequesterAccountContext?.(input)
                ?? Promise.resolve(null),
            resolveExternalActionEncryption: (signal, authorization) => this.resolveExternalActionEncryption(signal, authorization),
            authorizeRequest: (request) => authorizeMachineRpcRequest(request, this.machineRpcAdmissionBoundary),
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
        const operationInstallation = readInstallationIdentityIfExistsSync();
        this.actionOperationRuntime = createHostActionOperationRuntime({
            serverId: configuration.activeServerId,
            machineId: this.machine.id,
            ...(operationInstallation ? { custodyBinding: {
                serverId: machineRuntimeServerId, installationId: operationInstallation.installationId,
            } } : {}),
            resolveAccountId: async () => await this.getAccountId(),
            ...(this.lifecycleDependencies.onProjectOperationInspection
                ? { onInspection: this.lifecycleDependencies.onProjectOperationInspection } : {}),
            publishSnapshot: createActionOperationSnapshotPublisher({
                resolveAccountId: async () => await this.getAccountId(),
                serverBaseUrl: machineRuntimeServerHttpBaseUrl,
                readCredentials: async () => this.projectionSchedulingClosed || configuration.activeServerId !== machineRuntimeServerId
                    ? null : await readStoredCredentialsForServerId(machineRuntimeServerId),
                publishContent: (content) => emitActionOperationSnapshotV1({
                    socket: this.socket, machineId: this.machine.id, content,
                }),
            }),
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

        this.machineRpcWorkingDirectory = resolveMachineRpcWorkingDirectory();
        this.filesystemAccessPolicy = resolveFilesystemAccessPolicy();
        const resolveCurrentMachineExecutionOriginContext = createCurrentMachineExecutionOriginContextResolver({
            serverUrl: resolveServerHttpBaseUrl(),
            resolveCurrentMachineId: () => this.machine.id,
        });
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
                resolveServerFeaturesSnapshot: async () => (
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
            accessPolicy: this.filesystemAccessPolicy,
            serverId: this.machineRuntimeServerId,
            machineId: this.machine.id, resolveActionExecutor: resolveWorkspaceMutationActionExecutor,
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
        this.fileSystemTransferRelayOwner = {
            store: fileSystemHandlers.transferSessionStore,
            lifecycle: createTransferSessionLifecycle({
                store: fileSystemHandlers.transferSessionStore,
                chunkSizeBytes: configuration.filesTransferChunkBytes,
            }),
        };
        registerMachineFileBrowserHandlers({
            rpcHandlerManager: this.rpcHandlerManager,
            workingDirectory: this.machineRpcWorkingDirectory,
            accessPolicy: this.filesystemAccessPolicy,
        });
        registerWorkspaceAnchorHandlers(this.rpcHandlerManager, {
            defaultDirectory: this.machineRpcWorkingDirectory,
            accessPolicy: this.filesystemAccessPolicy,
        });
        registerWorkspaceFaviconHandlers(this.rpcHandlerManager, {
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
            accessPolicy: this.filesystemAccessPolicy,
            machineId: this.machine.id,
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
        voiceInference,
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
            const preflight = input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET
                || input.method === RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3;
            // Native preflight bootstrap needs Home-stamped admission even for a local target.
            if (input.machineId === this.machine.id && !input.externalAction
                && input.method !== RPC_METHODS.DAEMON_SESSION_HANDOFF_EXISTING_STATE_CHECK_V3) {
                return await this.rpcHandlerManager.invokeLocal(input.method, input.request,
                    input.signal ? { signal: input.signal } : undefined);
            }
            return preflight ? await callExactMachineRpc(input) : await callMachineRpc(input);
        };
        let executionRunAccountSettings: Awaited<ReturnType<typeof bootstrapAccountSettingsContext>>['settings'] | null = null;
        const resolveExecutionRunAccountSettingsSnapshot = createExecutionRunAccountSettingsSnapshotResolver({
            machineId: this.machine.id, serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl,
            readCredentials: readExecutionRunAccountCredentials, isOwnerCurrent: executionRunAccountOwnerCurrent,
            onSettings: settings => { executionRunAccountSettings = settings; },
        });
        const previousAccountSnapshots = this.executionRunAccountSnapshots;
        this.executionRunAccountSnapshots = resolveExecutionRunAccountSettingsSnapshot;
        void previousAccountSnapshots?.dispose();
        const workSummaryInstallation = readInstallationIdentityIfExistsSync();
        const workSummaryAccess = createAccountServerActionDeps({ token: this.token,
            serverId: executionRunServerId, serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl,
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
            serverUrl: resolveServerHttpBaseUrl(),
            resolveCurrentMachineId: () => this.machine.id,
        });
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
                ...(voiceInference ? { voiceInference } : {}),
                ...(machineTransferChannel ? { machineTransferChannel } : {}),
                ...(transferRelayV2Channel ? { transferRelayV2Channel } : {}),
                ...(directPeerTransfer ? { directPeerTransfer } : {}),
                ...(directTransferImport ? { directTransferImport } : {}),
                ...(directTransferExport ? { directTransferExport } : {}),
                ...(preparedMachineTransfer ? { preparedMachineTransfer } : {}),
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
                        authorization: { serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl,
                            readSourceInstallation: readHandoffSourceInstallation } }),
                },
                ...(deps?.deviceLocalSecretStorage && workSummaryInstallation && executionRunRuntimeAccountId ? {
                    nativeUsage: {
                        authority: { serverId: executionRunServerId, accountId: executionRunRuntimeAccountId, machineId: this.machine.id },
                        installationId: workSummaryInstallation.installationId,
                        activeServerDir: configuration.activeServerDir,
                        serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl,
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
                readMachineEffectiveCores: this.lifecycleDependencies.readMachineEffectiveCores,
                executionBudgetRegistry: this.executionBudgetRegistry,
                ...(this.lifecycleDependencies.managedActivity && workSummaryInstallation && executionRunRuntimeAccountId ? {
                    machineWorkSummary: {
                        target: { serverId: executionRunServerId, machineId: this.machine.id, installationId: workSummaryInstallation.installationId },
                        custodianAccountId: executionRunRuntimeAccountId,
                        activity: this.lifecycleDependencies.managedActivity.activity,
                        ...(this.lifecycleDependencies.readProjectFiniteLoad
                            ? { readFiniteLoad: this.lifecycleDependencies.readProjectFiniteLoad } : {}),
                        readAccess: async (signal) => await workSummaryAccess.machineAccessAction!({ actionId: 'machines.access.grants.list',
                            input: { serverId: executionRunServerId, machineId: this.machine.id }, context: { surface: 'cli', serverId: executionRunServerId }, signal }),
                    },
                } : {}),
                ...(this.lifecycleDependencies.managedActivity ? {
                    managedActivity: {
                        ...this.lifecycleDependencies.managedActivity,
                        validateCurrentTarget: async (managedTarget, context, method) => {
                            const installation = readInstallationIdentityIfExistsSync();
                            if (!context.machineAdmission || !installation
                                || installation.installationId !== context.machineAdmission.installationId) return false;
                            return await verifyManagedActivityTargetCurrent({
                                context: context.machineAdmission, managedTarget, method,
                                privateKey: installation.privateKey, daemonToken: this.token,
                                serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl,
                                signal: context.signal,
                            });
                        },
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
                ...(this.lifecycleDependencies.requesterSessionRuntime ? { requesterSessionRuntime: this.lifecycleDependencies.requesterSessionRuntime } : {}),
                requesterBootstrapBoundary: this.lifecycleDependencies.requesterBootstrapBoundary ?? {
                    serverId: this.machineRuntimeServerId,
                    serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl,
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
                    serverUrl: this.machineRuntimeServerHttpBaseUrl,
                    resolveAccountSettings: async () => (await resolveExecutionRunAccountSettingsSnapshot()).settings,
                    resolveAccountSettingsSnapshot: resolveExecutionRunAccountSettingsSnapshot,
                    readModelProjection: createAccountScopedProviderModelProjectionReader({
                        serverUrl: this.machineRuntimeServerHttpBaseUrl,
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
                                    serverHttpBaseUrl: resolveServerHttpBaseUrl(),
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
            this.managedActivityPublicationCleanup = this.lifecycleDependencies.managedActivity.activity.subscribe((decision) => {
                void this.updateDaemonState((state) => ({ ...(state ?? { status: 'running' as const }), managedActivity: decision }))
                    .catch((error) => logger.debug('[API MACHINE] Managed activity publication failed', { error: serializeAxiosErrorForLog(error) }));
            });
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
            ...(ingress ? { inspectSetup: async ({ workspace, context, reviewSetupConsent }) => {
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
    private async isNativeWorkspaceHomeCurrent(serverId: string, context: RpcActionExecutorContext): Promise<boolean> {
        const owner = this.externalActionIngressOwner;
        if (!owner || this.projectionSchedulingClosed || owner.currentServerId !== serverId) return false;
        context.signal?.throwIfAborted();
        if (context.serverId === serverId) return true;
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

    /** Preview reads locally after admission rather than re-entering its registered RPC. */
    createWorkspaceFileReplacePreviewActionExecutor(serverId: string): NonNullable<ActionExecutorDeps['workspaceFilesReplacePreview']> {
        return async ({ machineId, ...request }, context) => {
            const target = context.externalActionTarget;
            if (machineId !== this.machine.id || target?.kind !== 'machine' || target.machineId !== machineId
                || !await this.isNativeWorkspaceHomeCurrent(serverId, context)) {
                return { ok: false, errorCode: 'target_unavailable', error: 'Workspace replacement target is unavailable' };
            }
            return previewWorkspaceFileReplace(request, this.machineRpcWorkingDirectory, this.filesystemAccessPolicy,
                context.signal ? { signal: context.signal } : undefined);
        };
    }

    /** Replacement and Undo share this native effect after canonical Action admission. */
    createWorkspaceFileReplaceActionExecutor(serverId: string): NonNullable<ActionExecutorDeps['workspaceFilesReplace']> {
        return async ({ machineId, ...request }, context) => {
            const target = context.externalActionTarget;
            if (machineId !== this.machine.id || target?.kind !== 'machine' || target.machineId !== machineId
                || !await this.isNativeWorkspaceHomeCurrent(serverId, context)) {
                return { ok: false, errorCode: 'target_unavailable', error: 'Workspace replacement target is unavailable' };
            }
            if (context.operationAcceptance?.actionId === 'workspace.files.replace') {
                context.operationAcceptance.accept({ operation: { operationId: context.operationAcceptance.operationId } });
            }
            return await applyWorkspaceFileReplace(request, this.machineRpcWorkingDirectory, this.filesystemAccessPolicy,
                context.signal ? { signal: context.signal } : undefined);
        };
    }

    createLanguageIntelligenceApplyActionExecutor(serverId: string): NonNullable<ActionExecutorDeps['languageIntelligenceApply']> {
        return async ({ machineId, request }, context) => {
            const target = context.externalActionTarget;
            if (machineId !== this.machine.id || target?.kind !== 'machine' || target.machineId !== machineId
                || !await this.isNativeWorkspaceHomeCurrent(serverId, context)) {
                return { ok: false, errorCode: 'target_unavailable', error: 'Language Action target is unavailable' };
            }
            const { getLanguageServerHost } = await import('@/lsp/languageServerHost');
            const root = authorizeFilesystemPath({ targetPath: request.rootPath, defaultDirectory: this.machineRpcWorkingDirectory, accessPolicy: this.filesystemAccessPolicy });
            if (!root.valid) return { status: 'error', errorCode: 'path_not_allowed' };
            return getLanguageServerHost().apply({ ...request, rootPath: root.resolvedPath }, {
                signal: context.signal, requesterWorkAttributionV1: projectRpcRequesterWorkAttribution(context, this.machineRuntimeServerId),
            });
        };
    }

    /** Effect dependency reached only after the canonical Action admission. */
    createMachineSkillActionExecutor(params: Readonly<{ credentials: StoredCredentials;
        operationContext?: import('@/settings/secrets/hydrateSavedSecretCatalog').SavedSecretOperationContextV1;
    }>): NonNullable<ActionExecutorDeps['skillMachineActionExecute']> {
        return async request => {
            const accountId = readAccountIdFromToken(params.credentials.token);
            if (!accountId || accountId !== readAccountIdFromToken(this.token)) {
                return { ok: false, errorCode: 'machine_skill_custodian_required', error: 'machine_skill_custodian_required' };
            }
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
        return async (request) => {
            const admittedOwner = this.externalActionIngressOwner;
            if (!admittedOwner || this.projectionSchedulingClosed) {
                return { ok: false, errorCode: 'filesystem_action_owner_unavailable', error: 'The current filesystem Action owner is unavailable' };
            }
            const target = request.context.externalActionTarget;
            if (target?.kind !== 'machine' || target.machineId !== this.machine.id
                || !await this.isNativeWorkspaceHomeCurrent(serverId, request.context)) {
                return { ok: false, errorCode: 'target_unavailable', error: 'Filesystem target is unavailable' };
            }
            // The immutable invocation's Home was checked above. Each physical
            // phase retains its owner/target checks without a Home read per file.
            const assertCurrentAuthority = async () => {
                request.context.signal?.throwIfAborted();
                const projection = request.context.externalActionExecutionAuthorization?.requesterAccountProjection;
                if (projection && !await projection.isCurrent()) throw new Error('Filesystem requester admission is no longer current');
                request.context.signal?.throwIfAborted();
                if (this.externalActionIngressOwner !== admittedOwner || this.projectionSchedulingClosed) {
                    throw Object.assign(new Error('The admitted filesystem Action owner is no longer current'), { code: 'filesystem_action_owner_unavailable' });
                }
                const currentTarget = request.context.externalActionTarget;
                if (currentTarget?.kind !== 'machine' || currentTarget.machineId !== this.machine.id) {
                    throw new Error('Filesystem target is no longer current');
                }
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
                const result = await transfer({ ...request, actionId: request.actionId, assertCurrentAuthority });
                return result.success ? result : projectPreparedFilesystemActionResult(result);
            }
            // Reuse the incumbent effects without re-entering full Action admission.
            const inline = request.actionId === 'daemon.filesystem.readFile' ? readFile
                : request.actionId === 'daemon.filesystem.writeFile' ? writeFile
                : request.actionId === 'daemon.filesystem.listDirectory' || request.actionId === 'daemon.filesystem.getDirectoryTree'
                    ? directory : null;
            if (inline) {
                await assertCurrentAuthority();
                const result = await inline.execute(request.actionId, request.input, request.context);
                return result.ok ? result.result : result;
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
        };
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
                const request = { method: `${this.machine.id}:${method}`, params, machineAdmission, signal };
                const verifyMachineAdmissionCurrent = async () => {
                    try {
                        return !signal.aborted && (await authorizeMachineRpcRequest(request, this.machineRpcAdmissionBoundary)).ok
                            && !signal.aborted;
                    } catch { return false; }
                };
                if (!await verifyMachineAdmissionCurrent()) return forbidden();
                return await this.rpcHandlerManager.invokeLocal(method, params, { signal,
                    rpcContext: { machineAdmission, verifyMachineAdmissionCurrent,
                        callerAuthority: options.verifiedPeerAuthority ?? 'account_automation' } });
            },
        };
    }

    registerMachineAccessLossReceiver(options: Omit<Parameters<typeof registerMachineAccessLossReceiver>[1],
        'machineId' | 'cleanupRequesterMachineActionOperations' | 'cleanupRequesterMachineTerminals'>): void {
        registerMachineAccessLossReceiver(this.rpcHandlerManager, { ...options, machineId: this.machine.id,
            cleanupRequesterMachineActionOperations: input => this.cleanupRequesterMachineOperations({
                ...input, serverId: options.serverId,
            }),
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
        }>,
    ): Promise<unknown> {
        return await this.rpcHandlerManager.invokeLocal(method, request, {
            ...(options?.signal ? { signal: options.signal } : {}),
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

    registerLocalServicesRoutes(localServices: DaemonLocalServicesMachineRpcRoutes): void {
        registerDaemonLocalServicesMachineRpcHandlers(this.rpcHandlerManager, localServices);
    }

    registerMachineVitalsRoutes(options: DaemonMachineVitalsRoutes): void {
        registerDaemonMachineVitalsRpcHandlers(this.rpcHandlerManager, options);
    }

    registerMachineProcessesRoutes(options: DaemonProcessesRoutes): void {
        registerDaemonProcessesRpcHandlers(this.rpcHandlerManager, options);
    }

    registerMachineResourcesPolicyRoutes(options: DaemonMachineResourcesPolicyRoutes): void {
        registerDaemonMachineResourcesPolicyRpcHandlers(this.rpcHandlerManager, options);
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
        registerDaemonStorageRpcHandlers(this.rpcHandlerManager, options);
    }

    registerConnectedAccountDaemonRuntime(runtime: ConnectedAccountDaemonRuntime): void {
        this.connectedAccountDaemonRuntime = runtime;
    }

    registerConnectedServicePoolSelectionRead(read: ConnectedServicePoolSelectionRead): void {
        this.connectedServicePoolSelectionRead = read;
    }

    registerConnectedAccountPurposeBindingRuntime(runtime: Pick<
        DaemonConnectedAccountPurposeBindingRuntime,
        'activatePurposeBindings' | 'listActionFormConnectedAccountOptions'
    >): void {
        this.connectedAccountPurposeBindingRuntime = runtime;
    }

    registerComputerRoutes(resolveComputer: () => ComputerRoutes | null): void {
        registerDaemonComputerHandler(this.rpcHandlerManager, { resolveComputer });
    }

    registerManagedFiniteWake(input: Parameters<typeof registerManagedFiniteWake>[1]): void {
        registerManagedFiniteWake(this.rpcHandlerManager, input);
    }

    registerBrowserControlRoutes(browserControl: BrowserDaemonControlRoutes): void {
        registerDaemonBrowserControlHandler(this.rpcHandlerManager, {
            browserControl,
        });
    }

    registerBrowserContextRoutes(browserContext: BrowserContextRoutes): void {
        registerDaemonBrowserContextHandler(this.rpcHandlerManager, {
            browserContext,
        });
    }

    registerBrowserDiagnosticsRoutes(browserDiagnostics: BrowserDiagnosticsRoutes): void {
        registerDaemonBrowserDiagnosticsSnapshotHandler(this.rpcHandlerManager, {
            browserDiagnostics,
        });
    }

    registerBrowserRecordingRoutes(browserRecording: BrowserRecordingRoutes): void {
        registerDaemonBrowserRecordingHandlers(this.rpcHandlerManager, {
            browserRecording,
        });
    }

    registerSimulatorPreviewRoutes(simulatorPreview: SimulatorPreviewRoutes): void {
        registerDaemonSimulatorPreviewHandlers(this.rpcHandlerManager, {
            simulatorPreview,
        });
    }

    registerLiveStreamRelayRoutes(relay: DaemonLiveStreamRelayRoutes): void {
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
        for (const listener of this.sessionFollowRulesChangedListeners) await listener(change);
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
     * healthy while every machine RPC was unreachable. It is read by the heartbeat so
     * `happier daemon status` and `happier doctor` can report it instead of a PID probe.
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
        const codec = this.machineContentCodec;
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
        if (this.socket !== socket || codec !== this.machineContentCodec || !this.machineContentReady) return { ok: false, code: 'stream_transport_unavailable' };
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
    ): Promise<Readonly<{ ok: true; result: TResult; answeringClientId?: string; answeringClientIds?: readonly string[] }> | Readonly<{ ok: false; error?: string; errorCode?: string; answeringClients?: readonly SocketRpcAnsweringClientCandidateV1[] }>> {
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
            return { ok: true, result, ...(answeringClientId ? { answeringClientId } : {}), ...(answeringClientIds ? { answeringClientIds } : {}) };
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
            || (preparation ? !isProjectWorkspaceSyncPreparationActionV1(actionId) : actionId !== 'projects.open')
            || input.context.machineAdmission.machineId !== this.machine.id
            || !isExternalActionAuthorizationBoundToEnvelope(authorization.binding,
                { actionId: authorization.binding.actionId, machineId: this.machine.id, envelope: envelope.data })) {
            throw Object.assign(new Error('Original Project SOURCE envelope is unavailable'), { code: 'peer_unavailable' });
        }
        const { ApiClient } = await import('./api');
        const source = await ApiClient.getRequesterMachine(input.sourceWorkspace.machineId,
            { authorization, effectActionId: authorization.binding.actionId, signal: input.context.signal });
        if (!source?.installationId || !source.access || source.access.accessState !== 'ready') {
            throw Object.assign(new Error('Original Project SOURCE access is unavailable'), { code: 'peer_unavailable' });
        }
        const facts = await readWorkspaceSyncChildMachineFacts({ serverId,
            serverHttpBaseUrl: this.machineRuntimeServerHttpBaseUrl, machineIds: [source.id], purpose: 'admitted_mapping',
            authorization, effectActionId: authorization.binding.actionId, signal: input.context.signal });
        const address = resolveWorkspaceSyncTransportAddress({ namespace: input.sourceWorkspace, childMachines: facts });
        if (!preparation && (!address.ok || address.address.machineId !== input.machineId)) {
            throw Object.assign(new Error('Original Project SOURCE controller is unavailable'), { code: 'peer_unavailable' });
        }
        const context = buildActionExecutorContextForRpc({ ...input.context, serverId,
            externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target });
        const workspaceSyncSourceRouting = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare',
            operationId: input.operationId, accountServerId: serverId, sourceMachineId: source.id,
            sourceRootPath: input.sourceWorkspace.rootPath, originalActionEnvelope: envelope.data,
            sourceContext: { ...projectWorkspaceSyncPhysicalContextFromActionContext(context), machineAdmission: {
                actorAccountId: authorization.binding.accountId, custodianAccountId: source.access.custodian.accountId,
                machineId: source.id, installationId: source.installationId, role: source.access.role,
                encryptionMode: source.access.resourceMode } } });
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

    /** Only the installed chosen target can attest its own admitted namespace to the physical writer. */
    async callWorkspaceSyncTargetPhase(input: WorkspaceSyncTargetPhaseDescriptor & Readonly<{
        credentials: import('@/persistence').StoredCredentials;
        context: RpcActionExecutorContext;
    }>): Promise<unknown> {
        if (input.context.workspaceSyncSourceWriterTargetRouting) {
            const workspaceSyncSourceWriterTargetRouting = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(
                input.context.workspaceSyncSourceWriterTargetRouting);
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
            const result = await this.callWorkspaceSyncPhysicalMachineRpc({ ...input,
                originalMachineId: workspaceSyncSourceWriterTargetRouting.source.sourceMachineId,
                accountServerId: input.routing.accountServerId, requireCurrentAdmission: input.routing.phase !== 'release',
                signedEffectActionId: input.context.callerInputAuthorization.binding.actionId, routing: { workspaceSyncSourceWriterTargetRouting } });
            return input.routing.phase === 'preflight' ? HandoffTargetReplacementPreflightResultV1Schema.parse(result)
                : input.routing.phase === 'prepare' ? WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse(result)
                : WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse(result);
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
        if (!b || !target || request.operationId !== b.target.operationId
            || request.targetMachineId !== this.machine.id || input.machineId !== b.sourceWriter.machineId) {
            throw Object.assign(new Error('Workspace seed authority is unavailable'), { code: 'peer_unavailable' });
        }
        const workspaceSyncSeedRouting = WorkspaceSyncSeedRoutingV1Schema.parse({ v: 1, sourceWriterTarget: b, target });
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
        const signedBinding = signedAuthorization?.binding;
        const unavailable = () => Object.assign(new Error('Workspace source authority is unavailable'), { code: 'peer_unavailable' });
        if (!socket?.connected || !admission || !installation || !custodianAccountId
            || forwardWork && input.context.callerInputAuthorization && !writerTarget && !seedRouting && !admittedSourceRoot
            || seedRouting && (!forwardWork || input.method !== RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE
                || !signedAuthorization || signedAuthorization.binding.actionId !== 'projects.open'
                || !doesWorkspaceSyncSourceWriterTargetRootMatchRouting(signedAuthorization, seedRouting.sourceWriterTarget)
                || !isDeepStrictEqual(admission, seedRouting.target.targetContext.machineAdmission)
                || !isDeepStrictEqual(input.context.workspaceSyncSourceWriterTargetRouting, seedRouting.sourceWriterTarget)
                || !isDeepStrictEqual(input.context.workspaceSyncTargetRouting, seedRouting.target)
                || !input.context.workspaceSyncSourceExecution
                || !isDeepStrictEqual(input.context.workspaceSyncSourceExecution.externalActionExecution.authorization, signedAuthorization))
            || writerTarget && (retainedWriterRelease
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
            || forwardWork && (!input.context.verifyMachineAdmissionCurrent || !await input.context.verifyMachineAdmissionCurrent())) {
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
            if (!signedAuthorization || !packet) throw unavailable();
            const verified = await readMachineRpcAdmissionCurrent({ context: seedRouting.sourceWriterTarget.source.sourceContext.machineAdmission,
                method: `${input.machineId}:${input.method}`, workspaceSyncSeedRouting: seedRouting,
                callerInputAuthorization: signedAuthorization, workspaceSyncSourceExecution: packet,
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
            return await callSocketRpc({ socket, target: { kind: 'machine', id: input.machineId }, method: input.method,
                params: input.request, content: createWorkspaceSyncTargetContent({ destination, method: `${input.machineId}:${input.method}`, routing: seedRouting }),
                workspaceSyncSeedRouting: seedRouting, workspaceSyncSourceExecution: packet, timeoutMs: null,
                createExternalActionExecution: wire => {
                    const execution = createExternalActionMachineRpcExecution({ context: { ...input.context,
                        externalActionExecutionAuthorization: signedAuthorization, externalActionTarget: signedAuthorization.binding.target },
                        effectActionId: 'projects.open', installationId: installation.installationId,
                        method: wire.method, requestId: wire.requestId, params: wire.params,
                        workspaceSyncSeedRouting: seedRouting, privateKey: installation.privateKey });
                    if (!execution) throw unavailable();
                    return execution;
                }, ...(input.signal ? { signal: input.signal } : {}) });
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
            return await callSocketRpc({ socket, target: { kind: 'machine', id: input.machineId }, method: input.method,
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
                }, ...(input.signal ? { signal: input.signal } : {}) });
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
                || !retainedWriterRelease && input.machineId === writerTarget.target.targetMachineId
                    && destination.installationId !== (signedAuthorization?.binding.actionId === 'projects.open'
                        ? signedAuthorization.binding.installationId : signedAuthorization?.binding.handoffAdmission?.targetInstallationId)
                || configuration.activeServerId !== this.machineRuntimeServerId || this.socket !== socket || !socket.connected
                || readInstallationIdentityIfExistsSync()?.installationId !== installation.installationId) throw unavailable();
            const content = createWorkspaceSyncTargetContent({ destination, method: `${input.machineId}:${input.method}`, routing: writerTarget });
            const result = await callSocketRpc({ socket, target: { kind: 'machine', id: input.machineId }, method: input.method,
                params: input.request, content, workspaceSyncSourceWriterTargetRouting: writerTarget,
                ...(projectSourceExecution ? { workspaceSyncSourceExecution: projectSourceExecution } : {}),
                ...(jointTarget ? { workspaceSyncTargetRouting: targetRouting } : {}), timeoutMs: null,
                ...(forwardWork && signedAuthorization ? { createExternalActionExecution: wire => {
                    const execution = createExternalActionMachineRpcExecution({ context: { ...input.context,
                        externalActionExecutionAuthorization: signedAuthorization, externalActionTarget: signedAuthorization.binding.target },
                        effectActionId: signedAuthorization.binding.actionId, installationId: installation.installationId,
                        method: wire.method, requestId: wire.requestId, params: wire.params,
                        workspaceSyncSourceWriterTargetRouting: writerTarget, privateKey: installation.privateKey });
                    if (!execution) throw unavailable();
                    return execution;
                } } : {}), ...(input.signal ? { signal: input.signal } : {}) });
            if (writerTarget.target.phase === 'release') return WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse(result);
            const parsed = writerTarget.target.phase === 'preflight'
                ? HandoffTargetReplacementPreflightResultV1Schema.parse(result)
                : WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse(result);
            // P1's first-hop witness names D. It supplies the physical endpoint
            // only when D owns the admitted workspace; a bound D must retain
            // its independently verified P2 result instead.
            if (!jointTarget && parsed.targetWorkspace?.machineId !== destination.machineId) return parsed;
            if (parsed.physicalEndpoint && !isDeepStrictEqual(parsed.physicalEndpoint, destination)) throw unavailable();
            return { ...parsed, physicalEndpoint: destination };
        }
        const { ApiClient } = await import('./api');
        const parent = await runWithServerHttpBaseUrl(this.machineRuntimeServerHttpBaseUrl, async () =>
            await (await ApiClient.create(input.credentials)).getMachine(input.machineId,
                input.signal ? { signal: input.signal } : undefined));
        if (!parent || this.socket !== socket || !socket.connected
            || readInstallationIdentityIfExistsSync()?.installationId !== installation.installationId) throw unavailable();
        const codec = createMachineContentCodec(parent);
        const content: SocketRpcContent = codec.mode === 'plain' ? { mode: 'plain' } : {
            mode: 'e2ee', cipher: {
                encryptRaw: async value => codec.encodeRpc(value),
                decryptRaw: async value => codec.decodeRpc(value),
            },
        };
        return await callSocketRpc({ socket,
            target: { kind: 'machine', id: input.machineId }, method: input.method,
            params: input.request, content, ...input.routing, timeoutMs: null,
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
        });
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
        if (!request.success) return { v: 1 as const, ok: false as const, error: 'discussion_post_denied' as const };
        const raw = await emitSocketWithAck({ socket, event: DISCUSSION_AGENT_POST_EVENT_V1,
            payload: request.data, timeoutMs: null, ...(options?.signal ? { signal: options.signal } : {}) });
        const result = DiscussionAgentApprovedReplayResponseV1Schema.parse(raw);
        if (!result.ok && result.error === 'outcome_unknown') {
            // The canonical Action owner records uncertainty; it must not be
            // converted into a no-effect refusal or left awaiting a lost ACK.
            throw Object.assign(new Error('outcome_unknown'), { code: 'outcome_unknown' });
        }
        return result;
    }

    async captureMachineSessionTerminal(
        sessionId: string,
    ): Promise<MachineSessionTerminalCaptureResponseV1> {
        if (!this.socket) {
            return { v: 1, status: 'rejected', sessionId, reason: 'unsupported' };
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
            return {
                v: 1,
                status: 'rejected',
                sessionId: target.sessionId,
                reason: 'unsupported',
            };
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
        this.pendingPersistedIrohEndpointWithdrawal = false;
        return revision;
    }

    private currentMachineOperationProtocolCapabilities(
        includeSessionCapabilities = true,
    ): MachineOperationProtocolCapabilitiesV1 | null {
        const {
            externalActionExecutionAuthorization: _externalActionExecutionAuthorization,
            ...sessionCapabilities
        } = CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1;
        const capabilities: MachineOperationProtocolCapabilitiesV1 = {
            ...(this.sessionMessageReplyRecoverySupported ? { sessionMessageReply: { protocolVersions: [1] } } : {}),
            ...(includeSessionCapabilities && this.sessionSpawnV1OutcomeRequired
                ? sessionCapabilities
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
        let capabilities = this.currentMachineOperationProtocolCapabilities(includeSessionCapabilities);
        if (!capabilities) return null;

        if (capabilities.sessionMessageReply && !await this.sessionMessageReplyRecovery?.isCurrent?.()) {
            const { sessionMessageReply: _retiredReply, ...currentCapabilities } = capabilities;
            capabilities = Object.keys(currentCapabilities).length > 0 ? currentCapabilities : null;
        }
        if (!capabilities) return null;

        // The Home's resolved server feature bit is both product enablement and
        // proof that its strict Machine projection accepts this new leaf. Older,
        // malformed, disabled, or dependency-disabled Homes therefore keep the
        // handler installed locally but receive no incompatible advertisement.
        const snapshot = currentServerFeatures
            ? { status: 'ready' as const, features: currentServerFeatures }
            : await this.lifecycleDependencies.resolveServerFeaturesSnapshot?.();
        const personalBroker = this.providerBrokerAccountConnectionIngressLive
            && snapshot?.status === 'ready'
            && readServerEnabledBit(snapshot.features, 'providers') === true
            && snapshot.features.capabilities.providerBroker?.protocolVersions.includes(2) === true;
        if (capabilities.providerBrokerIngress && personalBroker) {
            capabilities = { ...capabilities, providerBrokerIngress: { protocolVersions: [1, 2] } };
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

        // Capability publication consumes only the daemon-wide cache supplied by
        // composition. Absence is unknown and must not trigger a per-publication
        // feature request or advertise a target route an older server cannot own.
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
            && !((withdrewPersistedEndpoint || this.pendingPersistedIrohEndpointWithdrawal)
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
        return { ...state, peerMediation: { ...peerMediation, iroh: undefined } };
    }

    /**
     * Publishes or withdraws the broker application capability. The composition
     * root calls this only when the exact provider-broker application handler
     * is installed; absence keeps the leaf withdrawn so every Machine stays
     * ineligible as a broker (fail closed).
     */
    async setProviderBrokerIngressLive(live: boolean, accountConnectionIngress = false): Promise<void> {
        if (this.providerBrokerIngressAdvertised === live && this.providerBrokerAccountConnectionIngressLive === (live && accountConnectionIngress)) return;
        const previous = this.providerBrokerIngressAdvertised;
        const previousPersonal = this.providerBrokerAccountConnectionIngressLive;
        this.providerBrokerIngressAdvertised = live;
        this.providerBrokerAccountConnectionIngressLive = live && accountConnectionIngress;
        try {
            await this.refreshProviderBrokerIngressAdvertisement();
        } catch (error) {
            this.providerBrokerIngressAdvertised = previous;
            this.providerBrokerAccountConnectionIngressLive = previousPersonal;
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
        return await backoff(async () => {
            if (this.shouldSuppressMachinePublication()) {
                return 'suppressed';
            }
            if (!this.socket) {
                throw new Error('Machine socket is not connected');
            }
            if (!this.machineContentReady) {
                await this.refreshMachineFromServer();
                if (!this.machineContentReady) throw new Error('Machine content key is unavailable');
            }
            const expectedVersion = this.machine.metadataVersion;
            const currentMetadata = this.machine.metadata === null ? null : StoredMachinePublishedMetadataV1Schema.parse(this.machine.metadata);
            let candidate = handler(currentMetadata);
            if (options?.agentInventoryObservation) candidate = { ...candidate,
                agentInventory: this.projectAgentInventoryPublication(options.agentInventoryObservation, currentMetadata?.agentInventory) };
            const updated = parseMachinePublishedMetadataV1(candidate);

            // No-op: don't write if nothing changed.
            if (this.machine.metadata && isDeepStrictEqual(updated, this.machine.metadata)) {
                return 'unchanged';
            }

            const answer = await this.publishMachineMetadataAttempt({ metadata: updated, expectedMetadataVersion: expectedVersion });
            if (answer.status === 'applied') {
                logger.debug('[API MACHINE] Metadata updated successfully');
                return 'published';
            } else if (answer.status === 'conflict') {
                throw new Error('Metadata version mismatch'); // Triggers retry
            }
            throw new Error('Unexpected machine metadata update acknowledgement');
        });
    }

    getMachineMetadataSnapshot(): MachineMetadataFieldReadV1 {
        return readOpenedMachineMetadataSnapshot(this.machine, this.machineContentReady);
    }

    async compareAndSwapMachineMetadata(
        input: Parameters<MachineMetadataFieldPortV1['compareAndSwap']>[0],
    ): Promise<Awaited<ReturnType<MachineMetadataFieldPortV1['compareAndSwap']>>> {
        if (this.shouldSuppressMachinePublication() || !this.socket) return { status: 'unavailable' };
        if (!this.machineContentReady) return { status: 'locked' };
        try { return await this.publishMachineMetadataAttempt(input); }
        catch { return { status: this.machineContentReady ? 'outcomeUnknown' : 'locked' }; }
    }

    private async publishMachineMetadataAttempt(input: Parameters<MachineMetadataFieldPortV1['compareAndSwap']>[0]) {
        if (!this.socket) throw new Error('Machine socket is not connected');
        const codec = this.machineContentCodec;
        return publishMachineMetadataOnce({
            getMachine: () => this.machine, socket: this.socket, codec, expectedDataEncryptionKey: this.readOwnerEnvelopeForWrite(),
            isContentCurrent: () => this.machineContentReady && this.machineContentCodec === codec,
            retireAndRefreshContent: async () => { this.retireMachineContent(); await this.refreshMachineFromServer(); },
            notifyMetadataChanged: () => this.notifyMachineMetadataChanged(),
        }, input);
    }

    /** The currently published projection fact; invalidation owns its advancement. */
    getContributionRegistryProjectionRevision(): number {
        return this.machine.daemonState?.contributionRegistryProjectionRevision ?? 0;
    }

    /**
     * Update daemon state (runtime info) - similar to session updateAgentState
     * Simplified without lock - relies on backoff for retry
     */
    async updateDaemonState(
        handler: (state: DaemonState | null) => DaemonState,
        options?: ApiMachineDaemonStatePublicationOptions,
    ): Promise<MachinePublicationOutcome> {
        if (this.shouldSuppressMachinePublication(options?.allowWhileQuiescing)) {
            return 'suppressed';
        }
        this.readOwnerEnvelopeForWrite();
        return await backoff(async () => {
            if (this.shouldSuppressMachinePublication(options?.allowWhileQuiescing)) {
                return 'suppressed';
            }
            if (!this.socket) {
                throw new Error('Machine socket is not connected');
            }
            const previousIrohEndpoint = this.machine.daemonState?.peerMediation?.iroh?.endpoint ?? null;
            if (!this.machineContentReady) {
                await this.refreshMachineFromServer();
                if (!this.machineContentReady) throw new Error('Machine content key is unavailable');
            }
            const codec = this.machineContentCodec;
            const expectedVersion = this.machine.daemonStateVersion;
            const expectedDataEncryptionKey = this.readOwnerEnvelopeForWrite();
            const currentState = this.machine.daemonState === null ? null : StoredMachinePublishedDaemonStateV1Schema.parse(this.machine.daemonState);
            const updated = parseMachinePublishedDaemonStateV1(handler(currentState));
            if (isDeepStrictEqual(currentState, updated)) {
                return 'unchanged';
            }

            const answer = MachineUpdateStateResponseSchema.parse(await emitSocketWithAck({
                socket: this.socket,
                event: 'machine-update-state',
                timeoutMs: null,
                payload: {
                    machineId: this.machine.id,
                    daemonState: codec.encodeStored(updated),
                    expectedVersion,
                    expectedDataEncryptionKey,
                },
            }));

            if ((codec !== this.machineContentCodec || !this.machineContentReady)
                && !('result' in answer && answer.result === 'key-mismatch')) {
                throw Object.assign(new Error('Machine content key changed during publication'), { retryable: false });
            }
            if (!('result' in answer)) throw Object.assign(new Error('Machine content publication requires a client update'), { code: answer.error, retryable: false });
            if (answer.result === 'key-mismatch') {
                this.retireMachineContent();
                await this.refreshMachineFromServer();
                throw new Error('Machine content key mismatch');
            }
            if (answer.result === 'success') {
                if (answer.version >= this.machine.daemonStateVersion) {
                    this.machine.daemonState = answer.daemonState === null ? null : StoredMachinePublishedDaemonStateV1Schema.parse(codec.decodeStored(answer.daemonState));
                    this.machine.daemonStateVersion = answer.version;
                    if (this.machine.keyBasis) this.machine.keyBasis = { ...this.machine.keyBasis, daemonStateVersion: answer.version };
                    await this.synchronizeIrohMachineEndpointAuthority(this.machine.daemonState, previousIrohEndpoint !== null);
                }
                logger.debug('[API MACHINE] Daemon state updated successfully');
                return 'published';
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.daemonStateVersion) {
                    this.machine.daemonStateVersion = answer.version;
                    this.machine.daemonState = this.discardUnverifiedIrohEndpoint(
                        answer.daemonState === null ? null : StoredMachinePublishedDaemonStateV1Schema.parse(codec.decodeStored(answer.daemonState)),
                    );
                    if (this.machine.keyBasis) this.machine.keyBasis = { ...this.machine.keyBasis, daemonStateVersion: answer.version };
                }
                throw new Error('Daemon state version mismatch'); // Triggers retry
            }
            throw new Error('Unexpected machine daemon-state update acknowledgement');
        });
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
        onMachineReplaced?: (event: { machineId: string }) => void;
        prepareServerTransportForReconnect?: () => Promise<ReadinessProbeResult>;
    }) {
        logger.debug(`[API MACHINE] Connecting to ${resolveServerHttpBaseUrl()}`);
        let takeoverOnNextConnect = params?.takeover === true;

        if (!this.connectionSupervisor) {
            this.connectionSupervisor = createManagedConnectionSupervisor({
                ...DEFAULT_MANAGED_CONNECTION_POLICY,
                classifyTransportErrorToProbeResult,
                createTransport: () => {
                    const serverUrl = resolveServerHttpBaseUrl();
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
                    // Account observation is connection-owned, including when the optional
                    // changes feed is disabled and no foreground Action has requested identity.
                    if (readAccountIdFromToken(this.token)) await this.getAccountId();
                    if (isReconnect && this.lifecycleDependencies.loadMachine) {
                        this.retireMachineContent();
                        await this.refreshMachineFromServer();
                        if (!this.machineContentReady || this.socket !== socket || this.activeTransportGeneration !== transportGeneration) return;
                    }
                    const missingCoreHandlers = REQUIRED_MACHINE_CONTROL_RPC_METHODS.filter(
                        (method) => !this.rpcHandlerManager.hasHandler(method),
                    );
                    if (socket) {
                        this.rpcHandlerManager.onSocketConnect(socket);
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
                            await this
                                .sessionSyncPendingInputServerContractController
                                .resolve({
                                    sessionConnectionEpoch:
                                        transportGeneration,
                                    socket,
                                    machineId: this.machine.id,
                                });
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
                                await this.publishMachineControlReadinessWhenReady({
                                    socket,
                                    transportGeneration,
                                    timeoutMs: MACHINE_CONTROL_RPC_REGISTRATION_TIMEOUT_MS,
                                });
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
                                    await this.publishMachineControlReadinessWhenReady({
                                        socket,
                                        transportGeneration,
                                        timeoutMs: MACHINE_CONTROL_RPC_REGISTRATION_TIMEOUT_MS,
                                    });
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
                        await Promise.resolve(params.onConnect()).catch(() => {});
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

    private installSocketEventHandlers(
        socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>,
        transportGeneration: number,
        params?: {
            takeover?: boolean;
            onConnect?: () => void | Promise<void>;
            onOwnershipConflict?: (conflict: { owner: MachineOwnerConflictDetails }) => void;
            onMachineReplaced?: (event: { machineId: string }) => void;
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
                if (isMachineReplacedSocketError(error)) {
                    void this.connectionSupervisor?.stop().catch(() => {});
                    params?.onMachineReplaced?.({ machineId: this.machine.id });
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
                return;
            }
            logger.debugLargeJson(
                `[API MACHINE] Received RPC request:`,
                projectIncomingMachineRpcDebugPayload(data),
            );
            const response = await this.rpcHandlerManager.handleRequest(data);
            if (!isCurrentTransport()) {
                return;
            }
            callback(response);
        });

        socket.on(SOCKET_RPC_EVENTS.REGISTERED, (data: { method: string }) => {
            if (!this.isActiveTransportGeneration(transportGeneration) || socket !== this.socket) {
                return;
            }
            const method = this.normalizeConnectedClientRpcAvailabilityMethod(data.method);
            const separatorIndex = data.method.indexOf(':');
            const rpcMethod = separatorIndex === -1 ? data.method : data.method.slice(separatorIndex + 1);
            if (isCurrentUiContextClientRpcMethod(rpcMethod)) {
                logger.warn('[API MACHINE] Current UI RPC availability received', {
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
            const codec = this.machineContentCodec;
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
                || codec !== this.machineContentCodec || !this.machineContentReady) return;
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
            const replyHint = SessionMessageReplyPendingHintV1Schema.safeParse(raw);
            if (replyHint.success) {
                this.requestSessionMessageReplyRecovery(socket, transportGeneration);
                this.requestSessionMessageReplyRecovery(socket, transportGeneration, replyHint.data.sessionId);
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
                    this.machine.metadata = projectMachinePublishedMetadataFromRowV1(StoredMachinePublishedMetadataV1Schema.parse(this.machineContentCodec.decodeStored(update.metadata.value)), update.devcontainerChild);
                    this.machine.metadataVersion = update.metadata.version;
                    if (this.machine.keyBasis) this.machine.keyBasis = { ...this.machine.keyBasis, metadataVersion: update.metadata.version };
                    this.notifyMachineMetadataChanged();
                }

                // A blob CAS acknowledgement can precede its same-version
                // echo; the retained-row fact is independent of that version.
                if (update.devcontainerChild !== undefined) {
                    const metadata = projectMachinePublishedMetadataFromRowV1(this.machine.metadata, update.devcontainerChild);
                    if (metadata !== this.machine.metadata) {
                        this.machine.metadata = metadata;
                        this.notifyMachineMetadataChanged();
                    }
                }

                if (update.daemonState && update.daemonState.version > this.machine.daemonStateVersion) {
                    logger.debug('[API MACHINE] Received external daemon state update');
                    this.machine.daemonState = update.daemonState.value === null ? null
                        : StoredMachinePublishedDaemonStateV1Schema.parse(this.machineContentCodec.decodeStored(update.daemonState.value));
                    this.machine.daemonStateVersion = update.daemonState.version;
                    if (this.machine.keyBasis) this.machine.keyBasis = { ...this.machine.keyBasis, daemonStateVersion: update.daemonState.version };
                }
                return;
            }

            const handled = this.dispatchUpdate(data);
            if ((data.body.t === 'pending-changed' || data.body.t === 'automation-run-updated')
                && data.body.managedWakeTargetV1 !== undefined) {
                const target = ManagedWakeTargetV1Schema.safeParse(data.body.managedWakeTargetV1);
                if (target.success && target.data.controller.machineId === this.machine.id) {
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
                this.startChangesSyncWithRetry({ reason: 'live',
                    ...(data.body.t === 'account-change' && Number.isSafeInteger(data.seq) && data.seq >= 0
                        ? { requestedCursor: data.seq } : {}),
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
        }, 20000);
        logger.debug('[API MACHINE] Keep-alive started (20s interval)');
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

    private notifyMachineMetadataChanged(): void {
        try {
            this.lifecycleDependencies.onMachineMetadataChanged?.();
        } catch {
            logger.warn('[API MACHINE] Machine metadata listener threw (ignored)');
        }
    }

    private retireMachineContent(): void {
        this.machineContentContext = { codec: this.machineContentCodec, ready: false };
        this.rpcHandlerManager.retireEncryptionContext();
        this.notifyMachineMetadataChanged();
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
            // Install decoded content, owner write basis, and RPC codec as one context.
            this.machine = { ...next, daemonState: this.discardUnverifiedIrohEndpoint(next.daemonState) };
            this.machineContentContext = { codec, ready: true };
            this.rpcHandlerManager.adoptEncryptionContext(this.machine);
            this.notifyMachineMetadataChanged();
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
            serverFeatures: null,
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
        // Startup/reconnect recover the full projection; live wakes classify the changes page first.
        const executionAuthority = opts.reason === 'live'
            ? 'runtime_recovery' as const
            : 'passive_projection' as const;
        const requestSupervisionScope = this.connectionSupervisor?.captureProbeReportScope?.();
        const transportGeneration = this.activeTransportGeneration;
        signal.throwIfAborted();
        if (opts.reason !== 'live') {
            try {
                await this.reconcileConnectedServicesProjection({
                    source: opts.reason === 'connect' ? 'startup' : 'reconnect',
                    executionAuthority,
                }, signal);
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

        const enabled = (() => {
            const raw = process.env.HAPPY_ENABLE_V2_CHANGES;
            if (!raw) return true;
            return ['true', '1', 'yes'].includes(raw.toLowerCase());
        })();
        if (!enabled) {
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

        const CHANGES_PAGE_LIMIT = 200;
        let after = await readAccountChangesCursor(accountId);
        // The post-commit producer's seq is this durable cursor, not a domain
        // event count. An equal acknowledged wake has no remaining feed work.
        // Lower values still query: a restore can rebase the cursor domain.
        if (opts.reason === 'live' && opts.requestedCursor === after
            && this.accountChangesObserverTransportGeneration === transportGeneration) return;
        let reason = opts.reason;
        while (!this.projectionSchedulingClosed && this.isActiveTransportGeneration(transportGeneration)) {
            signal.throwIfAborted();
            const result = await fetchChanges({ token: this.token, after, limit: CHANGES_PAGE_LIMIT, signal });
            signal.throwIfAborted();
            if (this.projectionSchedulingClosed || !this.isActiveTransportGeneration(transportGeneration)) return;
            if (result.status !== 'ok' && result.status !== 'cursor-gone'
                && this.isActiveTransportGeneration(transportGeneration)) {
                this.accountChangesObserverTransportGeneration = null;
            }

            if (result.status === 'cursor-gone') {
                void this.notifySessionFollowRulesChanged({ full: true, workflowRunIds: [] });
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
                await writeAccountChangesCursor(accountId, result.currentCursor);
                signal.throwIfAborted();
                if (this.isActiveTransportGeneration(transportGeneration)) {
                    this.accountChangesObserverTransportGeneration = transportGeneration;
                }
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
                if (opts.reason === 'reconnect' || opts.reason === 'live') {
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
            if (changes.length >= CHANGES_PAGE_LIMIT && nextCursor <= after) {
                throw new Error('account_changes_cursor_not_advanced');
            }
            const followSourcesFull = reason !== 'live' || changes.some(change => change.kind === 'account'
                && asRecord(change.hint)?.sessionFollows === true);
            const workflowRunIds = changes.flatMap(change => change.kind === 'account' && change.entityId.startsWith('workflow-run:')
                ? [change.entityId.slice('workflow-run:'.length)] : []);
            const discussionIds = changes.flatMap(change => change.kind === 'discussion' ? [change.entityId] : []);
            if (followSourcesFull || workflowRunIds.length || discussionIds.length)
                await this.notifySessionFollowRulesChanged({ full: followSourcesFull, workflowRunIds, discussionIds });
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

            const hasRelevantMachineChange = changes.some(
                (c) => c.kind === 'machine' && c.entityId === this.machine.id,
            );
            const hasManagedPolicyChange = changes.some(change => {
                if (change.kind !== 'account' || asRecord(change.hint)?.managedMachinePolicy !== true) return false;
                const hint = ManagedMachinePolicyChangeHintV1Schema.safeParse(change.hint);
                return hint.success && hint.data.machineId === this.machine.id;
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
            const hasWebhookAdmissionChange = changes.some(change => {
                const parsed = PluginDomainChangeEntrySchema.safeParse(change);
                return parsed.success && (parsed.data.hint.pluginDomain === 'webhook'
                    || parsed.data.hint.pluginDomain === 'availability');
            });
            const hasProjectRowsChange = changes.some((change) => {
                if (change.kind !== 'account') return false;
                const hint = ProjectAccountRowChangeHintV1Schema.safeParse(change.hint);
                return hint.success
                    && change.entityId === buildProjectAccountRowPhysicalKeyV1(hint.data.key);
            });
            const hasSavedSecretCatalogChange = changesRequireSavedSecretCatalogRefresh(changes);
            const hasConnectedMetadataCatalogChange = changes.some(change => change.kind === 'account'
                && (change.entityId === CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1
                    || change.entityId === CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1));
            const hasNotificationChannelCatalogChange = changes.some(change => change.kind === 'account'
                && change.entityId === NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1);
            const hasProfileCatalogChange = changes.some((change) => change.kind === 'account'
                && isProfileCatalogAccountChangeEntityIdV1(change.entityId));
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
            await this.prepareMachineRecipientEnvelopes([
                ...(reason !== 'live' ? [this.machine.id] : []),
                ...changes.filter(change => change.kind === 'machine').map(change => change.entityId),
            ], signal);
            signal.throwIfAborted();
            await this.prepareSessionRecipientEnvelopes(
                changes.filter(change => change.kind === 'share').map(change => change.entityId), signal);
            signal.throwIfAborted();
            if (reason !== 'live' || hasProjectRowsChange) {
                await this.notifyAccountProjectRowsChanged({
                    source: reason === 'live' ? 'changes' : reason,
                    signal,
                });
            }
            if (reason !== 'live' || hasProfileCatalogChange) {
                await refreshDemandedActiveProfileCatalog({ token: this.token, signal });
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
            if (reason !== 'live' || hasProviderConnectionsChange || highestAccountSettingsVersion !== null) {
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
            publishPluginAccountAvailabilityChanges(accountScopeKey, changes);
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
            for (const change of changes) {
                const sessionId = change.entityId.trim();
                if (change.kind === 'session' && sessionId) {
                    signal.throwIfAborted();
                    // Consume this exact durable invalidation before advancing the
                    // Account cursor. Failure replays it through the existing feed.
                    for (const listener of this.sessionChangeListeners) {
                        await listener({ sessionId, cursor: change.cursor });
                        signal.throwIfAborted();
                    }
                }
                const transcript = readSessionTranscriptChangeHintV1(change);
                if (!transcript || !sessionId) continue;
                signal.throwIfAborted();
                // Append hints also invalidate retained rows: Account changes can
                // coalesce a revision followed by an append into the latter hint.
                for (const listener of this.sessionTranscriptRevisionListeners) {
                    await listener({ sessionId, ...transcript, cursor: change.cursor });
                }
            }
            for (const deletion of deletedSessionChangeNotifications) {
                signal.throwIfAborted();
                // Cleanup is part of consuming this durable deletion fact. A
                // listener failure leaves the Account cursor untouched so the
                // incumbent changes retry owner replays the exact same deletion.
                await this.notifySessionDeletedChange(deletion);
            }
            for (const entry of result.response.sessionAccessWitness?.entries ?? []) {
                if (entry.status !== 'unavailable') continue;
                signal.throwIfAborted();
                // Same custody rule as deletion: derived local state for a Session
                // the Account can no longer reach is cleared before the cursor
                // advances, so a failed purge replays instead of being lost.
                await this.notifySessionAccessRevoked({
                    sessionId: entry.sessionId,
                    cursor: entry.cursor,
                });
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
                await this.notifyAutomationEventSourcesInvalidated(signal, {
                    ...(reason === 'reconnect' ? { reason: 'reconnect' as const } : {}),
                    ...(reason === 'live' && !hasAutomationSourceChange && !hasWebhookAdmissionChange
                        ? { definitionsChanged: false } : {}),
                });
            }
            if (reason !== 'live'
                || hasWebhookAdmissionChange || hasTeamChange) {
                await this.notifyPluginWebhookInvalidated(signal);
            }
            if (reason !== 'live' || hasManagedPolicyChange || hasTeamChange) {
                await this.notifyManagedMachinePolicyInvalidated(signal);
            } else {
                const machineIds = changes.filter(change => change.kind === 'machine' && change.entityId !== this.machine.id)
                    .map(change => change.entityId);
                if (machineIds.length) await this.notifyManagedMachinePolicyInvalidated(signal, { kind: 'machines', machineIds });
                // A controller Machine change can retire held native/currentness
                // work (including a moved controller). Its own operation/activity
                // publications cannot create a new automatic policy operation.
                if (hasRelevantMachineChange) await this.notifyManagedMachinePolicyInvalidated(signal, { kind: 'currentness' });
            }
            signal.throwIfAborted();
            if (this.projectionSchedulingClosed || !this.isActiveTransportGeneration(transportGeneration)) return;
            await writeAccountChangesCursor(accountId, nextCursor);
            signal.throwIfAborted();
            if (this.isActiveTransportGeneration(transportGeneration)) {
                this.accountChangesObserverTransportGeneration = transportGeneration;
            }
                if (connectedServicesPageDiagnostic) {
                    logger.debug('[API MACHINE] Connected service Account page', {
                        phase: 'settled', ...connectedServicesPageDiagnostic,
                    });
                }
            if (changes.length < CHANGES_PAGE_LIMIT) return;
            // Each page is consumed before its cursor is acknowledged. Subsequent
            // pages classify exact changes instead of repeating reconnect recovery.
            after = nextCursor;
            reason = 'live';
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

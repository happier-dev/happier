import { isDeepStrictEqual } from 'node:util';
import { createDaemonAgentIsolationEffects } from './agentIsolation/createDaemonAgentIsolationEffects';
import { createDaemonMachineReachabilityRoutes } from '@/machines/reachability/createDaemonMachineReachabilityRoutes';
import { getActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';

import { createDaemonMachineAdminAccessRoutes } from '@/machines/adminAccess/createDaemonMachineAdminAccessRoutes';
import { randomUUID } from 'node:crypto';
import { createDaemonMcpRequestAuthForTest } from './connectedServices/requestAuth/createDaemonMcpRequestAuthForTest';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';


import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { createManagedActivityInventory, createLiveWorkProducerGroup, type LiveWorkProducerV1 } from './lifecycle/managedActivity';
import { createExecutionRunLiveWorkProducer } from './executionRunRegistry';
import { createDaemonManagedMachinePolicyRuntime, readManagedMachinePolicyCensus } from './startup/managedMachinePolicyRuntime';
import { reconcileRecoveredSessionMachineControl } from './sessions/reconcileRecoveredSessionMachineControl';
import { readHttpStatus } from '@/api/client/httpStatusError';
import type { ApiMachineClient, ApiMachineClientLifecycleDependencies } from '@/api/apiMachine';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { installDaemonMachineAdmissionTransport } from './machineAdmissionTransport';
import { createClientActionReverseDispatcher } from '@/session/actions/clientActionReverseDispatch';
import { TrackedSession } from './types';
import { MachineMetadata } from '@/api/types';
import type { DaemonState } from '@/api/types';
import type { SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { formatProcessOwnerTag, PROCESS_OWNER_ENV_KEY } from '@/processes/ownerTag';
import {
  createSpawnConnectedServicesTeamResourceCatalogResolver,
  resolvePurposeTeamCredentialBindingIntentsFromHome,
} from '@/session/services/spawnConnectedServicesDefaults';
import { createDaemonKeepAwake } from './resources/daemonKeepAwake';
import { createDaemonStorageVitalsBindings } from './resources/createDaemonStorageVitalsBindings';
import { createDaemonGuard } from './guard/createDaemonGuard';
import { createGuardSessionRestoration } from './guard/sessionRestoration';
import { createGuardSessionAccess } from './guard/sessionAccess';
import type { GuardPolicyWorkPlan } from './guard/guardRuntime';
import { createLeftBehindActuator, readLeftBehindRestoration } from './guard/actuators/leftBehind';
import { createIdleTerminalPolicy } from './guard/idleTerminalPolicy';
import { createSessionMemoryCeiling, type SessionMemoryCeilingTarget } from './platform/linux/sessionMemoryCeiling';
import { waitForChangeOrDeadline } from './lifecycle/waitForChangeOrDeadline';

import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { createReadGuardFacts } from './guard/readGuardFacts';
import { readCurrentSessionEligibility } from './guard/sessionEligibility';
import { browserClose } from './guard/actuators/browserClose';
import { serviceStop } from './guard/actuators/serviceStop';
import { sessionStop as stopGuardSession } from './guard/actuators/sessionStop';
import { isTerminalHostPhysicallyRetiredStopResult } from './sessions/stopSessionContract';
import { applySessionMemoryCeilingOverrideToMetadata, readSessionMemoryCeilingOverride } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import { updateSessionMetadataForTarget } from '@/session/services/updateSessionMetadataForTarget';
import { MachineGuardPolicyV1Schema } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import { SessionSharedSummaryV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { createMachineVitalsAlerts } from './vitals/alerts/machineVitalsAlerts';
import { dispatchMachineVitalsAlertNotificationAsync, readMachineVitalsWorkingSessionCount } from './vitals/alerts/dispatchMachineVitalsAlertNotification';
import { buildMachineGuardEpisodeNotificationEvent } from '@/notifications/activity/buildMachineGuardEpisodeNotification';
import { createDaemonStorageRoutes, type DaemonStorageRoutes } from '@/rpc/handlers/storage';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { readMachineProjectWorkspaceRefs } from '@/workspaces/readMachineProjectWorkspaceRefs';
import type { DaemonPublicVoiceModelPackRuntime } from './voiceInference/publicModelPacks/runtime';
import type { BrowserRecordingDaemonRuntime } from './browser/recording/runtime';
import { scmWorktreeMutationActivity } from '@/scm/worktreeMutationActivity';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/getEnvironmentInfo';
import { pruneHappyCliRunnerSnapshots } from '@/utils/spawnHappyCLI';
import { projectPath } from '@/projectPath';
import { resolveRunningCliRuntimeIdentity } from '@/packagedRuntime/resolveRunningCliRuntimeIdentity';
import {
  acquireDaemonLock,
  clearDaemonStateForLockOwner,
  releaseDaemonLock,
  readStoredCredentials,
  readStoredCredentialsForServerId,
  sameStoredCredentials,
  writeDaemonStateForLockOwner,
} from '@/persistence';

import { reattachTrackedSessionsFromMarkers } from './sessions/reattachFromMarkers';
import { createSkillStore } from '@/prompts/skills/store/skillStore';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';
import { createSkillUsageRecorder } from '@/prompts/skills/store/skillUsage';
import { readSkillLibraryDigests } from '@/prompts/skills/library/readSkillLibraryContent';
import { listSessionMarkers } from './sessionRegistry';
import { equalProcessStart, processOwnerKey } from './processes/ownership/types';
import { resolveProcessOwnerRequester } from './processes/ownership/resolveProcessOwnerRequester';
import { createProcessActionExecutor } from './processes/actions/processActionExecutor';
import { createMachineProcessesView, type MachineProcessesView } from './processes/view/createMachineProcessesView';
import { readProcessRoleCatalog } from '@/processes/classification/processRoleCatalog';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { reconstructEndedSessionProcessRoot, type HappierProcessRootSource } from './processes/roots/listHappierProcessRoots';
import type { createLeftBehindPass } from './processes/leftBehind/leftBehindPass';
import { resolveLiveRunnerSnapshotFingerprints } from './sessionRunnerRuntime/resolveLiveRunnerSnapshotFingerprints';
import { createDefaultTerminalHostAdapterInventory } from '@/integrations/terminal/host/defaultAdapters';
import { createOnHappySessionWebhook } from './sessions/onHappySessionWebhook';
import { createAcceptedSessionWorkspaceRegistration } from './sessions/registerAcceptedSessionWorkspace';
import { reconcileAgentRuntimeRestartDisposition } from './sessions/reconcileAgentRuntimeRestartDisposition';
import { createDaemonSessionHandoffMetadataBridge } from './sessions/createDaemonSessionHandoffMetadataBridge';
import { startDaemonHeartbeatLoop } from './lifecycle/heartbeat';

import { initialMachineMetadata } from './machine/metadata';
import { createDaemonShutdownController } from './lifecycle/shutdown';
import { getDaemonAgentInstallJobOwner } from '@/capabilities/installJobs/agentInstallJobOwner';
import { installDaemonAcpCatalogHydrationObserver, readActiveAcpCatalog } from '@/agent/acp/catalog/hydrateAcpCatalog';
import { sweepRemovedAgentInstalls } from '@/agent/acp/catalog/registry/sweepRemovedAgentInstalls';
import { isAgentInstallTargetInUse } from '@/agent/acp/catalog/registry/managedAgentInstalls';
import { createBeforeShutdownDrain } from './lifecycle/createBeforeShutdownDrain';
import { createDaemonAdmissionDrain } from './lifecycle/admissionDrain';
import { startDaemonRuntimeBootstrap } from './startup/startDaemonRuntimeBootstrap';
import { captureNativePublicProfileRefresh } from './account/nativePublicProfileRefreshActions';
import type { SingleFlightIntervalLoopHandle } from './lifecycle/singleFlightIntervalLoop';
import { createRequesterSessionRuntimeContext } from './sessionEncryption/createRequesterSessionRuntimeContext';
import type { AdmittedRequesterSessionBootstrap, RequesterSessionRuntimeContext } from './sessionEncryption/requesterSessionCredentials';
import { createRequesterSessionRuntimeContextResolver, resolveRequesterSessionBootstrapFromCustody, bindRequesterSessionRuntimeMachineAdmissionCurrentness, listRequesterSessionCredentialBindings, releaseUnretainedRequesterSessionRuntimeContext } from './sessionEncryption/requesterSessionCredentials';
import { notifyActiveAccountConnectedServicesProjection } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { warmDaemonAccountCatalogs } from './startup/warmDaemonAccountCatalogs';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { migrateTrackedSessionProcessesOutOfDaemonServiceCgroup } from './platform/linux/migrateTrackedSessionsOutOfDaemonServiceCgroup';
import { readGuardCeilingCapability, shouldUseSystemdUserSessionResourceGovernor } from './platform/linux/systemdUserResourceGovernor';
import { resolveFilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
export { buildTmuxSpawnConfig, buildTmuxWindowEnv } from './platform/tmux/spawnConfig';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { resolveWaitForAuthConfig } from './startup/waitForAuthConfig';
import { waitForInitialCredentials } from './startup/waitForInitialCredentials';
import { createDaemonEventLoopStallMonitor } from './diagnostics/daemonEventLoopStallMonitor';
import { ensureDaemonStartupOwnership } from './startup/ensureDaemonStartupOwnership';
import { startDaemonMachineRegistrationRuntime } from './startup/startDaemonMachineRegistrationRuntime';
import { settleDaemonOptionalCapability, type DaemonOptionalCapabilityResult } from './startup/optionalCapabilities';
import { createDaemonCleanupAndShutdown } from './startup/createDaemonCleanupAndShutdown';
import { releaseDaemonOwnershipAfterFatal } from './lifecycle/cleanupAndShutdown';
import { type AutomationWorkerHandle } from './automation/automationWorker';
import { type MemoryWorkerHandle } from './memory/memoryWorker';
import { type VoiceInferenceWorkerHandle } from './voiceInference/voiceInferenceWorker';
import { createDaemonConnectivityCoordinator } from './connection/createDaemonConnectivityCoordinator';
import type { ConnectedServiceRefreshCoordinator } from './connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import type { ConnectedServiceQuotasCoordinator } from './connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { ConnectedServiceRuntimeRegistry } from './connectedServices/runtimeRegistry/registry';
import type { DaemonServerWorkScheduler } from './serverWork';
import type { ConnectedServiceQuotasLoopHandle } from './connectedServices/quotas/startConnectedServiceQuotasLoop';
import { getReleaseRingCatalogEntry } from '@happier-dev/release-runtime/releaseRings';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';

import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import type { ConnectedServiceId } from '@happier-dev/protocol';
import { trimProcessAllocator } from '@happier-dev/iroh-native/node';
import { resolveDaemonServiceIrohRelayConfig } from './service/resolveDaemonServiceIrohRelayConfig';
import { readHomeApplicationCarrierEligibilityFromEnv } from '@happier-dev/cli-common/homeEnrollment';
import { readOrCreateInstallationIdentity } from './identity/store';
import { createInstalledProjectFiniteRuntime } from './startup/createInstalledProjectFiniteRuntime';
import {
  startPluginWebhookDaemonWorkerV1,
  type PluginWebhookDaemonWorkerHandleV1,
} from '@/plugins/runtime/webhooks/pluginWebhookDaemonWorker';
import { attachPluginWebhookDaemonWakeV1 } from '@/plugins/runtime/webhooks/pluginWebhookDaemonWake';
import { resolveDaemonServiceLabelFromEnv, resolveDaemonTakeoverRequestedFromEnv, resolveDaemonStartupSourceFromEnv } from '@/daemon/ownership/daemonOwnershipMetadata';
import { DaemonOwnershipConflictError } from '@/daemon/ownership/DaemonOwnershipConflictError';
import { resolveDaemonOwnershipConflictExitCode } from '@/daemon/ownership/resolveDaemonOwnershipConflictExitCode';
import { startDaemonSessionControlRuntime } from './startup/startDaemonSessionControlRuntime';
import { prepareDaemonBootstrapContext } from './startup/prepareDaemonBootstrapContext';
import { createDaemonMachineBootstrapRuntime } from './startup/createDaemonMachineBootstrapRuntime';
import { createProductionDaemonWorkflowRuntime } from './workflows/daemonRuntime';
import { prepareWorkflowSessionRequester, runObservedWorkflowSessionStartup } from './workflows/workflowSessionStartup';
import { createMachineSessionSpawnRpcHandler } from '@/session/actions/sessionLifecycleActions';
import { normalizeSpawnSessionNonceResolution } from '@happier-dev/protocol/sessions/spawnSessionNonce';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { isWorkflowRuntimeEnabled } from './automation/workflowFeatureGate';
import {
  createProductionDaemonWorkspaceSyncRuntime,
  type ProductionDaemonWorkspaceSyncRuntime,
} from './startup/createProductionDaemonWorkspaceSyncRuntime';
import { createDaemonWorkspaceSyncRuntimeCustody } from './startup/daemonWorkspaceSyncRuntimeCustody';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createProjectWorkerAction } from '@/workspaces/execution/projectWorkerAction';
import { createAccountServerMachineFinitePolicyClient } from '@/api/machine/accountServerMachineFinitePolicyClient';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';

import { captureServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readInstallationIdentityIfExistsSync } from './identity/store';
import { prepareDaemonPluginRemoval } from './startup/prepareDaemonPluginRemoval';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { cleanupDaemonHomeMachineWorkspace } from './startup/daemonHomeMachineWorkspaceCleanup';
import { createSshTunnelSupervisor } from './ssh/tunnels';
import { createConnectedServiceGroupHomeCleanupScheduler } from './connectedServices/homes/createConnectedServiceGroupHomeCleanupScheduler';
import { createConnectedServiceMaterializedHomeCleanupScheduler } from './connectedServices/materialize/cleanup/createConnectedServiceMaterializedHomeCleanupScheduler';
import { listConnectedServiceRetainedMaterializedHomeSanitizers } from './connectedServices/catalogHooks';
import { readRetainedConnectedServiceMaterializationKeys } from './connectedServices/materialize/cleanup/readRetainedConnectedServiceMaterializationKeys';
import { resolveConnectedServicesMaterializationBaseDir } from './connectedServices/materialize/resolveConnectedServicesMaterializationBaseDir';
import { createDaemonMachineRpcRouteAttachmentCache } from './machineRpcRouteAttachments';
import { machineNativeEffectAdmission } from './local/services/launch/machineNativeEffectAdmission';
import { createMachineVitalsSampler, type MachineVitalsSampler } from './vitals/createMachineVitalsSampler';
import { createMachineVitalsReader } from './vitals/createMachineVitalsReader';
import { createMinuteHistoryStore } from './vitals/history/minuteHistoryStore';
import { createMachineResourceSummary, type MachineResourceSummary } from './resources/machineResourceSummary';
import { createMachineResourcesPolicyRuntime, type MachineResourcesPolicyRuntime } from './resources/machineResourcesPolicy';
import { createPersistedTakeoverAdmissionWaiter } from './spawn/persistedTakeoverAdmission';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import type { SessionSpawnDirectTargetTransport } from '@/session/actions/createCliActionDeps';
import type {
  ExternalSessionPersistedTakeoverAdmissionOwner,
} from '@/session/actions/externalSessions/persistedTakeoverAdmission';
import type {
  ExternalSessionPluginAdmissionOwner,
} from '@/session/actions/externalSessions/pluginExternalSessionAdmissionOwner';
import type { LocalServiceInventoryRoutes } from './local/services/inventory/routes';
import { createMachineLiveStreamCaptureRegistry } from './peer/mediation/stream';
import { createSimulatorInputLeaseManager } from './devices/simulator/lease';
import type {
  AgentExternalSessionsManagedEndpointReadHost,
} from '@/session/external/agentExternalSessionsInvocation';
import type {
  ManagedServiceSessionBaseUrlResolver,
  ManagedServiceSessionClientAccessResolver,
} from '@/plugins/runtime/invocation/services/managedServiceEndpointProjection';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createServerUrlServerFeaturesSnapshotStore, readServerFeaturesSnapshot } from '@/features/serverFeaturesSnapshotStore';
import { startServerFeaturesSnapshotRefreshLoop } from './serverFeaturesSnapshotRefreshLoop';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveMachineConnectionHandover } from './lifecycle/requestDaemonSelfRestart';
import { createDaemonPeerMediationObservabilityRuntime } from './machine/peerMediationObservabilityRuntime';
import { resolvePeerMediationTrustRoots as resolvePeerMediationTrustRootsFromSnapshot } from './peer/mediation/resolvePeerMediationTrustRoots';
import type { DaemonMachineIrohRuntime } from './peer/iroh/daemonMachineIrohRuntime';
import { prepareDaemonMachineIrohRuntime, createNativeRuntimeAbsentProviderBrokerError } from './startup/prepareDaemonMachineIrohRuntime';
import { createWorkspaceMachineCarrierTunnelOpen } from './peer/iroh/workspaceMachineCarrierTunnelOpen';
import { createProviderBrokerMachineCarrierTunnelOpen } from './peer/iroh/providerBrokerMachineCarrierTunnelOpen';
import {
  applyDaemonHomeDescriptorRefresh,
  prepareDaemonHomeIrohTransport,
  resolveCurrentDaemonHomeProfile,
  type DaemonHomeTransport,
} from './peer/iroh/daemonHomeIrohTransport';
import { resolveCurrentCliHomeTarget } from '@/server/homeTarget';
import { createDaemonSessionMutationCustody } from './connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { installPeerMediationObservabilityRuntimeActionContextProvider } from './peer/mediation/observability/runtimeActionContextProvider';
import {
  requestDaemonSelfRestartWithLockHandoff,
  resolveDaemonSelfRestartEnvironment,
} from './lifecycle/requestDaemonSelfRestartWithLockHandoff';
import {
  readDaemonRestartVerifyPollMs,
  readDaemonRestartVerifyTimeoutMs,
} from './startupWaitDefaults';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { DaemonPluginChangeOwner } from '@/plugins/daemon/changeService';
import { createDaemonPluginRuntimeOwner, createDaemonPluginTransferRpcResolver } from '@/plugins/daemon/runtimeOwner';
import { createDaemonPluginDevelopmentReviewApprovalPublisher } from '@/plugins/daemon/developmentReviewApproval';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { startBackgroundRegistryUpdateCheck } from '@/registries/updates/startBackgroundRegistryUpdateCheck';
import { createCliRegistryUpdateCheck } from '@/registries/updates/createCliRegistryUpdateCheck';
import { createClientActionMachineRpcExecutor } from '@/plugins/runtime/invocation/actions/clientActionMachineRpc';
import { DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY } from '@/plugins/runtime/context/daemonDatabaseLimitsPolicy';
import { createDaemonPluginAvailabilityReporter } from '@/plugins/availability/daemonReporter';
import { createDaemonPluginRegistryProjectionInvalidation } from './pluginRegistryProjectionInvalidation';
import { withTrackedSessionRpc } from './sessionEncryption/withTrackedSessionRpc';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createExternalSessionHostOperationOwner } from '@/session/external/hostOperationOwner';
import { resolveConnectedServiceQuotaFetcherDescriptors } from '@/plugins/projection/registry/connectedServiceQuotaFetchers';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
  resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceId,
} from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
import { createDaemonConnectedAccountPurposeBindingRuntime } from './connectedServices/purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import {
  createDaemonTeamCredentialDirectMaterialReconciler,
  subscribeTeamCredentialDirectMaterialAccountChanges,
  subscribeTeamCredentialDirectMaterialSourceChanges,
  type TeamCredentialDirectMaterialWakeReason,
  type TeamCredentialDirectMaterialSourceWake,
} from './connectedServices/directMaterial/daemonTeamCredentialDirectMaterialReconciler';
import { createHttpTeamCredentialDirectMaterialClient } from './connectedServices/directMaterial/teamCredentialDirectMaterialClient';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from '@happier-dev/protocol/providers/safety/limits';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { prepareProviderConnectionsCatalogForCli } from '@/providers/settings/hydrate';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { ProviderBrokerApplicationBindingV1, ProviderBrokerRelayApplicationBindingV1 } from '@happier-dev/protocol';
import type { TeamCredentialResourceSummaryV1 } from '@happier-dev/protocol/teams';
import {
  revalidateExternalProviderBrokerAuthorization,
  resolveRunnerCredentialSelectionCurrentness,
} from '@/providers/broker/daemonProviderBrokerRuntime';
import { readTeamCredentialBrokerResource, startDaemonProviderBrokerRuntimeWithCustody } from '@/providers/broker/startDaemonProviderBrokerRuntimeWithCustody';
import { projectTeamCredentialNativeProviderSourceAuthority } from '@/providers/broker/teamCredentialNativeProviderSource';
import {
  createConnectedServicesBrokerSourceMemberSelect,
  createConnectedServicesBrokerSourceOpen,
} from '@/providers/broker/connectedServicesSource';
import {
  createTeamCredentialBrokerSourceOwner,
  teamCredentialBrokerResourceAcceptsMachine,
} from '@/providers/broker/teamCredentialBrokerSourceOwner';
import { createTeamCredentialExternalModelCatalog, type TeamCredentialModelCatalogResolver } from '@/providers/broker/teamCredentialModelCatalog';
import {
  resolveTeamCredentialResourceCatalogApplications,
  resolveTeamCredentialSourceModelCatalog,
} from '@/providers/broker/resourceTestCandidate';
import {
  classifyTeamCredentialRequestRouteV1,
  evaluateTeamCredentialRequestPolicyV1,
} from '@/providers/broker/requestPolicyV1';
import { createProviderConnectionBrokerSourceOpen, isProviderConnectionDirectSourceCurrent, materializeProviderConnectionDirectCredential, resolveAdmittedProviderConnectionDirectSourceSnapshot } from '@/providers/broker/providerConnectionSource';
import { createProviderConnectionTeamCredentialSourceSnapshot } from '@/providers/broker/teamCredentialSourceSnapshot';
import { createProviderConnectionCpxBridge } from '@/providers/broker/providerConnectionCpxBridge';
import { createAccountConnectionBrokerSourceOpen, retireAccountConnectionBrokerSource } from '@/providers/broker/accountConnectionSource';
import { openAccountConnectionProviderBrokerAccess, reportAccountConnectionProviderBrokerOpenFailure } from '@/providers/broker/accountConnectionClient';
import { createDaemonAccountConnectionManagedConsumerOpen } from './providers/accountConnectionManagedConsumerComposition';
import { collectProviderConnectionDnsEvidence } from '@/providers/registry/dnsEvidence';
import { resolveProviderContributionRegistryView } from '@/providers/registry';
import { createProviderOperationLifetime } from '@/providers/operationLifetime';
import {
  getActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { hydrateSavedSecretCatalog } from "@/settings/secrets/savedSecretCatalogRead";
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { createManagedProviderOperationAuthority } from './connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountRequestAuthSubjectRegistry } from './connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from './connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { createDaemonTeamCredentialDirectMaterialOpen } from './providers/teamCredentialDirectMaterialComposition';
import { createDaemonSessionTeamCredentialNativeOpen, openDaemonSessionTeamCredentialProviderBinding, readDaemonSessionTeamCredentialNativeBinding } from './providers/sessionTeamCredentialProviderBindingComposition';
import { createDaemonSessionTeamCredentialNativeRelease, releaseDaemonSessionTeamCredentialNativeBindings } from './providers/sessionTeamCredentialNativeLifetime';
import { SessionTeamCredentialLaunchUnavailableError } from '@/session/services/sessionTeamCredentialLaunchError';
import {
  createCurrentRuntimeProviderOperationsSource,
  type RuntimeProviderOperationsProducer,
} from '@/providers/runtimeServices';
import {
  createConnectedAccountDaemonConfigurationOwner,
  createConnectedAccountDaemonRuntime,
} from './connectedServices/ConnectedAccountDaemonRuntime';
import {
  createActiveAccountSettingsConnectedAccountSecrets,
  createQualifiedConnectedAccountDaemonPersistence,
} from './connectedServices/qualifiedConnectedAccountDaemonPersistence';
import {
  createQualifiedConnectedAccountEstablishedRuntimeOwner,
} from './connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import {
  createQualifiedConnectedAccountAttemptTransactionAdapters,
} from './connectedServices/qualifiedConnectedAccountAttemptTransactionAdapters';
import {
  reconcileConnectedServicesProjectionForPluginConsumers as reconcileProjectionAndInvalidateConnectedAccounts,
} from './connectedServices/purposeBindings/reconcileConnectedServicesProjectionForPluginConsumers';
import {
  listQualifiedConnectedAccountGroupsV4,
  listQualifiedConnectedAccountsV4,
  readQualifiedConnectedAccountGroupV4,
  resolveQualifiedConnectedAccountAtomicV4Negotiation,
  resolveQualifiedConnectedAccountRemovalReviewNegotiation,
  resolveQualifiedConnectedAccountPeerClass,
  resolveQualifiedConnectedAccountPeerOperationTransport,
} from '@/api/client/qualifiedConnectedAccountApi';

function resolvePositiveIntEnv(raw: string | undefined, fallback: number, bounds: { min: number; max: number }): number {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

export function resolveDaemonRuntimeId(processEnv: NodeJS.ProcessEnv = process.env): string {
  const inheritedRuntimeId = String(processEnv.HAPPIER_DAEMON_RUNTIME_ID ?? '').trim();
  return inheritedRuntimeId || randomUUID();
}

function resolveDaemonPluginRecoveryRequestedFromEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return String(processEnv.HAPPIER_DAEMON_PLUGIN_RECOVERY ?? '').trim() === '1';
}

export async function startDaemon(
  options: Readonly<{ takeover?: boolean; pluginRecovery?: boolean }> = {},
): Promise<void> {
  process.env[PROCESS_OWNER_ENV_KEY] = formatProcessOwnerTag({ happierHomeDir: configuration.happyHomeDir,
    owner: { kind: 'happier' } });
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  const { requestShutdown, resolvesWhenShutdownRequested } = createDaemonShutdownController();
  const homeTransportCancellation = new AbortController();
  let publicProfileRefreshHandle: SingleFlightIntervalLoopHandle | null = null;
  void resolvesWhenShutdownRequested.then(() => homeTransportCancellation.abort());

  logger.debug('[DAEMON RUN] Starting daemon process...');
  // Which bytes this daemon is about to run. `startedWithCliVersion` is identical across
  // every bundle built from the same package version, so it cannot distinguish a current
  // build from one an earlier package build left in the checkout; this line can.
  const runningRuntime = resolveRunningCliRuntimeIdentity();
  logger.infoFile(
    `[DAEMON RUN] Runtime ${runningRuntime.tree ?? 'unknown'} ${runningRuntime.entrypoint ?? '(unresolved)'}`
    + ` built ${runningRuntime.builtAt ?? '(unverified)'}`,
  );
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const { waitForAuthEnabled, waitForAuthTimeoutMs } = resolveWaitForAuthConfig(process.env);

  let daemonLockHandle: Awaited<ReturnType<typeof acquireDaemonLock>> = null;
  let daemonStateOwner: Parameters<typeof writeDaemonStateForLockOwner>[1] | null = null;
  let machineVitals: MachineVitalsSampler | null = null;
  let machineVitalsAlerts: ReturnType<typeof createMachineVitalsAlerts> | null = null;
  let processLeftBehindPass: ReturnType<typeof createLeftBehindPass> | null = null;
  let machineResourceSummary: MachineResourceSummary | null = null;
  let machineResourcesPolicy: MachineResourcesPolicyRuntime | null = null;
  let machineProcessesView: MachineProcessesView | null = null;
  let daemonKeepAwake: ReturnType<typeof createDaemonKeepAwake> | null = null;
  let daemonGuard: Awaited<ReturnType<typeof createDaemonGuard>> | null = null;
  let sessionCeiling: ReturnType<typeof createSessionMemoryCeiling> | undefined;
  let guardSessionRestoration: ReturnType<typeof createGuardSessionRestoration> | null = null;
  let storageRoutes: DaemonStorageRoutes | null = null;
  const workspaceSyncRuntimeCustody =
    createDaemonWorkspaceSyncRuntimeCustody<ProductionDaemonWorkspaceSyncRuntime & Pick<ApiMachineClientLifecycleDependencies, 'createProjectFiniteRuntime' | 'readProjectFiniteLoad'>>();
  let projectWorkerAdmission: ReturnType<typeof createProjectWorkerAdmission> | null = null;
  let projectWorkerAction: ActionExecutorDeps['projectWorkerAction'];
  let machineIrohRuntime: DaemonMachineIrohRuntime | null = null;
  let homeIrohTransport: DaemonHomeTransport | null = null;
  const preparedIrohState: {
    machine: DaemonMachineIrohRuntime | null;
    home: DaemonHomeTransport | null;
    failedStartupCleanup: (() => Promise<void>) | null;
  } = { machine: null, home: null, failedStartupCleanup: null };
  let stopMachineIrohAcceptor: () => Promise<void> = async () => {};
  const stopWorkspaceSyncRuntime = workspaceSyncRuntimeCustody.stop;
  const runtimeId = resolveDaemonRuntimeId(process.env);
  const startupSource = resolveDaemonStartupSourceFromEnv(process.env);
  const serviceLabel = resolveDaemonServiceLabelFromEnv(process.env);
  const takeoverRequested = options.takeover ?? resolveDaemonTakeoverRequestedFromEnv(process.env);
  const pluginRecoveryRequested = options.pluginRecovery
    ?? resolveDaemonPluginRecoveryRequestedFromEnv(process.env);
  if (pluginRecoveryRequested) {
    logger.warn(
      '[PLUGIN RUNTIME] Recovery startup is skipping externally installed plugin activation; disable, remove, or repair the faulty plugin before a normal restart.',
    );
  }
  const publicReleaseChannel = getReleaseRingCatalogEntry(configuration.publicReleaseRing)
    .publicLabel as NonNullable<DaemonState['publicReleaseChannel']>;

  try {
    const ownershipGate = await ensureDaemonStartupOwnership({
      takeoverRequested,
      startupSource,
      runtimeId,
    });
    if (ownershipGate.action === 'exit') {
      return;
    }

    // Publish local ownership before authentication or Home transport can wait.
    // The same lock and state owner govern startup, the live listener and cleanup.
    daemonLockHandle = await acquireDaemonLock(5, 200);
    if (!daemonLockHandle) return;
    const startupState = {
      pid: process.pid,
      httpPort: 0,
      startedAt: Date.now(),
      startedWithCliVersion: configuration.currentCliVersion,
      startedWithPublicReleaseChannel: publicReleaseChannel,
      ...(runningRuntime.entrypoint ? { startedWithRuntimeEntrypoint: runningRuntime.entrypoint } : {}),
      ...(runningRuntime.builtAt ? { startedWithRuntimeBuiltAt: runningRuntime.builtAt } : {}),
      runtimeId,
      startupSource,
      ...(serviceLabel ? { serviceLabel } : {}),
      machineControlReady: false,
      daemonLogPath: logger.logFilePath,
    };
    if (!writeDaemonStateForLockOwner(daemonLockHandle, startupState)) {
      throw new Error('Daemon startup lost lifecycle ownership before publication');
    }
    daemonStateOwner = startupState;

    const credentialsGate = await waitForInitialCredentials({
      isInteractive,
      waitForAuthEnabled,
      waitForAuthTimeoutMs,
      credentialsPath: configuration.privateKeyFile,
      readCredentials: readStoredCredentials,
      acquireDaemonLock: () => acquireDaemonLock(5, 200),
      releaseDaemonLock: async handle => {
        if (daemonStateOwner) clearDaemonStateForLockOwner(handle, daemonStateOwner);
        await releaseDaemonLock(handle);
      },
      resolvesWhenShutdownRequested,
      logger,
      daemonLockHandle,
    });
    if (credentialsGate.action === 'exit') {
      await releaseDaemonOwnershipAfterFatal({ daemonLockHandle, daemonStateOwner });
      logger.flushSync();
      process.exit(credentialsGate.exitCode);
      return;
    }
    if (credentialsGate.action === 'shutdown') {
      return;
    }
    daemonLockHandle = credentialsGate.daemonLockHandle;

    const bootstrapContext = await prepareDaemonBootstrapContext({
      daemonLockHandle,
      initialMachineMetadata,
      startupSource,
      prepareServerTransport: async ({ persistedCredentials }) => {
        const applicationCarrierEligibility = readHomeApplicationCarrierEligibilityFromEnv(process.env);
        // Local native-endpoint initialization is optional carrier
        // preparation. Its failure is handed to the Home transport owner as
        // native-runtime unavailability; that owner is the single owner of the
        // trusted-HTTPS-or-fail-closed decision, and it still fails closed for
        // an Iroh-only Home or a selected-Iroh identity, authentication or
        // descriptor-integrity failure. No fallback decision is made here.
        const createdIrohRuntime = await prepareDaemonMachineIrohRuntime({
          applicationCarrierEligibility,
          readRuntimeOptions: () => ({
            happyHomeDir: configuration.happyHomeDir,
            relayConfig: resolveDaemonServiceIrohRelayConfig({ processEnv: process.env }),
          }),
        });
        if (createdIrohRuntime?.available) {
          preparedIrohState.machine = createdIrohRuntime;
        } else if (createdIrohRuntime) {
          if (createdIrohRuntime.reason === 'startup_failed') {
            preparedIrohState.failedStartupCleanup = createdIrohRuntime.shutdown;
          }
          logger.warn('[DAEMON RUN] Iroh carrier is unavailable; the Home transport owner evaluates independently trusted HTTPS', {
            reason: createdIrohRuntime.reason,
          });
        }
        preparedIrohState.home = await prepareDaemonHomeIrohTransport({
          signal: homeTransportCancellation.signal,
          runtime: preparedIrohState.machine,
          profile: await resolveCurrentDaemonHomeProfile(),
          applicationCarrierEligibility,
          ...(persistedCredentials ? { token: persistedCredentials.token } : {}),
        });
        logger.info('[DAEMON RUN] Home transport prepared', {
          carrier: preparedIrohState.home.carrier,
          observedPath: preparedIrohState.home.observedPath,
        });
      },
      verifyServerTransport: async ({ credentials }) => {
        if (!preparedIrohState.home) return;
        const readiness = await preparedIrohState.home.verifyAuthenticated(credentials.token);
        if (readiness.status !== 'ready') {
          throw new Error(readiness.errorMessage ?? `Authenticated Home transport probe failed: ${readiness.status}`);
        }
      },
    });
    machineIrohRuntime = preparedIrohState.machine;
    homeIrohTransport = preparedIrohState.home;
    daemonLockHandle = bootstrapContext.daemonLockHandle;
    const credentials = bootstrapContext.credentials;
    const api = bootstrapContext.api;
    // Authentication can establish a descriptor for a credential-seeded or
    // predecessor profile. Downstream owners consume that same persisted binding.
    const homeTarget = await resolveCurrentCliHomeTarget();
    // Missing/refused Project rows leave Project effects unavailable, while
    // unrelated daemon services remain usable with supported older Homes.
    await readProjectAccountRows({
      credentials,
      publication: 'installed',
      serverId: configuration.activeServerId,
      signal: homeTransportCancellation.signal,
    }).catch((error) => {
      if (homeTransportCancellation.signal.aborted) throw error;
      logger.warn('[DAEMON RUN] Project Account rows unavailable during startup', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    const preferredHost = bootstrapContext.preferredHost;
    const metadataForRegistration: MachineMetadata = bootstrapContext.metadataForRegistration;
    // This is the Account subject of the daemon's currently authenticated
    // connection, not a request claim or a persisted Account projection. An
    // opaque/malformed connection credential leaves public PAT ingress off.
    const externalActionAccountId = readAccountIdFromToken(credentials.token);
    const daemonSecretSources: import('@/plugins/runtime/lifecycle/contributions/targetSecretSources').TargetSecretSourcesV1 = {
      list: () => pluginReloadController.getState().activeRegistry?.secretSources?.list() ?? [],
      async acquire(source, options) {
        try {
          const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
            happyHomeDir: configuration.happyHomeDir, controller: pluginReloadController,
          });
          try {
            return await lease.registry.secretSources?.acquire(source, options)
              ?? { ok: false, code: 'source_unavailable', repair: 'configure' };
          } finally { await lease.release(); }
        } catch {
          return options?.signal?.aborted ? { ok: false, code: 'cancelled' }
            : { ok: false, code: 'source_unavailable', repair: 'configure' };
        }
      },
      async listFields(contribution, input, options) {
        try {
          const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
            happyHomeDir: configuration.happyHomeDir, controller: pluginReloadController,
          });
          try {
            return await lease.registry.secretSources?.listFields(contribution, input, options)
              ?? { ok: false, code: 'source_unavailable', repair: 'configure' };
          } finally { await lease.release(); }
        } catch {
          return options?.signal?.aborted ? { ok: false, code: 'cancelled' }
            : { ok: false, code: 'source_unavailable', repair: 'configure' };
        }
      },
      async store(contribution, input, options) {
        try {
          const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
            happyHomeDir: configuration.happyHomeDir, controller: pluginReloadController,
          });
          try {
            return await lease.registry.secretSources?.store(contribution, input, options)
              ?? { ok: false, code: 'source_unavailable', repair: 'configure' };
          } finally { await lease.release(); }
        } catch {
          return options?.signal?.aborted ? { ok: false, code: 'cancelled' }
            : { ok: false, code: 'source_unavailable', repair: 'configure' };
        }
      },
    };
    let pluginChangeService: DaemonPluginChangeOwner | null = null;
    const admissionDrain = createDaemonAdmissionDrain({
      isPluginHandoffQuiescing: () => pluginChangeService?.isQuiescing() === true,
    });
    let workflowRuntime: ReturnType<typeof createProductionDaemonWorkflowRuntime> | null = null;
    const getWorkflowRuntime = externalActionAccountId
      ? () => workflowRuntime ??= createProductionDaemonWorkflowRuntime({
          secretSources: daemonSecretSources,
          credentials,
          accountId: externalActionAccountId,
          serverId: configuration.activeServerId,
          admissionDrain,
        })
      : null;
    let preflightMachineRegistration = bootstrapContext.preflightMachineRegistration;
    let machineId = bootstrapContext.machineId;
    const deviceLocalSecretStorage = bootstrapContext.deviceLocalSecretStorage;

    let connectedServiceRefreshCoordinator: ConnectedServiceRefreshCoordinator | null = null;
    let connectedServiceRefreshLoopHandle: Readonly<{
      stop: () => void;
      pause: () => void;
      resume: () => void;
    }> | null = null;
    let connectedServiceQuotasCoordinator: ConnectedServiceQuotasCoordinator | null = null;
    let connectedServiceQuotasLoopHandle: ConnectedServiceQuotasLoopHandle | null = null;
    let teamCredentialDirectMaterialChangeCleanup: (() => void) | null = null;
    let teamCredentialDirectMaterialAccountChangeCleanup: (() => void) | null = null;
    let reconcileTeamCredentialDirectMaterialAfterSourceChange = (_reason: TeamCredentialDirectMaterialWakeReason): void => {};
    let daemonServerWorkScheduler: DaemonServerWorkScheduler | null = null;
    let apiMachineForSessions: ApiMachineClient | null = null;
    const postWorkflowMessage: NonNullable<import('./workflows/production').WorkflowProductionExecutionDeps['postWorkflowMessage']> = async (publication, options) => {
      const client = apiMachineForSessions;
      if (!client || homeTransportCancellation.signal.aborted || isDaemonQuiescing()
        || configuration.activeServerId !== requesterRuntimeServerId) {
        return { v: 1, ok: false, error: 'discussions_unavailable' };
      }
      return await client.postAgentDiscussionMessage(publication, options);
    };
    let managedMachinePolicyRuntime: ReturnType<typeof createDaemonManagedMachinePolicyRuntime> | null = null;
    let confidentialSecretFill: ReturnType<typeof api.createConfidentialSecretFillExecutor> | null = null;
    let confidentialActionInputs: ReturnType<typeof api.createConfidentialActionInputsExecutor> | null = null;
    const machineAdmissionTransport = async (
      request: Parameters<ApiMachineClient['enqueueSessionPendingByMachine']>[0],
      options?: Parameters<ApiMachineClient['enqueueSessionPendingByMachine']>[1],
    ) => {
      const currentApiMachine = apiMachineForSessions;
      if (!currentApiMachine) {
        return { status: 'rejected' as const, code: 'session_input_target_unavailable' as const };
      }
      return await currentApiMachine.enqueueSessionPendingByMachine(request, options);
    };
    const releaseMachineAdmissionTransport = installDaemonMachineAdmissionTransport({
      serverId: configuration.activeServerId,
      transport: machineAdmissionTransport,
      clientActionExecute: createClientActionReverseDispatcher(() => apiMachineForSessions),
      confidentialSecretFill: async (args) => confidentialSecretFill
        ? await confidentialSecretFill(args) : { status: 'refused', code: 'target_unavailable' },
      confidentialActionInputs: async (args) => confidentialActionInputs
        ? await confidentialActionInputs(args) : { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' },
    });
    let apiMachine: ApiMachineClient | null = null;
    let machineBootstrapRuntime: ReturnType<typeof createDaemonMachineBootstrapRuntime> | null = null;
    let homeTransportReplacementPending = false;
    const eventLoopStallMonitor = createDaemonEventLoopStallMonitor({
      getActiveRpcOperations: () =>
        apiMachineForSessions?.getActiveRpcHandlerExecutions() ?? [],
      warn: (message, data) => logger.warn(message, data),
    });
    eventLoopStallMonitor.start();
    let localServiceInventoryRoutes: Pick<LocalServiceInventoryRoutes, 'getSnapshot' | 'watchSnapshot'> | null = null;
    let localServiceSummary: Parameters<typeof createDaemonMachineBootstrapRuntime>[0]['localServiceSummary'];
    let isProjectServiceExecutionLive: (() => boolean) | undefined;
    let acquireLocalServicePreviewApplication: Parameters<typeof createDaemonMachineBootstrapRuntime>[0]['acquireLocalServicePreviewApplication'];
    const persistedTakeoverAdmissionWaiter =
      createPersistedTakeoverAdmissionWaiter();
    let persistedTakeoverAdmissionOwner:
      ExternalSessionPersistedTakeoverAdmissionOwner | null = null;
    const attachPersistedTakeoverAdmissionOwner = (
      owner: ExternalSessionPersistedTakeoverAdmissionOwner,
    ): (() => void) => {
      persistedTakeoverAdmissionOwner = owner;
      return () => {
        if (persistedTakeoverAdmissionOwner === owner) {
          persistedTakeoverAdmissionOwner = null;
        }
      };
    };
    const machineRpcRouteAttachments = createDaemonMachineRpcRouteAttachmentCache({
      getApiMachineForSessions: () => apiMachineForSessions,
    });
    machineResourcesPolicy = createMachineResourcesPolicyRuntime({
      port: {
        read: async () => apiMachine?.getMachineMetadataSnapshot() ?? { status: 'unavailable' },
        compareAndSwap: async input => apiMachine
          ? apiMachine.compareAndSwapMachineMetadata(input) : { status: 'unavailable' },
      },
      readVolumeCapacityBytes: () => {
        const disk = machineVitals?.latest()?.disk;
        return disk?.reported ? disk.volumes.map(volume => volume.totalBytes) : [];
      },
    });
    const { configureLanguageServerHost } = await import('@/lsp/languageServerHost');
    configureLanguageServerHost({
      readPolicy: () => machineResourcesPolicy?.read() ?? { status: 'unavailable' },
    });
    const machineVitalsHistory = await createMinuteHistoryStore({
      directory: join(dirname(configuration.daemonStateFile), 'vitals'),
    });
    machineVitals = createMachineVitalsSampler({
      readers: createMachineVitalsReader({ signal: homeTransportCancellation.signal }),
      historyStore: machineVitalsHistory,
      readPolicy: () => {
        const snapshot = machineResourcesPolicy?.read();
        return snapshot?.status === 'ready' ? snapshot.policy : null;
      },
      onTick: () => { machineResourceSummary?.refresh(); daemonGuard?.refreshOnTick(); projectWorkerAdmission?.notifyChanged(); },
    });
    await machineVitals.start();
    daemonKeepAwake = createDaemonKeepAwake({ policy: machineResourcesPolicy, vitals: machineVitals });
    await daemonKeepAwake.start();
    machineResourceSummary = createMachineResourceSummary({
      sampler: machineVitals,
      readNearlyFull: () => {
        const snapshot = machineResourcesPolicy?.read();
        return snapshot?.status === 'ready' ? snapshot.policy.alerts.disk.threshold : null;
      },
      onError: error => logger.warn('[DAEMON RUN] Machine resources summary publication failed', error),
    });
    machineResourcesPolicy.subscribe(() => machineResourceSummary?.refresh());
    const machineResourceTarget = () => {
      const installation = readInstallationIdentityIfExistsSync();
      const custodianAccountId = readAccountIdFromToken(credentials.token);
      if (!machineId || !installation || !custodianAccountId) return null;
      return { serverId: configuration.activeServerId, machineId,
        installationId: installation.installationId, custodianAccountId };
    };
    machineRpcRouteAttachments.attachMachineResourcesPolicyRoutes({ policy: machineResourcesPolicy, target: machineResourceTarget });
    const machineAdminAccessRoutes = createDaemonMachineAdminAccessRoutes({
      getMachineClient: () => apiMachine, target: machineResourceTarget,
    });
    machineRpcRouteAttachments.attachMachineAdminAccessRoutes(machineAdminAccessRoutes);
    machineRpcRouteAttachments.attachMachineVitalsRoutes({
      sampler: machineVitals,
      target: machineResourceTarget,
      readAttention: () => machineResourceSummary?.getSummary()?.attention,
    });
    const liveStreamCaptureRegistry = createMachineLiveStreamCaptureRegistry();
    const simulatorInputLeaseManager = createSimulatorInputLeaseManager({ ttlMs: 30_000 });
    // PMS-WIRE: own the peer-mediation observability store ONCE at startup. Its emitter is handed to
    // the machine-sync bootstrap relay terminators (write-path) and its store is published on the Api
    // provider bridge below so the runtime-action dispatch (read-path) returns LIVE counters from the
    // SAME store. The daemon's own scope is derived from the credential subject; without it the bridge
    // stays unregistered and the read-path executor fails closed.
    const peerMediationObservabilityRuntime = createDaemonPeerMediationObservabilityRuntime({
      isEnabled: () => {
        const snapshot = serverFeaturesSnapshotStore.getSnapshot();
        return snapshot?.status === 'ready'
          && readServerEnabledBit(snapshot.features, 'machines.peerMediation.observability') === true;
      },
    });
    installPeerMediationObservabilityRuntimeActionContextProvider({
      api,
      credentialsToken: credentials.token,
      runtime: peerMediationObservabilityRuntime,
      machineId: () => machineId,
      logger,
    });
    // G9-E: own the daemon-wide cached server-features snapshot ONCE at startup and publish its
    // synchronous read on the Api provider bridge so the runtime-action front door's feature gate
    // reads the LIVE server bits cold. Without this, `getServerFeaturesSnapshot` is undefined
    // daemon-wide and every server-represented runtime-action family (e.g. localServices.preview)
    // fails closed even when the server enables it. The store reuses the same `/v1/features` fetch
    // source the local-services inventory + browser daemon gates already use — no second fetch path.
    let retireProviderBrokerClaimsForFeatureDisable: (() => Promise<void>) | null = null;
    const serverFeaturesSnapshotStore = createServerUrlServerFeaturesSnapshotStore({
      serverUrl: resolveServerHttpBaseUrl,
      token: credentials.token,
      onAuthenticatedReady: async (features) => {
        await applyDaemonHomeDescriptorRefresh({
          features,
          homeTarget,
          requestReconnect: () => {
            if (!apiMachine?.requestServerTransportReconnect()) {
              homeTransportReplacementPending = true;
              return;
            }
            homeTransportReplacementPending = false;
          },
        });
        await apiMachine?.refreshProviderBrokerIngressAdvertisement(features);
        await hydrateSavedSecretCatalog({
          token: credentials.token,
        }).catch((error) => {
          logger.debug('[DAEMON RUN] Saved Secret catalog feature reconciliation failed (non-fatal)', {
            error: serializeAxiosErrorForLog(error),
          });
        });
        if (readServerEnabledBit(features, 'teams.credentialResources') !== true) {
          await retireProviderBrokerClaimsForFeatureDisable?.();
        }
      },
      onError: (error) => {
        logger.debug('[DAEMON RUN] Server-features snapshot refresh failed (non-fatal)', error);
      },
    });
    const resolvePeerMediationTrustRoots = () => {
      return resolvePeerMediationTrustRootsFromSnapshot(
        serverFeaturesSnapshotStore.getSnapshot(),
        Date.now(),
      );
    };
    let refreshBrowserRouteOwners: (() => Promise<void>) | null = null;
    const minimumServerFeaturesSnapshotRefreshIntervalMs = 30_000;
    // Prime offline-safe (non-blocking): a freshly booted daemon warms the cache so the first
    // session runtime-action dispatch reads real bits rather than failing closed. After the session
    // control runtime exists, the same refresh also gives browser route owners a late-registration
    // chance if the server was temporarily unreachable during startup.
    const serverFeaturesSnapshotRefreshLoop = startServerFeaturesSnapshotRefreshLoop({
      refresh: async () => { await serverFeaturesSnapshotStore.refresh(); },
      isTransitionActive: serverFeaturesSnapshotStore.isRefreshTransitionActive,
      transitionIntervalMs: minimumServerFeaturesSnapshotRefreshIntervalMs,
      onError: (error) => {
        logger.debug('[DAEMON RUN] Server-features scheduled refresh failed (non-fatal)', error);
      },
    });
    const refreshServerFeaturesSnapshot = async () => {
      await serverFeaturesSnapshotRefreshLoop.refresh();
      return serverFeaturesSnapshotStore.getSnapshot();
    };
    const refreshServerFeaturesAndBrowserRouteOwners = async (): Promise<void> => {
      await refreshServerFeaturesSnapshot();
      // The route owner's gate may request features itself. Keep that consumer
      // outside the feature fetch flight, so it cannot await its own producer.
      await refreshBrowserRouteOwners?.();
    };
    api.setServerFeaturesSnapshotProvider(
      () => serverFeaturesSnapshotStore.getSnapshot(),
      refreshServerFeaturesSnapshot,
    );
    let automationWorker: AutomationWorkerHandle | null = null;
    let memoryWorker: MemoryWorkerHandle | null = null;
    let voiceInferenceWorker: VoiceInferenceWorkerHandle | null = null;
    let pluginWebhookWorker: PluginWebhookDaemonWorkerHandleV1 | null = null;
    let pluginWebhookWakeCleanup: (() => void) | null = null;
    let providerOperationsProducer: RuntimeProviderOperationsProducer | null = null;
    let externalSessionPluginAdmissionOwner:
      ExternalSessionPluginAdmissionOwner | null = null;
    let externalSessionHostActionExecutor: RpcActionExecutor | null = null;
    let sessionSpawnDirectTargetTransport:
      SessionSpawnDirectTargetTransport | null = null;
    const pluginAdmissionOwner: ExternalSessionPluginAdmissionOwner =
      Object.freeze({
        async materializeStart(input) {
          const start = externalSessionPluginAdmissionOwner?.materializeStart;
          if (!start) {
            return {
              ok: false,
              error: {
                code: 'source_unavailable',
                message: 'External-session materialization is unavailable.',
              },
            };
          }
          return await start(input);
        },
        async takeoverStart(input, context) {
          const start = externalSessionPluginAdmissionOwner?.takeoverStart;
          if (!start) {
            return {
              ok: false,
              error: {
                code: 'source_unavailable',
                message: 'External-session takeover is unavailable.',
              },
            };
          }
          return await start(input, context);
        },
        async hookManagementAction(actionId, input, options) {
          const execute =
            externalSessionPluginAdmissionOwner?.hookManagementAction;
          if (!execute) {
            return {
              ok: false,
              errorCode: 'unsupported_action',
              error: `unsupported_action:${actionId}`,
            };
          }
          return await execute(actionId, input, options);
        },
      });
    const providerOperationsSource =
      createCurrentRuntimeProviderOperationsSource(
        () => providerOperationsProducer,
      );
    let resolveInitialPluginRegistryPublished!: () => void;
    const initialPluginRegistryPublished = new Promise<void>((resolve) => {
      resolveInitialPluginRegistryPublished = resolve;
    });
    let resolveMachineProviderBindingSettled!: () => void;
    const machineProviderBindingSettled = new Promise<void>((resolve) => {
      resolveMachineProviderBindingSettled = resolve;
    });
    const daemonSessionMutationCustody = createDaemonSessionMutationCustody({ credentials });
    let cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop = async (
      _input: Readonly<{ sessionId: string }>,
    ): Promise<unknown> => null;
    let machineConnectionStateCleanup: (() => void) | null = null;
    let stopPeerMediationLoopbackServer: () => Promise<void> = async () => {};
    let daemonConnectivityCoordinator: ReturnType<typeof createDaemonConnectivityCoordinator> | null = null;
    const isDaemonQuiescing = admissionDrain.isQuiescing;
    let publishSessionPluginCatalogInvalidation = (_revision: number): void => {};
    const pluginRegistryProjectionInvalidation =
      createDaemonPluginRegistryProjectionInvalidation({
        getApiMachine: () => apiMachine,
        isDaemonQuiescing: admissionDrain.isPublicationQuiescing,
        onProjectionInvalidated: revision => publishSessionPluginCatalogInvalidation(revision),
        onPublicationFailure: (error) => {
          logger.warn('[DAEMON RUN] Failed to publish durable plugin registry invalidation', {
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });
    const publishDaemonStateForCurrentOwner = (
      state: Parameters<typeof writeDaemonStateForLockOwner>[1],
    ): boolean => {
      const published = !admissionDrain.isPublicationQuiescing()
      && daemonLockHandle !== null
      && writeDaemonStateForLockOwner(daemonLockHandle, state);
      if (published) daemonStateOwner = state;
      return published;
    };
    let resumeQuiescedMachineRegistration = (): void => {};
    let resumeQuiescedMachineConnectionPublications = async (): Promise<void> => {};
    let resumeQuiescedMachineSyncStartup = async (): Promise<void> => {};
    let resumeQuiescedTransferStatePublication = async (): Promise<void> => {};
    const quiescePluginChangesForLockHandoff = async () => {
      if (!pluginChangeService) {
        throw new Error('Daemon plugin-change service is unavailable for lock handoff');
      }
      const quiescence = await pluginChangeService.quiesceForHandoff();
      admissionDrain.notifyPluginHandoffChanged();
      return {
        resume: async () => {
          await quiescence.resume();
          admissionDrain.notifyPluginHandoffChanged();
          pluginRegistryProjectionInvalidation.resume();
          resumeQuiescedMachineRegistration();
          await resumeQuiescedMachineConnectionPublications();
          try {
            await resumeQuiescedMachineSyncStartup();
          } finally {
            await resumeQuiescedTransferStatePublication();
          }
        },
      };
    };

    const pidToTrackedSession = new Map<number, TrackedSession>();
    let releaseAcpCatalogHydrationObserver: (() => void) | undefined;
    let storageModelPacks: DaemonPublicVoiceModelPackRuntime | null = null;
    let storageRecordings: BrowserRecordingDaemonRuntime | null = null;
    const storageOwnerListeners = new Set<() => void>();
    let unsubscribeStorageRecordings: (() => void) | undefined;
    let unsubscribeStorageModels: (() => void) | undefined;
    const notifyStorageOwnerChanged = () => { for (const listener of storageOwnerListeners) listener(); };
    const subscribeStorageModels = () => {
      const cleanups = [storageModelPacks?.subscribeChanges(notifyStorageOwnerChanged),
        storageModelPacks?.subscribeInvalidations?.(notifyStorageOwnerChanged)];
      return () => { for (const cleanup of cleanups) cleanup?.(); };
    };
    const bindStorageRecordings = (runtime: BrowserRecordingDaemonRuntime | null) => {
      unsubscribeStorageRecordings?.();
      unsubscribeStorageRecordings = undefined;
      storageRecordings = runtime;
      if (storageOwnerListeners.size) unsubscribeStorageRecordings = runtime?.service.subscribeStorageChanges(notifyStorageOwnerChanged);
      notifyStorageOwnerChanged();
    };
    const bindStorageModels = (runtime: DaemonPublicVoiceModelPackRuntime | null) => {
      unsubscribeStorageModels?.();
      unsubscribeStorageModels = undefined;
      storageModelPacks = runtime;
      if (storageOwnerListeners.size) unsubscribeStorageModels = subscribeStorageModels();
      notifyStorageOwnerChanged();
    };
    let sessionActivityOwner: LiveWorkProducerV1 | null = null;
    const sessionActivity = createLiveWorkProducerGroup(() => sessionActivityOwner ? [sessionActivityOwner] : null);
    const machineActivity = createLiveWorkProducerGroup(() => apiMachineForSessions
      ? [apiMachineForSessions.getLiveWorkProducer()] : null);
    const automationActivity = createLiveWorkProducerGroup(() => automationWorker
      ? [automationWorker.liveWorkProducer] : null);
    const serviceActivity = createLiveWorkProducerGroup(() => {
      const lease = pluginReloadController.tryAcquireRuntimeRegistry();
      if (!lease) return null;
      const source = lease.registry.projectManagedServices.activity;
      void lease.release();
      return [source];
    });
    const syncActivity = createLiveWorkProducerGroup(() => {
      const runtime = workspaceSyncRuntimeCustody.get();
      return runtime ? [runtime.activity] : null;
    });
    let transferActivityOwner: LiveWorkProducerV1 | null = null;
    const transferActivity = createLiveWorkProducerGroup(() => transferActivityOwner ? [transferActivityOwner] : null);
    const executionRunActivity = createExecutionRunLiveWorkProducer();
    const managedActivity = createManagedActivityInventory({ producers: [
      sessionActivity, machineActivity, automationActivity, serviceActivity, syncActivity,
      transferActivity, executionRunActivity, getDaemonAgentInstallJobOwner({ admissionDrain,
        invalidateInventory: pluginRegistryProjectionInvalidation.invalidateProjection,
        accountId: readAccountIdFromToken(credentials.token) ?? undefined,
        readTrackedSessions: () => pidToTrackedSession.values(), readAcpCatalog: () => {
          const snapshot = getActiveAccountSettingsSnapshot();
          return snapshot?.scopeKey === resolveAccountSettingsScopeKey(credentials) ? snapshot.acpCatalog : undefined;
        } }).activity,
    ] });
    const releaseManagedActivityRegistryEdges = pluginReloadController.subscribe(() => serviceActivity.notifyChanged());
    machineVitalsAlerts = createMachineVitalsAlerts({
      sampler: machineVitals, historyStore: machineVitalsHistory, policy: machineResourcesPolicy,
      notify: async (transition, sample, policy) => {
        const snapshot = getActiveAccountSettingsSnapshot();
        const target = machineResourceTarget();
        if (!snapshot || !target || snapshot.scopeKey !== resolveAccountSettingsScopeKey(credentials))
          throw new Error('machine_vitals_notification_account_unavailable');
        const inventory = await managedActivity.read();
        const workingSessionCount = readMachineVitalsWorkingSessionCount(inventory);
        const metadata = apiMachine?.getMachineMetadataSnapshot();
        const displayName = metadata?.status === 'ready' && typeof metadata.metadata.displayName === 'string'
          ? metadata.metadata.displayName.trim() : undefined;
        const hostName = metadata?.status === 'ready' && typeof metadata.metadata.host === 'string'
          ? metadata.metadata.host : undefined;
        await dispatchMachineVitalsAlertNotificationAsync({
          transition, latest: sample, machineId: target.machineId, machineName: displayName || hostName,
          ...(workingSessionCount === undefined ? {} : { workingSessionCount }),
          guardEnabled: policy.guard.memoryGuard.enabled,
          settings: snapshot.settings, settingsSecretsReadKeys: snapshot.settingsSecretsReadKeys,
          notificationChannelCatalog: snapshot.notificationChannelCatalog ?? { status: 'loading' },
          savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(snapshot),
          isCurrent: () => !homeTransportCancellation.signal.aborted && getActiveAccountSettingsSnapshot() === snapshot,
          expoPushSender: api.push(),
          usageNoticeArtifactStore: { accountId: target.custodianAccountId, store: createCredentialedAccountArtifactStore(credentials) },
        });
      },
      onError: error => logger.warn('[DAEMON RUN] Machine vitals alert failed', error),
    });
    const spawnResourceCleanupByPid = new Map<number, () => void | Promise<void>>();
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
    const connectedServicesRestartRequestedPids = new Set<number>();
    const connectedServicesMaterializationBaseDir = resolveConnectedServicesMaterializationBaseDir(configuration.happyHomeDir);
    const connectedServiceRuntimeRegistry = new ConnectedServiceRuntimeRegistry();
    let connectedServiceMaterializedHomeCleanupInterval: NodeJS.Timeout | null = null;
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
    const pidToSpawnResultResolver = new Map<number, (result: SpawnSessionResult) => void>();
    const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
    let hasPendingRunnerRestarts = () => false;
    const beforeShutdown = createBeforeShutdownDrain({
      hasPendingRunnerRestarts: () => hasPendingRunnerRestarts(),
      admissionDrain,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      pidToTrackedSession,
      shutdownSpawnDrainGraceMs: resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_MS,
        10_000,
        { min: 0, max: 120_000 },
      ),
      shutdownSpawnDrainPollMs: resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_SHUTDOWN_SPAWN_DRAIN_POLL_MS,
        100,
        { min: 10, max: 5_000 },
      ),
      getApiMachineForSessions: () => apiMachineForSessions,
      retireFiniteExecution: async () => await machineBootstrapRuntime?.retireProjectFiniteExecution(),
      buildUnexpectedSpawnResult: (errorMessage) => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage,
      }),
      buildIncompleteRetirementResult: () => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage:
          'startup_retirement_incomplete:exit_cleanup_incomplete',
      }),
      drainBackgroundServerWork: async () => {
        homeTransportCancellation.abort();
        releaseAcpCatalogHydrationObserver?.();
        storageRoutes?.dispose();
        storageRoutes = null;
        await daemonGuard?.stop();
        daemonGuard = null;
        await daemonKeepAwake?.stop();
        daemonKeepAwake = null;
        processLeftBehindPass?.dispose();
        processLeftBehindPass = null;
        machineProcessesView?.dispose();
        machineProcessesView = null;
        await machineVitalsAlerts?.stop();
        machineVitalsAlerts = null;
        machineResourceSummary?.stop();
        machineResourceSummary = null;
        machineResourcesPolicy?.stop();
        machineResourcesPolicy = null;
        await machineVitals?.stop();
        machineVitals = null;
        await managedMachinePolicyRuntime?.stop();
        managedMachinePolicyRuntime = null;
        releaseManagedActivityRegistryEdges();
        managedActivity.dispose();
        for (const source of [sessionActivity, machineActivity, automationActivity, serviceActivity, syncActivity, transferActivity]) source.dispose();
        await getDaemonAgentInstallJobOwner().shutdown();
        await stopWorkspaceSyncRuntime();
        pluginWebhookWakeCleanup?.();
        pluginWebhookWakeCleanup = null;
        await pluginWebhookWorker?.stop();
        pluginWebhookWorker = null;
        await pluginChangeService?.shutdown();
        pluginChangeService = null;
        if (connectedServiceMaterializedHomeCleanupInterval) {
          clearInterval(connectedServiceMaterializedHomeCleanupInterval);
          connectedServiceMaterializedHomeCleanupInterval = null;
        }
        teamCredentialDirectMaterialChangeCleanup?.();
        teamCredentialDirectMaterialChangeCleanup = null;
        teamCredentialDirectMaterialAccountChangeCleanup?.();
        teamCredentialDirectMaterialAccountChangeCleanup = null;
        serverFeaturesSnapshotRefreshLoop.stop();
        await connectedServiceQuotasCoordinator?.flushInBandQuotaPersistence(2_000);
        await daemonServerWorkScheduler?.flushAll(2_000);
      },
      disposePluginRuntimeRegistry: async () => {
        await pluginReloadController.shutdown({
          timeoutMs: resolvePositiveIntEnv(
            process.env.HAPPIER_DAEMON_PLUGIN_RUNTIME_SHUTDOWN_TIMEOUT_MS,
            5_000,
            { min: 0, max: 60_000 },
          ),
        });
      },
    });
    const {
      loadLocalSessionMetadataForHandoff,
      resolveHostedSessionWorkingDirectory,
    } = createDaemonSessionHandoffMetadataBridge({
      pidToTrackedSession,
      getMachineId: () => machineId,
    });
    const sshTunnelSupervisor = createSshTunnelSupervisor();
    await sshTunnelSupervisor.adoptPersistedTunnels();

    let orphanedDeadDaemonSessions: Awaited<
      ReturnType<typeof reattachTrackedSessionsFromMarkers>
    >['orphanedDeadDaemonSessions'] = [];
    let disconnectedTerminalHostCandidates: NonNullable<
      Awaited<ReturnType<typeof reattachTrackedSessionsFromMarkers>>['disconnectedTerminalHostCandidates']
    > = [];
    let unresolvedTerminalHostSessionIds: ReadonlyArray<string> = [];
    let terminalHostAdapterInventoryPromise: ReturnType<typeof createDefaultTerminalHostAdapterInventory> | null = null;
    const loadTerminalHostAdapters = async () => {
      terminalHostAdapterInventoryPromise ??= createDefaultTerminalHostAdapterInventory({
        happyHomeDir: configuration.happyHomeDir,
        preference: process.platform === 'win32' ? 'zellij' : 'auto',
      });
      return (await terminalHostAdapterInventoryPromise).adapters;
    };
    const skillStore = createSkillStore({ happyHomeDir: configuration.happyHomeDir,
      readLibraryDigests: () => readSkillLibraryDigests(credentials) });
    const skillUsageRecorder = createSkillUsageRecorder({ credentials, signal: homeTransportCancellation.signal });
    const startupProcessMarkers = await listSessionMarkers();
    // Retain known lifecycle facts, not process membership or native handles. All membership is re-read.
    const endedProcessRoots = new Map<string, HappierProcessRootSource>();
    const startupReattachResult = await reattachTrackedSessionsFromMarkers({
      pidToTrackedSession,
      credentials,
      deviceLocalSecretStorage,
      loadTerminalHostAdapters,
    });
    orphanedDeadDaemonSessions = startupReattachResult.orphanedDeadDaemonSessions;
    for (const session of orphanedDeadDaemonSessions) {
      if (session.recoveredLiveSession || session.processStartTimeMs === undefined) continue;
      const marker = startupProcessMarkers.find(candidate => candidate.pid === session.pid
        && candidate.happySessionId === session.sessionId && candidate.processStartTimeMs === session.processStartTimeMs);
      if (!marker) continue;
      const root = reconstructEndedSessionProcessRoot({ marker, session, endedAtMs: Date.now() });
      if (root) endedProcessRoots.set(`${processOwnerKey(root.owner)}:${root.pid}`, root);
    }
    disconnectedTerminalHostCandidates = startupReattachResult.disconnectedTerminalHostCandidates ?? [];
    unresolvedTerminalHostSessionIds = startupReattachResult.unresolvedTerminalHostSessionIds ?? [];
    await skillStore.reconcileSkillSessionDirs({
      liveSessionIds: startupReattachResult.inventoryReliable === true
        ? [...pidToTrackedSession.values()].map(tracked => tracked.happySessionId).filter((id): id is string => Boolean(id))
        : null,
    }).catch(error => logger.warn('[DAEMON RUN] Skill store startup reconciliation unavailable', { error }));
    const pendingSessionMachineAccessBindingIds = new Set(startupReattachResult.recoveredLiveSessionIds ?? []);
    let sessionMachineAccessBindingReconcileInFlight: Promise<void> | null = null;
    const reconcileSessionMachineAccessBindings = async (): Promise<void> => {
      if (!apiMachineForSessions || pendingSessionMachineAccessBindingIds.size === 0) return;
      if (sessionMachineAccessBindingReconcileInFlight) {
        await sessionMachineAccessBindingReconcileInFlight;
        if (!apiMachineForSessions || pendingSessionMachineAccessBindingIds.size === 0) return;
      }

      sessionMachineAccessBindingReconcileInFlight = (async () => {
        const liveSessionsById = new Map<string, TrackedSession>();
        for (const tracked of pidToTrackedSession.values()) {
          const sessionId = tracked.happySessionId?.trim();
          if (sessionId) liveSessionsById.set(sessionId, tracked);
        }
        for (const sessionId of pendingSessionMachineAccessBindingIds) {
          const tracked = liveSessionsById.get(sessionId);
          if (!tracked) {
            pendingSessionMachineAccessBindingIds.delete(sessionId);
            continue;
          }
          try {
            await reconcileRecoveredSessionMachineControl({
              credentials,
              sessionId,
              machineId,
              runnerPid: tracked.sessionRunnerPid ?? tracked.pid,
            });
            pendingSessionMachineAccessBindingIds.delete(sessionId);
          } catch (error) {
            logger.warn('[DAEMON RUN] Failed to reconcile recovered session machine control; will retry on reconnect', {
              sessionId,
              machineId,
              error: serializeAxiosErrorForLog(error),
            });
          }
        }
      })().finally(() => {
        sessionMachineAccessBindingReconcileInFlight = null;
      });
      await sessionMachineAccessBindingReconcileInFlight;
    };
    pruneHappyCliRunnerSnapshots(
      resolveLiveRunnerSnapshotFingerprints(pidToTrackedSession.values()),
    );
    if (shouldUseSystemdUserSessionResourceGovernor({ platform: process.platform, startupSource })) {
      const migratedTrackedSessionProcesses = await migrateTrackedSessionProcessesOutOfDaemonServiceCgroup({
        trackedSessions: pidToTrackedSession.values(),
        daemonPid: process.pid,
      });
      if (migratedTrackedSessionProcesses.length > 0) {
        logger.debug('[DAEMON RUN] Moved reattached session runner process(es) out of the daemon service cgroup', {
          migrations: migratedTrackedSessionProcesses,
        });
      }
    }

    const resolveGroupDeletionAuthority = async ({
      serviceId,
      groupId,
    }: Readonly<{
      serviceId: ConnectedServiceId;
      groupId: string;
    }>) => {
      if (
        resolveQualifiedConnectedAccountAtomicV4Negotiation(
          serverFeaturesSnapshotStore.getSnapshot(),
        ) !== 'advertised'
      ) {
        return { status: 'unknown' as const };
      }
      const service =
        resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceId(
          serviceId,
        );
      if (!service) return { status: 'unknown' as const };
      try {
        const group = await readQualifiedConnectedAccountGroupV4({
          token: credentials.token,
          group: { service, groupId },
        });
        return { status: group === null ? 'deleted' as const : 'exists' as const };
      } catch (error) {
        if (readHttpStatus(error) === 404) return { status: 'unknown' as const };
        throw error;
      }
    };
    const connectedServiceGroupHomeCleanupScheduler = createConnectedServiceGroupHomeCleanupScheduler({
      activeServerDir: configuration.activeServerDir,
      runtimeRegistry: connectedServiceRuntimeRegistry,
      pidToTrackedSession,
      resolveGroupDeletionAuthority,
    });
    void connectedServiceGroupHomeCleanupScheduler.reconcileDeletedGroupHomes({
      resolveGroupDeletionAuthority,
    }).catch((error) => {
      logger.debug('[DAEMON RUN] Connected-service group home startup reconciliation failed (non-fatal)', error);
    });
    const connectedServiceMaterializedHomeCleanupScheduler = createConnectedServiceMaterializedHomeCleanupScheduler({
      baseDir: connectedServicesMaterializationBaseDir,
      isolationBaseDir: join(configuration.activeServerDir, 'isolation'),
      pidToTrackedSession,
      orphanTtlMs: resolvePositiveIntEnv(
        process.env.HAPPIER_CONNECTED_SERVICES_MATERIALIZED_HOME_ORPHAN_TTL_MS,
        7 * 24 * 60 * 60_000,
        { min: 60_000, max: 90 * 24 * 60 * 60_000 },
      ),
      attemptTtlMs: resolvePositiveIntEnv(
        process.env.HAPPIER_CONNECTED_SERVICES_MATERIALIZED_HOME_ATTEMPT_TTL_MS,
        60 * 60_000,
        { min: 60_000, max: 7 * 24 * 60 * 60_000 },
      ),
      maxCleanupRetries: resolvePositiveIntEnv(
        process.env.HAPPIER_CONNECTED_SERVICES_MATERIALIZED_HOME_CLEANUP_MAX_RETRIES,
        3,
        { min: 1, max: 20 },
      ),
      getRetainedMaterializationKeys: async () => await readRetainedConnectedServiceMaterializationKeys({
        credentials,
      }).catch((error) => {
        logger.debug('[DAEMON RUN] Connected-service materialized home retained-session scan failed (non-fatal)', error);
        return { status: 'unavailable' };
      }),
      sanitizeRetainedMaterializedHome: async (homeRootDir) => {
        for (const sanitize of listConnectedServiceRetainedMaterializedHomeSanitizers()) {
          await sanitize(homeRootDir);
        }
      },
    });
    void connectedServiceMaterializedHomeCleanupScheduler.reconcile().catch((error) => {
      logger.debug('[DAEMON RUN] Connected-service materialized home startup reconciliation failed (non-fatal)', error);
    });
    connectedServiceMaterializedHomeCleanupInterval = setInterval(() => {
      void connectedServiceMaterializedHomeCleanupScheduler.cleanupPendingMaterializedHomes().catch((error) => {
        logger.debug('[DAEMON RUN] Connected-service materialized home periodic cleanup failed (non-fatal)', error);
      });
    }, resolvePositiveIntEnv(
      process.env.HAPPIER_CONNECTED_SERVICES_MATERIALIZED_HOME_CLEANUP_INTERVAL_MS,
      60 * 60_000,
      { min: 60_000, max: 24 * 60 * 60_000 },
    ));
    connectedServiceMaterializedHomeCleanupInterval.unref?.();

    let onTrackedSessionPidPromoted:
      NonNullable<
        Parameters<
          typeof createOnHappySessionWebhook
        >[0]['onPidPromoted']
      >
      | null = null;
    const onHappySessionWebhook = createOnHappySessionWebhook({
      pidToTrackedSession,
      pidToAwaiter,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      deviceLocalSecretStorage,
      registerAcceptedWorkspace: createAcceptedSessionWorkspaceRegistration({
        credentials,
        serverId: configuration.activeServerId,
        machineId,
        signal: homeTransportCancellation.signal,
        requesterSessionCustody: {
          resolve: async sessionId => {
            const context = await resolveRequesterSessionRuntimeContext(sessionId);
            if (!context) return null;
            return { ...context.bootstrap, isCurrent: context.isCurrent,
              release: () => releaseRequesterSessionRuntimeContext(context) };
          },
        },
      }),
      onTrackedSessionReady: async (tracked) => {
        const sessionId = typeof tracked.happySessionId === 'string' ? tracked.happySessionId.trim() : '';
        if (!sessionId) return;
        connectedServiceQuotasCoordinator?.updateSpawnTargetSessionId({
          pid: tracked.pid,
          sessionId,
        });
        daemonGuard?.runtime.invalidate();
      },
      onPidPromoted: (input) => {
        if (!onTrackedSessionPidPromoted) {
          throw new Error(
            'Daemon session PID-promotion owner is unavailable',
          );
        }
        onTrackedSessionPidPromoted(input);
      },
    });
    // A successor that connects to this daemon's server takes over its machine socket; until the
    // server moves it, the incumbent keeps serving (requestDaemonSelfRestart owns the handover).
    const withMachineConnectionHandover = (successorServerUrl?: string) => resolveMachineConnectionHandover({
      ...(successorServerUrl ? { successorServerUrl } : {}),
      configuredServerUrl: configuration.apiServerUrl,
      getMachineClient: () => apiMachineForSessions,
    });
    const requestControlServerSelfRestart = async (
      {
        successorDistClosureFingerprint,
        successorServerUrls,
        onReplacementConfirmed,
    }: {
      successorDistClosureFingerprint?: string;
        successorServerUrls?: Readonly<{ serverUrl: string; webappUrl: string }>;
      onReplacementConfirmed?: () => Promise<void>;
    } = {},
    ): Promise<void> => {
      const restartVerifyTimeoutMs = readDaemonRestartVerifyTimeoutMs();
      const result = await requestDaemonSelfRestartWithLockHandoff({
        getCurrentDaemonLockHandle: () => daemonLockHandle,
        setCurrentDaemonLockHandle: (lockHandle) => {
          daemonLockHandle = lockHandle;
        },
        quiesceBeforeLockRelease: quiescePluginChangesForLockHandoff,
        releaseDaemonLock,
        acquireDaemonLock: () => acquireDaemonLock(5, 200),
        requestShutdown,
        selfRestartParams: {
          runtimeId,
          expectedCliVersion: '',
          ownPid: process.pid,
          timeoutMs: restartVerifyTimeoutMs,
          deadlineAtMs: Date.now() + restartVerifyTimeoutMs,
          pollMs: readDaemonRestartVerifyPollMs(),
          postConfirmationOverlapMs: resolvePositiveIntEnv(
            process.env.HAPPIER_DAEMON_RESTART_OVERLAP_EXIT_GRACE_MS,
            1_000,
            { min: 0, max: 5_000 },
          ),
          ...(onReplacementConfirmed ? { onReplacementConfirmed } : {}),
          ...withMachineConnectionHandover(successorServerUrls?.serverUrl),
          takeover: true,
          env: resolveDaemonSelfRestartEnvironment(
            successorDistClosureFingerprint,
            successorServerUrls,
          ),
        },
      });
      if (result.status !== 'exited') {
        throw new Error(`Daemon self-restart did not exit current process (${result.status})`);
      }
    };
    const connectedAccountPersistence =
      createQualifiedConnectedAccountDaemonPersistence({
        credentials,
        getAccountEncryptionMode: async options => await api.getAccountEncryptionMode(options),
        resolveServerFeaturesSnapshot: () =>
          serverFeaturesSnapshotStore.getSnapshot(),
        resolveSessionSyncPendingInputServerContractResult: () =>
          apiMachineForSessions
            ?.getSessionSyncPendingInputServerContractResult()
            ?? null,
        secrets: createActiveAccountSettingsConnectedAccountSecrets({
          secretSources: daemonSecretSources,
          expectedScopeKey: resolveAccountSettingsScopeKey(credentials),
        }),
        onAccountSettled: async (settled) => {
          const coordinator = connectedServiceQuotasCoordinator;
          if (!coordinator) throw new Error('Qualified quota source initializer is unavailable');
          await coordinator.initializeQualifiedAccountQuotaSource(settled);
        },
        // Attempt durability is Account-mode aware, so a plaintext Account keeps the
        // same OAuth/device restart recovery as an E2EE one. Key presence never
        // decides installation.
        attemptTransactions:
          createQualifiedConnectedAccountAttemptTransactionAdapters({
            credentials,
            getMachineId: () => machineId,
            getAccountEncryptionMode: async options =>
              await api.getAccountEncryptionMode(options),
          }),
      });
    const connectedAccountConfigurationOwner =
      createConnectedAccountDaemonConfigurationOwner({
        reloadController: pluginReloadController,
        persistence: connectedAccountPersistence.configuration,
      });
    const establishedConnectedAccountRuntimeOwner =
      createQualifiedConnectedAccountEstablishedRuntimeOwner({
        reloadController: pluginReloadController,
        credentials,
        getAccountEncryptionMode: (signal, options) => api.getAccountEncryptionMode({ ...options, signal }),
        configuration: connectedAccountPersistence.configuration,
        configurationOwner: connectedAccountConfigurationOwner,
      });
    const teamCredentialDirectMaterialClient = createHttpTeamCredentialDirectMaterialClient({
      token: credentials.token,
      serverUrl: resolveServerHttpBaseUrl(),
      async readRecipientEncryptionMaterial(signal) {
        const mode = await api.getAccountEncryptionMode({ signal });
        if (mode === 'plain') return { mode: 'plain' };
        if (mode !== 'e2ee' || !credentials.encryption) {
          return { mode: 'e2ee_unavailable' };
        }
        return {
          mode: 'e2ee',
          secretKeyOrSeed: credentials.encryption.type === 'dataKey'
            ? credentials.encryption.machineKey
            : credentials.encryption.secret,
        };
      },
    });
    const connectedAccountPurposeBindingRuntime = createDaemonConnectedAccountPurposeBindingRuntime({
      credentialOwnerAccountId: readAccountIdFromToken(credentials.token) ?? undefined,
      coordinatorInventoryIsObserved: () => apiMachine?.hasCurrentAccountChangesObserver() === true,
      workerMachineId: machineId,
      establishedRuntimeOwner: establishedConnectedAccountRuntimeOwner,
      openTeamDirect: teamCredentialDirectMaterialClient.open,
      resolveQualifiedConnectedAccountV4Support: () =>
        resolveQualifiedConnectedAccountAtomicV4Negotiation(
          serverFeaturesSnapshotStore.getSnapshot(),
        ),
      resolveConnectedAccountEndpoints: async ({ account, signal }) =>
        await establishedConnectedAccountRuntimeOwner.readConfiguredEndpoints({
          account,
          signal,
        }),
      qualifiedApi: {
        async listAccounts(service, signal) {
          signal.throwIfAborted();
          const result = await listQualifiedConnectedAccountsV4({
            token: credentials.token,
            service,
            signal,
          });
          signal.throwIfAborted();
          return result;
        },
        async listGroups(service, signal) {
          signal.throwIfAborted();
          const result = await listQualifiedConnectedAccountGroupsV4({
            token: credentials.token,
            service,
            signal,
          });
          signal.throwIfAborted();
          return result;
        },
        async readGroup(group, signal) {
          signal.throwIfAborted();
          const result = await readQualifiedConnectedAccountGroupV4({
            token: credentials.token,
            group,
            signal,
          });
          signal.throwIfAborted();
          return result;
        },
      },
      reloadController: pluginReloadController,
    });
    const connectedAccountRequestAuthRegistry =
      createConnectedAccountRequestAuthSubjectRegistry();
    let connectedAccountRequestAuthHttpPort: number | null = null;
    let managedServiceEndpointReadHost:
      AgentExternalSessionsManagedEndpointReadHost | null = null;
    let managedServiceSessionBaseUrlResolver:
      ManagedServiceSessionBaseUrlResolver | null = null;
    let managedServiceSessionClientAccessResolver:
      ManagedServiceSessionClientAccessResolver | null = null;
    const managedProviderOperationAuthority =
      createManagedProviderOperationAuthority({
        materializationBaseDir: join(
          configuration.happyHomeDir,
          'providers',
          'managed-operation-auth',
        ),
        purposeBindingOwner: {
          activatePurposeBindings:
            connectedAccountPurposeBindingRuntime.activatePurposeBindings,
          readCredentialConfigurationRevision:
            connectedAccountPurposeBindingRuntime.readCredentialConfigurationRevision,
        },
        listActionFormConnectedAccountOptions:
          connectedAccountPurposeBindingRuntime.listActionFormConnectedAccountOptions,
        requestAuthRegistry: connectedAccountRequestAuthRegistry,
        resolveRequestAuthHttpPort() {
          if (connectedAccountRequestAuthHttpPort === null) {
            throw new Error(
              'connected_account_request_auth_http_port_unavailable',
            );
          }
          return connectedAccountRequestAuthHttpPort;
        },
        createRedactionLease: () =>
          createProviderRedactionLease({ values: [] }),
      });
    if (!daemonLockHandle) {
      throw new Error('Plugin runtime startup requires exclusive daemon ownership');
    }
    const reportOptionalCapabilityUnavailable = (result: Extract<DaemonOptionalCapabilityResult, { status: 'unavailable' }>) => {
      if (homeTransportCancellation.signal.aborted) return;
      logger.warn('[DAEMON RUN] Optional capability unavailable', {
        status: result.status,
        capability: result.capability,
        error: serializeAxiosErrorForLog(result.error),
      });
    };
    const accountCatalogWarmup = warmDaemonAccountCatalogs({
      credentials,
      logger,
      signal: homeTransportCancellation.signal,
    });
    const accountCatalogReadiness = settleDaemonOptionalCapability(
      'account_catalogs', accountCatalogWarmup, reportOptionalCapabilityUnavailable,
    );
    releaseAcpCatalogHydrationObserver = installDaemonAcpCatalogHydrationObserver({ credentials,
      onReady: async input => {
        try {
          const accountId = readAccountIdFromToken(credentials.token);
          if (!accountId) return;
          await sweepRemovedAgentInstalls({ ...input, accountId, env: process.env,
            isDefinitionInUse: definitionId => isAgentInstallTargetInUse({ agentId: 'custom-acp', definitionId }, pidToTrackedSession.values()) });
        } catch (error) {
          if (!input.signal?.aborted) logger.warn('[DAEMON RUN] Removed ACP install cleanup failed', error);
        }
      } });
    const externalSessionHostOperationOwner =
      createExternalSessionHostOperationOwner();
    if (!homeTarget.homeServerIdentityId && !serverFeaturesSnapshotStore.getSnapshot()) {
      // URL-only predecessor profiles join the existing startup discovery.
      await refreshServerFeaturesSnapshot();
    }
    const resolveBoundHomeServerIdentityId = () => {
      if (homeTransportCancellation.signal.aborted) return null;
      // Home transport authenticates the binding at startup/reconnect.
      // Origin stamps carry that identity; each real use still admits it.
      if (homeTarget.homeServerIdentityId) return homeTarget.homeServerIdentityId;
      const snapshot = serverFeaturesSnapshotStore.getSnapshot();
      return snapshot?.status === 'ready'
        ? snapshot.features.capabilities.serverIdentity.serverIdentityId ?? null
        : null;
    };
    const resolveCurrentMachineExecutionOriginContext =
      createCurrentMachineExecutionOriginContextResolver({
        serverUrl: resolveServerHttpBaseUrl(),
        resolveCurrentMachineId: () => machineId,
        resolveCurrentServerIdentityId: resolveBoundHomeServerIdentityId,
      });
    const managedPolicyServerHttpBaseUrl = resolveServerHttpBaseUrl();
    const pluginRemovalOrigin = await resolveCurrentMachineExecutionOriginContext();
    const managedPolicyHomeId = pluginRemovalOrigin?.serverIdentityId ?? null;
    const { installation: pluginRemovalInstallation, managedResourcePreflight } = await prepareDaemonPluginRemoval({
      credentials, machineId, origin: pluginRemovalOrigin, readServerUrl: () => managedPolicyServerHttpBaseUrl,
      signal: homeTransportCancellation.signal,
    });
    const readCurrentManagedPolicyController = () => {
      const installation = readInstallationIdentityIfExistsSync();
      if (!managedPolicyHomeId || !installation || !externalActionAccountId) return null;
      return { homeId: managedPolicyHomeId, controller: { machineId, installationId: installation.installationId },
        custodianAccountId: externalActionAccountId, privateKey: installation.privateKey,
        token: credentials.token, serverUrl: managedPolicyServerHttpBaseUrl };
    };
    const readCurrentManagedMachinePolicies = async (signal?: AbortSignal) => {
      const origin = await resolveCurrentMachineExecutionOriginContext(signal);
      const controller = readCurrentManagedPolicyController();
      if (!controller || !origin || origin.serverIdentityId !== controller.homeId || origin.machineId !== controller.controller.machineId) {
        throw Object.assign(new Error('controller_unavailable'), { code: 'controller_unavailable' });
      }
      return await readManagedMachinePolicyCensus({ ...controller, signal });
    };
    const browserRuntimeActionExecute = api.createBrowserRuntimeActionExecutor({
      observeExecution: request => apiMachineForSessions
        ? apiMachineForSessions.observeActionExecution(request)
        : Promise.resolve({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }),
    });
    confidentialSecretFill = api.createConfidentialSecretFillExecutor({ secretSources: daemonSecretSources,
      machineId: () => machineId, readHostIdentity: resolveCurrentMachineExecutionOriginContext });
    confidentialActionInputs = api.createConfidentialActionInputsExecutor({ secretSources: daemonSecretSources,
      machineId: () => machineId, readHostIdentity: resolveCurrentMachineExecutionOriginContext });
    const pluginRegistrySourceHome = resolveServerHttpBaseUrl();
    const pluginRegistrySourceHost = createCliRegistryHostV1({ credentials, secretSources: daemonSecretSources });
    const requesterRuntimeServerId = configuration.activeServerId;
    const isolationWorkspaceScope = `${requesterRuntimeServerId}:${resolveAccountSettingsScopeKey(credentials)}`;
const readIsolationRoots = () => {
      const workspaces = getActiveProjectAccountRowsSnapshot();
      if (configuration.activeServerId !== requesterRuntimeServerId) return null;
      return readMachineProjectWorkspaceRefs(workspaces, { scopeKey: isolationWorkspaceScope,
        serverId: requesterRuntimeServerId, homeServerIdentityId: resolveBoundHomeServerIdentityId(), machineId })
        ?.map(ref => ({ rootId: ref.id, path: ref.rootPath })) ?? null;
    };

    const isolationEffects = createDaemonAgentIsolationEffects({ getMachineClient: () => apiMachineForSessions,
      adminAccess: machineAdminAccessRoutes, readRoots: readIsolationRoots,
      trackedSessions: pidToTrackedSession,
      protectedRoots: [configuration.happyHomeDir, '/opt/happier', '/var/lib/happier-agent'],
      privateRoots: [configuration.happyHomeDir],
      readMemberBindingScope: () => {
        const target = machineAdminAccessRoutes.target();
        const homeServerIdentityId = resolveBoundHomeServerIdentityId();
        return target && homeServerIdentityId ? { activeServerDir: configuration.activeServerDir,
          homeServerIdentityId, machineId: target.machineId, installationId: target.installationId } : null;
      },
    });
    machineRpcRouteAttachments.attachMachineAgentIsolationRoutes(isolationEffects);
const agentIsolation: import('./agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext = {
      managedHappierBinaryPath: isolationEffects.installedCli,
      async readMember(input) {
        const machine = apiMachineForSessions;
        if (!machine) throw new Error('agent_isolation_unavailable');
        return machine.readAgentIsolationMember(input);
      },
      async prepareMember(input) {
        const machine = apiMachineForSessions;
        if (!machine) throw new Error('agent_isolation_unavailable');
        return machine.prepareAgentIsolationMember(input);
      },


      read() {
        const snapshot = apiMachineForSessions?.getAgentIsolationSnapshot()
          ?? { enabled: true, status: { kind: 'unavailable' as const, code: 'metadata_unavailable' as const } };
        const workspaceRoots = (readIsolationRoots() ?? []).map(root => root.path);
        return { ...snapshot, workspaceRoots, daemonObservation: machineAdminAccessRoutes.observer.read() };
      },
    };

const pluginRuntimeOwner = createDaemonPluginRuntimeOwner({


      signal: homeTransportCancellation.signal,
      publishDevelopmentReview: createDaemonPluginDevelopmentReviewApprovalPublisher({
        credentials,
        happyHomeDir: configuration.happyHomeDir,
        resolveCurrentMachineExecutionOriginContext,
      }),
      readSpawnFailureLimits: () => machineVitals?.latest()?.limits,
      happyHomeDir: configuration.happyHomeDir,
      readRegistrySources: () => runWithServerHttpBaseUrl(pluginRegistrySourceHome, () => pluginRegistrySourceHost.readSources()),
      ...(managedResourcePreflight ? { managedResourcePreflight } : {}),
      daemonDatabaseLimits: DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY,
      resolveCurrentMachineId: () => machineId,
      readDaemonRequesterWorkAttribution: () => {
        const target = machineResourceTarget();
        return target ? { serverId: target.serverId, accountId: target.custodianAccountId,
          machineId: target.machineId, installationId: target.installationId } : null;
      },
      machineAdmissionTransport,
      executeClientAction: createClientActionMachineRpcExecutor(() => apiMachineForSessions),
      resolveComposerMediaStageTransferRpcHandler: createDaemonPluginTransferRpcResolver(() => apiMachineForSessions),
      resolveCurrentMachineExecutionOriginContext,
      resolveSessionResourceAccess: async (input) => {
        const currentApiMachine = apiMachineForSessions;
        if (!currentApiMachine) {
          throw new Error('plugin_resource_session_access_unavailable');
        }
        return await currentApiMachine.resolvePluginResourceSessionAccess(input);
      },
      // Account Collection client preflight and plugin-facing feature decisions are
      // both advisory reads of this existing daemon-owned snapshot. Supplying it once
      // here keeps a single cache/currentness path; the resolved runtime fans it out.
      resolveServerFeaturesSnapshot: () => serverFeaturesSnapshotStore.getSnapshot(),
      staleCandidateCleanup: 'exclusiveHome',
      reloadController: pluginReloadController,
      availabilityReporter: createDaemonPluginAvailabilityReporter({
        credentials,
        serverFeaturesSnapshotStore,
        getMachineId: () => machineId,
        signal: homeTransportCancellation.signal,
      }),
      connectedAccounts: connectedAccountPurposeBindingRuntime.owner,
      actionFormConnectedAccounts: Object.freeze({
        resolveBindingIntent:
          connectedAccountPurposeBindingRuntime.resolveBindingIntent,
        activatePurposeBindings:
          connectedAccountPurposeBindingRuntime.activatePurposeBindings,
      }),
      providers: providerOperationsSource,
      // Declaration discovery can overlap warmup; executable plugins still
      // observe the established Account policy, catalog and lifetime.
      awaitAccountSettingsReadiness: () => accountCatalogWarmup,
      onInitialRegistryPublished: resolveInitialPluginRegistryPublished,
      awaitInitialRuntimeActivation: async () => {
        await Promise.race([
          machineProviderBindingSettled,
          resolvesWhenShutdownRequested.then(() => undefined),
        ]);
      },
      onDurableRegistryApplied: () => {
        pluginRegistryProjectionInvalidation.invalidateProjection();
        reconcileTeamCredentialDirectMaterialAfterSourceChange('registry-applied');
      },
      onRuntimeProjectionInvalidated: () => {
        pluginRegistryProjectionInvalidation.invalidateProjection();
        reconcileTeamCredentialDirectMaterialAfterSourceChange('registry-invalidated');
      },
      managedProviderOperationAuthority,
      qualifiedConnectedAccountEstablishedRuntimeOwner:
        establishedConnectedAccountRuntimeOwner,
      reconcileConnectedAccountPurposePublication:
        connectedAccountPurposeBindingRuntime.reconcileRegistryPublication,
      runtimeActionExecute: browserRuntimeActionExecute,
      managedEndpointRead: async (input) => {
        const host = managedServiceEndpointReadHost;
        if (!host) {
          throw new Error(
            'Managed server endpoint read owner is unavailable',
          );
        }
        return await host(input);
      },
      resolveManagedServiceSessionBaseUrl: async (input) => {
        const resolver = managedServiceSessionBaseUrlResolver;
        if (!resolver) {
          throw new Error('Managed server Session endpoint owner is unavailable');
        }
        return await resolver(input);
      },
      resolveManagedServiceSessionClientAccess: async (input) => {
        const resolver = managedServiceSessionClientAccessResolver;
        if (!resolver) {
          throw new Error('Managed server Session client access owner is unavailable');
        }
        return await resolver(input);
      },
      externalSessionPluginAdmissionOwner: pluginAdmissionOwner,
      resolveExternalSessionCurrentMachineId: () => machineId,
      externalSessionHostOperationOwner,
      externalSessionsActiveServerDir: configuration.activeServerDir,
      externalSessionsActiveServerId: configuration.activeServerId,
      ...(pluginRecoveryRequested ? { startupMode: 'pluginRecovery' as const } : {}),
    });
    pluginChangeService = pluginRuntimeOwner.changeService;
    const pluginRuntimeInitialization = settleDaemonOptionalCapability(
      'plugin_runtime', pluginRuntimeOwner.initialize(), reportOptionalCapabilityUnavailable,
    );
    await accountCatalogReadiness;
    const registryUpdateCheck = createCliRegistryUpdateCheck({ credentials, secretSources: daemonSecretSources, signal: homeTransportCancellation.signal });
    const checkRegistryUpdates = () => startBackgroundRegistryUpdateCheck(registryUpdateCheck);
    void checkRegistryUpdates()
      .catch(error => { if (!homeTransportCancellation.signal.aborted) logger.warn('[DAEMON RUN] Registry update check failed', error); });
    await Promise.race([
      initialPluginRegistryPublished,
      pluginRuntimeInitialization,
    ]);
    // Publish the restart fence before any spawn admission can reuse a stale
    // process. Physical retirement waits for machine mutation custody below.
    await reconcileAgentRuntimeRestartDisposition({
      trackedSessions: pidToTrackedSession.values(),
      isShuttingDown: isDaemonQuiescing,
      deferRunnerAuthorityReattach: true,
    });
    const connectedAccountDaemonRuntime = createConnectedAccountDaemonRuntime({
      reloadController: pluginReloadController,
      persistence: connectedAccountPersistence,
      configurationOwner: connectedAccountConfigurationOwner,
      resolvePeerOperationTransport: ({ service, operation }) =>
        resolveQualifiedConnectedAccountPeerOperationTransport({
          snapshot: serverFeaturesSnapshotStore.getSnapshot(),
          serverContract:
            apiMachineForSessions
              ?.getSessionSyncPendingInputServerContractResult()
              ?? null,
          service,
          operation,
        }),
      configurationConsequences: {
        async assertAvailable() {
          if (!connectedServiceRefreshCoordinator) {
            throw Object.assign(
              new Error(
                'Connected-account configuration consequence coordinator is unavailable',
              ),
              {
                code:
                  'connected_account_configuration_consequence_unavailable',
              },
            );
          }
        },
        async apply(input) {
          const coordinator = connectedServiceRefreshCoordinator;
          if (!coordinator) {
            throw Object.assign(
              new Error(
                'Connected-account configuration consequence coordinator became unavailable',
              ),
              {
                code:
                  'connected_account_configuration_consequence_unavailable',
              },
            );
          }
          await coordinator
            .applyQualifiedConnectedAccountConfigurationConsequence(input);
        },
      },
      revocation: {
        token: credentials.token,
        establishedRuntimeOwner: establishedConnectedAccountRuntimeOwner,
        legacyCredentialApi: api,
        resolveV4Support: () =>
          resolveQualifiedConnectedAccountAtomicV4Negotiation(
            serverFeaturesSnapshotStore.getSnapshot(),
          ),
        resolveRemovalReviewSupport: () =>
          resolveQualifiedConnectedAccountRemovalReviewNegotiation(
            serverFeaturesSnapshotStore.getSnapshot(),
          ),
      },
    });
    const daemonAccountServerActions = externalActionAccountId
      ? createAccountServerActionDeps({
        token: credentials.token,
        credentials,
        serverId: configuration.activeServerId,
        serverHttpBaseUrl: resolveServerHttpBaseUrl(),
        resolveServerFeaturesSnapshot: () => serverFeaturesSnapshotStore.getSnapshot(),
      })
      : undefined;
    const homeDomainAction = daemonAccountServerActions?.homeDomainAction;
    if (externalActionAccountId && homeDomainAction) {
        const reconciler = createDaemonTeamCredentialDirectMaterialReconciler({
          token: credentials.token,
          accountId: externalActionAccountId,
          signal: homeTransportCancellation.signal,
          homeDomainAction,
          isAccountChangesObserverCurrent: () => apiMachine?.hasCurrentAccountChangesObserver() === true,
          establishedRuntimeOwner: establishedConnectedAccountRuntimeOwner,
          async listAccounts(service, signal) {
            return await listQualifiedConnectedAccountsV4({ token: credentials.token, service, signal });
          },
          async readGroup(source, signal) {
            return await readQualifiedConnectedAccountGroupV4({
              token: credentials.token,
              group: source.target,
              signal,
            });
          },
          async resolveProviderSource(source, signal) {
            const catalog = await prepareProviderConnectionsCatalogForCli({ expectedScopeKey: resolveAccountSettingsScopeKey(credentials), signal });
            if (catalog.status !== 'ready') return null;
            const accountSnapshot = getActiveAccountSettingsSnapshot();
            if (!accountSnapshot) return null;
            const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
              happyHomeDir: configuration.happyHomeDir,
              controller: pluginReloadController,
            });
            try {
              const registry = resolveProviderContributionRegistryView(
                lease.registry.contributes,
                lease.durableRevision,
                lease.registry.readPluginOccurrenceId,
              );
              const dnsEvidenceByEndpointUrl = await collectProviderConnectionDnsEvidence({
                connectionId: source.connectionId,
                machineId,
                providerSettings: readProviderSettingsForCli(accountSnapshot).settings,
                registry,
                lifetime: createProviderOperationLifetime({
                  signal,
                  wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
                }),
              });
              const resolved = await resolveAdmittedProviderConnectionDirectSourceSnapshot({
                source,
                machineId,
                expectedScopeKey: resolveAccountSettingsScopeKey(credentials),
                registry,
                dnsEvidenceByEndpointUrl,
                getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
                signal,
              });
              if (!resolved.ok) return null;
              const credential = await materializeProviderConnectionDirectCredential({
                expected: resolved.snapshot,
                registry,
                dnsEvidenceByEndpointUrl,
                getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
              });
              if (!credential.ok) return null;
              return createProviderConnectionTeamCredentialSourceSnapshot({
                sourceAccountId: externalActionAccountId,
                expected: resolved.snapshot,
                resolvedCredential: credential.credential,
                isPersistedSourceCurrent: () => true,
                async isProviderSourceCurrent(expected) {
                  const currentSnapshot = getActiveAccountSettingsSnapshot();
                  if (!currentSnapshot) return false;
                  const currentLease = await acquireAuthoritativePluginRuntimeRegistryLease({
                    happyHomeDir: configuration.happyHomeDir,
                    controller: pluginReloadController,
                  });
                  try {
                    const currentRegistry = resolveProviderContributionRegistryView(
                      currentLease.registry.contributes,
                      currentLease.durableRevision,
                      currentLease.registry.readPluginOccurrenceId,
                    );
                    const currentDnsEvidence = await collectProviderConnectionDnsEvidence({
                      connectionId: source.connectionId,
                      machineId,
                      providerSettings: readProviderSettingsForCli(currentSnapshot).settings,
                      registry: currentRegistry,
                      lifetime: createProviderOperationLifetime({
                        signal,
                        wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
                      }),
                    });
                    return isProviderConnectionDirectSourceCurrent({
                      expected,
                      registry: currentRegistry,
                      dnsEvidenceByEndpointUrl: currentDnsEvidence,
                      getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
                    });
                  } finally {
                    await currentLease.release();
                  }
                },
              });
            } finally {
              await lease.release();
            }
          },
        });
        const reconcileIfEnabled = async (
          wakeReason?: TeamCredentialDirectMaterialWakeReason,
          sourceWake?: TeamCredentialDirectMaterialSourceWake,
        ) => {
          const snapshot = serverFeaturesSnapshotStore.getSnapshot();
          if (
            snapshot?.status !== 'ready'
            || readServerEnabledBit(snapshot.features, 'teams.credentialResources') !== true
          ) return { prepared: 0, remaining: 0, failures: [] };
          return await reconciler.reconcile(wakeReason, sourceWake);
        };
        const reconcileDirectMaterialBestEffort = (wakeReason: TeamCredentialDirectMaterialWakeReason, sourceWake?: TeamCredentialDirectMaterialSourceWake) => void reconcileIfEnabled(wakeReason, sourceWake).catch((error) => logger.debug(
            '[DAEMON RUN] Team credential direct-material reconciliation failed (non-fatal)',
            { error: serializeAxiosErrorForLog(error) },
          ));
        reconcileTeamCredentialDirectMaterialAfterSourceChange = reconcileDirectMaterialBestEffort;
        // Direct preparation consumes Provider settings, Saved Secrets and the
        // Account lifetime from the snapshot, which publishes only on change;
        // Team grant, recipient and connected-service facts arrive through the
        // AccountChange wake attached with the machine client below.
        teamCredentialDirectMaterialChangeCleanup = subscribeTeamCredentialDirectMaterialSourceChanges(
          (_previous, _next, wake) => reconcileDirectMaterialBestEffort('source-snapshot', wake),
        );
        reconcileDirectMaterialBestEffort('startup');
    }
    machineRpcRouteAttachments.attachConnectedAccountDaemonRuntime(
      connectedAccountDaemonRuntime,
    );
    machineRpcRouteAttachments.attachConnectedAccountPurposeBindingRuntime(
      connectedAccountPurposeBindingRuntime,
    );
    const openTeamCredentialProviderBinding: NonNullable<
      Parameters<typeof startDaemonSessionControlRuntime>[0]['openTeamCredentialProviderBinding']
    > | undefined = homeDomainAction && externalActionAccountId
      ? async (input) => {
          const workerMachineId = machineId;
          return await openDaemonSessionTeamCredentialProviderBinding(input, {
            machineId: workerMachineId,
            accountId: externalActionAccountId,
            serverId: requesterRuntimeServerId,
            serverHttpBaseUrl: readRequesterRuntimeServerHttpBaseUrl(),
            credentials,
            happyHomeDir: configuration.happyHomeDir,
            controller: pluginReloadController,
            runtime: machineIrohRuntime,
            resolveTrustRoots: resolvePeerMediationTrustRoots,
            openVendorNative: createDaemonSessionTeamCredentialNativeOpen({
              machineId: workerMachineId, accountId: externalActionAccountId, credentials,
              providerSettingsOperationContext: input.providerSettingsOperationContext,
              serverHttpBaseUrl: readRequesterRuntimeServerHttpBaseUrl(),
              installationIdentity: readInstallationIdentityIfExistsSync(),
              resolveCurrentMachineExecutionOriginContext: async signal =>
                isDaemonQuiescing() || homeTransportCancellation.signal.aborted ? null
                  : await resolveCurrentMachineExecutionOriginContext(signal),
            }),
            openTeamDirect: createDaemonTeamCredentialDirectMaterialOpen({
                clientOpen: teamCredentialDirectMaterialClient.open,
                workerMachineId,
                signal: input.signal,
              }),
          });
        }
      : undefined;
    let createRequesterRuntime: ((bootstrap: AdmittedRequesterSessionBootstrap, signal?: AbortSignal,
      options?: Readonly<{ bootstrapOwnership?: 'borrowed' }>) => Promise<RequesterSessionRuntimeContext | null>) | null = null;
    const readRequesterRuntimeServerHttpBaseUrl = captureServerHttpBaseUrl();
    const openRunAccountConnectionSource = managedPolicyHomeId && externalActionAccountId
      ? createDaemonAccountConnectionManagedConsumerOpen({
          homeId: managedPolicyHomeId, accountId: externalActionAccountId, machineId: () => machineId,
          isHomeCurrent: () => !isDaemonQuiescing() && configuration.activeServerId === requesterRuntimeServerId,
          custody: targetMachineId => createManagedProviderExplicitStartCustody({ machineId: targetMachineId,
            happyHomeDir: configuration.happyHomeDir, controller: pluginReloadController }),
          withRegistry: async read => {
            const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
              happyHomeDir: configuration.happyHomeDir, controller: pluginReloadController,
            });
            try { return await read(resolveProviderContributionRegistryView(lease.registry.contributes,
              lease.durableRevision, lease.registry.readPluginOccurrenceId)); }
            finally { await lease.release(); }
          },
          projectModelsForAccount: async (request, context) => {
            const producer = providerOperationsProducer;
            if (!producer) throw new Error('provider_source_projection_unavailable');
            return await producer.machineServices.projectModelsForAccount(request, context);
          },
          openRemote: async (request, isCurrent) => {
            const runtime = machineIrohRuntime;
            if (!runtime) {
              reportAccountConnectionProviderBrokerOpenFailure({ reason: 'native_runtime_absent' });
              return null;
            }
            return await openAccountConnectionProviderBrokerAccess({
              ...request,
              homeId: managedPolicyHomeId, accountId: externalActionAccountId, initiatorMachineId: machineId,
              openBroker: async (request, signal) => await api.openAccountConnectionProviderBroker(request, { signal }),
              admitConsumer: async (authority, signal) => {
                if (!await isCurrent(signal)) return { ok: false, reasonCode: 'operation_not_current' };
                const admitted = await api.admitAccountConnectionProviderBroker({ v: 2, authority }, { signal });
                if (!admitted.ok) return admitted;
                return await isCurrent(signal) ? admitted : { ok: false, reasonCode: 'operation_not_current' };
              },
              openTunnel: createProviderBrokerMachineCarrierTunnelOpen({
                homeId: managedPolicyHomeId, accountId: externalActionAccountId, localMachineId: machineId,
                runtime, resolveTrustRoots: resolvePeerMediationTrustRoots,
              }),
            });
          },
        })
      : undefined;
    const requesterMachineAdmissionBoundary = (attribution?: AdmittedRequesterSessionBootstrap['attribution']) => ({
      machineId, daemonToken: credentials.token, readInstallation: readInstallationIdentityIfExistsSync,
      signal: homeTransportCancellation.signal,
      isHomeCurrent: () => configuration.activeServerId === requesterRuntimeServerId
        && (!attribution || attribution.serverId === requesterRuntimeServerId && attribution.machineId === machineId),
    });
    const releaseRequesterSessionRuntimeContext = async (context: RequesterSessionRuntimeContext): Promise<void> => {
      await releaseUnretainedRequesterSessionRuntimeContext(context,
        [...pidToTrackedSession.values()].map(tracked => tracked.requesterSessionRuntimeContext));
    };
    const resolveRequesterSessionRuntimeContext = createRequesterSessionRuntimeContextResolver({
      trackedSessions: pidToTrackedSession,
      getCreateRuntime: () => createRequesterRuntime,
      recoverBootstrap: ({ sessionId, attribution: stamp, tracked, signal, onSessionReadRefused }) => resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: configuration.happyHomeDir,
        serverId: requesterRuntimeServerId, sessionId, serverHttpBaseUrl: readRequesterRuntimeServerHttpBaseUrl(),
        signal,
        onSessionReadRefused,
        machineAdmissionBoundary: requesterMachineAdmissionBoundary(),
        ...(stamp ? { expectedAttribution: stamp } : {}),
        // Retained attribution is not proof that a legacy Session has a
        // private file. Its actual owner is still verified by the custody owner.
        ...(tracked || stamp?.accountId === externalActionAccountId ? { legacyOwnerCredentials: credentials } : {}) }),
    });
    publishSessionPluginCatalogInvalidation = revision => {
      const projection = { runtimeId, contributionRegistryProjectionRevision: revision };
      for (const tracked of pidToTrackedSession.values()) {
        if (!tracked.happySessionId) continue;
        void (async () => {
          const requester = await resolveRequesterSessionRuntimeContext(tracked.happySessionId!, tracked.requesterWorkAttributionV1);
          try {
            const result = await withTrackedSessionRpc({
              tracked, credentials, custodianAccountId: externalActionAccountId,
              serverId: requesterRuntimeServerId, machineId,
              serverHttpBaseUrl: readRequesterRuntimeServerHttpBaseUrl(),
              ...(requester ? { requesterBootstrap: requester.bootstrap } : {}),
              isTrackedCurrent: () => !admissionDrain.isPublicationQuiescing()
                && pidToTrackedSession.get(tracked.pid) === tracked,
            }, callRpc => callRpc(SESSION_RPC_METHODS.SESSION_PLUGIN_CATALOG_INVALIDATE_V1, projection));
            if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
              logger.debug('[DAEMON RUN] Session plugin catalog hint unavailable', { sessionId: tracked.happySessionId });
            }
          } finally {
            if (requester) await releaseRequesterSessionRuntimeContext(requester);
          }
        })().catch(error => logger.debug('[DAEMON RUN] Session plugin catalog hint failed', {
          sessionId: tracked.happySessionId, error: error instanceof Error ? error.message : String(error),
        }));
      }
    };
    const ownedConnectedServiceRuntimeRegistry = connectedServiceRuntimeRegistry.scopeToRequester(target => {
      const tracked = pidToTrackedSession.get(target.pid)
        ?? [...pidToTrackedSession.values()].find(candidate => candidate.happySessionId === target.sessionId);
      const stamp = target.requesterWorkAttributionV1 ?? tracked?.requesterWorkAttributionV1 ?? tracked?.spawnOptions?.requesterWorkAttributionV1;
      return !stamp || stamp.serverId === configuration.activeServerId && stamp.accountId === externalActionAccountId;
    }, externalActionAccountId ? { serverId: requesterRuntimeServerId, accountId: externalActionAccountId } : undefined);
    const {
      processOwnershipRuntime,
      processActionLifecycle,
      processActionOwnerAdapters,
      guardSources,
      executeGuardLeftBehindAction,
      ownerRemainder,
      sessionLiveWorkProducer,
      dispatchSessionFollowOccurrence,
      spawnSession,
      spawnSessionForInternalResume,
      stopSession,
      stopRequesterSessionForHandoff,
      isSessionAlreadyRunning,
      sessionRunnerStatus,
      restartStaleSessionRunnersAfterDaemonStart,
      hasPendingRunnerRestarts: readPendingRunnerRestarts,
      onChildExited,
      onTrackedSessionHealthy,
      controlPort,
      controlToken,
      daemonWorkSignal,
      stopControlServer,
      connectedServiceAuthGroupPreTurnSwitchCoordinator,
      connectedServicePredictiveSwitchGuard,
      consumeCommittedAuthGroupGeneration,
      requestConnectedServiceRefreshRestartSignal,
      cancelConnectedServiceRuntimeAuthRecovery,
      retryTemporaryThrottleNow,
      readTemporaryThrottleRecovery,
      cancelTemporaryThrottleRecovery,
      reconcileReattachedConnectedServiceCredentialProjection,
      reconcileConnectedServicesProjection,
      awaitAgentSessionOpen,
      installExternalSessionHostOperations,
      readMaterializedStateObservationBinding,
      resolveExecutionRunLiveBrokerAuthority,
      providerAccountUsageStore,
      resolveProviderAccountUsageStore,
      flushProviderAccountUsagePersistence,
      connectedServiceRuntimeQuotaSnapshots,
      createAgentCatalogObservation,
      externalActionIngressOwner,
      managedMachinePolicyAdapter,
      readManagedServiceCurrentLogPaths,
      refreshBrowserRouteOwners: refreshBrowserRouteOwnersFromSessionControl,
      processLeftBehindPass: sessionControlLeftBehindPass,
    } = await startDaemonSessionControlRuntime({


      observeSessionScopeExit: async tracked => {
        const result = await sessionCeiling?.observeRunnerExit(tracked);
        if (result?.status === 'unavailable') logger.warn('[DAEMON RUN] Session scope exit memory evidence unavailable', { sessionId: tracked.happySessionId });
      },
      readSpawnFailureLimits: () => machineVitals?.latest()?.limits,
      readMachineResourcesPolicy: () => machineResourcesPolicy?.read() ?? { status: 'unavailable' },
      readMachineMemory: () => machineVitals?.latest()?.memory ?? null,
      readDoctorResourceVitals: () => ({ sample: machineVitals?.latest() ?? null,
        attention: machineResourceSummary?.getSummary()?.attention ?? null, self: eventLoopStallMonitor.snapshot() }),
      checkRegistryUpdates,
      skillStore,
      skillUsageRecorder,
      endedProcessRoots: () => [...endedProcessRoots.values()],
      retainEndedProcessRoots: roots => {
        for (const root of roots) endedProcessRoots.set(`${processOwnerKey(root.owner)}:${root.pid}`, { ...root, live: false });
      },
      admissionDrain,
      requesterSessionCustodyServerId: requesterRuntimeServerId,
      readLiveWorkInventory: managedActivity.read,
      machineId,
      managedProviderOperationAuthority,
      prepareTeamCredentialNativeSource: async (request, signal) => {
        const producer = providerOperationsProducer;
        if (!producer || isDaemonQuiescing() || homeTransportCancellation.signal.aborted) {
          throw Object.assign(new Error('provider_authorization_changed'), { code: 'provider_authorization_changed' });
        }
        return await producer.machineServices.prepareTeamCredentialNativeSource(request, signal);
      },
      readManagedMachinePolicyCurrent: async (managedId, signal) => (
        await readCurrentManagedMachinePolicies(signal)
      ).machines.find(machine => machine.id === managedId) ?? null,
      externalActionAccountId,
      resolveProjectWorkerAction: () => projectWorkerAction,
      resolveWorkspaceSyncHandoffAdapter: () => workspaceSyncRuntimeCustody.get()?.handoffAdapter ?? null,
      readHelperProcessRoots: () => [...voiceInferenceWorker?.readProcessRoots() ?? [],
        ...workspaceSyncRuntimeCustody.get()?.readProcessRoots() ?? []],
      readTerminalRequesterAttribution: terminalId => {
        const custody = apiMachineForSessions?.getFiniteTerminalSessions()?.getCustody(terminalId);
        return custody ? { serverId: custody.serverId, machineId: custody.machineId,
          installationId: custody.installationId, accountId: custody.requesterAccountId } : undefined;
      },
      serverId: configuration.activeServerId,
      serverBaseUrl: resolveServerHttpBaseUrl(),
      runtimeActionExecute: browserRuntimeActionExecute,
      ...(getWorkflowRuntime
        ? {
            workflowAcceptedAuthorizationCurrentness:
              async input => await workflowRuntime?.isAcceptedAuthorizationCurrent(input) ?? false,
          }
        : {}),
      currentMachineHost: metadataForRegistration.host,
      currentMachineHomeDir: metadataForRegistration.homeDir,
      resolveCurrentMachineExecutionOriginContext,
      resolveExternalSessionHostAction: () => {
        const executor = externalSessionHostActionExecutor;
        if (!executor) return undefined;
        return async ({ actionId, input, context, signal }) =>
          await executor.execute(actionId, input, {
            ...context,
            ...(signal ? { signal } : {}),
          });
      },
      externalSessionPluginAdmissionOwner: pluginAdmissionOwner,
      resolveSessionSpawnDirectTargetTransport: () =>
        sessionSpawnDirectTargetTransport ?? undefined,
      externalSessionHostOperationOwner,
      runtimeId,
      credentials,
      readPluginCatalogProjection: () => ({ runtimeId,
        contributionRegistryProjectionRevision: pluginRegistryProjectionInvalidation.readRevision() }),
      createRequesterSessionRuntimeContext: async (bootstrap, options) => await createRequesterRuntime?.(bootstrap, undefined, options) ?? null,
      resolveRequesterSessionRuntimeContext,
      releaseRequesterSessionRuntimeContext,
      daemonSessionMutationCustody,
      cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop: async (input) =>
        await cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop(input),
      deviceLocalSecretStorage,
      api,
      ...(openTeamCredentialProviderBinding ? { openTeamCredentialProviderBinding } : {}),
      ...(externalActionAccountId ? {
        prepareNativeTeamCredentialBinding: async input => {
          if (isDaemonQuiescing() || homeTransportCancellation.signal.aborted) throw new SessionTeamCredentialLaunchUnavailableError();
          const open = createDaemonSessionTeamCredentialNativeOpen({ machineId, accountId: externalActionAccountId, credentials,
            serverHttpBaseUrl: readRequesterRuntimeServerHttpBaseUrl(), installationIdentity: readInstallationIdentityIfExistsSync(),
            resolveCurrentMachineExecutionOriginContext,
            spawnActionContext: input.spawnActionContext, providerSettingsOperationContext: input.providerSettingsOperationContext });
          const { sessionId, binding } = input;
          const releaseInput = { sessionId, bindings: [binding],
            owningAccountId: input.spawnActionContext?.externalActionExecutionAuthorization?.binding.accountId ?? externalActionAccountId };
          const lifetime = { machineId, credentials: input.providerSettingsOperationContext?.credentials ?? credentials,
            serverHttpBaseUrl: input.providerSettingsOperationContext?.serverHttpBaseUrl ?? readRequesterRuntimeServerHttpBaseUrl(),
            homeServerIdentityId: input.spawnActionContext?.externalActionExecutionAuthorization?.binding.serverIdentityId,
            installationIdentity: readInstallationIdentityIfExistsSync(), resolveCurrentMachineExecutionOriginContext };
          const release = async () => { await releaseDaemonSessionTeamCredentialNativeBindings(releaseInput, lifetime); };
          let borrowed: Awaited<ReturnType<typeof open>> | undefined;
          try {
            borrowed = await open({ ...input, consumer: { kind: 'session', sessionId },
              signal: input.signal ?? homeTransportCancellation.signal });
          }
          catch (error) { if (input.created) await release(); throw error; }
          finally { await borrowed?.cleanup(); }
          return release;
        },
        releaseSessionOwnedNativeBindings: createDaemonSessionTeamCredentialNativeRelease({
          machineId, accountId: externalActionAccountId, credentials, get serverHttpBaseUrl() { return readRequesterRuntimeServerHttpBaseUrl(); },
          readInstallationIdentity: readInstallationIdentityIfExistsSync, resolveCurrentMachineExecutionOriginContext,
        }),
      } : {}),
      ...(externalActionAccountId ? { readInstalledTeamCredentialProviderModel: async input => {
        if (isDaemonQuiescing() || homeTransportCancellation.signal.aborted) throw new SessionTeamCredentialLaunchUnavailableError();
        const result = await readDaemonSessionTeamCredentialNativeBinding(input, {
          machineId, accountId: externalActionAccountId, credentials,
          serverHttpBaseUrl: readRequesterRuntimeServerHttpBaseUrl(),
          installationIdentity: readInstallationIdentityIfExistsSync(),
          resolveCurrentMachineExecutionOriginContext,
        });
        if (result.status !== 'ready' || !isDeepStrictEqual(result.binding, input.binding.nativeDelivery)
          || isDaemonQuiescing() || homeTransportCancellation.signal.aborted) throw new SessionTeamCredentialLaunchUnavailableError();
        return result.model;
      } } : {}),
      ...(openRunAccountConnectionSource ? { openAccountConnectionManagedConsumerSource: openRunAccountConnectionSource } : {}),
      ...(managedPolicyHomeId && externalActionAccountId ? {
        openAccountConnectionProviderBrokerAccess: async request => {
          const runtime = machineIrohRuntime;
          if (!runtime) throw createNativeRuntimeAbsentProviderBrokerError(request);
          const openTunnel = createProviderBrokerMachineCarrierTunnelOpen({
            homeId: managedPolicyHomeId, accountId: externalActionAccountId, localMachineId: machineId,
            runtime, resolveTrustRoots: resolvePeerMediationTrustRoots,
          });
          return await openAccountConnectionProviderBrokerAccess({
            ...request, homeId: managedPolicyHomeId, accountId: externalActionAccountId, initiatorMachineId: machineId,
            openBroker: async (openRequest, signal) => await api.openAccountConnectionProviderBroker(openRequest, { signal }),
            admitConsumer: async (authority, signal) => await api.admitAccountConnectionProviderBroker({ v: 2, authority }, { signal }),
            openTunnel,
          });
        },
      } : {}),
      connectedServicesMaterializationBaseDir,
      getConnectedServiceRefreshCoordinator: () => connectedServiceRefreshCoordinator,
      getConnectedServiceQuotasCoordinator: () => connectedServiceQuotasCoordinator,
      resolveQualifiedConnectedAccountV4Support: () =>
        resolveQualifiedConnectedAccountAtomicV4Negotiation(
          serverFeaturesSnapshotStore.getSnapshot(),
        ),
      resolveQualifiedConnectedAccountRequestAuthTransport: (service) =>
        resolveQualifiedConnectedAccountPeerOperationTransport({
          snapshot: serverFeaturesSnapshotStore.getSnapshot(),
          serverContract:
            apiMachineForSessions
              ?.getSessionSyncPendingInputServerContractResult()
              ?? null,
          service,
          operation: 'request_auth',
        }),
      establishedConnectedAccountRuntimeOwner,
      connectedAccountRequestAuthRegistry,
      onConnectedAccountRequestAuthHttpPortReady(port) {
        connectedAccountRequestAuthHttpPort = port;
      },
      connectedServiceRuntimeRegistry,
      ownedConnectedServiceRuntimeRegistry,
      pidToTrackedSession,
      pidToAwaiter,
      pidToSpawnResultResolver,
      pidToSpawnWebhookTimeout,
      persistedTakeoverAdmissionWaiter,
      getApiMachineForSessions: () => apiMachineForSessions,
      onLocalServicesRoutesReady: (routes) => {
        localServiceInventoryRoutes = routes.localServicesInventory ?? null;
        machineRpcRouteAttachments.attachLocalServicesRoutes(routes);
      },
      onComputerRoutesReady: machineRpcRouteAttachments.attachComputerRoutes,
      onLocalServicesSummaryReady: (source) => {
        localServiceSummary = source;
        isProjectServiceExecutionLive = source.isProjectServiceExecutionLive;
      },
      onManagedServiceEndpointReadHostReady: (host) => {
        managedServiceEndpointReadHost = host;
      },
      onManagedServiceSessionBaseUrlResolverReady: (resolver) => {
        managedServiceSessionBaseUrlResolver = resolver;
      },
      onManagedServiceSessionClientAccessResolverReady: (resolver) => {
        managedServiceSessionClientAccessResolver = resolver;
      },
      onLocalServicesPreviewRoutesReady: (routes) => {
        machineRpcRouteAttachments.attachLocalServicesPreviewRoutes(routes);
        acquireLocalServicePreviewApplication = routes.acquireNativeApplication;
      },
      onBrowserControlRoutesReady: machineRpcRouteAttachments.attachBrowserControlRoutes,
      onBrowserContextRoutesReady: machineRpcRouteAttachments.attachBrowserContextRoutes,
      onBrowserDiagnosticsRoutesReady: machineRpcRouteAttachments.attachBrowserDiagnosticsRoutes,
      onBrowserRecordingRoutesReady: machineRpcRouteAttachments.attachBrowserRecordingRoutes,
      onBrowserRecordingRuntimeReady: bindStorageRecordings,
      onSimulatorPreviewRoutesReady: machineRpcRouteAttachments.attachSimulatorPreviewRoutes,
      onMachineAccessLossReceiverReady: machineRpcRouteAttachments.attachMachineAccessLossReceiver,
      onConnectedServicePoolSelectionReadReady: machineRpcRouteAttachments.attachConnectedServicePoolSelectionRead,
      resolveServerFeaturesSnapshot: () => readServerFeaturesSnapshot(serverFeaturesSnapshotStore, refreshServerFeaturesSnapshot),
      liveStreamCaptureRegistry,
      simulatorInputLeaseManager,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      connectedServicesRestartRequestedPids,
      loadTerminalHostAdapters,
      startupTerminalRecovery: {
        disconnectedTerminalHostCandidates,
        unresolvedTerminalHostSessionIds,
      },
      onAlreadyRunningSessionAdopted: async (sessionId) => {
        pendingSessionMachineAccessBindingIds.add(sessionId);
        await reconcileSessionMachineAccessBindings();
      },
      connectedServiceGroupHomeCleanupScheduler,
      connectedServiceMaterializedHomeCleanupScheduler,
      beforeShutdown,
      onHappySessionWebhook,
      setOnTrackedSessionPidPromoted: (handler) => {
        onTrackedSessionPidPromoted = handler;
      },
      admitPersistedTakeover: async (input) => {
        const owner = persistedTakeoverAdmissionOwner;
        if (!owner) {
          throw new Error('persisted_takeover_admission_owner_unavailable');
        }
        if (input.phase === 'admit') {
          await owner.admit(input);
          return;
        }
        await owner.runtimeBound(input);
      },
      sshTunnelSupervisor,
      requestShutdown,
      requestSelfRestart: requestControlServerSelfRestart,
      pluginChangeService,
      hardRevokeRunningSessionsForGenerationIntegrityFailure:
        pluginRuntimeOwner
          .hardRevokeRunningSessionsForGenerationIntegrityFailure,
      resolveManagedPurposeBindingIntent:
        connectedAccountPurposeBindingRuntime.resolveBindingIntent,
      projectProviderModelsForAccount: async (request, context) => {
        const producer = providerOperationsProducer;
        if (!producer) throw new Error('provider_source_projection_unavailable');
        return await producer.machineServices.projectModelsForAccount(request, context);
      },
      activateSessionPurposeBindings:
        connectedAccountPurposeBindingRuntime.activateSessionPurposeBindings,
      resolveCurrentSessionPurposeBindingSnapshot:
        connectedAccountPurposeBindingRuntime
          .resolveCurrentSessionPurposeBindingSnapshot,
      ...(externalActionAccountId && homeDomainAction
        ? {
            resolveSessionTeamCredentialBindingIntents: async ({ teamResourceSelections, signal }) =>
              await resolvePurposeTeamCredentialBindingIntentsFromHome({
                teamResourceSelections,
                signal,
                resolveTeamCredentialResourceCatalog:
                  createSpawnConnectedServicesTeamResourceCatalogResolver({
                    homeDomainAction,
                    serverId: configuration.activeServerId,
                    accountId: externalActionAccountId,
                  }),
              }),
          }
        : {}),
      resolveCurrentRequestAuthBinding:
        connectedAccountPurposeBindingRuntime
          .resolveCurrentRequestAuthBinding,
      materializeRequestAuthBearer:
        connectedAccountPurposeBindingRuntime.materializeRequestAuthBearer,
      activatePurposeBindings:
        connectedAccountPurposeBindingRuntime.activatePurposeBindings,
      isShuttingDown: isDaemonQuiescing,
      processEnv: process.env,
    });
    machineRpcRouteAttachments.attachMachineReachabilityRoutes(createDaemonMachineReachabilityRoutes({
      getMachineClient: () => apiMachine, target: machineResourceTarget, agentIsolation, adminAccess: machineAdminAccessRoutes, ownerRemainder,
    }));
    hasPendingRunnerRestarts = readPendingRunnerRestarts;
    processLeftBehindPass = sessionControlLeftBehindPass;
    await processLeftBehindPass.firstPass();
    const requesterForProcessOwner: Parameters<typeof createProcessActionExecutor>[0]['requesterForOwner'] = (owner, roots) => {
      const target = machineResourceTarget();
      return target ? resolveProcessOwnerRequester(owner, roots, { target, custodianAccountId: target.custodianAccountId }) : null;
    };
    const allProcessesVisible = () => {
      const snapshot = machineResourcesPolicy?.read();
      return snapshot?.status === 'ready' && snapshot.policy.processes.allProcessesVisible;
    };
    machineProcessesView = createMachineProcessesView({
      onRequesterEvidenceUnavailable: failure => logger.debug('[DAEMON PROCESSES] Owner requester evidence unavailable', failure),
      processOwnershipRuntime, leftBehind: sessionControlLeftBehindPass, machineVitals,
      platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
      allProcessesVisible, requesterForOwner: requesterForProcessOwner, roleCatalog: readProcessRoleCatalog(),
      readCeiling: root => sessionCeiling?.readObservation(root),
      ...(localServiceInventoryRoutes ? { localServiceRoutes: localServiceInventoryRoutes } : {}),
      readRequesterIdentities: async () => {
        const target = machineResourceTarget();
        const readAccess = daemonAccountServerActions?.machineAccessAction;
        if (!target || !readAccess || homeTransportCancellation.signal.aborted) return new Map();
        const raw = await readAccess({ actionId: 'machines.access.grants.list',
          input: { serverId: target.serverId, machineId: target.machineId },
          context: { surface: 'cli', serverId: target.serverId }, signal: homeTransportCancellation.signal });
        const access = MachineAccessGrantsListResponseV1Schema.safeParse(raw);
        const current = machineResourceTarget();
        if (!access.success || homeTransportCancellation.signal.aborted || !current
          || current.machineId !== target.machineId || current.installationId !== target.installationId
          || current.custodianAccountId !== target.custodianAccountId || current.serverId !== target.serverId
          || access.data.machineId !== target.machineId || access.data.custodian.accountId !== target.custodianAccountId
          || !access.data.canManage || access.data.access.accessState !== 'ready') return new Map();
        return new Map((access.data.currentRequesterDisplayIdentities ?? []).map(identity => [identity.accountId, identity]));
      },
    });
    const processActions = createProcessActionExecutor({
      ...processActionOwnerAdapters, ownership: processOwnershipRuntime, leftBehind: sessionControlLeftBehindPass,
      allProcessesVisible, requesterForOwner: requesterForProcessOwner,
      prepareKill: processActionLifecycle.prepareKill,
      onRootEnded: root => {
        endedProcessRoots.set(`${processOwnerKey(root.owner)}:${root.pid}`, { ...root, live: false, endedAtMs: Date.now() });
      },
      stopOwner: async (root, execution) => {
        if (root.owner.kind === 'session') {
          const result = await processActionLifecycle.stopExactSession({ sessionId: root.owner.sessionId,
            pid: root.pid, start: root.start, signal: execution.signal, verifyCurrent: execution.verifyCurrent,
            ...(execution.actionContext ? { actionContext: execution.actionContext } : {}),
            ...(execution.rpcContext ? { rpcContext: execution.rpcContext } : {}),
            ...(execution.physicalStopEffect ? { physicalStopEffect: execution.physicalStopEffect } : {}) });
          if (!isTerminalHostPhysicallyRetiredStopResult(result)) return false;
          return result;
        }
        return await processActionOwnerAdapters.stopOwner(root, execution);
      },
      closeTerminal: async (owner, execution) => {
        if (execution.signal?.aborted || execution.verifyCurrent && !await execution.verifyCurrent()) return false;
        const manager = apiMachineForSessions?.getFiniteTerminalSessions();
        if (!manager || !manager.list().some(terminal => terminal.terminalId === owner.terminalId)) return false;
        return manager.close({ terminalId: owner.terminalId });
      },
    });
    machineRpcRouteAttachments.attachMachineProcessesRoutes({
      target: machineResourceTarget, view: machineProcessesView, actions: processActions,
    });
    sessionActivityOwner = sessionLiveWorkProducer;
    sessionActivity.notifyChanged();
    const { withAccess: withGuardAccess, sendNotice: sendGuardSessionNotice } = createGuardSessionAccess({
      readAccess: () => ({ credentials, custodianAccountId: externalActionAccountId,
        retainedRecordSignal: homeTransportCancellation.signal,
        serverId: requesterRuntimeServerId, machineId, serverHttpBaseUrl: readRequesterRuntimeServerHttpBaseUrl() }),
      resolveRequesterSessionRuntimeContext, releaseRequesterSessionRuntimeContext,
      isTrackedCurrent: tracked => !admissionDrain.isPublicationQuiescing() && pidToTrackedSession.get(tracked.pid) === tracked,
    });
    const readGuardEligibility = async (tracked: TrackedSession, signal?: AbortSignal) =>
      withGuardAccess(tracked, access => readCurrentSessionEligibility({ access }), signal);
    const guardFacts = createReadGuardFacts({ ...guardSources,
      trackedSessions: () => pidToTrackedSession.values(),
      readInventory: () => managedActivity.read(),
      readSessionEligibility: async (tracked, inventory, signal) =>
        withGuardAccess(tracked, access => readCurrentSessionEligibility({ access, inventory }), signal),
    });
    const defaultGuardPolicy = MachineGuardPolicyV1Schema.parse({});
    const readGuardPolicy = () => {
      const current = machineResourcesPolicy?.read();
      return current?.status === 'ready' ? current.policy.guard : defaultGuardPolicy;
    };
    const ceilingCapability = await readGuardCeilingCapability();
    const recordGuardSessionReplacement = async (previous: TrackedSession) => {
      const replacement = [...pidToTrackedSession.values()].find(item => item !== previous
        && item.happySessionId === previous.happySessionId && item.happySessionMetadataFromLocalWebhook
        && !item.reattachedFromDiskMarker && item.stopRequestedAtMs === undefined && !item.spawnStartupReadinessFailure);
      if (!replacement || pidToAwaiter.has(replacement.spawnStartupAwaiterPid ?? replacement.pid)) return;
      await replacement.canonicalWebhookReconciliation;
      if (pidToTrackedSession.get(replacement.pid) !== replacement || replacement.spawnStartupReadinessFailure
        || replacement.stopRequestedAtMs !== undefined) return;
      const ownership = await processOwnershipRuntime.readOwners({ freshness: 'fresh' });
      if (ownership.status === 'ok' && ownership.rows.some(row => row.level === 'proven' && !row.ownerEnded
        && row.owner?.kind === 'session' && row.owner.sessionId === replacement.happySessionId
        && row.pid === (replacement.sessionRunnerPid ?? replacement.pid)))
        await guardSessionRestoration?.onSessionRunnerStarted(replacement);
    };
    let idleTerminals: ReturnType<typeof createIdleTerminalPolicy> | undefined;
    daemonGuard = await createDaemonGuard({
      activeServerDir: configuration.activeServerDir, policy: machineResourcesPolicy,
      sampler: machineVitals, keepAwake: daemonKeepAwake, summary: machineResourceSummary,
      ownership: processOwnershipRuntime, inventory: managedActivity,
      readFacts: async (ownership, signal) => guardFacts({ ownership, inventory: await managedActivity.read(), signal }),
      readTarget: () => {
        const target = machineResourceTarget();
        if (!target) throw new Error('machine_target_unavailable');
        return target;
      },
      readLeftBehind: ownership => {
        if (ownership.status !== 'ok') return { count: sessionControlLeftBehindPass.confirmed().length, footprintBytes: null };
        const rows = new Map(ownership.snapshot.rows.map(row => [row.pid, row]));
        const confirmed = sessionControlLeftBehindPass.confirmed().filter(item => {
          const row = rows.get(item.pid);
          return row && equalProcessStart(item.start, row.start);
        });
        const measured = confirmed.map(item => rows.get(item.pid)?.memory?.bytes);
        return { count: confirmed.length, footprintBytes: measured.every((bytes): bytes is number => bytes !== undefined)
          ? measured.reduce((total, bytes) => total + bytes, 0) : null };
      },
      stopTarget: (candidate, signal) => candidate.kind === 'browser' ? browserClose(candidate, signal)
        : candidate.kind === 'service' ? serviceStop(candidate, signal)
        : stopGuardSession({ candidate, signal,
          readCurrentTracked: id => [...pidToTrackedSession.values()].find(tracked => tracked.happySessionId === id),
          readCurrentEligibility: readGuardEligibility,
          stopSession: async (id, tracked) => isTerminalHostPhysicallyRetiredStopResult(await stopSession(id, {
            expectedTrackedRunner: { tracked, sessionRunnerPid: tracked.sessionRunnerPid,
              processStartTimeMs: tracked.processStartTimeMs, processCommandHash: tracked.processCommandHash },
            beforeSignalExactTrackedRunner: () => !signal.aborted,
          })),
        }),
      onSessionStopRecorded: async candidate => {
        if (candidate.target.kind === 'session') await recordGuardSessionReplacement(candidate.target.tracked);
      },
      notice: async (candidate, state, signal) => {
        if (candidate.target.kind !== 'session') return false;
        return sendGuardSessionNotice(candidate.target.tracked, state, signal);
      },
      notifyEpisode: async episode => {
        const snapshot = getActiveAccountSettingsSnapshot();
        const target = machineResourceTarget();
        if (!snapshot || !target || snapshot.scopeKey !== resolveAccountSettingsScopeKey(credentials))
          throw new Error('guard_notification_account_unavailable');
        await dispatchActivityNotificationAsync({ settings: snapshot.settings, secretSources: daemonSecretSources,
          isCurrent: () => !homeTransportCancellation.signal.aborted && getActiveAccountSettingsSnapshot() === snapshot,
          expoPushSender: api.push(), event: buildMachineGuardEpisodeNotificationEvent({ machineId: target.machineId, episode }) });
      },
      createPolicyWork: activityLog => {
        const changed = new Set<() => void>();
        const leftBehind = createLeftBehindActuator({
          readPolicy: () => readGuardPolicy().leftBehind,
          confirmed: sessionControlLeftBehindPass.confirmed,
          readRestoration: owner => readLeftBehindRestoration({ owner, endedRoots: endedProcessRoots.values(), machineId }),
          executeAction: executeGuardLeftBehindAction,
          activity: activityLog,
        });
        let lastAuxPolicy: string | undefined;
        sessionCeiling = createSessionMemoryCeiling({ capability: ceilingCapability, activityLog, activeServerDir: configuration.activeServerDir,
          readPolicy: readGuardPolicy,
          onSessionStopRecorded: recordGuardSessionReplacement,
          hasSessionOverrides: () => [...pidToTrackedSession.values()].some(tracked =>
            typeof readSessionMemoryCeilingOverride(tracked.happySessionMetadataFromLocalWebhook) === 'number'),
          readSessions: async callerSignal => {
            const signal = callerSignal ?? homeTransportCancellation.signal;
            const targets: SessionMemoryCeilingTarget[] = [];
            await waitForChangeOrDeadline({ signal, waitForChange: async () => {
              signal.throwIfAborted();
              const ownership = await processOwnershipRuntime.readOwners({ freshness: 'fresh' });
              signal.throwIfAborted();
              if (ownership.status !== 'ok') throw new Error('guard_ceiling_ownership_unavailable');
              for (const root of ownership.roots) {
                if (!root.live || root.owner.kind !== 'session' || !root.requesterWorkAttributionV1) continue;
                const ownerSessionId = root.owner.sessionId;
                const tracked = [...pidToTrackedSession.values()].find(item => item.happySessionId === ownerSessionId
                  && (item.sessionRunnerPid ?? item.pid) === root.pid);
                if (!tracked) continue;
                const target = await withGuardAccess(tracked, guardAccess => withTrackedSessionRpc(guardAccess, async (_callRpc, access) => {
                  const metadata = tryDecryptSessionOwnerMetadataView({ credentials: access.credentials,
                    accountEncryptionMode: access.accountEncryptionMode, rawSession: access.rawSession });
                  if (!metadata) return null;
                  const summary = SessionSharedSummaryV1Schema.safeParse(metadata.summary);
                  return { tracked, root, label: (summary.success ? summary.data.text : undefined) ?? tracked.happySessionId ?? 'Session',
                    attribution: root.requesterWorkAttributionV1!, metadata };
                }), signal);
                signal.throwIfAborted();
                if (!target && pidToTrackedSession.get(tracked.pid) === tracked)
                  throw new Error('guard_ceiling_session_metadata_unavailable');
                if (target) targets.push(target);
              }
            } });
            signal.throwIfAborted();
            return targets;
          },
          readEligibility: readGuardEligibility,
          stopSession: async (id, tracked) => isTerminalHostPhysicallyRetiredStopResult(await stopSession(id, {
            expectedTrackedRunner: { tracked, sessionRunnerPid: tracked.sessionRunnerPid,
              processStartTimeMs: tracked.processStartTimeMs, processCommandHash: tracked.processCommandHash },
            beforeSignalExactTrackedRunner: () => !homeTransportCancellation.signal.aborted,
          })),
          notice: sendGuardSessionNotice,
          clearNotice: tracked => sendGuardSessionNotice(tracked, { kind: 'clear' }, homeTransportCancellation.signal),
          notify: async ({ kind, sessionId, memory }) => {
            const tracked = [...pidToTrackedSession.values()].find(item => item.happySessionId === sessionId);
            if (!tracked || !await sendGuardSessionNotice(tracked, { kind: 'notify_ceiling', notice: kind, ...(memory ? { memory } : {}) }, homeTransportCancellation.signal))
              throw new Error('guard_notification_session_unavailable');
          },
        });
        const ceiling = sessionCeiling;
        idleTerminals = createIdleTerminalPolicy({
          getTerminals: () => apiMachineForSessions?.getFiniteTerminalSessions() ?? null,
          ownership: processOwnershipRuntime, activityLog, readPolicy: readGuardPolicy,
          readTarget: () => {
            const target = machineResourceTarget();
            if (!target) throw new Error('machine_target_unavailable');
            return target;
          },
          notifyWarning: async ({ terminal, stopAt, idleMs, signal }) => {
            const custody = terminal.custody;
            const target = machineResourceTarget();
            if (!custody || !target || signal.aborted || custody.serverId !== target.serverId
              || custody.machineId !== target.machineId || custody.installationId !== target.installationId)
              throw new Error('guard_notification_terminal_unavailable');
            if (custody.kind === 'session') {
              const tracked = [...pidToTrackedSession.values()].find(item => item.happySessionId === custody.sessionId);
              if (!tracked || !await sendGuardSessionNotice(tracked, { kind: 'notify_terminal_warning',
                terminalId: terminal.terminalId, terminalKey: terminal.terminalKey, stopAt, idleMs }, signal))
                throw new Error('guard_notification_session_unavailable');
              return;
            }
            const snapshot = getActiveAccountSettingsSnapshot();
            if (custody.requesterAccountId !== externalActionAccountId || !snapshot
              || snapshot.scopeKey !== resolveAccountSettingsScopeKey(credentials))
              throw new Error('guard_notification_account_unavailable');
            await dispatchActivityNotificationAsync({ settings: snapshot.settings, secretSources: daemonSecretSources,
              isCurrent: () => !signal.aborted && !homeTransportCancellation.signal.aborted
                && getActiveAccountSettingsSnapshot() === snapshot,
              expoPushSender: api.push(), event: { topic: 'guard_stop_warning', machineId: target.machineId,
                terminalId: terminal.terminalId, terminalKey: terminal.terminalKey, stopAt, idleMs, rule: 'idle_terminals' } });
          },
        });
        const terminals = idleTerminals;
        return {
          enabled: policy => policy.leftBehind.mode !== 'off' || ceiling.enabled(policy) || policy.idleTerminals.enabled,
          terminalState: terminals.terminalState,
          subscribe: listener => {
            changed.add(listener);
            const releases = [managedActivity.subscribe(() => { leftBehind.invalidateFailures(); listener(); }),
              ceiling.subscribe(listener), terminals.subscribe(listener)];
            return () => { changed.delete(listener); for (const release of releases) release(); };
          },
          readPlan: async request => {
            const readSignal = request.readSignal ?? request.signal;
            readSignal.throwIfAborted();
            const policyIdentity = JSON.stringify(request.policy);
            if (policyIdentity !== lastAuxPolicy) { leftBehind.invalidateFailures(); lastAuxPolicy = policyIdentity; }
            let leftPlan: GuardPolicyWorkPlan = {};
            if (request.policy.leftBehind.mode !== 'off') {
              await sessionControlLeftBehindPass.readConfirmed();
              readSignal.throwIfAborted();
              const plan = leftBehind.plan();
              const due = plan.due[0];
              leftPlan = { nextAt: plan.nextAt, ...(due ? { run: async () => { await leftBehind.execute(due, request.signal); } } : {}) };
            }
            const plans: readonly GuardPolicyWorkPlan[] = [ceiling.enabled(request.policy) ? await ceiling.readPlan(request) : {},
              await terminals.readPlan(request), leftPlan];
            readSignal.throwIfAborted();
            const deadlines = plans.flatMap(plan => plan.nextAt === undefined ? [] : [plan.nextAt]);
            const due = plans.find(plan => plan.run);
            return { ...(deadlines.length ? { nextAt: Math.min(...deadlines) } : {}), ...(due?.run ? { run: due.run } : {}) };
          },
          refreshOnTick: () => { leftBehind.invalidateFailures(); ceiling.refreshOnTick(); terminals.refreshOnTick(); for (const listener of [...changed]) listener(); },
          deactivate: () => { terminals.deactivate(); ceiling.deactivate(); },
          stop: () => { terminals.stop(); ceiling.stop(); changed.clear(); },
        };
      },
      ceilingCapability, signal: homeTransportCancellation.signal,
      onError: error => logger.warn('[DAEMON RUN] Guard operation failed', error),
    });
    const currentGuard = daemonGuard;
    guardSessionRestoration = createGuardSessionRestoration({ activity: currentGuard.activityLog,
      readCustodianTarget: machineResourceTarget });
    machineRpcRouteAttachments.attachMachineGuardRoutes({ target: machineResourceTarget,
      guard: currentGuard.watch, activity: currentGuard.activityLog,
      keepRunning: async (request, _requester, signal, verifyCurrent) => {
        if (signal?.aborted || !verifyCurrent || !await verifyCurrent()) return { status: 'not_pending' };
        if (request.terminalKey) return idleTerminals?.keepRunning({ terminalKey: request.terminalKey }, _requester, signal) ?? { status: 'not_pending' };
        if (!request.sessionId) return { status: 'not_pending' };
        if (!_requester.isCustodian && !(await currentGuard.watch.readView(_requester, signal)).idle
          .some(row => row.sessionRef === request.sessionId)) return { status: 'not_pending' };
        return { status: await currentGuard.runtime.keepRunning(request.sessionId) };
      },
      setSessionCeiling: async (request, requester, signal, verifyCurrent) => {
        if (signal?.aborted || !verifyCurrent || !await verifyCurrent()) throw new Error('machine_target_unavailable');
        if (ceilingCapability.status === 'unavailable') return { status: 'unavailable', appliesAt: 'next_start', reason: ceilingCapability.reason };
        const tracked = [...pidToTrackedSession.values()].find(item => item.happySessionId === request.sessionId);
        const target = machineResourceTarget();
        if (!tracked) {
          if (!target || requester.serverId !== target.serverId) throw new Error('session_owner_unavailable');
          const context = await resolveRequesterSessionRuntimeContext(request.sessionId);
          try {
            const attribution = context?.bootstrap.attribution;
            if (context && (!await context.isCurrent() || attribution?.serverId !== target.serverId
              || attribution.machineId !== target.machineId || attribution.installationId !== target.installationId
              || !requester.isCustodian && attribution.accountId !== requester.accountId))
              throw new Error('session_owner_unavailable');
            if (!context && !requester.isCustodian) throw new Error('session_owner_unavailable');
            const written = await runWithServerHttpBaseUrl(context?.bootstrap.serverHttpBaseUrl ?? readRequesterRuntimeServerHttpBaseUrl(),
              () => updateSessionMetadataForTarget({ credentials: context?.bootstrap.credentials ?? credentials,
                idOrPrefix: request.sessionId, expectedSessionId: request.sessionId,
                currentness: { signal, verifyCurrent: async () => !homeTransportCancellation.signal.aborted
                  && await verifyCurrent() && (!context || await context.isCurrent()) },
                updater: metadata => {
                  if (metadata.machineId !== target.machineId) throw new Error('session_machine_mismatch');
                  return applySessionMemoryCeilingOverrideToMetadata(metadata, request.bytes);
                },
              }));
            if (!written.ok) throw new Error(`session_ceiling_${written.code}`);
            const started = [...pidToTrackedSession.values()].find(item => item.happySessionId === request.sessionId);
            if (started && sessionCeiling) {
              await started.canonicalWebhookReconciliation;
              signal?.throwIfAborted();
              if (!await verifyCurrent()) throw new Error('machine_target_unavailable');
              const applied = await sessionCeiling.apply(request, signal);
              currentGuard.runtime.invalidate();
              return applied;
            }
            currentGuard.runtime.invalidate();
            return { status: 'applied', appliesAt: 'next_start' };
          } finally {
            if (context) await releaseRequesterSessionRuntimeContext(context);
          }
        }
        const stamp = tracked?.requesterWorkAttributionV1 ?? tracked?.spawnOptions?.requesterWorkAttributionV1;
        if (!tracked || !target || requester.serverId !== target.serverId || !requester.isCustodian
          && (!stamp || stamp.serverId !== requester.serverId || stamp.accountId !== requester.accountId
            || stamp.machineId !== target.machineId || stamp.installationId !== target.installationId))
          throw new Error('session_owner_unavailable');
        if (!await sendGuardSessionNotice(tracked, { kind: 'ceiling', bytes: request.bytes }, signal)) throw new Error('session_guard_notice_unavailable');
        if (signal?.aborted || !await verifyCurrent() || !sessionCeiling) throw new Error('machine_target_unavailable');
        const result = await sessionCeiling.apply(request, signal);
        currentGuard.runtime.invalidate();
        return result;
      },
    });
    storageRoutes = createDaemonStorageRoutes({
      target: machineResourceTarget,
      readOwnSessionIds: async accountId => {
        const target = machineResourceTarget();
        if (!target) return new Set<string>();
        const own = new Set<string>();
        for (const tracked of pidToTrackedSession.values()) {
          const stamp = tracked.requesterWorkAttributionV1 ?? tracked.spawnOptions?.requesterWorkAttributionV1;
          if (tracked.happySessionId && stamp?.accountId === accountId && stamp.serverId === target.serverId
            && stamp.machineId === target.machineId && stamp.installationId === target.installationId) own.add(tracked.happySessionId);
        }
        // Protected requester custody proves the immutable Session/Account binding, not liveness.
        const custody = await listRequesterSessionCredentialBindings({ happyHomeDir: configuration.happyHomeDir, ...target });
        if (custody.status === 'ready') for (const binding of custody.bindings) {
          if (binding.attribution.accountId === accountId) own.add(binding.sessionId);
        }
        return own;
      },
      deps: async target => {
        const home = configuration.happyHomeDir;
        const activeServerDir = configuration.activeServerDir;
        const capturedCredentials = credentials;
        const [{ createManagedSessionDirectories }, projectRows, { getSharedTerminalProcessRegistry }, { readStorageWorktrees },
          { readStorageComposerMediaStageFacts }, { readStorageSessionHandoffFacts }, { resolveCanonicalAbsolutePath },
          { MachineStoragePolicyV1Schema }, { readResidentVoiceModelPackPaths }, { readSessionDraftPresence },
          { createStorageWorktreeOperations }, { createLogRetentionOwner }, { createProjectWorkspaceRetirement }] = await Promise.all([
          import('@/session/creation/managedSessionDirectories'), import('@/workspaces/projectAccountRows'),
          import('./local/services/inventory/terminalRegistry'), import('./resources/readStorageWorktrees'),
          import('@/transfers/staging/composerMediaStageStore'), import('@/session/handoff/state/sessionHandoffSourceExportStore'),
          import('@/utils/path/expandHomeDirPath'),
          import('@happier-dev/protocol/storage/storageV1'),
          import('./voiceInference/publicModelPacks/storagePaths'),
          import('@/session/drafts/readSessionDraftPresence'),
          import('@/storage/worktrees/storageWorktreeOperations'),
          import('@/utils/logs/logRetention'),
          import('@/workspaces/projectWorkspaceRetirement'),
        ]);
        const defaultStoragePolicy = MachineStoragePolicyV1Schema.parse({});
        const readTrackedSessions = () => [...pidToTrackedSession.values()].flatMap(tracked => {
          const cwd = tracked.runnerAgentInvocationContext?.cwd ?? tracked.spawnOptions?.directory ?? tracked.happySessionMetadataFromLocalWebhook?.path;
          return tracked.happySessionId && cwd ? [{ sessionId: tracked.happySessionId, cwd, running: true }] : [];
        });
        const readProjects = () => {
          const expectedScope = `${target.serverId}:${resolveAccountSettingsScopeKey(capturedCredentials)}`;
          const snapshot = projectRows.getActiveProjectAccountRowsSnapshot();
          const workspaceRefs = readMachineProjectWorkspaceRefs(snapshot, { scopeKey: expectedScope,
            serverId: target.serverId, homeServerIdentityId: resolveBoundHomeServerIdentityId(), machineId: target.machineId });
          if (!workspaceRefs) return { status: 'unavailable' as const };
          let unresolvedRoot = false;
          const projects = workspaceRefs.flatMap(ref => {
              const root = resolveCanonicalAbsolutePath(ref.rootPath);
              if (!root) unresolvedRoot = true;
              return root ? [{ repositoryRoot: root.path, projectId: projectWorkspaceRefV1(ref).projectKey }] : [];
            });
          if (unresolvedRoot) return { status: 'unavailable' as const, projects };
          return { status: 'ready' as const, projects };
        };
        const storageVitals = createDaemonStorageVitalsBindings(machineVitals);
        const hostBootedAt = machineVitals?.host()?.bootedAt;
        const storageIdle = async () => (await managedActivity.readDecision()).kind === 'idle'
          && scmWorktreeMutationActivity.isIdle();
        const subscribeStorageIdle = (listener: () => void) => {
          const releases = [managedActivity.subscribe(listener), scmWorktreeMutationActivity.subscribe(listener)];
          return () => { for (const release of releases) release(); };
        };
        const subscribeStorageRecordings = (listener: () => void) => {
          storageOwnerListeners.add(listener);
          if (storageOwnerListeners.size === 1) {
            unsubscribeStorageRecordings = storageRecordings?.service.subscribeStorageChanges(notifyStorageOwnerChanged);
            unsubscribeStorageModels = subscribeStorageModels();
          }
          return () => {
            storageOwnerListeners.delete(listener);
            if (!storageOwnerListeners.size) {
              unsubscribeStorageRecordings?.(); unsubscribeStorageRecordings = undefined;
              unsubscribeStorageModels?.(); unsubscribeStorageModels = undefined;
            }
          };
        };
        return {
          serverId: target.serverId, machineId: target.machineId, custodianAccountId: target.custodianAccountId,
          dockerPrune: (await import('@/storage/dockerPrune')).createStorageDockerPruneForHost({
            credentials: capturedCredentials, serverId: target.serverId, serverHttpBaseUrl: configuration.serverUrl,
            machineId: target.machineId, installationId: target.installationId, happyHomeDir: home,
            async assertInstalledCurrent() {
              const current = machineResourceTarget();
              if (credentials !== capturedCredentials || !current || current.serverId !== target.serverId
                || current.machineId !== target.machineId || current.installationId !== target.installationId
                || current.custodianAccountId !== target.custodianAccountId)
                throw Object.assign(new Error('Storage deployment authority changed'), { code: 'unauthorized' });
            },
          }),
          homeDir: homedir(), activityLog: currentGuard.activityLog,
          attributionFor: accountId => ({ serverId: target.serverId, accountId,
            machineId: target.machineId, installationId: target.installationId }),
          readPolicy: () => {
            const snapshot = machineResourcesPolicy?.read();
            return snapshot?.status === 'ready' ? snapshot.policy.storage : defaultStoragePolicy;
          },
          ...(machineResourcesPolicy ? { resourcesPolicy: machineResourcesPolicy } : {}),
          canRunStorageOwnerOperation: storageIdle,
          readLowPower: () => {
            const sample = machineVitals?.latest();
            return sample?.power?.onAC === false || sample?.thermal?.state === 'serious'
              || sample?.thermal?.state === 'critical' || sample?.thermal?.throttled === true;
          },
          maintenance: {
            subscribePolicy: listener => machineResourcesPolicy?.subscribe(listener) ?? (() => {}),
            subscribeVolumes: storageVitals.subscribeVolumes,
            isIdle: storageIdle, subscribeIdle: subscribeStorageIdle,
            isOnPower: storageVitals.isOnPower,
            subscribePower: storageVitals.subscribePower,
            logs: createLogRetentionOwner({ happyHomeDir: home,
              currentLogPaths: async () => [logger.logFilePath, ...await readManagedServiceCurrentLogPaths()],
              onError: error => logger.warn('[DAEMON RUN] Storage log retention failed', error) }),
            recordings: {
              nextExpiryAtMs: () => storageRecordings?.service.nextExpiryAtMs() ?? null,
              listStorageRecordings: () => storageRecordings?.service.listStorageRecordings() ?? [],
              cleanupExpiredRecordings: async ({ beforeEffect, ...request }) => storageRecordings?.routes.cleanupExpiredRecordings(request, { beforeEffect })
                ?? { discardedRecordingIds: [], failedRecordingIds: [] },
              subscribeStorageChanges: subscribeStorageRecordings,
            },
            activityLog: currentGuard.activityLog, actorAccountId: target.custodianAccountId,
            onError: error => logger.warn('[DAEMON RUN] Storage maintenance failed', error),
          },
          catalog: {
            happyHomeDir: home, activeServerDir, installDir: projectPath(),
            ...(hostBootedAt !== undefined ? { bootedAt: hostBootedAt } : {}),
            managedSessionDirectories: createManagedSessionDirectories({ activeServerDir }),
            worktreeOperations: createStorageWorktreeOperations({ happyHomeDir: home }),
            checkoutReferences: createProjectWorkspaceRetirement({ authority: { credentials: capturedCredentials, serverId: target.serverId },
              serverId: target.serverId, machineId: target.machineId,
              assertCurrentAuthority: async () => {
                const current = machineResourceTarget();
                if (credentials !== capturedCredentials || !current || current.serverId !== target.serverId
                  || current.machineId !== target.machineId || current.installationId !== target.installationId
                  || current.custodianAccountId !== target.custodianAccountId)
                  throw Object.assign(new Error('Storage reference authority changed'), { code: 'unauthorized' });
              } }),
            readProjects, readTrackedSessions,
            readAcpCatalog: () => getActiveAccountSettingsSnapshot()?.scopeKey === resolveAccountSettingsScopeKey(capturedCredentials)
              ? readActiveAcpCatalog() : undefined,
            acpAccountId: target.custodianAccountId,
            isAcpDefinitionInUse: definitionId => isAgentInstallTargetInUse({ agentId: 'custom-acp', definitionId }, pidToTrackedSession.values()),
            readPolicy: () => {
              const snapshot = machineResourcesPolicy?.read();
              return snapshot?.status === 'ready' ? snapshot.policy.storage : defaultStoragePolicy;
            },
            readWorktrees: async () => {
              const facts = readProjects();
              return readStorageWorktrees({ happyHomeDir: home,
                cwds: [...(facts.projects ?? []).map(project => project.repositoryRoot),
                  ...readTrackedSessions().map(session => session.cwd)] });
            },
            readModelPacks: async () => storageModelPacks?.list() ?? [],
            readRecordings: async () => storageRecordings?.service.listStorageRecordings() ?? [],
            readModelPackRuntime: () => storageModelPacks,
            readRecordingRuntime: () => storageRecordings?.service ?? null,
            readSessionDraftPresence: async sessionId => {
              const tracked = [...pidToTrackedSession.values()].find(session => session.happySessionId === sessionId);
              if (!tracked) return { status: 'unknown' as const };
              try {
                return await withGuardAccess(tracked, guardAccess => withTrackedSessionRpc(guardAccess, async (_rpc, access) => readSessionDraftPresence({
                  sessionId, requester: { token: access.credentials.token, serverHttpBaseUrl: access.serverHttpBaseUrl,
                    isCurrent: access.isCurrent },
                }))) ?? { status: 'unknown' as const };
              } catch { return { status: 'unknown' as const }; }
            },
            readTemporaryFacts: async () => (await Promise.all([
              readStorageComposerMediaStageFacts({ activeServerDir }), readStorageSessionHandoffFacts({ activeServerDir }),
            ])).flat(),
            readLiveRunnerSnapshotPaths: () => {
              const live = resolveLiveRunnerSnapshotFingerprints(pidToTrackedSession.values());
              return { reliable: live.reliable, paths: new Set([...live.fingerprints].map(fingerprint => join(home, '.runner-snapshots', fingerprint))) };
            },
            readLiveSkillCachePaths: skillStore.readLiveSkillCachePaths,
            readInUsePaths: async () => {
              const [owners, residentModels] = await Promise.all([
                timeWebLatencyPhase('storage.facts.process-census', () => processOwnershipRuntime.readOwners({ freshness: 'shared' })),
                timeWebLatencyPhase('storage.facts.resident-models', () => readResidentVoiceModelPackPaths({ worker: voiceInferenceWorker, modelPacks: storageModelPacks,
                  packsRootDir: join(activeServerDir, 'voiceInference', 'packs') })),
              ]);
              const paths = [projectPath(), process.execPath, ...readTrackedSessions().map(session => session.cwd),
                ...getSharedTerminalProcessRegistry().listProcesses().map(terminal => terminal.workspacePath), ...residentModels.paths];
              for (const tracked of pidToTrackedSession.values()) {
                const launch = tracked.runnerAgentInvocationContext?.agentCliLaunch?.spec;
                if (launch) paths.push(launch.resolvedPath, launch.command, ...launch.args.filter(arg => isAbsolute(arg)));
              }
              if (owners.status !== 'ok') return { reliable: false, paths };
              const sessions: { path: string; sessionId: string }[] = [];
              for (const owner of owners.rows) {
                if (owner.level === 'not_happier') continue;
                const row = owners.snapshot.rows.find(row => row.pid === owner.pid);
                const heldPaths = [owner.workspacePath, row?.cwd, row?.executablePath,
                  ...(row?.argv ?? []).filter(arg => isAbsolute(arg))].filter((path): path is string => !!path);
                paths.push(...heldPaths);
                // Ownership already selected the canonical live root; storage only projects its session binding.
                const ownerSessionId = owner.owner?.kind === 'session' && !owner.ownerEnded ? owner.owner.sessionId : undefined;
                const root = owners.roots.find(root => root.live && root.owner.kind === 'session' && root.owner.sessionId === ownerSessionId);
                if (root?.owner.kind === 'session') {
                  for (const path of heldPaths) sessions.push({ path, sessionId: root.owner.sessionId });
                }
              }
              const unresolvedRetainedRoots = [...pidToTrackedSession.values()].some(tracked =>
                tracked.runnerManagedDependencyRetentionV1?.sourceCustodies.some(source => source.kind === 'managed'));
              return { reliable: residentModels.reliable && !owners.snapshot.partial?.length && !owners.rows.some(owner => owner.level === 'unknown')
                && !unresolvedRetainedRoots, paths, sessions };
            },
            currentLogPaths: async () => [logger.logFilePath, ...await readManagedServiceCurrentLogPaths()],
          },
          readVolumes: storageVitals.readVolumes,
          readVolumesReported: storageVitals.readVolumesReported,
          subscribeVolumeChanges: storageVitals.subscribeVolumeChanges,
          subscribeChanges: (listener: () => void) => {
            const cleanup = [storageVitals.subscribeVolumes(listener), subscribeStorageRecordings(listener), sessionLiveWorkProducer.subscribe(listener), executionRunActivity.subscribe(listener), transferActivity.subscribe(listener),
              projectRows.subscribeActiveProjectAccountRowsSnapshot(listener), machineResourcesPolicy?.subscribe(listener)];
            return () => {
              for (const unsubscribe of cleanup) unsubscribe?.();
            };
          },
        };
      },
    });
    machineRpcRouteAttachments.attachStorageRoutes(storageRoutes);
    const storageTarget = machineResourceTarget();
    if (storageTarget) await storageRoutes.getService(storageTarget);
    connectedAccountPurposeBindingRuntime.bindSessionRestartOwner(({ sessionId, purpose, target }) => {
      const tracked = Array.from(pidToTrackedSession.values())
        .find((candidate) => candidate.happySessionId === sessionId);
      if (!tracked) {
        logger.debug('[DAEMON RUN] Connected Account purpose changed without a live session runner', {
          sessionId,
          purpose: purpose.purpose,
        });
        return;
      }
      void requestConnectedServiceRefreshRestartSignal({
        pid: tracked.pid,
        delayMs: 0,
        preferProcessGroup: tracked.startedBy === 'daemon',
        restartDiagnostic: {
          trigger: 'reconnect_propagation',
          sessionId,
          reason: `connected_account_purpose_changed:${purpose.purpose}`,
          ...target,
        },
        onSignalFailure: (error) => {
          logger.debug('[DAEMON RUN] Failed to request Connected Account purpose restart', error);
        },
      }).catch((error) => {
        logger.debug('[DAEMON RUN] Connected Account purpose restart owner failed', error);
      });
    });
    const reconcileConnectedServicesProjectionForPluginConsumers = async (
      notification: Parameters<typeof reconcileConnectedServicesProjection>[0],
    ): Promise<void> => {
      notification.signal.throwIfAborted();
      await reconcileProjectionAndInvalidateConnectedAccounts({
        notification,
        reconcile: reconcileConnectedServicesProjection,
        invalidateConfiguredExternalSessionSources: () => {
          notifyActiveAccountConnectedServicesProjection(
            resolveAccountSettingsScopeKey(credentials),
            notification.connectedServiceRefs,
          );
        },
        invalidateConnectedAccounts: () => {
          connectedAccountPurposeBindingRuntime.invalidate({
            ...(notification.connectedServiceRefs ? { services: notification.connectedServiceRefs } : {}),
            ...(notification.quotaRefreshOnly ? { quotaRefreshOnly: true } : {}),
            ...(notification.quotaRefreshRecordIds
              ? { quotaRefreshRecordIds: notification.quotaRefreshRecordIds } : {}),
            ...(['startup', 'reconnect', 'cursor-gone'].includes(notification.source)
              ? { resetQuotaSchedule: true } : {}),
          });
        },
      });
    };
    refreshBrowserRouteOwners = refreshBrowserRouteOwnersFromSessionControl;
    void refreshServerFeaturesAndBrowserRouteOwners();
    const filesystemAccessPolicy = resolveFilesystemAccessPolicy({ env: process.env });
    const connectedServiceQuotaFetcherDescriptors = await resolveMergedContributionRegistry({
      happyHomeDir: configuration.happyHomeDir,
    })
      .then((registry) => resolveConnectedServiceQuotaFetcherDescriptors(registry))
      .catch((error) => {
        logger.debug('[DAEMON RUN] Failed to resolve connected-service quota fetcher contributions; continuing without provider quota fetchers', error);
        return [];
      });
    const resolveConnectedAccountUsageIdentity: NonNullable<Parameters<typeof startDaemonRuntimeBootstrap>[0]['resolveConnectedAccountUsageIdentity']> = async (service) => {
        const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
          happyHomeDir: configuration.happyHomeDir, controller: pluginReloadController,
        });
        try {
          return lease.registry.contributes.connectedAccountDescriptorsById
            .get(buildQualifiedPluginContributionKey(service))?.definition.usageIdentity ?? null;
        } finally { await lease.release(); }
    };
    const nativeAccountRefresh = await captureNativePublicProfileRefresh({
        credentials, serverId: configuration.activeServerId, serverHttpBaseUrl: resolveServerHttpBaseUrl(),
        signal: homeTransportCancellation.signal,
        resolveServerFeaturesSnapshot: () => serverFeaturesSnapshotStore.getSnapshot(),
        onError: error => logger.debug('[DAEMON RUN] Public-profile refresh deferred', serializeAxiosErrorForLog(error)),
      });
    const runtimeBootstrap = await startDaemonRuntimeBootstrap({
      publicProfileRefresh: nativeAccountRefresh,
      artifactQueryHints: { signal: nativeAccountRefresh.signal, isCurrent: nativeAccountRefresh.isCurrent,
        resolveServerFeaturesSnapshot: () => serverFeaturesSnapshotStore.getSnapshot() },
      api,
      credentials,
      daemonSessionMutationCustody,
      logger,
      processEnv: process.env,
      controlPort,
      machineId,
      machineIdProvider: () => machineId,
      runtimeId,
      cliVersion: packageJson.version,
      startupSource,
      serviceLabel,
      daemonLogPath: logger.logFilePath,
      controlToken,
      publishDaemonState: publishDaemonStateForCurrentOwner,
      happyHomeDir: configuration.happyHomeDir,
      activeServerDir: configuration.activeServerDir,
      filesystemAccessPolicy,
      publicReleaseChannel,
      admissionDrain,
      isDaemonQuiescing: admissionDrain.isPublicationQuiescing,
      connectedServicesRestartRequestedPids,
      pidToTrackedSession,
      qualifiedConnectedAccountEstablishedRuntimeOwner:
        establishedConnectedAccountRuntimeOwner,
      resolveConnectedAccountUsageIdentity,
      listScheduledQualifiedConnectedAccounts:
        service => connectedAccountPurposeBindingRuntime.listCoordinatorAccounts(undefined, service),
      subscribeConnectedAccountInvalidations:
        connectedAccountPurposeBindingRuntime.subscribeInvalidations,
      listQualifiedConnectedAccountGroupQuotaTargets:
        connectedAccountPurposeBindingRuntime.listGroupQuotaTargets,
      resolveConnectedServiceQualifiedPurposeBindingSnapshot: async ({
        agentId,
        connectedServicesBindingsRaw,
      }) => {
        const bindings = ConnectedServiceBindingsV2IngressSchema.safeParse(
          connectedServicesBindingsRaw,
        );
        if (!bindings.success) return null;
        const lease =
          await acquireAuthoritativePluginRuntimeRegistryLease({
            happyHomeDir: configuration.happyHomeDir,
          });
        try {
          return resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
            agentId,
            bindings: bindings.data,
            contributions: lease.registry.contributes,
            catalogEntry: await lease.registry.acquireAgentCatalogEntry?.(agentId),
          });
        } finally {
          await lease.release();
        }
      },
      activatePurposeBindings:
        connectedAccountPurposeBindingRuntime.activatePurposeBindings,
      onQualifiedConnectedAccountCredentialUpdated: (account) => {
        connectedAccountPurposeBindingRuntime.invalidate({ services: [account.service] });
      },
      resolveQualifiedConnectedAccountV4Support: () =>
        resolveQualifiedConnectedAccountAtomicV4Negotiation(
          serverFeaturesSnapshotStore.getSnapshot(),
        ),
      resolveQualifiedConnectedAccountPeerClass: () =>
        resolveQualifiedConnectedAccountPeerClass(
          serverFeaturesSnapshotStore.getSnapshot(),
          apiMachineForSessions
            ?.getSessionSyncPendingInputServerContractResult()
            ?? null,
        ),
      resolveQualifiedConnectedAccountPeerOperationTransport: ({
        service,
        operation,
      }) =>
        resolveQualifiedConnectedAccountPeerOperationTransport({
          snapshot: serverFeaturesSnapshotStore.getSnapshot(),
          serverContract:
            apiMachineForSessions
              ?.getSessionSyncPendingInputServerContractResult()
            ?? null,
          service,
          operation,
        }),
      stopSession,
      connectedServiceRuntimeRegistry: ownedConnectedServiceRuntimeRegistry,
      // K2: FSM-routed proactive quota coordinator (built by the session-control runtime).
      connectedServiceAuthGroupPreTurnSwitchCoordinator,
      connectedServicePredictiveSwitchGuard,
      consumeCommittedAuthGroupGeneration,
      // K2: shared single runtime quota-snapshot store (proactive selection + quotas coordinator).
      connectedServiceRuntimeQuotaSnapshots,
      // Canonical provider-account usage source of truth for quota switching/fanout policy.
      providerAccountUsageStore,
      connectedServiceQuotaFetcherDescriptors,
    });
    const {
      fileState,
      initialDaemonState,
      directPeerServerLifecycle,
      transferLiveWorkProducer,
      directTransferRegistryHost,
      transferRuntimeStatePublisher,
      stopDirectPeerServer,
      stopTailscaleTransferServeLifecycle,
    } = runtimeBootstrap;
    transferActivityOwner = transferLiveWorkProducer;
    transferActivity.notifyChanged();
    resumeQuiescedTransferStatePublication = async () => {
      await transferRuntimeStatePublisher?.resume();
    };
    connectedServiceRefreshCoordinator = runtimeBootstrap.connectedServiceRefreshCoordinator;
    connectedServiceRefreshLoopHandle = runtimeBootstrap.connectedServiceRefreshLoopHandle;
    connectedServiceQuotasCoordinator = runtimeBootstrap.connectedServiceQuotasCoordinator;
    connectedServiceQuotasLoopHandle = runtimeBootstrap.connectedServiceQuotasLoopHandle;
    publicProfileRefreshHandle = runtimeBootstrap.publicProfileRefreshHandle;
    createRequesterRuntime = async (bootstrap, signal, options) => {
      if (bootstrap.serverHttpBaseUrl !== readRequesterRuntimeServerHttpBaseUrl()
        || !requesterMachineAdmissionBoundary(bootstrap.attribution).isHomeCurrent()) return null;
      if (options?.bootstrapOwnership !== 'borrowed') bindRequesterSessionRuntimeMachineAdmissionCurrentness({
        bootstrap, boundary: requesterMachineAdmissionBoundary(bootstrap.attribution),
      });
      return await createRequesterSessionRuntimeContext({ bootstrap, signal, ...options,
        providerAccountUsageStore: resolveProviderAccountUsageStore(bootstrap.attribution),
        activeServerDir: configuration.activeServerDir, connectedServicesMaterializationBaseDir,
        resolveQualifiedConnectedAccountV4Support: () => resolveQualifiedConnectedAccountAtomicV4Negotiation(serverFeaturesSnapshotStore.getSnapshot()),
        coordinatorInput: {
          machineId, machineIdProvider: () => machineId, runtimeId, happyHomeDir: configuration.happyHomeDir,
          logger, processEnv: process.env, pidToTrackedSession, connectedServiceRuntimeRegistry,
          connectedServiceAuthGroupPreTurnSwitchCoordinator, connectedServicePredictiveSwitchGuard,
          consumeCommittedAuthGroupGeneration, connectedServiceQuotaFetcherDescriptors,
          resolveConnectedAccountUsageIdentity,
          resolveQualifiedConnectedAccountPeerClass: () => resolveQualifiedConnectedAccountPeerClass(
            serverFeaturesSnapshotStore.getSnapshot(), apiMachineForSessions?.getSessionSyncPendingInputServerContractResult() ?? null),
          resolveQualifiedConnectedAccountPeerOperationTransport: ({ service, operation }) => resolveQualifiedConnectedAccountPeerOperationTransport({
            snapshot: serverFeaturesSnapshotStore.getSnapshot(), serverContract: apiMachineForSessions?.getSessionSyncPendingInputServerContractResult() ?? null,
            service, operation,
          }),
          resolveConnectedServiceQualifiedPurposeBindingSnapshot: async ({ agentId, connectedServicesBindingsRaw }) => {
            const bindings = ConnectedServiceBindingsV2IngressSchema.safeParse(connectedServicesBindingsRaw);
            if (!bindings.success) return null;
            const lease = await acquireAuthoritativePluginRuntimeRegistryLease({ happyHomeDir: configuration.happyHomeDir });
            try { return resolveQualifiedPurposeBindingSnapshotForAgentSpawn({ agentId, bindings: bindings.data,
              contributions: lease.registry.contributes,
              catalogEntry: await lease.registry.acquireAgentCatalogEntry?.(agentId) }); }
            finally { await lease.release(); }
          },
        },
      });
    };
    daemonServerWorkScheduler = runtimeBootstrap.daemonServerWorkScheduler;
    const machineRegistrationRuntime = startDaemonMachineRegistrationRuntime({
      api,
      credentials,
      metadataForRegistration,
      initialDaemonState,
      processEnv: process.env,
      resolvePositiveIntEnv,
      resolvesWhenShutdownRequested,
      initialPreflightMachineRegistration: preflightMachineRegistration,
      resolveMachineId: () => machineId,
      setMachineId: (resolvedMachineId) => {
        if (admissionDrain.isPublicationQuiescing()) return;
        if (fileState.machineId === resolvedMachineId) {
          machineId = resolvedMachineId;
          return;
        }
        const nextFileState = {
          ...fileState,
          machineId: resolvedMachineId,
        };
        if (!publishDaemonStateForCurrentOwner(nextFileState)) {
          requestShutdown(
            'exception',
            'daemon_state_publication_ownership_lost',
          );
          return;
        }
        fileState.machineId = resolvedMachineId;
        machineId = resolvedMachineId;
      },
      isShuttingDown: admissionDrain.isFinalShutdown,
      isQuiescing: admissionDrain.isPublicationQuiescing,
      bootstrapRuntime: machineBootstrapRuntime = createDaemonMachineBootstrapRuntime({
        onMachineControlReadinessChange: machineControlReady => {
          if (admissionDrain.isPublicationQuiescing()) return;
          // Registration may finish before bootstrap begins reading status.
          // Publish through the existing lock owner at the transition, not the heartbeat.
          if (!publishDaemonStateForCurrentOwner({ ...daemonStateOwner!, machineControlReady })) {
            requestShutdown('exception', 'daemon_state_publication_ownership_lost');
            return;
          }
          fileState.machineControlReady = machineControlReady;
        },
        secretSources: daemonSecretSources,
agentIsolation,

        api,
        controlPort,
        credentials,
        requesterServerId: requesterRuntimeServerId,
        resolveCurrentServerIdentityId: resolveBoundHomeServerIdentityId,
        resolveCurrentMachineExecutionOriginContext,
        resolveRequesterSessionRuntimeContext,
        resolveExecutionRunLiveBrokerAuthority,
        onActivationRejected: async event => { await guardSessionRestoration?.onActivationRejected(event); },
        readRequesterSessionCredentialBindings: async () => {
          const installation = readInstallationIdentityIfExistsSync();
          if (!installation || configuration.activeServerId !== requesterRuntimeServerId) {
            return { status: 'unavailable', reason: 'requester_session_custody_unavailable' };
          }
          return await listRequesterSessionCredentialBindings({ happyHomeDir: configuration.happyHomeDir,
            serverId: requesterRuntimeServerId, machineId, installationId: installation.installationId });
        },
        releaseRequesterSessionRuntimeContext,
        dispatchSessionFollowOccurrence,
        stopRequesterSessionForHandoff,
        daemonSessionMutationCustody,
        deviceLocalSecretStorage,
        ...(openRunAccountConnectionSource ? { openAccountConnectionManagedConsumerSource: openRunAccountConnectionSource } : {}),
        ...(openTeamCredentialProviderBinding
          ? {
              prepareRunTeamCredentialProviderBinding: async (request) => {
                const selection = request.selection;
                if (!selection) return null;
                const currentMachineId = machineId;
                if (!request.machineId || request.machineId !== currentMachineId) {
                  throw new Error('team_credential_provider_machine_not_current');
                }
                const lifetime = new AbortController();
                const opened = await openTeamCredentialProviderBinding({
                  teamId: selection.teamId,
                  resourceId: selection.resourceId,
                  expectedResourceRevision: selection.expectedResourceRevision,
                  deliveryMode: selection.deliveryMode,
                  agentId: request.agentId,
                  agentTargetKey: selection.agentTargetKey,
                  modelId: selection.modelId,
                  consumer: { kind: 'execution_run', executionRunId: request.runId },
                  signal: lifetime.signal,
                });
                let closed = false;
                return Object.freeze({
                  ...opened,
                  async cleanup() {
                    if (closed) return;
                    closed = true;
                    lifetime.abort();
                    await opened.cleanup();
                  },
                });
              },
            }
          : {}),
        ...(homeDomainAction
          ? {
              startProviderBrokerApplication: async ({
                machineId: registeredMachineId,
                apiMachine: brokerApiMachine,
              }) => {
                const readResource = async (
                  resourceId: string,
                  signal: AbortSignal,
                ): Promise<TeamCredentialResourceSummaryV1 | null> =>
                  await readTeamCredentialBrokerResource(api, resourceId, signal);
                // The broker serves its own source, so its catalog is that
                // source's canonical current projection — not the recipient
                // catalog, which would require the custodian to be an audience
                // member of the resource it offers to others. The Home decides
                // the requester's entitlement per request; request policy is
                // intersected by the broker's request-policy owner.
                const resolveCatalog = async (input: Readonly<{
                  resource: TeamCredentialResourceSummaryV1;
                  application: ProviderBrokerApplicationBindingV1;
                  signal: AbortSignal;
                }>) => {
                  const producer = providerOperationsProducer;
                  const source = input.resource.source;
                  if (!producer || !source) return null;
                  return await resolveTeamCredentialSourceModelCatalog({
                    machineId: registeredMachineId,
                    teamId: input.resource.teamId,
                    resourceId: input.resource.id,
                    resourceRevision: input.resource.revision,
                    source,
                    application: input.application,
                    projectModels: async (projectionRequest) =>
                      await producer.machineServices.projectModels(projectionRequest),
                    signal: input.signal,
                  });
                };
                const brokerManagedProviderCustody = createManagedProviderExplicitStartCustody({
                  machineId: registeredMachineId,
                  happyHomeDir: configuration.happyHomeDir,
                  controller: pluginReloadController,
                });
                const withBrokerProviderRegistry: import('@/providers/broker/providerConnectionSource').ProviderConnectionRegistryReader = async (read) => {
                  const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
                    happyHomeDir: configuration.happyHomeDir,
                    controller: pluginReloadController,
                  });
                  try {
                    return await read(resolveProviderContributionRegistryView(
                      lease.registry.contributes,
                      lease.durableRevision,
                      lease.registry.readPluginOccurrenceId,
                    ));
                  } finally {
                    await lease.release();
                  }
                };
                const sourceOwner = createTeamCredentialBrokerSourceOwner({
                  machineId: registeredMachineId,
                  custody: brokerManagedProviderCustody,
                  selectConnectedServicesSourceMember: createConnectedServicesBrokerSourceMemberSelect({
                    withRegistry: withBrokerProviderRegistry,
                    resolveBindingIntentSelection: connectedAccountPurposeBindingRuntime.resolveBindingIntentSelection,
                  }),
                  openConnectedServicesSource: createConnectedServicesBrokerSourceOpen({
                    withRegistry: withBrokerProviderRegistry,
                    readResource,
                    resolveBindingIntentSelection: connectedAccountPurposeBindingRuntime.resolveBindingIntentSelection,
                    custody: brokerManagedProviderCustody,
                  }),
                  openProviderConnectionSource: createProviderConnectionBrokerSourceOpen({
                    machineId: registeredMachineId,
                    readResource: async (resourceId, signal) => {
                      const resource = await readResource(resourceId, signal);
                      return resource?.source && resource.brokerPlacement
                        ? {
                            teamId: resource.teamId,
                            source: resource.source,
                            brokerPlacement: resource.brokerPlacement,
                            revision: resource.revision,
                            enabled: resource.enabled,
                          }
                        : null;
                    },
                    withRegistry: withBrokerProviderRegistry,
                    getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
                    collectDnsEvidence: async ({ source, registry, signal }) => {
                      const snapshot = getActiveAccountSettingsSnapshot();
                      if (!snapshot) return new Map();
                      return await collectProviderConnectionDnsEvidence({
                        connectionId: source.connectionId,
                        machineId: registeredMachineId,
                        providerSettings: readProviderSettingsForCli(snapshot).settings,
                        registry,
                        lifetime: createProviderOperationLifetime({
                          signal,
                          wallTimeMs: PROVIDER_ENDPOINT_SAFETY_LIMITS.maxWallTimeMs,
                        }),
                      });
                    },
                    openCpxProviderConnection: createProviderConnectionCpxBridge({
                      custody: brokerManagedProviderCustody,
                    }).open,
                    resolveExactSelection: async (request) => await (
                      providerOperationsProducer?.machineServices
                        .resolveTeamCredentialBrokerSourceSelection(request)
                      ?? Promise.resolve(null)
                    ),
                  }),
                });
                const authorizeExternalAuthorization = async (input: Readonly<{
                  binding: Extract<ProviderBrokerRelayApplicationBindingV1, { kind: 'external_api_key' }>;
                  expectedResourceRevision: number;
                  application: ProviderBrokerApplicationBindingV1;
                  signal?: AbortSignal;
                }>) => await api.authorizeTeamCredentialProviderModelCatalog({
                  v: 1,
                  binding: input.binding,
                  brokerMachineId: registeredMachineId,
                  expectedResourceRevision: input.expectedResourceRevision,
                  application: input.application,
                }, input.signal ? { signal: input.signal } : undefined);
                const runtimeInput: Parameters<typeof startDaemonProviderBrokerRuntimeWithCustody>[0]['runtime'] = {
                  machineId: registeredMachineId,
                  ...(managedPolicyHomeId && externalActionAccountId ? {
                    accountConnection: {
                      homeId: managedPolicyHomeId,
                      accountId: externalActionAccountId,
                      retire: async ({ authority }) => await retireAccountConnectionBrokerSource({
                        homeId: managedPolicyHomeId, accountId: externalActionAccountId, machineId: registeredMachineId,
                        custody: brokerManagedProviderCustody, authority,
                      }),
                      open: createAccountConnectionBrokerSourceOpen({
                        homeId: managedPolicyHomeId,
                        accountId: externalActionAccountId,
                        machineId: registeredMachineId,
                        expectedAccountSettingsScopeKey: resolveAccountSettingsScopeKey(credentials),
                        custody: brokerManagedProviderCustody,
                        withRegistry: withBrokerProviderRegistry,
                        getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
                        resolveBindingIntent: connectedAccountPurposeBindingRuntime.resolveBindingIntent,
                        projectModels: async request => {
                          const producer = providerOperationsProducer;
                          if (!producer) throw new Error('provider_source_projection_unavailable');
                          return await producer.machineServices.projectModels(request);
                        },
                        admitConsumer: async (authority, signal) => revalidateExternalProviderBrokerAuthorization(
                          await api.admitAccountConnectionProviderBroker({ v: 2, authority }, { signal }),
                        ),
                      }),
                    },
                  } : {}),
                  resolveTrustRoots: resolvePeerMediationTrustRoots,
                  nowMs: () => Date.now(),
                  createRequestId: randomUUID,
                  sourceOwner,
                  checkRunnerCredentialSelectionCurrentness: async ({ selection, modelId, signal }) => {
                    const resolveEligibility = providerOperationsProducer?.machineServices
                      .resolveTeamCredentialBrokerEligibility;
                    if (!resolveEligibility) return 'update_required';
                    return await resolveRunnerCredentialSelectionCurrentness({
                      registeredMachineId,
                      selection,
                      modelId,
                      signal,
                      readResource,
                      resolveEligibility: async (request, currentnessSignal) =>
                        await resolveEligibility(request, currentnessSignal),
                    });
                  },
                  resolveRequestPolicy: async ({ authority, request }) => {
                    const signal = request.signal ?? new AbortController().signal;
                    const resource = await readResource(authority.resourceId, signal);
                    if (
                      !teamCredentialBrokerResourceAcceptsMachine(resource, registeredMachineId)
                      || resource.teamId !== authority.teamId
                    ) return null;
                    const catalog = await resolveCatalog({
                      resource,
                      application: authority.application,
                      signal,
                    }).catch(() => null);
                    return catalog
                      ? {
                          resourceRevision: resource.revision,
                          sourceRevision: catalog.sourceRevision,
                          application: catalog.application,
                          policy: resource.requestPolicy,
                          source: resource.source,
                          modelCatalog: {
                            models: catalog.rows.map((row) => ({
                              id: row.descriptor.id,
                              ...(row.descriptor.name === undefined ? {} : { name: row.descriptor.name }),
                            })),
                            resolveCanonicalModelId: catalog.resolveCanonicalModelId,
                          },
                        }
                      : null;
                  },
                  admitRequest: async (request) => await api.admitTeamCredentialProviderBrokerRequest({
                    v: 1,
                    authority: request.authority,
                    expectedResourceRevision: request.expectedResourceRevision,
                    sourceMemberKey: request.sourceMemberKey,
                    requestId: request.requestId,
                    requestFacts: request.requestFacts,
                  }, { signal: request.request.signal }),
                  authorizeModelCatalog: async ({ authorization, expectedResourceRevision, request }) => {
                    if (authorization.kind === 'resource_test') {
                      return { ok: false as const, reasonCode: 'resource_unavailable' as const };
                    }
                    return authorization.kind === 'private'
                      ? await api.authorizeTeamCredentialProviderModelCatalog({
                            v: 1,
                            authority: authorization.authority,
                            expectedResourceRevision,
                          }, { signal: request.signal })
                      : await authorizeExternalAuthorization({
                          binding: authorization.binding,
                          expectedResourceRevision,
                          application: authorization.application,
                          ...(request.signal ? { signal: request.signal } : {}),
                        });
                  },
                  resolveExternalRequestPolicy: async ({ binding, request }) => {
                    const signal = request.signal ?? new AbortController().signal;
                    const resource = await readResource(binding.resourceId, signal);
                    const route = classifyTeamCredentialRequestRouteV1(request.pathAndQuery);
                    const protocol = route?.kind === 'openai_responses'
                      ? 'openai-responses'
                      : route?.kind === 'openai_chat_completions'
                        ? 'openai-chat'
                        : route?.kind === 'anthropic_messages' ? 'anthropic' : null;
                    if (
                      !teamCredentialBrokerResourceAcceptsMachine(resource, registeredMachineId)
                      || resource.teamId !== binding.teamId
                    ) return null;
                    const source = resource.source;
                    const producer = providerOperationsProducer;
                    if (!producer) return null;
                    const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
                      happyHomeDir: configuration.happyHomeDir,
                      controller: pluginReloadController,
                    });
                    let agentTargetKeys: string[];
                    try {
                      agentTargetKeys = [...lease.registry.contributes.agentDefinitionsById.values()]
                        .flatMap((agent) => agent.identity
                          ? listAgentExecutionTargetsV1(agent.identity).map(buildBackendTargetKeyV2)
                          : []);
                    } finally {
                      await lease.release();
                    }
                    const applications = await resolveTeamCredentialResourceCatalogApplications({
                      machineId: registeredMachineId,
                      teamId: resource.teamId,
                      resourceId: resource.id,
                      expectedResourceRevision: resource.revision,
                      source,
                      agentTargetKeys,
                      projectModels: async (projectionRequest) =>
                        await producer.machineServices.projectModels(projectionRequest),
                      signal,
                    }).catch(() => []);
                    if (request.method === 'GET' && request.pathAndQuery === '/v1/models') {
                      const resolvedCatalogs = await Promise.all(applications.map(async (candidate) =>
                        await resolveCatalog({ resource, application: candidate, signal }).catch(() => null)));
                      if (resolvedCatalogs.some((catalog) => catalog === null)) {
                        return { kind: 'denied' as const, reasonCode: 'resource_unavailable' as const };
                      }
                      const catalogs = resolvedCatalogs.filter(
                        (catalog): catalog is TeamCredentialModelCatalogResolver => catalog !== null,
                      );
                      const catalog = createTeamCredentialExternalModelCatalog(catalogs);
                      return catalog
                        ? {
                            kind: 'model_catalog' as const,
                            resourceRevision: resource.revision,
                            policy: resource.requestPolicy,
                            applications: catalog.applications,
                            modelCatalog: {
                              models: catalog.models,
                              resolveCanonicalModelId: catalog.resolveCanonicalModelId,
                            },
                          }
                        : null;
                    }
                    if (!protocol) return { kind: 'denied' as const, reasonCode: 'route_not_allowed' as const };
                    const protocolApplications = applications.filter((candidate) => candidate.protocol === protocol);
                    if (protocolApplications.length === 0) {
                      return { kind: 'denied' as const, reasonCode: 'route_not_allowed' as const };
                    }
                    const policy = resource.requestPolicy ?? {
                      allowedProtocolKinds: null,
                      allowedModelIds: null,
                      reasoningEffort: null,
                    };
                    const evaluatedCatalogs: TeamCredentialModelCatalogResolver[] = [];
                    let firstFailure: Extract<
                      ReturnType<typeof evaluateTeamCredentialRequestPolicyV1>,
                      { ok: false }
                    > | null = null;
                    for (const application of protocolApplications) {
                      const catalog = await resolveCatalog({ resource, application, signal }).catch(() => null);
                      if (!catalog) {
                        return { kind: 'denied' as const, reasonCode: 'resource_unavailable' as const };
                      }
                      const evaluated = evaluateTeamCredentialRequestPolicyV1({
                        policy,
                        request,
                        resolveCanonicalModelId: catalog.resolveCanonicalModelId,
                      });
                      if (evaluated.ok) evaluatedCatalogs.push(catalog);
                      else if (!firstFailure) firstFailure = evaluated;
                    }
                    if (evaluatedCatalogs.length === 0) {
                      return {
                        kind: 'denied' as const,
                        reasonCode: firstFailure?.reasonCode ?? 'resource_unavailable' as const,
                      };
                    }
                    if (evaluatedCatalogs.length !== 1) {
                      return { kind: 'denied' as const, reasonCode: 'route_not_allowed' as const };
                    }
                    const catalog = evaluatedCatalogs[0]!;
                    return {
                          kind: 'application' as const,
                          resourceRevision: resource.revision,
                          policy: resource.requestPolicy,
                          application: catalog.application,
                          modelCatalog: {
                            models: catalog.rows.map((row) => ({
                              id: row.descriptor.id,
                              ...(row.descriptor.name === undefined ? {} : { name: row.descriptor.name }),
                            })),
                            resolveCanonicalModelId: catalog.resolveCanonicalModelId,
                          },
                        };
                  },
                  admitExternalRequest: async (request) => await api.admitTeamCredentialExternalProviderRequest({
                    v: 1,
                    binding: request.binding,
                    brokerMachineId: registeredMachineId,
                    expectedResourceRevision: request.expectedResourceRevision,
                    application: request.application,
                    requestFacts: request.requestFacts,
                  }, { signal: request.request.signal }),
                  revalidateExternalAuthorization: async (request) => (
                    revalidateExternalProviderBrokerAuthorization(
                      await authorizeExternalAuthorization(request),
                    )
                  ),
                  retireExternalApiKey: async ({ externalApiKeyId, operationId, application }) =>
                    await brokerManagedProviderCustody.retireExternalApiKey({
                      identity: application.implementationIdentity,
                      externalApiKeyId,
                      operationId,
                    }),
                  retireExternalOperation: async ({ externalApiKeyId, operationId, brokerMachineId }) => {
                    if (brokerMachineId !== registeredMachineId) throw new Error('Broker Machine changed');
                    await brokerApiMachine.retireTeamCredentialExternalProviderOperation({ externalApiKeyId, operationId });
                  },
                  recordExternalTerminalUsage: async (request) =>
                    await api.recordTeamCredentialExternalProviderTerminalUsage(request),
                  resolveResourceTestRequestPolicy: async ({ binding, request }) => {
                    const signal = request.signal ?? new AbortController().signal;
                    const resource = await readResource(binding.resourceId, signal);
                    if (
                      !teamCredentialBrokerResourceAcceptsMachine(resource, registeredMachineId)
                      || resource.teamId !== binding.teamId
                      || resource.revision !== binding.expectedResourceRevision
                      || !pluginJsonValuesEqual(resource.source, binding.source)
                    ) return null;
                    const catalog = await resolveCatalog({
                      resource,
                      application: binding.application,
                      signal,
                    }).catch(() => null);
                    return catalog
                      ? {
                          resourceRevision: resource.revision,
                          policy: resource.requestPolicy,
                          application: binding.application,
                          modelCatalog: {
                            models: catalog.rows.map((row) => ({
                              id: row.descriptor.id,
                              ...(row.descriptor.name === undefined ? {} : { name: row.descriptor.name }),
                            })),
                            resolveCanonicalModelId: catalog.resolveCanonicalModelId,
                          },
                        }
                      : null;
                  },
                  admitResourceTestRequest: async (request) => await api.admitTeamCredentialResourceTestRequest({
                    v: 1,
                    binding: request.binding,
                    brokerMachineId: registeredMachineId,
                    relayAuthorization: request.relayAuthorization,
                    requestFacts: request.requestFacts,
                  }, { signal: request.request.signal }),
                };
                const runtime = await startDaemonProviderBrokerRuntimeWithCustody({
                  runtime: runtimeInput,
                  api,
                  apiMachine: brokerApiMachine,
                  custody: brokerManagedProviderCustody,
                });
                retireProviderBrokerClaimsForFeatureDisable = runtime.retireAllClaims;
                return Object.freeze({
                  ...runtime,
                  async close() {
                    if (retireProviderBrokerClaimsForFeatureDisable === runtime.retireAllClaims) {
                      retireProviderBrokerClaimsForFeatureDisable = null;
                    }
                    await runtime.close();
                  },
                });
              },
            }
          : {}),
        createWorkspaceSyncRuntime: async ({
          machineId: registeredMachineId,
          onReadinessPublished,
          onStatusPublished,
        }) => {
          return await workspaceSyncRuntimeCustody.acquire(registeredMachineId, async () => {
            const finiteServerId = configuration.activeServerId;
            const finiteServerHttpBaseUrl = resolveServerHttpBaseUrl();
            const isCurrent = async () => {
              const refuse = (reason: string) => {
                logger.debug('[ProjectFinite] Installed runtime refused', { reason });
                return false;
              };
              if (admissionDrain.isFinalShutdown()) return refuse('daemon_shutdown');
              if (configuration.activeServerId !== finiteServerId) return refuse('installed_home_changed');
              const stored = await readStoredCredentialsForServerId(finiteServerId).catch(() => null);
              if (!stored) return refuse('stored_credentials_unavailable');
              if (!sameStoredCredentials(credentials, stored)) {
                return refuse(credentials.requesterSessionCredentialScope && !stored.requesterSessionCredentialScope
                  ? 'installed_credentials_scoped_by_requester' : 'installed_credentials_changed');
              }
              return true;
            };
            const policyClient = await createAccountServerMachineFinitePolicyClient({
              machineId: registeredMachineId, credentials, serverHttpBaseUrl: resolveServerHttpBaseUrl(),
              isCredentialCurrent: async () => !admissionDrain.isFinalShutdown(),
            });
            const admission = createProjectWorkerAdmission({ machineId: registeredMachineId,
              readPolicy: policyClient.get, admissionDrain,
              readMemory: () => {
                const sample = machineVitals?.latest();
                if (!sample || machineVitals?.state().state !== 'reporting' || !sample.memory.reported
                  || Date.now() - sample.sampledAt > 2 * sample.intervalMs) return null;
                return { totalBytes: sample.memory.totalBytes, availableBytes: sample.memory.availableBytes };
              },
            });
            projectWorkerAdmission = admission;
            const openMachineCarrierTunnel = machineIrohRuntime && externalActionAccountId
              ? createWorkspaceMachineCarrierTunnelOpen({
                accountId: externalActionAccountId,
                localMachineId: registeredMachineId,
                runtime: machineIrohRuntime,
                resolveTrustRoots: resolvePeerMediationTrustRoots,
                readTargetMachine: async (targetMachineId, signal) => await api.getMachine(targetMachineId, { signal }),
                mintGrant: async (request, signal) => await api.mintPeerMediationRouteGrant(request, { signal }),
              })
              : undefined;
            const runtime = await createProductionDaemonWorkspaceSyncRuntime({
              homeTarget,
              happyHomeDir: configuration.happyHomeDir,
              activeServerDir: configuration.activeServerDir,
              activeServerId: configuration.activeServerId,
              localMachineId: registeredMachineId,
              releaseChannel: configuration.publicReleaseRing,
              credentials,
              isCurrent,
              callWorkspacePrepareBetween: async (descriptor, ingress) => {
                const client = apiMachineForSessions;
                const authorization = ingress.callerInputAuthorization;
                if (!client || !authorization) throw Object.assign(new Error('Workspace source authority is unavailable'), { code: 'peer_unavailable' });
                return await client.callWorkspaceSyncProjectSource({ ...descriptor, credentials, context: ingress,
                  operationId: authorization.binding.requestId,
                  method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN });
              },
              callWorkspaceTargetPhase: async (descriptor, ingress) => {
                const client = apiMachineForSessions;
                const custodianCredentials = await readStoredCredentialsForServerId(finiteServerId).catch(() => null);
                if (!client || !custodianCredentials) throw Object.assign(new Error('Workspace target authority is unavailable'), { code: 'peer_unavailable' });
                return await client.callWorkspaceSyncTargetPhase({ ...descriptor, credentials: custodianCredentials,
                  context: buildActionExecutorContextForRpc({ ...ingress, serverId: finiteServerId }) });
              },
              callWorkspaceSeedExport: async (descriptor, ingress) => {
                const client = apiMachineForSessions;
                const custodianCredentials = await readStoredCredentialsForServerId(finiteServerId).catch(() => null);
                if (!client || !custodianCredentials) throw Object.assign(new Error('Workspace seed authority is unavailable'), { code: 'peer_unavailable' });
                return await client.callWorkspaceSyncSeedExport({ ...descriptor, credentials: custodianCredentials,
                  context: buildActionExecutorContextForRpc({ ...ingress, serverId: finiteServerId }) });
              },
              readProjectWorkerDependencies: (workspaceRefId, relationshipId) => admission.dependencies({ workspaceRefId,
                ...(relationshipId ? { relationshipId } : {}) }),
              onReadinessPublished,
              onStatusPublished,
              ...(openMachineCarrierTunnel ? { openMachineCarrierTunnel } : {}),
              ...(directPeerServerLifecycle
                ? { requestDirectTransferPayloadFile: directPeerServerLifecycle.requestPayloadFile }
                : {}),
            });
            projectWorkerAction = createProjectWorkerAction({ machineId: registeredMachineId,
              serverId: configuration.activeServerId, serverHttpBaseUrl: resolveServerHttpBaseUrl(),
              credentials, ...(externalActionAccountId ? { accountId: externalActionAccountId } : {}),
              admission, workspaceSync: runtime.workspaceSync,
              isFiniteExecutionLive: () => apiMachineForSessions?.isProjectFiniteExecutionLive() === true,
              isServiceExecutionLive: () => isProjectServiceExecutionLive?.() === true });
            const createProjectFiniteRuntime = createInstalledProjectFiniteRuntime({
              api, credentials, externalActionAccountId, finiteServerId, finiteServerHttpBaseUrl,
              registeredMachineId, admission, isCurrent, resolveCurrentMachineExecutionOriginContext,
              nativeIo: createProjectNativeIo({ ownerRemainder }), successHomeDir: configuration.happyHomeDir,
              prepareBetween: (request, signal, context) => runtime.handoffAdapter.prepareBetween(request, signal, context),
              plugins: { secretSources: daemonSecretSources, async resolveProjectNativeAdapter(reference, role) {
                if (!await isCurrent()) return { kind: 'refused', code: 'native_adapter_retired' };
                const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
                  happyHomeDir: configuration.happyHomeDir, controller: pluginReloadController,
                });
                try { return await lease.registry.resolveProjectNativeAdapter(reference, role); }
                finally { await lease.release(); }
              } },
            });
            const readProjectFiniteLoad: NonNullable<ApiMachineClientLifecycleDependencies['readProjectFiniteLoad']> = async () => {
              const live = () => projectWorkerAdmission === admission
                && apiMachineForSessions?.isProjectFiniteExecutionLive() === true;
              if (!live() || !await isCurrent()) return { kind: 'unknown' };
              const { load } = await admission.observeFiniteEligibility();
              return live() && await isCurrent() ? load : { kind: 'unknown' };
            };
            return { ...runtime, createProjectFiniteRuntime, readProjectFiniteLoad };
          });
        },
        onMachineMetadataChanged: () => {
          projectWorkerAdmission?.notifyChanged();
          void machineResourcesPolicy?.reload().catch(error => logger.debug('[DAEMON RUN] Resources policy refresh failed', error));
        },
        onProjectOperationInspection: () => projectWorkerAdmission?.notifyChanged(),
        runtimeId,
        publicReleaseChannel,
        startupSource,
        serviceLabel,
        transferRuntimeStatePublisher,
        spawnSession: async options => {
          const result = await spawnSession(options);
          if (result.type === 'success' && result.sessionId) {
            const tracked = [...pidToTrackedSession.values()].find(item => item.happySessionId === result.sessionId);
            if (tracked) await guardSessionRestoration?.onSessionRunnerStarted(tracked);
          }
          return result;
        },
        spawnSessionForInternalResume: async (options, pendingActivation) => {
          const result = await spawnSessionForInternalResume(options, pendingActivation);
          if (result.type === 'success' && result.sessionId) {
            const tracked = [...pidToTrackedSession.values()].find(item => item.happySessionId === result.sessionId);
            if (tracked) await guardSessionRestoration?.onSessionRunnerStarted(tracked);
          }
          return result;
        },
        stopSession,
        sessionRunnerStatus,
        awaitAgentSessionOpen,
        installExternalSessionHostOperations,
        readMaterializedStateObservationBinding,
        isSessionAlreadyRunning,
        loadLocalSessionMetadataForHandoff,
        resolveHostedSessionWorkingDirectory,
        beforeShutdown,
        requestShutdown,
        directPeerServerLifecycle,
        ...(machineIrohRuntime ? { machineIrohRuntime } : {}),
        prepareServerTransportForReconnect: async () => (
          homeIrohTransport
            ? await homeIrohTransport.reacquire()
            : { status: 'ready' as const }
        ),
        acquireWorkspaceSyncMachineIngress: async (input) => {
          const runtime = workspaceSyncRuntimeCustody.get();
          if (!runtime) throw new Error('Workspace sync runtime is not ready');
          return await runtime.acquireWorkspaceSyncMachineIngress(input);
        },
        directTransferRegistryHost,
        daemonServerWorkScheduler,
        publicProfileRefreshHandle,
        cancelConnectedServiceRuntimeAuthRecovery,
        retryTemporaryThrottleNow,
        readTemporaryThrottleRecovery,
        cancelTemporaryThrottleRecovery,
        liveStreamCaptureRegistry,
        readActiveLiveStreamControlLease: (input) => simulatorInputLeaseManager.read(input),
        peerMediationObservabilityEmitter: peerMediationObservabilityRuntime.emitter,
        setDaemonServerWorkOnline: runtimeBootstrap.setDaemonServerWorkOnline,
        orphanedDeadDaemonSessions,
        onMachineConnectionOnline: async () => {
          await reconcileSessionMachineAccessBindings();
          await refreshServerFeaturesAndBrowserRouteOwners();
          pluginRuntimeOwner.reportCurrentAvailability();
          await connectedServiceQuotasCoordinator?.flushInBandQuotaPersistence(0);
          await flushProviderAccountUsagePersistence(0);
        },
        reconcileConnectedServicesProjection: reconcileConnectedServicesProjectionForPluginConsumers,
        subscribeConnectedAccountInvalidations:
          connectedAccountPurposeBindingRuntime.subscribeInvalidations,
        isShuttingDown: isDaemonQuiescing,
        admissionDrain,
        managedActivity: { activity: managedActivity, admissionDrain },
        machineReboot: {
          nativeAdmission: machineNativeEffectAdmission,
          vitals: { host: () => machineVitals?.host() ?? null },
          readServiceFacts: async request => {
            const lease = pluginReloadController.tryAcquireRuntimeRegistry();
            if (!lease) return { coverage: 'unknown', services: [] };
            try { return await lease.registry.projectManagedServices.readMachineRebootServices(request); }
            finally { await lease.release(); }
          },
        },
        isPublicationQuiescing: admissionDrain.isPublicationQuiescing,
        readSpawnFailureLimits: () => machineVitals?.latest()?.limits,
        ownerRemainder,
        getServerFeaturesSnapshot: () => serverFeaturesSnapshotStore.getSnapshot(),
        resolvePeerMediationTrustRoots,
        refreshServerFeaturesSnapshot,
        readLocalServiceInventorySnapshot: async () => localServiceInventoryRoutes?.getSnapshot() ?? null,
        localServiceSummary,
        onPublicVoiceModelPackRuntimeReady: bindStorageModels,
        ...(machineResourceSummary ? { machineResourceSummary } : {}),
        acquireLocalServicePreviewApplication,
        resolveManagedPurposeBindingIntent:
          connectedAccountPurposeBindingRuntime.resolveBindingIntent,
        resolveManagedPurposeBindingIntentSelection:
          connectedAccountPurposeBindingRuntime.resolveBindingIntentSelection,
        ...(externalActionAccountId ? { teamCredentialNativeSource: {
          controllerAccountId: externalActionAccountId,
          async readResource(resourceId: string, signal: AbortSignal) {
            if (isDaemonQuiescing() || homeTransportCancellation.signal.aborted) return null;
            const resource = await readTeamCredentialBrokerResource(api, resourceId, signal);
            if (!resource || isDaemonQuiescing() || homeTransportCancellation.signal.aborted) return null;
            return projectTeamCredentialNativeProviderSourceAuthority(resource, externalActionAccountId);
          },
        } } : {}),
        mcpServers: {
          readCredentials: async () => credentials,
          issueRequestAuth: createDaemonMcpRequestAuthForTest({ credentials, materializationBaseDir: connectedServicesMaterializationBaseDir,
            establishedOwner: establishedConnectedAccountRuntimeOwner,
            activatePurposeBindings: connectedAccountPurposeBindingRuntime.activatePurposeBindings,
            registry: connectedAccountRequestAuthRegistry,
            getHttpPort: () => {
              if (connectedAccountRequestAuthHttpPort === null) throw new Error('connected_account_request_auth_http_port_unavailable');
              return connectedAccountRequestAuthHttpPort;
            },
            isCurrent: () => !isDaemonQuiescing() && !homeTransportCancellation.signal.aborted,
          }),
        },
        createAgentCatalogObservation,
        onAutomationWorkerStarted: (worker: AutomationWorkerHandle) => {
          automationWorker = worker;
          automationActivity.notifyChanged();
        },
        ...(getWorkflowRuntime
          ? {
              isWorkflowFeatureEnabled: () => isWorkflowRuntimeEnabled(
                process.env,
                serverFeaturesSnapshotStore.getSnapshot(),
              ),
              createWorkflowRunCoordinatorForMachine: (input) => {
                const selectedCredentials = input.requesterCredentials ?? credentials;
                // getWorkflowRuntime is available only with a controller Account.
                const selectedAccountId = input.requesterWorkAttributionV1?.accountId ?? externalActionAccountId!;
                const runtime = sameStoredCredentials(selectedCredentials, credentials) ? getWorkflowRuntime()
                  : createProductionDaemonWorkflowRuntime({ credentials: selectedCredentials, accountId: selectedAccountId,
                    serverId: requesterRuntimeServerId, secretSources: daemonSecretSources, admissionDrain });
                const installation = readInstallationIdentityIfExistsSync();
                return runtime.createCoordinatorForMachine({ ...input, managedMachineAction: managedMachinePolicyAdapter,
                  postWorkflowMessage,
                  sessionStartup: async request => {
                    const client = apiMachineForSessions;
                    const stamp = input.requesterWorkAttributionV1;
                    const current = async () => Boolean(client && client === apiMachineForSessions
                      && !homeTransportCancellation.signal.aborted && !isDaemonQuiescing()
                      && stamp && stamp.accountId === selectedAccountId && stamp.machineId === input.machineId
                      && stamp.serverId === requesterRuntimeServerId && configuration.activeServerId === requesterRuntimeServerId
                      && stamp.installationId === readInstallationIdentityIfExistsSync()?.installationId
                      && request.authorization && await runtime.isAcceptedAuthorizationCurrent({ authorization: request.authorization }));
                    if (!client || !stamp || !externalActionAccountId || !sameStoredCredentials(request.request.credentials, selectedCredentials) || !await current()) {
                      throw Object.assign(new Error('Workflow requester Session authority unavailable'), { code: 'project_requester_credentials_unavailable' });
                    }
                    const prepared = request.retainedOperation ? null : await prepareWorkflowSessionRequester({
                      credentials: request.request.credentials, attribution: stamp,
                      // current() above proves this accepted Run's own Machine/Account binding.
                      machineAdmission: { actorAccountId: stamp.accountId, custodianAccountId: externalActionAccountId },
                      boundary: { serverId: stamp.serverId, serverHttpBaseUrl: readRequesterRuntimeServerHttpBaseUrl(), happyHomeDir: configuration.happyHomeDir },
                      verifyMachineAdmissionCurrent: current,
                      ...(request.request.signal ? { signal: request.request.signal } : {}),
                    });
                    if (!request.retainedOperation && !prepared) throw Object.assign(new Error('Workflow requester Session authority unavailable'), {
                      code: 'project_requester_credentials_unavailable',
                    });
                    const handler = createMachineSessionSpawnRpcHandler({ handlers: { spawnSession, stopSession },
                      serverId: stamp.serverId, awaitAgentSessionOpen });
                    return await runObservedWorkflowSessionStartup(request, { serverId: stamp.serverId, machineId: input.machineId,
                      observeExecution: observed => client.observeActionExecution(observed),
                      rpcContext: prepared ? { requesterSessionBootstrap: prepared.admitted } : {},
                      transport: operation => ({
                        spawn: async (spawnRequest, options) => {
                          if (!prepared || !await current()) throw new Error('project_requester_credentials_unavailable');
                          return await handler(spawnRequest, { ...options, signal: operation.signal,
                            requesterSessionBootstrap: prepared.admitted, localActionContext: operation });
                        },
                        resolveSpawnSessionByNonce: async (spawnNonce, options) => normalizeSpawnSessionNonceResolution(
                          await input.machineActionDirectTargetTransport.invoke(RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
                            { spawnNonce }, options?.signal ? { signal: options.signal } : undefined)),
                      }),
                      observeOperation: async (operation, options) => await input.machineActionDirectTargetTransport.invoke(
                        ACTION_OPERATION_RPC_METHODS_V2.get, { operationId: operation.operationId,
                          ...(options.waitForTerminal ? { waitForTerminal: true } : {}),
                          ...(options.includeSetupReview ? { includeSetupReview: true } : {}) },
                        options.signal ? { signal: options.signal } : undefined),
                      cancelOperation: async operation => await input.machineActionDirectTargetTransport.invoke(
                        ACTION_OPERATION_RPC_METHODS_V1.cancel, { operationId: operation.operationId }),
                      cleanupOnFailure: async () => { await prepared?.cleanupOnFailure(); },
                    });
                  },
                  ...(installation ? { installationIdentity: installation } : {}),
                  ...(managedPolicyHomeId ? { serverIdentityId: managedPolicyHomeId } : {}),
                  sessionActionRpcTransport: async request => {
                    if (!apiMachineForSessions) throw new Error('machine_socket_unavailable');
                    return await apiMachineForSessions.callSessionActionRpc(request);
                  } });
              },
              createWorkflowRecoveryForMachine: (input) => {
                const runtime = input.requesterCredentials && input.requesterWorkAttributionV1
                  ? createProductionDaemonWorkflowRuntime({ credentials: input.requesterCredentials,
                    accountId: input.requesterWorkAttributionV1.accountId, serverId: requesterRuntimeServerId,
                    secretSources: daemonSecretSources, admissionDrain }) : getWorkflowRuntime();
                return runtime.createRecoveryForMachine({ ...input, postWorkflowMessage });
              },
            }
          : {}),
        prepareApiMachineForSessions:
          machineRpcRouteAttachments.prepareApiMachineForSessions,
        persistedTakeoverAdmissionWaiter,
        attachPersistedTakeoverAdmissionOwner,
        ...(externalActionIngressOwner
          ? { externalActionIngressOwner }
          : {}),
      }),
      onMachineSyncRuntime: async (machineSyncRuntime) => {
        cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop =
          machineSyncRuntime.cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop;
        let didCompleteMachineSyncStartup = false;
        let machineSyncStartupInFlight: Promise<void> | null = null;
        const completeMachineSyncStartup = async (): Promise<void> => {
          if (admissionDrain.isPublicationQuiescing() || didCompleteMachineSyncStartup) return;
          if (machineSyncStartupInFlight) {
            try {
              await machineSyncStartupInFlight;
            } catch {
              // The original caller owns the failure. A concurrent resume retries
              // only while this daemon is still current and no completed result exists.
            }
            if (!admissionDrain.isPublicationQuiescing() && !didCompleteMachineSyncStartup) {
              await completeMachineSyncStartup();
            }
            return;
          }

          const operation = (async () => {
            if (machineSyncRuntime.apiMachine) {
              const mutationCustody = machineSyncRuntime.daemonSessionMutationCustody;
              if (!mutationCustody) {
                throw new Error('Daemon session mutation custody is unavailable during journal recovery');
              }
              const recovery = await machineSyncRuntime.apiMachine.recoverDaemonTerminalSessionMutationJournals({
                bindUsageLimitRecoveryJournals: (sessionIds) =>
                  mutationCustody.bindRecoveredJournals(sessionIds),
                isShuttingDown: admissionDrain.isPublicationQuiescing,
              });
              if (admissionDrain.isPublicationQuiescing()) return;

              if (recovery.retainedSessionIds.length > 0) {
                logger.warn('[DAEMON RUN] Retained daemon mutation journals without a resolvable session binding', {
                  sessionIds: recovery.retainedSessionIds,
                });
              }
              // Re-enter the same restart owner after exit staging is durable; the
              // canonical stop lifecycle serializes retirement with public Stop/Resume.
              const restartRetirementResults =
                await reconcileAgentRuntimeRestartDisposition({
                  trackedSessions: pidToTrackedSession.values(),
                  retireSession: stopSession,
                  isShuttingDown: admissionDrain.isPublicationQuiescing,
                });
              for (const { sessionId, result } of restartRetirementResults) {
                if (
                  result.status !== 'stopped'
                  && result.status !== 'not_found'
                ) {
                  logger.warn(
                    '[DAEMON RUN] Reattached Agent runtime remains fenced after incomplete startup retirement',
                    {
                      sessionId,
                      result,
                    },
                  );
                }
              }
              if (admissionDrain.isPublicationQuiescing()) return;

            }
            didCompleteMachineSyncStartup = true;
          })();
          machineSyncStartupInFlight = operation;
          try {
            await operation;
          } finally {
            if (machineSyncStartupInFlight === operation) {
              machineSyncStartupInFlight = null;
            }
          }
        };
        const previousResumeQuiescedMachineSyncStartup = resumeQuiescedMachineSyncStartup;
        resumeQuiescedMachineSyncStartup = completeMachineSyncStartup;
        try {
          await completeMachineSyncStartup();
        } catch (error) {
          // This continuation must be present while a lock handoff interrupts
          // recovery, but a rejected attempt must not remain resumable after
          // its registration owner retires it.
          if (resumeQuiescedMachineSyncStartup === completeMachineSyncStartup) {
            resumeQuiescedMachineSyncStartup = previousResumeQuiescedMachineSyncStartup;
          }
          throw error;
        }

        const attemptedApiMachine = machineSyncRuntime.apiMachine;
        const attemptedApiMachineForSessions = machineSyncRuntime.apiMachineForSessions;
        const attemptedProviderOperationsProducer =
          machineSyncRuntime.providerOperationsProducer;
        const attemptedExternalSessionPluginAdmissionOwner =
          machineSyncRuntime.externalSessionPluginAdmissionOwner ?? null;
        const attemptedExternalSessionHostActionExecutor =
          machineSyncRuntime.externalSessionHostActionExecutor ?? null;
        const attemptedSessionSpawnDirectTargetTransport =
          machineSyncRuntime.sessionSpawnDirectTargetTransport ?? null;
        let attemptedManagedMachinePolicyRuntime: ReturnType<typeof createDaemonManagedMachinePolicyRuntime> | null = null;
        try {
          await managedMachinePolicyRuntime?.stop();
          managedMachinePolicyRuntime = null;
          apiMachine = attemptedApiMachine;
          await machineResourcesPolicy?.reload();
          if (homeTransportReplacementPending && attemptedApiMachine) {
            homeTransportReplacementPending = !attemptedApiMachine.requestServerTransportReconnect();
          }
          apiMachineForSessions = attemptedApiMachineForSessions;
          attemptedApiMachineForSessions?.registerDeploymentChildRoutes(daemonWorkSignal);
          machineActivity.notifyChanged();
          syncActivity.notifyChanged();
          sessionLiveWorkProducer.notifyChanged();
          await reconcileSessionMachineAccessBindings();
          providerOperationsProducer = attemptedProviderOperationsProducer;
          externalSessionPluginAdmissionOwner =
            attemptedExternalSessionPluginAdmissionOwner;
          externalSessionHostActionExecutor =
            attemptedExternalSessionHostActionExecutor;
          sessionSpawnDirectTargetTransport =
            attemptedSessionSpawnDirectTargetTransport;
          resolveMachineProviderBindingSettled();
          await pluginRuntimeInitialization;
          if (!pluginWebhookWorker) {
            const installationIdentity = await readOrCreateInstallationIdentity();
            pluginWebhookWorker = startPluginWebhookDaemonWorkerV1({
              credentials,
              machineId: () => machineId,
              machineInstallationId: installationIdentity.installationId,
              enabled: () => {
                const snapshot = serverFeaturesSnapshotStore.getSnapshot();
                return snapshot?.status === 'ready'
                  ? readServerEnabledBit(snapshot.features, 'plugins.webhooks') === true
                  : false;
              },
              logger,
            });
          }
          // Direct-material preparation is woken by the relevant AccountChange
          // (grant, recipient, Team and connected-service changes) and by every
          // reconnect, whose census reconstructs missing work (teams-lane-10 06 §11).
          teamCredentialDirectMaterialAccountChangeCleanup?.();
          teamCredentialDirectMaterialAccountChangeCleanup = attemptedApiMachine
            ? subscribeTeamCredentialDirectMaterialAccountChanges(
                attemptedApiMachine,
                wakeReason => reconcileTeamCredentialDirectMaterialAfterSourceChange(wakeReason),
              )
            : null;
          pluginWebhookWakeCleanup?.();
          pluginWebhookWakeCleanup = attemptedApiMachine
            ? attachPluginWebhookDaemonWakeV1({
                apiMachine: attemptedApiMachine,
                getWorker: () => pluginWebhookWorker,
              })
            : null;
          machineRpcRouteAttachments.attachApiMachineForSessions(apiMachineForSessions);
          if (attemptedApiMachineForSessions) {
            attemptedApiMachineForSessions.registerManagedFiniteWake({
              readCurrent: async (managedId, signal) => (await readCurrentManagedMachinePolicies(signal)).machines.find(machine => machine.id === managedId) ?? null,
              executePolicy: managedMachinePolicyAdapter.executePolicy,
            });
            attemptedManagedMachinePolicyRuntime = createDaemonManagedMachinePolicyRuntime({
              apiMachine: attemptedApiMachineForSessions,
              executorMachineId: machineId,
              isAvailable: () => readCurrentManagedPolicyController() !== null,
              loadMachine: (id, signal) => runWithServerHttpBaseUrl(managedPolicyServerHttpBaseUrl,
                () => api.getMachine(id, { signal })),
              readCensus: readCurrentManagedMachinePolicies,
              executePolicy: managedMachinePolicyAdapter.executePolicy,
              onUnavailable: error => logger.debug('[DAEMON RUN] Managed policy execution unavailable', error),
              reconcileNativeCredentials: managedMachinePolicyAdapter.reconcileNativeCredentials,
            });
            managedMachinePolicyRuntime = attemptedManagedMachinePolicyRuntime;
          }
          automationWorker = machineSyncRuntime.automationWorker;
          memoryWorker = machineSyncRuntime.memoryWorker;
          voiceInferenceWorker = machineSyncRuntime.voiceInferenceWorker;
          daemonConnectivityCoordinator = machineSyncRuntime.daemonConnectivityCoordinator;
          machineConnectionStateCleanup = machineSyncRuntime.machineConnectionStateCleanup;
          stopPeerMediationLoopbackServer = machineSyncRuntime.stopPeerMediationLoopbackServer;
          stopMachineIrohAcceptor = machineSyncRuntime.stopMachineIrohAcceptor;
          resumeQuiescedMachineConnectionPublications =
            machineSyncRuntime.resumeMachineConnectionPublications;
        } catch (error) {
          await attemptedManagedMachinePolicyRuntime?.stop();
          if (managedMachinePolicyRuntime === attemptedManagedMachinePolicyRuntime) managedMachinePolicyRuntime = null;
          if (apiMachine === attemptedApiMachine) apiMachine = null;
          if (apiMachineForSessions === attemptedApiMachineForSessions) {
            apiMachineForSessions = null;
            machineActivity.notifyChanged();
          }
          if (providerOperationsProducer === attemptedProviderOperationsProducer) {
            providerOperationsProducer = null;
          }
          if (
            externalSessionPluginAdmissionOwner
            === attemptedExternalSessionPluginAdmissionOwner
          ) {
            externalSessionPluginAdmissionOwner = null;
          }
          if (
            externalSessionHostActionExecutor
            === attemptedExternalSessionHostActionExecutor
          ) {
            externalSessionHostActionExecutor = null;
          }
          if (
            sessionSpawnDirectTargetTransport
            === attemptedSessionSpawnDirectTargetTransport
          ) {
            sessionSpawnDirectTargetTransport = null;
          }
          throw error;
        }
        void settleDaemonOptionalCapability(
          'connected_service_reconcile',
          reconcileReattachedConnectedServiceCredentialProjection(),
          reportOptionalCapabilityUnavailable,
        );
      },
      filesystemAccessPolicy,
      takeoverRequested,
      preferredHost,
      connectedServiceRefreshLoopHandle,
      connectedServiceQuotasLoopHandle,
    });
    resumeQuiescedMachineRegistration = () => {
      machineRegistrationRuntime?.resume();
    };
    // Startup reconciliation has populated the existing tracked census.
    // Reattached Sessions may still hold the previous daemon's catalog.
    publishSessionPluginCatalogInvalidation(pluginRegistryProjectionInvalidation.readRevision());

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const restartOnStaleVersionAndHeartbeat = startDaemonHeartbeatLoop({
      pidToTrackedSession,
      ...(process.platform === 'linux' ? {
        allocatorMaintenance: { activity: managedActivity, trim: trimProcessAllocator },
      } : {}),
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => apiMachineForSessions,
      onChildExited,
      onTrackedSessionHealthy,
      controlPort,
      fileState,
      currentCliVersion: configuration.currentCliVersion,
      requestShutdown,
      isShuttingDown: admissionDrain.isPublicationQuiescing,
      writeDaemonStateForCurrentOwner: publishDaemonStateForCurrentOwner,
      requestSelfRestart: async (selfRestartParams) =>
        await requestDaemonSelfRestartWithLockHandoff({
          getCurrentDaemonLockHandle: () => daemonLockHandle,
          setCurrentDaemonLockHandle: (lockHandle) => {
            daemonLockHandle = lockHandle;
          },
          quiesceBeforeLockRelease: quiescePluginChangesForLockHandoff,
          releaseDaemonLock,
          acquireDaemonLock: () => acquireDaemonLock(5, 200),
          requestShutdown,
          selfRestartParams: { ...selfRestartParams, ...withMachineConnectionHandover() },
        }),
    });

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Reattach and restart dependencies are ready. The pass contains and logs its failures.
    void restartStaleSessionRunnersAfterDaemonStart();

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    const cleanupAndShutdown = createDaemonCleanupAndShutdown({
      stopKeepAwake: async () => { await daemonGuard?.stop(); daemonGuard = null; await daemonKeepAwake?.stop(); daemonKeepAwake = null; },
      markShutdownInitiated: () => {
        admissionDrain.beginShutdown();
        eventLoopStallMonitor.stop();
      },
      processEnv: process.env,
      resolvePositiveIntEnv,
      restartOnStaleVersionAndHeartbeat,
      connectedServiceRefreshLoopHandle,
      connectedServiceQuotasLoopHandle,
      beforeShutdown,
      publicProfileRefreshHandle,
      apiMachine,
      closeDaemonMutationCustody: async () => {
        connectedAccountDaemonRuntime.dispose();
        await daemonSessionMutationCustody.close();
      },
      machineConnectionStateCleanup,
      automationWorker,
      memoryWorker,
      voiceInferenceWorker,
      trackedSessionCount: pidToTrackedSession.size,
      stopDirectPeerServer: async () => {
        await cleanupDaemonHomeMachineWorkspace({
          stopWorkspaceSync: stopWorkspaceSyncRuntime,
          stopMachineAcceptor: stopMachineIrohAcceptor,
          stopPeerMediation: stopPeerMediationLoopbackServer,
          stopDirectPeer: stopDirectPeerServer,
          releaseHomeTransport: async () => await homeIrohTransport?.release(),
          shutdownMachineIroh: async () => await machineIrohRuntime?.shutdown(),
          cleanupFailedIrohStartup: async () => await preparedIrohState.failedStartupCleanup?.(),
        });
      },
      stopTailscaleTransferServeLifecycle,
      stopSshTunnelsOnShutdown: sshTunnelSupervisor.stopAllTunnels,
      stopControlServer,
      daemonStateOwner: fileState,
      daemonLockHandle,
      releaseDaemonLock,
    });
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
    releaseMachineAdmissionTransport();
  } catch (error) {
    homeTransportCancellation.abort();
    await publicProfileRefreshHandle?.stop().catch(stopError =>
      logger.debug('[DAEMON RUN] Public-profile refresh drain failed during startup cleanup', stopError));
    storageRoutes?.dispose();
    storageRoutes = null;
    await daemonGuard?.stop().catch(stopError => logger.warn('[DAEMON RUN] Guard shutdown failed', stopError));
    daemonGuard = null;
    await daemonKeepAwake?.stop().catch(stopError => logger.warn('[keep awake] Shutdown failed', stopError));
    daemonKeepAwake = null;
    processLeftBehindPass?.dispose();
    processLeftBehindPass = null;
    machineProcessesView?.dispose();
    machineProcessesView = null;
    await machineVitalsAlerts?.stop().catch(stopError => logger.warn('[DAEMON RUN] Machine vitals alert shutdown failed', stopError));
    machineVitalsAlerts = null;
    machineResourceSummary?.stop();
    machineResourceSummary = null;
    machineResourcesPolicy?.stop();
    machineResourcesPolicy = null;
    await machineVitals?.stop().catch((stopError) => {
      logger.debug('[DAEMON RUN] Machine vitals cleanup failed during shutdown', stopError);
    });
    machineVitals = null;
    await getDaemonAgentInstallJobOwner().shutdown().catch(() => {
      logger.debug('[DAEMON RUN] Agent installer process cleanup could not be verified during shutdown');
    });
    await cleanupDaemonHomeMachineWorkspace({
      stopWorkspaceSync: stopWorkspaceSyncRuntime,
      stopMachineAcceptor: stopMachineIrohAcceptor,
      stopPeerMediation: async () => undefined,
      stopDirectPeer: async () => undefined,
      releaseHomeTransport: async () => await (homeIrohTransport ?? preparedIrohState.home)?.release(),
      shutdownMachineIroh: async () => await (machineIrohRuntime ?? preparedIrohState.machine)?.shutdown(),
      cleanupFailedIrohStartup: async () => await preparedIrohState.failedStartupCleanup?.(),
    }).catch(() => undefined);
    try {
      await releaseDaemonOwnershipAfterFatal({
        daemonLockHandle,
        daemonStateOwner,
      });
    } catch {
      // ignore
    }
    if (error instanceof DaemonOwnershipConflictError) {
      process.exit(resolveDaemonOwnershipConflictExitCode(startupSource));
    }
    if (error === homeTransportCancellation.signal.reason) {
      const shutdownRequest = await resolvesWhenShutdownRequested;
      logger.debug('[DAEMON RUN] Startup interrupted; owned preparation and daemon ownership released', {
        source: shutdownRequest.source,
      });
      logger.flushSync();
      process.exit(shutdownRequest.source === 'exception' ? 1 : 0);
      return;
    }
    // IMPORTANT: Do not log raw Axios errors here; they can contain bearer tokens.
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', serializeAxiosErrorForLog(error));
    logger.flushSync();
    process.exit(1);
  }
}

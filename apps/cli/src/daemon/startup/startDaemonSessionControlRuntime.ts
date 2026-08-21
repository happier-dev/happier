import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { ApiMachineClient, ConnectedServicesProjectionNotification } from '@/api/apiMachine';
import { fetchAccountProfile } from '@/api/accountProfile';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { configuration } from '@/configuration';
import { getSessionNotificationTitle } from '@/agent/runtime/notifications/sessionNotificationContext';
import {
    getActiveAccountSettingsSnapshot,
    resolveActiveAccountSettingsSnapshotRevision,
    subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
    warmActiveAccountSettingsSnapshotBestEffort,
} from '@/settings/accountSettings/warmActiveAccountSettingsSnapshot';
import { logger } from '@/ui/logger';
import {
    resolveConnectedServiceCredentialResolutions,
} from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type {
    QualifiedConnectedAccountPeerOperationTransport,
} from '@/api/client/qualifiedConnectedAccountApi';
import { resolveConcreteBackendTargetRefV2 } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import {
    ConnectedServiceBindingsV1Schema,
    ConnectedServiceIdSchema,
    DEFAULT_LOCAL_SERVICE_PAGE_TITLE_CONCURRENCY,
    DEFAULT_LOCAL_SERVICE_PAGE_TITLE_FAILURE_TTL_MS,
    DEFAULT_LOCAL_SERVICE_PAGE_TITLE_MAX_BODY_BYTES,
    DEFAULT_LOCAL_SERVICE_PAGE_TITLE_SUCCESS_TTL_MS,
    DEFAULT_LOCAL_SERVICE_PAGE_TITLE_TIMEOUT_MS,
    parseBooleanEnv,
    projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1,
    readConnectedServiceMaterializationIdentityV1FromMetadata,
    writeProviderAccountUsageRecordIdToMetadata,
    writeConnectedServiceMaterializationIdentityV1ToMetadata,
    type AccountSettings,
    type AgentSessionStartupInstructionsMarkerV1,
    type AgentSessionStartupInstructionsV1,
    type ConnectedServiceBindingsV1,
    type ConnectedServiceCredentialRevisionV1,
    type ConnectedServiceId,
    type ConnectedServiceMaterializationIdentityV1,
    type ConnectedServiceUsageSourceV1,
    type QualifiedConnectedAccountServiceRef,
    type SessionConnectedServiceAuthReadRuntimeIdentityResponseV1,
    type ProviderAccountUsageRecordId,
    type SessionContinuationResumePromptModeV1,
    type SessionRunnerRestartDisabledReason,
} from '@happier-dev/protocol';
import { resolveRoutedUsageLimitRecoveryResumePromptMode } from '@/session/usageLimitRecoveryControls/resolveRoutedUsageLimitRecoveryResumePromptMode';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotAvailableError } from '@happier-dev/protocol/rpcErrors';
import { verifyPluginUiArtifactFileSetIntegrityV1 } from '@happier-dev/protocol/plugins/ui';
import {
    inferAgentIdFromSessionMetadata,
    resolveVendorResumeIdFromSessionMetadata,
    type TerminalHostAdapter,
} from '@happier-dev/agents';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import {
    authorizeDaemonSessionModelTransitionProviderTarget,
    authorizeSessionModelTransitionProviderTargetWithLease,
} from '@/providers/sessions/authorizeSessionModelTransitionTarget';
import { createCredentialedTargetActionCurrentIntent } from '@/session/actions/createCliActionExecutor';
import { resolveCatalogAgentId } from '@/agent/catalog/resolution';
import {
    resolveConnectedServiceCandidatePersistedSessionFile,
    getConnectedServiceRecoveryCapabilities,
    getConnectedServiceRuntimeAuthAdapter,
    resolveLegacyConnectedServiceRuntimeAuthFailureSourceRevisionThroughCatalog,
    resolveConnectedServiceGenerationApplicationScope,
    resolveConnectedServiceMaterializedHomeRoot,
    resolveConnectedServiceRuntimeAuthApplyCapability,
    resolveConnectedServiceSwitchContinuity,
} from '@/daemon/connectedServices/catalogHooks';
import { listManagedServerClaimDescriptors } from '@/daemon/managedServers/catalogHooks';
import type {
    CatalogAgentId,
    ConnectedServiceDaemonAuthBridgeRefresh,
    ConnectedServiceRuntimeAuthApplyCapability,
    ConnectedServiceSwitchEffectiveBinding,
    ManagedServerClaimDescriptor,
} from '@/agent/catalog/types';
import {
    createSessionConnectedServiceAuthTransport,
} from '@/session/runtime/control/transport';

import type {
    ConnectedServiceDaemonAuthBridgeRegistration,
} from '../connectedServices/daemonAuthBridgeTypes';

import { startDaemonControlServer } from '../controlServer';
import { createDaemonShutdownCancellationDomains } from './shutdownCancellationDomains';
import type { DaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { resolveConnectedServiceAuthForSpawn } from '../connectedServices/resolveConnectedServiceAuthForSpawn';
import { isValidConnectedServiceRunMaterializeToken } from '../connectedServices/runs/capabilityToken';
import { createExecutionRunConnectedServicesBridge } from '../connectedServices/runs/executionRunMaterialization';
import { isExecutionRunConnectedServiceGenerationCurrent } from '../connectedServices/runs/executionRunGenerationAdmission';
import { rehydrateLiveExecutionRunTargets } from '../connectedServices/runs/rehydrateExecutionRunTargets';
import { createAdoptedExecutionRunRootCleanup } from '../connectedServices/runs/createAdoptedExecutionRunRootCleanup';
import { resolveConnectedServiceMaterializedRootDir } from '../connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';
import { listExecutionRunMarkersForRehydration } from '../executionRunRegistry';
import {
    createComposedSimulatorPreviewAdapter,
} from '../devices/simulator/adapter';
import { createSimulatorCaptureAdapterForResource } from '../devices/simulator/captureAdapters';
import { createSimulatorCaptureRegistryReconciler } from '../devices/simulator/captureRegistration';
import type { SimulatorInputLeaseManager } from '../devices/simulator/lease';
import { createDefaultAndroidSimulatorResourcesDiscovery } from '../devices/simulator/android/discovery';
import { createAndroidScrcpyTunnelOwner } from '../devices/simulator/android/tunnelOwner';
import {
    createDefaultIosSimulatorResourcesDiscovery,
    resolveIosSimulatorCaptureAdapterAvailability,
    resolvePinnedIosSimulatorHelperArtifact,
} from '../devices/simulator/ios/discovery';
import { verifyIosSimulatorHelperSignature } from '../devices/simulator/ios/signature';
import type { IosSimulatorHelperFrameStreamOpener } from '../devices/simulator/ios/helperFrameProducer';
import { createIosSimulatorHelperSession } from '../devices/simulator/ios/helperSession';
import type { IosSimulatorInputCommandSender } from '../devices/simulator/ios/input';
import { createAndroidSimulatorPlatformAdapter } from '../devices/simulator/platform/android';
import { createIosSimulatorPlatformAdapter } from '../devices/simulator/platform/ios';
import { createSimulatorPreviewDaemonRuntime } from '../devices/simulator/runtime';
import { createSimulatorStreamControlBridge } from '../devices/simulator/streamControlBridge';
import type { SimulatorPreviewRoutes } from '../devices/simulator/previewRoutes.types';
import { createBrowserDiagnosticsRoutes, type BrowserDiagnosticsRoutes } from '../browser/diagnostics/routes';
import {
    createBrowserDiagnosticsActionRoutes,
    type BrowserDiagnosticsActionRoutes,
    type BrowserDiagnosticsInteractionTransport,
} from '../browser/diagnostics/actionRoutes';
import { createBrowserDiagnosticsInteractionTransport } from '../browser/diagnostics/interactionTransport';
import { createBrowserDiagnosticsDaemonStore } from '../browser/diagnostics/store';
import { createBrowserDaemonControlBroker } from '../browser/control/broker';
import { createBrowserDaemonControlRoutes, type BrowserDaemonControlRoutes } from '../browser/control/routes';
import { createBrowserContextRoutes, type BrowserContextRoutes } from '../browser/context/routes';
import {
    createUnavailableBrowserContextSource,
    type BrowserContextSource,
} from '../browser/context/source';
import { createSidecarCdpBrowserContextSource } from '../browser/context/cdp/productSource';
import {
    createBrowserContextDiagnosticsRingBuffer,
    type BrowserContextDiagnosticsRingBuffer,
} from '../browser/context/diagnostics/ringBuffer';
import { tapBrowserDiagnosticsStoreIntoRingBuffer } from '../browser/context/diagnostics/storeTap';
import { createSidecarCdpDiagnosticsRuntime } from '../browser/sidecar/diagnostics/runtime';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { createBrowserAutomationDaemonService } from '../browser/automation/service';
import { createBrowserAutomationRoutes, type BrowserAutomationRoutes } from '../browser/automation/routes';
import { createBrowserAutomationCdpAdapter } from '../browser/automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../browser/automation/adapters/controlBridge';
import {
    createBrowserRecordingDaemonRuntime,
    type BrowserRecordingDaemonRuntime,
    type BrowserRecordingDaemonRuntimeOptions,
} from '../browser/recording/runtime';
import { resolveBrowserRecordingStartContext as resolveBrowserRecordingStartContextForProducers } from '../browser/recording/startContext';
import { createBrowserRecordingNativeViewCaptureCommand } from '../browser/recording/adapters/nativeViewCommand';
import { createBrowserRecordingCdpScreencastTransport } from '../browser/recording/adapters/cdpScreencastTransport';
import {
    createDesktopBrowserRecordingNativeViewCaptureTransport,
    type DesktopBrowserRecordingFrameCaptureInvoke,
} from '../browser/recording/adapters/nativeViewTransport';
import { createReverseDesktopBrowserRecordingNativeViewCaptureInvoke } from '../browser/recording/adapters/reverseCaptureInvoke';
import { createDesktopReverseBrowserRecordingCaptureUiCall } from '../browser/recording/reverseChannel/desktopReverseCaptureUiCall';
import type { BrowserRecordingRoutes } from '../browser/recording/routes';
import { createBrowserProfileStore, type BrowserProfileStore } from '../browser/profiles/store';
import {
    createBrowserStoragePartitionOwner,
    type BrowserStoragePartitionOwner,
} from '../browser/storage/partitions';

export type DaemonBrowserStoragePurgeOwner = Readonly<{
    store: BrowserProfileStore;
    partitionOwner: BrowserStoragePartitionOwner;
    purgeForSessionDeleted: (sessionId: string) => Promise<void>;
    purgeForLogout: () => Promise<void>;
}>;

export type ProviderManagedLocalServicesOwner = Readonly<{
    dispatch: ProviderManagedLocalServicesDispatch;
    getManagedSnapshot: LocalServiceManagedRoutes['getSnapshot'];
    managedCatalogRuntime: ReturnType<
        typeof createProviderManagedCatalogRuntimePort
    >;
}>;
import type {
    BrowserSidecarContextCaptureSurface,
    BrowserSidecarControlAdapterFactory,
} from '../browser/sidecar/controlAdapter';
import { createProductBrowserSidecarControlAdapterFactory } from '../browser/sidecar/productSource';
import { createBrowserDaemonFeatureGate, type BrowserDaemonFeatureGate } from '../browser/featureGate';
import type { MachineLiveStreamCaptureRegistry } from '../peer/mediation/stream';
import { createLocalServicesDaemonRuntime } from '../local/services/runtime';
import type { LocalServiceManagedRoutes } from '../local/services/managed/routes';
import { fetchServerFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { createPluginExecService } from '@/plugins/runtime/exec/hostService';
import {
    createProviderManagedLocalServicesDispatch,
    type ProviderManagedLocalServicesDispatch,
} from '@/providers/discovery/managedStart';
import {
    createProviderManagedCatalogRuntimePort,
} from '@/providers/probe/managedRuntime';
import type { LocalServicesRuntimeActionRoutes } from '../local/services/actions/runtimeActionExecutor';
import type { DaemonLocalServicesMachineRpcRoutes } from '@/rpc/handlers/daemonLocalServices';
import { createLocalPageTitleEnricher } from '../local/services/inventory/pageTitle';
import type { LocalServicePreviewRoutes } from '../local/services/preview/routes';
import { createLocalServicePublicPreviewServerRoutes } from '../local/services/public/routes';
import { resolveHostedWebStaticAssetLifecycleSource } from '../local/services/plugins/staticAssets/source';
import { createOnChildExited } from '../sessions/onChildExited';
import { applyTrackedSessionTurnLifecycle } from '../sessions/applyTrackedSessionTurnLifecycle';
import {
    isSessionRunnerActive as isSessionRunnerActiveInDaemon,
    probeSessionRunnerServiceability,
} from '../sessions/isSessionRunnerActive';
import { createStopSession } from '../sessions/stopSession';
import {
    retireUpstreamAuthorityBeforeProcessStop,
} from '../sessions/cleanupPidSessionResources';
import {
    isTerminalHostPhysicallyRetiredStopResult,
    type StopSessionResult,
} from '../sessions/stopSessionContract';
import { notifyTerminalAttachmentRetiredThroughCatalog } from '@/terminal/attachment/catalogHooks';
import { waitForExistingSessionExitIfStopRequested } from '../sessions/waitForExistingSessionExitIfStopRequested';
import { waitForTrackedRunnerProcessesExit } from '../sessions/waitForTrackedRunnerProcessesExit';
import {
    resolveDisconnectedTerminalHostResumeGate,
    superviseDisconnectedTerminalHostCandidate,
    type DisconnectedTerminalHostCandidate,
    type DisconnectedTerminalHostSupervisionResult,
} from '../sessions/disconnectedTerminalHostSupervision';
import { createDisconnectedTerminalHostResumeLifecycle } from './disconnectedTerminalHostResumeLifecycle';
import { resolveTrackedSessionCatalogAgentId } from '../sessions/resolveTrackedSessionCatalogAgentId';
import {
    clearSessionMarkerConnectedServiceRestartIntent,
    clearSessionMarkerManagedLocalServiceRunAttachment,
    removeSessionMarkerIfOwned,
    updateSessionMarkerAgentSessionStartupInstructionsMarker,
} from '../sessionRegistry';
import type { TrackedSession } from '../types';
import {
    ConnectedServiceRuntimeRegistry,
    type ConnectedServiceRuntimeTarget,
} from '../connectedServices/runtimeRegistry/registry';
import { applyConnectedServiceProjectionCredentialUpdate } from '../connectedServices/refresh/applyConnectedServiceProjectionCredentialUpdate';
import { computeConnectedServiceAccessTokenFingerprint } from '../connectedServices/refresh/credentialFreshness/tokenFingerprint';
import { createSessionConnectedServiceRuntimeAuthRefreshHandler } from '../connectedServices/sessionRuntimeAuthRefresh';
import type {
    SpawnSessionOptions,
    SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { readTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { executeSpawnSessionRequest } from './executeSpawnSessionRequest';
import { refreshAccountSettingsForDaemonRequest } from './accountSettingsFreshness';
import { createSpawnConcurrencyGate } from '../spawn/createSpawnConcurrencyGate';
import { createAgentRuntimeSessionBridgeRoutes } from '../agentRuntime/sessionBridgeRoutes';
import { createForegroundAgentRuntimeAdmissionOwner } from '../agentRuntime/foregroundAdmission';
import {
    createExternalSessionHostOperationOwner,
    type ExternalSessionHostOperationSet,
} from '@/session/external/hostOperationOwner';
import { prepareForegroundAgentRuntimeAdmission } from '../agentRuntime/prepareForegroundAdmission';
import { isPidSafeHappySessionProcess } from '../pidSafety';
import { computeDaemonSpawnRequestKey, createSpawnRequestCoalescer } from '../spawn/spawnRequestCoalescer';
import { DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS } from '../spawn/sessionWebhookTimeoutPolicy';
import { resolveExistingSessionSpawnPreGate } from '../spawn/resolveExistingSessionSpawnPreGate';
import {
    createSessionRunnerRespawnManager,
    type SessionRunnerRespawnTerminalReason,
} from '../processSupervision/sessionRunnerRespawn';
import type { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import type { ConnectedServiceQuotasCoordinator } from '../connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { ConnectedServiceAuthGroupGenerationConsumer } from '../connectedServices/accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer';
import {
    readConnectedServiceProviderAdoptedAuthGroupGenerationsFromMetadata,
} from '../connectedServices/accountGroups/generation/pendingGenerationMetadata';
import {
  reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget,
  reconcileConnectedServiceDirectCredentialRevisions,
} from '../connectedServices/accountGroups/generation/reconcileConnectedServiceAuthGroupGenerations';
import {
    parseConnectedServiceProjectionSnapshot,
    publishObservedConnectedServiceProjectionThenApply,
    type ConnectedServiceProjectionSnapshot,
} from '../connectedServices/accountGroups/generation/connectedServiceProjectionSnapshot';
import {
    createConnectedAccountRequestAuthService,
    type ConnectedAccountRequestAuthResolvedBinding,
} from '../connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import {
    createConnectedAccountRequestAuthSubjectRegistry,
} from '../connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import {
    inspectConnectedAccountRequestAuthCapabilityFile,
    type ConnectedAccountRequestAuthCapabilityDescriptor,
} from '../connectedServices/requestAuth/capabilityFile';
import {
    resolveQualifiedPurposeBindingSnapshotForAgentSpawn,
    resolveQualifiedRequestAuthPurposeBindingsForAgentSpawn,
} from '../connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import {
    scopeConnectedAccountSessionPurposeBindingLease,
    type ConnectedAccountPurposeBindingOwner,
} from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import {
    CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
    resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/plugin-sdk/experimental/cloud/request-auth';
import { prepareProviderLaunch } from '@/providers/lifecycle/prepareLaunch';
import {
    createRuntimeProviderSpawnAuthorizationAttempt,
} from '@/providers/spawn/authorize';
import { createProviderRuntimeStateStore } from '@/providers/runtimeState';
import {
    recoverManagedProviderEndpoint,
} from '@/providers/lifecycle/managedEndpointRecovery';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { createAgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';
import {
    applyConnectedAccountRequestAuthRecovery,
    type ConnectedAccountRequestAuthRecoveryInput,
    type ConnectedAccountRequestAuthTemporaryRetry,
    type ConnectedAccountRequestAuthTemporaryRetryRecordResult,
} from '../connectedServices/requestAuth/ConnectedAccountRequestAuthRecovery';
import {
    materializeFirstPartyConnectedAccountBearer,
    resolveFirstPartyConnectedAccountBinding,
    resolveFirstPartyConnectedAccountServiceId,
} from '../connectedServices/requestAuth/firstPartyConnectedAccountRequestAuthAdapter';
import type {
    QualifiedConnectedAccountEstablishedRuntimeOwner,
} from '../connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { resolveSharedGenerationApplicationProof } from '../connectedServices/accountGroups/generation/resolveSharedGenerationApplicationProof';
import { mapCommittedGenerationApplyResult } from '../connectedServices/accountGroups/generation/mapCommittedGenerationApplyResult';
import {
    buildConnectedServiceAuthGroupCommittedGenerationFact,
    type ConnectedServiceGenerationExecutionAuthority,
} from '../connectedServices/sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import {
    buildProviderInputGenerationEpochId,
} from '@/agent/runtime/session/input/providerInputGenerationAdmission';
import {
    callSessionProviderInputAdmission,
    clearProviderInputAdmissionAfterDurableAdoption,
    continueProviderInputAdmissionReconciliationAfterLifecycleFence,
    createProviderInputAdmissionRecordTracker,
    requestProviderInputAdmissionWithBoundedRetry,
    waitForProviderInputAdmissionGrace,
    type ProviderInputAdmissionRequest,
} from './providerInputAdmissionRuntime';
import {
    InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry,
    type ConnectedServiceAuthGroupGenerationApplyFailure,
    type ConnectedServiceAuthGroupGenerationApplyResult,
} from '../connectedServices/accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { resolvePredictiveSoftSwitchCapability } from '../connectedServices/accountGroups/switching/resolvePredictiveSoftSwitchCapability';
import { evaluatePredictiveSoftSwitchLiveSessionRequirement } from '../connectedServices/accountGroups/switching/predictiveSoftSwitchPolicy';
import { createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator } from '../connectedServices/quotas/createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator';
import { createProviderAccountUsagePersistenceScheduler } from '../connectedServices/accountUsage/persistence';
import {
    recordProviderAccountUsageAdoptionForSession,
    recordProviderAccountUsageSnapshotForSession,
} from '../connectedServices/accountUsage/recordProviderAccountUsageSnapshotForSession';
import {
    createProviderAccountUsageStore,
    isProviderAccountUsageStoreMutationAccepted,
    type ProviderAccountUsageStore,
} from '../connectedServices/accountUsage/store';
import { ConnectedServiceRuntimeAuthSwitchAttemptTracker } from '../connectedServices/runtimeAuth/ConnectedServiceRuntimeAuthSwitchAttemptTracker';
import { buildConnectedServiceRuntimeAuthSwitchAttemptLogContext } from '../connectedServices/runtimeAuth/buildConnectedServiceRuntimeAuthSwitchAttemptLogContext';
import { commitConnectedServiceAccountSwitchSessionEvent } from '../connectedServices/runtimeAuth/commitConnectedServiceAccountSwitchSessionEvent';
import {
    commitRuntimeAuthRecoveryVisibleEventDelivery,
} from '../connectedServices/runtimeAuth/commitConnectedServiceRuntimeAuthRecoverySessionEvent';
import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from '../connectedServices/runtimeAuth/createDaemonConnectedServiceAuthGroupSwitchCoordinator';
import {
    createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator,
} from '../connectedServices/runtimeAuth/createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator';
import type {
    QualifiedConnectedAccountV4Support,
} from '../connectedServices/qualifiedConnectedAccountV4Support';
import {
    authorizeConnectedServiceRuntimeAuthFailureSource,
    handleConnectedServiceRuntimeAuthFailureForSession,
    type RuntimeAuthFailureSourceAuthorization,
} from '../connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession';
import { resolveCurrentRuntimeAuthFailureSource } from '../connectedServices/runtimeAuth/resolveCurrentRuntimeAuthFailureSource';
import { createConnectedServiceSessionAuthSwitchCore } from '../connectedServices/runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { shouldCommitAutomaticGroupApplySessionEvent } from '../connectedServices/runtimeAuth/automaticGroupApplySessionEvents';
import {
    type RuntimeAuthRecoveryDiagnostic,
} from '../connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import { createRuntimeAuthRecoverySchedulerForDaemon } from '../connectedServices/runtimeAuth/createRuntimeAuthRecoverySchedulerForDaemon';
import { ConnectedServiceTemporaryThrottleRetryScheduler } from '../connectedServices/runtimeAuth/temporaryThrottleRetryScheduler';
import {
    resolveInactiveTemporaryThrottleResumeSource,
    type TemporaryThrottleResumeSource,
} from '../connectedServices/runtimeAuth/resolveInactiveTemporaryThrottleResumeSource';
import type {
    ConnectedServiceAccountTransitionVerificationResult,
    ConnectedServiceRuntimeFailureClassification,
} from '../connectedServices/runtimeAuth/types';
import { createConnectedServicePredictiveSwitchGuard } from '../connectedServices/accountGroups/switching/connectedServicePredictiveSwitchGuard';
import {
    isConnectedServiceRestartSignalStaleProcessError,
    requestConnectedServiceSessionRestartSignal,
    type ConnectedServiceDaemonRestartDiagnosticInput,
    type ConnectedServiceDaemonRestartDiagnosticRecord,
} from '../connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import {
    createConnectedServiceSwitchDeferralQueue,
    type ConnectedServiceSwitchTarget,
} from '../connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { requestPlannedRunnerRestart } from '../plannedRunnerRestart/requestPlannedRunnerRestart';
import { createVersionRuntimeRefreshAttemptHandoff } from '../plannedRunnerRestart/versionRuntimeRefreshAttemptHandoff';
import type { PlannedRunnerRestartNotSignaledReason } from '../plannedRunnerRestart/types';
import {
    summarizeSessionRunnerEndpoint,
    restartAllSessionRunnersOnCurrentRuntime,
    restartSessionRunnerOnCurrentRuntime,
    type RestartSessionRunnerCompletion,
} from '../plannedRunnerRestart/restartSessionRunnerOnCurrentRuntime';
import { resolveCurrentSessionRunnerLaunchIdentity } from '../sessionRunnerRuntime/resolveRunnerEntrypointIdentity';
import { resolveSessionRunnerRuntimeState } from '../sessionRunnerRuntime/resolveRuntimeState';
import { logConnectedServiceDaemonRestartDiagnostic } from './logConnectedServiceDaemonRestartDiagnostic';
import {
    nudgeAlreadyRunningExistingSessionPendingQueue,
    probeAlreadyRunningExistingSessionServiceability,
} from './pendingQueueNudge';
import {
    applyTerminalControlServiceabilityProjection,
    resolveRunnerTerminalControlServiceabilityEvidence,
} from './terminalControlServiceabilityProjection';
import { publishReportedTerminalControlServiceability } from './publishReportedTerminalControlServiceability';
import { retireExactTerminalControlServiceability } from '../sessions/retireTerminalControlServiceability';
import { resolveSharedStateRequiredSwitchContinuity } from '../connectedServices/sessionAuthSwitch/sharedStateContinuity';
import { resolveUnsupportedSwitchContinuityErrorCode } from '../connectedServices/sessionAuthSwitch/resolveUnsupportedSwitchContinuityErrorCode';
import { materializeSessionConnectedServiceRuntimeAuthSelection } from '../connectedServices/sessionAuthSwitch/materializeSessionConnectedServiceRuntimeAuthSelection';
import { createSessionConnectedServiceAuthHotApply } from '../connectedServices/sessionAuthSwitch/sessionConnectedServiceAuthHotApply';
import { runSelectionPostSwitchRecovery } from '../connectedServices/sessionAuthSwitch/runSelectionPostSwitchRecovery';
import {
    createSessionConnectedServiceAccountAdoptionVerifier,
    type ConnectedServiceAccountAdoptionVerifier,
} from '../connectedServices/sessionAuthSwitch/sessionConnectedServiceAccountAdoptionVerification';
import { readConnectedServiceChildSelectionsFromEnv } from '../connectedServices/connectedServiceChildEnvironment';
import {
    parseConnectedServiceBindingSelections,
} from '../connectedServices/parseConnectedServicesBindings';
import {
    applyConnectedServiceAuthGenerationToTrackedSession,
    switchSessionConnectedServiceAuth,
    type ConnectedServiceRuntimeAuthApplyReason,
    type SessionConnectedServiceAuthSwitchDiagnostics,
    type SessionConnectedServiceAuthSwitchResult,
} from '../connectedServices/sessionAuthSwitch/switchSessionConnectedServiceAuth';
import { resolveTrackedConnectedServiceSwitchContinuityContext } from '../connectedServices/sessionAuthSwitch/resolveTrackedConnectedServiceSwitchContinuityContext';
import { resolveCommittedGenerationFromRuntimeAuthRecovery } from '../connectedServices/sessionAuthSwitch/resolveCommittedGenerationFromRuntimeAuthRecovery';
import { dispatchConnectedServiceAccountSwitchNotificationAsync } from '../connectedServices/notifications/dispatchConnectedServiceAccountSwitchNotification';
import { resolveDaemonCatalogAgentIdFromBackendTarget } from '../backendTargetRouting';
import type { SshTunnelSupervisor } from '../ssh/tunnels';
import type { ConnectedServiceGroupHomeCleanupScheduler } from '../connectedServices/homes/ConnectedServiceGroupHomeCleanupScheduler';
import { resolveSessionRuntimeSnapshot } from '../sessions/runtimeSnapshot/resolveSessionRuntimeSnapshot';
import {
    readConnectedServiceMaterializationIdentityFromEnvironment,
    readConnectedServiceMaterializationIdentityFromMetadata,
    readConnectedServiceMaterializationIdentityFromSpawnOptions,
    generateConnectedServiceMaterializationIdentityV1,
} from '../connectedServices/materialization/identity';
import { resolveConnectedServiceGroupHomeDir } from '../connectedServices/homes/resolveConnectedServiceHomeDir';
import { disposeSessionHookArtifactsForSession } from '@/plugins/runtime/hooks/session/service';
import { disposeTerminalAttachmentInfoForSession } from '@/terminal/attachment/terminalAttachmentInfo';
import {
    createConnectedServiceContinuationMessageDispatcher,
    type ConnectedServiceContinuationInterruption,
} from '../connectedServices/continuation/createConnectedServiceContinuationMessageDispatcher';
import {
    createConnectedServiceProviderActivityProofRecorder,
    isProviderActivityTurnLifecycleEvent,
} from '../connectedServices/recovery/providerActivityProofRecorder';
import { verifyProviderActivityOutcome } from '../connectedServices/recovery/verifyProviderActivityOutcome';
import { resolveTrackedConnectedServiceBindingsRaw } from '../connectedServices/trackedSessionConnectedServiceBindings';
import type { ConnectedServiceSessionAuthSwitchReason } from '../connectedServices/runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { removeRuntimeAuthFailureReportOutboxItemsForSession } from '../connectedServices/runtimeAuth/reportOutbox/runtimeAuthFailureReportOutbox';
import { createConnectedServiceRecoverySupersessionCleaner } from '../connectedServices/continuation/continuationRecoverySupersession';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';
type HostedWebStaticAssetSyncReason = 'startup' | 'session_spawned' | 'session_webhook' | 'session_exit';

function resolvePositiveIntEnv(raw: string | undefined, fallback: number, bounds: { min: number; max: number }): number {
    const value = (raw ?? '').trim();
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

function resolveTrackedSessionNotificationTitle(tracked: TrackedSession | null | undefined): string | null {
    return getSessionNotificationTitle(() => tracked?.happySessionMetadataFromLocalWebhook ?? null);
}

function normalizeOptionalString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeRuntimeAuthApplyReason(value: unknown): ConnectedServiceRuntimeAuthApplyReason | undefined {
    const normalized = normalizeOptionalString(value);
    switch (normalized) {
        case 'usage_limit':
        case 'soft_threshold':
        case 'same_provider_account_exhausted':
        case 'auth_expired':
        case 'account_changed':
        case 'refresh_failed':
        case 'manual':
        case 'diagnostic':
            return normalized;
        default:
            return undefined;
    }
}

function normalizeNullableGeneration(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : null;
}

function verifyHostedWebStaticAssetArtifact(input: Readonly<{
    files: readonly Readonly<{
        relativePath: string;
        bytes: Uint8Array;
    }>[];
    digest: string;
}>): Readonly<{ ok: true }> | Readonly<{ ok: false; reasonCode: string }> {
    const result = verifyPluginUiArtifactFileSetIntegrityV1({
        files: input.files,
        integrity: {
            digest: input.digest,
            pluginId: 'hosted-web-static-assets',
            contributionId: 'static-asset-file-set',
            artifactKind: 'hostedWebAsset',
        },
    });
    if (result.ok) {
        return { ok: true };
    }
    return { ok: false, reasonCode: result.reasonCode };
}

type RuntimeIdentityReconnectProbeTarget = Readonly<{
    serviceId: ConnectedServiceId;
    expected: Readonly<{
        groupId?: string;
        profileId?: string;
        generation?: number;
    }>;
    fallbackGroupId: string | null;
    fallbackProfileId: string;
    fallbackGeneration: number | null;
}>;

function resolveRuntimeIdentityReconnectProbeTargets(
    tracked: TrackedSession,
): RuntimeIdentityReconnectProbeTarget[] {
    const selections = parseConnectedServiceBindingSelections(resolveTrackedConnectedServiceBindingsRaw(tracked));
    if (selections.length === 0) return [];

    const childSelections = readConnectedServiceChildSelectionsFromEnv(
        tracked.spawnOptions?.environmentVariables ?? {},
    );
    const targets: RuntimeIdentityReconnectProbeTarget[] = [];
    for (const selection of selections) {
        if (selection.kind === 'profile') {
            targets.push({
                serviceId: selection.serviceId,
                expected: { profileId: selection.profileId },
                fallbackGroupId: null,
                fallbackProfileId: selection.profileId,
                fallbackGeneration: null,
            });
            continue;
        }

        const childSelection = childSelections?.get(selection.serviceId);
        const matchingChildSelection = childSelection?.kind === 'group'
            && childSelection.groupId === selection.groupId
            ? childSelection
            : null;
        const fallbackProfileId = normalizeOptionalString(matchingChildSelection?.activeProfileId)
            || normalizeOptionalString(selection.fallbackProfileId);
        if (!fallbackProfileId) continue;
        const fallbackGeneration = normalizeNullableGeneration(matchingChildSelection?.generation);
        targets.push({
            serviceId: selection.serviceId,
            expected: {
                groupId: selection.groupId,
                profileId: fallbackProfileId,
                ...(fallbackGeneration === null ? {} : { generation: fallbackGeneration }),
            },
            fallbackGroupId: selection.groupId,
            fallbackProfileId,
            fallbackGeneration,
        });
    }
    return targets;
}

async function rehydrateConnectedServiceRuntimeIdentityForSessionReport(input: Readonly<{
    credentials: Parameters<typeof createSessionConnectedServiceAuthTransport>[0]['credentials'];
    quotaCoordinator: ConnectedServiceQuotasCoordinator | null;
    sessionId: string;
    tracked: TrackedSession | null;
}>): Promise<void> {
    const sessionId = normalizeOptionalString(input.sessionId);
    const quotaCoordinator = input.quotaCoordinator;
    if (!sessionId || !quotaCoordinator || !input.tracked || !input.credentials) return;

    const targets = resolveRuntimeIdentityReconnectProbeTargets(input.tracked);
    if (targets.length === 0) return;

    const transport = createSessionConnectedServiceAuthTransport({
        credentials: input.credentials,
        sessionId,
    });
    let recordedExactIdentity = false;
    for (const target of targets) {
        let result: Awaited<ReturnType<typeof transport.readConnectedServiceRuntimeIdentity>>;
        try {
            result = await transport.readConnectedServiceRuntimeIdentity({
                serviceId: target.serviceId,
                reason: 'diagnostic',
                requireExactProof: true,
                expected: target.expected,
            });
        } catch (error) {
            logger.debug('[DAEMON RUN] Connected-service runtime identity reconnect probe failed (non-fatal)', {
                sessionId,
                serviceId: target.serviceId,
                error: serializeAxiosErrorForLog(error),
            });
            continue;
        }
        if (!result.ok) continue;

        const response: SessionConnectedServiceAuthReadRuntimeIdentityResponseV1 = result.value;
        if (!response.ok || response.serviceId !== target.serviceId) continue;
        if (response.identity.proofStrength !== 'exact') continue;
        if (response.runtime?.safeToProbe === false) continue;
        if (response.identity.strategy !== 'provider_account_id') continue;

        const providerAccountId = normalizeOptionalString(response.identity.providerAccountId);
        const profileId = normalizeOptionalString(response.runtime?.profileId) || target.fallbackProfileId;
        if (!providerAccountId || !profileId) continue;

        quotaCoordinator.recordRuntimeAccountIdentityFromSnapshot({
            sessionId,
            serviceId: target.serviceId,
            groupId: normalizeOptionalString(response.runtime?.groupId) || target.fallbackGroupId,
            profileId,
            providerAccountId,
            accountLabel: normalizeOptionalString(response.identity.accountLabel) || null,
            observedAtMs: Date.now(),
            source: 'runtime_identity_probe',
            proofStrength: 'exact',
            groupGeneration: response.runtime?.generation === undefined
                ? target.fallbackGeneration
                : normalizeNullableGeneration(response.runtime.generation),
        });
        recordedExactIdentity = true;
    }

    if (!recordedExactIdentity) {
        quotaCoordinator.invalidateRuntimeAccountIdentityForSession(sessionId);
    }
    await quotaCoordinator.flushInBandQuotaPersistence(0);
}

function recordRuntimeAccountIdentityFromVerification(input: Readonly<{
    quotaCoordinator: ConnectedServiceQuotasCoordinator | null;
    verificationInput: Parameters<ConnectedServiceAccountAdoptionVerifier>[0];
    result: ConnectedServiceAccountTransitionVerificationResult;
    observedAtMs: number;
}>): void {
    const sessionId = normalizeOptionalString(input.verificationInput.sessionId);
    if (!sessionId) return;
    const quotaCoordinator = input.quotaCoordinator;
    if (!quotaCoordinator) return;

    const providerAccountId = input.result.status === 'verified'
        ? normalizeOptionalString(input.result.providerAccountId)
        : '';
    const profileId = normalizeOptionalString(input.verificationInput.target.profileId);
    if (!providerAccountId || !profileId) {
        quotaCoordinator.invalidateRuntimeAccountIdentityForSession(sessionId);
        return;
    }

    const groupId = normalizeOptionalString(input.verificationInput.target.groupId);
    const selection = readConnectedServiceChildSelectionsFromEnv(
        input.verificationInput.tracked.spawnOptions?.environmentVariables ?? {},
    )?.get(input.verificationInput.serviceId);
    quotaCoordinator.recordRuntimeAccountIdentityFromSnapshot({
        sessionId,
        serviceId: input.verificationInput.serviceId,
        groupId: groupId || null,
        profileId,
        providerAccountId,
        accountLabel: null,
        observedAtMs: input.observedAtMs,
        source: 'active_account_verification',
        proofStrength: 'exact',
        groupGeneration: selection?.kind === 'group' && selection.groupId === groupId
            ? selection.generation
            : null,
    });
}

function buildManualSwitchRestartDiagnostic(input: Readonly<{
    sessionId: string;
    agentId: string;
    bindings: ConnectedServiceBindingsV1;
}>): ConnectedServiceDaemonRestartDiagnosticInput {
    for (const [serviceId, binding] of Object.entries(input.bindings.bindingsByServiceId)) {
        if (binding.source !== 'connected') continue;
        return {
            trigger: 'manual_switch',
            sessionId: input.sessionId,
            agentId: input.agentId,
            serviceId,
            profileId: binding.profileId ?? null,
            groupId: binding.selection === 'group' ? binding.groupId : null,
            reason: 'manual',
        };
    }
    return {
        trigger: 'manual_switch',
        sessionId: input.sessionId,
        agentId: input.agentId,
        reason: 'manual',
    };
}

function normalizeSwitchTarget(input: Readonly<{
    serviceId?: string | null;
    profileId?: string | null;
    groupId?: string | null;
    generation?: number | null;
}>): ConnectedServiceSwitchTarget {
    return {
        serviceId: typeof input.serviceId === 'string' ? input.serviceId : '',
        profileId: typeof input.profileId === 'string' ? input.profileId : '',
        groupId: typeof input.groupId === 'string' ? input.groupId : '',
        generation: typeof input.generation === 'number' && Number.isFinite(input.generation)
            ? Math.max(0, Math.trunc(input.generation))
            : 0,
    };
}

function findTrackedSessionByHappySessionId(
    trackedSessions: Iterable<TrackedSession>,
    sessionIdRaw: string,
): TrackedSession | null {
    const sessionId = normalizeOptionalString(sessionIdRaw);
    if (!sessionId) return null;
    for (const tracked of trackedSessions) {
        if (normalizeOptionalString(tracked.happySessionId) === sessionId) return tracked;
    }
    return null;
}

function startupInstructionsMarkerMatchesCarrier(
    marker: AgentSessionStartupInstructionsMarkerV1,
    carrier: AgentSessionStartupInstructionsV1,
): boolean {
    return marker.v === carrier.v
        && marker.id === carrier.id
        && marker.revision === carrier.revision;
}

function startupInstructionsMarkersEqual(
    left: AgentSessionStartupInstructionsMarkerV1,
    right: AgentSessionStartupInstructionsMarkerV1,
): boolean {
    return left.v === right.v
        && left.id === right.id
        && left.revision === right.revision;
}

function snapshotTrackedSessionForTemporaryThrottleResume(tracked: TrackedSession): TrackedSession {
    const {
        childProcess: _childProcess,
        activateConnectedAccountSessionBindingOnCanonicalSession:
            _activateConnectedAccountSessionBindingOnCanonicalSession,
        spawnStartupCanonicalSessionId: _spawnStartupCanonicalSessionId,
        spawnStartupReadinessFailure: _spawnStartupReadinessFailure,
        ...snapshot
    } = tracked;
    return {
        ...snapshot,
        ...(tracked.spawnOptions ? { spawnOptions: { ...tracked.spawnOptions } } : {}),
    };
}

type ManagedServerClaimSnapshot = Readonly<{
    countsByStatePath: ReadonlyMap<string, number>;
    hasUnknownTrackedClaims: boolean;
    inFlightTurnStatePaths: ReadonlySet<string>;
}>;

function isTrackedManagedServerSession(
    tracked: TrackedSession,
    descriptor: ManagedServerClaimDescriptor,
): boolean {
    const routedAgentId = resolveDaemonCatalogAgentIdFromBackendTarget(tracked.spawnOptions?.backendTarget);
    if (routedAgentId === descriptor.agentId) return true;
    const processCommand = normalizeOptionalString(tracked.processCommand);
    return processCommand ? descriptor.isExpectedProcessCommand(processCommand) : false;
}

async function summarizeManagedServerClaims(
    trackedSessions: Iterable<TrackedSession>,
    isTurnInFlight?: (sessionId: string) => boolean,
): Promise<ManagedServerClaimSnapshot> {
    const descriptors = await listManagedServerClaimDescriptors();
    const countsByStatePath = new Map<string, number>();
    const inFlightTurnStatePaths = new Set<string>();
    let hasUnknownTrackedClaims = false;
    for (const tracked of trackedSessions) {
        for (const descriptor of descriptors) {
            if (!isTrackedManagedServerSession(tracked, descriptor)) continue;
            const statePath = normalizeOptionalString(
                tracked.spawnOptions?.environmentVariables?.[descriptor.statePathEnvKey],
            );
            if (!statePath) {
                hasUnknownTrackedClaims = true;
                break;
            }
            countsByStatePath.set(statePath, (countsByStatePath.get(statePath) ?? 0) + 1);
            // Same single pass that counts claims also aggregates which state paths have an in-flight
            // turn — so the in-flight set is a structural subset of the claimed state paths (a state
            // path can never report in-flight while its claim count is 0). Fail-closed: a missing
            // session id / probe simply omits the state path (the kill proceeds).
            const happySessionId = normalizeOptionalString(tracked.happySessionId);
            if (happySessionId && isTurnInFlight?.(happySessionId) === true) {
                inFlightTurnStatePaths.add(statePath);
            }
            break;
        }
    }
    return { countsByStatePath, hasUnknownTrackedClaims, inFlightTurnStatePaths };
}

function resolveConnectedServiceMaterializationIdentityFromTrackedSession(
    tracked: TrackedSession | null | undefined,
): ConnectedServiceMaterializationIdentityV1 | null {
    return readConnectedServiceMaterializationIdentityFromSpawnOptions(tracked?.spawnOptions ?? null)
        ?? readConnectedServiceMaterializationIdentityFromEnvironment(
            tracked?.spawnOptions?.environmentVariables ?? null,
        );
}

function pathEqualsOrIsInside(parentPath: string, childPath: string): boolean {
    const parent = resolve(parentPath);
    const child = resolve(childPath);
    if (parent === child) return true;
    const pathFromParent = relative(parent, child);
    return Boolean(pathFromParent)
        && !pathFromParent.startsWith('..')
        && !isAbsolute(pathFromParent);
}

function trackedSessionUsesRequestedSharedGroupAuthSurface(input: Readonly<{
    tracked: TrackedSession | null;
    activeServerDir: string;
    agentId: CatalogAgentId;
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string;
}>): boolean {
    const env = input.tracked?.spawnOptions?.environmentVariables ?? {};
    const selection = readConnectedServiceChildSelectionsFromEnv(env)?.get(input.serviceId) ?? null;
    if (
        selection?.kind !== 'group'
        || selection.groupId !== input.groupId
        || selection.activeProfileId !== input.activeProfileId
    ) {
        return false;
    }

    const expectedGroupHome = resolveConnectedServiceGroupHomeDir({
        activeServerDir: input.activeServerDir,
        serviceId: input.serviceId,
        groupId: input.groupId,
        agentId: input.agentId,
    });
    return Object.values(env).some((value) => {
        const pathValue = normalizeOptionalString(value);
        return pathValue ? pathEqualsOrIsInside(expectedGroupHome, pathValue) : false;
    });
}

function buildTrackedExistingSessionResumeSeed(input: Readonly<{
    tracked: TemporaryThrottleResumeSource;
    sessionId: string;
}>): Readonly<{
    spawnOptions: SpawnSessionOptions;
    vendorResumeId: string;
    defaultOptions: SpawnSessionOptions;
}> | null {
    const spawnOptions = input.tracked.spawnOptions;
    if (!spawnOptions || !normalizeOptionalString(spawnOptions.directory)) return null;

    const resumeFromOptions = normalizeOptionalString(spawnOptions.resume);
    const resumeFromTracked = normalizeOptionalString(input.tracked.vendorResumeId);
    const {
        resume: _resume,
        sessionId: _sessionId,
        ...spawnOptionsWithoutResume
    } = spawnOptions;

    return {
        spawnOptions,
        vendorResumeId: resumeFromTracked,
        defaultOptions: {
            ...spawnOptionsWithoutResume,
            ...(resumeFromOptions ? { resume: resumeFromOptions } : {}),
            existingSessionId: input.sessionId,
            sessionId: undefined,
            approvedNewDirectoryCreation: true,
        },
    };
}

function toConnectedServiceAuthSwitchDiagnosticError(error: unknown): string {
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    const serialized = serializeAxiosErrorForLog(error);
    if (typeof serialized === 'string') return serialized;
    try {
        return JSON.stringify(serialized);
    } catch {
        return String(error);
    }
}

function attachConnectedServiceAuthSwitchDiagnostics(
    result: SessionConnectedServiceAuthSwitchResult,
    diagnostics: SessionConnectedServiceAuthSwitchDiagnostics | undefined,
): SessionConnectedServiceAuthSwitchResult {
    if (!diagnostics || Object.keys(diagnostics).length === 0) return result;
    return {
        ...result,
        diagnostics: {
            ...(!result.ok ? result.diagnostics : {}),
            ...diagnostics,
        },
    } as SessionConnectedServiceAuthSwitchResult;
}

function logConnectedServiceAuthSwitchResult(input: Readonly<{
    sessionId: string;
    agentId: string;
    serviceIds: readonly string[];
    result: SessionConnectedServiceAuthSwitchResult;
}>): void {
    logger.info('[DAEMON RUN] Connected-service session auth switch result', {
        sessionId: input.sessionId,
        agentId: input.agentId,
        serviceIds: input.serviceIds,
        ok: input.result.ok,
        ...(input.result.ok
            ? {
                action: input.result.action,
                continuityByServiceId: input.result.continuityByServiceId,
                ...(input.result.verificationByServiceId
                    ? { verificationByServiceId: input.result.verificationByServiceId }
                    : {}),
            }
            : {
                errorCode: input.result.errorCode,
                serviceId: input.result.serviceId,
                diagnostics: input.result.diagnostics,
            }),
    });
}

function readConnectedServiceBindingsOrEmpty(raw: unknown): ConnectedServiceBindingsV1 {
    const parsed = ConnectedServiceBindingsV1Schema.safeParse(raw);
    return parsed.success ? parsed.data : { v: 1, bindingsByServiceId: {} };
}

function connectedServiceAuthGroupGenerationApplyFailure(input: Readonly<{
    errorCode: string;
    serviceId: ConnectedServiceId;
    failurePhase: string;
}>): ConnectedServiceAuthGroupGenerationApplyFailure {
    return {
        ok: false,
        errorCode: input.errorCode,
        serviceId: input.serviceId,
        diagnostics: {
            failurePhase: input.failurePhase,
        },
    };
}

let lastTerminalControlServiceabilityObservation = 0;

function nextTerminalControlServiceabilityObservation(): number {
    lastTerminalControlServiceabilityObservation = Math.max(
        Date.now(),
        lastTerminalControlServiceabilityObservation + 1,
    );
    return lastTerminalControlServiceabilityObservation;
}

async function publishCurrentTerminalControlServiceability(input: Readonly<{
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    happyHomeDir: string;
    sessionId: string;
    serviceability:
        | Awaited<ReturnType<typeof probeAlreadyRunningExistingSessionServiceability>>
        | Readonly<{ state: 'recoverable_unservable' | 'unknown'; reason: string }>;
}>): Promise<boolean> {
    const observedAt = nextTerminalControlServiceabilityObservation();
    const attachment = await readTerminalHostAttachmentInfo({
        happyHomeDir: input.happyHomeDir,
        sessionId: input.sessionId,
    });
    if (attachment?.version !== 2) return false;
    const evidence = resolveRunnerTerminalControlServiceabilityEvidence({
        serviceability: input.serviceability,
        attachmentId: attachment.attachmentId,
        observedAt,
    });
    const rawSession = await fetchSessionByIdCompat({
        token: input.credentials.token,
        sessionId: input.sessionId,
    });
    if (!rawSession) return false;
    const attachmentBeforeUpdate = await readTerminalHostAttachmentInfo({
        happyHomeDir: input.happyHomeDir,
        sessionId: input.sessionId,
    });
    if (attachmentBeforeUpdate?.version !== 2 || attachmentBeforeUpdate.attachmentId !== attachment.attachmentId) return false;
    await updateSessionMetadataWithRetry({
        token: input.credentials.token,
        credentials: input.credentials,
        sessionId: input.sessionId,
        rawSession,
        updater: (metadata) => applyTerminalControlServiceabilityProjection({ metadata, evidence }),
    });
    return true;
}

async function persistSessionConnectedServiceBindings(input: Readonly<{
    token: string;
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    sessionId: string;
    normalizedBindings: ConnectedServiceBindingsV1;
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
}>): Promise<void> {
    const rawSession = await fetchSessionByIdCompat({
        token: input.token,
        sessionId: input.sessionId,
    });
    if (!rawSession) {
        throw new Error('session_not_found');
    }
    await updateSessionMetadataWithRetry({
        token: input.token,
        credentials: input.credentials,
        sessionId: input.sessionId,
        rawSession,
        updater: (metadata) => {
            const existingUpdatedAt = typeof metadata.connectedServicesUpdatedAt === 'number'
                && Number.isFinite(metadata.connectedServicesUpdatedAt)
                ? metadata.connectedServicesUpdatedAt
                : 0;
            const materializationIdentity =
                input.connectedServiceMaterializationIdentityV1
                ?? readConnectedServiceMaterializationIdentityV1FromMetadata(metadata);
            const nextMetadata = {
                ...metadata,
                connectedServices: input.normalizedBindings,
                connectedServicesUpdatedAt: Math.max(Date.now(), existingUpdatedAt + 1),
            };
            return materializationIdentity
                ? writeConnectedServiceMaterializationIdentityV1ToMetadata(
                    nextMetadata,
                    materializationIdentity,
                )
                : nextMetadata;
        },
    });
}

async function publishProviderAccountUsageRecordIdToSessionMetadata(input: Readonly<{
    token: string;
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    sessionId: string;
    recordId: ProviderAccountUsageRecordId | string;
}>): Promise<void> {
    const rawSession = await fetchSessionByIdCompat({
        token: input.token,
        sessionId: input.sessionId,
    });
    if (!rawSession) {
        throw new Error('session_not_found');
    }
    await updateSessionMetadataWithRetry({
        token: input.token,
        credentials: input.credentials,
        sessionId: input.sessionId,
        rawSession,
        updater: (metadata) => writeProviderAccountUsageRecordIdToMetadata(metadata, {
            recordId: input.recordId,
            updatedAtMs: Date.now(),
        }),
    });
}

function connectedServiceBindingToEffectiveBinding(
    serviceId: ConnectedServiceId,
    binding: ConnectedServiceBindingsV1['bindingsByServiceId'][string],
): ConnectedServiceSwitchEffectiveBinding | null {
    if (binding.source !== 'connected') return null;
    if (binding.selection === 'group') {
        return {
            source: 'connected',
            selection: 'group',
            serviceId,
            profileId: normalizeOptionalString(binding.profileId) || null,
            groupId: binding.groupId,
        };
    }
    return {
        source: 'connected',
        selection: 'profile',
        serviceId,
        profileId: binding.profileId,
        groupId: null,
    };
}

async function repairMissingConnectedServiceMaterializationIdentityForSpawn(input: Readonly<{
    token: string;
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    sessionId: string;
    agentId: CatalogAgentId;
    connectedServices: ConnectedServiceBindingsV1;
    vendorResumeId: string | null;
}>): Promise<ConnectedServiceMaterializationIdentityV1 | null> {
    const vendorResumeId = normalizeOptionalString(input.vendorResumeId);
    if (!vendorResumeId) return null;

    const connectedBindings: ConnectedServiceSwitchEffectiveBinding[] = [];
    for (const [serviceIdRaw, binding] of Object.entries(input.connectedServices.bindingsByServiceId)) {
        const serviceId = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
        if (!serviceId.success) continue;
        const effective = connectedServiceBindingToEffectiveBinding(serviceId.data, binding);
        if (effective) connectedBindings.push(effective);
    }
    if (connectedBindings.length === 0) return null;

    for (const binding of connectedBindings) {
        const continuity = await resolveConnectedServiceSwitchContinuity(input.agentId, {
            sessionId: input.sessionId,
            agentId: input.agentId,
            serviceId: binding.serviceId,
            previousBinding: binding,
            nextBinding: binding,
            fromBindings: input.connectedServices,
            toBindings: input.connectedServices,
            vendorResumeId,
        });
        if (continuity.mode !== 'restart_same_home') return null;
    }

    const connectedServiceMaterializationIdentityV1 = generateConnectedServiceMaterializationIdentityV1();
    await persistSessionConnectedServiceBindings({
        token: input.token,
        credentials: input.credentials,
        sessionId: input.sessionId,
        normalizedBindings: input.connectedServices,
        connectedServiceMaterializationIdentityV1,
    });
    return connectedServiceMaterializationIdentityV1;
}

export async function resolveContinuationResumePromptMode(input: Readonly<{
    serviceId?: ConnectedServiceId;
    groupId?: string | null;
    explicit?: unknown;
    readAccountSettings?: () => unknown;
    loadGroupPolicy?: () => Promise<unknown> | unknown;
}>): Promise<SessionContinuationResumePromptModeV1> {
    const readAccountSettings = input.readAccountSettings
        ?? (() => getActiveAccountSettingsSnapshot()?.settings ?? null);
    return await resolveRoutedUsageLimitRecoveryResumePromptMode({
        explicit: input.explicit,
        accountSettings: readAccountSettings(),
        loadGroupPolicy: input.loadGroupPolicy,
    });
}

export function resolveConnectedServiceContinuationOriginId(input: Readonly<{
    source: 'daemon_report' | 'scheduler_retry';
    activeTurnId?: string | null;
    reportId?: string | null;
}>): string | null {
    if (input.source === 'scheduler_retry') return null;
    const activeTurnId = input.activeTurnId?.trim() ?? '';
    if (activeTurnId) return activeTurnId;
    const reportId = input.reportId?.trim() ?? '';
    return reportId || null;
}

function readContinuationCustomResumePrompt(
    settings: AccountSettings | null | undefined,
): string | null {
    return settings?.usageLimitRecoverySettingsV1?.customResumePrompt ?? null;
}

function createConnectedServiceContinuationHandler(params: Readonly<{
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    interruptedOriginId?: string | null;
    resumePromptMode: SessionContinuationResumePromptModeV1;
    customResumePrompt?: string | null;
    recoveryKind?: ConnectedServiceRuntimeFailureClassification['kind'] | null;
    resolveInterruption: (input: Readonly<{
        sessionId: string;
        action: 'hot_applied' | 'restart_requested';
        switchReason?: ConnectedServiceSessionAuthSwitchReason;
    }>) => ConnectedServiceContinuationInterruption;
}>) {
    const continuationMessageDispatcher = createConnectedServiceContinuationMessageDispatcher({
        credentials: params.credentials,
        sendMessage: sendSessionMessage,
    });
    return async (input: Readonly<{
        tracked: Pick<TrackedSession, 'activeTurnId'>;
        sessionId: string;
        attemptId: string;
        normalizedBindings: ConnectedServiceBindingsV1;
        serviceIds: ReadonlySet<ConnectedServiceId>;
        action: 'hot_applied' | 'restart_requested';
        switchReason?: ConnectedServiceSessionAuthSwitchReason;
    }>) => {
        const interruptedOriginId = params.interruptedOriginId?.trim() ?? '';
        if (!interruptedOriginId) return;
        await continuationMessageDispatcher.enqueueInterruptedOriginContinuation({
            sessionId: input.sessionId,
            attemptId: input.attemptId,
            interruptedOriginId,
            interruption: params.resolveInterruption({
                sessionId: input.sessionId,
                action: input.action,
                switchReason: input.switchReason,
            }),
            resumePromptMode: params.resumePromptMode,
            customResumePrompt: params.customResumePrompt,
            recoveryKind: params.recoveryKind,
        });
    };
}

function createSelectionPostSwitchRecoveryHandler(params: Readonly<{
    getTrackedSessions: () => ReadonlyArray<TrackedSession>;
    isTurnInFlight?: (sessionId: string) => boolean;
}>) {
    return async (input: Readonly<{
        tracked: TrackedSession;
        sessionId: string;
        normalizedBindings: ConnectedServiceBindingsV1;
        serviceIds: ReadonlySet<ConnectedServiceId>;
        action: 'hot_applied' | 'restart_requested';
        runtimeAuthSelectionsByServiceId?: ReadonlyMap<ConnectedServiceId, unknown>;
    }>) => {
        const claimSnapshot = await summarizeManagedServerClaims(
            params.getTrackedSessions(),
            params.isTurnInFlight,
        );
        return await runSelectionPostSwitchRecovery({
            ...input,
            runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId,
            countTrackedClaimsForStatePath: (statePath) => {
                const normalized = normalizeOptionalString(statePath);
                return normalized ? (claimSnapshot.countsByStatePath.get(normalized) ?? 0) : 0;
            },
            hasUnknownTrackedClaims: claimSnapshot.hasUnknownTrackedClaims,
            hasInFlightTurnForStatePath: (statePath) => {
                const normalized = normalizeOptionalString(statePath);
                return normalized ? claimSnapshot.inFlightTurnStatePaths.has(normalized) : false;
            },
        });
    };
}

export function resolveConnectedServiceContinuationInterruptionForSwitch(input: Readonly<{
    sessionId: string;
    interruptedSessionId?: string | null;
    action: 'hot_applied' | 'restart_requested';
    switchReason?: ConnectedServiceSessionAuthSwitchReason;
    groupSwitchTriggerReason?: string | null;
    failureDriven?: boolean;
    turnDeferralQueue: ReturnType<typeof createConnectedServiceSwitchDeferralQueue>;
}>): ConnectedServiceContinuationInterruption {
    if (input.interruptedSessionId && input.sessionId !== input.interruptedSessionId) {
        return 'none';
    }
    if (
        input.interruptedSessionId === input.sessionId
        && (
            input.failureDriven === true
            || input.groupSwitchTriggerReason === 'usage_limit'
            || input.groupSwitchTriggerReason === 'auth_expired'
            || input.groupSwitchTriggerReason === 'refresh_failed'
        )
    ) {
        return 'provider_failed_turn';
    }
    if (input.action === 'hot_applied' || input.switchReason === 'pre_turn_group_policy') {
        return 'none';
    }
    return input.turnDeferralQueue.getTurnLifecycleState(input.sessionId).forcedSwitchInterruptedLiveTurn
        ? 'forced_turn_cancelled'
        : 'clean_boundary';
}

export async function resolveSessionConnectedServiceSwitchContinuity(input: Readonly<{
    sessionId: string;
    agentId: CatalogAgentId;
    serviceId: ConnectedServiceId;
    previousBinding: ConnectedServiceSwitchEffectiveBinding | null;
    nextBinding: ConnectedServiceSwitchEffectiveBinding;
    tracked?: TrackedSession | null;
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
    vendorResumeId?: string | null;
    fromBindingsRaw: unknown;
    toBindings: ConnectedServiceBindingsV1;
    accountSettings: AccountSettings | null;
    runtimeAuthSelection?: unknown;
    targetMaterializedRoot?: string | null;
    targetMaterializedEnv?: Readonly<Record<string, string>> | null;
    cwd?: string | null;
    candidatePersistedSessionFile?: string | null;
}>) {
    const connectedServiceMaterializationIdentityV1 = input.connectedServiceMaterializationIdentityV1
        ?? resolveConnectedServiceMaterializationIdentityFromTrackedSession(input.tracked ?? null);
    const vendorResumeId = normalizeOptionalString(input.vendorResumeId ?? input.tracked?.vendorResumeId);
    const continuity = await resolveConnectedServiceSwitchContinuity(input.agentId, {
        sessionId: input.sessionId,
        agentId: input.agentId,
        serviceId: input.serviceId,
        previousBinding: input.previousBinding,
        nextBinding: input.nextBinding,
        fromBindings: readConnectedServiceBindingsOrEmpty(input.fromBindingsRaw),
        toBindings: input.toBindings,
        connectedServiceMaterializationIdentityV1,
        ...(vendorResumeId ? { vendorResumeId } : {}),
        ...(input.targetMaterializedRoot ? { targetMaterializedRoot: input.targetMaterializedRoot } : {}),
        ...(input.targetMaterializedEnv ? { targetMaterializedEnv: input.targetMaterializedEnv } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.candidatePersistedSessionFile
            ? { candidatePersistedSessionFile: input.candidatePersistedSessionFile }
            : {}),
        ...(input.runtimeAuthSelection === undefined ? {} : { runtimeAuthSelection: input.runtimeAuthSelection }),
    });
    if (continuity.mode === 'hot_apply') {
        return { mode: 'hot_apply' as const };
    }
    if (continuity.mode === 'restart_same_home') {
        return { mode: 'restart_rematerialize' as const };
    }
    if (continuity.mode === 'restart_shared_state_required') {
        return await resolveSharedStateRequiredSwitchContinuity({
            agentId: input.agentId,
            accountSettings: input.accountSettings,
            warnings: continuity.reason ? [continuity.reason] : [],
            serviceId: input.serviceId,
            targetMaterializedRoot: input.targetMaterializedRoot ?? null,
            targetMaterializedEnv: input.targetMaterializedEnv ?? null,
            materializationIdentity: connectedServiceMaterializationIdentityV1 ?? null,
            vendorResumeId: vendorResumeId || null,
            cwd: input.cwd ?? null,
            candidatePersistedSessionFile: input.candidatePersistedSessionFile ?? null,
        });
    }
    return {
        mode: 'unsupported' as const,
        errorCode: resolveUnsupportedSwitchContinuityErrorCode(continuity.reason),
        warnings: continuity.reason ? [continuity.reason] : [],
        ...(continuity.diagnostics ? { diagnostics: continuity.diagnostics } : {}),
    };
}

function tryReadSessionMetadataRecord(input: Readonly<{
    rawSession: Readonly<{
        metadata?: unknown;
        encryptionMode?: unknown;
        metadataLayoutVersion?: unknown;
        ownerMetadata?: unknown;
        dataEncryptionKey?: unknown;
    }>;
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
}>): Record<string, unknown> | null {
    return tryDecryptSessionOwnerMetadataView({
        credentials: input.credentials,
        rawSession: input.rawSession,
    });
}

async function resolvePersistedConnectedServiceSwitchSessionMetadata(input: Readonly<{
    token: string;
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    sessionId: string;
}>): Promise<Record<string, unknown> | null> {
    const token = input.token.trim();
    if (!token) return null;
    const rawSession = await fetchSessionByIdCompat({
        token,
        sessionId: input.sessionId,
    }).catch(() => null);
    if (!rawSession) return null;
    return tryReadSessionMetadataRecord({
        rawSession,
        credentials: input.credentials,
    });
}

async function resolveInactiveConnectedServiceSessionContext(input: Readonly<{
    token: string;
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    sessionId: string;
}>): Promise<Readonly<{
    agentId: CatalogAgentId;
    connectedServices: ConnectedServiceBindingsV1;
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
    vendorResumeId?: string;
    /**
     * Session working directory (from the decrypted session metadata `path`). The inactive-switch
     * shared-state continuity check needs it to drive the source-aware resume-reachability probe and
     * to reconstruct the deterministic target materialized root; without it the switch fail-closes a
     * genuinely-resumable inactive session.
     */
    cwd?: string;
    /**
     * Provider-owned persisted vendor session-file hint derived from inactive session metadata.
     * Shared daemon continuity code must obtain this through the backend catalog, not by reading
     * provider-specific metadata fields directly.
     */
    candidatePersistedSessionFile?: string;
}> | null> {
    const rawSession = await fetchSessionByIdCompat({
        token: input.token,
        sessionId: input.sessionId,
    });
    const metadata = rawSession
        ? tryReadSessionMetadataRecord({
            rawSession,
            credentials: input.credentials,
        })
        : null;
    if (!metadata) return null;
    const inferredAgentId = inferAgentIdFromSessionMetadata(metadata);
    const agentId = resolveCatalogAgentId(inferredAgentId);
    const materializationIdentity = readConnectedServiceMaterializationIdentityFromMetadata(metadata);
    const vendorResumeId = resolveVendorResumeIdFromSessionMetadata(agentId, metadata);
    const cwd = normalizeOptionalString(metadata.path);
    const candidatePersistedSessionFile =
        resolveConnectedServiceCandidatePersistedSessionFile(agentId, metadata) ?? '';
    return {
        agentId,
        connectedServices: readConnectedServiceBindingsOrEmpty(metadata.connectedServices),
        ...(materializationIdentity
            ? { connectedServiceMaterializationIdentityV1: materializationIdentity }
            : {}),
        ...(vendorResumeId ? { vendorResumeId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(candidatePersistedSessionFile ? { candidatePersistedSessionFile } : {}),
    };
}

async function applyAlreadyRunningExistingSessionRuntimeSnapshot(input: Readonly<{
    sessionId: string;
    incomingOptions: SpawnSessionOptions;
    pidToTrackedSession: Map<number, TrackedSession>;
    readPersistedSessionMetadata: (sessionId: string) => Promise<Record<string, unknown> | null>;
}>): Promise<void> {
    const metadata = await input.readPersistedSessionMetadata(input.sessionId);
    if (!metadata) return;

    const agentId = inferAgentIdFromSessionMetadata(metadata);
    const persistedVendorResumeId = agentId
        ? resolveVendorResumeIdFromSessionMetadata(agentId, metadata)
        : null;

    for (const tracked of input.pidToTrackedSession.values()) {
        if (tracked.happySessionId !== input.sessionId) continue;
        const incomingOptions: SpawnSessionOptions = {
            ...tracked.spawnOptions,
            ...input.incomingOptions,
            existingSessionId: input.sessionId,
        };
        const runtimeSnapshot = resolveSessionRuntimeSnapshot({
            incomingOptions,
            persistedMetadata: metadata,
            persistedVendorResumeId,
            trackedSpawnOptions: tracked.spawnOptions ?? null,
            trackedVendorResumeId: tracked.vendorResumeId ?? null,
        });
        tracked.spawnOptions = runtimeSnapshot.spawnOptions;
        const vendorResumeId = runtimeSnapshot.snapshot.vendorResumeId?.value;
        if (vendorResumeId) {
            tracked.vendorResumeId = vendorResumeId;
        }
    }
}

async function resolveRespawnSessionOptionsWithRuntimeSnapshot(input: Readonly<{
    sessionId: string;
    spawnOptions: SpawnSessionOptions;
    vendorResumeId: string;
    defaultOptions: SpawnSessionOptions;
    readPersistedSessionMetadata: (sessionId: string) => Promise<Record<string, unknown> | null>;
}>): Promise<SpawnSessionOptions> {
    const metadata = await input.readPersistedSessionMetadata(input.sessionId);
    if (!metadata) return input.defaultOptions;

    const agentId = inferAgentIdFromSessionMetadata(metadata);
    const persistedVendorResumeId = agentId
        ? resolveVendorResumeIdFromSessionMetadata(agentId, metadata)
        : null;

    return resolveSessionRuntimeSnapshot({
        incomingOptions: input.defaultOptions,
        persistedMetadata: metadata,
        persistedVendorResumeId,
        trackedSpawnOptions: input.spawnOptions,
        trackedVendorResumeId: input.vendorResumeId,
    }).spawnOptions;
}

export async function commitConnectedServiceHotApplyRuntimeTarget(input: Readonly<{
    tracked: TrackedSession;
    agentId: CatalogAgentId;
    materializationIdentity: ConnectedServiceMaterializationIdentityV1;
    registry: ConnectedServiceRuntimeRegistry;
    acceptedConnectedServicesBindingsRaw: ConnectedServiceBindingsV1;
    acceptedConnectedServiceSelectionsEnv: Readonly<Record<string, string>>;
    afterRegister?: (registration: Readonly<{
        previousTarget: ConnectedServiceRuntimeTarget | null;
        registeredTarget: ConnectedServiceRuntimeTarget;
    }>) => void | Promise<void>;
}>): Promise<void> {
    let previousTarget: ConnectedServiceRuntimeTarget | null = null;
    try {
        previousTarget = input.registry.getByPid(input.tracked.pid);
        input.registry.registerTarget({
            pid: input.tracked.pid,
            agentId: input.agentId,
            sessionId: input.tracked.happySessionId,
            sessionDirectory: input.tracked.spawnOptions?.directory,
            materializationKey: input.materializationIdentity.id,
            connectedServiceMaterializationIdentityV1: input.materializationIdentity,
            connectedServicesBindingsRaw: input.acceptedConnectedServicesBindingsRaw,
            connectedServiceSelectionsEnv: input.acceptedConnectedServiceSelectionsEnv,
        });
        const registeredTarget = input.registry.getByPid(input.tracked.pid);
        if (!registeredTarget) {
            throw new Error('Connected-service runtime target registration was unavailable after hot apply');
        }
        await input.afterRegister?.({ previousTarget, registeredTarget });
    } catch (error) {
        input.registry.unregisterPid(input.tracked.pid);
        throw error;
    }
}

export async function startDaemonSessionControlRuntime(
    params: Readonly<{
        machineId: string;
        runtimeId?: string;
        credentials: NonNullable<Parameters<typeof executeSpawnSessionRequest>[0]['credentials']>;
        api: Parameters<typeof executeSpawnSessionRequest>[0]['api'];
        loadLocalHandoffMetadataByVendorResumeId: Parameters<typeof executeSpawnSessionRequest>[0]['loadLocalHandoffMetadataByVendorResumeId'];
        connectedServicesMaterializationBaseDir: string;
        getConnectedServiceRefreshCoordinator: () => ConnectedServiceRefreshCoordinator | null;
        getConnectedServiceQuotasCoordinator: () => ConnectedServiceQuotasCoordinator | null;
        resolveQualifiedConnectedAccountV4Support?: () =>
            QualifiedConnectedAccountV4Support;
        resolveQualifiedConnectedAccountRequestAuthTransport?: (
            service: QualifiedConnectedAccountServiceRef,
        ) => QualifiedConnectedAccountPeerOperationTransport;
        establishedConnectedAccountRuntimeOwner?: Pick<
            QualifiedConnectedAccountEstablishedRuntimeOwner,
            'invokeWithReceipt'
        >;
        connectedServiceRuntimeRegistry?: ConnectedServiceRuntimeRegistry;
        pidToTrackedSession: Map<number, TrackedSession>;
        pidToAwaiter: Map<number, (session: TrackedSession) => void>;
        pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
        pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
        getApiMachineForSessions: () => ApiMachineClient | null;
        onLocalServicesPreviewRoutesReady?: (routes: LocalServicePreviewRoutes) => void;
        onLocalServicesRoutesReady?: (routes: DaemonLocalServicesMachineRpcRoutes) => void;
        onProviderManagedLocalServicesOwnerReady?: (owner: ProviderManagedLocalServicesOwner) => void;
        onBrowserDiagnosticsRoutesReady?: (routes: BrowserDiagnosticsRoutes) => void;
        onBrowserRecordingRoutesReady?: (routes: BrowserRecordingRoutes) => void;
        onBrowserControlRoutesReady?: (routes: BrowserDaemonControlRoutes) => void;
        onBrowserContextRoutesReady?: (routes: BrowserContextRoutes) => void;
        onBrowserAutomationRoutesReady?: (routes: BrowserAutomationRoutes) => void;
        onSimulatorPreviewRoutesReady?: (routes: SimulatorPreviewRoutes) => void;
        spawnResourceCleanupByPid: Map<number, () => void | Promise<void>>;
        sessionAttachCleanupByPid: Map<number, () => Promise<void>>;
        connectedServicesRestartRequestedPids: Set<number>;
        loadTerminalHostAdapters?: () => Promise<Readonly<Partial<Record<TerminalHostAdapter['kind'], TerminalHostAdapter>>>>;
        startupTerminalRecovery?: Readonly<{
            disconnectedTerminalHostCandidates: ReadonlyArray<DisconnectedTerminalHostCandidate>;
            unresolvedTerminalHostSessionIds: ReadonlyArray<string>;
        }>;
        startupManagedProviderRecoveryCandidates?: NonNullable<
            Awaited<ReturnType<
                typeof import('../sessions/reattachFromMarkers').reattachTrackedSessionsFromMarkers
            >>['managedProviderRecoveryCandidates']
        >;
        connectedServiceGroupHomeCleanupScheduler?: Pick<ConnectedServiceGroupHomeCleanupScheduler, 'cleanupPendingDeletedGroupHomes'>;
        connectedServiceMaterializedHomeCleanupScheduler?: Readonly<{
            cleanupPendingMaterializedHomes: () => Promise<unknown>;
        }>;
        beforeShutdown: Parameters<typeof startDaemonControlServer>[0]['beforeShutdown'];
        onHappySessionWebhook: Parameters<typeof startDaemonControlServer>[0]['onHappySessionWebhook'];
        setOnTrackedSessionPidPromoted?: (
            handler: (input: Readonly<{
                fromPid: number;
                toPid: number;
                trackedSession: TrackedSession;
            }>) => void,
        ) => void;
        admitPersistedTakeover?: Parameters<
            typeof startDaemonControlServer
        >[0]['admitPersistedTakeover'];
        sshTunnelSupervisor?: Pick<SshTunnelSupervisor, 'ensureTunnel' | 'listTunnels' | 'probeTunnel' | 'releaseTunnel' | 'stopTunnel'>;
        requestShutdown: (source: ShutdownSource, errorMessage?: string) => void;
        requestSelfRestart?: Parameters<typeof startDaemonControlServer>[0]['requestSelfRestart'];
        pluginChangeService?: DaemonPluginChangeService;
        resolveManagedPurposeBindingIntent?: Parameters<
            typeof executeSpawnSessionRequest
        >[0]['resolveManagedPurposeBindingIntent'];
        activateSessionPurposeBindings?: Parameters<
            typeof executeSpawnSessionRequest
        >[0]['activateSessionPurposeBindings'];
        activatePurposeBindings?: ConnectedAccountPurposeBindingOwner[
            'activatePurposeBindings'
        ];
        resolveHostedWebStaticAssetContributionRegistry?: () => Promise<ResolvedContributionRegistry>;
        liveStreamCaptureRegistry?: MachineLiveStreamCaptureRegistry;
        simulatorInputLeaseManager?: SimulatorInputLeaseManager;
        browserSidecarControlAdapterFactory?: BrowserSidecarControlAdapterFactory;
        // Product browser-use policy decision for sidecar startup. Missing/malformed decisions
        // fail closed; the browser.sidecar feature gate is availability only, not consent.
        resolveBrowserUseAllowed?: () => boolean;
        resolveServerFeaturesSnapshot?: () => Promise<CliServerFeaturesSnapshot | undefined> | CliServerFeaturesSnapshot | undefined;
        // OWNER-GATE test seam: inject a browser daemon feature gate whose cached snapshot is
        // deterministic. Defaults to a real gate over the shared server-features snapshot source.
        browserDaemonFeatureGate?: BrowserDaemonFeatureGate;
        // Optional capture producer for the BRW-11 context routes. Defaults to a fail-closed
        // source (the chromiumSidecar control adapter exposes no CDP capture producer), so in
        // production the routes construct but capture stays unavailable until a managed source
        // lands (FP-BRW-SOURCE-1). The daemon QA seam injects a fake producer to prove the
        // wired context round-trip without a managed Chromium.
        browserContextSourceFactory?: (
            input: Readonly<{ machineId: string }>,
        ) => BrowserContextSource;
        resolveBrowserRecordingStartContext?: BrowserRecordingDaemonRuntimeOptions['resolveStartContext'];
        browserRecordingStreamFrameEncoderFactory?: BrowserRecordingDaemonRuntimeOptions['streamFrameEncoderFactory'];
        // BA-4: desktop Wry `nativeViewCapture` recording producer. Provided ONLY by a desktop daemon
        // entrypoint that can reach the native `desktop_browser_capture_recording_frame` Tauri command
        // (the daemon->native IPC boundary). Absent on headless/non-desktop hosts, so the desktop
        // recording cell stays fail-closed (`browser_recording_capture_adapter_missing`) — never a
        // PMS-stream producer mapped onto a desktop view.
        browserRecordingNativeViewCapture?: BrowserRecordingDaemonRuntimeOptions['nativeViewCapture'];
        // BA-4 desktop daemon entrypoint seam: the canonical desktop recording-frame invoke
        // (`desktop_browser_capture_recording_frame`, A2-registered) reachable on a Wry-capable host.
        // When supplied (and `browserRecordingNativeViewCapture` is not directly injected), the runtime
        // builds the `nativeViewCapture` producer from it via the canonical daemon→native transport —
        // no parallel native binding. Absent on headless hosts, so the desktop recording cell stays
        // fail-closed (`browser_recording_capture_adapter_missing`).
        desktopBrowserRecordingNativeViewCaptureInvoke?: DesktopBrowserRecordingFrameCaptureInvoke;
        // BRW-6: exposes the daemon profile/storage purge owner so the daemon's session-deleted
        // signal and logout transition can drive the on-disk purge. Mirrors the established
        // on*RoutesReady callback pattern; does not introduce a new lifecycle bus.
        onBrowserStoragePurgeOwnerReady?: (owner: DaemonBrowserStoragePurgeOwner) => void;
        // True once daemon shutdown has begun. Threaded into the control server + recovery schedulers
        // so recovery handlers/timers do not run switch/restart work into a tearing-down daemon.
        isShuttingDown?: () => boolean;
        reattachedAgentRequestAuthPidSafetyDependencies?: NonNullable<
            Parameters<typeof isPidSafeHappySessionProcess>[1]
        >;
        processEnv: NodeJS.ProcessEnv;
    }>,
): Promise<Readonly<{
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => Promise<StopSessionResult>;
    isSessionAlreadyRunning: (sessionId: string) => Promise<boolean>;
    onChildExited: (pid: number, exit: { reason: string; code: number | null; signal: string | null }) => void;
    controlPort: number;
    controlToken: string;
    stopControlServer: () => Promise<void>;
    connectedServiceAuthGroupPreTurnSwitchCoordinator: Readonly<{
        switchBeforeTurn: (input: Readonly<{
            sessionId?: string;
            serviceId: string;
            groupId: string;
            reason: 'usage_limit' | 'soft_threshold' | 'same_provider_account_exhausted' | 'auth_expired' | 'account_changed' | 'refresh_failed';
        }>) => Promise<unknown>;
        applyCommittedGeneration: (input: Readonly<{
            sessionId: string;
            serviceId: string;
            groupId: string;
            activeProfileId: string;
            generation: number;
            credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
            reason: string;
            allowRestart?: boolean;
        }>) => Promise<Readonly<{
            status: string;
            activeProfileId?: string | null;
            generation: number;
            errorCode?: string;
        }>>;
    }>;
    connectedServicePredictiveSwitchGuard: ReturnType<typeof createConnectedServicePredictiveSwitchGuard>;
    connectedServiceRuntimeAuthApplyCapabilityResolver: (input: Readonly<{
        sessionId: string;
        agentId?: string | null;
        serviceId?: ConnectedServiceId;
        groupId?: string;
        reason?: 'same_provider_account_exhausted';
    }>) => Promise<ConnectedServiceRuntimeAuthApplyCapability>;
    consumeCommittedAuthGroupGeneration: (
        input: Parameters<ConnectedServiceAuthGroupGenerationConsumer['consume']>[0],
    ) => ReturnType<ConnectedServiceAuthGroupGenerationConsumer['consume']>;
    requestConnectedServiceRefreshRestartSignal: (signalParams: Readonly<{
        pid: number;
        delayMs: number;
        preferProcessGroup?: boolean;
        shouldSignal?: () => boolean;
        onSignalFailure: (error: unknown) => void;
        restartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticInput;
        recordRestartDiagnostic?: (record: ConnectedServiceDaemonRestartDiagnosticRecord) => void;
        nowMs?: () => number;
    }>) => Promise<Readonly<{ signaled: boolean }>>;
    cancelConnectedServiceRuntimeAuthRecovery: (input: Readonly<{
        sessionId: string;
        attemptId: string;
    }>) => Promise<unknown>;
    retryTemporaryThrottleNow: (input: Readonly<{ sessionId: string }>) => Promise<unknown>;
    reconcileConnectedServicesProjection: (notification: ConnectedServicesProjectionNotification) => Promise<void>;
    awaitAgentSessionOpen: ReturnType<
        typeof createAgentRuntimeSessionBridgeRoutes
    >['awaitAgentSessionOpen'];
    installExternalSessionHostOperations(
        operations: ExternalSessionHostOperationSet,
    ): ReturnType<
        ReturnType<typeof createExternalSessionHostOperationOwner>['install']
    >;
    providerAccountUsageStore: Pick<ProviderAccountUsageStore, 'recordSnapshot' | 'resolveRecordId' | 'resolveBySource'>;
    connectedServiceRuntimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
    refreshBrowserRouteOwners: () => Promise<void>;
    purgeBrowserStorageForSessionDeleted: (sessionId: string) => Promise<void>;
    purgeBrowserStorageForLogout: () => Promise<void>;
}>> {
    const connectedServiceRuntimeRegistry =
        params.connectedServiceRuntimeRegistry ?? new ConnectedServiceRuntimeRegistry();
    let advanceProviderInputAdmissionsAfterHotApplyRegistration: (input: Readonly<{
        previousTarget: ConnectedServiceRuntimeTarget | null;
        registeredTarget: ConnectedServiceRuntimeTarget;
    }>) => void = () => {};
    const resolveHotApplyRuntimeTargetContext = (tracked: TrackedSession) => {
        const agentId = resolveTrackedSessionCatalogAgentId(tracked);
        const materializationIdentity =
            resolveConnectedServiceMaterializationIdentityFromTrackedSession(tracked);
        return agentId && materializationIdentity
            ? { agentId, materializationIdentity }
            : null;
    };
    const registerHotApplyRuntimeTarget = async (input: Readonly<{
        tracked: TrackedSession;
        runtimeAuthSelectionsByServiceId: ReadonlyMap<ConnectedServiceId, unknown>;
        acceptedConnectedServicesBindingsRaw: ConnectedServiceBindingsV1;
        acceptedConnectedServiceSelectionsEnv: Readonly<Record<string, string>>;
    }>): Promise<void> => {
        const context = resolveHotApplyRuntimeTargetContext(input.tracked);
        if (!context) return;
        await commitConnectedServiceHotApplyRuntimeTarget({
            ...input,
            ...context,
            registry: connectedServiceRuntimeRegistry,
            afterRegister: (registration) => {
                advanceProviderInputAdmissionsAfterHotApplyRegistration(registration);
                params.getConnectedServiceRefreshCoordinator()?.registerSpawnTarget({
                    pid: input.tracked.pid,
                    agentId: context.agentId,
                    sessionId: input.tracked.happySessionId,
                    connectedServicesBindingsRaw: input.acceptedConnectedServicesBindingsRaw,
                    materializationKey: context.materializationIdentity.id,
                    connectedServiceSelectionsEnv: input.acceptedConnectedServiceSelectionsEnv,
                });
                params.getConnectedServiceQuotasCoordinator()?.registerSpawnTarget({
                    pid: input.tracked.pid,
                    agentId: context.agentId,
                    sessionId: input.tracked.happySessionId,
                    connectedServicesBindingsRaw: input.acceptedConnectedServicesBindingsRaw,
                    connectedServiceSelectionsEnv: input.acceptedConnectedServiceSelectionsEnv,
                });
            },
        });
    };
    const registerTrackedConnectedServiceRuntimeTarget = async (tracked: TrackedSession): Promise<void> => {
        const agentId = resolveTrackedSessionCatalogAgentId(tracked);
        const materializationIdentity = resolveConnectedServiceMaterializationIdentityFromTrackedSession(tracked);
        if (!agentId || !materializationIdentity) return;
        const environment = tracked.spawnOptions?.environmentVariables ?? {};
        connectedServiceRuntimeRegistry.registerTarget({
            pid: tracked.pid,
            agentId,
            sessionId: tracked.happySessionId,
            sessionDirectory: tracked.spawnOptions?.directory,
            materializationKey: materializationIdentity.id,
            connectedServiceMaterializationIdentityV1: materializationIdentity,
            connectedServicesBindingsRaw: tracked.spawnOptions?.connectedServices,
            connectedServiceSelectionsEnv: environment,
        }, { source: 'bootstrap' });
    };
    await Promise.all(Array.from(params.pidToTrackedSession.values()).map(registerTrackedConnectedServiceRuntimeTarget));
    const spawnConcurrencyGate = createSpawnConcurrencyGate(
        resolvePositiveIntEnv(params.processEnv.HAPPIER_DAEMON_MAX_CONCURRENT_SPAWNS, 0, { min: 0, max: 64 }),
    );
    const spawnRequestCoalescer = createSpawnRequestCoalescer({
        recentSuccessTtlMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_DAEMON_SPAWN_RECENT_SUCCESS_TTL_MS,
            2_000,
            { min: 0, max: 60_000 },
        ),
        pendingTimeoutTtlMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_DAEMON_SPAWN_PENDING_TIMEOUT_TTL_MS,
            DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS,
            { min: 0, max: 60 * 60_000 },
        ),
    });
    const isSessionRunnerActive = async (sessionIdRaw: string): Promise<boolean> =>
        await isSessionRunnerActiveInDaemon({
            sessionId: sessionIdRaw,
            trackedSessions: params.pidToTrackedSession.values(),
        });
    let latestConnectedServiceProjectionSnapshot: ConnectedServiceProjectionSnapshot | null = null;
    let unsubscribeConnectedServiceRuntimeTargetRegistrations = () => {};
    const connectedServiceRuntimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const providerAccountUsageStore = createProviderAccountUsageStore();
    const providerAccountUsagePersistence = createProviderAccountUsagePersistenceScheduler({
        api: params.api,
        credentials: params.credentials,
        randomBytes,
        serverScope: configuration.activeServerDir,
        accountScope: 'active-account',
        now: () => Date.now(),
        resolveServerContract: () =>
            params.getApiMachineForSessions()
                ?.getSessionSyncPendingInputServerContractResult()
            ?? null,
    });
    const connectedServiceAuthGroupSwitchLeases = new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry();
    const connectedServiceRuntimeAuthSwitchAttempts = new ConnectedServiceRuntimeAuthSwitchAttemptTracker({
        nowMs: () => Date.now(),
        windowMs: 60_000,
    });
    let connectedServicePredictiveSwitchGuard: ReturnType<typeof createConnectedServicePredictiveSwitchGuard> | null = null;
    const connectedServiceSessionAuthSwitchCore = createConnectedServiceSessionAuthSwitchCore();
    const recordConnectedServiceRestartDiagnostic = (record: ConnectedServiceDaemonRestartDiagnosticRecord) => {
        logConnectedServiceDaemonRestartDiagnostic(logger, record);
    };
    const commitConnectedServiceAccountSwitchSessionEventWithNotification = (
        input: Readonly<{
            sessionId: string;
            event: unknown;
            logContext: string;
            reasonFallback?: string;
        }>,
    ): void => {
        void commitConnectedServiceAccountSwitchSessionEvent({
            credentials: params.credentials,
            sessionId: input.sessionId,
            event: input.event,
            listConnectedServiceProfiles: params.api.listConnectedServiceProfiles.bind(params.api),
        }).catch((error) => {
            logger.debug(`[DAEMON RUN] Failed to commit ${input.logContext} connected-service account switch session event (non-fatal)`, error);
        });

        const record = input.event && typeof input.event === 'object'
            ? input.event as Record<string, unknown>
            : null;
        // Applied switches notify for BOTH event shapes: the raw account-switch record
        // and the rich automatic group-switch event — previously the group-apply path
        // committed the transcript event but silently skipped the notification.
        if (
            !record
            || (
                record.type !== 'connected_service_account_switch'
                && record.type !== 'connected_service_auth_group_switch'
            )
        ) return;
        const serviceIdParsed = ConnectedServiceIdSchema.safeParse(record.serviceId);
        if (!serviceIdParsed.success) return;
        const reason = normalizeOptionalString(record.reason) || input.reasonFallback || 'unknown';
        const fromProfileId = normalizeOptionalString(record.fromProfileId) || null;
        const toProfileId = normalizeOptionalString(record.toProfileId) || null;
        // Reason-based suppression (background/manual) is owned by the dispatcher via
        // the ONE visibility policy — no per-reason branching here.
        if (fromProfileId && toProfileId && fromProfileId === toProfileId) return;
        const trackedForNotification = Array.from(params.pidToTrackedSession.values())
            .find((child) => child.happySessionId === input.sessionId) ?? null;
        const settingsSnapshot = getActiveAccountSettingsSnapshot();
        void dispatchConnectedServiceAccountSwitchNotificationAsync({
            settings: settingsSnapshot?.settings ?? null,
            settingsSecretsReadKeys: settingsSnapshot?.settingsSecretsReadKeys ?? [],
            expoPushSender: params.api.push(),
            runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
            listConnectedServiceProfiles: params.api.listConnectedServiceProfiles.bind(params.api),
            source: {
                sessionId: input.sessionId,
                sessionTitle: resolveTrackedSessionNotificationTitle(trackedForNotification),
                serviceId: serviceIdParsed.data,
                groupId: normalizeOptionalString(record.groupId),
                fromProfileId,
                toProfileId,
                reason,
                limitCategory: normalizeOptionalString(record.limitCategory) || null,
                retryAfterMs: typeof record.retryAfterMs === 'number' && Number.isFinite(record.retryAfterMs)
                    ? Math.max(0, Math.trunc(record.retryAfterMs))
                    : null,
                quotaScope: normalizeOptionalString(record.quotaScope) || null,
                providerLimitId: normalizeOptionalString(record.providerLimitId) || null,
                action: null,
            },
            nowMs: () => Date.now(),
            dedupeWindowMs: resolvePositiveIntEnv(
                params.processEnv.HAPPIER_CONNECTED_SERVICES_ACCOUNT_SWITCH_NOTIFICATION_DEDUPE_MS,
                60_000,
                { min: 0, max: 24 * 60 * 60_000 },
            ),
        }).catch((error) => {
            logger.debug(`[DAEMON RUN] ${input.logContext} connected-service account switch notification failed (non-fatal)`, error);
        });
    };
    const requestAuthGroupQuotaFreshnessMs = resolvePositiveIntEnv(
        params.processEnv.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_QUOTA_FRESHNESS_MS,
        5 * 60_000,
        { min: 1_000, max: 60 * 60_000 },
    );
    const preTurnConnectedServiceAuthGroupSwitchCoordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
        api: params.api,
        runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
        accountUsageStore: providerAccountUsageStore,
        leases: connectedServiceAuthGroupSwitchLeases,
        quotaFreshnessMs: requestAuthGroupQuotaFreshnessMs,
        nowMs: () => Date.now(),
        resolveCredentialRevision: (serviceId, profileId) => (
            latestConnectedServiceProjectionSnapshot
                ?.resolveCredentialRevision(serviceId, profileId)
            ?? null
        ),
        restartSession: async () => ({ ok: true }),
        probeQuotaSnapshotsForGroup: async (input) => {
            await params.getConnectedServiceQuotasCoordinator()?.probeGroupQuotaSnapshots(input);
        },
    });
    const qualifiedRequestAuthGroupSwitchCoordinator =
        params.resolveQualifiedConnectedAccountV4Support
            ? createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
                token: params.credentials.token,
                quotaFreshnessMs: requestAuthGroupQuotaFreshnessMs,
                nowMs: () => Date.now(),
                applyGeneration: async () => ({ ok: true }),
            })
            : null;
    const switchAfterConnectedAccountRequestAuthFailure = async (input: Readonly<{
        service: QualifiedConnectedAccountServiceRef;
        legacyServiceId: ConnectedServiceId;
        failure: Parameters<
            ConnectedAccountRequestAuthRecoveryInput[
                'switchAfterClassifiedFailure'
            ]
        >[0];
    }>): Promise<unknown> => {
        const support =
            params.resolveQualifiedConnectedAccountV4Support?.()
            ?? 'absent';
        if (
            support === 'advertised'
            && qualifiedRequestAuthGroupSwitchCoordinator
        ) {
            return await qualifiedRequestAuthGroupSwitchCoordinator
                .switchAfterClassifiedFailure({
                    ...input.failure,
                    serviceId: input.service,
                });
        }
        if (support !== 'absent') return null;
        return await preTurnConnectedServiceAuthGroupSwitchCoordinator
            .switchAfterClassifiedFailure({
                ...input.failure,
                serviceId: input.legacyServiceId,
            });
    };
    let connectedAccountRequestAuthHttpPort: number | null = null;
    const requireConnectedAccountRequestAuthHttpPort = (): number => {
        const value = connectedAccountRequestAuthHttpPort;
        if (
            typeof value !== 'number'
            || !Number.isSafeInteger(value)
            || value < 1
            || value > 65535
        ) {
            throw new Error(
                'connected_account_request_auth_http_port_unavailable',
            );
        }
        return value;
    };
    const connectedAccountRequestAuthRegistry =
        createConnectedAccountRequestAuthSubjectRegistry();
    const resolveRequestAuthAccountFingerprint = (
        resolved: ConnectedAccountRequestAuthResolvedBinding,
        projection: ConnectedServiceProjectionSnapshot | null,
    ): string | null => {
        if (!projection) return null;
        const serviceId = resolveFirstPartyConnectedAccountServiceId(resolved.account.service);
        if (!serviceId) return null;
        if (!resolved.group) {
            const revision = projection.resolveCredentialRevision(
                serviceId,
                resolved.account.accountId,
            );
            return revision
                ? JSON.stringify([serviceId, resolved.account.accountId, revision])
                : null;
        }
        const group = projection.groups.find((candidate) => (
            candidate.serviceId === serviceId
            && candidate.groupId === resolved.group?.groupId
        ));
        if (!group?.activeProfileId) return null;
        const revision = projection.resolveCredentialRevision(serviceId, group.activeProfileId);
        return revision
            ? JSON.stringify([
                serviceId,
                group.activeProfileId,
                revision,
                group.groupId,
                group.generation,
            ])
            : null;
    };
    const recordConnectedAccountRequestAuthTemporaryRetry = async (
        input: ConnectedAccountRequestAuthTemporaryRetry,
    ): Promise<ConnectedAccountRequestAuthTemporaryRetryRecordResult> => {
        const serviceId = resolveFirstPartyConnectedAccountServiceId(
            input.service,
        );
        const quotaCoordinator = params.getConnectedServiceQuotasCoordinator();
        const unavailable = (
            reason: Extract<
                ConnectedAccountRequestAuthTemporaryRetryRecordResult,
                Readonly<{ status: 'unavailable' }>
            >['reason'],
        ): ConnectedAccountRequestAuthTemporaryRetryRecordResult => {
            logger.warn(
                '[DAEMON RUN] Connected-account request-auth backoff unavailable',
                {
                    event: 'connected_account_request_auth_backoff_unavailable',
                    reason,
                    service: input.service,
                    accountId: input.accountId,
                    groupId: input.groupId,
                    groupGeneration: input.groupGeneration,
                    limitCategory: input.limitCategory,
                    quotaScope: input.quotaScope,
                },
            );
            return { status: 'unavailable', reason };
        };
        if (!serviceId || !quotaCoordinator) {
            return unavailable('backoff_owner_unavailable');
        }
        try {
            quotaCoordinator.recordRequestAuthProviderBackoff({
                serviceId,
                profileId: input.accountId,
                groupId: input.groupId,
                groupGeneration: input.groupGeneration,
                limitCategory: input.limitCategory,
                quotaScope: input.quotaScope,
                retryAfterMs: input.retryAfterMs,
                resetAtMs: input.resetAtMs,
                providerCode: input.providerCode,
            });
            return { status: 'recorded' };
        } catch {
            return unavailable('backoff_record_failed');
        }
    };
    const connectedAccountRequestAuthService =
        createConnectedAccountRequestAuthService({
            resolveCurrentBinding: (binding) => (
                latestConnectedServiceProjectionSnapshot
                    ? resolveFirstPartyConnectedAccountBinding(
                        binding,
                        latestConnectedServiceProjectionSnapshot,
                    )
                    : null
            ),
            materializeBearer: async ({ resolved, materialization }) => (
                await materializeFirstPartyConnectedAccountBearer({
                    resolved,
                    materialization,
                    transport:
                        params.resolveQualifiedConnectedAccountRequestAuthTransport
                            ? params.resolveQualifiedConnectedAccountRequestAuthTransport(
                                resolved.account.service,
                            )
                            : params.resolveQualifiedConnectedAccountV4Support?.() === 'advertised'
                                ? Object.freeze({ kind: 'v4' as const })
                                : (() => {
                                    throw new Error(
                                        'request_auth_capability_indeterminate',
                                    );
                                })(),
                    ...(params.establishedConnectedAccountRuntimeOwner
                        ? {
                            establishedRuntimeOwner:
                                params.establishedConnectedAccountRuntimeOwner,
                        }
                        : {}),
                    resolveCredential: async ({ serviceId, profileId }) => {
                        const resolutions = await resolveConnectedServiceCredentialResolutions({
                            credentials: params.credentials,
                            api: params.api,
                            bindings: [{ serviceId, profileId }],
                        });
                        const resolution = resolutions.get(serviceId) ?? null;
                        // Exact v0.2.1 credentials remain readable for passive compatibility, but
                        // authority-bearing consumers must have a server revision fence.
                        return resolution?.revisionSemantics === 'revisioned'
                            ? resolution
                            : null;
                    },
                })
            ),
            refreshAfterAuthFailure: async ({ resolved, failure }) => {
                const before = resolveRequestAuthAccountFingerprint(
                    resolved,
                    latestConnectedServiceProjectionSnapshot,
                );
                const serviceId = resolveFirstPartyConnectedAccountServiceId(
                    resolved.account.service,
                );
                if (!serviceId) return { status: 'denied' };

                const recovery = await applyConnectedAccountRequestAuthRecovery({
                    resolved,
                    failure,
                    refreshCredential: async (input) => Boolean(
                        await params.getConnectedServiceRefreshCoordinator()
                            ?.refreshConnectedServiceCredentialForQuota({
                                serviceId,
                                profileId: input.account.accountId,
                                force: true,
                                expectedCredentialRevision:
                                    input.expectedCredentialRevision,
                            })
                            .catch(() => null) ?? null
                    ),
                    switchAfterClassifiedFailure: async (input) => (
                        await switchAfterConnectedAccountRequestAuthFailure({
                            service: resolved.account.service,
                            legacyServiceId: serviceId,
                            failure: input,
                        }).catch(() => null)
                    ),
                    recordTemporaryRetry:
                        recordConnectedAccountRequestAuthTemporaryRetry,
                });
                if (recovery.effect === 'stale_context') {
                    return { status: 'stale_context' };
                }
                if (recovery.effect === 'temporary_retry_unavailable') {
                    return { status: 'denied' };
                }
                const projection = await fetchConnectedServiceProjectionSnapshot()
                    .catch(() => latestConnectedServiceProjectionSnapshot);
                const after = resolveRequestAuthAccountFingerprint(resolved, projection);
                return {
                    status: !after || after !== before
                        ? 'current_changed'
                        : 'current_unchanged',
                };
            },
            reportQuotaFailure: async ({ resolved, failure }) => {
                const before = resolveRequestAuthAccountFingerprint(
                    resolved,
                    latestConnectedServiceProjectionSnapshot,
                );
                const serviceId = resolveFirstPartyConnectedAccountServiceId(
                    resolved.account.service,
                );
                if (!serviceId) return { status: 'denied' };
                const recovery = await applyConnectedAccountRequestAuthRecovery({
                    resolved,
                    failure,
                    refreshCredential: async () => false,
                    switchAfterClassifiedFailure: async (input) => (
                        await switchAfterConnectedAccountRequestAuthFailure({
                            service: resolved.account.service,
                            legacyServiceId: serviceId,
                            failure: input,
                        }).catch(() => null)
                    ),
                    recordTemporaryRetry:
                        recordConnectedAccountRequestAuthTemporaryRetry,
                });
                if (recovery.effect === 'stale_context') {
                    return { status: 'stale_context' };
                }
                if (recovery.effect === 'temporary_retry_unavailable') {
                    return { status: 'denied' };
                }
                const projection = await fetchConnectedServiceProjectionSnapshot()
                    .catch(() => latestConnectedServiceProjectionSnapshot);
                const after = resolveRequestAuthAccountFingerprint(resolved, projection);
                return {
                    status: !after || after !== before
                        ? 'current_changed'
                        : 'current_unchanged',
                };
            },
            // Request-auth route errors are strict safe codes and the control server never logs
            // request/response bodies. Access material is therefore kept out of every diagnostic
            // sink instead of retaining a daemon-global unbounded set of decrypted secrets.
        });
    const replaceConnectedServiceProjectionSnapshot = (
        snapshot: ConnectedServiceProjectionSnapshot | null,
    ): ConnectedServiceProjectionSnapshot | null => {
        const previous = latestConnectedServiceProjectionSnapshot;
        latestConnectedServiceProjectionSnapshot = snapshot;
        connectedAccountRequestAuthService.reconcileCredentialLeases({
            isCurrent: (account, credentialRevision) => {
                if (!snapshot) return false;
                const serviceId = resolveFirstPartyConnectedAccountServiceId(account.service);
                return serviceId !== null
                    && snapshot.resolveCredentialRevision(serviceId, account.accountId)
                        === credentialRevision;
            },
        });
        return previous;
    };
    const fetchConnectedServiceProjectionSnapshot = async (
        signal?: AbortSignal,
    ): Promise<ConnectedServiceProjectionSnapshot> => {
        const profile = await fetchAccountProfile({
            token: params.credentials.token,
            ...(signal ? { signal } : {}),
        });
        const snapshot = parseConnectedServiceProjectionSnapshot({
            connectedServicesV2: profile.connectedServicesV2,
            connectedServiceCredentialRevisionsV1:
                profile.connectedServiceCredentialRevisionsV1,
        });
        replaceConnectedServiceProjectionSnapshot(snapshot);
        return snapshot;
    };
    const resolveCanonicalTrackedSessionId = (pid: number): string => {
        const session = params.pidToTrackedSession.get(pid);
        const sessionId = typeof session?.happySessionId === 'string' ? session.happySessionId.trim() : '';
        if (!sessionId || /^PID-\d+$/.test(sessionId)) {
            return '';
        }
        return sessionId;
    };

    let onChildExited: (
        pid: number,
        exit: { reason: string; code: number | null; signal: string | null },
    ) => Promise<void> = async () => {};
    let releaseExecutionRunAuthorityForRunnerExit: (input: Readonly<{
        runnerPid: number;
        runnerIdentity: object;
    }>) => Promise<void> = async () => {};
    let observeConnectedServiceRestartProcessMissing: ((tracked: TrackedSession) => void) | null = null;
    const shutdownCancellationDomains = createDaemonShutdownCancellationDomains();
    const ensureCurrentProjectionForRequestAuth =
        async (): Promise<void> => {
            if (latestConnectedServiceProjectionSnapshot) return;
            await fetchConnectedServiceProjectionSnapshot(
                shutdownCancellationDomains.daemonWorkSignal,
            );
        };
    const recoverReattachedAgentRequestAuth = async (): Promise<void> => {
        const reattached = [...params.pidToTrackedSession.values()]
            .filter((tracked) => tracked.reattachedFromDiskMarker === true);
        if (reattached.length === 0) return;
        const activateSessionPurposeBindings =
            params.activateSessionPurposeBindings;
        if (!activateSessionPurposeBindings) {
            logger.debug(
                '[DAEMON RUN] Reattached Agent request-auth recovery left authority unavailable',
                {
                    candidateCount: reattached.length,
                    reason: 'session_purpose_binding_owner_unavailable',
                },
            );
            return;
        }

        let runtimeRegistryLease: Awaited<
            ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>
        > | null = null;
        try {
            runtimeRegistryLease =
                await acquireAuthoritativePluginRuntimeRegistryLease({
                    happyHomeDir: configuration.happyHomeDir,
                });
            const contributions =
                runtimeRegistryLease.registry.contributes;
            for (const tracked of reattached) {
                const expectedPid = tracked.pid;
                const sessionId =
                    normalizeOptionalString(tracked.happySessionId);
                const agentId =
                    resolveTrackedSessionCatalogAgentId(tracked);
                const materializationIdentity =
                    resolveConnectedServiceMaterializationIdentityFromTrackedSession(
                        tracked,
                    );
                const expectedProcessCommandHash =
                    normalizeOptionalString(
                        tracked.processCommandHash,
                    );
                const expectedProcessStartTimeMs =
                    tracked.processStartTimeMs;
                const parsedBindings =
                    ConnectedServiceBindingsV1Schema.safeParse(
                        tracked.spawnOptions?.connectedServices,
                    );
                const unavailable = (reason: string): void => {
                    logger.debug(
                        '[DAEMON RUN] Reattached Agent request-auth recovery left authority unavailable',
                        {
                            sessionId,
                            agentId,
                            reason,
                        },
                    );
                };
                if (
                    !sessionId
                    || /^PID-\d+$/u.test(sessionId)
                    || !agentId
                    || !materializationIdentity
                    || !parsedBindings.success
                    || !expectedProcessCommandHash
                    || typeof expectedProcessStartTimeMs !== 'number'
                    || !Number.isFinite(expectedProcessStartTimeMs)
                ) {
                    unavailable(
                        'reattached_agent_identity_or_bindings_unavailable',
                    );
                    continue;
                }

                const purposeSnapshot =
                    resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                        agentId,
                        bindings: parsedBindings.data,
                        contributions,
                    });
                if (!purposeSnapshot?.requestAuthUses?.length) {
                    continue;
                }
                const requestAuthPurposeBindings =
                    resolveQualifiedRequestAuthPurposeBindingsForAgentSpawn({
                        agentId,
                        bindings: parsedBindings.data,
                        contributions,
                    });
                if (requestAuthPurposeBindings.length === 0) {
                    continue;
                }

                const materializedRootDir =
                    resolveConnectedServiceMaterializedRootDir({
                        baseDir:
                            params.connectedServicesMaterializationBaseDir,
                        agentId,
                        materializationKey:
                            materializationIdentity.id,
                    });
                const capabilityPath =
                    resolveConnectedAccountRequestAuthCapabilityPath(
                        materializedRootDir,
                    );
                const trackedCapabilityPath = normalizeOptionalString(
                    tracked.spawnOptions?.environmentVariables?.[
                        CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV
                    ],
                );
                if (trackedCapabilityPath !== capabilityPath) {
                    unavailable(
                        'request_auth_capability_path_mismatch',
                    );
                    continue;
                }
                const previousCapability =
                    await inspectConnectedAccountRequestAuthCapabilityFile({
                        path: capabilityPath,
                        materializedRootDir,
                    });
                if (
                    !previousCapability
                    || previousCapability.materializationId
                        !== materializationIdentity.id
                ) {
                    unavailable(
                        'request_auth_capability_recovery_facts_unavailable',
                    );
                    continue;
                }

                let sessionPurposeBindingLease: ReturnType<
                    typeof activateSessionPurposeBindings
                >;
                try {
                    sessionPurposeBindingLease =
                        activateSessionPurposeBindings({
                            sessionId,
                            purposes: purposeSnapshot.purposes,
                            bindings: purposeSnapshot.bindings,
                        });
                } catch {
                    unavailable(
                        'session_purpose_binding_activation_failed',
                    );
                    continue;
                }

                const redactionLease =
                    createProviderRedactionLease({ values: [] });
                const subject =
                    scopeConnectedAccountSessionPurposeBindingLease({
                        lease: sessionPurposeBindingLease,
                        subjectId:
                            `${sessionPurposeBindingLease.subjectId}/agent:${agentId}`,
                        uses: purposeSnapshot.requestAuthUses,
                        registerRedaction: redactionLease.add,
                    });
                const previousAttachCleanup =
                    params.sessionAttachCleanupByPid.get(expectedPid)
                    ?? null;
                let capability:
                    ConnectedAccountRequestAuthCapabilityDescriptor
                    | null = null;
                let capabilityRetired = false;
                let leaseDisposed = false;
                let redactionClosed = false;
                const retireRecoveredAuthority =
                    async (): Promise<void> => {
                        if (!leaseDisposed) {
                            leaseDisposed = true;
                            sessionPurposeBindingLease.dispose();
                        }
                        const currentCapability = capability;
                        if (
                            currentCapability
                            && !capabilityRetired
                        ) {
                            capabilityRetired = true;
                            await connectedAccountRequestAuthRegistry
                                .retire(currentCapability);
                        }
                        if (!redactionClosed) {
                            redactionClosed = true;
                            redactionLease.close();
                        }
                    };
                let lifecycleCleanupStarted = false;
                let lifecycleCleanupPromise:
                    Promise<void>
                    | null = null;
                const lifecycleCleanup =
                    async (): Promise<void> => {
                        lifecycleCleanupStarted = true;
                        lifecycleCleanupPromise ??= (async () => {
                            await retireRecoveredAuthority();
                            await previousAttachCleanup?.();
                        })();
                        await lifecycleCleanupPromise;
                    };

                // The existing reattach lifecycle owns retirement before the
                // replacement capability is published. PID promotion transfers
                // this same composed cleanup entry with the tracked session.
                params.sessionAttachCleanupByPid.set(
                    expectedPid,
                    lifecycleCleanup,
                );
                try {
                    capability =
                        await connectedAccountRequestAuthRegistry.activate({
                            subject,
                            materializedRootDir,
                            materializationId:
                                materializationIdentity.id,
                            httpPort:
                                requireConnectedAccountRequestAuthHttpPort(),
                            finalizeStagedAuthorityCommit:
                                async (_descriptor, commit) => {
                                    const isExactProcessCurrent =
                                        await isPidSafeHappySessionProcess({
                                            pid: expectedPid,
                                            expectedProcessCommandHash,
                                            expectedProcessStartTimeMs,
                                        }, params
                                            .reattachedAgentRequestAuthPidSafetyDependencies);
                                    if (
                                        !isExactProcessCurrent
                                        || lifecycleCleanupStarted
                                        || tracked.pid !== expectedPid
                                        || params.pidToTrackedSession.get(
                                            expectedPid,
                                        ) !== tracked
                                        || params.sessionAttachCleanupByPid.get(
                                            expectedPid,
                                        ) !== lifecycleCleanup
                                        || tracked.processCommandHash
                                            !== expectedProcessCommandHash
                                        || tracked.processStartTimeMs
                                            !== expectedProcessStartTimeMs
                                        || !subject.isCurrent()
                                    ) {
                                        throw new Error(
                                            'reattached_agent_process_identity_changed',
                                        );
                                    }
                                    commit();
                                },
                        });
                    const currentPid = tracked.pid;
                    if (
                        lifecycleCleanupStarted
                        || currentPid !== expectedPid
                        || params.pidToTrackedSession.get(expectedPid)
                            !== tracked
                        || params.sessionAttachCleanupByPid.get(
                            expectedPid,
                        ) !== lifecycleCleanup
                    ) {
                        await retireRecoveredAuthority();
                        if (
                            !lifecycleCleanupStarted
                            && params.sessionAttachCleanupByPid.get(
                                currentPid,
                            ) === lifecycleCleanup
                        ) {
                            if (previousAttachCleanup) {
                                params.sessionAttachCleanupByPid.set(
                                    currentPid,
                                    previousAttachCleanup,
                                );
                            } else {
                                params.sessionAttachCleanupByPid.delete(
                                    currentPid,
                                );
                            }
                        }
                        unavailable(
                            'reattached_agent_lifecycle_changed',
                        );
                    }
                } catch {
                    await retireRecoveredAuthority()
                        .catch(() => undefined);
                    const currentPid = tracked.pid;
                    if (
                        !lifecycleCleanupStarted
                        && params.sessionAttachCleanupByPid.get(
                            currentPid,
                        ) === lifecycleCleanup
                    ) {
                        if (previousAttachCleanup) {
                            params.sessionAttachCleanupByPid.set(
                                currentPid,
                                previousAttachCleanup,
                            );
                        } else {
                            params.sessionAttachCleanupByPid.delete(
                                currentPid,
                            );
                        }
                    }
                    unavailable(
                        'request_auth_capability_activation_failed',
                    );
                }
            }
        } catch {
            logger.debug(
                '[DAEMON RUN] Reattached Agent request-auth recovery left authority unavailable',
                {
                    candidateCount: reattached.length,
                    reason: 'plugin_contribution_registry_unavailable',
                },
            );
        } finally {
            await runtimeRegistryLease?.release()
                .catch(() => undefined);
        }
    };
    let queueHostedWebStaticAssetSync: (reason: HostedWebStaticAssetSyncReason) => Promise<void> = async () => {};
    const persistedConnectedServiceSwitchSessionMetadataBySessionId = new Map<
        string,
        Promise<Record<string, unknown> | null>
    >();
    const forgetPersistedConnectedServiceSwitchSessionMetadata = (sessionIdRaw: string): void => {
        const sessionId = normalizeOptionalString(sessionIdRaw);
        if (!sessionId) return;
        persistedConnectedServiceSwitchSessionMetadataBySessionId.delete(sessionId);
    };
    const rememberPersistedConnectedServiceSwitchSessionMetadata = (
        sessionIdRaw: string,
        metadataRaw: unknown,
    ): void => {
        const sessionId = normalizeOptionalString(sessionIdRaw);
        if (!sessionId) return;
        if (!metadataRaw || typeof metadataRaw !== 'object' || Array.isArray(metadataRaw)) {
            persistedConnectedServiceSwitchSessionMetadataBySessionId.delete(sessionId);
            return;
        }
        persistedConnectedServiceSwitchSessionMetadataBySessionId.set(
            sessionId,
            Promise.resolve(metadataRaw as Record<string, unknown>),
        );
    };
    const disconnectedTerminalHostCandidates = [
        ...(params.startupTerminalRecovery?.disconnectedTerminalHostCandidates ?? []),
    ];
    const unresolvedTerminalHostSessionIds = new Set(
        params.startupTerminalRecovery?.unresolvedTerminalHostSessionIds ?? [],
    );
    const disconnectedTerminalHostResultsBySessionId = new Map<string, DisconnectedTerminalHostSupervisionResult>();
    const terminalizedDisconnectedTerminalHostIds = new Set<string>();
    const retireDisconnectedTerminalHostCandidate = (input: Readonly<{
        sessionId: string;
        attachmentId?: string;
    }>): void => {
        disconnectedTerminalHostResultsBySessionId.delete(input.sessionId);
        for (let index = disconnectedTerminalHostCandidates.length - 1; index >= 0; index -= 1) {
            const candidate = disconnectedTerminalHostCandidates[index];
            if (!candidate || candidate.sessionId !== input.sessionId) continue;
            if (input.attachmentId && candidate.attachmentId !== input.attachmentId) continue;
            terminalizedDisconnectedTerminalHostIds.add(candidate.attachmentId);
            disconnectedTerminalHostCandidates.splice(index, 1);
        }
    };
    const disconnectedTerminalHostResumeLifecycle = createDisconnectedTerminalHostResumeLifecycle({
        unresolvedTerminalHostSessionIds,
        clearUnresolvedTerminalHostSession: (sessionId) => {
            unresolvedTerminalHostSessionIds.delete(sessionId);
        },
        findDisconnectedCandidate: (sessionId) =>
            disconnectedTerminalHostCandidates.find(
                (candidate) => candidate.sessionId === sessionId
                    && !terminalizedDisconnectedTerminalHostIds.has(candidate.attachmentId),
            ) ?? null,
        resolveResumeGateForCandidate: async (candidate) =>
            resolveDisconnectedTerminalHostResumeGate(await superviseDisconnectedTerminalHost(candidate)),
        retireCandidate: retireDisconnectedTerminalHostCandidate,
    });
    const superviseDisconnectedTerminalHost = async (
        candidate: DisconnectedTerminalHostCandidate,
    ): Promise<DisconnectedTerminalHostSupervisionResult> => {
        const existing = disconnectedTerminalHostResultsBySessionId.get(candidate.sessionId);
        if (existing) return existing;
        const adapters = await params.loadTerminalHostAdapters?.() ?? {};
        const result = await superviseDisconnectedTerminalHostCandidate({
            candidate,
            terminalHostAdapters: adapters,
            probeSessionServiceability: async (sessionId) => await probeSessionRunnerServiceability({
                sessionId,
                trackedSessions: params.pidToTrackedSession.values(),
                probeCapability: async () => await probeAlreadyRunningExistingSessionServiceability({
                    sessionId,
                    credentials: params.credentials,
                    abortSignal: shutdownCancellationDomains.daemonWorkSignal,
                    ...(params.isShuttingDown ? { isShuttingDown: params.isShuttingDown } : {}),
                }),
            }),
            onExactTerminalAttachmentRetired: notifyTerminalAttachmentRetiredThroughCatalog,
        });
        disconnectedTerminalHostResultsBySessionId.set(candidate.sessionId, result);
        if (result.state === 'stopped') terminalizedDisconnectedTerminalHostIds.add(candidate.attachmentId);
        if (result.state === 'recoverable_unservable' || result.state === 'unknown') {
            await publishCurrentTerminalControlServiceability({
                credentials: params.credentials,
                happyHomeDir: configuration.happyHomeDir,
                sessionId: candidate.sessionId,
                serviceability: result,
            }).catch((error) => {
                logger.debug('[DAEMON RUN] Failed to publish disconnected terminal control serviceability', {
                    sessionId: candidate.sessionId,
                    error: serializeAxiosErrorForLog(error),
                });
            });
        }
        return result;
    };
    await Promise.all(disconnectedTerminalHostCandidates.map(superviseDisconnectedTerminalHost));
    const physicallyRetiredTerminalAttachmentIdBySessionId = new Map<string, string>();
    const stopSessionCore = createStopSession({
        pidToTrackedSession: params.pidToTrackedSession,
        retireUpstreamAuthorityBeforeProcessStop: async (pid) =>
            await retireUpstreamAuthorityBeforeProcessStop({
                pid,
                spawnResourceCleanupByPid:
                    params.spawnResourceCleanupByPid,
            }),
        loadTerminalHostAdapters: params.loadTerminalHostAdapters,
        waitForTrackedRunnersExit: async ({ sessionId, trackedPids }) => {
            await waitForExistingSessionExitIfStopRequested({
                sessionId,
                pidToTrackedSession: params.pidToTrackedSession,
                isSessionRunnerActive,
                timeoutMs: configuration.daemonStopSessionWaitForExitMs,
                pollIntervalMs: configuration.daemonStopSessionWaitForExitPollIntervalMs,
                onExitObserved: (pid, exit) => onChildExited(pid, exit),
            });
            return trackedPids.every((pid) => !params.pidToTrackedSession.has(pid));
        },
        onExactTerminalAttachmentRetired: async (input) => {
            physicallyRetiredTerminalAttachmentIdBySessionId.set(input.sessionId, input.attachmentInfo.attachmentId);
            await notifyTerminalAttachmentRetiredThroughCatalog(input);
        },
        retireExactTerminalControlServiceability: async ({ sessionId, attachmentInfo, terminalMode }) => {
            await retireExactTerminalControlServiceability({
                credentials: params.credentials,
                sessionId,
                attachmentId: attachmentInfo.attachmentId,
                terminalMode,
            });
        },
    });
    const readPersistedConnectedServiceSwitchSessionMetadata = async (
        sessionIdRaw: string,
    ): Promise<Record<string, unknown> | null> => {
        const sessionId = normalizeOptionalString(sessionIdRaw);
        if (!sessionId) return null;
        const existing = persistedConnectedServiceSwitchSessionMetadataBySessionId.get(sessionId);
        if (existing) return await existing;

        const promise = resolvePersistedConnectedServiceSwitchSessionMetadata({
            token: params.credentials.token,
            credentials: params.credentials,
            sessionId,
        });
        persistedConnectedServiceSwitchSessionMetadataBySessionId.set(sessionId, promise);
        try {
            const metadata = await promise;
            if (!metadata && persistedConnectedServiceSwitchSessionMetadataBySessionId.get(sessionId) === promise) {
                persistedConnectedServiceSwitchSessionMetadataBySessionId.delete(sessionId);
            }
            return metadata;
        } catch (error) {
            if (persistedConnectedServiceSwitchSessionMetadataBySessionId.get(sessionId) === promise) {
                persistedConnectedServiceSwitchSessionMetadataBySessionId.delete(sessionId);
            }
            throw error;
        }
    };

    const runSpawnSession = async (
        options: SpawnSessionOptions,
        behavior: Readonly<{
            nudgeAlreadyRunningPendingQueue: boolean;
            completeFreshExplicitResumeAdmission?: () => void;
        }>,
    ): Promise<SpawnSessionResult> => {
        try {
            const key = computeDaemonSpawnRequestKey(options);
            return await spawnRequestCoalescer.run(key, async () => {
                if (options.existingSessionId) {
                    const preGateResult = await disconnectedTerminalHostResumeLifecycle.resolveResumePreGate(
                        options.existingSessionId,
                        async (sessionId) => await stopSession(sessionId),
                    );
                    if (preGateResult) {
                        return {
                            type: 'error',
                            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                            errorMessage: preGateResult.errorMessage,
                        };
                    }
                }
                const existingSessionPreGate = await resolveExistingSessionSpawnPreGate({
                    existingSessionId: options.existingSessionId,
                    pidToTrackedSession: params.pidToTrackedSession,
                    isSessionRunnerActive,
                    waitForExitTimeoutMs: configuration.daemonSpawnExistingSessionWaitForExitMs,
                    waitForExitPollIntervalMs: configuration.daemonSpawnExistingSessionWaitForExitPollIntervalMs,
                    logDebug: (message, payload) => logger.debug(message, payload),
                    onAlreadyRunning: async (sessionId) => {
                        const serviceability = await probeAlreadyRunningExistingSessionServiceability({
                            sessionId,
                            credentials: params.credentials,
                            abortSignal: shutdownCancellationDomains.daemonWorkSignal,
                            ...(params.isShuttingDown ? { isShuttingDown: params.isShuttingDown } : {}),
                        });
                        try {
                            await publishCurrentTerminalControlServiceability({
                                credentials: params.credentials,
                                happyHomeDir: configuration.happyHomeDir,
                                sessionId,
                                serviceability,
                            });
                        } catch (error) {
                            logger.debug('[DAEMON RUN] Failed to publish resume target terminal control serviceability', {
                                sessionId,
                                error: serializeAxiosErrorForLog(error),
                            });
                        }
                        if (serviceability.state !== 'servable') {
                            return {
                                action: 'error',
                                result: {
                                    type: 'error',
                                    errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                                    errorMessage: serviceability.state === 'unknown'
                                        ? 'The existing session runtime could not be verified. Retry resume after connectivity recovers.'
                                        : 'The existing session process is alive but its controls are unavailable. Stop it explicitly before retrying resume.',
                                },
                            };
                        }
                        await applyAlreadyRunningExistingSessionRuntimeSnapshot({
                            sessionId,
                            incomingOptions: options,
                            pidToTrackedSession: params.pidToTrackedSession,
                            readPersistedSessionMetadata: readPersistedConnectedServiceSwitchSessionMetadata,
                        });
                        if (behavior.nudgeAlreadyRunningPendingQueue) {
                            const nudgeResult = await nudgeAlreadyRunningExistingSessionPendingQueue({
                                sessionId,
                                credentials: params.credentials,
                                abortSignal: shutdownCancellationDomains.daemonWorkSignal,
                                ...(params.isShuttingDown ? { isShuttingDown: params.isShuttingDown } : {}),
                            });
                            if ('type' in nudgeResult && nudgeResult.type === 'unavailable') {
                                logger.warn('[DAEMON RUN] Resume target is alive but pending queue materialization probe failed; adopting existing runner and leaving nudge failure advisory', {
                                    sessionId,
                                    reason: nudgeResult.reason,
                                });
                            }
                        }
                        return { action: 'use_existing' };
                    },
                });
                if (existingSessionPreGate.shortCircuitResult) {
                    return existingSessionPreGate.shortCircuitResult;
                }

                const spawnResult = await spawnConcurrencyGate.run(async () =>
                    await executeSpawnSessionRequest({
                        options,
                        credentials: params.credentials,
                        api: params.api,
                        loadLocalHandoffMetadataByVendorResumeId: params.loadLocalHandoffMetadataByVendorResumeId,
                        connectedServicesMaterializationBaseDir: params.connectedServicesMaterializationBaseDir,
                        connectedServiceRefreshCoordinator: params.getConnectedServiceRefreshCoordinator(),
                        connectedServiceQuotasCoordinator: params.getConnectedServiceQuotasCoordinator(),
                        connectedServiceRuntimeRegistry,
                        connectedAccountRequestAuthRegistry,
                        connectedAccountRequestAuthHttpPort:
                            requireConnectedAccountRequestAuthHttpPort(),
                        resolveSessionSyncPendingInputServerContractResult: () =>
                            params.getApiMachineForSessions()
                                ?.getSessionSyncPendingInputServerContractResult()
                            ?? null,
                        providerAccountUsageStore,
                        authGroupSwitchCoordinator: preTurnConnectedServiceAuthGroupSwitchCoordinator,
                        predictiveSwitchGuard: connectedServicePredictiveSwitchGuard ?? undefined,
                        repairMissingConnectedServiceMaterializationIdentityForSpawn: async (input) => {
                            const identity = await repairMissingConnectedServiceMaterializationIdentityForSpawn({
                                token: params.credentials.token,
                                credentials: params.credentials,
                                sessionId: input.sessionId,
                                agentId: input.agentId,
                                connectedServices: input.connectedServices,
                                vendorResumeId: input.vendorResumeId,
                            });
                            if (identity) {
                                forgetPersistedConnectedServiceSwitchSessionMetadata(input.sessionId);
                            }
                            return identity;
                        },
                        pidToTrackedSession: params.pidToTrackedSession,
                        pidToAwaiter: params.pidToAwaiter,
                        pidToSpawnResultResolver: params.pidToSpawnResultResolver,
                        pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
                        resolveCanonicalTrackedSessionId,
                        onChildExited,
                        spawnResourceCleanupByPid: params.spawnResourceCleanupByPid,
                        sessionAttachCleanupByPid: params.sessionAttachCleanupByPid,
                        processEnv: params.processEnv,
                        resolveProvidersFeatureEnabled: async () => {
                            const serverSnapshot = await (
                                params.resolveServerFeaturesSnapshot?.()
                                ?? fetchServerFeaturesSnapshot({
                                    serverUrl: configuration.serverUrl,
                                    timeoutMs: 1_500,
                                })
                            );
                            return resolveCliFeatureDecision({
                                featureId: 'providers',
                                env: params.processEnv,
                                ...(serverSnapshot ? { serverSnapshot } : {}),
                            }).state === 'enabled';
                        },
                        ...(params.resolveManagedPurposeBindingIntent
                            ? {
                                resolveManagedPurposeBindingIntent:
                                    params.resolveManagedPurposeBindingIntent,
                            }
                            : {}),
                        ...(params.activateSessionPurposeBindings
                            ? {
                                activateSessionPurposeBindings:
                                    params.activateSessionPurposeBindings,
                            }
                            : {}),
                        managedProviderEndpointRuntime: {
                            materializationBaseDir: join(
                                configuration.happyHomeDir,
                                'providers',
                                'managed',
                            ),
                            resolveManagedLocalServicesEnabled: async () => {
                                const serverSnapshot =
                                    await resolveServerFeaturesSnapshot();
                                return resolveCliFeatureDecision({
                                    featureId: 'localServices.managed',
                                    env: params.processEnv,
                                    ...(serverSnapshot
                                        ? { serverSnapshot }
                                        : {}),
                                }).state === 'enabled';
                            },
                            localServices:
                                localServicesRuntime.trustedManagedLocalServices,
                            exec: managedLocalServicesExec,
                            requestAuthRegistry: connectedAccountRequestAuthRegistry,
                            validateRequestAuth:
                                connectedAccountRequestAuthService.validateRequestAuth,
                        },
                    }),
                );
                if (spawnResult.type === 'success' && options.executionAuthorization && options.existingSessionId) {
                    const sessionId = options.existingSessionId.trim();
                    const nudgeResult = await nudgeAlreadyRunningExistingSessionPendingQueue({
                        sessionId,
                        credentials: params.credentials,
                        abortSignal: shutdownCancellationDomains.daemonWorkSignal,
                        ...(params.isShuttingDown ? { isShuttingDown: params.isShuttingDown } : {}),
                    });
                    if ('type' in nudgeResult && nudgeResult.type === 'unavailable') {
                        return {
                            type: 'error',
                            errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                            errorMessage: `Exact pending dispatch unavailable after runner startup: ${nudgeResult.reason}`,
                        };
                    }
                }
                if (spawnResult.type === 'success' && options.existingSessionId) {
                    behavior.completeFreshExplicitResumeAdmission?.();
                }
                return spawnResult;
            });
        } catch (error) {
            logger.warn('[DAEMON RUN] Failed before spawn session work started', {
                error,
                hasExistingSessionId: typeof options.existingSessionId === 'string' && options.existingSessionId.trim().length > 0,
                hasResume: typeof options.resume === 'string' && options.resume.trim().length > 0,
                backendTargetKind: resolveConcreteBackendTargetRefV2(options.backendTarget)?.kind ?? null,
            });
            throw error;
        }
    };
    const spawnSessionWithAdmission = async (
        options: SpawnSessionOptions,
        behavior: Readonly<{ freshExplicitResume: boolean }>,
    ): Promise<SpawnSessionResult> => {
        if (params.isShuttingDown?.() === true) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage: 'Daemon is shutting down',
            };
        }
        const existingSessionId = normalizeOptionalString(options.existingSessionId);
        const completeFreshExplicitResumeAdmission = behavior.freshExplicitResume && existingSessionId
            ? sessionRunnerRespawnManager.prepareFreshExplicitResumeAdmission(existingSessionId)
            : undefined;
        const result = await runSpawnSession({
            ...options,
            machineId: params.machineId,
        }, {
            nudgeAlreadyRunningPendingQueue: true,
            ...(completeFreshExplicitResumeAdmission ? { completeFreshExplicitResumeAdmission } : {}),
        });
        if (result.type === 'success') {
            void queueHostedWebStaticAssetSync('session_spawned');
        }
        return result;
    };
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> =>
        await spawnSessionWithAdmission(options, { freshExplicitResume: true });
    const spawnSessionForInternalResume = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> =>
        await spawnSessionWithAdmission(options, { freshExplicitResume: false });

    const temporaryThrottleResumeSnapshotsBySessionId = new Map<string, TrackedSession>();
    const findTemporaryThrottleTrackedSession = (sessionId: string): TrackedSession | null => {
        const normalizedSessionId = normalizeOptionalString(sessionId);
        if (!normalizedSessionId) return null;
        return findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), normalizedSessionId)
            ?? temporaryThrottleResumeSnapshotsBySessionId.get(normalizedSessionId)
            ?? null;
    };
    // RD-REC-16 port: the throttle intent is durable but the in-memory resume snapshot is
    // not (and must not be persisted: spawn options can carry secret environment values).
    // After a daemon restart, rebuild the resume source from persisted session metadata
    // instead of dead-lettering the hydrated intent.
    const resolveTemporaryThrottleResumeSource = async (
        sessionId: string,
    ): Promise<TemporaryThrottleResumeSource | null> => {
        const tracked = findTemporaryThrottleTrackedSession(sessionId);
        if (tracked) return tracked;
        const token = normalizeOptionalString(params.credentials.token);
        if (!token) return null;
        return await resolveInactiveTemporaryThrottleResumeSource({
            sessionId,
            fallbackMachineId: params.machineId,
            fetchSession: async (id) => await fetchSessionByIdCompat({ token, sessionId: id }),
            decryptSessionMetadata: (rawSession) => tryReadSessionMetadataRecord({
                rawSession,
                credentials: params.credentials,
            }),
        });
    };
    const temporaryThrottleScheduler = new ConnectedServiceTemporaryThrottleRetryScheduler({
        nowMs: () => Date.now(),
        baseBackoffMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_CONNECTED_SERVICES_TEMPORARY_THROTTLE_BASE_BACKOFF_MS,
            1_000,
            { min: 100, max: 60_000 },
        ),
        maxBackoffMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_CONNECTED_SERVICES_TEMPORARY_THROTTLE_MAX_BACKOFF_MS,
            60_000,
            { min: 1_000, max: 10 * 60_000 },
        ),
        maxAttempts: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_CONNECTED_SERVICES_TEMPORARY_THROTTLE_MAX_ATTEMPTS,
            3,
            { min: 1, max: 100 },
        ),
        resume: async (_intent, { sessionId }) => {
            const tracked = await resolveTemporaryThrottleResumeSource(sessionId);
            if (!tracked) {
                temporaryThrottleResumeSnapshotsBySessionId.delete(sessionId);
                throw new Error('temporary_throttle_session_not_found');
            }
            const seed = buildTrackedExistingSessionResumeSeed({ tracked, sessionId });
            if (!seed) {
                throw new Error('temporary_throttle_resume_options_missing');
            }
            const respawnOptions = await resolveRespawnSessionOptionsWithRuntimeSnapshot({
                sessionId,
                spawnOptions: seed.spawnOptions,
                vendorResumeId: seed.vendorResumeId,
                defaultOptions: seed.defaultOptions,
                readPersistedSessionMetadata: readPersistedConnectedServiceSwitchSessionMetadata,
            });
            const result = await spawnSessionForInternalResume(respawnOptions);
            if (result.type === 'success') {
                temporaryThrottleResumeSnapshotsBySessionId.delete(sessionId);
                logger.debug('[DAEMON RUN] Temporary throttle recovery resumed session', {
                    sessionId,
                    resumedSessionId: result.sessionId ?? sessionId,
                });
                return;
            }
            throw new Error(`temporary_throttle_resume_failed:${result.type}${result.type === 'error' ? `:${result.errorCode}` : ''}`);
        },
    });
    const temporaryThrottleRecovery = {
        enable: async (input: Parameters<typeof temporaryThrottleScheduler.enable>[0]) => {
            const tracked = findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), input.sessionId);
            if (tracked) {
                temporaryThrottleResumeSnapshotsBySessionId.set(
                    input.sessionId,
                    snapshotTrackedSessionForTemporaryThrottleResume(tracked),
                );
            }
            return await temporaryThrottleScheduler.enable(input);
        },
        wake: async (input: Parameters<typeof temporaryThrottleScheduler.wake>[0]) =>
            await temporaryThrottleScheduler.wake(input),
    };
    // Cold-start persistence is evidence for UI/diagnostics and a future explicit action; it is
    // not execution authority. Load the intent so a fresh manual retry can use it, but do not arm
    // timers that could recreate a runner or provider process after daemon/computer restart.
    temporaryThrottleScheduler.hydrate({ schedule: false });

    const connectedServiceContinuationProviderActivityTimeoutMs = resolvePositiveIntEnv(
        params.processEnv.HAPPIER_CONNECTED_SERVICES_CONTINUATION_PROVIDER_ACTIVITY_TIMEOUT_MS,
        5 * 60_000,
        { min: 1_000, max: 24 * 60 * 60_000 },
    );
    const connectedServiceRecoverySupersessionCleaner = createConnectedServiceRecoverySupersessionCleaner({
        removeReportOutboxItemsForSession: async (input) => {
            await removeRuntimeAuthFailureReportOutboxItemsForSession(input);
        },
        logDebug: (message, error) => logger.debug(message, error),
    });
    const versionRuntimeRefreshCompletionTimeoutMs = resolvePositiveIntEnv(
        params.processEnv.HAPPIER_DAEMON_SESSION_RUNNER_RESTART_COMPLETION_TIMEOUT_MS,
        60_000,
        { min: 1_000, max: 10 * 60_000 },
    );
    const buildVersionRuntimeRefreshTerminalCompletion = (
        reason: SessionRunnerRespawnTerminalReason,
        detail?: string,
    ): RestartSessionRunnerCompletion => {
        const diagnostics = {
            respawnTerminalReason: reason,
            ...(detail ? { detail } : {}),
        };
        if (reason === 'not_authenticated') {
            return { ok: false, status: 'spawn_failed', reasonCode: 'missing_credentials', diagnostics };
        }
        if (reason === 'missing_spawn_options') {
            return { ok: false, status: 'spawn_failed', reasonCode: 'missing_spawn_options', diagnostics };
        }
        if (reason === 'already_running') {
            return { ok: false, status: 'partial_failure', reasonCode: 'restart_already_running', diagnostics };
        }
        if (reason === 'stop_requested') {
            return { ok: false, status: 'partial_failure', diagnostics };
        }
        return { ok: false, status: 'spawn_failed', diagnostics };
    };
    const versionRuntimeRefreshAttemptHandoff = createVersionRuntimeRefreshAttemptHandoff<RestartSessionRunnerCompletion>({
        timeoutMs: versionRuntimeRefreshCompletionTimeoutMs,
        timeoutCompletion: {
            ok: false,
            status: 'partial_failure',
            diagnostics: {
                respawnTerminalReason: 'timeout',
                timeoutMs: versionRuntimeRefreshCompletionTimeoutMs,
            },
        },
        supersededCompletion: {
            ok: false,
            status: 'partial_failure',
            diagnostics: { respawnTerminalReason: 'superseded_waiter' },
        },
        cancelledCompletion: {
            ok: false,
            status: 'partial_failure',
            diagnostics: { respawnTerminalReason: 'cancelled_before_signal' },
        },
    });
    const settleVersionRuntimeRefreshCompletion = versionRuntimeRefreshAttemptHandoff.settle;
    const takeVersionRuntimeRefreshTransientSpawnOptions = versionRuntimeRefreshAttemptHandoff.takeTransientSpawnOptions;
    const transferVersionRuntimeRefreshCompletionWaiter = versionRuntimeRefreshAttemptHandoff.transferPid;
    const onTrackedSessionPidPromoted = ({
        fromPid,
        toPid,
    }: Readonly<{
        fromPid: number;
        toPid: number;
        trackedSession: TrackedSession;
    }>): void => {
        connectedServiceRuntimeRegistry.transferPid(fromPid, toPid);
        const promoted = params.pidToTrackedSession.get(toPid);
        if (promoted?.happySessionId) {
            transferVersionRuntimeRefreshCompletionWaiter(
                promoted.happySessionId,
                fromPid,
                toPid,
            );
        }
        if (params.connectedServicesRestartRequestedPids.delete(fromPid)) {
            params.connectedServicesRestartRequestedPids.add(toPid);
        }
    };
    params.setOnTrackedSessionPidPromoted?.(
        onTrackedSessionPidPromoted,
    );
    const runnerRespawnScheduledPids = new Set<number>();
    type CapturedRunnerTerminal =
        | Readonly<{ status: 'captured'; sessionId: string; committedFenceMs: number }>
        | Readonly<{ status: 'already_inactive'; sessionId: string }>
        | Readonly<{ status: 'unavailable'; sessionId: string }>;
    type RunnerTerminalCycle = {
        entriesByPid: Map<number, {
            tracked: TrackedSession;
            admission: CapturedRunnerTerminal;
        }>;
    };
    const runnerTerminalCycleBySessionId = new Map<string, RunnerTerminalCycle>();
    const removeExitedRunnerMarker = async (
        previousPid: number,
        sessionId: string,
        tracked: TrackedSession,
    ): Promise<void> => {
        const removed = await removeSessionMarkerIfOwned({
            pid: previousPid,
            happySessionId: sessionId,
            ...(tracked.processCommandHash
                ? { processCommandHash: tracked.processCommandHash }
                : {}),
            ...(tracked.processStartTimeMs !== undefined
                ? { processStartTimeMs: tracked.processStartTimeMs }
                : {}),
            isStillOwned: () => {
                const current = params.pidToTrackedSession.get(previousPid);
                return current === undefined || current === tracked;
            },
        });
        if (!removed) {
            logger.debug('[DAEMON RUN] Exited runner marker ownership changed before release', {
                sessionId,
                previousPid,
            });
        }
    };
    const removeRunnerTerminalEntries = async (
        sessionId: string,
        entries: ReadonlyArray<readonly [number, {
            tracked: TrackedSession;
            admission: CapturedRunnerTerminal;
        }]>,
    ): Promise<void> => {
        await Promise.all(entries.map(async ([pid, entry]) => {
            await removeExitedRunnerMarker(pid, sessionId, entry.tracked);
        }));
    };
    const settleCapturedRunnerTerminal = async (input: Readonly<{
        sessionId: string;
        previousPid: number;
        reason: SessionRunnerRespawnTerminalReason;
    }>): Promise<void> => {
        const cycle = runnerTerminalCycleBySessionId.get(input.sessionId);
        if (cycle) runnerTerminalCycleBySessionId.delete(input.sessionId);
        const entries = cycle ? Array.from(cycle.entriesByPid.entries()) : [];
        const captured = cycle?.entriesByPid.get(input.previousPid)?.admission;
        if (input.reason === 'already_running') {
            await removeRunnerTerminalEntries(input.sessionId, entries);
            return;
        }
        if (!cycle || !captured || captured.status === 'unavailable') {
            logger.debug('[DAEMON RUN] Terminal respawn has no exact Session fence; retaining marker for startup recovery', input);
            return;
        }
        if (captured.status === 'already_inactive') {
            await removeRunnerTerminalEntries(input.sessionId, entries);
            return;
        }
        const apiMachine = params.getApiMachineForSessions();
        if (!apiMachine) {
            logger.debug('[DAEMON RUN] Machine Session terminal transport unavailable; retaining marker for startup recovery', input);
            return;
        }
        try {
            const finalized = await apiMachine.finalizeMachineSessionTerminal({
                sessionId: captured.sessionId,
                committedFenceMs: captured.committedFenceMs,
            });
            if (finalized.status === 'rejected') {
                logger.debug('[DAEMON RUN] Machine Session terminal finalize was rejected; retaining marker for startup recovery', {
                    ...input,
                    status: finalized.status,
                    reason: finalized.reason,
                });
                return;
            }
            await removeRunnerTerminalEntries(input.sessionId, entries);
        } catch (error) {
            logger.debug('[DAEMON RUN] Machine Session terminal finalize failed; retaining marker for startup recovery', {
                ...input,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    };
    const sessionRunnerRespawnManager = createSessionRunnerRespawnManager({
        // Runner death is non-fatal: the respawn owner is adopt-first (reattaches the durable
        // terminal host / claude session, never blind-relaunches a healthy one) and storm-bounded
        // via `decideRestartForCycle` independent of this flag. The historical `false` default traces
        // to commit 0d5d93f3b7 ("harden runner termination and daemon respawn"), which predates the
        // adopt-first landing; no test/comment ties it to a safety invariant. Default ON, with an
        // explicit opt-out env (HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED=false).
        enabled: parseBooleanEnv(params.processEnv.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED, true),
        maxRestarts: (() => {
            const maxAttempts = resolvePositiveIntEnv(
                params.processEnv.HAPPIER_DAEMON_SESSION_RESPAWN_MAX_ATTEMPTS,
                10,
                { min: 0, max: 100 },
            );
            return maxAttempts === 0 ? null : maxAttempts;
        })(),
        // RR-2: intended (connected-service) restarts run on their OWN rolling-window budget so a
        // storm of SUCCESSFUL intended restarts stays bounded across cycles and never consumes the
        // genuine crash budget.
        maxIntendedRestarts: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_DAEMON_SESSION_INTENDED_RESTART_MAX_ATTEMPTS,
            20,
            { min: 0, max: 200 },
        ),
        intendedRestartWindowMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_DAEMON_SESSION_INTENDED_RESTART_WINDOW_MS,
            30 * 60_000,
            { min: 60_000, max: 24 * 60 * 60_000 },
        ),
        baseDelayMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_DAEMON_SESSION_RESPAWN_BASE_DELAY_MS,
            1_000,
            { min: 50, max: 5 * 60_000 },
        ),
        maxDelayMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_DAEMON_SESSION_RESPAWN_MAX_DELAY_MS,
            60_000,
            { min: 50, max: 30 * 60_000 },
        ),
        jitterMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_DAEMON_SESSION_RESPAWN_JITTER_MS,
            250,
            { min: 0, max: 10_000 },
        ),
        isSessionAlreadyRunning: async (sessionId) => await isSessionRunnerActive(sessionId),
        spawnSession: spawnSessionForInternalResume,
        resolveRespawnOptions: async (input) => await resolveRespawnSessionOptionsWithRuntimeSnapshot({
            ...input,
            readPersistedSessionMetadata: readPersistedConnectedServiceSwitchSessionMetadata,
        }),
        onRespawnSuccess: ({ sessionId, previousPid }) => {
            runnerRespawnScheduledPids.delete(previousPid);
            params.connectedServicesRestartRequestedPids.delete(previousPid);
            const cycle = runnerTerminalCycleBySessionId.get(sessionId);
            if (cycle) runnerTerminalCycleBySessionId.delete(sessionId);
            const entries = cycle ? Array.from(cycle.entriesByPid.entries()) : [];
            void (entries.length > 0
                ? removeRunnerTerminalEntries(sessionId, entries)
                : Promise.resolve()).catch((error) => {
                logger.debug('[DAEMON RUN] Failed to release exited runner marker after respawn success', error);
            });
            void clearSessionMarkerConnectedServiceRestartIntent(previousPid).catch((error) => {
                logger.debug('[DAEMON RUN] Failed to clear connected-service restart intent after respawn success', error);
            });
            const next = findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), sessionId);
            settleVersionRuntimeRefreshCompletion(sessionId, previousPid, {
                ok: true,
                ...(next ? { next: summarizeSessionRunnerEndpoint(next) } : {}),
            });
        },
        onRespawnTerminal: ({ sessionId, previousPid, reason, detail }) => {
            runnerRespawnScheduledPids.delete(previousPid);
            params.connectedServicesRestartRequestedPids.delete(previousPid);
            void settleCapturedRunnerTerminal({ sessionId, previousPid, reason });
            void clearSessionMarkerConnectedServiceRestartIntent(previousPid).catch((error) => {
                logger.debug('[DAEMON RUN] Failed to clear connected-service restart intent after terminal respawn suppression', error);
            });
            settleVersionRuntimeRefreshCompletion(
                sessionId,
                previousPid,
                buildVersionRuntimeRefreshTerminalCompletion(reason, detail),
            );
        },
        random: () => Math.random(),
        logDebug: (message, payload) => logger.debug(message, payload),
        logWarn: (message) => logger.warn(message),
    });
    const clearConnectedServiceRestartIntentForPid = (pid: number, logMessage: string): void => {
        void clearSessionMarkerConnectedServiceRestartIntent(pid).catch((error) => {
            logger.debug(logMessage, error);
        });
    };
    const connectedServiceTurnDeferralQueue = createConnectedServiceSwitchDeferralQueue({
        timeoutMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_CONNECTED_SERVICES_TURN_DEFERRAL_TIMEOUT_MS,
            60_000,
            { min: 1_000, max: 10 * 60_000 },
        ),
        disableDeferral: String(params.processEnv.HAPPIER_CONNECTED_SERVICES_DISABLE_TURN_DEFERRAL ?? '').trim() === '1',
        emitSessionEvent: (sessionId, event) => {
            commitConnectedServiceAccountSwitchSessionEventWithNotification({
                sessionId,
                event,
                logContext: 'connected-service switch deferral',
            });
        },
    });
    const resolveSessionRunnerActivityDisabledReason = (
        sessionId: string,
    ): SessionRunnerRestartDisabledReason | null => (
        connectedServiceTurnDeferralQueue.isTurnInFlight(sessionId) ? 'turn_in_progress' : null
    );
    const resolvePredictiveSoftSwitchModeForInput = async (input: Readonly<{
        sessionId: string;
        serviceId: ConnectedServiceId;
        groupId: string;
        activeProfileId: string;
        agentId?: string | null;
        reason: 'soft_threshold' | 'same_provider_account_exhausted' | 'usage_limit' | 'auth_expired';
    }>): Promise<'supported' | 'unsupported'> => {
        const tracked = findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), input.sessionId);
        const resolvedAgentId = typeof input.agentId === 'string' && input.agentId.trim()
            ? input.agentId.trim()
            : resolveTrackedSessionCatalogAgentId(tracked);
        if (!resolvedAgentId) return 'unsupported';
        const declaredCapabilities = await getConnectedServiceRecoveryCapabilities(resolvedAgentId as CatalogAgentId)
            .catch(() => null);
        return await resolvePredictiveSoftSwitchCapability({
            declaredCapabilities,
            inferFromRuntimeAuthAdapter: async () => {
                const adapter = await getConnectedServiceRuntimeAuthAdapter(resolvedAgentId as CatalogAgentId);
                if (!adapter) return 'unsupported';
                const materialization = await adapter.materializeActiveProfile({
                    target: { agentId: resolvedAgentId },
                    selection: {
                        serviceId: input.serviceId,
                        groupId: input.groupId,
                        activeProfileId: input.activeProfileId,
                        profileId: input.activeProfileId,
                    },
                });
                return materialization?.supported === true ? 'supported' : 'unsupported';
            },
        }).then((mode) => {
            if (
                mode !== 'supported'
                && input.reason === 'soft_threshold'
                && declaredCapabilities?.sameAccountFanoutStrategy === 'shared_group_auth_surface'
                && trackedSessionUsesRequestedSharedGroupAuthSurface({
                    tracked,
                    activeServerDir: configuration.activeServerDir,
                    agentId: resolvedAgentId as CatalogAgentId,
                    serviceId: input.serviceId,
                    groupId: input.groupId,
                    activeProfileId: input.activeProfileId,
                })
            ) {
                return 'supported';
            }
            if (mode !== 'supported') return mode;
            const liveRequirement = declaredCapabilities?.predictiveSoftSwitch.liveSessionRequirement ?? null;
            if (!liveRequirement) return mode;
            const decision = evaluatePredictiveSoftSwitchLiveSessionRequirement({
                reason: input.reason,
                requirement: liveRequirement,
                activeServerDir: configuration.activeServerDir,
                agentId: resolvedAgentId as CatalogAgentId,
                serviceId: input.serviceId,
                groupId: input.groupId,
                activeProfileId: input.activeProfileId,
                env: tracked?.spawnOptions?.environmentVariables ?? {},
            });
            return decision.status === 'allow' ? 'supported' : 'unsupported';
        });
    };
    const resolveRuntimeAuthApplyCapabilityForInput = async (input: Readonly<{
        sessionId: string;
        agentId?: string | null;
    }>): Promise<ConnectedServiceRuntimeAuthApplyCapability> => {
        const tracked = findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), input.sessionId);
        const explicitAgentId = typeof input.agentId === 'string' && input.agentId.trim()
            ? input.agentId.trim()
            : null;
        const trackedAgentId = resolveTrackedSessionCatalogAgentId(tracked);
        const inactiveContext = explicitAgentId || trackedAgentId
            ? null
            : await resolveInactiveConnectedServiceSessionContext({
                token: params.credentials.token,
                credentials: params.credentials,
                sessionId: input.sessionId,
            });
        const resolvedAgentId = typeof input.agentId === 'string' && input.agentId.trim()
            ? input.agentId.trim()
            : trackedAgentId ?? inactiveContext?.agentId;
        if (!resolvedAgentId) return { directLiveHotAuth: 'unsupported' };
        return await resolveConnectedServiceRuntimeAuthApplyCapability(
            async () => await getConnectedServiceRecoveryCapabilities(resolvedAgentId as CatalogAgentId),
        );
    };
    const requestConnectedServiceRestartWithDeferral = async (input: Readonly<{
        sessionId: string;
        tracked: TrackedSession;
        source: 'manual' | 'automatic';
        policy: 'defer_until_turn_boundary' | 'defer_until_idle';
        target: ConnectedServiceSwitchTarget;
        restartSignalDelayMs: number;
        restartDiagnostic: ConnectedServiceDaemonRestartDiagnosticInput;
        onSignalFailureLogMessage: string;
    }>): Promise<Readonly<{ signaled: boolean }>> => {
        return await requestPlannedRunnerRestart({
            sessionId: input.sessionId,
            tracked: input.tracked,
            deferral: {
                kind: 'connected_service_switch',
                source: input.source,
                policy: input.policy,
                target: input.target,
                turnDeferralQueue: connectedServiceTurnDeferralQueue,
            },
            restartRequestedPids: params.connectedServicesRestartRequestedPids,
            pidToTrackedSession: params.pidToTrackedSession,
            canSignal: () => resolveSessionRunnerActivityDisabledReason(input.sessionId) ?? true,
            requestSignal: async (signalInput) => {
                // K5:gated_restart this raw SIGTERM IS the gated restart primitive's signal. It
                // only fires inside the planned restart helper after the deferral policy allows it,
                // and the respawn re-verifies resume reachability (K1).
                return await requestConnectedServiceSessionRestartSignal({
                    pid: signalInput.tracked.pid,
                    delayMs: input.restartSignalDelayMs,
                    preferProcessGroup: signalInput.tracked.startedBy === 'daemon',
                    shouldSignal: signalInput.shouldSignal,
                    restartDiagnostic: input.restartDiagnostic,
                    recordRestartDiagnostic: recordConnectedServiceRestartDiagnostic,
                    onSignalFailure: signalInput.onSignalFailure,
                    onProcessAlreadyMissing: signalInput.onProcessAlreadyMissing,
                });
            },
            observeProcessMissing: observeConnectedServiceRestartProcessMissing ?? undefined,
            clearRestartIntentForPid: clearConnectedServiceRestartIntentForPid,
            onSignalFailureLogMessage: input.onSignalFailureLogMessage,
            logDebug: (message, payload) => logger.debug(message, payload),
            logWarn: (message, payload) => logger.warn(message, payload),
        });
    };

    const requestSessionRunnerVersionRuntimeRefresh = async (input: Readonly<{
        sessionId: string;
        tracked: TrackedSession;
        reason: 'version_runtime_refresh';
        transientSpawnOptions?: SpawnSessionOptions;
    }>): Promise<Readonly<{
        signaled: boolean;
        notSignaledReason?: PlannedRunnerRestartNotSignaledReason;
        completion?: RestartSessionRunnerCompletion;
    }>> => {
        logger.debug('[DAEMON RUN] Session-runner runtime refresh restart attempt', {
            sessionId: input.sessionId,
            pid: input.tracked.pid,
            reason: input.reason,
            routedThroughGatedPrimitive: true,
        });
        if (params.connectedServicesRestartRequestedPids.has(input.tracked.pid)) {
            return { signaled: false, notSignaledReason: 'restart_already_running' };
        }
        const completionWaiter = versionRuntimeRefreshAttemptHandoff.create({
            sessionId: input.sessionId,
            previousPid: input.tracked.pid,
            ...(input.transientSpawnOptions
                ? { transientSpawnOptions: input.transientSpawnOptions }
                : {}),
        });
        try {
            const restart = await requestPlannedRunnerRestart({
                sessionId: input.sessionId,
                tracked: input.tracked,
                deferral: { kind: 'none' },
                restartRequestedPids: params.connectedServicesRestartRequestedPids,
                pidToTrackedSession: params.pidToTrackedSession,
                canSignal: () => resolveSessionRunnerActivityDisabledReason(input.sessionId) ?? true,
                requestSignal: async (signalInput) => {
                    // K5:gated_restart session-runner version refresh uses the shared forced-respawn
                    // signal primitive without a durable connected-service intent or startup re-drive.
                    return await requestConnectedServiceSessionRestartSignal({
                        pid: signalInput.tracked.pid,
                        delayMs: 0,
                        preferProcessGroup: signalInput.tracked.startedBy === 'daemon',
                        shouldSignal: signalInput.shouldSignal,
                        onSignalFailure: signalInput.onSignalFailure,
                        onProcessAlreadyMissing: signalInput.onProcessAlreadyMissing,
                    });
                },
                observeProcessMissing: observeConnectedServiceRestartProcessMissing ?? undefined,
                onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart session-runner for runtime refresh',
                logDebug: (message, payload) => logger.debug(message, payload),
                logWarn: (message, payload) => logger.warn(message, payload),
            });
            if (!restart.signaled) {
                completionWaiter.cancel();
                return restart;
            }
            return {
                ...restart,
                completion: await completionWaiter.promise,
            };
        } catch (error) {
            completionWaiter.cancel();
            throw error;
        }
    };

    type ProviderInputAdmissionTargetWitness = Readonly<{
        targetReference: ConnectedServiceRuntimeTarget;
        sessionId: string;
        runtimeIdentityKey: string;
        revision: number;
    }>;
    const captureProviderInputAdmissionTargetWitness = (
        target: ConnectedServiceRuntimeTarget,
    ): ProviderInputAdmissionTargetWitness | null => target.sessionId
        ? Object.freeze({
            targetReference: target,
            sessionId: target.sessionId,
            runtimeIdentityKey: target.runtimeIdentityKey,
            revision: target.revision,
        })
        : null;
    const isCurrentProviderInputAdmissionTarget = (witness: ProviderInputAdmissionTargetWitness): boolean => {
        const current = connectedServiceRuntimeRegistry.getBySessionId(witness.sessionId);
        return current === witness.targetReference
            && current.runtimeIdentityKey === witness.runtimeIdentityKey
            && current.revision === witness.revision;
    };
    const requestProviderInputAdmissionForTarget = async (
        target: ConnectedServiceRuntimeTarget,
        request: ProviderInputAdmissionRequest,
        expectedWitness?: ProviderInputAdmissionTargetWitness,
    ): Promise<
        | Readonly<{
            status: 'admitted';
            value: Readonly<{ status: 'enforced' | 'cleared' | 'not_matched' }>;
        }>
        | Readonly<{ status: 'cancelled' }>
    > => {
        const targetWitness = expectedWitness ?? captureProviderInputAdmissionTargetWitness(target);
        const sessionId = targetWitness?.sessionId ?? null;
        if (!targetWitness || !sessionId || !isCurrentProviderInputAdmissionTarget(targetWitness)) {
            throw new Error('provider_input_admission_target_released');
        }
        const outcome = await requestProviderInputAdmissionWithBoundedRetry({
            targetFence: {
                expected: targetWitness,
                resolveCurrentTarget: () => connectedServiceRuntimeRegistry.getBySessionId(sessionId),
                createSupersededError: () => new Error('provider_input_admission_target_released'),
            },
            isCancelled: () => shutdownCancellationDomains.daemonWorkSignal.aborted
                || (params.isShuttingDown?.() ?? false),
            requestAdmission: async () => await callSessionProviderInputAdmission({
                credentials: params.credentials,
                sessionId,
                ...request,
            }),
            isMethodUnavailable: isRpcMethodNotAvailableError,
            // A fresh current runner can publish its runtime target just before its
            // provider-input RPC is registered. Give that startup window a bounded
            // grace; an old/incompatible runner remains a typed admission failure.
            methodUnavailableRetry: {
                maxAttempts: 50,
                waitBeforeRetry: async () => await waitForProviderInputAdmissionGrace(
                    100,
                    shutdownCancellationDomains.daemonWorkSignal,
                ),
            },
        });
        return outcome;
    };

    /**
     * K2: shared FSM auth-generation apply used by BOTH the reactive runtime-auth
     * failure coordinator AND the proactive quota coordinator. Routing the proactive
     * quota switch through this (instead of a bare respawn) gives it:
     *  - the same fail-closed reachability gate at respawn (K1) via the FSM's restart path,
     *  - Codex appServer hot-apply IN PLACE when eligible (no respawn, no
     *    ConnectedServiceRestartRequested) + X4 transport invalidation (carried by the
     *    materializer into the hot-apply selection),
     *  - the configured post-replacement continuation policy, which may enqueue one ordinary
     *    Pending row only for an interrupted origin. Pending owns all later delivery behavior.
     * The exact tracked active-turn identity is frozen by the failure owner. Pending performs
     * the atomic explicit-user-input suppression at enqueue time.
     */
    const verifySessionConnectedServiceAccountAdoption = createSessionConnectedServiceAccountAdoptionVerifier();

    const buildConnectedServiceAuthGroupRestartSession = (builderInput: Readonly<{
        sessionId: string;
        interruptedSessionId?: string | null;
        interruptedOriginId?: string | null;
        restartReason: string | null;
        commitAccountSwitchEvents: boolean;
        allowRestart?: boolean;
        executionAuthority?: ConnectedServiceGenerationExecutionAuthority;
        dryRun?: boolean;
    }>) => async (restartInput: Readonly<{
        sessionId?: string;
        serviceId: ConnectedServiceId;
        groupId: string;
        activeProfileId: string | null;
        generation: number;
        reason?: string;
    }>): Promise<ConnectedServiceAuthGroupGenerationApplyResult> => {
        const tracked = Array.from(params.pidToTrackedSession.values())
            .find((child) => child.happySessionId === builderInput.sessionId) ?? null;
        const inactiveContext = tracked
            ? null
            : await resolveInactiveConnectedServiceSessionContext({
                token: params.credentials.token,
                credentials: params.credentials,
                sessionId: builderInput.sessionId,
            });
        if (!tracked && !inactiveContext) {
            return connectedServiceAuthGroupGenerationApplyFailure({
                errorCode: 'session_not_found',
                serviceId: restartInput.serviceId,
                failurePhase: 'session_lookup',
            });
        }
        const sameProviderAccountFanout = builderInput.restartReason === 'same_provider_account_exhausted';
        const hotApplyOnlyFailure = (): ConnectedServiceAuthGroupGenerationApplyFailure =>
            connectedServiceAuthGroupGenerationApplyFailure({
                errorCode: 'same_provider_account_exhaustion_hot_apply_required',
                serviceId: restartInput.serviceId,
                failurePhase: 'hot_apply',
            });
        const signalRestart = async () => {
            if (builderInput.allowRestart === false) {
                throw new Error('restart_disallowed_by_execution_policy');
            }
            if (sameProviderAccountFanout) {
                throw new Error('same_provider_account_exhaustion_hot_apply_required');
            }
            if (!tracked) throw new Error('session_not_found');
            const restartSignalDelayMs = resolvePositiveIntEnv(
                params.processEnv.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_RESTART_SIGNAL_DELAY_MS,
                250,
                { min: 0, max: 5_000 },
            );
            // K5:gated_restart the FSM's restart-resume fallback when hot-apply is
            // ineligible; gated through deferral + spawn-time reachability (K1).
            await requestConnectedServiceRestartWithDeferral({
                sessionId: builderInput.sessionId,
                tracked,
                source: 'automatic',
                policy: 'defer_until_turn_boundary',
                target: normalizeSwitchTarget({
                    serviceId: restartInput.serviceId,
                    profileId: restartInput.activeProfileId,
                    groupId: restartInput.groupId,
                    generation: restartInput.generation,
                }),
                restartSignalDelayMs,
                restartDiagnostic: {
                    trigger: 'automatic_group_switch',
                    sessionId: builderInput.sessionId,
                    agentId: resolveTrackedSessionCatalogAgentId(tracked),
                    serviceId: restartInput.serviceId,
                    profileId: restartInput.activeProfileId,
                    groupId: restartInput.groupId,
                    generation: restartInput.generation,
                    reason: builderInput.restartReason,
                },
                onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart connected-service auth group session',
            });
        };
        const signalRestartWithoutConfirmedApply = async (): Promise<ConnectedServiceAuthGroupGenerationApplyFailure> => {
            if (sameProviderAccountFanout) return hotApplyOnlyFailure();
            if (builderInput.allowRestart === false) {
                return connectedServiceAuthGroupGenerationApplyFailure({
                    errorCode: 'restart_disallowed_by_execution_policy',
                    serviceId: restartInput.serviceId,
                    failurePhase: 'restart',
                });
            }
            try {
                await signalRestart();
            } catch {
                return connectedServiceAuthGroupGenerationApplyFailure({
                    errorCode: 'restart_failed',
                    serviceId: restartInput.serviceId,
                    failurePhase: 'restart',
                });
            }
            return connectedServiceAuthGroupGenerationApplyFailure({
                errorCode: 'generation_apply_not_confirmed',
                serviceId: restartInput.serviceId,
                failurePhase: 'restart',
            });
        };
        const agentId = tracked
            ? resolveTrackedSessionCatalogAgentId(tracked)
            : inactiveContext?.agentId;
        if (!agentId) {
            return await signalRestartWithoutConfirmedApply();
        }
        const previousBindings = tracked
            ? readConnectedServiceBindingsOrEmpty(resolveTrackedConnectedServiceBindingsRaw(tracked))
            : readConnectedServiceBindingsOrEmpty(inactiveContext?.connectedServices);
        const previousBinding = previousBindings.bindingsByServiceId[restartInput.serviceId];
        const nextProfileId = normalizeOptionalString(restartInput.activeProfileId)
            || (previousBinding?.source === 'connected' ? previousBinding.profileId : '');
        if (
            !previousBinding
            || previousBinding.source !== 'connected'
            || previousBinding.selection !== 'group'
            || !nextProfileId
        ) {
            return await signalRestartWithoutConfirmedApply();
        }
        const runtimeAuthApplyReason = normalizeRuntimeAuthApplyReason(builderInput.restartReason);
        // K5:fsm_switch reactive + proactive-quota auth-generation apply routes through
        // the FSM (hot-apply-in-place when eligible, else gated restart-resume with
        // reachability + deferral + mid-turn re-continue exactly once).
        const result = await applyConnectedServiceAuthGenerationToTrackedSession({
            getChildren: () => Array.from(params.pidToTrackedSession.values()),
            resolveInactiveSession: async ({ sessionId }) => {
                return await resolveInactiveConnectedServiceSessionContext({
                    token: params.credentials.token,
                    credentials: params.credentials,
                    sessionId,
                });
            },
            api: params.api,
            ...(runtimeAuthApplyReason
                ? { runtimeAuthApplyReason }
                : {}),
            resolveContinuity: async ({
                tracked: continuityTracked,
                sessionId,
                agentId: continuityAgentId,
                serviceId,
                previous,
                next,
                previousBindings: continuityPreviousBindings,
                normalizedBindings,
                connectedServiceMaterializationIdentityV1,
                vendorResumeId,
                runtimeAuthSelection,
                cwd: inactiveCwd,
                candidatePersistedSessionFile: inactiveCandidatePersistedSessionFile,
            }) => {
                const persistedSessionMetadata = continuityTracked
                    ? await readPersistedConnectedServiceSwitchSessionMetadata(sessionId)
                    : null;
                const continuityContext = resolveTrackedConnectedServiceSwitchContinuityContext({
                    agentId: continuityAgentId,
                    baseDir: params.connectedServicesMaterializationBaseDir,
                    tracked: continuityTracked,
                    persistedSessionMetadata,
                    connectedServiceMaterializationIdentityV1,
                    vendorResumeId,
                    runtimeAuthSelection,
                    cwd: inactiveCwd,
                    candidatePersistedSessionFile: inactiveCandidatePersistedSessionFile ?? null,
                });
                return await resolveSessionConnectedServiceSwitchContinuity({
                    sessionId,
                    agentId: continuityAgentId,
                    serviceId,
                    previousBinding: previous,
                    nextBinding: next,
                    tracked: continuityTracked,
                    connectedServiceMaterializationIdentityV1: continuityContext.connectedServiceMaterializationIdentityV1,
                    vendorResumeId: continuityContext.vendorResumeId,
                    fromBindingsRaw: continuityTracked
                        ? resolveTrackedConnectedServiceBindingsRaw(continuityTracked) ?? continuityPreviousBindings
                        : continuityPreviousBindings,
                    toBindings: normalizedBindings,
                    accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
                    targetMaterializedRoot: continuityContext.targetMaterializedRoot,
                    targetMaterializedEnv: continuityContext.targetMaterializedEnv,
                    cwd: continuityContext.cwd,
                    candidatePersistedSessionFile: continuityContext.candidatePersistedSessionFile,
                    ...(runtimeAuthSelection === undefined ? {} : { runtimeAuthSelection }),
                });
            },
            materializeRuntimeAuthSelection: async (materializerInput) =>
                await materializeSessionConnectedServiceRuntimeAuthSelection({
                    credentials: params.credentials,
                    api: params.api,
                    activeServerDir: configuration.activeServerDir,
                    input: materializerInput,
                    accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
                    processEnv: params.processEnv,
                }),
            restartSession: async () => {
                await signalRestart();
            },
            persistSessionBindings: async ({
                sessionId,
                normalizedBindings,
                connectedServiceMaterializationIdentityV1,
            }) => {
                const trackedForSession = findTrackedSessionByHappySessionId(
                    params.pidToTrackedSession.values(),
                    sessionId,
                );
                await persistSessionConnectedServiceBindings({
                    token: params.credentials.token,
                    credentials: params.credentials,
                    sessionId,
                    normalizedBindings,
                    connectedServiceMaterializationIdentityV1:
                        connectedServiceMaterializationIdentityV1 === undefined
                            ? resolveConnectedServiceMaterializationIdentityFromTrackedSession(trackedForSession)
                            : connectedServiceMaterializationIdentityV1,
                });
                forgetPersistedConnectedServiceSwitchSessionMetadata(sessionId);
            },
            continueAfterRuntimeAuthSwitch: createConnectedServiceContinuationHandler({
                credentials: params.credentials,
                interruptedOriginId: builderInput.interruptedOriginId,
                resumePromptMode: await resolveContinuationResumePromptMode({
                    serviceId: restartInput.serviceId,
                    groupId: previousBinding.groupId,
                    loadGroupPolicy: previousBinding.groupId
                        ? async () => (await params.api.getConnectedServiceAuthGroup({
                            serviceId: restartInput.serviceId,
                            groupId: previousBinding.groupId,
                        }))?.policy ?? null
                        : undefined,
                }),
                customResumePrompt: readContinuationCustomResumePrompt(getActiveAccountSettingsSnapshot()?.settings ?? null),
                recoveryKind: builderInput.restartReason === 'usage_limit' || builderInput.restartReason === 'rate_limit'
                    ? builderInput.restartReason
                    : null,
                resolveInterruption: ({ sessionId, action, switchReason }) =>
                    resolveConnectedServiceContinuationInterruptionForSwitch({
                        sessionId,
                        interruptedSessionId: builderInput.interruptedSessionId,
                        action,
                        switchReason,
                        groupSwitchTriggerReason: builderInput.restartReason,
                        turnDeferralQueue: connectedServiceTurnDeferralQueue,
                    }),
            }),
            recoverAfterRuntimeAuthSwitch: createSelectionPostSwitchRecoveryHandler({
                getTrackedSessions: () => Array.from(params.pidToTrackedSession.values()),
                isTurnInFlight: (sessionId) => connectedServiceTurnDeferralQueue.isTurnInFlight(sessionId),
            }),
            verifyProviderAccountAdoption: async (verificationInput) => {
                const result = await verifySessionConnectedServiceAccountAdoption(verificationInput);
                recordRuntimeAccountIdentityFromVerification({
                    quotaCoordinator: params.getConnectedServiceQuotasCoordinator(),
                    verificationInput,
                    result,
                    observedAtMs: Date.now(),
                });
                return result;
            },
            hotApply: createSessionConnectedServiceAuthHotApply(),
            registerHotApplyTargets: registerHotApplyRuntimeTarget,
            emitSessionEvent: (sessionId, event) => {
                if (!shouldCommitAutomaticGroupApplySessionEvent(event, {
                    commitAccountSwitchEvents: builderInput.commitAccountSwitchEvents,
                    ...(builderInput.executionAuthority
                        ? { executionAuthority: builderInput.executionAuthority }
                        : {}),
                })) return;
                commitConnectedServiceAccountSwitchSessionEventWithNotification({
                    sessionId,
                    event,
                    logContext: 'automatic',
                });
            },
            dryRun: builderInput.dryRun === true,
            request: {
                sessionId: builderInput.sessionId,
                agentId,
                bindings: {
                    v: 1,
                    bindingsByServiceId: {
                        ...previousBindings.bindingsByServiceId,
                        [restartInput.serviceId]: {
                            ...previousBinding,
                            groupId: restartInput.groupId,
                            profileId: nextProfileId,
                        },
                    },
                },
                expectedGroupGenerationByServiceId: {
                    [restartInput.serviceId]: restartInput.generation,
                },
            },
            reason: 'automatic_runtime_failure',
        });
        return result;
    };

    /**
     * K2 (cmpn4hhdi fix): the PROACTIVE quota-driven pre-turn switch coordinator. It is
     * built HERE (where the FSM/deferral/hot-apply primitives live) and handed to the
     * quotas coordinator via startDaemonRuntimeBootstrap. With a sessionId present, its
     * `restartSession` is the shared FSM apply builder above — so the appServer usage-limit
     * switch hot-applies in place when eligible (+ X4), and otherwise gates a deferred
     * restart-resume with the K1 reachability gate, instead of the previous raw SIGTERM.
     * Pre-turn switches are clean boundaries and therefore never author a continuation row.
     */
    const createSessionQuotaDrivenAuthGroupSwitchCoordinator = (input: Readonly<{
        sessionId: string;
        reason: string;
        allowRestart?: boolean;
        executionAuthority?: ConnectedServiceGenerationExecutionAuthority;
    }>) => createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator({
        api: params.api,
        runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
        accountUsageStore: providerAccountUsageStore,
        leases: connectedServiceAuthGroupSwitchLeases,
        quotaFreshnessMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_QUOTA_FRESHNESS_MS,
            5 * 60_000,
            { min: 1_000, max: 60 * 60_000 },
        ),
        nowMs: () => Date.now(),
        resolveCredentialRevision: (serviceId, profileId) => (
            latestConnectedServiceProjectionSnapshot?.resolveCredentialRevision(serviceId, profileId) ?? null
        ),
        quotaCoordinator: params.getConnectedServiceQuotasCoordinator(),
        restartSession: buildConnectedServiceAuthGroupRestartSession({
            sessionId: input.sessionId,
            restartReason: input.reason,
            commitAccountSwitchEvents: false,
            allowRestart: input.allowRestart,
            ...(input.executionAuthority ? { executionAuthority: input.executionAuthority } : {}),
        }),
        preflightConnectedServiceAuthGeneration: buildConnectedServiceAuthGroupRestartSession({
            sessionId: input.sessionId,
            restartReason: input.reason,
            commitAccountSwitchEvents: false,
            dryRun: true,
        }),
        emitEvent: () => undefined,
    });

    const connectedServiceAuthGroupPreTurnSwitchCoordinator = {
        switchBeforeTurn: async (input: Readonly<{
            sessionId?: string;
            serviceId: string;
            groupId: string;
            reason: 'usage_limit' | 'soft_threshold' | 'same_provider_account_exhausted' | 'auth_expired' | 'account_changed' | 'refresh_failed';
        }>): Promise<unknown> => {
            const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
            if (!sessionId) return { status: 'session_not_found' };
            const tracked = Array.from(params.pidToTrackedSession.values())
                .find((child) => child.happySessionId === sessionId) ?? null;
            if (!tracked) return { status: 'session_not_found' };
            const proactiveCoordinator = createSessionQuotaDrivenAuthGroupSwitchCoordinator({
                sessionId,
                reason: input.reason,
            });
            // O3: switch-attempt trace at the proactive-quota decision point (the cmpn4hhdi seam).
            const proactiveSwitchResult = await proactiveCoordinator.switchBeforeTurn(input);
            logger.debug('[DAEMON RUN] Connected-service proactive quota switch attempt', {
                trigger: 'automatic_group_switch',
                decision: 'proactive_quota_switch_before_turn',
                sessionId,
                serviceId: input.serviceId,
                groupId: input.groupId,
                reason: input.reason,
                resultStatus: (proactiveSwitchResult as { status?: unknown }).status ?? null,
                routedThroughFsm: true,
            });
            return proactiveSwitchResult;
        },
        applyCommittedGeneration: async (input: Readonly<{
            sessionId: string;
            serviceId: string;
            groupId: string;
            activeProfileId: string;
            generation: number;
            credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
            reason: string;
            allowRestart?: boolean;
            executionAuthority?: ConnectedServiceGenerationExecutionAuthority;
        }>) => {
            const sessionId = input.sessionId.trim();
            const tracked = Array.from(params.pidToTrackedSession.values())
                .find((child) => child.happySessionId === sessionId) ?? null;
            if (!sessionId || !tracked) {
                return {
                    status: 'session_not_found',
                    generation: input.generation,
                    errorCode: 'session_not_found',
                };
            }
            // Recipients consume the source session's immutable committed generation. They must
            // never re-enter selection/CAS and independently advance the group generation.
            const recipientCoordinator = createSessionQuotaDrivenAuthGroupSwitchCoordinator({
                sessionId,
                reason: input.reason,
                allowRestart: input.allowRestart,
                ...(input.executionAuthority ? { executionAuthority: input.executionAuthority } : {}),
            });
            const result = await recipientCoordinator.applyCommittedGeneration(input);
            if (
                input.allowRestart === false
                && result.status === 'generation_apply_failed'
                && result.errorCode === 'restart_failed'
            ) {
                return {
                    ...result,
                    errorCode: 'restart_disallowed_by_execution_policy',
                };
            }
            return result;
        },
    };

    /**
     * K3 (D7): gated restart adapter for the credential-refresh / reconnect handler. The
     * refresh handler owns the eligibility/blocking decision; this adapter only enforces
     * turn-deferral + the spawn-time reachability gate (no raw mid-turn SIGTERM). Pure
     * refresh has no target generation rebind, so it routes through the gated restart
     * primitive rather than the FSM.
     */
    const requestConnectedServiceRefreshRestartSignal = async (signalParams: Readonly<{
        pid: number;
        delayMs: number;
        preferProcessGroup?: boolean;
        shouldSignal?: () => boolean;
        onSignalFailure: (error: unknown) => void;
        restartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticInput;
        recordRestartDiagnostic?: (record: ConnectedServiceDaemonRestartDiagnosticRecord) => void;
        nowMs?: () => number;
    }>): Promise<Readonly<{ signaled: boolean }>> => {
        const tracked = params.pidToTrackedSession.get(signalParams.pid) ?? null;
        if (!tracked) {
            signalParams.onSignalFailure(new Error('refresh_restart_tracked_session_missing'));
            return { signaled: false };
        }
        const diagnostic = signalParams.restartDiagnostic;
        const sessionId = (typeof diagnostic?.sessionId === 'string' && diagnostic.sessionId.trim())
            ? diagnostic.sessionId.trim()
            : (tracked.happySessionId ?? '');
        logger.debug('[DAEMON RUN] Connected-service refresh restart attempt', {
            trigger: diagnostic?.trigger ?? 'refresh_triggered_restart',
            decision: 'gated_refresh_restart',
            sessionId,
            serviceId: diagnostic?.serviceId ?? null,
            groupId: diagnostic?.groupId ?? null,
            generation: diagnostic?.generation ?? null,
            deferralPolicy: 'defer_until_turn_boundary',
            routedThroughGatedPrimitive: true,
        });
        try {
            // K5:gated_restart refresh/reconnect restart deferred until turn boundary,
            // reachability re-verified at respawn (no raw mid-turn SIGTERM). Propagate whether a
            // signal was actually emitted so the refresh handler reserves the pid only when it was —
            // a superseded/cancelled deferral must not leak a reservation (F4).
            return await requestConnectedServiceRestartWithDeferral({
                sessionId,
                tracked,
                source: 'automatic',
                policy: 'defer_until_turn_boundary',
                target: normalizeSwitchTarget({
                    serviceId: typeof diagnostic?.serviceId === 'string' ? diagnostic.serviceId : '',
                    profileId: typeof diagnostic?.profileId === 'string' ? diagnostic.profileId : '',
                    groupId: typeof diagnostic?.groupId === 'string' ? diagnostic.groupId : '',
                    generation: typeof diagnostic?.generation === 'number' ? diagnostic.generation : null,
                }),
                restartSignalDelayMs: signalParams.delayMs,
                restartDiagnostic: diagnostic ?? {
                    trigger: 'refresh_triggered_restart',
                    sessionId,
                },
                onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart connected-service credential-refreshed session',
            });
        } catch (error) {
            signalParams.onSignalFailure(error);
            return { signaled: false };
        }
    };

    const foregroundAgentRuntimeAdmission =
        createForegroundAgentRuntimeAdmissionOwner({
            prepare: prepareForegroundAgentRuntimeAdmission,
        });
    const externalSessionHostOperationOwner =
        createExternalSessionHostOperationOwner();
    const agentRuntimeSessionBridge = createAgentRuntimeSessionBridgeRoutes({
        foregroundAdmission: foregroundAgentRuntimeAdmission,
        authorizeProviderModelTransition: async (input) => {
            const tracked = findTrackedSessionByHappySessionId(
                params.pidToTrackedSession.values(),
                input.sessionId,
            );
            return await authorizeDaemonSessionModelTransitionProviderTarget({
                trackedAgentId: resolveTrackedSessionCatalogAgentId(tracked),
                trackedSelection:
                    tracked?.spawnOptions?.modelSelection?.ref ?? null,
                trackedSessionBindingMetadata:
                    tracked?.spawnOptions?.providerBindingMetadataV1 ?? null,
                requestAgentId: input.agentId,
                requestedSelection: input.selection,
                authorizeProviderTarget: async (authority) =>
                    await authorizeSessionModelTransitionProviderTargetWithLease({
                        sessionId: input.sessionId,
                        machineId: params.machineId,
                        agentId: authority.agentId,
                        agentTargetKey: authority.agentTargetKey,
                        lease: input.lease,
                        input: authority.input,
                    }),
            });
        },
        externalSessionHostOperationOwner,
        externalSessionHostBindingContext: Object.freeze({
            machineId: params.machineId,
            readAccountRevision: () =>
                resolveActiveAccountSettingsSnapshotRevision(
                    getActiveAccountSettingsSnapshot(),
                ),
        }),
        resolveStartupInstructions(sessionId) {
            const tracked = findTrackedSessionByHappySessionId(
                params.pidToTrackedSession.values(),
                sessionId,
            );
            const startupInstructions =
                tracked?.spawnOptions?.agentSessionStartupInstructionsV1;
            const requiredMarker =
                tracked?.agentSessionStartupInstructionsMarkerV1;
            if (!requiredMarker) {
                return startupInstructions;
            }
            if (
                !startupInstructions
                || !startupInstructionsMarkerMatchesCarrier(
                    requiredMarker,
                    startupInstructions,
                )
            ) {
                throw new Error(
                    'startup_instructions_required_carrier_unavailable_or_mismatched',
                );
            }
            return startupInstructions;
        },
        async onStartupInstructionsApplied(sessionId, marker) {
            const tracked = findTrackedSessionByHappySessionId(
                params.pidToTrackedSession.values(),
                sessionId,
            );
            if (!tracked) {
                throw new Error(
                    'startup_instructions_marker_session_not_tracked',
                );
            }
            const spawnOptions = tracked.spawnOptions;
            if (!spawnOptions) {
                throw new Error(
                    'startup_instructions_marker_spawn_options_missing',
                );
            }
            const requiredMarker =
                tracked.agentSessionStartupInstructionsMarkerV1;
            const startupInstructions =
                spawnOptions.agentSessionStartupInstructionsV1;
            if (
                !requiredMarker
                || !startupInstructions
                || !startupInstructionsMarkersEqual(
                    requiredMarker,
                    marker,
                )
                || !startupInstructionsMarkerMatchesCarrier(
                    marker,
                    startupInstructions,
                )
            ) {
                throw new Error(
                    'startup_instructions_marker_identity_mismatch',
                );
            }
            const acceptedSpawnMarkerGate =
                tracked.acceptedSpawnMarkerGate;
            if (
                acceptedSpawnMarkerGate
                && !await acceptedSpawnMarkerGate
            ) {
                throw new Error(
                    'startup_instructions_marker_spawn_custody_unproven',
                );
            }
            const {
                agentSessionStartupInstructionsV1: _appliedStartupInstructions,
                ...retainedSpawnOptions
            } = spawnOptions;
            tracked.spawnOptions = retainedSpawnOptions;
            const persisted =
                await updateSessionMarkerAgentSessionStartupInstructionsMarker({
                    pid: tracked.pid,
                    sessionId,
                    marker,
                    ...(spawnOptions.spawnNonce
                        ? {
                            expectedSpawnNonce:
                                spawnOptions.spawnNonce,
                        }
                        : {}),
                });
            if (!persisted) {
                throw new Error(
                    'startup_instructions_marker_persistence_mismatch',
                );
            }
        },
    });
    const onChildExitedBase = createOnChildExited({
        pidToTrackedSession: params.pidToTrackedSession,
        spawnResourceCleanupByPid: params.spawnResourceCleanupByPid,
        sessionAttachCleanupByPid: params.sessionAttachCleanupByPid,
        getApiMachineForSessions: params.getApiMachineForSessions,
        beforeUnexpectedExitSettlement: async (tracked) => {
            const sessionId = normalizeOptionalString(tracked.happySessionId);
            if (sessionId && tracked.startedBy === 'daemon') {
                const cycle = runnerTerminalCycleBySessionId.get(sessionId) ?? {
                    entriesByPid: new Map(),
                };
                runnerTerminalCycleBySessionId.set(sessionId, cycle);
                const previousEntry = cycle.entriesByPid.get(tracked.pid);
                if (previousEntry?.tracked === tracked) {
                    return;
                }
                const entry: {
                    tracked: TrackedSession;
                    admission: CapturedRunnerTerminal;
                } = {
                    tracked,
                    admission: {
                        status: 'unavailable',
                        sessionId,
                    },
                };
                cycle.entriesByPid.set(tracked.pid, entry);
                try {
                    const captured = await params.getApiMachineForSessions()
                        ?.captureMachineSessionTerminal(sessionId);
                    if (captured?.status === 'captured') {
                        entry.admission = {
                            status: 'captured',
                            sessionId: captured.sessionId,
                            committedFenceMs: captured.committedFenceMs,
                        };
                    } else if (captured?.status === 'already_inactive') {
                        entry.admission = {
                            status: 'already_inactive',
                            sessionId,
                        };
                    }
                } catch (error) {
                    logger.debug('[DAEMON RUN] Failed to capture exact Session fence before respawn; marker will retain recovery custody', {
                        sessionId,
                        pid: tracked.pid,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        },
        onUnexpectedExit: (tracked, exit) => {
            const transientSpawnOptions = tracked.happySessionId
                ? takeVersionRuntimeRefreshTransientSpawnOptions(tracked.happySessionId, tracked.pid)
                : undefined;
            const disposition = sessionRunnerRespawnManager.handleUnexpectedExit(tracked, exit, {
                forceRestart: params.connectedServicesRestartRequestedPids.has(tracked.pid),
                ...(transientSpawnOptions ? { spawnOptionsOverride: transientSpawnOptions } : {}),
            });
            if (disposition === 'scheduled') {
                runnerRespawnScheduledPids.add(tracked.pid);
            } else if (disposition === 'ignored' && tracked.happySessionId) {
                runnerRespawnScheduledPids.delete(tracked.pid);
                void settleCapturedRunnerTerminal({
                    sessionId: tracked.happySessionId,
                    previousPid: tracked.pid,
                    reason: 'no_restart',
                });
            } else {
                runnerRespawnScheduledPids.delete(tracked.pid);
            }
        },
        isExitUnexpectedOverride: (tracked) => {
            if (!params.connectedServicesRestartRequestedPids.has(tracked.pid)) {
                return null;
            }
            return true;
        },
        onPidPromoted: onTrackedSessionPidPromoted,
        shouldPreserveSessionMarkerOnExit: ({ trackedSession, unexpected }) => {
            return unexpected && trackedSession.startedBy === 'daemon';
        },
    });
    onChildExited = async (pid, exit) => {
        const trackedBeforeExit = params.pidToTrackedSession.get(pid) ?? null;
        const connectedServiceRestartWasRequested = params.connectedServicesRestartRequestedPids.has(pid);
        await onChildExitedBase(pid, exit);
        const trackedAfterExit = params.pidToTrackedSession.get(pid) ?? null;
        void params.connectedServiceGroupHomeCleanupScheduler?.cleanupPendingDeletedGroupHomes().catch((error) => {
            logger.debug('[DAEMON RUN] Connected-service group home cleanup tick failed (non-fatal)', error);
        });
        void params.connectedServiceMaterializedHomeCleanupScheduler?.cleanupPendingMaterializedHomes().catch((error) => {
            logger.debug('[DAEMON RUN] Connected-service materialized home cleanup tick failed (non-fatal)', error);
        });
        if (trackedBeforeExit === null || trackedAfterExit === trackedBeforeExit) {
            return;
        }
        await releaseExecutionRunAuthorityForRunnerExit({
            runnerPid: pid,
            runnerIdentity: trackedBeforeExit,
        });
        if (trackedAfterExit !== null) {
            logger.debug('[DAEMON RUN] PID ownership changed while observing child exit; preserving replacement runtime custody', {
                pid,
                exitedSessionId: trackedBeforeExit.happySessionId,
                replacementSessionId: trackedAfterExit.happySessionId,
            });
            return;
        }
        const restartWasRequested = connectedServiceRestartWasRequested || runnerRespawnScheduledPids.has(pid);
        if (!params.pidToTrackedSession.has(pid)) {
            connectedServiceRuntimeRegistry.unregisterPid(pid);
        }
        if (connectedServiceRestartWasRequested) {
            params.connectedServicesRestartRequestedPids.delete(pid);
        }
        if (trackedBeforeExit?.happySessionId) {
            const stillLive = Array.from(params.pidToTrackedSession.values())
                .some((child) => child.happySessionId === trackedBeforeExit.happySessionId);
            if (!stillLive) {
                await agentRuntimeSessionBridge.disposeSession(
                    trackedBeforeExit.happySessionId,
                ).catch((error) => {
                    logger.debug(
                        '[DAEMON RUN] Agent runtime session bridge cleanup failed (non-fatal)',
                        error,
                    );
                });
                connectedServiceTurnDeferralQueue.cancelSession(
                    trackedBeforeExit.happySessionId,
                    restartWasRequested ? 'session_restarting' : 'session_terminated',
                );
            }
            if (!stillLive && !restartWasRequested) {
                connectedServiceRuntimeAuthSwitchAttempts.clearSession(trackedBeforeExit.happySessionId);
                connectedServiceSessionAuthSwitchCore.clearSession(trackedBeforeExit.happySessionId);
                void disposeSessionHookArtifactsForSession({
                    happyHomeDir: configuration.happyHomeDir,
                    sessionId: trackedBeforeExit.happySessionId,
                }).catch((error) => {
                    logger.debug('[DAEMON RUN] Session hook artifact cleanup failed (non-fatal)', error);
                });
                void disposeTerminalAttachmentInfoForSession({
                    happyHomeDir: configuration.happyHomeDir,
                    sessionId: trackedBeforeExit.happySessionId,
                }).catch((error) => {
                    logger.debug('[DAEMON RUN] Terminal attachment cleanup failed (non-fatal)', error);
                });
                // BRW-6 privacy: when a session terminates for good (no live sibling, not restarting),
                // purge its `session`-mode browser profiles + bound on-disk partitions. Fail-closed
                // inside the owner (failed purge marks the profile unusable + audits).
                void purgeBrowserStorageForSessionDeleted(trackedBeforeExit.happySessionId).catch((error) => {
                    logger.debug('[DAEMON RUN] Browser storage session-delete purge failed (non-fatal)', error);
                });
            }
            void queueHostedWebStaticAssetSync('session_exit');
        }
    };
    observeConnectedServiceRestartProcessMissing = (tracked) => {
        const exit = { reason: 'process-missing', code: null, signal: null };
        try {
            onChildExited(tracked.pid, exit);
            return;
        } catch (error) {
            logger.warn('[DAEMON RUN] Failed to observe connected-service restart process exit through child-exit path', error);
        }
        const spawnCleanup = params.spawnResourceCleanupByPid.get(tracked.pid);
        if (spawnCleanup) {
            params.spawnResourceCleanupByPid.delete(tracked.pid);
            try {
                spawnCleanup();
            } catch (error) {
                logger.debug('[DAEMON RUN] Failed to run spawn cleanup after connected-service restart process disappeared', error);
            }
        }
        const attachCleanup = params.sessionAttachCleanupByPid.get(tracked.pid);
        if (attachCleanup) {
            params.sessionAttachCleanupByPid.delete(tracked.pid);
            void attachCleanup().catch((error) => {
                logger.debug('[DAEMON RUN] Failed to run attach cleanup after connected-service restart process disappeared', error);
            });
        }
        params.pidToTrackedSession.delete(tracked.pid);
        params.connectedServicesRestartRequestedPids.delete(tracked.pid);
        connectedServiceRuntimeRegistry.unregisterPid(tracked.pid);
        sessionRunnerRespawnManager.handleUnexpectedExit(tracked, exit, { forceRestart: true });
    };
    const stopSession = async (sessionId: string): Promise<StopSessionResult> =>
        await disconnectedTerminalHostResumeLifecycle.runStop(sessionId, async () => {
            sessionRunnerRespawnManager.markStopRequested(sessionId, { reason: 'daemon_stop_session', requestedAtMs: Date.now() });
            await connectedServiceRecoverySupersessionCleaner({
                sessionId,
                event: { kind: 'manual_session_supersession', reason: 'stop' },
            });
            physicallyRetiredTerminalAttachmentIdBySessionId.delete(sessionId);
            const trackedStopResult = await stopSessionCore(sessionId);
            const physicallyRetiredAttachmentId = physicallyRetiredTerminalAttachmentIdBySessionId.get(sessionId);
            physicallyRetiredTerminalAttachmentIdBySessionId.delete(sessionId);
            if (isTerminalHostPhysicallyRetiredStopResult(trackedStopResult) && physicallyRetiredAttachmentId) {
                return {
                    stopResult: trackedStopResult,
                    retireCandidate: { sessionId, attachmentId: physicallyRetiredAttachmentId },
                };
            }
            if (
                trackedStopResult.status !== 'incomplete'
                || trackedStopResult.reason !== 'tracked_runner_absent'
            ) {
                return { stopResult: trackedStopResult };
            }
            const normalizedSessionId = sessionId.trim();
            const candidate = disconnectedTerminalHostCandidates.find(
                (value) => value.sessionId === normalizedSessionId
                    && !terminalizedDisconnectedTerminalHostIds.has(value.attachmentId),
            );
            if (!candidate) return { stopResult: trackedStopResult };
            const runnerProbe = await probeSessionRunnerServiceability({
                sessionId: normalizedSessionId,
                trackedSessions: params.pidToTrackedSession.values(),
                probeCapability: async () => await probeAlreadyRunningExistingSessionServiceability({
                    sessionId: normalizedSessionId,
                    credentials: params.credentials,
                    abortSignal: shutdownCancellationDomains.daemonWorkSignal,
                    ...(params.isShuttingDown ? { isShuttingDown: params.isShuttingDown } : {}),
                }),
            });
            if (runnerProbe.state !== 'runner_absent') return { stopResult: trackedStopResult };

            const candidatePidToTrackedSession = new Map<number, TrackedSession>([[
                candidate.pid,
                { startedBy: 'daemon', happySessionId: normalizedSessionId, pid: candidate.pid },
            ]]);
            const stopDisconnectedHost = createStopSession({
                pidToTrackedSession: candidatePidToTrackedSession,
                expectedTerminalAttachmentId: candidate.attachmentId,
                terminalHostAdapters: await params.loadTerminalHostAdapters?.() ?? {},
                provenTerminalHostKindsByPid: new Map([[candidate.pid, candidate.handle.kind]]),
                ...(candidate.terminalMode
                    ? { provenTerminalModesByPid: new Map([[candidate.pid, candidate.terminalMode]]) }
                    : {}),
                requireTerminalTopologyProof: true,
                areTrackedRunnersExited: async ({ trackedPids }) => await waitForTrackedRunnerProcessesExit({
                    runners: trackedPids.map((pid) => ({ pid })),
                    timeoutMs: 0,
                    pollIntervalMs: 0,
                }),
                waitForTrackedRunnersExit: async ({ trackedPids }) => await waitForTrackedRunnerProcessesExit({
                    runners: trackedPids.map((pid) => ({ pid })),
                    timeoutMs: configuration.daemonStopSessionWaitForExitMs,
                    pollIntervalMs: configuration.daemonStopSessionWaitForExitPollIntervalMs,
                }),
                onExactTerminalAttachmentRetired: notifyTerminalAttachmentRetiredThroughCatalog,
                retireExactTerminalControlServiceability: async ({ sessionId, attachmentInfo, terminalMode }) => {
                    await retireExactTerminalControlServiceability({
                        credentials: params.credentials,
                        sessionId,
                        attachmentId: attachmentInfo.attachmentId,
                        terminalMode,
                    });
                },
            });
            const candidateStopResult = await stopDisconnectedHost(normalizedSessionId);
            return isTerminalHostPhysicallyRetiredStopResult(candidateStopResult)
                ? {
                    stopResult: candidateStopResult,
                    retireCandidate: {
                        sessionId: normalizedSessionId,
                        attachmentId: candidate.attachmentId,
                    },
                }
                : { stopResult: candidateStopResult };
        });
    const isSessionAlreadyRunning = async (sessionId: string): Promise<boolean> =>
        await isSessionRunnerActive(sessionId);
    const controlToken = randomBytes(32).toString('base64url');
    const recordConnectedServiceContinuationProviderActivity =
        createConnectedServiceProviderActivityProofRecorder({
            // `runtimeAuthRecoveryScheduler` is constructed later in this function; the
            // recorder only runs on turn-lifecycle events after startup completes.
            runtimeAuthRecovery: {
                markProviderOutcomeProofByIdentity: async (input) => {
                    await runtimeAuthRecoveryScheduler.markProviderOutcomeProofByIdentity(input);
                },
            },
            logDebug: (message, error) => logger.debug(message, error),
        });
    const runtimeAuthRecoveryStormEvents: number[] = [];
    const runtimeAuthRecoveryStormWindowMs = resolvePositiveIntEnv(
        params.processEnv.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_STORM_WINDOW_MS,
        60_000,
        { min: 1_000, max: 60 * 60_000 },
    );
    const runtimeAuthRecoveryStormThreshold = resolvePositiveIntEnv(
        params.processEnv.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_STORM_THRESHOLD,
        5,
        { min: 1, max: 1_000 },
    );
    const runtimeAuthRecoveryStormDelayMs = resolvePositiveIntEnv(
        params.processEnv.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_STORM_DELAY_MS,
        30_000,
        { min: 1_000, max: 60 * 60_000 },
    );
    const runtimeAuthRecoveryJitterMaxMs = resolvePositiveIntEnv(
        params.processEnv.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_JITTER_MS,
        250,
        { min: 1, max: 60_000 },
    );
    const shouldCountRuntimeAuthRecoveryAsLocalServerStorm = (classification: RuntimeAuthRecoveryDiagnostic['errorClassification']): boolean => {
        if (classification?.retryable !== true) return false;
        return classification.kind === 'timeout'
            || classification.kind === 'network'
            || classification.kind === 'server_error';
    };
    const pruneRuntimeAuthRecoveryStormEvents = (nowMs: number): void => {
        const cutoffMs = nowMs - runtimeAuthRecoveryStormWindowMs;
        while (runtimeAuthRecoveryStormEvents.length > 0 && (runtimeAuthRecoveryStormEvents[0] ?? 0) < cutoffMs) {
            runtimeAuthRecoveryStormEvents.shift();
        }
    };
    const recordRuntimeAuthRecoveryDiagnostic = (diagnostic: RuntimeAuthRecoveryDiagnostic): void => {
        logger.debug('[DAEMON RUN] Connected-service runtime-auth recovery diagnostic', diagnostic);
        if (diagnostic.transcriptEvent) {
            runtimeAuthRecoveryScheduler.schedulePendingVisibleEventDrain({
                deliver: deliverRuntimeAuthRecoveryVisibleEvent,
                onError: (error) => {
                    logger.debug('[DAEMON RUN] Failed to commit connected-service runtime-auth recovery session event (non-fatal)', {
                        sessionId: diagnostic.sessionId,
                        serviceId: diagnostic.serviceId,
                        error: serializeAxiosErrorForLog(error),
                    });
                },
            });
        }
        if (
            diagnostic.event === 'runtime_auth_recovery_enqueue'
            && shouldCountRuntimeAuthRecoveryAsLocalServerStorm(diagnostic.errorClassification)
        ) {
            const nowMs = Date.now();
            pruneRuntimeAuthRecoveryStormEvents(nowMs);
            runtimeAuthRecoveryStormEvents.push(nowMs);
        }
        if (
            diagnostic.event === 'runtime_auth_recovery_dead_letter'
            || diagnostic.event === 'runtime_auth_recovery_terminal'
        ) {
            logger.warn('[DAEMON RUN] Connected-service runtime-auth recovery stopped', diagnostic);
        }
        if (diagnostic.event === 'runtime_auth_recovery_success') {
            runtimeAuthRecoveryStormEvents.length = 0;
        }
    };
    const resolveCurrentRuntimeAuthFailureSourceForSession: NonNullable<
        Parameters<typeof authorizeConnectedServiceRuntimeAuthFailureSource>[0]['resolveCurrentRuntimeAuthFailureSource']
    > = async ({ sessionId: liveSessionId, tracked, classification: liveClassification }) => {
        const agentId = resolveTrackedSessionCatalogAgentId(tracked);
        return await resolveCurrentRuntimeAuthFailureSource({
            classification: liveClassification,
            readRuntimeIdentity: async (request) => {
                const transport = createSessionConnectedServiceAuthTransport({
                    credentials: params.credentials,
                    sessionId: liveSessionId,
                });
                const result = await transport.readConnectedServiceRuntimeIdentity({
                    serviceId: request.serviceId,
                    reason: 'usage_limit',
                    requireExactProof: true,
                    expected: {
                        groupId: request.groupId,
                        profileId: request.profileId,
                        generation: request.generation,
                        ...(request.credentialRevision
                            ? { credentialRevision: request.credentialRevision }
                            : {}),
                    },
                });
                if (!result?.ok) {
                    return {
                        status: 'unavailable',
                        reason: `connected-service runtime identity transport unavailable (${result?.code ?? result?.error ?? 'unknown'})`,
                    };
                }
                if (!result.value.ok) {
                    return {
                        status: 'unavailable',
                        reason: `connected-service runtime identity probe unavailable (${result.value.errorCode ?? 'unknown'})`,
                    };
                }
                if (result.value.serviceId !== request.serviceId) return null;
                return {
                    serviceId: request.serviceId,
                    proofStrength: result.value.identity.proofStrength,
                    providerAccountId: normalizeOptionalString(result.value.identity.providerAccountId),
                    profileId: normalizeOptionalString(result.value.runtime?.profileId),
                    groupId: normalizeOptionalString(result.value.runtime?.groupId),
                    generation: normalizeNullableGeneration(result.value.runtime?.generation),
                    credentialRevision: normalizeOptionalString(result.value.runtime?.credentialRevision),
                };
            },
            resolveCurrentCredential: async (serviceId, profileId) => {
                const resolutions = await resolveConnectedServiceCredentialResolutions({
                    credentials: params.credentials,
                    api: params.api,
                    bindings: [{ serviceId, profileId }],
                });
                const resolution = resolutions?.get(serviceId) ?? null;
                return resolution?.revisionSemantics === 'revisioned'
                    ? resolution
                    : null;
            },
            resolveLegacySourceRevision: agentId
                ? (compatibilityInput) =>
                    resolveLegacyConnectedServiceRuntimeAuthFailureSourceRevisionThroughCatalog(
                        agentId,
                        compatibilityInput,
                    )
                : null,
        });
    };
    const resolveRegisteredRuntimeAuthFailureSourceForSession: NonNullable<
        Parameters<typeof authorizeConnectedServiceRuntimeAuthFailureSource>[0]['resolveRegisteredRuntimeAuthFailureSource']
    > = async ({ sessionId: liveSessionId, tracked, classification: liveClassification }) => {
        const serviceId = ConnectedServiceIdSchema.safeParse(liveClassification.serviceId);
        if (!serviceId.success) return null;
        const target = connectedServiceRuntimeRegistry.getBySessionId(liveSessionId);
        if (!target || target.pid !== tracked.pid || target.sessionId !== liveSessionId) return null;
        const binding = target.activeBindings.find((candidate) => candidate.serviceId === serviceId.data);
        if (!binding) return null;
        return {
            serviceId: binding.serviceId,
            groupId: binding.groupId,
            profileId: binding.profileId,
            generation: binding.groupGeneration,
            credentialRevision: binding.credentialRevision,
        };
    };
    const runConnectedServiceRuntimeAuthFailureRecovery = async (input: Readonly<{
        sessionId: string;
        switchesThisTurn: number;
        interruptedOriginId?: string;
        resumePromptMode?: SessionContinuationResumePromptModeV1;
        // Scheduler replays (`scheduler_retry`) of persisted intents may be superseded when the
        // failing profile is no longer the session's spawned active profile; in-band reports
        // (default `daemon_report`) are fresh evidence and always run the pipeline.
        recoveryInvocationSource?: 'daemon_report' | 'scheduler_retry';
        classification: ConnectedServiceRuntimeFailureClassification;
        sourceAuthorization?: RuntimeAuthFailureSourceAuthorization;
    }>): Promise<unknown> => {
        const runtimeFailureAtMs = Date.now();
        const interruptedOriginId = resolveConnectedServiceContinuationOriginId({
            source: input.recoveryInvocationSource === 'scheduler_retry' ? 'scheduler_retry' : 'daemon_report',
            activeTurnId: Array.from(params.pidToTrackedSession.values())
                .find((tracked) => tracked.happySessionId === input.sessionId)
                ?.activeTurnId,
            reportId: input.interruptedOriginId,
        });
        const authorizedTracked = input.sourceAuthorization?.status === 'authorized'
            ? input.sourceAuthorization.tracked
            : null;
        const trackedRecoverySession = authorizedTracked
            ?? findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), input.sessionId);
        const authorizedInactive = input.sourceAuthorization?.status === 'authorized'
            ? input.sourceAuthorization.inactive
            : null;
        const inactiveRecoverySession = trackedRecoverySession
            ? null
            : authorizedInactive ?? await resolveInactiveConnectedServiceSessionContext({
                token: params.credentials.token,
                credentials: params.credentials,
                sessionId: input.sessionId,
            });
        const switchCoordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
            api: params.api,
            runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
            accountUsageStore: providerAccountUsageStore,
            leases: connectedServiceAuthGroupSwitchLeases,
            quotaFreshnessMs: resolvePositiveIntEnv(
                params.processEnv.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_QUOTA_FRESHNESS_MS,
                5 * 60_000,
                { min: 1_000, max: 60 * 60_000 },
            ),
            nowMs: () => Date.now(),
            probeQuotaSnapshotsForGroup: async (groupInput) => {
                await params.getConnectedServiceQuotasCoordinator()?.probeGroupQuotaSnapshots(groupInput);
            },
            // K2: reactive runtime-auth failure routes through the shared FSM apply builder
            // (hot-apply-in-place when eligible, else gated restart-resume + mid-turn
            // re-continue). Same builder the proactive quota coordinator uses.
            restartSession: buildConnectedServiceAuthGroupRestartSession({
                sessionId: input.sessionId,
                interruptedSessionId: input.sessionId,
                interruptedOriginId,
                restartReason: input.classification?.kind ?? null,
                commitAccountSwitchEvents: true,
            }),
            preflightConnectedServiceAuthGeneration: buildConnectedServiceAuthGroupRestartSession({
                sessionId: input.sessionId,
                interruptedSessionId: input.sessionId,
                interruptedOriginId,
                restartReason: input.classification?.kind ?? null,
                commitAccountSwitchEvents: false,
                dryRun: true,
            }),
        });
        const runtimeAuthCapabilityAgentId = input.sourceAuthorization?.status === 'authorized'
            ? input.sourceAuthorization.tracked
                ? resolveTrackedSessionCatalogAgentId(input.sourceAuthorization.tracked)
                : input.sourceAuthorization.inactive?.agentId
            : trackedRecoverySession
                ? resolveTrackedSessionCatalogAgentId(trackedRecoverySession)
                : inactiveRecoverySession?.agentId;
        const runtimeAuthApplyCapability = await resolveRuntimeAuthApplyCapabilityForInput({
            sessionId: input.sessionId,
            ...(runtimeAuthCapabilityAgentId ? { agentId: runtimeAuthCapabilityAgentId } : {}),
        });
        const result = await handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: () => Array.from(params.pidToTrackedSession.values()),
            resolveInactiveSession: async ({ sessionId }) => {
                if (sessionId === input.sessionId && inactiveRecoverySession) {
                    return inactiveRecoverySession;
                }
                return await resolveInactiveConnectedServiceSessionContext({
                    token: params.credentials.token,
                    credentials: params.credentials,
                    sessionId,
                });
            },
            resolveRegisteredRuntimeAuthFailureSource: resolveRegisteredRuntimeAuthFailureSourceForSession,
            resolveCurrentRuntimeAuthFailureSource: resolveCurrentRuntimeAuthFailureSourceForSession,
            switchCoordinator,
            switchAttemptTracker: connectedServiceRuntimeAuthSwitchAttempts,
            switchCore: connectedServiceSessionAuthSwitchCore,
            temporaryThrottleRecovery,
            emitSessionEvent: (sessionId, event) => {
                commitConnectedServiceAccountSwitchSessionEventWithNotification({
                    sessionId,
                    event,
                    logContext: 'runtime-auth',
                });
            },
            sessionId: input.sessionId,
            switchesThisTurn: input.switchesThisTurn,
            ...(input.recoveryInvocationSource ? { recoveryInvocationSource: input.recoveryInvocationSource } : {}),
            classification: input.classification,
            ...(input.sourceAuthorization ? { sourceAuthorization: input.sourceAuthorization } : {}),
            runtimeAuthApplyCapability,
            refreshConnectedServiceCredentialForRuntimeAuthFailure: async (refreshInput) => {
                const refreshCoordinator = params.getConnectedServiceRefreshCoordinator();
                if (!refreshCoordinator) {
                    return {
                        status: 'credential_missing' as const,
                        credential: null,
                        diagnostic: {
                            serviceId: refreshInput.serviceId,
                            profileId: refreshInput.profileId,
                            reason: 'runtime_auth_failure' as const,
                            status: 'credential_missing' as const,
                            expiresAt: null,
                            expiryAgeMs: null,
                            refreshWindowMs: 0,
                        },
                    };
                }
                return await refreshCoordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure(refreshInput);
            },
            continueAfterRuntimeAuthSwitch: createConnectedServiceContinuationHandler({
                credentials: params.credentials,
                interruptedOriginId,
                resumePromptMode: await resolveContinuationResumePromptMode({
                    serviceId: ConnectedServiceIdSchema.parse(input.classification.serviceId),
                    groupId: input.classification.groupId,
                    explicit: input.resumePromptMode,
                    loadGroupPolicy: input.classification.groupId
                        ? async () => (await params.api.getConnectedServiceAuthGroup({
                            serviceId: ConnectedServiceIdSchema.parse(input.classification.serviceId),
                            groupId: input.classification.groupId!,
                        }))?.policy ?? null
                        : undefined,
                }),
                customResumePrompt: readContinuationCustomResumePrompt(getActiveAccountSettingsSnapshot()?.settings ?? null),
                recoveryKind: input.classification.kind,
                resolveInterruption: ({ sessionId, action, switchReason }) =>
                    resolveConnectedServiceContinuationInterruptionForSwitch({
                        sessionId,
                        interruptedSessionId: input.sessionId,
                        action,
                        switchReason,
                        failureDriven: true,
                        turnDeferralQueue: connectedServiceTurnDeferralQueue,
                    }),
            }),
        });
        if (
            result
            && typeof result === 'object'
            && 'status' in result
            && result.status === 'recovery_superseded'
            && 'reason' in result
            && (result.reason === 'source_tuple_unavailable' || result.reason === 'source_tuple_mismatch')
        ) return result;
        if (
            input.recoveryInvocationSource !== 'scheduler_retry'
            && input.classification.kind === 'usage_limit'
            && input.classification.groupId
            && input.classification.profileId
        ) {
            const serviceId = ConnectedServiceIdSchema.safeParse(input.classification.serviceId);
            const quotaCoordinator = params.getConnectedServiceQuotasCoordinator();
            if (serviceId.success && quotaCoordinator) {
                const committedGeneration = resolveCommittedGenerationFromRuntimeAuthRecovery({
                    serviceId: serviceId.data,
                    groupId: input.classification.groupId,
                    recovery: result,
                });
                try {
                    await quotaCoordinator.recordRuntimeUsageLimitExhaustionAndFanout({
                        sourceSessionId: input.sessionId,
                        serviceId: serviceId.data,
                        groupId: input.classification.groupId,
                        exhaustedProfileId: input.classification.profileId,
                        sourceProviderAccountId: input.classification.sourceProviderAccountId ?? null,
                        sourceAccountLabel: input.classification.sourceAccountLabel ?? null,
                        sourceGroupGeneration: input.classification.groupGeneration ?? null,
                        resetAtMs: input.classification.resetsAtMs,
                        ...(committedGeneration ?? {}),
                    });
                } catch (error) {
                    logger.debug('[DAEMON RUN] Failed to fan out connected-service runtime usage-limit exhaustion (non-fatal)', error);
                }
            }
        }
        logger.debug('[DAEMON RUN] Connected-service reactive runtime-auth switch attempt', buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
            sessionId: input.sessionId,
            classification: input.classification,
            result,
            routedThroughFsm: true,
            startedAtMs: runtimeFailureAtMs,
            finishedAtMs: Date.now(),
        }));
        return result;
    };
    const deliverRuntimeAuthRecoveryVisibleEvent = async (delivery: Readonly<{
        sessionId: string;
        attemptId: string;
        transition: string;
        transcriptEvent: unknown;
    }>): Promise<void> => {
        await commitRuntimeAuthRecoveryVisibleEventDelivery({
            credentials: params.credentials,
            delivery,
        });
    };
    const runtimeAuthRecoveryScheduler = createRuntimeAuthRecoverySchedulerForDaemon({
        activeServerDir: configuration.activeServerDir,
        nowMs: () => Date.now(),
        maxAttempts: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_MAX_ATTEMPTS,
            3,
            { min: 1, max: 100 },
        ),
        baseBackoffMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_BASE_DELAY_MS,
            1_000,
            { min: 1, max: 24 * 60 * 60_000 },
        ),
        maxBackoffMs: resolvePositiveIntEnv(
            params.processEnv.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_MAX_DELAY_MS,
            60_000,
            { min: 1, max: 24 * 60 * 60_000 },
        ),
        providerOutcomePendingWaitMs: connectedServiceContinuationProviderActivityTimeoutMs,
        jitterMs: () => Math.floor(Math.random() * runtimeAuthRecoveryJitterMaxMs),
        recover: runConnectedServiceRuntimeAuthFailureRecovery,
        gate: () => {
            const nowMs = Date.now();
            pruneRuntimeAuthRecoveryStormEvents(nowMs);
            if (runtimeAuthRecoveryStormEvents.length < runtimeAuthRecoveryStormThreshold) {
                return { status: 'open' as const };
            }
            return {
                status: 'delayed' as const,
                retryAtMs: nowMs + runtimeAuthRecoveryStormDelayMs + Math.floor(Math.random() * runtimeAuthRecoveryJitterMaxMs),
                reason: 'local_server_storm',
            };
        },
        recordDiagnostic: recordRuntimeAuthRecoveryDiagnostic,
    });
    runtimeAuthRecoveryScheduler.schedulePendingVisibleEventDrain({
        deliver: deliverRuntimeAuthRecoveryVisibleEvent,
        onError: (error) => {
            logger.debug('[DAEMON RUN] Failed to commit hydrated connected-service runtime-auth recovery session event (non-fatal)', {
                error: serializeAxiosErrorForLog(error),
            });
        },
    });
    connectedServicePredictiveSwitchGuard = createConnectedServicePredictiveSwitchGuard({
        readTurnState: (sessionId) => connectedServiceTurnDeferralQueue.getTurnLifecycleState(sessionId),
        resolvePredictiveSoftSwitchMode: async (input) =>
            await resolvePredictiveSoftSwitchModeForInput(input),
        runtimeAuthApplyCapabilityResolver: async (input) =>
            await resolveRuntimeAuthApplyCapabilityForInput(input),
    });
    // Single async server-features fetch source shared by the local-services inventory gate and
    // the browser daemon feature gate (OWNER-GATE). One fetch source, two consumers — no second
    // fetch is introduced. The gates own caching the resolved snapshot.
    const resolveServerFeaturesSnapshot = params.resolveServerFeaturesSnapshot
        ?? (async () => fetchServerFeaturesSnapshot({
            serverUrl: configuration.serverUrl,
            timeoutMs: 1_500,
        }));
    const managedLocalServicesExec = createPluginExecService();
    const localServicesRuntime = createLocalServicesDaemonRuntime({
        machineId: params.machineId,
        processEnv: params.processEnv,
        // `localServices.inventory` is server-represented (default-allow): the inventory scan
        // respects the server decision. Supply the daemon's server-features snapshot so a server
        // that disables the product stops the daemon scanning (mirrors the quotas daemon gate).
        // The runtime refreshes + caches this on each inventory tick; a failed/missing snapshot
        // keeps the gate fail-closed.
        resolveServerFeaturesSnapshot,
        pageTitleEnricher: createLocalPageTitleEnricher({
            timeoutMs: DEFAULT_LOCAL_SERVICE_PAGE_TITLE_TIMEOUT_MS,
            maxBodyBytes: DEFAULT_LOCAL_SERVICE_PAGE_TITLE_MAX_BODY_BYTES,
            concurrency: DEFAULT_LOCAL_SERVICE_PAGE_TITLE_CONCURRENCY,
            successTtlMs: DEFAULT_LOCAL_SERVICE_PAGE_TITLE_SUCCESS_TTL_MS,
            failureTtlMs: DEFAULT_LOCAL_SERVICE_PAGE_TITLE_FAILURE_TTL_MS,
            fetch: globalThis.fetch,
        }),
        hostedWebStaticAssets: {
            verifyArtifact: verifyHostedWebStaticAssetArtifact,
        },
        // A.16x.8 flip: supply the canonical binary-safe managed exec service so plugin-contributed
        // hosted-web surfaces backed by a managed dev server actually spawn (assignAndInject /
        // detectAfterLaunch) instead of degrading to the `managed_service_unavailable` fallback.
        // The daemon abort signal stops launches once the control runtime tears down. Preview-URL
        // minting has no daemon owner today, so the managed preview is surfaced through the existing
        // local-service preview routes (no `registerPreviewEndpoint` hook is invented here).
        managedLocalServices: {
            exec: managedLocalServicesExec,
            signal: shutdownCancellationDomains.managedLocalServicesProcessSignal,
        },
    });
    params.onProviderManagedLocalServicesOwnerReady?.({
        dispatch: createProviderManagedLocalServicesDispatch({
            startTrusted: localServicesRuntime.trustedManagedLocalServices.start,
            processEnv: params.processEnv,
            signal: shutdownCancellationDomains.managedLocalServicesProcessSignal,
        }),
        getManagedSnapshot: localServicesRuntime.managedRoutes.getSnapshot,
        managedCatalogRuntime: createProviderManagedCatalogRuntimePort({
            materializationBaseDir: join(
                configuration.happyHomeDir,
                'providers',
                'managed',
                'catalog',
            ),
            resolveManagedLocalServicesEnabled: async () => {
                const serverSnapshot = await resolveServerFeaturesSnapshot();
                return resolveCliFeatureDecision({
                    featureId: 'localServices.managed',
                    env: params.processEnv,
                    ...(serverSnapshot ? { serverSnapshot } : {}),
                }).state === 'enabled';
            },
            localServices: localServicesRuntime.trustedManagedLocalServices,
            exec: managedLocalServicesExec,
        }),
    });
    const startupManagedProviderRecoveryCandidates =
        params.startupManagedProviderRecoveryCandidates ?? [];
    const recoverStartupManagedProviderCandidates = async (
        requestAuthHttpPort: number,
    ): Promise<void> => {
        const recoverySignal =
            shutdownCancellationDomains.daemonWorkSignal;
        const settingsReady =
            await warmActiveAccountSettingsSnapshotBestEffort({
                credentials: params.credentials,
                logger,
            });
        if (!settingsReady || recoverySignal.aborted) {
            logger.debug(
                '[DAEMON RUN] Managed Provider startup recovery left request-auth unavailable',
                {
                    candidateCount:
                        startupManagedProviderRecoveryCandidates.length,
                    reason: recoverySignal.aborted
                        ? 'daemon_shutdown'
                        : 'account_settings_unavailable',
                },
            );
            return;
        }
        try {
            await fetchConnectedServiceProjectionSnapshot(recoverySignal);
        } catch {
            logger.debug(
                '[DAEMON RUN] Managed Provider startup recovery left request-auth unavailable',
                {
                    candidateCount:
                        startupManagedProviderRecoveryCandidates.length,
                    reason: recoverySignal.aborted
                        ? 'daemon_shutdown'
                        : 'connected_service_projection_unavailable',
                },
            );
            return;
        }
        if (recoverySignal.aborted) return;
        let providersEnabled = false;
        let managedLocalServicesEnabled = false;
        try {
            const serverSnapshot = await resolveServerFeaturesSnapshot();
            providersEnabled = resolveCliFeatureDecision({
                featureId: 'providers',
                env: params.processEnv,
                ...(serverSnapshot ? { serverSnapshot } : {}),
            }).state === 'enabled';
            managedLocalServicesEnabled = resolveCliFeatureDecision({
                featureId: 'localServices.managed',
                env: params.processEnv,
                ...(serverSnapshot ? { serverSnapshot } : {}),
            }).state === 'enabled';
        } catch {
            providersEnabled = false;
            managedLocalServicesEnabled = false;
        }
        if (recoverySignal.aborted) return;
        await Promise.all(startupManagedProviderRecoveryCandidates.map(
            async (candidate) => {
                if (recoverySignal.aborted) return;
                const tracked = params.pidToTrackedSession.get(candidate.pid);
                const options = tracked?.spawnOptions;
                const selection = options?.modelSelection;
                const previousBinding = options?.providerBindingMetadataV1 ?? null;
                const backendTarget = options?.backendTarget;
                const agentId = resolveTrackedSessionCatalogAgentId(tracked);
                const failClosedWithoutRecovery = async (
                    reason: string,
                ): Promise<void> => {
                    logger.debug(
                        '[DAEMON RUN] Managed Provider startup recovery left request-auth unavailable',
                        {
                            sessionId: candidate.sessionId,
                            reason,
                        },
                    );
                };
                if (
                    !providersEnabled
                    || !managedLocalServicesEnabled
                    || !tracked
                    || !selection
                    || selection.ref.providerConnectionId === null
                    || !previousBinding
                    || !backendTarget
                    || !agentId
                ) {
                    await failClosedWithoutRecovery(
                        'managed_provider_recovery_prerequisites_unavailable',
                    );
                    return;
                }

                let runtimeLease: Awaited<ReturnType<
                    typeof acquireAuthoritativePluginRuntimeRegistryLease
                >> | null = null;
                let cleanupRequested = false;
                let runtimeLeaseReleased = false;
                let attemptForCleanup:
                    | Extract<
                        Awaited<ReturnType<typeof prepareProviderLaunch>>,
                        { ok: true; kind: 'provider' }
                    >['attempt']
                    | null = null;
                const cleanupAuthorization = async (): Promise<void> => {
                    cleanupRequested = true;
                    attemptForCleanup?.cleanupOnFailure();
                    const lease = runtimeLease;
                    if (!lease || runtimeLeaseReleased) return;
                    runtimeLeaseReleased = true;
                    await lease.release().catch(() => undefined);
                };
                const abortRecovery = (): void => {
                    void cleanupAuthorization();
                };
                recoverySignal.addEventListener(
                    'abort',
                    abortRecovery,
                    { once: true },
                );
                try {
                    if (recoverySignal.aborted) {
                        await cleanupAuthorization();
                        return;
                    }
                    const prepared = await prepareProviderLaunch({
                        selection,
                        backendTarget,
                        machineId: params.machineId,
                        agentId,
                        sessionId: candidate.sessionId,
                        previousBinding,
                        // Startup is passive: a security change cannot prompt.
                        confirmation: null,
                        connectedServices: null,
                        featureEnabled: true,
                        resolvePrerequisites: async () => ({ ok: true }),
                        createAuthorizationAttempt: async (context) => {
                            runtimeLease =
                                await acquireAuthoritativePluginRuntimeRegistryLease({
                                    happyHomeDir: configuration.happyHomeDir,
                                });
                            if (
                                cleanupRequested
                                || recoverySignal.aborted
                            ) {
                                await cleanupAuthorization();
                                throw new Error('daemon_shutdown');
                            }
                            return await createRuntimeProviderSpawnAuthorizationAttempt({
                                selection: context.selection,
                                machineId: context.machineId,
                                agentTargetKey: context.agentTargetKey,
                                agentId: context.agentId,
                                lease: runtimeLease,
                                getAccountSettingsSnapshot:
                                    getActiveAccountSettingsSnapshot,
                                subscribeAccountSettingsSnapshot: (listener) =>
                                    subscribeActiveAccountSettingsSnapshot(
                                        () => listener(),
                                    ),
                                runtimeStateStore:
                                    createProviderRuntimeStateStore({
                                        happyHomeDir:
                                            configuration.happyHomeDir,
                                        machineId: context.machineId,
                                    }),
                                materializationBaseDir: join(
                                    configuration.happyHomeDir,
                                    'providers',
                                    'materialized',
                                ),
                                sessionId: candidate.sessionId,
                                ...(params.resolveManagedPurposeBindingIntent
                                    ? {
                                        resolveManagedPurposeBindingIntent:
                                            params.resolveManagedPurposeBindingIntent,
                                    }
                                    : {}),
                                ...(context.managedPurposeBindingSnapshot
                                    ? {
                                        managedPurposeBindingSnapshot:
                                            context.managedPurposeBindingSnapshot,
                                    }
                                    : {}),
                            });
                        },
                    });
                    if (prepared.ok && prepared.kind === 'provider') {
                        attemptForCleanup = prepared.attempt;
                    }
                    if (cleanupRequested || recoverySignal.aborted) {
                        await cleanupAuthorization();
                        return;
                    }
                    if (
                        !prepared.ok
                        || prepared.kind !== 'provider'
                        || !(
                            'materializeManagedEndpoint'
                            in prepared.attempt
                        )
                    ) {
                        await cleanupAuthorization();
                        await failClosedWithoutRecovery(
                            'managed_provider_authorization_reconstruction_failed',
                        );
                        return;
                    }
                    const recovery = await recoverManagedProviderEndpoint({
                        sessionId: candidate.sessionId,
                        attachment: candidate.attachment,
                        attempt: prepared.attempt,
                        requestAuthHttpPort,
                        processEnv: params.processEnv,
                        localServices:
                            localServicesRuntime.trustedManagedLocalServices,
                        requestAuthRegistry:
                            connectedAccountRequestAuthRegistry,
                        validateRequestAuth:
                            connectedAccountRequestAuthService.validateRequestAuth,
                        clearMarkerAttachment: async () => {
                            await clearSessionMarkerManagedLocalServiceRunAttachment({
                                pid: candidate.pid,
                                ownership: candidate.markerOwnership,
                                attachment: candidate.attachment,
                            });
                        },
                        cleanupMaterialization: async () => {
                            await rm(
                                candidate.attachment.materialization.rootDir,
                                { recursive: true, force: true },
                            );
                        },
                        cleanupAuthorization,
                    });
                    if (!recovery.ok) {
                        logger.debug(
                            '[DAEMON RUN] Managed Provider startup recovery left request-auth unavailable',
                            {
                                sessionId: candidate.sessionId,
                                reason: recovery.code,
                                detail: recovery.detail,
                            },
                        );
                    }
                } catch (error) {
                    await cleanupAuthorization();
                    await failClosedWithoutRecovery(
                        error instanceof Error
                            ? error.message
                            : 'managed_provider_recovery_failed',
                    );
                } finally {
                    recoverySignal.removeEventListener(
                        'abort',
                        abortRecovery,
                    );
                }
            },
        ));
    };
    const resolveTrackedHostedWebStaticAssetSessionIds = (): readonly string[] => Object.freeze([
        ...new Set([...params.pidToTrackedSession.values()]
            .map((tracked) => normalizeOptionalString(tracked.happySessionId))
            .filter((sessionId) => sessionId.length > 0 && !/^PID-\d+$/u.test(sessionId))),
    ]);
    const syncHostedWebStaticAssetsForTrackedSessions = async (
        reason: HostedWebStaticAssetSyncReason,
    ): Promise<void> => {
        const sessionIds = resolveTrackedHostedWebStaticAssetSessionIds();
        if (sessionIds.length === 0) {
            await localServicesRuntime.syncHostedWebStaticAssets([]);
            return;
        }

        let runtimeRegistryLease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>> | null = null;
        try {
            let sourceRegistry: ResolvedContributionRegistry;
            if (params.resolveHostedWebStaticAssetContributionRegistry) {
                sourceRegistry = await params.resolveHostedWebStaticAssetContributionRegistry();
            } else {
                runtimeRegistryLease = await acquireAuthoritativePluginRuntimeRegistryLease({
                    happyHomeDir: configuration.happyHomeDir,
                });
                sourceRegistry = runtimeRegistryLease.registry.contributes;
            }
            const sourceResults = await Promise.all(sessionIds.map(async (sessionId) =>
                await resolveHostedWebStaticAssetLifecycleSource({
                    registry: sourceRegistry,
                    sessionId,
                    machineId: params.machineId,
                }),
            ));
            const sourceDiagnostics = sourceResults.flatMap((result) => result.diagnostics);
            if (sourceDiagnostics.length > 0) {
                logger.debug('[DAEMON RUN] Hosted-web static asset source returned diagnostics', {
                    reason,
                    diagnostics: sourceDiagnostics,
                });
            }

            const result = await localServicesRuntime.syncHostedWebStaticAssets(
                sourceResults.flatMap((sourceResult) => sourceResult.contributions),
            );
            if (result.diagnostics.length > 0) {
                logger.debug('[DAEMON RUN] Hosted-web static asset sync returned diagnostics', {
                    reason,
                    diagnostics: result.diagnostics,
                });
            }
        } catch (error) {
            logger.debug('[DAEMON RUN] Hosted-web static asset sync failed; clearing active hosted-web previews', error);
            await localServicesRuntime.syncHostedWebStaticAssets([]).catch((clearError) => {
                logger.debug('[DAEMON RUN] Failed to clear hosted-web static assets after sync failure', clearError);
            });
        } finally {
            if (runtimeRegistryLease) {
                await runtimeRegistryLease.release().catch((error: unknown) => {
                    logger.debug('[DAEMON RUN] Failed to release plugin runtime registry lease after hosted-web static asset sync', error);
                });
            }
        }
    };
    let hostedWebStaticAssetSyncPromise: Promise<void> = Promise.resolve();
    queueHostedWebStaticAssetSync = (reason) => {
        const previous = hostedWebStaticAssetSyncPromise;
        hostedWebStaticAssetSyncPromise = previous
            .catch(() => undefined)
            .then(async () => {
                await syncHostedWebStaticAssetsForTrackedSessions(reason);
            });
        return hostedWebStaticAssetSyncPromise;
    };
    void queueHostedWebStaticAssetSync('startup');
    const androidScrcpyTunnelOwner = createAndroidScrcpyTunnelOwner();
    // iOS capture-availability gate (capability-truth): trust is derived ONLY from a daemon-side
    // signature/notarization + digest verification of the vendored helper artifact. Until the
    // signed/notarized helper is produced and pinned (see scripts/buildIosSimulatorHelper.mjs +
    // PINNED_IOS_SIMULATOR_HELPER_ARTIFACT), this resolves to false and iOS stays fail-closed.
    const verifyIosHelperSignature = (path: string) => verifyIosSimulatorHelperSignature({ path });
    // Resolve the pinned vendored helper through the full digest + Developer ID signature +
    // notarization verification chain ONCE. The same verified resolution drives both the
    // capture-availability gate and the helper-session owner's process path, so a verified
    // resource always has a real producer + input sender behind it (capability-truth). While the
    // placeholder digest is pinned (no signed/notarized artifact produced yet), this fails closed.
    const iosSimulatorHelperArtifact = await resolvePinnedIosSimulatorHelperArtifact({
        verifyHelperSignature: verifyIosHelperSignature,
    });
    const iosSimulatorCaptureAdapterAvailable = await resolveIosSimulatorCaptureAdapterAvailability({
        resolveHelperArtifact: async () => iosSimulatorHelperArtifact,
    });
    // Single long-lived `--daemon-json` helper-session owner: the iOS analog of the Android scrcpy
    // server handle. It owns the piped child process and is BOTH the frame-stream producer
    // (openStream) AND the input command sender (sendCommand). Constructed only when the artifact
    // verified, so capture/input are never silently no-ops behind an unverified binary.
    const iosSimulatorHelperSession = iosSimulatorHelperArtifact.ok
        ? createIosSimulatorHelperSession({ helperPath: iosSimulatorHelperArtifact.path })
        : null;
    const openIosSimulatorHelperStream: IosSimulatorHelperFrameStreamOpener | null =
        iosSimulatorHelperSession ? iosSimulatorHelperSession.openStream : null;
    const sendIosSimulatorInputCommand: IosSimulatorInputCommandSender | null =
        iosSimulatorHelperSession ? iosSimulatorHelperSession.sendCommand : null;
    const simulatorPreviewAdapter = createComposedSimulatorPreviewAdapter({
        platforms: [
            createIosSimulatorPlatformAdapter({
                captureAdapterAvailable: iosSimulatorCaptureAdapterAvailable,
                discoverResources: createDefaultIosSimulatorResourcesDiscovery({
                    captureAdapterAvailable: iosSimulatorCaptureAdapterAvailable,
                    verifyHelperSignature: verifyIosHelperSignature,
                }),
                ...(sendIosSimulatorInputCommand
                    ? { sendInputCommand: sendIosSimulatorInputCommand }
                    : {}),
            }),
            createAndroidSimulatorPlatformAdapter({
                discoverResources: createDefaultAndroidSimulatorResourcesDiscovery(),
                resolveScrcpyControl: ({ serial }) => androidScrcpyTunnelOwner.getControl({ serial }),
                stopScrcpyControl: () => androidScrcpyTunnelOwner.stop(),
            }),
        ],
    });
    // PATCH-01 / A1: the bridge from the simulator encoder-control RPC entry point to the live
    // capture session's `applySidebandControl` sink. `wrapCaptureAdapter` records each started
    // session's sideband sink (keyed by the relay streamId) so `dispatchStreamControl` forwards a
    // `simulator.quality.set` / `simulator.keyframe.request` RPC into the SAME session the relay
    // terminator drives — not a parallel control path.
    const simulatorStreamControlBridge = createSimulatorStreamControlBridge();
    const simulatorPreviewRuntime = createSimulatorPreviewDaemonRuntime({
        machineId: params.machineId,
        adapter: simulatorPreviewAdapter,
        dispatchStreamControl: simulatorStreamControlBridge.dispatch,
        ...(params.simulatorInputLeaseManager
            ? { leaseManager: params.simulatorInputLeaseManager }
            : {}),
        ...(params.liveStreamCaptureRegistry
            ? {
                captureReconciler: createSimulatorCaptureRegistryReconciler({
                    registry: params.liveStreamCaptureRegistry,
                    createAdapter: (resource) => simulatorStreamControlBridge.wrapCaptureAdapter(createSimulatorCaptureAdapterForResource(resource, {
                        android: {
                            // Encoder-control (set_quality / request_keyframe / snapshot) + adaptive
                            // bitrate are backed by the server-restart producer: scrcpy runs
                            // raw_stream=true so encoder params are fixed at launch and only change
                            // via a clean server restart through the tunnel owner (which keeps the
                            // shared input control sender in sync).
                            ensureServer: androidScrcpyTunnelOwner.ensureServer,
                            restartServer: androidScrcpyTunnelOwner.restartServer,
                            adaptiveBitrate: true,
                        },
                        // iOS MJPEG frame producer. openStream is supplied ONLY when the signed
                        // helper artifact verified (capability-truth: a verified resource always
                        // has a real producer behind it). While unverified, openStream is omitted
                        // and the iOS branch returns the typed-unavailable capture adapter.
                        ios: {
                            ...(openIosSimulatorHelperStream
                                ? { openStream: openIosSimulatorHelperStream }
                                : {}),
                        },
                    })),
                }),
            }
            : {}),
    });
    const runtimeActionRouteProviderTarget = params.api as Readonly<{
        setBrowserDaemonControlRoutesProvider?: (provider: (() => BrowserDaemonControlRoutes | null) | null) => void;
        setBrowserDaemonContextRoutesProvider?: (provider: (() => BrowserContextRoutes | null) | null) => void;
        setBrowserDaemonAutomationRoutesProvider?: (provider: (() => BrowserAutomationRoutes | null) | null) => void;
        setBrowserDiagnosticsActionRoutesProvider?: (provider: (() => BrowserDiagnosticsActionRoutes | null) | null) => void;
        setBrowserRecordingRoutesProvider?: (provider: (() => BrowserRecordingRoutes | null) | null) => void;
        setLocalServicesRuntimeActionRoutesProvider?: (provider: (() => LocalServicesRuntimeActionRoutes | null) | null) => void;
        setSimulatorPreviewRoutesProvider?: (provider: (() => SimulatorPreviewRoutes | null) | null) => void;
    }>;
    // OWNER-GATE: one daemon-boundary browser feature gate. The first startup pass keeps the daemon
    // fail-closed when the server feature snapshot is unavailable; the returned
    // refreshBrowserRouteOwners() method re-runs the SAME gate/producer construction after the
    // central server-features store recovers (for example after machine-registration retry).
    const browserDaemonFeatureGate = params.browserDaemonFeatureGate
        ?? createBrowserDaemonFeatureGate({
            env: params.processEnv,
            resolveServerFeaturesSnapshot,
            onError: (error) => {
                logger.debug('[DAEMON RUN] Browser daemon feature gate refresh failed (non-fatal)', error);
            },
        });
    const browserContextDiagnosticsRingBuffer: BrowserContextDiagnosticsRingBuffer =
        createBrowserContextDiagnosticsRingBuffer();
    const browserDiagnosticsStore = createBrowserDiagnosticsDaemonStore({ machineId: params.machineId });
    // Tap the diagnostics publish + lifecycle path into the context ring buffer without mutating the
    // store: the wrapper re-exposes the full store contract and forwards every method. Only accepted,
    // schema-valid events feed the ring (it inherits the store's redaction + validation), and the
    // bridge's view-close / session-close clears prune the ring in lockstep with the store so closed
    // or purged diagnostics never linger in daemon memory.
    const browserDiagnosticsStoreTapped = tapBrowserDiagnosticsStoreIntoRingBuffer({
        store: browserDiagnosticsStore,
        ringBuffer: browserContextDiagnosticsRingBuffer,
    });
    let browserDiagnosticsRoutes: BrowserDiagnosticsRoutes | null = null;
    // DEV-5 / DIAG-INTERACTION: the `browser.diagnostics.*` runtime-action route owner. snapshot/clear
    // are backed by the live daemon diagnostics store; the interactive verbs (pause/resume/eval/
    // getProperties/releaseObjectGroup/elementPicker) ride the live sidecar CDP interaction transport
    // when the managed-Chromium sidecar exposes one (constructed below, next to the offline-diagnostics
    // runtime, over the SAME live transport + view bindings). Absent ⇒ the interaction verbs stay
    // honestly fail-closed (`browser_diagnostics_route_unavailable`, never a fake success). The route
    // owner is assembled AFTER the sidecar block so it can carry the interaction transport.
    let browserDiagnosticsInteractionTransport: BrowserDiagnosticsInteractionTransport | null = null;
    let browserDiagnosticsActionRoutes: BrowserDiagnosticsActionRoutes | null = null;
    let browserDiagnosticsActionRoutesHasInteraction = false;
    const browserControlBroker = createBrowserDaemonControlBroker();
    let unregisterBrowserSidecarControlAdapter: (() => void) | null = null;
    let disposeBrowserSidecarControlAdapter: (() => void | Promise<void>) | null = null;
    let disposeBrowserSidecarDiagnosticsRuntime: (() => void) | null = null;
    let browserControlRoutes: BrowserDaemonControlRoutes | null = null;
    let browserContextRoutes: BrowserContextRoutes | null = null;
    let browserAutomationRoutes: BrowserAutomationRoutes | null = null;
    let disposeBrowserAutomationService: (() => void) | null = null;
    let browserRecordingRuntime: BrowserRecordingDaemonRuntime | null = null;
    let browserSidecarContextCaptureForRecording: BrowserSidecarContextCaptureSurface | null = null;
    let browserRecordingRuntimeHasCdpScreencast = false;
    let browserRecordingCdpScreencastAvailable = false;
    let browserControlRoutesPublished = false;
    let browserContextRoutesPublished = false;
    let browserAutomationRoutesPublished = false;
    let browserDiagnosticsRoutesPublished = false;
    let browserRecordingRoutesPublished = false;
    let refreshBrowserRouteOwnersInFlight: Promise<void> | null = null;
    let controlRuntimeResourcesDisposed = false;
    const publishBrowserRouteOwners = (): void => {
        if (browserControlRoutes && !browserControlRoutesPublished) {
            browserControlRoutesPublished = true;
            runtimeActionRouteProviderTarget.setBrowserDaemonControlRoutesProvider?.(() => browserControlRoutes);
            params.onBrowserControlRoutesReady?.(browserControlRoutes);
            params.getApiMachineForSessions()?.registerBrowserControlRoutes(browserControlRoutes);
        }
        if (browserContextRoutes && !browserContextRoutesPublished) {
            browserContextRoutesPublished = true;
            runtimeActionRouteProviderTarget.setBrowserDaemonContextRoutesProvider?.(() => browserContextRoutes);
            params.onBrowserContextRoutesReady?.(browserContextRoutes);
            params.getApiMachineForSessions()?.registerBrowserContextRoutes?.(browserContextRoutes);
        }
        if (browserAutomationRoutes && !browserAutomationRoutesPublished) {
            browserAutomationRoutesPublished = true;
            runtimeActionRouteProviderTarget.setBrowserDaemonAutomationRoutesProvider?.(() => browserAutomationRoutes);
            params.onBrowserAutomationRoutesReady?.(browserAutomationRoutes);
        }
        if (browserDiagnosticsRoutes && !browserDiagnosticsRoutesPublished) {
            browserDiagnosticsRoutesPublished = true;
            params.onBrowserDiagnosticsRoutesReady?.(browserDiagnosticsRoutes);
            params.getApiMachineForSessions()?.registerBrowserDiagnosticsRoutes(browserDiagnosticsRoutes);
        }
        if (browserDiagnosticsActionRoutes) {
            runtimeActionRouteProviderTarget.setBrowserDiagnosticsActionRoutesProvider?.(() => browserDiagnosticsActionRoutes);
        }
        if (browserRecordingRuntime && !browserRecordingRoutesPublished) {
            const browserRecordingRoutes = browserRecordingRuntime.routes;
            browserRecordingRoutesPublished = true;
            runtimeActionRouteProviderTarget.setBrowserRecordingRoutesProvider?.(() => browserRecordingRoutes);
            params.onBrowserRecordingRoutesReady?.(browserRecordingRoutes);
            params.getApiMachineForSessions()?.registerBrowserRecordingRoutes(browserRecordingRoutes);
        }
    };
    const refreshBrowserRouteOwners = async (): Promise<void> => {
        if (controlRuntimeResourcesDisposed) return;
        if (refreshBrowserRouteOwnersInFlight) return refreshBrowserRouteOwnersInFlight;
        refreshBrowserRouteOwnersInFlight = (async () => {
            await browserDaemonFeatureGate.refresh();
            if (controlRuntimeResourcesDisposed) return;
            const browserDiagnosticsEnabled = browserDaemonFeatureGate.isEnabled('browser.diagnostics');
            if (browserDiagnosticsEnabled && !browserDiagnosticsRoutes) {
                browserDiagnosticsRoutes = createBrowserDiagnosticsRoutes({ store: browserDiagnosticsStoreTapped });
            }
            if (
                browserDiagnosticsEnabled
                && (!browserDiagnosticsActionRoutes
                    || (browserDiagnosticsInteractionTransport && !browserDiagnosticsActionRoutesHasInteraction))
            ) {
                browserDiagnosticsActionRoutes = createBrowserDiagnosticsActionRoutes({
                    store: browserDiagnosticsStoreTapped,
                    ...(browserDiagnosticsInteractionTransport
                        ? { interaction: browserDiagnosticsInteractionTransport }
                        : {}),
                });
                browserDiagnosticsActionRoutesHasInteraction = Boolean(browserDiagnosticsInteractionTransport);
            }

            const browserSidecarEnabled = browserDaemonFeatureGate.isEnabled('browser.sidecar');
            const browserUseAllowed = params.resolveBrowserUseAllowed?.() === true;
            if (browserSidecarEnabled && browserUseAllowed && !unregisterBrowserSidecarControlAdapter) {
                const browserSidecarControlAdapterFactory = params.browserSidecarControlAdapterFactory
                    ?? createProductBrowserSidecarControlAdapterFactory({
                        featureEnabled: browserSidecarEnabled,
                        browserUseAllowed,
                    });
                const browserSidecarControlAdapterResult = await browserSidecarControlAdapterFactory({
                    machineId: params.machineId,
                });
                if (browserSidecarControlAdapterResult?.ok) {
                    unregisterBrowserSidecarControlAdapter = browserControlBroker.registerAdapter(
                        browserSidecarControlAdapterResult.adapter,
                    );
                    disposeBrowserSidecarControlAdapter = browserSidecarControlAdapterResult.dispose ?? null;
                    if (browserControlBroker.hasExecutableAdapters() && !browserControlRoutes) {
                        browserControlRoutes = createBrowserDaemonControlRoutes({ broker: browserControlBroker });
                    }
                    if (browserControlBroker.hasExecutableAdapters() && browserDaemonFeatureGate.isEnabled('browser.context') && !browserContextRoutes) {
                        const browserContextSource = params.browserContextSourceFactory
                            ? params.browserContextSourceFactory({ machineId: params.machineId })
                            : browserSidecarControlAdapterResult.contextCapture
                                ? createSidecarCdpBrowserContextSource({
                                    contextCapture: browserSidecarControlAdapterResult.contextCapture,
                                    workingDirectory: configuration.happyHomeDir,
                                    pathAllowanceRegistry: createTransferPathAllowanceRegistry(),
                                    diagnosticsRingBuffer: browserContextDiagnosticsRingBuffer,
                                })
                                : createUnavailableBrowserContextSource();
                        browserContextRoutes = createBrowserContextRoutes({
                            ownerAccountId: params.machineId,
                            source: browserContextSource,
                            // Single-owner daemon feature-gate is the only publish-time authority:
                            // the server can disable browser.context after this owner is constructed,
                            // so page/screenshot publish reads the live gate instead of a hardcoded allow.
                            resolveGate: () => ({
                                featureEnabled: browserDaemonFeatureGate.isEnabled('browser.context'),
                                policyAllowed: true,
                                runtimeAvailable: true,
                            }),
                        });
                    }
                    if (browserControlBroker.hasExecutableAdapters() && browserDaemonFeatureGate.isEnabled('browser.automation') && !browserAutomationRoutes) {
                        const browserSidecarContextCapture = browserSidecarControlAdapterResult.contextCapture;
                        const browserAutomationService = createBrowserAutomationDaemonService({
                            adapter: createBrowserAutomationCdpAdapter({
                                transport: createControlAdapterAutomationTransport({
                                    adapter: browserSidecarControlAdapterResult.adapter,
                                    ...(browserContextRoutes ? { browserContext: browserContextRoutes } : {}),
                                    ...(browserSidecarContextCapture
                                        ? { contextCapture: browserSidecarContextCapture }
                                        : {}),
                                }),
                            }),
                            ...(browserSidecarContextCapture?.subscribeViewLifecycle
                                ? { subscribeViewLifecycle: browserSidecarContextCapture.subscribeViewLifecycle }
                                : {}),
                        });
                        disposeBrowserAutomationService = () => browserAutomationService.dispose();
                        browserAutomationRoutes = createBrowserAutomationRoutes({ service: browserAutomationService });
                    }
                    const browserSidecarContextCapture = browserSidecarControlAdapterResult.contextCapture;
                    browserSidecarContextCaptureForRecording = browserSidecarContextCapture ?? null;
                    if (
                        browserDiagnosticsEnabled
                        && !disposeBrowserSidecarDiagnosticsRuntime
                        && browserSidecarContextCapture?.subscribeCdpEvents
                        && browserSidecarContextCapture.subscribeViewLifecycle
                    ) {
                        const subscribeCdpEvents = browserSidecarContextCapture.subscribeCdpEvents;
                        const subscribeViewLifecycle = browserSidecarContextCapture.subscribeViewLifecycle;
                        const diagnosticsRuntime = createSidecarCdpDiagnosticsRuntime({
                            ownerAccountId: params.machineId,
                            store: browserDiagnosticsStoreTapped,
                            contextCapture: {
                                transport: browserSidecarContextCapture.transport,
                                resolvePageHandle: (view) => browserSidecarContextCapture.resolvePageHandle(view),
                                subscribeCdpEvents,
                                subscribeViewLifecycle,
                            },
                            isEnabled: () => browserDaemonFeatureGate.isEnabled('browser.diagnostics'),
                            onError: (error) => {
                                logger.debug('[DAEMON RUN] Browser sidecar diagnostics runtime error (non-fatal)', error);
                            },
                        });
                        disposeBrowserSidecarDiagnosticsRuntime = () => diagnosticsRuntime.dispose();
                    }
                    if (
                        browserDiagnosticsEnabled
                        && !browserDiagnosticsInteractionTransport
                        && browserSidecarContextCapture?.transport
                        && browserSidecarContextCapture.subscribeViewLifecycle
                    ) {
                        const subscribeViewLifecycle = browserSidecarContextCapture.subscribeViewLifecycle;
                        const interactionContextCapture = browserSidecarContextCapture;
                        browserDiagnosticsInteractionTransport = createBrowserDiagnosticsInteractionTransport({
                            contextCapture: {
                                transport: interactionContextCapture.transport,
                                resolvePageHandle: (view) => interactionContextCapture.resolvePageHandle(view),
                                subscribeViewLifecycle,
                                ...(interactionContextCapture.subscribeCdpEvents
                                    ? { subscribeCdpEvents: interactionContextCapture.subscribeCdpEvents }
                                    : {}),
                            },
                            onError: (error) => {
                                logger.debug('[DAEMON RUN] Browser diagnostics interaction transport error (non-fatal)', error);
                            },
                        });
                        browserDiagnosticsActionRoutes = createBrowserDiagnosticsActionRoutes({
                            store: browserDiagnosticsStoreTapped,
                            interaction: browserDiagnosticsInteractionTransport,
                        });
                        browserDiagnosticsActionRoutesHasInteraction = true;
                    }
                } else if (browserSidecarControlAdapterResult && !browserSidecarControlAdapterResult.ok) {
                    logger.debug('[DAEMON RUN] Browser sidecar control adapter unavailable', {
                        errorCode: browserSidecarControlAdapterResult.errorCode,
                        disabledReason: browserSidecarControlAdapterResult.disabledReason,
                    });
                }
            }
            if (
                browserRecordingRuntime
                && browserSidecarContextCaptureForRecording?.subscribeCdpEvents
                && !browserRecordingRuntimeHasCdpScreencast
            ) {
                browserRecordingRuntime.stop();
                browserRecordingRuntime = null;
                browserRecordingRoutesPublished = false;
                runtimeActionRouteProviderTarget.setBrowserRecordingRoutesProvider?.(null);
                browserRecordingRuntimeHasCdpScreencast = false;
            }
            if (browserDaemonFeatureGate.isEnabled('browser.recording') && !browserRecordingRuntime) {
                const cdpScreencastTransport = browserSidecarContextCaptureForRecording?.subscribeCdpEvents
                    ? createBrowserRecordingCdpScreencastTransport({
                        contextCapture: browserSidecarContextCaptureForRecording,
                    })
                    : null;
                browserRecordingCdpScreencastAvailable = Boolean(cdpScreencastTransport);
                browserRecordingRuntime = createBrowserRecordingDaemonRuntime({
                    workingDirectory: configuration.happyHomeDir,
                    liveStreamCaptureRegistry: params.liveStreamCaptureRegistry,
                    streamFrameEncoderFactory: params.browserRecordingStreamFrameEncoderFactory,
                    ...(browserRecordingNativeViewCapture
                        ? { nativeViewCapture: browserRecordingNativeViewCapture }
                        : {}),
                    ...(cdpScreencastTransport
                        ? { cdpScreencast: { transport: cdpScreencastTransport } }
                        : {}),
                    resolveStartContext: resolveBrowserRecordingStartContext,
                    onRetentionCleanupError: (error) => {
                        logger.debug('[DAEMON RUN] Browser recording retention cleanup failed (non-fatal)', error);
                    },
                });
                browserRecordingRuntimeHasCdpScreencast = Boolean(cdpScreencastTransport);
            }
            publishBrowserRouteOwners();
        })().finally(() => {
            refreshBrowserRouteOwnersInFlight = null;
        });
        return refreshBrowserRouteOwnersInFlight;
    };
    // Recording start-context: explicit override wins (QA/tests); otherwise the production
    // resolver flips each recording capability ON only where the matching producer actually
    // exists: PMS stream-frame registry, desktop native-view capture, and/or managed-Chromium
    // CDP screencast. A producer never stands in as proof for a different capture profile.
    // Desktop daemon entrypoint wiring (BA-4 + W2C-BA-1): prefer a directly-injected producer
    // (tests/QA), then a directly-injected desktop invoke (tests/QA), else the canonical CROSS-PROCESS
    // reverse channel — the spawned cli daemon cannot `invokeTauri` the desktop Wry WebView directly
    // (separate OS process), so it asks the connected desktop UI to capture each reference-only frame
    // over the persistent machine socket (`RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME`). Transport
    // construction is not source truth: native-view capture is advertised only when an injected
    // handler-backed producer/invoke exists or the machine client can see the connected UI handler.
    const nativeViewCaptureInjected = params.browserRecordingNativeViewCapture !== undefined;
    const desktopNativeViewCaptureInvokeInjected =
        params.desktopBrowserRecordingNativeViewCaptureInvoke !== undefined;
    const hasDesktopBrowserRecordingNativeViewCaptureSourceTruth = (): boolean => {
        if (nativeViewCaptureInjected || desktopNativeViewCaptureInvokeInjected) return true;
        return params.getApiMachineForSessions()
            ?.hasConnectedClientRpcHandler(RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME) === true;
    };
    const desktopBrowserRecordingNativeViewCaptureInvoke: DesktopBrowserRecordingFrameCaptureInvoke =
        params.desktopBrowserRecordingNativeViewCaptureInvoke
        ?? createReverseDesktopBrowserRecordingNativeViewCaptureInvoke({
            callUi: createDesktopReverseBrowserRecordingCaptureUiCall({
                getMachineClient: () => params.getApiMachineForSessions() ?? null,
            }),
        });
    const browserRecordingNativeViewCapture = params.browserRecordingNativeViewCapture
        ?? {
            isPlatformCaptureSupported: hasDesktopBrowserRecordingNativeViewCaptureSourceTruth,
            captureCommand: createBrowserRecordingNativeViewCaptureCommand({
                transport: createDesktopBrowserRecordingNativeViewCaptureTransport({
                    invokeRecordingFrameCapture: desktopBrowserRecordingNativeViewCaptureInvoke,
                    workingDirectory: configuration.happyHomeDir,
                }),
            }),
        };
    const resolveBrowserRecordingStartContext = params.resolveBrowserRecordingStartContext
        ?? ((startInput) => resolveBrowserRecordingStartContextForProducers({
            hasLiveStreamCaptureRegistry: Boolean(params.liveStreamCaptureRegistry),
            hasNativeViewCapture: Boolean(
                browserRecordingNativeViewCapture?.isPlatformCaptureSupported(),
            ),
            hasCdpScreencast: browserRecordingCdpScreencastAvailable,
        })(startInput));
    // BRW-6 privacy: daemon-side owner of on-disk browser profile/partition purge. Subscribed
    // to the session-deleted signal (purges `session`-mode profiles + bound partitions) and the
    // logout transition (purges `ephemeral` profiles + partitions). Fail-closed: a failed disk
    // purge marks the profile `unusable` and emits an audit; it is never silently reused.
    const browserStoragePartitionOwner = createBrowserStoragePartitionOwner({
        storageRootDirectory: configuration.happyHomeDir,
    });
    const browserProfileStore: BrowserProfileStore = createBrowserProfileStore({
        storageRootDirectory: configuration.happyHomeDir,
        partitionOwner: browserStoragePartitionOwner,
        emitAudit: (record) => {
            logger.debug('[DAEMON RUN] Browser profile purge audit', record);
        },
    });
    const purgeBrowserStorageForSessionDeleted = async (sessionId: string): Promise<void> => {
        const trimmed = sessionId.trim();
        if (!trimmed) return;
        const outcome = await browserProfileStore.purgeForSessionDeleted({ sessionId: trimmed });
        if (outcome.failedProfileIds.length > 0) {
            logger.debug('[DAEMON RUN] Browser storage session-delete purge failed for profiles', {
                sessionId: trimmed,
                failedProfileIds: outcome.failedProfileIds,
            });
        }
    };
    const purgeBrowserStorageForLogout = async (): Promise<void> => {
        const outcome = await browserProfileStore.purgeForLogout();
        if (outcome.failedProfileIds.length > 0) {
            logger.debug('[DAEMON RUN] Browser storage logout purge failed for profiles', {
                failedProfileIds: outcome.failedProfileIds,
            });
        }
    };
    params.onBrowserStoragePurgeOwnerReady?.({
        store: browserProfileStore,
        partitionOwner: browserStoragePartitionOwner,
        purgeForSessionDeleted: purgeBrowserStorageForSessionDeleted,
        purgeForLogout: purgeBrowserStorageForLogout,
    });
    const localServicesRuntimeActionRoutes: LocalServicesRuntimeActionRoutes = {
        inventoryRoutes: localServicesRuntime.inventoryRoutes,
        launcherRoutes: localServicesRuntime.launcherRoutes,
        previewRoutes: localServicesRuntime.previewRoutes,
        actionRoutes: localServicesRuntime.actionRoutes,
        publicPreviewRoutes: createLocalServicePublicPreviewServerRoutes({
            token: params.credentials.token,
        }),
    };
    await refreshBrowserRouteOwners();
    runtimeActionRouteProviderTarget.setLocalServicesRuntimeActionRoutesProvider?.(() => localServicesRuntimeActionRoutes);
    runtimeActionRouteProviderTarget.setSimulatorPreviewRoutesProvider?.(() => simulatorPreviewRuntime.routes);
    const localServicesMachineRpcRoutes: DaemonLocalServicesMachineRpcRoutes = {
        localServicesInventory: localServicesRuntime.inventoryRoutes,
        localServicesLauncher: localServicesRuntime.launcherRoutes,
        localServicesManaged: localServicesRuntime.managedRoutes,
        localServicesPreview: localServicesRuntime.previewRoutes,
        localServicesActions: localServicesRuntime.actionRoutes,
        localServicesPublicPreview: localServicesRuntimeActionRoutes.publicPreviewRoutes,
    };
    params.onLocalServicesRoutesReady?.(localServicesMachineRpcRoutes);
    params.onLocalServicesPreviewRoutesReady?.(localServicesRuntime.previewRoutes);
    params.onSimulatorPreviewRoutesReady?.(simulatorPreviewRuntime.routes);
    const apiMachineForSessions = params.getApiMachineForSessions();
    apiMachineForSessions?.registerLocalServicesRoutes(localServicesMachineRpcRoutes);
    apiMachineForSessions?.registerSimulatorPreviewRoutes(simulatorPreviewRuntime.routes);
    const disposeControlRuntimeResources = async (
        managedLocalServicesDisposition: 'permanent' | 'transfer' = 'permanent',
    ): Promise<void> => {
        if (controlRuntimeResourcesDisposed) return;
        controlRuntimeResourcesDisposed = true;
        unsubscribeConnectedServiceRuntimeTargetRegistrations();
        unsubscribeConnectedServiceRuntimeTargetRegistrations = () => {};
        connectedServiceTurnDeferralQueue.cancelAll('daemon_shutdown');
        providerAccountUsagePersistence.dispose();
        shutdownCancellationDomains.beginShutdown();
        // Stop recovery timers so a waiting intent cannot fire switch/restart work into a stopped
        // daemon. Persisted custody remains passive until an explicit post-start recovery action.
        runtimeAuthRecoveryScheduler.dispose();
        temporaryThrottleScheduler.dispose();
        if (browserControlRoutes) {
            runtimeActionRouteProviderTarget.setBrowserDaemonControlRoutesProvider?.(null);
        }
        if (browserContextRoutes) {
            runtimeActionRouteProviderTarget.setBrowserDaemonContextRoutesProvider?.(null);
        }
        if (browserAutomationRoutes) {
            runtimeActionRouteProviderTarget.setBrowserDaemonAutomationRoutesProvider?.(null);
        }
        if (browserDiagnosticsActionRoutes) {
            runtimeActionRouteProviderTarget.setBrowserDiagnosticsActionRoutesProvider?.(null);
        }
        if (browserRecordingRuntime) {
            runtimeActionRouteProviderTarget.setBrowserRecordingRoutesProvider?.(null);
        }
        await browserDiagnosticsInteractionTransport?.dispose();
        browserDiagnosticsInteractionTransport = null;
        disposeBrowserAutomationService?.();
        disposeBrowserAutomationService = null;
        disposeBrowserSidecarDiagnosticsRuntime?.();
        unregisterBrowserSidecarControlAdapter?.();
        await disposeBrowserSidecarControlAdapter?.();
        runtimeActionRouteProviderTarget.setLocalServicesRuntimeActionRoutesProvider?.(null);
        runtimeActionRouteProviderTarget.setSimulatorPreviewRoutesProvider?.(null);
        await shutdownCancellationDomains.stopManagedLocalServices(
            localServicesRuntime,
            managedLocalServicesDisposition,
        );
        browserRecordingRuntime?.stop();
        await simulatorPreviewRuntime.stop();
        // Tear down the long-lived iOS helper child process (SIGTERM) so a verified signed helper
        // never outlives the daemon. No-op when iOS stayed fail-closed (no session was created).
        await iosSimulatorHelperSession?.stop().catch((error: unknown) => {
            logger.debug('[DAEMON RUN] Failed to stop iOS simulator helper session', error);
        });
    };
    async function releaseDaemonAuthBridgeRegistryLease(
        lease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>>,
    ): Promise<void> {
        await lease.release().catch((error: unknown) => {
            logger.debug('[DAEMON RUN] Failed to release daemon auth bridge runtime registry lease', error);
        });
    }
    const resolveDaemonAuthBridge = async (serviceId: ConnectedServiceId): Promise<Readonly<{
        pluginId: string;
        registration: ConnectedServiceDaemonAuthBridgeRegistration;
    }> | null> => {
        let lease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>> | null = null;
        try {
            lease = await acquireAuthoritativePluginRuntimeRegistryLease({
                happyHomeDir: configuration.happyHomeDir,
            });
            const entry = lease
                .registry
                .daemonAuthBridgesByServiceId
                ?.get(serviceId) ?? null;
            if (!entry) return null;
            const refresh: ConnectedServiceDaemonAuthBridgeRefresh | null = await (
                lease.registry.contributes.catalogEntriesById[entry.pluginId]
                    ?.getConnectedServiceDaemonAuthBridgeRefresh?.()
                ?? Promise.resolve(null)
            );
            if (refresh) {
                return Object.freeze({
                    pluginId: entry.pluginId,
                    registration: Object.freeze({
                        ...entry.registration,
                        refresh: async (request: Parameters<ConnectedServiceDaemonAuthBridgeRegistration['refresh']>[0]) => {
                            const refreshCoordinator = params.getConnectedServiceRefreshCoordinator();
                            if (!refreshCoordinator) {
                                throw new Error('connected_service_daemon_auth_bridge_refresh_handler_unavailable');
                            }
                            return await refresh({
                                serviceId,
                                request,
                                refreshCoordinator,
                            });
                        },
                    }),
                });
            }
            return entry;
        } catch (error) {
            logger.debug('[DAEMON RUN] Failed to resolve daemon auth bridge from plugin runtime registry', error);
            return null;
        } finally {
            if (lease) {
                await releaseDaemonAuthBridgeRegistryLease(lease);
            }
        }
    };
    const handleSessionConnectedServiceRuntimeAuthRefresh =
        createSessionConnectedServiceRuntimeAuthRefreshHandler({
            registry: connectedServiceRuntimeRegistry,
            resolveDaemonAuthBridge,
        });
    // Execution-run connected-services bridge: runners (which spawn run backends in-process) ask
    // the daemon to resolve + materialize via the canonical spawn-auth owner with a RUN-scoped
    // materialization key, and the run registers into the canonical runtime registry so its
    // refresh/quota views cover materialized run homes without either coordinator owning writes.
    const executionRunConnectedServicesBridge = createExecutionRunConnectedServicesBridge({
        resolveAuthForSpawn: async (input) => await resolveConnectedServiceAuthForSpawn({
            ...input,
            activeServerDir: configuration.activeServerDir,
            baseDir: params.connectedServicesMaterializationBaseDir,
            credentials: params.credentials,
            api: params.api,
            accountUsageStore: providerAccountUsageStore,
            quotaFreshnessMs: 5 * 60_000,
            nowMs: () => Date.now(),
            authGroupSwitchCoordinator: preTurnConnectedServiceAuthGroupSwitchCoordinator,
            predictiveSwitchGuard: connectedServicePredictiveSwitchGuard ?? null,
            accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
            processEnv: params.processEnv ?? process.env,
            credentialRefreshService: params.getConnectedServiceRefreshCoordinator(),
            serverContract:
                params.getApiMachineForSessions()
                    ?.getSessionSyncPendingInputServerContractResult()
                ?? null,
        }),
        registerRunTargets: (registration) => {
            const canonicalTrackedSessionId = resolveCanonicalTrackedSessionId(registration.runnerPid);
            const sessionId = canonicalTrackedSessionId || registration.sessionId;
            connectedServiceRuntimeRegistry.registerRunTarget({
                runKey: registration.runKey,
                pid: registration.runnerPid,
                agentId: registration.agentId,
                materializationKey: registration.materializationKey,
                connectedServicesBindingsRaw: registration.connectedServicesBindingsRaw,
                connectedServiceSelectionsEnv: registration.connectedServiceSelectionsEnv,
                sessionId,
                sessionDirectory: registration.sessionDirectory,
            });
        },
        unregisterRunTargets: (runKey) => {
            connectedServiceRuntimeRegistry.unregisterRunKey(runKey);
        },
        resolveRunMaterializedRoot: ({ runKey, agentId }) => resolveConnectedServiceMaterializedRootDir({
            baseDir: params.connectedServicesMaterializationBaseDir,
            materializationKey: runKey,
            agentId,
        }),
        createAdoptedRootCleanup: ({ runKey, agentId, materializedRoot }) => createAdoptedExecutionRunRootCleanup({
            materializationBaseDir: params.connectedServicesMaterializationBaseDir,
            materializationKey: runKey,
            agentId,
            materializedRoot,
            removeRoot: async (root) => { await rm(root, { recursive: true, force: true }); },
        }),
        captureRunnerIdentity: ({ runnerPid, expectedParentSessionId }) => {
            const tracked = params.pidToTrackedSession.get(runnerPid);
            if (!tracked) return null;
            const parentSessionId =
                normalizeOptionalString(tracked.happySessionId);
            if (
                !parentSessionId
                || (
                    expectedParentSessionId !== undefined
                    && parentSessionId !== expectedParentSessionId
                )
            ) {
                return null;
            }
            return Object.freeze({
                identity: tracked,
                parentSessionId,
                isCurrent: () =>
                    params.pidToTrackedSession.get(runnerPid) === tracked,
            });
        },
        acquireAgentPurposeContributions: async () => {
            const lease =
                await acquireAuthoritativePluginRuntimeRegistryLease({
                    happyHomeDir: configuration.happyHomeDir,
                });
            return Object.freeze({
                contributions: lease.registry.contributes,
                isCurrent: () =>
                    pluginReloadController.isRuntimeRegistryCurrent(
                        lease.registry,
                    ),
                release: lease.release,
            });
        },
        purposeBindingOwner: Object.freeze({
            activatePurposeBindings:
                params.activatePurposeBindings
                ?? (() => {
                    throw new Error(
                        'connected_account_purpose_binding_owner_unavailable',
                    );
                }),
        }),
        requestAuthRegistry: connectedAccountRequestAuthRegistry,
        resolveRequestAuthHttpPort:
            requireConnectedAccountRequestAuthHttpPort,
        createRedactionLease: () =>
            createProviderRedactionLease({ values: [] }),
    });
    releaseExecutionRunAuthorityForRunnerExit =
        executionRunConnectedServicesBridge.releaseForRunnerExit;
    type EnforcedProviderInputAdmission = {
        kind: 'generation_pending';
        target: ConnectedServiceRuntimeTarget;
        targetWitness: ProviderInputAdmissionTargetWitness;
        readonly epochId: string;
        readonly desired: Readonly<{
            serviceId: ConnectedServiceId;
            groupId: string;
            profileId: string;
            generation: number;
            credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
        }>;
    };
    type EnforcedUnavailableProviderInputAdmission = {
        kind: 'group_unavailable';
        target: ConnectedServiceRuntimeTarget;
        targetWitness: ProviderInputAdmissionTargetWitness;
        readonly serviceId: ConnectedServiceId;
        readonly groupId: string;
    };
    type EnforcedCurrentTruthProviderInputAdmission =
        | EnforcedProviderInputAdmission
        | EnforcedUnavailableProviderInputAdmission;
    const enforcedProviderInputAdmissions = new Map<string, EnforcedProviderInputAdmission>();
    const enforcedUnavailableProviderInputAdmissions = new Map<string, EnforcedUnavailableProviderInputAdmission>();
    const pendingProviderInputAdmissionsByEpochId = new Map<string, EnforcedProviderInputAdmission>();
    const providerInputAdmissionRecords = createProviderInputAdmissionRecordTracker<EnforcedCurrentTruthProviderInputAdmission>();
    const providerInputAdmissionScopeKey = (sessionId: string, serviceId: string, groupId: string) =>
        `${sessionId}\0${serviceId}\0${groupId}`;
    const registeredTargetMatchesProviderInputAdmission = (
        target: ConnectedServiceRuntimeTarget,
        admission: EnforcedProviderInputAdmission,
    ): boolean => {
        const exactSelection = target.connectedServiceSelections.some((selection) => (
            selection.serviceId === admission.desired.serviceId
            && selection.kind === 'group'
            && selection.groupId === admission.desired.groupId
            && selection.activeProfileId === admission.desired.profileId
            && selection.generation === admission.desired.generation
            && selection.credentialRevision === admission.desired.credentialRevision
        ));
        return target.activeBindings.some((binding) => (
            binding.serviceId === admission.desired.serviceId
            && binding.groupId === admission.desired.groupId
            && binding.profileId === admission.desired.profileId
            && binding.groupGeneration === admission.desired.generation
            // The live binding is retained for legacy readers, but admission
            // transfer is authorized only by the post-hot-apply selection's
            // exact revision—not by a null binding revision.
            && (binding.credentialRevision === admission.desired.credentialRevision || exactSelection)
        ));
    };
    advanceProviderInputAdmissionsAfterHotApplyRegistration = ({ previousTarget, registeredTarget }) => {
        if (
            !previousTarget
            || registeredTarget.pid !== previousTarget.pid
            || registeredTarget.sessionId !== previousTarget.sessionId
        ) return;
        const registeredWitness = captureProviderInputAdmissionTargetWitness(registeredTarget);
        if (!registeredWitness || !isCurrentProviderInputAdmissionTarget(registeredWitness)) return;
        for (const admission of pendingProviderInputAdmissionsByEpochId.values()) {
            if (
                admission.target !== previousTarget
                || admission.targetWitness.targetReference !== previousTarget
                || admission.targetWitness.runtimeIdentityKey !== previousTarget.runtimeIdentityKey
                || admission.targetWitness.revision !== previousTarget.revision
                || !registeredTargetMatchesProviderInputAdmission(registeredTarget, admission)
            ) continue;
            admission.target = registeredTarget;
            admission.targetWitness = registeredWitness;
        }
        for (const [scopeKey, admission] of enforcedUnavailableProviderInputAdmissions) {
            if (
                admission.target !== previousTarget
                || admission.targetWitness.targetReference !== previousTarget
                || admission.targetWitness.runtimeIdentityKey !== previousTarget.runtimeIdentityKey
                || admission.targetWitness.revision !== previousTarget.revision
            ) continue;
            enforcedUnavailableProviderInputAdmissions.set(scopeKey, {
                ...admission,
                target: registeredTarget,
                targetWitness: registeredWitness,
            });
        }
    };
    const resolveSharedGenerationTargetMaterializedEnv = async (input: Readonly<{
        ownerId: CatalogAgentId;
        tracked: TrackedSession | null;
        target: Readonly<{
            serviceId: ConnectedServiceId;
            groupId: string;
            profileId: string;
            generation: number;
        }>;
    }>): Promise<Readonly<Record<string, string>> | null> => {
        if (input.tracked) {
            return input.tracked.spawnOptions?.environmentVariables ?? {};
        }
        const capabilities = await getConnectedServiceRecoveryCapabilities(input.ownerId).catch(() => null);
        const requirement = capabilities?.predictiveSoftSwitch.liveSessionRequirement;
        if (
            requirement?.kind !== 'shared_group_auth_surface'
            || !requirement.serviceIds.includes(input.target.serviceId)
        ) {
            return null;
        }
        const materializedRoot = resolveConnectedServiceMaterializedHomeRoot(input.ownerId, {
            activeServerDir: configuration.activeServerDir,
            serviceId: input.target.serviceId,
            profileId: input.target.profileId,
            selection: {
                kind: 'group',
                serviceId: input.target.serviceId,
                groupId: input.target.groupId,
                activeProfileId: input.target.profileId,
                fallbackProfileId: input.target.profileId,
                generation: input.target.generation,
                policy: null,
            },
        });
        return materializedRoot ? { [requirement.authEnvKey]: materializedRoot } : null;
    };
    const createDurableGenerationConsumer = (options?: Readonly<{
        allowProviderInputAdmissionWrites?: boolean;
    }>) => {
        const allowProviderInputAdmissionWrites = options?.allowProviderInputAdmissionWrites === true;
        return new ConnectedServiceAuthGroupGenerationConsumer({
        enforceGroupUnavailable: async ({ sessionId, serviceId, groupId }) => {
            const target = connectedServiceRuntimeRegistry.getBySessionId(sessionId);
            if (!target) return;
            const targetWitness = captureProviderInputAdmissionTargetWitness(target);
            if (!targetWitness) throw new Error('provider_input_admission_target_released');
            const outcome = await requestProviderInputAdmissionForTarget(target, {
                action: 'enforce',
                reason: 'group_unavailable',
                serviceId,
                groupId,
            }, targetWitness);
            if (outcome.status === 'cancelled') throw new Error('provider_input_admission_cancelled');
            enforcedUnavailableProviderInputAdmissions.set(
                providerInputAdmissionScopeKey(sessionId, serviceId, groupId),
                { kind: 'group_unavailable', target, targetWitness, serviceId, groupId },
            );
        },
        clearAdoptedGeneration: async (pending) => {
            const adopted = pending.providerAdoptedTarget;
            if (adopted.credentialRevision === null) {
                throw new Error('provider_adoption_authoritative_fence_superseded');
            }
            const projection = latestConnectedServiceProjectionSnapshot
                ?? await fetchConnectedServiceProjectionSnapshot();
            const current = projection.groups.find((group) => (
                group.serviceId === adopted.serviceId
                && group.groupId === adopted.groupId
            )) ?? null;
            const admissionKey = providerInputAdmissionScopeKey(
                pending.sessionId,
                adopted.serviceId,
                adopted.groupId,
            );
            const recordedAdmission = providerInputAdmissionRecords.read({
                sessionId: pending.sessionId,
                adoptedTarget: adopted,
            });
            const scopedAdmission = enforcedProviderInputAdmissions.get(admissionKey);
            const unavailableAdmission = enforcedUnavailableProviderInputAdmissions.get(admissionKey);
            let admission = recordedAdmission ?? (
                scopedAdmission
                && scopedAdmission.desired.serviceId === adopted.serviceId
                && scopedAdmission.desired.groupId === adopted.groupId
                && scopedAdmission.desired.profileId === adopted.profileId
                && scopedAdmission.desired.generation === adopted.generation
                && scopedAdmission.desired.credentialRevision === adopted.credentialRevision
                  ? scopedAdmission
                  : unavailableAdmission
            );
            if (
                !current
                || current.serviceId !== adopted.serviceId
                || current.groupId !== adopted.groupId
                || current.activeProfileId !== adopted.profileId
                || current.generation !== adopted.generation
                || projection.resolveCredentialRevision(adopted.serviceId, adopted.profileId) !== adopted.credentialRevision
            ) throw new Error('provider_adoption_authoritative_fence_superseded');
            const settledRuntimeTarget = connectedServiceRuntimeRegistry.adoptExactGroupApplicationForSession({
                sessionId: pending.sessionId,
                serviceId: adopted.serviceId,
                groupId: adopted.groupId,
                profileId: adopted.profileId,
                generation: adopted.generation,
                credentialRevision: adopted.credentialRevision,
            });
            if (!settledRuntimeTarget) {
                throw new Error('provider_adoption_runtime_binding_unavailable');
            }
            if (admission && !isCurrentProviderInputAdmissionTarget(admission.targetWitness)) {
                const currentTarget = connectedServiceRuntimeRegistry.getBySessionId(pending.sessionId);
                const currentWitness = currentTarget
                    ? captureProviderInputAdmissionTargetWitness(currentTarget)
                    : null;
                const currentTargetMatchesAdopted = currentTarget?.activeBindings.some((binding) => (
                    binding.serviceId === adopted.serviceId
                    && binding.groupId === adopted.groupId
                    && binding.profileId === adopted.profileId
                    && binding.groupGeneration === adopted.generation
                    && binding.credentialRevision === adopted.credentialRevision
                )) === true;
                if (
                    currentTarget
                    && currentWitness
                    && admission.target.pid === currentTarget.pid
                    && currentTargetMatchesAdopted
                ) {
                    if (admission.kind === 'generation_pending') {
                        admission.target = currentTarget;
                        admission.targetWitness = currentWitness;
                    } else {
                        admission = {
                            ...admission,
                            target: currentTarget,
                            targetWitness: currentWitness,
                        };
                        enforcedUnavailableProviderInputAdmissions.set(admissionKey, admission);
                    }
                    providerInputAdmissionRecords.record({
                        sessionId: pending.sessionId,
                        adoptedTarget: adopted,
                        record: admission,
                    });
                }
            }
            const releaseAdmissionRecord = () => {
                if (!admission) return;
                providerInputAdmissionRecords.delete({
                    sessionId: pending.sessionId,
                    adoptedTarget: adopted,
                });
                if (
                    admission.kind === 'generation_pending'
                    && pendingProviderInputAdmissionsByEpochId.get(admission.epochId) === admission
                ) {
                    pendingProviderInputAdmissionsByEpochId.delete(admission.epochId);
                }
                if (admission.kind === 'generation_pending' && enforcedProviderInputAdmissions.get(admissionKey) === admission) {
                    enforcedProviderInputAdmissions.delete(admissionKey);
                }
                if (admission.kind === 'group_unavailable' && enforcedUnavailableProviderInputAdmissions.get(admissionKey) === admission) {
                    enforcedUnavailableProviderInputAdmissions.delete(admissionKey);
                }
            };
            const clearResult = await clearProviderInputAdmissionAfterDurableAdoption({
                verifyAdoptionStillCurrent: () => !admission || isCurrentProviderInputAdmissionTarget(admission.targetWitness),
                // Current projection + exact provider proof are the canonical adoption fence.
                // Pending generation state is runtime-local, so there is no offline session row to clear.
                clearDurableAdoption: async () => ({ status: 'cleared' as const }),
                hasOutstandingRunnerAdmission: () => admission !== undefined
                    && isCurrentProviderInputAdmissionTarget(admission.targetWitness)
                    && enforcedProviderInputAdmissions.get(admissionKey) === admission,
                clearRunnerAdmission: async () => {
                    if (!admission && !allowProviderInputAdmissionWrites) {
                        return { status: 'cleared' as const };
                    }
                    const runtimeTarget = admission?.target
                        ?? connectedServiceRuntimeRegistry.getBySessionId(pending.sessionId);
                    if (!runtimeTarget) return;
                    if (admission) {
                        const clearOutcome = await requestProviderInputAdmissionForTarget(runtimeTarget, {
                            action: 'clear',
                            serviceId: adopted.serviceId,
                            groupId: adopted.groupId,
                            ...(admission.kind === 'generation_pending' ? { epochId: admission.epochId } : {}),
                        }, admission.targetWitness);
                        if (clearOutcome.status === 'cancelled') {
                            throw new Error('provider_input_admission_cancelled');
                        }
                        if (clearOutcome.value.status === 'enforced') {
                            throw new Error('provider_input_admission_clear_invalid_response');
                        }
                        if (clearOutcome.value.status === 'not_matched') {
                            releaseAdmissionRecord();
                            return { status: 'not_matched' as const };
                        }
                        releaseAdmissionRecord();
                        return { status: 'cleared' as const };
                    }
                    await requestProviderInputAdmissionForTarget(runtimeTarget, {
                        action: 'clear',
                        serviceId: adopted.serviceId,
                        groupId: adopted.groupId,
                    });
                    return { status: 'cleared' as const };
                },
            });
            if (clearResult.status === 'superseded') releaseAdmissionRecord();
            return clearResult;
        },
        verifySharedGenerationApplication: async ({
            sessionId,
            committedGeneration,
            applicationOwnerId,
        }) => {
            const tracked = findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), sessionId);
            const trackedAgentId = resolveTrackedSessionCatalogAgentId(tracked);
            if (tracked && trackedAgentId !== applicationOwnerId) return null;
            const agentId = trackedAgentId ?? applicationOwnerId as CatalogAgentId;
            const targetMaterializedEnv = await resolveSharedGenerationTargetMaterializedEnv({
                ownerId: agentId,
                tracked,
                target: committedGeneration.decisionCommittedTarget,
            });
            if (!targetMaterializedEnv) return null;
            return await resolveSharedGenerationApplicationProof({
                agentId,
                targetMaterializedEnv,
                committedGeneration,
                resolveCredentialResolution: async (binding) => {
                    const resolutions = await resolveConnectedServiceCredentialResolutions({
                        credentials: params.credentials,
                        api: params.api,
                        bindings: [binding],
                    });
                    const resolution = resolutions.get(binding.serviceId) ?? null;
                    return resolution?.revisionSemantics === 'revisioned'
                        ? resolution
                        : null;
                },
                resolveRuntimeAuthAdapter: async (resolvedAgentId) => await getConnectedServiceRuntimeAuthAdapter(
                    resolvedAgentId as CatalogAgentId,
                ),
            });
        },
        resolveGenerationApplicationScope: async ({ sessionId, serviceId, applicationOwnerId }) => {
            const tracked = findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), sessionId);
            const agentId = resolveTrackedSessionCatalogAgentId(tracked);
            return await resolveConnectedServiceGenerationApplicationScope(
                serviceId,
                agentId ? agentId as CatalogAgentId : applicationOwnerId as CatalogAgentId | null,
            );
        },
        applyCommittedGeneration: async ({
            sessionId,
            committedGeneration,
            switchReason,
            executionAuthority,
            applicationOwnerId,
            applicationCohortSessionIds,
        }) => {
            const target = committedGeneration.decisionCommittedTarget;
            const runtimeTarget = connectedServiceRuntimeRegistry.getBySessionId(sessionId);
            const admissionSessionIds = [...new Set(applicationCohortSessionIds ?? [sessionId])];
            const enforcedAdmissionsBySessionId = new Map<string, EnforcedCurrentTruthProviderInputAdmission>();
            for (const admissionSessionId of admissionSessionIds) {
                const unavailable = enforcedUnavailableProviderInputAdmissions.get(
                    providerInputAdmissionScopeKey(admissionSessionId, target.serviceId, target.groupId),
                );
                if (unavailable && isCurrentProviderInputAdmissionTarget(unavailable.targetWitness)) {
                    enforcedAdmissionsBySessionId.set(admissionSessionId, unavailable);
                }
            }
            if (executionAuthority !== 'passive_projection') {
                // A shared auth surface has one provider mutation, but every currently reachable
                // runner sharing it remains a producer until that exact mutation is proven.
                // Offline/no-runtime recipients deliberately have no admission endpoint.
                for (const admissionSessionId of admissionSessionIds) {
                    if (enforcedAdmissionsBySessionId.get(admissionSessionId)?.kind === 'group_unavailable') {
                        continue;
                    }
                    const admissionTarget = connectedServiceRuntimeRegistry.getBySessionId(admissionSessionId);
                    if (!admissionTarget) continue;
                    const targetWitness = captureProviderInputAdmissionTargetWitness(admissionTarget);
                    if (!targetWitness) {
                        return { reconciliationDisposition: 'failed', errorCode: 'provider_input_admission_target_released' };
                    }
                    const epochId = buildProviderInputGenerationEpochId({
                        runtimeIdentityKey: admissionTarget.runtimeIdentityKey,
                        targetRevision: admissionTarget.revision,
                        serviceId: target.serviceId,
                        groupId: target.groupId,
                        desired: {
                            profileId: target.profileId,
                            generation: target.generation,
                            credentialRevision: target.credentialRevision,
                        },
                    });
                    const admissionOutcome = await requestProviderInputAdmissionForTarget(admissionTarget, {
                        action: 'enforce',
                        reason: 'generation_pending',
                        serviceId: target.serviceId,
                        groupId: target.groupId,
                        epochId,
                    }, targetWitness);
                    if (admissionOutcome.status === 'cancelled') {
                        return { reconciliationDisposition: 'failed', errorCode: 'provider_input_admission_cancelled' };
                    }
                    const enforcedAdmission = {
                        kind: 'generation_pending' as const,
                        target: admissionTarget,
                        targetWitness,
                        epochId,
                        desired: target,
                    };
                    enforcedAdmissionsBySessionId.set(admissionSessionId, enforcedAdmission);
                    enforcedProviderInputAdmissions.set(
                        providerInputAdmissionScopeKey(admissionSessionId, target.serviceId, target.groupId),
                        enforcedAdmission,
                    );
                    pendingProviderInputAdmissionsByEpochId.set(epochId, enforcedAdmission);
                }
            }
            const tracked = findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), sessionId);
            if (!tracked) {
                if (target.credentialRevision === null) {
                    return { reconciliationDisposition: 'failed', errorCode: 'credential_revision_missing' };
                }
                const scope = await resolveConnectedServiceGenerationApplicationScope(
                    target.serviceId,
                    applicationOwnerId as CatalogAgentId | undefined,
                );
                if (scope.status !== 'supported' || scope.scope !== 'shared_group_auth_surface') {
                    return { reconciliationDisposition: 'failed', errorCode: 'session_not_found' };
                }
                const ownerId = scope.ownerId as CatalogAgentId;
                const resolutions = await resolveConnectedServiceCredentialResolutions({
                    credentials: params.credentials,
                    api: params.api,
                    bindings: [{ serviceId: target.serviceId, profileId: target.profileId }],
                }).catch(() => null);
                const resolution = resolutions?.get(target.serviceId) ?? null;
                if (
                    !resolution
                    || resolution.revisionSemantics !== 'revisioned'
                    || resolution.credentialRevision
                        !== target.credentialRevision
                ) {
                    return { reconciliationDisposition: 'failed', errorCode: 'credential_revision_superseded' };
                }
                const targetMaterializedEnv = await resolveSharedGenerationTargetMaterializedEnv({
                    ownerId,
                    tracked: null,
                    target,
                });
                const adapter = await getConnectedServiceRuntimeAuthAdapter(ownerId).catch(() => null);
                if (!targetMaterializedEnv || !adapter?.hotApply) {
                    return { reconciliationDisposition: 'failed', errorCode: 'shared_generation_application_unavailable' };
                }
                const selection = {
                    serviceId: target.serviceId,
                    groupId: target.groupId,
                    activeProfileId: target.profileId,
                    profileId: target.profileId,
                    groupGeneration: target.generation,
                    credentialRevision: target.credentialRevision,
                    record: resolution.record,
                    targetMaterializedEnv,
                };
                const applied = await adapter.hotApply({
                    target: { agentId: ownerId },
                    selection,
                    targetMaterializedEnv,
                }).catch(() => null);
                if (!applied?.applied) {
                    return { reconciliationDisposition: 'failed', errorCode: 'shared_generation_application_unverified' };
                }
                const adopted = await resolveSharedGenerationApplicationProof({
                    agentId: ownerId,
                    targetMaterializedEnv,
                    committedGeneration,
                    resolveCredentialResolution: async () => resolution,
                    resolveRuntimeAuthAdapter: async () => adapter,
                });
                if (!adopted) {
                    return { reconciliationDisposition: 'failed', errorCode: 'shared_generation_application_unverified' };
                }
                for (const [admissionSessionId, enforcedAdmission] of enforcedAdmissionsBySessionId) {
                    providerInputAdmissionRecords.record({
                        sessionId: admissionSessionId,
                        adoptedTarget: adopted,
                        record: enforcedAdmission,
                    });
                }
                return { reconciliationDisposition: 'converged', errorCode: null, providerAdoptedTarget: adopted };
            }
            const result = await connectedServiceAuthGroupPreTurnSwitchCoordinator.applyCommittedGeneration({
                sessionId,
                serviceId: target.serviceId,
                groupId: target.groupId,
                activeProfileId: target.profileId,
                generation: target.generation,
                credentialRevision: target.credentialRevision,
                reason: switchReason,
                allowRestart: executionAuthority !== 'passive_projection',
                executionAuthority,
            });
            const mapped = mapCommittedGenerationApplyResult({ committedGeneration, result });
            if (mapped.providerAdoptedTarget) {
                for (const [admissionSessionId, enforcedAdmission] of enforcedAdmissionsBySessionId) {
                    providerInputAdmissionRecords.record({
                        sessionId: admissionSessionId,
                        adoptedTarget: mapped.providerAdoptedTarget,
                        record: enforcedAdmission,
                    });
                }
            }
            return mapped;
        },
        });
    };
    const runtimeGenerationTarget = (target: ReturnType<ConnectedServiceRuntimeRegistry['listTargets']>[number]) => ({
        sessionId: target.sessionId,
        agentId: target.agentId,
        connectedServiceMaterializationIdentityV1: target.connectedServiceMaterializationIdentityV1,
        connectedServicesBindingsRaw: target.connectedServicesBindingsRaw,
        activeBindings: target.activeBindings.map((binding) => ({
            serviceId: binding.serviceId,
            groupId: binding.groupId,
            profileId: binding.profileId,
            generation: binding.groupGeneration,
            credentialRevision: binding.credentialRevision,
        })),
    });
    const isCurrentRuntimeGenerationTarget = (target: ConnectedServiceRuntimeTarget): boolean =>
        connectedServiceRuntimeRegistry.listTargets().some((candidate) => candidate === target);
    const reconciledProjectionByRuntimeTarget = new WeakMap<ConnectedServiceRuntimeTarget, ConnectedServiceProjectionSnapshot>();
    let runtimeTargetReconciliationTail: Promise<void> = Promise.resolve();
    const reconcileRuntimeTargetGenerationForTarget = async (
        target: ConnectedServiceRuntimeTarget,
        sessionMetadata?: Readonly<Record<string, unknown>>,
        requireFreshProjection = false,
    ): Promise<void> => {
        // Execution runs have no proven in-place generation-apply capability. Their exact run-key
        // pre-effect admission fence owns current-generation enforcement, so a retained parent
        // sessionId must never route the run through parent metadata or the session consumer.
        if (connectedServiceRuntimeRegistry.isRunTarget(target)) return;
        const sessionId = target.sessionId;
        if (!sessionId || !isCurrentRuntimeGenerationTarget(target)) return;
        // A fresh/manual generation application already owns this exact runtime transition.
        // Its hot-apply registration emits a registry notification before adoption is cleared;
        // do not start a competing passive consumer that can clear the same runner admission.
        if ([...pendingProviderInputAdmissionsByEpochId.values()].some((admission) => admission.target === target)) {
            return;
        }
        const projectionBoundary = await continueProviderInputAdmissionReconciliationAfterLifecycleFence({
            isCancelled: () => shutdownCancellationDomains.daemonWorkSignal.aborted
                || (params.isShuttingDown?.() ?? false),
            continueReconciliation: async () => requireFreshProjection
                ? await fetchConnectedServiceProjectionSnapshot()
                : latestConnectedServiceProjectionSnapshot
                    ?? await fetchConnectedServiceProjectionSnapshot(),
        });
        if (projectionBoundary.status === 'cancelled') return;
        const projectionSnapshot = projectionBoundary.value;
        if (!isCurrentRuntimeGenerationTarget(target)) return;
        if (reconciledProjectionByRuntimeTarget.get(target) === projectionSnapshot) return;
        let effectiveSessionMetadata = sessionMetadata;
        if (!effectiveSessionMetadata) {
            const rawSession = await fetchSessionByIdCompat({
                token: params.credentials.token,
                sessionId,
            });
            effectiveSessionMetadata = rawSession
                ? tryDecryptSessionOwnerMetadataView({ credentials: params.credentials, rawSession }) ?? undefined
                : undefined;
        }
        if (
            !isCurrentRuntimeGenerationTarget(target)
            || latestConnectedServiceProjectionSnapshot !== projectionSnapshot
        ) return;
        const providerAdoptedTargets = effectiveSessionMetadata
            ? readConnectedServiceProviderAdoptedAuthGroupGenerationsFromMetadata(effectiveSessionMetadata)
                .map((entry) => entry.providerAdoptedTarget)
            : [];
        await reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
            target: runtimeGenerationTarget(target),
            providerAdoptedTargets,
            consumer: createDurableGenerationConsumer({ allowProviderInputAdmissionWrites: false }),
            listCurrentGroups: async (serviceId) => projectionSnapshot.groups.filter((group) => group.serviceId === serviceId),
            resolveCredentialRevision: projectionSnapshot.resolveCredentialRevision,
            resolveCredentialPresence: projectionSnapshot.resolveCredentialPresence,
            executionAuthority: 'passive_projection',
        });
        await reconcileConnectedServiceDirectCredentialRevisions({
            credentialRevisions: projectionSnapshot.credentialRevisions,
            resolveCredentialPresence: projectionSnapshot.resolveCredentialPresence,
            listRuntimeTargets: () => [runtimeGenerationTarget(target)],
            applyLiveCredentialRevision: async (input) => {
                await applyConnectedServiceProjectionCredentialUpdate({
                    input,
                    listRuntimeTargets: () => connectedServiceRuntimeRegistry.listRefreshTargets(),
                    stopSession,
                    getRefreshCoordinator: params.getConnectedServiceRefreshCoordinator,
                });
            },
            executionAuthority: 'passive_projection',
        });
        if (
            isCurrentRuntimeGenerationTarget(target)
            && latestConnectedServiceProjectionSnapshot === projectionSnapshot
        ) {
            reconciledProjectionByRuntimeTarget.set(target, projectionSnapshot);
        }
    };
    const scheduleRuntimeTargetGenerationReconciliation = (
        offeredTarget: ConnectedServiceRuntimeTarget,
        sessionMetadata?: Readonly<Record<string, unknown>>,
        requireFreshProjection = false,
    ): Promise<void> => {
        const scheduled = runtimeTargetReconciliationTail.then(async () => {
            const currentTarget = isCurrentRuntimeGenerationTarget(offeredTarget) ? offeredTarget : null;
            if (!currentTarget) return;
            await reconcileRuntimeTargetGenerationForTarget(
                currentTarget,
                sessionMetadata,
                requireFreshProjection,
            );
        });
        runtimeTargetReconciliationTail = scheduled.catch(() => undefined);
        return scheduled;
    };
    unsubscribeConnectedServiceRuntimeTargetRegistrations = connectedServiceRuntimeRegistry.subscribeTargetRegistrations(
        (target) => {
            const tracked = params.pidToTrackedSession.get(target.pid) ?? null;
            if (!connectedServiceRuntimeRegistry.isRunTarget(target) && !tracked?.happySessionMetadataFromLocalWebhook) {
                return;
            }
            void scheduleRuntimeTargetGenerationReconciliation(target).catch((error) => {
                logger.debug('[DAEMON RUN] Failed to reconcile connected-service group generation after runtime registration', {
                    pid: target.pid,
                    sessionId: target.sessionId,
                    error: serializeAxiosErrorForLog(error),
                });
            });
        },
    );
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
        getChildren: () => Array.from(params.pidToTrackedSession.values()),
        machineId: params.machineId,
        runtimeId: params.runtimeId ?? '',
        stopSession,
        spawnSession,
        requestShutdown: () => params.requestShutdown('happier-cli'),
        ...(params.requestSelfRestart ? { requestSelfRestart: params.requestSelfRestart } : {}),
        ...(params.pluginChangeService ? { pluginChangeService: params.pluginChangeService } : {}),
        pluginActionCurrentIntent: createCredentialedTargetActionCurrentIntent(params.credentials),
        ...(params.isShuttingDown ? { isShuttingDown: params.isShuttingDown } : {}),
        beforeShutdown: async ({ managedLocalServicesDisposition }) => {
            await agentRuntimeSessionBridge.dispose();
            await externalSessionHostOperationOwner.retire();
            await disposeControlRuntimeResources(managedLocalServicesDisposition);
            const beforeShutdown = params.beforeShutdown;
            if (typeof beforeShutdown === 'function') {
                await beforeShutdown({ managedLocalServicesDisposition });
            }
        },
        onHappySessionWebhook: async (sessionId, sessionMetadata) => {
            await params.onHappySessionWebhook(sessionId, sessionMetadata);
            void queueHostedWebStaticAssetSync('session_webhook');
            const normalizedSessionId = normalizeOptionalString(sessionId);
            if (!normalizedSessionId) return;
            rememberPersistedConnectedServiceSwitchSessionMetadata(normalizedSessionId, sessionMetadata);
            const tracked = [...params.pidToTrackedSession.values()]
                .find((candidate) => normalizeOptionalString(candidate.happySessionId) === normalizedSessionId);
            if (tracked) {
                await publishReportedTerminalControlServiceability({
                    tracked,
                    readTerminalAttachmentInfo: async (reportedSessionId) =>
                        await readTerminalHostAttachmentInfo({
                            happyHomeDir: configuration.happyHomeDir,
                            sessionId: reportedSessionId,
                        }),
                    probeSessionRunnerServiceability: async (reportedSessionId) =>
                        await probeSessionRunnerServiceability({
                            sessionId: reportedSessionId,
                            trackedSessions: params.pidToTrackedSession.values(),
                            probeCapability: async () =>
                                await probeAlreadyRunningExistingSessionServiceability({
                                    sessionId: reportedSessionId,
                                    credentials: params.credentials,
                                    abortSignal: shutdownCancellationDomains.daemonWorkSignal,
                                    ...(params.isShuttingDown ? { isShuttingDown: params.isShuttingDown } : {}),
                                }),
                        }),
                    publishSessionRunnerControlServiceability: async (reportedSessionId, probe) => {
                        if (probe.state !== 'runner_present') return false;
                        return await publishCurrentTerminalControlServiceability({
                            credentials: params.credentials,
                            happyHomeDir: configuration.happyHomeDir,
                            sessionId: reportedSessionId,
                            serviceability: probe.control,
                        });
                    },
                });
            }
            void rehydrateConnectedServiceRuntimeIdentityForSessionReport({
                credentials: params.credentials,
                quotaCoordinator: params.getConnectedServiceQuotasCoordinator(),
                sessionId: normalizedSessionId,
                tracked: tracked ?? null,
            }).catch((error) => {
                logger.debug('[DAEMON RUN] Failed to rehydrate connected-service runtime identity after session report', {
                    sessionId: normalizedSessionId,
                    error: serializeAxiosErrorForLog(error),
                });
            });
            const currentTarget = connectedServiceRuntimeRegistry.getBySessionId(normalizedSessionId);
            if (!currentTarget) return;
            await scheduleRuntimeTargetGenerationReconciliation(currentTarget, sessionMetadata, true);
        },
        ...(params.admitPersistedTakeover
            ? { admitPersistedTakeover: params.admitPersistedTakeover }
            : {}),
        ...(params.sshTunnelSupervisor ? { sshTunnels: params.sshTunnelSupervisor } : {}),
        localServicesInventory: localServicesRuntime.inventoryRoutes,
        localServicesLauncher: localServicesRuntime.launcherRoutes,
        localServicesManaged: localServicesRuntime.managedRoutes,
        localServicesPreview: localServicesRuntime.previewRoutes,
        localServicesActions: localServicesRuntime.actionRoutes,
        localServicesPublicPreview: localServicesRuntimeActionRoutes.publicPreviewRoutes,
        localServicesPluginBridge: localServicesRuntime.pluginBridgeRoutes,
        agentRuntimeSessionBridge,
        foregroundAgentRuntimeAdmission,
        simulatorPreview: simulatorPreviewRuntime.routes,
        connectedAccountRequestAuth: {
            authenticate: connectedAccountRequestAuthRegistry.authenticate,
            lookupRequestAuth: async (input) => {
                await ensureCurrentProjectionForRequestAuth();
                return await connectedAccountRequestAuthService
                    .lookupRequestAuth(input);
            },
            refreshAfterAuthFailure: async (input) => {
                await ensureCurrentProjectionForRequestAuth();
                return await connectedAccountRequestAuthService
                    .refreshAfterAuthFailure(input);
            },
            reportQuotaFailure: async (input) => {
                await ensureCurrentProjectionForRequestAuth();
                return await connectedAccountRequestAuthService
                    .reportQuotaFailure(input);
            },
        },
        handleSessionConnectedServiceAuthSwitch: async (input) => {
            const interruptedOriginId = Array.from(params.pidToTrackedSession.values())
                .find((tracked) => tracked.happySessionId === input.sessionId)
                ?.activeTurnId?.trim() || null;
            await connectedServiceRecoverySupersessionCleaner({
                sessionId: input.sessionId,
                event: { kind: 'manual_session_supersession', reason: 'switch' },
            });
            const settingsRefresh = await refreshAccountSettingsForDaemonRequest({
                credentials: params.credentials,
                accountSettingsVersionHint: input.accountSettingsVersionHint,
            });
            let diagnostics: SessionConnectedServiceAuthSwitchDiagnostics | undefined;
            if (!settingsRefresh.ok) {
                logger.warn(
                    '[DAEMON RUN] Account settings freshness refresh failed before connected-service auth switch',
                    serializeAxiosErrorForLog(settingsRefresh.error),
                );
                diagnostics = {
                    accountSettingsFreshness: {
                        requestedVersion: typeof input.accountSettingsVersionHint === 'number'
                            ? input.accountSettingsVersionHint
                            : null,
                        status: 'failed',
                        error: toConnectedServiceAuthSwitchDiagnosticError(settingsRefresh.error),
                    },
                };
            } else if (typeof input.accountSettingsVersionHint === 'number') {
                diagnostics = {
                    accountSettingsFreshness: {
                        requestedVersion: input.accountSettingsVersionHint,
                        status: 'succeeded',
                    },
                };
            }

            // K5:fsm_switch manual auth switch routes through the FSM (reachability
            // gate at respawn, binding persistence, hot-apply-in-place when eligible).
            const result = await switchSessionConnectedServiceAuth({
                core: connectedServiceSessionAuthSwitchCore,
                getChildren: () => Array.from(params.pidToTrackedSession.values()),
                resolveInactiveSession: async ({ sessionId }) => {
                    return await resolveInactiveConnectedServiceSessionContext({
                        token: params.credentials.token,
                        credentials: params.credentials,
                        sessionId,
                    });
                },
                api: params.api,
                resolveContinuity: async ({
                    tracked,
                    sessionId,
                    agentId,
                    serviceId,
                    previous,
                    next,
                    previousBindings,
                    normalizedBindings,
                    connectedServiceMaterializationIdentityV1,
                    vendorResumeId,
                    runtimeAuthSelection,
                    cwd: inactiveCwd,
                    candidatePersistedSessionFile: inactiveCandidatePersistedSessionFile,
                }) => {
                    const persistedSessionMetadata = tracked
                        ? await readPersistedConnectedServiceSwitchSessionMetadata(sessionId)
                        : null;
                    const continuityContext = resolveTrackedConnectedServiceSwitchContinuityContext({
                        agentId,
                        baseDir: params.connectedServicesMaterializationBaseDir,
                        tracked,
                        persistedSessionMetadata,
                        connectedServiceMaterializationIdentityV1,
                        vendorResumeId,
                        runtimeAuthSelection,
                        cwd: inactiveCwd,
                        candidatePersistedSessionFile: inactiveCandidatePersistedSessionFile ?? null,
                    });
                    return await resolveSessionConnectedServiceSwitchContinuity({
                        sessionId,
                        agentId,
                        serviceId,
                        previousBinding: previous,
                        nextBinding: next,
                        tracked,
                        connectedServiceMaterializationIdentityV1: continuityContext.connectedServiceMaterializationIdentityV1,
                        vendorResumeId: continuityContext.vendorResumeId,
                        fromBindingsRaw: tracked
                            ? resolveTrackedConnectedServiceBindingsRaw(tracked) ?? previousBindings
                            : previousBindings,
                        toBindings: normalizedBindings,
                        accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
                        targetMaterializedRoot: continuityContext.targetMaterializedRoot,
                        targetMaterializedEnv: continuityContext.targetMaterializedEnv,
                        cwd: continuityContext.cwd,
                        candidatePersistedSessionFile: continuityContext.candidatePersistedSessionFile,
                        ...(runtimeAuthSelection === undefined ? {} : { runtimeAuthSelection }),
                    });
                },
                materializeRuntimeAuthSelection: async (materializerInput) =>
                    await materializeSessionConnectedServiceRuntimeAuthSelection({
                        credentials: params.credentials,
                        api: params.api,
                        activeServerDir: configuration.activeServerDir,
                        input: materializerInput,
                        accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
                        processEnv: params.processEnv,
                    }),
                restartSession: async (tracked) => {
                    const serviceIds = Object.keys(input.bindings.bindingsByServiceId);
                    const primaryServiceId = serviceIds[0] ?? '';
                    const primaryBinding = primaryServiceId
                        ? input.bindings.bindingsByServiceId[primaryServiceId]
                        : null;
                    const primaryGeneration = primaryServiceId
                        ? input.expectedGroupGenerationByServiceId?.[primaryServiceId]
                        : undefined;
                    const restartSignalDelayMs = resolvePositiveIntEnv(
                        params.processEnv.HAPPIER_CONNECTED_SERVICES_AUTH_SWITCH_RESTART_SIGNAL_DELAY_MS,
                        250,
                        { min: 0, max: 5_000 },
                    );
                    // K5:gated_restart manual restart-resume fallback (hot-apply ineligible);
                    // gated through deferral + spawn-time reachability (K1).
                    await requestConnectedServiceRestartWithDeferral({
                        sessionId: input.sessionId,
                        tracked,
                        source: 'manual',
                        policy: 'defer_until_turn_boundary',
                        target: normalizeSwitchTarget({
                            serviceId: primaryServiceId,
                            profileId: primaryBinding?.source === 'connected' ? primaryBinding.profileId : '',
                            groupId: primaryBinding?.source === 'connected' && primaryBinding.selection === 'group'
                                ? primaryBinding.groupId
                                : '',
                            generation: typeof primaryGeneration === 'number' && Number.isFinite(primaryGeneration)
                                ? Math.max(0, Math.trunc(primaryGeneration))
                                : 0,
                        }),
                        restartSignalDelayMs,
                        restartDiagnostic: buildManualSwitchRestartDiagnostic({
                            sessionId: input.sessionId,
                            agentId: input.agentId,
                            bindings: input.bindings,
                        }),
                        onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart connected-service auth-switched session',
                    });
                },
                persistSessionBindings: async ({
                    sessionId,
                    normalizedBindings,
                    connectedServiceMaterializationIdentityV1,
                }) => {
                    const tracked = findTrackedSessionByHappySessionId(
                        params.pidToTrackedSession.values(),
                        sessionId,
                    );
                    await persistSessionConnectedServiceBindings({
                        token: params.credentials.token,
                        credentials: params.credentials,
                        sessionId,
                        normalizedBindings,
                        connectedServiceMaterializationIdentityV1:
                            connectedServiceMaterializationIdentityV1 === undefined
                                ? resolveConnectedServiceMaterializationIdentityFromTrackedSession(tracked)
                                : connectedServiceMaterializationIdentityV1,
                    });
                    forgetPersistedConnectedServiceSwitchSessionMetadata(sessionId);
                },
                continueAfterRuntimeAuthSwitch: createConnectedServiceContinuationHandler({
                    credentials: params.credentials,
                    interruptedOriginId,
                    resumePromptMode: await resolveContinuationResumePromptMode({}),
                    customResumePrompt: readContinuationCustomResumePrompt(getActiveAccountSettingsSnapshot()?.settings ?? null),
                    resolveInterruption: ({ sessionId, action, switchReason }) =>
                        resolveConnectedServiceContinuationInterruptionForSwitch({
                            sessionId,
                            interruptedSessionId: input.sessionId,
                            action,
                            switchReason,
                            turnDeferralQueue: connectedServiceTurnDeferralQueue,
                        }),
                }),
                recoverAfterRuntimeAuthSwitch: createSelectionPostSwitchRecoveryHandler({
                    getTrackedSessions: () => Array.from(params.pidToTrackedSession.values()),
                    isTurnInFlight: (sessionId) => connectedServiceTurnDeferralQueue.isTurnInFlight(sessionId),
                }),
                verifyProviderAccountAdoption: async (verificationInput) => {
                    const result = await verifySessionConnectedServiceAccountAdoption(verificationInput);
                    recordRuntimeAccountIdentityFromVerification({
                        quotaCoordinator: params.getConnectedServiceQuotasCoordinator(),
                        verificationInput,
                        result,
                        observedAtMs: Date.now(),
                    });
                    return result;
                },
                hotApply: createSessionConnectedServiceAuthHotApply(),
                registerHotApplyTargets: registerHotApplyRuntimeTarget,
                emitSessionEvent: (sessionId, event) => {
                    commitConnectedServiceAccountSwitchSessionEventWithNotification({
                        sessionId,
                        event,
                        logContext: 'manual',
                        reasonFallback: 'manual',
                    });
                },
                request: input,
            });
            const resultWithDiagnostics = attachConnectedServiceAuthSwitchDiagnostics(result, diagnostics);
            logConnectedServiceAuthSwitchResult({
                sessionId: input.sessionId,
                agentId: input.agentId,
                serviceIds: Object.keys(input.bindings.bindingsByServiceId),
                result: resultWithDiagnostics,
            });
            return resultWithDiagnostics;
        },
        handleSessionConnectedServiceRuntimeAuthRefresh,
        handleSessionRunnerRestart: async (request) => {
            const tracked = findTrackedSessionByHappySessionId(
                params.pidToTrackedSession.values(),
                request.sessionId,
            );
            return await restartSessionRunnerOnCurrentRuntime({
                request,
                tracked,
                currentIdentity: resolveCurrentSessionRunnerLaunchIdentity(),
                requestRestart: requestSessionRunnerVersionRuntimeRefresh,
                resolveActivityDisabledReason: resolveSessionRunnerActivityDisabledReason,
            });
        },
        handleSessionRunnerRestartAll: async (request) => {
            return await restartAllSessionRunnersOnCurrentRuntime({
                mode: request.mode,
                reason: request.reason,
                dryRun: request.dryRun === true,
                currentIdentity: resolveCurrentSessionRunnerLaunchIdentity(),
                trackedSessions: Array.from(params.pidToTrackedSession.values()),
                requestRestart: requestSessionRunnerVersionRuntimeRefresh,
                resolveActivityDisabledReason: resolveSessionRunnerActivityDisabledReason,
            });
        },
        handleSessionRunnerStatusGet: async (request) => {
            const tracked = findTrackedSessionByHappySessionId(
                params.pidToTrackedSession.values(),
                request.sessionId,
            );
            return resolveSessionRunnerRuntimeState({
                sessionId: request.sessionId,
                tracked,
                currentIdentity: resolveCurrentSessionRunnerLaunchIdentity(),
                resolveActivityDisabledReason: resolveSessionRunnerActivityDisabledReason,
                machineId: params.machineId,
                observedAtMs: Date.now(),
            });
        },
        handleConnectedServiceRuntimeAuthFailure: runConnectedServiceRuntimeAuthFailureRecovery,
        handleConnectedServiceUsageLimitWaitResumeCancel: async (input) =>
            await runtimeAuthRecoveryScheduler.cancelExact(input),
        authorizeConnectedServiceRuntimeAuthFailure: async ({ sessionId, classification }) =>
            await authorizeConnectedServiceRuntimeAuthFailureSource({
                getChildren: () => Array.from(params.pidToTrackedSession.values()),
                resolveInactiveSession: async ({ sessionId: inactiveSessionId }) =>
                    await resolveInactiveConnectedServiceSessionContext({
                        token: params.credentials.token,
                        credentials: params.credentials,
                        sessionId: inactiveSessionId,
                    }),
                resolveRegisteredRuntimeAuthFailureSource: resolveRegisteredRuntimeAuthFailureSourceForSession,
                resolveCurrentRuntimeAuthFailureSource: resolveCurrentRuntimeAuthFailureSourceForSession,
                sessionId,
                classification,
                runtimeAuthApplyCapability: await resolveRuntimeAuthApplyCapabilityForInput({ sessionId }),
            }),
        resolveConnectedServiceRuntimeAuthResumePromptMode: async ({ classification, explicit }) =>
            await resolveContinuationResumePromptMode({
                serviceId: ConnectedServiceIdSchema.parse(classification.serviceId),
                groupId: classification.groupId,
                explicit,
            }),
        runtimeAuthRecoveryScheduler,
        handleConnectedServiceTurnLifecycle: async (input) => {
            const lifecycleObservedAtMs = Date.now();
            const turnCustody = await applyTrackedSessionTurnLifecycle({
                trackedSessions: params.pidToTrackedSession.values(),
                sessionId: input.sessionId,
                event: input.event,
                ...(input.turnId ? { turnId: input.turnId } : {}),
            });
            const acceptsDownstreamLifecycle = turnCustody.status === 'recorded'
                || turnCustody.status === 'ignored_missing_exact_turn';
            if (!acceptsDownstreamLifecycle || controlRuntimeResourcesDisposed) {
                return { status: turnCustody.status, turnCustody };
            }
            const runtimeTargetAtAcceptance =
                connectedServiceRuntimeRegistry.getBySessionId(input.sessionId) ?? null;
            connectedServiceTurnDeferralQueue.recordTurnLifecycleEvent({
                sessionId: input.sessionId,
                event: input.event,
            });
            // Exact marker custody is the control response boundary. Provider proof and report-outbox
            // supersession are downstream settlement: keep their established order, but do not let
            // either strand the runner's accepted begin/terminal lifecycle acknowledgement.
            void Promise.resolve().then(async () => {
                if (
                    controlRuntimeResourcesDisposed
                    || (
                        runtimeTargetAtAcceptance !== null
                        && !isCurrentRuntimeGenerationTarget(runtimeTargetAtAcceptance)
                    )
                ) {
                    return;
                }
                if (isProviderActivityTurnLifecycleEvent(input.event, input.terminalStatus)) {
                    const providerOutcome = runtimeTargetAtAcceptance
                        ? await verifyProviderActivityOutcome({
                            target: runtimeTargetAtAcceptance,
                            reportedSelectionsEnvRaw: input.connectedServiceSelectionsEnvRaw,
                            event: input.event === 'task_started' ? 'task_started' : 'assistant_message_end',
                        }).catch(() => ({
                            status: 'unavailable' as const,
                            reason: 'provider_outcome_verification_failed',
                        }))
                        : { status: 'unsupported' as const };
                    if (
                        controlRuntimeResourcesDisposed
                        || (
                            runtimeTargetAtAcceptance !== null
                            && !isCurrentRuntimeGenerationTarget(runtimeTargetAtAcceptance)
                        )
                    ) {
                        return;
                    }
                    await recordConnectedServiceContinuationProviderActivity({
                        sessionId: input.sessionId,
                        observedAtMs: lifecycleObservedAtMs,
                        ...(providerOutcome.status === 'unsupported'
                            ? {}
                            : {
                                providerOutcomeTargets: providerOutcome.status === 'verified'
                                    ? providerOutcome.targets
                                    : [],
                            }),
                    });
                }
                if (
                    controlRuntimeResourcesDisposed
                    || (
                        runtimeTargetAtAcceptance !== null
                        && !isCurrentRuntimeGenerationTarget(runtimeTargetAtAcceptance)
                    )
                ) {
                    return;
                }
                // Runtime-auth report-outbox supersession remains owned by its canonical cleaner.
                await connectedServiceRecoverySupersessionCleaner({
                    sessionId: input.sessionId,
                    event: {
                        kind: 'turn_lifecycle',
                        event: input.event,
                        ...(input.terminalStatus ? { terminalStatus: input.terminalStatus } : {}),
                    },
                    updatedBeforeMs: lifecycleObservedAtMs,
                });
            }).catch((error) => {
                logger.debug('[DAEMON RUN] Connected-service turn lifecycle downstream settlement failed after custody (non-fatal)', {
                    sessionId: input.sessionId,
                    event: input.event,
                    error: serializeAxiosErrorForLog(error),
                });
            });
            return { status: turnCustody.status, turnCustody };
        },
        handleConnectedServiceQuotaRecoveryCreditConsume: async (input) => {
            const coordinator = params.getConnectedServiceQuotasCoordinator();
            if (!coordinator) {
                return {
                    ok: false as const,
                    errorCode: 'connected_service_quota_recovery_credit_unavailable',
                    error: 'connected_service_quota_recovery_credit_unavailable',
                };
            }
            return await coordinator.consumeRecoveryCreditForProfile(input);
        },
        handleProviderAccountUsageSnapshot: async (input) => {
            let qualifiedUsageSource: ConnectedServiceUsageSourceV1 | null = null;
            const result = await recordProviderAccountUsageSnapshotForSession({
                getChildren: () => Array.from(params.pidToTrackedSession.values()),
                store: providerAccountUsageStore,
                persistence: providerAccountUsagePersistence,
                ...(input.source ? { observation: { sources: [input.source] as const } } : {}),
                credentialFingerprint: input.credentialFingerprint,
                verifyCredentialFingerprint: async (candidate) => {
                    const serviceId = ConnectedServiceIdSchema.safeParse(candidate.serviceId);
                    if (!serviceId.success) return false;
                    const resolution = await resolveConnectedServiceCredentialResolutions({
                        credentials: params.credentials,
                        api: params.api,
                        bindings: [{ serviceId: serviceId.data, profileId: candidate.profileId }],
                    }).then((byServiceId) => byServiceId.get(serviceId.data) ?? null);
                    if (resolution?.revisionSemantics !== 'revisioned') {
                        return false;
                    }
                    const record = resolution.record;
                    return record?.kind === 'oauth'
                        && record.oauth.providerAccountId === candidate.providerAccountId
                        && computeConnectedServiceAccessTokenFingerprint(record.oauth.accessToken) === candidate.credentialFingerprint;
                },
                resolveAuthoritativeSource: async (source) => {
                    const currentBinding = connectedServiceRuntimeRegistry
                        .getBySessionId(input.sessionId)
                        ?.activeBindings.find((binding) => binding.serviceId === source.serviceId) ?? null;
                    if (!currentBinding || currentBinding.profileId !== source.profileId) return null;
                    qualifiedUsageSource = currentBinding.groupId === null
                        ? {
                            serviceId: currentBinding.serviceId,
                            profileId: currentBinding.profileId,
                            bindingKind: 'profile',
                        }
                        : currentBinding.groupGeneration === null
                            ? null
                            : {
                                serviceId: currentBinding.serviceId,
                                profileId: currentBinding.profileId,
                                bindingKind: 'group_member',
                                groupId: currentBinding.groupId,
                                groupGeneration: currentBinding.groupGeneration,
                            };
                    return qualifiedUsageSource;
                },
                publishRecordId: async ({ sessionId, recordId }) => await publishProviderAccountUsageRecordIdToSessionMetadata({
                    token: params.credentials.token,
                    credentials: params.credentials,
                    sessionId,
                    recordId,
                }),
                sessionId: input.sessionId,
                snapshot: input.snapshot,
            });
            // Transport custody ends at the canonical recorder and persistence scheduler.
            // Policy fanout and recovery proof are downstream settlement and cannot delay receipt.
            void Promise.resolve().then(async () => {
                let sourceIsExactlyCurrent = false;
                let quotaProof: Readonly<{
                    sessionId: string;
                    proofKind: 'quota_probe_fresh';
                    serviceId: ConnectedServiceId;
                    profileId: string;
                    groupId: string | null;
                    groupGeneration: number | null;
                    credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
                    observedAtMs: number;
                }> | null = null;
                if (
                    isProviderAccountUsageStoreMutationAccepted(result)
                    && qualifiedUsageSource
                    && input.credentialFingerprint
                    && input.snapshot.accountSubject.kind === 'providerSubject'
                ) {
                    const source = qualifiedUsageSource;
                    const serviceId = ConnectedServiceIdSchema.safeParse(source.serviceId);
                    const coordinator = params.getConnectedServiceQuotasCoordinator();
                    const projected = projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1({
                        snapshot: input.snapshot,
                        source,
                    });
                    const credentialResolution = serviceId.success
                        ? await resolveConnectedServiceCredentialResolutions({
                            credentials: params.credentials,
                            api: params.api,
                            bindings: [{ serviceId: serviceId.data, profileId: source.profileId }],
                        }).then((byServiceId) => byServiceId.get(serviceId.data) ?? null).catch(() => null)
                        : null;
                    const credential = credentialResolution?.record ?? null;
                    sourceIsExactlyCurrent =
                        credentialResolution?.revisionSemantics === 'revisioned'
                        && credential?.kind === 'oauth'
                        && credential.oauth.providerAccountId === input.snapshot.accountSubject.id
                        && computeConnectedServiceAccessTokenFingerprint(credential.oauth.accessToken) === input.credentialFingerprint;
                    if (
                        serviceId.success
                        && coordinator
                        && projected
                        && credentialResolution
                        && credential?.kind === 'oauth'
                        && sourceIsExactlyCurrent
                    ) {
                        const groupId = source.bindingKind === 'group_member'
                            ? source.groupId ?? null
                            : null;
                        const groupGeneration = source.bindingKind === 'group_member'
                            ? source.groupGeneration ?? null
                            : null;
                        const proof = coordinator.resolveQuotaProbeFreshProof({
                            serviceId: serviceId.data,
                            profileId: source.profileId,
                            expectedAppliedIdentity: {
                                serviceId: serviceId.data,
                                profileId: source.profileId,
                                groupId,
                                groupGeneration,
                                providerAccountId: credential.oauth.providerAccountId,
                                materialFingerprint: computeConnectedServiceAccessTokenFingerprint(credential.oauth.accessToken),
                            },
                            snapshotAppliedIdentity: {
                                serviceId: serviceId.data,
                                profileId: source.profileId,
                                groupId,
                                groupGeneration,
                                providerAccountId: input.snapshot.accountSubject.id,
                                materialFingerprint: input.credentialFingerprint,
                            },
                            snapshot: projected,
                        });
                        if (proof.status === 'proof') {
                            quotaProof = {
                                sessionId: input.sessionId,
                                proofKind: proof.proofKind,
                                serviceId: serviceId.data,
                                profileId: source.profileId,
                                groupId,
                                groupGeneration,
                                credentialRevision: credentialResolution.credentialRevision,
                                observedAtMs: input.snapshot.observedAtMs,
                            };
                        }
                    }
                }
                if (
                    sourceIsExactlyCurrent
                    && isProviderAccountUsageStoreMutationAccepted(result)
                    && 'recordId' in result
                    && qualifiedUsageSource
                    && qualifiedUsageSource.bindingKind === 'group_member'
                    && qualifiedUsageSource.groupId
                    && qualifiedUsageSource.groupGeneration !== undefined
                ) {
                    const snapshot = providerAccountUsageStore.resolveRecordId(result.recordId);
                    if (snapshot) {
                        await params.getConnectedServiceQuotasCoordinator()?.handleAccountUsageChanged?.({
                            sessionId: input.sessionId,
                            serviceId: qualifiedUsageSource.serviceId,
                            profileId: qualifiedUsageSource.profileId,
                            groupId: qualifiedUsageSource.groupId,
                            groupGeneration: qualifiedUsageSource.groupGeneration,
                            recordId: result.recordId,
                            snapshot,
                            source: input.policyDisposition === 'evidence_only'
                                ? 'evidence_only'
                                : 'in_band',
                        });
                    }
                }
                if (quotaProof) {
                    await runtimeAuthRecoveryScheduler.markProviderOutcomeProofByIdentity(quotaProof).catch(() => []);
                }
            }).catch((error) => {
                logger.debug('[DAEMON RUN] Provider account-usage downstream settlement failed after custody (non-fatal)', {
                    error: serializeAxiosErrorForLog(error),
                });
            });
            return result;
        },
        handleProviderAccountUsageAdoption: async (input) => await recordProviderAccountUsageAdoptionForSession({
            getChildren: () => Array.from(params.pidToTrackedSession.values()),
            store: providerAccountUsageStore,
            persistence: providerAccountUsagePersistence,
            publishRecordId: async ({ sessionId, recordId }) => await publishProviderAccountUsageRecordIdToSessionMetadata({
                token: params.credentials.token,
                credentials: params.credentials,
                sessionId,
                recordId,
            }),
            sessionId: input.sessionId,
            adoption: input.adoption,
        }),
        controlToken,
        // Execution-run bridge endpoints accept only the scoped run-materialize capability token.
        verifyRunMaterializeToken: (provided) => isValidConnectedServiceRunMaterializeToken(provided, controlToken),
        materializeConnectedServicesForExecutionRun: executionRunConnectedServicesBridge.materialize,
        checkConnectedServicesGenerationForExecutionRun: async ({ runId, runnerPid }) => {
            const target = connectedServiceRuntimeRegistry.getRunTargetByRunKey(runId);
            if (!target || target.pid !== runnerPid || target.materializationKey !== runId) {
                return { ok: true as const, current: false };
            }
            let projection = latestConnectedServiceProjectionSnapshot;
            if (!projection) {
                try {
                    projection = await fetchConnectedServiceProjectionSnapshot();
                } catch {
                    return { ok: true as const, current: false };
                }
            }
            const currentTarget =
                connectedServiceRuntimeRegistry.getRunTargetByRunKey(runId);
            if (
                currentTarget !== target
                || currentTarget.pid !== runnerPid
                || currentTarget.materializationKey !== runId
            ) {
                return { ok: true as const, current: false };
            }
            return {
                ok: true as const,
                current: isExecutionRunConnectedServiceGenerationCurrent({ runId, target, projection }),
            };
        },
        releaseConnectedServicesForExecutionRun: executionRunConnectedServicesBridge.release,
    });
    connectedAccountRequestAuthHttpPort = controlPort;
    if (startupManagedProviderRecoveryCandidates.length > 0) {
        void recoverStartupManagedProviderCandidates(controlPort).catch((error: unknown) => {
            logger.debug(
                '[DAEMON RUN] Managed Provider startup recovery failed',
                serializeAxiosErrorForLog(error),
            );
        });
    }
    await rehydrateLiveExecutionRunTargets({
        markers: listExecutionRunMarkersForRehydration,
        adopt: executionRunConnectedServicesBridge.adoptLiveMaterialization,
        proveRunnerLive: async (marker) => {
            const tracked = params.pidToTrackedSession.get(marker.pid);
            if (!tracked || tracked.happySessionId !== marker.happySessionId) return false;
            return await isSessionRunnerActiveInDaemon({
                sessionId: marker.happySessionId,
                trackedSessions: [tracked],
            });
        },
    }).catch((error) => {
        logger.debug('[DAEMON RUN] Passive execution-run target re-registration failed (non-fatal)', error);
    });
    await recoverReattachedAgentRequestAuth();
    void Promise.allSettled(
        connectedServiceRuntimeRegistry.listTargets().map((target) => (
            scheduleRuntimeTargetGenerationReconciliation(target)
        )),
    ).then((outcomes) => {
        for (const outcome of outcomes) {
            if (outcome.status === 'rejected') {
                logger.debug('[DAEMON RUN] Failed to reconcile connected-service provider adoption after daemon replacement', {
                    error: serializeAxiosErrorForLog(outcome.reason),
                });
            }
        }
    });
    const stopControlServerWithConnectedServiceDeferralCleanup = async (): Promise<void> => {
        await externalSessionHostOperationOwner.retire();
        await disposeControlRuntimeResources();
        await stopControlServer();
    };

    // Fix-activation lag closeout: when this daemon generation comes up (the dist-guard restarts the
    // daemon on a dist-closure fingerprint change, already gated on stack-side quiescence), roll any
    // runners still serving a STALE code generation onto the current dist. Reuses the existing
    // version/entrypoint-aware `if_stale` rollout (the same owner + adopt-first restart the manual
    // `handleSessionRunnerRestartAll` RPC uses) — runners already on the current entrypoint are
    // skipped (`already_current`), busy runners are skipped by the activity gate and re-checked on a
    // bounded re-arm, and every respawn routes through the adopt-first owner (relay reconstructed; the
    // healthy claude is never relaunched). Automatic rollout is hard-disabled until a reviewed
    // current-generation action owner exists. startDaemon still starts the inert scheduler after
    // reattach so this composition cannot bypass the canonical config owner.
    const reconcileConnectedServicesProjection = async (
        notification: ConnectedServicesProjectionNotification,
    ): Promise<void> => {
        notification.signal.throwIfAborted();
        const projectionSnapshot = parseConnectedServiceProjectionSnapshot({
            connectedServicesV2: notification.connectedServicesV2,
            connectedServiceCredentialRevisionsV1: notification.connectedServiceCredentialRevisionsV1,
        });
        notification.signal.throwIfAborted();
        await publishObservedConnectedServiceProjectionThenApply({
            projection: projectionSnapshot,
            publishObserved: replaceConnectedServiceProjectionSnapshot,
            applyToRuntime: async () => {
                await Promise.all(connectedServiceRuntimeRegistry.listTargets().map(async (target) => {
                    await scheduleRuntimeTargetGenerationReconciliation(target);
                }));
                notification.signal.throwIfAborted();
                await reconcileConnectedServiceDirectCredentialRevisions({
                    credentialRevisions: projectionSnapshot.credentialRevisions,
                    resolveCredentialPresence: projectionSnapshot.resolveCredentialPresence,
                    listRuntimeTargets: () => connectedServiceRuntimeRegistry.listTargets()
                        .filter((target) => connectedServiceRuntimeRegistry.isRunTarget(target))
                        .map(runtimeGenerationTarget),
                    applyLiveCredentialRevision: async (input) => {
                        await applyConnectedServiceProjectionCredentialUpdate({
                            input,
                            listRuntimeTargets: () => connectedServiceRuntimeRegistry.listRefreshTargets(),
                            stopSession,
                            getRefreshCoordinator: params.getConnectedServiceRefreshCoordinator,
                        });
                    },
                    executionAuthority: notification.executionAuthority,
                    signal: notification.signal,
                });
                notification.signal.throwIfAborted();
            },
        });
    };
    return {
        spawnSession: spawnSessionForInternalResume,
        stopSession,
        isSessionAlreadyRunning,
        onChildExited,
        controlPort,
        controlToken,
        stopControlServer: stopControlServerWithConnectedServiceDeferralCleanup,
        // K2: FSM-routed proactive quota pre-turn switch coordinator (consumed by the quotas
        // coordinator via startDaemonRuntimeBootstrap — replaces the old raw-signal coordinator).
        connectedServiceAuthGroupPreTurnSwitchCoordinator,
        connectedServicePredictiveSwitchGuard,
        connectedServiceRuntimeAuthApplyCapabilityResolver: resolveRuntimeAuthApplyCapabilityForInput,
        consumeCommittedAuthGroupGeneration: async (input: Parameters<ConnectedServiceAuthGroupGenerationConsumer['consume']>[0]) =>
            await createDurableGenerationConsumer({
                allowProviderInputAdmissionWrites: input.executionAuthority !== 'passive_projection',
            }).consume(input),
        // K3: gated credential-refresh / reconnect restart adapter (turn-deferral + reachability).
        requestConnectedServiceRefreshRestartSignal,
        cancelConnectedServiceRuntimeAuthRecovery: async ({ sessionId, attemptId }) =>
            await runtimeAuthRecoveryScheduler.cancelExact({ sessionId, attemptId }),
        retryTemporaryThrottleNow: async ({ sessionId }) =>
            await temporaryThrottleScheduler.wake({ sessionId, reason: 'manual' }),
        reconcileConnectedServicesProjection,
        awaitAgentSessionOpen:
            agentRuntimeSessionBridge.awaitAgentSessionOpen,
        installExternalSessionHostOperations: (operations) =>
            externalSessionHostOperationOwner.install(operations),
        providerAccountUsageStore,
        // K2: the single runtime quota-snapshot store shared by the reactive coordinator, the
        // proactive pre-turn coordinator, and (via bootstrap) the quotas coordinator + in-band
        // recorder — so the proactive selection sees the same probed snapshots (matches the
        // single-store design of the monolithic reference).
        connectedServiceRuntimeQuotaSnapshots,
        createAgentCatalogObservation: (
            infrastructure: Pick<
                Parameters<typeof createAgentProviderCatalogObservationService>[0],
                'client' | 'scheduler'
            >,
        ) => createAgentProviderCatalogObservationService({
            ...infrastructure,
            activatePurposeBindings: params.activatePurposeBindings ?? (() => {
                throw new Error('connected_account_purpose_binding_owner_unavailable');
            }),
            requestAuth: {
                lookupRequestAuth: async (input) => {
                    await ensureCurrentProjectionForRequestAuth();
                    return await connectedAccountRequestAuthService.lookupRequestAuth(input);
                },
                refreshAfterAuthFailure: async (input) => {
                    await ensureCurrentProjectionForRequestAuth();
                    return await connectedAccountRequestAuthService.refreshAfterAuthFailure(input);
                },
            },
            createRedactionLease: () => createProviderRedactionLease({ values: [] }),
        }),
        refreshBrowserRouteOwners,
        // BRW-6: daemon-side on-disk browser storage purge entrypoints. The daemon's
        // session-deleted signal and logout transition drive these to remove session/ephemeral
        // profile + partition bytes (fail-closed; failed purge marks the profile unusable).
        purgeBrowserStorageForSessionDeleted,
        purgeBrowserStorageForLogout,
    };
}

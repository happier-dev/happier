import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { ApiMachineClient, ConnectedServicesProjectionNotification } from '@/api/apiMachine';
import type { Metadata, SessionCreationOutcome } from '@/api/types';
import { fetchAccountProfile } from '@/api/accountProfile';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { configuration } from '@/configuration';
import { getSessionNotificationTitle } from '@/agent/runtime/notifications/sessionNotificationContext';
import {
    getActiveAccountSettingsSnapshot,
    resolveActiveAccountSettingsSnapshotRevision,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { logger } from '@/ui/logger';
import {
    resolveConnectedServiceCredentialResolutions,
} from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type {
    QualifiedConnectedAccountPeerOperationTransport,
} from '@/api/client/qualifiedConnectedAccountApi';
import {
    listQualifiedConnectedAccountsV4,
    readQualifiedConnectedAccountGroupV4,
} from '@/api/client/qualifiedConnectedAccountApi';
import { resolveConcreteBackendTargetRefV2 } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import {
    ConnectedServiceBindingsV1Schema,
    ConnectedAccountServiceKeySchema,
    ConnectedServiceIdSchema,
    DEFAULT_LOCAL_SERVICE_PAGE_TITLE_CONCURRENCY,
    DEFAULT_LOCAL_SERVICE_PAGE_TITLE_FAILURE_TTL_MS,
    DEFAULT_LOCAL_SERVICE_PAGE_TITLE_MAX_BODY_BYTES,
    DEFAULT_LOCAL_SERVICE_PAGE_TITLE_SUCCESS_TTL_MS,
    DEFAULT_LOCAL_SERVICE_PAGE_TITLE_TIMEOUT_MS,
    parseBooleanEnv,
    projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1,
    readConnectedServiceMaterializationIdentityV1FromMetadata,
    readBuiltInLegacyConnectedAccountServiceKeyIngress,
    resolveConnectedServicesProviderStateSharingPolicyV1,
    writeProviderAccountUsageRecordIdToMetadata,
    writeConnectedServiceMaterializationIdentityV1ToMetadata,
    assessProviderEndpoint,
    type AccountSettings,
    type ConnectedAccountServiceKey,
    type ConnectedServiceBindingsV1,
    type ConnectedServiceCredentialRevisionV1,
    type ConnectedServiceExecutionAuthorityV1,
    type ConnectedServiceId,
    type ConnectedServiceMaterializationIdentityV1,
    type ConnectedServiceUsageSourceV1,
    type ProviderAccountUsageSnapshotV1,
    type MachineSessionTerminalAuthorityV1,
    type QualifiedConnectedAccountServiceRef,
    type SessionConnectedServiceAuthReadRuntimeIdentityResponseV1,
    type ProviderAccountUsageRecordId,
    type ProviderRuntimeBindingBasisV1,
    type RequestAuthFailureOutcomeV1,
    type RuntimeDescriptorV1,
    type SessionContinuationResumePromptModeV1,
    type SessionRunnerRestartDisabledReason,
} from '@happier-dev/protocol';
import { resolveRoutedUsageLimitRecoveryResumePromptMode } from '@/session/usageLimitRecoveryControls/resolveRoutedUsageLimitRecoveryResumePromptMode';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotAvailableError } from '@happier-dev/protocol/rpcErrors';
import {
    PluginUiArtifactDigestV1Schema,
    verifyPluginUiArtifactFileSetIntegrityV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    resolveAgentIdFromSessionMetadata,
    resolveVendorResumeIdFromSessionMetadata,
    type TerminalHostAdapter,
} from '@happier-dev/agents';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import {
    authorizeDaemonSessionModelTransitionProviderTarget,
    authorizeSessionModelTransitionProviderTargetWithLease,
    resolveDaemonSessionModelTransitionAuthority,
} from '@/providers/sessions/authorizeSessionModelTransitionTarget';
import {
    sameProviderRuntimeBindingBasis,
} from '@/providers/sessions/providerAuthorizationApplyPolicy';
import {
    isRetainedManagedProviderSettingsGrantCurrent,
} from '@/providers/sessions/retainedManagedProviderPolicy';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { createCredentialedTargetActionCurrentIntent } from '@/session/actions/createCliActionExecutor';
import { resolveCatalogAgentId } from '@/agent/catalog/resolution';
import {
    findCatalogEntry,
    isLegacyServiceKeyedCompatibilityCatalogAgent,
    readDeclaredCatalogConnectedServiceIds,
} from '@/agent/catalog/registry';
import {
    getConnectedServiceRuntimeAuthAdapter,
    getConnectedServiceStateSharingDescriptor,
    resolveLegacyConnectedServiceRuntimeAuthFailureSourceRevisionThroughCatalog,
    resolveConnectedServiceGenerationApplicationScope,
    resolveConnectedServiceMaterializedHomeRoot,
    resolveConnectedServiceSwitchContinuity,
} from '@/daemon/connectedServices/catalogHooks';
import { resolveConnectedServiceTargetMaterializedRoot } from '@/daemon/connectedServices/materialize/resolveConnectedServiceTargetMaterializedRoot';
import { createConnectedServiceRuntimeAuthNativeHome } from '@/daemon/connectedServices/runtimeAuth/createRuntimeAuthNativeHome';
import type {
    CatalogAgentId,
    ConnectedServiceDaemonAuthBridgeRefresh,
    ConnectedServiceSwitchEffectiveBinding,
} from '@/agent/catalog/types';
import {
    createSessionConnectedServiceAuthTransport,
} from '@/session/runtime/control/transport';
import {
    DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
    createSessionTranscriptFollowLeaseRegistry,
} from '@/api/session/transcriptQueries';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import type { SessionSpawnDirectTargetTransport } from '@/session/actions/createCliActionDeps';
import type {
    ExternalSessionPluginAdmissionOwner,
} from '@/session/actions/externalSessions/pluginExternalSessionAdmissionOwner';
import type { ActionExecutorDeps, RuntimeActionExecute } from '@happier-dev/protocol/actions';
import { createAccountServerPatIntrospector } from '../auth/accountServerPatIntrospector';
import { createDaemonPatVerifier } from '../auth/daemonPatVerifier';
import {
    createDaemonExternalActionContributedApprovalReplay,
    createDaemonExternalActionContributedDefinitionLister,
    createDaemonExternalActionContributedInvoker,
} from '../externalActions/createDaemonExternalActionContributedInvoker';
import { createDaemonExternalActionTargetResolver } from '../externalActions/daemonExternalActionTargetResolver';
import type { ExternalActionIngressOwner } from '@/rpc/handlers/externalAction';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';

import type {
    ConnectedServiceDaemonAuthBridgeRegistration,
} from '../connectedServices/daemonAuthBridgeTypes';
import type { DeviceLocalSecretStorage } from '../deviceLocalSecretStorage';

import { startDaemonControlServer } from '../controlServer';
import { createOnDaemonSessionStartupFailure } from '../sessions/onHappySessionWebhook';
import {
    AgentRuntimeDaemonModelTransitionAuthorizationResultV1Schema,
    AgentRuntimeDaemonTurnContributionsResultV1Schema,
    COMPOSER_STAGED_MEDIA_ADMISSION_SETTLEMENT_FIELD,
} from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import {
    AgentRuntimeDaemonServiceResponseV1Schema,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import {
    RunnerDaemonPluginServiceOperationV1Schema,
} from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import {
    RUNNER_MANAGED_SERVICES_CUSTODY_RPC_METHOD,
    RunnerManagedServicesCustodyResultV1Schema,
    createRunnerManagedServicesClient,
    type RunnerManagedServicesCustodyDispatchV1,
    type RunnerManagedProviderCustodyScopeV1,
} from '@/agent/runtime/session/process/runnerManagedServicesCustody';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import {
    preserveComposerAttachmentSelectionAcrossSessionInputTransformV1,
    validateSessionStructuredInputIngressV1,
} from '@/session/services/admitSessionStructuredInputV1';
import {
    finalizeComposerStagedMediaToSession,
} from '@/session/media/finalizeComposerStagedMediaToSession';
import { prepareComposerAttachmentDraftsForSendV1 } from '@/session/composer/prepareComposerAttachmentDraftsForSendV1';
import { garbageCollectUncommittedSessionMedia } from '@/session/media/garbageCollect';
import { settleComposerStagedMediaAdmissionV1 } from '@/session/media/settleComposerStagedMediaAdmission';
import { createActiveDaemonComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import {
    startPublicManagedProviderRuntime,
} from '@/providers/lifecycle/publicManagedProviderRuntimeStart';
import {
    createProviderLaunchResourceScope,
} from '@/providers/lifecycle/resourceScope';
import { createDaemonShutdownCancellationDomains } from './shutdownCancellationDomains';
import type { DaemonPluginChangeService } from '@/plugins/daemon/changeService';
import {
    resolveConnectedServiceAuthForSpawn,
    type ConnectedServiceQualifiedAuthGroupApi,
} from '../connectedServices/resolveConnectedServiceAuthForSpawn';
import { isValidConnectedServiceRunMaterializeToken } from '../connectedServices/runs/capabilityToken';
import { createExecutionRunConnectedServicesBridge } from '../connectedServices/runs/executionRunMaterialization';
import { isExecutionRunConnectedServiceGenerationCurrent } from '../connectedServices/runs/executionRunGenerationAdmission';
import { rehydrateLiveExecutionRunTargets } from '../connectedServices/runs/rehydrateExecutionRunTargets';
import { createAdoptedExecutionRunRootCleanup } from '../connectedServices/runs/createAdoptedExecutionRunRootCleanup';
import { resolveConnectedServiceMaterializedRootDir } from '../connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';
import {
    clearExecutionRunConnectedServicesCleanupReceipt,
    listExecutionRunMarkersForRehydration,
} from '../executionRunRegistry';
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
    createBrowserContextDiagnosticsSummarySource,
    type BrowserContextDiagnosticsSummarySource,
} from '../browser/context/diagnostics/summary';
import { createSidecarCdpDiagnosticsRuntime } from '../browser/sidecar/diagnostics/runtime';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { createBrowserAutomationDaemonService } from '../browser/automation/service';
import { createBrowserAutomationRuntimeProvisioner } from '../browser/sidecar/provisioning';
import type { ProvisionBrowserAutomationRuntime } from '../browser/actions/runtimeActionExecutor';
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

export type ProviderManagedCatalogRuntimeOwner = Readonly<{
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
import { fetchServerFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
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
import {
    createStopSession,
    type StopSessionOptions,
} from '../sessions/stopSession';
import {
    registerPidSpawnResourceCleanup,
    retireUpstreamAuthorityBeforeProcessStop,
} from '../sessions/cleanupPidSessionResources';
import {
    isTerminalHostPhysicallyRetiredStopResult,
    type StopSessionResult,
} from '../sessions/stopSessionContract';
import { waitForExistingSessionExitIfStopRequested } from '../sessions/waitForExistingSessionExitIfStopRequested';
import { waitForTrackedRunnerProcessesExit } from '../sessions/waitForTrackedRunnerProcessesExit';
import {
    resolveDisconnectedTerminalMode,
    resolveDisconnectedTerminalHostResumeGate,
    superviseDisconnectedTerminalHostCandidate,
    type DisconnectedTerminalHostCandidate,
    type DisconnectedTerminalHostSupervisionResult,
} from '../sessions/disconnectedTerminalHostSupervision';
import { createDisconnectedTerminalHostResumeLifecycle } from './disconnectedTerminalHostResumeLifecycle';
import { resolveTrackedSessionCatalogAgentId } from '../sessions/resolveTrackedSessionCatalogAgentId';
import {
    clearSessionMarkerConnectedServiceRestartIntent,
    readSessionMarkerForPid,
    removeSessionMarker,
    removeSessionMarkerIfOwned,
    updateSessionMarkerActiveTurn,
} from '../sessionRegistry';
import {
    promoteForegroundDaemonServiceAuthority,
} from '../agentRuntime/promoteForegroundDaemonServiceAuthority';
import {
    readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker,
    removeAgentRuntimeDaemonServiceAuthorityIfOwned,
    type AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
} from '../agentRuntime/sessionBridgeAuthorization';
import {
    refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority,
} from '../agentRuntime/refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority';
import {
    awaitTrackedRunnerAgentSessionOpen,
    recordTrackedRunnerAgentSessionOpenAttestation,
} from '../agentRuntime/runnerAgentSessionOpenAttestation';
import {
    authorizeRunnerAgentNewTurn,
} from '../agentRuntime/runnerAgentTurnAdmission';
import {
    createRunnerAgentDaemonFacetService,
} from '../agentRuntime/runnerAgentDaemonFacetService';
import {
    createRunnerDaemonPluginServicesHost,
    type RunnerDaemonCurrentGlobalActionExecutor,
    type RunnerDaemonCurrentGlobalExternalSessionsOwner,
    type RunnerDaemonCurrentGlobalMcpOwner,
} from '../agentRuntime/runnerDaemonPluginServicesHost';
import {
    materializeRunnerManagedProviderAgentBinding,
} from '../agentRuntime/materializeRunnerManagedProviderAgentBinding';
import {
    authorizeTrackedRunnerAgentDaemonServiceOperation,
} from '../agentRuntime/authorizeTrackedRunnerAgentDaemonServiceOperation';
import {
    RunnerAgentDaemonFacetOperationV1Schema,
} from '@/agent/runtime/session/process/agentRuntimeDaemonFacetProtocol';
import {
    resolveRetainedAgentSessionRealtimeVoiceAuthority,
    snapshotAgentSessionRealtimeVoiceProviders,
} from '@/agent/runtime/session/realtime/resolveAgentSessionRealtimeVoiceAuthority';
import {
    resolveAgentCompositionThroughRuntimeRegistry,
    resolvePluginToolPromptContributionsThroughRuntimeRegistry,
    transformAgentContextThroughPluginRuntimeRegistry,
    transformAgentRequestThroughRuntimeRegistry,
    transformSessionInputThroughRuntimeRegistry,
} from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';
import {
    verifyRunnerAgentBindingAgainstGeneration,
} from '@/plugins/runtime/runner/loadRetainedAgentRuntimeLeaf';
import {
    projectManifestAgentContribution,
} from '@/plugins/projection/registry/projectManifestAgentContribution';
import {
    readLeasedAgentProviderBindingAdapter,
} from '@/plugins/runtime/providerBindings/adapter';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
    readCurrentPluginHardRevocationRevision,
    readCurrentPluginImmutableGenerationIntegrityCurrentness,
} from '@/plugins/store/registry/generationStore';
import { BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS } from '@/plugins/projection/registry/sources/generatedBundledPluginArtifacts';
import {
    isPluginRunningSessionDispositionTarget,
} from '@/plugins/runtime/reload/controller';
import {
    createManagedServiceDurabilityOwner,
    observeManagedServiceProcessStartIdentity,
    type ManagedServiceDurabilityOwner,
} from '@/plugins/runtime/invocation/services/managedServiceDurability';
import type {
    ManagedServiceSessionBaseUrlResolver,
} from '@/plugins/runtime/invocation/services/managedServiceEndpointProjection';
import {
    executeRunnerManagedServiceEndpointProjectionBridgeOperation,
} from '@/plugins/runtime/invocation/services/runnerManagedServiceEndpointProjectionBridge';
import {
    createDaemonManagedServiceEndpointReadOwner,
} from '@/plugins/runtime/invocation/services/daemonManagedServiceEndpointReadOwner';
import {
    authorizeRunnerManagedProviderServerSupervision,
    authorizeRunnerManagedServiceSupervision,
    projectRunnerManagedProviderServerLaunchAuthority,
    type RunnerManagedProviderServerLaunchAuthority,
} from '@/plugins/runtime/invocation/services/runnerManagedServiceSupervisionAuthorization';
import {
    resolveRunnerManagedServiceDeclaredSecret,
} from '@/plugins/runtime/invocation/services/runnerManagedServiceDeclaredSecretAuthority';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import type {
    ManagedServiceSpec,
} from '@happier-dev/plugin-sdk/managed-services';
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
import { resolveSessionMachineWorkspacePath } from '@/session/machineControlLocality';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { readTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';
import {
    cancelLatestUsageLimitRecoveryInMetadataAfterExplicitStop,
    persistUsageLimitRecoveryFieldDurably,
} from '@/session/usageLimitRecoveryControls/persistUsageLimitRecoveryFieldDurably';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { executeSpawnSessionRequest } from './executeSpawnSessionRequest';
import { refreshAccountSettingsForDaemonRequest } from './accountSettingsFreshness';
import { createSpawnConcurrencyGate } from '../spawn/createSpawnConcurrencyGate';
import { createForegroundAgentRuntimeAdmissionOwner } from '../agentRuntime/foregroundAdmission';
import {
    createExternalSessionHostOperationOwner,
    type ExternalSessionHostOperationOwner,
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
    ConnectedAccountRequestAuthError,
    createConnectedAccountRequestAuthService,
    type ConnectedAccountRequestAuthResolvedBinding,
} from '../connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import {
    createConnectedAccountRequestAuthSubjectRegistry,
    type ConnectedAccountRequestAuthSubjectRegistry,
} from '../connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import {
    inspectConnectedAccountRequestAuthCapabilityFile,
    type ConnectedAccountRequestAuthCapabilityDescriptor,
} from '../connectedServices/requestAuth/capabilityFile';
import {
    resolveQualifiedPurposeBindingSnapshotForAgentSpawn,
    resolveQualifiedRequestAuthPurposeBindingsFromSnapshot,
} from '../connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import {
    scopeConnectedAccountSessionPurposeBindingLease,
    type ConnectedAccountPurposeBindingOwner,
} from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import {
    resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/agents/request-auth';
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
import {
    resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey,
    resolveFirstPartyQualifiedConnectedAccountServiceForLegacyServiceInput,
    resolveQualifiedConnectedAccountServiceForIngressServiceId,
} from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
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
import { createProviderAccountUsagePersistenceScheduler } from '../connectedServices/accountUsage/persistence';
import {
    recordProviderAccountUsageAdoptionForSession,
    recordProviderAccountUsageSnapshotForSession,
} from '../connectedServices/accountUsage/recordProviderAccountUsageSnapshotForSession';
import type {
    QualifiedProviderAccountUsagePersistenceTarget,
} from '../connectedServices/accountUsage/persistence';
import {
    createProviderAccountUsageStore,
    isProviderAccountUsageStoreMutationAccepted,
    type ProviderAccountUsageStore,
} from '../connectedServices/accountUsage/store';
import { ConnectedServiceRuntimeAuthSwitchAttemptTracker } from '../connectedServices/runtimeAuth/ConnectedServiceRuntimeAuthSwitchAttemptTracker';
import { buildConnectedServiceRuntimeAuthSwitchAttemptLogContext } from '../connectedServices/runtimeAuth/buildConnectedServiceRuntimeAuthSwitchAttemptLogContext';
import { commitConnectedServiceAccountSwitchSessionEvent } from '../connectedServices/runtimeAuth/commitConnectedServiceAccountSwitchSessionEvent';
import type { DaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import {
    buildRuntimeAuthRecoveryAttemptTransitionLocalId,
} from '../connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoveryProjection';
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
import { resolveRuntimeAuthFailureSourceProfile } from '../connectedServices/runtimeAuth/resolveRuntimeAuthFailureSourceProfile';
import { readConnectedServiceCredentialProviderAccountId } from '../connectedServices/shared/connectedServiceCredentialRecord';
import { resolveProviderAccountUsageSourceProfile } from '../connectedServices/accountUsage/resolveProviderAccountUsageSourceProfile';
import { createConnectedServiceSessionAuthSwitchCore } from '../connectedServices/runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { shouldCommitAutomaticGroupApplySessionEvent } from '../connectedServices/runtimeAuth/automaticGroupApplySessionEvents';
import {
    type RuntimeAuthRecoveryDiagnostic,
    type RuntimeAuthRecoveryVisibleEventDelivery,
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
import {
    CONNECTED_SERVICE_TURN_LIFECYCLE_SOURCE_CUTOVER_BLOCK,
    connectedServiceTurnLifecycleContinue,
} from '../connectedServices/connectedServiceTurnLifecycleContract';
import { requestPlannedRunnerRestart } from '../plannedRunnerRestart/requestPlannedRunnerRestart';
import { createVersionRuntimeRefreshAttemptHandoff } from '../plannedRunnerRestart/versionRuntimeRefreshAttemptHandoff';
import type {
    PlannedRunnerRestartNotSignaledReason,
    PlannedRunnerRestartSignalGateResult,
    RestartSessionRunnerResult,
} from '../plannedRunnerRestart/types';
import {
    captureRunnerRestartIdentityWitness,
    summarizeSessionRunnerEndpoint,
    restartAllSessionRunnersOnCurrentRuntime,
    restartSessionRunnerForRequestAuthSourceCutover,
    restartSessionRunnerOnCurrentRuntime,
    type RestartSessionRunnerCompletion,
} from '../plannedRunnerRestart/restartSessionRunnerOnCurrentRuntime';
import {
    resolveRequestAuthSourceCutoverRequirement,
    type RequestAuthSourceCutoverRequirement,
} from '../plannedRunnerRestart/requestAuthSourceCutover';
import {
    resolveCurrentSessionRunnerLaunchIdentity,
    resolveSessionRunnerEntrypointIdentityFromProcessCommand,
} from '../sessionRunnerRuntime/resolveRunnerEntrypointIdentity';
import { resolveSessionRunnerRuntimeState } from '../sessionRunnerRuntime/resolveRuntimeState';
import { resolveSessionRunnerRuntimeStatusV2 } from '../sessionRunnerRuntime/resolveRuntimeStatusV2';
import {
    resolveAuthoritativeTrackedRunnerAgentRuntimeCurrentness,
} from '../sessionRunnerRuntime/resolveAgentRuntimeCurrentness';
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
import { recoverStrandedTerminalControlServiceability } from '../sessions/recoverStrandedTerminalControlServiceability';
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
type ConnectedServicePreTurnSwitchCoordinator = NonNullable<
    Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['authGroupSwitchCoordinator']
>;
type ConnectedServicePreTurnSwitchInput = Parameters<
    ConnectedServicePreTurnSwitchCoordinator['switchBeforeTurn']
>[0];
type ConnectedServicePreTurnSwitchResult = Awaited<ReturnType<
    ConnectedServicePreTurnSwitchCoordinator['switchBeforeTurn']
>>;

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
    const digest = PluginUiArtifactDigestV1Schema.safeParse(input.digest);
    if (!digest.success) {
        return { ok: false, reasonCode: 'digest_invalid' };
    }
    const result = verifyPluginUiArtifactFileSetIntegrityV1({
        files: input.files,
        integrity: {
            digest: digest.data,
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
    serviceId: ConnectedAccountServiceKey;
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
    for (const [serviceIdRaw, binding] of Object.entries(input.bindings.bindingsByServiceId)) {
        if (binding.source !== 'connected') continue;
        const serviceId = ConnectedAccountServiceKeySchema.safeParse(serviceIdRaw);
        if (!serviceId.success) continue;
        return {
            trigger: 'manual_switch',
            sessionId: input.sessionId,
            agentId: input.agentId,
            serviceId: serviceId.data,
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
    const serviceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(
        input.serviceId,
    );
    if (!serviceId) {
        throw new Error('connected_service_switch_target_service_id_invalid');
    }
    return {
        serviceId,
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

function resolveConnectedServiceMaterializationIdentityFromTrackedSession(
    tracked: TrackedSession | null | undefined,
): ConnectedServiceMaterializationIdentityV1 | null {
    return readConnectedServiceMaterializationIdentityFromSpawnOptions(tracked?.spawnOptions ?? null)
        ?? readConnectedServiceMaterializationIdentityFromEnvironment(
            tracked?.spawnOptions?.environmentVariables ?? null,
        );
}

function resolveOwnedRetainedDevRequestAuthCapabilityPaths(input: Readonly<{
    tracked: TrackedSession;
    agentId: CatalogAgentId;
    bindings: ConnectedServiceBindingsV1;
}>): readonly string[] {
    const childSelections =
        readConnectedServiceChildSelectionsFromEnv(
            input.tracked.spawnOptions?.environmentVariables ?? {},
        );
    const paths = new Set<string>();
    for (
        const [serviceIdRaw, binding]
        of Object.entries(
            input.bindings.bindingsByServiceId,
        )
    ) {
        if (binding.source !== 'connected') continue;
        const serviceId = serviceIdRaw as ConnectedServiceId;
        const childSelection =
            childSelections?.get(serviceId) ?? null;
        const selection =
            binding.selection === 'profile'
                ? {
                    kind: 'profile' as const,
                    serviceId,
                    profileId: binding.profileId,
                }
                : childSelection?.kind === 'group'
                    && childSelection.groupId
                        === binding.groupId
                    ? childSelection
                    : null;
        if (!selection) continue;
        const profileId = selection.kind === 'profile'
            ? selection.profileId
            : selection.activeProfileId;
        const materializedRoot =
            resolveConnectedServiceMaterializedHomeRoot(
                input.agentId,
                {
                    activeServerDir:
                        configuration.activeServerDir,
                    serviceId,
                    profileId,
                    selection,
                },
            );
        if (!materializedRoot) continue;
        paths.add(
            resolveConnectedAccountRequestAuthCapabilityPath(
                materializedRoot,
            ),
        );
    }
    return [...paths];
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
    logger.debug('[DAEMON RUN] Connected-service session auth switch result', {
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
    serviceId: ConnectedAccountServiceKey;
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

async function repairMissingConnectedServiceMaterializationIdentityForSpawn(input: Readonly<{
    token: string;
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    sessionId: string;
    agentId: CatalogAgentId;
    connectedServices: ConnectedServiceBindingsV1;
    vendorResumeId: string | null;
}>): Promise<Readonly<{
    identity: ConnectedServiceMaterializationIdentityV1;
    persistAfterMaterialization: () => Promise<void>;
}> | null> {
    const vendorResumeId = normalizeOptionalString(input.vendorResumeId);
    if (!vendorResumeId) return null;

    const hasConnectedBinding = Object.values(
        input.connectedServices.bindingsByServiceId,
    ).some((binding) => binding.source === 'connected');
    if (!hasConnectedBinding) return null;

    const connectedServiceMaterializationIdentityV1 = generateConnectedServiceMaterializationIdentityV1();
    return {
        identity: connectedServiceMaterializationIdentityV1,
        persistAfterMaterialization: async () => {
            await persistSessionConnectedServiceBindings({
                token: input.token,
                credentials: input.credentials,
                sessionId: input.sessionId,
                normalizedBindings: input.connectedServices,
                connectedServiceMaterializationIdentityV1,
            });
        },
    };
}

export async function resolveContinuationResumePromptMode(input: Readonly<{
    serviceId?: ConnectedAccountServiceKey;
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

type ContinueAfterRuntimeAuthSwitch = (input: Readonly<{
    sessionId: string;
    attemptId: string;
    action: 'hot_applied' | 'restart_requested';
    switchReason?: ConnectedServiceSessionAuthSwitchReason;
}>) => Promise<void>;

type ReconcileCurrentRuntimeAuthTarget = (input: Readonly<{
    sessionId: string;
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
}>) => Promise<boolean>;

export async function continueAfterSupersededRuntimeAuthFailure(input: Readonly<{
    result: unknown;
    sessionId: string;
    interruptedOriginId?: string | null;
    continueAfterRuntimeAuthSwitch: ContinueAfterRuntimeAuthSwitch;
    reconcileCurrentRuntimeAuthTarget?: ReconcileCurrentRuntimeAuthTarget;
}>): Promise<boolean> {
    if (
        !input.result
        || typeof input.result !== 'object'
        || !('status' in input.result)
        || input.result.status !== 'recovery_superseded'
        || !('reason' in input.result)
        || (
            input.result.reason !== 'source_tuple_unavailable'
            && input.result.reason !== 'source_tuple_mismatch'
        )
    ) {
        return false;
    }
    const interruptedOriginId = input.interruptedOriginId?.trim() ?? '';
    let currentTargetSettled = false;
    if (
        input.reconcileCurrentRuntimeAuthTarget
        && 'serviceId' in input.result
        && 'groupId' in input.result
        && typeof input.result.serviceId === 'string'
        && typeof input.result.groupId === 'string'
    ) {
        const serviceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(input.result.serviceId);
        const groupId = input.result.groupId.trim();
        if (serviceId && groupId) {
            currentTargetSettled = await input.reconcileCurrentRuntimeAuthTarget({
                sessionId: input.sessionId,
                serviceId,
                groupId,
            });
        }
    }
    if (currentTargetSettled && interruptedOriginId) {
        await input.continueAfterRuntimeAuthSwitch({
            sessionId: input.sessionId,
            attemptId: interruptedOriginId,
            action: 'hot_applied',
        });
    }
    return true;
}

export async function settleSupersedingRuntimeAuthGenerationForSource(input: Readonly<{
    recovery: unknown;
    serviceId: ConnectedAccountServiceKey;
    groupId: string;
    sessionId: string;
    fromProfileId: string | null;
    consumeCommittedAuthGroupGeneration: (
        consumeInput: Parameters<ConnectedServiceAuthGroupGenerationConsumer['consume']>[0],
    ) => Promise<Pick<Awaited<ReturnType<ConnectedServiceAuthGroupGenerationConsumer['consume']>>, 'outcome'>>;
}>): Promise<void> {
    const resolved = resolveCommittedGenerationFromRuntimeAuthRecovery({
        serviceId: input.serviceId,
        groupId: input.groupId,
        recovery: input.recovery,
        provenance: 'runtime_failure',
    });
    if (!resolved?.sourceRequiresConvergence) {
        throw Object.assign(
            new Error('connected_service_runtime_auth_superseding_generation_target_unavailable'),
            {
                code: 'connected_service_runtime_auth_superseding_generation_target_unavailable',
                retryable: true,
            },
        );
    }
    const consumption = await input.consumeCommittedAuthGroupGeneration({
        committedGeneration: resolved.committedGeneration,
        switchReason: 'automatic_runtime_failure',
        sessions: [{
            sessionId: input.sessionId,
            activity: 'live',
            fromProfileId: input.fromProfileId,
        }],
        executionAuthority: 'runtime_recovery',
    });
    if (consumption.outcome !== 'adopted_current') {
        throw Object.assign(
            new Error('connected_service_runtime_auth_superseding_generation_not_acknowledged'),
            {
                code: 'connected_service_runtime_auth_superseding_generation_not_acknowledged',
                retryable: true,
                outcome: consumption.outcome,
            },
        );
    }
}

export async function isRetainedManagedProviderInvocationCurrent(
    input: Readonly<{
        readsRetainedAuthorityCurrent(): boolean;
        revalidatePolicy(): Promise<boolean>;
        fenceRetainedPolicy(): Promise<void>;
        readHardRevocationRevision(): Promise<number>;
        readGenerationIntegrityCurrentness(): Promise<boolean>;
        hardRevocationRevisionAtAdmission: number;
    }>,
): Promise<boolean> {
    try {
        if (!input.readsRetainedAuthorityCurrent()) return false;
        let policyCurrent = false;
        try {
            policyCurrent = await input.revalidatePolicy() === true;
        } catch {
            if (!input.readsRetainedAuthorityCurrent()) return false;
            await input.fenceRetainedPolicy();
            return false;
        }
        if (!policyCurrent) {
            if (!input.readsRetainedAuthorityCurrent()) return false;
            await input.fenceRetainedPolicy();
            return false;
        }
        if (!input.readsRetainedAuthorityCurrent()) return false;
        const hardRevocationRevision =
            await input.readHardRevocationRevision();
        if (
            hardRevocationRevision
                !== input.hardRevocationRevisionAtAdmission
            || await input.readGenerationIntegrityCurrentness()
                !== true
        ) {
            return false;
        }
        if (
            await input.readHardRevocationRevision()
            !== input.hardRevocationRevisionAtAdmission
        ) {
            return false;
        }
        return input.readsRetainedAuthorityCurrent();
    } catch {
        return false;
    }
}

export async function isManagedProviderSessionInvocationCurrent(
    input: Readonly<{
        adoptionCommitted(): boolean;
        revalidateInitialPolicy(): Promise<boolean>;
        readsRetainedAuthorityCurrent(): boolean;
        revalidateRetainedPolicy(): Promise<boolean>;
        fenceRetainedPolicy(): Promise<void>;
        readHardRevocationRevision(): Promise<number>;
        readGenerationIntegrityCurrentness(): Promise<boolean>;
        hardRevocationRevisionAtAdmission: number;
    }>,
): Promise<boolean> {
    if (!input.adoptionCommitted()) {
        try {
            return await input.revalidateInitialPolicy() === true
                && !input.adoptionCommitted();
        } catch {
            return false;
        }
    }
    return await isRetainedManagedProviderInvocationCurrent({
        readsRetainedAuthorityCurrent:
            input.readsRetainedAuthorityCurrent,
        revalidatePolicy:
            input.revalidateRetainedPolicy,
        fenceRetainedPolicy:
            input.fenceRetainedPolicy,
        readHardRevocationRevision:
            input.readHardRevocationRevision,
        readGenerationIntegrityCurrentness:
            input.readGenerationIntegrityCurrentness,
        hardRevocationRevisionAtAdmission:
            input.hardRevocationRevisionAtAdmission,
    });
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
        sessionId: string;
        attemptId: string;
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

function createSelectionPostSwitchRecoveryHandler() {
    return async (input: Readonly<{
        tracked: TrackedSession;
        sessionId: string;
        normalizedBindings: ConnectedServiceBindingsV1;
        serviceIds: ReadonlySet<ConnectedServiceId>;
        action: 'hot_applied' | 'restart_requested';
        runtimeAuthSelectionsByServiceId?: ReadonlyMap<ConnectedServiceId, unknown>;
    }>) => {
        return await runSelectionPostSwitchRecovery({
            ...input,
            runtimeAuthSelectionsByServiceId: input.runtimeAuthSelectionsByServiceId,
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
    serviceId: ConnectedAccountServiceKey;
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
    runtimeDescriptorV1?: RuntimeDescriptorV1 | null;
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
            runtimeDescriptorV1: input.runtimeDescriptorV1 ?? null,
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
    accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
}>): Record<string, unknown> | null {
    return tryDecryptSessionOwnerMetadataView({
        credentials: input.credentials,
        accountEncryptionMode: input.accountEncryptionMode,
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
    const [rawSession, accountEncryptionCurrentness] = await Promise.all([
        fetchSessionByIdCompat({
            token,
            sessionId: input.sessionId,
        }).catch(() => null),
        fetchAccountEncryptionCurrentness({ token }),
    ]);
    if (!rawSession) return null;
    return tryReadSessionMetadataRecord({
        rawSession,
        credentials: input.credentials,
        accountEncryptionMode: accountEncryptionCurrentness.mode,
    });
}

async function persistExplicitSessionStopUsageLimitRecoveryCancellation(input: Readonly<{
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    sessionId: string;
    mutationCustody: Pick<DaemonSessionMutationCustody, 'stage'>;
}>): Promise<void> {
    const token = input.credentials.token.trim();
    if (!token) return;
    const [rawSession, accountEncryptionCurrentness] = await Promise.all([
        fetchSessionByIdCompat({ token, sessionId: input.sessionId }),
        fetchAccountEncryptionCurrentness({ token }),
    ]);
    if (!rawSession || rawSession.id !== input.sessionId) return;
    const currentMetadata = tryReadSessionMetadataRecord({
        rawSession,
        credentials: input.credentials,
        accountEncryptionMode: accountEncryptionCurrentness.mode,
    });
    if (!currentMetadata) return;
    const nextMetadata = cancelLatestUsageLimitRecoveryInMetadataAfterExplicitStop(currentMetadata);
    if (nextMetadata === currentMetadata) return;
    await persistUsageLimitRecoveryFieldDurably({
        sessionId: input.sessionId,
        currentMetadata,
        nextMetadata,
        mode: 'cancel',
        stageUsageLimitRecoveryMutation: async (mutation) => {
            await input.mutationCustody.stage({ mutation, rawSession });
        },
    });
}

async function resolveInactiveConnectedServiceSessionContext(input: Readonly<{
    token: string;
    credentials: Parameters<typeof updateSessionMetadataWithRetry>[0]['credentials'];
    sessionId: string;
    currentMachineId: string;
}>): Promise<Readonly<{
    /** Absent when the Session declares no Agent this daemon has installed. */
    agentId: CatalogAgentId | null;
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
    const [rawSession, accountEncryptionCurrentness] = await Promise.all([
        fetchSessionByIdCompat({
            token: input.token,
            sessionId: input.sessionId,
        }),
        fetchAccountEncryptionCurrentness({ token: input.token }),
    ]);
    const metadata = rawSession
        ? tryReadSessionMetadataRecord({
            rawSession,
            credentials: input.credentials,
            accountEncryptionMode: accountEncryptionCurrentness.mode,
        })
        : null;
    if (!metadata) return null;
    const agentId = resolveCatalogAgentId(resolveAgentIdFromSessionMetadata(metadata));
    const materializationIdentity = readConnectedServiceMaterializationIdentityFromMetadata(metadata);
    const vendorResumeId = agentId
        ? resolveVendorResumeIdFromSessionMetadata(agentId, metadata)
        : null;
    const cwd = resolveSessionMachineWorkspacePath({
        metadata,
        currentMachineId: input.currentMachineId,
        candidatePath: metadata.path,
    });
    return {
        agentId,
        connectedServices: readConnectedServiceBindingsOrEmpty(metadata.connectedServices),
        ...(materializationIdentity
            ? { connectedServiceMaterializationIdentityV1: materializationIdentity }
            : {}),
        ...(vendorResumeId ? { vendorResumeId } : {}),
        ...(cwd ? { cwd } : {}),
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

    const agentId = resolveAgentIdFromSessionMetadata(metadata);
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
            resolutionMode: 'retained_live_process',
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

    const agentId = resolveAgentIdFromSessionMetadata(metadata);
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
        /**
         * Account identity resolved from this daemon's authenticated lifecycle.
         * Without it the public Action route is deliberately not mounted.
         */
        externalActionAccountId?: string | null;
        /** Resolved Account server for this daemon lifecycle's PAT introspection. */
        serverBaseUrl: string;
        runtimeActionExecute?: RuntimeActionExecute;
        currentMachineHost?: string | null;
        currentMachineHomeDir?: string | null;
        /** Fresh Account server + exact daemon identity for server-origin Session spawn binding. */
        resolveCurrentMachineExecutionOriginContext?: (
            signal?: AbortSignal,
        ) => Promise<CurrentMachineExecutionOriginContext | null>;
        /** Current exact external-session RPC executor; it may change after machine sync. */
        resolveExternalSessionHostAction?: () =>
            | ActionExecutorDeps['hostExternalSessionAction']
            | undefined;
        /** Canonical daemon owner for External Session hook installation mutations. */
        externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
        /** Current exact daemon spawn transport; it may change after machine sync. */
        resolveSessionSpawnDirectTargetTransport?: () =>
            | SessionSpawnDirectTargetTransport
            | undefined;
        externalSessionHostOperationOwner?: ExternalSessionHostOperationOwner;
        runtimeId?: string;
        credentials: NonNullable<Parameters<typeof executeSpawnSessionRequest>[0]['credentials']>;
        daemonSessionMutationCustody: Pick<DaemonSessionMutationCustody, 'stageTranscriptEvent'>
            & Partial<Pick<DaemonSessionMutationCustody, 'stage'>>;
        cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop?: (input: Readonly<{
            sessionId: string;
        }>) => Promise<unknown>;
        deviceLocalSecretStorage?: DeviceLocalSecretStorage;
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
        connectedAccountRequestAuthRegistry?:
            ConnectedAccountRequestAuthSubjectRegistry;
        onConnectedAccountRequestAuthHttpPortReady?: (port: number) => void;
        connectedServiceRuntimeRegistry?: ConnectedServiceRuntimeRegistry;
        pidToTrackedSession: Map<number, TrackedSession>;
        pidToAwaiter: Map<number, (session: TrackedSession) => void>;
        pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
        pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
        getApiMachineForSessions: () => ApiMachineClient | null;
        onLocalServicesPreviewRoutesReady?: (routes: LocalServicePreviewRoutes) => void;
        onLocalServicesRoutesReady?: (routes: DaemonLocalServicesMachineRpcRoutes) => void;
        onProviderManagedCatalogRuntimeOwnerReady?: (owner: ProviderManagedCatalogRuntimeOwner) => void;
        onManagedServiceEndpointReadHostReady?: (
            host: ReturnType<
                typeof createDaemonManagedServiceEndpointReadOwner
            >['bindHost'],
        ) => void;
        onManagedServiceSessionBaseUrlResolverReady?: (
            resolver: ManagedServiceSessionBaseUrlResolver,
        ) => void;
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
        onAlreadyRunningSessionAdopted?: (sessionId: string) => Promise<void>;
        connectedServiceGroupHomeCleanupScheduler?: Pick<ConnectedServiceGroupHomeCleanupScheduler, 'cleanupPendingDeletedGroupHomes'>;
        connectedServiceMaterializedHomeCleanupScheduler?: Readonly<{
            cleanupPendingMaterializedHomes: () => Promise<unknown>;
        }>;
        beforeShutdown: Parameters<typeof startDaemonControlServer>[0]['beforeShutdown'];
        onHappySessionWebhook: (
            sessionId: string,
            sessionMetadata: Metadata,
            reconcileCanonicalReadiness?: (
                tracked: TrackedSession,
            ) => Promise<void>,
            sessionCreationOutcome?: SessionCreationOutcome,
        ) => Promise<void>;
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
        hardRevokeRunningSessionsForGenerationIntegrityFailure?: (
            input: Readonly<{
                pluginId: string;
                immutableGenerationId: string;
            }>,
        ) => Promise<void>;
        resolveManagedPurposeBindingIntent?: Parameters<
            typeof executeSpawnSessionRequest
        >[0]['resolveManagedPurposeBindingIntent'];
        activateSessionPurposeBindings?: Parameters<
            typeof executeSpawnSessionRequest
        >[0]['activateSessionPurposeBindings'];
        resolveCurrentSessionPurposeBindingSnapshot?: ConnectedAccountPurposeBindingOwner[
            'resolveCurrentSessionPurposeBindingSnapshot'
        ];
        resolveCurrentRequestAuthBinding?: ConnectedAccountPurposeBindingOwner[
            'resolveCurrentRequestAuthBinding'
        ];
        materializeRequestAuthBearer?: ConnectedAccountPurposeBindingOwner[
            'materializeRequestAuthBearer'
        ];
        activatePurposeBindings?: ConnectedAccountPurposeBindingOwner[
            'activatePurposeBindings'
        ];
        resolveHostedWebStaticAssetContributionRegistry?: () => Promise<ResolvedContributionRegistry>;
        liveStreamCaptureRegistry?: MachineLiveStreamCaptureRegistry;
        simulatorInputLeaseManager?: SimulatorInputLeaseManager;
        browserSidecarControlAdapterFactory?: BrowserSidecarControlAdapterFactory;
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
    externalActionIngressOwner?: ExternalActionIngressOwner;
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => Promise<StopSessionResult>;
    isSessionAlreadyRunning: (sessionId: string) => Promise<boolean>;
    onChildExited: (pid: number, exit: { reason: string; code: number | null; signal: string | null }) => void;
    controlPort: number;
    controlToken: string;
    stopControlServer: () => Promise<void>;
    connectedServiceAuthGroupPreTurnSwitchCoordinator: Readonly<{
        switchBeforeTurn: (input: ConnectedServicePreTurnSwitchInput) =>
            Promise<ConnectedServicePreTurnSwitchResult>;
        applyCommittedGeneration: (input: Readonly<{
            sessionId: string;
            serviceId: ConnectedAccountServiceKey;
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
        applyCredentialUpdate: (input: Readonly<{
            sessionId: string;
            serviceId: ConnectedServiceId;
            profileId: string;
            reason: 'account_changed' | 'auth_expired';
            executionAuthority: ConnectedServiceExecutionAuthorityV1;
        }>) => Promise<Readonly<{
            status: 'hot_applied' | 'restart_requested' | 'unchanged' | 'failed';
            errorCode?: string;
        }>>;
    }>;
    connectedServicePredictiveSwitchGuard: ReturnType<typeof createConnectedServicePredictiveSwitchGuard>;
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
    reconcileReattachedConnectedServiceCredentialProjection: () => Promise<void>;
    reconcileConnectedServicesProjection: (notification: ConnectedServicesProjectionNotification) => Promise<void>;
    awaitAgentSessionOpen: (
        input: Omit<
            Parameters<typeof awaitTrackedRunnerAgentSessionOpen>[0],
            'getTrackedSessions'
        >,
    ) => ReturnType<typeof awaitTrackedRunnerAgentSessionOpen>;
    installExternalSessionHostOperations(
        operations: ExternalSessionHostOperationSet,
    ): ReturnType<
        ReturnType<typeof createExternalSessionHostOperationOwner>['install']
    >;
    providerAccountUsageStore: Pick<ProviderAccountUsageStore, 'recordSnapshot' | 'resolveRecordId' | 'resolveBySource'>;
    /** Resubmits provider account-usage material the persistence scheduler paused. */
    flushProviderAccountUsagePersistence: (timeoutMs: number) => Promise<void>;
    connectedServiceRuntimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
    createAgentCatalogObservation: (
        infrastructure: Pick<
            Parameters<typeof createAgentProviderCatalogObservationService>[0],
            'client' | 'scheduler'
        >,
    ) => ReturnType<typeof createAgentProviderCatalogObservationService>;
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
    // Reattached children are restored as ongoing runtime targets only when their materialized
    // credential is revision-fenced. Server-observed credential revisions are the canonical
    // authority for that fact, so bootstrap must never resolve credential material to learn it:
    // the materialization owner is not ready yet, and a stale-but-fenced revision is precisely the
    // case reattach reconciliation exists to repair.
    const resolveBootstrapConnectedServiceRuntimeCandidate = (tracked: TrackedSession) => {
        const agentId = resolveTrackedSessionCatalogAgentId(tracked);
        const materializationIdentity = resolveConnectedServiceMaterializationIdentityFromTrackedSession(tracked);
        if (!agentId || !materializationIdentity) return null;
        const environment = tracked.spawnOptions?.environmentVariables ?? {};
        const configuredSelections = parseConnectedServiceBindingSelections(
            resolveTrackedConnectedServiceBindingsRaw(tracked),
        );
        const materializedSelections =
            readConnectedServiceChildSelectionsFromEnv(environment);
        const credentialBindings = configuredSelections.flatMap(
            (selection) => {
                const materialized = materializedSelections?.get(
                    selection.serviceId,
                );
                if (!materialized) {
                    return [];
                }
                if (selection.kind === 'profile') {
                    return materialized.kind === 'profile'
                        && materialized.profileId === selection.profileId
                        ? [{
                            serviceId: selection.serviceId,
                            profileId: materialized.profileId,
                        }]
                        : [];
                }
                return materialized.kind === 'group'
                    && materialized.groupId === selection.groupId
                    ? [{
                        serviceId: selection.serviceId,
                        profileId: materialized.activeProfileId,
                    }]
                    : [];
            },
        );
        if (
            configuredSelections.length === 0
            || credentialBindings.length !== configuredSelections.length
        ) return null;
        return { tracked, agentId, materializationIdentity, environment, credentialBindings };
    };
    const registerTrackedConnectedServiceRuntimeTargets = async (): Promise<void> => {
        const candidates = Array.from(params.pidToTrackedSession.values())
            .flatMap((tracked) => resolveBootstrapConnectedServiceRuntimeCandidate(tracked) ?? []);
        if (candidates.length === 0) return;
        const projection = await fetchConnectedServiceProjectionSnapshot().catch(() => null);
        if (!projection) return;
        for (const candidate of candidates) {
            const revisionFenced = candidate.credentialBindings.every((binding) => (
                projection.resolveCredentialPresence(
                    binding.serviceId,
                    binding.profileId,
                ).status === 'present'
            ));
            if (!revisionFenced) continue;
            connectedServiceRuntimeRegistry.registerTarget({
                pid: candidate.tracked.pid,
                agentId: candidate.agentId,
                sessionId: candidate.tracked.happySessionId,
                sessionDirectory: candidate.tracked.spawnOptions?.directory,
                materializationKey: candidate.materializationIdentity.id,
                connectedServiceMaterializationIdentityV1: candidate.materializationIdentity,
                connectedServicesBindingsRaw: candidate.tracked.spawnOptions?.connectedServices,
                connectedServiceSelectionsEnv: candidate.environment,
            }, { source: 'bootstrap' });
        }
    };
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
    let unsubscribeRunnerAgentAuthorityCurrentness = () => {};
    const connectedServiceRuntimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const providerAccountUsageStore = createProviderAccountUsageStore();
    const providerAccountUsagePersistence = createProviderAccountUsagePersistenceScheduler({
        api: {
            getAccountEncryptionMode: () => params.api.getAccountEncryptionMode(),
        },
        credentials: params.credentials,
        randomBytes,
        serverScope: configuration.activeServerDir,
        accountScope: 'active-account',
        now: () => Date.now(),
    });
    const qualifiedConnectedAccountAuthGroupSwitchLeases =
        new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry<
            QualifiedConnectedAccountServiceRef
        >();
    const connectedServiceRuntimeAuthSwitchAttempts = new ConnectedServiceRuntimeAuthSwitchAttemptTracker({
        nowMs: () => Date.now(),
        windowMs: 60_000,
    });
    let connectedServicePredictiveSwitchGuard: ReturnType<typeof createConnectedServicePredictiveSwitchGuard> | null = null;
    const connectedServiceSessionAuthSwitchCore = createConnectedServiceSessionAuthSwitchCore();
    const recordConnectedServiceRestartDiagnostic = (record: ConnectedServiceDaemonRestartDiagnosticRecord) => {
        logConnectedServiceDaemonRestartDiagnostic(logger, record);
    };
    const commitConnectedServiceAccountSwitchSessionEventWithNotification = async (
        input: Readonly<{
            sessionId: string;
            event: unknown;
            logContext: string;
            reasonFallback?: string;
        }>,
    ): Promise<void> => {
        await commitConnectedServiceAccountSwitchSessionEvent({
            mutationCustody: params.daemonSessionMutationCustody,
            sessionId: input.sessionId,
            event: input.event,
            listConnectedServiceProfiles: params.api.listConnectedServiceProfiles.bind(params.api),
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
        const serviceIdParsed = readBuiltInLegacyConnectedAccountServiceKeyIngress(record.serviceId);
        if (!serviceIdParsed) return;
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
                serviceId: serviceIdParsed,
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
    const prepareLegacyAuthGroupCandidateForSwitch = async (input: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        profileId: string;
        reason: string;
    }>) => await params.getConnectedServiceRefreshCoordinator()
        ?.prepareConnectedServiceAuthGroupCandidateForSwitch({
            serviceId: input.serviceId,
            profileId: input.profileId,
            reason: input.reason,
        }) ?? {
            status: 'ineligible' as const,
            memberState: { credentialHealthStatus: 'refresh_failed_retryable' as const },
        };
    const readQualifiedConnectedServiceAuthGroup = async (input: Readonly<{
        serviceId: ConnectedAccountServiceKey;
        groupId: string;
        signal?: AbortSignal;
    }>) => {
        if (params.resolveQualifiedConnectedAccountV4Support?.() !== 'advertised') {
            return null;
        }
        const service =
            resolveQualifiedConnectedAccountServiceForIngressServiceId(
                input.serviceId,
            );
        if (!service) return null;
        return await readQualifiedConnectedAccountGroupV4({
            token: params.credentials.token,
            group: { service, groupId: input.groupId },
            ...(input.signal ? { signal: input.signal } : {}),
        });
    };
    const resolveQualifiedProviderAccountUsagePersistenceTargets = async (input: Readonly<{
        sessionId: string;
        snapshot: ProviderAccountUsageSnapshotV1;
        sources: readonly ConnectedServiceUsageSourceV1[];
    }>): Promise<readonly QualifiedProviderAccountUsagePersistenceTarget[]> => {
        if (
            params.resolveQualifiedConnectedAccountV4Support?.() !== 'advertised'
            || input.snapshot.accountSubject.kind !== 'providerSubject'
        ) {
            return [];
        }
        const runtimeTarget = connectedServiceRuntimeRegistry.getBySessionId(
            input.sessionId,
        );
        if (!runtimeTarget) return [];
        const sourceMatchesBinding = (
            source: ConnectedServiceUsageSourceV1,
            binding: (typeof runtimeTarget.activeBindings)[number],
        ): boolean => {
            if (
                source.serviceId !== binding.serviceId
                || source.profileId !== binding.profileId
            ) return false;
            return source.bindingKind === 'group_member'
                ? binding.groupId === source.groupId
                    && binding.groupGeneration === source.groupGeneration
                : binding.groupId === null;
        };
        const candidateBindings = input.sources.length > 0
            ? runtimeTarget.activeBindings.filter((binding) =>
                input.sources.some((source) => sourceMatchesBinding(source, binding)),
            )
            : runtimeTarget.activeBindings;
        const providerAccountId = input.snapshot.accountSubject.id.trim();
        if (!providerAccountId) return [];
        const listedAccountsByService = new Map<
            string,
            Awaited<ReturnType<typeof listQualifiedConnectedAccountsV4>> | null
        >();
        const targets: QualifiedProviderAccountUsagePersistenceTarget[] = [];
        for (const binding of candidateBindings) {
            const service =
                resolveQualifiedConnectedAccountServiceForIngressServiceId(
                    binding.serviceId,
                );
            if (!service) continue;
            const legacyServiceId =
                resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
                    binding.serviceId,
                );
            if (!legacyServiceId) continue;
            const serviceKey = `${service.pluginId}\u0000${service.localId}`;
            let listed = listedAccountsByService.get(serviceKey);
            if (listed === undefined) {
                listed = await listQualifiedConnectedAccountsV4({
                    token: params.credentials.token,
                    service,
                }).catch(() => null);
                listedAccountsByService.set(serviceKey, listed);
            }
            const profile = listed?.accounts.find((candidate) =>
                candidate.ref.accountId === binding.profileId
                && candidate.providerIdentity?.accountId === providerAccountId,
            );
            if (!profile || profile.revisionSemantics !== 'revisioned') continue;
            const resolutions = await resolveConnectedServiceCredentialResolutions({
                credentials: params.credentials,
                api: params.api,
                bindings: [{
                    serviceId: legacyServiceId,
                    profileId: binding.profileId,
                }],
            }).catch(() => null);
            const resolution = resolutions?.get(legacyServiceId) ?? null;
            if (
                !resolution
                || resolution.revisionSemantics !== 'revisioned'
                || resolution.credentialRevision !== profile.credentialRevision
                || readConnectedServiceCredentialProviderAccountId(resolution.record)
                    !== providerAccountId
            ) continue;
            const source = binding.groupId === null
                ? {
                    ref: profile.ref,
                    bindingKind: 'account' as const,
                }
                : {
                    ref: profile.ref,
                    bindingKind: 'group_member' as const,
                    groupId: binding.groupId,
                    ...(binding.groupGeneration === null
                        ? {}
                        : { groupGeneration: binding.groupGeneration }),
                };
            targets.push({
                source,
                expectedCredentialRevision: profile.credentialRevision,
                expectedConfigurationRevision: profile.configurationRevision,
            });
        }
        return targets;
    };
    const validateConnectedServiceGroupMutationCurrentness = async (input: Readonly<{
        serviceId: ConnectedAccountServiceKey;
        groupId: string;
        profileId: string;
        generation: number;
        credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
    }>) => {
        const currentGroup = await readQualifiedConnectedServiceAuthGroup({
            serviceId: input.serviceId,
            groupId: input.groupId,
        }).catch(() => null);
        if (!currentGroup?.activeConnectedAccountId) {
            return { current: false as const, reason: 'shared_generation_application_superseded' };
        }
        // Released V2/V3 sealed-credential reads remain scalar-keyed on the server wire;
        // first-party services translate at this named ingress. External qualified services
        // verify currentness through the V4 group owner above alone.
        const scalarCredentialServiceId =
            resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(input.serviceId);
        const currentResolutions = scalarCredentialServiceId
            ? await resolveConnectedServiceCredentialResolutions({
                credentials: params.credentials,
                api: params.api,
                bindings: [{ serviceId: scalarCredentialServiceId, profileId: currentGroup.activeConnectedAccountId }],
            }).catch(() => null)
            : null;
        const currentResolution = scalarCredentialServiceId
            ? currentResolutions?.get(scalarCredentialServiceId) ?? null
            : null;
        const authoritativeTarget = currentResolution
            ? {
                profileId: currentGroup.activeConnectedAccountId,
                generation: currentGroup.generation,
                credentialRevision: currentResolution.revisionSemantics === 'revisioned'
                    ? currentResolution.credentialRevision
                    : null,
            }
            : undefined;
        if (
            currentGroup.activeConnectedAccountId !== input.profileId
            || currentGroup.generation !== input.generation
        ) {
            return {
                current: false as const,
                reason: 'shared_generation_application_superseded',
                ...(authoritativeTarget ? { authoritativeTarget } : {}),
            };
        }
        const revisionIsCurrent = currentResolution?.revisionSemantics === 'revisioned'
            ? currentResolution.credentialRevision === input.credentialRevision
            : input.credentialRevision === null;
        return revisionIsCurrent
            ? { current: true as const }
            : {
                current: false as const,
                reason: 'credential_revision_superseded',
                ...(authoritativeTarget ? { authoritativeTarget } : {}),
            };
    };
    const prepareQualifiedAuthGroupCandidateForSwitch = async (input: Readonly<{
        serviceId: QualifiedConnectedAccountServiceRef;
        groupId: string;
        profileId: string;
        reason: string;
    }>) => {
        const serviceId = resolveFirstPartyConnectedAccountServiceId(
            input.serviceId,
        );
        if (!serviceId) return { status: 'ready' as const };
        return await prepareLegacyAuthGroupCandidateForSwitch({
            serviceId,
            groupId: input.groupId,
            profileId: input.profileId,
            reason: input.reason,
        });
    };
    const qualifiedRequestAuthGroupSwitchCoordinator =
        params.resolveQualifiedConnectedAccountV4Support
            ? createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
                token: params.credentials.token,
                quotaFreshnessMs: requestAuthGroupQuotaFreshnessMs,
                nowMs: () => Date.now(),
                leases: qualifiedConnectedAccountAuthGroupSwitchLeases,
                applyGeneration: async () => ({ ok: true }),
                prepareCandidateForSwitch:
                    prepareQualifiedAuthGroupCandidateForSwitch,
            })
            : null;
    const switchAfterConnectedAccountRequestAuthFailure = async (input: Readonly<{
        service: QualifiedConnectedAccountServiceRef;
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
            support !== 'advertised'
            || !qualifiedRequestAuthGroupSwitchCoordinator
        ) {
            return null;
        }
        return await qualifiedRequestAuthGroupSwitchCoordinator
            .switchAfterClassifiedFailure({
                ...input.failure,
                serviceId: input.service,
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
        params.connectedAccountRequestAuthRegistry
        ?? createConnectedAccountRequestAuthSubjectRegistry();
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
        if (!quotaCoordinator) {
            return unavailable('backoff_owner_unavailable');
        }
        try {
            if (serviceId) {
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
            } else {
                quotaCoordinator.recordQualifiedRequestAuthProviderBackoff({
                    account: {
                        service: input.service,
                        accountId: input.accountId,
                    },
                    groupId: input.groupId,
                    groupGeneration: input.groupGeneration,
                    limitCategory: input.limitCategory,
                    quotaScope: input.quotaScope,
                    retryAfterMs: input.retryAfterMs,
                    resetAtMs: input.resetAtMs,
                    providerCode: input.providerCode,
                });
            }
            return { status: 'recorded' };
        } catch {
            return unavailable('backoff_record_failed');
        }
    };
    const recoverConnectedAccountRequestAuthFailure = async (input: Readonly<{
        resolved: ConnectedAccountRequestAuthResolvedBinding;
        failure: ConnectedAccountRequestAuthRecoveryInput['failure'];
        signal: AbortSignal;
        allowCredentialRefresh: boolean;
    }>): Promise<RequestAuthFailureOutcomeV1> => {
        input.signal.throwIfAborted();
        const legacyServiceId = input.resolved.legacyServiceKeyedCompatibility === true
            ? resolveFirstPartyConnectedAccountServiceId(
                input.resolved.account.service,
            )
            : null;
        if (
            input.resolved.legacyServiceKeyedCompatibility === true
            && !legacyServiceId
        ) {
            return { status: 'denied' };
        }
        const before = legacyServiceId
            ? resolveRequestAuthAccountFingerprint(
                input.resolved,
                latestConnectedServiceProjectionSnapshot,
            )
            : null;
        const recovery = await applyConnectedAccountRequestAuthRecovery({
            resolved: input.resolved,
            failure: input.failure,
            signal: input.signal,
            refreshCredential: async (refreshInput) => {
                input.signal.throwIfAborted();
                if (!input.allowCredentialRefresh) return false;
                const refreshCoordinator =
                    params.getConnectedServiceRefreshCoordinator();
                if (!refreshCoordinator) return false;
                const refreshed = legacyServiceId
                    ? await refreshCoordinator
                        .refreshConnectedServiceCredentialForQuota({
                            serviceId: legacyServiceId,
                            profileId: refreshInput.account.accountId,
                            force: true,
                            expectedCredentialRevision:
                                refreshInput.expectedCredentialRevision,
                        })
                        .catch(() => null)
                    : await refreshCoordinator
                        .refreshQualifiedConnectedAccountCredentialForRequestAuth({
                            account: refreshInput.account,
                            expectedCredentialRevision:
                                refreshInput.expectedCredentialRevision,
                        })
                        .catch(() => false);
                input.signal.throwIfAborted();
                return Boolean(refreshed);
            },
            switchAfterClassifiedFailure: async (failure) => {
                input.signal.throwIfAborted();
                const result = await switchAfterConnectedAccountRequestAuthFailure({
                    service: input.resolved.account.service,
                    failure,
                }).catch(() => null);
                input.signal.throwIfAborted();
                return result;
            },
            recordTemporaryRetry: recordConnectedAccountRequestAuthTemporaryRetry,
        });
        input.signal.throwIfAborted();
        if (recovery.effect === 'stale_context') {
            return { status: 'stale_context' };
        }
        if (recovery.effect === 'temporary_retry_unavailable') {
            return { status: 'denied' };
        }
        if (!legacyServiceId) {
            // The qualified purpose-binding owner re-resolves current account/group truth after
            // this callback. It alone turns an actual replacement into stale_context.
            return { status: 'current_unchanged' };
        }
        const projection = await fetchConnectedServiceProjectionSnapshot(input.signal)
            .catch(() => {
                input.signal.throwIfAborted();
                return latestConnectedServiceProjectionSnapshot;
            });
        input.signal.throwIfAborted();
        const after = resolveRequestAuthAccountFingerprint(input.resolved, projection);
        return {
            status: !after || after !== before
                ? 'current_changed'
                : 'current_unchanged',
        };
    };
    const connectedAccountRequestAuthService =
        createConnectedAccountRequestAuthService({
            resolveCurrentBinding: async ({ subject, binding, signal }) => {
                signal.throwIfAborted();
                const service = binding.target.kind === 'account'
                    ? binding.target.account.service
                    : binding.target.service;
                const legacyServiceId =
                    subject.legacyServiceKeyedCompatibility === true
                        ? resolveFirstPartyConnectedAccountServiceId(service)
                        : null;
                if (legacyServiceId) {
                    const projection = latestConnectedServiceProjectionSnapshot
                        ?? await fetchConnectedServiceProjectionSnapshot(signal);
                    signal.throwIfAborted();
                    const resolved = projection
                        ? resolveFirstPartyConnectedAccountBinding(
                            binding,
                            projection,
                        )
                        : null;
                    return resolved
                        ? Object.freeze({
                            ...resolved,
                            legacyServiceKeyedCompatibility: true as const,
                        })
                        : null;
                }
                if (
                    !subject.isCurrent()
                    || !params.resolveCurrentRequestAuthBinding
                ) {
                    return null;
                }
                try {
                    const resolved =
                        await params.resolveCurrentRequestAuthBinding({
                            subjectId: subject.subjectId,
                            binding,
                            signal,
                        });
                    signal.throwIfAborted();
                    if (!subject.isCurrent() || !resolved) return null;
                    // The qualified owner never delegates its service target to the
                    // compatibility adapter. Strip a forged compatibility marker from
                    // any callback result before it reaches cache/recovery policy.
                    return Object.freeze({
                        account: resolved.account,
                        credentialRevision: resolved.credentialRevision,
                        ...(resolved.group ? { group: resolved.group } : {}),
                    });
                } catch (error) {
                    signal.throwIfAborted();
                    if (error instanceof ConnectedAccountRequestAuthError) {
                        throw error;
                    }
                    throw new ConnectedAccountRequestAuthError(
                        'request_auth_binding_unavailable',
                    );
                }
            },
            materializeBearer: async ({
                subject,
                binding,
                resolved,
                materialization,
                signal,
            }) => {
                signal.throwIfAborted();
                const service = binding.target.kind === 'account'
                    ? binding.target.account.service
                    : binding.target.service;
                const legacyServiceId =
                    subject.legacyServiceKeyedCompatibility === true
                        ? resolveFirstPartyConnectedAccountServiceId(service)
                        : null;
                if (!legacyServiceId) {
                    if (!subject.isCurrent()) {
                        throw new ConnectedAccountRequestAuthError(
                            'request_auth_not_active',
                        );
                    }
                    if (!params.materializeRequestAuthBearer) {
                        throw new ConnectedAccountRequestAuthError(
                            'request_auth_binding_unavailable',
                        );
                    }
                    const result = await params.materializeRequestAuthBearer({
                        subjectId: subject.subjectId,
                        binding,
                        resolved,
                        materialization,
                        signal,
                    });
                    signal.throwIfAborted();
                    if (!subject.isCurrent()) {
                        throw new ConnectedAccountRequestAuthError(
                            'request_auth_not_active',
                        );
                    }
                    return result;
                }
                return await materializeFirstPartyConnectedAccountBearer({
                    resolved,
                    materialization,
                    signal,
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
                    resolveCredential: async ({
                        serviceId,
                        profileId,
                        signal: credentialSignal,
                    }) => {
                        credentialSignal?.throwIfAborted();
                        const resolutions = await resolveConnectedServiceCredentialResolutions({
                            credentials: params.credentials,
                            api: params.api,
                            bindings: [{ serviceId, profileId }],
                            ...(credentialSignal ? { signal: credentialSignal } : {}),
                        });
                        credentialSignal?.throwIfAborted();
                        const resolution = resolutions.get(serviceId) ?? null;
                        // Exact v0.2.1 credentials remain readable for passive compatibility, but
                        // authority-bearing consumers must have a server revision fence.
                        return resolution?.revisionSemantics === 'revisioned'
                            ? resolution
                            : null;
                    },
                });
            },
            refreshAfterAuthFailure: async ({ resolved, failure, signal }) => {
                return await recoverConnectedAccountRequestAuthFailure({
                    resolved,
                    failure,
                    signal,
                    allowCredentialRefresh: true,
                });
            },
            reportQuotaFailure: async ({ resolved, failure, signal }) => {
                return await recoverConnectedAccountRequestAuthFailure({
                    resolved,
                    failure,
                    signal,
                    allowCredentialRefresh: false,
                });
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
            isCurrent: (
                account,
                credentialRevision,
                legacyServiceKeyedCompatibility,
            ) => {
                if (legacyServiceKeyedCompatibility !== true) {
                    // Qualified bindings are re-resolved through their own canonical
                    // owner on every lookup; this projection has no authority over them.
                    return true;
                }
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
    await registerTrackedConnectedServiceRuntimeTargets();
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
    type PendingRequestAuthSourceCutover = {
        sessionId: string;
        agentId: string;
        tracked: TrackedSession;
        requirement: RequestAuthSourceCutoverRequirement;
        resolveCurrentCapabilityPath:
            (tracked: TrackedSession) => string | null;
        attempt: Promise<RestartSessionRunnerResult> | null;
        boundaryAttempt: Promise<RestartSessionRunnerResult> | null;
    };
    const pendingRequestAuthSourceCutoverBySessionId =
        new Map<string, PendingRequestAuthSourceCutover>();
    const retirePendingRequestAuthSourceCutoverForCurrentSuccessor = (
        pending: PendingRequestAuthSourceCutover,
    ): boolean => {
        const matches = Array.from(
            params.pidToTrackedSession.values(),
        ).filter(
            (tracked) =>
                normalizeOptionalString(
                    tracked.happySessionId,
                ) === pending.sessionId,
        );
        if (
            matches.length !== 1
            || matches[0] === pending.tracked
        ) {
            return false;
        }
        const successor = matches[0]!;
        const currentCapabilityPath =
            pending.resolveCurrentCapabilityPath(successor);
        if (!currentCapabilityPath) return false;
        const successorSource =
            resolveRequestAuthSourceCutoverRequirement({
                tracked: successor,
                currentCapabilityPath,
            });
        if (successorSource.status !== 'current') {
            return false;
        }
        if (
            pendingRequestAuthSourceCutoverBySessionId.get(
                pending.sessionId,
            ) === pending
        ) {
            pendingRequestAuthSourceCutoverBySessionId.delete(
                pending.sessionId,
            );
        }
        return true;
    };
    const requestPendingRequestAuthSourceCutover = (
        pending: PendingRequestAuthSourceCutover,
    ): Promise<RestartSessionRunnerResult> => {
        if (pending.attempt) return pending.attempt;
        const attempt =
            (async (): Promise<RestartSessionRunnerResult> => {
                try {
                    const result =
                        await restartSessionRunnerForRequestAuthSourceCutover({
                            tracked: pending.tracked,
                            currentIdentity:
                                resolveCurrentSessionRunnerLaunchIdentity(),
                            requestRestart:
                                requestSessionRunnerVersionRuntimeRefresh,
                            requirement: pending.requirement,
                            resolveCurrentCapabilityPath: () =>
                                pending.resolveCurrentCapabilityPath(
                                    pending.tracked,
                                ),
                            resolveActivityDisabledReason:
                                resolveSessionRunnerActivityDisabledReason,
                        });
                    logger.debug(
                        '[DAEMON RUN] Reattached Agent request-auth source cutover attempt settled',
                        {
                            sessionId: pending.sessionId,
                            agentId: pending.agentId,
                            status: result.status,
                            reasonCode:
                                result.reasonCode ?? null,
                        },
                    );
                    if (
                        result.status === 'restarted'
                        && retirePendingRequestAuthSourceCutoverForCurrentSuccessor(
                            pending,
                        )
                    ) {
                        return result;
                    }
                    return result;
                } catch (error) {
                    logger.debug(
                        '[DAEMON RUN] Reattached Agent request-auth source cutover attempt failed closed',
                        {
                            sessionId: pending.sessionId,
                            agentId: pending.agentId,
                            error: serializeAxiosErrorForLog(error),
                        },
                    );
                    return {
                        ok: false,
                        status: 'ineligible',
                        sessionId: pending.sessionId,
                        reasonCode:
                            'runner_generation_unattested',
                    };
                }
            })();
        pending.attempt = attempt;
        void attempt.finally(() => {
            if (pending.attempt === attempt) {
                pending.attempt = null;
            }
        });
        return attempt;
    };
    const requestPendingRequestAuthSourceCutoverAtBoundary = (
        pending: PendingRequestAuthSourceCutover,
    ): Promise<RestartSessionRunnerResult> => {
        if (pending.boundaryAttempt) return pending.boundaryAttempt;
        const attempt = requestPendingRequestAuthSourceCutover(pending);
        pending.boundaryAttempt = attempt;
        void attempt.then((result) => {
            if (
                pending.boundaryAttempt === attempt
                && result.status === 'busy'
                && result.reasonCode === 'turn_in_progress'
            ) {
                pending.boundaryAttempt = null;
            }
        });
        return attempt;
    };
    const shutdownCancellationDomains = createDaemonShutdownCancellationDomains();
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
            for (const tracked of reattached) {
                const trackedMapPid = tracked.pid;
                const expectedPid = tracked.sessionRunnerPid ?? tracked.pid;
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
                const authorityPath =
                    tracked.agentRuntimeDaemonServiceAuthorityFilePath;
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
                    || !authorityPath
                    || typeof expectedProcessStartTimeMs !== 'number'
                    || !Number.isFinite(expectedProcessStartTimeMs)
                ) {
                    unavailable(
                        'reattached_agent_identity_or_bindings_unavailable',
                    );
                    continue;
                }

                const retainedAuthority =
                    await readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker({
                        happyHomeDir: configuration.happyHomeDir,
                        publicReleaseRing:
                            configuration.publicReleaseRing,
                        path: authorityPath,
                        sessionId,
                        runner: {
                            pid: expectedPid,
                            processStartTimeMs: expectedProcessStartTimeMs,
                            processCommandHash: expectedProcessCommandHash,
                        },
                    });
                const acquireRetainedPurposeContributions =
                    runtimeRegistryLease.registry
                        .acquireRetainedRunnerAgentPurposeContributions;
                if (
                    !retainedAuthority
                    || retainedAuthority.retainedAgent.agentId !== agentId
                    || tracked.runnerAgentImmutableGenerationId
                        !== retainedAuthority.retainedAgent
                            .immutableGenerationId
                    || !acquireRetainedPurposeContributions
                ) {
                    unavailable(
                        'retained_agent_request_auth_declaration_unavailable',
                    );
                    continue;
                }
                const retainedPurposeContributions = await (async () => {
                    try {
                        return await acquireRetainedPurposeContributions({
                            binding: retainedAuthority.retainedAgent,
                            pluginHardRevocationRevision:
                                retainedAuthority.pluginHardRevocationRevision,
                        });
                    } catch {
                        return null;
                    }
                })();
                if (!retainedPurposeContributions) {
                    unavailable(
                        'retained_agent_request_auth_declaration_unavailable',
                    );
                    continue;
                }
                const contributions =
                    retainedPurposeContributions.contributes;

                const purposeSnapshot =
                    resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                        agentId,
                        bindings: parsedBindings.data,
                        contributions,
                    });
                if (!purposeSnapshot?.requestAuthUses?.length) {
                    await retainedPurposeContributions.release();
                    continue;
                }
                const requestAuthPurposeBindings =
                    resolveQualifiedRequestAuthPurposeBindingsFromSnapshot(
                        purposeSnapshot,
                    );
                if (requestAuthPurposeBindings.length === 0) {
                    await retainedPurposeContributions.release();
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
                const sourceCutover =
                    resolveRequestAuthSourceCutoverRequirement({
                        tracked,
                        currentCapabilityPath: capabilityPath,
                        ownedRetainedDevCapabilityPaths:
                            resolveOwnedRetainedDevRequestAuthCapabilityPaths({
                                tracked,
                                agentId,
                                bindings:
                                    parsedBindings.data,
                            }),
                    });
                if (sourceCutover.status === 'unavailable') {
                    await retainedPurposeContributions.release();
                    unavailable(sourceCutover.reason);
                    continue;
                }
                if (sourceCutover.status === 'required') {
                    await retainedPurposeContributions.release();
                    const resolveCurrentCapabilityPath = (
                        candidate: TrackedSession,
                    ): string | null => {
                        const currentMaterializationIdentity =
                            resolveConnectedServiceMaterializationIdentityFromTrackedSession(
                                candidate,
                            );
                        if (!currentMaterializationIdentity) return null;
                        return resolveConnectedAccountRequestAuthCapabilityPath(
                            resolveConnectedServiceMaterializedRootDir({
                                baseDir:
                                    params.connectedServicesMaterializationBaseDir,
                                agentId,
                                materializationKey:
                                    currentMaterializationIdentity.id,
                            }),
                        );
                    };
                    const pending: PendingRequestAuthSourceCutover = {
                        sessionId,
                        agentId,
                        tracked,
                        requirement: sourceCutover.requirement,
                        resolveCurrentCapabilityPath,
                        attempt: null,
                        boundaryAttempt: null,
                    };
                    pendingRequestAuthSourceCutoverBySessionId.set(
                        sessionId,
                        pending,
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
                    await retainedPurposeContributions.release();
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
                    await retainedPurposeContributions.release();
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
                        subjectId: sessionPurposeBindingLease.subjectId,
                        uses: purposeSnapshot.requestAuthUses,
                        ...(isLegacyServiceKeyedCompatibilityCatalogAgent(
                            contributions.catalogEntriesById[agentId],
                        )
                            ? { legacyServiceKeyedCompatibility: true as const }
                            : {}),
                        registerRedaction: redactionLease.add,
                    });
                const previousAttachCleanup =
                    params.sessionAttachCleanupByPid.get(trackedMapPid)
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
                            await retainedPurposeContributions.release();
                            await previousAttachCleanup?.();
                        })();
                        await lifecycleCleanupPromise;
                    };

                // The existing reattach lifecycle owns retirement before the
                // replacement capability is published. PID promotion transfers
                // this same composed cleanup entry with the tracked session.
                params.sessionAttachCleanupByPid.set(
                    trackedMapPid,
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
                                async (descriptor, commit) => {
                                    const isExactProcessCurrent =
                                        await isPidSafeHappySessionProcess({
                                            pid: expectedPid,
                                            expectedProcessCommandHash,
                                            expectedProcessStartTimeMs,
                                        }, params
                                            .reattachedAgentRequestAuthPidSafetyDependencies);
                                    if (
                                        // The running child was launched under the
                                        // predecessor capability's exact subject
                                        // scope. Recovering a differently scoped
                                        // authority onto that same process would
                                        // commit credentials across a changed
                                        // subject scope, so the replacement scope
                                        // must equal the recovered one.
                                        descriptor.subjectScopeDigest
                                            !== previousCapability
                                                .subjectScopeDigest
                                        || !isExactProcessCurrent
                                        || lifecycleCleanupStarted
                                        || tracked.pid !== trackedMapPid
                                        || (tracked.sessionRunnerPid ?? tracked.pid)
                                            !== expectedPid
                                        || params.pidToTrackedSession.get(
                                            trackedMapPid,
                                        ) !== tracked
                                        || params.sessionAttachCleanupByPid.get(
                                            trackedMapPid,
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
                        || currentPid !== trackedMapPid
                        || (tracked.sessionRunnerPid ?? tracked.pid)
                            !== expectedPid
                        || params.pidToTrackedSession.get(trackedMapPid)
                            !== tracked
                        || params.sessionAttachCleanupByPid.get(
                            trackedMapPid,
                        ) !== lifecycleCleanup
                    ) {
                        await retireRecoveredAuthority();
                        await retainedPurposeContributions.release();
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
                    await retainedPurposeContributions.release()
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
    const registerDisconnectedTerminalHostCandidate = (
        candidate: DisconnectedTerminalHostCandidate,
    ): void => {
        disconnectedTerminalHostResultsBySessionId.delete(candidate.sessionId);
        terminalizedDisconnectedTerminalHostIds.delete(candidate.attachmentId);
        unresolvedTerminalHostSessionIds.delete(candidate.sessionId);
        for (let index = disconnectedTerminalHostCandidates.length - 1; index >= 0; index -= 1) {
            if (disconnectedTerminalHostCandidates[index]?.sessionId === candidate.sessionId) {
                disconnectedTerminalHostCandidates.splice(index, 1);
            }
        }
        disconnectedTerminalHostCandidates.push(candidate);
    };
    const retireTerminalControlServiceabilityForCurrentAccount = async (
        input: Omit<Parameters<typeof retireExactTerminalControlServiceability>[0], 'credentials'>,
    ) => await retireExactTerminalControlServiceability({
        credentials: params.credentials,
        ...input,
    });
    const retireDisconnectedTerminalHostCandidate = async (input: Readonly<{
        sessionId: string;
        attachmentId?: string;
    }>): Promise<void> => {
        disconnectedTerminalHostResultsBySessionId.delete(input.sessionId);
        const markerPids: number[] = [];
        for (let index = disconnectedTerminalHostCandidates.length - 1; index >= 0; index -= 1) {
            const candidate = disconnectedTerminalHostCandidates[index];
            if (!candidate || candidate.sessionId !== input.sessionId) continue;
            if (input.attachmentId && candidate.attachmentId !== input.attachmentId) continue;
            terminalizedDisconnectedTerminalHostIds.add(candidate.attachmentId);
            markerPids.push(candidate.pid);
            disconnectedTerminalHostCandidates.splice(index, 1);
        }
        await Promise.all(markerPids.map(async (pid) => {
            await removeSessionMarker(pid).catch((error) => {
                logger.debug('[DAEMON RUN] Retired terminal host but failed to remove its disconnected marker', {
                    sessionId: input.sessionId,
                    pid,
                    error,
                });
            });
        }));
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
            retireExactTerminalControlServiceability: async ({ sessionId, attachmentInfo, terminalMode }) => {
                return await retireTerminalControlServiceabilityForCurrentAccount({
                    sessionId,
                    attachmentId: attachmentInfo.attachmentId,
                    terminalMode,
                });
            },
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
        recoverStrandedTerminalControlServiceability: async ({ sessionId, expectedAttachmentId }) =>
            await recoverStrandedTerminalControlServiceability({
                credentials: params.credentials,
                currentMachineId: params.machineId,
                sessionId,
                expectedAttachmentId,
                loadTerminalHostAdapters: async () => await params.loadTerminalHostAdapters?.() ?? {},
                retireExactTerminalControlServiceability: async (input) =>
                    await retireTerminalControlServiceabilityForCurrentAccount(input),
            }),
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
        },
        retireExactTerminalControlServiceability: async ({ sessionId, attachmentInfo, terminalMode }) => {
            return await retireTerminalControlServiceabilityForCurrentAccount({
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
                        } catch {
                            logger.debug('[DAEMON RUN] Failed to publish resume target terminal control serviceability');
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
                        await params.onAlreadyRunningSessionAdopted?.(sessionId);
                        if (behavior.nudgeAlreadyRunningPendingQueue) {
                            const nudgeResult = await nudgeAlreadyRunningExistingSessionPendingQueue({
                                sessionId,
                                credentials: params.credentials,
                                abortSignal: shutdownCancellationDomains.daemonWorkSignal,
                                ...(params.isShuttingDown ? { isShuttingDown: params.isShuttingDown } : {}),
                            });
                            if ('type' in nudgeResult && nudgeResult.type === 'unavailable') {
                                logger.warn('[DAEMON RUN] Resume target is alive but pending queue materialization probe failed; adopting existing runner and leaving nudge failure advisory');
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
                        deviceLocalSecretStorage: params.deviceLocalSecretStorage,
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
                        authGroupSwitchCoordinator: connectedServiceAuthGroupPreTurnSwitchCoordinator,
                        predictiveSwitchGuard: connectedServicePredictiveSwitchGuard ?? undefined,
                        repairMissingConnectedServiceMaterializationIdentityForSpawn: async (input) => {
                            const repair = await repairMissingConnectedServiceMaterializationIdentityForSpawn({
                                token: params.credentials.token,
                                credentials: params.credentials,
                                sessionId: input.sessionId,
                                agentId: input.agentId,
                                connectedServices: input.connectedServices,
                                vendorResumeId: input.vendorResumeId,
                            });
                            if (!repair) return null;
                            return {
                                identity: repair.identity,
                                persistAfterMaterialization: async () => {
                                    await repair.persistAfterMaterialization();
                                    forgetPersistedConnectedServiceSwitchSessionMetadata(input.sessionId);
                                },
                            };
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
                        ...(params.activatePurposeBindings
                            ? {
                                activatePurposeBindings:
                                    params.activatePurposeBindings,
                            }
                            : {}),
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
        const accountEncryptionCurrentness = await fetchAccountEncryptionCurrentness({ token });
        return await resolveInactiveTemporaryThrottleResumeSource({
            sessionId,
            fallbackMachineId: params.machineId,
            fetchSession: async (id) => await fetchSessionByIdCompat({ token, sessionId: id }),
            decryptSessionMetadata: (rawSession) => tryReadSessionMetadataRecord({
                rawSession,
                credentials: params.credentials,
                accountEncryptionMode: accountEncryptionCurrentness.mode,
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
        | Readonly<{ status: 'captured'; sessionId: string; authority: MachineSessionTerminalAuthorityV1 }>
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
            logger.debug('[DAEMON RUN] Terminal respawn has no captured Session publisher authority; retaining marker for startup recovery', input);
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
                authority: captured.authority,
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
        emitSessionEvent: async (sessionId, event) => {
            await commitConnectedServiceAccountSwitchSessionEventWithNotification({
                sessionId,
                event,
                logContext: 'connected-service switch deferral',
            });
        },
    });
    const resolveSessionRunnerActivityDisabledReason = (
        sessionId: string,
    ): SessionRunnerRestartDisabledReason | null => {
        const tracked = findTrackedSessionByHappySessionId(
            params.pidToTrackedSession.values(),
            sessionId,
        );
        if (
            normalizeOptionalString(tracked?.activeTurnId)
            || normalizeOptionalString(
                tracked?.reattachedInterruptedTurnId,
            )
        ) {
            return 'turn_in_progress';
        }
        return connectedServiceTurnDeferralQueue.isTurnInFlight(
            sessionId,
        )
            ? 'turn_in_progress'
            : null;
    };
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
        try {
            const adapter = await getConnectedServiceRuntimeAuthAdapter(
                resolvedAgentId as CatalogAgentId,
            );
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
            return materialization?.supported === true
                ? 'supported'
                : 'unsupported';
        } catch {
            return 'unsupported';
        }
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
                // This raw SIGTERM is the gated restart primitive's signal. It
                // only fires inside the planned restart helper after the deferral policy allows it,
                // and the respawn re-verifies resume reachability.
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
        completionTimeoutMs?: number | null;
        canSignal?: () =>
            | PlannedRunnerRestartSignalGateResult
            | Promise<PlannedRunnerRestartSignalGateResult>;
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
            ...(input.completionTimeoutMs !== undefined
                ? {
                    timeoutMs:
                        input.completionTimeoutMs,
                }
                : {}),
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
                canSignal: input.canSignal
                    ?? (() => (
                        resolveSessionRunnerActivityDisabledReason(
                            input.sessionId,
                        ) ?? true
                    )),
                requestSignal: async (signalInput) => {
                    // Session-runner version refresh uses the shared forced-respawn
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
    const qualifiedConnectedAccountApi: ConnectedServiceQualifiedAuthGroupApi = {
        readGroup: ({ service, groupId, signal }) =>
            readQualifiedConnectedAccountGroupV4({
                token: params.credentials.token,
                group: { service, groupId },
                ...(signal ? { signal } : {}),
            }),
        listAccounts: ({ service, signal }) =>
            listQualifiedConnectedAccountsV4({
                token: params.credentials.token,
                service,
                ...(signal ? { signal } : {}),
            }),
    };

    const buildConnectedServiceAuthApplicationSession = (builderInput: Readonly<{
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
        serviceId: ConnectedAccountServiceKey;
        groupId: string | null;
        activeProfileId: string | null;
        generation: number | null;
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
                currentMachineId: params.machineId,
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
            // The FSM's restart-resume fallback when hot-apply is ineligible is
            // gated through deferral and spawn-time reachability.
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
        const nextGroupId = normalizeOptionalString(restartInput.groupId);
        const nextGeneration = normalizeNullableGeneration(restartInput.generation);
        if (
            !previousBinding
            || previousBinding.source !== 'connected'
            || !nextProfileId
            || (previousBinding.selection === 'group' && (!nextGroupId || nextGeneration === null))
        ) {
            return await signalRestartWithoutConfirmedApply();
        }
        const runtimeAuthApplyReason = normalizeRuntimeAuthApplyReason(builderInput.restartReason);
        // Reactive and proactive-quota auth-generation apply routes through
        // the FSM (hot-apply-in-place when eligible, else gated restart-resume with
        // reachability + deferral + mid-turn re-continue exactly once).
        const result = await applyConnectedServiceAuthGenerationToTrackedSession({
            getChildren: () => Array.from(params.pidToTrackedSession.values()),
            resolveInactiveSession: async ({ sessionId }) => {
                return await resolveInactiveConnectedServiceSessionContext({
                    token: params.credentials.token,
                    credentials: params.credentials,
                    sessionId,
                    currentMachineId: params.machineId,
                });
            },
            api: params.api,
            qualifiedConnectedAccountApi,
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
                    runtimeDescriptorV1: continuityContext.runtimeDescriptorV1,
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
                    groupId: previousBinding.selection === 'group' ? previousBinding.groupId : null,
                    loadGroupPolicy: previousBinding.selection === 'group' && previousBinding.groupId
                        ? async () => (await readQualifiedConnectedServiceAuthGroup({
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
            recoverAfterRuntimeAuthSwitch: createSelectionPostSwitchRecoveryHandler(),
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
            hotApply: createSessionConnectedServiceAuthHotApply({
                validateGroupMutationCurrentness: validateConnectedServiceGroupMutationCurrentness,
            }),
            registerHotApplyTargets: registerHotApplyRuntimeTarget,
            emitSessionEvent: async (sessionId, event) => {
                if (!shouldCommitAutomaticGroupApplySessionEvent(event, {
                    commitAccountSwitchEvents: builderInput.commitAccountSwitchEvents,
                    ...(builderInput.executionAuthority
                        ? { executionAuthority: builderInput.executionAuthority }
                        : {}),
                })) return;
                await commitConnectedServiceAccountSwitchSessionEventWithNotification({
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
                        [restartInput.serviceId]: previousBinding.selection === 'group'
                            ? {
                                ...previousBinding,
                                groupId: nextGroupId,
                                profileId: nextProfileId,
                            }
                            : {
                                ...previousBinding,
                                profileId: nextProfileId,
                            },
                    },
                },
                ...(previousBinding.selection === 'profile'
                    ? { rematerializeServiceId: restartInput.serviceId }
                    : {}),
                ...(previousBinding.selection === 'group' && nextGeneration !== null
                    ? {
                        expectedGroupGenerationByServiceId: {
                            [restartInput.serviceId]: nextGeneration,
                        },
                    }
                    : {}),
            },
            reason: 'automatic_runtime_failure',
        });
        return result;
    };

    /**
     * Accepts canonical qualified service keys; released scalar ids normalize through the
     * sole legacy ingress normalizer at the edge. Every group decision routes through the
     * qualified V4 coordinator; an unmapped identity has no group authority.
     */
    const createSessionQualifiedAuthGroupSwitchCoordinator = (input: Readonly<{
        sessionId: string;
        serviceId: ConnectedAccountServiceKey;
        reason: string;
        allowRestart?: boolean;
        executionAuthority?: ConnectedServiceGenerationExecutionAuthority;
    }>) => {
        if (params.resolveQualifiedConnectedAccountV4Support?.() !== 'advertised') {
            return null;
        }
        const qualifiedService =
            resolveQualifiedConnectedAccountServiceForIngressServiceId(
                input.serviceId,
            );
        if (!qualifiedService) return null;
        return createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
            token: params.credentials.token,
            quotaFreshnessMs: requestAuthGroupQuotaFreshnessMs,
            nowMs: () => Date.now(),
            leases: qualifiedConnectedAccountAuthGroupSwitchLeases,
            prepareCandidateForSwitch:
                prepareQualifiedAuthGroupCandidateForSwitch,
            // Session application carries the canonical qualified service key; first-party
            // scalars persist only inside the bounded V2/V3 compatibility seams.
            applyGeneration: async (generation) => await buildConnectedServiceAuthApplicationSession({
                sessionId: input.sessionId,
                restartReason: input.reason,
                commitAccountSwitchEvents: false,
                allowRestart: input.allowRestart,
                ...(input.executionAuthority
                    ? { executionAuthority: input.executionAuthority }
                    : {}),
            })({
                ...generation,
                serviceId: input.serviceId,
            }),
        });
    };

    const connectedServiceAuthGroupPreTurnSwitchCoordinator = {
        switchBeforeTurn: async (
            input: ConnectedServicePreTurnSwitchInput,
        ): Promise<ConnectedServicePreTurnSwitchResult> => {
            const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
            if (!sessionId) return { status: 'session_not_found' };
            const tracked = Array.from(params.pidToTrackedSession.values())
                .find((child) => child.happySessionId === sessionId) ?? null;
            if (!tracked) return { status: 'session_not_found' };
            const parsedServiceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(input.serviceId);
            const proactiveCoordinator = parsedServiceId
                ? createSessionQualifiedAuthGroupSwitchCoordinator({
                sessionId,
                serviceId: parsedServiceId,
                reason: input.reason,
            })
                : null;
            if (!proactiveCoordinator) {
                return {
                    status: 'qualified_connected_account_v4_unavailable',
                    generation: 0,
                };
            }
            const qualifiedService =
                resolveQualifiedConnectedAccountServiceForIngressServiceId(
                    parsedServiceId,
                );
            if (!qualifiedService) {
                return {
                    status: 'qualified_connected_account_v4_unavailable',
                    generation: 0,
                };
            }
            const proactiveSwitchResult = await proactiveCoordinator.switchBeforeTurn({
                ...input,
                serviceId: qualifiedService,
            });
            logger.debug('[DAEMON RUN] Connected-service proactive quota switch attempt', {
                trigger: 'automatic_group_switch',
                decision: 'qualified_v4_switch_before_turn',
                sessionId,
                serviceId: input.serviceId,
                groupId: input.groupId,
                reason: input.reason,
                resultStatus: proactiveSwitchResult.status,
                routedThroughQualifiedV4: true,
            });
            return proactiveSwitchResult;
        },
        applyCommittedGeneration: async (input: Readonly<{
            sessionId: string;
            serviceId: ConnectedAccountServiceKey;
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
            const parsedServiceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(input.serviceId);
            const recipientCoordinator = parsedServiceId
                ? createSessionQualifiedAuthGroupSwitchCoordinator({
                    sessionId,
                    serviceId: parsedServiceId,
                    reason: input.reason,
                    allowRestart: input.allowRestart,
                    ...(input.executionAuthority
                        ? { executionAuthority: input.executionAuthority }
                        : {}),
                })
                : null;
            if (!recipientCoordinator || !parsedServiceId) {
                return {
                    status: 'generation_apply_failed',
                    generation: input.generation,
                    errorCode: 'qualified_connected_account_v4_unavailable',
                };
            }
            const qualifiedService =
                resolveQualifiedConnectedAccountServiceForIngressServiceId(
                    parsedServiceId,
                );
            if (!qualifiedService) {
                return {
                    status: 'generation_apply_failed',
                    generation: input.generation,
                    errorCode: 'qualified_connected_account_v4_unavailable',
                };
            }
            // Recipients consume the source session's immutable committed generation. They must
            // never re-enter selection/CAS and independently advance the group generation.
            const result = await recipientCoordinator.applyCommittedGeneration({
                ...input,
                serviceId: qualifiedService,
            });
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
        applyCredentialUpdate: async (input: Readonly<{
            sessionId: string;
            serviceId: ConnectedServiceId;
            profileId: string;
            reason: 'account_changed' | 'auth_expired';
            executionAuthority: ConnectedServiceExecutionAuthorityV1;
        }>) => {
            const sessionId = input.sessionId.trim();
            const tracked = Array.from(params.pidToTrackedSession.values())
                .find((child) => child.happySessionId === sessionId) ?? null;
            if (!sessionId || !tracked) {
                return { status: 'failed' as const, errorCode: 'session_not_found' };
            }
            const childSelection = readConnectedServiceChildSelectionsFromEnv(
                tracked.spawnOptions?.environmentVariables ?? {},
            )?.get(input.serviceId);
            const groupSelection = childSelection?.kind === 'group'
                && childSelection.activeProfileId === input.profileId
                ? childSelection
                : null;
            const result = await buildConnectedServiceAuthApplicationSession({
                sessionId,
                restartReason: input.reason,
                commitAccountSwitchEvents: false,
                allowRestart: input.executionAuthority !== 'passive_projection',
                executionAuthority: input.executionAuthority,
            })({
                sessionId,
                serviceId: input.serviceId,
                groupId: groupSelection?.groupId ?? null,
                activeProfileId: input.profileId,
                generation: groupSelection?.generation ?? null,
                reason: input.reason,
            });
            if (!result.ok) {
                return { status: 'failed' as const, errorCode: result.errorCode };
            }
            const action = 'action' in result ? result.action : undefined;
            switch (action) {
                case 'hot_applied':
                    return { status: 'hot_applied' as const };
                case 'restart_requested':
                    return { status: 'restart_requested' as const };
                default:
                    return { status: 'unchanged' as const };
            }
        },
    };

    /**
     * Gated restart adapter consumed by the canonical session-auth application owner
     * when a provider cannot adopt the selected credential in place. Credential refresh,
     * reconnect, manual selection, and quota switching all reach that owner first.
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
            // Refresh/reconnect restart is deferred until the turn boundary and
            // reachability re-verified at respawn (no raw mid-turn SIGTERM). Propagate whether a
            // signal was actually emitted so the refresh handler reserves the pid only when it was —
            // a superseded/cancelled deferral must not leak a reservation.
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

    let foregroundAgentRuntimeHttpPort: number | null = null;
    const foregroundAgentRuntimeAdmission =
        createForegroundAgentRuntimeAdmissionOwner({
            prepare: (request) =>
                prepareForegroundAgentRuntimeAdmission(request, {
                    ...(params.activateSessionPurposeBindings
                        ? {
                            activateSessionPurposeBindings:
                                params.activateSessionPurposeBindings,
                        }
                        : {}),
                    ...(params.resolveCurrentSessionPurposeBindingSnapshot
                        ? {
                            resolveExternalAgentSessionPurposeBindingSnapshot:
                                async ({ authorizedPurposes, signal }) =>
                                    await params
                                        .resolveCurrentSessionPurposeBindingSnapshot!({
                                            authorizedPurposes,
                                            signal,
                                        }),
                        }
                        : {}),
                    resolveConnectedServiceAuthForSpawn: async (input) => {
                        const entry = findCatalogEntry(input.agentId);
                        if (
                            !entry
                            || readDeclaredCatalogConnectedServiceIds(entry).length === 0
                        ) {
                            return null;
                        }
                        const accountSettings =
                            getActiveAccountSettingsSnapshot()?.settings
                            ?? null;
                        const resumeReachabilityRequired =
                            Boolean(input.vendorResumeId)
                            && resolveConnectedServicesProviderStateSharingPolicyV1(
                                (accountSettings as Readonly<
                                    Record<string, unknown>
                                > | null)
                                    ?.connectedServicesProviderStateSharingSettingsV1,
                                input.agentId,
                            ).stateMode === 'shared';
                        return await resolveConnectedServiceAuthForSpawn({
                            ...input,
                            agentId: input.agentId,
                            activeServerDir: configuration.activeServerDir,
                            baseDir:
                                params.connectedServicesMaterializationBaseDir,
                            credentials: params.credentials,
                            api: params.api,
                            accountUsageStore: providerAccountUsageStore,
                            quotaFreshnessMs: 5 * 60_000,
                            nowMs: () => Date.now(),
                            authGroupSwitchCoordinator:
                                connectedServiceAuthGroupPreTurnSwitchCoordinator,
                            predictiveSwitchGuard:
                                connectedServicePredictiveSwitchGuard ?? null,
                            accountSettings,
                            processEnv: params.processEnv ?? process.env,
                            credentialRefreshService:
                                params.getConnectedServiceRefreshCoordinator(),
                            resumeReachabilityRequired,
                            allowLegacyUnfencedOneShotMaterialization: true,
                            serverContract:
                                params.getApiMachineForSessions()
                                    ?.getSessionSyncPendingInputServerContractResult()
                                ?? null,
                        });
                    },
                    resolveDaemonSpawnHooks: async (agentId) => {
                        const entry = findCatalogEntry(agentId);
                        const getDaemonSpawnHooks = entry?.getDaemonSpawnHooks;
                        return getDaemonSpawnHooks
                            ? await getDaemonSpawnHooks()
                            : null;
                    },
                    connectedAccountRequestAuthRegistry,
                    resolveConnectedAccountRequestAuthHttpPort:
                        requireConnectedAccountRequestAuthHttpPort,
                    connectedServicesMaterializationBaseDir:
                        params.connectedServicesMaterializationBaseDir,
                }),
            getHttpPort: () => {
                if (!foregroundAgentRuntimeHttpPort) {
                    throw new Error(
                        'Foreground Agent runtime daemon service is unavailable',
                    );
                }
                return foregroundAgentRuntimeHttpPort;
            },
            promoteDaemonServiceAuthority: async (input) => {
                return await promoteForegroundDaemonServiceAuthority({
                    happyHomeDir: configuration.happyHomeDir,
                    publicReleaseRing:
                        configuration.publicReleaseRing,
                    trackedSessions: params.pidToTrackedSession,
                    ...input,
                });
            },
        });
    const externalSessionHostOperationOwner =
        params.externalSessionHostOperationOwner
        ?? createExternalSessionHostOperationOwner();
    const createSessionManagedProviderCustodyDispatchForSession = async (
        sessionId: string,
    ): Promise<RunnerManagedServicesCustodyDispatchV1> => {
        const transport = await resolveSessionTransportContext({
            credentials: params.credentials,
            idOrPrefix: sessionId,
        });
        if (!transport.ok || transport.sessionId !== sessionId) {
            throw new PluginError({
                code: 'plugin_services_managed_provider_custody_unavailable',
                message:
                    'Runner managed Provider custody transport is unavailable',
            });
        }
        return async (request, options) => {
                if (options?.signal?.aborted) {
                    throw new PluginError({
                        code: 'plugin_operation_aborted',
                        message:
                            'Runner managed Provider custody operation was aborted',
                    });
                }
                const rpc = {
                    token: params.credentials.token,
                    sessionId: transport.sessionId,
                    method:
                        `${transport.sessionId}:${RUNNER_MANAGED_SERVICES_CUSTODY_RPC_METHOD}`,
                    request,
                };
                const raw = transport.mode === 'plain'
                    ? await callSessionRpc({
                        ...rpc,
                        mode: 'plain',
                    })
                    : await callSessionRpc({
                        ...rpc,
                        mode: 'e2ee',
                        ctx: transport.ctx,
                    });
                if (options?.signal?.aborted) {
                    throw new PluginError({
                        code: 'plugin_operation_aborted',
                        message:
                            'Runner managed Provider custody operation was aborted',
                    });
                }
                return RunnerManagedServicesCustodyResultV1Schema
                    .parse(raw);
        };
    };
    const createSessionManagedProviderCustodyDispatch = async (
        scope: RunnerManagedProviderCustodyScopeV1,
    ): Promise<RunnerManagedServicesCustodyDispatchV1> =>
        await createSessionManagedProviderCustodyDispatchForSession(
            scope.sessionId,
        );
    const createSessionManagedServiceEndpointReadRpc = async (
        sessionId: string,
    ) => {
        const transport = await resolveSessionTransportContext({
            credentials: params.credentials,
            idOrPrefix: sessionId,
        });
        if (!transport.ok || transport.sessionId !== sessionId) {
            throw new PluginError({
                code: 'plugin_services_managed_provider_custody_unavailable',
                message:
                    'Runner managed-service request transport is unavailable',
            });
        }
        return Object.freeze({
            async call(rpcInput: Readonly<{
                method: string;
                request: unknown;
                timeoutMs: number;
                signal?: AbortSignal;
            }>): Promise<unknown> {
                const common = {
                    token: params.credentials.token,
                    sessionId: transport.sessionId,
                    method:
                        `${transport.sessionId}:${rpcInput.method}`,
                    request: rpcInput.request,
                    timeoutMs: rpcInput.timeoutMs,
                    ...(rpcInput.signal
                        ? { signal: rpcInput.signal }
                        : {}),
                };
                return transport.mode === 'plain'
                    ? await callSessionRpc({
                        ...common,
                        mode: 'plain',
                    })
                    : await callSessionRpc({
                        ...common,
                        mode: 'e2ee',
                        ctx: transport.ctx,
                    });
            },
        });
    };
    const createSessionManagedProviderCustodyClient = async (
        scope: RunnerManagedProviderCustodyScopeV1,
        dependencies: Parameters<
            typeof createRunnerManagedServicesClient
        >[0]['dependencies'],
    ) => {
        return createRunnerManagedServicesClient({
            scope,
            dependencies,
            dispatch:
                await createSessionManagedProviderCustodyDispatch(
                    scope,
                ),
            endpointReadRpc:
                await createSessionManagedServiceEndpointReadRpc(
                    scope.sessionId,
                ),
        });
    };
    const runnerDaemonPluginServicesHost =
        createRunnerDaemonPluginServicesHost({
            createInvocation: async ({
                sessionId,
                runner,
                retainedAgent,
                invocationId,
                witness,
                managedProviderRetention,
                signal,
            }) => {
                const tracked =
                    findTrackedSessionByHappySessionId(
                        params.pidToTrackedSession.values(),
                        sessionId,
                    );
                if (
                    !tracked
                    || !authorizeTrackedRunnerAgentDaemonServiceOperation({
                        tracked,
                        sessionId,
                        runner,
                        retainedAgent,
                        witness: undefined,
                        allowIdleCurrentGeneration: true,
                    })
                ) {
                    throw new PluginError({
                        code:
                            'plugin_services_runner_authority_unavailable',
                        message:
                            'Runner PluginServices exact runner authority is unavailable',
                    });
                }
                const trackedInvocationContext =
                    tracked.runnerAgentInvocationContext;
                const invocationContext =
                    trackedInvocationContext
                        ? Object.freeze({
                            cwd: trackedInvocationContext.cwd,
                            environment: Object.freeze({}),
                            ...(trackedInvocationContext.agentCliLaunch
                                ? {
                                    agentCliLaunch:
                                        trackedInvocationContext
                                            .agentCliLaunch,
                                }
                                : {}),
                            providerBindingActive:
                                trackedInvocationContext
                                    .providerBindingActive,
                        })
                        : null;
                if (!invocationContext) {
                    throw new PluginError({
                        code:
                            'plugin_services_invocation_context_unavailable',
                        message:
                            'Runner PluginServices invocation context is unavailable',
                    });
                }
                const lease =
                    await acquireAuthoritativePluginRuntimeRegistryLease({
                        happyHomeDir:
                            configuration.happyHomeDir,
                    });
                let releaseLease = true;
                const supervisionLaunchAuthorities = new Map<
                    string,
                    RunnerManagedProviderServerLaunchAuthority
                >();
                const readSupervisionLaunchAuthority = (
                    serverId: string,
                ): RunnerManagedProviderServerLaunchAuthority | null =>
                    supervisionLaunchAuthorities.get(serverId) ?? null;
                const stampSupervisionLaunchAuthority = (
                    spec: ManagedServiceSpec,
                ): void => {
                    const expected =
                        projectRunnerManagedProviderServerLaunchAuthority(
                            spec,
                        );
                    if (!expected) return;
                    const existing = supervisionLaunchAuthorities.get(
                        expected.serverId,
                    );
                    if (existing) {
                        if (!isDeepStrictEqual(existing, expected)) {
                            throw new PluginError({
                                code:
                                    'plugin_managed_service_spec_conflict',
                                message:
                                    'A different managed-service specification already owns this exact lifecycle scope',
                            });
                        }
                        return;
                    }
                    supervisionLaunchAuthorities.set(
                        expected.serverId,
                        expected,
                    );
                };
                const managedProviderCleanup: {
                    current: (() => void | Promise<void>) | null;
                } = { current: null };
                const cleanupManagedProvider = async () => {
                    supervisionLaunchAuthorities.clear();
                    const cleanup = managedProviderCleanup.current;
                    managedProviderCleanup.current = null;
                    await cleanup?.();
                };
                let releaseManagedProviderInvocation = true;
                try {
                    const registration =
                        lease.registry.agentRuntimesByAgentId.get(
                            retainedAgent.agentId,
                        );
                    let isCurrent = false;
                    try {
                        isCurrent =
                            registration?.isCurrent() === true;
                    } catch {
                        isCurrent = false;
                    }
                    const binding =
                        registration?.hasPrimaryRuntime === true
                            ? registration
                                .sessionRunnerFactoryBinding
                            : undefined;
                    const currentRegistrationIsExact = Boolean(
                        registration
                        && registration.hasPrimaryRuntime
                        && binding
                        && isCurrent
                        && registration.pluginId
                            === retainedAgent.pluginId
                        && registration.pluginVersion
                            === retainedAgent.pluginVersion
                        && registration.agentId
                            === retainedAgent.agentId
                        && registration.immutableGenerationId
                            === retainedAgent.immutableGenerationId
                        && isDeepStrictEqual(binding, retainedAgent),
                    );
                    const capturedAgentRegistration =
                        currentRegistrationIsExact
                            ? registration!
                            : null;
                    const capturedAgentProviderBinding =
                        capturedAgentRegistration
                            ? readLeasedAgentProviderBindingAdapter({
                                lease,
                                agentId:
                                    capturedAgentRegistration.agentId,
                            })
                            : null;
                    const isCapturedAgentRegistrationPreOpen =
                        (): boolean => {
                            if (
                                !capturedAgentRegistration
                                || !capturedAgentProviderBinding
                                || capturedAgentRegistration
                                    .providerBinding
                                    !== capturedAgentProviderBinding.adapter
                                || capturedAgentRegistration.pluginId
                                    !== capturedAgentProviderBinding.pluginId
                                || tracked
                                    .agentRuntimeDaemonServiceSessionOpenAttestation
                                    !== undefined
                                || tracked
                                    .agentRuntimeDaemonServiceAdmittedTurnId
                                    !== undefined
                            ) {
                                return false;
                            }
                            try {
                                return capturedAgentRegistration
                                    .isCurrent() === true;
                            } catch {
                                return false;
                            }
                        };
                    const authorizeOperation = (
                        operationWitness:
                            typeof witness,
                        options?: Readonly<{
                            requireActiveTurn?: boolean;
                        }>,
                    ): boolean =>
                        authorizeTrackedRunnerAgentDaemonServiceOperation({
                            tracked,
                            sessionId,
                            runner,
                            retainedAgent,
                            witness:
                                operationWitness,
                            allowIdleCurrentGeneration:
                                options?.requireActiveTurn
                                    !== true,
                        });
                    if (!authorizeOperation(witness)) {
                        throw new PluginError({
                            code:
                                'plugin_services_turn_authority_unavailable',
                            message:
                            'Runner PluginServices turn authority is unavailable',
                        });
                    }
                    const revalidateAdoptedManagedProviderPolicy = async (
                        runtimeBindingBasis:
                            ProviderRuntimeBindingBasisV1,
                    ): Promise<boolean> => {
                        const trackedSelection =
                            tracked.spawnOptions
                                ?.modelSelection?.ref
                            ?? null;
                        const trackedMetadata =
                            tracked.spawnOptions
                                ?.providerBindingMetadataV1
                            ?? null;
                        if (
                            !trackedSelection
                            || trackedSelection
                                .providerConnectionId === null
                            || !trackedMetadata
                        ) return false;
                        try {
                            resolveDaemonSessionModelTransitionAuthority({
                                trackedAgentId:
                                    resolveTrackedSessionCatalogAgentId(
                                        tracked,
                                    ),
                                authorizedAgentId:
                                    retainedAgent.agentId,
                                trackedSelection,
                                trackedSessionBindingMetadata:
                                    trackedMetadata,
                                requestAgentId:
                                    retainedAgent.agentId,
                                requestedSelection: {
                                    ...trackedSelection,
                                    providerConnectionId:
                                        trackedSelection
                                            .providerConnectionId,
                                },
                            });
                            const accountSnapshot =
                                getActiveAccountSettingsSnapshot();
                            if (!accountSnapshot) return false;
                            const providerSettings =
                                readProviderSettingsForCli(
                                    accountSnapshot.settings,
                                ).settings;
                            return isRetainedManagedProviderSettingsGrantCurrent({
                                machineId: params.machineId,
                                providerSettings,
                                runtimeBindingBasis,
                            });
                        } catch {
                            return false;
                        }
                    };
                    let managedProvider = await (async () => {
                        if (managedProviderRetention) {
                            const retained =
                                managedProviderRetention;
                            const scope = retained.scope;
                            if (
                                scope.sessionId
                                    !== sessionId
                            ) {
                                throw new PluginError({
                                    code:
                                        'plugin_services_managed_provider_retention_mismatch',
                                    message:
                                        'Retained managed Provider authority belongs to another Session',
                                });
                            }
                            const createRetainedInvocation =
                                lease.registry
                                    .createRetainedManagedProviderRuntimeInvocationServices;
                            if (!createRetainedInvocation) {
                                throw new PluginError({
                                    code:
                                        'plugin_services_managed_provider_authority_unavailable',
                                    message:
                                        'Retained managed Provider invocation services are unavailable',
                                });
                            }
                            const storePaths =
                                resolvePluginStorePaths({
                                    happyHomeDir:
                                        configuration.happyHomeDir,
                                });
                            const readsRetainedAuthorityCurrent =
                                (): boolean => {
                                    const currentBasis =
                                        tracked.spawnOptions
                                            ?.providerBindingMetadataV1
                                            ?.runtimeBindingBasis;
                                    return !signal.aborted
                                        && authorizeTrackedRunnerAgentDaemonServiceOperation({
                                            tracked,
                                            sessionId,
                                            runner,
                                            retainedAgent,
                                            witness: undefined,
                                            allowIdleCurrentGeneration: true,
                                        })
                                        && currentBasis !== undefined
                                        && sameProviderRuntimeBindingBasis(
                                            currentBasis,
                                            scope.runtimeBindingBasis,
                                        );
                                };
                            const retainedCustodyDispatch =
                                await createSessionManagedProviderCustodyDispatch(
                                    scope,
                                );
                            let retainedProviderPolicyFence:
                                Promise<void> | null = null;
                            let retainedProviderPolicyFenced = false;
                            const fenceRetainedProviderPolicy = async () => {
                                if (retainedProviderPolicyFenced) return;
                                if (!retainedProviderPolicyFence) {
                                    const fenceAttempt = (async () => {
                                            const result =
                                                await retainedCustodyDispatch({
                                                    v: 1,
                                                    kind:
                                                        'fenceRetainedProviderPolicy',
                                                    claim: scope,
                                                });
                                            if (
                                                result.kind
                                                    !== 'retainedProviderPolicyFenced'
                                            ) {
                                                throw new PluginError({
                                                    code:
                                                        'plugin_services_managed_provider_custody_unavailable',
                                                    message:
                                                        'Runner returned an invalid retained Provider policy-fence result',
                                                });
                                            }
                                        })();
                                    retainedProviderPolicyFence = fenceAttempt;
                                    try {
                                        await fenceAttempt;
                                        retainedProviderPolicyFenced = true;
                                    } finally {
                                        if (
                                            retainedProviderPolicyFence
                                                === fenceAttempt
                                        ) {
                                            retainedProviderPolicyFence = null;
                                        }
                                    }
                                    return;
                                }
                                await retainedProviderPolicyFence;
                            };
                            const revalidateRetainedProviderPolicy =
                                async (): Promise<boolean> =>
                                    await revalidateAdoptedManagedProviderPolicy(
                                        scope.runtimeBindingBasis,
                                    );
                            const readAdoptedPublicOutcome = async () => {
                                const outcome =
                                    await retainedCustodyDispatch({
                                        v: 1,
                                        kind:
                                            'readAdoptedPublicOutcome',
                                        claim: scope,
                                    });
                                return outcome.kind
                                    === 'adoptedPublicOutcome'
                                    ? outcome.outcome
                                    : null;
                            };
                            const currentHardRevocationRevision =
                                await readCurrentPluginHardRevocationRevision({
                                    paths: storePaths,
                                    pluginId: scope.pluginId,
                                });
                            if (
                                currentHardRevocationRevision
                                    !== retained
                                        .providerPluginHardRevocationRevisionAtAdmission
                                || !await readCurrentPluginImmutableGenerationIntegrityCurrentness({
                                    paths: storePaths,
                                    pluginId: scope.pluginId,
                                    immutableGenerationId:
                                        scope.immutableGenerationId,
                                    bundledArtifacts:
                                        BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
                                    retainedManifestAuthority:
                                        scope.manifestAuthority,
                                })
                            ) {
                                throw new PluginError({
                                    code:
                                        'plugin_services_managed_provider_authority_unavailable',
                                    message:
                                        'Retained managed Provider authority was hard-revoked',
                                });
                            }
                            const created =
                                await createRetainedInvocation({
                                    scope: {
                                        sessionId:
                                            scope.sessionId,
                                        runtimeBindingBasis:
                                            scope.runtimeBindingBasis,
                                        identity: {
                                            pluginId:
                                                scope.pluginId,
                                            localId:
                                                scope.providerLocalId,
                                        },
                                        activationGeneration:
                                            scope.activationGeneration,
                                        immutableGenerationId:
                                            scope.immutableGenerationId,
                                        manifestAuthority:
                                            scope.manifestAuthority,
                                        operationClaimId:
                                            scope.operationClaimId,
                                    },
                                    signal,
                                    isCurrent:
                                        readsRetainedAuthorityCurrent,
                                    readAdoptedPublicOutcome,
                                    revalidatePolicy:
                                        revalidateRetainedProviderPolicy,
                                });
                            if (!created) {
                                throw new PluginError({
                                    code:
                                        'plugin_services_managed_provider_authority_unavailable',
                                    message:
                                        'Retained managed Provider authority could not be reauthorized',
                                });
                            }
                            managedProviderCleanup.current = () =>
                                created.cleanup();
                            const bootstrap = created.bootstrap;
                            if (
                                bootstrap.identity.pluginId
                                    !== scope.pluginId
                                || bootstrap.identity.localId
                                    !== scope.providerLocalId
                                || bootstrap.activationGeneration
                                    !== scope.activationGeneration
                                || bootstrap.immutableGenerationId
                                    !== scope.immutableGenerationId
                                || bootstrap.manifestAuthority
                                    !== scope.manifestAuthority
                                || bootstrap.operationClaimId
                                    !== scope.operationClaimId
                                || await readCurrentPluginHardRevocationRevision({
                                    paths: storePaths,
                                    pluginId: scope.pluginId,
                                }) !== currentHardRevocationRevision
                                || !await readCurrentPluginImmutableGenerationIntegrityCurrentness({
                                    paths: storePaths,
                                    pluginId: scope.pluginId,
                                    immutableGenerationId:
                                        scope.immutableGenerationId,
                                    bundledArtifacts:
                                        BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
                                    retainedManifestAuthority:
                                        scope.manifestAuthority,
                                })
                            ) {
                                throw new PluginError({
                                    code:
                                        'plugin_services_managed_provider_retention_mismatch',
                                    message:
                                        'Replacement daemon reconstructed a different managed Provider authority',
                                    });
                            }
                            const isRetainedProviderCurrent = async () =>
                                await isRetainedManagedProviderInvocationCurrent({
                                    readsRetainedAuthorityCurrent,
                                    revalidatePolicy:
                                        revalidateRetainedProviderPolicy,
                                    fenceRetainedPolicy:
                                        fenceRetainedProviderPolicy,
                                    readHardRevocationRevision: async () =>
                                        await readCurrentPluginHardRevocationRevision({
                                            paths: storePaths,
                                            pluginId:
                                                scope.pluginId,
                                        }),
                                    readGenerationIntegrityCurrentness:
                                        async () =>
                                            await readCurrentPluginImmutableGenerationIntegrityCurrentness({
                                                paths: storePaths,
                                                pluginId:
                                                    scope.pluginId,
                                                immutableGenerationId:
                                                    scope.immutableGenerationId,
                                                bundledArtifacts:
                                                    BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
                                                retainedManifestAuthority:
                                                    scope.manifestAuthority,
                                            }),
                                    hardRevocationRevisionAtAdmission:
                                        currentHardRevocationRevision,
                                });
                            const retainedSessionBindingMetadata =
                                tracked.spawnOptions
                                    ?.providerBindingMetadataV1;
                            if (
                                !retainedSessionBindingMetadata
                                || !retainedSessionBindingMetadata
                                    .runtimeBindingBasis
                                || !sameProviderRuntimeBindingBasis(
                                    retainedSessionBindingMetadata
                                        .runtimeBindingBasis,
                                    scope.runtimeBindingBasis,
                                )
                            ) {
                                throw new PluginError({
                                    code:
                                        'plugin_services_managed_provider_materialization_authority_changed',
                                    message:
                                        'Retained managed Provider binding metadata is unavailable',
                                });
                            }
                            return Object.freeze({
                                bootstrap: Object.freeze({
                                    v: 1 as const,
                                    scope,
                                    requestAuth:
                                        bootstrap.requestAuth,
                                    providerPluginHardRevocationRevisionAtAdmission:
                                        currentHardRevocationRevision,
                                    sessionBindingMetadata:
                                        retainedSessionBindingMetadata,
                                }),
                                connectedAccounts:
                                    created.connectedAccounts,
                                readSupervisionLaunchAuthority,
                                start: async () => {
                                    const outcome =
                                        await readAdoptedPublicOutcome();
                                    if (
                                        !outcome
                                        || outcome.operationClaimId
                                            !== scope.operationClaimId
                                        || !outcome.endpointTemplateIds
                                            .includes(
                                                scope
                                                    .runtimeBindingBasis
                                                    .endpoint
                                                    .endpointTemplateId,
                                            )
                                        || !await isRetainedProviderCurrent()
                                    ) {
                                        throw new PluginError({
                                            code:
                                                'plugin_services_managed_provider_authority_unavailable',
                                            message:
                                                'Retained managed Provider public outcome is unavailable',
                                        });
                                    }
                                },
                                materializeAgentBinding: async ({
                                    endpointUrl,
                                    credentialPlaceholder,
                                }: Readonly<{
                                    endpointUrl: string;
                                    credentialPlaceholder: string;
                                }>) => {
                                    const basis =
                                        scope.runtimeBindingBasis;
                                    const metadata = tracked.spawnOptions
                                        ?.providerBindingMetadataV1;
                                    const outcome =
                                        await readAdoptedPublicOutcome();
                                    const endpoint = outcome?.endpoints
                                        .find((entry) => (
                                            entry.endpointTemplateId
                                                === basis.endpoint
                                                    .endpointTemplateId
                                        ));
                                    let assessed:
                                        ReturnType<
                                            typeof assessProviderEndpoint
                                        > | null = null;
                                    try {
                                        assessed = assessProviderEndpoint(
                                            endpointUrl,
                                        );
                                    } catch {
                                        assessed = null;
                                    }
                                    if (
                                        !capturedAgentProviderBinding
                                        || !basis
                                            .runtimeCredentialTransport
                                        || !metadata?.model
                                        || !endpoint
                                        || !assessed
                                        || assessed.normalizedUrl
                                            !== endpoint.endpointUrl
                                    ) {
                                        await cleanupManagedProvider()
                                            .catch(() => undefined);
                                        throw new PluginError({
                                            code:
                                                'plugin_services_managed_provider_materialization_authority_changed',
                                            message:
                                                'Retained managed Provider pre-open materialization authority is unavailable',
                                        });
                                    }
                                    return await materializeRunnerManagedProviderAgentBinding({
                                        capturedAgentBinding:
                                            capturedAgentProviderBinding,
                                        isCapturedAgentRegistrationCurrent:
                                            isCapturedAgentRegistrationPreOpen,
                                        isManagedProviderCurrent:
                                            isRetainedProviderCurrent,
                                        cleanup:
                                            cleanupManagedProvider,
                                        binding: {
                                            v: 1,
                                            agentTargetKey:
                                                basis.agentTargetKey,
                                            selection: {
                                                connectionId:
                                                    basis.connectionId,
                                                model:
                                                    metadata.model,
                                            },
                                            contributionKey:
                                                basis.contributionKey,
                                            endpoint: {
                                                endpointTemplateId:
                                                    basis.endpoint
                                                        .endpointTemplateId,
                                                normalizedUrl:
                                                    assessed.normalizedUrl,
                                                protocol:
                                                    basis.endpoint.protocol,
                                                publicHeaders:
                                                    basis.endpoint
                                                        .publicHeaders,
                                            },
                                            runtimeCredentialTransport:
                                                basis
                                                    .runtimeCredentialTransport,
                                            compatibilityFingerprint:
                                                metadata
                                                    .compatibilityFingerprint,
                                        },
                                        prepared:
                                            basis.prepared,
                                        credential: {
                                            kind: 'apiKey',
                                            transport:
                                                basis
                                                    .runtimeCredentialTransport,
                                            value:
                                                credentialPlaceholder,
                                        },
                                    });
                                },
                                isCurrent:
                                    isRetainedProviderCurrent,
                            });
                        }
                        const trackedSelection =
                            tracked.spawnOptions
                                ?.modelSelection?.ref
                            ?? null;
                        const trackedBindingMetadata =
                            tracked.spawnOptions
                                ?.providerBindingMetadataV1
                            ?? null;
                        const trackedRuntimeBindingBasis =
                            trackedBindingMetadata
                                ?.runtimeBindingBasis
                            ?? null;
                        if (
                            !trackedSelection
                            || trackedSelection
                                .providerConnectionId === null
                            || !trackedRuntimeBindingBasis
                            || trackedRuntimeBindingBasis
                                .deployment.kind
                                !== 'managedLocal'
                        ) {
                            return null;
                        }
                        const authority =
                            resolveDaemonSessionModelTransitionAuthority({
                                trackedAgentId:
                                    resolveTrackedSessionCatalogAgentId(
                                        tracked,
                                    ),
                                authorizedAgentId:
                                    retainedAgent.agentId,
                                trackedSelection,
                                trackedSessionBindingMetadata:
                                    trackedBindingMetadata,
                                requestAgentId:
                                    retainedAgent.agentId,
                                requestedSelection: {
                                    ...trackedSelection,
                                    providerConnectionId:
                                        trackedSelection
                                            .providerConnectionId,
                                },
                            });
                        const authorization =
                            await authorizeSessionModelTransitionProviderTargetWithLease({
                                sessionId,
                                machineId: params.machineId,
                                agentId: authority.agentId,
                                agentTargetKey:
                                    authority.agentTargetKey,
                                lease,
                                input: authority.input,
                            });
                        const runtimeBindingBasis =
                            authorization.runtimeBindingBasis;
                        if (
                            runtimeBindingBasis.deployment.kind
                                !== 'managedLocal'
                        ) {
                            throw new PluginError({
                                code:
                                    'plugin_services_managed_provider_authority_unavailable',
                                message:
                                    'Runner Provider authorization is not a managed-local binding',
                            });
                        }
                        if (!sameProviderRuntimeBindingBasis(
                            trackedRuntimeBindingBasis,
                            runtimeBindingBasis,
                        )) {
                            throw new PluginError({
                                code:
                                    'plugin_services_managed_provider_authority_unavailable',
                                message:
                                    'Runner managed Provider authorization is not current for this Session binding',
                            });
                        }
                        const identity =
                            runtimeBindingBasis.deployment
                                .implementationIdentity;
                        const createInvocation =
                            lease.registry
                                .createManagedProviderRuntimeInvocationServices;
                        if (!createInvocation) {
                            throw new PluginError({
                                code:
                                    'plugin_services_managed_provider_authority_unavailable',
                                message:
                                    'Managed Provider runtime invocation services are unavailable',
                            });
                        }
                        const storePaths =
                            resolvePluginStorePaths({
                                happyHomeDir:
                                    configuration.happyHomeDir,
                            });
                        const providerPluginHardRevocationRevisionAtAdmission =
                            await readCurrentPluginHardRevocationRevision({
                                paths: storePaths,
                                pluginId: identity.pluginId,
                            });
                        let readAdoptedPublicOutcome:
                            ReturnType<
                                typeof createRunnerManagedServicesClient
                            >['readAdoptedPublicOutcome'] | null = null;
                        let fenceRetainedProviderPolicy:
                            ReturnType<
                                typeof createRunnerManagedServicesClient
                            >['fenceRetainedProviderPolicy'] | null = null;
                        const readsSessionProviderAuthorityCurrent =
                            (): boolean => {
                                const currentBasis =
                                    tracked.spawnOptions
                                        ?.providerBindingMetadataV1
                                        ?.runtimeBindingBasis;
                                return !signal.aborted
                                    && authorizeTrackedRunnerAgentDaemonServiceOperation({
                                        tracked,
                                        sessionId,
                                        runner,
                                        retainedAgent,
                                        witness: undefined,
                                        allowIdleCurrentGeneration: true,
                                    })
                                    && currentBasis !== undefined
                                    && sameProviderRuntimeBindingBasis(
                                        currentBasis,
                                        runtimeBindingBasis,
                                    );
                            };
                        const revalidateSessionProviderAuthority =
                            async (): Promise<boolean> => {
                                if (!readsSessionProviderAuthorityCurrent()) {
                                    return false;
                                }
                                try {
                                    const refreshed =
                                        await authorizeSessionModelTransitionProviderTargetWithLease({
                                            sessionId:
                                                sessionId,
                                            machineId:
                                                params.machineId,
                                            agentId:
                                                authority.agentId,
                                            agentTargetKey:
                                                authority.agentTargetKey,
                                            lease,
                                            input: authority.input,
                                    });
                                    return readsSessionProviderAuthorityCurrent()
                                        && sameProviderRuntimeBindingBasis(
                                            refreshed
                                                .runtimeBindingBasis,
                                            runtimeBindingBasis,
                                        )
                                        && await readCurrentPluginHardRevocationRevision({
                                            paths: storePaths,
                                            pluginId:
                                                identity.pluginId,
                                        })
                                            === providerPluginHardRevocationRevisionAtAdmission;
                                } catch {
                                    return false;
                                }
                            };
                        const createdManagedProviderInvocation =
                            await createInvocation({
                                identity,
                                purposeBindings:
                                    runtimeBindingBasis
                                        .deployment.purposeBindings,
                                operationClaim: {
                                    kind: 'sessionDemand',
                                    sessionId,
                                    runtimeBindingBasis,
                                    bindSessionCustody: async (
                                        custodyScope,
                                        dependencies,
                                    ) => {
                                        const runnerCustodyScope:
                                            RunnerManagedProviderCustodyScopeV1 =
                                                Object.freeze({
                                                    v: 1,
                                                    sessionId:
                                                        custodyScope
                                                            .sessionId,
                                                    runtimeBindingBasis:
                                                        custodyScope
                                                            .runtimeBindingBasis,
                                                    pluginId:
                                                        custodyScope
                                                            .identity
                                                            .pluginId,
                                                    providerLocalId:
                                                        custodyScope
                                                            .identity
                                                            .localId,
                                                    activationGeneration:
                                                        custodyScope
                                                            .activationGeneration,
                                                    immutableGenerationId:
                                                        custodyScope
                                                            .immutableGenerationId,
                                                    manifestAuthority:
                                                        custodyScope
                                                            .manifestAuthority,
                                                    operationClaimId:
                                                        custodyScope
                                                            .operationClaimId,
                                                });
                                        const custodyClient =
                                            await createSessionManagedProviderCustodyClient(
                                                runnerCustodyScope,
                                                dependencies,
                                            );
                                        readAdoptedPublicOutcome =
                                            custodyClient
                                                .readAdoptedPublicOutcome;
                                        fenceRetainedProviderPolicy =
                                            custodyClient
                                                .fenceRetainedProviderPolicy;
                                        return Object.freeze({
                                            managedServices: Object.freeze({
                                                dependencies:
                                                    custodyClient.services
                                                        .dependencies,
                                                supervise(
                                                    spec: Parameters<typeof custodyClient.services.supervise>[0],
                                                    options?: Parameters<typeof custodyClient.services.supervise>[1],
                                                ) {
                                                    stampSupervisionLaunchAuthority(
                                                        spec,
                                                    );
                                                    return custodyClient
                                                        .services
                                                        .supervise(
                                                            spec,
                                                            options,
                                                        );
                                                },
                                            }),
                                            projectEndpointAccess:
                                                custodyClient
                                                    .projectEndpointAccess,
                                            adoptService: async (
                                                serviceId,
                                            ) => {
                                                await custodyClient
                                                    .commitAdoption(
                                                        serviceId,
                                                    );
                                            },
                                            readAdoptedPublicOutcome:
                                                custodyClient
                                                    .readAdoptedPublicOutcome,
                                        });
                                    },
                                },
                                signal,
                                isCurrent:
                                    readsSessionProviderAuthorityCurrent,
                            });
                        if (!createdManagedProviderInvocation) {
                            throw new PluginError({
                                code:
                                    'plugin_services_managed_provider_authority_unavailable',
                                message:
                                    'Managed Provider runtime invocation authority could not be prepared',
                            });
                        }
                        managedProviderCleanup.current = () =>
                            createdManagedProviderInvocation.cleanup();
                        const bootstrap =
                            createdManagedProviderInvocation.bootstrap;
                        if (
                            bootstrap.identity.pluginId
                                !== identity.pluginId
                            || bootstrap.identity.localId
                                !== identity.localId
                            || await readCurrentPluginHardRevocationRevision({
                                paths: storePaths,
                                pluginId: identity.pluginId,
                            })
                                !== providerPluginHardRevocationRevisionAtAdmission
                            || !await readCurrentPluginImmutableGenerationIntegrityCurrentness({
                                paths: storePaths,
                                pluginId: identity.pluginId,
                                immutableGenerationId:
                                    bootstrap.immutableGenerationId,
                                bundledArtifacts:
                                    BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
                            })
                        ) {
                            throw new PluginError({
                                code:
                                    'plugin_services_managed_provider_authority_unavailable',
                                message:
                                    'Managed Provider runtime authority changed while preparing the Runner invocation',
                            });
                        }
                        const managedRuntimeDeclaration =
                            lease.registry.contributes.providers
                                ?.find((provider) => (
                                    provider.identity.pluginId
                                        === identity.pluginId
                                    && provider.identity.localId
                                        === identity.localId
                                ))
                                ?.definition.managedRuntime;
                        if (
                            managedRuntimeDeclaration?.kind
                                !== 'managed'
                            || !lease.registry
                                .acquireManagedProviderRuntime
                        ) {
                            throw new PluginError({
                                code:
                                    'plugin_services_managed_provider_authority_unavailable',
                                message:
                                    'Managed Provider public runtime declaration is unavailable',
                            });
                        }
                        const providerConnectionRevision =
                            authorization.sessionBindingMetadata
                                .connectionRevision;
                        let adoptionCommitted = false;
                        let startPromise: Promise<void> | null = null;
                        const start = (): Promise<void> => {
                            startPromise ??= (async () => {
                                const launchResourceScope =
                                    createProviderLaunchResourceScope();
                                const started =
                                    await startPublicManagedProviderRuntime({
                                        identity,
                                        request: Object.freeze({
                                            reason:
                                                'sessionDemand' as const,
                                            connectionId:
                                                trackedSelection
                                                    .providerConnectionId,
                                            connectionRevision:
                                                providerConnectionRevision,
                                            endpointTemplateIds:
                                                Object.freeze([
                                                    ...managedRuntimeDeclaration
                                                        .endpointTemplateIds,
                                                ]),
                                        }),
                                        acquireRuntime: async (
                                            requestedIdentity,
                                        ) => await lease.registry
                                            .acquireManagedProviderRuntime!(
                                                requestedIdentity,
                                            ),
                                        connectedAccounts:
                                            createdManagedProviderInvocation
                                                .connectedAccounts,
                                        custody:
                                            createdManagedProviderInvocation,
                                        isAuthorizationCurrent:
                                            readsSessionProviderAuthorityCurrent,
                                        revalidateAuthorization:
                                            revalidateSessionProviderAuthority,
                                        signal,
                                        launchResourceScope,
                                    });
                                if (!started.ok) {
                                    throw new PluginError({
                                        code: started.code,
                                        message:
                                            'Managed Provider Session runtime start failed',
                                    });
                                }
                                adoptionCommitted = true;
                                const retire =
                                    launchResourceScope.transfer();
                                const cleanupInvocation =
                                    managedProviderCleanup.current;
                                managedProviderCleanup.current =
                                    async () => {
                                        await retire?.();
                                        await cleanupInvocation?.();
                                    };
                            })();
                            return startPromise;
                        };
                        const isManagedProviderCurrent = async () =>
                            await isManagedProviderSessionInvocationCurrent({
                                adoptionCommitted: () =>
                                    adoptionCommitted,
                                revalidateInitialPolicy:
                                    revalidateSessionProviderAuthority,
                                readsRetainedAuthorityCurrent:
                                    readsSessionProviderAuthorityCurrent,
                                revalidateRetainedPolicy: async () =>
                                    await revalidateAdoptedManagedProviderPolicy(
                                        runtimeBindingBasis,
                                    ),
                                fenceRetainedPolicy: async () => {
                                    if (!fenceRetainedProviderPolicy) {
                                        throw new PluginError({
                                            code:
                                                'plugin_services_managed_provider_custody_unavailable',
                                            message:
                                                'Runner retained Provider policy-fence authority is unavailable',
                                        });
                                    }
                                    await fenceRetainedProviderPolicy();
                                },
                                readHardRevocationRevision: async () =>
                                    await readCurrentPluginHardRevocationRevision({
                                        paths: storePaths,
                                        pluginId:
                                            identity.pluginId,
                                    }),
                                readGenerationIntegrityCurrentness:
                                    async () =>
                                        await readCurrentPluginImmutableGenerationIntegrityCurrentness({
                                            paths: storePaths,
                                            pluginId:
                                                identity.pluginId,
                                            immutableGenerationId:
                                                bootstrap
                                                    .immutableGenerationId,
                                            bundledArtifacts:
                                                BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
                                        }),
                                hardRevocationRevisionAtAdmission:
                                    providerPluginHardRevocationRevisionAtAdmission,
                            });
                        return Object.freeze({
                            bootstrap: Object.freeze({
                                v: 1 as const,
                                scope: Object.freeze({
                                    v: 1 as const,
                                    sessionId:
                                        sessionId,
                                    runtimeBindingBasis,
                                    pluginId:
                                        identity.pluginId,
                                    providerLocalId:
                                        identity.localId,
                                    activationGeneration:
                                        bootstrap
                                            .activationGeneration,
                                    immutableGenerationId:
                                        bootstrap
                                            .immutableGenerationId,
                                    manifestAuthority:
                                        bootstrap.manifestAuthority,
                                    operationClaimId:
                                        bootstrap
                                            .operationClaimId,
                                }),
                                requestAuth:
                                    bootstrap.requestAuth,
                                providerPluginHardRevocationRevisionAtAdmission,
                                sessionBindingMetadata:
                                    authorization
                                        .sessionBindingMetadata,
                            }),
                            connectedAccounts:
                                createdManagedProviderInvocation
                                    .connectedAccounts,
                            readSupervisionLaunchAuthority,
                            start,
                            materializeAgentBinding: async ({
                                endpointUrl,
                                credentialPlaceholder,
                            }: Readonly<{
                                endpointUrl: string;
                                credentialPlaceholder: string;
                            }>) => {
                                if (
                                    !startPromise
                                    || !capturedAgentProviderBinding
                                    || !readAdoptedPublicOutcome
                                    || !runtimeBindingBasis
                                        .runtimeCredentialTransport
                                ) {
                                    await cleanupManagedProvider()
                                        .catch(() => undefined);
                                    throw new PluginError({
                                        code:
                                            'plugin_services_managed_provider_materialization_authority_changed',
                                        message:
                                            'Managed Provider pre-open materialization authority is unavailable',
                                    });
                                }
                                await startPromise;
                                let assessed:
                                    ReturnType<
                                        typeof assessProviderEndpoint
                                    >;
                                try {
                                    assessed = assessProviderEndpoint(
                                        endpointUrl,
                                    );
                                } catch {
                                    await cleanupManagedProvider()
                                        .catch(() => undefined);
                                    throw new PluginError({
                                        code:
                                            'plugin_services_managed_provider_materialization_authority_changed',
                                        message:
                                            'Managed Provider materialization endpoint is invalid',
                                    });
                                }
                                const adopted =
                                    await readAdoptedPublicOutcome();
                                const adoptedEndpoint =
                                    adopted?.endpoints.find((entry) => (
                                        entry.endpointTemplateId
                                            === runtimeBindingBasis
                                                .endpoint
                                                .endpointTemplateId
                                    ));
                                if (
                                    assessed.locality !== 'loopback'
                                    || !adopted
                                    || adopted.operationClaimId
                                        !== bootstrap.operationClaimId
                                    || !adoptedEndpoint
                                    || assessed.normalizedUrl
                                        !== adoptedEndpoint.endpointUrl
                                ) {
                                    await cleanupManagedProvider()
                                        .catch(() => undefined);
                                    throw new PluginError({
                                        code:
                                            'plugin_services_managed_provider_materialization_authority_changed',
                                        message:
                                            'Managed Provider adopted endpoint materialization facts are unavailable',
                                    });
                                }
                                return await materializeRunnerManagedProviderAgentBinding({
                                    capturedAgentBinding:
                                        capturedAgentProviderBinding,
                                    isCapturedAgentRegistrationCurrent:
                                        isCapturedAgentRegistrationPreOpen,
                                    isManagedProviderCurrent,
                                    cleanup:
                                        cleanupManagedProvider,
                                    binding: {
                                        v: 1,
                                        agentTargetKey:
                                            runtimeBindingBasis
                                                .agentTargetKey,
                                        selection: {
                                            connectionId:
                                                runtimeBindingBasis
                                                    .connectionId,
                                            model:
                                                authorization.model,
                                        },
                                        contributionKey:
                                            runtimeBindingBasis
                                                .contributionKey,
                                        endpoint: {
                                            endpointTemplateId:
                                                runtimeBindingBasis
                                                    .endpoint
                                                    .endpointTemplateId,
                                            normalizedUrl:
                                                assessed.normalizedUrl,
                                            protocol:
                                                runtimeBindingBasis
                                                    .endpoint.protocol,
                                            publicHeaders:
                                                runtimeBindingBasis
                                                    .endpoint
                                                    .publicHeaders,
                                        },
                                        runtimeCredentialTransport:
                                            runtimeBindingBasis
                                                .runtimeCredentialTransport,
                                        compatibilityFingerprint:
                                            authorization
                                                .sessionBindingMetadata
                                                .compatibilityFingerprint,
                                    },
                                    prepared:
                                        runtimeBindingBasis.prepared,
                                    credential: {
                                        kind: 'apiKey',
                                        transport:
                                            runtimeBindingBasis
                                                .runtimeCredentialTransport,
                                        value:
                                            credentialPlaceholder,
                                    },
                                });
                            },
                            isCurrent:
                                isManagedProviderCurrent,
                        });
                    })().catch(async (error: unknown) => {
                        if (
                            managedProviderRetention
                            && isPluginError(error)
                            && error.code
                                === 'plugin_services_managed_provider_authority_unavailable'
                        ) {
                            await cleanupManagedProvider()
                                .catch(() => undefined);
                            return null;
                        }
                        throw error;
                    });
                    if (managedProviderRetention && managedProvider) {
                        let retainedProviderIsCurrent = false;
                        try {
                            retainedProviderIsCurrent =
                                await managedProvider.isCurrent();
                        } catch {
                            retainedProviderIsCurrent = false;
                        }
                        if (!retainedProviderIsCurrent) {
                            await cleanupManagedProvider()
                                .catch(() => undefined);
                            managedProvider = null;
                        }
                    }
                    const createRetained =
                        lease.registry
                            .createRetainedRunnerAgentInvocationServices;
                    if (!createRetained) {
                        throw new PluginError({
                            code:
                                'plugin_services_retained_generation_unavailable',
                            message:
                                'Retained Runner Agent PluginServices are unavailable',
                        });
                    }
                    const invocationProjection =
                        await createRetained({
                            binding: retainedAgent,
                            sessionId,
                            managedDependencyRetention:
                                tracked
                                    .runnerManagedDependencyRetentionV1
                                ?? {
                                    v: 1 as const,
                                    sourceGenerationIds: [],
                                    qualifiedDependencyIds: [],
                                },
                            correlationId:
                                invocationId,
                            cwd:
                                invocationContext.cwd,
                            environment:
                                invocationContext.environment,
                            ...(invocationContext.agentCliLaunch
                                ? {
                                    agentCliLaunch:
                                        invocationContext.agentCliLaunch,
                                }
                                : {}),
                            providerBindingActive:
                                invocationContext
                                    .providerBindingActive,
                            signal,
                            isGenerationCurrent:
                                () => authorizeOperation(undefined),
                        });
                    const executeCurrentGlobalAction:
                        RunnerDaemonCurrentGlobalActionExecutor =
                        async (
                            actionOrRef,
                            actionInput,
                            options,
                            operationWitness,
                        ) => {
                            if (typeof actionOrRef !== 'string') {
                                throw new PluginError({
                                    code:
                                        'plugin_action_generation_private_unavailable',
                                    message:
                                        'A retained Runner cannot substitute the current plugin generation for an exact generation-private action handler',
                                });
                            }
                            const currentLease =
                                await acquireAuthoritativePluginRuntimeRegistryLease({
                                    happyHomeDir:
                                        configuration.happyHomeDir,
                                });
                            try {
                                const createCurrentActions =
                                    currentLease.registry
                                        .createRetainedRunnerAgentCurrentGlobalActionsService;
                                if (!createCurrentActions) {
                                    throw new PluginError({
                                        code:
                                            'plugin_services_retained_generation_unavailable',
                                        message:
                                            'Retained Runner current-global Actions are unavailable',
                                    });
                                }
                                const currentActions =
                                    await createCurrentActions({
                                        binding: retainedAgent,
                                        sessionId,
                                        correlationId:
                                            invocationId,
                                        signal,
                                        isGenerationCurrent:
                                            () => authorizeOperation(
                                                operationWitness,
                                                {
                                                    requireActiveTurn:
                                                        true,
                                                },
                                            ),
                                    });
                                if (!authorizeOperation(
                                    operationWitness,
                                    { requireActiveTurn: true },
                                )) {
                                    throw new PluginError({
                                        code:
                                            'plugin_services_turn_authority_unavailable',
                                        message:
                                            'Runner PluginServices Action lost its exact active-turn authority before execution',
                                    });
                                }
                                // This is the runtime parse boundary: the
                                // canonical ActionsService validates the
                                // action-specific input and output schemas.
                                const executeCurrentAction =
                                    currentActions.execute as (
                                        action: Parameters<
                                            RunnerDaemonCurrentGlobalActionExecutor
                                        >[0],
                                        actionInput: Parameters<
                                            RunnerDaemonCurrentGlobalActionExecutor
                                        >[1],
                                        actionOptions: Parameters<
                                            RunnerDaemonCurrentGlobalActionExecutor
                                        >[2],
                                    ) => Promise<unknown>;
                                return await executeCurrentAction(
                                    actionOrRef,
                                    actionInput,
                                    options,
                                );
                            } finally {
                                await currentLease.release();
                            }
                        };
                    const currentGlobalMcp:
                        RunnerDaemonCurrentGlobalMcpOwner =
                        Object.freeze({
                            async list(query) {
                                const currentLease =
                                    await acquireAuthoritativePluginRuntimeRegistryLease({
                                        happyHomeDir:
                                            configuration.happyHomeDir,
                                    });
                                try {
                                    const createCurrentMcp =
                                        currentLease.registry
                                            .createRetainedRunnerAgentCurrentGlobalMcpService;
                                    if (!createCurrentMcp) {
                                        throw new PluginError({
                                            code:
                                                'plugin_services_retained_generation_unavailable',
                                            message:
                                                'Retained Runner current-global MCP is unavailable',
                                        });
                                    }
                                    return await (await createCurrentMcp({
                                        binding: retainedAgent,
                                        sessionId,
                                        correlationId: invocationId,
                                        signal,
                                        isGenerationCurrent:
                                            () => authorizeOperation(undefined),
                                    })).list(query);
                                } finally {
                                    await currentLease.release();
                                }
                            },
                            async discover(provider, query, options) {
                                const currentLease =
                                    await acquireAuthoritativePluginRuntimeRegistryLease({
                                        happyHomeDir:
                                            configuration.happyHomeDir,
                                    });
                                try {
                                    const createCurrentMcp =
                                        currentLease.registry
                                            .createRetainedRunnerAgentCurrentGlobalMcpService;
                                    if (!createCurrentMcp) {
                                        throw new PluginError({
                                            code:
                                                'plugin_services_retained_generation_unavailable',
                                            message:
                                                'Retained Runner current-global MCP is unavailable',
                                        });
                                    }
                                    return await (await createCurrentMcp({
                                        binding: retainedAgent,
                                        sessionId,
                                        correlationId: invocationId,
                                        signal,
                                        isGenerationCurrent:
                                            () => authorizeOperation(undefined),
                                    })).discover(provider, query, options);
                                } finally {
                                    await currentLease.release();
                                }
                            },
                            async connect(ref, options) {
                                const currentLease =
                                    await acquireAuthoritativePluginRuntimeRegistryLease({
                                        happyHomeDir:
                                            configuration.happyHomeDir,
                                    });
                                let releaseCurrentLease = true;
                                try {
                                    const createCurrentMcp =
                                        currentLease.registry
                                            .createRetainedRunnerAgentCurrentGlobalMcpService;
                                    if (!createCurrentMcp) {
                                        throw new PluginError({
                                            code:
                                                'plugin_services_retained_generation_unavailable',
                                            message:
                                                'Retained Runner current-global MCP is unavailable',
                                        });
                                    }
                                    const selectedClient =
                                        await (await createCurrentMcp({
                                            binding: retainedAgent,
                                            sessionId,
                                            correlationId: invocationId,
                                            signal,
                                            isGenerationCurrent:
                                                () => authorizeOperation(undefined),
                                        })).connect(ref, options);
                                    let disposed = false;
                                    let disposal: Promise<void> | null = null;
                                    const dispose = () => {
                                        disposal ??= (async () => {
                                            if (disposed) return;
                                            disposed = true;
                                            signal.removeEventListener(
                                                'abort',
                                                disposeOnAbort,
                                            );
                                            const results =
                                                await Promise.allSettled([
                                                    selectedClient.dispose(),
                                                    currentLease.release(),
                                                ]);
                                            const failures = results.flatMap(
                                                (result) => result.status
                                                    === 'rejected'
                                                    ? [result.reason]
                                                    : [],
                                            );
                                            if (failures.length === 1) {
                                                throw failures[0];
                                            }
                                            if (failures.length > 1) {
                                                throw new AggregateError(
                                                    failures,
                                                    'Retained Runner MCP client cleanup failed',
                                                );
                                            }
                                        })();
                                        return disposal;
                                    };
                                    const disposeOnAbort = () => {
                                        void dispose().catch(() => {});
                                    };
                                    if (signal.aborted) disposeOnAbort();
                                    else signal.addEventListener(
                                        'abort',
                                        disposeOnAbort,
                                        { once: true },
                                    );
                                    releaseCurrentLease = false;
                                    return Object.freeze({
                                        listTools:
                                            selectedClient.listTools,
                                        callTool:
                                            selectedClient.callTool,
                                        listResources:
                                            selectedClient.listResources,
                                        listResourceTemplates:
                                            selectedClient
                                                .listResourceTemplates,
                                        readResource:
                                            selectedClient.readResource,
                                        subscribeResource:
                                            selectedClient
                                                .subscribeResource,
                                        listPrompts:
                                            selectedClient.listPrompts,
                                        getPrompt:
                                            selectedClient.getPrompt,
                                        dispose,
                                    });
                                } finally {
                                    if (releaseCurrentLease) {
                                        await currentLease.release();
                                    }
                                }
                            },
                        });
                    const withCurrentGlobalExternalSessions =
                        async <T>(operation: (
                            service:
                                RunnerDaemonCurrentGlobalExternalSessionsOwner,
                        ) => Promise<T>): Promise<T> => {
                            const currentLease =
                                await acquireAuthoritativePluginRuntimeRegistryLease({
                                    happyHomeDir:
                                        configuration.happyHomeDir,
                                });
                            try {
                                const createCurrentExternalSessions =
                                    currentLease.registry
                                        .createRetainedRunnerAgentCurrentGlobalExternalSessionsService;
                                if (!createCurrentExternalSessions) {
                                    throw new PluginError({
                                        code:
                                            'plugin_services_retained_generation_unavailable',
                                        message:
                                            'Retained Runner current-global External Sessions are unavailable',
                                    });
                                }
                                return await operation(
                                    await createCurrentExternalSessions({
                                        binding: retainedAgent,
                                        sessionId,
                                        correlationId: invocationId,
                                        signal,
                                        isGenerationCurrent:
                                            () => authorizeOperation(undefined),
                                    }),
                                );
                            } finally {
                                await currentLease.release();
                            }
                        };
                    const currentGlobalExternalSessions:
                        RunnerDaemonCurrentGlobalExternalSessionsOwner =
                        Object.freeze({
                            async capabilities(options) {
                                return await withCurrentGlobalExternalSessions(
                                    async (service) =>
                                        await service.capabilities(options),
                                );
                            },
                            async list(query, options) {
                                return await withCurrentGlobalExternalSessions(
                                    async (service) =>
                                        await service.list(query, options),
                                );
                            },
                            async attach(ref, options) {
                                return await withCurrentGlobalExternalSessions(
                                    async (service) =>
                                        await service.attach(ref, options),
                                );
                            },
                            async readTranscript(ref, query, options) {
                                return await withCurrentGlobalExternalSessions(
                                    async (service) =>
                                        await service.readTranscript(
                                            ref,
                                            query,
                                            options,
                                        ),
                                );
                            },
                            async followTranscript(
                                ref,
                                options,
                                listener,
                            ) {
                                const currentLease =
                                    await acquireAuthoritativePluginRuntimeRegistryLease({
                                        happyHomeDir:
                                            configuration.happyHomeDir,
                                    });
                                let releaseCurrentLease = true;
                                try {
                                    const createCurrentExternalSessions =
                                        currentLease.registry
                                            .createRetainedRunnerAgentCurrentGlobalExternalSessionsService;
                                    if (!createCurrentExternalSessions) {
                                        throw new PluginError({
                                            code:
                                                'plugin_services_retained_generation_unavailable',
                                            message:
                                                'Retained Runner current-global External Sessions are unavailable',
                                        });
                                    }
                                    const followed = await (
                                        await createCurrentExternalSessions({
                                            binding: retainedAgent,
                                            sessionId,
                                            correlationId: invocationId,
                                            signal,
                                            isGenerationCurrent:
                                                () => authorizeOperation(undefined),
                                        })
                                    ).followTranscript(
                                        ref,
                                        options,
                                        listener,
                                    );
                                    if (followed.status === 'unavailable') {
                                        return followed;
                                    }
                                    let disposal: Promise<void> | null = null;
                                    const dispose = () => {
                                        disposal ??= (async () => {
                                            signal.removeEventListener(
                                                'abort',
                                                disposeOnAbort,
                                            );
                                            const results =
                                                await Promise.allSettled([
                                                    followed.subscription.dispose(),
                                                    currentLease.release(),
                                                ]);
                                            const failures = results.flatMap(
                                                (result) => result.status
                                                    === 'rejected'
                                                    ? [result.reason]
                                                    : [],
                                            );
                                            if (failures.length === 1) {
                                                throw failures[0];
                                            }
                                            if (failures.length > 1) {
                                                throw new AggregateError(
                                                    failures,
                                                    'Retained Runner External Sessions follow cleanup failed',
                                                );
                                            }
                                        })();
                                        return disposal;
                                    };
                                    const disposeOnAbort = () => {
                                        void dispose().catch(() => {});
                                    };
                                    if (signal.aborted) disposeOnAbort();
                                    else signal.addEventListener(
                                        'abort',
                                        disposeOnAbort,
                                        { once: true },
                                    );
                                    releaseCurrentLease = false;
                                    return Object.freeze({
                                        status: 'following' as const,
                                        startingCursor:
                                            followed.startingCursor,
                                        subscription: Object.freeze({
                                            dispose,
                                        }),
                                    });
                                } finally {
                                    if (releaseCurrentLease) {
                                        await currentLease.release();
                                    }
                                }
                            },
                            async takeover(ref, request, options) {
                                return await withCurrentGlobalExternalSessions(
                                    async (service) =>
                                        await service.takeover(
                                            ref,
                                            request,
                                            options,
                                        ),
                                );
                            },
                        });
                    const invocationRetainsRegistryLease =
                        managedProvider !== null;
                    if (!invocationRetainsRegistryLease) {
                        await lease.release();
                    }
                    releaseLease = false;
                    releaseManagedProviderInvocation = false;
                    return {
                        ...invocationProjection,
                        ...(managedProvider
                            ? { managedProvider }
                            : {}),
                        authorizeOperation,
                        authorizeManagedProviderMaterialization:
                            isCapturedAgentRegistrationPreOpen,
                        executeCurrentGlobalAction,
                        currentGlobalMcp,
                        currentGlobalExternalSessions,
                        dispose: async () => {
                            await cleanupManagedProvider();
                            if (invocationRetainsRegistryLease) {
                                await lease.release();
                            }
                        },
                    };
                } finally {
                    if (
                        releaseManagedProviderInvocation
                    ) {
                        await cleanupManagedProvider();
                    }
                    if (releaseLease) {
                        await lease.release();
                    }
                }
            },
        });
    const attestRetainedAgentForVoice = async (
        retainedAgent: unknown,
    ) => {
        try {
            return await verifyRunnerAgentBindingAgainstGeneration({
                paths: resolvePluginStorePaths({
                    happyHomeDir: configuration.happyHomeDir,
                }),
                binding: retainedAgent,
            });
        } catch {
            return null;
        }
    };
    const runnerAgentDaemonFacetService =
        createRunnerAgentDaemonFacetService({
            externalSessionHostOperationOwner,
            machineId: params.machineId,
            readAccountRevision: () =>
                resolveActiveAccountSettingsSnapshotRevision(
                    getActiveAccountSettingsSnapshot(),
                ),
            authorizeCurrent: async ({
                sessionId,
                runner,
                retainedAgent,
            }) => {
                const tracked =
                    findTrackedSessionByHappySessionId(
                        params.pidToTrackedSession.values(),
                        sessionId,
                    );
                if (
                    !tracked
                    || !authorizeTrackedRunnerAgentDaemonServiceOperation({
                        tracked,
                        sessionId,
                        runner,
                        retainedAgent,
                        witness: undefined,
                        allowIdleCurrentGeneration: true,
                    })
                ) {
                    return false;
                }
                return (
                    await authorizeRunnerAgentNewTurn({
                        retainedAgent,
                    })
                ).status === 'admitted';
            },
            authorizeActiveTurn: async ({
                sessionId,
                runner,
                retainedAgent,
                witness,
            }) => {
                const tracked =
                    findTrackedSessionByHappySessionId(
                        params.pidToTrackedSession.values(),
                        sessionId,
                    );
                if (
                    !tracked
                    || !authorizeTrackedRunnerAgentDaemonServiceOperation({
                        tracked,
                        sessionId,
                        runner,
                        retainedAgent,
                        witness,
                        allowIdleCurrentGeneration: false,
                    })
                ) {
                    return false;
                }
                return (
                    await authorizeRunnerAgentNewTurn({
                        retainedAgent,
                    })
                ).status === 'admitted';
            },
            resolveRetainedExternalSessionAgentContribution:
                async ({ retainedAgent }) => {
                    try {
                        const verified =
                            await verifyRunnerAgentBindingAgainstGeneration({
                                paths: resolvePluginStorePaths({
                                    happyHomeDir:
                                        configuration.happyHomeDir,
                                }),
                                binding: retainedAgent,
                            });
                        return projectManifestAgentContribution({
                            definition: verified.declaredAgent,
                            provenance:
                                verified.manifestAuthority
                                    === 'bundled_first_party'
                                    ? 'first_party'
                                    : 'external',
                            source: {
                                kind: verified.manifestAuthority
                                    === 'bundled_first_party'
                                    ? 'bundled'
                                    : 'package',
                            },
                            pluginId: verified.manifest.id,
                        });
                    } catch {
                        return null;
                    }
                },
            snapshotVoiceAuthority: async ({ retainedAgent }) => {
                const verifiedRetainedAgent =
                    await attestRetainedAgentForVoice(retainedAgent);
                if (!verifiedRetainedAgent) return null;
                const lease =
                    await acquireAuthoritativePluginRuntimeRegistryLease({
                        happyHomeDir:
                            configuration.happyHomeDir,
                    });
                try {
                    if (
                        (
                            await authorizeRunnerAgentNewTurn({
                                retainedAgent:
                                    verifiedRetainedAgent.binding,
                            })
                        ).status !== 'admitted'
                    ) {
                        return null;
                    }
                    const voiceAuthority =
                        resolveRetainedAgentSessionRealtimeVoiceAuthority({
                            runtimeRegistry: lease.registry,
                            retainedAgent:
                                verifiedRetainedAgent.binding,
                        });
                    if (!voiceAuthority) return null;
                    return {
                        agentGeneration: voiceAuthority.generation,
                        providers:
                            snapshotAgentSessionRealtimeVoiceProviders({
                                runtimeRegistry: lease.registry,
                                policyAgentRef: voiceAuthority.policyAgentRef,
                            }).flatMap(({ provider, lifecycle }) => {
                                const declaration =
                                    voiceAuthority.resolveDeclaration(
                                        provider.identity,
                                    );
                                if (
                                    !declaration
                                    || !voiceAuthority.isCurrent(
                                        provider.identity,
                                    )
                                    || voiceAuthority.resolveProviderGeneration(
                                        provider.identity,
                                    ) !== lifecycle.generation
                                ) {
                                    return [];
                                }
                                return [{
                                    provider: provider.identity,
                                    providerGeneration: lifecycle.generation,
                                    declaration,
                                }];
                            }),
                    };
                } finally {
                    await lease.release();
                }
            },
            waitVoiceAuthorityRetired: async ({
                retainedAgent,
                provider,
                providerGeneration,
                signal,
            }) => {
                const verifiedRetainedAgent =
                    await attestRetainedAgentForVoice(retainedAgent);
                if (!verifiedRetainedAgent) return;
                const lease =
                    await acquireAuthoritativePluginRuntimeRegistryLease({
                        happyHomeDir:
                            configuration.happyHomeDir,
                    });
                let retirementSignal: AbortSignal | null = null;
                try {
                    if (
                        (
                            await authorizeRunnerAgentNewTurn({
                                retainedAgent:
                                    verifiedRetainedAgent.binding,
                            })
                        ).status !== 'admitted'
                    ) {
                        return;
                    }
                    const voiceAuthority =
                        resolveRetainedAgentSessionRealtimeVoiceAuthority({
                            runtimeRegistry: lease.registry,
                            retainedAgent:
                                verifiedRetainedAgent.binding,
                        });
                    retirementSignal =
                        voiceAuthority
                        && voiceAuthority.isCurrent(provider)
                        && voiceAuthority.resolveProviderGeneration(provider)
                            === providerGeneration
                            ? voiceAuthority.resolveRetirementSignal(provider)
                            : null;
                } finally {
                    await lease.release();
                }
                if (
                    !retirementSignal
                    || retirementSignal.aborted
                ) {
                    return;
                }
                await new Promise<void>((resolve, reject) => {
                    const onRetired = () => {
                        cleanup();
                        resolve();
                    };
                    const onAborted = () => {
                        cleanup();
                        reject(
                            new Error(
                                'voice_authority_wait_aborted',
                            ),
                        );
                    };
                    const cleanup = () => {
                        retirementSignal?.removeEventListener(
                            'abort',
                            onRetired,
                        );
                        signal?.removeEventListener(
                            'abort',
                            onAborted,
                        );
                    };
                    retirementSignal.addEventListener(
                        'abort',
                        onRetired,
                        { once: true },
                    );
                    signal?.addEventListener(
                        'abort',
                        onAborted,
                        { once: true },
                    );
                    if (retirementSignal?.aborted) {
                        onRetired();
                    } else if (signal?.aborted) {
                        onAborted();
                    }
                });
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
                            authority: captured.authority,
                        };
                    } else if (captured?.status === 'already_inactive') {
                        entry.admission = {
                            status: 'already_inactive',
                            sessionId,
                        };
                    }
                } catch (error) {
                    logger.debug('[DAEMON RUN] Failed to capture Session publisher authority before respawn; marker will retain recovery custody', {
                        sessionId,
                        pid: tracked.pid,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        },
        retireSessionRunnerOwnedManagedServices: async ({ sessionId }) => {
            const retiredPids = await managedServiceDurabilityOwner
                ?.retireSessionRunnerOwnedProjections({ sessionId });
            if (retiredPids?.length) {
                logger.debug('[DAEMON RUN] Retired managed services orphaned by an exited Session runner', {
                    sessionId,
                    retiredPids,
                });
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
            if (unexpected && trackedSession.startedBy === 'daemon') return true;
            const terminal = trackedSession.happySessionMetadataFromLocalWebhook?.terminal
                ?? trackedSession.hostedTerminal;
            return Boolean(trackedSession.publishedTerminalControlServiceabilityAttachmentId)
                || Boolean(terminal?.mode && terminal.mode !== 'plain');
        },
        onFinalTrackedSessionExitStaged: async ({ pid, trackedSession }) => {
            if (params.connectedServicesRestartRequestedPids.has(pid)) return;
            const sessionId = normalizeOptionalString(trackedSession.happySessionId);
            if (!sessionId) return;
            const terminal = trackedSession.happySessionMetadataFromLocalWebhook?.terminal
                ?? trackedSession.hostedTerminal;
            const attachmentInfo = await readTerminalHostAttachmentInfo({
                happyHomeDir: configuration.happyHomeDir,
                sessionId,
            }).catch((error) => {
                logger.debug('[DAEMON RUN] Preserved runner-exit marker but could not read its terminal-host attachment', {
                    sessionId,
                    pid,
                    error,
                });
                throw error;
            });
            if (attachmentInfo?.version !== 2) {
                if (
                    trackedSession.publishedTerminalControlServiceabilityAttachmentId
                    || (terminal?.mode && terminal.mode !== 'plain')
                ) {
                    throw new Error('terminal_host_attachment_unavailable_after_runner_exit');
                }
                return;
            }
            const terminalMode = resolveDisconnectedTerminalMode({
                terminal,
                hostKind: attachmentInfo.handle.kind,
                attachmentId: attachmentInfo.attachmentId,
            });
            if (!terminalMode) {
                throw new Error('terminal_host_mode_unresolved_after_runner_exit');
            }

            registerDisconnectedTerminalHostCandidate({
                sessionId,
                pid,
                happyHomeDir: configuration.happyHomeDir,
                attachmentId: attachmentInfo.attachmentId,
                handle: attachmentInfo.handle,
                terminalMode,
                ...(trackedSession.publishedTerminalControlServiceabilityAttachmentId
                    === attachmentInfo.attachmentId
                    ? { controlDescriptorAvailable: true }
                    : {}),
            });
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
        if (
            trackedBeforeExit
                .agentRuntimeDaemonServiceAuthorityFilePath
            && trackedBeforeExit
                .agentRuntimeDaemonServiceCapabilityHash
        ) {
            await removeAgentRuntimeDaemonServiceAuthorityIfOwned({
                happyHomeDir: configuration.happyHomeDir,
                publicReleaseRing: configuration.publicReleaseRing,
                path: trackedBeforeExit
                    .agentRuntimeDaemonServiceAuthorityFilePath,
                capabilityDigest: trackedBeforeExit
                    .agentRuntimeDaemonServiceCapabilityHash,
            }).catch((error) => {
                logger.debug(
                    '[DAEMON RUN] Runner Agent authority owner cleanup failed (non-fatal)',
                    error,
                );
                return false;
            });
        }
        delete trackedBeforeExit
            .agentRuntimeDaemonServiceCapabilityHash;
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
                await connectedServiceTurnDeferralQueue.cancelSession(
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
    const stopSession = async (
        sessionId: string,
        options?: StopSessionOptions,
    ): Promise<StopSessionResult> =>
        await disconnectedTerminalHostResumeLifecycle.runStop(sessionId, async () => {
            sessionRunnerRespawnManager.markStopRequested(sessionId, { reason: 'daemon_stop_session', requestedAtMs: Date.now() });
            const automaticRecoveryCancellations = await Promise.allSettled([
                params.cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop?.({ sessionId })
                    ?? Promise.resolve(null),
                runtimeAuthRecoveryScheduler.cancel({ sessionId }),
                temporaryThrottleScheduler.cancel({ sessionId }),
            ]);
            const automaticRecoveryOwners = ['inactive_usage_limit', 'runtime_auth', 'temporary_throttle'] as const;
            automaticRecoveryCancellations.forEach((result, index) => {
                if (result.status !== 'rejected') return;
                logger.warn('[DAEMON RUN] Automatic recovery cancellation failed after explicit Stop', {
                    sessionId,
                    owner: automaticRecoveryOwners[index],
                    error: serializeAxiosErrorForLog(result.reason),
                });
            });
            temporaryThrottleResumeSnapshotsBySessionId.delete(sessionId);
            await connectedServiceRecoverySupersessionCleaner({
                sessionId,
                event: { kind: 'manual_session_supersession', reason: 'stop' },
            });
            if (params.daemonSessionMutationCustody.stage) {
                await persistExplicitSessionStopUsageLimitRecoveryCancellation({
                    credentials: params.credentials,
                    sessionId,
                    mutationCustody: { stage: params.daemonSessionMutationCustody.stage },
                }).catch((error) => {
                    logger.warn('[DAEMON RUN] Failed to publish explicit Stop recovery cancellation', {
                        sessionId,
                        error: serializeAxiosErrorForLog(error),
                    });
                });
            }
            physicallyRetiredTerminalAttachmentIdBySessionId.delete(sessionId);
            const trackedStopResult = await stopSessionCore(
                sessionId,
                options,
            );
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
                retireExactTerminalControlServiceability: async ({ sessionId, attachmentInfo, terminalMode }) => {
                    return await retireTerminalControlServiceabilityForCurrentAccount({
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
                // Released V2/V3 sealed-credential reads remain scalar-keyed on the server
                // wire; first-party services translate at this named ingress. External
                // qualified services have no scalar credential identity here and report
                // typed unavailability instead of a guessed lookup.
                const credentialIngressServiceId =
                    resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(serviceId);
                if (!credentialIngressServiceId) return null;
                const resolutions = await resolveConnectedServiceCredentialResolutions({
                    credentials: params.credentials,
                    api: params.api,
                    bindings: [{ serviceId: credentialIngressServiceId, profileId }],
                });
                const resolution = resolutions?.get(credentialIngressServiceId) ?? null;
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
    const resolveProviderQualifiedRuntimeAuthFailureSourceForSession: NonNullable<
        Parameters<typeof authorizeConnectedServiceRuntimeAuthFailureSource>[0]['resolveProviderQualifiedRuntimeAuthFailureSource']
    > = async ({ classification }) => {
        const groupId = typeof classification.groupId === 'string' ? classification.groupId.trim() : '';
        if (!groupId || typeof classification.serviceId !== 'string') return classification;
        // The V4 group owner accepts canonical qualified service refs directly.
        if (!(await readQualifiedConnectedServiceAuthGroup({ serviceId: classification.serviceId, groupId }))) {
            return classification;
        }
        // Released V2/V3 sealed-credential reads remain scalar-keyed on the server wire;
        // first-party services translate at this named ingress. External qualified services
        // have no scalar credential identity and resolve provider accounts through the V4
        // group owner only.
        const scalarCredentialServiceId =
            resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(classification.serviceId);
        return await resolveRuntimeAuthFailureSourceProfile({
            classification,
            getGroupMembers: async () => (await readQualifiedConnectedServiceAuthGroup({
                serviceId: classification.serviceId,
                groupId,
            }))?.members.map((member) => ({ profileId: member.connectedAccountId })) ?? null,
            resolveProviderAccountId: async (profileId) => {
                if (!scalarCredentialServiceId) return null;
                const resolution = await resolveConnectedServiceCredentialResolutions({
                    credentials: params.credentials,
                    api: params.api,
                    bindings: [{ serviceId: scalarCredentialServiceId, profileId }],
                }).then((byServiceId) => byServiceId.get(scalarCredentialServiceId) ?? null);
                return resolution
                    ? readConnectedServiceCredentialProviderAccountId(resolution.record)
                    : null;
            },
        });
    };
    const resolveRegisteredRuntimeAuthFailureSourceForSession: NonNullable<
        Parameters<typeof authorizeConnectedServiceRuntimeAuthFailureSource>[0]['resolveRegisteredRuntimeAuthFailureSource']
    > = async ({ sessionId: liveSessionId, tracked, classification: liveClassification }) => {
        // The runtime registry binds sessions by canonical qualified service key.
        const serviceId = liveClassification.serviceId;
        if (typeof serviceId !== 'string' || !serviceId) return null;
        const target = connectedServiceRuntimeRegistry.getBySessionId(liveSessionId);
        if (!target || target.pid !== tracked.pid || target.sessionId !== liveSessionId) return null;
        const binding = target.activeBindings.find((candidate) => candidate.serviceId === serviceId);
        if (!binding) return null;
        return {
            serviceId,
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
                currentMachineId: params.machineId,
            });
        const runtimeAuthV4Support =
            params.resolveQualifiedConnectedAccountV4Support?.()
            ?? 'absent';
        // The classification carries the canonical qualified service key (sanitize is the
        // sole ingress and normalizes released bundled scalar ids). The reverse scalar
        // mapping stays only for the bounded V2/V3 compatibility seams below.
        const runtimeAuthServiceKey = typeof input.classification.serviceId === 'string'
            ? readBuiltInLegacyConnectedAccountServiceKeyIngress(input.classification.serviceId)
            : null;
        const legacyRuntimeAuthService =
            resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
                input.classification.serviceId,
            );
        const qualifiedRuntimeAuthService = runtimeAuthServiceKey
            ? resolveQualifiedConnectedAccountServiceForIngressServiceId(runtimeAuthServiceKey)
            : null;
        const runtimeAuthGroupQuotaFreshnessMs = resolvePositiveIntEnv(
            params.processEnv.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_QUOTA_FRESHNESS_MS,
            5 * 60_000,
            { min: 1_000, max: 60 * 60_000 },
        );
        const buildRuntimeAuthApplication = (options: Readonly<{
            commitAccountSwitchEvents: boolean;
            dryRun?: boolean;
        }>) => buildConnectedServiceAuthApplicationSession({
            sessionId: input.sessionId,
            interruptedSessionId: input.sessionId,
            interruptedOriginId,
            restartReason: input.classification.kind,
            commitAccountSwitchEvents: options.commitAccountSwitchEvents,
            ...(options.dryRun ? { dryRun: true } : {}),
        });
        const qualifiedRuntimeAuthSwitchCoordinator: NonNullable<
            Parameters<typeof handleConnectedServiceRuntimeAuthFailureForSession>[0]['switchCoordinator']
        > | null = (
            runtimeAuthV4Support === 'advertised'
            && qualifiedRuntimeAuthService
            && runtimeAuthServiceKey
        )
            ? (() => {
                const serviceKey = runtimeAuthServiceKey;
                const qualifiedService = qualifiedRuntimeAuthService;
                const qualifiedCoordinator =
                    createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
                        token: params.credentials.token,
                        quotaFreshnessMs: runtimeAuthGroupQuotaFreshnessMs,
                        nowMs: () => Date.now(),
                        leases: qualifiedConnectedAccountAuthGroupSwitchLeases,
                        prepareCandidateForSwitch:
                            prepareQualifiedAuthGroupCandidateForSwitch,
                        // The V4 coordinator owns group truth and mutation. Runtime application
                        // carries the canonical qualified service key; first-party scalars
                        // persist only inside the bounded V2/V3 compatibility seams.
                        applyGeneration: async (generation) => await buildRuntimeAuthApplication({
                            commitAccountSwitchEvents: true,
                        })({
                            ...generation,
                            serviceId: serviceKey,
                        }),
                    });
                return {
                    switchAfterClassifiedFailure: async (switchInput) => {
                        // Source authorization can replace a stale report with the exact
                        // runtime binding. Do not let an already-selected V4 coordinator
                        // operate on a different service identity.
                        if (switchInput.serviceId !== serviceKey) {
                            throw new Error(
                                'qualified_connected_account_runtime_auth_service_mismatch',
                            );
                        }
                        return await qualifiedCoordinator
                            .switchAfterClassifiedFailure({
                                ...switchInput,
                                serviceId: qualifiedService,
                            });
                    },
                };
            })()
            : null;
        const switchCoordinator = qualifiedRuntimeAuthSwitchCoordinator;
        if (!runtimeAuthServiceKey) {
            // Sanitize owns classification ingress; an unparseable key here means a caller
            // bypassed it. Fail the recovery visibly instead of guessing an identity.
            return {
                status: 'recovery_handler_failed' as const,
                reason: 'runtime_auth_service_key_unparseable',
            };
        }
        const continueAfterRuntimeAuthSwitch = createConnectedServiceContinuationHandler({
            credentials: params.credentials,
            interruptedOriginId,
            resumePromptMode: await resolveContinuationResumePromptMode({
                serviceId: runtimeAuthServiceKey,
                groupId: input.classification.groupId,
                explicit: input.resumePromptMode,
                loadGroupPolicy: input.classification.groupId
                    ? async () => (await readQualifiedConnectedServiceAuthGroup({
                        serviceId: runtimeAuthServiceKey,
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
        });
        let supersedingSourceConverged = false;
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
                    currentMachineId: params.machineId,
                });
            },
            resolveRegisteredRuntimeAuthFailureSource: resolveRegisteredRuntimeAuthFailureSourceForSession,
            resolveCurrentRuntimeAuthFailureSource: resolveCurrentRuntimeAuthFailureSourceForSession,
            resolveProviderQualifiedRuntimeAuthFailureSource: resolveProviderQualifiedRuntimeAuthFailureSourceForSession,
            switchCoordinator,
            switchAttemptTracker: connectedServiceRuntimeAuthSwitchAttempts,
            switchCore: connectedServiceSessionAuthSwitchCore,
            temporaryThrottleRecovery,
            emitSessionEvent: async (sessionId, event) => {
                await commitConnectedServiceAccountSwitchSessionEventWithNotification({
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
            refreshConnectedServiceCredentialForRuntimeAuthFailure: async (refreshInput) => {
                const refreshCoordinator = params.getConnectedServiceRefreshCoordinator();
                const legacyServiceId =
                    resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
                        refreshInput.serviceId,
                    );
                if (!legacyServiceId) {
                    throw new Error('runtime_auth_credential_legacy_refresh_unavailable');
                }
                if (!refreshCoordinator) {
                    return {
                        status: 'credential_missing' as const,
                        credential: null,
                        diagnostic: {
                            serviceId: legacyServiceId,
                            profileId: refreshInput.profileId,
                            reason: 'runtime_auth_failure' as const,
                            status: 'credential_missing' as const,
                            expiresAt: null,
                            expiryAgeMs: null,
                            refreshWindowMs: 0,
                        },
                    };
                }
                return await refreshCoordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure({
                    ...refreshInput,
                    serviceId: legacyServiceId,
                });
            },
            continueAfterRuntimeAuthSwitch,
            settleSupersedingRuntimeGroupGeneration: async (settlementInput) => {
                await settleSupersedingRuntimeAuthGenerationForSource({
                    recovery: { status: 'switch_attempted', result: settlementInput.result },
                    serviceId: settlementInput.serviceId,
                    groupId: settlementInput.groupId,
                    sessionId: settlementInput.sessionId,
                    fromProfileId: settlementInput.fromProfileId,
                    consumeCommittedAuthGroupGeneration,
                });
                supersedingSourceConverged = true;
            },
        });
        if (await continueAfterSupersededRuntimeAuthFailure({
            result,
            sessionId: input.sessionId,
            interruptedOriginId,
            continueAfterRuntimeAuthSwitch,
            reconcileCurrentRuntimeAuthTarget: async ({ sessionId, serviceId, groupId }) => {
                const target = connectedServiceRuntimeRegistry.getBySessionId(sessionId);
                if (
                    !target
                    || !isCurrentRuntimeGenerationTarget(target)
                    || !target.activeBindings.some((binding) => (
                        binding.serviceId === serviceId && binding.groupId === groupId
                    ))
                ) return false;
                await scheduleRuntimeTargetGenerationReconciliation(target, undefined, true);
                const currentTarget = connectedServiceRuntimeRegistry.getBySessionId(sessionId);
                if (!currentTarget || !isCurrentRuntimeGenerationTarget(currentTarget)) return false;
                const snapshot = latestConnectedServiceProjectionSnapshot;
                const group = snapshot?.groups.find((candidate) => (
                    candidate.serviceId === serviceId && candidate.groupId === groupId
                )) ?? null;
                if (!group?.activeProfileId) return false;
                const credentialPresence = snapshot?.resolveCredentialPresence(serviceId, group.activeProfileId);
                if (!credentialPresence || credentialPresence.status === 'absent') return false;
                return currentTarget.activeBindings.some((binding) => (
                    binding.serviceId === serviceId
                    && binding.groupId === groupId
                    && binding.profileId === group.activeProfileId
                    && binding.groupGeneration === group.generation
                    && (
                        credentialPresence.status === 'legacy_unfenced'
                        || binding.credentialRevision === credentialPresence.credentialRevision
                    )
                ));
            },
        })) return result;
        if (
            input.recoveryInvocationSource !== 'scheduler_retry'
            && input.classification.kind === 'usage_limit'
            && input.classification.groupId
            && input.classification.profileId
        ) {
            const serviceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(input.classification.serviceId);
            const quotaCoordinator = params.getConnectedServiceQuotasCoordinator();
            if (serviceId && quotaCoordinator) {
                const committedGeneration = resolveCommittedGenerationFromRuntimeAuthRecovery({
                    serviceId,
                    groupId: input.classification.groupId,
                    recovery: result,
                });
                try {
                    await quotaCoordinator.recordRuntimeUsageLimitExhaustionAndFanout({
                        sourceSessionId: input.sessionId,
                        serviceId,
                        groupId: input.classification.groupId,
                        exhaustedProfileId: input.classification.profileId,
                        sourceProviderAccountId: input.classification.sourceProviderAccountId ?? null,
                        sourceAccountLabel: input.classification.sourceAccountLabel ?? null,
                        sourceGroupGeneration: input.classification.groupGeneration ?? null,
                        resetAtMs: input.classification.resetsAtMs,
                        ...(committedGeneration
                            ? {
                                committedGeneration: committedGeneration.committedGeneration,
                                sourceRequiresConvergence:
                                    committedGeneration.sourceRequiresConvergence && !supersedingSourceConverged,
                            }
                            : {}),
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
    const deliverRuntimeAuthRecoveryVisibleEvent = async (
        delivery: RuntimeAuthRecoveryVisibleEventDelivery,
    ): Promise<void> => {
        await params.daemonSessionMutationCustody.stageTranscriptEvent({
            sessionId: delivery.sessionId,
            eventId: buildRuntimeAuthRecoveryAttemptTransitionLocalId(delivery),
            data: { ...delivery.transcriptEvent },
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
    });
    // Single async server-features fetch source shared by the local-services inventory gate and
    // the browser daemon feature gate (OWNER-GATE). One fetch source, two consumers — no second
    // fetch is introduced. The gates own caching the resolved snapshot.
    const resolveServerFeaturesSnapshot = params.resolveServerFeaturesSnapshot
        ?? (async () => fetchServerFeaturesSnapshot({
            serverUrl: configuration.serverUrl,
            timeoutMs: 1_500,
        }));
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
    });
    params.onProviderManagedCatalogRuntimeOwnerReady?.({
        managedCatalogRuntime: createProviderManagedCatalogRuntimePort({
            happyHomeDir: configuration.happyHomeDir,
        }),
    });
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
        setBrowserAutomationRuntimeProvisionerProvider?: (provider: (() => ProvisionBrowserAutomationRuntime | null) | null) => void;
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
    const browserDiagnosticsStore = createBrowserDiagnosticsDaemonStore({ machineId: params.machineId });
    // SB-G: the offline-diagnostics summaries read the store on demand instead of retaining a second
    // copy of the same redacted event stream under the same view key. The store is the one retainer,
    // so a view's diagnostics are pruned exactly once by the bridge's view-close / session-close
    // clears (BRW-6 purge posture) and the two buffers cannot diverge.
    const browserContextDiagnosticsSummarySource: BrowserContextDiagnosticsSummarySource =
        createBrowserContextDiagnosticsSummarySource({ store: browserDiagnosticsStore });
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
    let managedServiceDurabilityOwner: ManagedServiceDurabilityOwner | null = null;
    let managedServiceEndpointReadOwner:
        ReturnType<typeof createDaemonManagedServiceEndpointReadOwner>
        | null = null;
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
                browserDiagnosticsRoutes = createBrowserDiagnosticsRoutes({ store: browserDiagnosticsStore });
            }
            if (
                browserDiagnosticsEnabled
                && (!browserDiagnosticsActionRoutes
                    || (browserDiagnosticsInteractionTransport && !browserDiagnosticsActionRoutesHasInteraction))
            ) {
                browserDiagnosticsActionRoutes = createBrowserDiagnosticsActionRoutes({
                    store: browserDiagnosticsStore,
                    ...(browserDiagnosticsInteractionTransport
                        ? { interaction: browserDiagnosticsInteractionTransport }
                        : {}),
                });
                browserDiagnosticsActionRoutesHasInteraction = Boolean(browserDiagnosticsInteractionTransport);
            }

            const browserSidecarEnabled = browserDaemonFeatureGate.isEnabled('browser.sidecar');
            // E2-F1: this gate used to also require `params.resolveBrowserUseAllowed?.() === true`,
            // a browser-use consent hook that NO production caller has ever passed — `git log -S`
            // over the whole repository history finds it only inside this file and its own test. It
            // was therefore permanently `false`, and this block holds the sole
            // `browserControlBroker.registerAdapter` call plus the only assignments of
            // `browserControlRoutes` / `browserContextRoutes` / `browserAutomationRoutes`, so no
            // agent could ever reach a daemon browser route. It is not a lost producer: no
            // `browserUse` policy owner exists anywhere in the product. Consent for agent-driven
            // browser use is owned by the action-approval danger floor (every
            // `browser.automation.*` id is in `protocol/src/actions/danger.ts`, and
            // `readFeatureEnv.ts` says so verbatim); the server feature bit below is the
            // availability authority. One owner each — no second decision-maker.
            if (browserSidecarEnabled && !unregisterBrowserSidecarControlAdapter) {
                const browserSidecarControlAdapterFactory = params.browserSidecarControlAdapterFactory
                    ?? createProductBrowserSidecarControlAdapterFactory({
                        featureEnabled: browserSidecarEnabled,
                        // OPEN PRODUCT DECISION (E2-F1, awaiting a user ruling — see
                        // `.project/plans/2026-08-23-ru2-surfaces-finalization/lanes/A1.md`).
                        // `autoInstallWhenMissing` defaults to `true`, and MCH-2's lazy install is
                        // the ONLY production path that can ever place the managed
                        // Chrome-for-Testing artifact on disk (`getArchiveDownloadInstallableAdapter`
                        // has zero non-test callers). Leaving it defaulted here would make every
                        // daemon fetch ~150 MB of third-party Chromium at startup, because
                        // `browser.sidecar` is default-ALLOW and this refresh runs on every start.
                        // That is a cost/trust change no user has agreed to, so it stays explicitly
                        // off: the daemon wires browser control/context/automation the moment a
                        // managed Chromium exists on disk, and provisioning it stays a separate,
                        // explicit decision. Flip this to `true` to adopt the lazy install.
                        autoInstallWhenMissing: false,
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
                                    diagnosticsSummarySource: browserContextDiagnosticsSummarySource,
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
                            store: browserDiagnosticsStore,
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
                            store: browserDiagnosticsStore,
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
    // Install-on-first-automation-attempt (user ruling, 2026-08-23). Startup deliberately does NOT
    // fetch the ~150MB managed Chromium (`autoInstallWhenMissing: false` above); the provisioner is
    // published so the FIRST `browser.automation.*` dispatch that finds no route can start the
    // fetch and, when it lands, refresh these same route owners. No feature check here: the browser
    // action executor already refuses the family when `browser.automation` is server-disabled, and a
    // second gate would be a second decision-maker for one question.
    const browserAutomationRuntimeProvisioner = createBrowserAutomationRuntimeProvisioner({
        refreshRouteOwners: refreshBrowserRouteOwners,
        onError: (error) => {
            logger.debug('[DAEMON RUN] Managed browser runtime provisioning failed (non-fatal)', error);
        },
    });
    runtimeActionRouteProviderTarget.setBrowserAutomationRuntimeProvisionerProvider?.(
        () => browserAutomationRuntimeProvisioner.provision,
    );

    await refreshBrowserRouteOwners();
    runtimeActionRouteProviderTarget.setLocalServicesRuntimeActionRoutesProvider?.(() => localServicesRuntimeActionRoutes);
    runtimeActionRouteProviderTarget.setSimulatorPreviewRoutesProvider?.(() => simulatorPreviewRuntime.routes);
    const localServicesMachineRpcRoutes: DaemonLocalServicesMachineRpcRoutes = {
        localServicesInventory: localServicesRuntime.inventoryRoutes,
        localServicesLauncher: localServicesRuntime.launcherRoutes,
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
    const disposeControlRuntimeResources = async (): Promise<void> => {
        if (controlRuntimeResourcesDisposed) return;
        controlRuntimeResourcesDisposed = true;
        await managedServiceEndpointReadOwner?.dispose();
        managedServiceEndpointReadOwner = null;
        unsubscribeConnectedServiceRuntimeTargetRegistrations();
        unsubscribeConnectedServiceRuntimeTargetRegistrations = () => {};
        unsubscribeRunnerAgentAuthorityCurrentness();
        unsubscribeRunnerAgentAuthorityCurrentness = () => {};
        await connectedServiceTurnDeferralQueue.cancelAll('daemon_shutdown');
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
        runtimeActionRouteProviderTarget.setBrowserAutomationRuntimeProvisionerProvider?.(null);
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
        await shutdownCancellationDomains.stopManagedLocalServices(localServicesRuntime);
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
    const resolveDaemonAuthBridge = async (serviceId: ConnectedAccountServiceKey): Promise<Readonly<{
        pluginId: string;
        registration: ConnectedServiceDaemonAuthBridgeRegistration;
    }> | null> => {
        const legacyServiceId =
            resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(serviceId);
        if (!legacyServiceId) return null;
        let lease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>> | null = null;
        try {
            lease = await acquireAuthoritativePluginRuntimeRegistryLease({
                happyHomeDir: configuration.happyHomeDir,
            });
            const candidates = await Promise.all(
                Object.entries(lease.registry.contributes.catalogEntriesById)
                    .filter(([, entry]) => entry.connectedServiceIds?.includes(legacyServiceId) === true)
                    .map(async ([pluginId, entry]) => {
                        const refresh: ConnectedServiceDaemonAuthBridgeRefresh | null = await (
                            entry.getConnectedServiceDaemonAuthBridgeRefresh?.(legacyServiceId) ?? null
                        );
                        return refresh ? Object.freeze({ pluginId, refresh }) : null;
                    }),
            );
            const bridges = candidates.filter((candidate): candidate is NonNullable<typeof candidate> => (
                candidate !== null
            ));
            if (bridges.length !== 1) return null;
            const bridge = bridges[0]!;
            return Object.freeze({
                pluginId: bridge.pluginId,
                registration: Object.freeze({
                    serviceId,
                    refresh: async (request: Parameters<ConnectedServiceDaemonAuthBridgeRegistration['refresh']>[0]) => {
                        const refreshCoordinator = params.getConnectedServiceRefreshCoordinator();
                        if (!refreshCoordinator) {
                            throw new Error('connected_service_daemon_auth_bridge_refresh_handler_unavailable');
                        }
                        return await bridge.refresh({
                            serviceId: legacyServiceId,
                            request,
                            refreshCoordinator,
                        });
                    },
                }),
            });
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
            authGroupSwitchCoordinator: connectedServiceAuthGroupPreTurnSwitchCoordinator,
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
        acquireAgentPurposeContributions: async ({ agentId }) => {
            const lease =
                await acquireAuthoritativePluginRuntimeRegistryLease({
                    happyHomeDir: configuration.happyHomeDir,
                });
            return Object.freeze({
                contributions: lease.registry.contributes,
                // The same registry that supplies the declarations also owns the committed
                // immutable generation those declarations came from, so both facts are read
                // through this one lease rather than resolved again later.
                resolveAgentContributionIdentity: async () => {
                    const identity = lease.registry.contributes
                        .agentDefinitionsById.get(agentId)?.identity;
                    if (!identity) return null;
                    const immutableGenerationId = await lease.registry
                        .resolveCurrentPluginImmutableGenerationId?.(
                            identity.pluginId,
                        ) ?? null;
                    if (!immutableGenerationId) return null;
                    return Object.freeze({
                        pluginId: identity.pluginId,
                        localId: identity.localId,
                        immutableGenerationId,
                    });
                },
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
        clearTerminalCleanupReceipt:
            clearExecutionRunConnectedServicesCleanupReceipt,
    });
    releaseExecutionRunAuthorityForRunnerExit =
        executionRunConnectedServicesBridge.releaseForRunnerExit;
    type EnforcedProviderInputAdmission = {
        kind: 'generation_pending';
        target: ConnectedServiceRuntimeTarget;
        targetWitness: ProviderInputAdmissionTargetWitness;
        readonly epochId: string;
        readonly desired: Readonly<{
            serviceId: ConnectedAccountServiceKey;
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
        readonly serviceId: ConnectedAccountServiceKey;
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
            serviceId: ConnectedAccountServiceKey;
            groupId: string;
            profileId: string;
            generation: number;
        }>;
    }>): Promise<Readonly<Record<string, string>> | null> => {
        if (input.tracked) {
            return input.tracked.spawnOptions?.environmentVariables ?? {};
        }
        const descriptor = await getConnectedServiceStateSharingDescriptor(
            input.ownerId,
        ).catch(() => null);
        if (
            descriptor?.providerSupportStatus !== 'supported'
            || !descriptor.nativeHome
        ) {
            return null;
        }
        const legacyServiceId =
            resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
                input.target.serviceId,
            );
        if (!legacyServiceId) return null;
        const materializedRoot = resolveConnectedServiceMaterializedHomeRoot(input.ownerId, {
            activeServerDir: configuration.activeServerDir,
            serviceId: legacyServiceId,
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
        return materializedRoot
            ? { [descriptor.nativeHome.environmentKey]: materializedRoot }
            : null;
    };
    const createDurableGenerationConsumer = (options?: Readonly<{
        allowProviderInputAdmissionWrites?: boolean;
    }>) => {
        const allowProviderInputAdmissionWrites = options?.allowProviderInputAdmissionWrites === true;
        const enforceGenerationProviderInputAdmissions = async (input: Readonly<{
            target: Readonly<{
                serviceId: ConnectedAccountServiceKey;
                groupId: string;
                profileId: string;
                generation: number;
                credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
            }>;
            sessionIds: readonly string[];
            executionAuthority: ConnectedServiceGenerationExecutionAuthority;
        }>): Promise<
            | Readonly<{
                status: 'ready';
                admissionsBySessionId: Map<string, EnforcedCurrentTruthProviderInputAdmission>;
            }>
            | Readonly<{
                status: 'failed';
                result: Readonly<{ reconciliationDisposition: 'failed'; errorCode: string }>;
            }>
        > => {
            const admissionsBySessionId = new Map<string, EnforcedCurrentTruthProviderInputAdmission>();
            for (const sessionId of input.sessionIds) {
                const unavailable = enforcedUnavailableProviderInputAdmissions.get(
                    providerInputAdmissionScopeKey(sessionId, input.target.serviceId, input.target.groupId),
                );
                if (unavailable && isCurrentProviderInputAdmissionTarget(unavailable.targetWitness)) {
                    admissionsBySessionId.set(sessionId, unavailable);
                }
            }
            if (input.executionAuthority === 'passive_projection') {
                return { status: 'ready', admissionsBySessionId };
            }
            for (const sessionId of input.sessionIds) {
                if (admissionsBySessionId.get(sessionId)?.kind === 'group_unavailable') continue;
                const admissionTarget = connectedServiceRuntimeRegistry.getBySessionId(sessionId);
                if (!admissionTarget) continue;
                const targetWitness = captureProviderInputAdmissionTargetWitness(admissionTarget);
                if (!targetWitness) {
                    return {
                        status: 'failed',
                        result: { reconciliationDisposition: 'failed', errorCode: 'provider_input_admission_target_released' },
                    };
                }
                const epochId = buildProviderInputGenerationEpochId({
                    runtimeIdentityKey: admissionTarget.runtimeIdentityKey,
                    targetRevision: admissionTarget.revision,
                    serviceId: input.target.serviceId,
                    groupId: input.target.groupId,
                    desired: {
                        profileId: input.target.profileId,
                        generation: input.target.generation,
                        credentialRevision: input.target.credentialRevision,
                    },
                });
                const admissionOutcome = await requestProviderInputAdmissionForTarget(admissionTarget, {
                    action: 'enforce',
                    reason: 'generation_pending',
                    serviceId: input.target.serviceId,
                    groupId: input.target.groupId,
                    epochId,
                }, targetWitness);
                if (admissionOutcome.status === 'cancelled') {
                    return {
                        status: 'failed',
                        result: { reconciliationDisposition: 'failed', errorCode: 'provider_input_admission_cancelled' },
                    };
                }
                const enforcedAdmission = {
                    kind: 'generation_pending' as const,
                    target: admissionTarget,
                    targetWitness,
                    epochId,
                    desired: input.target,
                };
                admissionsBySessionId.set(sessionId, enforcedAdmission);
                enforcedProviderInputAdmissions.set(
                    providerInputAdmissionScopeKey(sessionId, input.target.serviceId, input.target.groupId),
                    enforcedAdmission,
                );
                pendingProviderInputAdmissionsByEpochId.set(epochId, enforcedAdmission);
            }
            return { status: 'ready', admissionsBySessionId };
        };
        const recordGenerationProviderInputAdmissions = (input: Readonly<{
            admissionsBySessionId: ReadonlyMap<string, EnforcedCurrentTruthProviderInputAdmission>;
            adoptedTarget: object;
        }>): void => {
            for (const [sessionId, admission] of input.admissionsBySessionId) {
                providerInputAdmissionRecords.record({
                    sessionId,
                    adoptedTarget: input.adoptedTarget,
                    record: admission,
                });
            }
        };
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
                            applicationSettled: true,
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
                        applicationSettled: true,
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
                    const legacyServiceId =
                        resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
                            binding.serviceId,
                        );
                    if (!legacyServiceId) return null;
                    const resolutions = await resolveConnectedServiceCredentialResolutions({
                        credentials: params.credentials,
                        api: params.api,
                        bindings: [{ ...binding, serviceId: legacyServiceId }],
                    });
                    const resolution = resolutions.get(legacyServiceId) ?? null;
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
        applySharedGenerationApplication: async ({
            applicationOwnerId,
            applicationCohortSessionIds,
            committedGeneration,
            executionAuthority,
        }) => {
            const target = committedGeneration.decisionCommittedTarget;
            const admissions = await enforceGenerationProviderInputAdmissions({
                target,
                sessionIds: [...new Set(applicationCohortSessionIds)],
                executionAuthority,
            });
            if (admissions.status === 'failed') return admissions.result;
            if (target.credentialRevision === null) {
                return { reconciliationDisposition: 'failed', errorCode: 'credential_revision_missing' };
            }
            const legacyTargetServiceId =
                resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
                    target.serviceId,
                );
            if (!legacyTargetServiceId) {
                return { reconciliationDisposition: 'failed', errorCode: 'shared_generation_application_unavailable' };
            }
            const ownerId = applicationOwnerId as CatalogAgentId;
            const scope = await resolveConnectedServiceGenerationApplicationScope(target.serviceId, ownerId);
            if (scope.status !== 'supported' || scope.scope !== 'shared_group_auth_surface') {
                return { reconciliationDisposition: 'failed', errorCode: 'shared_generation_application_unavailable' };
            }
            const resolutions = await resolveConnectedServiceCredentialResolutions({
                credentials: params.credentials,
                api: params.api,
                bindings: [{ serviceId: legacyTargetServiceId, profileId: target.profileId }],
            }).catch(() => null);
            const resolution = resolutions?.get(legacyTargetServiceId) ?? null;
            if (
                !resolution
                || resolution.revisionSemantics !== 'revisioned'
                || resolution.credentialRevision !== target.credentialRevision
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
            const targetMaterializedRoot = resolveConnectedServiceTargetMaterializedRoot({
                agentId: ownerId,
                targetMaterializedEnv,
            });
            const nativeHome = targetMaterializedRoot
                ? await createConnectedServiceRuntimeAuthNativeHome({
                    agentId: ownerId,
                    root: targetMaterializedRoot,
                })
                : null;
            const supersedingTargetObservation: {
                authoritativeTarget?: Readonly<{
                    profileId: string;
                    generation: number;
                    credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
                }>;
            } = {};
            const applied = await adapter.hotApply({
                target: { agentId: ownerId },
                selection: {
                    serviceId: target.serviceId,
                    groupId: target.groupId,
                    activeProfileId: target.profileId,
                    profileId: target.profileId,
                    groupGeneration: target.generation,
                    credentialRevision: target.credentialRevision,
                },
                credential: resolution.record,
                ...(nativeHome ? { nativeHome } : {}),
                validateCurrentBeforeMutation: async () => {
                    const currentness = await validateConnectedServiceGroupMutationCurrentness({
                        serviceId: target.serviceId,
                        groupId: target.groupId,
                        profileId: target.profileId,
                        generation: target.generation,
                        credentialRevision: target.credentialRevision,
                    });
                    if (currentness.current === false && currentness.authoritativeTarget) {
                        supersedingTargetObservation.authoritativeTarget = currentness.authoritativeTarget;
                    }
                    return currentness;
                },
            }).catch(() => null);
            if (!applied?.applied) {
                const authoritativeTarget = supersedingTargetObservation.authoritativeTarget;
                if (
                    applied?.status === 'superseded_after_apply'
                    && authoritativeTarget
                ) {
                    return mapCommittedGenerationApplyResult({
                        committedGeneration,
                        result: {
                            status: 'superseded_after_apply',
                            activeProfileId: authoritativeTarget.profileId,
                            generation: authoritativeTarget.generation,
                            credentialRevision: authoritativeTarget.credentialRevision,
                            errorCode: typeof applied.reason === 'string' ? applied.reason : null,
                        },
                    });
                }
                return {
                    reconciliationDisposition: 'failed',
                    errorCode: typeof applied?.reason === 'string'
                        ? applied.reason
                        : 'shared_generation_application_unverified',
                };
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
            recordGenerationProviderInputAdmissions({
                admissionsBySessionId: admissions.admissionsBySessionId,
                adoptedTarget: adopted,
            });
            return { reconciliationDisposition: 'converged', errorCode: null, providerAdoptedTarget: adopted };
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
            const admissionSessionIds = [...new Set(applicationCohortSessionIds ?? [sessionId])];
            const admissions = await enforceGenerationProviderInputAdmissions({
                target,
                sessionIds: admissionSessionIds,
                executionAuthority,
            });
            if (admissions.status === 'failed') return admissions.result;
            const tracked = findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), sessionId);
            if (!tracked) return { reconciliationDisposition: 'failed', errorCode: 'session_not_found' };
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
                recordGenerationProviderInputAdmissions({
                    admissionsBySessionId: admissions.admissionsBySessionId,
                    adoptedTarget: mapped.providerAdoptedTarget,
                });
            }
            return mapped;
        },
        });
    };
    const consumeCommittedAuthGroupGeneration = async (
        input: Parameters<ConnectedServiceAuthGroupGenerationConsumer['consume']>[0],
    ) => await createDurableGenerationConsumer({
        allowProviderInputAdmissionWrites: input.executionAuthority !== 'passive_projection',
    }).consume(input);
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
    const reconcileDirectCredentialProjectionForTargets = async (
        projectionSnapshot: ConnectedServiceProjectionSnapshot,
        targets: ReadonlyArray<ConnectedServiceRuntimeTarget>,
        executionAuthority: ConnectedServicesProjectionNotification['executionAuthority'],
        signal?: AbortSignal,
    ): Promise<void> => {
        await reconcileConnectedServiceDirectCredentialRevisions({
            credentialRevisions: projectionSnapshot.credentialRevisions,
            resolveCredentialPresence: projectionSnapshot.resolveCredentialPresence,
            listRuntimeTargets: () => targets.map(runtimeGenerationTarget),
            applyLiveCredentialRevision: async (input) => {
                await applyConnectedServiceProjectionCredentialUpdate({
                    input,
                    listRuntimeTargets: () => connectedServiceRuntimeRegistry.listRefreshTargets(),
                    stopSession,
                    getRefreshCoordinator: params.getConnectedServiceRefreshCoordinator,
                });
            },
            executionAuthority,
            ...(signal ? { signal } : {}),
        });
    };
    const reconcileRuntimeTargetGenerationForTarget = async (
        target: ConnectedServiceRuntimeTarget,
        sessionMetadata?: Readonly<Record<string, unknown>>,
        requireFreshProjection = false,
        reconcileDirectCredentialProjection = true,
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
            const [rawSession, accountEncryptionCurrentness] = await Promise.all([
                fetchSessionByIdCompat({
                    token: params.credentials.token,
                    sessionId,
                }),
                fetchAccountEncryptionCurrentness({ token: params.credentials.token }),
            ]);
            effectiveSessionMetadata = rawSession
                ? tryDecryptSessionOwnerMetadataView({
                    credentials: params.credentials,
                    rawSession,
                    accountEncryptionMode: accountEncryptionCurrentness.mode,
                }) ?? undefined
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
        if (reconcileDirectCredentialProjection) {
            await reconcileDirectCredentialProjectionForTargets(
                projectionSnapshot,
                [target],
                'passive_projection',
            );
        }
        if (
            reconcileDirectCredentialProjection
            && isCurrentRuntimeGenerationTarget(target)
            && latestConnectedServiceProjectionSnapshot === projectionSnapshot
        ) {
            reconciledProjectionByRuntimeTarget.set(target, projectionSnapshot);
        }
    };
    const scheduleRuntimeTargetGenerationReconciliation = (
        offeredTarget: ConnectedServiceRuntimeTarget,
        sessionMetadata?: Readonly<Record<string, unknown>>,
        requireFreshProjection = false,
        reconcileDirectCredentialProjection = true,
    ): Promise<void> => {
        const scheduled = runtimeTargetReconciliationTail.then(async () => {
            const currentTarget = isCurrentRuntimeGenerationTarget(offeredTarget) ? offeredTarget : null;
            if (!currentTarget) return;
            await reconcileRuntimeTargetGenerationForTarget(
                currentTarget,
                sessionMetadata,
                requireFreshProjection,
                reconcileDirectCredentialProjection,
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
    const refreshTrackedRunnerAgentAuthority = async (
        tracked: TrackedSession,
        sessionId: string,
        httpPort: number,
    ): Promise<void> => {
        await refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority({
            happyHomeDir: configuration.happyHomeDir,
            publicReleaseRing: configuration.publicReleaseRing,
            httpPort,
            sessionId,
            tracked,
            resolveCurrentRetainedAgent: async ({ agentId }) => {
                const lease =
                    await acquireAuthoritativePluginRuntimeRegistryLease({
                        happyHomeDir: configuration.happyHomeDir,
                    });
                try {
                    const registration =
                        lease.registry.agentRuntimesByAgentId.get(agentId);
                    if (
                        !registration
                        || !registration.hasPrimaryRuntime
                        || !registration.sessionRunnerFactoryBinding
                        || registration.isCurrent() !== true
                    ) {
                        throw new Error(
                            `Runner Agent '${agentId}' has no current retained binding`,
                        );
                    }
                    return registration.sessionRunnerFactoryBinding;
                } finally {
                    await lease.release();
                }
            },
            ...(params.hardRevokeRunningSessionsForGenerationIntegrityFailure
                ? {
                    hardRevokeRunningSessionsForGenerationIntegrityFailure:
                        params.hardRevokeRunningSessionsForGenerationIntegrityFailure,
                }
                : {}),
            reserveManagedDependencyRetention: async (retainedAgent) => {
                const lease =
                    await acquireAuthoritativePluginRuntimeRegistryLease({
                        happyHomeDir: configuration.happyHomeDir,
                    });
                try {
                    return lease.registry
                        .reserveManagedDependencyRetention?.(retainedAgent)
                        ?? {
                            retention: {
                                v: 1 as const,
                                sourceGenerationIds: [],
                                qualifiedDependencyIds: [],
                            },
                            release() {},
                        };
                } finally {
                    await lease.release();
                }
            },
        });
    };
    unsubscribeRunnerAgentAuthorityCurrentness =
        pluginReloadController.subscribeRunningSessionDisposition((result) => {
            if (
                result.changedPluginIds.length === 0
                || result.runningSessionDisposition
                    !== 'revokeRunningSessions'
            ) {
                return;
            }
            const providerFences = new Set<string>();
            for (const tracked of params.pidToTrackedSession.values()) {
                const sessionId =
                    normalizeOptionalString(tracked.happySessionId);
                const runnerPid =
                    tracked.sessionRunnerPid ?? tracked.pid;
                let authorityRemoval: Promise<boolean> | null = null;
                const denyRunnerAgentAuthority = (): Promise<boolean> => {
                    if (authorityRemoval) return authorityRemoval;
                    const authorityPath =
                        tracked.agentRuntimeDaemonServiceAuthorityFilePath;
                    const capabilityDigest =
                        tracked.agentRuntimeDaemonServiceCapabilityHash;
                    tracked.agentRuntimeRunnerRestartDisposition =
                        'runner_authority_unavailable';
                    delete tracked
                        .agentRuntimeDaemonServiceCapabilityHash;
                    delete tracked
                        .agentRuntimeDaemonServiceAdmittedTurnId;
                    delete tracked
                        .agentRuntimeDaemonServiceAdmittedInputId;
                    delete tracked
                        .agentRuntimeDaemonServiceAdmittedUserMessageSeq;
                    delete tracked
                        .agentRuntimeDaemonServiceAdmittedUserMessageSeqs;
                    authorityRemoval = authorityPath && capabilityDigest
                        ? removeAgentRuntimeDaemonServiceAuthorityIfOwned({
                            happyHomeDir: configuration.happyHomeDir,
                            publicReleaseRing:
                                configuration.publicReleaseRing,
                            path: authorityPath,
                            capabilityDigest,
                        }).catch(() => false)
                        : Promise.resolve(false);
                    return authorityRemoval;
                };
                const agentTargeted = (async (): Promise<boolean> => {
                    const authorityPath =
                        tracked.agentRuntimeDaemonServiceAuthorityFilePath;
                    const processStartTimeMs =
                        tracked.processStartTimeMs;
                    const processCommandHash =
                        tracked.processCommandHash;
                    if (
                        !sessionId
                        || !authorityPath
                        || !Number.isSafeInteger(runnerPid)
                        || runnerPid < 1
                        || typeof processStartTimeMs !== 'number'
                        || !Number.isSafeInteger(processStartTimeMs)
                        || processStartTimeMs < 0
                        || typeof processCommandHash !== 'string'
                    ) {
                        return false;
                    }
                    const authority =
                        await readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker({
                            happyHomeDir: configuration.happyHomeDir,
                            publicReleaseRing:
                                configuration.publicReleaseRing,
                            path: authorityPath,
                            sessionId,
                            runner: {
                                pid: runnerPid,
                                processStartTimeMs,
                                processCommandHash,
                            },
                        });
                    if (
                        !authority
                        || tracked.runnerAgentImmutableGenerationId
                            !== authority.retainedAgent
                                .immutableGenerationId
                        || !isPluginRunningSessionDispositionTarget(
                            result,
                            authority.retainedAgent,
                        )
                    ) {
                        return false;
                    }
                    const capturedRunnerIdentity = {
                        pid: tracked.pid,
                        sessionRunnerPid: tracked.sessionRunnerPid,
                        processStartTimeMs,
                        processCommandHash,
                    };
                    const activeTurnId =
                        tracked.activeTurnId
                        ?? tracked.reattachedInterruptedTurnId
                        ?? tracked
                            .agentRuntimeDaemonServiceAdmittedTurnId
                        ?? null;
                    // Hard disable/trust loss/quarantine is a live revocation:
                    // fence tracked admission synchronously with durable
                    // publication, then retire the exact document and runner
                    // through their existing owners.
                    const targetedAuthorityRemoval =
                        denyRunnerAgentAuthority();
                    await updateSessionMarkerActiveTurn({
                        pid: runnerPid,
                        sessionId,
                        activeTurnId,
                    }).catch(() => false);
                    await targetedAuthorityRemoval;
                    const currentTracked =
                        params.pidToTrackedSession.get(
                            capturedRunnerIdentity.pid,
                        );
                    if (
                        currentTracked !== tracked
                        || tracked.sessionRunnerPid
                            !== capturedRunnerIdentity.sessionRunnerPid
                        || tracked.processStartTimeMs
                            !== capturedRunnerIdentity.processStartTimeMs
                        || tracked.processCommandHash
                            !== capturedRunnerIdentity.processCommandHash
                    ) {
                        return true;
                    }
                    await stopSession(sessionId, {
                        expectedTrackedRunner: {
                            tracked,
                            sessionRunnerPid:
                                capturedRunnerIdentity.sessionRunnerPid,
                            processStartTimeMs:
                                capturedRunnerIdentity.processStartTimeMs,
                            processCommandHash:
                                capturedRunnerIdentity.processCommandHash,
                        },
                    }).catch((error) => {
                        logger.debug(
                            '[DAEMON RUN] Failed to terminate hard-revoked Runner Agent session',
                            error,
                        );
                    });
                    return true;
                })().catch((error) => {
                    logger.debug(
                        '[DAEMON RUN] Failed to resolve direct Runner Agent revocation authority',
                        error,
                    );
                    return false;
                });
                void (async () => {
                    const persistedMarker = sessionId
                        ? await readSessionMarkerForPid(runnerPid)
                        : null;
                    const persistedMarkerIsExact = Boolean(
                        persistedMarker
                        && persistedMarker.happySessionId === sessionId
                        && persistedMarker.processCommandHash
                            === tracked.processCommandHash
                        && persistedMarker.processStartTimeMs
                            === tracked.processStartTimeMs,
                    );
                    const persistedManagedProviderAuthority =
                        persistedMarkerIsExact
                            ? persistedMarker
                                ?.runnerManagedDependencyRetentionV1
                                ?.adoptedManagedProviderAuthority
                                ?? null
                            : null;
                    // The marker is the sole live P authority writer. The
                    // tracked projection may retain only an exact cleanup
                    // identity after policy fencing so a later hard
                    // revocation remains idempotent; it never authorizes
                    // Provider effects.
                    const managedProviderAuthority =
                        persistedManagedProviderAuthority
                        ?? tracked.runnerManagedDependencyRetentionV1
                            ?.adoptedManagedProviderAuthority
                        ?? null;
                    const providerTargeted = Boolean(
                        sessionId
                        && managedProviderAuthority
                        && isPluginRunningSessionDispositionTarget(
                            result,
                            managedProviderAuthority,
                        ),
                    );
                    if (
                        !providerTargeted
                        || !sessionId
                        || !managedProviderAuthority
                    ) {
                        return;
                    }

                    const fenceKey =
                        `${sessionId}\0${managedProviderAuthority.pluginId}${result.runningSessionRevocationScope
                            ? `\0${result.runningSessionRevocationScope.immutableGenerationId}`
                            : ''}`;
                    if (providerFences.has(fenceKey)) return;
                    providerFences.add(fenceKey);
                    const capturedProviderRunnerIdentity = {
                        pid: tracked.pid,
                        sessionRunnerPid:
                            tracked.sessionRunnerPid,
                        processStartTimeMs:
                            tracked.processStartTimeMs,
                        processCommandHash:
                            tracked.processCommandHash,
                    };
                    void (async () => {
                        try {
                            const dispatch =
                                await createSessionManagedProviderCustodyDispatchForSession(
                                    sessionId,
                                );
                            const fenced = await dispatch({
                                v: 1,
                                kind: 'fenceHardRevocation',
                                pluginId:
                                    managedProviderAuthority.pluginId,
                                ...(result
                                    .runningSessionRevocationScope
                                    ? {
                                        immutableGenerationId:
                                            result
                                                .runningSessionRevocationScope
                                                .immutableGenerationId,
                                    }
                                    : {}),
                            });
                            if (
                                fenced.kind
                                    !== 'hardRevocationFenced'
                            ) {
                                throw new Error(
                                    'Runner returned the wrong managed Provider hard-revocation result',
                                );
                            }
                        } catch (error) {
                            logger.debug(
                                '[DAEMON RUN] Failed to fence hard-revoked managed Provider custody',
                                error,
                            );
                            if (await agentTargeted) {
                                // The Agent revocation path above owns the
                                // exact runner stop for a combined plugin.
                                return;
                            }
                            const currentTracked =
                                params.pidToTrackedSession.get(
                                    capturedProviderRunnerIdentity.pid,
                                );
                            if (
                                currentTracked !== tracked
                                || normalizeOptionalString(
                                    tracked.happySessionId,
                                ) !== sessionId
                                || tracked.sessionRunnerPid
                                    !== capturedProviderRunnerIdentity
                                        .sessionRunnerPid
                                || tracked.processStartTimeMs
                                    !== capturedProviderRunnerIdentity
                                        .processStartTimeMs
                                || tracked.processCommandHash
                                    !== capturedProviderRunnerIdentity
                                        .processCommandHash
                            ) {
                                return;
                            }
                            await stopSessionCore(sessionId, {
                                expectedTrackedRunner: {
                                    tracked,
                                    sessionRunnerPid:
                                        capturedProviderRunnerIdentity
                                            .sessionRunnerPid,
                                    processStartTimeMs:
                                        capturedProviderRunnerIdentity
                                            .processStartTimeMs,
                                    processCommandHash:
                                        capturedProviderRunnerIdentity
                                            .processCommandHash,
                                },
                                beforeSignalExactTrackedRunner: () => {
                                    sessionRunnerRespawnManager
                                        .markStopRequested(sessionId, {
                                            reason:
                                                'daemon_stop_session',
                                            requestedAtMs: Date.now(),
                                        });
                                },
                            }).catch((stopError) => {
                                logger.debug(
                                    '[DAEMON RUN] Failed to terminate Runner after managed Provider custody revocation failure',
                                    stopError,
                                );
                            });
                        }
                    })();
                })().catch((error) => {
                    logger.debug(
                        '[DAEMON RUN] Failed to resolve durable Runner revocation authority',
                        error,
                    );
                });
            }
        });
    const managedServiceEndpointProjectionRoot = join(
        resolvePluginStorePaths({
            happyHomeDir: configuration.happyHomeDir,
        }).stateDir,
        'managed-servers',
    );
    managedServiceDurabilityOwner = createManagedServiceDurabilityOwner({
        rootDir: managedServiceEndpointProjectionRoot,
        observeProcessStartIdentity:
            observeManagedServiceProcessStartIdentity,
    });
    managedServiceEndpointReadOwner =
        createDaemonManagedServiceEndpointReadOwner({
            credentials: params.credentials,
            resolveProjection: async (query) =>
                await managedServiceDurabilityOwner!
                    .resolveEndpointProjection(query),
        });
    params.onManagedServiceEndpointReadHostReady?.(
        managedServiceEndpointReadOwner
            .bindHost,
    );
    params.onManagedServiceSessionBaseUrlResolverReady?.(async (input) => {
        const projection = await managedServiceDurabilityOwner!
            .resolveEndpointProjection({
                pluginId: input.pluginId,
                sessionId: input.sessionId,
                contributionId: input.contributionId,
                selector: { kind: 'currentSessionManagedSpawn' },
            });
        return projection?.endpoint.baseUrl ?? null;
    });
    const resolveTrackedRunnerRuntimeCurrentness = async (
        tracked: TrackedSession | null | undefined,
    ) => await resolveAuthoritativeTrackedRunnerAgentRuntimeCurrentness(
        tracked,
        {
            machineId: params.machineId,
            accountSettings:
                getActiveAccountSettingsSnapshot()?.settings ?? null,
        },
    );
    const resolveSessionRunnerStatusState = async (input: Readonly<{
        sessionId: string;
        observedAtMs?: number;
    }>) => {
        const tracked = findTrackedSessionByHappySessionId(
            params.pidToTrackedSession.values(),
            input.sessionId,
        );
        const agentRuntimeCurrentness =
            await resolveTrackedRunnerRuntimeCurrentness(
                tracked,
            );
        const state = resolveSessionRunnerRuntimeState({
            sessionId: input.sessionId,
            tracked,
            currentIdentity: resolveCurrentSessionRunnerLaunchIdentity(),
            agentRuntimeVersionState:
                agentRuntimeCurrentness.versionState,
            agentRuntimeRestartUnavailableReason:
                agentRuntimeCurrentness.restartUnavailableReason,
            resolveActivityDisabledReason:
                resolveSessionRunnerActivityDisabledReason,
            machineId: params.machineId,
            observedAtMs: input.observedAtMs ?? Date.now(),
        });
        return { state, tracked };
    };
    const resolveSessionRunnerStatus = async (input: Readonly<{
        sessionId: string;
        observedAtMs?: number;
    }>) => (await resolveSessionRunnerStatusState(input)).state;
    const resolveSessionRunnerStatusV2 = async (input: Readonly<{
        sessionId: string;
        observedAtMs?: number;
    }>) => {
        const { state, tracked } =
            await resolveSessionRunnerStatusState(input);
        return await resolveSessionRunnerRuntimeStatusV2({ state, tracked });
    };
    const onSessionStartupFailure = createOnDaemonSessionStartupFailure({
        pidToTrackedSession: params.pidToTrackedSession,
        pidToAwaiter: params.pidToAwaiter,
    });
    const externalActionAccountId = params.externalActionAccountId?.trim() ?? '';
    const pluginActionCurrentIntent = createCredentialedTargetActionCurrentIntent(
        params.credentials,
    );
    const externalActionTranscriptFollowLeaseRegistry = externalActionAccountId
        ? createSessionTranscriptFollowLeaseRegistry({
            // This matches the established CLI Action executor capacity. The
            // registry is daemon-lifetime so retained follow leases are not
            // lost between finite HTTP requests.
            maxLeases: 16,
            idleTtlMs: DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
        })
        : null;
    const externalActionContributedInvoker = externalActionAccountId
        ? createDaemonExternalActionContributedInvoker({
            requestCurrentIntent: pluginActionCurrentIntent,
        })
        : null;
    const externalActionContributedApprovalReplay = externalActionAccountId
        ? createDaemonExternalActionContributedApprovalReplay({
            credentials: params.credentials,
        })
        : null;
    const externalActionContributedDefinitionLister = externalActionAccountId
        ? createDaemonExternalActionContributedDefinitionLister()
        : null;
    const requiresPortableSessionSpawnServerIdentity = (actionId: string, input: unknown): boolean => {
        if (actionId === 'session.spawn_new' || actionId === 'approval.request.decide') {
            return true;
        }
        if (
            actionId !== 'approval.request.create'
            || !input
            || typeof input !== 'object'
            || Array.isArray(input)
        ) {
            return false;
        }
        return (input as Readonly<Record<string, unknown>>).actionId === 'session.spawn_new';
    };
    const externalActionIngressOwner: ExternalActionIngressOwner | undefined = (
        externalActionAccountId
        && externalActionTranscriptFollowLeaseRegistry
        && externalActionContributedInvoker
        && externalActionContributedApprovalReplay
        && externalActionContributedDefinitionLister
    )
        ? {
            currentServerId: configuration.activeServerId,
            resolveTarget: createDaemonExternalActionTargetResolver({
                credentials: params.credentials,
                ...(params.currentMachineHost
                    ? { currentMachineHost: params.currentMachineHost }
                    : {}),
                ...(params.currentMachineHomeDir
                    ? { currentMachineHomeDir: params.currentMachineHomeDir }
                    : {}),
            }),
            executor: {
                execute: async (actionId, input, context) => {
                    let executionContext = context;
                    if (requiresPortableSessionSpawnServerIdentity(actionId, input)) {
                        let origin: CurrentMachineExecutionOriginContext | null = null;
                        try {
                            origin = await params.resolveCurrentMachineExecutionOriginContext?.(context?.signal) ?? null;
                        } catch {
                            origin = null;
                        }
                        if (!origin || origin.machineId !== params.machineId) {
                            const cancelled = context?.signal?.aborted === true;
                            return {
                                ok: false,
                                errorCode: cancelled ? 'cancelled' : 'target_unavailable',
                                error: cancelled ? 'cancelled' : 'target_unavailable',
                            };
                        }
                        executionContext = {
                            ...(context ?? {}),
                            serverId: origin.serverIdentityId,
                        };
                    }
                    // Machine-sync owners can be replaced after the control
                    // listener starts. Resolve their exact current adapters at
                    // the request boundary rather than retaining a stale one.
                    const hostExternalSessionAction =
                        params.resolveExternalSessionHostAction?.();
                    const sessionSpawnDirectTargetTransport =
                        params.resolveSessionSpawnDirectTargetTransport?.();
                    const apiMachineForSessions = params.getApiMachineForSessions();
                    const executor = createCliActionExecutorFromCredentials({
                        credentials: params.credentials,
                        pluginActionExecutionOwner: 'current_process',
                        ...(params.runtimeActionExecute
                            ? { runtimeActionExecute: params.runtimeActionExecute }
                            : {}),
                        invokeContributedAction: externalActionContributedInvoker,
                        targetActionApprovalReplay:
                            externalActionContributedApprovalReplay,
                        listContributedActionDefinitions:
                            externalActionContributedDefinitionLister,
                        ...(hostExternalSessionAction
                            ? { hostExternalSessionAction }
                            : {}),
                        ...(params.externalSessionPluginAdmissionOwner
                            ? {
                                externalSessionPluginAdmissionOwner:
                                    params.externalSessionPluginAdmissionOwner,
                            }
                            : {}),
                        ...(sessionSpawnDirectTargetTransport
                            ? { sessionSpawnDirectTargetTransport }
                            : {}),
                        ...(apiMachineForSessions
                            ? {
                                machineAdmissionTransport: async (request, options) =>
                                    await apiMachineForSessions.enqueueSessionPendingByMachine(
                                        request,
                                        options,
                                    ),
                            }
                            : {}),
                        transcriptFollowLeaseRegistry:
                            externalActionTranscriptFollowLeaseRegistry,
                    });
                    return await executor.execute(actionId, input, executionContext);
                },
            },
        }
        : undefined;
    const externalActionApi: NonNullable<
        Parameters<typeof startDaemonControlServer>[0]['externalActionApi']
    > | undefined = externalActionIngressOwner
        ? {
            verifyPat: createDaemonPatVerifier({
                accountId: externalActionAccountId,
                introspect: createAccountServerPatIntrospector({
                    daemonConnectionToken: params.credentials.token,
                    serverBaseUrl: params.serverBaseUrl,
                }),
            }),
            ...externalActionIngressOwner,
        }
        : undefined;
    /**
     * The control-runtime shutdown phases, in the one order the daemon uses. Each
     * phase is independent: a runner cleanup that rejects must not stop External
     * Session generations from retiring, control-runtime resources from being
     * disposed, or the control socket from being stopped — a shutdown that skipped
     * them would still report itself finished. Failures are collected and rethrown
     * afterwards so the caller still sees exactly what failed.
     */
    const runControlRuntimeShutdownPhases = async (
        trailingPhases: ReadonlyArray<
            readonly [phase: string, run: () => Promise<void>]
        > = [],
    ): Promise<void> => {
        const failures: unknown[] = [];
        const phases: ReadonlyArray<readonly [string, () => Promise<void>]> = [
            ['runner_plugin_services_host', async () => {
                await runnerDaemonPluginServicesHost.dispose();
            }],
            ['runner_agent_daemon_facets', async () => {
                await runnerAgentDaemonFacetService.dispose();
            }],
            ['external_session_host_operations', async () => {
                await externalSessionHostOperationOwner.retire();
            }],
            ...(externalActionTranscriptFollowLeaseRegistry
                ? [['external_action_transcript_follow_leases', async () => {
                    await externalActionTranscriptFollowLeaseRegistry.dispose();
                }] as const]
                : []),
            ['control_runtime_resources', disposeControlRuntimeResources],
            ...trailingPhases,
        ];
        for (const [phase, run] of phases) {
            try {
                await run();
            } catch (error) {
                failures.push(error);
                logger.debug(
                    `[DAEMON RUN] Control-runtime shutdown phase failed: ${phase}`,
                    error,
                );
            }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(
                failures,
                'Daemon control-runtime shutdown phases failed',
            );
        }
    };
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
        getChildren: () => Array.from(params.pidToTrackedSession.values()),
        machineId: params.machineId,
        runtimeId: params.runtimeId ?? '',
        stopSession,
        spawnSession,
        requestShutdown: () => params.requestShutdown('happier-cli'),
        ...(params.requestSelfRestart ? { requestSelfRestart: params.requestSelfRestart } : {}),
        ...(params.pluginChangeService ? { pluginChangeService: params.pluginChangeService } : {}),
        pluginActionCurrentIntent,
        ...(externalActionApi ? { externalActionApi } : {}),
        ...(params.isShuttingDown ? { isShuttingDown: params.isShuttingDown } : {}),
        beforeShutdown: async () => {
            const beforeShutdown = params.beforeShutdown;
            await runControlRuntimeShutdownPhases(
                typeof beforeShutdown === 'function'
                    ? [['daemon_before_shutdown', async () => {
                        await beforeShutdown();
                    }]]
                    : [],
            );
        },
        onHappySessionWebhook: async (
            sessionId,
            sessionMetadata,
            _reconcileCanonicalReadiness,
            sessionCreationOutcome,
        ) => {
            await params.onHappySessionWebhook(
                sessionId,
                sessionMetadata,
                async (tracked) => {
                    if (!tracked.agentRuntimeDaemonServiceAuthorityFilePath) {
                        return;
                    }
                    const canonicalSessionId =
                        normalizeOptionalString(tracked.happySessionId);
                    if (!canonicalSessionId) {
                        throw new Error(
                            'Runner Agent canonical session authority is unavailable',
                        );
                    }
                    await refreshTrackedRunnerAgentAuthority(
                        tracked,
                        canonicalSessionId,
                        controlPort,
                    );
                },
                sessionCreationOutcome,
            );
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
        onSessionStartupFailure,
        ...(params.admitPersistedTakeover
            ? { admitPersistedTakeover: params.admitPersistedTakeover }
            : {}),
        ...(params.sshTunnelSupervisor ? { sshTunnels: params.sshTunnelSupervisor } : {}),
        localServicesInventory: localServicesRuntime.inventoryRoutes,
        localServicesLauncher: localServicesRuntime.launcherRoutes,
        localServicesPreview: localServicesRuntime.previewRoutes,
        localServicesActions: localServicesRuntime.actionRoutes,
        localServicesPublicPreview: localServicesRuntimeActionRoutes.publicPreviewRoutes,
        agentRuntimeDaemonServices: {
            dispatch: async (request, context) => {
                const {
                    sessionId,
                    runner,
                    retainedAgent,
                    trackedSession,
                } = context;
                if (
                    request.operation.kind
                    === 'turn.admission.authorize'
                ) {
                    const decision =
                        await authorizeRunnerAgentNewTurn({
                            retainedAgent,
                        });
                    if (decision.status === 'admitted') {
                        return {
                            ok: true as const,
                            result: {
                                kind: 'turn.admission' as const,
                                status: 'admitted' as const,
                                witness:
                                    request.operation.witness,
                            },
                        };
                    }
                    return {
                        ok: true as const,
                        result: {
                            kind: 'turn.admission' as const,
                            status: 'denied' as const,
                            reason: decision.reason,
                        },
                    };
                }
                if (
                    request.operation.kind
                    === 'session.open.attest'
                ) {
                    const tracked = trackedSession;
                    if (
                        !tracked
                        || tracked.happySessionId
                            !== sessionId
                    ) {
                        return {
                            ok: false as const,
                            error: {
                                code:
                                    'agent_runtime_daemon_service_session_open_attestation_unavailable',
                                message:
                                    'Runner Agent session-open attestation custody is unavailable',
                            },
                        };
                    }
                    const attestation =
                        await recordTrackedRunnerAgentSessionOpenAttestation({
                            tracked,
                            retainedAgent,
                            runner,
                            phase: request.operation.phase,
                            request:
                                request.operation.request,
                            providerSessionId:
                                request.operation
                                    .providerSessionId,
                        });
                    return attestation
                        ? {
                            ok: true as const,
                            result: {
                                kind:
                                    'session.open.attestation' as const,
                                status: request.operation.phase
                                    === 'prepare'
                                    ? 'accepted' as const
                                    : 'recorded' as const,
                            },
                        }
                        : {
                            ok: false as const,
                            error: {
                                code:
                                    'agent_runtime_daemon_service_session_open_attestation_unavailable',
                                message:
                                    'Runner Agent session-open attestation could not be recorded',
                            },
                        };
                }
                const pluginServiceOperation =
                    RunnerDaemonPluginServiceOperationV1Schema.safeParse(
                        request.operation,
                    );
                if (pluginServiceOperation.success) {
                    try {
                        return {
                            ok: true as const,
                            result:
                                await runnerDaemonPluginServicesHost
                                    .dispatch({
                                        sessionId,
                                        runner,
                                        retainedAgent,
                                        operation:
                                            pluginServiceOperation
                                                .data,
                                        ...(context.signal
                                            ? {
                                                signal:
                                                    context.signal,
                                            }
                                            : {}),
                                    }),
                        };
                    } catch (error) {
                        const candidateCode =
                            isPluginError(error)
                                ? error.code
                                : (
                                    error
                                    && typeof error === 'object'
                                    && typeof Reflect.get(
                                        error,
                                        'code',
                                    ) === 'string'
                                )
                                    ? Reflect.get(error, 'code')
                                    : '';
                        const code =
                            typeof candidateCode === 'string'
                            && /^[a-z][a-z0-9_]{0,127}$/u
                                .test(candidateCode)
                                ? candidateCode
                                : 'runner_plugin_services_unavailable';
                        return {
                            ok: false as const,
                            error: {
                                code,
                                message:
                                    'Runner PluginServices operation is unavailable',
                            },
                        };
                    }
                }
                const facetOperation =
                    RunnerAgentDaemonFacetOperationV1Schema.safeParse(
                        request.operation,
                    );
                if (facetOperation.success) {
                    try {
                        return {
                            ok: true as const,
                            result:
                                await runnerAgentDaemonFacetService
                                    .dispatch({
                                        sessionId,
                                        runner,
                                        retainedAgent,
                                        operation:
                                            facetOperation.data,
                                        ...(context.signal
                                            ? {
                                                signal:
                                                    context.signal,
                                            }
                                            : {}),
                                    }),
                        };
                    } catch (error) {
                        const candidateCode =
                            isPluginError(error)
                                ? error.code
                                : (
                                    error
                                    && typeof error === 'object'
                                    && typeof Reflect.get(
                                        error,
                                        'code',
                                    ) === 'string'
                                )
                                    ? Reflect.get(error, 'code')
                                    : (
                                        error instanceof Error
                                            ? error.message
                                            : ''
                                    );
                        const code =
                            typeof candidateCode === 'string'
                            && /^[a-z][a-z0-9_]{0,127}$/u
                                .test(candidateCode)
                                ? candidateCode
                                : 'agent_runtime_daemon_facet_unavailable';
                        return {
                            ok: false as const,
                            error: {
                                code,
                                message:
                                    'Runner Agent daemon-owned facet is unavailable',
                            },
                        };
                    }
                }
                if (
                    request.operation.kind
                    === 'turn_contributions.resolve'
                    || request.operation.kind
                    === 'model_transition.authorize'
                    || request.operation.kind
                    === 'session.input.admit'
                ) {
                    const decision =
                        await authorizeRunnerAgentNewTurn({
                            retainedAgent,
                        });
                    if (decision.status !== 'admitted') {
                        return {
                            ok: false as const,
                            error: {
                                code:
                                    'agent_runtime_daemon_service_generation_not_current',
                                message:
                                    'Runner Agent generation is not current',
                            },
                        };
                    }
                    if (
                        request.operation.kind
                        === 'session.input.admit'
                    ) {
                        const admissionRequest =
                            request.operation.request;
                        const admission =
                            admissionRequest.sessionId !== sessionId
                                ? {
                                    status: 'rejected' as const,
                                    code: 'session_input_source_authority_mismatch' as const,
                                }
                                : admissionRequest.targetMachineId
                                    !== params.machineId
                                    ? {
                                        status: 'rejected' as const,
                                        code: 'session_input_target_update_required' as const,
                                    }
                                    : await params
                                        .getApiMachineForSessions()
                                        ?.enqueueSessionPendingByMachine(
                                            admissionRequest,
                                            context.signal
                                                ? { signal: context.signal }
                                                : undefined,
                                        )
                                        ?? {
                                            status: 'rejected' as const,
                                            code: 'session_input_target_unavailable' as const,
                                        };
                        return {
                            ok: true as const,
                            result: {
                                kind: 'session.input.admission' as const,
                                status: 'resolved' as const,
                                admission,
                            },
                        };
                    }
                    const lease =
                        await acquireAuthoritativePluginRuntimeRegistryLease({
                            happyHomeDir:
                                configuration.happyHomeDir,
                        });
                    try {
                        if (
                            request.operation.kind
                            === 'model_transition.authorize'
                        ) {
                            const tracked =
                                findTrackedSessionByHappySessionId(
                                    params.pidToTrackedSession
                                        .values(),
                                    sessionId,
                                );
                            const authorization =
                                AgentRuntimeDaemonModelTransitionAuthorizationResultV1Schema.parse(
                                await authorizeDaemonSessionModelTransitionProviderTarget({
                                    trackedAgentId:
                                        resolveTrackedSessionCatalogAgentId(
                                            tracked,
                                        ),
                                    trackedSelection:
                                        tracked?.spawnOptions
                                            ?.modelSelection?.ref
                                        ?? null,
                                    trackedSessionBindingMetadata:
                                        tracked?.spawnOptions
                                            ?.providerBindingMetadataV1
                                        ?? null,
                                    requestAgentId:
                                        retainedAgent.agentId,
                                    requestedSelection:
                                        request.operation
                                            .selection,
                                    authorizeProviderTarget:
                                        async (authority) =>
                                            await authorizeSessionModelTransitionProviderTargetWithLease({
                                                sessionId,
                                                machineId:
                                                    params.machineId,
                                                agentId:
                                                    authority.agentId,
                                                agentTargetKey:
                                                    authority
                                                        .agentTargetKey,
                                                lease,
                                                input:
                                                    authority.input,
                                            }),
                                }),
                            );
                            return {
                                ok: true as const,
                                result: {
                                    kind:
                                        'model_transition' as const,
                                    status:
                                        'authorized' as const,
                                    authorization,
                                },
                            };
                        }
                        const operationRequest =
                            request.operation.request;
                        if (
                            operationRequest.kind
                            === 'composition'
                        ) {
                            const composition =
                                await resolveAgentCompositionThroughRuntimeRegistry(
                                    lease.registry,
                                    {
                                        sessionId,
                                        agentId: retainedAgent.agentId,
                                        runtimeFamily:
                                            operationRequest.runtimeFamily,
                                        ...(operationRequest.machineId
                                            ? {
                                                machineId:
                                                    operationRequest.machineId,
                                            }
                                            : {}),
                                        ...(operationRequest.featureIds
                                            ? {
                                                featureIds:
                                                    operationRequest.featureIds,
                                            }
                                            : {}),
                                        ...(context.signal
                                            ? { signal: context.signal }
                                            : {}),
                                    },
                                );
                            return {
                                ok: true as const,
                                result: {
                                    kind:
                                        'turn_contributions' as const,
                                    status:
                                        'resolved' as const,
                                    contributions:
                                        AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({
                                            kind:
                                                'composition' as const,
                                            ...composition,
                                        }),
                                },
                            };
                        }
                        if (
                            operationRequest.kind
                            === 'prompt'
                        ) {
                            const promptAssetBlocks =
                                await lease.registry
                                    .resolvePromptAssetBlocks({
                                        agentId:
                                            retainedAgent.agentId,
                                        sessionId,
                                        ...(operationRequest
                                            .selectedAsset
                                            ? {
                                                selectedAsset:
                                                    operationRequest
                                                        .selectedAsset,
                                            }
                                            : {}),
                                        ...(operationRequest
                                            .machineId
                                            ? {
                                                machineId:
                                                    operationRequest
                                                        .machineId,
                                            }
                                            : {}),
                                        ...(operationRequest
                                            .featureIds
                                            ? {
                                                featureIds:
                                                    operationRequest
                                                        .featureIds,
                                            }
                                            : {}),
                                        ...(operationRequest
                                            .excludePluginIds
                                            ? {
                                                excludePluginIds:
                                                    operationRequest
                                                        .excludePluginIds,
                                            }
                                            : {}),
                                    });
                            return {
                                ok: true as const,
                                result: {
                                    kind:
                                        'turn_contributions' as const,
                                    status:
                                        'resolved' as const,
                                    contributions:
                                        AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({
                                        kind:
                                            'prompt' as const,
                                        promptAssetBlocks,
                                        toolPromptContributions:
                                            resolvePluginToolPromptContributionsThroughRuntimeRegistry(
                                                lease.registry,
                                                operationRequest.excludePluginIds
                                                    ? {
                                                        excludePluginIds:
                                                            operationRequest
                                                                .excludePluginIds,
                                                    }
                                                    : undefined,
                                            ).map(({ pluginId: _pluginId, ...contribution }) => contribution),
                                        }),
                                },
                            };
                        }
                        if (
                            operationRequest.kind
                            === 'composerReference'
                        ) {
                            const references =
                                lease.registry
                                    .composerReferences;
                            if (!references) {
                                throw new PluginError({
                                    code:
                                        'composer_reference_unavailable',
                                    message:
                                        'Composer references are unavailable',
                                });
                            }
                            const resolution =
                                await references.resolve({
                                    reference:
                                        operationRequest.reference,
                                    candidateId:
                                        operationRequest.candidateId,
                                    sessionId,
                                    signal:
                                        context.signal
                                        ?? new AbortController().signal,
                                });
                            return {
                                ok: true as const,
                                result: {
                                    kind:
                                        'turn_contributions' as const,
                                    status:
                                        'resolved' as const,
                                    contributions:
                                        AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({
                                            kind:
                                                'composerReference' as const,
                                            resolution,
                                        }),
                                },
                            };
                        }
                        if (
                            operationRequest.kind
                            === 'composerAttachment'
                        ) {
                            if (
                                operationRequest.request.sessionId
                                !== sessionId
                            ) {
                                throw new PluginError({
                                    code:
                                        'composer_attachment_session_mismatch',
                                    message:
                                        'Composer attachment resolution session does not match the authenticated Runner session',
                                });
                            }
                            const attachments =
                                lease.registry
                                    .composerAttachments;
                            if (!attachments) {
                                throw new PluginError({
                                    code:
                                        'composer_attachment_unavailable',
                                    message:
                                        'Composer attachments are unavailable',
                                });
                            }
                            if (
                                !attachments.isDeclared(
                                    operationRequest.attachment,
                                )
                            ) {
                                throw new PluginError({
                                    code:
                                        'composer_attachment_unavailable',
                                    message:
                                        `Composer attachment '${operationRequest.attachment.pluginId}/${operationRequest.attachment.localId}' is unavailable`,
                                });
                            }
                            const result = attachments.requires({
                                attachment: operationRequest.attachment,
                                phase: 'resolveForDispatch',
                            })
                                ? await (async () => {
                                    if (!await attachments.supports({
                                        attachment:
                                            operationRequest.attachment,
                                        phase: 'resolveForDispatch',
                                    })) {
                                        throw new PluginError({
                                            code:
                                                'composer_attachment_callback_unavailable',
                                            message:
                                                `Composer attachment '${operationRequest.attachment.pluginId}/${operationRequest.attachment.localId}' does not provide 'resolveForDispatch'`,
                                        });
                                    }
                                    return await attachments.resolveForDispatch({
                                        attachment:
                                            operationRequest.attachment,
                                        request:
                                            operationRequest.request,
                                        signal:
                                            context.signal
                                            ?? new AbortController().signal,
                                    });
                                })()
                                : Object.freeze({
                                    attachments: Object.freeze(
                                        operationRequest.request.attachments.map(
                                            (attachment) => Object.freeze({
                                                instanceId:
                                                    attachment.instanceId,
                                                status: 'ready' as const,
                                            }),
                                        ),
                                    ),
                                });
                            return {
                                ok: true as const,
                                result: {
                                    kind:
                                        'turn_contributions' as const,
                                    status:
                                        'resolved' as const,
                                    contributions:
                                        AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({
                                            kind:
                                                'composerAttachment' as const,
                                            result,
                                        }),
                                },
                            };
                        }
                        if (
                            operationRequest.kind
                            === 'composerAttachmentAccepted'
                        ) {
                            if (
                                operationRequest.event.sessionId
                                !== sessionId
                            ) {
                                throw new PluginError({
                                    code:
                                        'composer_attachment_session_mismatch',
                                    message:
                                        'Composer attachment acceptance session does not match the authenticated Runner session',
                                });
                            }
                            const attachments =
                                lease.registry
                                    .composerAttachments;
                            if (!attachments) {
                                throw new PluginError({
                                    code:
                                        'composer_attachment_unavailable',
                                    message:
                                        'Composer attachments are unavailable',
                                });
                            }
                            if (
                                !attachments.isDeclared(
                                    operationRequest.attachment,
                                )
                            ) {
                                throw new PluginError({
                                    code:
                                        'composer_attachment_unavailable',
                                    message:
                                        `Composer attachment '${operationRequest.attachment.pluginId}/${operationRequest.attachment.localId}' is unavailable`,
                                });
                            }
                            if (attachments.requires({
                                attachment: operationRequest.attachment,
                                phase: 'afterMessageAccepted',
                            })) {
                                if (!await attachments.supports({
                                    attachment: operationRequest.attachment,
                                    phase: 'afterMessageAccepted',
                                })) {
                                    throw new PluginError({
                                        code:
                                            'composer_attachment_callback_unavailable',
                                        message:
                                            `Composer attachment '${operationRequest.attachment.pluginId}/${operationRequest.attachment.localId}' does not provide 'afterMessageAccepted'`,
                                    });
                                }
                                await attachments.afterMessageAccepted({
                                    attachment:
                                        operationRequest.attachment,
                                    event: operationRequest.event,
                                    signal:
                                        context.signal
                                        ?? new AbortController().signal,
                                });
                            }
                            return {
                                ok: true as const,
                                result: {
                                    kind:
                                        'turn_contributions' as const,
                                    status:
                                        'resolved' as const,
                                    contributions:
                                        AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({
                                            kind:
                                                'composerAttachmentAccepted' as const,
                                        }),
                                },
                            };
                        }
                        if (
                            operationRequest.kind
                            === 'settleComposerStagedMedia'
                        ) {
                            await settleComposerStagedMediaAdmissionV1({
                                outcome: operationRequest.outcome,
                                settlement: operationRequest.settlement,
                                stageStore:
                                    createActiveDaemonComposerMediaStageStore({
                                        machineId: params.machineId,
                                    }),
                                logger,
                            });
                            return {
                                ok: true as const,
                                result: {
                                    kind:
                                        'turn_contributions' as const,
                                    status:
                                        'resolved' as const,
                                    contributions:
                                        AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({
                                            kind:
                                                'settleComposerStagedMedia' as const,
                                        }),
                                },
                            };
                        }
                        let payload: Readonly<Record<string, unknown>>;
                        if (operationRequest.kind === 'transformSessionInput') {
                            const signal = context.signal
                                ?? new AbortController().signal;
                            const transformed =
                                await transformSessionInputThroughRuntimeRegistry(
                                    lease.registry,
                                    operationRequest.payload,
                                    { signal },
                                );
                            const sourceMeta = operationRequest.payload.meta;
                            const sourceMetaRecord = sourceMeta
                                && typeof sourceMeta === 'object'
                                && !Array.isArray(sourceMeta)
                                ? sourceMeta as Record<string, unknown>
                                : {};
                            const transformedMeta = transformed.meta;
                            const transformedMetaRecord = transformedMeta
                                && typeof transformedMeta === 'object'
                                && !Array.isArray(transformedMeta)
                                ? transformedMeta as Record<string, unknown>
                                : null;
                            const meta = preserveComposerAttachmentSelectionAcrossSessionInputTransformV1({
                                sourceMeta: sourceMetaRecord,
                                transformedMeta: transformedMetaRecord,
                            });
                            if (!meta) {
                                payload = transformed;
                            } else {
                                const selected =
                                    validateSessionStructuredInputIngressV1({
                                        meta,
                                    });
                                if (selected.length === 0) {
                                    payload = meta === transformedMetaRecord
                                        ? transformed
                                        : Object.freeze({ ...transformed, meta });
                                } else {
                                    if (
                                        operationRequest.payload.sessionId
                                        !== sessionId
                                    ) {
                                        throw new PluginError({
                                            code:
                                                'composer_attachment_session_mismatch',
                                            message:
                                                'Composer attachment preparation session does not match the authenticated Runner session',
                                        });
                                    }
                                    const attachments =
                                        lease.registry
                                            .composerAttachments;
                                    if (!attachments) {
                                        throw new PluginError({
                                            code:
                                                'composer_attachment_unavailable',
                                            message:
                                                'Composer attachments are unavailable',
                                        });
                                    }
                                    const preparedDraftAttachments =
                                        await prepareComposerAttachmentDraftsForSendV1({
                                            attachments,
                                            sessionId,
                                            messageLocalId:
                                                operationRequest.payload.localId,
                                            drafts: selected,
                                            signal,
                                        });
                                    const messageLocalId =
                                        typeof operationRequest.payload.localId
                                        === 'string'
                                            ? operationRequest.payload.localId
                                                .trim()
                                            : '';
                                    if (!messageLocalId) {
                                        throw new PluginError({
                                            code:
                                                'composer_attachment_request_invalid',
                                            message:
                                                'Composer attachment finalization requires the canonical Message local identity',
                                        });
                                    }
                                    const tracked =
                                        findTrackedSessionByHappySessionId(
                                            params.pidToTrackedSession.values(),
                                            sessionId,
                                        );
                                    const workingDirectory =
                                        tracked?.spawnOptions?.directory;
                                    const finalization =
                                        await finalizeComposerStagedMediaToSession({
                                            sessionId,
                                            messageLocalId,
                                            workingDirectory:
                                                typeof workingDirectory === 'string'
                                                    ? workingDirectory
                                                    : '',
                                            executionTarget: {
                                                serverId:
                                                    configuration.activeServerId,
                                                machineId: params.machineId,
                                            },
                                            stageStore:
                                                createActiveDaemonComposerMediaStageStore({
                                                    machineId: params.machineId,
                                                }),
                                            meta,
                                            attachments:
                                                preparedDraftAttachments,
                                            logger,
                                        });
                                    try {
                                        const preparedComposerAttachments =
                                            attachments.admit({
                                                phase: 'prepared',
                                                attachments:
                                                    finalization.attachments,
                                            });
                                        const {
                                            [COMPOSER_STAGED_MEDIA_ADMISSION_SETTLEMENT_FIELD]: _discardedSettlement,
                                            ...transformedWithoutSettlement
                                        } = transformed;
                                        payload = Object.freeze({
                                            ...transformedWithoutSettlement,
                                            meta: finalization.meta,
                                            preparedComposerAttachments,
                                            ...(finalization.releaseIntents.length > 0
                                                ? {
                                                    [COMPOSER_STAGED_MEDIA_ADMISSION_SETTLEMENT_FIELD]: {
                                                        v: 1,
                                                        releaseIntents:
                                                            finalization.releaseIntents,
                                                        createdWorkspaceRelativePaths:
                                                            finalization.createdWorkspaceRelativePaths,
                                                        workingDirectory,
                                                    },
                                                }
                                                : {}),
                                        });
                                    } catch (error) {
                                        if (
                                            typeof workingDirectory === 'string'
                                            && workingDirectory.trim().length > 0
                                        ) {
                                            await garbageCollectUncommittedSessionMedia({
                                                workingDirectory,
                                                candidateWorkspaceRelativePaths:
                                                    finalization
                                                        .createdWorkspaceRelativePaths,
                                                reason: 'failed_durable_write',
                                                logger,
                                            });
                                        }
                                        throw error;
                                    }
                                }
                            }
                        } else if (operationRequest.kind === 'transformAgentRequest') {
                            const rawRequest = operationRequest.payload.request;
                            if (
                                !rawRequest
                                || typeof rawRequest !== 'object'
                                || Array.isArray(rawRequest)
                            ) {
                                throw new PluginError({
                                    code: 'agent_request_transform_invalid',
                                    message: 'Agent request transformation requires a raw ACP request object',
                                });
                            }
                            payload =
                                await transformAgentRequestThroughRuntimeRegistry(
                                    lease.registry,
                                    Object.freeze({
                                        sessionId,
                                        agentId: retainedAgent.agentId,
                                        runtimeFamily: 'acpSession',
                                        method: 'session/prompt',
                                        request: rawRequest,
                                        timestampMs: Date.now(),
                                    }),
                                    context.signal
                                        ? { signal: context.signal }
                                        : undefined,
                                );
                        } else {
                            payload =
                                await transformAgentContextThroughPluginRuntimeRegistry(
                                    lease.registry,
                                    operationRequest.payload,
                                    context.signal
                                        ? { signal: context.signal }
                                        : undefined,
                                );
                        }
                        return {
                            ok: true as const,
                            result: {
                                kind:
                                    'turn_contributions' as const,
                                status:
                                    'resolved' as const,
                                contributions:
                                    AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({
                                    kind:
                                        operationRequest.kind,
                                    payload,
                                    }),
                            },
                        };
                    } finally {
                        await lease.release();
                    }
                }
                const authority = {
                    sessionId,
                    pluginId:
                        retainedAgent.pluginId,
                };
                if (
                    request.operation.kind
                    === 'managed_server.endpoint.read.claim'
                ) {
                    const claimed = managedServiceEndpointReadOwner?.claim({
                        requestId: request.operation.requestId,
                        projectionToken:
                            request.operation.projectionToken,
                        sessionId: authority.sessionId,
                        pluginId: authority.pluginId,
                    }) === true;
                    return {
                        ok: true as const,
                        result: {
                            kind:
                                'managed_server.endpoint.read' as const,
                            status: claimed
                                ? 'claimed' as const
                                : 'unavailable' as const,
                            requestId: request.operation.requestId,
                        },
                    };
                }
                if (
                    request.operation.kind
                    === 'managed_server.secret.read'
                ) {
                    const resolved =
                        await resolveRunnerManagedServiceDeclaredSecret({
                            paths: resolvePluginStorePaths({
                                happyHomeDir:
                                    configuration.happyHomeDir,
                            }),
                            binding: retainedAgent,
                            request: {
                                phase: request.operation.phase,
                                secretId: request.operation.secretId,
                                canonicalOrigin:
                                    request.operation.canonicalOrigin,
                                ...(request.operation.expectedRevision
                                    ? {
                                        expectedRevision:
                                            request.operation
                                                .expectedRevision,
                                    }
                                    : {}),
                            },
                            ...(context.signal
                                ? { signal: context.signal }
                                : {}),
                        });
                    return AgentRuntimeDaemonServiceResponseV1Schema.parse({
                        ok: true as const,
                        result: {
                            kind: 'managed_server.secret' as const,
                            requestId: request.operation.requestId,
                            ...resolved,
                        },
                    });
                }
                if (
                    request.operation.kind
                    === 'managed_server.supervision.authorize'
                ) {
                    const managedProviderAuthority =
                        request.operation.operationClaimId
                            ? await runnerDaemonPluginServicesHost
                                .readManagedProviderSupervisionAuthority({
                                    sessionId,
                                    runner,
                                    retainedAgent,
                                    contributionId:
                                        request.operation.contributionId,
                                    operationClaimId:
                                        request.operation.operationClaimId,
                                    serverId: request.operation.serverId,
                                })
                            : null;
                    if (
                        managedProviderAuthority
                        && !managedProviderAuthority.expectedLaunch
                    ) {
                        throw new PluginError({
                            code: 'plugin_managed_server_launch_denied',
                            message: 'Managed Provider server launch has no exact operation-input authority',
                        });
                    }
                    const authorization = managedProviderAuthority
                        ? await authorizeRunnerManagedProviderServerSupervision({
                                paths: resolvePluginStorePaths({
                                    happyHomeDir:
                                        configuration.happyHomeDir,
                                }),
                                sessionId,
                                request: {
                                    ...request.operation,
                                    immutableGenerationId:
                                        managedProviderAuthority
                                            .bootstrap.scope
                                            .immutableGenerationId,
                                },
                                bootstrap:
                                    managedProviderAuthority.bootstrap,
                                expectedLaunch:
                                    managedProviderAuthority
                                        .expectedLaunch!,
                            })
                        : await authorizeRunnerManagedServiceSupervision({
                                paths: resolvePluginStorePaths({
                                    happyHomeDir:
                                        configuration.happyHomeDir,
                                }),
                                binding: retainedAgent,
                                request: {
                                    ...request.operation,
                                    immutableGenerationId:
                                        retainedAgent
                                            .immutableGenerationId,
                                },
                                ...(context.signal
                                    ? { signal: context.signal }
                                    : {}),
                            });
                    return AgentRuntimeDaemonServiceResponseV1Schema.parse({
                        ok: true as const,
                        result: {
                            kind:
                                'managed_server.supervision' as const,
                            status: 'authorized' as const,
                            launch: authorization.launch,
                        },
                    });
                }
                if (
                    request.operation.kind
                    === 'managed_server.endpoint.publish'
                ) {
                    const projection =
                        request.operation.projection;
                    const managedProviderAuthority =
                        projection.operationClaimId
                            ? await runnerDaemonPluginServicesHost
                                .readManagedProviderSupervisionAuthority({
                                    sessionId,
                                    runner,
                                    retainedAgent,
                                    contributionId:
                                        projection.contributionId,
                                    operationClaimId:
                                        projection.operationClaimId,
                                })
                            : null;
                    const managedProviderBootstrap =
                        managedProviderAuthority?.bootstrap ?? null;
                    const isExactAgentContribution =
                        projection.contributionId
                            === `${retainedAgent.pluginId}/agents/${retainedAgent.localAgentId}`;
                    if (
                        (
                            !managedProviderBootstrap
                            && !isExactAgentContribution
                        )
                        || (
                            managedProviderBootstrap
                            && projection.pluginId
                                !== managedProviderBootstrap
                                    .scope.pluginId
                        )
                    ) {
                        return {
                            ok: true as const,
                            result: {
                                kind:
                                    'managed_server.endpoint' as const,
                                status: 'unavailable' as const,
                            },
                        };
                    }
                    const result =
                        await executeRunnerManagedServiceEndpointProjectionBridgeOperation({
                            authority: managedProviderBootstrap
                                ? {
                                    sessionId:
                                        managedProviderBootstrap
                                            .scope.sessionId,
                                    pluginId:
                                        managedProviderBootstrap
                                            .scope.pluginId,
                                }
                                : authority,
                            operation: {
                                kind:
                                    'managed_server_endpoint_publish',
                                projection:
                                    request.operation.projection,
                            },
                            owner:
                                managedServiceDurabilityOwner!,
                        });
                    if (
                        result.kind
                        !== 'managed_server_endpoint_published'
                    ) {
                        throw new Error(
                            'Managed server endpoint publish returned the wrong result',
                        );
                    }
                    return {
                        ok: true as const,
                        result: {
                            kind:
                                'managed_server.endpoint' as const,
                            status: 'published' as const,
                            projectionToken:
                                result.projectionToken,
                        },
                    };
                }
                if (
                    request.operation.kind
                    === 'managed_server.endpoint.release'
                ) {
                    const result =
                        await executeRunnerManagedServiceEndpointProjectionBridgeOperation({
                            authority: {
                                sessionId: authority.sessionId,
                                pluginId:
                                    request.operation.pluginId,
                            },
                            operation: {
                                kind:
                                    'managed_server_endpoint_release',
                                instanceId:
                                    request.operation.instanceId,
                                projectionToken:
                                    request.operation
                                        .projectionToken,
                            },
                            owner:
                                managedServiceDurabilityOwner!,
                        });
                    if (
                        result.kind
                        !== 'managed_server_endpoint_released'
                    ) {
                        throw new Error(
                            'Managed server endpoint release returned the wrong result',
                        );
                    }
                    return {
                        ok: true as const,
                        result: {
                            kind:
                                'managed_server.endpoint' as const,
                            status: 'released' as const,
                            released: result.released,
                        },
                    };
                }
                if (
                    request.operation.kind
                    !== 'managed_server.endpoint.resolve'
                ) {
                    return {
                        ok: true as const,
                        result: {
                            kind:
                                'managed_server.endpoint' as const,
                            status: 'unavailable' as const,
                        },
                    };
                }
                const projection =
                    await managedServiceDurabilityOwner!
                        .resolveEndpointProjection({
                            pluginId: authority.pluginId,
                            sessionId: authority.sessionId,
                            selector:
                                request.operation.selector,
                        });
                return projection
                    && projection.custodyOwner
                        === 'sessionRunner'
                    ? {
                        ok: true as const,
                        result: {
                            kind:
                                'managed_server.endpoint' as const,
                            status: 'resolved' as const,
                            projection,
                        },
                    }
                    : {
                        ok: true as const,
                        result: {
                            kind:
                                'managed_server.endpoint' as const,
                            status: 'unavailable' as const,
                        },
                    };
            },
        },
        recordAgentRuntimeDaemonServiceAdmission:
            async (tracked, admission) => {
                const sessionId =
                    normalizeOptionalString(tracked.happySessionId);
                if (!sessionId) return false;
                return await updateSessionMarkerActiveTurn({
                    pid:
                        tracked.sessionRunnerPid
                        ?? tracked.pid,
                    sessionId,
                    activeTurnId: admission.turnId,
                    agentRuntimeDaemonServiceActiveAdmission:
                        admission,
                });
            },
        clearAgentRuntimeDaemonServiceAdmission:
            async (tracked, admission) => {
                const sessionId =
                    normalizeOptionalString(tracked.happySessionId);
                if (!sessionId) return false;
                return await updateSessionMarkerActiveTurn({
                    pid:
                        tracked.sessionRunnerPid
                        ?? tracked.pid,
                    sessionId,
                    activeTurnId:
                        tracked.activeTurnId
                        ?? null,
                    expectedAgentRuntimeDaemonServiceActiveAdmission:
                        admission,
                });
            },
        foregroundAgentRuntimeAdmission,
        simulatorPreview: simulatorPreviewRuntime.routes,
        connectedAccountRequestAuth: {
            authenticate: connectedAccountRequestAuthRegistry.authenticate,
            lookupRequestAuth: async (input) => {
                return await connectedAccountRequestAuthService
                    .lookupRequestAuth(input);
            },
            refreshAfterAuthFailure: async (input) => {
                return await connectedAccountRequestAuthService
                    .refreshAfterAuthFailure(input);
            },
            reportQuotaFailure: async (input) => {
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

            // Manual auth switch routes through the FSM (reachability
            // gate at respawn, binding persistence, hot-apply-in-place when eligible).
            const result = await switchSessionConnectedServiceAuth({
                core: connectedServiceSessionAuthSwitchCore,
                getChildren: () => Array.from(params.pidToTrackedSession.values()),
                resolveInactiveSession: async ({ sessionId }) => {
                    return await resolveInactiveConnectedServiceSessionContext({
                        token: params.credentials.token,
                        credentials: params.credentials,
                        sessionId,
                        currentMachineId: params.machineId,
                    });
                },
                api: params.api,
                qualifiedConnectedAccountApi,
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
                        runtimeDescriptorV1: continuityContext.runtimeDescriptorV1,
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
                    // Manual restart-resume fallback (hot-apply ineligible) is gated
                    // through deferral and spawn-time reachability.
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
                recoverAfterRuntimeAuthSwitch: createSelectionPostSwitchRecoveryHandler(),
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
                hotApply: createSessionConnectedServiceAuthHotApply({
                    validateGroupMutationCurrentness: validateConnectedServiceGroupMutationCurrentness,
                }),
                registerHotApplyTargets: registerHotApplyRuntimeTarget,
                emitSessionEvent: async (sessionId, event) => {
                    await commitConnectedServiceAccountSwitchSessionEventWithNotification({
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
            const expectedRunnerProcessIdentity = tracked && !('v' in request)
                ? captureRunnerRestartIdentityWitness(tracked)
                : undefined;
            const currentIdentity =
                resolveCurrentSessionRunnerLaunchIdentity();
            const agentRuntimeCurrentness =
                await resolveTrackedRunnerRuntimeCurrentness(
                    tracked,
                );
            return await restartSessionRunnerOnCurrentRuntime({
                request,
                expectedRunnerProcessIdentity,
                tracked,
                currentIdentity,
                resolveCurrentIdentity:
                    resolveCurrentSessionRunnerLaunchIdentity,
                agentRuntimeVersionState:
                    agentRuntimeCurrentness.versionState,
                agentRuntimeRestartUnavailableReason:
                    agentRuntimeCurrentness.restartUnavailableReason,
                resolveAgentRuntimeCurrentness:
                    resolveTrackedRunnerRuntimeCurrentness,
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
                resolveCurrentIdentity:
                    resolveCurrentSessionRunnerLaunchIdentity,
                trackedSessions: Array.from(params.pidToTrackedSession.values()),
                requestRestart: requestSessionRunnerVersionRuntimeRefresh,
                resolveActivityDisabledReason: resolveSessionRunnerActivityDisabledReason,
                resolveAgentRuntimeCurrentness:
                    resolveTrackedRunnerRuntimeCurrentness,
            });
        },
        handleSessionRunnerStatusGet: async (request) => {
            return await resolveSessionRunnerStatus({
                sessionId: request.sessionId,
            });
        },
        handleSessionRunnerStatusV2Get: async (request) => {
            return await resolveSessionRunnerStatusV2({
                sessionId: request.sessionId,
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
                        currentMachineId: params.machineId,
                    }),
                resolveRegisteredRuntimeAuthFailureSource: resolveRegisteredRuntimeAuthFailureSourceForSession,
                resolveCurrentRuntimeAuthFailureSource: resolveCurrentRuntimeAuthFailureSourceForSession,
                resolveProviderQualifiedRuntimeAuthFailureSource: resolveProviderQualifiedRuntimeAuthFailureSourceForSession,
                sessionId,
                classification,
            }),
        resolveConnectedServiceRuntimeAuthResumePromptMode: async ({ classification, explicit }) => {
            // Scheduler intents are sanitized at load, so the key is canonical here; a
            // stale unparseable key degrades to the caller's explicit/standard prompt mode.
            const serviceKey = readBuiltInLegacyConnectedAccountServiceKeyIngress(classification.serviceId);
            if (!serviceKey) return explicit ?? 'standard';
            return await resolveContinuationResumePromptMode({
                serviceId: serviceKey,
                groupId: classification.groupId,
                explicit,
            });
        },
        runtimeAuthRecoveryScheduler,
        handleConnectedServiceTurnLifecycle: async (input) => {
            const lifecycleObservedAtMs = Date.now();
            let pendingSourceCutover =
                pendingRequestAuthSourceCutoverBySessionId.get(
                    input.sessionId,
                ) ?? null;
            if (
                pendingSourceCutover
                && retirePendingRequestAuthSourceCutoverForCurrentSuccessor(
                    pendingSourceCutover,
                )
            ) {
                pendingSourceCutover = null;
            }
            if (
                pendingSourceCutover
                && input.event === 'prompt_or_steer'
            ) {
                if (
                    !input.requestedAction
                    || input.activeTurnId === undefined
                ) {
                    return CONNECTED_SERVICE_TURN_LIFECYCLE_SOURCE_CUTOVER_BLOCK;
                }
                if (input.activeTurnId === null) {
                    const idleCustody =
                        await applyTrackedSessionTurnLifecycle({
                            trackedSessions:
                                params.pidToTrackedSession.values(),
                            sessionId: input.sessionId,
                            event: input.event,
                            activeTurnIdWitness: null,
                    });
                    if (idleCustody.status === 'recorded') {
                        connectedServiceTurnDeferralQueue
                            .recordTurnLifecycleEvent({
                                sessionId: input.sessionId,
                                event: input.event,
                                activeTurnIdWitness: null,
                            });
                        await requestPendingRequestAuthSourceCutoverAtBoundary(
                            pendingSourceCutover,
                        );
                    }
                    return CONNECTED_SERVICE_TURN_LIFECYCLE_SOURCE_CUTOVER_BLOCK;
                }
                const isLiveSteer =
                    input.requestedAction.kind === 'steer_if_active'
                    || input.requestedAction.kind === 'steer_now';
                const retainedActiveTurnId =
                    normalizeOptionalString(
                        pendingSourceCutover.tracked.activeTurnId,
                    )
                    || normalizeOptionalString(
                        pendingSourceCutover.tracked
                            .reattachedInterruptedTurnId,
                    );
                if (
                    !isLiveSteer
                    || retainedActiveTurnId
                        !== input.activeTurnId
                ) {
                    return CONNECTED_SERVICE_TURN_LIFECYCLE_SOURCE_CUTOVER_BLOCK;
                }
            }
            const turnCustody = await applyTrackedSessionTurnLifecycle({
                trackedSessions: params.pidToTrackedSession.values(),
                sessionId: input.sessionId,
                event: input.event,
                ...(input.turnId ? { turnId: input.turnId } : {}),
                ...(pendingSourceCutover
                    && input.event === 'prompt_or_steer'
                    && input.activeTurnId !== undefined
                    ? {
                        activeTurnIdWitness:
                            input.activeTurnId,
                    }
                    : {}),
            });
            const acceptsDownstreamLifecycle = turnCustody.status === 'recorded'
                || turnCustody.status === 'ignored_missing_exact_turn';
            if (!acceptsDownstreamLifecycle || controlRuntimeResourcesDisposed) {
                return connectedServiceTurnLifecycleContinue(
                    turnCustody,
                );
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
            if (
                pendingSourceCutover
                && turnCustody.status === 'recorded'
                && (
                    input.event === 'assistant_message_end'
                    || input.event === 'turn_cancelled'
                )
            ) {
                await requestPendingRequestAuthSourceCutoverAtBoundary(
                    pendingSourceCutover,
                );
            }
            return connectedServiceTurnLifecycleContinue(
                turnCustody,
            );
        },
        handleConnectedServiceQuotaRecoveryCreditConsume: async (input) => {
            const coordinator = params.getConnectedServiceQuotasCoordinator();
            const legacyServiceId =
                resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
                    input.serviceId,
                );
            if (!coordinator || !legacyServiceId) {
                return {
                    ok: false as const,
                    errorCode: 'connected_service_quota_recovery_credit_unavailable',
                    error: 'connected_service_quota_recovery_credit_unavailable',
                };
            }
            return await coordinator.consumeRecoveryCreditForProfile({
                ...input,
                serviceId: legacyServiceId,
            });
        },
        handleProviderAccountUsageSnapshot: async (input) => {
            let qualifiedUsageSource: ConnectedServiceUsageSourceV1 | null = null;
            let claimedSource = input.source;
            if (
                claimedSource?.bindingKind === 'group_member'
                && input.snapshot.accountSubject.kind === 'providerSubject'
            ) {
                const groupSource = claimedSource;
                claimedSource = await resolveProviderAccountUsageSourceProfile({
                    source: groupSource,
                    providerAccountId: input.snapshot.accountSubject.id,
                    getCurrentGroup: async () => {
                        const group = await readQualifiedConnectedServiceAuthGroup({
                            serviceId: groupSource.serviceId,
                            groupId: groupSource.groupId,
                        });
                        return group
                            ? {
                                generation: group.generation,
                                members: group.members.map((member) => ({
                                    profileId: member.connectedAccountId,
                                })),
                            }
                            : null;
                    },
                    resolveProviderAccountId: async (profileId) => {
                        const legacyServiceId =
                            resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
                                groupSource.serviceId,
                            );
                        if (!legacyServiceId) return null;
                        const resolution = await resolveConnectedServiceCredentialResolutions({
                            credentials: params.credentials,
                            api: params.api,
                            bindings: [{ serviceId: legacyServiceId, profileId }],
                        }).then((byServiceId) => byServiceId.get(legacyServiceId) ?? null);
                        return resolution
                            ? readConnectedServiceCredentialProviderAccountId(resolution.record)
                            : null;
                    },
                });
            }
            const capturedClaimedSource = claimedSource;
            const shouldResolveSourceCredential = capturedClaimedSource
                && (
                    input.deriveCredentialFingerprintFromSource === true
                    || input.credentialFingerprint !== undefined
                );
            const sourceForCredential = shouldResolveSourceCredential ? capturedClaimedSource : null;
            const sourceCredentialLegacyServiceId = sourceForCredential
                ? resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
                    sourceForCredential.serviceId,
                )
                : null;
            const sourceCredentialResolution = sourceForCredential
                && sourceCredentialLegacyServiceId
                ? await resolveConnectedServiceCredentialResolutions({
                    credentials: params.credentials,
                    api: params.api,
                    bindings: [{
                        serviceId: sourceCredentialLegacyServiceId,
                        profileId: sourceForCredential.profileId,
                    }],
                }).then((byServiceId) => byServiceId.get(sourceCredentialLegacyServiceId) ?? null)
                : null;
            const sourceCredentialRecord = sourceCredentialResolution?.revisionSemantics === 'revisioned'
                ? sourceCredentialResolution.record
                : null;
            const credentialFingerprint = capturedClaimedSource
                && input.deriveCredentialFingerprintFromSource === true
                && input.credentialFingerprint === undefined
                ? sourceCredentialRecord?.kind === 'oauth'
                    ? computeConnectedServiceAccessTokenFingerprint(
                        sourceCredentialRecord.oauth.accessToken,
                    )
                    : null
                : input.credentialFingerprint;
            const result = await recordProviderAccountUsageSnapshotForSession({
                getChildren: () => Array.from(params.pidToTrackedSession.values()),
                store: providerAccountUsageStore,
                persistence: providerAccountUsagePersistence,
                ...(capturedClaimedSource ? { observation: { sources: [capturedClaimedSource] as const } } : {}),
                credentialFingerprint,
                verifyCredentialFingerprint: async (candidate) => {
                    const serviceId = ConnectedAccountServiceKeySchema.safeParse(
                        readBuiltInLegacyConnectedAccountServiceKeyIngress(candidate.serviceId),
                    );
                    const claimedServiceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(
                        capturedClaimedSource?.serviceId,
                    );
                    if (!serviceId.success) return false;
                    if (
                        claimedServiceId !== serviceId.data
                        || capturedClaimedSource?.profileId !== candidate.profileId
                        || sourceCredentialResolution?.revisionSemantics !== 'revisioned'
                    ) {
                        return false;
                    }
                    const record = sourceCredentialResolution.record;
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
                resolvePersistenceTargets:
                    resolveQualifiedProviderAccountUsagePersistenceTargets,
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
                    serviceId: ConnectedAccountServiceKey;
                    profileId: string;
                    groupId: string | null;
                    groupGeneration: number | null;
                    credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
                    observedAtMs: number;
                }> | null = null;
                if (
                    isProviderAccountUsageStoreMutationAccepted(result)
                    && qualifiedUsageSource
                    && credentialFingerprint
                    && input.snapshot.accountSubject.kind === 'providerSubject'
                ) {
                    const source = qualifiedUsageSource;
                    const serviceId = ConnectedAccountServiceKeySchema.safeParse(
                        readBuiltInLegacyConnectedAccountServiceKeyIngress(source.serviceId),
                    );
                    const legacyServiceId = serviceId.success
                        ? resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(serviceId.data)
                        : null;
                    const claimedServiceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(
                        capturedClaimedSource?.serviceId,
                    );
                    const coordinator = params.getConnectedServiceQuotasCoordinator();
                    const projected = legacyServiceId
                        ? projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1({
                            snapshot: input.snapshot,
                            source: { ...source, serviceId: legacyServiceId },
                        })
                        : null;
                    const credentialResolution = serviceId.success
                        && claimedServiceId === serviceId.data
                        && capturedClaimedSource?.profileId === source.profileId
                        ? sourceCredentialResolution
                        : null;
                    const credential = credentialResolution?.record ?? null;
                    sourceIsExactlyCurrent =
                        credentialResolution?.revisionSemantics === 'revisioned'
                        && credential?.kind === 'oauth'
                        && credential.oauth.providerAccountId === input.snapshot.accountSubject.id
                        && computeConnectedServiceAccessTokenFingerprint(credential.oauth.accessToken) === credentialFingerprint;
                    if (
                        serviceId.success
                        && legacyServiceId
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
                            serviceId: legacyServiceId,
                            profileId: source.profileId,
                            expectedAppliedIdentity: {
                                serviceId: legacyServiceId,
                                profileId: source.profileId,
                                groupId,
                                groupGeneration,
                                providerAccountId: credential.oauth.providerAccountId,
                                materialFingerprint: computeConnectedServiceAccessTokenFingerprint(credential.oauth.accessToken),
                            },
                            snapshotAppliedIdentity: {
                                serviceId: legacyServiceId,
                                profileId: source.profileId,
                                groupId,
                                groupGeneration,
                                providerAccountId: input.snapshot.accountSubject.id,
                                materialFingerprint: credentialFingerprint,
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
            resolvePersistenceTargets:
                resolveQualifiedProviderAccountUsagePersistenceTargets,
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
    foregroundAgentRuntimeHttpPort = controlPort;
    connectedAccountRequestAuthHttpPort = controlPort;
    params.onConnectedAccountRequestAuthHttpPortReady?.(controlPort);
    const reattachedAuthorityRefreshes = await Promise.allSettled(
        [...params.pidToTrackedSession.values()]
            .filter((tracked) => (
                tracked.reattachedFromDiskMarker === true
                && Boolean(
                    normalizeOptionalString(tracked.happySessionId)
                    && tracked.agentRuntimeDaemonServiceAuthorityFilePath,
                )
            ))
            .map(async (tracked) => {
                const sessionId =
                    normalizeOptionalString(tracked.happySessionId);
                if (!sessionId) return;
                await refreshTrackedRunnerAgentAuthority(
                    tracked,
                    sessionId,
                    controlPort,
                );
            }),
    );
    for (const outcome of reattachedAuthorityRefreshes) {
        if (outcome.status === 'rejected') {
            logger.debug(
                '[DAEMON RUN] Reattached Runner Agent authority refresh failed closed',
                outcome.reason,
            );
        }
    }
    await rehydrateLiveExecutionRunTargets({
        markers: listExecutionRunMarkersForRehydration,
        adopt: executionRunConnectedServicesBridge.adoptLiveMaterialization,
        cleanupTerminal:
            executionRunConnectedServicesBridge.cleanupTerminalMaterialization,
        clearTerminalCleanupReceipt:
            clearExecutionRunConnectedServicesCleanupReceipt,
        proveRunnerLive: async (marker) => {
            if (marker.happySessionId === null) return false;
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
    const reattachedRuntimeTargets = connectedServiceRuntimeRegistry
        .listTargets()
        .filter((target) => !connectedServiceRuntimeRegistry.isRunTarget(target));
    const initialRuntimeTargetGenerationReconciliation = Promise.allSettled(
        reattachedRuntimeTargets.map((target) => (
            scheduleRuntimeTargetGenerationReconciliation(
                target,
                undefined,
                false,
                false,
            )
        )),
    );
    void initialRuntimeTargetGenerationReconciliation.then((outcomes) => {
        for (const outcome of outcomes) {
            if (outcome.status === 'rejected') {
                logger.debug('[DAEMON RUN] Failed to reconcile connected-service provider adoption after daemon replacement', {
                    error: serializeAxiosErrorForLog(outcome.reason),
                });
            }
        }
    });
    let reattachedCredentialProjectionReconciliation: Promise<void> | null = null;
    const reconcileReattachedConnectedServiceCredentialProjection = (): Promise<void> => {
        if (reattachedCredentialProjectionReconciliation) {
            return reattachedCredentialProjectionReconciliation;
        }
        reattachedCredentialProjectionReconciliation = (async () => {
            const initialReconciliationOutcomes =
                await initialRuntimeTargetGenerationReconciliation;
            const currentTargets = reattachedRuntimeTargets.filter(
                (target) => isCurrentRuntimeGenerationTarget(target),
            );
            if (currentTargets.length === 0) return;
            const projectionSnapshot =
                await fetchConnectedServiceProjectionSnapshot();
            await reconcileDirectCredentialProjectionForTargets(
                projectionSnapshot,
                currentTargets,
                'passive_projection',
            );
            if (latestConnectedServiceProjectionSnapshot !== projectionSnapshot) return;
            for (const [index, target] of reattachedRuntimeTargets.entries()) {
                if (initialReconciliationOutcomes[index]?.status !== 'fulfilled') {
                    continue;
                }
                if (isCurrentRuntimeGenerationTarget(target)) {
                    reconciledProjectionByRuntimeTarget.set(target, projectionSnapshot);
                }
            }
        })();
        return reattachedCredentialProjectionReconciliation;
    };
    const stopControlServerWithConnectedServiceDeferralCleanup = async (): Promise<void> => {
        await runControlRuntimeShutdownPhases([
            ['control_server_stop', stopControlServer],
        ]);
    };

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
                await reconcileDirectCredentialProjectionForTargets(
                    projectionSnapshot,
                    connectedServiceRuntimeRegistry.listTargets()
                        .filter((target) => connectedServiceRuntimeRegistry.isRunTarget(target)),
                    notification.executionAuthority,
                    notification.signal,
                );
                notification.signal.throwIfAborted();
            },
        });
    };
    return {
        ...(externalActionIngressOwner ? { externalActionIngressOwner } : {}),
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
        consumeCommittedAuthGroupGeneration,
        // Gated application fallback restart adapter (turn-deferral + reachability).
        requestConnectedServiceRefreshRestartSignal,
        cancelConnectedServiceRuntimeAuthRecovery: async ({ sessionId, attemptId }) =>
            await runtimeAuthRecoveryScheduler.cancelExact({ sessionId, attemptId }),
        retryTemporaryThrottleNow: async ({ sessionId }) =>
            await temporaryThrottleScheduler.wake({ sessionId, reason: 'manual' }),
        reconcileReattachedConnectedServiceCredentialProjection,
        reconcileConnectedServicesProjection,
        awaitAgentSessionOpen: async (input) =>
            await awaitTrackedRunnerAgentSessionOpen({
                getTrackedSessions: () =>
                    Array.from(
                        params.pidToTrackedSession.values(),
                    ),
                ...input,
            }),
        installExternalSessionHostOperations: (operations) =>
            externalSessionHostOperationOwner.install(operations),
        providerAccountUsageStore,
        // Provider account-usage persistence pauses a key after repeated write
        // failures and retains its last payload. Reconnect is the only signal that
        // the failure cause is gone, so the daemon connectivity lifecycle resubmits
        // the retained material through the scheduler's existing flush.
        flushProviderAccountUsagePersistence: async (timeoutMs: number) =>
            await providerAccountUsagePersistence.flush(timeoutMs),
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
                    return await connectedAccountRequestAuthService.lookupRequestAuth(input);
                },
                refreshAfterAuthFailure: async (input) => {
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

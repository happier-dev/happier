import { refreshTrackedSessionsRuntimeSnapshot, resolveRespawnSessionOptionsWithRuntimeSnapshot } from '@/daemon/sessions/runtimeSnapshot/respawn';
import { snapshotTrackedSessionForTemporaryThrottleResume, buildTrackedExistingSessionResumeSeed } from '@/daemon/connectedServices/usageLimitRecovery/resumeSource';
import { persistExplicitSessionStopUsageLimitRecoveryCancellation } from '@/daemon/connectedServices/usageLimitRecovery/explicitStop';
import { tryReadSessionMetadataRecord, resolvePersistedConnectedServiceSwitchSessionState, resolveInactiveConnectedServiceSessionContext } from '@/daemon/connectedServices/sessionAuthSwitch/persistedState';
import { resolveConnectedServiceMaterializationIdentityFromTrackedSession, resolveSessionConnectedServiceSwitchContinuity } from '@/daemon/connectedServices/sessionAuthSwitch/continuity';
export { resolveSessionConnectedServiceSwitchContinuity } from '@/daemon/connectedServices/sessionAuthSwitch/continuity';
import { resolveContinuationResumePromptMode, resolveConnectedServiceContinuationOriginId, readContinuationCustomResumePrompt, createConnectedServiceContinuationHandler, createSelectionPostSwitchRecoveryHandler, resolveConnectedServiceContinuationInterruptionForSwitch } from '@/daemon/connectedServices/continuation/switchRecovery';
export { resolveContinuationResumePromptMode, resolveConnectedServiceContinuationOriginId, resolveConnectedServiceContinuationInterruptionForSwitch } from '@/daemon/connectedServices/continuation/switchRecovery';

export { isRetainedManagedProviderInvocationCurrent, isManagedProviderSessionInvocationCurrent } from '@/providers/broker/invocationCurrentness';
import { isSupersededRuntimeAuthFailure, settleSupersedingRuntimeAuthGenerationForSource } from '@/daemon/connectedServices/runtimeAuth/supersedingGeneration';
export { isSupersededRuntimeAuthFailure, settleSupersedingRuntimeAuthGenerationForSource } from '@/daemon/connectedServices/runtimeAuth/supersedingGeneration';
import { persistSessionConnectedServiceBindings, selectConnectedServiceCredentialBindingIntentsForPersist, repairMissingConnectedServiceMaterializationIdentityForSpawn } from '@/daemon/connectedServices/sessionAuthSwitch/bindingPersistence';
import { buildManualSwitchRestartDiagnostic, toConnectedServiceAuthSwitchDiagnosticError, attachConnectedServiceAuthSwitchDiagnostics, logConnectedServiceAuthSwitchResult, connectedServiceAuthGroupGenerationApplyFailure } from '@/daemon/connectedServices/sessionAuthSwitch/diagnostics';
import { rehydrateConnectedServiceRuntimeIdentityForSessionReport, recordRuntimeAccountIdentityFromVerification } from '@/daemon/connectedServices/runtimeAuth/rehydration';
import { normalizeOptionalString, normalizeRuntimeAuthApplyReason, normalizeNullableGeneration, normalizeSwitchTarget } from '@/daemon/connectedServices/sessionAuthSwitch/targets';
import { matchesCurrentQuotaObservationCredential } from '@/daemon/connectedServices/quotas/proof/quotaProbeFreshProof';


import axios from 'axios';



import { SessionTeamCredentialLaunchUnavailableError } from '@/session/services/sessionTeamCredentialLaunch';
import { retireObservedSessionRunnerMetadata } from '../sessions/plainRunnerRetirement';
import { actionStartTargetUnavailableV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import type { PendingSessionResumeAdmission, PendingSessionResumePort } from '../sessions/activatePendingInactiveSession';
import { DiscussionAgentPublisherResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import type { DiscussionAgentPublisherPrivateRequestV1 } from '@/discussions/discussionAgentPublisher';



import { readWebLatencyTracePoint, timeWebLatencyPhase, withWebLatencyTrace } from '../externalActions/webLatencyTrace';
import { resolveExistingSessionAttachContext } from '../sessionEncryption/resolveExistingSessionAttachContext';
import { createProcessOwnershipRuntime } from '../processes/ownership/processOwnershipRuntime';
import { readLanguageServerProcessRoots } from '@/lsp/languageServerHost';
import { createEndOwnerRemainder } from '../processes/endOwnerRemainder';
import { createSessionProcessActionLifecycle, type SessionProcessActionLifecycle } from '../sessions/sessionProcessActionLifecycle';
import { clearSessionExplicitStopIntentAfterResume, recordSessionStopIntent, resolveSessionExplicitControlIntent, resolveSessionResumeControlIntent } from '@/session/services/sessionExplicitStopIntent';
import { resolveSessionRoleRpcOrigin } from '@/session/actions/sessionRoleRpcOrigin';
import { resolveSessionOwningMachineId } from '@/session/services/resolveSessionOwningMachine';
import { resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { readSessionExplicitStopV1FromMetadata, resolveSessionAutoResumeAdmissionV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';

import { createProcessActionOwnerAdapters } from '../processes/actions/processActionOwnerAdapters';
import { createLeftBehindPass } from '../processes/leftBehind/leftBehindPass';
import type { HappierProcessRoot } from '../processes/ownership/types';
import { listHappierProcessRoots, readProcessOwnershipBootTimeMs, readTrackedSessionProcessIdentity, type HappierProcessRootSource } from '../processes/roots/listHappierProcessRoots';
import { resolveProcessOwnerScopeKey } from '@/processes/ownerTag';

import { getSharedTerminalProcessRegistry } from '../local/services/inventory/terminalRegistry';
import { randomBytes, randomUUID } from 'node:crypto';
import { issueMcpRequestAuthCapability } from '@/mcp/runtime/issueMcpRequestAuthCapability';
import { createSessionBrokerApplicationEvidence, recordSessionBrokerApplicationEvidenceRead } from '@/providers/broker/sessionBrokerApplicationEvidence';
import { readMcpRequestAuthFailureCode, readMcpRequestAuthDiagnosticCode } from '@/mcp/runtime/mcpRequestAuth';
import { createDaemonRunnerPluginMcp } from '../agentRuntime/runnerPluginMcp';
import { createGuardLeftBehindActionExecutor } from '../guard/actions';
import type { DaemonAdmissionDrain } from '../lifecycle/admissionDrain';
import { createSessionLiveWorkProducer } from '../lifecycle/sessionLiveWorkProducer';
import { createSessionFollowOccurrenceDispatcher } from '@/agent/runtime/session/follow/sessionFollowOccurrenceDispatcher';
import { createObservedAccountRunFollowRoutes } from '@/agent/runtime/session/follow/accountRunFollowRoutes';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { reportPendingSessionActivationFailure } from '@/api/session/pendingActivationTransport';
import { readTrackedSessionInputLiveWorkRequired } from '../lifecycle/readTrackedSessionInputLiveWork';
import { waitForChangeOrDeadline } from '../lifecycle/waitForChangeOrDeadline';
import { prepareSessionRunnerRestartAdmission, SessionRunnerRestartAdmissionUnsupportedError } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import { ExecutionRunListResponseSchema, isExecutionRunActive } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { readTrackedSessionMaterializedStateObservationBinding } from '../sessions/trackedSessionFromMarker';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { createSessionStartupReadinessHandler } from './sessionStartupReadiness';
import { readRequesterAgentStartPolicyV1 } from '../sessionEncryption/requesterAgentStartPolicy';



import type { ActionOperationRpcContext } from '../actionOperations/actionOperationRpcHandlers';
import type { ConnectedServicePoolSelectionRead } from '@/api/machine/rpcHandlers.connectedAccounts';
import { ConnectedServicePoolSelectionGetResponseV1Schema } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { createDaemonManagedMachineActionAdapter, type ManagedMachinePolicyRequest } from './managedMachineActionAdapter';

import { executeManagedMachinePolicyAction } from './managedMachinePolicyAction';
import type { ActionExecuteResult, ExternalActionTargetV1 } from '@happier-dev/protocol';

import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { MANAGED_MACHINE_ACTION_IDS_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';

import { resolveExternalActionMachineTarget } from '../externalActions/reconcileExternalActionTarget';
import { readManagedMachine } from '@/machines/managed/readManagedMachine';



import type {
  ApiMachineClient,
  ConnectedServicesProjectionNotification,
} from '@/api/apiMachine';
import type { Metadata, SessionCreationOutcome } from '@/api/types';
import { fetchAccountProfile } from '@/api/accountProfile';
import { fetchSessionById as fetchForegroundSessionById } from '@/session/transport/http/sessionsHttp';
import { readSessionAccessProjectionRoleV1 as readForegroundSessionAccessRole } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { resolveAccountSettingsScopeKey as resolveForegroundAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import {
  createSpawnConnectedServicesTeamResourceCatalogResolver as createForegroundTeamResourceCatalogResolver,
  resolvePurposeTeamCredentialBindingIntentsFromHome as resolveForegroundTeamCredentialBindingIntents,
} from '@/session/services/spawnConnectedServicesDefaults';
import { createProviderErrorV1 as createForegroundProviderError } from '@happier-dev/protocol/providers/errors';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type {
  RequesterSessionRuntimeContext,
  RequesterSessionRuntimeContextPorts,
} from '../sessionEncryption/requesterSessionCredentials';
import { releaseUnretainedRequesterSessionRuntimeContext } from '../sessionEncryption/requesterSessionCredentials';
import { isOriginalOwnAccountActionCustody, prepareInstalledRequesterAccountActionContext } from "../sessionEncryption/requesterAccountActionProjection";
import { readRequesterAccountActionContext, type RequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";





import {
  decodeJwtPayload,
  readAccountIdFromToken as readPreviewAccountIdFromToken,
} from '@/cloud/decodeJwtPayload';
import { ExternalActionActionIdV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

import { resolveAvailableAccountSettings } from '@/settings/accountSettings/resolveAvailableAccountSettings';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { refreshTerminalPresentUserPolicy } from '@/settings/accountSettings/resolveEffectiveTerminalPresentUserPolicy';
import { getSessionNotificationTitle } from '@/agent/runtime/notifications/sessionNotificationContext';
import { createPersonalFollowOccurrenceDispatcher } from '@/notifications/activity/dispatchPersonalFollowOccurrence';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { PushNotificationClient } from '@/api/pushNotifications';
import { projectSessionFollowOccurrenceDiagnostic, type SessionActivityChangedResult } from '@/daemon/sessions/sessionActivityChangedContract';

import {
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
  resolveActiveAccountSettingsSnapshotRevision,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createProviderManagedRuntimeBindingFingerprintV1 } from '@happier-dev/protocol/providers/contributions';
import { SessionExecutionRunBrokerAuthorityRequestV1Schema, SessionExecutionRunBrokerAuthorityResponseV1Schema } from '@happier-dev/protocol/daemon/executionRuns';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { startManagedProviderConsumerApplication } from '@/providers/broker/managedProviderConsumerApplication';
import type { AgentRuntimeDaemonServiceRequestV1, AgentRuntimeDaemonServiceResponseV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { logger } from '@/ui/logger';
import { createDaemonQualifiedRequestAuthCallbacks } from '../connectedServices/requestAuth/createDaemonQualifiedRequestAuthCallbacks';
import { resolveRequesterSessionRuntimeDirectories } from '../sessionEncryption/createRequesterSessionRuntimeContext';
import { assertRequesterSessionAccountContextCurrent, listRequesterSessionCredentialBindings } from "../sessionEncryption/requesterSessionCredentials";
import { readRequesterHomeWithinActionLifetime, runWithRequesterSessionCurrentnessCheckpoint } from "@/daemon/sessionEncryption/requesterCurrentness";
import { buildRuntimeAuthUsageLimitRecoveryProjection } from '@/daemon/connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoveryUsageLimitMetadata';
import { checkRuntimeAuthUsageLimitRecovery } from '@/daemon/connectedServices/runtimeAuth/checkRuntimeAuthUsageLimitRecovery';
import { isCurrentUsageLimitRecoveryAccount } from '@/daemon/connectedServices/runtimeAuth/isCurrentUsageLimitRecoveryAccount';
import { continueAccountQualifiedSessionAfterUsageLimitReset } from '@/daemon/connectedServices/continuation/continueSessionAfterUsageLimitReset';
import { readQualifiedConnectedAccountCredentialMaterial, readQualifiedConnectedAccountCredentialIdentity } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { projectTemporaryThrottleRecoveryMetadata } from '@/daemon/connectedServices/runtimeAuth/projection/temporaryThrottleRecoveryMetadata';
import { resolveConnectedServiceCredentialResolutions } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import { resolveConnectedServiceAccountMode } from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import { validateConnectedServiceGroupMutationCurrentness as validateGroupMutationCurrentness } from '../connectedServices/accountGroups/generation/validateGroupMutationCurrentness';
import type { QualifiedConnectedAccountPeerOperationTransport } from '@/api/client/qualifiedConnectedAccountApi';
import {
  listQualifiedConnectedAccountsV4,
  readQualifiedConnectedAccountGroupV4,
} from '@/api/client/qualifiedConnectedAccountApi';
import { resolveConcreteBackendTargetRefV2 } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import { ComposerRefV1Schema } from '@happier-dev/protocol/plugins/ui/composerRef';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import {
  ConnectedServiceBindingsV2IngressSchema,
  ConnectedAccountServiceKeySchema,
  ConnectedServiceIdSchema,
  readBuiltInLegacyConnectedAccountServiceKeyIngress,
} from '@happier-dev/protocol/connect/connected-service-bindings';
import {
  DEFAULT_LOCAL_SERVICE_PAGE_TITLE_CONCURRENCY,
  DEFAULT_LOCAL_SERVICE_PAGE_TITLE_FAILURE_TTL_MS,
  DEFAULT_LOCAL_SERVICE_PAGE_TITLE_MAX_BODY_BYTES,
  DEFAULT_LOCAL_SERVICE_PAGE_TITLE_SUCCESS_TTL_MS,
  DEFAULT_LOCAL_SERVICE_PAGE_TITLE_TIMEOUT_MS,
} from '@happier-dev/protocol/features/payload/capabilities/localServiceCapabilities';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { parseBooleanEnv } from '@happier-dev/protocol/env/parseBooleanEnv';
import { projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol/connect/accountUsage';

import { resolveConnectedServicesProviderStateSharingPolicyV1 } from '@happier-dev/protocol/account/settings/connected-services';
import { writeProviderAccountUsageRecordIdToMetadata } from '@happier-dev/protocol/sessions/metadata/providerAccountUsageRefsV1';

import { ProviderErrorV1Schema, ProviderErrorCodeV1Schema } from '@happier-dev/protocol/providers/errors';
import { projectProviderRuntimeBindingBasis } from '@/providers/spawn/runtimeBindingBasis';
import { createAccountScopedProviderModelProjectionReader } from '@/providers/modelManagement/remoteProjection';

import { bindInactiveSessionControlLaunchScope } from '../spawn/inactiveSessionControlLaunchScope';
import { prepareInactiveSessionControlLaunchScope } from '../spawn/prepareInactiveSessionControlLaunchScope';
import type { ExecutionRunProviderLaunchRequest } from '@/agent/runtime/bridges/executionRun/runtime/providerLaunch';
import type { RunnerExecutionRunProviderPreparation } from '@/daemon/agentRuntime/runnerExecutionRunProviderLaunch';
import type { ExternalActionExecutionAuthorizationV1, ComposerRefV1, ConnectedAccountServiceKey, ConnectedServiceBindingsV2, ConnectedServiceCredentialRevisionV1, ConnectedServiceExecutionAuthorityV1, ConnectedServiceId, ConnectedServiceMaterializationIdentityV1, ConnectedServiceUsageSourceV1, ProviderAccountUsageSnapshotV1, MachineSessionTerminalAuthorityV1, QualifiedConnectedAccountServiceRef, ProviderAccountUsageRecordId, RequestAuthFailureOutcomeV1, SessionContinuationResumePromptModeV1, SessionRunnerRestartDisabledReason, SessionRunnerRuntimeStateV1, SessionRunnerRuntimeStatusV2, SessionRunnerStatusGetRequestV1 } from '@happier-dev/protocol';

import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { TeamCredentialErrorCodeV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';

import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isRpcMethodNotAvailableError } from '@happier-dev/protocol/rpcErrors';
import { PluginUiArtifactDigestV1Schema } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import { verifyPluginUiArtifactFileSetIntegrityV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import { COMPOSER_SOURCE_REF_PRIVATE_META_FIELD_V1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import {
  type TerminalHostAdapter,
} from '@happier-dev/agents';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { resolveAgentContributionQualifiedId } from '@/plugins/projection/registry/agentRoutingIdentity';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { authorizeDaemonSessionModelTransitionProviderTarget, authorizeSessionModelTransitionProviderTargetWithLease } from '@/providers/sessions/authorizeSessionModelTransitionTarget';



import { createCredentialedTargetActionCurrentIntent } from '@/session/actions/approvals/credentialedTargetActionCurrentIntent';

import { readCurrentCatalogHook } from '@/agent/catalog/runtimeEntry';
import {
  findCatalogEntry,
  isLegacyServiceKeyedCompatibilityCatalogAgent,
  readDeclaredCatalogConnectedServiceIds,
} from '@/agent/catalog/registry';
import {
  getConnectedServiceRuntimeAuthAdapter,
  classifyConnectedServiceRuntimeFailureForTarget,
  getConnectedServiceStateSharingDescriptor,
  resolveLegacyConnectedServiceRuntimeAuthFailureSourceRevisionThroughCatalog,
  resolveConnectedServiceGenerationApplicationScope,
  resolveConnectedServicePredictiveSoftSwitchCapability,
  resolveConnectedServiceMaterializedHomeRoot,
} from '@/daemon/connectedServices/catalogHooks';
import { resolveConnectedServiceTargetMaterializedRoot } from '@/daemon/connectedServices/materialize/resolveConnectedServiceTargetMaterializedRoot';
import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { createConnectedServiceRuntimeAuthNativeHome } from '@/daemon/connectedServices/runtimeAuth/createRuntimeAuthNativeHome';
import type {
  CatalogAgentId,
} from '@/agent/catalog/types';
import { createSessionConnectedServiceAuthTransport } from '@/session/runtime/control/transport';
import {
  DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
  createSessionTranscriptFollowLeaseRegistry,
} from '@/api/session/transcriptQueries';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

import { createLocalServicesDaemonRuntimeActionExecutor } from '@/daemon/local/services/actions/runtimeActionExecutor';
import { createProjectServiceRelocationRoute } from '@/daemon/local/services/actions/projectServiceRelocationRoute';
import { createLocalServicesDaemonFeatureGate } from '@/daemon/local/services/featureGate';
import type { createManagedServicesOwner, ProjectManagedServiceHandle } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { mintExternalActionExecutionAuthorization, prepareExternalActionRequesterAccountAuthorization, verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import type { SessionSpawnDirectTargetTransport } from '@/session/actions/createCliActionDeps';
import type { ExternalSessionPluginAdmissionOwner } from '@/session/actions/externalSessions/pluginExternalSessionAdmissionOwner';
import type {
  ActionExecutorDeps,
  RuntimeActionExecute,
} from '@happier-dev/protocol/actions';
import { createAccountServerPatIntrospector } from '../auth/accountServerPatIntrospector';
import { createAccountServerPatEncryptionAccessReader } from '../auth/accountServerPatEncryptionAccess';
import { createDaemonPatVerifier } from '../auth/daemonPatVerifier';
import {
  createDaemonExternalActionContributedApprovalReplay,
  createDaemonExternalActionContributedDefinitionLister,
  createDaemonExternalActionContributedInvoker,
} from '../externalActions/createDaemonExternalActionContributedInvoker';
import {
  createDaemonApprovalExecutionOriginCurrentnessFromCredentials,
  createDaemonExternalActionTargetResolver,
} from '../externalActions/daemonExternalActionTargetResolver';
import type { ExternalActionIngressOwner } from '@/rpc/handlers/externalAction';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { readSettings, readStoredCredentialsForServerId, sameStoredCredentials, type StoredCredentials } from '@/persistence';

import type { ConnectedServiceDaemonAuthBridgeRegistration } from '../connectedServices/daemonAuthBridgeTypes';
import type { DeviceLocalSecretStorage } from '../deviceLocalSecretStorage';

import {
  startDaemonControlServer,
  resolveTrackedAgentRuntimeDaemonServiceAuthority,
  type AgentRuntimeDaemonServiceRoutes,
} from '../controlServer';
import { createDaemonSessionAccountActionExecutor, logDaemonSessionAccountActionRefusalV1 } from '../agentRuntime/createDaemonSessionAccountActionExecutor';
import { createOnDaemonSessionStartupFailure } from '../sessions/onHappySessionWebhook';
import {
  AgentRuntimeDaemonModelTransitionAuthorizationResultV1Schema,
  AgentRuntimeDaemonTurnContributionsResultV1Schema,
  COMPOSER_STAGED_MEDIA_ADMISSION_SETTLEMENT_FIELD,
} from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createRunnerExecutionRunSnapshots } from '../agentRuntime/runnerExecutionRunSnapshots';
import { readCurrentReviewHostPluginAuthority } from '@/agent/executionRuns/profiles/review/pluginAuthority';
import { RunnerDaemonPluginServiceOperationV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
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
import { finalizeComposerStagedMediaToSession } from '@/session/media/finalizeComposerStagedMediaToSession';
import { prepareComposerAttachmentDraftsForSendV1 } from '@/session/composer/prepareComposerAttachmentDraftsForSendV1';
import { garbageCollectUncommittedSessionMedia } from '@/session/media/garbageCollect';
import { settleComposerStagedMediaAdmissionV1 } from '@/session/media/settleComposerStagedMediaAdmission';
import { createActiveDaemonComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import type { MachineRpcHandlerDeps } from '@/api/machine/rpcHandlers';
import { withTrackedSessionRpc } from '../sessionEncryption/withTrackedSessionRpc';

import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { traceRunPreparationPhase } from '@/providers/diagnostics';
import { createDaemonShutdownCancellationDomains } from './shutdownCancellationDomains';
import type { DaemonPluginChangeService } from '@/plugins/daemon/changeService';
import {
  resolveConnectedServiceAuthForSpawn,
  type ConnectedServiceQualifiedAuthGroupApi,
} from '../connectedServices/resolveConnectedServiceAuthForSpawn';
import { isValidConnectedServiceRunMaterializeToken } from '../connectedServices/runs/capabilityToken';
import { createExecutionRunConnectedServicesBridge, registerExecutionRunConnectedServicesTarget, type CreateExecutionRunConnectedServicesBridgeDeps } from '../connectedServices/runs/executionRunMaterialization';
import { acknowledgeExecutionRunAuthGroupGeneration, resolveExecutionRunAuthForSpawn } from '../connectedServices/runs/resolveAuthForSpawn';
import { isExecutionRunConnectedServiceGenerationCurrent } from '../connectedServices/runs/executionRunGenerationAdmission';
import {
  reattestRunningExecutionRunConnectedServices,
  rehydrateLiveExecutionRunTargets,
} from '../connectedServices/runs/rehydrateExecutionRunTargets';
import { createAdoptedExecutionRunRootCleanup } from '../connectedServices/runs/createAdoptedExecutionRunRootCleanup';
import { resolveConnectedServiceMaterializedRootDir } from '../connectedServices/materialize/resolveConnectedServiceMaterializedRootDir';
import {
  createExecutionRunLiveWorkProducer,
  clearExecutionRunConnectedServicesCleanupReceipt,
  readRetainedExecutionRunRecord,
  listExecutionRunMarkersForRehydration,
} from '../executionRunRegistry';
import { createComposedSimulatorPreviewAdapter } from '../devices/simulator/adapter';
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

import { type BrowserDiagnosticsRoutes } from '../browser/diagnostics/routes';
import { type BrowserDiagnosticsActionRoutes } from '../browser/diagnostics/actionRoutes';



import { type BrowserDaemonControlRoutes } from '../browser/control/routes';
import { type BrowserContextRoutes } from '../browser/context/routes';
import { createComputerRoutes, type ComputerRoutes } from '../computer/routes';
import { type BrowserContextSource } from '../browser/context/source';






import type { ProvisionBrowserAutomationRuntime } from '../browser/actions/runtimeActionExecutor';
import { type BrowserAutomationRoutes } from '../browser/automation/routes';




import { type BrowserRecordingDaemonRuntime, type BrowserRecordingDaemonRuntimeOptions } from '../browser/recording/runtime';





import { type DesktopBrowserRecordingFrameCaptureInvoke } from '../browser/recording/adapters/nativeViewTransport';



import type { BrowserUiAutomationRouteOwner } from '../runtimeActionExecutor';
import type { BrowserRecordingRoutes } from '../browser/recording/routes';



export type { DaemonBrowserStoragePurgeOwner } from '@/daemon/browser/control/routePublication';
import type { DaemonBrowserStoragePurgeOwner } from '@/daemon/browser/control/routePublication';

import type { BrowserSidecarControlAdapterFactory, BrowserSidecarControlAdapterFactoryInput, BrowserSidecarControlAdapterFactoryResult } from '../browser/sidecar/controlAdapter';

import { type BrowserDaemonFeatureGate } from '../browser/featureGate';
import type { MachineLiveStreamCaptureRegistry } from '../peer/mediation/stream';
import {
  createLocalServicesDaemonRuntime,
  type LocalServicesDaemonRuntime,
} from '../local/services/runtime';
import { readLocalServiceWorkspaceFacts } from '../local/services/inventory/workspaces';
import { listSessionMarkers } from '../sessionRegistry';
import {
  fetchServerFeaturesSnapshot,
  type CliServerFeaturesSnapshot,
} from '@/features/serverFeaturesClient';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import type { LocalServicesRuntimeActionRoutes } from '../local/services/actions/runtimeActionExecutor';
import type { DaemonLocalServicesMachineRpcRoutes } from '@/rpc/handlers/daemonLocalServices';
import { createLocalPageTitleEnricher } from '../local/services/inventory/pageTitle';
import type { LocalServicePreviewRoutes } from '../local/services/preview/routes';
import { createLocalServicePublicPreviewServerRoutes } from '../local/services/public/routes';
import { resolveHostedWebStaticAssetLifecycleSource } from '../local/services/plugins/staticAssets/source';
import { createOnChildExited } from '../sessions/onChildExited';
import type { SkillStore } from '@/prompts/skills/store/skillStore';
import type { SkillUsageRecorder } from '@/prompts/skills/store/skillUsage';
import { resolveRecoveredSpawnNonceAdmission } from '../spawn/recoveredSpawnNonceAdmission';
import { applyTrackedSessionTurnLifecycle } from '../sessions/applyTrackedSessionTurnLifecycle';
import {
  isSessionRunnerActive as isSessionRunnerActiveInDaemon,
  probeSessionRunnerPresence,
  probeSessionRunnerServiceability,
  resolveSessionRunnerResumeDecision,
} from '../sessions/isSessionRunnerActive';
import {
  createStopSession,
  type StopSessionOptions,
} from '../sessions/stopSession';
import { createRequesterMachineSessionAccessLossCleanup } from '../sessions/requesterMachineAccessLoss';
import {
  registerPidSpawnResourceCleanup,
  retireUpstreamAuthorityBeforeProcessStop,
} from '../sessions/cleanupPidSessionResources';
import {
  isTerminalHostPhysicallyRetiredStopResult,
  type StopSessionResult,
} from '../sessions/stopSessionContract';
import { waitForExistingSessionExitIfStopRequested } from '../sessions/waitForExistingSessionExitIfStopRequested';
import { observePlannedRunnerRetirement, waitForTrackedRunnerProcessesExit } from '../sessions/waitForTrackedRunnerProcessesExit';
import {
  resolveDisconnectedTerminalMode,
  resolveDisconnectedTerminalHostResumeGate,
  superviseDisconnectedTerminalHostCandidate,
  resolveTrackedSessionTerminalHostExitCandidate,
  shouldRetainTrackedTerminalHostExitMarker,
  superviseTrackedOptionalTerminalPresentation,
  type DisconnectedTerminalHostCandidate,
  type DisconnectedTerminalHostSupervisionResult,
} from '../sessions/disconnectedTerminalHostSupervision';
import { resolveTrackedSessionTerminalPresentation } from '../sessions/resolveTrackedSessionTerminalPresentation';
import { createDisconnectedTerminalHostResumeLifecycle } from './disconnectedTerminalHostResumeLifecycle';
import { resolveTrackedSessionCatalogAgentId } from '../sessions/resolveTrackedSessionCatalogAgentId';
import { findTrackedSessionByRunnerPid } from '../sessions/sessionReportCorrelation';
import { resolveTrackedSessionRunnerIdentity } from '../sessions/sessionReportCorrelation';
import { processGenerationMatches, readProcessIdentityByPid } from '../processIdentity';
import {
  clearSessionMarkerConnectedServiceRestartIntent,
  readSessionMarkerForPid,
  removeSessionMarker,
  removeSessionMarkerIfOwned,
  updateSessionMarkerActiveTurn,
} from '../sessionRegistry';
import { promoteForegroundDaemonServiceAuthority } from '../agentRuntime/promoteForegroundDaemonServiceAuthority';
import {
  readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned,
  type AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
} from '../agentRuntime/sessionBridgeAuthorization';
import { refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority } from '../agentRuntime/refreshTrackedRunnerAgentRuntimeDaemonServiceAuthority';

import {
  awaitTrackedRunnerAgentSessionOpen,
  recordTrackedRunnerAgentSessionOpenAttestation,
} from '../agentRuntime/runnerAgentSessionOpenAttestation';
import { authorizeRunnerAgentNewTurn, authorizeRunnerAgentTurnAdmission } from '../agentRuntime/runnerAgentTurnAdmission';
import { attestRetainedAgentForVoice, createRunnerAgentDaemonFacetService } from '../agentRuntime/runnerAgentDaemonFacetService';
import { projectRunnerDaemonPluginServicesFailure, projectRunnerDaemonPluginServicesFailureDiagnostic } from '../agentRuntime/runnerDaemonPluginServicesHost';

import { authorizeTrackedRunnerAgentDaemonServiceOperation } from '../agentRuntime/authorizeTrackedRunnerAgentDaemonServiceOperation';
import { RunnerAgentDaemonFacetOperationV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonFacetProtocol';
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
import { loadRetainedAgentRuntimeLeaf, verifyRunnerAgentBindingAgainstGeneration, type RetainedRunnerAgentServiceBinding } from '@/plugins/runtime/runner/loadRetainedAgentRuntimeLeaf';
import type { AgentSessionRunnerBindingV1 } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';

import { resolvePluginStorePaths } from '@/plugins/store/paths';

import { isPluginRunningSessionDispositionTarget } from '@/plugins/runtime/reload/controller';
import {
  createManagedServiceDurabilityOwner,
  observeManagedServiceProcessStartIdentity,
  type ManagedServiceDurabilityOwner,
} from '@/plugins/runtime/invocation/services/managedServiceDurability';
import type {
  ManagedServiceSessionBaseUrlResolver,
  ManagedServiceSessionClientAccessResolver,
} from '@/plugins/runtime/invocation/services/managedServiceEndpointProjection';
import { executeRunnerManagedServiceEndpointProjectionBridgeOperation } from '@/plugins/runtime/invocation/services/runnerManagedServiceEndpointProjectionBridge';
import { createDaemonManagedServiceEndpointReadOwner } from '@/plugins/runtime/invocation/services/daemonManagedServiceEndpointReadOwner';
import { authorizeRunnerManagedProviderServerSupervision, authorizeRunnerManagedServiceSupervision } from '@/plugins/runtime/invocation/services/runnerManagedServiceSupervisionAuthorization';
import { resolveRunnerManagedServiceDeclaredSecret } from '@/plugins/runtime/invocation/services/runnerManagedServiceDeclaredSecretAuthority';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import { TeamCredentialDirectMaterialOperationError } from '../connectedServices/directMaterial/teamCredentialDirectMaterialClient';

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
import { SPAWN_SESSION_ERROR_CODES, projectSessionRunnerLaunchAdmissionFailure } from '@/session/shared/spawnSessionContract';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { resolveSessionMachineWorkspacePath } from '@/session/machineControlLocality';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { readTerminalHostAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';

import {
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
import {
  prepareForegroundAgentRuntimeAdmission,
  type PrepareForegroundAgentRuntimeAdmissionDependencies,
} from '../agentRuntime/prepareForegroundAdmission';
import { isPidSafeHappySessionProcess } from '../pidSafety';
import {
  computeDaemonSpawnRequestKey,
  createSpawnRequestCoalescer,
} from '../spawn/spawnRequestCoalescer';
import { DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS } from '@happier-dev/protocol/sessions/creation/sessionSpawnBudget';
import { resolveExistingSessionSpawnPreGate } from '../spawn/resolveExistingSessionSpawnPreGate';
import {
  createSessionRunnerRespawnManager,
  isCurrentDefiniteSessionStartupFailure,
  type SessionRunnerRespawnManager,
  type SessionRunnerRespawnTerminalReason,
} from '../processSupervision/sessionRunnerRespawn';
import type { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import type { ConnectedServiceQuotasCoordinator } from '../connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { ConnectedServiceAuthGroupGenerationConsumer } from '../connectedServices/accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer';
import { readConnectedServiceProviderAdoptedAuthGroupGenerationsFromMetadata } from '../connectedServices/accountGroups/generation/pendingGenerationMetadata';
import {
  reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget,
  reconcileConnectedServiceDirectCredentialRevisions,
} from '../connectedServices/accountGroups/generation/reconcileConnectedServiceAuthGroupGenerations';
import {
  fetchConnectedServiceProjectionForSession,
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
import { resolveConnectedAccountRequestAuthCapabilityPath } from '@happier-dev/agents/request-auth';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';


import { createAgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';
import {
  applyConnectedAccountRequestAuthRecovery,
  refreshExpiredConnectedAccountRequestAuthReplacement,
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
import type { QualifiedConnectedAccountEstablishedRuntimeOwner } from '../connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { resolveSharedGenerationApplicationProof } from '../connectedServices/accountGroups/generation/resolveSharedGenerationApplicationProof';
import { mapCommittedGenerationApplyResult } from '../connectedServices/accountGroups/generation/mapCommittedGenerationApplyResult';
import {
  buildConnectedServiceAuthGroupCommittedGenerationFact,
  type ConnectedServiceGenerationExecutionAuthority,
} from '../connectedServices/sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import { buildProviderInputGenerationEpochId } from '@/agent/runtime/session/input/providerInputGenerationAdmission';
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
  SESSION_SWITCH_LIMIT_WINDOW_MS,
  type ConnectedServiceAuthGroupGenerationApplyFailure,
  type ConnectedServiceAuthGroupGenerationApplyResult,
} from '../connectedServices/accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import {
  createProviderAccountUsagePersistenceScheduler,
  flushProviderAccountUsagePersistenceForTrackedSessions,
  ProviderAccountUsageSourceQualificationError,
} from '../connectedServices/accountUsage/persistence';
import {
  recordProviderAccountUsageAdoptionForSession,
  recordProviderAccountUsageSnapshotForSession,
} from '../connectedServices/accountUsage/recordProviderAccountUsageSnapshotForSession';
import type { QualifiedProviderAccountUsagePersistenceTarget } from '../connectedServices/accountUsage/persistence';
import {
  createProviderAccountUsageStore,
  isProviderAccountUsageStoreMutationAccepted,
  type ProviderAccountUsageStore,
} from '../connectedServices/accountUsage/store';
import { ConnectedServiceRuntimeAuthSwitchAttemptTracker } from '../connectedServices/runtimeAuth/ConnectedServiceRuntimeAuthSwitchAttemptTracker';
import { buildConnectedServiceRuntimeAuthSwitchAttemptLogContext } from '../connectedServices/runtimeAuth/buildConnectedServiceRuntimeAuthSwitchAttemptLogContext';
import { commitConnectedServiceAccountSwitchSessionEvent } from '../connectedServices/runtimeAuth/commitConnectedServiceAccountSwitchSessionEvent';
import type { DaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { buildRuntimeAuthRecoveryAttemptTransitionLocalId } from '../connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoveryProjection';
import { createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator } from '../connectedServices/runtimeAuth/createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator';
import type { QualifiedConnectedAccountV4Support } from '../connectedServices/qualifiedConnectedAccountV4Support';
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
  type RuntimeAuthRecoveryScheduler,
  type RuntimeAuthRecoveryDiagnostic,
  type RuntimeAuthRecoveryVisibleEventDelivery,
} from '../connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import { createRuntimeAuthRecoverySchedulerForDaemon } from '../connectedServices/runtimeAuth/createRuntimeAuthRecoverySchedulerForDaemon';
import { ConnectedServiceTemporaryThrottleRetryScheduler } from '../connectedServices/runtimeAuth/temporaryThrottleRetryScheduler';
import { recoverConnectedServiceRuntimeFailure, readConnectedServiceRuntimeAuthFailureSourceBinding } from '../connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailure';
import { connectedServiceRecoveryScopeKey } from '../connectedServices/runtimeRegistry/target';
import {
  resolveInactiveTemporaryThrottleResumeSource,
  type TemporaryThrottleResumeSource,
} from '../connectedServices/runtimeAuth/resolveInactiveTemporaryThrottleResumeSource';
import type {
  ConnectedServiceRuntimeFailureClassification,
} from '../connectedServices/runtimeAuth/types';
import { createConnectedServicePredictiveSwitchGuard } from '../connectedServices/accountGroups/switching/connectedServicePredictiveSwitchGuard';
import type { PredictiveSoftSwitchCapability } from '../connectedServices/accountGroups/switching/predictiveSoftSwitchPolicy';
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
import { restartStaleRunnersAfterDaemonStart } from '../plannedRunnerRestart/restartStaleRunnersAfterDaemonStart';
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
import { resolveSessionRunnerRuntimeState, resolveTrackedSessionRunnerActivity } from '../sessionRunnerRuntime/resolveRuntimeState';
import { shouldRefreshSessionRunnerResumeIdentity } from '../sessionRunnerRuntime/resolveRestartEligibility';
import { resolveSessionRunnerRuntimeStatusV2 } from '../sessionRunnerRuntime/resolveRuntimeStatusV2';
import { resolveAuthoritativeTrackedRunnerAgentRuntimeCurrentness } from '../sessionRunnerRuntime/resolveAgentRuntimeCurrentness';
import { logConnectedServiceDaemonRestartDiagnostic } from './logConnectedServiceDaemonRestartDiagnostic';
import {
  nudgeAlreadyRunningExistingSessionPendingQueue as nudgeSessionPendingQueueWithCredentials,
  probeAlreadyRunningExistingSessionServiceability as probeSessionServiceabilityWithCredentials,
} from './pendingQueueNudge';
import {
  applyTerminalControlServiceabilityProjection,
  resolveRunnerTerminalControlServiceabilityEvidence,
} from './terminalControlServiceabilityProjection';
import { publishReportedTerminalControlServiceability } from './publishReportedTerminalControlServiceability';
import { retireExactTerminalControlServiceability, retireStoppedPlainRunnerControlServiceability, type TerminalControlServiceabilityRetirementTarget } from '../sessions/retireTerminalControlServiceability';
import { executeTerminalHostDisposition } from '@/terminal/attachment/terminalHostDisposition';
import { recoverStrandedTerminalControlServiceability } from '../sessions/recoverStrandedTerminalControlServiceability';


import { materializeSessionConnectedServiceRuntimeAuthSelection } from '../connectedServices/sessionAuthSwitch/materializeSessionConnectedServiceRuntimeAuthSelection';
import { createSessionConnectedServiceAuthHotApply } from '../connectedServices/sessionAuthSwitch/sessionConnectedServiceAuthHotApply';

import {
  createSessionConnectedServiceAccountAdoptionVerifier,
} from '../connectedServices/sessionAuthSwitch/sessionConnectedServiceAccountAdoptionVerification';
import { readConnectedServiceChildSelectionsFromEnv } from '../connectedServices/connectedServiceChildEnvironment';
import { parseConnectedServiceBindingSelections } from '../connectedServices/parseConnectedServicesBindings';
import {
  applyConnectedServiceAuthGenerationToTrackedSession,
  assertConnectedServiceRestartCompleted,
  buildConnectedServiceRestartFailureDiagnostics,
  switchSessionConnectedServiceAuth,
  type SessionConnectedServiceAuthSwitchDiagnostics,
} from '../connectedServices/sessionAuthSwitch/switchSessionConnectedServiceAuth';
import {
  applyConnectedServiceCredentialUpdate,
  readConnectedServiceCredentialApplicationState,
} from '../connectedServices/sessionAuthSwitch/credentialApplicationState';
import { resolveTrackedConnectedServiceSwitchContinuityContext } from '../connectedServices/sessionAuthSwitch/resolveTrackedConnectedServiceSwitchContinuityContext';
import { resolveCommittedGenerationFromRuntimeAuthRecovery } from '../connectedServices/sessionAuthSwitch/resolveCommittedGenerationFromRuntimeAuthRecovery';
import { dispatchConnectedServiceAccountSwitchNotificationAsync } from '../connectedServices/notifications/dispatchConnectedServiceAccountSwitchNotification';
import { resolveDaemonCatalogAgentIdFromBackendTarget } from '../backendTargetRouting';
import type { SshTunnelSupervisor } from '../ssh/tunnels';
import type { ConnectedServiceGroupHomeCleanupScheduler } from '../connectedServices/homes/ConnectedServiceGroupHomeCleanupScheduler';


import { disposeSessionHookArtifactsForSession } from '@/plugins/runtime/hooks/session/service';
import { dispatchPluginHookEvent } from '@/plugins/runtime/hooks/execution/dispatchPluginHookEvent';
import { disposeTerminalAttachmentInfoForSession } from '@/terminal/attachment/terminalAttachmentInfo';
import {
  createConnectedServiceContinuationMessageDispatcher,
} from '../connectedServices/continuation/createConnectedServiceContinuationMessageDispatcher';
import {
  createConnectedServiceProviderActivityProofRecorder,
  isProviderActivityTurnLifecycleEvent,
} from '../connectedServices/recovery/providerActivityProofRecorder';
import { verifyProviderActivityOutcome } from '../connectedServices/recovery/verifyProviderActivityOutcome';
import { resolveTrackedConnectedServiceBindingsRaw } from '../connectedServices/trackedSessionConnectedServiceBindings';

import { removeRuntimeAuthFailureReportOutboxItemsForSession } from '../connectedServices/runtimeAuth/reportOutbox/runtimeAuthFailureReportOutbox';
import { createConnectedServiceRecoverySupersessionCleaner } from '../connectedServices/continuation/continuationRecoverySupersession';
import { createBrowserRoutePublication } from '@/daemon/browser/control/routePublication';
import { createDaemonRunnerInvocationServices } from '@/daemon/agentRuntime/invocationServices';
import { createDaemonExternalActionExecution } from '@/daemon/externalActions/execution';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';
type HostedWebStaticAssetSyncReason =
  | 'startup'
  | 'session_spawned'
  | 'session_webhook'
  | 'session_exit';
type ConnectedServicePreTurnSwitchCoordinator = NonNullable<
  Parameters<
    typeof resolveConnectedServiceAuthForSpawn
  >[0]['authGroupSwitchCoordinator']
>;
type ConnectedServicePreTurnSwitchInput = Parameters<
  ConnectedServicePreTurnSwitchCoordinator['switchBeforeTurn']
>[0];
type ConnectedServicePreTurnSwitchResult = Awaited<
  ReturnType<ConnectedServicePreTurnSwitchCoordinator['switchBeforeTurn']>
>;

function resolvePositiveIntEnv(
  raw: string | undefined,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

function resolveTrackedSessionNotificationTitle(
  tracked: TrackedSession | null | undefined,
): string | null {
  return getSessionNotificationTitle(
    () => tracked?.happySessionMetadataFromLocalWebhook ?? null,
  );
}

function verifyHostedWebStaticAssetArtifact(
  input: Readonly<{
    files: readonly Readonly<{
      relativePath: string;
      bytes: Uint8Array;
    }>[];
    digest: string;
  }>,
): Readonly<{ ok: true }> | Readonly<{ ok: false; reasonCode: string }> {
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

function findTrackedSessionByHappySessionId(
  trackedSessions: Iterable<TrackedSession>,
  sessionIdRaw: string,
): TrackedSession | null {
  const sessionId = normalizeOptionalString(sessionIdRaw);
  if (!sessionId) return null;
  for (const tracked of trackedSessions) {
    if (normalizeOptionalString(tracked.happySessionId) === sessionId)
      return tracked;
  }
  return null;
}

async function resolveOwnedRetainedDevRequestAuthCapabilityPaths(
  input: Readonly<{
    tracked: TrackedSession;
    agentId: CatalogAgentId;
    bindings: ConnectedServiceBindingsV2;
  }>,
): Promise<readonly string[]> {
  const childSelections = readConnectedServiceChildSelectionsFromEnv(
    input.tracked.spawnOptions?.environmentVariables ?? {},
  );
  const paths = new Set<string>();
  for (const [serviceIdRaw, binding] of Object.entries(
    input.bindings.bindingsByServiceId,
  )) {
    if (binding.source !== 'connected') continue;
    const serviceId = serviceIdRaw as ConnectedServiceId;
    const childSelection = childSelections?.get(serviceId) ?? null;
    const selection =
      binding.selection === 'profile'
        ? {
            kind: 'profile' as const,
            serviceId,
            profileId: binding.profileId,
          }
        : childSelection?.kind === 'group' &&
            childSelection.groupId === binding.groupId
          ? childSelection
          : null;
    if (!selection) continue;
    const profileId =
      selection.kind === 'profile'
        ? selection.profileId
        : selection.activeProfileId;
    const materializedRoot = await readCurrentCatalogHook(input.agentId, entry => resolveConnectedServiceMaterializedHomeRoot(
      input.agentId,
      {
        activeServerDir: configuration.activeServerDir,
        serviceId,
        profileId,
        selection,
      },
      entry,
    ));
    if (!materializedRoot) continue;
    paths.add(
      resolveConnectedAccountRequestAuthCapabilityPath(materializedRoot),
    );
  }
  return [...paths];
}

let lastTerminalControlServiceabilityObservation = 0;

function nextTerminalControlServiceabilityObservation(): number {
  lastTerminalControlServiceabilityObservation = Math.max(
    Date.now(),
    lastTerminalControlServiceabilityObservation + 1,
  );
  return lastTerminalControlServiceabilityObservation;
}

async function publishTerminalControlServiceabilityWithCredentials(
  input: Readonly<{
    credentials: Parameters<
      typeof updateSessionMetadataWithRetry
    >[0]['credentials'];
    happyHomeDir: string;
    sessionId: string;
    currentness?: Parameters<
      typeof updateSessionMetadataWithRetry
    >[0]['currentness'];
    serviceability:
      | Awaited<ReturnType<typeof probeSessionServiceabilityWithCredentials>>
      | Readonly<{
          state: 'recoverable_unservable' | 'unknown';
          reason: string;
        }>;
  }>,
): Promise<boolean> {
  const observedAt = nextTerminalControlServiceabilityObservation();
  const attachment = await readTerminalHostAttachmentInfo({
    happyHomeDir: input.happyHomeDir,
    sessionId: input.sessionId,
  });
  if (!attachment || attachment.version === 1) return false;
  const evidence = resolveRunnerTerminalControlServiceabilityEvidence({
    serviceability: input.serviceability,
    attachmentId: attachment.attachmentId,
    observedAt,
  });
  const rawSession = await fetchSessionByIdCompat({ reason: 'session-control',
    token: input.credentials.token,
    sessionId: input.sessionId,
  });
  if (!rawSession) return false;
  const attachmentBeforeUpdate = await readTerminalHostAttachmentInfo({
    happyHomeDir: input.happyHomeDir,
    sessionId: input.sessionId,
  });
  if (
    !attachmentBeforeUpdate ||
    attachmentBeforeUpdate.version === 1 ||
    attachmentBeforeUpdate.attachmentId !== attachment.attachmentId
  )
    return false;
  await updateSessionMetadataWithRetry({
    token: input.credentials.token,
    credentials: input.credentials,
    sessionId: input.sessionId,
    rawSession,
    currentness: input.currentness,
    updater: (metadata) =>
      applyTerminalControlServiceabilityProjection({ metadata, evidence }),
  });
  return true;
}

function stripComposerSourceRefPrivateMetaField(
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const {
    [COMPOSER_SOURCE_REF_PRIVATE_META_FIELD_V1]: _discardedSourceComposerRef,
    ...metaWithoutPrivateSourceRef
  } = meta;
  return metaWithoutPrivateSourceRef;
}

function readComposerSourceRefAndStripPrivateMetaField(
  meta: Record<string, unknown>,
): Readonly<{
  meta: Record<string, unknown>;
  sourceComposerRef?: ComposerRefV1;
}> {
  const rawSourceComposerRef = meta[COMPOSER_SOURCE_REF_PRIVATE_META_FIELD_V1];
  const metaWithoutPrivateSourceRef =
    stripComposerSourceRefPrivateMetaField(meta);
  if (rawSourceComposerRef === undefined) {
    return { meta: metaWithoutPrivateSourceRef };
  }
  const parsed = ComposerRefV1Schema.safeParse(rawSourceComposerRef);
  if (!parsed.success) {
    throw new PluginError({
      code: 'composer_attachment_source_ref_invalid',
      message:
        'Composer attachment finalization received an invalid source Composer reference',
    });
  }
  return {
    meta: metaWithoutPrivateSourceRef,
    sourceComposerRef: parsed.data,
  };
}

async function publishProviderAccountUsageRecordIdToSessionMetadata(
  input: Readonly<{
    token: string;
    credentials: Parameters<
      typeof updateSessionMetadataWithRetry
    >[0]['credentials'];
    sessionId: string;
    recordId: ProviderAccountUsageRecordId | string;
  }>,
): Promise<void> {
  const rawSession = await fetchSessionByIdCompat({ reason: 'session-control',
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
    updater: (metadata) =>
      writeProviderAccountUsageRecordIdToMetadata(metadata, {
        recordId: input.recordId,
        updatedAtMs: Date.now(),
      }),
  });
}

export async function commitConnectedServiceHotApplyRuntimeTarget(
  input: Readonly<{
    tracked: TrackedSession;
    agentId: CatalogAgentId;
    materializationIdentity: ConnectedServiceMaterializationIdentityV1;
    registry: ConnectedServiceRuntimeRegistry;
    acceptedConnectedServicesBindingsRaw: ConnectedServiceBindingsV2;
    acceptedConnectedServiceSelectionsEnv: Readonly<Record<string, string>>;
    afterRegister?: (
      registration: Readonly<{
        previousTarget: ConnectedServiceRuntimeTarget | null;
        registeredTarget: ConnectedServiceRuntimeTarget;
      }>,
    ) => void | Promise<void>;
  }>,
): Promise<void> {
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
      connectedServiceSelectionsEnv:
        input.acceptedConnectedServiceSelectionsEnv,
    });
    const registeredTarget = input.registry.getByPid(input.tracked.pid);
    if (!registeredTarget) {
      throw new Error(
        'Connected-service runtime target registration was unavailable after hot apply',
      );
    }
    await input.afterRegister?.({ previousTarget, registeredTarget });
  } catch (error) {
    input.registry.unregisterPid(input.tracked.pid);
    throw error;
  }
}

export async function startDaemonSessionControlRuntime(
  params: Readonly<{
    agentIsolation?: import('@/daemon/agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext;
    observeSessionScopeExit?: (tracked: TrackedSession) => Promise<void>;
    readMachineResourcesPolicy?: import('@/processes/toolIdleTimeouts').MachineResourcesPolicyReader;
    readSpawnFailureLimits?: import('@/processes/spawnFailure/classifySpawnFailure').SpawnFailureLimitsReader;
    readDoctorResourceVitals?: Parameters<typeof startDaemonControlServer>[0]['readDoctorResourceVitals'];
    checkRegistryUpdates?: () => Promise<void>;
    machineId: string;
    /**
     * Account identity resolved from this daemon's authenticated lifecycle.
     * Without it the public Action route is deliberately not mounted.
     */
    externalActionAccountId?: string | null;
    openAccountConnectionProviderBrokerAccess?: import('@/providers/broker/accountConnectionClient').OpenAccountConnectionProviderBrokerAccess;
    openAccountConnectionManagedConsumerSource?: import('@/agent/runtime/bridges/executionRun/runtime/managedProvider').ExecutionRunManagedProviderSourceOpener;
    projectProviderModelsForAccount?: import('@/providers/modelManagement/runtimeServices').RuntimeProviderModelManagementServices['projectModelsForAccount'];
    /** Profile identity paired with `serverBaseUrl` for this daemon lifecycle. */
    serverId: string;
    /** C52's single composed inventory; requester recovery must include sessionless native work. */
    readLiveWorkInventory?: () => Promise<import('../lifecycle/managedActivity').LiveWorkInventoryV1>;
    /** Existing service-owner group follows Plugin registry replacement without copying state. */
    projectManagedServiceActivity?: import('../lifecycle/managedActivity').LiveWorkProducerV1;
    /** Resolved Account server for this daemon lifecycle's PAT introspection. */
    serverBaseUrl: string;
    runtimeActionExecute?: RuntimeActionExecute;
    managedProviderOperationAuthority?: import('../connectedServices/purposeBindings/managedProviderOperationAuthority').ManagedProviderOperationAuthority;
    readManagedMachinePolicyCurrent?: Parameters<
      typeof createDaemonManagedMachineActionAdapter
    >[0]['readPolicyCurrent'];
    /** Process-lifetime Workflow admission authority reused at every work-releasing control. */
    workflowAcceptedAuthorizationCurrentness?: Parameters<
      typeof createCliActionExecutorFromCredentials
    >[0]['workflowAcceptedAuthorizationCurrentness'];
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
    /** Current registered finite installation, resolved at the same exact-target request boundary. */
    resolveProjectAction?: () => ActionExecutorDeps['projectAction'];
    resolveProjectWorkerAction?: () => ActionExecutorDeps['projectWorkerAction'];
    /** Current source-daemon Sync preparation owner for compound service relocation. */
    resolveWorkspaceSyncHandoffAdapter?: () => import('@/workspaces/sync/workspaceSyncHandoffAdapter').WorkspaceSyncHandoffAdapter | null;
    /** Existing helper lifetime owners expose generation-bound Stop, never raw signal callbacks. */
    readHelperProcessRoots?: () => readonly HappierProcessRootSource[];
    readTerminalRequesterAttribution?: (terminalId: string) => import('@/daemon/lifecycle/requesterWorkAttribution').RequesterWorkAttributionV1 | undefined;
    /** Canonical daemon owner for External Session hook installation mutations. */
    externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
    /** Current exact daemon spawn transport; it may change after machine sync. */
    resolveSessionSpawnDirectTargetTransport?: () =>
      | SessionSpawnDirectTargetTransport
      | undefined;
    externalSessionHostOperationOwner?: ExternalSessionHostOperationOwner;
    runtimeId?: string;
    /** The daemon composition's canonical runtime controller; runner processes never adopt it. */
    pluginRuntimeController?: import('@/plugins/runtime/reload/controller').PluginReloadController;
    readPluginCatalogProjection?: () => import('@/plugins/daemon/catalogProjection').DaemonPluginCatalogProjection;
    credentials: NonNullable<
      Parameters<typeof executeSpawnSessionRequest>[0]['credentials']
    >;
    createRequesterSessionRuntimeContext?: (
      bootstrap: import('../sessionEncryption/requesterSessionCredentials').AdmittedRequesterSessionBootstrap,
    ) => Promise<
      | import('../sessionEncryption/requesterSessionCredentials').RequesterSessionRuntimeContext
      | null
    >;
    /** Captured local Home profile alias for protected exact-Session custody reads. */
    requesterSessionCustodyServerId?: string;
    daemonSessionMutationCustody: Pick<
      DaemonSessionMutationCustody,
      'stageTranscriptEvent' | 'stageTranscriptMessage'
    > &
      Partial<Pick<DaemonSessionMutationCustody, 'stage'>>;
    cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop?: (
      input: Readonly<{
        sessionId: string;
      }>,
    ) => Promise<unknown>;
    deviceLocalSecretStorage?: DeviceLocalSecretStorage;
    api: Parameters<typeof executeSpawnSessionRequest>[0]['api'];
    openTeamCredentialProviderBinding?: (
      input: Readonly<{
        sessionId?: string;
        teamId: string;
        resourceId: string;
        expectedResourceRevision: number;
        deliveryMode: TeamCredentialProviderModelSelectionV1['deliveryMode'];
        agentId: string;
        agentTargetKey: string;
        modelId: string;
        consumer?: import('@happier-dev/protocol').ProviderBrokerConsumerV1;
        providerSettingsOperationContext?: SavedSecretOperationContextV1;
        beginBrokerRequest?: () => import('@/providers/broker/providerBrokerApplicationFailure').SessionBrokerApplicationOutcomeRecorder | undefined;
        signal: AbortSignal;
      }>,
    ) => Promise<
      import('@/providers/broker/sessionTeamCredentialProviderBinding').SessionTeamCredentialProviderBinding
    >;
    connectedServicesMaterializationBaseDir: string;
    getConnectedServiceRefreshCoordinator: () => ConnectedServiceRefreshCoordinator | null;
    getConnectedServiceQuotasCoordinator: () => ConnectedServiceQuotasCoordinator | null;
    resolveQualifiedConnectedAccountV4Support?: () => QualifiedConnectedAccountV4Support;
    resolveQualifiedConnectedAccountRequestAuthTransport?: (
      service: QualifiedConnectedAccountServiceRef,
    ) => QualifiedConnectedAccountPeerOperationTransport;
    establishedConnectedAccountRuntimeOwner?: Pick<
      QualifiedConnectedAccountEstablishedRuntimeOwner,
      'invokeWithReceipt' | 'readMaterialSnapshot' | 'recordScopeChallenge'
    >;
    connectedAccountRequestAuthRegistry?: ConnectedAccountRequestAuthSubjectRegistry;
    onConnectedAccountRequestAuthHttpPortReady?: (port: number) => void;
    connectedServiceRuntimeRegistry?: ConnectedServiceRuntimeRegistry;
    ownedConnectedServiceRuntimeRegistry?: ConnectedServiceRuntimeRegistry;
    pidToTrackedSession: Map<number, TrackedSession>;
    skillStore?: SkillStore;
    skillUsageRecorder?: SkillUsageRecorder;
    endedProcessRoots?: () => readonly HappierProcessRootSource[];
    retainEndedProcessRoots?: (roots: readonly HappierProcessRoot[]) => void;
    pidToAwaiter: Map<number, (session: TrackedSession) => void>;
    pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
    pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
    persistedTakeoverAdmissionWaiter?: Parameters<
      typeof executeSpawnSessionRequest
    >[0]['persistedTakeoverAdmissionWaiter'];
    getApiMachineForSessions: () => ApiMachineClient | null;
    onMachineAccessLossReceiverReady?: (
      options: Parameters<ApiMachineClient['registerMachineAccessLossReceiver']>[0],
    ) => void;
    onComputerRoutesReady?: (resolveComputer: () => ComputerRoutes | null) => void;
    onLocalServicesPreviewRoutesReady?: (
      routes: LocalServicePreviewRoutes,
    ) => void;
    onLocalServicesRoutesReady?: (
      routes: DaemonLocalServicesMachineRpcRoutes & Readonly<{
        localServicesInventory: LocalServicesDaemonRuntime['inventoryRoutes'];
      }>,
    ) => void;
    onLocalServicesSummaryReady?: (
      source: Pick<
        LocalServicesDaemonRuntime,
        'getSummary' | 'subscribeSummary' | 'refreshInventoryNow'
      > &
        Readonly<{
          isProjectServiceExecutionLive(): boolean;
        }>,
    ) => void;
    onManagedServiceEndpointReadHostReady?: (
      host: ReturnType<
        typeof createDaemonManagedServiceEndpointReadOwner
      >['bindHost'],
    ) => void;
    onManagedServiceSessionBaseUrlResolverReady?: (
      resolver: ManagedServiceSessionBaseUrlResolver,
    ) => void;
    onManagedServiceSessionClientAccessResolverReady?: (
      resolver: ManagedServiceSessionClientAccessResolver,
    ) => void;
    onBrowserDiagnosticsRoutesReady?: (
      routes: BrowserDiagnosticsRoutes,
    ) => void;
    onBrowserRecordingRoutesReady?: (routes: BrowserRecordingRoutes) => void;
    onBrowserRecordingRuntimeReady?: (runtime: BrowserRecordingDaemonRuntime | null) => void;
    onBrowserControlRoutesReady?: (routes: BrowserDaemonControlRoutes) => void;
    onBrowserContextRoutesReady?: (routes: BrowserContextRoutes) => void;
    onBrowserAutomationRoutesReady?: (routes: BrowserAutomationRoutes) => void;
    onSimulatorPreviewRoutesReady?: (routes: SimulatorPreviewRoutes) => void;
    onConnectedServicePoolSelectionReadReady?: (read: ConnectedServicePoolSelectionRead) => void;
    spawnResourceCleanupByPid: Map<number, () => void | Promise<void>>;
    sessionAttachCleanupByPid: Map<number, () => Promise<void>>;
    connectedServicesRestartRequestedPids: Set<number>;
    loadTerminalHostAdapters?: () => Promise<
      Readonly<
        Partial<Record<TerminalHostAdapter['kind'], TerminalHostAdapter>>
      >
    >;
    startupTerminalRecovery?: Readonly<{
      disconnectedTerminalHostCandidates: ReadonlyArray<DisconnectedTerminalHostCandidate>;
      unresolvedTerminalHostSessionIds: ReadonlyArray<string>;
    }>;
    onAlreadyRunningSessionAdopted?: (sessionId: string) => Promise<void>;
    connectedServiceGroupHomeCleanupScheduler?: Pick<
      ConnectedServiceGroupHomeCleanupScheduler,
      'cleanupPendingDeletedGroupHomes'
    >;
    connectedServiceMaterializedHomeCleanupScheduler?: Readonly<{
      cleanupPendingMaterializedHomes: () => Promise<unknown>;
    }>;
    beforeShutdown: Parameters<
      typeof startDaemonControlServer
    >[0]['beforeShutdown'];
    admissionDrain?: DaemonAdmissionDrain;
    onHappySessionWebhook: (
      sessionId: string,
      sessionMetadata: Metadata,
      reconcileCanonicalReadiness?: (tracked: TrackedSession) => Promise<void>,
      sessionCreationOutcome?: SessionCreationOutcome,
    ) => Promise<void>;
    setOnTrackedSessionPidPromoted?: (
      handler: (
        input: Readonly<{
          fromPid: number;
          toPid: number;
          trackedSession: TrackedSession;
        }>,
      ) => void,
    ) => void;
    admitPersistedTakeover?: Parameters<
      typeof startDaemonControlServer
    >[0]['admitPersistedTakeover'];
    sshTunnelSupervisor?: Pick<
      SshTunnelSupervisor,
      | 'ensureTunnel'
      | 'listTunnels'
      | 'probeTunnel'
      | 'releaseTunnel'
      | 'stopTunnel'
    >;
    requestShutdown: (source: ShutdownSource, errorMessage?: string) => void;
    requestSelfRestart?: Parameters<
      typeof startDaemonControlServer
    >[0]['requestSelfRestart'];
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
    resolveCurrentSessionPurposeBindingSnapshot?: ConnectedAccountPurposeBindingOwner['resolveCurrentSessionPurposeBindingSnapshot'];
    /** Home-backed Team slot bindings for a foreground Session's durable Team purpose targets. */
    resolveSessionTeamCredentialBindingIntents?: NonNullable<
      PrepareForegroundAgentRuntimeAdmissionDependencies['resolveSessionTeamCredentialBindingIntents']
    >;
    resolveCurrentRequestAuthBinding?: ConnectedAccountPurposeBindingOwner['resolveCurrentRequestAuthBinding'];
    materializeRequestAuthBearer?: ConnectedAccountPurposeBindingOwner['materializeRequestAuthBearer'];
    activatePurposeBindings?: ConnectedAccountPurposeBindingOwner['activatePurposeBindings'];
    resolveHostedWebStaticAssetContributionRegistry?: () => Promise<ResolvedContributionRegistry>;
    liveStreamCaptureRegistry?: MachineLiveStreamCaptureRegistry;
    simulatorInputLeaseManager?: SimulatorInputLeaseManager;
    browserSidecarControlAdapterFactory?: BrowserSidecarControlAdapterFactory;
    readMachineMemory?: BrowserSidecarControlAdapterFactoryInput['readMachineMemory'];
    resolveServerFeaturesSnapshot?: () =>
      | Promise<CliServerFeaturesSnapshot | undefined>
      | CliServerFeaturesSnapshot
      | undefined;
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
    onBrowserStoragePurgeOwnerReady?: (
      owner: DaemonBrowserStoragePurgeOwner,
    ) => void;
    // True once daemon shutdown has begun. Threaded into the control server + recovery schedulers
    // so recovery handlers/timers do not run switch/restart work into a tearing-down daemon.
    isShuttingDown?: () => boolean;
    reattachedAgentRequestAuthPidSafetyDependencies?: NonNullable<
      Parameters<typeof isPidSafeHappySessionProcess>[1]
    >;
    processEnv: NodeJS.ProcessEnv;
  }> & RequesterSessionRuntimeContextPorts,
): Promise<
  Readonly<{
    executeGuardLeftBehindAction: ReturnType<typeof createGuardLeftBehindActionExecutor>;
    resolveExecutionRunLiveBrokerAuthority: NonNullable<MachineRpcHandlerDeps['resolveExecutionRunLiveBrokerAuthority']>;
    guardSources: Required<Pick<import('../guard/readGuardFacts').ReadGuardFactsDependencies, 'readBrowsers' | 'readServices' | 'readServiceTargets'>>;
    sessionLiveWorkProducer: ReturnType<typeof createSessionLiveWorkProducer>;
    dispatchSessionFollowOccurrence: (request: import('@/agent/runtime/session/follow/sessionFollowOccurrenceDispatcher').SessionFollowOccurrenceDispatch) => Promise<import('@/agent/runtime/session/follow/sessionFollowOccurrenceDispatcher').SessionFollowReceiverRangeResult | SessionActivityChangedResult | void>;
    processOwnershipRuntime: ReturnType<typeof createProcessOwnershipRuntime>;
    processLeftBehindPass: ReturnType<typeof createLeftBehindPass>;
    ownerRemainder: ReturnType<typeof createEndOwnerRemainder>;
    processActionLifecycle: SessionProcessActionLifecycle;
    processActionOwnerAdapters: ReturnType<typeof createProcessActionOwnerAdapters>;
    readManagedServiceCurrentLogPaths: () => Promise<readonly string[]>;
    retryOrphanedManagedServices: () => Promise<void>;
    managedMachinePolicyAdapter: ReturnType<
      typeof createDaemonManagedMachineActionAdapter
    >;
    externalActionIngressOwner?: ExternalActionIngressOwner;
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    spawnSessionForInternalResume: PendingSessionResumePort;
    stopSession: (sessionId: string, options?: StopSessionOptions) => Promise<StopSessionResult>;
    stopRequesterSessionForHandoff: (sessionId: string, expectedSpawnNonce: string) => Promise<'stopped' | 'already_inactive' | 'failed'>;
    isSessionAlreadyRunning: (sessionId: string) => Promise<boolean>;
    restartStaleSessionRunnersAfterDaemonStart: () => ReturnType<typeof restartStaleRunnersAfterDaemonStart>;
    hasPendingRunnerRestarts: () => boolean;
    sessionRunnerStatus: Readonly<{
      get: (
        request: SessionRunnerStatusGetRequestV1,
      ) => Promise<SessionRunnerRuntimeStateV1>;
      getV2: (
        request: SessionRunnerStatusGetRequestV1,
      ) => Promise<SessionRunnerRuntimeStatusV2>;
    }>;
    onChildExited: (
      pid: number,
      exit: { reason: string; code: number | null; signal: string | null },
    ) => Promise<void>;
    onTrackedSessionHealthy: (tracked: TrackedSession) => Promise<void>;
    controlPort: number;
    controlToken: string;
    stopControlServer: () => Promise<void>;
    connectedServiceAuthGroupPreTurnSwitchCoordinator: Readonly<{
      credentialHealthSwitchLeases: InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry<QualifiedConnectedAccountServiceRef>;
      credentialHealthQuotaFreshnessMs: number;
      switchBeforeTurn: (
        input: ConnectedServicePreTurnSwitchInput,
      ) => Promise<ConnectedServicePreTurnSwitchResult>;
      applyCommittedGeneration: (
        input: Readonly<{
          sessionId: string;
          serviceId: ConnectedAccountServiceKey;
          groupId: string;
          activeProfileId: string;
          generation: number;
          credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
          reason: string;
          allowRestart?: boolean;
        }>,
      ) => Promise<
        Readonly<{
          status: string;
          activeProfileId?: string | null;
          generation: number;
          errorCode?: string;
        }>
      >;
      applyCredentialUpdate: (
        input: Readonly<{
          signal?: AbortSignal;
          sessionId: string;
          serviceId: Parameters<typeof readConnectedServiceCredentialApplicationState>[0]['serviceId'];
          profileId: string;
          reason: 'account_changed' | 'auth_expired';
          executionAuthority: ConnectedServiceExecutionAuthorityV1;
        }>,
      ) => Promise<
        Readonly<{
          status: 'hot_applied' | 'restart_requested' | 'unchanged' | 'failed';
          errorCode?: string;
        }>
      >;
    }>;
    connectedServicePredictiveSwitchGuard: ReturnType<
      typeof createConnectedServicePredictiveSwitchGuard
    >;
    consumeCommittedAuthGroupGeneration: (
      input: Parameters<
        ConnectedServiceAuthGroupGenerationConsumer['consume']
      >[0],
    ) => ReturnType<ConnectedServiceAuthGroupGenerationConsumer['consume']>;
    requestConnectedServiceRefreshRestartSignal: (
      signalParams: Readonly<{
        pid: number;
        delayMs: number;
        preferProcessGroup?: boolean;
        shouldSignal?: () => boolean;
        onSignalFailure: (error: unknown) => void;
        restartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticInput;
        recordRestartDiagnostic?: (
          record: ConnectedServiceDaemonRestartDiagnosticRecord,
        ) => void;
        nowMs?: () => number;
      }>,
    ) => Promise<Readonly<{ signaled: boolean }>>;
    cancelConnectedServiceRuntimeAuthRecovery: (
      input: Readonly<{
        sessionId: string;
        attemptId: string;
      }>,
    ) => Promise<unknown>;
    checkRuntimeAuthUsageLimitRecovery: (
      input: Readonly<{ sessionId: string; attemptId: string; resumePromptMode?: SessionContinuationResumePromptModeV1 }>,
    ) => Promise<unknown>;
    retryTemporaryThrottleNow: (
      input: Readonly<{ sessionId: string }>,
    ) => Promise<unknown>;
    readTemporaryThrottleRecovery: (
      sessionId: string,
    ) => ReturnType<ConnectedServiceTemporaryThrottleRetryScheduler['read']>;
    cancelTemporaryThrottleRecovery: (
      input: Parameters<
        ConnectedServiceTemporaryThrottleRetryScheduler['cancel']
      >[0],
    ) => ReturnType<ConnectedServiceTemporaryThrottleRetryScheduler['cancel']>;
    reconcileReattachedConnectedServiceCredentialProjection: () => Promise<void>;
    reconcileConnectedServicesProjection: (
      notification: ConnectedServicesProjectionNotification,
    ) => Promise<void>;
    awaitAgentSessionOpen: (
      input: Omit<
        Parameters<typeof awaitTrackedRunnerAgentSessionOpen>[0],
        'getTrackedSessions' | 'readStartupFailure'
      >,
    ) => ReturnType<typeof awaitTrackedRunnerAgentSessionOpen>;
    installExternalSessionHostOperations(
      operations: ExternalSessionHostOperationSet,
    ): ReturnType<
      ReturnType<typeof createExternalSessionHostOperationOwner>['install']
    >;
    readMaterializedStateObservationBinding(
      sessionId: string,
    ): ReturnType<typeof readTrackedSessionMaterializedStateObservationBinding>;
    providerAccountUsageStore: Pick<
      ProviderAccountUsageStore,
      'recordSnapshot' | 'resolveRecordId' | 'resolveBySource' | 'retainSourcesForProfile'
    >;
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
  }>
> {
  let notifySessionLiveWorkChanged: () => void = () => {};
  const pluginRuntimeController = params.pluginRuntimeController ?? pluginReloadController;
  // Every live acquisition in this daemon uses its same admitted controller;
  // retained Run snapshots keep their already captured lease below.
  const acquireDaemonPluginRuntimeRegistryLease = () => acquireAuthoritativePluginRuntimeRegistryLease({
    happyHomeDir: configuration.happyHomeDir, controller: pluginRuntimeController,
  });
  let controlRuntimeResourcesDisposed = false;
  const isRuntimePublicationQuiescing =
    params.admissionDrain?.isPublicationQuiescing ??
    params.isShuttingDown ??
    (() => false);
  const requesterRuntimeAccess = params.resolveRequesterSessionRuntimeContext
    ? { resolve: params.resolveRequesterSessionRuntimeContext, release: params.releaseRequesterSessionRuntimeContext }
    : null;
  const releaseSessionAccountContext = async (context: RequesterSessionRuntimeContext | null): Promise<void> => {
    if (context && requesterRuntimeAccess) await requesterRuntimeAccess.release(context);
  };
  // Selecting a requester and validating an optional port's returned context
  // are one read-only resolution phase. Callers' later effects stay outside.
  const resolveSessionAccountContext = async (
    sessionId: string | null,
    retainedAttribution?: TrackedSession['requesterWorkAttributionV1'],
    signal?: AbortSignal,
  ): Promise<RequesterSessionRuntimeContext | null> => runWithRequesterSessionCurrentnessCheckpoint(async () => {
    if (sessionId === null) return null;
    const tracked = findTrackedSessionByHappySessionId(
      params.pidToTrackedSession.values(),
      sessionId,
    );
    const attribution =
      retainedAttribution ??
      tracked?.requesterWorkAttributionV1 ??
      tracked?.spawnOptions?.requesterWorkAttributionV1;
    const context =
      (await requesterRuntimeAccess?.resolve(
        sessionId,
        attribution,
        signal,
      )) ?? null;
    if (context) {
      try {
        if (
          (attribution &&
            !isDeepStrictEqual(context.bootstrap.attribution, attribution)) ||
          !(await context.isCurrent(signal))
        ) throw new Error('requester_session_not_current');
        return context;
      } catch (error) {
        await releaseSessionAccountContext(context);
        throw error;
      }
    }
    if (
      attribution &&
      (attribution.accountId !== params.externalActionAccountId ||
        attribution.serverId !== params.serverId ||
        attribution.machineId !== params.machineId)
    ) {
      throw new Error('requester_session_not_current');
    }
    return null;
  }, { readOnly: true });
  const withSessionAccountContext = async <T>(
    sessionId: string | null,
    operation: (context: RequesterSessionRuntimeContext | null) => Promise<T>,
    retainedAttribution?: TrackedSession['requesterWorkAttributionV1'],
    signal?: AbortSignal,
  ): Promise<T> => {
    const context = await resolveSessionAccountContext(sessionId, retainedAttribution, signal);
    try {
      return await operation(context);
    } finally {
      await releaseSessionAccountContext(context);
    }
  };
  const assertSessionAccountCurrent = async (
    sessionId: string | null,
    expected: RequesterSessionRuntimeContext | null,
    retainedAttribution?: TrackedSession['requesterWorkAttributionV1'],
    signal?: AbortSignal,
  ): Promise<void> => {
    if (sessionId === null) {
      if (expected || controlRuntimeResourcesDisposed || isRuntimePublicationQuiescing()) {
        throw new Error('requester_session_not_current');
      }
      return;
    }
    await assertRequesterSessionAccountContextCurrent({
      expected,
      signal,
      resolveCurrent: () => resolveSessionAccountContext(sessionId, retainedAttribution, signal),
      readTrackedContext: () =>
        findTrackedSessionByHappySessionId(
          params.pidToTrackedSession.values(),
          sessionId,
        )?.requesterSessionRuntimeContext ?? null,
    });
  };
  const withSessionAccountHome = <T>(
    context: RequesterSessionRuntimeContext | null,
    operation: () => Promise<T>,
  ): Promise<T> =>
    context
      ? runWithServerHttpBaseUrl(context.bootstrap.serverHttpBaseUrl, operation)
      : operation();
  // Attached Run authority belongs to the same tracked Session/requester as
  // other Session control reads, never to the worker custodian's credentials.
  const resolveExecutionRunLiveBrokerAuthority: NonNullable<MachineRpcHandlerDeps['resolveExecutionRunLiveBrokerAuthority']> = async input => {
    const unavailable = { status: 'not_current', reason: 'runtime_unavailable' } as const;
    const tracked = findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), input.sessionId);
    if (!tracked) return unavailable;
    const signal = shutdownCancellationDomains.daemonWorkSignal;
    return await withSessionAccountContext(input.sessionId, async requester => {
      const custodianAccountId = params.externalActionAccountId ?? readPreviewAccountIdFromToken(params.credentials.token);
      const accountId = requester?.bootstrap.attribution.accountId ?? custodianAccountId;
      if (accountId !== input.requestingAccountId) return { status: 'not_current', reason: 'identity_mismatch' } as const;
      return await withTrackedSessionRpc({
        tracked, credentials: params.credentials, custodianAccountId,
        serverId: params.serverId, machineId: params.machineId, serverHttpBaseUrl: params.serverBaseUrl,
        ...(requester ? { requesterBootstrap: requester.bootstrap } : {}), signal,
        isTrackedCurrent: () => !controlRuntimeResourcesDisposed && !isRuntimePublicationQuiescing()
          && params.pidToTrackedSession.get(tracked.pid) === tracked && tracked.reportMarkerCustody?.retiring !== true
          && (!requester || tracked.requesterSessionRuntimeContext === requester),
      }, async callRpc => SessionExecutionRunBrokerAuthorityResponseV1Schema.parse(await callRpc(
        `${input.sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1}`,
        { v: 1, executionRunId: input.executionRunId,
          ...(input.expectedIntent !== undefined ? { expectedIntent: input.expectedIntent } : {}),
          expectedOccurrenceId: input.expectedOccurrenceId,
          ...(input.expectedDirectMaterialUse ? { expectedDirectMaterialUse: input.expectedDirectMaterialUse } : {}),
        },
      ))) ?? unavailable;
    }, undefined, signal);
  };
  const releaseInactiveSessionControlLaunchScope = bindInactiveSessionControlLaunchScope(async input => {
    const sessionId = input.adapterParams.sessionId;
    const context = await resolveSessionAccountContext(sessionId, undefined, input.signal);
    const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
    const readSnapshot = () => context ? context.readAccountSettingsSnapshot() : getActiveAccountSettingsSnapshot();
    const assertCurrent = async () => {
      input.signal.throwIfAborted();
      await assertSessionAccountCurrent(sessionId, context, undefined, input.signal);
      const accountId = context?.bootstrap.attribution.accountId ?? params.externalActionAccountId
        ?? readPreviewAccountIdFromToken(params.credentials.token);
      if (!input.adapterParams.credentials || !accountId
        || readPreviewAccountIdFromToken(input.adapterParams.credentials.token) !== accountId) {
        throw new Error('inactive_agent_launch_scope_unavailable');
      }
      if (!context && (lifetime !== getActiveAccountSettingsSnapshotLifetimeToken()
        || readSnapshot()?.scopeKey !== resolveForegroundAccountSettingsScopeKey(params.credentials))) {
        throw new Error('inactive_agent_launch_scope_unavailable');
      }
    };
    try {
      const scope = await withSessionAccountHome(context, () => prepareInactiveSessionControlLaunchScope(input, {
        readAgentIsolationEnabled: () => params.agentIsolation?.read()?.enabled === true,
        credentials: context?.bootstrap.credentials ?? params.credentials,
        api: context?.api ?? params.api,
        processEnv: params.processEnv ?? process.env,
        activeServerDir: context?.activeServerDir ?? configuration.activeServerDir,
        providerRuntimeHomeDir: context?.activeServerDir,
        connectedServicesMaterializationBaseDir: context?.connectedServicesMaterializationBaseDir ?? params.connectedServicesMaterializationBaseDir,
        readAccountSettingsSnapshot: readSnapshot,
        ...(context ? { requesterSessionBootstrap: context.bootstrap,
          savedSecretOperationContext: context.bootstrap.savedSecretOperationContext,
          readAccountLaunchProfiles: () => context.readAccountLaunchProfiles() } : {}),
        connectedAccountsOwner: context?.connectedAccountsOwner,
        qualifiedConnectedAccountApi: context?.qualifiedConnectedAccountApi ?? qualifiedConnectedAccountApi,
        activatePurposeBindings: context?.activatePurposeBindings ?? params.activatePurposeBindings,
        activateSessionPurposeBindings: context?.activateSessionPurposeBindings ?? params.activateSessionPurposeBindings,
        connectedServiceRefreshCoordinator: context ? context.connectedServiceRefreshCoordinator : params.getConnectedServiceRefreshCoordinator(),
        providerAccountUsageStore: context?.providerAccountUsageStore ?? providerAccountUsageStore,
        authGroupSwitchCoordinator: context ? context.authGroupSwitchCoordinator : connectedServiceAuthGroupPreTurnSwitchCoordinator,
        predictiveSwitchGuard: context ? context.predictiveSwitchGuard : connectedServicePredictiveSwitchGuard,
        resolveManagedPurposeBindingIntent: context?.resolveManagedPurposeBindingIntent ?? params.resolveManagedPurposeBindingIntent,
        connectedAccountRequestAuthRegistry,
        connectedAccountRequestAuthHttpPort: connectedAccountRequestAuthHttpPort ?? undefined,
        resolveProvidersFeatureEnabled: async () => resolveCliFeatureDecision({ featureId: 'providers',
          env: params.processEnv, serverSnapshot: await fetchServerFeaturesSnapshot({ serverUrl: resolveServerHttpBaseUrl() }) }).state === 'enabled',
        readModelProjection: createAccountScopedProviderModelProjectionReader({
          serverUrl: context?.bootstrap.serverHttpBaseUrl ?? params.serverBaseUrl,
          readCredentials: async () => context?.bootstrap.credentials ?? params.credentials,
          readAccountSettingsSnapshot: async () => readSnapshot(),
          isCurrent: async () => { await assertCurrent(); return true; },
        }),
        assertCurrent,
      }));
      return { ...scope, async dispose() {
        try { await scope.dispose(); } finally { await releaseSessionAccountContext(context); }
      } };
    } catch (error) {
      await releaseSessionAccountContext(context);
      throw error;
    }
  });
  const probeAlreadyRunningExistingSessionServiceability = async (
    input: Parameters<typeof probeSessionServiceabilityWithCredentials>[0],
  ): ReturnType<typeof probeSessionServiceabilityWithCredentials> => {
    try {
      return await withSessionAccountContext(input.sessionId, async (context) =>
        await withSessionAccountHome(context, () =>
          probeSessionServiceabilityWithCredentials({
            ...input,
            credentials: context?.bootstrap.credentials ?? input.credentials,
            ...(context ? { requesterSessionBootstrap: context.bootstrap } : {}),
          }),
        ),
      );
    } catch {
      return { state: 'unknown', reason: 'transport_unavailable' };
    }
  };
  const publishCurrentTerminalControlServiceability = async (
    input: Parameters<
      typeof publishTerminalControlServiceabilityWithCredentials
    >[0],
  ): Promise<boolean> => {
    return await withSessionAccountContext(input.sessionId, async (context) => {
      await assertSessionAccountCurrent(input.sessionId, context);
      return await withSessionAccountHome(context, () =>
        publishTerminalControlServiceabilityWithCredentials({
          ...input,
          credentials: context?.bootstrap.credentials ?? input.credentials,
          ...(context
            ? {
                currentness: {
                  verifyCurrent: () => context.isCurrent(),
                },
              }
            : {}),
        }),
      );
    });
  };
  const nudgeAlreadyRunningExistingSessionPendingQueue = async (
    input: Parameters<typeof nudgeSessionPendingQueueWithCredentials>[0],
  ): ReturnType<typeof nudgeSessionPendingQueueWithCredentials> => {
    try {
      return await withSessionAccountContext(input.sessionId, async (context) =>
        await withSessionAccountHome(context, () =>
          nudgeSessionPendingQueueWithCredentials({
            ...input,
            credentials: context?.bootstrap.credentials ?? input.credentials,
            ...(context ? { requesterSessionBootstrap: context.bootstrap } : {}),
          }),
        ),
      );
    } catch {
      return { type: 'unavailable', reason: 'transport_unavailable' };
    }
  };
  let computerRoutes: ComputerRoutes | null = null;
  await refreshTerminalPresentUserPolicy({
    token: params.credentials.token,
    serverHttpBaseUrl: params.serverBaseUrl,
  });
  const connectedServiceRuntimeRegistry =
    params.connectedServiceRuntimeRegistry ??
    new ConnectedServiceRuntimeRegistry();
  const ownedConnectedServiceRuntimeRegistry =
    params.ownedConnectedServiceRuntimeRegistry ??
    connectedServiceRuntimeRegistry;
  let advanceProviderInputAdmissionsAfterHotApplyRegistration: (
    input: Readonly<{
      previousTarget: ConnectedServiceRuntimeTarget | null;
      registeredTarget: ConnectedServiceRuntimeTarget;
    }>,
  ) => void = () => {};
  const resolveHotApplyRuntimeTargetContext = (tracked: TrackedSession) => {
    const agentId = resolveTrackedSessionCatalogAgentId(tracked);
    const materializationIdentity =
      resolveConnectedServiceMaterializationIdentityFromTrackedSession(tracked);
    return agentId && materializationIdentity
      ? { agentId, materializationIdentity }
      : null;
  };
  const registerHotApplyRuntimeTarget = async (
    input: Readonly<{
      tracked: TrackedSession;
      runtimeAuthSelectionsByServiceId: ReadonlyMap<
        ConnectedServiceId,
        unknown
      >;
      acceptedConnectedServicesBindingsRaw: ConnectedServiceBindingsV2;
      acceptedConnectedServiceSelectionsEnv: Readonly<Record<string, string>>;
    }>,
  ): Promise<void> => {
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
          connectedServicesBindingsRaw:
            input.acceptedConnectedServicesBindingsRaw,
          materializationKey: context.materializationIdentity.id,
          connectedServiceSelectionsEnv:
            input.acceptedConnectedServiceSelectionsEnv,
        });
        params.getConnectedServiceQuotasCoordinator()?.registerSpawnTarget({
          pid: input.tracked.pid,
          agentId: context.agentId,
          sessionId: input.tracked.happySessionId,
          connectedServicesBindingsRaw:
            input.acceptedConnectedServicesBindingsRaw,
          connectedServiceSelectionsEnv:
            input.acceptedConnectedServiceSelectionsEnv,
        });
      },
    });
  };
  // Reattached children are restored as ongoing runtime targets only when their materialized
  // credential is revision-fenced. Server-observed credential revisions are the canonical
  // authority for that fact, so bootstrap must never resolve credential material to learn it:
  // the materialization owner is not ready yet, and a stale-but-fenced revision is precisely the
  // case reattach reconciliation exists to repair.
  const resolveBootstrapConnectedServiceRuntimeCandidate = (
    tracked: TrackedSession,
  ) => {
    const agentId = resolveTrackedSessionCatalogAgentId(tracked);
    const materializationIdentity =
      resolveConnectedServiceMaterializationIdentityFromTrackedSession(tracked);
    if (!agentId || !materializationIdentity) return null;
    const environment = tracked.spawnOptions?.environmentVariables ?? {};
    const configuredSelections = parseConnectedServiceBindingSelections(
      resolveTrackedConnectedServiceBindingsRaw(tracked),
    );
    const materializedSelections =
      readConnectedServiceChildSelectionsFromEnv(environment);
    const credentialBindings = configuredSelections.flatMap((selection) => {
      const materialized = materializedSelections?.get(selection.serviceId);
      if (!materialized) {
        return [];
      }
      if (selection.kind === 'profile') {
        return materialized.kind === 'profile' &&
          materialized.profileId === selection.profileId
          ? [
              {
                serviceId: selection.serviceId,
                profileId: materialized.profileId,
              },
            ]
          : [];
      }
      // A Team-resource selection carries no local credential binding.
      if (selection.kind !== 'group') return [];
      return materialized.kind === 'group' &&
        materialized.groupId === selection.groupId
        ? [
            {
              serviceId: selection.serviceId,
              profileId: materialized.activeProfileId,
            },
          ]
        : [];
    });
    if (
      configuredSelections.length === 0 ||
      credentialBindings.length !== configuredSelections.length
    )
      return null;
    return {
      tracked,
      agentId,
      materializationIdentity,
      environment,
      credentialBindings,
    };
  };
  const registerTrackedConnectedServiceRuntimeTargets =
    async (): Promise<void> => {
      const candidates = Array.from(
        params.pidToTrackedSession.values(),
      ).flatMap(
        (tracked) =>
          resolveBootstrapConnectedServiceRuntimeCandidate(tracked) ?? [],
      );
      if (candidates.length === 0) return;
      let ownedProjection:
        | ConnectedServiceProjectionSnapshot
        | null
        | undefined;
      for (const candidate of candidates) {
        const sessionId = normalizeOptionalString(
          candidate.tracked.happySessionId,
        );
        if (!sessionId) continue;
        let contextResolved = false;
        try {
          await withSessionAccountContext(sessionId, async (accountContext) => {
            contextResolved = true;
            const projection = accountContext
              ? await fetchConnectedServiceProjectionSnapshot(
                  undefined,
                  sessionId,
                ).catch(() => null)
              : ownedProjection === undefined
                ? (ownedProjection =
                    await fetchConnectedServiceProjectionSnapshot().catch(
                      () => null,
                    ))
                : ownedProjection;
            if (!projection) return;
            try {
              await assertSessionAccountCurrent(sessionId, accountContext);
            } catch {
              return;
            }
            const revisionFenced = candidate.credentialBindings.every(
              (binding) =>
                projection.resolveCredentialPresence(
                  binding.serviceId,
                  binding.profileId,
                ).status === 'present',
            );
            if (!revisionFenced) return;
            connectedServiceRuntimeRegistry.registerTarget(
              {
                pid: candidate.tracked.pid,
                agentId: candidate.agentId,
                sessionId: candidate.tracked.happySessionId,
                sessionDirectory: candidate.tracked.spawnOptions?.directory,
                materializationKey: candidate.materializationIdentity.id,
                connectedServiceMaterializationIdentityV1:
                  candidate.materializationIdentity,
                connectedServicesBindingsRaw:
                  candidate.tracked.spawnOptions?.connectedServices,
                connectedServiceSelectionsEnv: candidate.environment,
              },
              { source: 'bootstrap' },
            );
          });
        } catch (error) {
          if (contextResolved) throw error;
        }
      }
    };
  const spawnConcurrencyGate = createSpawnConcurrencyGate(
    resolvePositiveIntEnv(
      params.processEnv.HAPPIER_DAEMON_MAX_CONCURRENT_SPAWNS,
      0,
      { min: 0, max: 64 },
    ),
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
  const isSessionRunnerActive = async (
    sessionIdRaw: string,
  ): Promise<boolean> =>
    await isSessionRunnerActiveInDaemon({
      sessionId: sessionIdRaw,
      trackedSessions: params.pidToTrackedSession.values(),
    });
  let latestConnectedServiceProjectionSnapshot: ConnectedServiceProjectionSnapshot | null =
    null;
  let unsubscribeConnectedServiceRuntimeTargetRegistrations = () => {};
  let unsubscribeRunnerAgentAuthorityCurrentness = () => {};
  const connectedServiceRuntimeQuotaSnapshots =
    new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
  const providerAccountUsageStore = createProviderAccountUsageStore();
  const providerAccountUsagePersistence =
    createProviderAccountUsagePersistenceScheduler({
      api: {
        getAccountEncryptionMode: options => params.api.getAccountEncryptionMode(options),
      },
      credentials: params.credentials,
      randomBytes,
      serverScope: configuration.activeServerDir,
      accountScope: 'active-account',
      now: () => Date.now(),
    });
  const qualifiedConnectedAccountAuthGroupSwitchLeases =
    new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry<QualifiedConnectedAccountServiceRef>();
  const connectedServiceRuntimeAuthSwitchAttempts =
    new ConnectedServiceRuntimeAuthSwitchAttemptTracker({
      nowMs: () => Date.now(),
      windowMs: 60_000,
    });
  let connectedServicePredictiveSwitchGuard: ReturnType<
    typeof createConnectedServicePredictiveSwitchGuard
  > | null = null;
  const connectedServiceSessionAuthSwitchCore =
    createConnectedServiceSessionAuthSwitchCore();
  const recordConnectedServiceRestartDiagnostic = (
    record: ConnectedServiceDaemonRestartDiagnosticRecord,
  ) => {
    logConnectedServiceDaemonRestartDiagnostic(logger, record);
  };
  const commitConnectedServiceAccountSwitchSessionEventWithNotification =
    async (
      input: Readonly<{
        sessionId: string;
        event: unknown;
        logContext: string;
        reasonFallback?: string;
      }>,
    ): Promise<void> => {
      return await withSessionAccountContext(input.sessionId, async (accountContext) => {
        const accountApi = accountContext?.api ?? params.api;
        return await withSessionAccountHome(accountContext, async () => {
          await commitConnectedServiceAccountSwitchSessionEvent({
            mutationCustody:
              accountContext?.daemonSessionMutationCustody ??
              params.daemonSessionMutationCustody,
            sessionId: input.sessionId,
            event: input.event,
            listConnectedServiceProfiles:
              accountApi.listConnectedServiceProfiles.bind(accountApi),
          });

          const record =
            input.event && typeof input.event === 'object'
              ? (input.event as Record<string, unknown>)
              : null;
          // Applied switches notify for BOTH event shapes: the raw account-switch record
          // and the rich automatic group-switch event — previously the group-apply path
          // committed the transcript event but silently skipped the notification.
          if (
            !record ||
            (record.type !== 'connected_service_account_switch' &&
              record.type !== 'connected_service_auth_group_switch')
          )
            return;
          const serviceIdParsed =
            readBuiltInLegacyConnectedAccountServiceKeyIngress(record.serviceId);
          if (!serviceIdParsed) return;
          const reason =
            normalizeOptionalString(record.reason) ||
            input.reasonFallback ||
            'unknown';
          const fromProfileId =
            normalizeOptionalString(record.fromProfileId) || null;
          const toProfileId = normalizeOptionalString(record.toProfileId) || null;
          // Reason-based suppression (background/manual) is owned by the dispatcher via
          // the ONE visibility policy — no per-reason branching here.
          if (fromProfileId && toProfileId && fromProfileId === toProfileId)
            return;
          const trackedForNotification =
            Array.from(params.pidToTrackedSession.values()).find(
              (child) => child.happySessionId === input.sessionId,
            ) ?? null;
          await assertSessionAccountCurrent(input.sessionId, accountContext);
          const settingsSnapshot =
            accountContext?.readAccountSettingsSnapshot() ??
            getActiveAccountSettingsSnapshot();
          await dispatchConnectedServiceAccountSwitchNotificationAsync({
            settings: settingsSnapshot?.settings ?? null,
            settingsSecretsReadKeys:
              settingsSnapshot?.settingsSecretsReadKeys ?? [],
            expoPushSender: accountApi.push(),
            runtimeQuotaSnapshots:
              accountContext?.connectedServiceRuntimeQuotaSnapshots ??
              connectedServiceRuntimeQuotaSnapshots,
            listConnectedServiceProfiles:
              accountApi.listConnectedServiceProfiles.bind(accountApi),
            source: {
              sessionId: input.sessionId,
              sessionTitle: resolveTrackedSessionNotificationTitle(
                trackedForNotification,
              ),
              serviceId: serviceIdParsed,
              groupId: normalizeOptionalString(record.groupId),
              fromProfileId,
              toProfileId,
              reason,
              limitCategory:
                normalizeOptionalString(record.limitCategory) || null,
              retryAfterMs:
                typeof record.retryAfterMs === 'number' &&
                Number.isFinite(record.retryAfterMs)
                  ? Math.max(0, Math.trunc(record.retryAfterMs))
                  : null,
              quotaScope: normalizeOptionalString(record.quotaScope) || null,
              providerLimitId:
                normalizeOptionalString(record.providerLimitId) || null,
              action: null,
            },
            nowMs: () => Date.now(),
            dedupeWindowMs: resolvePositiveIntEnv(
              params.processEnv
                .HAPPIER_CONNECTED_SERVICES_ACCOUNT_SWITCH_NOTIFICATION_DEDUPE_MS,
              60_000,
              { min: 0, max: 24 * 60 * 60_000 },
            ),
          }).catch((error) => {
            logger.debug(
              `[DAEMON RUN] ${input.logContext} connected-service account switch notification failed (non-fatal)`,
              error,
            );
          });
        });
      });
    };
  const requestAuthGroupQuotaFreshnessMs = resolvePositiveIntEnv(
    params.processEnv.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_QUOTA_FRESHNESS_MS,
    5 * 60_000,
    { min: 1_000, max: 60 * 60_000 },
  );
  const prepareLegacyAuthGroupCandidateForSwitch = async (
    input: Readonly<{
      signal?: AbortSignal;
      serviceId: ConnectedServiceId;
      groupId: string;
      profileId: string;
      reason: string;
    }>,
  ) =>
    (await params
      .getConnectedServiceRefreshCoordinator()
      ?.prepareConnectedServiceAuthGroupCandidateForSwitch({
        serviceId: input.serviceId,
        profileId: input.profileId,
        reason: input.reason,
        signal: input.signal,
      })) ?? {
      status: 'ineligible' as const,
      memberState: {
        credentialHealthStatus: 'refresh_failed_retryable' as const,
      },
    };
  const readQualifiedConnectedServiceAuthGroup = async (
    input: Readonly<{
      serviceId: ConnectedAccountServiceKey;
      groupId: string;
      sessionId?: string;
      signal?: AbortSignal;
    }>,
  ) => {
    if (params.resolveQualifiedConnectedAccountV4Support?.() !== 'advertised') {
      return null;
    }
    const service = resolveQualifiedConnectedAccountServiceForIngressServiceId(
      input.serviceId,
    );
    if (!service) return null;
    return await withSessionAccountContext(input.sessionId ?? null, async (accountContext) => {
      if (accountContext)
        return await accountContext.qualifiedConnectedAccountApi.readGroup({
          service,
          groupId: input.groupId,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      return await readQualifiedConnectedAccountGroupV4({
        token: params.credentials.token,
        group: { service, groupId: input.groupId },
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }, undefined, input.signal);
  };
  const resolveQualifiedProviderAccountUsagePersistenceTargets = async (
    input: Readonly<{
      sessionId: string;
      snapshot: ProviderAccountUsageSnapshotV1;
      sources: readonly ConnectedServiceUsageSourceV1[];
    }>,
  ): Promise<readonly QualifiedProviderAccountUsagePersistenceTarget[]> => {
    return await withSessionAccountContext(input.sessionId, async (accountContext) => {
      await assertSessionAccountCurrent(input.sessionId, accountContext);
      return await withSessionAccountHome(accountContext, async () => {
        if (
          params.resolveQualifiedConnectedAccountV4Support?.() !== 'advertised' ||
          input.snapshot.accountSubject.kind !== 'providerSubject'
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
            source.serviceId !== binding.serviceId ||
            source.profileId !== binding.profileId
          )
            return false;
          return source.bindingKind === 'group_member'
            ? binding.groupId === source.groupId &&
                binding.groupGeneration === source.groupGeneration
            : binding.groupId === null;
        };
        const candidateBindings =
          input.sources.length > 0
            ? runtimeTarget.activeBindings.filter((binding) =>
                input.sources.some((source) =>
                  sourceMatchesBinding(source, binding),
                ),
              )
            : runtimeTarget.activeBindings;
        const providerAccountId = input.snapshot.accountSubject.id.trim();
        if (!providerAccountId) return [];
        const listedAccountsByService = new Map<
          string,
          Awaited<ReturnType<typeof listQualifiedConnectedAccountsV4>>
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
              requestPurpose: 'connected-accounts:usage-persistence',
              token:
                accountContext?.bootstrap.credentials.token ??
                params.credentials.token,
              service,
            }).catch((error: unknown) => {
              if (axios.isCancel(error) || (error instanceof Error && error.name === 'AbortError')) throw error;
              throw new ProviderAccountUsageSourceQualificationError('qualified_account_listing_failed', error);
            });
            listedAccountsByService.set(serviceKey, listed);
          }
          const profile = listed.accounts.find(
            (candidate) =>
              candidate.ref.accountId === binding.profileId &&
              candidate.providerIdentity?.accountId === providerAccountId,
          );
          if (!profile || profile.revisionSemantics !== 'revisioned') continue;
          const resolutions = await resolveConnectedServiceCredentialResolutions({
            credentials:
              accountContext?.bootstrap.credentials ?? params.credentials,
            api: accountContext?.api ?? params.api,
            bindings: [
              {
                serviceId: legacyServiceId,
                profileId: binding.profileId,
              },
            ],
          }).catch((error: unknown) => {
            if (axios.isCancel(error) || (error instanceof Error && error.name === 'AbortError')) throw error;
            throw new ProviderAccountUsageSourceQualificationError('credential_resolution_failed', error);
          });
          const resolution = resolutions.get(legacyServiceId) ?? null;
          if (
            !resolution ||
            resolution.revisionSemantics !== 'revisioned' ||
            resolution.credentialRevision !== profile.credentialRevision ||
            readConnectedServiceCredentialProviderAccountId(resolution.record) !==
              providerAccountId
          )
            continue;
          const source =
            binding.groupId === null
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
        await assertSessionAccountCurrent(input.sessionId, accountContext);
        return targets;
      });
    });
  };
  const validateConnectedServiceGroupMutationCurrentness = async (
    input: Readonly<{
      serviceId: ConnectedAccountServiceKey;
      groupId: string;
      profileId: string;
      generation: number;
      credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
    }>,
    sessionId?: string,
  ) => {
    return await withSessionAccountContext(sessionId ?? null, async (accountContext) =>
      await withSessionAccountHome(accountContext, async () => {
        return await validateGroupMutationCurrentness({ input,
          credentials: accountContext?.bootstrap.credentials ?? params.credentials,
          api: accountContext?.api ?? params.api,
          readGroup: group => readQualifiedConnectedServiceAuthGroup({ ...group, ...(sessionId ? { sessionId } : {}) }),
          ...(sessionId ? { assertCurrent: () => assertSessionAccountCurrent(sessionId, accountContext) } : {}),
        });
      }),
    );
  };
  const prepareQualifiedAuthGroupCandidateForSwitch = async (
    input: Readonly<{
      signal?: AbortSignal;
      serviceId: QualifiedConnectedAccountServiceRef;
      groupId: string;
      profileId: string;
      reason: string;
    }>,
  ) => {
    const serviceId = resolveFirstPartyConnectedAccountServiceId(
      input.serviceId,
    );
    if (!serviceId) return { status: 'ready' as const };
    return await prepareLegacyAuthGroupCandidateForSwitch({
      serviceId,
      groupId: input.groupId,
      profileId: input.profileId,
      reason: input.reason,
      signal: input.signal,
    });
  };
  const qualifiedAuthGroupQuotaDependencies = {
    accountUsageStore: providerAccountUsageStore,
    probeQuotaSnapshotsForGroup: async (
      input: Readonly<{
        signal?: AbortSignal;
        serviceId: QualifiedConnectedAccountServiceRef;
        groupId: string;
        profileIds: ReadonlyArray<string>;
        reason: string;
      }>,
    ) => {
      const coordinator = params.getConnectedServiceQuotasCoordinator();
      return coordinator
        ? await coordinator.probeGroupQuotaSnapshots({
            ...input,
            serviceId: buildQualifiedPluginContributionKey(input.serviceId),
          })
        : {
            status: 'incomplete' as const,
            requestedProfileCount: input.profileIds.length,
            completedProfileCount: 0,
            reason: 'probe_unavailable' as const,
          };
    },
    consumeAvailableRecoveryCreditForProfile: async (
      input: Readonly<{
        serviceId: QualifiedConnectedAccountServiceRef;
        groupId: string;
        profileId: string;
        automaticResetContext: Readonly<{
          groupId: string;
          sessionId?: string;
        }>;
      }>,
    ) => {
      const coordinator = params.getConnectedServiceQuotasCoordinator();
      return coordinator
        ? await coordinator.consumeAvailableRecoveryCreditForProfile({
            ...input,
            serviceId: buildQualifiedPluginContributionKey(input.serviceId),
          })
        : {
            ok: false as const,
            errorCode: 'connected_service_quota_recovery_credit_not_available',
            error: 'Quota recovery is unavailable',
          };
    },
  };
  const qualifiedRequestAuthGroupSwitchCoordinator =
    params.resolveQualifiedConnectedAccountV4Support
      ? createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
          ...qualifiedAuthGroupQuotaDependencies,
          accountScope: params.externalActionAccountId
            ? {
                serverId: params.serverId,
                accountId: params.externalActionAccountId,
              }
            : undefined,
          token: params.credentials.token,
          quotaFreshnessMs: requestAuthGroupQuotaFreshnessMs,
          nowMs: () => Date.now(),
          leases: qualifiedConnectedAccountAuthGroupSwitchLeases,
          applyGeneration: async () => ({ ok: true }),
          prepareCandidateForSwitch:
            prepareQualifiedAuthGroupCandidateForSwitch,
        })
      : null;
  params.onConnectedServicePoolSelectionReadReady?.(async (request) => {
    if (params.resolveQualifiedConnectedAccountV4Support?.() !== 'advertised' || !qualifiedRequestAuthGroupSwitchCoordinator) {
      return { status: 'unavailable', code: 'unsupported' };
    }
    const result = await qualifiedRequestAuthGroupSwitchCoordinator.readSelection({
      serviceId: request.group.service,
      groupId: request.group.groupId,
      providerLimitId: request.providerLimitId,
      hypothetical: request.hypothetical,
    });
    return ConnectedServicePoolSelectionGetResponseV1Schema.parse({ group: request.group, ...result });
  });
  const switchAfterConnectedAccountRequestAuthFailure = async (
    input: Readonly<{
      parentSessionId?: string;
      service: QualifiedConnectedAccountServiceRef;
      failure: Parameters<
        ConnectedAccountRequestAuthRecoveryInput['switchAfterClassifiedFailure']
      >[0];
    }>,
  ): Promise<unknown> => {
    const support =
      params.resolveQualifiedConnectedAccountV4Support?.() ?? 'absent';
    if (support !== 'advertised') {
      return null;
    }
    return await withSessionAccountContext(input.parentSessionId ?? null, async (accountContext) => {
      const coordinator = input.parentSessionId
        ? await createSessionQualifiedAuthGroupSwitchCoordinator({
            sessionId: input.parentSessionId,
            accountContext,
            serviceId: buildQualifiedPluginContributionKey(input.service),
            reason: 'request_auth_recovery',
            applyGeneration: async () => ({ ok: true }),
          })
        : qualifiedRequestAuthGroupSwitchCoordinator;
      if (!coordinator) return null;
      return await coordinator.switchAfterClassifiedFailure({
        ...input.failure,
        serviceId: input.service,
      });
    });
  };
  let connectedAccountRequestAuthHttpPort: number | null = null;
  const requireConnectedAccountRequestAuthHttpPort = (): number => {
    const value = connectedAccountRequestAuthHttpPort;
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > 65535
    ) {
      throw new Error('connected_account_request_auth_http_port_unavailable');
    }
    return value;
  };
  const connectedAccountRequestAuthRegistry =
    params.connectedAccountRequestAuthRegistry ??
    createConnectedAccountRequestAuthSubjectRegistry();
  const resolveRequestAuthAccountFingerprint = (
    resolved: ConnectedAccountRequestAuthResolvedBinding,
    projection: ConnectedServiceProjectionSnapshot | null,
  ): string | null => {
    if (!projection) return null;
    const legacyServiceId = resolveFirstPartyConnectedAccountServiceId(
      resolved.account.service,
    );
    const serviceKey =
      legacyServiceId === null
        ? null
        : readBuiltInLegacyConnectedAccountServiceKeyIngress(legacyServiceId);
    if (serviceKey === null) return null;
    if (!resolved.group) {
      const revision = projection.resolveCredentialRevision(
        serviceKey,
        resolved.account.accountId,
      );
      return revision
        ? JSON.stringify([serviceKey, resolved.account.accountId, revision])
        : null;
    }
    const group = projection.groups.find(
      (candidate) =>
        candidate.serviceId === serviceKey &&
        candidate.groupId === resolved.group?.groupId,
    );
    if (!group?.activeProfileId) return null;
    const revision = projection.resolveCredentialRevision(
      serviceKey,
      group.activeProfileId,
    );
    return revision
      ? JSON.stringify([
          serviceKey,
          group.activeProfileId,
          revision,
          group.groupId,
          group.generation,
        ])
      : null;
  };
  const recordConnectedAccountRequestAuthTemporaryRetry = async (
    input: ConnectedAccountRequestAuthTemporaryRetry,
    accountContext: RequesterSessionRuntimeContext | null = null,
    parentSessionId?: string,
  ): Promise<ConnectedAccountRequestAuthTemporaryRetryRecordResult> => {
    const serviceId = resolveFirstPartyConnectedAccountServiceId(input.service);
    const quotaCoordinator = accountContext
      ? accountContext.connectedServiceQuotasCoordinator
      : params.getConnectedServiceQuotasCoordinator();
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
      if (parentSessionId)
        await assertSessionAccountCurrent(parentSessionId, accountContext);
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
  const recoverConnectedAccountRequestAuthFailure = async (
    input: Readonly<{
      subject: Parameters<
        ReturnType<
          typeof createConnectedAccountRequestAuthService
        >['lookupRequestAuth']
      >[0]['subject'];
      resolved: ConnectedAccountRequestAuthResolvedBinding;
      failure: ConnectedAccountRequestAuthRecoveryInput['failure'];
      signal: AbortSignal;
      allowCredentialRefresh: boolean;
    }>,
  ): Promise<RequestAuthFailureOutcomeV1> => {
    input.signal.throwIfAborted();
    const parentSessionId = input.subject.parentSessionId;
    return await withSessionAccountContext(parentSessionId ?? null, async (accountContext) => {
      if (!input.subject.isCurrent()) return { status: 'stale_context' };
      if (parentSessionId)
        await assertSessionAccountCurrent(parentSessionId, accountContext);
      return await withSessionAccountHome(accountContext, async () => {
        const legacyServiceId =
          input.resolved.legacyServiceKeyedCompatibility === true
            ? resolveFirstPartyConnectedAccountServiceId(
                input.resolved.account.service,
              )
            : null;
        if (
          input.resolved.legacyServiceKeyedCompatibility === true &&
          !legacyServiceId
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
            if (!input.subject.isCurrent()) return false;
            if (parentSessionId)
              await assertSessionAccountCurrent(parentSessionId, accountContext);
            const refreshCoordinator = accountContext
              ? accountContext.connectedServiceRefreshCoordinator
              : params.getConnectedServiceRefreshCoordinator();
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
            if (parentSessionId)
              await assertSessionAccountCurrent(parentSessionId, accountContext);
            return Boolean(refreshed);
          },
          switchAfterClassifiedFailure: async (failure) => {
            input.signal.throwIfAborted();
            if (!input.subject.isCurrent()) return null;
            if (parentSessionId)
              await assertSessionAccountCurrent(parentSessionId, accountContext);
            const result = await switchAfterConnectedAccountRequestAuthFailure({
              ...(parentSessionId ? { parentSessionId } : {}),
              service: input.resolved.account.service,
              failure,
            }).catch(() => null);
            input.signal.throwIfAborted();
            return result;
          },
          recordTemporaryRetry: async (retry) =>
            await recordConnectedAccountRequestAuthTemporaryRetry(
              retry,
              accountContext,
              parentSessionId,
            ),
        });
        input.signal.throwIfAborted();
        if (!input.subject.isCurrent()) return { status: 'stale_context' };
        if (parentSessionId)
          await assertSessionAccountCurrent(parentSessionId, accountContext);
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
        const projection = await fetchConnectedServiceProjectionSnapshot(
          input.signal,
        ).catch(() => {
          input.signal.throwIfAborted();
          return latestConnectedServiceProjectionSnapshot;
        });
        input.signal.throwIfAborted();
        const after = resolveRequestAuthAccountFingerprint(
          input.resolved,
          projection,
        );
        return {
          status:
            !after || after !== before ? 'current_changed' : 'current_unchanged',
        };
      });
    }, undefined, input.signal);
  };
  const qualifiedRequestAuthCallbacks =
    createDaemonQualifiedRequestAuthCallbacks({
      recordScopeChallenge: params.establishedConnectedAccountRuntimeOwner?.recordScopeChallenge,
      withSessionAccountContext,
      assertSessionAccountCurrent,
    });
  const connectedAccountRequestAuthService =
    createConnectedAccountRequestAuthService({
      resolveCurrentBinding: async ({ subject, binding, signal }) => {
        signal.throwIfAborted();
        return await withSessionAccountContext(
          subject.legacyServiceKeyedCompatibility === true
            ? (subject.parentSessionId ?? null)
            : null,
          async (accountContext) => {
            // The host-issued parent selects requester custody before a released
            // scalar adapter can consult the Machine custodian's projection.
            if (
              subject.legacyServiceKeyedCompatibility !== true ||
              accountContext
            ) {
              return await qualifiedRequestAuthCallbacks.resolveCurrentBinding({
                subject,
                binding,
                signal,
              });
            }
            const service =
              binding.target.kind === 'account'
                ? binding.target.account.service
                : binding.target.service;
            const legacyServiceId =
              subject.legacyServiceKeyedCompatibility === true
                ? resolveFirstPartyConnectedAccountServiceId(service)
                : null;
            if (legacyServiceId) {
              const projection =
                latestConnectedServiceProjectionSnapshot ??
                (await fetchConnectedServiceProjectionSnapshot(signal));
              signal.throwIfAborted();
              const resolved = projection
                ? resolveFirstPartyConnectedAccountBinding(binding, projection)
                : null;
              return resolved
                ? Object.freeze({
                    ...resolved,
                    legacyServiceKeyedCompatibility: true as const,
                  })
                : null;
            }
            return await qualifiedRequestAuthCallbacks.resolveCurrentBinding({
              subject,
              binding,
              signal,
            });
          },
          undefined,
          signal,
        );
      },
      materializeBearer: async ({
        subject,
        binding,
        resolved,
        materialization,
        signal,
      }) => {
        signal.throwIfAborted();
        const service =
          binding.target.kind === 'account'
            ? binding.target.account.service
            : binding.target.service;
        const legacyServiceId =
          subject.legacyServiceKeyedCompatibility === true &&
          resolved.legacyServiceKeyedCompatibility === true
            ? resolveFirstPartyConnectedAccountServiceId(service)
            : null;
        if (!legacyServiceId) {
          return await qualifiedRequestAuthCallbacks.materializeBearer({
            subject,
            binding,
            resolved,
            materialization,
            signal,
          });
        }
        return await materializeFirstPartyConnectedAccountBearer({
          resolved,
          materialization,
          signal,
          transport: params.resolveQualifiedConnectedAccountRequestAuthTransport
            ? params.resolveQualifiedConnectedAccountRequestAuthTransport(
                resolved.account.service,
              )
            : params.resolveQualifiedConnectedAccountV4Support?.() ===
                'advertised'
              ? Object.freeze({ kind: 'v4' as const })
              : (() => {
                  throw new Error('request_auth_capability_indeterminate');
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
            const resolutions =
              await resolveConnectedServiceCredentialResolutions({
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
      refreshExpiredReplacement: async ({ subject, resolved, signal }) => {
        if (resolved.legacyServiceKeyedCompatibility === true) return;
        const parentSessionId = subject.parentSessionId;
        await withSessionAccountContext(parentSessionId ?? null, async (accountContext) => {
          const refreshCoordinator = accountContext
            ? accountContext.connectedServiceRefreshCoordinator
            : params.getConnectedServiceRefreshCoordinator();
          if (!refreshCoordinator) return;
          const assertCurrent = async () => {
            signal.throwIfAborted();
            if (!subject.isCurrent()) throw new Error('request_auth_not_active');
            if (parentSessionId) await assertSessionAccountCurrent(parentSessionId, accountContext);
          };
          await withSessionAccountHome(accountContext, () => refreshExpiredConnectedAccountRequestAuthReplacement({
            resolved, signal, refreshCoordinator, assertCurrent,
            readAccounts: async (service, signal) => (await listQualifiedConnectedAccountsV4({
              token: (accountContext?.bootstrap.credentials ?? params.credentials).token,
              service, signal,
              requestPurpose: 'connected-accounts:request-auth-replacement',
            })).accounts,
          }));
        }, undefined, signal);
      },
      refreshAfterAuthFailure: async ({
        subject,
        resolved,
        failure,
        signal,
      }) => {
        return await recoverConnectedAccountRequestAuthFailure({
          subject,
          resolved,
          failure,
          signal,
          allowCredentialRefresh: true,
        });
      },
      reportQuotaFailure: async ({ subject, resolved, failure, signal }) => {
        return await recoverConnectedAccountRequestAuthFailure({
          subject,
          resolved,
          failure,
          signal,
          allowCredentialRefresh: false,
        });
      },
      reportScopeFailure: qualifiedRequestAuthCallbacks.reportScopeFailure,
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
        const legacyServiceId = resolveFirstPartyConnectedAccountServiceId(
          account.service,
        );
        const serviceKey =
          legacyServiceId === null
            ? null
            : readBuiltInLegacyConnectedAccountServiceKeyIngress(
                legacyServiceId,
              );
        return (
          serviceKey !== null &&
          snapshot.resolveCredentialRevision(serviceKey, account.accountId) ===
            credentialRevision
        );
      },
    });
    return previous;
  };
  const fetchConnectedServiceProjectionSnapshot = async (
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<ConnectedServiceProjectionSnapshot> => {
    const { snapshot, requester } =
      await fetchConnectedServiceProjectionForSession({
        token: params.credentials.token,
        ...(sessionId
          ? {
              sessionId,
              withSessionAccountContext,
              assertSessionAccountCurrent,
            }
          : {}),
        ...(signal ? { signal } : {}),
      });
    if (!requester) replaceConnectedServiceProjectionSnapshot(snapshot);
    return snapshot;
  };
  await registerTrackedConnectedServiceRuntimeTargets();
  const resolveCanonicalTrackedSessionId = (pid: number): string => {
    const session = params.pidToTrackedSession.get(pid);
    const sessionId =
      typeof session?.happySessionId === 'string'
        ? session.happySessionId.trim()
        : '';
    if (!sessionId || /^PID-\d+$/.test(sessionId)) {
      return '';
    }
    return sessionId;
  };

  let guardBrowserResourceOwner: Pick<Extract<BrowserSidecarControlAdapterFactoryResult, { ok: true }>, 'adapter' | 'readProcessRoots' | 'readResourceTargets'> | null = null;
  let processActionOwnerAdapters: ReturnType<typeof createProcessActionOwnerAdapters> | null = null;
  let iosSimulatorHelperSession: ReturnType<typeof createIosSimulatorHelperSession> | null = null;
  const processOwnershipRuntime = createProcessOwnershipRuntime({
    daemonScopeKey: resolveProcessOwnerScopeKey(configuration.happyHomeDir),
    listRoots: async (snapshot, readOptions) => {
      const observeRootSource = async <T>(phase: string, operation: () => Promise<T>, sessionId?: string) => {
        const startedAtMs = Date.now();
        logger.debug('[process-ownership] Root source started', { phase, capturedAtMs: snapshot.capturedAtMs, sessionId });
        try { return await operation(); }
        finally { logger.debug('[process-ownership] Root source settled', {
          phase, capturedAtMs: snapshot.capturedAtMs, sessionId, elapsedMs: Date.now() - startedAtMs,
        }); }
      };
      const [markers, runs, bootTimeMs] = await Promise.all([
        observeRootSource('session_markers', () => listSessionMarkers()),
        observeRootSource('execution_run_markers', () => listExecutionRunMarkersForRehydration()),
        observeRootSource('boot_time', () => readProcessOwnershipBootTimeMs()),
      ]);
      const managedServices = (pluginRuntimeController.getState().activeRegistry?.projectManagedServices.readResourceTargets() ?? [])
        .map(target => processActionOwnerAdapters?.captureServiceRoot(target) ?? target.root);
      const markerBySession = new Map(markers.map(marker => [marker.happySessionId, marker]));
      // Physical cleanup consumes native ownership and existing lifecycle facts.
      // Recovering unrelated Account contexts here would couple Stop/exit and
      // Left-behind observation to Home storage and requester admission latency.
      if (readOptions.requesterAttribution !== 'retained') await Promise.all([...params.pidToTrackedSession.entries()].map(async ([pid, session]) => {
        const sessionId = resolveCanonicalTrackedSessionId(pid);
        if (!sessionId || session.requesterWorkAttributionV1 || session.spawnOptions?.requesterWorkAttributionV1
          || markerBySession.get(sessionId)?.requesterWorkAttributionV1) return;
        // The canonical requester lifecycle verifies Account ownership and current
        // Machine admission before retaining attribution on this exact TrackedSession.
        await observeRootSource('requester_recovery', async () => {
          const context = await requesterRuntimeAccess?.resolve(sessionId) ?? null;
          await releaseSessionAccountContext(context);
        }, sessionId);
      }));
      return listHappierProcessRoots({ snapshot, bootTimeMs,
        nativeContainers: pluginRuntimeController.getState().activeRegistry?.projectManagedServices.readNativeContainerSources() ?? [],
        trackedSessions: [...params.pidToTrackedSession.values()].map(session => ({ ...session,
          requesterWorkAttributionV1: session.requesterWorkAttributionV1 ?? session.spawnOptions?.requesterWorkAttributionV1
            ?? (session.happySessionId ? markerBySession.get(session.happySessionId)?.requesterWorkAttributionV1 : undefined),
          ownerCreatedAtMs: session.happySessionId ? markerBySession.get(session.happySessionId)?.createdAt : undefined })),
        terminalRegistry: getSharedTerminalProcessRegistry(), managedServices: [...managedServices, ...readLanguageServerProcessRoots()],
        terminalRequesterAttribution: params.readTerminalRequesterAttribution,
        helperProcesses: [...(guardBrowserResourceOwner?.readResourceTargets
          ? guardBrowserResourceOwner.readResourceTargets().map(target => processActionOwnerAdapters?.captureBrowserRoot(target) ?? target.root)
          : guardBrowserResourceOwner?.readProcessRoots?.() ?? []),
          ...params.readHelperProcessRoots?.() ?? [], ...iosSimulatorHelperSession?.readProcessRoots() ?? []],
        executionRuns: runs.map(run => ({ owner: { kind: 'run', runId: run.runId, ...(run.happySessionId ? { sessionId: run.happySessionId } : {}) },
          pid: run.pid, ownerCreatedAtMs: run.startedAtMs, live: run.status === 'running',
          ...(run.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: run.requesterWorkAttributionV1 } : {}) })),
        endedRoots: params.endedProcessRoots?.(),
      });
    },
  });
  const processLeftBehindPass = createLeftBehindPass({
    processOwnershipRuntime,
    onUnavailable: (reason) => logger.debug('[DAEMON RUN] Process left-behind observation unavailable', { reason }),
  });
  const ownerRemainder = createEndOwnerRemainder({
    processOwnershipRuntime,
    daemonScopeKey: resolveProcessOwnerScopeKey(configuration.happyHomeDir),
    firstPass: processLeftBehindPass.firstPass,
    retainEndedRoots: params.retainEndedProcessRoots,
  });
  let onChildExited: (
    pid: number,
    exit: { reason: string; code: number | null; signal: string | null },
  ) => Promise<void> = async () => {};
  let releaseExecutionRunAuthorityForRunnerExit: (
    input: Readonly<{
      runnerPid: number;
      runnerIdentity: object;
    }>,
  ) => Promise<void> = async () => {};
  const runnerExecutionRunSnapshots = createRunnerExecutionRunSnapshots({ machineId: params.machineId,
    controller: pluginRuntimeController,
    withNativeModelAccount: async (context, read) => {
      return await withSessionAccountContext(context.sessionId, async (requester) => {
        await assertSessionAccountCurrent(context.sessionId, requester);
        const credentials = requester ? requester.bootstrap.credentials : params.credentials;
        const snapshot = requester ? requester.readAccountSettingsSnapshot() : getActiveAccountSettingsSnapshot();
        const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
        const isCurrent = async () => await context.isCurrent()
          && (requester !== null || lifetime === getActiveAccountSettingsSnapshotLifetimeToken());
        if (!snapshot || snapshot.scopeKey !== resolveForegroundAccountSettingsScopeKey(credentials) || !await isCurrent()) {
          throw new Error('execution_run_contribution_snapshot_unavailable');
        }
        const result = await withSessionAccountHome(requester, () => read({ accountSettings: snapshot.settings, promptCredentials: credentials,
          preflightDependencies: { createApiClient: async () => requester ? requester.api : params.api,
            activatePurposeBindings: requester ? requester.activatePurposeBindings : params.activatePurposeBindings,
            connectedAccountsOwner: requester?.connectedAccountsOwner } }));
        await assertSessionAccountCurrent(context.sessionId, requester);
        if (!await isCurrent()) throw new Error('execution_run_contribution_snapshot_unavailable');
        return result;
      });
    },
    resolveProviderPreparation: (request, context) => resolveRunnerProviderPreparation(request, context) });
  let observeConnectedServiceRestartProcessMissing:
    | ((tracked: TrackedSession) => void)
    | null = null;
  type PendingRequestAuthSourceCutover = {
    sessionId: string;
    agentId: string;
    tracked: TrackedSession;
    requirement: RequestAuthSourceCutoverRequirement;
    resolveCurrentCapabilityPath: (tracked: TrackedSession) => string | null;
    attempt: Promise<RestartSessionRunnerResult> | null;
    boundaryAttempt: Promise<RestartSessionRunnerResult> | null;
  };
  const pendingRequestAuthSourceCutoverBySessionId = new Map<
    string,
    PendingRequestAuthSourceCutover
  >();
  const retirePendingRequestAuthSourceCutoverForCurrentSuccessor = (
    pending: PendingRequestAuthSourceCutover,
  ): boolean => {
    const matches = Array.from(params.pidToTrackedSession.values()).filter(
      (tracked) =>
        normalizeOptionalString(tracked.happySessionId) === pending.sessionId,
    );
    if (matches.length !== 1 || matches[0] === pending.tracked) {
      return false;
    }
    const successor = matches[0]!;
    const currentCapabilityPath =
      pending.resolveCurrentCapabilityPath(successor);
    if (!currentCapabilityPath) return false;
    const successorSource = resolveRequestAuthSourceCutoverRequirement({
      tracked: successor,
      currentCapabilityPath,
    });
    if (successorSource.status !== 'current') {
      return false;
    }
    if (
      pendingRequestAuthSourceCutoverBySessionId.get(pending.sessionId) ===
      pending
    ) {
      pendingRequestAuthSourceCutoverBySessionId.delete(pending.sessionId);
    }
    return true;
  };
  const requestPendingRequestAuthSourceCutover = (
    pending: PendingRequestAuthSourceCutover,
  ): Promise<RestartSessionRunnerResult> => {
    if (pending.attempt) return pending.attempt;
    const attempt = (async (): Promise<RestartSessionRunnerResult> => {
      try {
        const result = await restartSessionRunnerForRequestAuthSourceCutover({
          tracked: pending.tracked,
          currentIdentity: resolveCurrentSessionRunnerLaunchIdentity(),
          requestRestart: requestSessionRunnerVersionRuntimeRefresh,
          requirement: pending.requirement,
          resolveCurrentCapabilityPath: () =>
            pending.resolveCurrentCapabilityPath(pending.tracked),
          resolveActivityDisabledReason:
            resolveSessionRunnerActivityDisabledReason,
        });
        logger.debug(
          '[DAEMON RUN] Reattached Agent request-auth source cutover attempt settled',
          {
            sessionId: pending.sessionId,
            agentId: pending.agentId,
            status: result.status,
            reasonCode: result.reasonCode ?? null,
          },
        );
        if (
          result.status === 'restarted' &&
          retirePendingRequestAuthSourceCutoverForCurrentSuccessor(pending)
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
          reasonCode: 'runner_generation_unattested',
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
        pending.boundaryAttempt === attempt &&
        result.status === 'busy' &&
        result.reasonCode === 'turn_in_progress'
      ) {
        pending.boundaryAttempt = null;
      }
    });
    return attempt;
  };
  const shutdownCancellationDomains = createDaemonShutdownCancellationDomains();
  const recoverReattachedAgentRequestAuth = async (): Promise<void> => {
    const reattached = [...params.pidToTrackedSession.values()].filter(
      (tracked) => tracked.reattachedFromDiskMarker === true,
    );
    if (reattached.length === 0) return;
    if (
      !params.activateSessionPurposeBindings &&
      !params.resolveRequesterSessionRuntimeContext
    ) {
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
        await acquireDaemonPluginRuntimeRegistryLease();
      for (const tracked of reattached) {
        const trackedMapPid = tracked.pid;
        const expectedPid = tracked.sessionRunnerPid ?? tracked.pid;
        const sessionId = normalizeOptionalString(tracked.happySessionId);
        const agentId = resolveTrackedSessionCatalogAgentId(tracked);
        const materializationIdentity =
          resolveConnectedServiceMaterializationIdentityFromTrackedSession(
            tracked,
          );
        const expectedRunnerIdentity = resolveTrackedSessionRunnerIdentity(tracked);
        const expectedProcessCommandHash = normalizeOptionalString(
          expectedRunnerIdentity?.processCommandHash,
        );
        const expectedProcessStartTimeMs = expectedRunnerIdentity?.processStartTimeMs;
        const authorityPath =
          tracked.agentRuntimeDaemonServiceAuthorityFilePath;
        const parsedBindings =
          ConnectedServiceBindingsV2IngressSchema.safeParse(
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
          !sessionId ||
          /^PID-\d+$/u.test(sessionId) ||
          !agentId ||
          !materializationIdentity ||
          !parsedBindings.success ||
          !expectedProcessCommandHash ||
          !authorityPath ||
          typeof expectedProcessStartTimeMs !== 'number' ||
          !Number.isFinite(expectedProcessStartTimeMs)
        ) {
          unavailable('reattached_agent_identity_or_bindings_unavailable');
          continue;
        }

        const isTrackedPidCurrent = () => tracked.pid === trackedMapPid
          && tracked.reportMarkerCustody?.retiring !== true
          && params.pidToTrackedSession.get(trackedMapPid) === tracked;
        if (!isTrackedPidCurrent()) {
          unavailable('reattached_agent_lifecycle_changed');
          continue;
        }
        let accountContext: RequesterSessionRuntimeContext | null;
        try {
          accountContext = await resolveSessionAccountContext(sessionId);
        } catch {
          unavailable('requester_session_not_current');
          continue;
        }
        let accountContextRetained = false;
        const isBorrowedAccountCurrent = () => isTrackedPidCurrent()
          && (!accountContext || tracked.requesterSessionRuntimeContext === accountContext);
        try {
          if (!isBorrowedAccountCurrent()) {
            unavailable('reattached_agent_lifecycle_changed');
            continue;
          }
          const activateSessionPurposeBindings = accountContext
            ? accountContext.activateSessionPurposeBindings
            : params.activateSessionPurposeBindings;
          if (!activateSessionPurposeBindings) {
            unavailable('session_purpose_binding_owner_unavailable');
            continue;
          }
          const materializationBaseDir =
            accountContext?.connectedServicesMaterializationBaseDir ??
            params.connectedServicesMaterializationBaseDir;

          const retainedAuthority =
            await readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker({
              happyHomeDir: configuration.happyHomeDir,
              publicReleaseRing: configuration.publicReleaseRing,
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
            !retainedAuthority ||
            retainedAuthority.retainedAgent.agentId !== agentId ||
            !tracked.runnerAgentSourceCustodyV1 ||
            !pluginSourceCustodyV1Equal(
              tracked.runnerAgentSourceCustodyV1,
              retainedAuthority.retainedAgent.sourceCustody,
            ) ||
            !acquireRetainedPurposeContributions
          ) {
            unavailable('retained_agent_request_auth_declaration_unavailable');
            continue;
          }
          const retainedPurposeContributions = await (async () => {
            try {
              return await acquireRetainedPurposeContributions({
                binding: retainedAuthority.retainedAgent,
                pluginHardRevocationRevision:
                  retainedAuthority.pluginHardRevocationRevision,
                runnerSnapshotIdentity: retainedAuthority.runner.snapshotIdentity,
              });
            } catch {
              return null;
            }
          })();
          if (!retainedPurposeContributions) {
            unavailable('retained_agent_request_auth_declaration_unavailable');
            continue;
          }
          const contributions = retainedPurposeContributions.contributes;

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

          const materializedRootDir = resolveConnectedServiceMaterializedRootDir({
            baseDir: materializationBaseDir,
            agentId,
            materializationKey: materializationIdentity.id,
          });
          const capabilityPath =
            resolveConnectedAccountRequestAuthCapabilityPath(materializedRootDir);
          const sourceCutover = resolveRequestAuthSourceCutoverRequirement({
            tracked,
            currentCapabilityPath: capabilityPath,
            ownedRetainedDevCapabilityPaths:
              await resolveOwnedRetainedDevRequestAuthCapabilityPaths({
                tracked,
                agentId,
                bindings: parsedBindings.data,
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
                  baseDir: materializationBaseDir,
                  agentId,
                  materializationKey: currentMaterializationIdentity.id,
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
            pendingRequestAuthSourceCutoverBySessionId.set(sessionId, pending);
            continue;
          }
          const previousCapability =
            await inspectConnectedAccountRequestAuthCapabilityFile({
              path: capabilityPath,
              materializedRootDir,
            });
          if (
            !previousCapability ||
            previousCapability.materializationId !== materializationIdentity.id
          ) {
            await retainedPurposeContributions.release();
            unavailable('request_auth_capability_recovery_facts_unavailable');
            continue;
          }

          let sessionPurposeBindingLease: ReturnType<
            typeof activateSessionPurposeBindings
          >;
          try {
            await assertSessionAccountCurrent(sessionId, accountContext);
            if (!isBorrowedAccountCurrent()) {
              throw new Error('reattached_agent_lifecycle_changed');
            }
            sessionPurposeBindingLease = activateSessionPurposeBindings({
              sessionId,
              purposes: purposeSnapshot.purposes,
              bindings: purposeSnapshot.bindings,
              ...(purposeSnapshot.directMaterialOrigins
                ? { directMaterialOrigins: purposeSnapshot.directMaterialOrigins }
                : {}),
            });
          } catch {
            await retainedPurposeContributions.release();
            unavailable('session_purpose_binding_activation_failed');
            continue;
          }

          const redactionLease = createProviderRedactionLease({ values: [] });
          const subject = scopeConnectedAccountSessionPurposeBindingLease({
            lease: sessionPurposeBindingLease,
            subjectId: sessionPurposeBindingLease.subjectId,
            parentSessionId: sessionId,
            uses: purposeSnapshot.requestAuthUses,
            ...(isLegacyServiceKeyedCompatibilityCatalogAgent(
              contributions.catalogEntriesById[agentId],
            )
              ? { legacyServiceKeyedCompatibility: true as const }
              : {}),
            registerRedaction: redactionLease.add,
          });
          const previousAttachCleanup =
            params.sessionAttachCleanupByPid.get(trackedMapPid) ?? null;
          let capability: ConnectedAccountRequestAuthCapabilityDescriptor | null =
            null;
          let capabilityRetired = false;
          let leaseDisposed = false;
          let redactionClosed = false;
          const retireRecoveredAuthority = async (): Promise<void> => {
            if (!leaseDisposed) {
              leaseDisposed = true;
              sessionPurposeBindingLease.dispose();
            }
            const currentCapability = capability;
            if (currentCapability && !capabilityRetired) {
              capabilityRetired = true;
              await connectedAccountRequestAuthRegistry.retire(currentCapability);
            }
            if (!redactionClosed) {
              redactionClosed = true;
              redactionLease.close();
            }
          };
          let lifecycleCleanupStarted = false;
          let lifecycleCleanupPromise: Promise<void> | null = null;
          const lifecycleCleanup = async (): Promise<void> => {
            accountContextRetained = true;
            lifecycleCleanupStarted = true;
            lifecycleCleanupPromise ??= (async () => {
              await retireRecoveredAuthority();
              await retainedPurposeContributions.release();
              await previousAttachCleanup?.();
              await releaseSessionAccountContext(accountContext);
            })();
            await lifecycleCleanupPromise;
          };

          // The existing reattach lifecycle owns retirement before the
          // replacement capability is published. PID promotion transfers
          // this same composed cleanup entry with the tracked session.
          params.sessionAttachCleanupByPid.set(trackedMapPid, lifecycleCleanup);
          try {
            capability = await connectedAccountRequestAuthRegistry.activate({
              subject,
              materializedRootDir,
              materializationId: materializationIdentity.id,
              httpPort: requireConnectedAccountRequestAuthHttpPort(),
              finalizeStagedAuthorityCommit: async (descriptor, commit) => {
                await assertSessionAccountCurrent(sessionId, accountContext);
                const isExactProcessCurrent = await isPidSafeHappySessionProcess(
                  {
                    pid: expectedPid,
                    expectedProcessCommandHash,
                    expectedProcessStartTimeMs,
                  },
                  params.reattachedAgentRequestAuthPidSafetyDependencies,
                );
                if (
                  // The running child was launched under the
                  // predecessor capability's exact subject
                  // scope. Recovering a differently scoped
                  // authority onto that same process would
                  // commit credentials across a changed
                  // subject scope, so the replacement scope
                  // must equal the recovered one.
                  descriptor.subjectScopeDigest !==
                    previousCapability.subjectScopeDigest ||
                  !isExactProcessCurrent ||
                  !isBorrowedAccountCurrent() ||
                  lifecycleCleanupStarted ||
                  tracked.pid !== trackedMapPid ||
                  (tracked.sessionRunnerPid ?? tracked.pid) !== expectedPid ||
                  params.pidToTrackedSession.get(trackedMapPid) !== tracked ||
                  params.sessionAttachCleanupByPid.get(trackedMapPid) !==
                    lifecycleCleanup ||
                  resolveTrackedSessionRunnerIdentity(tracked)?.processCommandHash !== expectedProcessCommandHash ||
                  resolveTrackedSessionRunnerIdentity(tracked)?.processStartTimeMs !== expectedProcessStartTimeMs ||
                  !subject.isCurrent()
                ) {
                  throw new Error('reattached_agent_process_identity_changed');
                }
                commit();
              },
            });
            const currentPid = tracked.pid;
            if (
              !isBorrowedAccountCurrent() ||
              lifecycleCleanupStarted ||
              currentPid !== trackedMapPid ||
              (tracked.sessionRunnerPid ?? tracked.pid) !== expectedPid ||
              params.pidToTrackedSession.get(trackedMapPid) !== tracked ||
              params.sessionAttachCleanupByPid.get(trackedMapPid) !==
                lifecycleCleanup
            ) {
              await retireRecoveredAuthority();
              await retainedPurposeContributions.release();
              if (
                !lifecycleCleanupStarted &&
                params.sessionAttachCleanupByPid.get(currentPid) ===
                  lifecycleCleanup
              ) {
                if (previousAttachCleanup) {
                  params.sessionAttachCleanupByPid.set(
                    currentPid,
                    previousAttachCleanup,
                  );
                } else {
                  params.sessionAttachCleanupByPid.delete(currentPid);
                }
              }
              unavailable('reattached_agent_lifecycle_changed');
            } else {
              accountContextRetained = true;
            }
          } catch {
            await retireRecoveredAuthority().catch(() => undefined);
            await retainedPurposeContributions.release().catch(() => undefined);
            const currentPid = tracked.pid;
            if (
              !lifecycleCleanupStarted &&
              params.sessionAttachCleanupByPid.get(currentPid) ===
                lifecycleCleanup
            ) {
              if (previousAttachCleanup) {
                params.sessionAttachCleanupByPid.set(
                  currentPid,
                  previousAttachCleanup,
                );
              } else {
                params.sessionAttachCleanupByPid.delete(currentPid);
              }
            }
            unavailable('request_auth_capability_activation_failed');
          }
        } finally {
          if (!accountContextRetained) await releaseSessionAccountContext(accountContext);
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
      await runtimeRegistryLease?.release().catch(() => undefined);
    }
  };
  let queueHostedWebStaticAssetSync: (
    reason: HostedWebStaticAssetSyncReason,
  ) => Promise<void> = async () => {};
  const persistedConnectedServiceSwitchSessionMetadataBySessionId = new Map<
    string,
    Promise<Record<string, unknown> | null>
  >();
  const forgetPersistedConnectedServiceSwitchSessionMetadata = (
    sessionIdRaw: string,
  ): void => {
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
    if (
      !metadataRaw ||
      typeof metadataRaw !== 'object' ||
      Array.isArray(metadataRaw)
    ) {
      persistedConnectedServiceSwitchSessionMetadataBySessionId.delete(
        sessionId,
      );
      return;
    }
    persistedConnectedServiceSwitchSessionMetadataBySessionId.set(
      sessionId,
      Promise.resolve(metadataRaw as Record<string, unknown>),
    );
  };
  const disconnectedTerminalHostCandidates = [
    ...(params.startupTerminalRecovery?.disconnectedTerminalHostCandidates ??
      []),
  ];
  const unresolvedTerminalHostSessionIds = new Set(
    params.startupTerminalRecovery?.unresolvedTerminalHostSessionIds ?? [],
  );
  const disconnectedTerminalHostResultsBySessionId = new Map<
    string,
    DisconnectedTerminalHostSupervisionResult
  >();
  const terminalizedDisconnectedTerminalHostIds = new Set<string>();
  const registerDisconnectedTerminalHostCandidate = (
    candidate: DisconnectedTerminalHostCandidate,
  ): void => {
    disconnectedTerminalHostResultsBySessionId.delete(candidate.sessionId);
    terminalizedDisconnectedTerminalHostIds.delete(candidate.attachmentId);
    unresolvedTerminalHostSessionIds.delete(candidate.sessionId);
    for (
      let index = disconnectedTerminalHostCandidates.length - 1;
      index >= 0;
      index -= 1
    ) {
      if (
        disconnectedTerminalHostCandidates[index]?.sessionId ===
        candidate.sessionId
      ) {
        disconnectedTerminalHostCandidates.splice(index, 1);
      }
    }
    disconnectedTerminalHostCandidates.push(candidate);
  };
  const retireTerminalControlServiceabilityForCurrentAccount = async (
    input: Omit<
      Parameters<typeof retireExactTerminalControlServiceability>[0],
      'credentials' | 'attachmentId' | 'expectedRunner' | 'terminalMode'
    > & TerminalControlServiceabilityRetirementTarget & Readonly<{ metadataContext?: StopSessionOptions['metadataContext'] }>,
    retainedAttribution?: TrackedSession['requesterWorkAttributionV1'],
  ) => {
    if (input.metadataContext) {
      const { metadataContext, ...target } = input;
      return await retireExactTerminalControlServiceability({ ...target, ...metadataContext });
    }
    return await withSessionStopMetadataContext(input.sessionId, context =>
      retireExactTerminalControlServiceability({ ...input, ...context,
        currentness: { ...input.currentness, ...context.currentness, assertCurrent: () => {
          input.currentness?.assertCurrent?.();
          context.currentness?.assertCurrent?.();
        } },
      }), retainedAttribution);
  };
  const withSessionStopMetadataContext = async <T>(
    sessionId: string,
    operation: (context: NonNullable<StopSessionOptions['metadataContext']>) => Promise<T>,
    retainedAttribution?: TrackedSession['requesterWorkAttributionV1'],
    signal?: AbortSignal,
  ): Promise<T> => {
    const tracked = findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), sessionId);
    const attribution = retainedAttribution ?? tracked?.requesterWorkAttributionV1 ?? tracked?.spawnOptions?.requesterWorkAttributionV1;
    // Stop writes Account metadata; it must not construct Settings, secrets or
    // Connected Accounts just to stop this daemon Account's admitted runner.
    // Attribution selects credentials, while Home and the tuple writer still
    // authorize the mutation and verify encryption currentness.
    if (attribution && attribution.accountId === params.externalActionAccountId
      && attribution.serverId === params.serverId && attribution.machineId === params.machineId) {
      return await runWithServerHttpBaseUrl(params.serverBaseUrl, () => operation({
        credentials: params.credentials,
        currentness: { ...(signal ? { signal } : {}), assertCurrent: () => {
          signal?.throwIfAborted();
          if (controlRuntimeResourcesDisposed || isRuntimePublicationQuiescing()
            || configuration.activeServerId !== params.serverId) throw new Error('requester_session_not_current');
        } },
      }));
    }
    return await withSessionAccountContext(sessionId, async context => {
      await assertSessionAccountCurrent(sessionId, context);
      return await withSessionAccountHome(context, () => operation({
        credentials: context?.bootstrap.credentials ?? params.credentials,
        currentness: { ...(signal ? { signal } : {}), ...(context ? { verifyCurrent: () => context.isCurrent(signal) } : {}) },
      }));
    }, retainedAttribution, signal);
  };
  const retireDisconnectedTerminalHostCandidate = async (
    input: Readonly<{
      sessionId: string;
      attachmentId?: string;
    }>,
  ): Promise<void> => {
    disconnectedTerminalHostResultsBySessionId.delete(input.sessionId);
    const markerPids: number[] = [];
    for (
      let index = disconnectedTerminalHostCandidates.length - 1;
      index >= 0;
      index -= 1
    ) {
      const candidate = disconnectedTerminalHostCandidates[index];
      if (!candidate || candidate.sessionId !== input.sessionId) continue;
      if (input.attachmentId && candidate.attachmentId !== input.attachmentId)
        continue;
      terminalizedDisconnectedTerminalHostIds.add(candidate.attachmentId);
      markerPids.push(candidate.pid);
      disconnectedTerminalHostCandidates.splice(index, 1);
    }
    await Promise.all(
      markerPids.map(async (pid) => {
        await removeSessionMarker(pid).catch((error) => {
          logger.debug(
            '[DAEMON RUN] Retired terminal host but failed to remove its disconnected marker',
            {
              sessionId: input.sessionId,
              pid,
              error,
            },
          );
        });
      }),
    );
  };
  const disconnectedTerminalHostResumeLifecycle =
    createDisconnectedTerminalHostResumeLifecycle({
      unresolvedTerminalHostSessionIds,
      clearUnresolvedTerminalHostSession: (sessionId) => {
        unresolvedTerminalHostSessionIds.delete(sessionId);
      },
      findDisconnectedCandidate: (sessionId) =>
        disconnectedTerminalHostCandidates.find(
          (candidate) =>
            candidate.sessionId === sessionId &&
            !terminalizedDisconnectedTerminalHostIds.has(
              candidate.attachmentId,
            ),
        ) ?? null,
      resolveResumeGateForCandidate: async (candidate) => {
        const result = await superviseDisconnectedTerminalHost(candidate);
        if (
          result.state !== 'recoverable_unservable' ||
          result.reason !== 'runner_absent' ||
          candidate.controlDescriptorAvailable !== true
        ) {
          return resolveDisconnectedTerminalHostResumeGate(result);
        }
        // Selection reads the captured runtime, not today's Account default.
        // The retained host and native identity are still admitted by the
        // selected runtime's existing endpoint/terminal recovery owners.
        const selected = await resolveTrackedSessionTerminalPresentation(
          {
            pid: candidate.pid,
            startedBy: 'daemon',
            happySessionId: candidate.sessionId,
            spawnOptions: candidate.spawnOptions,
            happySessionMetadataFromLocalWebhook: candidate.metadata,
          },
          candidate.handle.kind,
        );
        return resolveDisconnectedTerminalHostResumeGate(result, {
          ...selected,
          controlDescriptorAvailable: candidate.controlDescriptorAvailable,
        });
      },
      retireCandidate: retireDisconnectedTerminalHostCandidate,
    });
  const superviseDisconnectedTerminalHost = async (
    candidate: DisconnectedTerminalHostCandidate,
  ): Promise<DisconnectedTerminalHostSupervisionResult> => {
    const existing = disconnectedTerminalHostResultsBySessionId.get(
      candidate.sessionId,
    );
    if (existing) return existing;
    const adapters = (await params.loadTerminalHostAdapters?.()) ?? {};
    const result = await superviseDisconnectedTerminalHostCandidate({
      candidate,
      terminalHostAdapters: adapters,
      probeSessionServiceability: async (sessionId) =>
        await probeSessionRunnerServiceability({
          sessionId,
          trackedSessions: params.pidToTrackedSession.values(),
          probeCapability: async () =>
            await probeAlreadyRunningExistingSessionServiceability({
              sessionId,
              credentials: params.credentials,
              abortSignal: shutdownCancellationDomains.daemonWorkSignal,
              isShuttingDown: isRuntimePublicationQuiescing,
            }),
        }),
      retireExactTerminalControlServiceability: async ({
        sessionId,
        attachmentInfo,
        terminalMode,
      }) => {
        return await retireTerminalControlServiceabilityForCurrentAccount({
          sessionId,
          attachmentId: attachmentInfo.attachmentId,
          terminalMode,
        });
      },
    });
    disconnectedTerminalHostResultsBySessionId.set(candidate.sessionId, result);
    if (result.state === 'stopped')
      terminalizedDisconnectedTerminalHostIds.add(candidate.attachmentId);
    if (
      result.state === 'recoverable_unservable' ||
      result.state === 'unknown'
    ) {
      await publishCurrentTerminalControlServiceability({
        credentials: params.credentials,
        happyHomeDir: configuration.happyHomeDir,
        sessionId: candidate.sessionId,
        serviceability: result,
      }).catch((error) => {
        logger.debug(
          '[DAEMON RUN] Failed to publish disconnected terminal control serviceability',
          {
            sessionId: candidate.sessionId,
            error: serializeAxiosErrorForLog(error),
          },
        );
      });
    }
    return result;
  };
  await Promise.all(
    disconnectedTerminalHostCandidates.map(superviseDisconnectedTerminalHost),
  );
  const physicallyRetiredTerminalAttachmentIdBySessionId = new Map<
    string,
    string
  >();
  const stopSessionCore = createStopSession({
    ownerRemainder,
    pidToTrackedSession: params.pidToTrackedSession,
    retireAbsentTerminalControlServiceability: async ({ sessionId, trackedSession, metadataContext, stoppedAt }) =>
      await retireStoppedPlainRunnerControlServiceability({ sessionId, trackedSession,
        publishRetirement: expectedRunner => retireTerminalControlServiceabilityForCurrentAccount({
        sessionId,
        ...(metadataContext ? { metadataContext } : {}),
        terminalMode: 'plain',
        stoppedAt,
        expectedRunner,
      }, trackedSession.requesterWorkAttributionV1 ?? trackedSession.spawnOptions?.requesterWorkAttributionV1) }),
    retireUpstreamAuthorityBeforeProcessStop: async (pid) =>
      await retireUpstreamAuthorityBeforeProcessStop({
        pid,
        spawnResourceCleanupByPid: params.spawnResourceCleanupByPid,
      }),
    loadTerminalHostAdapters: params.loadTerminalHostAdapters,
    recoverStrandedTerminalControlServiceability: async ({
      sessionId,
      expectedAttachmentId,
      metadataContext,
      stoppedAt,
    }) =>
      await recoverStrandedTerminalControlServiceability({
        credentials: metadataContext?.credentials ?? params.credentials,
        ...(metadataContext?.currentness ? { currentness: metadataContext.currentness } : {}),
        ...(metadataContext?.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: metadataContext.resolveAuthorizationHeaders } : {}),
        currentMachineId: params.machineId,
        sessionId,
        expectedAttachmentId,
        stoppedAt,
        loadTerminalHostAdapters: async () =>
          (await params.loadTerminalHostAdapters?.()) ?? {},
        retireExactTerminalControlServiceability: async (input) =>
          await retireTerminalControlServiceabilityForCurrentAccount({ ...input, ...(metadataContext ? { metadataContext } : {}) }),
      }),
    areTrackedRunnersExited: async ({ trackedPids }) =>
      await waitForTrackedRunnerProcessesExit({
        runners: trackedPids.map((pid) => ({ pid })),
        timeoutMs: 0,
        pollIntervalMs: 0,
      }),
    waitForTrackedRunnersExit: async ({ sessionId, trackedPids }) => {
      await waitForExistingSessionExitIfStopRequested({
        sessionId,
        pidToTrackedSession: params.pidToTrackedSession,
        timeoutMs: configuration.daemonStopSessionWaitForExitMs,
        pollIntervalMs:
          configuration.daemonStopSessionWaitForExitPollIntervalMs,
        onExitObserved: (pid, exit) => onChildExited(pid, exit),
      });
      return trackedPids.every((pid) => !params.pidToTrackedSession.has(pid));
    },
    onExactTerminalAttachmentRetired: async (input) => {
      physicallyRetiredTerminalAttachmentIdBySessionId.set(
        input.sessionId,
        input.attachmentInfo.attachmentId,
      );
    },
    retireExactTerminalControlServiceability: async ({
      sessionId,
      attachmentInfo,
      terminalMode,
      metadataContext,
      stoppedAt,
    }) => {
      return await retireTerminalControlServiceabilityForCurrentAccount({
        sessionId,
        attachmentId: attachmentInfo.attachmentId,
        terminalMode,
        stoppedAt,
        ...(metadataContext ? { metadataContext } : {}),
      });
    },
  });
  const readPersistedConnectedServiceSwitchSessionMetadata = async (
    sessionIdRaw: string,
  ): Promise<Record<string, unknown> | null> => {
    const sessionId = normalizeOptionalString(sessionIdRaw);
    if (!sessionId) return null;
    return await withSessionAccountContext(sessionId, async (accountContext) => {
      if (accountContext)
        return await withSessionAccountHome(accountContext, async () => {
          const metadata =
            await resolvePersistedConnectedServiceSwitchSessionState({
              token: accountContext.bootstrap.credentials.token,
              credentials: accountContext.bootstrap.credentials,
              sessionId,
            }).then(state => state.metadata);
          await assertSessionAccountCurrent(sessionId, accountContext);
          return metadata;
        });
      const existing =
        persistedConnectedServiceSwitchSessionMetadataBySessionId.get(sessionId);
      if (existing) return await existing;

      const promise = resolvePersistedConnectedServiceSwitchSessionState({
        token: params.credentials.token,
        credentials: params.credentials,
        sessionId,
      }).then(state => state.metadata);
      persistedConnectedServiceSwitchSessionMetadataBySessionId.set(
        sessionId,
        promise,
      );
      try {
        const metadata = await promise;
        if (
          !metadata &&
          persistedConnectedServiceSwitchSessionMetadataBySessionId.get(
            sessionId,
          ) === promise
        ) {
          persistedConnectedServiceSwitchSessionMetadataBySessionId.delete(
            sessionId,
          );
        }
        return metadata;
      } catch (error) {
        if (
          persistedConnectedServiceSwitchSessionMetadataBySessionId.get(
            sessionId,
          ) === promise
        ) {
          persistedConnectedServiceSwitchSessionMetadataBySessionId.delete(
            sessionId,
          );
        }
        throw error;
      }
    });
  };

  const runSpawnSession = async (
    options: SpawnSessionOptions,
    behavior: Readonly<{
      nudgeAlreadyRunningPendingQueue: boolean;
      isLaunchAdmissionCurrent: () => boolean;
      currentResumeAdmission?: ReturnType<SessionRunnerRespawnManager['prepareFreshExplicitResumeAdmission']>;
      freshExplicitResumeAdmission?: ReturnType<SessionRunnerRespawnManager['prepareFreshExplicitResumeAdmission']>;
      managerResume?: Readonly<{ recheck: () => Promise<boolean>; clear: () => Promise<void> }>;
    }>,
  ): Promise<SpawnSessionResult> => {
    const suppliedRequesterRuntime = options.requesterSessionRuntimeContext;
    if (
      suppliedRequesterRuntime &&
      (suppliedRequesterRuntime.bootstrap !==
        options.requesterSessionBootstrap ||
        (options.existingSessionId &&
          suppliedRequesterRuntime.bootstrap.getBoundSessionId() !==
            options.existingSessionId) ||
        !(await suppliedRequesterRuntime.isCurrent()))
    )
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
        errorMessage: 'Requester Account runtime unavailable',
      };
    const requesterRuntime = options.requesterSessionBootstrap
      ? (suppliedRequesterRuntime ??
        (await params.createRequesterSessionRuntimeContext?.(
          options.requesterSessionBootstrap,
        )) ??
        null)
      : null;
    if (options.requesterSessionBootstrap && !requesterRuntime)
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
        errorMessage: 'Requester Account runtime unavailable',
      };
    const spawnParams = requesterRuntime
      ? {
          ...params,
          credentials: requesterRuntime.bootstrap.credentials,
          api: requesterRuntime.api,
          connectedServicesMaterializationBaseDir:
            requesterRuntime.connectedServicesMaterializationBaseDir,
          getConnectedServiceRefreshCoordinator: () =>
            requesterRuntime.connectedServiceRefreshCoordinator,
          getConnectedServiceQuotasCoordinator: () =>
            requesterRuntime.connectedServiceQuotasCoordinator,
          resolveManagedPurposeBindingIntent:
            requesterRuntime.resolveManagedPurposeBindingIntent,
          activateSessionPurposeBindings:
            requesterRuntime.activateSessionPurposeBindings,
          activatePurposeBindings: requesterRuntime.activatePurposeBindings,
        }
      : params;
    try {
      // Pending input may request Resume while its canonical planned
      // replacement is preparing. Retain requester admission above, then
      // rejoin that launcher without probing the retiring runner's controls.
      const existingSessionId = normalizeOptionalString(options.existingSessionId);
      if ((behavior.freshExplicitResumeAdmission || behavior.currentResumeAdmission) && existingSessionId && (
        sessionRunnerRespawnManager.hasPendingIntendedRestarts(existingSessionId)
        || [...params.pidToTrackedSession.values()].some(tracked =>
          tracked.happySessionId === existingSessionId
          && params.connectedServicesRestartRequestedPids.has(tracked.pid))
      )) {
        if (!behavior.isLaunchAdmissionCurrent()) {
          return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
            errorMessage: 'Session resume admission unavailable' };
        }
        const refusal = projectSessionRunnerLaunchAdmissionFailure(options.beforeSessionRunnerLaunch
          ? await options.beforeSessionRunnerLaunch() : true);
        if (refusal) return refusal;
        return { type: 'success', sessionId: existingSessionId };
      }
      const key = computeDaemonSpawnRequestKey(options);
      const run = async () =>
        await spawnRequestCoalescer.run(key, async () => {
          let retainedTerminalRecovery: 'adopt' | undefined;
          if (options.existingSessionId) {
            const preGateResult =
              await disconnectedTerminalHostResumeLifecycle.resolveResumePreGate(
                options.existingSessionId,
                async (sessionId) => await stopSession(sessionId, undefined, behavior.freshExplicitResumeAdmission ?? behavior.currentResumeAdmission),
              );
            if (preGateResult?.type === 'error') {
              return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: preGateResult.errorMessage,
              };
            }
            if (preGateResult?.type === 'resume') {
              retainedTerminalRecovery = preGateResult.retainedTerminalRecovery;
            }
          }
          // The caller can predate an admitted Stop. Capture after the existing
          // Stop barrier, then clear only this observed intent after exact success.
          const resumeStopMetadata = !behavior.managerResume && behavior.freshExplicitResumeAdmission && existingSessionId
            ? await resolvePersistedConnectedServiceSwitchSessionState({
                token: spawnParams.credentials.token, credentials: spawnParams.credentials, sessionId: existingSessionId,
              }).then(state => state.metadata) : null;
          const completeResume = async (result: SpawnSessionResult): Promise<SpawnSessionResult> => {
            if (result.type === 'success' && result.sessionId === existingSessionId
              && behavior.managerResume && behavior.isLaunchAdmissionCurrent()) {
              if (!await behavior.managerResume.recheck()) return { type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                errorMessage: 'Session manager Resume authority changed; Stop hold retained' };
              await behavior.managerResume.clear();
            }
            if (result.type === 'success' && result.sessionId === existingSessionId
              && existingSessionId && resumeStopMetadata && behavior.isLaunchAdmissionCurrent()
              && readSessionExplicitStopV1FromMetadata(resumeStopMetadata)) {
              await clearSessionExplicitStopIntentAfterResume({ credentials: spawnParams.credentials,
                sessionId: existingSessionId, metadata: resumeStopMetadata });
            }
            return result;
          };
          if (options.existingSessionId) {
            const sessionId = normalizeOptionalString(
              options.existingSessionId,
            );
            const tracked = [...spawnParams.pidToTrackedSession.values()].find(
              (candidate) => candidate.happySessionId === sessionId,
            );
            if (sessionId && tracked) {
              const metadata =
                (await resolvePersistedConnectedServiceSwitchSessionState({
                  token: spawnParams.credentials.token,
                  credentials: spawnParams.credentials,
                  sessionId,
                }).then(state => state.metadata).catch(() => null)) ??
                tracked.happySessionMetadataFromLocalWebhook ??
                null;
              const managed =
                readSessionDirectoryKind(metadata) === 'managed' ||
                tracked.spawnOptions?.directoryKind === 'managed' ||
                options.directoryKind === 'managed';
              if (managed) {
                const directory =
                  resolveSessionMachineWorkspacePath({
                    metadata: metadata ?? {},
                    currentMachineId: spawnParams.machineId,
                    candidatePath:
                      metadata?.path ?? tracked.spawnOptions?.directory,
                  }) ?? '';
                const proof =
                  await createManagedSessionDirectories().resolveForSession({
                    sessionId,
                    path: directory,
                    sessionCreationTag:
                      tracked.spawnOptions?.sessionCreationTag,
                  });
                if (!proof.ok) {
                  const missingDirectoryResult = {
                    type: 'error' as const,
                    errorCode:
                      SPAWN_SESSION_ERROR_CODES.SESSION_DIRECTORY_MISSING,
                    errorMessage:
                      'The session folder is no longer available on this machine.',
                  };
                  if (options.approvedNewDirectoryCreation !== true)
                    return missingDirectoryResult;
                  // Consent admits a new launch, not the old process whose cwd is missing.
                  // Preserve exact-process custody until the normal Stop owner retires it.
                  const stopped = await stopSession(sessionId, {
                    expectedTrackedRunner: {
                      tracked,
                      sessionRunnerPid: tracked.sessionRunnerPid,
                      processStartTimeMs: tracked.processStartTimeMs,
                      processCommandHash: tracked.processCommandHash,
                    },
                  });
                  if (
                    !isTerminalHostPhysicallyRetiredStopResult(stopped) &&
                    stopped.status !== 'not_found'
                  ) {
                    return missingDirectoryResult;
                  }
                  if (
                    [...spawnParams.pidToTrackedSession.values()].some(
                      (candidate) => candidate.happySessionId === sessionId,
                    )
                  ) {
                    return missingDirectoryResult;
                  }
                }
              }
            }
          }
          const existingSessionPreGate =
            await resolveExistingSessionSpawnPreGate({
              existingSessionId: options.existingSessionId,
              pidToTrackedSession: spawnParams.pidToTrackedSession,
              probeSessionRunnerPresence: async (sessionId) => await probeSessionRunnerPresence({
                sessionId, trackedSessions: spawnParams.pidToTrackedSession.values(),
              }),
              pendingSessionStartup: {
                pidToAwaiter: spawnParams.pidToAwaiter,
                machineId: spawnParams.machineId,
                happyHomeDir: configuration.happyHomeDir,
                readSessionMetadata: async (sessionId) => {
                  const context = await resolveExistingSessionAttachContext({
                    sessionId, token: spawnParams.credentials.token, credentials: spawnParams.credentials,
                  });
                  if (!context.ok) throw new Error(context.reason);
                  return context.metadata;
                },
              },
              waitForExitTimeoutMs:
                configuration.daemonSpawnExistingSessionWaitForExitMs,
              waitForExitPollIntervalMs:
                configuration.daemonSpawnExistingSessionWaitForExitPollIntervalMs,
              logDebug: (message, payload) => logger.debug(message, payload),
              logWarn: (message, payload) => logger.infoFile(message, payload),
              onAlreadyRunning: async (sessionId) => {
                const serviceability =
                  await probeAlreadyRunningExistingSessionServiceability({
                    sessionId,
                    credentials: spawnParams.credentials,
                    abortSignal: shutdownCancellationDomains.daemonWorkSignal,
                    isShuttingDown: isRuntimePublicationQuiescing,
                  });
                try {
                  await publishCurrentTerminalControlServiceability({
                    credentials: spawnParams.credentials,
                    happyHomeDir: configuration.happyHomeDir,
                    sessionId,
                    serviceability,
                  });
                } catch {
                  logger.debug(
                    '[DAEMON RUN] Failed to publish resume target terminal control serviceability',
                  );
                }
                const resumeDecision = resolveSessionRunnerResumeDecision({
                  state: 'runner_present',
                  control: serviceability,
                });
                if (resumeDecision.action === 'wait_for_exit') {
                  return {
                    action: 'wait_for_exit',
                    timeoutResult: {
                      type: 'error',
                      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                      runtimeFailureReason: resumeDecision.reason,
                      errorMessage:
                        serviceability.state === 'unknown'
                          ? 'The existing session runtime could not be verified. Retry resume after connectivity recovers.'
                          : 'The existing session process is alive but its controls are unavailable. Stop it explicitly before retrying resume.',
                    },
                  };
                }
                if (resumeDecision.action === 'fence') {
                  return {
                    action: 'error',
                    result: {
                      type: 'error',
                      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                      runtimeFailureReason: serviceability.state === 'servable' ? undefined : serviceability.reason,
                      errorMessage:
                        serviceability.state === 'unknown'
                          ? 'The existing session runtime could not be verified. Retry resume after connectivity recovers.'
                          : 'The existing session process is alive but its controls are unavailable. Stop it explicitly before retrying resume.',
                    },
                  };
                }
                await refreshTrackedSessionsRuntimeSnapshot({
                  sessionId,
                  incomingOptions: options,
                  trackedSessions: spawnParams.pidToTrackedSession.values(),
                  readPersistedSessionMetadata:
                    readPersistedConnectedServiceSwitchSessionMetadata,
                });
                await spawnParams.onAlreadyRunningSessionAdopted?.(sessionId);
                if (behavior.nudgeAlreadyRunningPendingQueue) {
                  const nudgeResult =
                    await nudgeAlreadyRunningExistingSessionPendingQueue({
                      sessionId,
                      credentials: spawnParams.credentials,
                      abortSignal: shutdownCancellationDomains.daemonWorkSignal,
                      isShuttingDown: isRuntimePublicationQuiescing,
                    });
                  if (
                    'type' in nudgeResult &&
                    nudgeResult.type === 'unavailable'
                  ) {
                    logger.warn(
                      '[DAEMON RUN] Resume target is alive but pending queue materialization probe failed; adopting existing runner and leaving nudge failure advisory',
                    );
                  }
                }
                return { action: 'use_existing' };
              },
            });
          if (existingSessionPreGate.shortCircuitResult) {
            return await completeResume(existingSessionPreGate.shortCircuitResult);
          }

          const spawnResult = await spawnConcurrencyGate.run(
            async () =>
              await executeSpawnSessionRequest({
                agentIsolation: params.agentIsolation,
                signal: shutdownCancellationDomains.daemonWorkSignal,
                readMachineResourcesPolicy: params.readMachineResourcesPolicy,
                readSpawnFailureLimits: params.readSpawnFailureLimits,
                checkRegistryUpdates: params.checkRegistryUpdates,
                options,
                ...(requesterRuntime
                  ? { requesterSessionRuntimeContext: requesterRuntime }
                  : {}),
                retainedTerminalRecovery,
                credentials: spawnParams.credentials,
                deviceLocalSecretStorage: spawnParams.deviceLocalSecretStorage,
                api: spawnParams.api,
                connectedServicesMaterializationBaseDir:
                  spawnParams.connectedServicesMaterializationBaseDir,
                connectedServiceRefreshCoordinator:
                  spawnParams.getConnectedServiceRefreshCoordinator(),
                connectedServiceQuotasCoordinator:
                  spawnParams.getConnectedServiceQuotasCoordinator(),
                connectedServiceRuntimeRegistry:
                  requesterRuntime?.connectedServiceRuntimeRegistry ??
                  connectedServiceRuntimeRegistry,
                connectedAccountRequestAuthRegistry,
                connectedAccountRequestAuthHttpPort:
                  requireConnectedAccountRequestAuthHttpPort(),
                resolveSessionSyncPendingInputServerContractResult: () =>
                  spawnParams
                    .getApiMachineForSessions()
                    ?.getSessionSyncPendingInputServerContractResult() ?? null,
                ...(spawnParams.pluginChangeService?.controlPluginDevelopment
                  ? {
                      controlPluginDevelopment:
                        spawnParams.pluginChangeService
                          .controlPluginDevelopment,
                    }
                  : {}),
                providerAccountUsageStore:
                  requesterRuntime?.providerAccountUsageStore ??
                  providerAccountUsageStore,
                authGroupSwitchCoordinator:
                  requesterRuntime?.authGroupSwitchCoordinator ??
                  connectedServiceAuthGroupPreTurnSwitchCoordinator,
                predictiveSwitchGuard:
                  requesterRuntime?.predictiveSwitchGuard ??
                  connectedServicePredictiveSwitchGuard ??
                  undefined,
                repairMissingConnectedServiceMaterializationIdentityForSpawn:
                  async (input) => {
                    const repair =
                      await repairMissingConnectedServiceMaterializationIdentityForSpawn(
                        {
                          token: spawnParams.credentials.token,
                          credentials: spawnParams.credentials,
                          sessionId: input.sessionId,
                          agentId: input.agentId,
                          connectedServices: input.connectedServices,
                          vendorResumeId: input.vendorResumeId,
                        },
                      );
                    if (!repair) return null;
                    return {
                      identity: repair.identity,
                      persistAfterMaterialization: async () => {
                        await repair.persistAfterMaterialization();
                        forgetPersistedConnectedServiceSwitchSessionMetadata(
                          input.sessionId,
                        );
                      },
                    };
                  },
                pidToTrackedSession: spawnParams.pidToTrackedSession,
                pidToAwaiter: spawnParams.pidToAwaiter,
                pidToSpawnResultResolver: spawnParams.pidToSpawnResultResolver,
                pidToSpawnWebhookTimeout: spawnParams.pidToSpawnWebhookTimeout,
                persistedTakeoverAdmissionWaiter:
                  spawnParams.persistedTakeoverAdmissionWaiter,
                resolveCanonicalTrackedSessionId,
                onChildExited,
                onTrackedSessionRegistered: () =>
                  notifySessionLiveWorkChanged(),
                spawnResourceCleanupByPid:
                  spawnParams.spawnResourceCleanupByPid,
                sessionAttachCleanupByPid:
                  spawnParams.sessionAttachCleanupByPid,
                processEnv: spawnParams.processEnv,
                resolveProvidersFeatureEnabled: async () => {
                  const serverSnapshot =
                    await (spawnParams.resolveServerFeaturesSnapshot?.() ??
                      fetchServerFeaturesSnapshot({
                        serverUrl: resolveServerHttpBaseUrl(),
                      }));
                  return (
                    resolveCliFeatureDecision({
                      featureId: 'providers',
                      env: spawnParams.processEnv,
                      ...(serverSnapshot ? { serverSnapshot } : {}),
                    }).state === 'enabled'
                  );
                },
                ...(spawnParams.resolveManagedPurposeBindingIntent
                  ? {
                      resolveManagedPurposeBindingIntent:
                        spawnParams.resolveManagedPurposeBindingIntent,
                    }
                  : {}),
                ...(spawnParams.activateSessionPurposeBindings
                  ? {
                      activateSessionPurposeBindings:
                        spawnParams.activateSessionPurposeBindings,
                    }
                  : {}),
                ...(spawnParams.activatePurposeBindings
                  ? {
                      activatePurposeBindings:
                        spawnParams.activatePurposeBindings,
                    }
                  : {}),
              }),
            shutdownCancellationDomains.daemonWorkSignal,
          );
          // A newly started runner refreshes and drains Pending itself. Its
          // canonical startup acknowledgement is sufficient; a redundant RPC
          // capability lookup must not turn accepted startup into a failure.
          if (spawnResult.type === 'success' && options.existingSessionId) {
            behavior.freshExplicitResumeAdmission?.complete();
          }
          return await completeResume(spawnResult);
        }, behavior.isLaunchAdmissionCurrent);
      return requesterRuntime
        ? await runWithServerHttpBaseUrl(
            requesterRuntime.bootstrap.serverHttpBaseUrl,
            run,
          )
        : await run();
    } catch (error) {
      if (shutdownCancellationDomains.daemonWorkSignal.aborted
        && error === shutdownCancellationDomains.daemonWorkSignal.reason) {
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
          errorMessage: 'Daemon is shutting down',
        };
      }
      logger.warn('[DAEMON RUN] Failed before spawn session work started', {
        hasExistingSessionId:
          typeof options.existingSessionId === 'string' &&
          options.existingSessionId.trim().length > 0,
        hasResume:
          typeof options.resume === 'string' &&
          options.resume.trim().length > 0,
        backendTargetKind:
          resolveConcreteBackendTargetRefV2(options.backendTarget)?.kind ??
          null,
      });
      throw error;
    } finally {
      // The existing tracked Session owns accepted runtime resources. A
      // refused/coalesced/already-running invocation has no such owner.
      if (requesterRuntime) await releaseUnretainedRequesterSessionRuntimeContext(requesterRuntime,
        [...params.pidToTrackedSession.values()].map(tracked => tracked.requesterSessionRuntimeContext));
    }
  };
  const spawnSessionWithAdmission = async (
    options: SpawnSessionOptions,
    behavior: Readonly<{ freshExplicitResume: boolean; freshLaunchRequest?: boolean; completingPlannedRestart?: boolean;
      pendingActivation?: PendingSessionResumeAdmission }>,
  ): Promise<SpawnSessionResult> => {
    const canCompletePlannedRestart = () => behavior.completingPlannedRestart === true
      && !controlRuntimeResourcesDisposed
      && !shutdownCancellationDomains.daemonWorkSignal.aborted;
    const mayCompletePlannedRestart = canCompletePlannedRestart();
    if (params.isShuttingDown?.() === true && !mayCompletePlannedRestart) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
        errorMessage: 'Daemon is shutting down',
      };
    }
    const existingSessionId = normalizeOptionalString(
      options.existingSessionId,
    );
    const automaticExistingSessionResume = !behavior.freshExplicitResume && Boolean(existingSessionId);
    const pendingActivation = behavior.pendingActivation;
    const execution = options.executionAuthorization;
    if (pendingActivation && (!automaticExistingSessionResume || execution?.provenance !== 'user_request'
      || execution.requestId !== pendingActivation.requestId || execution.requestedAt !== pendingActivation.requestedAt)) {
      return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
        errorMessage: 'Pending resume admission does not match the original input' };
    }
    // A Stop can still be persisting its hold. Capture explicit Resume intent
    // only after that same owner has completed, rather than fencing it as stale.
    if (behavior.freshExplicitResume && existingSessionId) {
      await disconnectedTerminalHostResumeLifecycle.waitForStop(existingSessionId);
    }
    const resumeContext = options.resumeActionContext;
    const managerContext = resumeContext?.actionCaller?.kind === 'session' ? resumeContext : undefined;
    let managerResume: Readonly<{ recheck: () => Promise<boolean>; clear: () => Promise<void> }> | undefined;
    if (managerContext && existingSessionId) {
      const requester = readRequesterAccountActionContext(managerContext.externalActionExecutionAuthorization);
      const binding = requester?.authorization.binding;
      const installation = readInstallationIdentityIfExistsSync();
      const refuseManager = () => ({ type: 'error' as const, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'Current manager Resume authority unavailable; Stop hold retained' });
      let origin: ReturnType<typeof resolveSessionRoleRpcOrigin>;
      try { origin = resolveSessionRoleRpcOrigin(managerContext); } catch { return refuseManager(); }
      if (!requester || !binding || !installation || binding.actionId !== 'session.open'
        || binding.requestId !== managerContext.actionRequestId || binding.machineId !== params.machineId
        || binding.installationId !== installation.installationId
        || binding.accountId !== (options.requesterSessionBootstrap?.attribution.accountId ?? externalActionAccountId)
        || !isDeepStrictEqual(binding.sessionActionOrigin, origin)) return refuseManager();
      const resolveAuthorizationHeaders = (request: Parameters<NonNullable<Parameters<typeof updateSessionMetadataWithRetry>[0]['resolveAuthorizationHeaders']>>[0]) => {
        const result = resolveExternalActionServerRequestHeaders({ context: managerContext, effectActionId: 'session.open',
          ...request, daemonToken: requester.credentials.token, serverIdentityId: binding.serverIdentityId,
          privateKey: installation.privateKey, installationId: installation.installationId });
        if (!result.ok) throw new Error('Manager Resume metadata authorization unavailable');
        return result.headers;
      };
      const readAdmission = async () => await runWithServerHttpBaseUrl(requester.serverHttpBaseUrl, async () => {
        if (managerContext.signal?.aborted || !await requester.isCurrent()) return null;
        const machineOrigin = await params.resolveCurrentMachineExecutionOriginContext?.(managerContext.signal);
        if (machineOrigin?.machineId !== params.machineId || machineOrigin.serverIdentityId !== binding.serverIdentityId) return null;
        const [rawSession, encryption] = await Promise.all([
          fetchSessionByIdCompat({ reason: 'session-control', token: requester.credentials.token, sessionId: existingSessionId, resolveAuthorizationHeaders,
            ...(managerContext.signal ? { signal: managerContext.signal } : {}) }),
          fetchAccountEncryptionCurrentness({ token: requester.credentials.token,
            authorizationHeaders: resolveAuthorizationHeaders({ method: 'GET', path: '/v1/account/encryption/currentness' }) }),
        ]);
        if (!rawSession || rawSession.id !== existingSessionId || rawSession.effectiveAccess?.level !== 'owner') return null;
        const metadata = tryReadSessionMetadataRecord({ rawSession, credentials: requester.credentials, accountEncryptionMode: encryption.mode });
        const owner = resolveSessionOwningMachineId({ rawSession, credentials: requester.credentials, accountEncryptionMode: encryption.mode });
        if (!metadata || !owner.ok || owner.machineId !== params.machineId
          || resolveSessionResumeControlIntent({ rawSession, metadata, actionContext: managerContext }) !== 'manager'
          || !await requester.isCurrent()) return null;
        return metadata;
      });
      const metadata = await readAdmission().catch(() => null);
      if (!metadata) return refuseManager();
      const observedStop = readSessionExplicitStopV1FromMetadata(metadata);
      const authorityCurrent = async () => (await readAdmission().catch(() => null)) !== null;
      const recheck = async () => {
        const fresh = await readAdmission().catch(() => null);
        if (!fresh) return false;
        return isDeepStrictEqual(readSessionExplicitStopV1FromMetadata(fresh), observedStop);
      };
      managerResume = { recheck, clear: async () => await runWithServerHttpBaseUrl(requester.serverHttpBaseUrl,
        async () => await clearSessionExplicitStopIntentAfterResume({ credentials: requester.credentials,
          sessionId: existingSessionId, metadata, resolveAuthorizationHeaders, currentness: { verifyCurrent: authorityCurrent,
            ...(managerContext.signal ? { signal: managerContext.signal } : {}) } })) };
    }
    // Public spawn is a newly admitted launch request, including online-only
    // input wake (which has no unattended Pending authorization). Observe the
    // prior physical Stop without promoting it to person Resume: persisted
    // holds, requester custody and any later Stop still reject launch below.
    // Retained internal recovery must instead supply the Pending owner's
    // freshly verified demand before it may cross an earlier physical Stop.
    const currentResumeAdmission = automaticExistingSessionResume && (pendingActivation || behavior.freshLaunchRequest)
      ? sessionRunnerRespawnManager.prepareFreshExplicitResumeAdmission(existingSessionId!) : undefined;
    const automaticResumeAdmission = automaticExistingSessionResume && !currentResumeAdmission
      ? sessionRunnerRespawnManager.prepareAutomaticResumeAdmission(existingSessionId!)
      : undefined;
    const freshExplicitResumeAdmission =
      behavior.freshExplicitResume && existingSessionId
        ? sessionRunnerRespawnManager.prepareFreshExplicitResumeAdmission(
            existingSessionId,
          )
        : undefined;
    const isLaunchAdmissionCurrent = () => (!mayCompletePlannedRestart || canCompletePlannedRestart())
      && (automaticResumeAdmission?.() ?? true)
      && (currentResumeAdmission?.isCurrent() ?? true)
      && (freshExplicitResumeAdmission?.isCurrent() ?? true);
    const result = await runSpawnSession(
      {
        ...options,
        machineId: params.machineId,
        ...(mayCompletePlannedRestart || automaticExistingSessionResume || freshExplicitResumeAdmission
          ? {
              beforeSessionRunnerLaunch: async () => {
                if (!isLaunchAdmissionCurrent()) return false;
                if (automaticExistingSessionResume && existingSessionId) {
                  const state = await resolvePersistedConnectedServiceSwitchSessionState({
                    token: (options.requesterSessionBootstrap?.credentials ?? params.credentials).token,
                    credentials: options.requesterSessionBootstrap?.credentials ?? params.credentials,
                    sessionId: existingSessionId,
                  }).catch(() => null);
                  if (!state) return false;
                  const admission = resolveSessionAutoResumeAdmissionV1({ metadata: state.metadata,
                    archivedAt: state.archivedAt, machineAvailable: true, authorityAvailable: state.metadata != null });
                  if (admission !== 'eligible') return { kind: 'launch_error' as const,
                    code: admission, message: 'Automatic Session resume refused' };
                }
                if (options.beforeSessionRunnerLaunch) {
                  const admission = await options.beforeSessionRunnerLaunch();
                  if (admission !== true) return admission;
                }
                if (managerResume && !await managerResume.recheck()) return false;
                return isLaunchAdmissionCurrent();
              },
            }
          : {}),
      },
      {
        nudgeAlreadyRunningPendingQueue: true,
        isLaunchAdmissionCurrent,
        ...(currentResumeAdmission ? { currentResumeAdmission } : {}),
        ...(freshExplicitResumeAdmission
          ? { freshExplicitResumeAdmission }
          : {}),
        ...(managerResume ? { managerResume } : {}),
      },
    );
    if (result.type === 'success') {
      currentResumeAdmission?.complete();
      void queueHostedWebStaticAssetSync('session_spawned');
    }
    return result;
  };
  const spawnSession = async (
    options: SpawnSessionOptions,
  ): Promise<SpawnSessionResult> =>
    await spawnSessionWithAdmission(options, {
      freshLaunchRequest: true,
      freshExplicitResume: options.resumeActionContext?.actionCaller?.kind === 'session'
        || options.executionAuthorization?.provenance === 'user_request',
    });
  const spawnSessionForInternalResume = async (
    options: SpawnSessionOptions,
    pendingActivation?: PendingSessionResumeAdmission,
  ): Promise<SpawnSessionResult> =>
    await spawnSessionWithAdmission(options, { freshExplicitResume: false, ...(pendingActivation ? { pendingActivation } : {}) });

  const temporaryThrottleResumeSnapshotsBySessionId = new Map<
    string,
    TrackedSession
  >();
  const findTemporaryThrottleTrackedSession = (
    sessionId: string,
  ): TrackedSession | null => {
    const normalizedSessionId = normalizeOptionalString(sessionId);
    if (!normalizedSessionId) return null;
    return (
      findTrackedSessionByHappySessionId(
        params.pidToTrackedSession.values(),
        normalizedSessionId,
      ) ??
      temporaryThrottleResumeSnapshotsBySessionId.get(normalizedSessionId) ??
      null
    );
  };
  // RD-REC-16 port: the throttle intent is durable but the in-memory resume snapshot is
  // not (and must not be persisted: spawn options can carry secret environment values).
  // After a daemon restart, rebuild the resume source from persisted session metadata
  // instead of dead-lettering the hydrated intent.
  const resolveTemporaryThrottleResumeSource = async (
    sessionId: string,
  ): Promise<TemporaryThrottleResumeSource | null> => {
    return await withSessionAccountContext(sessionId, async (accountContext) =>
      await withSessionAccountHome(accountContext, async () => {
        const tracked = findTemporaryThrottleTrackedSession(sessionId);
        if (tracked) return tracked;
        const credentials =
          accountContext?.bootstrap.credentials ?? params.credentials;
        const token = normalizeOptionalString(credentials.token);
        if (!token) return null;
        const accountEncryptionCurrentness =
          await fetchAccountEncryptionCurrentness({ token });
        return await resolveInactiveTemporaryThrottleResumeSource({
          sessionId,
          fallbackMachineId: params.machineId,
          fetchSession: async (id) =>
            await fetchSessionByIdCompat({ reason: 'session-control', token, sessionId: id }),
          decryptSessionMetadata: (rawSession) =>
            tryReadSessionMetadataRecord({
              rawSession,
              credentials,
              accountEncryptionMode: accountEncryptionCurrentness.mode,
            }),
        });
      }),
    );
  };
  const temporaryThrottleContinuationMessageDispatcher =
    createConnectedServiceContinuationMessageDispatcher({
      credentials: params.credentials,
      sendMessage: async (input) => {
        return await withSessionAccountContext(input.idOrPrefix, async (accountContext) =>
          await withSessionAccountHome(accountContext, async () => {
            await assertSessionAccountCurrent(input.idOrPrefix, accountContext);
            return await sendSessionMessage({
              ...input,
              credentials:
                accountContext?.bootstrap.credentials ?? params.credentials,
            });
          }),
        );
      },
    });
  const temporaryThrottleScheduler =
    new ConnectedServiceTemporaryThrottleRetryScheduler({
      nowMs: () => Date.now(),
      onStateChange: async (sessionId, intent, previous) => {
        if (intent?.scope?.kind === 'run' || previous?.scope?.kind === 'run') return;
        try {
          await withSessionAccountContext(sessionId, async (accountContext) =>
            await withSessionAccountHome(accountContext, async () => {
              const credentials =
                accountContext?.bootstrap.credentials ?? params.credentials;
              const stage = (
                accountContext?.daemonSessionMutationCustody ??
                params.daemonSessionMutationCustody
              ).stage;
              if (!stage)
                throw new Error(
                  'temporary_throttle_projection_custody_unavailable',
                );
              const [rawSession, currentness] = await Promise.all([
                fetchSessionByIdCompat({ reason: 'session-control', token: credentials.token, sessionId }),
                fetchAccountEncryptionCurrentness({ token: credentials.token }),
              ]);
              if (!rawSession || rawSession.id !== sessionId) return;
              const fetchedMetadata = tryReadSessionMetadataRecord({
                rawSession,
                credentials,
                accountEncryptionMode: currentness.mode,
              });
              if (!fetchedMetadata) return;
              // Custody may still be delivering the prior state. Clear that exact
              // staged value, not an older value returned by the Session fetch.
              const currentMetadata =
                !intent && previous
                  ? projectTemporaryThrottleRecoveryMetadata({}, previous, null)
                  : fetchedMetadata;
              const nextMetadata = projectTemporaryThrottleRecoveryMetadata(
                currentMetadata,
                intent,
                previous,
              );
              if (nextMetadata === currentMetadata) return;
              await persistUsageLimitRecoveryFieldDurably({
                sessionId,
                currentMetadata,
                nextMetadata,
                stageUsageLimitRecoveryMutation: async (mutation) => {
                  await assertSessionAccountCurrent(sessionId, accountContext);
                  await stage({ mutation, rawSession });
                },
              });
            }),
          );
        } catch {
          logger.debug(
            '[DAEMON RUN] Temporary throttle recovery presentation could not be staged',
          );
        }
      },
      baseBackoffMs: resolvePositiveIntEnv(
        params.processEnv
          .HAPPIER_CONNECTED_SERVICES_TEMPORARY_THROTTLE_BASE_BACKOFF_MS,
        1_000,
        { min: 100, max: 60_000 },
      ),
      maxBackoffMs: resolvePositiveIntEnv(
        params.processEnv
          .HAPPIER_CONNECTED_SERVICES_TEMPORARY_THROTTLE_MAX_BACKOFF_MS,
        60_000,
        { min: 1_000, max: 10 * 60_000 },
      ),
      maxAttempts: resolvePositiveIntEnv(
        params.processEnv
          .HAPPIER_CONNECTED_SERVICES_TEMPORARY_THROTTLE_MAX_ATTEMPTS,
        3,
        { min: 1, max: 100 },
      ),
      resume: async (intent, { sessionId }) => {
        return await withSessionAccountContext(sessionId, async (accountContext) =>
          await withSessionAccountHome(accountContext, async () => {
            const tracked = await resolveTemporaryThrottleResumeSource(sessionId);
            if (!tracked) {
              temporaryThrottleResumeSnapshotsBySessionId.delete(sessionId);
              throw new Error('temporary_throttle_session_not_found');
            }
            if (!intent.continuation) {
              return {
                status: 'terminal' as const,
                lastError: 'temporary_throttle_continuation_identity_missing',
              };
            }
            const seed = buildTrackedExistingSessionResumeSeed({
              tracked,
              sessionId,
            });
            if (!seed) {
              throw new Error('temporary_throttle_resume_options_missing');
            }
            const respawnOptions =
              await resolveRespawnSessionOptionsWithRuntimeSnapshot({
                sessionId,
                spawnOptions: seed.spawnOptions,
                vendorResumeId: seed.vendorResumeId,
                defaultOptions: seed.defaultOptions,
                readPersistedSessionMetadata:
                  readPersistedConnectedServiceSwitchSessionMetadata,
              });
            await assertSessionAccountCurrent(sessionId, accountContext);
            const result = await spawnSessionForInternalResume(respawnOptions);
            if (result.type === 'success') {
              const continuationResult =
                await temporaryThrottleContinuationMessageDispatcher.enqueueInterruptedOriginContinuation(
                  {
                    sessionId,
                    attemptId: intent.issueFingerprint,
                    interruptedOriginId: intent.continuation.interruptedOriginId,
                    interruption: 'provider_failed_turn',
                    resumePromptMode: intent.continuation.resumePromptMode,
                    customResumePrompt: intent.continuation.customResumePrompt,
                    recoveryKind: intent.continuation.recoveryKind,
                  },
                );
              if (continuationResult.status === 'enqueued') {
                temporaryThrottleResumeSnapshotsBySessionId.delete(sessionId);
                logger.debug(
                  '[DAEMON RUN] Temporary throttle recovery handed continuation to Pending',
                  {
                    sessionId,
                  },
                );
                return { status: 'continued' as const };
              }
              if (continuationResult.status === 'suppressed_newer_user_input') {
                temporaryThrottleResumeSnapshotsBySessionId.delete(sessionId);
                return {
                  status: 'superseded' as const,
                  reason: 'newer_user_input',
                };
              }
              temporaryThrottleResumeSnapshotsBySessionId.delete(sessionId);
              return {
                status: 'terminal' as const,
                lastError:
                  continuationResult.status === 'disabled'
                    ? 'temporary_throttle_continuation_disabled'
                    : 'temporary_throttle_continuation_not_interrupted',
              };
            }
            throw new Error(
              `temporary_throttle_resume_failed:${result.type}${result.type === 'error' ? `:${result.errorCode}` : ''}`,
            );
          }),
        );
      },
    });
  const temporaryThrottleRecovery = {
    enable: async (
      input: Parameters<typeof temporaryThrottleScheduler.enable>[0],
    ) => {
      const tracked = findTrackedSessionByHappySessionId(
        params.pidToTrackedSession.values(),
        input.sessionId,
      );
      if (tracked) {
        temporaryThrottleResumeSnapshotsBySessionId.set(
          input.sessionId,
          snapshotTrackedSessionForTemporaryThrottleResume(tracked),
        );
      }
      return await temporaryThrottleScheduler.enable(input);
    },
    wake: async (
      input: Parameters<typeof temporaryThrottleScheduler.wake>[0],
    ) => await temporaryThrottleScheduler.wake(input),
  };
  // Cold-start persistence is evidence for UI/diagnostics and a future explicit action; it is
  // not execution authority. Load the intent so a fresh manual retry can use it, but do not arm
  // timers that could recreate a runner or provider process after daemon/computer restart.
  temporaryThrottleScheduler.hydrate({ schedule: false });

  const connectedServiceContinuationProviderActivityTimeoutMs =
    resolvePositiveIntEnv(
      params.processEnv
        .HAPPIER_CONNECTED_SERVICES_CONTINUATION_PROVIDER_ACTIVITY_TIMEOUT_MS,
      5 * 60_000,
      { min: 1_000, max: 24 * 60 * 60_000 },
    );
  const connectedServiceRecoverySupersessionCleaner =
    createConnectedServiceRecoverySupersessionCleaner({
      removeReportOutboxItemsForSession: async (input) => {
        await removeRuntimeAuthFailureReportOutboxItemsForSession(input);
      },
      logDebug: (message, error) => logger.debug(message, error),
    });
  const versionRuntimeRefreshCompletionTimeoutMs = resolvePositiveIntEnv(
    params.processEnv
      .HAPPIER_DAEMON_SESSION_RUNNER_RESTART_COMPLETION_TIMEOUT_MS,
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
      return {
        ok: false,
        status: 'spawn_failed',
        reasonCode: 'missing_credentials',
        diagnostics,
      };
    }
    if (reason === 'missing_spawn_options') {
      return {
        ok: false,
        status: 'spawn_failed',
        reasonCode: 'missing_spawn_options',
        diagnostics,
      };
    }
    if (reason === 'already_running') {
      return {
        ok: false,
        status: 'partial_failure',
        reasonCode: 'restart_already_running',
        diagnostics,
      };
    }
    if (reason === 'stop_requested') {
      return { ok: false, status: 'partial_failure', diagnostics };
    }
    return { ok: false, status: 'spawn_failed', diagnostics };
  };
  const versionRuntimeRefreshAttemptHandoff =
    createVersionRuntimeRefreshAttemptHandoff<RestartSessionRunnerCompletion>({
      // The respawn owner settles success/failure under its existing spawn
      // lifecycle. A second handoff deadline cannot expire healthy retirement
      // or replacement preparation before that owner has finished.
      timeoutMs: null,
      lifetime: {
        signal: shutdownCancellationDomains.daemonWorkSignal,
        completion: { ok: false, status: 'partial_failure', diagnostics: { respawnTerminalReason: 'daemon_shutdown' } },
      },
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
  const settleVersionRuntimeRefreshCompletion =
    versionRuntimeRefreshAttemptHandoff.settle;
  const takeVersionRuntimeRefreshTransientSpawnOptions =
    versionRuntimeRefreshAttemptHandoff.takeTransientSpawnOptions;
  const transferVersionRuntimeRefreshCompletionWaiter =
    versionRuntimeRefreshAttemptHandoff.transferPid;
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
  params.setOnTrackedSessionPidPromoted?.(onTrackedSessionPidPromoted);
  const runnerRespawnScheduledPids = new Set<number>();
  type CapturedRunnerTerminal =
    | Readonly<{
        status: 'captured';
        sessionId: string;
        authority: MachineSessionTerminalAuthorityV1;
      }>
    | Readonly<{ status: 'already_inactive'; sessionId: string }>
    | Readonly<{ status: 'unavailable'; sessionId: string }>;
  type RunnerTerminalCycle = {
    entriesByPid: Map<
      number,
      {
        tracked: TrackedSession;
        admission: CapturedRunnerTerminal;
      }
    >;
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
      logger.debug(
        '[DAEMON RUN] Exited runner marker ownership changed before release',
        {
          sessionId,
          previousPid,
        },
      );
    }
  };
  const removeRunnerTerminalEntries = async (
    sessionId: string,
    entries: ReadonlyArray<
      readonly [
        number,
        {
          tracked: TrackedSession;
          admission: CapturedRunnerTerminal;
        },
      ]
    >,
  ): Promise<void> => {
    await Promise.all(
      entries.map(async ([pid, entry]) => {
        await removeExitedRunnerMarker(pid, sessionId, entry.tracked);
      }),
    );
  };
  const settleCapturedRunnerTerminal = async (
    input: Readonly<{
      sessionId: string;
      previousPid: number;
      reason: SessionRunnerRespawnTerminalReason;
    }>,
  ): Promise<void> => {
    const cycle = runnerTerminalCycleBySessionId.get(input.sessionId);
    if (cycle) runnerTerminalCycleBySessionId.delete(input.sessionId);
    const entries = cycle ? Array.from(cycle.entriesByPid.entries()) : [];
    const captured = cycle?.entriesByPid.get(input.previousPid)?.admission;
    if (input.reason === 'already_running') {
      await removeRunnerTerminalEntries(input.sessionId, entries);
      return;
    }
    if (!cycle || !captured || captured.status === 'unavailable') {
      logger.debug(
        '[DAEMON RUN] Terminal respawn has no captured Session publisher authority; retaining marker for startup recovery',
        input,
      );
      return;
    }
    if (captured.status === 'already_inactive') {
      await removeRunnerTerminalEntries(input.sessionId, entries);
      return;
    }
    const apiMachine = params.getApiMachineForSessions();
    if (!apiMachine) {
      logger.debug(
        '[DAEMON RUN] Machine Session terminal transport unavailable; retaining marker for startup recovery',
        input,
      );
      return;
    }
    try {
      const finalized = await apiMachine.finalizeMachineSessionTerminal({
        sessionId: captured.sessionId,
        authority: captured.authority,
      });
      if (finalized.status === 'rejected') {
        logger.debug(
          '[DAEMON RUN] Machine Session terminal finalize was rejected; retaining marker for startup recovery',
          {
            ...input,
            status: finalized.status,
            reason: finalized.reason,
          },
        );
        return;
      }
      await removeRunnerTerminalEntries(input.sessionId, entries);
    } catch (error) {
      logger.debug(
        '[DAEMON RUN] Machine Session terminal finalize failed; retaining marker for startup recovery',
        {
          ...input,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  };
  const readStartupFailure: NonNullable<Parameters<typeof createSessionRunnerRespawnManager>[0]['readStartupFailure']> =
    async ({ sessionId, trackedSession: tracked, runnerExitCode }) => {
      if (typeof tracked.processStartTimeMs !== 'number'
        || !Number.isFinite(tracked.processStartTimeMs)) return null;
      const attribution = tracked.requesterWorkAttributionV1 ?? tracked.spawnOptions?.requesterWorkAttributionV1;
      return await withSessionAccountContext(sessionId, async (context) => {
        const rawSession = await withSessionAccountHome(context, () => fetchSessionByIdCompat({ reason: 'session-control',
          token: context?.bootstrap.credentials.token ?? params.credentials.token,
          sessionId,
        }));
        await assertSessionAccountCurrent(sessionId, context, attribution);
        const issue = rawSession?.id === sessionId && rawSession.latestTurnStatus === 'failed'
          ? rawSession.lastRuntimeIssue ?? null : null;
        const execution = tracked.spawnOptions?.executionAuthorization;
        const pending = rawSession?.pendingActivationAuthorization;
        const target = pending?.admittedTarget;
        if (isCurrentDefiniteSessionStartupFailure(issue, tracked.processStartTimeMs, runnerExitCode)
          && execution?.provenance === 'user_request' && typeof execution.requestedAt === 'number'
          && pending?.status === 'waiting' && pending.requestId === execution.requestId
          && pending.requestedAt === execution.requestedAt && target?.sessionId === sessionId
          && target.accountId === (context?.bootstrap.attribution.accountId ?? params.externalActionAccountId)
          && target.machineId === params.machineId
          && target.installationId === readInstallationIdentityIfExistsSync()?.installationId) {
          const origin = await params.resolveCurrentMachineExecutionOriginContext?.();
          if (origin?.serverIdentityId === target.homeId && origin.machineId === target.machineId) {
            await assertSessionAccountCurrent(sessionId, context, attribution);
            // The webhook admitted process custody before Agent construction. Its
            // later definite refusal still owns this exact retained activation.
            // Home keeps the managed-compute running guard and request CAS.
            await withSessionAccountHome(context, () => reportPendingSessionActivationFailure({
              token: context?.bootstrap.credentials.token ?? params.credentials.token,
              sessionId, requestId: execution.requestId, requestedAt: execution.requestedAt!,
              failureCode: 'runtime_start_failed',
              failureDetails: { reason: 'spawn-rejected', spawnErrorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED },
            }));
          }
        }
        return issue;
      }, attribution);
    };
  const sessionRunnerRespawnManager = createSessionRunnerRespawnManager({
    // Runner death is non-fatal: the respawn owner is adopt-first (reattaches the durable
    // terminal host / claude session, never blind-relaunches a healthy one) and storm-bounded
    // via `decideRestartForCycle` independent of this flag. The historical `false` default traces
    // to commit 0d5d93f3b7 ("harden runner termination and daemon respawn"), which predates the
    // adopt-first landing; no test/comment ties it to a safety invariant. Default ON, with an
    // explicit opt-out env (HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED=false).
    enabled: parseBooleanEnv(
      params.processEnv.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED,
      true,
    ),
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
    isSessionAlreadyRunning: async (sessionId) =>
      await isSessionRunnerActive(sessionId),
    readStartupFailure,
    // Only the current intended respawn cycle may finish during shutdown drain.
    // An existing version handoff must also retain this exact predecessor.
    spawnSession: (options, predecessor) => spawnSessionWithAdmission(options, {
      freshExplicitResume: false,
      completingPlannedRestart: predecessor.intended && (
        versionRuntimeRefreshAttemptHandoff.has(
          predecessor.sessionId, predecessor.previousPid, predecessor.trackedSession,
        ) || !versionRuntimeRefreshAttemptHandoff.has(predecessor.sessionId, predecessor.previousPid)
      ),
    }),
    resolveRespawnOptions: async (input) =>
      await resolveRespawnSessionOptionsWithRuntimeSnapshot({
        ...input,
        readPersistedSessionMetadata:
          readPersistedConnectedServiceSwitchSessionMetadata,
      }),
    onRespawnSuccess: ({ sessionId, previousPid }) => {
      runnerRespawnScheduledPids.delete(previousPid);
      params.connectedServicesRestartRequestedPids.delete(previousPid);
      const cycle = runnerTerminalCycleBySessionId.get(sessionId);
      if (cycle) runnerTerminalCycleBySessionId.delete(sessionId);
      const entries = cycle ? Array.from(cycle.entriesByPid.entries()) : [];
      void (
        entries.length > 0
          ? removeRunnerTerminalEntries(sessionId, entries)
          : Promise.resolve()
      ).catch((error) => {
        logger.debug(
          '[DAEMON RUN] Failed to release exited runner marker after respawn success',
          error,
        );
      });
      void clearSessionMarkerConnectedServiceRestartIntent(previousPid).catch(
        (error) => {
          logger.debug(
            '[DAEMON RUN] Failed to clear connected-service restart intent after respawn success',
            error,
          );
        },
      );
      const next = findTrackedSessionByHappySessionId(
        params.pidToTrackedSession.values(),
        sessionId,
      );
      settleVersionRuntimeRefreshCompletion(sessionId, previousPid, {
        ok: true,
        ...(next ? { next: summarizeSessionRunnerEndpoint(next) } : {}),
      });
    },
    onRespawnTerminal: ({ sessionId, previousPid, reason, detail }) => {
      runnerRespawnScheduledPids.delete(previousPid);
      params.connectedServicesRestartRequestedPids.delete(previousPid);
      void settleCapturedRunnerTerminal({ sessionId, previousPid, reason });
      void clearSessionMarkerConnectedServiceRestartIntent(previousPid).catch(
        (error) => {
          logger.debug(
            '[DAEMON RUN] Failed to clear connected-service restart intent after terminal respawn suppression',
            error,
          );
        },
      );
      settleVersionRuntimeRefreshCompletion(
        sessionId,
        previousPid,
        buildVersionRuntimeRefreshTerminalCompletion(reason, detail),
      );
    },
    onStopRequested: sessionId => versionRuntimeRefreshAttemptHandoff.settleSession(
      sessionId, buildVersionRuntimeRefreshTerminalCompletion('stop_requested'),
    ),
    random: () => Math.random(),
    logDebug: (message, payload) => logger.debug(message, payload),
    logWarn: (message) => logger.warn(message),
  });
  const clearConnectedServiceRestartIntentForPid = (
    pid: number,
    logMessage: string,
  ): void => {
    void clearSessionMarkerConnectedServiceRestartIntent(pid).catch((error) => {
      logger.debug(logMessage, error);
    });
  };
  const connectedServiceTurnDeferralQueue =
    createConnectedServiceSwitchDeferralQueue({
      timeoutMs: resolvePositiveIntEnv(
        params.processEnv.HAPPIER_CONNECTED_SERVICES_TURN_DEFERRAL_TIMEOUT_MS,
        60_000,
        { min: 1_000, max: 10 * 60_000 },
      ),
      disableDeferral:
        String(
          params.processEnv.HAPPIER_CONNECTED_SERVICES_DISABLE_TURN_DEFERRAL ??
            '',
        ).trim() === '1',
      emitSessionEvent: async (sessionId, event) => {
        await commitConnectedServiceAccountSwitchSessionEventWithNotification({
          sessionId,
          event,
          logContext: 'connected-service switch deferral',
        });
      },
    });
  // A begin marker write may await disk before exact custody is accepted. Inhibit restarts
  // during that observation without giving rejected lifecycle input authority in the queue.
  // Separate entries keep overlapping begins protected until each observation settles.
  const pendingTurnBegins = new Set<Readonly<{ sessionId: string }>>();
  const readSessionRunnerLiveWork = async (tracked: TrackedSession, signal: AbortSignal) => {
    const sessionId = resolveCanonicalTrackedSessionId(tracked.pid);
    return await withSessionAccountContext(sessionId || null, async requester =>
      await readTrackedSessionInputLiveWorkRequired({
        tracked, credentials: params.credentials, custodianAccountId: params.externalActionAccountId ?? null,
        serverId: params.serverId, machineId: params.machineId, serverHttpBaseUrl: params.serverBaseUrl,
        ...(requester ? { requesterBootstrap: requester.bootstrap } : {}),
        isTrackedCurrent: () => params.pidToTrackedSession.get(tracked.pid) === tracked, signal,
      }), undefined, signal);
  };
  const readSessionRunnerNativeRuntimeActivity = async (sessionId: string): Promise<'active' | 'settled' | 'unknown'> => {
    const tracked = findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), sessionId);
    if (!tracked) return 'unknown';
    return (await readSessionRunnerLiveWork(tracked, shutdownCancellationDomains.daemonWorkSignal)).nativeRuntimeActivity ?? 'unknown';
  };
  const resolveSessionRunnerActivity = (
    sessionId: string,
    childRuns?: readonly Parameters<typeof isExecutionRunActive>[0][],
  ) => {
    const busy = (busySource: string, details: Record<string, unknown> = {}) => ({
      reasonCode: 'turn_in_progress' as const, diagnostics: { busySource, ...details },
    });
    if (childRuns?.some(isExecutionRunActive)) return busy('child_turn');
    for (const begin of pendingTurnBegins) {
      if (begin.sessionId === sessionId) return busy('pending_foreground_begin');
    }
    const tracked = findTrackedSessionByHappySessionId(
      params.pidToTrackedSession.values(),
      sessionId,
    );
    const trackedActivity = resolveTrackedSessionRunnerActivity(tracked,
      params.getApiMachineForSessions()?.getActiveRpcHandlerExecutions() ?? []);
    if (trackedActivity) return trackedActivity;
    return connectedServiceTurnDeferralQueue.isTurnInFlight(sessionId)
      ? busy('foreground_turn_queue')
      : null;
  };
  const resolveSessionRunnerActivityDisabledReason = (
    sessionId: string,
    childRuns?: readonly Parameters<typeof isExecutionRunActive>[0][],
  ): SessionRunnerRestartDisabledReason | null => resolveSessionRunnerActivity(sessionId, childRuns)?.reasonCode ?? null;
  const waitForSessionRunnerChildTurns = async (
    sessionId: string,
    signal: AbortSignal,
  ): Promise<PlannedRunnerRestartSignalGateResult> => {
    const tracked = findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), sessionId);
    if (!tracked) return 'activity_observation_unavailable';
    try {
      // The live Run manager, not visibility markers or retained status,
      // decides whether a child turn is active.
      return await withSessionAccountContext(sessionId, async accountContext =>
        await withSessionAccountHome(accountContext, async () => {
          const credentials = accountContext?.bootstrap.credentials ?? params.credentials;
          const transport = await resolveSessionTransportContext({ reason: 'session-control', credentials, idOrPrefix: sessionId, signal });
          if (!transport.ok || transport.sessionId !== sessionId) return 'activity_observation_unavailable';
          const executionRunActivityChanges = createExecutionRunLiveWorkProducer();
          while (!signal.aborted) {
            const observation = new AbortController();
            const changed = waitForChangeOrDeadline({ signal: AbortSignal.any([signal, observation.signal]),
              waitForChange: waiting => new Promise<void>(resolve => {
                const unsubscribe = executionRunActivityChanges.subscribe(() => resolve());
                waiting.addEventListener('abort', () => { unsubscribe(); resolve(); }, { once: true });
                if (waiting.aborted) { unsubscribe(); resolve(); }
              }),
            });
            try {
              const request = { token: credentials.token, sessionId,
                method: `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_LIST}`, request: {}, timeoutMs: null, signal };
              const raw = transport.mode === 'plain' ? await callSessionRpc({ ...request, mode: 'plain' })
                : await callSessionRpc({ ...request, mode: 'e2ee', ctx: transport.ctx });
              const { runs } = ExecutionRunListResponseSchema.parse(raw);
              await assertSessionAccountCurrent(sessionId, accountContext);
              const reason = resolveSessionRunnerActivityDisabledReason(sessionId, runs);
              if (!reason) return true;
              // Foreground activity retains its existing busy/retry semantics.
              if (resolveSessionRunnerActivityDisabledReason(sessionId)) return reason;
              if (await changed === 'aborted') return 'activity_observation_unavailable';
            } finally { observation.abort(); }
          }
          return 'activity_observation_unavailable';
        }), undefined, signal);
    } catch {
      if (!signal.aborted) logger.debug('[DAEMON RUN] Planned restart child activity unavailable', {
        sessionId, code: 'child_run_activity_unavailable',
      });
      return 'activity_observation_unavailable';
    }
  };
  const prepareSessionRunnerSignal = async (sessionId: string, expectedPid: number, signal: AbortSignal) => {
    try {
      return await withSessionAccountContext(sessionId, async accountContext =>
        await withSessionAccountHome(accountContext, async () => {
          const credentials = accountContext?.bootstrap.credentials ?? params.credentials;
          const transport = await resolveSessionTransportContext({ reason: 'session-control', credentials, idOrPrefix: sessionId, signal });
          if (!transport.ok || transport.sessionId !== sessionId) return null;
          await assertSessionAccountCurrent(sessionId, accountContext);
          const tracked = findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), sessionId);
          if (!tracked || (tracked.sessionRunnerPid ?? tracked.pid) !== expectedPid) return null;
          return await prepareSessionRunnerRestartAdmission({ expectedPid, signal,
            onHold: attempt => {
              tracked.plannedRestartAdmission = attempt;
              attempt.signal.addEventListener('abort', () => {
                if (tracked.plannedRestartAdmission === attempt) delete tracked.plannedRestartAdmission;
              }, { once: true });
            }, callRpc: async (request, requestSignal) =>
            await withSessionAccountHome(accountContext, async () => {
              const input = { token: credentials.token, sessionId,
                method: `${sessionId}:${SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION}`, request, timeoutMs: null,
                signal: requestSignal ?? shutdownCancellationDomains.daemonWorkSignal };
              return transport.mode === 'plain' ? await callSessionRpc({ ...input, mode: 'plain' })
                : await callSessionRpc({ ...input, mode: 'e2ee', ctx: transport.ctx });
            }) });
        }), undefined, signal);
    } catch (error) {
      if (error instanceof SessionRunnerRestartAdmissionUnsupportedError) throw error;
      return null;
    }
  };
  const resolvePredictiveSoftSwitchModeForInput = async (
    input: Readonly<{
      signal?: AbortSignal;
      sessionId: string;
      serviceId: ConnectedAccountServiceKey;
      groupId: string;
      activeProfileId: string;
      agentId?: string | null;
      reason:
        | 'soft_threshold'
        | 'same_provider_account_exhausted'
        | 'usage_limit'
        | 'auth_expired';
    }>,
  ): Promise<PredictiveSoftSwitchCapability> => {
    input.signal?.throwIfAborted();
    const tracked = findTrackedSessionByHappySessionId(
      params.pidToTrackedSession.values(),
      input.sessionId,
    );
    const resolvedAgentId =
      typeof input.agentId === 'string' && input.agentId.trim()
        ? input.agentId.trim()
        : resolveTrackedSessionCatalogAgentId(tracked);
    if (!resolvedAgentId) return 'unsupported';
    return await resolveConnectedServicePredictiveSoftSwitchCapability(
      resolvedAgentId as CatalogAgentId,
      {
        serviceId: input.serviceId,
        groupId: input.groupId,
        activeProfileId: input.activeProfileId,
        profileId: input.activeProfileId,
      },
    );
  };
  const observeSessionRunnerRetirement = async (
    tracked: TrackedSession,
    _sessionId: string,
    timeoutMs = versionRuntimeRefreshCompletionTimeoutMs,
  ): Promise<boolean | undefined> => {
    return await observePlannedRunnerRetirement({
      tracked,
      timeoutMs,
      pollIntervalMs: configuration.daemonSpawnExistingSessionWaitForExitPollIntervalMs,
      onExitObserved: async (pid, exit) => {
        if (params.pidToTrackedSession.get(pid) === tracked) await onChildExited(pid, exit);
      },
    });
  };
  const captureSessionRunnerRemainder = async (tracked: TrackedSession, sessionId: string) => {
    // This exact native tree includes Session-owned Runs, even though their
    // process tags deliberately identify the more specific logical Run owner.
    // Anchor it to the same witnessed wrapper/runner that receives the signal.
    return await ownerRemainder.captureTree({ kind: 'session', sessionId }, {
      pid: tracked.pid,
      ...(tracked.processStartTimeMs === undefined ? {} : { start: { startTimeMs: tracked.processStartTimeMs } }),
    });
  };

  const requestConnectedServiceRestartWithDeferral = async (
    input: Readonly<{
      sessionId: string;
      tracked: TrackedSession;
      source: 'manual' | 'automatic';
      policy: 'defer_until_turn_boundary' | 'defer_until_idle';
      target: ConnectedServiceSwitchTarget;
      restartSignalDelayMs: number;
      restartDiagnostic: ConnectedServiceDaemonRestartDiagnosticInput;
      onSignalFailureLogMessage: string;
    }>,
  ): ReturnType<typeof requestPlannedRunnerRestart> => {
    const completionTarget = {
      sessionId: input.sessionId,
      previousPid: input.tracked.pid,
      tracked: input.tracked,
      transientSpawnOptions: input.tracked.spawnOptions,
    };
    return await withSessionAccountContext(input.sessionId, async (accountContext) =>
      await requestPlannedRunnerRestart({
        reason: input.restartDiagnostic.reason ?? input.restartDiagnostic.trigger,
        prepareSignal: signal => prepareSessionRunnerSignal(input.sessionId, input.tracked.sessionRunnerPid ?? input.tracked.pid,
          AbortSignal.any([signal, shutdownCancellationDomains.daemonWorkSignal])),
        sessionId: input.sessionId,
        tracked: input.tracked,
        // Keep transition custody through the existing exact-predecessor
        // handoff. A signal is not yet a registered replacement runner.
        completion: {
          hasPending: () => versionRuntimeRefreshAttemptHandoff.has(input.sessionId, input.tracked.pid),
          join: () => versionRuntimeRefreshAttemptHandoff.join(completionTarget),
          create: () => {
            const attempt = versionRuntimeRefreshAttemptHandoff.create(completionTarget);
            return { ...attempt, retire: () => attempt.settle({ ok: false, status: 'partial_failure',
              diagnostics: { respawnTerminalReason: 'runner_retirement_unobserved' } }) };
          },
        },
        deferral: {
          kind: 'connected_service_switch',
          source: input.source,
          policy: input.policy,
          target: input.target,
          turnDeferralQueue: connectedServiceTurnDeferralQueue,
        },
        restartRequestedPids: params.connectedServicesRestartRequestedPids,
        pidToTrackedSession: params.pidToTrackedSession,
        isShuttingDown: isRuntimePublicationQuiescing,
        observeRunnerRetirement: observeSessionRunnerRetirement,
        captureRunnerRemainder: captureSessionRunnerRemainder,
        canSignal: async signal => {
          await assertSessionAccountCurrent(input.sessionId, accountContext);
          return resolveSessionRunnerActivityDisabledReason(input.sessionId)
            ?? await waitForSessionRunnerChildTurns(input.sessionId,
              AbortSignal.any([signal, shutdownCancellationDomains.daemonWorkSignal]));
        },
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
        observeProcessMissing:
          observeConnectedServiceRestartProcessMissing ?? undefined,
        clearRestartIntentForPid: clearConnectedServiceRestartIntentForPid,
        onSignalFailureLogMessage: input.onSignalFailureLogMessage,
        logDebug: (message, payload) => logger.debug(message, payload),
        logWarn: (message, payload) => logger.warn(message, payload),
      }),
    );
  };

  const requestSessionRunnerVersionRuntimeRefresh = async (
    input: Readonly<{
      sessionId: string;
      tracked: TrackedSession;
      reason: 'version_runtime_refresh';
      requesterReason?: Parameters<typeof restartSessionRunnerOnCurrentRuntime>[0]['request']['reason'] | 'request_auth_source_cutover';
      transientSpawnOptions?: SpawnSessionOptions;
      completionTimeoutMs?: number | null;
      canSignal?: () =>
        | PlannedRunnerRestartSignalGateResult
        | Promise<PlannedRunnerRestartSignalGateResult>;
    }>,
  ): Promise<
    Readonly<{
      signaled: boolean;
      notSignaledReason?: PlannedRunnerRestartNotSignaledReason;
      completion?: RestartSessionRunnerCompletion;
    }>
  > => {
    logger.debug(
      '[DAEMON RUN] Session-runner runtime refresh restart attempt',
      {
        sessionId: input.sessionId,
        pid: input.tracked.pid,
        reason: input.requesterReason ?? input.reason,
        restartKind: input.reason,
        routedThroughGatedPrimitive: true,
      },
    );
    const completionTarget = {
      sessionId: input.sessionId,
      previousPid: input.tracked.pid,
      tracked: input.tracked,
      ...(input.completionTimeoutMs !== undefined ? { timeoutMs: input.completionTimeoutMs } : {}),
      ...(input.transientSpawnOptions ? { transientSpawnOptions: input.transientSpawnOptions } : {}),
    };
    return await requestPlannedRunnerRestart({
      reason: input.requesterReason ?? input.reason,
      ...(input.requesterReason === 'request_auth_source_cutover' ? {} : {
        prepareSignal: (signal: AbortSignal) => prepareSessionRunnerSignal(input.sessionId, input.tracked.sessionRunnerPid ?? input.tracked.pid,
          AbortSignal.any([signal, shutdownCancellationDomains.daemonWorkSignal])),
      }),
      sessionId: input.sessionId,
      tracked: input.tracked,
      completion: {
        hasPending: () => versionRuntimeRefreshAttemptHandoff.has(input.sessionId, input.tracked.pid),
        join: () => versionRuntimeRefreshAttemptHandoff.join(completionTarget),
        create: () => {
          const attempt = versionRuntimeRefreshAttemptHandoff.create(completionTarget);
          return { ...attempt, retire: () => attempt.settle({
            ok: false, status: 'partial_failure', diagnostics: { respawnTerminalReason: 'runner_retirement_unobserved' },
          }) };
        },
      },
      captureRunnerRemainder: captureSessionRunnerRemainder,
      ...(input.completionTimeoutMs !== null
        ? { observeRunnerRetirement: (tracked: TrackedSession, sessionId: string) =>
            observeSessionRunnerRetirement(tracked, sessionId, input.completionTimeoutMs ?? versionRuntimeRefreshCompletionTimeoutMs) }
        : {}),
      deferral: { kind: 'none' },
      restartRequestedPids: params.connectedServicesRestartRequestedPids,
      pidToTrackedSession: params.pidToTrackedSession,
      isShuttingDown: isRuntimePublicationQuiescing,
      canSignal: async signal => {
        const allowed = input.canSignal ? await input.canSignal()
          : resolveSessionRunnerActivityDisabledReason(input.sessionId) ?? true;
        if (allowed !== true || input.requesterReason === 'request_auth_source_cutover') return allowed;
        const childGate = await waitForSessionRunnerChildTurns(input.sessionId,
          AbortSignal.any([signal, shutdownCancellationDomains.daemonWorkSignal]));
        if (childGate !== true) return childGate;
        // Native work and the exact restart context may change while child turns drain.
        return input.canSignal ? await input.canSignal()
          : resolveSessionRunnerActivityDisabledReason(input.sessionId) ?? true;
      },
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
      observeProcessMissing:
        observeConnectedServiceRestartProcessMissing ?? undefined,
      onSignalFailureLogMessage:
        '[DAEMON RUN] Failed to restart session-runner for runtime refresh',
      logDebug: (message, payload) => logger.debug(message, payload),
      logWarn: (message, payload) => logger.warn(message, payload),
    });
  };

  type ProviderInputAdmissionTargetWitness = Readonly<{
    targetReference: ConnectedServiceRuntimeTarget;
    sessionId: string;
    runtimeIdentityKey: string;
    revision: number;
  }>;
  const captureProviderInputAdmissionTargetWitness = (
    target: ConnectedServiceRuntimeTarget,
  ): ProviderInputAdmissionTargetWitness | null =>
    target.sessionId
      ? Object.freeze({
          targetReference: target,
          sessionId: target.sessionId,
          runtimeIdentityKey: target.runtimeIdentityKey,
          revision: target.revision,
        })
      : null;
  const isCurrentProviderInputAdmissionTarget = (
    witness: ProviderInputAdmissionTargetWitness,
  ): boolean => {
    const current = connectedServiceRuntimeRegistry.getBySessionId(
      witness.sessionId,
    );
    return (
      current === witness.targetReference &&
      current.runtimeIdentityKey === witness.runtimeIdentityKey &&
      current.revision === witness.revision
    );
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
    const targetWitness =
      expectedWitness ?? captureProviderInputAdmissionTargetWitness(target);
    const sessionId = targetWitness?.sessionId ?? null;
    if (
      !targetWitness ||
      !sessionId ||
      !isCurrentProviderInputAdmissionTarget(targetWitness)
    ) {
      throw new Error('provider_input_admission_target_released');
    }
    const outcome = await requestProviderInputAdmissionWithBoundedRetry({
      targetFence: {
        expected: targetWitness,
        resolveCurrentTarget: () =>
          connectedServiceRuntimeRegistry.getBySessionId(sessionId),
        createSupersededError: () =>
          new Error('provider_input_admission_target_released'),
      },
      isCancelled: () =>
        shutdownCancellationDomains.daemonWorkSignal.aborted ||
        isRuntimePublicationQuiescing(),
      requestAdmission: async () => {
        return await withSessionAccountContext(sessionId, async (accountContext) =>
          await withSessionAccountHome(accountContext, () =>
            callSessionProviderInputAdmission({
              credentials:
                accountContext?.bootstrap.credentials ?? params.credentials,
              sessionId,
              ...request,
            }),
          ),
        );
      },
      isMethodUnavailable: isRpcMethodNotAvailableError,
      // A fresh current runner can publish its runtime target just before its
      // provider-input RPC is registered. Give that startup window a bounded
      // grace; an old/incompatible runner remains a typed admission failure.
      methodUnavailableRetry: {
        maxAttempts: 50,
        waitBeforeRetry: async () =>
          await waitForProviderInputAdmissionGrace(
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
  const verifySessionConnectedServiceAccountAdoption =
    createSessionConnectedServiceAccountAdoptionVerifier();
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
        requestPurpose: 'connected-accounts:auth-group',
        ...(signal ? { signal } : {}),
      }),
  };

  const buildConnectedServiceAuthApplicationSession =
    (
      builderInput: Readonly<{
        sessionId: string;
        interruptedSessionId?: string | null;
        interruptedOriginId?: string | null;
        restartReason: string | null;
        commitAccountSwitchEvents: boolean;
        allowRestart?: boolean;
        executionAuthority?: ConnectedServiceGenerationExecutionAuthority;
        dryRun?: boolean;
      }>,
    ) =>
    async (
      restartInput: Readonly<{
        sessionId?: string;
        serviceId: ConnectedAccountServiceKey;
        groupId: string | null;
        activeProfileId: string | null;
        generation: number | null;
        reason?: string;
      }>,
    ): Promise<ConnectedServiceAuthGroupGenerationApplyResult> => {
      const apply = async () => await withSessionAccountContext(builderInput.sessionId, async (accountContext) => {
        const sessionCredentials =
          accountContext?.bootstrap.credentials ?? params.credentials;
        const sessionApi = accountContext?.api ?? params.api;
        const readSessionSettings = () =>
          accountContext
            ? accountContext.readAccountSettingsSnapshot().settings
            : (getActiveAccountSettingsSnapshot()?.settings ?? null);
        return await withSessionAccountHome(accountContext, async () => {
          const tracked =
            Array.from(params.pidToTrackedSession.values()).find(
              (child) => child.happySessionId === builderInput.sessionId,
            ) ?? null;
          const inactiveContext = tracked
            ? null
            : await resolveInactiveConnectedServiceSessionContext({
                token: sessionCredentials.token,
                credentials: sessionCredentials,
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
          const sameProviderAccountFanout =
            builderInput.restartReason === 'same_provider_account_exhausted';
          const hotApplyOnlyFailure =
            (): ConnectedServiceAuthGroupGenerationApplyFailure =>
              connectedServiceAuthGroupGenerationApplyFailure({
                errorCode: 'same_provider_account_exhaustion_hot_apply_required',
                serviceId: restartInput.serviceId,
                failurePhase: 'hot_apply',
              });
          const signalRestart = async () => {
            await assertSessionAccountCurrent(
              builderInput.sessionId,
              accountContext,
            );
            if (builderInput.allowRestart === false) {
              throw new Error('restart_disallowed_by_execution_policy');
            }
            if (sameProviderAccountFanout) {
              throw new Error(
                'same_provider_account_exhaustion_hot_apply_required',
              );
            }
            if (!tracked) throw new Error('session_not_found');
            const restartSignalDelayMs = resolvePositiveIntEnv(
              params.processEnv
                .HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_RESTART_SIGNAL_DELAY_MS,
              250,
              { min: 0, max: 5_000 },
            );
            // The FSM's restart-resume fallback when hot-apply is ineligible is
            // gated through deferral and spawn-time reachability.
            return await requestConnectedServiceRestartWithDeferral({
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
              onSignalFailureLogMessage:
                '[DAEMON RUN] Failed to restart connected-service auth group session',
            });
          };
          const signalRestartWithoutConfirmedApply =
            async (): Promise<ConnectedServiceAuthGroupGenerationApplyFailure> => {
              if (sameProviderAccountFanout) return hotApplyOnlyFailure();
              if (builderInput.allowRestart === false) {
                return connectedServiceAuthGroupGenerationApplyFailure({
                  errorCode: 'restart_disallowed_by_execution_policy',
                  serviceId: restartInput.serviceId,
                  failurePhase: 'restart',
                });
              }
              try {
                const restart = await signalRestart();
                assertConnectedServiceRestartCompleted(restart);
              } catch (error) {
                return connectedServiceAuthGroupGenerationApplyFailure({
                  errorCode: 'restart_failed',
                  serviceId: restartInput.serviceId,
                  failurePhase: 'restart',
                  diagnostics: buildConnectedServiceRestartFailureDiagnostics(error),
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
          const applicationState = readConnectedServiceCredentialApplicationState(
            {
              serviceId: restartInput.serviceId,
              connectedServicesBindingsRaw: tracked
                ? resolveTrackedConnectedServiceBindingsRaw(tracked)
                : inactiveContext?.connectedServices,
              connectedServiceSelectionsEnv:
                tracked?.spawnOptions?.environmentVariables,
            },
          );
          if (!applicationState)
            return await signalRestartWithoutConfirmedApply();
          restartInput = {
            ...restartInput,
            serviceId: applicationState.serviceId,
          };
          const previousBindings = applicationState.bindings;
          const previousBinding = applicationState.binding;
          const nextProfileId =
            normalizeOptionalString(restartInput.activeProfileId) ||
            (previousBinding?.source === 'connected'
              ? previousBinding.profileId
              : '');
          const nextGroupId = normalizeOptionalString(restartInput.groupId);
          const nextGeneration = normalizeNullableGeneration(
            restartInput.generation,
          );
          if (
            !previousBinding ||
            previousBinding.source !== 'connected' ||
            !nextProfileId ||
            (previousBinding.selection === 'group' &&
              (!nextGroupId || nextGeneration === null))
          ) {
            return await signalRestartWithoutConfirmedApply();
          }
          const runtimeAuthApplyReason = normalizeRuntimeAuthApplyReason(
            builderInput.restartReason,
          );
          // Reactive and proactive-quota auth-generation apply routes through
          // the FSM (hot-apply-in-place when eligible, else gated restart-resume with
          // reachability + deferral + mid-turn re-continue exactly once).
          const result =
            await applyConnectedServiceAuthGenerationToTrackedSession({
              getChildren: () => Array.from(params.pidToTrackedSession.values()),
              resolveInactiveSession: async ({ sessionId }) => {
                await assertSessionAccountCurrent(sessionId, accountContext);
                return await resolveInactiveConnectedServiceSessionContext({
                  token: sessionCredentials.token,
                  credentials: sessionCredentials,
                  sessionId,
                  currentMachineId: params.machineId,
                });
              },
              api: sessionApi,
              qualifiedConnectedAccountApi:
                accountContext?.qualifiedConnectedAccountApi ??
                qualifiedConnectedAccountApi,
              ...(runtimeAuthApplyReason ? { runtimeAuthApplyReason } : {}),
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
                persistedSessionMetadata: inactivePersistedSessionMetadata,
                cwd: inactiveCwd,
                candidatePersistedSessionFile:
                  inactiveCandidatePersistedSessionFile,
              }) => {
                const persistedSessionMetadata = continuityTracked
                  ? await readPersistedConnectedServiceSwitchSessionMetadata(
                      sessionId,
                    )
                  : inactivePersistedSessionMetadata ?? null;
                const continuityContext =
                  resolveTrackedConnectedServiceSwitchContinuityContext({
                    agentId: continuityAgentId,
                    baseDir:
                      accountContext?.connectedServicesMaterializationBaseDir ??
                      params.connectedServicesMaterializationBaseDir,
                    tracked: continuityTracked,
                    persistedSessionMetadata,
                    connectedServiceMaterializationIdentityV1,
                    vendorResumeId,
                    runtimeAuthSelection,
                    cwd: inactiveCwd,
                    candidatePersistedSessionFile:
                      inactiveCandidatePersistedSessionFile ?? null,
                  });
                return await resolveSessionConnectedServiceSwitchContinuity({
                  sessionId,
                  agentId: continuityAgentId,
                  serviceId,
                  previousBinding: previous,
                  nextBinding: next,
                  tracked: continuityTracked,
                  connectedServiceMaterializationIdentityV1:
                    continuityContext.connectedServiceMaterializationIdentityV1,
                  vendorResumeId: continuityContext.vendorResumeId,
                  fromBindingsRaw: continuityTracked
                    ? (resolveTrackedConnectedServiceBindingsRaw(
                        continuityTracked,
                      ) ?? continuityPreviousBindings)
                    : continuityPreviousBindings,
                  toBindings: normalizedBindings,
                  accountSettings: readSessionSettings(),
                  targetMaterializedRoot:
                    continuityContext.targetMaterializedRoot,
                  targetMaterializedEnv: continuityContext.targetMaterializedEnv,
                  cwd: continuityContext.cwd,
                  runtimeDescriptorV1: continuityContext.runtimeDescriptorV1,
                  candidatePersistedSessionFile:
                    continuityContext.candidatePersistedSessionFile,
                  ...(runtimeAuthSelection === undefined
                    ? {}
                    : { runtimeAuthSelection }),
                });
              },
              materializeRuntimeAuthSelection: async (materializerInput) => {
                await assertSessionAccountCurrent(
                  materializerInput.sessionId,
                  accountContext,
                );
                return await materializeSessionConnectedServiceRuntimeAuthSelection(
                  {
                    credentials: sessionCredentials,
                    api: sessionApi,
                    activeServerDir:
                      accountContext?.activeServerDir ??
                      configuration.activeServerDir,
                    baseDir: accountContext?.connectedServicesMaterializationBaseDir ?? params.connectedServicesMaterializationBaseDir,
                    connectedAccountsOwner: accountContext?.connectedAccountsOwner,
                    activatePurposeBindings: accountContext?.activatePurposeBindings ?? params.activatePurposeBindings,
                    validateGroupMutationCurrentness: group => validateConnectedServiceGroupMutationCurrentness(group, materializerInput.sessionId),
                    input: materializerInput,
                    accountSettings: readSessionSettings(),
                    processEnv: params.processEnv,
                    allowNativeAccountState: accountContext === null,
                    isCurrent: async () => {
                      await assertSessionAccountCurrent(
                        materializerInput.sessionId,
                        accountContext,
                      );
                      return true;
                    },
                  },
                );
              },
              restartSession: async () => {
                return await signalRestart();
              },
              persistSessionBindings: async ({
                sessionId,
                normalizedBindings,
                connectedServiceMaterializationIdentityV1,
              }) => {
                await assertSessionAccountCurrent(sessionId, accountContext);
                const trackedForSession = findTrackedSessionByHappySessionId(
                  params.pidToTrackedSession.values(),
                  sessionId,
                );
                await persistSessionConnectedServiceBindings({
                  token: sessionCredentials.token,
                  credentials: sessionCredentials,
                  sessionId,
                  normalizedBindings,
                  connectedServiceMaterializationIdentityV1:
                    connectedServiceMaterializationIdentityV1 === undefined
                      ? resolveConnectedServiceMaterializationIdentityFromTrackedSession(
                          trackedForSession,
                        )
                      : connectedServiceMaterializationIdentityV1,
                });
                forgetPersistedConnectedServiceSwitchSessionMetadata(sessionId);
              },
              continueAfterRuntimeAuthSwitch:
                createConnectedServiceContinuationHandler({
                  credentials: sessionCredentials,
                  isCurrent: async () => {
                    await assertSessionAccountCurrent(
                      builderInput.sessionId,
                      accountContext,
                    );
                    return true;
                  },
                  interruptedOriginId: builderInput.interruptedOriginId,
                  resumePromptMode: await resolveContinuationResumePromptMode({
                    serviceId: restartInput.serviceId,
                    groupId:
                      previousBinding.selection === 'group'
                        ? previousBinding.groupId
                        : null,
                    readAccountSettings: readSessionSettings,
                    loadGroupPolicy:
                      previousBinding.selection === 'group' &&
                      previousBinding.groupId
                        ? async () =>
                            (
                              await readQualifiedConnectedServiceAuthGroup({
                                serviceId: restartInput.serviceId,
                                groupId: previousBinding.groupId,
                                sessionId: builderInput.sessionId,
                              })
                            )?.policy ?? null
                        : undefined,
                  }),
                  customResumePrompt: readContinuationCustomResumePrompt(
                    readSessionSettings(),
                  ),
                  recoveryKind:
                    builderInput.restartReason === 'usage_limit' ||
                    builderInput.restartReason === 'rate_limit'
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
              recoverAfterRuntimeAuthSwitch:
                createSelectionPostSwitchRecoveryHandler(),
              verifyProviderAccountAdoption: async (verificationInput) => {
                const result =
                  await verifySessionConnectedServiceAccountAdoption(
                    verificationInput,
                  );
                recordRuntimeAccountIdentityFromVerification({
                  quotaCoordinator: accountContext
                    ? (accountContext.connectedServiceQuotasCoordinator ?? null)
                    : params.getConnectedServiceQuotasCoordinator(),
                  verificationInput,
                  result,
                  observedAtMs: Date.now(),
                });
                return result;
              },
              hotApply: createSessionConnectedServiceAuthHotApply({
                runtimeRegistry: connectedServiceRuntimeRegistry,
                isSessionCurrent: async () => {
                  await assertSessionAccountCurrent(
                    builderInput.sessionId,
                    accountContext,
                  );
                  return true;
                },
                validateGroupMutationCurrentness: (currentness) =>
                  validateConnectedServiceGroupMutationCurrentness(
                    currentness,
                    builderInput.sessionId,
                  ),
              }),
              registerHotApplyTargets: registerHotApplyRuntimeTarget,
              emitSessionEvent: async (sessionId, event) => {
                if (
                  !shouldCommitAutomaticGroupApplySessionEvent(event, {
                    commitAccountSwitchEvents:
                      builderInput.commitAccountSwitchEvents,
                    ...(builderInput.executionAuthority
                      ? { executionAuthority: builderInput.executionAuthority }
                      : {}),
                  })
                )
                  return;
                await commitConnectedServiceAccountSwitchSessionEventWithNotification(
                  {
                    sessionId,
                    event,
                    logContext: 'automatic',
                  },
                );
              },
              dryRun: builderInput.dryRun === true,
              request: {
                sessionId: builderInput.sessionId,
                agentId,
                bindings: {
                  v: 2,
                  bindingsByServiceId: {
                    ...previousBindings.bindingsByServiceId,
                    [restartInput.serviceId]:
                      previousBinding.selection === 'group'
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
                ...(previousBinding.selection === 'group' &&
                nextGeneration !== null
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
        });
      });
      // Generation application and notification admission mutate the same runner
      // selection. Keep every application writer under the same Session owner.
      return await connectedServiceSessionAuthSwitchCore.run({
        sessionId: builderInput.sessionId,
        reason: 'automatic_runtime_failure',
        execute: apply,
      });
    };

  /**
   * Accepts canonical qualified service keys; released scalar ids normalize through the
   * sole legacy ingress normalizer at the edge. Every group decision routes through the
   * qualified V4 coordinator; an unmapped identity has no group authority.
   */
  const createSessionQualifiedAuthGroupSwitchCoordinator = async (
    input: Readonly<{
      sessionId: string | null;
      accountContext: RequesterSessionRuntimeContext | null;
      serviceId: ConnectedAccountServiceKey;
      reason: string;
      allowRestart?: boolean;
      executionAuthority?: ConnectedServiceGenerationExecutionAuthority;
      applyGeneration?: Parameters<
        typeof createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator
      >[0]['applyGeneration'];
    }>,
  ) => {
    const { accountContext } = input;
    if (params.resolveQualifiedConnectedAccountV4Support?.() !== 'advertised') {
      return null;
    }
    const qualifiedService =
      resolveQualifiedConnectedAccountServiceForIngressServiceId(
        input.serviceId,
      );
    if (!qualifiedService) return null;
    return createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
      ...qualifiedAuthGroupQuotaDependencies,
      accountScope: accountContext
        ? accountContext.bootstrap.attribution
        : params.externalActionAccountId
          ? {
              serverId: params.serverId,
              accountId: params.externalActionAccountId,
            }
          : undefined,
      isCurrent: async (signal) => {
        await assertSessionAccountCurrent(input.sessionId, accountContext, undefined, signal);
        return true;
      },
      ...(accountContext
        ? {
            accountUsageStore: accountContext.providerAccountUsageStore,
            probeQuotaSnapshotsForGroup: async (
              request: Parameters<
                typeof qualifiedAuthGroupQuotaDependencies.probeQuotaSnapshotsForGroup
              >[0],
            ) => {
              await assertSessionAccountCurrent(
                input.sessionId,
                accountContext,
                undefined,
                request.signal,
              );
              return (
                (await accountContext.connectedServiceQuotasCoordinator?.probeGroupQuotaSnapshots(
                  {
                    ...request,
                    serviceId: buildQualifiedPluginContributionKey(
                      request.serviceId,
                    ),
                  },
                )) ?? {
                  status: 'incomplete' as const,
                  requestedProfileCount: request.profileIds.length,
                  completedProfileCount: 0,
                  reason: 'probe_unavailable' as const,
                }
              );
            },
            consumeAvailableRecoveryCreditForProfile: async (
              request: Parameters<
                typeof qualifiedAuthGroupQuotaDependencies.consumeAvailableRecoveryCreditForProfile
              >[0],
            ) => {
              await assertSessionAccountCurrent(
                input.sessionId,
                accountContext,
              );
              return (
                (await accountContext.connectedServiceQuotasCoordinator?.consumeAvailableRecoveryCreditForProfile(
                  {
                    ...request,
                    serviceId: buildQualifiedPluginContributionKey(
                      request.serviceId,
                    ),
                  },
                )) ?? {
                  ok: false as const,
                  errorCode:
                    'connected_service_quota_recovery_credit_not_available',
                  error: 'Quota recovery is unavailable',
                }
              );
            },
          }
        : {}),
      token:
        accountContext?.bootstrap.credentials.token ?? params.credentials.token,
      quotaFreshnessMs: requestAuthGroupQuotaFreshnessMs,
      nowMs: () => Date.now(),
      leases: qualifiedConnectedAccountAuthGroupSwitchLeases,
      prepareCandidateForSwitch: async (candidate) => {
        await assertSessionAccountCurrent(input.sessionId, accountContext, undefined, candidate.signal);
        if (!accountContext)
          return await prepareQualifiedAuthGroupCandidateForSwitch(candidate);
        const serviceId = resolveFirstPartyConnectedAccountServiceId(
          candidate.serviceId,
        );
        if (!serviceId) return { status: 'ready' as const };
        return (
          (await accountContext.connectedServiceRefreshCoordinator?.prepareConnectedServiceAuthGroupCandidateForSwitch(
            {
              serviceId,
              profileId: candidate.profileId,
              reason: candidate.reason,
              signal: candidate.signal,
            },
          )) ?? {
            status: 'ineligible' as const,
            memberState: {
              credentialHealthStatus: 'refresh_failed_retryable' as const,
            },
          }
        );
      },
      // Session application carries the canonical qualified service key; first-party
      // scalars persist only inside the bounded V2/V3 compatibility seams.
      applyGeneration: async (generation) => {
        if (input.applyGeneration) return await input.applyGeneration(generation);
        if (input.sessionId === null) throw new Error('execution_run_generation_application_unavailable');
        return await buildConnectedServiceAuthApplicationSession({
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
            });
      },
    });
  };

  const connectedServiceAuthGroupPreTurnSwitchCoordinator = {
    credentialHealthSwitchLeases: qualifiedConnectedAccountAuthGroupSwitchLeases,
    credentialHealthQuotaFreshnessMs: requestAuthGroupQuotaFreshnessMs,
    switchBeforeTurn: async (
      input: ConnectedServicePreTurnSwitchInput,
    ): Promise<ConnectedServicePreTurnSwitchResult> => {
      const sessionId =
        typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
      if (!sessionId) return { status: 'session_not_found' };
      const tracked =
        Array.from(params.pidToTrackedSession.values()).find(
          (child) => child.happySessionId === sessionId,
        ) ?? null;
      if (!tracked) return { status: 'session_not_found' };
      const parsedServiceId =
        readBuiltInLegacyConnectedAccountServiceKeyIngress(input.serviceId);
      if (!parsedServiceId) {
        return {
          status: 'qualified_connected_account_v4_unavailable',
          generation: 0,
        };
      }
      return await withSessionAccountContext(sessionId, async (accountContext) => {
        const proactiveCoordinator = await createSessionQualifiedAuthGroupSwitchCoordinator({
          sessionId,
          accountContext,
          serviceId: parsedServiceId,
          reason: input.reason,
        });
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
        const proactiveSwitchResult = await withSessionAccountHome(
          accountContext,
          () =>
            proactiveCoordinator.switchBeforeTurn({
              ...input,
              serviceId: qualifiedService,
            }),
        );
        logger.debug(
          '[DAEMON RUN] Connected-service proactive quota switch attempt',
          {
            trigger: 'automatic_group_switch',
            decision: 'qualified_v4_switch_before_turn',
            sessionId,
            serviceId: input.serviceId,
            groupId: input.groupId,
            reason: input.reason,
            resultStatus: proactiveSwitchResult.status,
            routedThroughQualifiedV4: true,
          },
        );
        return proactiveSwitchResult;
      }, undefined, input.signal);
    },
    applyCommittedGeneration: async (
      input: Readonly<{
        sessionId: string;
        serviceId: ConnectedAccountServiceKey;
        groupId: string;
        activeProfileId: string;
        generation: number;
        credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
        reason: string;
        allowRestart?: boolean;
        executionAuthority?: ConnectedServiceGenerationExecutionAuthority;
      }>,
    ) => {
      const sessionId = input.sessionId.trim();
      const tracked =
        Array.from(params.pidToTrackedSession.values()).find(
          (child) => child.happySessionId === sessionId,
        ) ?? null;
      if (!sessionId || !tracked) {
        return {
          status: 'session_not_found',
          generation: input.generation,
          errorCode: 'session_not_found',
        };
      }
      const parsedServiceId =
        readBuiltInLegacyConnectedAccountServiceKeyIngress(input.serviceId);
      if (!parsedServiceId) {
        return {
          status: 'generation_apply_failed',
          generation: input.generation,
          errorCode: 'qualified_connected_account_v4_unavailable',
        };
      }
      return await withSessionAccountContext(sessionId, async (accountContext) => {
        const recipientCoordinator = await createSessionQualifiedAuthGroupSwitchCoordinator({
          sessionId,
          accountContext,
          serviceId: parsedServiceId,
          reason: input.reason,
          allowRestart: input.allowRestart,
          ...(input.executionAuthority
            ? { executionAuthority: input.executionAuthority }
            : {}),
        });
        if (!recipientCoordinator) {
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
        const result = await withSessionAccountHome(accountContext, () =>
          recipientCoordinator.applyCommittedGeneration({
            ...input,
            serviceId: qualifiedService,
          }),
        );
        if (
          input.allowRestart === false &&
          result.status === 'generation_apply_failed' &&
          result.errorCode === 'restart_failed'
        ) {
          return {
            ...result,
            errorCode: 'restart_disallowed_by_execution_policy',
          };
        }
        return result;
      });
    },
    applyCredentialUpdate: async (
      input: Readonly<{
        signal?: AbortSignal;
        sessionId: string;
        serviceId: Parameters<typeof readConnectedServiceCredentialApplicationState>[0]['serviceId'];
        profileId: string;
        reason: 'account_changed' | 'auth_expired';
        executionAuthority: ConnectedServiceExecutionAuthorityV1;
      }>,
    ) => {
      return await applyConnectedServiceCredentialUpdate({ ...input,
        core: connectedServiceSessionAuthSwitchCore,
        getTrackedSession: sessionId => findTrackedSessionByHappySessionId(params.pidToTrackedSession.values(), sessionId),
        applyGeneration: request => buildConnectedServiceAuthApplicationSession({
          sessionId: request.sessionId, restartReason: input.reason, commitAccountSwitchEvents: false,
          allowRestart: input.executionAuthority !== 'passive_projection', executionAuthority: input.executionAuthority,
        })({ ...request, reason: input.reason }),
      });
    },
  };

  /**
   * Gated restart adapter consumed by the canonical session-auth application owner
   * when a provider cannot adopt the selected credential in place. Credential refresh,
   * reconnect, manual selection, and quota switching all reach that owner first.
   */
  const requestConnectedServiceRefreshRestartSignal = async (
    signalParams: Readonly<{
      pid: number;
      delayMs: number;
      preferProcessGroup?: boolean;
      shouldSignal?: () => boolean;
      onSignalFailure: (error: unknown) => void;
      restartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticInput;
      recordRestartDiagnostic?: (
        record: ConnectedServiceDaemonRestartDiagnosticRecord,
      ) => void;
      nowMs?: () => number;
    }>,
  ): Promise<Readonly<{ signaled: boolean }>> => {
    const tracked = params.pidToTrackedSession.get(signalParams.pid) ?? null;
    if (!tracked) {
      signalParams.onSignalFailure(
        new Error('refresh_restart_tracked_session_missing'),
      );
      return { signaled: false };
    }
    const diagnostic = signalParams.restartDiagnostic;
    const sessionId =
      typeof diagnostic?.sessionId === 'string' && diagnostic.sessionId.trim()
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
          serviceId:
            typeof diagnostic?.serviceId === 'string'
              ? diagnostic.serviceId
              : '',
          profileId:
            typeof diagnostic?.profileId === 'string'
              ? diagnostic.profileId
              : '',
          groupId:
            typeof diagnostic?.groupId === 'string' ? diagnostic.groupId : '',
          generation:
            typeof diagnostic?.generation === 'number'
              ? diagnostic.generation
              : null,
        }),
        restartSignalDelayMs: signalParams.delayMs,
        restartDiagnostic: diagnostic ?? {
          trigger: 'refresh_triggered_restart',
          sessionId,
        },
        onSignalFailureLogMessage:
          '[DAEMON RUN] Failed to restart connected-service credential-refreshed session',
      });
    } catch (error) {
      signalParams.onSignalFailure(error);
      return { signaled: false };
    }
  };

  let foregroundAgentRuntimeHttpPort: number | null = null;
  const foregroundAgentRuntimeAdmission =
    createForegroundAgentRuntimeAdmissionOwner({
      connectedServiceRuntimeRegistry,
      prepare: async (request, signal) => {
        let context: RequesterSessionRuntimeContext | null = null;
        const releaseUnadoptedContext = async () => {
          await releaseSessionAccountContext(context);
        };
        try {
          const accountSessionId =
            request.existingSessionId ?? request.sessionId;
          context = await resolveSessionAccountContext(accountSessionId);
          const requester = context;
          const isForegroundAccountCurrent = async (
            canonicalSessionId?: string,
          ): Promise<boolean> => {
            try {
              if (requester)
                return (
                  Boolean(requester.readAccountSettingsSnapshot()) &&
                  requester.bootstrap.getBoundSessionId() ===
                    accountSessionId &&
                  requester.bootstrap.attribution.serverId ===
                    params.serverId &&
                  requester.bootstrap.attribution.machineId ===
                    params.machineId &&
                  (await requester.isCurrent())
                );
              return await runWithServerHttpBaseUrl(
                params.serverBaseUrl,
                async () => {
                  const profile = await fetchAccountProfile({
                    token: params.credentials.token,
                  });
                  if (
                    params.externalActionAccountId &&
                    profile.id !== params.externalActionAccountId
                  )
                    return false;
                  const snapshot = getActiveAccountSettingsSnapshot();
                  if (
                    (snapshot &&
                      snapshot.scopeKey !==
                        resolveForegroundAccountSettingsScopeKey(
                          params.credentials,
                        )) ||
                    (request.accountSettingsScopeKey &&
                      snapshot?.scopeKey !== request.accountSettingsScopeKey)
                  )
                    return false;
                  // A fresh foreground launch has no Home Session yet. Its authenticated
                  // Account owns preparation; claim rechecks the published canonical Session.
                  const publishedSessionId =
                    canonicalSessionId ?? request.existingSessionId;
                  if (!publishedSessionId) return true;
                  const session = await fetchForegroundSessionById({ reason: 'session-control',
                    token: params.credentials.token,
                    serverUrl: params.serverBaseUrl,
                    sessionId: publishedSessionId,
                  });
                  return (
                    session?.id === publishedSessionId &&
                    readForegroundSessionAccessRole(session) === 'owner'
                  );
                },
              );
            } catch {
              return false;
            }
          };
          if (!(await isForegroundAccountCurrent())) {
            await releaseUnadoptedContext();
            return {
              ok: false as const,
              error: createForegroundProviderError(
                'provider_authorization_changed',
                { machineId: request.machineId },
              ),
            };
          }
          const activateSessionPurposeBindings = requester
            ? requester.activateSessionPurposeBindings
            : params.activateSessionPurposeBindings;
          const resolvePurposeSnapshot = requester
            ? requester.resolveCurrentSessionPurposeBindingSnapshot
            : params.resolveCurrentSessionPurposeBindingSnapshot;
          const requesterHomeActions = requester
            ? createAccountServerActionDeps({
                token: requester.bootstrap.credentials.token,
                serverId: requester.bootstrap.attribution.serverId,
                serverHttpBaseUrl: requester.bootstrap.serverHttpBaseUrl,
              }).homeDomainAction
            : undefined;
          const prepared = await withSessionAccountHome(requester, () =>
            prepareForegroundAgentRuntimeAdmission(request, {
              signal: AbortSignal.any([signal, shutdownCancellationDomains.daemonWorkSignal]),
              isSessionAccountCurrent: isForegroundAccountCurrent,
              ...(requester
                ? {
                    requesterSessionBootstrap: requester.bootstrap,
                    requesterSessionRuntimeContext: requester,
                    connectedAccountsOwner: requester.connectedAccountsOwner,
                    subscribeAccountSettingsSnapshot:
                      requester.subscribeAccountSettingsSnapshot,
                    resolveManagedPurposeBindingIntent:
                      requester.resolveManagedPurposeBindingIntent,
                  }
                : {}),
              ...(activateSessionPurposeBindings
                ? {
                    activateSessionPurposeBindings:
                      activateSessionPurposeBindings,
                  }
                : {}),
              ...(resolvePurposeSnapshot
                ? {
                    resolveExternalAgentSessionPurposeBindingSnapshot: async ({
                      authorizedPurposes,
                      signal,
                    }) =>
                      await resolvePurposeSnapshot({
                        authorizedPurposes,
                        signal,
                      }),
                  }
                : {}),
              ...(requester && requesterHomeActions
                ? {
                    resolveSessionTeamCredentialBindingIntents: async ({
                      teamResourceSelections,
                      signal,
                    }) => {
                      if (!(await isForegroundAccountCurrent()))
                        throw new Error('requester_session_not_current');
                      return await resolveForegroundTeamCredentialBindingIntents(
                        {
                          teamResourceSelections,
                          signal,
                          resolveTeamCredentialResourceCatalog:
                            createForegroundTeamResourceCatalogResolver({
                              homeDomainAction: requesterHomeActions,
                              serverId:
                                requester.bootstrap.attribution.serverId,
                              accountId:
                                requester.bootstrap.attribution.accountId,
                            }),
                        },
                      );
                    },
                  }
                : !requester &&
                    params.resolveSessionTeamCredentialBindingIntents
                  ? {
                      resolveSessionTeamCredentialBindingIntents:
                        params.resolveSessionTeamCredentialBindingIntents,
                    }
                  : {}),
              resolveConnectedServiceAuthForSpawn: async (input) => {
                const entry = findCatalogEntry(input.agentId);
                if (
                  !entry ||
                  readDeclaredCatalogConnectedServiceIds(entry).length === 0
                ) {
                  return null;
                }
                if (!(await isForegroundAccountCurrent()))
                  throw new Error('requester_session_not_current');
                const accountSettings =
                  (requester
                    ? requester.readAccountSettingsSnapshot()
                    : getActiveAccountSettingsSnapshot()
                  )?.settings ?? null;
                const resumeReachabilityRequired =
                  Boolean(input.vendorResumeId) &&
                  resolveConnectedServicesProviderStateSharingPolicyV1(
                    (
                      accountSettings as Readonly<
                        Record<string, unknown>
                      > | null
                    )?.connectedServicesProviderStateSharingSettingsV1,
                    input.agentId,
                  ).stateMode === 'shared';
                return await withSessionAccountHome(requester, () =>
                  resolveConnectedServiceAuthForSpawn({
                    ...input,
                    agentId: input.agentId,
                    activeServerDir:
                      requester?.activeServerDir ??
                      configuration.activeServerDir,
                    baseDir:
                      requester?.connectedServicesMaterializationBaseDir ??
                      params.connectedServicesMaterializationBaseDir,
                    credentials:
                      requester?.bootstrap.credentials ?? params.credentials,
                    api: requester?.api ?? params.api,
                    accountUsageStore:
                      requester?.providerAccountUsageStore ??
                      providerAccountUsageStore,
                    quotaFreshnessMs: 5 * 60_000,
                    nowMs: () => Date.now(),
                    authGroupSwitchCoordinator: requester
                      ? requester.authGroupSwitchCoordinator
                      : connectedServiceAuthGroupPreTurnSwitchCoordinator,
                    predictiveSwitchGuard: requester
                      ? (requester.predictiveSwitchGuard ?? null)
                      : (connectedServicePredictiveSwitchGuard ?? null),
                    accountSettings,
                    processEnv: params.processEnv ?? process.env,
                    credentialRefreshService: requester
                      ? requester.connectedServiceRefreshCoordinator
                      : params.getConnectedServiceRefreshCoordinator(),
                    ...(requester
                      ? {
                          allowNativeAccountState: false,
                          connectedAccountsOwner:
                            requester.connectedAccountsOwner,
                          qualifiedConnectedAccountApi:
                            requester.qualifiedConnectedAccountApi,
                          isAccountRuntimeCurrent: isForegroundAccountCurrent,
                        }
                      : {}),
                    resumeReachabilityRequired,
                  }),
                );
              },
              resolveDaemonSpawnHooks: async (agentId) => {
                const entry = findCatalogEntry(agentId);
                const getDaemonSpawnHooks = entry?.getDaemonSpawnHooks;
                return getDaemonSpawnHooks ? await getDaemonSpawnHooks() : null;
              },
              connectedAccountRequestAuthRegistry,
              resolveConnectedAccountRequestAuthHttpPort:
                requireConnectedAccountRequestAuthHttpPort,
              connectedServicesMaterializationBaseDir:
                requester?.connectedServicesMaterializationBaseDir ??
                params.connectedServicesMaterializationBaseDir,
            }),
          );
          if (!prepared.ok) {
            await releaseUnadoptedContext();
            return prepared;
          }
          return {
            ok: true as const,
            prepared: {
              ...prepared.prepared,
              cleanup: async () => {
                try {
                  await prepared.prepared.cleanup();
                } finally {
                  await releaseUnadoptedContext();
                }
              },
            },
          };
        } catch (error) {
          await releaseUnadoptedContext();
          logger.debug(
            '[DAEMON RUN] Foreground Session Account admission unavailable',
            { error: serializeAxiosErrorForLog(error) },
          );
          return {
            ok: false as const,
            error: createForegroundProviderError(
              'provider_authorization_changed',
              { machineId: request.machineId },
            ),
          };
        }
      },
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
          publicReleaseRing: configuration.publicReleaseRing,
          trackedSessions: params.pidToTrackedSession,
          ...input,
        });
      },
    });
  const externalSessionHostOperationOwner =
    params.externalSessionHostOperationOwner ??
    createExternalSessionHostOperationOwner();
  const createSessionManagedProviderCustodyDispatchForSession = async (
    sessionId: string,
  ): Promise<RunnerManagedServicesCustodyDispatchV1> => {
    const transport = await resolveSessionTransportContext({ reason: 'session-control',
      credentials: params.credentials,
      idOrPrefix: sessionId,
    });
    if (!transport.ok || transport.sessionId !== sessionId) {
      throw new PluginError({
        code: 'plugin_services_managed_provider_custody_unavailable',
        message: 'Runner managed Provider custody transport is unavailable',
      });
    }
    return async (request, options) => {
      if (options?.signal?.aborted) {
        throw new PluginError({
          code: 'plugin_operation_aborted',
          message: 'Runner managed Provider custody operation was aborted',
        });
      }
      const rpc = {
        token: params.credentials.token,
        sessionId: transport.sessionId,
        method: `${transport.sessionId}:${RUNNER_MANAGED_SERVICES_CUSTODY_RPC_METHOD}`,
        request,
      };
      const raw =
        transport.mode === 'plain'
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
          message: 'Runner managed Provider custody operation was aborted',
        });
      }
      return RunnerManagedServicesCustodyResultV1Schema.parse(raw);
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
    const transport = await resolveSessionTransportContext({ reason: 'session-control',
      credentials: params.credentials,
      idOrPrefix: sessionId,
    });
    if (!transport.ok || transport.sessionId !== sessionId) {
      throw new PluginError({
        code: 'plugin_services_managed_provider_custody_unavailable',
        message: 'Runner managed-service request transport is unavailable',
      });
    }
    return Object.freeze({
      async call(
        rpcInput: Readonly<{
          method: string;
          request: unknown;
          timeoutMs: number | null;
          signal?: AbortSignal;
        }>,
      ): Promise<unknown> {
        const common = {
          token: params.credentials.token,
          sessionId: transport.sessionId,
          method: `${transport.sessionId}:${rpcInput.method}`,
          request: rpcInput.request,
          timeoutMs: rpcInput.timeoutMs,
          ...(rpcInput.signal ? { signal: rpcInput.signal } : {}),
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
      dispatch: await createSessionManagedProviderCustodyDispatch(scope),
      endpointReadRpc: await createSessionManagedServiceEndpointReadRpc(
        scope.sessionId,
      ),
    });
  };
  const runnerDaemonPluginServicesHost = createDaemonRunnerInvocationServices({
    params, findTrackedSessionByHappySessionId, runnerExecutionRunSnapshots, acquireDaemonPluginRuntimeRegistryLease, createSessionManagedProviderCustodyDispatch, createSessionManagedProviderCustodyClient, resolveSessionAccountContext, withSessionAccountHome, shutdownCancellationDomains, releaseSessionAccountContext, connectedServiceRuntimeRegistry,
  });
  const withRetainedRunnerAgentServiceBinding = async <T>(
    binding: AgentSessionRunnerBindingV1,
    runnerSnapshotIdentity: string,
    operation: (attested: RetainedRunnerAgentServiceBinding) => Promise<T>,
  ): Promise<T> => {
    const lease = await acquireDaemonPluginRuntimeRegistryLease();
    try {
      const attest = lease.registry.attestRetainedRunnerAgentServiceBinding;
      if (!attest) throw new PluginError({
        code: 'plugin_services_retained_generation_untrusted',
        message: 'Retained Agent source attestation is unavailable',
      });
      const attested = await attest({ binding, runnerSnapshotIdentity });
      const result = await operation(attested);
      await attested.assertStillAvailable();
      return result;
    } finally {
      await lease.release();
    }
  };
  const runnerAgentDaemonFacetService = createRunnerAgentDaemonFacetService({
    externalSessionHostOperationOwner,
    machineId: params.machineId,
    authorizeCurrent: async ({ sessionId, runner, retainedAgent }) => {
      const tracked = findTrackedSessionByHappySessionId(
        params.pidToTrackedSession.values(),
        sessionId,
      );
      if (
        !tracked ||
        !authorizeTrackedRunnerAgentDaemonServiceOperation({
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
        (
          await authorizeRunnerAgentNewTurn({
            retainedAgent,
          })
        ).status === 'admitted'
      );
    },
    authorizeActiveTurn: async ({
      sessionId,
      runner,
      retainedAgent,
      witness,
    }) => {
      const tracked = findTrackedSessionByHappySessionId(
        params.pidToTrackedSession.values(),
        sessionId,
      );
      if (
        !tracked ||
        !authorizeTrackedRunnerAgentDaemonServiceOperation({
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
        (
          await authorizeRunnerAgentNewTurn({
            retainedAgent,
          })
        ).status === 'admitted'
      );
    },
    resolveRetainedExternalSessionAgentContribution: async ({
      retainedAgent,
      runner,
    }) => {
      try {
        const verified = await verifyRunnerAgentBindingAgainstGeneration({
          paths: resolvePluginStorePaths({
            happyHomeDir: configuration.happyHomeDir,
          }),
          binding: retainedAgent,
          developmentRunnerSnapshotIdentity: runner.snapshotIdentity,
        });
        const leaf = await loadRetainedAgentRuntimeLeaf({
          paths: resolvePluginStorePaths({ happyHomeDir: configuration.happyHomeDir }),
          binding: retainedAgent,
          developmentRunnerSnapshotIdentity: runner.snapshotIdentity,
        });
        return Object.freeze({ ...projectManifestAgentContribution({
          definition: verified.declaredAgent,
          provenance:
            verified.manifestAuthority === 'bundled_first_party'
              ? 'first_party'
              : 'external',
          source: {
            kind:
              verified.manifestAuthority === 'bundled_first_party'
                ? 'bundled'
                : 'package',
          },
          pluginId: verified.manifest.id,
        }), catalogEntry: leaf.catalogEntry, dispose: leaf.dispose });
      } catch {
        return null;
      }
    },
    snapshotVoiceAuthority: async ({ retainedAgent, runner }) => {
      const verifiedRetainedAgent =
        await attestRetainedAgentForVoice({
          paths: resolvePluginStorePaths({ happyHomeDir: configuration.happyHomeDir }),
          retainedAgent,
          runner,
        });
      if (!verifiedRetainedAgent) return null;
      const lease = await acquireDaemonPluginRuntimeRegistryLease();
      try {
        if (
          (
            await authorizeRunnerAgentNewTurn({
              retainedAgent: verifiedRetainedAgent.binding,
            })
          ).status !== 'admitted'
        ) {
          return null;
        }
        const voiceAuthority =
          resolveRetainedAgentSessionRealtimeVoiceAuthority({
            runtimeRegistry: lease.registry,
            retainedAgent: verifiedRetainedAgent.binding,
          });
        if (!voiceAuthority) return null;
        return {
          agentSourceCustody: verifiedRetainedAgent.binding.sourceCustody,
          providers: snapshotAgentSessionRealtimeVoiceProviders({
            runtimeRegistry: lease.registry,
            policyAgentRef: voiceAuthority.policyAgentRef,
          }).flatMap(({ provider, lifecycle }) => {
            const declaration = voiceAuthority.resolveDeclaration(
              provider.identity,
            );
            if (
              !declaration ||
              !voiceAuthority.isCurrent(provider.identity) ||
              voiceAuthority.resolveProviderOccurrenceId(provider.identity) !==
                lifecycle.occurrenceId
            ) {
              return [];
            }
            return [
              {
                provider: provider.identity,
                providerGeneration: lifecycle.occurrenceId,
                declaration,
              },
            ];
          }),
        };
      } finally {
        await lease.release();
      }
    },
    waitVoiceAuthorityRetired: async ({
      retainedAgent,
      runner,
      provider,
      providerGeneration,
      signal,
    }) => {
      const verifiedRetainedAgent =
        await attestRetainedAgentForVoice({
          paths: resolvePluginStorePaths({ happyHomeDir: configuration.happyHomeDir }),
          retainedAgent,
          runner,
        });
      if (!verifiedRetainedAgent) return;
      const lease = await acquireDaemonPluginRuntimeRegistryLease();
      let retirementSignal: AbortSignal | null = null;
      try {
        if (
          (
            await authorizeRunnerAgentNewTurn({
              retainedAgent: verifiedRetainedAgent.binding,
            })
          ).status !== 'admitted'
        ) {
          return;
        }
        const voiceAuthority =
          resolveRetainedAgentSessionRealtimeVoiceAuthority({
            runtimeRegistry: lease.registry,
            retainedAgent: verifiedRetainedAgent.binding,
          });
        retirementSignal =
          voiceAuthority &&
          voiceAuthority.isCurrent(provider) &&
          voiceAuthority.resolveProviderOccurrenceId(provider) ===
            providerGeneration
            ? voiceAuthority.resolveRetirementSignal(provider)
            : null;
      } finally {
        await lease.release();
      }
      if (!retirementSignal || retirementSignal.aborted) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const onRetired = () => {
          cleanup();
          resolve();
        };
        const onAborted = () => {
          cleanup();
          reject(new Error('voice_authority_wait_aborted'));
        };
        const cleanup = () => {
          retirementSignal?.removeEventListener('abort', onRetired);
          signal?.removeEventListener('abort', onAborted);
        };
        retirementSignal.addEventListener('abort', onRetired, { once: true });
        signal?.addEventListener('abort', onAborted, { once: true });
        if (retirementSignal?.aborted) {
          onRetired();
        } else if (signal?.aborted) {
          onAborted();
        }
      });
    },
  });
  const onChildExitedBase = createOnChildExited({
    skillStore: params.skillStore,
    observeSessionScopeExit: async tracked => {
      const sessionId = normalizeOptionalString(tracked.happySessionId);
      const runner = resolveTrackedSessionRunnerIdentity(tracked);
      // Explicit Stop retains the runner tuple until its attachment-fenced
      // control retirement publishes `stopped`. Unexpected exits, including
      // startup refusals, have no such later publisher.
      if (sessionId && !/^PID-\d+$/.test(sessionId) && tracked.stopRequestedAtMs === undefined
        && runner?.processStartTimeMs !== undefined) {
        const expectedRunner = { pid: runner.pid, startTimeMs: runner.processStartTimeMs };
        const retire = async (context: NonNullable<StopSessionOptions['metadataContext']>) => {
          const rawSession = await fetchSessionByIdCompat({ reason: 'session-control', token: context.credentials.token, sessionId });
          if (!rawSession) return;
          await updateSessionMetadataWithRetry({ ...context, token: context.credentials.token,
            sessionId, rawSession, updater: async metadata => {
              if (params.pidToTrackedSession.get(tracked.pid) !== tracked) return metadata;
              const retired = await retireObservedSessionRunnerMetadata({ metadata, expectedRunner,
                trackedSession: tracked, sessionId, happyHomeDir: configuration.happyHomeDir });
              return params.pidToTrackedSession.get(tracked.pid) === tracked ? retired : metadata;
            } });
        };
        const requester = tracked.requesterSessionRuntimeContext;
        if (requester) {
          // Exit tracking has already marked this runner as retiring. Consume
          // its retained Account lifetime before cleanup releases it; resolving
          // a new live-runner requester here would correctly refuse that exit.
          await runWithServerHttpBaseUrl(requester.bootstrap.serverHttpBaseUrl, () => retire({
            credentials: requester.bootstrap.credentials,
            currentness: { verifyCurrent: () => requester.isCurrent() },
          }));
        } else {
          await withSessionStopMetadataContext(sessionId, retire,
            tracked.requesterWorkAttributionV1 ?? tracked.spawnOptions?.requesterWorkAttributionV1);
        }
      }
      await params.observeSessionScopeExit?.(tracked);
    },
    ownerRemainder,
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
          const captured = await params
            .getApiMachineForSessions()
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
          logger.debug(
            '[DAEMON RUN] Failed to capture Session publisher authority before respawn; marker will retain recovery custody',
            {
              sessionId,
              pid: tracked.pid,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
    },
    retireSessionRunnerOwnedManagedServices: async ({ sessionId }) => {
      const retiredPids =
        await managedServiceDurabilityOwner?.retireSessionRunnerOwnedProjections(
          { sessionId },
        );
      if (retiredPids?.length) {
        logger.debug(
          '[DAEMON RUN] Retired managed services orphaned by an exited Session runner',
          {
            sessionId,
            retiredPids,
          },
        );
      }
    },
    onUnexpectedExit: (tracked, exit) => {
      const transientSpawnOptions = tracked.happySessionId
        ? takeVersionRuntimeRefreshTransientSpawnOptions(
            tracked.happySessionId,
            tracked.pid,
          )
        : undefined;
      const disposition = sessionRunnerRespawnManager.handleUnexpectedExit(
        tracked,
        exit,
        {
          forceRestart: params.connectedServicesRestartRequestedPids.has(
            tracked.pid,
          ),
          ...(tracked.plannedRestartReason ? { restartReason: tracked.plannedRestartReason } : {}),
          ...(transientSpawnOptions
            ? { spawnOptionsOverride: transientSpawnOptions }
            : {}),
        },
      );
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
    shouldPreserveSessionMarkerOnExit: async ({
      trackedSession,
      unexpected,
    }) => {
      if (
        unexpected &&
        trackedSession.startedBy === 'daemon' &&
        trackedSession.publishedTerminalControlServiceabilityAttachmentLifecycle !==
          'borrowed'
      )
        return true;
      return await shouldRetainTrackedTerminalHostExitMarker({
        tracked: trackedSession,
        happyHomeDir: configuration.happyHomeDir,
      });
    },
    onFinalTrackedSessionExitStaged: async ({ pid, trackedSession }) => {
      if (params.connectedServicesRestartRequestedPids.has(pid)) return;
      const sessionId = normalizeOptionalString(trackedSession.happySessionId);
      if (!sessionId) return;
      const terminal =
        trackedSession.happySessionMetadataFromLocalWebhook?.terminal ??
        trackedSession.hostedTerminal;
      const attachmentInfo = await readTerminalHostAttachmentInfo({
        happyHomeDir: configuration.happyHomeDir,
        sessionId,
      }).catch((error) => {
        logger.debug(
          '[DAEMON RUN] Preserved runner-exit marker but could not read its terminal-host attachment',
          {
            sessionId,
            pid,
            error,
          },
        );
        throw error;
      });
      const borrowedAttachmentId =
        trackedSession.publishedTerminalControlServiceabilityAttachmentLifecycle ===
        'borrowed'
          ? trackedSession.publishedTerminalControlServiceabilityAttachmentId
          : attachmentInfo?.version === 3 &&
              (!trackedSession.publishedTerminalControlServiceabilityAttachmentId ||
                trackedSession.publishedTerminalControlServiceabilityAttachmentId ===
                  attachmentInfo.attachmentId)
            ? attachmentInfo.attachmentId
            : undefined;
      if (borrowedAttachmentId) {
        const terminalMode =
          attachmentInfo?.version === 3 &&
          attachmentInfo.attachmentId === borrowedAttachmentId
            ? resolveDisconnectedTerminalMode({
                terminal,
                hostKind: attachmentInfo.handle.kind,
                attachmentId: borrowedAttachmentId,
              })
            : terminal?.mode;
        if (terminalMode && terminalMode !== 'plain') {
          await retireTerminalControlServiceabilityForCurrentAccount({
            sessionId,
            attachmentId: borrowedAttachmentId,
            terminalMode,
          });
        }
        if (
          attachmentInfo?.version === 3 &&
          attachmentInfo.attachmentId === borrowedAttachmentId
        ) {
          const disposition = await executeTerminalHostDisposition({
            happyHomeDir: configuration.happyHomeDir,
            sessionId,
            expectedAttachmentId: borrowedAttachmentId,
            intent: { kind: 'release_borrowed_host', reason: 'provider_exit' },
          });
          if (disposition.status !== 'retired') {
            throw new Error('borrowed_terminal_attachment_retirement_failed');
          }
        }
        return;
      }
      if (trackedSession.stopRequestedReason === 'user_process_kill') return;
      const candidate = await resolveTrackedSessionTerminalHostExitCandidate({
        tracked: trackedSession,
        pid,
        happyHomeDir: configuration.happyHomeDir,
        attachmentInfo,
      });
      if (candidate) registerDisconnectedTerminalHostCandidate(candidate);
    },
  });
  onChildExited = async (pid, exit) => {
    const trackedBeforeExit = params.pidToTrackedSession.get(pid) ?? null;
    const startupPid = trackedBeforeExit?.spawnStartupAwaiterPid ?? pid;
    const startupResolver = params.pidToSpawnResultResolver.get(startupPid);
    const connectedServiceRestartWasRequested =
      params.connectedServicesRestartRequestedPids.has(pid);
    await onChildExitedBase(pid, exit);
    notifySessionLiveWorkChanged();
    const trackedAfterExit = params.pidToTrackedSession.get(pid) ?? null;
    if (
      trackedBeforeExit &&
      ![...params.pidToTrackedSession.values()].includes(trackedBeforeExit) &&
      startupResolver &&
      params.pidToSpawnResultResolver.get(startupPid) === startupResolver
    ) {
      startupResolver({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
        errorMessage: 'Child process exited before startup readiness completed',
      });
    }
    void params.connectedServiceGroupHomeCleanupScheduler
      ?.cleanupPendingDeletedGroupHomes()
      .catch((error) => {
        logger.debug(
          '[DAEMON RUN] Connected-service group home cleanup tick failed (non-fatal)',
          error,
        );
      });
    void params.connectedServiceMaterializedHomeCleanupScheduler
      ?.cleanupPendingMaterializedHomes()
      .catch((error) => {
        logger.debug(
          '[DAEMON RUN] Connected-service materialized home cleanup tick failed (non-fatal)',
          error,
        );
      });
    if (trackedBeforeExit === null || trackedAfterExit === trackedBeforeExit) {
      return;
    }
    await releaseExecutionRunAuthorityForRunnerExit({
      runnerPid: trackedBeforeExit.sessionRunnerPid ?? pid,
      runnerIdentity: trackedBeforeExit,
    });
    await runnerExecutionRunSnapshots.releaseForRunnerExit(trackedBeforeExit);
    if (trackedAfterExit !== null) {
      logger.debug(
        '[DAEMON RUN] PID ownership changed while observing child exit; preserving replacement runtime custody',
        {
          pid,
          exitedSessionId: trackedBeforeExit.happySessionId,
          replacementSessionId: trackedAfterExit.happySessionId,
        },
      );
      return;
    }
    if (
      trackedBeforeExit.agentRuntimeDaemonServiceAuthorityFilePath &&
      trackedBeforeExit.agentRuntimeDaemonServiceCapabilityHash
    ) {
      await removeAgentRuntimeDaemonServiceAuthorityIfOwned({
        happyHomeDir: configuration.happyHomeDir,
        publicReleaseRing: configuration.publicReleaseRing,
        path: trackedBeforeExit.agentRuntimeDaemonServiceAuthorityFilePath,
        capabilityDigest:
          trackedBeforeExit.agentRuntimeDaemonServiceCapabilityHash,
      }).catch((error) => {
        logger.debug(
          '[DAEMON RUN] Runner Agent authority owner cleanup failed (non-fatal)',
          error,
        );
        return false;
      });
    }
    delete trackedBeforeExit.agentRuntimeDaemonServiceCapabilityHash;
    delete trackedBeforeExit.agentRuntimeDaemonServiceNativeRealtimeAdmission;
    const restartWasRequested =
      connectedServiceRestartWasRequested ||
      runnerRespawnScheduledPids.has(pid);
    if (!params.pidToTrackedSession.has(pid)) {
      connectedServiceRuntimeRegistry.unregisterPid(pid);
    }
    if (connectedServiceRestartWasRequested) {
      params.connectedServicesRestartRequestedPids.delete(pid);
    }
    if (trackedBeforeExit?.happySessionId) {
      const stillLive = Array.from(params.pidToTrackedSession.values()).some(
        (child) => child.happySessionId === trackedBeforeExit.happySessionId,
      );
      if (!stillLive) {
        await connectedServiceTurnDeferralQueue.cancelSession(
          trackedBeforeExit.happySessionId,
          restartWasRequested ? 'session_restarting' : 'session_terminated',
        );
      }
      if (!stillLive && !restartWasRequested) {
        await computerRoutes?.closeSession(trackedBeforeExit.happySessionId);
        connectedServiceRuntimeAuthSwitchAttempts.clearSession(
          trackedBeforeExit.happySessionId,
        );
        connectedServiceSessionAuthSwitchCore.clearSession(
          trackedBeforeExit.happySessionId,
        );
        const retainedTerminalCandidate =
          disconnectedTerminalHostCandidates.find(
            (candidate) =>
              candidate.sessionId === trackedBeforeExit.happySessionId &&
              !terminalizedDisconnectedTerminalHostIds.has(
                candidate.attachmentId,
              ),
          );
        const retainedTerminal = retainedTerminalCandidate
          ? await superviseDisconnectedTerminalHost(retainedTerminalCandidate)
          : null;
        // The existing exact-host supervision owns absence. A surviving
        // provider still uses these Session-scoped ports/secrets; unknown
        // evidence stays fenced rather than becoming artifact absence.
        if (retainedTerminal?.state === 'unknown') {
          logger.warn(
            '[DAEMON RUN] Session hook cleanup deferred while terminal-host retirement is unproven',
            {
              sessionId: trackedBeforeExit.happySessionId,
              reason: retainedTerminal.reason,
            },
          );
        }
        if (
          (!retainedTerminal || retainedTerminal.state === 'stopped') &&
          !Array.from(params.pidToTrackedSession.values()).some(
            (child) =>
              child.happySessionId === trackedBeforeExit.happySessionId,
          )
        ) {
          await disposeSessionHookArtifactsForSession({
            happyHomeDir: configuration.happyHomeDir,
            sessionId: trackedBeforeExit.happySessionId,
          }).catch(() => {
            logger.warn('[DAEMON RUN] Session hook artifact cleanup failed', {
              sessionId: trackedBeforeExit.happySessionId,
              reason: 'artifact_cleanup_failed',
            });
          });
        }
        await disposeTerminalAttachmentInfoForSession({
          happyHomeDir: configuration.happyHomeDir,
          sessionId: trackedBeforeExit.happySessionId,
        }).catch((error) => {
          logger.debug(
            '[DAEMON RUN] Terminal attachment cleanup failed (non-fatal)',
            error,
          );
        });
        // BRW-6 privacy: when a session terminates for good (no live sibling, not restarting),
        // purge its `session`-mode browser profiles + bound on-disk partitions. Fail-closed
        // inside the owner (failed purge marks the profile unusable + audits).
        void purgeBrowserStorageForSessionDeleted(
          trackedBeforeExit.happySessionId,
        ).catch((error) => {
          logger.debug(
            '[DAEMON RUN] Browser storage session-delete purge failed (non-fatal)',
            error,
          );
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
      logger.warn(
        '[DAEMON RUN] Failed to observe connected-service restart process exit through child-exit path',
        error,
      );
    }
    const spawnCleanup = params.spawnResourceCleanupByPid.get(tracked.pid);
    if (spawnCleanup) {
      params.spawnResourceCleanupByPid.delete(tracked.pid);
      try {
        spawnCleanup();
      } catch (error) {
        logger.debug(
          '[DAEMON RUN] Failed to run spawn cleanup after connected-service restart process disappeared',
          error,
        );
      }
    }
    const attachCleanup = params.sessionAttachCleanupByPid.get(tracked.pid);
    if (attachCleanup) {
      params.sessionAttachCleanupByPid.delete(tracked.pid);
      void attachCleanup().catch((error) => {
        logger.debug(
          '[DAEMON RUN] Failed to run attach cleanup after connected-service restart process disappeared',
          error,
        );
      });
    }
    params.pidToTrackedSession.delete(tracked.pid);
    notifySessionLiveWorkChanged();
    params.connectedServicesRestartRequestedPids.delete(tracked.pid);
    connectedServiceRuntimeRegistry.unregisterPid(tracked.pid);
    sessionRunnerRespawnManager.handleUnexpectedExit(tracked, exit, {
      forceRestart: true,
      ...(tracked.plannedRestartReason ? { restartReason: tracked.plannedRestartReason } : {}),
    });
  };
  const stopSession = async (
    sessionId: string,
    options?: StopSessionOptions,
    resumeAdmission?: ReturnType<SessionRunnerRespawnManager['prepareFreshExplicitResumeAdmission']>,
    recordExplicitIntent?: () => Promise<void | false>,
    stopCredentials = params.credentials,
  ): Promise<StopSessionResult> => {
    const request = { reason: 'daemon_stop_session', requestedAtMs: Date.now() } as const;
    // Physical Stops coalesce; each external Stop must still retire launch admission.
    // Exact Action/handoff stops claim their process-specific intent before signalling.
    if (!options?.expectedTrackedRunner && !resumeAdmission && !recordExplicitIntent) {
      sessionRunnerRespawnManager.markStopRequested(sessionId, request);
    }
    return await disconnectedTerminalHostResumeLifecycle.runStop(
      sessionId,
      async () => {
        if (await recordExplicitIntent?.() === false) return { stopResult: { status: 'not_found' as const } };
        if (!options?.expectedTrackedRunner && !resumeAdmission && recordExplicitIntent) {
          sessionRunnerRespawnManager.markStopRequested(sessionId, request);
        }
        const stopStartedAtMs = Date.now();
        if (!options?.expectedTrackedRunner && resumeAdmission) resumeAdmission.retireIncumbent(request);
        const automaticRecoveryOwners = [
          'inactive_usage_limit',
          'runtime_auth',
          'temporary_throttle',
        ] as const;
        const automaticRecoveryCancellations = await Promise.allSettled([
          params.cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop?.({
            sessionId,
          }) ?? Promise.resolve(null),
          runtimeAuthRecoveryScheduler.cancel({ sessionId }),
          temporaryThrottleScheduler.cancel({ sessionId }),
        ].map((cancellation, index) => cancellation.finally(() => {
          logger.infoFile('[DAEMON STOP] Automatic recovery owner cancellation completed', {
            sessionId, owner: automaticRecoveryOwners[index], elapsedMs: Date.now() - stopStartedAtMs,
          });
        })));
        automaticRecoveryCancellations.forEach((result, index) => {
          if (result.status !== 'rejected') return;
          logger.warn(
            '[DAEMON RUN] Automatic recovery cancellation failed after explicit Stop',
            {
              sessionId,
              owner: automaticRecoveryOwners[index],
              error: serializeAxiosErrorForLog(result.reason),
            },
          );
        });
        temporaryThrottleResumeSnapshotsBySessionId.delete(sessionId);
        const supersessionStartedAtMs = Date.now();
        await connectedServiceRecoverySupersessionCleaner({
          sessionId,
          event: { kind: 'manual_session_supersession', reason: 'stop' },
        });
        logger.infoFile('[DAEMON STOP] Recovery report outbox supersession completed', {
          sessionId, elapsedMs: Date.now() - supersessionStartedAtMs,
        });
        if (params.daemonSessionMutationCustody.stage) {
          await persistExplicitSessionStopUsageLimitRecoveryCancellation({
            credentials: stopCredentials,
            sessionId,
            mutationCustody: {
              stage: params.daemonSessionMutationCustody.stage,
            },
            ...(options?.metadataContext?.resolveAuthorizationHeaders
              ? { resolveAuthorizationHeaders: options.metadataContext.resolveAuthorizationHeaders } : {}),
          }).catch((error) => {
            logger.warn(
              '[DAEMON RUN] Failed to publish explicit Stop recovery cancellation',
              {
                sessionId,
                error: serializeAxiosErrorForLog(error),
              },
            );
          });
        }
        physicallyRetiredTerminalAttachmentIdBySessionId.delete(sessionId);
        logger.infoFile('[DAEMON STOP] Recovery cancellation completed', {
          sessionId,
          elapsedMs: Date.now() - stopStartedAtMs,
        });
        const trackedStopResult = await stopSessionCore(sessionId, options?.expectedTrackedRunner ? {
          ...options,
          beforeSignalExactTrackedRunner: async (tracked) => {
            if (await options.beforeSignalExactTrackedRunner?.(tracked) === false) return false;
            sessionRunnerRespawnManager.markStopRequested(sessionId,
              { reason: 'daemon_stop_session', requestedAtMs: Date.now() });
            return true;
          },
        } : options);
        logger.infoFile('[DAEMON STOP] Physical stop owner completed', {
          sessionId,
          elapsedMs: Date.now() - stopStartedAtMs,
          status: trackedStopResult.status,
          ...(trackedStopResult.status === 'incomplete'
            ? { reason: trackedStopResult.reason }
            : {}),
        });
        const physicallyRetiredAttachmentId =
          physicallyRetiredTerminalAttachmentIdBySessionId.get(sessionId);
        physicallyRetiredTerminalAttachmentIdBySessionId.delete(sessionId);
        if (
          isTerminalHostPhysicallyRetiredStopResult(trackedStopResult) &&
          physicallyRetiredAttachmentId
        ) {
          return {
            stopResult: trackedStopResult,
            retireCandidate: {
              sessionId,
              attachmentId: physicallyRetiredAttachmentId,
            },
          };
        }
        if (
          trackedStopResult.status !== 'incomplete' ||
          trackedStopResult.reason !== 'tracked_runner_absent'
        ) {
          return { stopResult: trackedStopResult };
        }
        const normalizedSessionId = sessionId.trim();
        const candidate = disconnectedTerminalHostCandidates.find(
          (value) =>
            value.sessionId === normalizedSessionId &&
            !terminalizedDisconnectedTerminalHostIds.has(value.attachmentId),
        );
        if (!candidate) return { stopResult: trackedStopResult };
        const runnerProbe = await probeSessionRunnerServiceability({
          sessionId: normalizedSessionId,
          trackedSessions: params.pidToTrackedSession.values(),
          probeCapability: async () =>
            await probeAlreadyRunningExistingSessionServiceability({
              sessionId: normalizedSessionId,
              credentials: stopCredentials,
              abortSignal: shutdownCancellationDomains.daemonWorkSignal,
              isShuttingDown: isRuntimePublicationQuiescing,
            }),
        });
        if (runnerProbe.state !== 'runner_absent')
          return { stopResult: trackedStopResult };

        const candidatePidToTrackedSession = new Map<number, TrackedSession>([
          [
            candidate.pid,
            {
              startedBy: 'daemon',
              happySessionId: normalizedSessionId,
              pid: candidate.pid,
            },
          ],
        ]);
        const stopDisconnectedHost = createStopSession({
          pidToTrackedSession: candidatePidToTrackedSession,
          expectedTerminalAttachmentId: candidate.attachmentId,
          terminalHostAdapters:
            (await params.loadTerminalHostAdapters?.()) ?? {},
          provenTerminalHostKindsByPid: new Map([
            [candidate.pid, candidate.handle.kind],
          ]),
          ...(candidate.terminalMode
            ? {
                provenTerminalModesByPid: new Map([
                  [candidate.pid, candidate.terminalMode],
                ]),
              }
            : {}),
          requireTerminalTopologyProof: true,
          areTrackedRunnersExited: async ({ trackedPids }) =>
            await waitForTrackedRunnerProcessesExit({
              runners: trackedPids.map((pid) => ({ pid })),
              timeoutMs: 0,
              pollIntervalMs: 0,
            }),
          waitForTrackedRunnersExit: async ({ trackedPids }) =>
            await waitForTrackedRunnerProcessesExit({
              runners: trackedPids.map((pid) => ({ pid })),
              timeoutMs: configuration.daemonStopSessionWaitForExitMs,
              pollIntervalMs:
                configuration.daemonStopSessionWaitForExitPollIntervalMs,
            }),
          retireExactTerminalControlServiceability: async ({
            sessionId,
            attachmentInfo,
            terminalMode,
          }) => {
            return await retireTerminalControlServiceabilityForCurrentAccount({
              sessionId,
              attachmentId: attachmentInfo.attachmentId,
              terminalMode,
            });
          },
        });
        const candidateStopResult =
          await stopDisconnectedHost(normalizedSessionId);
        return isTerminalHostPhysicallyRetiredStopResult(candidateStopResult)
          ? {
              stopResult: candidateStopResult,
              retireCandidate: {
                sessionId: normalizedSessionId,
                attachmentId: candidate.attachmentId,
              },
            }
          : { stopResult: candidateStopResult };
      },
    );
  };
  const stopSessionExplicit = async (sessionId: string, signal?: AbortSignal): Promise<StopSessionResult> => {
    try {
      return await withSessionStopMetadataContext(sessionId, async metadataContext => {
        const { credentials } = metadataContext;
        return await stopSession(sessionId, { metadataContext }, undefined, async () => {
          const stopRawSession = await fetchSessionByIdCompat({ reason: 'session-control', token: credentials.token, sessionId, signal });
          if (!stopRawSession || stopRawSession.id !== sessionId) {
            throw new Error('Explicit Stop intent could not be persisted for the exact Session');
          }
          const accountEncryptionCurrentness = await fetchAccountEncryptionCurrentness({ token: credentials.token, signal });
          const owner = resolveSessionOwningMachineId({ credentials, rawSession: stopRawSession,
            accountEncryptionMode: accountEncryptionCurrentness.mode });
          if (!owner.ok || owner.machineId !== params.machineId) {
            throw new Error('Explicit Stop target is not owned by this Machine');
          }
          await recordSessionStopIntent({ credentials, sessionId, rawSession: stopRawSession, stopIntent: 'explicit_stop',
            accountEncryptionCurrentness,
            ...(metadataContext.currentness ? { currentness: metadataContext.currentness } : {}),
          });
        }, credentials);
      }, undefined, signal);
    } catch (error) {
      logger.warn('[DAEMON STOP] Explicit Stop could not settle', { sessionId, error: serializeAxiosErrorForLog(error) });
      return { status: 'incomplete', reason: 'explicit_stop_failed' };
    }
  };
  const isSessionAlreadyRunning = async (sessionId: string): Promise<boolean> =>
    await isSessionRunnerActive(sessionId);
  const controlToken = randomBytes(32).toString('base64url');
  const recordConnectedServiceContinuationProviderActivity =
    createConnectedServiceProviderActivityProofRecorder({
      // `runtimeAuthRecoveryScheduler` is constructed later in this function; the
      // recorder only runs on turn-lifecycle events after startup completes.
      runtimeAuthRecovery: {
        markProviderOutcomeProofByIdentity: async (input) => {
          await runtimeAuthRecoveryScheduler.markProviderOutcomeProofByIdentity(
            input,
          );
        },
      },
      logDebug: (message, error) => logger.debug(message, error),
    });
  const runtimeAuthRecoveryStormEvents: number[] = [];
  const runtimeAuthRecoveryStormWindowMs = resolvePositiveIntEnv(
    params.processEnv
      .HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_STORM_WINDOW_MS,
    60_000,
    { min: 1_000, max: 60 * 60_000 },
  );
  const runtimeAuthRecoveryStormThreshold = resolvePositiveIntEnv(
    params.processEnv
      .HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_STORM_THRESHOLD,
    5,
    { min: 1, max: 1_000 },
  );
  const runtimeAuthRecoveryStormDelayMs = resolvePositiveIntEnv(
    params.processEnv
      .HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_STORM_DELAY_MS,
    30_000,
    { min: 1_000, max: 60 * 60_000 },
  );
  const runtimeAuthRecoveryJitterMaxMs = resolvePositiveIntEnv(
    params.processEnv
      .HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_JITTER_MS,
    250,
    { min: 1, max: 60_000 },
  );
  const shouldCountRuntimeAuthRecoveryAsLocalServerStorm = (
    classification: RuntimeAuthRecoveryDiagnostic['errorClassification'],
  ): boolean => {
    if (classification?.retryable !== true) return false;
    return (
      classification.kind === 'timeout' ||
      classification.kind === 'network' ||
      classification.kind === 'server_error'
    );
  };
  const pruneRuntimeAuthRecoveryStormEvents = (nowMs: number): void => {
    const cutoffMs = nowMs - runtimeAuthRecoveryStormWindowMs;
    while (
      runtimeAuthRecoveryStormEvents.length > 0 &&
      (runtimeAuthRecoveryStormEvents[0] ?? 0) < cutoffMs
    ) {
      runtimeAuthRecoveryStormEvents.shift();
    }
  };
  const recordRuntimeAuthRecoveryDiagnostic = (
    diagnostic: RuntimeAuthRecoveryDiagnostic,
  ): void => {
    logger.debug(
      '[DAEMON RUN] Connected-service runtime-auth recovery diagnostic',
      diagnostic,
    );
    if (diagnostic.transcriptEvent) {
      runtimeAuthRecoveryScheduler.schedulePendingVisibleEventDrain({
        deliver: deliverRuntimeAuthRecoveryVisibleEvent,
        onError: (error) => {
          logger.debug(
            '[DAEMON RUN] Failed to commit connected-service runtime-auth recovery session event (non-fatal)',
            {
              sessionId: diagnostic.sessionId,
              serviceId: diagnostic.serviceId,
              error: serializeAxiosErrorForLog(error),
            },
          );
        },
      });
    }
    if (
      diagnostic.event === 'runtime_auth_recovery_enqueue' &&
      shouldCountRuntimeAuthRecoveryAsLocalServerStorm(
        diagnostic.errorClassification,
      )
    ) {
      const nowMs = Date.now();
      pruneRuntimeAuthRecoveryStormEvents(nowMs);
      runtimeAuthRecoveryStormEvents.push(nowMs);
    }
    if (
      diagnostic.event === 'runtime_auth_recovery_dead_letter' ||
      diagnostic.event === 'runtime_auth_recovery_terminal'
    ) {
      logger.warn(
        '[DAEMON RUN] Connected-service runtime-auth recovery stopped',
        diagnostic,
      );
    }
    if (diagnostic.event === 'runtime_auth_recovery_success') {
      runtimeAuthRecoveryStormEvents.length = 0;
    }
  };
  const resolveCurrentRuntimeAuthFailureSourceForSession: NonNullable<
    Parameters<
      typeof authorizeConnectedServiceRuntimeAuthFailureSource
    >[0]['resolveCurrentRuntimeAuthFailureSource']
  > = async ({
    sessionId: liveSessionId,
    tracked,
    classification: liveClassification,
  }) => {
    return await withSessionAccountContext(liveSessionId, async (accountContext) =>
      await withSessionAccountHome(accountContext, async () => {
        const agentId = resolveTrackedSessionCatalogAgentId(tracked);
        return await resolveCurrentRuntimeAuthFailureSource({
          classification: liveClassification,
          readRuntimeIdentity: async (request) => {
            const transport = createSessionConnectedServiceAuthTransport({
              credentials:
                accountContext?.bootstrap.credentials ?? params.credentials,
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
              providerAccountId: normalizeOptionalString(
                result.value.identity.providerAccountId,
              ),
              profileId: normalizeOptionalString(result.value.runtime?.profileId),
              groupId: normalizeOptionalString(result.value.runtime?.groupId),
              generation: normalizeNullableGeneration(
                result.value.runtime?.generation,
              ),
              credentialRevision: normalizeOptionalString(
                result.value.runtime?.credentialRevision,
              ),
            };
          },
          resolveCurrentCredential: async (serviceId, profileId) => {
            // Released V2/V3 sealed-credential reads remain scalar-keyed on the server
            // wire; first-party services translate at this named ingress. External
            // qualified services have no scalar credential identity here and report
            // typed unavailability instead of a guessed lookup.
            const credentialIngressServiceId =
              resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
                serviceId,
              );
            if (!credentialIngressServiceId) return null;
            const resolutions =
              await resolveConnectedServiceCredentialResolutions({
                credentials:
                  accountContext?.bootstrap.credentials ?? params.credentials,
                api: accountContext?.api ?? params.api,
                bindings: [{ serviceId: credentialIngressServiceId, profileId }],
              });
            const resolution =
              resolutions?.get(credentialIngressServiceId) ?? null;
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
      }),
    );
  };
  const resolveConnectedAccountUsageIdentity = async (serviceId: string) => {
    const service = resolveQualifiedConnectedAccountServiceForIngressServiceId(serviceId);
    if (!service) return null;
    const lease = await acquireDaemonPluginRuntimeRegistryLease();
    try {
      return lease.registry.contributes.connectedAccountDescriptorsById
        .get(buildQualifiedPluginContributionKey(service))?.definition.usageIdentity ?? null;
    } finally { await lease.release(); }
  };
  const resolveProviderQualifiedRuntimeAuthFailureSourceForSession: NonNullable<
    Parameters<
      typeof authorizeConnectedServiceRuntimeAuthFailureSource
    >[0]['resolveProviderQualifiedRuntimeAuthFailureSource']
  > = async ({ sessionId, classification }) => {
    return await withSessionAccountContext(sessionId, async (accountContext) =>
      await withSessionAccountHome(accountContext, async () => {
        const groupId =
          typeof classification.groupId === 'string'
            ? classification.groupId.trim()
            : '';
        if (!groupId || typeof classification.serviceId !== 'string')
          return classification;
        // The V4 group owner accepts canonical qualified service refs directly.
        if (
          !(await readQualifiedConnectedServiceAuthGroup({
            sessionId,
            serviceId: classification.serviceId,
            groupId,
          }))
        ) {
          return classification;
        }
        return await resolveRuntimeAuthFailureSourceProfile({
          classification,
          requiresProviderOrganizationId: (await resolveConnectedAccountUsageIdentity(classification.serviceId))?.requiredContext === 'organization',
          getGroupMembers: async () =>
            (
              await readQualifiedConnectedServiceAuthGroup({
                sessionId,
                serviceId: classification.serviceId,
                groupId,
              })
            )?.members.map((member) => ({
              profileId: member.connectedAccountId,
            })) ?? null,
          resolveProviderAccountIdentity: async (profileId) => {
            const service = resolveQualifiedConnectedAccountServiceForIngressServiceId(classification.serviceId);
            if (!service) return null;
            const material = await readQualifiedConnectedAccountCredentialMaterial({
              credentials: accountContext?.bootstrap.credentials ?? params.credentials,
              account: { service, accountId: profileId },
              requestPurpose: 'connected-accounts:auth-group',
              getAccountEncryptionMode: (signal) => resolveConnectedServiceAccountMode(accountContext?.api ?? params.api, { signal }),
            });
            return material ? readQualifiedConnectedAccountCredentialIdentity(material) : null;
          },
        });
      }),
    );
  };
  const resolveRegisteredRuntimeAuthFailureSourceForSession: NonNullable<
    Parameters<
      typeof authorizeConnectedServiceRuntimeAuthFailureSource
    >[0]['resolveRegisteredRuntimeAuthFailureSource']
  > = async ({
    sessionId: liveSessionId,
    tracked,
    classification: liveClassification,
  }) => {
    // The runtime registry binds sessions by canonical qualified service key.
    const serviceId = liveClassification.serviceId;
    if (typeof serviceId !== 'string' || !serviceId) return null;
    const target =
      connectedServiceRuntimeRegistry.getBySessionId(liveSessionId);
    if (
      !target ||
      target.pid !== tracked.pid ||
      target.sessionId !== liveSessionId
    )
      return null;
    return readConnectedServiceRuntimeAuthFailureSourceBinding(target, serviceId);
  };
  const runConnectedServiceRuntimeAuthFailureRecovery = async (
    input: Readonly<{
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
    }>,
  ): Promise<unknown> => {
    return await withSessionAccountContext(input.sessionId, async (accountContext) => {
      const sessionCredentials =
        accountContext?.bootstrap.credentials ?? params.credentials;
      return await withSessionAccountHome(accountContext, async () => {
        const runtimeFailureAtMs = Date.now();
        const interruptedOriginId = resolveConnectedServiceContinuationOriginId({
          source:
            input.recoveryInvocationSource === 'scheduler_retry'
              ? 'scheduler_retry'
              : 'daemon_report',
          activeTurnId: Array.from(params.pidToTrackedSession.values()).find(
            (tracked) => tracked.happySessionId === input.sessionId,
          )?.activeTurnId,
          reportId: input.interruptedOriginId,
        });
        const authorizedTracked =
          input.sourceAuthorization?.status === 'authorized'
            ? input.sourceAuthorization.tracked
            : null;
        const trackedRecoverySession =
          authorizedTracked ??
          findTrackedSessionByHappySessionId(
            params.pidToTrackedSession.values(),
            input.sessionId,
          );
        const authorizedInactive =
          input.sourceAuthorization?.status === 'authorized'
            ? input.sourceAuthorization.inactive
            : null;
        const inactiveRecoverySession = trackedRecoverySession
          ? null
          : (authorizedInactive ??
            (await resolveInactiveConnectedServiceSessionContext({
              token: sessionCredentials.token,
              credentials: sessionCredentials,
              sessionId: input.sessionId,
              currentMachineId: params.machineId,
            })));
        const runtimeAuthV4Support =
          params.resolveQualifiedConnectedAccountV4Support?.() ?? 'absent';
        // The classification carries the canonical qualified service key (sanitize is the
        // sole ingress and normalizes released bundled scalar ids). The reverse scalar
        // mapping stays only for the bounded V2/V3 compatibility seams below.
        const runtimeAuthServiceKey =
          typeof input.classification.serviceId === 'string'
            ? readBuiltInLegacyConnectedAccountServiceKeyIngress(
                input.classification.serviceId,
              )
            : null;
        const legacyRuntimeAuthService =
          resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
            input.classification.serviceId,
          );
        const qualifiedRuntimeAuthService = runtimeAuthServiceKey
          ? resolveQualifiedConnectedAccountServiceForIngressServiceId(
              runtimeAuthServiceKey,
            )
          : null;
        const buildRuntimeAuthApplication = (
          options: Readonly<{
            commitAccountSwitchEvents: boolean;
            dryRun?: boolean;
          }>,
        ) =>
          buildConnectedServiceAuthApplicationSession({
            sessionId: input.sessionId,
            interruptedSessionId: input.sessionId,
            interruptedOriginId,
            restartReason: input.classification.kind,
            commitAccountSwitchEvents: options.commitAccountSwitchEvents,
            ...(options.dryRun ? { dryRun: true } : {}),
          });
        const qualifiedCoordinator =
          runtimeAuthV4Support === 'advertised' &&
          runtimeAuthServiceKey &&
          qualifiedRuntimeAuthService
            ? await createSessionQualifiedAuthGroupSwitchCoordinator({
                sessionId: input.sessionId,
                accountContext,
                serviceId: runtimeAuthServiceKey,
                reason: input.classification.kind,
                applyGeneration: async (generation) =>
                  await buildRuntimeAuthApplication({
                    commitAccountSwitchEvents: true,
                  })({
                    ...generation,
                    serviceId: runtimeAuthServiceKey,
                  }),
              })
            : null;
        const qualifiedRuntimeAuthSwitchCoordinator: NonNullable<
          Parameters<
            typeof handleConnectedServiceRuntimeAuthFailureForSession
          >[0]['switchCoordinator']
        > | null =
          qualifiedCoordinator &&
          qualifiedRuntimeAuthService &&
          runtimeAuthServiceKey
            ? {
                switchAfterClassifiedFailure: async (switchInput) => {
                  if (switchInput.serviceId !== runtimeAuthServiceKey)
                    throw new Error(
                      'qualified_connected_account_runtime_auth_service_mismatch',
                    );
                  await assertSessionAccountCurrent(
                    input.sessionId,
                    accountContext,
                  );
                  return await qualifiedCoordinator.switchAfterClassifiedFailure({
                    ...switchInput,
                    serviceId: qualifiedRuntimeAuthService,
                  });
                },
              }
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
        const interruptedContinuation = interruptedOriginId
          ? {
              interruptedOriginId,
              resumePromptMode: await resolveContinuationResumePromptMode({
                serviceId: runtimeAuthServiceKey,
                groupId: input.classification.groupId,
                explicit: input.resumePromptMode,
                readAccountSettings: accountContext
                  ? () => accountContext.readAccountSettingsSnapshot().settings
                  : undefined,
                loadGroupPolicy: input.classification.groupId
                  ? async () =>
                      (
                        await readQualifiedConnectedServiceAuthGroup({
                          serviceId: runtimeAuthServiceKey,
                          groupId: input.classification.groupId!,
                          sessionId: input.sessionId,
                        })
                      )?.policy ?? null
                  : undefined,
              }),
              customResumePrompt: readContinuationCustomResumePrompt(
                accountContext
                  ? accountContext.readAccountSettingsSnapshot().settings
                  : (getActiveAccountSettingsSnapshot()?.settings ?? null),
              ),
              recoveryKind: input.classification.kind,
            }
          : null;
        const continueAfterRuntimeAuthSwitch =
          createConnectedServiceContinuationHandler({
            credentials: sessionCredentials,
            isCurrent: async () => {
              await assertSessionAccountCurrent(input.sessionId, accountContext);
              return true;
            },
            interruptedOriginId,
            resumePromptMode: interruptedContinuation?.resumePromptMode ?? 'off',
            customResumePrompt:
              interruptedContinuation?.customResumePrompt ?? null,
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
        const scopedTemporaryThrottleRecovery = {
          ...temporaryThrottleRecovery,
          enable: async (
            temporaryThrottleInput: Parameters<
              typeof temporaryThrottleRecovery.enable
            >[0],
          ) =>
            await temporaryThrottleRecovery.enable({
              ...temporaryThrottleInput,
              continuation: interruptedContinuation,
            }),
        };
        const result = await handleConnectedServiceRuntimeAuthFailureForSession({
          getChildren: () => Array.from(params.pidToTrackedSession.values()),
          resolveInactiveSession: async ({ sessionId }) => {
            if (sessionId === input.sessionId && inactiveRecoverySession) {
              return inactiveRecoverySession;
            }
            return await resolveInactiveConnectedServiceSessionContext({
              token: sessionCredentials.token,
              credentials: sessionCredentials,
              sessionId,
              currentMachineId: params.machineId,
            });
          },
          resolveRegisteredRuntimeAuthFailureSource:
            resolveRegisteredRuntimeAuthFailureSourceForSession,
          resolveCurrentRuntimeAuthFailureSource:
            resolveCurrentRuntimeAuthFailureSourceForSession,
          resolveProviderQualifiedRuntimeAuthFailureSource:
            resolveProviderQualifiedRuntimeAuthFailureSourceForSession,
          switchCoordinator,
          switchAttemptTracker: connectedServiceRuntimeAuthSwitchAttempts,
          switchCore: connectedServiceSessionAuthSwitchCore,
          temporaryThrottleRecovery: scopedTemporaryThrottleRecovery,
          emitSessionEvent: async (sessionId, event) => {
            await commitConnectedServiceAccountSwitchSessionEventWithNotification(
              {
                sessionId,
                event,
                logContext: 'runtime-auth',
              },
            );
          },
          sessionId: input.sessionId,
          switchesThisTurn: input.switchesThisTurn,
          ...(input.recoveryInvocationSource
            ? { recoveryInvocationSource: input.recoveryInvocationSource }
            : {}),
          classification: input.classification,
          ...(input.sourceAuthorization
            ? { sourceAuthorization: input.sourceAuthorization }
            : {}),
          refreshConnectedServiceCredentialForRuntimeAuthFailure: async (
            refreshInput,
          ) => {
            const refreshCoordinator = accountContext
              ? (accountContext.connectedServiceRefreshCoordinator ?? null)
              : params.getConnectedServiceRefreshCoordinator();
            const legacyServiceId =
              resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
                refreshInput.serviceId,
              );
            if (!legacyServiceId) {
              throw new Error(
                'runtime_auth_credential_legacy_refresh_unavailable',
              );
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
            return await refreshCoordinator.refreshConnectedServiceCredentialForRuntimeAuthFailure(
              {
                ...refreshInput,
                serviceId: legacyServiceId,
              },
            );
          },
          continueAfterRuntimeAuthSwitch,
          settleSupersedingRuntimeGroupGeneration: async (settlementInput) => {
            await settleSupersedingRuntimeAuthGenerationForSource({
              recovery: {
                status: 'switch_attempted',
                result: settlementInput.result,
              },
              serviceId: settlementInput.serviceId,
              groupId: settlementInput.groupId,
              sessionId: settlementInput.sessionId,
              fromProfileId: settlementInput.fromProfileId,
              consumeCommittedAuthGroupGeneration,
            });
            supersedingSourceConverged = true;
          },
        });
        if (
          isSupersededRuntimeAuthFailure({
            result,
          })
        )
          return result;
        if (
          input.recoveryInvocationSource !== 'scheduler_retry' &&
          input.classification.kind === 'usage_limit' &&
          input.classification.groupId &&
          input.classification.profileId
        ) {
          const serviceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(
            input.classification.serviceId,
          );
          const quotaCoordinator = accountContext
            ? (accountContext.connectedServiceQuotasCoordinator ?? null)
            : params.getConnectedServiceQuotasCoordinator();
          if (serviceId && quotaCoordinator) {
            const committedGeneration =
              resolveCommittedGenerationFromRuntimeAuthRecovery({
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
                sourceProviderAccountId:
                  input.classification.sourceProviderAccountId ?? null,
                sourceAccountLabel:
                  input.classification.sourceAccountLabel ?? null,
                sourceGroupGeneration:
                  input.classification.groupGeneration ?? null,
                resetAtMs: input.classification.resetsAtMs,
                ...(committedGeneration
                  ? {
                      committedGeneration:
                        committedGeneration.committedGeneration,
                      sourceRequiresConvergence:
                        committedGeneration.sourceRequiresConvergence &&
                        !supersedingSourceConverged,
                    }
                  : {}),
              });
            } catch (error) {
              logger.debug(
                '[DAEMON RUN] Failed to fan out connected-service runtime usage-limit exhaustion (non-fatal)',
                error,
              );
            }
          }
        }
        logger.debug(
          '[DAEMON RUN] Connected-service reactive runtime-auth switch attempt',
          buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
            sessionId: input.sessionId,
            classification: input.classification,
            result,
            routedThroughFsm: true,
            startedAtMs: runtimeFailureAtMs,
            finishedAtMs: Date.now(),
          }),
        );
        return result;
      });
    });
  };
  const deliverRuntimeAuthRecoveryVisibleEvent = async (
    delivery: RuntimeAuthRecoveryVisibleEventDelivery,
  ): Promise<void> => {
    await withSessionAccountContext(delivery.sessionId, async (accountContext) => {
      const usageLimitRecovery = buildRuntimeAuthUsageLimitRecoveryProjection(
        delivery.recoveryIntent,
      );
      await withSessionAccountHome(accountContext, () =>
        (
          accountContext?.daemonSessionMutationCustody ??
          params.daemonSessionMutationCustody
        ).stageTranscriptEvent({
          sessionId: delivery.sessionId,
          eventId: buildRuntimeAuthRecoveryAttemptTransitionLocalId(delivery),
          data: { ...delivery.transcriptEvent },
          ...(usageLimitRecovery ? { usageLimitRecovery } : {}),
        }),
      );
    });
  };
  const runtimeAuthRecoveryScheduler: RuntimeAuthRecoveryScheduler =
    createRuntimeAuthRecoverySchedulerForDaemon({
      activeServerDir: configuration.activeServerDir,
      nowMs: () => Date.now(),
      maxAttempts: resolvePositiveIntEnv(
        params.processEnv
          .HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_MAX_ATTEMPTS,
        3,
        { min: 1, max: 100 },
      ),
      baseBackoffMs: resolvePositiveIntEnv(
        params.processEnv
          .HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_BASE_DELAY_MS,
        1_000,
        { min: 1, max: 24 * 60 * 60_000 },
      ),
      maxBackoffMs: resolvePositiveIntEnv(
        params.processEnv
          .HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_MAX_DELAY_MS,
        60_000,
        { min: 1, max: 24 * 60 * 60_000 },
      ),
      providerOutcomePendingWaitMs:
        connectedServiceContinuationProviderActivityTimeoutMs,
      jitterMs: () =>
        Math.floor(Math.random() * runtimeAuthRecoveryJitterMaxMs),
      recover: runConnectedServiceRuntimeAuthFailureRecovery,
      continueAfterUsageLimitReset: async (intent) => {
        return await withSessionAccountContext(intent.sessionId, async (accountContext) =>
          await withSessionAccountHome(accountContext, async () => {
            const credentials = accountContext?.bootstrap.credentials ?? params.credentials;
            const isCurrent = async () => {
              await assertSessionAccountCurrent(intent.sessionId, accountContext);
              const current = runtimeAuthRecoveryScheduler.readForSession(intent.sessionId)
                .find((candidate) => candidate.attemptId === intent.attemptId);
              if (!current || (current.status !== 'checking' && current.status !== 'waiting')
                || current.classification.resetsAtMs !== intent.classification.resetsAtMs
                || current.resumePromptMode !== intent.resumePromptMode) return false;
              const runtime = connectedServiceRuntimeRegistry.getBySessionId(intent.sessionId);
              if (!runtime) return true;
              const binding = runtime.activeBindings.find((candidate) => candidate.serviceId === intent.serviceId);
              return Boolean(binding && binding.profileId === intent.profileId && binding.groupId === null);
            };
            if (!(await isCurrent())) return { status: 'recovery_superseded' };
            const service = resolveQualifiedConnectedAccountServiceForIngressServiceId(intent.serviceId);
            const profileId = intent.profileId;
            if (!service || !profileId) return { status: 'recovery_superseded' };
            const readAccount = async () => {
              // Current credential resolution is V4-only, including retained native projections.
              // A transport failure must reach the scheduler's retry owner, never a legacy fallback.
              const material = await readQualifiedConnectedAccountCredentialMaterial({
                credentials, account: { service, accountId: profileId },
                requestPurpose: 'connected-accounts:quota-qualification',
                getAccountEncryptionMode: (signal) => resolveConnectedServiceAccountMode(
                  accountContext?.api ?? params.api, { signal },
                ),
              });
              return material ? {
                ...readQualifiedConnectedAccountCredentialIdentity(material),
                requiresProviderOrganizationId: (await resolveConnectedAccountUsageIdentity(intent.serviceId))?.requiredContext === 'organization',
              } : null;
            };
            const account = await readAccount();
            if (!account || !isCurrentUsageLimitRecoveryAccount({ classification: intent.classification, ...account })) {
              return { status: 'recovery_superseded' };
            }
            const [rawSession, accountEncryptionCurrentness] = await Promise.all([
              fetchSessionByIdCompat({ reason: 'session-control', token: credentials.token, sessionId: intent.sessionId }),
              fetchAccountEncryptionCurrentness({ token: credentials.token }),
            ]);
            if (!rawSession) return { status: 'recovery_superseded' };
            const metadata = tryReadSessionMetadataRecord({
              rawSession, credentials, accountEncryptionMode: accountEncryptionCurrentness.mode,
            });
            const recovery = buildRuntimeAuthUsageLimitRecoveryProjection(intent);
            if (!metadata || metadata.machineId !== params.machineId || !recovery) return { status: 'recovery_superseded' };
            return await continueAccountQualifiedSessionAfterUsageLimitReset({
              classification: intent.classification, readAccount,
              readActiveBinding: () => connectedServiceRuntimeRegistry.getBySessionId(intent.sessionId)
                ?.activeBindings.find((binding) => binding.serviceId === intent.serviceId),
              continuation: {
                credentials, sessionId: intent.sessionId, rawSession, metadata, recovery, nowMs: Date.now(),
                customResumePrompt: (accountContext?.readAccountSettingsSnapshot() ?? getActiveAccountSettingsSnapshot())
                  ?.settings.usageLimitRecoverySettingsV1?.customResumePrompt ?? null,
                isCurrent,
              },
            });
          }),
        );
      },
      gate: () => {
        const nowMs = Date.now();
        pruneRuntimeAuthRecoveryStormEvents(nowMs);
        if (
          runtimeAuthRecoveryStormEvents.length <
          runtimeAuthRecoveryStormThreshold
        ) {
          return { status: 'open' as const };
        }
        return {
          status: 'delayed' as const,
          retryAtMs:
            nowMs +
            runtimeAuthRecoveryStormDelayMs +
            Math.floor(Math.random() * runtimeAuthRecoveryJitterMaxMs),
          reason: 'local_server_storm',
        };
      },
      recordDiagnostic: recordRuntimeAuthRecoveryDiagnostic,
    });
  runtimeAuthRecoveryScheduler.schedulePendingVisibleEventDrain({
    deliver: deliverRuntimeAuthRecoveryVisibleEvent,
    onError: (error) => {
      logger.debug(
        '[DAEMON RUN] Failed to commit hydrated connected-service runtime-auth recovery session event (non-fatal)',
        {
          error: serializeAxiosErrorForLog(error),
        },
      );
    },
  });
  connectedServicePredictiveSwitchGuard =
    createConnectedServicePredictiveSwitchGuard({
      isSessionCurrent: async (sessionId, signal) => {
        return await withSessionAccountContext(sessionId, async () => true, undefined, signal);
      },
      readTurnState: (sessionId) =>
        connectedServiceTurnDeferralQueue.getTurnLifecycleState(sessionId),
      resolvePredictiveSoftSwitchMode: async (input) =>
        await resolvePredictiveSoftSwitchModeForInput(input),
    });
  // Single async server-features fetch source shared by the local-services inventory gate and
  // the browser daemon feature gate (OWNER-GATE). One fetch source, two consumers — no second
  // fetch is introduced. The gates own caching the resolved snapshot.
  const resolveServerFeaturesSnapshot = async () =>
    params.resolveServerFeaturesSnapshot ? await params.resolveServerFeaturesSnapshot() :
      fetchServerFeaturesSnapshot({
        serverUrl: resolveServerHttpBaseUrl(),
      });
  function listProjectServices(): readonly ProjectManagedServiceHandle[];
  function listProjectServices(options: Readonly<{ requireComplete: true; workspaceRoot?: string }>): Promise<readonly ProjectManagedServiceHandle[]>;
  function listProjectServices(options?: Readonly<{ requireComplete: true; workspaceRoot?: string }>) {
    const owner = pluginRuntimeController.getState().activeRegistry?.projectManagedServices;
    if (options) {
      if (!owner) return Promise.reject(Object.assign(new Error('Project service native owner is unavailable'),
        { code: 'project_service_bindings_unavailable' }));
      return owner.listProjectServices(options);
    }
    return owner?.listProjectServices() ?? [];
  }
  const projectManagedServices: Pick<
    ReturnType<typeof createManagedServicesOwner>,
    'listProjectServices' | 'resolveProjectService' | 'readProcessRoots'
  > & Partial<Pick<ReturnType<typeof createManagedServicesOwner>, 'activity'>> = {
    ...(params.projectManagedServiceActivity ? { activity: params.projectManagedServiceActivity } : {}),
    readProcessRoots: () =>
      pluginRuntimeController.getState().activeRegistry
        ?.projectManagedServices.readProcessRoots() ?? [],
    listProjectServices,
    resolveProjectService: (target) =>
      pluginRuntimeController
        .getState()
        .activeRegistry?.projectManagedServices.resolveProjectService(
          target,
        ) ?? { status: 'unknown' },
  };
  const localServicesActionFeatureGate = createLocalServicesDaemonFeatureGate({
    env: params.processEnv,
    resolveServerFeaturesSnapshot,
  });
  await localServicesActionFeatureGate.refresh();
  const localServicesRuntime = createLocalServicesDaemonRuntime({
    processOwnershipRuntime,
    machineId: params.machineId,
    projectManagedServices,
    projectServiceStarter: {
      resolveRuntime: async (ingress) =>
        (await params
          .getApiMachineForSessions()
          ?.resolveProjectFiniteRuntime(ingress)) ?? null,
      acquirePluginRuntime: acquireDaemonPluginRuntimeRegistryLease,
    },
    accountId:
      readPreviewAccountIdFromToken(params.credentials.token) ?? undefined,
    previewServer: {
      token: params.credentials.token,
      serverBaseUrl: params.serverBaseUrl,
    },
    workspaceFacts: async () =>
      readLocalServiceWorkspaceFacts({
        credentials: params.credentials,
        serverId: params.serverId,
        serverBaseUrl: params.serverBaseUrl,
        machineId: params.machineId,
        markers: await listSessionMarkers(),
      }),
    processEnv: params.processEnv,
    internalProcessPids: () => [
      process.pid,
      ...[...params.pidToTrackedSession.values()].flatMap(session => [session.pid, readTrackedSessionProcessIdentity(session).pid]),
    ],
    // These are the selected Happier Home/UI endpoint authorities. The scanner admits
    // only literal-loopback HTTP(S) URLs and their exact matching bindings.
    internalEndpointUrls: () => [
      configuration.apiServerUrl,
      configuration.serverUrl,
      configuration.webappUrl,
    ],
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
  const resolveTrackedHostedWebStaticAssetSessionIds = (): readonly string[] =>
    Object.freeze([
      ...new Set(
        [...params.pidToTrackedSession.values()]
          .map((tracked) => normalizeOptionalString(tracked.happySessionId))
          .filter(
            (sessionId) =>
              sessionId.length > 0 && !/^PID-\d+$/u.test(sessionId),
          ),
      ),
    ]);
  const syncHostedWebStaticAssetsForTrackedSessions = async (
    reason: HostedWebStaticAssetSyncReason,
  ): Promise<void> => {
    const sessionIds = resolveTrackedHostedWebStaticAssetSessionIds();
    if (sessionIds.length === 0) {
      await localServicesRuntime.syncHostedWebStaticAssets([]);
      return;
    }

    let runtimeRegistryLease: Awaited<
      ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>
    > | null = null;
    try {
      let sourceRegistry: ResolvedContributionRegistry;
      if (params.resolveHostedWebStaticAssetContributionRegistry) {
        sourceRegistry =
          await params.resolveHostedWebStaticAssetContributionRegistry();
      } else {
        runtimeRegistryLease =
          await acquireDaemonPluginRuntimeRegistryLease();
        sourceRegistry = runtimeRegistryLease.registry.contributes;
      }
      const sourceResults = await Promise.all(
        sessionIds.map(
          async (sessionId) =>
            await resolveHostedWebStaticAssetLifecycleSource({
              registry: sourceRegistry,
              sessionId,
              machineId: params.machineId,
            }),
        ),
      );
      const sourceDiagnostics = sourceResults.flatMap(
        (result) => result.diagnostics,
      );
      if (sourceDiagnostics.length > 0) {
        logger.debug(
          '[DAEMON RUN] Hosted-web static asset source returned diagnostics',
          {
            reason,
            diagnostics: sourceDiagnostics,
          },
        );
      }

      const result = await localServicesRuntime.syncHostedWebStaticAssets(
        sourceResults.flatMap((sourceResult) => sourceResult.contributions),
      );
      if (result.diagnostics.length > 0) {
        logger.debug(
          '[DAEMON RUN] Hosted-web static asset sync returned diagnostics',
          {
            reason,
            diagnostics: result.diagnostics,
          },
        );
      }
    } catch (error) {
      logger.debug(
        '[DAEMON RUN] Hosted-web static asset sync failed; clearing active hosted-web previews',
        error,
      );
      await localServicesRuntime
        .syncHostedWebStaticAssets([])
        .catch((clearError) => {
          logger.debug(
            '[DAEMON RUN] Failed to clear hosted-web static assets after sync failure',
            clearError,
          );
        });
    } finally {
      if (runtimeRegistryLease) {
        await runtimeRegistryLease.release().catch((error: unknown) => {
          logger.debug(
            '[DAEMON RUN] Failed to release plugin runtime registry lease after hosted-web static asset sync',
            error,
          );
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
  const verifyIosHelperSignature = (path: string) =>
    verifyIosSimulatorHelperSignature({ path });
  // Resolve the pinned vendored helper through the full digest + Developer ID signature +
  // notarization verification chain ONCE. The same verified resolution drives both the
  // capture-availability gate and the helper-session owner's process path, so a verified
  // resource always has a real producer + input sender behind it (capability-truth). While the
  // placeholder digest is pinned (no signed/notarized artifact produced yet), this fails closed.
  const iosSimulatorHelperArtifact =
    await resolvePinnedIosSimulatorHelperArtifact({
      verifyHelperSignature: verifyIosHelperSignature,
    });
  const iosSimulatorCaptureAdapterAvailable =
    await resolveIosSimulatorCaptureAdapterAvailability({
      resolveHelperArtifact: async () => iosSimulatorHelperArtifact,
    });
  // Single long-lived `--daemon-json` helper-session owner: the iOS analog of the Android scrcpy
  // server handle. It owns the piped child process and is BOTH the frame-stream producer
  // (openStream) AND the input command sender (sendCommand). Constructed only when the artifact
  // verified, so capture/input are never silently no-ops behind an unverified binary.
  iosSimulatorHelperSession = iosSimulatorHelperArtifact.ok
    ? createIosSimulatorHelperSession({
        helperPath: iosSimulatorHelperArtifact.path,
      })
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
        resolveScrcpyControl: ({ serial }) =>
          androidScrcpyTunnelOwner.getControl({ serial }),
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
            createAdapter: (resource) =>
              simulatorStreamControlBridge.wrapCaptureAdapter(
                createSimulatorCaptureAdapterForResource(resource, {
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
                }),
              ),
          }),
        }
      : {}),
  });
  const runtimeActionRouteProviderTarget = params.api as Readonly<{
    setComputerRoutesProvider?: (
      provider: (() => ComputerRoutes | null) | null,
    ) => void;
    setBrowserDaemonControlRoutesProvider?: (
      provider: (() => BrowserDaemonControlRoutes | null) | null,
    ) => void;
    setBrowserDaemonContextRoutesProvider?: (
      provider: (() => BrowserContextRoutes | null) | null,
    ) => void;
    setBrowserDaemonAutomationRoutesProvider?: (
      provider: (() => BrowserAutomationRoutes | null) | null,
    ) => void;
    setBrowserUiAutomationProvider?: (
      provider: (() => BrowserUiAutomationRouteOwner | null) | null,
    ) => void;
    setBrowserAutomationRuntimeProvisionerProvider?: (
      provider: (() => ProvisionBrowserAutomationRuntime | null) | null,
    ) => void;
    setBrowserDiagnosticsActionRoutesProvider?: (
      provider: (() => BrowserDiagnosticsActionRoutes | null) | null,
    ) => void;
    setBrowserRecordingRoutesProvider?: (
      provider: (() => BrowserRecordingRoutes | null) | null,
    ) => void;
    setLocalServicesRuntimeActionRoutesProvider?: (
      provider: (() => LocalServicesRuntimeActionRoutes | null) | null,
    ) => void;
    setSimulatorPreviewRoutesProvider?: (
      provider: (() => SimulatorPreviewRoutes | null) | null,
    ) => void;
  }>;
  // Driver installation/capture is lazy and follows an approved explicit-target Action,
  // never daemon startup. Native lifecycle uses the already-published capture registry.
  computerRoutes = params.liveStreamCaptureRegistry
    ? createComputerRoutes({
        machineId: params.machineId,
        machineDisplayName: params.currentMachineHost ?? undefined,
        registry: params.liveStreamCaptureRegistry,
        defaultDisplayId: process.env.DISPLAY,
      })
    : null;
  runtimeActionRouteProviderTarget.setComputerRoutesProvider?.(
    () => computerRoutes,
  );
  // Machine registration may finish after startup. Publish through its attachment
  // owner so the person's controls also survive machine transport replacement.
  params.onComputerRoutesReady?.(() => computerRoutes);
  const browserRoutePublication = createBrowserRoutePublication({
    params, runtimeActionRouteProviderTarget, resolveServerFeaturesSnapshot,
    findTrackedSessionByHappySessionId, shutdownSignal: shutdownCancellationDomains.daemonWorkSignal,
    setGuardBrowserResourceOwner: (owner) => { guardBrowserResourceOwner = owner; },
  });
  const { refreshBrowserRouteOwners, purgeBrowserStorageForSessionDeleted, purgeBrowserStorageForLogout } = browserRoutePublication;
  let managedServiceDurabilityOwner: ManagedServiceDurabilityOwner | null =
    null;
  let managedServiceEndpointReadOwner: ReturnType<
    typeof createDaemonManagedServiceEndpointReadOwner
  > | null = null;
  const localServicesRuntimeActionRoutes: LocalServicesRuntimeActionRoutes = {
    inventoryRoutes: localServicesRuntime.inventoryRoutes,
    launcherRoutes: localServicesRuntime.launcherRoutes,
    previewRoutes: localServicesRuntime.previewRoutes,
    actionRoutes: localServicesRuntime.actionRoutes,
    publicPreviewRoutes: createLocalServicePublicPreviewServerRoutes({
      token: params.credentials.token,
      accountId: readPreviewAccountIdFromToken(params.credentials.token) ?? undefined,
      serverBaseUrl: params.serverBaseUrl,
    }),
    relocateService: createProjectServiceRelocationRoute({
      serverBaseUrl: params.serverBaseUrl,
      credentials: params.credentials,
      projectManagedServices,
      resolveWorkspaceSyncHandoffAdapter: () => params.resolveWorkspaceSyncHandoffAdapter?.() ?? null,
    }),
  };
  browserRoutePublication.publishBrowserAutomationRuntimeProvisioner();

  // Browser artifact verification is optional to control readiness. The same
  // refresh owner publishes routes only after its source and feature proof;
  // retirement disposes a late adapter before it can become reachable.
  void refreshBrowserRouteOwners().catch((error) => {
    logger.debug(
      '[DAEMON RUN] Browser route startup refresh failed (non-fatal)',
      error,
    );
  });
  runtimeActionRouteProviderTarget.setLocalServicesRuntimeActionRoutesProvider?.(
    () => localServicesRuntimeActionRoutes,
  );
  runtimeActionRouteProviderTarget.setSimulatorPreviewRoutesProvider?.(
    () => simulatorPreviewRuntime.routes,
  );
  const localServicesMachineRpcRoutes: DaemonLocalServicesMachineRpcRoutes & Readonly<{
    localServicesInventory: LocalServicesDaemonRuntime['inventoryRoutes'];
  }> = {
    machineId: params.machineId,
    serverId: params.serverId,
    accountId:
      readPreviewAccountIdFromToken(params.credentials.token) ?? undefined,
    projectManagedServices,
    resolveLauncherActionExecutor: ({ ingress }) => ({
      execute: async (actionId, input, context) => {
        if (
          !ingress?.machineAdmission ||
          !ingress.verifyMachineAdmissionCurrent ||
          !(await ingress.verifyMachineAdmissionCurrent())
        )
          return {
            ok: false,
            errorCode: 'machine_admission_required',
            error: 'machine_admission_required',
          };
        const credentials = await readStoredCredentialsForServerId(
          params.serverId,
        ).catch(() => null);
        if (
          !credentials ||
          credentials.token !== params.credentials.token ||
          readPreviewAccountIdFromToken(credentials.token) !==
            ingress.machineAdmission.actorAccountId
        )
          return {
            ok: false,
            errorCode: 'requester_credentials_unavailable',
            error: 'requester_credentials_unavailable',
          };
        await localServicesActionFeatureGate.refresh();
        const executor: ReturnType<
          typeof createCliActionExecutorFromCredentials
        > = createCliActionExecutorFromCredentials({
          credentials,
          machineId: params.machineId,
          serverId: params.serverId,
          serverApiUrl: params.serverBaseUrl,
          readCredentials: async () =>
            await readStoredCredentialsForServerId(params.serverId),
          machineActionDirectTargetTransport: {
            machineId: params.machineId,
            machineServiceAction: request => {
              const machine = params.getApiMachineForSessions();
              return machine ? machine.executeMachineServiceAction(request)
                : Promise.resolve({ kind: 'unavailable' as const, reason: 'admission_unavailable' as const });
            },
            machineReboot: request => {
              const machine = params.getApiMachineForSessions();
              return machine ? machine.executeMachineRebootAction({ ...request, context: { ...request.context,
                // Only this receiving factory possesses genuine transport custody.
                machineAdmission: ingress.machineAdmission,
                verifyMachineAdmissionCurrent: ingress.verifyMachineAdmissionCurrent,
              } }) : Promise.resolve({ kind: 'unavailable' as const, reason: 'admission_unavailable' as const });
            },
            invoke: async (method, request, options) => {
              const machine = params.getApiMachineForSessions();
              if (!machine) throw Object.assign(new Error('Machine transport is unavailable'), { code: 'machine_transport_unavailable' });
              return await machine.invokeLocalMachineAction(method, request, {
                ...options, rpcContext: options?.rpcContext ?? ingress,
              });
            },
          },
          resolveServerFeaturesSnapshot,
          prepareLocalServiceStartApproval: async ({ input, context, executeCanonicalAction }) => {
            const prepare = localServicesRuntime.launcherRoutes.prepareStartApproval;
            if (!prepare || !localServicesActionFeatureGate.isEnabled('localServices.launcher')) return {
              ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable',
            };
            return prepare(input, ingress, context, executeCanonicalAction);
          },
          runtimeActionExecute: createLocalServicesDaemonRuntimeActionExecutor({
            routes: localServicesRuntimeActionRoutes,
            ingress,
            featureGate: localServicesActionFeatureGate,
            prepareStartAction: (request, startContext) =>
              executor.prepare(
                'localServices.launcher.start',
                request,
                startContext,
              ),
          }),
        });
        return await executor.execute(actionId, input, context);
      },
    }),
    localServicesInventory: localServicesRuntime.inventoryRoutes,
    localServicesLauncher: localServicesRuntime.launcherRoutes,
    localServicesPreview: localServicesRuntime.previewRoutes,
    localServicesActions: localServicesRuntime.actionRoutes,
    localServicesPublicPreview:
      localServicesRuntimeActionRoutes.publicPreviewRoutes,
  };
  params.onLocalServicesRoutesReady?.(localServicesMachineRpcRoutes);
  params.onLocalServicesSummaryReady?.({
    ...localServicesRuntime,
    isProjectServiceExecutionLive: () =>
      localServicesRuntime.hasProjectServiceStarter() &&
      params.getApiMachineForSessions()?.isProjectFiniteExecutionLive() ===
        true &&
      localServicesActionFeatureGate.isEnabled('localServices.launcher') &&
      localServicesActionFeatureGate.isEnabled('localServices.managed'),
  });
  params.onLocalServicesPreviewRoutesReady?.(
    localServicesRuntime.previewRoutes,
  );
  params.onSimulatorPreviewRoutesReady?.(simulatorPreviewRuntime.routes);
  {
    const cleanupSessions = createRequesterMachineSessionAccessLossCleanup({
      serverId: params.serverId,
      machineId: params.machineId,
      pidToTrackedSession: params.pidToTrackedSession,
      retireRequesterCredentials: async (binding) => {
        const { retireRequesterSessionCredentialCustody } =
          await import('../sessionEncryption/requesterSessionCredentials');
        return await retireRequesterSessionCredentialCustody({
          happyHomeDir: configuration.happyHomeDir,
          ...binding,
        });
      },
      stopSession: async (sessionId, options) => {
        const expected = options?.expectedTrackedRunner;
        if (
          !expected ||
          params.pidToTrackedSession.get(expected.tracked.pid) !==
            expected.tracked
        ) {
          return { status: 'incomplete', reason: 'runner_signal_incomplete' };
        }
        return await stopSessionCore(sessionId, options);
      },
      beforeSignalExactTrackedRunner: (tracked) => {
        // Only after the final signed Home check: host custody is
        // not a manual requester Account/history mutation.
        if (tracked.happySessionId)
          sessionRunnerRespawnManager.markStopRequested(
            tracked.happySessionId,
            { reason: 'daemon_stop_session', requestedAtMs: Date.now() },
          );
      },
    });
    const cleanupServices = async (
      input: Parameters<typeof cleanupSessions>[0],
    ): Promise<Readonly<{ kind: 'settled' | 'incomplete' }>> => {
      try {
        if (
          input.machineId !== params.machineId ||
          !(await input.verifyCurrentMachineAdmission())
        ) {
          return { kind: 'incomplete' };
        }
        const lease = await acquireDaemonPluginRuntimeRegistryLease();
        try {
          const owner = lease.registry.projectManagedServices;
          const ownerIsCurrent = () =>
            pluginRuntimeController.getState().activeRegistry
              ?.projectManagedServices === owner;
          const verifyCurrentMachineAdmission = async () =>
            ownerIsCurrent() &&
            (await input.verifyCurrentMachineAdmission()) &&
            ownerIsCurrent();
          if (!(await verifyCurrentMachineAdmission()))
            return { kind: 'incomplete' };
          const witnesses = await owner.stopForAccessLoss(
            {
              serverId: params.serverId,
              accountId: input.requesterAccountId,
              machineId: input.machineId,
              installationId: input.installationId,
            },
            { verifyCurrentMachineAdmission },
          );
          const definitive = witnesses.every(
            (witness) =>
              witness.status === 'stopped' ||
              witness.status === 'cancelled_preparation',
          );
          return {
            kind:
              definitive && (await verifyCurrentMachineAdmission())
                ? 'settled'
                : 'incomplete',
          };
        } finally {
          await lease.release();
        }
      } catch {
        return { kind: 'incomplete' };
      }
    };
    const machineAccessLossReceiver: Parameters<ApiMachineClient['registerMachineAccessLossReceiver']>[0] = {
      serverId: params.serverId,
      readLiveWorkInventory: params.readLiveWorkInventory,
      resolveInstallationId: () =>
        readInstallationIdentityIfExistsSync()?.installationId ?? null,
      cleanupRequesterMachineSessions: cleanupSessions,
      cleanupRequesterMachineServices: cleanupServices,
    };
    if (params.onMachineAccessLossReceiverReady) {
      params.onMachineAccessLossReceiverReady(machineAccessLossReceiver);
    } else {
      params.getApiMachineForSessions()?.registerMachineAccessLossReceiver(machineAccessLossReceiver);
    }
  }
  const apiMachineForSessions = params.getApiMachineForSessions();
  apiMachineForSessions?.registerLocalServicesRoutes(
    localServicesMachineRpcRoutes,
  );
  apiMachineForSessions?.registerSimulatorPreviewRoutes(
    simulatorPreviewRuntime.routes,
  );
  const disposeControlRuntimeResources = async (): Promise<void> => {
    if (controlRuntimeResourcesDisposed) return;
    controlRuntimeResourcesDisposed = true;
    browserRoutePublication.retire();
    releaseInactiveSessionControlLaunchScope();
    runtimeActionRouteProviderTarget.setComputerRoutesProvider?.(null);
    const retiringComputerRoutes = computerRoutes;
    computerRoutes = null;
    await retiringComputerRoutes?.dispose();
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
    await browserRoutePublication.dispose();
    runtimeActionRouteProviderTarget.setLocalServicesRuntimeActionRoutesProvider?.(
      null,
    );
    runtimeActionRouteProviderTarget.setSimulatorPreviewRoutesProvider?.(null);
    await shutdownCancellationDomains.stopManagedLocalServices(
      localServicesRuntime,
    );
    browserRoutePublication.stopRecording();
    await simulatorPreviewRuntime.stop();
    // Tear down the long-lived iOS helper child process (SIGTERM) so a verified signed helper
    // never outlives the daemon. No-op when iOS stayed fail-closed (no session was created).
    await iosSimulatorHelperSession?.stop().catch((error: unknown) => {
      logger.debug(
        '[DAEMON RUN] Failed to stop iOS simulator helper session',
        error,
      );
    });
  };
  const resolveDaemonAuthBridge = async (
    serviceId: ConnectedAccountServiceKey,
  ): Promise<Readonly<{
    pluginId: string;
    registration: ConnectedServiceDaemonAuthBridgeRegistration;
  }> | null> => {
    const legacyServiceId =
      resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
        serviceId,
      );
    if (!legacyServiceId) return null;
    const service =
      resolveQualifiedConnectedAccountServiceForIngressServiceId(serviceId);
    if (!service) return null;
    return Object.freeze({
      pluginId: service.pluginId,
      registration: Object.freeze({
        serviceId,
        refresh: async (request, context) => {
          return await withSessionAccountContext(context?.target.sessionId || null, async (requesterContext) => {
            const refreshCoordinator = requesterContext
              ? (requesterContext.connectedServiceRefreshCoordinator ?? null)
              : params.getConnectedServiceRefreshCoordinator();
            if (!refreshCoordinator || !context || !context.isCurrent()) {
              return {
                status: 'unavailable' as const,
                reason: 'connected_service_daemon_auth_bridge_unavailable',
              };
            }
            const selection = context.target.connectedServiceSelections.find(
              (candidate) => candidate.serviceId === serviceId,
            );
            if (
              !selection?.credentialRevision ||
              !request.expectedCredentialRevision ||
              !request.refreshAttemptId
            ) {
              return {
                status: 'unavailable' as const,
                reason: 'connected_service_runtime_auth_target_unavailable',
              };
            }
            if (context.target.sessionId)
              await assertSessionAccountCurrent(
                context.target.sessionId,
                requesterContext,
              );
            const expectedCredentialRevision = request.expectedCredentialRevision;
            const refreshAttemptId = request.refreshAttemptId;
            return await withSessionAccountHome(requesterContext, async () => {
              const result =
                await refreshCoordinator.refreshConnectedServiceCredentialForRuntimeAuthBridge(
                  {
                    target: context.target,
                    isCurrent: context.isCurrent,
                    serviceId,
                    acceptSettledCredentialRevision:
                      context.acceptSettledCredentialRevision,
                    profileId:
                      selection.kind === 'profile'
                        ? selection.profileId
                        : selection.activeProfileId,
                    expectedCredentialRevision,
                    refreshAttemptId,
                    authority: request.runId
                      ? context.authority
                      : (params.pidToTrackedSession.get(context.target.pid) ??
                        context.authority),
                  },
                );
              if (context.target.sessionId)
                await assertSessionAccountCurrent(
                  context.target.sessionId,
                  requesterContext,
                );
              return result;
            });
          });
        },
      } satisfies ConnectedServiceDaemonAuthBridgeRegistration),
    });
  };
  const recoverExecutionRunRuntimeFailure: NonNullable<CreateExecutionRunConnectedServicesBridgeDeps['recoverRuntimeFailure']> = async ({ runId, parentSessionId, interruptedOriginId, selection, classification, isCurrent, signal, refreshCredential }) => {
        return await withSessionAccountContext(parentSessionId, async (context) => {
          const service = resolveQualifiedConnectedAccountServiceForIngressServiceId(selection.serviceId);
          if (!service || !isCurrent()) return { status: 'failed' as const, reason: 'runtime_recovery_stale' };
          const groupId = selection.kind === 'group' ? selection.groupId : null;
          const resumePromptMode = await resolveContinuationResumePromptMode({ serviceId: selection.serviceId, groupId,
            readAccountSettings: context ? () => context.readAccountSettingsSnapshot().settings : undefined,
            loadGroupPolicy: groupId ? async () => (await readQualifiedConnectedServiceAuthGroup({ serviceId: selection.serviceId, groupId, ...(parentSessionId ? { sessionId: parentSessionId } : {}) }))?.policy ?? null : undefined });
          const continuation = { interruptedOriginId, resumePromptMode, recoveryKind: classification.kind,
            customResumePrompt: readContinuationCustomResumePrompt(context ? context.readAccountSettingsSnapshot().settings : (getActiveAccountSettingsSnapshot()?.settings ?? null)) };
          const coordinator = await createSessionQualifiedAuthGroupSwitchCoordinator({ sessionId: parentSessionId, accountContext: context,
            serviceId: selection.serviceId, reason: classification.kind, applyGeneration: acknowledgeExecutionRunAuthGroupGeneration });
          const scope = { kind: 'run' as const, runId };
          const switchAttemptKey = { sessionId: connectedServiceRecoveryScopeKey(scope), serviceId: selection.serviceId,
            groupId: groupId ?? '', profileId: selection.kind === 'group' ? selection.activeProfileId : selection.profileId,
            credentialRevision: selection.credentialRevision ?? null };
          return await withSessionAccountHome(context, async () => {
            await assertSessionAccountCurrent(parentSessionId, context);
            if (!isCurrent()) return { status: 'failed' as const, reason: 'runtime_recovery_stale' };
            const result = await recoverConnectedServiceRuntimeFailure({ scope, selection, classification, signal, isCurrent, continuation, temporaryThrottleScheduler, refreshCredential, nowMs: () => Date.now(),
              switchesThisTurn: connectedServiceRuntimeAuthSwitchAttempts.resolveSwitchesThisTurn({ ...switchAttemptKey, reportedSwitchesThisTurn: 0 }),
              sessionSwitchesThisHour: connectedServiceRuntimeAuthSwitchAttempts.countRecordedSwitchesInWindow({ ...switchAttemptKey, windowMs: SESSION_SWITCH_LIMIT_WINDOW_MS }),
              switchCoordinator: { switchAfterClassifiedFailure: async (input) => {
                if (!coordinator || !isCurrent()) return { status: 'stale_context', generation: selection.kind === 'group' ? selection.generation : 0 };
                await assertSessionAccountCurrent(parentSessionId, context);
                const switched = await coordinator.switchAfterClassifiedFailure({ ...input, serviceId: service,
                  ...(selection.kind === 'group' && selection.credentialRevision ? { expectedFailureSource: {
                    profileId: selection.activeProfileId, groupGeneration: selection.generation,
                    credentialRevision: selection.credentialRevision, isCurrent,
                  } } : {}) });
                connectedServiceRuntimeAuthSwitchAttempts.recordSwitchResult({ ...switchAttemptKey, resultStatus: switched.status });
                return switched;
              } },
            });
            await assertSessionAccountCurrent(parentSessionId, context);
            return isCurrent() ? result
              : { status: 'failed' as const, reason: 'runtime_recovery_stale' };
          });
        }, undefined, signal);
      };
  const handleSessionConnectedServiceRuntimeAuthRefresh =
    createSessionConnectedServiceRuntimeAuthRefreshHandler({
      registry: connectedServiceRuntimeRegistry,
      resolveDaemonAuthBridge,
      onCredentialRevisionAdopted: async (accepted) => {
        const sessionId = accepted.target.sessionId;
        if (!sessionId || accepted.selection.kind !== 'profile'
          || connectedServiceRuntimeRegistry.getBySessionId(sessionId) !== accepted.target) return;
        for (const intent of runtimeAuthRecoveryScheduler.readForSession(sessionId)) {
          if (!intent.attemptId || intent.groupId !== null
            || intent.serviceId !== accepted.selection.serviceId
            || intent.profileId !== accepted.selection.profileId) continue;
          await runtimeAuthRecoveryScheduler.markAwaitingProviderOutcomeProofByKey({
            sessionId, serviceId: intent.serviceId, profileId: intent.profileId, groupId: null,
            failingAccessTokenFingerprint: intent.classification.failingAccessTokenFingerprint ?? null,
            expectedAttemptId: intent.attemptId,
            expectedPendingTargetCredentialRevision: accepted.previousCredentialRevision,
            result: { status: 'continuation_enqueued', credentialRevision: accepted.credentialRevision },
          });
        }
      },
      captureSessionAuthority: (target) => {
        const tracked = params.pidToTrackedSession.get(target.pid);
        if (
          !tracked ||
          !target.sessionId ||
          tracked.happySessionId !== target.sessionId
        )
          return null;
        return {
          identity: tracked,
          isCurrent: () =>
            params.pidToTrackedSession.get(target.pid) === tracked &&
            tracked.happySessionId === target.sessionId,
        };
      },
    });
  // Execution-run connected-services bridge: runners (which spawn run backends in-process) ask
  // the daemon to resolve + materialize via the canonical spawn-auth owner with a RUN-scoped
  // materialization key, and the run registers into the canonical runtime registry so its
  // refresh/quota views cover materialized run homes without either coordinator owning writes.
  const resolveExecutionRunMaterializationBaseDir = async (
    parentSessionId: string | null,
  ): Promise<string | null> => {
    if (parentSessionId === null) return params.connectedServicesMaterializationBaseDir;
    const tracked = findTrackedSessionByHappySessionId(
      params.pidToTrackedSession.values(),
      parentSessionId,
    );
    let attribution =
      tracked?.requesterWorkAttributionV1 ??
      tracked?.spawnOptions?.requesterWorkAttributionV1;
    if (!attribution) {
      const installation = readInstallationIdentityIfExistsSync();
      if (installation && params.requesterSessionCustodyServerId) {
        const retained = await listRequesterSessionCredentialBindings({
          happyHomeDir: configuration.happyHomeDir,
          serverId: params.requesterSessionCustodyServerId,
          machineId: params.machineId,
          installationId: installation.installationId,
        });
        if (retained.status !== 'ready') return null;
        attribution = retained.bindings.find(
          (binding) => binding.sessionId === parentSessionId,
        )?.attribution;
      }
    }
    if (attribution) {
      if (
        attribution.serverId !== params.serverId ||
        attribution.machineId !== params.machineId
      )
        return null;
      if (attribution.accountId === params.externalActionAccountId)
        return params.connectedServicesMaterializationBaseDir;
      return resolveRequesterSessionRuntimeDirectories({
        activeServerDir: configuration.activeServerDir,
        connectedServicesMaterializationBaseDir:
          params.connectedServicesMaterializationBaseDir,
        attribution,
      }).connectedServicesMaterializationBaseDir;
    }
    // Only an actual retained owned runner supplies ordinary cleanup custody.
    // Absence of a requester file does not assign an unknown Session to Alice.
    return tracked ? params.connectedServicesMaterializationBaseDir : null;
  };
  const captureExecutionRunConnectedServicesRunnerIdentity: CreateExecutionRunConnectedServicesBridgeDeps['captureRunnerIdentity'] = async ({ runnerPid, expectedParentSessionId, runId, controllerOccurrenceId }) => {
    if (runnerPid === process.pid && expectedParentSessionId === undefined && runId !== undefined) {
      // Detached Runs execute inside this daemon. The sealed lifecycle record,
      // not the visibility marker or a caller-selected PID, proves that owner.
      const record = await readRetainedExecutionRunRecord(runId).catch(() => null);
      const processIdentity = await readProcessIdentityByPid(process.pid);
      const attribution = record?.requesterWorkAttributionV1;
      if (record?.state.runId === runId && record.state.sessionId === null
        && record.ownerPid === process.pid && record.ownerProcessStartTimeMs !== undefined
        && processIdentity?.processStartTimeMs !== undefined
        && processGenerationMatches(record.ownerProcessStartTimeMs, processIdentity.processStartTimeMs)
        && (!attribution || attribution.accountId === params.externalActionAccountId
          && attribution.serverId === params.serverId && attribution.machineId === params.machineId)) {
        // A terminal sealed checkpoint stays terminal until native load succeeds.
        // Only its canonical in-flight resume can borrow this live host's custody.
        const resume = record.state.status !== 'running' && controllerOccurrenceId
          ? params.getApiMachineForSessions()?.captureExecutionRunResumeMaterialization(runId, controllerOccurrenceId)
          : null;
        if (record.state.status !== 'running' && !resume?.isCurrent()) return null;
        return Object.freeze({ identity: params, parentSessionId: null,
          isCurrent: () => !controlRuntimeResourcesDisposed && !isRuntimePublicationQuiescing()
            && (!resume || resume.isCurrent()) });
      }
    }
    const resolveTracked = () => params.pidToTrackedSession.get(runnerPid)
      ?? findTrackedSessionByRunnerPid(params.pidToTrackedSession, runnerPid);
    const tracked = resolveTracked();
    if (!tracked) return null;
    const parentSessionId = normalizeOptionalString(tracked.happySessionId);
    if (!parentSessionId || (expectedParentSessionId !== undefined && parentSessionId !== expectedParentSessionId)) return null;
    const runnerIdentity = resolveTrackedSessionRunnerIdentity(tracked);
    const runnerStartTimeMs = runnerIdentity?.processStartTimeMs;
    if (runId !== undefined) {
      // Run custody supplies Session/host lineage, independently of marker visibility.
      const record = await readRetainedExecutionRunRecord(runId).catch(() => null);
      if (!record || record.state.runId !== runId || record.state.sessionId !== parentSessionId
        || !runnerIdentity || runnerIdentity.pid !== runnerPid) return null;
    }
    return Object.freeze({ identity: tracked, parentSessionId,
      isCurrent: () => {
        const currentRunner = resolveTrackedSessionRunnerIdentity(tracked);
        return resolveTracked() === tracked && tracked.happySessionId === parentSessionId
          && (runId === undefined || (currentRunner?.pid === runnerPid && runnerStartTimeMs !== undefined
            && processGenerationMatches(currentRunner.processStartTimeMs, runnerStartTimeMs)));
      },
    });
  };
  const executionRunConnectedServicesBridge =
    createExecutionRunConnectedServicesBridge({
      classifyRuntimeFailure: classifyConnectedServiceRuntimeFailureForTarget,
      recoverRuntimeFailure: recoverExecutionRunRuntimeFailure,
      recordRuntimeTurnCompleted: async ({ runId }) => {
        const lifecycle = { sessionId: connectedServiceRecoveryScopeKey({ kind: 'run', runId }),
          event: 'assistant_message_end' as const, terminalStatus: 'completed' as const };
        connectedServiceRuntimeAuthSwitchAttempts.recordTurnLifecycle(lifecycle);
        await temporaryThrottleScheduler.recordTurnLifecycle({ ...lifecycle, observedAtMs: Date.now() });
      },
      getRunRuntimeTarget: (runKey) =>
        connectedServiceRuntimeRegistry.getRunTargetByRunKey(runKey),
      adoptRunCredentialRevision: (input) =>
        connectedServiceRuntimeRegistry.adoptExactCredentialRevisionForRun(
          input,
        ),
      resolveRunCredentialRevisionTarget: (input) =>
        connectedServiceRuntimeRegistry.resolveExactRunCredentialRevisionTarget(
          input,
        ),
      resolveDaemonAuthBridge,
      recoverRejectedStart: async ({
        parentSessionId,
        selection,
        modelId,
        isCurrent,
      }) => {
        const service =
          resolveQualifiedConnectedAccountServiceForIngressServiceId(
            selection.serviceId,
          );
        if (
          !service ||
          !selection.credentialRevision ||
          !isCurrent() ||
          params.resolveQualifiedConnectedAccountV4Support?.() !== 'advertised'
        ) {
          return { status: 'stale_context', generation: selection.generation };
        }
        const credentialRevision = selection.credentialRevision;
        return await withSessionAccountContext(parentSessionId, async (context) => {
          const coordinator =
            await createSessionQualifiedAuthGroupSwitchCoordinator({
              sessionId: parentSessionId,
              accountContext: context,
              serviceId: selection.serviceId,
              reason: 'execution_run_rejected_start',
              applyGeneration: acknowledgeExecutionRunAuthGroupGeneration,
            });
          if (!coordinator || !isCurrent())
            return { status: 'stale_context' as const, generation: selection.generation };
          // Pool truth changes here; this Run's host releases and rematerializes its own
          // activation. The request-auth coordinator's applyGeneration does no Session work.
          await assertSessionAccountCurrent(parentSessionId, context);
          return await withSessionAccountHome(context, () =>
            coordinator.switchAfterClassifiedFailure({
              serviceId: service,
              groupId: selection.groupId,
              observedProfileId: selection.activeProfileId,
              reason: 'plan',
              limitCategory: 'plan_invalid',
              quotaScope: 'model',
              providerLimitId: modelId,
              rejectedStart: true,
              expectedFailureSource: {
                profileId: selection.activeProfileId,
                groupGeneration: selection.generation,
                credentialRevision,
                isCurrent,
              },
            }),
          );
        });
      },
      resolveAuthForSpawn: async ({ parentSessionId, ...input }) => {
        const context = await readRequesterHomeWithinActionLifetime(
          () => resolveSessionAccountContext(parentSessionId, undefined, input.signal), input.signal);
        const assertPreparationCurrent = () => readRequesterHomeWithinActionLifetime(
          () => assertSessionAccountCurrent(parentSessionId, context, undefined, input.signal), input.signal);
        let retained = false;
        try {
          await assertPreparationCurrent();
          const resolved = await withSessionAccountHome(context, () =>
            resolveExecutionRunAuthForSpawn({
              ...input,
              ...(parentSessionId ? { sessionId: parentSessionId } : {}),
              activeServerDir:
                context?.activeServerDir ?? configuration.activeServerDir,
              baseDir:
                context?.connectedServicesMaterializationBaseDir ??
                params.connectedServicesMaterializationBaseDir,
              credentials: context?.bootstrap.credentials ?? params.credentials,
              api: context?.api ?? params.api,
              accountUsageStore:
                context?.providerAccountUsageStore ?? providerAccountUsageStore,
              quotaFreshnessMs: 5 * 60_000,
              nowMs: () => Date.now(),
              predictiveSwitchGuard: context
                ? (context.predictiveSwitchGuard ?? null)
                : (connectedServicePredictiveSwitchGuard ?? null),
              accountSettings: context
                ? context.readAccountSettingsSnapshot().settings
                : (getActiveAccountSettingsSnapshot()?.settings ?? null),
              processEnv: params.processEnv ?? process.env,
              credentialRefreshService: context
                ? context.connectedServiceRefreshCoordinator
                : params.getConnectedServiceRefreshCoordinator(),
              ...(context
                ? {
                    allowNativeAccountState: false,
                    connectedAccountsOwner: context.connectedAccountsOwner,
                    requesterWorkAttributionV1: context.bootstrap.attribution,
                    isAccountRuntimeCurrent: async () => {
                      await assertPreparationCurrent();
                      return true;
                    },
                  }
                : {}),
            }, selection => createSessionQualifiedAuthGroupSwitchCoordinator({
              ...selection,
              sessionId: parentSessionId,
              accountContext: context,
            })),
          );
          try {
            await assertPreparationCurrent();
          } catch (error) {
            try { await resolved?.cleanupOnFailure?.(); }
            finally { await resolved?.materializationPurposeLease?.dispose(); }
            throw error;
          }
          if (!resolved) return null;
          retained = true;
          return { ...resolved, releaseAccountContext: async () => await releaseSessionAccountContext(context) };
        } finally {
          if (!retained) await releaseSessionAccountContext(context);
        }
      },
      registerRunTargets: (registration, signal) => {
        return registerExecutionRunConnectedServicesTarget({ registry: connectedServiceRuntimeRegistry,
          registration, withSessionAccountContext, assertSessionAccountCurrent, signal });
      },
      unregisterRunTargets: (runKey) => {
        connectedServiceRuntimeRegistry.unregisterRunKey(runKey);
      },
      finishRunRecovery: async (runKey) => {
        connectedServiceRuntimeAuthSwitchAttempts.clearSession(connectedServiceRecoveryScopeKey({ kind: 'run', runId: runKey }));
        await temporaryThrottleScheduler.finishRun(runKey);
      },
      resolveRunMaterializedRoot: async ({
        runKey,
        agentId,
        parentSessionId,
      }) => {
        const baseDir =
          await resolveExecutionRunMaterializationBaseDir(parentSessionId);
        return baseDir
          ? resolveConnectedServiceMaterializedRootDir({
              baseDir,
              materializationKey: runKey,
              agentId,
            })
          : null;
      },
      createAdoptedRootCleanup: async ({
        runKey,
        agentId,
        materializedRoot,
        parentSessionId,
      }) => {
        const baseDir =
          await resolveExecutionRunMaterializationBaseDir(parentSessionId);
        // A retained ordinary marker may already carry its exact root even
        // when its runner is gone. The canonical cleanup owner validates it
        // against the ordinary root; a Bob/unknown root never passes that proof.
        return createAdoptedExecutionRunRootCleanup({
          materializationBaseDir:
            baseDir ?? params.connectedServicesMaterializationBaseDir,
          materializationKey: runKey,
          agentId,
          materializedRoot,
          removeRoot: async (root) => {
            await rm(root, { recursive: true, force: true });
          },
        });
      },
      captureRunnerIdentity: captureExecutionRunConnectedServicesRunnerIdentity,
      acquireAgentPurposeContributions: async ({ agentId }) => {
        const lease = await acquireDaemonPluginRuntimeRegistryLease();
        let catalogEntry;
        try {
          catalogEntry = await lease.registry.acquireAgentCatalogEntry?.(agentId);
        } catch (error) {
          await lease.release();
          throw error;
        }
        return Object.freeze({
          contributions: lease.registry.contributes,
          catalogEntry,
          // The same registry that supplies the declarations also owns the committed
          // immutable generation those declarations came from, so both facts are read
          // through this one lease rather than resolved again later.
          resolveAgentContributionIdentity: async () => {
            const identity =
              lease.registry.contributes.agentDefinitionsById.get(
                agentId,
              )?.identity;
            if (!identity) return null;
            const sourceCustody =
              lease.registry.readPluginSourceCustody?.(identity.pluginId) ??
              null;
            if (!sourceCustody) return null;
            return Object.freeze({
              pluginId: identity.pluginId,
              localId: identity.localId,
              sourceCustody,
            });
          },
          isCurrent: () =>
            pluginRuntimeController.isRuntimeRegistryCurrent(lease.registry),
          release: lease.release,
        });
      },
      purposeBindingOwner: Object.freeze({
        activatePurposeBindings: async (input, { parentSessionId, signal }) => {
          const context = await readRequesterHomeWithinActionLifetime(
            () => resolveSessionAccountContext(parentSessionId, undefined, signal), signal);
          try {
            const activate = context
              ? context.activatePurposeBindings
              : params.activatePurposeBindings;
            if (!activate)
              throw new Error(
                'connected_account_purpose_binding_owner_unavailable',
              );
            await readRequesterHomeWithinActionLifetime(
              () => assertSessionAccountCurrent(parentSessionId, context, undefined, signal), signal);
            const lease = await withSessionAccountHome(context, async () =>
              activate(input),
            );
            return { lease, releaseAccountContext: async () => await releaseSessionAccountContext(context) };
          } catch (error) {
            await releaseSessionAccountContext(context);
            throw error;
          }
        },
      }),
      requestAuthRegistry: connectedAccountRequestAuthRegistry,
      resolveRequestAuthHttpPort: requireConnectedAccountRequestAuthHttpPort,
      createRedactionLease: () => createProviderRedactionLease({ values: [] }),
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
  const enforcedProviderInputAdmissions = new Map<
    string,
    EnforcedProviderInputAdmission
  >();
  const enforcedUnavailableProviderInputAdmissions = new Map<
    string,
    EnforcedUnavailableProviderInputAdmission
  >();
  const pendingProviderInputAdmissionsByEpochId = new Map<
    string,
    EnforcedProviderInputAdmission
  >();
  const providerInputAdmissionRecords =
    createProviderInputAdmissionRecordTracker<EnforcedCurrentTruthProviderInputAdmission>();
  const providerInputAdmissionScopeKey = (
    sessionId: string,
    serviceId: string,
    groupId: string,
  ) => `${sessionId}\0${serviceId}\0${groupId}`;
  const registeredTargetMatchesProviderInputAdmission = (
    target: ConnectedServiceRuntimeTarget,
    admission: EnforcedProviderInputAdmission,
  ): boolean => {
    const exactSelection = target.connectedServiceSelections.some(
      (selection) =>
        selection.serviceId === admission.desired.serviceId &&
        selection.kind === 'group' &&
        selection.groupId === admission.desired.groupId &&
        selection.activeProfileId === admission.desired.profileId &&
        selection.generation === admission.desired.generation &&
        selection.credentialRevision === admission.desired.credentialRevision,
    );
    return target.activeBindings.some(
      (binding) =>
        binding.serviceId === admission.desired.serviceId &&
        binding.groupId === admission.desired.groupId &&
        binding.profileId === admission.desired.profileId &&
        binding.groupGeneration === admission.desired.generation &&
        // The live binding is retained for legacy readers, but admission
        // transfer is authorized only by the post-hot-apply selection's
        // exact revision—not by a null binding revision.
        (binding.credentialRevision === admission.desired.credentialRevision ||
          exactSelection),
    );
  };
  advanceProviderInputAdmissionsAfterHotApplyRegistration = ({
    previousTarget,
    registeredTarget,
  }) => {
    if (
      !previousTarget ||
      registeredTarget.pid !== previousTarget.pid ||
      registeredTarget.sessionId !== previousTarget.sessionId
    )
      return;
    const registeredWitness =
      captureProviderInputAdmissionTargetWitness(registeredTarget);
    if (
      !registeredWitness ||
      !isCurrentProviderInputAdmissionTarget(registeredWitness)
    )
      return;
    for (const admission of pendingProviderInputAdmissionsByEpochId.values()) {
      if (
        admission.target !== previousTarget ||
        admission.targetWitness.targetReference !== previousTarget ||
        admission.targetWitness.runtimeIdentityKey !==
          previousTarget.runtimeIdentityKey ||
        admission.targetWitness.revision !== previousTarget.revision ||
        !registeredTargetMatchesProviderInputAdmission(
          registeredTarget,
          admission,
        )
      )
        continue;
      admission.target = registeredTarget;
      admission.targetWitness = registeredWitness;
    }
    for (const [
      scopeKey,
      admission,
    ] of enforcedUnavailableProviderInputAdmissions) {
      if (
        admission.target !== previousTarget ||
        admission.targetWitness.targetReference !== previousTarget ||
        admission.targetWitness.runtimeIdentityKey !==
          previousTarget.runtimeIdentityKey ||
        admission.targetWitness.revision !== previousTarget.revision
      )
        continue;
      enforcedUnavailableProviderInputAdmissions.set(scopeKey, {
        ...admission,
        target: registeredTarget,
        targetWitness: registeredWitness,
      });
    }
  };
  const resolveSharedGenerationTargetMaterializedEnv = async (
    input: Readonly<{
      ownerId: CatalogAgentId;
      tracked: TrackedSession | null;
      accountContext?: RequesterSessionRuntimeContext | null;
      target: Readonly<{
        serviceId: ConnectedAccountServiceKey;
        groupId: string;
        profileId: string;
        generation: number;
      }>;
    }>,
  ): Promise<Readonly<Record<string, string>> | null> => {
    if (input.tracked) {
      return input.tracked.spawnOptions?.environmentVariables ?? {};
    }
    const descriptor = await getConnectedServiceStateSharingDescriptor(
      input.ownerId,
    ).catch(() => null);
    if (
      descriptor?.providerSupportStatus !== 'supported' ||
      !descriptor.nativeHome
    ) {
      return null;
    }
    const legacyServiceId =
      resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
        input.target.serviceId,
      );
    if (!legacyServiceId) return null;
    const materializedRoot = await readCurrentCatalogHook(input.ownerId, entry => resolveConnectedServiceMaterializedHomeRoot(
      input.ownerId,
      {
        activeServerDir:
          input.accountContext?.activeServerDir ??
          configuration.activeServerDir,
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
      },
      entry,
    ));
    return materializedRoot
      ? { [descriptor.nativeHome.environmentKey]: materializedRoot,
          [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: materializedRoot }
      : null;
  };
  const createDurableGenerationConsumer = (
    options?: Readonly<{
      allowProviderInputAdmissionWrites?: boolean;
      accountContext?: RequesterSessionRuntimeContext | null;
      sessionId?: string;
    }>,
  ) => {
    const accountContext = options?.accountContext ?? null;
    const sessionCredentials =
      accountContext?.bootstrap.credentials ?? params.credentials;
    const sessionApi = accountContext?.api ?? params.api;
    const sessionRuntimeRegistry = accountContext
      ? accountContext.connectedServiceRuntimeRegistry
      : connectedServiceRuntimeRegistry;
    if (!sessionRuntimeRegistry)
      throw new Error('requester_session_runtime_owner_unavailable');
    const resolveSessionProjection = async () => {
      if (!accountContext)
        return (
          latestConnectedServiceProjectionSnapshot ??
          (await fetchConnectedServiceProjectionSnapshot())
        );
      if (!options?.sessionId) throw new Error('requester_session_not_current');
      await assertSessionAccountCurrent(options.sessionId, accountContext);
      return await fetchConnectedServiceProjectionSnapshot(
        undefined,
        options.sessionId,
      );
    };
    const allowProviderInputAdmissionWrites =
      options?.allowProviderInputAdmissionWrites === true;
    const enforceGenerationProviderInputAdmissions = async (
      input: Readonly<{
        target: Readonly<{
          serviceId: ConnectedAccountServiceKey;
          groupId: string;
          profileId: string;
          generation: number;
          credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
        }>;
        sessionIds: readonly string[];
        executionAuthority: ConnectedServiceGenerationExecutionAuthority;
      }>,
    ): Promise<
      | Readonly<{
          status: 'ready';
          admissionsBySessionId: Map<
            string,
            EnforcedCurrentTruthProviderInputAdmission
          >;
        }>
      | Readonly<{
          status: 'failed';
          result: Readonly<{
            reconciliationDisposition: 'failed';
            errorCode: string;
          }>;
        }>
    > => {
      for (const sessionId of input.sessionIds)
        await assertSessionAccountCurrent(sessionId, accountContext);
      const admissionsBySessionId = new Map<
        string,
        EnforcedCurrentTruthProviderInputAdmission
      >();
      for (const sessionId of input.sessionIds) {
        const unavailable = enforcedUnavailableProviderInputAdmissions.get(
          providerInputAdmissionScopeKey(
            sessionId,
            input.target.serviceId,
            input.target.groupId,
          ),
        );
        if (
          unavailable &&
          isCurrentProviderInputAdmissionTarget(unavailable.targetWitness)
        ) {
          admissionsBySessionId.set(sessionId, unavailable);
        }
      }
      if (input.executionAuthority === 'passive_projection') {
        return { status: 'ready', admissionsBySessionId };
      }
      for (const sessionId of input.sessionIds) {
        if (admissionsBySessionId.get(sessionId)?.kind === 'group_unavailable')
          continue;
        const admissionTarget =
          sessionRuntimeRegistry.getBySessionId(sessionId);
        if (!admissionTarget) continue;
        const targetWitness =
          captureProviderInputAdmissionTargetWitness(admissionTarget);
        if (!targetWitness) {
          return {
            status: 'failed',
            result: {
              reconciliationDisposition: 'failed',
              errorCode: 'provider_input_admission_target_released',
            },
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
        const admissionOutcome = await requestProviderInputAdmissionForTarget(
          admissionTarget,
          {
            action: 'enforce',
            reason: 'generation_pending',
            serviceId: input.target.serviceId,
            groupId: input.target.groupId,
            epochId,
          },
          targetWitness,
        );
        if (admissionOutcome.status === 'cancelled') {
          return {
            status: 'failed',
            result: {
              reconciliationDisposition: 'failed',
              errorCode: 'provider_input_admission_cancelled',
            },
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
          providerInputAdmissionScopeKey(
            sessionId,
            input.target.serviceId,
            input.target.groupId,
          ),
          enforcedAdmission,
        );
        pendingProviderInputAdmissionsByEpochId.set(epochId, enforcedAdmission);
      }
      return { status: 'ready', admissionsBySessionId };
    };
    const recordGenerationProviderInputAdmissions = (
      input: Readonly<{
        admissionsBySessionId: ReadonlyMap<
          string,
          EnforcedCurrentTruthProviderInputAdmission
        >;
        adoptedTarget: object;
      }>,
    ): void => {
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
        await assertSessionAccountCurrent(sessionId, accountContext);
        const target = sessionRuntimeRegistry.getBySessionId(sessionId);
        if (!target) return;
        const targetWitness =
          captureProviderInputAdmissionTargetWitness(target);
        if (!targetWitness)
          throw new Error('provider_input_admission_target_released');
        const outcome = await requestProviderInputAdmissionForTarget(
          target,
          {
            action: 'enforce',
            reason: 'group_unavailable',
            serviceId,
            groupId,
          },
          targetWitness,
        );
        if (outcome.status === 'cancelled')
          throw new Error('provider_input_admission_cancelled');
        enforcedUnavailableProviderInputAdmissions.set(
          providerInputAdmissionScopeKey(sessionId, serviceId, groupId),
          {
            kind: 'group_unavailable',
            target,
            targetWitness,
            serviceId,
            groupId,
          },
        );
      },
      clearAdoptedGeneration: async (pending) => {
        const adopted = pending.providerAdoptedTarget;
        if (adopted.credentialRevision === null) {
          throw new Error('provider_adoption_authoritative_fence_superseded');
        }
        await assertSessionAccountCurrent(pending.sessionId, accountContext);
        const projection = await resolveSessionProjection();
        const current =
          projection.groups.find(
            (group) =>
              group.serviceId === adopted.serviceId &&
              group.groupId === adopted.groupId,
          ) ?? null;
        const admissionKey = providerInputAdmissionScopeKey(
          pending.sessionId,
          adopted.serviceId,
          adopted.groupId,
        );
        const recordedAdmission = providerInputAdmissionRecords.read({
          sessionId: pending.sessionId,
          adoptedTarget: adopted,
        });
        const scopedAdmission =
          enforcedProviderInputAdmissions.get(admissionKey);
        const unavailableAdmission =
          enforcedUnavailableProviderInputAdmissions.get(admissionKey);
        let admission =
          recordedAdmission ??
          (scopedAdmission &&
          scopedAdmission.desired.serviceId === adopted.serviceId &&
          scopedAdmission.desired.groupId === adopted.groupId &&
          scopedAdmission.desired.profileId === adopted.profileId &&
          scopedAdmission.desired.generation === adopted.generation &&
          scopedAdmission.desired.credentialRevision ===
            adopted.credentialRevision
            ? scopedAdmission
            : unavailableAdmission);
        if (
          !current ||
          current.serviceId !== adopted.serviceId ||
          current.groupId !== adopted.groupId ||
          current.activeProfileId !== adopted.profileId ||
          current.generation !== adopted.generation ||
          projection.resolveCredentialRevision(
            adopted.serviceId,
            adopted.profileId,
          ) !== adopted.credentialRevision
        )
          throw new Error('provider_adoption_authoritative_fence_superseded');
        const settledRuntimeTarget =
          sessionRuntimeRegistry.adoptExactGroupApplicationForSession({
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
        if (
          admission &&
          !isCurrentProviderInputAdmissionTarget(admission.targetWitness)
        ) {
          const currentTarget = sessionRuntimeRegistry.getBySessionId(
            pending.sessionId,
          );
          const currentWitness = currentTarget
            ? captureProviderInputAdmissionTargetWitness(currentTarget)
            : null;
          const currentTargetMatchesAdopted =
            currentTarget?.activeBindings.some(
              (binding) =>
                binding.serviceId === adopted.serviceId &&
                binding.groupId === adopted.groupId &&
                binding.profileId === adopted.profileId &&
                binding.groupGeneration === adopted.generation &&
                binding.credentialRevision === adopted.credentialRevision,
            ) === true;
          if (
            currentTarget &&
            currentWitness &&
            admission.target.pid === currentTarget.pid &&
            currentTargetMatchesAdopted
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
              enforcedUnavailableProviderInputAdmissions.set(
                admissionKey,
                admission,
              );
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
            admission.kind === 'generation_pending' &&
            pendingProviderInputAdmissionsByEpochId.get(admission.epochId) ===
              admission
          ) {
            pendingProviderInputAdmissionsByEpochId.delete(admission.epochId);
          }
          if (
            admission.kind === 'generation_pending' &&
            enforcedProviderInputAdmissions.get(admissionKey) === admission
          ) {
            enforcedProviderInputAdmissions.delete(admissionKey);
          }
          if (
            admission.kind === 'group_unavailable' &&
            enforcedUnavailableProviderInputAdmissions.get(admissionKey) ===
              admission
          ) {
            enforcedUnavailableProviderInputAdmissions.delete(admissionKey);
          }
        };
        const clearResult =
          await clearProviderInputAdmissionAfterDurableAdoption({
            verifyAdoptionStillCurrent: () =>
              !admission ||
              isCurrentProviderInputAdmissionTarget(admission.targetWitness),
            // Current projection + exact provider proof are the canonical adoption fence.
            // Pending generation state is runtime-local, so there is no offline session row to clear.
            clearDurableAdoption: async () => ({ status: 'cleared' as const }),
            hasOutstandingRunnerAdmission: () =>
              admission !== undefined &&
              isCurrentProviderInputAdmissionTarget(admission.targetWitness) &&
              enforcedProviderInputAdmissions.get(admissionKey) === admission,
            clearRunnerAdmission: async () => {
              if (!admission && !allowProviderInputAdmissionWrites) {
                return { status: 'cleared' as const };
              }
              const runtimeTarget =
                admission?.target ??
                sessionRuntimeRegistry.getBySessionId(pending.sessionId);
              if (!runtimeTarget) return;
              if (admission) {
                const clearOutcome =
                  await requestProviderInputAdmissionForTarget(
                    runtimeTarget,
                    {
                      action: 'clear',
                      serviceId: adopted.serviceId,
                      groupId: adopted.groupId,
                      applicationSettled: true,
                      ...(admission.kind === 'generation_pending'
                        ? { epochId: admission.epochId }
                        : {}),
                    },
                    admission.targetWitness,
                  );
                if (clearOutcome.status === 'cancelled') {
                  throw new Error('provider_input_admission_cancelled');
                }
                if (clearOutcome.value.status === 'enforced') {
                  throw new Error(
                    'provider_input_admission_clear_invalid_response',
                  );
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
        await assertSessionAccountCurrent(sessionId, accountContext);
        const tracked = findTrackedSessionByHappySessionId(
          params.pidToTrackedSession.values(),
          sessionId,
        );
        const trackedAgentId = resolveTrackedSessionCatalogAgentId(tracked);
        if (tracked && trackedAgentId !== applicationOwnerId) return null;
        const agentId =
          trackedAgentId ?? (applicationOwnerId as CatalogAgentId);
        const targetMaterializedEnv =
          await resolveSharedGenerationTargetMaterializedEnv({
            ownerId: agentId,
            accountContext,
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
            const resolutions =
              await resolveConnectedServiceCredentialResolutions({
                credentials: sessionCredentials,
                api: sessionApi,
                bindings: [{ ...binding, serviceId: legacyServiceId }],
              });
            const resolution = resolutions.get(legacyServiceId) ?? null;
            return resolution?.revisionSemantics === 'revisioned'
              ? resolution
              : null;
          },
          resolveRuntimeAuthAdapter: async (resolvedAgentId) =>
            await getConnectedServiceRuntimeAuthAdapter(
              resolvedAgentId as CatalogAgentId,
            ),
        });
      },
      resolveGenerationApplicationScope: async ({
        sessionId,
        serviceId,
        applicationOwnerId,
      }) => {
        await assertSessionAccountCurrent(sessionId, accountContext);
        const tracked = findTrackedSessionByHappySessionId(
          params.pidToTrackedSession.values(),
          sessionId,
        );
        const agentId = resolveTrackedSessionCatalogAgentId(tracked);
        return await resolveConnectedServiceGenerationApplicationScope(
          serviceId,
          agentId
            ? (agentId as CatalogAgentId)
            : (applicationOwnerId as CatalogAgentId | null),
        );
      },
      applySharedGenerationApplication: async ({
        representativeSessionId,
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
          return {
            reconciliationDisposition: 'failed',
            errorCode: 'credential_revision_missing',
          };
        }
        const legacyTargetServiceId =
          resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
            target.serviceId,
          );
        if (!legacyTargetServiceId) {
          return {
            reconciliationDisposition: 'failed',
            errorCode: 'shared_generation_application_unavailable',
          };
        }
        const ownerId = applicationOwnerId as CatalogAgentId;
        const scope = await resolveConnectedServiceGenerationApplicationScope(
          target.serviceId,
          ownerId,
        );
        if (
          scope.status !== 'supported' ||
          scope.scope !== 'shared_group_auth_surface'
        ) {
          return {
            reconciliationDisposition: 'failed',
            errorCode: 'shared_generation_application_unavailable',
          };
        }
        const resolutions = await resolveConnectedServiceCredentialResolutions({
          credentials: sessionCredentials,
          api: sessionApi,
          bindings: [
            { serviceId: legacyTargetServiceId, profileId: target.profileId },
          ],
        }).catch(() => null);
        const resolution = resolutions?.get(legacyTargetServiceId) ?? null;
        if (
          !resolution ||
          resolution.revisionSemantics !== 'revisioned' ||
          resolution.credentialRevision !== target.credentialRevision
        ) {
          return {
            reconciliationDisposition: 'failed',
            errorCode: 'credential_revision_superseded',
          };
        }
        const targetMaterializedEnv =
          await resolveSharedGenerationTargetMaterializedEnv({
            ownerId,
            accountContext,
            tracked: null,
            target,
          });
        const adapter = await getConnectedServiceRuntimeAuthAdapter(
          ownerId,
        ).catch(() => null);
        if (!targetMaterializedEnv || !adapter?.hotApply) {
          return {
            reconciliationDisposition: 'failed',
            errorCode: 'shared_generation_application_unavailable',
          };
        }
        const targetMaterializedRoot =
          resolveConnectedServiceTargetMaterializedRoot({
            agentId: ownerId,
            targetMaterializedEnv,
          });
        const nativeHome = targetMaterializedRoot
          ? await createConnectedServiceRuntimeAuthNativeHome({
              agentId: ownerId,
              root: targetMaterializedRoot,
              isCurrent: async () => {
                await assertSessionAccountCurrent(
                  representativeSessionId,
                  accountContext,
                );
                return true;
              },
            })
          : null;
        const supersedingTargetObservation: {
          authoritativeTarget?: Readonly<{
            profileId: string;
            generation: number;
            credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
          }>;
        } = {};
        const applied = await adapter
          .hotApply({
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
              await assertSessionAccountCurrent(
                representativeSessionId,
                accountContext,
              );
              const currentness =
                await validateConnectedServiceGroupMutationCurrentness(
                  {
                    serviceId: target.serviceId,
                    groupId: target.groupId,
                    profileId: target.profileId,
                    generation: target.generation,
                    credentialRevision: target.credentialRevision,
                  },
                  representativeSessionId,
                );
              if (
                currentness.current === false &&
                currentness.authoritativeTarget
              ) {
                supersedingTargetObservation.authoritativeTarget =
                  currentness.authoritativeTarget;
              }
              return currentness;
            },
          })
          .catch(() => null);
        if (!applied?.applied) {
          const authoritativeTarget =
            supersedingTargetObservation.authoritativeTarget;
          if (
            applied?.status === 'superseded_after_apply' &&
            authoritativeTarget
          ) {
            return mapCommittedGenerationApplyResult({
              committedGeneration,
              result: {
                status: 'superseded_after_apply',
                activeProfileId: authoritativeTarget.profileId,
                generation: authoritativeTarget.generation,
                credentialRevision: authoritativeTarget.credentialRevision,
                errorCode:
                  typeof applied.reason === 'string' ? applied.reason : null,
              },
            });
          }
          return {
            reconciliationDisposition: 'failed',
            errorCode:
              typeof applied?.reason === 'string'
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
          return {
            reconciliationDisposition: 'failed',
            errorCode: 'shared_generation_application_unverified',
          };
        }
        recordGenerationProviderInputAdmissions({
          admissionsBySessionId: admissions.admissionsBySessionId,
          adoptedTarget: adopted,
        });
        return {
          reconciliationDisposition: 'converged',
          errorCode: null,
          providerAdoptedTarget: adopted,
        };
      },
      applyCommittedGeneration: async ({
        sessionId,
        committedGeneration,
        generationApplyReason,
        executionAuthority,
        applicationOwnerId,
        applicationCohortSessionIds,
      }) => {
        const target = committedGeneration.decisionCommittedTarget;
        const admissionSessionIds = [
          ...new Set(applicationCohortSessionIds ?? [sessionId]),
        ];
        const admissions = await enforceGenerationProviderInputAdmissions({
          target,
          sessionIds: admissionSessionIds,
          executionAuthority,
        });
        if (admissions.status === 'failed') return admissions.result;
        const tracked = findTrackedSessionByHappySessionId(
          params.pidToTrackedSession.values(),
          sessionId,
        );
        if (!tracked)
          return {
            reconciliationDisposition: 'failed',
            errorCode: 'session_not_found',
          };
        const result =
          await connectedServiceAuthGroupPreTurnSwitchCoordinator.applyCommittedGeneration(
            {
              sessionId,
              serviceId: target.serviceId,
              groupId: target.groupId,
              activeProfileId: target.profileId,
              generation: target.generation,
              credentialRevision: target.credentialRevision,
              reason: generationApplyReason,
              allowRestart: executionAuthority !== 'passive_projection',
              executionAuthority,
            },
          );
        const mapped = mapCommittedGenerationApplyResult({
          committedGeneration,
          result,
        });
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
    input: Parameters<
      ConnectedServiceAuthGroupGenerationConsumer['consume']
    >[0],
  ) => {
    return await withSessionAccountContext(input.sessions[0]?.sessionId ?? null, async (accountContext) => {
      for (const session of input.sessions)
        await assertSessionAccountCurrent(session.sessionId, accountContext);
      return await withSessionAccountHome(accountContext, () =>
        createDurableGenerationConsumer({
          accountContext,
          sessionId: input.sessions[0]?.sessionId,
          allowProviderInputAdmissionWrites:
            input.executionAuthority !== 'passive_projection',
        }).consume(input),
      );
    });
  };
  const runtimeGenerationTarget = (
    target: ReturnType<ConnectedServiceRuntimeRegistry['listTargets']>[number],
  ) => ({
    sessionId: target.sessionId,
    agentId: target.agentId,
    connectedServiceMaterializationIdentityV1:
      target.connectedServiceMaterializationIdentityV1,
    connectedServicesBindingsRaw: target.connectedServicesBindingsRaw,
    activeBindings: target.activeBindings.map((binding) => ({
      serviceId: binding.serviceId,
      groupId: binding.groupId,
      profileId: binding.profileId,
      generation: binding.groupGeneration,
      credentialRevision: binding.credentialRevision,
    })),
  });
  const isCurrentRuntimeGenerationTarget = (
    target: ConnectedServiceRuntimeTarget,
  ): boolean => {
    // Exit settlement can retain a tracked entry after its purpose lease is
    // disposed, or remove it before unregistering the target. Registry
    // membership alone cannot authorize Session rematerialization.
    if (!connectedServiceRuntimeRegistry.isRunTarget(target)) {
      const tracked = params.pidToTrackedSession.get(target.pid);
      if (!tracked || tracked.reportMarkerCustody?.retiring === true) return false;
    }
    return connectedServiceRuntimeRegistry
      .listTargets()
      .some((candidate) => candidate === target);
  };
  const reconciledProjectionByRuntimeTarget = new WeakMap<
    ConnectedServiceRuntimeTarget,
    ConnectedServiceProjectionSnapshot
  >();
  let runtimeTargetReconciliationTail: Promise<void> = Promise.resolve();
  const reconcileDirectCredentialProjectionForTargets = async (
    projectionSnapshot: ConnectedServiceProjectionSnapshot,
    targets: ReadonlyArray<ConnectedServiceRuntimeTarget>,
    executionAuthority: ConnectedServicesProjectionNotification['executionAuthority'],
    signal?: AbortSignal,
    accountContext: RequesterSessionRuntimeContext | null = null,
  ): Promise<void> => {
    const runtimeRegistry = accountContext
      ? accountContext.connectedServiceRuntimeRegistry
      : ownedConnectedServiceRuntimeRegistry;
    await reconcileConnectedServiceDirectCredentialRevisions({
      credentialRevisions: projectionSnapshot.credentialRevisions,
      resolveCredentialPresence: projectionSnapshot.resolveCredentialPresence,
      listRuntimeTargets: () =>
        targets
          .filter((target) => runtimeRegistry?.isSessionTarget(target) === true
            || runtimeRegistry?.isRunTarget(target) === true)
          .map(runtimeGenerationTarget),
      applyLiveCredentialRevision: async (input) => {
        if (accountContext && !(await accountContext.isCurrent()))
          throw new Error('requester_session_not_current');
        await applyConnectedServiceProjectionCredentialUpdate({
          input,
          listRuntimeTargets: () =>
            runtimeRegistry?.listRefreshTargets() ?? [],
          stopSession,
          getRefreshCoordinator: () =>
            accountContext
              ? (accountContext.connectedServiceRefreshCoordinator ?? null)
              : params.getConnectedServiceRefreshCoordinator(),
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
    return await withSessionAccountContext(sessionId, async (accountContext) =>
      await withSessionAccountHome(accountContext, async () => {
        // A fresh/manual generation application already owns this exact runtime transition.
        // Its hot-apply registration emits a registry notification before adoption is cleared;
        // do not start a competing passive consumer that can clear the same runner admission.
        if (
          [...pendingProviderInputAdmissionsByEpochId.values()].some(
            (admission) => admission.target === target,
          )
        ) {
          return;
        }
        const projectionBoundary =
          await continueProviderInputAdmissionReconciliationAfterLifecycleFence({
            isCancelled: () =>
              shutdownCancellationDomains.daemonWorkSignal.aborted ||
              isRuntimePublicationQuiescing(),
            continueReconciliation: async () =>
              accountContext
                ? await fetchConnectedServiceProjectionSnapshot(
                    undefined,
                    sessionId,
                  )
                : requireFreshProjection
                  ? await fetchConnectedServiceProjectionSnapshot()
                  : (latestConnectedServiceProjectionSnapshot ??
                    (await fetchConnectedServiceProjectionSnapshot())),
          });
        if (projectionBoundary.status === 'cancelled') return;
        const projectionSnapshot = projectionBoundary.value;
        if (!isCurrentRuntimeGenerationTarget(target)) return;
        if (
          reconciledProjectionByRuntimeTarget.get(target) === projectionSnapshot
        )
          return;
        let effectiveSessionMetadata = sessionMetadata;
        if (!effectiveSessionMetadata) {
          const [rawSession, accountEncryptionCurrentness] = await Promise.all([
            fetchSessionByIdCompat({ reason: 'session-control',
              token:
                accountContext?.bootstrap.credentials.token ??
                params.credentials.token,
              sessionId,
            }),
            fetchAccountEncryptionCurrentness({
              token:
                accountContext?.bootstrap.credentials.token ??
                params.credentials.token,
            }),
          ]);
          effectiveSessionMetadata = rawSession
            ? (tryDecryptSessionOwnerMetadataView({
                credentials:
                  accountContext?.bootstrap.credentials ?? params.credentials,
                rawSession,
                accountEncryptionMode: accountEncryptionCurrentness.mode,
              }) ?? undefined)
            : undefined;
        }
        if (
          !isCurrentRuntimeGenerationTarget(target) ||
          (!accountContext &&
            latestConnectedServiceProjectionSnapshot !== projectionSnapshot)
        )
          return;
        const providerAdoptedTargets = effectiveSessionMetadata
          ? readConnectedServiceProviderAdoptedAuthGroupGenerationsFromMetadata(
              effectiveSessionMetadata,
            ).map((entry) => entry.providerAdoptedTarget)
          : [];
        await reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
          target: runtimeGenerationTarget(target),
          providerAdoptedTargets,
          consumer: createDurableGenerationConsumer({
            accountContext,
            sessionId,
            allowProviderInputAdmissionWrites: false,
          }),
          listCurrentGroups: async (serviceId) =>
            projectionSnapshot.groups.filter(
              (group) => group.serviceId === serviceId,
            ),
          resolveCredentialRevision: projectionSnapshot.resolveCredentialRevision,
          resolveCredentialPresence: projectionSnapshot.resolveCredentialPresence,
          executionAuthority: 'passive_projection',
        });
        if (reconcileDirectCredentialProjection) {
          await reconcileDirectCredentialProjectionForTargets(
            projectionSnapshot,
            [target],
            'passive_projection',
            undefined,
            accountContext,
          );
        }
        if (
          reconcileDirectCredentialProjection &&
          isCurrentRuntimeGenerationTarget(target) &&
          (accountContext ||
            latestConnectedServiceProjectionSnapshot === projectionSnapshot)
        ) {
          reconciledProjectionByRuntimeTarget.set(target, projectionSnapshot);
        }
      }),
    );
  };
  const scheduleRuntimeTargetGenerationReconciliation = (
    offeredTarget: ConnectedServiceRuntimeTarget,
    sessionMetadata?: Readonly<Record<string, unknown>>,
    requireFreshProjection = false,
    reconcileDirectCredentialProjection = true,
  ): Promise<void> => {
    const scheduled = runtimeTargetReconciliationTail.then(async () => {
      const currentTarget = isCurrentRuntimeGenerationTarget(offeredTarget)
        ? offeredTarget
        : null;
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
  unsubscribeConnectedServiceRuntimeTargetRegistrations =
    connectedServiceRuntimeRegistry.subscribeTargetRegistrations((target) => {
      const tracked = params.pidToTrackedSession.get(target.pid) ?? null;
      if (
        !connectedServiceRuntimeRegistry.isRunTarget(target) &&
        !tracked?.happySessionMetadataFromLocalWebhook
      ) {
        return;
      }
      void scheduleRuntimeTargetGenerationReconciliation(target).catch(
        (error) => {
          logger.debug(
            '[DAEMON RUN] Failed to reconcile connected-service group generation after runtime registration',
            {
              pid: target.pid,
              sessionId: target.sessionId,
              error: serializeAxiosErrorForLog(error),
            },
          );
        },
      );
    });
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
        const lease = await acquireDaemonPluginRuntimeRegistryLease();
        try {
          const registration =
            lease.registry.agentRuntimesByAgentId.get(agentId);
          if (
            !registration ||
            !registration.hasPrimaryRuntime ||
            !registration.sessionRunnerFactoryBinding ||
            registration.isCurrent() !== true
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
        const lease = await acquireDaemonPluginRuntimeRegistryLease();
        try {
          return (
            lease.registry.reserveManagedDependencyRetention?.(
              retainedAgent,
            ) ?? {
              retention: {
                v: 1 as const,
                sourceCustodies: [],
                qualifiedDependencyIds: [],
              },
              release() {},
            }
          );
        } finally {
          await lease.release();
        }
      },
    });
  };
  unsubscribeRunnerAgentAuthorityCurrentness =
    pluginRuntimeController.subscribeRunningSessionDisposition((result) => {
      if (
        result.changedPluginIds.length === 0 ||
        result.runningSessionDisposition !== 'revokeRunningSessions'
      ) {
        return;
      }
      const providerFences = new Set<string>();
      for (const tracked of params.pidToTrackedSession.values()) {
        const sessionId = normalizeOptionalString(tracked.happySessionId);
        const runnerPid = tracked.sessionRunnerPid ?? tracked.pid;
        let authorityRemoval: Promise<boolean> | null = null;
        const denyRunnerAgentAuthority = (): Promise<boolean> => {
          if (authorityRemoval) return authorityRemoval;
          const authorityPath =
            tracked.agentRuntimeDaemonServiceAuthorityFilePath;
          const capabilityDigest =
            tracked.agentRuntimeDaemonServiceCapabilityHash;
          tracked.agentRuntimeRunnerRestartDisposition =
            'runner_authority_unavailable';
          delete tracked.agentRuntimeDaemonServiceCapabilityHash;
          delete tracked.agentRuntimeDaemonServiceNativeRealtimeAdmission;
          delete tracked.agentRuntimeDaemonServiceAdmittedTurnId;
          delete tracked.agentRuntimeDaemonServiceAdmittedInputId;
          delete tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeq;
          delete tracked.agentRuntimeDaemonServiceAdmittedUserMessageSeqs;
          authorityRemoval =
            authorityPath && capabilityDigest
              ? removeAgentRuntimeDaemonServiceAuthorityIfOwned({
                  happyHomeDir: configuration.happyHomeDir,
                  publicReleaseRing: configuration.publicReleaseRing,
                  path: authorityPath,
                  capabilityDigest,
                }).catch(() => false)
              : Promise.resolve(false);
          return authorityRemoval;
        };
        const agentTargeted = (async (): Promise<boolean> => {
          const authorityPath =
            tracked.agentRuntimeDaemonServiceAuthorityFilePath;
          const runnerIdentity = resolveTrackedSessionRunnerIdentity(tracked);
          const processStartTimeMs = runnerIdentity?.processStartTimeMs;
          const processCommandHash = runnerIdentity?.processCommandHash;
          if (
            !sessionId ||
            !authorityPath ||
            !Number.isSafeInteger(runnerPid) ||
            runnerPid < 1 ||
            typeof processStartTimeMs !== 'number' ||
            !Number.isSafeInteger(processStartTimeMs) ||
            processStartTimeMs < 0 ||
            typeof processCommandHash !== 'string'
          ) {
            return false;
          }
          const authority =
            await readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker({
              happyHomeDir: configuration.happyHomeDir,
              publicReleaseRing: configuration.publicReleaseRing,
              path: authorityPath,
              sessionId,
              runner: {
                pid: runnerPid,
                processStartTimeMs,
                processCommandHash,
              },
            });
          if (
            !authority ||
            !tracked.runnerAgentSourceCustodyV1 ||
            !pluginSourceCustodyV1Equal(
              tracked.runnerAgentSourceCustodyV1,
              authority.retainedAgent.sourceCustody,
            ) ||
            !isPluginRunningSessionDispositionTarget(result, {
              pluginId: authority.retainedAgent.pluginId,
              immutableGenerationId:
                authority.retainedAgent.sourceCustody.kind === 'managed'
                  ? authority.retainedAgent.sourceCustody.immutableGenerationId
                  : '',
            })
          ) {
            return false;
          }
          const capturedRunnerIdentity = {
            pid: tracked.pid,
            sessionRunnerPid: tracked.sessionRunnerPid,
            processStartTimeMs: tracked.processStartTimeMs,
            processCommandHash: tracked.processCommandHash,
          };
          const activeTurnId =
            tracked.activeTurnId ??
            tracked.reattachedInterruptedTurnId ??
            tracked.agentRuntimeDaemonServiceAdmittedTurnId ??
            null;
          // Hard disable/trust loss/quarantine is a live revocation:
          // fence tracked admission synchronously with durable
          // publication, then retire the exact document and runner
          // through their existing owners.
          const targetedAuthorityRemoval = denyRunnerAgentAuthority();
          await updateSessionMarkerActiveTurn({
            pid: runnerPid,
            sessionId,
            activeTurnId,
          }).catch(() => false);
          await targetedAuthorityRemoval;
          const currentTracked = params.pidToTrackedSession.get(
            capturedRunnerIdentity.pid,
          );
          if (
            currentTracked !== tracked ||
            tracked.sessionRunnerPid !==
              capturedRunnerIdentity.sessionRunnerPid ||
            tracked.processStartTimeMs !==
              capturedRunnerIdentity.processStartTimeMs ||
            tracked.processCommandHash !==
              capturedRunnerIdentity.processCommandHash ||
            resolveTrackedSessionRunnerIdentity(tracked)?.processStartTimeMs !== processStartTimeMs ||
            resolveTrackedSessionRunnerIdentity(tracked)?.processCommandHash !== processCommandHash
          ) {
            return true;
          }
          await stopSession(sessionId, {
            expectedTrackedRunner: {
              tracked,
              sessionRunnerPid: capturedRunnerIdentity.sessionRunnerPid,
              processStartTimeMs: capturedRunnerIdentity.processStartTimeMs,
              processCommandHash: capturedRunnerIdentity.processCommandHash,
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
          const runnerIdentity = resolveTrackedSessionRunnerIdentity(tracked);
          const persistedMarkerIsExact = Boolean(
            persistedMarker &&
            runnerIdentity &&
            persistedMarker.pid === runnerIdentity.pid &&
            persistedMarker.happySessionId === sessionId &&
            persistedMarker.processCommandHash === runnerIdentity.processCommandHash &&
            persistedMarker.processStartTimeMs === runnerIdentity.processStartTimeMs,
          );
          const persistedManagedProviderAuthority = persistedMarkerIsExact
            ? (persistedMarker?.runnerManagedDependencyRetentionV1
                ?.adoptedManagedProviderAuthority ?? null)
            : null;
          // The marker is the sole live P authority writer. The
          // tracked projection may retain only an exact cleanup
          // identity after policy fencing so a later hard
          // revocation remains idempotent; it never authorizes
          // Provider effects.
          const managedProviderAuthority =
            persistedManagedProviderAuthority ??
            tracked.runnerManagedDependencyRetentionV1
              ?.adoptedManagedProviderAuthority ??
            null;
          const providerTargeted = Boolean(
            sessionId &&
            managedProviderAuthority &&
            isPluginRunningSessionDispositionTarget(result, {
              pluginId: managedProviderAuthority.pluginId,
              immutableGenerationId:
                managedProviderAuthority.sourceCustody.kind === 'managed'
                  ? managedProviderAuthority.sourceCustody.immutableGenerationId
                  : '',
            }),
          );
          if (!providerTargeted || !sessionId || !managedProviderAuthority) {
            return;
          }

          const fenceKey = `${sessionId}\0${managedProviderAuthority.pluginId}${
            result.runningSessionRevocationScope
              ? `\0${result.runningSessionRevocationScope.immutableGenerationId}`
              : ''
          }`;
          if (providerFences.has(fenceKey)) return;
          providerFences.add(fenceKey);
          const capturedProviderRunnerIdentity = {
            pid: tracked.pid,
            sessionRunnerPid: tracked.sessionRunnerPid,
            processStartTimeMs: tracked.processStartTimeMs,
            processCommandHash: tracked.processCommandHash,
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
                pluginId: managedProviderAuthority.pluginId,
                sourceCustody: managedProviderAuthority.sourceCustody,
              });
              if (fenced.kind !== 'hardRevocationFenced') {
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
              const currentTracked = params.pidToTrackedSession.get(
                capturedProviderRunnerIdentity.pid,
              );
              if (
                currentTracked !== tracked ||
                normalizeOptionalString(tracked.happySessionId) !== sessionId ||
                tracked.sessionRunnerPid !==
                  capturedProviderRunnerIdentity.sessionRunnerPid ||
                tracked.processStartTimeMs !==
                  capturedProviderRunnerIdentity.processStartTimeMs ||
                tracked.processCommandHash !==
                  capturedProviderRunnerIdentity.processCommandHash
              ) {
                return;
              }
              await stopSessionCore(sessionId, {
                expectedTrackedRunner: {
                  tracked,
                  sessionRunnerPid:
                    capturedProviderRunnerIdentity.sessionRunnerPid,
                  processStartTimeMs:
                    capturedProviderRunnerIdentity.processStartTimeMs,
                  processCommandHash:
                    capturedProviderRunnerIdentity.processCommandHash,
                },
                beforeSignalExactTrackedRunner: () => {
                  sessionRunnerRespawnManager.markStopRequested(sessionId, {
                    reason: 'daemon_stop_session',
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
    observeProcessStartIdentity: observeManagedServiceProcessStartIdentity,
  });
  managedServiceEndpointReadOwner = createDaemonManagedServiceEndpointReadOwner(
    {
      credentials: params.credentials,
      resolveProjection: async (query) =>
        await managedServiceDurabilityOwner!.resolveEndpointProjection(query),
    },
  );
  params.onManagedServiceEndpointReadHostReady?.(
    managedServiceEndpointReadOwner.bindHost,
  );
  params.onManagedServiceSessionClientAccessResolverReady?.(
    managedServiceEndpointReadOwner.resolveSessionClientAccess,
  );
  params.onManagedServiceSessionBaseUrlResolverReady?.(async (input) => {
    const projection =
      await managedServiceDurabilityOwner!.resolveEndpointProjection({
        pluginId: input.pluginId,
        sessionId: input.sessionId,
        contributionId: input.contributionId,
        selector: { kind: 'currentSessionManagedSpawn' },
      });
    return projection?.endpoint.baseUrl ?? null;
  });
  const resolveTrackedRunnerRuntimeCurrentness = async (
    tracked: TrackedSession | null | undefined,
  ) =>
    await resolveAuthoritativeTrackedRunnerAgentRuntimeCurrentness(tracked, {
      machineId: params.machineId,
      accountSnapshot: getActiveAccountSettingsSnapshot(),
    });
  const refreshTrackedSessionRuntimeSnapshotForPlannedRestart = async (
    input: Readonly<{
      sessionId: string;
      tracked: TrackedSession;
    }>,
  ): Promise<void> => {
    if (input.tracked.reattachedInterruptedTurnId && !input.tracked.activeTurnId) {
      await applyTrackedSessionTurnLifecycle({
        trackedSessions: params.pidToTrackedSession.values(),
        sessionId: input.sessionId,
        event: 'reconcile_reattached',
        readReattachedTurnSnapshot: async sessionId => {
          if (params.pidToTrackedSession.get(input.tracked.pid) !== input.tracked) return null;
          const attribution = input.tracked.requesterWorkAttributionV1 ?? input.tracked.spawnOptions?.requesterWorkAttributionV1;
          return await withSessionAccountContext(sessionId, async (accountContext) => {
            const snapshot = await withSessionAccountHome(accountContext, () => fetchSessionByIdCompat({ reason: 'session-control',
              token: accountContext?.bootstrap.credentials.token ?? params.credentials.token, sessionId,
            }));
            await assertSessionAccountCurrent(sessionId, accountContext, attribution);
            return params.pidToTrackedSession.get(input.tracked.pid) === input.tracked ? snapshot : null;
          }, attribution);
        },
      });
    }
    if (!input.tracked.spawnOptions) return;
    try {
      await refreshTrackedSessionsRuntimeSnapshot({
        sessionId: input.sessionId,
        incomingOptions: input.tracked.spawnOptions,
        trackedSessions: [input.tracked],
        readPersistedSessionMetadata:
          readPersistedConnectedServiceSwitchSessionMetadata,
      });
    } catch (error) {
      logger.warn(
        '[DAEMON RUN] Failed to refresh session runtime snapshot before planned restart',
        { sessionId: input.sessionId, error },
      );
    }
  };
  const resolveSessionRunnerStatusState = async (
    input: Readonly<{
      sessionId: string;
      observedAtMs?: number;
    }>,
  ) => {
    const tracked = findTrackedSessionByHappySessionId(
      params.pidToTrackedSession.values(),
      input.sessionId,
    );
    if (tracked?.reattachedInterruptedTurnId || shouldRefreshSessionRunnerResumeIdentity(tracked)) {
      await refreshTrackedSessionRuntimeSnapshotForPlannedRestart({
        sessionId: input.sessionId,
        tracked,
      });
    }
    const agentRuntimeCurrentness =
      await resolveTrackedRunnerRuntimeCurrentness(tracked);
    const state = resolveSessionRunnerRuntimeState({
      sessionId: input.sessionId,
      tracked,
      currentIdentity: resolveCurrentSessionRunnerLaunchIdentity(),
      agentRuntimeVersionState: agentRuntimeCurrentness.versionState,
      agentRuntimeRestartUnavailableReason:
        agentRuntimeCurrentness.restartUnavailableReason,
      resolveActivityDisabledReason: resolveSessionRunnerActivityDisabledReason,
      machineId: params.machineId,
      observedAtMs: input.observedAtMs ?? Date.now(),
    });
    return { state, tracked };
  };
  const resolveSessionRunnerStatus = async (
    input: Readonly<{
      sessionId: string;
      observedAtMs?: number;
    }>,
  ) => (await resolveSessionRunnerStatusState(input)).state;
  const resolveSessionRunnerStatusV2 = async (
    input: Readonly<{
      sessionId: string;
      observedAtMs?: number;
    }>,
  ) => {
    const { state, tracked } = await resolveSessionRunnerStatusState(input);
    return await resolveSessionRunnerRuntimeStatusV2({ state, tracked });
  };
  const onSessionStartupFailure = createOnDaemonSessionStartupFailure({
    pidToTrackedSession: params.pidToTrackedSession,
    pidToAwaiter: params.pidToAwaiter,
  });
  const externalActionAccountId = params.externalActionAccountId?.trim() ?? '';
  const externalActionInstallationIdentity = externalActionAccountId
    ? readInstallationIdentityIfExistsSync()
    : null;
  const pluginActionCurrentIntent = createCredentialedTargetActionCurrentIntent(
    params.credentials,
  );
  const externalActionTranscriptFollowLeaseRegistry = externalActionAccountId
    ? createSessionTranscriptFollowLeaseRegistry({
        // The registry is daemon-lifetime so retained follow leases are
        // not lost between finite HTTP requests.
        idleTtlMs: DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
      })
    : null;
  const externalActionContributedInvoker = externalActionAccountId
    ? createDaemonExternalActionContributedInvoker({
        observePluginExecution: request => observeContributedPluginExecution(request),
        requestCurrentIntent: pluginActionCurrentIntent,
      })
    : null;
  const externalActionContributedDefinitionLister = externalActionAccountId
    ? createDaemonExternalActionContributedDefinitionLister()
    : null;
  const externalActionTargetResolver = externalActionAccountId
    ? createDaemonExternalActionTargetResolver({
        credentials: params.credentials,
        serverApiUrl: params.serverBaseUrl,
        ...(params.resolveServerFeaturesSnapshot
          ? {
              resolveServerFeaturesSnapshot:
                params.resolveServerFeaturesSnapshot,
            }
          : {}),
        ...(params.currentMachineHost
          ? { currentMachineHost: params.currentMachineHost }
          : {}),
        ...(params.currentMachineHomeDir
          ? { currentMachineHomeDir: params.currentMachineHomeDir }
          : {}),
      })
    : null;
  const isSessionCallerCurrent: NonNullable<
    Parameters<
      typeof createDaemonApprovalExecutionOriginCurrentnessFromCredentials
    >[0]['isSessionCallerCurrent']
  > = async ({ caller, signal }) => {
    if (signal?.aborted) return false;
    const tracked = Array.from(params.pidToTrackedSession.values()).find(
      (candidate) => candidate.happySessionId === caller.sessionId,
    );
    if (tracked) {
      const authority = await resolveTrackedAgentRuntimeDaemonServiceAuthority(
        tracked,
        caller.sessionId,
      );
      return (
        !signal?.aborted &&
        authority !== null &&
        Array.from(params.pidToTrackedSession.values()).includes(tracked)
      );
    }
    return foregroundAgentRuntimeAdmission.isSessionCurrent(caller.sessionId);
  };
  const externalActionApprovalExecutionOriginCurrentness =
    createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
      credentials: params.credentials,
      machineId: params.machineId,
      serverId: params.serverId,
      serverApiUrl: params.serverBaseUrl,
      ...(params.resolveCurrentMachineExecutionOriginContext
        ? { resolveCurrentMachineExecutionOriginContext: params.resolveCurrentMachineExecutionOriginContext }
        : {}),
      currentMachineHost: params.currentMachineHost,
      currentMachineHomeDir: params.currentMachineHomeDir,
      isSessionCallerCurrent,
      ...(params.workflowAcceptedAuthorizationCurrentness
        ? { isWorkflowRunAuthorizationCurrent: params.workflowAcceptedAuthorizationCurrentness }
        : {}),
      ...(params.resolveServerFeaturesSnapshot
        ? {
            resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot,
          }
        : {}),
    });
  const externalActionContributedApprovalReplay =
    externalActionAccountId && externalActionApprovalExecutionOriginCurrentness
      ? createDaemonExternalActionContributedApprovalReplay({
          credentials: params.credentials,
          isApprovalExecutionOriginCurrent:
            externalActionApprovalExecutionOriginCurrentness,
        })
      : null;
  const requiresPortableSessionSpawnServerIdentity = (
    actionId: string,
    input: unknown,
  ): boolean => {
    if (
      actionId === 'session.spawn_new' ||
      actionId === 'approval.request.decide'
    ) {
      return true;
    }
    if (
      actionId !== 'approval.request.create' ||
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input)
    ) {
      return false;
    }
    return (
      (input as Readonly<Record<string, unknown>>).actionId ===
      'session.spawn_new'
    );
  };
  const requesterAccountOperationContext = (
    apiMachine: ApiMachineClient,
    requester: RequesterAccountActionContext,
    role: 'use' | 'manage',
    signal?: AbortSignal,
  ): ActionOperationRpcContext => {
    if (!externalActionInstallationIdentity || !externalActionAccountId) {
      throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
    }
    // Custody was opened for this installation and remains Home-verified by
    // the admitted owner. Resource mode belongs to the installed controller,
    // not to the requester's Account encryption material.
    const ownCustodian = isOriginalOwnAccountActionCustody(requester.authorization.binding)
      && requester.authorization.binding.custodianAccountId === externalActionAccountId;
    return {
      machineAdmission: {
        actorAccountId: requester.authorization.binding.accountId,
        custodianAccountId: externalActionAccountId,
        machineId: params.machineId,
        installationId: externalActionInstallationIdentity.installationId,
        role: requester.authorization.binding.admittedMachineRole ?? (ownCustodian ? 'manage' : role),
        encryptionMode: apiMachine.getMachineEncryptionMode(),
      },
      verifyMachineAdmissionCurrent: requester.isCurrent,
      ...(signal ? { signal } : {}),
    };
  };
  const observeContributedPluginExecution = (request: Parameters<ApiMachineClient['observePluginActionExecution']>[0]) => {
    const client = params.getApiMachineForSessions();
    if (!client) return Promise.resolve({ ok: false as const, errorCode: 'action_operation_unavailable', error: 'action_operation_unavailable' });
    const requester = readRequesterAccountActionContext(request.rpcContext?.externalActionExecutionAuthorization);
    return client.observePluginActionExecution(requester ? { ...request, rpcContext: {
      ...request.rpcContext,
      ...requesterAccountOperationContext(client, requester, 'use', request.rpcContext?.signal),
    } } : request);
  };
  const relayDiscussionAgentPublication = async (
    credentials: typeof params.credentials, serverHttpBaseUrl: string,
    publication: DiscussionAgentPublisherPrivateRequestV1, signal?: AbortSignal,
  ) => await runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
    const sessionId = publication.request.sessionId;
    const transport = await resolveSessionTransportContext({ reason: 'session-control', credentials, idOrPrefix: sessionId,
      ...(signal ? { signal } : {}) });
    if (!transport.ok || transport.sessionId !== sessionId)
      return { v: 1 as const, ok: false as const, error: 'discussion_post_denied' as const };
    const rpc = { token: credentials.token, sessionId,
      method: `${sessionId}:${SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1}`,
      request: publication, timeoutMs: null, ...(signal ? { signal } : {}) };
    return DiscussionAgentPublisherResponseV1Schema.parse(transport.mode === 'plain'
      ? await callSessionRpc({ ...rpc, mode: 'plain' }) : await callSessionRpc({ ...rpc, mode: 'e2ee', ctx: transport.ctx }));
  });
  const subscribeManagedMachineChanges: ApiMachineClient['onManagedMachinePolicyInvalidated'] = listener => {
    const apiMachine = params.getApiMachineForSessions();
    if (!apiMachine) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
    return apiMachine.onManagedMachinePolicyInvalidated(listener);
  };
  const managedMachinePolicyAdapter = createDaemonManagedMachineActionAdapter({
    credentials: params.credentials,
    machineId: params.machineId,
    serverBaseUrl: params.serverBaseUrl,
    serverId: params.serverId,
    prepareRequesterAccountContext: request => externalActionIngressOwner?.prepareRequesterAccountContext?.(request) ?? Promise.resolve(null),
    resolveCurrentMachineExecutionOriginContext:
      params.resolveCurrentMachineExecutionOriginContext,
    installationIdentity: externalActionInstallationIdentity,
    managedProviderOperationAuthority: params.managedProviderOperationAuthority,
    subscribeManagedMachineChanges,
    ...(params.readManagedMachinePolicyCurrent
      ? { readPolicyCurrent: params.readManagedMachinePolicyCurrent }
      : {}),
    acquireRuntimeRegistryLease: acquireDaemonPluginRuntimeRegistryLease,
    executeManagedPolicyAction: (machine, context, runApproved) => executeManagedMachinePolicyAction({
      machine, context, runApproved, serverId: params.serverId,
      createExecutor: overrides => createExternalActionExecutor(params.credentials, undefined, undefined, undefined, undefined, overrides),
    }),
    observeActionExecution: async (request) => {
      const currentApiMachine = params.getApiMachineForSessions();
      if (!currentApiMachine) {
        throw Object.assign(new Error('target_unavailable'), {
          code: 'target_unavailable',
        });
      }
      return await currentApiMachine.observeActionExecution(request);
    },
  });
  const externalActionIngressExecutor: ExternalActionIngressOwner['executor'] = {
    execute: (...args) =>
      createExternalActionExecutor(params.credentials).execute(...args),
    replayApprovedApprovalRequest: (...args) =>
      createExternalActionExecutor(params.credentials).replayApprovedApprovalRequest(...args),
    continueConfidentialApprovalRequest: (...args) =>
      createExternalActionExecutor(params.credentials).continueConfidentialApprovalRequest(...args),
  };
  const externalActionIngressOwner: ExternalActionIngressOwner | undefined =
    externalActionAccountId &&
    externalActionTranscriptFollowLeaseRegistry &&
    externalActionContributedInvoker &&
    externalActionContributedApprovalReplay &&
    externalActionContributedDefinitionLister &&
    externalActionTargetResolver &&
    externalActionApprovalExecutionOriginCurrentness
      ? {
          currentServerId: params.serverId,
          currentServerHttpBaseUrl: params.serverBaseUrl,
          acquirePluginRuntimeRegistryLease: acquireDaemonPluginRuntimeRegistryLease,
          resolvePluginExecutionOriginContext: () => params.resolveCurrentMachineExecutionOriginContext?.() ?? null,
          resolveAccountPluginExecutionSelection: async (pluginId, registry, signal) =>
            await params.getApiMachineForSessions()?.resolveAccountPluginExecutionSelection(pluginId, registry, signal)
              ?? { kind: 'unavailable', code: 'plugin_account_execution_unavailable' },
          prepareRequesterAccountContext: async ({ authorization, purpose, signal, verifyWorkspaceSyncPrepareCurrent, verifyServiceMoveChildCurrent, deploymentChildExecution }) => {
            const privatePurpose = purpose ?? { kind: 'external_action' as const };
            let executeManagedFiniteWake: ((request: ManagedMachinePolicyRequest) => Promise<ActionExecuteResult>) | undefined;
            let requesterTargetResolver: ReturnType<typeof createDaemonExternalActionTargetResolver> | undefined;
            const prepared = await prepareInstalledRequesterAccountActionContext({ authorization, purpose: privatePurpose,
              ...(verifyWorkspaceSyncPrepareCurrent ? { verifyWorkspaceSyncPrepareCurrent } : {}),
              ...(verifyServiceMoveChildCurrent ? { verifyServiceMoveChildCurrent } : {}),
              ...(deploymentChildExecution ? { deploymentChildExecution } : {}),
              machineId: params.machineId,
              serverId: params.serverId, serverHttpBaseUrl: params.serverBaseUrl,
              ownCredentials: params.credentials,
              resolveRequesterSessionBootstrap: async (sessionId, attribution) => {
                const runtime = await params.resolveRequesterSessionRuntimeContext?.(sessionId, attribution);
                return runtime ? { ...runtime.bootstrap, isCurrent: () => runtime.isCurrent(signal),
                  release: () => releaseSessionAccountContext(runtime) } : null;
              },
              resolveCurrentMachineExecutionOriginContext: signal => params.resolveCurrentMachineExecutionOriginContext?.(signal)
                ?? Promise.resolve(null),
              createExecutor: (admitted, installation) => {
                requesterTargetResolver = createDaemonExternalActionTargetResolver({
                  credentials: admitted.credentials, serverApiUrl: admitted.serverHttpBaseUrl,
                  ...(params.resolveServerFeaturesSnapshot ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot } : {}),
                  ...(params.currentMachineHost ? { currentMachineHost: params.currentMachineHost } : {}),
                  ...(params.currentMachineHomeDir ? { currentMachineHomeDir: params.currentMachineHomeDir } : {}),
                });
                if (privatePurpose.kind === 'managed_finite_wake') {
                  const target = privatePurpose.target;
                  const native = createDaemonManagedMachineActionAdapter({ credentials: admitted.credentials,
                    controllerCredentials: params.credentials,
                    subscribeManagedMachineChanges,
                    machineId: params.machineId, serverBaseUrl: admitted.serverHttpBaseUrl, serverId: params.serverId,
                    resolveCurrentMachineExecutionOriginContext: params.resolveCurrentMachineExecutionOriginContext,
                    installationIdentity: installation,
                    managedProviderOperationAuthority: params.managedProviderOperationAuthority,
                    ...(params.readManagedMachinePolicyCurrent ? { readPolicyCurrent: params.readManagedMachinePolicyCurrent } : {}),
                    acquireRuntimeRegistryLease: acquireDaemonPluginRuntimeRegistryLease,
                    observeActionExecution: async request => {
                      const apiMachine = params.getApiMachineForSessions();
                      if (!apiMachine) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
                      return await apiMachine.observeActionExecution({ ...request,
                        rpcContext: requesterAccountOperationContext(apiMachine, admitted, 'manage', signal),
                      });
                    },
                    executeManagedPolicyAction: (machine, context, runApproved) => executeManagedMachinePolicyAction({
                      machine, context, runApproved, serverId: params.serverId,
                      createExecutor: overrides => createExternalActionExecutor(admitted.credentials,
                        undefined, undefined, undefined, undefined, overrides, admitted),
                    }),
                  });
                  executeManagedFiniteWake = async request => {
                    const refused = { ok: false as const, errorCode: 'requester_account_context_unavailable', error: 'requester_account_context_unavailable' };
                    const origin = request.actionOrigin;
                    if (request.signal?.aborted || request.purpose.kind !== 'accepted-input-start'
                      || !sameStrictJsonValue(request.purpose.target, target)
                      || !origin || origin.token !== admitted.authorization.token
                      || !sameStrictJsonValue(origin.binding, admitted.authorization.binding)
                      || request.machine.id !== target.managedId || request.machine.homeId !== target.homeId
                      || request.machine.enrolledMachineId !== target.enrolledMachineId
                      || request.machine.intentRevision !== target.expectedIntentRevision
                      || !sameStrictJsonValue(request.machine.controller, target.controller)
                      || !await admitted.isCurrent()) return refused;
                    const release = admitted.retain();
                    try {
                      return await runWithServerHttpBaseUrl(admitted.serverHttpBaseUrl,
                        () => native.executePolicy({ ...request, actionOrigin: admitted.authorization }));
                    } finally { await release(); }
                  };
                }
                return createExternalActionExecutor(admitted.credentials,
                  undefined, undefined, undefined, undefined, undefined, admitted,
                  privatePurpose.kind === 'machine_rpc' && privatePurpose.method === RPC_METHODS.STOP_SESSION
                    ? async ({ sessionId, context }) => {
                        // This receiver already re-entered the requester's complete Action policy.
                        // Spend only its admitted operand at the incumbent Stop owner; self-RPC
                        // would re-enter requester policy again instead of reaching the process.
                        if (!privatePurpose.params || typeof privatePurpose.params !== 'object'
                          || Reflect.get(privatePurpose.params, 'sessionId') !== sessionId
                          || context?.signal?.aborted || !await admitted.isCurrent()) {
                          const errorCode = context?.signal?.aborted ? 'cancelled' : 'target_unavailable';
                          return { ok: false, errorCode, error: errorCode };
                        }
                        return await runWithServerHttpBaseUrl(admitted.serverHttpBaseUrl, async () => {
                          const resolveAuthorizationHeaders = (request: Parameters<NonNullable<Parameters<typeof updateSessionMetadataWithRetry>[0]['resolveAuthorizationHeaders']>>[0]) => {
                              const signed = resolveExternalActionServerRequestHeaders({ context,
                                effectActionId: admitted.authorization.binding.actionId,
                                ...request, daemonToken: admitted.credentials.token,
                                serverIdentityId: admitted.authorization.binding.serverIdentityId,
                                privateKey: installation.privateKey, installationId: installation.installationId,
                              });
                              if (!signed.ok) throw new Error('Native Stop requester authorization unavailable');
                              return signed.headers;
                          };
                          return await stopSession(sessionId, { metadataContext: { credentials: admitted.credentials,
                            resolveAuthorizationHeaders, currentness: { verifyCurrent: () => admitted.isCurrent(),
                              ...(context?.signal ? { signal: context.signal } : {}) } } }, undefined, async () => {
                            const rawSession = await fetchSessionByIdCompat({ reason: 'session-control', token: admitted.credentials.token,
                              sessionId, resolveAuthorizationHeaders, ...(context?.signal ? { signal: context.signal } : {}) });
                            if (!rawSession || rawSession.id !== sessionId || !await admitted.isCurrent()) {
                              throw new Error('Native Stop exact Session authority unavailable');
                            }
                            const accountEncryptionCurrentness = await fetchAccountEncryptionCurrentness({
                              token: admitted.credentials.token,
                              authorizationHeaders: resolveAuthorizationHeaders({ method: 'GET', path: '/v1/account/encryption/currentness' }),
                            });
                            const owner = resolveSessionOwningMachineId({ credentials: admitted.credentials, rawSession,
                              accountEncryptionMode: accountEncryptionCurrentness.mode });
                            if (!owner.ok || owner.machineId !== params.machineId) throw new Error('Native Stop target changed');
                            if (admitted.authorization.binding.actionId === 'session.stop') {
                              const metadata = tryReadSessionMetadataRecord({ rawSession, credentials: admitted.credentials,
                                accountEncryptionMode: accountEncryptionCurrentness.mode });
                              const stop = readSessionExplicitStopV1FromMetadata(metadata);
                              // The source already owns this durable intent. A delayed RPC
                              // cannot recreate it or kill a runner resumed after it cleared.
                              if (!stop || 'status' in stop || stop.requestId !== admitted.authorization.binding.requestId) {
                                return false;
                              }
                            }
                            if (context?.signal?.aborted || !await admitted.isCurrent()) throw new Error('Native Stop requester retired');
                            return undefined;
                          }, admitted.credentials);
                        });
                      } : undefined);
              },
              ...(signal ? { signal } : {}) });
            return prepared ? { ...prepared, ...(requesterTargetResolver ? { resolveTarget: requesterTargetResolver } : {}),
              ...(executeManagedFiniteWake ? { executeManagedFiniteWake } : {}) } : null;
          },
          resolveEncryption: async (signal) => {
            const credentialMaterial = params.credentials.encryption;
            if (!credentialMaterial) return null;
            const material =
              credentialMaterial.type === 'legacy'
                ? credentialMaterial.secret.length === 32
                  ? {
                      type: 'dataKey' as const,
                      machineKey: deriveAccountMachineKeyFromRecoverySecret(
                        credentialMaterial.secret,
                      ),
                    }
                  : null
                : credentialMaterial.machineKey.length === 32
                  ? credentialMaterial
                  : null;
            if (!material) return null;
            const origin =
              await params.resolveCurrentMachineExecutionOriginContext?.(
                signal,
              );
            if (!origin || origin.machineId !== params.machineId) return null;
            return { serverIdentityId: origin.serverIdentityId, material };
          },
          resolveTarget: externalActionTargetResolver,
          // The ingress owner is published before Machine sync attaches. Build
          // its credentialed executor at the request boundary so every native
          // adapter belongs to the current Machine lifecycle.
          executor: externalActionIngressExecutor,
          ...(externalActionInstallationIdentity
            ? {
                externalActionMachineRequestPrivateKey:
                  externalActionInstallationIdentity.privateKey,
              }
            : {}),
        }
      : undefined;
  const createExternalActionExecutor = createDaemonExternalActionExecution({
    params, requiresPortableSessionSpawnServerIdentity, requesterAccountOperationContext, acquireDaemonPluginRuntimeRegistryLease, shutdownCancellationDomains, isSessionCallerCurrent, externalActionApprovalExecutionOriginCurrentness, externalActionIngressOwner, externalActionContributedApprovalReplay, observeContributedPluginExecution, relayDiscussionAgentPublication, externalActionInstallationIdentity, ownerRemainder, isRuntimePublicationQuiescing, pluginRuntimeController, connectedAccountRequestAuthRegistry, requireConnectedAccountRequestAuthHttpPort, localServicesActionFeatureGate, localServicesRuntimeActionRoutes, localServicesRuntime, externalActionContributedInvoker, externalActionContributedDefinitionLister, externalActionTranscriptFollowLeaseRegistry,
  });
  const createSessionAccountActionAuthorizationPreparer = (
    credentials: StoredCredentials,
    requesterRuntime: RequesterSessionRuntimeContext | null,
    serverHttpBaseUrl: string,
  ): NonNullable<Parameters<typeof createDaemonSessionAccountActionExecutor>[0]['prepareExternalActionAuthorization']> =>
    async ({ operation, authority, isCallerCurrent, sessionActionOrigin, targetMachineId, workflowTarget }) => {
      // Private/client-only Actions retain their existing Session channel;
      // Home-bound public effects use only the incumbent signed carrier.
      if (
        !ExternalActionActionIdV1Schema.safeParse(operation.actionId)
          .success
      )
        return undefined;
      const installation = readInstallationIdentityIfExistsSync();
      const origin =
        await params.resolveCurrentMachineExecutionOriginContext?.(
          authority.signal,
        );
      if (
        !installation ||
        !origin ||
        origin.machineId !== params.machineId
      )
        return null;
      // These reads prepare one authorization input. The Home mint below and
      // final publication retain their independent, fresh isCurrent fences.
      const prepared = await runWithRequesterSessionCurrentnessCheckpoint(async () => {
        if (!await isCallerCurrent()) return null;
        const [profile, encryption] = await runWithServerHttpBaseUrl(
          serverHttpBaseUrl,
          () => Promise.all([
            fetchAccountProfile({
              token: credentials.token,
              ...(authority.signal ? { signal: authority.signal } : {}),
            }),
            fetchAccountEncryptionCurrentness({
              token: credentials.token,
              serverBaseUrl: serverHttpBaseUrl,
              ...(authority.signal ? { signal: authority.signal } : {}),
            }),
          ]),
        );
        if ((requesterRuntime && profile.id !== requesterRuntime.bootstrap.attribution.accountId)
          || !await isCallerCurrent()) return null;
        return { profile, encryption };
      });
      if (!prepared) return null;
      const { profile, encryption } = prepared;
      const payload = decodeJwtPayload(credentials.token);
      const extras = payload?.extras;
      const hint =
        payload?.tokenEpoch ??
        (extras && typeof extras === 'object' && 'tokenEpoch' in extras
          ? extras.tokenEpoch
          : undefined);
      // A missing legacy epoch may propose zero as associated data only.
      // The authenticated Home mint, not this unverified hint, decides it.
      const tokenEpochHint = hint === undefined ? 0 : hint;
      if (
        typeof tokenEpochHint !== 'number' ||
        !Number.isSafeInteger(tokenEpochHint) ||
        tokenEpochHint < 0
      )
        return null;
      const material =
        credentials.encryption?.type === 'legacy'
          ? {
              type: 'dataKey' as const,
              machineKey: deriveAccountMachineKeyFromRecoverySecret(
                credentials.encryption.secret,
              ),
            }
          : credentials.encryption;
      let selectedMachineId = operation.actionId === 'session.board.item.upsert'
        ? params.machineId : targetMachineId ?? params.machineId;
      if (resolveActionExecutionPlacementForInput(getActionSpec(operation.actionId), operation.input) === 'machine') {
        let ownerMachineId: string | undefined;
        if ((MANAGED_MACHINE_ACTION_IDS_V1 as readonly string[]).includes(operation.actionId)) {
          const parsed = getActionSpec(operation.actionId).inputSchema.safeParse(operation.input);
          if (!parsed.success) return null;
          const managedInput: unknown = parsed.data;
          if (managedInput && typeof managedInput === 'object' && 'homeId' in managedInput && managedInput.homeId !== origin.serverIdentityId) return null;
          if (managedInput && typeof managedInput === 'object') {
            const managedId = 'managedId' in managedInput ? managedInput.managedId
              : 'managedMachineId' in managedInput ? managedInput.managedMachineId : undefined;
            if (typeof managedId === 'string') {
              const machine = await readManagedMachine({ credentials, serverHttpBaseUrl,
                homeId: origin.serverIdentityId, managedId, ...(authority.signal ? { signal: authority.signal } : {}) });
              if (machine.id !== managedId || machine.homeId !== origin.serverIdentityId) return null;
              ownerMachineId = machine.controller.machineId;
            }
          }
        }
        const selected = resolveExternalActionMachineTarget({ actionId: operation.actionId, rawInput: operation.input,
          ...(targetMachineId ? { target: { kind: 'machine', machineId: targetMachineId } } : {}),
          fallbackMachineId: params.machineId, ...(ownerMachineId ? { ownerMachineId } : {}) });
        if (selected.kind !== 'ready') return null;
        selectedMachineId = selected.machineId;
      }
      if (workflowTarget && workflowTarget.machineId !== selectedMachineId) return null;
      const target: ExternalActionTargetV1 = operation.actionId === 'session.board.item.upsert'
        ? { kind: 'session', sessionId: sessionActionOrigin.caller.sessionId }
        : workflowTarget ?? { kind: 'machine', machineId: selectedMachineId };
      const isCurrent = async () => {
        const current = readInstallationIdentityIfExistsSync();
        return (
          current?.installationId === installation.installationId &&
          current.publicKey === installation.publicKey &&
          (await isCallerCurrent())
        );
      };
      const managedContinuation = operation.actionId === 'machines.managed.acquire'
        || operation.actionId === 'machines.managed.bootstrap.retry';
      const accountSettings = managedContinuation
        ? requesterRuntime?.readAccountSettingsSnapshot().settings
          ?? await resolveAvailableAccountSettings({ credentials })
        : null;
      const acceptedCurrentness = managedContinuation
        ? createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
            credentials,
            machineId: params.machineId,
            serverId: params.serverId,
            serverApiUrl: serverHttpBaseUrl,
            isSessionCallerCurrent,
            ...(params.resolveServerFeaturesSnapshot
              ? { resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot }
              : {}),
          })
        : undefined;
      if (managedContinuation && (!accountSettings || !acceptedCurrentness)) return null;
      let authorization =
        await prepareExternalActionRequesterAccountAuthorization({
          actionId: operation.actionId,
          input: operation.input,
          requestId: operation.requestId,
          target,
          machineId: selectedMachineId,
          sourceMachineId: params.machineId,
          accountId: profile.id,
          accountEncryptionMode: encryption.mode,
          tokenEpochHint,
          token: credentials.token,
          ...(material ? { material } : {}),
          serverId: params.serverId,
          serverIdentityId: origin.serverIdentityId,
          serverHttpBaseUrl,
          installationId: installation.installationId,
          privateKey: installation.privateKey,
          sessionActionOrigin,
          isCurrent,
          ...(managedContinuation && accountSettings && acceptedCurrentness ? {
            isContinuationCurrent: async (acceptedAuthorization: ExternalActionExecutionAuthorizationV1) => {
              const currentInstallation = readInstallationIdentityIfExistsSync();
              if (authority.signal?.aborted
                || currentInstallation?.installationId !== installation.installationId
                || currentInstallation.publicKey !== installation.publicKey
                || requesterRuntime && !await requesterRuntime.isCurrent()) return false;
              const acceptedOrigin = buildApprovalExecutionOriginV1({
                actionId: operation.actionId,
                input: operation.input,
                targetSessionId: null,
                context: {
                  surface: operation.surface ?? 'agent', authority: 'account_automation',
                  serverId: params.serverId, serverIdentityId: origin.serverIdentityId,
                  runtimeAccountId: profile.id, actionRequestId: operation.requestId,
                  actionCaller: sessionActionOrigin.caller,
                  defaultSessionId: sessionActionOrigin.caller.sessionId,
                  callerPermissionMode: sessionActionOrigin.callerPermissionMode,
                  causalPermissionAuthority: sessionActionOrigin.causalPermissionAuthority,
                  ...(sessionActionOrigin.workspaceWrites
                    ? { workspaceWrites: sessionActionOrigin.workspaceWrites } : {}),
                  sessionInputSource: { sourceSessionId: sessionActionOrigin.caller.sessionId,
                    sourceTurnId: sessionActionOrigin.sourceTurnId,
                    ...(sessionActionOrigin.sourceInputId ? { sourceInputId: sessionActionOrigin.sourceInputId } : {}),
                    via: 'action' },
                  sessionAgentSpawnPolicyV1: accountSettings.sessionAgentSpawnPolicyV1,
                  externalActionExecutionAuthorization: acceptedAuthorization,
                  externalActionTarget: target,
                  signExternalActionApprovalInput: ({ actionId, input: actionInput, target: actionTarget, requesterConfirmation, sessionTargetsV1 }) =>
                    signExternalActionApprovalInputV1({ authorizationToken: acceptedAuthorization.token,
                      actionId, input: actionInput, target: actionTarget, privateKey: installation.privateKey,
                      ...(requesterConfirmation ? { requesterConfirmation } : {}),
                      ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}) }),
                },
              });
              return acceptedOrigin !== null && await acceptedCurrentness({
                origin: acceptedOrigin, actionInput: operation.input,
                ...(authority.signal ? { signal: authority.signal } : {}),
              });
            },
          } : {}),
          ...(authority.signal ? { signal: authority.signal } : {}),
        });
      if (authorization && requesterRuntime)
        authorization =
          await requesterRuntime.bootstrap.projectExternalActionAuthorization(
            authorization,
            origin.serverIdentityId,
            authority.signal,
          );
      return authorization && (await isCurrent())
        ? {
            authorization,
            target,
            ...(!requesterRuntime && encryption.settingsVersion !== undefined
              ? { accountSettingsVersion: encryption.settingsVersion }
              : {}),
          }
        : null;
    };
  const executeSessionAccountAction: ReturnType<
    typeof createDaemonSessionAccountActionExecutor
  > | null = externalActionIngressOwner
    ? (operation, authority) => withWebLatencyTrace(operation.requestId, async (): Promise<ActionExecuteResult> => {
        const requesterStartedAt = Date.now();
        let requesterResolved = false;
        let requesterRuntime: RequesterSessionRuntimeContext | null = null;
        try {
          requesterRuntime = await readRequesterHomeWithinActionLifetime(
            async () => !await authority.isCurrent() ? null
              : await resolveSessionAccountContext(authority.sessionId, undefined, authority.signal), authority.signal);
          requesterResolved = true;
          const credentials = requesterRuntime?.bootstrap.credentials ?? params.credentials;
          const serverHttpBaseUrl = requesterRuntime?.bootstrap.serverHttpBaseUrl ?? params.serverBaseUrl;
          const execute = createDaemonSessionAccountActionExecutor({
            serverId: params.serverId,
            serverHttpBaseUrl,
            token: credentials.token,
            credentials,
            resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot,
            machineId: params.machineId,
            initialStartDiagnostic: { phase: 'requester_runtime',
              elapsedMs: Math.max(0, Date.now() - requesterStartedAt), requesterRuntimeBound: Boolean(requesterRuntime) },
            postAgentDiscussionMessage: async (request, witness, options) => await relayDiscussionAgentPublication(
              credentials, serverHttpBaseUrl, { request, witness }, options?.signal),
            createExecutor: (getCurrentTurnWorkDepth, isCallerCurrent, postAgentDiscussionMessage, accountPluginActions) =>
              createExternalActionExecutor(
                credentials,
                getCurrentTurnWorkDepth,
                isCallerCurrent,
                undefined,
                requesterRuntime,
                undefined,
                undefined,
                undefined,
                postAgentDiscussionMessage,
                accountPluginActions,
              ),
            prepareExternalActionAuthorization: createSessionAccountActionAuthorizationPreparer(
              credentials, requesterRuntime, serverHttpBaseUrl,
            ),
          });
          return await withSessionAccountHome(requesterRuntime, () => execute(operation, authority));
        } catch (error) {
          if (authority.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
          if (isPluginError(error) && error.code === 'project_requester_home_unavailable')
            return { ok: false, errorCode: error.code, error: error.code };
          const refusalPhase = requesterResolved ? 'credentialed_factory' : 'requester_runtime';
          const refusalReason = requesterResolved ? 'credentialed_factory_failed' : 'requester_runtime_unavailable';
          logDaemonSessionAccountActionRefusalV1(operation, authority.sessionId, {
            reason: 'action_executor_refused', errorCode: 'target_unavailable', refusalCode: 'target_unavailable',
            refusalPhase, refusalReason,
            elapsedSubphasesMs: { [refusalPhase]: Math.max(0, Date.now() - requesterStartedAt) },
          });
          return actionStartTargetUnavailableV1(undefined, refusalPhase, refusalReason);
        } finally {
          await releaseSessionAccountContext(requesterRuntime);
        }
      }, authority.sessionId)
    : null;
  const externalActionApi:
    | NonNullable<
        Parameters<typeof startDaemonControlServer>[0]['externalActionApi']
      >
    | undefined = externalActionIngressOwner
    ? {
        currentAccountId: externalActionAccountId,
        terminalPolicyScope: {
          token: params.credentials.token,
          serverHttpBaseUrl: params.serverBaseUrl,
        },
        readEncryptionAccess: createAccountServerPatEncryptionAccessReader({
          accountId: externalActionAccountId,
          serverBaseUrl: params.serverBaseUrl,
        }),
        verifyPat: createDaemonPatVerifier({
          accountId: externalActionAccountId,
          introspect: createAccountServerPatIntrospector({
            daemonConnectionToken: params.credentials.token,
            serverBaseUrl: params.serverBaseUrl,
          }),
        }),
        resolveInstallationId: () =>
          readInstallationIdentityIfExistsSync()?.installationId ?? null,
        verifyExecutionAuthorization: async (input) => {
          const installation = readInstallationIdentityIfExistsSync();
          if (
            !installation ||
            installation.installationId !==
              input.authorization.binding.installationId
          )
            return false;
          return await verifyExternalActionExecutionAuthorizationCurrent({
            ...input,
            privateKey: installation.privateKey,
            installationId: installation.installationId,
            serverHttpBaseUrl: params.serverBaseUrl,
          });
        },
        mintExecutionAuthorization: async ({
          actionId,
          envelope,
          machineId,
          pat,
          signal,
        }) =>
          await mintExternalActionExecutionAuthorization({
            actionId,
            envelope,
            machineId,
            pat,
            serverHttpBaseUrl: params.serverBaseUrl,
            ...(signal ? { signal } : {}),
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
      ['runner_plugin_mcp', async () => { await runnerPluginMcp.dispose(); }],
      [
        'runner_plugin_services_host',
        async () => {
          await runnerDaemonPluginServicesHost.dispose();
          await runnerExecutionRunSnapshots.dispose();
        },
      ],
      [
        'runner_agent_daemon_facets',
        async () => {
          await runnerAgentDaemonFacetService.dispose();
        },
      ],
      [
        'external_session_host_operations',
        async () => {
          await externalSessionHostOperationOwner.retire();
        },
      ],
      ...(externalActionTranscriptFollowLeaseRegistry
        ? [
            [
              'external_action_transcript_follow_leases',
              async () => {
                await externalActionTranscriptFollowLeaseRegistry.dispose();
              },
            ] as const,
          ]
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
  // Opaque RPC release handles only. The canonical PID cleanup owner retains
  // custody; this map carries no broker authority or selection state.
  const providerBrokerBindingReleaseById = new Map<
    string,
    Readonly<{
      sessionId: string;
      cleanup: () => Promise<void>;
      readManagedBinding?: (proof: ManagedRunBindingProof, signal?: AbortSignal) => Promise<ManagedRunBindingResult | null>;
      managedConsumerCredential?: string;
    }>
  >();
  type ManagedRunBindingOpen = Extract<AgentRuntimeDaemonServiceRequestV1['operation'], { kind: 'provider_managed.binding.open' }>;
  type ManagedRunBindingProof = Omit<ManagedRunBindingOpen, 'kind' | 'requestId'>;
  type ManagedRunBindingResult = Extract<Extract<AgentRuntimeDaemonServiceResponseV1, { ok: true }>['result'], { kind: 'provider_managed.binding' }>;
  const managedRunBindingProof = (operation: ManagedRunBindingProof): ManagedRunBindingProof => ({
    executionRunId: operation.executionRunId, executionRunOccurrenceId: operation.executionRunOccurrenceId,
    agentId: operation.agentId, modelId: operation.modelId, runtimeBindingBasis: operation.runtimeBindingBasis,
    expectedAccountSettingsScopeKey: operation.expectedAccountSettingsScopeKey,
  });
  const resolveAttachedProviderAccount = async (sessionId: string, tracked: TrackedSession,
    expectedScopeKey: string, signal: AbortSignal) => runWithRequesterSessionCurrentnessCheckpoint(async () => {
    const requester = await resolveSessionAccountContext(sessionId, undefined, signal);
    let accountReturned = false;
    try {
      const credentials = requester ? requester.bootstrap.credentials : params.credentials;
      const rootAccountId = readPreviewAccountIdFromToken(params.credentials.token);
      if (!rootAccountId || readPreviewAccountIdFromToken(credentials.token) !== rootAccountId
        || resolveForegroundAccountSettingsScopeKey(credentials) !== expectedScopeKey
        || requester && (requester.bootstrap.attribution.serverId !== params.serverId
          || requester.bootstrap.attribution.machineId !== params.machineId
          || normalizeServerHttpBaseUrl(requester.bootstrap.serverHttpBaseUrl) !== normalizeServerHttpBaseUrl(params.serverBaseUrl))) return null;
      const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
      const readSnapshot = () => {
        const snapshot = requester ? requester.readAccountSettingsSnapshot() : getActiveAccountSettingsSnapshot();
        return snapshot?.scopeKey === expectedScopeKey ? snapshot : null;
      };
      const isCurrentPidOwner = () => !signal.aborted && !isRuntimePublicationQuiescing()
        && params.pidToTrackedSession.get(tracked.pid) === tracked
        && tracked.reportMarkerCustody?.retiring !== true
        && tracked.happySessionId === sessionId
        && (requester ? tracked.requesterSessionRuntimeContext === requester
          : lifetimeToken === getActiveAccountSettingsSnapshotLifetimeToken());
      const isCurrent = async () => {
        if (!isCurrentPidOwner()) return false;
        try {
          await assertSessionAccountCurrent(sessionId, requester);
          return isCurrentPidOwner() && readSnapshot() !== null;
        } catch { return false; }
      };
      const purposeResolver = requester ? requester.resolveManagedPurposeBindingIntent : params.resolveManagedPurposeBindingIntent;
      if (!await isCurrent()) return null;
      // Returned closures borrow the exact tracked runtime; PID retirement owns it.
      accountReturned = true;
      return { accountId: rootAccountId, credentials, isCurrent, isCurrentPidOwner,
        ...(requester ? { savedSecretOperationContext: requester.bootstrap.savedSecretOperationContext } : {}),
        release: async () => await releaseSessionAccountContext(requester),
        readCurrentAccountSettingsSnapshot: () => isCurrentPidOwner() ? readSnapshot() : null,
        readAccountSettingsSnapshot: async () => await isCurrent() ? readSnapshot() : null,
        ...(purposeResolver ? { resolveManagedPurposeBindingIntent: async (input: Parameters<typeof purposeResolver>[0]) => {
          // The nested Connected Account reader checks the same requester at
          // entry. Share that read proof; keep the post-read fence fresh.
          const binding = await runWithRequesterSessionCurrentnessCheckpoint(async () => {
            if (!await isCurrent()) throw createForegroundProviderError('provider_authorization_changed');
            return await withSessionAccountHome(requester, () => purposeResolver(input));
          }, { readOnly: true });
          if (!await isCurrent()) throw createForegroundProviderError('provider_authorization_changed');
          return binding;
        } } : {}),
        withHome: <T>(read: () => Promise<T>) => runWithServerHttpBaseUrl(params.serverBaseUrl, read),
      };
    } finally {
      if (!accountReturned) await releaseSessionAccountContext(requester);
    }
  }, { readOnly: true });
  const openAttachedManagedRunBinding = async (input: Readonly<{ sessionId: string; tracked: TrackedSession;
    proof: ManagedRunBindingProof; signal: AbortSignal }>): Promise<ManagedRunBindingResult | null> => {
    const proof = managedRunBindingProof(input.proof);
    const basis = proof.runtimeBindingBasis;
    if (!params.openAccountConnectionManagedConsumerSource || basis.deployment.kind !== 'managedLocal'
      || basis.deployment.managedRuntime.sharing !== 'connectionMachine'
      || basis.runtimeCredentialTransport?.destination.kind !== 'httpHeader') return null;
    // Traced phases run in callbacks; keep the managed narrowing in a local.
    const deployment = basis.deployment;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, shutdownCancellationDomains.daemonWorkSignal]);
    const preparationSignal = AbortSignal.any([signal, input.signal]);
    const resources = createProviderLaunchResourceScope();
    const trace = <T>(phase: Parameters<typeof traceRunPreparationPhase>[1], work: () => Promise<T>) =>
      traceRunPreparationPhase(proof.executionRunId, phase, preparationSignal, work);
    let bindingPublished = false;
    try {
      const account = await trace('binding_account_context', () =>
        resolveAttachedProviderAccount(input.sessionId, input.tracked, proof.expectedAccountSettingsScopeKey, signal));
      if (!account) return null;
      resources.register(account.release);
      const resolveManagedPurposeBindingIntent = account.resolveManagedPurposeBindingIntent;
      if (!resolveManagedPurposeBindingIntent) return null;
      const isRunCurrent = async (currentSignal: AbortSignal = signal) => {
        const readSignal = AbortSignal.any([signal, currentSignal]);
        try {
          // Session transport and its nested Account readers form one read
          // preparation. Never retain that observation across the Run RPC's
          // result-publication fence or a later consumer validation.
          const current = await runWithRequesterSessionCurrentnessCheckpoint(async () => {
            if (!await account.isCurrent()) return null;
            return await account.withHome(async () => {
              const transport = await resolveSessionTransportContext({ reason: 'session-control', credentials: account.credentials, idOrPrefix: input.sessionId, signal: readSignal });
              if (!transport.ok || transport.sessionId !== input.sessionId || !await account.isCurrent()) return null;
              const rpc = { token: account.credentials.token, sessionId: transport.sessionId,
                method: `${transport.sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1}`,
                request: SessionExecutionRunBrokerAuthorityRequestV1Schema.parse({ v: 1, executionRunId: proof.executionRunId,
                  expectedOccurrenceId: proof.executionRunOccurrenceId, expectedProviderConnectionModel: {
                    agentId: proof.agentId, agentTargetKey: basis.agentTargetKey, providerConnectionId: basis.connectionId, modelId: proof.modelId,
                  } }), signal: readSignal };
              return SessionExecutionRunBrokerAuthorityResponseV1Schema.parse(transport.mode === 'plain'
                ? await callSessionRpc({ ...rpc, mode: 'plain' }) : await callSessionRpc({ ...rpc, mode: 'e2ee', ctx: transport.ctx }));
            });
          }, { readOnly: true });
          return current?.status === 'current' && current.executionRunId === proof.executionRunId
            && current.occurrenceId === proof.executionRunOccurrenceId && current.parentSessionId === input.sessionId
            && await runWithRequesterSessionCurrentnessCheckpoint(() => account.isCurrent());
        } catch { return false; }
      };
      input.signal.throwIfAborted();
      if (!await trace('binding_run_authority', () => isRunCurrent(preparationSignal))) return null;
      const targetMachineId = basis.deployment.gatewayPlacement?.kind === 'machine'
        ? basis.deployment.gatewayPlacement.machineId : params.machineId;
      const application = { agentTargetKey: basis.agentTargetKey, implementationIdentity: basis.deployment.implementationIdentity,
        endpointTemplateId: basis.endpoint.endpointTemplateId, protocol: basis.endpoint.protocol };
      const opened = await trace('managed_source_open', () => params.openAccountConnectionManagedConsumerSource!({ targetMachineId, accountId: account.accountId,
        runtimeBindingBasis: basis, agentId: proof.agentId, modelId: proof.modelId,
        request: { consumer: { kind: 'execution_run', executionRunId: proof.executionRunId }, executionRunOccurrenceId: proof.executionRunOccurrenceId,
          consumerMachineId: params.machineId, application, source: { kind: 'account_connection', connectionId: basis.connectionId,
            expectedConnectionSecurityFingerprint: basis.credentialAuthorization.connectionSecurityFingerprint,
            expectedManagedRuntimeBindingFingerprint: createProviderManagedRuntimeBindingFingerprintV1({
              implementationIdentity: deployment.implementationIdentity, managedRuntime: deployment.managedRuntime,
              purposeBindings: deployment.purposeBindings }) } },
        expectedAccountSettingsScopeKey: proof.expectedAccountSettingsScopeKey, readAccountSettingsSnapshot: account.readAccountSettingsSnapshot,
        resolveManagedPurposeBindingIntent, signal: preparationSignal, isCurrent: isRunCurrent }));
      if (!opened) return null;
      resources.register(opened.retire);
      const endpointUrl = opened.access.endpointUrl(application.endpointTemplateId);
      if (!endpointUrl) return null;
      let cleanup: (() => Promise<void>) | null = null;
      const consumer = await trace('consumer_application_start', () => startManagedProviderConsumerApplication({ signal, endpointUrl, credentialTransport: basis.runtimeCredentialTransport,
        request: async request => {
          if (await opened.revalidate(request.signal)) return { ok: true, response: await opened.access.request(request) };
          lifetime.abort();
          void cleanup?.().catch(() => undefined); // The existing PID cleanup retains failed release custody.
          return { ok: false, reasonCode: 'resource_forbidden' };
        } }));
      resources.register(consumer.cleanup);
      input.signal.throwIfAborted();
      if (!await trace('binding_source_currentness', () => opened.revalidate(preparationSignal))) return null;
      const bindingId = randomUUID();
      const result = { kind: 'provider_managed.binding' as const, bindingId, endpointUrl: consumer.endpointUrl,
        headers: { [basis.runtimeCredentialTransport.destination.name]: consumer.renderedCredential } };
      const release = resources.transfer();
      let unregister: (() => void) | null = null;
      cleanup = async () => {
        lifetime.abort();
        await release?.();
        providerBrokerBindingReleaseById.delete(bindingId);
        unregister?.();
      };
      unregister = registerPidSpawnResourceCleanup({ pid: input.tracked.pid, spawnResourceCleanupByPid: params.spawnResourceCleanupByPid,
        label: 'provider_managed.binding.open',
        isCurrentPidOwner: account.isCurrentPidOwner,
        cleanup: async () => { await cleanup?.(); } });
      if (!unregister) { await cleanup(); return null; }
      providerBrokerBindingReleaseById.set(bindingId, { sessionId: input.sessionId,
        managedConsumerCredential: consumer.credential,
        cleanup: async () => { await cleanup?.(); },
        readManagedBinding: async (currentProof, currentSignal) => {
          if (!isDeepStrictEqual(currentProof, proof)) return null;
          if (!consumer.isCurrent()) { await cleanup?.(); return null; }
          const readSignal = currentSignal ? AbortSignal.any([signal, currentSignal]) : signal;
          if (!await opened.revalidate(readSignal)) {
            if (!readSignal.aborted) await cleanup?.();
            return null;
          }
          return consumer.isCurrent() ? result : null;
        } });
      bindingPublished = true;
      return result;
    } finally {
      if (!bindingPublished) {
        lifetime.abort();
        await resources.retire();
      }
    }
  };
  const resolveRunnerProviderPreparation = async (request: ExecutionRunProviderLaunchRequest,
    context: Parameters<AgentRuntimeDaemonServiceRoutes['dispatch']>[1]): Promise<RunnerExecutionRunProviderPreparation | null> => {
    const tracked = context.trackedSession;
    if (!tracked || !await context.isCurrent()) return null;
    context.signal?.throwIfAborted();
    const account = await traceRunPreparationPhase(request.runId, 'request_account_context', context.signal, () =>
      resolveAttachedProviderAccount(context.sessionId, tracked, request.expectedAccountSettingsScopeKey,
        shutdownCancellationDomains.daemonWorkSignal));
    if (!account) return null;
    try {
      const accountSettingsSnapshot = await traceRunPreparationPhase(request.runId, 'request_settings', context.signal,
        () => account.readAccountSettingsSnapshot());
      if (!accountSettingsSnapshot) return null;
      const serverSnapshot = await traceRunPreparationPhase(request.runId, 'request_features', context.signal,
        () => params.resolveServerFeaturesSnapshot?.() ?? fetchServerFeaturesSnapshot({ serverUrl: params.serverBaseUrl }));
      if (!await context.isCurrent() || !await account.isCurrent()) return null;
      return { machineId: params.machineId, happyHomeDir: configuration.happyHomeDir, accountSettingsSnapshot,
        readAccountSettingsSnapshot: account.readCurrentAccountSettingsSnapshot,
        ...(account.savedSecretOperationContext ? { savedSecretOperationContext: account.savedSecretOperationContext } : {}),
        featureEnabled: resolveCliFeatureDecision({ featureId: 'providers', env: params.processEnv,
          ...(serverSnapshot ? { serverSnapshot } : {}) }).state === 'enabled',
        isCurrent: async () => await context.isCurrent() && await account.isCurrent(),
        ...(account.resolveManagedPurposeBindingIntent ? { resolveManagedPurposeBindingIntent: account.resolveManagedPurposeBindingIntent } : {}),
        readModelProjection: createAccountScopedProviderModelProjectionReader({ serverUrl: params.serverBaseUrl,
          readCredentials: async () => await account.isCurrent() ? account.credentials : null,
          readAccountSettingsSnapshot: account.readAccountSettingsSnapshot,
          isCurrent: async () => await context.isCurrent() && await account.isCurrent() }),
        prepareManagedEndpoint: async ({ scope, authorization, registerCleanup, signal }) => {
          const unavailable = () => createForegroundProviderError('provider_endpoint_unavailable');
          if (scope.kind !== 'execution_run' || scope.executionRunId !== request.runId || !request.controllerOccurrenceId
            || !await context.isCurrent() || !await account.isCurrent()) throw unavailable();
          const proof: ManagedRunBindingProof = { executionRunId: request.runId,
            executionRunOccurrenceId: request.controllerOccurrenceId, agentId: request.agentId, modelId: request.selection.modelId,
            runtimeBindingBasis: projectProviderRuntimeBindingBasis(authorization), expectedAccountSettingsScopeKey: request.expectedAccountSettingsScopeKey };
          const opened = await openAttachedManagedRunBinding({ sessionId: context.sessionId, tracked, proof,
            signal: signal ?? context.signal ?? shutdownCancellationDomains.daemonWorkSignal });
          const binding = opened ? providerBrokerBindingReleaseById.get(opened.bindingId) : null;
          if (!opened || !binding?.managedConsumerCredential || !binding.readManagedBinding) throw unavailable();
          registerCleanup(binding.cleanup);
          return { normalizedUrl: opened.endpointUrl, downstreamBearer: binding.managedConsumerCredential,
            cleanup: binding.cleanup,
            revalidateBeforeCommit: async (signal) => {
              if (await context.isCurrent() && await account.isCurrent()
                && providerBrokerBindingReleaseById.get(opened.bindingId) === binding && await binding.readManagedBinding!(proof, signal)) {
                return { ok: true as const };
              }
              await binding.cleanup();
              return { ok: false as const, error: unavailable() };
            },
          };
        },
      };
    } finally { await account.release(); }
  };
  const sessionLiveWorkProducer = createSessionLiveWorkProducer({
    startup: spawnRequestCoalescer,
    readSessions: () => [...params.pidToTrackedSession.values()],
    readActivity: tracked => readSessionRunnerLiveWork(tracked, shutdownCancellationDomains.daemonWorkSignal),
  });
  notifySessionLiveWorkChanged = () => sessionLiveWorkProducer.notifyChanged();
  let sourceFollow: Readonly<{ machine: ApiMachineClient; personalSettingsLifetime: number; isCurrent: () => Promise<boolean>;
    dispatcher: ReturnType<typeof createSessionFollowOccurrenceDispatcher> }> | null = null;
  let sourceRunRoutes: Readonly<{ machine: ApiMachineClient; isCurrent: () => Promise<boolean>;
    routes: ReturnType<typeof createObservedAccountRunFollowRoutes> }> | null = null;
  shutdownCancellationDomains.daemonWorkSignal.addEventListener('abort', () => {
    sourceRunRoutes?.routes.dispose(); sourceRunRoutes = null;
  }, { once: true });
  const dispatchSessionFollowOccurrence = async (request: import('@/agent/runtime/session/follow/sessionFollowOccurrenceDispatcher').SessionFollowOccurrenceDispatch): Promise<import('@/agent/runtime/session/follow/sessionFollowOccurrenceDispatcher').SessionFollowReceiverRangeResult | SessionActivityChangedResult | void> => {
    const diagnostic = 'observations' in request ? { entry: 'receiver_range', destinationSessionId: request.destinationSessionId,
      ...(request.sourceSessionId ? { sourceSessionId: request.sourceSessionId } : {}) }
      : request.occurrence && !('original' in request.occurrence) ? { entry: 'occurrence',
        ...projectSessionFollowOccurrenceDiagnostic(request.occurrence) } : null;
    if (isRuntimePublicationQuiescing()) {
      if (diagnostic) logger.debug('[Session Follow] Daemon dispatch', { ...diagnostic, phase: 'publication', status: 'held', reason: 'quiescing' });
      return;
    }
    if (diagnostic) logger.debug('[Session Follow] Daemon dispatch', { ...diagnostic, phase: 'requester_context', status: 'started' });
    const sessionId = 'sourceSessionIdChanged' in request ? request.contextSessionId ?? null
      : 'accountFollowSourcesChanged' in request ? null
      : 'executionRunSourceChanged' in request ? 'sessionId' in request.executionRunSourceChanged ? request.executionRunSourceChanged.sessionId : null
      : 'observations' in request ? request.destinationSessionId
      : request.destinationSessionId ?? ('original' in request.occurrence
        ? request.occurrence.original.source.kind === 'execution_run' && 'sessionId' in request.occurrence.original.source
          ? request.occurrence.original.source.sessionId : request.contextSessionId ?? null
        : request.occurrence.sourceSessionId);
    return await withSessionAccountContext(sessionId, async requester => {
      if (diagnostic) logger.debug('[Session Follow] Daemon dispatch', { ...diagnostic, phase: 'requester_context',
        status: 'completed', requester: requester !== null });
      const machine = params.getApiMachineForSessions();
      const installation = readInstallationIdentityIfExistsSync();
      const signal = shutdownCancellationDomains.daemonWorkSignal;
      if (!installation) {
        if (diagnostic) logger.debug('[Session Follow] Daemon dispatch', { ...diagnostic, phase: 'installation', status: 'held', reason: 'installation_missing' });
        return;
      }
      if (requester) {
        if (diagnostic) logger.debug('[Session Follow] Daemon dispatch', { ...diagnostic, phase: 'requester_currentness', status: 'started' });
        if (!await requester.isCurrent(signal)) {
          if (diagnostic) logger.debug('[Session Follow] Daemon dispatch', { ...diagnostic, phase: 'requester_currentness', status: 'held', reason: 'requester_not_current' });
          return;
        }
        const bootstrap = requester.bootstrap;
        const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: bootstrap.attribution.accountId,
          credentials: bootstrap.credentials, serverId: bootstrap.attribution.serverId,
          serverHttpBaseUrl: bootstrap.serverHttpBaseUrl, machineId: params.machineId,
          installationId: installation.installationId, signal, rulesCache: requester.sessionFollowRuleCache,
          runRoutes: requester.sessionFollowRunRoutes,
          isCurrent: async () => !isRuntimePublicationQuiescing() && await requester.isCurrent(signal),
          subscribeInvalidation: bootstrap.subscribeSessionFollowRules,
          spawnSession: spawnSessionForInternalResume, isSessionAlreadyRunning, resolveServerFeaturesSnapshot,
          resolveSourceKeyContext: async () => {
            const origin = await createCurrentMachineExecutionOriginContextResolver({ serverUrl: bootstrap.serverHttpBaseUrl,
              resolveCurrentMachineId: () => params.machineId })(signal);
            return origin?.machineId === params.machineId && await requester.isCurrent(signal)
              ? { serverIdentityId: origin.serverIdentityId, authority: 'account_automation', surface: 'api', signal } : null;
          },
          isPersonalCurrent: () => bootstrap.savedSecretOperationContext.isCurrent(),
          dispatchPersonal: async (dispatch, isCurrent) => createPersonalFollowOccurrenceDispatcher({
            operationContext: bootstrap.savedSecretOperationContext,
            expoPushSender: requester.api.push(),
            isCurrent,
          })(dispatch),
        });
        try {
          if ('accountFollowSourcesChanged' in request) return await dispatcher.dispatchAccountSourceRange(request.accountFollowSourcesChanged);
          if ('executionRunSourceChanged' in request) return await dispatcher.dispatchExecutionRunSourceChange(request.executionRunSourceChanged, request.includeRun);
          if ('sourceSessionIdChanged' in request) return { receiverSessionIds: await dispatcher.readReceiverSessionIds(request.sourceSessionIdChanged) };
          if ('observations' in request) return await dispatcher.dispatchReceiverRange(request);
          if (request.destinationSessionId !== undefined) await dispatcher.dispatchReceiver({ occurrence: request.occurrence, destinationSessionId: request.destinationSessionId });
          else return await dispatcher.dispatch(request.occurrence);
        } finally { dispatcher.dispose(); }
        return;
      }
      if (diagnostic) logger.debug('[Session Follow] Daemon dispatch', { ...diagnostic, phase: 'installed_account', status: 'started' });
      const account = await machine?.resolveInstalledAccountObservationRuntime(signal);
      if (!machine || !account || account.serverId !== params.serverId
        || account.machineId !== params.machineId || account.accountId !== readPreviewAccountIdFromToken(params.credentials.token)
        || !sameStoredCredentials(account.credentials, params.credentials) || !await account.isCurrent?.()) {
        if (diagnostic) logger.debug('[Session Follow] Daemon dispatch', { ...diagnostic, phase: 'installed_account', status: 'held', reason: 'installed_account_not_current' });
        return;
      }
      if (!sourceFollow || sourceFollow.machine !== machine || !await sourceFollow.isCurrent()
        || sourceFollow.personalSettingsLifetime !== getActiveAccountSettingsSnapshotLifetimeToken()) {
        sourceFollow?.dispatcher.dispose();
        sourceFollow = null;
        const isCurrent = async () => !isRuntimePublicationQuiescing() && params.getApiMachineForSessions() === machine
          && Boolean(await account.isCurrent?.());
        if (!sourceRunRoutes || sourceRunRoutes.machine !== machine || !await sourceRunRoutes.isCurrent()) {
          sourceRunRoutes?.routes.dispose();
          sourceRunRoutes = { machine, isCurrent, routes: createObservedAccountRunFollowRoutes({ accountId: account.accountId,
            credentials: account.credentials, serverHttpBaseUrl: account.serverHttpBaseUrl, signal, isCurrent }) };
        }
        // Session receivers need the admitted Account observation. Personal
        // effects additionally need the exact saved-settings scope below.
        const snapshot = getActiveAccountSettingsSnapshot();
        const personalSettingsLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
        const operationContext = snapshot && account.serverId === configuration.activeServerId
          && snapshot.scopeKey === resolveForegroundAccountSettingsScopeKey(account.credentials)
          ? createInvocationSavedSecretOperationContextV1({ credentials: account.credentials,
            snapshot, readSourceSnapshot: getActiveAccountSettingsSnapshot, serverHttpBaseUrl: account.serverHttpBaseUrl,
            isCurrent: async () => personalSettingsLifetime === getActiveAccountSettingsSnapshotLifetimeToken() && await isCurrent(),
          }) : null;
        const push = new PushNotificationClient(account.credentials.token, account.serverHttpBaseUrl, account.serverId);
        const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: account.accountId, credentials: account.credentials,
          serverId: account.serverId, serverHttpBaseUrl: account.serverHttpBaseUrl, machineId: params.machineId,
          installationId: installation.installationId, signal,
          runRoutes: sourceRunRoutes.routes,
          isCurrent,
          subscribeInvalidation: listener => machine.onSessionFollowRulesChanged(listener),
          spawnSession: spawnSessionForInternalResume, isSessionAlreadyRunning, resolveServerFeaturesSnapshot,
          resolveSourceKeyContext: async () => {
            const origin = await params.resolveCurrentMachineExecutionOriginContext?.(signal);
            return origin?.machineId === params.machineId && await account.isCurrent?.()
              ? { serverIdentityId: origin.serverIdentityId, authority: 'account_automation', surface: 'api', signal } : null;
          },
          isPersonalCurrent: () => operationContext?.isCurrent() ?? false,
          dispatchPersonal: async (dispatch, isCurrent) => operationContext
            ? createPersonalFollowOccurrenceDispatcher({ operationContext, expoPushSender: push, isCurrent })(dispatch)
            : undefined,
        });
        sourceFollow = { machine, dispatcher, personalSettingsLifetime, isCurrent };
      }
      if ('accountFollowSourcesChanged' in request) return await sourceFollow.dispatcher.dispatchAccountSourceRange(request.accountFollowSourcesChanged);
      if ('executionRunSourceChanged' in request) return await sourceFollow.dispatcher.dispatchExecutionRunSourceChange(request.executionRunSourceChanged, request.includeRun);
      if ('sourceSessionIdChanged' in request) {
        await sourceFollow.dispatcher.dispatchAccountSourceRange({ sourceSessionId: request.sourceSessionIdChanged });
        return { receiverSessionIds: await sourceFollow.dispatcher.readReceiverSessionIds(request.sourceSessionIdChanged) };
      }
      if ('observations' in request) return await sourceFollow.dispatcher.dispatchReceiverRange(request);
      if (request.destinationSessionId !== undefined) await sourceFollow.dispatcher.dispatchReceiver({ occurrence: request.occurrence, destinationSessionId: request.destinationSessionId });
      else return await sourceFollow.dispatcher.dispatch(request.occurrence);
    }, undefined, shutdownCancellationDomains.daemonWorkSignal);
  };
  const runnerPluginMcp = createDaemonRunnerPluginMcp({ acquireRegistry: acquireDaemonPluginRuntimeRegistryLease,
    trackedSessions: params.pidToTrackedSession, spawnResourceCleanupByPid: params.spawnResourceCleanupByPid,
    signal: shutdownCancellationDomains.daemonWorkSignal });
  const { port: controlPort, stop: stopControlServer } =
    await startDaemonControlServer({
      skillStore: params.skillStore,
      skillUsageRecorder: params.skillUsageRecorder,
      onScmDiffSummaryResultUpdated: change => params.getApiMachineForSessions()?.emitScmDiffSummaryResultUpdated(change),
      onSessionActivityChanged: async (sessionId, occurrence, executionRunId) => {
        sessionLiveWorkProducer.notifyChanged();
        if (executionRunId && sessionId === null) params.getApiMachineForSessions()?.emitExecutionRunSourceUpdated(executionRunId);
        let result: Awaited<ReturnType<typeof dispatchSessionFollowOccurrence>> = undefined;
        if (occurrence) {
          result = await dispatchSessionFollowOccurrence({ occurrence, ...(sessionId ? { contextSessionId: sessionId } : {}) });
        }
        if (executionRunId) await dispatchSessionFollowOccurrence({ executionRunSourceChanged: { kind: 'execution_run', runId: executionRunId,
          ...(sessionId ? { sessionId } : { machineId: params.machineId }) }, includeRun: !occurrence });
        return result && !('receiverSessionIds' in result) ? result : undefined;
      },
      admissionDrain: params.admissionDrain,
      resolveRecoveredSpawnNonce: async (spawnNonce) =>
        await resolveRecoveredSpawnNonceAdmission({
          spawnNonce,
          happyHomeDir: configuration.happyHomeDir,
          getChildren: () => Array.from(params.pidToTrackedSession.values()),
          probeSessionServiceability: async (sessionId) =>
            await probeSessionRunnerServiceability({
              sessionId,
              trackedSessions: params.pidToTrackedSession.values(),
              probeCapability: async () =>
                await probeAlreadyRunningExistingSessionServiceability({
                  sessionId,
                  credentials: params.credentials,
                  abortSignal: shutdownCancellationDomains.daemonWorkSignal,
                  isShuttingDown: isRuntimePublicationQuiescing,
                }),
            }),
        }),
      runtimeActionExecute: params.runtimeActionExecute,
      pidToTrackedSession: params.pidToTrackedSession,
      getChildren: () => Array.from(params.pidToTrackedSession.values()),
      machineId: params.machineId,
      runtimeId: params.runtimeId ?? '',
      readDoctorResourceVitals: params.readDoctorResourceVitals,
      ...(params.readPluginCatalogProjection ? { readPluginCatalogProjection: params.readPluginCatalogProjection } : {}),
      stopSession: (sessionId, intent, signal) => intent === 'explicit_stop'
        ? stopSessionExplicit(sessionId, signal) : stopSession(sessionId),
      spawnSession,
      requestShutdown: () => params.requestShutdown('happier-cli'),
      ...(params.requestSelfRestart
        ? { requestSelfRestart: params.requestSelfRestart }
        : {}),
      ...(params.pluginChangeService
        ? { pluginChangeService: params.pluginChangeService }
        : {}),
      pluginActionCurrentIntent,
      ...(externalActionApi ? { externalActionApi } : {}),
      ...(params.isShuttingDown
        ? { isShuttingDown: params.isShuttingDown }
        : {}),
      beforeShutdown: async () => {
        const beforeShutdown = params.beforeShutdown;
        await runControlRuntimeShutdownPhases(
          typeof beforeShutdown === 'function'
            ? [
                [
                  'daemon_before_shutdown',
                  async () => {
                    await beforeShutdown();
                  },
                ],
              ]
            : [],
        );
      },
      onHappySessionWebhook: createSessionStartupReadinessHandler({
        onHappySessionWebhook: async (...args) => {
          await params.onHappySessionWebhook(...args);
          notifySessionLiveWorkChanged();
        },
        reconcileCanonicalReadiness: async (tracked) => {
          if (!tracked.agentRuntimeDaemonServiceAuthorityFilePath) {
            return;
          }
          const canonicalSessionId = normalizeOptionalString(
            tracked.happySessionId,
          );
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
        reconcileFollowUp: async (sessionId, sessionMetadata) => {
          void queueHostedWebStaticAssetSync('session_webhook');
          const normalizedSessionId = normalizeOptionalString(sessionId);
          if (!normalizedSessionId) return;
          rememberPersistedConnectedServiceSwitchSessionMetadata(
            normalizedSessionId,
            sessionMetadata,
          );
          const tracked = [...params.pidToTrackedSession.values()].find(
            (candidate) =>
              normalizeOptionalString(candidate.happySessionId) ===
              normalizedSessionId,
          );
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
                      isShuttingDown: isRuntimePublicationQuiescing,
                    }),
                }),
              publishSessionRunnerControlServiceability: async (
                reportedSessionId,
                probe,
              ) => {
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
            logger.debug(
              '[DAEMON RUN] Failed to rehydrate connected-service runtime identity after session report',
              {
                sessionId: normalizedSessionId,
                error: serializeAxiosErrorForLog(error),
              },
            );
          });
          const currentTarget =
            connectedServiceRuntimeRegistry.getBySessionId(normalizedSessionId);
          if (!currentTarget) return;
          await scheduleRuntimeTargetGenerationReconciliation(
            currentTarget,
            sessionMetadata,
            true,
          );
        },
        onFollowUpError: (error, sessionId) => {
          logger.debug(
            '[DAEMON RUN] Failed to reconcile session startup follow-up',
            {
              sessionId,
              error: serializeAxiosErrorForLog(error),
            },
          );
        },
      }),
      onSessionStartupFailure,
      ...(params.admitPersistedTakeover
        ? { admitPersistedTakeover: params.admitPersistedTakeover }
        : {}),
      ...(params.sshTunnelSupervisor
        ? { sshTunnels: params.sshTunnelSupervisor }
        : {}),
      localServicesInventory: localServicesRuntime.inventoryRoutes,
      localServicesLauncher: localServicesRuntime.launcherRoutes,
      localServicesPreview: localServicesRuntime.previewRoutes,
      localServicesActions: localServicesRuntime.actionRoutes,
      localServicesPublicPreview:
        localServicesRuntimeActionRoutes.publicPreviewRoutes,
      agentRuntimeDaemonServices: {
        authorizeExecutionRunAction: async (operation, { sessionId, trackedSession, signal: requestSignal }) => {
          const child = operation.executionRun;
          if (!child || params.pidToTrackedSession.get(trackedSession.pid) !== trackedSession) return false;
          const signal = AbortSignal.any([requestSignal, shutdownCancellationDomains.daemonWorkSignal]);
          return await withSessionAccountContext(sessionId, async requester => {
            const credentials = requester?.bootstrap.credentials ?? params.credentials;
            return await withSessionAccountHome(requester, async () => {
              const transport = await resolveSessionTransportContext({ reason: 'session-control', credentials, idOrPrefix: sessionId, signal });
              if (!transport.ok || transport.sessionId !== sessionId) return false;
              const rpc = { token: credentials.token, sessionId,
                method: `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1}`,
                request: { v: 1, executionRunId: child.runId, expectedOccurrenceId: child.occurrenceId }, timeoutMs: null, signal };
              const current = SessionExecutionRunBrokerAuthorityResponseV1Schema.parse(transport.mode === 'plain'
                ? await callSessionRpc({ ...rpc, mode: 'plain' }) : await callSessionRpc({ ...rpc, mode: 'e2ee', ctx: transport.ctx }));
              return params.pidToTrackedSession.get(trackedSession.pid) === trackedSession
                && current.status === 'current' && current.parentSessionId === sessionId
                && current.executionRunId === child.runId && current.occurrenceId === child.occurrenceId
                && current.runtimeState === 'active_turn' && current.activeTurnId === operation.witness.turnId;
            });
          }, undefined, signal);
        },
        dispatch: async (request, context) => {
          const { sessionId, runner, trackedSession } = context;
          if (request.operation.kind === 'execution_run.review_plugin_authority.resolve_v1') {
            if (!trackedSession || context.signal?.aborted || !await context.isCurrent()) return {
              ok: false as const, error: { code: 'execution_run_host_action_context_unavailable',
                message: 'Review host-action context is unavailable' },
            };
            const authority = await readCurrentReviewHostPluginAuthority(request.operation.pluginId, pluginRuntimeController);
            if (context.signal?.aborted || !await context.isCurrent()) return {
              ok: false as const, error: { code: 'execution_run_host_action_context_unavailable',
                message: 'Review host-action context is unavailable' },
            };
            return { ok: true as const, result: { kind: 'execution_run.review_plugin_authority' as const, authority } };
          }
          if (request.operation.kind === 'execution_run.snapshot.acquire_v1'
            || request.operation.kind === 'execution_run.snapshot.release_v1'
            || request.operation.kind === 'execution_run.native_offered_model.read_v1'
            || request.operation.kind === 'execution_run.review_scm_scope.resolve_v1'
            || request.operation.kind === 'execution_run.commit_message_context.resolve_v1'
            || request.operation.kind === 'execution_run.scm_commit_target.capture_v1'
            || request.operation.kind === 'execution_run.provider.admit_v1'
            || request.operation.kind === 'execution_run.provider.prepare_v1'
            || request.operation.kind === 'execution_run.provider.revalidate_v1'
            || request.operation.kind === 'execution_run.provider.release_v1') {
            try {
              return await runnerExecutionRunSnapshots.dispatch(request, context);
            } catch (error) {
              // This boundary also serves SCM and native model reads. Retain
              // the failing operation and Home disposition before returning
              // the deliberately narrow public snapshot refusal.
              logger.warnLocalFile('[EXECUTION RUN] Snapshot service operation failed', {
                sessionId,
                operation: request.operation.kind,
                ...classifyServerEndpointError(error),
              });
              const code = ProviderErrorCodeV1Schema.safeParse(error && typeof error === 'object' && 'code' in error ? error.code : undefined);
              if (code.success) return { ok: false as const, error: { code: code.data, message: code.data } };
              return { ok: false as const, error: { code: 'execution_run_contribution_snapshot_unavailable',
                message: 'Execution Run executable snapshot is unavailable' } };
            }
          }
          const executionRunSnapshotId = request.context.executionRunSnapshotId;
          // Exact close authenticates against the invocation's retained snapshot and parent.
          // Snapshot release can precede it; every other operation still needs the live lease.
          const closesPluginServices = request.operation.kind === 'plugin_services.close_v1';
          const runSnapshot = executionRunSnapshotId && !closesPluginServices
            ? runnerExecutionRunSnapshots.read(executionRunSnapshotId, context) : null;
          if (executionRunSnapshotId && !closesPluginServices && !runSnapshot?.projection.agent) {
            return { ok: false as const, error: { code: 'execution_run_contribution_snapshot_unavailable',
              message: 'Execution Run executable snapshot is unavailable' } };
          }
          const retainedAgent = runSnapshot?.projection.agent?.binding ?? context.retainedAgent;
          if (request.operation.kind === 'agent_start.policy.read') {
            const unavailable = { ok: false as const, error: { code: 'requester_agent_start_policy_unavailable',
              message: 'Requester Agent-start policy is unavailable' } };
            if (!trackedSession || context.signal?.aborted || !await context.isCurrent()) return unavailable;
            const signal = context.signal
              ? AbortSignal.any([context.signal, shutdownCancellationDomains.daemonWorkSignal])
              : shutdownCancellationDomains.daemonWorkSignal;
            const attribution = trackedSession.requesterWorkAttributionV1 ?? trackedSession.spawnOptions?.requesterWorkAttributionV1;
            try {
              return await withSessionAccountContext(sessionId, async requester => {
                // A missing requester is not permission to consult the daemon Account.
                if (!requester) return unavailable;
                const policy = await withSessionAccountHome(requester,
                  () => readRequesterAgentStartPolicyV1({ runtime: requester, signal }));
                if (!policy || signal.aborted || !await context.isCurrent()) return unavailable;
                await assertSessionAccountCurrent(sessionId, requester, attribution, signal);
                return { ok: true as const, result: { kind: 'agent_start.policy' as const, policy } };
              }, attribution, signal);
            } catch {
              return unavailable;
            }
          }
          if (request.operation.kind === 'mcp.plugin.prepare' || request.operation.kind === 'mcp.plugin.materialize'
            || request.operation.kind === 'mcp.plugin.discover'
            || request.operation.kind === 'mcp.plugin.close') {
            try {
              if (request.operation.kind !== 'mcp.plugin.close') {
                const decision = await authorizeRunnerAgentNewTurn({ retainedAgent });
                if (decision.status !== 'admitted') return { ok: false as const, error: {
                  code: 'agent_runtime_daemon_service_generation_not_current', message: 'Runner Agent generation is not current' } };
              }
              return { ok: true as const, result: await runnerPluginMcp.dispatch(request.operation, { ...context,
                agentId: retainedAgent.agentId,
                ...(runSnapshot ? { runtimeRegistryLease: { ...runSnapshot.snapshot.runtimeRegistryLease, release: async () => {} } } : {}),
              }) };
            } catch (error) {
              return { ok: false as const, error: { code: isPluginError(error) ? error.code : 'plugin_mcp_preparation_unavailable',
                message: 'Plugin MCP preparation is unavailable' } };
            }
          }
          if (request.operation.kind === 'mcp.request_auth.open' || request.operation.kind === 'mcp.request_auth.close') {
            const operation = request.operation;
            const tracked = trackedSession;
            const unavailable = () => ({ ok: false as const, error: { code: 'mcp_request_auth_not_active', message: 'mcp_request_auth_not_active' } });
            if (!tracked || tracked.happySessionId !== sessionId || params.pidToTrackedSession.get(tracked.pid) !== tracked) return unavailable();
            if (operation.kind === 'mcp.request_auth.close') {
              await connectedAccountRequestAuthRegistry.retireSessionCapabilities({ parentSessionId: sessionId, materializationId: operation.materializationId });
              return { ok: true as const, result: { kind: 'mcp.request_auth.closed' as const } };
            }
            // Dispatch resolution and issuer catalog preparation share one
            // opening observation. Issuance retains its fresh effect fences.
            return await withWebLatencyTrace(operation.requestId, () => runWithRequesterSessionCurrentnessCheckpoint(async () => {
              let requesterContext: RequesterSessionRuntimeContext | null = null;
              try {
                const signal = context.signal ?? shutdownCancellationDomains.daemonWorkSignal;
                const requesterAdmissionStartedAt = performance.now();
                let requesterCheckpoint: 'requester_resolution' | 'requester_currentness' = 'requester_resolution';
                try {
                  requesterContext = await timeWebLatencyPhase('mcp.requester_resolution', () => resolveSessionAccountContext(sessionId, undefined, signal));
                  requesterCheckpoint = 'requester_currentness';
                  await timeWebLatencyPhase('mcp.requester_currentness', () => assertSessionAccountCurrent(sessionId, requesterContext));
                } catch (error) {
                  logger.infoFile('[mcp] Request-auth dispatch phase', { phase: 'requester_admission', status: 'failed',
                    checkpoint: requesterCheckpoint, failureCode: readMcpRequestAuthDiagnosticCode(error), sessionId,
                    ...readWebLatencyTracePoint(),
                    durationMs: Math.round(performance.now() - requesterAdmissionStartedAt) });
                  throw error;
                }
                const requester = requesterContext;
                logger.infoFile('[mcp] Request-auth dispatch phase', { phase: 'requester_admission', status: 'completed', sessionId,
                  ...readWebLatencyTracePoint(),
                  durationMs: Math.round(performance.now() - requesterAdmissionStartedAt) });
                const activate = requester ? requester.activatePurposeBindings : params.activatePurposeBindings;
                const established = requester ? requester.qualifiedConnectedAccountEstablishedRuntimeOwner : params.establishedConnectedAccountRuntimeOwner;
                if (!activate || !established) return unavailable();
                const credentials = requester ? requester.bootstrap.credentials : params.credentials;
                const snapshotLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
                const isCurrent = () => !isRuntimePublicationQuiescing() && !shutdownCancellationDomains.daemonWorkSignal.aborted
                  && params.pidToTrackedSession.get(tracked.pid) === tracked
                  && tracked.reportMarkerCustody?.retiring !== true
                  && tracked.happySessionId === sessionId
                  && (requester ? tracked.requesterSessionRuntimeContext === requester
                    : snapshotLifetime === getActiveAccountSettingsSnapshotLifetimeToken());
                if (!isCurrent()) return unavailable();
                const assertCurrent = async (requestSignal: AbortSignal) => {
                  requestSignal.throwIfAborted();
                  if (!isCurrent()) throw new Error('mcp_request_auth_not_active');
                  await assertSessionAccountCurrent(sessionId, requester);
                  if (!isCurrent()) throw new Error('mcp_request_auth_not_active');
                };
                const opened = await issueMcpRequestAuthCapability(operation, {
                  parentSessionId: sessionId,
                  materializationBaseDir: requester ? requester.connectedServicesMaterializationBaseDir : params.connectedServicesMaterializationBaseDir,
                  readAccountSettingsSnapshot: () => requester ? requester.readAccountSettingsSnapshot() : getActiveAccountSettingsSnapshot(),
                  ...(requester ? { operationContext: requester.bootstrap.savedSecretOperationContext } : {}),
                  establishedOwner: { readMaterialSnapshot: input => timeWebLatencyPhase('mcp.credentials',
                    () => withSessionAccountHome(requester, () => established.readMaterialSnapshot(input))) },
                  activatePurposeBindings: activate, registry: connectedAccountRequestAuthRegistry,
                  httpPort: requireConnectedAccountRequestAuthHttpPort(), isCurrent, assertCurrent,
                  registerLifetimeCleanup: cleanup => registerPidSpawnResourceCleanup({ pid: tracked.pid,
                    label: operation.kind,
                    spawnResourceCleanupByPid: params.spawnResourceCleanupByPid,
                    isCurrentPidOwner: isCurrent, cleanup }),
                  readExecutionRunAuthority: async (request, requestSignal) => {
                    await assertCurrent(requestSignal);
                    const response = await withSessionAccountHome(requester, async () => {
                      const transport = await resolveSessionTransportContext({ reason: 'session-control', credentials, idOrPrefix: sessionId, signal: requestSignal });
                      if (!transport.ok || transport.sessionId !== sessionId) return null;
                      const rpc = { token: credentials.token, sessionId,
                        method: `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1}`,
                        request,
                        signal: requestSignal };
                      return SessionExecutionRunBrokerAuthorityResponseV1Schema.parse(transport.mode === 'plain'
                        ? await callSessionRpc({ ...rpc, mode: 'plain' }) : await callSessionRpc({ ...rpc, mode: 'e2ee', ctx: transport.ctx }));
                    });
                    await assertCurrent(requestSignal);
                    return response;
                  },
                }, signal);
                return { ok: true as const, result: { kind: 'mcp.request_auth' as const, ...opened } };
              } catch (error) {
                const code = readMcpRequestAuthFailureCode(error);
                return { ok: false as const, error: { code, message: code } };
              } finally {
                await releaseSessionAccountContext(requesterContext);
              }
            }), sessionId);
          }
          if (request.operation.kind === 'action.execute') {
            return {
              ok: true as const,
              result: {
                kind: 'action.execution' as const,
                requestId: request.operation.requestId,
                outcome: executeSessionAccountAction
                  ? await executeSessionAccountAction(
                      request.operation,
                      context,
                    )
                  : {
                      ok: false as const,
                      errorCode: 'target_unavailable' as const,
                      error: 'target_unavailable',
                    },
              },
            };
          }
          if (request.operation.kind === 'turn.admission.authorize') {
            return await authorizeRunnerAgentTurnAdmission({ retainedAgent, witness: request.operation.witness });
          }
          if (request.operation.kind === 'session.open.attest') {
            const tracked = trackedSession;
            if (!tracked || tracked.happySessionId !== sessionId) {
              return {
                ok: false as const,
                error: {
                  code: 'agent_runtime_daemon_service_session_open_attestation_unavailable',
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
                request: request.operation.request,
                providerSessionId: request.operation.providerSessionId,
              });
            return attestation
              ? {
                  ok: true as const,
                  result: {
                    kind: 'session.open.attestation' as const,
                    status:
                      request.operation.phase === 'prepare'
                        ? ('accepted' as const)
                        : ('recorded' as const),
                  },
                }
              : {
                  ok: false as const,
                  error: {
                    code: 'agent_runtime_daemon_service_session_open_attestation_unavailable',
                    message:
                      'Runner Agent session-open attestation could not be recorded',
                  },
                };
          }
          if (request.operation.kind === 'provider_managed.purpose.resolve'
            || request.operation.kind === 'provider_managed.binding.open'
            || request.operation.kind === 'provider_managed.binding.read'
            || request.operation.kind === 'provider_managed.binding.close') {
            const operation = request.operation;
            const unavailable = () => ({ ok: false as const,
              error: { code: 'provider_endpoint_unavailable', message: 'provider_endpoint_unavailable' } });
            const tracked = trackedSession;
            if (!tracked || tracked.happySessionId !== sessionId
              || params.pidToTrackedSession.get(tracked.pid) !== tracked) return unavailable();
            try {
              if (operation.kind === 'provider_managed.binding.close') {
                const binding = providerBrokerBindingReleaseById.get(operation.bindingId);
                if (!binding?.readManagedBinding || binding.sessionId !== sessionId) return unavailable();
                await binding.cleanup();
                providerBrokerBindingReleaseById.delete(operation.bindingId);
                return { ok: true as const, result: { kind: 'provider_managed.binding.closed' as const, status: 'closed' as const } };
              }
              const signal = context.signal ?? shutdownCancellationDomains.daemonWorkSignal;
              if (operation.kind === 'provider_managed.purpose.resolve') {
                const account = await resolveAttachedProviderAccount(sessionId, tracked, operation.expectedAccountSettingsScopeKey, signal);
                try {
                  if (!account?.resolveManagedPurposeBindingIntent) return unavailable();
                  const binding = await account.resolveManagedPurposeBindingIntent({
                    purpose: operation.purpose, target: operation.target, serviceRefs: operation.serviceRefs, signal,
                  });
                  if (!binding || !await account.isCurrent()) return unavailable();
                  return { ok: true as const, result: { kind: 'provider_managed.purpose' as const, binding } };
                } finally { await account?.release(); }
              }
              const proof = managedRunBindingProof(operation);
              const existing = operation.kind === 'provider_managed.binding.read' && operation.bindingId
                ? providerBrokerBindingReleaseById.get(operation.bindingId) : undefined;
              // An existing handle is cleanup-only custody for this exact proof.
              // A missing handle (daemon replacement) may re-admit only the
              // original source/target and current accepted Run occurrence.
              if (existing && (existing.sessionId !== sessionId || !existing.readManagedBinding)) return unavailable();
              const result = existing
                ? await existing.readManagedBinding?.(proof, signal)
                : await openAttachedManagedRunBinding({ sessionId, tracked, proof, signal });
              return result ? { ok: true as const, result } : unavailable();
            } catch (error) {
              const providerError = ProviderErrorV1Schema.safeParse(error);
              return providerError.success ? { ok: false as const,
                error: { code: providerError.data.code, message: providerError.data.code } } : unavailable();
            }
          }
          if (request.operation.kind === 'provider_broker.refusal.read') {
            const turnId = request.operation.turnId;
            const evidence = trackedSession?.teamCredentialBrokerEvidence;
            if (!evidence) {
              recordSessionBrokerApplicationEvidenceRead({ sessionId, turnId, pid: runner.pid,
                processStartTimeMs: runner.processStartTimeMs, outcome: 'miss',
                reason: 'no_evidence' });
            }
            return { ok: true as const, result: { kind: 'provider_broker.refusal' as const,
              denial: evidence?.readDenial(turnId) ?? null } };
          }
          if (request.operation.kind === 'provider_broker.binding.open') {
            const tracked = trackedSession;
            const operation = request.operation;
            // One admission, two binding owners (`PLAN.md` §2.3): an
            // Execution Run that selected its own model carries its own
            // accepted Team and route, and is admitted on them, never on
            // its parent Session's binding, which a later parent edit may
            // change. A Session, or a Run that selected nothing and so
            // inherits, is admitted only on its tracked Session binding.
            // The Home authorizes either one at open and per request.
            const carriesRunSelection =
              operation.teamId !== undefined ||
              operation.deliveryMode !== undefined;
            // A Run materializes for its own Agent, never its parent
            // Session's retained one; a Session never names another.
            const consumerAgentId =
              operation.consumer?.kind === 'execution_run'
                ? (operation.agentId ?? null)
                : operation.agentId === undefined
                  ? retainedAgent.agentId
                  : null;
            const binding = ((): Readonly<{
              teamId: string;
              deliveryMode: TeamCredentialProviderModelSelectionV1['deliveryMode'];
            }> | null => {
              if (!tracked || consumerAgentId === null) return null;
              if (carriesRunSelection) {
                return operation.consumer?.kind === 'execution_run' &&
                  operation.teamId !== undefined &&
                  operation.deliveryMode !== undefined
                  ? {
                      teamId: operation.teamId,
                      deliveryMode: operation.deliveryMode,
                    }
                  : null;
              }
              const selection = tracked.spawnOptions?.modelSelection?.ref;
              const teamBinding =
                tracked.spawnOptions?.teamCredentialBindings?.find(
                  (candidate) => candidate.slot.kind === 'provider_model',
                );
              const teamId =
                teamBinding?.resourceId !== null
                  ? (teamBinding?.teamId ?? tracked.spawnOptions?.primaryTeamId)
                  : tracked.spawnOptions?.primaryTeamId;
              if (
                typeof teamId !== 'string' ||
                teamBinding?.slot.kind !== 'provider_model' ||
                teamBinding.resourceId !== operation.resourceId ||
                teamBinding.expectedResourceRevision !==
                  operation.expectedResourceRevision ||
                selection?.agentTargetKey !== operation.agentTargetKey ||
                selection.modelId !== operation.modelId
              )
                return null;
              return { teamId, deliveryMode: teamBinding.deliveryMode };
            })();
            const openTeamBinding = params.openTeamCredentialProviderBinding;
            if (
              !tracked ||
              !openTeamBinding ||
              !binding ||
              consumerAgentId === null
            ) {
              throw new SessionTeamCredentialLaunchUnavailableError();
            }
            let opened;
            try {
              const signal = context.signal ?? new AbortController().signal;
              opened = await withSessionAccountContext(sessionId, async requester => {
                const result = await withSessionAccountHome(requester, () => openTeamBinding({
                  sessionId,
                  teamId: binding.teamId,
                  resourceId: operation.resourceId,
                  expectedResourceRevision:
                    operation.expectedResourceRevision,
                  deliveryMode: binding.deliveryMode,
                  agentId: consumerAgentId,
                  agentTargetKey: operation.agentTargetKey,
                  modelId: operation.modelId,
                  beginBrokerRequest: () => {
                    if (operation.consumer?.kind === 'execution_run') return undefined;
                    const evidence = tracked.teamCredentialBrokerEvidence ??= createSessionBrokerApplicationEvidence({
                      sessionId, pid: runner.pid, processStartTimeMs: runner.processStartTimeMs,
                      readActiveTurnId: () => tracked.activeTurnId ?? null,
                      isCurrent: () => params.pidToTrackedSession.get(tracked.pid) === tracked,
                    });
                    return evidence.beginRequest();
                  },
                  ...(operation.consumer
                    ? { consumer: operation.consumer }
                    : {}),
                  ...(requester ? { providerSettingsOperationContext: requester.bootstrap.savedSecretOperationContext } : {}),
                  signal,
                }));
                try {
                  await assertSessionAccountCurrent(sessionId, requester, undefined, signal);
                  return result;
                } catch (error) {
                  await result.cleanup();
                  throw error;
                }
              }, undefined, signal);
            } catch (error) {
              const providerError = ProviderErrorV1Schema.safeParse(error);
              if (providerError.success) {
                return {
                  ok: false as const,
                  error: {
                    code: providerError.data.code,
                    message: providerError.data.code,
                  },
                };
              }
              if (error instanceof TeamCredentialDirectMaterialOperationError) {
                const teamCredentialCode =
                  TeamCredentialErrorCodeV1Schema.safeParse(error.code);
                if (teamCredentialCode.success) {
                  return {
                    ok: false as const,
                    error: {
                      code: teamCredentialCode.data,
                      message: teamCredentialCode.data,
                    },
                  };
                }
              }
              throw error;
            }
            const bindingId =
              request.operation.consumer?.kind === 'execution_run'
                ? randomUUID()
                : null;
            const unregisterCleanup = registerPidSpawnResourceCleanup({
              pid: tracked.pid,
              label: operation.kind,
              spawnResourceCleanupByPid: params.spawnResourceCleanupByPid,
              isCurrentPidOwner: () =>
                params.pidToTrackedSession.get(tracked.pid) === tracked,
              cleanup: async () => {
                await opened.cleanup();
                if (bindingId)
                  providerBrokerBindingReleaseById.delete(bindingId);
              },
            });
            if (!unregisterCleanup) {
              await opened.cleanup();
              throw new SessionTeamCredentialLaunchUnavailableError();
            }
            if (bindingId)
              providerBrokerBindingReleaseById.set(bindingId, {
                sessionId,
                cleanup: async () => {
                  await opened.cleanup();
                  unregisterCleanup();
                },
              });
            return AgentRuntimeDaemonServiceResponseV1Schema.parse({
              ok: true as const,
              result: {
                kind: 'provider_broker.binding' as const,
                status: 'opened' as const,
                providerBinding: opened.providerBinding,
                environmentOverlay: opened.environmentOverlay,
                additionalRedactionValues: opened.additionalRedactionValues,
                ...(bindingId ? { bindingId } : {}),
              },
            });
          }
          if (request.operation.kind === 'provider_broker.binding.close') {
            const binding = providerBrokerBindingReleaseById.get(
              request.operation.bindingId,
            );
            if (!binding || binding.sessionId !== sessionId || binding.readManagedBinding) {
              return {
                ok: false as const,
                error: {
                  code: 'provider_broker_binding_not_current',
                  message: 'Team credential Provider binding is not current',
                },
              };
            }
            await binding.cleanup();
            providerBrokerBindingReleaseById.delete(
              request.operation.bindingId,
            );
            return {
              ok: true as const,
              result: {
                kind: 'provider_broker.binding.closed' as const,
                status: 'closed' as const,
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
                result: await runnerDaemonPluginServicesHost.dispatch({
                  sessionId,
                  runner,
                  retainedAgent,
                  ...(executionRunSnapshotId ? { executionRunSnapshotId, runnerRetainedAgent: context.retainedAgent } : {}),
                  operation: pluginServiceOperation.data,
                  ...(context.signal
                    ? {
                        signal: context.signal,
                      }
                    : {}),
                }),
              };
            } catch (error) {
              const failure = projectRunnerDaemonPluginServicesFailure(error,
                pluginServiceOperation.data.kind === 'plugin_services.prepare_v1' ? 'dispatch' : undefined);
              if (failure.cause) {
                logger.warnLocalFile(JSON.stringify({
                  kind: pluginServiceOperation.data.kind === 'plugin_services.prepare_v1'
                    ? 'runner_plugin_services_prepare_refused' : 'runner_plugin_services_dispatch_refused',
                  operation: pluginServiceOperation.data.kind,
                  ...projectRunnerDaemonPluginServicesFailureDiagnostic(error),
                }));
              }
              return {
                ok: false as const,
                error: failure,
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
                result: await runnerAgentDaemonFacetService.dispatch({
                  sessionId,
                  runner,
                  retainedAgent,
                  operation: facetOperation.data,
                  ...(context.signal
                    ? {
                        signal: context.signal,
                      }
                    : {}),
                }),
              };
            } catch (error) {
              const candidateCode = isPluginError(error)
                ? error.code
                : error &&
                    typeof error === 'object' &&
                    typeof Reflect.get(error, 'code') === 'string'
                  ? Reflect.get(error, 'code')
                  : error instanceof Error
                    ? error.message
                    : '';
              const code =
                typeof candidateCode === 'string' &&
                /^[a-z][a-z0-9_]{0,127}$/u.test(candidateCode)
                  ? candidateCode
                  : 'agent_runtime_daemon_facet_unavailable';
              return {
                ok: false as const,
                error: {
                  code,
                  message: 'Runner Agent daemon-owned facet is unavailable',
                },
              };
            }
          }
          if (
            request.operation.kind === 'turn_contributions.resolve' ||
            request.operation.kind === 'model_transition.authorize' ||
            request.operation.kind === 'session.input.admit'
          ) {
            const decision = await authorizeRunnerAgentNewTurn({
              retainedAgent,
            });
            if (decision.status !== 'admitted') {
              return {
                ok: false as const,
                error: {
                  code: 'agent_runtime_daemon_service_generation_not_current',
                  message: 'Runner Agent generation is not current',
                },
              };
            }
            if (request.operation.kind === 'session.input.admit') {
              const admissionRequest = request.operation.request;
              const admission =
                admissionRequest.sessionId !== sessionId
                  ? {
                      status: 'rejected' as const,
                      code: 'session_input_source_authority_mismatch' as const,
                    }
                  : admissionRequest.targetMachineId !== params.machineId
                    ? {
                        status: 'rejected' as const,
                        code: 'session_input_source_authority_mismatch' as const,
                      }
                    : ((await params
                        .getApiMachineForSessions()
                        ?.enqueueSessionPendingByMachine(
                          admissionRequest,
                          context.signal
                            ? { signal: context.signal }
                            : undefined,
                        )) ?? {
                        status: 'rejected' as const,
                        code: 'session_input_target_unavailable' as const,
                      });
              return {
                ok: true as const,
                result: {
                  kind: 'session.input.admission' as const,
                  status: 'resolved' as const,
                  admission,
                },
              };
            }
            const lease = runSnapshot ? { ...runSnapshot.snapshot.runtimeRegistryLease, release: async () => {} }
              : await acquireDaemonPluginRuntimeRegistryLease();
            try {
              if (request.operation.kind === 'model_transition.authorize') {
                const tracked = findTrackedSessionByHappySessionId(
                  params.pidToTrackedSession.values(),
                  sessionId,
                );
                const authorization =
                  AgentRuntimeDaemonModelTransitionAuthorizationResultV1Schema.parse(
                    await authorizeDaemonSessionModelTransitionProviderTarget({
                      trackedAgentId:
                        resolveTrackedSessionCatalogAgentId(tracked),
                      trackedSelection:
                        tracked?.spawnOptions?.modelSelection?.ref ?? null,
                      trackedSessionBindingMetadata:
                        tracked?.spawnOptions?.providerBindingMetadataV1 ??
                        null,
                      requestAgentId: retainedAgent.agentId,
                      requestedSelection: request.operation.selection,
                      authorizeProviderTarget: async (authority) =>
                        await authorizeSessionModelTransitionProviderTargetWithLease(
                          {
                            sessionId,
                            machineId: params.machineId,
                            agentId: authority.agentId,
                            agentTargetKey: authority.agentTargetKey,
                            signal: context.signal,
                            lease,
                            input: authority.input,
                          },
                        ),
                    }),
                  );
                return {
                  ok: true as const,
                  result: {
                    kind: 'model_transition' as const,
                    status: 'authorized' as const,
                    authorization,
                  },
                };
              }
              const operationRequest = request.operation.request;
              if (operationRequest.kind === 'lifecycleHook') {
                return { ok: true as const, result: { kind: 'turn_contributions' as const, status: 'resolved' as const,
                  contributions: AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({ kind: 'lifecycleHook',
                    result: await dispatchPluginHookEvent({ runtimeRegistry: lease.registry, event: operationRequest.event }),
                  }) } };
              }
              if (operationRequest.kind === 'composition') {
                const composition =
                  await resolveAgentCompositionThroughRuntimeRegistry(
                    lease.registry,
                    {
                      sessionId,
                      agentId: retainedAgent.agentId,
                      runtimeFamily: operationRequest.runtimeFamily,
                      ...(operationRequest.machineId
                        ? {
                            machineId: operationRequest.machineId,
                          }
                        : {}),
                      ...(operationRequest.featureIds
                        ? {
                            featureIds: operationRequest.featureIds,
                          }
                        : {}),
                      ...(context.signal ? { signal: context.signal } : {}),
                    },
                  );
                return {
                  ok: true as const,
                  result: {
                    kind: 'turn_contributions' as const,
                    status: 'resolved' as const,
                    contributions:
                      AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({
                        kind: 'composition' as const,
                        ...composition,
                      }),
                  },
                };
              }
              if (operationRequest.kind === 'prompt') {
                let optionalPromptAssetsUnavailable = false;
                const promptAssetBlocks =
                  await lease.registry.resolvePromptAssetBlocks({
                    agentId: retainedAgent.agentId,
                    onOptionalUnavailable: () => { optionalPromptAssetsUnavailable = true; },
                    ...(context.signal ? { signal: context.signal } : {}),
                    sessionId,
                    ...(operationRequest.selectedAsset
                      ? {
                          selectedAsset: operationRequest.selectedAsset,
                        }
                      : {}),
                    ...(operationRequest.machineId
                      ? {
                          machineId: operationRequest.machineId,
                        }
                      : {}),
                    ...(operationRequest.featureIds
                      ? {
                          featureIds: operationRequest.featureIds,
                        }
                      : {}),
                    ...(operationRequest.excludePluginIds
                      ? {
                          excludePluginIds: operationRequest.excludePluginIds,
                        }
                      : {}),
                  });
                return {
                  ok: true as const,
                  result: {
                    kind: 'turn_contributions' as const,
                    status: 'resolved' as const,
                    contributions:
                      AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({
                        kind: 'prompt' as const,
                        promptAssetBlocks,
                        ...(optionalPromptAssetsUnavailable ? { optionalPromptAssetsUnavailable: true } : {}),
                        toolPromptContributions:
                          resolvePluginToolPromptContributionsThroughRuntimeRegistry(
                            lease.registry,
                            operationRequest.excludePluginIds
                              ? {
                                  excludePluginIds:
                                    operationRequest.excludePluginIds,
                                }
                              : undefined,
                          ).map(
                            ({ pluginId: _pluginId, ...contribution }) =>
                              contribution,
                          ),
                      }),
                  },
                };
              }
              if (operationRequest.kind === 'composerReference') {
                const references = lease.registry.composerReferences;
                if (!references) {
                  throw new PluginError({
                    code: 'composer_reference_unavailable',
                    message: 'Composer references are unavailable',
                  });
                }
                const resolution = await references.resolve({
                  reference: operationRequest.reference,
                  candidateId: operationRequest.candidateId,
                  sessionId,
                  signal: context.signal ?? new AbortController().signal,
                });
                return {
                  ok: true as const,
                  result: {
                    kind: 'turn_contributions' as const,
                    status: 'resolved' as const,
                    contributions:
                      AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({
                        kind: 'composerReference' as const,
                        resolution,
                      }),
                  },
                };
              }
              if (operationRequest.kind === 'composerAttachment') {
                if (operationRequest.request.sessionId !== sessionId) {
                  throw new PluginError({
                    code: 'composer_attachment_session_mismatch',
                    message:
                      'Composer attachment resolution session does not match the authenticated Runner session',
                  });
                }
                const attachments = lease.registry.composerAttachments;
                if (!attachments) {
                  throw new PluginError({
                    code: 'composer_attachment_unavailable',
                    message: 'Composer attachments are unavailable',
                  });
                }
                if (!attachments.isDeclared(operationRequest.attachment)) {
                  throw new PluginError({
                    code: 'composer_attachment_unavailable',
                    message: `Composer attachment '${operationRequest.attachment.pluginId}/${operationRequest.attachment.localId}' is unavailable`,
                  });
                }
                const result = attachments.requires({
                  attachment: operationRequest.attachment,
                  phase: 'resolveForDispatch',
                })
                  ? await (async () => {
                      if (
                        !(await attachments.supports({
                          attachment: operationRequest.attachment,
                          phase: 'resolveForDispatch',
                        }))
                      ) {
                        throw new PluginError({
                          code: 'composer_attachment_callback_unavailable',
                          message: `Composer attachment '${operationRequest.attachment.pluginId}/${operationRequest.attachment.localId}' does not provide 'resolveForDispatch'`,
                        });
                      }
                      return await attachments.resolveForDispatch({
                        attachment: operationRequest.attachment,
                        request: operationRequest.request,
                        signal: context.signal ?? new AbortController().signal,
                      });
                    })()
                  : Object.freeze({
                      attachments: Object.freeze(
                        operationRequest.request.attachments.map((attachment) =>
                          Object.freeze({
                            instanceId: attachment.instanceId,
                            status: 'ready' as const,
                          }),
                        ),
                      ),
                    });
                return {
                  ok: true as const,
                  result: {
                    kind: 'turn_contributions' as const,
                    status: 'resolved' as const,
                    contributions:
                      AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({
                        kind: 'composerAttachment' as const,
                        result,
                      }),
                  },
                };
              }
              if (operationRequest.kind === 'composerAttachmentAccepted') {
                if (operationRequest.event.sessionId !== sessionId) {
                  throw new PluginError({
                    code: 'composer_attachment_session_mismatch',
                    message:
                      'Composer attachment acceptance session does not match the authenticated Runner session',
                  });
                }
                const attachments = lease.registry.composerAttachments;
                if (!attachments) {
                  throw new PluginError({
                    code: 'composer_attachment_unavailable',
                    message: 'Composer attachments are unavailable',
                  });
                }
                if (!attachments.isDeclared(operationRequest.attachment)) {
                  throw new PluginError({
                    code: 'composer_attachment_unavailable',
                    message: `Composer attachment '${operationRequest.attachment.pluginId}/${operationRequest.attachment.localId}' is unavailable`,
                  });
                }
                if (
                  attachments.requires({
                    attachment: operationRequest.attachment,
                    phase: 'afterMessageAccepted',
                  })
                ) {
                  if (
                    !(await attachments.supports({
                      attachment: operationRequest.attachment,
                      phase: 'afterMessageAccepted',
                    }))
                  ) {
                    throw new PluginError({
                      code: 'composer_attachment_callback_unavailable',
                      message: `Composer attachment '${operationRequest.attachment.pluginId}/${operationRequest.attachment.localId}' does not provide 'afterMessageAccepted'`,
                    });
                  }
                  await attachments.afterMessageAccepted({
                    attachment: operationRequest.attachment,
                    event: operationRequest.event,
                    signal: context.signal ?? new AbortController().signal,
                  });
                }
                return {
                  ok: true as const,
                  result: {
                    kind: 'turn_contributions' as const,
                    status: 'resolved' as const,
                    contributions:
                      AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({
                        kind: 'composerAttachmentAccepted' as const,
                      }),
                  },
                };
              }
              if (operationRequest.kind === 'settleComposerStagedMedia') {
                await settleComposerStagedMediaAdmissionV1({
                  outcome: operationRequest.outcome,
                  settlement: operationRequest.settlement,
                  stageStore: createActiveDaemonComposerMediaStageStore({
                    machineId: params.machineId,
                  }),
                  logger,
                });
                return {
                  ok: true as const,
                  result: {
                    kind: 'turn_contributions' as const,
                    status: 'resolved' as const,
                    contributions:
                      AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({
                        kind: 'settleComposerStagedMedia' as const,
                      }),
                  },
                };
              }
              let payload: Readonly<Record<string, unknown>>;
              if (operationRequest.kind === 'transformSessionInput') {
                const signal = context.signal ?? new AbortController().signal;
                const transformed =
                  await transformSessionInputThroughRuntimeRegistry(
                    lease.registry,
                    operationRequest.payload,
                    { signal },
                  );
                const sourceMeta = operationRequest.payload.meta;
                const sourceMetaRecord =
                  sourceMeta &&
                  typeof sourceMeta === 'object' &&
                  !Array.isArray(sourceMeta)
                    ? (sourceMeta as Record<string, unknown>)
                    : {};
                const transformedMeta = transformed.meta;
                const transformedMetaRecord =
                  transformedMeta &&
                  typeof transformedMeta === 'object' &&
                  !Array.isArray(transformedMeta)
                    ? (transformedMeta as Record<string, unknown>)
                    : null;
                const preservedMeta =
                  preserveComposerAttachmentSelectionAcrossSessionInputTransformV1(
                    {
                      sourceMeta: sourceMetaRecord,
                      transformedMeta: transformedMetaRecord,
                    },
                  );
                const sourceRefRead =
                  readComposerSourceRefAndStripPrivateMetaField(
                    sourceMetaRecord,
                  );
                if (!preservedMeta) {
                  if (
                    transformedMetaRecord &&
                    Object.prototype.hasOwnProperty.call(
                      transformedMetaRecord,
                      COMPOSER_SOURCE_REF_PRIVATE_META_FIELD_V1,
                    )
                  ) {
                    payload = Object.freeze({
                      ...transformed,
                      meta: stripComposerSourceRefPrivateMetaField(
                        transformedMetaRecord,
                      ),
                    });
                  } else {
                    payload = transformed;
                  }
                } else {
                  const meta =
                    stripComposerSourceRefPrivateMetaField(preservedMeta);
                  const sourceComposerRef = sourceRefRead.sourceComposerRef;
                  const selected = validateSessionStructuredInputIngressV1({
                    meta,
                  });
                  if (selected.length === 0) {
                    payload =
                      meta === transformedMetaRecord
                        ? transformed
                        : Object.freeze({ ...transformed, meta });
                  } else {
                    if (operationRequest.payload.sessionId !== sessionId) {
                      throw new PluginError({
                        code: 'composer_attachment_session_mismatch',
                        message:
                          'Composer attachment preparation session does not match the authenticated Runner session',
                      });
                    }
                    const attachments = lease.registry.composerAttachments;
                    if (!attachments) {
                      throw new PluginError({
                        code: 'composer_attachment_unavailable',
                        message: 'Composer attachments are unavailable',
                      });
                    }
                    const preparedDraftAttachments =
                      await prepareComposerAttachmentDraftsForSendV1({
                        attachments,
                        sessionId,
                        messageLocalId: operationRequest.payload.localId,
                        drafts: selected,
                        signal,
                      });
                    const messageLocalId =
                      typeof operationRequest.payload.localId === 'string'
                        ? operationRequest.payload.localId.trim()
                        : '';
                    if (!messageLocalId) {
                      throw new PluginError({
                        code: 'composer_attachment_request_invalid',
                        message:
                          'Composer attachment finalization requires the canonical Message local identity',
                      });
                    }
                    const tracked = findTrackedSessionByHappySessionId(
                      params.pidToTrackedSession.values(),
                      sessionId,
                    );
                    const workingDirectory = tracked?.spawnOptions?.directory;
                    const finalization =
                      await finalizeComposerStagedMediaToSession({
                        sessionId,
                        messageLocalId,
                        workingDirectory:
                          typeof workingDirectory === 'string'
                            ? workingDirectory
                            : '',
                        executionTarget: {
                          serverId: params.serverId,
                          machineId: params.machineId,
                        },
                        stageStore: createActiveDaemonComposerMediaStageStore({
                          machineId: params.machineId,
                        }),
                        meta,
                        attachments: preparedDraftAttachments,
                        ...(sourceComposerRef ? { sourceComposerRef } : {}),
                        logger,
                      });
                    try {
                      const preparedComposerAttachments = attachments.admit({
                        phase: 'prepared',
                        attachments: finalization.attachments,
                      });
                      const {
                        [COMPOSER_STAGED_MEDIA_ADMISSION_SETTLEMENT_FIELD]:
                          _discardedSettlement,
                        ...transformedWithoutSettlement
                      } = transformed;
                      payload = Object.freeze({
                        ...transformedWithoutSettlement,
                        meta: finalization.meta,
                        preparedComposerAttachments,
                        ...(finalization.releaseIntents.length > 0
                          ? {
                              [COMPOSER_STAGED_MEDIA_ADMISSION_SETTLEMENT_FIELD]:
                                {
                                  v: 1,
                                  releaseIntents: finalization.releaseIntents,
                                  createdWorkspaceRelativePaths:
                                    finalization.createdWorkspaceRelativePaths,
                                  workingDirectory,
                                },
                            }
                          : {}),
                      });
                    } catch (error) {
                      if (
                        typeof workingDirectory === 'string' &&
                        workingDirectory.trim().length > 0
                      ) {
                        await garbageCollectUncommittedSessionMedia({
                          workingDirectory,
                          candidateWorkspaceRelativePaths:
                            finalization.createdWorkspaceRelativePaths,
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
                  !rawRequest ||
                  typeof rawRequest !== 'object' ||
                  Array.isArray(rawRequest)
                ) {
                  throw new PluginError({
                    code: 'agent_request_transform_invalid',
                    message:
                      'Agent request transformation requires a raw ACP request object',
                  });
                }
                payload = await transformAgentRequestThroughRuntimeRegistry(
                  lease.registry,
                  Object.freeze({
                    sessionId,
                    agentId: retainedAgent.agentId,
                    runtimeFamily: 'acpSession',
                    method: 'session/prompt',
                    request: rawRequest,
                    timestampMs: Date.now(),
                  }),
                  context.signal ? { signal: context.signal } : undefined,
                );
              } else {
                payload =
                  await transformAgentContextThroughPluginRuntimeRegistry(
                    lease.registry,
                    operationRequest.payload,
                    context.signal ? { signal: context.signal } : undefined,
                  );
              }
              return {
                ok: true as const,
                result: {
                  kind: 'turn_contributions' as const,
                  status: 'resolved' as const,
                  contributions:
                    AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({
                      kind: operationRequest.kind,
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
            pluginId: retainedAgent.pluginId,
          };
          if (request.operation.kind === 'managed_server.endpoint.read.claim') {
            const claimed =
              managedServiceEndpointReadOwner?.claim({
                requestId: request.operation.requestId,
                projectionToken: request.operation.projectionToken,
                sessionId: authority.sessionId,
                pluginId: authority.pluginId,
              }) === true;
            return {
              ok: true as const,
              result: {
                kind: 'managed_server.endpoint.read' as const,
                status: claimed
                  ? ('claimed' as const)
                  : ('unavailable' as const),
                requestId: request.operation.requestId,
              },
            };
          }
          if (request.operation.kind === 'managed_server.secret.read') {
            const operation = request.operation;
            const resolved = await withRetainedRunnerAgentServiceBinding(
              retainedAgent,
              runner.snapshotIdentity,
              async attested => await resolveRunnerManagedServiceDeclaredSecret({
                paths: resolvePluginStorePaths({
                  happyHomeDir: configuration.happyHomeDir,
                }),
                attested,
                request: {
                  phase: operation.phase,
                  secretId: operation.secretId,
                  canonicalOrigin: operation.canonicalOrigin,
                  ...(operation.expectedRevision
                    ? { expectedRevision: operation.expectedRevision }
                    : {}),
                },
                ...(context.signal ? { signal: context.signal } : {}),
              }),
            );
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
            request.operation.kind === 'managed_server.supervision.authorize'
          ) {
            const operation = request.operation;
            const managedProviderAuthority = request.operation.operationClaimId
              ? await runnerDaemonPluginServicesHost.readManagedProviderSupervisionAuthority(
                  {
                    sessionId,
                    runner,
                    retainedAgent,
                    contributionId: request.operation.contributionId,
                    operationClaimId: request.operation.operationClaimId,
                    serverId: request.operation.serverId,
                  },
                )
              : null;
            if (
              managedProviderAuthority &&
              !managedProviderAuthority.expectedLaunch
            ) {
              throw new PluginError({
                code: 'plugin_managed_server_launch_denied',
                message:
                  'Managed Provider server launch has no exact operation-input authority',
              });
            }
            const authorization = managedProviderAuthority
              ? await authorizeRunnerManagedProviderServerSupervision({
                  paths: resolvePluginStorePaths({
                    happyHomeDir: configuration.happyHomeDir,
                  }),
                  sessionId,
                  request: {
                    ...request.operation,
                    sourceCustody:
                      managedProviderAuthority.bootstrap.scope.sourceCustody,
                  },
                  bootstrap: managedProviderAuthority.bootstrap,
                  expectedLaunch: managedProviderAuthority.expectedLaunch!,
                })
              : await withRetainedRunnerAgentServiceBinding(
                retainedAgent,
                runner.snapshotIdentity,
                async attested => await authorizeRunnerManagedServiceSupervision({
                  attested,
                  happyHomeDir: configuration.happyHomeDir,
                  processEnv: params.processEnv ?? process.env,
                  ...(context.invocationContext.agentCliLaunch
                    ? { agentCliLaunch: context.invocationContext.agentCliLaunch }
                    : {}),
                  request: {
                    ...operation,
                    sourceCustody: retainedAgent.sourceCustody,
                  },
                  ...(context.signal ? { signal: context.signal } : {}),
                }),
              );
            return AgentRuntimeDaemonServiceResponseV1Schema.parse({
              ok: true as const,
              result: {
                kind: 'managed_server.supervision' as const,
                status: 'authorized' as const,
                launch: authorization.launch,
              },
            });
          }
          if (request.operation.kind === 'managed_server.endpoint.publish') {
            const projection = request.operation.projection;
            const managedProviderAuthority = projection.operationClaimId
              ? await runnerDaemonPluginServicesHost.readManagedProviderSupervisionAuthority(
                  {
                    sessionId,
                    runner,
                    retainedAgent,
                    contributionId: projection.contributionId,
                    operationClaimId: projection.operationClaimId,
                  },
                )
              : null;
            const managedProviderBootstrap =
              managedProviderAuthority?.bootstrap ?? null;
            const isExactAgentContribution =
              projection.contributionId ===
              resolveAgentContributionQualifiedId({
                pluginId: retainedAgent.pluginId,
                localId: retainedAgent.localAgentId,
              });
            if (
              (!managedProviderBootstrap && !isExactAgentContribution) ||
              (managedProviderBootstrap &&
                projection.pluginId !== managedProviderBootstrap.scope.pluginId)
            ) {
              return {
                ok: true as const,
                result: {
                  kind: 'managed_server.endpoint' as const,
                  status: 'unavailable' as const,
                },
              };
            }
            const result =
              await executeRunnerManagedServiceEndpointProjectionBridgeOperation(
                {
                  authority: managedProviderBootstrap
                    ? {
                        sessionId: managedProviderBootstrap.scope.sessionId,
                        pluginId: managedProviderBootstrap.scope.pluginId,
                      }
                    : authority,
                  operation: {
                    kind: 'managed_server_endpoint_publish',
                    projection: request.operation.projection,
                  },
                  owner: managedServiceDurabilityOwner!,
                },
              );
            if (result.kind !== 'managed_server_endpoint_published') {
              throw new Error(
                'Managed server endpoint publish returned the wrong result',
              );
            }
            return {
              ok: true as const,
              result: {
                kind: 'managed_server.endpoint' as const,
                status: 'published' as const,
                projectionToken: result.projectionToken,
              },
            };
          }
          if (request.operation.kind === 'managed_server.endpoint.release') {
            const result =
              await executeRunnerManagedServiceEndpointProjectionBridgeOperation(
                {
                  authority: {
                    sessionId: authority.sessionId,
                    pluginId: request.operation.pluginId,
                  },
                  operation: {
                    kind: 'managed_server_endpoint_release',
                    instanceId: request.operation.instanceId,
                    projectionToken: request.operation.projectionToken,
                  },
                  owner: managedServiceDurabilityOwner!,
                },
              );
            if (result.kind !== 'managed_server_endpoint_released') {
              throw new Error(
                'Managed server endpoint release returned the wrong result',
              );
            }
            return {
              ok: true as const,
              result: {
                kind: 'managed_server.endpoint' as const,
                status: 'released' as const,
                released: result.released,
              },
            };
          }
          if (request.operation.kind !== 'managed_server.endpoint.resolve') {
            return {
              ok: true as const,
              result: {
                kind: 'managed_server.endpoint' as const,
                status: 'unavailable' as const,
              },
            };
          }
          const projection =
            await managedServiceDurabilityOwner!.resolveEndpointProjection({
              pluginId: authority.pluginId,
              sessionId: authority.sessionId,
              selector: request.operation.selector,
            });
          return projection && projection.custodyOwner === 'sessionRunner'
            ? {
                ok: true as const,
                result: {
                  kind: 'managed_server.endpoint' as const,
                  status: 'resolved' as const,
                  projection,
                },
              }
            : {
                ok: true as const,
                result: {
                  kind: 'managed_server.endpoint' as const,
                  status: 'unavailable' as const,
                },
              };
        },
      },
      recordAgentRuntimeDaemonServiceAdmission: async (tracked, admission) => {
        const sessionId = normalizeOptionalString(tracked.happySessionId);
        if (!sessionId) return false;
        return await updateSessionMarkerActiveTurn({
          pid: tracked.sessionRunnerPid ?? tracked.pid,
          sessionId,
          activeTurnId: admission.turnId,
          agentRuntimeDaemonServiceActiveAdmission: admission,
        });
      },
      clearAgentRuntimeDaemonServiceAdmission: async (tracked, admission) => {
        const sessionId = normalizeOptionalString(tracked.happySessionId);
        if (!sessionId) return false;
        return await updateSessionMarkerActiveTurn({
          pid: tracked.sessionRunnerPid ?? tracked.pid,
          sessionId,
          activeTurnId: tracked.activeTurnId ?? null,
          expectedAgentRuntimeDaemonServiceActiveAdmission: admission,
        });
      },
      foregroundAgentRuntimeAdmission,
      simulatorPreview: simulatorPreviewRuntime.routes,
      connectedAccountRequestAuth: {
        authenticate: connectedAccountRequestAuthRegistry.authenticate,
        lookupRequestAuth: async (input) => {
          return await connectedAccountRequestAuthService.lookupRequestAuth(
            input,
          );
        },
        refreshAfterAuthFailure: async (input) => {
          return await connectedAccountRequestAuthService.refreshAfterAuthFailure(
            input,
          );
        },
        reportQuotaFailure: async (input) => {
          return await connectedAccountRequestAuthService.reportQuotaFailure(
            input,
          );
        },
      },
      handleSessionConnectedServiceAuthSwitch: async (input) => {
        return await withSessionAccountContext(input.sessionId, async (accountContext) => {
          const sessionCredentials =
            accountContext?.bootstrap.credentials ?? params.credentials;
          const sessionApi = accountContext?.api ?? params.api;
          const readSessionSettings = () =>
            accountContext
              ? accountContext.readAccountSettingsSnapshot().settings
              : (getActiveAccountSettingsSnapshot()?.settings ?? null);
          return await withSessionAccountHome(accountContext, async () => {
            const interruptedOriginId =
              Array.from(params.pidToTrackedSession.values())
                .find((tracked) => tracked.happySessionId === input.sessionId)
                ?.activeTurnId?.trim() || null;
            await connectedServiceRecoverySupersessionCleaner({
              sessionId: input.sessionId,
              event: { kind: 'manual_session_supersession', reason: 'switch' },
            });
            const settingsRefresh = accountContext
              ? (await accountContext.refreshAccountSettings(
                  input.accountSettingsVersionHint,
                ))
                ? { ok: true as const }
                : {
                    ok: false as const,
                    error: new Error('requester_account_settings_unavailable'),
                  }
              : await refreshAccountSettingsForDaemonRequest({
                  credentials: sessionCredentials,
                  accountSettingsVersionHint: input.accountSettingsVersionHint,
                });
            if (accountContext && !settingsRefresh.ok)
              throw settingsRefresh.error;
            let diagnostics:
              | SessionConnectedServiceAuthSwitchDiagnostics
              | undefined;
            if (!settingsRefresh.ok) {
              logger.warn(
                '[DAEMON RUN] Account settings freshness refresh failed before connected-service auth switch',
                serializeAxiosErrorForLog(settingsRefresh.error),
              );
              diagnostics = {
                accountSettingsFreshness: {
                  requestedVersion:
                    typeof input.accountSettingsVersionHint === 'number'
                      ? input.accountSettingsVersionHint
                      : null,
                  status: 'failed',
                  error: toConnectedServiceAuthSwitchDiagnosticError(
                    settingsRefresh.error,
                  ),
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
                await assertSessionAccountCurrent(sessionId, accountContext);
                return await resolveInactiveConnectedServiceSessionContext({
                  token: sessionCredentials.token,
                  credentials: sessionCredentials,
                  sessionId,
                  currentMachineId: params.machineId,
                });
              },
              api: sessionApi,
              qualifiedConnectedAccountApi:
                accountContext?.qualifiedConnectedAccountApi ??
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
                persistedSessionMetadata: inactivePersistedSessionMetadata,
                cwd: inactiveCwd,
                candidatePersistedSessionFile:
                  inactiveCandidatePersistedSessionFile,
              }) => {
                const persistedSessionMetadata = tracked
                  ? await readPersistedConnectedServiceSwitchSessionMetadata(
                      sessionId,
                    )
                  : inactivePersistedSessionMetadata ?? null;
                const continuityContext =
                  resolveTrackedConnectedServiceSwitchContinuityContext({
                    agentId,
                    baseDir:
                      accountContext?.connectedServicesMaterializationBaseDir ??
                      params.connectedServicesMaterializationBaseDir,
                    tracked,
                    persistedSessionMetadata,
                    connectedServiceMaterializationIdentityV1,
                    vendorResumeId,
                    runtimeAuthSelection,
                    cwd: inactiveCwd,
                    candidatePersistedSessionFile:
                      inactiveCandidatePersistedSessionFile ?? null,
                  });
                return await resolveSessionConnectedServiceSwitchContinuity({
                  sessionId,
                  agentId,
                  serviceId,
                  previousBinding: previous,
                  nextBinding: next,
                  tracked,
                  connectedServiceMaterializationIdentityV1:
                    continuityContext.connectedServiceMaterializationIdentityV1,
                  vendorResumeId: continuityContext.vendorResumeId,
                  fromBindingsRaw: tracked
                    ? (resolveTrackedConnectedServiceBindingsRaw(tracked) ??
                      previousBindings)
                    : previousBindings,
                  toBindings: normalizedBindings,
                  accountSettings: readSessionSettings(),
                  targetMaterializedRoot:
                    continuityContext.targetMaterializedRoot,
                  targetMaterializedEnv: continuityContext.targetMaterializedEnv,
                  cwd: continuityContext.cwd,
                  runtimeDescriptorV1: continuityContext.runtimeDescriptorV1,
                  candidatePersistedSessionFile:
                    continuityContext.candidatePersistedSessionFile,
                  ...(runtimeAuthSelection === undefined
                    ? {}
                    : { runtimeAuthSelection }),
                });
              },
              materializeRuntimeAuthSelection: async (materializerInput) => {
                await assertSessionAccountCurrent(
                  materializerInput.sessionId,
                  accountContext,
                );
                return await materializeSessionConnectedServiceRuntimeAuthSelection(
                  {
                    credentials: sessionCredentials,
                    api: sessionApi,
                    activeServerDir:
                      accountContext?.activeServerDir ??
                      configuration.activeServerDir,
                    baseDir: accountContext?.connectedServicesMaterializationBaseDir ?? params.connectedServicesMaterializationBaseDir,
                    connectedAccountsOwner: accountContext?.connectedAccountsOwner,
                    activatePurposeBindings: accountContext?.activatePurposeBindings ?? params.activatePurposeBindings,
                    validateGroupMutationCurrentness: group => validateConnectedServiceGroupMutationCurrentness(group, materializerInput.sessionId),
                    input: materializerInput,
                    accountSettings: readSessionSettings(),
                    processEnv: params.processEnv,
                    allowNativeAccountState: accountContext === null,
                    isCurrent: async () => {
                      await assertSessionAccountCurrent(
                        materializerInput.sessionId,
                        accountContext,
                      );
                      return true;
                    },
                  },
                );
              },
              restartSession: async (tracked) => {
                const serviceIds = Object.keys(
                  input.bindings.bindingsByServiceId,
                );
                const primaryServiceId = serviceIds[0] ?? '';
                const primaryBinding = primaryServiceId
                  ? input.bindings.bindingsByServiceId[primaryServiceId]
                  : null;
                const primaryGeneration = primaryServiceId
                  ? input.expectedGroupGenerationByServiceId?.[primaryServiceId]
                  : undefined;
                const restartSignalDelayMs = resolvePositiveIntEnv(
                  params.processEnv
                    .HAPPIER_CONNECTED_SERVICES_AUTH_SWITCH_RESTART_SIGNAL_DELAY_MS,
                  250,
                  { min: 0, max: 5_000 },
                );
                // Manual restart-resume fallback (hot-apply ineligible) is gated
                // through deferral and spawn-time reachability.
                return await requestConnectedServiceRestartWithDeferral({
                  sessionId: input.sessionId,
                  tracked,
                  source: 'manual',
                  policy: 'defer_until_turn_boundary',
                  target: normalizeSwitchTarget({
                    serviceId: primaryServiceId,
                    profileId:
                      primaryBinding?.source === 'connected'
                        ? primaryBinding.profileId
                        : '',
                    groupId:
                      primaryBinding?.source === 'connected' &&
                      primaryBinding.selection === 'group'
                        ? primaryBinding.groupId
                        : '',
                    generation:
                      typeof primaryGeneration === 'number' &&
                      Number.isFinite(primaryGeneration)
                        ? Math.max(0, Math.trunc(primaryGeneration))
                        : 0,
                  }),
                  restartSignalDelayMs,
                  restartDiagnostic: buildManualSwitchRestartDiagnostic({
                    sessionId: input.sessionId,
                    agentId: input.agentId,
                    bindings: input.bindings,
                  }),
                  onSignalFailureLogMessage:
                    '[DAEMON RUN] Failed to restart connected-service auth-switched session',
                });
              },
              persistSessionBindings: async ({
                sessionId,
                normalizedBindings,
                connectedServiceMaterializationIdentityV1,
              }) => {
                await assertSessionAccountCurrent(sessionId, accountContext);
                const tracked = findTrackedSessionByHappySessionId(
                  params.pidToTrackedSession.values(),
                  sessionId,
                );
                const bindingIntents =
                  selectConnectedServiceCredentialBindingIntentsForPersist({
                    normalizedBindings,
                    next: input.teamCredentialBindings,
                    previous: input.previousTeamCredentialBindings,
                  });
                await persistSessionConnectedServiceBindings({
                  token: sessionCredentials.token,
                  credentials: sessionCredentials,
                  sessionId,
                  normalizedBindings,
                  ...(bindingIntents.intents
                    ? { teamCredentialBindings: bindingIntents.intents }
                    : {}),
                  ...(bindingIntents.isNext && input.teamVisibilityGrantConsent
                    ? {
                        teamVisibilityGrantConsent:
                          input.teamVisibilityGrantConsent,
                      }
                    : {}),
                  connectedServiceMaterializationIdentityV1:
                    connectedServiceMaterializationIdentityV1 === undefined
                      ? resolveConnectedServiceMaterializationIdentityFromTrackedSession(
                          tracked,
                        )
                      : connectedServiceMaterializationIdentityV1,
                });
                forgetPersistedConnectedServiceSwitchSessionMetadata(sessionId);
              },
              continueAfterRuntimeAuthSwitch:
                createConnectedServiceContinuationHandler({
                  credentials: sessionCredentials,
                  isCurrent: async () => {
                    await assertSessionAccountCurrent(
                      input.sessionId,
                      accountContext,
                    );
                    return true;
                  },
                  interruptedOriginId,
                  resumePromptMode: await resolveContinuationResumePromptMode({
                    readAccountSettings: readSessionSettings,
                  }),
                  customResumePrompt: readContinuationCustomResumePrompt(
                    readSessionSettings(),
                  ),
                  resolveInterruption: ({ sessionId, action, switchReason }) =>
                    resolveConnectedServiceContinuationInterruptionForSwitch({
                      sessionId,
                      interruptedSessionId: input.sessionId,
                      action,
                      switchReason,
                      turnDeferralQueue: connectedServiceTurnDeferralQueue,
                    }),
                }),
              recoverAfterRuntimeAuthSwitch:
                createSelectionPostSwitchRecoveryHandler(),
              verifyProviderAccountAdoption: async (verificationInput) => {
                const result =
                  await verifySessionConnectedServiceAccountAdoption(
                    verificationInput,
                  );
                recordRuntimeAccountIdentityFromVerification({
                  quotaCoordinator: accountContext
                    ? (accountContext.connectedServiceQuotasCoordinator ?? null)
                    : params.getConnectedServiceQuotasCoordinator(),
                  verificationInput,
                  result,
                  observedAtMs: Date.now(),
                });
                return result;
              },
              hotApply: createSessionConnectedServiceAuthHotApply({
                runtimeRegistry: connectedServiceRuntimeRegistry,
                isSessionCurrent: async () => {
                  await assertSessionAccountCurrent(
                    input.sessionId,
                    accountContext,
                  );
                  return true;
                },
                validateGroupMutationCurrentness: (currentness) =>
                  validateConnectedServiceGroupMutationCurrentness(
                    currentness,
                    input.sessionId,
                  ),
              }),
              registerHotApplyTargets: registerHotApplyRuntimeTarget,
              emitSessionEvent: async (sessionId, event) => {
                await commitConnectedServiceAccountSwitchSessionEventWithNotification(
                  {
                    sessionId,
                    event,
                    logContext: 'manual',
                    reasonFallback: 'manual',
                  },
                );
              },
              request: input,
            });
            const resultWithDiagnostics =
              attachConnectedServiceAuthSwitchDiagnostics(result, diagnostics);
            logConnectedServiceAuthSwitchResult({
              sessionId: input.sessionId,
              agentId: input.agentId,
              serviceIds: Object.keys(input.bindings.bindingsByServiceId),
              result: resultWithDiagnostics,
            });
            return resultWithDiagnostics;
          });
        });
      },
      handleSessionConnectedServiceRuntimeAuthRefresh,
      handleSessionRunnerRestart: async (request, options) => {
        const tracked = findTrackedSessionByHappySessionId(
          params.pidToTrackedSession.values(),
          request.sessionId,
        );
        const expectedRunnerProcessIdentity =
          tracked && !('v' in request)
            ? captureRunnerRestartIdentityWitness(tracked)
            : undefined;
        const currentIdentity = resolveCurrentSessionRunnerLaunchIdentity();
        const agentRuntimeCurrentness =
          await resolveTrackedRunnerRuntimeCurrentness(tracked);
        return await restartSessionRunnerOnCurrentRuntime({
          request,
          expectedRunnerProcessIdentity,
          tracked,
          currentIdentity,
          resolveCurrentIdentity: resolveCurrentSessionRunnerLaunchIdentity,
          agentRuntimeVersionState: agentRuntimeCurrentness.versionState,
          agentRuntimeRestartUnavailableReason:
            agentRuntimeCurrentness.restartUnavailableReason,
          resolveAgentRuntimeCurrentness:
            resolveTrackedRunnerRuntimeCurrentness,
          requestRestart: requestSessionRunnerVersionRuntimeRefresh,
          readNativeRuntimeActivity: readSessionRunnerNativeRuntimeActivity,
          ...options,
          resolveActivityDisabledReason:
            resolveSessionRunnerActivity,
          refreshTrackedSessionRuntimeSnapshot:
            refreshTrackedSessionRuntimeSnapshotForPlannedRestart,
        });
      },
      handleSessionRunnerRestartAll: async (request) => {
        return await restartAllSessionRunnersOnCurrentRuntime({
          shouldContinue: () => !isRuntimePublicationQuiescing(),
          mode: request.mode,
          reason: request.reason,
          dryRun: request.dryRun === true,
          currentIdentity: resolveCurrentSessionRunnerLaunchIdentity(),
          resolveCurrentIdentity: resolveCurrentSessionRunnerLaunchIdentity,
          trackedSessions: Array.from(params.pidToTrackedSession.values()),
          requestRestart: requestSessionRunnerVersionRuntimeRefresh,
          readNativeRuntimeActivity: readSessionRunnerNativeRuntimeActivity,
          resolveActivityDisabledReason:
            resolveSessionRunnerActivity,
          resolveAgentRuntimeCurrentness:
            resolveTrackedRunnerRuntimeCurrentness,
          refreshTrackedSessionRuntimeSnapshot:
            refreshTrackedSessionRuntimeSnapshotForPlannedRestart,
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
      handleConnectedServiceRuntimeAuthFailure:
        runConnectedServiceRuntimeAuthFailureRecovery,
      handleConnectedServiceUsageLimitWaitResumeCancel: async (input) =>
        await runtimeAuthRecoveryScheduler.cancelExact(input),
      authorizeConnectedServiceRuntimeAuthFailure: async ({
        sessionId,
        classification,
      }) => {
        return await withSessionAccountContext(sessionId, async (accountContext) =>
          await withSessionAccountHome(accountContext, () =>
            authorizeConnectedServiceRuntimeAuthFailureSource({
              getChildren: () => Array.from(params.pidToTrackedSession.values()),
              resolveInactiveSession: async ({
                sessionId: inactiveSessionId,
              }) => {
                await assertSessionAccountCurrent(
                  inactiveSessionId,
                  accountContext,
                );
                const credentials =
                  accountContext?.bootstrap.credentials ?? params.credentials;
                return await resolveInactiveConnectedServiceSessionContext({
                  token: credentials.token,
                  credentials,
                  sessionId: inactiveSessionId,
                  currentMachineId: params.machineId,
                });
              },
              resolveRegisteredRuntimeAuthFailureSource:
                resolveRegisteredRuntimeAuthFailureSourceForSession,
              resolveCurrentRuntimeAuthFailureSource:
                resolveCurrentRuntimeAuthFailureSourceForSession,
              resolveProviderQualifiedRuntimeAuthFailureSource:
                resolveProviderQualifiedRuntimeAuthFailureSourceForSession,
              sessionId,
              classification,
            }),
          ),
        );
      },
      resolveConnectedServiceRuntimeAuthResumePromptMode: async ({
        sessionId,
        classification,
        explicit,
      }) => {
        return await withSessionAccountContext(sessionId, async (accountContext) => {
          // Scheduler intents are sanitized at load, so the key is canonical here; a
          // stale unparseable key degrades to the caller's explicit/standard prompt mode.
          const serviceKey = readBuiltInLegacyConnectedAccountServiceKeyIngress(
            classification.serviceId,
          );
          if (!serviceKey) return explicit ?? 'standard';
          return await resolveContinuationResumePromptMode({
            serviceId: serviceKey,
            groupId: classification.groupId,
            explicit,
            readAccountSettings: accountContext
              ? () => accountContext.readAccountSettingsSnapshot().settings
              : undefined,
            loadGroupPolicy: classification.groupId
              ? async () =>
                  (
                    await readQualifiedConnectedServiceAuthGroup({
                      sessionId,
                      serviceId: serviceKey,
                      groupId: classification.groupId!,
                    })
                  )?.policy ?? null
              : undefined,
          });
        });
      },
      runtimeAuthRecoveryScheduler,
      handleConnectedServiceTurnLifecycle: async (input) => {
        const lifecycleObservedAtMs = Date.now();
        let pendingSourceCutover =
          pendingRequestAuthSourceCutoverBySessionId.get(input.sessionId) ??
          null;
        if (
          pendingSourceCutover &&
          retirePendingRequestAuthSourceCutoverForCurrentSuccessor(
            pendingSourceCutover,
          )
        ) {
          pendingSourceCutover = null;
        }
        if (pendingSourceCutover && input.event === 'prompt_or_steer') {
          if (!input.requestedAction || input.activeTurnId === undefined) {
            return CONNECTED_SERVICE_TURN_LIFECYCLE_SOURCE_CUTOVER_BLOCK;
          }
          if (input.activeTurnId === null) {
            const idleCustody = await applyTrackedSessionTurnLifecycle({
              trackedSessions: params.pidToTrackedSession.values(),
              sessionId: input.sessionId,
              event: input.event,
              activeTurnIdWitness: null,
            });
            if (idleCustody.status === 'recorded') {
              connectedServiceTurnDeferralQueue.recordTurnLifecycleEvent({
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
            input.requestedAction.kind === 'steer_if_active' ||
            input.requestedAction.kind === 'steer_now';
          const retainedActiveTurnId =
            normalizeOptionalString(
              pendingSourceCutover.tracked.activeTurnId,
            ) ||
            normalizeOptionalString(
              pendingSourceCutover.tracked.reattachedInterruptedTurnId,
            );
          if (!isLiveSteer || retainedActiveTurnId !== input.activeTurnId) {
            return CONNECTED_SERVICE_TURN_LIFECYCLE_SOURCE_CUTOVER_BLOCK;
          }
        }
        const pendingBegin = { sessionId: input.sessionId };
        if (input.turnId && (input.event === 'prompt_or_steer' || input.event === 'task_started')) pendingTurnBegins.add(pendingBegin);
        try {
          const turnCustody = await applyTrackedSessionTurnLifecycle({
            trackedSessions: params.pidToTrackedSession.values(),
            sessionId: input.sessionId,
            event: input.event,
            ...(input.turnId ? { turnId: input.turnId } : {}),
            ...(pendingSourceCutover &&
            input.event === 'prompt_or_steer' &&
            input.activeTurnId !== undefined
              ? {
                  activeTurnIdWitness: input.activeTurnId,
                }
              : {}),
          });
          const acceptsDownstreamLifecycle =
            turnCustody.status === 'recorded' ||
            turnCustody.status === 'ignored_missing_exact_turn';
          if (!acceptsDownstreamLifecycle || controlRuntimeResourcesDisposed) {
            return connectedServiceTurnLifecycleContinue(turnCustody);
          }
          const runtimeTargetAtAcceptance =
            connectedServiceRuntimeRegistry.getBySessionId(input.sessionId) ??
            null;
          // Legacy transcript observations still feed downstream recovery, but
          // only accepted exact turn custody may change foreground activity.
          if (turnCustody.status === 'recorded') {
            connectedServiceTurnDeferralQueue.recordTurnLifecycleEvent({
              sessionId: input.sessionId,
              event: input.event,
            });
          }
          // Exact marker custody is the control response boundary. Provider proof and report-outbox
          // supersession are downstream settlement: keep their established order, but do not let
          // either strand the runner's accepted begin/terminal lifecycle acknowledgement.
          void Promise.resolve()
            .then(async () => {
              if (
                controlRuntimeResourcesDisposed ||
                (runtimeTargetAtAcceptance !== null &&
                  !isCurrentRuntimeGenerationTarget(runtimeTargetAtAcceptance))
              ) {
                return;
              }
              if (
                isProviderActivityTurnLifecycleEvent(
                  input.event,
                  input.terminalStatus,
                )
              ) {
                if (turnCustody.status === 'recorded') {
                  connectedServiceRuntimeAuthSwitchAttempts.recordTurnLifecycle({
                    sessionId: input.sessionId, event: input.event, terminalStatus: input.terminalStatus,
                  });
                  await temporaryThrottleScheduler.recordTurnLifecycle({
                    sessionId: input.sessionId,
                    event: input.event,
                    terminalStatus: input.terminalStatus,
                    observedAtMs: lifecycleObservedAtMs,
                  });
                }
                const providerOutcome = runtimeTargetAtAcceptance
                  ? await verifyProviderActivityOutcome({
                      target: runtimeTargetAtAcceptance,
                      reportedSelectionsEnvRaw:
                        input.connectedServiceSelectionsEnvRaw,
                      event:
                        input.event === 'task_started'
                          ? 'task_started'
                          : 'assistant_message_end',
                    }).catch(() => ({
                      status: 'unavailable' as const,
                      reason: 'provider_outcome_verification_failed',
                    }))
                  : { status: 'unsupported' as const };
                if (
                  controlRuntimeResourcesDisposed ||
                  (runtimeTargetAtAcceptance !== null &&
                    !isCurrentRuntimeGenerationTarget(runtimeTargetAtAcceptance))
                ) {
                  return;
                }
                await recordConnectedServiceContinuationProviderActivity({
                  sessionId: input.sessionId,
                  observedAtMs: lifecycleObservedAtMs,
                  ...(providerOutcome.status === 'unsupported'
                    ? {}
                    : {
                        providerOutcomeTargets:
                          providerOutcome.status === 'verified'
                            ? providerOutcome.targets
                            : [],
                      }),
                });
              }
              if (
                controlRuntimeResourcesDisposed ||
                (runtimeTargetAtAcceptance !== null &&
                  !isCurrentRuntimeGenerationTarget(runtimeTargetAtAcceptance))
              ) {
                return;
              }
              // Runtime-auth report-outbox supersession remains owned by its canonical cleaner.
              await connectedServiceRecoverySupersessionCleaner({
                sessionId: input.sessionId,
                event: {
                  kind: 'turn_lifecycle',
                  event: input.event,
                  ...(input.terminalStatus
                    ? { terminalStatus: input.terminalStatus }
                    : {}),
                },
                updatedBeforeMs: lifecycleObservedAtMs,
              });
            })
            .catch((error) => {
              logger.debug(
                '[DAEMON RUN] Connected-service turn lifecycle downstream settlement failed after custody (non-fatal)',
                {
                  sessionId: input.sessionId,
                  event: input.event,
                  error: serializeAxiosErrorForLog(error),
                },
              );
            });
          if (
            pendingSourceCutover &&
            turnCustody.status === 'recorded' &&
            (input.event === 'assistant_message_end' ||
              input.event === 'turn_cancelled')
          ) {
            await requestPendingRequestAuthSourceCutoverAtBoundary(
              pendingSourceCutover,
            );
          }
          return connectedServiceTurnLifecycleContinue(turnCustody);
        } finally {
          pendingTurnBegins.delete(pendingBegin);
        }
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
        const accountContext = await resolveSessionAccountContext(
          input.sessionId,
        );
        let releaseAfterReceipt = true;
        try {
          await assertSessionAccountCurrent(input.sessionId, accountContext);
          return await withSessionAccountHome(accountContext, async () => {
            let claimedSource: typeof input.source | null = input.source;
            if (
              input.sourceProviderAccountId === undefined &&
              claimedSource?.bindingKind === 'group_member' &&
              input.snapshot.accountSubject.kind === 'providerSubject'
            ) {
              const groupSource = claimedSource;
              claimedSource = await resolveProviderAccountUsageSourceProfile({
                source: groupSource,
                providerAccountId: input.snapshot.accountSubject.id,
                providerOrganizationId: input.snapshot.recordKey.quotaScope === 'organization'
                  ? input.snapshot.recordKey.quotaScopeId ?? null : null,
                getCurrentGroup: async () => {
                  await assertSessionAccountCurrent(
                    input.sessionId,
                    accountContext,
                  );
                  const group = await readQualifiedConnectedServiceAuthGroup({
                    serviceId: groupSource.serviceId,
                    groupId: groupSource.groupId,
                    sessionId: input.sessionId,
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
                resolveProviderAccountIdentity: async (profileId) => {
                  const service = resolveQualifiedConnectedAccountServiceForIngressServiceId(groupSource.serviceId);
                  if (!service) return null;
                  const material = await readQualifiedConnectedAccountCredentialMaterial({
                    credentials: accountContext?.bootstrap.credentials ?? params.credentials,
                    account: { service, accountId: profileId },
                    requestPurpose: 'connected-accounts:auth-group',
                    getAccountEncryptionMode: (signal) => resolveConnectedServiceAccountMode(accountContext?.api ?? params.api, { signal }),
                  });
                  return material ? readQualifiedConnectedAccountCredentialIdentity(material) : null;
                },
              });
            }
            const capturedClaimedSource = claimedSource;
            const shouldResolveSourceCredential =
              capturedClaimedSource &&
              (input.deriveCredentialFingerprintFromSource === true ||
                input.credentialFingerprint !== undefined);
            const sourceForCredential = shouldResolveSourceCredential
              ? capturedClaimedSource
              : null;
            const sourceCredentialLegacyServiceId = sourceForCredential
              ? resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
                  sourceForCredential.serviceId,
                )
              : null;
            const sourceCredentialResolution =
              sourceForCredential && sourceCredentialLegacyServiceId
                ? await resolveConnectedServiceCredentialResolutions({
                    credentials:
                      accountContext?.bootstrap.credentials ?? params.credentials,
                    api: accountContext?.api ?? params.api,
                    bindings: [
                      {
                        serviceId: sourceCredentialLegacyServiceId,
                        profileId: sourceForCredential.profileId,
                      },
                    ],
                  }).then(
                    (byServiceId) =>
                      byServiceId.get(sourceCredentialLegacyServiceId) ?? null,
                  )
                : null;
            const sourceCredentialRecord =
              sourceCredentialResolution?.revisionSemantics === 'revisioned'
                ? sourceCredentialResolution.record
                : null;
            const credentialFingerprint =
              capturedClaimedSource &&
              input.deriveCredentialFingerprintFromSource === true &&
              input.credentialFingerprint === undefined
                ? sourceCredentialRecord?.kind === 'oauth'
                  ? computeConnectedServiceAccessTokenFingerprint(
                      sourceCredentialRecord.oauth.accessToken,
                    )
                  : null
                : input.credentialFingerprint;
            const result = await recordProviderAccountUsageSnapshotForSession({
              getChildren: () => Array.from(params.pidToTrackedSession.values()),
              store:
                accountContext?.providerAccountUsageStore ??
                providerAccountUsageStore,
              persistence: accountContext
                ? accountContext.providerAccountUsagePersistence
                : providerAccountUsagePersistence,
              ...(capturedClaimedSource
                ? { observation: { sources: [capturedClaimedSource] as const } }
                : {}),
              credentialFingerprint,
              sourceProviderAccountId: input.sourceProviderAccountId,
              requiresProviderOrganizationId: input.source
                ? (await resolveConnectedAccountUsageIdentity(input.source.serviceId))?.requiredContext === 'organization' : false,
              verifyCredentialFingerprint: async (candidate) => {
                const serviceId = ConnectedAccountServiceKeySchema.safeParse(
                  readBuiltInLegacyConnectedAccountServiceKeyIngress(
                    candidate.serviceId,
                  ),
                );
                const claimedServiceId =
                  readBuiltInLegacyConnectedAccountServiceKeyIngress(
                    capturedClaimedSource?.serviceId,
                  );
                if (!serviceId.success) return false;
                if (
                  claimedServiceId !== serviceId.data ||
                  capturedClaimedSource?.profileId !== candidate.profileId ||
                  sourceCredentialResolution?.revisionSemantics !== 'revisioned'
                ) {
                  return false;
                }
                const record = sourceCredentialResolution.record;
                return matchesCurrentQuotaObservationCredential({
                  ...candidate,
                  credential: record?.kind === 'oauth' ? {
                    providerAccountId: record.oauth.providerAccountId,
                    providerOrganizationId: sourceCredentialResolution.providerOrganizationId ?? null,
                    credentialFingerprint: computeConnectedServiceAccessTokenFingerprint(record.oauth.accessToken),
                  } : null,
                });
              },
              resolveAuthoritativeSource: async (source) => {
                const currentBinding =
                  connectedServiceRuntimeRegistry
                    .getBySessionId(input.sessionId)
                    ?.activeBindings.find(
                      (binding) => binding.serviceId === source.serviceId,
                    ) ?? null;
                if (
                  !currentBinding ||
                  currentBinding.profileId !== source.profileId
                )
                  return null;
                return currentBinding.groupId === null
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
              },
              resolvePersistenceTargets:
                resolveQualifiedProviderAccountUsagePersistenceTargets,
              publishRecordId: async ({ sessionId, recordId }) => {
                await assertSessionAccountCurrent(sessionId, accountContext);
                return await publishProviderAccountUsageRecordIdToSessionMetadata(
                  {
                    token:
                      accountContext?.bootstrap.credentials.token ??
                      params.credentials.token,
                    credentials:
                      accountContext?.bootstrap.credentials ?? params.credentials,
                    sessionId,
                    recordId,
                  },
                );
              },
              sessionId: input.sessionId,
              snapshot: input.snapshot,
            });
            const qualifiedUsageSource = 'qualifiedSource' in result ? result.qualifiedSource ?? null : null;
            const verifiedLocalSource = 'verifiedLocalSource' in result ? result.verifiedLocalSource ?? null : null;
            const verifiedSourceProviderAccountId = 'sourceProviderAccountId' in result ? result.sourceProviderAccountId ?? null : null;
            // Transport custody ends at the canonical recorder and persistence scheduler.
            // Policy fanout and recovery proof are downstream settlement and cannot delay receipt.
            void Promise.resolve()
              .then(async () => {
                await assertSessionAccountCurrent(
                  input.sessionId,
                  accountContext,
                );
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
                  isProviderAccountUsageStoreMutationAccepted(result) &&
                  (verifiedLocalSource || qualifiedUsageSource) &&
                  credentialFingerprint
                ) {
                  const source = verifiedLocalSource ?? qualifiedUsageSource!;
                  const observedProviderAccountId = verifiedSourceProviderAccountId
                    ?? (input.snapshot.accountSubject.kind === 'providerSubject' ? input.snapshot.accountSubject.id : null);
                  const serviceId = ConnectedAccountServiceKeySchema.safeParse(
                    readBuiltInLegacyConnectedAccountServiceKeyIngress(
                      source.serviceId,
                    ),
                  );
                  const legacyServiceId = serviceId.success
                    ? resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(
                        serviceId.data,
                      )
                    : null;
                  const claimedServiceId =
                    readBuiltInLegacyConnectedAccountServiceKeyIngress(
                      capturedClaimedSource?.serviceId,
                    );
                  const coordinator = accountContext
                    ? accountContext.connectedServiceQuotasCoordinator
                    : params.getConnectedServiceQuotasCoordinator();
                  const projection = legacyServiceId
                    ? projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1(
                        {
                          snapshot: input.snapshot,
                          source,
                        },
                      )
                    : null;
                  const projected = projection && verifiedSourceProviderAccountId
                    ? { ...projection, activeAccountId: verifiedSourceProviderAccountId }
                    : projection;
                  const credentialResolution =
                    serviceId.success &&
                    claimedServiceId === serviceId.data &&
                    capturedClaimedSource?.profileId === source.profileId
                      ? sourceCredentialResolution
                      : null;
                  const credential = credentialResolution?.record ?? null;
                  sourceIsExactlyCurrent = credentialResolution?.revisionSemantics === 'revisioned'
                    && matchesCurrentQuotaObservationCredential({
                      providerAccountId: observedProviderAccountId ?? '',
                      providerOrganizationId: input.snapshot.recordKey.quotaScope === 'organization'
                        ? input.snapshot.recordKey.quotaScopeId ?? null : null,
                      credentialFingerprint,
                      credential: credential?.kind === 'oauth' ? {
                        providerAccountId: credential.oauth.providerAccountId,
                        providerOrganizationId: credentialResolution.providerOrganizationId ?? null,
                        credentialFingerprint: computeConnectedServiceAccessTokenFingerprint(credential.oauth.accessToken),
                      } : null,
                    });
                  if (
                    serviceId.success &&
                    legacyServiceId &&
                    coordinator &&
                    projected &&
                    credentialResolution &&
                    credential?.kind === 'oauth' &&
                    sourceIsExactlyCurrent
                  ) {
                    const groupId =
                      source.bindingKind === 'group_member'
                        ? (source.groupId ?? null)
                        : null;
                    const groupGeneration =
                      source.bindingKind === 'group_member'
                        ? (source.groupGeneration ?? null)
                        : null;
                    if (verifiedLocalSource) {
                      coordinator.recordRuntimeProfileSnapshot({
                        serviceId: serviceId.data,
                        profileId: source.profileId,
                        snapshot: { ...projected, serviceId: legacyServiceId },
                        verifiedCredentialFingerprint: credentialFingerprint,
                      });
                    }
                    const proof = coordinator.resolveQuotaProbeFreshProof({
                      serviceId: legacyServiceId,
                      profileId: source.profileId,
                      expectedAppliedIdentity: {
                        serviceId: legacyServiceId,
                        profileId: source.profileId,
                        groupId,
                        groupGeneration,
                        providerAccountId: credential.oauth.providerAccountId,
                        materialFingerprint:
                          computeConnectedServiceAccessTokenFingerprint(
                            credential.oauth.accessToken,
                          ),
                      },
                      snapshotAppliedIdentity: {
                        serviceId: legacyServiceId,
                        profileId: source.profileId,
                        groupId,
                        groupGeneration,
                        providerAccountId: observedProviderAccountId ?? '',
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
                        credentialRevision:
                          credentialResolution.credentialRevision,
                        observedAtMs: input.snapshot.observedAtMs,
                      };
                    }
                  }
                }
                if (
                  sourceIsExactlyCurrent &&
                  isProviderAccountUsageStoreMutationAccepted(result) &&
                  'recordId' in result &&
                  qualifiedUsageSource &&
                  qualifiedUsageSource.bindingKind === 'group_member' &&
                  qualifiedUsageSource.groupId &&
                  qualifiedUsageSource.groupGeneration !== undefined
                ) {
                  const snapshot = (
                    accountContext?.providerAccountUsageStore ??
                    providerAccountUsageStore
                  ).resolveRecordId(result.recordId);
                  if (snapshot) {
                    await assertSessionAccountCurrent(
                      input.sessionId,
                      accountContext,
                    );
                    await (
                      accountContext
                        ? accountContext.connectedServiceQuotasCoordinator
                        : params.getConnectedServiceQuotasCoordinator()
                    )?.handleAccountUsageChanged?.({
                      sessionId: input.sessionId,
                      serviceId: qualifiedUsageSource.serviceId,
                      profileId: qualifiedUsageSource.profileId,
                      groupId: qualifiedUsageSource.groupId,
                      groupGeneration: qualifiedUsageSource.groupGeneration,
                      recordId: result.recordId,
                      snapshot,
                      source:
                        input.policyDisposition === 'evidence_only'
                          ? 'evidence_only'
                          : 'in_band',
                    });
                  }
                }
                if (quotaProof) {
                  await runtimeAuthRecoveryScheduler
                    .markProviderOutcomeProofByIdentity(quotaProof)
                    .catch(() => []);
                }
              })
              .finally(() => releaseSessionAccountContext(accountContext))
              .catch((error) => {
                logger.debug(
                  '[DAEMON RUN] Provider account-usage downstream settlement failed after custody (non-fatal)',
                  {
                    error: serializeAxiosErrorForLog(error),
                  },
                );
              });
            releaseAfterReceipt = false;
            return result;
          });
        } finally {
          if (releaseAfterReceipt) await releaseSessionAccountContext(accountContext);
        }
      },
      handleProviderAccountUsageAdoption: async (input) => {
        return await withSessionAccountContext(input.sessionId, async (accountContext) => {
          await assertSessionAccountCurrent(input.sessionId, accountContext);
          return await withSessionAccountHome(accountContext, () =>
            recordProviderAccountUsageAdoptionForSession({
              getChildren: () => Array.from(params.pidToTrackedSession.values()),
              store:
                accountContext?.providerAccountUsageStore ??
                providerAccountUsageStore,
              persistence: accountContext
                ? accountContext.providerAccountUsagePersistence
                : providerAccountUsagePersistence,
              resolvePersistenceTargets:
                resolveQualifiedProviderAccountUsagePersistenceTargets,
              publishRecordId: async ({ sessionId, recordId }) => {
                await assertSessionAccountCurrent(sessionId, accountContext);
                return await publishProviderAccountUsageRecordIdToSessionMetadata(
                  {
                    token:
                      accountContext?.bootstrap.credentials.token ??
                      params.credentials.token,
                    credentials:
                      accountContext?.bootstrap.credentials ?? params.credentials,
                    sessionId,
                    recordId,
                  },
                );
              },
              sessionId: input.sessionId,
              adoption: input.adoption,
            }),
          );
        });
      },
      controlToken,
      // Execution-run bridge endpoints accept only the scoped run-materialize capability token.
      verifyRunMaterializeToken: (provided) =>
        isValidConnectedServiceRunMaterializeToken(provided, controlToken),
      readAppliedSessionConnectedServices: async (input) => {
        const startedAt = performance.now();
        let phaseStartedAt = startedAt;
        let phase = 'tracked_runner';
        const recordPhase = (completedPhase: string): void => {
          const now = performance.now();
          logger.info('[DAEMON RUN] Applied parent selection phase', {
            phase: completedPhase, runnerPid: input.runnerPid, initialEmpty: input.initialEmpty === true,
            durationMs: Math.round(now - phaseStartedAt), elapsedMs: Math.round(now - startedAt),
          });
          phaseStartedAt = now;
        };
        recordPhase('entered');
        const resolveTracked = () => params.pidToTrackedSession.get(input.runnerPid)
          ?? findTrackedSessionByRunnerPid(params.pidToTrackedSession, input.runnerPid);
        const tracked = resolveTracked();
        if (!tracked || tracked.happySessionId !== input.sessionId
          || resolveTrackedSessionCatalogAgentId(tracked) !== input.agentId) return { status: 'unavailable' };
        try {
          phase = 'account_context';
          return await withSessionAccountContext(input.sessionId, async (accountContext) => {
            recordPhase(phase);
            phase = 'account_currentness_before_presence';
            await assertSessionAccountCurrent(input.sessionId, accountContext);
            recordPhase(phase);
            phase = 'runner_presence';
            if (!await isSessionRunnerActiveInDaemon({ sessionId: input.sessionId, trackedSessions: [tracked] })) {
              recordPhase(phase);
              return { status: 'unavailable' as const };
            }
            recordPhase(phase);
            phase = 'account_currentness_after_presence';
            await assertSessionAccountCurrent(input.sessionId, accountContext);
            recordPhase(phase);
            if (resolveTracked() !== tracked) return { status: 'unavailable' as const };
            return await withSessionAccountHome(accountContext, async () => {
              // The runner invokes this only once, after its accepted open proves
              // there are no applied CS accounts or selection environment. Later
              // reads never recreate a target invalidated by a partial hot apply.
              if (input.initialEmpty && !connectedServiceRuntimeRegistry.getByPid(tracked.pid)) {
                connectedServiceRuntimeRegistry.registerTarget({
                  pid: tracked.pid, sessionId: input.sessionId, agentId: input.agentId,
                  sessionDirectory: tracked.spawnOptions?.directory,
                  connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: {} },
                  connectedServiceSelectionsEnv: {},
                  ...(tracked.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: tracked.requesterWorkAttributionV1 } : {}),
                });
              }
              return connectedServiceRuntimeRegistry.readAppliedSessionBindings(input, tracked);
            });
          });
        } catch {
          logger.info('[DAEMON RUN] Applied parent selection unavailable', {
            phase, runnerPid: input.runnerPid, initialEmpty: input.initialEmpty === true,
            elapsedMs: Math.round(performance.now() - startedAt),
          });
          return { status: 'unavailable' };
        }
      },
      materializeConnectedServicesForExecutionRun:
        executionRunConnectedServicesBridge.materialize,
      recoverConnectedServicesRejectedStartForExecutionRun:
        executionRunConnectedServicesBridge.recoverRejectedStart,
      recoverConnectedServiceRuntimeFailureForExecutionRun:
        executionRunConnectedServicesBridge.recoverRuntimeFailure,
      completeConnectedServiceRuntimeTurnForExecutionRun:
        executionRunConnectedServicesBridge.completeRuntimeTurn,
      refreshConnectedServiceRuntimeAuthForExecutionRun:
        executionRunConnectedServicesBridge.refreshRuntimeAuth,
      checkConnectedServicesGenerationForExecutionRun: async ({
        runId,
        runnerPid,
        registration,
      }) => {
        let target =
          connectedServiceRuntimeRegistry.getRunTargetByRunKey(runId);
        if (!target && registration) {
          await reattestRunningExecutionRunConnectedServices({
            markers: listExecutionRunMarkersForRehydration,
            runId,
            runnerPid,
            registration,
            adopt: executionRunConnectedServicesBridge.adoptLiveMaterialization,
            proveRunnerLive: async (marker) => {
              if (marker.happySessionId === null) return false;
              const tracked = params.pidToTrackedSession.get(marker.pid);
              if (!tracked || tracked.happySessionId !== marker.happySessionId)
                return false;
              return await isSessionRunnerActiveInDaemon({
                sessionId: marker.happySessionId,
                trackedSessions: [tracked],
              });
            },
          }).catch(() => false);
          target = connectedServiceRuntimeRegistry.getRunTargetByRunKey(runId);
        }
        if (
          !target ||
          target.pid !== runnerPid ||
          target.materializationKey !== runId
        ) {
          return { ok: true as const, current: false };
        }
        const sessionId = target.sessionId;
        if (sessionId === null) {
          const owner = await captureExecutionRunConnectedServicesRunnerIdentity({ runnerPid, runId });
          if (!owner?.isCurrent()) return { ok: true as const, current: false };
        }
        let operationEntered = false;
        try {
          return await withSessionAccountContext(sessionId, async (accountContext) => {
            operationEntered = true;
            let projection: ConnectedServiceProjectionSnapshot;
            try {
              await assertSessionAccountCurrent(sessionId, accountContext);
              projection = accountContext
                ? await fetchConnectedServiceProjectionSnapshot(
                    undefined,
                    sessionId ?? undefined,
                  )
                : (latestConnectedServiceProjectionSnapshot ??
                  (await fetchConnectedServiceProjectionSnapshot()));
              await assertSessionAccountCurrent(sessionId, accountContext);
            } catch {
              return { ok: true as const, current: false };
            }
            const currentTarget =
              connectedServiceRuntimeRegistry.getRunTargetByRunKey(runId);
            if (
              currentTarget !== target ||
              currentTarget.pid !== runnerPid ||
              currentTarget.materializationKey !== runId
            ) {
              return { ok: true as const, current: false };
            }
            return {
              ok: true as const,
              current: isExecutionRunConnectedServiceGenerationCurrent({
                runId,
                target,
                projection,
              }),
            };
          });
        } catch (error) {
          if (operationEntered) throw error;
          return { ok: true as const, current: false };
        }
      },
      releaseConnectedServicesForExecutionRun:
        executionRunConnectedServicesBridge.release,
    });
  foregroundAgentRuntimeHttpPort = controlPort;
  connectedAccountRequestAuthHttpPort = controlPort;
  params.onConnectedAccountRequestAuthHttpPortReady?.(controlPort);
  const reattachedAuthorityRefreshes = await Promise.allSettled(
    [...params.pidToTrackedSession.values()]
      .filter(
        (tracked) =>
          tracked.reattachedFromDiskMarker === true &&
          Boolean(
            normalizeOptionalString(tracked.happySessionId) &&
            tracked.agentRuntimeDaemonServiceAuthorityFilePath,
          ),
      )
      .map(async (tracked) => {
        const sessionId = normalizeOptionalString(tracked.happySessionId);
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
      if (!tracked || tracked.happySessionId !== marker.happySessionId)
        return false;
      return await isSessionRunnerActiveInDaemon({
        sessionId: marker.happySessionId,
        trackedSessions: [tracked],
      });
    },
  }).catch((error) => {
    logger.debug(
      '[DAEMON RUN] Passive execution-run target re-registration failed (non-fatal)',
      error,
    );
  });
  await recoverReattachedAgentRequestAuth();
  const reattachedRuntimeTargets = connectedServiceRuntimeRegistry
    .listTargets()
    .filter((target) => !connectedServiceRuntimeRegistry.isRunTarget(target));
  const initialRuntimeTargetGenerationReconciliation = Promise.allSettled(
    reattachedRuntimeTargets.map((target) =>
      scheduleRuntimeTargetGenerationReconciliation(
        target,
        undefined,
        false,
        false,
      ),
    ),
  );
  void initialRuntimeTargetGenerationReconciliation.then((outcomes) => {
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        logger.debug(
          '[DAEMON RUN] Failed to reconcile connected-service provider adoption after daemon replacement',
          {
            error: serializeAxiosErrorForLog(outcome.reason),
          },
        );
      }
    }
  });
  let reattachedCredentialProjectionReconciliation: Promise<void> | null = null;
  const reconcileReattachedConnectedServiceCredentialProjection =
    (): Promise<void> => {
      if (reattachedCredentialProjectionReconciliation) {
        return reattachedCredentialProjectionReconciliation;
      }
      reattachedCredentialProjectionReconciliation = (async () => {
        const initialReconciliationOutcomes =
          await initialRuntimeTargetGenerationReconciliation;
        const currentTargets = reattachedRuntimeTargets.filter(
          (target) =>
            isCurrentRuntimeGenerationTarget(target) &&
            ownedConnectedServiceRuntimeRegistry.isSessionTarget(target),
        );
        if (currentTargets.length === 0) return;
        const projectionSnapshot =
          await fetchConnectedServiceProjectionSnapshot();
        await reconcileDirectCredentialProjectionForTargets(
          projectionSnapshot,
          currentTargets,
          'passive_projection',
        );
        if (latestConnectedServiceProjectionSnapshot !== projectionSnapshot)
          return;
        for (const [index, target] of reattachedRuntimeTargets.entries()) {
          if (initialReconciliationOutcomes[index]?.status !== 'fulfilled') {
            continue;
          }
          if (
            isCurrentRuntimeGenerationTarget(target) &&
            ownedConnectedServiceRuntimeRegistry.isSessionTarget(target)
          ) {
            reconciledProjectionByRuntimeTarget.set(target, projectionSnapshot);
          }
        }
      })();
      return reattachedCredentialProjectionReconciliation;
    };
  const stopControlServerWithConnectedServiceDeferralCleanup =
    async (): Promise<void> => {
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
      connectedServiceCredentialRevisionsV1:
        notification.connectedServiceCredentialRevisionsV1,
    });
    notification.signal.throwIfAborted();
    await publishObservedConnectedServiceProjectionThenApply({
      projection: projectionSnapshot,
      publishObserved: replaceConnectedServiceProjectionSnapshot,
      applyToRuntime: async () => {
        const changedServiceIds = notification.connectedServiceRefs === undefined
          ? null
          : new Set(notification.connectedServiceRefs.map(buildQualifiedPluginContributionKey));
        const affectedTargets = ownedConnectedServiceRuntimeRegistry.listTargets().filter((target) => (
          changedServiceIds === null
          || parseConnectedServiceBindingSelections(target.connectedServicesBindingsRaw)
            .some((selection) => changedServiceIds.has(selection.serviceId))
          || target.activeBindings.some((binding) => changedServiceIds.has(binding.serviceId))
        ));
        await Promise.all(
          affectedTargets.map(async (target) => {
            await scheduleRuntimeTargetGenerationReconciliation(target);
          }),
        );
        notification.signal.throwIfAborted();
        await reconcileDirectCredentialProjectionForTargets(
          projectionSnapshot,
          affectedTargets.filter((target) =>
            connectedServiceRuntimeRegistry.isRunTarget(target),
          ),
          notification.executionAuthority,
          notification.signal,
        );
        notification.signal.throwIfAborted();
      },
    });
  };
  processActionOwnerAdapters = createProcessActionOwnerAdapters({
    readServiceTargets: () => pluginRuntimeController.getState().activeRegistry?.projectManagedServices.readResourceTargets() ?? [],
    readBrowsers: () => guardBrowserResourceOwner?.readResourceTargets?.() ?? [],
    startService: localServicesRuntime.launcherRoutes.startTarget,
    getBrowserAdapter: () => guardBrowserResourceOwner?.adapter ?? null,
    refreshInventory: localServicesRuntime.refreshInventoryNow,
    terminateDetectedService: localServicesRuntime.terminateDetectedService,
  });
  const executeGuardLeftBehindAction = createGuardLeftBehindActionExecutor({
    readContext: async signal => {
      const currentApi = params.getApiMachineForSessions();
      if (isRuntimePublicationQuiescing() || !currentApi || !externalActionInstallationIdentity || !externalActionAccountId) return null;
      const readSignal = signal ?? new AbortController().signal;
      const runtime = await currentApi.resolveInstalledAccountObservationRuntime(readSignal);
      const origin = await params.resolveCurrentMachineExecutionOriginContext?.(readSignal);
      if (!runtime || runtime.serverId !== params.serverId || runtime.machineId !== params.machineId
        || runtime.accountId !== externalActionAccountId || !sameStoredCredentials(runtime.credentials, params.credentials)
        || !origin || origin.machineId !== params.machineId) return null;
      const verifyCurrent = async () => {
        const installation = readInstallationIdentityIfExistsSync();
        const freshOrigin = await params.resolveCurrentMachineExecutionOriginContext?.(readSignal);
        return !isRuntimePublicationQuiescing() && !readSignal.aborted && params.getApiMachineForSessions() === currentApi
          && Boolean(await runtime.isCurrent?.())
          && installation?.installationId === externalActionInstallationIdentity.installationId
          && Buffer.from(installation.privateKey).equals(Buffer.from(externalActionInstallationIdentity.privateKey))
          && freshOrigin?.machineId === params.machineId && freshOrigin.serverIdentityId === origin.serverIdentityId;
      };
      if (!await verifyCurrent()) return null;
      return { authority: 'account_automation', surface: 'rpc', actionCaller: { kind: 'host' },
        serverId: params.serverId, serverIdentityId: origin.serverIdentityId, runtimeAccountId: runtime.accountId,
        actionRequestId: randomUUID(), defaultSessionMachineId: params.machineId,
        externalActionTarget: { kind: 'machine', machineId: params.machineId },
        machineAdmission: { actorAccountId: runtime.accountId, custodianAccountId: externalActionAccountId,
          machineId: params.machineId, installationId: externalActionInstallationIdentity.installationId,
          role: 'manage', encryptionMode: currentApi.getMachineEncryptionMode() },
        verifyMachineAdmissionCurrent: verifyCurrent, ...(signal ? { signal } : {}) };
    },
    getExecutor: context => {
      const operationId = context.operationAcceptance?.actionId === 'machines.processes.leftBehind.cleanUp'
        ? context.operationAcceptance.operationId : null;
      return createExternalActionExecutor(params.credentials, undefined, undefined, undefined, undefined,
        operationId && context.signal && context.operationOwnerUpdate
          ? { hostActionApprovalLifetime: { operationId, signal: context.signal } } : undefined);
    },
    observeExecution: async request => {
      const currentApi = params.getApiMachineForSessions();
      if (!currentApi) return { ok: false, errorCode: 'scope-retired', error: 'scope-retired' };
      return await currentApi.observeActionExecution(request);
    },
  });
  return {
    executeGuardLeftBehindAction,
    resolveExecutionRunLiveBrokerAuthority,
    sessionLiveWorkProducer,
    dispatchSessionFollowOccurrence,
    processActionOwnerAdapters,
    readManagedServiceCurrentLogPaths: () => managedServiceDurabilityOwner!.getCurrentLogPaths(),
    retryOrphanedManagedServices: async () => {
      if (isRuntimePublicationQuiescing()) return;
      const retiredPids = await managedServiceDurabilityOwner!.retireEndedSessionRunnerOwnedProjections({ processOwnership: processOwnershipRuntime });
      if (retiredPids.length) logger.infoFile('[DAEMON RUN] Retired retained managed services of ended owners', { retiredPids });
    },
    guardSources: {
      readBrowsers: () => guardBrowserResourceOwner?.readResourceTargets?.() ?? [],
      readServices: (signal?: AbortSignal) => localServicesRuntime.refreshInventoryNow({ stage: 'native', signal }),
      readServiceTargets: () => pluginRuntimeController.getState().activeRegistry?.projectManagedServices.readResourceTargets() ?? [],
    },
    processOwnershipRuntime,
    processLeftBehindPass,
    ownerRemainder,
    processActionLifecycle: createSessionProcessActionLifecycle({
      pidToTrackedSession: params.pidToTrackedSession,
      markStopRequested: sessionRunnerRespawnManager.markStopRequested,
      registerPhysicalStopEffect: disconnectedTerminalHostResumeLifecycle.registerPhysicalStopEffect,
      prepareStopIntent: async (sessionId, execution, stopIntent) => {
        const actionContext = execution.actionContext;
        const requesterAction = readRequesterAccountActionContext(actionContext?.externalActionExecutionAuthorization);
        if (actionContext?.externalActionExecutionAuthorization && !requesterAction) {
          throw new Error('Process Stop requester custody unavailable');
        }
        await withSessionAccountContext(sessionId, async requester => {
          const credentials = requesterAction?.credentials ?? requester?.bootstrap.credentials ?? params.credentials;
          const serverHttpBaseUrl = requesterAction?.serverHttpBaseUrl ?? requester?.bootstrap.serverHttpBaseUrl ?? params.serverBaseUrl;
          const verifyCurrent = async () => {
            if (execution.signal?.aborted || execution.verifyCurrent && !await execution.verifyCurrent()
              || requesterAction && !await requesterAction.isCurrent()) return false;
            await assertSessionAccountCurrent(sessionId, requester);
            return true;
          };
          await runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => {
            if (!await verifyCurrent()) throw new Error('Process Stop requester retired');
            const installation = readInstallationIdentityIfExistsSync();
            const resolveAuthorizationHeaders = (request: Parameters<NonNullable<Parameters<typeof updateSessionMetadataWithRetry>[0]['resolveAuthorizationHeaders']>>[0]) => {
              const result = resolveExternalActionServerRequestHeaders({ context: actionContext,
                effectActionId: actionContext?.externalActionExecutionAuthorization?.binding.actionId ?? 'machines.processes.kill',
                ...request, daemonToken: credentials.token,
                serverIdentityId: requesterAction?.authorization.binding.serverIdentityId ?? params.serverId,
                ...(installation ? { privateKey: installation.privateKey, installationId: installation.installationId } : {}),
              });
              if (!result.ok) throw new Error('Process Stop metadata authorization unavailable');
              return result.headers;
            };
            const rawSession = await fetchSessionByIdCompat({ reason: 'session-control', token: credentials.token, sessionId, resolveAuthorizationHeaders });
            if (!rawSession || rawSession.id !== sessionId) throw new Error('Exact process Stop Session unavailable');
            const intent = resolveSessionExplicitControlIntent({ rawSession, actionContext });
            if (intent === 'unauthorized' || intent === 'self_stop_forbidden') throw new Error('Process Stop caller is not the admitted Session manager');
            const accountEncryptionCurrentness = rawSession.metadataLayoutVersion === 1 || stopIntent !== 'lifecycle_control'
              ? await fetchAccountEncryptionCurrentness({ token: credentials.token,
                  authorizationHeaders: resolveAuthorizationHeaders({ method: 'GET', path: '/v1/account/encryption/currentness' }) })
              : undefined;
            const owner = resolveSessionOwningMachineId({ credentials, rawSession,
              ...(accountEncryptionCurrentness ? { accountEncryptionMode: accountEncryptionCurrentness.mode } : {}) });
            if (!owner.ok || owner.machineId !== params.machineId) throw new Error('Process Stop Session Machine changed');
            if (stopIntent === 'lifecycle_control') return;
            await recordSessionStopIntent({ credentials, sessionId, rawSession,
              actionContext, stopIntent, requestId: actionContext?.actionRequestId ?? undefined, resolveAuthorizationHeaders, accountEncryptionCurrentness,
              currentness: { verifyCurrent }, ...(execution.signal ? { signal: execution.signal } : {}),
            });
          });
        });
      },
      // Process Actions exercise host custody, not the custodian's Account
      // recovery/history mutations performed by the ordinary Stop API wrapper.
      stopSession: async (sessionId, options, physicalEffect) =>
        await disconnectedTerminalHostResumeLifecycle.runStop(sessionId,
          async () => ({ stopResult: await stopSessionCore(sessionId, options) }), physicalEffect),
    }),
    managedMachinePolicyAdapter,
    ...(externalActionIngressOwner ? { externalActionIngressOwner } : {}),
    // Machine RPC (including inactive Goal resume) carries a newly admitted
    // caller intent, just like the local control server. Automatic recovery
    // keeps the Stop-fenced internal entry points above.
    spawnSession,
    // Retained input authorization identifies its original; it is not a fresh
    // person's Resume intent and cannot clear an explicit Stop.
    spawnSessionForInternalResume,
    stopSession,
    stopRequesterSessionForHandoff: async (sessionId, expectedSpawnNonce) => {
      const candidates = [...params.pidToTrackedSession.values()].filter(tracked => tracked.happySessionId === sessionId);
      if (candidates.length === 0) return await isSessionAlreadyRunning(sessionId) ? 'failed' : 'already_inactive';
      if (candidates.length !== 1) return 'failed';
      const tracked = candidates[0]!;
      if (tracked.spawnOptions?.spawnNonce !== expectedSpawnNonce) return 'failed';
      const result = await stopSessionCore(sessionId, {
        expectedTrackedRunner: { tracked, sessionRunnerPid: tracked.sessionRunnerPid,
          processStartTimeMs: tracked.processStartTimeMs, processCommandHash: tracked.processCommandHash },
        beforeSignalExactTrackedRunner: () => {
          sessionRunnerRespawnManager.markStopRequested(sessionId,
            { reason: 'daemon_stop_session', requestedAtMs: Date.now() });
        },
      });
      return result.status === 'stopped' ? 'stopped' : 'failed';
    },
    isSessionAlreadyRunning,
    hasPendingRunnerRestarts: () => versionRuntimeRefreshAttemptHandoff.hasPending()
      || params.connectedServicesRestartRequestedPids.size > 0
      || sessionRunnerRespawnManager.hasPendingIntendedRestarts(),
    restartStaleSessionRunnersAfterDaemonStart: () => restartStaleRunnersAfterDaemonStart({
      readSettings,
      isShuttingDown: isRuntimePublicationQuiescing,
      restart: () => ({
        currentIdentity: resolveCurrentSessionRunnerLaunchIdentity(),
        resolveCurrentIdentity: resolveCurrentSessionRunnerLaunchIdentity,
        trackedSessions: Array.from(params.pidToTrackedSession.values()),
        requestRestart: requestSessionRunnerVersionRuntimeRefresh,
        readNativeRuntimeActivity: readSessionRunnerNativeRuntimeActivity,
        resolveActivityDisabledReason: resolveSessionRunnerActivity,
        resolveAgentRuntimeCurrentness: resolveTrackedRunnerRuntimeCurrentness,
        refreshTrackedSessionRuntimeSnapshot: refreshTrackedSessionRuntimeSnapshotForPlannedRestart,
      }),
      logDebug: (message, payload) => logger.debug(message, payload),
      logWarn: (message, payload) => logger.warn(message, payload),
    }),
    sessionRunnerStatus: {
      get: resolveSessionRunnerStatus,
      getV2: resolveSessionRunnerStatusV2,
    },
    onChildExited,
    onTrackedSessionHealthy: async (tracked: TrackedSession): Promise<void> => {
      await superviseTrackedOptionalTerminalPresentation({
        tracked,
        happyHomeDir: configuration.happyHomeDir,
        isCurrent: () =>
          params.pidToTrackedSession.get(tracked.pid) === tracked &&
          !isRuntimePublicationQuiescing() &&
          typeof tracked.stopRequestedAtMs !== 'number' &&
          tracked.reportMarkerCustody?.retiring !== true,
        loadTerminalHostAdapters: async () =>
          (await params.loadTerminalHostAdapters?.()) ?? {},
        probeSessionServiceability: async (sessionId) =>
          await probeSessionRunnerServiceability({
            sessionId,
            trackedSessions: params.pidToTrackedSession.values(),
            probeCapability: async () =>
              await probeAlreadyRunningExistingSessionServiceability({
                sessionId,
                credentials: params.credentials,
                abortSignal: shutdownCancellationDomains.daemonWorkSignal,
                isShuttingDown: isRuntimePublicationQuiescing,
              }),
          }),
        retireExactTerminalControlServiceability: async ({
          sessionId,
          attachmentInfo,
          terminalMode,
        }) =>
          await retireTerminalControlServiceabilityForCurrentAccount({
            sessionId,
            attachmentId: attachmentInfo.attachmentId,
            terminalMode,
          }),
      });
    },
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
    cancelConnectedServiceRuntimeAuthRecovery: async ({
      sessionId,
      attemptId,
    }) =>
      await runtimeAuthRecoveryScheduler.cancelExact({ sessionId, attemptId }),
    checkRuntimeAuthUsageLimitRecovery: async (input) =>
      await checkRuntimeAuthUsageLimitRecovery({ scheduler: runtimeAuthRecoveryScheduler, ...input }),
    retryTemporaryThrottleNow: async ({ sessionId }) =>
      await temporaryThrottleScheduler.wake({ sessionId, reason: 'manual' }),
    readTemporaryThrottleRecovery: (sessionId: string) =>
      temporaryThrottleScheduler.read(sessionId),
    cancelTemporaryThrottleRecovery: async (
      input: Parameters<
        ConnectedServiceTemporaryThrottleRetryScheduler['cancel']
      >[0],
    ) => await temporaryThrottleScheduler.cancel(input),
    reconcileReattachedConnectedServiceCredentialProjection,
    reconcileConnectedServicesProjection,
    awaitAgentSessionOpen: async (input) =>
      await awaitTrackedRunnerAgentSessionOpen({
        getTrackedSessions: () =>
          Array.from(params.pidToTrackedSession.values()),
        ...input,
        readStartupFailure: trackedSession => readStartupFailure({ sessionId: input.sessionId, trackedSession }),
      }),
    installExternalSessionHostOperations: (operations) =>
      externalSessionHostOperationOwner.install(operations),
    readMaterializedStateObservationBinding: (sessionId) =>
      readTrackedSessionMaterializedStateObservationBinding(params.pidToTrackedSession.values(), sessionId),
    providerAccountUsageStore,
    // Provider account-usage persistence pauses a key after repeated write
    // failures and retains its last payload. Reconnect is the only signal that
    // the failure cause is gone, so the daemon connectivity lifecycle resubmits
    // the retained material through the scheduler's existing flush.
    flushProviderAccountUsagePersistence: async (timeoutMs: number) =>
      await flushProviderAccountUsagePersistenceForTrackedSessions({
        ownedScheduler: providerAccountUsagePersistence,
        trackedSessions: [...params.pidToTrackedSession.keys()].map((pid) => ({
          happySessionId: resolveCanonicalTrackedSessionId(pid) || null,
        })),
        withSessionAccountContext,
        timeoutMs,
      }),
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
    ) =>
      createAgentProviderCatalogObservationService({
        ...infrastructure,
        activatePurposeBindings:
          params.activatePurposeBindings ??
          (() => {
            throw new Error(
              'connected_account_purpose_binding_owner_unavailable',
            );
          }),
        requestAuth: {
          lookupRequestAuth: async (input) => {
            return await connectedAccountRequestAuthService.lookupRequestAuth(
              input,
            );
          },
          refreshAfterAuthFailure: async (input) => {
            return await connectedAccountRequestAuthService.refreshAfterAuthFailure(
              input,
            );
          },
        },
        createRedactionLease: () =>
          createProviderRedactionLease({ values: [] }),
      }),
    refreshBrowserRouteOwners,
    // BRW-6: daemon-side on-disk browser storage purge entrypoints. The daemon's
    // session-deleted signal and logout transition drive these to remove session/ephemeral
    // profile + partition bytes (fail-closed; failed purge marks the profile unusable).
    purgeBrowserStorageForSessionDeleted,
    purgeBrowserStorageForLogout,
  };
}

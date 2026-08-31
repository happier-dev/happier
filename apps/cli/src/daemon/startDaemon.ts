import fs from 'fs/promises';
import os from 'os';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn as spawnChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { getReleaseRingCatalogEntry } from '@happier-dev/release-runtime/releaseRings';
import {
  AGENT_IDS,
  resolveAgentIdFromSessionMetadata,
  resolveAgentNativeSpawnDefinitiveRejection,
} from '@happier-dev/agents';

import { ApiClient, isMachineContentPublicKeyMismatchError } from '@/api/api';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { ensureMachineRegistered } from '@/api/machine/ensureMachineRegistered';
import { ensureSessionMachineAccessKeyBinding } from '@/api/session/ensureSessionMachineAccessKeyBinding';
import { isRpcMethodNotAvailableError } from '@happier-dev/protocol/rpcErrors';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import {
  probeSessionPendingQueueWakeCapabilityV1,
  requestSessionPendingQueueWakeV1,
} from './sessions/pendingQueueWake';
import { publishSessionPendingQueueWake } from './sessions/publishSessionPendingQueueWake';
import { createRuntimeAuthRecoverySchedulerForDaemon } from './connectedServices/runtimeAuth/createRuntimeAuthRecoverySchedulerForDaemon';
import { deriveConnectedServiceBrokerRefreshToken } from './connectedServices/broker/brokerRefreshCapabilityToken';
import { createConnectedServiceCredentialApi } from '@/api/connectedServices/connectedServiceCredentialApi';
import { resolveRoutedUsageLimitRecoveryResumePromptMode } from '@/session/usageLimitRecoveryControls/resolveRoutedUsageLimitRecoveryResumePromptMode';
import type { ApiMachineClient } from '@/api/apiMachine';
import { fetchAccountProfile } from '@/api/accountProfile';
import { applyInitialTranscriptAfterSeqToAttachPayload } from '@/daemon/sessionEncryption/applyInitialTranscriptAfterSeqToAttachPayload';
import { TrackedSession } from './types';
import { MachineMetadata, DaemonState, type Metadata } from '@/api/types';
import {
  SpawnSessionOptions,
  SpawnSessionResult,
  SpawnSessionRunnerAcceptanceHooks,
} from '@/rpc/handlers/registerSessionHandlers';
import { resolveCanonicalCodexBackendMode } from '@/rpc/handlers/codexBackendMode';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration, reloadConfiguration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/integrations/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import {
  buildHappyCliSubprocessLaunchSpec,
  pruneHappyCliRunnerSnapshots,
  resolveHappyCliSubprocessRuntimeDecision,
  spawnHappyCLI,
  type HappyCliSubprocessLaunchOptions,
} from '@/utils/spawnHappyCLI';
import {
  getConnectedServiceRuntimeAuthAdapter,
  getConnectedServiceStateSharingDescriptor,
  getVendorResumeSupport,
  requireCatalogEntry,
  resolveConnectedServiceCredentialLifecycleDescriptor,
  resolveConnectedServiceGenerationApplicationScope,
  resolveConnectedServiceCandidatePersistedSessionFile,
  resolveConnectedServiceSwitchContinuity,
  resolveAgentCliSubcommand,
  resolveCatalogAgentId,
  hasTerminalAttachmentControlDescriptorThroughCatalog,
  notifyTerminalAttachmentRetiredThroughCatalog,
} from '@/backends/catalog';
import { CATALOG_AGENT_IDS } from '@/backends/types';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import {
  writeDaemonStateIfLockOwned,
  writeConnectedServiceBrokerState,
  DaemonLocallyPersistedState,
  acquireDaemonLock,
  releaseDaemonLock,
  clearDaemonState,
  readCredentials,
  readSettings,
} from '@/persistence';
import type { Credentials } from '@/persistence';
import { abandonSpawnedSessionUntilCompleted } from '@/session/services/awaitSpawnedSessionId';
import { setSessionArchivedState } from '@/session/services/setSessionArchivedState';
import { createSessionAttachFile } from './sessionAttachFile';
import { getDaemonShutdownExitCode, getDaemonShutdownWatchdogTimeoutMs } from './shutdownPolicy';
import { shouldRetryMachineRegistrationError } from './machineRegistrationRetryPolicy';
import { computeRestartDelayMs } from '@/subprocess/supervision/backoff';
import {
  isDaemonStartupSourceServiceManaged,
  resolveDaemonTakeoverRequestedFromEnv,
  resolveDaemonServiceLabelFromEnv,
  resolveDaemonStartupSourceFromEnv,
} from '@/daemon/ownership/daemonOwnershipMetadata';
import { evaluateCurrentDaemonOwner } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { DaemonOwnershipConflictError } from '@/daemon/ownership/DaemonOwnershipConflictError';
import { DaemonStartupConflictError } from '@/daemon/ownership/DaemonStartupConflictError';
import { evaluateDaemonStartupServiceConflict } from '@/daemon/ownership/daemonServiceInventory';
import {
  buildDaemonTakeoverNotice,
  resolveDaemonTakeoverDecision,
} from '@/daemon/ownership/resolveDaemonTakeoverDecision';
import { resolveDaemonOwnershipConflictExitCode } from '@/daemon/ownership/resolveDaemonOwnershipConflictExitCode';
import { resolveDaemonServiceCliRuntimeFromEnv } from '@/daemon/service/cli';

import { forceStopKnownDaemonPid, isDaemonRunningCurrentlyInstalledHappyVersion, resolveDaemonSpawnSessionByNonce, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { resolveTrackedSessionCatalogAgentId } from './sessions/resolveTrackedSessionCatalogAgentId';
import { activatePendingInactiveSession } from './sessions/activatePendingInactiveSession';
import { resolveExistingRunnerAcceptance } from './spawn/resolveRunnerAcceptance';
import {
  createDirectPeerTransferRegistry,
  requestDirectPeerTransferToFile,
  startDirectPeerTransferServer,
} from '@/machines/transfer/directPeerTransport';
import { resolveMachineTransferRuntimeConfig } from '@/machines/transfer/transferRuntimeConfig';
import {
  reattachTrackedSessionsFromMarkers,
} from './sessions/reattachFromMarkers';
import {
  ClaudeEndpointRecoveryFenceError,
  resolveClaudeEndpointRecoverySpawnOptions,
} from './sessions/claudeEndpointStateEnv';
import { HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY } from '@/backends/claude/endpointRecovery/claudeEndpointArtifacts';
import { createOnHappySessionWebhook } from './sessions/onHappySessionWebhook';
import { applyTrackedSessionTurnLifecycle } from './sessions/applyTrackedSessionTurnLifecycle';
import { connectedServiceTurnLifecycleContinue } from './connectedServices/connectedServiceTurnLifecycleContract';
import { resolveSessionRuntimeSnapshot } from './sessions/runtimeSnapshot/resolveSessionRuntimeSnapshot';
import { resolveRespawnSessionRuntimeSnapshot } from './sessions/runtimeSnapshot/resolveRespawnSessionRuntimeSnapshot';
import { buildInactiveUsageLimitResumeSpawnOptions } from './sessions/runtimeSnapshot/buildInactiveUsageLimitResumeSpawnOptions';
import { buildHandoffSessionMetadataFromTrackedSession } from './sessions/buildHandoffSessionMetadataFromTrackedSession';
import { createOnChildExited } from './sessions/onChildExited';
import { publishOrphanedStartupSessionEnds } from './sessions/publishOrphanedStartupSessionEnds';
import {
  resolveDisconnectedTerminalHostResumeGate,
  superviseDisconnectedTerminalHostCandidate,
  type DisconnectedTerminalHostCandidate,
  type DisconnectedTerminalHostSupervisionResult,
} from './sessions/disconnectedTerminalHostSupervision';
import {
  applyTerminalControlServiceabilityProjection,
  resolveRunnerTerminalControlServiceabilityEvidence,
} from './sessions/terminalControlServiceabilityProjection';
import { publishReportedTerminalControlServiceability } from './sessions/publishReportedTerminalControlServiceability';
import { retireExactTerminalControlServiceability } from './sessions/retireTerminalControlServiceability';
import { recoverStrandedTerminalControlServiceability } from './sessions/recoverStrandedTerminalControlServiceability';
import { waitForVisibleConsoleSessionWebhook } from './sessions/visibleConsoleSpawnWaiter';
import { createStopSession } from './sessions/stopSession';
import {
  isTerminalHostPhysicallyRetiredStopResult,
  type StopSessionResult,
} from './sessions/stopSessionContract';
import { waitForExistingSessionExitIfStopRequested } from './sessions/waitForExistingSessionExitIfStopRequested';
import { waitForTerminatingSessionRunnerExit } from './sessions/waitForTerminatingSessionRunnerExit';
import { waitForTrackedRunnerProcessesExit } from './sessions/waitForTrackedRunnerProcessesExit';
import { readProcessRunState } from './processRunState';
import { resolveSpawnWebhookResult } from './sessions/resolveSpawnWebhookResult';
import {
  isSessionRunnerActive as isSessionRunnerActiveInDaemon,
  probeSessionRunnerServiceability as probeSessionRunnerServiceabilityInDaemon,
  resolveSessionRunnerResumeDecision,
  type SessionRunnerServiceabilityProbe,
} from './sessions/isSessionRunnerActive';
import { startDaemonHeartbeatLoop } from './lifecycle/heartbeat';
import { requestDaemonSelfRestartWithLockHandoff } from './lifecycle/requestDaemonSelfRestartWithLockHandoff';
import { assertCurrentDaemonSelfRestartAuthorization } from './lifecycle/selfRestartAuthorization';
import { resolveDaemonSelfRestartExpectedCliVersion } from './lifecycle/resolveDaemonSelfRestartExpectedCliVersion';
import {
  readDaemonRestartVerifyPollMs,
  readDaemonRestartVerifyTimeoutMs,
} from './startupWaitDefaults';
import { reapSameHomeDaemonOrphansBeforeStart } from './multiDaemon';
import {
  createSessionRunnerRespawnManager,
  type SessionRunnerRespawnTerminalReason,
} from './processSupervision/sessionRunnerRespawn';
import {
  buildSessionRunnerRespawnDescriptorV1FromSpawnOptions,
  buildTrackedSessionRespawnEnvironmentVariables,
} from './processSupervision/sessionRunnerRespawnDescriptor';
import { getSessionNotificationTitle } from '@/agent/runtime/readyNotificationContext';
import { publishShutdownStateBestEffort } from './lifecycle/publishShutdownState';
import type { SessionHandoffLocalMetadataSource } from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import { selectPreferredTmuxSessionName, TmuxUtilities, isTmuxAvailable } from '@/integrations/tmux';
import { resolveTerminalRequestFromSpawnOptions } from '@/terminal/runtime/terminalConfig';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import {
  evaluatePredictiveSoftSwitchLiveSessionRequirement,
  evaluatePredictiveSoftSwitchPolicy,
  evaluatePredictiveSoftSwitchTrackedLiveSessionPolicy,
} from './connectedServices/accountGroups/switching/predictiveSoftSwitchPolicy';

import {
  getPreferredHostName,
  initialMachineMetadata,
  refreshMachineMetadataForCurrentDaemon,
} from './machine/metadata';
import { createDaemonShutdownController } from './lifecycle/shutdown';
import { buildTmuxSpawnConfig, buildTmuxWindowEnv } from './platform/tmux/spawnConfig';
export { buildTmuxSpawnConfig, buildTmuxWindowEnv } from './platform/tmux/spawnConfig';
import {
  migrateTrackedSessionProcessesOutOfDaemonServiceCgroup,
} from './platform/linux/migrateTrackedSessionProcessesOutOfDaemonServiceCgroup';
import { removeRuntimeAuthFailureReportOutboxItemsForSession } from './connectedServices/runtimeAuth/reportOutbox/runtimeAuthFailureReportOutbox';
import { createConnectedServiceRecoverySupersessionCleaner } from './connectedServices/continuation/continuationRecoverySupersession';
import { buildCgroupSelfMigratingHappyCliLaunchSpec } from './platform/linux/buildCgroupSelfMigratingHappyCliLaunchSpec';
import { applySpawnedChildOomScoreAdjustment } from './platform/linux/applySpawnedChildOomScoreAdjustment';
import { resolveWindowsRemoteSessionConsoleMode } from './platform/windows/windowsSessionConsoleMode';
import { startHappySessionInVisibleWindowsConsole } from './platform/windows/spawnHappyCliVisibleConsole';
import { startHappySessionInWindowsTerminal } from './platform/windows/spawnHappyCliWindowsTerminal';
import {
  buildWindowsHostedTerminalArgs,
  buildWindowsHostedTerminalAttachment,
  buildWindowsTerminalWindowIdentity,
  resolveWindowsTerminalWindowName,
} from './platform/windows/windowsHostedSessionRuntime';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import {
  clearSessionMarkerConnectedServiceRestartIntent,
  readSessionMarkerForPid,
  refreshSessionMarkerRespawn,
  removeSessionMarker,
  writeSessionMarker,
} from './sessionRegistry';
import {
  HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY,
  serializePendingFirstInputForEnv,
} from './spawn/pendingFirstInput';
import { createDefaultTerminalHostRegistry } from '@/integrations/terminalHost/defaultRegistry';
import { resolveLiveRunnerSnapshotFingerprints } from './sessionRunnerRuntime/resolveLiveRunnerSnapshotFingerprints';
import { buildHappySessionControlArgs } from './sessionSpawnArgs';
import { serializeDaemonInitialGoalForEnv, HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY } from '@/agent/runtime/sessionInitialGoal';
import { resolveExistingSessionAttachContext } from './sessionEncryption/resolveExistingSessionAttachContext';
import { resolveWaitForAuthConfig } from './startup/waitForAuthConfig';
import { ensureSessionDirectory } from './startup/ensureSessionDirectory';
import { waitForInitialCredentials } from './startup/waitForInitialCredentials';
import { resolveDaemonDiagnosticSubsystemGates } from './startup/diagnosticSubsystemGates';
import { createDaemonEventLoopStallMonitor } from './diagnostics/daemonEventLoopStallMonitor';
import { resolveStartDaemonMachinePreflightDecision } from './startup/machinePreflightDecision';
import { waitForSessionWebhook } from './spawn/waitForSessionWebhook';
import { resolveSpawnChildEnvironment } from './spawn/resolveSpawnChildEnvironment';
import { buildSpawnChildProcessEnv } from './spawn/buildSpawnChildProcessEnv';
import { resolveStackProcessKindOverrideForSessionSpawn } from './spawn/resolveStackProcessKindOverrideForSessionSpawn';
import { createSpawnConcurrencyGate } from './spawn/createSpawnConcurrencyGate';
import { computeDaemonSpawnRequestKey, createSpawnRequestCoalescer } from './spawn/spawnRequestCoalescer';
import { createDaemonSpawnAttemptRegistry } from './spawn/daemonSpawnAttemptRegistry';
import { normalizeSpawnSessionDirectory } from '@/rpc/handlers/spawnSessionOptionsContract';
import { startAutomationWorker, type AutomationWorkerHandle } from './automation/automationWorker';
import { startMemoryWorker, type MemoryWorkerHandle } from './memory/memoryWorker';
import { createDaemonConnectivityCoordinator } from './connection/createDaemonConnectivityCoordinator';
import {
  createDaemonServerWorkBudget,
  createDaemonServerWorkScheduler,
  type DaemonServerWorkScheduler,
} from './serverWork';
import {
  ConnectedServiceSpawnMaterializationError,
  ConnectedServiceSpawnResumeUnreachableError,
  resolveConnectedServiceAuthForSpawn,
} from './connectedServices/resolveConnectedServiceAuthForSpawn';
import { buildSpawnResumeUnreachableErrorResult } from './connectedServices/buildSpawnResumeUnreachableErrorResult';
import { createExecutionRunConnectedServicesBridge } from './connectedServices/runsBridge/materializeConnectedServicesForRun';
import {
  buildConnectedServiceCredentialSpawnErrorResult,
  buildConnectedServiceDiagnosticSpawnValidationErrorResult,
  buildConnectedServiceMaterializationSpawnErrorResult,
} from './connectedServices/diagnostics/buildConnectedServiceDiagnosticSpawnErrorResult';
import { buildConnectedServiceUxDiagnostic } from './connectedServices/diagnostics/connectedServiceUxDiagnostics';
import { shouldResolveConnectedServiceAuthForSpawn } from './connectedServices/shouldResolveConnectedServiceAuthForSpawn';
import { ConnectedServiceRefreshCoordinator } from './connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import { prepareConnectedServiceAuthGroupCandidateForSwitch } from './connectedServices/refresh/prepareConnectedServiceAuthGroupCandidateForSwitch';
import { ConnectedServiceAuthGroupQuotaProbeIncompleteError } from './connectedServices/accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { createConnectedServiceGroupMutationCurrentnessValidator } from './connectedServices/credentials/createConnectedServiceGroupMutationCurrentnessValidator';
import { createConnectedServicesAuthUpdatedRestartHandler } from './connectedServices/refresh/createConnectedServicesAuthUpdatedRestartHandler';
import {
  ConnectedServiceQuotasCoordinator,
  DEFAULT_CONNECTED_SERVICE_QUOTA_FETCH_TIMEOUT_MS,
} from './connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { createConnectedServiceQuotaFetchers } from './connectedServices/quotas/createConnectedServiceQuotaFetchers';
import {
  ConnectedServiceRuntimeRegistry,
  type ConnectedServiceRuntimeBindingIdentity,
  type ConnectedServiceRuntimeTarget,
  type ConnectedServiceRuntimeTargetInput,
  type ConnectedServiceRuntimeTargetRegistration,
} from './connectedServices/runtimeRegistry/registry';
import { createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator } from './connectedServices/quotas/createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator';
import { ConnectedServiceAuthGroupGenerationConsumer } from './connectedServices/accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer';
import { createConnectedServiceCurrentGroupTruthNotifier } from './connectedServices/accountGroups/generation/createConnectedServiceCurrentGroupTruthNotifier';
import {
  getBrokerBridgeEffectiveSelection,
  isBrokerBridgeCurrentGroupTruthCompatible,
  markBrokerBridgeEffectiveSelectionUnavailable,
} from './connectedServices/broker/brokerBridgeEffectiveSelectionRegistry';
import {
  reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget,
  reconcileConnectedServiceDirectCredentialRevisionForRuntimeTarget,
  reconcileConnectedServiceDirectCredentialRevisions,
  reconcileConnectedServiceAuthGroupGenerations,
} from './connectedServices/accountGroups/generation/reconcileConnectedServiceAuthGroupGenerations';
import { mapCommittedGenerationApplyResult } from './connectedServices/accountGroups/generation/mapCommittedGenerationApplyResult';
import { createRuntimeGenerationApplicationProofResolver } from './connectedServices/accountGroups/generation/createRuntimeGenerationApplicationProofResolver';
import type { RuntimeGenerationApplicationProofTarget } from './connectedServices/accountGroups/generation/resolveRuntimeGenerationApplicationProofs';
import {
  diffConnectedServiceProjectionSnapshots,
  parseConnectedServiceProjectionSnapshot,
  type ConnectedServiceProjectionSnapshot,
} from './connectedServices/accountGroups/generation/connectedServiceProjectionSnapshot';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from './connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry } from './connectedServices/accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { normalizeConnectedServiceAuthGroupPolicy } from './connectedServices/accountGroups/switching/buildConnectedServiceAuthGroupSwitchState';
import {
  persistMemberRuntimeStateWithPositiveEvidence,
  type ConnectedServiceAuthGroupPositiveEvidence,
} from './connectedServices/accountGroups/memberRuntimeState';
import { recordConnectedServiceRuntimeQuotaSnapshotForSession } from './connectedServices/quotas/recordConnectedServiceRuntimeQuotaSnapshotForSession';
import { hydrateProviderAccountUsageStoreFromConnectedServiceInventory } from './connectedServices/accountUsage/currentSourceHydration';
import { activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration } from './connectedServices/accountUsage/startupActivation';
import { createProviderAccountUsagePersistenceScheduler } from './connectedServices/accountUsage/persistence';
import { createProviderAccountUsageStore } from './connectedServices/accountUsage/store';
import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from './connectedServices/runtimeAuth/createDaemonConnectedServiceAuthGroupSwitchCoordinator';
import {
  authorizeConnectedServiceRuntimeAuthFailureSource,
  handleConnectedServiceRuntimeAuthFailureForSession,
} from './connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession';
import { commitConnectedServiceAccountSwitchSessionEvent } from './connectedServices/runtimeAuth/commitConnectedServiceAccountSwitchSessionEvent';
import { surfaceConnectedServiceAccountSwitchOutcome } from './connectedServices/runtimeAuth/surfaceConnectedServiceAccountSwitchOutcome';
import { shouldCommitAutomaticGroupApplySessionEvent } from './connectedServices/runtimeAuth/automaticGroupApplySessionEvents';
import { commitConnectedServiceRuntimeAuthRecoverySessionEvent } from './connectedServices/runtimeAuth/commitConnectedServiceRuntimeAuthRecoverySessionEvent';
import { ConnectedServiceRuntimeAuthSwitchAttemptTracker } from './connectedServices/runtimeAuth/ConnectedServiceRuntimeAuthSwitchAttemptTracker';
import {
  createConnectedServiceSessionAuthSwitchCore,
  type ConnectedServiceSessionAuthSwitchReason,
} from './connectedServices/runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { buildConnectedServiceRuntimeAuthSwitchAttemptLogContext } from './connectedServices/runtimeAuth/buildConnectedServiceRuntimeAuthSwitchAttemptLogContext';
import {
  RuntimeAuthRecoveryScheduler,
  type RuntimeAuthRecoveryDiagnostic,
  type RuntimeAuthRecoveryIntent,
} from './connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import { buildRuntimeAuthRecoveryKey } from './connectedServices/runtimeAuth/recoveryKey/runtimeAuthRecoveryKey';
import {
  resolveReactiveRuntimeAuthRecoveryClear,
  type ReactiveRuntimeAuthRecoverySignal,
  type ReactiveRuntimeAuthRecoverySource,
} from './connectedServices/runtimeAuth/resolveReactiveRuntimeAuthRecoveryClear';
import type { ConnectedServiceRuntimeFailureClassification } from './connectedServices/runtimeAuth/types';
import { createRecoveryIntentFileStore } from './connectedServices/recoveryScheduler/recoveryIntentFileStore';
import {
  switchSessionConnectedServiceAuth,
  type SessionConnectedServiceAuthSwitchDiagnostics,
  type ConnectedServiceResumeContinuityProofDiagnostics,
  type SessionConnectedServiceAuthSwitchResult,
} from './connectedServices/sessionAuthSwitch/switchSessionConnectedServiceAuth';
import { resolveManualSwitchPreviousGroupMembers } from './connectedServices/sessionAuthSwitch/resolveManualSwitchPreviousGroupMembers';
import { buildConnectedServiceAuthGroupCommittedGenerationFact } from './connectedServices/sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import { buildConnectedServiceSwitchContinuationAttemptId } from './connectedServices/sessionAuthSwitch/buildConnectedServiceSwitchContinuationAttemptId';
import { resolveCommittedGenerationFromRuntimeAuthRecovery } from './connectedServices/sessionAuthSwitch/resolveCommittedGenerationFromRuntimeAuthRecovery';
import {
  buildConnectedServiceRestartRequestedSessionEvent,
  createConnectedServiceSessionRestartAmplificationGuard,
  isConnectedServiceRestartSignalStaleProcessError,
  requestConnectedServiceSessionRestartSignal,
  shouldEmitConnectedServiceRestartRequestedSessionEvent,
  type ConnectedServiceRestartRequestedTranscriptEventOwner,
  type ConnectedServiceDaemonRestartDiagnosticInput,
  type ConnectedServiceDaemonRestartDiagnosticRecord,
} from './connectedServices/sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';
import {
  createConnectedServiceSwitchDeferralQueue,
  type ConnectedServiceSwitchDeferralQueue,
  type ConnectedServiceSwitchTarget,
} from './connectedServices/sessionAuthSwitch/connectedServiceSwitchDeferralQueue';
import { requestPlannedRunnerRestart } from './plannedRunnerRestart/requestPlannedRunnerRestart';
import type { PlannedRunnerRestartNotSignaledReason } from './plannedRunnerRestart/types';
import {
  summarizeSessionRunnerEndpoint,
  restartAllSessionRunnersOnCurrentRuntime,
  restartSessionRunnerOnCurrentRuntime,
  type RestartSessionRunnerCompletion,
} from './plannedRunnerRestart/restartSessionRunnerOnCurrentRuntime';
import { resolveCurrentSessionRunnerLaunchIdentity } from './sessionRunnerRuntime/resolveRunnerEntrypointIdentity';
import { resolveSessionRunnerRuntimeState } from './sessionRunnerRuntime/resolveRuntimeState';
import { resolveSessionRunnerActivityDisabledReason as resolveSessionRunnerActivityDisabledReasonFromReaders } from './sessionRunnerRuntime/resolveActivityDisabledReason';
import { setOpenCodeConnectedServiceInFlightTurnProvider } from './connectedServices/sessionAuthSwitch/openCodeConnectedServiceInFlightTurnRegistry';
import { requestConnectedServiceSwitchBeforeTurnWithDeferral } from './connectedServices/sessionAuthSwitch/connectedServiceSwitchBeforeTurnDeferral';
import { logConnectedServiceDaemonRestartDiagnostic } from './connectedServices/sessionAuthSwitch/logConnectedServiceDaemonRestartDiagnostic';
import { logConnectedServiceAuthSwitchResult } from './connectedServices/sessionAuthSwitch/logConnectedServiceAuthSwitchResult';
import { resolveSharedStateRequiredSwitchContinuity } from './connectedServices/sessionAuthSwitch/resolveSharedStateRequiredSwitchContinuity';
import { resolveUnsupportedSwitchContinuityErrorCode } from './connectedServices/sessionAuthSwitch/diagnostics/resolveUnsupportedSwitchContinuityErrorCode';
import { createSessionConnectedServiceAuthHotApply } from './connectedServices/sessionAuthSwitch/sessionConnectedServiceAuthHotApply';
import { createSessionConnectedServiceAccountAdoptionVerifier } from './connectedServices/accountTransitions/createSessionConnectedServiceAccountAdoptionVerifier';
import { resolveInactiveConnectedServiceSessionForAuthSwitch } from './connectedServices/sessionAuthSwitch/resolveInactiveConnectedServiceSessionForAuthSwitch';
import { dispatchConnectedServiceCredentialHealthNotificationAsync } from './connectedServices/notifications/dispatchConnectedServiceCredentialHealthNotification';
import { dispatchConnectedServiceQuotaLifecycleNotificationAsync } from './connectedServices/notifications/dispatchConnectedServiceQuotaLifecycleNotification';
import { commitConnectedServiceQuotaLifecycleSessionEvents } from './connectedServices/quotas/commitConnectedServiceQuotaLifecycleSessionEvents';
import { ConnectedServiceGroupHomeCleanupScheduler } from './connectedServices/homes/ConnectedServiceGroupHomeCleanupScheduler';
import { ConnectedServiceMaterializedHomeCleanupScheduler } from './connectedServices/materialize/cleanup/ConnectedServiceMaterializedHomeCleanupScheduler';
import { startConnectedServiceMaterializedHomeCleanupLoop } from './connectedServices/materialize/cleanup/startConnectedServiceMaterializedHomeCleanupLoop';
import { isConnectedServiceAuthGroupUnavailableError } from '@/api/connectedServices/connectedServiceCredentialApi';
import {
  ConnectedServiceCredentialRecordV1Schema,
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  ConnectedServiceIdSchema,
  RestartAllSessionRunnersResultV1Schema,
  RestartSessionRunnerResultV1Schema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceCredentialRevisionV1,
  type ConnectedServiceExecutionAuthorityV1,
  type ConnectedServiceMaterializationIdentityV1,
  type RestartSessionRunnerRequestV1,
  type SessionRunnerRestartDisabledReason,
  writeProviderAccountUsageRecordIdToMetadata,
  type SessionContinuationRecoveryIdentityV1,
  type SessionContinuationResumePromptModeV1,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';
import { resolveConnectedServiceQuotasDaemonOptions } from './connectedServices/quotas/resolveConnectedServiceQuotasDaemonOptions';
import { resolveConnectedServicesQuotasDaemonEnabled } from './connectedServices/quotas/resolveConnectedServicesQuotasDaemonEnabled';
import { startConnectedServiceQuotasLoop, type ConnectedServiceQuotasLoopHandle } from './connectedServices/quotas/startConnectedServiceQuotasLoop';
import { readConnectedServiceRuntimeIdentityForQuotaFanout } from './connectedServices/quotas/identity/readConnectedServiceRuntimeIdentityForQuotaFanout';
import type { RuntimeAccountIdentitySelectionInput } from './connectedServices/quotas/identity/runtimeAccountIdentityTypes';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { parseBooleanEnv, resolveConnectedServicesProviderStateSharingPolicyV1, type AccountSettings, type BackendTargetRefV1, type ConnectedServiceId } from '@happier-dev/protocol';
import type { CatalogAgentId, ConnectedServiceSwitchEffectiveBinding } from '@/backends/types';
import { readTerminalAttachmentInfo, writeTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { bindSpawnedTmuxTerminalAttachment } from './sessions/bindSpawnedTmuxTerminalAttachment';
import { normalizeAccountSettingsVersionHint } from '@/settings/accountSettings/accountSettingsVersion';
import { refreshAccountSettingsForMinimumVersion } from '@/settings/accountSettings/refreshAccountSettingsForMinimumVersion';
import { warmActiveAccountSettingsSnapshotBestEffort } from '@/settings/accountSettings/warmActiveAccountSettingsSnapshot';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { fetchSessionByIdCompat, fetchSessionsPage, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { persistExplicitSessionStopUsageLimitRecoveryCancellation } from '@/session/usageLimitRecoveryControls/persistUsageLimitRecoveryFieldDurably';
import { UsageLimitRecoveryScheduler } from './connectedServices/usageLimitRecovery/UsageLimitRecoveryScheduler';
import { createInactiveUsageLimitRecoveryCheckOwner } from './connectedServices/usageLimitRecovery/inactiveUsageLimitRecoveryCheckOwner';
import { resolveInactiveUsageLimitRecoverySchedulerResult } from './connectedServices/usageLimitRecovery/resolveInactiveUsageLimitRecoverySchedulerResult';
import { createUsageLimitRecoveryWakeGate } from './connectedServices/usageLimitRecovery/usageLimitRecoveryWakeGate';
import {
  TemporaryThrottleRecoveryScheduler,
  type TemporaryThrottleRecoveryIntent,
} from './connectedServices/temporaryThrottle/TemporaryThrottleRecoveryScheduler';
import { continueTrackedTemporaryThrottleSession } from './connectedServices/temporaryThrottle/continueTrackedTemporaryThrottleSession';
import {
  resolveInactiveTemporaryThrottleResumeSource,
  type TemporaryThrottleResumeSource,
} from './connectedServices/temporaryThrottle/resolveInactiveTemporaryThrottleResumeSource';
import { hydrateInactiveUsageLimitRecoveryFromSessionMetadata } from './connectedServices/usageLimitRecovery/hydrateInactiveUsageLimitRecoveryFromSessionMetadata';
import {
  createConnectedServiceContinuationMessageDispatcher,
  type ConnectedServiceContinuationInterruption,
} from './connectedServices/continuation/createConnectedServiceContinuationMessageDispatcher';
import { createConnectedServiceContinuationApplicationCorrelation } from './connectedServices/continuation/connectedServiceContinuationApplicationCorrelation';
import { listMatchingRuntimeAuthRecoveryIntents } from './connectedServices/runtimeAuth/matchRuntimeAuthRecoveryIntent';
import {
  createConnectedServiceProviderActivityProofRecorder,
  isProviderActivityTurnLifecycleEvent,
} from './connectedServices/recovery/providerActivityProofRecorder';
import { resolveEffectiveProviderStateMode } from './connectedServices/stateSharing/resolveEffectiveProviderStateMode';
import { listProviderActivityRecoveryIdentitiesFromRuntimeBindings } from './connectedServices/continuation/continuationRecoveryIdentity';
import {
  hasTrackedConnectedServiceGroupBinding,
  resolveTrackedConnectedServiceBindingsRaw,
} from './connectedServices/trackedSessionConnectedServiceBindings';
import { materializeSessionConnectedServiceRuntimeAuthSelection } from './connectedServices/sessionAuthSwitch/materializeSessionConnectedServiceRuntimeAuthSelection';
import { resolveTrackedConnectedServiceSwitchContinuityContext } from './connectedServices/sessionAuthSwitch/resolveTrackedConnectedServiceSwitchContinuityContext';
import {
  createConnectedServiceMaterializationIdentity,
  readConnectedServiceMaterializationIdentityV1,
} from './connectedServices/materialize/createConnectedServiceMaterializationIdentity';
import {
  readConnectedServiceBindingsOrEmpty,
  readNonEmptyMetadataString,
  readTrackedConnectedServiceMaterializationIdentity,
  readTrackedConnectedServiceMaterializationIdentityId,
  registerConnectedServiceRuntimeTargetForDaemon,
  registerConnectedServiceTrackedSessionTargetsForDaemon as registerConnectedServiceTrackedSessionTargetsForDaemonBase,
  shouldReconcileConnectedServiceRuntimeTargetRegistration,
} from './connectedServices/startup/runtimeTargetRegistration';
import { rehydrateLiveExecutionRunRuntimeTargets } from './connectedServices/startup/executionRunTargetRehydration';
import { listExecutionRunMarkers } from './executionRunRegistry';
import { createAdoptedExecutionRunRootCleanup } from './connectedServices/runsBridge/createAdoptedExecutionRunRootCleanup';
import { startConnectedServiceRefreshStartup } from './connectedServices/startup/refreshStartup';
import {
  resolveConnectedServiceCredentials,
  resolveConnectedServiceCredentialsWithRevisions,
} from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import { computeConnectedServiceAccessTokenFingerprint } from './connectedServices/refresh/credentialFreshness/tokenFingerprint';
import { resolveCurrentCodexRuntimeAuthFailureSource } from './connectedServices/runtimeAuth/resolveCurrentCodexRuntimeAuthFailureSource';
import { resolveRuntimeAuthFailureSourceProfile } from './connectedServices/runtimeAuth/resolveRuntimeAuthFailureSourceProfile';
import { resolveConnectedServiceGroupMemberByProviderAccountId } from './connectedServices/shared/resolveConnectedServiceGroupMemberByProviderAccountId';
import { readCredentialAccountIdentity } from './connectedServices/quotas/coordinator/support';
import { startConnectedServiceStableHomeReconcileScheduler } from './connectedServices/startup/stableHomeReconcile';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';

function resolvePositiveIntEnv(raw: string | undefined, fallback: number, bounds: { min: number; max: number }): number {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

function readBuiltInCatalogAgentIdFromBackendTarget(target: BackendTargetRefV1 | undefined): CatalogAgentId | null {
  if (target?.kind !== 'builtInAgent') return null;
  return typeof target.agentId === 'string' && (CATALOG_AGENT_IDS as readonly string[]).includes(target.agentId)
    ? (target.agentId as CatalogAgentId)
    : null;
}

function resolveTrackedSessionNotificationTitle(tracked: TrackedSession | null | undefined): string | null {
  return getSessionNotificationTitle(() => tracked?.happySessionMetadataFromLocalWebhook ?? null);
}

function resolveCatalogAgentIdFromBackendTarget(target: BackendTargetRefV1 | undefined): CatalogAgentId {
  if (target?.kind === 'configuredAcpBackend') {
    return 'customAcp';
  }
  return resolveCatalogAgentId(readBuiltInCatalogAgentIdFromBackendTarget(target));
}

function resolveTrackedSessionCatalogAgentIdFromMetadataSource(
  tracked: Pick<TrackedSession, 'happySessionMetadataFromLocalWebhook' | 'spawnOptions'>,
): CatalogAgentId {
  if (tracked.spawnOptions?.backendTarget?.kind === 'configuredAcpBackend') return 'customAcp';
  const fromBackendTarget = readBuiltInCatalogAgentIdFromBackendTarget(tracked.spawnOptions?.backendTarget);
  if (fromBackendTarget) return fromBackendTarget;
  return resolveCatalogAgentId(resolveAgentIdFromSessionMetadata(tracked.happySessionMetadataFromLocalWebhook));
}

function readConnectedServiceAccessTokenRefreshCapabilityFromMetadata(
  metadata: unknown,
): ConnectedServiceRuntimeTargetInput['accessTokenRefresh'] | undefined {
  const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : null;
  if (record && Object.prototype.hasOwnProperty.call(record, 'connectedServiceAccessTokenRefreshV1')) {
    const genericCapability = record.connectedServiceAccessTokenRefreshV1;
    if (!genericCapability || typeof genericCapability !== 'object' || Array.isArray(genericCapability)) {
      return null;
    }
    const genericCapabilityRecord = genericCapability as Readonly<{
      mode?: unknown;
      serviceIds?: unknown;
    }>;
    const serviceIds = Array.isArray(genericCapabilityRecord.serviceIds)
      ? genericCapabilityRecord.serviceIds.filter((serviceId): serviceId is ConnectedServiceId =>
          typeof serviceId === 'string' && serviceId.trim().length > 0)
      : [];
    return genericCapabilityRecord.mode === 'daemon_callback' && serviceIds.length > 0
      ? { mode: 'daemon_callback', serviceIds }
      : null;
  }
  const capability = record?.claudeSubscriptionAccessTokenRefreshV1;
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) return null;
  return (capability as Readonly<{ mode?: unknown }>).mode === 'daemon_callback'
    ? { mode: 'daemon_callback', serviceIds: ['claude-subscription'] }
    : null;
}

export function registerConnectedServiceTrackedSessionTargetsForDaemon(input: Readonly<{
  tracked: TrackedSession;
  runtimeRegistry?: ConnectedServiceRuntimeRegistry | null;
  onRegisteredTarget?: (target: ConnectedServiceRuntimeTarget) => void;
}>): ConnectedServiceRuntimeTarget | null {
  return registerConnectedServiceTrackedSessionTargetsForDaemonBase({
    ...input,
    resolveAccessTokenRefresh: readConnectedServiceAccessTokenRefreshCapabilityFromMetadata,
  });
}

function snapshotTrackedSessionForTemporaryThrottleResume(tracked: TrackedSession): TrackedSession {
  const { childProcess: _childProcess, ...snapshot } = tracked;
  return {
    ...snapshot,
    ...(tracked.spawnOptions ? { spawnOptions: { ...tracked.spawnOptions } } : {}),
  };
}

async function recoverTrackedSessionConnectedServiceRuntimeAuthSwitch(input: Readonly<{
  tracked: TrackedSession;
  runtimeAuthSelectionsByServiceId?: ReadonlyMap<ConnectedServiceId, unknown>;
}>): Promise<Readonly<{ ok: true } | { ok: false; errorCode?: string }>> {
  const selections = input.runtimeAuthSelectionsByServiceId;
  if (!selections || selections.size === 0) return { ok: true };
  const agentId = resolveTrackedSessionCatalogAgentId(input.tracked);
  const adapter = await getConnectedServiceRuntimeAuthAdapter(agentId);
  if (!adapter) return { ok: true };
  for (const selection of selections.values()) {
    const selectionRecord = selection && typeof selection === 'object' && !Array.isArray(selection)
      ? selection as Readonly<Record<string, unknown>>
      : null;
    if (typeof selectionRecord?.restartAndResume !== 'function') continue;
    const result = await adapter.recoverAfterRuntimeAuthSwitch({
      target: { agentId },
      selection,
    });
    if (result['recovered'] === false) {
      return {
        ok: false,
        errorCode: typeof result['reason'] === 'string' ? result['reason'] : 'recovery_failed',
      };
    }
  }
  return { ok: true };
}

function readRuntimeAuthSelectionRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readRuntimeAuthSelectionString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRuntimeAuthSelectionGeneration(record: Readonly<Record<string, unknown>>): number | null {
  const value = record.groupGeneration ?? record.generation;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function shouldTreatRuntimeAuthRecoveryClassificationAsLocalServerFailure(input: Readonly<{
  retryable?: boolean | null;
  kind?: string | null;
}> | null | undefined): boolean {
  if (!input?.retryable) return false;
  return input.kind === 'timeout'
    || input.kind === 'network'
    || input.kind === 'server_error';
}

export async function commitRuntimeAuthRecoveryDiagnosticForDaemon(input: Readonly<{
  credentials: Credentials;
  delivery: Readonly<{
    sessionId: string;
    transcriptEvent: unknown;
    attemptId: string;
    transition: string;
  }>;
}>): Promise<void> {
  await commitConnectedServiceRuntimeAuthRecoverySessionEvent({
    credentials: input.credentials,
    sessionId: input.delivery.sessionId,
    event: input.delivery.transcriptEvent,
    attemptId: input.delivery.attemptId,
    transition: input.delivery.transition,
  });
}

function buildRuntimeAccountIdentitySelectionsFromHotApply(
  runtimeAuthSelectionsByServiceId: ReadonlyMap<ConnectedServiceId, unknown> | undefined,
): ReadonlyArray<RuntimeAccountIdentitySelectionInput> {
  if (!runtimeAuthSelectionsByServiceId || runtimeAuthSelectionsByServiceId.size === 0) return [];
  const identitySelections: RuntimeAccountIdentitySelectionInput[] = [];

  for (const [serviceId, selection] of runtimeAuthSelectionsByServiceId.entries()) {
    const selectionRecord = readRuntimeAuthSelectionRecord(selection);
    if (!selectionRecord) continue;
    const profileId = readRuntimeAuthSelectionString(selectionRecord, 'profileId')
      ?? readRuntimeAuthSelectionString(selectionRecord, 'activeProfileId');
    if (!profileId) continue;
    const credentialRecord = ConnectedServiceCredentialRecordV1Schema.safeParse(selectionRecord.record);
    if (!credentialRecord.success) continue;
    identitySelections.push({
      serviceId,
      profileId,
      groupId: readRuntimeAuthSelectionString(selectionRecord, 'groupId'),
      groupGeneration: readRuntimeAuthSelectionGeneration(selectionRecord),
      record: credentialRecord.data,
      source: 'codex_live_auth_apply',
    });
  }

  return identitySelections;
}

function shouldDowngradeLegacyImplicitTmuxRequest(params: Readonly<{
  terminal: SpawnSessionOptions['terminal'] | undefined;
  backendTarget: BackendTargetRefV1 | undefined;
}>): boolean {
  if (params.terminal?.mode !== 'tmux') {
    return false;
  }
  const tmuxOptions = params.terminal.tmux;
  const hasExplicitTmuxConfig = tmuxOptions !== undefined && (
    tmuxOptions.sessionName !== undefined
    || tmuxOptions.isolated !== undefined
    || tmuxOptions.tmpDir !== undefined
  );
  if (hasExplicitTmuxConfig) {
    return false;
  }
  return params.backendTarget === undefined;
}

function readConnectedServiceBindingString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toConnectedServiceSwitchEffectiveBinding(
  serviceId: ConnectedServiceId,
  binding: ConnectedServiceBindingsV1['bindingsByServiceId'][string],
): ConnectedServiceSwitchEffectiveBinding | null {
  if (binding.source !== 'connected') return null;
  const selection = readConnectedServiceBindingString(binding.selection);
  if (selection === 'group') {
    const groupId = readConnectedServiceBindingString(binding.groupId);
    if (!groupId) return null;
    const profileId = readConnectedServiceBindingString(binding.profileId);
    return {
      source: 'connected',
      selection: 'group',
      serviceId,
      profileId: profileId || null,
      groupId,
    };
  }
  const profileId = readConnectedServiceBindingString(binding.profileId);
  if (!profileId) return null;
  return {
    source: 'connected',
    selection: 'profile',
    serviceId,
    profileId,
    groupId: null,
  };
}

function resolveConnectedServiceRestartProcessGroupPid(tracked: TrackedSession): number | null {
  return tracked.startedBy === 'daemon' && tracked.childProcess && Number.isInteger(tracked.pid) && tracked.pid > 0
    ? tracked.pid
    : null;
}

async function listRetainedConnectedServiceMaterializationIdentityIds(params: Readonly<{
  credentials: Credentials;
}>): Promise<ReadonlySet<string>> {
  const retained = new Set<string>();
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < 50; page += 1) {
    const result = await fetchSessionsPage({
      token: params.credentials.token,
      ...(cursor ? { cursor } : {}),
      limit: 200,
    });
    for (const rawSession of result.sessions as ReadonlyArray<RawSessionRecord>) {
      const metadata = tryDecryptSessionMetadata({
        credentials: params.credentials,
        rawSession,
      });
      const identity = readConnectedServiceMaterializationIdentityV1(
        metadata?.connectedServiceMaterializationIdentityV1,
      );
      if (identity) retained.add(identity.id);
    }
    if (!result.hasNext || !result.nextCursor) break;
    if (seenCursors.has(result.nextCursor)) break;
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  return retained;
}

async function resumeInactiveSessionWhenUsageLimitReady(params: Readonly<{
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  fallbackMachineId: string;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
}>): Promise<boolean> {
  const spawnOptions = buildInactiveUsageLimitResumeSpawnOptions({
    sessionId: params.sessionId,
    fallbackMachineId: params.fallbackMachineId,
    rawSession: params.rawSession,
    metadata: params.metadata,
  });
  if (!spawnOptions) return false;
  const result = await params.spawnSession(spawnOptions);
  return result.type === 'success';
}

async function persistExplicitSessionStopRecoveryCancellation(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
}>): Promise<void> {
  const rawSession = await fetchSessionByIdCompat({
    token: params.credentials.token,
    sessionId: params.sessionId,
  });
  if (!rawSession) return;
  await persistExplicitSessionStopUsageLimitRecoveryCancellation({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId: params.sessionId,
    rawSession,
  });
}

async function resolvePersistedConnectedServiceSwitchSessionMetadata(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  agentId: CatalogAgentId;
}>): Promise<Record<string, unknown> | null> {
  const token = typeof params.credentials.token === 'string' ? params.credentials.token.trim() : '';
  if (!token) return null;
  const attachContext = await resolveExistingSessionAttachContext({
    token,
    sessionId: params.sessionId,
    agent: params.agentId,
    credentials: params.credentials,
  }).catch(() => null);
  return attachContext?.ok ? attachContext.metadata : null;
}

async function resolveDurableConnectedServiceRuntimeAuthRecoverySession(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  serviceId?: ConnectedServiceId | string | null;
}>): Promise<TrackedSession | null> {
  const inactive = await resolveInactiveConnectedServiceSessionForAuthSwitch({
    credentials: params.credentials,
    sessionId: params.sessionId,
    agentId: resolveCatalogAgentId(null),
  });
  if (!inactive) return null;
  const serviceId = readNonEmptyMetadataString(params.serviceId);
  if (serviceId && !inactive.connectedServices.bindingsByServiceId[serviceId]) return null;
  const directory = readNonEmptyMetadataString(inactive.cwd)
    ?? readNonEmptyMetadataString(inactive.metadata?.path);
  if (!directory) return null;

  const baseSpawnOptions: SpawnSessionOptions = {
    existingSessionId: params.sessionId,
    directory,
    backendTarget: { kind: 'builtInAgent', agentId: inactive.agentId },
    approvedNewDirectoryCreation: true,
    connectedServices: inactive.connectedServices,
    ...(inactive.vendorResumeId ? { resume: inactive.vendorResumeId } : {}),
    ...(inactive.connectedServiceMaterializationIdentityV1
      ? { connectedServiceMaterializationIdentityV1: inactive.connectedServiceMaterializationIdentityV1 }
      : {}),
  };
  const spawnOptions = resolveSessionRuntimeSnapshot({
    incomingOptions: baseSpawnOptions,
    persistedMetadata: inactive.metadata ?? null,
  }).spawnOptions;

  return {
    startedBy: 'daemon',
    happySessionId: params.sessionId,
    pid: 0,
    reattachedFromDiskMarker: true,
    spawnOptions,
    ...(inactive.metadata ? { happySessionMetadataFromLocalWebhook: inactive.metadata as Metadata } : {}),
    ...(inactive.vendorResumeId ? { vendorResumeId: inactive.vendorResumeId } : {}),
  };
}

async function persistSessionConnectedServiceBindings(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  normalizedBindings: ReturnType<typeof readConnectedServiceBindingsOrEmpty>;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
}>): Promise<void> {
  const rawSession = await fetchSessionByIdCompat({
    token: params.credentials.token,
    sessionId: params.sessionId,
  });
  if (!rawSession) {
    throw new Error('Session not found while persisting connected-service auth binding');
  }
  await updateSessionMetadataWithRetry({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId: params.sessionId,
    rawSession,
    updater: (metadata) => {
      const existingUpdatedAt = typeof metadata.connectedServicesUpdatedAt === 'number'
        && Number.isFinite(metadata.connectedServicesUpdatedAt)
        ? metadata.connectedServicesUpdatedAt
        : 0;
      const existingMaterializationIdentity = readConnectedServiceMaterializationIdentityV1(
        metadata.connectedServiceMaterializationIdentityV1,
      );
      const nextMaterializationIdentity =
        existingMaterializationIdentity ?? params.connectedServiceMaterializationIdentityV1 ?? null;
      return {
        ...metadata,
        connectedServices: params.normalizedBindings,
        connectedServicesUpdatedAt: Math.max(Date.now(), existingUpdatedAt + 1),
        ...(nextMaterializationIdentity
          ? { connectedServiceMaterializationIdentityV1: nextMaterializationIdentity }
          : {}),
      };
    },
    maxAttempts: 6,
  });
}

let lastTerminalControlServiceabilityObservation = 0;

function nextTerminalControlServiceabilityObservation(): number {
  lastTerminalControlServiceabilityObservation = Math.max(
    Date.now(),
    lastTerminalControlServiceabilityObservation + 1,
  );
  return lastTerminalControlServiceabilityObservation;
}

async function publishTerminalControlServiceability(params: Readonly<{
  credentials: Credentials;
  happyHomeDir: string;
  sessionId: string;
  attachmentId: string;
  state: 'servable' | 'recoverable_unservable' | 'unknown';
  observedAt: number;
  reason?: string;
}>): Promise<boolean> {
  const attachmentBeforeFetch = await readTerminalAttachmentInfo({
    happyHomeDir: params.happyHomeDir,
    sessionId: params.sessionId,
  });
  if (attachmentBeforeFetch?.version !== 2 || attachmentBeforeFetch.attachmentId !== params.attachmentId) return false;
  const rawSession = await fetchSessionByIdCompat({ token: params.credentials.token, sessionId: params.sessionId });
  if (!rawSession) return false;
  const attachmentBeforeUpdate = await readTerminalAttachmentInfo({
    happyHomeDir: params.happyHomeDir,
    sessionId: params.sessionId,
  });
  if (attachmentBeforeUpdate?.version !== 2 || attachmentBeforeUpdate.attachmentId !== params.attachmentId) return false;
  await updateSessionMetadataWithRetry({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId: params.sessionId,
    rawSession,
    updater: (metadata) => applyTerminalControlServiceabilityProjection({
      metadata,
      evidence: {
        attachmentId: params.attachmentId,
        state: params.state,
        observedAt: params.observedAt,
        ...(params.reason ? { reason: params.reason } : {}),
      },
    }),
  });
  return true;
}

async function publishCurrentTerminalControlServiceability(params: Readonly<{
  credentials: Credentials;
  happyHomeDir: string;
  sessionId: string;
  state: 'servable' | 'recoverable_unservable' | 'unknown';
  reason?: string;
}>): Promise<boolean> {
  const observedAt = nextTerminalControlServiceabilityObservation();
  const attachment = await readTerminalAttachmentInfo({
    happyHomeDir: params.happyHomeDir,
    sessionId: params.sessionId,
  });
  if (attachment?.version !== 2) return false;
  return await publishTerminalControlServiceability({
    ...params,
    attachmentId: attachment.attachmentId,
    observedAt,
  });
}

async function publishProviderAccountUsageRecordIdToSessionMetadata(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  recordId: string;
}>): Promise<void> {
  const rawSession = await fetchSessionByIdCompat({
    token: params.credentials.token,
    sessionId: params.sessionId,
  });
  if (!rawSession) {
    throw new Error('Session not found while publishing provider account usage ref');
  }
  await updateSessionMetadataWithRetry({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId: params.sessionId,
    rawSession,
    updater: (metadata) => writeProviderAccountUsageRecordIdToMetadata(metadata, {
      recordId: params.recordId,
      updatedAtMs: Date.now(),
    }),
    maxAttempts: 6,
  });
}

export async function resolveContinuationResumePromptMode(input: Readonly<{
  credentials?: Credentials;
  serviceId?: ConnectedServiceId;
  groupId?: string | null;
  explicit?: unknown;
  readAccountSettings?: () => unknown;
  loadGroupPolicy?: () => Promise<unknown> | unknown;
}>): Promise<SessionContinuationResumePromptModeV1> {
  const readAccountSettings = input.readAccountSettings
    ?? (() => getActiveAccountSettingsSnapshot()?.settings ?? null);
  const loadGroupPolicy = input.loadGroupPolicy ?? (input.credentials && input.serviceId && input.groupId
    ? async () => {
      const api = await createConnectedServiceCredentialApi(input.credentials!);
      const group = await api.getConnectedServiceAuthGroup({
        serviceId: input.serviceId!,
        groupId: input.groupId!,
      });
      return group?.policy ?? null;
    }
    : undefined);
  return await resolveRoutedUsageLimitRecoveryResumePromptMode({
    explicit: input.explicit,
    accountSettings: readAccountSettings(),
    loadGroupPolicy,
  });
}

function readContinuationCustomResumePrompt(
  settings: AccountSettings | null | undefined,
): string | null {
  return settings?.usageLimitRecoverySettingsV1?.customResumePrompt ?? null;
}

function createConnectedServiceContinuationHandler(params: Readonly<{
  credentials: Credentials;
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

export function resolveConnectedServiceContinuationInterruptionForSwitch(input: Readonly<{
  sessionId: string;
  interruptedSessionId?: string | null;
  action: 'hot_applied' | 'restart_requested';
  switchReason?: ConnectedServiceSessionAuthSwitchReason;
  groupSwitchTriggerReason?: string;
  failureDriven?: boolean;
  turnDeferralQueue: ConnectedServiceSwitchDeferralQueue;
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
  serviceId: ConnectedServiceId;
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
    const serviceId = ConnectedServiceIdSchema.safeParse(input.result.serviceId);
    const groupId = input.result.groupId.trim();
    if (serviceId.success && groupId) {
      currentTargetSettled = await input.reconcileCurrentRuntimeAuthTarget({
        sessionId: input.sessionId,
        serviceId: serviceId.data,
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
  serviceId: ConnectedServiceId;
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

const PREVIOUS_RUNNER_RETIRED_RESPAWN_TERMINAL_REASONS = new Set<SessionRunnerRespawnTerminalReason>([
  'already_running',
  'stop_requested',
  'missing_spawn_options',
  'directory_approval_required',
  'not_authenticated',
  'resume_unreachable',
  'no_restart',
]);

export function doesRestartCompletionProvePreviousRunnerRetired(
  completion: RestartSessionRunnerCompletion,
): boolean {
  if (completion.ok) return true;
  const reason = completion.diagnostics?.respawnTerminalReason;
  return typeof reason === 'string'
    && PREVIOUS_RUNNER_RETIRED_RESPAWN_TERMINAL_REASONS.has(reason as SessionRunnerRespawnTerminalReason);
}

function resolveTrackedContinuationRecoveryIdentities(input: Readonly<{
  sessionId: string;
  runtimeBindings: ReadonlyArray<ConnectedServiceRuntimeBindingIdentity>;
  recoveryIntents: ReadonlyArray<RuntimeAuthRecoveryIntent>;
}>): readonly SessionContinuationRecoveryIdentityV1[] {
  return listProviderActivityRecoveryIdentitiesFromRuntimeBindings(
    input.runtimeBindings,
    input.recoveryIntents,
  );
}

export async function resolveSessionConnectedServiceSwitchContinuity(input: Readonly<{
  sessionId: string;
  agentId: CatalogAgentId;
  serviceId: ConnectedServiceId;
  previousBinding: Readonly<{
    source: 'native' | 'connected';
    selection: 'native' | 'profile' | 'group';
    serviceId: ConnectedServiceId;
    profileId: string | null;
    groupId: string | null;
  }> | null;
  nextBinding: Readonly<{
    source: 'native' | 'connected';
    selection: 'native' | 'profile' | 'group';
    serviceId: ConnectedServiceId;
    profileId: string | null;
    groupId: string | null;
  }>;
  fromBindingsRaw: unknown;
  toBindings: ReturnType<typeof readConnectedServiceBindingsOrEmpty>;
  accountSettings: AccountSettings | null;
  runtimeAuthSelection?: unknown;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1 | null;
  vendorResumeId?: string | null;
  targetMaterializedRoot?: string | null;
  targetMaterializedEnv?: Readonly<Record<string, string>> | null;
  cwd?: string | null;
  candidatePersistedSessionFile?: string | null;
}>) {
  const continuity = await resolveConnectedServiceSwitchContinuity(input.agentId, {
    sessionId: input.sessionId,
    agentId: input.agentId,
    serviceId: input.serviceId,
    previousBinding: input.previousBinding,
    nextBinding: input.nextBinding,
    fromBindings: readConnectedServiceBindingsOrEmpty(input.fromBindingsRaw),
    toBindings: input.toBindings,
    ...(input.connectedServiceMaterializationIdentityV1
      ? { connectedServiceMaterializationIdentityV1: input.connectedServiceMaterializationIdentityV1 }
      : {}),
    ...(input.vendorResumeId ? { vendorResumeId: input.vendorResumeId } : {}),
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
    return resolveSharedStateRequiredSwitchContinuity({
      agentId: input.agentId,
      accountSettings: input.accountSettings,
      warnings: continuity.reason ? [continuity.reason] : [],
      serviceId: input.serviceId,
      targetMaterializedRoot: input.targetMaterializedRoot ?? null,
      targetMaterializedEnv: input.targetMaterializedEnv ?? null,
      materializationIdentity: input.connectedServiceMaterializationIdentityV1 ?? null,
      vendorResumeId: input.vendorResumeId ?? null,
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

function buildMaterializationIdentityMissingSpawnErrorResult(input: Readonly<{
  agentId: CatalogAgentId;
  reason: string;
}>): Extract<SpawnSessionResult, { type: 'error' }> {
  return buildConnectedServiceDiagnosticSpawnValidationErrorResult({
    errorMessage: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing,
    uxDiagnostic: buildConnectedServiceUxDiagnostic({
      code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing,
      failurePhase: 'materialization',
      source: 'spawn_resume',
      agentId: input.agentId,
      retryable: false,
      diagnostics: {
        reason: input.reason,
      },
    }),
  });
}

function resolveCliSubcommandFromBackendTarget(target: BackendTargetRefV1 | undefined): CatalogAgentId | 'acp-catalog' {
  if (target?.kind === 'configuredAcpBackend') {
    return 'acp-catalog';
  }
  return resolveAgentCliSubcommand(readBuiltInCatalogAgentIdFromBackendTarget(target));
}

async function applyAlreadyRunningExistingSessionRuntimeSnapshot(params: Readonly<{
  sessionId: string;
  incomingOptions: SpawnSessionOptions;
  pidToTrackedSession: Map<number, TrackedSession>;
  credentials: Credentials;
}>): Promise<void> {
  const trackedSessions = Array.from(params.pidToTrackedSession.values())
    .filter((tracked) => tracked.happySessionId === params.sessionId);

  if (trackedSessions.length < 1) return;

  const storedCredentials = await readCredentials().catch(() => null);
  const effectiveCredentials = storedCredentials ?? params.credentials;
  const tokenForFetch = effectiveCredentials?.token ?? '';

  const attachContext = await resolveExistingSessionAttachContext({
    token: tokenForFetch,
    sessionId: params.sessionId,
    agent: params.incomingOptions.backendTarget?.kind === 'builtInAgent'
      ? params.incomingOptions.backendTarget.agentId
      : 'customAcp',
    credentials: effectiveCredentials,
  });

  if (!attachContext.ok) {
    logger.debug('[DAEMON RUN] Failed to resolve runtime snapshot for already-running session resume', {
      sessionId: params.sessionId,
      reason: attachContext.reason,
    });
    return;
  }

  for (const trackedSession of trackedSessions) {
    const runtimeSnapshot = resolveSessionRuntimeSnapshot({
      incomingOptions: params.incomingOptions,
      persistedMetadata: attachContext.metadata,
      persistedVendorResumeId: attachContext.vendorResumeId,
      trackedSpawnOptions: trackedSession.spawnOptions ?? null,
      trackedVendorResumeId: trackedSession.vendorResumeId ?? null,
    });
    trackedSession.spawnOptions = runtimeSnapshot.spawnOptions;
    const vendorResumeId = runtimeSnapshot.snapshot.vendorResumeId?.value;
    if (vendorResumeId) {
      trackedSession.vendorResumeId = vendorResumeId;
    }
  }
}

async function requestPendingQueueWake(params: Readonly<{
  sessionId: string;
  credentials: Credentials;
  isShutdownRequested?: () => boolean;
}>) {
  return await requestSessionPendingQueueWakeV1({
    sessionId: params.sessionId,
    token: params.credentials.token,
    isShutdownRequested: params.isShutdownRequested,
    resolveTransport: async () => await resolveSessionTransportContext({
      credentials: params.credentials,
      idOrPrefix: params.sessionId,
    }),
    callRpc: async (method, request, transport) => await callSessionRpc({
      token: params.credentials.token.trim(),
      sessionId: params.sessionId,
      mode: transport.mode as Parameters<typeof callSessionRpc>[0]['mode'],
      ctx: transport.ctx as Parameters<typeof callSessionRpc>[0]['ctx'],
      method,
      request,
    }),
    isMethodUnavailable: isRpcMethodNotAvailableError,
  });
}

async function probePendingQueueServiceability(params: Readonly<{
  sessionId: string;
  credentials: Credentials;
  isShutdownRequested?: () => boolean;
}>) {
  return await probeSessionPendingQueueWakeCapabilityV1({
    sessionId: params.sessionId,
    token: params.credentials.token,
    isShutdownRequested: params.isShutdownRequested,
    resolveTransport: async () => await resolveSessionTransportContext({
      credentials: params.credentials,
      idOrPrefix: params.sessionId,
    }),
    callRpc: async (method, request, transport) => await callSessionRpc({
      token: params.credentials.token.trim(),
      sessionId: params.sessionId,
      mode: transport.mode as Parameters<typeof callSessionRpc>[0]['mode'],
      ctx: transport.ctx as Parameters<typeof callSessionRpc>[0]['ctx'],
      method,
      request,
    }),
    isMethodUnavailable: isRpcMethodNotAvailableError,
  });
}

export async function sleepMsOrShutdown(delayMs: number, shutdownPromise: Promise<unknown>): Promise<'elapsed' | 'shutdown'> {
  if (delayMs <= 0) return 'elapsed';
  return await new Promise<'elapsed' | 'shutdown'>((resolveSleep) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      resolveSleep('elapsed');
    }, delayMs);
    timeout.unref?.();
    void shutdownPromise.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveSleep('shutdown');
    });
  });
}

async function nudgeAttachedExistingSessionPendingQueue(params: Readonly<{
  requestedExistingSessionId: string;
  resolved: SpawnSessionResult;
  credentials: Credentials;
  isShutdownRequested: () => boolean;
}>): Promise<SpawnSessionResult> {
  const requestedSessionId = params.requestedExistingSessionId.trim();
  if (!requestedSessionId || params.resolved.type !== 'success') {
    return params.resolved;
  }

  const resolvedSessionId = typeof params.resolved.sessionId === 'string'
    ? params.resolved.sessionId.trim()
    : '';
  if (!resolvedSessionId) {
    return params.resolved;
  }

  if (resolvedSessionId !== requestedSessionId) {
    logger.debug('[DAEMON RUN] Skipping pending queue nudge for attach spawn because resolved session id does not match requested existing session id', {
      requestedSessionId,
      resolvedSessionId,
    });
    return params.resolved;
  }

  publishSessionPendingQueueWake({
    sessionId: resolvedSessionId,
    isShutdownRequested: params.isShutdownRequested,
    logLabel: 'attach',
    requestWake: async () => await requestPendingQueueWake({
      sessionId: resolvedSessionId,
      credentials: params.credentials,
      isShutdownRequested: params.isShutdownRequested,
    }),
  });
  return params.resolved;
}

function readAccountSettingsChangedHintVersion(update: unknown): number | null {
  if (!update || typeof update !== 'object') return null;
  const body = (update as { body?: unknown }).body;
  if (!body || typeof body !== 'object') return null;
  if ((body as { t?: unknown }).t !== 'account-settings-changed') return null;
  return normalizeAccountSettingsVersionHint((body as { settingsVersion?: unknown }).settingsVersion);
}

async function refreshDaemonAccountSettingsForHint(params: Readonly<{
  credentials: Credentials;
  settingsVersion: number | null;
}>): Promise<boolean> {
  await refreshAccountSettingsForMinimumVersion({
    credentials: params.credentials,
    minSettingsVersion: params.settingsVersion,
    mode: 'blocking',
    forceRefresh: true,
  });
  return true;
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

function mapExistingSessionAttachFailureToSpawnError(reason: import('./sessionEncryption/resolveExistingSessionAttachContext').ExistingSessionAttachContextFailureReason): SpawnSessionResult {
  switch (reason) {
    case 'missingSessionId':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Existing session id is required for resume attach.',
      };
    case 'missingToken':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Missing auth token to fetch existing session for resume.',
      };
    case 'notAuthenticated':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'not_authenticated',
      };
    case 'sessionNotFound':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Existing session not found or access denied for resume.',
      };
    case 'fetchFailed':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Failed to fetch existing session for resume.',
      };
    case 'missingCredentials':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
        errorMessage: 'Missing credentials to open the session encryption key for resume.',
      };
    case 'invalidEncryptionKey':
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
        errorMessage: 'Failed to open session encryption key for resume.',
      };
  }
}

export async function startDaemon(options: Readonly<{ takeover?: boolean }> = {}): Promise<void> {
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  const {
    requestShutdown,
    isShutdownRequested: isDaemonShutdownRequested = () => false,
    resolvesWhenShutdownRequested,
  } = createDaemonShutdownController();

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());
  const diagnosticSubsystemGates = resolveDaemonDiagnosticSubsystemGates(process.env);

  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const { waitForAuthEnabled, waitForAuthTimeoutMs } = resolveWaitForAuthConfig(process.env);

  let daemonLockHandle: Awaited<ReturnType<typeof acquireDaemonLock>> = null;
  let publishedDaemonStateOwner: Readonly<{ pid: number; startedAt: number }> | null = null;
  const inheritedRuntimeId = String(process.env.HAPPIER_DAEMON_RUNTIME_ID ?? '').trim();
  const runtimeId = inheritedRuntimeId || randomUUID();
  const startupSource = resolveDaemonStartupSourceFromEnv(process.env);
  const selfRestartCorrelationId = String(process.env.HAPPIER_DAEMON_SELF_RESTART_CORRELATION_ID ?? '').trim();
  assertCurrentDaemonSelfRestartAuthorization({
    startupSource,
    correlationId: selfRestartCorrelationId,
    deadlineMs: process.env.HAPPIER_DAEMON_SELF_RESTART_DEADLINE_MS,
  });
  const serviceLabel = resolveDaemonServiceLabelFromEnv(process.env);
  const takeoverRequested = startupSource === 'self-restart'
    ? true
    : options.takeover ?? resolveDaemonTakeoverRequestedFromEnv(process.env);

  try {
    const ownership = await evaluateCurrentDaemonOwner();
    const takeoverDecision = resolveDaemonTakeoverDecision({
      ownership,
      takeoverRequested,
      startupSource,
    });
    if (takeoverDecision.kind === 'conflict') {
      const error = new DaemonOwnershipConflictError({
        intent: 'daemon-start',
        owner: takeoverDecision.owner,
      });
      logger.warn('[DAEMON RUN] Daemon ownership conflict prevented daemon startup', {
        title: error.title,
        lines: error.lines,
      });
      throw error;
    }

    const startupServiceConflict = await evaluateDaemonStartupServiceConflict({
      startupSource,
      runtime: resolveDaemonServiceCliRuntimeFromEnv({ processEnv: process.env }),
    });
    if (startupServiceConflict.kind === 'installed-background-service-conflict') {
      const error = new DaemonStartupConflictError({
        action: 'daemon-start-sync',
        services: startupServiceConflict.services,
      });
      logger.warn('[DAEMON RUN] Installed background service prevented manual daemon startup', {
        title: error.title,
        lines: error.lines,
      });
      throw error;
    }

    if (takeoverDecision.kind === 'manual-owner-takeover' || takeoverDecision.kind === 'manual-owner-replace') {
      const takeoverNotice = buildDaemonTakeoverNotice({ action: 'start-sync' });
      logger.warn(
        takeoverDecision.kind === 'manual-owner-takeover'
          ? '[DAEMON RUN] Daemon takeover requested; replacing the current manual daemon runtime'
          : '[DAEMON RUN] Replacing the current stale manual daemon runtime before startup',
        {
          runtimeId,
          ownerCliVersion: takeoverDecision.owner.state.startedWithCliVersion,
          ownerReleaseChannel: takeoverDecision.owner.state.startedWithPublicReleaseChannel,
          title: takeoverNotice.title,
          lines: takeoverNotice.lines,
        },
      );
      await stopDaemon();
      if (takeoverDecision.owner.source === 'process') {
        await forceStopKnownDaemonPid(takeoverDecision.owner.state.pid);
      }
    }

    const preservedOwnerPids =
      ownership.kind === 'compatible' || (ownership.kind === 'conflict' && takeoverDecision.kind === 'ok')
        ? [ownership.owner.state.pid]
        : [];
    try {
      const orphanReapResult = await reapSameHomeDaemonOrphansBeforeStart({
        preservePids: preservedOwnerPids,
      });
      if (
        orphanReapResult.stoppedPids.length > 0
        || orphanReapResult.failedPids.length > 0
      ) {
        logger.debug('[DAEMON RUN] Same-home daemon orphan reap complete', orphanReapResult);
      }
    } catch (error) {
      logger.warn('[DAEMON RUN] Same-home daemon orphan reap failed', error);
    }

    const credentialsGate = await waitForInitialCredentials({
      isInteractive,
      waitForAuthEnabled,
      waitForAuthTimeoutMs,
      credentialsPath: configuration.privateKeyFile,
      refresh: () => reloadConfiguration(),
      readCredentials,
      acquireDaemonLock: () => acquireDaemonLock(5, 200),
      releaseDaemonLock,
      resolvesWhenShutdownRequested,
      logger,
      daemonLockHandle,
    });
    if (credentialsGate.action === 'exit') {
      process.exit(credentialsGate.exitCode);
    }
    if (credentialsGate.action === 'shutdown') {
      return;
    }
    daemonLockHandle = credentialsGate.daemonLockHandle;

    // Ensure auth and machine registration BEFORE we take the daemon lock.
    // This prevents stuck lock files when auth is interrupted or cannot proceed.
    const auth = await authAndSetupMachineIfNeeded();
    const credentials = auth.credentials;
    let machineId = auth.machineId;
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    const api = await ApiClient.create(credentials);
    const resolveCurrentConnectedServiceCredentialRevision = async (
      serviceId: ConnectedServiceId,
      profileId: string | null,
    ) => {
      if (!profileId) return null;
      const resolved = await resolveConnectedServiceCredentialsWithRevisions({
        credentials,
        api,
        bindings: [{ serviceId, profileId }],
      }).then((byServiceId) => byServiceId.get(serviceId) ?? null);
      return resolved?.revisionSemantics === 'revisioned'
        ? resolved.credentialRevision
        : null;
    };
    const resolveProviderQualifiedRuntimeAuthFailureSource = async (input: Readonly<{
      classification: ConnectedServiceRuntimeFailureClassification;
    }>) => {
      const serviceId = ConnectedServiceIdSchema.safeParse(input.classification.serviceId);
      const groupId = typeof input.classification.groupId === 'string'
        ? input.classification.groupId.trim()
        : '';
      if (!serviceId.success || !groupId) return input.classification;
      return await resolveRuntimeAuthFailureSourceProfile({
        classification: input.classification,
        getGroupMembers: async () => {
          const group = await api.getConnectedServiceAuthGroup({
            serviceId: serviceId.data,
            groupId,
          });
          return group?.members ?? null;
        },
        resolveProviderAccountId: async (profileId) => {
          const resolved = await resolveConnectedServiceCredentialsWithRevisions({
            credentials,
            api,
            bindings: [{ serviceId: serviceId.data, profileId }],
          }).then((byServiceId) => byServiceId.get(serviceId.data) ?? null);
          return resolved
            ? readCredentialAccountIdentity(resolved.record)?.providerAccountId ?? null
            : null;
        },
      });
    };
    const preferredHost = await getPreferredHostName();
    const metadataForRegistration: MachineMetadata = { ...initialMachineMetadata, host: preferredHost };
    let preflightMachineRegistration: Awaited<ReturnType<typeof ensureMachineRegistered>> | null = null;

    const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledHappyVersion({
      expectedMachineId: machineId,
    });
    const machinePreflightDecision = resolveStartDaemonMachinePreflightDecision({
      runningDaemonVersionMatches,
      startupSource,
    });
    if (machinePreflightDecision === 'stop_current_daemon') {
      logger.debug('[DAEMON RUN] Daemon version or machine identity mismatch detected, restarting daemon with current CLI version');
      await stopDaemon();
    } else if (machinePreflightDecision === 'skip_sync_preflight_for_self_restart') {
      logger.debug('[DAEMON RUN] Self-restart replacement detected matching daemon; skipping synchronous machine preflight and continuing takeover');
    } else {
      preflightMachineRegistration = await ensureMachineRegistered({
        api,
        machineId,
        metadata: metadataForRegistration,
        caller: 'startDaemon preflight',
      });
      machineId = preflightMachineRegistration.machineId;
      if (preflightMachineRegistration.didRotateMachineId) {
        logger.debug('[DAEMON RUN] Same-version daemon matched a stale machine id, restarting daemon with recovered machine identity');
        await stopDaemon();
      } else {
        logger.debug('[DAEMON RUN] Daemon version and machine identity match, keeping existing daemon');
        console.log('Daemon already running with matching version');
        process.exit(0);
      }
    }

    // Acquire exclusive lock (proves daemon is running)
    if (!daemonLockHandle) {
      daemonLockHandle = await acquireDaemonLock(5, 200);
    }
    if (!daemonLockHandle) {
      logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
      process.exit(0);
    }

    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

    // FIX-1a (incident Jun-11 H-A): populate the in-memory account-settings snapshot at daemon
    // startup, best-effort. Without this, every `getActiveAccountSettingsSnapshot()` consumer
    // (switch continuity, resume prompts, materializers) ran against NULL settings until the
    // first spawn/settings-changed hint arrived — a common steady state under frequent daemon
    // restarts. Fail-open: a failure here only delays freshness; hint paths still refresh.
    void warmActiveAccountSettingsSnapshotBestEffort({ credentials });

        // Setup state - key by PID
        const pidToTrackedSession = new Map<number, TrackedSession>();
        const spawnResourceCleanupByPid = new Map<number, () => void>();
        const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
      const connectedServicesMaterializationBaseDir = join(configuration.happyHomeDir, 'daemon', 'connected-services', 'materialized');
      let connectedServiceRefreshCoordinator: ConnectedServiceRefreshCoordinator | null = null;
      const prepareAuthGroupCandidateForSwitch = async (input: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        profileId: string;
        reason: string;
      }>) => {
        const refreshService = connectedServiceRefreshCoordinator;
        if (!refreshService) {
          return {
            status: 'ineligible' as const,
            memberState: { credentialHealthStatus: 'refresh_failed_retryable' as const },
          };
        }
        return await prepareConnectedServiceAuthGroupCandidateForSwitch({
          serviceId: input.serviceId,
          profileId: input.profileId,
          reason: input.reason,
          refreshService,
        });
      };
      const validateConnectedServiceGroupMutationCurrentness =
        createConnectedServiceGroupMutationCurrentnessValidator({ api, credentials });
      let connectedServiceRefreshLoopHandle: Readonly<{
        stop: () => void;
        pause: () => void;
        resume: () => void;
      }> | null = null;
      let connectedServiceQuotasCoordinator: ConnectedServiceQuotasCoordinator | null = null;
      let connectedServiceStableHomeReconcileHandle: Readonly<{ stop: () => void }> | null = null;
      const connectedServiceRuntimeRegistry = new ConnectedServiceRuntimeRegistry();
      const connectedServiceRuntimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
      const providerAccountUsageStore = createProviderAccountUsageStore();
      const connectedServiceContinuationApplicationCorrelation =
        createConnectedServiceContinuationApplicationCorrelation<
          Readonly<{
            interruptedOriginId: string;
            resumePromptMode: SessionContinuationResumePromptModeV1;
            customResumePrompt: string | null;
          }>
        >();
      const clearMemberRuntimeStateWithPositiveEvidenceForTarget = async (
        target: ConnectedServiceRuntimeTarget | null,
        evidence: ConnectedServiceAuthGroupPositiveEvidence,
      ): Promise<void> => {
        if (!target) return;
        const candidates = new Map<string, Readonly<{
          serviceId: ConnectedServiceId;
          groupId: string;
          profileId: string;
          generation: number;
        }>>();
        for (const active of target.activeBindings) {
          if (!active.groupId || active.generation === null) continue;
          candidates.set(`${active.serviceId}\0${active.groupId}\0${active.profileId}\0${active.generation}`, {
            serviceId: active.serviceId,
            groupId: active.groupId,
            profileId: active.profileId,
            generation: active.generation,
          });
        }
        for (const candidate of candidates.values()) {
          await persistMemberRuntimeStateWithPositiveEvidence({
            api,
            serviceId: candidate.serviceId,
            groupId: candidate.groupId,
            profileId: candidate.profileId,
            generation: candidate.generation,
            evidence,
            normalizePolicy: normalizeConnectedServiceAuthGroupPolicy,
          }).catch((error) => {
            logger.debug('[DAEMON RUN] Failed to clear connected-service member runtime-state with positive evidence', {
              serviceId: candidate.serviceId,
              groupId: candidate.groupId,
              profileId: candidate.profileId,
              evidenceKind: evidence.kind,
              error: serializeAxiosErrorForLog(error),
            });
          });
        }
      };
      const clearMemberRuntimeStateWithSuccessfulSpawnEvidence = (target: ConnectedServiceRuntimeTarget): void => {
        void clearMemberRuntimeStateWithPositiveEvidenceForTarget(
          target,
          { kind: 'successful_spawn', observedAtMs: Date.now() },
        );
      };
      const providerAccountUsagePersistence = createProviderAccountUsagePersistenceScheduler({
        api,
        now: () => Date.now(),
        credentials,
        randomBytes: (length) => randomBytes(length),
        serverScope: configuration.serverUrl,
        accountScope: machineId,
      });
      const connectedServiceAuthGroupSwitchLeases = new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry();
      const connectedServiceRuntimeAuthSwitchAttempts = new ConnectedServiceRuntimeAuthSwitchAttemptTracker({
        nowMs: () => Date.now(),
        windowMs: resolvePositiveIntEnv(
          process.env.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_SWITCH_ATTEMPT_WINDOW_MS,
          10 * 60_000,
          { min: 1_000, max: 24 * 60 * 60_000 },
        ),
      });
      const connectedServiceSessionAuthSwitchCore = createConnectedServiceSessionAuthSwitchCore();
      const inactiveUsageLimitRecoveryCheckOwner = createInactiveUsageLimitRecoveryCheckOwner();
      const inactiveUsageLimitRecoveryRunnerUnavailableRetryDelayMs = resolvePositiveIntEnv(
        process.env.HAPPIER_USAGE_LIMIT_RECOVERY_RUNNER_UNAVAILABLE_RETRY_DELAY_MS,
        60_000,
        { min: 1_000, max: 60 * 60_000 },
      );
      const inactiveUsageLimitRecoveryWakeCoalesceWindowMs = resolvePositiveIntEnv(
        process.env.HAPPIER_USAGE_LIMIT_RECOVERY_WAKE_COALESCE_WINDOW_MS,
        1_000,
        { min: 1, max: 60_000 },
      );
      const recordConnectedServiceRestartDiagnostic = (record: ConnectedServiceDaemonRestartDiagnosticRecord) => {
        logConnectedServiceDaemonRestartDiagnostic(record);
      };
      const inactiveUsageLimitRecoveryScheduler = new UsageLimitRecoveryScheduler({
        nowMs: () => Date.now(),
        store: createRecoveryIntentFileStore<SessionUsageLimitRecoveryV1>(join(
          configuration.activeServerDir,
          'connected-services',
          'inactive-usage-limit-recovery.json',
        )),
        recordRestartDiagnostic: recordConnectedServiceRestartDiagnostic,
        gate: createUsageLimitRecoveryWakeGate({
          nowMs: () => Date.now(),
          hasRunner: (sessionId) => inactiveUsageLimitRecoveryCheckOwner.hasRunner(sessionId),
          runnerUnavailableRetryDelayMs: inactiveUsageLimitRecoveryRunnerUnavailableRetryDelayMs,
          coalesceWindowMs: inactiveUsageLimitRecoveryWakeCoalesceWindowMs,
        }),
        recover: async (_intent, { sessionId }) => {
          if (!inactiveUsageLimitRecoveryCheckOwner.hasRunner(sessionId)) {
            return {
              status: 'wait',
              nextCheckAtMs: Date.now() + inactiveUsageLimitRecoveryRunnerUnavailableRetryDelayMs,
              lastProbeError: 'usage_limit_recovery_check_runner_unavailable',
            };
          }
          const result = await inactiveUsageLimitRecoveryCheckOwner.run(sessionId);
          return resolveInactiveUsageLimitRecoverySchedulerResult({
            result,
            nowMs: Date.now(),
            fallbackRetryDelayMs: 60_000,
          });
        },
      });
      const hydratedInactiveUsageLimitRecoveries = inactiveUsageLimitRecoveryScheduler.hydratePassive();
      if (hydratedInactiveUsageLimitRecoveries.length > 0) {
        logger.debug('[DAEMON RUN] Hydrated inactive usage-limit recovery intents', {
          count: hydratedInactiveUsageLimitRecoveries.length,
        });
      }
      let connectedServiceGroupDeletionAuthorityUnavailableLogged = false;
      const resolveConnectedServiceGroupDeletionAuthority = async ({ serviceId, groupId }: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
      }>): Promise<Readonly<{ status: 'exists' | 'deleted' | 'unknown' }>> => {
        try {
          const group = await api.getConnectedServiceAuthGroup({ serviceId, groupId });
          return group === null ? { status: 'deleted' } : { status: 'exists' };
        } catch (error) {
          if (!isConnectedServiceAuthGroupUnavailableError(error)) throw error;
          if (!connectedServiceGroupDeletionAuthorityUnavailableLogged) {
            connectedServiceGroupDeletionAuthorityUnavailableLogged = true;
            logger.debug('[DAEMON RUN] Connected-service auth group deletion authority unavailable; skipping group-home deletion until server support is confirmed', error);
          }
          return { status: 'unknown' };
        }
      };
      const connectedServiceGroupHomeCleanupScheduler = new ConnectedServiceGroupHomeCleanupScheduler({
        activeServerDir: configuration.activeServerDir,
        hasLiveTarget: ({ serviceId, groupId, agentId }) => getCurrentChildren().some((tracked) => {
          const trackedAgentId = resolveTrackedSessionCatalogAgentId(tracked);
          if (trackedAgentId !== agentId) return false;
          return hasTrackedConnectedServiceGroupBinding({
            tracked,
            serviceId,
            groupId,
          });
        }),
        resolveGroupDeletionAuthority: resolveConnectedServiceGroupDeletionAuthority,
      });
      const connectedServiceMaterializedHomeCleanupScheduler = new ConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir: connectedServicesMaterializationBaseDir,
        nowMs: () => Date.now(),
        rootTtlMs: resolvePositiveIntEnv(
          process.env.HAPPIER_CONNECTED_SERVICES_MATERIALIZED_HOME_TTL_MS,
          30 * 24 * 60 * 60_000,
          { min: 60_000, max: 365 * 24 * 60 * 60_000 },
        ),
        attemptsTtlMs: resolvePositiveIntEnv(
          process.env.HAPPIER_CONNECTED_SERVICES_MATERIALIZED_ATTEMPTS_TTL_MS,
          60 * 60_000,
          { min: 60_000, max: 7 * 24 * 60 * 60_000 },
        ),
        hasLiveTarget: ({ materializationIdentityId, agentId }) => getCurrentChildren().some((tracked) => {
          const trackedAgentId = resolveTrackedSessionCatalogAgentId(tracked);
          if (trackedAgentId !== agentId) return false;
          return readTrackedConnectedServiceMaterializationIdentityId(tracked) === materializationIdentityId;
        }),
        listRetainedIdentityIds: async () =>
          await listRetainedConnectedServiceMaterializationIdentityIds({ credentials }),
      });
      let connectedServiceQuotasLoopHandle: ConnectedServiceQuotasLoopHandle | null = null;
      let connectedServiceMaterializedHomeCleanupLoopHandle: Readonly<{
        stop: () => void;
        trigger: () => void;
      }> | null = null;
      let daemonServerWorkOnline = true;
      const daemonServerWorkScheduler: DaemonServerWorkScheduler = createDaemonServerWorkScheduler({
        budget: createDaemonServerWorkBudget({
          maxConcurrentWrites: resolvePositiveIntEnv(
            process.env.HAPPIER_DAEMON_SERVER_WORK_MAX_CONCURRENT_WRITES,
            1,
            { min: 1, max: 8 },
          ),
        }),
        gate: () => daemonServerWorkOnline
          ? { status: 'open' }
          : { status: 'deferred', reason: 'offline' },
        logger,
      });
      let apiMachineForSessions: ApiMachineClient | null = null;
      let automationWorker: AutomationWorkerHandle | null = null;
      let memoryWorker: MemoryWorkerHandle | null = null;
      let apiMachine: ApiMachineClient | null = null;
      const eventLoopStallMonitor = createDaemonEventLoopStallMonitor({
        getActiveRpcOperations: () => apiMachineForSessions?.getActiveRpcHandlerExecutions() ?? [],
        warn: (message, data) => logger.warn(message, data),
      });
      eventLoopStallMonitor.start();
	      let machineConnectionStateCleanup: (() => void) | null = null;
	      let shutdownInitiated = false;
	      let connectedServiceQuotaProducersQuiesced = false;
	      let daemonConnectivityCoordinator: ReturnType<typeof createDaemonConnectivityCoordinator> | null = null;

        // Session spawning awaiter system
            const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
            const pidToSpawnResultResolver = new Map<number, (result: SpawnSessionResult) => void>();
            const pidToSpawnWebhookTimeout = new Map<number, NodeJS.Timeout>();
            const spawnConcurrencyGate = createSpawnConcurrencyGate(
              resolvePositiveIntEnv(process.env.HAPPIER_DAEMON_MAX_CONCURRENT_SPAWNS, 0, { min: 0, max: 64 }),
            );

        const resolveAcceptedExistingSessionStartup = async (
          sessionId: string,
          requestedSpawnNonce: string | undefined,
        ): Promise<SpawnSessionResult | null> => {
          for (const [pid, tracked] of pidToTrackedSession) {
            const trackedExistingSessionId = typeof tracked.spawnOptions?.existingSessionId === 'string'
              ? tracked.spawnOptions.existingSessionId.trim()
              : '';
            if (
              tracked.startedBy !== 'daemon'
              || tracked.pid !== pid
              || trackedExistingSessionId !== sessionId
              || !pidToAwaiter.has(pid)
            ) {
              continue;
            }
            const runState = await readProcessRunState(pid).catch(() => null);
            if (runState !== 'servable') continue;
            return {
              type: 'success',
              sessionId,
              runnerAcceptance: resolveExistingRunnerAcceptance({
                requestedSpawnNonce,
                trackedSpawnNonces: [tracked.spawnOptions?.spawnNonce],
              }),
            };
          }
          return null;
        };

        const spawnRecentSuccessTtlMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SPAWN_RECENT_SUCCESS_TTL_MS,
          2000,
          { min: 0, max: 60_000 },
        );
        const spawnRequestCoalescer = createSpawnRequestCoalescer({
          recentSuccessTtlMs: spawnRecentSuccessTtlMs,
        });
        const acceptedSpawnNonceTtlMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SPAWN_ACCEPTED_NONCE_TTL_MS,
          15 * 60_000,
          { min: 1000, max: 60 * 60_000 },
        );
        const daemonSpawnAttemptRegistry = createDaemonSpawnAttemptRegistry({
          ttlMs: acceptedSpawnNonceTtlMs,
        });
        const shutdownSpawnDrainGraceMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_MS,
          10_000,
          { min: 0, max: 120_000 },
        );
        const shutdownSpawnDrainPollMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SHUTDOWN_SPAWN_DRAIN_POLL_MS,
          100,
          { min: 10, max: 5_000 },
        );

	        let beforeShutdownOnce: Promise<void> | null = null;
	        const quiesceConnectedServiceQuotaProducersForShutdown = async (): Promise<void> => {
	          connectedServiceQuotaProducersQuiesced = true;
	          if (!connectedServiceQuotasLoopHandle) return;
	          connectedServiceQuotasLoopHandle.pause();
	          await connectedServiceQuotasLoopHandle.stop();
	          connectedServiceQuotasLoopHandle = null;
	        };
	        const flushConnectedServiceQuotaPersistenceForShutdown = async (): Promise<void> => {
	          const result = await connectedServiceQuotasCoordinator?.flushInBandQuotaPersistence(2_000);
          if (!result?.timedOut) return;
          logger.warn('[DAEMON RUN] Connected-service quota persistence did not drain before shutdown', result);
        };
        const flushProviderAccountUsagePersistenceForShutdown = async (): Promise<void> => {
          const result = await providerAccountUsagePersistence.flush(2_000);
          if (!result || typeof result !== 'object' || !('timedOut' in result) || result.timedOut !== true) return;
          logger.warn('[DAEMON RUN] Provider account usage persistence did not drain before shutdown', result);
        };
        const flushDaemonServerWorkForShutdown = async (): Promise<void> => {
          const result = await daemonServerWorkScheduler.flushAll(2_000);
          if (!result.timedOut) return;
          logger.warn('[DAEMON RUN] Daemon server work did not drain before shutdown', result);
        };
        const beforeShutdown = async (): Promise<void> => {
	          if (beforeShutdownOnce) return await beforeShutdownOnce;
	          beforeShutdownOnce = (async () => {
	            await quiesceConnectedServiceQuotaProducersForShutdown();
	            await flushConnectedServiceQuotaPersistenceForShutdown();
            await flushProviderAccountUsagePersistenceForShutdown();
	            await flushDaemonServerWorkForShutdown();
            const initialInFlightSpawns = pidToAwaiter.size;
            const hasPendingRpcRequests = apiMachineForSessions !== null;
            if (initialInFlightSpawns === 0 && !hasPendingRpcRequests) return;

            logger.debug('[DAEMON RUN] Shutdown requested with in-flight work; deferring shutdown', {
              inFlightSpawns: initialInFlightSpawns,
              pendingRpcDrainEnabled: hasPendingRpcRequests,
              graceMs: shutdownSpawnDrainGraceMs,
              pollMs: shutdownSpawnDrainPollMs,
            });

            const start = Date.now();
            while (pidToAwaiter.size > 0 && Date.now() - start < shutdownSpawnDrainGraceMs) {
              // eslint-disable-next-line no-await-in-loop
              await new Promise((resolve) => setTimeout(resolve, shutdownSpawnDrainPollMs));
            }

            const remaining = pidToAwaiter.size;
            if (remaining === 0) {
              logger.debug('[DAEMON RUN] In-flight spawn(s) drained; checking pending RPC requests');
            } else {
              const errorMessage = `Daemon shutting down while ${remaining} spawn(s) still awaiting session webhook.`;
              logger.warn('[DAEMON RUN] In-flight spawn(s) did not drain before shutdown; aborting spawn(s)', {
                inFlight: remaining,
                graceMs: shutdownSpawnDrainGraceMs,
              });

              for (const timeout of pidToSpawnWebhookTimeout.values()) {
                clearTimeout(timeout);
              }

              for (const resolveSpawnResult of pidToSpawnResultResolver.values()) {
                resolveSpawnResult({
                  type: 'error',
                  errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                  errorMessage,
                });
              }

              pidToAwaiter.clear();
              pidToSpawnResultResolver.clear();
              pidToSpawnWebhookTimeout.clear();
            }

            if (!apiMachineForSessions) return;

            const elapsedMs = Date.now() - start;
            const remainingRpcGraceMs = Math.max(0, shutdownSpawnDrainGraceMs - elapsedMs);
            if (remainingRpcGraceMs === 0) {
              logger.warn('[DAEMON RUN] No shutdown grace budget left to drain pending RPC requests');
              return;
            }

            let rpcRequestsDrained = false;
            const timeoutHandle = setTimeout(() => {
              if (!rpcRequestsDrained) {
                logger.warn('[DAEMON RUN] Pending RPC requests did not drain before shutdown', {
                  graceMs: remainingRpcGraceMs,
                });
              }
            }, remainingRpcGraceMs);

            try {
              await Promise.race([
                apiMachineForSessions.awaitPendingRpcRequests().then(() => {
                  rpcRequestsDrained = true;
                }),
                new Promise<void>((resolve) => setTimeout(resolve, remainingRpcGraceMs)),
              ]);
            } finally {
              clearTimeout(timeoutHandle);
            }

            if (rpcRequestsDrained) {
              logger.debug('[DAEMON RUN] Pending RPC requests drained; proceeding with shutdown');
            }

            await flushConnectedServiceQuotaPersistenceForShutdown();
            await flushDaemonServerWorkForShutdown();
          })();
          return await beforeShutdownOnce;
        };

        const isSessionRunnerActive = async (sessionIdRaw: string): Promise<boolean> => {
          return await isSessionRunnerActiveInDaemon({
            sessionId: sessionIdRaw,
            trackedSessions: pidToTrackedSession.values(),
          });
        };
        const probeSessionRunnerServiceability = async (sessionIdRaw: string) => {
          return await probeSessionRunnerServiceabilityInDaemon({
            sessionId: sessionIdRaw,
            trackedSessions: pidToTrackedSession.values(),
            probeCapability: async () => await probePendingQueueServiceability({
              sessionId: sessionIdRaw,
              credentials,
              isShutdownRequested: () => shutdownInitiated,
            }),
          });
        };
        const publishSessionRunnerControlServiceability = async (
          sessionId: string,
          probe: SessionRunnerServiceabilityProbe,
        ): Promise<boolean> => {
          try {
            const observedAt = nextTerminalControlServiceabilityObservation();
            const attachment = await readTerminalAttachmentInfo({
              happyHomeDir: configuration.happyHomeDir,
              sessionId,
            });
            if (attachment?.version !== 2) return false;
            const evidence = resolveRunnerTerminalControlServiceabilityEvidence({
              probe,
              attachmentId: attachment.attachmentId,
              observedAt,
            });
            if (!evidence) return false;
            return await publishTerminalControlServiceability({
              credentials,
              happyHomeDir: configuration.happyHomeDir,
              sessionId,
              ...evidence,
            });
          } catch (error) {
            logger.debug('[DAEMON RUN] Failed to publish resume target terminal control serviceability', {
              sessionId,
              error: serializeAxiosErrorForLog(error),
            });
            return false;
          }
        };
        const stopSessionInFlightBySessionId = new Map<string, Promise<StopSessionResult>>();
        const completedStopSessionIds = new Set<string>();
        const physicallyRetiredTerminalAttachmentIdBySessionId = new Map<string, string>();
        let terminalHostAdaptersPromise: ReturnType<typeof createDefaultTerminalHostRegistry> | null = null;
        const loadTerminalHostAdapters = async () => await (
          terminalHostAdaptersPromise ??= createDefaultTerminalHostRegistry()
        );
        const retireTerminalControlServiceabilityForCurrentAccount = async (
          input: Omit<Parameters<typeof retireExactTerminalControlServiceability>[0], 'credentials'>,
        ) => await retireExactTerminalControlServiceability({ credentials, ...input });
        const stopSessionCore = createStopSession({
          pidToTrackedSession,
          loadTerminalHostAdapters,
          recoverStrandedTerminalControlServiceability: async ({ sessionId, expectedAttachmentId }) => await recoverStrandedTerminalControlServiceability({
            credentials,
            currentMachineId: machineId,
            happyHomeDir: configuration.happyHomeDir,
            sessionId,
            ...(expectedAttachmentId ? { expectedAttachmentId } : {}),
            loadTerminalHostAdapters,
            retireExactTerminalControlServiceability: retireTerminalControlServiceabilityForCurrentAccount,
          }),
          onExactTerminalAttachmentRetired: async (input) => {
            physicallyRetiredTerminalAttachmentIdBySessionId.set(input.sessionId, input.attachmentInfo.attachmentId);
            await notifyTerminalAttachmentRetiredThroughCatalog(input);
          },
          retireExactTerminalControlServiceability: async ({ sessionId, attachmentInfo }) => {
            return await retireTerminalControlServiceabilityForCurrentAccount({
              sessionId,
              attachmentId: attachmentInfo.attachmentId,
              terminalMode: attachmentInfo.terminal.mode ?? attachmentInfo.handle.kind,
            });
          },
          areTrackedRunnersExited: async ({ trackedPids }) => {
            const exited = await waitForTrackedRunnerProcessesExit({
              runners: trackedPids.map((pid) => ({ pid })),
              timeoutMs: 0,
              pollIntervalMs: 0,
            });
            if (!exited) return false;

            for (const pid of trackedPids) {
              await onChildExited(pid, { reason: 'process-missing', code: null, signal: null });
            }
            return true;
          },
          waitForTrackedRunnersExit: async ({ sessionId, trackedPids }) => {
            await waitForExistingSessionExitIfStopRequested({
              sessionId,
              pidToTrackedSession,
              isSessionRunnerActive,
              timeoutMs: configuration.daemonStopSessionWaitForExitMs,
              pollIntervalMs: configuration.daemonStopSessionWaitForExitPollIntervalMs,
              trackedPids,
              onExitObserved: (pid, exit) => onChildExited(pid, exit),
            });
            return trackedPids.every((pid) => !pidToTrackedSession.has(pid));
          },
        });

        // Helper functions
        const getCurrentChildren = () => Array.from(pidToTrackedSession.values());
        // Single switch-outcome surfacing choke point: every applied connected-service account
        // switch (pre-turn/preemptive, automatic group-apply, recovery, manual, quota-driven) routes
        // here so the transcript switch event and the user notification can never drift apart again.
        // Reason-aware suppression (manual + background reasons) is owned by the committer/dispatcher.
        const surfaceConnectedServiceAccountSwitchOutcomeForSession = (
          input: Readonly<{ sessionId: string; event: unknown }>,
        ): void => {
          surfaceConnectedServiceAccountSwitchOutcome(
            {
              credentials,
              runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
              listConnectedServiceProfiles: api.listConnectedServiceProfiles.bind(api),
              getConnectedServiceAuthGroup: api.getConnectedServiceAuthGroup.bind(api),
              expoPushSender: api.push(),
              getActiveAccountSettingsSnapshot,
              resolveSessionNotificationTitle: (sessionId) =>
                resolveTrackedSessionNotificationTitle(
                  getCurrentChildren().find((child) => child.happySessionId === sessionId) ?? null,
                ),
              nowMs: () => Date.now(),
              dedupeWindowMs: resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_ACCOUNT_SWITCH_NOTIFICATION_DEDUPE_MS,
                60_000,
                { min: 0, max: 24 * 60 * 60_000 },
              ),
              logDebug: (message, error) => logger.debug(message, error),
            },
            input,
          );
        };
        const resolvePersistedConnectedServiceMetadataForTrackedSession = async (
          tracked: Pick<TrackedSession, 'happySessionMetadataFromLocalWebhook' | 'spawnOptions'>,
          sessionId: string,
        ): Promise<Record<string, unknown> | null> => {
          const agentId = resolveTrackedSessionCatalogAgentIdFromMetadataSource(tracked);
          return await resolvePersistedConnectedServiceSwitchSessionMetadata({
            credentials,
            sessionId,
            agentId,
          });
        };
        let connectedServiceAuthGroupGenerationConsumer: ConnectedServiceAuthGroupGenerationConsumer | null = null;
        let connectedServiceGenerationReconciliationTail = Promise.resolve();
        let latestConnectedServiceProjectionSnapshot: ConnectedServiceProjectionSnapshot | null = null;
        let connectedServiceProjectionReconciliationBaseline: ConnectedServiceProjectionSnapshot | null = null;
        let connectedServiceProjectionEpoch = 0;
        const lastReconciledProjectionEpochByRuntimeTarget = new WeakMap<ConnectedServiceRuntimeTarget, number>();
        const activeRegistrationReconciliationByRuntimeTarget = new WeakMap<ConnectedServiceRuntimeTarget, Promise<void>>();
        const fetchConnectedServiceProjectionSnapshot = async (): Promise<ConnectedServiceProjectionSnapshot> => {
          const profile = await fetchAccountProfile({ token: credentials.token });
          const snapshot = parseConnectedServiceProjectionSnapshot({
            connectedServicesV2: profile.connectedServicesV2,
            connectedServiceCredentialRevisionsV1: profile.connectedServiceCredentialRevisionsV1,
          });
          latestConnectedServiceProjectionSnapshot = snapshot;
          return snapshot;
        };
        const resolveRuntimeGenerationApplicationProofs = createRuntimeGenerationApplicationProofResolver({
          resolveLifecycleDescriptor: resolveConnectedServiceCredentialLifecycleDescriptor,
          getCurrentGroup: async (group) => await api.getConnectedServiceAuthGroup(group),
        });
        const isCurrentRuntimeGenerationApplicationProofBinding = (
          registration: ConnectedServiceRuntimeTargetRegistration,
          binding: RuntimeGenerationApplicationProofTarget['activeBindings'][number],
          isReconciliationCurrent: () => boolean = () => true,
        ): boolean => isReconciliationCurrent()
          && connectedServiceRuntimeRegistry.isCurrentTargetRegistration(registration)
          && registration.target.activeBindings.some((candidate) => candidate === binding);
        const reconcileConnectedServiceRuntimeTargetRegistrationNow = async (
          registration: ConnectedServiceRuntimeTargetRegistration,
          snapshot: ConnectedServiceProjectionSnapshot,
          signal?: AbortSignal,
        ): Promise<void> => {
          const consumer = connectedServiceAuthGroupGenerationConsumer;
          if (!consumer || !connectedServiceRuntimeRegistry.isCurrentTargetRegistration(registration)) return;
          const { target } = registration;
          const reconciliationEpoch = connectedServiceProjectionEpoch;
          if (lastReconciledProjectionEpochByRuntimeTarget.get(target) === reconciliationEpoch) return;
          const isCurrent = () => connectedServiceRuntimeRegistry.isCurrentTargetRegistration(registration);
          const providerAdoptedTargets = target.activeBindings.some((binding) => binding.groupId !== null)
            ? await resolveRuntimeGenerationApplicationProofs(target, {
              isCurrent: (binding) => isCurrentRuntimeGenerationApplicationProofBinding(registration, binding),
            })
            : [];
          if (!isCurrent()) return;
          await reconcileConnectedServiceAuthGroupGenerationForRuntimeTarget({
            target,
            providerAdoptedTargets,
            consumer,
            listCurrentGroups: async (serviceId) => snapshot.groups.filter((group) => group.serviceId === serviceId),
            resolveCredentialRevision: snapshot.resolveCredentialRevision,
            resolveCredentialBoundary: snapshot.resolveCredentialBoundary,
            executionAuthority: 'passive_projection',
            isCurrent,
            ...(signal ? { signal } : {}),
          });
          if (!isCurrent()) return;
          await reconcileConnectedServiceDirectCredentialRevisionForRuntimeTarget({
            target,
            resolveCredentialBoundary: snapshot.resolveCredentialBoundary,
            applyLiveCredentialBoundary: async (input) => {
              if (!connectedServiceRefreshCoordinator) return;
              await connectedServiceRefreshCoordinator.handleExternalCredentialUpdate(input);
            },
            executionAuthority: 'passive_projection',
            isCurrent,
            ...(signal ? { signal } : {}),
          });
          if (isCurrent()) lastReconciledProjectionEpochByRuntimeTarget.set(target, reconciliationEpoch);
        };
        const enqueueConnectedServiceRuntimeTargetRegistrationReconciliation = (
          registration: ConnectedServiceRuntimeTargetRegistration,
          force = false,
        ): Promise<void> => {
          const active = activeRegistrationReconciliationByRuntimeTarget.get(registration.target);
          if (active) {
            if (!force) return active;
            const continueForcedReconciliation = async () => {
              if (!connectedServiceRuntimeRegistry.isCurrentTargetRegistration(registration)) return;
              await enqueueConnectedServiceRuntimeTargetRegistrationReconciliation(registration, true);
            };
            return active.then(
              continueForcedReconciliation,
              continueForcedReconciliation,
            );
          }
          const reconciliation = Promise.resolve().then(async () => {
            if (force && !connectedServiceAuthGroupGenerationConsumer) {
              throw new Error('connected_service_generation_consumer_unavailable');
            }
            const snapshot = force
              ? await fetchConnectedServiceProjectionSnapshot()
              : latestConnectedServiceProjectionSnapshot;
            if (!snapshot) return;
            await reconcileConnectedServiceRuntimeTargetRegistrationNow(registration, snapshot);
          });
          activeRegistrationReconciliationByRuntimeTarget.set(registration.target, reconciliation);
          void reconciliation.finally(() => {
            if (activeRegistrationReconciliationByRuntimeTarget.get(registration.target) === reconciliation) {
              activeRegistrationReconciliationByRuntimeTarget.delete(registration.target);
            }
          }).catch(() => {});
          void reconciliation.catch((error) => {
            logger.warn('[DAEMON RUN] Connected-service runtime registration reconciliation failed', {
              key: registration.key,
              pid: registration.target.pid,
              sessionId: registration.target.sessionId,
              error: serializeAxiosErrorForLog(error),
            });
          });
          return reconciliation;
        };
        const connectedServiceRuntimeRegistrationCleanup = connectedServiceRuntimeRegistry.onTargetRegistration(
          (registration) => {
            if (!shouldReconcileConnectedServiceRuntimeTargetRegistration({
              registration,
              tracked: registration.key.kind === 'session'
                ? pidToTrackedSession.get(registration.key.pid) ?? null
                : null,
            })) return;
            void enqueueConnectedServiceRuntimeTargetRegistrationReconciliation(registration);
          },
        );
        const registerConnectedServiceTrackedSessionTargets = (
          tracked: TrackedSession,
        ): ConnectedServiceRuntimeTarget | null => {
          return registerConnectedServiceTrackedSessionTargetsForDaemon({
            tracked,
            runtimeRegistry: connectedServiceRuntimeRegistry,
          });
        };
        const registerCurrentConnectedServiceTrackedSessionTargets = (): void => {
          for (const tracked of getCurrentChildren()) {
            registerConnectedServiceTrackedSessionTargets(tracked);
          }
        };
        const connectedServiceContinuationProviderActivityTimeoutMs = resolvePositiveIntEnv(
          process.env.HAPPIER_CONNECTED_SERVICES_CONTINUATION_PROVIDER_ACTIVITY_TIMEOUT_MS,
          5 * 60_000,
          { min: 1_000, max: 60 * 60_000 },
        );
        connectedServiceMaterializedHomeCleanupLoopHandle = startConnectedServiceMaterializedHomeCleanupLoop({
          enabled: true,
          tickMs: resolvePositiveIntEnv(
            process.env.HAPPIER_CONNECTED_SERVICES_MATERIALIZED_HOME_CLEANUP_TICK_MS,
            30 * 60_000,
            { min: 60_000, max: 24 * 60 * 60_000 },
          ),
          scheduler: connectedServiceMaterializedHomeCleanupScheduler,
          onTickError: (error) => {
            logger.debug('[DAEMON RUN] Connected-service materialized home cleanup tick failed (non-fatal)', error);
          },
        });
        const loadLocalSessionMetadataForHandoff = async (sessionId: string): Promise<SessionHandoffLocalMetadataSource | null> => {
            for (const trackedSession of pidToTrackedSession.values()) {
                if (trackedSession.happySessionId !== sessionId) {
                    continue;
            }
            return buildHandoffSessionMetadataFromTrackedSession({
              trackedSession,
              machineId,
              fallbackHomeDir: os.homedir(),
            });
          }
          return null;
        };

        logger.debug('[DAEMON RUN] Running startup session reattach scan');
        const startupReattachResult = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession, credentials });
        const pendingSessionMachineAccessBindingIds = new Set(startupReattachResult.recoveredLiveSessionIds ?? []);
        let sessionMachineAccessBindingReconcileInFlight: Promise<void> | null = null;
        const reconcileSessionMachineAccessBindings = async (): Promise<void> => {
          if (!apiMachineForSessions || pendingSessionMachineAccessBindingIds.size === 0) return;
          if (sessionMachineAccessBindingReconcileInFlight) {
            await sessionMachineAccessBindingReconcileInFlight;
            if (!apiMachineForSessions || pendingSessionMachineAccessBindingIds.size === 0) return;
          }

          sessionMachineAccessBindingReconcileInFlight = (async () => {
            const liveSessionIds = new Set(
              getCurrentChildren()
                .map((tracked) => tracked.happySessionId?.trim())
                .filter((sessionId): sessionId is string => Boolean(sessionId)),
            );
            for (const sessionId of pendingSessionMachineAccessBindingIds) {
              if (!liveSessionIds.has(sessionId)) {
                pendingSessionMachineAccessBindingIds.delete(sessionId);
                continue;
              }
              try {
                await ensureSessionMachineAccessKeyBinding({
                  serverUrl: configuration.apiServerUrl,
                  token: credentials.token,
                  sessionId,
                  machineId,
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
        const orphanedDeadDaemonSessions = [...startupReattachResult.orphanedDeadDaemonSessions];
        const disconnectedTerminalHostCandidates = [...(startupReattachResult.disconnectedTerminalHostCandidates ?? [])];
        const unresolvedTerminalHostSessionIds = new Set(startupReattachResult.unresolvedTerminalHostSessionIds ?? []);
        const terminalizedDisconnectedTerminalHostIds = new Set<string>();
        const disconnectedTerminalHostResultsBySessionId = new Map<string, DisconnectedTerminalHostSupervisionResult>();
        const registerDisconnectedTerminalHostCandidate = (candidate: DisconnectedTerminalHostCandidate): void => {
          disconnectedTerminalHostResultsBySessionId.delete(candidate.sessionId);
          terminalizedDisconnectedTerminalHostIds.delete(candidate.attachmentId);
          for (let index = disconnectedTerminalHostCandidates.length - 1; index >= 0; index -= 1) {
            if (disconnectedTerminalHostCandidates[index]?.sessionId === candidate.sessionId) {
              disconnectedTerminalHostCandidates.splice(index, 1);
            }
          }
          disconnectedTerminalHostCandidates.push(candidate);
        };
        const retireDisconnectedTerminalHostCandidate = async (input: Readonly<{
          sessionId: string;
          attachmentId?: string;
        }>): Promise<void> => {
          disconnectedTerminalHostResultsBySessionId.delete(input.sessionId);
          const retiredMarkerPids: number[] = [];
          for (let index = disconnectedTerminalHostCandidates.length - 1; index >= 0; index -= 1) {
            const candidate = disconnectedTerminalHostCandidates[index];
            if (!candidate || candidate.sessionId !== input.sessionId) continue;
            if (input.attachmentId && candidate.attachmentId !== input.attachmentId) continue;
            terminalizedDisconnectedTerminalHostIds.add(candidate.attachmentId);
            retiredMarkerPids.push(candidate.pid);
            disconnectedTerminalHostCandidates.splice(index, 1);
          }
          await Promise.all(retiredMarkerPids.map(async (pid) => {
            await removeSessionMarker(pid).catch((error) => {
              logger.debug('[DAEMON RUN] Retired terminal host but failed to remove its disconnected marker', {
                sessionId: input.sessionId,
                pid,
                error,
              });
            });
          }));
        };
        let disconnectedTerminalHostSupervisionInFlight: Promise<void> | null = null;
        const publishedStartupOrphanedSessionIds = new Set<string>();
        const publishingStartupOrphanedSessionIds = new Set<string>();
        const publishStartupOrphanedSessionEnds = async (
          apiMachine: ApiMachineClient | null = apiMachineForSessions,
        ): Promise<void> => {
          if (!apiMachine) return;
          const stagingKey = (session: (typeof orphanedDeadDaemonSessions)[number]): string => (
            `${session.sessionId}\u0000${session.activeTurnId ?? ''}`
          );
          const sessions = Array.from(new Map(orphanedDeadDaemonSessions
            .map((session) => [stagingKey(session), session] as const)).values())
            .filter((session) => (
              !publishedStartupOrphanedSessionIds.has(stagingKey(session))
              && !publishingStartupOrphanedSessionIds.has(stagingKey(session))
            ));
          if (sessions.length === 0) return;
          sessions.forEach((session) => publishingStartupOrphanedSessionIds.add(stagingKey(session)));
          try {
            await publishOrphanedStartupSessionEnds({
              apiMachine,
              orphanedDeadDaemonSessions: sessions,
            });
            for (const session of sessions) {
              publishedStartupOrphanedSessionIds.add(stagingKey(session));
            }
          } finally {
            sessions.forEach((session) => publishingStartupOrphanedSessionIds.delete(stagingKey(session)));
          }
        };
        const superviseStartupDisconnectedTerminalHosts = (
          apiMachine: ApiMachineClient | null = apiMachineForSessions,
        ): Promise<void> => {
          if (disconnectedTerminalHostCandidates.length === 0) return Promise.resolve();
          if (disconnectedTerminalHostSupervisionInFlight) return disconnectedTerminalHostSupervisionInFlight;
          disconnectedTerminalHostSupervisionInFlight = (async () => {
            const terminalHostAdapters = await loadTerminalHostAdapters();
            const results = await Promise.all(disconnectedTerminalHostCandidates.map(async (candidate) => {
              const observedAt = nextTerminalControlServiceabilityObservation();
              return {
                candidate,
                observedAt,
                result: await superviseDisconnectedTerminalHostCandidate({
                  candidate,
                  terminalHostAdapters,
                  probeSessionServiceability: async (sessionId) => await probeSessionRunnerServiceability(sessionId),
                  retireExactTerminalControlServiceability: async ({ sessionId, attachmentInfo }) => {
                    return await retireTerminalControlServiceabilityForCurrentAccount({
                      sessionId,
                      attachmentId: attachmentInfo.attachmentId,
                      terminalMode: attachmentInfo.terminal.mode ?? attachmentInfo.handle.kind,
                    });
                  },
                }),
              };
            }));
            for (const { candidate, observedAt, result } of results) {
              disconnectedTerminalHostResultsBySessionId.set(candidate.sessionId, result);
              if (result.state === 'servable' || result.state === 'recoverable_unservable' || result.state === 'unknown') {
                try {
                  await publishTerminalControlServiceability({
                    credentials,
                    happyHomeDir: configuration.happyHomeDir,
                    sessionId: candidate.sessionId,
                    attachmentId: candidate.attachmentId,
                    state: result.state === 'servable' ? 'servable' : result.state === 'recoverable_unservable' ? 'recoverable_unservable' : 'unknown',
                    observedAt,
                    ...('reason' in result ? { reason: result.reason } : {}),
                  });
                } catch (error) {
                  logger.debug('[DAEMON RUN] Failed to publish terminal control serviceability', {
                    sessionId: candidate.sessionId,
                    error: serializeAxiosErrorForLog(error),
                  });
                }
              }
              if (result.state !== 'stopped' || terminalizedDisconnectedTerminalHostIds.has(candidate.attachmentId)) continue;
              terminalizedDisconnectedTerminalHostIds.add(candidate.attachmentId);
              orphanedDeadDaemonSessions.push({
                sessionId: candidate.sessionId,
                pid: candidate.pid,
                ...(candidate.activeTurnId ? { activeTurnId: candidate.activeTurnId } : {}),
              });
            }
            await publishStartupOrphanedSessionEnds(apiMachine);
          })().catch((error) => {
            logger.debug('[DAEMON RUN] Disconnected terminal-host supervision failed (non-fatal)', error);
          }).finally(() => {
            disconnectedTerminalHostSupervisionInFlight = null;
          });
          return disconnectedTerminalHostSupervisionInFlight;
        };
        logger.debug('[DAEMON RUN] Startup session reattach scan finished', {
          trackedSessionCount: pidToTrackedSession.size,
          orphanedDeadDaemonSessionCount: orphanedDeadDaemonSessions.length,
        });
        pruneHappyCliRunnerSnapshots(resolveLiveRunnerSnapshotFingerprints(getCurrentChildren()));
        registerCurrentConnectedServiceTrackedSessionTargets();
        void connectedServiceGroupHomeCleanupScheduler.reconcileDeletedGroupHomes({
          resolveGroupDeletionAuthority: resolveConnectedServiceGroupDeletionAuthority,
        }).catch((error) => {
          logger.debug('[DAEMON RUN] Connected-service group home startup reconciliation failed (non-fatal)', error);
        });
        connectedServiceMaterializedHomeCleanupLoopHandle?.trigger();
        if (process.platform === 'linux' && startupSource === 'background-service') {
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

        const recordConnectedServiceContinuationProviderActivity =
          createConnectedServiceProviderActivityProofRecorder({
            // Late-bound: the runtime-auth scheduler is constructed after this
            // recorder; resolve it at call time.
            runtimeAuthRecovery: {
              readForSession: (sessionId) => runtimeAuthRecoveryScheduler?.readForSession(sessionId) ?? [],
              markProviderOutcomeProofByKey: async (markInput) =>
                await runtimeAuthRecoveryScheduler?.markProviderOutcomeProofByKey(markInput),
            },
            usageLimitRecovery: {
              markProviderOutcomeProofForSession: async (markInput) =>
                await inactiveUsageLimitRecoveryScheduler.markProviderOutcomeProofForSession(markInput),
            },
            logDebug: (message, error) => logger.debug(message, error),
          });
        const clearConnectedServiceRecoveryAfterSupersession =
          createConnectedServiceRecoverySupersessionCleaner({
            removeReportOutboxItemsForSession: async (sessionId) => {
              await removeRuntimeAuthFailureReportOutboxItemsForSession({ sessionId });
            },
            logDebug: (message, error) => logger.debug(message, error),
          });

        const connectedServicesRestartRequestedPids = new Set<number>();

        // Handle webhook from happy session reporting itself
        const onHappySessionWebhook = createOnHappySessionWebhook({
          pidToTrackedSession,
          pidToAwaiter,
          onTrackedSessionReady: async (tracked) => {
            const sessionId = typeof tracked.happySessionId === 'string' ? tracked.happySessionId.trim() : '';
            if (!sessionId) return;
            const target = registerConnectedServiceTrackedSessionTargets(tracked);
            for (const registration of connectedServiceRuntimeRegistry.listTargetRegistrations()) {
              if (
                registration.key.kind === 'session'
                && registration.target.sessionId === sessionId
                && registration.target !== target
              ) {
                connectedServiceRuntimeRegistry.unregisterSessionTargetByPid(registration.key.pid);
              }
            }
            if (!target || target.pid !== tracked.pid || target.sessionId !== sessionId) return;
            await enqueueConnectedServiceRuntimeTargetRegistrationReconciliation({
              key: { kind: 'session', pid: tracked.pid },
              target,
            }, true);
          },
          onTrackedSessionReported: async (tracked) => {
            if (tracked.startedBy !== 'daemon') {
              // Session reports are the first durable identity boundary for terminal-started
              // runtimes. Index them through the same registry owner used by daemon spawns and
              // reattachment before serving broker-backed provider requests.
              registerConnectedServiceTrackedSessionTargets(tracked);
            }
            await publishReportedTerminalControlServiceability({
              tracked,
              readTerminalAttachmentInfo: async (sessionId) => await readTerminalAttachmentInfo({
                happyHomeDir: configuration.happyHomeDir,
                sessionId,
              }),
              probeSessionRunnerServiceability,
              publishSessionRunnerControlServiceability,
            });
          },
        });
        const resolveCanonicalTrackedSessionId = (pid: number): string => {
          const session = pidToTrackedSession.get(pid);
          const sessionId = typeof session?.happySessionId === 'string' ? session.happySessionId.trim() : '';
          if (!sessionId) return '';
          if (/^PID-\d+$/.test(sessionId)) return '';
          return sessionId;
        };
        const normalizeSpawnNonceForAck = (value: unknown): string => {
          return typeof value === 'string' && value.trim().length > 0 ? value : '';
        };
        const buildSpawnAcceptedResult = (params: Readonly<{
          pid: number;
          spawnNonce?: string;
          fallbackSessionId?: string;
        }>): Extract<SpawnSessionResult, { type: 'success' }> => {
          const trackedSessionId = resolveCanonicalTrackedSessionId(params.pid);
          const fallbackSessionId = typeof params.fallbackSessionId === 'string' ? params.fallbackSessionId.trim() : '';
          const sessionId = trackedSessionId || fallbackSessionId;
          const spawnNonce = normalizeSpawnNonceForAck(params.spawnNonce);
          return {
            type: 'success',
            runnerAcceptance: 'newly_accepted',
            ...(sessionId ? { sessionId } : { sessionIdStatus: 'pending' as const }),
            ...(spawnNonce ? { spawnNonce } : {}),
          };
        };
        const resolveTrackedSpawnByNonce = async (spawnNonce: string): Promise<SpawnSessionResult | null> => {
          for (const [pid, tracked] of pidToTrackedSession) {
            if (
              tracked.startedBy !== 'daemon'
              || tracked.pid !== pid
              || normalizeSpawnNonceForAck(tracked.spawnOptions?.spawnNonce) !== spawnNonce
            ) {
              continue;
            }
            const runState = await readProcessRunState(pid).catch(() => null);
            if (runState !== 'servable') continue;
            const result = buildSpawnAcceptedResult({
              pid,
              spawnNonce,
            });
            result.runnerAcceptance = 'same_request_runner';
            daemonSpawnAttemptRegistry.rememberAccepted({ spawnNonce, result });
            return result;
          }
          return null;
        };
        const persistAcceptedSpawnMarker = async (params: Readonly<{
          pid: number;
          spawnOptions: SpawnSessionOptions;
          directory: string;
          existingSessionId?: string;
        }>): Promise<void> => {
          const respawn = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(
            {
              ...params.spawnOptions,
              directory: params.directory,
            },
            { encryptionMaterial: credentials.encryption },
          );
          if (!respawn) {
            throw new Error(`Could not persist accepted spawn custody for PID ${params.pid}`);
          }
          const existingSessionId = typeof params.existingSessionId === 'string'
            ? params.existingSessionId.trim()
            : '';
          const processInstanceFingerprint = readProcessInstanceFingerprintSync(params.pid) ?? undefined;
          await writeSessionMarker({
            pid: params.pid,
            happySessionId: existingSessionId || `PID-${params.pid}`,
            startedBy: 'daemon',
            cwd: params.directory,
            ...(processInstanceFingerprint ? { processInstanceFingerprint } : {}),
            respawn,
          });
        };

            // Spawn a new session (sessionId reserved for future Happy session resume; vendor resume uses options.resume).
                const spawnSession = async (
                  options: SpawnSessionOptions,
                  acceptanceHooks?: SpawnSessionRunnerAcceptanceHooks,
                ): Promise<SpawnSessionResult> => {
          let normalizedOptions: SpawnSessionOptions = {
            ...options,
            directory: normalizeSpawnSessionDirectory(options.directory, process.env),
          };
          const requestedSpawnNonce = normalizeSpawnNonceForAck(normalizedOptions.spawnNonce);
          if (requestedSpawnNonce) {
            normalizedOptions = {
              ...normalizedOptions,
              spawnNonce: requestedSpawnNonce,
            };
            const acceptedResult = daemonSpawnAttemptRegistry.replay(requestedSpawnNonce);
            if (acceptedResult) {
              return acceptedResult;
            }
            const trackedResult = await resolveTrackedSpawnByNonce(requestedSpawnNonce);
            if (trackedResult) {
              return trackedResult;
            }
          }
          const key = computeDaemonSpawnRequestKey(normalizedOptions);
          return await spawnRequestCoalescer.run(key, async () => {
            if (typeof normalizedOptions.accountSettingsVersionHint === 'number') {
              try {
                await refreshDaemonAccountSettingsForHint({
                  credentials,
                  settingsVersion: normalizedOptions.accountSettingsVersionHint,
                });
              } catch (error) {
                logger.warn('[DAEMON RUN] Account settings freshness refresh failed before spawn; continuing with last available settings', serializeAxiosErrorForLog(error));
              }
            }
            const normalizedExistingSessionId = typeof normalizedOptions.existingSessionId === 'string' ? normalizedOptions.existingSessionId.trim() : '';
            if (!normalizedExistingSessionId && !normalizeSpawnNonceForAck(normalizedOptions.spawnNonce)) {
              normalizedOptions = {
                ...normalizedOptions,
                spawnNonce: randomUUID(),
              };
            }
            if (normalizedExistingSessionId) {
              const inFlightStop = stopSessionInFlightBySessionId.get(normalizedExistingSessionId);
              let precedingStopResult: StopSessionResult | null = null;
              if (inFlightStop) {
                precedingStopResult = await inFlightStop;
              }
              // A new Resume attempt starts a new lifecycle generation. Never let a prior
              // completed Stop make a racing or subsequently failed stop look successful.
              completedStopSessionIds.delete(normalizedExistingSessionId);
              if (unresolvedTerminalHostSessionIds.has(normalizedExistingSessionId)) {
                const repairResult = precedingStopResult ?? await stopSession(normalizedExistingSessionId);
                if (repairResult.status === 'stopped' || repairResult.status === 'not_found') {
                  unresolvedTerminalHostSessionIds.delete(normalizedExistingSessionId);
                } else {
                  logger.warn('[DAEMON RUN] Refusing Resume while preserved terminal topology is unreadable or legacy', {
                    sessionId: normalizedExistingSessionId,
                    stopStatus: repairResult.status,
                    ...(repairResult.status === 'incomplete' ? { stopReason: repairResult.reason } : {}),
                  });
                  return {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                    errorMessage: 'This session has preserved terminal topology that is unreadable or legacy. Repair or migrate that topology before trying Resume again.',
                  };
                }
              }
              const disconnectedHostCandidate = disconnectedTerminalHostCandidates.find(
                (candidate) => candidate.sessionId === normalizedExistingSessionId
                  && !terminalizedDisconnectedTerminalHostIds.has(candidate.attachmentId),
              );
              if (disconnectedHostCandidate) {
                await superviseStartupDisconnectedTerminalHosts();
                const supervision = disconnectedTerminalHostResultsBySessionId.get(normalizedExistingSessionId);
                const resumeGate = supervision
                  ? resolveDisconnectedTerminalHostResumeGate(supervision)
                  : { action: 'fence' as const, reason: 'supervision_unavailable' };
                const delegatesExactClaudeRunnerAbsenceToRecovery =
                  normalizedOptions.backendTarget?.kind === 'builtInAgent'
                  && normalizedOptions.backendTarget.agentId === 'claude'
                  && disconnectedHostCandidate.controlDescriptorAvailable === true
                  && supervision?.state === 'recoverable_unservable'
                  && supervision.reason === 'runner_absent';
                if (resumeGate.action === 'fence' && !delegatesExactClaudeRunnerAbsenceToRecovery) {
                  logger.warn('[DAEMON RUN] Refusing Resume while an exact preserved terminal host lacks recoverable controls', {
                    sessionId: normalizedExistingSessionId,
                    attachmentId: disconnectedHostCandidate.attachmentId,
                    reason: resumeGate.reason,
                  });
                  return {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                    errorMessage: 'This session has a preserved terminal host that cannot be controlled safely. Stop the session, then Resume again to launch a fresh host.',
                  };
                }
              }
              const acceptedExistingSessionStartup = await resolveAcceptedExistingSessionStartup(
                normalizedExistingSessionId,
                normalizedOptions.spawnNonce,
              );
              if (acceptedExistingSessionStartup) {
                logger.debug('[DAEMON RUN] Rejoining accepted existing-session launch while its exact child awaits the session webhook', {
                  sessionId: normalizedExistingSessionId,
                });
                return acceptedExistingSessionStartup;
              }
              // Idempotency: a resume/attach request must never spawn a duplicate process.
              // This covers both:
              // - sessions we are tracking (including in-flight attaches), and
              // - runners started outside this daemon (lock file check).
              const initialServiceability = await waitForTerminatingSessionRunnerExit({
                initialProbe: await probeSessionRunnerServiceability(normalizedExistingSessionId),
                probe: async () => await probeSessionRunnerServiceability(normalizedExistingSessionId),
                timeoutMs: configuration.daemonSpawnExistingSessionWaitForExitMs,
                pollIntervalMs: configuration.daemonSpawnExistingSessionWaitForExitPollIntervalMs,
              });
              const initialResumeDecision = resolveSessionRunnerResumeDecision(initialServiceability);
              if (initialResumeDecision.action === 'fence') {
                await publishSessionRunnerControlServiceability(normalizedExistingSessionId, initialServiceability);
                logger.debug('[DAEMON RUN] Resume target serviceability is unknown; refusing an unsafe duplicate spawn', {
                  sessionId: normalizedExistingSessionId,
                  reason: initialResumeDecision.reason,
                });
                return {
                  type: 'error',
                  errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                  errorMessage: 'The existing session runtime could not be verified. Retry resume after connectivity recovers.',
                };
              }
              if (initialResumeDecision.action === 'wait_for_exit') {
                await publishSessionRunnerControlServiceability(normalizedExistingSessionId, initialServiceability);
                return {
                  type: 'error',
                  errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                  errorMessage: 'The previous session runtime is still shutting down. Retry resume after it exits.',
                };
              }
              if (initialResumeDecision.action === 'adopt') {
                // If the daemon has *just* requested the runner to stop (e.g. aborting a handoff),
                // a best-effort "restart on source" can race and leave the session stopped. When
                // we detect an in-flight stop marker, wait briefly for the runner to exit before
                // applying the idempotent "already running" rule.
                if (configuration.daemonSpawnExistingSessionWaitForExitMs > 0) {
                  await waitForExistingSessionExitIfStopRequested({
                    sessionId: normalizedExistingSessionId,
                    pidToTrackedSession,
                    isSessionRunnerActive,
                    timeoutMs: configuration.daemonSpawnExistingSessionWaitForExitMs,
                    pollIntervalMs: configuration.daemonSpawnExistingSessionWaitForExitPollIntervalMs,
                  });
                }

                const serviceabilityAfterWait = await probeSessionRunnerServiceability(normalizedExistingSessionId);
                const resumeDecisionAfterWait = resolveSessionRunnerResumeDecision(serviceabilityAfterWait);
                if (resumeDecisionAfterWait.action === 'fence') {
                  await publishSessionRunnerControlServiceability(normalizedExistingSessionId, serviceabilityAfterWait);
                  return {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                    errorMessage: 'The existing session runtime could not be verified. Retry resume after connectivity recovers.',
                  };
                }
                if (resumeDecisionAfterWait.action === 'adopt') {
                  const runnerAcceptance = resolveExistingRunnerAcceptance({
                    requestedSpawnNonce: normalizedOptions.spawnNonce,
                    trackedSpawnNonces: Array.from(pidToTrackedSession.values())
                      .filter((tracked) => tracked.happySessionId === normalizedExistingSessionId)
                      .map((tracked) => tracked.spawnOptions?.spawnNonce),
                  });
                  logger.debug(`[DAEMON RUN] Resume requested for ${normalizedExistingSessionId}, but session is already running`);
                  await applyAlreadyRunningExistingSessionRuntimeSnapshot({
                    sessionId: normalizedExistingSessionId,
                    incomingOptions: normalizedOptions,
                    pidToTrackedSession,
                    credentials,
                  });
                  pendingSessionMachineAccessBindingIds.add(normalizedExistingSessionId);
                  await reconcileSessionMachineAccessBindings();
                  // Best-effort: wake the live runner's pending queue so a queued message is
                  // delivered promptly on resume. The RESULT is intentionally advisory only.
                  //
                  // Root-cause invariant (daemon-restart mass-kill, Family A2): a session that
                  // passes the canonical `isSessionRunnerActive` check above is alive and servable
                  // and MUST be adopted. A transient pending-queue probe failure (the RPC handler
                  // is not yet registered during a startup/reattach window, or the runtime is mid
                  // turn) is NOT proof of a stale runner. Stopping + respawning here was the
                  // destructive escape hatch that killed live Claude runners en masse after a daemon
                  // restart marked them (falsely) inactive. Never kill a live, servable runner over
                  // a momentary probe result; it will drain its queue once its handler is ready.
                  const hasExplicitCatchUpCursor = typeof normalizedOptions.initialTranscriptAfterSeq === 'number';
                  const hasFreshUserRequestAuthorization =
                    normalizedOptions.executionAuthorization?.provenance === 'user_request'
                    && typeof normalizedOptions.executionAuthorization.requestId === 'string'
                    && normalizedOptions.executionAuthorization.requestId.trim().length > 0;
                  if (hasExplicitCatchUpCursor && hasFreshUserRequestAuthorization) {
                    try {
                      await inactiveUsageLimitRecoveryScheduler.checkNow({
                        sessionId: normalizedExistingSessionId,
                      });
                    } catch (error) {
                      // Recovery selection is advisory to prompt delivery. A transient store or
                      // provider-check failure must not strand the fresh user-authored prompt;
                      // the runner can still consume it and report the provider outcome normally.
                      logger.warn('[DAEMON RUN] Explicit user-request recovery check failed; continuing with the one-shot pending queue wake', {
                        sessionId: normalizedExistingSessionId,
                        error: serializeAxiosErrorForLog(error),
                      });
                    }
                  }
                  const pendingQueueNudge = await nudgeAttachedExistingSessionPendingQueue({
                    requestedExistingSessionId: normalizedExistingSessionId,
                    resolved: { type: 'success', sessionId: normalizedExistingSessionId },
                    credentials,
                    isShutdownRequested: () => shutdownInitiated,
                  });
                  if (pendingQueueNudge.type === 'error') {
                    logger.debug('[DAEMON RUN] Resume target pending-queue wake was unavailable; adopting the live runner without replacement (it will drain once its queue handler is ready)', {
                      sessionId: normalizedExistingSessionId,
                      reason: pendingQueueNudge.errorMessage,
                    });
                  }
                  await publishSessionRunnerControlServiceability(normalizedExistingSessionId, serviceabilityAfterWait);
                  return {
                    type: 'success',
                    sessionId: normalizedExistingSessionId,
                    runnerAcceptance,
                  };
                }
              }
            }

            return await spawnConcurrencyGate.run(async () => {
              const resolvedDirectory = normalizedOptions.directory;
              let {
                directory,
                sessionId,
                machineId,
                approvedNewDirectoryCreation = true,
                existingSessionAttachPayload,
                resume,
                existingSessionId,
                permissionMode,
                permissionModeUpdatedAt,
                agentModeId,
                agentModeUpdatedAt,
                modelId,
                modelUpdatedAt,
                initialTranscriptAfterSeq,
                initialGoal,
                pendingFirstInput,
                experimentalCodexAcp,
                codexBackendMode,
                agentRuntimeDescriptorV1,
                backendTarget,
              } = normalizedOptions;
              const normalizedResume = typeof resume === 'string' ? resume.trim() : '';
              const normalizedExistingSessionId = typeof existingSessionId === 'string' ? existingSessionId.trim() : '';
              const canonicalCodexBackendMode = resolveCanonicalCodexBackendMode({
                codexBackendMode,
                experimentalCodexAcp,
                agentRuntimeDescriptorV1,
              });

              // NOTE: existing-session idempotency is handled before entering the spawn concurrency gate.
              let effectiveResume = normalizedResume;
              const catalogAgentId = resolveCatalogAgentIdFromBackendTarget(backendTarget);

              let sessionAttachPayload: import('@/agent/runtime/sessionAttachPayload').SessionAttachFilePayload | null = null;
              let existingSessionPersistedMetadata: Record<string, unknown> | null = null;
              if (normalizedExistingSessionId) {
                if (existingSessionAttachPayload) {
                  sessionAttachPayload = existingSessionAttachPayload;
                } else {
                  const storedCredentials = await readCredentials().catch(() => null);
                  const effectiveCredentials = storedCredentials ?? credentials;
                  const tokenForFetch = effectiveCredentials?.token ?? '';

                  const attachContext = await resolveExistingSessionAttachContext({
                    token: tokenForFetch,
                    sessionId: normalizedExistingSessionId,
                    agent: backendTarget?.kind === 'builtInAgent' ? backendTarget.agentId : 'customAcp',
                    credentials: effectiveCredentials,
                  });

                  if (!attachContext.ok) {
                    return mapExistingSessionAttachFailureToSpawnError(attachContext.reason);
                  }

                  sessionAttachPayload = attachContext.attachPayload;
                  existingSessionPersistedMetadata = attachContext.metadata;
                  if (!effectiveResume) {
                    const derivedResume = typeof attachContext.vendorResumeId === 'string' ? attachContext.vendorResumeId.trim() : '';
                    if (derivedResume) {
                      effectiveResume = derivedResume;
                    }
                  }
                }

                sessionAttachPayload = applyInitialTranscriptAfterSeqToAttachPayload(sessionAttachPayload, initialTranscriptAfterSeq);
              }

              if (normalizedExistingSessionId) {
                const requestExecutionAuthorization = normalizedOptions.executionAuthorization;
                const runtimeSnapshot = resolveSessionRuntimeSnapshot({
                  incomingOptions: {
                    ...normalizedOptions,
                    ...(effectiveResume ? { resume: effectiveResume } : {}),
                  },
                  persistedMetadata: existingSessionPersistedMetadata,
                  persistedVendorResumeId: effectiveResume || null,
                });
                normalizedOptions = {
                  ...runtimeSnapshot.spawnOptions,
                  ...(requestExecutionAuthorization ? { executionAuthorization: requestExecutionAuthorization } : {}),
                };
                resume = normalizedOptions.resume;
                permissionMode = normalizedOptions.permissionMode;
                permissionModeUpdatedAt = normalizedOptions.permissionModeUpdatedAt;
                agentModeId = normalizedOptions.agentModeId;
                agentModeUpdatedAt = normalizedOptions.agentModeUpdatedAt;
                modelId = normalizedOptions.modelId;
                modelUpdatedAt = normalizedOptions.modelUpdatedAt;
                effectiveResume = typeof resume === 'string' ? resume.trim() : '';
              }

              const nativeSpawnSelection = resolveAgentNativeSpawnDefinitiveRejection({
                agentId: catalogAgentId,
                selection: {
                  modelId: normalizedOptions.modelId,
                  acpSessionModeId: normalizedOptions.agentModeId,
                  sessionConfigOptionOverrides: normalizedOptions.sessionConfigOptionOverrides,
                },
              });
              if (!nativeSpawnSelection.ok) {
                return {
                  type: 'error',
                  errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                  errorMessage: 'Agent-native selection is invalid.',
                };
              }

              if (
                normalizedExistingSessionId
                && backendTarget?.kind === 'builtInAgent'
                && backendTarget.agentId === 'claude'
              ) {
                try {
                  normalizedOptions = await resolveClaudeEndpointRecoverySpawnOptions({
                    happyHomeDir: configuration.happyHomeDir,
                    sessionId: normalizedExistingSessionId,
                    defaultOptions: normalizedOptions,
                    loadTerminalHostAdapters,
                    retireExactTerminalControlServiceability: async ({ sessionId, attachmentInfo }) => (
                      await retireTerminalControlServiceabilityForCurrentAccount({
                        sessionId,
                        attachmentId: attachmentInfo.attachmentId,
                        terminalMode: attachmentInfo.terminal.mode ?? attachmentInfo.handle.kind,
                      })
                    ),
                    proveExactSessionRunnerAbsent: async () => (
                      await probeSessionRunnerServiceability(normalizedExistingSessionId)
                    ).state === 'runner_absent',
                  });
                } catch (error) {
                  if (!(error instanceof ClaudeEndpointRecoveryFenceError)) throw error;
                  logger.warn('[DAEMON RUN] Refusing Claude Resume before spawn because exact terminal recovery is fenced', {
                    sessionId: normalizedExistingSessionId,
                    reason: error.reason,
                  });
                  return {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                    errorMessage: error.message,
                  };
                }
              }

              // This is the single final environment owner. Existing-session recovery and every
              // other spawn normalization must complete before validation snapshots the child env.
              const envKeysPreview = normalizedOptions.environmentVariables && typeof normalizedOptions.environmentVariables === 'object'
                ? Object.keys(normalizedOptions.environmentVariables as Record<string, unknown>)
                : [];
              const environmentVariablesValidation = validateEnvVarRecordStrict(normalizedOptions.environmentVariables);
              logger.debugLargeJson('[DAEMON RUN] Spawning session', {
                directory: resolvedDirectory,
                sessionId: normalizedOptions.sessionId,
                machineId: normalizedOptions.machineId,
                approvedNewDirectoryCreation: normalizedOptions.approvedNewDirectoryCreation,
                backendTarget: normalizedOptions.backendTarget,
                profileId: normalizedOptions.profileId,
                hasPendingFirstInput: normalizedOptions.pendingFirstInput !== undefined,
                hasInitialTranscriptAfterSeq: typeof normalizedOptions.initialTranscriptAfterSeq === 'number',
                hasInitialGoal: normalizedOptions.initialGoal !== undefined,
                hasResume: typeof normalizedOptions.resume === 'string' && normalizedOptions.resume.trim().length > 0,
                windowsRemoteSessionLaunchMode: normalizedOptions.windowsRemoteSessionLaunchMode,
                windowsRemoteSessionConsole: normalizedOptions.windowsRemoteSessionConsole,
                windowsTerminalWindowName: normalizedOptions.windowsTerminalWindowName,
                environmentVariableCount: envKeysPreview.length,
                environmentVariableKeys: envKeysPreview,
                environmentVariablesValid: environmentVariablesValidation.ok,
                environmentVariablesError: environmentVariablesValidation.ok ? null : environmentVariablesValidation.error,
              });

              if (!environmentVariablesValidation.ok) {
                return {
                  type: 'error',
                  errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_ENVIRONMENT_VARIABLES,
                  errorMessage: environmentVariablesValidation.error,
                };
              }

              // Only gate vendor resume. Happy-session reconnect (existingSessionId) is supported for all agents.
              if (effectiveResume) {
                if (backendTarget?.kind === 'configuredAcpBackend') {
                  return {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
                    errorMessage: `Resume is not supported for configured ACP backend '${backendTarget.backendId}'.`,
                  };
                }
                const vendorResumeSupport = await getVendorResumeSupport(
                  catalogAgentId,
                );
                const ok = vendorResumeSupport(
                  canonicalCodexBackendMode
                    ? { codexBackendMode: canonicalCodexBackendMode }
                    : { experimentalCodexAcp },
                );
                if (!ok) {
                  const supportLevel = requireCatalogEntry(catalogAgentId).vendorResumeSupport;
                  const qualifier = supportLevel === 'experimental' ? ' (experimental and not enabled)' : '';
                  return {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
                    errorMessage: `Resume is not supported for agent '${catalogAgentId}'${qualifier}.`,
                  };
                }
              }
              let directoryCreated = false;

              const catalogEntry = requireCatalogEntry(catalogAgentId);
              const daemonSpawnHooks = catalogEntry.getDaemonSpawnHooks
                ? await catalogEntry.getDaemonSpawnHooks()
                : null;

              let spawnResourceCleanupOnFailure: (() => void) | null = null;
              let spawnResourceCleanupOnExit: (() => void) | null = null;
              let spawnResourceCleanupArmed = false;
              let sessionAttachCleanup: (() => Promise<void>) | null = null;

              const ensuredDirectory = await ensureSessionDirectory({
                directory: resolvedDirectory,
                approvedNewDirectoryCreation,
              });
              if (!ensuredDirectory.ok) {
                logger.debug(`[DAEMON RUN] Directory setup failed for ${resolvedDirectory}`, ensuredDirectory.response);
                return ensuredDirectory.response;
              }
              directoryCreated = ensuredDirectory.directoryCreated;

              try {

                const cleanupSpawnResources = () => {
                  if (spawnResourceCleanupOnFailure && !spawnResourceCleanupArmed) {
                    spawnResourceCleanupOnFailure();
                    spawnResourceCleanupOnFailure = null;
                    spawnResourceCleanupOnExit = null;
                  }
                };

                let connectedServiceAuth: Awaited<ReturnType<typeof resolveConnectedServiceAuthForSpawn>> = null;
                const fallbackMaterializationKey =
                  normalizedExistingSessionId ||
                  (typeof sessionId === 'string' ? sessionId.trim() : '') ||
                  `spawn-${Date.now()}-${randomBytes(8).toString('hex')}`;
                let materializationKey = fallbackMaterializationKey;
                const connectedServiceAuthSessionId =
                  normalizedExistingSessionId ||
                  (typeof sessionId === 'string' ? sessionId.trim() : '') ||
                  undefined;

                if (shouldResolveConnectedServiceAuthForSpawn(normalizedOptions)) {
                  let repairedMissingMaterializationIdentity: Readonly<{
                    bindings: ConnectedServiceBindingsV1;
                    identity: ConnectedServiceMaterializationIdentityV1;
                  }> | null = null;
                  let connectedServiceMaterializationIdentityV1 =
                    readConnectedServiceMaterializationIdentityV1(
                      normalizedOptions.connectedServiceMaterializationIdentityV1,
                    );
                  if (!connectedServiceMaterializationIdentityV1) {
                    if (normalizedExistingSessionId) {
                      const normalizedConnectedServiceBindings = readConnectedServiceBindingsOrEmpty(
                        normalizedOptions.connectedServices,
                      );
                      const canRepairMissingIdentity = Boolean(effectiveResume) && Object.values(
                        normalizedConnectedServiceBindings.bindingsByServiceId,
                      ).some((binding) => binding.source === 'connected');
                      if (!canRepairMissingIdentity) {
                        return buildMaterializationIdentityMissingSpawnErrorResult({
                          agentId: catalogAgentId,
                          reason: 'missing_identity_and_resume_state',
                        });
                      }
                      connectedServiceMaterializationIdentityV1 = createConnectedServiceMaterializationIdentity();
                      repairedMissingMaterializationIdentity = {
                        bindings: normalizedConnectedServiceBindings,
                        identity: connectedServiceMaterializationIdentityV1,
                      };
                    } else {
                      connectedServiceMaterializationIdentityV1 = createConnectedServiceMaterializationIdentity();
                    }
                  }
                  materializationKey = connectedServiceMaterializationIdentityV1.id;
                  normalizedOptions = {
                    ...normalizedOptions,
                    connectedServiceMaterializationIdentityV1,
                  };
                  try {
                    const connectedServiceAuthQuotaFreshnessMs = resolvePositiveIntEnv(
                      process.env.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_QUOTA_FRESHNESS_MS,
                      5 * 60_000,
                      { min: 1_000, max: 60 * 60_000 },
                    );
                    const connectedServiceSpawnQuotaProbeDeadlineAtMs = Date.now()
                      + DEFAULT_CONNECTED_SERVICE_QUOTA_FETCH_TIMEOUT_MS;
                    const preTurnSwitchCoordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
                      api,
                      prepareCandidateForSwitch: prepareAuthGroupCandidateForSwitch,
                      resolveCredentialRevision: (serviceId, profileId) => profileId
                        ? latestConnectedServiceProjectionSnapshot?.resolveCredentialRevision(serviceId, profileId) ?? null
                        : null,
                      resolveCurrentCredentialRevision: resolveCurrentConnectedServiceCredentialRevision,
                      runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
                      accountUsageStore: providerAccountUsageStore,
                      leases: connectedServiceAuthGroupSwitchLeases,
                      quotaFreshnessMs: connectedServiceAuthQuotaFreshnessMs,
                      nowMs: () => Date.now(),
                      restartSession: async () => {},
                      probeQuotaSnapshotsForGroup: async (input) => {
                        if (!connectedServiceQuotasCoordinator) return {
                          status: 'incomplete' as const,
                          requestedProfileCount: input.profileIds.length,
                          completedProfileCount: 0,
                          completedProfileIds: [],
                          reason: 'probe_unavailable' as const,
                        };
                        return await connectedServiceQuotasCoordinator.probeGroupQuotaSnapshots(input);
                      },
                      emitEvent: (event) => {
                        if (!event.success || event.resultStatus !== 'switched') return;
                        // Pre-turn/preemptive group switch — surface transcript event + notification
                        // through the single choke point. The committer no-ops on an unknown session,
                        // so the materialization-key fallback stays non-fatal when no session id exists.
                        surfaceConnectedServiceAccountSwitchOutcomeForSession({
                          sessionId: connectedServiceAuthSessionId ?? materializationKey,
                          event,
                        });
                      },
                    });
                    const activeAccountSettings = getActiveAccountSettingsSnapshot();
                    // K1 §2: only continuity-gate the spawn when shared-state continuity was requested
                    // for this agent. The gate proves the post-materialization target the vendor reads;
                    // a fresh (no-resume) spawn or an isolated spawn is not gated.
                    // RD-OPI-3: clamp the REQUESTED policy to the provider-EFFECTIVE state mode —
                    // providers whose descriptor reports `state.supported: false` (always-false
                    // reachability verifiers) must not enroll in the hard resume gate.
                    const spawnSharedStateContinuityRequested = resolveEffectiveProviderStateMode({
                      requestedStateMode: resolveConnectedServicesProviderStateSharingPolicyV1(
                        (activeAccountSettings?.settings as { connectedServicesProviderStateSharingSettingsV1?: unknown } | null)
                          ?.connectedServicesProviderStateSharingSettingsV1,
                        catalogAgentId,
                      ).stateMode,
                      descriptor: await getConnectedServiceStateSharingDescriptor(catalogAgentId),
                    }) === 'shared';
                    connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
                      agentId: catalogAgentId,
                      sessionDirectory: resolvedDirectory,
                      connectedServicesBindingsRaw: normalizedOptions.connectedServices,
                      materializationKey,
                      connectedServiceMaterializationIdentityV1,
                      activeServerDir: configuration.activeServerDir,
                      baseDir: connectedServicesMaterializationBaseDir,
                      credentials,
                      api,
                      accountUsageStore: providerAccountUsageStore,
                      runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
                      quotaFreshnessMs: connectedServiceAuthQuotaFreshnessMs,
                      nowMs: () => Date.now(),
                      sessionId: connectedServiceAuthSessionId,
                      authGroupSwitchCoordinator: preTurnSwitchCoordinator,
                      quotaProbeDeadlineAtMs: connectedServiceSpawnQuotaProbeDeadlineAtMs,
                      accountSettings: activeAccountSettings?.settings ?? null,
                      processEnv: process.env,
                      credentialRefreshService: connectedServiceRefreshCoordinator,
                      vendorResumeId: effectiveResume || null,
                      resumeReachabilityRequired: spawnSharedStateContinuityRequested,
                      candidatePersistedSessionFile: resolveConnectedServiceCandidatePersistedSessionFile(
                        catalogAgentId,
                        existingSessionPersistedMetadata,
                      ),
                    });
                    if (repairedMissingMaterializationIdentity && normalizedExistingSessionId) {
                      try {
                        await persistSessionConnectedServiceBindings({
                          credentials,
                          sessionId: normalizedExistingSessionId,
                          normalizedBindings: repairedMissingMaterializationIdentity.bindings,
                          connectedServiceMaterializationIdentityV1:
                            repairedMissingMaterializationIdentity.identity,
                        });
                      } catch (error) {
                        const cleanup = connectedServiceAuth?.cleanupOnFailure
                          ?? connectedServiceAuth?.cleanupMaterializationRoot
                          ?? null;
                        cleanup?.();
                        logger.warn('[DAEMON RUN] Failed to persist repaired connected-service materialization identity after exact existing-session materialization', error);
                        return buildMaterializationIdentityMissingSpawnErrorResult({
                          agentId: catalogAgentId,
                          reason: 'identity_repair_persist_failed',
                        });
                      }
                      logger.warn('[DAEMON RUN] Repaired missing connected-service materialization identity after exact existing-session materialization', {
                        sessionId: normalizedExistingSessionId,
                        agentId: catalogAgentId,
                      });
                    }
                  } catch (error) {
                    // K1 §2: the post-materialization re-verify proved the resumed session is
                    // unreachable in the REAL materialized target. Fail closed BEFORE the vendor
                    // launches with the concrete structured continuity reason, instead of respawning
                    // into a missing session file ("Pi process exited"). D2: we keep the verbatim
                    // SPAWN_VALIDATION_FAILED code + message (legacy consumers unchanged) AND attach a
                    // structured `errorDetail` so the client can programmatically recognize "resume
                    // unreachable" and offer "start fresh under the new account".
                    if (error instanceof ConnectedServiceSpawnResumeUnreachableError) {
                      logger.warn('[DAEMON RUN] Connected services resume reachability re-verify failed; failing closed before spawn', {
                        agentId: error.agentId,
                        errorCode: error.errorCode,
                        failurePhase: error.failurePhase,
                        vendorResumeId: error.vendorResumeId,
                        cwd: error.cwd,
                        targetMaterializedRoot: error.targetMaterializedRoot,
                        reason: error.reason,
                      });
                      return buildSpawnResumeUnreachableErrorResult(error);
                    }
                    if (error instanceof ConnectedServiceAuthGroupQuotaProbeIncompleteError) {
                      logger.warn('[DAEMON RUN] Connected-service quota evidence refresh did not complete before spawn; failing closed', {
                        agentId: catalogAgentId,
                        reason: error.reason ?? 'unknown',
                      });
                      return {
                        type: 'error',
                        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                        errorMessage: 'Connected service account availability could not be verified before launch. Please retry.',
                      };
                    }
                    if (error instanceof ConnectedServiceSpawnMaterializationError) {
                      logger.warn('[DAEMON RUN] Connected services materialization failed; failing closed before spawn', {
                        agentId: error.agentId,
                        diagnostics: error.diagnostics.map((diagnostic) => ({
                          code: diagnostic.code,
                          providerId: diagnostic.providerId,
                          serviceId: diagnostic.serviceId,
                          reason: diagnostic.reason,
                          severity: diagnostic.severity,
                        })),
                      });
                      return buildConnectedServiceMaterializationSpawnErrorResult(error);
                    }
                    const credentialRefreshErrorResult = buildConnectedServiceCredentialSpawnErrorResult({
                      agentId: catalogAgentId,
                      error,
                    });
                    if (credentialRefreshErrorResult) {
                      logger.warn('[DAEMON RUN] Connected services credential preflight failed; failing closed before spawn', {
                        agentId: catalogAgentId,
                        code: credentialRefreshErrorResult.errorMessage,
                      });
                      return credentialRefreshErrorResult;
                    }
                    logger.debug('[DAEMON RUN] Connected services resolution failed', error);
                    return {
                      type: 'error',
                      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                      errorMessage:
                        error instanceof Error
                          ? `Connected services resolution failed: ${error.message}`
                          : 'Connected services resolution failed.',
                    };
                  }
                }

                const effectiveConnectedServicesBindings =
                  connectedServiceAuth?.connectedServicesBindings ?? normalizedOptions.connectedServices;
                const effectiveSpawnOptionsBase: SpawnSessionOptions = {
                  ...normalizedOptions,
                  ...(effectiveConnectedServicesBindings
                    ? { connectedServices: effectiveConnectedServicesBindings }
                    : {}),
                };
                const sessionChildProcessEnv: NodeJS.ProcessEnv = { ...process.env };
                delete sessionChildProcessEnv[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY];

                const spawnEnvironment = await resolveSpawnChildEnvironment({
                  options: { ...effectiveSpawnOptionsBase, directory: resolvedDirectory },
                  profileEnvironmentVariables: environmentVariablesValidation.env,
                  daemonSpawnHooks,
                  processEnv: sessionChildProcessEnv,
                  logDebug: (message) => logger.debug(message),
                  logInfo: (message) => logger.info(message),
                  logWarn: (message) => logger.warn(message),
                  connectedServiceAuth,
                });
                spawnResourceCleanupOnFailure = spawnEnvironment.cleanupOnFailure;
                spawnResourceCleanupOnExit = spawnEnvironment.cleanupOnExit;
                if (!spawnEnvironment.ok) {
                  cleanupSpawnResources();
                  return {
                    type: 'error',
                    errorCode: spawnEnvironment.errorCode,
                    errorMessage: spawnEnvironment.errorMessage,
                  };
                }
                const extraEnv = spawnEnvironment.expandedEnvironmentVariables;
                const extraEnvForChild = spawnEnvironment.extraEnvForChild;
                const materializationDiagnostics = spawnEnvironment.materializationDiagnostics;
                const trackedSessionEnvironmentVariables = buildTrackedSessionRespawnEnvironmentVariables({
                  expandedEnvironmentVariables: extraEnv,
                  extraEnvForChild,
                });
                const {
                  existingSessionAttachPayload: _existingSessionAttachPayload,
                  initialTranscriptAfterSeq: _initialTranscriptAfterSeq,
                  executionAuthorization: _executionAuthorization,
                  initialGoal: _initialGoal,
                  ...trackedSpawnOptionsBase
                } = effectiveSpawnOptionsBase;
                const trackedSpawnOptions: SpawnSessionOptions = {
                  ...trackedSpawnOptionsBase,
                  ...(trackedSessionEnvironmentVariables
                    ? { environmentVariables: trackedSessionEnvironmentVariables }
                    : {}),
                  ...(materializationDiagnostics ? { materializationDiagnostics } : {}),
                };

            const downgradeLegacyImplicitTmuxRequest = shouldDowngradeLegacyImplicitTmuxRequest({
              terminal: normalizedOptions.terminal,
              backendTarget,
            });
            const terminalRequest = resolveTerminalRequestFromSpawnOptions({
              happyHomeDir: configuration.happyHomeDir,
              terminal: downgradeLegacyImplicitTmuxRequest ? undefined : normalizedOptions.terminal,
              environmentVariables: extraEnv,
            });
            let sessionAttachFilePath: string | null = null;
            if (normalizedExistingSessionId) {
              if (!sessionAttachPayload) {
                throw new Error('Missing session attach payload for existing session');
              }
              const attach = await createSessionAttachFile({
                happySessionId: normalizedExistingSessionId,
                payload: sessionAttachPayload,
              });
              sessionAttachFilePath = attach.filePath;
              sessionAttachCleanup = attach.cleanup;
            }

            const stackProcessKindOverride = resolveStackProcessKindOverrideForSessionSpawn(process.env);
            const extraEnvForChildWithMessage = {
              ...extraEnvForChild,
              ...(sessionAttachFilePath
                ? { HAPPIER_SESSION_ATTACH_FILE: sessionAttachFilePath }
                : {}),
              ...(pendingFirstInput
                ? { [HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]: serializePendingFirstInputForEnv(pendingFirstInput) }
                : {}),
              ...(initialGoal
                ? { [HAPPIER_DAEMON_INITIAL_GOAL_ENV_KEY]: serializeDaemonInitialGoalForEnv(initialGoal) }
                : {}),
              ...stackProcessKindOverride,
            };

            const tmuxRequested = terminalRequest.requested === 'tmux';
            const tmuxAvailable = tmuxRequested ? await isTmuxAvailable() : false;
            let useTmux = tmuxAvailable && tmuxRequested;

            const tmuxSessionName = tmuxRequested ? terminalRequest.tmux.sessionName : undefined;
            const tmuxTmpDir = tmuxRequested ? terminalRequest.tmux.tmpDir : null;
            const tmuxCommandEnv: Record<string, string> = {};
            if (tmuxTmpDir) {
              tmuxCommandEnv.TMUX_TMPDIR = tmuxTmpDir;
            }

            let tmuxFallbackReason: string | null = null;

            if (!tmuxAvailable && tmuxRequested) {
              tmuxFallbackReason = 'tmux is not available on this machine';
              logger.debug('[DAEMON RUN] tmux requested but tmux is not available; falling back to regular spawning');
            }

            if (acceptanceHooks) {
              try {
                await acceptanceHooks.onBeforeRunnerLaunchAccepted();
              } catch (error) {
                cleanupSpawnResources();
                if (sessionAttachCleanup) {
                  await sessionAttachCleanup();
                  sessionAttachCleanup = null;
                }
                return {
                  type: 'error',
                  errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                  errorMessage: `Failed to accept handoff runner launch: ${error instanceof Error ? error.message : String(error)}`,
                };
              }
            }

            const liveRunnerSnapshotFingerprints = resolveLiveRunnerSnapshotFingerprints(getCurrentChildren());
            const runtimeDecision = resolveHappyCliSubprocessRuntimeDecision({ liveRunnerSnapshotFingerprints });
            const runnerLaunchOptions: HappyCliSubprocessLaunchOptions = {
              preferWindowsPackagedBinary: true,
              liveRunnerSnapshotFingerprints,
              ...(runtimeDecision ? { runtimeDecision } : {}),
            };

            if (useTmux && tmuxSessionName !== undefined) {
              // Resolve empty-string session name (legacy "current/most recent") deterministically.
              let resolvedTmuxSessionName = tmuxSessionName;
              if (tmuxSessionName === '') {
                try {
                  const tmuxForDiscovery = new TmuxUtilities(undefined, tmuxCommandEnv);
                  const listResult = await tmuxForDiscovery.executeTmuxCommand([
                    'list-sessions',
                    '-F',
                    '#{session_name}\t#{session_attached}\t#{session_last_attached}',
                  ]);
                  resolvedTmuxSessionName =
                    selectPreferredTmuxSessionName(listResult?.stdout ?? '') ?? TmuxUtilities.DEFAULT_SESSION_NAME;
                } catch (error) {
                  logger.debug('[DAEMON RUN] Failed to resolve current/most-recent tmux session; defaulting to "happy"', error);
                  resolvedTmuxSessionName = TmuxUtilities.DEFAULT_SESSION_NAME;
                }
              }

              // Try to spawn in tmux session
              const sessionDesc = resolvedTmuxSessionName || 'current/most recent session';
              logger.debug(`[DAEMON RUN] Attempting to spawn session in tmux: ${sessionDesc}`);

              const agentSubcommand = resolveCliSubcommandFromBackendTarget(backendTarget);
              const windowName = `happy-${Date.now()}-${agentSubcommand}`;
              const tmuxTarget = `${resolvedTmuxSessionName}:${windowName}`;

              const terminalRuntimeArgs = [
                '--happy-terminal-mode',
                'tmux',
                '--happy-terminal-requested',
                'tmux',
                '--happy-tmux-target',
                tmuxTarget,
                ...(tmuxTmpDir ? ['--happy-tmux-tmpdir', tmuxTmpDir] : []),
              ];

                  const { commandTokens, tmuxEnv } = buildTmuxSpawnConfig({
                    agent: agentSubcommand,
                    directory: resolvedDirectory,
                    extraEnv: extraEnvForChildWithMessage,
                    tmuxCommandEnv,
                    launchOptions: runnerLaunchOptions,
                    extraArgs: [
                      ...terminalRuntimeArgs,
                  ...buildHappySessionControlArgs({
                    resume: effectiveResume,
                    existingSessionId: normalizedExistingSessionId,
                    backendTarget,
                    permissionMode,
                    permissionModeUpdatedAt,
                    agentModeId,
                    agentModeUpdatedAt,
                    modelId,
                    modelUpdatedAt,
                  }),
                    ],
                  });
              const tmux = new TmuxUtilities(resolvedTmuxSessionName, tmuxCommandEnv);

          // Spawn in tmux with environment variables
          // IMPORTANT: `spawnInTmux` uses `-e KEY=VALUE` flags for the window.
          // Use merged env so tmux mode matches regular process spawn behavior.
          // Note: this may add many `-e` flags; if it becomes a problem we can optimize
          // by diffing against `tmux show-environment` in a follow-up.
              if (tmuxTmpDir) {
                try {
                  await fs.mkdir(tmuxTmpDir, { recursive: true });
                } catch (error) {
                  logger.debug('[DAEMON RUN] Failed to ensure TMUX_TMPDIR exists; tmux may fail to start', error);
                }
              }

              const tmuxResult = await tmux.spawnInTmux(commandTokens, {
                sessionName: resolvedTmuxSessionName,
                windowName: windowName,
                cwd: resolvedDirectory
              }, tmuxEnv);  // Pass complete environment for tmux session

          if (tmuxResult.success) {
            logger.debug(`[DAEMON RUN] Successfully spawned in tmux session: ${tmuxResult.sessionId}, PID: ${tmuxResult.pid}`);

            // Validate we got a PID from tmux
            if (!tmuxResult.pid) {
              throw new Error('Tmux window created but no PID returned');
            }
            const tmuxPid = tmuxResult.pid;

            // Resolve the actual tmux session name used (important when sessionName was empty/undefined)
            const tmuxSession = tmuxResult.sessionName ?? (resolvedTmuxSessionName || 'happy');

                // Create a tracked session for tmux windows - now we have the real PID!
                const trackedSession: TrackedSession = {
                  startedBy: 'daemon',
                  happySessionId: normalizedExistingSessionId || undefined,
                  pid: tmuxPid, // Real PID from tmux -P flag
                  spawnOptions: trackedSpawnOptions,
                  tmuxSessionId: tmuxResult.sessionId,
                  tmuxTmpDir: typeof tmuxTmpDir === 'string' && tmuxTmpDir.trim().length > 0 ? tmuxTmpDir.trim() : undefined,
                  vendorResumeId: effectiveResume || undefined,
                  directoryCreated,
                  message: directoryCreated
                    ? `The path '${resolvedDirectory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSession}'. Use 'tmux attach -t ${tmuxSession}' to view the session.`
                    : `Spawned new session in tmux session '${tmuxSession}'. Use 'tmux attach -t ${tmuxSession}' to view the session.`
                };

                // Add to tracking map so webhook can find it later
              pidToTrackedSession.set(tmuxPid, trackedSession);
              await persistAcceptedSpawnMarker({
                pid: tmuxPid,
                spawnOptions: trackedSpawnOptions,
                directory: resolvedDirectory,
                existingSessionId: normalizedExistingSessionId,
              });
              if (connectedServiceAuth && effectiveConnectedServicesBindings) {
                registerConnectedServiceRuntimeTargetForDaemon({
                  runtimeRegistry: connectedServiceRuntimeRegistry,
                  pid: tmuxPid,
                  agentId: catalogAgentId,
                  sessionId: connectedServiceAuthSessionId,
                  connectedServicesBindingsRaw: effectiveConnectedServicesBindings,
                  connectedServiceSelectionsEnv: connectedServiceAuth.env,
                  materializationKey,
                  // RD-MAT-6: keep refresh-driven rematerialization on the live identity root and
                  // the session's working directory (workspace-trust projection target).
                  connectedServiceMaterializationIdentityV1: normalizedOptions.connectedServiceMaterializationIdentityV1,
                  sessionDirectory: resolvedDirectory,
                  runtimeAccountIdentitySelections: connectedServiceAuth.runtimeAccountIdentitySelections,
                  onRegisteredTarget: clearMemberRuntimeStateWithSuccessfulSpawnEvidence,
                });
              }
                if (spawnResourceCleanupOnExit) {
                  spawnResourceCleanupByPid.set(tmuxPid, spawnResourceCleanupOnExit);
                  spawnResourceCleanupArmed = true;
                }
                if (sessionAttachCleanup) {
                  sessionAttachCleanupByPid.set(tmuxPid, sessionAttachCleanup);
                  sessionAttachCleanup = null;
                }

            const acceptedResult = buildSpawnAcceptedResult({
              pid: tmuxPid,
              spawnNonce: trackedSpawnOptions.spawnNonce,
              fallbackSessionId: normalizedExistingSessionId,
            });
            // Preserve fast acknowledgement; the durable Pending row and server event own delivery.
            logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxPid} (tmux)`);
            const webhookCompletion = waitForSessionWebhook({
              pid: tmuxPid,
              pidToAwaiter,
                pidToSpawnResultResolver,
                pidToSpawnWebhookTimeout,
                timeoutErrorMessage: `Session webhook timeout for PID ${tmuxPid} (tmux)`,
                onTimeout: () => {
                  logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${tmuxPid} (tmux)`);
                },
              onSuccess: (completedSession) => {
                logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook (tmux)`);
              },
            }).then(async (result) => {
              const resolved = resolveSpawnWebhookResult({
                pid: tmuxPid,
                result,
                pidToTrackedSession,
                warn: (message) => logger.warn(message),
              });
              if (resolved.type === 'success' && resolved.sessionId) {
                await bindSpawnedTmuxTerminalAttachment({
                  happyHomeDir: configuration.happyHomeDir,
                  sessionId: resolved.sessionId,
                  tmuxSessionName: tmuxSession,
                  tmuxWindowName: tmuxResult.windowName ?? windowName,
                  ...(tmuxTmpDir ? { tmuxTmpDir } : {}),
                  disposeUnboundHost: async () => {
                    const target = `${tmuxSession}:${tmuxResult.windowName ?? windowName}`;
                    if (!await tmux.killWindow(target)) {
                      throw new Error(`Failed to dispose unbound tmux window ${target}`);
                    }
                  },
                });
              }
              daemonSpawnAttemptRegistry.settle(trackedSpawnOptions.spawnNonce ?? '', resolved);
              const nudgeResult = await nudgeAttachedExistingSessionPendingQueue({
                requestedExistingSessionId: normalizedExistingSessionId,
                credentials,
                isShutdownRequested: () => shutdownInitiated,
                resolved,
              });
              if (nudgeResult.type === 'error') {
                logger.warn(`[DAEMON RUN] Pending queue wake failed after webhook for PID ${tmuxPid} (tmux): ${nudgeResult.errorMessage}`);
              }
              return nudgeResult;
            }).catch((error) => {
              logger.warn(`[DAEMON RUN] Session webhook monitor failed for PID ${tmuxPid} (tmux): ${error instanceof Error ? error.message : String(error)}`);
              const result = {
                type: 'error' as const,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: error instanceof Error ? error.message : String(error),
              };
              daemonSpawnAttemptRegistry.settle(trackedSpawnOptions.spawnNonce ?? '', result);
              return result;
            });
            daemonSpawnAttemptRegistry.rememberAccepted({
              spawnNonce: trackedSpawnOptions.spawnNonce,
              result: acceptedResult,
            });
            void webhookCompletion;
            return acceptedResult;
              } else {
                tmuxFallbackReason = tmuxResult.error ?? 'tmux spawn failed';
                logger.debug(`[DAEMON RUN] Failed to spawn in tmux: ${tmuxResult.error}, falling back to regular spawning`);
                useTmux = false;
              }
            }

            // Regular process spawning (fallback or if tmux not available)
            if (!useTmux) {
              logger.debug(`[DAEMON RUN] Using regular process spawning`);

          const agentCommand = resolveCliSubcommandFromBackendTarget(backendTarget);
              const args = [
                agentCommand,
                '--happy-starting-mode', 'remote',
                '--started-by', 'daemon'
              ];

              if (tmuxRequested) {
                const reason = tmuxFallbackReason ?? 'tmux was not used';
                args.push(
                  '--happy-terminal-mode',
                  'plain',
              '--happy-terminal-requested',
              'tmux',
                  '--happy-terminal-fallback-reason',
                  reason,
                );
              }

              args.push(...buildHappySessionControlArgs({
                resume: effectiveResume,
                existingSessionId: normalizedExistingSessionId,
                backendTarget,
                permissionMode,
                permissionModeUpdatedAt,
                agentModeId,
                agentModeUpdatedAt,
                modelId,
                modelUpdatedAt,
              }));
              const windowsLaunchMode = resolveWindowsRemoteSessionConsoleMode({
                platform: process.platform,
                requested: normalizedOptions.windowsRemoteSessionLaunchMode ?? normalizedOptions.windowsRemoteSessionConsole,
                env: process.env,
              });

              const waitForWindowsHostedSession = async (params: {
                pid: number;
                logLabel: string;
                terminal: NonNullable<Metadata['terminal']>;
              }): Promise<SpawnSessionResult> => {
                if (sessionAttachCleanup) {
                  sessionAttachCleanupByPid.set(params.pid, sessionAttachCleanup);
                  sessionAttachCleanup = null;
                }

                const trackedSession: TrackedSession = {
                  startedBy: 'daemon',
                  happySessionId: normalizedExistingSessionId || undefined,
                  pid: params.pid,
                  spawnOptions: trackedSpawnOptions,
                  vendorResumeId: effectiveResume || undefined,
                  hostedTerminal: params.terminal,
                  directoryCreated,
                  message: directoryCreated ? `The path '${resolvedDirectory}' did not exist. We created a new folder and spawned a new session there.` : undefined,
                };
                pidToTrackedSession.set(params.pid, trackedSession);
                await persistAcceptedSpawnMarker({
                  pid: params.pid,
                  spawnOptions: trackedSpawnOptions,
                  directory: resolvedDirectory,
                  existingSessionId: normalizedExistingSessionId,
                });
                if (connectedServiceAuth && effectiveConnectedServicesBindings) {
                  registerConnectedServiceRuntimeTargetForDaemon({
                    runtimeRegistry: connectedServiceRuntimeRegistry,
                    pid: params.pid,
                    agentId: catalogAgentId,
                    sessionId: connectedServiceAuthSessionId,
                    connectedServicesBindingsRaw: effectiveConnectedServicesBindings,
                    connectedServiceSelectionsEnv: connectedServiceAuth.env,
                    materializationKey,
                    // RD-MAT-6: keep refresh-driven rematerialization on the live identity root and
                    // the session's working directory (workspace-trust projection target).
                    connectedServiceMaterializationIdentityV1: normalizedOptions.connectedServiceMaterializationIdentityV1,
                    sessionDirectory: resolvedDirectory,
                    runtimeAccountIdentitySelections: connectedServiceAuth.runtimeAccountIdentitySelections,
                    onRegisteredTarget: clearMemberRuntimeStateWithSuccessfulSpawnEvidence,
                  });
                }

                if (spawnResourceCleanupOnExit) {
                  spawnResourceCleanupByPid.set(params.pid, spawnResourceCleanupOnExit);
                  spawnResourceCleanupArmed = true;
                }

                const pollMsRaw = typeof process.env.HAPPIER_DAEMON_VISIBLE_CONSOLE_EXIT_POLL_MS === 'string'
                  ? process.env.HAPPIER_DAEMON_VISIBLE_CONSOLE_EXIT_POLL_MS.trim()
                  : '';
                const pollMsParsed = pollMsRaw ? Number(pollMsRaw) : NaN;
                const pollMs = Number.isFinite(pollMsParsed) && pollMsParsed > 0 ? pollMsParsed : 5000;

                logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${params.pid} (${params.logLabel})`);

                const acceptedResult = buildSpawnAcceptedResult({
                  pid: params.pid,
                  spawnNonce: trackedSpawnOptions.spawnNonce,
                  fallbackSessionId: normalizedExistingSessionId,
                });
                daemonSpawnAttemptRegistry.rememberAccepted({
                  spawnNonce: trackedSpawnOptions.spawnNonce,
                  result: acceptedResult,
                });

                const webhookCompletion = waitForVisibleConsoleSessionWebhook({
                  pid: params.pid,
                  pollMs,
                  pidToAwaiter,
                  pidToSpawnResultResolver,
                  pidToSpawnWebhookTimeout,
                  onChildExited,
                }).then(async (result) => {
                  const resolved = resolveSpawnWebhookResult({
                    pid: params.pid,
                    result,
                    pidToTrackedSession,
                    warn: (message) => logger.warn(message),
                  });
                  daemonSpawnAttemptRegistry.settle(trackedSpawnOptions.spawnNonce ?? '', resolved);
                  if (resolved.type === 'success') {
                    logger.debug(
                      `[DAEMON RUN] Session ${resolved.sessionId} fully spawned with webhook (${params.logLabel})`,
                    );
                    const resolvedSessionId =
                      typeof resolved.sessionId === 'string' ? resolved.sessionId.trim() : '';
                    if (resolvedSessionId) {
                      try {
                        await writeTerminalAttachmentInfo({
                          happyHomeDir: configuration.happyHomeDir,
                          sessionId: resolvedSessionId,
                          terminal: params.terminal,
                        });
                      } catch (error) {
                        logger.debug('[DAEMON RUN] Failed to persist Windows terminal attachment info', error);
                      }
                      try {
                        await publishCurrentTerminalControlServiceability({
                          credentials,
                          happyHomeDir: configuration.happyHomeDir,
                          sessionId: resolvedSessionId,
                          state: 'servable',
                        });
                      } catch (error) {
                        logger.debug('[DAEMON RUN] Failed to publish spawned terminal control serviceability', {
                          sessionId: resolvedSessionId,
                          error: serializeAxiosErrorForLog(error),
                        });
                      }
                    }
                  } else if (
                    resolved.type === 'error' &&
                    resolved.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
                  ) {
                    logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${params.pid} (${params.logLabel})`);
                  }
                }).catch((error) => {
                  logger.warn(`[DAEMON RUN] Session webhook monitor failed for PID ${params.pid} (${params.logLabel}): ${error instanceof Error ? error.message : String(error)}`);
                  daemonSpawnAttemptRegistry.settle(trackedSpawnOptions.spawnNonce ?? '', {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                    errorMessage: error instanceof Error ? error.message : String(error),
                  });
                });
                void webhookCompletion;
                return acceptedResult;
              };

              const buildWindowsHostedLaunchEnv = (launchSpec: ReturnType<typeof buildHappyCliSubprocessLaunchSpec>) =>
                buildSpawnChildProcessEnv({
                  processEnv: sessionChildProcessEnv,
                  extraEnv: {
                    ...extraEnvForChildWithMessage,
                    ...(launchSpec.env ?? {}),
                  },
                  serverSelectionEnv: {
                    activeServerId: configuration.activeServerId,
                    canonicalServerUrl: configuration.serverUrl,
                    apiServerUrl: configuration.apiServerUrl,
                    webappUrl: configuration.webappUrl,
                  },
                });

              if (windowsLaunchMode === 'windows_terminal' || windowsLaunchMode === 'console') {
                const windowsTerminalIdentity = buildWindowsTerminalWindowIdentity({
                  existingSessionId: normalizedExistingSessionId,
                  reservedSessionId: typeof sessionId === 'string' ? sessionId : undefined,
                  agentCommand,
                  windowName: resolveWindowsTerminalWindowName({
                    requested: normalizedOptions.windowsTerminalWindowName,
                    env: process.env,
                  }),
                });

                const tryConsoleLaunch = async (params: {
                  requested: 'windows_terminal' | 'console';
                  fallbackReason?: string;
                }): Promise<SpawnSessionResult> => {
                  const consoleArgs = buildWindowsHostedTerminalArgs({
                    baseArgs: args,
                    actualMode: 'windows_console',
                    requestedMode: params.requested,
                    fallbackReason: params.fallbackReason,
                  });
                  const launchSpec = buildHappyCliSubprocessLaunchSpec(consoleArgs, runnerLaunchOptions);
                  const started = await startHappySessionInVisibleWindowsConsole({
                    filePath: launchSpec.filePath,
                    args: launchSpec.args,
                    workingDirectory: resolvedDirectory,
                    env: buildWindowsHostedLaunchEnv(launchSpec),
                  });

                  if (!started.ok) {
                    logger.debug('[DAEMON RUN] Failed to spawn visible Windows console session', { error: started.errorMessage });
                    cleanupSpawnResources();
                    if (sessionAttachCleanup) {
                      await sessionAttachCleanup();
                      sessionAttachCleanup = null;
                    }
                    return {
                      type: 'error',
                      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                      errorMessage: started.errorMessage,
                    };
                  }

                  logger.debug(`[DAEMON RUN] Spawned visible-console session with PID ${started.pid}`);
                  return await waitForWindowsHostedSession({
                    pid: started.pid,
                    logLabel: params.requested === 'windows_terminal' ? 'windows console fallback' : 'visible console',
                    terminal: buildWindowsHostedTerminalAttachment({
                      actualMode: 'windows_console',
                      requestedMode: params.requested,
                      pid: started.pid,
                      fallbackReason: params.fallbackReason,
                    }),
                  });
                };

                if (windowsLaunchMode === 'windows_terminal') {
	                  const windowsTerminalArgs = buildWindowsHostedTerminalArgs({
	                    baseArgs: args,
	                    actualMode: 'windows_terminal',
	                    requestedMode: 'windows_terminal',
	                    windowId: windowsTerminalIdentity.windowId,
	                    title: windowsTerminalIdentity.title,
	                  });
                  const launchSpec = buildHappyCliSubprocessLaunchSpec(windowsTerminalArgs, runnerLaunchOptions);
                  const started = await startHappySessionInWindowsTerminal({
                    filePath: launchSpec.filePath,
                    args: launchSpec.args,
                    workingDirectory: resolvedDirectory,
                    env: buildWindowsHostedLaunchEnv(launchSpec),
                    windowId: windowsTerminalIdentity.windowId,
                    title: windowsTerminalIdentity.title,
                  });

                  if (started.ok) {
                    logger.debug(`[DAEMON RUN] Spawned Windows Terminal session with PID ${started.pid}`);
                    return await waitForWindowsHostedSession({
                      pid: started.pid,
                      logLabel: 'windows terminal',
                      terminal: buildWindowsHostedTerminalAttachment({
                        actualMode: 'windows_terminal',
                        requestedMode: 'windows_terminal',
                        pid: started.pid,
                        windowId: windowsTerminalIdentity.windowId,
                        title: windowsTerminalIdentity.title,
                      }),
                    });
                  }

                  logger.debug('[DAEMON RUN] Failed to spawn Windows Terminal session; falling back to console', {
                    error: started.errorMessage,
                  });
                  return await tryConsoleLaunch({
                    requested: 'windows_terminal',
                    fallbackReason: started.errorMessage,
                  });
                }

                return await tryConsoleLaunch({ requested: 'console' });
              }

                  // NOTE: sessionId is reserved for future Happy session resume; we currently ignore it.
              const childProcessEnv = buildSpawnChildProcessEnv({
                processEnv: sessionChildProcessEnv,
                extraEnv: extraEnvForChildWithMessage,
                serverSelectionEnv: {
                  activeServerId: configuration.activeServerId,
                  canonicalServerUrl: configuration.serverUrl,
                  apiServerUrl: configuration.apiServerUrl,
                  webappUrl: configuration.webappUrl,
                },
              });
              const spawnOptions = {
                cwd: resolvedDirectory,
                // Daemon-managed session runners must survive daemon replacement and shutdown.
                // Keep them detached from the daemon lifecycle instead of piping them through it.
                detached: true,
                stdio: 'ignore' as const,
                windowsHide: true,
                env: childProcessEnv,
              };
              const cgroupSelfMigratingLaunchSpec =
                process.platform === 'linux' && startupSource === 'background-service'
                  ? await buildCgroupSelfMigratingHappyCliLaunchSpec({
                    args,
                    daemonPid: process.pid,
                    environment: childProcessEnv,
                    launchOptions: runnerLaunchOptions,
                  })
                  : null;
              const happyProcess = cgroupSelfMigratingLaunchSpec
                ? spawnChildProcess(
                  cgroupSelfMigratingLaunchSpec.filePath,
                  cgroupSelfMigratingLaunchSpec.args,
                  {
                    ...spawnOptions,
                    env: {
                      ...childProcessEnv,
                      ...(cgroupSelfMigratingLaunchSpec.env ?? {}),
                    },
                  },
                )
                : spawnHappyCLI(args, spawnOptions, runnerLaunchOptions);

              if (!happyProcess.pid) {
                logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
                if (spawnResourceCleanupOnFailure && !spawnResourceCleanupArmed) {
                  spawnResourceCleanupOnFailure();
                  spawnResourceCleanupOnFailure = null;
                  spawnResourceCleanupOnExit = null;
                }
                if (sessionAttachCleanup) {
                  await sessionAttachCleanup();
                  sessionAttachCleanup = null;
                }
                return {
                  type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_NO_PID,
                  errorMessage: 'Failed to spawn Happier process - no PID returned'
                };
              }

              logger.debug(`[DAEMON RUN] Spawned process with PID ${happyProcess.pid}`);
              happyProcess.unref();
              void applySpawnedChildOomScoreAdjustment({
                pid: happyProcess.pid,
                startupSource,
                logDebug: (message, context) => logger.debug(message, context),
              });
              if (sessionAttachCleanup) {
                sessionAttachCleanupByPid.set(happyProcess.pid, sessionAttachCleanup);
                sessionAttachCleanup = null;
              }

                  const trackedSession: TrackedSession = {
                    startedBy: 'daemon',
                    happySessionId: normalizedExistingSessionId || undefined,
                    pid: happyProcess.pid,
                    childProcess: happyProcess,
                    spawnOptions: trackedSpawnOptions,
                    vendorResumeId: effectiveResume || undefined,
                    directoryCreated,
                    message: directoryCreated ? `The path '${resolvedDirectory}' did not exist. We created a new folder and spawned a new session there.` : undefined
                  };

          pidToTrackedSession.set(happyProcess.pid, trackedSession);
          await persistAcceptedSpawnMarker({
            pid: happyProcess.pid,
            spawnOptions: trackedSpawnOptions,
            directory: resolvedDirectory,
            existingSessionId: normalizedExistingSessionId,
          });
          // Clear any stale stop request on an explicit (re)spawn/resume of this session, so a later
          // GENUINE crash of a resumed-after-stop session can respawn. The per-session stop flag is
          // otherwise never cleared (clearStopRequested had no caller), which silently vetoed the
          // respawn forever — see the exit-143 crash RCA. A user-stopped session never reaches this
          // path via the respawn manager (its respawn is suppressed), so clearing here is safe.
          if (normalizedExistingSessionId) {
            sessionRunnerRespawnManager.clearStopRequested(normalizedExistingSessionId);
          }
          if (connectedServiceAuth && effectiveConnectedServicesBindings) {
            registerConnectedServiceRuntimeTargetForDaemon({
              runtimeRegistry: connectedServiceRuntimeRegistry,
              pid: happyProcess.pid,
              agentId: catalogAgentId,
              sessionId: connectedServiceAuthSessionId,
              connectedServicesBindingsRaw: effectiveConnectedServicesBindings,
              connectedServiceSelectionsEnv: connectedServiceAuth.env,
              materializationKey,
              // RD-MAT-6: keep refresh-driven rematerialization on the live identity root and
              // the session's working directory (workspace-trust projection target).
              connectedServiceMaterializationIdentityV1: normalizedOptions.connectedServiceMaterializationIdentityV1,
              sessionDirectory: resolvedDirectory,
              runtimeAccountIdentitySelections: connectedServiceAuth.runtimeAccountIdentitySelections,
              onRegisteredTarget: clearMemberRuntimeStateWithSuccessfulSpawnEvidence,
            });
          }
          if (spawnResourceCleanupOnExit) {
            spawnResourceCleanupByPid.set(happyProcess.pid, spawnResourceCleanupOnExit);
            spawnResourceCleanupArmed = true;
          }

          happyProcess.on('exit', (code, signal) => {
            logger.debug(`[DAEMON RUN] Child PID ${happyProcess.pid} exited with code ${code}, signal ${signal}`);
            if (happyProcess.pid) {
              const resolveSpawn = pidToSpawnResultResolver.get(happyProcess.pid);
              if (resolveSpawn) {
                pidToSpawnResultResolver.delete(happyProcess.pid);
                const timeout = pidToSpawnWebhookTimeout.get(happyProcess.pid);
                if (timeout) clearTimeout(timeout);
                pidToSpawnWebhookTimeout.delete(happyProcess.pid);
                pidToAwaiter.delete(happyProcess.pid);
                resolveSpawn({
                  type: 'error',
                  errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
                  errorMessage: `Child process exited before session webhook (pid=${happyProcess.pid}, code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
                });
              }
              void onChildExited(happyProcess.pid, { reason: 'process-exited', code, signal }).catch((error) => {
                logger.warn('[DAEMON RUN] Failed to complete child-exit lifecycle after process exit', { pid: happyProcess.pid, error });
              });
            }
          });

          happyProcess.on('error', (error) => {
            logger.debug(`[DAEMON RUN] Child process error:`, error);
            if (happyProcess.pid) {
              const resolveSpawn = pidToSpawnResultResolver.get(happyProcess.pid);
              if (resolveSpawn) {
                pidToSpawnResultResolver.delete(happyProcess.pid);
                const timeout = pidToSpawnWebhookTimeout.get(happyProcess.pid);
                if (timeout) clearTimeout(timeout);
                pidToSpawnWebhookTimeout.delete(happyProcess.pid);
                pidToAwaiter.delete(happyProcess.pid);
                resolveSpawn({
                  type: 'error',
                  errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
                  errorMessage: `Child process error before session webhook (pid=${happyProcess.pid})`,
                });
              }
              void onChildExited(happyProcess.pid, { reason: 'process-error', code: null, signal: null }).catch((error) => {
                logger.warn('[DAEMON RUN] Failed to complete child-exit lifecycle after process error', { pid: happyProcess.pid, error });
              });
            }
          });

          const acceptedResult = buildSpawnAcceptedResult({
            pid: happyProcess.pid,
            spawnNonce: trackedSpawnOptions.spawnNonce,
            fallbackSessionId: normalizedExistingSessionId,
          });
          // The durable Pending row survives process startup and owns provider delivery.
          logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${happyProcess.pid}`);
              const webhookCompletion = waitForSessionWebhook({
                pid: happyProcess.pid!,
                pidToAwaiter,
                pidToSpawnResultResolver,
                pidToSpawnWebhookTimeout,
                timeoutErrorMessage: `Session webhook timeout for PID ${happyProcess.pid}`,
                onTimeout: () => {
                  logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${happyProcess.pid}`);
                },
                onSuccess: (completedSession) => {
                  logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook`);
            },
          }).then(async (result) => {
            const resolved = resolveSpawnWebhookResult({
              pid: happyProcess.pid!,
              result,
              pidToTrackedSession,
              warn: (message) => logger.warn(message),
            });
            daemonSpawnAttemptRegistry.settle(trackedSpawnOptions.spawnNonce ?? '', resolved);
            const nudgeResult = await nudgeAttachedExistingSessionPendingQueue({
              requestedExistingSessionId: normalizedExistingSessionId,
              credentials,
              isShutdownRequested: () => shutdownInitiated,
              resolved,
            });
            if (nudgeResult.type === 'error') {
              logger.warn(`[DAEMON RUN] Pending queue wake failed after webhook for PID ${happyProcess.pid}: ${nudgeResult.errorMessage}`);
            }
            return nudgeResult;
          }).catch((error) => {
            logger.warn(`[DAEMON RUN] Session webhook monitor failed for PID ${happyProcess.pid}: ${error instanceof Error ? error.message : String(error)}`);
            const result = {
              type: 'error' as const,
              errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
              errorMessage: error instanceof Error ? error.message : String(error),
            };
            daemonSpawnAttemptRegistry.settle(trackedSpawnOptions.spawnNonce ?? '', result);
            return result;
          });
          daemonSpawnAttemptRegistry.rememberAccepted({
            spawnNonce: trackedSpawnOptions.spawnNonce,
            result: acceptedResult,
          });
          void webhookCompletion;
          return acceptedResult;
        }

        // This should never be reached, but TypeScript requires a return statement
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
          errorMessage: 'Unexpected error in session spawning'
        };
              } catch (error) {
                if (spawnResourceCleanupOnFailure && !spawnResourceCleanupArmed) {
                  spawnResourceCleanupOnFailure();
                  spawnResourceCleanupOnFailure = null;
              spawnResourceCleanupOnExit = null;
            }
            if (sessionAttachCleanup) {
              await sessionAttachCleanup();
              sessionAttachCleanup = null;
            }
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.debug('[DAEMON RUN] Failed to spawn session:', error);
                    return {
                      type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                      errorMessage: `Failed to spawn session: ${errorMessage}`
                    };
                  }
              });
          });
                };

        const temporaryThrottleResumeSnapshotsBySessionId = new Map<string, TrackedSession>();
        const findTemporaryThrottleTrackedSession = (sessionId: string): TrackedSession | null => {
          const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
          if (!normalizedSessionId) return null;
          return getCurrentChildren().find((child) => child.happySessionId === normalizedSessionId)
            ?? temporaryThrottleResumeSnapshotsBySessionId.get(normalizedSessionId)
            ?? null;
        };
        // RD-REC-16: the throttle intent is durable but the in-memory resume snapshot is
        // not (and must not be persisted: spawn options can carry secret environment
        // values). After a daemon restart, rebuild the resume source from persisted
        // session metadata instead of dead-lettering the hydrated intent.
        const resolveTemporaryThrottleResumeSource = async (
          sessionId: string,
        ): Promise<TemporaryThrottleResumeSource | null> => {
          const tracked = findTemporaryThrottleTrackedSession(sessionId);
          if (tracked) return tracked;
          const effectiveCredentials = (await readCredentials().catch(() => null)) ?? credentials;
          const token = typeof effectiveCredentials?.token === 'string' ? effectiveCredentials.token.trim() : '';
          if (!effectiveCredentials || !token) return null;
          return await resolveInactiveTemporaryThrottleResumeSource({
            sessionId,
            fallbackMachineId: machineId,
            fetchSession: async (id) => await fetchSessionByIdCompat({ token, sessionId: id }),
            decryptSessionMetadata: (rawSession) => tryDecryptSessionMetadata({
              credentials: effectiveCredentials,
              rawSession,
            }),
          });
        };
        const temporaryThrottleRecoveryScheduler = new TemporaryThrottleRecoveryScheduler({
          nowMs: () => Date.now(),
          baseBackoffMs: resolvePositiveIntEnv(
            process.env.HAPPIER_CONNECTED_SERVICES_TEMPORARY_THROTTLE_BASE_BACKOFF_MS,
            1_000,
            { min: 100, max: 60_000 },
          ),
          maxBackoffMs: resolvePositiveIntEnv(
            process.env.HAPPIER_CONNECTED_SERVICES_TEMPORARY_THROTTLE_MAX_BACKOFF_MS,
            60_000,
            { min: 1_000, max: 10 * 60_000 },
          ),
          store: createRecoveryIntentFileStore<TemporaryThrottleRecoveryIntent>(join(
            configuration.activeServerDir,
            'connected-services',
            'temporary-throttle-recovery.json',
          )),
          retry: async (_intent, { sessionId }) => {
            const tracked = await resolveTemporaryThrottleResumeSource(sessionId);
            if (!tracked) {
              temporaryThrottleResumeSnapshotsBySessionId.delete(sessionId);
              return {
                status: 'exhausted',
                lastError: 'temporary_throttle_session_not_found',
              };
            }
            return { status: 'ready' };
          },
          resume: async (intent, { sessionId }) => {
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
            const result = await continueTrackedTemporaryThrottleSession({
              tracked,
              sessionId,
              credentials,
              readCredentials,
              spawnSession,
              attemptId: intent.issueFingerprint,
              continuation: intent.continuation,
            });
            if (result.status === 'continued') {
              temporaryThrottleResumeSnapshotsBySessionId.delete(sessionId);
              logger.debug('[DAEMON RUN] Temporary throttle recovery handed continuation to Pending', {
                sessionId,
              });
              return result;
            }
            if (result.status === 'superseded' || result.status === 'terminal') {
              temporaryThrottleResumeSnapshotsBySessionId.delete(sessionId);
              return result;
            }
            const runtimeResult = result.runtimeResult;
            if (runtimeResult.status === 'unavailable') {
              throw new Error(`temporary_throttle_resume_unavailable:${runtimeResult.reason}`);
            }
            throw new Error(`temporary_throttle_resume_failed:${runtimeResult.errorCode ?? runtimeResult.reason}`);
          },
        });
        temporaryThrottleRecoveryScheduler.hydrate();
        const temporaryThrottleRecovery = {
          enable: async (input: Parameters<typeof temporaryThrottleRecoveryScheduler.enable>[0]) => {
            const tracked = getCurrentChildren().find((child) => child.happySessionId === input.sessionId) ?? null;
            if (tracked) {
              temporaryThrottleResumeSnapshotsBySessionId.set(
                input.sessionId,
                snapshotTrackedSessionForTemporaryThrottleResume(tracked),
              );
            }
            return await temporaryThrottleRecoveryScheduler.enable(input);
          },
        };

        // Generic crash respawn remains opt-in. Deliberate recovery operations pass forceRestart
        // through the manager and are bounded by their own intended-restart policy.
        const sessionRespawnEnabled = parseBooleanEnv(process.env.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED, false);
        const sessionRespawnMaxAttempts = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SESSION_RESPAWN_MAX_ATTEMPTS,
          10,
          { min: 0, max: 100 },
        );
        const sessionRespawnBaseDelayMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SESSION_RESPAWN_BASE_DELAY_MS,
          1_000,
          { min: 50, max: 5 * 60_000 },
        );
        const sessionRespawnMaxDelayMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SESSION_RESPAWN_MAX_DELAY_MS,
          60_000,
          { min: 50, max: 30 * 60_000 },
        );
        const sessionRespawnJitterMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SESSION_RESPAWN_JITTER_MS,
          250,
          { min: 0, max: 10_000 },
        );

        const isSessionAlreadyRunning = async (sessionId: string): Promise<boolean> => {
          return await isSessionRunnerActive(sessionId);
        };
        // A stopped runner marker is diagnostic state, not authorization to
        // recreate provider execution after a later daemon start.
        const prepareStopSessionForDaemonStop = (): void => {};
        const clearConnectedServiceRestartIntentForPid = (pid: number, logMessage: string): void => {
          void clearSessionMarkerConnectedServiceRestartIntent(pid).catch((error) => {
            logger.debug(logMessage, error);
          });
        };
        const sessionRespawnMaxRestarts = sessionRespawnMaxAttempts === 0 ? null : sessionRespawnMaxAttempts;
        const sessionIntendedRestartMaxAttempts = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SESSION_INTENDED_RESTART_MAX_ATTEMPTS,
          20,
          { min: 0, max: 200 },
        );
        const sessionIntendedRestartWindowMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SESSION_INTENDED_RESTART_WINDOW_MS,
          30 * 60_000,
          { min: 60_000, max: 24 * 60 * 60_000 },
        );
        const sessionRunnerRestartCompletionTimeoutMs = resolvePositiveIntEnv(
          process.env.HAPPIER_DAEMON_SESSION_RUNNER_RESTART_COMPLETION_TIMEOUT_MS,
          60_000,
          { min: 1_000, max: 10 * 60_000 },
        );
        type SessionRunnerRestartCompletionWaiter = Readonly<{
          settle: (completion: RestartSessionRunnerCompletion) => void;
        }>;
        const sessionRunnerRestartCompletionWaiters = new Map<string, SessionRunnerRestartCompletionWaiter>();
        const sessionRunnerRestartCompletionKey = (sessionId: string, previousPid: number): string =>
          `${sessionId}\u0000${previousPid}`;
        const buildSessionRunnerRestartTerminalCompletion = (
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
        const settleSessionRunnerRestartCompletion = (
          sessionId: string,
          previousPid: number,
          completion: RestartSessionRunnerCompletion,
        ): void => {
          const key = sessionRunnerRestartCompletionKey(sessionId, previousPid);
          const waiter = sessionRunnerRestartCompletionWaiters.get(key);
          if (!waiter) return;
          sessionRunnerRestartCompletionWaiters.delete(key);
          waiter.settle(completion);
        };
        const createSessionRunnerRestartCompletionWaiter = (
          sessionId: string,
          previousPid: number,
        ): Readonly<{
          promise: Promise<RestartSessionRunnerCompletion>;
          cancel: () => void;
        }> => {
          const key = sessionRunnerRestartCompletionKey(sessionId, previousPid);
          let resolved = false;
          let resolveCompletion!: (completion: RestartSessionRunnerCompletion) => void;
          const promise = new Promise<RestartSessionRunnerCompletion>((resolve) => {
            resolveCompletion = resolve;
          });
          const timer = setTimeout(() => {
            settleSessionRunnerRestartCompletion(sessionId, previousPid, {
              ok: false,
              status: 'partial_failure',
              diagnostics: {
                respawnTerminalReason: 'timeout',
                timeoutMs: sessionRunnerRestartCompletionTimeoutMs,
              },
            });
          }, sessionRunnerRestartCompletionTimeoutMs) as NodeJS.Timeout & { unref?: () => void };
          timer.unref?.();
          const settle = (completion: RestartSessionRunnerCompletion) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            resolveCompletion(completion);
          };
          const existing = sessionRunnerRestartCompletionWaiters.get(key);
          existing?.settle({
            ok: false,
            status: 'partial_failure',
            diagnostics: { respawnTerminalReason: 'superseded_waiter' },
          });
          sessionRunnerRestartCompletionWaiters.set(key, { settle });
          return {
            promise,
            cancel: () => {
              if (resolved) return;
              resolved = true;
              clearTimeout(timer);
              sessionRunnerRestartCompletionWaiters.delete(key);
              resolveCompletion({
                ok: false,
                status: 'partial_failure',
                diagnostics: { respawnTerminalReason: 'cancelled_before_signal' },
              });
            },
          };
        };
        const connectedServiceRestartAmplificationGuard = createConnectedServiceSessionRestartAmplificationGuard();
        const sessionRunnerRespawnManager = createSessionRunnerRespawnManager({
          enabled: sessionRespawnEnabled,
          maxRestarts: sessionRespawnMaxRestarts,
          maxIntendedRestarts: sessionIntendedRestartMaxAttempts,
          intendedRestartWindowMs: sessionIntendedRestartWindowMs,
          baseDelayMs: sessionRespawnBaseDelayMs,
          maxDelayMs: sessionRespawnMaxDelayMs,
          jitterMs: sessionRespawnJitterMs,
          isSessionAlreadyRunning,
          spawnSession,
          resolveRespawnOptions: async (input) => {
            return await resolveRespawnSessionRuntimeSnapshot({
              ...input,
              credentials,
              readCredentials,
            });
          },
          onRespawnSuccess: ({ sessionId, previousPid }) => {
            connectedServicesRestartRequestedPids.delete(previousPid);
            connectedServiceRestartAmplificationGuard.completePid(previousPid, { status: 'success' });
            clearConnectedServiceRestartIntentForPid(
              previousPid,
              '[DAEMON RUN] Failed to clear connected-service restart intent after respawn success',
            );
            const next = getCurrentChildren().find((child) => child.happySessionId === sessionId) ?? null;
            settleSessionRunnerRestartCompletion(sessionId, previousPid, {
              ok: true,
              ...(next ? { next: summarizeSessionRunnerEndpoint(next) } : {}),
            });
          },
          onRespawnTerminal: ({ sessionId, previousPid, reason, detail }) => {
            connectedServicesRestartRequestedPids.delete(previousPid);
            connectedServiceRestartAmplificationGuard.completePid(
              previousPid,
              reason === 'not_authenticated'
                ? { status: 'terminal', reason }
                : { status: 'cleared' },
            );
            clearConnectedServiceRestartIntentForPid(
              previousPid,
              '[DAEMON RUN] Failed to clear connected-service restart intent after terminal respawn suppression',
            );
            settleSessionRunnerRestartCompletion(
              sessionId,
              previousPid,
              buildSessionRunnerRestartTerminalCompletion(reason, detail),
            );
          },
          random: () => Math.random(),
          logDebug: (message, payload) => logger.debug(message, payload),
          logWarn: (message) => logger.warn(message),
        });

        let observeConnectedServiceRestartProcessMissing: ((tracked: TrackedSession) => Promise<void>) | null = null;

        const connectedServiceTurnDeferralQueue = createConnectedServiceSwitchDeferralQueue({
          timeoutMs: resolvePositiveIntEnv(
            process.env.HAPPIER_CONNECTED_SERVICES_TURN_DEFERRAL_TIMEOUT_MS,
            60_000,
            { min: 1_000, max: 10 * 60_000 },
          ),
          disableDeferral: String(process.env.HAPPIER_CONNECTED_SERVICES_DISABLE_TURN_DEFERRAL ?? '').trim() === '1',
          emitSessionEvent: (sessionId, event) => {
            void commitConnectedServiceAccountSwitchSessionEvent({
              credentials,
              sessionId,
              event,
              listConnectedServiceProfiles: api.listConnectedServiceProfiles.bind(api),
              getConnectedServiceAuthGroup: api.getConnectedServiceAuthGroup.bind(api),
            }).catch((error) => {
              logger.debug('[DAEMON RUN] Failed to commit connected-service switch deferral session event (non-fatal)', error);
            });
          },
        });

        // Lane F prevention: expose per-session turn-in-flight state to the OpenCode managed-server
        // auth-switch release path (a pure module that cannot import the daemon queue directly). The
        // release refuses to kill a server whose sole claimant is still mid-turn (closes the OQ-2
        // sole-claimant mid-turn-kill window). Cleared on shutdown (see cleanupAndShutdown).
        setOpenCodeConnectedServiceInFlightTurnProvider(
          (sessionId) => connectedServiceTurnDeferralQueue.isTurnInFlight(sessionId),
        );
        const resolveSessionRunnerActivityDisabledReason = (
          sessionId: string,
        ): SessionRunnerRestartDisabledReason | null => resolveSessionRunnerActivityDisabledReasonFromReaders(sessionId, {
          isTurnInProgress: (id) => connectedServiceTurnDeferralQueue.isTurnInFlight(id),
        });

        const normalizeSwitchTarget = (input: Readonly<{
          serviceId?: string | null;
          profileId?: string | null;
          groupId?: string | null;
          generation?: number | null;
        }>): ConnectedServiceSwitchTarget => ({
          serviceId: typeof input.serviceId === 'string' ? input.serviceId : '',
          profileId: typeof input.profileId === 'string' ? input.profileId : '',
          groupId: typeof input.groupId === 'string' ? input.groupId : '',
          generation: typeof input.generation === 'number' && Number.isFinite(input.generation)
            ? Math.max(0, Math.trunc(input.generation))
            : 0,
        });

        const requestConnectedServiceRestartWithDeferral = async (input: Readonly<{
          sessionId: string;
          tracked: TrackedSession;
          source: 'manual' | 'automatic';
          policy: 'defer_until_turn_boundary' | 'defer_until_idle';
          target: ConnectedServiceSwitchTarget;
          restartSignalDelayMs: number;
          restartDiagnostic: ConnectedServiceDaemonRestartDiagnosticInput;
          transcriptEventOwner: ConnectedServiceRestartRequestedTranscriptEventOwner;
          onSignalFailureLogMessage: string;
          awaitPreviousRunnerRetirement?: boolean;
        }>): Promise<Readonly<{ signaled: boolean }>> => {
          // K5:gated_restart connected-service restarts route through the generic planned runner
          // restart primitive, preserving deferral, stale-owner checks, PID reservation, and respawn.
          const completionWaiter = input.awaitPreviousRunnerRetirement
            ? createSessionRunnerRestartCompletionWaiter(input.sessionId, input.tracked.pid)
            : null;
          try {
            const restart = await requestPlannedRunnerRestart({
              sessionId: input.sessionId,
              tracked: input.tracked,
              reason: 'connected_service_switch',
              deferral: {
                kind: 'connected_service_switch',
                source: input.source,
                policy: input.policy,
                target: input.target,
                turnDeferralQueue: connectedServiceTurnDeferralQueue,
              },
              restartRequestedPids: connectedServicesRestartRequestedPids,
              pidToTrackedSession,
              canSignal: () => resolveSessionRunnerActivityDisabledReason(input.sessionId) ?? true,
              requestSignal: async ({ shouldSignal, onSignalFailure, onProcessAlreadyMissing }) =>
                // K5:gated_restart raw signal is owned by planned runner restart deferral/reservation.
                await requestConnectedServiceSessionRestartSignal({
                  pid: input.tracked.pid,
                  processGroupPid: resolveConnectedServiceRestartProcessGroupPid(input.tracked),
                  delayMs: input.restartSignalDelayMs,
                  shouldSignal,
                  restartDiagnostic: input.restartDiagnostic,
                  recordRestartDiagnostic: recordConnectedServiceRestartDiagnostic,
                  restartAmplificationGuard: connectedServiceRestartAmplificationGuard,
                  onSignalFailure,
                  onProcessAlreadyMissing,
                }),
              observeProcessMissing: (tracked) => {
                if (observeConnectedServiceRestartProcessMissing) {
                  void observeConnectedServiceRestartProcessMissing(tracked).catch((error) => {
                    logger.warn('[DAEMON RUN] Failed to stage connected-service restart process exit', { pid: tracked.pid, error });
                  });
                } else {
                  logger.warn('[DAEMON RUN] Connected-service restart process was already missing before exit observer was ready');
                }
              },
              clearRestartIntentForPid: (pid) => {
                clearConnectedServiceRestartIntentForPid(
                  pid,
                  '[DAEMON RUN] Failed to clear connected-service restart intent after skipped or failed signal',
                );
              },
              onSignalFailureLogMessage: input.onSignalFailureLogMessage,
              logDebug: (message, payload) => logger.debug(message, payload),
              logWarn: (message, payload) => logger.warn(message, payload),
            });
            if (shouldEmitConnectedServiceRestartRequestedSessionEvent({
              owner: input.transcriptEventOwner,
              signaled: restart.signaled,
            })) {
              void commitConnectedServiceAccountSwitchSessionEvent({
                credentials,
                sessionId: input.sessionId,
                event: buildConnectedServiceRestartRequestedSessionEvent(input.restartDiagnostic),
              }).catch((error) => {
                logger.debug('[DAEMON RUN] Connected-service restart transcript event failed (non-fatal)', error);
              });
            }
            if (!completionWaiter) return restart;
            if (!restart.signaled) {
              throw Object.assign(
                new Error(`connected_service_restart_not_signaled:${restart.notSignaledReason ?? 'unknown'}`),
                { code: 'connected_service_restart_not_signaled', retryable: true },
              );
            }
            if (!input.tracked.childProcess && configuration.daemonSpawnExistingSessionWaitForExitMs > 0) {
              void waitForExistingSessionExitIfStopRequested({
                sessionId: input.sessionId,
                pidToTrackedSession,
                isSessionRunnerActive,
                timeoutMs: configuration.daemonSpawnExistingSessionWaitForExitMs,
                pollIntervalMs: configuration.daemonSpawnExistingSessionWaitForExitPollIntervalMs,
                trackedPids: [input.tracked.pid],
                onExitObserved: (pid, exit) => onChildExited(pid, exit),
              }).catch((error) => {
                logger.debug('[DAEMON RUN] Failed to observe connected-service runner retirement for a reattached session', error);
              });
            }
            const completion = await completionWaiter.promise;
            if (!doesRestartCompletionProvePreviousRunnerRetired(completion)) {
              const reason = completion.ok ? 'unknown' : completion.diagnostics?.respawnTerminalReason;
              throw Object.assign(
                new Error(`connected_service_previous_runner_retirement_unproven:${String(reason ?? 'unknown')}`),
                { code: 'connected_service_previous_runner_retirement_unproven', retryable: true },
              );
            }
            return restart;
          } catch (error) {
            completionWaiter?.cancel();
            throw error;
          }
        };

        const requestVersionRuntimeRefreshWithDeferral = async (input: Readonly<{
          sessionId: string;
          tracked: TrackedSession;
        }>): Promise<Readonly<{
          signaled: boolean;
          notSignaledReason?: PlannedRunnerRestartNotSignaledReason;
          completion?: RestartSessionRunnerCompletion;
        }>> => {
          const completionWaiter = createSessionRunnerRestartCompletionWaiter(input.sessionId, input.tracked.pid);
          try {
            const restart = await requestPlannedRunnerRestart({
              sessionId: input.sessionId,
              tracked: input.tracked,
              reason: 'version_runtime_refresh',
              deferral: { kind: 'none' },
              restartRequestedPids: connectedServicesRestartRequestedPids,
              pidToTrackedSession,
              canSignal: () => resolveSessionRunnerActivityDisabledReason(input.sessionId) ?? true,
              requestSignal: async ({ shouldSignal, onSignalFailure, onProcessAlreadyMissing }) =>
                // K5:gated_restart version refresh uses the planned restart primitive without
                // connected-service deferral/target metadata; this call is only the signal adapter.
                await requestConnectedServiceSessionRestartSignal({
                  pid: input.tracked.pid,
                  processGroupPid: resolveConnectedServiceRestartProcessGroupPid(input.tracked),
                  delayMs: 0,
                  shouldSignal,
                  onSignalFailure,
                  onProcessAlreadyMissing,
                }),
              observeProcessMissing: (tracked) => {
                if (observeConnectedServiceRestartProcessMissing) {
                  void observeConnectedServiceRestartProcessMissing(tracked).catch((error) => {
                    logger.warn('[DAEMON RUN] Failed to stage planned runner restart process exit', { pid: tracked.pid, error });
                  });
                } else {
                  logger.warn('[DAEMON RUN] Planned session runner restart process was already missing before exit observer was ready');
                }
              },
              onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart session runner for version refresh',
              logDebug: (message, payload) => logger.debug(message, payload),
              logWarn: (message, payload) => logger.warn(message, payload),
            });
            if (!restart.signaled) {
              completionWaiter.cancel();
              return restart;
            }
            if (!input.tracked.childProcess && configuration.daemonSpawnExistingSessionWaitForExitMs > 0) {
              void waitForExistingSessionExitIfStopRequested({
                sessionId: input.sessionId,
                pidToTrackedSession,
                isSessionRunnerActive,
                timeoutMs: configuration.daemonSpawnExistingSessionWaitForExitMs,
                pollIntervalMs: configuration.daemonSpawnExistingSessionWaitForExitPollIntervalMs,
                trackedPids: [input.tracked.pid],
                onExitObserved: (pid, exit) => onChildExited(pid, exit),
              }).catch((error) => {
                logger.debug('[DAEMON RUN] Failed to observe planned runner restart exit for reattached session', error);
              });
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
        const verifyConnectedServiceAccountAdoption = createSessionConnectedServiceAccountAdoptionVerifier();

        /**
         * K2: build the FSM hot-apply/gated apply callback used by BOTH the reactive
         * runtime-auth failure coordinator AND the proactive quota coordinator. Routing
         * the proactive quota switch through this (instead of a bare respawn) gives it:
         *  - the same fail-closed reachability gate at respawn (K1) via the FSM's restart path,
         *  - Codex appServer hot-apply IN PLACE when eligible (no respawn, no
         *    ConnectedServiceRestartRequested) + X4 transport invalidation (carried by the
         *    materializer into the hot-apply selection),
         *  - the configured post-replacement continuation policy, which may enqueue one ordinary
         *    Pending row only for an interrupted origin. Pending owns all later delivery behavior.
         * The exact tracked active-turn identity is frozen by the failure owner. Pending performs
         * the atomic explicit-user-input suppression at enqueue time.
         */
        const buildConnectedServiceApplyAuthGeneration = (applyParams: Readonly<{
          interruptedSessionId?: string | null;
          interruptedOriginId?: string | null;
          commitAccountSwitchEvents: boolean;
          dryRun?: boolean;
          deferCorrelatedContinuationSettlement?: boolean;
          executionAuthority: ConnectedServiceExecutionAuthorityV1;
        }>) => async (generationInput: Readonly<{
          sessionId: string;
          serviceId: ConnectedServiceId;
          groupId: string | null;
          activeProfileId: string | null;
          generation: number | null;
          credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
          reason: string;
          switchReason: ConnectedServiceSessionAuthSwitchReason;
          fromProfileId?: string | null;
        }>): Promise<Readonly<{
          ok: boolean;
          action?: string;
          errorCode?: string;
          // Failure diagnostics OR the INC-6 success continuity proof for switch telemetry.
          diagnostics?: SessionConnectedServiceAuthSwitchDiagnostics | Readonly<{ continuity: ConnectedServiceResumeContinuityProofDiagnostics }>;
        }>> => {
          const activeProfileId = typeof generationInput.activeProfileId === 'string'
            ? generationInput.activeProfileId.trim()
            : '';
          if (!activeProfileId) {
            return { ok: false, errorCode: 'profile_missing' };
          }
          const liveTracked = getCurrentChildren().find((child) => child.happySessionId === generationInput.sessionId) ?? null;
          const tracked = liveTracked ?? await resolveDurableConnectedServiceRuntimeAuthRecoverySession({
            credentials,
            sessionId: generationInput.sessionId,
            serviceId: generationInput.serviceId,
          });
          if (!tracked) {
            return { ok: false, errorCode: 'session_not_found' };
          }
          const getSwitchChildren = liveTracked
            ? getCurrentChildren
            : () => [...getCurrentChildren(), tracked];
          const agentId = resolveTrackedSessionCatalogAgentId(tracked);
          const serviceId = ConnectedServiceIdSchema.parse(generationInput.serviceId);
          // K5:fsm_switch reactive + proactive-quota auth-generation apply routes through the FSM
          // (hot-apply-in-place when eligible, else gated restart-resume with reachability + deferral).
		          const result = await switchSessionConnectedServiceAuth({
		            core: connectedServiceSessionAuthSwitchCore,
	            executionPolicy: {
	              allowRestartResume: applyParams.executionAuthority !== 'passive_projection',
	              allowContinuation: applyParams.executionAuthority !== 'passive_projection',
	              source: applyParams.executionAuthority === 'passive_projection' ? 'startup_reconciliation' : 'runtime',
	            },
	            switchReason: generationInput.switchReason,
            ...(
              applyParams.dryRun === true || generationInput.credentialRevision == null
                ? {}
                : {
                    expectedCredentialRevisionByServiceId: {
                      [serviceId]: generationInput.credentialRevision,
                    },
                  }
            ),
            // RD-SW-9: thread the group-switch trigger reason so a predictive soft-threshold
            // switch that cannot hot-apply fails inside the FSM BEFORE side effects, instead of
            // being classified by the post-apply backstop.
            groupSwitchTriggerReason: generationInput.reason,
            sessionEventReason: generationInput.reason,
            getChildren: getSwitchChildren,
            api,
            resolveContinuity: async ({
              tracked: switchTracked,
              sessionId,
              agentId: switchAgentId,
              serviceId: switchServiceId,
              previous,
              next,
              previousBindings,
              normalizedBindings,
              runtimeAuthSelection,
              connectedServiceMaterializationIdentityV1,
              vendorResumeId,
            }) => {
              const persistedSessionMetadata = await resolvePersistedConnectedServiceSwitchSessionMetadata({
                credentials,
                sessionId,
                agentId: switchAgentId,
              });
              const continuityContext = resolveTrackedConnectedServiceSwitchContinuityContext({
                agentId: switchAgentId,
                baseDir: connectedServicesMaterializationBaseDir,
                tracked: switchTracked,
                persistedSessionMetadata,
                connectedServiceMaterializationIdentityV1,
                vendorResumeId,
                resolveCandidatePersistedSessionFile: resolveConnectedServiceCandidatePersistedSessionFile,
                // RD-SW-2 (Rule A): the proof context must target the POST-switch materialized
                // home, not the tracked session's pre-switch env.
                runtimeAuthSelection,
              });
              return await resolveSessionConnectedServiceSwitchContinuity({
                sessionId,
                agentId: switchAgentId,
                serviceId: switchServiceId,
                previousBinding: previous,
                nextBinding: next,
                fromBindingsRaw: switchTracked
                  ? resolveTrackedConnectedServiceBindingsRaw(switchTracked) ?? previousBindings
                  : previousBindings,
                toBindings: normalizedBindings,
                accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
                connectedServiceMaterializationIdentityV1: continuityContext.connectedServiceMaterializationIdentityV1,
                vendorResumeId: continuityContext.vendorResumeId,
                targetMaterializedRoot: continuityContext.targetMaterializedRoot,
                targetMaterializedEnv: continuityContext.targetMaterializedEnv,
                cwd: continuityContext.cwd,
                candidatePersistedSessionFile: continuityContext.candidatePersistedSessionFile,
                ...(runtimeAuthSelection === undefined ? {} : { runtimeAuthSelection }),
              });
            },
            materializeRuntimeAuthSelection: async (materializerInput) => {
              return await materializeSessionConnectedServiceRuntimeAuthSelection({
                credentials,
                api,
                activeServerDir: configuration.activeServerDir,
                input: materializerInput,
                accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
                processEnv: process.env,
              });
            },
            runtimeAuthApplyCapabilityResolver: async ({ agentId }) => {
              const lifecycleDescriptor = await resolveConnectedServiceCredentialLifecycleDescriptor(agentId);
              return lifecycleDescriptor.runtimeAuthApply;
            },
            restartSession: async (restartTracked) => {
              if (generationInput.groupId === null || generationInput.generation === null) {
                throw new Error('connected_service_direct_profile_restart_requires_lifecycle_owner');
              }
              if (pidToTrackedSession.get(restartTracked.pid) !== restartTracked) {
                const spawnOptions = restartTracked.spawnOptions;
                if (!spawnOptions?.existingSessionId) {
                  throw new Error('connected_service_runtime_auth_durable_recovery_missing_resume_spawn_options');
                }
                const result = await spawnSession(spawnOptions);
                if (result.type !== 'success') {
                  if (result.type === 'error') {
                    throw new Error(result.errorMessage);
                  }
                  throw new Error('connected_service_runtime_auth_durable_recovery_spawn_requires_directory_approval');
                }
                return;
              }
              const restartSignalDelayMs = resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_RESTART_SIGNAL_DELAY_MS,
                250,
                { min: 0, max: 5_000 },
              );
              // K5:fsm_switch the FSM's restart-resume fallback when hot-apply is ineligible;
              // gated through deferral + spawn-time reachability (K1).
              await requestConnectedServiceRestartWithDeferral({
                sessionId: generationInput.sessionId,
                tracked: restartTracked,
                source: 'automatic',
                policy: 'defer_until_turn_boundary',
                target: normalizeSwitchTarget({
                  serviceId,
                  profileId: activeProfileId,
                  groupId: generationInput.groupId,
                  generation: generationInput.generation,
                }),
                restartSignalDelayMs,
                awaitPreviousRunnerRetirement: true,
                restartDiagnostic: {
                  trigger: 'automatic_group_switch',
                  sessionId: generationInput.sessionId,
                  agentId,
                  serviceId,
                  profileId: activeProfileId,
                  groupId: generationInput.groupId,
                  generation: generationInput.generation,
                  reason: generationInput.reason,
                },
                transcriptEventOwner: 'switch_fsm',
                onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart connected-service auth group session through shared switch primitive',
              });
            },
            hotApply: createSessionConnectedServiceAuthHotApply({
              validateGroupMutationCurrentness: validateConnectedServiceGroupMutationCurrentness,
            }),
            recoverAfterRuntimeAuthSwitch: recoverTrackedSessionConnectedServiceRuntimeAuthSwitch,
            continueAfterRuntimeAuthSwitch: async (continuationInput) => {
              if (generationInput.groupId === null || generationInput.generation === null) return;
              const correlationKey = {
                sessionId: generationInput.sessionId,
                serviceId,
                groupId: generationInput.groupId,
                profileId: activeProfileId,
                generation: generationInput.generation,
              };
              const settledCorrelation = applyParams.deferCorrelatedContinuationSettlement === true
                ? false
                : await connectedServiceContinuationApplicationCorrelation.settle(
                  correlationKey,
                  async (correlatedContinuation) => {
                    await createConnectedServiceContinuationHandler({
                      credentials,
                      ...correlatedContinuation,
                      resolveInterruption: () => 'provider_failed_turn',
                    })(continuationInput);
                  },
                );
              if (settledCorrelation || applyParams.deferCorrelatedContinuationSettlement === true) {
                return;
              }
              await createConnectedServiceContinuationHandler({
                credentials,
                interruptedOriginId: applyParams.interruptedOriginId,
                resumePromptMode: await resolveContinuationResumePromptMode({
                  credentials,
                  serviceId,
                  groupId: generationInput.groupId,
                }),
                customResumePrompt: readContinuationCustomResumePrompt(getActiveAccountSettingsSnapshot()?.settings ?? null),
                resolveInterruption: ({ sessionId, action, switchReason }) =>
                  resolveConnectedServiceContinuationInterruptionForSwitch({
                    sessionId,
                    interruptedSessionId: applyParams.interruptedSessionId,
                    action,
                    switchReason,
                    groupSwitchTriggerReason: generationInput.reason,
                    turnDeferralQueue: connectedServiceTurnDeferralQueue,
                  }),
              })(continuationInput);
            },
            verifyProviderAccountAdoption: verifyConnectedServiceAccountAdoption,
            persistSessionBindings: async ({
              sessionId,
              normalizedBindings,
              connectedServiceMaterializationIdentityV1,
            }) => {
              await persistSessionConnectedServiceBindings({
                credentials,
                sessionId,
                normalizedBindings,
                connectedServiceMaterializationIdentityV1,
              });
            },
            registerHotApplyTargets: (switchTracked, context) => {
              // Hot-apply keeps the runner alive, so no webhook will rewrite the durable
              // session marker — refresh it here or a daemon restart restores the
              // pre-switch bindings and treats real switch requests as 'unchanged'.
              if (switchTracked.spawnOptions) {
                void refreshSessionMarkerRespawn({
                  pid: switchTracked.pid,
                  spawnOptions: switchTracked.spawnOptions,
                  encryptionMaterial: credentials.encryption,
                }).catch((error) => {
                  logger.debug('[DAEMON RUN] Failed to refresh session marker after hot-applied auth switch', error);
                });
              }
              const materializationIdentity = readConnectedServiceMaterializationIdentityV1(
                switchTracked.spawnOptions?.connectedServiceMaterializationIdentityV1,
              );
              if (!materializationIdentity) return;
              registerConnectedServiceRuntimeTargetForDaemon({
                runtimeRegistry: connectedServiceRuntimeRegistry,
                pid: switchTracked.pid,
                agentId,
                sessionId: switchTracked.happySessionId,
                connectedServicesBindingsRaw: switchTracked.spawnOptions?.connectedServices,
                materializationKey: materializationIdentity.id,
                // RD-MAT-6: keep refresh-driven rematerialization on the live identity root and
                // the session's working directory (workspace-trust projection target).
                connectedServiceMaterializationIdentityV1: materializationIdentity,
                sessionDirectory: switchTracked.spawnOptions?.directory ?? null,
                ...(switchTracked.spawnOptions?.environmentVariables
                  ? { connectedServiceSelectionsEnv: switchTracked.spawnOptions.environmentVariables }
                  : {}),
                runtimeAccountIdentitySelections: buildRuntimeAccountIdentitySelectionsFromHotApply(
                  context?.runtimeAuthSelectionsByServiceId,
                ),
              });
            },
            emitSessionEvent: (sessionId, event) => {
              if (!shouldCommitAutomaticGroupApplySessionEvent(event, {
                commitAccountSwitchEvents: applyParams.commitAccountSwitchEvents,
                executionAuthority: applyParams.executionAuthority,
              })) return;
              // Automatic group-apply (now-live recovery/preemptive path): surface transcript event
              // AND user notification through the single choke point. Previously this path committed
              // the transcript event but never dispatched the notification — the silent-swap regression.
              surfaceConnectedServiceAccountSwitchOutcomeForSession({ sessionId, event });
            },
            // The persisted group binding does not track the live active member, so thread the
            // pre-switch member through to the transcript "from" (otherwise it renders as the
            // native / "CLI Auth" label even though the session was on a real group member).
	            emitFromProfileIdByServiceId: new Map([[serviceId, generationInput.fromProfileId ?? null]]),
	            dryRun: applyParams.dryRun === true,
	            request: {
              sessionId: generationInput.sessionId,
              agentId,
              bindings: {
                v: 1,
                bindingsByServiceId: {
                  [serviceId]: generationInput.groupId === null
                    ? {
                        source: 'connected',
                        selection: 'profile',
                        profileId: activeProfileId,
                      }
                    : {
                        source: 'connected',
                        selection: 'group',
                        groupId: generationInput.groupId,
                        profileId: activeProfileId,
                      },
                },
              },
              ...(generationInput.groupId === null || generationInput.generation === null
                ? { rematerializeServiceId: serviceId }
                : {
                    expectedGroupGenerationByServiceId: {
                      [serviceId]: generationInput.generation,
                    },
                  }),
            },
          });
          return result.ok
            ? {
                ok: true,
                action: result.action,
                ...(result.verificationByServiceId
                  ? { verificationByServiceId: result.verificationByServiceId }
                  : {}),
                // INC-6: thread the proven continuity context into switch telemetry.
                ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
              }
            : {
                ok: false,
                errorCode: result.errorCode,
                ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
              };
        };

        void hydrateInactiveUsageLimitRecoveryFromSessionMetadata({
          credentials,
          currentMachineId: machineId,
          currentMachineHost: preferredHost,
          currentMachineHomeDir: os.homedir(),
          observe: ({ sessionId, recovery, runCheckNow }) => {
            inactiveUsageLimitRecoveryCheckOwner.observe({ sessionId, recovery, runCheckNow });
          },
        }).then((result) => {
          if (result.observed === 0) return;
          logger.debug('[DAEMON RUN] Reconstructed inactive usage-limit recovery checks passively from session metadata', result);
        }).catch((error) => {
          logger.warn('[DAEMON RUN] Failed to rehydrate inactive usage-limit recovery checks from session metadata', {
            error: serializeAxiosErrorForLog(error),
          });
        });

            // Handle child process exit
            const onChildExitedBase = createOnChildExited({
              pidToTrackedSession,
              spawnResourceCleanupByPid,
              sessionAttachCleanupByPid,
              getApiMachineForSessions: () => apiMachineForSessions,
          onUnexpectedExit: (tracked, exit) => {
            sessionRunnerRespawnManager.handleUnexpectedExit(tracked, exit, {
              forceRestart: connectedServicesRestartRequestedPids.has(tracked.pid),
            });
          },
          isExitUnexpectedOverride: (tracked, _exit) => {
            if (!connectedServicesRestartRequestedPids.has(tracked.pid)) return null;
            return true;
          },
          onPidPromoted: ({ fromPid, toPid }) => {
            connectedServiceRuntimeRegistry.transferPid(fromPid, toPid);
            if (connectedServicesRestartRequestedPids.delete(fromPid)) {
              connectedServicesRestartRequestedPids.add(toPid);
            }
            connectedServiceRestartAmplificationGuard.transferPid(fromPid, toPid);
          },
          shouldPreserveSessionMarkerOnExit: ({ pid, trackedSession }) => {
            if (connectedServicesRestartRequestedPids.has(pid)) return true;
            const terminal = trackedSession.happySessionMetadataFromLocalWebhook?.terminal
              ?? trackedSession.hostedTerminal;
            return Boolean(trackedSession.publishedTerminalControlServiceabilityAttachmentId)
              || Boolean(terminal?.mode && terminal.mode !== 'plain');
          },
          onFinalTrackedSessionExitStaged: async ({ pid, trackedSession }) => {
            if (connectedServicesRestartRequestedPids.has(pid)) return;
            const sessionId = typeof trackedSession.happySessionId === 'string'
              ? trackedSession.happySessionId.trim()
              : '';
            if (!sessionId) return;
            const terminal = trackedSession.happySessionMetadataFromLocalWebhook?.terminal
              ?? trackedSession.hostedTerminal;

            const attachmentInfo = await readTerminalAttachmentInfo({
              happyHomeDir: configuration.happyHomeDir,
              sessionId,
            }).catch((error) => {
              logger.debug('[DAEMON RUN] Preserved runner-exit marker but could not read its terminal attachment', {
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
                throw new Error('terminal_attachment_unavailable_after_runner_exit');
              }
              return;
            }

            const agentId = resolveTrackedSessionCatalogAgentId(trackedSession);
            const controlDescriptorAvailable = await hasTerminalAttachmentControlDescriptorThroughCatalog(agentId, {
              happyHomeDir: configuration.happyHomeDir,
              sessionId,
              attachmentId: attachmentInfo.attachmentId,
            }).catch(() => false);
            registerDisconnectedTerminalHostCandidate({
              sessionId,
              pid,
              ...(trackedSession.activeTurnId ? { activeTurnId: trackedSession.activeTurnId } : {}),
              happyHomeDir: configuration.happyHomeDir,
              attachmentId: attachmentInfo.attachmentId,
              handle: attachmentInfo.handle,
              controlDescriptorAvailable,
            });
          },
            });
        const onChildExited = async (pid: number, exit: { reason: string; code: number | null; signal: string | null }) => {
          const trackedBeforeExit = pidToTrackedSession.get(pid) ?? null;
          const wasConnectedServicesRestartRequested = connectedServicesRestartRequestedPids.has(pid);
          await onChildExitedBase(pid, exit);
          if (!pidToTrackedSession.has(pid)) {
            connectedServiceRuntimeRegistry.unregisterPid(pid);
          }
          if (trackedBeforeExit?.happySessionId) {
            const stillLive = getCurrentChildren().some((child) => child.happySessionId === trackedBeforeExit.happySessionId);
            if (!stillLive) {
              // A connected-service forced restart respawns the session — treat the deferred switch as
              // applied-via-restart (settle, no misleading "Account switch cancelled"), not terminated.
              connectedServiceTurnDeferralQueue.cancelSession(
                trackedBeforeExit.happySessionId,
                wasConnectedServicesRestartRequested ? 'session_restarting' : 'session_terminated',
              );
            }
            if (!stillLive && !wasConnectedServicesRestartRequested) {
              connectedServiceRuntimeAuthSwitchAttempts.clearSession(trackedBeforeExit.happySessionId);
              connectedServiceSessionAuthSwitchCore.clearSession(trackedBeforeExit.happySessionId);
            }
          }
          void connectedServiceGroupHomeCleanupScheduler.cleanupPendingDeletedGroupHomes().catch((error) => {
            logger.debug('[DAEMON RUN] Connected-service group home cleanup tick failed (non-fatal)', error);
          });
          void connectedServiceMaterializedHomeCleanupScheduler.cleanupPendingMaterializedHomes().catch((error) => {
            logger.debug('[DAEMON RUN] Connected-service materialized home cleanup tick failed (non-fatal)', error);
          });
        };

        observeConnectedServiceRestartProcessMissing = async (tracked) => {
          const exit = { reason: 'process-missing', code: null, signal: null };
          try {
            await onChildExited(tracked.pid, exit);
          } catch (error) {
            logger.warn('[DAEMON RUN] Failed to observe connected-service restart process exit through child-exit path', error);
          }
        };

        const stopSession = async (sessionId: string): Promise<StopSessionResult> => {
          const normalizedSessionId = String(sessionId ?? '').trim();
          const existingStop = stopSessionInFlightBySessionId.get(normalizedSessionId);
          if (existingStop) return await existingStop;

          const operation = Promise.resolve().then(async (): Promise<StopSessionResult> => {
            sessionRunnerRespawnManager.markStopRequested(normalizedSessionId, { reason: 'daemon_stop_session', requestedAtMs: Date.now() });
            const automaticRecoveryCancellations = await Promise.allSettled([
              inactiveUsageLimitRecoveryCheckOwner.cancelSession({
                sessionId: normalizedSessionId,
                scheduler: inactiveUsageLimitRecoveryScheduler,
              }),
              runtimeAuthRecoveryScheduler?.cancel({ sessionId: normalizedSessionId }) ?? Promise.resolve(null),
              temporaryThrottleRecoveryScheduler.stopRetrying({ sessionId: normalizedSessionId }),
            ]);
            const automaticRecoveryOwners = ['inactive_usage_limit', 'runtime_auth', 'temporary_throttle'] as const;
            automaticRecoveryCancellations.forEach((result, index) => {
              if (result.status !== 'rejected') return;
              logger.warn('[DAEMON RUN] Automatic recovery cancellation failed after explicit Stop', {
                sessionId: normalizedSessionId,
                owner: automaticRecoveryOwners[index],
                error: serializeAxiosErrorForLog(result.reason),
              });
            });
            temporaryThrottleResumeSnapshotsBySessionId.delete(normalizedSessionId);
            await clearConnectedServiceRecoveryAfterSupersession({
              sessionId: normalizedSessionId,
              event: {
                kind: 'manual_session_supersession',
                reason: 'stop',
              },
            });
            await persistExplicitSessionStopRecoveryCancellation({
              credentials,
              sessionId: normalizedSessionId,
            }).catch((error) => {
              logger.warn('[DAEMON RUN] Failed to publish usage-limit recovery cancellation after explicit Stop', {
                sessionId: normalizedSessionId,
                error: serializeAxiosErrorForLog(error),
              });
            });
            physicallyRetiredTerminalAttachmentIdBySessionId.delete(normalizedSessionId);
            const trackedStopResult = await stopSessionCore(normalizedSessionId);
            const physicallyRetiredAttachmentId = physicallyRetiredTerminalAttachmentIdBySessionId.get(normalizedSessionId);
            physicallyRetiredTerminalAttachmentIdBySessionId.delete(normalizedSessionId);
            if (isTerminalHostPhysicallyRetiredStopResult(trackedStopResult) && physicallyRetiredAttachmentId) {
              await retireDisconnectedTerminalHostCandidate({
                sessionId: normalizedSessionId,
                attachmentId: physicallyRetiredAttachmentId,
              });
            }
            if (
              trackedStopResult.status !== 'incomplete'
              || trackedStopResult.reason !== 'tracked_runner_absent'
            ) {
              return trackedStopResult;
            }

            const disconnectedHostCandidate = disconnectedTerminalHostCandidates.find(
              (candidate) => candidate.sessionId === normalizedSessionId
                && !terminalizedDisconnectedTerminalHostIds.has(candidate.attachmentId),
            );
            if (!disconnectedHostCandidate) return trackedStopResult;

            const currentRunner = await probeSessionRunnerServiceability(normalizedSessionId);
            if (currentRunner.state !== 'runner_absent') return trackedStopResult;

            const terminalHostAdapters = await loadTerminalHostAdapters();
            const candidatePidToTrackedSession = new Map<number, TrackedSession>([[
              disconnectedHostCandidate.pid,
              {
                startedBy: 'daemon',
                happySessionId: normalizedSessionId,
                pid: disconnectedHostCandidate.pid,
              },
            ]]);
            const stopDisconnectedHost = createStopSession({
              pidToTrackedSession: candidatePidToTrackedSession,
              expectedTerminalAttachmentId: disconnectedHostCandidate.attachmentId,
              terminalHostAdapters,
              provenTerminalHostKindsByPid: new Map([[
                disconnectedHostCandidate.pid,
                disconnectedHostCandidate.handle.kind,
              ]]),
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
              retireExactTerminalControlServiceability: async ({ sessionId, attachmentInfo }) => {
                return await retireTerminalControlServiceabilityForCurrentAccount({
                  sessionId,
                  attachmentId: attachmentInfo.attachmentId,
                  terminalMode: attachmentInfo.terminal.mode ?? attachmentInfo.handle.kind,
                });
              },
            });
            const disconnectedStopResult = await stopDisconnectedHost(normalizedSessionId);
            if (isTerminalHostPhysicallyRetiredStopResult(disconnectedStopResult)) {
              await retireDisconnectedTerminalHostCandidate({
                sessionId: normalizedSessionId,
                attachmentId: disconnectedHostCandidate.attachmentId,
              });
            }
            return disconnectedStopResult;
          }).then((result): StopSessionResult => {
            if (result.status === 'stopped') {
              completedStopSessionIds.add(normalizedSessionId);
              return result;
            }
            if (result.status === 'not_found' && completedStopSessionIds.has(normalizedSessionId)) {
              return { status: 'stopped' };
            }
            return result;
          });
          stopSessionInFlightBySessionId.set(normalizedSessionId, operation);
          try {
            return await operation;
          } finally {
            if (stopSessionInFlightBySessionId.get(normalizedSessionId) === operation) {
              stopSessionInFlightBySessionId.delete(normalizedSessionId);
            }
          }
        };

        let runtimeAuthRecoveryScheduler: RuntimeAuthRecoveryScheduler | null = null;
        const resolveRegisteredRuntimeAuthFailureSourceForSession: NonNullable<
          Parameters<typeof authorizeConnectedServiceRuntimeAuthFailureSource>[0]['resolveRegisteredRuntimeAuthFailureSource']
        > = ({ sessionId: liveSessionId, classification: liveClassification }) => {
          const serviceId = ConnectedServiceIdSchema.safeParse(liveClassification.serviceId);
          if (!serviceId.success) return null;
          const binding = connectedServiceRuntimeRegistry
            .getBySessionId(liveSessionId)
            ?.activeBindings.find((candidate) => candidate.serviceId === serviceId.data) ?? null;
          return binding
            ? {
                serviceId: binding.serviceId,
                groupId: binding.groupId,
                profileId: binding.profileId,
                generation: binding.generation,
                credentialRevision: binding.credentialRevision,
              }
            : null;
        };
        const resolveRuntimeAuthApplyForFailureSource = async (input: Readonly<{
          sessionId: string;
          serviceId: ConnectedServiceId;
        }>) => {
          const tracked = getCurrentChildren().find(
            (candidate) => candidate.happySessionId === input.sessionId,
          ) ?? null;
          let ownerId: CatalogAgentId;
          if (tracked) {
            ownerId = resolveTrackedSessionCatalogAgentId(tracked);
          } else {
            const scope = await resolveConnectedServiceGenerationApplicationScope(input.serviceId);
            if (scope.status !== 'supported') return null;
            ownerId = scope.ownerId as CatalogAgentId;
          }
          const descriptor = await resolveConnectedServiceCredentialLifecycleDescriptor(ownerId);
          return descriptor.serviceIds.includes(input.serviceId)
            ? descriptor.runtimeAuthApply
            : null;
        };
        const resolveCurrentRuntimeAuthFailureSourceForSession: NonNullable<
          Parameters<typeof authorizeConnectedServiceRuntimeAuthFailureSource>[0]['resolveCurrentRuntimeAuthFailureSource']
        > = async ({ sessionId: liveSessionId, classification: liveClassification }) => {
          const runtimeTarget = connectedServiceRuntimeRegistry.getBySessionId(liveSessionId);
          const brokerSelectionIdentity = runtimeTarget?.brokerSelectionIdentity ?? null;
          if (brokerSelectionIdentity) {
            const serviceId = ConnectedServiceIdSchema.safeParse(liveClassification.serviceId);
            if (!serviceId.success) return null;
            const brokerSelection = getBrokerBridgeEffectiveSelection({
              selectionIdentity: brokerSelectionIdentity,
              serviceId: serviceId.data,
            });
            if (brokerSelection?.availability !== 'available') return null;
            const selection = brokerSelection.selection;
            return selection.kind === 'group'
              ? {
                  serviceId: selection.serviceId,
                  groupId: selection.groupId,
                  profileId: selection.activeProfileId,
                  generation: selection.generation,
                  credentialRevision: selection.credentialRevision ?? null,
                }
              : {
                  serviceId: selection.serviceId,
                  groupId: null,
                  profileId: selection.profileId,
                  generation: null,
                  credentialRevision: null,
                };
          }
          return await resolveCurrentCodexRuntimeAuthFailureSource({
            classification: liveClassification,
            readRuntimeIdentity: async (request) => await readConnectedServiceRuntimeIdentityForQuotaFanout({
              credentials,
              sessionId: liveSessionId,
              serviceId: request.serviceId,
              groupId: request.groupId,
              profileId: request.profileId,
              expectedGroupGeneration: request.generation,
              credentialRevision: request.credentialRevision,
            }),
            resolveCurrentCredential: async (serviceId, profileId) =>
              await resolveConnectedServiceCredentialsWithRevisions({
                credentials,
                api,
                bindings: [{ serviceId, profileId }],
              }).then((byServiceId) => {
                const resolved = byServiceId.get(serviceId);
                return resolved?.revisionSemantics === 'revisioned'
                  ? {
                      record: resolved.record,
                      credentialRevision: resolved.credentialRevision,
                    }
                  : null;
              }),
          });
        };

        const handleConnectedServiceRuntimeAuthRecovery = async (input: Readonly<{
          sessionId: string;
          switchesThisTurn: number;
          classification: ConnectedServiceRuntimeFailureClassification;
          interruptedOriginId?: string;
          resumePromptMode?: SessionContinuationResumePromptModeV1;
          source?: 'scheduler_retry';
        }>): Promise<unknown> => {
          // Daemon-lifecycle guard: never run switch/restart/continuation while the daemon is
          // shutting down. Post-shutdown recovery work can never reach provider-outcome proof and
          // races a dying control endpoint. Return a degraded, non-success, non-terminal result; the
          // recovery intent is left untouched so a healthy future daemon re-hydrates and re-drives it.
          // This deferral must NOT be counted as a recovery attempt.
          if (shutdownInitiated) {
            return {
              status: 'daemon_lifecycle_unavailable' as const,
              reason: 'recovery_deferred_shutdown' as const,
            };
          }
          const runtimeFailureAtMs = Date.now();
          const interruptedOriginId = resolveConnectedServiceContinuationOriginId({
            source: input.source === 'scheduler_retry' ? 'scheduler_retry' : 'daemon_report',
            activeTurnId: getCurrentChildren()
              .find((child) => child.happySessionId === input.sessionId)
              ?.activeTurnId,
            reportId: input.interruptedOriginId,
          });
          const interruptedContinuation = interruptedOriginId
            ? {
                interruptedOriginId,
                resumePromptMode: await resolveContinuationResumePromptMode({
                  credentials,
                  serviceId: ConnectedServiceIdSchema.safeParse(input.classification.serviceId).data,
                  groupId: input.classification.groupId,
                  explicit: input.resumePromptMode,
                }),
                customResumePrompt: readContinuationCustomResumePrompt(
                  getActiveAccountSettingsSnapshot()?.settings ?? null,
                ),
                recoveryKind: input.classification.kind,
              }
            : null;
          const markRuntimeAuthRecoverySucceeded = async (
            source: ReactiveRuntimeAuthRecoverySource,
            signal: ReactiveRuntimeAuthRecoverySignal,
          ): Promise<void> => {
            // B1 PROOF GATE: a reactive recovery source (committed CAS switch, switch
            // event, group-switch observer) is a LOCAL substep, not provider-outcome
            // proof. Clear the recovery intent ONLY when the signal carries accepted
            // proof (account-adoption verified, or a genuinely fresh candidate).
            // Otherwise the recovery stays provider-outcome-waiting under the scheduler
            // backoff/exhaustion lifecycle. Routing every entrypoint through this one
            // shared gate prevents the metadata-only "switched/observed_generation =
            // recovered" loop that this plan exists to kill.
            const decision = resolveReactiveRuntimeAuthRecoveryClear(signal);
            if (!decision.clear) {
              logger.debug('[DAEMON RUN] Connected-service runtime-auth reactive recovery without provider-outcome proof; staying provider-outcome-waiting', {
                source,
                sessionId: input.sessionId,
                serviceId: input.classification.serviceId,
              });
              return;
            }
            const recoveryKey = buildRuntimeAuthRecoveryKey({
              sessionId: input.sessionId,
              serviceId: input.classification.serviceId,
              profileId: input.classification.profileId,
              groupId: input.classification.groupId,
            });
            const serviceId = ConnectedServiceIdSchema.parse(input.classification.serviceId);
            const intents = runtimeAuthRecoveryScheduler?.readForSession(input.sessionId) ?? [];
            const matches = listMatchingRuntimeAuthRecoveryIntents(intents, {
              serviceId,
              groupId: input.classification.groupId,
              profileId: signal.activeProfileId ?? input.classification.profileId,
            });
            const recoveryKeys = matches.length > 0
              ? matches.map((intent) => buildRuntimeAuthRecoveryKey({
                sessionId: intent.sessionId,
                serviceId: intent.serviceId,
                profileId: intent.profileId,
                groupId: intent.groupId,
              }))
              : [recoveryKey];
            await Promise.all(recoveryKeys.map(async (key) => {
              await runtimeAuthRecoveryScheduler?.markProviderOutcomeProofByKey({
                recoveryKey: key,
                proofKind: decision.proof,
              }).catch((error) => {
                logger.debug('[DAEMON RUN] Connected-service runtime-auth recovery success cleanup failed (non-fatal)', {
                  source,
                  proof: decision.proof,
                  sessionId: input.sessionId,
                  recoveryKey: key,
                  serviceId,
                  error: serializeAxiosErrorForLog(error),
                });
              });
            }));
          };
          const applyConnectedServiceAuthGeneration = buildConnectedServiceApplyAuthGeneration({
            interruptedSessionId: input.sessionId,
            interruptedOriginId,
            commitAccountSwitchEvents: true,
            executionAuthority: 'runtime_recovery',
          });
          const continueAfterRuntimeAuthSwitch = createConnectedServiceContinuationHandler({
            credentials,
            interruptedOriginId,
            resumePromptMode: interruptedContinuation?.resumePromptMode ?? 'off',
            customResumePrompt: interruptedContinuation?.customResumePrompt ?? null,
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
          const switchCoordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
            api,
            prepareCandidateForSwitch: prepareAuthGroupCandidateForSwitch,
            resolveCredentialRevision: (serviceId, profileId) => profileId
              ? latestConnectedServiceProjectionSnapshot?.resolveCredentialRevision(serviceId, profileId) ?? null
              : null,
            resolveCurrentCredentialRevision: resolveCurrentConnectedServiceCredentialRevision,
            runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
            accountUsageStore: providerAccountUsageStore,
            leases: connectedServiceAuthGroupSwitchLeases,
            quotaFreshnessMs: resolvePositiveIntEnv(
              process.env.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_QUOTA_FRESHNESS_MS,
              5 * 60_000,
              { min: 1_000, max: 60 * 60_000 },
            ),
            nowMs: () => Date.now(),
            probeQuotaSnapshotsForGroup: async (groupInput) => {
              await connectedServiceQuotasCoordinator?.probeGroupQuotaSnapshots(groupInput);
            },
            onCommittedSwitch: async (committed) => {
              if (interruptedContinuation) {
                connectedServiceContinuationApplicationCorrelation.register({
                  sessionId: input.sessionId,
                  serviceId: committed.serviceId,
                  groupId: committed.groupId,
                  profileId: committed.activeProfileId,
                  generation: committed.generation,
                }, interruptedContinuation);
              }
              // The CAS commit carries only commit metadata (active profile +
              // generation) — no post-switch adoption verification and no proof the
              // adopted profile differs from the failed one. It maps to no proof, so
              // the gate keeps the recovery provider-outcome-waiting.
              await markRuntimeAuthRecoverySucceeded('committed_switch', {
                activeProfileId: committed.activeProfileId,
              });
            },
            restartSession: async (restartInput) => {
              const tracked = getCurrentChildren().find((child) => child.happySessionId === input.sessionId) ?? null;
              if (!tracked) return;
              const restartSignalDelayMs = resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_RESTART_SIGNAL_DELAY_MS,
                250,
                { min: 0, max: 5_000 },
              );
              // K5:fsm_switch reactive runtime-auth coordinator restartSession; the coordinator is
              // built WITH applyConnectedServiceAuthGeneration (the FSM), so this gated restart is
              // the coordinator's spawn_next_turn fallback inside the FSM-driven flow.
              await requestConnectedServiceRestartWithDeferral({
                sessionId: input.sessionId,
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
                awaitPreviousRunnerRetirement: true,
                restartDiagnostic: {
                  trigger: 'automatic_group_switch',
                  sessionId: input.sessionId,
                  agentId: resolveTrackedSessionCatalogAgentId(tracked),
                  serviceId: restartInput.serviceId,
                  profileId: restartInput.activeProfileId,
                  groupId: restartInput.groupId,
                  generation: restartInput.generation,
                  reason: restartInput.reason ?? input.classification?.kind ?? null,
                },
                transcriptEventOwner: 'switch_fsm',
                onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart connected-service auth group session',
              });
            },
            // K5:fsm_switch reactive runtime-auth failure routes through the shared FSM apply builder.
            // K2: reactive runtime-auth failure routes through the shared FSM apply builder
            // (hot-apply-in-place when eligible, else gated restart-resume + mid-turn re-continue).
            applyConnectedServiceAuthGeneration: async (generationInput) => {
              if (interruptedContinuation) {
                connectedServiceContinuationApplicationCorrelation.register({
                  sessionId: input.sessionId,
                  serviceId: generationInput.serviceId,
                  groupId: generationInput.groupId,
                  profileId: generationInput.activeProfileId ?? '',
                  generation: generationInput.generation,
                }, interruptedContinuation);
              }
              return await applyConnectedServiceAuthGeneration(generationInput);
            },
            preflightConnectedServiceAuthGeneration: buildConnectedServiceApplyAuthGeneration({
              interruptedSessionId: input.sessionId,
              interruptedOriginId,
              commitAccountSwitchEvents: false,
              dryRun: true,
              executionAuthority: 'runtime_recovery',
            }),
            emitEvent: (event) => {
              if (
                event.success
                && (event.resultStatus === 'switched' || event.resultStatus === 'observed_generation')
                && event.serviceId === input.classification.serviceId
              ) {
                // The switch event carries from/to profile but no adoption
                // verification. Only a genuinely fresh candidate (to !== from) is
                // proof here; an observed_generation / same-account event maps to no
                // proof and stays provider-outcome-waiting.
                void markRuntimeAuthRecoverySucceeded('event', {
                  fromProfileId: event.fromProfileId,
                  activeProfileId: event.toProfileId,
                });
              }
            },
          });
          const runtimeAuthApply = await resolveRuntimeAuthApplyForFailureSource({
            sessionId: input.sessionId,
            serviceId: ConnectedServiceIdSchema.parse(input.classification.serviceId),
          });
          let supersedingSourceConverged = false;
          const result = await handleConnectedServiceRuntimeAuthFailureForSession({
            getChildren: getCurrentChildren,
            switchCoordinator,
            switchAttemptTracker: connectedServiceRuntimeAuthSwitchAttempts,
            switchCore: connectedServiceSessionAuthSwitchCore,
            resolveDurableSessionForRuntimeAuthRecovery: async ({ sessionId, classification }) =>
              await resolveDurableConnectedServiceRuntimeAuthRecoverySession({
                credentials,
                sessionId,
                serviceId: classification.serviceId,
              }),
            resolveRegisteredRuntimeAuthFailureSource: resolveRegisteredRuntimeAuthFailureSourceForSession,
            resolveCurrentRuntimeAuthFailureSource: resolveCurrentRuntimeAuthFailureSourceForSession,
            resolveProviderQualifiedRuntimeAuthFailureSource,
            runtimeAuthApply,
            temporaryThrottleRecovery: {
              enable: async (temporaryThrottleInput) => await temporaryThrottleRecovery.enable({
                ...temporaryThrottleInput,
                continuation: interruptedContinuation,
              }),
            },
            credentialRefreshService: connectedServiceRefreshCoordinator,
            restartSession: async (tracked) => {
              if (pidToTrackedSession.get(tracked.pid) !== tracked) {
                const spawnOptions = tracked.spawnOptions;
                if (!spawnOptions?.existingSessionId) {
                  throw new Error('connected_service_runtime_auth_durable_recovery_missing_resume_spawn_options');
                }
                const result = await spawnSession(spawnOptions);
                if (result.type !== 'success') {
                  if (result.type === 'error') {
                    throw new Error(result.errorMessage);
                  }
                  throw new Error('connected_service_runtime_auth_durable_recovery_spawn_requires_directory_approval');
                }
                return;
              }
              const restartSignalDelayMs = resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_REFRESH_RESTART_SIGNAL_DELAY_MS,
                250,
                { min: 0, max: 5_000 },
              );
              // K5:gated_restart D7 pure credential-refresh / reconnect recovery restart (no target
              // generation rebind) — gated through deferral + spawn-time reachability.
              await requestConnectedServiceRestartWithDeferral({
                sessionId: input.sessionId,
                tracked,
                source: 'automatic',
                policy: 'defer_until_turn_boundary',
                target: normalizeSwitchTarget({
                  serviceId: input.classification?.serviceId ?? '',
                  profileId: input.classification?.profileId ?? '',
                  groupId: input.classification?.groupId ?? '',
                  generation: null,
                }),
                restartSignalDelayMs,
                awaitPreviousRunnerRetirement: true,
                restartDiagnostic: {
                  trigger: 'runtime_auth_recovery_restart',
                  sessionId: input.sessionId,
                  agentId: resolveTrackedSessionCatalogAgentId(tracked),
                  serviceId: input.classification?.serviceId ?? null,
                  profileId: input.classification?.profileId ?? null,
                  groupId: input.classification?.groupId ?? null,
                  reason: input.classification?.kind ?? null,
                },
                transcriptEventOwner: 'restart_signal',
                onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart connected-service runtime-auth-refreshed session',
              });
            },
            continueAfterRuntimeAuthSwitch: async (continuationInput) => {
              if (interruptedContinuation && continuationInput.target) {
                const correlationKey = {
                  sessionId: continuationInput.sessionId,
                  ...continuationInput.target,
                };
                connectedServiceContinuationApplicationCorrelation.register(correlationKey, interruptedContinuation);
                await connectedServiceContinuationApplicationCorrelation.settle(
                  correlationKey,
                  async (correlatedContinuation) => {
                    await createConnectedServiceContinuationHandler({
                      credentials,
                      ...correlatedContinuation,
                      resolveInterruption: () => 'provider_failed_turn',
                    })(continuationInput);
                  },
                );
                return;
              }
              await continueAfterRuntimeAuthSwitch(continuationInput);
            },
            settleSupersedingRuntimeGroupGeneration: async (settlementInput) => {
              const consumer = connectedServiceAuthGroupGenerationConsumer;
              if (!consumer) {
                throw Object.assign(
                  new Error('connected_service_generation_consumer_unavailable'),
                  { code: 'connected_service_generation_consumer_unavailable', retryable: true },
                );
              }
              await settleSupersedingRuntimeAuthGenerationForSource({
                recovery: { status: 'switch_attempted', result: settlementInput.result },
                serviceId: settlementInput.serviceId,
                groupId: settlementInput.groupId,
                sessionId: settlementInput.sessionId,
                fromProfileId: settlementInput.fromProfileId,
                consumeCommittedAuthGroupGeneration: async (consumeInput) => await consumer.consume(consumeInput),
              });
              supersedingSourceConverged = true;
            },
            emitSessionEvent: (sessionId, event) => {
              // Runtime-auth recovery switch — surface transcript event + notification through the
              // single choke point (reason-aware suppression owned by the committer/dispatcher).
              surfaceConnectedServiceAccountSwitchOutcomeForSession({ sessionId, event });
            },
            onRuntimeAuthRecoverySuccess: async (recoverySuccess) => {
              // The observer fires on local group-switch substeps
              // (switched/observed_generation) and on bare credential_refreshed.
              // Forward only the proof carriers it has (post-switch adoption
              // verification / from-profile); the shared gate clears recovery solely
              // on accepted proof. credential_refreshed carries neither and stays
              // provider-outcome-waiting.
              await markRuntimeAuthRecoverySucceeded('observer', {
                ...(recoverySuccess.verificationByServiceId
                  ? { verificationByServiceId: recoverySuccess.verificationByServiceId }
                  : {}),
                ...(recoverySuccess.fromProfileId ? { fromProfileId: recoverySuccess.fromProfileId } : {}),
                activeProfileId: recoverySuccess.profileId,
              });
              const recoveryServiceId = ConnectedServiceIdSchema.safeParse(recoverySuccess.serviceId);
              const recoveryGroupId = typeof recoverySuccess.groupId === 'string' && recoverySuccess.groupId.trim().length > 0
                ? recoverySuccess.groupId.trim()
                : null;
              const recoveryProfileId = typeof recoverySuccess.profileId === 'string' && recoverySuccess.profileId.trim().length > 0
                ? recoverySuccess.profileId.trim()
                : null;
              const recoveryGeneration = typeof recoverySuccess.generation === 'number' && Number.isFinite(recoverySuccess.generation)
                ? Math.trunc(recoverySuccess.generation)
                : null;
              if (
                recoverySuccess.verificationByServiceId
                && recoveryServiceId.success
                && recoveryGroupId
                && recoveryProfileId
                && recoveryGeneration !== null
              ) {
                await persistMemberRuntimeStateWithPositiveEvidence({
                  api,
                  serviceId: recoveryServiceId.data,
                  groupId: recoveryGroupId,
                  profileId: recoveryProfileId,
                  generation: recoveryGeneration,
                  evidence: { kind: 'account_adoption', observedAtMs: Date.now() },
                  normalizePolicy: normalizeConnectedServiceAuthGroupPolicy,
                }).catch((error) => {
                  logger.debug('[DAEMON RUN] Failed to clear connected-service member runtime-state after account adoption', {
                    serviceId: recoveryServiceId.data,
                    groupId: recoveryGroupId,
                    profileId: recoveryProfileId,
                    error: serializeAxiosErrorForLog(error),
                  });
                });
              }
            },
            onRuntimeAuthRestartFailure: async (restartFailure) => {
              logger.warn('[DAEMON RUN] Connected-service runtime-auth restart failed after recovery response', {
                sessionId: restartFailure.sessionId,
                pid: restartFailure.tracked.pid,
                source: restartFailure.source,
                groupSwitchStatus: restartFailure.groupSwitchResult?.status,
                groupSwitchMode: restartFailure.groupSwitchResult && 'mode' in restartFailure.groupSwitchResult
                  ? restartFailure.groupSwitchResult.mode
                  : undefined,
                error: serializeAxiosErrorForLog(restartFailure.error),
              });
            },
            sessionId: input.sessionId,
            switchesThisTurn: input.switchesThisTurn,
            recoveryInvocationSource: input.source,
            classification: input.classification,
          });
          if (await continueAfterSupersededRuntimeAuthFailure({
            result,
            sessionId: input.sessionId,
            interruptedOriginId,
            continueAfterRuntimeAuthSwitch,
            reconcileCurrentRuntimeAuthTarget: async ({ sessionId, serviceId, groupId }) => {
              const target = connectedServiceRuntimeRegistry.getBySessionId(sessionId);
              if (!target) return false;
              const registration: ConnectedServiceRuntimeTargetRegistration = {
                key: { kind: 'session', pid: target.pid },
                target,
              };
              if (
                !connectedServiceRuntimeRegistry.isCurrentTargetRegistration(registration)
                || !target.activeBindings.some((binding) => (
                  binding.serviceId === serviceId && binding.groupId === groupId
                ))
              ) return false;
              await enqueueConnectedServiceRuntimeTargetRegistrationReconciliation(registration, true);
              const currentTarget = connectedServiceRuntimeRegistry.getBySessionId(sessionId);
              if (!currentTarget) return false;
              const snapshot = latestConnectedServiceProjectionSnapshot;
              const group = snapshot?.groups.find((candidate) => (
                candidate.serviceId === serviceId && candidate.groupId === groupId
              )) ?? null;
              if (!group?.activeProfileId) return false;
              const credentialBoundary = snapshot?.resolveCredentialBoundary(serviceId, group.activeProfileId);
              if (credentialBoundary?.status !== 'present') return false;
              return currentTarget.activeBindings.some((binding) => (
                binding.serviceId === serviceId
                && binding.groupId === groupId
                && binding.profileId === group.activeProfileId
                && binding.generation === group.generation
                && (
                  credentialBoundary.credentialRevision === null
                  || binding.credentialRevision === credentialBoundary.credentialRevision
                )
              ));
            },
          })) {
            return result;
          }
          if (
            input.source !== 'scheduler_retry'
            && input.classification.kind === 'usage_limit'
            && typeof input.classification.groupId === 'string'
            && input.classification.groupId.trim().length > 0
            && typeof input.classification.profileId === 'string'
            && input.classification.profileId.trim().length > 0
          ) {
            const serviceId = ConnectedServiceIdSchema.safeParse(input.classification.serviceId);
            const quotaCoordinator = connectedServiceQuotasCoordinator;
            if (serviceId.success && quotaCoordinator) {
              try {
                const committedRecovery = resolveCommittedGenerationFromRuntimeAuthRecovery({
                  serviceId: serviceId.data,
                  groupId: input.classification.groupId,
                  recovery: result,
                });
                await quotaCoordinator.recordRuntimeUsageLimitExhaustionAndFanout({
                  sourceSessionId: input.sessionId,
                  serviceId: serviceId.data,
                  groupId: input.classification.groupId,
                  exhaustedProfileId: input.classification.profileId,
                  resetAtMs: input.classification.resetsAtMs,
                  sourceGroupGeneration: input.classification.groupGeneration ?? null,
                  sourceProviderAccountId: input.classification.sourceProviderAccountId ?? null,
                  sourceAccountLabel: input.classification.sourceAccountLabel ?? null,
                  committedGeneration: committedRecovery?.committedGeneration ?? null,
                  sourceRequiresConvergence:
                    (committedRecovery?.sourceRequiresConvergence ?? false) && !supersedingSourceConverged,
                });
              } catch (error) {
                logger.debug('[DAEMON RUN] Failed to fan out connected-service runtime usage-limit exhaustion (non-fatal)', error);
              }
            }
          }
          if (input.classification) {
            logger.debug('[DAEMON RUN] Connected-service reactive runtime-auth switch attempt', buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
              sessionId: input.sessionId,
              classification: input.classification,
              result,
              routedThroughFsm: true,
              startedAtMs: runtimeFailureAtMs,
              finishedAtMs: Date.now(),
            }));
          }
          return result;
        };

        const runtimeAuthRecoveryBaseBackoffMs = resolvePositiveIntEnv(
          process.env.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_BASE_BACKOFF_MS,
          2_000,
          { min: 250, max: 60_000 },
        );
        const runtimeAuthRecoveryMaxBackoffMs = resolvePositiveIntEnv(
          process.env.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_MAX_BACKOFF_MS,
          60_000,
          { min: 1_000, max: 10 * 60_000 },
        );
        const runtimeAuthRecoveryStormWindowMs = resolvePositiveIntEnv(
          process.env.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_STORM_WINDOW_MS,
          60_000,
          { min: 1_000, max: 10 * 60_000 },
        );
        const runtimeAuthRecoveryStormThreshold = resolvePositiveIntEnv(
          process.env.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_STORM_THRESHOLD,
          3,
          { min: 2, max: 100 },
        );
        const runtimeAuthRecoveryLocalServerFailureTimes: number[] = [];
        const pruneRuntimeAuthRecoveryLocalServerFailures = (nowMs: number): void => {
          while (
            runtimeAuthRecoveryLocalServerFailureTimes.length > 0
            && runtimeAuthRecoveryLocalServerFailureTimes[0]! <= nowMs - runtimeAuthRecoveryStormWindowMs
          ) {
            runtimeAuthRecoveryLocalServerFailureTimes.shift();
          }
        };
        const runtimeAuthRecoveryJitterMs = (): number => Math.trunc(Math.random() * Math.min(1_000, runtimeAuthRecoveryBaseBackoffMs));
        const recordRuntimeAuthRecoveryDiagnostic = (event: RuntimeAuthRecoveryDiagnostic): void => {
          const nowMs = Date.now();
          pruneRuntimeAuthRecoveryLocalServerFailures(nowMs);
          if (shouldTreatRuntimeAuthRecoveryClassificationAsLocalServerFailure(event.classification)) {
            runtimeAuthRecoveryLocalServerFailureTimes.push(nowMs);
          }
          if (event.event === 'runtime_auth_recovery_success') {
            runtimeAuthRecoveryLocalServerFailureTimes.length = 0;
          }
          const logPayload = {
            event: event.event,
            sessionId: event.sessionId,
            serviceId: event.serviceId,
            profileId: event.profileId,
            groupId: event.groupId,
            failurePhase: event.failurePhase,
            reason: event.reason,
            attemptCount: event.attemptCount,
            nextRetryAtMs: event.nextRetryAtMs,
            classification: event.classification,
          };
          if (event.transcriptEvent && runtimeAuthRecoveryScheduler) {
            runtimeAuthRecoveryScheduler.schedulePendingVisibleEventDrain({
              delayMs: 0,
              deliver: async (delivery) => {
                await commitRuntimeAuthRecoveryDiagnosticForDaemon({ credentials, delivery });
              },
              onError: (error) => {
                logger.debug('[DAEMON RUN] Failed to commit durable runtime-auth recovery session event; retrying (non-fatal)', {
                  sessionId: event.sessionId,
                  serviceId: event.serviceId,
                  error: serializeAxiosErrorForLog(error),
                });
              },
            });
          }
          if (event.event === 'runtime_auth_recovery_dead_letter' || event.event === 'runtime_auth_recovery_terminal') {
            logger.warn('[DAEMON RUN] Connected-service runtime-auth recovery diagnostic', logPayload);
            return;
          }
          logger.debug('[DAEMON RUN] Connected-service runtime-auth recovery diagnostic', logPayload);
        };
        const runtimeAuthRecoveryComposition = createRuntimeAuthRecoverySchedulerForDaemon({
          activeServerDir: configuration.activeServerDir,
          nowMs: () => Date.now(),
          baseBackoffMs: runtimeAuthRecoveryBaseBackoffMs,
          maxBackoffMs: runtimeAuthRecoveryMaxBackoffMs,
          jitterMs: runtimeAuthRecoveryJitterMs,
          providerOutcomePendingWaitMs: connectedServiceContinuationProviderActivityTimeoutMs,
          maxAttempts: resolvePositiveIntEnv(
            process.env.HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_MAX_ATTEMPTS,
            5,
            { min: 1, max: 25 },
          ),
          recover: handleConnectedServiceRuntimeAuthRecovery,
          gate: ({ intent }) => {
            const nowMs = Date.now();
            // Daemon-lifecycle gate: while shutting down, defer the recovery WITHOUT counting an
            // attempt (the gate runs before the attempt increment) and WITHOUT running the handler.
            // Keep the live-daemon intent waiting at its current retry time; `dispose()` below stops
            // timers during teardown. A replacement daemon reconstructs the durable state passively.
            if (shutdownInitiated) {
              return {
                status: 'delayed' as const,
                retryAtMs: intent.nextRetryAtMs ?? nowMs,
                reason: 'daemon_lifecycle_unavailable',
              };
            }
            pruneRuntimeAuthRecoveryLocalServerFailures(nowMs);
            if (!shouldTreatRuntimeAuthRecoveryClassificationAsLocalServerFailure(intent.lastErrorClassification)) {
              return { status: 'open' as const };
            }
            const stormCount = runtimeAuthRecoveryLocalServerFailureTimes.length;
            if (stormCount < runtimeAuthRecoveryStormThreshold) return { status: 'open' as const };
            const stormBackoffMs = Math.min(
              runtimeAuthRecoveryMaxBackoffMs,
              runtimeAuthRecoveryBaseBackoffMs * (2 ** Math.min(6, stormCount - runtimeAuthRecoveryStormThreshold + 1)),
            );
            return {
              status: 'delayed' as const,
              retryAtMs: nowMs + stormBackoffMs + runtimeAuthRecoveryJitterMs(),
              reason: 'local_server_storm',
            };
          },
          recordDiagnostic: recordRuntimeAuthRecoveryDiagnostic,
        });
        runtimeAuthRecoveryScheduler = runtimeAuthRecoveryComposition.scheduler;
        runtimeAuthRecoveryScheduler.schedulePendingVisibleEventDrain({
          delayMs: 0,
          deliver: async (delivery) => {
            await commitRuntimeAuthRecoveryDiagnosticForDaemon({ credentials, delivery });
          },
          onError: (error) => {
            logger.debug('[DAEMON RUN] Failed to drain durable runtime-auth recovery session events; retrying (non-fatal)', {
              error: serializeAxiosErrorForLog(error),
            });
          },
        });
        if (runtimeAuthRecoveryComposition.hydratedIntents.length > 0) {
          logger.debug('[DAEMON RUN] Hydrated runtime-auth recovery intents passively', {
            count: runtimeAuthRecoveryComposition.hydratedIntents.length,
          });
        }
        // QAE-1: single daemon-side owner for a user "Stop waiting" (wait-resume
        // cancel). It must clear BOTH durable recovery stores (runtime-auth
        // recovery + inactive usage-limit) and superseded report-outbox /
        // pending-continuation state — a `waiting` intent left armed in either
        // store resumes the session involuntarily at the provider reset time.
        const cancelConnectedServiceUsageLimitWaitResumeForSession = async (
          input: Readonly<{ sessionId: string; attemptId: string }>,
        ): Promise<Readonly<{ ok: true }>> => {
          const { sessionId } = input;
          const settled = await Promise.allSettled([
            runtimeAuthRecoveryScheduler?.cancelExact(input) ?? Promise.resolve([]),
          ]);
          for (const result of settled) {
            if (result.status === 'rejected') {
              logger.warn('[DAEMON RUN] Failed to clear connected-service recovery wait state after user wait-resume cancel', {
                sessionId,
                error: serializeAxiosErrorForLog(result.reason),
              });
            }
          }
          return { ok: true };
        };

    const controlToken = randomBytes(32).toString('base64url');
    let selfRestartFileState: DaemonLocallyPersistedState | null = null;

    // Run-materialization bridge for execution runs (ER-CS): the daemon stays the sole CS owner —
    // the bridge closes the daemon's spawn-resolution singletons over the EXISTING
    // `resolveConnectedServiceAuthForSpawn` owner (no parallel resolver) and registers run PIDs in the
    // runtime registry so refresh distribution / canonical group-home ownership cover run homes.
    const executionRunConnectedServicesBridge = createExecutionRunConnectedServicesBridge({
      resolveAuthForSpawn: async (params) => await resolveConnectedServiceAuthForSpawn({
        agentId: params.agentId,
        sessionDirectory: params.sessionDirectory ?? null,
        connectedServicesBindingsRaw: params.connectedServicesBindingsRaw,
        materializationKey: params.materializationKey,
        activeServerDir: configuration.activeServerDir,
        baseDir: connectedServicesMaterializationBaseDir,
        credentials,
        api,
        accountUsageStore: providerAccountUsageStore,
        runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
        processEnv: process.env,
        credentialRefreshService: connectedServiceRefreshCoordinator,
      }),
      runtimeRegistry: connectedServiceRuntimeRegistry,
      createAdoptedRootCleanup: ({ materializedRoot, materializationKey, agentId }) => {
        return createAdoptedExecutionRunRootCleanup({
          materializationBaseDir: connectedServicesMaterializationBaseDir,
          materializedRoot,
          materializationKey,
          agentId,
          removeRoot: async (root) => await fs.rm(root, { recursive: true, force: true }),
        });
      },
    });
    await rehydrateLiveExecutionRunRuntimeTargets({
      markers: listExecutionRunMarkers,
      runtimeRegistry: connectedServiceRuntimeRegistry,
      adoptCleanup: executionRunConnectedServicesBridge.adoptLiveMaterialization,
      proveRunnerLive: async (marker) => {
        const tracked = pidToTrackedSession.get(marker.pid);
        if (!tracked || tracked.happySessionId !== marker.happySessionId) return false;
        return await isSessionRunnerActiveInDaemon({
          sessionId: marker.happySessionId,
          trackedSessions: [tracked],
        });
      },
    }).catch((error) => {
      logger.debug('[DAEMON RUN] Passive execution-run target re-registration failed (non-fatal)', error);
    });
    const resolveExecutionRunBridgeAgentId = (agentIdRaw: string): CatalogAgentId => {
      const agentId = agentIdRaw.trim();
      if (!(AGENT_IDS as readonly string[]).includes(agentId)) {
        // Fail closed: an unknown agent id must never silently materialize nothing.
        throw new Error(`execution_run_connected_service_unknown_agent:${agentId}`);
      }
      return agentId as CatalogAgentId;
    };

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      machineId,
      runtimeId,
      stopSession,
      prepareStopSession: prepareStopSessionForDaemonStop,
      spawnSession,
      resolveSpawnSessionByNonce: async (spawnNonce) => daemonSpawnAttemptRegistry.resolve(spawnNonce),
      requestShutdown: () => requestShutdown('happier-cli'),
      beforeShutdown,
      onHappySessionWebhook,
      controlToken,
      handleExecutionRunConnectedServiceMaterialize: async (input) => {
        return await executionRunConnectedServicesBridge.materialize({
          runId: input.runId,
          agentId: resolveExecutionRunBridgeAgentId(input.agentId),
          pid: input.pid,
          materializationKey: input.materializationKey,
          connectedServicesBindingsRaw: input.connectedServicesBindingsRaw,
          sessionDirectory: input.sessionDirectory ?? null,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        });
      },
      handleExecutionRunConnectedServiceRelease: async (input) => {
        return await executionRunConnectedServicesBridge.release({
          runId: input.runId,
          pid: input.pid,
          materializationKey: input.materializationKey,
        });
      },
      isShuttingDown: () => shutdownInitiated || connectedServiceQuotaProducersQuiesced,
      handleSessionRunnerRestart: async (request: RestartSessionRunnerRequestV1) => {
        const tracked = getCurrentChildren().find((child) => child.happySessionId === request.sessionId) ?? null;
          const result = await restartSessionRunnerOnCurrentRuntime({
            request,
            tracked,
            currentIdentity: resolveCurrentSessionRunnerLaunchIdentity(),
            requestRestart: requestVersionRuntimeRefreshWithDeferral,
            resolveActivityDisabledReason: resolveSessionRunnerActivityDisabledReason,
          });
        return RestartSessionRunnerResultV1Schema.parse(result);
      },
      handleSessionRunnerRestartAll: async (request) => {
        const result = await restartAllSessionRunnersOnCurrentRuntime({
          mode: request.mode,
          reason: request.reason,
          dryRun: request.dryRun === true,
          currentIdentity: resolveCurrentSessionRunnerLaunchIdentity(),
          trackedSessions: getCurrentChildren(),
          requestRestart: requestVersionRuntimeRefreshWithDeferral,
          resolveActivityDisabledReason: resolveSessionRunnerActivityDisabledReason,
        });
        return RestartAllSessionRunnersResultV1Schema.parse(result);
      },
      handleSessionRunnerStatusGet: async (request) => {
        const tracked = getCurrentChildren().find((child) => child.happySessionId === request.sessionId) ?? null;
        return resolveSessionRunnerRuntimeState({
          sessionId: request.sessionId,
          tracked,
          currentIdentity: resolveCurrentSessionRunnerLaunchIdentity(),
          resolveActivityDisabledReason: resolveSessionRunnerActivityDisabledReason,
          machineId,
          daemonId: runtimeId,
          observedAtMs: Date.now(),
        });
      },
      handleConnectedServiceUsageLimitWaitResumeCancel: cancelConnectedServiceUsageLimitWaitResumeForSession,
      handleSessionConnectedServiceAuthSwitch: async (input) => {
        let diagnostics: SessionConnectedServiceAuthSwitchDiagnostics | undefined;
        const switchStartedAtMs = Date.now();
        const serviceIds = Object.keys(input.bindings.bindingsByServiceId);
        await clearConnectedServiceRecoveryAfterSupersession({
          sessionId: input.sessionId,
          event: {
            kind: 'manual_session_supersession',
            reason: 'switch',
          },
        });
        const trackedForSwitch = getCurrentChildren().find((child) => child.happySessionId === input.sessionId) ?? null;
        const previousBindings = readConnectedServiceBindingsOrEmpty(
          trackedForSwitch ? resolveTrackedConnectedServiceBindingsRaw(trackedForSwitch) : undefined,
        );
        // Thread the live pre-switch member for any group binding so a manual group-member switch's
        // transcript "from" is the real account (the persisted group binding does not track it) —
        // mirrors the automatic path. Best-effort; falls back to the previous binding's profile.
        const manualSwitchPreviousGroupMembers = await resolveManualSwitchPreviousGroupMembers({
          api,
          previousBindings,
        });
        if (typeof input.accountSettingsVersionHint === 'number') {
          try {
            await refreshDaemonAccountSettingsForHint({
              credentials,
              settingsVersion: input.accountSettingsVersionHint,
            });
            diagnostics = {
              accountSettingsFreshness: {
                requestedVersion: input.accountSettingsVersionHint,
                status: 'succeeded',
              },
            };
          } catch (error) {
            logger.warn('[DAEMON RUN] Account settings freshness refresh failed before connected-service auth switch', serializeAxiosErrorForLog(error));
            diagnostics = {
              accountSettingsFreshness: {
                requestedVersion: input.accountSettingsVersionHint,
                status: 'failed',
                error: toConnectedServiceAuthSwitchDiagnosticError(error),
              },
            };
          }
        }
        // K5:fsm_switch manual (RPC-driven, user-initiated) auth switch through the FSM.
        const result = await switchSessionConnectedServiceAuth({
          core: connectedServiceSessionAuthSwitchCore,
          getChildren: getCurrentChildren,
          emitFromProfileIdByServiceId: manualSwitchPreviousGroupMembers,
          resolveInactiveSession: async ({ sessionId }) => {
            const inactiveAgentId = resolveCatalogAgentId(
              (CATALOG_AGENT_IDS as readonly string[]).includes(input.agentId)
                ? input.agentId as Parameters<typeof resolveCatalogAgentId>[0]
                : null,
            );
            const inactive = await resolveInactiveConnectedServiceSessionForAuthSwitch({
              credentials,
              sessionId,
              agentId: inactiveAgentId,
            });
            if (!inactive) return null;
            // Derive the persisted session-file hint from the inactive session metadata via the SAME
            // provider-agnostic catalog helper the tracked/spawn paths use, so the continuity check
            // can prove shared-state resume reachability for an inactive (not-running) session.
            const candidatePersistedSessionFile = resolveConnectedServiceCandidatePersistedSessionFile(
              inactive.agentId,
              inactive.metadata ?? null,
            );
            return {
              ...inactive,
              ...(candidatePersistedSessionFile ? { candidatePersistedSessionFile } : {}),
            };
          },
          api,
          resolveContinuity: async ({
            tracked,
            sessionId,
            agentId,
            serviceId,
            previous,
            next,
            previousBindings,
            normalizedBindings,
            runtimeAuthSelection,
            connectedServiceMaterializationIdentityV1,
            vendorResumeId,
            cwd: inactiveCwd,
            candidatePersistedSessionFile: inactiveCandidatePersistedSessionFile,
          }) => {
            const persistedSessionMetadata = tracked
              ? await resolvePersistedConnectedServiceSwitchSessionMetadata({
                  credentials,
                  sessionId,
                  agentId,
                })
              : null;
            const continuityContext = resolveTrackedConnectedServiceSwitchContinuityContext({
              agentId,
              baseDir: connectedServicesMaterializationBaseDir,
              tracked,
              persistedSessionMetadata,
              connectedServiceMaterializationIdentityV1,
              vendorResumeId,
              cwd: inactiveCwd,
              candidatePersistedSessionFile: inactiveCandidatePersistedSessionFile,
              resolveCandidatePersistedSessionFile: resolveConnectedServiceCandidatePersistedSessionFile,
              // RD-SW-2 (Rule A): the proof context must target the POST-switch materialized
              // home, not the tracked session's pre-switch env.
              runtimeAuthSelection,
            });
            return await resolveSessionConnectedServiceSwitchContinuity({
              sessionId,
              agentId,
              serviceId,
              previousBinding: previous,
              nextBinding: next,
              fromBindingsRaw: tracked
                ? resolveTrackedConnectedServiceBindingsRaw(tracked) ?? previousBindings
                : previousBindings,
              toBindings: normalizedBindings,
              accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
              connectedServiceMaterializationIdentityV1: continuityContext.connectedServiceMaterializationIdentityV1,
              vendorResumeId: continuityContext.vendorResumeId,
              targetMaterializedRoot: continuityContext.targetMaterializedRoot,
              targetMaterializedEnv: continuityContext.targetMaterializedEnv,
              cwd: continuityContext.cwd,
              candidatePersistedSessionFile: continuityContext.candidatePersistedSessionFile,
              ...(runtimeAuthSelection === undefined ? {} : { runtimeAuthSelection }),
            });
          },
          materializeRuntimeAuthSelection: async (materializerInput) =>
            await materializeSessionConnectedServiceRuntimeAuthSelection({
              credentials,
              api,
              activeServerDir: configuration.activeServerDir,
              input: materializerInput,
              accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
              processEnv: process.env,
          }),
          runtimeAuthApplyCapabilityResolver: async ({ agentId }) => {
            const lifecycleDescriptor = await resolveConnectedServiceCredentialLifecycleDescriptor(agentId);
            return lifecycleDescriptor.runtimeAuthApply;
          },
          restartSession: async (tracked) => {
            const primaryServiceId = serviceIds.length === 1 ? serviceIds[0] ?? '' : '__multi_service_switch__';
            const primaryBinding = serviceIds.length === 1
              ? input.bindings.bindingsByServiceId[primaryServiceId]
              : null;
            const primaryGeneration = serviceIds.length === 1
              ? input.expectedGroupGenerationByServiceId?.[primaryServiceId]
              : undefined;
            const restartSignalDelayMs = resolvePositiveIntEnv(
              process.env.HAPPIER_CONNECTED_SERVICES_AUTH_SWITCH_RESTART_SIGNAL_DELAY_MS,
              250,
              { min: 0, max: 5_000 },
            );
            // K5:fsm_switch the FSM's restartSession callback for the manual switch; the FSM
            // owns reachability/continuity and only calls this when a restart-resume is chosen.
            await requestConnectedServiceRestartWithDeferral({
              sessionId: input.sessionId,
              tracked,
              source: 'manual',
              policy: 'defer_until_turn_boundary',
              target: normalizeSwitchTarget({
                serviceId: primaryServiceId,
                profileId: primaryBinding && primaryBinding.source === 'connected' ? primaryBinding.profileId : '',
                groupId: primaryBinding && primaryBinding.source === 'connected' && primaryBinding.selection === 'group'
                  ? primaryBinding.groupId
                  : '',
                generation: serviceIds.length === 1
                  ? input.expectedGroupGenerationByServiceId?.[primaryServiceId]
                  : 0,
              }),
              restartSignalDelayMs,
              restartDiagnostic: {
                trigger: 'manual_switch',
                sessionId: input.sessionId,
                agentId: input.agentId,
                serviceId: serviceIds.length === 1 ? serviceIds[0] ?? null : null,
                profileId: primaryBinding && primaryBinding.source === 'connected'
                  ? primaryBinding.profileId
                  : null,
                groupId: primaryBinding && primaryBinding.source === 'connected' && primaryBinding.selection === 'group'
                  ? primaryBinding.groupId
                  : null,
                generation: typeof primaryGeneration === 'number' && Number.isFinite(primaryGeneration)
                  ? Math.max(0, Math.trunc(primaryGeneration))
                  : null,
                reason: 'manual',
              },
              transcriptEventOwner: 'switch_fsm',
              onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart connected-service auth-switched session',
            });
          },
          hotApply: createSessionConnectedServiceAuthHotApply({
            validateGroupMutationCurrentness: validateConnectedServiceGroupMutationCurrentness,
          }),
          recoverAfterRuntimeAuthSwitch: recoverTrackedSessionConnectedServiceRuntimeAuthSwitch,
          verifyProviderAccountAdoption: verifyConnectedServiceAccountAdoption,
          persistSessionBindings: async ({
            sessionId,
            normalizedBindings,
            connectedServiceMaterializationIdentityV1,
          }) => {
            await persistSessionConnectedServiceBindings({
              credentials,
              sessionId,
              normalizedBindings,
              connectedServiceMaterializationIdentityV1,
            });
          },
          registerHotApplyTargets: (tracked, context) => {
            // Hot-apply keeps the runner alive, so no webhook will rewrite the durable
            // session marker — refresh it here or a daemon restart restores the
            // pre-switch bindings and treats real switch requests as 'unchanged'.
            if (tracked.spawnOptions) {
              void refreshSessionMarkerRespawn({
                pid: tracked.pid,
                spawnOptions: tracked.spawnOptions,
                encryptionMaterial: credentials.encryption,
              }).catch((error) => {
                logger.debug('[DAEMON RUN] Failed to refresh session marker after hot-applied auth switch', error);
              });
            }
            const catalogAgentId = resolveTrackedSessionCatalogAgentId(tracked);
            const materializationIdentity = readConnectedServiceMaterializationIdentityV1(
              tracked.spawnOptions?.connectedServiceMaterializationIdentityV1,
            );
            if (!materializationIdentity) return;
            registerConnectedServiceRuntimeTargetForDaemon({
              runtimeRegistry: connectedServiceRuntimeRegistry,
              pid: tracked.pid,
              agentId: catalogAgentId,
              sessionId: tracked.happySessionId,
              connectedServicesBindingsRaw: tracked.spawnOptions?.connectedServices,
              materializationKey: materializationIdentity.id,
              // RD-MAT-6: keep refresh-driven rematerialization on the live identity root and
              // the session's working directory (workspace-trust projection target).
              connectedServiceMaterializationIdentityV1: materializationIdentity,
              sessionDirectory: tracked.spawnOptions?.directory ?? null,
              ...(tracked.spawnOptions?.environmentVariables
                ? { connectedServiceSelectionsEnv: tracked.spawnOptions.environmentVariables }
                : {}),
              runtimeAccountIdentitySelections: buildRuntimeAccountIdentitySelectionsFromHotApply(
                context?.runtimeAuthSelectionsByServiceId,
              ),
            });
          },
          emitSessionEvent: (sessionId, event) => {
            // Manual switch — surface through the single choke point. The event reason defaults to
            // 'manual', which the dispatcher suppresses, so manual switches stay notification-silent
            // while still committing the transcript switch event.
            surfaceConnectedServiceAccountSwitchOutcomeForSession({ sessionId, event });
          },
          request: input,
        });
        const resultWithDiagnostics = attachConnectedServiceAuthSwitchDiagnostics(result, diagnostics);
        logConnectedServiceAuthSwitchResult({
          logger,
          sessionId: input.sessionId,
          agentId: input.agentId,
          serviceIds,
          result: resultWithDiagnostics,
          startedAtMs: switchStartedAtMs,
          finishedAtMs: Date.now(),
          previousBindings,
          expectedGroupGenerationByServiceId: input.expectedGroupGenerationByServiceId,
        });
        return resultWithDiagnostics;
      },
      handleConnectedServiceRuntimeAuthFailure: handleConnectedServiceRuntimeAuthRecovery,
      authorizeConnectedServiceRuntimeAuthFailure: async ({ sessionId, classification }) => {
        const runtimeAuthApply = classification
          ? await resolveRuntimeAuthApplyForFailureSource({
              sessionId,
              serviceId: ConnectedServiceIdSchema.parse(classification.serviceId),
            })
          : null;
        return await authorizeConnectedServiceRuntimeAuthFailureSource({
          getChildren: getCurrentChildren,
          sessionId,
          classification,
          resolveDurableSessionForRuntimeAuthRecovery: async ({ sessionId: durableSessionId, classification: durableClassification }) =>
            await resolveDurableConnectedServiceRuntimeAuthRecoverySession({
              credentials,
              sessionId: durableSessionId,
              serviceId: durableClassification.serviceId,
          }),
          resolveRegisteredRuntimeAuthFailureSource: resolveRegisteredRuntimeAuthFailureSourceForSession,
          resolveCurrentRuntimeAuthFailureSource: resolveCurrentRuntimeAuthFailureSourceForSession,
          resolveProviderQualifiedRuntimeAuthFailureSource,
          runtimeAuthApply,
        });
      },
      resolveConnectedServiceRuntimeAuthResumePromptMode: async ({ classification, explicit }) =>
        await resolveContinuationResumePromptMode({
          credentials,
          serviceId: ConnectedServiceIdSchema.parse(classification.serviceId),
          groupId: classification.groupId,
          explicit,
        }),
      runtimeAuthRecoveryScheduler: runtimeAuthRecoveryScheduler ?? undefined,
      handleConnectedServiceTurnLifecycle: async (input) => {
        const trackedTurnResult = await applyTrackedSessionTurnLifecycle({
          trackedSessions: getCurrentChildren(),
          sessionId: input.sessionId,
          event: input.event,
          ...(input.turnId ? { turnId: input.turnId } : {}),
        });
        connectedServiceTurnDeferralQueue.recordTurnLifecycleEvent({
          sessionId: input.sessionId,
          event: input.event,
        });
        // REV-1: failTurn emits `assistant_message_end` too — a FAILED turn (the
        // usage-limit interruption itself) is not provider-activity proof and must
        // not clear the recovery intents the failure report just armed.
        if (isProviderActivityTurnLifecycleEvent(input.event, input.terminalStatus)) {
          await recordConnectedServiceContinuationProviderActivity({
            sessionId: input.sessionId,
            recoveryIdentities: resolveTrackedContinuationRecoveryIdentities({
              sessionId: input.sessionId,
              runtimeBindings: connectedServiceRuntimeRegistry.getBySessionId(input.sessionId)?.activeBindings ?? [],
              recoveryIntents: runtimeAuthRecoveryScheduler?.readForSession(input.sessionId) ?? [],
            }),
          });
        }
        if (input.event === 'assistant_message_end' && input.terminalStatus !== 'failed') {
          await clearMemberRuntimeStateWithPositiveEvidenceForTarget(
            connectedServiceRuntimeRegistry.getBySessionId(input.sessionId),
            { kind: 'successful_turn', observedAtMs: Date.now() },
          );
        }
        // Runtime-auth report-outbox supersession remains owned by its canonical cleaner.
        await clearConnectedServiceRecoveryAfterSupersession({
          sessionId: input.sessionId,
          event: {
            kind: 'turn_lifecycle',
            event: input.event,
            ...(input.terminalStatus ? { terminalStatus: input.terminalStatus } : {}),
          },
        });
        return connectedServiceTurnLifecycleContinue(trackedTurnResult);
      },
      handleConnectedServiceQuotaSnapshot: async (input) => await recordConnectedServiceRuntimeQuotaSnapshotForSession({
        accountUsageRecorder: {
          store: providerAccountUsageStore,
          persistence: providerAccountUsagePersistence,
          publishRecordId: async ({ sessionId, recordId }) => await publishProviderAccountUsageRecordIdToSessionMetadata({
            credentials,
            sessionId,
            recordId,
          }),
        },
        getChildren: getCurrentChildren,
        notifyAccountUsageChanged: async (change) => {
          await connectedServiceQuotasCoordinator?.handleAccountUsageChanged(change);
        },
        runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
        sessionId: input.sessionId,
        serviceId: input.serviceId,
        groupId: input.groupId,
        groupGeneration: input.groupGeneration,
        sourceProviderAccountId: input.sourceProviderAccountId,
        credentialFingerprint: input.credentialFingerprint,
        policyDisposition: input.policyDisposition,
        resolveProviderQualifiedGroupSource: async (candidate) => {
          const group = await api.getConnectedServiceAuthGroup({
            serviceId: candidate.serviceId,
            groupId: candidate.groupId,
          });
          if (!group) return null;
          const profileId = await resolveConnectedServiceGroupMemberByProviderAccountId({
            providerAccountId: candidate.providerAccountId,
            members: group.members,
            resolveProviderAccountId: async (memberProfileId) => {
              const resolved = await resolveConnectedServiceCredentialsWithRevisions({
                credentials,
                api,
                bindings: [{ serviceId: candidate.serviceId, profileId: memberProfileId }],
              }).then((byServiceId) => byServiceId.get(candidate.serviceId) ?? null);
              return resolved
                ? readCredentialAccountIdentity(resolved.record)?.providerAccountId ?? null
                : null;
            },
          });
          return profileId ? { profileId, groupGeneration: group.generation } : null;
        },
        verifyCredentialFingerprint: async (candidate) => {
          const record = await resolveConnectedServiceCredentials({
            credentials,
            api,
            bindings: [{ serviceId: candidate.serviceId, profileId: candidate.profileId }],
          }).then((byServiceId) => byServiceId.get(candidate.serviceId) ?? null);
          return record?.kind === 'oauth'
            && record.oauth.providerAccountId === candidate.providerAccountId
            && computeConnectedServiceAccessTokenFingerprint(record.oauth.accessToken) === candidate.credentialFingerprint;
        },
        resolveCurrentGroupGenerationForProfile: async (candidate) => {
          const currentBinding = connectedServiceRuntimeRegistry
            .getBySessionId(input.sessionId)
            ?.activeBindings.find((binding) => (
              binding.serviceId === candidate.serviceId
              && binding.groupId === candidate.groupId
              && binding.profileId === candidate.profileId
            )) ?? null;
          return currentBinding?.generation ?? null;
        },
        ...(connectedServiceQuotasCoordinator ? {
          resolveExpectedQuotaProbeAppliedIdentity: async (candidate) => {
            const record = await resolveConnectedServiceCredentials({
              credentials,
              api,
              bindings: [{ serviceId: candidate.serviceId, profileId: candidate.profileId }],
            }).then((byServiceId) => byServiceId.get(candidate.serviceId) ?? null).catch(() => null);
            if (record?.kind !== 'oauth') return null;
            return {
              serviceId: candidate.serviceId,
              profileId: candidate.profileId,
              groupId: candidate.groupId,
              groupGeneration: candidate.groupGeneration,
              providerAccountId: record.oauth.providerAccountId,
              materialFingerprint: computeConnectedServiceAccessTokenFingerprint(record.oauth.accessToken),
            };
          },
          resolveQuotaProbeFreshProof: (proofInput) => {
            const coordinator = connectedServiceQuotasCoordinator;
            return coordinator
              ? coordinator.resolveQuotaProbeFreshProof(proofInput)
              : { status: 'no_proof', reason: 'provider_operation_identity_missing' };
          },
          recordQuotaProbeFreshProof: async (proof) => {
            const intents = runtimeAuthRecoveryScheduler?.readForSession(proof.sessionId) ?? [];
            const matches = listMatchingRuntimeAuthRecoveryIntents(intents, {
              serviceId: proof.serviceId,
              groupId: proof.groupId,
              profileId: proof.profileId,
            });
            await Promise.all(matches.map(async (intent) => {
              await runtimeAuthRecoveryScheduler?.markProviderOutcomeProofByKey({
                recoveryKey: buildRuntimeAuthRecoveryKey({
                  sessionId: intent.sessionId,
                  serviceId: intent.serviceId,
                  profileId: intent.profileId,
                  groupId: intent.groupId,
                }),
                proofKind: proof.proofKind,
                ...(intent.attemptId ? { expectedAttemptId: intent.attemptId } : {}),
                observedAtMs: proof.observedAtMs,
              });
            }));
            await inactiveUsageLimitRecoveryScheduler.markProviderOutcomeProofForSession({
              ...proof,
              observedAtMs: proof.observedAtMs,
            });
          },
        } : {}),
        snapshot: input.snapshot,
      }),
      handleConnectedServiceQuotaRecoveryCreditConsume: async (input) => {
        if (!connectedServiceQuotasCoordinator) {
          return {
            ok: false as const,
            errorCode: 'connected_service_quota_recovery_credit_unavailable',
            error: 'connected_service_quota_recovery_credit_unavailable',
          };
        }
        return await connectedServiceQuotasCoordinator.consumeRecoveryCreditForProfile(input);
      },
      handleCodexChatGptAuthTokensRefresh: async (input) => {
        if (!connectedServiceRefreshCoordinator) {
          throw new Error('connected_service_chatgpt_refresh_handler_unavailable');
        }
        return await connectedServiceRefreshCoordinator.refreshOpenAiCodexChatGptTokensForBridge({
          sessionId: input.sessionId,
          brokerSelectionIdentity: input.brokerSelectionIdentity ?? null,
          selection: input.selection,
          chatgptPlanType: input.chatgptPlanType,
          forceRefresh: input.forceRefresh,
          failingAccessTokenFingerprint: input.failingAccessTokenFingerprint ?? null,
        });
      },
      handleClaudeSubscriptionAuthTokensRefresh: async (input) => {
        if (!connectedServiceRefreshCoordinator) {
          throw new Error('connected_service_claude_subscription_refresh_handler_unavailable');
        }
        return await connectedServiceRefreshCoordinator.refreshClaudeSubscriptionTokensForBridge({
          sessionId: input.sessionId,
          brokerSelectionIdentity: input.brokerSelectionIdentity ?? null,
          selection: input.selection,
          forceRefresh: input.forceRefresh,
          failingAccessTokenFingerprint: input.failingAccessTokenFingerprint ?? null,
        });
      },
      requestSelfRestart: async ({ successorDistClosureFingerprint } = {}) => {
        const state = selfRestartFileState;
        const result = await requestDaemonSelfRestartWithLockHandoff({
          getCurrentDaemonLockHandle: () => daemonLockHandle,
          setCurrentDaemonLockHandle: (lockHandle) => {
            daemonLockHandle = lockHandle;
          },
          releaseDaemonLock,
          acquireDaemonLock: () => acquireDaemonLock(5, 200),
          requestShutdown,
          selfRestartParams: {
            runtimeId: state?.runtimeId ?? runtimeId,
            expectedCliVersion: '',
            ownPid: process.pid,
            timeoutMs: readDaemonRestartVerifyTimeoutMs(),
            pollMs: readDaemonRestartVerifyPollMs(),
            postConfirmationOverlapMs: resolvePositiveIntEnv(
              process.env.HAPPIER_DAEMON_RESTART_OVERLAP_EXIT_GRACE_MS,
              1_000,
              { min: 0, max: 5_000 },
            ),
            takeover: true,
            env: successorDistClosureFingerprint
              ? {
                  ...process.env,
                  HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: successorDistClosureFingerprint,
                }
              : undefined,
          },
        });
        if (result.status !== 'exited') {
          throw new Error(`Daemon self-restart did not exit current process (${result.status})`);
        }
      },
    });
    const directPeerRuntimeConfig = resolveMachineTransferRuntimeConfig();
    const directPeerFeatureEnabled = directPeerRuntimeConfig.directPeer.featureEnabled;
    const directPeerServerEnabled = directPeerRuntimeConfig.directPeer.serverEnabled;
    let directPeerRegistry: ReturnType<typeof createDirectPeerTransferRegistry> | null = null;
    let stopDirectPeerServer: () => Promise<void> = async () => {};
    if (directPeerServerEnabled) {
      const { port: directPeerPort, stop } = await startDirectPeerTransferServer({
        readPublishedTransfer: (input) => directPeerRegistry?.readPublishedTransfer(input) ?? null,
        resolveOnDemandTransfer: async (input) => await directPeerRegistry?.resolveOnDemandTransferOnOpen(input) ?? null,
      });
      stopDirectPeerServer = stop;
      directPeerRegistry = createDirectPeerTransferRegistry({
        advertisedPort: directPeerPort,
      });
    }

    // Persist daemon.state.json after the control server is available so:
    // - `happier daemon status` can reliably detect the running process, and
    // - callers can reach `/ping` even if machine registration is slow/unavailable.
    //
    // Note: the presence of daemon.state.json does NOT imply that machine sync is ready.
    const daemonStateCliVersion = resolveDaemonSelfRestartExpectedCliVersion({
      currentCliVersion: packageJson.version,
    });
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now(),
      startedWithCliVersion: daemonStateCliVersion,
      startedWithPublicReleaseChannel: getReleaseRingCatalogEntry(configuration.publicReleaseRing).publicLabel,
      runtimeId,
      ...(selfRestartCorrelationId ? { selfRestartCorrelationId } : {}),
      startupSource,
      serviceLabel,
      machineId,
      daemonLogPath: logger.logFilePath,
      controlToken,
    };
    selfRestartFileState = fileState;
    const connectedServiceBrokerState = {
      httpPort: controlPort,
      connectedServiceBrokerRefreshToken: deriveConnectedServiceBrokerRefreshToken(controlToken),
    };
    let didWriteDaemonState = false;
    const writeDaemonStateOnce = () => {
      if (didWriteDaemonState) return;
      didWriteDaemonState = true;
      if (!writeDaemonStateIfLockOwned(fileState)) {
        throw new Error('Daemon state publication rejected because the process no longer owns the lifecycle lock');
      }
      publishedDaemonStateOwner = {
        pid: fileState.pid,
        startedAt: fileState.startedAt,
      };
      writeConnectedServiceBrokerState(connectedServiceBrokerState);
      logger.debug('[DAEMON RUN] Daemon state written');
    };
    writeDaemonStateOnce();
	        // Prepare initial daemon state
	        const initialDaemonState: DaemonState = {
          status: 'offline',
          pid: process.pid,
          httpPort: controlPort,
          startedAt: Date.now(),
          startedWithCliVersion: daemonStateCliVersion,
        };

      const restartOnAuthUpdate = parseBooleanEnv(
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_RESTART_ENABLED,
        true,
      );
      const restartAfterAuthUpdated = createConnectedServicesAuthUpdatedRestartHandler({
            restartRequestedPids: connectedServicesRestartRequestedPids,
            pidToTrackedSession,
            restartEnabled: restartOnAuthUpdate,
            resolveLifecycleDescriptor: resolveConnectedServiceCredentialLifecycleDescriptor,
            stopSessionForCredentialDeletion: async ({ tracked }) => {
              const sessionId = String(tracked.happySessionId ?? '').trim();
              if (!sessionId) {
                throw new Error(`Cannot invalidate deleted connected-service credential for pid ${tracked.pid}: session id is missing`);
              }
              return await stopSession(sessionId);
            },
            // K3: route credential-refresh / reconnect restarts through the gated
            // restart primitive (turn-deferral + spawn-time reachability gate)
            // instead of the raw SIGTERM primitive. The handler still owns the
            // eligibility/blocking decision; this adapter only enforces deferral.
            requestRestartSignal: async (signalParams) => {
              // O3: switch-attempt trace at the credential-refresh/reconnect restart decision
              // point. The restart is gated (deferral policy below) and re-verifies resume
              // reachability at respawn; this trace records the trigger + ids + deferral state.
              logger.debug('[DAEMON RUN] Connected-service refresh restart attempt', {
                trigger: signalParams.restartDiagnostic?.trigger ?? 'refresh_triggered_restart',
                decision: 'gated_refresh_restart',
                sessionId: signalParams.sessionId,
                serviceId: signalParams.target.serviceId,
                groupId: signalParams.target.groupId,
                generation: signalParams.target.generation,
                deferralPolicy: 'defer_until_turn_boundary',
                routedThroughGatedPrimitive: true,
              });
              // K5:gated_restart refresh/reconnect restart deferred until turn boundary,
              // reachability re-verified at respawn (no raw mid-turn SIGTERM). The handler reserves
              // the pid only when the gated restart actually signalled; a superseded/cancelled
              // deferral returns { signaled: false } so the reservation is not leaked.
              return await requestConnectedServiceRestartWithDeferral({
                sessionId: signalParams.sessionId ?? signalParams.tracked.happySessionId ?? '',
                tracked: signalParams.tracked,
                source: 'automatic',
                policy: 'defer_until_turn_boundary',
                target: normalizeSwitchTarget({
                  serviceId: signalParams.target.serviceId,
                  profileId: signalParams.target.profileId,
                  groupId: signalParams.target.groupId,
                  generation: signalParams.target.generation,
                }),
                restartSignalDelayMs: signalParams.delayMs,
                restartDiagnostic: signalParams.restartDiagnostic ?? {
                  trigger: 'refresh_triggered_restart',
                  sessionId: signalParams.sessionId,
                },
                transcriptEventOwner: 'restart_signal',
                onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart connected-service credential-refreshed session',
              });
            },
            resolveProcessGroupPid: resolveConnectedServiceRestartProcessGroupPid,
            restartSignalDelayMs: resolvePositiveIntEnv(
              process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_RESTART_SIGNAL_DELAY_MS,
              250,
              { min: 0, max: 5_000 },
            ),
            recordRestartDiagnostic: recordConnectedServiceRestartDiagnostic,
            onRestartSignalFailure: (error) => {
              logger.warn('[DAEMON RUN] Failed to restart connected-service credential-refreshed session', error);
            },
            onRestartBlocked: (diagnostic) => {
              logger.debug('[DAEMON RUN] Connected-service credential refresh restart blocked', diagnostic);
            },
          });
      const applyRefreshedConnectedServiceAuth = buildConnectedServiceApplyAuthGeneration({
        commitAccountSwitchEvents: false,
        deferCorrelatedContinuationSettlement: true,
        executionAuthority: 'passive_projection',
      });
      const onAuthUpdated: NonNullable<
        ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0]['onAuthUpdated']
      > = async (event) => {
        if (event.mutation === 'deleted') {
          await restartAfterAuthUpdated(event);
          return { appliedRuntimeIdentityKeys: new Set<string>() };
        }

        const appliedSessionIds = new Set<string>();
        const appliedRuntimeIdentityKeys = new Set<string>();
        for (const target of event.affectedTargets) {
          const sessionId = String(target.sessionId ?? '').trim();
          if (!sessionId || appliedSessionIds.has(sessionId)) continue;
          const selection = target.selectionsByServiceId.get(event.binding.serviceId);
          if (!selection) continue;
          const activeProfileId = selection.kind === 'profile'
            ? selection.profileId
            : selection.activeProfileId;
          if (activeProfileId !== event.binding.profileId) continue;

          const result = await applyRefreshedConnectedServiceAuth({
            sessionId,
            serviceId: event.binding.serviceId,
            groupId: selection.kind === 'group' ? selection.groupId : null,
            activeProfileId,
            generation: selection.kind === 'group' ? selection.generation : null,
            credentialRevision: event.credentialRevision,
            reason: event.trigger,
            switchReason: 'automatic_runtime_failure',
            fromProfileId: activeProfileId,
          });
          if (!result.ok) {
            if (result.errorCode === 'restart_disallowed_by_execution_policy') continue;
            throw new Error(`connected_service_refreshed_auth_application_failed:${result.errorCode ?? 'unknown'}`);
          }
          if (result.action !== 'hot_applied') continue;
          appliedSessionIds.add(sessionId);
          for (const affectedTarget of event.affectedTargets) {
            if (
              affectedTarget.sessionId === sessionId
              && affectedTarget.pid === target.pid
            ) {
              appliedRuntimeIdentityKeys.add(affectedTarget.runtimeIdentityKey);
            }
          }
        }

        await restartAfterAuthUpdated(event);
        return { appliedRuntimeIdentityKeys };
      };
      const refreshStartup = startConnectedServiceRefreshStartup({
        env: process.env,
        api,
        credentials,
        runtimeRegistry: connectedServiceRuntimeRegistry,
        machineId,
        runtimeId,
        activeServerDir: configuration.activeServerDir,
        baseDir: connectedServicesMaterializationBaseDir,
        resolvePositiveIntEnv,
        parseBooleanEnv,
        accountSettingsProvider: () => getActiveAccountSettingsSnapshot()?.settings ?? null,
        onAuthUpdated,
        onCredentialHealthNotification: async ({ diagnostic, healthStatus, affectedTargets }) => {
          const settingsSnapshot = getActiveAccountSettingsSnapshot();
          const notificationTargets = affectedTargets.length > 0
            ? affectedTargets.map((target) => ({
              sessionId: target.sessionId,
              tracked: pidToTrackedSession.get(target.pid) ?? null,
            }))
            : [{
              sessionId: `connected-service:${diagnostic.serviceId}:${diagnostic.profileId}`,
              tracked: null,
            }];
          await Promise.all(notificationTargets.map(async (target) => {
            await dispatchConnectedServiceCredentialHealthNotificationAsync({
              settings: settingsSnapshot?.settings ?? null,
              settingsSecretsReadKeys: settingsSnapshot?.settingsSecretsReadKeys ?? [],
              expoPushSender: api.push(),
              listConnectedServiceProfiles: api.listConnectedServiceProfiles.bind(api),
              source: {
                sessionId: target.sessionId,
                sessionTitle: resolveTrackedSessionNotificationTitle(target.tracked),
                serviceId: diagnostic.serviceId,
                profileId: diagnostic.profileId,
                status: healthStatus,
                reason: diagnostic.category ?? diagnostic.status,
                providerStatus: diagnostic.providerStatus ?? null,
                providerErrorCode: diagnostic.providerErrorCode ?? null,
              },
              nowMs: () => Date.now(),
              dedupeWindowMs: resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_CREDENTIAL_HEALTH_NOTIFICATION_DEDUPE_MS,
                60_000,
                { min: 0, max: 24 * 60 * 60_000 },
              ),
            });
          }));
        },
        registerCurrentTargets: registerCurrentConnectedServiceTrackedSessionTargets,
        onTickError: (error) => {
          logger.debug('[DAEMON RUN] Connected services refresh tick failed (non-fatal)', error);
        },
      });
      connectedServiceRefreshCoordinator = refreshStartup.coordinator;
      connectedServiceRefreshLoopHandle = refreshStartup.loopHandle;

      // Triage #4 systemic leg: format+freshness-reconcile stable provider homes (e.g. codex
      // homes, which are not refresh-target bound and otherwise drift stale/malformed) at startup
      // and on a coarse cadence, provider-owned via the lifecycle-descriptor home-maintenance hook.
      if (parseBooleanEnv(process.env.HAPPIER_CONNECTED_SERVICES_STABLE_HOME_RECONCILE_ENABLED, true)) {
        connectedServiceStableHomeReconcileHandle = startConnectedServiceStableHomeReconcileScheduler({
          activeServerDir: configuration.activeServerDir,
          api,
          credentials,
          intervalMs: resolvePositiveIntEnv(
            process.env.HAPPIER_CONNECTED_SERVICES_STABLE_HOME_RECONCILE_INTERVAL_MS,
            15 * 60_000,
            { min: 60_000, max: 6 * 60 * 60_000 },
          ),
          onError: (error) => {
            logger.debug('[DAEMON RUN] Connected services stable-home reconcile failed (non-fatal)', error);
          },
        });
      }

      const connectedServicesQuotasEnabled = await resolveConnectedServicesQuotasDaemonEnabled({
        env: process.env,
        serverUrl: configuration.serverUrl,
        timeoutMs: 1500,
      });
      const quotaGroupFreshnessMs = resolvePositiveIntEnv(
        process.env.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_QUOTA_FRESHNESS_MS,
        5 * 60_000,
        { min: 1_000, max: 60 * 60_000 },
      );
      const createQuotaAuthGroupSwitchCoordinatorForSession = (input: Readonly<{
        sessionId: string;
        switchReason: ConnectedServiceSessionAuthSwitchReason;
        executionAuthority: ConnectedServiceExecutionAuthorityV1;
      }>) => createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator({
        api,
        prepareCandidateForSwitch: prepareAuthGroupCandidateForSwitch,
        runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
        accountUsageStore: providerAccountUsageStore,
        leases: connectedServiceAuthGroupSwitchLeases,
        quotaFreshnessMs: quotaGroupFreshnessMs,
        nowMs: () => Date.now(),
        quotaCoordinator: connectedServiceQuotasCoordinator,
        switchReasonForApplyGeneration: input.switchReason,
        resolveCurrentCredentialRevision: resolveCurrentConnectedServiceCredentialRevision,
        applyConnectedServiceAuthGeneration: buildConnectedServiceApplyAuthGeneration({
          commitAccountSwitchEvents: false,
          deferCorrelatedContinuationSettlement: true,
          executionAuthority: input.executionAuthority,
        }),
        preflightConnectedServiceAuthGeneration: buildConnectedServiceApplyAuthGeneration({
          commitAccountSwitchEvents: false,
          dryRun: true,
          deferCorrelatedContinuationSettlement: true,
          executionAuthority: input.executionAuthority,
        }),
        restartSession: async (restartInput) => {
          const current = getCurrentChildren().find((child) => child.happySessionId === input.sessionId) ?? null;
          if (!current) return;
          const restartSignalDelayMs = resolvePositiveIntEnv(
            process.env.HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_RESTART_SIGNAL_DELAY_MS,
            250,
            { min: 0, max: 5_000 },
          );
          // K5:gated_restart automatic group fallback uses deferral after FSM policy permits restart
          await requestConnectedServiceRestartWithDeferral({
            sessionId: input.sessionId,
            tracked: current,
            source: 'automatic',
            policy: 'defer_until_idle',
            target: normalizeSwitchTarget({
              serviceId: restartInput.serviceId,
              profileId: restartInput.activeProfileId,
              groupId: restartInput.groupId,
              generation: restartInput.generation,
            }),
            restartSignalDelayMs,
            restartDiagnostic: {
              trigger: 'automatic_group_switch',
              sessionId: input.sessionId,
              agentId: resolveTrackedSessionCatalogAgentId(current),
              serviceId: restartInput.serviceId,
              profileId: restartInput.activeProfileId,
              groupId: restartInput.groupId,
              generation: restartInput.generation,
              reason: restartInput.reason ?? 'soft_threshold',
            },
            transcriptEventOwner: 'switch_fsm',
            onSignalFailureLogMessage: '[DAEMON RUN] Failed to restart quota-driven connected-service auth group session',
          });
        },
        emitEvent: (event) => {
          if (!event.success || event.resultStatus !== 'switched') return;
          surfaceConnectedServiceAccountSwitchOutcomeForSession({ sessionId: input.sessionId, event });
        },
      });
      if (connectedServicesQuotasEnabled) {
            const quotasTickMs = resolvePositiveIntEnv(
              process.env.HAPPIER_CONNECTED_SERVICES_QUOTAS_TICK_MS,
              60_000,
              { min: 5_000, max: 30 * 60_000 },
            );
            const {
              fetchTimeoutMs,
              discoveryEnabled,
              discoveryIntervalMs,
              failureBackoffMinMs,
              failureBackoffMaxMs,
              failureBackoffJitterPct,
              loopJitterMs,
              groupSwitchCheckJitterMs,
            } = resolveConnectedServiceQuotasDaemonOptions(process.env);
            const quotaCredentialRefreshWindowMs = resolvePositiveIntEnv(
              process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_WINDOW_MS,
              10 * 60_000,
              { min: 10_000, max: 60 * 60_000 },
            );
            const quotaFetchLeaseMs = resolvePositiveIntEnv(
              process.env.HAPPIER_CONNECTED_SERVICES_QUOTA_FETCH_LEASE_MS,
              30_000,
              { min: 1_000, max: 5 * 60_000 },
            );
            const quotaFetchLeaseContentionWaitMaxMs = resolvePositiveIntEnv(
              process.env.HAPPIER_CONNECTED_SERVICES_QUOTA_FETCH_LEASE_CONTENTION_WAIT_MAX_MS,
              5_000,
              { min: 0, max: 60_000 },
            );
            const groupSwitchCheckMinIntervalMs = resolvePositiveIntEnv(
              process.env.HAPPIER_CONNECTED_SERVICES_QUOTA_GROUP_SWITCH_CHECK_MIN_INTERVAL_MS,
              quotaGroupFreshnessMs,
              { min: 0, max: 30 * 60_000 },
            );
            const quotaFetchers = createConnectedServiceQuotaFetchers(process.env);

            const quotaActivation = await activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration({
              enabled: true,
              quotaFetchers,
              awaitReadiness: async () => {
                const settingsReady = await warmActiveAccountSettingsSnapshotBestEffort({ credentials });
                if (!settingsReady) {
                  throw new Error('Connected-service account settings are unavailable during quota startup');
                }
              },
              hydrate: async ({ serviceIds }) => (
                await hydrateProviderAccountUsageStoreFromConnectedServiceInventory({
                  serviceIds,
                  api,
                  credentials,
                  store: providerAccountUsageStore,
                  nowMs: Date.now(),
                })
              ).hydration,
              createCoordinator: () => new ConnectedServiceQuotasCoordinator({
              api,
              credentials,
              runtimeRegistry: connectedServiceRuntimeRegistry,
              quotaFetchers,
              fetchTimeoutMs,
              discoveryEnabled,
              discoveryIntervalMs,
              failureBackoffMinMs,
              failureBackoffMaxMs,
              failureBackoffJitterPct,
              runtimeQuotaSnapshots: connectedServiceRuntimeQuotaSnapshots,
              accountUsageStore: providerAccountUsageStore,
              accountUsagePersistence: providerAccountUsagePersistence,
              credentialRefreshWindowMs: quotaCredentialRefreshWindowMs,
              machineIdProvider: () => machineId,
              ownerIdProvider: () => `${machineId}:${runtimeId}`,
              quotaFetchLeaseMs,
              quotaFetchLeaseContentionWaitMaxMs,
              quotaPersistenceServerWorkScheduler: daemonServerWorkScheduler,
              quotaPersistenceServerScope: configuration.serverUrl,
              quotaPersistenceMinIntervalMs: resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_QUOTA_IN_BAND_MIN_INTERVAL_MS,
                5_000,
                { min: 0, max: 60_000 },
              ),
              quotaPersistenceMaxKeys: resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_QUOTA_IN_BAND_MAX_KEYS,
                256,
                { min: 1, max: 10_000 },
              ),
              quotaPersistenceMaxKeyAgeMs: resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_QUOTA_IN_BAND_MAX_KEY_AGE_MS,
                60 * 60_000,
                { min: 60_000, max: 24 * 60 * 60_000 },
              ),
              quotaPersistenceMaxPendingPayloadAgeMs: resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_QUOTA_IN_BAND_MAX_PENDING_PAYLOAD_AGE_MS,
                5 * 60_000,
                { min: 1_000, max: 60 * 60_000 },
              ),
              quotaPersistenceMaxConsecutiveFailures: resolvePositiveIntEnv(
                process.env.HAPPIER_CONNECTED_SERVICES_QUOTA_IN_BAND_MAX_CONSECUTIVE_FAILURES,
                5,
                { min: 1, max: 100 },
              ),
              groupSwitchCheckMinIntervalMs,
              groupSwitchCheckJitterMs,
              softSwitchPolicyGuard: async (input) => {
                const tracked = getCurrentChildren().find((child) => child.happySessionId === input.sessionId) ?? null;
                const trackedRuntimePolicy = evaluatePredictiveSoftSwitchTrackedLiveSessionPolicy({
                  reason: input.reason,
                  hasTrackedRuntime: tracked !== null,
                });
                if (trackedRuntimePolicy.status !== 'allow') return trackedRuntimePolicy;
                if (!tracked) return trackedRuntimePolicy;
                const agentId = resolveTrackedSessionCatalogAgentId(tracked);
                const lifecycleDescriptor = await resolveConnectedServiceCredentialLifecycleDescriptor(agentId);
                const policy = evaluatePredictiveSoftSwitchPolicy({
                  context: 'live_session',
                  reason: input.reason,
                  predictiveSoftSwitchMode: lifecycleDescriptor.predictiveSoftSwitch.mode,
                  turnState: connectedServiceTurnDeferralQueue.getTurnLifecycleState(input.sessionId),
                  runtimeAuthApply: lifecycleDescriptor.runtimeAuthApply,
                });
                if (policy.status !== 'allow') return policy;
                return evaluatePredictiveSoftSwitchLiveSessionRequirement({
                  reason: input.reason,
                  requirement: lifecycleDescriptor.predictiveSoftSwitch.liveSessionRequirement,
                  activeServerDir: configuration.activeServerDir,
                  agentId,
                  serviceId: input.serviceId,
                  groupId: input.groupId,
                  activeProfileId: input.activeProfileId,
                  env: tracked.spawnOptions?.environmentVariables ?? {},
                });
              },
              sameAccountFanoutStrategyResolver: async (input) => {
                const tracked = getCurrentChildren().find((child) => child.happySessionId === input.sourceSessionId) ?? null;
                if (!tracked) return 'none';
                const agentId = resolveTrackedSessionCatalogAgentId(tracked);
                const lifecycleDescriptor = await resolveConnectedServiceCredentialLifecycleDescriptor(agentId);
                return lifecycleDescriptor.sameAccountFanoutStrategy;
              },
              runtimeAuthApplyCapabilityResolver: async (input) => {
                const tracked = getCurrentChildren().find((child) => (
                  child.happySessionId === (input.targetSessionId ?? input.sourceSessionId)
                )) ?? null;
                if (!tracked) return { directLiveHotAuth: 'unsupported' };
                const agentId = resolveTrackedSessionCatalogAgentId(tracked);
                const lifecycleDescriptor = await resolveConnectedServiceCredentialLifecycleDescriptor(agentId);
                return lifecycleDescriptor.runtimeAuthApply;
              },
              readRuntimeAccountIdentity: async (input) => await readConnectedServiceRuntimeIdentityForQuotaFanout({
                credentials,
                sessionId: input.sessionId,
                serviceId: input.serviceId,
                groupId: input.groupId,
                profileId: input.profileId,
                expectedGroupGeneration: input.expectedGroupGeneration,
	              }),
              // Durable same-account fanout fallback (codex): when the live runtime-identity probe cannot
              // verify a sibling's account, prove it from PERSISTED artifacts that survive daemon restarts
              // — the session's persisted materialization identity (canonical reader) plus the persisted
              // profile's credential provider-account id (canonical resolver). Best-effort under a bounded
              // timeout: any read failure yields null so the candidate stays suppressed.
              readPersistedSessionAccountIdentity: async (input) => {
                const boundedMs = 2_000;
                const withTimeout = async <T>(work: Promise<T>): Promise<T | null> => {
                  let timer: ReturnType<typeof setTimeout> | null = null;
                  try {
                    return await Promise.race<T | null>([
                      work,
                      new Promise<null>((resolve) => {
                        timer = setTimeout(() => resolve(null), boundedMs);
                        (timer as unknown as { unref?: () => void })?.unref?.();
                      }),
                    ]);
                  } catch {
                    return null;
                  } finally {
                    if (timer) clearTimeout(timer);
                  }
                };
                const tracked = getCurrentChildren().find((child) => child.happySessionId === input.sessionId) ?? null;
                const agentId = tracked ? resolveTrackedSessionCatalogAgentId(tracked) : resolveCatalogAgentId(null);
                // Reuse the canonical persisted-session-metadata reader; require durable evidence the
                // session persists (do NOT introduce a second metadata reader).
                const persistedMetadata = await withTimeout(resolvePersistedConnectedServiceSwitchSessionMetadata({
                  credentials,
                  sessionId: input.sessionId,
                  agentId,
                }));
                if (!persistedMetadata) return null;
                const record = await withTimeout(resolveConnectedServiceCredentials({
                  credentials,
                  api,
                  bindings: [{ serviceId: input.serviceId, profileId: input.profileId }],
                }).then((byServiceId) => byServiceId.get(input.serviceId) ?? null));
                if (!record) return null;
                const providerAccountId = readCredentialAccountIdentity(record)?.providerAccountId ?? null;
                if (!providerAccountId) return null;
                return {
                  providerAccountId,
                  serviceId: input.serviceId,
                  groupId: input.groupId,
                  profileId: input.profileId,
                  groupGeneration: input.expectedGroupGeneration,
                };
              },
	              quotaWorkGate: () => {
	                if (shutdownInitiated || connectedServiceQuotaProducersQuiesced) {
	                  return { status: 'deferred' as const, reason: 'shutdown' };
	                }
	                if (!daemonServerWorkOnline) return { status: 'deferred' as const, reason: 'offline' };
	                const nowMs = Date.now();
                pruneRuntimeAuthRecoveryLocalServerFailures(nowMs);
                const stormCount = runtimeAuthRecoveryLocalServerFailureTimes.length;
                if (stormCount < runtimeAuthRecoveryStormThreshold) return { status: 'open' as const };
                return {
                  status: 'deferred' as const,
                  reason: 'local_server_storm',
                  retryAfterMs: Math.min(
                    runtimeAuthRecoveryMaxBackoffMs,
                    runtimeAuthRecoveryBaseBackoffMs * (2 ** Math.min(6, stormCount - runtimeAuthRecoveryStormThreshold + 1)),
                  ) + runtimeAuthRecoveryJitterMs(),
                };
              },
              recordDiagnostic: (event) => {
                logger.debug('[DAEMON RUN] Connected-service quota diagnostic', event);
              },
              // RD-QUO-13: produce the (previously consumer-only) quota blocked/recovered
              // surfaces from the coordinator's edge-triggered lifecycle transitions —
              // notification topics + provider-quota-wait/recovered transcript events.
              onQuotaLifecycleTransition: async (transition) => {
                const settingsSnapshot = getActiveAccountSettingsSnapshot();
                await dispatchConnectedServiceQuotaLifecycleNotificationAsync({
                  settings: settingsSnapshot?.settings ?? null,
                  settingsSecretsReadKeys: settingsSnapshot?.settingsSecretsReadKeys ?? [],
                  expoPushSender: api.push(),
                  transition,
                }).catch((error) => {
                  logger.debug('[DAEMON RUN] Connected-service quota lifecycle notification failed (non-fatal)', error);
                });
                await commitConnectedServiceQuotaLifecycleSessionEvents({
                  credentials,
                  transition,
                }).catch((error) => {
                  logger.debug('[DAEMON RUN] Connected-service quota lifecycle transcript event failed (non-fatal)', error);
                });
              },
              authGroupSwitchCoordinator: {
                async switchBeforeTurn(input) {
                  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
                  if (!sessionId) return { status: 'session_not_found' };
                  const tracked = getCurrentChildren().find((child) => child.happySessionId === sessionId) ?? null;
                  if (!tracked) return { status: 'session_not_found' };
                  const switchCoordinator = createQuotaAuthGroupSwitchCoordinatorForSession({
                    sessionId,
                    switchReason: 'pre_turn_group_policy',
                    executionAuthority: 'runtime_recovery',
                  });
                  const runProactiveSwitch = async () => {
                    // O3: switch-attempt trace at the proactive-quota decision point (the
                    // cmpn4hhdi seam). Captures trigger, ids, generation, hot-apply-vs-restart
                    // (mode), and the structured result status; deferral state + reachability
                    // result are emitted by the deferral-queue and restart-diagnostic events
                    // respectively when a restart-resume is chosen.
                    const result = await switchCoordinator.switchBeforeTurn(input);
                    logger.debug('[DAEMON RUN] Connected-service proactive quota switch attempt', {
                      trigger: 'automatic_group_switch',
                      decision: 'proactive_quota_switch_before_turn',
                      sessionId,
                      serviceId: input.serviceId,
                      groupId: input.groupId,
                      reason: input.reason,
                      resultStatus: result.status,
                      generation: 'generation' in result ? result.generation : null,
                      mode: 'mode' in result ? result.mode ?? null : null,
                      errorCode: 'errorCode' in result ? result.errorCode : null,
                      routedThroughFsm: true,
                    });
                    return result;
                  };
                  const proactiveSwitchResult = input.deferUntilTurnBoundary === true
                    ? await requestConnectedServiceSwitchBeforeTurnWithDeferral({
                        deferralQueue: connectedServiceTurnDeferralQueue,
                        sessionId,
                        source: 'automatic',
                        policy: 'defer_until_turn_boundary',
                        target: normalizeSwitchTarget({
                          serviceId: input.serviceId,
                          profileId: input.observedProfileId ?? '',
                          groupId: input.groupId,
                          generation: 0,
                        }),
                        runSwitch: runProactiveSwitch,
                        onDeferredSwitchFailure: (error) => {
                          logger.debug('[DAEMON RUN] Deferred connected-service proactive quota switch failed', error);
                        },
                      })
                    : await runProactiveSwitch();
                  if (proactiveSwitchResult.status === 'deferred') {
                    logger.debug('[DAEMON RUN] Connected-service proactive quota switch attempt', {
                      trigger: 'automatic_group_switch',
                      decision: 'proactive_quota_switch_before_turn',
                      sessionId,
                      serviceId: input.serviceId,
                      groupId: input.groupId,
                      reason: input.reason,
                      resultStatus: proactiveSwitchResult.status,
                      generation: null,
                      mode: null,
                      errorCode: null,
                      routedThroughFsm: true,
                      policy: proactiveSwitchResult.policy,
                    });
                  }
                  return proactiveSwitchResult;
                },
                async applyCommittedGeneration(input) {
                  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
                  const tracked = getCurrentChildren().find((child) => child.happySessionId === sessionId) ?? null;
                  if (!sessionId || !tracked) {
                    return {
                      status: 'session_not_found',
                      generation: input.generation,
                      errorCode: 'session_not_found',
                    };
                  }
                  const recipientCoordinator = createQuotaAuthGroupSwitchCoordinatorForSession({
                    sessionId,
                    switchReason: input.reason === 'same_provider_account_exhausted'
                      ? 'automatic_runtime_failure'
                      : 'pre_turn_group_policy',
                    executionAuthority: 'runtime_recovery',
                  });
                  return await recipientCoordinator.applyCommittedGeneration(input);
                },
              },
              consumeCommittedAuthGroupGeneration: async (input) => {
                const consumer = connectedServiceAuthGroupGenerationConsumer;
                if (!consumer) throw new Error('durable_generation_consumer_unavailable');
                return await consumer.consume(input);
              },
              refreshConnectedServiceCredentialForQuota: async (input: Readonly<{
                serviceId: ConnectedServiceId;
                profileId: string;
                force: boolean;
              }>) =>
                connectedServiceRefreshCoordinator?.refreshConnectedServiceCredentialForQuota({
                  serviceId: input.serviceId,
                  profileId: input.profileId,
                  force: input.force,
                }) ?? null,
              now: () => Date.now(),
              randomBytes: (length) => randomBytes(length),
              }),
              startLoop: (coordinator) => {
                registerCurrentConnectedServiceTrackedSessionTargets();
                const loopHandle = startConnectedServiceQuotasLoop({
                  enabled: true,
                  tickMs: quotasTickMs,
                  tickJitterMs: loopJitterMs,
                  coordinator,
                  onTickError: (error) => {
                    logger.debug('[DAEMON RUN] Connected services quotas tick failed (non-fatal)', error);
                  },
                });
                if (!loopHandle) {
                  throw new Error('Connected-service quota loop did not start after successful hydration');
                }
                return loopHandle;
              },
              onActivationError: (error) => {
                logger.warn('[DAEMON RUN] Connected-service quota policy remains disabled because startup hydration failed', {
                  error: serializeAxiosErrorForLog(error),
                });
              },
            });
            if (quotaActivation.status === 'active') {
              connectedServiceQuotasCoordinator = quotaActivation.coordinator;
              connectedServiceQuotasLoopHandle = quotaActivation.loopHandle;
            }
          }

      const continueAfterExactConnectedServiceGenerationApplication = async (input: Readonly<{
        sessionId: string;
        target: Readonly<{
          serviceId: ConnectedServiceId;
          groupId: string;
          profileId: string;
          generation: number;
        }>;
      }>): Promise<void> => {
        const correlationKey = {
          sessionId: input.sessionId,
          serviceId: input.target.serviceId,
          groupId: input.target.groupId,
          profileId: input.target.profileId,
          generation: input.target.generation,
        };
        await connectedServiceContinuationApplicationCorrelation.settle(
          correlationKey,
          async (correlatedContinuation) => {
            const normalizedBindings = {
              v: 1,
              bindingsByServiceId: {
                [input.target.serviceId]: {
                  source: 'connected',
                  selection: 'group',
                  groupId: input.target.groupId,
                  profileId: input.target.profileId,
                },
              },
            } satisfies ConnectedServiceBindingsV1;
            const serviceIds = new Set<ConnectedServiceId>([input.target.serviceId]);
            const attemptId = buildConnectedServiceSwitchContinuationAttemptId({
              action: 'hot_applied',
              serviceIds,
              normalizedBindings,
              expectedGroupGenerationByServiceId: {
                [input.target.serviceId]: input.target.generation,
              },
            });
            await createConnectedServiceContinuationHandler({
              credentials,
              ...correlatedContinuation,
              resolveInterruption: () => 'provider_failed_turn',
            })({
              sessionId: input.sessionId,
              attemptId,
              action: 'hot_applied',
              switchReason: 'automatic_runtime_failure',
            });
          },
        );
      };

      connectedServiceAuthGroupGenerationConsumer = new ConnectedServiceAuthGroupGenerationConsumer({
        notifyCurrentGroupTruth: createConnectedServiceCurrentGroupTruthNotifier({
          applyRequestTimeBrokerCurrentTruth: async (input) => {
            if (input.applicationOwnerId !== 'opencode' && input.applicationOwnerId !== 'pi') return null;
            const runtimeTarget = connectedServiceRuntimeRegistry.getBySessionId(input.sessionId);
            const selectionIdentity = runtimeTarget?.brokerSelectionIdentity ?? null;
            if (!selectionIdentity || input.isCurrent?.() === false) {
              return { ok: false, errorCode: 'broker_selection_identity_unavailable' };
            }
            if (input.currentTruth.kind === 'current_auth_group_unavailable') {
              markBrokerBridgeEffectiveSelectionUnavailable({
                selectionIdentity,
                serviceId: input.serviceId,
                groupId: input.currentTruth.groupId,
                unavailableReason: input.currentTruth.unavailableReason,
              });
              return { ok: true };
            }
            return isBrokerBridgeCurrentGroupTruthCompatible({
              selectionIdentity,
              serviceId: input.serviceId,
              groupId: input.currentTruth.groupId,
              generation: input.currentTruth.generation,
              credentialRevision: input.currentTruth.credentialRevision,
            })
              ? { ok: true }
              : { ok: false, errorCode: 'broker_current_truth_not_applied' };
          },
          resolveTransport: async (sessionId) => {
            const transport = await resolveSessionTransportContext({ credentials, idOrPrefix: sessionId });
            return transport.ok ? transport : null;
          },
          callRpc: async ({ transport, method, request }) => await callSessionRpc({
            token: credentials.token,
            sessionId: transport.sessionId,
            ctx: transport.ctx,
            mode: transport.mode,
            method,
            request,
          }),
        }),
        applySharedGenerationApplication: async (input) => {
          const target = input.committedGeneration.decisionCommittedTarget;
          const credentialRevision = target.credentialRevision;
          if (credentialRevision === null) {
            return { reconciliationDisposition: 'failed', errorCode: 'credential_revision_missing' };
          }
          const descriptor = await resolveConnectedServiceCredentialLifecycleDescriptor(
            input.applicationOwnerId as CatalogAgentId,
          );
          if (!descriptor.applySharedGenerationApplication) {
            return { reconciliationDisposition: 'failed', errorCode: 'shared_generation_application_unavailable' };
          }
          const resolved = await resolveConnectedServiceCredentialsWithRevisions({
            credentials,
            api,
            bindings: [{ serviceId: target.serviceId, profileId: target.profileId }],
          }).then((byServiceId) => byServiceId.get(target.serviceId) ?? null).catch(() => null);
          if (!resolved || resolved.credentialRevision !== credentialRevision) {
            return { reconciliationDisposition: 'failed', errorCode: 'credential_revision_superseded' };
          }
          const proof = await descriptor.applySharedGenerationApplication({
            activeServerDir: configuration.activeServerDir,
            serviceId: target.serviceId,
            groupId: target.groupId,
            profileId: target.profileId,
            generation: target.generation,
            credentialRevision,
            record: resolved.record,
            validateCurrentBeforeMutation: async () => await validateConnectedServiceGroupMutationCurrentness({
              serviceId: target.serviceId,
              groupId: target.groupId,
              profileId: target.profileId,
              generation: target.generation,
              credentialRevision,
            }),
          }).catch(() => ({ status: 'unavailable' as const }));
          if (proof.status === 'superseded_after_apply') {
            return mapCommittedGenerationApplyResult({
              committedGeneration: input.committedGeneration,
              result: {
                status: 'superseded_after_apply',
                activeProfileId: proof.activeProfileId,
                generation: proof.generation,
                credentialRevision: proof.credentialRevision,
              },
            });
          }
          if (proof.status !== 'verified' || proof.credentialRevision !== credentialRevision) {
            return { reconciliationDisposition: 'failed', errorCode: 'shared_generation_application_unverified' };
          }
          return {
            reconciliationDisposition: 'converged',
            errorCode: null,
            providerAdoptedTarget: {
              ...target,
              proof: {
                ...proof,
                status: 'verified',
              },
            },
          };
        },
        applyCommittedGeneration: async (input) => {
          const tracked = getCurrentChildren().find((child) => child.happySessionId === input.sessionId) ?? null;
          if (!tracked) {
            return { reconciliationDisposition: 'failed', errorCode: 'session_not_found' };
          }
          const target = input.committedGeneration.decisionCommittedTarget;
          const coordinator = createQuotaAuthGroupSwitchCoordinatorForSession({
            sessionId: input.sessionId,
            switchReason: input.switchReason,
            executionAuthority: input.executionAuthority,
          });
          const result = await coordinator.applyCommittedGeneration({
            sessionId: input.sessionId,
            serviceId: target.serviceId,
            groupId: target.groupId,
            activeProfileId: target.profileId,
            generation: target.generation,
            credentialRevision: target.credentialRevision,
            reason: input.committedGeneration.provenance,
            fromProfileId: input.fromProfileId,
          });
          const mapped = mapCommittedGenerationApplyResult({
            committedGeneration: input.committedGeneration,
            result,
          });
          return mapped;
        },
        settleExactRecipientApplication: async ({ sessionId, providerAdoptedTarget }) => {
          const settledRuntimeTarget = connectedServiceRuntimeRegistry.adoptExactGroupApplicationForSession({
            sessionId,
            serviceId: providerAdoptedTarget.serviceId,
            groupId: providerAdoptedTarget.groupId,
            profileId: providerAdoptedTarget.profileId,
            generation: providerAdoptedTarget.generation,
            credentialRevision: providerAdoptedTarget.credentialRevision,
          });
          if (!settledRuntimeTarget) {
            throw new Error('connected-service exact recipient runtime binding unavailable');
          }
        },
        continueAfterExactRecipientApplication: async ({ sessionId, providerAdoptedTarget }) => {
          await continueAfterExactConnectedServiceGenerationApplication({
            sessionId,
            target: providerAdoptedTarget,
          }).catch((error) => {
            logger.warn('[DAEMON RUN] Exact connected-service application settled but continuation enqueue failed', {
              sessionId,
              serviceId: providerAdoptedTarget.serviceId,
              groupId: providerAdoptedTarget.groupId,
              profileId: providerAdoptedTarget.profileId,
              generation: providerAdoptedTarget.generation,
              error: serializeAxiosErrorForLog(error),
            });
          });
        },
        verifySharedGenerationApplication: async (input) => {
          const runtimeTarget = connectedServiceRuntimeRegistry.getBySessionId(input.sessionId);
          if (!runtimeTarget) return null;
          const desired = input.committedGeneration.decisionCommittedTarget;
          const currentBinding = runtimeTarget.activeBindings.find((binding) => (
            binding.serviceId === desired.serviceId
            && binding.groupId === desired.groupId
          ));
          if (!currentBinding) return null;
          const registration: ConnectedServiceRuntimeTargetRegistration = {
            key: { kind: 'session', pid: runtimeTarget.pid },
            target: runtimeTarget,
          };
          const desiredBinding: RuntimeGenerationApplicationProofTarget['activeBindings'][number] = {
            ...currentBinding,
            profileId: desired.profileId,
            generation: desired.generation,
            credentialRevision: desired.credentialRevision,
            credentialFingerprint: null,
          };
          const proofs = await resolveRuntimeGenerationApplicationProofs({
            ...runtimeTarget,
            activeBindings: [desiredBinding],
          }, {
            isCurrent: (binding) => binding === desiredBinding
              && connectedServiceRuntimeRegistry.isCurrentTargetRegistration(registration)
              && runtimeTarget.activeBindings.some((candidate) => candidate === currentBinding),
          });
          return proofs.find((proof) => (
            proof.serviceId === desired.serviceId
            && proof.groupId === desired.groupId
            && proof.profileId === desired.profileId
            && proof.generation === desired.generation
            && proof.credentialRevision === desired.credentialRevision
            && proof.proof.credentialRevision === desired.credentialRevision
          )) ?? null;
        },
        resolveGenerationApplicationScope: async (input) => {
          const tracked = getCurrentChildren().find((child) => child.happySessionId === input.sessionId) ?? null;
          return await resolveConnectedServiceGenerationApplicationScope(
            input.serviceId,
            tracked ? resolveTrackedSessionCatalogAgentId(tracked) : input.applicationOwnerId as CatalogAgentId | null,
          );
        },
      });
      const machineRegistrationTimeoutMs = resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_TIMEOUT_MS,
        10_000,
        { min: 250, max: 120_000 },
      );
      const machineRegistrationRetryBaseDelayMs = resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_BASE_DELAY_MS
          ?? process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_DELAY_MS,
        10_000,
        { min: 0, max: 5 * 60_000 },
      );
      const machineRegistrationRetryMaxDelayMs = resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_MAX_DELAY_MS,
        5 * 60_000,
        { min: 0, max: 30 * 60_000 },
      );
      const machineRegistrationRetryJitterMs = resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_RETRY_JITTER_MS,
        1_000,
        { min: 0, max: 60_000 },
      );
      const machineRegistrationRetryEffectiveMaxDelayMs = Math.max(
        machineRegistrationRetryBaseDelayMs,
        machineRegistrationRetryMaxDelayMs,
      );
      const machineRegistrationMaxAttempts = resolvePositiveIntEnv(
        process.env.HAPPIER_DAEMON_MACHINE_REGISTRATION_MAX_ATTEMPTS,
        0,
        { min: 0, max: 10_000 },
      );

      // Do machine bootstrap in the background so shutdown requests are not blocked by /v1/machines latency.
      void (async () => {
        let attempts = 0;
        while (!shutdownInitiated) {
          try {
            const ensured = preflightMachineRegistration ?? await ensureMachineRegistered({
              api,
              machineId,
              metadata: metadataForRegistration,
              daemonState: initialDaemonState,
              timeoutMs: machineRegistrationTimeoutMs,
              caller: 'startDaemon',
            });
            preflightMachineRegistration = null;
            if (shutdownInitiated) {
              return;
            }
            const ensuredMachineId = ensured.machineId;
            if (fileState.machineId !== ensuredMachineId) {
              const nextState: DaemonLocallyPersistedState = {
                ...fileState,
                machineId: ensuredMachineId,
              };
              if (!writeDaemonStateIfLockOwned(nextState)) {
                return;
              }
              fileState.machineId = ensuredMachineId;
            }
            machineId = ensuredMachineId;
            const machine = ensured.machine;
            logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);

            // Create realtime machine session
            const connectedApiMachine = diagnosticSubsystemGates.disableMachineSync
              ? null
              : api.machineSyncClient(machine, {
                  runtimeId,
                  cliVersion: packageJson.version,
                  publicReleaseChannel: getReleaseRingCatalogEntry(configuration.publicReleaseRing).publicLabel,
                  startupSource,
                  serviceManaged: isDaemonStartupSourceServiceManaged(startupSource),
                  ...(serviceLabel ? { serviceLabel } : null),
                });
            apiMachine = connectedApiMachine;
            apiMachineForSessions = connectedApiMachine;
            await reconcileSessionMachineAccessBindings();

            // Set RPC handlers
            if (diagnosticSubsystemGates.disableAutomationWorker) {
              logger.warn('[DAEMON RUN] Diagnostic gate enabled: automation worker disabled');
            } else {
              automationWorker = startAutomationWorker({
                token: credentials.token,
                machineId,
                encryption: credentials.encryption,
                spawnSession,
              });
            }

            memoryWorker = await (async () => {
              try {
                return await startMemoryWorker({
                  credentials,
                  machineId,
                });
              } catch (error) {
                logger.warn('[DAEMON RUN] Failed to start memory worker (best-effort)', error);
                return null;
              }
            })();

            if (connectedApiMachine) {
              await connectedApiMachine.recoverDaemonTerminalSessionMutationJournals().catch((error) => {
                logger.warn('[DAEMON RUN] Failed to recover daemon terminal mutation journals at startup', {
                  error: serializeAxiosErrorForLog(error),
                });
              });
              connectedApiMachine.onConnectedServicesProjectionChange((notification) => {
                const reconciliation = connectedServiceGenerationReconciliationTail.then(async () => {
                  notification.signal.throwIfAborted();
                  const projectionSnapshot = parseConnectedServiceProjectionSnapshot({
                    connectedServicesV2: notification.connectedServicesV2,
                    connectedServiceCredentialRevisionsV1: notification.connectedServiceCredentialRevisionsV1,
                  });
                  notification.signal.throwIfAborted();
                  const projectionDelta = diffConnectedServiceProjectionSnapshots(
                    connectedServiceProjectionReconciliationBaseline,
                    projectionSnapshot,
                  );
                  const isInitialProjection = connectedServiceProjectionReconciliationBaseline === null;
                  if (
                    isInitialProjection
                    || projectionDelta.changedGroupScopes.length > 0
                    || projectionDelta.changedCredentialBoundaries.length > 0
                  ) {
                    connectedServiceProjectionEpoch += 1;
                  }
                  latestConnectedServiceProjectionSnapshot = projectionSnapshot;
                  const projectionRegistrations = connectedServiceRuntimeRegistry.listTargetRegistrations();
                  // Changed projection scopes are owned by the global reconcilers below. The
                  // registration sweep is only for an unchanged replay, where a late/re-registered
                  // runtime still needs current truth without duplicating group effects or notices.
                  if (
                    projectionDelta.changedGroupScopes.length === 0
                    && projectionDelta.changedCredentialBoundaries.length === 0
                  ) {
                    for (const registration of projectionRegistrations) {
                      notification.signal.throwIfAborted();
                      await reconcileConnectedServiceRuntimeTargetRegistrationNow(
                        registration,
                        projectionSnapshot,
                        notification.signal,
                      );
                    }
                  }
                  if (projectionDelta.changedGroupScopes.length > 0) {
                    await reconcileConnectedServiceAuthGroupGenerations({
                      consumer: connectedServiceAuthGroupGenerationConsumer,
                      listCurrentGroups: async (serviceId) => projectionSnapshot.groups.filter((group) => group.serviceId === serviceId),
                      resolveCredentialRevision: projectionSnapshot.resolveCredentialRevision,
                      listRuntimeTargets: () => projectionRegistrations.map((registration) => registration.target),
                      isCurrentRuntimeTarget: (target) => projectionRegistrations.some((registration) => (
                        registration.target === target
                        && connectedServiceRuntimeRegistry.isCurrentTargetRegistration(registration)
                      )),
                      executionAuthority: notification.executionAuthority,
                      groupScopes: projectionDelta.changedGroupScopes,
                      signal: notification.signal,
                    });
                  }
                  notification.signal.throwIfAborted();
                  if (projectionDelta.changedCredentialBoundaries.length > 0) {
                    await reconcileConnectedServiceDirectCredentialRevisions({
                      credentialBoundaries: projectionDelta.changedCredentialBoundaries,
                      listRuntimeTargets: () => projectionRegistrations.map((registration) => registration.target),
                      isCurrentRuntimeTarget: (target) => projectionRegistrations.some((registration) => (
                        registration.target === target
                        && connectedServiceRuntimeRegistry.isCurrentTargetRegistration(registration)
                      )),
                      applyLiveCredentialBoundary: async (input) => {
                        if (!connectedServiceRefreshCoordinator) return;
                        await connectedServiceRefreshCoordinator.handleExternalCredentialUpdate(input);
                      },
                      executionAuthority: notification.executionAuthority,
                      signal: notification.signal,
                    });
                  }
                  notification.signal.throwIfAborted();
                  // The global changed-scope owners just reconciled every currently registered
                  // target. Stamp their exact current objects only after all work succeeds so an
                  // identical replay is a no-op, while rejection leaves both epoch and projection
                  // baseline eligible for retry.
                  for (const registration of projectionRegistrations) {
                    if (connectedServiceRuntimeRegistry.isCurrentTargetRegistration(registration)) {
                      lastReconciledProjectionEpochByRuntimeTarget.set(
                        registration.target,
                        connectedServiceProjectionEpoch,
                      );
                    }
                  }
                  connectedServiceProjectionReconciliationBaseline = projectionSnapshot;
                });
                connectedServiceGenerationReconciliationTail = reconciliation.catch(() => {});
                return reconciliation;
              });
              connectedApiMachine.setRPCHandlers({
                spawnSession,
                spawnSessionForHandoff: spawnSession,
                resolveSpawnSessionByNonce: resolveDaemonSpawnSessionByNonce,
                abandonSpawnSessionByNonce: async (spawnNonce) => await abandonSpawnedSessionUntilCompleted({
                  spawnNonce,
                  resolveSpawnSessionByNonce: resolveDaemonSpawnSessionByNonce,
                  archiveSession: async (sessionId) => {
                    const archived = await setSessionArchivedState({
                      credentials,
                      idOrPrefix: sessionId,
                      archived: true,
                    });
                    return archived.ok && archived.archivedAt !== null;
                  },
                }),
                stopSession,
                isSessionActive: isSessionAlreadyRunning,
                loadLocalSessionMetadata: loadLocalSessionMetadataForHandoff,
                requestShutdown: () => {
                  void beforeShutdown().finally(() => requestShutdown('happier-app'));
                },
                ...(memoryWorker ? { memory: memoryWorker } : {}),
                daemonServerWorkScheduler,
                machineTransferChannel: {
                  onEnvelope: (listener) => connectedApiMachine.onMachineTransferEnvelope(listener),
                  sendEnvelope: (payload) => connectedApiMachine.sendMachineTransferEnvelope(payload),
                },
                ...(directPeerRegistry
                  ? {
                      directPeerTransfer: {
                        publishTransfer: ({ transferId, payload: _payload, payloadSource, onDemandScope }) => {
                          if (!payloadSource) {
                            throw new Error('Direct peer handoff publish requires a file-backed payload source');
                          }
                          return directPeerRegistry!.publishTransfer({
                            transferId,
                            payloadSource,
                            ...(onDemandScope ? { onDemandScope } : {}),
                          }).endpointCandidates;
                        },
                        requestPayloadFile: async ({ transferId, endpointCandidates, destinationPath, openBody, timeoutMs, onProgress }) =>
                          await requestDirectPeerTransferToFile({
                            transferId,
                            endpointCandidates,
                            destinationPath,
                            ...(openBody !== undefined ? { openBody } : {}),
                            ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
                            ...(onProgress ? { onProgress } : {}),
                          }),
                        clearPublishedTransfer: (transferId) => directPeerRegistry!.clearPublishedTransfer(transferId),
                      },
                    }
                  : {}),
              }, {
                resumeInactiveSessionWhenUsageLimitReady: async ({ sessionId, rawSession, metadata }) =>
                  await resumeInactiveSessionWhenUsageLimitReady({
                    spawnSession,
                    fallbackMachineId: machineId,
                    sessionId,
                    rawSession,
                    metadata,
                }),
                scheduleInactiveSessionUsageLimitRecoveryCheck: ({ sessionId, recovery, runCheckNow }) => {
                  inactiveUsageLimitRecoveryCheckOwner.schedule({
                    sessionId,
                    recovery,
                    runCheckNow,
                    scheduler: inactiveUsageLimitRecoveryScheduler,
                    onPersistenceError: (error) => {
                      logger.warn('[DAEMON RUN] Failed to schedule inactive usage-limit recovery check', {
                        sessionId,
                        error: serializeAxiosErrorForLog(error),
                      });
                    },
                  });
                },
                cancelInactiveSessionUsageLimitRecoveryCheck: ({
                  sessionId,
                  issueFingerprint,
                  armedAtMs,
                  runtimeAuthRecoveryAttemptId,
                }) => {
                  void inactiveUsageLimitRecoveryCheckOwner.cancelExact({
                    sessionId,
                    issueFingerprint,
                    armedAtMs,
                    ...(runtimeAuthRecoveryAttemptId ? { runtimeAuthRecoveryAttemptId } : {}),
                    scheduler: inactiveUsageLimitRecoveryScheduler,
                  }).catch((error) => {
                    logger.warn('[DAEMON RUN] Failed to cancel inactive usage-limit recovery check', {
                      sessionId,
                      error: serializeAxiosErrorForLog(error),
                    });
                  });
                },
                // QAE-1: user wait-resume cancel must clear the daemon runtime-auth
                // recovery store too (shared owner clears both stores).
                cancelConnectedServiceRuntimeAuthRecovery: cancelConnectedServiceUsageLimitWaitResumeForSession,
                notifyConnectedServiceRuntimeAuthFailure: async ({ sessionId, switchesThisTurn, classification }) => ({
                  ok: true as const,
                  result: await handleConnectedServiceRuntimeAuthRecovery({
                    sessionId,
                    switchesThisTurn: switchesThisTurn ?? 0,
                    classification: classification as ConnectedServiceRuntimeFailureClassification,
                  }),
                }),
                retryTemporaryThrottleNow: async ({ sessionId }) =>
                  await temporaryThrottleRecoveryScheduler.retryNow({ sessionId }),
              });

              connectedApiMachine.onUpdate((update) => {
                if (!automationWorker) return false;
                const t = (update?.body as any)?.t;
                if (t === 'automation-assignment-updated' || t === 'automation-run-updated') {
                  automationWorker.handleServerUpdate(update);
                  return true;
                }
                return false;
              });

              connectedApiMachine.onUpdate((update) => {
                const settingsVersion = readAccountSettingsChangedHintVersion(update);
                if (settingsVersion === null) return false;

                void refreshDaemonAccountSettingsForHint({ credentials, settingsVersion }).catch((error) => {
                  logger.warn('[DAEMON RUN] Failed to refresh account settings from live hint', error);
                });
                return true;
              });

              connectedApiMachine.onAccountSettingsVersionHint(async (hint) => {
                await refreshDaemonAccountSettingsForHint({
                  credentials,
                  settingsVersion: hint.settingsVersion,
                });
              });

              connectedApiMachine.onPendingSessionActivationHint(async (hint) => {
                const result = await activatePendingInactiveSession({
                  credentials,
                  machineId,
                  sessionId: hint.sessionId,
                  requestId: hint.requestId,
                  pendingVersion: hint.pendingVersion,
                  spawnSession: async (options) => await spawnSession(options),
                });
                if (result.status === 'rejected') {
                  logger.warn('[DAEMON RUN] Exact inactive Pending activation was rejected; Pending custody retained', {
                    sessionId: hint.sessionId,
                    requestId: hint.requestId,
                    source: hint.source,
                    reason: result.reason,
                  });
                }
              });

              daemonConnectivityCoordinator = createDaemonConnectivityCoordinator({
                resources: [
                  ...(automationWorker
                    ? [{
                      name: 'automationWorker',
                      pause: () => automationWorker!.pause(),
                      resume: () => automationWorker!.resume(),
                    }]
                    : []),
                  ...(connectedServiceQuotasLoopHandle
                    ? [{
                      name: 'connectedServiceQuotasLoop',
                      pause: () => connectedServiceQuotasLoopHandle!.pause(),
                      resume: () => connectedServiceQuotasLoopHandle!.resume(),
                    }]
                    : []),
                  ...(connectedServiceRefreshLoopHandle
                    ? [{
                      name: 'connectedServiceRefreshLoop',
                      pause: () => connectedServiceRefreshLoopHandle!.pause(),
                      resume: () => connectedServiceRefreshLoopHandle!.resume(),
                    }]
                    : []),
                ],
              });

              machineConnectionStateCleanup = connectedApiMachine.onConnectionStateChange((state) => {
                daemonServerWorkOnline = state.phase === 'online';
                if (daemonServerWorkOnline) {
                  connectedServiceQuotasCoordinator?.notifyQuotaPersistenceConnectivityChanged();
                }
                void daemonConnectivityCoordinator!.applyState(state).catch((error) => {
                  logger.warn('[DAEMON RUN] Failed to apply daemon connectivity state', error);
                });
              });

              let didRefreshMachineMetadata = false;
              connectedApiMachine.connect({
                takeover: takeoverRequested,
                onConnect: async () => {
                  if (shutdownInitiated) return;

                  await reconcileSessionMachineAccessBindings();

                  // FIX-1a (incident Jun-11 H-A): keep the account-settings snapshot fresh on
                  // (re)connect. Cheap no-op when a scope-matching snapshot is already active;
                  // populates it when the startup warm-up failed (e.g. started offline).
                  void warmActiveAccountSettingsSnapshotBestEffort({ credentials });

                  if (automationWorker) {
                    await automationWorker.refreshAssignments().catch((error) => {
                      logger.warn('[DAEMON RUN] Failed to refresh automation assignments on machine reconnect', error);
                    });
                  }

                  if (didRefreshMachineMetadata) return;
                  didRefreshMachineMetadata = true;
                  // Keep machine metadata fresh without clobbering user-provided fields (e.g. displayName) that may exist.
                  await connectedApiMachine.updateMachineMetadata((metadata) => {
                    const base = (metadata ?? machine.metadata ?? {}) as Partial<MachineMetadata>;
                    return refreshMachineMetadataForCurrentDaemon(base, preferredHost);
                  }).catch((error) => {
                    didRefreshMachineMetadata = false;
                    logger.warn('[DAEMON RUN] Failed to refresh machine metadata on reconnect', error);
                  });
                },
                onOwnershipConflict: () => {
                  logger.warn('[DAEMON RUN] Machine server ownership conflict detected; shutting down');
                  requestShutdown('happier-app');
                },
                onMachineReplaced: () => {
                  logger.warn('[DAEMON RUN] Machine identity was replaced on the server; shutting down');
                  requestShutdown('happier-app');
                },
              });

              void publishStartupOrphanedSessionEnds(connectedApiMachine).catch((error) => {
                logger.warn('[DAEMON RUN] Failed to stage orphaned startup session exits', {
                  error: serializeAxiosErrorForLog(error),
                });
              });
              void superviseStartupDisconnectedTerminalHosts(connectedApiMachine);
            } else {
              logger.warn('[DAEMON RUN] Diagnostic gate enabled: machine sync disabled');
            }

            return;
          } catch (error) {
            if (!shouldRetryMachineRegistrationError(error)) {
              logger.warn('[DAEMON RUN] Machine registration rejected (non-retryable); giving up', {
                ...(isMachineContentPublicKeyMismatchError(error) ? { reason: error.reason } : {}),
                ...(serializeAxiosErrorForLog(error) as any),
              });
              return;
            }

            attempts += 1;
            if (machineRegistrationMaxAttempts > 0 && attempts >= machineRegistrationMaxAttempts) {
              logger.warn('[DAEMON RUN] Machine registration failed too many times; giving up', {
                attempt: attempts,
              });
              return;
            }

            const retryDelayMs = Math.min(
              machineRegistrationRetryEffectiveMaxDelayMs,
              computeRestartDelayMs({
                attempt: attempts,
                baseDelayMs: machineRegistrationRetryBaseDelayMs,
                maxDelayMs: machineRegistrationRetryEffectiveMaxDelayMs,
                jitterMs: machineRegistrationRetryJitterMs,
                random: () => Math.random(),
              }),
            );

            // IMPORTANT: Do not log raw Axios errors here; they can contain bearer tokens.
            logger.warn(
              '[DAEMON RUN] Machine registration unavailable; retrying',
              {
                attempt: attempts,
                retryDelayMs,
                error: serializeAxiosErrorForLog(error),
              },
            );

            if (shutdownInitiated) {
              return;
            }

            const sleepResult = await sleepMsOrShutdown(retryDelayMs, resolvesWhenShutdownRequested);
            if (sleepResult === 'shutdown') {
              return;
            }
          }
        }
      })();

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const restartOnStaleVersionAndHeartbeat = startDaemonHeartbeatLoop({
      pidToTrackedSession,
      spawnResourceCleanupByPid,
      sessionAttachCleanupByPid,
      getApiMachineForSessions: () => apiMachineForSessions,
      onChildExited,
      controlPort,
      fileState,
      currentCliVersion: configuration.currentCliVersion,
      requestShutdown,
      isShuttingDown: () => shutdownInitiated,
      requestSelfRestart: async (selfRestartParams) =>
        await requestDaemonSelfRestartWithLockHandoff({
          getCurrentDaemonLockHandle: () => daemonLockHandle,
          setCurrentDaemonLockHandle: (lockHandle) => {
            daemonLockHandle = lockHandle;
          },
          releaseDaemonLock,
          acquireDaemonLock: () => acquireDaemonLock(5, 200),
          requestShutdown,
          selfRestartParams,
        }),
    });

            // Setup signal handlers
                const cleanupAndShutdown = async (source: 'happier-app' | 'happier-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
          shutdownInitiated = true;
          eventLoopStallMonitor.stop();
          connectedServiceTurnDeferralQueue.cancelAll('daemon_shutdown');
          // Lane F: stop exposing turn-in-flight state once the queue is torn down so a tearing-down
          // daemon never reports a stale in-flight turn to the managed-server release path.
          setOpenCodeConnectedServiceInFlightTurnProvider(null);
          // Stop runtime-auth recovery timers so live-daemon recovery work cannot fire a
          // switch/restart into a tearing-down daemon. Daemon restart intentionally drops these
          // in-memory recovery intents.
          runtimeAuthRecoveryScheduler?.dispose();
          temporaryThrottleRecoveryScheduler.dispose();
          const exitCode = getDaemonShutdownExitCode(source);
          const shutdownWatchdog = setTimeout(async () => {
            logger.debug(`[DAEMON RUN] Shutdown timed out, forcing exit with code ${exitCode}`);
            await new Promise((resolve) => setTimeout(resolve, 100));
            process.exit(exitCode);
          }, getDaemonShutdownWatchdogTimeoutMs());
          shutdownWatchdog.unref?.();

          logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

          // Clear health check interval
          if (restartOnStaleVersionAndHeartbeat) {
            clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }

      // Clear daemon.state.json early in shutdown so callers observing "stop" don't race a later
      // heartbeat tick or long tail cleanup work (and to satisfy daemon stop integration tests).
      try {
        const didClearOwnedDaemonState = await clearDaemonState({
          expectedOwner: {
            pid: fileState.pid,
            startedAt: fileState.startedAt,
          },
        });
        if (didClearOwnedDaemonState) {
          publishedDaemonStateOwner = null;
        }
        logger.debug(
          didClearOwnedDaemonState
            ? '[DAEMON RUN] Daemon state file removed'
            : '[DAEMON RUN] Daemon state file preserved because shutdown no longer owns the publication',
        );
      } catch (error) {
        logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
      }
      try {
        await beforeShutdown();
      } catch (error) {
        logger.warn('[DAEMON RUN] Before-shutdown work failed during cleanup', serializeAxiosErrorForLog(error));
      }
      if (connectedServiceRefreshLoopHandle) {
        connectedServiceRefreshLoopHandle.stop();
        connectedServiceRefreshLoopHandle = null;
      }
      if (connectedServiceStableHomeReconcileHandle) {
        connectedServiceStableHomeReconcileHandle.stop();
        connectedServiceStableHomeReconcileHandle = null;
      }
      if (connectedServiceQuotasLoopHandle) {
        await connectedServiceQuotasLoopHandle.stop();
        connectedServiceQuotasLoopHandle = null;
      }
      if (connectedServiceMaterializedHomeCleanupLoopHandle) {
        connectedServiceMaterializedHomeCleanupLoopHandle.stop();
        connectedServiceMaterializedHomeCleanupLoopHandle = null;
      }
      connectedServiceQuotasCoordinator?.dispose();
      connectedServiceQuotasCoordinator = null;
      connectedServiceRuntimeRegistrationCleanup();
      providerAccountUsagePersistence.dispose();

      if (apiMachine) {
        machineConnectionStateCleanup?.();
        machineConnectionStateCleanup = null;
          const daemonStateUpdateTimeoutMs = resolvePositiveIntEnv(
            process.env.HAPPIER_DAEMON_SHUTDOWN_STATE_UPDATE_TIMEOUT_MS,
            250,
            { min: 50, max: 30_000 },
          );

          await publishShutdownStateBestEffort({
            apiMachine,
            source,
            timeoutMs: daemonStateUpdateTimeoutMs,
            warn: (message, error) => {
              if (error !== undefined) {
                logger.warn(message, error);
                return;
              }
              logger.warn(message);
            },
          });
      }
      if (automationWorker) {
        automationWorker.stop();
      }
      if (memoryWorker) {
        memoryWorker.stop();
      }

      // Best-effort cleanup for provider-managed background processes (e.g. shared OpenCode server).
      // Important: do not tear down shared provider background processes while session runners are still
      // tracked by this daemon. Some harnesses stop the daemon while externally-started sessions are
      // still live (e.g. in-flight provider tests). Killing the shared OpenCode server in that state
      // can wedge or abort those sessions mid-turn.
      if (pidToTrackedSession.size === 0) {
        try {
          const { stopSharedManagedOpenCodeServerFromEnvBestEffort } = await import('@/backends/opencode/server/sharedManagedServer');
          await stopSharedManagedOpenCodeServerFromEnvBestEffort();
        } catch {
          // best-effort only
        }
      }

      await stopDirectPeerServer();
      await stopControlServer();
          await stopCaffeinate();
          if (daemonLockHandle) {
            await releaseDaemonLock(daemonLockHandle);
          }

          logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
          clearTimeout(shutdownWatchdog);
          process.exit(exitCode);
        };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    if (daemonLockHandle) {
      if (publishedDaemonStateOwner) {
        try {
          await clearDaemonState({
            expectedOwner: publishedDaemonStateOwner,
          });
          publishedDaemonStateOwner = null;
        } catch {
          // The process is terminating; lock release must still run so a later daemon can recover.
        }
      }
      try {
        await releaseDaemonLock(daemonLockHandle);
      } catch {
        // ignore
      }
    }
    if (error instanceof DaemonOwnershipConflictError) {
      process.exit(resolveDaemonOwnershipConflictExitCode(startupSource, error.owner));
    }
    if (error instanceof DaemonStartupConflictError) {
      process.exit(1);
    }
    // IMPORTANT: Do not log raw Axios errors here; they can contain bearer tokens.
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', serializeAxiosErrorForLog(error));
    process.exit(1);
  }
}

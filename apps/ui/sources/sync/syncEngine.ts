import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { buildSessionOrganizationLabelKey } from '@/sync/domains/session/organization/keys';
import { readSessionOrganizationWorkspaceLabel } from '@/sync/domains/session/organization/viewState';
import { requireSessionOrganizationMutationScope, writeSessionOrganizationWorkspaceLabels } from '@/sync/ops/sessionOrganization';
import { registerSyncRuntime } from './sync';
import { type SessionMessageV1, type SessionMessagesPageV1 } from '@happier-dev/protocol';
import { MACHINE_RECIPIENT_ACCESS_CHANGE_KIND_V1, isMachineProjectionChangeKindV1 } from '@happier-dev/protocol/changes';
import { projectSessionMetadataForWire } from '@happier-dev/protocol/sessions/metadata/terminalMetadata';
import { parsePermissionIntentAlias, resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';
import { applyComposerControlAcknowledgementV1, projectComposerOptionsInputV1 } from '@happier-dev/protocol/embed';
import type { ApiTokenGrantV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { EMPTY_PROJECT_AUTHORING_SESSION_INPUTS } from '@/sync/store/domains/projectAuthoringSessions';
import {
    publishHomeAccountChange,
    subscribeHomeAccountChange,
    subscribeHomeCredentialChange,
} from '@/sync/runtime/orchestration/homeAccountChange';
import { refreshWorkflowRunsByIds } from '@/sync/engine/workflows/refreshWorkflowRun';
import { invalidateMachinePoolProjection } from '@/sync/engine/machines/machinePoolProjection';
import { invalidateSavedSecretCatalogProjection } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { readSessionMetadataLayoutVersion } from './engine/sessions/parsePlainSessionPayload';
import { SessionMetadataUpgradeDiscovery, changesRequireSessionMetadataUpgradeDiscovery, socketRequiresSessionMetadataUpgradeDiscovery } from './engine/sessions/metadataUpgradeDiscovery';
import { shouldInferSessionLifecycleFromTranscript } from './engine/sessions/taskLifecycle';
import Constants from 'expo-constants';
import { t } from '@/text';
import {
    readExternalSessionOperationState,
} from '@happier-dev/agents';
import {
    apiSocket,
} from '@/sync/api/session/apiSocket';
import type { AccountEncryptionObservationBinding } from '@/sync/http/accountEncryptionObservationBinding';
import { getConcurrentAccountEncryptionObservationBinding } from '@/sync/runtime/orchestration/concurrentSessionCache';
import { emitSessionReadCursorUpdateWithServerScope } from '@/sync/api/session/emitSessionReadCursorUpdateWithServerScope';
import { isDemoModeActive } from '@/demoMode/runtime/enterExitDemoMode';
import { ensureSessionRuntimeForPendingInput } from '@/sync/ops';
import {
    isTokenOnlyAuthCredentials,
    subscribeHomeCredentialMutations,
    type AuthCredentials,
} from '@/auth/storage/tokenStorage';
import { resolveScopedAccountEncryption } from '@/sync/encryption/scopedAccountEncryption';
import { Encryption, captureEncryptionGenerationCurrentness } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import {
    fetchAccountEncryptionCurrentness,
    invalidateAccountEncryptionModeCache,
    invalidateAccountEncryptionModeCacheForChanges,
} from '@/sync/api/account/apiAccountEncryptionMode';
import { getPendingQueueWakeResumeOptions } from '@/sync/domains/pending/pendingQueueWake';
import { normalizeNonEmptyString } from '@/utils/strings/normalizeNonEmptyString';
import {
    clearSessionMessageDerivedCachesForServerScopeReset,
    storage,
} from './domains/state/storage';

import type { ApiEphemeralActivityUpdate, ApiUpdateContainer } from './api/types/apiTypes';
import {
    Session,
    Machine,
    type PendingMessage,
} from './domains/state/storageTypes';
import { MetadataSchema, type AgentState, type Metadata } from '@happier-dev/session-core/state';
import { InvalidateSync, SupersededOperationError } from '@/utils/sessions/sync';
import { createScopedBatchResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { PauseController } from '@/utils/timing/pauseController';
import { userRequestLeaseOwner } from '@/sync/runtime/connectivity/userRequestLease';
import { consumeActionOperationSnapshotPush } from '@/sync/domains/actionOperations/consumeActionOperationSnapshotPush';
import { getActionOperation } from '@/sync/ops/actionOperations';
import { actionOperationPresentationCoordinator } from '@/components/inbox/actionOperations/actionOperationPresentationRuntime';
import {
    assertServerReachabilityAuthenticated,
    invalidateAllServerReachabilitySupervisors,
    setServerReachabilityNetworkAllowed,
    stopServerReachabilitySupervisors,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import {
    acquireEndpointSupervisor,
    getEndpointSupervisorForServer,
} from '@/sync/runtime/connectivity/endpointSupervisorPool';
import { bindEndpointConnectivityStateToRealtimeStore } from '@/sync/runtime/connectivity/bindManagedConnectionStateToRealtimeStore';
import { applyInitialAppStateConnectivityGate } from '@/sync/runtime/connectivity/appStateConnectivityGate';
import {
    createNotAuthenticatedError,
    isTerminalAuthError,
} from '@/sync/runtime/connectivity/authErrors';
import { bindSocketErrorToRealtimeStore } from '@/sync/runtime/connectivity/bindSocketErrorToRealtimeStore';
import { isTransientConnectivityError, RetryableServerResponseError, shouldRetryError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { isSocketIoAckTimeoutError } from '@happier-dev/sync-client';
import { readServerFetchWriteTimeoutMs } from '@/sync/runtime/connectivity/serverReachabilityTuning';
import {
    loadSyncTuning,
    type SyncTuning,
} from '@/sync/runtime/syncTuning';
import {
    acknowledgeTranscriptGap,
    clearResolvedStaleTranscriptMessageIds,
    clearDeferredTranscriptStateForSession,
    createDeferredTranscriptState,
    hasStaleTranscriptMarkers,
    markDeferredTranscriptRemoteSeq,
    markTranscriptDeferred,
    markTranscriptGap,
    markTranscriptStale,
    readDeferredTranscriptDurableSeq,
    readTranscriptGap,
    readStaleTranscriptMessageIds,
    readStaleTranscriptMessageSeqs,
    readStaleTranscriptMinSeq,
    type DeferredTranscriptMarker,
    type DeferredTranscriptState,
} from '@/sync/domains/session/realtime/deferredTranscriptState';
import {
    clearDeferredSessionStateHydration,
    createDeferredSessionStateHydrationState,
    hasDeferredSessionStateHydration,
    markSessionStateHydrationDeferred,
    type DeferredSessionStateHydrationState,
} from '@/sync/domains/session/realtime/deferredSessionStateHydration';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { sessionAddressKey, normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { captureSessionListRetirementFence, wasSessionRetiredSinceFence } from '@/sync/store/domains/sessions';
import type { OrdinarySessionListLifecycle } from '@/sync/domains/session/listing/ordinarySessionListHomeState';
import {
    resolveOrdinarySessionListCoverage,
    areSessionListHomeObservationsEqual,
    type SessionListHomeObservationPhase,
} from '@/sync/domains/session/listing/sessionListHomeObservation';
import { classifySessionListFailure, type SessionListFailure } from '@/sync/domains/session/listing/sessionListFailure';
import { createSessionSystemRecordRepository, type SessionSystemRecordRepository } from '@/sync/domains/sessionSystemRecords/repository';
import type { SessionSystemRecordFetchResult } from '@/sync/domains/sessionSystemRecords/transport';
import { invalidateSessionSystemRecordsFromChanges, invalidateSessionSystemRecordsFromTargets, isSessionSystemRecordChangeKind } from '@/sync/domains/sessionSystemRecords/changeWatch';
import type { SessionStoredContentContext } from '@happier-dev/sync-client';
import {
    buildSessionOrganizationProjection,
    buildSessionOrganizationServerKey,
} from '@/sync/domains/session/organization';
import { removeAuthoritativelyDeletedSessionListTagsForAccount } from '@/components/sessions/shell/search/useSessionListViewFilters';
import { createSessionListOrganizationSnapshotRequest } from '@/sync/engine/sessions/sessionListOrganizationSnapshotRequest';
import {
    fetchAndApplySessionFolderAssignments,
    fetchAndApplySessionOrganizationSnapshot,
} from '@/sync/ops/sessionOrganization';
import {
    publishMachineContributionRegistryProjectionReconnect,
} from '@/sync/ops/machineContributionRegistryProjection';
import {
    type EnsureSessionVisibleForRouteResult,
    type SessionRouteHydrationRetryCause,
    createAvailableSessionRouteResult,
    createMissingSessionRouteResult,
    createRetryableSessionRouteResult,
    createAwaitingPushSessionRouteResult,
    readTerminalSessionRouteMissingCause,
    readRetryableSessionRouteCause,
} from '@/sync/domains/session/sessionRouteHydrationState';
import {
    createHostedSystemSessionEnsurer,
    type EnsureHostedSystemSessionInput,
    type HostedSystemSessionEnsureResult,
} from '@/sync/domains/session/hostedSystemSession';
import { hasAuthoritativeSessionRouteData, hasCurrentSessionTurnsProjection, isHydratedSessionCurrentForListState } from '@/sync/domains/session/hasAuthoritativeSessionRouteData';
import { SESSION_LIST_DOCUMENT_ADMISSION, admitOpenedSessionListAgentState, admitOpenedSessionListDisplayMetadata } from '@/sync/domains/session/sessionDocumentAdmission';
import {
    emitSyncPerformanceSummaryToConsole,
    installSyncPerformanceTelemetryGlobal,
    syncPerformanceTelemetry,
} from '@/sync/runtime/syncPerformanceTelemetry';
import {
    createJsThreadLagTelemetry,
    type JsThreadLagTelemetry,
} from '@/sync/runtime/performance/jsThreadLagTelemetry';
import {
    installSyncReliabilityTelemetryGlobal,
    syncReliabilityTelemetry,
} from '@/sync/runtime/syncReliabilityTelemetry';
import {
    computeSessionMessagesPaginationUpdateFromPage,
    type SessionMessagesPaginationState,
} from '@/sync/runtime/sessionMessagesPagination';
import {
    applyTailDiscontinuityOlderPage,
    applyTailDiscontinuityOpaqueOlderPage,
    applyTailDiscontinuityOpaqueForwardPage,
    openTailDiscontinuityFromSnapshot,
    openTailDiscontinuityFromOpaqueSnapshot,
    type SessionMessagesTailDiscontinuity,
} from '@/sync/runtime/sessionMessagesTailDiscontinuity';
import { makeExternalSessionHistoricalImportLocalId } from '@happier-dev/protocol/sessions/external/historicalImportIdentity';
import {
    createInactiveSessionMessagesWindowState,
    resetSessionMessagesWindowForLiveTail,
    resetSessionMessagesWindowForSessionSwitch,
    type SessionMessagesWindowState,
} from '@/sync/runtime/sessionMessagesWindowState';
import { ActivityUpdateAccumulator, type ActivityUpdateFlushOptions } from '@/sync/engine/activity/activityUpdateAccumulator';
import { readSessionFullPublicationUpdatedAt, sessionRuntimeObservations, type SessionPublicationSource } from '@/sync/domains/session/sessionRuntimeObservation';
import type { MachineActivityUpdate } from '@/sync/domains/machines/machineActivity';
import { randomUUID } from '@/platform/randomUUID';
import {
    Platform,
    AppState,
} from 'react-native';
import type {
    ManagedEndpointSupervisor,
    ManagedEndpointSupervisorState,
} from '@happier-dev/connection-supervisor';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { resolveSentFrom } from './domains/messages/sentFrom';
import {
    NormalizedMessage,
    normalizeRawMessage,
    RawRecord,
} from '@happier-dev/session-core/raw';
import {
    applySettings,
    type AccountSettingsWriteDelta,
    type Settings,
    settingsDefaults,
    settingsParse,
    SUPPORTED_SCHEMA_VERSION,
} from './domains/settings/settings';
import {
    assertUiSessionEncryptionModeAllowed,
    resolveUiClientEncryptionRequirement,
} from './domains/settings/clientEncryptionRequirement';
import {
    Profile,
    profileDefaults,
} from './domains/profiles/profile';
import {
    loadSessionMaterializedMaxSeqById,
    saveSessionMaterializedMaxSeqById,
    loadChangesCursor,
    loadExternalSessionTailCursor,
    pruneStaleInstanceChangesCursors,
    saveExternalSessionTailCursor,
    type ChangesCursorScope,
} from './domains/state/persistence';
import {
    loadPendingAccountSettings,
    savePendingAccountSettings,
} from './domains/state/accountSettingsPersistence';
import { listPendingOutboxSessionIds } from './domains/state/pendingOutboxPersistence';
import {
    deletePersistedSessionViewport,
    loadPersistedSessionViewports,
    upsertPersistedSessionViewport,
} from './domains/state/sessionViewportPersistence';
import { sessionViewportStorageKey } from './domains/state/sessionLocalStateKeys';
import { machineProcessesStore } from './domains/machines/processes/machineProcessesStore';
import { machineResourceStore } from './domains/machines/resources/machineResourceStore';
import {
    captureActiveServerAccountScopeCurrentness,
    captureActiveServerAccountScopeLifetime,
    getActiveServerAccountScope,
    retireActiveServerAccountScopeLifetime,
} from './domains/scope/activeServerAccountScope';
import {
    areServerAccountScopesEqual,
    createServerAccountScope,
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
    type ServerAccountScopeLifetime,
} from './domains/scope/serverAccountScope';
import {
    areAccountSettingsScopesEqual,
    createAccountSettingsScope,
    type AccountSettingsScope,
} from './domains/settings/scope/accountSettingsScope';
import { loadProfile as loadPersistedProfile } from './domains/state/profilePersistence';
import {
    clearWarmCacheAccountScope,
    loadMachineDisplayWarmCacheEntries,
    loadSessionListWarmCacheEntries,
    preparePluginUiProjectionWarmCacheEntries,
    resolveWarmCacheAccountScope,
    setWarmCacheAccountScope,
} from './domains/state/warmCachePersistence';
import {
    buildMachineDisplayCacheEntriesFromRenderables,
    buildSessionListCacheEntriesFromRenderables,
    buildSessionListRenderableFromCacheEntry,
} from './domains/state/warmCacheAdapters';
import { readWarmMachineDisplays } from './domains/state/machineDisplayWarmCacheAdapters';
import {
    initializeTracking,
    tracking,
} from '@/track';
import { applyCrashReportsOptOut } from '@/utils/system/sentry';
import { parseToken } from '@/utils/auth/parseToken';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { RevenueCat } from './domains/purchases';
import {
    trackPaywallPresented,
    trackPaywallPurchased,
    trackPaywallCancelled,
    trackPaywallRestored,
    trackPaywallError,
} from '@/track';
import { getActiveServerHomeCarrier, getActiveServerSnapshot } from './domains/server/serverRuntime';
import {
    areServerProfileIdentifiersEquivalent,
    getServerProfileById,
    getServerProfileLegacyServerIds,
} from './domains/server/serverProfiles';
import { migratePendingNotificationActionScopes } from './domains/pending/pendingNotificationAction';
import { migratePendingNotificationNavScopes } from './domains/pending/pendingNotificationNav';
import { migratePendingSetupIntentScopes } from './domains/pending/pendingSetupIntent';
import { migratePendingTerminalConnectScopes } from './domains/pending/pendingTerminalConnect';
import type { SettingsAnalyticsSource } from '@/track/settingsAnalytics/types';
import { log } from '@/log';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { ingestWorkspaceMutationMessages } from '@/scm/refresh/workspaceMutationIngestionRuntime';
import { projectManager } from './runtime/orchestration/projectManager';
import { voiceHooks } from '@/voice/context/voiceHooks';
import { notifyActivityReady } from '@/activity/notifications/runtime/activityLocalNotificationBus';
import type { Message, TranscriptOlderPageLoadResult } from '@happier-dev/session-core/messages';
import { isRecoveredHistoryTranscriptObservation, type TranscriptMessageMetadataUpdate } from '@happier-dev/session-core/messages';
import { EncryptionCache } from './encryption/encryptionCache';
import type { SessionEncryption } from './encryption/sessionEncryption';
import { createSessionEncryptionUnavailableError } from './encryption/sessionEncryptionUnavailableError';
import { createScopedSessionEncryptionSource } from './runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey';
import { nowServerMs } from './runtime/time';
import {
    createAccountSettingsFailedStatus,
    createAccountSettingsIdleStatus,
    createAccountSettingsRetryingStatus,
    createAccountSettingsSyncedStatus,
} from './domains/settings/accountSettingsSyncStatus';
import { stripLocalOnlyAccountSettings } from './domains/settings/localOnlyAccountSettings';
import {
    clearSessionViewingActivationsForServerScopeReset,
    getCurrentViewingSessionId,
} from './domains/session/readState/sessionManualUnreadHold';
import {
    clearSessionSurfaceVisibilityForServerScopeReset,
    getFocusedSessionAddress,
    getRouteAnchorSessionAddress,
    getSessionSurfaceVisibilitySnapshot,
    getVisibleSessionListSurfaces,
    getVisibleSessionSurfaces,
    isSessionListRowVisible,
    isSessionSurfaceVisible,
} from './domains/session/sessionSurfaceVisibility';
import { clearMountedSessionRealtimeScmConsumerScopes } from './runtime/sessionRealtimeScmConsumers';
import { resolveSessionLiveConsumption, resolveSessionScmMutationSignal } from './runtime/sessionLiveConsumption';
import { resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import {
    catchUpTranscriptSourceWindow,
    readInitialTranscriptSourceWindow,
} from '@happier-dev/agents';
import { SessionViewerProjectionV1Schema } from '@happier-dev/protocol/sessions/personal/viewer';
import { isSessionPersonallyTrackedForViewer } from './domains/session/readState/sessionViewer';
import { updateSessionMetadataWithRetry as updateSessionMetadataWithRetryRpc, type SessionMetadataUpdateRequest, type SessionMetadataTeamCredentialBinding, type UpdateMetadataAck } from './domains/session/metadata/updateSessionMetadataWithRetry';
import type { ArtifactBodyInput, ArtifactHeader, DecryptedArtifact } from './domains/artifacts/artifactTypes';
import type {
    AutomationDefinition,
    AutomationDefinitionRun,
} from './domains/automations/automationTypes';
import { getUserProfile } from './api/social/apiFriends';
import {
    cancelAutomationRun,
    clearAutomationRunHistory,
    deleteAutomationDefinition,
    deliverAutomationResultAgain,
    getAutomationDefinition,
    getAutomationRunDetail,
    getAutomationSettings,
    isAutomationApiErrorCode,
    pauseAutomationDefinition,
    replaceAutomationDefinitionAssignments,
    retryAutomationReplyHandoff,
    resumeAutomationDefinition,
    updateAutomationSettings,
    type AutomationRequestContext,
} from './api/automations/apiAutomations';
import { kvBulkGet } from './api/account/apiKv';
import { FeedItem } from './domains/social/feedTypes';
import { UserProfile } from './domains/social/friendTypes';
import {
    buildLocalOutboundPendingUserMessage,
    buildOutgoingUserTextRecord,
    OutgoingUserTextRecordSchema,
} from './domains/messages/outgoingUserMessage';
import { HappyError } from '@/utils/errors/errors';
import {
    dbgSettings,
    isSettingsSyncDebugEnabled,
    summarizeSettings,
    summarizeSettingsDelta,
    warnSettings,
} from './domains/settings/debugSettings';
import {
    decryptSecretValueWithKeys,
    encryptSecretString,
    sealSecretsDeep,
} from './encryption/secretSettings';
import { resolveSettingsSecretsKeySet } from './encryption/resolveSettingsSecretsKeySet';
import { didControlReturnToMobile } from './domains/session/control/controlledByUserTransitions';
import { submitSessionUserMessage } from './domains/session/input/submitSessionUserMessage';
import { shouldDelegatePendingActivationToDaemon } from './domains/session/input/pendingActivationWakeDecision';
import {
    assertCanSendUserMessageToSession,
    canSendUserMessageToSession,
    SESSION_MESSAGE_SEND_NOT_RESUMABLE_ERROR_CODE,
} from './domains/session/input/sessionMessageSendEligibility';
import type {
    DirectMessageSubmitResult,
    SessionMessageCallerSurface,
    SessionMessageHostAdmissionOrigin,
    SessionSubmitPort,
    SubmitSessionOutboundHandoff,
    SubmitSessionUserMessageResult,
    SubmitPersistence,
} from './domains/session/input/types';
import type { SessionMessageDirectBypassReason } from './domains/session/control/submitMode';
import { getPermissionModeOverrideForSpawn } from './domains/permissions/permissionModeOverride';
import type { SavedSecret } from './domains/settings/savedSecretTypes';
import type { PermissionMode } from './domains/permissions/permissionTypes';
import { ACCOUNT_SETTINGS_QUIET_FLUSH_DELAY_MS, scheduleDebouncedPendingSettingsFlush } from './engine/pending/pendingSettings';
import {
    applySettingsLocalDelta,
    retireLegacyAuthoringMemoryKey,
    requireOneShotAccountSettingsMutationApplied,
    syncSettings as syncSettingsEngine,
    type OneShotAccountSettingsPreparedCommitResult,
    type OneShotAccountSettingsMutationResult,
    type SyncSettingsParams,
} from './engine/settings/syncSettings';
import { removeCommittedPendingSettings } from './engine/settings/writeback/accountSettingsRawDeltaMerge';
import {
    prepareAccountSettingsForDaemonSpawn as prepareAccountSettingsForDaemonSpawnEngine,
    type PreparedAccountSettingsForDaemonSpawn,
} from './engine/settings/prepareAccountSettingsForDaemonSpawn';
import { assertAccountSettingsRehydratedVersion } from './engine/settings/accountSettingsRehydration';
import { registerAccountSettingsDaemonSpawnPreparation } from './ops/accountSettingsDaemonSpawnPreparation';
import { getOfferings as getOfferingsEngine, presentPaywall as presentPaywallEngine, purchaseProduct as purchaseProductEngine, syncPurchases as syncPurchasesEngine } from './engine/purchases/syncPurchases';
import { fetchChanges, fetchCurrentChangesCursor } from './api/session/apiChanges';
import {
    publishActivePluginCollectionUiQueryChanges,
    resetActivePluginCollectionUiQueryWatches,
} from './api/plugins/data/queryPluginCollectionUiQuery';
import {
    createActivePluginAccountAvailabilityProjectionHydrator,
} from './api/plugins/availability/pluginAvailabilityProjection';
import {
    applyPluginAccountAvailabilityProjectionRefresh,
    clearPluginAccountAvailabilityProjection,
} from './domains/plugins/availability/projection';
import {
    publishActiveScopedPluginSettingsChanges,
    resetActiveScopedPluginSettingsChangeWatches,
} from './domains/plugins/settings/scopedPluginSettingsChangeWatch';
import {
    resolveWebSyncClientIdentity,
    type WebSyncClientIdentity,
} from '@/sync/runtime/webSyncClientIdentity';
import { decideChangesCursorCheckpoint } from '@/sync/runtime/orchestration/changesCursorCheckpoint';
import { verifyChangesCursorMaterializationProofs } from '@/sync/runtime/orchestration/cursorMaterializationDetector';
import {
    evaluateSafeCursorLagTripwire,
    rememberBlockedCursorLag,
    type SafeCursorLagTripwireState,
} from '@/sync/runtime/orchestration/safeCursorLagTripwire';
import { runWithInFlightDedupe } from '@/sync/runtime/orchestration/runWithInFlightDedupe';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import { decideMessageCatchUpPolicy } from '@/sync/runtime/orchestration/messageCatchUpPolicy';
import { applyMessageCatchUpDecision } from '@/sync/runtime/orchestration/applyMessageCatchUpDecision';
import { readExternalSessionLink, type ExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import {
    deriveExternalSessionObservedProgress,
    updateMetadataWithObservedExternalSessionProgress,
    updateMetadataWithViewedExternalSessionProgress,
} from '@/sync/domains/session/external/externalSessionAttentionMetadata';
import { normalizeExternalSessionTranscriptMessages } from '@/sync/runtime/external/normalizeExternalSessionTranscriptMessages';
import {
    createExternalSessionTranscriptLiveSourceKeyFromLink,
    externalSessionTranscriptAuthorityKey,
    resolveExternalSessionTranscriptAuthority,
    type ExternalSessionTranscriptAuthority,
} from '@/sync/runtime/external/externalSessionTranscriptAuthority';
import { filterExternalSessionTranscriptAuthorityMessages } from '@/sync/runtime/external/filterExternalSessionTranscriptAuthorityMessages';
import { isMachineReachable, captureMachinePresenceObservation } from '@/sync/domains/machines/reachability/machineReachability';
import { isSessionSubmitMachineReachable } from '@/sync/domains/session/input/syncBackedSubmitPort';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { readStoredSessionRawRecord } from '@/sync/runtime/readStoredSessionContent';
import {
    persistSessionTranscriptMessage as persistSessionTranscriptMessageAtOwner,
    type PersistSessionTranscriptMessageInput,
} from '@happier-dev/session-core/messages';
import { isVoiceTranscriptHistorySession } from '@/voice/persistence/voiceTranscriptHistorySession';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { emitSessionMetadataUpdateWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/emitSessionMetadataUpdateWithServerScope';
import { createOperationAccountCurrentnessSource, fetchSessionByIdWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope';
import { runWithHomeCredentialRequestSignal } from '@/sync/runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import {
    captureServerRequestAuthorityForServerAccountScope,
    type ServerAccountRequestAuthority,
    createServerRequestForResolvedServerScope,
    createServerRequestForServerAccountScope,
    createServerRequestWithServerScope,
    runWithServerRequestAuthorityForServerAccountScope,
} from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { resolveServerAccountRequestContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext';
import { readSessionSnapshotForAuthority, readSessionSnapshotsForAuthority, SessionSnapshotReadError, readSessionEncryptionContextsForAuthority, ensureSessionDisplayProjectionsForRead } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { sessionRpcWithPreferredSessionScope } from '@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope';
import { sessionRpcWithServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';
import {
    externalSessionTranscriptReadAfterRequiresResyncV1,
    machineExternalSessionTranscriptPage,
    machineExternalSessionTranscriptReadAfter,
    machineExternalSessionTranscriptRefreshReadAfter,
} from '@/sync/ops/machineExternalSessions';
import {
    createArtifactViaApi,
    createArtifactWithHeaderViaApi,
    fetchAndApplyArtifactsList,
    fetchAndApplyArtifactBodies,
    fetchAndApplyArtifactChanges,
    fetchArtifactWithBodyFromApi,
    fetchArtifactBinaryFromApi,
    fetchArtifactHtmlPreviewFromApi,
    fetchArtifactForViewFromApi,
    handleDeleteArtifactSocketUpdate,
    handleNewArtifactSocketUpdate,
    handleUpdateArtifactSocketUpdate,
    updateArtifactWithHeaderViaApi,
    type ArtifactDataKeyCache,
    type ArtifactViewRead,
} from './engine/artifacts/syncArtifacts';
import { runWithServerAccountScopeRequestGuard } from './runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { artifactInventorySelectionOptions, doesArtifactInventorySelectionCover, isApprovalSessionInventorySelection, isApprovalStateInventorySelection, isArtifactInventoryLoaded, type ArtifactInventorySelection } from './domains/artifacts/artifactInventory';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { fetchAndApplyFeed, handleNewFeedPostUpdate, handleRelationshipUpdatedSocketUpdate, handleTodoKvBatchUpdate } from './engine/social/syncFeed';
import { fetchAndApplyFriends } from './engine/social/syncFriends';
import {
    fetchAndApplyProfile,
    handleUpdateAccountSocketUpdate,
    schedulePushTokenReconciliation,
} from './engine/account/syncAccount';
import { buildUpdatedMachineFromSocketUpdate, fetchAndApplyMachines, type MachineDataKeyCacheEntry } from './engine/machines/syncMachines';
import { fetchAndApplyAutomationRuns, fetchAndApplyAutomations, type AutomationRefreshOptions } from './engine/automations/syncAutomations';
import { createPendingQueueRequest } from './engine/pending/createPendingQueueRequest';
import {
    applyAutomationDefinitionDetail,
    markAutomationDefinitionContentUnavailable,
} from './domains/automations/automationDefinitionProjection';
import {
    createAutomationRunDetailPrivateContentCurrentnessUnavailable,
    inspectAutomationRunDetailPrivateContent,
    resolveAutomationRunDetailAccountMaterial,
    type AutomationRunDetailRouteInspection,
} from './domains/automations/automationRunDetailInspection';
import { projectAutomationDefinitionSessionLink } from './domains/automations/automationSessionLink';
import { readPluginEventAutomationEditSeed, type PluginEventAutomationEditSeed } from './domains/automations/pluginEventAutomationEditSeed';
import { applyTodoSocketUpdates as applyTodoSocketUpdatesEngine, fetchTodos as fetchTodosEngine } from './engine/todos/syncTodos';
import { fetchAndApplyAccountPets } from './domains/pets/syncAccountPets';
import type { AccountPetMetadata } from './domains/pets/accountPetLibraryTypes';
import {
    planSyncActionsFromChanges,
    plannedChangesAffectSessionListQuery,
    plannedChangesAffectProfileCatalog,
    plannedChangesAffectWorkflowTriggers,
    plannedChangesAffectUsageQuery,
} from './runtime/orchestration/changesPlanner';
import { applyPlannedChangeActions } from './runtime/orchestration/changesApplier';
import { runSocketReconnectCatchUpViaChanges } from './runtime/orchestration/socketReconnectViaChanges';
import {
    SessionDraftRuntimeHydrationGate,
    materializeVisibleExistingSessionDraft,
    materializeSessionDraftSocketWake,
    parseSessionDraftSocketWake,
} from './runtime/orchestration/sessionDraftSyncRuntime';
import { socketEmitWithAckFallback } from './engine/socket/socketEmitWithAckFallback';
import { publishPermissionModeToMetadata as publishPermissionModeToMetadataEngine } from './state/permissionModePublish';
import { publishAcpSessionModeOverrideToMetadata as publishAcpSessionModeOverrideToMetadataEngine } from './state/acpSessionModeOverridePublish';
import { publishAcpConfigOptionOverrideToMetadata as publishAcpConfigOptionOverrideToMetadataEngine, type AcpConfigOptionOverrideValueId } from './state/acpConfigOptionOverridePublish';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import type { ResolvedServerScopedTransport } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport';
import { isRpcMethodNotFoundResult, RPC_ERROR_CODES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { MessageAckResponseSchema, type MessageAckResponse } from '@happier-dev/protocol/updates';
import { resolveRuntimeFeatureDecisionOrThrow } from '@/sync/domains/features/featureDecisionInputs';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { createApiSessionDraftsTransport } from '@/sync/api/account/apiSessionDrafts';
import { createSessionDraftCipher, type SessionDraftContext } from '@/sync/encryption/sessionDraftEncryption';
import { createAuthoringMemoryCipher } from '@/sync/encryption/authoringMemoryEncryption';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { createApiProjectAccountRowsTransport } from '@/sync/api/account/apiProjectAccountRows';
import { createProjectAccountRowsSync } from '@/sync/engine/projects/projectAccountRowsSync';
import type { WorkspaceRefAccountMutation } from '@/sync/domains/workspaces/workspaceRefs';
import { createApiAuthoringMemoryTransport } from '@/sync/api/account/apiAuthoringMemory';
import { createAuthoringMemorySync, importLegacyAuthoringMemory, type AuthoringMemoryDelta } from '@/sync/engine/authoringMemory/authoringMemorySync';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { loadAuthoringMemoryProjection, saveAuthoringMemoryProjection } from '@/sync/domains/state/authoringMemoryPersistence';
import {
    configureSessionDraftRepository,
    ensureSessionDraftAddressesHydrated,
    ensureSessionDraftRepositoryHydrated,
    materializeExactSessionDraft,
    materializeExactSessionDraftWithScopedRuntime,
    retryPendingSessionDrafts,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { SessionDraftAddressV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { runWithSessionDraftRepositoryScopedRuntime } from '@/sync/ops/sessionDrafts/runWithSessionDraftRepositoryScopedRuntime';
import { migrateLegacySessionDrafts } from '@/sync/domains/input/drafts/sessionDraftLegacyMigration';
import { removeRunnerCreatorCustodyForRemovedDraft } from '@/sync/domains/ephemeralRunner/runnerCreatorDraftRemoval';
import { publishMountedDiscussionChanges } from '@/sync/domains/discussions/discussionChangeWatch';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY } from '@happier-dev/protocol/sessions/messages/sessionMessageMeta';
import { decideExternalSessionTranscriptRefreshApplicationV1, ExternalSessionRefreshCursorV1Schema, externalSessionTranscriptRefreshBindingsEqualV1, shouldResyncExternalSessionTranscriptReadAfterV1, type ExternalSessionTranscriptInvalidationV1 } from '@happier-dev/protocol/sessions/external/secureRefreshV1';
import { ExternalSessionOperationSharedPresentationV1Schema } from '@happier-dev/protocol/sessions/external/operationV1';
import { readPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { hasRawComposerAttachmentSelectionV1, type HappierStructuredInputV1, type RawIngressStructuredInputV1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { SessionUserMessageSendResponseSchema } from '@happier-dev/protocol/sessions/userMessageRpc';
import type { ComposerContentHandleV1 } from '@happier-dev/protocol/runtime/input/composerContentV1';
import type { PendingDeliveryBlockedReason } from '@happier-dev/protocol/sessions/messages/pendingDeliveryBlockedReason';
import { PendingResetStartSetInputV1Schema, type PendingRequestedActionV1, type PendingResetStartBindingV1, type PendingResetStartSetInputV1, type PendingResetStartSetResultV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import type { ParticipantRecipientV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import type { ExternalSessionsRpcErrorCode } from '@happier-dev/protocol/sessions/external/rpcErrorCodes';
import type { SessionMetadataInactiveModelIntentExpectationV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { AutomationV3ClearRunHistoryResponse, AutomationV3Settings } from '@happier-dev/protocol/automations/automationApiV3';
import type { AccountSettingMutationV1 } from '@happier-dev/protocol/account/settings/accountSettingMutationV1';
import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import { abortServerFetches, createServerFetchAtEndpoint, StaleServerGenerationError, type ServerFetch, type ServerFetchOptions, type ServerResponseRequest } from './http/client';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';
import { clearEmbedMemoryStorage } from '@/sync/domains/state/persistenceStorage';
import { clearEmbedBrowserRecords } from '@/sync/domains/state/browserRecordStorage';
import { fetchEmbedSessionApprovalArtifacts } from '@/sync/domains/artifacts/embedSessionApprovalArtifacts';
import type { ComposerOptionsInputV1 } from '@happier-dev/protocol/embed';
import { createSessionAttachmentTransferRouting, type SessionAttachmentTransferContext } from '@/sync/domains/transfers/runtime/transferRuntime/families/sessionAttachmentTransfers';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import {
    buildUpdatedSessionFromSocketUpdate,
    fetchAndApplySessions,
    fetchAndApplyMessages,
    fetchAndApplyNewerMessages,
    fetchAndApplyOlderMessages,
    handleDeleteSessionSocketUpdate,
    handleNewMessageSocketUpdate,
} from './engine/sessions/syncSessions';
import {
    advanceOrdinarySessionListFrontier,
    EMPTY_ORDINARY_SESSION_LIST_FRONTIER,
    isOrdinarySessionListFrontierExhausted,
    resolveOrdinarySessionListContinuation,
    type OrdinarySessionListFrontier,
} from './engine/sessions/ordinarySessionListFrontier';
import {
    clearTargetWindowRequestEpochs,
    fetchAndApplyTargetWindowMessages,
} from './engine/sessions/fetchAndApplyTargetWindowMessages';
import { fetchAndApplyTranscriptRepair } from './engine/sessions/fetchAndApplyTranscriptRepair';
import {
    SessionMessagePageDecryptionError,
    SessionMessagePageResponseError,
    type SessionMessagesEncryption,
} from './engine/sessions/sessionMessagesPagePipeline';
import type { SessionTranscriptLoadIssue } from './store/domains/transcriptLoading';
import { fetchUserMessageHistoryPage, type FetchUserMessageHistoryPageResult } from './engine/sessions/fetchUserMessageHistoryPage';
import {
    createSessionTranscriptRetentionController,
    type SessionTranscriptRetentionController,
} from './engine/sessions/sessionTranscriptRetention';
import { socketTranscriptStreamSegmentAssembler } from './engine/socket/socketTranscriptStreamSegmentAssembler';
import {
    readMountedSessionTranscriptConsumerSessionIdsForRetention,
    subscribeSessionTranscriptConsumerReleases,
} from './runtime/sessionRealtimeTranscriptConsumers';
import { resolveSessionMessageRouteId } from '@happier-dev/session-core/messages';
import type { SessionListQueryPageRequest } from './domains/session/listing/sessionListQueryController';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { readSessionOwnerMetadataView, SESSION_OWNER_METADATA_PROJECTION } from './domains/session/readSessionOwnerMetadataView';
import { buildSessionOwnerMetadataUnavailableShell, projectSessionLayout1OwnerMetadata, readSessionLayout1OwnerMetadata } from './engine/sessions/readSessionLayout1OwnerProjection';
import { fetchAndApplySessionById, type SessionListRowPublication } from './engine/sessions/sessionById';
import { looksLikeCurrentV2SessionNotFound404 } from './engine/sessions/sessionHttpCompat';
import { getForkedTranscriptSnapshotCached } from './domains/sessionFork/forkedTranscriptSnapshot';
import {
    computeForkedTranscriptHasMoreOlder,
    resolveNextForkedTranscriptLoadOlderRequest,
} from './domains/sessionFork/forkedTranscriptPaging';
import {
    assertPendingMessageProjectionTransportableV2,
    assertValidPendingMessageId,
    blockPendingDeliveryV2,
    deleteDiscardedPendingMessageV2,
    deletePendingMessageV2,
    dismissPendingDeliveryV2,
    discardPendingMessageV2,
    enqueuePendingMessageV2,
    fetchAndApplyPendingMessagesV2,
    markPendingDeliveryHandledV2,
    reorderPendingMessagesV2,
    replayPersistedPendingOutboxForSession,
    resolvePendingMessageProjectionLocalIdV2,
    resolvePendingMutationIdentity,
    sendPendingDeliveryAsNewV2,
    retryPendingOutboxOperationV2,
    setPendingMessageSendState,
    restoreDiscardedPendingMessageV2,
    updatePendingMessageV2,
    type PendingMessageComposerAdmissionAcceptedFactV1,
    updatePendingRequestedActionV2,
} from './engine/pending/pendingQueueV2';
import {
    isPendingOutboxProjectionForIdentity,
    pendingOutboxProjectionIdentityKey,
} from './engine/pending/pendingOutboxProjectionIdentity';
import {
    resolvePendingInputServerWireMode,
    shouldSchedulePendingOutboxTransportRetry,
    type PendingInputServerWireMode,
} from './engine/pending/pendingInputServerWireContract';
import {
    getServerFeaturesSnapshot,
    refreshAuthenticatedServerFeaturesSnapshot,
    observePublicServerFeaturesFresh,
    primeServerFeaturesSnapshot,
    type ServerFeaturesSnapshot,
} from './api/capabilities/serverFeaturesClient';
import {
    dropSocketSessionWork,
    flushActivityUpdates as flushActivityUpdatesEngine,
    flushMachineActivityUpdates as flushMachineActivityUpdatesEngine,
    handleEphemeralSocketUpdate,
    handleTranscriptStreamSegmentSocketUpdate,
    handleUpdateContainer,
    handleSocketUpdate,
    parseEphemeralUpdate,
    parseUpdateContainer,
    type SocketSessionHydrationReason,
} from './engine/socket/socket';
import { isVersionSupported, MINIMUM_CLI_SESSION_USER_MESSAGE_RPC_VERSION } from '@/utils/system/versionUtils';

const SESSION_MESSAGES_PAGE_SIZE = 150;
const SESSION_LIST_BACKGROUND_HYDRATION_SCROLL_SETTLE_MS = 180;


type LoadOlderMessagesOptions = Readonly<{
    limit?: number;
    authority?: ServerAccountRequestAuthority;
}>;

export type LoadTargetWindowMessagesTarget =
    | Readonly<{ kind: 'seq'; seq: number }>
    | Readonly<{ kind: 'route-message-id'; routeMessageId: string; seqHint: number }>;

export type LoadTargetWindowMessagesOptions = Readonly<{
    limit?: number;
    direction?: 'initial' | 'older' | 'newer';
    /** Continue this observed window without changing its route-target identity. */
    continuationWindowId?: string;
}>;

export type LoadTargetWindowMessagesResult = Readonly<{
    status: 'loaded' | 'not_found' | 'skipped_missing_session' | 'stale' | 'not_ready' | 'retryable_error';
    windowId: string;
    targetSeq: number;
    targetPresent: boolean;
    rawSeqs: readonly number[];
    appliedSeqs: readonly number[];
    olderCursor: number | null;
    newerCursor: number | null;
    hasMoreOlder: boolean | null;
    hasMoreNewer: boolean | null;
}>;

function isRetryableTargetWindowLoadError(error: unknown): boolean {
    return error instanceof SessionMessagePageDecryptionError
        || isTransientConnectivityError(error)
        || isSocketIoAckTimeoutError(error);
}

class ExternalSessionTranscriptRpcError extends Error {
    // Agent/source availability is a settled typed load issue, not transient
    // connectivity. Existing Machine/authority changes (or explicit user retry)
    // invalidate the transcript again; elapsed time cannot make it available.
    get retryable(): boolean {
        return this.code !== 'agent_unavailable';
    }

    constructor(readonly code: ExternalSessionsRpcErrorCode, message: string) {
        super(message);
        this.name = 'ExternalSessionTranscriptRpcError';
    }
}

function projectSessionTranscriptReadFailure(error: unknown): Extract<SessionTranscriptLoadIssue, { kind: 'read_failed' }> {
    if (error instanceof ExternalSessionTranscriptRpcError) {
        return { kind: 'read_failed', errorCode: error.code };
    }
    if (error instanceof SessionMessagePageResponseError) {
        return {
            kind: 'read_failed',
            errorCode: error.code,
            ...(error.status !== undefined ? { httpStatus: error.status } : {}),
        };
    }
    if (error instanceof SessionMessagePageDecryptionError) {
        return { kind: 'read_failed', errorCode: 'decryption_failed' };
    }
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : null;
    if (code === 'session_encryption_not_found' || code === 'scoped_session_encryption_unavailable') {
        return { kind: 'read_failed', errorCode: code };
    }
    const rpcErrorCode = readRpcErrorCode(error);
    if (rpcErrorCode) {
        return { kind: 'read_failed', errorCode: 'rpc_error', causeCode: rpcErrorCode };
    }
    if (error instanceof HappyError && error.status !== undefined) {
        return {
            kind: 'read_failed',
            errorCode: 'http_error',
            httpStatus: error.status,
            ...(code ? { causeCode: code } : {}),
        };
    }
    if (isTransientConnectivityError(error)) {
        return { kind: 'read_failed', errorCode: 'network_error' };
    }
    if (code) {
        return { kind: 'read_failed', errorCode: 'request_failed', causeCode: code };
    }
    return { kind: 'read_failed', errorCode: 'internal_error' };
}

function logSessionTranscriptReadFailure(sessionId: string, error: unknown, issue: SessionTranscriptLoadIssue): void {
    const stage = error instanceof SessionMessagePageResponseError
        ? error.stage
        : error instanceof SessionMessagePageDecryptionError
            ? 'decrypt'
            : error && typeof error === 'object' && 'code' in error
                && (error.code === 'session_encryption_not_found' || error.code === 'scoped_session_encryption_unavailable')
                ? 'reader'
                : 'fetch_messages';
    const cause = error instanceof SessionMessagePageResponseError || error instanceof SessionMessagePageDecryptionError
        ? error.cause
        : undefined;
    const details = error instanceof Error ? `${error.name}: ${error.message}` : `non-Error ${typeof error}`;
    const causeDetails = cause instanceof Error ? ` cause=${cause.name}: ${cause.message}` : '';
    log.log(`Transcript read failed for ${sessionId}: stage=${stage} code=${issue.kind === 'read_failed' ? issue.errorCode : issue.kind}`
        + `${issue.kind === 'read_failed' && issue.httpStatus !== undefined ? ` httpStatus=${issue.httpStatus}` : ''}`
        + `${issue.kind === 'read_failed' && issue.causeCode ? ` causeCode=${issue.causeCode}` : ''}`
        + ` error=${details}${causeDetails}`);
}

function createSessionMessageSubmitFailureError(
    errorCode: string | undefined,
    errorMessage: string | undefined,
    fallbackMessage: string,
): Error {
    const resolvedMessage = errorCode === 'action-conflict'
        ? t('session.pendingMessages.errors.actionConflict')
        : errorMessage ?? fallbackMessage;
    return Object.assign(
        new Error(resolvedMessage),
        ...(errorCode ? [{ code: errorCode }] : []),
    );
}

type SyncSocketSessionHydrationReason = SocketSessionHydrationReason;

/**
 * The Session-reader source a pending owner hands its sealers. The mounted Sync's Account
 * owner answers synchronously; a captured Account authority hydrates the Session's reader
 * on demand (`createScopedSessionEncryptionSource`).
 */
type PendingQueueOwnerEncryption = Readonly<{
    getSessionEncryption: (sessionId: string) => SessionEncryption | null | Promise<SessionEncryption | null>;
}>;

function resolveSessionMessagesPageSize(options?: LoadOlderMessagesOptions): number {
    const optionLimit = options?.limit;
    if (typeof optionLimit === 'number' && Number.isFinite(optionLimit)) {
        return Math.max(1, Math.trunc(optionLimit));
    }
    return SESSION_MESSAGES_PAGE_SIZE;
}

export type SessionViewportSource = 'default' | 'observed';

export type SessionViewportAnchorKind = 'message' | 'toolGroup' | 'item';

export type SessionViewportAnchorSnapshot = Readonly<{
    kind: SessionViewportAnchorKind;
    messageId?: string | null;
    itemId: string;
    itemOffsetPx: number;
    capturedAtMs: number;
    seq?: number | null;
}>;

export type SessionViewportSnapshot = Readonly<{
    isPinned: boolean;
    offsetY: number;
    anchor?: SessionViewportAnchorSnapshot | null;
    lastUpdatedAt: number;
    source: SessionViewportSource;
}>;

export type SessionViewportChangeState = Readonly<{
    isPinned: boolean;
    /** Omitted/non-finite means the detached position is not yet known. */
    offsetY?: number;
    shouldRestoreViewport?: boolean;
    shouldPersistViewport?: boolean;
    anchor?: SessionViewportAnchorSnapshot | null;
}>;

function isSessionViewportAnchorKind(value: unknown): value is SessionViewportAnchorKind {
    return value === 'message' || value === 'toolGroup' || value === 'item';
}

function sanitizeSessionViewportAnchor(value: unknown): SessionViewportAnchorSnapshot | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<Record<keyof SessionViewportAnchorSnapshot, unknown>>;
    if (!isSessionViewportAnchorKind(candidate.kind)) return null;
    if (typeof candidate.itemId !== 'string') return null;
    const itemId = candidate.itemId.trim();
    if (!itemId) return null;
    const messageId = candidate.messageId;
    if (messageId != null && (typeof messageId !== 'string' || !messageId.trim())) return null;
    const seq = typeof candidate.seq === 'number' && Number.isFinite(candidate.seq)
        ? Math.trunc(candidate.seq)
        : null;
    if (typeof candidate.itemOffsetPx !== 'number' || !Number.isFinite(candidate.itemOffsetPx)) return null;
    if (typeof candidate.capturedAtMs !== 'number' || !Number.isFinite(candidate.capturedAtMs) || candidate.capturedAtMs < 0) return null;

    return {
        kind: candidate.kind,
        ...(typeof messageId === 'string' ? { messageId: messageId.trim() } : {}),
        ...(seq != null ? { seq } : {}),
        itemId,
        itemOffsetPx: candidate.itemOffsetPx,
        capturedAtMs: candidate.capturedAtMs,
    };
}

type SessionMessagesScope = 'main' | 'sidechain';

export type SyncMessageTransport = Readonly<{
    emitWithAck: <T = unknown>(event: string, payload: unknown, opts?: { timeoutMs?: number | null }) => Promise<T>;
    send: (event: string, payload: unknown) => unknown;
}>;

function createDefaultMessageTransport(): SyncMessageTransport {
    return {
        emitWithAck: <T>(event: string, payload: unknown, opts?: { timeoutMs?: number | null }) =>
            apiSocket.emitWithAck<T>(event, payload, opts),
        send: (event: string, payload: unknown) => apiSocket.send(event, payload),
    };
}

function shouldRetrySyncInvalidation(error: unknown): boolean {
    if (isDemoModeActive()) return false;
    if (error instanceof ExternalSessionTranscriptRpcError && !error.retryable) return false;
    return shouldRetryError(error);
}

function classifyRouteHydrationErrorCause(error: unknown): SessionRouteHydrationRetryCause {
    return isTransientConnectivityError(error) ? 'server_unavailable' : 'unknown';
}

function isServerSwitchAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'ServerFetchAbortedForServerSwitchError';
}

function buildSessionByIdHydrationInFlightKey(sessionId: string, serverId?: string): string {
    return `${String(serverId ?? '').trim()}\n${sessionId}`;
}

function isFallbackSafeSessionUserMessageRpcError(error: unknown): boolean {
    // Fallback here is compatibility with older daemons / preview CLIs that may expose
    // the active-session send surface under a different method set or during reconnect churn.
    // A parsed runtime result is a target decision, not a transport failure; its error prose
    // must not reopen the legacy writer.
    if (error instanceof HappyError && typeof error.code === 'string' && error.code.trim().length > 0) {
        return false;
    }
    if (isRpcMethodNotAvailableError(error) || readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_FOUND) {
        return true;
    }

    if (isTransientConnectivityError(error)) {
        return true;
    }

    const errorMessage = error instanceof Error ? error.message : String(error ?? '');
    return errorMessage === 'Method not found';
}

function canUseSessionUserMessageRuntimeRpc(
    session: Session | null | undefined,
): boolean {
    const metadata = session ? readSessionOwnerMetadataView(session) : null;
    const cliVersion = typeof metadata?.version === 'string'
        ? metadata.version.trim()
        : '';
    if (cliVersion.length === 0) {
        return true;
    }
    return isVersionSupported(cliVersion, MINIMUM_CLI_SESSION_USER_MESSAGE_RPC_VERSION);
}

function composerAttachmentRuntimeRequiredError(): HappyError {
    return new HappyError(
        'Composer attachments require the active-session runtime',
        false,
        {
            kind: 'server',
            code: 'session_user_message_composer_attachments_runtime_required',
        },
    );
}

function readExternalSessionLinkFromSession(
    session: Session | null | undefined,
): ExternalSessionLink | null {
    return readExternalSessionLink(
        session ? readSessionOwnerMetadataView(session) : null,
    );
}

function ensureSessionRuntimeAfterCommittedPrompt(params: Readonly<{
    sessionId: string;
    session: Session;
    seq: number;
    tag: string;
    serverId?: string | null;
    accountLifetime?: ServerAccountScopeLifetime;
}>): void {
    if (params.accountLifetime && !params.accountLifetime.isCurrent()) return;
    const controlTarget = params.accountLifetime
        ? null
        : readMachineControlTargetForSession(params.sessionId);
    const metadata = readSessionOwnerMetadataView(params.session);
    const machineId = params.accountLifetime
        ? normalizeNonEmptyString(metadata?.machineId)
        : normalizeNonEmptyString(controlTarget?.machineId) ?? normalizeNonEmptyString(metadata?.machineId);
    const directory = params.accountLifetime
        ? normalizeNonEmptyString(metadata?.path)
        : normalizeNonEmptyString(controlTarget?.basePath) ?? normalizeNonEmptyString(metadata?.path);
    if (!machineId || !directory) return;

    const resumeOptions = getPendingQueueWakeResumeOptions({
        sessionId: params.sessionId,
        session: params.session,
        resumeCapabilityOptions: params.accountLifetime
            ? {}
            : { accountSettings: storage.getState().settings },
        resumeTargetOverride: { machineId, directory },
    });
    if (!resumeOptions) return;
    if (params.accountLifetime && !params.accountLifetime.isCurrent()) return;

    fireAndForget(
        ensureSessionRuntimeForPendingInput({
            ...resumeOptions,
            initialTranscriptAfterSeq: Math.max(0, params.seq - 1),
            ...(params.serverId ? { serverId: params.serverId } : {}),
            ...(params.accountLifetime ? { accountLifetime: params.accountLifetime } : {}),
        }),
        { tag: params.tag },
    );
}

function normalizeScopedServerId(value: unknown): string | undefined {
    const serverId = String(value ?? '').trim();
    return serverId || undefined;
}

function isKnownServerId(serverId: string, activeServerId: string | undefined): boolean {
    return areServerProfileIdentifiersEquivalent(serverId, activeServerId) || getServerProfileById(serverId) !== null;
}

function resolveMessageRouteHydrationServerId(
    sessionId: string,
    explicitServerIdRaw: unknown,
    appliedServerIdRaw?: unknown,
): string | undefined {
    // A live Sync owns a prepared Home independently of profile selection.
    // Only cold callers with no prepared target retain the selected-Home
    // fallback needed before Sync has applied its first connection.
    const activeServerId = normalizeScopedServerId(appliedServerIdRaw)
        ?? normalizeScopedServerId(getActiveServerSnapshot().serverId);
    const explicitServerId = normalizeScopedServerId(explicitServerIdRaw);
    if (explicitServerId) {
        return explicitServerId;
    }

    const cachedServerId = normalizeScopedServerId(resolveServerIdForSessionIdFromLocalCache(sessionId));
    if (cachedServerId && isKnownServerId(cachedServerId, activeServerId)) {
        return cachedServerId;
    }

    return activeServerId;
}

/**
 * The locally known Session row for one exact Home, or `null`.
 *
 * Exact equality is required rather than profile-identifier equivalence because
 * the pending owner uses this row as the Home's own Session facts: a row that
 * does not name this exact Home cannot stand in for it.
 */
function readExactServerScopedSession(sessionId: string, serverId: string): Session | null {
    const session = storage.getState().sessions[sessionId];
    if (!session || session.id !== sessionId) return null;
    return session.serverId && session.serverId === serverId ? session : null;
}

export type SendPendingMessageNowResult =
    | Readonly<{
        type: 'committed';
        persistence: Extract<SubmitPersistence, 'transcript_committed' | 'provider_direct'>;
        providerAcceptancePending?: boolean;
    }>
    | Readonly<{ type: 'retry_scheduled' }>;

export type SendPendingMessageNowDeliveryIntent =
    | 'steer_now'
    | 'interrupt_and_send';

type PendingQueueOwnerOptions = Readonly<{
    serverId?: string | null;
}>;

function sanitizePendingMessageMetaForExplicitSubmit(rawRecord: unknown): Record<string, unknown> | undefined {
    const parsed = OutgoingUserTextRecordSchema.safeParse(rawRecord);
    if (!parsed.success) {
        return undefined;
    }
    const meta = parsed.data.meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
        return undefined;
    }

    const sanitized = { ...(meta as Record<string, unknown>) };
    delete sanitized[SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY];
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

const STATIC_EXPO_PUBLIC_HAPPIER_USER_SEND_NO_ACK_AUTH_PROBE_TIMEOUT_MS =
    process.env.EXPO_PUBLIC_HAPPIER_USER_SEND_NO_ACK_AUTH_PROBE_TIMEOUT_MS;

function readUserSendNoAckAuthProbeTimeoutMs(): number {
    const raw = String(STATIC_EXPO_PUBLIC_HAPPIER_USER_SEND_NO_ACK_AUTH_PROBE_TIMEOUT_MS ?? '').trim();
    if (!raw) return 750;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 750;
    return Math.max(0, Math.min(5_000, parsed));
}

async function waitForEndpointProbeToSettle(
    supervisor: ManagedEndpointSupervisor,
    timeoutMs: number,
): Promise<ManagedEndpointSupervisorState> {
    const current = supervisor.getState();
    if (current.phase !== 'connecting' || timeoutMs <= 0) {
        return current;
    }

    return await new Promise<ManagedEndpointSupervisorState>((resolve) => {
        let unsubscribe: (() => void) | null = null;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        let cleanupBeforeSubscribeReturned = false;
        const cleanup = (): void => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
            if (unsubscribe) {
                unsubscribe();
                unsubscribe = null;
                return;
            }
            cleanupBeforeSubscribeReturned = true;
        };

        timeout = setTimeout(() => {
            cleanup();
            resolve(supervisor.getState());
        }, Math.max(0, timeoutMs));

        unsubscribe = supervisor.subscribe((state) => {
            if (state.phase === 'connecting') {
                return;
            }
            cleanup();
            resolve(state);
        });
        if (cleanupBeforeSubscribeReturned && unsubscribe) {
            unsubscribe();
            unsubscribe = null;
        }
    });
}

function readOptionalSessionMetadataString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

type FetchSessionsOptions = Readonly<{
    discoverMetadataUpgrades?: boolean;
    awaitSessionListHydration?: boolean;
    requiredHydrationSessionIds?: ReadonlyArray<string>;
    prioritizeSessionIds?: ReadonlyArray<string>;
    mode?: 'replace' | 'append';
}>;

type FetchSessionsResult = Awaited<ReturnType<typeof fetchAndApplySessions>>;

function canShareFetchSessionsInFlight(options?: FetchSessionsOptions): boolean {
    return options?.awaitSessionListHydration !== true
        && (options?.requiredHydrationSessionIds?.length ?? 0) === 0
        && (options?.prioritizeSessionIds?.length ?? 0) === 0
        && options?.mode !== 'append';
}

type SessionOrganizationSyncState = Pick<
    ReturnType<typeof storage.getState>,
    | 'sessionOrganizationSchemaVersionByServerId'
    | 'sessionOrganizationSnapshotVersionByServerId'
    | 'sessionOrganizationPinsBySessionKey'
    | 'sessionOrganizationFoldersByFolderKey'
    | 'sessionOrganizationFolderAssignmentsBySessionKey'
    | 'sessionOrganizationTagsByTagKey'
    | 'sessionOrganizationTagAssignmentsBySessionKey'
    | 'sessionOrganizationAttentionStandingsBySessionKey'
    | 'sessionOrganizationOrderEntriesByScopeKey'
    | 'sessionOrganizationLabelsByLabelKey'
>;

function resolveOrganizationPinnedSessionIdsForServer(state: SessionOrganizationSyncState, serverId: string | null): string[] {
    const normalizedServerId = typeof serverId === 'string' && serverId.trim().length > 0 ? serverId.trim() : null;
    if (!normalizedServerId) return [];
    return [...buildSessionOrganizationProjection({
        schemaVersionByServerId: state.sessionOrganizationSchemaVersionByServerId,
        snapshotVersionByServerId: state.sessionOrganizationSnapshotVersionByServerId,
        pinsBySessionKey: state.sessionOrganizationPinsBySessionKey,
        foldersByFolderKey: state.sessionOrganizationFoldersByFolderKey,
        folderAssignmentsBySessionKey: state.sessionOrganizationFolderAssignmentsBySessionKey,
        tagsByTagKey: state.sessionOrganizationTagsByTagKey,
        tagAssignmentsBySessionKey: state.sessionOrganizationTagAssignmentsBySessionKey,
        attentionStandingsBySessionKey: state.sessionOrganizationAttentionStandingsBySessionKey,
        orderEntriesByScopeKey: state.sessionOrganizationOrderEntriesByScopeKey,
        labelsByLabelKey: state.sessionOrganizationLabelsByLabelKey,
    }, normalizedServerId).orderedPinSessionIds];
}

type AckedOutboundUserMessageCommitInput = Readonly<{
    sessionId: string;
    localId: string | null;
    createdAt: number;
    rawRecord: RawRecord;
    ack: Readonly<{
        id: string;
        seq: number;
    }>;
    removePending?: boolean;
}>;

/**
 * Outcome of the changes-based resume catch-up.
 *
 * `refreshedByCatchUp` records which whole-list refreshes the catch-up already completed for this resume so the
 * resume tail does not issue the same full refresh a second time. Without it a foreground resume runs two
 * complete catch-up waves: the catch-up's own `invalidate.sessions`/`invalidate.machines`, and then the
 * socket-offline recovery block in `resumeSync`.
 */
type ResumeViaChangesOutcome = Readonly<{
    status: 'ok' | 'fallback' | 'aborted';
    refreshedByCatchUp: Readonly<{ sessions: boolean; machines: boolean }>;
}>;

export type SessionSystemRecordRuntime = Readonly<{
    scope: ServerAccountScope;
    request: ServerAccountRequestAuthority['request'];
    repository: SessionSystemRecordRepository;
    /**
     * The exact Session row the store holds for this address. The runtime reads it from
     * `storage.getState().sessions`, so this is the store projection, not the raw fetch payload.
     */
    session: Session;
    contentContext: SessionStoredContentContext | null;
    /** Read the exact current Session projection without trusting a same-id row from another Home. */
    readSession(): Session | null;
    /** Read the current canonical Session key context without rehydrating the Session. */
    readContentContext(): SessionStoredContentContext | null;
    isCurrent(): boolean;
}>;

type SessionRealtimeHomeScope = Readonly<{
    serverId: string;
    encryption: Encryption | null;
    credentials: AuthCredentials;
    isCurrent: () => boolean;
}>;

class Sync {

        encryption: Encryption | null = null;
        serverID!: string;
        anonID!: string;
        private credentials: AuthCredentials | null = null;
        private appliedServerTarget: SyncServerTarget | null = null;
        private embedSessionScope: (Omit<SyncEmbedSessionOptions, 'composerOptionsInput'> & {
            composerOptionsInput?: ComposerOptionsInputV1 | null;
        } & Readonly<{
            request: ServerResponseRequest;
            controller: AbortController;
            approvalsSync: InvalidateSync;
        }>) | null = null;
        private embedFeaturesSnapshot: ServerFeaturesSnapshot = { status: 'unsupported', reason: 'endpoint_missing' };
        private readonly requestViaConfiguredSocket: ServerFetch = async (path, init, options) => {
            const scope = this.embedSessionScope;
            if (!scope && isEmbedWindowContext()) throw new StaleServerGenerationError();
            return await (scope?.request ?? apiSocket.request.bind(apiSocket))(path, init, options);
        };
        private pauseController = new PauseController();
        private userRequestLeaseOwner = userRequestLeaseOwner;
        private activeEndpointSupervisor: ManagedEndpointSupervisor | null = null;
      private syncTuning: SyncTuning = loadSyncTuning();
      private resumeInFlight: Promise<void> | null = null;
      private resumeWaitController: AbortController | null = null;
      private manualResumeGeneration = 0;
      private changesCatchUpQueuedAfterResume = false;
      private pendingOutboxRearmInFlightByScope = new Map<string, Promise<void>>();
      private readonly usesPersistentDesktopSync = isDesktopHost();
      private isForeground = this.usesPersistentDesktopSync || AppState.currentState === 'active';
      public encryptionCache = new EncryptionCache();
      private sessionDraftSyncEnabled = false;
      private sessionDraftFlushSync: InvalidateSync | null = null;
      private sessionDraftSnapshotIncomplete = false;
      private sessionDraftRepositoryConfiguredScope: ServerAccountScope | null = null;
      private authoringMemoryRuntime: Promise<ReturnType<typeof createAuthoringMemorySync>> | null = null;
      private projectAccountRowsRuntime: Promise<ReturnType<typeof createProjectAccountRowsSync>> | null = null;
      private readonly sessionDraftRuntimeHydrationGate = new SessionDraftRuntimeHydrationGate();
      private readonly sessionDraftRuntimePreparationGate = new SessionDraftRuntimeHydrationGate();
      private readonly sessionSystemRecordRepositories = new Map<string, SessionSystemRecordRepository>();
    private sessionsSync: InvalidateSync;
    private metadataUpgradeDiscovery = new SessionMetadataUpgradeDiscovery();
    private fetchSessionsInFlight: {
        serverScopeGeneration: number;
        snapshotGeneration: number;
        target: SyncServerTarget;
        promise: Promise<FetchSessionsResult | undefined>;
    } | null = null;
    private fetchMoreSessionsInFlight: Promise<void> | null = null;
    private sessionListNextCursor: string | null = null;
    private sessionListHasMore = false;
    private sessionListAttentionNextCursor: string | null = null;
    private sessionListAttentionHasMore = false;
    private sessionListMetadataUpgradeRequiredCount = 0;
    private sessionListScrollActive = false;
    private sessionListScrollActiveUntilMs = 0;
    private sessionListScrollSettleTimer: ReturnType<typeof setTimeout> | null = null;
    private sessionListScrollIdleResolvers: Array<() => void> = [];
    private messagesSync = new Map<string, InvalidateSync>();
    private activeServerSessionIds = new Set<string>();
    private hasFetchedSessionsSnapshotForActiveServer = false;
    private serverScopeGeneration = 0;
    private sessionListSnapshotGeneration = 0;
    private bootstrapForegroundReady: Promise<void> | null = null;
    private managedTargetBackfillLifetime: ServerAccountScopeLifetime | null = null;
    private consumeBootstrapAutomationPage: NonNullable<Parameters<typeof fetchAndApplyAutomations>[0]['onDefinitionsRead']> | null = null;
      private sessionByIdHydrationInFlight = new Map<string, Readonly<{
          sessionId: string;
          serverId: string | undefined;
          encryption: Encryption | null;
          isCurrent(): boolean;
          promise: Promise<EnsureSessionVisibleForRouteResult>;
          readSessionEncryption: () => ReturnType<Encryption['getSessionEncryption']>;
          invalidate(): void;
      }>>();
      private readonly hostedSystemSessionEnsurer = createHostedSystemSessionEnsurer({
          fetchAccountEncryptionCurrentness: (credentials, request) =>
              fetchAccountEncryptionCurrentness(credentials, { request }),
          randomBytes: getRandomBytes,
          request: (path, init) => this.requestViaConfiguredSocket(path, init),
          hydrate: (sessionId, authority) => this.ensureSessionVisibleForMessageRoute(sessionId, {
              forceRefresh: true,
              authority,
          }),
          isScopeCurrent: (scopeKey) => {
              const current = getActiveServerAccountScope();
              return Boolean(current && serverAccountScopeKeySuffix(current) === scopeKey);
          },
      });
      private sessionReceivedMessages = new Map<string, Map<string, number>>();
      // Tail-reset discontinuity walks (MAIN chain only) — see sessionMessagesTailDiscontinuity.ts.
      private sessionMessagesTailDiscontinuityBySessionId = new Map<string, SessionMessagesTailDiscontinuity>();
      private sessionMessagesWindowStateBySessionId = new Map<string, SessionMessagesWindowState>();
      private sessionMessagesBeforeSeqByKey = new Map<string, number>();
      private sessionMessagesHasMoreOlderByKey = new Map<string, boolean>();
      private sessionMessagesFetchLatestInFlightByKey = new Set<string>();
      private sessionMessagesFetchedLatestByKey = new Set<string>();
      private sessionMessagesLoadingOlderByKey = new Set<string>();
      private deferredMessagesFetchSessionIds = new Set<string>();
      private sessionMessagesLoadingNewerByKey = new Set<string>();
      private sessionMessagesPaginationSupportedByKey = new Map<string, boolean>();
      private externalSessionOlderCursorBySessionId = new Map<string, string | null>();
      private externalSessionHasMoreOlderBySessionId = new Map<string, boolean>();
      private externalSessionTailStateBySessionId = new Map<string, {
          cursor: string | null;
          readonly recoveryRequired: boolean;
          lastSourceMessageIds?: readonly string[];
      }>();
      private externalSessionTailCursorListenersBySessionId =
          new Map<string, Set<() => void>>();
      private transcriptAuthorityKeyBySessionId = new Map<string, string>();
      // A replacement outcome proves this exact authority is no longer readable.
      // This is only a currentness fence until session metadata resolves another authority.
      private externalSessionTranscriptFenceAuthorityKeyBySessionId = new Map<string, string>();
      private sessionViewport = new Map<string, SessionViewportSnapshot>();
      private sessionViewportHydratedStorageKey: string | null = null;
      private deferredForwardLoadingSessions = new Set<string>();
      private explicitSessionTailProbeIds = new Set<string>();
      private sessionTranscriptRetention!: SessionTranscriptRetentionController;
      private sessionDataKeys = new Map<string, Uint8Array>(); // Store session data encryption keys internally
      private sessionDataKeyEnvelopes = new Map<string, string>(); // Track wrapped DEK envelopes so unchanged keys can be reused safely
      private machineDataKeys = new Map<string, MachineDataKeyCacheEntry>(); // Unwrapped machine data keys + the envelope each came from, so an unchanged envelope is never re-opened
      private machineRecipientChangeCursors = new Map<string, number>();
      private artifactDataKeys: ArtifactDataKeyCache = new Map(); // Unwrapped artifact data keys + the envelope each came from, so an unchanged envelope is never re-opened
      private artifactBodyHydrations = createScopedBatchResolutionSingleFlight<PromiseSettledResult<void>>();
    private settingsSync: InvalidateSync;
    private profileSync: InvalidateSync;
    private purchasesSync: InvalidateSync;
    private machinesSync: InvalidateSync;
    private nativeUpdateSync: InvalidateSync;
    private artifactsSync: InvalidateSync;
    private artifactInventoryConsumers = new Set<Readonly<{
        scope: ServerAccountScope;
        selection?: ArtifactInventorySelection;
        includeProvenance: boolean;
        onSettled?: (outcome: 'success' | 'failed') => void;
    }>>();
    private artifactInventoryRefreshes: readonly Readonly<{
        controller: AbortController; selection: ArtifactInventorySelection | undefined;
    }>[] = [];
    private friendsSync: InvalidateSync;
    private friendRequestsSync: InvalidateSync;
    private feedSync: InvalidateSync;
    private pendingMessageCommitRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private pendingOutboxOperationRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private todosSync: InvalidateSync;
    private automationsSync: InvalidateSync;
    // Stronger demand survives status-only arrivals, awaits and the queue's retry.
    private automationRunRefreshPending = false;
    // Traversal identity is only an in-process write fence. The store owns the
    // corresponding acceptance check; this owner keeps the token alongside
    // each in-flight reader so an older response cannot overwrite it later.
    private automationDefinitionTraversalToken: number | null = null;
    private automationRunTraversalTokensByAutomationId = new Map<string, number>();
    private accountPetsSync: InvalidateSync;
    private pluginAvailabilitySync: InvalidateSync;
    private readonly pluginAvailabilityProjectionHydrator =
        createActivePluginAccountAvailabilityProjectionHydrator();
    private activityAccumulator: ActivityUpdateAccumulator;
    private pendingSettings: Partial<Settings> = {};
    private pendingSettingsScope: AccountSettingsScope | null = null;
    private pendingSettingsFlushTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingSettingsDirty = false;
    private sessionMaterializedMaxSeqById: Record<string, number> = {};
    private deferredTranscriptState: DeferredTranscriptState = createDeferredTranscriptState();
    private deferredSessionStateHydrationState: DeferredSessionStateHydrationState = createDeferredSessionStateHydrationState();
    private notifiedReadySeqByAddressKey: Record<string, number> = {};
    private sessionMaterializedMaxSeqFlushTimer: ReturnType<typeof setTimeout> | null = null;
    private sessionMaterializedMaxSeqDirty = false;
    private nativeInactiveCheckpointTimer: ReturnType<typeof setTimeout> | null = null;
    private jsThreadLagTelemetry: JsThreadLagTelemetry | null = null;
	      private changesCursor: string | null = isEmbedWindowContext() ? null : loadChangesCursor(String(getActiveServerSnapshot().serverId ?? '').trim() || null);
        // Publication is an observation, not materialization proof. Retain only the
        // latest notified row per resource while its durable checkpoint is held.
        private publishedAccountChangeCursors = new Map<string, number>();
        private safeCursorLagState: SafeCursorLagTripwireState | null = null;
        private webSyncClientIdentity: WebSyncClientIdentity | null = null;
        private webSyncClientIdentityHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
        private webLifecycleHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
        private webLifecycleHeartbeatLastNowMs: number | null = null;
	      private lastSocketDisconnectedAtMs: number | null = null;
      private lastSocketOfflineDurationMs: number | null = null;
      private socketOfflineCatchUpConsumedSessionIds = new Set<string>();
      private socketStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
      private postSubscriptionChangesCatchUpPending = false;
      revenueCatInitialized = false;
    private settingsSecretsKey: Uint8Array | null = null;
    private settingsSecretsReadKeys: readonly Uint8Array[] = [];
    private messageTransport: SyncMessageTransport = createDefaultMessageTransport();
    private updatesSubscribed = false;

    // Generic locking mechanism
    private recalculationLockCount = 0;
    private lastRecalculationTime = 0;
    private machinesRefreshInFlight: Promise<void> | null = null;
    private lastMachinesRefreshAt = 0;

        constructor() {
        syncPerformanceTelemetry.configure({
            enabled: this.syncTuning.syncPerformanceTelemetryEnabled,
            slowThresholdMs: this.syncTuning.syncPerformanceTelemetrySlowThresholdMs,
            flushIntervalMs: this.syncTuning.syncPerformanceTelemetryFlushIntervalMs,
            emitSummary: emitSyncPerformanceSummaryToConsole,
        });
        installSyncPerformanceTelemetryGlobal(syncPerformanceTelemetry);
        installSyncReliabilityTelemetryGlobal(syncReliabilityTelemetry);
        if (!isEmbedWindowContext()) subscribeHomeAccountChange(event => {
            if (event.sessionSystemRecords !== undefined) {
                for (const repository of this.sessionSystemRecordRepositories.values()) {
                    if (!areServerProfileIdentifiersEquivalent(repository.scope.serverId, event.serverId)) continue;
                    invalidateSessionSystemRecordsFromTargets({ scope: repository.scope, repository, targets: event.sessionSystemRecords });
                    // Released/predecessor workflow transports have no addressed publisher.
                    if (event.changeKinds?.includes('session')) for (const sessionId of event.entityIds ?? []) {
                        repository.invalidateLegacyWorkflows({ serverId: event.serverId, sessionId });
                    }
                }
                return;
            }
            // A focused content-free wake starts the canonical feed read; it
            // does not identify a Session record or an access change. Repeated
            // unrelated wakes must not invalidate that read's admitted Board
            // on every arrival. The feed applier owns exact invalidation once
            // it answers; known access/record wakes still withdraw immediately.
            if (event.source === 'catch-up-pending' && event.changeKinds === undefined) return;
            // Detailed focused pages already invalidate their exact Session/share
            // ids. Advisory Home wakes and blocked catch-up have no such page:
            // revalidate observed records now, and leave hidden records stale for
            // their next subscriber, through the same repository refresh owner.
            if (event.feedPageConsumed === true && event.entityIds !== undefined && event.changeKinds !== undefined) return;
            if (event.changeKinds && !event.changeKinds.some(isSessionSystemRecordChangeKind)) return;
            for (const repository of this.sessionSystemRecordRepositories.values()) {
                if (!areServerProfileIdentifiersEquivalent(repository.scope.serverId, event.serverId)) continue;
                if (event.entityIds) {
                    for (const sessionId of event.entityIds) repository.invalidate({ serverId: event.serverId, sessionId });
                } else {
                    repository.invalidateAll();
                }
            }
        }, { includeCatchUpPending: true });
        if (!isEmbedWindowContext()) subscribeHomeAccountChange(event => {
            if (event.changeKinds && !event.changeKinds.some(isMachineProjectionChangeKindV1)) return;
            const state = storage.getState();
            for (const session of Object.values(state.sessions)) {
                if (!areServerProfileIdentifiersEquivalent(session.serverId, event.serverId)
                    || !((session.pendingCount ?? 0) > 0 || state.sessionPending[session.id]?.messages.length)
                    || !resolveSessionLiveConsumption(session.id, event.serverId).isFullContentConsumer) continue;
                // Holds depend on current guest AND controller grants, not pendingVersion.
                // Fence the old read through the same Pending snapshot lifecycle.
                fireAndForget(this.fetchPendingMessages(session.id, undefined, undefined, { invalidateSnapshot: true }), {
                    tag: 'Sync.accountChange.fetchPendingMessages',
                });
            }
        });
        if (!isEmbedWindowContext()) subscribeHomeCredentialChange(({ serverId }) => {
            for (const [key, repository] of this.sessionSystemRecordRepositories) {
                if (!areServerProfileIdentifiersEquivalent(repository.scope.serverId, serverId)) continue;
                repository.retire();
                this.sessionSystemRecordRepositories.delete(key);
            }
            if (this.isAppliedTransportServer(serverId)) {
                // A request captured with the replaced Home credential must not
                // finish over the previous direct transport while connection
                // lifecycle prepares the replacement.
                apiSocket.invalidateRequests('credentials-changed');
            }
        });
        // Decrypted plaintext deliberately does NOT hang off the transcript-derived-cache
        // seam.
        //
        // That seam exists for memo caches whose entries root store objects — the
        // per-session message arrays in `sync/store/hooks.ts` keep a `SessionMessages`
        // entry alive through `sourceRef`s, so dropping the store entry without clearing
        // them frees nothing. A `DecryptedMessage` is a plain record and roots none of
        // that, so it never belonged to that concern.
        //
        // Registering it here conflated two lifetimes and cost far more than it saved:
        // bounded retention eviction (`evictSessionMessages`) fires the seam, so every
        // evicted transcript ALSO threw away plaintext whose validity had not changed —
        // the cache is keyed by `(messageId, ciphertext fingerprint)` and stays correct
        // across an eviction. Returning to the session then paid full decryption again.
        //
        // Measured on remote-dev 2026-08-18 (same defect, same wiring), returning to a
        // session parked past the retention grace: before, `toDecrypt 368, cached 0` —
        // 0% hit, 1574ms of decryption, 3685ms to first paint. After removing this
        // registration: `toDecrypt 0, cached 368` — 100% hit, 213ms, 1967ms to first
        // paint, on the identical scenario.
        //
        // The two lifetimes that genuinely invalidate plaintext still clear it, each at
        // its own owner: a session key change (`initializeSessionEncryption`) and session
        // deletion (`removeSessionEncryption`). Size is bounded by the cache's own
        // `maxMessageBytes` LRU budget. Nothing here needs a third opinion.
        if (!isEmbedWindowContext()) registerAccountSettingsDaemonSpawnPreparation(this.prepareAccountSettingsForDaemonSpawn);
        this.syncJsThreadLagTelemetryRuntime();
        // Bounded transcript retention: sweep is triggered by transcript-surface
        // unmounts (registry releases) and by sessions becoming visible — never polled.
        this.sessionTranscriptRetention = createSessionTranscriptRetentionController({
            readHydratedSessionIds: () => Object.keys(storage.getState().sessionMessages),
            readProtectedSessionIds: () => this.readTranscriptRetentionProtectedSessionIds(),
            readLastViewedAtBySessionId: () => storage.getState().sessionLastViewed,
            evictSessionTranscript: (sessionId) => this.evictSessionTranscript(sessionId),
            tuning: {
                recentKeepCount: this.syncTuning.sessionTranscriptRetentionRecentKeepCount,
                graceMs: this.syncTuning.sessionTranscriptRetentionGraceMs,
                sweepDebounceMs: this.syncTuning.sessionTranscriptRetentionSweepDebounceMs,
            },
        });
        subscribeSessionTranscriptConsumerReleases(() => {
            if (!isDemoModeActive()) {
                this.sessionTranscriptRetention.scheduleSweep();
            }
        });
        fireAndForget(Promise.resolve().then(() => {
            if (isEmbedWindowContext()) return;
            const pruned = pruneStaleInstanceChangesCursors({
                nowMs: Date.now(),
                retentionMs: this.syncTuning.webSyncInstanceCursorRetentionMs,
                maxKeys: 500,
            });
            if (pruned > 0) {
                syncReliabilityTelemetry.record('sync.webInstanceCursor.reaped', { pruned });
            }
        }), { tag: 'Sync.pruneStaleInstanceChangesCursors' });
        dbgSettings('Sync.constructor: loaded pendingSettings', {
            pendingKeys: Object.keys(this.pendingSettings).sort(),
        });
        if (!isEmbedWindowContext()) applyInitialAppStateConnectivityGate({
            isForeground: this.isForeground,
            pauseController: this.pauseController,
            setNetworkAllowed: setServerReachabilityNetworkAllowed,
        });
        const onSuccess = () => {
            storage.getState().clearSyncError();
            storage.getState().setLastSyncAt(Date.now());
        };
        const onError = this.reportSyncError;
        const readPendingServerSettingsKeys = () => Object
            .keys(stripLocalOnlyAccountSettings(this.pendingSettings))
            .sort();
        const onSettingsSuccess = () => {
            const now = Date.now();
            storage.getState().clearSyncError();
            storage.getState().setLastSyncAt(now);
            storage.getState().setAccountSettingsSyncStatus(createAccountSettingsSyncedStatus(now));
        };
        const onSettingsError = (e: any) => {
            onError(e);
            storage.getState().setAccountSettingsSyncStatus(createAccountSettingsFailedStatus({
                error: e,
                pendingServerKeys: readPendingServerSettingsKeys(),
            }));
        };
        const onSettingsRetryFailure = (
            e: any,
            info: { failuresCount: number; nextDelayMs: number; nextRetryAt: number },
        ) => {
            const message = e instanceof Error ? e.message : String(e);
            const kind: 'auth' | 'config' | 'network' | 'server' | 'unknown' =
                e instanceof HappyError && e.kind ? e.kind : 'unknown';
            storage.getState().setSyncError({
                message,
                retryable: true,
                kind,
                at: Date.now(),
                serverId: this.serverID || undefined,
                failuresCount: info.failuresCount,
                nextRetryAt: info.nextRetryAt,
            });
            storage.getState().setAccountSettingsSyncStatus(createAccountSettingsRetryingStatus({
                error: e,
                retryInfo: info,
                pendingServerKeys: readPendingServerSettingsKeys(),
            }));
        };

          const onRetry = (info: { failuresCount: number; nextDelayMs: number; nextRetryAt: number }) => {
              const ex = storage.getState().syncError;
              if (!ex) return;
              storage.getState().setSyncError({ ...ex, failuresCount: info.failuresCount, nextRetryAt: info.nextRetryAt });
          };

            const pause = this.pauseController;
            const backoff = {
                minDelayMs: this.syncTuning.invalidateSyncBackoffMinDelayMs,
                maxDelayMs: this.syncTuning.invalidateSyncBackoffMaxDelayMs,
                maxFailureCount: 'infinite' as const,
            };
            const shouldRetry = shouldRetrySyncInvalidation;
            this.sessionsSync = new InvalidateSync(async () => {
                const existing = this.fetchSessionsInFlight;
                if (existing && existing.serverScopeGeneration === this.serverScopeGeneration
                    && existing.snapshotGeneration === this.sessionListSnapshotGeneration
                    && this.isAppliedTransportTargetCurrent(existing.target)) {
                    await existing.promise;
                }
                await this.fetchSessions();
            }, { onError, onSuccess, onRetry, pause, backoff, shouldRetry });
            this.settingsSync = new InvalidateSync(this.syncSettings, {
                onError: onSettingsError,
                onSuccess: onSettingsSuccess,
                onRetryFailure: onSettingsRetryFailure,
                onRetry,
                pause,
                backoff,
                shouldRetry,
            });
            this.profileSync = new InvalidateSync(this.fetchProfile, { onError, onSuccess, onRetry, pause, backoff, shouldRetry });
            this.purchasesSync = new InvalidateSync(this.syncPurchases, { onError, onSuccess, onRetry, pause, backoff, shouldRetry });
            this.machinesSync = new InvalidateSync(this.fetchMachines, { onError, onSuccess, onRetry, pause, backoff, shouldRetry });
            this.nativeUpdateSync = new InvalidateSync(this.fetchNativeUpdate, { pause, backoff, shouldRetry });
            this.artifactsSync = new InvalidateSync(this.refreshDemandedArtifactInventories, { pause, backoff, shouldRetry });
            this.friendsSync = new InvalidateSync(this.fetchFriends, { pause, backoff, shouldRetry });
            this.friendRequestsSync = new InvalidateSync(this.fetchFriendRequests, { pause, backoff, shouldRetry });
            this.feedSync = new InvalidateSync(this.fetchFeed, { pause, backoff, shouldRetry });
            this.todosSync = new InvalidateSync(this.fetchTodos, { pause, backoff, shouldRetry });
            this.automationsSync = new InvalidateSync(this.fetchAutomations, { pause, backoff, shouldRetry });
            this.accountPetsSync = new InvalidateSync(this.fetchAccountPets, { pause, backoff, shouldRetry });
            this.pluginAvailabilitySync = new InvalidateSync(async () => {
                const projection = await this.pluginAvailabilityProjectionHydrator.refresh();
                if (!projection) return;
                applyPluginAccountAvailabilityProjectionRefresh(projection);
            }, { onError, onSuccess, onRetry, pause, backoff, shouldRetry });

            this.activityAccumulator = new ActivityUpdateAccumulator(
                this.flushActivityUpdates.bind(this),
                this.syncTuning.activityUpdateDebounceMs,
                sessionRuntimeObservations,
            );

          // Listen for app state changes to pause sync + run a single centralized resume pipeline.
          if (!isEmbedWindowContext()) AppState.addEventListener('change', (nextAppState) => {
              if (this.usesPersistentDesktopSync && nextAppState !== 'active') {
                  this.clearNativeInactiveCheckpointTimer();
                  this.isForeground = true;
                  setServerReachabilityNetworkAllowed(true);
                  this.pauseController.resume();
                  return;
              }
              if (nextAppState === 'active') {
                  this.userRequestLeaseOwner.cancelDeferredRoutineTeardown();
                  this.clearNativeInactiveCheckpointTimer();
                  this.isForeground = true;
                  this.resumeNativeCryptoWorkerDispatchAfterForeground('Sync.nativeCryptoWorkerQueue.active.appState');
                  setServerReachabilityNetworkAllowed(true);
                  log.log('📱 App became active');
                  this.pauseController.resume();
                  fireAndForget(invalidateAllServerReachabilitySupervisors(), { tag: 'Sync.invalidateAllServerReachabilitySupervisors' });
                  this.resumeAfterForegroundTransition('Sync.resumeSync.app-foreground');
              } else {
                  this.isForeground = false;
                  log.log(`📱 App state changed to: ${nextAppState}`);
                  this.pauseController.pause();
                  const teardownConnectivity = () => {
                      this.markNativeCryptoWorkerBackgroundQuiescent();
                      setServerReachabilityNetworkAllowed(false);
                      try {
                          this.disconnectSocketIntentionally();
                      } catch {
                          // ignore
                      }
                      fireAndForget(stopServerReachabilitySupervisors(), { tag: 'Sync.stopServerReachabilitySupervisors' });
                  };
                  this.userRequestLeaseOwner.deferRoutineTeardown(teardownConnectivity);
                  if (nextAppState === 'inactive') {
                      this.scheduleNativeInactiveCheckpoint();
                  } else {
                      this.clearNativeInactiveCheckpointTimer();
                      this.flushBackgroundSyncCheckpointsNow();
                  }
              }
          });

          // Web: AppState events are not always reliable when tabs are backgrounded. Mirror the
          // pause/resume behavior using document visibility.
          if (!isEmbedWindowContext() && Platform.OS === 'web' && !this.usesPersistentDesktopSync) {
              const doc = (globalThis as unknown as { document?: any }).document;
              if (doc && typeof doc.addEventListener === 'function' && typeof doc.removeEventListener === 'function') {
                  const pauseForWebBackground = (tag: string) => {
                      this.isForeground = false;
                      this.pauseController.pause();
                      this.flushBackgroundSyncCheckpointsNow();
                      const teardownConnectivity = () => {
                          this.markNativeCryptoWorkerBackgroundQuiescent();
                          setServerReachabilityNetworkAllowed(false);
                          try {
                              this.disconnectSocketIntentionally();
                          } catch {
                              // ignore
                          }
                          fireAndForget(stopServerReachabilitySupervisors(), { tag });
                      };
                      this.userRequestLeaseOwner.deferRoutineTeardown(teardownConnectivity);
                  };
                  const pauseForWebHardBoundary = (tag: string) => {
                      this.isForeground = false;
                      this.markNativeCryptoWorkerBackgroundQuiescent();
                      this.pauseController.pause();
                      this.flushBackgroundSyncCheckpointsNow();
                      this.userRequestLeaseOwner.crossHardBoundary(() => {
                          setServerReachabilityNetworkAllowed(false);
                          try {
                              this.disconnectSocketIntentionally();
                          } catch {
                              // ignore
                          }
                          fireAndForget(stopServerReachabilitySupervisors(), { tag });
                      });
                  };
                  const resumeForWebForeground = (tag: string) => {
                      this.userRequestLeaseOwner.cancelDeferredRoutineTeardown();
                      this.isForeground = true;
                      this.resumeNativeCryptoWorkerDispatchAfterForeground(`${tag}.nativeCryptoWorkerQueue`);
                      setServerReachabilityNetworkAllowed(true);
                      this.pauseController.resume();
                      fireAndForget(invalidateAllServerReachabilitySupervisors(), { tag: `${tag}.reachability` });
                      this.resumeAfterForegroundTransition(tag);
                  };
                  const onVisibilityChange = () => {
                      const state = String(doc.visibilityState ?? '').trim().toLowerCase();
                      if (state === 'hidden' || state === 'visible') {
                          const nextIsForeground = state === 'visible';
                          if (this.isForeground === nextIsForeground) {
                              return;
                          }
                      }
                      if (state === 'hidden') {
                          pauseForWebBackground('Sync.stopServerReachabilitySupervisors.visibility');
                          return;
                      }
                      if (state === 'visible') {
                          resumeForWebForeground('Sync.resumeSync.visibility');
                      }
                  };
                  const onPageHide = () => {
                      pauseForWebHardBoundary('Sync.stopServerReachabilitySupervisors.pagehide');
                  };
                  const onPageShow = (event?: { persisted?: boolean }) => {
                      const state = String(doc.visibilityState ?? '').trim().toLowerCase();
                      if (event?.persisted === true || state === 'visible') {
                          resumeForWebForeground('Sync.resumeSync.pageshow');
                      }
                  };
                  const onFreeze = () => {
                      pauseForWebHardBoundary('Sync.stopServerReachabilitySupervisors.freeze');
                  };
                  const onResume = () => {
                      resumeForWebForeground('Sync.resumeSync.page-lifecycle-resume');
                  };
                  const startWebLifecycleHeartbeat = () => {
                      if (this.webLifecycleHeartbeatTimer) return;
                      this.webLifecycleHeartbeatLastNowMs = Date.now();
                      this.webLifecycleHeartbeatTimer = setInterval(() => {
                          const previous = this.webLifecycleHeartbeatLastNowMs ?? Date.now();
                          const now = Date.now();
                          this.webLifecycleHeartbeatLastNowMs = now;
                          this.evaluateSafeCursorLagTripwireNow(now);
                          const elapsedMs = now - previous;
                          if (elapsedMs < this.syncTuning.webLifecycleHeartbeatDriftMs) {
                              return;
                          }
                          const state = String(doc.visibilityState ?? '').trim().toLowerCase();
                          if (state === 'visible') {
                              resumeForWebForeground('Sync.resumeSync.lifecycle-heartbeat');
                          }
                      }, this.syncTuning.webLifecycleHeartbeatTickMs);
                      try {
                          (this.webLifecycleHeartbeatTimer as unknown as { unref?: () => void }).unref?.();
                      } catch {
                          // ignore
                      }
                  };
                  try {
                      doc.addEventListener('visibilitychange', onVisibilityChange);
                  } catch {
                      // ignore
                  }
                  const eventTarget = globalThis as unknown as {
                      addEventListener?: (event: string, listener: (event?: { persisted?: boolean }) => void) => void;
                  };
                  try {
                      eventTarget.addEventListener?.('pagehide', onPageHide);
                      eventTarget.addEventListener?.('pageshow', onPageShow);
                      eventTarget.addEventListener?.('freeze', onFreeze);
                      eventTarget.addEventListener?.('resume', onResume);
                  } catch {
                      // ignore
                  }
                  startWebLifecycleHeartbeat();
                  if (doc.wasDiscarded === true) {
                      syncReliabilityTelemetry.recordCritical('sync.webPage.wasDiscarded', {
                          visibilityState: String(doc.visibilityState ?? ''),
                      });
                      const state = String(doc.visibilityState ?? '').trim().toLowerCase();
                      if (state !== 'hidden') {
                          resumeForWebForeground('Sync.resumeSync.document-was-discarded');
                      }
                  }
                  // Seed initial visibility state so a tab that starts hidden is treated as backgrounded immediately.
                  try {
                      onVisibilityChange();
                  } catch {
                      // ignore
                  }
              }
          }
      }

	      public getSyncTuning(): SyncTuning {
	          return this.syncTuning;
	      }

      private resolveSessionListScrollIdleWaiters(): void {
          const waiters = this.sessionListScrollIdleResolvers.splice(0, this.sessionListScrollIdleResolvers.length);
          for (const resolve of waiters) {
              resolve();
          }
      }

      private clearSessionListScrollActivity(): void {
          if (this.sessionListScrollSettleTimer) {
              clearTimeout(this.sessionListScrollSettleTimer);
              this.sessionListScrollSettleTimer = null;
          }
          this.sessionListScrollActive = false;
          this.sessionListScrollActiveUntilMs = 0;
          this.resolveSessionListScrollIdleWaiters();
      }

      private scheduleSessionListScrollSettleTimer(delayMs: number): void {
          if (this.sessionListScrollSettleTimer) return;
          const safeDelayMs = Math.max(0, Math.trunc(delayMs));
          this.sessionListScrollSettleTimer = setTimeout(() => {
              this.sessionListScrollSettleTimer = null;
              const remainingMs = this.sessionListScrollActiveUntilMs - Date.now();
              if (remainingMs > 0) {
                  this.scheduleSessionListScrollSettleTimer(remainingMs);
                  return;
              }
              this.sessionListScrollActive = false;
              this.resolveSessionListScrollIdleWaiters();
          }, safeDelayMs);
      }

      public markSessionListScrollActivity(): void {
          this.sessionListScrollActive = true;
          this.sessionListScrollActiveUntilMs = Date.now() + SESSION_LIST_BACKGROUND_HYDRATION_SCROLL_SETTLE_MS;
          this.scheduleSessionListScrollSettleTimer(SESSION_LIST_BACKGROUND_HYDRATION_SCROLL_SETTLE_MS);
      }

      private waitForSessionListScrollIdle = async (): Promise<void> => {
          if (!this.sessionListScrollActive) return;
          await new Promise<void>((resolve) => {
              this.sessionListScrollIdleResolvers.push(resolve);
          });
      };

	      private readSocketOfflineDurationMs(): number {
	          if (this.lastSocketDisconnectedAtMs != null) {
	              return Math.max(0, Date.now() - this.lastSocketDisconnectedAtMs);
	          }
	          return Math.max(0, this.lastSocketOfflineDurationMs ?? 0);
	      }

	      private readSocketOfflineDurationMsForSession(sessionId: string): number {
	          const offlineForMs = this.readSocketOfflineDurationMs();
	          if (offlineForMs <= 0) return 0;
	          if (
	              this.lastSocketDisconnectedAtMs == null
	              && this.socketOfflineCatchUpConsumedSessionIds.has(sessionId)
	          ) {
	              return 0;
	          }
	          return offlineForMs;
	      }

	      private markSocketOfflineCatchUpConsumedForSession(sessionId: string, offlineForMs: number): void {
	          if (!sessionId || offlineForMs <= 0 || this.lastSocketDisconnectedAtMs != null) return;
	          this.socketOfflineCatchUpConsumedSessionIds.add(sessionId);
	      }

      private connectSocketWithPostSubscriptionCatchUp(): void {
          if (this.socketStatus !== 'connected') {
              this.postSubscriptionChangesCatchUpPending = true;
          }
          apiSocket.connect();
      }

      private disconnectSocketIntentionally(options?: Readonly<{ preserveHttpRequests?: boolean }>): void {
          this.postSubscriptionChangesCatchUpPending = false;
          this.socketStatus = 'disconnected';
          apiSocket.disconnect(options);
      }

      private resumeAfterForegroundTransition(tag: string): void {
          const resume = this.resumeSync('app-foreground');
          fireAndForget(resume, { tag });
          try {
              this.connectSocketWithPostSubscriptionCatchUp();
          } catch {
              // The foreground resume still repairs the HTTP snapshot. A later successful connect
              // consumes the armed post-subscription catch-up demand.
          }
      }

      private getSessionMessagesPageOptions(sessionId: string, authority?: ServerAccountRequestAuthority, scopedRead?: Readonly<{
          serverId: string;
          encryption: Encryption | null;
          isCurrent: () => boolean;
      }>) {
          const embedScope = this.embedSessionScope;
          const encryption = scopedRead ? scopedRead.encryption : this.encryption;
          const generation = this.serverScopeGeneration;
          const lifetime = embedScope ? null : captureActiveServerAccountScopeCurrentness();
          const serverId = scopedRead?.serverId ?? embedScope?.endpointUrl ?? authority?.scope.serverId ?? resolvePreferredServerIdForSessionId(sessionId);
          const readTranscriptAuthorityKey = () => {
              const session = storage.getState().sessions[sessionId] ?? null;
              return session ? externalSessionTranscriptAuthorityKey(
                  this.resolveTranscriptAuthority(session, readExternalSessionLinkFromSession(session)),
              ) : null;
          };
          const transcriptAuthorityKey = readTranscriptAuthorityKey();
          const isCurrent = (): boolean => generation === this.serverScopeGeneration
              && (scopedRead ? scopedRead.isCurrent() : encryption === this.encryption
                  && (embedScope ? this.embedSessionScope === embedScope && embedScope.isCurrent() && sessionId === embedScope.scope.sessionId : lifetime?.isCurrent() === true))
              && readTranscriptAuthorityKey() === transcriptAuthorityKey
              && (!authority || this.isServerAccountSessionReadCurrent(authority, sessionId));
          return {
              isCurrent,
              applyMessageMetadata: (targetSessionId: string, metadataUpdates: readonly TranscriptMessageMetadataUpdate[]) => {
                  if (!isCurrent() || targetSessionId !== sessionId) return;
                  const session = storage.getState().sessions[sessionId] ?? null;
                  if (!session) return;
                  const link = readExternalSessionLinkFromSession(session);
                  const admittedUpdates = link
                      ? filterExternalSessionTranscriptAuthorityMessages(metadataUpdates, this.resolveTranscriptAuthority(session, link))
                      : metadataUpdates;
                  if (admittedUpdates.length > 0) storage.getState().applyMessages(sessionId, [], { metadataUpdates: admittedUpdates });
              },
              initialMessageDecryptBatchSize: this.syncTuning.initialMessageDecryptBatchSize,
              messageDecryptBatchSize: this.syncTuning.messageDecryptBatchSize,
              messageDecryptYieldDelayMs: this.syncTuning.messageDecryptYieldDelayMs,
              onContentAuthenticationFailure: (failedEncryption: SessionMessagesEncryption): void => {
                  if (!isCurrent()) return;
                  const session = storage.getState().sessions[sessionId];
                  if (!session || session.encryptionMode === 'plain') return;
                  if (scopedRead ? !areServerProfileIdentifiersEquivalent(session.serverId, serverId)
                      : serverId !== resolvePreferredServerIdForSessionId(sessionId)) return;
                  const currentEncryption = authority
                      ? this.getSessionMessagesEncryptionForAuthority(authority, sessionId)
                      : encryption?.getSessionEncryption(sessionId);
                  if (currentEncryption !== failedEncryption || session.encryptedContentAvailability === 'encrypted_content_unavailable') return;
                  this.applySessions([{ ...session, encryptedContentAvailability: 'encrypted_content_unavailable' }], 'projection');
              },
          };
      }

      private syncJsThreadLagTelemetryRuntime(): void {
          if (!syncPerformanceTelemetry.isEnabled()) {
              this.stopJsThreadLagTelemetryRuntime();
              return;
          }
          if (!this.jsThreadLagTelemetry) {
              this.jsThreadLagTelemetry = createJsThreadLagTelemetry({
                  telemetry: syncPerformanceTelemetry,
                  sampleIntervalMs: this.syncTuning.jsThreadLagTelemetrySampleIntervalMs,
                  flushIntervalMs: this.syncTuning.syncPerformanceTelemetryFlushIntervalMs,
                  thresholdMs: this.syncTuning.jsThreadLagTelemetryThresholdMs,
                  maxSamples: this.syncTuning.jsThreadLagTelemetryMaxSamples,
              });
          }
          this.jsThreadLagTelemetry.start();
      }

      private stopJsThreadLagTelemetryRuntime(): void {
          const telemetry = this.jsThreadLagTelemetry;
          if (!telemetry) return;
          const summary = telemetry.snapshot();
          telemetry.stop();
          if (summary.count > 0 && syncPerformanceTelemetry.isEnabled()) {
              telemetry.flushSummary();
          }
          telemetry.reset();
      }

      private markNativeCryptoWorkerBackgroundQuiescent(): void {
          Encryption.markNativeCryptoWorkerQueueQuiescent({
              telemetryEnabled: this.syncTuning.nativeCryptoWorkerTelemetryEnabled,
          });
      }

      private resumeNativeCryptoWorkerDispatchAfterForeground(tag: string): void {
          const activeEncryption = this.encryption;
          fireAndForget(Encryption.markNativeCryptoWorkerQueueActive({
              telemetryEnabled: this.syncTuning.nativeCryptoWorkerTelemetryEnabled,
              capabilityStalenessMs: this.syncTuning.nativeCryptoWorkerCapabilityStalenessMs,
              revalidationTimeoutMs: this.syncTuning.nativeCryptoWorkerTimeoutMs,
              revalidateCapabilities: this.syncTuning.nativeCryptoWorkerMode === 'off' || !activeEncryption
                  ? undefined
                  : async () => {
                      await activeEncryption.warmNativeCryptoWorkerForDiagnostics();
                  },
          }), { tag });
      }

    private configureEncryptionRuntime(encryption: Encryption, accountId: string): void {
          const configuredServerId = this.getAppliedTransportTarget()?.serverId
              ?? String(getActiveServerSnapshot().serverId ?? '').trim();
          const serverId = configuredServerId || null;
          encryption.configureAesBatchConcurrencyLimit(this.syncTuning.encryptionAesBatchConcurrencyLimit);
          // Routing is NOT set here. It arrives with the instance: Encryption resolves it
          // from SyncTuning at construction, so every instance — active, server-scoped RPC,
          // concurrent server — runs the same configured routing. This call owns only the
          // active account's scope binding. Re-declaring routing here is what made this the
          // one configured instance and left every other one on the built-in 'off'.
          encryption.configureNativeCryptoWorker({
              scope: {
                  accountId,
                  serverId,
                  generation: 0,
              },
          });
          if (this.syncTuning.nativeCryptoWorkerMode !== 'off') {
              void encryption.warmNativeCryptoWorkerForDiagnostics();
          }
      }

      /**
       * Supplies an additional endpoint supervisor to `getActiveEndpointAuthSupervisors`. Production never calls
       * this (the live supervisor comes from `getProductionActiveEndpointSupervisor`); it exists so tests can drive
       * auth/connectivity classification. It deliberately does NOT arm a resume: the "endpoint came back online →
       * resume" trigger is owned by `bindEndpointConnectivityStateToRealtimeStore({ onEndpointOnline })` →
       * `resumeSync('server-reachable')`, which is the binding that actually runs in production.
       */
      public setActiveEndpointSupervisor(supervisor: ManagedEndpointSupervisor | null): void {
          this.activeEndpointSupervisor = supervisor;
      }

    setMessageTransport(transport: SyncMessageTransport): void {
        this.messageTransport = transport;
    }

    resetMessageTransport(): void {
        this.messageTransport = createDefaultMessageTransport();
    }

    private captureAppliedServerTarget(target?: SyncServerTarget): SyncServerTarget {
        const snapshot = target ?? getActiveServerSnapshot();
        return {
            serverId: String(snapshot.serverId ?? '').trim(),
            serverUrl: String(snapshot.serverUrl ?? '').trim(),
            generation: snapshot.generation,
            ...(target?.runtimeOrigin ? { runtimeOrigin: target.runtimeOrigin } : {}),
            ...(target?.carrier ? { carrier: target.carrier } : {}),
            ...(target?.homeCarrier !== undefined ? { homeCarrier: target.homeCarrier } : {}),
        };
    }

    /**
     * The direct `apiSocket` is configured for this target, not the Home that is
     * currently staged in profile selection. Keep that distinction local to
     * Sync: connectionManager owns the public applied snapshot, while Sync
     * cannot import it without a cycle.
     */
    private getAppliedTransportTarget(): SyncServerTarget | null {
        const target = this.appliedServerTarget;
        if (!target || !target.serverId.trim() || !target.serverUrl.trim()) return null;
        return target;
    }

    /**
     * Terminal direct-transport errors belong to the immutable Sync target,
     * never to a Home that happens to be staged in selection. Exact outbox
     * callers pass their persisted scope explicitly.
     */
    private recordTerminalAuthSyncError(
        error: unknown,
        options?: Readonly<{ serverId?: string | null }>,
    ): void {
        const scopedServerId = String(options?.serverId ?? '').trim();
        const appliedServerId = String(this.getAppliedTransportTarget()?.serverId ?? '').trim();
        const serverId = scopedServerId || appliedServerId;
        storage.getState().setSyncError({
            message: error instanceof Error ? error.message : 'Authentication required',
            retryable: false,
            kind: 'auth',
            at: Date.now(),
            ...(serverId ? { serverId } : {}),
        });
    }

    /**
     * The focused switch already owns this prepared carrier. Feature refreshes
     * borrow it without taking a second lease, so a staged Home cannot replace
     * the bootstrap Home's feature request.
     */
    private createPreparedFeatureTransport(target: SyncServerTarget): ResolvedServerScopedTransport {
        return {
            canonicalServerUrl: target.serverUrl,
            runtimeOrigin: target.runtimeOrigin ?? target.serverUrl,
            carrier: target.carrier ?? 'https',
            ...(target.homeCarrier ? { homeCarrier: target.homeCarrier } : {}),
            release: async () => {},
        };
    }

    /**
     * Direct Sync HTTP is issued only through apiSocket's immutable prepared
     * configuration. The returned request remains safe to pass through an
     * asynchronous feature or storage decision: apiSocket refuses issuance
     * after a later Home has replaced that configuration.
     */
    private createAppliedTransportRequest(target: SyncServerTarget): ServerFetch {
        if (this.embedSessionScope) return this.embedSessionScope.request;
        return apiSocket.createRequestForPreparedTarget({
            endpoint: target.serverUrl,
            serverId: target.serverId,
            generation: target.generation,
            ...(target.runtimeOrigin ? { runtimeOrigin: target.runtimeOrigin } : {}),
            ...(target.carrier ? { carrier: target.carrier } : {}),
            ...(target.homeCarrier !== undefined ? { homeCarrier: target.homeCarrier } : {}),
        });
    }

    private createAppliedReadTransport(target: SyncServerTarget | null = this.getAppliedTransportTarget()) {
        if (this.embedSessionScope || !target) return undefined;
        return apiSocket.createReadTransportForPreparedTarget({
            endpoint: target.serverUrl, serverId: target.serverId, generation: target.generation,
            ...(target.runtimeOrigin ? { runtimeOrigin: target.runtimeOrigin } : {}),
            ...(target.carrier ? { carrier: target.carrier } : {}),
            ...(target.homeCarrier !== undefined ? { homeCarrier: target.homeCarrier } : {}),
        });
    }

    private createAppliedSettingsRequestContext(
        settingsScope: AccountSettingsScope | null | undefined,
    ): SyncSettingsParams['requestContext'] {
        const target = this.getAppliedTransportTarget();
        if (
            !settingsScope
            || !target
            || !areServerProfileIdentifiersEquivalent(settingsScope.serverId, target.serverId)
        ) {
            return undefined;
        }
        return {
            scope: settingsScope,
            endpointUrl: target.serverUrl,
            request: this.createAppliedTransportRequest(target),
        };
    }

    /**
     * Sync's direct Automation calls are incumbent transport work. Pair the
     * already-configured socket request with the same target identity used for
     * capability decisions so neither can follow a staged Home.
     */
    private createAppliedAutomationRequestContext(
        target: SyncServerTarget | null = this.getAppliedTransportTarget(),
    ): AutomationRequestContext {
        if (!target) {
            throw new Error('Applied Home transport is not ready');
        }
        return {
            request: this.createAppliedTransportRequest(target),
            serverId: target.serverId,
        };
    }

    private createAppliedTransportScopeGuard(target: SyncServerTarget): () => boolean {
        const serverScopeGuard = this.createServerScopeGuard();
        return () => serverScopeGuard() && this.isAppliedTransportTargetCurrent(target);
    }

    private prepareAppliedAutomationExecution(): Readonly<{
        requestContext: AutomationRequestContext;
        shouldContinue: () => boolean;
    }> {
        const target = this.getAppliedTransportTarget();
        if (!target) {
            throw new Error('Applied Home transport is not ready');
        }
        return {
            requestContext: this.createAppliedAutomationRequestContext(target),
            shouldContinue: this.createAppliedTransportScopeGuard(target),
        };
    }

    private isAppliedTransportTargetCurrent(target: SyncServerTarget): boolean {
        const current = this.getAppliedTransportTarget();
        return current !== null
            && current.serverId === target.serverId
            && current.serverUrl === target.serverUrl
            && current.generation === target.generation;
    }

    private isAppliedTransportServer(serverId: string | null | undefined): boolean {
        const target = this.getAppliedTransportTarget();
        return Boolean(
            target
            && areServerProfileIdentifiersEquivalent(serverId, target.serverId),
        );
    }

    private getActiveEndpointTarget(): { serverId: string; serverUrl: string } | null {
        const activeServer = this.getAppliedTransportTarget();
        const serverId = String(activeServer?.serverId ?? '').trim();
        const serverUrl = String(activeServer?.serverUrl ?? '').trim();
        if (!serverId || !serverUrl) {
            return null;
        }
        return { serverId, serverUrl };
    }

    private getProductionActiveEndpointSupervisor(): ManagedEndpointSupervisor | null {
        const target = this.getActiveEndpointTarget();
        if (!target) {
            return null;
        }
        const { serverId, serverUrl } = target;
        return getEndpointSupervisorForServer({ serverId, serverUrl });
    }

    private getActiveEndpointAuthSupervisors(): ManagedEndpointSupervisor[] {
        return [
            this.activeEndpointSupervisor,
            this.getProductionActiveEndpointSupervisor(),
        ].filter((supervisor, index, supervisors): supervisor is ManagedEndpointSupervisor =>
            Boolean(supervisor) && supervisors.indexOf(supervisor) === index,
        );
    }

    private async assertActiveEndpointAuthenticated(options?: Readonly<{ forceProbe?: boolean }>): Promise<void> {
        const embedScope = this.embedSessionScope;
        if (embedScope) {
            if (!embedScope.isCurrent()) throw new StaleServerGenerationError();
            if (options?.forceProbe === true) {
                const response = await embedScope.request('/v2/cursor');
                if (response.status === 401) throw createNotAuthenticatedError();
            }
            if (this.embedSessionScope !== embedScope || !embedScope.isCurrent()) throw new StaleServerGenerationError();
            return;
        }
        if (isEmbedWindowContext()) throw new StaleServerGenerationError();
        const target = this.getActiveEndpointTarget();
        if (target) {
            assertServerReachabilityAuthenticated(target.serverUrl, this.credentials?.token ?? null);
        }

        const supervisors = this.getActiveEndpointAuthSupervisors();
        if (supervisors.some((supervisor) => supervisor.getState().phase === 'auth_failed')) {
            throw createNotAuthenticatedError();
        }
        if (options?.forceProbe !== true) {
            return;
        }

        const targetToAcquire = supervisors.length === 0 ? target : null;
        const acquiredHandle = targetToAcquire
            ? await acquireEndpointSupervisor({ serverId: targetToAcquire.serverId, endpoint: targetToAcquire.serverUrl })
            : null;

        try {
            const supervisorsToProbe = acquiredHandle ? [...supervisors, acquiredHandle.supervisor] : supervisors;
            const timeoutMs = readUserSendNoAckAuthProbeTimeoutMs();
            for (const supervisor of supervisorsToProbe) {
                const current = supervisor.getState();
                if (current.phase === 'auth_failed') {
                    throw createNotAuthenticatedError();
                }
                if (current.phase === 'online') {
                    supervisor.invalidate();
                    const next = await waitForEndpointProbeToSettle(supervisor, timeoutMs);
                    if (next.phase === 'auth_failed') {
                        throw createNotAuthenticatedError();
                    }
                    continue;
                }
                if (current.phase === 'connecting') {
                    const next = await waitForEndpointProbeToSettle(supervisor, timeoutMs);
                    if (next.phase === 'auth_failed') {
                        throw createNotAuthenticatedError();
                    }
                }
            }
        } finally {
            if (acquiredHandle) {
                await acquiredHandle.release().catch(() => {});
            }
        }
    }

    private getWebSyncClientIdentity(): WebSyncClientIdentity | null {
        if (isEmbedWindowContext() || this.embedSessionScope) return null;
        if (Platform.OS !== 'web' || isDesktopHost()) return null;
        if (this.webSyncClientIdentity) return this.webSyncClientIdentity;
        if (typeof globalThis.sessionStorage === 'undefined' || typeof globalThis.localStorage === 'undefined') {
            return null;
        }

        try {
            const identity = resolveWebSyncClientIdentity({
                sessionStorage: globalThis.sessionStorage,
                localStorage: globalThis.localStorage,
                nowMs: Date.now(),
                liveTtlMs: this.syncTuning.webSyncInstanceLiveTtlMs,
            });
            this.webSyncClientIdentity = identity;
            if (!this.webSyncClientIdentityHeartbeatTimer) {
                const timer = setInterval(() => {
                    identity.heartbeat(Date.now());
                }, this.syncTuning.webSyncInstanceHeartbeatMs);
                try {
                    (timer as unknown as { unref?: () => void }).unref?.();
                } catch {
                    // ignore
                }
                this.webSyncClientIdentityHeartbeatTimer = timer;
            }
            return identity;
        } catch {
            return null;
        }
    }

    private buildCursorScopeForServer(serverScopeRaw: string | null | undefined): ChangesCursorScope | null {
        if (this.embedSessionScope) return null;
        const scope = String(serverScopeRaw ?? '').trim();
        const accountId = String(this.serverID ?? '').trim();
        if (!scope || !accountId) return null;
        const identity = this.getWebSyncClientIdentity();
        if (!identity) return { serverScope: scope, accountId };
        return { serverScope: scope, accountId, instanceId: identity.instanceId };
    }

    private getChangesCursorScope(): ChangesCursorScope | null {
        return this.buildCursorScopeForServer(
            this.getAppliedTransportTarget()?.serverId
            ?? String(getActiveServerSnapshot().serverId ?? '').trim(),
        );
    }

    private getExternalSessionCursorScope(sessionId: string): ChangesCursorScope | null {
        return this.buildCursorScopeForServer(
            this.getExternalSessionServerScope(sessionId)
            ?? this.getAppliedTransportTarget()?.serverId
            ?? String(getActiveServerSnapshot().serverId ?? '').trim(),
        );
    }

    private clearActiveAccountSettingsScope(): void {
        this.projectAccountRowsRuntime = null;
        storage.getState().clearProjectAccountRowsScope();
        this.authoringMemoryRuntime = null;
        storage.getState().resetAuthoringMemory();
        this.flushSessionMaterializedMaxSeqForCurrentScopeNow();
        this.pendingSettings = {};
        this.pendingSettingsScope = null;
        this.sessionMaterializedMaxSeqById = {};
        this.deferredTranscriptState = createDeferredTranscriptState();
        this.deferredSessionStateHydrationState = createDeferredSessionStateHydrationState();
        this.notifiedReadySeqByAddressKey = {};
        storage.getState().clearSettingsScope();
        storage.getState().clearProfileScope();
        storage.getState().clearSessionLocalStateScope();
        storage.getState().resetAccountSettingsSyncStatus();
    }

    private async activateAccountSettingsScope(accountId: string): Promise<AccountSettingsScope | null> {
        const serverId = this.getAppliedTransportTarget()?.serverId
            ?? String(getActiveServerSnapshot().serverId ?? '').trim();
        const scope = createAccountSettingsScope(serverId, accountId);
        if (!scope) {
            this.clearActiveAccountSettingsScope();
            return null;
        }

        if (!areAccountSettingsScopesEqual(this.pendingSettingsScope, scope)) {
            this.projectAccountRowsRuntime = null;
            this.authoringMemoryRuntime = null;
            storage.getState().resetAuthoringMemory();
            this.flushSessionMaterializedMaxSeqForCurrentScopeNow();
            storage.getState().resetAccountSettingsSyncStatus();
        }
        const legacyScopes = getServerProfileLegacyServerIds(serverId)
            .map((legacyServerId) => createAccountSettingsScope(legacyServerId, accountId))
            .filter((legacyScope): legacyScope is AccountSettingsScope => legacyScope !== null);
        migratePendingSetupIntentScopes(scope, legacyScopes);
        migratePendingTerminalConnectScopes(scope, legacyScopes);
        migratePendingNotificationActionScopes(scope, legacyScopes);
        migratePendingNotificationNavScopes(scope, legacyScopes);
        await storage.getState().activateSettingsScope(scope, legacyScopes);
        this.hydrateAuthoringMemoryProjection(scope);
        storage.getState().activateProfileScope(scope, legacyScopes);
        storage.getState().activateProjectAccountRowsScope(scope);
        storage.getState().activateSessionLocalStateScope(scope);
        this.pendingSettings = loadPendingAccountSettings(scope);
        this.pendingSettingsScope = scope;
        this.sessionMaterializedMaxSeqById = loadSessionMaterializedMaxSeqById(scope);
        this.deferredTranscriptState = createDeferredTranscriptState();
        this.deferredSessionStateHydrationState = createDeferredSessionStateHydrationState();
        this.notifiedReadySeqByAddressKey = {};
        this.sessionMaterializedMaxSeqDirty = false;
        dbgSettings('Sync.activateAccountSettingsScope: loaded pendingSettings', {
            scope,
            pendingKeys: Object.keys(this.pendingSettings).sort(),
        });
        return scope;
    }

    private parseAccountIdForSettingsScope(
        credentials: AuthCredentials,
        context: string,
    ): string | null {
        try {
            return parseToken(credentials.token);
        } catch (error) {
            this.clearActiveAccountSettingsScope();
            warnSettings('Sync.activateAccountSettingsScopeForCredentials: invalid token', {
                context,
                error: error instanceof Error ? error.message : 'Unknown error',
            });
            return null;
        }
    }

    private async activateAccountSettingsScopeForCredentials(credentials: AuthCredentials): Promise<AccountSettingsScope | null> {
        const accountId = this.parseAccountIdForSettingsScope(credentials, 'activate');
        return accountId ? this.activateAccountSettingsScope(accountId) : null;
    }

    private async configureSettingsSecretKeys(
        credentials: AuthCredentials,
        scope: AccountSettingsScope | null,
    ): Promise<void> {
        if (!scope) {
            this.settingsSecretsKey = null;
            this.settingsSecretsReadKeys = [];
            return;
        }
        try {
            const keySet = await resolveSettingsSecretsKeySet({ credentials, scope });
            this.settingsSecretsKey = keySet?.writeKey ?? null;
            this.settingsSecretsReadKeys = keySet?.readKeys ?? [];
        } catch {
            this.settingsSecretsKey = null;
            this.settingsSecretsReadKeys = [];
        }
    }

    private flushPendingSettingsForCurrentScopeNow(): void {
        if (this.pendingSettingsFlushTimer) {
            clearTimeout(this.pendingSettingsFlushTimer);
            this.pendingSettingsFlushTimer = null;
        }
        this.pendingSettingsDirty = false;
        if (!this.pendingSettingsScope) return;
        savePendingAccountSettings(this.pendingSettingsScope, this.pendingSettings);
    }

    private schedulePendingSettingsFlush = () => {
        scheduleDebouncedPendingSettingsFlush({
            getTimer: () => this.pendingSettingsFlushTimer,
            setTimer: (timer) => {
                this.pendingSettingsFlushTimer = timer;
            },
            markDirty: () => {
                this.pendingSettingsDirty = true;
            },
            consumeDirty: () => {
                if (!this.pendingSettingsDirty) {
                    return false;
                }
                this.pendingSettingsDirty = false;
                return true;
            },
            flush: () => {
                // Persist pending settings for crash/restart safety.
                if (this.pendingSettingsScope) {
                    savePendingAccountSettings(this.pendingSettingsScope, this.pendingSettings);
                }
                // Trigger server sync (can be retried later).
                this.settingsSync.invalidate();
            },
            delayMs: ACCOUNT_SETTINGS_QUIET_FLUSH_DELAY_MS,
        });
    };

    async create(credentials: AuthCredentials, encryption: Encryption | null, target?: SyncServerTarget, options?: SyncCreateOptions) {
        if (options && 'accountId' in options && options.scope.kind === 'embedSession') {
            const previousScope = this.embedSessionScope;
            const sameSessionScope = previousScope !== null
                && previousScope.scope.sessionId === options.scope.sessionId
                && previousScope.accountId === options.accountId
                && previousScope.endpointUrl === options.endpointUrl
                && previousScope.accountMode === options.accountMode;
            const renewalCursor = sameSessionScope && previousScope.approvalGranted === options.approvalGranted
                && storage.getState().isDataReady ? this.changesCursor : null;
            this.disposeEmbedSession({ preserveSessionState: sameSessionScope });
            if (Object.keys(storage.getState().sessions).some((sessionId) => sessionId !== options.scope.sessionId)) {
                storage.setState({ sessions: {}, projectAuthoringSessions: EMPTY_PROJECT_AUTHORING_SESSION_INPUTS, sessionMessages: {}, sessionUserMessageHistory: {}, sessionPending: {}, isDataReady: false, isSessionDraftsReady: false });
                this.sessionViewport.clear();
            }
            const controller = new AbortController();
            const endpointRequest = createServerFetchAtEndpoint({
                endpointUrl: options.endpointUrl, credentials, signal: controller.signal,
                isCurrent: () => this.embedSessionScope?.controller === controller && options.isCurrent(),
            });
            const sessionPath = encodeURIComponent(options.scope.sessionId);
            const embedOptions = options;
            const sync = this;
            function request(path: string, init?: RequestInit, requestOptions?: ServerFetchOptions): Promise<Response>;
            function request<T>(path: string, init: RequestInit | undefined, requestOptions: ServerFetchOptions | undefined, consumeResponse: (response: Response) => Promise<T>): Promise<T>;
            async function request<T>(path: string, init?: RequestInit, requestOptions?: ServerFetchOptions, consumeResponse?: (response: Response) => Promise<T>): Promise<Response | T> {
                const url = new URL(path, embedOptions.endpointUrl);
                const method = (init?.method ?? 'GET').toUpperCase();
                const read = method === 'GET';
                const permitted = url.origin === new URL(embedOptions.endpointUrl).origin && (
                    read && (url.pathname === '/v1/features' || url.pathname === '/v2/cursor'
                        || url.pathname === `/v2/sessions/${sessionPath}`
                        || url.pathname === `/v1/sessions/${sessionPath}/messages`
                        || url.pathname.startsWith(`/v2/sessions/${sessionPath}/messages/by-local-id/`)
                        || url.pathname === `/v1/sessions/${sessionPath}/turns`
                        || url.pathname === '/v2/changes' && url.searchParams.get('sessionId') === embedOptions.scope.sessionId)
                    || (url.pathname === `/v2/sessions/${sessionPath}/pending` || url.pathname.startsWith(`/v2/sessions/${sessionPath}/pending/`))
                    || method === 'POST' && /^\/v1\/actions\/[^/]+$/.test(url.pathname)
                );
                if (!permitted) throw new Error('Request is outside the embed Session corridor');
                const observe = (response: Response) => {
                    if (response.status === 401 && sync.embedSessionScope?.controller === controller && embedOptions.isCurrent()) embedOptions.onCredentialRejected?.();
                };
                if (consumeResponse) return await endpointRequest(path, init, requestOptions, async response => {
                    observe(response);
                    return await consumeResponse(response);
                });
                const response = await endpointRequest(path, init, requestOptions);
                observe(response);
                return response;
            }
            const scope = {
                ...options,
                controller,
                request,
                approvalsSync: new InvalidateSync(async () => {
                    if (this.embedSessionScope?.controller !== controller || !options.isCurrent()) return;
                    await this.refreshEmbedSessionApprovals();
                }, { pause: this.pauseController, onError: error => {
                    if (this.embedSessionScope?.controller === controller && options.isCurrent()) this.reportSyncError(error);
                } }),
            };
            this.embedSessionScope = scope;
            this.appliedServerTarget = { serverId: options.endpointUrl, serverUrl: options.endpointUrl, generation: this.serverScopeGeneration };
            this.credentials = credentials;
            this.encryption = encryption;
            this.serverID = options.accountId;
            this.anonID = '';
            this.changesCursor = renewalCursor;
            this.pauseController.resume();
            if (encryption) this.configureEncryptionRuntime(encryption, options.accountId);
            if (!this.updatesSubscribed) {
                this.subscribeToUpdates();
                this.updatesSubscribed = true;
            }
            this.postSubscriptionChangesCatchUpPending = true;
            apiSocket.initialize({ endpoint: options.endpointUrl, token: credentials.token,
                serverId: options.endpointUrl, generation: this.serverScopeGeneration,
                socketRole: { clientType: 'session-scoped', sessionId: options.scope.sessionId },
                request: scope.request, isCurrent: () => this.embedSessionScope === scope && options.isCurrent(),
                onCredentialRejected: () => { if (this.embedSessionScope === scope && options.isCurrent()) options.onCredentialRejected?.(); },
            }, encryption);
            if (renewalCursor !== null) {
                // Renew the authority and capability projection, then recover the disconnect
                // window through the existing cursor owner instead of bootstrapping history.
                await this.refreshEmbedSessionSnapshot({ detailOnly: true });
                if (this.embedSessionScope === scope && options.isCurrent()) await this.resumeSync('changes-catch-up');
            } else {
                await this.bootstrapSync();
            }
            return;
        }
        if (isEmbedWindowContext()) throw new Error('Embed sync requires a Session scope');
        this.disposeEmbedSession();
        const appliedServerTarget = this.captureAppliedServerTarget(target);
        const accountId = this.parseAccountIdForSettingsScope(credentials, 'create');
        if (!accountId) throw new Error('Invalid auth token');
        // The socket is already configured for this prepared target. Bind the
        // matching Sync authority before publishing its credentials or awaiting
        // any bootstrap helper, so no request can combine the former Home with
        // this Home's bearer.
        this.appliedServerTarget = appliedServerTarget;
        this.credentials = credentials;
        this.encryption = encryption;
        if (encryption) {
            this.configureEncryptionRuntime(encryption, accountId);
        }
        this.anonID = encryption?.anonID ?? '';
        this.serverID = accountId;
        if (this.anonID) {
            initializeTracking(this.anonID);
        }
        setWarmCacheAccountScope(this.serverID);
        this.hydrateWarmCachesForActiveServer({
            serverId: appliedServerTarget.serverId,
            accountId,
            preserveFetchedState: true,
        });
        const settingsScope = await this.activateAccountSettingsScope(accountId);
        this.changesCursor = loadChangesCursor(this.getChangesCursorScope());
        this.publishedAccountChangeCursors = new Map();
        await this.configureSettingsSecretKeys(credentials, settingsScope);
        this.syncJsThreadLagTelemetryRuntime();
        assertSyncServerTargetCurrent(appliedServerTarget);
        await this.#init();
        assertSyncServerTargetCurrent(appliedServerTarget);

        // UX: avoid blocking login forever if initial sync fetches hang/retry indefinitely.
        // We still kick off the sync work in #init(); this just bounds the time we block the login call.
        const initialAwaitTimeoutMs = 2500;
        await Promise.all([
            this.settingsSync.awaitQueue({ timeoutMs: initialAwaitTimeoutMs }),
            this.profileSync.awaitQueue({ timeoutMs: initialAwaitTimeoutMs }),
            this.purchasesSync.awaitQueue({ timeoutMs: initialAwaitTimeoutMs }),
        ]);
        fireAndForget(
            refreshAuthenticatedServerFeaturesSnapshot({
                credentials,
                force: true,
                serverId: appliedServerTarget.serverId,
                scopedTransport: this.createPreparedFeatureTransport(appliedServerTarget),
            }),
            { tag: 'Sync.refreshAuthenticatedServerFeatures.create' },
        );
    }

    /** Retire the exact frame authority before a replacement can issue requests. */
    public disposeEmbedSession(options?: Readonly<{ preserveSessionState?: boolean }>): void {
        const scope = this.embedSessionScope;
        if (!scope) return;
        this.embedSessionScope = null;
        scope.approvalsSync.stop();
        scope.controller.abort('embed-session-retired');
        this.serverScopeGeneration += 1;
        this.userRequestLeaseOwner.crossHardBoundary(() => this.disconnectSocketIntentionally());
        apiSocket.disposeScopedAuthority();
        for (const hydration of this.sessionByIdHydrationInFlight.values()) hydration.invalidate();
        this.sessionByIdHydrationInFlight.clear();
        for (const unit of this.messagesSync.values()) unit.stop();
        this.messagesSync.clear();
        for (const timer of this.pendingMessageCommitRetryTimers.values()) clearTimeout(timer);
        for (const timer of this.pendingOutboxOperationRetryTimers.values()) clearTimeout(timer);
        this.pendingMessageCommitRetryTimers.clear();
        this.pendingOutboxOperationRetryTimers.clear();
        dropSocketSessionWork(scope.scope.sessionId);
        this.activityAccumulator.reset();
        for (const key of this.sessionDataKeys.values()) key.fill(0);
        this.sessionDataKeys.clear();
        this.sessionDataKeyEnvelopes.clear();
        this.encryption?.removeSessionEncryption(scope.scope.sessionId);
        this.encryptionCache.clearAll();
        this.encryption = null;
        this.credentials = { token: '' };
        this.serverID = '';
        this.appliedServerTarget = null;
        this.activeServerSessionIds.clear();
        this.changesCursor = null;
        this.resumeInFlight = null;
        this.changesCatchUpQueuedAfterResume = false;
        this.postSubscriptionChangesCatchUpPending = false;
        if (options?.preserveSessionState !== true) {
            clearEmbedMemoryStorage();
            clearEmbedBrowserRecords();
            this.resetSessionTranscriptState(scope.scope.sessionId);
            this.sessionViewport.clear();
            storage.setState({ sessions: {}, projectAuthoringSessions: EMPTY_PROJECT_AUTHORING_SESSION_INPUTS, sessionMessages: {}, sessionUserMessageHistory: {}, sessionPending: {}, isDataReady: false, isSessionDraftsReady: false });
        }
    }

    private async withSessionRequestLifetime<TResult>(
        signal: AbortSignal | undefined,
        operation: (signal: AbortSignal | undefined) => Promise<TResult>,
        requestScope?: ServerAccountScope,
    ): Promise<TResult> {
        const embed = this.embedSessionScope;
        if (embed) {
            const cancellation = mergeAbortSignals([embed.controller.signal, signal]);
            try { return await operation(cancellation.signal); }
            finally { cancellation.dispose(); }
        }
        const scope = requestScope ?? getActiveServerAccountScope();
        if (!scope) return await operation(signal);
        return await runWithServerAccountScopeRequestGuard({ scope, signal,
            isCurrent: this.createServerScopeGuard(), staleError: () => new StaleServerGenerationError(),
        }, async guard => {
            guard.check();
            return await operation(guard.signal);
        });
    }

    public getSessionAttachmentTransferContext(sessionId: string, options?:
        | Readonly<{ purpose: 'attachmentPreview' }>
        | Readonly<{ purpose: 'attachmentUpload'; target: ExactSessionMachineTargetIdentity }>
    ): SessionAttachmentTransferContext | undefined {
        const scope = this.embedSessionScope;
        if (!scope) {
            if (isEmbedWindowContext()) return undefined;
            const target = options?.purpose === 'attachmentUpload' ? options.target : null;
            if ((!target && options?.purpose !== 'attachmentPreview') || !this.credentials?.token) return undefined;
            if (target ? target.sessionId !== sessionId : !storage.getState().sessions[sessionId]) return undefined;
            const current = this.createServerScopeGuard();
            const lifetime = captureActiveServerAccountScopeCurrentness();
            const encryption = this.encryption;
            const isCurrent = () => current() && lifetime.isCurrent() && this.encryption === encryption;
            return { kind: 'sessionBound', sessionId, call: async <T>(method: string, request: unknown, signal?: AbortSignal | null): Promise<T> => {
                if (!isCurrent()) throw new StaleServerGenerationError();
                const transferRouting = createSessionAttachmentTransferRouting(sessionId, method);
                const response = await this.withSessionRequestLifetime(signal ?? undefined, ownedSignal => target
                    ? sessionRpcWithServerAccountScope<T, unknown>({ sessionId, scope: target, method, payload: request,
                        signal: ownedSignal, transferRouting })
                    : sessionRpcWithPreferredSessionScope<T, unknown>({ sessionId, method, payload: request,
                        signal: ownedSignal, transferRouting }), target ?? undefined);
                if (!isCurrent()) throw new StaleServerGenerationError();
                return response;
            } };
        }
        if (scope.scope.sessionId !== sessionId || !scope.isCurrent()) return undefined;
        if (options?.purpose === 'attachmentUpload'
            && (options.target.accountId !== scope.accountId
                || !areServerProfileIdentifiersEquivalent(options.target.serverId, scope.endpointUrl))) return undefined;
        return {
            kind: 'sessionBound', sessionId,
            call: async <T>(method: string, request: unknown, signal?: AbortSignal | null): Promise<T> => {
                if (this.embedSessionScope !== scope || !scope.isCurrent()) throw new StaleServerGenerationError();
                const response = await this.withSessionRequestLifetime(signal ?? undefined,
                    ownedSignal => apiSocket.sessionRPC<T, unknown>(sessionId, method, request, { signal: ownedSignal,
                        transferRouting: createSessionAttachmentTransferRouting(sessionId, method) }));
                if (this.embedSessionScope !== scope || !scope.isCurrent()) throw new StaleServerGenerationError();
                return response;
            },
        };
    }

    public getEmbedSessionRequestContext() {
        const scope = this.embedSessionScope;
        const credentials = this.credentials;
        if (!scope || !scope.isCurrent() || !credentials) return null;
        const revision = this.serverScopeGeneration;
        const isCurrent = () => this.embedSessionScope === scope && scope.isCurrent();
        return { serverId: scope.endpointUrl, accountId: scope.accountId, sessionId: scope.scope.sessionId,
            credentials, request: scope.request,
            revision, isCurrent,
            onActionAcknowledged: (actionId: string, result: unknown) => {
                if (!isCurrent()) return;
                const session = storage.getState().sessions[scope.scope.sessionId];
                if (!session) return;
                const previous = session.composerOptionsInput ?? scope.composerOptionsInput ?? {};
                const next = applyComposerControlAcknowledgementV1({ sessionId: session.id, options: previous, actionId, result });
                if (next === previous) return;
                scope.composerOptionsInput = projectComposerOptionsInputV1(next, scope.composerOptionsGrant ?? null);
                this.applySessions([{ ...session, composerOptionsInput: scope.composerOptionsInput }], 'projection');
            },
            onRetire: (cancel: () => void) => {
                if (!isCurrent()) {
                    cancel();
                    return { dispose(): void {} };
                }
                scope.controller.signal.addEventListener('abort', cancel, { once: true });
                return { dispose: () => scope.controller.signal.removeEventListener('abort', cancel) };
            } };
    }

    private async refreshEmbedSessionSnapshot(options?: Readonly<{ detailOnly?: boolean }>): Promise<void> {
        const scope = this.embedSessionScope;
        if (!scope || !scope.isCurrent()) return;
        const shouldContinue = () => this.embedSessionScope === scope && scope.isCurrent() && !this.pauseController.isPaused();
        if (!shouldContinue()) return;
        const sessionId = scope.scope.sessionId;
        const hydration = await this.ensureSessionVisibleForMessageRoute(sessionId, {
            fresh: true, includeTurnsProjection: options?.detailOnly !== true, hydrateMessages: false,
            scopeCurrentness: shouldContinue,
        });
        if (!shouldContinue()) return;
        if (hydration.kind !== 'available') throw new Error(hydration.errorCode ?? 'Embed Session is unavailable');
        const session = storage.getState().sessions[sessionId];
        if (options?.detailOnly !== true && session && isSessionContentReadable(readSessionContentAvailability(session))) {
            await this.getOrCreateMessagesSync(sessionId).invalidateAndAwait();
            if (!shouldContinue()) return;
            await this.fetchPendingMessages(sessionId);
        }
    }

    private async refreshEmbedSessionApprovals(): Promise<void> {
        const scope = this.embedSessionScope;
        if (!scope || !scope.isCurrent()) return;
        const inventoryReadStartedWith = storage.getState().artifacts;
        const artifacts = scope.approvalGranted === true ? await fetchEmbedSessionApprovalArtifacts({
            request: scope.request,
            serverId: scope.endpointUrl,
            accountId: scope.accountId,
            sessionId: scope.scope.sessionId,
        }) : [];
        if (this.embedSessionScope !== scope || !scope.isCurrent()) return;
        storage.getState().applyArtifacts(
            artifacts,
            inventoryReadStartedWith,
            { approvalSessionIds: [scope.scope.sessionId] },
            'inventory',
        );
    }

    async restore(credentials: AuthCredentials, encryption: Encryption | null, target?: SyncServerTarget) {
        if (isEmbedWindowContext()) throw new Error('Embed sync requires a Session scope');
        const appliedServerTarget = this.captureAppliedServerTarget(target);
        const accountId = this.parseAccountIdForSettingsScope(credentials, 'restore');
        if (!accountId) throw new Error('Invalid auth token');
        this.appliedServerTarget = appliedServerTarget;
        this.credentials = credentials;
        this.encryption = encryption;
        // NOTE: No awaiting anything here, we're restoring from a disk (ie app restarted)
        // Purchases sync is invalidated in #init() and will complete asynchronously
        if (encryption) {
            this.configureEncryptionRuntime(encryption, accountId);
        }
        this.anonID = encryption?.anonID ?? '';
        this.serverID = accountId;
        if (this.anonID) {
            initializeTracking(this.anonID);
        }
        setWarmCacheAccountScope(this.serverID);
        this.hydrateWarmCachesForActiveServer({
            serverId: appliedServerTarget.serverId,
            accountId,
            preserveFetchedState: true,
        });
        const settingsScope = await this.activateAccountSettingsScope(accountId);
        this.changesCursor = loadChangesCursor(this.getChangesCursorScope());
        this.publishedAccountChangeCursors = new Map();
        await this.configureSettingsSecretKeys(credentials, settingsScope);
        this.syncJsThreadLagTelemetryRuntime();
        assertSyncServerTargetCurrent(appliedServerTarget);
        await this.#init();
        assertSyncServerTargetCurrent(appliedServerTarget);
        fireAndForget(
            refreshAuthenticatedServerFeaturesSnapshot({
                credentials,
                force: true,
                serverId: appliedServerTarget.serverId,
                scopedTransport: this.createPreparedFeatureTransport(appliedServerTarget),
            }),
            { tag: 'Sync.refreshAuthenticatedServerFeatures.restore' },
        );
    }

    /**
     * The local phase of restore: publish this Account/Home's persisted warm rows into
     * the store synchronously, before any carrier, socket or request exists.
     *
     * The warm cache is a local projection, so an unreachable Home (a failed Iroh
     * carrier, an offline network) must never stand between it and the list. Restore
     * and switch still call the same owner once their transport target is bound; the
     * `preserveFetchedState` guard keeps either call from overwriting fetched rows.
     */
    public hydrateLocalState(credentials: AuthCredentials, target?: SyncServerTarget): void {
        let accountId: string | null = null;
        try {
            accountId = parseToken(credentials.token);
        } catch {
            return;
        }
        const serverId = String(target?.serverId ?? getActiveServerSnapshot().serverId ?? '').trim();
        if (!serverId || !accountId) return;
        const settingsScope = createAccountSettingsScope(serverId, accountId);
        if (settingsScope) {
            if (!areAccountSettingsScopesEqual(this.pendingSettingsScope, settingsScope)) {
                this.authoringMemoryRuntime = null;
                this.projectAccountRowsRuntime = null;
                storage.getState().activateProjectAccountRowsScope(settingsScope);
            }
            this.hydrateAuthoringMemoryProjection(settingsScope);
        }
        setWarmCacheAccountScope(accountId);
        this.hydrateWarmCachesForActiveServer({ serverId, accountId, preserveFetchedState: true });
    }

    private hydrateWarmCachesForActiveServer(options?: Readonly<{
        serverId?: string;
        accountId?: string;
        preserveFetchedState?: boolean;
    }>): void {
        const serverId = options?.serverId
            ?? this.getAppliedTransportTarget()?.serverId
            ?? String(getActiveServerSnapshot().serverId ?? '').trim();
        const accountId = options?.accountId ?? resolveWarmCacheAccountScope(loadPersistedProfile().id);
        if (!serverId || !accountId) return;

        preparePluginUiProjectionWarmCacheEntries(serverId, accountId);
        const currentState = storage.getState();
        const shouldHydrateMachineDisplays = options?.preserveFetchedState !== true
            || Object.keys(currentState.machineDisplayById).length === 0;
        if (shouldHydrateMachineDisplays) {
            const machineDisplays = readWarmMachineDisplays({ profile: getServerProfileById(serverId),
                serverIdentityId: serverId, accountId, loadWarmEntries: loadMachineDisplayWarmCacheEntries });
            if (machineDisplays.length > 0) storage.getState().replaceMachineDisplays([...machineDisplays]);
        }

        const shouldHydrateSessionList = options?.preserveFetchedState !== true
            || (
                !this.hasFetchedSessionsSnapshotForActiveServer
                && Object.keys(storage.getState().sessionListRowsByServerId[serverId] ?? {}).length === 0
            );
        if (shouldHydrateSessionList) {
            const sessionEntries = loadSessionListWarmCacheEntries(serverId, accountId);
            if (Object.keys(sessionEntries).length > 0) {
                storage.getState().applyServerScopedSessionListRows(
                    serverId,
                    Object.values(sessionEntries).map((entry) => buildSessionListRenderableFromCacheEntry(entry)),
                    { source: 'ordinary', mode: 'replace' },
                );
            }
        }
        // Strict-query corpora the store does not hold yet come back as last-known membership
        // over the rows above; fetched memberships are never overwritten.
        storage.getState().restoreSessionListQueryMemberships(serverId, accountId);
    }

    /** Read only the already-bound exact-Home projection; this never acquires transport. */
    public readSessionSystemRecordObservation = (address: SessionAddress) => {
        for (const repository of this.sessionSystemRecordRepositories.values()) {
            if (!areServerProfileIdentifiersEquivalent(repository.scope.serverId, address.serverId)) continue;
            const authority = repository.readObservationAuthority(address);
            if (authority) return { ...authority, scope: repository.scope, session: address, repository };
        }
        return null;
    };

    /** Execute under one explicit Home/Account lease; no callback may retain request. */
    public withSessionSystemRecordRuntime = async <T>(
        address: SessionAddress,
        operation: (runtime: SessionSystemRecordRuntime) => Promise<T>,
        options?: Readonly<{ forceSessionRefresh?: boolean }>,
    ): Promise<SessionSystemRecordFetchResult<T>> => {
        const sessionAddress = normalizeSessionAddress(address.serverId, address.sessionId);
        if (!sessionAddress) return { status: 'forbidden' };
        let credentialCurrent = true;
        const unsubscribeCredentialChange = subscribeHomeCredentialChange(({ serverId }) => {
            if (areServerProfileIdentifiersEquivalent(serverId, sessionAddress.serverId)) credentialCurrent = false;
        });
        let repositoryCurrent = () => true;
        const isCurrent = () => credentialCurrent && repositoryCurrent();
        let authority: ServerAccountRequestAuthority;
        try {
            authority = await captureServerRequestAuthorityForServerAccountScope({
                serverId: sessionAddress.serverId,
                activeRequest: this.requestViaConfiguredSocket,
            });
        } catch {
            unsubscribeCredentialChange();
            return isCurrent() ? { status: 'offline' } : { status: 'forbidden' };
        }
        try {
            if (!isCurrent() || !areServerProfileIdentifiersEquivalent(authority.scope.serverId, sessionAddress.serverId)) return { status: 'forbidden' };
            if (!authority.context.credentials) return { status: 'forbidden' };
            const sessionEncryption = authority.context.encryption;
            let readSessionEncryption = () => sessionEncryption?.getSessionEncryption(sessionAddress.sessionId) ?? null;
            // Reuse the canonical exact-Session hydration and its in-flight
            // coalescer. Several record observers must not each perform another
            // full Session read merely to obtain mode/access/key context.
            const hydrated = await this.ensureSessionVisibleForMessageRoute(sessionAddress.sessionId, {
                serverId: sessionAddress.serverId,
                forceRefresh: options?.forceSessionRefresh === true,
                hydrateMessages: false,
                authority,
                scopeCurrentness: isCurrent,
                onHydratedSessionReader: reader => { readSessionEncryption = reader; },
            });
            if (!isCurrent()) return { status: 'forbidden' };
            if (hydrated.kind === 'missing') return hydrated.cause === 'not_found' ? { status: 'not_found' } : { status: 'forbidden' };
            if (hydrated.kind !== 'available') return hydrated.kind === 'retryable_failure'
                && (hydrated.cause === 'server_unavailable' || hydrated.cause === 'network')
                ? { status: 'offline' }
                : { status: 'invalid_response' };
            const session = storage.getState().sessions[sessionAddress.sessionId] ?? null;
            if (!session || !areServerProfileIdentifiersEquivalent(session.serverId, sessionAddress.serverId)) return { status: 'invalid_response' };
            const key = serverAccountScopeKeySuffix(authority.scope);
            let repository = this.sessionSystemRecordRepositories.get(key);
            if (!repository) {
                repository = createSessionSystemRecordRepository({
                    scope: authority.scope,
                    request: createServerRequestForServerAccountScope({
                        scope: authority.scope,
                        activeRequest: this.requestViaConfiguredSocket,
                    }),
                    retryBackoff: {
                        minDelayMs: this.syncTuning.invalidateSyncBackoffMinDelayMs,
                        maxDelayMs: this.syncTuning.invalidateSyncBackoffMaxDelayMs,
                    },
                });
                this.sessionSystemRecordRepositories.set(key, repository);
            }
            repositoryCurrent = repository.isCurrent;
            if (!isCurrent()) return { status: 'forbidden' };
            const readSession = (): SessionSystemRecordRuntime['session'] | null => {
                if (!isCurrent()) return null;
                const current = storage.getState().sessions[sessionAddress.sessionId] ?? null;
                return current && areServerProfileIdentifiersEquivalent(current.serverId, sessionAddress.serverId)
                    ? current
                    : null;
            };
            const readContentContext = (): SessionStoredContentContext | null => {
                const current = readSession();
                if (!current) return null;
                if (current.encryptionMode === 'plain') return { mode: 'plain' };
                if (current.encryptionMode !== 'e2ee') return null;
                return {
                    mode: 'e2ee',
                    encryption: readSessionEncryption(),
                };
            };
            const contentContext = readContentContext();
            repository.retainObservationAuthority(sessionAddress, {
                readCapabilities: () => readSession()?.access?.capabilities ?? null,
                readContentContext,
                isCurrent,
            });
            const value = await operation({
                scope: authority.scope,
                request: async (path, init, options) => {
                    if (!isCurrent()) throw new Error('Session System Record scope retired');
                    return await authority.request(path, init, options);
                },
                repository,
                session,
                contentContext,
                readSession,
                readContentContext,
                isCurrent,
            });
            return isCurrent() ? { status: 'ok', value } : { status: 'forbidden' };
        } catch (error) {
            if (!isCurrent()) return { status: 'forbidden' };
            return error instanceof TypeError ? { status: 'offline' } : { status: 'invalid_response' };
        } finally {
            unsubscribeCredentialChange();
            await authority.release();
        }
    };

    public reconfigureSessionDraftRepositoryForAccountMode(
        credentials: AuthCredentials,
        accountMode: 'plain' | 'e2ee',
    ): void {
        const scope = getActiveServerAccountScope();
        if (!scope || credentials.token !== this.credentials?.token) {
            throw new Error('Session draft repository scope is unavailable');
        }
        const appliedTarget = this.getAppliedTransportTarget();
        const appliedTransportIsCurrent = appliedTarget
            ? this.createAppliedTransportScopeGuard(appliedTarget)
            : () => false;
        const draftEncryption = this.encryption;
        const isDraftScopeCurrent = () => appliedTransportIsCurrent()
            && this.credentials?.token === credentials.token
            && this.encryption === draftEncryption
            && areServerAccountScopesEqual(getActiveServerAccountScope(), scope);
        const readContext = (sessionId: string, resolvedMode?: 'plain' | 'e2ee', contextEncryption = draftEncryption): SessionDraftContext => {
            if (!isDraftScopeCurrent()) return null;
            const state = storage.getState();
            const retained = state.sessions[sessionId];
            const session = retained && areServerProfileIdentifiersEquivalent(retained.serverId, scope.serverId)
                ? retained
                : readSessionListRowForServerId(state.sessionListRowsByServerId, scope.serverId, sessionId);
            const mode = resolvedMode ?? session?.encryptionMode;
            if (!mode) return null;
            assertUiSessionEncryptionModeAllowed({
                mode,
                requirement: resolveUiClientEncryptionRequirement({ syncedSettings: state.settings, localSettings: state.settings }),
            });
            return mode === 'plain' ? { mode: 'plain' }
                : { mode: 'e2ee', encryption: contextEncryption?.getSessionEncryption(sessionId) ?? null };
        };
        this.sessionDraftFlushSync?.stop();
        const draftFlushSync = this.sessionDraftSyncEnabled ? new InvalidateSync(async () => {
            if (isDraftScopeCurrent()) await retryPendingSessionDrafts(scope);
        }, {
            pause: this.pauseController,
            backoff: {
                minDelayMs: this.syncTuning.invalidateSyncBackoffMinDelayMs,
                maxDelayMs: this.syncTuning.invalidateSyncBackoffMaxDelayMs,
                maxFailureCount: 'infinite',
            },
            shouldRetry: error => isDraftScopeCurrent() && shouldRetrySyncInvalidation(error),
        }) : null;
        this.sessionDraftFlushSync = draftFlushSync;
        configureSessionDraftRepository({
            scope,
            onFlushRetryRequested: error => {
                if (isDraftScopeCurrent() && (error === undefined || shouldRetrySyncInvalidation(error))) {
                    draftFlushSync?.invalidate();
                }
            },
            transport: this.sessionDraftSyncEnabled
                ? createApiSessionDraftsTransport({
                    request: createServerRequestForServerAccountScope({
                        scope,
                        activeRequest: this.requestViaConfiguredSocket,
                    }),
                })
                : undefined,
            cipher: createSessionDraftCipher({
                accountMode,
                accountCryptoMaterial: isTokenOnlyAuthCredentials(credentials)
                    ? null
                    : resolveAccountScopedCryptoMaterialFromCredentials(credentials),
                getSessionContext: async (sessionId) => {
                    const context = readContext(sessionId);
                    if (context && (context.mode === 'plain' || context.encryption)) return context;
                    if (appliedTarget && isDraftScopeCurrent()) {
                        // Draft recovery needs the Session's mode and cipher, not
                        // its metadata, Agent state, transcript or full store entity.
                        const result = await fetchSessionByIdWithServerScope({
                            sessionId,
                            serverId: appliedTarget.serverId,
                            contentDemand: 'encryption-context',
                            activeCredentials: credentials,
                            activeEncryption: draftEncryption,
                            sessionDataKeys: this.sessionDataKeys,
                            sessionDataKeyEnvelopes: this.sessionDataKeyEnvelopes,
                            activeRequest: this.requestViaConfiguredSocket,
                            activeReadTransport: this.createAppliedReadTransport(appliedTarget),
                            applySessions: this.applySessions,
                            log,
                            isCurrent: isDraftScopeCurrent,
                        });
                        return result.ok ? readContext(sessionId, result.encryptionMode) : null;
                    }
                    return null;
                },
                withSessionContexts: async (sessionIds, operation) => {
                    const contexts = new Map<string, SessionDraftContext>();
                    const missing: string[] = [];
                    for (const sessionId of sessionIds) {
                        const context = readContext(sessionId);
                        if (context && (context.mode === 'plain' || context.encryption)) contexts.set(sessionId, context);
                        else missing.push(sessionId);
                    }
                    if (!missing.length || !appliedTarget || !isDraftScopeCurrent()) return await operation(contexts);
                    return await runWithServerRequestAuthorityForServerAccountScope({
                        scope, activeRequest: this.requestViaConfiguredSocket,
                    }, async authority => {
                        const currentness = createOperationAccountCurrentnessSource({ credentials,
                            request: authority.request, serverId: scope.serverId });
                        try {
                            const results = await readSessionEncryptionContextsForAuthority({
                                authority, sessionIds: missing,
                                sessionDataKeys: this.sessionDataKeys, sessionDataKeyEnvelopes: this.sessionDataKeyEnvelopes,
                                accountCurrentnessSource: currentness, isCurrent: isDraftScopeCurrent,
                            });
                            for (const [sessionId, result] of results) contexts.set(sessionId,
                                result.ok ? readContext(sessionId, result.encryptionMode, authority.context.encryption) : null);
                            const value = await operation(contexts);
                            await currentness.ensureCurrent();
                            return value;
                        } finally { currentness.dispose(); }
                    });
                },
                randomBytes: getRandomBytes,
            }),
            syncEnabled: this.sessionDraftSyncEnabled,
            onDraftRemoved: ({ scope: removedScope, document }) => (
                removeRunnerCreatorCustodyForRemovedDraft({ scope: removedScope, document })
            ),
        });
    }

    private prepareSessionDraftRepositoryRuntime(params: Readonly<{
        forceSnapshotHydration?: boolean;
    }> = {}): Promise<void> {
        const scope = getActiveServerAccountScope();
        const credentials = this.credentials;
        if (!scope || !credentials) return Promise.resolve();
        const capturedScope = scope;
        const capturedGeneration = this.serverScopeGeneration;
        const shouldContinue = () => (
            this.serverScopeGeneration === capturedGeneration
            && areServerAccountScopesEqual(getActiveServerAccountScope(), capturedScope)
        );
        return this.sessionDraftRuntimePreparationGate.run({
            scope: capturedScope,
            force: params.forceSnapshotHydration === true,
            hydrate: async () => {
                if (
                    params.forceSnapshotHydration === true
                    || !areServerAccountScopesEqual(this.sessionDraftRepositoryConfiguredScope, capturedScope)
                ) {
                    const syncDecision = await resolveRuntimeFeatureDecisionOrThrow({
                        featureId: 'sessions.drafts',
                        serverId: capturedScope.serverId,
                    });
                    const syncEnabled = syncDecision.state === 'enabled';
                    if (!shouldContinue()) return false;
                    this.sessionDraftSyncEnabled = syncEnabled;
                    if (syncEnabled) {
                        const mode = await fetchAccountEncryptionMode(credentials);
                        if (!shouldContinue()) return false;
                        this.reconfigureSessionDraftRepositoryForAccountMode(credentials, mode.mode);
                    } else {
                        configureSessionDraftRepository({ syncEnabled: false });
                    }
                    this.sessionDraftRepositoryConfiguredScope = capturedScope;
                }
                if (!shouldContinue()) return false;
                await migrateLegacySessionDrafts(capturedScope);
                if (!shouldContinue()) return false;
                return true;
            },
        });
    }

    private async ensureSessionDraftRepositoryRuntimeReady(params: Readonly<{
        forceSnapshotHydration?: boolean;
    }> = {}): Promise<void> {
        const scope = getActiveServerAccountScope();
        const generation = this.serverScopeGeneration;
        if (!scope) return;
        await this.sessionDraftRuntimeHydrationGate.run({
            scope,
            force: params.forceSnapshotHydration === true,
            hydrate: async () => {
                await this.prepareSessionDraftRepositoryRuntime(params);
                if (generation !== this.serverScopeGeneration
                    || !areServerAccountScopesEqual(getActiveServerAccountScope(), scope)) return false;
                this.sessionDraftSnapshotIncomplete = true;
                const complete = await ensureSessionDraftRepositoryHydrated(scope);
                if (generation !== this.serverScopeGeneration
                    || !areServerAccountScopesEqual(getActiveServerAccountScope(), scope)) return false;
                this.sessionDraftSnapshotIncomplete = !complete;
                return true;
            },
        });
    }

    /** Foreground admission shares preparation/migration, while full hydration still owns outbox recovery. */
    public async prepareSessionDraftSurface(lifetime: ServerAccountScopeLifetime, addresses: readonly Extract<SessionDraftAddressV2, { kind: 'session' | 'newSession' }>[]): Promise<boolean> {
        const scope = lifetime.scope;
        if (!lifetime.isCurrent()) return false;
        if (!areServerAccountScopesEqual(getActiveServerAccountScope(), scope)) {
            // Inactive Homes keep their existing invocation-owned authority;
            // never configure the active singleton for a background surface.
            try {
                await Promise.all(addresses.map(async address => {
                    if (address.kind === 'session') {
                        await this.materializeExistingSessionDraft(address.sessionId, lifetime);
                        return;
                    }
                    const profile = getServerProfileById(scope.serverId);
                    if (!profile) throw new Error('Session draft Home unavailable');
                    await runWithSessionDraftRepositoryScopedRuntime({
                        binding: lifetime,
                        activeRequest: createServerFetchAtEndpoint({ endpointUrl: profile.serverUrl, serverId: scope.serverId }),
                        operation: params => materializeExactSessionDraftWithScopedRuntime({ ...params, address }),
                    });
                }));
            } catch {
                log.log('[session-drafts] Scoped foreground hydration unavailable; retaining local drafts');
            }
            return lifetime.isCurrent();
        }
        const generation = this.serverScopeGeneration;
        const credentials = this.credentials;
        const isCurrent = () => lifetime.isCurrent() && credentials !== null && credentials === this.credentials
            && generation === this.serverScopeGeneration
            && areServerAccountScopesEqual(getActiveServerAccountScope(), scope);
        if (!isCurrent()) return false;
        try {
            await this.prepareSessionDraftRepositoryRuntime();
            if (!isCurrent()) return false;
            return await ensureSessionDraftAddressesHydrated(scope, addresses) && isCurrent();
        } catch {
            // Match Account hydration's locally durable fallback, without marking the whole list ready.
            log.log('[session-drafts] Foreground hydration unavailable; retaining local drafts');
            return isCurrent();
        }
    }

    private markSessionDraftsReady(): void {
        storage.setState(state => state.isSessionDraftsReady ? state : { isSessionDraftsReady: true });
    }

    private async refreshSessionDraftRepositoryForSync(params: Readonly<{
        forceSnapshotHydration?: boolean;
    }> = {}): Promise<void> {
        const scope = getActiveServerAccountScope();
        const generation = this.serverScopeGeneration;
        try {
            await this.ensureSessionDraftRepositoryRuntimeReady(params);
        } catch {
            // Drafts are locally durable and the hydration gate retries after a failed run.
            // A draft-only outage must not suppress already-loaded account projections.
            log.log('[session-drafts] Snapshot hydration unavailable; retaining local drafts and retrying on the next sync');
        }
        if (scope && generation === this.serverScopeGeneration
            && areServerAccountScopesEqual(getActiveServerAccountScope(), scope)) {
            this.markSessionDraftsReady();
        }
    }

    private resetServerScopedRuntimeState = (targetToReset?: SyncServerTarget | null) => {
        this.bootstrapForegroundReady = null;
        this.projectAccountRowsRuntime = null;
        storage.getState().clearProjectAccountRowsScope();
        this.credentials = { token: '' };
        this.authoringMemoryRuntime = null;
        storage.getState().resetAuthoringMemory();
        apiSocket.invalidateRequests('server-switch');
        this.automationRunTraversalTokensByAutomationId.clear();
        this.automationRunRefreshPending = false;
        this.changesCatchUpQueuedAfterResume = false;
        this.postSubscriptionChangesCatchUpPending = false;
        this.sessionDraftSyncEnabled = false;
        this.sessionDraftFlushSync?.stop();
        this.sessionDraftFlushSync = null;
        this.sessionDraftSnapshotIncomplete = false;
        this.sessionDraftRepositoryConfiguredScope = null;
        this.sessionDraftRuntimeHydrationGate.reset();
        this.sessionDraftRuntimePreparationGate.reset();
        configureSessionDraftRepository({ syncEnabled: false });
        // The UI-sync generation fence is the sole shared Account retirement
        // boundary. Consumers receive synchronous owner-local cancellation
        // before this reset continues, while no consumer cleanup is awaited.
        this.pluginAvailabilityProjectionHydrator.reset();
        clearPluginAccountAvailabilityProjection();
        retireActiveServerAccountScopeLifetime();
        // Retire only the Home being reset: a finite operation captured for another
        // explicit Home must not be torn down by a focus switch.
        invalidateAccountEncryptionModeCache({
            reason: 'scope-reset',
            serverId: targetToReset?.serverId ?? this.getAppliedTransportTarget()?.serverId ?? null,
        });
        machineProcessesStore.reset();
        machineResourceStore.reset();
        // Session System Record repositories are qualified by their captured
        // Home/Account credential, not by whichever Home owns the focused
        // socket. Credential mutation retires the exact Home above; switching
        // or resetting the focused runtime must not tear down observations for
        // a different Home.
        this.stopJsThreadLagTelemetryRuntime();
        this.serverScopeGeneration += 1;
        this.flushPendingSettingsForCurrentScopeNow();
        this.clearActiveAccountSettingsScope();
        this.userRequestLeaseOwner.crossHardBoundary(() => this.disconnectSocketIntentionally());
        this.activityAccumulator.reset();

        for (const timer of this.pendingMessageCommitRetryTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingMessageCommitRetryTimers.clear();
        for (const timer of this.pendingOutboxOperationRetryTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingOutboxOperationRetryTimers.clear();

        for (const timer of this.messagesSync.values()) {
            timer.stop();
        }
        this.messagesSync.clear();
        this.sessionReceivedMessages.clear();
        this.sessionMessagesBeforeSeqByKey.clear();
        this.sessionMessagesHasMoreOlderByKey.clear();
        for (const sessionId of [...this.sessionMessagesTailDiscontinuityBySessionId.keys()]) {
            storage.getState().setSessionTailContiguousBoundary(sessionId, null);
        }
        this.sessionMessagesTailDiscontinuityBySessionId.clear();
        this.sessionMessagesFetchLatestInFlightByKey.clear();
        this.sessionMessagesFetchedLatestByKey.clear();
        this.sessionMessagesLoadingOlderByKey.clear();
        this.deferredMessagesFetchSessionIds.clear();
        this.sessionMessagesLoadingNewerByKey.clear();
        this.sessionMessagesPaginationSupportedByKey.clear();
        this.externalSessionOlderCursorBySessionId.clear();
        this.externalSessionHasMoreOlderBySessionId.clear();
        this.externalSessionTailStateBySessionId.clear();
        for (const listeners of this.externalSessionTailCursorListenersBySessionId.values()) {
            for (const listener of listeners) listener();
        }
        this.transcriptAuthorityKeyBySessionId.clear();
        this.externalSessionTranscriptFenceAuthorityKeyBySessionId.clear();
        for (const sessionId of Object.keys(storage.getState().sessionTranscriptLoadIssues)) {
            storage.getState().setSessionTranscriptLoadIssue(sessionId, null);
        }
        this.sessionMessagesWindowStateBySessionId.clear();
        clearTargetWindowRequestEpochs();
        this.sessionViewport.clear();
        // Persisted records are scoped and survive; the next active scope rehydrates lazily.
        this.sessionViewportHydratedStorageKey = null;
        clearSessionMessageDerivedCachesForServerScopeReset();
        clearSessionSurfaceVisibilityForServerScopeReset();
        clearSessionViewingActivationsForServerScopeReset();
        clearMountedSessionRealtimeScmConsumerScopes();
        this.deferredForwardLoadingSessions.clear();
        this.explicitSessionTailProbeIds.clear();
        this.activeServerSessionIds.clear();
        this.hasFetchedSessionsSnapshotForActiveServer = false;
        this.fetchMoreSessionsInFlight = null;
        this.sessionListNextCursor = null;
        this.sessionListHasMore = false;
        this.sessionListAttentionNextCursor = null;
        this.sessionListAttentionHasMore = false;
        this.sessionListMetadataUpgradeRequiredCount = 0;
        this.metadataUpgradeDiscovery = new SessionMetadataUpgradeDiscovery();
        this.clearSessionListScrollActivity();
        this.sessionDataKeys.clear();
        this.sessionDataKeyEnvelopes.clear();
        this.machineDataKeys.clear();
        this.machineRecipientChangeCursors.clear();
        this.publishedAccountChangeCursors = new Map();
        this.artifactDataKeys.clear();

        this.lastSocketDisconnectedAtMs = null;
        this.lastSocketOfflineDurationMs = null;
        this.socketOfflineCatchUpConsumedSessionIds.clear();
        this.safeCursorLagState = null;
        this.webSyncClientIdentity = null;
        if (this.webSyncClientIdentityHeartbeatTimer) {
            clearInterval(this.webSyncClientIdentityHeartbeatTimer);
            this.webSyncClientIdentityHeartbeatTimer = null;
        }
        this.changesCursor = null;

        storage.getState().resetWorkflowTriggerSets();
        const activeServerIdForReset = String(
            targetToReset?.serverId ?? this.getAppliedTransportTarget()?.serverId ?? '',
        ).trim();
        const withoutActiveServerEntry = <T>(entries: Readonly<Record<string, T>>): Readonly<Record<string, T>> => {
            if (!activeServerIdForReset || !(activeServerIdForReset in entries)) return entries;
            const next = { ...entries };
            delete next[activeServerIdForReset];
            return next;
        };
        const withoutOutgoingHomeMachineEntries = <T>(entries: Readonly<Record<string, T>>): Readonly<Record<string, T>> => {
            if (!activeServerIdForReset) return entries;
            const outgoingKeys = Object.keys(entries).filter((serverId) => (
                areServerProfileIdentifiersEquivalent(serverId, activeServerIdForReset)
            ));
            if (outgoingKeys.length === 0) return entries;
            const next = { ...entries };
            for (const serverId of outgoingKeys) delete next[serverId];
            return next;
        };

        storage.setState((state) => ({
            ...state,
            profile: { ...profileDefaults },
            sessions: {},
            projectAuthoringSessions: EMPTY_PROJECT_AUTHORING_SESSION_INPUTS,
            concurrentSessionListCacheByServerId: (() => {
                if (!activeServerIdForReset) return state.concurrentSessionListCacheByServerId;
                if (!(activeServerIdForReset in state.concurrentSessionListCacheByServerId)) return state.concurrentSessionListCacheByServerId;
                const next = { ...state.concurrentSessionListCacheByServerId };
                delete next[activeServerIdForReset];
                return next;
            })(),
            sessionListRowsByServerId: withoutActiveServerEntry(
                state.sessionListRowsByServerId ?? {},
            ),
            ordinarySessionListMembershipByServerId: withoutActiveServerEntry(
                state.ordinarySessionListMembershipByServerId ?? {},
            ),
            archivedSessionListMembershipByServerId: withoutActiveServerEntry(
                state.archivedSessionListMembershipByServerId ?? {},
            ),
            sessionListIndexByServerId: (() => {
                const previous = state.sessionListIndexByServerId ?? {};
                if (!activeServerIdForReset) return previous;
                if (!(activeServerIdForReset in previous)) return previous;
                const { [activeServerIdForReset]: _, ...rest } = previous;
                return rest;
            })(),
            machineListByServerId: withoutOutgoingHomeMachineEntries(state.machineListByServerId),
            machineListStatusByServerId: withoutOutgoingHomeMachineEntries(state.machineListStatusByServerId),
            machinePresenceByServerId: withoutOutgoingHomeMachineEntries(state.machinePresenceByServerId),
            sessionScmStatus: {},
            machines: {},
            machineDisplayById: {},
            machinePresenceById: {},
            sessionMessages: {},
            sessionUserMessageHistory: {},
            sessionMessagesHistoryStartLoaded: {},
            sessionPending: {},
            artifacts: {},
            artifactOpenWorkflowPublicationArtifacts: [],
            artifactSkillRevisions: {},
            artifactInventoryUnreadyCount: 0,
            artifactsLoaded: false,
            artifactBrowserLoaded: false,
            artifactInboxLoaded: false,
            artifactInboxPartial: false,
            artifactInventoryKindsLoaded: [],
            artifactInventoryKindsPartial: [],
            automations: {},
            automationDefinitionNextCursor: null,
            automationDefinitionWindowExtended: false,
            // The shared Run bodies and every window that references them are
            // retired together, so a new Account can never resolve a stale
            // private row through a window this reset forgot.
            workflowRunsById: {},
            workflowRunListWindows: {},
            workflowRunInvocationsByRunId: {},
            automationRunIdsByAutomationId: {},
            automationRunNextCursorByAutomationId: {},
            automationRunTraversalsByAutomationId: {},
            friends: {},
            users: {},
            friendsLoaded: false,
            feedItems: [],
            feedHead: null,
            feedTail: null,
            feedHasMore: false,
            feedLoaded: false,
            todoState: null,
            todosLoaded: false,
            isDataReady: false,
            isSessionDraftsReady: false,
            socketStatus: 'disconnected',
            socketLastError: null,
            socketLastErrorAt: null,
            syncError: null,
            accountSettingsSyncStatus: createAccountSettingsIdleStatus(),
            lastSyncAt: null,
        }));
    };

    public async switchServer(credentials: AuthCredentials, target?: SyncServerTarget): Promise<void> {
        const encryptionTarget = target ?? getActiveServerSnapshot();
        const encryption = await resolveScopedAccountEncryption({
            serverId: encryptionTarget.serverId, serverUrl: encryptionTarget.serverUrl, credentials,
        });

        assertSyncServerTargetCurrent(target);

        const targetServerId = String(target?.serverId ?? getActiveServerSnapshot().serverId ?? '').trim();
        this.resetServerScopedRuntimeState();
        // The incoming credential is a new authority decision for this exact Home. Withdraw any
        // retained private Pool rows before restore; the shared projection lifecycle rehydrates
        // them only after it captures and parses this credential's Account.
        if (targetServerId) storage.getState().clearMachinePoolsForServer(targetServerId);
        apiSocket.initialize(buildSyncSocketConfig(credentials, target), encryption);
        await this.restore(credentials, encryption, target);
    }

    public disconnectServer(): void {
        if (this.embedSessionScope) { this.disposeEmbedSession(); return; }
        const disconnectedTarget = this.getAppliedTransportTarget();
        this.appliedServerTarget = null;
        const serverId = disconnectedTarget?.serverId ?? '';
        this.resetServerScopedRuntimeState(disconnectedTarget);
        this.credentials = null;
        // Signed-out is a transient availability state, not evidence that this Account's last
        // known definitions disappeared. Keep them visible but inert until credential recovery.
        if (serverId) storage.getState().setMachinePoolListStatus(serverId, 'signedOut');
        clearWarmCacheAccountScope();
    }

    public acquireUserRequestLease(): () => void {
        return this.userRequestLeaseOwner.acquire();
    }

    /**
     * Encrypt a secret value into an encrypted-at-rest container.
     * Used for transient persistence (e.g. local drafts) where plaintext must never be stored.
     */
    public encryptSecretValue(value: string): import('./encryption/secretSettings').SecretString | null {
        const v = typeof value === 'string' ? value.trim() : '';
        if (!v) return null;
        if (!this.settingsSecretsKey) return null;
        return { _isSecretValue: true, encryptedValue: encryptSecretString(v, this.settingsSecretsKey) };
    }

    /**
     * Generic secret-string decryption helper for settings-like objects.
     * Prefer this over adding per-field helpers unless a field needs special handling.
     */
    public decryptSecretValue(input: import('./encryption/secretSettings').SecretString | null | undefined): string | null {
        return decryptSecretValueWithKeys(input, this.settingsSecretsReadKeys);
    }

    async #init() {

        // Subscribe to updates
        if (!this.updatesSubscribed) {
            this.subscribeToUpdates();
            this.updatesSubscribed = true;
        }

        // Sync initial PostHog opt-out state with stored settings
        if (!this.embedSessionScope && tracking) {
            const currentSettings = storage.getState().settings;
            if (currentSettings.analyticsOptOut) {
                tracking.optOut();
            } else {
                tracking.optIn();
            }
        }
        if (!this.embedSessionScope) applyCrashReportsOptOut(storage.getState().settings.crashReportsOptOut);

        // Core admission and independent background queues share one bootstrap owner.
        fireAndForget(this.bootstrapSync(), { tag: 'Sync.bootstrapSync' });
    }


        onSessionVisible = (sessionId: string) => {
            if (this.embedSessionScope && (sessionId !== this.embedSessionScope.scope.sessionId || !this.embedSessionScope.isCurrent())) return;
            for (const repository of this.sessionSystemRecordRepositories.values()) repository.refreshObserved();
            if (isDemoModeActive()) return;
            // Opening a session grows the hydrated working set; bound it (coalesced sweep).
            this.sessionTranscriptRetention.scheduleSweep();
            this.ensureSessionViewportHydrated();
            const prevViewport = this.sessionViewport.get(sessionId);
            if (prevViewport) {
                this.sessionViewport.set(sessionId, { ...prevViewport, lastUpdatedAt: Date.now() });
            } else {
                this.markSessionLiveTailIntent(sessionId);
            }
            if (storage.getState().sessionMessages[sessionId]?.isLoaded === true) {
                this.explicitSessionTailProbeIds.add(sessionId);
            }
            this.repairStaleTranscriptIfNeeded(sessionId);
            if (hasDeferredSessionStateHydration(this.deferredSessionStateHydrationState, sessionId)) {
                this.deferredSessionStateHydrationState = clearDeferredSessionStateHydration(
                    this.deferredSessionStateHydrationState,
                    sessionId,
                );
                fireAndForget(this.ensureSessionVisibleForMessageRoute(sessionId, { forceRefresh: true }), {
                    tag: 'Sync.onSessionVisible.deferredSessionStateHydration',
                });
            }
            this.replayDeferredMessagesFetch(sessionId);
            this.getOrCreateMessagesSync(sessionId).invalidateCoalesced();

            // Notify voice assistant about session visibility
            const session = storage.getState().sessions[sessionId];
            const address = normalizeSessionAddress(session?.serverId, sessionId);
            if (!this.embedSessionScope && session && address) {
                voiceHooks.onSessionFocus(
                    address,
                    readSessionOwnerMetadataView(session) ?? undefined,
                );
        }
    }

        materializeExistingSessionDraft = async (
            sessionId: string,
            accountLifetime: ServerAccountScopeLifetime,
        ): Promise<void> => {
            if (isDemoModeActive() || !accountLifetime.isCurrent()) return;
            const capturedDraftScope = accountLifetime.scope;
            await materializeVisibleExistingSessionDraft({
                sessionId,
                capturedScope: capturedDraftScope,
                isCurrent: accountLifetime.isCurrent,
                materializeExact: async (scope, address) => {
                    if (!accountLifetime.isCurrent()) return;
                    if (this.embedSessionScope || isEmbedWindowContext()) {
                        const admitted = this.getEmbedSessionRequestContext();
                        if (!admitted || admitted.sessionId !== sessionId
                            || !areServerAccountScopesEqual(scope, {
                                serverId: admitted.serverId, accountId: admitted.accountId,
                            })) return;
                        // The frame has Session authority only. Its successor
                        // draft uses the incumbent local repository, never
                        // Account draft migration or remote materialization.
                        await ensureSessionDraftRepositoryHydrated(scope);
                        return;
                    }
                    if (areServerAccountScopesEqual(getActiveServerAccountScope(), scope)) {
                        await this.prepareSessionDraftRepositoryRuntime();
                        if (!accountLifetime.isCurrent()) return;
                        await materializeExactSessionDraft(scope, address);
                        return;
                    }
                    await migrateLegacySessionDrafts(scope);
                    if (!accountLifetime.isCurrent()) return;
                    await runWithServerRequestAuthorityForServerAccountScope({
                        scope,
                        activeRequest: this.createSessionRequest(sessionId),
                    }, async (authority) => {
                        const isCurrent = () => accountLifetime.isCurrent()
                            && areServerAccountScopesEqual(authority.scope, scope);
                        if (!isCurrent()) return;
                        const credentials = authority.context.credentials;
                        if (!credentials) throw new Error('Session draft materialization requires exact Account credentials');
                        const request = async (path: string, init?: RequestInit): Promise<Response> => {
                            if (!isCurrent()) throw new Error('Session draft Account authority retired');
                            const response = await authority.request(path, init);
                            if (!isCurrent()) throw new Error('Session draft Account authority retired');
                            return response;
                        };
                        const [syncDecision, mode, exactSessionSnapshot] = await Promise.all([
                            resolveRuntimeFeatureDecisionOrThrow({
                                featureId: 'sessions.drafts',
                                serverId: scope.serverId,
                            }),
                            fetchAccountEncryptionMode(credentials, { request }),
                            readSessionSnapshotForAuthority({
                                authority: { ...authority, request },
                                sessionId,
                                isCurrent,
                            }),
                        ]);
                        if (!isCurrent() || syncDecision.state !== 'enabled') return;
                        const exactSession = exactSessionSnapshot.session;
                        await materializeExactSessionDraftWithScopedRuntime({
                            scope,
                            address,
                            isCurrent,
                            runtime: {
                                transport: createApiSessionDraftsTransport({ request }),
                                cipher: createSessionDraftCipher({
                                    accountMode: mode.mode,
                                    accountCryptoMaterial: mode.mode === 'e2ee' && !isTokenOnlyAuthCredentials(credentials)
                                        ? resolveAccountScopedCryptoMaterialFromCredentials(credentials)
                                        : null,
                                    getSessionContext: (targetSessionId) => {
                                        if (targetSessionId !== sessionId) return null;
                                        if (exactSession.encryptionMode === 'plain') return { mode: 'plain' };
                                        return {
                                            mode: 'e2ee',
                                            encryption: authority.context.encryption?.getSessionEncryption(sessionId) ?? null,
                                        };
                                    },
                                    randomBytes: getRandomBytes,
                                }),
                            },
                        });
                    });
                },
            });
        }

        refreshSessionMessages = async (
            sessionId: string,
            options?: Readonly<{
                authority?: ServerAccountRequestAuthority;
                /** Start the shared retry cycle without waiting for an unbounded background retry. */
                awaitQueue?: boolean;
            }>,
        ): Promise<void> => {
            const normalized = String(sessionId ?? '').trim();
            if (!normalized) return;
            if (options?.authority) {
                const authority = options.authority;
                const isCurrent = (): boolean => this.isServerAccountSessionReadCurrent(
                    authority,
                    normalized,
                );
                if (!isCurrent()) return;
                const session = storage.getState().sessions[normalized] ?? null;
                await fetchAndApplyMessages({
                    sessionId: normalized,
                    serverId: authority.scope.serverId,
                    sessionEncryptionMode: session?.encryptionMode === 'plain' ? 'plain' : 'e2ee',
                    getSessionEncryption: (id) =>
                        this.getSessionMessagesEncryptionForAuthority(authority, id),
                    // Account authority remains current after a local history
                    // clear, so the page also needs the carrier's local shell.
                    isSessionKnown: () => isCurrent(),
                    request: (path) => authority.request(path, { method: 'GET' }),
                    // This request is an isolated account-scoped read. Dedupe state is local so a
                    // response from a retired account cannot repopulate the active Sync caches.
                    sessionReceivedMessages: new Map(),
                    applyMessages: (sid, messages) => {
                        if (isCurrent()) {
                            this.applyMessages(sid, messages, { notifyVoice: false });
                        }
                    },
                    markMessagesLoaded: (sid) => {
                        if (isCurrent()) {
                            this.publishSessionMessagesHistoryStartCoverage(sid);
                            storage.getState().applyMessagesLoaded(sid);
                        }
                    },
                    onMessagesPage: (page) => {
                        if (isCurrent()) {
                            this.updateSessionMessagesPaginationFromPage(
                                normalized,
                                { scope: 'main' },
                                page,
                                { allowHasMoreInference: true, deferHistoryStartCoverage: true },
                            );
                        }
                    },
                    ...this.getSessionMessagesPageOptions(normalized, authority),
                    log,
                });
                return;
            }
            const queue = this.getOrCreateMessagesSync(normalized);
            if (options?.awaitQueue === false) {
                queue.invalidate();
                return;
            }
            await queue.invalidateAndAwait();
        }

        refreshSessionForSubmit = async (
            sessionId: string,
            options?: Readonly<{
                serverId?: string | null;
                accountLifetime?: ServerAccountScopeLifetime;
            }>,
        ): Promise<Session | null> => {
            const normalized = String(sessionId ?? '').trim();
            if (!normalized) return null;
            const embedScope = this.embedSessionScope;
            if (embedScope) {
                if (normalized !== embedScope.scope.sessionId || !embedScope.isCurrent()) return null;
                await this.ensureSessionVisibleForMessageRoute(normalized, { forceRefresh: true, hydrateMessages: false });
                if (this.embedSessionScope !== embedScope || !embedScope.isCurrent()) return null;
                return storage.getState().sessions[normalized] ?? null;
            }
            if (isEmbedWindowContext()) return null;
            if (options?.accountLifetime) {
                const lifetime = options.accountLifetime;
                if (!lifetime.isCurrent()) return null;
                if (
                    options.serverId
                    && !areServerProfileIdentifiersEquivalent(options.serverId, lifetime.scope.serverId)
                ) return null;
                return await runWithServerRequestAuthorityForServerAccountScope({
                    scope: lifetime.scope,
                    activeRequest: this.createSessionRequest(normalized),
                }, async (authority) => {
                    const isCurrent = () => lifetime.isCurrent()
                        && areServerAccountScopesEqual(authority.scope, lifetime.scope);
                    if (!isCurrent()) return null;
                    const snapshot = await readSessionSnapshotForAuthority({
                        authority,
                        sessionId: normalized,
                        isCurrent,
                    });
                    if (!isCurrent()) return null;
                    if (
                        snapshot.session.serverId
                        && !areServerProfileIdentifiersEquivalent(
                            snapshot.session.serverId,
                            lifetime.scope.serverId,
                        )
                    ) return null;
                    return {
                        ...snapshot.session,
                        serverId: lifetime.scope.serverId,
                    };
                });
            }
            const serverId = typeof options?.serverId === 'string' && options.serverId.trim().length > 0
                ? options.serverId.trim()
                : undefined;
            await this.ensureSessionVisibleForMessageRoute(normalized, {
                forceRefresh: true,
                ...(serverId ? { serverId } : {}),
            });
            return storage.getState().sessions[normalized] ?? null;
        }

        /**
         * Hydrate a visible session by id for deep links / hard refreshes.
         *
         * @remarks
         * The sessions list is paginated and bounded. When the user deep-links directly into a session/message,
         * the active server snapshot may not include that session id yet, which causes message fetch to no-op.
         * This helper fetches `/v2/sessions/:id` and initializes encryption so messages can be loaded.
         */
        ensureHostedSystemSession = async (
            input: Pick<EnsureHostedSystemSessionInput, 'tag' | 'metadata'>,
        ): Promise<HostedSystemSessionEnsureResult> => {
            const activeServer = this.appliedServerTarget;
            const scope = getActiveServerAccountScope();
            const credentials = this.credentials;
            const encryption = this.encryption;
            if (
                !activeServer
                || !scope
                || !credentials
                || scope.accountId !== this.serverID
                || !areServerProfileIdentifiersEquivalent(scope.serverId, activeServer.serverId)
            ) {
                throw new Error('Hosted system session requires an initialized account scope');
            }
            const authority = await captureServerRequestAuthorityForServerAccountScope({
                scope,
                activeRequest: this.requestViaConfiguredSocket,
            });
            try {
            if (
                authority.context.token !== credentials.token
                || !areServerAccountScopesEqual(getActiveServerAccountScope(), scope)
            ) {
                throw new Error('Hosted system session account authority changed');
            }
            return await this.hostedSystemSessionEnsurer.ensure({
                ...input,
                scopeKey: serverAccountScopeKeySuffix(scope),
                credentials,
                encryption,
                serverBasis: {
                    serverId: activeServer.serverId,
                    generation: activeServer.generation,
                },
                authority,
            });
            } finally {
                await authority.release?.();
            }
        };

        ensureSessionVisibleForMessageRoute = async (
            sessionId: string,
            options?: Readonly<{
                forceRefresh?: boolean;
                /** Require a read started after this demand instead of joining an older hydration. */
                fresh?: boolean;
                serverId?: string;
                includeTurnsProjection?: boolean;
                hydrateMessages?: boolean;
                /** Keep a wake reconciliation open until its queued messages have applied. */
                awaitMessageHydration?: boolean;
                authority?: ServerAccountRequestAuthority;
                accountCurrentnessSource?: ReturnType<typeof createOperationAccountCurrentnessSource>;
                /** Exact captured Account-scope currentness for a qualified caller. */
                scopeCurrentness?: () => boolean;
                /** Exact record observers use the reader initialized by a coalesced hydration. */
                onHydratedSessionReader?: (read: () => ReturnType<Encryption['getSessionEncryption']>) => void;
            }>,
        ): Promise<EnsureSessionVisibleForRouteResult> => {
            const normalized = String(sessionId ?? '').trim();
            if (!normalized) return createMissingSessionRouteResult('', undefined, 'not_found');
            const embedScope = this.embedSessionScope;
            if (embedScope && (normalized !== embedScope.scope.sessionId || !embedScope.isCurrent())) return createMissingSessionRouteResult(normalized, undefined, 'not_found');
            const forceRefresh = options?.forceRefresh === true || options?.fresh === true;

            const includeTurnsProjection = options?.includeTurnsProjection === true;

            const DEBUG_SESSION_HYDRATE =
                !embedScope && typeof globalThis !== 'undefined'
                && (
                    (globalThis as any).__HAPPIER_DEBUG_SESSION_HYDRATE__ === true
                    || (() => {
                        try {
                            return typeof localStorage !== 'undefined' && localStorage.getItem('happier.debug.sessionHydrate') === '1';
                        } catch {
                            return false;
                        }
                    })()
                );
            const appliedTransportTarget = this.getAppliedTransportTarget();
            const activeServerId = String(appliedTransportTarget?.serverId ?? '').trim();
            const preferredServerId = embedScope ? embedScope.endpointUrl : resolveMessageRouteHydrationServerId(
                normalized,
                options?.serverId,
                activeServerId || undefined,
            );
            if (preferredServerId && !isKnownServerId(preferredServerId, activeServerId || undefined)) {
                return createMissingSessionRouteResult(normalized, preferredServerId, 'not_found');
            }
            const prefersActiveServer = !preferredServerId || areServerProfileIdentifiersEquivalent(preferredServerId, activeServerId);
            // The full-row carrier is keyed by Session id and may retain another
            // Home's same-id row. Only this request's Home can supply prior state
            // or the admitted publication read back by the by-ID hydration owner.
            const readHydrationSession = (id: string): Session | null => {
                const session = storage.getState().sessions[id];
                return session && (!preferredServerId || areServerProfileIdentifiersEquivalent(session.serverId, preferredServerId))
                    ? session
                    : null;
            };

            // Fast-path when we already know the session exists on this server and the stored record is
            // already authoritatively hydrated (deep links can occur before the sessions snapshot bootstraps).
            const existingSession = readHydrationSession(normalized);
            const isKnownOnRequestedServer = prefersActiveServer
                ? this.isSessionKnownOnActiveServer(normalized)
                : Boolean(preferredServerId && storage.getState().sessionListRowsByServerId[preferredServerId]?.[normalized]);
            if (!forceRefresh && isKnownOnRequestedServer && existingSession) {
                const encryptionMode: 'e2ee' | 'plain' = existingSession.encryptionMode === 'plain' ? 'plain' : 'e2ee';
                const scopedEncryption = options?.authority?.context.encryption ?? this.encryption;
                const hasEncryption = encryptionMode === 'plain'
                    ? false
                    : Boolean(scopedEncryption?.getSessionEncryption(normalized));
                const hasAuthoritativeSessionRouteState = hasAuthoritativeSessionRouteData(existingSession, { hasSessionEncryption: hasEncryption });
                if (DEBUG_SESSION_HYDRATE) {
                    log.log(`[sessionHydrate] fast-path check ${normalized} mode=${encryptionMode} hasEncryption=${hasEncryption} hasRouteState=${hasAuthoritativeSessionRouteState}`);
                }
                const needsTurnsProjection = includeTurnsProjection
                    && !hasCurrentSessionTurnsProjection(existingSession)
                    && isSessionContentReadable(readSessionContentAvailability(existingSession));
                const listRenderable = preferredServerId
                    ? readSessionListRowForServerId(storage.getState().sessionListRowsByServerId, preferredServerId, normalized)
                    : null;
                const hasCurrentListState = !listRenderable
                    || isHydratedSessionCurrentForListState(existingSession, () => listRenderable,
                        readSessionFullPublicationUpdatedAt(existingSession));
                if (hasAuthoritativeSessionRouteState && hasCurrentListState && !needsTurnsProjection) {
                    if (DEBUG_SESSION_HYDRATE) {
                        log.log(`[sessionHydrate] fast-path hit ${normalized}`);
                    }
                    return createAvailableSessionRouteResult(
                        normalized,
                        String(existingSession.serverId ?? preferredServerId ?? '').trim() || undefined,
                    );
                }
            }

            // Sync might not be fully initialized yet (e.g. very early during app bootstrap).
            const credentials = options?.authority?.context.credentials ?? this.credentials;
            if (!credentials) {
                if (DEBUG_SESSION_HYDRATE) {
                    log.log(`[sessionHydrate] missing credentials for ${normalized}`);
                }
                return createRetryableSessionRouteResult(normalized, preferredServerId, 'unknown');
            }

            const authorityScopeKey = options?.authority
                ? serverAccountScopeKeySuffix(options.authority.scope)
                : '';
            // A lean background read cannot satisfy an opened transcript's turn demand.
            const inFlightKey = `${buildSessionByIdHydrationInFlightKey(normalized, preferredServerId)}:${authorityScopeKey}:${includeTurnsProjection}`;
            const finishMessageHydration = async (result: EnsureSessionVisibleForRouteResult) => {
                if (result.kind === 'available' && !options?.authority && options?.hydrateMessages !== false) {
                    this.replayDeferredMessagesFetch(normalized);
                    const messages = this.getOrCreateMessagesSync(normalized);
                    if (options?.awaitMessageHydration === true) await messages.invalidateAndAwait();
                    else messages.invalidateCoalesced();
                }
                return result;
            };
            const existing = this.sessionByIdHydrationInFlight.get(inFlightKey);
            if (existing && options?.fresh === true) {
                const scopeIsCurrent = this.createServerScopeGuard();
                await existing.promise;
                if (!scopeIsCurrent() || options.scopeCurrentness?.() === false) {
                    return createAwaitingPushSessionRouteResult(normalized, preferredServerId);
                }
                return this.ensureSessionVisibleForMessageRoute(normalized, { ...options, fresh: false, forceRefresh: true });
            }
            if (existing) {
                if (DEBUG_SESSION_HYDRATE) {
                    log.log(`[sessionHydrate] awaiting in-flight hydration for ${normalized}`);
                }
                const result = await existing.promise;
                if (result.kind === 'available' && options?.scopeCurrentness?.() !== false) {
                    options?.onHydratedSessionReader?.(existing.readSessionEncryption);
                }
                return options?.awaitMessageHydration === true ? finishMessageHydration(result) : result;
            }

            let hydrationCurrent = true;
            const hydrationEncryption = this.encryption;
            const readerEncryption = options?.authority ? options.authority.context.encryption : hydrationEncryption;
            const readSessionEncryption = () => readerEncryption?.getSessionEncryption(normalized) ?? null;
            const hydrationGeneration = this.serverScopeGeneration;
            const hasExplicitScopeCurrentness = options?.authority !== undefined
                && options.scopeCurrentness !== undefined;
            const hydrationLifetime = embedScope || options?.scopeCurrentness
                ? null
                : captureActiveServerAccountScopeCurrentness();
            const isHydrationCurrent = (): boolean => (
                hydrationCurrent
                && (embedScope ? this.embedSessionScope === embedScope && embedScope.isCurrent() : (options?.scopeCurrentness?.() ?? hydrationLifetime?.isCurrent() ?? false))
                && (hasExplicitScopeCurrentness || (
                    hydrationEncryption === this.encryption
                    && hydrationGeneration === this.serverScopeGeneration
                    && (
                        !options?.authority
                        || this.isServerAccountSessionAuthorityCurrent(options.authority)
                    )
                ))
            );
            const inFlight = (async () => {
                try {
                    if (DEBUG_SESSION_HYDRATE) {
                        log.log(`[sessionHydrate] fetching session by id ${normalized}`);
                    }
                    const result = await fetchSessionByIdWithServerScope({
                        sessionId: normalized,
                        serverId: preferredServerId,
                        activeCredentials: credentials,
                        ...(embedScope ? { sessionKey: embedScope.sessionKey ?? null,
                            composerOptionsInput: embedScope.composerOptionsInput ?? null,
                            composerOptionsGrant: embedScope.composerOptionsGrant ?? null,
                            accountMode: embedScope.accountMode } : {}),
                        activeEncryption: this.encryption,
                        sessionDataKeys: this.sessionDataKeys,
                        sessionDataKeyEnvelopes: this.sessionDataKeyEnvelopes,
                        activeRequest: this.requestViaConfiguredSocket,
                        activeReadTransport: this.createAppliedReadTransport(appliedTransportTarget),
                        getExistingSession: readHydrationSession,
                        applySessions: this.applySessions,
                        log,
                        includeTurnsProjection,
                        authority: options?.authority,
                        accountCurrentnessSource: options?.accountCurrentnessSource,
                        isCurrent: isHydrationCurrent,
                    });
                    if (!result.ok) {
                        const code = typeof result.errorCode === 'string' ? result.errorCode : '';
                        if (code === 'stale_response') return createAwaitingPushSessionRouteResult(normalized, preferredServerId);
                        const missingCause = readTerminalSessionRouteMissingCause(code);
                        // Terminal errors should not spin forever in route hydration. Let the route render and fail closed.
                        if (missingCause) {
                            return { ...createMissingSessionRouteResult(normalized, preferredServerId, missingCause), errorCode: code };
                        }
                        return { ...createRetryableSessionRouteResult(
                            normalized,
                            preferredServerId,
                            readRetryableSessionRouteCause(code),
                        ), errorCode: code };
                    }

                    // A replacement encryption instance must acquire its own current hydration.
                    if (
                        !isHydrationCurrent()
                    ) {
                        return createAwaitingPushSessionRouteResult(normalized, preferredServerId);
                    }
                    const hydratedServerId = String(result.session?.serverId ?? '').trim();
                    const hydratedSession = result.session;
                    const currentListRow = readSessionListRowForServerId(storage.getState().sessionListRowsByServerId,
                        hydratedServerId || preferredServerId || activeServerId, normalized);
                    if (!hasAuthoritativeSessionRouteData(hydratedSession, {
                        hasSessionEncryption: Boolean(readSessionEncryption()),
                    })) {
                        return createRetryableSessionRouteResult(normalized, hydratedServerId || preferredServerId, 'decrypting');
                    }
                    if (hydratedSession && currentListRow
                        && !isHydratedSessionCurrentForListState(hydratedSession, () => currentListRow, result.sessionPublicationUpdatedAt)) {
                        return createAwaitingPushSessionRouteResult(normalized, hydratedServerId || preferredServerId);
                    }
                    // The active-Account keys this route needs are already committed by
                    // the canonical by-ID owner, which received this exact encryption
                    // instance as `activeEncryption`. Re-applying its result here made a
                    // second decision-maker for one committed hydration; a captured
                    // scoped authority still hydrates through its own instance inside
                    // `fetchSessionByIdWithServerScope`, so nothing mixes two Account
                    // owners for the same bare Session id.

                    if (!hydratedServerId || areServerProfileIdentifiersEquivalent(hydratedServerId, activeServerId)) {
                        this.activeServerSessionIds.add(normalized);
                    }
                    if (DEBUG_SESSION_HYDRATE) {
                        const hasEncryption = result.session?.encryptionMode === 'plain'
                            ? false
                            : Boolean(this.encryption?.getSessionEncryption(normalized));
                        log.log(`[sessionHydrate] hydration ok ${normalized} hasEncryption=${hasEncryption}`);
                    }
                    return createAvailableSessionRouteResult(
                        normalized,
                        hydratedServerId || preferredServerId,
                    );
                } catch (err) {
                    if (isTerminalAuthError(err)) {
                        this.recordTerminalAuthSyncError(err, { serverId: preferredServerId });
                        return createMissingSessionRouteResult(normalized, preferredServerId, 'unauthorized');
                    }
                    log.log(`⚠️ ensureSessionVisibleForMessageRoute failed for ${normalized}: ${err instanceof Error ? err.message : 'unknown error'}`);
                    return { ...createRetryableSessionRouteResult(
                        normalized,
                        preferredServerId,
                        classifyRouteHydrationErrorCause(err),
                    ), ...(err instanceof HappyError && err.code ? { errorCode: err.code } : {}) };
                }
            })();

            const inFlightEntry = Object.freeze({
                sessionId: normalized,
                serverId: preferredServerId,
                encryption: readerEncryption,
                isCurrent: isHydrationCurrent,
                promise: inFlight,
                readSessionEncryption,
                invalidate: () => {
                    hydrationCurrent = false;
                    if (this.sessionByIdHydrationInFlight.get(inFlightKey) === inFlightEntry) {
                        this.sessionByIdHydrationInFlight.delete(inFlightKey);
                    }
                },
            });
            this.sessionByIdHydrationInFlight.set(inFlightKey, inFlightEntry);
            inFlight.finally(() => {
                if (this.sessionByIdHydrationInFlight.get(inFlightKey) === inFlightEntry) {
                    this.sessionByIdHydrationInFlight.delete(inFlightKey);
                }
            });

            const result = await inFlight;
            if (result.kind === 'available' && options?.scopeCurrentness?.() !== false) {
                options?.onHydratedSessionReader?.(readSessionEncryption);
            }
            return finishMessageHydration(result);
        }

    private invalidateSessionByIdHydration = (sessionId: string): void => {
        const normalized = String(sessionId ?? '').trim();
        if (!normalized) return;
        for (const [key, entry] of this.sessionByIdHydrationInFlight) {
            if (entry.sessionId !== normalized) continue;
            entry.invalidate();
            this.sessionByIdHydrationInFlight.delete(key);
        }
        this.sessionDataKeys.delete(normalized);
        this.sessionDataKeyEnvelopes.delete(normalized);
    };

    private isSessionListMemberOnHome(serverIdRaw: string, sessionId: string): boolean {
        const serverId = String(serverIdRaw ?? '').trim();
        if (!serverId) return false;
        const state = storage.getState();
        return (state.ordinarySessionListMembershipByServerId[serverId] ?? []).includes(sessionId)
            || (state.archivedSessionListMembershipByServerId[serverId] ?? []).includes(sessionId);
    }

    private readonly applySessionListRowProjections = (entries: readonly SessionListRowPublication[]): void => {
        const byServer = new Map<string, SessionListRenderableSession[]>();
        for (const { serverId, row } of entries) {
            const group = byServer.get(serverId) ?? [];
            group.push(row);
            byServer.set(serverId, group);
        }
        for (const [serverId, rows] of byServer) storage.getState().applyServerScopedSessionListRows(serverId, rows, {
            source: 'rowOnly', mode: 'append',
        });
    };

    private refreshSessionListRowProjection = async (
        serverId: string,
        sessionId: string,
        suppliedCurrentnessSource?: ReturnType<typeof createOperationAccountCurrentnessSource>,
    ): Promise<void> => {
        const target = this.getAppliedTransportTarget();
        const credentials = this.credentials;
        const encryption = this.encryption;
        const generation = this.serverScopeGeneration;
        if (!target || !credentials || !areServerProfileIdentifiersEquivalent(serverId, target.serverId)) {
            throw new Error('Session projection AccountChange scope is unavailable');
        }
        const retirementFence = captureSessionListRetirementFence();
        const request = this.createAppliedTransportRequest(target);
        const accountCurrentnessSource = suppliedCurrentnessSource
            ?? createOperationAccountCurrentnessSource({ credentials, request, serverId });
        const isCurrent = () => this.serverScopeGeneration === generation
            && this.isAppliedTransportTargetCurrent(target)
            && this.credentials === credentials
            && this.encryption === encryption
            && accountCurrentnessSource.isCurrent()
            && !wasSessionRetiredSinceFence(retirementFence, serverId, sessionId);
        const readExistingSession = (id: string): Session | null => {
            const session = storage.getState().sessions[id];
            return session && areServerProfileIdentifiersEquivalent(session.serverId, serverId) ? session : null;
        };
        try {
            const result = await fetchSessionByIdWithServerScope({
                sessionId,
                serverId,
                contentDemand: 'list-projection',
                activeCredentials: credentials,
                activeEncryption: encryption,
                sessionDataKeys: this.sessionDataKeys,
                sessionDataKeyEnvelopes: this.sessionDataKeyEnvelopes,
                activeRequest: request,
                accountCurrentnessSource,
                activeReadTransport: this.createAppliedReadTransport(target),
                applySessions: (sessions) => { if (isCurrent()) this.applySessions(sessions); },
                applySessionListRows: this.applySessionListRowProjections,
                getExistingSession: readExistingSession,
                getCurrentSessionListRenderable: (id) => readSessionListRowForServerId(storage.getState().sessionListRowsByServerId, serverId, id),
                includeTurnsProjection: false,
                isCurrent,
                log,
            });
            if (!isCurrent()) throw new Error('Session projection AccountChange scope changed during refresh');
            if (!result.ok) {
                if (result.errorCode === 'not_found') {
                    this.retireLocalSession(sessionId, serverId);
                    return;
                }
                throw new Error(`Session projection refresh failed: ${result.errorCode ?? 'unknown'}`);
            }
            if (!result.sessionListRenderable) throw new Error('Session projection refresh returned no row');
            if (readExistingSession(sessionId)) this.markSessionStateHydrationDeferred(sessionId);
        } finally { if (!suppliedCurrentnessSource) accountCurrentnessSource.dispose(); }
    };

    /**
     * Listed row changes always reconcile the exact Session's access/currentness.
     * Offscreen rows use the canonical list projection without opening a Session key;
     * demanded rows keep their full hydration. Authoritative exact absence retires
     * the row, and failed projection reads hold the change cursor for a later retry.
     * Unreadable demanded rows retain the existing list-refresh repair.
     */
    private refreshListedSessionRows = async (serverId: string, sessionIds: readonly string[]): Promise<void> => {
        if (sessionIds.length === 0) return;
        const target = this.getAppliedTransportTarget();
        const credentials = this.credentials;
        if (!target || !credentials || !areServerProfileIdentifiersEquivalent(serverId, target.serverId)) {
            throw new Error('Session projection AccountChange scope is unavailable');
        }
        // Server-admitted list projections borrow the connected identity. Keep
        // one lazy exact source for demanded hydration or an unbound transport;
        // every borrower retains this pass's semantic invalidation fence.
        const accountCurrentnessSource = createOperationAccountCurrentnessSource({
            credentials, request: this.createAppliedTransportRequest(target), serverId,
        });
        const unreadable: string[] = [];
        try {
            const projectionReads: Promise<void>[] = [];
            const demandedHydrations: Array<() => Promise<void>> = [];
            for (const sessionId of sessionIds) {
                if (!this.isSessionHydrationDemanded(sessionId, serverId)) {
                    // Submit the logical set before awaiting admission. The shared
                    // parts reader owns physical batching and its HTTP body budget;
                    // a crypto worker window here fragments it into serial reads.
                    projectionReads.push(this.refreshSessionListRowProjection(serverId, sessionId, accountCurrentnessSource));
                } else {
                    demandedHydrations.push(async () => {
                        const result = await this.ensureSessionVisibleForMessageRoute(sessionId, {
                            forceRefresh: true,
                            hydrateMessages: false,
                            accountCurrentnessSource,
                            ...(serverId ? { serverId } : {}),
                        });
                        if (result.kind !== 'available') unreadable.push(sessionId);
                    });
                }
            }
            // Keep the finite witness alive for every admitted borrower, including
            // siblings still completing after a row fails. A failure still holds
            // the containing Account-change cursor for recovery.
            const outcomes = await Promise.allSettled([
                ...projectionReads,
                runTasksWithLimit(demandedHydrations, this.syncTuning.sessionListHydrationConcurrencyLimit),
            ]);
            for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
        } finally { accountCurrentnessSource.dispose(); }
        if (unreadable.length === 0) return;
        await this.fetchSessions({
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: unreadable,
            prioritizeSessionIds: unreadable,
        });
    };

    /** Join the existing Availability queue after an authenticated declaration claim. */
    public refreshPluginAccountAvailability = async (): Promise<void> => {
        await this.pluginAvailabilitySync.invalidateAndAwait({ settleOnFirstAttempt: true });
    };

    public invalidateSessionListSnapshot = (serverId?: string | null): void => {
        if (serverId && !areServerProfileIdentifiersEquivalent(serverId, this.appliedServerTarget?.serverId)) return;
        this.sessionListSnapshotGeneration += 1;
        this.fetchSessionsInFlight = null;
        this.sessionsSync.invalidate();
    };

    private invalidateDeletedSessionHydration = (sessionId: string): void => {
        this.invalidateSessionByIdHydration(sessionId);
        this.invalidateSessionListSnapshot();
    };

    private keepPendingMessageForRetryableCommitFailure(params: Readonly<{
        sessionId: string;
        localId: string;
        error: unknown;
    }>): boolean {
        if (isTerminalAuthError(params.error)) {
            return false;
        }

        this.schedulePendingMessageCommitRetry({
            sessionId: params.sessionId,
            localId: params.localId,
        });
        return true;
    }

    async sendMessage(
        sessionId: string,
        text: string,
        displayText?: string,
        metaOverrides?: Record<string, unknown>,
        options?: Readonly<{
            profileId?: string | null;
            localId?: string | null;
            hostAdmissionOrigin?: SessionMessageHostAdmissionOrigin;
            bypassPendingQueueReason?: SessionMessageDirectBypassReason;
            onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void;
            preserveExistingPendingProjection?: boolean;
            serverId?: string | null;
            accountLifetime?: ServerAccountScopeLifetime;
            session?: Session;
            /** The models this sender may run; the message runs on the first allowed one when needed. */
            allowedModels?: readonly ProviderBoundModelRef[] | null;
            allowedPermissionModes?: readonly PermissionMode[] | null;
        }>
    ): Promise<DirectMessageSubmitResult> {
        const embedScope = this.embedSessionScope;
        const exactAccountLifetime = options?.accountLifetime;
        const exactScopeError = () => Object.assign(
            new Error('Session Account authority is unavailable'),
            { code: 'session_account_scope_retired' },
        );
        const assertExactAccountCurrent = (): void => {
            if (embedScope && (this.embedSessionScope !== embedScope || !embedScope.isCurrent() || sessionId !== embedScope.scope.sessionId)) throw exactScopeError();
            if (exactAccountLifetime && !exactAccountLifetime.isCurrent()) throw exactScopeError();
        };
        const assertExactActiveTransport = (): void => {
            assertExactAccountCurrent();
            if (
                exactAccountLifetime
                && !areServerAccountScopesEqual(getActiveServerAccountScope(), exactAccountLifetime.scope)
            ) {
                throw Object.assign(
                    new Error('Exact Session direct transport is unavailable for this Home'),
                    { code: 'session_exact_transport_unavailable' },
                );
            }
        };
        assertExactAccountCurrent();
        if (
            exactAccountLifetime
            && options?.serverId
            && !areServerProfileIdentifiersEquivalent(options.serverId, exactAccountLifetime.scope.serverId)
        ) {
            throw exactScopeError();
        }
        if (exactAccountLifetime) assertExactActiveTransport();

        let session = exactAccountLifetime
            ? options?.session ?? null
            : storage.getState().sessions[sessionId] ?? null;
        if (
            exactAccountLifetime
            && (
                session?.id !== sessionId
                || !session.serverId
                || !areServerProfileIdentifiersEquivalent(session.serverId, exactAccountLifetime.scope.serverId)
            )
        ) {
            throw exactScopeError();
        }
        if (!session) {
            try {
                await this.ensureSessionVisibleForMessageRoute(sessionId, { forceRefresh: true });
            } catch {
                // Best effort only. Fall through to the missing-session error below if the hydrate did not land.
            }
            session = storage.getState().sessions[sessionId] ?? null;
        }
        if (!session) {
            storage.getState().clearSessionOptimisticThinking(sessionId);
            throw new Error(`Session ${sessionId} not found in storage`);
        }

        assertCanSendUserMessageToSession(session, {
            resumeCapabilityOptions: { accountSettings: storage.getState().settings },
        });

        this.markSessionLiveTailIntent(sessionId);
        storage.getState().markSessionOptimisticThinking(sessionId);

        const sessionEncryptionMode: 'e2ee' | 'plain' = session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
        const currentSettings = storage.getState().settings;
        assertUiSessionEncryptionModeAllowed({
            mode: sessionEncryptionMode,
            requirement: resolveUiClientEncryptionRequirement({
                syncedSettings: currentSettings,
                localSettings: currentSettings,
            }),
        });

        try {
            // Read permission mode from session state
            const permissionMode = session.permissionMode || 'default';
            
            // Read model mode - default is agent-specific (Gemini needs an explicit default)
            const agentId = readSessionPresentationAgentId(session);
            const modelMode = session.modelMode;

            if (options?.localId != null && readPendingLocalId(options.localId) === null) {
                throw new Error('Pending localId must not be blank');
            }
            const requestedLocalId = readPendingLocalId(options?.localId) ?? '';
            const localId = requestedLocalId || randomUUID();
            const pendingMessageBeforeSend = (storage.getState().sessionPending[sessionId]?.messages ?? [])
                .find((message) => message.id === localId || message.localId === localId);
            if (pendingMessageBeforeSend?.pendingOutboxScope) {
                throw new Error('A durable pending operation already owns this local message');
            }
            const pendingMessageExistedBeforeSend = pendingMessageBeforeSend != null;
            const preserveExistingPendingProjection = options?.preserveExistingPendingProjection === true
                && pendingMessageBeforeSend != null;
            const removeLocallyOwnedPendingMessage = () => {
                // A server snapshot can take custody while the Socket ACK
                // is in flight. This send only owns its local projection.
                const pending = storage.getState().sessionPending[sessionId]?.messages
                    .find((message) => message.id === localId || message.localId === localId);
                if (pending?.source === 'server_pending') return;
                storage.getState().removePendingMessage(sessionId, localId);
            };
            const removePendingMessageCreatedForSend = () => {
                if (!pendingMessageExistedBeforeSend) removeLocallyOwnedPendingMessage();
            };

            const sentFrom = resolveSentFrom();
            const content = buildOutgoingUserTextRecord({
                text,
                displayText,
                permissionMode,
                agentId,
                modelMode,
                settings: storage.getState().settings,
                session,
                metaOverrides,
                hostAdmissionOrigin: options?.hostAdmissionOrigin,
                sentFrom,
                allowedModels: options?.allowedModels,
                allowedPermissionModes: options?.allowedPermissionModes,
            });
            const selectedComposerAttachment = hasRawComposerAttachmentSelectionV1(content.meta);

            const messagePayload =
                sessionEncryptionMode === 'plain'
                    ? { t: 'plain' as const, v: content }
                    : await (async () => {
                        assertExactActiveTransport();
                        const encryption = this.encryption?.getSessionEncryption(sessionId);
                        if (!encryption) {
                            throw new Error(`Session ${sessionId} encryption not found`);
                        }
                        const encrypted = await encryption.encryptRawRecord(content);
                        assertExactActiveTransport();
                        return encrypted;
                    })();

            assertExactActiveTransport();

            // Track this outbound user message in the local pending queue until it is committed.
            // This prevents “ghost” optimistic transcript items when the send fails, and it lets the UI
            // show a pending bubble while we await ACK / catch-up.
            const createdAt = pendingMessageBeforeSend?.createdAt ?? nowServerMs();
            if (!preserveExistingPendingProjection) {
                storage.getState().upsertPendingMessage(sessionId, buildLocalOutboundPendingUserMessage({
                    localId,
                    createdAt,
                    updatedAt: createdAt,
                    deliveryStatus: 'queued',
                    text,
                    displayText,
                    rawRecord: content,
                }));
                options?.onLocalPendingProjectionCreated?.({ localId });
            }
            const canUseActiveSessionRuntimeRpc = session.active === true
                && canUseSessionUserMessageRuntimeRpc(session);
            let runtimeRpcFallbackRequiresEnsure = false;
            if (selectedComposerAttachment && !canUseActiveSessionRuntimeRpc) {
                removePendingMessageCreatedForSend();
                throw composerAttachmentRuntimeRequiredError();
            }
            if (canUseActiveSessionRuntimeRpc) {
                try {
                        assertExactActiveTransport();
                        const rawResponse = await apiSocket.sessionRPC<unknown, {
                            text: string;
                            localId: string;
                            meta: Record<string, unknown>;
                        }>(
                            sessionId,
                            SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND,
                            {
                                text,
                                localId,
                                meta:
                                    content.meta && typeof content.meta === 'object' && !Array.isArray(content.meta)
                                        ? (content.meta as Record<string, unknown>)
                                        : {},
                            },
                            { timeoutMs: this.syncTuning.sessionRpcTimeoutMs },
                        );
                        const response = SessionUserMessageSendResponseSchema.safeParse(rawResponse);
                        if (
                            response.success
                            && response.data.ok === true
                            && exactAccountLifetime
                            && !exactAccountLifetime.isCurrent()
                        ) {
                            return { localId, persistence: 'provider_direct', providerAcceptancePending: true };
                        }
                        assertExactActiveTransport();
                        if (!response.success) {
                            throw new HappyError(
                                'Session message runtime returned an invalid acknowledgement',
                                false,
                                { kind: 'server', code: 'session_user_message_invalid_response' },
                            );
                        }
                        if (response.data.ok !== true) {
                            throw new HappyError(
                                response.data.error,
                                false,
                                { kind: 'server', code: response.data.errorCode },
                            );
                        }
                        if (preserveExistingPendingProjection) {
                            const existing = (storage.getState().sessionPending[sessionId]?.messages ?? [])
                                .find((message) => message.id === localId || message.localId === localId);
                            if (existing) {
                                storage.getState().upsertPendingMessage(sessionId, {
                                    ...existing,
                                    updatedAt: nowServerMs(),
                                    deliveryStatus: 'accepted',
                                    sendState: undefined,
                                });
                            }
                        } else {
                            storage.getState().upsertPendingMessage(sessionId, buildLocalOutboundPendingUserMessage({
                                localId,
                                createdAt,
                                updatedAt: nowServerMs(),
                                deliveryStatus: 'accepted',
                                text,
                                displayText,
                                rawRecord: content,
                            }));
                        }
                        return { localId, persistence: 'provider_direct', providerAcceptancePending: true };
                } catch (error) {
                        if (isSocketIoAckTimeoutError(error)) {
                            if (exactAccountLifetime) {
                                removePendingMessageCreatedForSend();
                                throw error;
                            }
                            if (preserveExistingPendingProjection) {
                                const existing = (storage.getState().sessionPending[sessionId]?.messages ?? [])
                                    .find((message) => message.id === localId || message.localId === localId);
                                if (existing) {
                                    storage.getState().upsertPendingMessage(sessionId, {
                                        ...existing,
                                        updatedAt: nowServerMs(),
                                        sendState: 'unconfirmed',
                                    });
                                }
                            } else {
                                storage.getState().upsertPendingMessage(sessionId, {
                                    ...buildLocalOutboundPendingUserMessage({
                                        localId,
                                        createdAt,
                                        updatedAt: nowServerMs(),
                                        deliveryStatus: 'queued',
                                        text,
                                        displayText,
                                        rawRecord: content,
                                    }),
                                    sendState: 'unconfirmed',
                                });
                            }
                            return { localId, persistence: 'pending' as const };
                        }
                        if (!isFallbackSafeSessionUserMessageRpcError(error)) {
                            removeLocallyOwnedPendingMessage();
                            throw error;
                        }
                        if (selectedComposerAttachment) {
                            removePendingMessageCreatedForSend();
                            throw composerAttachmentRuntimeRequiredError();
                        }
                        if (options?.bypassPendingQueueReason === 'selected_direct') {
                            removePendingMessageCreatedForSend();
                            const queued = await this.enqueuePendingMessage(
                                sessionId,
                                text,
                                displayText,
                                metaOverrides,
                                {
                                    localId,
                                    ...(exactAccountLifetime ? {
                                        serverId: exactAccountLifetime.scope.serverId,
                                        accountLifetime: exactAccountLifetime,
                                    } : {}),
                                    hostAdmissionOrigin: options?.hostAdmissionOrigin,
                                    allowedModels: options?.allowedModels,
                                    allowedPermissionModes: options?.allowedPermissionModes,
                                    requestedAction: { v: 1, kind: 'enqueue' },
                                },
                            );
                            return { localId: queued.localId, persistence: 'pending' as const };
                        }
                        runtimeRpcFallbackRequiresEnsure = true;
                }
            }

            const payload = {
                sid: sessionId,
                message: messagePayload,
                localId,
                sentFrom,
                permissionMode: permissionMode || 'default',
                messageRole: 'user' as const,
            };

            const rawAck = await (async () => {
                try {
                    assertExactActiveTransport();
                    await this.assertActiveEndpointAuthenticated();
                    assertExactActiveTransport();
                    return await socketEmitWithAckFallback<MessageAckResponse>({
                        emitWithAck: (event, payload, opts) => {
                            assertExactActiveTransport();
                            return this.messageTransport.emitWithAck<MessageAckResponse>(event, payload, opts);
                        },
                        send: (event, payload) => {
                            assertExactActiveTransport();
                            return this.messageTransport.send(event, payload);
                        },
                        event: 'message',
                        payload,
                        onNoAck: () => {
                            if (!exactAccountLifetime) this.schedulePendingMessageCommitRetry({ sessionId, localId });
                        },
                        beforeFallback: async () => {
                            assertExactActiveTransport();
                            await this.assertActiveEndpointAuthenticated({ forceProbe: true });
                            assertExactActiveTransport();
                        },
                    });
                } catch (error) {
                    if (exactAccountLifetime) {
                        removeLocallyOwnedPendingMessage();
                        throw error;
                    }
                    if (this.keepPendingMessageForRetryableCommitFailure({ sessionId, localId, error })) {
                        return null;
                    }
                    removeLocallyOwnedPendingMessage();
                    throw error;
                }
            })();

            if (!rawAck) {
                if (exactAccountLifetime) {
                    removeLocallyOwnedPendingMessage();
                    throw Object.assign(new Error('Exact Session delivery acknowledgement is unavailable'), {
                        code: 'session_exact_transport_unavailable',
                    });
                }
                storage.getState().clearSessionOptimisticThinking(sessionId);
                return { localId, persistence: 'pending' };
            }

            const parsedAck = MessageAckResponseSchema.safeParse(rawAck);
            if (!parsedAck.success) {
                if (exactAccountLifetime) {
                    removeLocallyOwnedPendingMessage();
                    throw new Error('Exact Session delivery returned an invalid acknowledgement');
                }
                // Treat malformed ACKs as "no ACK": keep the pending bubble and retry later.
                this.schedulePendingMessageCommitRetry({ sessionId, localId });
                return { localId, persistence: 'pending' };
            }

            const ack = parsedAck.data;

            if (ack.ok === true && exactAccountLifetime && !exactAccountLifetime.isCurrent()) {
                return { localId, seq: ack.seq, persistence: 'transcript_committed' };
            }
            assertExactActiveTransport();

            if (ack.ok !== true) {
                removeLocallyOwnedPendingMessage();
                throw new Error(ack.error || 'Message send rejected');
            }

            this.commitAckedOutboundUserMessage({
                sessionId,
                localId,
                createdAt,
                rawRecord: content,
                ack,
            });

            if (
                !embedScope && (!exactAccountLifetime || exactAccountLifetime.isCurrent())
                && (session.active !== true || runtimeRpcFallbackRequiresEnsure)
            ) {
                ensureSessionRuntimeAfterCommittedPrompt({
                    sessionId,
                    session,
                    seq: ack.seq,
                    tag: 'Sync.sendMessage.wakeAfterSend',
                    ...(exactAccountLifetime ? {
                        serverId: exactAccountLifetime.scope.serverId,
                        accountLifetime: exactAccountLifetime,
                    } : {}),
                });
            }

	            // Server ACK means the user message is committed (or idempotently confirmed).
	            // Do NOT clear optimistic thinking here: the agent can still be mid-turn (streaming / tool calls).
            // We clear optimistic thinking only when we see a terminal lifecycle marker (task_complete / turn_aborted),
            // when the session enters a permission/action-required gate, when the session is marked thinking by live
            // activity updates, or when the optimistic timeout expires.
            return { localId, seq: ack.seq, persistence: 'transcript_committed' };
        } catch (e) {
            if (embedScope && (this.embedSessionScope !== embedScope || !embedScope.isCurrent())) throw e;
            if (isTerminalAuthError(e)) {
                this.recordTerminalAuthSyncError(e, {
                    serverId: exactAccountLifetime?.scope.serverId,
                });
            }
            storage.getState().clearSessionOptimisticThinking(sessionId);
            throw e;
        }
    }

    async sendPendingMessageNow(sessionId: string, pending: {
        localId: string;
        createdAt: number;
        rawRecord: unknown;
        text: string;
        displayText?: string;
        deliveryIntent?: SendPendingMessageNowDeliveryIntent;
    }, options?: PendingQueueOwnerOptions): Promise<SendPendingMessageNowResult> {
        const embedScope = this.embedSessionScope;
        const requestedAddress = normalizeSessionAddress(options?.serverId, sessionId);
        const { recipient, outboxScope, session } = await this.withPendingQueueOwnerContext(
            sessionId,
            async ({ outboxScope, isCurrent }) => {
                const { recipient } = await resolvePendingMutationIdentity(sessionId, pending.localId, outboxScope);
                const ownerAddress = normalizeSessionAddress(outboxScope.serverId, sessionId);
                if (!ownerAddress) throw new Error('Pending action requires an exact Session address');
                if (requestedAddress && sessionAddressKey(ownerAddress) !== sessionAddressKey(requestedAddress)) {
                    throw new Error('Pending action owner does not match the requested Session address');
                }
                if (!await isCurrent()) throw new Error('Pending owner server-account scope changed');
                const exactSession = embedScope
                    ? await this.refreshSessionForSubmit(sessionId)
                    : requestedAddress
                    ? (await runWithServerRequestAuthorityForServerAccountScope({
                        scope: outboxScope,
                        activeRequest: this.createSessionRequest(sessionId),
                    }, async (authority) => await readSessionSnapshotForAuthority({
                        authority,
                        sessionId,
                    }))).session
                    : storage.getState().sessions[sessionId];
                if (!await isCurrent()) throw new Error('Pending owner server-account scope changed');
                return { recipient, outboxScope, session: exactSession };
            },
            undefined,
            requestedAddress?.serverId,
        );
        if (!session) {
            if (!recipient && !requestedAddress) storage.getState().clearSessionOptimisticThinking(sessionId);
            throw new Error(`Session ${sessionId} not found in storage`);
        }

        await assertPendingMessageProjectionTransportableV2(sessionId, pending.localId, outboxScope);

        const deliveryIntent = pending.deliveryIntent ?? 'interrupt_and_send';
        const projectedSession = storage.getState().sessions[sessionId];
        const ownsProjectedSessionState = !requestedAddress || Boolean(
            projectedSession?.serverId
                ? areServerProfileIdentifiersEquivalent(projectedSession.serverId, requestedAddress.serverId)
                : areServerProfileIdentifiersEquivalent(
                    requestedAddress.serverId,
                    this.getAppliedTransportTarget()?.serverId,
                ),
        );
        if (!recipient && ownsProjectedSessionState) {
            this.markSessionLiveTailIntent(sessionId);
            storage.getState().markSessionOptimisticThinking(sessionId);
        }

        try {
            const state = storage.getState();
            const result = await submitSessionUserMessage(this.createSessionSubmitPort(), {
                sessionId,
                ...(requestedAddress ? { serverId: requestedAddress.serverId } : {}),
                recipient,
                session,
                text: pending.text,
                displayText: pending.displayText,
                metaOverrides: sanitizePendingMessageMetaForExplicitSubmit(pending.rawRecord),
                localId: pending.localId,
                configuredMode: state.settings.sessionMessageSendMode,
                busySteerSendPolicy: state.settings.sessionBusySteerSendPolicy,
                resumeCapabilityOptions: { accountSettings: state.settings },
                permissionOverride: getPermissionModeOverrideForSpawn(session),
                callerSurface: deliveryIntent === 'interrupt_and_send'
                    ? 'pending_message_send_now'
                    : 'pending_message_steer_now',
                requestedAction: deliveryIntent === 'steer_now'
                    ? { v: 1, kind: 'steer_now' }
                    : { v: 1, kind: 'send_now' },
                ...(deliveryIntent === 'interrupt_and_send'
                    ? { explicitMode: 'interrupt' as const }
                    : { forceImmediate: true }),
                existingDurablePendingMessage: true,
            });

            if (result.type === 'send_failed' || result.type === 'rejected' || result.type === 'wake_failed') {
                if (!recipient && ownsProjectedSessionState) storage.getState().clearSessionOptimisticThinking(sessionId);
                if (result.errorCode === SESSION_MESSAGE_SEND_NOT_RESUMABLE_ERROR_CODE) {
                    throw new HappyError(
                        result.errorMessage ?? 'This inactive session cannot be resumed; the pending message remains queued.',
                        false,
                        { kind: 'config', code: SESSION_MESSAGE_SEND_NOT_RESUMABLE_ERROR_CODE },
                    );
                }
                throw createSessionMessageSubmitFailureError(
                    result.errorCode,
                    result.errorMessage,
                    'Message send rejected',
                );
            }

            if (result.persistence === 'provider_direct' || result.persistence === 'transcript_committed') {
                return {
                    type: 'committed',
                    persistence: result.persistence,
                    ...(result.providerAcceptancePending === true ? { providerAcceptancePending: true } : {}),
                };
            }

            return { type: 'retry_scheduled' };
        } catch (e) {
            if (isTerminalAuthError(e)) {
                this.recordTerminalAuthSyncError(e, { serverId: outboxScope.serverId });
            }
            if (!recipient && ownsProjectedSessionState) storage.getState().clearSessionOptimisticThinking(sessionId);
            throw e;
        }
    }

    private schedulePendingMessageCommitRetry(params: { sessionId: string; localId: string }): void {
        const embedScope = this.embedSessionScope;
        const isCurrent = () => !embedScope || this.embedSessionScope === embedScope && embedScope.isCurrent();
        const key = `${params.sessionId}:${params.localId}`;
        if (this.pendingMessageCommitRetryTimers.has(key)) {
            return;
        }

        const clearRetry = (): void => {
            const existing = this.pendingMessageCommitRetryTimers.get(key);
            if (existing) {
                clearTimeout(existing);
            }
            this.pendingMessageCommitRetryTimers.delete(key);
        };

        const run = async (attempt: number): Promise<void> => {
            if (!isCurrent()) { clearRetry(); return; }
            const pendingState = storage.getState().sessionPending[params.sessionId];
            const pending = pendingState?.messages?.find((m) => m.id === params.localId) ?? null;
            if (!pending) {
                clearRetry();
                return;
            }

            const scheduleRetryWithBackoff = () => {
                if (!isCurrent()) { clearRetry(); return; }
                fireAndForget((embedScope ? this.refreshEmbedSessionSnapshot() : this.fetchSessions()).then(() => undefined), { tag: 'Sync.pendingMessageCommitRetry.fetchSessions' });

                const nextAttempt = attempt + 1;
                if (nextAttempt >= 6) {
                    clearRetry();
                    return;
                }

                const baseDelayMs = Math.min(30_000, 1_000 * Math.pow(2, nextAttempt));
                const jitterMs = Math.floor(Math.random() * 250);
                const timeout = setTimeout(() => {
                    fireAndForget(run(nextAttempt), { tag: `Sync.pendingMessageCommitRetry:${key}` });
                }, baseDelayMs + jitterMs);
                this.pendingMessageCommitRetryTimers.set(key, timeout);
            };

            const session = storage.getState().sessions[params.sessionId] ?? null;
            if (!session) {
                scheduleRetryWithBackoff();
                return;
            }
            if (!canSendUserMessageToSession(session, {
                resumeCapabilityOptions: { accountSettings: storage.getState().settings },
            })) {
                storage.getState().removePendingMessage(params.sessionId, params.localId);
                storage.getState().clearSessionOptimisticThinking(params.sessionId);
                clearRetry();
                return;
            }

            const sessionEncryptionMode: 'e2ee' | 'plain' = session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
            const parsed = OutgoingUserTextRecordSchema.safeParse(pending.rawRecord);
            const rawRecord: RawRecord = parsed.success
                ? parsed.data
                : {
                    role: 'user',
                    content: { type: 'text', text: pending.text },
                    meta: {},
                };

            if (hasRawComposerAttachmentSelectionV1(rawRecord.meta)) {
                try {
                    await this.sendMessage(
                        params.sessionId,
                        pending.text,
                        pending.displayText,
                        rawRecord.meta,
                        { localId: params.localId, preserveExistingPendingProjection: true },
                    );
                } catch {
                    // The canonical sender preserves this durable row when the active runtime
                    // cannot admit its selected attachment. Never reinterpret it as raw socket input.
                }
                clearRetry();
                return;
            }

            const messagePayload =
                sessionEncryptionMode === 'plain'
                    ? { t: 'plain' as const, v: rawRecord }
                    : await (async () => {
                        const sessionEncryption = this.encryption?.getSessionEncryption(params.sessionId);
                        if (!sessionEncryption) {
                            scheduleRetryWithBackoff();
                            return null;
                        }
                        return await sessionEncryption.encryptRawRecord(rawRecord);
                    })();
            if (!messagePayload) {
                return;
            }
            if (!isCurrent()) { clearRetry(); return; }

            const payload = {
                sid: params.sessionId,
                message: messagePayload,
                localId: params.localId,
                sentFrom: 'retry',
                permissionMode: 'default',
                messageRole: 'user' as const,
            };

            let terminalAuthFailure = false;
            const rawAck = await (async () => {
                try {
                    await this.assertActiveEndpointAuthenticated();
                    if (!isCurrent()) throw new StaleServerGenerationError();
                    return await this.messageTransport.emitWithAck<MessageAckResponse>('message', payload, {
                        timeoutMs: null,
                    });
                } catch (error) {
                    if (!isCurrent()) return null;
                    let terminalError = error;
                    if (!isTerminalAuthError(terminalError)) {
                        try {
                            await this.assertActiveEndpointAuthenticated({ forceProbe: true });
                        } catch (probeError) {
                            terminalError = probeError;
                        }
                    }
                    if (!isCurrent()) return null;
                    if (isTerminalAuthError(terminalError)) {
                        terminalAuthFailure = true;
                        this.recordTerminalAuthSyncError(terminalError);
                        storage.getState().removePendingMessage(params.sessionId, params.localId);
                        storage.getState().clearSessionOptimisticThinking(params.sessionId);
                        clearRetry();
                    }
                    return null;
                }
            })();
            if (!isCurrent()) { clearRetry(); return; }
            if (terminalAuthFailure) {
                return;
            }

            const ack = rawAck ? MessageAckResponseSchema.safeParse(rawAck) : null;

            if (ack?.success && ack.data.ok === true) {
                this.commitAckedOutboundUserMessage({
                    sessionId: params.sessionId,
                    localId: params.localId,
                    createdAt: pending.createdAt,
                    rawRecord,
                    ack: ack.data,
                });

                clearRetry();
                return;
            }

            if (ack?.success && ack.data.ok === false) {
                storage.getState().removePendingMessage(params.sessionId, params.localId);
                clearRetry();
                return;
            }

            const nextAttempt = attempt + 1;
            if (nextAttempt >= 6) {
                clearRetry();
                return;
            }

            const baseDelayMs = Math.min(30_000, 1_000 * Math.pow(2, nextAttempt));
            const jitterMs = Math.floor(Math.random() * 250);
            const timeout = setTimeout(() => {
                fireAndForget(run(nextAttempt), { tag: `Sync.pendingMessageCommitRetry:${key}` });
            }, baseDelayMs + jitterMs);
            this.pendingMessageCommitRetryTimers.set(key, timeout);
        };

        const timeout = setTimeout(() => {
            fireAndForget(run(0), { tag: `Sync.pendingMessageCommitRetry:${key}` });
        }, 1_000);
        this.pendingMessageCommitRetryTimers.set(key, timeout);
    }

    schedulePendingOutboxOperationRetry(params: {
        sessionId: string;
        localId: string;
        outboxScope: ServerAccountScope;
    }): void {
        const embedScope = this.embedSessionScope;
        const isCurrent = () => !embedScope || this.embedSessionScope === embedScope && embedScope.isCurrent();
        const key = pendingOutboxProjectionIdentityKey(params);
        if (this.pendingOutboxOperationRetryTimers.has(key)) {
            return;
        }

        const clearRetry = (): void => {
            const existing = this.pendingOutboxOperationRetryTimers.get(key);
            if (existing) {
                clearTimeout(existing);
            }
            this.pendingOutboxOperationRetryTimers.delete(key);
        };

        const markSendFailed = async (): Promise<void> => {
            if (!isCurrent()) return;
            await setPendingMessageSendState(params.sessionId, params.localId, 'failed', params.outboxScope);
        };

        const scheduleRetryWithBackoff = async (attempt: number): Promise<void> => {
            if (!isCurrent()) { clearRetry(); return; }
            const nextAttempt = attempt + 1;
            if (nextAttempt >= 6) {
                await markSendFailed();
                clearRetry();
                return;
            }
            const baseDelayMs = Math.min(30_000, 1_000 * Math.pow(2, nextAttempt));
            const jitterMs = Math.floor(Math.random() * 250);
            const timeout = setTimeout(() => {
                fireAndForget(run(nextAttempt), { tag: `Sync.pendingOutboxOperationRetry:${key}` });
            }, baseDelayMs + jitterMs);
            this.pendingOutboxOperationRetryTimers.set(key, timeout);
        };

        const run = async (attempt: number): Promise<void> => {
            if (!isCurrent()) { clearRetry(); return; }
            try {
                const retry = async (request: ServerFetch, serverWireMode: ReturnType<typeof resolvePendingInputServerWireMode>) => {
                    if (!isCurrent()) { clearRetry(); return; }
                    const result = await retryPendingOutboxOperationV2({
                        sessionId: params.sessionId, localId: params.localId,
                        request, outboxScope: params.outboxScope, serverWireMode,
                    });
                    if (!isCurrent() || result.accepted || !shouldSchedulePendingOutboxTransportRetry(serverWireMode)) {
                        clearRetry();
                        return;
                    }
                    await scheduleRetryWithBackoff(attempt);
                };
                if (embedScope) {
                    await this.withPendingQueueOwnerContext(params.sessionId,
                        ({ request, serverWireMode }) => retry(request, serverWireMode), params.outboxScope);
                } else {
                    await runWithServerRequestAuthorityForServerAccountScope({
                        scope: params.outboxScope, activeRequest: this.createSessionRequest(params.sessionId),
                    }, async (authority) => retry(authority.request, resolvePendingInputServerWireMode(
                        await getServerFeaturesSnapshot({ serverId: params.outboxScope.serverId }),
                    )));
                }
            } catch (error) {
                if (!isCurrent()) { clearRetry(); return; }
                if (isTerminalAuthError(error)) {
                    this.recordTerminalAuthSyncError(error, { serverId: params.outboxScope.serverId });
                }
                await markSendFailed();
                clearRetry();
            }
        };

        const timeout = setTimeout(() => {
            fireAndForget(run(0), { tag: `Sync.pendingOutboxOperationRetry:${key}` });
        }, 1_000);
        this.pendingOutboxOperationRetryTimers.set(key, timeout);
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.withSessionRequestLifetime(undefined, signal => sessionRpcWithPreferredSessionScope<void, { reason: string }>({
            sessionId,
            method: 'abort',
            ...(signal ? { signal } : {}),
            payload: {
            reason: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`
            },
        }));
    }

    async updatePendingRequestedAction(
        sessionId: string,
        localId: string,
        requestedAction: PendingRequestedActionV1,
        options?: Readonly<{
            resumeWhenAvailable?: boolean;
            serverId?: string | null;
            accountLifetime?: ServerAccountScopeLifetime;
            signal?: AbortSignal;
        }>,
    ): Promise<PendingResetStartSetResultV1> {
        assertValidPendingMessageId(localId);
        return await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, serverWireMode, isCurrent, encryption }) => {
            if (requestedAction.kind === 'reset_start') await this.assertPendingResetStartAdmission(requestedAction.reset, outboxScope, serverWireMode, isCurrent, options?.signal);
            throwIfAborted(options?.signal);
            const { recipient } = await resolvePendingMutationIdentity(sessionId, localId, outboxScope);
            let receipt: PendingResetStartSetResultV1;
            try {
                receipt = await updatePendingRequestedActionV2({
                    sessionId,
                    localId,
                    requestedAction,
                    serverWireMode,
                    ...(options?.resumeWhenAvailable !== undefined
                        ? { resumeWhenAvailable: options.resumeWhenAvailable }
                        : {}),
                    request,
                    outboxScope,
                    isOutboxScopeCurrent: isCurrent,
                });
            } catch (error) {
                const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
                if (code === 'action-conflict' || code === 'not-found') {
                    try {
                        await fetchAndApplyPendingMessagesV2({
                            sessionId, recipient, encryption, request, outboxScope,
                            isOutboxScopeCurrent: isCurrent,
                        });
                    } catch (refreshError) {
                        log.log('Failed to reconcile pending messages after a stale requested action: ' + String(refreshError));
                    }
                }
                throw error;
            }
            if (options?.resumeWhenAvailable !== undefined && !options.accountLifetime) {
                await this.refreshSessionForSubmit(sessionId, {
                    serverId: outboxScope.serverId,
                });
            }
            return receipt;
        }, undefined, options?.serverId, options?.accountLifetime);
    }

    isSessionTargetRemoteToActiveServer = (sessionId: string): boolean => {
        const preferredServerId = resolvePreferredServerIdForSessionId(sessionId);
        const activeServerId = this.appliedServerTarget?.serverId;
        return Boolean(preferredServerId && !areServerProfileIdentifiersEquivalent(preferredServerId, activeServerId));
    }

    private createSessionSubmitPort(): SessionSubmitPort {
        const embedScope = this.embedSessionScope;
        const assertScope = () => {
            if (embedScope && (this.embedSessionScope !== embedScope || !embedScope.isCurrent())) throw new StaleServerGenerationError();
            if (!embedScope && isEmbedWindowContext()) throw new StaleServerGenerationError();
        };
        const canWakeMachineId = (machineId: string): boolean => {
            if (embedScope) return false;
            const machine = storage.getState().machines[machineId];
            if (machine?.storageMode === 'plain') return true;
            return Boolean(this.encryption?.getMachineEncryption(machineId));
        };

        return {
            enqueuePendingMessage: (targetSessionId, targetText, targetDisplayText, targetMetaOverrides, options) => {
                assertScope();
                return this.enqueuePendingMessage(targetSessionId, targetText, targetDisplayText, targetMetaOverrides, options);
            },
            sendMessage: (targetSessionId, targetText, targetDisplayText, targetMetaOverrides, options) => {
                assertScope();
                return this.sendMessage(targetSessionId, targetText, targetDisplayText, targetMetaOverrides, options);
            },
            abortSession: (targetSessionId) => { assertScope(); return this.abortSession(targetSessionId); },
            updatePendingRequestedAction: async (targetSessionId, localId, requestedAction, options) => {
                assertScope();
                await this.updatePendingRequestedAction(targetSessionId, localId, requestedAction, options);
            },
            ensureSessionRuntimeForPendingInput: async (options) => {
                assertScope();
                if (embedScope) throw new Error('Machine activation is unavailable to an embed Session');
                return await ensureSessionRuntimeForPendingInput(options);
            },
            shouldDelegatePendingActivationToDaemon: async (session, serverId, machineId) => {
                assertScope();
                if (embedScope) return false;
                return await shouldDelegatePendingActivationToDaemon({
                    session,
                    serverId,
                    machineId,
                    getServerFeaturesSnapshot,
                    getMachine: (targetMachineId) => storage.getState().machines[targetMachineId],
                });
            },
            isMachineReachable: (machineId, options) => {
                if (embedScope) return false;
                return isSessionSubmitMachineReachable(machineId, options);
            },
            refreshSessionForSubmit: (targetSessionId, options) => {
                assertScope(); return this.refreshSessionForSubmit(targetSessionId, options);
            },
            canWakeMachineId,
            isSessionTargetRemoteToActiveServer: (targetSessionId) =>
                this.isSessionTargetRemoteToActiveServer(targetSessionId),
        };
    }

    async submitMessage(
        sessionId: string,
        text: string,
        displayText?: string,
        metaOverrides?: Record<string, unknown>,
        options?: Readonly<{
            serverId?: string | null;
            accountLifetime?: ServerAccountScopeLifetime;
            recipient?: ParticipantRecipientV1;
            requestedAction?: PendingRequestedActionV1;
            resumeWhenAvailable?: true;
            callerSurface?: SessionMessageCallerSurface | null;
            forceImmediate?: boolean;
            hostAdmissionOrigin?: SessionMessageHostAdmissionOrigin;
            /** Stable authoring identity supplied by composer-owned retries. */
            localId?: string;
            onOutboundHandoff?: (handoff: SubmitSessionOutboundHandoff) => void;
        }>,
    ): Promise<SubmitSessionUserMessageResult> {
        let state = storage.getState();
        let session = state.sessions[sessionId] ?? null;
        if (!session) {
            try {
                await this.ensureSessionVisibleForMessageRoute(sessionId, {
                    forceRefresh: true,
                    ...(options?.serverId ? { serverId: options.serverId } : {}),
                });
            } catch {
                // Best effort only. Fall through to the low-level missing-session error if hydrate did not land.
            }
            state = storage.getState();
            session = state.sessions[sessionId] ?? null;
        }
        if (!session) {
            throw new Error(`Session ${sessionId} not available for pending-aware submit`);
        }

        const port = this.createSessionSubmitPort();

        const resumeCapabilityOptions: ResumeCapabilityOptions = {
            accountSettings: state.settings,
        };

        const result = await submitSessionUserMessage(port, {
            sessionId,
            ...(options?.serverId ? { serverId: options.serverId } : {}),
            ...(options?.accountLifetime ? { accountLifetime: options.accountLifetime } : {}),
            ...(options?.localId ? { localId: options.localId } : {}),
            recipient: options?.recipient,
            requestedAction: options?.requestedAction,
            session,
            text,
            displayText,
            metaOverrides,
            configuredMode: state.settings.sessionMessageSendMode,
            busySteerSendPolicy: state.settings.sessionBusySteerSendPolicy,
            sessionInactiveResumePolicy: state.settings.sessionInactiveResumePolicy,
            ...(options?.forceImmediate === true ? { explicitMode: 'server_pending' as const } : {}),
            forceImmediate: options?.forceImmediate === true,
            hostAdmissionOrigin: options?.hostAdmissionOrigin,
            onOutboundHandoff: options?.onOutboundHandoff,
            resumeCapabilityOptions,
            permissionOverride: getPermissionModeOverrideForSpawn(session),
            callerSurface: options?.callerSurface ?? 'sync_submit_message',
        });

        if (result.type === 'send_failed' || result.type === 'rejected' || result.type === 'wake_failed') {
            if (result.type === 'wake_failed') {
                log.log(`submitMessage wake failed for ${sessionId}: ${result.errorMessage ?? 'Failed to wake session'}`);
            }
            throw createSessionMessageSubmitFailureError(
                result.errorCode,
                result.errorMessage,
                'Failed to submit message',
            );
        }
        return result;
    }

    private async updateSessionMetadataWithRetry(
        sessionId: string,
        updater: SessionMetadataUpdateRequest<Metadata>,
        options?: Readonly<{
            serverId?: string | null;
            maxAttempts?: number;
            sessionExpectation?:
                SessionMetadataInactiveModelIntentExpectationV1;
            teamCredentialBinding?: SessionMetadataTeamCredentialBinding;
            mutationIntent?: 'rename_session';
            expectedMetadataRevision?: number;
            onMetadataCommitted?: (revision: number) => void;
            accountLifetime?: Pick<ServerAccountScopeLifetime, 'scope' | 'isCurrent'>;
            authority?: ServerAccountRequestAuthority;
            shouldContinue?: () => boolean;
        }>,
    ): Promise<void> {
        const exactAccountLifetime = options?.accountLifetime;
        const exactAuthority = options?.authority;
        const activeMetadataCurrentness = exactAuthority ? null : captureActiveServerAccountScopeCurrentness();
        // Tuple crypto escapes each fetch and belongs to the complete CAS
        // operation, including retries and post-read encryption/publication.
        let accountCurrentnessSource: ReturnType<typeof createOperationAccountCurrentnessSource> | undefined;
        const assertCurrent = (): void => {
            if (options?.shouldContinue?.() === false) {
                throw Object.assign(new Error('Session metadata publication was superseded'), {
                    code: 'session_metadata_publication_superseded',
                });
            }
            if (
                activeMetadataCurrentness?.isCurrent() === false
                || (
                    exactAccountLifetime
                    && (
                        !exactAccountLifetime.isCurrent()
                        || !exactAuthority
                        || !areServerAccountScopesEqual(exactAuthority.scope, exactAccountLifetime.scope)
                    )
                )
            ) {
                throw Object.assign(new Error('Session Account authority retired during metadata update'), {
                    code: 'session_account_scope_retired',
                });
            }
            // A retired Account scope is the more specific cause, so it is checked first.
            accountCurrentnessSource?.assertCurrent();
        };
        const isCurrent = (): boolean => {
            try {
                assertCurrent();
                return true;
            } catch {
                return false;
            }
        };
        try {
        assertCurrent();
        const resolvedServerIdOverride =
            typeof options?.serverId === 'string' && options.serverId.trim().length > 0
                ? options.serverId.trim()
                : null;
        // A metadata mutation owns its hydrated read even when UI detail
        // residency releases the projected row while the request is in flight.
        let mutationSession: Session | null = null;
        const exactSessionDataKeys = new Map<string, Uint8Array>();
        const exactSessionDataKeyEnvelopes = new Map<string, string>();
        const projectionServerId = exactAuthority?.scope.serverId ?? resolvedServerIdOverride
            ?? this.getAppliedTransportTarget()?.serverId;
        const incumbent = storage.getState().sessions[sessionId];
        // Reuse admitted provenance, never the visible tuple as a raw CAS baseline.
        const ownerMetadataProjectionBaseline = incumbent?.serverId && projectionServerId
            && areServerProfileIdentifiersEquivalent(incumbent.serverId, projectionServerId)
            ? incumbent[SESSION_OWNER_METADATA_PROJECTION] : undefined;

        const fetchLatestSession = async (
            includeMetadataTupleMutationSnapshot = false,
        ) => {
            assertCurrent();
            if (exactAuthority) {
                const credentials = exactAuthority.context.credentials;
                if (!credentials) throw new Error('Session metadata update requires exact Account credentials');
                accountCurrentnessSource ??= createOperationAccountCurrentnessSource({
                    credentials, request: exactAuthority.request, serverId: exactAuthority.scope.serverId,
                });
                const result = await fetchSessionByIdWithServerScope({
                    authority: exactAuthority,
                    sessionId,
                    serverId: exactAuthority.scope.serverId,
                    activeCredentials: credentials,
                    activeEncryption: exactAuthority.context.encryption,
                    sessionDataKeys: exactSessionDataKeys,
                    sessionDataKeyEnvelopes: exactSessionDataKeyEnvelopes,
                    activeRequest: exactAuthority.request,
                    applySessions: (sessions) => {
                        assertCurrent();
                        const session = sessions.find((candidate) => candidate.id === sessionId);
                        if (session) {
                            mutationSession = {
                                ...session,
                                serverId: exactAuthority.scope.serverId,
                            };
                        }
                    },
                    getExistingSession: () => mutationSession,
                    ownerMetadataProjectionBaseline,
                    log,
                    includeTurnsProjection: false,
                    includeMetadataTupleMutationSnapshot,
                    accountCurrentnessSource,
                    isCurrent,
                });
                assertCurrent();
                return result;
            }
            if (!this.credentials) {
                throw new Error('Sync credentials not available');
            }
            accountCurrentnessSource ??= createOperationAccountCurrentnessSource({
                credentials: this.credentials,
                request: this.requestViaConfiguredSocket,
                serverId: resolvedServerIdOverride ?? this.getAppliedTransportTarget()?.serverId,
            });
            return await fetchSessionByIdWithServerScope({
                sessionId,
                serverId: resolvedServerIdOverride ?? resolvePreferredServerIdForSessionId(sessionId),
                activeCredentials: this.credentials,
                activeEncryption: this.encryption,
                sessionDataKeys: this.sessionDataKeys,
                sessionDataKeyEnvelopes: this.sessionDataKeyEnvelopes,
                activeRequest: this.requestViaConfiguredSocket,
                activeReadTransport: this.createAppliedReadTransport(),
                applySessions: (sessions) => {
                    assertCurrent();
                    const session = sessions.find((candidate) => candidate.id === sessionId);
                    if (session) mutationSession = session;
                    this.applySessions(sessions);
                },
                // A socket may advance the visible tuple while this read is
                // decrypting. Retain the operation's raw CAS baseline, just as
                // the exact-Account path does; store admission still owns
                // projection ordering and the tuple writer owns CAS conflicts.
                getExistingSession: () => mutationSession,
                ownerMetadataProjectionBaseline,
                log,
                includeTurnsProjection: false,
                includeMetadataTupleMutationSnapshot,
                accountCurrentnessSource,
                isCurrent,
            });
        };

        const resolvePatchContext = () => {
            assertCurrent();
            const session = exactAuthority
                ? mutationSession
                : storage.getState().sessions[sessionId] ?? mutationSession;
            const sessionEncryptionMode: 'e2ee' | 'plain' = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
            const encryption = !session || sessionEncryptionMode === 'plain'
                ? null
                : exactAuthority
                    ? exactAuthority.context.encryption?.getSessionEncryption(sessionId) ?? null
                    : this.encryption?.getSessionEncryption(sessionId);
            return { session, sessionEncryptionMode, encryption };
        };

        let prefetchedTupleRead: Awaited<
            ReturnType<typeof fetchSessionByIdWithServerScope>
        > | undefined;
        let patchContext = resolvePatchContext();
        if (exactAuthority || !patchContext.session?.metadata || (patchContext.sessionEncryptionMode === 'e2ee' && !patchContext.encryption)) {
            prefetchedTupleRead = await fetchLatestSession(true);
            patchContext = resolvePatchContext();
        }

        if (!patchContext.session) {
            throw new Error(`Session ${sessionId} not found`);
        }
        if (patchContext.sessionEncryptionMode === 'e2ee' && !patchContext.encryption) {
            throw createSessionEncryptionUnavailableError(sessionId);
        }

        const tupleWriterContextRef: {
            current: Awaited<
            ReturnType<typeof fetchSessionByIdWithServerScope>
            >['metadataTupleWriterContext'];
        } = { current: undefined };
        const requireTupleWriterContext = () => {
            assertCurrent();
            if (!tupleWriterContextRef.current) {
                throw new Error(`Session metadata writer context not found for ${sessionId}`);
            }
            return tupleWriterContextRef.current;
        };
        const acquireTupleSnapshot = async () => {
            assertCurrent();
            const result = prefetchedTupleRead
                ?? await fetchLatestSession(true);
            assertCurrent();
            prefetchedTupleRead = undefined;
            patchContext = resolvePatchContext();
            if (
                !result.ok
                || !result.metadataTupleMutationSnapshot
                || !result.metadataTupleWriterContext
            ) {
                throw Object.assign(
                    new Error(
                        `Session metadata tuple is unavailable for ${sessionId}`,
                    ),
                    {
                        code: 'metadata_privacy_upgrade_required' as const,
                    },
                );
            }
            tupleWriterContextRef.current =
                result.metadataTupleWriterContext;
            return result.metadataTupleMutationSnapshot;
        };

        const readPatchSession = (): Session | null => {
            assertCurrent();
            return exactAuthority ? mutationSession : storage.getState().sessions[sessionId] ?? mutationSession;
        };
        const ownsActiveProjection = (): boolean => Boolean(
            exactAccountLifetime
            && exactAuthority
            && isCurrent()
            && exactAccountLifetime.isCurrent()
            && areServerAccountScopesEqual(getActiveServerAccountScope(), exactAccountLifetime.scope)
            && (() => {
                const projected = storage.getState().sessions[sessionId];
                return Boolean(projected && (!projected.serverId || areServerProfileIdentifiersEquivalent(
                    projected.serverId,
                    exactAuthority.scope.serverId,
                )));
            })()
        );

        try {
        await updateSessionMetadataWithRetryRpc<Metadata, AgentState>({
            sessionId,
            metadataLayoutVersion:
                readSessionMetadataLayoutVersion(
                    patchContext.session?.metadataLayoutVersion,
                ),
            getSession: () => {
                const s = readPatchSession();
                if (!s?.metadata) return null;
                const metadataLayoutVersion =
                    readSessionMetadataLayoutVersion(s.metadataLayoutVersion);
                const metadata = metadataLayoutVersion === 1
                    ? s.ownerMetadataView ?? s.metadata
                    : s.metadata;
                return {
                    metadataLayoutVersion,
                    metadataVersion: s.metadataVersion,
                    metadata,
                };
            },
            refreshSessions: async () => {
                assertCurrent();
                await fetchLatestSession();
                assertCurrent();
                patchContext = resolvePatchContext();
            },
            encryptMetadata: async (metadata) => {
                assertCurrent();
                if (patchContext.sessionEncryptionMode === 'plain') {
                    return JSON.stringify(projectSessionMetadataForWire(metadata));
                }
                if (!patchContext.encryption?.encryptMetadata) {
                    throw createSessionEncryptionUnavailableError(sessionId);
                }
                const encrypted = await patchContext.encryption.encryptMetadata(
                    metadata,
                );
                assertCurrent();
                return encrypted;
            },
            decryptMetadata: async (version, encrypted) => {
                assertCurrent();
                if (patchContext.sessionEncryptionMode !== 'plain') {
                    if (!patchContext.encryption?.decryptMetadata) {
                        throw createSessionEncryptionUnavailableError(sessionId);
                    }
                    const metadata = await patchContext.encryption.decryptMetadata(
                        version,
                        encrypted,
                    );
                    assertCurrent();
                    const parsed = MetadataSchema.safeParse(metadata);
                    return parsed.success ? parsed.data : null;
                }
                try {
                    const parsed = MetadataSchema.safeParse(
                        JSON.parse(encrypted),
                    );
                    return parsed.success ? parsed.data : null;
                } catch {
                    return null;
                }
            },
            emitUpdateMetadata: async (payload) => {
                assertCurrent();
                const scope = resolvedServerIdOverride
                    ? { serverId: resolvedServerIdOverride }
                    : {};
                const result = 'sid' in payload
                    ? await emitSessionMetadataUpdateWithServerScope({
                        sessionId,
                        expectedVersion: payload.expectedVersion,
                        metadata: payload.metadata,
                        ...(payload.sessionExpectation
                            ? {
                                sessionExpectation:
                                    payload.sessionExpectation,
                            }
                            : {}),
                        ...scope,
                        ...(exactAuthority ? { authority: exactAuthority } : {}),
                        isCurrent,
                    })
                    : await emitSessionMetadataUpdateWithServerScope({
                        sessionId,
                        patch: payload,
                        ...scope,
                        ...(exactAuthority ? { authority: exactAuthority } : {}),
                        isCurrent,
                    });
                // HTTP tuple/conditioned writers normalize a strict matched
                // success receipt before retirement. Preserve that fact; raw
                // legacy socket ACKs retain their existing fence.
                if (result.result !== 'success' || ('sid' in payload && !payload.sessionExpectation)) assertCurrent();
                return result;
            },
            applySessionMetadata: ({ metadataVersion, metadata }) => {
                assertCurrent();
                const currentSession = readPatchSession();
                if (!currentSession) {
                    return;
                }
                const nextSession = {
                    ...currentSession,
                    metadata,
                    composerOptionsInput: projectComposerOptionsInputV1(metadata),
                    metadataVersion,
                    metadataLayoutVersion: 0,
                };
                const admission = currentSession[SESSION_LIST_DOCUMENT_ADMISSION];
                if (admission) nextSession[SESSION_LIST_DOCUMENT_ADMISSION] = admitOpenedSessionListDisplayMetadata(
                    { ...admission, metadataLayoutVersion: 0 }, nextSession);
                mutationSession = nextSession;
                if (!exactAuthority || ownsActiveProjection()) this.applySessions([nextSession], 'projection');
            },
            acquireTupleSnapshot,
            tupleCrypto: {
                encryptPayload: async (payload) => {
                    const encrypted = await requireTupleWriterContext().encryptPayload(payload);
                    assertCurrent();
                    return encrypted;
                },
                encodeOwnerMetadata: (ownerMetadata) => {
                    const encoded = requireTupleWriterContext().encodeOwnerMetadata(ownerMetadata);
                    assertCurrent();
                    return encoded;
                },
                encodeSharedDisplay: async (display) => {
                    const encoded = await requireTupleWriterContext().encodeSharedDisplay(display);
                    assertCurrent();
                    return encoded;
                },
                encodeOwnerDisplay: (display) => {
                    const encoded = requireTupleWriterContext().encodeOwnerDisplay(display);
                    assertCurrent();
                    return encoded;
                },
            },
            getOwnerMigrationCurrentness: () =>
                tupleWriterContextRef.current
                    ?.ownerMigrationCurrentness,
            applyTupleSnapshot: (next) => {
                // The canonical tuple owner has already reported a known
                // commit. Retired views must not adopt its private projection.
                if (!isCurrent()) return;
                const currentSession = readPatchSession();
                if (!currentSession) {
                    return;
                }
                const credentials = exactAuthority?.context.credentials ?? this.credentials;
                const accountCurrentness = accountCurrentnessSource?.peek();
                // Publish the committed envelope and view as one admitted owner
                // projection, so hydration does not manufacture new provenance.
                const ownerProjection = next.mode === 'owner' && credentials
                    ? projectSessionLayout1OwnerMetadata({
                        sharedMetadata: next.value.sharedMetadata,
                        metadataVersion: next.metadataVersion,
                        ownerMetadataRead: readSessionLayout1OwnerMetadata({
                            access: currentSession.access ?? null,
                            accountMode: accountCurrentness?.mode,
                            accountCurrentness,
                            credentials,
                            ownerMetadataEnvelope: next.ownerMetadataEnvelope,
                            previousProjection: currentSession[SESSION_OWNER_METADATA_PROJECTION],
                        }),
                    }) : null;
                const {
                    ownerMetadata: _obsoleteOwnerMetadata,
                    ...ordinarySession
                } = currentSession as Session & {
                    ownerMetadata?: unknown;
                };
                const committedSession = {
                    ...ordinarySession,
                    metadata:
                        next.value.sharedMetadata as unknown as Metadata,
                    metadataVersion: next.metadataVersion,
                    metadataLayoutVersion: 1,
                    ...(next.mode === 'owner'
                        ? {
                            ...(ownerProjection?.kind === 'owner' ? {
                                [SESSION_OWNER_METADATA_PROJECTION]: ownerProjection,
                                ownerMetadataView: ownerProjection.ownerMetadataView,
                                composerOptionsInput: ownerProjection.composerOptionsInput,
                            } : {}),
                            agentState: next.value.agentState,
                            agentStateVersion: next.agentStateVersion,
                        }
                        : {}),
                } as Session;
                const admission = ordinarySession[SESSION_LIST_DOCUMENT_ADMISSION];
                if (admission) {
                    const committedAdmission = admitOpenedSessionListDisplayMetadata(
                        { ...admission, metadataLayoutVersion: 1 }, committedSession);
                    committedSession[SESSION_LIST_DOCUMENT_ADMISSION] = next.mode === 'owner'
                        ? admitOpenedSessionListAgentState(committedAdmission, next.agentStateVersion)
                        : committedAdmission;
                }
                const nextSession = next.mode === 'owner' && ownerProjection?.kind !== 'owner'
                    ? buildSessionOwnerMetadataUnavailableShell(committedSession) : committedSession;
                mutationSession = nextSession;
                if (!exactAuthority || ownsActiveProjection()) this.applySessions([nextSession], 'projection');
            },
            updater,
            sessionExpectation: options?.sessionExpectation,
            teamCredentialBinding: options?.teamCredentialBinding,
            mutationIntent: options?.mutationIntent,
            expectedMetadataRevision: options?.expectedMetadataRevision,
            onMetadataCommitted: options?.onMetadataCommitted,
            maxAttempts: typeof options?.maxAttempts === 'number' ? options.maxAttempts : 8,
        });
        } catch (error) {
            // A refused CAS can still have read the winner's canonical tuple.
            // Publish that read to its current mounted Home before its control settles.
            if (mutationSession && ownsActiveProjection()) this.applySessions([mutationSession], 'projection');
            throw error;
        }
        } finally {
            accountCurrentnessSource?.dispose();
        }
    }

    public applySessionMetadataLocally(
        sessionId: string,
        updater: (metadata: Metadata) => Metadata,
    ): void {
        const latestSession = storage.getState().sessions[sessionId] ?? null;
        if (!latestSession) return;
        const ownerMetadata = readSessionOwnerMetadataView(latestSession);
        if (!ownerMetadata) return;
        const nextMetadata = updater(ownerMetadata);
        if (nextMetadata === ownerMetadata) return;
        const metadataLayoutVersion =
            readSessionMetadataLayoutVersion(latestSession.metadataLayoutVersion);
        if (metadataLayoutVersion !== 0 && metadataLayoutVersion !== 1) return;
        this.applySessions([{
            ...latestSession,
            composerOptionsInput: projectComposerOptionsInputV1(nextMetadata),
            ...(metadataLayoutVersion === 1
                ? { ownerMetadataView: nextMetadata }
                : { metadata: nextMetadata }),
        }], 'projection');
    }

    private readSessionAtAddress(address: SessionAddress): Session | SessionListRenderableSession | null {
        const state = storage.getState();
        if (this.isAppliedTransportServer(address.serverId)) {
            const session = state.sessions[address.sessionId];
            if (session && (!session.serverId || areServerProfileIdentifiersEquivalent(session.serverId, address.serverId))) {
                return session;
            }
        }
        return state.sessionListRowsByServerId[address.serverId]?.[address.sessionId] ?? null;
    }

    private applyLocalReadCursor(address: SessionAddress, lastViewedSessionSeq: number): void {
        const state = storage.getState();
        const session = this.readSessionAtAddress(address);
        if (!session) return;

        const nextViewedSeq = Math.max(0, Math.trunc(lastViewedSessionSeq));
        const existingViewedSeq =
            typeof session.lastViewedSessionSeq === 'number' && Number.isFinite(session.lastViewedSessionSeq)
                ? Math.max(0, Math.trunc(session.lastViewedSessionSeq))
                : 0;
        const effectiveViewedSeq = Math.max(existingViewedSeq, nextViewedSeq);
        if (session.lastViewedSessionSeq === effectiveViewedSeq) return;

        if (this.isAppliedTransportServer(address.serverId) && state.sessions[address.sessionId] === session) {
            state.applySessions([{ ...(session as Session), lastViewedSessionSeq: effectiveViewedSeq }], 'projection');
            return;
        }
        state.applyServerScopedSessionListRowPatches(address.serverId, [{
            sessionId: address.sessionId,
            patch: { lastViewedSessionSeq: effectiveViewedSeq },
        }]);
    }

    async markSessionViewed(addressInput: SessionAddress, opts?: { sessionSeq?: number; pendingActivityAt?: number }): Promise<void> {
        const address = normalizeSessionAddress(addressInput.serverId, addressInput.sessionId);
        if (!address) return;
        const { serverId, sessionId } = address;
        const session = this.readSessionAtAddress(address);
        if (!session || !isSessionPersonallyTrackedForViewer(session)) return;
        const usedActiveSession = this.isAppliedTransportServer(serverId);
        const activeCredentials = this.credentials;

        const sessionSeq = Math.max(0, Math.trunc(opts?.sessionSeq ?? session.seq ?? 0));
        const existingAuthoritativeSeq = session.viewer?.readState.state === 'tracking'
            ? session.viewer.readState.lastViewedSessionSeq
            : typeof session.lastViewedSessionSeq === 'number' && Number.isFinite(session.lastViewedSessionSeq)
                ? Math.max(0, Math.trunc(session.lastViewedSessionSeq))
                : 0;
        const nextAuthoritativeSeq = Math.max(existingAuthoritativeSeq, sessionSeq);
        if (nextAuthoritativeSeq > existingAuthoritativeSeq) {
            // Pre-viewer Homes retain their released optimistic scalar behavior.
            // Current Homes return the canonical private attention with the ACK.
            if (!session.viewer) this.applyLocalReadCursor(address, nextAuthoritativeSeq);
            try {
                const result = await emitSessionReadCursorUpdateWithServerScope(address, nextAuthoritativeSeq);
                if (usedActiveSession && this.credentials !== activeCredentials) return;
                const current = this.readSessionAtAddress(address);
                if (!current || !isSessionPersonallyTrackedForViewer(current)) return;
                const viewer = SessionViewerProjectionV1Schema.safeParse(result.viewer);
                if (viewer.success) {
                    this.invalidateSessionListSnapshot(serverId);
                    const next = {
                        ...current,
                        viewer: viewer.data,
                        lastViewedSessionSeq: viewer.data.readState.state === 'tracking'
                            ? viewer.data.readState.lastViewedSessionSeq
                            : current.seq,
                    };
                    const state = storage.getState();
                    if (this.isAppliedTransportServer(serverId) && state.sessions[sessionId] === current) {
                        state.applySessions([next as Session], 'projection');
                    } else {
                        state.applyServerScopedSessionListRowPatches(serverId, [{
                            sessionId,
                            patch: {
                                viewer: viewer.data,
                                lastViewedSessionSeq: next.lastViewedSessionSeq,
                            },
                        }]);
                    }
                } else if (result.result === 'success' && !current.viewer) {
                    const acknowledgedSeq = typeof result.lastViewedSessionSeq === 'number' && Number.isFinite(result.lastViewedSessionSeq)
                        ? Math.max(0, Math.trunc(result.lastViewedSessionSeq))
                        : nextAuthoritativeSeq;
                    this.applyLocalReadCursor(address, acknowledgedSeq);
                } else {
                    this.sessionsSync.invalidate();
                }
            } catch {
                // A failed observation publish is retried by subsequent viewing/sync.
            }
        }

        if (!this.isAppliedTransportServer(serverId)) return;
        const current = storage.getState().sessions[sessionId];
        if (!current || !isSessionPersonallyTrackedForViewer(current)) return;
        const ownerMetadata = readSessionOwnerMetadataView(current);
        if (!ownerMetadata || !readExternalSessionLink(ownerMetadata)) return;
        if (updateMetadataWithViewedExternalSessionProgress(ownerMetadata) === ownerMetadata) return;
        await this.updateSessionMetadataWithRetry(sessionId, (metadata) => (
            readExternalSessionLink(metadata) ? updateMetadataWithViewedExternalSessionProgress(metadata) : metadata
        ));
    }

    private publishExternalSessionObservedProgress(
        sessionId: string,
        items: ReadonlyArray<ExternalSessionTranscriptRawMessageV1>,
    ): void {
        const session = storage.getState().sessions[sessionId] ?? null;
        const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
        if (!ownerMetadata || !readExternalSessionLink(ownerMetadata)) return;

        const progress = deriveExternalSessionObservedProgress(items);
        if (!progress) return;

        this.applySessionMetadataLocally(
            sessionId,
            (metadata) => updateMetadataWithObservedExternalSessionProgress(metadata, progress),
        );
    }

    private async applyExternalSessionTranscriptItems(
        sessionId: string,
        items: ReadonlyArray<ExternalSessionTranscriptRawMessageV1>,
        options?: Readonly<{
            nextCursor?: string | null;
            expectedAuthorityKey?: string;
        }>,
    ): Promise<boolean> {
        if (this.externalSessionTailStateBySessionId.get(sessionId)?.recoveryRequired) return false;
        const session = storage.getState().sessions[sessionId] ?? null;
        const externalSessionLink = readExternalSessionLink(
            session ? readSessionOwnerMetadataView(session) : null,
        );
        if (!externalSessionLink) return false;
        if (
            options?.expectedAuthorityKey !== undefined
            && (
                this.isExternalSessionTranscriptAuthorityFenced(
                    sessionId,
                    options.expectedAuthorityKey,
                )
                || externalSessionTranscriptAuthorityKey(
                    this.resolveTranscriptAuthority(session, externalSessionLink),
                ) !== options.expectedAuthorityKey
            )
        ) {
            return false;
        }

        const normalizedMessages = normalizeExternalSessionTranscriptMessages(items, {
            agentId: externalSessionLink.agentId,
            remoteSessionId: externalSessionLink.remoteSessionId,
        });
        if (normalizedMessages.length > 0) {
            this.applyMessages(sessionId, normalizedMessages, {
                notifyVoice: false,
                notifyActivity: true,
            });
        }

        if (options && Object.prototype.hasOwnProperty.call(options, 'nextCursor')) {
            this.setExternalSessionTailCursor(sessionId, options.nextCursor ?? null);
        }

        this.recordExternalSessionSourcePage(sessionId, items, externalSessionLink);
        this.publishExternalSessionObservedProgress(sessionId, items);
        return true;
    }

    /**
     * Commit a source read only after its complete staged window has passed
     * currentness/truncation adjudication. A single store application keeps a
     * relink during staged replacement at either the prior accepted transcript
     * or the complete replacement; it cannot expose an intermediate page.
     */
    private applyExternalSessionTranscriptPages(
        sessionId: string,
        pages: ReadonlyArray<Readonly<{
            items: ReadonlyArray<ExternalSessionTranscriptRawMessageV1>;
            nextCursor: string | null;
        }>>,
        expectedAuthorityKey: string,
        options?: Readonly<{ replaceExisting?: boolean }>,
    ): Readonly<{ changedMessageIds: readonly string[]; sourceMessageIds: readonly string[] }> | null {
        if (options?.replaceExisting !== true
            && this.externalSessionTailStateBySessionId.get(sessionId)?.recoveryRequired) return null;
        const session = storage.getState().sessions[sessionId] ?? null;
        const externalSessionLink = readExternalSessionLink(
            session ? readSessionOwnerMetadataView(session) : null,
        );
        if (!session || !externalSessionLink) return null;
        if (
            this.isExternalSessionTranscriptAuthorityFenced(sessionId, expectedAuthorityKey) ||
            externalSessionTranscriptAuthorityKey(
                this.resolveTranscriptAuthority(session, externalSessionLink),
            ) !== expectedAuthorityKey
        ) {
            return null;
        }

        const items = pages.flatMap((page) => page.items);
        const normalizedMessages = normalizeExternalSessionTranscriptMessages(items, {
            agentId: externalSessionLink.agentId,
            remoteSessionId: externalSessionLink.remoteSessionId,
        });
        let changedMessageIds: readonly string[] = [];
        if (normalizedMessages.length > 0 || options?.replaceExisting === true) {
            changedMessageIds = this.applyMessages(sessionId, normalizedMessages, {
                notifyVoice: false,
                notifyActivity: true,
                activitySource: 'reconciliation',
                replaceExisting: options?.replaceExisting === true,
            }).changed;
        }
        if (pages.length > 0) {
            this.setExternalSessionTailCursor(
                sessionId,
                pages[pages.length - 1]?.nextCursor ?? null,
            );
        }
        const sourceMessageIds = this.recordExternalSessionSourcePage(sessionId, items, externalSessionLink);
        const materializedMessageIds = this.readExternalSessionPageMaterializedIds(sessionId, normalizedMessages, changedMessageIds);
        this.publishExternalSessionObservedProgress(sessionId, items);
        return { changedMessageIds: materializedMessageIds, sourceMessageIds };
    }

    async publishSessionPermissionModeToMetadata(params: {
        sessionId: string;
        permissionMode: PermissionMode;
        permissionModeUpdatedAt: number;
        serverId?: string | null;
        accountLifetime?: ServerAccountScopeLifetime;
        shouldPublishPermissionIntent?: () => boolean;
    }): Promise<void> {
        await publishPermissionModeToMetadataEngine({
            sessionId: params.sessionId,
            permissionMode: params.permissionMode,
            permissionModeUpdatedAt: params.permissionModeUpdatedAt,
            updateSessionMetadataWithRetry: (sessionId, updater) => this.patchSessionMetadataWithRetry(sessionId, updater, {
                ...(params.serverId ? { serverId: params.serverId } : {}),
                ...(params.accountLifetime ? { accountLifetime: params.accountLifetime } : {}),
                ...(params.shouldPublishPermissionIntent ? { shouldContinue: params.shouldPublishPermissionIntent } : {}),
            }),
        });
    }

    async publishSessionAcpSessionModeOverrideToMetadata(params: {
        sessionId: string;
        modeId: string;
        updatedAt: number;
    }): Promise<void> {
        await publishAcpSessionModeOverrideToMetadataEngine({
            sessionId: params.sessionId,
            modeId: params.modeId,
            updatedAt: params.updatedAt,
            updateSessionMetadataWithRetry: (sessionId, updater) => this.updateSessionMetadataWithRetry(sessionId, updater),
        });
    }

    async publishSessionAcpConfigOptionOverrideToMetadata(params: {
        sessionId: string;
        configId: string;
        value: AcpConfigOptionOverrideValueId;
        updatedAt: number;
        serverId?: string | null;
        accountLifetime?: ServerAccountScopeLifetime;
    }): Promise<void> {
        await publishAcpConfigOptionOverrideToMetadataEngine({
            sessionId: params.sessionId,
            configId: params.configId,
            value: params.value,
            updatedAt: params.updatedAt,
            updateSessionMetadataWithRetry: (sessionId, updater) => this.patchSessionMetadataWithRetry(sessionId, updater, {
                ...(params.serverId ? { serverId: params.serverId } : {}),
                ...(params.accountLifetime ? { accountLifetime: params.accountLifetime } : {}),
            }),
        });
    }

    async fetchPendingMessages(
        sessionId: string,
        expectedOutboxScope?: ServerAccountScope,
        recipient?: PendingMessage['recipient'],
        options?: Readonly<{ invalidateSnapshot: boolean }>,
    ): Promise<void> {
        if (isDemoModeActive()) return;
        if (
            expectedOutboxScope
            && !areServerAccountScopesEqual(this.embedSessionScope ? this.getAppliedTransportAccountScope() : getActiveServerAccountScope(), expectedOutboxScope)
        ) {
            return;
        }
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent, serverWireMode, encryption }) => {
        if (
            expectedOutboxScope
            && !areServerAccountScopesEqual(outboxScope, expectedOutboxScope)
        ) {
            return;
        }
        for (const localId of await replayPersistedPendingOutboxForSession(sessionId, outboxScope)) {
            if (shouldSchedulePendingOutboxTransportRetry(serverWireMode)) {
                this.schedulePendingOutboxOperationRetry({ sessionId, localId, outboxScope });
            }
        }
        await fetchAndApplyPendingMessagesV2({
            sessionId,
            recipient,
            invalidateSnapshot: options?.invalidateSnapshot,
            encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
        }, expectedOutboxScope);
    }

    private rearmPendingOutboxForActiveScope = (): Promise<void> => {
        const outboxScope = getActiveServerAccountScope();
        if (!outboxScope) {
            return Promise.resolve();
        }
        const scopeKey = serverAccountScopeKeySuffix(outboxScope);
        return runWithInFlightDedupe(
            {
                get: () => this.pendingOutboxRearmInFlightByScope.get(scopeKey) ?? null,
                set: (value) => {
                    if (value) {
                        this.pendingOutboxRearmInFlightByScope.set(scopeKey, value);
                    } else {
                        this.pendingOutboxRearmInFlightByScope.delete(scopeKey);
                    }
                },
            },
            async () => {
                const sessionIds = await listPendingOutboxSessionIds(outboxScope);
                await runTasksWithLimit(
                    sessionIds.map((sessionId) => async () => {
                        if (!areServerAccountScopesEqual(getActiveServerAccountScope(), outboxScope)) {
                            return;
                        }
                        try {
                            await this.fetchPendingMessages(sessionId, outboxScope);
                        } catch {
                            // The durable row remains authoritative and the next lifecycle edge retries it.
                        }
                    }),
                    this.syncTuning.resumeConcurrencyLimit,
                );
            },
        );
    };

    private async assertPendingResetStartAdmission(reset: PendingResetStartBindingV1, scope: ServerAccountScope,
        wireMode: PendingInputServerWireMode, isCurrent: () => boolean | Promise<boolean>, signal?: AbortSignal): Promise<void> {
        if (wireMode !== 'pending_input_v4' && wireMode !== 'pending_input_v5') throw Object.assign(new Error('Reset start requires a current Home'), { code: 'reset_start_unsupported' });
        const [{ captureLazyActionAccountContext }, { getProviderAccountUsageQuota, getProviderAccountUsageHistoryWitness },
            { evaluatePendingResetStartAdmissionV1 }] = await Promise.all([
            import('@/sync/ops/actions/actionAccountContext'), import('@/sync/api/account/apiProviderAccountUsage'),
            import('@happier-dev/protocol/sessions/pending/pendingResetStartReadinessV1'),
        ]);
        const account = await captureLazyActionAccountContext(scope.serverId, signal);
        try {
            if (account.accountId !== scope.accountId || !await isCurrent()) throw new Error('Pending owner server-account scope changed');
            const assertCurrent = () => account.assertCurrent();
            const options = { accountMode: await account.resolveAccountMode(), request: account.request, assertCurrent,
                includePendingWork: false, ...(signal ? { signal } : {}) };
            const read = await getProviderAccountUsageQuota(account.credentials, { source: reset.source }, options);
            const witness = await getProviderAccountUsageHistoryWitness(account.credentials, { recordId: reset.recordId, witness: reset.witness }, options);
            account.assertCurrent();
            const admission = evaluatePendingResetStartAdmissionV1({ reset, witness, current: read.current,
                nowMs: Date.now(), authorityCurrent: await isCurrent() });
            if (admission.status !== 'available') throw Object.assign(new Error('Reset start is unavailable'),
                { code: 'reset_start_unavailable', reason: admission.reason });
        } finally { account.dispose(); }
    }

    /** Seal the composer draft for the existing approval-gated reset Action; no Pending effects. */
    async preparePendingResetStartInput(sessionId: string, text: string, displayText?: string,
        metaOverrides?: Record<string, unknown>, options?: Readonly<PendingQueueOwnerOptions & {
            accountLifetime?: ServerAccountScopeLifetime;
            allowedModels?: readonly ProviderBoundModelRef[] | null;
            allowedPermissionModes?: readonly PermissionMode[] | null;
        }>):
        Promise<Readonly<{ localId: string; initialInput: NonNullable<PendingResetStartSetInputV1['initialInput']> }>> {
        return await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, encryption, serverWireMode, isCurrent }) => {
            if (serverWireMode !== 'pending_input_v4' && serverWireMode !== 'pending_input_v5') throw Object.assign(new Error('Reset start requires a current Home'), { code: 'reset_start_unsupported' });
            const session = readExactServerScopedSession(sessionId, outboxScope.serverId);
            if (!session || !await isCurrent()) throw new Error('Pending Session authority is unavailable');
            const { loadAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
            const rawRecord = buildOutgoingUserTextRecord({ text, displayText,
                permissionMode: session.permissionMode ?? 'default', modelMode: session.modelMode,
                agentId: readSessionPresentationAgentId(session), session, metaOverrides,
                allowedModels: options?.allowedModels, allowedPermissionModes: options?.allowedPermissionModes,
                settings: areServerAccountScopesEqual(storage.getState().settingsScope, outboxScope)
                    ? storage.getState().settings : settingsParse(loadAccountSettings(outboxScope).settings),
            });
            const localId = randomUUID();
            const sessionEncryption = session.encryptionMode === 'plain' ? null : await encryption?.getSessionEncryption(sessionId);
            if (session.encryptionMode !== 'plain' && !sessionEncryption) throw createSessionEncryptionUnavailableError(sessionId);
            const content = session.encryptionMode === 'plain' ? { t: 'plain' as const, v: rawRecord }
                : { t: 'encrypted' as const, c: await sessionEncryption!.encryptRawRecord(rawRecord) };
            if (!await isCurrent()) throw new Error('Pending owner server-account scope changed');
            const targetMachineId = readMachineControlTargetForSession({ sessionId, ...outboxScope })?.machineId;
            const initialInput = PendingResetStartSetInputV1Schema.shape.initialInput.parse({ content,
                ...(targetMachineId ? { targetMachineId } : {}) });
            if (!initialInput) throw new Error('Pending initial input is unavailable');
            return { localId, initialInput };
        }, undefined, options?.serverId, options?.accountLifetime);
    }

    async enqueuePendingResetStartInput(input: PendingResetStartSetInputV1,
        accountLifetime: ServerAccountScopeLifetime, signal?: AbortSignal): Promise<PendingResetStartSetResultV1> {
        if (!input.initialInput) throw new Error('Reset start initial input is required');
        const requestedAction = { v: 1 as const, kind: 'reset_start' as const, reset: input.reset };
        const result = await this.enqueuePendingMessage(input.sessionId, '', undefined, undefined, {
            localId: input.localId, serverId: input.serverId, accountLifetime, requestedAction, signal,
            initialContent: input.initialInput.content, targetMachineId: input.initialInput.targetMachineId,
        });
        // Durable offline reset custody is retained by the same outbox. It is not
        // an acknowledged server write and must not be reported as applied.
        if (!result.accepted || result.cancelled || typeof result.didWrite !== 'boolean') {
            throw Object.assign(new Error('Reset start has not been admitted by the Home'), { code: 'reset_start_unconfirmed' });
        }
        return { didUpdate: result.didWrite, requestedAction };
    }

    async enqueuePendingMessage(
        sessionId: string,
        text: string,
        displayText?: string,
        metaOverrides?: Record<string, unknown>,
        options?: Readonly<{
            localId?: string | null;
            serverId?: string | null;
            recipient?: ParticipantRecipientV1;
            deliveryMode?: 'external_handoff';
            hostAdmissionOrigin?: SessionMessageHostAdmissionOrigin;
            onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void;
            requestedAction?: PendingRequestedActionV1;
            initialContent?: NonNullable<PendingResetStartSetInputV1['initialInput']>['content'];
            targetMachineId?: string;
            signal?: AbortSignal;
            accountLifetime?: ServerAccountScopeLifetime;
            resumeWhenAvailable?: true;
            /** The models this sender may run; the message runs on the first allowed one when needed. */
            allowedModels?: readonly ProviderBoundModelRef[] | null;
            allowedPermissionModes?: readonly PermissionMode[] | null;
        }>,
    ): Promise<Readonly<{
        localId: string;
        accepted: boolean;
        didWrite?: boolean;
        cancelled?: true;
        terminal?: true;
        externalHandoffClaimed?: true;
    }>> {
        return await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent, serverWireMode, encryption }) => {
        if (!await isCurrent()) throw new Error('Pending owner server-account scope changed');
        if (options?.requestedAction?.kind === 'reset_start') await this.assertPendingResetStartAdmission(options.requestedAction.reset, outboxScope, serverWireMode, isCurrent, options.signal);
        throwIfAborted(options?.signal);
        if (options?.localId != null && readPendingLocalId(options.localId) === null) {
            throw new Error('Pending localId must not be blank');
        }
        const durableLocalId = readPendingLocalId(options?.localId) ?? undefined;
        const targetRecipient = options?.recipient?.kind === 'execution_run' ? options.recipient : undefined;
        if (!targetRecipient) this.markSessionLiveTailIntent(sessionId);
        // The unqualified enqueue serves the exact Home its owner context resolved,
        // not only the mounted active one: hand the pending owner the Session facts
        // for that Home when the local row already carries them, so a non-active
        // owner Home is served instead of failing with `Session … not found`.
        const exactHomeSession = readExactServerScopedSession(sessionId, outboxScope.serverId);
        const result = await enqueuePendingMessageV2({
            sessionId,
            ...(exactHomeSession ? { session: exactHomeSession } : {}),
            recipient: options?.recipient,
            targetMachineId: options?.targetMachineId ?? (targetRecipient ? readMachineControlTargetForSession({ sessionId, ...outboxScope })?.machineId : undefined),
            text,
            displayText,
            localId: durableLocalId,
            deliveryMode: options?.deliveryMode,
            metaOverrides,
            hostAdmissionOrigin: options?.hostAdmissionOrigin,
            allowedModels: options?.allowedModels,
            allowedPermissionModes: options?.allowedPermissionModes,
            encryption,
            fetchArtifactWithBody: (artifactId) => this.fetchArtifactWithBody(artifactId),
            updateArtifact: (artifact) => storage.getState().updateArtifact(artifact),
            request: options?.signal ? (path, init) => request(path, { ...init, signal: options.signal }) : request,
            outboxScope,
            serverWireMode,
            accountLifetime: options?.accountLifetime,
            signal: options?.signal,
            isCurrent: options?.signal ? async () => !options.signal!.aborted && await isCurrent() : isCurrent,
            requestedAction: options?.requestedAction ?? { v: 1, kind: 'enqueue' },
            ...(options?.initialContent ? { initialContent: options.initialContent } : {}),
            ...(options?.resumeWhenAvailable === true ? { resumeWhenAvailable: true as const } : {}),
            onLocalPendingProjectionCreated: options?.onLocalPendingProjectionCreated,
        });
        if (
            result.accepted === false
            && typeof result.localId === 'string'
            && result.localId.length > 0
            && shouldSchedulePendingOutboxTransportRetry(serverWireMode)
        ) {
            this.schedulePendingOutboxOperationRetry({ sessionId, localId: result.localId, outboxScope });
        }
        // No post-operation fence: the Home has already committed an accepted
        // enqueue, and a scope that retires while the request is in flight cannot
        // unsend it. `submitSessionUserMessage` owns the typed retirement result
        // for the caller; rethrowing here would report a generic `send_failed`
        // for a message the Home delivered.
        return result;
        }, undefined, options?.serverId, options?.accountLifetime);
    }

    /**
     * The only Account scope that may use Sync's direct socket. Profile scope
     * follows staged Home selection and can move before its transport applies,
     * so a staged scope is never enough to authorize the applied socket.
     */
    private getAppliedTransportAccountScope(): ServerAccountScope | null {
        if (this.embedSessionScope) return createServerAccountScope(this.embedSessionScope.endpointUrl, this.embedSessionScope.accountId);
        const target = this.appliedServerTarget;
        const scope = storage.getState().profileScope;
        if (
            !target
            || !scope
            || scope.accountId !== this.serverID
            || !areServerProfileIdentifiersEquivalent(scope.serverId, target.serverId)
        ) {
            return null;
        }
        return scope;
    }

    private isAppliedTransportAccountScopeCurrent(scope: ServerAccountScope): boolean {
        return areServerAccountScopesEqual(this.getAppliedTransportAccountScope(), scope);
    }

    private async resolvePendingQueueOwnerContext(
        sessionId: string,
        expectedActiveScope?: ServerAccountScope,
        expectedServerId?: string | null,
        expectedAccountLifetime?: ServerAccountScopeLifetime,
    ): Promise<Readonly<{
        outboxScope: ServerAccountScope;
        request: (path: string, init?: RequestInit) => Promise<Response>;
        isCurrent: () => boolean | Promise<boolean>;
        serverWireMode: PendingInputServerWireMode;
        encryption: PendingQueueOwnerEncryption | null;
        release: () => Promise<void>;
    }>> {
        type PendingQueueOwner = Readonly<{
            outboxScope: ServerAccountScope;
            request: (path: string, init?: RequestInit) => Promise<Response>;
            isCurrent: () => boolean | Promise<boolean>;
            encryption: PendingQueueOwnerEncryption | null;
            release: () => Promise<void>;
        }>;
        const withServerWireMode = async (
            owner: PendingQueueOwner,
        ): Promise<PendingQueueOwner & Readonly<{ serverWireMode: PendingInputServerWireMode }>> => {
            try {
                return {
                    ...owner,
                    request: createPendingQueueRequest({
                        request: owner.request,
                        writeTimeoutMs: readServerFetchWriteTimeoutMs(),
                    }),
                    serverWireMode: resolvePendingInputServerWireMode(
                        this.embedSessionScope ? this.embedFeaturesSnapshot : await getServerFeaturesSnapshot({ serverId: owner.outboxScope.serverId }),
                    ),
                };
            } catch (error) {
                await owner.release();
                throw error;
            }
        };
        const embedScope = this.embedSessionScope;
        if (embedScope) {
            if (sessionId !== embedScope.scope.sessionId || !embedScope.isCurrent()) throw new StaleServerGenerationError();
            const outboxScope = createServerAccountScope(embedScope.endpointUrl, embedScope.accountId);
            if (!outboxScope) throw new Error('Embed Session scope is unavailable');
            return await withServerWireMode({ outboxScope, request: embedScope.request,
                isCurrent: () => this.embedSessionScope === embedScope && embedScope.isCurrent(),
                encryption: this.encryption, release: async () => undefined });
        }
        if (isEmbedWindowContext()) throw new StaleServerGenerationError();
        if (expectedAccountLifetime) {
            if (!expectedAccountLifetime.isCurrent()) {
                throw new Error('Pending owner server-account scope changed');
            }
            const authority = await captureServerRequestAuthorityForServerAccountScope({
                scope: expectedAccountLifetime.scope,
                activeRequest: this.createSessionRequest(sessionId),
            });
            const isCurrent = () => expectedAccountLifetime.isCurrent()
                && areServerAccountScopesEqual(authority.scope, expectedAccountLifetime.scope);
            if (!isCurrent()) {
                await authority.release();
                throw new Error('Pending owner server-account scope changed');
            }
            return await withServerWireMode({
                outboxScope: expectedAccountLifetime.scope,
                request: async (path, init) => {
                    if (!isCurrent()) throw new Error('Pending owner server-account scope changed');
                    return await authority.request(path, init);
                },
                isCurrent,
                encryption: createScopedSessionEncryptionSource(authority.context),
                release: authority.release,
            });
        }
        if (expectedActiveScope) {
            const appliedScope = this.getAppliedTransportAccountScope();
            if (!areServerAccountScopesEqual(appliedScope, expectedActiveScope)) {
                const authority = await captureServerRequestAuthorityForServerAccountScope({
                    scope: expectedActiveScope,
                    activeRequest: this.createSessionRequest(sessionId),
                });
                const isCurrent = () => areServerAccountScopesEqual(
                    getActiveServerAccountScope(),
                    expectedActiveScope,
                ) && areServerAccountScopesEqual(authority.scope, expectedActiveScope);
                if (!isCurrent()) {
                    await authority.release();
                    throw new Error('Pending owner server-account scope changed');
                }
                return await withServerWireMode({
                    outboxScope: expectedActiveScope,
                    request: async (path, init) => {
                        if (!isCurrent()) throw new Error('Pending owner server-account scope changed');
                        return await authority.request(path, init);
                    },
                    isCurrent,
                    encryption: createScopedSessionEncryptionSource(authority.context),
                    release: authority.release,
                });
            }
            const assertCapturedActiveScope = (): void => {
                if (!this.isAppliedTransportAccountScopeCurrent(expectedActiveScope)) {
                    throw new Error('Pending owner server-account scope changed');
                }
            };
            return await withServerWireMode({
                outboxScope: expectedActiveScope,
                request: async (path, init) => {
                    assertCapturedActiveScope();
                    return await this.requestViaConfiguredSocket(path, init);
                },
                isCurrent: () => this.isAppliedTransportAccountScopeCurrent(expectedActiveScope),
                encryption: this.encryption,
                release: async () => undefined,
            });
        }
        const activeRequest = this.createSessionRequest(sessionId);
        const fenceAppliedRequest = (capturedScope: ServerAccountScope) => async (
            path: string,
            init?: RequestInit,
        ): Promise<Response> => {
            if (!this.isAppliedTransportAccountScopeCurrent(capturedScope)) {
                throw new Error('Pending owner server-account scope changed');
            }
            return await activeRequest(path, init);
        };
        const explicitServerId = typeof expectedServerId === 'string' && expectedServerId.trim().length > 0
            ? expectedServerId.trim()
            : null;
        const preferredServerId = explicitServerId ?? resolvePreferredServerIdForSessionId(sessionId);
        const appliedOutboxScope = this.getAppliedTransportAccountScope();
        const targetsAppliedTransport = !preferredServerId
            || areServerProfileIdentifiersEquivalent(preferredServerId, this.appliedServerTarget?.serverId);
        if (
            appliedOutboxScope
            && targetsAppliedTransport
        ) {
            return await withServerWireMode({
                outboxScope: appliedOutboxScope,
                request: fenceAppliedRequest(appliedOutboxScope),
                isCurrent: () => this.isAppliedTransportAccountScopeCurrent(appliedOutboxScope),
                encryption: this.encryption,
                release: async () => undefined,
            });
        }
        let context = await resolveServerAccountRequestContext({
            serverId: preferredServerId ?? null,
            ...(targetsAppliedTransport && !appliedOutboxScope ? { preferScoped: true } : {}),
        });
        if (context.scope === 'active' && !this.getAppliedTransportAccountScope()) {
            context = await resolveServerAccountRequestContext({
                serverId: preferredServerId ?? null,
                preferScoped: true,
            });
        }
        if (context.scope === 'active') {
            const outboxScope = this.getAppliedTransportAccountScope();
            if (!outboxScope) {
                throw new Error('Pending enqueue requires an applied transport account scope');
            }
            return await withServerWireMode({
                outboxScope,
                request: fenceAppliedRequest(outboxScope),
                isCurrent: () => this.isAppliedTransportAccountScopeCurrent(outboxScope),
                encryption: this.encryption,
                release: async () => undefined,
            });
        }
        const outboxScope = createServerAccountScope(context.targetServerId, context.targetAccountId);
        if (!outboxScope) {
            throw new Error('Pending enqueue requires an authenticated server-account scope');
        }
        return await withServerWireMode({
            outboxScope,
            request: createServerRequestForResolvedServerScope({ context, activeRequest }),
            encryption: createScopedSessionEncryptionSource(context),
            release: context.release ?? (async () => undefined),
            isCurrent: async () => {
                const currentPreferredServerId = explicitServerId ?? resolvePreferredServerIdForSessionId(sessionId);
                if (
                    typeof currentPreferredServerId !== 'string'
                    || !areServerProfileIdentifiersEquivalent(currentPreferredServerId, outboxScope.serverId)
                ) return false;
                const currentContext = await resolveServerAccountRequestContext({
                    serverId: currentPreferredServerId,
                    preferScoped: true,
                });
                try {
                    if (currentContext.scope !== 'scoped') return false;
                    const currentScope = createServerAccountScope(
                        currentContext.targetServerId,
                        currentContext.targetAccountId,
                    );
                    return areServerAccountScopesEqual(currentScope, outboxScope);
                } finally {
                    if (currentContext.scope === 'scoped') await currentContext.release?.();
                }
            },
        });
    }

    private async withPendingQueueOwnerContext<TResult>(
        sessionId: string,
        operation: (
            owner: Awaited<ReturnType<Sync['resolvePendingQueueOwnerContext']>>,
        ) => Promise<TResult>,
        expectedActiveScope?: ServerAccountScope,
        expectedServerId?: string | null,
        expectedAccountLifetime?: ServerAccountScopeLifetime,
    ): Promise<TResult> {
        const owner = await this.resolvePendingQueueOwnerContext(
            sessionId,
            expectedActiveScope,
            expectedServerId,
            expectedAccountLifetime,
        );
        try {
            if (!await owner.isCurrent()) throw new Error('Pending owner server-account scope changed');
            // The owner scope is fenced BEFORE the operation. A scope that retires
            // while the request is in flight cannot unsend it, so re-checking
            // afterwards would only turn a server-accepted mutation into a caller
            // rejection; each operation gates its own local projection instead.
            return await operation(owner);
        } finally {
            await owner.release();
        }
    }

    async retryPendingMessageSend(sessionId: string, localId: string, options?: PendingQueueOwnerOptions): Promise<void> {
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, serverWireMode, isCurrent }) => {
        const pending = storage.getState().sessionPending[sessionId]?.messages?.find((message) =>
            isPendingOutboxProjectionForIdentity(message, { sessionId, localId, outboxScope })
        );
        if (!pending) throw new Error('Pending retry requires its persisted server-account scope');
        const projectedServerId = storage.getState().sessions[sessionId]?.serverId;
        if (
            !options?.serverId
            || (projectedServerId && areServerProfileIdentifiersEquivalent(projectedServerId, outboxScope.serverId))
            || (!projectedServerId && areServerProfileIdentifiersEquivalent(outboxScope.serverId, this.appliedServerTarget?.serverId))
        ) {
            this.markSessionLiveTailIntent(sessionId);
        }
        await setPendingMessageSendState(sessionId, localId, 'unconfirmed', outboxScope);
        try {
            const result = await retryPendingOutboxOperationV2({
                sessionId,
                localId,
                request,
                outboxScope,
                serverWireMode,
            });
            if (!await isCurrent()) return;
            if (!result.accepted && shouldSchedulePendingOutboxTransportRetry(serverWireMode)) {
                this.schedulePendingOutboxOperationRetry({ sessionId, localId, outboxScope });
            }
        } catch (error) {
            if (!await isCurrent()) throw error;
            if (isTerminalAuthError(error)) {
                this.recordTerminalAuthSyncError(error, { serverId: outboxScope.serverId });
            }
            await setPendingMessageSendState(sessionId, localId, 'failed', outboxScope);
        }
        }, undefined, options?.serverId);
    }

    async updatePendingMessage(
        sessionId: string,
        pendingId: string,
        text: string,
        structuredInput?: RawIngressStructuredInputV1 | HappierStructuredInputV1,
        options?: Readonly<{
            replacementLocalId?: string;
            preparedComposerAdmission?: Readonly<{
                stagedMediaHandles: readonly ComposerContentHandleV1[];
                stagedMediaReleaseIntents?: import('@happier-dev/protocol/sessions/userMessageRpc').SessionPendingMessageComposerAdmissionAcceptedRequestV1['stagedMediaReleaseIntents'];
                sessionMediaMetadata?: Readonly<{
                    key: 'happier' | 'happierMedia';
                    envelope: import('@happier-dev/protocol').SessionMediaMessageMetaV1;
                }>;
            }>;
            serverId?: string | null;
            accountLifetime?: ServerAccountScopeLifetime;
            session?: Session;
        }>,
    ): Promise<PendingMessageComposerAdmissionAcceptedFactV1 | undefined> {
        return await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent, encryption }) => await updatePendingMessageV2({
            sessionId,
            pendingId,
            text,
            structuredInput,
            replacementLocalId: options?.replacementLocalId,
            preparedComposerAdmission: options?.preparedComposerAdmission,
            encryption,
            ...(!options?.accountLifetime ? {
                fetchArtifactWithBody: (artifactId: string) => this.fetchArtifactWithBody(artifactId),
                updateArtifact: (artifact: DecryptedArtifact) => storage.getState().updateArtifact(artifact),
            } : {}),
            request,
            outboxScope,
            isCurrent,
            ...(options?.session ? { session: options.session } : {}),
        }), undefined, options?.serverId, options?.accountLifetime);
    }

    async deletePendingMessage(sessionId: string, pendingId: string, options?: PendingQueueOwnerOptions): Promise<void> {
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent }) => {
        await deletePendingMessageV2({
            sessionId,
            pendingId,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
        }, undefined, options?.serverId);
    }

    async withdrawPendingMessage(
        sessionId: string,
        pendingId: string,
        options?: PendingQueueOwnerOptions & { accountLifetime?: ServerAccountScopeLifetime; targetExecutionRunId?: string },
    ): Promise<import('@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1').PendingMessageWithdrawOutcomeV1> {
        return await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent }) => (
            deletePendingMessageV2({
                sessionId, pendingId, request, outboxScope, withdraw: true,
                targetExecutionRunId: options?.targetExecutionRunId,
                isOutboxScopeCurrent: isCurrent,
            })
        ), undefined, options?.serverId, options?.accountLifetime);
    }

    async discardPendingMessage(
        sessionId: string,
        pendingId: string,
        opts?: PendingQueueOwnerOptions & { reason?: 'switch_to_local' | 'manual' }
    ): Promise<void> {
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent, encryption }) => {
        await discardPendingMessageV2({
            sessionId,
            pendingId,
            reason: opts?.reason ?? 'manual',
            encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
        }, undefined, opts?.serverId);
    }

    async dismissPendingDelivery(sessionId: string, pendingId: string, options?: PendingQueueOwnerOptions & {
        accountLifetime?: ServerAccountScopeLifetime; targetExecutionRunId?: string;
    }): Promise<void> {
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent, encryption }) => {
        await dismissPendingDeliveryV2({
            sessionId,
            pendingId,
            encryption,
            targetExecutionRunId: options?.targetExecutionRunId,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
        }, undefined, options?.serverId, options?.accountLifetime);
    }

    async blockPendingDelivery(
        sessionId: string,
        pendingId: string,
        reason: PendingDeliveryBlockedReason,
        options?: PendingQueueOwnerOptions,
    ): Promise<void> {
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent, encryption }) => {
        await blockPendingDeliveryV2({
            sessionId,
            pendingId,
            reason,
            encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
        }, undefined, options?.serverId);
    }

    async restoreDiscardedPendingMessage(sessionId: string, pendingId: string, options?: PendingQueueOwnerOptions): Promise<void> {
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent, encryption }) => {
        await restoreDiscardedPendingMessageV2({
            sessionId,
            pendingId,
            encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
        }, undefined, options?.serverId);
    }

    async sendPendingDeliveryAsNew(sessionId: string, pendingId: string, options?: PendingQueueOwnerOptions & {
        accountLifetime?: ServerAccountScopeLifetime; targetExecutionRunId?: string;
    }): Promise<string> {
        return await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent, encryption }) => {
        return await sendPendingDeliveryAsNewV2({
            sessionId,
            pendingId,
            encryption,
            targetExecutionRunId: options?.targetExecutionRunId,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
        }, undefined, options?.serverId, options?.accountLifetime);
    }

    async markPendingDeliveryHandled(sessionId: string, pendingId: string, options?: PendingQueueOwnerOptions & {
        accountLifetime?: ServerAccountScopeLifetime;
    }): Promise<void> {
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent, encryption }) => {
        await markPendingDeliveryHandledV2({
            sessionId,
            pendingId,
            encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
        }, undefined, options?.serverId, options?.accountLifetime);
    }

    async deleteDiscardedPendingMessage(sessionId: string, pendingId: string, options?: PendingQueueOwnerOptions): Promise<void> {
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent, encryption }) => {
        await deleteDiscardedPendingMessageV2({
            sessionId,
            pendingId,
            encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
        }, undefined, options?.serverId);
    }

    async reorderPendingMessages(
        sessionId: string,
        orderedLocalIds: string[],
        recipient?: PendingMessage['recipient'],
        options?: PendingQueueOwnerOptions,
    ): Promise<void> {
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent, encryption }) => {
        const canonicalOrderedLocalIds = await Promise.all(orderedLocalIds.map((pendingId) =>
            resolvePendingMessageProjectionLocalIdV2(sessionId, pendingId, outboxScope)
        ));
        await reorderPendingMessagesV2({
            sessionId,
            recipient,
            orderedLocalIds: canonicalOrderedLocalIds,
            encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
        }, undefined, options?.serverId);
    }

    applySettings = (delta: AccountSettingsWriteDelta, options: {
        expectedSettingsScope: AccountSettingsScope | null;
        source?: SettingsAnalyticsSource;
    }) => {
        applySettingsLocalDelta({
            expectedSettingsScope: options.expectedSettingsScope,
            delta,
            settingsSecretsKey: this.settingsSecretsKey,
            getPendingSettings: () => this.pendingSettings,
            setPendingSettings: (next) => {
                this.pendingSettings = next;
            },
            schedulePendingSettingsFlush: () => this.schedulePendingSettingsFlush(),
            source: options.source,
        });
    }

    refreshPurchases = () => {
        this.purchasesSync.invalidate();
    }

    /**
     * Registration only consumes an already-granted OS permission, so a newly granted permission
     * must re-run it immediately instead of waiting for the next bootstrap or resume.
     */
    onPushPermissionGranted = () => {
        schedulePushTokenReconciliation();
    }

    refreshProfile = async () => {
        await this.profileSync.invalidateAndAwait();
    }

    purchaseProduct = async (productId: string): Promise<{ success: boolean; error?: string }> => {
        const shouldContinue = this.createServerScopeGuard();
        return await purchaseProductEngine({
            revenueCatInitialized: this.revenueCatInitialized,
            productId,
            shouldContinue,
            applyPurchases: (customerInfo) => storage.getState().applyPurchases(customerInfo),
        });
    }

    getOfferings = async (): Promise<{ success: boolean; offerings?: any; error?: string }> => {
        return await getOfferingsEngine({ revenueCatInitialized: this.revenueCatInitialized });
    }

    presentPaywall = async (): Promise<{ success: boolean; purchased?: boolean; error?: string }> => {
        const shouldContinue = this.createServerScopeGuard();
        return await presentPaywallEngine({
            revenueCatInitialized: this.revenueCatInitialized,
            trackPaywallPresented,
            trackPaywallPurchased,
            trackPaywallCancelled,
            trackPaywallRestored,
            trackPaywallError,
            shouldContinue,
            syncPurchases: () => this.syncPurchases(),
        });
    }

    async assumeUsers(
        userIds: string[],
        options?: Readonly<{
            credentials?: AuthCredentials;
            request?: ServerFetch;
            shouldContinue?: () => boolean;
        }>,
    ): Promise<void> {
        const credentials = options?.credentials ?? this.credentials;
        if (!credentials || userIds.length === 0) return;
        const shouldContinue = options?.shouldContinue ?? (() => true);
        if (!shouldContinue()) return;
        const request = options?.request ?? (() => {
            const target = this.getAppliedTransportTarget();
            return target ? this.createAppliedTransportRequest(target) : this.requestViaConfiguredSocket;
        })();
        
        const state = storage.getState();
        // Filter out users we already have in cache (including null for 404s)
        const missingIds = userIds.filter(id => !(id in state.users));
        
        if (missingIds.length === 0) return;

        // The API owns 404-to-null normalization. Other failures must reach the
        // Feed retry owner before it publishes a snapshot without these users.
        const results = await Promise.all(
            missingIds.map(async (id) => ({
                id,
                profile: await getUserProfile(credentials, id, { request, retry: 'none' }),
            })),
        );

        const usersMap: Record<string, UserProfile | null> = {};
        for (const r of results) {
            usersMap[r.id] = r.profile;
        }

        if (shouldContinue() && Object.keys(usersMap).length > 0) {
            storage.getState().applyUsers(usersMap);
        }
    }

    //
    // Private
    //

    private getActiveSessionHydrationIds = (): string[] => {
        const viewingSessionId = getCurrentViewingSessionId();
        const surfaceVisibility = getSessionSurfaceVisibilitySnapshot();
        const focusedAddress = getFocusedSessionAddress();
        const routeAnchor = getRouteAnchorSessionAddress();
        const activeServerId = this.getAppliedTransportTarget()?.serverId;
        // Viewing activations retain their legacy ID-only fallback, but must
        // not override an explicitly scoped surface for the same Session.
        const viewingAddress = focusedAddress?.sessionId === viewingSessionId ? focusedAddress
            : routeAnchor?.sessionId === viewingSessionId ? routeAnchor : null;
        const hasScopedViewingSurface = viewingSessionId !== null
            && getVisibleSessionSurfaces().some(address => address.sessionId === viewingSessionId);
        const currentViewingSessionId = (!viewingAddress || areServerProfileIdentifiersEquivalent(viewingAddress.serverId, activeServerId))
            && (!hasScopedViewingSurface || (viewingSessionId !== null && isSessionSurfaceVisible(viewingSessionId, activeServerId)))
            ? viewingSessionId : null;
        const focusedSessionId = !focusedAddress || areServerProfileIdentifiersEquivalent(focusedAddress.serverId, activeServerId)
            ? surfaceVisibility.focusedSessionId : null;
        const routeSessionId = !routeAnchor || areServerProfileIdentifiersEquivalent(routeAnchor.serverId, activeServerId)
            ? surfaceVisibility.routeAnchorSessionId : null;
        return Array.from(new Set([
            currentViewingSessionId,
            focusedSessionId,
            routeSessionId,
            ...surfaceVisibility.visibleSessionIds.filter(sessionId => isSessionSurfaceVisible(sessionId, activeServerId)),
            ...getVisibleSessionListSurfaces()
                .filter(address => areServerProfileIdentifiersEquivalent(address.serverId, activeServerId))
                .map(address => address.sessionId),
            ...Object.keys(storage.getState().sessions)
                .filter(sessionId => resolveSessionLiveConsumption(sessionId, activeServerId).isFullContentConsumer),
        ].filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0)));
    }

    private getPrioritizedSessionHydrationIds = (): string[] => {
        // Persisted transcript scroll positions are restoration state, not
        // evidence that their Sessions are consumed by this window now.
        return this.getActiveSessionHydrationIds();
    }

    private isSessionHydrationDemanded = (sessionId: string, serverId?: string | null): boolean => {
        const route = getRouteAnchorSessionAddress();
        return isSessionListRowVisible(sessionId, serverId)
            || resolveSessionLiveConsumption(sessionId, serverId).isFullContentConsumer
            || (route?.sessionId === sessionId && areServerProfileIdentifiersEquivalent(route.serverId, serverId));
    };

    /** A virtualized list batches its newly visible rows; exact reads share route acquisition. */
    public hydrateSessionListRows = async (addresses: readonly SessionAddress[]): Promise<void> => {
        if (!await this.awaitBootstrapForegroundAcquisition()) return;
        const unique = new Map(addresses.map(address => [sessionAddressKey(address), address]));
        await runTasksWithLimit([...unique.values()].map(address => async () => {
            if (!isSessionListRowVisible(address.sessionId, address.serverId)) return;
            await this.ensureSessionVisibleForMessageRoute(address.sessionId, {
                serverId: address.serverId,
                hydrateMessages: false,
            });
        }), this.syncTuning.sessionListHydrationConcurrencyLimit);
    };

    private fetchSessions = async (options?: FetchSessionsOptions) => {
        if (!await this.awaitBootstrapForegroundAcquisition()) return;
        const credentials = this.credentials;
        if (!credentials) return;
        const appliedTransportTarget = this.getAppliedTransportTarget();
        if (!appliedTransportTarget) return;
        const serverScopeGeneration = this.serverScopeGeneration;
        const snapshotGeneration = this.sessionListSnapshotGeneration;
        if (canShareFetchSessionsInFlight(options)) {
            const existing = this.fetchSessionsInFlight;
            if (
                existing
                && existing.serverScopeGeneration === serverScopeGeneration
                && existing.snapshotGeneration === snapshotGeneration
                && this.isAppliedTransportTargetCurrent(existing.target)
            ) {
                return existing.promise;
            }
        }
        const activeServerId = appliedTransportTarget.serverId;
        this.publishActiveSessionListObservation(
            !activeServerId || storage.getState().concurrentSessionListCacheByServerId[activeServerId]?.listObservation?.lastSuccessAt == null
                ? 'loading'
                : 'refreshing',
            undefined,
            activeServerId,
        );
        const runFetch = this.fetchSessionsOnce(
            options,
            serverScopeGeneration,
            snapshotGeneration,
            appliedTransportTarget,
            credentials,
        ).catch((error) => {
            const failure = classifySessionListFailure(error);
            this.publishActiveSessionListObservation(failure.reason === 'network' && (this.socketStatus === 'disconnected' || this.socketStatus === 'error')
                ? 'offline'
                : 'error', undefined, activeServerId, failure);
            throw error;
        });
        if (canShareFetchSessionsInFlight(options)) {
            const sharedFetch = runFetch.finally(() => {
                if (this.fetchSessionsInFlight?.promise === sharedFetch) {
                    this.fetchSessionsInFlight = null;
                }
            });
            this.fetchSessionsInFlight = {
                serverScopeGeneration,
                snapshotGeneration,
                target: appliedTransportTarget,
                promise: sharedFetch,
            };
            return sharedFetch;
        }
        return runFetch;
    }

    private publishActiveSessionListObservation = (
        phase: SessionListHomeObservationPhase,
        lastSuccessAt?: number,
        expectedServerId?: string,
        failure?: SessionListFailure,
    ): void => {
        const serverId = this.getAppliedTransportTarget()?.serverId ?? '';
        if (!serverId || (expectedServerId && serverId !== expectedServerId)) return;
        storage.setState((state) => {
            const previous = state.concurrentSessionListCacheByServerId[serverId];
            const nextLastSuccessAt = typeof lastSuccessAt === 'number'
                ? lastSuccessAt
                : previous?.listObservation?.lastSuccessAt ?? null;
            const listObservation = { phase, lastSuccessAt: nextLastSuccessAt,
                ...(phase === 'error' && failure ? { failure } : {}) };
            if (areSessionListHomeObservationsEqual(previous?.listObservation, listObservation)) return state;
            return {
                ...state,
                concurrentSessionListCacheByServerId: {
                    ...state.concurrentSessionListCacheByServerId,
                    [serverId]: {
                        serverName: resolveHomeDisplayLabel(getServerProfileById(serverId), serverId),
                        listObservation,
                    },
                },
            };
        });
    };

    private fetchSessionsOnce = async (
        options: FetchSessionsOptions | undefined,
        serverScopeGeneration: number,
        snapshotGeneration: number,
        appliedTransportTarget: SyncServerTarget,
        credentials: AuthCredentials,
    ) => {
        const shouldContinue = () => (
            this.serverScopeGeneration === serverScopeGeneration
            && this.sessionListSnapshotGeneration === snapshotGeneration
            && this.isAppliedTransportTargetCurrent(appliedTransportTarget)
        );
        const initialState = storage.getState();
        const activeServerId = appliedTransportTarget.serverId || null;
        const activeRows = activeServerId ? initialState.sessionListRowsByServerId[activeServerId] ?? {} : {};
        const cachedSessionListEntries = buildSessionListCacheEntriesFromRenderables(activeRows);
        const activeHydrationSessionIds = this.getActiveSessionHydrationIds();
        const activeHydrationSessionIdSet = new Set(activeHydrationSessionIds);
        const explicitPrioritizedHydrationIds = options?.prioritizeSessionIds ?? [];
        const prioritizedHydrationIds = Array.from(new Set([
            ...explicitPrioritizedHydrationIds,
            ...this.getPrioritizedSessionHydrationIds(),
        ])).filter((sessionId) => (
            !activeHydrationSessionIdSet.has(sessionId)
            || explicitPrioritizedHydrationIds.includes(sessionId)
        ));
        const isAppend = options?.mode === 'append';
        const previousFrontier = this.readOrdinarySessionListFrontier();
        const sessionRequest = this.createAppliedTransportRequest(appliedTransportTarget);
        const continuation = isAppend
            ? resolveOrdinarySessionListContinuation(previousFrontier)
            : null;
        const hasLastKnownOrganizationSnapshot = activeServerId
            ? typeof initialState.sessionOrganizationSnapshotVersionByServerId[activeServerId] === 'number'
            : false;
        const organizationSnapshotRefresh = !isAppend && activeServerId
            ? fetchAndApplySessionOrganizationSnapshot({
                credentials,
                serverId: activeServerId,
                serverUrl: appliedTransportTarget.serverUrl,
                requestAtEndpoint: sessionRequest,
                request: createSessionListOrganizationSnapshotRequest(),
                shouldContinue,
            })
            : null;
        // Attach failure handling immediately while the Session read overlaps
        // this request. The containing retry attempt still owns both outcomes.
        const organizationSnapshotOutcome = organizationSnapshotRefresh?.then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
        );
        if (!hasLastKnownOrganizationSnapshot) await organizationSnapshotOutcome;
        const organizationPinnedSessionIds = isAppend
            ? []
            : resolveOrganizationPinnedSessionIdsForServer(storage.getState(), activeServerId);
        const requiredHydrationSessionIds = Array.from(new Set([
            ...(options?.requiredHydrationSessionIds ?? []),
            ...organizationPinnedSessionIds,
        ]));
        const applyRequiredHydrationSessions: typeof this.applySessions = (sessions) => {
            if (!shouldContinue()) return;
            this.applySessions(sessions.filter((session) => {
                const currentRenderable = activeServerId
                    ? storage.getState().sessionListRowsByServerId[activeServerId]?.[session.id]
                    : null;
                return !currentRenderable
                    // This callback precedes publication: keep the incoming response's
                    // own witness, never the newer incumbent's observation.
                    || isHydratedSessionCurrentForListState(session, () => currentRenderable, session.updatedAt);
            }));
        };
        const hydrateRequiredSessions = async (
            sessionIds: readonly string[],
            accountCurrentness: Awaited<ReturnType<typeof fetchAccountEncryptionCurrentness>> | undefined,
            prefetched?: FetchSessionsResult['prefetchedFullSessionReads'],
        ): Promise<void> => {
            if (!sessionIds.length || !activeServerId || !shouldContinue()) return;
            const stagedSessionDataKeys = new Map(this.sessionDataKeys);
            const stagedSessionDataKeyEnvelopes = new Map(this.sessionDataKeyEnvelopes);
            const currentness = createOperationAccountCurrentnessSource({ credentials, request: sessionRequest,
                serverId: activeServerId, initial: accountCurrentness });
            try {
                await runWithServerRequestAuthorityForServerAccountScope({ serverId: activeServerId,
                    activeRequest: (path, init) => sessionRequest(path, init ?? {}) }, async authority => {
                    const results = await readSessionSnapshotsForAuthority({ authority, sessionIds, prefetched,
                        includeTurns: false, accountCurrentnessSource: currentness, isCurrent: shouldContinue,
                        processingConcurrencyLimit: this.syncTuning.sessionListHydrationConcurrencyLimit,
                        sessionDataKeys: stagedSessionDataKeys, sessionDataKeyEnvelopes: stagedSessionDataKeyEnvelopes,
                        getExistingSession: id => storage.getState().sessions[id] ?? null });
                    if (!shouldContinue()) return;
                    for (const sessionId of sessionIds) {
                        if (!shouldContinue()) return;
                        const result = results.get(sessionId);
                        if (result?.ok) {
                            applyRequiredHydrationSessions([result.snapshot.session]);
                        } else if (result && result.error instanceof SessionSnapshotReadError && result.error.errorCode === 'not_found') {
                            stagedSessionDataKeys.delete(sessionId);
                            stagedSessionDataKeyEnvelopes.delete(sessionId);
                            // Exact absence retires this Home's row and fences older snapshots.
                            this.retireLocalSession(sessionId, activeServerId);
                        } else {
                            throw result && !result.ok ? result.error : new Error('Required Session result missing');
                        }
                        const stagedKey = stagedSessionDataKeys.get(sessionId);
                        if (stagedKey) this.sessionDataKeys.set(sessionId, stagedKey);
                        else this.sessionDataKeys.delete(sessionId);
                        const stagedEnvelope = stagedSessionDataKeyEnvelopes.get(sessionId);
                        if (typeof stagedEnvelope === 'string') this.sessionDataKeyEnvelopes.set(sessionId, stagedEnvelope);
                        else this.sessionDataKeyEnvelopes.delete(sessionId);
                    }
                });
            } finally {
                currentness.dispose();
            }
        };
        const result = await fetchAndApplySessions({
            clientEncryptionRequirement: resolveUiClientEncryptionRequirement({
                syncedSettings: storage.getState().settings,
                localSettings: storage.getState().settings,
            }),
            serverId: activeServerId,
            sessionListCursor: continuation?.kind === 'ordinary' ? continuation.cursor : null,
            sessionListAttentionCursor: continuation?.kind === 'attention' ? continuation.cursor : null,
            sessionListMaxPages: 1,
            includeActiveSessionRows: !isAppend,
            includeSessionListAttentionRows: !isAppend || continuation?.kind === 'attention',
            credentials,
            encryption: this.encryption,
            sessionDataKeys: this.sessionDataKeys,
            sessionDataKeyEnvelopes: this.sessionDataKeyEnvelopes,
            request: sessionRequest,
            getExistingSession: (sessionId) => storage.getState().sessions[sessionId] ?? null,
            getCurrentSessionListRenderable: (sessionId) => (
                activeServerId
                    ? storage.getState().sessionListRowsByServerId[activeServerId]?.[sessionId] ?? null
                    : null
            ),
            cachedSessionListEntries,
            shouldContinue,
            applySessionListRenderables: (sessions) => {
                if (!shouldContinue()) return;
                if (activeServerId) {
                    storage.getState().applyServerScopedSessionListRows(activeServerId, sessions, {
                        source: 'ordinary',
                        mode: isAppend ? 'append' : 'replace',
                    });
                }
            },
            applySessionListRenderablePatches: (patches) => {
                if (!shouldContinue()) return;
                if (activeServerId) {
                    storage.getState().applyServerScopedSessionListRowPatches(activeServerId, patches);
                }
            },
            onSnapshotFetched: (sessionIds) => {
                if (!shouldContinue()) return;
                this.activeServerSessionIds = isAppend
                    ? new Set([...this.activeServerSessionIds, ...sessionIds])
                    : new Set(sessionIds);
                this.hasFetchedSessionsSnapshotForActiveServer = true;
            },
            prioritizeSessionIds: prioritizedHydrationIds,
            activeSessionIds: activeHydrationSessionIds,
            requiredHydrationSessionIds,
            hydrateRequiredSessions,
            awaitSessionListHydration: options?.awaitSessionListHydration,
            sessionListHydrationConcurrencyLimit: this.syncTuning.sessionListHydrationConcurrencyLimit,
            sessionListBackgroundHydrationConcurrencyLimit: this.syncTuning.sessionListBackgroundHydrationConcurrencyLimit,
            sessionListBackgroundHydrationYieldDelayMs: this.syncTuning.sessionListBackgroundHydrationYieldDelayMs,
            sessionListBackgroundHydrationYieldEveryRows: this.syncTuning.sessionListBackgroundHydrationYieldEveryRows,
            sessionListBackgroundHydrationGate: isAppend ? this.waitForSessionListScrollIdle : undefined,
            sessionListBackgroundHydrationApplyBatchSize: this.syncTuning.sessionListBackgroundHydrationApplyBatchSize,
            sessionListBackgroundHydrationApplyFlushDelayMs: this.syncTuning.sessionListBackgroundHydrationApplyFlushDelayMs,
            applySessions: (sessions, source) => {
                if (!shouldContinue()) return;
                this.applySessions(sessions, source);
            },
            log,
        });
        const organizationOutcome = await organizationSnapshotOutcome;
        if (shouldContinue() && organizationOutcome?.ok === false) throw organizationOutcome.error;
        // A canceled acquisition applied no rows, so it must not advance this
        // Home's frontier either — otherwise the cursor moves past a page that
        // was never stored and no later refresh recovers it. Same guard the
        // concurrent-cache owner already applies before publishing a page.
        if (!result.current || !shouldContinue()) return;
        const fetchedSessionIdSet = new Set(result.sessionIds.filter((sessionId) => result.isSessionCurrent?.(sessionId) !== false));
        // The overlapping organization refresh may discover pins that were
        // absent from the warm snapshot used to prioritize the list read.
        const settledRequiredHydrationSessionIds = Array.from(new Set([
            ...requiredHydrationSessionIds,
            ...(isAppend ? [] : resolveOrganizationPinnedSessionIdsForServer(storage.getState(), activeServerId)),
        ]));
        const hasCurrentRequiredSession = (sessionId: string): boolean => {
            const session = storage.getState().sessions[sessionId];
            return Boolean(session
                && areServerProfileIdentifiersEquivalent(session.serverId, activeServerId)
                && hasAuthoritativeSessionRouteData(session)
                && isHydratedSessionCurrentForListState(session,
                    id => activeServerId ? storage.getState().sessionListRowsByServerId[activeServerId]?.[id] : null,
                    readSessionFullPublicationUpdatedAt(session)));
        };
        const missingRequiredHydrationSessionIds = settledRequiredHydrationSessionIds.filter(
            sessionId => result.isSessionCurrent?.(sessionId) !== false
                && (!fetchedSessionIdSet.has(sessionId) || !hasCurrentRequiredSession(sessionId)),
        );
        await hydrateRequiredSessions(missingRequiredHydrationSessionIds, result.accountCurrentness);
        if (!shouldContinue()) return;
        for (const sessionId of missingRequiredHydrationSessionIds) {
            if (result.isSessionCurrent?.(sessionId) !== false && !hasCurrentRequiredSession(sessionId)) {
                throw new Error(`Required session hydration failed for ${sessionId}`);
            }
        }
        const frontier = advanceOrdinarySessionListFrontier({
            previous: isAppend ? previousFrontier : EMPTY_ORDINARY_SESSION_LIST_FRONTIER,
            continuation,
            result,
        });
        this.sessionListNextCursor = frontier.nextCursor;
        this.sessionListHasMore = frontier.hasNext;
        this.sessionListAttentionNextCursor = frontier.attentionNextCursor;
        this.sessionListAttentionHasMore = frontier.attentionHasNext;
        this.sessionListMetadataUpgradeRequiredCount = frontier.metadataUpgradeRequiredCount ?? 0;
        if (isOrdinarySessionListFrontierExhausted(frontier)) {
            this.publishActiveSessionListObservation('ready', Date.now(), activeServerId ?? undefined);
        }
        // First paint/frontier publication precedes the independent migration
        // census and its gathered full-tuple work, including archived rows.
        if (!isAppend) {
            await this.refreshSessionMetadataUpgrades(options?.discoverMetadataUpgrades, result.prefetchedFullSessionReads);
        } else if (!this.embedSessionScope) {
            await ensureSessionDisplayProjectionsForRead({ serverId: activeServerId, credentials,
                request: sessionRequest, prefetched: result.prefetchedFullSessionReads,
                processingConcurrencyLimit: this.syncTuning.resumeConcurrencyLimit, isCurrent: shouldContinue });
        }
        const { prefetchedFullSessionReads: _consumedFullReads, ...publishedResult } = result;
        return publishedResult;
    }

    private refreshSessionMetadataUpgrades = async (force = false,
        prefetched?: FetchSessionsResult['prefetchedFullSessionReads']): Promise<void> => {
        const target = this.getAppliedTransportTarget();
        const credentials = this.credentials;
        const lifetime = !this.embedSessionScope ? captureActiveServerAccountScopeLifetime() : null;
        if (!target || !credentials || !lifetime) return;
        const isCurrent = () => lifetime.isCurrent() && this.isAppliedTransportTargetCurrent(target)
            && this.credentials?.token === credentials.token;
        const request = this.createAppliedTransportRequest(target);
        let consumedOwnPrefetched = false;
        const maintain = (sessionIds: readonly string[]) => ensureSessionDisplayProjectionsForRead({
            serverId: target.serverId, credentials, request, prefetched, sessionIds, isCurrent,
            processingConcurrencyLimit: this.syncTuning.resumeConcurrencyLimit });
        await this.metadataUpgradeDiscovery.refresh({
            request, token: credentials.token, isCurrent, log,
            migrate: async sessionIds => {
                consumedOwnPrefetched = true;
                if (!await maintain(sessionIds)) throw new Error('Session metadata upgrade deferred');
            },
        }, force);
        // A joined or already-satisfied census did not consume this caller's
        // captured parts. Do not infer tuple coverage from another caller's IDs.
        if (!consumedOwnPrefetched && prefetched?.size && !await maintain([])) {
            this.metadataUpgradeDiscovery.requestRefresh();
        }
    };

    public fetchSessionListQueryPage = async (
        serverIdRaw: string,
        page: SessionListQueryPageRequest,
    ) => {
        if (!await this.awaitBootstrapForegroundAcquisition()) throw new StaleServerGenerationError();
        const appliedServer = this.appliedServerTarget;
        const serverId = String(serverIdRaw ?? '').trim();
        const credentials = this.credentials;
        if (
            !serverId
            || !credentials
            || !appliedServer
            || !areServerProfileIdentifiersEquivalent(serverId, appliedServer.serverId)
        ) {
            throw new HappyError('Selected Home query runtime is unavailable', true, {
                kind: 'network',
                code: 'home_unavailable',
            });
        }
        const capturedAppliedServer = appliedServer;
        const capturedToken = credentials.token;
        const sessionRequest = this.createAppliedTransportRequest(capturedAppliedServer);
        const shouldContinue = () => (
            !page.signal.aborted
            && this.credentials?.token === capturedToken
            && this.appliedServerTarget?.serverId === capturedAppliedServer.serverId
            && this.appliedServerTarget.serverUrl === capturedAppliedServer.serverUrl
            && this.appliedServerTarget.generation === capturedAppliedServer.generation
        );
        const result = await fetchAndApplySessions({
            clientEncryptionRequirement: resolveUiClientEncryptionRequirement({
                syncedSettings: storage.getState().settings,
                localSettings: storage.getState().settings,
            }),
            serverId,
            source: page.source,
            signal: page.signal,
            sessionListPageSize: page.limit ?? (page.source.kind === 'query' ? page.source.body.limit : undefined),
            sessionListCursor: page.cursor,
            sessionListAttentionCursor: page.attentionCursor,
            sessionListMaxPages: 1,
            sessionListAttentionMaxPages: page.attentionCursor ? 1 : 0,
            requiredHydrationSessionIds: page.hydration === 'required' ? 'all' : undefined,
            candidateStartedBy: page.candidateStartedBy,
            awaitSessionListHydration: page.hydration === 'required',
            credentials,
            encryption: this.encryption,
            sessionDataKeys: this.sessionDataKeys,
            sessionDataKeyEnvelopes: this.sessionDataKeyEnvelopes,
            request: sessionRequest,
            getExistingSession: () => null,
            getCurrentSessionListRenderable: (sessionId) => (
                storage.getState().sessionListRowsByServerId?.[serverId]?.[sessionId]
                ?? null
            ),
            shouldContinue,
            applySessionListRenderables: (sessions) => {
                if (!shouldContinue()) return;
                storage.getState().applyServerScopedSessionListRows(serverId, sessions, {
                    // Ordinary, archived and query pages share this pagination owner but
                    // remain distinct canonical memberships in the store.
                    source: page.membership,
                    mode: page.cursor || page.attentionCursor ? 'append' : 'replace',
                });
            },
            applySessionListRenderablePatches: (patches) => {
                if (!shouldContinue()) return;
                storage.getState().applyServerScopedSessionListRowPatches(serverId, patches);
            },
            applySessions: () => {},
            log,
        });
        await ensureSessionDisplayProjectionsForRead({ serverId, credentials, request: sessionRequest,
            prefetched: result.prefetchedFullSessionReads, signal: page.signal, isCurrent: shouldContinue });
        const { prefetchedFullSessionReads: _consumedFullReads, ...publishedResult } = result;
        return publishedResult;
    }

    /**
     * The active Home's ordinary Session-list frontier.
     *
     * Sync is its single owner: the filter's ordinary corpus on this Home reads
     * this rather than opening a second paginator over `/v2/sessions`.
     */
    public readOrdinarySessionListFrontier = (): OrdinarySessionListFrontier => ({
        nextCursor: this.sessionListNextCursor,
        hasNext: this.sessionListHasMore,
        attentionNextCursor: this.sessionListAttentionNextCursor,
        attentionHasNext: this.sessionListAttentionHasMore,
        metadataUpgradeRequiredCount: this.sessionListMetadataUpgradeRequiredCount,
    });

    public fetchMoreSessions = async (): Promise<void> => {
        if (!this.credentials
            || !resolveOrdinarySessionListContinuation(this.readOrdinarySessionListFrontier())) return;
        if (this.fetchMoreSessionsInFlight) return this.fetchMoreSessionsInFlight;
        const promise = this.fetchSessions({ mode: 'append' }).then(() => undefined).finally(() => {
            if (this.fetchMoreSessionsInFlight === promise) {
                this.fetchMoreSessionsInFlight = null;
            }
        });
        this.fetchMoreSessionsInFlight = promise;
        return promise;
    }

    /**
     * The active Home's ordinary Session-list lifecycle facts.
     *
     * Every reader of "where has this Home's ordinary list got to" — coverage,
     * the filter's ordinary corpus on this Home, Voice — goes through this one
     * reader rather than re-deriving the frontier or the in-flight fact.
     */
    public readOrdinarySessionListLifecycle = (): OrdinarySessionListLifecycle => ({
        serverId: this.getAppliedTransportTarget()?.serverId ?? null,
        hasFetchedSnapshot: this.hasFetchedSessionsSnapshotForActiveServer,
        fetchInFlight: this.fetchSessionsInFlight !== null,
        fetchMoreInFlight: this.fetchMoreSessionsInFlight !== null,
        frontier: this.readOrdinarySessionListFrontier(),
    });

    /** Completeness owned by the current active Home's ordinary list lifecycle. */
    public readOrdinarySessionListCoverage = (): Readonly<{
        serverId: string | null;
        coverage: 'complete' | 'incomplete';
    }> => {
        const lifecycle = this.readOrdinarySessionListLifecycle();
        const observation = lifecycle.serverId
            ? storage.getState().concurrentSessionListCacheByServerId[lifecycle.serverId]?.listObservation
            : null;
        return {
            serverId: lifecycle.serverId,
            coverage: resolveOrdinarySessionListCoverage({
                serverId: lifecycle.serverId,
                hasFetchedSnapshot: lifecycle.hasFetchedSnapshot,
                phase: observation?.phase,
                fetchInFlight: lifecycle.fetchInFlight,
                fetchMoreInFlight: lifecycle.fetchMoreInFlight,
                hasNext: lifecycle.frontier.hasNext,
                attentionHasNext: lifecycle.frontier.attentionHasNext,
                metadataUpgradeRequiredCount: lifecycle.frontier.metadataUpgradeRequiredCount,
            }),
        };
    };

    private isSessionKnownOnActiveServer = (sessionId: string): boolean => {
        if (this.activeServerSessionIds.has(sessionId)) {
            return true;
        }

        if (!this.hasFetchedSessionsSnapshotForActiveServer) {
            return Boolean(storage.getState().sessions[sessionId]);
        }

        return false;
    }

    private isSessionKnownOnResolvedOwnerServer = (sessionId: string): boolean => {
        // `activeServerSessionIds` is a fetched-membership cache and can lag a
        // delete/share-revocation socket update. A page response may only apply
        // while the local session row still exists.
        if (!storage.getState().sessions[sessionId]) {
            return false;
        }
        if (this.isSessionKnownOnActiveServer(sessionId)) {
            return true;
        }

        return this.isSessionTargetRemoteToActiveServer(sessionId);
    }

    private isHydrationSourceActiveServer = (sourceServerId?: string | null): boolean => {
        const normalizedSourceServerId = String(sourceServerId ?? '').trim();
        const activeServerId = this.getAppliedTransportTarget()?.serverId ?? '';
        if (!normalizedSourceServerId) return true;
        return areServerProfileIdentifiersEquivalent(normalizedSourceServerId, activeServerId);
    }

    private shouldRefreshActiveSessionListAfterSocketHydration = (
        reason: SyncSocketSessionHydrationReason,
        sourceServerId?: string | null,
    ): boolean => (
        reason === 'socket-new-session-reconcile'
        && !this.embedSessionScope
        && this.isHydrationSourceActiveServer(sourceServerId)
    );

    private ensureHydratedActiveSessionListRow = (
        sessionId: string,
        sourceServerId?: string | null,
    ): void => {
        if (!this.isHydrationSourceActiveServer(sourceServerId)) return;
        const normalized = String(sessionId ?? '').trim();
        if (!normalized) return;

        const state = storage.getState();
        const activeServerId = this.getAppliedTransportTarget()?.serverId ?? '';
        if (!activeServerId) return;
        const currentIndex = state.sessionListIndexByServerId?.[activeServerId];
        if (currentIndex?.some((item) => item.type === 'session' && item.sessionId === normalized)) {
            return;
        }

        const session = state.sessions[normalized];
        if (!session || session.active !== true || session.archivedAt != null) return;
        const sessionServerId = String(session.serverId ?? sourceServerId ?? '').trim();
        if (sessionServerId && !areServerProfileIdentifiersEquivalent(sessionServerId, activeServerId)) {
            return;
        }

        const currentRenderable = state.sessionListRowsByServerId[activeServerId]?.[normalized];
        storage.getState().applyServerScopedSessionListRows(activeServerId, [
            buildSessionListRenderableFromSession(session, currentRenderable),
        ], { source: 'ordinary', mode: 'append' });
    }

    private hydrateSessionFromSocketUpdate = async (
        sessionId: string,
        reason: SyncSocketSessionHydrationReason,
        sourceServerId?: string | null,
    ): Promise<void> => {
        await this.ensureSessionVisibleForMessageRoute(sessionId, {
            forceRefresh: true,
            serverId: sourceServerId ?? undefined,
            includeTurnsProjection: reason === 'socket-update-turn-projection',
        });
        if (!this.shouldRefreshActiveSessionListAfterSocketHydration(reason, sourceServerId)) return;
        try {
            await this.fetchSessions({
                awaitSessionListHydration: true,
                requiredHydrationSessionIds: [sessionId],
                prioritizeSessionIds: [sessionId],
            });
        } finally {
            this.ensureHydratedActiveSessionListRow(sessionId, sourceServerId);
        }
    }

    private resolveSocketHydrationReasonForUpdate = (
        update: unknown,
        reason: SyncSocketSessionHydrationReason,
    ): SyncSocketSessionHydrationReason => {
        if (reason !== 'socket-update-missing-session') return reason;
        return parseUpdateContainer(update)?.body.t === 'new-session'
            ? 'socket-new-session-reconcile'
            : reason;
    }

    private createSessionRequest = (sessionId: string): ServerFetch => {
        const scope = this.embedSessionScope;
        if (scope) {
            if (sessionId !== scope.scope.sessionId) return async () => { throw new StaleServerGenerationError(); };
            return scope.request;
        }
        if (isEmbedWindowContext()) return async () => { throw new StaleServerGenerationError(); };
        return createServerRequestWithServerScope({
            serverId: resolvePreferredServerIdForSessionId(sessionId),
            activeRequest: this.requestViaConfiguredSocket,
        });
    }

    private createSessionMessagesRequest = (sessionId: string): ((path: string) => Promise<Response>) => {
        const request = this.createSessionRequest(sessionId);
        // The messages route enforces limit <= 500 (default 150), unlike unpaged metadata.
        return (path: string) => request(path, { method: 'GET' }, { recoveryRead: 'paged' });
    }

    /** One finite HTTP read keeps its Home's transport, Account cipher and shell together. */
    private async withSessionTranscriptRead<TResult>(sessionId: string, operation: (read: Readonly<{
        serverId: string | undefined;
        isSessionKnown: (id: string) => boolean;
        encryption: Encryption | null;
        request: (path: string) => Promise<Response>;
        pageOptions: ReturnType<Sync['getSessionMessagesPageOptions']>;
    }>) => Promise<TResult>): Promise<TResult> {
        // A materialized carrier is already exact-Home admitted. Bare-id list lookup
        // deliberately becomes ambiguous when another Home lists the same id.
        const serverId = normalizeScopedServerId(storage.getState().sessions[sessionId]?.serverId)
            ?? resolvePreferredServerIdForSessionId(sessionId);
        const activeServerId = this.getAppliedTransportTarget()?.serverId ?? getActiveServerSnapshot().serverId;
        if (this.embedSessionScope || !serverId || areServerProfileIdentifiersEquivalent(serverId, activeServerId)) {
            return await operation({ serverId, isSessionKnown: id => this.isSessionKnownOnResolvedOwnerServer(id),
                encryption: this.encryption, request: this.createSessionMessagesRequest(sessionId),
                pageOptions: this.getSessionMessagesPageOptions(sessionId) });
        }
        let credentialsCurrent = true;
        const unsubscribe = subscribeHomeCredentialMutations(event => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, serverId)) credentialsCurrent = false;
        });
        let authority: ServerAccountRequestAuthority | null = null;
        try {
            authority = await captureServerRequestAuthorityForServerAccountScope({ serverId, activeRequest: this.requestViaConfiguredSocket });
            const encryption = authority.context.encryption;
            const cipherLifetime = captureEncryptionGenerationCurrentness(encryption, authority.scope);
            const isCurrent = () => credentialsCurrent && cipherLifetime.isCurrent()
                && areServerProfileIdentifiersEquivalent(storage.getState().sessions[sessionId]?.serverId, serverId);
            const pageOptions = this.getSessionMessagesPageOptions(sessionId, undefined, { serverId, encryption, isCurrent });
            const capturedAuthority = authority;
            return await operation({ serverId, isSessionKnown: id => id === sessionId && pageOptions.isCurrent(), encryption, pageOptions,
                request: path => {
                    if (!pageOptions.isCurrent()) throw new StaleServerGenerationError();
                    return capturedAuthority.request(path, { method: 'GET' }, { recoveryRead: 'paged' });
                },
            });
        } finally {
            unsubscribe();
            await authority?.release();
        }
    }

    private isServerAccountSessionAuthorityCurrent(
        authority: ServerAccountRequestAuthority,
    ): boolean {
        return areServerAccountScopesEqual(
            getActiveServerAccountScope(),
            authority.scope,
        );
    }

    /**
     * An account-scoped History read must retain both its captured Account
     * authority and the local session shell. A delete keeps the former current
     * while intentionally removing the latter.
     */
    private isServerAccountSessionReadCurrent(
        authority: ServerAccountRequestAuthority,
        sessionId: string,
    ): boolean {
        return this.isServerAccountSessionAuthorityCurrent(authority)
            && Boolean(storage.getState().sessions[sessionId]);
    }

    private getSessionMessagesEncryptionForAuthority(
        authority: ServerAccountRequestAuthority,
        sessionId: string,
    ): SessionMessagesEncryption | null {
        if (!authority.context.encryption) return null;
        const candidate = authority.context.encryption.getSessionEncryption(sessionId);
        if (
            !candidate
            || typeof (candidate as { decryptMessages?: unknown }).decryptMessages !== 'function'
        ) {
            return null;
        }
        return candidate as unknown as SessionMessagesEncryption;
    }

    public fetchUserMessageHistoryPage = async (
        sessionId: string,
        opts: { beforeSeq?: number | null; limit?: number; turnProjection?: boolean } = {},
    ): Promise<FetchUserMessageHistoryPageResult> => {
        const normalizedSessionId = String(sessionId ?? '').trim();
        if (!normalizedSessionId) return { status: 'not_ready' };

        const currentness = captureActiveServerAccountScopeCurrentness();
        let session = storage.getState().sessions[normalizedSessionId] ?? null;
        if (!session) {
            // Sent-before also walks list-only Sessions. Reuse by-ID hydration to
            // acquire their mode/key without opening or populating the transcript.
            const hydration = await this.ensureSessionVisibleForMessageRoute(normalizedSessionId, { hydrateMessages: false });
            if (!currentness.isCurrent() || hydration.kind !== 'available') return { status: 'not_ready' };
            session = storage.getState().sessions[normalizedSessionId] ?? null;
        }
        if (!session || !currentness.isCurrent()) return { status: 'not_ready' };

        const admittedSession = session;
        return await this.withSessionTranscriptRead<FetchUserMessageHistoryPageResult>(normalizedSessionId, async read => {
        let session: Session | null = admittedSession;
        if (session.encryptionMode !== 'plain' && !read.encryption?.getSessionEncryption(normalizedSessionId)) {
            const hydration = await this.ensureSessionVisibleForMessageRoute(normalizedSessionId, { hydrateMessages: false });
            if (!read.pageOptions.isCurrent() || hydration.kind !== 'available') return { status: 'not_ready' };
            session = storage.getState().sessions[normalizedSessionId] ?? null;
        }
        if (!session || !read.pageOptions.isCurrent()) return { status: 'not_ready' };
        const result = await fetchUserMessageHistoryPage({
            sessionId: normalizedSessionId,
            beforeSeq: opts.beforeSeq,
            limit: opts.limit,
            ...(opts.turnProjection === true ? { turnProjection: true } : {}),
            sessionEncryptionMode: session?.encryptionMode === 'plain' ? 'plain' : 'e2ee',
            request: read.request,
            getSessionEncryption: (id) => read.encryption?.getSessionEncryption(id) ?? null,
        });
        return read.pageOptions.isCurrent() ? result : { status: 'not_ready' };
        });
    }

    /**
     * Export the per-session data key for UI-assisted resume (dataKey mode only).
     * Returns null when the session uses legacy encryption or the key is unavailable.
     */
    public getSessionEncryptionKeyBase64ForResume(sessionId: string): string | null {
        const key = this.sessionDataKeys.get(sessionId);
        if (!key) return null;
        return encodeBase64(key, 'base64');
    }

    /**
     * Get the decrypted per-session data encryption key (DEK) if available.
     *
     * @remarks
     * This is intentionally in-memory only; it returns null if the session key
     * hasn't been fetched/decrypted yet.
     */
    public getSessionDataKey(sessionId: string): Uint8Array | null {
        const key = this.sessionDataKeys.get(sessionId);
        if (!key) return null;
        // Defensive copy (callers should treat keys as immutable).
        return new Uint8Array(key);
    }

    public refreshMachines = async (params?: Readonly<{ serverId?: string }>) => {
        const serverId = params?.serverId;
        if (serverId && !areServerProfileIdentifiersEquivalent(serverId, this.getAppliedTransportTarget()?.serverId ?? '')) {
            const { refreshConcurrentMachineList } = await import('./runtime/orchestration/concurrentSessionCache');
            if (!await refreshConcurrentMachineList(serverId)) throw new Error('machine_inventory_unavailable');
            return;
        }
        return this.fetchMachines();
    }

      public retryNow = () => {
          if (isEmbedWindowContext() && !this.embedSessionScope) return;
          this.manualResumeGeneration += 1;
          const manualGeneration = this.manualResumeGeneration;
          const scopeIsCurrent = this.createServerScopeGuard();
          const supersededResume = this.resumeInFlight;
          this.resumeWaitController?.abort();
          abortServerFetches('manual-retry', { readOnly: true });
          let reconnectSocket = false;
          try {
              storage.getState().clearSyncError();
              this.userRequestLeaseOwner.cancelDeferredRoutineTeardown();
              this.disconnectSocketIntentionally({ preserveHttpRequests: true });
              reconnectSocket = true;
          } catch {
              // ignore
          }
          try {
              if (!this.embedSessionScope) fireAndForget(invalidateAllServerReachabilitySupervisors(), {
                  tag: 'Sync.invalidateAllServerReachabilitySupervisors.manual',
              });
          } catch {
              // ignore
          }
          // The old run must release its own dedupe slot and shared sync units
          // before the replacement enters. Never detach an unresolved resume.
          const startManualResume = () => {
              if (!scopeIsCurrent() || this.manualResumeGeneration !== manualGeneration) return;
              // This fresh census consumes wakes queued before it entered. Wakes
              // during the new run retain their ordinary trailing callback.
              this.changesCatchUpQueuedAfterResume = false;
              return this.resumeSync('manual');
          };
          // Register directly on the old run before reconnect can queue a wake.
          // An extra rejection-recovery hop lets that wake take the dedupe slot
          // and silently replace manual-only hydration with incremental catch-up.
          const resume = supersededResume
              ? supersededResume.then(startManualResume, startManualResume)
              : Promise.resolve(startManualResume());
          fireAndForget(resume, { tag: 'Sync.resumeSync.manual' });
          if (reconnectSocket) {
              try {
                  this.connectSocketWithPostSubscriptionCatchUp();
              } catch {
                  // The manual HTTP resume remains active; the next successful connection will
                  // consume the armed post-subscription catch-up demand.
              }
          }
      }

      private requestChangesCatchUp = (): void => {
          if (isEmbedWindowContext() && !this.embedSessionScope) return;
          if (!this.isForeground) return;
          const activeResume = this.resumeInFlight;
          if (!activeResume) {
              fireAndForget(this.resumeSync('changes-catch-up'), { tag: 'Sync.resumeSync.changes-catch-up' });
              return;
          }

          // A wake can arrive after the active resume has consumed its final
          // changes page but before its outer cleanup releases this in-flight
          // slot. Preserve one level-triggered follow-up through the same
          // cursor owner; reset clears it with the Account lifetime.
          if (this.changesCatchUpQueuedAfterResume) return;
          this.changesCatchUpQueuedAfterResume = true;
          const scopeIsCurrent = this.createServerScopeGuard();
          const manualGeneration = this.manualResumeGeneration;
          const isCurrent = () => scopeIsCurrent() && this.manualResumeGeneration === manualGeneration;
          void activeResume.then(
              () => { if (isCurrent()) this.runQueuedChangesCatchUp(); },
              () => { if (isCurrent()) this.runQueuedChangesCatchUp(); },
          );
      };

      private runQueuedChangesCatchUp = (): void => {
          if (!this.changesCatchUpQueuedAfterResume) {
              return;
          }
          this.changesCatchUpQueuedAfterResume = false;
          this.requestChangesCatchUp();
      };

      public resumeSync = (reason: 'app-foreground' | 'socket-reconnect' | 'changes-catch-up' | 'manual' | 'server-reachable'): Promise<void> => {
          return runWithInFlightDedupe(
              {
                  get: () => this.resumeInFlight,
                  set: (value) => {
                      this.resumeInFlight = value;
                  },
              },
              async () => {
                  if (isEmbedWindowContext() && !this.embedSessionScope) return;
                  const scopeIsCurrent = this.createServerScopeGuard();
                  const manualGeneration = this.manualResumeGeneration;
                  const shouldContinue = () => scopeIsCurrent()
                      && this.manualResumeGeneration === manualGeneration
                      && !this.pauseController.isPaused();
                  if ((reason === 'socket-reconnect' || reason === 'changes-catch-up' || reason === 'server-reachable') && !this.isForeground) {
                      return;
                  }
                  if (this.pauseController.isPaused()) {
                      return;
                  }
                  await this.pauseController.waitUntilResumed();
                  if (!shouldContinue()) {
                      return;
                  }
                  if (!this.credentials) {
                      return;
                  }
                  const waitController = new AbortController();
                  this.resumeWaitController = waitController;
                  const signal = waitController.signal;
                  try {
                  // Startup reachability and subscription wakes use the same
                  // foreground acquisition as bootstrap before draft/cursor
                  // recovery can compete for list or key-opening work.
                  await this.bootstrapForegroundReady;
                  if (!shouldContinue()) return;
                  if (this.embedSessionScope) {
                      const outcome = await this.resumeViaChanges({ accountId: this.serverID, shouldContinue, signal });
                      if (outcome.status === 'fallback' && shouldContinue()) await this.snapshotRefreshOnResume({mode:'fallback',reason,shouldContinue,signal});
                      return;
                  }
                  const forceSessionSystemRecordRefresh = reason === 'socket-reconnect'
                      || reason === 'server-reachable'
                      || reason === 'manual';
                  if (forceSessionSystemRecordRefresh || reason === 'app-foreground') {
                      // Resume withdraws stale observations, not the Account's
                      // encryption identity. Finite operations re-read through
                      // their currentness owner with their original credentials.
                      invalidateAccountEncryptionModeCache({
                          serverId: this.getAppliedTransportTarget()?.serverId,
                          reason: 'transport-withdrawal',
                      });
                  }
                  const sessionSystemRecordRefreshScope = getActiveServerAccountScope();
                  for (const repository of this.sessionSystemRecordRepositories.values()) {
                      repository.refreshObserved(
                          forceSessionSystemRecordRefresh
                          && areServerAccountScopesEqual(sessionSystemRecordRefreshScope, repository.scope)
                              ? { force: true }
                              : undefined,
                      );
                  }

                  if (reason !== 'changes-catch-up') {
                      await this.refreshSessionDraftRepositoryForSync({
                          // Durable changes repair missed draft pushes by address. A
                          // full census is only needed for explicit refresh or an
                          // earlier snapshot that could not open every Session.
                          forceSnapshotHydration: reason === 'manual' || this.sessionDraftSnapshotIncomplete,
                      });
                      if (!shouldContinue()) return;
                  }

                  let accountId = storage.getState().profile?.id ?? null;
                  if (!accountId) {
                      this.profileSync.invalidateCoalesced();
                      await this.profileSync.awaitQueue({ timeoutMs: this.syncTuning.resumeQuickInvalidateTimeoutMs, signal });
                      accountId = storage.getState().profile?.id ?? null;
                  }

                  if (!accountId) {
                      if (!shouldContinue()) {
                          return;
                      }
                      await this.snapshotRefreshOnResume({ mode: 'fallback', reason: 'missing-profile', shouldContinue, signal });
                      return;
                  }

                  if (reason !== 'changes-catch-up') {
                      await this.rearmPendingOutboxForActiveScope();
                      if (!shouldContinue()) {
                          return;
                      }
                  }

                  if (reason !== 'changes-catch-up') this.metadataUpgradeDiscovery.requestRefresh();
                  const { status, refreshedByCatchUp } = await this.resumeViaChanges({
                      accountId,
                      shouldContinue,
                      signal,
                      allowOfflineSnapshotRefresh: reason !== 'changes-catch-up',
                  });
                  if (!shouldContinue()) return;
                  if (status === 'aborted') {
                      return;
                  }
                  if (status === 'fallback') {
                      if (!shouldContinue()) {
                          return;
                      }
                      await this.snapshotRefreshOnResume({ mode: 'fallback', reason: 'changes-fallback', shouldContinue, signal });
                      return;
                  }

                  if (reason === 'changes-catch-up') {
                      return;
                  }

                  await this.refreshSessionMetadataUpgrades();

                  if (!shouldContinue()) {
                      return;
                  }
                  await this.catchUpLoadedExternalSessionsOnResume();
                  if (!shouldContinue()) {
                      return;
                  }

                  const invalidateBounded = async (syncUnit: InvalidateSync, timeoutMs: number): Promise<void> => {
                      if (!shouldContinue()) {
                          return;
                      }
                      syncUnit.invalidateCoalesced();
                      await syncUnit.awaitQueue({ timeoutMs, signal });
                  };

                  // Activity/presence updates are delivered via ephemerals and are not recovered for the window in
                  // which the socket was down. Gate this on measured socket downtime rather than the resume
                  // reason: a background→foreground cycle disconnects the socket intentionally, and an intentional
                  // disconnect resets apiSocket's reconnect bookkeeping (`hasConnectedOnce` /
                  // `pendingReconnectNotification`), so `socket-reconnect` never fires for it. Gating on the reason
                  // left a resuming client with stale session.active and machine-online state until the next
                  // keep-alive ephemeral (0–20s).
                  //
                  // Skip whatever the changes catch-up already refreshed in this same resume: it runs the identical
                  // full refresh (session-organization + sessions/active + /v2/sessions?includeAttention,
                  // /v1/machines) and its session refresh awaits hydration, so repeating it here fires a second
                  // complete catch-up wave once that hydration finishes.
                  if (this.readSocketOfflineDurationMs() > 0) {
                      const offlineRecoveryTasks: Array<() => Promise<void>> = [];
                      if (!refreshedByCatchUp.sessions) {
                          offlineRecoveryTasks.push(
                              () => invalidateBounded(this.sessionsSync, this.syncTuning.resumeQuickInvalidateTimeoutMs),
                          );
                      }
                      if (!refreshedByCatchUp.machines) {
                          offlineRecoveryTasks.push(
                              () => invalidateBounded(this.machinesSync, this.syncTuning.resumeQuickInvalidateTimeoutMs),
                          );
                      }
                      if (offlineRecoveryTasks.length > 0) {
                          await runTasksWithLimit(offlineRecoveryTasks, this.syncTuning.resumeConcurrencyLimit);
                      }
                  }

                    await runTasksWithLimit(
                        [
                            () => invalidateBounded(this.purchasesSync, this.syncTuning.resumeQuickInvalidateTimeoutMs),
                            () => invalidateBounded(this.nativeUpdateSync, this.syncTuning.resumeQuickInvalidateTimeoutMs),
                        ],
                        this.syncTuning.resumeConcurrencyLimit
                    );
                  } catch (error) {
                      if (shouldContinue() || !(error instanceof SupersededOperationError
                          || error instanceof StaleServerGenerationError)) throw error;
                  } finally {
                      if (this.resumeWaitController === waitController) this.resumeWaitController = null;
                  }
                }
            );
        };

      private reportSyncError = (error: unknown): void => {
          storage.getState().setSyncError({
              message: error instanceof Error ? error.message : String(error),
              retryable: shouldRetryError(error),
              kind: error instanceof HappyError && error.kind ? error.kind : 'unknown',
              at: Date.now(),
          });
      };

      /** Background content owners share the routed Session's existing startup phase. */
      public awaitBootstrapForegroundAcquisition = async (): Promise<boolean> => {
          const generation = this.serverScopeGeneration;
          const credentials = this.credentials;
          await this.bootstrapForegroundReady;
          return this.serverScopeGeneration === generation && this.credentials === credentials;
      };

      private bootstrapSync = async (): Promise<void> => {
          const embedScope = this.embedSessionScope;
          const generation = this.serverScopeGeneration;
          const credentials = this.credentials;
          await this.pauseController.waitUntilResumed();
          if (!this.credentials || this.credentials !== credentials || this.serverScopeGeneration !== generation) {
              return;
          }
          if (embedScope) {
              if (this.embedSessionScope !== embedScope || !embedScope.isCurrent()) return;
              const snapshot = await observePublicServerFeaturesFresh({ request: embedScope.request });
              if (this.embedSessionScope !== embedScope || !embedScope.isCurrent()) return;
              this.embedFeaturesSnapshot = snapshot;
              primeServerFeaturesSnapshot({ serverId: embedScope.endpointUrl, snapshot });
              const cursor = await fetchCurrentChangesCursor({ credentials: this.credentials, request: embedScope.request });
              if (this.embedSessionScope !== embedScope || !embedScope.isCurrent()) return;
              if (cursor.status === 'ok') this.changesCursor = cursor.cursor;
              await this.refreshEmbedSessionSnapshot();
              // Approval decisions have their own authority. Keep their pushed
              // inventory fresh without withholding Session input admission.
              embedScope.approvalsSync.invalidateCoalesced();
              if (this.embedSessionScope === embedScope && embedScope.isCurrent()) {
                  storage.getState().applyReady();
                  this.markSessionDraftsReady();
              }
              return;
          }
          if (isEmbedWindowContext()) return;
          const refreshedServerId = this.getAppliedTransportTarget()?.serverId ?? '';
          if (refreshedServerId) publishHomeAccountChange(refreshedServerId);

          // Settings supplies the client encryption requirement and imports legacy
          // organization rows before Sessions reads its pinned hydration snapshot.
          // A failed attempt exposes the shell/error immediately; its queue keeps
          // recovering. Sessions still waits for applied Settings after a failure.
          const isCurrent = () => this.serverScopeGeneration === generation && this.credentials === credentials;
          const settingsReady = this.settingsSync.invalidateAndAwait({ settleOnFirstAttempt: true });
          // Settings owns the client encryption requirement. Once it has
          // applied, start the demanded route through the existing coalesced
          // exact reader while Profile/root admission can still be pending.
          const routeReady = settingsReady.then(async () => {
              if (!isCurrent()) return;
              const route = getRouteAnchorSessionAddress();
              if (!route) return;
              await this.ensureSessionVisibleForMessageRoute(route.sessionId, {
                  serverId: route.serverId, hydrateMessages: false,
              });
          }, () => undefined).catch((error) => {
              // Foreground failure uses the existing error/retry projection;
              // it must not retire unrelated inventory or recovery queues.
              if (isCurrent()) this.reportSyncError(error);
          });
          // Bootstrap, mounted list queries, viewport demand and reconnect
          // recovery share one phase. Profile/core readiness stays independent.
          this.bootstrapForegroundReady = routeReady;
          void routeReady.then(() => {
              if (this.bootstrapForegroundReady === routeReady) this.bootstrapForegroundReady = null;
          });
          try {
              await Promise.all([
                  settingsReady,
                  this.profileSync.invalidateAndAwait({ settleOnFirstAttempt: true }),
              ]);
          } catch (error) {
              if (!isCurrent()) return;
              // The existing error projection is the first-render failure path;
              // queue drainage or a timeout must never impersonate settled core.
              this.reportSyncError(error);
          }
          if (!isCurrent()) return;
          storage.getState().applyReady();

          // Workspace restoration admits the route that demands its exact
          // Session. The Account inventory must neither delay that admission
          // nor compete with Settings/Profile before it. Its existing queue
          // still owns recovery, including a failed Settings first attempt.
          fireAndForget((async () => {
              try {
                  await settingsReady;
              } catch {
                  if (!isCurrent()) return;
                  await this.settingsSync.invalidateAndAwait();
              }
              if (!isCurrent()) return;
              await routeReady;
              if (!isCurrent()) return;
              await this.sessionsSync.invalidateAndAwait({ settleOnFirstAttempt: true });
          })(), {
              tag: 'Sync.bootstrapSessions',
              onError: (error) => { if (isCurrent()) this.reportSyncError(error); },
          });

          // The route's key and content must not queue behind unrelated Machine,
          // draft, or list crypto after its transport responds. Core readiness
          // remains independent; only background acquisition yields to demand.
          await routeReady;
          if (!isCurrent()) return;

          // Bootstrap can also run during reconnect recovery. The existing
          // admitted Account lifetime owns exactly one retained-row attempt.
          const backfillLifetime = captureActiveServerAccountScopeLifetime();
          if (backfillLifetime && this.managedTargetBackfillLifetime !== backfillLifetime) {
              this.managedTargetBackfillLifetime = backfillLifetime;
              // The existing reader applies the canonical Automation decision before
              // delivering its current response. Complete known rows prove no work;
              // an incomplete page cannot prove anything about the unobserved tail.
              this.consumeBootstrapAutomationPage = page => {
                  if (!backfillLifetime.isCurrent()) return;
                  if (page.nextCursor === null && page.automations.every(row => row.managedTarget !== undefined)) return;
                  fireAndForget(import('@/sync/engine/automations/backfillAutomationManagedTargets')
                      .then(({ backfillAutomationManagedTargetsForAccount }) => backfillAutomationManagedTargetsForAccount(backfillLifetime)), {
                      tag: 'Sync.automationManagedTargetBackfill',
                      logError: false,
                  });
              };
          }

          // Each peripheral publishes its own loading/error state. These queues
          // and independent lists never wait for whole-Account draft recovery.
          for (const syncUnit of [
              this.accountPetsSync, this.machinesSync, this.artifactsSync,
              this.pluginAvailabilitySync, this.purchasesSync,
              this.todosSync, this.friendsSync, this.friendRequestsSync,
              this.feedSync, this.nativeUpdateSync,
          ]) syncUnit.invalidateCoalesced();
          this.requestAutomationsRefresh();

          await this.refreshSessionDraftRepositoryForSync();
          if (this.serverScopeGeneration !== generation || this.credentials !== credentials) return;
          // Recovery retains its draft-before-outbox ordering without delaying
          // unrelated workspace presentation.
          await this.rearmPendingOutboxForActiveScope();
          if (this.serverScopeGeneration !== generation || this.credentials !== credentials) return;

        };

      private snapshotRefreshOnResume = async (opts: {
          mode: 'fallback' | 'long-offline';
          reason: string;
          shouldContinue?: () => boolean;
          signal?: AbortSignal;
      }): Promise<{ status: 'complete' | 'error' }> => {
          if (this.pauseController.isPaused()) {
              return { status: 'error' };
          }
          const credentials = this.credentials;
          const scopeIsCurrent = this.createServerScopeGuard();
          const manualGeneration = this.manualResumeGeneration;
          const isCurrent = () => scopeIsCurrent() && this.credentials === credentials
              && this.manualResumeGeneration === manualGeneration
              && (opts.shouldContinue?.() ?? true) && !this.pauseController.isPaused();
          await this.pauseController.waitUntilResumed();
          if (!credentials || !isCurrent()) {
              return { status: 'error' };
          }
          const embedScope = this.embedSessionScope;
          if (embedScope) {
              await this.refreshEmbedSessionSnapshot();
              return { status: isCurrent() && this.embedSessionScope === embedScope && embedScope.isCurrent() ? 'complete' : 'error' };
          }
          if (isEmbedWindowContext()) return { status: 'error' };
          this.metadataUpgradeDiscovery.invalidate();
          const refreshedServerId = this.getAppliedTransportTarget()?.serverId ?? '';
          if (refreshedServerId) publishHomeAccountChange(refreshedServerId, undefined, { source: 'snapshot' });

          const invalidateBounded = async (syncUnit: InvalidateSync, timeoutMs: number) => {
              if (!isCurrent()) return { status: 'stopped' } as const;
              try {
                  return await syncUnit.invalidateAndAwait({ timeoutMs, signal: opts.signal });
              } catch (error) {
                  if (error instanceof SupersededOperationError && !isCurrent()) return { status: 'stopped' } as const;
                  throw error;
              }
          };

          const concurrencyLimit = this.syncTuning.resumeConcurrencyLimit;

          // Rebuild core lists first (sessions drives most downstream state).
          const core = await runTasksWithLimit(
              [
                  () => invalidateBounded(this.sessionsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.machinesSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.pluginAvailabilitySync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
              ],
              concurrencyLimit
          );
          if (!isCurrent() || core.some(outcome => outcome.status !== 'completed')) return { status: 'error' };

          await this.refreshSessionDraftRepositoryForSync({ forceSnapshotHydration: true });
          if (!isCurrent()) return { status: 'error' };

          // Catch up live transcript consumers, including a first read that failed while offline.
          // Hidden sessions keep their transcript state until they become visible or otherwise active.
          const activeTranscriptSessionIds: string[] = [];
          try {
              const sessions = storage.getState().sessions;
              for (const sessionId of Object.keys(sessions)) {
                  if (resolveSessionLiveConsumption(sessionId).isFullContentConsumer) {
                      activeTranscriptSessionIds.push(sessionId);
                  }
              }
          } catch {
              // ignore
          }

          const transcripts = await runTasksWithLimit(
              activeTranscriptSessionIds.map((sessionId) => async () => {
                  const outcome = await invalidateBounded(this.getOrCreateMessagesSync(sessionId), this.syncTuning.invalidateSyncAwaitTimeoutMs);
                  if (isCurrent() && outcome.status === 'completed') scmStatusSync.invalidate(sessionId);
                  return outcome;
              }),
              this.syncTuning.messageCatchUpConcurrencyLimit
          );
          if (!isCurrent() || transcripts.some(outcome => outcome.status !== 'completed')) return { status: 'error' };

          // Refresh the rest with bounded concurrency.
          const remaining = await runTasksWithLimit(
              [
                  () => invalidateBounded(this.artifactsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => {
                      if (isCurrent()) this.automationRunRefreshPending = true;
                      return invalidateBounded(this.automationsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs);
                  },
                  () => invalidateBounded(this.todosSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.friendsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.friendRequestsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.feedSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.settingsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.profileSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.accountPetsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
              ],
              concurrencyLimit
          );
          return { status: isCurrent() && remaining.every(outcome => outcome.status === 'completed') ? 'complete' : 'error' };
      };

    public refreshMachinesThrottled = async (params?: { staleMs?: number; force?: boolean }) => {
        if (!this.credentials) return;
        const staleMs = params?.staleMs ?? 30_000;
        const force = params?.force ?? false;
        const now = Date.now();

        if (!force && (now - this.lastMachinesRefreshAt) < staleMs) {
            return;
        }

        if (this.machinesRefreshInFlight) {
            return this.machinesRefreshInFlight;
        }

        this.machinesRefreshInFlight = this.fetchMachines()
            .then(() => {
                this.lastMachinesRefreshAt = Date.now();
            })
            .finally(() => {
                this.machinesRefreshInFlight = null;
            });

        return this.machinesRefreshInFlight;
    }

    public refreshSessions = async (options?: Readonly<{ awaitSessionListHydration?: boolean }>) => {
        if (options?.awaitSessionListHydration === true) {
            return this.fetchSessions({ awaitSessionListHydration: true, discoverMetadataUpgrades: true });
        }
        this.metadataUpgradeDiscovery.requestRefresh();
        return this.sessionsSync.invalidateAndAwait();
    }

    /**
     * Generic session metadata patching surface for feature modules that need to
     * atomically update the canonical metadata tuple.
     */
    public patchSessionMetadataWithRetry = async (
        sessionId: string,
        updater: SessionMetadataUpdateRequest<Metadata>,
        options?: Readonly<{
            serverId?: string | null;
            maxAttempts?: number;
            sessionExpectation?:
                SessionMetadataInactiveModelIntentExpectationV1;
            teamCredentialBinding?: SessionMetadataTeamCredentialBinding;
            mutationIntent?: 'rename_session';
            expectedMetadataRevision?: number;
            onMetadataCommitted?: (revision: number) => void;
            accountLifetime?: Pick<ServerAccountScopeLifetime, 'scope' | 'isCurrent'>;
            shouldContinue?: () => boolean;
        }>,
    ): Promise<void> => {
        const targetServerId = options?.accountLifetime?.scope.serverId ?? options?.serverId?.trim();
        if (!targetServerId) {
            await this.updateSessionMetadataWithRetry(sessionId, updater, options);
            return;
        }
        const lifetime = options?.accountLifetime;
        if (
            lifetime && (!lifetime.isCurrent()
            || (options?.serverId
                && !areServerProfileIdentifiersEquivalent(options.serverId, lifetime.scope.serverId))
            )
        ) {
            throw Object.assign(new Error('Session Account authority retired during metadata update'), {
                code: 'session_account_scope_retired',
            });
        }
        await runWithHomeCredentialRequestSignal(targetServerId, async credentialSignal => {
        await runWithServerRequestAuthorityForServerAccountScope({
            ...(lifetime ? { scope: lifetime.scope } : { serverId: targetServerId }),
            activeRequest: this.createSessionRequest(sessionId),
        }, async (authority) => {
            const isCurrent = () => !credentialSignal.aborted
                && (!lifetime || (lifetime.isCurrent()
                    && areServerAccountScopesEqual(authority.scope, lifetime.scope)));
            const fencedAuthority: ServerAccountRequestAuthority = {
                ...authority,
                request: async (path, init) => {
                    if (!isCurrent()) throw Object.assign(new Error('Session Account authority retired during metadata update'), {
                        code: 'session_account_scope_retired',
                    });
                    const response = await authority.request(path, init);
                    if (!isCurrent()) throw Object.assign(new Error('Session Account authority retired during metadata update'), {
                        code: 'session_account_scope_retired',
                    });
                    return response;
                },
            };
            await this.updateSessionMetadataWithRetry(sessionId, updater, {
                ...options,
                serverId: authority.scope.serverId,
                accountLifetime: { scope: authority.scope, isCurrent },
                authority: fencedAuthority,
            });
        });
        });
    }

    /**
     * The owner's explicit request to move one historical (layout-0) Session to
     * the canonical owner/shared tuple without changing its content (PA-L2), so
     * the people it is shared with can read its shared projection. It runs the
     * same tuple owner, CAS and exact-Account fencing as any owner metadata edit;
     * an already-migrated Session commits nothing.
     */
    public migrateSessionMetadataOwnerLayout = async (
        sessionId: string,
        options?: Readonly<{
            serverId?: string | null;
            accountLifetime?: Pick<ServerAccountScopeLifetime, 'scope' | 'isCurrent'>;
        }>,
    ): Promise<void> => {
        await this.patchSessionMetadataWithRetry(sessionId, 'ownerMigration', options);
    }

    public refreshAutomations = async () => {
        return this.refreshAutomationsAndAwait();
    }

    private requestAutomationsRefresh(options?: AutomationRefreshOptions, coalesced = false): void {
        if (!options?.summariesOnly) this.automationRunRefreshPending = true;
        // A Run wake during a summary-only HTTP read requires the existing trailing
        // pass; coalescing it into that weaker read would silently lose freshness.
        if (coalesced && options?.summariesOnly) this.automationsSync.invalidateCoalesced();
        else this.automationsSync.invalidate();
    }

    private refreshAutomationsAndAwait(options?: AutomationRefreshOptions, signal?: AbortSignal): Promise<void> {
        if (!options?.summariesOnly) this.automationRunRefreshPending = true;
        return this.automationsSync.invalidateAndAwait({ signal });
    }

    /**
     * Continue the one Account-scoped Automation definition window. The
     * store's exact-cursor-and-traversal writer rejects a response if
     * refresh/account movement replaced that continuation while this request
     * was in flight.
     */
    public loadMoreAutomations = async (expectedCursor: string): Promise<{ nextCursor: string | null }> => {
        const { requestContext, shouldContinue } = this.prepareAppliedAutomationExecution();
        const expectedTraversalToken = this.automationDefinitionTraversalToken;
        const result = await fetchAndApplyAutomations({
            credentials: this.credentials,
            cursor: expectedCursor,
            traversalToken: expectedTraversalToken ?? undefined,
            requestContext,
            shouldContinue,
            applyAutomations: (automations, nextCursor) =>
                storage.getState().applyAutomations(automations, nextCursor),
            appendAutomations: (cursor, traversalToken, automations, nextCursor) =>
                storage.getState().appendAutomations(cursor, traversalToken, automations, nextCursor),
        });
        if (this.automationDefinitionTraversalToken === expectedTraversalToken) {
            this.automationDefinitionTraversalToken = result.traversalToken;
        }
        return { nextCursor: result.nextCursor };
    }

    /** Account-scoped Automation settings stay direct: their server owner is not another UI cache. */
    public async getAutomationSettings(): Promise<AutomationV3Settings> {
        const credentials = this.credentials;
        if (!credentials) {
            throw new Error('Not authenticated');
        }
        const { requestContext, shouldContinue } = this.prepareAppliedAutomationExecution();
        const settings = await getAutomationSettings(credentials, requestContext);
        if (!shouldContinue()) {
            throw new Error('Automation server-account scope changed');
        }
        return settings;
    }

    /** The server validates and owns the complete Automation settings record. */
    public async updateAutomationSettings(input: AutomationV3Settings): Promise<AutomationV3Settings> {
        const credentials = this.credentials;
        if (!credentials) {
            throw new Error('Not authenticated');
        }
        const { requestContext, shouldContinue } = this.prepareAppliedAutomationExecution();
        const settings = await updateAutomationSettings(credentials, input, requestContext);
        if (!shouldContinue()) {
            throw new Error('Automation server-account scope changed');
        }
        return settings;
    }

    /**
     * Clear-history keeps server eligibility authoritative, then re-seeds the
     * incumbent first Run window so active/non-eligible rows remain visible.
     */
    public async clearAutomationRunHistory(automationId: string): Promise<AutomationV3ClearRunHistoryResponse> {
        const credentials = this.credentials;
        if (!credentials) {
            throw new Error('Not authenticated');
        }
        const { requestContext, shouldContinue } = this.prepareAppliedAutomationExecution();
        const result = await clearAutomationRunHistory(credentials, automationId, requestContext);
        if (!shouldContinue()) {
            throw new Error('Automation server-account scope changed');
        }
        await this.fetchAutomationRuns(automationId);
        if (!shouldContinue()) {
            throw new Error('Automation server-account scope changed');
        }
        return result;
    }

    public async fetchAutomationRuns(
        automationId: string,
        limit: number = 20,
        cursor?: string,
    ): Promise<{ nextCursor: string | null }> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const { requestContext, shouldContinue } = this.prepareAppliedAutomationExecution();
        const expectedTraversalToken = cursor
            ? this.automationRunTraversalTokensByAutomationId.get(automationId) ?? null
            : null;
        const result = await fetchAndApplyAutomationRuns({
            credentials: this.credentials,
            automationId,
            limit,
            cursor,
            traversalToken: expectedTraversalToken ?? undefined,
            requestContext,
            shouldContinue,
            setAutomationRuns: (id, runs, nextCursor) => storage.getState().setAutomationRuns(id, runs, nextCursor),
            appendAutomationRuns: (id, expectedCursor, traversalToken, runs, nextCursor) =>
                storage.getState().appendAutomationRuns(id, expectedCursor, traversalToken, runs, nextCursor),
        });
        if (!shouldContinue()) {
            return { nextCursor: result.nextCursor };
        }
        if (cursor && this.automationRunTraversalTokensByAutomationId.get(automationId) !== expectedTraversalToken) {
            return { nextCursor: result.nextCursor };
        }
        if (result.traversalToken === null) {
            this.automationRunTraversalTokensByAutomationId.delete(automationId);
        } else {
            this.automationRunTraversalTokensByAutomationId.set(automationId, result.traversalToken);
        }
        return { nextCursor: result.nextCursor };
    }

    public async replaceAutomationAssignments(
        automationId: string,
        assignments: ReadonlyArray<import('@happier-dev/protocol').AutomationAssignmentInput>,
    ): Promise<AutomationDefinition> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const { requestContext, shouldContinue } = this.prepareAppliedAutomationExecution();
        const updated = await replaceAutomationDefinitionAssignments(this.credentials, automationId, assignments, requestContext);
        return this.projectAndUpsertAutomationDefinition(updated, shouldContinue, { replaceEqualRevision: true });
    }

    public async pauseAutomation(automationId: string): Promise<AutomationDefinition> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const { requestContext, shouldContinue } = this.prepareAppliedAutomationExecution();
        const currentBeforeRequest = storage.getState().automations[automationId] ?? null;
        const updated = await pauseAutomationDefinition(this.credentials, automationId, requestContext);
        if (!shouldContinue()) {
            throw new Error('Automation server-account scope changed');
        }
        const currentAfterRequest = storage.getState().automations[automationId] ?? null;
        if (currentAfterRequest && currentAfterRequest !== currentBeforeRequest) {
            return currentAfterRequest;
        }
        return this.projectAndUpsertAutomationDefinition(updated, shouldContinue, { replaceEqualRevision: true });
    }

    public async resumeAutomation(automationId: string): Promise<AutomationDefinition> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const { requestContext, shouldContinue } = this.prepareAppliedAutomationExecution();
        const currentBeforeRequest = storage.getState().automations[automationId] ?? null;
        const updated = await resumeAutomationDefinition(this.credentials, automationId, requestContext);
        if (!shouldContinue()) {
            throw new Error('Automation server-account scope changed');
        }
        const currentAfterRequest = storage.getState().automations[automationId] ?? null;
        if (currentAfterRequest && currentAfterRequest !== currentBeforeRequest) {
            return currentAfterRequest;
        }
        return this.projectAndUpsertAutomationDefinition(updated, shouldContinue, { replaceEqualRevision: true });
    }

    /** Direct private read for a route/editor; list refreshes intentionally never call this. */
    public async refreshAutomationDefinitionDetail(automationId: string): Promise<AutomationDefinition | null> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const { requestContext, shouldContinue } = this.prepareAppliedAutomationExecution();
        try {
            return await this.readAndUpsertAutomationDefinition(automationId, requestContext, shouldContinue);
        } catch (error) {
            if (!isAutomationApiErrorCode(error, 'automation_stored_content_unavailable') || !shouldContinue()) {
                throw error;
            }
            const current = storage.getState().automations[automationId];
            if (!current) {
                return null;
            }
            const unavailable = markAutomationDefinitionContentUnavailable(current);
            storage.getState().upsertAutomation(unavailable);
            return unavailable;
        }
    }

    /** Opens exactly one saved Event for its active editor; Account key/currentness stays Sync-owned. */
    public async getAutomationPluginEventEditSeed(automationId: string, triggerId: string): Promise<PluginEventAutomationEditSeed | null> {
        const credentials = this.credentials;
        if (!credentials) throw new Error('Not authenticated');
        const { requestContext, shouldContinue } = this.prepareAppliedAutomationExecution();
        const definition = await this.readAndUpsertAutomationDefinition(automationId, requestContext, shouldContinue);
        if (!shouldContinue()) throw new Error('Automation server-account scope changed');
        let accountCurrentness: Awaited<ReturnType<typeof fetchAccountEncryptionCurrentness>>;
        try {
            accountCurrentness = await fetchAccountEncryptionCurrentness(credentials, {
                request: (path, init) => requestContext.request(path, init, { includeAuth: false }),
            });
        } catch {
            if (!shouldContinue()) throw new Error('Automation server-account scope changed');
            return null;
        }
        if (!shouldContinue()) throw new Error('Automation server-account scope changed');
        const material = resolveAutomationRunDetailAccountMaterial({ credentials, accountCurrentness });
        if (material.kind !== 'available') return null;
        const seed = readPluginEventAutomationEditSeed(definition, triggerId, {
            mode: accountCurrentness.mode,
            ...(material.material ? { material: material.material } : {}),
        });
        if (!shouldContinue()) throw new Error('Automation server-account scope changed');
        return seed;
    }

    private async readAndUpsertAutomationDefinition(
        automationId: string,
        requestContext: AutomationRequestContext,
        shouldContinue: () => boolean,
    ): Promise<AutomationDefinition> {
        const credentials = this.credentials;
        if (!credentials) {
            throw new Error('Not authenticated');
        }
        const detail = await getAutomationDefinition(credentials, automationId, requestContext);
        return this.projectAndUpsertAutomationDefinition(detail, shouldContinue);
    }

    private async projectAndUpsertAutomationDefinition(
        detail: import('@happier-dev/protocol').AutomationDefinitionDetail,
        shouldContinue: () => boolean,
        options: Readonly<{ replaceEqualRevision?: boolean }> = {},
    ): Promise<AutomationDefinition> {
        if (!shouldContinue()) {
            throw new Error('Automation server-account scope changed');
        }
        const current = storage.getState().automations[detail.id];
        const projected = applyAutomationDefinitionDetail(current, detail, options);
        if (projected === current) {
            return current;
        }
        const linked = projectAutomationDefinitionSessionLink({ automation: projected });
        if (!shouldContinue()) {
            throw new Error('Automation server-account scope changed');
        }
        const currentAfterLinkResolution = storage.getState().automations[detail.id];
        if (current && !currentAfterLinkResolution) {
            return linked;
        }
        const rechecked = applyAutomationDefinitionDetail(currentAfterLinkResolution, detail, options);
        if (rechecked === currentAfterLinkResolution) {
            return currentAfterLinkResolution;
        }
        const recheckedWithLink = {
            ...rechecked,
            linkedExistingSessionId: (
                rechecked.id === linked.id
                && rechecked.templateVersion === linked.templateVersion
                && rechecked.targetType === linked.targetType
            )
                ? linked.linkedExistingSessionId
                : null,
        };
        if (shouldContinue()) {
            storage.getState().upsertAutomation(recheckedWithLink);
        }
        return recheckedWithLink;
    }

    public async deleteAutomation(automationId: string): Promise<void> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const { requestContext, shouldContinue } = this.prepareAppliedAutomationExecution();
        const deleted = await deleteAutomationDefinition(this.credentials, automationId, requestContext);
        if (!shouldContinue()) {
            throw new Error('Automation server-account scope changed');
        }
        storage.getState().removeAutomation(automationId, deleted.removedRevision);
    }

    /** Route-owned occurrence work may target a saved Home without changing active Sync custody. */
    private async prepareAutomationRunExecution(
        options: Readonly<{ accountLifetime?: ServerAccountScopeLifetime | null }>,
    ) {
        const lifetime = options.accountLifetime;
        if (lifetime === undefined) {
            const credentials = this.credentials;
            if (!credentials) throw new Error('Not authenticated');
            const execution = this.prepareAppliedAutomationExecution();
            return {
                ...execution,
                credentials,
                account: null,
                updateActiveCache: true,
                dispose: () => {},
            };
        }
        if (!lifetime?.isCurrent()) throw new Error('Automation server-account scope changed');
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
        try {
            account = await captureLazyActionAccountContext(lifetime.scope.serverId, controller.signal);
            const capturedAccount = account;
            const shouldContinue = () => !controller.signal.aborted && lifetime.isCurrent()
                && capturedAccount.accountLifetime.isCurrent()
                && areServerAccountScopesEqual(lifetime.scope, capturedAccount.accountLifetime.scope);
            if (!shouldContinue()) throw new Error('Automation server-account scope changed');
            return {
                credentials: capturedAccount.credentials,
                requestContext: { request: capturedAccount.request, serverId: capturedAccount.serverId },
                shouldContinue,
                account: capturedAccount,
                // Explicitly scoped details refresh directly; they never install another Home's rows.
                updateActiveCache: false,
                dispose: () => { retirement.dispose(); capturedAccount.dispose(); },
            };
        } catch (error) {
            retirement.dispose();
            account?.dispose();
            throw error;
        }
    }

    /**
     * Opens one direct Run detail for its route only. The exact Account
     * currentness witness and key proof stay on the Sync owner; the resulting
     * private projection is never copied into the bounded Automation Run cache.
     */
    public async getAutomationRunDetailInspection(
        automationId: string,
        runId: string,
        options: Readonly<{ accountLifetime?: ServerAccountScopeLifetime | null }> = {},
    ): Promise<AutomationRunDetailRouteInspection> {
        const execution = await this.prepareAutomationRunExecution(options);
        const { credentials, requestContext, shouldContinue } = execution;
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = execution.account ?? await captureLazyActionAccountContext(requestContext.serverId).catch(() => null);
        try {
            if (!shouldContinue()) throw new Error('Automation server-account scope changed');
            const detail = await getAutomationRunDetail(credentials, automationId, runId, requestContext);
            if (!shouldContinue()) {
                throw new Error('Automation server-account scope changed');
            }

            let accountCurrentness: Awaited<ReturnType<typeof fetchAccountEncryptionCurrentness>>;
            try {
                accountCurrentness = await fetchAccountEncryptionCurrentness(credentials, {
                    request: (path, init) => requestContext.request(path, init, { includeAuth: false }),
                });
            } catch {
                if (!shouldContinue()) {
                    throw new Error('Automation server-account scope changed');
                }
                return {
                    detail,
                    privateContent: createAutomationRunDetailPrivateContentCurrentnessUnavailable(),
                };
            }
            if (!shouldContinue()) {
                throw new Error('Automation server-account scope changed');
            }

            const material = resolveAutomationRunDetailAccountMaterial({
                credentials,
                accountCurrentness,
            });
            let workflowResult: Parameters<typeof inspectAutomationRunDetailPrivateContent>[0]['workflowResult'];
            if (detail.workflowRun && detail.resultEnvelope !== null && account && account.credentials.token === credentials.token) {
                account.assertCurrent();
                const [{ createUiWorkflowAction }, { WorkflowRunGetResultV1Schema }] = await Promise.all([
                    import('@/sync/ops/actions/workflowActionDeps'),
                    import('@happier-dev/protocol/workflows/actionsV1'),
                ]);
                const opened = await createUiWorkflowAction({ account })({ actionId: 'workflow.run.get',
                    input: { runId: detail.workflowRun.workflowRunId },
                    context: { surface: 'ui', authority: 'present_user', serverId: account.serverId, runtimeAccountId: account.accountId },
                }).catch(() => null);
                account.assertCurrent();
                const parsed = WorkflowRunGetResultV1Schema.safeParse(opened);
                if (parsed.success) workflowResult = { accountId: account.accountId, detail: parsed.data };
            }
            const privateContent = inspectAutomationRunDetailPrivateContent({
                detail,
                accountCurrentness,
                ...(material.kind === 'available' && material.material
                    ? { material: material.material }
                    : {}),
                ...(workflowResult ? { workflowResult } : {}),
            });
            if (!shouldContinue()) {
                throw new Error('Automation server-account scope changed');
            }
            return { detail, privateContent };
        } finally {
            if (account !== execution.account) account?.dispose();
            execution.dispose();
        }
    }

    /** Unqualified cancellation retains the incumbent bounded Run cache projection. */
    public async cancelAutomationRun(
        runId: string,
        options: Readonly<{ accountLifetime?: ServerAccountScopeLifetime | null }> = {},
    ): Promise<AutomationDefinitionRun> {
        const execution = await this.prepareAutomationRunExecution(options);
        try {
            if (!execution.shouldContinue()) throw new Error('Automation server-account scope changed');
            const run = await cancelAutomationRun(execution.credentials, runId, execution.requestContext);
            if (!execution.shouldContinue()) throw new Error('Automation server-account scope changed');
            if (execution.updateActiveCache) storage.getState().upsertAutomationRun(run);
            return run;
        } finally { execution.dispose(); }
    }

    /** Requeues one blocked reply handoff in its captured Home. */
    public async retryAutomationReplyHandoff(
        runId: string,
        options: Readonly<{ accountLifetime?: ServerAccountScopeLifetime | null }> = {},
    ): Promise<AutomationDefinitionRun> {
        const execution = await this.prepareAutomationRunExecution(options);
        try {
            if (!execution.shouldContinue()) throw new Error('Automation server-account scope changed');
            const run = await retryAutomationReplyHandoff(execution.credentials, runId, execution.requestContext);
            if (!execution.shouldContinue()) throw new Error('Automation server-account scope changed');
            if (execution.updateActiveCache) storage.getState().upsertAutomationRun(run);
            return run;
        } finally { execution.dispose(); }
    }

    /**
     * Authorizes one further delivery of an accepted result. The caller passes
     * the exact Run revision it showed the user, so the server can refuse an
     * authorization that no longer describes what they decided about.
     */
    public async deliverAutomationResultAgain(input: Readonly<{
        runId: string;
        expectedRevision: number;
    }>, options: Readonly<{ accountLifetime?: ServerAccountScopeLifetime | null }> = {}): Promise<AutomationDefinitionRun> {
        const execution = await this.prepareAutomationRunExecution(options);
        try {
            if (!execution.shouldContinue()) throw new Error('Automation server-account scope changed');
            const run = await deliverAutomationResultAgain(execution.credentials, input, execution.requestContext);
            if (!execution.shouldContinue()) throw new Error('Automation server-account scope changed');
            if (execution.updateActiveCache) storage.getState().upsertAutomationRun(run);
            return run;
        } finally { execution.dispose(); }
    }

    public getCredentials(): AuthCredentials | null {
        return this.credentials?.token ? this.credentials : null;
    }

    public getAccountEncryptionObservationBinding(credentials: AuthCredentials, serverId?: string): AccountEncryptionObservationBinding | null {
        const active = apiSocket.getAccountEncryptionObservationBinding(credentials);
        if (!serverId || active && areServerProfileIdentifiersEquivalent(active.serverId, serverId)) return active;
        return getConcurrentAccountEncryptionObservationBinding(serverId, credentials);
    }

    // Artifact methods
    /** Mounted surfaces own inventory demand independently of their initial-read readiness. */
    public observeArtifactInventory(scope: ServerAccountScope, selection?: ArtifactInventorySelection, options?: Readonly<{
        includeProvenance?: boolean;
        refreshOnAdmission?: boolean;
        onSettled?: (outcome: 'success' | 'failed') => void;
    }>): () => void {
        if (Array.isArray(selection) && selection.length === 0) return () => {};
        // The store can publish this scope before restore finishes binding Sync.
        // Keep mounted demand; readArtifactInventoryConsumers admits acquisition
        // only after the exact Account is active, including bootstrap's refresh.
        const consumer = { scope, selection, includeProvenance: options?.includeProvenance === true, onSettled: options?.onSettled };
        this.artifactInventoryConsumers.add(consumer);
        if (options?.refreshOnAdmission) this.artifactsSync.invalidate();
        return () => {
            this.artifactInventoryConsumers.delete(consumer);
            const remaining = this.readArtifactInventorySelections();
            let withdrawn = false;
            for (const refresh of this.artifactInventoryRefreshes) {
                if (!remaining.some(required => doesArtifactInventorySelectionCover(required, refresh.selection))) {
                    refresh.controller.abort();
                    withdrawn = true;
                }
            }
            // Withdrawing Browser must not restart a still-demanded approval census.
            // A shrunken full/union read does need a new attempt for its uncovered remainder.
            if (withdrawn && remaining.some(required => !this.artifactInventoryRefreshes.some(refresh =>
                !refresh.controller.signal.aborted && doesArtifactInventorySelectionCover(refresh.selection, required)))) {
                this.artifactsSync.invalidate();
            }
        };
    }

    private readArtifactInventoryConsumers() {
        return [...this.artifactInventoryConsumers].filter(consumer =>
            areServerAccountScopesEqual(consumer.scope, this.pendingSettingsScope));
    }

    private readArtifactInventorySelections(): readonly (ArtifactInventorySelection | undefined)[] {
        const consumers = this.readArtifactInventoryConsumers();
        if (consumers.length === 0) return [];
        if (consumers.some(consumer => consumer.selection === undefined)) return [undefined];
        const browser = consumers.some(consumer => consumer.selection === 'browserListed');
        const kinds = [...new Set(consumers.flatMap(consumer => typeof consumer.selection === 'object'
            && !isApprovalSessionInventorySelection(consumer.selection) && !isApprovalStateInventorySelection(consumer.selection)
            ? consumer.selection : []))].sort()
            .filter(kind => !browser || !doesArtifactInventorySelectionCover('browserListed', [kind]));
        const selections: ArtifactInventorySelection[] = browser ? ['browserListed'] : [];
        if (kinds.length > 0) selections.push(kinds);
        if (consumers.some(consumer => consumer.selection === 'inboxOpen')
            && !selections.some(selection => doesArtifactInventorySelectionCover(selection, 'inboxOpen'))) selections.push('inboxOpen');
        const sessions = new Set(consumers.flatMap(consumer => isApprovalSessionInventorySelection(consumer.selection)
            ? consumer.selection.approvalSessionIds : []));
        if (sessions.size > 0) selections.push({ approvalSessionIds: [...sessions].sort() });
        for (const consumer of consumers) if (isApprovalStateInventorySelection(consumer.selection)
            && !selections.some(selection => doesArtifactInventorySelectionCover(selection, consumer.selection))) selections.push(consumer.selection);
        return selections;
    }

    private settleArtifactInventoryConsumers(scope: ServerAccountScope | null, selection: ArtifactInventorySelection | undefined,
        outcome: 'success' | 'failed'): void {
        if (!scope || !areServerAccountScopesEqual(scope, this.pendingSettingsScope)) return;
        for (const consumer of this.readArtifactInventoryConsumers()) {
            if (doesArtifactInventorySelectionCover(selection, consumer.selection)) {
                // A full structural census can still contain unreadable headers. It answers
                // full membership, not the browser's stricter private-policy classification.
                consumer.onSettled?.(outcome === 'success' && consumer.selection === 'browserListed'
                    && !isArtifactInventoryLoaded(storage.getState(), 'browserListed') ? 'failed' : outcome);
            }
        }
    }

    private refreshDemandedArtifactInventories = async (): Promise<void> => {
        const selections = this.readArtifactInventorySelections();
        if (selections.length === 0) return;
        // Browser covers ordinary kinds, not the Inbox's private families. Both acquisitions
        // stay in the existing queue, with independent cancellation for their real consumers.
        const refreshes = selections.map(selection => ({ controller: new AbortController(), selection }));
        this.artifactInventoryRefreshes = refreshes;
        try {
            const results = await Promise.allSettled(refreshes.map(async refresh => {
                try {
                    await this.fetchArtifactsList({ selection: refresh.selection, signal: refresh.controller.signal });
                } catch (error) {
                    // Only this acquisition's withdrawal settles its cancellation.
                    if (!refresh.controller.signal.aborted) throw error;
                }
            }));
            for (const result of results) if (result.status === 'rejected') throw result.reason;
        } finally {
            if (this.artifactInventoryRefreshes === refreshes) this.artifactInventoryRefreshes = [];
        }
    };

    public fetchArtifactsList = async (options?: Readonly<{ selection?: ArtifactInventorySelection; kinds?: readonly string[]; browserListed?: true; signal?: AbortSignal }>): Promise<void> => {
        if (!this.credentials) return;
        const shouldContinue = this.createServerScopeGuard();
        const inventoryScope = getActiveServerAccountScope();
        const selection = options?.selection ?? (options?.browserListed ? 'browserListed' : options?.kinds);
        let inventoryReadStartedWith = storage.getState().artifacts;
        try { await this.withArtifactReadAuthority(options?.signal, params => fetchAndApplyArtifactsList({
            ...params,
            ...artifactInventorySelectionOptions(selection),
            inventoryScope,
            inventoryReadStartedWith,
            getCurrentArtifacts: () => storage.getState().artifacts,
            changesPageLimit: this.syncTuning.changesPageLimit,
            hydrateArtifacts: artifacts => {
                storage.getState().applyArtifacts(artifacts);
                inventoryReadStartedWith = storage.getState().artifacts;
            },
            includeProvenance: this.readArtifactInventoryConsumers().some(consumer => consumer.includeProvenance
                && doesArtifactInventorySelectionCover(selection, consumer.selection)),
            shouldContinue: () => shouldContinue() && !params.signal?.aborted,
            applyArtifacts: (artifacts, source) => {
                storage.getState().applyArtifacts(artifacts,
                    source !== undefined ? inventoryReadStartedWith : undefined, selection, source);
                // Publication proves this selected acquisition; a resolved no-op does not. Initial
                // readiness may cancel the opening effect before independent bodies finish.
                if ((source === 'inventory' || source === 'unreadable' && selection !== 'browserListed')
                    && shouldContinue() && !params.signal?.aborted) {
                    this.settleArtifactInventoryConsumers(inventoryScope, selection, 'success');
                }
            },
        })); } catch (error) {
            if (shouldContinue() && !options?.signal?.aborted) {
                this.settleArtifactInventoryConsumers(inventoryScope, selection, 'failed');
            }
            throw error;
        }
    }

    public async fetchArtifactWithBody(artifactId: string, options?: Readonly<{ fresh?: boolean }>): Promise<DecryptedArtifact | null> {
        if (!this.credentials) return null;
        return this.withArtifactReadAuthority(undefined, params => fetchArtifactWithBodyFromApi({ ...params, artifactId, fresh: options?.fresh }));
    }

    private refreshArtifactsByIds(artifactIds: readonly string[]): Promise<void> {
        const exactIds = Array.from(new Set(artifactIds.map(id => id.trim()).filter(Boolean))).sort();
        if (exactIds.length === 0) return Promise.resolve();
        return this.withArtifactReadAuthority(undefined, params => fetchAndApplyArtifactChanges({
            ...params,
            artifactIds: exactIds,
            getCurrentArtifacts: () => storage.getState().artifacts,
            applyArtifacts: storage.getState().applyArtifacts,
            deleteArtifact: storage.getState().deleteArtifact,
        }));
    }

    /** A mounted transcript demands bodies only for its own linked approval headers. */
    public hydrateSessionApprovalArtifacts(serverId: string, artifactIds: readonly string[]): Promise<void> {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !this.credentials || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, serverId)) return Promise.resolve();
        const pendingIds = artifactIds.filter(id => storage.getState().artifacts[id]?.body === undefined).sort();
        if (pendingIds.length === 0) return Promise.resolve();
        const credentialScope = resolveAuthCredentialsScopeKey(this.credentials);
        // Register the known demand before authority acquisition (including Web Locks)
        // can spread its readers across separate tasks.
        return this.artifactBodyHydrations.run(credentialScope, pendingIds, async (ids, sharedSignal, publish) => {
            const pending = new Set(ids);
            const results = new Map<string, PromiseSettledResult<void>>();
            const controller = new AbortController();
            const cancel = () => { controller.abort(); hydration.stop(); };
            const hydration = new InvalidateSync(async () => {
                if (!lifetime.isCurrent()) return;
                const selectedIds = [...pending];
                const attempt = await this.withArtifactReadAuthority(controller.signal, params => fetchAndApplyArtifactBodies({
                    ...params, artifactIds: selectedIds,
                    applyArtifacts: storage.getState().applyArtifacts,
                }));
                if (controller.signal.aborted || !lifetime.isCurrent()) return;
                const completed = new Map<string, PromiseSettledResult<void>>();
                let retry: PromiseRejectedResult | undefined;
                for (const [index, result] of attempt.entries()) {
                    if (result.status === 'rejected' && shouldRetrySyncInvalidation(result.reason)) {
                        retry ??= result;
                        continue;
                    }
                    const id = selectedIds[index]!;
                    pending.delete(id);
                    results.set(id, result);
                    completed.set(id, result);
                }
                publish(completed);
                if (retry) throw retry.reason;
            }, {
                pause: this.pauseController,
                backoff: {
                    minDelayMs: this.syncTuning.invalidateSyncBackoffMinDelayMs,
                    maxDelayMs: this.syncTuning.invalidateSyncBackoffMaxDelayMs,
                    maxFailureCount: 'infinite',
                },
                shouldRetry: (error: unknown) => !sharedSignal.aborted && lifetime.isCurrent() && shouldRetrySyncInvalidation(error),
                onRetryFailure: (error: unknown) => log.log(`Approval artifact hydration retry: ${error}`),
            });
            sharedSignal.addEventListener('abort', cancel, { once: true });
            const retirement = lifetime.onRetire(cancel);
            try {
                if (sharedSignal.aborted) cancel();
                await hydration.invalidateAndAwait();
                // Retirement has always settled hydration without publishing stale rows.
                for (const id of pending) results.set(id, { status: 'fulfilled', value: undefined });
                return results;
            } finally {
                retirement.dispose();
                sharedSignal.removeEventListener('abort', cancel);
                controller.abort();
                hydration.stop();
            }
        }, { scope: lifetime }).then(results => {
            for (const result of results.values()) if (result.status === 'rejected') throw result.reason;
        });
    }

    private async withArtifactReadAuthority<TResult>(signal: AbortSignal | undefined,
        operation: (params: Omit<Parameters<typeof fetchArtifactForViewFromApi>[0], 'artifactId'> & Readonly<{ serverId: string }>) => Promise<TResult>,
    ): Promise<TResult> {
        if (!this.credentials) throw new Error('Not authenticated');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Artifact Account scope is unavailable');
        const serverIsCurrent = this.createServerScopeGuard();
        const credentials = this.credentials;
        const encryption = this.encryption;
        const staleError = () => new Error('Artifact Account scope changed');
        return runWithServerAccountScopeRequestGuard({ scope, signal, staleError,
            isCurrent: () => serverIsCurrent() && this.credentials === credentials && this.encryption === encryption
                && areServerAccountScopesEqual(scope, getActiveServerAccountScope()),
        }, async guard => {
            guard.check();
            if (!await this.awaitBootstrapForegroundAcquisition()) throw staleError();
            guard.check();
            const authority = await captureServerRequestAuthorityForServerAccountScope({ scope, activeRequest: this.requestViaConfiguredSocket });
            let result: TResult;
            try {
                guard.check();
                if (authority.context.token !== credentials.token) throw staleError();
                result = await operation({ credentials, encryption, artifactDataKeys: this.artifactDataKeys,
                    serverId: scope.serverId,
                    readTransport: authority.readTransport,
                    signal: guard.signal,
                    forbiddenOrigins: [authority.context.targetServerUrl,
                        ...(authority.context.runtimeOrigin ? [authority.context.runtimeOrigin] : [])],
                    request: async (path, init) => {
                        guard.check();
                        const response = await authority.request(path, { ...init, signal: guard.signal });
                        guard.check();
                        return response;
                    },
                });
            } finally { await authority.release(); }
            // Releasing a scoped carrier can await: retirement during that release still
            // invalidates the result before it is disclosed or published by the caller.
            guard.check();
            return result;
        });
    }

    public fetchArtifactForView = async (artifactId: string, options: Readonly<{ signal: AbortSignal }>): Promise<ArtifactViewRead | null> => {
        return this.withArtifactReadAuthority(options.signal,
            params => fetchArtifactForViewFromApi({ ...params, artifactId }));
    };

    public fetchArtifactBinary = async (artifactId: string, reference: Parameters<typeof fetchArtifactBinaryFromApi>[0]['reference'], signal?: AbortSignal): Promise<Uint8Array> => {
        return this.withArtifactReadAuthority(signal, params => fetchArtifactBinaryFromApi({ ...params, artifactId, reference }));
    };

    public fetchArtifactHtmlPreview = async (artifactId: string, signal?: AbortSignal): Promise<NonNullable<ArtifactViewRead['htmlPreview']>> => {
        return this.withArtifactReadAuthority(signal, params => fetchArtifactHtmlPreviewFromApi({ ...params, artifactId }));
    };

    public async createArtifact(
        title: string | null, 
        body: ArtifactBodyInput,
        sessions?: string[],
        draft?: boolean
    ): Promise<string> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }

        return await createArtifactViaApi({
            credentials: this.credentials,
            title,
            body,
            sessions,
            draft,
            encryption: this.encryption,
            artifactDataKeys: this.artifactDataKeys,
            addArtifact: (artifact) => storage.getState().addArtifact(artifact),
        });
    }

    public async createArtifactWithHeader(header: Readonly<Record<string, unknown>>, body: ArtifactBodyInput): Promise<string> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }

        return await createArtifactWithHeaderViaApi({
            credentials: this.credentials,
            header,
            body,
            encryption: this.encryption,
            artifactDataKeys: this.artifactDataKeys,
            addArtifact: (artifact) => storage.getState().addArtifact(artifact),
        });
    }

    public async updateArtifactWithHeader(
        artifactId: string,
        header: Readonly<Record<string, unknown>>,
        body: ArtifactBodyInput,
        options?: Readonly<{ expectedRevision: Readonly<{ headerVersion: number; bodyVersion: number }>; signal?: AbortSignal }>,
    ): Promise<void> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }

        await updateArtifactWithHeaderViaApi({
            credentials: this.credentials,
            artifactId,
            expectedRevision: options?.expectedRevision,
            signal: options?.signal,
            header,
            body,
            encryption: this.encryption,
            artifactDataKeys: this.artifactDataKeys,
            getArtifact: (id) => storage.getState().artifacts[id],
            updateArtifact: (artifact) => storage.getState().updateArtifact(artifact),
        });
    }

    private fetchMachines = async () => {
        if (!await this.awaitBootstrapForegroundAcquisition()) return;
        if (!this.credentials) return;
        const credentials = this.credentials;
        const appliedTransportTarget = this.getAppliedTransportTarget();
        if (!appliedTransportTarget) return;
        const generation = this.serverScopeGeneration;
        const shouldContinue = () => (
            this.serverScopeGeneration === generation
            && this.isAppliedTransportTargetCurrent(appliedTransportTarget)
        );
        const sourceServerId = appliedTransportTarget.serverId;
        const cachedMachineDisplayEntries = buildMachineDisplayCacheEntriesFromRenderables(storage.getState().machineDisplayById);
        const recipientEncryptionLifetime = captureEncryptionGenerationCurrentness(this.encryption);
        const readTransport = this.embedSessionScope ? undefined : apiSocket.createReadTransportForPreparedTarget({
            ...appliedTransportTarget, endpoint: appliedTransportTarget.serverUrl,
        });

        await fetchAndApplyMachines({
            credentials,
            readAccountMode: async () => (await fetchAccountEncryptionMode(credentials, { request: this.createAppliedTransportRequest(appliedTransportTarget), usage: 'identity' })).mode,
            request: this.createAppliedTransportRequest(appliedTransportTarget),
            readTransport,
            encryption: this.encryption,
            machineDataKeys: this.machineDataKeys,
            throwOnError: true,
            getExistingMachine: (machineId) => storage.getState().machines[machineId] ?? null,
            getMachineSnapshot: () => storage.getState().machines,
            cachedMachineDisplayEntries,
            shouldContinue,
            applyMachineDisplayEntries: (machines, options) => {
                if (!shouldContinue()) return;
                storage.getState().replaceMachineDisplays(machines, { sourceServerId, replace: options?.replace });
            },
            machineDisplayHydrationConcurrencyLimit: this.syncTuning.machineDisplayHydrationConcurrencyLimit,
            applyMachines: (machines, replace, publishedRows) => {
                if (!shouldContinue()) return;
                storage.getState().applyMachines(machines, replace, { sourceServerId,
                    activityUpdates: publishedRows.map(({ id, active, activeAt }) => ({ id, active, activeAt })),
                });
            },
            onRowsObserved: machines => {
                if (!shouldContinue()) return;
                const scope = getActiveServerAccountScope();
                if (!scope || scope.serverId !== sourceServerId) return;
                // Role selects an attempt, not permission: the worklist reauthorizes every read
                // and commit. Custodians and current foreign holders repair Team joins through
                // the same invalidation lifecycle, including when the custodian is offline.
                void import('./api/machines/machineDataKeyEnvelopesApi').then(owner => {
                    if (!shouldContinue()) return;
                    return owner.prepareMachineDataKeyEnvelopesForMachines({ scope, machines, publishedRows: machines,
                        recipientChangeCursors: this.machineRecipientChangeCursors,
                        isCurrent: () => shouldContinue() && recipientEncryptionLifetime.isCurrent() });
                }).catch(() => { /* The next canonical invalidation retries unavailable local loading. */ });
            },
            replace: true,
            sourceServerId,
            onListComplete: () => {
                if (!shouldContinue()) return;
                storage.getState().markMachineListSettled(sourceServerId);
            },
            onListUnavailable: () => {
                if (!shouldContinue()) return;
                storage.getState().markMachineListUnavailable(sourceServerId);
            },
        });
    }

    private fetchFriends = async () => {
        if (!this.credentials) return;
        const target = this.getAppliedTransportTarget();
        if (!target) return;
        const shouldContinue = this.createAppliedTransportScopeGuard(target);
        await fetchAndApplyFriends({
            credentials: this.credentials,
            request: this.createAppliedTransportRequest(target),
            serverId: target.serverId,
            shouldContinue,
            applyFriends: (friends) => storage.getState().applyFriends(friends),
        });
    }

    private fetchFriendRequests = async () => {
        // Friend requests are now included in the friends list with status='pending'
        // This method is kept for backward compatibility but does nothing
        log.log('👥 fetchFriendRequests called - now handled by fetchFriends');
    }

    private fetchTodos = async () => {
        const credentials = this.credentials;
        const target = this.getAppliedTransportTarget();
        if (!credentials || !target) return;
        await fetchTodosEngine({
            credentials,
            request: this.createAppliedTransportRequest(target),
            shouldContinue: this.createAppliedTransportScopeGuard(target),
        });
    }

    private fetchAutomations = async () => {
        const credentials = this.credentials;
        const target = this.getAppliedTransportTarget();
        if (!credentials || !target) return;
        const shouldContinue = this.createAppliedTransportScopeGuard(target);
        // Only bootstrap installs this continuation. Take it once, even if
        // admission/read fails; later refreshes and arrivals never restart it.
        const onDefinitionsRead = this.consumeBootstrapAutomationPage ?? undefined;
        this.consumeBootstrapAutomationPage = null;
        const refreshRuns = this.automationRunRefreshPending;
        this.automationRunRefreshPending = false;
        try {
            const result = await fetchAndApplyAutomations({
                credentials,
                requestContext: this.createAppliedAutomationRequestContext(target),
                shouldContinue,
                onDefinitionsRead,
                applyAutomations: (automations, nextCursor) =>
                    storage.getState().applyAutomations(automations, nextCursor),
                appendAutomations: (cursor, traversalToken, automations, nextCursor) =>
                    storage.getState().appendAutomations(cursor, traversalToken, automations, nextCursor),
                loadedAutomationRunIds: refreshRuns ? Object.keys(storage.getState().automationRunIdsByAutomationId) : [],
                refreshAutomationRunsWindow: (automationId, runs, nextCursor) =>
                    storage.getState().refreshAutomationRunsWindow(automationId, runs, nextCursor),
            });
            this.automationDefinitionTraversalToken = result.traversalToken;
        } catch (error) {
            if (refreshRuns && shouldContinue()) this.automationRunRefreshPending = true;
            throw error;
        }
    }

    private fetchAccountPets = async () => {
        const credentials = this.credentials;
        if (!credentials) return;
        const appliedTransportTarget = this.getAppliedTransportTarget();
        if (!appliedTransportTarget) return;
        const serverId = appliedTransportTarget.serverId;
        const serverScopeGuard = this.createServerScopeGuard();
        const shouldContinue = () => (
            serverScopeGuard()
            && this.isAppliedTransportTargetCurrent(appliedTransportTarget)
        );
        const params = {
            credentials,
            request: this.createAppliedTransportRequest(appliedTransportTarget),
            shouldContinue,
            applyAccountPets: (pets: AccountPetMetadata[]) => storage.getState().applyAccountPets(pets),
        };
        await fetchAndApplyAccountPets(serverId ? { ...params, serverId } : params);
    }

    private applyTodoSocketUpdates = async (changes: any[]) => {
        const target = this.getAppliedTransportTarget();
        if (!this.credentials || !target) return;
        await applyTodoSocketUpdatesEngine({
            changes,
            credentials: this.credentials,
            encryption: this.encryption,
            request: this.createAppliedTransportRequest(target),
            shouldContinue: this.createAppliedTransportScopeGuard(target),
            invalidateTodosSync: () => this.todosSync.invalidate(),
        });
    }

    private fetchFeed = async () => {
        const credentials = this.credentials;
        const target = this.getAppliedTransportTarget();
        if (!credentials || !target) return;
        const request = this.createAppliedTransportRequest(target);
        const shouldContinue = this.createAppliedTransportScopeGuard(target);
        await fetchAndApplyFeed({
            credentials,
            request,
            getFeedItems: () => storage.getState().feedItems,
            getFeedHead: () => storage.getState().feedHead,
            assumeUsers: (userIds) => this.assumeUsers(userIds, { credentials, request, shouldContinue }),
            getUsers: () => storage.getState().users,
            shouldContinue,
            applyFeedItems: (items) => storage.getState().applyFeedItems(items),
            log,
        });
    }

    /** One runtime per applied Account/Home; frame credentials never gain Account memory access. */
    private hydrateAuthoringMemoryProjection(scope: AccountSettingsScope): void {
        const projection = loadAuthoringMemoryProjection(scope);
        if (projection) storage.getState().applyAuthoringMemory(projection);
        else storage.getState().resetAuthoringMemory();
    }

    private ensureAuthoringMemoryRuntime(): Promise<ReturnType<typeof createAuthoringMemorySync>> {
        if (this.embedSessionScope || isEmbedWindowContext()) throw new Error('Authoring memory requires Account authority');
        if (this.authoringMemoryRuntime) return this.authoringMemoryRuntime;
        const credentials = this.credentials;
        const scope = this.pendingSettingsScope;
        const requestContext = this.createAppliedSettingsRequestContext(scope);
        const encryption = this.encryption;
        const target = this.getAppliedTransportTarget();
        if (!credentials || !scope || !requestContext || !target) throw new Error('Authoring memory Account/Home is unavailable');
        const guard = this.createAppliedTransportScopeGuard(target);
        // Install the owner identity before a synchronous transport callback
        // can consult it during the first persisted-mode request.
        const task = Promise.resolve().then(async () => {
            const isCurrent = () => this.authoringMemoryRuntime === task && guard()
                && this.credentials === credentials && areAccountSettingsScopesEqual(this.pendingSettingsScope, scope);
            const request = async (path: string, init?: RequestInit): Promise<Response> => {
                if (!isCurrent()) throw new Error('Authoring memory Account/Home retired');
                const response = await requestContext.request(path, {
                    ...init, headers: { ...init?.headers, Authorization: `Bearer ${credentials.token}` },
                });
                if (!isCurrent()) throw new Error('Authoring memory Account/Home retired');
                return response;
            };
            const mode = await fetchAccountEncryptionMode(credentials, { request });
            if (!isCurrent()) throw new Error('Authoring memory Account/Home retired');
            const legacySettings = {
                read: () => readAccountSettingsBaseline({ request, credentials, encryption, accountMode: mode.mode }),
                remove: async (key: string, expectedVersion: number) => {
                    if (!isCurrent()) throw new Error('Authoring memory Account/Home retired');
                    if (key !== 'recentMachinePaths' && key !== 'lastUsedProfile' && key !== 'lastEngineSelectionsByScopeV1') {
                        throw new Error('Invalid authoring-memory retirement key');
                    }
                    const result = await retireLegacyAuthoringMemoryKey({
                        credentials, encryption, accountMode: mode.mode, settingsScope: scope,
                        requestContext: { ...requestContext, request },
                        key, expectedSettingsVersion: expectedVersion,
                    });
                    if (!isCurrent()) throw new Error('Authoring memory Account/Home retired');
                    return result.status;
                },
            };
            const owner = createAuthoringMemorySync({
                transport: createApiAuthoringMemoryTransport({ request }),
                cipher: createAuthoringMemoryCipher({ mode: mode.mode,
                    material: mode.mode === 'e2ee' && !isTokenOnlyAuthCredentials(credentials)
                        ? resolveAccountScopedCryptoMaterialFromCredentials(credentials) : null,
                    randomBytes: getRandomBytes }),
                isCurrent,
                legacySettings,
                onProjectLastOpenedChanged: () => {
                    const runtime = this.projectAccountRowsRuntime;
                    if (runtime) fireAndForget(runtime.then(rows => {
                        if (isCurrent() && this.projectAccountRowsRuntime === runtime) rows.refreshRecency(
                            ref => owner.readProjectLastOpened({ serverId: ref.serverId, projectKey: ref.projectKey ?? ref.id }));
                    }), { tag: 'Sync.projectAccountRows.recency' });
                },
                apply: (delta) => {
                    const previous = storage.getState().authoringMemory;
                    storage.getState().applyAuthoringMemory(delta);
                    if (!isCurrent()) throw new Error('Authoring memory Account/Home retired');
                    const current = storage.getState().authoringMemory;
                    if (current !== previous) saveAuthoringMemoryProjection(scope, current);
                },
            });
            await owner.bootstrap();
            await importLegacyAuthoringMemory({ owner, settings: legacySettings });
            const rowsRuntime = this.projectAccountRowsRuntime;
            if (rowsRuntime) fireAndForget(rowsRuntime.then(rows => {
                if (isCurrent() && this.projectAccountRowsRuntime === rowsRuntime) rows.refreshRecency(
                    ref => owner.readProjectLastOpened({ serverId: ref.serverId, projectKey: ref.projectKey ?? ref.id }));
            }), { tag: 'Sync.projectAccountRows.recency' });
            return owner;
        }).catch((error: unknown) => {
            // Retired Account/Home work is cancellation, including owner-local scope checks.
            // Preserve failures from the current authority rather than hiding unavailable storage.
            if (this.authoringMemoryRuntime !== task || !guard()
                || this.credentials !== credentials || !areAccountSettingsScopesEqual(this.pendingSettingsScope, scope)) {
                throw new StaleServerGenerationError();
            }
            throw error;
        });
        this.authoringMemoryRuntime = task;
        void task.catch(() => { if (this.authoringMemoryRuntime === task) this.authoringMemoryRuntime = null; });
        return task;
    }

    public applyAuthoringMemoryDelta = async (delta: AuthoringMemoryDelta, options?: Readonly<{
        expectedSettingsScope: AccountSettingsScope | null;
    }>): Promise<void> => {
        if (options && !areAccountSettingsScopesEqual(this.pendingSettingsScope, options.expectedSettingsScope)) {
            throw new Error('Authoring memory Account/Home changed before mutation');
        }
        await (await this.ensureAuthoringMemoryRuntime()).applyDelta(delta);
    };

    public reconfigureAuthoringMemoryForAccountMode(credentials: AuthCredentials, _accountMode: 'plain' | 'e2ee'): void {
        if (!this.pendingSettingsScope || credentials.token !== this.credentials?.token) {
            throw new Error('Authoring memory Account/Home is unavailable');
        }
        // The next access re-reads persisted currentness after the atomic switch.
        // Retiring the runtime also rejects any source-mode response still in flight.
        this.authoringMemoryRuntime = null;
        this.projectAccountRowsRuntime = null;
        if (areAccountSettingsScopesEqual(storage.getState().projectAccountRows?.scope, this.pendingSettingsScope)) {
            storage.getState().clearProjectAccountRowsScope();
        }
    }

    private ensureProjectAccountRowsRuntime(): Promise<ReturnType<typeof createProjectAccountRowsSync>> {
        if (this.embedSessionScope || isEmbedWindowContext()) throw new Error('Project rows require Account authority');
        if (this.projectAccountRowsRuntime) return this.projectAccountRowsRuntime;
        const credentials = this.credentials;
        const scope = this.pendingSettingsScope;
        const context = this.createAppliedSettingsRequestContext(scope);
        const target = this.getAppliedTransportTarget();
        if (!credentials || !scope || !context || !target) throw new Error('Project Account/Home unavailable');
        const guard = this.createAppliedTransportScopeGuard(target);
        storage.getState().activateProjectAccountRowsScope(scope);
        storage.getState().setProjectAccountRowsStatusForScope(scope, 'loading');
        const isCurrent = () => this.projectAccountRowsRuntime === task && guard()
            && this.credentials === credentials && areAccountSettingsScopesEqual(this.pendingSettingsScope, scope);
        const onRefreshFailure = (error: unknown) => {
            if (!isCurrent()) return;
            if (isTransientConnectivityError(error)) {
                storage.getState().setProjectAccountRowsStatusForScope(scope, 'error');
                return;
            }
            // An auth/mode/material or unclassified failure is not permission to
            // keep disclosing private rows from a previously admitted read.
            this.projectAccountRowsRuntime = null;
            if (areAccountSettingsScopesEqual(storage.getState().projectAccountRows?.scope, scope)) {
                storage.getState().clearProjectAccountRowsScope();
            }
        };
        const task = Promise.resolve().then(async () => {
            const request: ServerFetch = async (path, init, options) => {
                if (!isCurrent()) throw new StaleServerGenerationError();
                const response = await context.request(path, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${credentials.token}` } }, options);
                if (!isCurrent()) throw new StaleServerGenerationError();
                return response;
            };
            const mode = await fetchAccountEncryptionMode(credentials, { request });
            if (!isCurrent()) throw new StaleServerGenerationError();
            const readLegacyLabel = (key: string) => readSessionOrganizationWorkspaceLabel(
                storage.getState().sessionOrganizationLabelsByLabelKey[buildSessionOrganizationLabelKey({
                    serverId: scope.serverId, labelKind: 'workspace', scopeKey: key,
                })],
            );
            const owner = createProjectAccountRowsSync({
                scope, transport: createApiProjectAccountRowsTransport({ request }),
                cipher: createProjectAccountRowCipherV1({ mode: mode.mode,
                    material: mode.mode === 'e2ee' && !isTokenOnlyAuthCredentials(credentials)
                        ? resolveAccountScopedCryptoMaterialFromCredentials(credentials) : null, randomBytes: getRandomBytes }),
                isCurrent,
                apply: (...args) => storage.getState().applyProjectAccountRowsForScope(scope, ...args),
                onRefreshFailure,
                // Optional recency is attached by the memory owner when it is available.
                // Its failure must not stop the independent structural census.
                writeRecency: async (ref, timestamp) => (await this.ensureAuthoringMemoryRuntime())
                    .writeProjectLastOpened({ serverId: ref.serverId, projectKey: ref.projectKey ?? ref.id }, timestamp),
                readLegacyLabel,
                retireLegacyLabel: async (key, label) => {
                    const mutationScope = await requireSessionOrganizationMutationScope(scope.serverId);
                    if (!isCurrent()) throw new StaleServerGenerationError();
                    if (readLegacyLabel(key) !== label) return;
                    await writeSessionOrganizationWorkspaceLabels({ scope: mutationScope, current: { [key]: label }, next: {} });
                    if (!isCurrent()) throw new StaleServerGenerationError();
                },
            });
            await owner.refresh();
            const memoryRuntime = this.authoringMemoryRuntime;
            if (memoryRuntime) fireAndForget(memoryRuntime.then(memory => {
                if (isCurrent() && this.authoringMemoryRuntime === memoryRuntime) owner.refreshRecency(
                    ref => memory.readProjectLastOpened({ serverId: ref.serverId, projectKey: ref.projectKey ?? ref.id }));
            }), { tag: 'Sync.projectAccountRows.recency' });
            return owner;
        }).catch((error: unknown) => {
            onRefreshFailure(error);
            throw error;
        });
        this.projectAccountRowsRuntime = task;
        void task.catch(() => { if (this.projectAccountRowsRuntime === task) this.projectAccountRowsRuntime = null; });
        return task;
    }

    /** Reads the Account's project rows back after a write made elsewhere (a controller daemon's lifecycle Action). */
    public refreshProjectAccountRows = async () => {
        const scope = this.pendingSettingsScope;
        const needsInitialCensus = this.projectAccountRowsRuntime === null;
        const runtime = this.ensureProjectAccountRowsRuntime();
        const owner = await runtime;
        // A newly created owner has already read and applied this refresh's census.
        if (needsInitialCensus) return;
        if (scope && this.projectAccountRowsRuntime === runtime) {
            // Retain admitted display rows while withholding fresh mutation authority.
            storage.getState().setProjectAccountRowsStatusForScope(scope, 'loading');
        }
        await owner.refresh();
    };

    public mutateProjectWorkspaceRef = async (mutation: WorkspaceRefAccountMutation, expectedScope: AccountSettingsScope) => {
        if (!areAccountSettingsScopesEqual(this.pendingSettingsScope, expectedScope)) throw new Error('Project Account/Home changed');
        return await (await this.ensureProjectAccountRowsRuntime()).mutateRef(mutation);
    };

    /** An already-demanded SCM observation may enrich an existing accepted ref once. */
    public recordObservedWorkspaceRepositoryIdentity = async (
        address: import('@happier-dev/protocol/workspaces/workspaceRefV1').WorkspaceAddressV1,
        identity: NonNullable<import('@happier-dev/protocol/workspaces/workspaceRefV1').WorkspaceRefV1['repositoryIdentity']>,
        expectedScope: AccountSettingsScope,
    ) => {
        if (!areAccountSettingsScopesEqual(this.pendingSettingsScope, expectedScope)) throw new Error('Project Account/Home changed');
        return await (await this.ensureProjectAccountRowsRuntime()).recordWorkspaceRepositoryIdentity(address, identity);
    };

    private syncSettings = async () => {
        if (!this.credentials) return;
        if (!this.embedSessionScope && !isEmbedWindowContext()) {
            fireAndForget(this.awaitBootstrapForegroundAcquisition().then(current => current
                ? this.ensureAuthoringMemoryRuntime() : undefined), { tag: 'Sync.authoringMemory.bootstrap' });
            fireAndForget(this.awaitBootstrapForegroundAcquisition().then(current => current
                ? this.ensureProjectAccountRowsRuntime() : undefined), { tag: 'Sync.projectAccountRows.bootstrap' });
        }
        const settingsScope = this.pendingSettingsScope;
        const requestContext = this.createAppliedSettingsRequestContext(settingsScope);
        if (!requestContext) return;
        const settingsSyncParams: SyncSettingsParams = {
            credentials: this.credentials,
            encryption: this.encryption,
            settingsScope,
            requestContext,
            pendingSettings: this.pendingSettings,
            getPendingSettings: () => areAccountSettingsScopesEqual(this.pendingSettingsScope, settingsScope)
                ? this.pendingSettings
                : settingsScope ? loadPendingAccountSettings(settingsScope) : {},
            // A capable client repairs an absent/stale derived policy through the
            // same exact-Home CAS owner that fetched the encrypted settings winner.
            republishRemoteAlertPolicy: true,
            settingsSecretsKey: this.settingsSecretsKey,
            settingsSecretsReadKeys: this.settingsSecretsReadKeys,
            clearPendingSettings: (nextPendingSettings) => {
                if (settingsScope) {
                    savePendingAccountSettings(settingsScope, nextPendingSettings);
                    if (areAccountSettingsScopesEqual(this.pendingSettingsScope, settingsScope)) {
                        this.pendingSettings = nextPendingSettings;
                    }
                    return;
                }
                if (!this.pendingSettingsScope) {
                    this.pendingSettings = nextPendingSettings;
                }
            },
        };
        await syncSettingsEngine(settingsSyncParams);
    }

    public prepareAccountSettingsForDaemonSpawn = async (): Promise<PreparedAccountSettingsForDaemonSpawn> => {
        this.flushPendingSettingsForCurrentScopeNow();
        return await prepareAccountSettingsForDaemonSpawnEngine({
            settingsScope: this.pendingSettingsScope,
            pendingSettings: { ...this.pendingSettings },
            getActiveSettingsScope: () => storage.getState().settingsScope,
            getCurrentSettingsVersion: () => storage.getState().settingsVersion,
            flushPendingServerSettings: async () => {
                await this.syncSettings();
            },
            clearPendingSettings: (submittedPendingSettings) => {
                const settingsScope = this.pendingSettingsScope;
                const nextPendingSettings = removeCommittedPendingSettings(this.pendingSettings, submittedPendingSettings);
                if (settingsScope) {
                    savePendingAccountSettings(settingsScope, nextPendingSettings);
                }
                this.pendingSettings = nextPendingSettings;
            },
        });
    }

    /** Re-fetches the canonical CAS winner after a daemon-owned account-settings mutation. */
    public refreshAccountSettingsFromServer = async (
        minimumVersion: number,
        expectedSettingsScope: AccountSettingsScope | null,
    ): Promise<void> => {
        if (!expectedSettingsScope
            || !areAccountSettingsScopesEqual(this.pendingSettingsScope, expectedSettingsScope)) {
            throw new Error('Account settings scope changed before refreshing settings');
        }
        this.flushPendingSettingsForCurrentScopeNow();
        await this.syncSettings();
        if (!areAccountSettingsScopesEqual(this.pendingSettingsScope, expectedSettingsScope)) {
            throw new Error('Account settings scope changed while refreshing settings');
        }
        assertAccountSettingsRehydratedVersion({
            currentVersion: storage.getState().settingsVersion,
            minimumVersion,
        });
    }

    /** Applies immutable top-level set/reset operations across CAS conflicts. */
    public applyAccountSettingsMutation = async (
        mutation: AccountSettingMutationV1,
        expectedSettingsScope: AccountSettingsScope | null,
    ): Promise<void> => {
        const credentials = this.credentials;
        if (!credentials) throw new Error('Account settings mutation requires an authenticated account');
        if (!expectedSettingsScope
            || !areAccountSettingsScopesEqual(this.pendingSettingsScope, expectedSettingsScope)) {
            throw new Error('Account settings scope changed before mutating settings');
        }
        const generation = this.serverScopeGeneration;
        const settingsScope = expectedSettingsScope;
        const encryption = this.encryption;
        const settingsSecretsKey = this.settingsSecretsKey;
        const settingsSecretsReadKeys = this.settingsSecretsReadKeys;
        this.flushPendingSettingsForCurrentScopeNow();
        await this.syncSettings();
        if (this.serverScopeGeneration !== generation
            || this.credentials !== credentials
            || !areAccountSettingsScopesEqual(this.pendingSettingsScope, settingsScope)) {
            throw new Error('Account settings scope changed while mutating settings');
        }
        const requestContext = this.createAppliedSettingsRequestContext(settingsScope);
        if (!requestContext) throw new Error('Account settings transport changed before mutation');
        await syncSettingsEngine({
            credentials,
            encryption,
            settingsScope,
            requestContext,
            pendingSettings: {},
            settingsSecretsKey,
            settingsSecretsReadKeys,
            clearPendingSettings: () => {},
            accountSettingsMutation: mutation,
        });
    }

    /**
     * Applies one explicit Account Settings mutation. Strict one-shot callers
     * receive the canonical winner on conflict; deterministic field-level
     * intents may request the bounded CAS rebase owned by syncSettings.
     */
    public mutateAccountSettingsOnce = async <T>(input: Readonly<{
        signal?: AbortSignal;
        expectedSettingsScope: AccountSettingsScope | null;
        /** Null is admitted only for a rebasing intent; syncSettings reads its exact Home baseline. */
        expectedSettingsVersion: number | null;
        rebaseOnConflict?: boolean;
        mutate: (
            raw: Readonly<Record<string, unknown>>,
        ) => Readonly<{
            settings: Record<string, unknown>;
            value: T;
        }>;
        commitPrepared?: (prepared: Readonly<{
            content: import('@happier-dev/protocol').AccountSettingsStoredContentEnvelope;
            expectedSettingsVersion: number;
            accountMode: 'plain' | 'e2ee';
            remoteAlertPolicy?: import('@happier-dev/protocol/account/settings/accountRemoteAlertPolicy').AccountRemoteAlertPolicyV1 | null;
        }>) => Promise<OneShotAccountSettingsPreparedCommitResult>;
    }>): Promise<Exclude<OneShotAccountSettingsMutationResult<T>, Readonly<{ status: 'invalid' }>>> => {
        if (input.signal?.aborted) throw new Error('Account Settings mutation was cancelled before issuance');
        const credentials = this.credentials;
        if (!credentials) throw new Error('Account settings mutation requires an authenticated account');
        if (!input.expectedSettingsScope
            || !areAccountSettingsScopesEqual(this.pendingSettingsScope, input.expectedSettingsScope)) {
            throw new Error('Account settings scope changed before mutating settings');
        }
        const generation = this.serverScopeGeneration;
        const settingsScope = input.expectedSettingsScope;
        const encryption = this.encryption;
        const settingsSecretsKey = this.settingsSecretsKey;
        const settingsSecretsReadKeys = this.settingsSecretsReadKeys;
        this.flushPendingSettingsForCurrentScopeNow();
        await this.syncSettings();
        if (input.signal?.aborted) throw new Error('Account Settings mutation was cancelled before issuance');
        if (this.serverScopeGeneration !== generation
            || this.credentials !== credentials
            || !areAccountSettingsScopesEqual(this.pendingSettingsScope, settingsScope)) {
            throw new Error('Account settings scope changed while mutating settings');
        }
        const requestContext = this.createAppliedSettingsRequestContext(settingsScope);
        if (!requestContext) throw new Error('Account settings transport changed before mutation');
        const result = await syncSettingsEngine({
            signal: input.signal,
            credentials,
            encryption,
            settingsScope,
            requestContext,
            pendingSettings: {},
            settingsSecretsKey,
            settingsSecretsReadKeys,
            clearPendingSettings: () => {},
            oneShotServerSettingsMutation: {
                expectedSettingsVersion: input.expectedSettingsVersion,
                ...(input.rebaseOnConflict === true ? { rebaseOnConflict: true } : {}),
                mutate: input.mutate,
                ...(input.commitPrepared ? { commitPrepared: input.commitPrepared } : {}),
            },
        });
        if (!result) throw new Error('One-shot Account Settings mutation did not settle');
        if (result.status === 'invalid') requireOneShotAccountSettingsMutationApplied(result);
        return result;
    }

    private fetchProfile = async () => {
        const credentials = this.credentials;
        const target = this.getAppliedTransportTarget();
        if (!credentials || !target) return;
        const generation = this.serverScopeGeneration;
        const targetCurrent = this.createAppliedTransportScopeGuard(target);
        const shouldContinue = () => this.serverScopeGeneration === generation && targetCurrent();
        const profileScope = this.pendingSettingsScope;
        await fetchAndApplyProfile({
            credentials,
            request: this.createAppliedTransportRequest(target),
            shouldContinue,
            applyProfile: (profile) => {
                if (!shouldContinue()) return;
                if (profileScope) {
                    storage.getState().applyProfileForScope(profileScope, profile);
                    return;
                }
                storage.getState().applyProfile(profile);
            },
        });
    }

    private fetchNativeUpdate = async () => {
        try {
            // Skip in development
            if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || !Constants.expoConfig?.version) {
                return;
            }
            if (Platform.OS === 'ios' && !Constants.expoConfig?.ios?.bundleIdentifier) {
                return;
            }
            if (Platform.OS === 'android' && !Constants.expoConfig?.android?.package) {
                return;
            }

            // Get platform and app identifiers
            const platform = Platform.OS;
            const version = Constants.expoConfig?.version!;
            const appId = (Platform.OS === 'ios' ? Constants.expoConfig?.ios?.bundleIdentifier! : Constants.expoConfig?.android?.package!);

            const response = await this.requestViaConfiguredSocket('/v1/version', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    platform,
                    version,
                    app_id: appId,
                }),
            }, { includeAuth: false, recoveryRead: 'unbounded' });

            if (!response.ok) {
                log.log(`[fetchNativeUpdate] Request failed: ${response.status}`);
                throw new RetryableServerResponseError(response.status, 'Native update status is unavailable');
            }

            const data = await response.json();

            // Apply update status to storage
            if (data.update_required && data.update_url) {
                storage.getState().applyNativeUpdateStatus({
                    available: true,
                    updateUrl: data.update_url
                });
            } else {
                storage.getState().applyNativeUpdateStatus({
                    available: false
                });
            }
        } catch (error) {
            console.error('[fetchNativeUpdate] Error:', error);
            throw error;
        }
    }

    private syncPurchases = async () => {
        const shouldContinue = this.createServerScopeGuard();
        await syncPurchasesEngine({
            serverID: this.serverID,
            revenueCatInitialized: this.revenueCatInitialized,
            setRevenueCatInitialized: (next) => {
                if (!shouldContinue()) return;
                this.revenueCatInitialized = next;
            },
            shouldContinue,
            applyPurchases: (customerInfo) => {
                if (!shouldContinue()) return;
                storage.getState().applyPurchases(customerInfo);
            },
        });
    }

    private applySessionThinkingFromTaskLifecycle = (
        sessionId: string,
        event: import('./engine/sessions/taskLifecycle').TaskLifecycleEvent,
    ) => {
        // Message catch-up pages can contain historical task_started markers.
        // We only use lifecycle catch-up to clear stale thinking state.
        if (event.type === 'task_started') {
            return;
        }

        const createdAt = event.createdAt || nowServerMs();
        if (event.type === 'turn_aborted' || event.type === 'task_complete') {
            storage.getState().applyMessages(sessionId, [{
                // Deterministic id to keep lifecycle event application stable if the same event is observed twice.
                id: `task-lifecycle-${sessionId}-${event.type}-${event.id}-${createdAt}`,
                localId: null,
                createdAt,
                role: 'event',
                content: {
                    type: 'task-lifecycle',
                    event: event.type,
                    id: event.id,
                },
                isSidechain: false,
            }]);
        }

        const session = storage.getState().sessions[sessionId];
        if (!session || !shouldInferSessionLifecycleFromTranscript(session)) {
            return;
        }

        const nextThinking = false;
        if (!nextThinking) {
            // Even when session.thinking is already false, a delayed lifecycle event
            // should clear any optimistic thinking marker left from the send path.
            storage.getState().clearSessionOptimisticThinking(sessionId);
        }

        const lastTurnCompletedAt = event.type === 'task_complete'
            ? createdAt
            : session.lastTurnCompletedAt ?? null;

        storage.getState().applySessionTerminalLifecycle(sessionId, lastTurnCompletedAt);
    }

    private hasUserOlderLoadInFlight(sessionId: string): boolean {
        const prefix = `${sessionId}:`;
        for (const key of this.sessionMessagesLoadingOlderByKey) {
            if (key.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    private replayDeferredMessagesFetch(sessionId: string): void {
        if (this.deferredMessagesFetchSessionIds.delete(sessionId)) {
            // A deferred fetch may have been discovered by the currently running
            // invalidation cycle (for example while route hydration resolves the
            // session's owner server). `invalidateCoalesced()` intentionally does
            // nothing while a cycle is already active, so it can strand the deferred
            // transcript forever. Use the normal invalidation entry point here: it
            // schedules the required post-run cycle when the first attempt is active,
            // while retaining coalescing when no attempt has started yet.
            this.getOrCreateMessagesSync(sessionId).invalidate();
        }
    }

    /**
     * End an unresolved-owner transcript deferral with the Home's own answer.
     *
     * `activeServerSessionIds` is a fetched-membership cache, so it cannot separate "this
     * Home has not listed the Session yet" from "this Session is no longer on this Home".
     * Deferring on that fact alone therefore outlives a Session that left its Home and
     * leaves its transcript on an activity indicator that never settles. Ask the one
     * authority that can answer — the same exact session hydration the Session route uses.
     * An `available` answer replays the deferral from `ensureSessionVisibleForMessageRoute`
     * itself, so no second resume path exists here; authoritative absence goes to the
     * canonical local retirement owner, which is exactly the evidence `deletedSessionIds`
     * documents and lets the route settle on its existing unavailable presentation. Every
     * other answer leaves the deferral standing: a terminal auth failure is already owned
     * by the Account-recovery surface, and a retryable one is connectivity, not absence.
     */
    private resolveUnlistedSessionOwnerOnHome(sessionId: string): void {
        void this.ensureSessionVisibleForMessageRoute(sessionId)
            .then((result) => {
                if (result.kind !== 'missing' || result.cause !== 'not_found') return;
                if (!storage.getState().sessions[sessionId]) return;
                this.retireLocalSession(sessionId, result.serverId ?? null);
            })
            .catch(() => {
                // `ensureSessionVisibleForMessageRoute` classifies its own failures into the
                // route result; an unclassified rejection is not absence evidence.
            });
    }

    private resolveTranscriptAuthority(
        session: Session,
        externalSessionLink: ExternalSessionLink | null,
    ): ExternalSessionTranscriptAuthority {
        const transportScope = this.getAppliedTransportAccountScope();
        const reachabilityScope = transportScope
            && areServerProfileIdentifiersEquivalent(session.serverId ?? transportScope.serverId, transportScope.serverId)
            ? transportScope
            : null;
        const machine = externalSessionLink
            ? resolveServerScopedMachine(storage.getState(), session.serverId, externalSessionLink.machineId)
            : null;
        return resolveExternalSessionTranscriptAuthority({
            linked: externalSessionLink !== null,
            // A not-yet-hydrated machine row is not evidence that the Agent is offline.
            // Known offline presence selects the snapshot; unknown presence keeps the
            // live read path, whose RPC returns the typed availability outcome.
            agentReachable: machine === null || reachabilityScope === null ? null : isMachineReachable(reachabilityScope, machine),
            liveSourceKey: externalSessionLink
                ? createExternalSessionTranscriptLiveSourceKeyFromLink(externalSessionLink)
                : null,
            currentStorageState: session.currentStorageState
                ?? (externalSessionLink ? 'legacy_external_unknown' : 'hosted'),
            acceptedThroughServerSeq: session.acceptedThroughServerSeq ?? null,
            publishedThroughServerSeq: session.publishedThroughServerSeq ?? null,
            materializedThroughSourceAt: session.materializedThroughSourceAt ?? null,
            transcriptShareable: session.transcriptShareable ?? null,
            operationPresentation:
                ExternalSessionOperationSharedPresentationV1Schema.safeParse(
                    session.metadata?.externalSessionOperationPresentationV1,
                ).data
                ?? null,
            operationProgress:
                readExternalSessionOperationState(
                    readSessionOwnerMetadataView(session) ?? {},
                ).value?.progress
                ?? null,
        });
    }

    private async replaceWithServerTranscript(
        session: Session,
        authority: Extract<ExternalSessionTranscriptAuthority, { kind: 'server_snapshot' | 'server_partial' | 'hosted' }>,
        read: Parameters<Parameters<Sync['withSessionTranscriptRead']>[1]>[0],
    ): Promise<boolean> {
        const authorityKey = externalSessionTranscriptAuthorityKey(authority);
        const stagedMessages: NormalizedMessage[] = [];
        let stagedPage: SessionMessagesPageV1 | null = null;
        const pageOptions = read.pageOptions;
        await fetchAndApplyMessages({
            sessionId: session.id,
            serverId: read.serverId,
            sessionEncryptionMode: session.encryptionMode === 'plain' ? 'plain' : 'e2ee',
            getSessionEncryption: (id) => read.encryption?.getSessionEncryption(id) ?? null,
            isSessionKnown: read.isSessionKnown,
            request: read.request,
            sessionReceivedMessages: new Map(),
            applyMessages: (_sessionId, messages) => {
                stagedMessages.push(...messages);
            },
            markMessagesLoaded: () => {},
            onMessagesPage: (page) => {
                stagedPage = page;
            },
            ...pageOptions,
            log,
        });

        if (!pageOptions.isCurrent()) return false;
        const currentSession = storage.getState().sessions[session.id] ?? null;
        if (!currentSession) return false;
        const currentLink = readExternalSessionLinkFromSession(currentSession);
        const currentAuthority = this.resolveTranscriptAuthority(currentSession, currentLink);
        if (externalSessionTranscriptAuthorityKey(currentAuthority) !== authorityKey) return false;

        if (storage.getState().sessionMessages[session.id]?.messageIdsOldestFirst.length
            && !this.isExternalSessionLiveTail(session.id)) {
            this.deferredForwardLoadingSessions.add(session.id);
            return false;
        }

        const maxServerSeq = authority.kind === 'hosted' ? null : authority.maxServerSeq;
        const boundedMessages = maxServerSeq === null
            ? stagedMessages
            : stagedMessages.filter((message) => (
                typeof message.seq === 'number'
                && Number.isSafeInteger(message.seq)
                && message.seq >= 0
                && message.seq <= maxServerSeq
            ));
        this.resetSessionTranscriptState(session.id, { resetMessages: false });
        if (stagedPage) {
            this.updateSessionMessagesPaginationFromPage(
                session.id,
                { scope: 'main' },
                stagedPage,
                { allowHasMoreInference: true, deferHistoryStartCoverage: true },
            );
        }
        this.applyMessages(session.id, boundedMessages, { replaceExisting: true, activitySource: 'reconciliation' });
        this.publishSessionMessagesHistoryStartCoverage(session.id);
        this.transcriptAuthorityKeyBySessionId.set(session.id, authorityKey);
        this.externalSessionTranscriptFenceAuthorityKeyBySessionId.delete(session.id);
        return true;
    }

    private fetchMessages = async (sessionId: string): Promise<void> => {
            const isCurrent = this.createServerScopeGuard();
            const serverId = storage.getState().sessions[sessionId]?.serverId;
            const priorIssue = storage.getState().getSessionTranscriptLoadIssue(sessionId);
            try {
                await this.fetchMessagesInternal(sessionId);
            } catch (error) {
                if (!isCurrent() || !areServerProfileIdentifiersEquivalent(serverId, storage.getState().sessions[sessionId]?.serverId)) throw error;
                // All transcript reads share this owner. External-session readers may already
                // have projected a more specific authority/RPC failure; preserve that signal
                // and only classify otherwise-unreported failures here so hosted/server
                // request, schema, and decryption errors cannot leave the UI's loading state
                // indistinguishable from an in-flight read.
                const currentIssue = storage.getState().getSessionTranscriptLoadIssue(sessionId);
                const wasProjectedByCurrentAttempt = currentIssue !== null && currentIssue !== priorIssue;
                const issue = currentIssue && wasProjectedByCurrentAttempt
                    ? currentIssue
                    : projectSessionTranscriptReadFailure(error);
                logSessionTranscriptReadFailure(sessionId, error, issue);
                if (!wasProjectedByCurrentAttempt) {
                    storage.getState().setSessionTranscriptLoadIssue(sessionId, issue);
                }
                throw error;
            }
        };

    private fetchMessagesInternal = async (sessionId: string) => {
        const initialSession = storage.getState().sessions[sessionId] ?? null;
        // A queued InvalidateSync callback can run after local deletion. It
        // must not recreate an empty loaded transcript for an absent session.
        if (!initialSession) {
            this.explicitSessionTailProbeIds.delete(sessionId);
            return;
        }
        if (isDemoModeActive()) {
            if (storage.getState().sessionMessages[sessionId]?.isLoaded !== true) {
                storage.getState().applyMessagesLoaded(sessionId);
            }
            this.explicitSessionTailProbeIds.delete(sessionId);
            return;
        }
        return await this.withSessionTranscriptRead(sessionId, async read => {
        if (!read.pageOptions.isCurrent()) return;
        let session: Session | null = initialSession;
        if (session.encryptionMode !== 'plain' && !read.encryption?.getSessionEncryption(sessionId)) {
            const sessionServerId = session.serverId;
            const hydration = Array.from(this.sessionByIdHydrationInFlight.values()).find((entry) => (
                entry.sessionId === sessionId
                && entry.encryption === read.encryption
                && areServerProfileIdentifiersEquivalent(entry.serverId, sessionServerId)
                && entry.isCurrent()
            ));
            if (hydration) {
                // Exact hydration owns reader installation. Keep this read loading
                // until that current Home/Account attempt settles; a still-missing
                // reader afterwards takes the normal terminal failure path below.
                const isCurrent = read.pageOptions.isCurrent;
                const issue = storage.getState().getSessionTranscriptLoadIssue(sessionId);
                if (issue?.kind === 'read_failed' && (
                    issue.errorCode === 'session_encryption_not_found'
                    || issue.errorCode === 'scoped_session_encryption_unavailable'
                )) storage.getState().setSessionTranscriptLoadIssue(sessionId, null);
                await hydration.promise;
                if (!isCurrent() || !hydration.isCurrent()) return;
                session = storage.getState().sessions[sessionId] ?? null;
                if (!session || !areServerProfileIdentifiersEquivalent(session.serverId, sessionServerId)) return;
            }
        }
        const externalSessionLink = readExternalSessionLink(
            session ? readSessionOwnerMetadataView(session) : null,
        );
        if (!externalSessionLink && this.hasFetchedSessionsSnapshotForActiveServer && !read.isSessionKnown(sessionId)) {
            // Do not fetch messages when we cannot resolve the session to either the active server
            // or a locally known owner server. This avoids cross-server message fetches. A
            // deep-link session can be transiently unresolved while its route row is committed;
            // defer that attempt instead of publishing a successful empty transcript.
            this.deferredMessagesFetchSessionIds.add(sessionId);
            this.resolveUnlistedSessionOwnerOnHome(sessionId);
            return;
        }

        if (this.hasUserOlderLoadInFlight(sessionId)) {
            // Defer-not-drop (plan D4): background catch-up must not apply messages while a
            // user-triggered older-page load is in flight for this session (it would prepend
            // uncoordinated content under the transcript viewport). Returning is a safe success
            // for InvalidateSync; the deferral is replayed from loadOlderMessagesForChain once
            // the in-flight load settles.
            this.deferredMessagesFetchSessionIds.add(sessionId);
            return;
        }

          const hasLoadedMessages = storage.getState().sessionMessages[sessionId]?.isLoaded === true;
          const hasExplicitTailProbe = this.explicitSessionTailProbeIds.has(sessionId);
          // IMPORTANT: `session.seq` is a "latest known session message seq" hint (often coming from `/sessions`),
          // not necessarily the last message seq that *this device has materialized*. Using it here can cause gaps.
          const afterSeq = hasLoadedMessages ? this.readSessionMessagesCatchUpAfterSeq(sessionId) : 0;
          const deferredDurableSeq = readDeferredTranscriptDurableSeq(this.deferredTranscriptState, sessionId);
          const sessionSeqHint = Math.max(session?.seq ?? 0, deferredDurableSeq ?? 0, readTranscriptGap(this.deferredTranscriptState, sessionId)?.throughSeq ?? 0);

          const viewport = this.sessionViewport.get(sessionId) ?? null;
          const isPinned = viewport?.isPinned ?? true;
          const offlineForMs = this.readSocketOfflineDurationMsForSession(sessionId);
          const hasAcceptedLocalPending = (storage.getState().sessionPending[sessionId]?.messages ?? []).some((message) => (
              message.deliveryStatus === 'accepted'
              && message.source !== 'server_pending'
          ));
          const requestMessages = read.request;
          const sessionEncryptionMode = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';

        const transcriptAuthority = this.resolveTranscriptAuthority(session, externalSessionLink);
          const authorityKey = externalSessionTranscriptAuthorityKey(transcriptAuthority);
          const previousAuthorityKey = this.transcriptAuthorityKeyBySessionId.get(sessionId) ?? null;
          const loadedTranscript = storage.getState().sessionMessages[sessionId];
          const hasMaterializedMessages = Object.keys(loadedTranscript?.messagesById ?? {}).length > 0;
          const pageOptions = read.pageOptions;

          if (this.isExternalSessionTranscriptAuthorityFenced(sessionId, authorityKey)) {
              storage.getState().setSessionTranscriptLoadIssue(sessionId, {
                  kind: 'source_discontinuity',
              });
              return;
          }

          if (transcriptAuthority.kind === 'unavailable') {
              this.transcriptAuthorityKeyBySessionId.set(sessionId, authorityKey);
              storage.getState().setSessionTranscriptLoadIssue(sessionId, {
                  kind: 'authority_unavailable',
                  reason: transcriptAuthority.reason,
              });
              return;
          }

          if (transcriptAuthority.kind === 'live_agent' && externalSessionLink) {
              // A prior interrupted/legacy open can leave the store marked loaded while
              // materializing zero rows. Treat that state as cold for external transcripts:
              // catch-up reads only deltas and cannot recover the initial window, leaving the
              // reader with the blank list that a target jump appears to fix.
              if (!hasLoadedMessages || !hasMaterializedMessages) {
                  // A target/sidechain page can accept rows before initial loading
                  // completes. Retire that authority through the staged handoff too.
                  const replacesAcceptedAuthority = previousAuthorityKey !== authorityKey
                      && ((loadedTranscript?.reducerState.messageIds.size ?? 0) > 0
                          || this.getSessionTargetWindowState(sessionId).isWindowMode);
                  const fetchInitialAuthorityWindow = () =>
                      this.fetchExternalSessionMessages(sessionId, externalSessionLink,
                          replacesAcceptedAuthority ? { mode: 'replace' } : undefined);
                  const didApplyCurrentAuthority = await (hasLoadedMessages
                      ? this.withSessionCatchUpNewer(sessionId, fetchInitialAuthorityWindow)
                      : fetchInitialAuthorityWindow());
                  if (didApplyCurrentAuthority) {
                      this.transcriptAuthorityKeyBySessionId.set(sessionId, authorityKey);
                      this.externalSessionTranscriptFenceAuthorityKeyBySessionId.delete(sessionId);
                      storage.getState().setSessionTranscriptLoadIssue(sessionId, null);
                      if (hasExplicitTailProbe) {
                          this.explicitSessionTailProbeIds.delete(sessionId);
                      }
                  }
                  return;
              }

              let didApplyCurrentAuthority: boolean;
              if (previousAuthorityKey !== authorityKey) {
                  didApplyCurrentAuthority = await this.fetchExternalSessionMessages(
                      sessionId,
                      externalSessionLink,
                      { mode: 'replace' },
                  );
              } else {
                  didApplyCurrentAuthority = await this.catchUpExternalSessionMessages(sessionId, externalSessionLink);
              }
              if (didApplyCurrentAuthority) {
                  this.transcriptAuthorityKeyBySessionId.set(sessionId, authorityKey);
                  this.externalSessionTranscriptFenceAuthorityKeyBySessionId.delete(sessionId);
                  storage.getState().setSessionTranscriptLoadIssue(sessionId, null);
                  this.explicitSessionTailProbeIds.delete(sessionId);
              }
              return;
          }

          if (
              transcriptAuthority.kind === 'server_snapshot'
              || transcriptAuthority.kind === 'server_partial'
              || (
                  transcriptAuthority.kind === 'hosted'
                  && (
                      externalSessionLink !== null
                      || previousAuthorityKey !== null
                  )
                  && previousAuthorityKey !== authorityKey
              )
          ) {
              if (!hasLoadedMessages || !hasMaterializedMessages || previousAuthorityKey !== authorityKey) {
                  if (hasLoadedMessages && hasMaterializedMessages && !this.isExternalSessionLiveTail(sessionId)) {
                      this.deferredForwardLoadingSessions.add(sessionId);
                      return;
                  }
                  const replaceAuthorityWindow = () =>
                      this.replaceWithServerTranscript(session, transcriptAuthority, read);
                  const didCommit = await (hasLoadedMessages
                      ? this.withSessionCatchUpNewer(sessionId, replaceAuthorityWindow)
                      : replaceAuthorityWindow());
                  if (didCommit) {
                      storage.getState().setSessionTranscriptLoadIssue(sessionId, null);
                  }
              }
              this.explicitSessionTailProbeIds.delete(sessionId);
              return;
          }

          // A previous empty or interrupted open can leave a non-empty session hint with a loaded,
          // zero-row cache. Recover with a snapshot so catch-up does not preserve the blank projection.
          const needsSnapshotLoad = !hasLoadedMessages || (!hasMaterializedMessages && sessionSeqHint > 0);
          if (needsSnapshotLoad) {
              this.deferredForwardLoadingSessions.delete(sessionId);
              const fetchSnapshot = () => fetchAndApplyMessages({
                  sessionId,
                  serverId: read.serverId,
                  sessionEncryptionMode,
                  getSessionEncryption: (id) => read.encryption?.getSessionEncryption(id) ?? null,
                  isSessionKnown: read.isSessionKnown,
                  request: requestMessages,
                  sessionReceivedMessages: this.sessionReceivedMessages,
                  applyMessages: (sid, messages) => this.applyMessages(sid, messages, { activitySource: 'reconciliation' }),
                  onTaskLifecycleEvent: (event) => this.applySessionThinkingFromTaskLifecycle(sessionId, event),
                  markMessagesLoaded: (sid) => {
                      this.publishSessionMessagesHistoryStartCoverage(sid);
                      storage.getState().applyMessagesLoaded(sid);
                  },
                  onMessagesPage: (page) => {
                      this.updateSessionMessagesPaginationFromPage(sessionId, { scope: 'main' }, page, {
                          allowHasMoreInference: true, deferHistoryStartCoverage: true,
                      });
                  },
                  ...pageOptions,
                  log,
              });
              // A loaded zero-row transcript is warm state, not a first-ever load. When the
              // session shell now reports durable activity, this snapshot is the on-open catch-up
              // operation and must share the same canonical signal as every other newer repair.
              await (hasLoadedMessages
                  ? this.withSessionCatchUpNewer(sessionId, fetchSnapshot)
                  : fetchSnapshot());
              if (!pageOptions.isCurrent()) return;
              storage.getState().setSessionTranscriptLoadIssue(sessionId, null);
              if (hasExplicitTailProbe) {
                  this.explicitSessionTailProbeIds.delete(sessionId);
              }
              return;
          }

            const decision = decideMessageCatchUpPolicy({
                isForeground: this.isForeground && !this.pauseController.isPaused(),
                isSessionVisible: resolveSessionLiveConsumption(sessionId, read.serverId).isFullContentConsumer,
                isPinned,
                materializedMaxSeq: afterSeq,
                sessionSeqHint,
                offlineForMs,
                hasAcceptedLocalPending,
                hasExplicitTailProbe,
                hasDeferredNewer: this.hasDeferredNewerMessages(sessionId),
                thresholds: {
                    largeGapSeq: this.syncTuning.messageLargeGapSeq,
                    maxIncrementalPagesOnResume: this.syncTuning.messageMaxIncrementalPagesOnResume,
                    forceSnapshotOfflineMs: this.syncTuning.messageForceSnapshotOfflineMs,
                },
            });

          // §13: the on-open incremental/snapshot catch-up runs its newer fetches directly here
          // (NOT through `loadNewerMessages`), so it must bracket the catch-up signal itself —
          // otherwise opening a normal session that advanced in the background performs real
          // newer-message fetching with no "Catching up…" overlay. Idle/deferred decisions and
          // the first-ever snapshot load (handled earlier) are intentionally not bracketed.
          const isCatchUpWork = decision.kind === 'incremental_batched' || decision.kind === 'tail_reset_latest_page';
          const isCatchUpSessionCurrent = (): boolean => (
              read.isSessionKnown(sessionId) && pageOptions.isCurrent()
          );
          const canRefreshLiveTail = () => (
              (this.sessionViewport.get(sessionId)?.isPinned ?? true)
              && !this.getSessionTargetWindowState(sessionId).isWindowMode
              && this.isForeground
              && !this.pauseController.isPaused()
              && resolveSessionLiveConsumption(sessionId, read.serverId).isFullContentConsumer
          );
          const applyCatchUpDecision = () => applyMessageCatchUpDecision({
              decision,
              afterSeq,
              onIncrementalExhausted: () => canRefreshLiveTail() ? 'tail_reset_latest_page' : 'defer_forward_loading',
              fetchNewerPage: async (cursor) => {
                  const expectedGap = readTranscriptGap(this.deferredTranscriptState, sessionId);
                  const pageServerId = read.serverId;
                  const result = await fetchAndApplyNewerMessages({
                      sessionId,
                      serverId: pageServerId,
                      sessionEncryptionMode,
                      afterSeq: cursor,
                      limit: SESSION_MESSAGES_PAGE_SIZE,
                      getSessionEncryption: (id) => read.encryption?.getSessionEncryption(id) ?? null,
                      isSessionKnown: read.isSessionKnown,
                      request: requestMessages,
                      sessionReceivedMessages: this.sessionReceivedMessages,
                      applyMessages: (sid, messages) => {
                          if (isCatchUpSessionCurrent()) this.applyMessages(sid, messages, { activitySource: 'reconciliation' });
                      },
                      onNormalizedMessages: (messages) => {
                          if (isCatchUpSessionCurrent()) ingestWorkspaceMutationMessages(sessionId, messages, pageServerId);
                      },
                      onTaskLifecycleEvent: (event) => {
                          if (isCatchUpSessionCurrent()) this.applySessionThinkingFromTaskLifecycle(sessionId, event);
                      },
                      onMessagesPage: (page) => {
                          if (!isCatchUpSessionCurrent()) return;
                          this.updateSessionMessagesPaginationFromPage(sessionId, { scope: 'main' }, page, { allowHasMoreInference: true, direction: 'newer' });
                          this.deferredTranscriptState = acknowledgeTranscriptGap(this.deferredTranscriptState, sessionId, {
                              afterSeq: cursor, expectedGap, page,
                          });
                      },
                      ...pageOptions,
                      log,
                  });

                  return {
                      messagesCount: result.page.messages.length,
                      nextAfterSeq: result.page.nextAfterSeq ?? null,
                  };
              },
              fetchSnapshotLatestPage: async () => {
                  // Read at snapshot time, not decision time: the incremental-exhausted
                  // branch advanced the contiguous head with its newer pages first.
                  const prefixMaxSeqBeforeSnapshot = this.readSessionMessagesCatchUpAfterSeq(sessionId);
                  const expectedGap = readTranscriptGap(this.deferredTranscriptState, sessionId);
                  await fetchAndApplyMessages({
                      sessionId,
                      shouldContinue: () => {
                          if (!isCatchUpSessionCurrent()) return false;
                          if (canRefreshLiveTail()) return true;
                          this.deferredForwardLoadingSessions.add(sessionId);
                          return false;
                      },
                      serverId: read.serverId,
                      sessionEncryptionMode,
                      getSessionEncryption: (id) => read.encryption?.getSessionEncryption(id) ?? null,
                      isSessionKnown: read.isSessionKnown,
                      request: requestMessages,
                      sessionReceivedMessages: this.sessionReceivedMessages,
                      applyMessages: (sid, messages) => {
                          if (isCatchUpSessionCurrent()) this.applyMessages(sid, messages, { activitySource: 'reconciliation' });
                      },
                      onTaskLifecycleEvent: (event) => {
                          if (isCatchUpSessionCurrent()) this.applySessionThinkingFromTaskLifecycle(sessionId, event);
                      },
                      markMessagesLoaded: (sid) => {
                          if (isCatchUpSessionCurrent()) {
                              this.publishSessionMessagesHistoryStartCoverage(sid);
                              storage.getState().applyMessagesLoaded(sid);
                          }
                      },
                      onMessagesPage: (page) => {
                          if (!isCatchUpSessionCurrent()) return;
                          this.updateSessionMessagesPaginationFromPage(sessionId, { scope: 'main' }, page, {
                              allowHasMoreInference: true, deferHistoryStartCoverage: true,
                          });
                          this.openSessionTailDiscontinuityFromSnapshotPage(sessionId, prefixMaxSeqBeforeSnapshot, page);
                          this.deferredTranscriptState = acknowledgeTranscriptGap(this.deferredTranscriptState, sessionId, {
                              afterSeq: prefixMaxSeqBeforeSnapshot, expectedGap, page,
                          });
                      },
                      ...pageOptions,
                      log,
                  });
              },
              markLoaded: () => {
                  if (isCatchUpSessionCurrent()) storage.getState().applyMessagesLoaded(sessionId);
              },
              setDeferredForwardLoading: (deferred) => {
                  if (!isCatchUpSessionCurrent()) return;
                  if (deferred) {
                      this.deferredForwardLoadingSessions.add(sessionId);
                  } else {
                      this.deferredForwardLoadingSessions.delete(sessionId);
                  }
              },
          });
          await (isCatchUpWork
              ? this.withSessionCatchUpNewer(sessionId, applyCatchUpDecision)
              : applyCatchUpDecision());
          if (hasExplicitTailProbe && isCatchUpSessionCurrent()) {
              this.explicitSessionTailProbeIds.delete(sessionId);
          }
          if (isCatchUpWork && isCatchUpSessionCurrent()) {
              this.markSocketOfflineCatchUpConsumedForSession(sessionId, offlineForMs);
          }
          if (isCatchUpSessionCurrent()) {
              storage.getState().setSessionTranscriptLoadIssue(sessionId, null);
          }
          });
      }

      private buildSessionMessagesPaginationKey(params: Readonly<{
          sessionId: string;
          scope: SessionMessagesScope;
          sidechainId?: string | null;
      }>): string {
          const sessionId = params.sessionId;
          if (params.scope === 'main') return `${sessionId}:main`;
          const sidechainId = typeof params.sidechainId === 'string' ? params.sidechainId.trim() : '';
          if (!sidechainId) {
              throw new Error('sidechainId is required for sidechain transcript paging');
          }
          return `${sessionId}:sidechain:${sidechainId}`;
      }

      private deleteSessionMessagesPaginationStateForSession(sessionId: string): void {
          if (this.sessionMessagesTailDiscontinuityBySessionId.has(sessionId)) {
              this.commitSessionTailDiscontinuity(sessionId, null);
          }
          const prefix = `${sessionId}:`;
          for (const key of this.sessionMessagesBeforeSeqByKey.keys()) {
              if (key.startsWith(prefix)) {
                  this.sessionMessagesBeforeSeqByKey.delete(key);
              }
          }
          for (const key of this.sessionMessagesHasMoreOlderByKey.keys()) {
              if (key.startsWith(prefix)) {
                  this.sessionMessagesHasMoreOlderByKey.delete(key);
              }
          }
          for (const key of this.sessionMessagesPaginationSupportedByKey.keys()) {
              if (key.startsWith(prefix)) {
                  this.sessionMessagesPaginationSupportedByKey.delete(key);
              }
          }
          for (const key of [...this.sessionMessagesFetchLatestInFlightByKey]) {
              if (key.startsWith(prefix)) {
                  this.sessionMessagesFetchLatestInFlightByKey.delete(key);
              }
          }
          for (const key of [...this.sessionMessagesFetchedLatestByKey]) {
              if (key.startsWith(prefix)) {
                  this.sessionMessagesFetchedLatestByKey.delete(key);
              }
          }
          for (const key of [...this.sessionMessagesLoadingOlderByKey]) {
              if (key.startsWith(prefix)) {
                  this.sessionMessagesLoadingOlderByKey.delete(key);
              }
          }
          for (const key of [...this.sessionMessagesLoadingNewerByKey]) {
              if (key.startsWith(prefix)) {
                  this.sessionMessagesLoadingNewerByKey.delete(key);
              }
          }
          this.externalSessionOlderCursorBySessionId.delete(sessionId);
          this.externalSessionHasMoreOlderBySessionId.delete(sessionId);
          this.clearExternalSessionTailCursor(sessionId);
      }

      private getExternalSessionServerScope(sessionId: string): string | undefined {
          return resolvePreferredServerIdForSessionId(sessionId);
      }

      private getExternalSessionTailCursor(sessionId: string): string | null {
          const cached = this.externalSessionTailStateBySessionId.get(sessionId);
          if (typeof cached !== 'undefined') {
              if (cached.cursor === null) return null;
              const parsed = ExternalSessionRefreshCursorV1Schema.safeParse(cached.cursor);
              if (parsed.success) return parsed.data;
              this.externalSessionTailStateBySessionId.set(sessionId, { ...cached, cursor: null });
              saveExternalSessionTailCursor(
                  sessionId,
                  null,
                  this.getExternalSessionCursorScope(sessionId),
              );
              return null;
          }
          const persisted = loadExternalSessionTailCursor(sessionId, this.getExternalSessionCursorScope(sessionId));
          this.externalSessionTailStateBySessionId.set(sessionId, { cursor: persisted, recoveryRequired: false });
          return persisted;
      }

      private markExternalSessionTranscriptRecoveryRequired(sessionId: string): void {
          // A reset cursor can appear valid again after the source regrows. Keep
          // the accepted window and remember the observed discontinuity until
          // its staged replacement succeeds, even when the reader is detached.
          this.externalSessionTailStateBySessionId.set(sessionId, {
              cursor: this.getExternalSessionTailCursor(sessionId),
              recoveryRequired: true,
          });
          this.deferredForwardLoadingSessions.add(sessionId);
          storage.getState().setSessionTranscriptLoadIssue(sessionId, { kind: 'source_discontinuity' });
      }

      getAcceptedExternalSessionTailCursor(sessionId: string): string | null {
          return this.getExternalSessionTailCursor(sessionId);
      }

      subscribeAcceptedExternalSessionTailCursor(
          sessionId: string,
          listener: () => void,
      ): () => void {
          const listeners =
              this.externalSessionTailCursorListenersBySessionId.get(sessionId)
              ?? new Set<() => void>();
          listeners.add(listener);
          this.externalSessionTailCursorListenersBySessionId.set(sessionId, listeners);
          return () => {
              listeners.delete(listener);
              if (listeners.size === 0) {
                  this.externalSessionTailCursorListenersBySessionId.delete(sessionId);
              }
          };
      }

      private notifyAcceptedExternalSessionTailCursorChanged(sessionId: string): void {
          for (
              const listener
              of this.externalSessionTailCursorListenersBySessionId.get(sessionId) ?? []
          ) {
              listener();
          }
      }

      private setExternalSessionTailCursor(sessionId: string, cursor: string | null): void {
          const parsed = ExternalSessionRefreshCursorV1Schema.safeParse(cursor);
          const normalized = parsed.success ? parsed.data : null;
          const previous = this.getExternalSessionTailCursor(sessionId);
          const accepted = this.externalSessionTailStateBySessionId.get(sessionId);
          // Continuous tail growth preserves this accepted window's identity,
          // so it cannot invalidate a healthy older-page request. Reset and
          // observed discontinuity replace the record instead.
          if (accepted) accepted.cursor = normalized;
          else this.externalSessionTailStateBySessionId.set(sessionId, { cursor: normalized, recoveryRequired: false });
          saveExternalSessionTailCursor(sessionId, normalized, this.getExternalSessionCursorScope(sessionId));
          if (previous !== normalized) {
              this.notifyAcceptedExternalSessionTailCursorChanged(sessionId);
          }
      }

      private clearExternalSessionTailCursor(sessionId: string): void {
          const previous = this.getExternalSessionTailCursor(sessionId);
          this.externalSessionTailStateBySessionId.delete(sessionId);
          saveExternalSessionTailCursor(sessionId, null, this.getExternalSessionCursorScope(sessionId));
          if (previous !== null) {
              this.notifyAcceptedExternalSessionTailCursorChanged(sessionId);
          }
      }

      private isExternalSessionTranscriptAuthorityFenced(
          sessionId: string,
          authorityKey: string,
      ): boolean {
          return this.externalSessionTranscriptFenceAuthorityKeyBySessionId.get(sessionId) === authorityKey;
      }

      private fenceExternalSessionTranscriptAuthority(
          sessionId: string,
          authorityKey: string,
      ): void {
          // Keep the prior transcript visible, but remove every cursor and pagination fact
          // that could let this proven-replaced authority apply another source window.
          this.resetSessionTranscriptState(sessionId, { resetMessages: false });
          this.externalSessionTranscriptFenceAuthorityKeyBySessionId.set(sessionId, authorityKey);
          storage.getState().setSessionTranscriptLoadIssue(sessionId, {
              kind: 'source_discontinuity',
          });
      }

      private createServerScopeGuard(): () => boolean {
          const generation = this.serverScopeGeneration;
          const scope = this.embedSessionScope;
          return () => this.serverScopeGeneration === generation && (!scope || this.embedSessionScope === scope && scope.isCurrent());
      }

      private async fetchExternalSessionMessages(
          sessionId: string,
          externalSessionLink: ReturnType<typeof readExternalSessionLink> extends infer T ? Exclude<T, null> : never,
          options?: Readonly<{ mode: 'replace' | 'merge_latest' }>,
      ): Promise<boolean> {
          if (options && !this.isExternalSessionLiveTail(sessionId)) {
              this.deferredForwardLoadingSessions.add(sessionId);
              return false;
          }
          const serverScopeIsCurrent = this.createServerScopeGuard();
          const initialSession = storage.getState().sessions[sessionId] ?? null;
          if (!initialSession) return false;
          const expectedAuthorityKey = externalSessionTranscriptAuthorityKey(
              this.resolveTranscriptAuthority(initialSession, externalSessionLink),
          );
          const acceptedCursor = this.getExternalSessionTailCursor(sessionId);
          const acceptedWindow = this.externalSessionTailStateBySessionId.get(sessionId);
          const prefixMessageIds = options?.mode === 'merge_latest' ? this.readExternalSessionPrefixMessageIds(sessionId) : [];
          const prefixMaterializedMessageIds = options?.mode === 'merge_latest'
              ? storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst ?? [] : [];
          const authorityIsCurrent = () => {
              if (!serverScopeIsCurrent()) return false;
              if (this.isExternalSessionTranscriptAuthorityFenced(sessionId, expectedAuthorityKey)) {
                  return false;
              }
              const currentSession = storage.getState().sessions[sessionId] ?? null;
              if (!currentSession) return false;
              return externalSessionTranscriptAuthorityKey(
                  this.resolveTranscriptAuthority(
                      currentSession,
                      readExternalSessionLinkFromSession(currentSession),
                  ),
              ) === expectedAuthorityKey;
          };
          const shouldContinue = () => authorityIsCurrent()
              && this.externalSessionTailStateBySessionId.get(sessionId) === acceptedWindow
              && this.getExternalSessionTailCursor(sessionId) === acceptedCursor;
          const stagedPages: Array<Readonly<{
              items: ExternalSessionTranscriptRawMessageV1[];
              nextCursor: string | null;
          }>> = [];
          const applyOrStagePage = async (page: Readonly<{
              items: ExternalSessionTranscriptRawMessageV1[];
              nextCursor: string | null;
          }>): Promise<void> => {
              if (!shouldContinue()) return;
              stagedPages.push(page);
          };
          const initialWindow = await readInitialTranscriptSourceWindow({
              shouldContinue,
              pageOlder: async () => {
                  const page = await this.withSessionRequestLifetime(undefined, signal => machineExternalSessionTranscriptPage({
                      machineId: externalSessionLink.machineId,
                      agentId: externalSessionLink.agentId,
                      remoteSessionId: externalSessionLink.remoteSessionId,
                      source: externalSessionLink.source,
                      direction: 'older',
                  }, { serverId: this.getExternalSessionServerScope(sessionId), signal }));
                  if (!page.ok) {
                      if (shouldContinue()) {
                          storage.getState().setSessionTranscriptLoadIssue(sessionId, {
                              kind: 'read_failed',
                              errorCode: page.errorCode,
                          });
                      }
                      throw new ExternalSessionTranscriptRpcError(page.errorCode, page.error);
                  }
                  return {
                      items: page.items,
                      nextCursor: page.nextCursor ?? null,
                      tailCursor: page.tailCursor ?? null,
                      hasMore: page.hasMore === true,
                      truncated: page.truncated === true,
                  };
              },
              readAfter: async ({ cursor }) => {
                  const tail = await this.withSessionRequestLifetime(undefined, signal => machineExternalSessionTranscriptReadAfter({
                      machineId: externalSessionLink.machineId,
                      agentId: externalSessionLink.agentId,
                      remoteSessionId: externalSessionLink.remoteSessionId,
                      source: externalSessionLink.source,
                      cursor,
                  }, { serverId: this.getExternalSessionServerScope(sessionId), signal }));
                  if (!tail.ok) {
                      if (shouldContinue()) {
                          storage.getState().setSessionTranscriptLoadIssue(sessionId, {
                              kind: 'read_failed',
                              errorCode: tail.errorCode,
                          });
                      }
                      throw new ExternalSessionTranscriptRpcError(tail.errorCode, tail.error);
                  }
                  return {
                      items: tail.items,
                      nextCursor: tail.nextCursor ?? null,
                      truncated:
                          externalSessionTranscriptReadAfterRequiresResyncV1(
                              tail,
                              cursor,
                          ),
                  };
              },
              onPageItems: applyOrStagePage,
              onTailItems: applyOrStagePage,
          });
          if (!shouldContinue()) return false;

          if (initialWindow.truncated === true) {
              storage.getState().setSessionTranscriptLoadIssue(sessionId, {
                  kind: 'source_discontinuity',
              });
              return false;
          }

          if (options) {
              if (!shouldContinue()) return false;
              if (!this.isExternalSessionLiveTail(sessionId)) {
                  this.deferredForwardLoadingSessions.add(sessionId);
                  return false;
              }
              if (options.mode === 'replace') this.resetSessionTranscriptState(sessionId, { resetMessages: false });
          }
          // The request was admitted above; its own replacement retires the old
          // cursor record. Keep the authority fence without rejecting that commit.
          if (!authorityIsCurrent()) return false;
          const applied = this.applyExternalSessionTranscriptPages(
              sessionId,
              stagedPages,
              expectedAuthorityKey,
              { replaceExisting: options?.mode === 'replace' },
          );
          if (!applied) return false;
          if (options?.mode === 'merge_latest') {
              const previous = this.sessionMessagesTailDiscontinuityBySessionId.get(sessionId);
              this.commitSessionTailDiscontinuity(sessionId, openTailDiscontinuityFromOpaqueSnapshot({
                  prev: previous?.kind === 'opaque' ? previous : null,
                  prefixMessageIds, prefixMaterializedMessageIds,
                  snapshotMessageIds: applied.sourceMessageIds,
                  snapshotMaterializedMessageIds: applied.changedMessageIds,
                  nextCursor: initialWindow.hasMoreOlder ? initialWindow.olderCursor : null,
              }));
          } else {
              this.externalSessionOlderCursorBySessionId.set(sessionId, initialWindow.olderCursor);
              this.externalSessionHasMoreOlderBySessionId.set(sessionId, initialWindow.hasMoreOlder);
          }
          const nextWindow = this.externalSessionTailStateBySessionId.get(sessionId);
          if (nextWindow) this.externalSessionTailStateBySessionId.set(sessionId, { ...nextWindow, recoveryRequired: false });
          if (options?.mode !== 'replace') {
              storage.getState().applyMessagesLoaded(sessionId);
          }
          storage.getState().setSessionTranscriptLoadIssue(sessionId, null);
          this.deferredForwardLoadingSessions.delete(sessionId);
          return true;
      }

      private isExternalSessionLiveTail(sessionId: string): boolean {
          return this.getSessionViewport(sessionId)?.isPinned !== false
              && !this.getSessionTargetWindowState(sessionId).isWindowMode;
      }

      private readExternalSessionSourceMessageIds(
          items: ReadonlyArray<ExternalSessionTranscriptRawMessageV1>,
          sourceIdentity: Readonly<{ agentId: string; remoteSessionId: string }>,
      ): readonly string[] {
          return items.map((item) => makeExternalSessionHistoricalImportLocalId({ ...sourceIdentity, directItemId: item.id }));
      }

      private recordExternalSessionSourcePage(
          sessionId: string,
          items: ReadonlyArray<ExternalSessionTranscriptRawMessageV1>,
          sourceIdentity: Readonly<{ agentId: string; remoteSessionId: string }>,
      ): readonly string[] {
          const ids = this.readExternalSessionSourceMessageIds(items, sourceIdentity);
          const accepted = this.externalSessionTailStateBySessionId.get(sessionId);
          if (accepted && ids.length > 0) accepted.lastSourceMessageIds = ids;
          return ids;
      }

      private readExternalSessionPrefixMessageIds(sessionId: string): readonly string[] {
          const receipt = this.externalSessionTailStateBySessionId.get(sessionId)?.lastSourceMessageIds;
          if (receipt?.length) return receipt;
          const reducer = storage.getState().sessionMessages[sessionId]?.reducerState;
          if (!reducer) return [];
          // Warm caches retain canonical source-namespaced IDs, not raw provider
          // IDs. These use the same Protocol identity as new page receipts.
          const ids = new Set(reducer.messageIds.keys());
          for (const message of reducer.messages.values()) if (message.realID) ids.add(message.realID);
          return [...ids];
      }

      private readExternalSessionPageMaterializedIds(
          sessionId: string,
          messages: readonly NormalizedMessage[],
          changed: readonly string[],
      ): readonly string[] {
          const reducer = storage.getState().sessionMessages[sessionId]?.reducerState;
          const ids = new Set(changed);
          for (const message of messages) {
              const id = reducer?.messageIds.get(message.id)
                  ?? (message.localId ? reducer?.localIds.get(message.localId) : undefined);
              if (id) ids.add(id);
          }
          return [...ids];
      }

      /**
       * Canonical bracket for newer-catch-up work that has no other co-lifecycle to release the
       * §13 signal: the on-open incremental/snapshot catch-up (`fetchMessages`), the external-session
       * tail catch-up, stale-region repair, and reconnect invalidation all funnel through here so the bottom-anchored
       * CatchUpProgressOverlay shows for the full duration. Ref-counting (see TranscriptLoadingDomain)
       * makes overlapping brackets safe (e.g. an on-open catch-up overlapping a resume drain), and the
       * finally guarantees release on every return/throw path. (`loadNewerMessages` brackets the same
       * signal inline because its begin/end share one lifecycle with its paging-key guard.)
       */
      private async withSessionCatchUpNewer<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
          storage.getState().beginSessionCatchUpNewer(sessionId);
          try {
              return await work();
          } finally {
              storage.getState().endSessionCatchUpNewer(sessionId);
          }
      }

      private async catchUpExternalSessionMessages(
          sessionId: string,
          externalSessionLink: ReturnType<typeof readExternalSessionLink> extends infer T ? Exclude<T, null> : never,
          options?: Readonly<{ allowAdjacentPage?: boolean }>,
      ): Promise<boolean> {
          const canApplyInCurrentViewport = () => !this.getSessionTargetWindowState(sessionId).isWindowMode
              && (options?.allowAdjacentPage === true || this.isExternalSessionLiveTail(sessionId));
          if (!canApplyInCurrentViewport()) {
              this.deferredForwardLoadingSessions.add(sessionId);
              return false;
          }
          // §13 catch-up signal: surface the bottom-anchored CatchUpProgressOverlay while the resume
          // catch-up runs. `withSessionCatchUpNewer` ref-counts begin/end (see TranscriptLoadingDomain)
          // so overlapping flows for one session compose correctly and release on every return path.
          return await this.withSessionCatchUpNewer(sessionId, async () => {
              if (this.externalSessionTailStateBySessionId.get(sessionId)?.recoveryRequired) {
                  return await this.fetchExternalSessionMessages(sessionId, externalSessionLink, { mode: 'replace' });
              }
              const serverScopeIsCurrent = this.createServerScopeGuard();
              const initialSession = storage.getState().sessions[sessionId] ?? null;
              if (!initialSession) return false;
              const expectedAuthorityKey = externalSessionTranscriptAuthorityKey(
                  this.resolveTranscriptAuthority(initialSession, externalSessionLink),
              );
              const acceptedCursor = this.getExternalSessionTailCursor(sessionId);
              const acceptedWindow = this.externalSessionTailStateBySessionId.get(sessionId);
              const shouldContinue = () => {
                  if (!serverScopeIsCurrent()) return false;
                  if (this.externalSessionTailStateBySessionId.get(sessionId) !== acceptedWindow
                      || this.getExternalSessionTailCursor(sessionId) !== acceptedCursor) return false;
                  if (this.isExternalSessionTranscriptAuthorityFenced(sessionId, expectedAuthorityKey)) {
                      return false;
                  }
                  const currentSession = storage.getState().sessions[sessionId] ?? null;
                  if (!currentSession) return false;
                  return externalSessionTranscriptAuthorityKey(
                      this.resolveTranscriptAuthority(
                          currentSession,
                          readExternalSessionLinkFromSession(currentSession),
                      ),
                      ) === expectedAuthorityKey;
              };
              const cursor = acceptedCursor ?? 'tail';
              let hasMore = false;
              let recoveryRequired = false;
              const stagedPages: Array<Readonly<{
                  items: ReadonlyArray<ExternalSessionTranscriptRawMessageV1>;
                  nextCursor: string | null;
              }>> = [];
              const tail = await catchUpTranscriptSourceWindow({
                  cursor,
                  shouldContinue,
                  readAfter: async ({ cursor: nextCursor }) => {
                      const response = await this.withSessionRequestLifetime(undefined, signal => machineExternalSessionTranscriptReadAfter({
                          machineId: externalSessionLink.machineId,
                          agentId: externalSessionLink.agentId,
                          remoteSessionId: externalSessionLink.remoteSessionId,
                          source: externalSessionLink.source,
                          cursor: nextCursor,
                      }, { serverId: this.getExternalSessionServerScope(sessionId), signal }));
                      if (!response.ok) {
                          if (shouldContinue()) {
                              storage.getState().setSessionTranscriptLoadIssue(sessionId, {
                                  kind: 'read_failed',
                                  errorCode: response.errorCode,
                              });
                          }
                          throw new ExternalSessionTranscriptRpcError(response.errorCode, response.error);
                      }
                      hasMore = response.hasMore === true;
                      recoveryRequired = externalSessionTranscriptReadAfterRequiresResyncV1(
                          response, nextCursor, { allowAdjacentPage: true },
                      );
                      return {
                          items: response.items,
                          nextCursor: response.nextCursor ?? null,
                          truncated:
                              externalSessionTranscriptReadAfterRequiresResyncV1(
                                  response,
                                  nextCursor,
                                  { allowAdjacentPage: options?.allowAdjacentPage === true && !this.isExternalSessionLiveTail(sessionId) },
                              ),
                      };
                  },
                  onItems: async (page) => {
                      if (!shouldContinue()) return;
                      stagedPages.push(page);
                  },
              });
              if (!shouldContinue()) return false;
              if (recoveryRequired) this.markExternalSessionTranscriptRecoveryRequired(sessionId);
              if (!canApplyInCurrentViewport()) {
                  this.deferredForwardLoadingSessions.add(sessionId);
                  return false;
              }

              if (tail.truncated === true) {
                  this.deferredForwardLoadingSessions.add(sessionId);
                  return await this.fetchExternalSessionMessages(sessionId, externalSessionLink, {
                      mode: recoveryRequired ? 'replace' : 'merge_latest',
                  });
              }
              const didApply = this.applyExternalSessionTranscriptPages(
                  sessionId,
                  stagedPages,
                  expectedAuthorityKey,
              );
              if (didApply) {
                  if (hasMore) this.deferredForwardLoadingSessions.add(sessionId);
                  else this.deferredForwardLoadingSessions.delete(sessionId);
              }
              return didApply !== null;
          });
      }

      private collectLoadedExternalSessionsForResume(): Array<{ sessionId: string; externalSessionLink: ExternalSessionLink }> {
          const state = storage.getState();
          const loadedExternalSessions: Array<{ sessionId: string; externalSessionLink: ExternalSessionLink }> = [];
          for (const [sessionId, messages] of Object.entries(state.sessionMessages)) {
              if (messages?.isLoaded !== true) continue;
              if (!resolveSessionLiveConsumption(sessionId, this.getExternalSessionServerScope(sessionId)).isFullContentConsumer) continue;
              const session = state.sessions[sessionId] ?? null;
              const externalSessionLink = readExternalSessionLink(
                  session ? readSessionOwnerMetadataView(session) : null,
              );
              if (!externalSessionLink) continue;
              loadedExternalSessions.push({ sessionId, externalSessionLink });
          }
          return loadedExternalSessions;
      }

      private async catchUpLoadedExternalSessionsOnResume(): Promise<void> {
          const loadedExternalSessions = this.collectLoadedExternalSessionsForResume();
          if (loadedExternalSessions.length === 0) return;

          await runTasksWithLimit(
              loadedExternalSessions.map(({ sessionId }) => async () => {
                  try {
                      await this.fetchMessages(sessionId);
                  } catch (error) {
                      syncReliabilityTelemetry.recordCritical('sync.externalSession.resumeCatchUpFailed', {
                          sessionId,
                          message: error instanceof Error ? error.message : String(error),
                      });
                  }
              }),
              this.syncTuning.messageCatchUpConcurrencyLimit,
          );
      }

      private async loadOlderMessagesForChain(params: Readonly<{
          sessionId: string;
          scope: SessionMessagesScope;
          sidechainId?: string | null;
          beforeSeqOverride?: number;
          limit?: number;
      }>): Promise<TranscriptOlderPageLoadResult> {
          if (params.scope === 'main') {
              const session = storage.getState().sessions[params.sessionId] ?? null;
              const externalSessionLink = readExternalSessionLink(
                  session ? readSessionOwnerMetadataView(session) : null,
              );
              const transcriptAuthority = session
                  ? this.resolveTranscriptAuthority(session, externalSessionLink)
                  : null;
              if (externalSessionLink && transcriptAuthority?.kind === 'live_agent') {
                  const authorityKey = externalSessionTranscriptAuthorityKey(transcriptAuthority);
                  if (this.isExternalSessionTranscriptAuthorityFenced(params.sessionId, authorityKey)) {
                      return {
                          loaded: 0,
                          hasMore: this.externalSessionHasMoreOlderBySessionId.get(params.sessionId) ?? false,
                          status: 'not_ready',
                      };
                  }
                  const appliedAuthorityKey = this.transcriptAuthorityKeyBySessionId.get(params.sessionId) ?? null;
                  if (appliedAuthorityKey !== null && appliedAuthorityKey !== authorityKey) {
                      await this.fetchMessages(params.sessionId);
                      return {
                          loaded: 0,
                          hasMore: this.externalSessionHasMoreOlderBySessionId.get(params.sessionId) ?? true,
                          status: 'not_ready',
                      };
                  }
                  if (this.externalSessionTailStateBySessionId.get(params.sessionId)?.recoveryRequired) {
                      await this.fetchExternalSessionMessages(params.sessionId, externalSessionLink, { mode: 'replace' });
                      return {
                          loaded: 0,
                          hasMore: this.externalSessionHasMoreOlderBySessionId.get(params.sessionId) ?? true,
                          status: 'not_ready',
                      };
                  }
                  const loadingKey = `${params.sessionId}:direct`;
                  if (this.sessionMessagesLoadingOlderByKey.has(loadingKey)) {
                      return {
                          loaded: 0,
                          hasMore: this.externalSessionHasMoreOlderBySessionId.get(params.sessionId) ?? true,
                          status: 'in_flight',
                      };
                  }

                  const knownHasMore = this.externalSessionHasMoreOlderBySessionId.get(params.sessionId);
                  const recordedGap = this.sessionMessagesTailDiscontinuityBySessionId.get(params.sessionId);
                  const opaqueGap = recordedGap?.kind === 'opaque' ? recordedGap : null;
                  if (opaqueGap ? opaqueGap.walkCursor === null : knownHasMore === false) {
                      return { loaded: 0, hasMore: false, status: 'no_more' };
                  }

                  const cursor = opaqueGap?.walkCursor ?? this.externalSessionOlderCursorBySessionId.get(params.sessionId) ?? null;
                  if (!cursor) {
                      return { loaded: 0, hasMore: knownHasMore ?? false, status: 'not_ready' };
                  }

                  this.sessionMessagesLoadingOlderByKey.add(loadingKey);
                  try {
                      const serverScopeIsCurrent = this.createServerScopeGuard();
                      const acceptedWindow = this.externalSessionTailStateBySessionId.get(params.sessionId);
                      const shouldContinue = () => {
                          if (!serverScopeIsCurrent()) return false;
                          if (this.externalSessionTailStateBySessionId.get(params.sessionId) !== acceptedWindow) return false;
                          if (this.isExternalSessionTranscriptAuthorityFenced(params.sessionId, authorityKey)) {
                              return false;
                          }
                          const currentSession = storage.getState().sessions[params.sessionId] ?? null;
                          if (!currentSession) return false;
                          return externalSessionTranscriptAuthorityKey(
                              this.resolveTranscriptAuthority(
                                  currentSession,
                                  readExternalSessionLinkFromSession(currentSession),
                              ),
                          ) === authorityKey;
                      };
                      const requestedLimit =
                          typeof params.limit === 'number' && Number.isFinite(params.limit)
                              ? resolveSessionMessagesPageSize({ limit: params.limit })
                              : null;
                      const page = await this.withSessionRequestLifetime(undefined, signal => machineExternalSessionTranscriptPage({
                          machineId: externalSessionLink.machineId,
                          agentId: externalSessionLink.agentId,
                          remoteSessionId: externalSessionLink.remoteSessionId,
                          source: externalSessionLink.source,
                          direction: 'older',
                          cursor,
                          ...(requestedLimit !== null ? { maxItems: requestedLimit } : {}),
                      }, { serverId: this.getExternalSessionServerScope(params.sessionId), signal }));
                      if (!shouldContinue()) {
                          return { loaded: 0, hasMore: knownHasMore ?? true, status: 'not_ready' };
                      }

                      if (!page.ok) {
                          throw new Error(page.error);
                      }

                      // Discontinuity admission runs BEFORE normalization, row application and the
                      // cursor commit. `truncated` means the provider could not serve history
                      // continuous with the cursor we asked from — a physical source replacement or
                      // rotation — so the returned rows are NOT older history for the accepted
                      // transcript. Splicing them in and committing their `nextCursor` would publish
                      // replacement data as if it were the session's own past and permanently
                      // strand the real prefix behind an unaccounted cursor.
                      //
                      // Apply zero rows, keep the accepted cursor, and delegate to the SAME
                      // replacement hydration the tail catch-up already uses.
                      // The accepted tail state retains this recovery intent while
                      // detached; it is distinct from a replaced-authority fence.
                      if (page.truncated === true) {
                          this.markExternalSessionTranscriptRecoveryRequired(params.sessionId);
                          await this.fetchExternalSessionMessages(params.sessionId, externalSessionLink, {
                              mode: 'replace',
                          });
                          return {
                              loaded: 0,
                              hasMore: this.externalSessionHasMoreOlderBySessionId.get(params.sessionId)
                                  ?? knownHasMore
                                  ?? true,
                              status: 'not_ready',
                          };
                      }

                      const sourceMessageIds = this.readExternalSessionSourceMessageIds(page.items, externalSessionLink);
                      if (opaqueGap && page.hasMore === true && page.nextCursor === cursor
                          && applyTailDiscontinuityOpaqueOlderPage({
                              prev: opaqueGap, pageMessageIds: sourceMessageIds, pageMaterializedMessageIds: [], nextCursor: cursor,
                          }) !== null) {
                          console.error('Failed to load older external session messages: page cursor did not advance');
                          return { loaded: 0, hasMore: true, status: 'not_ready' };
                      }
                      const normalizedMessages = normalizeExternalSessionTranscriptMessages(page.items, {
                          agentId: externalSessionLink.agentId,
                          remoteSessionId: externalSessionLink.remoteSessionId,
                      });
                      let changedMessageIds: readonly string[] = [];
                      if (normalizedMessages.length > 0) {
                          changedMessageIds = this.applyMessages(params.sessionId, normalizedMessages, { notifyVoice: false }).changed;
                      }
                      if (opaqueGap) {
                          const nextGap = applyTailDiscontinuityOpaqueOlderPage({
                              prev: opaqueGap, pageMessageIds: sourceMessageIds,
                              pageMaterializedMessageIds: this.readExternalSessionPageMaterializedIds(params.sessionId, normalizedMessages, changedMessageIds),
                              nextCursor: page.hasMore ? page.nextCursor ?? null : null,
                          });
                          this.commitSessionTailDiscontinuity(params.sessionId, nextGap);
                          const hasMore = nextGap ? nextGap.walkCursor !== null : knownHasMore ?? false;
                          return { loaded: normalizedMessages.length, hasMore, status: hasMore ? 'loaded' : 'no_more' };
                      }

                      this.externalSessionOlderCursorBySessionId.set(params.sessionId, page.nextCursor ?? null);
                      this.externalSessionHasMoreOlderBySessionId.set(params.sessionId, page.hasMore === true);

                      return {
                          loaded: normalizedMessages.length,
                          hasMore: page.hasMore === true,
                          status: page.hasMore === true ? 'loaded' : 'no_more',
                      };
                  } catch (error) {
                      console.error('Failed to load older direct session messages:', error);
                      // A FAILED read, not an empty page: rows and the accepted older cursor are
                      // untouched, so the reader must see the failure and be able to retry it.
                      return { loaded: 0, hasMore: knownHasMore ?? true, status: 'retryable_error' };
                  } finally {
                      this.sessionMessagesLoadingOlderByKey.delete(loadingKey);
                      this.replayDeferredMessagesFetch(params.sessionId);
                  }
              }
              if (transcriptAuthority?.kind === 'unavailable') {
                  return { loaded: 0, hasMore: false, status: 'not_ready' };
              }
          }

          const pagingKey = this.buildSessionMessagesPaginationKey({
              sessionId: params.sessionId,
              scope: params.scope,
              sidechainId: params.sidechainId,
          });

          if (this.sessionMessagesLoadingOlderByKey.has(pagingKey)) {
              return {
                  loaded: 0,
                  hasMore: this.sessionMessagesHasMoreOlderByKey.get(pagingKey) ?? true,
                  status: 'in_flight',
              };
          }

          const knownHasMore = this.sessionMessagesHasMoreOlderByKey.get(pagingKey);
          const normalizedBeforeSeqOverride =
              typeof params.beforeSeqOverride === 'number' && Number.isFinite(params.beforeSeqOverride)
                  ? Math.max(1, Math.trunc(params.beforeSeqOverride))
                  : null;
          const recordedBeforeSeq = this.sessionMessagesBeforeSeqByKey.get(pagingKey) ?? null;
          // Tail-reset discontinuity walk: while a hole is open on the main chain, plain
          // older loads page DOWN FROM THE TAIL ISLAND (hole-fill), never from the
          // monotone-min cursor — that cursor still points below the pre-gap prefix and
          // paging from it skipped the hole forever. Cursor-override loads (fork parent
          // context) keep legacy behavior and never advance the walk.
          const recordedDiscontinuity = params.scope === 'main' && normalizedBeforeSeqOverride === null
              ? this.sessionMessagesTailDiscontinuityBySessionId.get(params.sessionId) ?? null
              : null;
          const tailDiscontinuity = recordedDiscontinuity?.kind === 'seq' ? recordedDiscontinuity : null;
          if (
              knownHasMore === false
              && (
                  normalizedBeforeSeqOverride === null
                  || (typeof recordedBeforeSeq === 'number' && recordedBeforeSeq <= normalizedBeforeSeqOverride)
              )
          ) {
              return { loaded: 0, hasMore: false, status: 'no_more' };
          }

          const supported = this.sessionMessagesPaginationSupportedByKey.get(pagingKey);
          if (supported === false) {
              return { loaded: 0, hasMore: false, status: 'no_more' };
          }

          const beforeSeq = tailDiscontinuity?.walkCursor ?? normalizedBeforeSeqOverride ?? recordedBeforeSeq;
          if (!beforeSeq) {
              // Pagination state is initialized during the initial `/messages` fetch. If we haven't
              // seen it yet, don't permanently disable pagination on the UI side.
              return { loaded: 0, hasMore: knownHasMore ?? true, status: 'not_ready' };
          }

          this.sessionMessagesLoadingOlderByKey.add(pagingKey);
          const session = storage.getState().sessions[params.sessionId] ?? null;
          const sessionEncryptionMode = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
          try {
              return await this.withSessionTranscriptRead<TranscriptOlderPageLoadResult>(params.sessionId, async read => {
              const pageOptions = read.pageOptions;
              const result = await fetchAndApplyOlderMessages({
                  sessionId: params.sessionId,
                  serverId: read.serverId,
                  sessionEncryptionMode,
                  beforeSeq,
                  limit: resolveSessionMessagesPageSize({ limit: params.limit }),
                  scope: params.scope,
                  sidechainId: params.sidechainId ?? null,
                  getSessionEncryption: (id) => read.encryption?.getSessionEncryption(id) ?? null,
                  isSessionKnown: read.isSessionKnown,
                  request: read.request,
                  sessionReceivedMessages: this.sessionReceivedMessages,
                  applyMessages: (sid, messages) => this.applyMessages(sid, messages, { notifyVoice: false }),
                  ...pageOptions,
                  log,
              });

              // The page pipeline can return its missing-session sentinel after
              // decrypt. Do not reinterpret that empty page as terminal history:
              // delete-wins must leave pagination and deferred state absent.
              if (!read.isSessionKnown(params.sessionId) || !pageOptions.isCurrent()) {
                  return { loaded: 0, hasMore: knownHasMore ?? true, status: 'not_ready' };
              }

              if (result.page.messages.length === 0) {
                  this.updateSessionMessagesPaginationFromPage(
                      params.sessionId,
                      { scope: params.scope, sidechainId: params.sidechainId ?? null },
                      result.page,
                      { allowHasMoreInference: true },
                  );
                  if (tailDiscontinuity !== null) {
                      const nextDiscontinuity = applyTailDiscontinuityOlderPage({
                          prev: tailDiscontinuity,
                          pageMinSeq: null,
                          nextBeforeSeq: typeof result.page.nextBeforeSeq === 'number'
                              ? result.page.nextBeforeSeq
                              : null,
                      });
                      // Terminal network exhaustion does not make the stale prefix
                      // contiguous. Keep the canonical discontinuity record (and its
                      // deepest prefix authority) while hasMore=false stops this walk.
                      // A later tail reset can then restart from a new island without
                      // forgetting the still-disconnected prefix.
                      if (
                          nextDiscontinuity !== null
                          || typeof result.page.nextBeforeSeq === 'number'
                      ) {
                          this.commitSessionTailDiscontinuity(params.sessionId, nextDiscontinuity);
                      }
                      if (nextDiscontinuity !== null) {
                          return { loaded: 0, hasMore: true, status: 'loaded' };
                      }
                  }
                  if (normalizedBeforeSeqOverride !== null) {
                      const currentBeforeSeq = this.sessionMessagesBeforeSeqByKey.get(pagingKey);
                      this.sessionMessagesBeforeSeqByKey.set(
                          pagingKey,
                          typeof currentBeforeSeq === 'number'
                              ? Math.min(currentBeforeSeq, normalizedBeforeSeqOverride)
                              : normalizedBeforeSeqOverride,
                      );
                  }
                  const hasMore = this.sessionMessagesHasMoreOlderByKey.get(pagingKey) ?? false;
                  return {
                      loaded: 0,
                      hasMore,
                      status: hasMore ? 'loaded' : 'no_more',
                  };
              }

              this.updateSessionMessagesPaginationFromPage(
                  params.sessionId,
                  { scope: params.scope, sidechainId: params.sidechainId ?? null },
                  result.page,
                  { allowHasMoreInference: true },
              );

              if (tailDiscontinuity !== null) {
                  let pageMinSeq: number | null = null;
                  for (const message of result.page.messages) {
                      if (typeof message.seq === 'number' && Number.isFinite(message.seq)) {
                          pageMinSeq = pageMinSeq === null ? message.seq : Math.min(pageMinSeq, message.seq);
                      }
                  }
                  const nextDiscontinuity = applyTailDiscontinuityOlderPage({
                      prev: tailDiscontinuity,
                      pageMinSeq,
                      nextBeforeSeq: typeof result.page.nextBeforeSeq === 'number' ? result.page.nextBeforeSeq : null,
                  });
                  this.commitSessionTailDiscontinuity(params.sessionId, nextDiscontinuity);
                  if (nextDiscontinuity !== null) {
                      // The hole is still open: more older content exists by construction.
                      return { loaded: result.applied, hasMore: true, status: 'loaded' };
                  }
              }

              const hasMore = this.sessionMessagesHasMoreOlderByKey.get(pagingKey) ?? false;
              if (hasMore === false) {
                  return { loaded: result.applied, hasMore: false, status: 'no_more' };
              }

              return { loaded: result.applied, hasMore, status: 'loaded' };
              });
          } catch (error) {
              console.error('Failed to load older messages:', error);
              // A FAILED read, not an empty page: `beforeSeq` and the applied rows are
              // untouched, so the reader must see the failure and be able to retry it.
              return { loaded: 0, hasMore: knownHasMore ?? true, status: 'retryable_error' };
          } finally {
              this.sessionMessagesLoadingOlderByKey.delete(pagingKey);
              this.replayDeferredMessagesFetch(params.sessionId);
          }
      }

      public async loadOlderMessages(sessionId: string, options?: LoadOlderMessagesOptions): Promise<TranscriptOlderPageLoadResult> {
          if (options?.authority) {
              const authority = options.authority;
              const normalizedSessionId = String(sessionId ?? '').trim();
              const isCurrent = (): boolean => this.isServerAccountSessionReadCurrent(
                  authority,
                  normalizedSessionId,
              );
              if (
                  !normalizedSessionId
                  || !isCurrent()
              ) {
                  return { loaded: 0, hasMore: true, status: 'not_ready' };
              }
              const pagingKey = this.buildSessionMessagesPaginationKey({
                  sessionId: normalizedSessionId,
                  scope: 'main',
              });
              const knownHasMore = this.sessionMessagesHasMoreOlderByKey.get(pagingKey);
              if (knownHasMore === false) {
                  return { loaded: 0, hasMore: false, status: 'no_more' };
              }
              const beforeSeq = this.sessionMessagesBeforeSeqByKey.get(pagingKey) ?? null;
              if (!beforeSeq) {
                  return {
                      loaded: 0,
                      hasMore: knownHasMore ?? true,
                      status: 'not_ready',
                  };
              }
              const session = storage.getState().sessions[normalizedSessionId] ?? null;
              const result = await fetchAndApplyOlderMessages({
                  sessionId: normalizedSessionId,
                  serverId: authority.scope.serverId,
                  sessionEncryptionMode: session?.encryptionMode === 'plain' ? 'plain' : 'e2ee',
                  beforeSeq,
                  limit: resolveSessionMessagesPageSize({ limit: options.limit }),
                  scope: 'main',
                  getSessionEncryption: (id) =>
                      this.getSessionMessagesEncryptionForAuthority(authority, id),
                  isSessionKnown: () => isCurrent(),
                  request: (path) => authority.request(path, { method: 'GET' }),
                  sessionReceivedMessages: new Map(),
                  applyMessages: (sid, messages) => {
                      if (isCurrent()) {
                          this.applyMessages(sid, messages, { notifyVoice: false });
                      }
                  },
                  onMessagesPage: (page) => {
                      if (isCurrent()) {
                          this.updateSessionMessagesPaginationFromPage(
                              normalizedSessionId,
                              { scope: 'main' },
                              page,
                              { allowHasMoreInference: true },
                          );
                      }
                  },
                  ...this.getSessionMessagesPageOptions(normalizedSessionId, authority),
                  log,
              });
              if (!isCurrent()) {
                  return { loaded: 0, hasMore: true, status: 'not_ready' };
              }
              const hasMore = this.sessionMessagesHasMoreOlderByKey.get(pagingKey)
                  ?? result.page.hasMore === true;
              return {
                  loaded: result.applied,
                  hasMore,
                  status: hasMore ? 'loaded' : 'no_more',
              };
          }
          return this.loadOlderMessagesForChain({ sessionId, scope: 'main', limit: options?.limit });
      }

      public async loadOlderMessagesFromCursor(sessionId: string, beforeSeq: number, options?: LoadOlderMessagesOptions): Promise<TranscriptOlderPageLoadResult> {
          return this.loadOlderMessagesForChain({ sessionId, scope: 'main', beforeSeqOverride: beforeSeq, limit: options?.limit });
      }

      private readTargetWindowTargetSeq(target: LoadTargetWindowMessagesTarget): number | null {
          const raw = target.kind === 'seq' ? target.seq : target.seqHint;
          return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : null;
      }

      private buildTargetWindowId(
          sessionId: string,
          target: LoadTargetWindowMessagesTarget,
          targetSeq: number,
      ): string {
          if (target.kind === 'seq') {
              return `${sessionId}:main:seq:${targetSeq}`;
          }
          return `${sessionId}:main:route:${encodeURIComponent(target.routeMessageId)}:seq:${targetSeq}`;
      }

      private isRouteMessageIdLoaded(sessionId: string, routeMessageId: string): boolean {
          const sessionMessages = storage.getState().sessionMessages[sessionId];
          if (!sessionMessages) return false;
          return resolveSessionMessageRouteId({
              routeMessageId,
              messagesById: sessionMessages.messagesById,
              reducerState: sessionMessages.reducerState,
          }) !== null;
      }

      private readonly inactiveSessionMessagesWindowState = createInactiveSessionMessagesWindowState();
      private sessionTargetWindowStateListeners = new Map<string, Set<() => void>>();

      public getSessionTargetWindowState(sessionId: string): SessionMessagesWindowState {
          const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
          if (!normalizedSessionId) return this.inactiveSessionMessagesWindowState;
          return this.sessionMessagesWindowStateBySessionId.get(normalizedSessionId)
              ?? this.inactiveSessionMessagesWindowState;
      }

      public subscribeSessionTargetWindowState(sessionId: string, listener: () => void): () => void {
          const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
          if (!normalizedSessionId) return () => undefined;
          let listeners = this.sessionTargetWindowStateListeners.get(normalizedSessionId);
          if (!listeners) {
              listeners = new Set();
              this.sessionTargetWindowStateListeners.set(normalizedSessionId, listeners);
          }
          listeners.add(listener);
          return () => {
              listeners?.delete(listener);
              if (listeners && listeners.size === 0) {
                  this.sessionTargetWindowStateListeners.delete(normalizedSessionId);
              }
          };
      }

      private notifySessionTargetWindowStateListeners(sessionId: string): void {
          const listeners = this.sessionTargetWindowStateListeners.get(sessionId);
          if (!listeners) return;
          for (const listener of [...listeners]) {
              listener();
          }
      }

      private setSessionTargetWindowState(sessionId: string, state: SessionMessagesWindowState): void {
          this.sessionMessagesWindowStateBySessionId.set(sessionId, state);
          this.notifySessionTargetWindowStateListeners(sessionId);
      }

      public async loadTargetWindowMessages(
          sessionId: string,
          target: LoadTargetWindowMessagesTarget,
          options?: LoadTargetWindowMessagesOptions,
      ): Promise<LoadTargetWindowMessagesResult> {
          const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
          const targetSeq = this.readTargetWindowTargetSeq(target);
          let windowId = normalizedSessionId && targetSeq !== null
              ? this.buildTargetWindowId(normalizedSessionId, target, targetSeq)
              : '';
          const currentWindowState = normalizedSessionId
              ? this.getSessionTargetWindowState(normalizedSessionId)
              : createInactiveSessionMessagesWindowState();
          if (options?.continuationWindowId) {
              if (!currentWindowState.isWindowMode || currentWindowState.windowId !== options.continuationWindowId
                  || currentWindowState.targetSeq !== targetSeq || options.direction === 'initial') {
                  return {
                      status: 'stale', windowId, targetSeq: targetSeq ?? 0, targetPresent: false, rawSeqs: [], appliedSeqs: [],
                      olderCursor: currentWindowState.olderCursor, newerCursor: currentWindowState.newerCursor,
                      hasMoreOlder: currentWindowState.hasMoreOlder, hasMoreNewer: currentWindowState.hasMoreNewer,
                  };
              }
              windowId = options.continuationWindowId;
          }
          if (!normalizedSessionId || targetSeq === null) {
              return {
                  status: 'not_ready',
                  windowId,
                  targetSeq: targetSeq ?? 0,
                  targetPresent: false,
                  rawSeqs: [],
                  appliedSeqs: [],
                  olderCursor: currentWindowState.olderCursor,
                  newerCursor: currentWindowState.newerCursor,
                  hasMoreOlder: currentWindowState.hasMoreOlder,
                  hasMoreNewer: currentWindowState.hasMoreNewer,
              };
          }

          const session = storage.getState().sessions[normalizedSessionId] ?? null;
          const externalSessionLink = readExternalSessionLink(
              session ? readSessionOwnerMetadataView(session) : null,
          );
          const transcriptAuthority = session
              ? this.resolveTranscriptAuthority(session, externalSessionLink)
              : null;
          if (
              transcriptAuthority?.kind === 'live_agent'
              || transcriptAuthority?.kind === 'unavailable'
          ) {
              return {
                  status: 'not_ready',
                  windowId,
                  targetSeq,
                  targetPresent: false,
                  rawSeqs: [],
                  appliedSeqs: [],
                  olderCursor: currentWindowState.olderCursor,
                  newerCursor: currentWindowState.newerCursor,
                  hasMoreOlder: currentWindowState.hasMoreOlder,
                  hasMoreNewer: currentWindowState.hasMoreNewer,
              };
          }

          const sessionEncryptionMode = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
          const direction = options?.direction === 'older' || options?.direction === 'newer'
              ? options.direction
              : 'initial';

          try {
              return await this.withSessionTranscriptRead(normalizedSessionId, read => fetchAndApplyTargetWindowMessages({
                  sessionId: normalizedSessionId,
                  serverId: read.serverId,
                  windowId,
                  target,
                  direction,
                  limit: resolveSessionMessagesPageSize({ limit: options?.limit }),
                  scope: 'main',
                  sessionEncryptionMode,
                  getSessionEncryption: (id) => read.encryption?.getSessionEncryption(id) ?? null,
                  isSessionKnown: read.isSessionKnown,
                  isRouteMessageIdLoaded: (routeMessageId) => this.isRouteMessageIdLoaded(normalizedSessionId, routeMessageId),
                  request: read.request,
                  sessionReceivedMessages: this.sessionReceivedMessages,
                  applyMessages: (sid, messages) => this.applyMessages(sid, messages, { notifyVoice: false }),
                  getWindowState: () => this.getSessionTargetWindowState(normalizedSessionId),
                  setWindowState: (state) => this.setSessionTargetWindowState(normalizedSessionId, state),
                  now: () => Date.now(),
                  ...read.pageOptions,
                  log,
              }));
          } catch (error) {
              console.error('Failed to load target-window messages:', error);
              const state = this.getSessionTargetWindowState(normalizedSessionId);
              return {
                  status: isRetryableTargetWindowLoadError(error)
                      ? 'retryable_error'
                      : 'not_ready',
                  windowId,
                  targetSeq,
                  targetPresent: false,
                  rawSeqs: [],
                  appliedSeqs: [],
                  olderCursor: state.olderCursor,
                  newerCursor: state.newerCursor,
                  hasMoreOlder: state.hasMoreOlder,
                  hasMoreNewer: state.hasMoreNewer,
              };
          }
      }

      /**
       * A live Agent transcript has exactly ONE read authority and ONE cursor: the bounded
       * global Agent page walked by `loadOlderMessagesForChain`. Sidechain rows are not a
       * separate stream — they arrive in that same page carrying `sidechainId`, and the
       * reducer indexes them under it. There is no Agent sidechain read, and the hosted
       * server `/messages` sidechain scope is NOT peer authority here: the common apply
       * boundary correctly drops every persisted server row for a `live_agent` session, so
       * asking the server can only apply zero rows while looking like a completed load.
       */
      private isLiveAgentTranscriptSession(sessionId: string): boolean {
          const session = storage.getState().sessions[sessionId] ?? null;
          if (!session) return false;
          const externalSessionLink = readExternalSessionLinkFromSession(session);
          if (!externalSessionLink) return false;
          return this.resolveTranscriptAuthority(session, externalSessionLink).kind === 'live_agent';
      }

      private readLoadedSidechainRowCount(sessionId: string, sidechainId: string): number {
          return storage.getState().sessionMessages[sessionId]
              ?.reducerState
              ?.sidechains
              ?.get(sidechainId)
              ?.length
              ?? 0;
      }

      /**
       * Demand hydration for a live-Agent sidechain: the child rows either are already in
       * the common store or lie behind the session's own older Agent history. Advance the
       * one global cursor by a single page per call and report progress through the
       * existing statuses, so the caller's demand-retry owner drives the walk and no second
       * loop, timer or cursor is introduced here. `no_more` is an authoritative answer:
       * with the Agent history exhausted, an absent sidechain is empty, not pending.
       */
      private async ensureLiveAgentSidechainRowsLoaded(
          sessionId: string,
          sidechainId: string,
      ): Promise<'loaded' | 'not_ready' | 'in_flight'> {
          if (this.readLoadedSidechainRowCount(sessionId, sidechainId) > 0) return 'loaded';
          const older = await this.loadOlderMessagesForChain({ sessionId, scope: 'main' });
          if (this.readLoadedSidechainRowCount(sessionId, sidechainId) > 0) return 'loaded';
          switch (older.status) {
              case 'loaded':
              case 'in_flight':
                  return 'in_flight';
              case 'no_more':
                  return 'loaded';
              default:
                  return 'not_ready';
          }
      }

      public async ensureSidechainMessagesLoaded(sessionId: string, sidechainId: string): Promise<'loaded' | 'not_ready' | 'in_flight'> {
          const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
          const normalizedSidechainId = typeof sidechainId === 'string' ? sidechainId.trim() : '';
          if (!normalizedSessionId || !normalizedSidechainId) return 'not_ready';

          if (this.isLiveAgentTranscriptSession(normalizedSessionId)) {
              return await this.ensureLiveAgentSidechainRowsLoaded(normalizedSessionId, normalizedSidechainId);
          }

          const pagingKey = this.buildSessionMessagesPaginationKey({
              sessionId: normalizedSessionId,
              scope: 'sidechain',
              sidechainId: normalizedSidechainId,
          });

          // If we already have any pagination state (or have explicitly recorded a successful "latest" fetch),
          // treat the sidechain as initialized. This prevents re-fetch storms for empty/short sidechains where
          // `beforeSeq` may legitimately remain unset.
          if (
              this.sessionMessagesFetchedLatestByKey.has(pagingKey)
              || this.sessionMessagesBeforeSeqByKey.has(pagingKey)
              || this.sessionMessagesHasMoreOlderByKey.has(pagingKey)
              || this.sessionMessagesPaginationSupportedByKey.has(pagingKey)
          ) {
              return 'loaded';
          }

          if (this.sessionMessagesFetchLatestInFlightByKey.has(pagingKey)) {
              return 'in_flight';
          }

          this.sessionMessagesFetchLatestInFlightByKey.add(pagingKey);
          const session = storage.getState().sessions[normalizedSessionId] ?? null;
          const sessionEncryptionMode = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
          try {
              return await this.withSessionTranscriptRead<'loaded' | 'not_ready'>(normalizedSessionId, async read => {
              const pageOptions = read.pageOptions;
              await fetchAndApplyMessages({
                  sessionId: normalizedSessionId,
                  serverId: read.serverId,
                  sessionEncryptionMode,
                  scope: 'sidechain',
                  sidechainId: normalizedSidechainId,
                  getSessionEncryption: (id) => read.encryption?.getSessionEncryption(id) ?? null,
                  isSessionKnown: read.isSessionKnown,
                  request: read.request,
                  sessionReceivedMessages: this.sessionReceivedMessages,
                  applyMessages: (sid, messages) => this.applyMessages(sid, messages, { notifyVoice: false }),
                  markMessagesLoaded: () => {},
                  onMessagesPage: (page) => {
                      this.updateSessionMessagesPaginationFromPage(
                          normalizedSessionId,
                          { scope: 'sidechain', sidechainId: normalizedSidechainId },
                          page,
                          { allowHasMoreInference: true },
                      );
                  },
                  ...pageOptions,
                  log,
              });
              if (!pageOptions.isCurrent()) return 'not_ready';
              this.sessionMessagesFetchedLatestByKey.add(pagingKey);
              return 'loaded';
              });
          } catch (error) {
              console.error('Failed to fetch sidechain messages:', error);
              return 'not_ready';
          } finally {
              this.sessionMessagesFetchLatestInFlightByKey.delete(pagingKey);
          }
      }

      public async loadOlderSidechainMessages(sessionId: string, sidechainId: string): Promise<TranscriptOlderPageLoadResult> {
          const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
          const normalizedSidechainId = typeof sidechainId === 'string' ? sidechainId.trim() : '';
          if (!normalizedSessionId || !normalizedSidechainId) {
              return { loaded: 0, hasMore: true, status: 'not_ready' };
          }

          // Older sidechain history for a live Agent IS older global history; there is no
          // separate child cursor to initialize or advance.
          if (this.isLiveAgentTranscriptSession(normalizedSessionId)) {
              return await this.loadOlderMessagesForChain({
                  sessionId: normalizedSessionId,
                  scope: 'main',
              });
          }

          const pagingKey = this.buildSessionMessagesPaginationKey({
              sessionId: normalizedSessionId,
              scope: 'sidechain',
              sidechainId: normalizedSidechainId,
          });

          if (
              !this.sessionMessagesFetchedLatestByKey.has(pagingKey)
              && !this.sessionMessagesBeforeSeqByKey.has(pagingKey)
              && !this.sessionMessagesHasMoreOlderByKey.has(pagingKey)
              && !this.sessionMessagesPaginationSupportedByKey.has(pagingKey)
          ) {
              const init = await this.ensureSidechainMessagesLoaded(normalizedSessionId, normalizedSidechainId);
              if (init === 'in_flight') {
                  return { loaded: 0, hasMore: true, status: 'in_flight' };
              }
              if (init !== 'loaded') {
                  return { loaded: 0, hasMore: true, status: 'not_ready' };
              }
          }

          return this.loadOlderMessagesForChain({
              sessionId: normalizedSessionId,
              scope: 'sidechain',
              sidechainId: normalizedSidechainId,
          });
      }

        public async loadOlderMessagesForkAware(childSessionId: string, options?: LoadOlderMessagesOptions): Promise<TranscriptOlderPageLoadResult> {
            const fork = getForkedTranscriptSnapshotCached(storage.getState() as any, childSessionId);
            if (!fork) return this.loadOlderMessages(childSessionId, options);

            const request = resolveNextForkedTranscriptLoadOlderRequest({
                fork,
                getHasMoreOlder: (id) => {
                    const key = this.buildSessionMessagesPaginationKey({ sessionId: id, scope: 'main' });
                    return this.sessionMessagesHasMoreOlderByKey.get(key);
                },
                getBeforeSeqCursor: (id) => {
                    const key = this.buildSessionMessagesPaginationKey({ sessionId: id, scope: 'main' });
                    return this.sessionMessagesBeforeSeqByKey.get(key);
                },
            });
            if (!request) {
                return { loaded: 0, hasMore: false, status: 'no_more' };
            }

            if (request.sessionId !== childSessionId) {
                const hydration = await this.ensureSessionVisibleForMessageRoute(request.sessionId);
                if (hydration.kind !== 'available') {
                    return { loaded: 0, hasMore: true, status: 'not_ready' };
                }
            }

            const result =
                request.kind === 'loadOlderFromCursor'
                    ? await this.loadOlderMessagesFromCursor(request.sessionId, request.beforeSeq, options)
                    : await this.loadOlderMessages(request.sessionId, options);

            const overallHasMore = computeForkedTranscriptHasMoreOlder({
                fork,
                getHasMoreOlder: (id) => {
                    const key = this.buildSessionMessagesPaginationKey({ sessionId: id, scope: 'main' });
                    return this.sessionMessagesHasMoreOlderByKey.get(key);
                },
            });

            if (overallHasMore === false) {
                return { ...result, hasMore: false, status: 'no_more' };
            }
            // A forked transcript can page multiple segments (child first, then ancestors). If the selected
            // segment is exhausted (`status: no_more`) but older context remains in another segment, treat the
            // overall forked transcript as still having more. This avoids UI/FlashList consumers prematurely
            // terminating paging based on the segment-local status.
            const normalizedStatus = result.status === 'no_more' ? 'loaded' : result.status;
            return { ...result, hasMore: true, status: normalizedStatus };
        }

        /**
         * Prefetch fork ancestor context once nearer fork segments are exhausted.
         *
         * This does NOT materialize/copy messages into the child session. It only loads the relevant
         * ancestor session pages into the local cache (bounded by each segment's cutoff), and avoids
         * revealing older read-only context before the child transcript's own older pages are loaded.
         */
        public async prefetchForkedTranscriptContext(childSessionId: string): Promise<void> {
            const fork = getForkedTranscriptSnapshotCached(storage.getState() as any, childSessionId);
            if (!fork) return;

            const missingSegments = fork.segments.filter((seg, index) => {
                if (
                    seg.isReadOnlyContext !== true ||
                    typeof seg.cutoffSeqInclusive !== 'number' ||
                    !Number.isFinite(seg.cutoffSeqInclusive) ||
                    seg.cutoffSeqInclusive < 0 ||
                    (seg.messageIdsOldestFirst?.length ?? 0) > 0
                ) {
                    return false;
                }

                for (let i = index + 1; i < fork.segments.length; i += 1) {
                    const closerSegment = fork.segments[i];
                    if (!closerSegment) continue;
                    const key = this.buildSessionMessagesPaginationKey({ sessionId: closerSegment.sessionId, scope: 'main' });
                    if (this.sessionMessagesHasMoreOlderByKey.get(key) !== false) {
                        return false;
                    }
                }

                return true;
            });
            if (missingSegments.length === 0) return;

            for (const seg of missingSegments) {
                const hydration = await this.ensureSessionVisibleForMessageRoute(seg.sessionId);
                if (hydration.kind !== 'available') continue;

                const cutoff = Math.max(0, Math.trunc(seg.cutoffSeqInclusive as number));
                await this.loadOlderMessagesFromCursor(seg.sessionId, cutoff + 1).catch(() => {});
            }
        }

      public markSessionLiveTailIntent(sessionId: string): void {
          if (!sessionId) return;
          this.ensureSessionViewportHydrated();
          const hadDeferredForwardLoading = this.deferredForwardLoadingSessions.has(sessionId);
          this.sessionMessagesWindowStateBySessionId.set(
              sessionId,
              resetSessionMessagesWindowForLiveTail(this.getSessionTargetWindowState(sessionId)),
          );
          this.notifySessionTargetWindowStateListeners(sessionId);
          this.sessionViewport.set(sessionId, {
              isPinned: true,
              offsetY: 0,
              anchor: null,
              lastUpdatedAt: Date.now(),
              source: 'default',
          });
          // Another tab can write this session after this instance hydrates, so
          // durable live-tail deletion must not depend on an in-memory ID cache.
          deletePersistedSessionViewport(sessionId, getActiveServerAccountScope());
          if (hadDeferredForwardLoading) {
              this.getOrCreateMessagesSync(sessionId).invalidate();
          }
      }

      public onSessionViewportChange(sessionId: string, state: SessionViewportChangeState): void {
          if (!sessionId) return;
          this.ensureSessionViewportHydrated();
          if (state.shouldRestoreViewport !== true) {
              this.markSessionLiveTailIntent(sessionId);
              return;
          }
          if (state.isPinned === true) {
              const prevViewport = this.sessionViewport.get(sessionId);
              if (prevViewport?.source === 'observed' && prevViewport.isPinned === false) {
                  return;
              }
              this.markSessionLiveTailIntent(sessionId);
              return;
          }
          const prevViewport = this.sessionViewport.get(sessionId);
          const anchor = state.anchor === undefined
              ? prevViewport?.anchor ?? null
              : sanitizeSessionViewportAnchor(state.anchor);
          const offsetY = typeof state.offsetY === 'number' && Number.isFinite(state.offsetY)
              ? state.offsetY
              : prevViewport?.isPinned === false
                  ? prevViewport.offsetY
                  : 0;
          const lastUpdatedAt = Date.now();
          this.sessionViewport.set(sessionId, {
              isPinned: false,
              offsetY,
              anchor,
              lastUpdatedAt,
              source: 'observed',
          });
          if (state.shouldPersistViewport !== false) {
              this.persistSessionViewport(sessionId, { offsetY, anchor, lastUpdatedAt });
          }
      }

      public getSessionViewport(sessionId: string): SessionViewportSnapshot | null {
          if (!sessionId) return null;
          this.ensureSessionViewportHydrated();
          return this.sessionViewport.get(sessionId) ?? null;
      }

      private ensureSessionViewportHydrated(): void {
          if (this.embedSessionScope || isEmbedWindowContext()) return;
          const scope = getActiveServerAccountScope();
          const storageKey = sessionViewportStorageKey(scope);
          if (this.sessionViewportHydratedStorageKey === storageKey) return;
          this.sessionViewportHydratedStorageKey = storageKey;
          const persisted = loadPersistedSessionViewports(scope);
          for (const [sessionId, record] of Object.entries(persisted)) {
              if (this.sessionViewport.has(sessionId)) continue;
              this.sessionViewport.set(sessionId, {
                  isPinned: record.isPinned,
                  offsetY: record.offsetY,
                  anchor: record.anchor
                      ? {
                          kind: record.anchor.kind,
                          messageId: record.anchor.messageId,
                          seq: record.anchor.seq,
                          itemId: record.anchor.itemId,
                          itemOffsetPx: record.anchor.itemOffsetPx,
                          capturedAtMs: record.anchor.capturedAtMs,
                      }
                      : null,
                  lastUpdatedAt: record.lastUpdatedAt,
                  source: 'observed',
              });
          }
      }

      private persistSessionViewport(
          sessionId: string,
          snapshot: Readonly<{ offsetY: number; anchor: SessionViewportAnchorSnapshot | null; lastUpdatedAt: number }>,
      ): void {
          if (this.embedSessionScope || isEmbedWindowContext()) return;
          const capturedMessageId = snapshot.anchor?.messageId?.trim() ?? '';
          const durable = capturedMessageId
              ? this.resolveDurableSessionMessageIdentity(sessionId, capturedMessageId)
              : null;
          upsertPersistedSessionViewport(sessionId, {
              isPinned: false,
              offsetY: snapshot.offsetY,
              lastUpdatedAt: snapshot.lastUpdatedAt,
              anchor: snapshot.anchor && durable
                  ? {
                      kind: snapshot.anchor.kind,
                      messageId: durable.messageId,
                      seq: snapshot.anchor.seq ?? durable.seq,
                      itemId: snapshot.anchor.itemId,
                      itemOffsetPx: snapshot.anchor.itemOffsetPx,
                      capturedAtMs: snapshot.anchor.capturedAtMs,
                  }
                  : null,
          }, getActiveServerAccountScope());
      }

      private resolveDurableSessionMessageIdentity(
          sessionId: string,
          messageId: string,
      ): Readonly<{ messageId: string; seq: number | null }> {
          const session = storage.getState().sessionMessages[sessionId];
          const messagesById = session?.messagesById ?? {};
          let message = messagesById[messageId] ?? null;
          if (!message) {
              for (const candidate of Object.values(messagesById)) {
                  if (candidate?.realID === messageId) {
                      message = candidate;
                      break;
                  }
              }
          }
          if (!message) return { messageId, seq: null };
          const realId = typeof message.realID === 'string' && message.realID.trim() ? message.realID.trim() : null;
          const seq = typeof message.seq === 'number' && Number.isFinite(message.seq) ? message.seq : null;
          return { messageId: realId ?? messageId, seq };
      }

      public hasDeferredNewerMessages(sessionId: string): boolean {
          return this.deferredForwardLoadingSessions.has(sessionId);
      }

      /**
       * Live-tail demand belongs to the catch-up policy. Detached readers can
       * request one adjacent history page; target windows retain their own cursors.
       */
      public maybeDrainDeferredNewerMessages(
          sessionId: string,
          viewport: Readonly<{ isPinned: boolean; distanceFromBottomPx: number }>,
      ): void {
          if (!sessionId || !this.hasDeferredNewerMessages(sessionId)) return;
          if (this.getSessionTargetWindowState(sessionId).isWindowMode) return;
          if (viewport.isPinned || this.getSessionViewport(sessionId)?.isPinned !== false) {
              this.getOrCreateMessagesSync(sessionId).invalidateCoalesced();
              return;
          }
          if (viewport.distanceFromBottomPx > this.syncTuning.transcriptForwardPrefetchThresholdPx) return;
          fireAndForget(this.loadNewerMessages(sessionId), { tag: 'Sync.maybeDrainDeferredNewerMessages' });
      }

      public async loadNewerMessages(sessionId: string): Promise<{
          loaded: number;
          hasMore: boolean;
          status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
      }> {
          const pagingKey = this.buildSessionMessagesPaginationKey({ sessionId, scope: 'main' });
          if (this.sessionMessagesLoadingNewerByKey.has(pagingKey)) {
              return { loaded: 0, hasMore: true, status: 'in_flight' };
          }

          const externalSession = storage.getState().sessions[sessionId] ?? null;
          const externalSessionLink = readExternalSessionLinkFromSession(externalSession);
          if (externalSession && externalSessionLink) {
              const authority = this.resolveTranscriptAuthority(externalSession, externalSessionLink);
              if (authority.kind === 'live_agent') {
                  if (this.getSessionTargetWindowState(sessionId).isWindowMode
                      || this.transcriptAuthorityKeyBySessionId.get(sessionId) !== externalSessionTranscriptAuthorityKey(authority)) {
                      this.deferredForwardLoadingSessions.add(sessionId);
                      return { loaded: 0, hasMore: true, status: 'not_ready' };
                  }
                  this.sessionMessagesLoadingNewerByKey.add(pagingKey);
                  const beforeCount = storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst.length ?? 0;
                  try {
                      const didApply = await this.catchUpExternalSessionMessages(sessionId, externalSessionLink, { allowAdjacentPage: true });
                      const afterCount = storage.getState().sessionMessages[sessionId]?.messageIdsOldestFirst.length ?? 0;
                      const hasMore = this.deferredForwardLoadingSessions.has(sessionId);
                      return { loaded: Math.max(0, afterCount - beforeCount), hasMore,
                          status: !didApply ? 'not_ready' : hasMore ? 'loaded' : 'no_more' };
                  } finally {
                      this.sessionMessagesLoadingNewerByKey.delete(pagingKey);
                  }
              }
              if (authority.kind !== 'hosted') {
                  return { loaded: 0, hasMore: true, status: 'not_ready' };
              }
          }

          const supported = this.sessionMessagesPaginationSupportedByKey.get(pagingKey);
          if (supported === false) {
              return { loaded: 0, hasMore: false, status: 'no_more' };
          }

          const afterSeq = this.readSessionMessagesCatchUpAfterSeq(sessionId);
          if (!afterSeq && !readTranscriptGap(this.deferredTranscriptState, sessionId)) {
              return { loaded: 0, hasMore: true, status: 'not_ready' };
          }

          this.sessionMessagesLoadingNewerByKey.add(pagingKey);
          // §13 catch-up signal: the deferred-newer backlog drain is a genuine catch-up (it only fires
          // when a missed-while-away forward backlog exists), so surface the overlay while it runs.
          storage.getState().beginSessionCatchUpNewer(sessionId);
          const session = storage.getState().sessions[sessionId] ?? null;
          const sessionEncryptionMode = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
          try {
              return await this.withSessionTranscriptRead<Awaited<ReturnType<Sync['loadNewerMessages']>>>(sessionId, async read => {
              const pageOptions = read.pageOptions;
              const expectedGap = readTranscriptGap(this.deferredTranscriptState, sessionId);
              const pageServerId = read.serverId;
              const result = await fetchAndApplyNewerMessages({
                  sessionId,
                  serverId: pageServerId,
                  sessionEncryptionMode,
                  afterSeq,
                  limit: SESSION_MESSAGES_PAGE_SIZE,
                  getSessionEncryption: (id) => read.encryption?.getSessionEncryption(id) ?? null,
                  isSessionKnown: read.isSessionKnown,
                  request: read.request,
                  sessionReceivedMessages: this.sessionReceivedMessages,
                  applyMessages: (sid, messages) => this.applyMessages(sid, messages, { notifyVoice: false }),
                  onNormalizedMessages: (messages) => ingestWorkspaceMutationMessages(sessionId, messages, pageServerId),
                  onTaskLifecycleEvent: (event) => this.applySessionThinkingFromTaskLifecycle(sessionId, event),
                  onMessagesPage: (page) => {
                      this.updateSessionMessagesPaginationFromPage(sessionId, { scope: 'main' }, page, { allowHasMoreInference: true, direction: 'newer' });
                      this.deferredTranscriptState = acknowledgeTranscriptGap(this.deferredTranscriptState, sessionId, {
                          afterSeq, expectedGap, page,
                      });
                  },
                  ...pageOptions,
                  log,
              });

              if (!pageOptions.isCurrent()) return { loaded: 0, hasMore: true, status: 'not_ready' };
              if (result.page.messages.length === 0) {
                  this.deferredForwardLoadingSessions.delete(sessionId);
                  return { loaded: 0, hasMore: false, status: 'no_more' };
              }

              const hasMore = Boolean(result.page.nextAfterSeq);
              if (!hasMore) {
                  this.deferredForwardLoadingSessions.delete(sessionId);
                  return { loaded: result.applied, hasMore: false, status: 'no_more' };
              }

              return { loaded: result.applied, hasMore, status: 'loaded' };
              });
          } catch (error) {
              console.error('Failed to load newer messages:', error);
              return { loaded: 0, hasMore: true, status: 'loaded' };
          } finally {
              this.sessionMessagesLoadingNewerByKey.delete(pagingKey);
              storage.getState().endSessionCatchUpNewer(sessionId);
          }
      }

    private subscribeToUpdates = () => {
        apiSocket.onSessionConsumptionAdmitted(({ serverId, sessionIds }) => {
            const target = this.getAppliedTransportTarget();
            const credentials = this.credentials;
            if (!target || !areServerProfileIdentifiersEquivalent(serverId, target.serverId)) return;
            this.onSessionLiveConsumptionAdmittedForHome(serverId, sessionIds,
                () => this.credentials === credentials && this.isAppliedTransportTargetCurrent(target));
        });
        // Subscribe to message updates
        apiSocket.onMessage('update', this.handleUpdate.bind(this));
        apiSocket.onMessage('ephemeral', this.handleEphemeralUpdate.bind(this));
        // Broadcast-safe session events are optional hints; ignore by default.
        apiSocket.onMessage('session', () => {});

		          apiSocket.onStatusChange((status) => {
	              this.socketStatus = status;
	              if (status === 'connected') {
	                  const shouldClosePostSubscriptionGap = this.postSubscriptionChangesCatchUpPending;
	                  this.postSubscriptionChangesCatchUpPending = false;
	                  if (this.lastSocketDisconnectedAtMs != null) {
	                      this.lastSocketOfflineDurationMs = Date.now() - this.lastSocketDisconnectedAtMs;
	                      this.socketOfflineCatchUpConsumedSessionIds.clear();
		                  }
		                  this.lastSocketDisconnectedAtMs = null;
	                  if (shouldClosePostSubscriptionGap) {
	                      this.requestChangesCatchUp();
	                  }
		                  return;
		              }
		              if (status === 'disconnected' || status === 'error') {
                          if (!this.embedSessionScope && !isEmbedWindowContext()) this.publishActiveSessionListObservation('offline');
		                  if (this.lastSocketDisconnectedAtMs == null) {
		                      this.lastSocketDisconnectedAtMs = Date.now();
		                      this.lastSocketOfflineDurationMs = null;
		                      this.socketOfflineCatchUpConsumedSessionIds.clear();
		                  }
		              }
		          });

          // Subscribe to connection state changes
          apiSocket.onReconnected(() => {
              if (!this.embedSessionScope) {
                  // A completed change page cannot renew projections whose authority
                  // was lost with the transport but produced no durable Account row.
                  const serverId = this.getAppliedTransportTarget()?.serverId;
                  if (serverId) {
                      publishHomeAccountChange(serverId, undefined, { source: 'connected' });
                      publishMachineContributionRegistryProjectionReconnect(serverId);
                  }
              }
              fireAndForget(this.resumeSync('socket-reconnect'), { tag: 'Sync.resumeSync.socket-reconnect' });
          });
      }

      private async refetchStaleTranscriptRegion(
          sessionId: string,
          staleMinSeq: number | null,
          authoritativeUpdateMessageIds: ReadonlySet<string>,
          messageSeqs?: Readonly<Record<string, number>>,
      ): Promise<ReadonlySet<string>> {
          let resolvedMessageIds: ReadonlySet<string> = new Set<string>();
          if (typeof staleMinSeq !== 'number' || !Number.isFinite(staleMinSeq) || staleMinSeq <= 0) {
              this.getOrCreateMessagesSync(sessionId).invalidateCoalesced();
              return resolvedMessageIds;
          }
          if (!storage.getState().sessions[sessionId]) {
              return resolvedMessageIds;
          }
          const targets = [...authoritativeUpdateMessageIds].map((messageId) => ({
              messageId,
              seq: messageSeqs?.[messageId]
                  ?? this.resolveDurableSessionMessageIdentity(sessionId, messageId).seq
                  ?? staleMinSeq,
          }));
          const session = storage.getState().sessions[sessionId] ?? null;
          const sessionEncryptionMode = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
          // Hidden edits and changes-feed revisions can outlive the independent tail
          // probe, so their repair owns the catch-up signal until every page settles.
          return await this.withSessionCatchUpNewer(sessionId, () => this.withSessionTranscriptRead(sessionId, async read => {
              const pageServerId = read.serverId;
              try {
                  await fetchAndApplyTranscriptRepair({
                      sessionId,
                      serverId: pageServerId,
                      sessionEncryptionMode,
                      targets,
                      pageSize: SESSION_MESSAGES_PAGE_SIZE,
                      isMessageMaterialized: (id, localId) => {
                          const reducerState = storage.getState().sessionMessages[sessionId]?.reducerState;
                          if (reducerState?.messageIds.has(id)) return true;
                          const localMessageId = localId ? reducerState?.localIds.get(localId) : undefined;
                          return localMessageId !== undefined && reducerState?.messages.get(localMessageId)?.realID === id;
                      },
                      getSessionEncryption: (id) => read.encryption?.getSessionEncryption(id) ?? null,
                      isSessionKnown: read.isSessionKnown,
                      request: read.request,
                      sessionReceivedMessages: this.sessionReceivedMessages,
                      applyMessages: (sid, messages) => this.applyMessages(sid, messages, { notifyVoice: false }),
                      onNormalizedMessages: (messages) => ingestWorkspaceMutationMessages(sessionId, messages, pageServerId),
                      onResolvedMessageIds: (messageIds) => {
                          resolvedMessageIds = messageIds;
                      },
                      ...read.pageOptions,
                      log,
                  });
              } catch (error) {
                  console.error('Failed to refetch stale transcript region:', error);
              }

              return resolvedMessageIds;
          }));
	      }

      private repairStaleTranscriptIfNeeded(sessionId: string): void {
          if (!hasStaleTranscriptMarkers(this.deferredTranscriptState, sessionId)) return;
          // Both reopen and a late live hint repair exact rows in place, preserving older pages.
          fireAndForget(this.repairDeferredStaleTranscriptRegion(
              sessionId,
              readStaleTranscriptMinSeq(this.deferredTranscriptState, sessionId),
              new Set(readStaleTranscriptMessageIds(this.deferredTranscriptState, sessionId)),
              readStaleTranscriptMessageSeqs(this.deferredTranscriptState, sessionId),
          ), { tag: 'Sync.repairStaleTranscriptIfNeeded' });
      }

      private async repairDeferredStaleTranscriptRegion(
          sessionId: string,
          staleMinSeq: number | null,
          authoritativeUpdateMessageIds: ReadonlySet<string>,
          messageSeqs?: Readonly<Record<string, number>>,
      ): Promise<void> {
          const expectedMessageSeqs = readStaleTranscriptMessageSeqs(this.deferredTranscriptState, sessionId);
          const resolvedMessageIds = await this.refetchStaleTranscriptRegion(
              sessionId,
              staleMinSeq,
              authoritativeUpdateMessageIds,
              messageSeqs,
          );
          if (resolvedMessageIds.size === 0) return;
          this.deferredTranscriptState = clearResolvedStaleTranscriptMessageIds(
              this.deferredTranscriptState,
              sessionId,
              resolvedMessageIds,
              expectedMessageSeqs,
          );
      }

      private async repairSessionTranscriptRevision(
          repair: Readonly<{ sessionId: string; minSeq: number; messageIds: readonly string[]; messageSeqs?: Readonly<Record<string, number>> }>,
      ): Promise<void> {
          const resolvedMessageIds = await this.refetchStaleTranscriptRegion(
              repair.sessionId,
              repair.minSeq,
              new Set(repair.messageIds),
              repair.messageSeqs,
          );
          if (!repair.messageIds.every((messageId) => resolvedMessageIds.has(messageId))) {
              throw new Error('Durable transcript revision could not be materialized');
          }
      }

      private readTranscriptRetentionProtectedSessionIds(): ReadonlySet<string> {
          const protectedIds = new Set(readMountedSessionTranscriptConsumerSessionIdsForRetention());
          for (const sessionId of Object.keys(storage.getState().sessionMessages)) {
              if (protectedIds.has(sessionId)) continue;
              const liveConsumption = resolveSessionLiveConsumption(sessionId);
              if (liveConsumption.isVisible || liveConsumption.isFullContentConsumer) {
                  protectedIds.add(sessionId);
              }
          }
          return protectedIds;
      }

      /**
       * Canonical transcript memory release for bounded retention: drops the store
       * entry entirely (which also clears the per-session derived caches through
       * clearSessionTranscriptDerivedCachesForSession), resets sync-side per-session
       * transcript state so re-opening runs the first-open page-limited load pipeline,
       * and releases the session's live delta-assembly segments.
       */
      private evictSessionTranscript(sessionId: string): void {
          storage.getState().evictSessionMessages(sessionId);
          this.resetSessionTranscriptState(sessionId);
          syncPerformanceTelemetry.count('sync.sessions.transcript.evicted', { evicted: 1 });
      }

      /**
       * Canonical local half of an already-authoritative session deletion.
       * The server DELETE remains the authority; this is deliberately
       * idempotent so its later socket echo repeats the same teardown safely.
       *
       * `serverId` is the Home whose answer proved the absence. Omitting it retires the
       * id on every Home, which is only correct when the caller has no Home in hand.
       */
      public retireLocalSession(sessionId: string, serverId?: string | null): void {
          const normalizedServerId = String(serverId ?? '').trim() || null;
          handleDeleteSessionSocketUpdate({
              sessionId,
              serverId: normalizedServerId,
              // The socket teardown is addressed by the same Home this retirement is:
              // without it the socket falls back to the active Home and clears the
              // wrong addresses.
              dropSocketSessionWork: (targetSessionId, retireActiveCarrier) => dropSocketSessionWork(
                  targetSessionId,
                  normalizedServerId,
                  retireActiveCarrier,
              ),
              invalidateSessionHydration: this.invalidateDeletedSessionHydration,
              resetSessionTranscriptState: (targetSessionId) => this.resetSessionTranscriptState(targetSessionId),
              deleteSession: (targetSessionId, targetServerId) => storage.getState().deleteSession(targetSessionId, targetServerId),
              removeSessionEncryption: (targetSessionId) => this.encryption?.removeSessionEncryption(targetSessionId),
              removeProjectManagerSession: (targetSessionId) => projectManager.removeSession(targetSessionId),
              clearScmStatusForSession: (targetSessionId, carrierServerId) => scmStatusSync.clearForSession(targetSessionId, carrierServerId),
              log,
          });
      }

      private resetSessionTranscriptState(
          sessionId: string,
          options?: Readonly<{ resetMessages?: boolean }>,
      ): void {
          socketTranscriptStreamSegmentAssembler.releaseTranscriptStreamSegmentAssemblyForSession(sessionId);
          if (options?.resetMessages !== false) {
              storage.getState().resetSessionMessages(sessionId);
              this.externalSessionTranscriptFenceAuthorityKeyBySessionId.delete(sessionId);
          }
          storage.getState().setSessionTranscriptLoadIssue(sessionId, null);
          this.transcriptAuthorityKeyBySessionId.delete(sessionId);
          this.deferredTranscriptState = clearDeferredTranscriptStateForSession(this.deferredTranscriptState, sessionId);

          this.sessionReceivedMessages.delete(sessionId);
          this.deleteSessionMessagesPaginationStateForSession(sessionId);
          this.deferredMessagesFetchSessionIds.delete(sessionId);
          this.deferredForwardLoadingSessions.delete(sessionId);
          this.explicitSessionTailProbeIds.delete(sessionId);
          this.socketOfflineCatchUpConsumedSessionIds.delete(sessionId);
          this.sessionMessagesWindowStateBySessionId.set(
              sessionId,
              resetSessionMessagesWindowForSessionSwitch(this.getSessionTargetWindowState(sessionId)),
          );
          this.notifySessionTargetWindowStateListeners(sessionId);

          if ((this.sessionMaterializedMaxSeqById[sessionId] ?? 0) !== 0) {
              this.sessionMaterializedMaxSeqById = { ...this.sessionMaterializedMaxSeqById, [sessionId]: 0 };
              this.sessionMaterializedMaxSeqDirty = true;
              this.scheduleSessionMaterializedMaxSeqFlush();
          }
      }

        private getOrCreateMessagesSync(sessionId: string): InvalidateSync {
            let ex = this.messagesSync.get(sessionId);
            if (!ex) {
                ex = new InvalidateSync(() => this.fetchMessages(sessionId), {
                    pause: this.pauseController,
                    backoff: {
                        minDelayMs: this.syncTuning.invalidateSyncBackoffMinDelayMs,
                        maxDelayMs: this.syncTuning.invalidateSyncBackoffMaxDelayMs,
                        maxFailureCount: 'infinite',
                    },
                    shouldRetry: shouldRetrySyncInvalidation,
                });
                this.messagesSync.set(sessionId, ex);
            }
            return ex;
        }

    private flushChangesCursorNow(): void {
        // Changes cursors are synchronously persisted by decideChangesCursorCheckpoint.
        // Hidden/background lifecycle calls this as an idempotent safety hook.
    }

    private rememberBlockedChangesCursorLag(params: Readonly<{
        blockedCursor: string;
        blockedReason: string;
        safeAdvanceCursor: string | null;
        nowMs?: number;
    }>): void {
        this.safeCursorLagState = rememberBlockedCursorLag(this.safeCursorLagState, {
            blockedCursor: params.blockedCursor,
            blockedReason: params.blockedReason,
            safeAdvanceCursor: params.safeAdvanceCursor,
            nowMs: params.nowMs ?? Date.now(),
        });
    }

    private evaluateSafeCursorLagTripwireNow(nowMs: number = Date.now()): void {
        const evaluation = evaluateSafeCursorLagTripwire(this.safeCursorLagState, {
            nowMs,
            alertMs: this.syncTuning.safeCursorLagAlertMs,
        });
        this.safeCursorLagState = evaluation.state;
        if (!evaluation.event) return;
        syncReliabilityTelemetry.recordCritical('sync.cursor.safeCursorLagExceeded', {
            blockedCursor: evaluation.event.blockedCursor,
            blockedReason: evaluation.event.blockedReason,
            safeAdvanceCursor: evaluation.event.safeAdvanceCursor,
            lagMs: evaluation.event.lagMs,
            consecutiveOverThresholdTicks: evaluation.event.consecutiveOverThresholdTicks,
        });
    }

    private clearNativeInactiveCheckpointTimer(): void {
        if (!this.nativeInactiveCheckpointTimer) return;
        clearTimeout(this.nativeInactiveCheckpointTimer);
        this.nativeInactiveCheckpointTimer = null;
    }

    private flushBackgroundSyncCheckpointsNow(): void {
        try {
            this.flushPendingSettingsForCurrentScopeNow();
        } catch {
            // ignore
        }
        try {
            this.flushSessionMaterializedMaxSeq();
        } catch {
            // ignore
        }
        try {
            this.flushChangesCursorNow();
        } catch {
            // ignore
        }
    }

    private scheduleNativeInactiveCheckpoint(): void {
        this.clearNativeInactiveCheckpointTimer();
        const debounceMs = this.syncTuning.nativeInactiveCheckpointDebounceMs;
        if (debounceMs <= 0) {
            if (!this.isForeground) {
                this.flushBackgroundSyncCheckpointsNow();
            }
            return;
        }
        this.nativeInactiveCheckpointTimer = setTimeout(() => {
            this.nativeInactiveCheckpointTimer = null;
            if (!this.isForeground) {
                this.flushBackgroundSyncCheckpointsNow();
            }
        }, debounceMs);
    }

      private async resumeViaChanges(opts: {
          accountId: string;
          shouldContinue?: () => boolean;
          signal?: AbortSignal;
          allowOfflineSnapshotRefresh?: boolean;
      }): Promise<ResumeViaChangesOutcome> {
          const CHANGES_PAGE_LIMIT = this.syncTuning.changesPageLimit;
          const embedScope = this.embedSessionScope;
          const afterCursor = this.changesCursor;
          const shouldContinue = () => (opts.shouldContinue?.() ?? true)
              && (!embedScope || this.embedSessionScope === embedScope && embedScope.isCurrent());
          const invalidateForResume = async (syncUnit: InvalidateSync): Promise<void> => {
              if (!shouldContinue()) throw new SupersededOperationError();
              await syncUnit.invalidateAndAwait({ signal: opts.signal });
          };
          const appliedTransportTarget = this.getAppliedTransportTarget();
          // Before the first successful connection there is no applied target
          // yet; that bootstrap has no older socket to distinguish from its
          // selected target. Once one exists, every direct-socket decision
          // below stays on it until the next successful apply.
          const transportTarget = appliedTransportTarget ?? this.captureAppliedServerTarget();
          // A changes page arrives through Sync's direct socket. Its cursor and
          // Account projections therefore belong to that applied transport,
          // never to a Home merely staged in profile selection.
          const cursorScope = this.buildCursorScopeForServer(transportTarget.serverId);
          const sessionRecordChangeScope = appliedTransportTarget
              ? createServerAccountScope(appliedTransportTarget.serverId, this.serverID)
              : createServerAccountScope(transportTarget.serverId, this.serverID) ?? getActiveServerAccountScope();
          const isAppliedTransportCurrent = (): boolean => (
              !appliedTransportTarget || this.isAppliedTransportTargetCurrent(appliedTransportTarget)
          );
          let aborted = false;
          // Only a *completed* refresh counts: a failed one must still be retried by the resume tail.
          const refreshedByCatchUp = { sessions: false, machines: false };
          const finish = (status: ResumeViaChangesOutcome['status']): ResumeViaChangesOutcome => ({
              status,
              refreshedByCatchUp: { ...refreshedByCatchUp },
          });
          const credentials = this.credentials;
          if (!credentials) return finish('fallback');
          const request = embedScope?.request ?? this.createAppliedTransportRequest(transportTarget);
          const publishedAccountChangeCursors = this.publishedAccountChangeCursors;

          const canWriteCursor = (): boolean => {
              if (shouldContinue()) {
                  return true;
              }
              aborted = true;
              return false;
          };

	          const offlineForMs = this.readSocketOfflineDurationMs();
	          const forceSnapshotRefresh = opts.allowOfflineSnapshotRefresh !== false
	              && offlineForMs >= this.syncTuning.messageForceSnapshotOfflineMs;

          const catchUp = await runSocketReconnectCatchUpViaChanges({
              credentials,
              accountId: opts.accountId,
              planContext: {
                  isSessionListMember: (sessionId) => embedScope ? sessionId === embedScope.scope.sessionId : this.isSessionListMemberOnHome(transportTarget.serverId, sessionId),
              },
              afterCursor,
              changesPageLimit: CHANGES_PAGE_LIMIT,
              maxChangesPagesPerResume: this.syncTuning.changesMaxPagesPerResume,
              forceSnapshotRefresh,
                fetchChanges: (params) => fetchChanges({ ...params, request, ...(embedScope ? { sessionId: embedScope.scope.sessionId } : {}) }),
                fetchCurrentCursor: (params) => fetchCurrentChangesCursor({ ...params, request }),
                checkpointCursor: async (cursor, context) => {
                    if (!canWriteCursor()) {
                        return false;
                    }
                    if (embedScope) { this.changesCursor = cursor; return true; }
                    const checkpoint = decideChangesCursorCheckpoint({
                        currentCursor: this.changesCursor,
                        approvedCursor: cursor,
                        shouldAdvance: true,
                        scope: cursorScope,
                    });
                    if (checkpoint.status === 'storage-write-failed') {
                        syncReliabilityTelemetry.recordCritical('sync.cursor.checkpointStorageWriteFailed', {
                            cursor,
                            reason: context.reason,
                        });
                        return false;
                    }
                    this.changesCursor = checkpoint.cursor;
                    this.safeCursorLagState = null;
                    if (context.reason === 'snapshot-base') publishedAccountChangeCursors.clear();
                    else {
                        // ChangeEntry cursors are numeric. This only releases transient
                        // notification memory; the existing checkpoint owner decides safety.
                        const approved = Number(cursor);
                        for (const [key, publishedCursor] of publishedAccountChangeCursors) {
                            if (publishedCursor <= approved) publishedAccountChangeCursors.delete(key);
                        }
                    }
                    syncReliabilityTelemetry.record('sync.cursor.checkpointAdvanced', {
                        cursor,
                        reason: context.reason,
                        changes: context.changes.length,
                    });
                    if (context.changes.length > 0) {
                        this.flushSessionMaterializedMaxSeq();
                        verifyChangesCursorMaterializationProofs({
                            changes: context.changes,
                            advancedCursor: cursor,
                            isSessionMessagesLoaded: (sessionId) => storage.getState().sessionMessages[sessionId]?.isLoaded === true,
                            loadSessionMaterializedMaxSeqById: () => loadSessionMaterializedMaxSeqById(this.pendingSettingsScope),
                            telemetry: syncReliabilityTelemetry,
                        });
                    }
                    return true;
                },
                onCursorBlocked: ({ blockedCursor, blockedReason, safeAdvanceCursor, changes }) => {
                    // Later catalog rows may lie beyond this blocked page. Revalidate
                    // mounted Account projections through their existing snapshot owner
                    // without advancing past the unmaterialized change.
                    if (!embedScope && shouldContinue() && isAppliedTransportCurrent() && transportTarget.serverId) {
                        publishHomeAccountChange(transportTarget.serverId, undefined, { source: 'catch-up-pending' });
                    }
                    this.rememberBlockedChangesCursorLag({
                        blockedCursor,
                        blockedReason,
                        safeAdvanceCursor,
                    });
                    const blockedChange = changes.find((change) => String(change.cursor) === blockedCursor);
                    syncReliabilityTelemetry.recordCritical('sync.cursor.blocked', {
                        blockedCursor,
                        blockedReason,
                        safeAdvanceCursor,
                        kind: blockedChange?.kind ?? null,
                        entityId: blockedChange?.entityId ?? null,
                    });
	                    if (blockedReason === 'unsupported-kind') {
	                        syncReliabilityTelemetry.recordCritical('sync.changes.unsupportedKind', {
	                            cursor: blockedCursor,
	                            kind: blockedChange?.kind ?? null,
	                            entityId: blockedChange?.entityId ?? null,
	                        });
	                    }
	                },
	                onSnapshotBaseCursorFetchFailed: ({ trigger, fallbackCursor, error }) => {
	                    syncReliabilityTelemetry.recordCritical('sync.cursor.snapshotBaseFetchFailed', {
	                        trigger,
	                        fallbackCursor,
	                        error,
	                    });
	                },
	                onCursorContractAnomaly: ({ reason, afterCursor: anomalyAfterCursor, offendingCursor, nextCursor }) => {
	                    syncReliabilityTelemetry.recordCritical('sync.cursor.contractAnomaly', {
	                        reason,
	                        afterCursor: anomalyAfterCursor,
	                        offendingCursor,
	                        nextCursor,
	                    });
	                },
	                snapshotRefresh: async () => {
	                    if (!shouldContinue()) throw new StaleServerGenerationError();
	                    const snapshot = await this.snapshotRefreshOnResume({ mode: 'long-offline', reason: 'snapshot-refresh', shouldContinue, signal: opts.signal });
                        if (!shouldContinue()) throw new StaleServerGenerationError();
                        if (snapshot.status !== 'complete') return snapshot;
                        refreshedByCatchUp.sessions = true;
                        refreshedByCatchUp.machines = !embedScope;
                        if (embedScope) return snapshot;
	                    resetActivePluginCollectionUiQueryWatches();
	                    resetActiveScopedPluginSettingsChangeWatches();
                        return snapshot;
                },
                applyPlanned: async (planned) => {
                    if (!shouldContinue()) throw new StaleServerGenerationError();
                    const scope = embedScope;
                    if (scope) {
                        // The Session-scoped server page is consumed by the incumbent planner and
                        // applier. No Account projection or list materialization is admitted here.
                        const scopedPlan = planSyncActionsFromChanges(planned.changes.filter((change) =>
                            (change.kind === 'session' || change.kind === 'share') && change.entityId === scope.scope.sessionId,
                        ), { isSessionListMember: () => true });
                        scopedPlan.sessionDraftAddresses = [];
                        scopedPlan.sessionFolderAssignmentSessionIds = [];
                        scopedPlan.sessionOrganization = { mode: 'none' };
                        scopedPlan.invalidate.sessionFolderAssignments = false;
                        const applied = await applyPlannedChangeActions({
                            planned: scopedPlan, credentials, shouldContinue,
                            isSessionMessagesLoaded: (sid) => storage.getState().sessionMessages[sid]?.isLoaded === true,
                            getSessionMaterializedMaxSeq: (sid) => this.sessionMaterializedMaxSeqById[sid] ?? 0,
                            invalidate: { sessions: () => this.refreshEmbedSessionSnapshot(), sessionRows: () => this.refreshEmbedSessionSnapshot() },
                            invalidateMessagesForSession: (sid) => invalidateForResume(this.getOrCreateMessagesSync(sid)),
                            repairSessionTranscriptRevision: (repair) => this.repairSessionTranscriptRevision(repair),
                            convergePendingForSession: (sid) => this.fetchPendingMessages(sid),
                            invalidateScmStatusForSession: () => {}, applyTodoSocketUpdates: async () => {},
                            kvBulkGet: (credentials, keys) => kvBulkGet(credentials, keys, { request }),
                            concurrencyLimit: this.syncTuning.resumeConcurrencyLimit,
                        });
                        // Exact embed feeds carry only Session/share rows. A Session wake is also
                        // the freshness signal for Session-bound approval artifacts created during
                        // a turn, so refresh the bounded approval inventory after any real row.
                        if (shouldContinue() && planned.changes.length > 0) {
                            await invalidateForResume(embedScope.approvalsSync);
                        }
                        return applied;
                    }
                    const plannedServerId = transportTarget.serverId || sessionRecordChangeScope?.serverId || '';
                    if (changesRequireSessionMetadataUpgradeDiscovery(planned.changes)) {
                        this.metadataUpgradeDiscovery.invalidate();
                        // share rows already refresh the list. A narrow row or
                        // Team change needs only the independent migration owner.
                        if (!planned.invalidate.sessions) await this.refreshSessionMetadataUpgrades();
                    }
                    return await applyPlannedChangeActions({
                        planned,
                        shouldContinue,
                        credentials,
                        isSessionMessagesLoaded: (sessionId) => storage.getState().sessionMessages[sessionId]?.isLoaded === true,
                        shouldCatchUpSessionMessages: (sessionId) =>
                            resolveSessionLiveConsumption(sessionId).isFullContentConsumer,
                        getSessionMaterializedMaxSeq: (sessionId) => this.sessionMaterializedMaxSeqById[sessionId] ?? 0,
                        isSessionMessagesDeferred: (sessionId) => this.hasDeferredNewerMessages(sessionId),
                        publishAccountChanges: (replayedChanges, materialization) => {
                            if (!shouldContinue() || !isAppliedTransportCurrent()) return;
                            const changes = replayedChanges.filter(change =>
                                publishedAccountChangeCursors.get(`${change.kind}:${change.entityId}`) !== change.cursor);
                            if (changes.length === 0) return;
                            // A failed row still retries through the full materialization
                            // plan. Only newly observed rows describe a new projection wake.
                            const publishedPlan = changes.length === replayedChanges.length ? planned : planSyncActionsFromChanges(changes, {
                                isSessionListMember: sessionId => this.isSessionListMemberOnHome(plannedServerId, sessionId),
                            });
                            // Recipient/access changes need not alter the published Machine blobs.
                            // Their dedicated focused AccountChange cursor is the freshness signal.
                            for (const change of changes) {
                                if (change.kind === MACHINE_RECIPIENT_ACCESS_CHANGE_KIND_V1) {
                                    this.machineRecipientChangeCursors.set(change.entityId, change.cursor);
                                }
                            }
                            if (plannedServerId && sessionRecordChangeScope) {
                                publishMountedDiscussionChanges({
                                    serverId: plannedServerId,
                                    accountId: sessionRecordChangeScope.accountId,
                                    changes,
                                });
                            }
                            if (sessionRecordChangeScope) {
                                for (const repository of this.sessionSystemRecordRepositories.values()) {
                                    invalidateSessionSystemRecordsFromChanges({ scope: sessionRecordChangeScope, changes, repository });
                                }
                            }
                            // Withdraw changed mode facts before a Home observer
                            // starts its replacement read from this exact page.
                            invalidateAccountEncryptionModeCacheForChanges(changes, { serverId: plannedServerId });
                            const changedEntityIds = changes.map((change) => change.entityId);
                            if (plannedServerId && changedEntityIds.length > 0) {
                                // The focused-Home page has already passed through
                                // the canonical change planner. Publish that exact
                                // filtered-list decision instead of asking the list
                                // to reinterpret AccountChange hints or reacting a
                                // second time to the earlier content-free wake.
                                publishHomeAccountChange(plannedServerId, changedEntityIds, {
                                    feedPageConsumed: true,
                                    entityRevisions: Object.fromEntries(changes.flatMap(change => {
                                        const hint = change.hint;
                                        if (!hint || typeof hint !== 'object' || !('revision' in hint)
                                            || typeof hint.revision !== 'number' || !Number.isSafeInteger(hint.revision) || hint.revision < 0) return [];
                                        return [[change.entityId, hint.revision]];
                                    })),
                                    changeKinds: changes.map(change => change.kind),
                                    ...(materialization?.workflowRunsMaterialized ? { workflowRunsMaterialized: true as const } : {}),
                                    ...(materialization?.savedSecretResourcesRefreshStarted ? { savedSecretResourcesRefreshStarted: true as const } : {}),
                                    sessionListQueryAffects: materialization?.workflowRunsMaterialized ? false : plannedChangesAffectSessionListQuery(publishedPlan),
                                    profileCatalogAffects: materialization?.workflowRunsMaterialized ? false : plannedChangesAffectProfileCatalog(publishedPlan),
                                    workflowTriggersAffect: materialization?.workflowRunsMaterialized ? false : plannedChangesAffectWorkflowTriggers(publishedPlan),
                                    accountSettingsAffects: materialization?.workflowRunsMaterialized ? false : publishedPlan.invalidate.settings || publishedPlan.unsupportedChanges.length > 0,
                                    usageQueryAffects: materialization?.workflowRunsMaterialized ? false : plannedChangesAffectUsageQuery(publishedPlan),
                                });
                            }
                            publishActivePluginCollectionUiQueryChanges(changes);
                            publishActiveScopedPluginSettingsChanges(changes);
                            const changedAvailabilityPluginIds = this.pluginAvailabilityProjectionHydrator.invalidate(changes);
                            if (changedAvailabilityPluginIds.length > 0) {
                                // AccountChange is a freshness observation, not
                                // withdrawal authority. Retain confirmed facts
                                // until each named plugin read replaces them.
                                // An in-flight read was superseded by invalidate;
                                // preserve a trailing refresh for the new facts.
                                this.pluginAvailabilitySync.invalidate();
                            }
                            for (const change of changes) {
                                publishedAccountChangeCursors.set(`${change.kind}:${change.entityId}`, change.cursor);
                            }
                        },
                        refreshWorkflowRuns: (runIds) => refreshWorkflowRunsByIds(runIds),
                        invalidate: {
                            settings: () => invalidateForResume(this.settingsSync),
                            profile: () => invalidateForResume(this.profileSync),
                            machines: async () => {
                                await invalidateForResume(this.machinesSync);
                                refreshedByCatchUp.machines = true;
                            },
                            machinePools: async () => {
                                if (
                                    !plannedServerId
                                    || !isAppliedTransportCurrent()
                                    || !areServerProfileIdentifiersEquivalent(
                                        plannedServerId,
                                        transportTarget.serverId,
                                    )
                                ) {
                                    throw new Error('Machine Pool AccountChange scope changed before refresh');
                                }
                                await invalidateMachinePoolProjection(plannedServerId, { forceFeatures: true });
                            },
                            artifacts: artifactIds => this.refreshArtifactsByIds(artifactIds),
                            friends: () => invalidateForResume(this.friendsSync),
                            friendRequests: () => invalidateForResume(this.friendRequestsSync),
                            feed: () => invalidateForResume(this.feedSync),
                            automations: options => this.refreshAutomationsAndAwait(options, opts.signal),
                            pets: () => this.fetchAccountPets(),
                            savedSecretResources: () => {
                                const scope = storage.getState().settingsScope;
                                if (!scope || !plannedServerId || !areServerProfileIdentifiersEquivalent(scope.serverId, plannedServerId)) {
                                    throw new Error('Saved Secret catalog AccountChange scope changed before refresh');
                                }
                                return invalidateSavedSecretCatalogProjection(scope);
                            },
                            sessions: async ({ requiredHydrationSessionIds, prioritizeSessionIds }) => {
                                const demandedSessionIds = new Set((requiredHydrationSessionIds ?? [])
                                    .filter(sessionId => this.isSessionHydrationDemanded(sessionId, plannedServerId)));
                                const projectionSessionIds = (requiredHydrationSessionIds ?? [])
                                    .filter(sessionId => !demandedSessionIds.has(sessionId));
                                await this.fetchSessions({
                                    awaitSessionListHydration: true,
                                    requiredHydrationSessionIds: [...demandedSessionIds],
                                    prioritizeSessionIds: (prioritizeSessionIds ?? []).filter(sessionId => this.isSessionHydrationDemanded(sessionId, plannedServerId)),
                                });
                                if (!shouldContinue()) return;
                                await this.refreshListedSessionRows(plannedServerId, projectionSessionIds);
                                refreshedByCatchUp.sessions = true;
                            },
                            sessionRows: (sessionIds) => this.refreshListedSessionRows(plannedServerId, sessionIds),
                            sessionFolderAssignments: async (sessionIds) => {
                                if (
                                    !plannedServerId
                                    || !isAppliedTransportCurrent()
                                    || !areServerProfileIdentifiersEquivalent(
                                        plannedServerId,
                                        transportTarget.serverId,
                                    )
                                ) {
                                    throw new Error('Cannot refresh session folder assignments without an active server');
                                }
                                await fetchAndApplySessionFolderAssignments({
                                    credentials,
                                    serverId: plannedServerId,
                                    sessionIds,
                                });
                            },
                            todos: () => invalidateForResume(this.todosSync),
                        },
                        refreshSessionOrganization: async (plan) => {
                            const serverSnapshot = transportTarget;
                            if (
                                !plannedServerId
                                || !shouldContinue()
                                || !isAppliedTransportCurrent()
                                || !areServerProfileIdentifiersEquivalent(plannedServerId, serverSnapshot.serverId)
                            ) {
                                throw new Error('Session organization AccountChange scope changed before refresh');
                            }
                            await fetchAndApplySessionOrganizationSnapshot({
                                credentials,
                                serverId: plannedServerId,
                                serverUrl: serverSnapshot.serverUrl,
                                shouldContinue,
                                request: {
                                    includeFolders: plan.includeFolders,
                                    includeTags: plan.includeTags,
                                    includeLabels: plan.includeLabels,
                                    includeAttentionStandings: true,
                                    includeAttentionReminderTimes: true,
                                    assignmentSessionIds: plan.assignmentSessionIds,
                                    folderIds: plan.folderIds,
                                    tagIds: plan.tagIds,
                                    orderScopes: plan.orderScopes,
                                },
                            });
                        },
                        applyAuthoritativeSessionOrganizationDeletions: (plan) => {
                            if (sessionRecordChangeScope && plan.deletedTagIds.length > 0) {
                                // The change hint proves that a delete committed, while the
                                // just-refreshed canonical snapshot decides whether that ID is
                                // still absent now. A later upsert of the same opaque ID must not
                                // be undone by an older catch-up page.
                                const confirmedDeletedTagIds = plan.deletedTagIds.filter((tagId) => (
                                    storage.getState().sessionOrganizationTagsByTagKey[
                                        buildSessionOrganizationServerKey(sessionRecordChangeScope.serverId, tagId)
                                    ] === undefined
                                ));
                                if (confirmedDeletedTagIds.length === 0) return;
                                removeAuthoritativelyDeletedSessionListTagsForAccount(
                                    sessionRecordChangeScope,
                                    confirmedDeletedTagIds,
                                );
                            }
                        },
                        invalidateMessagesForSession: async (sessionId) => {
                            // §13 catch-up signal: socket-reconnect invalidation re-pulls newer activity,
                            // so surface the overlay while the coalesced refetch-and-merge runs.
                            await this.withSessionCatchUpNewer(sessionId, () =>
                                invalidateForResume(this.getOrCreateMessagesSync(sessionId)));
                        },
                        repairSessionTranscriptRevision: (repair) => this.repairSessionTranscriptRevision(repair),
                        invalidateScmStatusForSession: (sessionId) => scmStatusSync.invalidate(sessionId),
                        applyTodoSocketUpdates: (changes) => this.applyTodoSocketUpdates(changes),
                        kvBulkGet: (credentials, keys) => kvBulkGet(credentials, keys, { request }),
                        convergePendingForSession: (sessionId) => this.fetchPendingMessages(sessionId),
                        materializeAuthoringMemory: async (key) => {
                            if (!shouldContinue() || !isAppliedTransportCurrent()) throw new Error('Authoring memory transport retired');
                            const runtime = await this.ensureAuthoringMemoryRuntime();
                            if (!shouldContinue() || !isAppliedTransportCurrent()) throw new Error('Authoring memory transport retired');
                            await runtime.refresh(key);
                            if (!shouldContinue() || !isAppliedTransportCurrent()) throw new Error('Authoring memory transport retired');
                        },
                        materializeProjectAccountRow: async () => {
                            if (!shouldContinue() || !isAppliedTransportCurrent()) throw new Error('Project row transport retired');
                            const runtime = await this.ensureProjectAccountRowsRuntime();
                            if (!shouldContinue() || !isAppliedTransportCurrent()) throw new Error('Project row transport retired');
                            await runtime.refresh();
                            if (!shouldContinue() || !isAppliedTransportCurrent()) throw new Error('Project row transport retired');
                        },
                        materializeSessionDraft: async (address) => {
                            if (
                                !sessionRecordChangeScope
                                || !shouldContinue()
                                || !isAppliedTransportCurrent()
                            ) {
                                throw new Error('Session draft scope changed before materialization');
                            }
                            await materializeExactSessionDraft(sessionRecordChangeScope, address);
                            if (
                                !shouldContinue()
                                || !isAppliedTransportCurrent()
                            ) {
                                throw new Error('Session draft scope changed during materialization');
                            }
                        },
                        concurrencyLimit: this.syncTuning.resumeConcurrencyLimit,
                    });
                },
            });

          if (aborted) {
              return finish('aborted');
          }
          if (catchUp.status === 'fallback') {
              return finish('fallback');
          }

          if (catchUp.shouldPersistCursor) {
              if (!canWriteCursor()) {
                  return finish('aborted');
              }
              if (embedScope) { this.changesCursor = catchUp.nextCursor; return finish('ok'); }
              const checkpoint = decideChangesCursorCheckpoint({
                  currentCursor: this.changesCursor,
                  approvedCursor: catchUp.nextCursor,
                  shouldAdvance: true,
                  scope: cursorScope,
              });
              if (checkpoint.status === 'storage-write-failed') {
                  syncReliabilityTelemetry.recordCritical('sync.cursor.checkpointStorageWriteFailed', {
                      cursor: catchUp.nextCursor,
                      reason: 'final-result',
                  });
                  return finish('fallback');
              }
              this.changesCursor = checkpoint.cursor;
              this.safeCursorLagState = null;
          }

          return finish('ok');
      }

    private handleUpdate = async (update: unknown) => {
          const scope = this.embedSessionScope;
          if (scope) {
              if (!scope.isCurrent()) return;
              const parsed = parseUpdateContainer(update);
              if (!parsed) return;
              const body = parsed.body;
              if (body.t === 'account-change') { this.requestChangesCatchUp(); return; }
              const id = 'sid' in body ? body.sid : 'sessionId' in body ? body.sessionId : 'id' in body ? body.id : null;
              if (id !== scope.scope.sessionId) return;
              if (body.t === 'new-session' || body.t === 'session-shared' || body.t === 'session-share-updated' || body.t === 'session-share-revoked'
                  || body.t === 'public-share-created' || body.t === 'public-share-updated' || body.t === 'public-share-deleted') {
                  await this.ensureSessionVisibleForMessageRoute(scope.scope.sessionId, { forceRefresh: true });
                  return;
              }
              if (body.t === 'update-session') {
                  // Detail is the sole capability and bounded metadata producer for this frame.
                  // Legacy plain metadata socket payloads can contain private owner fields.
                  const { access: _access, ownerMetadata, metadata, metadataLayoutVersion: _layout, ...sessionBody } = body;
                  if (metadata != null || ownerMetadata != null) {
                      await this.ensureSessionVisibleForMessageRoute(scope.scope.sessionId, {
                          forceRefresh: true, hydrateMessages: false,
                      });
                      if (this.embedSessionScope !== scope || !scope.isCurrent()) return;
                  }
                  update = { ...parsed, body: sessionBody };
              } else if (body.t !== 'new-message' && body.t !== 'message-updated' && body.t !== 'pending-changed' && body.t !== 'delete-session') return;
          }
          const appliedTransportTarget = this.getAppliedTransportTarget();
          if (!appliedTransportTarget) return;
          const sourceServerId = appliedTransportTarget.serverId;
          const serverScopeGuard = this.createServerScopeGuard();
          const shouldContinue = () => (
              serverScopeGuard()
              && this.isAppliedTransportTargetCurrent(appliedTransportTarget)
          );
          await this.applySocketUpdateForScope(update, {
              serverId: sourceServerId,
              encryption: this.encryption,
              credentials: this.credentials ?? null,
              shouldContinue,
              readAccountMode: async () => {
                  const credentials = this.credentials;
                  if (!credentials || !shouldContinue()) throw new Error('machine_target_changed');
                  const result = await fetchAccountEncryptionMode(credentials, { request: this.createAppliedTransportRequest(appliedTransportTarget), usage: 'identity' });
                  if (!shouldContinue() || this.credentials !== credentials) throw new Error('machine_target_changed');
                  return result.mode;
              },
          });
    }

    private applySocketUpdateForScope = async (update: unknown, context: Readonly<{
        serverId: string;
        encryption: Encryption | null;
        credentials: AuthCredentials | null;
        shouldContinue: () => boolean;
        readAccountMode?: () => Promise<'plain' | 'e2ee'>;
        sessionId?: string;
        parsedUpdate?: ApiUpdateContainer;
    }>) => {
        const sourceServerId = context.serverId;
        const shouldContinue = context.shouldContinue;
        const parsedUpdate = context.parsedUpdate ?? parseUpdateContainer(update);
        if (!this.embedSessionScope && !context.sessionId && shouldContinue()
            && parsedUpdate && socketRequiresSessionMetadataUpgradeDiscovery(parsedUpdate.body)) {
            this.metadataUpgradeDiscovery.invalidate();
            this.sessionsSync.invalidate();
        }
        const hasCurrentCarrier = (sessionId: string) => {
            const session = storage.getState().sessions[sessionId];
            if (!session) return !context.sessionId;
            return areServerProfileIdentifiersEquivalent(session.serverId ?? getActiveServerSnapshot().serverId, sourceServerId);
        };
          const callbacks: Omit<Parameters<typeof handleSocketUpdate>[0], 'update'> = {
              encryption: context.encryption,
              credentials: context.credentials,
              readAccountMode: context.readAccountMode,
              settingsSecretsKey: this.settingsSecretsKey,
              settingsSecretsReadKeys: this.settingsSecretsReadKeys,
              settingsScope: this.pendingSettingsScope,
              sourceServerId,
              shouldContinue,
              onAccountChangeWake: (wake) => {
                  // Catalogs that need current rows independently of the history
                  // cursor opt into this wake at the existing snapshot lifecycle.
                  if (shouldContinue() && sourceServerId) {
                      publishHomeAccountChange(sourceServerId, wake.entityIds, {
                          source: 'catch-up-pending', changeKinds: wake.changeKinds,
                          sessionSystemRecords: wake.sessionSystemRecords,
                      });
                  }
                  // Catch-up still consumes every feed row. Its detailed dispatch
                  // separately marks feedPageConsumed; advisory ids cannot stand
                  // in for that proof while the request is held or blocked.
                  this.requestChangesCatchUp();
              },
              artifactDataKeys: this.artifactDataKeys,
              applySessions: (sessions) => this.applySessions(sessions, parsedUpdate?.body.t === 'new-session' ? 'full' : 'projection'),
	              fetchSessions: () => {
                      if (this.embedSessionScope || context.sessionId) return;
	                  fireAndForget(this.fetchSessions(), { tag: 'Sync.handleUpdate.fetchSessions', logError: false });
	              },
	              hydrateSessionById: (sessionId, reason) => {
                      if (context.sessionId) return;
	                  const hydrationReason = this.resolveSocketHydrationReasonForUpdate(update, reason);
	                  fireAndForget(
	                      this.hydrateSessionFromSocketUpdate(sessionId, hydrationReason, sourceServerId),
	                      {
	                          tag: `Sync.handleUpdate.hydrateSessionById.${hydrationReason}`,
	                          logError: false,
	                      },
	                  );
                  },
                  invalidateSessionHydration: this.invalidateDeletedSessionHydration,
                  refreshPendingForRecipient: (sessionId, recipient) => this.fetchPendingMessages(sessionId, undefined, recipient),
	              resetSessionTranscriptState: (sessionId) => this.resetSessionTranscriptState(sessionId),
	              applyMessages: (sessionId, messages) => this.applyMessages(sessionId, messages),
                  sessionReceivedMessages: this.sessionReceivedMessages,
                onSessionVisible: (sessionId) => { if (hasCurrentCarrier(sessionId)) this.onSessionVisible(sessionId); },
                isSessionMessagesLoaded: (sessionId) => hasCurrentCarrier(sessionId) && storage.getState().sessionMessages[sessionId]?.isLoaded === true,
                getSessionMaterializedMaxSeq: (sessionId) => hasCurrentCarrier(sessionId) ? this.sessionMaterializedMaxSeqById[sessionId] ?? 0 : 0,
              markSessionMaterializedMaxSeq: (sessionId, seq) => { if (hasCurrentCarrier(sessionId)) this.markSessionMaterializedMaxSeq(sessionId, seq); },
              markSessionKnownRemoteSeq: (sessionId, seq) => { if (hasCurrentCarrier(sessionId)) this.markSessionKnownRemoteSeq(sessionId, seq); },
              markSessionTranscriptDeferred: (sessionId, marker) => { if (hasCurrentCarrier(sessionId)) this.markSessionTranscriptDeferred(sessionId, marker); },
              markSessionTranscriptStale: (sessionId, marker) => { if (hasCurrentCarrier(sessionId)) this.markSessionTranscriptStale(sessionId, marker); },
              markSessionStateHydrationDeferred: (sessionId) => { if (hasCurrentCarrier(sessionId)) this.markSessionStateHydrationDeferred(sessionId); },
              onReadyProjectionAdvance: (sessionId, seq, localId) => this.notifyReadyProjectionAdvance(sessionId, seq, sourceServerId, localId),
              onMessageGapDetected: (sessionId, info) => { if (hasCurrentCarrier(sessionId)) this.recoverSessionMessageGap(sessionId, info); },
              assumeUsers: (userIds) => this.assumeUsers(userIds),
              applyTodoSocketUpdates: (changes) => this.applyTodoSocketUpdates(changes),
              invalidateMachines: () => this.machinesSync.invalidate(),
              invalidateSessions: () => this.sessionsSync.invalidate(),
            invalidateArtifacts: () => this.artifactsSync.invalidate(),
            invalidateFriends: () => this.friendsSync.invalidate(),
            invalidateFriendRequests: () => this.friendRequestsSync.invalidate(),
            invalidateFeed: () => this.feedSync.invalidate(),
            invalidateAutomations: options => this.requestAutomationsRefresh(options),
            invalidateAutomationsCoalesced: options => this.requestAutomationsRefresh(options, true),
            invalidateTodos: () => this.todosSync.invalidate(),
            onTaskLifecycleEvent: (sessionId, event) => this.applySessionThinkingFromTaskLifecycle(sessionId, event),
            log,
        };
        if (parsedUpdate) await handleUpdateContainer({ ...callbacks, updateData: parsedUpdate });
    }

    async consumeSessionRealtimeUpdateForHome(input: SessionRealtimeHomeScope & Readonly<{ update: ApiUpdateContainer }>): Promise<void> {
        if (!input.isCurrent() || this.embedSessionScope) return;
        const body = input.update.body;
        if (body.t !== 'new-message' && body.t !== 'message-updated') return;
        const sessionId = body.sid;
        const live = resolveSessionLiveConsumption(sessionId, input.serverId).isFullContentConsumer;
        const hasExactCarrier = () => areServerProfileIdentifiersEquivalent(storage.getState().sessions[sessionId]?.serverId, input.serverId);
        // A retained exact-Home transcript still needs the canonical stale and
        // deferred markers, even when it no longer consumes full content.
        if (!live && !hasExactCarrier()
            && (body.delivery === 'hint' || !resolveSessionScmMutationSignal(sessionId, input.serverId))) return;
        // Opening/ACK owns missing shells. A later body never replaces another Home's carrier.
        if (live && !hasExactCarrier()) return;
        await this.applySocketUpdateForScope(input.update, { serverId: input.serverId,
            encryption: input.encryption, credentials: input.credentials, sessionId, parsedUpdate: input.update,
            shouldContinue: () => input.isCurrent() && (!live || hasExactCarrier()),
        });
    }

    async consumeSessionRealtimeEphemeralForHome(input: SessionRealtimeHomeScope & Readonly<{
        update: Parameters<typeof handleTranscriptStreamSegmentSocketUpdate>[0]['update'];
    }>): Promise<void> {
        const sessionId = input.update.sessionId;
        const shouldContinue = () => input.isCurrent() && !this.embedSessionScope
            && areServerProfileIdentifiersEquivalent(storage.getState().sessions[sessionId]?.serverId, input.serverId);
        if (!shouldContinue()) return;
        await handleTranscriptStreamSegmentSocketUpdate({ update: input.update, sourceServerId: input.serverId,
            shouldContinue, ...this.transcriptSocketCallbacks({ serverId: input.serverId, encryption: input.encryption, shouldContinue }),
        });
    }

    onSessionLiveConsumptionAdmittedForHome(serverId: string, sessionIds: readonly string[], isCurrent: () => boolean): void {
        for (const sessionId of sessionIds) {
            fireAndForget((async () => {
                const currentDemand = () => isCurrent()
                    && resolveSessionLiveConsumption(sessionId, serverId).isFullContentConsumer;
                if (!currentDemand()) return;
                if (!areServerProfileIdentifiersEquivalent(storage.getState().sessions[sessionId]?.serverId, serverId)) {
                    const authority = await captureServerRequestAuthorityForServerAccountScope({
                        serverId, activeRequest: this.requestViaConfiguredSocket,
                    });
                    try {
                        if (!currentDemand()) return;
                        await this.ensureSessionVisibleForMessageRoute(sessionId, { serverId, forceRefresh: true,
                            authority, scopeCurrentness: currentDemand });
                    } finally { await authority.release(); }
                }
                if (currentDemand() && areServerProfileIdentifiersEquivalent(storage.getState().sessions[sessionId]?.serverId, serverId)) {
                    this.onSessionVisible(sessionId);
                }
            })(), { tag: 'Sync.sessionConsumptionCatchUp' });
        }
    }

    private flushActivityUpdates = (updates: Map<string, ApiEphemeralActivityUpdate>, options?: ActivityUpdateFlushOptions) => {
        flushActivityUpdatesEngine({
            updates,
            ...options,
            applySessions: (sessions) => this.applySessions(sessions, 'projection'),
            hydrateSessionById: (sessionId, reason) => {
                fireAndForget(
                    this.hydrateSessionFromSocketUpdate(sessionId, reason, options?.sourceServerId),
                    {
                        tag: `Sync.flushActivityUpdates.hydrateSessionById.${reason}`,
                        logError: false,
                    },
                );
            },
        });
    }

    private flushMachineActivityUpdates = (updates: Map<string, MachineActivityUpdate>, options?: { sourceServerId?: string | null; onApplied?: () => void }) => {
        const scope = this.getAppliedTransportAccountScope();
        const reachabilityBefore = new Map<string, boolean>();
        for (const machineId of updates.keys()) {
            const machine = storage.getState().machines[machineId] ?? null;
            reachabilityBefore.set(machineId, machine !== null && isMachineReachable(scope, machine));
        }
        flushMachineActivityUpdatesEngine({
            updates,
            ...options,
        });
        options?.onApplied?.();
        const changedMachineIds = new Set<string>();
        for (const [machineId, wasReachable] of reachabilityBefore) {
            const machine = storage.getState().machines[machineId] ?? null;
            const isReachable = machine !== null && isMachineReachable(scope, machine);
            if (isReachable !== wasReachable) changedMachineIds.add(machineId);
        }
        if (changedMachineIds.size === 0) return;
        for (const sessionId of this.messagesSync.keys()) {
            const session = storage.getState().sessions[sessionId] ?? null;
            const link = readExternalSessionLink(
                session ? readSessionOwnerMetadataView(session) : null,
            );
            if (link && changedMachineIds.has(link.machineId)) {
                this.getOrCreateMessagesSync(sessionId).invalidateCoalesced();
            }
        }
    }

    private handleEphemeralUpdate = (
        update: unknown,
        messageContext: import('@/sync/api/session/apiSocket').SyncSocketMessageContext,
    ) => {
        const scope = this.embedSessionScope;
        if (scope) {
            if (!scope.isCurrent()) return;
            const parsed = parseEphemeralUpdate(update);
            if (!parsed || parsed.type === 'machine-activity' || parsed.type === 'session-personal-event') return;
            const id = 'sessionId' in parsed ? parsed.sessionId : parsed.type === 'activity' ? parsed.id : null;
            if (id !== scope.scope.sessionId) return;
        }
        if (parseSessionDraftSocketWake(update)) {
            const capturedScope = getActiveServerAccountScope();
            if (!capturedScope) return;
            fireAndForget(materializeSessionDraftSocketWake({
                payload: update,
                capturedScope,
                readActiveScope: getActiveServerAccountScope,
                materializeExact: materializeExactSessionDraft,
            }), { tag: 'Sync.handleSessionDraftSocketWake' });
            return;
        }
        const sourceServerId = messageContext.serverId;
        const accountScope = getActiveServerAccountScope();
        const shouldContinue = this.createServerScopeGuard();
        const actionOperationTransportTarget = this.getAppliedTransportTarget();
        const actionOperationCredentials = this.credentials;
        const actionOperationEncryption = this.encryption;
        const actionOperationAccountLifetime = captureActiveServerAccountScopeCurrentness();
        const actionOperationCipherLifetime = captureEncryptionGenerationCurrentness(actionOperationEncryption, {
            accountId: accountScope?.accountId, serverId: sourceServerId,
        });
        const actionOperationScopeIsCurrent = () => {
            return shouldContinue() && this.encryption === actionOperationEncryption
                && this.credentials === actionOperationCredentials
                && !!actionOperationTransportTarget && this.isAppliedTransportTargetCurrent(actionOperationTransportTarget)
                && actionOperationAccountLifetime.isCurrent() && actionOperationCipherLifetime.isCurrent()
                && !!accountScope && areServerProfileIdentifiersEquivalent(accountScope.serverId, sourceServerId);
        };
        fireAndForget(handleEphemeralSocketUpdate({
            update,
            sourceServerId,
            shouldContinue,
            addActivityUpdate: (ephemeralUpdate) => {
                const retirementFence = captureSessionListRetirementFence();
                this.activityAccumulator.addUpdate(ephemeralUpdate, {
                    shouldContinue: () => shouldContinue()
                        && !wasSessionRetiredSinceFence(retirementFence, sourceServerId, ephemeralUpdate.id),
                    sourceServerId,
                });
            },
            addMachineActivityUpdate: (machineUpdate) => {
                const observe = captureMachinePresenceObservation(accountScope
                    && areServerProfileIdentifiersEquivalent(accountScope.serverId, sourceServerId) ? accountScope : null);
                if (!shouldContinue()) return;
                this.flushMachineActivityUpdates(new Map([[machineUpdate.id, machineUpdate]]), { sourceServerId,
                    onApplied: () => { if (shouldContinue()) observe([machineUpdate.id]); },
                });
            },
            ...this.transcriptSocketCallbacks({ serverId: sourceServerId, encryption: this.encryption, shouldContinue }),
            updateExternalSessionTranscript: (ephemeralUpdate) => this.handleExternalSessionTranscriptEphemeralUpdate(
                ephemeralUpdate,
                { sourceServerId, shouldContinue },
            ),
            updateActionOperationSnapshot: accountScope && actionOperationCredentials && actionOperationTransportTarget
                ? async (ephemeralUpdate) => {
                    if (!actionOperationScopeIsCurrent()) return;
                    let mode: 'plain' | 'e2ee';
                    try {
                        mode = (await fetchAccountEncryptionMode(actionOperationCredentials, {
                            request: this.createAppliedTransportRequest(actionOperationTransportTarget),
                            usage: 'identity',
                        })).mode;
                    } catch {
                        // Unavailable Account mode never admits content by key presence.
                        return;
                    }
                    if (!actionOperationScopeIsCurrent()) return;
                    await consumeActionOperationSnapshotPush({
                        update: ephemeralUpdate,
                        accountId: accountScope.accountId,
                        accountEncryptionMode: mode,
                        sourceServerId,
                        ...(actionOperationEncryption ? {
                            openSnapshot: (ciphertext: string) => actionOperationEncryption.openActionOperationSnapshotRaw(ciphertext),
                        } : {}),
                        readSnapshot: (operationId) => getActionOperation({ operationId,
                            machineId: ephemeralUpdate.machineId, serverId: sourceServerId,
                            accountId: accountScope.accountId, requireCurrentDomainFacts: true }),
                        shouldContinue: actionOperationScopeIsCurrent,
                        onSnapshot: (snapshot) => actionOperationPresentationCoordinator.observe(snapshot),
                    });
                }
                : undefined,
        }), { tag: 'Sync.handleEphemeralUpdate' });
    }

    private transcriptSocketCallbacks(context: Readonly<{
        serverId: string | null;
        encryption: Encryption | null;
        shouldContinue: () => boolean;
    }>) {
        const getSession = (sessionId: string) => {
            const session = storage.getState().sessions[sessionId];
            return session && (!context.serverId || areServerProfileIdentifiersEquivalent(session.serverId, context.serverId))
                ? session : undefined;
        };
        return {
            getSession,
            getSessionEncryption: (sessionId: string) => context.encryption?.getSessionEncryption(sessionId) ?? null,
            applyMessages: (sessionId: string, messages: NormalizedMessage[]) => {
                if (context.shouldContinue() && getSession(sessionId)) {
                    this.applyMessages(sessionId, messages, { notifyVoice: false, notifyActivity: true });
                }
            },
        };
    }

    private async handleExternalSessionTranscriptEphemeralUpdate(
        ephemeralUpdate: ExternalSessionTranscriptInvalidationV1,
        options?: Readonly<{
            sourceServerId?: string | null;
            shouldContinue?: () => boolean;
        }>,
    ): Promise<void> {
        const shouldContinue = options?.shouldContinue ?? (() => true);
        if (!shouldContinue()) return;
        const binding = ephemeralUpdate.binding;
        const sourceServerId = String(options?.sourceServerId ?? '').trim();
        const bindingMatchesCurrentSession = (
            candidateSession: Session | null,
            candidateLink: ReturnType<typeof readExternalSessionLink>,
        ): candidateLink is NonNullable<ReturnType<typeof readExternalSessionLink>> => {
            if (
                !candidateSession
                || !candidateLink
                || !candidateLink.qualifiedIdentity
            ) {
                return false;
            }
            const candidateServerId = String(candidateSession.serverId ?? '').trim();
            if (
                sourceServerId
                && (
                    !candidateServerId
                    || !areServerProfileIdentifiersEquivalent(
                        candidateServerId,
                        sourceServerId,
                    )
                )
            ) {
                return false;
            }
            return candidateLink.machineId === binding.machineId
                && candidateLink.remoteSessionId === binding.link.remoteSessionId
                && String(candidateLink.linkedAtMs) === binding.link.generation
                && candidateLink.qualifiedIdentity.agent.pluginId
                    === binding.source.qualifiedIdentity.agent.pluginId
                && candidateLink.qualifiedIdentity.agent.localId
                    === binding.source.qualifiedIdentity.agent.localId
                && candidateLink.qualifiedIdentity.source.kind
                    === binding.source.qualifiedIdentity.source.kind
                && candidateLink.qualifiedIdentity.source.contractVersion
                    === binding.source.qualifiedIdentity.source.contractVersion;
        };
        let session = storage.getState().sessions[binding.sessionId] ?? null;
        let externalSessionLink = readExternalSessionLink(
            session ? readSessionOwnerMetadataView(session) : null,
        );
        if (!bindingMatchesCurrentSession(session, externalSessionLink)) {
            const hydration = await this.ensureSessionVisibleForMessageRoute(
                binding.sessionId,
                {
                    forceRefresh: true,
                    serverId: options?.sourceServerId ?? undefined,
                },
            );
            if (hydration.kind !== 'available' || !shouldContinue()) return;
            session = storage.getState().sessions[binding.sessionId] ?? null;
            externalSessionLink = readExternalSessionLink(
                session ? readSessionOwnerMetadataView(session) : null,
            );
        }
        if (!bindingMatchesCurrentSession(session, externalSessionLink)) return;
        if (!session || !externalSessionLink) return;
        const sessionServerId = String(session?.serverId ?? '').trim();
        const requestCursor = this.getExternalSessionTailCursor(binding.sessionId);
        const acceptedWindow = this.externalSessionTailStateBySessionId.get(binding.sessionId);
        if (!requestCursor) {
            return;
        }
        const selectedAuthority = this.resolveTranscriptAuthority(session, externalSessionLink);
        if (selectedAuthority.kind !== 'live_agent') {
            return;
        }
        const expectedAuthorityKey = externalSessionTranscriptAuthorityKey(selectedAuthority);

        if (!shouldContinue()) return;
        if (!this.isExternalSessionLiveTail(binding.sessionId)) {
            this.deferredForwardLoadingSessions.add(binding.sessionId);
            return;
        }
        if (this.externalSessionTailStateBySessionId.get(binding.sessionId)?.recoveryRequired) {
            await this.fetchExternalSessionMessages(binding.sessionId, externalSessionLink, { mode: 'replace' });
            return;
        }
        const resolvedServerId =
            this.getExternalSessionServerScope(binding.sessionId)
            ?? (sessionServerId || sourceServerId || undefined);
        const response = await this.withSessionRequestLifetime(undefined, signal => machineExternalSessionTranscriptRefreshReadAfter({
            v: 1,
            binding,
            cursor: requestCursor,
        }, { serverId: resolvedServerId, signal }));
        const currentSession = storage.getState().sessions[binding.sessionId] ?? null;
        const currentLink = readExternalSessionLinkFromSession(currentSession);
        if (
            !shouldContinue()
            || !currentSession
            || !bindingMatchesCurrentSession(currentSession, currentLink)
            || this.externalSessionTailStateBySessionId.get(binding.sessionId) !== acceptedWindow
            || this.getExternalSessionTailCursor(binding.sessionId) !== requestCursor
            || externalSessionTranscriptAuthorityKey(
                this.resolveTranscriptAuthority(currentSession, currentLink),
            ) !== expectedAuthorityKey
            || !externalSessionTranscriptRefreshBindingsEqualV1(binding, response.binding)
        ) {
            return;
        }

        const decision = decideExternalSessionTranscriptRefreshApplicationV1(
            binding,
            requestCursor,
            response,
        );
        if (response.result.outcome === 'gap_or_cursor_expired'
            || (response.result.outcome === 'advanced'
                && shouldResyncExternalSessionTranscriptReadAfterV1({
                    requestCursor,
                    nextCursor: response.result.nextCursor,
                    hasMore: response.result.hasMore,
                    diagnostics: response.result.diagnostics,
                    allowAdjacentPage: true,
                }))) {
            this.markExternalSessionTranscriptRecoveryRequired(binding.sessionId);
        }
        if ((decision.kind === 'apply' || decision.reason === 'resync_required' || decision.reason === 'already_current')
            && !this.isExternalSessionLiveTail(binding.sessionId)) {
            this.deferredForwardLoadingSessions.add(binding.sessionId);
            return;
        }
        if (decision.kind === 'apply') {
            const didApply = await this.applyExternalSessionTranscriptItems(binding.sessionId, decision.items, {
                nextCursor: decision.nextCursor,
                expectedAuthorityKey,
            });
            if (didApply) {
                storage.getState().setSessionTranscriptLoadIssue(binding.sessionId, null);
            }
            return;
        }
        if (decision.reason === 'already_current') {
            storage.getState().setSessionTranscriptLoadIssue(binding.sessionId, null);
            return;
        }
        if (decision.reason === 'resync_required') {
            await this.fetchExternalSessionMessages(binding.sessionId, currentLink, {
                mode: this.externalSessionTailStateBySessionId.get(binding.sessionId)?.recoveryRequired ? 'replace' : 'merge_latest',
            });
            return;
        }
        if (decision.reason === 'source_replaced') {
            this.fenceExternalSessionTranscriptAuthority(binding.sessionId, expectedAuthorityKey);
            const hydration = await this.ensureSessionVisibleForMessageRoute(
                binding.sessionId,
                {
                    forceRefresh: true,
                    serverId: options?.sourceServerId ?? undefined,
                },
            );
            if (hydration.kind !== 'available' || !shouldContinue()) return;
            // The hydration ALREADY enqueued this Session's canonical messages sync unit,
            // which is the one owner of transcript rehydration. Awaiting that queue keeps
            // the replacement read to a single pass; a direct `fetchMessages` here raced
            // the enqueued unit and produced a second, competing source read.
            await this.getOrCreateMessagesSync(binding.sessionId).awaitQueue();
            return;
        }
        if (decision.reason === 'source_unavailable') {
            storage.getState().setSessionTranscriptLoadIssue(binding.sessionId, {
                kind: 'read_failed',
                errorCode: 'agent_unavailable',
            });
            return;
        }
        if (decision.reason === 'read_failed') {
            storage.getState().setSessionTranscriptLoadIssue(binding.sessionId, {
                kind: 'read_failed',
                errorCode: 'internal_error',
            });
        }
    }

    //
    // Apply store
    //

    private applyMessages = (
        sessionId: string,
        messages: NormalizedMessage[],
        options?: { notifyVoice?: boolean; notifyActivity?: boolean; replaceExisting?: boolean; activitySource?: 'reconciliation' }
    ) => {
        const session = storage.getState().sessions[sessionId] ?? null;
        const notificationAddress = normalizeSessionAddress(session?.serverId, sessionId);
        const externalSessionLink = readExternalSessionLink(
            session ? readSessionOwnerMetadataView(session) : null,
        );
        const authorityFilteredMessages = session && externalSessionLink
            ? filterExternalSessionTranscriptAuthorityMessages(
                messages,
                this.resolveTranscriptAuthority(session, externalSessionLink),
            )
            : messages;
        const result = options?.replaceExisting === true
            ? storage.getState().replaceSessionMessages(sessionId, authorityFilteredMessages)
            : storage.getState().applyMessages(sessionId, authorityFilteredMessages);
        const checkpointSettings = storage.getState().settings;
        if (!this.embedSessionScope && checkpointSettings['scm.diffSummary.prefetch'] === true
            && checkpointSettings['scm.diffSummary.enabled'] !== false && result.changed.length > 0) {
            const lifetime = captureActiveServerAccountScopeLifetime();
            const messagesById = storage.getState().sessionMessages[sessionId]?.messagesMap;
            if (session && lifetime && messagesById) {
                const changedMessages = result.changed.flatMap((id) => {
                    const message = messagesById[id];
                    return message?.kind === 'tool-call' && message.tool.name === 'Diff' ? [message] : [];
                });
                const serverScopeIsCurrent = this.createServerScopeGuard();
                if (changedMessages.length > 0) fireAndForget(import('@/sync/ops/scmDiffSummary/checkpointPrefetch').then(({ prefetchCompletedCheckpointMessages }) => (
                    prefetchCompletedCheckpointMessages({ session, messages: changedMessages, settings: checkpointSettings, lifetime,
                        shouldContinue: () => serverScopeIsCurrent() && storage.getState().sessions[sessionId]?.serverId === session.serverId,
                    })
                )), { tag: 'Sync.applyMessages.prefetchCompletedCheckpoint', logError: false });
            }
        }
        const gap = this.sessionMessagesTailDiscontinuityBySessionId.get(sessionId);
        if (gap?.kind === 'opaque') {
            this.commitSessionTailDiscontinuity(sessionId, applyTailDiscontinuityOpaqueForwardPage({
                prev: gap, pageMaterializedMessageIds: result.changed,
            }));
        }
        let receivedCommittedUserLocalIds: Set<string> | null = null;
        for (const message of authorityFilteredMessages) {
            if (message.role === 'user' && typeof message.localId === 'string' && message.localId.length > 0) {
                (receivedCommittedUserLocalIds ??= new Set<string>()).add(message.localId);
            }
        }
        if (receivedCommittedUserLocalIds !== null) {
            const refreshedTargets = new Set<string | undefined>();
            for (const pending of storage.getState().sessionPending[sessionId]?.messages ?? []) {
                if (
                    pending.source !== 'server_pending'
                    || typeof pending.localId !== 'string'
                    || !receivedCommittedUserLocalIds.has(pending.localId)
                ) continue;
                const targetKey = pending.recipient?.runId;
                if (refreshedTargets.has(targetKey)) continue;
                refreshedTargets.add(targetKey);
                // Settlement publishes the committed message and pending receipt separately.
                // Even an unchanged committed twin requests the canonical snapshot: transcript
                // equality does not prove whether the durable row was removed or retained.
                // Main and Run queues have separate snapshots; refresh each matched target once.
                fireAndForget(this.fetchPendingMessages(sessionId, undefined, pending.recipient), {
                    tag: 'Sync.applyMessages.fetchPendingMessages',
                    logError: false,
                });
            }
        }
        const notifyVoice = options?.notifyVoice !== false;
        const notifyActivity = options?.notifyActivity ?? notifyVoice;
        if (notifyVoice || notifyActivity) {
            let m: Message[] = [];
            for (let messageId of result.changed) {
                const message = storage.getState().sessionMessages[sessionId].messagesMap[messageId];
                if (message && !isRecoveredHistoryTranscriptObservation(message)) {
                    m.push(message);
                }
            }
            if (notifyVoice && notificationAddress && m.length > 0) {
                voiceHooks.onMessages(notificationAddress, m);
            }
            const latestReadyEventSeq = (result as { latestReadyEventSeq?: number }).latestReadyEventSeq;
            if (notificationAddress && result.hasReadyEvent && this.shouldNotifyReadySeq(notificationAddress.serverId, sessionId, latestReadyEventSeq)) {
                const committedSequence = typeof latestReadyEventSeq === 'number'
                    && Number.isInteger(latestReadyEventSeq)
                    && latestReadyEventSeq > 0
                    ? {
                        sequenceDomain: 'session_transcript' as const,
                        sequence: latestReadyEventSeq,
                    }
                    : undefined;
                if (notifyVoice) {
                    voiceHooks.onReady(notificationAddress, m);
                }
                if (notifyActivity) {
                    notifyActivityReady({
                        serverId: notificationAddress.serverId,
                        sessionId,
                    }, m, committedSequence, m.find((message) => message.seq === latestReadyEventSeq)?.localId ?? undefined, options?.activitySource);
                }
            }
        }
        return result;
    }

    private publishSessionMessagesHistoryStartCoverage(sessionId: string): void {
        const pagingKey = this.buildSessionMessagesPaginationKey({ sessionId, scope: 'main' });
        // Partial tail snapshots retain the materialized start. Only a cache reset,
        // replacement, eviction or deletion revokes this coverage.
        if (this.sessionMessagesHasMoreOlderByKey.get(pagingKey) === false) {
            storage.getState().markSessionMessagesHistoryStartLoaded(sessionId);
        }
    }

    private updateSessionMessagesPaginationFromPage(
        sessionId: string,
        chain: { scope: SessionMessagesScope; sidechainId?: string | null },
        page: {
            messages: Array<{ seq: number }>;
            hasMore?: boolean;
            nextBeforeSeq?: number | null;
            nextAfterSeq?: number | null;
        },
        options?: { allowHasMoreInference?: boolean; direction?: 'older' | 'newer'; deferHistoryStartCoverage?: boolean },
    ): void {
        const pagingKey = this.buildSessionMessagesPaginationKey({
            sessionId,
            scope: chain.scope,
            sidechainId: chain.sidechainId,
        });

        const prev: SessionMessagesPaginationState = {
            beforeSeq: this.sessionMessagesBeforeSeqByKey.get(pagingKey) ?? null,
            hasMoreOlder: this.sessionMessagesHasMoreOlderByKey.has(pagingKey)
                ? (this.sessionMessagesHasMoreOlderByKey.get(pagingKey) as boolean)
                : null,
            paginationSupported: this.sessionMessagesPaginationSupportedByKey.has(pagingKey)
                ? (this.sessionMessagesPaginationSupportedByKey.get(pagingKey) as boolean)
                : null,
        };

        const update = computeSessionMessagesPaginationUpdateFromPage({
            prev,
            page,
            pageSize: SESSION_MESSAGES_PAGE_SIZE,
            allowHasMoreInference: options?.allowHasMoreInference === true,
            direction: options?.direction ?? 'older',
        });

        if (chain.scope === 'main' && typeof update.maxSeq === 'number') {
            this.markSessionMaterializedMaxSeq(sessionId, update.maxSeq);
        }

        if (typeof update.next.beforeSeq === 'number') {
            this.sessionMessagesBeforeSeqByKey.set(pagingKey, update.next.beforeSeq);
        }

        if (update.next.hasMoreOlder == null) {
            this.sessionMessagesHasMoreOlderByKey.delete(pagingKey);
        } else {
            this.sessionMessagesHasMoreOlderByKey.set(pagingKey, update.next.hasMoreOlder);
        }

        if (chain.scope === 'main' && options?.direction !== 'newer' && options?.deferHistoryStartCoverage !== true) {
            // Snapshot callbacks precede materialization; their completion callback
            // publishes coverage instead. Older pages arrive here after apply, even
            // when an empty final page adds no messages.
            this.publishSessionMessagesHistoryStartCoverage(sessionId);
        }

        if (update.next.paginationSupported == null) {
            this.sessionMessagesPaginationSupportedByKey.delete(pagingKey);
        } else {
            this.sessionMessagesPaginationSupportedByKey.set(pagingKey, update.next.paginationSupported);
        }
    }

    /**
     * Commit a tail-reset discontinuity transition (open/advance/close) for the session's
     * MAIN chain and publish the display floor the transcript tail consumes. `null` closes.
     */
    private commitSessionTailDiscontinuity(
        sessionId: string,
        record: SessionMessagesTailDiscontinuity | null,
    ): void {
        const previous = this.sessionMessagesTailDiscontinuityBySessionId.get(sessionId) ?? null;
        if (record) {
            this.sessionMessagesTailDiscontinuityBySessionId.set(sessionId, record);
            // While a hole is open there IS more older content by construction (the hole
            // and the prefix), regardless of page-size inference on individual walk pages.
            if (record.kind === 'seq') {
                const pagingKey = this.buildSessionMessagesPaginationKey({ sessionId, scope: 'main' });
                this.sessionMessagesHasMoreOlderByKey.set(pagingKey, true);
            }
        } else {
            this.sessionMessagesTailDiscontinuityBySessionId.delete(sessionId);
        }
        if (previous === record) return;
        storage.getState().setSessionTailContiguousBoundary(sessionId, record
            ? record.kind === 'seq' ? { kind: 'seq', seq: record.walkCursor } : { kind: 'messageIds', messageIds: record.boundaryMessageIds }
            : null);
    }

    /** Retained older availability belongs to the cursor, not a mounted list's lifetime. */
    getSessionOlderMessagesAvailability(sessionId: string): boolean | null {
        if (this.getSessionTargetWindowState(sessionId).isWindowMode) return null;
        const fork = getForkedTranscriptSnapshotCached(storage.getState(), sessionId, { textUpdates: false });
        if (fork) {
            return computeForkedTranscriptHasMoreOlder({
                fork,
                getHasMoreOlder: (id) => this.sessionMessagesHasMoreOlderByKey.get(
                    this.buildSessionMessagesPaginationKey({ sessionId: id, scope: 'main' }),
                ),
            });
        }
        const gap = this.sessionMessagesTailDiscontinuityBySessionId.get(sessionId);
        if (gap?.kind === 'opaque') return gap.walkCursor !== null;
        if (this.isLiveAgentTranscriptSession(sessionId)) {
            return this.externalSessionHasMoreOlderBySessionId.get(sessionId) ?? null;
        }
        return this.sessionMessagesHasMoreOlderByKey.get(this.buildSessionMessagesPaginationKey({ sessionId, scope: 'main' }))
            ?? (gap ? true : null);
    }

    /**
     * Open (or extend) the tail-reset discontinuity from a snapshot latest page applied
     * over previously materialized content (C6/D2b fetch-then-merge). Without this, the
     * hole between the old prefix and the new island was unrepresentable: the monotone-min
     * older cursor kept paging below the prefix and the gap never filled (live defect
     * 2026-07-12).
     */
    private openSessionTailDiscontinuityFromSnapshotPage(
        sessionId: string,
        prefixMaxSeqBeforeSnapshot: number,
        page: { messages: Array<{ seq: number }> },
    ): void {
        if (!Array.isArray(page.messages) || page.messages.length === 0) return;
        let snapshotMinSeq = Number.POSITIVE_INFINITY;
        for (const message of page.messages) {
            if (typeof message.seq === 'number' && Number.isFinite(message.seq) && message.seq < snapshotMinSeq) {
                snapshotMinSeq = message.seq;
            }
        }
        if (!Number.isFinite(snapshotMinSeq)) return;
        const prev = this.sessionMessagesTailDiscontinuityBySessionId.get(sessionId) ?? null;
        const next = openTailDiscontinuityFromSnapshot({
            prev: prev?.kind === 'seq' ? prev : null,
            prefixMaxSeq: prefixMaxSeqBeforeSnapshot,
            snapshotMinSeq,
        });
        if (next !== prev) {
            this.commitSessionTailDiscontinuity(sessionId, next);
        }
    }

    private applySessions = (sessions: (Omit<Session, "presence"> & {
        presence?: "online" | number;
    })[], source: SessionPublicationSource = 'full') => {
        if (this.embedSessionScope) {
            if (!this.embedSessionScope.isCurrent()) return;
            const admitted = sessions.filter((session) => session.id === this.embedSessionScope?.scope.sessionId);
            for (const session of admitted) this.activeServerSessionIds.add(session.id);
            storage.getState().applySessions(admitted, source);
            return;
        }
        const active = storage.getState().getActiveSessions();
        const activeServerId = this.getAppliedTransportTarget()?.serverId ?? '';
        const authorityBeforeBySessionId = new Map<string, string>();
        for (const incoming of sessions) {
            const current = storage.getState().sessions[incoming.id] ?? null;
            if (!current) continue;
            const previousHome = normalizeScopedServerId(current.serverId);
            const incomingHome = normalizeScopedServerId(incoming.serverId);
            if (previousHome && incomingHome && !areServerProfileIdentifiersEquivalent(previousHome, incomingHome)) {
                // The full carrier and transcript are keyed by bare id. A new exact
                // Home binding must retire the old body's cursors and repair markers
                // before publishing that carrier; same-Home refreshes retain history.
                this.resetSessionTranscriptState(incoming.id);
            }
            authorityBeforeBySessionId.set(
                incoming.id,
                externalSessionTranscriptAuthorityKey(
                    this.resolveTranscriptAuthority(current, readExternalSessionLinkFromSession(current)),
                ),
            );
        }

        // When multi-server mode is enabled, we use `activeServerSessionIds` as a conservative
        // guard to avoid cross-server message fetches after the initial session snapshot. Ensure
        // that any newly-applied sessions (via socket updates, create flows, etc.) are treated as
        // "known" on the active server too, otherwise message fetches can be incorrectly skipped.
        for (const session of sessions) {
            const sessionServerId = typeof session?.serverId === 'string' ? session.serverId.trim() : '';
            if (session?.id && (!sessionServerId || areServerProfileIdentifiersEquivalent(sessionServerId, activeServerId))) {
                this.activeServerSessionIds.add(session.id);
            }
        }
        storage.getState().applySessions(sessions, source);
        // Session hydration owns key readiness. Wake observed System Record
        // projections so they reopen their retained bytes from the newly current
        // Session context; this is deliberately not a record refetch.
        for (const incoming of sessions) {
            const recordAddress = normalizeSessionAddress(incoming.serverId, incoming.id);
            if (!recordAddress) continue;
            for (const repository of this.sessionSystemRecordRepositories.values()) {
                repository.notifyContentContextChanged(recordAddress);
            }
        }
        for (const incoming of sessions) {
            const previousAuthority = authorityBeforeBySessionId.get(incoming.id);
            const current = storage.getState().sessions[incoming.id] ?? null;
            if (!previousAuthority || !current) continue;
            const nextAuthority = externalSessionTranscriptAuthorityKey(
                this.resolveTranscriptAuthority(current, readExternalSessionLinkFromSession(current)),
            );
            if (
                nextAuthority !== previousAuthority
                && this.externalSessionTranscriptFenceAuthorityKeyBySessionId.get(incoming.id)
                    !== nextAuthority
            ) {
                this.externalSessionTranscriptFenceAuthorityKeyBySessionId.delete(incoming.id);
            }
            if (nextAuthority !== previousAuthority && this.messagesSync.has(incoming.id)) {
                this.getOrCreateMessagesSync(incoming.id).invalidateCoalesced();
            }
        }
        const newActive = storage.getState().getActiveSessions();
        this.applySessionDiff(active, newActive);
    }

    public commitAckedOutboundUserMessage(params: AckedOutboundUserMessageCommitInput): void {
        const localId = params.localId || null;

        // A successful ACK may arrive after the server's authoritative whole-session deletion.
        // There is no carrier to normalize into, so retire the pending row here and stop — this is
        // the one path where a standalone removal is the ONLY writer.
        if (!storage.getState().sessions[params.sessionId]) {
            if (params.removePending !== false && localId) {
                storage.getState().removePendingMessage(params.sessionId, localId);
            }
            return;
        }

        const committed = normalizeRawMessage(params.ack.id, localId, params.createdAt, params.rawRecord, {
            seq: params.ack.seq,
        });
        if (committed) {
            // `applyMessages` retires the matching pending projection in the SAME store update, so
            // the transcript never publishes a frame carrying NEITHER row for this utterance. The
            // removal that used to run BEFORE this was a second writer whose only observable effect
            // was that empty frame — the send flicker, seen from the data side.
            this.commitAckedSessionMessage(params.sessionId, committed);
        } else if (localId) {
            // Nothing to apply, so the pending row has no twin arriving: retire it directly.
            storage.getState().removePendingMessage(params.sessionId, localId);
        }
    }

    public persistSessionTranscriptMessage = async (
        input: PersistSessionTranscriptMessageInput,
    ): Promise<void> => {
        const scope = getActiveServerAccountScope();
        if (!scope) {
            throw new Error('Voice transcript persistence requires an active server-account scope');
        }
        const activeCredentials = this.credentials;
        const activeEncryption = this.encryption;
        if (!activeCredentials) {
            throw new Error('Voice transcript persistence requires active account credentials');
        }
        const resolvedAuthority = await captureServerRequestAuthorityForServerAccountScope({
            scope,
            activeRequest: this.requestViaConfiguredSocket,
        });
        try {
        if (resolvedAuthority.context.token !== activeCredentials.token) {
            throw new Error('Voice transcript persistence server-account credentials changed');
        }
        const authority: ServerAccountRequestAuthority = {
            ...resolvedAuthority,
            context: {
                ...resolvedAuthority.context,
                credentials: activeCredentials,
                encryption: activeEncryption,
            },
        };
        const assertAuthorityCurrent = (): void => {
            if (!this.isServerAccountSessionAuthorityCurrent(authority)) {
                throw new Error('Voice transcript persistence server-account scope changed');
            }
        };
        assertAuthorityCurrent();

        let session = storage.getState().sessions[input.sessionId] ?? null;
        let readSessionEncryption = () => authority.context.encryption?.getSessionEncryption(input.sessionId) ?? null;
        let sessionEncryption = session?.encryptionMode === 'plain'
            ? null
            : readSessionEncryption();
        if (!session || (session.encryptionMode !== 'plain' && !sessionEncryption)) {
            const hydration = await this.ensureSessionVisibleForMessageRoute(
                input.sessionId,
                {
                    forceRefresh: true,
                    serverId: authority.scope.serverId,
                    authority,
                    onHydratedSessionReader: reader => { readSessionEncryption = reader; },
                },
            );
            assertAuthorityCurrent();
            if (
                hydration.kind !== 'available'
                || hydration.sessionId !== input.sessionId
            ) {
                throw new Error(`Session ${input.sessionId} not found`);
            }
            session = storage.getState().sessions[input.sessionId] ?? null;
            sessionEncryption = session?.encryptionMode === 'plain'
                ? null
                : readSessionEncryption();
        }
        if (!session) {
            throw new Error(`Session ${input.sessionId} not found`);
        }
        assertAuthorityCurrent();
        const sessionEncryptionMode = session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
        const isTranscriptHistorySession = isVoiceTranscriptHistorySession({
            active: session.active,
            metadata: readSessionOwnerMetadataView(session),
        });
        let receivedAuthoritativeSessionNotFound = false;
        const persisted = await (async () => {
            try {
                return await persistSessionTranscriptMessageAtOwner({
                    request: async (path, init) => {
                        assertAuthorityCurrent();
                        const response = await authority.request(path, init);
                        const responseBody = response.status === 404
                            ? await response.clone().json().catch(() => null)
                            : null;
                        assertAuthorityCurrent();
                        // The current v2 write route uses this exact payload for a
                        // deleted or inaccessible session. Other 404 shapes may be
                        // a route/version failure and must leave local state alone.
                        receivedAuthoritativeSessionNotFound = response.status === 404
                            && looksLikeCurrentV2SessionNotFound404(responseBody);
                        return response;
                    },
                    sessionEncryptionMode,
                    ...(sessionEncryption
                        ? {
                            encryptRawRecord: async (rawRecord) => {
                                assertAuthorityCurrent();
                                const encrypted = await sessionEncryption.encryptRaw(rawRecord);
                                assertAuthorityCurrent();
                                return encrypted;
                            },
                        }
                        : {}),
                }, input);
            } catch (error) {
                assertAuthorityCurrent();
                if (receivedAuthoritativeSessionNotFound) {
                    this.retireLocalSession(input.sessionId, authority.scope.serverId);
                }
                throw error;
            }
        })();
        assertAuthorityCurrent();
        // A delete-session update may arrive while an earlier write response is
        // still in flight. The server-side whole-session deletion remains
        // authoritative: never recreate a local transcript bucket from a late
        // ACK for the deleted carrier (or any other deleted session).
        if (!storage.getState().sessions[input.sessionId]) {
            return;
        }
        this.commitAckedSessionMessage(input.sessionId, persisted.message, {
            advanceReadCursor: isTranscriptHistorySession,
        });
        } finally {
            await resolvedAuthority.release?.();
        }
    };

    private commitAckedSessionMessage(
        sessionId: string,
        committed: NormalizedMessage,
        options?: Readonly<{ advanceReadCursor?: boolean }>,
    ): void {
        this.applyMessages(sessionId, [committed]);
        const seq = committed.seq;
        if (typeof seq !== 'number' || !Number.isFinite(seq)) return;

        const prevMaterializedMaxSeq = this.sessionMaterializedMaxSeqById[sessionId] ?? 0;
        this.markSessionMaterializedMaxSeq(sessionId, seq);
        if (seq > prevMaterializedMaxSeq + 1 && storage.getState().sessionMessages[sessionId]?.isLoaded === true) {
            this.recoverSessionMessageGap(sessionId, { prevMaterializedMaxSeq, messageSeq: seq });
        }
        const currentSession = storage.getState().sessions[sessionId];
        if (currentSession) {
            this.applySessions([
                {
                    ...currentSession,
                    updatedAt: nowServerMs(),
                    seq: Math.max(currentSession.seq ?? 0, seq),
                    ...(options?.advanceReadCursor === true
                        ? {
                            lastViewedSessionSeq: Math.max(
                                currentSession.lastViewedSessionSeq ?? 0,
                                seq,
                            ),
                        }
                        : {}),
                },
            ], 'projection');
        }
    }

    private readSessionMessagesCatchUpAfterSeq(sessionId: string): number {
        const materializedMaxSeq = this.sessionMaterializedMaxSeqById[sessionId] ?? 0;
        const gap = readTranscriptGap(this.deferredTranscriptState, sessionId);
        return gap ? Math.min(materializedMaxSeq, gap.afterSeq) : materializedMaxSeq;
    }

    private recoverSessionMessageGap(
        sessionId: string,
        info: Readonly<{ prevMaterializedMaxSeq: number; messageSeq: number | null }>,
    ): void {
        this.deferredTranscriptState = markTranscriptGap(this.deferredTranscriptState, sessionId, {
            afterSeq: info.prevMaterializedMaxSeq,
            throughSeq: info.messageSeq,
        });
        // Retain a later cycle when this observation races an already-running page.
        this.getOrCreateMessagesSync(sessionId).invalidate();
        this.repairStaleTranscriptIfNeeded(sessionId);
    }

    private markSessionMaterializedMaxSeq(sessionId: string, seq: number): void {
        if (!sessionId) return;
        if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) return;
        const prev = this.sessionMaterializedMaxSeqById[sessionId] ?? 0;
        if (seq <= prev) return;
        this.sessionMaterializedMaxSeqById = { ...this.sessionMaterializedMaxSeqById, [sessionId]: seq };
        this.sessionMaterializedMaxSeqDirty = true;
        this.scheduleSessionMaterializedMaxSeqFlush();
    }

    private markSessionKnownRemoteSeq(sessionId: string, seq: number): void {
        this.deferredTranscriptState = markDeferredTranscriptRemoteSeq(this.deferredTranscriptState, sessionId, seq);
    }

    private markSessionTranscriptDeferred(sessionId: string, marker: DeferredTranscriptMarker): void {
        this.deferredTranscriptState = markTranscriptDeferred(this.deferredTranscriptState, sessionId, marker);
    }

    private markSessionTranscriptStale(sessionId: string, marker: DeferredTranscriptMarker): void {
        this.deferredTranscriptState = markTranscriptStale(this.deferredTranscriptState, sessionId, marker);
    }

    private markSessionStateHydrationDeferred(sessionId: string): void {
        this.deferredSessionStateHydrationState = markSessionStateHydrationDeferred(
            this.deferredSessionStateHydrationState,
            sessionId,
        );
    }

    private shouldNotifyReadySeq(serverId: string, sessionId: string, seq: number | null | undefined): boolean {
        if (typeof seq !== 'number' || !Number.isFinite(seq)) return true;
        const normalizedSeq = Math.max(0, Math.trunc(seq));
        const addressKey = sessionAddressKey({ serverId, sessionId });
        const previousSeq = this.notifiedReadySeqByAddressKey[addressKey] ?? -1;
        if (normalizedSeq <= previousSeq) return false;
        this.notifiedReadySeqByAddressKey = {
            ...this.notifiedReadySeqByAddressKey,
            [addressKey]: normalizedSeq,
        };
        return true;
    }

    private notifyReadyProjectionAdvance(sessionId: string, seq: number, serverId: string | null, localId?: string): void {
        const address = normalizeSessionAddress(serverId, sessionId);
        if (!address || !this.shouldNotifyReadySeq(address.serverId, address.sessionId, seq)) return;
        voiceHooks.onReady(address, []);
        notifyActivityReady({
            serverId: address.serverId,
            sessionId: address.sessionId,
        }, [], {
            sequenceDomain: 'session_transcript',
            sequence: seq,
        }, localId);
    }

    private scheduleSessionMaterializedMaxSeqFlush(): void {
        if (this.sessionMaterializedMaxSeqFlushTimer) return;
        const scope = this.pendingSettingsScope;
        const generation = this.serverScopeGeneration;
        this.sessionMaterializedMaxSeqFlushTimer = setTimeout(() => {
            this.sessionMaterializedMaxSeqFlushTimer = null;
            if (
                this.serverScopeGeneration !== generation ||
                !areAccountSettingsScopesEqual(this.pendingSettingsScope, scope)
            ) {
                return;
            }
            this.flushSessionMaterializedMaxSeq();
        }, 2_000);
    }

    private flushSessionMaterializedMaxSeq(): void {
        this.flushSessionMaterializedMaxSeqForCurrentScopeNow();
    }

    private flushSessionMaterializedMaxSeqForCurrentScopeNow(): void {
        if (this.sessionMaterializedMaxSeqFlushTimer) {
            clearTimeout(this.sessionMaterializedMaxSeqFlushTimer);
            this.sessionMaterializedMaxSeqFlushTimer = null;
        }
        if (!this.sessionMaterializedMaxSeqDirty) return;
        this.sessionMaterializedMaxSeqDirty = false;
        if (!this.pendingSettingsScope) return;
        saveSessionMaterializedMaxSeqById(this.sessionMaterializedMaxSeqById, this.pendingSettingsScope);
    }

    private applySessionDiff = (active: Session[], newActive: Session[]) => {
        let wasActive = new Set(active.map(s => s.id));
        let isActive = new Set(newActive.map(s => s.id));
        for (let s of active) {
            if (!isActive.has(s.id)) {
                const address = normalizeSessionAddress(s.serverId, s.id);
                if (address) voiceHooks.onSessionOffline(address, s.metadata ?? undefined);
            }
        }
        for (let s of newActive) {
            if (!wasActive.has(s.id)) {
                const address = normalizeSessionAddress(s.serverId, s.id);
                if (address) voiceHooks.onSessionOnline(address, s.metadata ?? undefined);
            }
        }
    }

}

// Global singleton instance
export const sync = new Sync();

export type SyncEmbedSessionOptions = Readonly<{
    scope: Readonly<{ kind: 'embedSession'; sessionId: string }>;
    accountId: string;
    endpointUrl: string;
    /** From the admitted child grant; approval inventory is not required for Send. */
    approvalGranted: boolean;
    accountMode?: 'plain' | 'e2ee';
    sessionKey?: string | null;
    composerOptionsInput?: ComposerOptionsInputV1 | null;
    composerOptionsGrant?: ApiTokenGrantV1 | null;
    isCurrent: () => boolean;
    onCredentialRejected?: () => void;
}>;
export type SyncCreateOptions = SyncEmbedSessionOptions | Readonly<{ scope: Readonly<{ kind: 'account' }> }>;

export type SyncServerTarget = Readonly<{
    serverId: string;
    serverUrl: string;
    generation: number;
    runtimeOrigin?: string;
    carrier?: 'https' | 'iroh';
    homeCarrier?: HomeCarrier | null;
}>;

function assertSyncServerTargetCurrent(target: SyncServerTarget | undefined): void {
    if (!target) return;
    const current = getActiveServerSnapshot();
    if (
        current.serverId !== target.serverId
        || current.serverUrl !== target.serverUrl
        || current.generation !== target.generation
    ) {
        throw new Error('Active Home changed while preparing its authenticated Sync runtime');
    }
}

function buildSyncSocketConfig(credentials: AuthCredentials, target?: SyncServerTarget) {
    const snapshot = target ?? getActiveServerSnapshot();
    const homeCarrier = target?.homeCarrier ?? getActiveServerHomeCarrier();
    return {
        endpoint: snapshot.serverUrl,
        token: credentials.token,
        credentials,
        serverId: snapshot.serverId,
        generation: snapshot.generation,
        ...(snapshot.runtimeOrigin ? { runtimeOrigin: snapshot.runtimeOrigin } : {}),
        ...(snapshot.carrier ? { carrier: snapshot.carrier } : {}),
        ...(homeCarrier !== undefined ? { homeCarrier } : {}),
    };
}

//
// Init sequence
//

let isInitialized = false;
export async function syncCreate(credentials: AuthCredentials, target?: SyncServerTarget) {
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }
    isInitialized = true;
    await syncInit(credentials, false, target);
}

/** Local restore phase: warm cache into the store, with no transport dependency. */
export function syncHydrateLocalState(credentials: AuthCredentials, target?: SyncServerTarget): void {
    sync.hydrateLocalState(credentials, target);
}

export async function syncRestore(credentials: AuthCredentials, target?: SyncServerTarget) {
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }
    isInitialized = true;
    await syncInit(credentials, true, target);
}

export async function syncSwitchServer(credentials: AuthCredentials | null, target?: SyncServerTarget): Promise<void> {
    if (!credentials) {
        if (isInitialized) {
            sync.disconnectServer();
            isInitialized = false;
        }
        return;
    }

    if (!isInitialized) {
        await syncCreate(credentials, target);
        return;
    }

    await sync.switchServer(credentials, target);
}

async function syncInit(credentials: AuthCredentials, restore: boolean, target?: SyncServerTarget) {

    // Initialize sync engine
    const encryptionTarget = target ?? getActiveServerSnapshot();
    const encryption = await resolveScopedAccountEncryption({
        serverId: encryptionTarget.serverId, serverUrl: encryptionTarget.serverUrl, credentials,
    });

    assertSyncServerTargetCurrent(target);

    // Initialize socket connection
    apiSocket.initialize(buildSyncSocketConfig(credentials, target), encryption);

    // Wire socket status to storage
    apiSocket.onStatusChange((status) => {
        storage.getState().setSocketStatus(status);
    });
    bindEndpointConnectivityStateToRealtimeStore({
        subscribe: apiSocket.onConnectionStateChange,
        onEndpointOnline: () => {
            queueMicrotask(() => {
                fireAndForget(sync.resumeSync('server-reachable'), { tag: 'Sync.resumeSync.server-reachable' });
            });
        },
    });
    bindSocketErrorToRealtimeStore(apiSocket.onError);

    // Initialize sessions engine
    if (restore) {
        await sync.restore(credentials, encryption, target);
    } else {
        await sync.create(credentials, encryption, target);
    }
}

registerSyncRuntime({ sync, syncCreate, syncHydrateLocalState, syncRestore, syncSwitchServer });

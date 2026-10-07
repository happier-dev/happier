import { registerSyncRuntime } from './sync';
import { type SessionMessageV1, type SessionMessagesPageV1 } from '@happier-dev/protocol';
import { projectSessionMetadataForWire } from '@happier-dev/protocol/sessions/metadata/terminalMetadata';
import { projectComposerOptionsInputV1 } from '@happier-dev/protocol/embed';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import {
    publishHomeAccountChange,
    subscribeHomeCredentialChange,
} from '@/sync/runtime/orchestration/homeAccountChange';
import { refreshWorkflowRunById } from '@/sync/engine/workflows/refreshWorkflowRun';
import { invalidateMachinePoolProjection } from '@/sync/engine/machines/machinePoolProjection';
import { invalidateSavedSecretCatalogProjection } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { readSessionMetadataLayoutVersion } from './engine/sessions/parsePlainSessionPayload';
import Constants from 'expo-constants';
import { t } from '@/text';
import {
    readExternalSessionOperationState,
} from '@happier-dev/agents';
import {
    apiSocket,
} from '@/sync/api/session/apiSocket';
import { emitSessionReadCursorUpdateWithServerScope } from '@/sync/api/session/emitSessionReadCursorUpdateWithServerScope';
import { isDemoModeActive } from '@/demoMode/runtime/enterExitDemoMode';
import { ensureSessionRuntimeForPendingInput } from '@/sync/ops';
import {
    isTokenOnlyAuthCredentials,
    type AuthCredentials,
} from '@/auth/storage/tokenStorage';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import {
    fetchAccountEncryptionCurrentness,
    invalidateAccountEncryptionModeCache,
} from '@/sync/api/account/apiAccountEncryptionMode';
import { getPendingQueueWakeResumeOptions } from '@/sync/domains/pending/pendingQueueWake';
import { normalizeNonEmptyString } from '@/utils/strings/normalizeNonEmptyString';
import {
    clearSessionMessageDerivedCachesForServerScopeReset,
    storage,
} from './domains/state/storage';

import type { ApiEphemeralActivityUpdate } from './api/types/apiTypes';
import {
    Session,
    Machine,
    type PendingMessage,
} from './domains/state/storageTypes';
import { MetadataSchema, type AgentState, type Metadata } from '@happier-dev/session-core/state';
import { InvalidateSync } from '@/utils/sessions/sync';
import { PauseController } from '@/utils/timing/pauseController';
import { createUserRequestLeaseOwner } from '@/sync/runtime/connectivity/userRequestLease';
import { consumeActionOperationSnapshotPush } from '@/sync/domains/actionOperations/consumeActionOperationSnapshotPush';
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
import { resolveSocketErrorClassification } from '@/sync/runtime/connectivity/resolveSocketErrorClassification';
import { isTransientConnectivityError, shouldRetryError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
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
import type { OrdinarySessionListLifecycle } from '@/sync/domains/session/listing/ordinarySessionListHomeState';
import {
    resolveOrdinarySessionListCoverage,
    type SessionListHomeObservationPhase,
} from '@/sync/domains/session/listing/sessionListHomeObservation';
import { createSessionSystemRecordRepository, type SessionSystemRecordRepository } from '@/sync/domains/sessionSystemRecords/repository';
import type { SessionSystemRecordFetchResult } from '@/sync/domains/sessionSystemRecords/transport';
import { invalidateSessionSystemRecordsFromChanges } from '@/sync/domains/sessionSystemRecords/changeWatch';
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
import type {
    EnsureSessionVisibleForRouteResult,
    SessionRouteHydrationMissingCause,
    SessionRouteHydrationRetryCause,
} from '@/sync/domains/session/sessionRouteHydrationState';
import {
    createHostedSystemSessionEnsurer,
    type EnsureHostedSystemSessionInput,
    type HostedSystemSessionEnsureResult,
} from '@/sync/domains/session/hostedSystemSession';
import { hasAuthoritativeSessionRouteData } from '@/sync/domains/session/hasAuthoritativeSessionRouteData';
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
import { ActivityUpdateAccumulator } from '@/sync/engine/activity/activityUpdateAccumulator';
import {
    MachineActivityAccumulator,
    type MachineActivityUpdate,
} from '@/sync/engine/activity/machineActivityAccumulator';
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
    RawRecordSchema,
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
    resolveWarmCacheAccountScope,
    setWarmCacheAccountScope,
} from './domains/state/warmCachePersistence';
import {
    buildMachineDisplayCacheEntriesFromRenderables,
    buildMachineDisplayRenderableFromCacheEntry,
    buildSessionListCacheEntriesFromRenderables,
    buildSessionListRenderableFromCacheEntry,
} from './domains/state/warmCacheAdapters';
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
    getSessionSurfaceVisibilitySnapshot,
} from './domains/session/sessionSurfaceVisibility';
import { clearMountedSessionRealtimeScmConsumerScopes } from './runtime/sessionRealtimeScmConsumers';
import { resolveSessionLiveConsumption } from './runtime/sessionLiveConsumption';
import { resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import {
    catchUpTranscriptSourceWindow,
    readInitialTranscriptSourceWindow,
} from '@happier-dev/agents';
import { SessionViewerProjectionV1Schema } from '@happier-dev/protocol/sessions/personal/viewer';
import { isSessionPersonallyTrackedForViewer } from './domains/session/readState/sessionViewer';
import { updateSessionMetadataWithRetry as updateSessionMetadataWithRetryRpc, type SessionMetadataUpdateRequest, type UpdateMetadataAck } from './domains/session/metadata/updateSessionMetadataWithRetry';
import type { ArtifactBodyInput, ArtifactHeader, DecryptedArtifact } from './domains/artifacts/artifactTypes';
import type {
    AutomationDefinition,
    AutomationDefinitionRun,
    AutomationRunNowAdmission,
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
    runAutomationDefinitionNow,
    updateAutomationSettings,
    type AutomationRequestContext,
} from './api/automations/apiAutomations';
import { kvBulkGet } from './api/account/apiKv';
import { FeedItem } from './domains/social/feedTypes';
import { UserProfile } from './domains/social/friendTypes';
import {
    buildLocalOutboundPendingUserMessage,
    buildOutgoingUserTextRecord,
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
import { createTaskLimiter, runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
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
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { readStoredSessionRawRecord } from '@/sync/runtime/readStoredSessionContent';
import {
    persistSessionTranscriptMessage as persistSessionTranscriptMessageAtOwner,
    type PersistSessionTranscriptMessageInput,
} from '@happier-dev/session-core/messages';
import { isVoiceTranscriptHistorySession } from '@/voice/persistence/voiceTranscriptHistorySession';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { emitSessionMetadataUpdateWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/emitSessionMetadataUpdateWithServerScope';
import { fetchSessionByIdWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope';
import {
    captureServerRequestAuthorityForServerAccountScope,
    type ServerAccountRequestAuthority,
    createServerRequestForResolvedServerScope,
    createServerRequestForServerAccountScope,
    createServerRequestWithServerScope,
    runWithServerRequestAuthorityForServerAccountScope,
} from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { resolveServerAccountRequestContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext';
import { readSessionSnapshotForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { sessionRpcWithPreferredSessionScope } from '@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope';
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
    fetchArtifactWithBodyFromApi,
    fetchArtifactBinaryFromApi,
    fetchArtifactHtmlPreviewFromApi,
    fetchArtifactForViewFromApi,
    handleDeleteArtifactSocketUpdate,
    handleNewArtifactSocketUpdate,
    handleUpdateArtifactSocketUpdate,
    updateArtifactViaApi,
    updateArtifactWithHeaderViaApi,
    type ArtifactDataKeyCache,
    type ArtifactViewRead,
} from './engine/artifacts/syncArtifacts';
import { runWithServerAccountScopeRequestGuard } from './runtime/orchestration/serverScopedRpc/serverAccountScopeRequestGuard';
import { fetchAndApplyFeed, handleNewFeedPostUpdate, handleRelationshipUpdatedSocketUpdate, handleTodoKvBatchUpdate } from './engine/social/syncFeed';
import { fetchAndApplyFriends } from './engine/social/syncFriends';
import {
    fetchAndApplyProfile,
    handleUpdateAccountSocketUpdate,
    schedulePushTokenReconciliation,
} from './engine/account/syncAccount';
import { buildMachineFromMachineActivityEphemeralUpdate, buildUpdatedMachineFromSocketUpdate, fetchAndApplyMachines, type MachineDataKeyCacheEntry } from './engine/machines/syncMachines';
import { fetchAndApplyAutomationRuns, fetchAndApplyAutomations } from './engine/automations/syncAutomations';
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
import { applyTodoSocketUpdates as applyTodoSocketUpdatesEngine, fetchTodos as fetchTodosEngine } from './engine/todos/syncTodos';
import { fetchAndApplyAccountPets } from './domains/pets/syncAccountPets';
import type { AccountPetMetadata } from './domains/pets/accountPetLibraryTypes';
import {
    planSyncActionsFromChanges,
    plannedChangesAffectSessionListQuery,
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
import { createSessionDraftCipher } from '@/sync/encryption/sessionDraftEncryption';
import { createAuthoringMemoryCipher } from '@/sync/encryption/authoringMemoryEncryption';
import { createApiAuthoringMemoryTransport } from '@/sync/api/account/apiAuthoringMemory';
import { createAuthoringMemorySync, importLegacyAuthoringMemory, type AuthoringMemoryDelta } from '@/sync/engine/authoringMemory/authoringMemorySync';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { loadAuthoringMemoryProjection, saveAuthoringMemoryProjection } from '@/sync/domains/state/authoringMemoryPersistence';
import {
    configureSessionDraftRepository,
    ensureSessionDraftRepositoryHydrated,
    materializeExactSessionDraft,
    materializeExactSessionDraftWithScopedRuntime,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { migrateLegacySessionDrafts } from '@/sync/domains/input/drafts/sessionDraftLegacyMigration';
import { removeRunnerCreatorCustodyForRemovedDraft } from '@/sync/domains/ephemeralRunner/runnerCreatorDraftRemoval';
import { publishMountedSessionDiscussionChanges } from '@/sync/domains/session/discussions/sessionDiscussionChangeWatch';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY } from '@happier-dev/protocol/sessions/messages/sessionMessageMeta';
import { decideExternalSessionTranscriptRefreshApplicationV1, ExternalSessionRefreshCursorV1Schema, externalSessionTranscriptRefreshBindingsEqualV1, shouldResyncExternalSessionTranscriptReadAfterV1, type ExternalSessionTranscriptInvalidationV1 } from '@happier-dev/protocol/sessions/external/secureRefreshV1';
import { ExternalSessionOperationSharedPresentationV1Schema } from '@happier-dev/protocol/sessions/external/operationV1';
import { readPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { hasRawComposerAttachmentSelectionV1, type HappierStructuredInputV1, type RawIngressStructuredInputV1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { SessionUserMessageSendResponseSchema } from '@happier-dev/protocol/sessions/userMessageRpc';
import type { ComposerContentHandleV1 } from '@happier-dev/protocol/runtime/input/composerContentV1';
import type { PendingDeliveryBlockedReason } from '@happier-dev/protocol/sessions/messages/pendingDeliveryBlockedReason';
import type { PendingRequestedActionV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import type { ParticipantRecipientV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';
import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import type { ExternalSessionsRpcErrorCode } from '@happier-dev/protocol/sessions/external/rpcErrorCodes';
import type { SessionMetadataInactiveModelIntentExpectationV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { AutomationV3ClearRunHistoryResponse, AutomationV3Settings } from '@happier-dev/protocol/automations/automationApiV3';
import type { AccountSettingMutationV1 } from '@happier-dev/protocol/account/settings/accountSettingMutationV1';
import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import { createServerFetchAtEndpoint, StaleServerGenerationError, type ServerFetch } from './http/client';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';
import { clearEmbedMemoryStorage } from '@/sync/domains/state/persistenceStorage';
import { clearEmbedBrowserRecords } from '@/sync/domains/state/browserRecordStorage';
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
import { readSessionOwnerMetadataView } from './domains/session/readSessionOwnerMetadataView';
import { fetchAndApplySessionById } from './engine/sessions/sessionById';
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
    observeAuthenticatedServerFeaturesFresh,
    primeServerFeaturesSnapshot,
    type ServerFeaturesSnapshot,
} from './api/capabilities/serverFeaturesClient';
import {
    dropSocketSessionWork,
    flushActivityUpdates as flushActivityUpdatesEngine,
    flushMachineActivityUpdates as flushMachineActivityUpdatesEngine,
    handleEphemeralSocketUpdate,
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
    emitWithAck: <T = unknown>(event: string, payload: unknown, opts?: { timeoutMs?: number }) => Promise<T>;
    send: (event: string, payload: unknown) => unknown;
}>;

function createDefaultMessageTransport(): SyncMessageTransport {
    return {
        emitWithAck: <T>(event: string, payload: unknown, opts?: { timeoutMs?: number }) =>
            apiSocket.emitWithAck<T>(event, payload, opts),
        send: (event: string, payload: unknown) => apiSocket.send(event, payload),
    };
}

function shouldRetrySyncInvalidation(error: unknown): boolean {
    if (isDemoModeActive()) return false;
    return shouldRetryError(error);
}

function createAvailableSessionRouteResult(
    sessionId: string,
    serverId?: string,
): EnsureSessionVisibleForRouteResult {
    return {
        kind: 'available',
        sessionId,
        ...(serverId ? { serverId } : {}),
    };
}

function createMissingSessionRouteResult(
    sessionId: string,
    serverId: string | undefined,
    cause: SessionRouteHydrationMissingCause,
): EnsureSessionVisibleForRouteResult {
    return {
        kind: 'missing',
        sessionId,
        ...(serverId ? { serverId } : {}),
        cause,
    };
}

function createRetryableSessionRouteResult(
    sessionId: string,
    serverId: string | undefined,
    cause: SessionRouteHydrationRetryCause,
): EnsureSessionVisibleForRouteResult {
    return {
        kind: 'retryable_failure',
        sessionId,
        ...(serverId ? { serverId } : {}),
        cause,
    };
}

function readTerminalSessionRouteMissingCause(errorCode: string): SessionRouteHydrationMissingCause | null {
    if (errorCode === 'not_found' || errorCode === 'unauthorized' || errorCode === 'forbidden') {
        return errorCode;
    }
    return null;
}

function readRetryableSessionRouteCause(errorCode: string): SessionRouteHydrationRetryCause {
    if (errorCode === 'server_unavailable' || errorCode === 'network_error') {
        return 'server_unavailable';
    }
    if (errorCode === 'session_encryption_not_found') {
        return 'decrypting';
    }
    return 'unknown';
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
    const parsed = RawRecordSchema.safeParse(rawRecord);
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
    }, normalizedServerId).pinnedSessionIds];
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

class Sync {

        encryption: Encryption | null = null;
        serverID!: string;
        anonID!: string;
        private credentials!: AuthCredentials;
        private appliedServerTarget: SyncServerTarget | null = null;
        private embedSessionScope: (SyncEmbedSessionOptions & Readonly<{
            request: ServerFetch;
            controller: AbortController;
        }>) | null = null;
        private embedFeaturesSnapshot: ServerFeaturesSnapshot = { status: 'unsupported', reason: 'endpoint_missing' };
        private readonly requestViaConfiguredSocket: ServerFetch = async (path, init, options) => {
            const scope = this.embedSessionScope;
            if (!scope && isEmbedWindowContext()) throw new StaleServerGenerationError();
            return await (scope?.request ?? apiSocket.request.bind(apiSocket))(path, init, options);
        };
        private pauseController = new PauseController();
        private userRequestLeaseOwner = createUserRequestLeaseOwner();
        private activeEndpointSupervisor: ManagedEndpointSupervisor | null = null;
      private syncTuning: SyncTuning = loadSyncTuning();
      private readonly snapshotSyncAttemptLimiter = createTaskLimiter(this.syncTuning.bootstrapConcurrencyLimit);
      private resumeInFlight: Promise<void> | null = null;
      private changesCatchUpQueuedAfterResume = false;
      private pendingOutboxRearmInFlightByScope = new Map<string, Promise<void>>();
      private readonly usesPersistentDesktopSync = isDesktopHost();
      private isForeground = this.usesPersistentDesktopSync || AppState.currentState === 'active';
      public encryptionCache = new EncryptionCache();
      private sessionDraftSyncEnabled = false;
      private sessionDraftOfflineCatchUpPending = false;
      private sessionDraftRepositoryConfiguredScope: ServerAccountScope | null = null;
      private authoringMemoryRuntime: Promise<ReturnType<typeof createAuthoringMemorySync>> | null = null;
      private readonly sessionDraftRuntimeHydrationGate = new SessionDraftRuntimeHydrationGate();
      private readonly sessionSystemRecordRepositories = new Map<string, SessionSystemRecordRepository>();
    private sessionsSync: InvalidateSync;
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
      private sessionByIdHydrationInFlight = new Map<string, Readonly<{
          sessionId: string;
          promise: Promise<EnsureSessionVisibleForRouteResult>;
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
      private artifactDataKeys: ArtifactDataKeyCache = new Map(); // Unwrapped artifact data keys + the envelope each came from, so an unchanged envelope is never re-opened
    private settingsSync: InvalidateSync;
    private profileSync: InvalidateSync;
    private purchasesSync: InvalidateSync;
    private machinesSync: InvalidateSync;
    private nativeUpdateSync: InvalidateSync;
    private artifactsSync: InvalidateSync;
    private friendsSync: InvalidateSync;
    private friendRequestsSync: InvalidateSync;
    private feedSync: InvalidateSync;
    private pendingMessageCommitRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private pendingOutboxOperationRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private todosSync: InvalidateSync;
    private automationsSync: InvalidateSync;
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
    private machineActivityAccumulator: MachineActivityAccumulator;
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
        const onError = (e: any) => {
            const message = e instanceof Error ? e.message : String(e);
            const retryable = shouldRetryError(e);
            const kind: 'auth' | 'config' | 'network' | 'server' | 'unknown' =
                e instanceof HappyError && e.kind ? e.kind : 'unknown';
            storage.getState().setSyncError({ message, retryable, kind, at: Date.now() });
        };
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
            const limitSnapshotAttempt = (command: () => Promise<void>) => (
                () => this.snapshotSyncAttemptLimiter.run(command)
            );

            this.sessionsSync = new InvalidateSync(limitSnapshotAttempt(async () => {
                await this.fetchSessions();
            }), { onError, onSuccess, onRetry, pause, backoff, shouldRetry });
            this.settingsSync = new InvalidateSync(limitSnapshotAttempt(this.syncSettings), {
                onError: onSettingsError,
                onSuccess: onSettingsSuccess,
                onRetryFailure: onSettingsRetryFailure,
                onRetry,
                pause,
                backoff,
                shouldRetry,
            });
            this.profileSync = new InvalidateSync(limitSnapshotAttempt(this.fetchProfile), { onError, onSuccess, onRetry, pause, backoff, shouldRetry });
            this.purchasesSync = new InvalidateSync(limitSnapshotAttempt(this.syncPurchases), { onError, onSuccess, onRetry, pause, backoff, shouldRetry });
            this.machinesSync = new InvalidateSync(limitSnapshotAttempt(this.fetchMachines), { onError, onSuccess, onRetry, pause, backoff, shouldRetry });
            this.nativeUpdateSync = new InvalidateSync(limitSnapshotAttempt(this.fetchNativeUpdate), { pause, backoff, shouldRetry });
            this.artifactsSync = new InvalidateSync(limitSnapshotAttempt(this.fetchArtifactsList), { pause, backoff, shouldRetry });
            this.friendsSync = new InvalidateSync(limitSnapshotAttempt(this.fetchFriends), { pause, backoff, shouldRetry });
            this.friendRequestsSync = new InvalidateSync(limitSnapshotAttempt(this.fetchFriendRequests), { pause, backoff, shouldRetry });
            this.feedSync = new InvalidateSync(limitSnapshotAttempt(this.fetchFeed), { pause, backoff, shouldRetry });
            this.todosSync = new InvalidateSync(limitSnapshotAttempt(this.fetchTodos), { pause, backoff, shouldRetry });
            this.automationsSync = new InvalidateSync(limitSnapshotAttempt(this.fetchAutomations), { pause, backoff, shouldRetry });
            this.accountPetsSync = new InvalidateSync(limitSnapshotAttempt(this.fetchAccountPets), { pause, backoff, shouldRetry });
            this.pluginAvailabilitySync = new InvalidateSync(limitSnapshotAttempt(async () => {
                const projection = await this.pluginAvailabilityProjectionHydrator.refresh();
                if (!projection) return;
                applyPluginAccountAvailabilityProjectionRefresh(projection);
            }), { onError, onSuccess, onRetry, pause, backoff, shouldRetry });

            this.activityAccumulator = new ActivityUpdateAccumulator(
                this.flushActivityUpdates.bind(this),
                this.syncTuning.activityUpdateDebounceMs,
            );
            this.machineActivityAccumulator = new MachineActivityAccumulator(this.flushMachineActivityUpdates.bind(this), 300);

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
                  this.markNativeCryptoWorkerBackgroundQuiescent();
                  log.log(`📱 App state changed to: ${nextAppState}`);
                  this.pauseController.pause();
                  const teardownConnectivity = () => {
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
                      this.markNativeCryptoWorkerBackgroundQuiescent();
                      this.pauseController.pause();
                      this.flushBackgroundSyncCheckpointsNow();
                      const teardownConnectivity = () => {
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

      private disconnectSocketIntentionally(): void {
          this.postSubscriptionChangesCatchUpPending = false;
          this.socketStatus = 'disconnected';
          apiSocket.disconnect();
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

      private getSessionMessagesPageOptions(sessionId: string, authority?: ServerAccountRequestAuthority) {
          const embedScope = this.embedSessionScope;
          const encryption = this.encryption;
          const generation = this.serverScopeGeneration;
          const lifetime = embedScope ? null : captureActiveServerAccountScopeCurrentness();
          const serverId = embedScope?.endpointUrl ?? authority?.scope.serverId ?? resolvePreferredServerIdForSessionId(sessionId);
          const readTranscriptAuthorityKey = () => {
              const session = storage.getState().sessions[sessionId] ?? null;
              return session ? externalSessionTranscriptAuthorityKey(
                  this.resolveTranscriptAuthority(session, readExternalSessionLinkFromSession(session)),
              ) : null;
          };
          const transcriptAuthorityKey = readTranscriptAuthorityKey();
          const isCurrent = (): boolean => generation === this.serverScopeGeneration
              && encryption === this.encryption
              && (embedScope ? this.embedSessionScope === embedScope && embedScope.isCurrent() && sessionId === embedScope.scope.sessionId : lifetime?.isCurrent() === true)
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
                  if (serverId !== resolvePreferredServerIdForSessionId(sessionId)) return;
                  const currentEncryption = authority
                      ? this.getSessionMessagesEncryptionForAuthority(authority, sessionId)
                      : encryption?.getSessionEncryption(sessionId);
                  if (currentEncryption !== failedEncryption || session.encryptedContentAvailability === 'encrypted_content_unavailable') return;
                  this.applySessions([{ ...session, encryptedContentAvailability: 'encrypted_content_unavailable' }]);
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
            const renewalCursor = sameSessionScope && storage.getState().isDataReady ? this.changesCursor : null;
            this.disposeEmbedSession({ preserveSessionState: sameSessionScope });
            if (Object.keys(storage.getState().sessions).some((sessionId) => sessionId !== options.scope.sessionId)) {
                storage.setState({ sessions: {}, sessionMessages: {}, sessionPending: {}, isDataReady: false });
                this.sessionViewport.clear();
            }
            const controller = new AbortController();
            const endpointRequest = createServerFetchAtEndpoint({
                endpointUrl: options.endpointUrl, credentials, signal: controller.signal,
                isCurrent: () => this.embedSessionScope?.controller === controller && options.isCurrent(),
            });
            const sessionPath = encodeURIComponent(options.scope.sessionId);
            const request: ServerFetch = async (path, init, requestOptions) => {
                const url = new URL(path, options.endpointUrl);
                const method = (init?.method ?? 'GET').toUpperCase();
                const read = method === 'GET';
                const permitted = url.origin === new URL(options.endpointUrl).origin && (
                    read && (url.pathname === '/v1/features/authenticated' || url.pathname === '/v2/cursor'
                        || url.pathname === `/v2/sessions/${sessionPath}`
                        || url.pathname === `/v1/sessions/${sessionPath}/messages`
                        || url.pathname.startsWith(`/v2/sessions/${sessionPath}/messages/by-local-id/`)
                        || url.pathname === `/v1/sessions/${sessionPath}/turns`
                        || url.pathname === '/v2/changes' && url.searchParams.get('sessionId') === options.scope.sessionId)
                    || (url.pathname === `/v2/sessions/${sessionPath}/pending` || url.pathname.startsWith(`/v2/sessions/${sessionPath}/pending/`))
                    || method === 'POST' && /^\/v1\/actions\/[^/]+$/.test(url.pathname)
                );
                if (!permitted) throw new Error('Request is outside the embed Session corridor');
                const response = await endpointRequest(path, init, requestOptions);
                if (response.status === 401 && this.embedSessionScope?.controller === controller && options.isCurrent()) options.onCredentialRejected?.();
                return response;
            };
            const scope = {
                ...options,
                controller,
                request,
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
        scope.controller.abort('embed-session-retired');
        this.serverScopeGeneration += 1;
        this.disconnectSocketIntentionally();
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
            storage.setState({ sessions: {}, sessionMessages: {}, sessionPending: {}, isDataReady: false });
        }
    }

    public getSessionAttachmentTransferContext(sessionId: string, options?: Readonly<{ purpose: 'attachmentPreview' }>): SessionAttachmentTransferContext | undefined {
        const scope = this.embedSessionScope;
        if (!scope) {
            if (isEmbedWindowContext()) return undefined;
            if (options?.purpose !== 'attachmentPreview' || !this.credentials?.token || !storage.getState().sessions[sessionId]) return undefined;
            const current = this.createServerScopeGuard();
            const lifetime = captureActiveServerAccountScopeCurrentness();
            const encryption = this.encryption;
            const isCurrent = () => current() && lifetime.isCurrent() && this.encryption === encryption;
            return { kind: 'sessionBound', sessionId, call: async <T>(method: string, request: unknown, signal?: AbortSignal | null): Promise<T> => {
                if (!isCurrent()) throw new StaleServerGenerationError();
                const response = await sessionRpcWithPreferredSessionScope<T, unknown>({ sessionId, method, payload: request,
                    signal: signal ?? undefined, transferRouting: createSessionAttachmentTransferRouting(sessionId, method) });
                if (!isCurrent()) throw new StaleServerGenerationError();
                return response;
            } };
        }
        if (scope.scope.sessionId !== sessionId || !scope.isCurrent()) return undefined;
        return {
            kind: 'sessionBound', sessionId,
            call: async <T>(method: string, request: unknown, signal?: AbortSignal | null): Promise<T> => {
                if (this.embedSessionScope !== scope || !scope.isCurrent()) throw new StaleServerGenerationError();
                const response = await apiSocket.sessionRPC<T, unknown>(sessionId, method, request, { signal: signal ?? undefined,
                    transferRouting: createSessionAttachmentTransferRouting(sessionId, method) });
                if (this.embedSessionScope !== scope || !scope.isCurrent()) throw new StaleServerGenerationError();
                return response;
            },
        };
    }

    public getEmbedSessionRequestContext() {
        const scope = this.embedSessionScope;
        if (!scope || !scope.isCurrent()) return null;
        const revision = this.serverScopeGeneration;
        const isCurrent = () => this.embedSessionScope === scope && scope.isCurrent();
        return { serverId: scope.endpointUrl, accountId: scope.accountId, sessionId: scope.scope.sessionId,
            credentials: this.credentials, request: scope.request,
            revision, isCurrent,
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
        const sessionId = scope.scope.sessionId;
        const hydration = await this.ensureSessionVisibleForMessageRoute(sessionId, {
            forceRefresh: true, includeTurnsProjection: options?.detailOnly !== true, hydrateMessages: false,
        });
        if (this.embedSessionScope !== scope || !scope.isCurrent()) return;
        if (hydration.kind !== 'available') throw new Error(hydration.errorCode ?? 'Embed Session is unavailable');
        const session = storage.getState().sessions[sessionId];
        if (options?.detailOnly !== true && session && isSessionContentReadable(readSessionContentAvailability(session))) {
            await this.getOrCreateMessagesSync(sessionId).invalidateAndAwait();
            if (this.embedSessionScope !== scope || !scope.isCurrent()) return;
            await this.fetchPendingMessages(sessionId);
        }
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
            if (!areAccountSettingsScopesEqual(this.pendingSettingsScope, settingsScope)) this.authoringMemoryRuntime = null;
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

        const currentState = storage.getState();
        const shouldHydrateMachineDisplays = options?.preserveFetchedState !== true
            || Object.keys(currentState.machineDisplayById).length === 0;
        if (shouldHydrateMachineDisplays) {
            const machineEntries = loadMachineDisplayWarmCacheEntries(serverId, accountId);
            if (Object.keys(machineEntries).length > 0) {
                storage.getState().replaceMachineDisplays(
                    Object.values(machineEntries).map((entry) => buildMachineDisplayRenderableFromCacheEntry(entry)),
                );
            }
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
            // Reuse the canonical exact-Session hydration and its in-flight
            // coalescer. Several record observers must not each perform another
            // full Session read merely to obtain mode/access/key context.
            const hydrated = await this.ensureSessionVisibleForMessageRoute(sessionAddress.sessionId, {
                serverId: sessionAddress.serverId,
                forceRefresh: options?.forceSessionRefresh === true,
                hydrateMessages: false,
                authority,
                scopeCurrentness: isCurrent,
            });
            if (!isCurrent()) return { status: 'forbidden' };
            if (hydrated.kind === 'missing') return hydrated.cause === 'not_found' ? { status: 'not_found' } : { status: 'forbidden' };
            if (hydrated.kind !== 'available') return hydrated.cause === 'server_unavailable' || hydrated.cause === 'network'
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
                    encryption: authority.context.encryption?.getSessionEncryption(sessionAddress.sessionId) ?? null,
                };
            };
            const contentContext = readContentContext();
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
        configureSessionDraftRepository({
            scope,
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
                getSessionContext: (sessionId) => {
                    const session = storage.getState().sessions[sessionId] ?? null;
                    if (!session) return null;
                    if (session.encryptionMode === 'plain') return { mode: 'plain' };
                    return {
                        mode: 'e2ee',
                        encryption: this.encryption?.getSessionEncryption(sessionId) ?? null,
                    };
                },
                randomBytes: getRandomBytes,
            }),
            syncEnabled: this.sessionDraftSyncEnabled,
            onDraftRemoved: ({ scope: removedScope, document }) => (
                removeRunnerCreatorCustodyForRemovedDraft({ scope: removedScope, document })
            ),
        });
    }

    private ensureSessionDraftRepositoryRuntimeReady(params: Readonly<{
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
        return this.sessionDraftRuntimeHydrationGate.run({
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
                await ensureSessionDraftRepositoryHydrated(capturedScope);
                if (!shouldContinue()) return false;
                if (params.forceSnapshotHydration === true) this.sessionDraftOfflineCatchUpPending = false;
                return true;
            },
        });
    }

    private async refreshSessionDraftRepositoryForSync(params: Readonly<{
        forceSnapshotHydration?: boolean;
    }> = {}): Promise<void> {
        try {
            await this.ensureSessionDraftRepositoryRuntimeReady(params);
        } catch {
            // Drafts are locally durable and the hydration gate retries after a failed run.
            // A draft-only outage must not suppress already-loaded account projections.
            log.log('[session-drafts] Snapshot hydration unavailable; retaining local drafts and retrying on the next sync');
        }
    }

    private resetServerScopedRuntimeState = (targetToReset?: SyncServerTarget | null) => {
        this.authoringMemoryRuntime = null;
        storage.getState().resetAuthoringMemory();
        apiSocket.invalidateRequests('server-switch');
        this.automationRunTraversalTokensByAutomationId.clear();
        this.changesCatchUpQueuedAfterResume = false;
        this.postSubscriptionChangesCatchUpPending = false;
        this.sessionDraftSyncEnabled = false;
        this.sessionDraftOfflineCatchUpPending = false;
        this.sessionDraftRepositoryConfiguredScope = null;
        this.sessionDraftRuntimeHydrationGate.reset();
        configureSessionDraftRepository({ syncEnabled: false });
        // The UI-sync generation fence is the sole shared Account retirement
        // boundary. Consumers receive synchronous owner-local cancellation
        // before this reset continues, while no consumer cleanup is awaited.
        this.pluginAvailabilityProjectionHydrator.reset();
        clearPluginAccountAvailabilityProjection();
        retireActiveServerAccountScopeLifetime();
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
        this.machineActivityAccumulator.reset();

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
        this.clearSessionListScrollActivity();
        this.sessionDataKeys.clear();
        this.sessionDataKeyEnvelopes.clear();
        this.machineDataKeys.clear();
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

        const activeServerIdForReset = String(
            targetToReset?.serverId ?? this.getAppliedTransportTarget()?.serverId ?? '',
        ).trim();
        const withoutActiveServerEntry = <T>(entries: Readonly<Record<string, T>>): Readonly<Record<string, T>> => {
            if (!activeServerIdForReset || !(activeServerIdForReset in entries)) return entries;
            const next = { ...entries };
            delete next[activeServerIdForReset];
            return next;
        };

        storage.setState((state) => ({
            ...state,
            profile: { ...profileDefaults },
            sessions: {},
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
            machineListByServerId: (() => {
                if (!activeServerIdForReset) return state.machineListByServerId;
                if (!(activeServerIdForReset in state.machineListByServerId)) return state.machineListByServerId;
                const next = { ...state.machineListByServerId };
                delete next[activeServerIdForReset];
                return next;
            })(),
            machineListStatusByServerId: (() => {
                if (!activeServerIdForReset) return state.machineListStatusByServerId;
                if (!(activeServerIdForReset in state.machineListStatusByServerId)) return state.machineListStatusByServerId;
                const next = { ...state.machineListStatusByServerId };
                delete next[activeServerIdForReset];
                return next;
            })(),
            sessionScmStatus: {},
            machines: {},
            machineDisplayById: {},
            sessionMessages: {},
            sessionMessagesHistoryStartLoaded: {},
            sessionPending: {},
            artifacts: {},
            artifactsLoaded: false,
            automations: {},
            workflowTriggerSetsById: {},
            workflowTriggerSetIdsByQuery: {},
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
            socketStatus: 'disconnected',
            socketLastError: null,
            socketLastErrorAt: null,
            syncError: null,
            accountSettingsSyncStatus: createAccountSettingsIdleStatus(),
            lastSyncAt: null,
        }));
    };

    public async switchServer(credentials: AuthCredentials, target?: SyncServerTarget): Promise<void> {
        const encryption = isTokenOnlyAuthCredentials(credentials)
            ? null
            : await createEncryptionFromAuthCredentials(credentials);

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

        // Initial bootstrap sync is orchestrated to avoid request storms.
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
            if (hasStaleTranscriptMarkers(this.deferredTranscriptState, sessionId)) {
                // C6/D2a: a row was edited while hidden. Refetch only the stale region and merge
                // it in place (applyMessages upserts) instead of wiping the whole transcript —
                // the previous full reset discarded all paginated older history to repair an edit.
                const staleMinSeq = readStaleTranscriptMinSeq(this.deferredTranscriptState, sessionId);
                const authoritativeUpdateMessageIds = new Set(
                    readStaleTranscriptMessageIds(this.deferredTranscriptState, sessionId),
                );
                fireAndForget(this.repairDeferredStaleTranscriptRegion(
                    sessionId,
                    staleMinSeq,
                    authoritativeUpdateMessageIds,
                    readStaleTranscriptMessageSeqs(this.deferredTranscriptState, sessionId),
                ), {
                    tag: 'Sync.onSessionVisible.staleRefetch',
                });
            }
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
                    await migrateLegacySessionDrafts(scope);
                    if (!accountLifetime.isCurrent()) return;
                    await ensureSessionDraftRepositoryHydrated(scope);
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
                serverId?: string;
                includeTurnsProjection?: boolean;
                hydrateMessages?: boolean;
                /** Keep a wake reconciliation open until its queued messages have applied. */
                awaitMessageHydration?: boolean;
                authority?: ServerAccountRequestAuthority;
                /** Exact captured Account-scope currentness for a qualified caller. */
                scopeCurrentness?: () => boolean;
            }>,
        ): Promise<EnsureSessionVisibleForRouteResult> => {
            const normalized = String(sessionId ?? '').trim();
            if (!normalized) return createMissingSessionRouteResult('', undefined, 'not_found');
            const embedScope = this.embedSessionScope;
            if (embedScope && (normalized !== embedScope.scope.sessionId || !embedScope.isCurrent())) return createMissingSessionRouteResult(normalized, undefined, 'not_found');
            const forceRefresh = options?.forceRefresh === true;

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
            const activeServerId = String(this.getAppliedTransportTarget()?.serverId ?? '').trim();
            const preferredServerId = embedScope ? embedScope.endpointUrl : resolveMessageRouteHydrationServerId(
                normalized,
                options?.serverId,
                activeServerId || undefined,
            );
            if (preferredServerId && !isKnownServerId(preferredServerId, activeServerId || undefined)) {
                return createMissingSessionRouteResult(normalized, preferredServerId, 'not_found');
            }
            const prefersActiveServer = !preferredServerId || areServerProfileIdentifiersEquivalent(preferredServerId, activeServerId);

            // Fast-path when we already know the session exists on this server and the stored record is
            // already authoritatively hydrated (deep links can occur before the sessions snapshot bootstraps).
            const existingSession = storage.getState().sessions[normalized];
            const existingServerId = String(existingSession?.serverId ?? '').trim();
            const existingMatchesTarget = Boolean(existingSession) && (
                !preferredServerId
                || areServerProfileIdentifiersEquivalent(existingServerId, preferredServerId)
            );
            const isKnownOnRequestedServer = prefersActiveServer
                ? this.isSessionKnownOnActiveServer(normalized)
                : Boolean(preferredServerId && storage.getState().sessionListRowsByServerId[preferredServerId]?.[normalized]);
            if (!forceRefresh && existingMatchesTarget && isKnownOnRequestedServer && existingSession) {
                const encryptionMode: 'e2ee' | 'plain' = existingSession.encryptionMode === 'plain' ? 'plain' : 'e2ee';
                const scopedEncryption = options?.authority?.context.encryption ?? this.encryption;
                const hasEncryption = encryptionMode === 'plain'
                    ? false
                    : Boolean(scopedEncryption?.getSessionEncryption(normalized));
                const hasAuthoritativeSessionRouteState = hasAuthoritativeSessionRouteData(existingSession, { hasSessionEncryption: hasEncryption });
                if (DEBUG_SESSION_HYDRATE) {
                    log.log(`[sessionHydrate] fast-path check ${normalized} mode=${encryptionMode} hasEncryption=${hasEncryption} hasRouteState=${hasAuthoritativeSessionRouteState}`);
                }
                if (hasAuthoritativeSessionRouteState) {
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
            const inFlightKey = `${buildSessionByIdHydrationInFlightKey(normalized, preferredServerId)}:${authorityScopeKey}`;
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
            if (existing) {
                if (DEBUG_SESSION_HYDRATE) {
                    log.log(`[sessionHydrate] awaiting in-flight hydration for ${normalized}`);
                }
                const result = await existing.promise;
                return options?.awaitMessageHydration === true ? finishMessageHydration(result) : result;
            }

            let hydrationCurrent = true;
            const hydrationEncryption = this.encryption;
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
                            accountMode: embedScope.accountMode } : {}),
                        activeEncryption: this.encryption,
                        sessionDataKeys: this.sessionDataKeys,
                        sessionDataKeyEnvelopes: this.sessionDataKeyEnvelopes,
                        activeRequest: this.requestViaConfiguredSocket,
                        getExistingSession: (sessionId) => storage.getState().sessions[sessionId] ?? null,
                        applySessions: (sessions) => this.applySessions(sessions),
                        log,
                        includeTurnsProjection: options?.includeTurnsProjection === true,
                        authority: options?.authority,
                        isCurrent: isHydrationCurrent,
                    });
                    if (!result.ok) {
                        const code = typeof result.errorCode === 'string' ? result.errorCode : '';
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
                        return createRetryableSessionRouteResult(
                            normalized,
                            preferredServerId,
                            'unknown',
                        );
                    }
                    const hydratedServerId = String(result.session?.serverId ?? '').trim();
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
                promise: inFlight,
                invalidate: () => {
                    hydrationCurrent = false;
                },
            });
            this.sessionByIdHydrationInFlight.set(inFlightKey, inFlightEntry);
            inFlight.finally(() => {
                if (this.sessionByIdHydrationInFlight.get(inFlightKey) === inFlightEntry) {
                    this.sessionByIdHydrationInFlight.delete(inFlightKey);
                }
            });

            const result = await inFlight;
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

    /**
     * Row-level changes to listed Sessions: refresh exactly those rows through the
     * canonical exact-Session hydration (and its in-flight coalescer) instead of
     * re-reading the list. A row that cannot be read (deleted, access lost, or a
     * transient failure) may have left the list, so it escalates to one list refresh
     * that owns retirement; that refresh throws when the Home is unreachable, which
     * holds the change cursor for a later catch-up.
     */
    private refreshListedSessionRows = async (serverId: string, sessionIds: readonly string[]): Promise<void> => {
        const unreadable: string[] = [];
        await runTasksWithLimit(
            sessionIds.map((sessionId) => async () => {
                const result = await this.ensureSessionVisibleForMessageRoute(sessionId, {
                    forceRefresh: true,
                    hydrateMessages: false,
                    ...(serverId ? { serverId } : {}),
                });
                if (result.kind !== 'available') unreadable.push(sessionId);
            }),
            this.syncTuning.sessionListHydrationConcurrencyLimit,
        );
        if (unreadable.length === 0) return;
        await this.fetchSessions({
            awaitSessionListHydration: true,
            requiredHydrationSessionIds: unreadable,
            prioritizeSessionIds: unreadable,
        });
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
            const publishNextPromptPermissionModeIfNeeded = async (): Promise<void> => {
                if (embedScope) return;
                const settingsApplyTiming = storage.getState().settings.sessionPermissionModeApplyTiming ?? 'immediate';
                if (settingsApplyTiming !== 'next_prompt') {
                    return;
                }

                const latestSession = exactAccountLifetime
                    ? session
                    : storage.getState().sessions[sessionId] ?? null;
                const localUpdatedAt = latestSession?.permissionModeUpdatedAt ?? null;
                const metadataUpdatedAtRaw = latestSession
                    ? readSessionOwnerMetadataView(latestSession)?.permissionModeUpdatedAt ?? null
                    : null;
                const metadataUpdatedAt =
                    typeof metadataUpdatedAtRaw === 'number' && Number.isFinite(metadataUpdatedAtRaw)
                        ? metadataUpdatedAtRaw
                        : 0;

                if (!(typeof localUpdatedAt === 'number' && Number.isFinite(localUpdatedAt) && localUpdatedAt > metadataUpdatedAt)) {
                    return;
                }

                const modeToPublish = (latestSession?.permissionMode ?? 'default') as PermissionMode;
                try {
                    await this.publishSessionPermissionModeToMetadata({
                        sessionId,
                        permissionMode: modeToPublish,
                        permissionModeUpdatedAt: localUpdatedAt,
                        ...(exactAccountLifetime ? {
                            serverId: exactAccountLifetime.scope.serverId,
                            accountLifetime: exactAccountLifetime,
                        } : {}),
                    });
                } catch {
                    // Best-effort only: sending messages must not fail due to metadata publish failures.
                }
            };

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
            const removePendingMessageCreatedForSend = () => {
                if (!pendingMessageExistedBeforeSend) {
                    storage.getState().removePendingMessage(sessionId, localId);
                }
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
                        await publishNextPromptPermissionModeIfNeeded();
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
                            storage.getState().removePendingMessage(sessionId, localId);
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
                        timeoutMs: this.syncTuning.socketAckTimeoutMs,
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
                        storage.getState().removePendingMessage(sessionId, localId);
                        throw error;
                    }
                    if (this.keepPendingMessageForRetryableCommitFailure({ sessionId, localId, error })) {
                        return null;
                    }
                    storage.getState().removePendingMessage(sessionId, localId);
                    throw error;
                }
            })();

            if (!rawAck) {
                if (exactAccountLifetime) {
                    storage.getState().removePendingMessage(sessionId, localId);
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
                    storage.getState().removePendingMessage(sessionId, localId);
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
                storage.getState().removePendingMessage(sessionId, localId);
                throw new Error(ack.error || 'Message send rejected');
            }

            this.commitAckedOutboundUserMessage({
                sessionId,
                localId,
                createdAt,
                rawRecord: content,
                ack,
            });

            // For "next prompt" apply timing, the permission mode change is intentionally not published
            // immediately when the user toggles the picker. Instead, once the user actually sends a message,
            // we publish the newer local selection as the session-wide permission mode so it propagates
	            // across devices.
	            await publishNextPromptPermissionModeIfNeeded();

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
            if (
                e
                && typeof e === 'object'
                && (e as { code?: unknown }).code === 'action-conflict'
            ) {
                await this.fetchPendingMessages(sessionId, outboxScope, recipient).catch(() => {});
            }
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
            const parsed = RawRecordSchema.safeParse(pending.rawRecord);
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
                        timeoutMs: this.syncTuning.socketAckTimeoutMs,
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
        await sessionRpcWithPreferredSessionScope<void, { reason: string }>({
            sessionId,
            method: 'abort',
            payload: {
            reason: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`
            },
        });
    }

    async updatePendingRequestedAction(
        sessionId: string,
        localId: string,
        requestedAction: PendingRequestedActionV1,
        options?: Readonly<{
            resumeWhenAvailable?: boolean;
            serverId?: string | null;
            accountLifetime?: ServerAccountScopeLifetime;
        }>,
    ): Promise<void> {
        assertValidPendingMessageId(localId);
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, serverWireMode, isCurrent }) => {
            await updatePendingRequestedActionV2({
                sessionId,
                localId,
                requestedAction,
                ...(options?.resumeWhenAvailable !== undefined
                    ? { resumeWhenAvailable: options.resumeWhenAvailable, serverWireMode }
                    : {}),
                request,
                outboxScope,
                isOutboxScopeCurrent: isCurrent,
            });
            if (options?.resumeWhenAvailable !== undefined && !options.accountLifetime) {
                await this.refreshSessionForSubmit(sessionId, {
                    serverId: outboxScope.serverId,
                });
            }
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
            updatePendingRequestedAction: (targetSessionId, localId, requestedAction, options) => {
                assertScope(); return this.updatePendingRequestedAction(targetSessionId, localId, requestedAction, options);
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
            isMachineReachable: (machineId) => {
                if (embedScope) return false;
                const machine = storage.getState().machines[machineId];
                return Boolean(machine && isMachineOnline(machine));
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
    ): Promise<void> {
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
    }

    private async updateSessionMetadataWithRetry(
        sessionId: string,
        updater: SessionMetadataUpdateRequest<Metadata>,
        options?: Readonly<{
            serverId?: string | null;
            maxAttempts?: number;
            sessionExpectation?:
                SessionMetadataInactiveModelIntentExpectationV1;
            mutationIntent?: 'rename_session';
            accountLifetime?: Pick<ServerAccountScopeLifetime, 'scope' | 'isCurrent'>;
            authority?: ServerAccountRequestAuthority;
        }>,
    ): Promise<void> {
        const exactAccountLifetime = options?.accountLifetime;
        const exactAuthority = options?.authority;
        const assertCurrent = (): void => {
            if (
                exactAccountLifetime
                && (
                    !exactAccountLifetime.isCurrent()
                    || !exactAuthority
                    || !areServerAccountScopesEqual(exactAuthority.scope, exactAccountLifetime.scope)
                )
            ) {
                throw Object.assign(new Error('Session Account authority retired during metadata update'), {
                    code: 'session_account_scope_retired',
                });
            }
        };
        const isCurrent = (): boolean => {
            try {
                assertCurrent();
                return true;
            } catch {
                return false;
            }
        };
        assertCurrent();
        const resolvedServerIdOverride =
            typeof options?.serverId === 'string' && options.serverId.trim().length > 0
                ? options.serverId.trim()
                : null;
        let exactSession: Session | null = null;
        const exactSessionDataKeys = new Map<string, Uint8Array>();
        const exactSessionDataKeyEnvelopes = new Map<string, string>();

        const fetchLatestSession = async (
            includeMetadataTupleMutationSnapshot = false,
        ) => {
            assertCurrent();
            if (exactAuthority) {
                const credentials = exactAuthority.context.credentials;
                if (!credentials) throw new Error('Session metadata update requires exact Account credentials');
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
                            exactSession = {
                                ...session,
                                serverId: exactAuthority.scope.serverId,
                            };
                        }
                    },
                    getExistingSession: () => exactSession,
                    log,
                    includeTurnsProjection: false,
                    includeMetadataTupleMutationSnapshot,
                    isCurrent,
                });
                assertCurrent();
                return result;
            }
            if (!this.credentials) {
                throw new Error('Sync credentials not available');
            }
            return await fetchSessionByIdWithServerScope({
                sessionId,
                serverId: resolvedServerIdOverride ?? resolvePreferredServerIdForSessionId(sessionId),
                activeCredentials: this.credentials,
                activeEncryption: this.encryption,
                sessionDataKeys: this.sessionDataKeys,
                sessionDataKeyEnvelopes: this.sessionDataKeyEnvelopes,
                activeRequest: this.requestViaConfiguredSocket,
                applySessions: (sessions) => this.applySessions(sessions),
                getExistingSession: (targetSessionId) => storage.getState().sessions[targetSessionId] ?? null,
                log,
                includeTurnsProjection: false,
                includeMetadataTupleMutationSnapshot,
            });
        };

        const resolvePatchContext = () => {
            assertCurrent();
            const session = exactAuthority
                ? exactSession
                : storage.getState().sessions[sessionId] ?? null;
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
            return exactAuthority ? exactSession : storage.getState().sessions[sessionId] ?? null;
        };
        const ownsActiveProjection = (): boolean => Boolean(
            exactAccountLifetime
            && exactAuthority
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
                        ...(exactAuthority ? { authority: exactAuthority, isCurrent } : {}),
                    })
                    : await emitSessionMetadataUpdateWithServerScope({
                        sessionId,
                        patch: payload,
                        ...scope,
                        ...(exactAuthority ? { authority: exactAuthority, isCurrent } : {}),
                    });
                assertCurrent();
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
                if (exactAuthority) exactSession = nextSession;
                if (!exactAuthority || ownsActiveProjection()) this.applySessions([nextSession]);
            },
            acquireTupleSnapshot,
            tupleCrypto: {
                encryptPayload: async (payload) => {
                    assertCurrent();
                    if (!tupleWriterContextRef.current) {
                        throw new Error(
                            `Session metadata writer context not found for ${sessionId}`,
                        );
                    }
                    const encrypted = await tupleWriterContextRef.current
                        .encryptPayload(payload);
                    assertCurrent();
                    return encrypted;
                },
                encodeOwnerMetadata: (ownerMetadata) => {
                    assertCurrent();
                    if (!tupleWriterContextRef.current) {
                        throw new Error(
                            `Session metadata writer context not found for ${sessionId}`,
                        );
                    }
                    return tupleWriterContextRef.current
                        .encodeOwnerMetadata(ownerMetadata);
                },
            },
            getOwnerMigrationCurrentness: () =>
                tupleWriterContextRef.current
                    ?.ownerMigrationCurrentness,
            applyTupleSnapshot: (next) => {
                assertCurrent();
                const currentSession = readPatchSession();
                if (!currentSession) {
                    return;
                }
                const {
                    ownerMetadata: _obsoleteOwnerMetadata,
                    ...ordinarySession
                } = currentSession as Session & {
                    ownerMetadata?: unknown;
                };
                const nextSession = {
                    ...ordinarySession,
                    metadata:
                        next.value.sharedMetadata as unknown as Metadata,
                    metadataVersion: next.metadataVersion,
                    metadataLayoutVersion: 1,
                    ...(next.mode === 'owner'
                        ? {
                            ownerMetadataView: next.value.metadata,
                            composerOptionsInput: projectComposerOptionsInputV1(next.value.metadata),
                            agentState: next.value.agentState,
                            agentStateVersion: next.agentStateVersion,
                        }
                        : {}),
                } as Session;
                if (exactAuthority) exactSession = nextSession;
                if (!exactAuthority || ownsActiveProjection()) this.applySessions([nextSession]);
            },
            updater,
            sessionExpectation: options?.sessionExpectation,
            mutationIntent: options?.mutationIntent,
            maxAttempts: typeof options?.maxAttempts === 'number' ? options.maxAttempts : 8,
        });
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
        }]);
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
            state.applySessions([{ ...(session as Session), lastViewedSessionSeq: effectiveViewedSeq }]);
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
                        state.applySessions([next as Session]);
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
    }): Promise<void> {
        await publishPermissionModeToMetadataEngine({
            sessionId: params.sessionId,
            permissionMode: params.permissionMode,
            permissionModeUpdatedAt: params.permissionModeUpdatedAt,
            updateSessionMetadataWithRetry: (sessionId, updater) => this.patchSessionMetadataWithRetry(sessionId, updater, {
                ...(params.serverId ? { serverId: params.serverId } : {}),
                ...(params.accountLifetime ? { accountLifetime: params.accountLifetime } : {}),
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
    }): Promise<void> {
        await publishAcpConfigOptionOverrideToMetadataEngine({
            sessionId: params.sessionId,
            configId: params.configId,
            value: params.value,
            updatedAt: params.updatedAt,
            updateSessionMetadataWithRetry: (sessionId, updater) => this.updateSessionMetadataWithRetry(sessionId, updater),
        });
    }

    async fetchPendingMessages(
        sessionId: string,
        expectedOutboxScope?: ServerAccountScope,
        recipient?: PendingMessage['recipient'],
    ): Promise<void> {
        if (isDemoModeActive()) return;
        if (
            expectedOutboxScope
            && !areServerAccountScopesEqual(this.embedSessionScope ? this.getAppliedTransportAccountScope() : getActiveServerAccountScope(), expectedOutboxScope)
        ) {
            return;
        }
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent, serverWireMode }) => {
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
            encryption: this.encryption,
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
            accountLifetime?: ServerAccountScopeLifetime;
            resumeWhenAvailable?: true;
            /** The models this sender may run; the message runs on the first allowed one when needed. */
            allowedModels?: readonly ProviderBoundModelRef[] | null;
            allowedPermissionModes?: readonly PermissionMode[] | null;
        }>,
    ): Promise<Readonly<{
        localId: string;
        accepted: boolean;
        cancelled?: true;
        terminal?: true;
        externalHandoffClaimed?: true;
    }>> {
        return await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent, serverWireMode, encryption }) => {
        if (!await isCurrent()) throw new Error('Pending owner server-account scope changed');
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
            targetMachineId: targetRecipient ? readMachineControlTargetForSession({ sessionId, ...outboxScope })?.machineId : undefined,
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
            request,
            outboxScope,
            serverWireMode,
            accountLifetime: options?.accountLifetime,
            isCurrent,
            requestedAction: options?.requestedAction ?? { v: 1, kind: 'enqueue' },
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

    async discardPendingMessage(
        sessionId: string,
        pendingId: string,
        opts?: PendingQueueOwnerOptions & { reason?: 'switch_to_local' | 'manual' }
    ): Promise<void> {
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent }) => {
        await discardPendingMessageV2({
            sessionId,
            pendingId,
            reason: opts?.reason ?? 'manual',
            encryption: this.encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
        }, undefined, opts?.serverId);
    }

    async dismissPendingDelivery(sessionId: string, pendingId: string, options?: PendingQueueOwnerOptions): Promise<void> {
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent }) => {
        await dismissPendingDeliveryV2({
            sessionId,
            pendingId,
            encryption: this.encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
        }, undefined, options?.serverId);
    }

    async blockPendingDelivery(
        sessionId: string,
        pendingId: string,
        reason: PendingDeliveryBlockedReason,
        options?: PendingQueueOwnerOptions,
    ): Promise<void> {
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent }) => {
        await blockPendingDeliveryV2({
            sessionId,
            pendingId,
            reason,
            encryption: this.encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
        }, undefined, options?.serverId);
    }

    async restoreDiscardedPendingMessage(sessionId: string, pendingId: string, options?: PendingQueueOwnerOptions): Promise<void> {
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent }) => {
        await restoreDiscardedPendingMessageV2({
            sessionId,
            pendingId,
            encryption: this.encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
        }, undefined, options?.serverId);
    }

    async sendPendingDeliveryAsNew(sessionId: string, pendingId: string, options?: PendingQueueOwnerOptions): Promise<string> {
        return await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent }) => await sendPendingDeliveryAsNewV2({
            sessionId,
            pendingId,
            encryption: this.encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        }), undefined, options?.serverId);
    }

    async markPendingDeliveryHandled(sessionId: string, pendingId: string, options?: PendingQueueOwnerOptions): Promise<void> {
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent }) => {
        await markPendingDeliveryHandledV2({
            sessionId,
            pendingId,
            encryption: this.encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
        }, undefined, options?.serverId);
    }

    async deleteDiscardedPendingMessage(sessionId: string, pendingId: string, options?: PendingQueueOwnerOptions): Promise<void> {
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent }) => {
        await deleteDiscardedPendingMessageV2({
            sessionId,
            pendingId,
            encryption: this.encryption,
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
        await this.withPendingQueueOwnerContext(sessionId, async ({ outboxScope, request, isCurrent }) => {
        const canonicalOrderedLocalIds = await Promise.all(orderedLocalIds.map((pendingId) =>
            resolvePendingMessageProjectionLocalIdV2(sessionId, pendingId, outboxScope)
        ));
        await reorderPendingMessagesV2({
            sessionId,
            recipient,
            orderedLocalIds: canonicalOrderedLocalIds,
            encryption: this.encryption,
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

        const isNotFoundError = (error: unknown): boolean => {
            const e = error as any;
            const status =
                e?.status ??
                e?.response?.status ??
                e?.data?.status ??
                e?.cause?.status ??
                null;
            return status === 404;
        };

        // Fetch missing users in parallel. Only cache null for explicit "not found" responses.
        // Do not cache null for transient errors; otherwise we permanently treat that user as absent.
        const results = await Promise.all(
            missingIds.map(async (id) => {
                try {
                    const profile = await getUserProfile(credentials, id, { request, retry: 'none' });
                    return { id, profile, cache: true };
                } catch (error) {
                    if (isNotFoundError(error)) {
                        return { id, profile: null as UserProfile | null, cache: true };
                    }
                    return { id, profile: undefined as unknown as UserProfile | null, cache: false };
                }
            }),
        );

        const usersMap: Record<string, UserProfile | null> = {};
        for (const r of results) {
            if (!r.cache) continue;
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
        const currentViewingSessionId = getCurrentViewingSessionId();
        const surfaceVisibility = getSessionSurfaceVisibilitySnapshot();
        return Array.from(new Set([
            currentViewingSessionId,
            surfaceVisibility.focusedSessionId,
            surfaceVisibility.routeAnchorSessionId,
            ...surfaceVisibility.visibleSessionIds,
        ].filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0)));
    }

    private getPrioritizedSessionHydrationIds = (): string[] => {
        const viewportPriorityLimit = Math.max(0, this.syncTuning.sessionViewportHydrationPriorityMaxRows);
        const prioritizedByViewport = Array.from(this.sessionViewport.entries())
            .sort((left, right) => right[1].lastUpdatedAt - left[1].lastUpdatedAt)
            .slice(0, viewportPriorityLimit)
            .map(([sessionId]) => sessionId);

        return Array.from(new Set([
            ...this.getActiveSessionHydrationIds(),
            ...prioritizedByViewport,
        ]));
    }

    private fetchSessions = async (options?: FetchSessionsOptions) => {
        if (!this.credentials) return;
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
        ).catch((error) => {
            this.publishActiveSessionListObservation(this.socketStatus === 'disconnected' || this.socketStatus === 'error'
                ? 'offline'
                : 'error', undefined, activeServerId);
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
    ): void => {
        const serverId = this.getAppliedTransportTarget()?.serverId ?? '';
        if (!serverId || (expectedServerId && serverId !== expectedServerId)) return;
        storage.setState((state) => {
            const previous = state.concurrentSessionListCacheByServerId[serverId];
            const nextLastSuccessAt = typeof lastSuccessAt === 'number'
                ? lastSuccessAt
                : previous?.listObservation?.lastSuccessAt ?? null;
            if (previous?.listObservation?.phase === phase
                && previous.listObservation.lastSuccessAt === nextLastSuccessAt) return state;
            return {
                ...state,
                concurrentSessionListCacheByServerId: {
                    ...state.concurrentSessionListCacheByServerId,
                    [serverId]: {
                        serverName: getServerProfileById(serverId)?.name?.trim() || previous?.serverName || null,
                        listObservation: { phase, lastSuccessAt: nextLastSuccessAt },
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
        // This owner-only inventory includes archived/offscreen publications;
        // list-page hydration cannot discover them. The existing tuple writer
        // owns parsing, Account/Session keys, and the exact-source CAS upgrade.
        const upgradeLifetime = !isAppend && !this.embedSessionScope
            ? captureActiveServerAccountScopeLifetime()
            : null;
        const upgradeCredentials = this.credentials;
        const upgradeDiscovery = upgradeLifetime && upgradeCredentials && shouldContinue() ? (async () => {
            const isCurrent = () => upgradeLifetime.isCurrent() && shouldContinue();
            try {
                const response = await sessionRequest('/v2/sessions/metadata-upgrades', {
                    method: 'GET', headers: { Authorization: `Bearer ${upgradeCredentials.token}` },
                });
                if (!isCurrent()) return [];
                // A supported older server has no discovery operation; its
                // existing Session reads remain usable without another parser.
                if (response.status !== 404) {
                    if (!response.ok) throw new Error('Session metadata upgrade discovery unavailable');
                    const payload: unknown = await response.json();
                    if (!isCurrent()) return [];
                    if (!payload || typeof payload !== 'object' || !('sessionIds' in payload)
                        || !Array.isArray(payload.sessionIds)
                        || !payload.sessionIds.every((id): id is string => typeof id === 'string' && id.length > 0)) {
                        throw new Error('Invalid Session metadata upgrade discovery');
                    }
                    return [...new Set(payload.sessionIds)];
                }
            } catch {
                log.log('Shared Session metadata discovery deferred until the next sync');
            }
            return [];
        })() : Promise.resolve([]);
        const continuation = isAppend
            ? resolveOrdinarySessionListContinuation(previousFrontier)
            : null;
        const hasLastKnownOrganizationSnapshot = activeServerId
            ? typeof initialState.sessionOrganizationSnapshotVersionByServerId[activeServerId] === 'number'
            : false;
        const organizationSnapshotRefresh = !isAppend && activeServerId
            ? fetchAndApplySessionOrganizationSnapshot({
                credentials: this.credentials,
                serverId: activeServerId,
                serverUrl: appliedTransportTarget.serverUrl,
                requestAtEndpoint: sessionRequest,
                request: createSessionListOrganizationSnapshotRequest(),
                shouldContinue,
            })
            : null;
        if (organizationSnapshotRefresh) {
            if (hasLastKnownOrganizationSnapshot) {
                void organizationSnapshotRefresh.catch(() => undefined);
            } else {
                await organizationSnapshotRefresh.catch(() => undefined);
            }
        }
        const organizationPinnedSessionIds = isAppend
            ? []
            : resolveOrganizationPinnedSessionIdsForServer(storage.getState(), activeServerId);
        const requiredHydrationSessionIds = Array.from(new Set([
            ...(options?.requiredHydrationSessionIds ?? []),
            ...organizationPinnedSessionIds,
        ]));
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
            credentials: this.credentials,
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
            awaitSessionListHydration: options?.awaitSessionListHydration,
            sessionListEagerHydrationCount: isAppend
                ? this.syncTuning.sessionListAppendEagerHydrationCount
                : this.syncTuning.sessionListEagerHydrationCount,
            sessionListHydrationConcurrencyLimit: this.syncTuning.sessionListHydrationConcurrencyLimit,
            sessionListBackgroundHydrationConcurrencyLimit: this.syncTuning.sessionListBackgroundHydrationConcurrencyLimit,
            sessionListBackgroundHydrationMaxRows: this.syncTuning.sessionListBackgroundHydrationMaxRows,
            sessionListBackgroundHydrationYieldDelayMs: this.syncTuning.sessionListBackgroundHydrationYieldDelayMs,
            sessionListBackgroundHydrationYieldEveryRows: this.syncTuning.sessionListBackgroundHydrationYieldEveryRows,
            sessionListBackgroundHydrationGate: isAppend ? this.waitForSessionListScrollIdle : undefined,
            sessionListBackgroundHydrationApplyBatchSize: this.syncTuning.sessionListBackgroundHydrationApplyBatchSize,
            sessionListBackgroundHydrationApplyFlushDelayMs: this.syncTuning.sessionListBackgroundHydrationApplyFlushDelayMs,
            applySessions: (sessions) => {
                if (!shouldContinue()) return;
                this.applySessions(sessions);
            },
            log,
        });
        // A canceled acquisition applied no rows, so it must not advance this
        // Home's frontier either — otherwise the cursor moves past a page that
        // was never stored and no later refresh recovers it. Same guard the
        // concurrent-cache owner already applies before publishing a page.
        if (!result.current || !shouldContinue()) return;
        const fetchedSessionIdSet = new Set(result.sessionIds.filter((sessionId) => result.isSessionCurrent?.(sessionId) !== false));
        const missingRequiredHydrationSessionIds = requiredHydrationSessionIds.filter(
            (sessionId) => result.isSessionCurrent?.(sessionId) !== false && !fetchedSessionIdSet.has(sessionId),
        );
        const activeCredentials = this.credentials;
        const activeEncryption = this.encryption;
        if (!activeCredentials) return;
        await runTasksWithLimit(
            missingRequiredHydrationSessionIds.map((sessionId) => async () => {
                const stagedSessionDataKeys = new Map(this.sessionDataKeys);
                const stagedSessionDataKeyEnvelopes = new Map(this.sessionDataKeyEnvelopes);
                const exactResult = await fetchSessionByIdWithServerScope({
                    sessionId,
                    serverId: activeServerId,
                    activeCredentials,
                    activeEncryption,
                    sessionDataKeys: stagedSessionDataKeys,
                    sessionDataKeyEnvelopes: stagedSessionDataKeyEnvelopes,
                    activeRequest: sessionRequest,
                    accountCurrentness: result.accountCurrentness,
                    getExistingSession: (targetSessionId) => storage.getState().sessions[targetSessionId] ?? null,
                    applySessions: (sessions) => {
                        if (!shouldContinue()) return;
                        this.applySessions(sessions);
                    },
                    log,
                    includeTurnsProjection: false,
                });
                if (!shouldContinue()) return;
                if (!exactResult.ok) {
                    if (exactResult.errorCode === 'not_found') {
                        stagedSessionDataKeys.delete(sessionId);
                        stagedSessionDataKeyEnvelopes.delete(sessionId);
                        // Exact hydration has authoritative absence evidence. Reuse
                        // the canonical local deletion owner so it fences any
                        // older session-list snapshot as well as transcript and
                        // socket work. The evidence is this Home's alone: a same-id
                        // Session on another Home keeps its row and its carrier.
                        this.retireLocalSession(sessionId, activeServerId);
                    } else {
                        throw new Error(
                            `Required session shell hydration failed for ${sessionId}: ${exactResult.errorCode ?? 'unknown'}`,
                        );
                    }
                }
                const stagedKey = stagedSessionDataKeys.get(sessionId);
                if (stagedKey) {
                    this.sessionDataKeys.set(sessionId, stagedKey);
                } else {
                    this.sessionDataKeys.delete(sessionId);
                }
                const stagedEnvelope = stagedSessionDataKeyEnvelopes.get(sessionId);
                if (typeof stagedEnvelope === 'string') {
                    this.sessionDataKeyEnvelopes.set(sessionId, stagedEnvelope);
                } else {
                    this.sessionDataKeyEnvelopes.delete(sessionId);
                }
            }),
            this.syncTuning.sessionListHydrationConcurrencyLimit,
        );
        if (!shouldContinue()) return;
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
        // Discovery overlaps the ordinary read. Publish the list before doing
        // upgrades so a retained inventory cannot delay the initial screen.
        const upgradeIds = await upgradeDiscovery;
        if (upgradeLifetime) {
            const isCurrent = () => upgradeLifetime.isCurrent() && shouldContinue();
            await runTasksWithLimit(upgradeIds.map(sessionId => async () => {
                if (!isCurrent()) return;
                try {
                    await this.migrateSessionMetadataOwnerLayout(sessionId, {
                        serverId: appliedTransportTarget.serverId,
                        accountLifetime: { scope: upgradeLifetime.scope, isCurrent },
                    });
                } catch {
                    // Failed or retired upgrades disclose nothing; the next
                    // ordinary sync rediscovers pending rows.
                    log.log('Shared Session metadata upgrade deferred until the next sync');
                }
            }), this.syncTuning.resumeConcurrencyLimit);
        }
        return result;
    }

    public fetchSessionListQueryPage = async (
        serverIdRaw: string,
        page: SessionListQueryPageRequest,
    ) => {
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
        return fetchAndApplySessions({
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
            sessionListAttentionMaxPages: 1,
            credentials,
            encryption: this.encryption,
            sessionDataKeys: this.sessionDataKeys,
            sessionDataKeyEnvelopes: this.sessionDataKeyEnvelopes,
            request: (path, init) => sessionRequest(path, { ...init, signal: page.signal }),
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

    private createSessionRequest = (sessionId: string): ((path: string, init?: RequestInit) => Promise<Response>) => {
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
        return (path: string) => request(path, { method: 'GET' });
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

        const session = storage.getState().sessions[normalizedSessionId] ?? null;
        if (!session && this.hasFetchedSessionsSnapshotForActiveServer && !this.isSessionKnownOnResolvedOwnerServer(normalizedSessionId)) {
            return { status: 'not_ready' };
        }

        return fetchUserMessageHistoryPage({
            sessionId: normalizedSessionId,
            beforeSeq: opts.beforeSeq,
            limit: opts.limit,
            ...(opts.turnProjection === true ? { turnProjection: true } : {}),
            sessionEncryptionMode: session?.encryptionMode === 'plain' ? 'plain' : 'e2ee',
            request: this.createSessionMessagesRequest(normalizedSessionId),
            getSessionEncryption: (id) => this.encryption?.getSessionEncryption(id) ?? null,
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

    public refreshMachines = async () => {
        return this.fetchMachines();
    }

      public retryNow = () => {
          if (isEmbedWindowContext() && !this.embedSessionScope) return;
          let reconnectSocket = false;
          try {
              storage.getState().clearSyncError();
              this.disconnectSocketIntentionally();
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
          const resume = this.resumeSync('manual');
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
          const isCurrent = this.createServerScopeGuard();
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
                  const shouldContinue = this.createServerScopeGuard();
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
                  if (this.embedSessionScope) {
                      const outcome = await this.resumeViaChanges({ accountId: this.serverID, shouldContinue });
                      if (outcome.status === 'fallback' && shouldContinue()) await this.snapshotRefreshOnResume({mode:'fallback',reason});
                      return;
                  }
                  const forceSessionSystemRecordRefresh = reason === 'socket-reconnect'
                      || reason === 'server-reachable'
                      || reason === 'manual';
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
                          forceSnapshotHydration: reason === 'manual' || this.sessionDraftOfflineCatchUpPending,
                      });
                      if (!shouldContinue()) return;
                  }

                  let accountId = storage.getState().profile?.id ?? null;
                  if (!accountId) {
                      this.profileSync.invalidateCoalesced();
                      await this.profileSync.awaitQueue({ timeoutMs: this.syncTuning.resumeQuickInvalidateTimeoutMs });
                      accountId = storage.getState().profile?.id ?? null;
                  }

                  if (!accountId) {
                      if (!shouldContinue()) {
                          return;
                      }
                      await this.snapshotRefreshOnResume({ mode: 'fallback', reason: 'missing-profile' });
                      return;
                  }

                  if (reason !== 'changes-catch-up') {
                      await this.rearmPendingOutboxForActiveScope();
                      if (!shouldContinue()) {
                          return;
                      }
                  }

                  const { status, refreshedByCatchUp } = await this.resumeViaChanges({
                      accountId,
                      shouldContinue,
                      allowOfflineSnapshotRefresh: reason !== 'changes-catch-up',
                  });
                  if (status === 'aborted') {
                      return;
                  }
                  if (status === 'fallback') {
                      if (!shouldContinue()) {
                          return;
                      }
                      await this.snapshotRefreshOnResume({ mode: 'fallback', reason: 'changes-fallback' });
                      return;
                  }

                  if (reason === 'changes-catch-up') {
                      return;
                  }

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
                      await syncUnit.awaitQueue({ timeoutMs });
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
                }
            );
        };

      private bootstrapSync = async (): Promise<void> => {
          const embedScope = this.embedSessionScope;
          await this.pauseController.waitUntilResumed();
          if (!this.credentials) {
              return;
          }
          if (embedScope) {
              if (this.embedSessionScope !== embedScope || !embedScope.isCurrent()) return;
              const snapshot = await observeAuthenticatedServerFeaturesFresh({ request: embedScope.request });
              if (this.embedSessionScope !== embedScope || !embedScope.isCurrent()) return;
              this.embedFeaturesSnapshot = snapshot;
              primeServerFeaturesSnapshot({ serverId: embedScope.endpointUrl, snapshot });
              const cursor = await fetchCurrentChangesCursor({ credentials: this.credentials, request: embedScope.request });
              if (this.embedSessionScope !== embedScope || !embedScope.isCurrent()) return;
              if (cursor.status === 'ok') this.changesCursor = cursor.cursor;
              await this.refreshEmbedSessionSnapshot();
              if (this.embedSessionScope === embedScope && embedScope.isCurrent()) storage.getState().applyReady();
              return;
          }
          if (isEmbedWindowContext()) return;
          const refreshedServerId = this.getAppliedTransportTarget()?.serverId ?? '';
          if (refreshedServerId) publishHomeAccountChange(refreshedServerId);

          const invalidateBounded = async (syncUnit: InvalidateSync, timeoutMs: number): Promise<void> => {
              syncUnit.invalidateCoalesced();
              await syncUnit.awaitQueue({ timeoutMs });
          };

          // Bootstrap concurrency is slightly higher to reduce time-to-first-render.
          const bootstrapConcurrencyLimit = this.syncTuning.bootstrapConcurrencyLimit;

          // Phase 1: load settings first. Session bootstrap depends on settings for pinned
          // and durable-attention rows, so fetching sessions concurrently can omit rows
          // that must be visible before the user scrolls.
          await invalidateBounded(this.settingsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs);

          // Phase 2: load core UI state and every projection consumed immediately after readiness.
          await runTasksWithLimit(
              [
                  () => invalidateBounded(this.profileSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.accountPetsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.sessionsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.machinesSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.artifactsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.pluginAvailabilitySync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.purchasesSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
              ],
              bootstrapConcurrencyLimit
          );

          await this.refreshSessionDraftRepositoryForSync();

          await this.rearmPendingOutboxForActiveScope();

          try {
              storage.getState().applyReady();
          } catch {
              // ignore
          }

          // Phase 3: load non-critical lists.
          await runTasksWithLimit(
              [
                  () => invalidateBounded(this.automationsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.todosSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.friendsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.friendRequestsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.feedSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.nativeUpdateSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
              ],
              this.syncTuning.resumeConcurrencyLimit
          );
        };

      private snapshotRefreshOnResume = async (opts: { mode: 'fallback' | 'long-offline'; reason: string }): Promise<void> => {
          if (this.embedSessionScope) { await this.refreshEmbedSessionSnapshot(); return; }
          if (isEmbedWindowContext()) return;
          if (this.pauseController.isPaused()) {
              return;
          }
          await this.pauseController.waitUntilResumed();
          if (!this.credentials) {
              return;
          }
          const refreshedServerId = this.getAppliedTransportTarget()?.serverId ?? '';
          if (refreshedServerId) publishHomeAccountChange(refreshedServerId);

          const invalidateBounded = async (syncUnit: InvalidateSync, timeoutMs: number): Promise<void> => {
              syncUnit.invalidateCoalesced();
              await syncUnit.awaitQueue({ timeoutMs });
          };

          const concurrencyLimit = this.syncTuning.resumeConcurrencyLimit;

          // Rebuild core lists first (sessions drives most downstream state).
          await runTasksWithLimit(
              [
                  () => invalidateBounded(this.sessionsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.machinesSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.pluginAvailabilitySync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
              ],
              concurrencyLimit
          );

          await this.refreshSessionDraftRepositoryForSync({ forceSnapshotHydration: true });

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

          await runTasksWithLimit(
              activeTranscriptSessionIds.map((sessionId) => async () => {
                  await invalidateBounded(this.getOrCreateMessagesSync(sessionId), this.syncTuning.invalidateSyncAwaitTimeoutMs);
                  scmStatusSync.invalidate(sessionId);
              }),
              this.syncTuning.messageCatchUpConcurrencyLimit
          );

          // Refresh the rest with bounded concurrency.
          await runTasksWithLimit(
              [
                  () => invalidateBounded(this.artifactsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.automationsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
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
            return this.fetchSessions({ awaitSessionListHydration: true });
        }
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
            mutationIntent?: 'rename_session';
            accountLifetime?: Pick<ServerAccountScopeLifetime, 'scope' | 'isCurrent'>;
        }>,
    ): Promise<void> => {
        if (!options?.accountLifetime) {
            await this.updateSessionMetadataWithRetry(sessionId, updater, options);
            return;
        }
        const lifetime = options.accountLifetime;
        if (
            !lifetime.isCurrent()
            || (options.serverId
                && !areServerProfileIdentifiersEquivalent(options.serverId, lifetime.scope.serverId))
        ) {
            throw Object.assign(new Error('Session Account authority retired during metadata update'), {
                code: 'session_account_scope_retired',
            });
        }
        await runWithServerRequestAuthorityForServerAccountScope({
            scope: lifetime.scope,
            activeRequest: this.createSessionRequest(sessionId),
        }, async (authority) => {
            const isCurrent = () => lifetime.isCurrent()
                && areServerAccountScopesEqual(authority.scope, lifetime.scope);
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
                serverId: lifetime.scope.serverId,
                authority: fencedAuthority,
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
        return this.automationsSync.invalidateAndAwait();
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
        await deleteAutomationDefinition(this.credentials, automationId, requestContext);
        if (!shouldContinue()) {
            throw new Error('Automation server-account scope changed');
        }
        storage.getState().removeAutomation(automationId);
    }

    /**
     * Admits one occurrence and returns the server's whole receipt.
     *
     * The bounded Automation Run cache still receives the exact Run body, and
     * the declared workflow correspondence travels back to the caller so it can
     * open that exact managed Run. Nothing here infers the correspondence.
     */
    public async runAutomationNow(
        automationId: string,
    ): Promise<AutomationRunNowAdmission> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const { requestContext, shouldContinue } = this.prepareAppliedAutomationExecution();
        const admitted = await runAutomationDefinitionNow(this.credentials, automationId, requestContext);
        if (!shouldContinue()) {
            throw new Error('Automation server-account scope changed');
        }
        storage.getState().upsertAutomationRun(admitted.run);
        return admitted;
    }

    /**
     * Opens one direct Run detail for its route only. The exact Account
     * currentness witness and key proof stay on the Sync owner; the resulting
     * private projection is never copied into the bounded Automation Run cache.
     */
    public async getAutomationRunDetailInspection(
        automationId: string,
        runId: string,
    ): Promise<AutomationRunDetailRouteInspection> {
        const credentials = this.credentials;
        if (!credentials) {
            throw new Error('Not authenticated');
        }
        const { requestContext, shouldContinue } = this.prepareAppliedAutomationExecution();
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
        const privateContent = inspectAutomationRunDetailPrivateContent({
            detail,
            accountCurrentness,
            ...(material.kind === 'available' && material.material
                ? { material: material.material }
                : {}),
        });
        if (!shouldContinue()) {
            throw new Error('Automation server-account scope changed');
        }
        return { detail, privateContent };
    }

    /** Cancellation updates the one incumbent bounded Run cache when its scope remains current. */
    public async cancelAutomationRun(runId: string): Promise<AutomationDefinitionRun> {
        const credentials = this.credentials;
        if (!credentials) {
            throw new Error('Not authenticated');
        }
        const { requestContext, shouldContinue } = this.prepareAppliedAutomationExecution();
        const run = await cancelAutomationRun(credentials, runId, requestContext);
        if (!shouldContinue()) {
            throw new Error('Automation server-account scope changed');
        }
        storage.getState().upsertAutomationRun(run);
        return run;
    }

    /** Requeues one blocked reply handoff and patches the incumbent bounded Run cache. */
    public async retryAutomationReplyHandoff(runId: string): Promise<AutomationDefinitionRun> {
        const credentials = this.credentials;
        if (!credentials) throw new Error('Not authenticated');
        const { requestContext, shouldContinue } = this.prepareAppliedAutomationExecution();
        const run = await retryAutomationReplyHandoff(credentials, runId, requestContext);
        if (!shouldContinue()) throw new Error('Automation server-account scope changed');
        storage.getState().upsertAutomationRun(run);
        return run;
    }

    /**
     * Authorizes one further delivery of an accepted result. The caller passes
     * the exact Run revision it showed the user, so the server can refuse an
     * authorization that no longer describes what they decided about.
     */
    public async deliverAutomationResultAgain(input: Readonly<{
        runId: string;
        expectedRevision: number;
    }>): Promise<AutomationDefinitionRun> {
        const credentials = this.credentials;
        if (!credentials) throw new Error('Not authenticated');
        const { requestContext, shouldContinue } = this.prepareAppliedAutomationExecution();
        const run = await deliverAutomationResultAgain(credentials, input, requestContext);
        if (!shouldContinue()) throw new Error('Automation server-account scope changed');
        storage.getState().upsertAutomationRun(run);
        return run;
    }

    public getCredentials() {
        return this.credentials;
    }

    // Artifact methods
    public fetchArtifactsList = async (): Promise<void> => {
        if (!this.credentials) return;
        const shouldContinue = this.createServerScopeGuard();
        await this.withArtifactReadAuthority(undefined, params => fetchAndApplyArtifactsList({
            ...params,
            shouldContinue: () => shouldContinue() && !params.signal?.aborted,
            applyArtifacts: (artifacts) => storage.getState().applyArtifacts(artifacts),
        }));
    }

    public async fetchArtifactWithBody(artifactId: string): Promise<DecryptedArtifact | null> {
        if (!this.credentials) return null;
        return this.withArtifactReadAuthority(undefined, params => fetchArtifactWithBodyFromApi({ ...params, artifactId }));
    }

    private async withArtifactReadAuthority<TResult>(signal: AbortSignal | undefined,
        operation: (params: Omit<Parameters<typeof fetchArtifactForViewFromApi>[0], 'artifactId' | 'includePdfPreview'>) => Promise<TResult>,
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
            const authority = await captureServerRequestAuthorityForServerAccountScope({ scope, activeRequest: this.requestViaConfiguredSocket });
            let result: TResult;
            try {
                guard.check();
                if (authority.context.token !== credentials.token) throw staleError();
                result = await operation({ credentials, encryption, artifactDataKeys: this.artifactDataKeys,
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

    public fetchArtifactForView = async (artifactId: string, options: Readonly<{ includePdfPreview: boolean; signal: AbortSignal }>): Promise<ArtifactViewRead | null> => {
        return this.withArtifactReadAuthority(options.signal,
            params => fetchArtifactForViewFromApi({ ...params, artifactId, includePdfPreview: options.includePdfPreview }));
    };

    public fetchArtifactBinary = async (artifactId: string, reference: Parameters<typeof fetchArtifactBinaryFromApi>[0]['reference'], signal?: AbortSignal): Promise<Uint8Array> => {
        return this.withArtifactReadAuthority(signal, params => fetchArtifactBinaryFromApi({ ...params, artifactId, reference }));
    };

    public fetchArtifactHtmlPreview = async (artifactId: string, signal?: AbortSignal): Promise<string> => {
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

    public async updateArtifact(
        artifactId: string, 
        title: string | null, 
        body: ArtifactBodyInput,
        sessions?: string[],
        draft?: boolean
    ): Promise<void> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }

        await updateArtifactViaApi({
            credentials: this.credentials,
            artifactId,
            title,
            body,
            sessions,
            draft,
            encryption: this.encryption,
            artifactDataKeys: this.artifactDataKeys,
            getArtifact: (id) => storage.getState().artifacts[id],
            updateArtifact: (artifact) => storage.getState().updateArtifact(artifact),
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
        if (!this.credentials) return;
        const appliedTransportTarget = this.getAppliedTransportTarget();
        if (!appliedTransportTarget) return;
        const generation = this.serverScopeGeneration;
        const shouldContinue = () => (
            this.serverScopeGeneration === generation
            && this.isAppliedTransportTargetCurrent(appliedTransportTarget)
        );
        const sourceServerId = appliedTransportTarget.serverId;
        const cachedMachineDisplayEntries = buildMachineDisplayCacheEntriesFromRenderables(storage.getState().machineDisplayById);

        await fetchAndApplyMachines({
            credentials: this.credentials,
            request: this.createAppliedTransportRequest(appliedTransportTarget),
            encryption: this.encryption,
            machineDataKeys: this.machineDataKeys,
            throwOnError: false,
            getExistingMachine: (machineId) => storage.getState().machines[machineId] ?? null,
            cachedMachineDisplayEntries,
            shouldContinue,
            applyMachineDisplayEntries: (machines) => {
                if (!shouldContinue()) return;
                storage.getState().replaceMachineDisplays(machines, { sourceServerId });
            },
            machineDisplayHydrationConcurrencyLimit: this.syncTuning.machineDisplayHydrationConcurrencyLimit,
            applyMachines: (machines, replace) => {
                if (!shouldContinue()) return;
                storage.getState().applyMachines(machines, replace, { sourceServerId });
            },
            replace: true,
            sourceServerId,
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
        const result = await fetchAndApplyAutomations({
            credentials,
            requestContext: this.createAppliedAutomationRequestContext(target),
            shouldContinue,
            applyAutomations: (automations, nextCursor) =>
                storage.getState().applyAutomations(automations, nextCursor),
            appendAutomations: (cursor, traversalToken, automations, nextCursor) =>
                storage.getState().appendAutomations(cursor, traversalToken, automations, nextCursor),
            loadedAutomationRunIds: Object.keys(storage.getState().automationRunIdsByAutomationId),
            refreshAutomationRunsWindow: (automationId, runs, nextCursor) =>
                storage.getState().refreshAutomationRunsWindow(automationId, runs, nextCursor),
        });
        this.automationDefinitionTraversalToken = result.traversalToken;
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
        if (!this.credentials) return;
        await applyTodoSocketUpdatesEngine({
            changes,
            credentials: this.credentials,
            encryption: this.encryption,
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
            const owner = createAuthoringMemorySync({
                transport: createApiAuthoringMemoryTransport({ request }),
                cipher: createAuthoringMemoryCipher({ mode: mode.mode,
                    material: mode.mode === 'e2ee' && !isTokenOnlyAuthCredentials(credentials)
                        ? resolveAccountScopedCryptoMaterialFromCredentials(credentials) : null,
                    randomBytes: getRandomBytes }),
                isCurrent,
                apply: (delta) => {
                    const previous = storage.getState().authoringMemory;
                    storage.getState().applyAuthoringMemory(delta);
                    if (!isCurrent()) throw new Error('Authoring memory Account/Home retired');
                    const current = storage.getState().authoringMemory;
                    if (current !== previous) saveAuthoringMemoryProjection(scope, current);
                },
            });
            await owner.bootstrap();
            await importLegacyAuthoringMemory({ owner, settings: {
                read: () => readAccountSettingsBaseline({ request, credentials, encryption, accountMode: mode.mode }),
                remove: async (key, expectedVersion) => {
                    owner.assertCurrent();
                    if (key !== 'recentMachinePaths' && key !== 'lastUsedProfile' && key !== 'lastEngineSelectionsByScopeV1') {
                        throw new Error('Invalid authoring-memory retirement key');
                    }
                    const result = await retireLegacyAuthoringMemoryKey({
                        credentials, encryption, accountMode: mode.mode, settingsScope: scope,
                        requestContext: { ...requestContext, request },
                        key, expectedSettingsVersion: expectedVersion,
                    });
                    owner.assertCurrent();
                    return result.status;
                },
            } });
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
    }

    private syncSettings = async () => {
        if (!this.credentials) return;
        if (!this.embedSessionScope && !isEmbedWindowContext()) {
            fireAndForget(this.ensureAuthoringMemoryRuntime().catch((error: unknown) => {
                if (!(error instanceof StaleServerGenerationError)) throw error;
                // The failed runtime is cleared by its owner. The next current-generation
                // settings lifecycle bootstraps it again through this same entry point.
            }), { tag: 'Sync.authoringMemory.bootstrap' });
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
        expectedSettingsVersion: number;
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
        }>) => Promise<OneShotAccountSettingsPreparedCommitResult>;
    }>): Promise<OneShotAccountSettingsMutationResult<T>> => {
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
            }, { includeAuth: false });

            if (!response.ok) {
                log.log(`[fetchNativeUpdate] Request failed: ${response.status}`);
                return;
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
            storage.getState().applyNativeUpdateStatus(null);
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
        if (!session) {
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
        const machine = externalSessionLink
            ? storage.getState().machines[externalSessionLink.machineId] ?? null
            : null;
        return resolveExternalSessionTranscriptAuthority({
            linked: externalSessionLink !== null,
            // A not-yet-hydrated machine row is not evidence that the Agent is offline.
            // Known offline presence selects the snapshot; unknown presence keeps the
            // live read path, whose RPC returns the typed availability outcome.
            agentReachable: machine === null ? null : isMachineOnline(machine),
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
    ): Promise<boolean> {
        const authorityKey = externalSessionTranscriptAuthorityKey(authority);
        const stagedMessages: NormalizedMessage[] = [];
        let stagedPage: SessionMessagesPageV1 | null = null;
        const pageOptions = this.getSessionMessagesPageOptions(session.id);
        await fetchAndApplyMessages({
            sessionId: session.id,
            serverId: resolvePreferredServerIdForSessionId(session.id),
            sessionEncryptionMode: session.encryptionMode === 'plain' ? 'plain' : 'e2ee',
            getSessionEncryption: (id) => this.encryption?.getSessionEncryption(id) ?? null,
            isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
            request: this.createSessionMessagesRequest(session.id),
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
            const priorIssue = storage.getState().getSessionTranscriptLoadIssue(sessionId);
            try {
                await this.fetchMessagesInternal(sessionId);
            } catch (error) {
                if (!isCurrent()) throw error;
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
        const session = storage.getState().sessions[sessionId] ?? null;
        // A queued InvalidateSync callback can run after local deletion. It
        // must not recreate an empty loaded transcript for an absent session.
        if (!session) {
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
        const externalSessionLink = readExternalSessionLink(
            session ? readSessionOwnerMetadataView(session) : null,
        );
        if (!externalSessionLink && this.hasFetchedSessionsSnapshotForActiveServer && !this.isSessionKnownOnResolvedOwnerServer(sessionId)) {
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
          const requestMessages = this.createSessionMessagesRequest(sessionId);
          const sessionEncryptionMode = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';

        const transcriptAuthority = this.resolveTranscriptAuthority(session, externalSessionLink);
          const authorityKey = externalSessionTranscriptAuthorityKey(transcriptAuthority);
          const previousAuthorityKey = this.transcriptAuthorityKeyBySessionId.get(sessionId) ?? null;
          const loadedTranscript = storage.getState().sessionMessages[sessionId];
          const hasMaterializedMessages = Object.keys(loadedTranscript?.messagesById ?? {}).length > 0;
          const pageOptions = this.getSessionMessagesPageOptions(sessionId);

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
                      this.replaceWithServerTranscript(session, transcriptAuthority);
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
                  serverId: resolvePreferredServerIdForSessionId(sessionId),
                  sessionEncryptionMode,
                  getSessionEncryption: (id) => this.encryption?.getSessionEncryption(id) ?? null,
                  isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
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
              storage.getState().setSessionTranscriptLoadIssue(sessionId, null);
              if (hasExplicitTailProbe) {
                  this.explicitSessionTailProbeIds.delete(sessionId);
              }
              return;
          }

            const decision = decideMessageCatchUpPolicy({
                isForeground: this.isForeground && !this.pauseController.isPaused(),
                isSessionVisible: resolveSessionLiveConsumption(sessionId).isFullContentConsumer,
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
              this.isSessionKnownOnResolvedOwnerServer(sessionId) && pageOptions.isCurrent()
          );
          const canRefreshLiveTail = () => (
              (this.sessionViewport.get(sessionId)?.isPinned ?? true)
              && !this.getSessionTargetWindowState(sessionId).isWindowMode
              && this.isForeground
              && !this.pauseController.isPaused()
              && resolveSessionLiveConsumption(sessionId).isFullContentConsumer
          );
          const applyCatchUpDecision = () => applyMessageCatchUpDecision({
              decision,
              afterSeq,
              onIncrementalExhausted: () => canRefreshLiveTail() ? 'tail_reset_latest_page' : 'defer_forward_loading',
              fetchNewerPage: async (cursor) => {
                  const expectedGap = readTranscriptGap(this.deferredTranscriptState, sessionId);
                  const pageServerId = resolvePreferredServerIdForSessionId(sessionId);
                  const result = await fetchAndApplyNewerMessages({
                      sessionId,
                      serverId: pageServerId,
                      sessionEncryptionMode,
                      afterSeq: cursor,
                      limit: SESSION_MESSAGES_PAGE_SIZE,
                      getSessionEncryption: (id) => this.encryption?.getSessionEncryption(id) ?? null,
                      isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
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
                      serverId: resolvePreferredServerIdForSessionId(sessionId),
                      sessionEncryptionMode,
                      getSessionEncryption: (id) => this.encryption?.getSessionEncryption(id) ?? null,
                      isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
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
                  const page = await machineExternalSessionTranscriptPage({
                      machineId: externalSessionLink.machineId,
                      agentId: externalSessionLink.agentId,
                      remoteSessionId: externalSessionLink.remoteSessionId,
                      source: externalSessionLink.source,
                      direction: 'older',
                  }, { serverId: this.getExternalSessionServerScope(sessionId) });
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
                  const tail = await machineExternalSessionTranscriptReadAfter({
                      machineId: externalSessionLink.machineId,
                      agentId: externalSessionLink.agentId,
                      remoteSessionId: externalSessionLink.remoteSessionId,
                      source: externalSessionLink.source,
                      cursor,
                  }, { serverId: this.getExternalSessionServerScope(sessionId) });
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
                      const response = await machineExternalSessionTranscriptReadAfter({
                          machineId: externalSessionLink.machineId,
                          agentId: externalSessionLink.agentId,
                          remoteSessionId: externalSessionLink.remoteSessionId,
                          source: externalSessionLink.source,
                          cursor: nextCursor,
                      }, { serverId: this.getExternalSessionServerScope(sessionId) });
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
                      const page = await machineExternalSessionTranscriptPage({
                          machineId: externalSessionLink.machineId,
                          agentId: externalSessionLink.agentId,
                          remoteSessionId: externalSessionLink.remoteSessionId,
                          source: externalSessionLink.source,
                          direction: 'older',
                          cursor,
                          ...(requestedLimit !== null ? { maxItems: requestedLimit } : {}),
                      }, { serverId: this.getExternalSessionServerScope(params.sessionId) });
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
          const requestMessages = this.createSessionMessagesRequest(params.sessionId);
          const session = storage.getState().sessions[params.sessionId] ?? null;
          const sessionEncryptionMode = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
          const pageOptions = this.getSessionMessagesPageOptions(params.sessionId);
          try {
              const result = await fetchAndApplyOlderMessages({
                  sessionId: params.sessionId,
                  serverId: resolvePreferredServerIdForSessionId(params.sessionId),
                  sessionEncryptionMode,
                  beforeSeq,
                  limit: resolveSessionMessagesPageSize({ limit: params.limit }),
                  scope: params.scope,
                  sidechainId: params.sidechainId ?? null,
                  getSessionEncryption: (id) => this.encryption?.getSessionEncryption(id) ?? null,
                  isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
                  request: requestMessages,
                  sessionReceivedMessages: this.sessionReceivedMessages,
                  applyMessages: (sid, messages) => this.applyMessages(sid, messages, { notifyVoice: false }),
                  ...pageOptions,
                  log,
              });

              // The page pipeline can return its missing-session sentinel after
              // decrypt. Do not reinterpret that empty page as terminal history:
              // delete-wins must leave pagination and deferred state absent.
              if (!this.isSessionKnownOnResolvedOwnerServer(params.sessionId) || !pageOptions.isCurrent()) {
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
                  serverId: resolvePreferredServerIdForSessionId(normalizedSessionId),
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
              return await fetchAndApplyTargetWindowMessages({
                  sessionId: normalizedSessionId,
                  serverId: resolvePreferredServerIdForSessionId(normalizedSessionId),
                  windowId,
                  target,
                  direction,
                  limit: resolveSessionMessagesPageSize({ limit: options?.limit }),
                  scope: 'main',
                  sessionEncryptionMode,
                  getSessionEncryption: (id) => this.encryption?.getSessionEncryption(id) ?? null,
                  isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
                  isRouteMessageIdLoaded: (routeMessageId) => this.isRouteMessageIdLoaded(normalizedSessionId, routeMessageId),
                  request: this.createSessionMessagesRequest(normalizedSessionId),
                  sessionReceivedMessages: this.sessionReceivedMessages,
                  applyMessages: (sid, messages) => this.applyMessages(sid, messages, { notifyVoice: false }),
                  getWindowState: () => this.getSessionTargetWindowState(normalizedSessionId),
                  setWindowState: (state) => this.setSessionTargetWindowState(normalizedSessionId, state),
                  now: () => Date.now(),
                  ...this.getSessionMessagesPageOptions(normalizedSessionId),
                  log,
              });
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
          const requestMessages = this.createSessionMessagesRequest(normalizedSessionId);
          const session = storage.getState().sessions[normalizedSessionId] ?? null;
          const sessionEncryptionMode = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
          const pageOptions = this.getSessionMessagesPageOptions(normalizedSessionId);
          try {
              await fetchAndApplyMessages({
                  sessionId: normalizedSessionId,
                  serverId: resolvePreferredServerIdForSessionId(normalizedSessionId),
                  sessionEncryptionMode,
                  scope: 'sidechain',
                  sidechainId: normalizedSidechainId,
                  getSessionEncryption: (id) => this.encryption?.getSessionEncryption(id) ?? null,
                  isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
                  request: requestMessages,
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
          const requestMessages = this.createSessionMessagesRequest(sessionId);
          const session = storage.getState().sessions[sessionId] ?? null;
          const sessionEncryptionMode = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
          const pageOptions = this.getSessionMessagesPageOptions(sessionId);
          try {
              const expectedGap = readTranscriptGap(this.deferredTranscriptState, sessionId);
              const pageServerId = resolvePreferredServerIdForSessionId(sessionId);
              const result = await fetchAndApplyNewerMessages({
                  sessionId,
                  serverId: pageServerId,
                  sessionEncryptionMode,
                  afterSeq,
                  limit: SESSION_MESSAGES_PAGE_SIZE,
                  getSessionEncryption: (id) => this.encryption?.getSessionEncryption(id) ?? null,
                  isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
                  request: requestMessages,
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
          } catch (error) {
              console.error('Failed to load newer messages:', error);
              return { loaded: 0, hasMore: true, status: 'loaded' };
          } finally {
              this.sessionMessagesLoadingNewerByKey.delete(pagingKey);
              storage.getState().endSessionCatchUpNewer(sessionId);
          }
      }

    private subscribeToUpdates = () => {
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
	                      this.sessionDraftOfflineCatchUpPending = true;
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
              if (!this.embedSessionScope) publishMachineContributionRegistryProjectionReconnect();
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
          if (this.hasFetchedSessionsSnapshotForActiveServer && !this.isSessionKnownOnResolvedOwnerServer(sessionId)) {
              return resolvedMessageIds;
          }
          const targets = [...authoritativeUpdateMessageIds].map((messageId) => ({
              messageId,
              seq: messageSeqs?.[messageId]
                  ?? this.resolveDurableSessionMessageIdentity(sessionId, messageId).seq
                  ?? staleMinSeq,
          }));
          const requestMessages = this.createSessionMessagesRequest(sessionId);
          const session = storage.getState().sessions[sessionId] ?? null;
          const sessionEncryptionMode = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
          const pageServerId = resolvePreferredServerIdForSessionId(sessionId);
          // Hidden edits and changes-feed revisions can outlive the independent tail
          // probe, so their repair owns the catch-up signal until every page settles.
          return await this.withSessionCatchUpNewer(sessionId, async () => {
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
                      getSessionEncryption: (id) => this.encryption?.getSessionEncryption(id) ?? null,
                      isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
                      request: requestMessages,
                      sessionReceivedMessages: this.sessionReceivedMessages,
                      applyMessages: (sid, messages) => this.applyMessages(sid, messages, { notifyVoice: false }),
                      onNormalizedMessages: (messages) => ingestWorkspaceMutationMessages(sessionId, messages, pageServerId),
                      onResolvedMessageIds: (messageIds) => {
                          resolvedMessageIds = messageIds;
                      },
                      ...this.getSessionMessagesPageOptions(sessionId),
                      log,
                  });
              } catch (error) {
                  console.error('Failed to refetch stale transcript region:', error);
              }

              return resolvedMessageIds;
          });
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
          allowOfflineSnapshotRefresh?: boolean;
      }): Promise<ResumeViaChangesOutcome> {
          const CHANGES_PAGE_LIMIT = this.syncTuning.changesPageLimit;
          const embedScope = this.embedSessionScope;
          const afterCursor = this.changesCursor ?? '0';
          const shouldContinue = () => (opts.shouldContinue?.() ?? true)
              && (!embedScope || this.embedSessionScope === embedScope && embedScope.isCurrent());
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
              credentials: this.credentials,
              accountId: opts.accountId,
              planContext: {
                  isSessionListMember: (sessionId) => embedScope ? sessionId === embedScope.scope.sessionId : this.isSessionListMemberOnHome(transportTarget.serverId, sessionId),
              },
              afterCursor,
              changesPageLimit: CHANGES_PAGE_LIMIT,
              maxChangesPagesPerResume: this.syncTuning.changesMaxPagesPerResume,
              forceSnapshotRefresh,
                fetchChanges: (params) => fetchChanges({ ...params, ...(embedScope ? { request: embedScope.request, sessionId: embedScope.scope.sessionId } : {}) }),
                fetchCurrentCursor: (params) => fetchCurrentChangesCursor({ ...params, ...(embedScope ? { request: embedScope.request } : {}) }),
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
	                    await this.snapshotRefreshOnResume({ mode: 'long-offline', reason: 'snapshot-refresh' });
                        if (embedScope) return;
	                    resetActivePluginCollectionUiQueryWatches();
	                    resetActiveScopedPluginSettingsChangeWatches();
                },
                applyPlanned: async (planned) => {
                    const scope = embedScope;
                    if (scope) {
                        if (!shouldContinue()) throw new StaleServerGenerationError();
                        // The Session-scoped server page is consumed by the incumbent planner and
                        // applier. No Account projection or list materialization is admitted here.
                        const scopedPlan = planSyncActionsFromChanges(planned.changes.filter((change) =>
                            (change.kind === 'session' || change.kind === 'share') && change.entityId === scope.scope.sessionId,
                        ), { isSessionListMember: () => true });
                        scopedPlan.sessionDraftAddresses = [];
                        scopedPlan.sessionFolderAssignmentSessionIds = [];
                        scopedPlan.sessionOrganization = { mode: 'none' };
                        scopedPlan.invalidate.sessionFolderAssignments = false;
                        return await applyPlannedChangeActions({
                            planned: scopedPlan, credentials: this.credentials,
                            isSessionMessagesLoaded: (sid) => storage.getState().sessionMessages[sid]?.isLoaded === true,
                            getSessionMaterializedMaxSeq: (sid) => this.sessionMaterializedMaxSeqById[sid] ?? 0,
                            invalidate: { sessions: () => this.refreshEmbedSessionSnapshot(), sessionRows: () => this.refreshEmbedSessionSnapshot() },
                            invalidateMessagesForSession: (sid) => this.getOrCreateMessagesSync(sid).invalidateAndAwait(),
                            repairSessionTranscriptRevision: (repair) => this.repairSessionTranscriptRevision(repair),
                            convergePendingForSession: (sid) => this.fetchPendingMessages(sid),
                            invalidateScmStatusForSession: () => {}, applyTodoSocketUpdates: async () => {},
                            kvBulkGet, concurrencyLimit: this.syncTuning.resumeConcurrencyLimit,
                        });
                    }
                    const plannedServerId = transportTarget.serverId || sessionRecordChangeScope?.serverId || '';
                    return await applyPlannedChangeActions({
                        planned,
                        credentials: this.credentials,
                        isSessionMessagesLoaded: (sessionId) => storage.getState().sessionMessages[sessionId]?.isLoaded === true,
                        shouldCatchUpSessionMessages: (sessionId) =>
                            resolveSessionLiveConsumption(sessionId).isFullContentConsumer,
                        getSessionMaterializedMaxSeq: (sessionId) => this.sessionMaterializedMaxSeqById[sessionId] ?? 0,
                        isSessionMessagesDeferred: (sessionId) => this.hasDeferredNewerMessages(sessionId),
                        publishAccountChanges: (changes) => {
                            if (plannedServerId) {
                                publishMountedSessionDiscussionChanges({
                                    serverId: plannedServerId,
                                    changes,
                                });
                            }
                            if (sessionRecordChangeScope) {
                                for (const repository of this.sessionSystemRecordRepositories.values()) {
                                    invalidateSessionSystemRecordsFromChanges({ scope: sessionRecordChangeScope, changes, repository });
                                }
                            }
                            const changedEntityIds = changes.map((change) => change.entityId);
                            if (plannedServerId && changedEntityIds.length > 0) {
                                // The focused-Home page has already passed through
                                // the canonical change planner. Publish that exact
                                // filtered-list decision instead of asking the list
                                // to reinterpret AccountChange hints or reacting a
                                // second time to the earlier content-free wake.
                                publishHomeAccountChange(plannedServerId, changedEntityIds, {
                                    sessionListQueryAffects: plannedChangesAffectSessionListQuery(planned),
                                });
                            }
                            publishActivePluginCollectionUiQueryChanges(changes);
                            publishActiveScopedPluginSettingsChanges(changes);
                            if (changes.some((change) => (
                                change.kind === 'account' && change.entityId === 'self'
                            ))) {
                                // The Account-mode cache is the one owner of
                                // its own snapshot. An AccountChange supplies
                                // only its incumbent invalidation edge.
                                invalidateAccountEncryptionModeCache();
                            }
                            const changedAvailabilityPluginIds = this.pluginAvailabilityProjectionHydrator.invalidate(changes);
                            if (changedAvailabilityPluginIds.length > 0) {
                                // AccountChange is a freshness observation, not
                                // withdrawal authority. Retain confirmed facts
                                // until each named plugin read replaces them.
                                this.pluginAvailabilitySync.invalidateCoalesced();
                            }
                        },
                        refreshWorkflowRun: (runId) => refreshWorkflowRunById(runId),
                        invalidate: {
                            settings: () => this.settingsSync.invalidateAndAwait(),
                            profile: () => this.profileSync.invalidateAndAwait(),
                            machines: async () => {
                                await this.machinesSync.invalidateAndAwait();
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
                            artifacts: () => this.artifactsSync.invalidateAndAwait(),
                            friends: () => this.friendsSync.invalidateAndAwait(),
                            friendRequests: () => this.friendRequestsSync.invalidateAndAwait(),
                            feed: () => this.feedSync.invalidateAndAwait(),
                            automations: () => this.automationsSync.invalidateAndAwait(),
                            pets: () => this.fetchAccountPets(),
                            savedSecretResources: async () => {
                                const scope = storage.getState().settingsScope;
                                if (!scope || !plannedServerId || !areServerProfileIdentifiersEquivalent(scope.serverId, plannedServerId)) {
                                    throw new Error('Saved Secret catalog AccountChange scope changed before refresh');
                                }
                                await invalidateSavedSecretCatalogProjection(scope);
                            },
                            sessions: async ({ requiredHydrationSessionIds, prioritizeSessionIds }) => {
                                await this.fetchSessions({
                                    awaitSessionListHydration: true,
                                    requiredHydrationSessionIds,
                                    prioritizeSessionIds,
                                });
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
                                    credentials: this.credentials,
                                    serverId: plannedServerId,
                                    sessionIds,
                                });
                            },
                            todos: () => this.todosSync.invalidateAndAwait(),
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
                                credentials: this.credentials,
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
                                this.getOrCreateMessagesSync(sessionId).invalidateAndAwait());
                        },
                        repairSessionTranscriptRevision: (repair) => this.repairSessionTranscriptRevision(repair),
                        invalidateScmStatusForSession: (sessionId) => scmStatusSync.invalidate(sessionId),
                        applyTodoSocketUpdates: (changes) => this.applyTodoSocketUpdates(changes),
                        kvBulkGet,
                        convergePendingForSession: (sessionId) => this.fetchPendingMessages(sessionId),
                        materializeAuthoringMemory: async (key) => {
                            if (!isAppliedTransportCurrent()) throw new Error('Authoring memory transport retired');
                            await (await this.ensureAuthoringMemoryRuntime()).refresh(key);
                            if (!isAppliedTransportCurrent()) throw new Error('Authoring memory transport retired');
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
          await handleSocketUpdate({
              update,
              encryption: this.encryption,
              credentials: this.credentials ?? null,
              settingsSecretsKey: this.settingsSecretsKey,
              settingsSecretsReadKeys: this.settingsSecretsReadKeys,
              settingsScope: this.pendingSettingsScope,
              sourceServerId,
              shouldContinue,
              onAccountChangeWake: () => {
                  // The focused Home's wake is only a cursor signal. The catch-up it requests
                  // passes the detailed page through the change planner, which publishes the
                  // exact changed entities (`publishAccountChanges`), so each Account projection
                  // (governance, eligibility, Teams, follow, lists) refetches only for what it
                  // shows. A content-free event here made every one of them refetch on every
                  // unrelated change. Secondary Homes have no planner and keep their
                  // conservative wake in the concurrent session cache.
                  this.requestChangesCatchUp();
              },
              artifactDataKeys: this.artifactDataKeys,
              applySessions: (sessions) => this.applySessions(sessions),
	              fetchSessions: () => {
                      if (this.embedSessionScope) return;
	                  fireAndForget(this.fetchSessions(), { tag: 'Sync.handleUpdate.fetchSessions', logError: false });
	              },
	              hydrateSessionById: (sessionId, reason) => {
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
                onSessionVisible: (sessionId) => this.onSessionVisible(sessionId),
                isSessionMessagesLoaded: (sessionId) => storage.getState().sessionMessages[sessionId]?.isLoaded === true,
                getSessionMaterializedMaxSeq: (sessionId) => this.sessionMaterializedMaxSeqById[sessionId] ?? 0,
              markSessionMaterializedMaxSeq: (sessionId, seq) => this.markSessionMaterializedMaxSeq(sessionId, seq),
              markSessionKnownRemoteSeq: (sessionId, seq) => this.markSessionKnownRemoteSeq(sessionId, seq),
              markSessionTranscriptDeferred: (sessionId, marker) => this.markSessionTranscriptDeferred(sessionId, marker),
              markSessionTranscriptStale: (sessionId, marker) => this.markSessionTranscriptStale(sessionId, marker),
              markSessionStateHydrationDeferred: (sessionId) => this.markSessionStateHydrationDeferred(sessionId),
              onReadyProjectionAdvance: (sessionId, seq, localId) => this.notifyReadyProjectionAdvance(sessionId, seq, sourceServerId, localId),
              onMessageGapDetected: (sessionId, info) => this.recoverSessionMessageGap(sessionId, info),
              assumeUsers: (userIds) => this.assumeUsers(userIds),
              applyTodoSocketUpdates: (changes) => this.applyTodoSocketUpdates(changes),
              invalidateMachines: () => this.machinesSync.invalidate(),
              invalidateSessions: () => this.sessionsSync.invalidate(),
            invalidateArtifacts: () => this.artifactsSync.invalidate(),
            invalidateFriends: () => this.friendsSync.invalidate(),
            invalidateFriendRequests: () => this.friendRequestsSync.invalidate(),
            invalidateFeed: () => this.feedSync.invalidate(),
            invalidateAutomations: () => this.automationsSync.invalidate(),
            invalidateAutomationsCoalesced: () => this.automationsSync.invalidateCoalesced(),
            invalidateTodos: () => this.todosSync.invalidate(),
            onTaskLifecycleEvent: (sessionId, event) => this.applySessionThinkingFromTaskLifecycle(sessionId, event),
            log,
        });
    }

    private flushActivityUpdates = (updates: Map<string, ApiEphemeralActivityUpdate>, options?: { sourceServerId?: string | null }) => {
        flushActivityUpdatesEngine({
            updates,
            ...options,
            applySessions: (sessions) => this.applySessions(sessions),
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

    private flushMachineActivityUpdates = (updates: Map<string, MachineActivityUpdate>, options?: { sourceServerId?: string | null }) => {
        const reachabilityBefore = new Map<string, boolean>();
        for (const machineId of updates.keys()) {
            const machine = storage.getState().machines[machineId] ?? null;
            reachabilityBefore.set(machineId, machine !== null && isMachineOnline(machine));
        }
        flushMachineActivityUpdatesEngine({
            updates,
            ...options,
            applyMachines: (machines, applyOptions) => storage.getState().applyMachines(machines, false, applyOptions),
        });
        const changedMachineIds = new Set<string>();
        for (const [machineId, wasReachable] of reachabilityBefore) {
            const machine = storage.getState().machines[machineId] ?? null;
            const isReachable = machine !== null && isMachineOnline(machine);
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
        const getSessionEncryption = this.encryption
            ? this.encryption.getSessionEncryption.bind(this.encryption)
            : (() => null);
        fireAndForget(handleEphemeralSocketUpdate({
            update,
            sourceServerId,
            shouldContinue,
            addActivityUpdate: (ephemeralUpdate) => {
                this.activityAccumulator.addUpdate(ephemeralUpdate, { shouldContinue, sourceServerId });
            },
            addMachineActivityUpdate: (machineUpdate) => {
                this.machineActivityAccumulator.addUpdate(machineUpdate, { shouldContinue, sourceServerId });
            },
            getSessionEncryption,
            getSession: (sessionId) => storage.getState().sessions[sessionId],
            applyMessages: (sessionId, messages) => this.applyMessages(sessionId, messages, { notifyVoice: false, notifyActivity: true }),
            updateExternalSessionTranscript: (ephemeralUpdate) => this.handleExternalSessionTranscriptEphemeralUpdate(
                ephemeralUpdate,
                { sourceServerId, shouldContinue },
            ),
            updateActionOperationSnapshot: accountScope && this.encryption
                ? (ephemeralUpdate) => consumeActionOperationSnapshotPush({
                    update: ephemeralUpdate,
                    accountId: accountScope.accountId,
                    sourceServerId,
                    openSnapshot: (ciphertext) => this.encryption?.openActionOperationSnapshotRaw(ciphertext) ?? null,
                    shouldContinue,
                    onSnapshot: (snapshot) => actionOperationPresentationCoordinator.observe(snapshot),
                })
                : undefined,
        }), { tag: 'Sync.handleEphemeralUpdate' });
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
        const response = await machineExternalSessionTranscriptRefreshReadAfter({
            v: 1,
            binding,
            cursor: requestCursor,
        }, { serverId: resolvedServerId });
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

    getSessionTailDiscontinuityOlderAvailability(sessionId: string): boolean | null {
        if (this.getSessionTargetWindowState(sessionId).isWindowMode) return null;
        const gap = this.sessionMessagesTailDiscontinuityBySessionId.get(sessionId);
        if (!gap) return null;
        if (gap.kind === 'opaque') return gap.walkCursor !== null;
        return this.sessionMessagesHasMoreOlderByKey.get(this.buildSessionMessagesPaginationKey({ sessionId, scope: 'main' })) ?? true;
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
    })[]) => {
        if (this.embedSessionScope) {
            if (!this.embedSessionScope.isCurrent()) return;
            const admitted = sessions.filter((session) => session.id === this.embedSessionScope?.scope.sessionId);
            for (const session of admitted) this.activeServerSessionIds.add(session.id);
            storage.getState().applySessions(admitted);
            return;
        }
        const active = storage.getState().getActiveSessions();
        const activeServerId = this.getAppliedTransportTarget()?.serverId ?? '';
        const authorityBeforeBySessionId = new Map<string, string>();
        for (const incoming of sessions) {
            const current = storage.getState().sessions[incoming.id] ?? null;
            if (!current) continue;
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
        storage.getState().applySessions(sessions);
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
        let sessionEncryption = session?.encryptionMode === 'plain'
            ? null
            : authority.context.encryption?.getSessionEncryption(input.sessionId) ?? null;
        if (!session || (session.encryptionMode !== 'plain' && !sessionEncryption)) {
            const hydration = await this.ensureSessionVisibleForMessageRoute(
                input.sessionId,
                {
                    forceRefresh: true,
                    serverId: authority.scope.serverId,
                    authority,
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
                : authority.context.encryption?.getSessionEncryption(input.sessionId) ?? null;
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
            ]);
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
    accountMode?: 'plain' | 'e2ee';
    sessionKey?: string | null;
    composerOptionsInput?: ComposerOptionsInputV1 | null;
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
    const encryption = isTokenOnlyAuthCredentials(credentials)
        ? null
        : await createEncryptionFromAuthCredentials(credentials);

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
    apiSocket.onError((error) => {
        if (!error) {
            storage.getState().setSocketError(null);
            return;
        }
        const msg = error.message || 'Connection error';
        storage.getState().setSocketError(msg);

        const classification = resolveSocketErrorClassification(error);
        const kind: 'auth' | 'config' | 'network' | 'server' | 'unknown' =
            classification.kind === 'auth' ? 'auth' : 'unknown';
        const retryable = classification.retryable;

        storage.getState().setSyncError({ message: msg, retryable, kind, at: Date.now() });
    });

    // Initialize sessions engine
    if (restore) {
        await sync.restore(credentials, encryption, target);
    } else {
        await sync.create(credentials, encryption, target);
    }
}

registerSyncRuntime({ sync, syncCreate, syncHydrateLocalState, syncRestore, syncSwitchServer });

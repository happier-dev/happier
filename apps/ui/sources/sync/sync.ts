import Constants from 'expo-constants';
import { t } from '@/text';
import {
    readExternalSessionOperationState,
    resolveAgentIdFromSessionMetadata,
} from '@happier-dev/agents';
import {
    apiSocket,
} from '@/sync/api/session/apiSocket';
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
import { ApiMessage, type ApiSessionMessagesResponse } from './api/types/apiTypes';
import type { ApiEphemeralActivityUpdate } from './api/types/apiTypes';
import {
    Session,
    Machine,
    MetadataSchema,
    type AgentState,
    type Metadata,
} from './domains/state/storageTypes';
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
import { isTransientConnectivityError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { isSocketIoAckTimeoutError } from '@/sync/runtime/socketIoAckTimeout';
import {
    loadSyncTuning,
    type SyncTuning,
} from '@/sync/runtime/syncTuning';
import {
    clearResolvedStaleTranscriptMessageIds,
    clearDeferredTranscriptStateForSession,
    createDeferredTranscriptState,
    hasStaleTranscriptMarkers,
    markDeferredTranscriptRemoteSeq,
    markTranscriptDeferred,
    markTranscriptStale,
    readDeferredTranscriptDurableSeq,
    readStaleTranscriptMessageIds,
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
import { buildSessionOrganizationProjection } from '@/sync/domains/session/organization';
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
    openTailDiscontinuityFromSnapshot,
    type SessionMessagesTailDiscontinuity,
} from '@/sync/runtime/sessionMessagesTailDiscontinuity';
import {
    createInactiveSessionMessagesWindowState,
    resetSessionMessagesWindowForLiveTail,
    resetSessionMessagesWindowForSessionSwitch,
    type SessionMessagesWindowState,
} from '@/sync/runtime/sessionMessagesWindowState';
import { ActivityUpdateAccumulator } from './reducer/activityUpdateAccumulator';
import {
    MachineActivityAccumulator,
    type MachineActivityUpdate,
} from './reducer/machineActivityAccumulator';
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
} from './typesRaw';
import {
    applySettings,
    type AccountSettingsWriteDelta,
    type Settings,
    settingsDefaults,
    settingsParse,
    SUPPORTED_SCHEMA_VERSION,
} from './domains/settings/settings';
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
    getActiveServerAccountScope,
    retireActiveServerAccountScopeLifetime,
} from './domains/scope/activeServerAccountScope';
import {
    areServerAccountScopesEqual,
    createServerAccountScope,
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
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
    scheduleWarmCacheBootHydration,
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
import { getActiveServerSnapshot } from './domains/server/serverRuntime';
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
import { config } from '@/config';
import { log } from '@/log';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { ingestWorkspaceMutationMessages } from '@/scm/refresh/workspaceMutationIngestionRuntime';
import { projectManager } from './runtime/orchestration/projectManager';
import { voiceHooks } from '@/voice/context/voiceHooks';
import { notifyActivityReady } from '@/activity/notifications/runtime/activityLocalNotificationBus';
import { Message } from './domains/messages/messageTypes';
import { isRecoveredHistoryTranscriptObservation } from './domains/messages/transcriptObservationProvenance';
import type { TranscriptOlderPageLoadResult } from './domains/messages/transcriptOlderPageLoad';
import { EncryptionCache } from './encryption/encryptionCache';
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
import { computeNextReadStateV1 } from './domains/state/readStateV1';
import { updateSessionMetadataWithRetry as updateSessionMetadataWithRetryRpc, type UpdateMetadataAck } from './domains/session/metadata/updateSessionMetadataWithRetry';
import type { ArtifactHeader, DecryptedArtifact } from './domains/artifacts/artifactTypes';
import type {
    AutomationDefinition,
    AutomationDefinitionRun,
} from './domains/automations/automationTypes';
import { getUserProfile } from './api/social/apiFriends';
import {
    cancelAutomationRun,
    clearAutomationRunHistory,
    deleteAutomationDefinition,
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
} from './api/automations/apiAutomations';
import type { AutomationEditorDraft } from './domains/automations/automationEditorDraft';
import { saveAutomationEditorDraft as saveAutomationEditorDraftOwner } from './domains/automations/automationEditorWriter';
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
import { scheduleDebouncedPendingSettingsFlush } from './engine/pending/pendingSettings';
import {
    applySettingsLocalDelta,
    syncSettings as syncSettingsEngine,
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
    clearPluginAccountAvailabilityProjection,
    replacePluginAccountAvailabilityProjection,
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
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { readStoredSessionRawRecord } from '@/sync/runtime/readStoredSessionContent';
import {
    persistSessionTranscriptMessage as persistSessionTranscriptMessageAtOwner,
    type PersistSessionTranscriptMessageInput,
} from '@/sync/domains/messages/persistSessionTranscriptMessage';
import { isVoiceTranscriptHistorySession } from '@/voice/persistence/voiceTranscriptHistorySession';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { emitSessionMetadataUpdateWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/emitSessionMetadataUpdateWithServerScope';
import { fetchSessionByIdWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope';
import {
    captureSessionRequestAuthorityForServerAccountScope,
    type ServerAccountSessionRequestAuthority,
    createSessionRequestForResolvedServerScope,
    createSessionRequestWithServerScope,
    resolveSessionRequestForServerAccountScope,
} from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';
import { resolveServerScopedSessionContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';
import { sessionRpcWithPreferredSessionScope } from '@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope';
import {
    machineExternalSessionTranscriptPage,
    machineExternalSessionTranscriptReadAfter,
    machineExternalSessionTranscriptRefreshReadAfter,
} from '@/sync/ops/machineExternalSessions';
import {
    createArtifactViaApi,
    createArtifactWithHeaderViaApi,
    fetchAndApplyArtifactsList,
    fetchArtifactWithBodyFromApi,
    handleDeleteArtifactSocketUpdate,
    handleNewArtifactSocketUpdate,
    handleUpdateArtifactSocketUpdate,
    updateArtifactViaApi,
    updateArtifactWithHeaderViaApi,
    type ArtifactDataKeyCache,
} from './engine/artifacts/syncArtifacts';
import { fetchAndApplyFeed, handleNewFeedPostUpdate, handleRelationshipUpdatedSocketUpdate, handleTodoKvBatchUpdate } from './engine/social/syncFeed';
import { fetchAndApplyFriends } from './engine/social/syncFriends';
import { fetchAndApplyProfile, handleUpdateAccountSocketUpdate, registerPushTokenIfAvailable } from './engine/account/syncAccount';
import { buildMachineFromMachineActivityEphemeralUpdate, buildUpdatedMachineFromSocketUpdate, fetchAndApplyMachines, type MachineDataKeyCacheEntry } from './engine/machines/syncMachines';
import { fetchAndApplyAutomationRuns, fetchAndApplyAutomations } from './engine/automations/syncAutomations';
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
import { planSyncActionsFromChanges } from './runtime/orchestration/changesPlanner';
import { applyPlannedChangeActions } from './runtime/orchestration/changesApplier';
import { runSocketReconnectCatchUpViaChanges } from './runtime/orchestration/socketReconnectViaChanges';
import {
    SessionDraftRuntimeHydrationGate,
    materializeSessionDraftSocketWake,
    parseSessionDraftSocketWake,
} from './runtime/orchestration/sessionDraftSyncRuntime';
import { socketEmitWithAckFallback } from './engine/socket/socketEmitWithAckFallback';
import { publishPermissionModeToMetadata as publishPermissionModeToMetadataEngine } from './state/permissionModePublish';
import { publishAcpSessionModeOverrideToMetadata as publishAcpSessionModeOverrideToMetadataEngine } from './state/acpSessionModeOverridePublish';
import { publishAcpConfigOptionOverrideToMetadata as publishAcpConfigOptionOverrideToMetadataEngine, type AcpConfigOptionOverrideValueId } from './state/acpConfigOptionOverridePublish';
import { isRpcMethodNotFoundResult, RPC_ERROR_CODES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { MessageAckResponseSchema, type MessageAckResponse } from '@happier-dev/protocol/updates';
import { isRuntimeFeatureEnabled } from '@/sync/domains/features/featureDecisionInputs';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { createApiSessionDraftsTransport } from '@/sync/api/account/apiSessionDrafts';
import { createSessionDraftCipher } from '@/sync/encryption/sessionDraftEncryption';
import {
    configureSessionDraftRepository,
    ensureSessionDraftRepositoryHydrated,
    materializeExactSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { migrateLegacySessionDrafts } from '@/sync/domains/input/drafts/sessionDraftLegacyMigration';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import {
    SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY,
    decideExternalSessionTranscriptRefreshApplicationV1,
    ExternalSessionOperationSharedPresentationV1Schema,
    ExternalSessionRefreshCursorV1Schema,
    externalSessionTranscriptRefreshBindingsEqualV1,
    readPendingLocalId,
    hasRawComposerAttachmentSelectionV1,
    SessionUserMessageSendResponseSchema,
    type ComposerContentHandleV1,
    type HappierStructuredInputV1,
    type RawIngressStructuredInputV1,
    type ExternalSessionTranscriptInvalidationV1,
    type PendingDeliveryBlockedReason,
    type PendingRequestedActionV1,
    type ExternalSessionTranscriptRawMessageV1,
    type SessionMetadataInactiveModelIntentExpectationV1,
    type AutomationV3ClearRunHistoryResponse,
    type AutomationV3Settings,
} from '@happier-dev/protocol';
import { serverFetch } from './http/client';
import {
    buildUpdatedSessionFromSocketUpdate,
    fetchAndApplySessions,
    fetchAndApplyMessages,
    fetchAndApplyNewerMessages,
    fetchAndApplyOlderMessages,
    handleDeleteSessionSocketUpdate,
    handleNewMessageSocketUpdate,
    repairInvalidReadStateV1 as repairInvalidReadStateV1Engine,
} from './engine/sessions/syncSessions';
import {
    clearTargetWindowRequestEpochs,
    fetchAndApplyTargetWindowMessages,
} from './engine/sessions/fetchAndApplyTargetWindowMessages';
import type { SessionMessagesEncryption } from './engine/sessions/sessionMessagesPagePipeline';
import { fetchUserMessageHistoryPage, type FetchUserMessageHistoryPageResult } from './engine/sessions/fetchUserMessageHistoryPage';
import {
    createSessionTranscriptRetentionController,
    type SessionTranscriptRetentionController,
} from './engine/sessions/sessionTranscriptRetention';
import { releaseTranscriptStreamSegmentAssemblyForSession } from './engine/sessions/transcriptStreamSegmentAssembly';
import {
    readMountedSessionTranscriptConsumerSessionIdsForRetention,
    subscribeSessionTranscriptConsumerReleases,
} from './runtime/sessionRealtimeTranscriptConsumers';
import { resolveSessionMessageRouteId } from './domains/messages/messageRouteIds';
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
import { getServerFeaturesSnapshot } from './api/capabilities/serverFeaturesClient';
import {
    dropSocketSessionWork,
    flushActivityUpdates as flushActivityUpdatesEngine,
    flushMachineActivityUpdates as flushMachineActivityUpdatesEngine,
    handleEphemeralSocketUpdate,
    handleSocketUpdate,
    parseUpdateContainer,
    type SocketSessionHydrationReason,
} from './engine/socket/socket';
import { isVersionSupported, MINIMUM_CLI_SESSION_USER_MESSAGE_RPC_VERSION } from '@/utils/system/versionUtils';

const SESSION_MESSAGES_PAGE_SIZE = 150;
const SESSION_LIST_BACKGROUND_HYDRATION_SCROLL_SETTLE_MS = 180;


type LoadOlderMessagesOptions = Readonly<{
    limit?: number;
    authority?: ServerAccountSessionRequestAuthority;
}>;

export type LoadTargetWindowMessagesTarget =
    | Readonly<{ kind: 'seq'; seq: number }>
    | Readonly<{ kind: 'route-message-id'; routeMessageId: string; seqHint: number }>;

export type LoadTargetWindowMessagesOptions = Readonly<{
    limit?: number;
    direction?: 'initial' | 'older' | 'newer';
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
    if (isTransientConnectivityError(error) || isSocketIoAckTimeoutError(error)) {
        return true;
    }
    // React Native's fetch boundary uses this exact TypeError before endpoint
    // supervision can turn later attempts into a named connectivity timeout.
    return error instanceof TypeError
        && error.message.trim().toLowerCase() === 'network request failed';
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
    if (error && typeof error === 'object') {
        const candidate = error as { retryable?: unknown; canTryAgain?: unknown };
        if (candidate.retryable === false) return false;
        if (candidate.canTryAgain === false) return false;
    }
    return true;
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
    if (error instanceof Error) {
        if (
            error.name === 'ServerFetchConnectivityTimeoutError'
            || error.name === 'ServerFetchAbortedForServerSwitchError'
        ) {
            return 'server_unavailable';
        }
    }
    return 'unknown';
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
    if (errorMessage === 'Method not found' || errorMessage === 'Socket connect timeout') {
        return true;
    }

    return errorMessage.toLowerCase().includes('connect_error');
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
}>): void {
    const controlTarget = readMachineControlTargetForSession(params.sessionId);
    const metadata = readSessionOwnerMetadataView(params.session);
    const machineId = normalizeNonEmptyString(controlTarget?.machineId)
        ?? normalizeNonEmptyString(metadata?.machineId);
    const directory = normalizeNonEmptyString(controlTarget?.basePath)
        ?? normalizeNonEmptyString(metadata?.path);
    if (!machineId || !directory) return;

    const resumeOptions = getPendingQueueWakeResumeOptions({
        sessionId: params.sessionId,
        session: params.session,
        resumeCapabilityOptions: { accountSettings: storage.getState().settings },
        resumeTargetOverride: { machineId, directory },
    });
    if (!resumeOptions) return;

    fireAndForget(
        ensureSessionRuntimeForPendingInput({
            ...resumeOptions,
            initialTranscriptAfterSeq: Math.max(0, params.seq - 1),
        }),
        { tag: params.tag },
    );
}

function recordTerminalAuthSyncError(
    error: unknown,
    options?: Readonly<{
        serverId?: string | null;
    }>,
): void {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const scopedServerId = String(options?.serverId ?? '').trim();
    const serverId = scopedServerId || activeServerId;
    storage.getState().setSyncError({
        message: error instanceof Error ? error.message : 'Authentication required',
        retryable: false,
        kind: 'auth',
        at: Date.now(),
        ...(serverId ? { serverId } : {}),
    });
}

function normalizeScopedServerId(value: unknown): string | undefined {
    const serverId = String(value ?? '').trim();
    return serverId || undefined;
}

function isKnownServerId(serverId: string, activeServerId: string | undefined): boolean {
    return areServerProfileIdentifiersEquivalent(serverId, activeServerId) || getServerProfileById(serverId) !== null;
}

function resolveMessageRouteHydrationServerId(sessionId: string, explicitServerIdRaw: unknown): string | undefined {
    const activeServerId = normalizeScopedServerId(getActiveServerSnapshot().serverId);
    const explicitServerId = normalizeScopedServerId(explicitServerIdRaw);
    if (explicitServerId && isKnownServerId(explicitServerId, activeServerId)) {
        return explicitServerId;
    }

    const cachedServerId = normalizeScopedServerId(resolveServerIdForSessionIdFromLocalCache(sessionId));
    if (cachedServerId && isKnownServerId(cachedServerId, activeServerId)) {
        return cachedServerId;
    }

    return activeServerId;
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

type FetchArchivedSessionsOptions = Readonly<{
    mode?: 'replace' | 'append';
}>;

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

function requireActivePendingOutboxScope(): ServerAccountScope {
    const scope = getActiveServerAccountScope();
    if (!scope) throw new Error('Pending enqueue requires an active server-account scope');
    return scope;
}

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

class Sync {

        encryption: Encryption | null = null;
        serverID!: string;
        anonID!: string;
        private credentials!: AuthCredentials;
        private pauseController = new PauseController();
        private userRequestLeaseOwner = createUserRequestLeaseOwner();
        private activeEndpointSupervisor: ManagedEndpointSupervisor | null = null;
      private syncTuning: SyncTuning = loadSyncTuning();
      private resumeInFlight: Promise<void> | null = null;
      private accountChangeWakeQueuedAfterResume = false;
      private pendingOutboxRearmInFlightByScope = new Map<string, Promise<void>>();
      private readonly usesPersistentDesktopSync = isDesktopHost();
      private isForeground = this.usesPersistentDesktopSync || AppState.currentState === 'active';
      public encryptionCache = new EncryptionCache();
      private sessionDraftSyncEnabled = false;
      private sessionDraftOfflineCatchUpPending = false;
      private sessionDraftRepositoryConfiguredScope: ServerAccountScope | null = null;
      private readonly sessionDraftRuntimeHydrationGate = new SessionDraftRuntimeHydrationGate();
    private sessionsSync: InvalidateSync;
    private fetchSessionsInFlight: {
        serverScopeGeneration: number;
        snapshotGeneration: number;
        promise: Promise<FetchSessionsResult | undefined>;
    } | null = null;
    private fetchMoreSessionsInFlight: Promise<void> | null = null;
    private sessionListNextCursor: string | null = null;
    private sessionListHasMore = false;
    private sessionListScrollActive = false;
    private sessionListScrollActiveUntilMs = 0;
    private sessionListScrollSettleTimer: ReturnType<typeof setTimeout> | null = null;
    private sessionListScrollIdleResolvers: Array<() => void> = [];
    private fetchMoreArchivedSessionsInFlight: Promise<void> | null = null;
    private archivedSessionListNextCursor: string | null = null;
    private archivedSessionListHasMore = false;
    private archivedSessionsFetchPendingUntilReady = false;
    private archivedSessionsFetchPendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
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
          request: (path, init, authority) => serverFetch(path, init, {
              includeAuth: false,
              expectedActiveServer: authority.expectedActiveServer,
          }),
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
      private externalSessionTailCursorBySessionId = new Map<string, string | null>();
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
    private readStateV1RepairAttempted = new Set<string>();
    private readStateV1RepairInFlight = new Set<string>();
    private settingsSync: InvalidateSync;
    private profileSync: InvalidateSync;
    private purchasesSync: InvalidateSync;
    private machinesSync: InvalidateSync;
    private pushTokenSync: InvalidateSync;
    private nativeUpdateSync: InvalidateSync;
    private artifactsSync: InvalidateSync;
    private friendsSync: InvalidateSync;
    private friendRequestsSync: InvalidateSync;
    private feedSync: InvalidateSync;
    private pendingMessageCommitRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private pendingOutboxOperationRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private todosSync: InvalidateSync;
    private automationsSync: InvalidateSync;
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
    private notifiedReadySeqBySessionId: Record<string, number> = {};
    private sessionMaterializedMaxSeqFlushTimer: ReturnType<typeof setTimeout> | null = null;
    private sessionMaterializedMaxSeqDirty = false;
    private nativeInactiveCheckpointTimer: ReturnType<typeof setTimeout> | null = null;
    private jsThreadLagTelemetry: JsThreadLagTelemetry | null = null;
	      private changesCursor: string | null = loadChangesCursor(String(getActiveServerSnapshot().serverId ?? '').trim() || null);
        private safeCursorLagState: SafeCursorLagTripwireState | null = null;
        private webSyncClientIdentity: WebSyncClientIdentity | null = null;
        private webSyncClientIdentityHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
        private webLifecycleHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
        private webLifecycleHeartbeatLastNowMs: number | null = null;
	      private lastSocketDisconnectedAtMs: number | null = null;
      private lastSocketOfflineDurationMs: number | null = null;
      private socketOfflineCatchUpConsumedSessionIds = new Set<string>();
      revenueCatInitialized = false;
    private settingsSecretsKey: Uint8Array | null = null;
    private settingsSecretsReadKeys: readonly Uint8Array[] = [];
    private warmCacheBootHydration: ReturnType<typeof scheduleWarmCacheBootHydration> | null = null;
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
        registerAccountSettingsDaemonSpawnPreparation(this.prepareAccountSettingsForDaemonSpawn);
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
        applyInitialAppStateConnectivityGate({
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
            const retryable = !(e instanceof HappyError && e.canTryAgain === false);
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

            this.sessionsSync = new InvalidateSync(async () => {
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
            this.artifactsSync = new InvalidateSync(this.fetchArtifactsList, { pause, backoff, shouldRetry });
            this.friendsSync = new InvalidateSync(this.fetchFriends, { pause, backoff, shouldRetry });
            this.friendRequestsSync = new InvalidateSync(this.fetchFriendRequests, { pause, backoff, shouldRetry });
            this.feedSync = new InvalidateSync(this.fetchFeed, { pause, backoff, shouldRetry });
            this.todosSync = new InvalidateSync(this.fetchTodos, { pause, backoff, shouldRetry });
            this.automationsSync = new InvalidateSync(this.fetchAutomations, { pause, backoff, shouldRetry });
            this.accountPetsSync = new InvalidateSync(this.fetchAccountPets, { pause, backoff, shouldRetry });
            this.pluginAvailabilitySync = new InvalidateSync(async () => {
                const projection = await this.pluginAvailabilityProjectionHydrator.refresh();
                if (!projection) return;
                replacePluginAccountAvailabilityProjection(projection);
            }, { onError, onSuccess, onRetry, pause, backoff, shouldRetry });

          const registerPushToken = async () => {
              if (__DEV__ && config.enableDevPushTokenRegistration !== true) {
                  return;
              }
              await this.registerPushToken();
          }
            this.pushTokenSync = new InvalidateSync(registerPushToken, { pause, backoff, shouldRetry });
            this.activityAccumulator = new ActivityUpdateAccumulator(
                this.flushActivityUpdates.bind(this),
                this.syncTuning.activityUpdateDebounceMs,
            );
            this.machineActivityAccumulator = new MachineActivityAccumulator(this.flushMachineActivityUpdates.bind(this), 300);

          // Listen for app state changes to pause sync + run a single centralized resume pipeline.
          AppState.addEventListener('change', (nextAppState) => {
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
                  try {
                      apiSocket.connect();
                  } catch {
                      // ignore
                  }
                  fireAndForget(this.resumeSync('app-foreground'), { tag: 'Sync.resumeSync.app-foreground' });
              } else {
                  this.isForeground = false;
                  this.markNativeCryptoWorkerBackgroundQuiescent();
                  log.log(`📱 App state changed to: ${nextAppState}`);
                  this.pauseController.pause();
                  const teardownConnectivity = () => {
                      setServerReachabilityNetworkAllowed(false);
                      try {
                          apiSocket.disconnect();
                      } catch {
                          // ignore
                      }
                      fireAndForget(stopServerReachabilitySupervisors(), { tag: 'Sync.stopServerReachabilitySupervisors' });
                  };
                  if (Platform.OS === 'web') {
                      this.userRequestLeaseOwner.deferRoutineTeardown(teardownConnectivity);
                  } else {
                      teardownConnectivity();
                  }
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
          if (Platform.OS === 'web' && !this.usesPersistentDesktopSync) {
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
                              apiSocket.disconnect();
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
                              apiSocket.disconnect();
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
                      try {
                          apiSocket.connect();
                      } catch {
                          // ignore
                      }
                      fireAndForget(this.resumeSync('app-foreground'), { tag });
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

	      private getMessageDecryptBatchOptions(): {
	          initialMessageDecryptBatchSize: number;
          messageDecryptBatchSize: number;
          messageDecryptYieldDelayMs: number;
      } {
          return {
              initialMessageDecryptBatchSize: this.syncTuning.initialMessageDecryptBatchSize,
              messageDecryptBatchSize: this.syncTuning.messageDecryptBatchSize,
              messageDecryptYieldDelayMs: this.syncTuning.messageDecryptYieldDelayMs,
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
          const serverId = String(getActiveServerSnapshot().serverId ?? '').trim() || null;
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

    private getActiveEndpointTarget(): { serverId: string; serverUrl: string } | null {
        const activeServer = getActiveServerSnapshot();
        const serverId = String(activeServer.serverId ?? '').trim();
        const serverUrl = String(activeServer.serverUrl ?? '').trim();
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
        const target = this.getActiveEndpointTarget();
        if (target) {
            assertServerReachabilityAuthenticated(target.serverUrl);
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
        const scope = String(serverScopeRaw ?? '').trim();
        const accountId = String(this.serverID ?? '').trim();
        if (!scope || !accountId) return null;
        const identity = this.getWebSyncClientIdentity();
        if (!identity) return { serverScope: scope, accountId };
        return { serverScope: scope, accountId, instanceId: identity.instanceId };
    }

    private getChangesCursorScope(): ChangesCursorScope | null {
        return this.buildCursorScopeForServer(String(getActiveServerSnapshot().serverId ?? '').trim());
    }

    private getExternalSessionCursorScope(sessionId: string): ChangesCursorScope | null {
        return this.buildCursorScopeForServer(this.getExternalSessionServerScope(sessionId) ?? String(getActiveServerSnapshot().serverId ?? '').trim());
    }

    private clearActiveAccountSettingsScope(): void {
        this.flushSessionMaterializedMaxSeqForCurrentScopeNow();
        this.pendingSettings = {};
        this.pendingSettingsScope = null;
        this.sessionMaterializedMaxSeqById = {};
        this.deferredTranscriptState = createDeferredTranscriptState();
        this.deferredSessionStateHydrationState = createDeferredSessionStateHydrationState();
        this.notifiedReadySeqBySessionId = {};
        storage.getState().clearSettingsScope();
        storage.getState().clearProfileScope();
        storage.getState().clearSessionLocalStateScope();
        storage.getState().resetAccountSettingsSyncStatus();
    }

    private activateAccountSettingsScope(accountId: string): AccountSettingsScope | null {
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
        const scope = createAccountSettingsScope(serverId, accountId);
        if (!scope) {
            this.clearActiveAccountSettingsScope();
            return null;
        }

        if (!areAccountSettingsScopesEqual(this.pendingSettingsScope, scope)) {
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
        storage.getState().activateSettingsScope(scope, legacyScopes);
        storage.getState().activateProfileScope(scope, legacyScopes);
        storage.getState().activateSessionLocalStateScope(scope);
        this.pendingSettings = loadPendingAccountSettings(scope);
        this.pendingSettingsScope = scope;
        this.sessionMaterializedMaxSeqById = loadSessionMaterializedMaxSeqById(scope);
        this.deferredTranscriptState = createDeferredTranscriptState();
        this.deferredSessionStateHydrationState = createDeferredSessionStateHydrationState();
        this.notifiedReadySeqBySessionId = {};
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

    private activateAccountSettingsScopeForCredentials(credentials: AuthCredentials): AccountSettingsScope | null {
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
            delayMs: 900,
        });
    };

    async create(credentials: AuthCredentials, encryption: Encryption | null) {
        const accountId = this.parseAccountIdForSettingsScope(credentials, 'create');
        if (!accountId) throw new Error('Invalid auth token');
        if (encryption) {
            this.configureEncryptionRuntime(encryption, accountId);
        }
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption?.anonID ?? '';
        this.serverID = accountId;
        if (this.anonID) {
            initializeTracking(this.anonID);
        }
        setWarmCacheAccountScope(this.serverID);
        const settingsScope = this.activateAccountSettingsScope(accountId);
        this.changesCursor = loadChangesCursor(this.getChangesCursorScope());
        await this.configureSettingsSecretKeys(credentials, settingsScope);
        this.scheduleWarmCachesHydrationForActiveServerBoot();
        this.syncJsThreadLagTelemetryRuntime();
        await this.#init();
        this.drainArchivedSessionsFetchPendingUntilReady();

        // UX: avoid blocking login forever if initial sync fetches hang/retry indefinitely.
        // We still kick off the sync work in #init(); this just bounds the time we block the login call.
        const initialAwaitTimeoutMs = 2500;
        await Promise.all([
            this.settingsSync.awaitQueue({ timeoutMs: initialAwaitTimeoutMs }),
            this.profileSync.awaitQueue({ timeoutMs: initialAwaitTimeoutMs }),
            this.purchasesSync.awaitQueue({ timeoutMs: initialAwaitTimeoutMs }),
        ]);
    }

    async restore(credentials: AuthCredentials, encryption: Encryption | null) {
        const accountId = this.parseAccountIdForSettingsScope(credentials, 'restore');
        if (!accountId) throw new Error('Invalid auth token');
        // NOTE: No awaiting anything here, we're restoring from a disk (ie app restarted)
        // Purchases sync is invalidated in #init() and will complete asynchronously
        if (encryption) {
            this.configureEncryptionRuntime(encryption, accountId);
        }
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption?.anonID ?? '';
        this.serverID = accountId;
        if (this.anonID) {
            initializeTracking(this.anonID);
        }
        setWarmCacheAccountScope(this.serverID);
        const settingsScope = this.activateAccountSettingsScope(accountId);
        this.changesCursor = loadChangesCursor(this.getChangesCursorScope());
        await this.configureSettingsSecretKeys(credentials, settingsScope);
        this.scheduleWarmCachesHydrationForActiveServerBoot();
        this.syncJsThreadLagTelemetryRuntime();
        await this.#init();
        this.drainArchivedSessionsFetchPendingUntilReady();
    }

    private scheduleWarmCachesHydrationForActiveServerBoot(): void {
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
        const accountId = resolveWarmCacheAccountScope(loadPersistedProfile().id);
        if (!serverId || !accountId) return;
        const generation = this.serverScopeGeneration;
        this.warmCacheBootHydration?.cancel();
        const scheduled = scheduleWarmCacheBootHydration(() => {
            if (this.serverScopeGeneration !== generation) return;
            this.hydrateWarmCachesForActiveServer({
                serverId,
                accountId,
                preserveFetchedState: true,
            });
        });
        this.warmCacheBootHydration = scheduled;
        void scheduled.done.finally(() => {
            if (this.warmCacheBootHydration === scheduled) {
                this.warmCacheBootHydration = null;
            }
        });
    }

    private hydrateWarmCachesForActiveServer(options?: Readonly<{
        serverId?: string;
        accountId?: string;
        preserveFetchedState?: boolean;
    }>): void {
        const serverId = options?.serverId ?? String(getActiveServerSnapshot().serverId ?? '').trim();
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
                && Object.keys(storage.getState().sessionListRenderables).length === 0
            );
        if (shouldHydrateSessionList) {
            const sessionEntries = loadSessionListWarmCacheEntries(serverId, accountId);
            if (Object.keys(sessionEntries).length > 0) {
                storage.getState().replaceSessionListRenderables(
                    Object.values(sessionEntries).map((entry) => buildSessionListRenderableFromCacheEntry(entry)),
                );
            }
        }
    }

    public reconfigureSessionDraftRepositoryForAccountMode(
        credentials: AuthCredentials,
        accountMode: 'plain' | 'e2ee',
    ): void {
        const scope = getActiveServerAccountScope();
        if (!scope || credentials.token !== this.credentials?.token) {
            throw new Error('Session draft repository scope is unavailable');
        }
        configureSessionDraftRepository({
            transport: this.sessionDraftSyncEnabled
                ? createApiSessionDraftsTransport({ credentials })
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
                    const syncEnabled = await isRuntimeFeatureEnabled({
                        featureId: 'sessions.drafts',
                        serverId: capturedScope.serverId,
                    });
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

    private resetServerScopedRuntimeState = () => {
        this.sessionDraftSyncEnabled = false;
        this.sessionDraftOfflineCatchUpPending = false;
        this.sessionDraftRepositoryConfiguredScope = null;
        this.sessionDraftRuntimeHydrationGate.reset();
        configureSessionDraftRepository({ syncEnabled: false });
        // The UI-sync generation fence is the sole shared Account retirement
        // boundary. Consumers receive synchronous owner-local cancellation
        // before this reset continues, while no consumer cleanup is awaited.
        this.accountChangeWakeQueuedAfterResume = false;
        this.pluginAvailabilityProjectionHydrator.reset();
        clearPluginAccountAvailabilityProjection();
        retireActiveServerAccountScopeLifetime();
        this.stopJsThreadLagTelemetryRuntime();
        this.serverScopeGeneration += 1;
        this.warmCacheBootHydration?.cancel();
        this.warmCacheBootHydration = null;
        this.flushPendingSettingsForCurrentScopeNow();
        this.clearActiveAccountSettingsScope();
        this.userRequestLeaseOwner.crossHardBoundary(() => apiSocket.disconnect());
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
            storage.getState().setSessionTailContiguousFloorSeq(sessionId, null);
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
        this.externalSessionTailCursorBySessionId.clear();
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
        this.clearSessionListScrollActivity();
        this.fetchMoreArchivedSessionsInFlight = null;
        this.archivedSessionListNextCursor = null;
        this.archivedSessionListHasMore = false;
        this.sessionDataKeys.clear();
        this.sessionDataKeyEnvelopes.clear();
        this.machineDataKeys.clear();
        this.artifactDataKeys.clear();
        this.readStateV1RepairAttempted.clear();
        this.readStateV1RepairInFlight.clear();

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

        storage.setState((state) => ({
            ...state,
            profile: { ...profileDefaults },
            sessions: {},
            sessionListRenderables: {},
            concurrentSessionListCacheByServerId: (() => {
                const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
                if (!activeServerId) return state.concurrentSessionListCacheByServerId;
                if (!(activeServerId in state.concurrentSessionListCacheByServerId)) return state.concurrentSessionListCacheByServerId;
                const next = { ...state.concurrentSessionListCacheByServerId };
                delete next[activeServerId];
                return next;
            })(),
            sessionListRowStateByServerId: (() => {
                const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
                const previous = state.sessionListRowStateByServerId ?? {};
                if (!activeServerId) return previous;
                if (!(activeServerId in previous)) return previous;
                const { [activeServerId]: _, ...rest } = previous;
                return rest;
            })(),
            sessionListIndexByServerId: (() => {
                const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
                const previous = state.sessionListIndexByServerId ?? {};
                if (!activeServerId) return previous;
                if (!(activeServerId in previous)) return previous;
                const { [activeServerId]: _, ...rest } = previous;
                return rest;
            })(),
            machineListByServerId: (() => {
                const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
                if (!activeServerId) return state.machineListByServerId;
                if (!(activeServerId in state.machineListByServerId)) return state.machineListByServerId;
                const next = { ...state.machineListByServerId };
                delete next[activeServerId];
                return next;
            })(),
            machineListStatusByServerId: (() => {
                const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
                if (!activeServerId) return state.machineListStatusByServerId;
                if (!(activeServerId in state.machineListStatusByServerId)) return state.machineListStatusByServerId;
                const next = { ...state.machineListStatusByServerId };
                delete next[activeServerId];
                return next;
            })(),
            sessionScmStatus: {},
            machines: {},
            machineDisplayById: {},
            sessionMessages: {},
            sessionPending: {},
            artifacts: {},
            automations: {},
            automationRunsByAutomationId: {},
            automationRunNextCursorByAutomationId: {},
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

    public async switchServer(credentials: AuthCredentials): Promise<void> {
        const encryption = isTokenOnlyAuthCredentials(credentials)
            ? null
            : await createEncryptionFromAuthCredentials(credentials);

        this.resetServerScopedRuntimeState();
        apiSocket.initialize({ endpoint: getActiveServerSnapshot().serverUrl, token: credentials.token }, encryption);
        await this.restore(credentials, encryption);
    }

    public disconnectServer(): void {
        this.resetServerScopedRuntimeState();
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
        if (tracking) {
            const currentSettings = storage.getState().settings;
            if (currentSettings.analyticsOptOut) {
                tracking.optOut();
            } else {
                tracking.optIn();
            }
        }
        applyCrashReportsOptOut(storage.getState().settings.crashReportsOptOut);

        // Initial bootstrap sync is orchestrated to avoid request storms.
        fireAndForget(this.bootstrapSync(), { tag: 'Sync.bootstrapSync' });
    }


        onSessionVisible = (sessionId: string) => {
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
            this.getOrCreateMessagesSync(sessionId).invalidateCoalesced();

            // C6/D3: reopening a session is a reactive, list-independent bottom arrival. Drain any
            // deferred-newer backlog here so newer-message catch-up never stalls waiting for a
            // ChatList scroll event.
            this.maybeDrainDeferredNewerMessages(sessionId, { isPinned: true, distanceFromBottomPx: 0 });

            // Notify voice assistant about session visibility
            const session = storage.getState().sessions[sessionId];
            if (session) {
                voiceHooks.onSessionFocus(
                    sessionId,
                    readSessionOwnerMetadataView(session) ?? undefined,
                );
        }
    }

        refreshSessionMessages = async (
            sessionId: string,
            options?: Readonly<{ authority?: ServerAccountSessionRequestAuthority }>,
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
                            storage.getState().applyMessagesLoaded(sid);
                        }
                    },
                    onMessagesPage: (page) => {
                        if (isCurrent()) {
                            this.updateSessionMessagesPaginationFromPage(
                                normalized,
                                { scope: 'main' },
                                page,
                                { allowHasMoreInference: true },
                            );
                        }
                    },
                    ...this.getMessageDecryptBatchOptions(),
                    log,
                });
                return;
            }
            await this.getOrCreateMessagesSync(normalized).invalidateAndAwait();
        }

        refreshSessionForSubmit = async (
            sessionId: string,
            options?: Readonly<{ serverId?: string | null }>,
        ): Promise<Session | null> => {
            const normalized = String(sessionId ?? '').trim();
            if (!normalized) return null;
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
            const activeServer = getActiveServerSnapshot();
            const scope = getActiveServerAccountScope();
            const credentials = this.credentials;
            const encryption = this.encryption;
            if (
                !scope
                || !credentials
                || scope.accountId !== this.serverID
                || !areServerProfileIdentifiersEquivalent(scope.serverId, activeServer.serverId)
            ) {
                throw new Error('Hosted system session requires an initialized account scope');
            }
            const authority = await captureSessionRequestAuthorityForServerAccountScope({
                scope,
                activeRequest: (path, init) => apiSocket.request(path, init),
            });
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
        };

        ensureSessionVisibleForMessageRoute = async (
            sessionId: string,
            options?: Readonly<{
                forceRefresh?: boolean;
                serverId?: string;
                includeTurnsProjection?: boolean;
                authority?: ServerAccountSessionRequestAuthority;
            }>,
        ): Promise<EnsureSessionVisibleForRouteResult> => {
            const normalized = String(sessionId ?? '').trim();
            if (!normalized) return createMissingSessionRouteResult('', undefined, 'not_found');
            const forceRefresh = options?.forceRefresh === true;

            const DEBUG_SESSION_HYDRATE =
                typeof globalThis !== 'undefined'
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
            const preferredServerId = resolveMessageRouteHydrationServerId(normalized, options?.serverId);
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
            const prefersActiveServer = !preferredServerId || areServerProfileIdentifiersEquivalent(preferredServerId, activeServerId);

            // Fast-path when we already know the session exists on this server and the stored record is
            // already authoritatively hydrated (deep links can occur before the sessions snapshot bootstraps).
            const existingSession = storage.getState().sessions[normalized];
            if (!forceRefresh && prefersActiveServer && this.isSessionKnownOnActiveServer(normalized) && existingSession) {
                const encryptionMode: 'e2ee' | 'plain' = existingSession.encryptionMode === 'plain' ? 'plain' : 'e2ee';
                const hasEncryption = encryptionMode === 'plain'
                    ? false
                    : Boolean(this.encryption?.getSessionEncryption(normalized));
                const hasAuthoritativeSessionRouteState = hasAuthoritativeSessionRouteData(existingSession);
                if (DEBUG_SESSION_HYDRATE) {
                    log.log(`[sessionHydrate] fast-path check ${normalized} mode=${encryptionMode} hasEncryption=${hasEncryption} hasRouteState=${hasAuthoritativeSessionRouteState}`);
                }
                if (hasAuthoritativeSessionRouteState && (encryptionMode === 'plain' || hasEncryption)) {
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
            const existing = this.sessionByIdHydrationInFlight.get(inFlightKey);
            if (existing) {
                if (DEBUG_SESSION_HYDRATE) {
                    log.log(`[sessionHydrate] awaiting in-flight hydration for ${normalized}`);
                }
                return await existing.promise;
            }

            let hydrationCurrent = true;
            const isHydrationCurrent = (): boolean => (
                hydrationCurrent
                && (
                    !options?.authority
                    || this.isServerAccountSessionAuthorityCurrent(options.authority)
                )
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
                        activeEncryption: this.encryption,
                        sessionDataKeys: this.sessionDataKeys,
                        sessionDataKeyEnvelopes: this.sessionDataKeyEnvelopes,
                        activeRequest: (path, init) => apiSocket.request(path, init),
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
                            return createMissingSessionRouteResult(normalized, preferredServerId, missingCause);
                        }
                        return createRetryableSessionRouteResult(
                            normalized,
                            preferredServerId,
                            readRetryableSessionRouteCause(code),
                        );
                    }

                    // Ensure the *current* encryption instance is initialized for this session.
                    // During app bootstrap / key restoration, the sync encryption instance can change while
                    // the session-by-id hydration request is in-flight. Re-initializing here ensures
                    // subsequent message fetches can proceed immediately.
                    if (
                        !isHydrationCurrent()
                    ) {
                        return createRetryableSessionRouteResult(
                            normalized,
                            preferredServerId,
                            'unknown',
                        );
                    }
                    const hydratedSessionEncryptionMode = result.session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
                    const hydratedServerId = String(result.session?.serverId ?? '').trim();
                    if (hydratedSessionEncryptionMode === 'e2ee' && this.encryption) {
                        const sessionDataKey = this.sessionDataKeys.get(normalized) ?? null;
                        const sessionScope = hydratedServerId
                            ? { serverId: hydratedServerId }
                            : undefined;
                        await this.encryption.initializeSessions(
                            new Map([[normalized, sessionDataKey]]),
                            {
                                ...sessionScope,
                                shouldContinue: isHydrationCurrent,
                            },
                        );
                        if (
                            !isHydrationCurrent()
                        ) {
                            return createRetryableSessionRouteResult(
                                normalized,
                                preferredServerId,
                                'unknown',
                            );
                        }
                    }

                    if (!hydratedServerId || areServerProfileIdentifiersEquivalent(hydratedServerId, activeServerId)) {
                        this.activeServerSessionIds.add(normalized);
                    }
                    if (DEBUG_SESSION_HYDRATE) {
                        const hasEncryption = hydratedSessionEncryptionMode === 'plain'
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
                        recordTerminalAuthSyncError(err, { serverId: preferredServerId });
                        return createMissingSessionRouteResult(normalized, preferredServerId, 'unauthorized');
                    }
                    log.log(`⚠️ ensureSessionVisibleForMessageRoute failed for ${normalized}: ${err instanceof Error ? err.message : 'unknown error'}`);
                    return createRetryableSessionRouteResult(
                        normalized,
                        preferredServerId,
                        classifyRouteHydrationErrorCause(err),
                    );
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
            if (result.kind === 'available' && !options?.authority) {
                this.getOrCreateMessagesSync(normalized).invalidateCoalesced();
            }
            return result;
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

    private invalidateDeletedSessionHydration = (sessionId: string): void => {
        this.invalidateSessionByIdHydration(sessionId);
        this.sessionListSnapshotGeneration += 1;
        this.fetchSessionsInFlight = null;
        this.sessionsSync.invalidate();
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
        }>
    ): Promise<DirectMessageSubmitResult> {
        let session = storage.getState().sessions[sessionId] ?? null;
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

        try {
            const publishNextPromptPermissionModeIfNeeded = async (): Promise<void> => {
                const settingsApplyTiming = storage.getState().settings.sessionPermissionModeApplyTiming ?? 'immediate';
                if (settingsApplyTiming !== 'next_prompt') {
                    return;
                }

                const latestSession = storage.getState().sessions[sessionId] ?? null;
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
                    });
                } catch {
                    // Best-effort only: sending messages must not fail due to metadata publish failures.
                }
            };

            // Read permission mode from session state
            const permissionMode = session.permissionMode || 'default';
            
            // Read model mode - default is agent-specific (Gemini needs an explicit default)
            const agentId = resolveAgentIdFromSessionMetadata(readSessionOwnerMetadataView(session));
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
            });
            const selectedComposerAttachment = hasRawComposerAttachmentSelectionV1(content.meta);

            const messagePayload =
                sessionEncryptionMode === 'plain'
                    ? { t: 'plain' as const, v: content }
                    : await (async () => {
                        const encryption = this.encryption?.getSessionEncryption(sessionId);
                        if (!encryption) {
                            throw new Error(`Session ${sessionId} encryption not found`);
                        }
                        return await encryption.encryptRawRecord(content);
                    })();

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
                                    hostAdmissionOrigin: options?.hostAdmissionOrigin,
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
                    await this.assertActiveEndpointAuthenticated();
                    return await socketEmitWithAckFallback<MessageAckResponse>({
                        emitWithAck: (event, payload, opts) =>
                            this.messageTransport.emitWithAck<MessageAckResponse>(event, payload, opts),
                        send: (event, payload) => this.messageTransport.send(event, payload),
                        event: 'message',
                        payload,
                        timeoutMs: this.syncTuning.socketAckTimeoutMs,
                        onNoAck: () => this.schedulePendingMessageCommitRetry({ sessionId, localId }),
                        beforeFallback: () => this.assertActiveEndpointAuthenticated({ forceProbe: true }),
                    });
                } catch (error) {
                    if (this.keepPendingMessageForRetryableCommitFailure({ sessionId, localId, error })) {
                        return null;
                    }
                    storage.getState().removePendingMessage(sessionId, localId);
                    throw error;
                }
            })();

            if (!rawAck) {
                storage.getState().clearSessionOptimisticThinking(sessionId);
                return { localId, persistence: 'pending' };
            }

            const parsedAck = MessageAckResponseSchema.safeParse(rawAck);
            if (!parsedAck.success) {
                // Treat malformed ACKs as "no ACK": keep the pending bubble and retry later.
                this.schedulePendingMessageCommitRetry({ sessionId, localId });
                return { localId, persistence: 'pending' };
            }

            const ack = parsedAck.data;

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

            if (session.active !== true || runtimeRpcFallbackRequiresEnsure) {
                ensureSessionRuntimeAfterCommittedPrompt({
                    sessionId,
                    session,
                    seq: ack.seq,
                    tag: 'Sync.sendMessage.wakeAfterSend',
                });
            }

	            // Server ACK means the user message is committed (or idempotently confirmed).
	            // Do NOT clear optimistic thinking here: the agent can still be mid-turn (streaming / tool calls).
            // We clear optimistic thinking only when we see a terminal lifecycle marker (task_complete / turn_aborted),
            // when the session enters a permission/action-required gate, when the session is marked thinking by live
            // activity updates, or when the optimistic timeout expires.
            return { localId, seq: ack.seq, persistence: 'transcript_committed' };
        } catch (e) {
            if (isTerminalAuthError(e)) {
                recordTerminalAuthSyncError(e);
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
    }): Promise<SendPendingMessageNowResult> {
        const session = storage.getState().sessions[sessionId];
        if (!session) {
            storage.getState().clearSessionOptimisticThinking(sessionId);
            throw new Error(`Session ${sessionId} not found in storage`);
        }

        assertPendingMessageProjectionTransportableV2(sessionId, pending.localId);

        const deliveryIntent = pending.deliveryIntent ?? 'interrupt_and_send';
        this.markSessionLiveTailIntent(sessionId);
        storage.getState().markSessionOptimisticThinking(sessionId);

        try {
            const state = storage.getState();
            const result = await submitSessionUserMessage(this.createSessionSubmitPort(), {
                sessionId,
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
                storage.getState().clearSessionOptimisticThinking(sessionId);
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
                await this.fetchPendingMessages(sessionId).catch(() => {});
            }
            if (isTerminalAuthError(e)) {
                recordTerminalAuthSyncError(e);
            }
            storage.getState().clearSessionOptimisticThinking(sessionId);
            throw e;
        }
    }

    private schedulePendingMessageCommitRetry(params: { sessionId: string; localId: string }): void {
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
            const pendingState = storage.getState().sessionPending[params.sessionId];
            const pending = pendingState?.messages?.find((m) => m.id === params.localId) ?? null;
            if (!pending) {
                clearRetry();
                return;
            }

            const scheduleRetryWithBackoff = () => {
                fireAndForget(this.fetchSessions(), { tag: 'Sync.pendingMessageCommitRetry.fetchSessions' });

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
                    return await this.messageTransport.emitWithAck<MessageAckResponse>('message', payload, {
                        timeoutMs: this.syncTuning.socketAckTimeoutMs,
                    });
                } catch (error) {
                    let terminalError = error;
                    if (!isTerminalAuthError(terminalError)) {
                        try {
                            await this.assertActiveEndpointAuthenticated({ forceProbe: true });
                        } catch (probeError) {
                            terminalError = probeError;
                        }
                    }
                    if (isTerminalAuthError(terminalError)) {
                        terminalAuthFailure = true;
                        recordTerminalAuthSyncError(terminalError);
                        storage.getState().removePendingMessage(params.sessionId, params.localId);
                        storage.getState().clearSessionOptimisticThinking(params.sessionId);
                        clearRetry();
                    }
                    return null;
                }
            })();
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

        const markSendFailed = (): void => {
            setPendingMessageSendState(params.sessionId, params.localId, 'failed', params.outboxScope);
        };

        const scheduleRetryWithBackoff = (attempt: number): void => {
            const nextAttempt = attempt + 1;
            if (nextAttempt >= 6) {
                markSendFailed();
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
            try {
                const request = await resolveSessionRequestForServerAccountScope({
                    scope: params.outboxScope,
                    activeRequest: this.createSessionRequest(params.sessionId),
                });
                const serverWireMode = resolvePendingInputServerWireMode(
                    await getServerFeaturesSnapshot({ serverId: params.outboxScope.serverId }),
                );
                const result = await retryPendingOutboxOperationV2({
                    sessionId: params.sessionId,
                    localId: params.localId,
                    request,
                    outboxScope: params.outboxScope,
                    serverWireMode,
                });
                if (result.accepted) {
                    clearRetry();
                    return;
                }
                if (!shouldSchedulePendingOutboxTransportRetry(serverWireMode)) {
                    clearRetry();
                    return;
                }
                scheduleRetryWithBackoff(attempt);
            } catch (error) {
                if (isTerminalAuthError(error)) {
                    recordTerminalAuthSyncError(error);
                }
                markSendFailed();
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
    ): Promise<void> {
        assertValidPendingMessageId(localId);
        const { outboxScope, request } = await this.resolvePendingQueueOwnerContext(sessionId);
        await updatePendingRequestedActionV2({
            sessionId,
            localId,
            requestedAction,
            request,
            outboxScope,
        });
    }

    isSessionTargetRemoteToActiveServer(sessionId: string): boolean {
        const preferredServerId = resolvePreferredServerIdForSessionId(sessionId);
        const activeServerId = getActiveServerSnapshot().serverId;
        return Boolean(preferredServerId && !areServerProfileIdentifiersEquivalent(preferredServerId, activeServerId));
    }

    private createSessionSubmitPort(): SessionSubmitPort {
        const canWakeMachineId = (machineId: string): boolean => {
            const machine = storage.getState().machines[machineId];
            if (machine?.storageMode === 'plain') return true;
            return Boolean(this.encryption?.getMachineEncryption(machineId));
        };

        return {
            enqueuePendingMessage: (targetSessionId, targetText, targetDisplayText, targetMetaOverrides, options) =>
                this.enqueuePendingMessage(targetSessionId, targetText, targetDisplayText, targetMetaOverrides, options),
            sendMessage: (targetSessionId, targetText, targetDisplayText, targetMetaOverrides, options) =>
                this.sendMessage(targetSessionId, targetText, targetDisplayText, targetMetaOverrides, options),
            abortSession: (targetSessionId) => this.abortSession(targetSessionId),
            updatePendingRequestedAction: (targetSessionId, localId, requestedAction) =>
                this.updatePendingRequestedAction(targetSessionId, localId, requestedAction),
            ensureSessionRuntimeForPendingInput: (options) => ensureSessionRuntimeForPendingInput(options),
            refreshSessionForSubmit: (targetSessionId, options) =>
                this.refreshSessionForSubmit(targetSessionId, options),
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
            callerSurface?: SessionMessageCallerSurface | null;
            forceImmediate?: boolean;
            hostAdmissionOrigin?: SessionMessageHostAdmissionOrigin;
            onOutboundHandoff?: (handoff: SubmitSessionOutboundHandoff) => void;
        }>,
    ): Promise<void> {
        let state = storage.getState();
        let session = state.sessions[sessionId] ?? null;
        if (!session) {
            try {
                await this.ensureSessionVisibleForMessageRoute(sessionId, { forceRefresh: true });
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
            session,
            text,
            displayText,
            metaOverrides,
            configuredMode: state.settings.sessionMessageSendMode,
            busySteerSendPolicy: state.settings.sessionBusySteerSendPolicy,
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
        updater: (metadata: Metadata) => Metadata,
        options?: Readonly<{
            serverId?: string | null;
            maxAttempts?: number;
            sessionExpectation?:
                SessionMetadataInactiveModelIntentExpectationV1;
        }>,
    ): Promise<void> {
        const resolvedServerIdOverride =
            typeof options?.serverId === 'string' && options.serverId.trim().length > 0
                ? options.serverId.trim()
                : null;

        const fetchLatestSession = async (
            includeMetadataTupleMutationSnapshot = false,
        ) => {
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
                activeRequest: (path, init) => apiSocket.request(path, init),
                applySessions: (sessions) => this.applySessions(sessions),
                getExistingSession: (targetSessionId) => storage.getState().sessions[targetSessionId] ?? null,
                log,
                includeTurnsProjection: false,
                includeMetadataTupleMutationSnapshot,
            });
        };

        const resolvePatchContext = () => {
            const session = storage.getState().sessions[sessionId] ?? null;
            const sessionEncryptionMode: 'e2ee' | 'plain' = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
            const encryption = sessionEncryptionMode === 'plain' ? null : this.encryption?.getSessionEncryption(sessionId);
            return { session, sessionEncryptionMode, encryption };
        };

        let prefetchedTupleRead: Awaited<
            ReturnType<typeof fetchSessionByIdWithServerScope>
        > | undefined;
        let patchContext = resolvePatchContext();
        if (!patchContext.session?.metadata || (patchContext.sessionEncryptionMode === 'e2ee' && !patchContext.encryption)) {
            prefetchedTupleRead = await fetchLatestSession(true);
            patchContext = resolvePatchContext();
        }

        if (patchContext.sessionEncryptionMode === 'e2ee' && !patchContext.encryption) {
            throw new Error(`Session ${sessionId} not found`);
        }

        const tupleWriterContextRef: {
            current: Awaited<
            ReturnType<typeof fetchSessionByIdWithServerScope>
            >['metadataTupleWriterContext'];
        } = { current: undefined };
        const acquireTupleSnapshot = async () => {
            const result = prefetchedTupleRead
                ?? await fetchLatestSession(true);
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

        await updateSessionMetadataWithRetryRpc<Metadata, AgentState>({
            sessionId,
            metadataLayoutVersion:
                patchContext.session?.metadataLayoutVersion ?? 0,
            getSession: () => {
                const s = storage.getState().sessions[sessionId];
                if (!s?.metadata) return null;
                const metadata = (s.metadataLayoutVersion ?? 0) === 1
                    ? s.ownerMetadataView ?? s.metadata
                    : s.metadata;
                return {
                    metadataLayoutVersion: s.metadataLayoutVersion ?? 0,
                    metadataVersion: s.metadataVersion,
                    metadata,
                };
            },
            refreshSessions: async () => {
                await fetchLatestSession();
                patchContext = resolvePatchContext();
            },
            encryptMetadata: async (metadata) => {
                if (patchContext.sessionEncryptionMode === 'plain') {
                    return JSON.stringify(metadata);
                }
                if (!patchContext.encryption) {
                    throw new Error(`Session ${sessionId} not found`);
                }
                return await patchContext.encryption.encryptMetadata(
                    metadata,
                );
            },
            decryptMetadata: async (version, encrypted) => {
                if (patchContext.sessionEncryptionMode !== 'plain') {
                    if (!patchContext.encryption) {
                        throw new Error(`Session ${sessionId} not found`);
                    }
                    return await patchContext.encryption.decryptMetadata(
                        version,
                        encrypted,
                    );
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
                const scope = resolvedServerIdOverride
                    ? { serverId: resolvedServerIdOverride }
                    : {};
                return 'sid' in payload
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
                    })
                    : await emitSessionMetadataUpdateWithServerScope({
                        sessionId,
                        patch: payload,
                        ...scope,
                    });
            },
            applySessionMetadata: ({ metadataVersion, metadata }) => {
                const currentSession =
                    storage.getState().sessions[sessionId];
                if (!currentSession) {
                    return;
                }
                this.applySessions([{
                    ...currentSession,
                    metadata,
                    metadataVersion,
                    metadataLayoutVersion: 0,
                }]);
            },
            acquireTupleSnapshot,
            tupleCrypto: {
                encryptPayload: async (payload) => {
                    if (!tupleWriterContextRef.current) {
                        throw new Error(
                            `Session metadata writer context not found for ${sessionId}`,
                        );
                    }
                    return await tupleWriterContextRef.current
                        .encryptPayload(payload);
                },
                encodeOwnerMetadata: (ownerMetadata) => {
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
                const currentSession =
                    storage.getState().sessions[sessionId];
                if (!currentSession) {
                    return;
                }
                const {
                    ownerMetadata: _obsoleteOwnerMetadata,
                    ...ordinarySession
                } = currentSession as Session & {
                    ownerMetadata?: unknown;
                };
                this.applySessions([{
                    ...ordinarySession,
                    metadata:
                        next.value.sharedMetadata as unknown as Metadata,
                    metadataVersion: next.metadataVersion,
                    metadataLayoutVersion: 1,
                    ...(next.mode === 'owner'
                        ? {
                            ownerMetadataView: next.value.metadata,
                            agentState: next.value.agentState,
                            agentStateVersion: next.agentStateVersion,
                        }
                        : {}),
                }]);
            },
            updater,
            sessionExpectation: options?.sessionExpectation,
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
        this.applySessions([{
            ...latestSession,
            ...((latestSession.metadataLayoutVersion ?? 0) === 1
                ? { ownerMetadataView: nextMetadata }
                : { metadata: nextMetadata }),
        }]);
    }

    private repairInvalidReadStateV1 = async (params: { sessionId: string; sessionSeqUpperBound: number }): Promise<void> => {
        await repairInvalidReadStateV1Engine({
            sessionId: params.sessionId,
            sessionSeqUpperBound: params.sessionSeqUpperBound,
            attempted: this.readStateV1RepairAttempted,
            inFlight: this.readStateV1RepairInFlight,
            getSession: (sessionId) => storage.getState().sessions[sessionId],
            updateSessionMetadataWithRetry: (sessionId, updater) => this.updateSessionMetadataWithRetry(sessionId, updater),
            now: nowServerMs,
        });
    }

    private applyLocalReadCursor(sessionId: string, lastViewedSessionSeq: number): void {
        const session = storage.getState().sessions[sessionId];
        if (!session) return;

        const nextViewedSeq = Math.max(0, Math.trunc(lastViewedSessionSeq));
        const existingViewedSeq =
            typeof session.lastViewedSessionSeq === 'number' && Number.isFinite(session.lastViewedSessionSeq)
                ? Math.max(0, Math.trunc(session.lastViewedSessionSeq))
                : 0;
        const effectiveViewedSeq = Math.max(existingViewedSeq, nextViewedSeq);
        if (session.lastViewedSessionSeq === effectiveViewedSeq) return;

        storage.getState().applySessions([{
            ...session,
            lastViewedSessionSeq: effectiveViewedSeq,
        }]);
    }

    async markSessionViewed(sessionId: string, opts?: { sessionSeq?: number; pendingActivityAt?: number }): Promise<void> {
        const session = storage.getState().sessions[sessionId];
        if (!session) return;

        const sessionSeq = opts?.sessionSeq ?? session.seq ?? 0;
        // Pending queue does not affect unread; keep pendingActivityAt at 0 for backwards compatibility.
        const pendingActivityAt = 0;
        const ownerMetadata = readSessionOwnerMetadataView(session);
        const existing = ownerMetadata?.readStateV1;
        const existingSeq = existing?.sessionSeq ?? 0;
        const needsRepair = existingSeq > sessionSeq;
        const existingAuthoritativeSeq =
            typeof session.lastViewedSessionSeq === 'number' && Number.isFinite(session.lastViewedSessionSeq)
                ? Math.max(0, Math.trunc(session.lastViewedSessionSeq))
                : 0;
        const nextAuthoritativeSeq = Math.max(existingAuthoritativeSeq, sessionSeq);
        const nextDirectAttentionMetadata =
            ownerMetadata && readExternalSessionLink(ownerMetadata)
                ? updateMetadataWithViewedExternalSessionProgress(ownerMetadata)
                : ownerMetadata;
        const shouldPublishDirectAttention = Boolean(
            ownerMetadata
            && nextDirectAttentionMetadata
            && nextDirectAttentionMetadata !== ownerMetadata,
        );

        const early = computeNextReadStateV1({
            prev: existing,
            sessionSeq,
            pendingActivityAt,
            now: nowServerMs(),
        });

        const shouldPublishReadCursor = nextAuthoritativeSeq > existingAuthoritativeSeq;
        if (!needsRepair && !early.didChange && !shouldPublishReadCursor && !shouldPublishDirectAttention) return;

        if (shouldPublishReadCursor) {
            this.applyLocalReadCursor(sessionId, nextAuthoritativeSeq);

            try {
                const result = await apiSocket.emitWithAck<{
                    result: 'success' | 'forbidden' | 'error';
                    lastViewedSessionSeq?: number;
                }>('update-read-cursor', {
                    sid: sessionId,
                    lastViewedSessionSeq: nextAuthoritativeSeq,
                });

                if (result.result === 'success') {
                    const acknowledgedSeq =
                        typeof result.lastViewedSessionSeq === 'number' && Number.isFinite(result.lastViewedSessionSeq)
                            ? Math.max(0, Math.trunc(result.lastViewedSessionSeq))
                            : nextAuthoritativeSeq;
                    this.applyLocalReadCursor(sessionId, acknowledgedSeq);
                }
            } catch {
                // The local read cursor is a UI observation. Keep it even if the server publish is retried by later sync.
            }
        }

        if (!ownerMetadata) {
            return;
        }

        await this.updateSessionMetadataWithRetry(sessionId, (metadata) => {
            let nextMetadata = readExternalSessionLink(metadata)
                ? updateMetadataWithViewedExternalSessionProgress(metadata)
                : metadata;
            const result = computeNextReadStateV1({
                prev: nextMetadata.readStateV1,
                sessionSeq,
                pendingActivityAt,
                now: nowServerMs(),
            });
            if (!result.didChange) return nextMetadata;
            return { ...nextMetadata, readStateV1: result.next };
        });
    }

    private async publishExternalSessionObservedProgress(
        sessionId: string,
        items: ReadonlyArray<ExternalSessionTranscriptRawMessageV1>,
    ): Promise<void> {
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

        await this.publishExternalSessionObservedProgress(sessionId, items);
        return true;
    }

    /**
     * Commit a source read only after its complete staged window has passed
     * currentness/truncation adjudication. A single store application keeps a
     * relink during staged replacement at either the prior accepted transcript
     * or the complete replacement; it cannot expose an intermediate page.
     */
    private async applyExternalSessionTranscriptPages(
        sessionId: string,
        pages: ReadonlyArray<Readonly<{
            items: ReadonlyArray<ExternalSessionTranscriptRawMessageV1>;
            nextCursor: string | null;
        }>>,
        expectedAuthorityKey: string,
        options?: Readonly<{ replaceExisting?: boolean }>,
    ): Promise<boolean> {
        const session = storage.getState().sessions[sessionId] ?? null;
        const externalSessionLink = readExternalSessionLink(
            session ? readSessionOwnerMetadataView(session) : null,
        );
        if (!session || !externalSessionLink) return false;
        if (
            this.isExternalSessionTranscriptAuthorityFenced(sessionId, expectedAuthorityKey) ||
            externalSessionTranscriptAuthorityKey(
                this.resolveTranscriptAuthority(session, externalSessionLink),
            ) !== expectedAuthorityKey
        ) {
            return false;
        }

        const items = pages.flatMap((page) => page.items);
        const normalizedMessages = normalizeExternalSessionTranscriptMessages(items, {
            agentId: externalSessionLink.agentId,
            remoteSessionId: externalSessionLink.remoteSessionId,
        });
        if (normalizedMessages.length > 0 || options?.replaceExisting === true) {
            this.applyMessages(sessionId, normalizedMessages, {
                notifyVoice: false,
                notifyActivity: true,
                replaceExisting: options?.replaceExisting === true,
            });
        }
        if (pages.length > 0) {
            this.setExternalSessionTailCursor(
                sessionId,
                pages[pages.length - 1]?.nextCursor ?? null,
            );
        }
        await this.publishExternalSessionObservedProgress(sessionId, items);
        return true;
    }

    async publishSessionPermissionModeToMetadata(params: {
        sessionId: string;
        permissionMode: PermissionMode;
        permissionModeUpdatedAt: number;
    }): Promise<void> {
        await publishPermissionModeToMetadataEngine({
            sessionId: params.sessionId,
            permissionMode: params.permissionMode,
            permissionModeUpdatedAt: params.permissionModeUpdatedAt,
            updateSessionMetadataWithRetry: (sessionId, updater) => this.updateSessionMetadataWithRetry(sessionId, updater),
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
    ): Promise<void> {
        if (isDemoModeActive()) return;
        if (
            expectedOutboxScope
            && !areServerAccountScopesEqual(getActiveServerAccountScope(), expectedOutboxScope)
        ) {
            return;
        }
        const { outboxScope, request, isCurrent, serverWireMode } = await this.resolvePendingQueueOwnerContext(
            sessionId,
            expectedOutboxScope,
        );
        if (
            expectedOutboxScope
            && !areServerAccountScopesEqual(outboxScope, expectedOutboxScope)
        ) {
            return;
        }
        for (const localId of replayPersistedPendingOutboxForSession(sessionId, outboxScope)) {
            if (shouldSchedulePendingOutboxTransportRetry(serverWireMode)) {
                this.schedulePendingOutboxOperationRetry({ sessionId, localId, outboxScope });
            }
        }
        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: this.encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
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
                const sessionIds = listPendingOutboxSessionIds(outboxScope);
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
            deliveryMode?: 'external_handoff';
            hostAdmissionOrigin?: SessionMessageHostAdmissionOrigin;
            onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void;
            requestedAction?: PendingRequestedActionV1;
        }>,
    ): Promise<Readonly<{
        localId: string;
        accepted: boolean;
        cancelled?: true;
        terminal?: true;
        externalHandoffClaimed?: true;
    }>> {
        const { outboxScope, request, serverWireMode } = await this.resolvePendingQueueOwnerContext(sessionId);
        if (options?.localId != null && readPendingLocalId(options.localId) === null) {
            throw new Error('Pending localId must not be blank');
        }
        const durableLocalId = readPendingLocalId(options?.localId) ?? undefined;
        this.markSessionLiveTailIntent(sessionId);
        const result = await enqueuePendingMessageV2({
            sessionId,
            text,
            displayText,
            localId: durableLocalId,
            deliveryMode: options?.deliveryMode,
            metaOverrides,
            hostAdmissionOrigin: options?.hostAdmissionOrigin,
            encryption: this.encryption,
            fetchArtifactWithBody: (artifactId) => this.fetchArtifactWithBody(artifactId),
            updateArtifact: (artifact) => storage.getState().updateArtifact(artifact),
            request,
            outboxScope,
            serverWireMode,
            requestedAction: options?.requestedAction ?? { v: 1, kind: 'enqueue' },
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
        return result;
    }

    private async resolvePendingQueueOwnerContext(
        sessionId: string,
        expectedActiveScope?: ServerAccountScope,
    ): Promise<Readonly<{
        outboxScope: ServerAccountScope;
        request: (path: string, init?: RequestInit) => Promise<Response>;
        isCurrent: () => boolean | Promise<boolean>;
        serverWireMode: PendingInputServerWireMode;
    }>> {
        type PendingQueueOwner = Readonly<{
            outboxScope: ServerAccountScope;
            request: (path: string, init?: RequestInit) => Promise<Response>;
            isCurrent: () => boolean | Promise<boolean>;
        }>;
        const withServerWireMode = async (
            owner: PendingQueueOwner,
        ): Promise<PendingQueueOwner & Readonly<{ serverWireMode: PendingInputServerWireMode }>> => ({
            ...owner,
            serverWireMode: resolvePendingInputServerWireMode(
                await getServerFeaturesSnapshot({ serverId: owner.outboxScope.serverId }),
            ),
        });
        if (expectedActiveScope) {
            const assertCapturedActiveScope = (): void => {
                if (!areServerAccountScopesEqual(getActiveServerAccountScope(), expectedActiveScope)) {
                    throw new Error('Pending owner server-account scope changed');
                }
            };
            return await withServerWireMode({
                outboxScope: expectedActiveScope,
                request: async (path, init) => {
                    assertCapturedActiveScope();
                    const response = await apiSocket.request(path, init);
                    assertCapturedActiveScope();
                    return response;
                },
                isCurrent: () => areServerAccountScopesEqual(
                    getActiveServerAccountScope(),
                    expectedActiveScope,
                ),
            });
        }
        const activeRequest = this.createSessionRequest(sessionId);
        const fenceActiveRequest = (capturedScope: ServerAccountScope) => async (
            path: string,
            init?: RequestInit,
        ): Promise<Response> => {
            if (!areServerAccountScopesEqual(getActiveServerAccountScope(), capturedScope)) {
                throw new Error('Pending owner server-account scope changed');
            }
            const response = await activeRequest(path, init);
            if (!areServerAccountScopesEqual(getActiveServerAccountScope(), capturedScope)) {
                throw new Error('Pending owner server-account scope changed');
            }
            return response;
        };
        const preferredServerId = resolvePreferredServerIdForSessionId(sessionId);
        const activeOutboxScope = getActiveServerAccountScope();
        const activeServerId = getActiveServerSnapshot().serverId;
        if (
            activeOutboxScope
            && (
                !preferredServerId
                || areServerProfileIdentifiersEquivalent(preferredServerId, activeServerId)
            )
        ) {
            return await withServerWireMode({
                outboxScope: activeOutboxScope,
                request: fenceActiveRequest(activeOutboxScope),
                isCurrent: () => areServerAccountScopesEqual(getActiveServerAccountScope(), activeOutboxScope),
            });
        }
        const context = await resolveServerScopedSessionContext({
            serverId: preferredServerId ?? null,
        });
        if (context.scope === 'active') {
            const outboxScope = requireActivePendingOutboxScope();
            return await withServerWireMode({
                outboxScope,
                request: fenceActiveRequest(outboxScope),
                isCurrent: () => areServerAccountScopesEqual(getActiveServerAccountScope(), outboxScope),
            });
        }
        const outboxScope = createServerAccountScope(context.targetServerId, context.targetAccountId);
        if (!outboxScope) {
            throw new Error('Pending enqueue requires an authenticated server-account scope');
        }
        return await withServerWireMode({
            outboxScope,
            request: createSessionRequestForResolvedServerScope({ context, activeRequest }),
            isCurrent: async () => {
                const currentPreferredServerId = resolvePreferredServerIdForSessionId(sessionId);
                if (
                    typeof currentPreferredServerId !== 'string'
                    || !areServerProfileIdentifiersEquivalent(currentPreferredServerId, outboxScope.serverId)
                ) return false;
                const currentContext = await resolveServerScopedSessionContext({ serverId: currentPreferredServerId });
                const currentScope = currentContext.scope === 'active'
                    ? getActiveServerAccountScope()
                    : createServerAccountScope(currentContext.targetServerId, currentContext.targetAccountId);
                return areServerAccountScopesEqual(currentScope, outboxScope);
            },
        });
    }

    async retryPendingMessageSend(sessionId: string, localId: string): Promise<void> {
        const { outboxScope, request, serverWireMode } = await this.resolvePendingQueueOwnerContext(sessionId);
        const pending = storage.getState().sessionPending[sessionId]?.messages?.find((message) =>
            isPendingOutboxProjectionForIdentity(message, { sessionId, localId, outboxScope })
        );
        if (!pending) throw new Error('Pending retry requires its persisted server-account scope');
        this.markSessionLiveTailIntent(sessionId);
        setPendingMessageSendState(sessionId, localId, 'unconfirmed', outboxScope);
        try {
            const result = await retryPendingOutboxOperationV2({
                sessionId,
                localId,
                request,
                outboxScope,
                serverWireMode,
            });
            if (!result.accepted && shouldSchedulePendingOutboxTransportRetry(serverWireMode)) {
                this.schedulePendingOutboxOperationRetry({ sessionId, localId, outboxScope });
            }
        } catch (error) {
            if (isTerminalAuthError(error)) recordTerminalAuthSyncError(error);
            setPendingMessageSendState(sessionId, localId, 'failed', outboxScope);
        }
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
            }>;
        }>,
    ): Promise<PendingMessageComposerAdmissionAcceptedFactV1 | undefined> {
        const { outboxScope, request } = await this.resolvePendingQueueOwnerContext(sessionId);
        return await updatePendingMessageV2({
            sessionId,
            pendingId,
            text,
            structuredInput,
            replacementLocalId: options?.replacementLocalId,
            preparedComposerAdmission: options?.preparedComposerAdmission,
            encryption: this.encryption,
            fetchArtifactWithBody: (artifactId) => this.fetchArtifactWithBody(artifactId),
            updateArtifact: (artifact) => storage.getState().updateArtifact(artifact),
            request,
            outboxScope,
        });
    }

    async deletePendingMessage(sessionId: string, pendingId: string): Promise<void> {
        const { outboxScope, request } = await this.resolvePendingQueueOwnerContext(sessionId);
        await deletePendingMessageV2({
            sessionId,
            pendingId,
            request,
            outboxScope,
        });
    }

    async discardPendingMessage(
        sessionId: string,
        pendingId: string,
        opts?: { reason?: 'switch_to_local' | 'manual' }
    ): Promise<void> {
        const { outboxScope, request, isCurrent } = await this.resolvePendingQueueOwnerContext(sessionId);
        await discardPendingMessageV2({
            sessionId,
            pendingId,
            reason: opts?.reason ?? 'manual',
            encryption: this.encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
    }

    async dismissPendingDelivery(sessionId: string, pendingId: string): Promise<void> {
        const { outboxScope, request, isCurrent } = await this.resolvePendingQueueOwnerContext(sessionId);
        await dismissPendingDeliveryV2({
            sessionId,
            pendingId,
            encryption: this.encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
    }

    async blockPendingDelivery(
        sessionId: string,
        pendingId: string,
        reason: PendingDeliveryBlockedReason,
    ): Promise<void> {
        const { outboxScope, request, isCurrent } = await this.resolvePendingQueueOwnerContext(sessionId);
        await blockPendingDeliveryV2({
            sessionId,
            pendingId,
            reason,
            encryption: this.encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
    }

    async restoreDiscardedPendingMessage(sessionId: string, pendingId: string): Promise<void> {
        const { outboxScope, request, isCurrent } = await this.resolvePendingQueueOwnerContext(sessionId);
        await restoreDiscardedPendingMessageV2({
            sessionId,
            pendingId,
            encryption: this.encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
    }

    async sendPendingDeliveryAsNew(sessionId: string, pendingId: string): Promise<string> {
        const { outboxScope, request, isCurrent } = await this.resolvePendingQueueOwnerContext(sessionId);
        return await sendPendingDeliveryAsNewV2({
            sessionId,
            pendingId,
            encryption: this.encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
    }

    async markPendingDeliveryHandled(sessionId: string, pendingId: string): Promise<void> {
        const { outboxScope, request, isCurrent } = await this.resolvePendingQueueOwnerContext(sessionId);
        await markPendingDeliveryHandledV2({
            sessionId,
            pendingId,
            encryption: this.encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
    }

    async deleteDiscardedPendingMessage(sessionId: string, pendingId: string): Promise<void> {
        const { outboxScope, request, isCurrent } = await this.resolvePendingQueueOwnerContext(sessionId);
        await deleteDiscardedPendingMessageV2({
            sessionId,
            pendingId,
            encryption: this.encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
    }

    async reorderPendingMessages(sessionId: string, orderedLocalIds: string[]): Promise<void> {
        const { outboxScope, request, isCurrent } = await this.resolvePendingQueueOwnerContext(sessionId);
        const canonicalOrderedLocalIds = orderedLocalIds.map((pendingId) =>
            resolvePendingMessageProjectionLocalIdV2(sessionId, pendingId, outboxScope)
        );
        await reorderPendingMessagesV2({
            sessionId,
            orderedLocalIds: canonicalOrderedLocalIds,
            encryption: this.encryption,
            request,
            outboxScope,
            isOutboxScopeCurrent: isCurrent,
        });
    }

    applySettings = (delta: AccountSettingsWriteDelta, options?: { source?: SettingsAnalyticsSource }) => {
        applySettingsLocalDelta({
            delta,
            settingsSecretsKey: this.settingsSecretsKey,
            getPendingSettings: () => this.pendingSettings,
            setPendingSettings: (next) => {
                this.pendingSettings = next;
            },
            schedulePendingSettingsFlush: () => this.schedulePendingSettingsFlush(),
            source: options?.source,
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
        this.pushTokenSync.invalidate();
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

    async assumeUsers(userIds: string[]): Promise<void> {
        if (!this.credentials || userIds.length === 0) return;
        
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
                    const profile = await getUserProfile(this.credentials!, id);
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

        if (Object.keys(usersMap).length > 0) {
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
        const serverScopeGeneration = this.serverScopeGeneration;
        const snapshotGeneration = this.sessionListSnapshotGeneration;
        if (canShareFetchSessionsInFlight(options)) {
            const existing = this.fetchSessionsInFlight;
            if (
                existing
                && existing.serverScopeGeneration === serverScopeGeneration
                && existing.snapshotGeneration === snapshotGeneration
            ) {
                return existing.promise;
            }
        }
        const runFetch = this.fetchSessionsOnce(options, serverScopeGeneration, snapshotGeneration);
        if (canShareFetchSessionsInFlight(options)) {
            const sharedFetch = runFetch.finally(() => {
                if (this.fetchSessionsInFlight?.promise === sharedFetch) {
                    this.fetchSessionsInFlight = null;
                }
            });
            this.fetchSessionsInFlight = {
                serverScopeGeneration,
                snapshotGeneration,
                promise: sharedFetch,
            };
            return sharedFetch;
        }
        return runFetch;
    }

    private fetchSessionsOnce = async (
        options: FetchSessionsOptions | undefined,
        serverScopeGeneration: number,
        snapshotGeneration: number,
    ) => {
        const shouldContinue = () => (
            this.serverScopeGeneration === serverScopeGeneration
            && this.sessionListSnapshotGeneration === snapshotGeneration
        );
        const initialState = storage.getState();
        const activeServerSnapshot = getActiveServerSnapshot();
        const activeServerId = String(activeServerSnapshot.serverId ?? '').trim() || null;
        const cachedSessionListEntries = buildSessionListCacheEntriesFromRenderables(initialState.sessionListRenderables);
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
        const hasLastKnownOrganizationSnapshot = activeServerId
            ? typeof initialState.sessionOrganizationSnapshotVersionByServerId[activeServerId] === 'number'
            : false;
        const organizationSnapshotRefresh = !isAppend && activeServerId
            ? fetchAndApplySessionOrganizationSnapshot({
                credentials: this.credentials,
                serverId: activeServerId,
                serverUrl: activeServerSnapshot.serverUrl,
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
        const sessionRequest = (path: string, init: RequestInit) =>
            apiSocket.request(path, init);
        const result = await fetchAndApplySessions({
            serverId: activeServerId,
            sessionListCursor: isAppend ? this.sessionListNextCursor : null,
            sessionListMaxPages: 1,
            includeActiveSessionRows: !isAppend,
            includeSessionListAttentionRows: !isAppend,
            credentials: this.credentials,
            encryption: this.encryption,
            sessionDataKeys: this.sessionDataKeys,
            sessionDataKeyEnvelopes: this.sessionDataKeyEnvelopes,
            request: sessionRequest,
            getExistingSession: (sessionId) => storage.getState().sessions[sessionId] ?? null,
            getCurrentSessionListRenderable: (sessionId) => storage.getState().sessionListRenderables[sessionId] ?? null,
            cachedSessionListEntries,
            shouldContinue,
            applySessionListRenderables: (sessions) => {
                if (!shouldContinue()) return;
                if (isAppend) {
                    storage.getState().mergeSessionListRenderables(sessions);
                    return;
                }
                storage.getState().replaceSessionListRenderables(sessions);
            },
            applySessionListRenderablePatches: (patches) => {
                if (!shouldContinue()) return;
                storage.getState().applySessionListRenderablePatches(patches);
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
            repairInvalidReadStateV1: (params) => this.repairInvalidReadStateV1(params),
            log,
        });
        if (!shouldContinue()) return;
        const fetchedSessionIdSet = new Set(result.sessionIds);
        const missingRequiredHydrationSessionIds = requiredHydrationSessionIds.filter(
            (sessionId) => !fetchedSessionIdSet.has(sessionId),
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
                    activeRequest: (path, init) => apiSocket.request(path, init),
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
                        // socket work.
                        this.retireLocalSession(sessionId);
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
        this.sessionListNextCursor = result.hasNext ? result.nextCursor : null;
        this.sessionListHasMore = result.hasNext;
        return result;
    }

    public fetchMoreSessions = async (): Promise<void> => {
        if (!this.credentials || !this.sessionListHasMore || !this.sessionListNextCursor) return;
        if (this.fetchMoreSessionsInFlight) return this.fetchMoreSessionsInFlight;
        const promise = this.fetchSessions({ mode: 'append' }).then(() => undefined).finally(() => {
            if (this.fetchMoreSessionsInFlight === promise) {
                this.fetchMoreSessionsInFlight = null;
            }
        });
        this.fetchMoreSessionsInFlight = promise;
        return promise;
    }

    private fetchArchivedSessionsPage = async (options?: FetchArchivedSessionsOptions): Promise<void> => {
        if (!this.credentials) {
            if (options?.mode !== 'append') {
                this.archivedSessionsFetchPendingUntilReady = true;
            }
            return;
        }
        const generation = this.serverScopeGeneration;
        const shouldContinue = () => this.serverScopeGeneration === generation;
        const isAppend = options?.mode === 'append';
        const request = (path: string, init: RequestInit) =>
            apiSocket.request(path, init);
        const result = await (async () => {
            try {
                return await fetchAndApplySessions({
                    sessionListPath: '/v2/sessions/archived',
                    sessionListCursor: isAppend ? this.archivedSessionListNextCursor : null,
                    sessionListMaxPages: 1,
                    serverId: String(getActiveServerSnapshot().serverId ?? '').trim() || null,
                    credentials: this.credentials,
                    encryption: this.encryption,
                    sessionDataKeys: this.sessionDataKeys,
                    sessionDataKeyEnvelopes: this.sessionDataKeyEnvelopes,
                    request,
                    getExistingSession: (sessionId) => storage.getState().sessions[sessionId] ?? null,
                    shouldContinue,
                    applySessions: (sessions) => {
                        if (!shouldContinue()) return;
                        this.applySessions(sessions);
                    },
                    repairInvalidReadStateV1: (params) => this.repairInvalidReadStateV1(params),
                    log,
                });
            } catch (error) {
                if (!isAppend && isServerSwitchAbortError(error)) {
                    this.archivedSessionsFetchPendingUntilReady = true;
                    this.scheduleArchivedSessionsFetchPendingDrain();
                    return null;
                }
                throw error;
            }
        })();
        if (!result) return;
        if (!shouldContinue()) return;
        this.archivedSessionListNextCursor = result.hasNext ? result.nextCursor : null;
        this.archivedSessionListHasMore = result.hasNext;
    }

    private scheduleArchivedSessionsFetchPendingDrain(): void {
        if (this.archivedSessionsFetchPendingRetryTimer) return;
        const timer = setTimeout(() => {
            this.archivedSessionsFetchPendingRetryTimer = null;
            this.drainArchivedSessionsFetchPendingUntilReady();
        }, 250);
        try {
            (timer as unknown as { unref?: () => void }).unref?.();
        } catch {
            // ignore
        }
        this.archivedSessionsFetchPendingRetryTimer = timer;
    }

    private drainArchivedSessionsFetchPendingUntilReady(): void {
        if (!this.archivedSessionsFetchPendingUntilReady || !this.credentials) return;
        this.archivedSessionsFetchPendingUntilReady = false;
        fireAndForget(this.fetchArchivedSessionsPage({ mode: 'replace' }), {
            tag: 'Sync.fetchArchivedSessions.deferredUntilReady',
        });
    }

    public fetchArchivedSessions = async (): Promise<void> => {
        return this.fetchArchivedSessionsPage({ mode: 'replace' });
    }

    public fetchMoreArchivedSessions = async (): Promise<void> => {
        if (!this.credentials || !this.archivedSessionListHasMore || !this.archivedSessionListNextCursor) return;
        if (this.fetchMoreArchivedSessionsInFlight) return this.fetchMoreArchivedSessionsInFlight;
        const promise = this.fetchArchivedSessionsPage({ mode: 'append' }).finally(() => {
            if (this.fetchMoreArchivedSessionsInFlight === promise) {
                this.fetchMoreArchivedSessionsInFlight = null;
            }
        });
        this.fetchMoreArchivedSessionsInFlight = promise;
        return promise;
    }

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
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        if (!normalizedSourceServerId) return true;
        return areServerProfileIdentifiersEquivalent(normalizedSourceServerId, activeServerId);
    }

    private shouldRefreshActiveSessionListAfterSocketHydration = (
        reason: SyncSocketSessionHydrationReason,
        sourceServerId?: string | null,
    ): boolean => (
        reason === 'socket-new-session-reconcile'
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
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
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

        const currentRenderable = state.sessionListRenderables[normalized];
        storage.getState().mergeSessionListRenderables([
            buildSessionListRenderableFromSession(session, currentRenderable),
        ]);
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
        return createSessionRequestWithServerScope({
            serverId: resolvePreferredServerIdForSessionId(sessionId),
            activeRequest: (path, init) => apiSocket.request(path, init),
        });
    }

    private createSessionMessagesRequest = (sessionId: string): ((path: string) => Promise<Response>) => {
        const request = this.createSessionRequest(sessionId);
        return (path: string) => request(path, { method: 'GET' });
    }

    private isServerAccountSessionAuthorityCurrent(
        authority: ServerAccountSessionRequestAuthority,
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
        authority: ServerAccountSessionRequestAuthority,
        sessionId: string,
    ): boolean {
        return this.isServerAccountSessionAuthorityCurrent(authority)
            && Boolean(storage.getState().sessions[sessionId]);
    }

    private getSessionMessagesEncryptionForAuthority(
        authority: ServerAccountSessionRequestAuthority,
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
          try {
              storage.getState().clearSyncError();
              apiSocket.disconnect();
              apiSocket.connect();
          } catch {
              // ignore
          }
          try {
              fireAndForget(invalidateAllServerReachabilitySupervisors(), {
                  tag: 'Sync.invalidateAllServerReachabilitySupervisors.manual',
              });
          } catch {
              // ignore
          }
          fireAndForget(this.resumeSync('manual'), { tag: 'Sync.resumeSync.manual' });
      }

      private requestAccountChangeCatchUp = (): void => {
          const activeResume = this.resumeInFlight;
          if (!activeResume) {
              fireAndForget(this.resumeSync('account-change'), { tag: 'Sync.resumeSync.account-change' });
              return;
          }

          // A wake can arrive after the active resume has consumed its final
          // changes page but before its outer cleanup releases this in-flight
          // slot. Preserve one level-triggered follow-up through the same
          // cursor owner; reset clears it with the Account lifetime.
          this.accountChangeWakeQueuedAfterResume = true;
          void activeResume.then(
              () => this.runQueuedAccountChangeCatchUp(),
              () => this.runQueuedAccountChangeCatchUp(),
          );
      };

      private runQueuedAccountChangeCatchUp = (): void => {
          if (!this.accountChangeWakeQueuedAfterResume) {
              return;
          }
          this.accountChangeWakeQueuedAfterResume = false;
          this.requestAccountChangeCatchUp();
      };

      public resumeSync = (reason: 'app-foreground' | 'socket-reconnect' | 'account-change' | 'manual' | 'server-reachable'): Promise<void> => {
          return runWithInFlightDedupe(
              {
                  get: () => this.resumeInFlight,
                  set: (value) => {
                      this.resumeInFlight = value;
                  },
              },
              async () => {
                  const shouldContinue = this.createServerScopeGuard();
                  if ((reason === 'socket-reconnect' || reason === 'account-change' || reason === 'server-reachable') && !this.isForeground) {
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

                  await this.ensureSessionDraftRepositoryRuntimeReady({
                      forceSnapshotHydration: reason === 'manual' || this.sessionDraftOfflineCatchUpPending,
                  });
                  if (!shouldContinue()) return;

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

                  await this.rearmPendingOutboxForActiveScope();
                  if (!shouldContinue()) {
                      return;
                  }

                  const { status, refreshedByCatchUp } = await this.resumeViaChanges({ accountId, shouldContinue });
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
                            () => invalidateBounded(this.pushTokenSync, this.syncTuning.resumeQuickInvalidateTimeoutMs),
                            () => invalidateBounded(this.nativeUpdateSync, this.syncTuning.resumeQuickInvalidateTimeoutMs),
                        ],
                        this.syncTuning.resumeConcurrencyLimit
                    );
                }
            );
        };

      private bootstrapSync = async (): Promise<void> => {
          if (this.pauseController.isPaused()) {
              return;
          }
          await this.pauseController.waitUntilResumed();
          if (!this.credentials) {
              return;
          }
          this.pluginAvailabilityProjectionHydrator.reset();
          clearPluginAccountAvailabilityProjection();

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

          // Phase 2: load core UI state and first session/machine snapshots.
          await runTasksWithLimit(
              [
                  () => invalidateBounded(this.profileSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.accountPetsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.sessionsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.machinesSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.pluginAvailabilitySync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.purchasesSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
              ],
              bootstrapConcurrencyLimit
          );

          await this.ensureSessionDraftRepositoryRuntimeReady();

          await this.rearmPendingOutboxForActiveScope();

          try {
              storage.getState().applyReady();
          } catch {
              // ignore
          }

          // Phase 3: load non-critical lists.
          await runTasksWithLimit(
              [
                  () => invalidateBounded(this.artifactsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.automationsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.todosSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.friendsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.friendRequestsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.feedSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.pushTokenSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  () => invalidateBounded(this.nativeUpdateSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
              ],
              this.syncTuning.resumeConcurrencyLimit
          );
        };

      private snapshotRefreshOnResume = async (opts: { mode: 'fallback' | 'long-offline'; reason: string }): Promise<void> => {
          if (this.pauseController.isPaused()) {
              return;
          }
          await this.pauseController.waitUntilResumed();
          if (!this.credentials) {
              return;
          }
          this.pluginAvailabilityProjectionHydrator.reset();
          clearPluginAccountAvailabilityProjection();

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

          await this.ensureSessionDraftRepositoryRuntimeReady({ forceSnapshotHydration: true });

          // Catch up transcripts only for loaded sessions that currently consume live transcript content.
          // Hidden loaded sessions keep their transcript state until they become visible or otherwise active.
          const loadedSessionIds: string[] = [];
          try {
              const sessions = storage.getState().sessionMessages;
              for (const sessionId of Object.keys(sessions)) {
                  if (
                      sessions[sessionId]?.isLoaded === true
                      && resolveSessionLiveConsumption(sessionId).isFullContentConsumer
                  ) {
                      loadedSessionIds.push(sessionId);
                  }
              }
          } catch {
              // ignore
          }

          await runTasksWithLimit(
              loadedSessionIds.map((sessionId) => async () => {
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
        updater: (metadata: Metadata) => Metadata,
        options?: Readonly<{
            serverId?: string | null;
            maxAttempts?: number;
            sessionExpectation?:
                SessionMetadataInactiveModelIntentExpectationV1;
        }>,
    ): Promise<void> => {
        await this.updateSessionMetadataWithRetry(sessionId, updater, options);
    }

    public refreshAutomations = async () => {
        return this.automationsSync.invalidateAndAwait();
    }

    /** Account-scoped Automation settings stay direct: their server owner is not another UI cache. */
    public async getAutomationSettings(): Promise<AutomationV3Settings> {
        const credentials = this.credentials;
        if (!credentials) {
            throw new Error('Not authenticated');
        }
        const shouldContinue = this.createServerScopeGuard();
        const settings = await getAutomationSettings(credentials);
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
        const shouldContinue = this.createServerScopeGuard();
        const settings = await updateAutomationSettings(credentials, input);
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
        const shouldContinue = this.createServerScopeGuard();
        const result = await clearAutomationRunHistory(credentials, automationId);
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
        const shouldContinue = this.createServerScopeGuard();

        return await fetchAndApplyAutomationRuns({
            credentials: this.credentials,
            automationId,
            limit,
            cursor,
            shouldContinue,
            setAutomationRuns: (id, runs, nextCursor) => storage.getState().setAutomationRuns(id, runs, nextCursor),
            appendAutomationRuns: (id, expectedCursor, runs, nextCursor) =>
                storage.getState().appendAutomationRuns(id, expectedCursor, runs, nextCursor),
        });
    }

    /** One plural writer serves every Automation and Session authoring surface. */
    public async saveAutomationEditorDraft(
        draft: AutomationEditorDraft,
        options: Readonly<{ isCurrent?: () => boolean }> = {},
    ): Promise<AutomationDefinition> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const shouldContinue = this.createServerScopeGuard();
        const updated = await saveAutomationEditorDraftOwner({
            credentials: this.credentials,
            draft,
            isCurrent: () => shouldContinue() && (options.isCurrent?.() ?? true),
            ...(this.encryption ? {
                sealAutomationTriggerDefinition: (params) => (
                    this.encryption!.sealAutomationTriggerDefinition(params)
                ),
            } : {}),
        });
        return this.projectAndUpsertAutomationDefinition(updated, shouldContinue, { replaceEqualRevision: true });
    }

    public async replaceAutomationAssignments(
        automationId: string,
        assignments: ReadonlyArray<import('@happier-dev/protocol').AutomationAssignmentInput>,
    ): Promise<AutomationDefinition> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const shouldContinue = this.createServerScopeGuard();
        const updated = await replaceAutomationDefinitionAssignments(this.credentials, automationId, assignments);
        return this.projectAndUpsertAutomationDefinition(updated, shouldContinue, { replaceEqualRevision: true });
    }

    public async pauseAutomation(automationId: string): Promise<AutomationDefinition> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const shouldContinue = this.createServerScopeGuard();
        const updated = await pauseAutomationDefinition(this.credentials, automationId);
        return this.projectAndUpsertAutomationDefinition(updated, shouldContinue, { replaceEqualRevision: true });
    }

    public async resumeAutomation(automationId: string): Promise<AutomationDefinition> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const shouldContinue = this.createServerScopeGuard();
        const updated = await resumeAutomationDefinition(this.credentials, automationId);
        return this.projectAndUpsertAutomationDefinition(updated, shouldContinue, { replaceEqualRevision: true });
    }

    /** Direct private read for a route/editor; list refreshes intentionally never call this. */
    public async refreshAutomationDefinitionDetail(automationId: string): Promise<AutomationDefinition | null> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const shouldContinue = this.createServerScopeGuard();
        try {
            return await this.readAndUpsertAutomationDefinition(automationId, shouldContinue);
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
        shouldContinue: () => boolean,
    ): Promise<AutomationDefinition> {
        const credentials = this.credentials;
        if (!credentials) {
            throw new Error('Not authenticated');
        }
        const detail = await getAutomationDefinition(credentials, automationId);
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
        const shouldContinue = this.createServerScopeGuard();
        await deleteAutomationDefinition(this.credentials, automationId);
        if (!shouldContinue()) {
            throw new Error('Automation server-account scope changed');
        }
        storage.getState().removeAutomation(automationId);
    }

    public async runAutomationNow(automationId: string): Promise<AutomationDefinitionRun> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const shouldContinue = this.createServerScopeGuard();
        const run = await runAutomationDefinitionNow(this.credentials, automationId);
        if (!shouldContinue()) {
            throw new Error('Automation server-account scope changed');
        }
        storage.getState().upsertAutomationRun(run);
        return run;
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
        const shouldContinue = this.createServerScopeGuard();
        const detail = await getAutomationRunDetail(credentials, automationId, runId);
        if (!shouldContinue()) {
            throw new Error('Automation server-account scope changed');
        }

        let accountCurrentness: Awaited<ReturnType<typeof fetchAccountEncryptionCurrentness>>;
        try {
            accountCurrentness = await fetchAccountEncryptionCurrentness(credentials);
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
        const shouldContinue = this.createServerScopeGuard();
        const run = await cancelAutomationRun(credentials, runId);
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
        const shouldContinue = this.createServerScopeGuard();
        const run = await retryAutomationReplyHandoff(credentials, runId);
        if (!shouldContinue()) throw new Error('Automation server-account scope changed');
        storage.getState().upsertAutomationRun(run);
        return run;
    }

    public getCredentials() {
        return this.credentials;
    }

    // Artifact methods
    public fetchArtifactsList = async (): Promise<void> => {
        const shouldContinue = this.createServerScopeGuard();
        await fetchAndApplyArtifactsList({
            credentials: this.credentials,
            encryption: this.encryption,
            artifactDataKeys: this.artifactDataKeys,
            shouldContinue,
            applyArtifacts: (artifacts) => storage.getState().applyArtifacts(artifacts),
        });
    }

    public async fetchArtifactWithBody(artifactId: string): Promise<DecryptedArtifact | null> {
        if (!this.credentials) return null;

        return await fetchArtifactWithBodyFromApi({
            credentials: this.credentials,
            artifactId,
            encryption: this.encryption,
            artifactDataKeys: this.artifactDataKeys,
        });
    }

    public async createArtifact(
        title: string | null, 
        body: string | null,
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

    public async createArtifactWithHeader(header: ArtifactHeader, body: string | null): Promise<string> {
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
        body: string | null,
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

    public async updateArtifactWithHeader(artifactId: string, header: ArtifactHeader, body: string | null): Promise<void> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }

        await updateArtifactWithHeaderViaApi({
            credentials: this.credentials,
            artifactId,
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
        const generation = this.serverScopeGeneration;
        const shouldContinue = () => this.serverScopeGeneration === generation;
        const sourceServerId = String(getActiveServerSnapshot().serverId ?? '').trim() || null;
        const cachedMachineDisplayEntries = buildMachineDisplayCacheEntriesFromRenderables(storage.getState().machineDisplayById);

        await fetchAndApplyMachines({
            credentials: this.credentials,
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
        });
    }

    private fetchFriends = async () => {
        if (!this.credentials) return;
        const shouldContinue = this.createServerScopeGuard();
        await fetchAndApplyFriends({
            credentials: this.credentials,
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
        if (!this.credentials) return;
        const shouldContinue = this.createServerScopeGuard();
        await fetchTodosEngine({ credentials: this.credentials, shouldContinue });
    }

    private fetchAutomations = async () => {
        const shouldContinue = this.createServerScopeGuard();
        await fetchAndApplyAutomations({
            credentials: this.credentials,
            shouldContinue,
            applyAutomations: (automations) => storage.getState().applyAutomations(automations),
            loadedAutomationRunIds: Object.keys(storage.getState().automationRunsByAutomationId),
            refreshAutomationRunsWindow: (automationId, runs, nextCursor) =>
                storage.getState().refreshAutomationRunsWindow(automationId, runs, nextCursor),
        });
    }

    private fetchAccountPets = async () => {
        const credentials = this.credentials;
        if (!credentials) return;
        const activeServer = getActiveServerSnapshot();
        const serverId = String(activeServer.serverId ?? '').trim() || undefined;
        const shouldContinue = this.createServerScopeGuard();
        const params = {
            credentials,
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
        if (!this.credentials) return;
        const shouldContinue = this.createServerScopeGuard();
        await fetchAndApplyFeed({
            credentials: this.credentials,
            getFeedItems: () => storage.getState().feedItems,
            getFeedHead: () => storage.getState().feedHead,
            assumeUsers: (userIds) => this.assumeUsers(userIds),
            getUsers: () => storage.getState().users,
            shouldContinue,
            applyFeedItems: (items) => storage.getState().applyFeedItems(items),
            log,
        });
    }

    private syncSettings = async () => {
        if (!this.credentials) return;
        const settingsScope = this.pendingSettingsScope;
        const settingsSyncParams: SyncSettingsParams = {
            credentials: this.credentials,
            encryption: this.encryption,
            settingsScope,
            pendingSettings: this.pendingSettings,
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
    public refreshAccountSettingsFromServer = async (minimumVersion: number): Promise<void> => {
        this.flushPendingSettingsForCurrentScopeNow();
        await this.syncSettings();
        assertAccountSettingsRehydratedVersion({
            currentVersion: storage.getState().settingsVersion,
            minimumVersion,
        });
    }

    /**
     * Applies a functional account-settings update against every canonical CAS
     * winner. Unlike applySettings, this never replays a stale whole subtree.
     */
    public mutateAccountSettings = async (
        mutate: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown>,
    ): Promise<void> => {
        const credentials = this.credentials;
        if (!credentials) throw new Error('Account settings mutation requires an authenticated account');
        const generation = this.serverScopeGeneration;
        const settingsScope = this.pendingSettingsScope;
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
        await syncSettingsEngine({
            credentials,
            encryption,
            settingsScope,
            pendingSettings: {},
            settingsSecretsKey,
            settingsSecretsReadKeys,
            clearPendingSettings: () => {},
            serverSettingsMutation: mutate,
        });
    }

    /**
     * Applies one explicit Account Settings mutation exactly once. A version
     * conflict refreshes the canonical winner and is returned to the caller;
     * the semantic mutation is never recomputed or replayed.
     */
    public mutateAccountSettingsOnce = async <T>(input: Readonly<{
        expectedSettingsVersion: number;
        mutate: (
            raw: Readonly<Record<string, unknown>>,
        ) => Readonly<{
            settings: Record<string, unknown>;
            value: T;
        }>;
    }>): Promise<OneShotAccountSettingsMutationResult<T>> => {
        const credentials = this.credentials;
        if (!credentials) throw new Error('Account settings mutation requires an authenticated account');
        const generation = this.serverScopeGeneration;
        const settingsScope = this.pendingSettingsScope;
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
        const result = await syncSettingsEngine({
            credentials,
            encryption,
            settingsScope,
            pendingSettings: {},
            settingsSecretsKey,
            settingsSecretsReadKeys,
            clearPendingSettings: () => {},
            oneShotServerSettingsMutation: input,
        });
        if (!result) throw new Error('One-shot Account Settings mutation did not settle');
        return result;
    }

    private fetchProfile = async () => {
        if (!this.credentials) return;
        const generation = this.serverScopeGeneration;
        const shouldContinue = () => this.serverScopeGeneration === generation;
        const profileScope = this.pendingSettingsScope;
        await fetchAndApplyProfile({
            credentials: this.credentials,
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

            const response = await serverFetch('/v1/version', {
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
            this.getOrCreateMessagesSync(sessionId).invalidateCoalesced();
        }
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
        let stagedPage: ApiSessionMessagesResponse | null = null;
        await fetchAndApplyMessages({
            sessionId: session.id,
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
            ...this.getMessageDecryptBatchOptions(),
            log,
        });

        const currentSession = storage.getState().sessions[session.id] ?? null;
        if (!currentSession) return false;
        const currentLink = readExternalSessionLinkFromSession(currentSession);
        const currentAuthority = this.resolveTranscriptAuthority(currentSession, currentLink);
        if (externalSessionTranscriptAuthorityKey(currentAuthority) !== authorityKey) return false;

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
                { allowHasMoreInference: true },
            );
        }
        this.applyMessages(session.id, boundedMessages, { replaceExisting: true });
        this.transcriptAuthorityKeyBySessionId.set(session.id, authorityKey);
        this.externalSessionTranscriptFenceAuthorityKeyBySessionId.delete(session.id);
        return true;
    }

    private fetchMessages = async (sessionId: string) => {
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
            // or a locally known owner server. This avoids cross-server message fetches while keeping
            // the UI state non-destructive during server-switch races.
            if (storage.getState().sessionMessages[sessionId]?.isLoaded !== true) {
                storage.getState().applyMessagesLoaded(sessionId);
            }
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
          const afterSeq = hasLoadedMessages ? (this.sessionMaterializedMaxSeqById[sessionId] ?? 0) : 0;
          const deferredDurableSeq = readDeferredTranscriptDurableSeq(this.deferredTranscriptState, sessionId);
          const sessionSeqHint = Math.max(session?.seq ?? 0, deferredDurableSeq ?? 0);

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
              if (!hasLoadedMessages) {
                  const didApplyCurrentAuthority = await this.fetchExternalSessionMessages(sessionId, externalSessionLink);
                  if (didApplyCurrentAuthority) {
                      this.transcriptAuthorityKeyBySessionId.set(sessionId, authorityKey);
                      this.externalSessionTranscriptFenceAuthorityKeyBySessionId.delete(sessionId);
                      storage.getState().setSessionTranscriptLoadIssue(sessionId, null);
                  }
                  return;
              }

              let didApplyCurrentAuthority: boolean;
              if (previousAuthorityKey !== authorityKey) {
                  didApplyCurrentAuthority = await this.fetchExternalSessionMessages(
                      sessionId,
                      externalSessionLink,
                      { replaceExisting: true },
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
                      || (previousAuthorityKey !== null && previousAuthorityKey !== authorityKey)
                  )
              )
          ) {
              if (!hasLoadedMessages || previousAuthorityKey !== authorityKey) {
                  const didCommit = await this.replaceWithServerTranscript(session, transcriptAuthority);
                  if (didCommit) {
                      storage.getState().setSessionTranscriptLoadIssue(sessionId, null);
                  }
              }
              this.explicitSessionTailProbeIds.delete(sessionId);
              return;
          }

          if (!hasLoadedMessages) {
              this.deferredForwardLoadingSessions.delete(sessionId);
              await fetchAndApplyMessages({
                  sessionId,
                  sessionEncryptionMode,
                  getSessionEncryption: (id) => this.encryption?.getSessionEncryption(id) ?? null,
                  isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
                  request: requestMessages,
                  sessionReceivedMessages: this.sessionReceivedMessages,
                  applyMessages: (sid, messages) => this.applyMessages(sid, messages),
                  onTaskLifecycleEvent: (event) => this.applySessionThinkingFromTaskLifecycle(sessionId, event),
                  markMessagesLoaded: (sid) => storage.getState().applyMessagesLoaded(sid),
                  onMessagesPage: (page) => {
                      this.updateSessionMessagesPaginationFromPage(sessionId, { scope: 'main' }, page, { allowHasMoreInference: true });
                  },
                  ...this.getMessageDecryptBatchOptions(),
                  log,
              });
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
                thresholds: {
                    largeGapSeq: this.syncTuning.messageLargeGapSeq,
                    maxIncrementalPagesOnResume: this.syncTuning.messageMaxIncrementalPagesOnResume,
                    forceSnapshotOfflineMs: this.syncTuning.messageForceSnapshotOfflineMs,
                },
            });

          // §13: the on-open incremental/snapshot catch-up runs its newer fetches directly here
          // (NOT through `loadNewerMessages`), so it must bracket the catch-up signal itself —
          // otherwise opening a normal session that advanced in the background performs real
          // newer-message fetching with no "Catching up…" overlay. `do_nothing` decisions and the
          // first-ever snapshot load (handled earlier) are intentionally NOT bracketed.
          const isCatchUpWork = decision.kind !== 'do_nothing';
          const isCatchUpSessionCurrent = (): boolean => (
              this.isSessionKnownOnResolvedOwnerServer(sessionId)
          );
          const applyCatchUpDecision = () => applyMessageCatchUpDecision({
              decision,
              afterSeq,
              onIncrementalExhausted: isPinned ? 'tail_reset_latest_page' : 'defer_forward_loading',
              fetchNewerPage: async (cursor) => {
                  const result = await fetchAndApplyNewerMessages({
                      sessionId,
                      sessionEncryptionMode,
                      afterSeq: cursor,
                      limit: SESSION_MESSAGES_PAGE_SIZE,
                      getSessionEncryption: (id) => this.encryption?.getSessionEncryption(id) ?? null,
                      isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
                      request: requestMessages,
                      sessionReceivedMessages: this.sessionReceivedMessages,
                      applyMessages: (sid, messages) => {
                          if (isCatchUpSessionCurrent()) this.applyMessages(sid, messages);
                      },
                      onNormalizedMessages: (messages) => {
                          if (isCatchUpSessionCurrent()) ingestWorkspaceMutationMessages(sessionId, messages);
                      },
                      onTaskLifecycleEvent: (event) => {
                          if (isCatchUpSessionCurrent()) this.applySessionThinkingFromTaskLifecycle(sessionId, event);
                      },
                      onMessagesPage: (page) => {
                          if (!isCatchUpSessionCurrent()) return;
                          this.updateSessionMessagesPaginationFromPage(sessionId, { scope: 'main' }, page, { allowHasMoreInference: true, direction: 'newer' });
                      },
                      ...this.getMessageDecryptBatchOptions(),
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
                  const prefixMaxSeqBeforeSnapshot = this.sessionMaterializedMaxSeqById[sessionId] ?? 0;
                  await fetchAndApplyMessages({
                      sessionId,
                      sessionEncryptionMode,
                      getSessionEncryption: (id) => this.encryption?.getSessionEncryption(id) ?? null,
                      isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
                      request: requestMessages,
                      sessionReceivedMessages: this.sessionReceivedMessages,
                      applyMessages: (sid, messages) => {
                          if (isCatchUpSessionCurrent()) this.applyMessages(sid, messages);
                      },
                      onTaskLifecycleEvent: (event) => {
                          if (isCatchUpSessionCurrent()) this.applySessionThinkingFromTaskLifecycle(sessionId, event);
                      },
                      markMessagesLoaded: (sid) => {
                          if (isCatchUpSessionCurrent()) storage.getState().applyMessagesLoaded(sid);
                      },
                      onMessagesPage: (page) => {
                          if (!isCatchUpSessionCurrent()) return;
                          this.updateSessionMessagesPaginationFromPage(sessionId, { scope: 'main' }, page, { allowHasMoreInference: true });
                          this.openSessionTailDiscontinuityFromSnapshotPage(sessionId, prefixMaxSeqBeforeSnapshot, page);
                      },
                      ...this.getMessageDecryptBatchOptions(),
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
          const cached = this.externalSessionTailCursorBySessionId.get(sessionId);
          if (typeof cached !== 'undefined') {
              if (cached === null) return null;
              const parsed = ExternalSessionRefreshCursorV1Schema.safeParse(cached);
              if (parsed.success) return parsed.data;
              this.externalSessionTailCursorBySessionId.set(sessionId, null);
              saveExternalSessionTailCursor(
                  sessionId,
                  null,
                  this.getExternalSessionCursorScope(sessionId),
              );
              return null;
          }
          const persisted = loadExternalSessionTailCursor(sessionId, this.getExternalSessionCursorScope(sessionId));
          this.externalSessionTailCursorBySessionId.set(sessionId, persisted);
          return persisted;
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
          this.externalSessionTailCursorBySessionId.set(sessionId, normalized);
          saveExternalSessionTailCursor(sessionId, normalized, this.getExternalSessionCursorScope(sessionId));
          if (previous !== normalized) {
              this.notifyAcceptedExternalSessionTailCursorChanged(sessionId);
          }
      }

      private clearExternalSessionTailCursor(sessionId: string): void {
          const previous = this.getExternalSessionTailCursor(sessionId);
          this.externalSessionTailCursorBySessionId.delete(sessionId);
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
          return () => this.serverScopeGeneration === generation;
      }

      private async fetchExternalSessionMessages(
          sessionId: string,
          externalSessionLink: ReturnType<typeof readExternalSessionLink> extends infer T ? Exclude<T, null> : never,
          options?: Readonly<{ replaceExisting?: boolean }>,
      ): Promise<boolean> {
          const serverScopeIsCurrent = this.createServerScopeGuard();
          const initialSession = storage.getState().sessions[sessionId] ?? null;
          if (!initialSession) return false;
          const expectedAuthorityKey = externalSessionTranscriptAuthorityKey(
              this.resolveTranscriptAuthority(initialSession, externalSessionLink),
          );
          const shouldContinue = () => {
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
                      throw new Error(page.error);
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
                      throw new Error(tail.error);
                  }
                  return {
                      items: tail.items,
                      nextCursor: tail.nextCursor ?? null,
                      truncated: tail.truncated === true,
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

          if (options?.replaceExisting === true) {
              if (!shouldContinue()) return false;
              this.resetSessionTranscriptState(sessionId, { resetMessages: false });
          }
          if (!shouldContinue()) return false;
          if (!await this.applyExternalSessionTranscriptPages(
              sessionId,
              stagedPages,
              expectedAuthorityKey,
              { replaceExisting: options?.replaceExisting === true },
          )) {
              return false;
          }
          this.externalSessionOlderCursorBySessionId.set(sessionId, initialWindow.olderCursor);
          this.externalSessionHasMoreOlderBySessionId.set(sessionId, initialWindow.hasMoreOlder);
          if (options?.replaceExisting !== true) {
              storage.getState().applyMessagesLoaded(sessionId);
          }
          storage.getState().setSessionTranscriptLoadIssue(sessionId, null);
          return true;
      }

      /**
       * Canonical bracket for newer-catch-up work that has no other co-lifecycle to release the
       * §13 signal: the on-open incremental/snapshot catch-up (`fetchMessages`), the external-session
       * tail catch-up, and reconnect invalidation all funnel through here so the bottom-anchored
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
      ): Promise<boolean> {
          // §13 catch-up signal: surface the bottom-anchored CatchUpProgressOverlay while the resume
          // catch-up runs. `withSessionCatchUpNewer` ref-counts begin/end (see TranscriptLoadingDomain)
          // so overlapping flows for one session compose correctly and release on every return path.
          return await this.withSessionCatchUpNewer(sessionId, async () => {
              const serverScopeIsCurrent = this.createServerScopeGuard();
              const initialSession = storage.getState().sessions[sessionId] ?? null;
              if (!initialSession) return false;
              const expectedAuthorityKey = externalSessionTranscriptAuthorityKey(
                  this.resolveTranscriptAuthority(initialSession, externalSessionLink),
              );
              const shouldContinue = () => {
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
              const cursor = this.getExternalSessionTailCursor(sessionId) ?? 'tail';
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
                          throw new Error(response.error);
                      }
                      return {
                          items: response.items,
                          nextCursor: response.nextCursor ?? null,
                          truncated: response.truncated === true,
                      };
                  },
                  onItems: async (page) => {
                      if (!shouldContinue()) return;
                      stagedPages.push(page);
                  },
              });
              if (!shouldContinue()) return false;

              if (tail.truncated === true) {
                  return await this.fetchExternalSessionMessages(sessionId, externalSessionLink, {
                      replaceExisting: true,
                  });
              }
              return await this.applyExternalSessionTranscriptPages(
                  sessionId,
                  stagedPages,
                  expectedAuthorityKey,
              );
          });
      }

      private collectLoadedExternalSessionsForResume(): Array<{ sessionId: string; externalSessionLink: ExternalSessionLink }> {
          const state = storage.getState();
          const loadedExternalSessions: Array<{ sessionId: string; externalSessionLink: ExternalSessionLink }> = [];
          for (const [sessionId, messages] of Object.entries(state.sessionMessages)) {
              if (messages?.isLoaded !== true) continue;
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
                  const loadingKey = `${params.sessionId}:direct`;
                  if (this.sessionMessagesLoadingOlderByKey.has(loadingKey)) {
                      return {
                          loaded: 0,
                          hasMore: this.externalSessionHasMoreOlderBySessionId.get(params.sessionId) ?? true,
                          status: 'in_flight',
                      };
                  }

                  const knownHasMore = this.externalSessionHasMoreOlderBySessionId.get(params.sessionId);
                  if (knownHasMore === false) {
                      return { loaded: 0, hasMore: false, status: 'no_more' };
                  }

                  const cursor = this.externalSessionOlderCursorBySessionId.get(params.sessionId) ?? null;
                  if (!cursor) {
                      return { loaded: 0, hasMore: knownHasMore ?? false, status: 'not_ready' };
                  }

                  this.sessionMessagesLoadingOlderByKey.add(loadingKey);
                  try {
                      const serverScopeIsCurrent = this.createServerScopeGuard();
                      const shouldContinue = () => {
                          if (!serverScopeIsCurrent()) return false;
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
                      // replacement hydration the tail catch-up already uses
                      // (`catchUpExternalSessionMessages`): it fences the replaced authority and
                      // re-reads the source from its head. No second recovery state machine.
                      if (page.truncated === true) {
                          await this.fetchExternalSessionMessages(params.sessionId, externalSessionLink, {
                              replaceExisting: true,
                          });
                          return {
                              loaded: 0,
                              hasMore: this.externalSessionHasMoreOlderBySessionId.get(params.sessionId)
                                  ?? knownHasMore
                                  ?? true,
                              status: 'not_ready',
                          };
                      }

                      const normalizedMessages = normalizeExternalSessionTranscriptMessages(page.items, {
                          agentId: externalSessionLink.agentId,
                          remoteSessionId: externalSessionLink.remoteSessionId,
                      });
                      if (normalizedMessages.length > 0) {
                          this.applyMessages(params.sessionId, normalizedMessages, { notifyVoice: false });
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
          const tailDiscontinuity = params.scope === 'main' && normalizedBeforeSeqOverride === null
              ? this.sessionMessagesTailDiscontinuityBySessionId.get(params.sessionId) ?? null
              : null;
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
          try {
              const result = await fetchAndApplyOlderMessages({
                  sessionId: params.sessionId,
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
                  ...this.getMessageDecryptBatchOptions(),
                  log,
              });

              // The page pipeline can return its missing-session sentinel after
              // decrypt. Do not reinterpret that empty page as terminal history:
              // delete-wins must leave pagination and deferred state absent.
              if (!this.isSessionKnownOnResolvedOwnerServer(params.sessionId)) {
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
                  ...this.getMessageDecryptBatchOptions(),
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
          const windowId = normalizedSessionId && targetSeq !== null
              ? this.buildTargetWindowId(normalizedSessionId, target, targetSeq)
              : '';
          const currentWindowState = normalizedSessionId
              ? this.getSessionTargetWindowState(normalizedSessionId)
              : createInactiveSessionMessagesWindowState();
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
                  ...this.getMessageDecryptBatchOptions(),
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
          try {
              await fetchAndApplyMessages({
                  sessionId: normalizedSessionId,
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
                  ...this.getMessageDecryptBatchOptions(),
                  log,
              });
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
              this.getOrCreateMessagesSync(sessionId).invalidateCoalesced();
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
       * C6/D3: sync-owned reactive drain for the deferred-forward-loading backlog (mechanism B).
       *
       * The data layer accrues the backlog and must own when to release it. Previously the
       * release lived only in ChatList.onScroll, so a list shell that did not reproduce those
       * callbacks silently stalled newer-message catch-up. The list now only reports geometry;
       * the threshold + decision + fetch are owned here. Drains when pinned or near the bottom
       * (within the forward-prefetch threshold); a scrolled-up session is left deferred so the
       * viewport is never yanked.
       */
      public maybeDrainDeferredNewerMessages(
          sessionId: string,
          viewport: Readonly<{ isPinned: boolean; distanceFromBottomPx: number }>,
      ): void {
          if (!sessionId || !this.hasDeferredNewerMessages(sessionId)) return;
          const nearBottom = viewport.isPinned
              || viewport.distanceFromBottomPx <= this.syncTuning.transcriptForwardPrefetchThresholdPx;
          if (!nearBottom) return;
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

          const supported = this.sessionMessagesPaginationSupportedByKey.get(pagingKey);
          if (supported === false) {
              return { loaded: 0, hasMore: false, status: 'no_more' };
          }

          const afterSeq = this.sessionMaterializedMaxSeqById[sessionId] ?? 0;
          if (!afterSeq) {
              return { loaded: 0, hasMore: true, status: 'not_ready' };
          }

          this.sessionMessagesLoadingNewerByKey.add(pagingKey);
          // §13 catch-up signal: the deferred-newer backlog drain is a genuine catch-up (it only fires
          // when a missed-while-away forward backlog exists), so surface the overlay while it runs.
          storage.getState().beginSessionCatchUpNewer(sessionId);
          const requestMessages = this.createSessionMessagesRequest(sessionId);
          const session = storage.getState().sessions[sessionId] ?? null;
          const sessionEncryptionMode = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
          try {
              const result = await fetchAndApplyNewerMessages({
                  sessionId,
                  sessionEncryptionMode,
                  afterSeq,
                  limit: SESSION_MESSAGES_PAGE_SIZE,
                  getSessionEncryption: (id) => this.encryption?.getSessionEncryption(id) ?? null,
                  isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
                  request: requestMessages,
                  sessionReceivedMessages: this.sessionReceivedMessages,
                  applyMessages: (sid, messages) => this.applyMessages(sid, messages, { notifyVoice: false }),
                  onNormalizedMessages: (messages) => ingestWorkspaceMutationMessages(sessionId, messages),
                  onTaskLifecycleEvent: (event) => this.applySessionThinkingFromTaskLifecycle(sessionId, event),
                  onMessagesPage: (page) => {
                      this.updateSessionMessagesPaginationFromPage(sessionId, { scope: 'main' }, page, { allowHasMoreInference: true, direction: 'newer' });
                  },
                  ...this.getMessageDecryptBatchOptions(),
                  log,
              });

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

      private registerPushToken = async () => {
          log.log('registerPushToken');
          await registerPushTokenIfAvailable({ credentials: this.credentials, log });
    }

    private subscribeToUpdates = () => {
        // Subscribe to message updates
        apiSocket.onMessage('update', this.handleUpdate.bind(this));
        apiSocket.onMessage('ephemeral', this.handleEphemeralUpdate.bind(this));
        // Broadcast-safe session events are optional hints; ignore by default.
        apiSocket.onMessage('session', () => {});

		          apiSocket.onStatusChange((status) => {
	              if (status === 'connected') {
	                  if (this.lastSocketDisconnectedAtMs != null) {
	                      this.lastSocketOfflineDurationMs = Date.now() - this.lastSocketDisconnectedAtMs;
	                      this.sessionDraftOfflineCatchUpPending = true;
	                      this.socketOfflineCatchUpConsumedSessionIds.clear();
		                  }
		                  this.lastSocketDisconnectedAtMs = null;
		                  return;
		              }
		              if (status === 'disconnected' || status === 'error') {
		                  if (this.lastSocketDisconnectedAtMs == null) {
		                      this.lastSocketDisconnectedAtMs = Date.now();
		                      this.lastSocketOfflineDurationMs = null;
		                      this.socketOfflineCatchUpConsumedSessionIds.clear();
		                  }
		              }
		          });

          // Subscribe to connection state changes
          apiSocket.onReconnected(() => {
              publishMachineContributionRegistryProjectionReconnect();
              fireAndForget(this.resumeSync('socket-reconnect'), { tag: 'Sync.resumeSync.socket-reconnect' });
          });
      }

      private async refetchStaleTranscriptRegion(
          sessionId: string,
          staleMinSeq: number | null,
          authoritativeUpdateMessageIds: ReadonlySet<string>,
      ): Promise<ReadonlySet<string>> {
          const resolvedMessageIds = new Set<string>();
          if (typeof staleMinSeq !== 'number' || !Number.isFinite(staleMinSeq) || staleMinSeq <= 0) {
              this.getOrCreateMessagesSync(sessionId).invalidateCoalesced();
              return resolvedMessageIds;
          }
          if (this.hasFetchedSessionsSnapshotForActiveServer && !this.isSessionKnownOnResolvedOwnerServer(sessionId)) {
              return resolvedMessageIds;
          }
          const unresolvedMessageIds = new Set(authoritativeUpdateMessageIds);
          let afterSeq = Math.max(0, Math.trunc(staleMinSeq) - 1);
          const requestMessages = this.createSessionMessagesRequest(sessionId);
          const session = storage.getState().sessions[sessionId] ?? null;
          const sessionEncryptionMode = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
          try {
              while (unresolvedMessageIds.size > 0) {
                  if (!this.isSessionKnownOnResolvedOwnerServer(sessionId)) break;
                  const observedOnPage = new Set<string>();
                  const result = await fetchAndApplyNewerMessages({
                      sessionId,
                      sessionEncryptionMode,
                      afterSeq,
                      limit: SESSION_MESSAGES_PAGE_SIZE,
                      authoritativeUpdateMessageIds: unresolvedMessageIds,
                      getSessionEncryption: (id) => this.encryption?.getSessionEncryption(id) ?? null,
                      isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
                      request: requestMessages,
                      sessionReceivedMessages: this.sessionReceivedMessages,
                      applyMessages: (sid, messages) => this.applyMessages(sid, messages, { notifyVoice: false }),
                      onNormalizedMessages: (messages) => {
                          ingestWorkspaceMutationMessages(sessionId, messages);
                          for (const message of messages) {
                              if (unresolvedMessageIds.has(message.id)) {
                                  observedOnPage.add(message.id);
                              }
                          }
                      },
                      onTaskLifecycleEvent: (event) => this.applySessionThinkingFromTaskLifecycle(sessionId, event),
                      onMessagesPage: (page) => {
                          this.updateSessionMessagesPaginationFromPage(sessionId, { scope: 'main' }, page, { allowHasMoreInference: true, direction: 'newer' });
                      },
                      ...this.getMessageDecryptBatchOptions(),
                      log,
                  });
                  if (!this.isSessionKnownOnResolvedOwnerServer(sessionId)) break;

                  for (const messageId of observedOnPage) {
                      unresolvedMessageIds.delete(messageId);
                      resolvedMessageIds.add(messageId);
                  }
                  if (unresolvedMessageIds.size === 0) break;

                  const nextAfterSeq = result.page.nextAfterSeq;
                  if (
                      typeof nextAfterSeq !== 'number'
                      || !Number.isFinite(nextAfterSeq)
                      || Math.trunc(nextAfterSeq) <= afterSeq
                  ) {
                      break;
                  }
                  afterSeq = Math.trunc(nextAfterSeq);
              }
          } catch (error) {
              log.log(`Failed to refetch stale transcript region: ${error instanceof Error ? error.message : String(error)}`);
          }

          return resolvedMessageIds;
	      }

      private async repairDeferredStaleTranscriptRegion(
          sessionId: string,
          staleMinSeq: number | null,
          authoritativeUpdateMessageIds: ReadonlySet<string>,
      ): Promise<void> {
          const resolvedMessageIds = await this.refetchStaleTranscriptRegion(
              sessionId,
              staleMinSeq,
              authoritativeUpdateMessageIds,
          );
          if (resolvedMessageIds.size === 0) return;
          this.deferredTranscriptState = clearResolvedStaleTranscriptMessageIds(
              this.deferredTranscriptState,
              sessionId,
              resolvedMessageIds,
          );
      }

      private async repairSessionTranscriptRevision(
          repair: Readonly<{ sessionId: string; minSeq: number; messageIds: readonly string[] }>,
      ): Promise<void> {
          const resolvedMessageIds = await this.refetchStaleTranscriptRegion(
              repair.sessionId,
              repair.minSeq,
              new Set(repair.messageIds),
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
       */
      public retireLocalSession(sessionId: string): void {
          handleDeleteSessionSocketUpdate({
              sessionId,
              dropSocketSessionWork,
              invalidateSessionHydration: this.invalidateDeletedSessionHydration,
              resetSessionTranscriptState: (targetSessionId) => this.resetSessionTranscriptState(targetSessionId),
              deleteSession: (targetSessionId) => storage.getState().deleteSession(targetSessionId),
              removeSessionEncryption: (targetSessionId) => this.encryption?.removeSessionEncryption(targetSessionId),
              removeProjectManagerSession: (targetSessionId) => projectManager.removeSession(targetSessionId),
              clearScmStatusForSession: (targetSessionId) => scmStatusSync.clearForSession(targetSessionId),
              log,
          });
      }

      private resetSessionTranscriptState(
          sessionId: string,
          options?: Readonly<{ resetMessages?: boolean }>,
      ): void {
          releaseTranscriptStreamSegmentAssemblyForSession(sessionId);
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
      }): Promise<ResumeViaChangesOutcome> {
          const CHANGES_PAGE_LIMIT = this.syncTuning.changesPageLimit;
          const afterCursor = this.changesCursor ?? '0';
          const shouldContinue = opts.shouldContinue ?? (() => true);
          const cursorScope = this.getChangesCursorScope();
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
	          const forceSnapshotRefresh = offlineForMs >= this.syncTuning.messageForceSnapshotOfflineMs;

          const catchUp = await runSocketReconnectCatchUpViaChanges({
              credentials: this.credentials,
              accountId: opts.accountId,
              afterCursor,
              changesPageLimit: CHANGES_PAGE_LIMIT,
              maxChangesPagesPerResume: this.syncTuning.changesMaxPagesPerResume,
              forceSnapshotRefresh,
                fetchChanges,
                fetchCurrentCursor: fetchCurrentChangesCursor,
                checkpointCursor: async (cursor, context) => {
                    if (!canWriteCursor()) {
                        return false;
                    }
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
	                    await this.snapshotRefreshOnResume({ mode: 'long-offline', reason: 'snapshot-refresh' });
	                    resetActivePluginCollectionUiQueryWatches();
	                    resetActiveScopedPluginSettingsChangeWatches();
	                },
                applyPlanned: async (planned) => {
                    return await applyPlannedChangeActions({
                        planned,
                        credentials: this.credentials,
                        isSessionMessagesLoaded: (sessionId) => storage.getState().sessionMessages[sessionId]?.isLoaded === true,
                        getSessionMaterializedMaxSeq: (sessionId) => this.sessionMaterializedMaxSeqById[sessionId] ?? 0,
                        publishPluginCollectionChanges: (changes) => {
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
                            if (this.pluginAvailabilityProjectionHydrator.invalidate(changes)) {
                                // AccountChange is level-triggered. Withdraw the old
                                // projection synchronously, then let its one
                                // coalesced owner rehydrate before consumers can
                                // mistake stale release facts for current ones.
                                clearPluginAccountAvailabilityProjection();
                                this.pluginAvailabilitySync.invalidateCoalesced();
                            }
                        },
                        invalidate: {
                            settings: () => this.settingsSync.invalidateAndAwait(),
                            profile: () => this.profileSync.invalidateAndAwait(),
                            machines: async () => {
                                await this.machinesSync.invalidateAndAwait();
                                refreshedByCatchUp.machines = true;
                            },
                            artifacts: () => this.artifactsSync.invalidateAndAwait(),
                            friends: () => this.friendsSync.invalidateAndAwait(),
                            friendRequests: () => this.friendRequestsSync.invalidateAndAwait(),
                            feed: () => this.feedSync.invalidateAndAwait(),
                            automations: () => this.automationsSync.invalidateAndAwait(),
                            pets: () => this.fetchAccountPets(),
                            sessions: async ({ requiredHydrationSessionIds, prioritizeSessionIds }) => {
                                await this.fetchSessions({
                                    awaitSessionListHydration: true,
                                    requiredHydrationSessionIds,
                                    prioritizeSessionIds,
                                });
                                refreshedByCatchUp.sessions = true;
                            },
                            sessionFolderAssignments: async (sessionIds) => {
                                const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
                                if (!serverId) {
                                    throw new Error('Cannot refresh session folder assignments without an active server');
                                }
                                await fetchAndApplySessionFolderAssignments({
                                    credentials: this.credentials,
                                    serverId,
                                    sessionIds,
                                });
                            },
                            todos: () => this.todosSync.invalidateAndAwait(),
                        },
                        refreshSessionOrganization: async (plan) => {
                            const serverSnapshot = getActiveServerSnapshot();
                            const serverId = String(serverSnapshot.serverId ?? '').trim();
                            if (!serverId) {
                                throw new Error('Cannot refresh session organization without an active server');
                            }
                            await fetchAndApplySessionOrganizationSnapshot({
                                credentials: this.credentials,
                                serverId,
                                serverUrl: serverSnapshot.serverUrl,
                                request: {
                                    includeFolders: plan.includeFolders,
                                    includeTags: plan.includeTags,
                                    includeLabels: plan.includeLabels,
                                    includeAttentionStandings: true,
                                    assignmentSessionIds: plan.assignmentSessionIds,
                                    folderIds: plan.folderIds,
                                    tagIds: plan.tagIds,
                                    orderScopes: plan.orderScopes,
                                },
                            });
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
                        materializeSessionDraft: async (address) => {
                            const scope = getActiveServerAccountScope();
                            if (!scope || !shouldContinue()) {
                                throw new Error('Session draft scope changed before materialization');
                            }
                            await materializeExactSessionDraft(scope, address);
                            if (
                                !shouldContinue()
                                || !areServerAccountScopesEqual(getActiveServerAccountScope(), scope)
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
          const sourceServerId = String(getActiveServerSnapshot().serverId ?? '').trim() || null;
          const shouldContinue = this.createServerScopeGuard();
          await handleSocketUpdate({
              update,
              encryption: this.encryption,
              settingsSecretsKey: this.settingsSecretsKey,
              settingsSecretsReadKeys: this.settingsSecretsReadKeys,
              settingsScope: this.pendingSettingsScope,
              sourceServerId,
              shouldContinue,
              onAccountChangeWake: () => {
                  this.requestAccountChangeCatchUp();
              },
              artifactDataKeys: this.artifactDataKeys,
              applySessions: (sessions) => this.applySessions(sessions),
	              fetchSessions: () => {
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
              onReadyProjectionAdvance: (sessionId, seq) => this.notifyReadyProjectionAdvance(sessionId, seq),
              onMessageGapDetected: (sessionId, _info) => {
                  this.getOrCreateMessagesSync(sessionId).invalidateCoalesced();
              },
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

    private handleEphemeralUpdate = (update: unknown) => {
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
        const sourceServerId = String(getActiveServerSnapshot().serverId ?? '').trim() || null;
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
        if (!requestCursor) {
            return;
        }
        const selectedAuthority = this.resolveTranscriptAuthority(session, externalSessionLink);
        if (selectedAuthority.kind !== 'live_agent') {
            return;
        }
        const expectedAuthorityKey = externalSessionTranscriptAuthorityKey(selectedAuthority);

        if (!shouldContinue()) return;
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
                replaceExisting: true,
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
        options?: { notifyVoice?: boolean; notifyActivity?: boolean; replaceExisting?: boolean }
    ) => {
        const session = storage.getState().sessions[sessionId] ?? null;
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
            if (notifyVoice && m.length > 0) {
                voiceHooks.onMessages(sessionId, m);
            }
            const latestReadyEventSeq = (result as { latestReadyEventSeq?: number }).latestReadyEventSeq;
            if (result.hasReadyEvent && this.shouldNotifyReadySeq(sessionId, latestReadyEventSeq)) {
                if (notifyVoice) {
                    voiceHooks.onReady(sessionId, m);
                }
                if (notifyActivity) {
                    notifyActivityReady(sessionId, m);
                }
            }
        }
        return result;
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
        options?: { allowHasMoreInference?: boolean; direction?: 'older' | 'newer' },
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
            const pagingKey = this.buildSessionMessagesPaginationKey({ sessionId, scope: 'main' });
            this.sessionMessagesHasMoreOlderByKey.set(pagingKey, true);
        } else {
            this.sessionMessagesTailDiscontinuityBySessionId.delete(sessionId);
        }
        if (previous === record) return;
        storage.getState().setSessionTailContiguousFloorSeq(sessionId, record ? record.walkCursor : null);
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
            prev,
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
        const active = storage.getState().getActiveSessions();
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
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
        const resolvedAuthority = await captureSessionRequestAuthorityForServerAccountScope({
            scope,
            activeRequest: (path, init) => apiSocket.request(path, init),
        });
        if (resolvedAuthority.context.token !== activeCredentials.token) {
            throw new Error('Voice transcript persistence server-account credentials changed');
        }
        const authority: ServerAccountSessionRequestAuthority = {
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
                    this.retireLocalSession(input.sessionId);
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
    };

    private commitAckedSessionMessage(
        sessionId: string,
        committed: NormalizedMessage,
        options?: Readonly<{ advanceReadCursor?: boolean }>,
    ): void {
        this.applyMessages(sessionId, [committed]);
        const seq = committed.seq;
        if (typeof seq !== 'number' || !Number.isFinite(seq)) return;

        this.markSessionMaterializedMaxSeq(sessionId, seq);
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

    private shouldNotifyReadySeq(sessionId: string, seq: number | null | undefined): boolean {
        if (typeof seq !== 'number' || !Number.isFinite(seq)) return true;
        const normalizedSeq = Math.max(0, Math.trunc(seq));
        const previousSeq = this.notifiedReadySeqBySessionId[sessionId] ?? -1;
        if (normalizedSeq <= previousSeq) return false;
        this.notifiedReadySeqBySessionId = {
            ...this.notifiedReadySeqBySessionId,
            [sessionId]: normalizedSeq,
        };
        return true;
    }

    private notifyReadyProjectionAdvance(sessionId: string, seq: number): void {
        if (!this.shouldNotifyReadySeq(sessionId, seq)) return;
        voiceHooks.onReady(sessionId, []);
        notifyActivityReady(sessionId, []);
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
                voiceHooks.onSessionOffline(s.id, s.metadata ?? undefined);
            }
        }
        for (let s of newActive) {
            if (!wasActive.has(s.id)) {
                voiceHooks.onSessionOnline(s.id, s.metadata ?? undefined);
            }
        }
    }

}

// Global singleton instance
export const sync = new Sync();

//
// Init sequence
//

let isInitialized = false;
export async function syncCreate(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }
    isInitialized = true;
    await syncInit(credentials, false);
}

export async function syncRestore(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }
    isInitialized = true;
    await syncInit(credentials, true);
}

export async function syncSwitchServer(credentials: AuthCredentials | null): Promise<void> {
    if (!credentials) {
        if (isInitialized) {
            sync.disconnectServer();
            isInitialized = false;
        }
        return;
    }

    if (!isInitialized) {
        await syncCreate(credentials);
        return;
    }

    await sync.switchServer(credentials);
}

async function syncInit(credentials: AuthCredentials, restore: boolean) {

    // Initialize sync engine
    const encryption = isTokenOnlyAuthCredentials(credentials)
        ? null
        : await createEncryptionFromAuthCredentials(credentials);

    // Initialize socket connection
    apiSocket.initialize({ endpoint: getActiveServerSnapshot().serverUrl, token: credentials.token }, encryption);

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
        await sync.restore(credentials, encryption);
    } else {
        await sync.create(credentials, encryption);
    }
}

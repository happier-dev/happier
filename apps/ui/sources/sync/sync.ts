import Constants from 'expo-constants';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { ensureSessionRuntimeForPendingInput } from '@/sync/ops';
import { type AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    ClientVersionCheckRequestV1Schema,
    ClientVersionCheckResponseV1Schema,
    SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY,
    isRecoveredHistoryTranscriptObservationProvenance,
    readPendingLocalId,
    type DirectTranscriptRawMessageV1,
    type PendingDeliveryBlockedReason,
    type SessionUserMessageSendResponse,
} from '@happier-dev/protocol';
import { readCurrentUiClientCompatibilityDeclaration } from '@/sync/runtime/clientCompatibility/uiClientCompatibility';
import { applyUiClientUpgradeRequired } from '@/sync/runtime/clientCompatibility/uiClientUpgradeRequired';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import {
    clearActiveViewingSessionsForServerScopeReset,
    getActiveViewingSessionId,
    getVisibleSessionIds,
} from '@/sync/domains/session/activeViewingSession';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { storage } from './domains/state/storage';
import { ApiMessage } from './api/types/apiTypes';
import type { ApiEphemeralActivityUpdate } from './api/types/apiTypes';
import { Session, Machine, MetadataSchema, type Metadata } from './domains/state/storageTypes';
import { InvalidateSync } from '@/utils/sessions/sync';
import { PauseController } from '@/utils/timing/pauseController';
import {
    invalidateAllServerReachabilitySupervisors,
    setServerReachabilityNetworkAllowed,
    stopServerReachabilitySupervisors,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { bindManagedConnectionStateToRealtimeStore } from '@/sync/runtime/connectivity/bindManagedConnectionStateToRealtimeStore';
import { assertEndpointAuthenticatedWithProbe } from '@/sync/runtime/connectivity/assertEndpointAuthenticatedWithProbe';
import { isTerminalAuthError } from '@/sync/runtime/connectivity/authErrors';
import { isTransientConnectivityError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { isSocketIoAckTimeoutError } from '@/sync/runtime/socketIoAckTimeout';
import { applyInitialAppStateConnectivityGate } from '@/sync/runtime/connectivity/appStateConnectivityGate';
import { loadSyncTuning, type SyncTuning } from '@/sync/runtime/syncTuning';
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
import {
    acknowledgeStaleTranscriptRepair,
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
import { normalizeSessionListAttentionPromotionMode } from '@/sync/domains/session/listing/attentionPromotion/sessionListAttentionPromotion';
import {
    buildSessionOrganizationProjection,
    buildSessionOrganizationSnapshotFromProjection,
    listSessionOrganizationRequiredHydrationSessionIds,
    type SessionOrganizationProjection,
} from '@/sync/domains/session/organization';
import { fetchAndApplySessionOrganizationSnapshot } from '@/sync/ops/sessionOrganization';
import { createSessionListOrganizationSnapshotRequest } from '@/sync/engine/sessions/sessionListOrganizationSnapshotRequest';
import { ActivityUpdateAccumulator, type ActivityUpdateAccumulatorFlushOptions } from './reducer/activityUpdateAccumulator';
import { MachineActivityAccumulator, type MachineActivityUpdate } from './reducer/machineActivityAccumulator';
import { randomUUID } from '@/platform/randomUUID';
import { Platform, AppState } from 'react-native';
import { resolveSentFrom } from './domains/messages/sentFrom';
import { NormalizedMessage, normalizeRawMessage, RawRecord, RawRecordSchema } from './typesRaw';
import { applySettings, Settings, settingsDefaults, settingsParse, SUPPORTED_SCHEMA_VERSION } from './domains/settings/settings';
import { Profile, profileDefaults } from './domains/profiles/profile';
import {
    loadSessionMaterializedMaxSeqById,
    saveSessionMaterializedMaxSeqById,
    loadChangesCursor,
    loadDirectSessionTailCursor,
    loadProfile as loadPersistedProfile,
    pruneStaleInstanceChangesCursors,
    saveDirectSessionTailCursor,
    type ChangesCursorScope,
} from './domains/state/persistence';
import {
    loadPendingAccountSettings,
    savePendingAccountSettings,
} from './domains/state/accountSettingsPersistence';
import {
    assertSafePendingIdPathSegment,
    listPendingOutboxSessionIds,
} from './domains/state/pendingOutboxPersistence';
import {
    deletePersistedSessionViewport,
    loadPersistedSessionViewports,
    upsertPersistedSessionViewport,
} from './domains/state/sessionViewportPersistence';
import { sessionViewportStorageKey } from './domains/state/sessionLocalStateKeys';
import { getActiveServerAccountScope } from './domains/scope/activeServerAccountScope';
import {
    areServerAccountScopesEqual,
    createServerAccountScope,
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from './domains/scope/serverAccountScope';
import { getPendingQueueWakeResumeOptions } from './domains/pending/pendingQueueWake';
import {
    areAccountSettingsScopesEqual,
    createAccountSettingsScope,
    type AccountSettingsScope,
} from './domains/settings/scope/accountSettingsScope';

type LoadOlderMessagesOptions = Readonly<{
    limit?: number;
}>;

class PendingOutboxSessionNotHydratedError extends Error {}

type ResolvedPendingQueueOwnerContext = Readonly<{
    outboxScope: ServerAccountScope;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    enqueueEncryption: PendingQueueEncryption;
    readEncryption: PendingQueueReadEncryption;
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

import { createSyncGenerationGuard } from './domains/scope/syncGenerationGuard';
import {
    clearWarmCacheAccountScope,
    loadMachineDisplayWarmCacheEntries,
    loadSessionListWarmCacheEntries,
    loadSessionOrganizationWarmCacheSnapshot,
    readPersistedSessionListWarmCacheEntries,
    resolveWarmCacheAccountScope,
    saveSessionOrganizationWarmCacheSnapshot,
    setWarmCacheAccountScope,
} from './domains/state/warmCachePersistence';
import {
    buildMachineDisplayCacheEntriesFromRenderables,
    buildMachineDisplayRenderableFromCacheEntry,
    buildSessionListCacheEntriesFromRenderables,
    buildSessionListRenderableFromCacheEntry,
} from './domains/state/warmCacheAdapters';
import {
    isTerminalTaskLifecycleEventType,
    type TaskLifecycleEvent,
} from '@/sync/engine/sessions/taskLifecycle';
import { initializeTracking, tracking } from '@/track';
import { applyCrashReportsOptOut } from '@/utils/system/sentry';
import { parseToken } from '@/utils/auth/parseToken';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { RevenueCat } from './domains/purchases';
import { purchasesDefaults } from './domains/purchases/purchases';
import { trackPaywallPresented, trackPaywallPurchased, trackPaywallCancelled, trackPaywallRestored, trackPaywallError } from '@/track';
import { getActiveServerSnapshot } from './domains/server/serverRuntime';
import {
    areServerProfileIdentifiersEquivalent,
    getServerProfileById,
    getServerProfileLegacyServerIds,
} from './domains/server/serverProfiles';
import { migratePendingSetupIntentScopes } from './domains/pending/pendingSetupIntent';
import { migratePendingTerminalConnectScopes } from './domains/pending/pendingTerminalConnect';
import { migratePendingNotificationActionScopes } from './domains/pending/pendingNotificationAction';
import { migratePendingNotificationNavScopes } from './domains/pending/pendingNotificationNav';
import type { SettingsAnalyticsSource } from '@/track/settingsAnalytics/types';
import { setActiveServerSessionListCache } from './store/sessionListCache';
import { config } from '@/config';
import { log } from '@/log';
import { t } from '@/text';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { ingestWorkspaceMutationMessages } from '@/scm/refresh/workspaceMutationIngestionRuntime';
import { projectManager } from './runtime/orchestration/projectManager';
import { clearMountedSessionRealtimeScmConsumerScopes } from './runtime/sessionRealtimeScmConsumers';
import { voiceHooks } from '@/voice/context/voiceHooks';
import { notifyActivityReady } from '@/activity/notifications/runtime/activityLocalNotificationBus';
import { Message } from './domains/messages/messageTypes';
import { EncryptionCache } from './encryption/encryptionCache';
import { nowServerMs } from './runtime/time';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { computeNextReadStateV1 } from './domains/state/readStateV1';
import { updateSessionMetadataWithRetry as updateSessionMetadataWithRetryRpc, type UpdateMetadataAck } from './domains/session/metadata/updateSessionMetadataWithRetry';
import type { ArtifactHeader, DecryptedArtifact } from './domains/artifacts/artifactTypes';
import type { Automation, AutomationRun } from './domains/automations/automationTypes';
import { getUserProfile } from './api/social/apiFriends';
import {
    createAutomation as createAutomationApi,
    deleteAutomation as deleteAutomationApi,
    pauseAutomation as pauseAutomationApi,
    replaceAutomationAssignments as replaceAutomationAssignmentsApi,
    resumeAutomation as resumeAutomationApi,
    runAutomationNow as runAutomationNowApi,
    type AutomationAssignmentInput,
    type AutomationCreateInput,
    type AutomationPatchInput,
    updateAutomation as updateAutomationApi,
} from './api/automations/apiAutomations';
import { kvBulkGet } from './api/account/apiKv';
import { FeedItem } from './domains/social/feedTypes';
import { UserProfile } from './domains/social/friendTypes';
import { buildSendMessageMeta } from './domains/messages/buildSendMessageMeta';
import { HappyError } from '@/utils/errors/errors';
import {
    createAccountSettingsFailedStatus,
    createAccountSettingsIdleStatus,
    createAccountSettingsRetryingStatus,
    createAccountSettingsSyncedStatus,
} from './domains/settings/accountSettingsSyncStatus';
import {
    dbgSettings,
    isSettingsSyncDebugEnabled,
    summarizeSettings,
    summarizeSettingsDelta,
    warnSettings,
} from './domains/settings/debugSettings';
import { stripLocalOnlyAccountSettings } from './domains/settings/localOnlyAccountSettings';
import {
    decryptSecretValueWithKeys,
    deriveSettingsSecretsKeySet,
    encryptSecretString,
    sealSecretsDeep,
} from './encryption/secretSettings';
import { didControlReturnToMobile } from './domains/session/control/controlledByUserTransitions';
import type { SessionMessageDirectBypassReason } from './domains/session/control/submitMode';
import { buildResumeCapabilityOptionsFromUiState } from '@/agents/registry/registryUiBehavior';
import { submitSessionUserMessage } from './domains/session/input/submitSessionUserMessage';
import type {
    SessionMessageCallerSurface,
    SessionSubmitPort,
} from './domains/session/input/types';
import type { SavedSecret } from './domains/settings/savedSecretTypes';
import type { PermissionMode } from './domains/permissions/permissionTypes';
import { getPermissionModeOverrideForSpawn } from './domains/permissions/permissionModeOverride';
import { scheduleDebouncedPendingSettingsFlush } from './engine/pending/pendingSettings';
import {
    applySettingsLocalDelta,
    syncSettings as syncSettingsEngine,
    type SyncSettingsParams,
} from './engine/settings/syncSettings';
import { removeCommittedPendingSettings } from './engine/settings/writeback/accountSettingsRawDeltaMerge';
import {
    prepareAccountSettingsForDaemonSpawn as prepareAccountSettingsForDaemonSpawnEngine,
    type PreparedAccountSettingsForDaemonSpawn,
} from './engine/settings/prepareAccountSettingsForDaemonSpawn';
import { registerAccountSettingsDaemonSpawnPreparation } from './ops/accountSettingsDaemonSpawnPreparation';
import { getOfferings as getOfferingsEngine, presentPaywall as presentPaywallEngine, purchaseProduct as purchaseProductEngine, syncPurchases as syncPurchasesEngine } from './engine/purchases/syncPurchases';
import { fetchChanges, fetchCurrentChangesCursor } from './api/session/apiChanges';
import {
    resolveWebSyncClientIdentity,
    type WebSyncClientIdentity,
} from '@/sync/runtime/webSyncClientIdentity';
import { decideChangesCursorCheckpoint } from '@/sync/runtime/orchestration/changesCursorCheckpoint';
import {
    evaluateSafeCursorLagTripwire,
    rememberBlockedCursorLag,
    type SafeCursorLagTripwireState,
} from '@/sync/runtime/orchestration/safeCursorLagTripwire';
import { runWithInFlightDedupe } from '@/sync/runtime/orchestration/runWithInFlightDedupe';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
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
import { decideMessageCatchUpPolicy } from '@/sync/runtime/orchestration/messageCatchUpPolicy';
import { installSessionRealtimeTranscriptSuppressionGlobal } from '@/sync/runtime/sessionRealtimeTranscriptSuppression';
import { resolveSessionLiveConsumption } from '@/sync/runtime/sessionLiveConsumption';
import {
    readMountedSessionTranscriptConsumerSessionIdsForRetention,
    subscribeSessionTranscriptConsumerReleases,
} from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import {
    createSessionTranscriptRetentionController,
    type SessionTranscriptRetentionController,
} from './engine/sessions/sessionTranscriptRetention';
import {
    isVersionSupported,
    MINIMUM_CLI_SESSION_USER_MESSAGE_RPC_VERSION,
} from '@/utils/system/versionUtils';
import { applyMessageCatchUpDecision } from '@/sync/runtime/orchestration/applyMessageCatchUpDecision';
import { readDirectSessionLink, type DirectSessionLink } from '@/sync/domains/session/directSessions/readDirectSessionLink';
import { normalizeDirectTranscriptMessages } from '@/sync/runtime/directSessions/normalizeDirectTranscriptMessages';
import { readStoredSessionRawRecord } from '@/sync/runtime/readStoredSessionContent';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { emitSessionMetadataUpdateWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/emitSessionMetadataUpdateWithServerScope';
import { fetchSessionByIdWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope';
import type {
    EnsureSessionVisibleForRouteResult,
    SessionRouteHydrationMissingCause,
    SessionRouteHydrationRetryCause,
} from '@/sync/domains/session/sessionRouteHydrationState';
import {
    createSessionRequestForResolvedServerScope,
    createSessionRequestWithServerScope,
    resolveSessionRequestForServerAccountScope,
} from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';
import { resolveServerScopedSessionContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';
import { resolveScopedPendingSessionEncryption } from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedPendingSessionEncryption';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { sessionRpcWithPreferredSessionScope } from '@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope';
import { sessionRpcWithServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import {
    machineDirectSessionTranscriptPage,
    machineDirectSessionTranscriptReadAfter,
} from '@/sync/ops/machineDirectSessions';
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
import { fetchAndApplyAccountPets } from './engine/pets/syncAccountPets';
import { applyTodoSocketUpdates as applyTodoSocketUpdatesEngine, fetchTodos as fetchTodosEngine } from './engine/todos/syncTodos';
import { planSyncActionsFromChanges } from './runtime/orchestration/changesPlanner';
import { applyPlannedChangeActions } from './runtime/orchestration/changesApplier';
import { runSocketReconnectCatchUpViaChanges } from './runtime/orchestration/socketReconnectViaChanges';
import {
    SessionDraftRuntimeHydrationGate,
    materializeVisibleExistingSessionDraft,
    materializeSessionDraftSocketWake,
    parseSessionDraftSocketWake,
} from './runtime/orchestration/sessionDraftSyncRuntime';
import { verifyChangesCursorMaterializationProofs } from './runtime/orchestration/cursorMaterializationDetector';
import { fetchAndApplySessionFolderAssignments } from '@/sync/ops/sessionOrganization';
import { readMachineControlTargetForSession, readMachineTargetForSession } from './ops/sessionMachineTarget';
import { deriveSessionAuthoringSnapshot } from './domains/sessionAuthoring/deriveSessionAuthoringSnapshot';
import { socketEmitWithAckFallback } from './engine/socket/socketEmitWithAckFallback';
import { publishPermissionModeToMetadata as publishPermissionModeToMetadataEngine } from './engine/overrides/permissionModePublish';
import { publishAcpSessionModeOverrideToMetadata as publishAcpSessionModeOverrideToMetadataEngine } from './engine/overrides/acpSessionModeOverridePublish';
import { publishModelOverrideToMetadata as publishModelOverrideToMetadataEngine } from './engine/overrides/modelOverridePublish';
import { publishSessionModelsSeedToMetadata as publishSessionModelsSeedToMetadataEngine } from './engine/overrides/sessionModelsSeedPublish';
import type { PreflightModelList } from '@/sync/domains/models/modelOptions';
import { getModelScopedConfigTombstonesV1Supported } from './domains/state/agentStateCapabilities';
import { publishAcpConfigOptionOverrideToMetadata as publishAcpConfigOptionOverrideToMetadataEngine, type AcpConfigOptionOverrideValueId } from './engine/overrides/acpConfigOptionOverridePublish';
import { RPC_ERROR_CODES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotAvailableError, readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { MessageAckResponseSchema, type MessageAckResponse } from '@happier-dev/protocol/updates';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { getRandomBytes } from '@/platform/cryptoRandom';
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
import { serverFetch } from './http/client';
import { logNativeUpdateFetchFailure } from '@/sync/runtime/nativeUpdate/logNativeUpdateFetchFailure';
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
import { fetchAndApplyTargetWindowMessages, clearTargetWindowRequestEpochs } from './engine/sessions/fetchAndApplyTargetWindowMessages';
import {
    buildSessionListFetchHydrationTelemetryFields,
    type SessionListFetchHydrationTelemetrySource,
} from './engine/sessions/sessionListHydrationTelemetry';
import { normalizeSessionListHydrationSessionIds } from './engine/sessions/sessionListHydrationPriority';
import {
    fetchUserMessageHistoryPage,
    USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE,
    type FetchUserMessageHistoryPageResult,
} from './engine/sessions/fetchUserMessageHistoryPage';
import { fetchAndApplySessionById } from './engine/sessions/sessionById';
import { getForkedTranscriptSnapshotCached } from './domains/sessionFork/forkedTranscriptSnapshot';
import { resolveSessionMessageRouteId } from './domains/messages/messageRouteIds';
import {
    computeForkedTranscriptHasMoreOlder,
    resolveNextForkedTranscriptLoadOlderRequest,
} from './domains/sessionFork/forkedTranscriptPaging';
import {
    blockPendingDeliveryV2,
    deleteDiscardedPendingMessageV2,
    deletePendingMessageV2,
    discardPendingMessageV2,
    dismissPendingDeliveryV2,
    enqueuePendingMessageV2,
    fetchAndApplyPendingMessagesV2,
    markPendingDeliveryHandledV2,
    sendPendingDeliveryAsNewV2,
    reorderPendingMessagesV2,
    replayPersistedPendingOutboxForSession,
    retryPendingOutboxOperationV2,
    restoreDiscardedPendingMessageV2,
    setPendingMessageSendState,
    updatePendingMessageV2,
    updatePendingRequestedActionV2,
    type PendingMessageEnqueueResultV2,
    type PendingQueueEncryption,
    type PendingQueueReadEncryption,
} from './engine/pending/pendingQueueV2';
import {
    resolvePendingInputServerWireMode,
    type PendingInputServerWireMode,
} from './engine/pending/pendingInputServerWireContract';
import {
    isPendingOutboxProjectionForIdentity,
    pendingOutboxProjectionIdentityKey,
} from './engine/pending/pendingOutboxProjectionIdentity';
import {
    flushActivityUpdates as flushActivityUpdatesEngine,
    flushMachineActivityUpdates as flushMachineActivityUpdatesEngine,
    handleEphemeralSocketUpdate,
    handleSocketUpdate,
    parseUpdateContainer,
} from './engine/socket/socket';
import { actionOperationStore } from './domains/actionOperations/actionOperationStore';
import { openActionOperationRevisionEphemeral } from './domains/actionOperations/actionOperationEphemeral';

const SESSION_LIST_BACKGROUND_HYDRATION_SCROLL_SETTLE_MS = 180;
const WEB_INITIAL_SESSION_MESSAGES_PAGE_SIZE = 12;

/**
 * How long a successful `/v1/version` answer stays fresh.
 *
 * The answer depends on the installed app version and the server's published minimum, neither of
 * which can change while this process is foregrounded, so a burst of app switches asked the same
 * question repeatedly. Longer than the 30 s machines window because the fact is far less volatile,
 * and short enough that an `upgrade-required` transition is still picked up in the same sitting.
 */
const NATIVE_UPDATE_CHECK_STALE_MS = 15 * 60_000;

export type SessionViewportSource = 'default' | 'observed';

export type SessionViewportAnchorKind = 'message' | 'toolGroup' | 'item';

export type SessionViewportAnchorSnapshot = Readonly<{
    kind: SessionViewportAnchorKind;
    messageId?: string | null;
    /** Message seq stamped at persistence time; present on hydrated anchors (identity-first restore). */
    seq?: number | null;
    itemId: string;
    itemOffsetPx: number;
    capturedAtMs: number;
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
    /**
     * Distance metadata for observed viewports. Omitted (or non-finite) means
     * "position unknown": only the pin/detach intent applies and the previously
     * stored offset metadata is preserved (live-tail geometry when none exists).
     */
    offsetY?: number;
    shouldPersistViewport?: boolean;
    shouldRestoreViewport?: boolean;
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

type ReadyNotificationProgress = Readonly<{
    seq: number;
    transcriptNotified: boolean;
}>;

function createDefaultMessageTransport(): SyncMessageTransport {
    return {
        emitWithAck: <T>(event: string, payload: unknown, opts?: { timeoutMs?: number }) =>
            apiSocket.emitWithAck<T>(event, payload, opts),
        send: (event: string, payload: unknown) => apiSocket.send(event, payload),
    };
}

function hasAuthoritativeSessionRouteData(session: Session | null | undefined): boolean {
    return Boolean(session?.metadata != null);
}

function isFallbackSafeSessionUserMessageRpcError(error: unknown): boolean {
    // Fallback here is compatibility with older daemons / preview CLIs that may expose
    // the active-session send surface under a different method set or during reconnect churn.
    if (isRpcMethodNotAvailableError(error) || readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_FOUND) {
        return true;
    }

    const errorMessage = error instanceof Error ? error.message : String(error ?? '');
    if (errorMessage === 'Method not found' || errorMessage === 'Socket connect timeout') {
        return true;
    }

    const normalizedMessage = errorMessage.toLowerCase();
    return (
        normalizedMessage.includes('connect_error')
        // Default sends may still fall back to the socket commit path for older daemons
        // and transient startup transport churn. Required runtime delivery handles these
        // errors by retrying instead, because transcript commit is not provider delivery.
        || normalizedMessage.includes('econnreset')
        || normalizedMessage.includes('econnrefused')
    );
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

async function assertActiveEndpointAuthenticated(options?: Readonly<{ forceProbe?: boolean }>): Promise<void> {
    const activeServer = getActiveServerSnapshot();
    await assertEndpointAuthenticatedWithProbe({
        serverId: activeServer.serverId,
        serverUrl: activeServer.serverUrl,
        forceProbe: options?.forceProbe === true,
    });
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

function isKnownServerId(serverId: string, activeServerId: string): boolean {
    return areServerProfileIdentifiersEquivalent(serverId, activeServerId) || getServerProfileById(serverId) !== null;
}

function resolveMessageRouteHydrationServerId(sessionId: string, explicitServerIdRaw: unknown): string | undefined {
    const activeServerId = normalizeScopedServerId(getActiveServerSnapshot().serverId);
    const explicitServerId = normalizeScopedServerId(explicitServerIdRaw);
    if (explicitServerId && activeServerId && isKnownServerId(explicitServerId, activeServerId)) {
        return explicitServerId;
    }

    const cachedServerId = normalizeScopedServerId(resolveServerIdForSessionIdFromLocalCache(sessionId));
    if (cachedServerId && activeServerId && isKnownServerId(cachedServerId, activeServerId)) {
        return cachedServerId;
    }

    return activeServerId;
}

function createEnsureSessionVisibleAvailableResult(
    sessionId: string,
    serverId?: string,
): EnsureSessionVisibleForRouteResult {
    return serverId
        ? { kind: 'available', sessionId, serverId }
        : { kind: 'available', sessionId };
}

function createEnsureSessionVisibleMissingResult(
    sessionId: string,
    cause: SessionRouteHydrationMissingCause,
    serverId?: string,
): EnsureSessionVisibleForRouteResult {
    return serverId
        ? { kind: 'missing', sessionId, serverId, cause }
        : { kind: 'missing', sessionId, cause };
}

function createEnsureSessionVisibleRetryableResult(
    sessionId: string,
    cause: SessionRouteHydrationRetryCause,
    serverId?: string,
): EnsureSessionVisibleForRouteResult {
    return serverId
        ? { kind: 'retryable_failure', sessionId, serverId, cause }
        : { kind: 'retryable_failure', sessionId, cause };
}

function mapSessionByIdTerminalCodeToMissingCause(code: string): SessionRouteHydrationMissingCause | null {
    if (code === 'not_found' || code === 'unauthorized' || code === 'forbidden') {
        return code;
    }
    return null;
}

function mapSessionByIdRetryableCodeToCause(code: string): SessionRouteHydrationRetryCause {
    if (code === 'network_error') {
        return 'server_unavailable';
    }
    if (code === 'session_encryption_not_found') {
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

function createSessionRouteHydrationInFlightKey(sessionId: string, serverId?: string): string {
    return `${serverId ?? ''}\n${sessionId}`;
}

function canUseSessionUserMessageRuntimeRpc(session: Readonly<{
    metadata?: { version?: unknown } | null;
}> | null | undefined): boolean {
    const cliVersion = typeof session?.metadata?.version === 'string' ? session.metadata.version.trim() : '';
    if (cliVersion.length === 0) {
        return true;
    }
    return isVersionSupported(cliVersion, MINIMUM_CLI_SESSION_USER_MESSAGE_RPC_VERSION);
}

function ensureSessionRuntimeAfterCommittedPrompt(params: Readonly<{
    sessionId: string;
    session: Session;
    seq: number;
    requestId: string;
    tag: string;
}>): void {
    const controlTarget = readMachineControlTargetForSession(params.sessionId);
    const machineId = controlTarget?.machineId ?? (typeof params.session.metadata?.machineId === 'string'
        ? params.session.metadata.machineId.trim()
        : '');
    const directory = controlTarget?.basePath ?? (typeof params.session.metadata?.path === 'string'
        ? params.session.metadata.path.trim()
        : '');
    if (!machineId || !directory) return;

    const resolvedBackend = resolveSessionActionDefaultBackend({ session: params.session });
    if (!resolvedBackend) return;

    const authoringSnapshot = deriveSessionAuthoringSnapshot({ session: params.session });

    fireAndForget(
        ensureSessionRuntimeForPendingInput({
            sessionId: params.sessionId,
            machineId,
            directory,
            backendTarget: resolvedBackend.backendTarget,
            ...(authoringSnapshot.connectedServices !== null
                ? { connectedServices: authoringSnapshot.connectedServices }
                : {}),
            ...(typeof authoringSnapshot.connectedServicesUpdatedAt === 'number'
                ? { connectedServicesUpdatedAt: authoringSnapshot.connectedServicesUpdatedAt }
                : {}),
            ...(authoringSnapshot.permissionMode && typeof authoringSnapshot.permissionModeUpdatedAt === 'number'
                ? {
                    permissionMode: authoringSnapshot.permissionMode as PermissionMode,
                    permissionModeUpdatedAt: authoringSnapshot.permissionModeUpdatedAt,
                }
                : {}),
            ...(authoringSnapshot.agentModeId && typeof authoringSnapshot.agentModeUpdatedAt === 'number'
                ? {
                    agentModeId: authoringSnapshot.agentModeId,
                    agentModeUpdatedAt: authoringSnapshot.agentModeUpdatedAt,
                }
                : {}),
            ...(authoringSnapshot.modelId && typeof authoringSnapshot.modelUpdatedAt === 'number'
                ? {
                    modelId: authoringSnapshot.modelId,
                    modelUpdatedAt: authoringSnapshot.modelUpdatedAt,
                }
                : {}),
            initialTranscriptAfterSeq: Math.max(0, params.seq - 1),
            executionAuthorization: {
                provenance: 'user_request',
                requestId: params.requestId,
            },
        }).then((result) => {
            // Runtime ensure reports failures as resolved values, not rejections; without this
            // a failed wake is invisible and the queued prompt never gets a runner.
            if (result.type !== 'success') {
                log.log(`[sync] Wake after committed prompt failed for ${params.sessionId} (${params.tag}): ${JSON.stringify(result)}`);
            }
        }),
        { tag: params.tag },
    );
}

export type SendPendingMessageNowResult =
    | Readonly<{
        type: 'committed';
        persistence: 'provider_direct' | 'transcript_committed';
        providerAcceptancePending?: boolean;
    }>
    | Readonly<{ type: 'retry_scheduled'; persistence: 'pending' }>;

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

function readOptionalSessionMetadataString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

type FetchSessionsOptions = Readonly<{
    awaitSessionListHydration?: boolean;
    requiredHydrationSessionIds?: ReadonlyArray<string>;
    prioritizeSessionIds?: ReadonlyArray<string>;
    hydrationTelemetrySource?: SessionListFetchHydrationTelemetrySource;
    mode?: 'replace' | 'append';
}>;

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

function buildOrganizationProjectionForServer(
    state: SessionOrganizationSyncState,
    serverId: string | null,
): SessionOrganizationProjection | null {
    const normalizedServerId = typeof serverId === 'string' && serverId.trim().length > 0 ? serverId.trim() : null;
    if (!normalizedServerId) return null;
    return buildSessionOrganizationProjection({
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
    }, normalizedServerId);
}

/**
 * Persist the organization the list is currently painting so the next boot repaints it before
 * the refresh lands. Written from the store rather than from a response so partial refreshes
 * (`refreshSessionOrganization`) stay represented, and skipped whenever the store does not hold
 * a complete snapshot for this server yet.
 */
function persistSessionOrganizationWarmCache(
    serverId: string | null,
    accountId: string | null,
    projection: SessionOrganizationProjection | null,
): void {
    if (!serverId || !projection) return;
    const snapshot = buildSessionOrganizationSnapshotFromProjection(projection);
    if (!snapshot) return;
    saveSessionOrganizationWarmCacheSnapshot(serverId, accountId, snapshot);
}

function shouldIncludeSessionListAttentionRows(settings: Pick<Settings, 'sessionListAttentionPromotionModeV1'>): boolean {
    return normalizeSessionListAttentionPromotionMode(settings.sessionListAttentionPromotionModeV1) !== 'off';
}

function requireActivePendingOutboxScope(): ServerAccountScope {
    const scope = getActiveServerAccountScope();
    if (!scope) throw new Error('Pending enqueue requires an active server-account scope');
    return scope;
}

/**
 * Outcome of the changes-based resume catch-up.
 *
 * `refreshedByCatchUp` records which whole-list refreshes the catch-up already completed for this
 * resume so the resume tail does not issue the same full refresh a second time. Without it a
 * foreground resume ran two complete catch-up waves: the catch-up's own
 * `invalidate.sessions`/`invalidate.machines`, and then the socket-offline recovery block below.
 */
type ResumeViaChangesOutcome = Readonly<{
    status: 'ok' | 'fallback' | 'aborted';
    refreshedByCatchUp: Readonly<{ sessions: boolean; machines: boolean }>;
}>;

class Sync {

        encryption!: Encryption;
        serverID!: string;
        anonID!: string;
        private credentials!: AuthCredentials;
        private pauseController = new PauseController();
        private syncTuning: SyncTuning = loadSyncTuning();
        private sessionTranscriptRetention!: SessionTranscriptRetentionController;
      private resumeInFlight: Promise<void> | null = null;
      private pendingOutboxRearmInFlightByScope = new Map<string, Promise<void>>();
      private readonly usesPersistentDesktopSync = isTauriDesktop();
      private isForeground = this.usesPersistentDesktopSync || AppState.currentState === 'active';
      public encryptionCache = new EncryptionCache();
    private sessionsSync: InvalidateSync;
    private fetchSessionsInFlight: { generation: number; promise: Promise<void> } | null = null;
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
    private messagesSync = new Map<string, InvalidateSync>();
    private activeServerSessionIds = new Set<string>();
    private hasFetchedSessionsSnapshotForActiveServer = false;
    private serverScopeGeneration = 0;
      private sessionByIdHydrationInFlight = new Map<string, Promise<EnsureSessionVisibleForRouteResult>>();
      private sessionReceivedMessages = new Map<string, Map<string, number>>();
      private sessionMessagesBeforeSeqByKey = new Map<string, number>();
      private sessionMessagesHasMoreOlderByKey = new Map<string, boolean>();
      private sessionMessagesFetchLatestInFlightByKey = new Set<string>();
      private sessionMessagesFetchedLatestByKey = new Set<string>();
      private sessionMessagesLoadingOlderByKey = new Set<string>();
      private sessionMessagesLoadingNewerByKey = new Set<string>();
      private deferredMessagesFetchSessionIds = new Set<string>();
      private sessionMessagesPaginationSupportedByKey = new Map<string, boolean>();
      // Tail-reset discontinuity walks (MAIN chain only) — see sessionMessagesTailDiscontinuity.ts.
      private sessionMessagesTailDiscontinuityBySessionId = new Map<string, SessionMessagesTailDiscontinuity>();
      private sessionMessagesWindowStateBySessionId = new Map<string, SessionMessagesWindowState>();
      private directSessionOlderCursorBySessionId = new Map<string, string | null>();
      private directSessionHasMoreOlderBySessionId = new Map<string, boolean>();
      private directSessionTailCursorBySessionId = new Map<string, string | null>();
      private sessionViewport = new Map<string, SessionViewportSnapshot>();
      private sessionViewportHydratedStorageKey: string | null = null;
      /**
       * Hot-path cache of sessionIds this instance has persisted. It supports
       * local bookkeeping only: cross-tab writes mean it must never authorize
       * skipping the unconditional durable live-tail delete.
       */
      private persistedSessionViewportIds = new Set<string>();
      private deferredForwardLoadingSessions = new Set<string>();
      private explicitSessionTailProbeIds = new Set<string>();
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
    private activityAccumulator: ActivityUpdateAccumulator;
    private machineActivityAccumulator: MachineActivityAccumulator;
    private pendingSettings: Partial<Settings> = {};
    private pendingSettingsScope: AccountSettingsScope | null = null;
    private isBootstrapSyncRunning = false;
    private legacySessionOrganizationImportedPinnedSessionIdsForBootstrap = new Set<string>();
    private pendingSettingsFlushTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingSettingsDirty = false;
    private sessionMaterializedMaxSeqById: Record<string, number> = {};
    private deferredTranscriptState: DeferredTranscriptState = createDeferredTranscriptState();
    private deferredSessionStateHydrationState: DeferredSessionStateHydrationState = createDeferredSessionStateHydrationState();
    private readyNotificationProgressBySessionId: Record<string, ReadyNotificationProgress> = {};
    private sessionMaterializedMaxSeqFlushTimer: ReturnType<typeof setTimeout> | null = null;
    private sessionMaterializedMaxSeqDirty = false;
    private nativeInactiveCheckpointTimer: ReturnType<typeof setTimeout> | null = null;
    private jsThreadLagTelemetry: JsThreadLagTelemetry | null = null;
      private changesCursor: string | null = null;
        private safeCursorLagState: SafeCursorLagTripwireState | null = null;
        private webSyncClientIdentity: WebSyncClientIdentity | null = null;
        private webSyncClientIdentityHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
        private webLifecycleHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
        private webLifecycleHeartbeatLastNowMs: number | null = null;
        private userRequestLeases = new Set<symbol>();
        private deferredWebVisibilityTeardown: (() => void) | null = null;
		      private lastSocketDisconnectedAtMs: number | null = null;
		      private lastSocketOfflineDurationMs: number | null = null;
              private socketOfflineCatchUpConsumedSessionIds = new Set<string>();
	      revenueCatInitialized = false;
	    private settingsSecretsKey: Uint8Array | null = null;
	    private settingsSecretsReadKeys: readonly Uint8Array[] = [];
	    private messageTransport: SyncMessageTransport = createDefaultMessageTransport();
    private updatesSubscribed = false;
    private sessionDraftSyncEnabled = false;
    private sessionDraftOfflineCatchUpPending = false;
    private sessionDraftRepositoryConfiguredScope: ServerAccountScope | null = null;
    private readonly sessionDraftRuntimeHydrationGate = new SessionDraftRuntimeHydrationGate();

    // Generic locking mechanism
    private recalculationLockCount = 0;
    private lastRecalculationTime = 0;
	    private machinesRefreshInFlight: Promise<void> | null = null;
	    private lastMachinesRefreshAt = 0;
	    private lastNativeUpdateCheckAt = 0;

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

	        constructor() {
        syncPerformanceTelemetry.configure({
            enabled: this.syncTuning.syncPerformanceTelemetryEnabled,
            slowThresholdMs: this.syncTuning.syncPerformanceTelemetrySlowThresholdMs,
            flushIntervalMs: this.syncTuning.syncPerformanceTelemetryFlushIntervalMs,
            emitSummary: emitSyncPerformanceSummaryToConsole,
        });
        installSyncPerformanceTelemetryGlobal(syncPerformanceTelemetry);
        installSyncReliabilityTelemetryGlobal(syncReliabilityTelemetry);
        installSessionRealtimeTranscriptSuppressionGlobal();
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
        subscribeSessionTranscriptConsumerReleases(() => this.sessionTranscriptRetention.scheduleSweep());
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
        const onConnectionStateChange = (apiSocket as {
            onConnectionStateChange?: typeof apiSocket.onConnectionStateChange;
        } | undefined)?.onConnectionStateChange;
        if (typeof onConnectionStateChange === 'function') {
            let skippedInitialIdleConnectionState = false;
            bindManagedConnectionStateToRealtimeStore({
                subscribe: (listener) => onConnectionStateChange((state) => {
                    if (!skippedInitialIdleConnectionState && state.phase === 'idle') {
                        skippedInitialIdleConnectionState = true;
                        return;
                    }
                    skippedInitialIdleConnectionState = true;
                    listener(state);
                }),
                setEndpointConnectivity: (snapshot) => {
                    storage.getState().setEndpointConnectivity(snapshot);
                },
                onOnline: () => {
                    queueMicrotask(() => {
                        fireAndForget(this.resumeSync('server-reachable'), { tag: 'Sync.resumeSync.server-reachable' });
                    });
                },
            });
        }
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

            this.sessionsSync = new InvalidateSync(this.fetchSessions, { onError, onSuccess, onRetry, pause, backoff });
            this.settingsSync = new InvalidateSync(this.syncSettings, {
                onError: onSettingsError,
                onSuccess: onSettingsSuccess,
                onRetry,
                onRetryFailure: onSettingsRetryFailure,
                pause,
                backoff,
            });
            this.profileSync = new InvalidateSync(this.fetchProfile, { onError, onSuccess, onRetry, pause, backoff });
            this.purchasesSync = new InvalidateSync(this.syncPurchases, { onError, onSuccess, onRetry, pause, backoff });
            this.machinesSync = new InvalidateSync(this.fetchMachines, { onError, onSuccess, onRetry, pause, backoff });
            this.nativeUpdateSync = new InvalidateSync(this.fetchNativeUpdate, { pause, backoff });
            this.artifactsSync = new InvalidateSync(this.fetchArtifactsList, { pause, backoff });
            this.friendsSync = new InvalidateSync(this.fetchFriends, { pause, backoff });
            this.friendRequestsSync = new InvalidateSync(this.fetchFriendRequests, { pause, backoff });
            this.feedSync = new InvalidateSync(this.fetchFeed, { pause, backoff });
            this.todosSync = new InvalidateSync(this.fetchTodos, { pause, backoff });
            this.automationsSync = new InvalidateSync(this.fetchAutomations, { pause, backoff });

          const registerPushToken = async () => {
              if (__DEV__ && config.enableDevPushTokenRegistration !== true) {
                  return;
              }
              await this.registerPushToken();
          }
            this.pushTokenSync = new InvalidateSync(registerPushToken, { pause, backoff });
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
                  setServerReachabilityNetworkAllowed(false);
                  log.log(`📱 App state changed to: ${nextAppState}`);
                  this.pauseController.pause();
                  try {
                      apiSocket.disconnect();
                  } catch {
                      // ignore
                  }
                  fireAndForget(stopServerReachabilitySupervisors(), { tag: 'Sync.stopServerReachabilitySupervisors' });
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
                  const pauseForWebBackground = (tag: string, hardBoundary = false) => {
                      if (hardBoundary) {
                          this.userRequestLeases.clear();
                          this.deferredWebVisibilityTeardown = null;
                      } else if (this.userRequestLeases.size > 0) {
                          this.deferredWebVisibilityTeardown = () => pauseForWebBackground(tag);
                          return;
                      }
                      this.isForeground = false;
                      this.markNativeCryptoWorkerBackgroundQuiescent();
                      setServerReachabilityNetworkAllowed(false);
                      this.pauseController.pause();
                      try {
                          apiSocket.disconnect();
                      } catch {
                          // ignore
                      }
                      fireAndForget(stopServerReachabilitySupervisors(), { tag });
                      this.flushBackgroundSyncCheckpointsNow();
                  };
                  const resumeForWebForeground = (tag: string) => {
                      this.deferredWebVisibilityTeardown = null;
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
                      if (state === 'visible') {
                          this.deferredWebVisibilityTeardown = null;
                      }
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
                      pauseForWebBackground('Sync.stopServerReachabilitySupervisors.pagehide', true);
                  };
                  const onPageShow = (event?: { persisted?: boolean }) => {
                      const state = String(doc.visibilityState ?? '').trim().toLowerCase();
                      if (event?.persisted === true || state === 'visible') {
                          resumeForWebForeground('Sync.resumeSync.pageshow');
                      }
                  };
                  const onFreeze = () => {
                      pauseForWebBackground('Sync.stopServerReachabilitySupervisors.freeze', true);
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

      public acquireUserRequestLease(): () => void {
          const lease = Symbol('user-request');
          this.userRequestLeases.add(lease);
          let released = false;
          return () => {
              if (released) return;
              released = true;
              this.userRequestLeases.delete(lease);
              if (this.userRequestLeases.size !== 0) return;
              const teardown = this.deferredWebVisibilityTeardown;
              this.deferredWebVisibilityTeardown = null;
              teardown?.();
          };
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

      private getSessionMessagesPageSize(options?: LoadOlderMessagesOptions): number {
          const optionLimit = options?.limit;
          if (typeof optionLimit === 'number' && Number.isFinite(optionLimit)) {
              return Math.max(1, Math.trunc(optionLimit));
          }
          return Math.max(1, Math.trunc(this.syncTuning.sessionMessagesPageSize));
      }

      private getMessageDecryptBatchOptions() {
          return {
              initialMessageDecryptBatchSize: this.syncTuning.initialMessageDecryptBatchSize,
              messageDecryptBatchSize: this.syncTuning.messageDecryptBatchSize,
              messageDecryptYieldDelayMs: this.syncTuning.messageDecryptYieldDelayMs,
          };
      }

      private syncJsThreadLagTelemetryRuntime(): void {
          if (!this.jsThreadLagTelemetry) {
              this.jsThreadLagTelemetry = createJsThreadLagTelemetry({
                  telemetry: syncPerformanceTelemetry,
                  sampleIntervalMs: this.syncTuning.jsThreadLagTelemetrySampleIntervalMs,
                  flushIntervalMs: this.syncTuning.syncPerformanceTelemetryFlushIntervalMs,
                  thresholdMs: this.syncTuning.jsThreadLagTelemetryThresholdMs,
                  maxSamples: this.syncTuning.jsThreadLagTelemetryMaxSamples,
              });
          }
          if (!syncPerformanceTelemetry.isEnabled()) {
              this.stopJsThreadLagTelemetryRuntime();
              return;
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
          const activeEncryption = (this as { encryption?: Encryption }).encryption;
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

      public reconfigureSessionDraftRepositoryForAccountMode(
          credentials: AuthCredentials,
          accountMode: 'plain' | 'e2ee',
      ): void {
          const scope = getActiveServerAccountScope();
          if (!scope || !this.encryption || credentials.token !== this.credentials?.token) {
              throw new Error('Session draft repository scope is unavailable');
          }
          configureSessionDraftRepository({
              transport: this.sessionDraftSyncEnabled
                  ? createApiSessionDraftsTransport({ credentials })
                  : undefined,
              cipher: createSessionDraftCipher({
                  accountMode,
                  accountCryptoMaterial: resolveAccountScopedCryptoMaterialFromCredentials(credentials),
                  getSessionContext: (sessionId) => {
                      const session = storage.getState().sessions[sessionId] ?? null;
                      if (!session) return null;
                      if (session.encryptionMode === 'plain') return { mode: 'plain' };
                      return {
                          mode: 'e2ee',
                          encryption: this.encryption.getSessionEncryption(sessionId),
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
          if (!scope || !credentials || !this.encryption) {
              return Promise.resolve();
          }
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
                  const serverId = capturedScope.serverId;
                  const syncEnabled = await isRuntimeFeatureEnabled({
                      featureId: 'sessions.drafts',
                      serverId,
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
              if (params.forceSnapshotHydration === true) {
                  this.sessionDraftOfflineCatchUpPending = false;
              }
              return true;
            },
          });
      }

      /**
       * Decrypted plaintext deliberately does NOT hang off the transcript-derived-cache
       * seam.
       *
       * That seam exists for memo caches whose entries root store objects — the
       * per-session message arrays in `sync/store/hooks.ts` keep a `SessionMessages`
       * entry alive through `sourceRef`s, so dropping the store entry without clearing
       * them frees nothing. A `DecryptedMessage` is a plain record and roots none of
       * that, so it never belonged to that concern.
       *
       * Registering it there conflated two different lifetimes and cost far more than it
       * saved: bounded retention eviction (`evictSessionMessages`) fires the seam, so
       * every evicted transcript ALSO threw away plaintext whose validity had not
       * changed at all — the cache is keyed by `(messageId, ciphertext fingerprint)` and
       * stays correct across an eviction. Returning to the session then paid full
       * decryption again. Measured on device 2026-08-18, returning to a session parked
       * past the retention grace: `toDecrypt 368, cached 0` — a 0% hit rate and 1.6s of
       * re-decryption for memory that the encryption cache's own byte budget was already
       * bounding.
       *
       * The two lifetimes that genuinely invalidate plaintext still clear it, each at its
       * own owner: a session key change (`initializeSessionEncryption`) and session
       * deletion (`removeSessionEncryption`, reached from the delete path in
       * `syncSessions`). Size is bounded by the cache's LRU byte budget. Nothing here
       * needs a third opinion.
       */

    setMessageTransport(transport: SyncMessageTransport): void {
        this.messageTransport = transport;
    }

    resetMessageTransport(): void {
        this.messageTransport = createDefaultMessageTransport();
    }

    private getWebSyncClientIdentity(): WebSyncClientIdentity | null {
        if (Platform.OS !== 'web') return null;
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
                const nodeTimer = timer as unknown as { unref?: () => void };
                nodeTimer.unref?.();
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

    private getDirectSessionCursorScope(sessionId: string): ChangesCursorScope | null {
        return this.buildCursorScopeForServer(this.getDirectSessionServerScope(sessionId) ?? String(getActiveServerSnapshot().serverId ?? '').trim());
    }

    private clearActiveAccountSettingsScope(): void {
        this.flushSessionMaterializedMaxSeqForCurrentScopeNow();
        this.pendingSettings = {};
        this.pendingSettingsScope = null;
        this.sessionMaterializedMaxSeqById = {};
        this.deferredTranscriptState = createDeferredTranscriptState();
        this.deferredSessionStateHydrationState = createDeferredSessionStateHydrationState();
        this.readyNotificationProgressBySessionId = {};
        storage.getState().clearSettingsScope();
        storage.getState().clearProfileScope();
        storage.getState().clearPetsScope();
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
            .filter((legacyScope): legacyScope is AccountSettingsScope =>
                !!legacyScope && !areAccountSettingsScopesEqual(legacyScope, scope));

        migratePendingSetupIntentScopes(scope, legacyScopes);
        migratePendingTerminalConnectScopes(scope, legacyScopes);
        migratePendingNotificationActionScopes(scope, legacyScopes);
        migratePendingNotificationNavScopes(scope, legacyScopes);
        storage.getState().activateSettingsScope(scope, legacyScopes);
        storage.getState().activateProfileScope(scope, legacyScopes);
        storage.getState().activatePetsScope(scope, legacyScopes);
        storage.getState().activateSessionLocalStateScope(scope, legacyScopes);
        this.pendingSettings = loadPendingAccountSettings(scope);
        this.pendingSettingsScope = scope;
        this.sessionMaterializedMaxSeqById = loadSessionMaterializedMaxSeqById(scope);
        this.deferredTranscriptState = createDeferredTranscriptState();
        this.deferredSessionStateHydrationState = createDeferredSessionStateHydrationState();
        this.readyNotificationProgressBySessionId = {};
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

    async create(credentials: AuthCredentials, encryption: Encryption) {
        const accountId = this.parseAccountIdForSettingsScope(credentials, 'create');
        if (!accountId) throw new Error('Invalid auth token');
        this.configureEncryptionRuntime(encryption, accountId);
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = accountId;
        setWarmCacheAccountScope(this.serverID);
        this.activateAccountSettingsScope(accountId);
        this.changesCursor = loadChangesCursor(this.getChangesCursorScope());
        // Derive a stable per-account key for field-level secret settings.
        // This is separate from the outer settings blob encryption.
        try {
            const keySet = deriveSettingsSecretsKeySet(resolveAccountScopedCryptoMaterialFromCredentials(credentials));
            this.settingsSecretsKey = keySet.writeKey;
            this.settingsSecretsReadKeys = keySet.readKeys;
        } catch {
            this.settingsSecretsKey = null;
            this.settingsSecretsReadKeys = [];
        }
        this.hydrateWarmCachesForActiveServer();
        this.syncJsThreadLagTelemetryRuntime();
        await this.#init();

        // UX: avoid blocking login forever if initial sync fetches hang/retry indefinitely.
        // We still kick off the sync work in #init(); this just bounds the time we block the login call.
        const initialAwaitTimeoutMs = 2500;
        await Promise.all([
            this.settingsSync.awaitQueue({ timeoutMs: initialAwaitTimeoutMs }),
            this.profileSync.awaitQueue({ timeoutMs: initialAwaitTimeoutMs }),
            this.purchasesSync.awaitQueue({ timeoutMs: initialAwaitTimeoutMs }),
        ]);
    }

    async restore(credentials: AuthCredentials, encryption: Encryption) {
        const accountId = this.parseAccountIdForSettingsScope(credentials, 'restore');
        if (!accountId) throw new Error('Invalid auth token');
        // NOTE: No awaiting anything here, we're restoring from a disk (ie app restarted)
        // Purchases sync is invalidated in #init() and will complete asynchronously
        this.configureEncryptionRuntime(encryption, accountId);
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = accountId;
        setWarmCacheAccountScope(this.serverID);
        this.activateAccountSettingsScope(accountId);
        this.changesCursor = loadChangesCursor(this.getChangesCursorScope());
        try {
            const keySet = deriveSettingsSecretsKeySet(resolveAccountScopedCryptoMaterialFromCredentials(credentials));
            this.settingsSecretsKey = keySet.writeKey;
            this.settingsSecretsReadKeys = keySet.readKeys;
        } catch {
            this.settingsSecretsKey = null;
            this.settingsSecretsReadKeys = [];
        }
        this.hydrateWarmCachesForActiveServer();
        this.syncJsThreadLagTelemetryRuntime();
        await this.#init();
    }

    private hydrateWarmCachesForActiveServer(): void {
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
        const accountId = resolveWarmCacheAccountScope(loadPersistedProfile().id);
        if (!serverId || !accountId) return;

        const machineEntries = loadMachineDisplayWarmCacheEntries(serverId, accountId);
        if (Object.keys(machineEntries).length > 0) {
            storage.getState().replaceMachineDisplays(
                Object.values(machineEntries).map((entry) => buildMachineDisplayRenderableFromCacheEntry(entry)),
            );
        }

        const sessionEntries = loadSessionListWarmCacheEntries(serverId, accountId);
        if (Object.keys(sessionEntries).length > 0) {
            storage.getState().replaceSessionListRenderables(
                Object.values(sessionEntries).map((entry) => buildSessionListRenderableFromCacheEntry(entry)),
            );
        }

        // Warm rows without their organization would paint unpinned and ungrouped and then
        // rearrange, so the organization is restored through the same owner the refresh uses;
        // that refresh is version-gated and replaces this only when the server is ahead.
        const organizationSnapshot = loadSessionOrganizationWarmCacheSnapshot(serverId, accountId);
        if (organizationSnapshot) {
            storage.getState().applySessionOrganizationSnapshot(
                serverId,
                organizationSnapshot,
                createSessionListOrganizationSnapshotRequest(),
            );
        }
    }

    private resetServerScopedRuntimeState = () => {
        this.sessionDraftSyncEnabled = false;
        this.sessionDraftOfflineCatchUpPending = false;
        this.sessionDraftRepositoryConfiguredScope = null;
        this.sessionDraftRuntimeHydrationGate.reset();
        configureSessionDraftRepository({ syncEnabled: false });
        this.userRequestLeases.clear();
        this.deferredWebVisibilityTeardown = null;
        this.stopJsThreadLagTelemetryRuntime();
        this.serverScopeGeneration += 1;
        this.flushPendingSettingsForCurrentScopeNow();
        this.flushSessionMaterializedMaxSeq();
        this.clearActiveAccountSettingsScope();
        apiSocket.disconnect();
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
        this.sessionMessagesLoadingNewerByKey.clear();
        this.deferredMessagesFetchSessionIds.clear();
        this.sessionMessagesPaginationSupportedByKey.clear();
        this.sessionMessagesWindowStateBySessionId.clear();
        for (const sessionId of [...this.sessionTargetWindowStateListeners.keys()]) {
            this.notifySessionTargetWindowStateListeners(sessionId);
        }
        clearTargetWindowRequestEpochs(); // invalidate any in-flight window fetches so stale commits fail the epoch guard
        this.directSessionTailCursorBySessionId.clear();
        this.sessionViewport.clear();
        // Re-hydrate persisted viewport anchors for whichever scope becomes
        // active next; persisted records themselves are scope-keyed and survive.
        this.sessionViewportHydratedStorageKey = null;
        this.sessionByIdHydrationInFlight.clear();
        clearActiveViewingSessionsForServerScopeReset();
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
        this.changesCursor = null;

        storage.setState((state) => ({
            ...state,
            profile: { ...profileDefaults },
            sessions: {},
            sessionListRenderables: {},
            sessionsData: null,
            sessionListViewData: null,
            sessionListViewDataByServerId: setActiveServerSessionListCache(
                state.sessionListViewDataByServerId,
                null,
            ),
            sessionScmStatus: {},
            machines: {},
            machineDisplayById: {},
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
            sessionMessages: {},
            sessionPending: {},
            artifacts: {},
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
            realtimeStatus: 'disconnected',
            socketStatus: 'disconnected',
            socketLastError: null,
            socketLastErrorAt: null,
            syncError: null,
            accountSettingsSyncStatus: createAccountSettingsIdleStatus(),
            lastSyncAt: null,
            purchases: { ...purchasesDefaults },
        }));
        this.revenueCatInitialized = false;
    };

    public async switchServer(credentials: AuthCredentials): Promise<void> {
        const encryption = await createEncryptionFromAuthCredentials(credentials);

        this.resetServerScopedRuntimeState();
        apiSocket.initialize({ endpoint: getActiveServerSnapshot().serverUrl, token: credentials.token }, encryption);
        await this.restore(credentials, encryption);
    }

    public disconnectServer(): void {
        this.resetServerScopedRuntimeState();
        clearWarmCacheAccountScope();
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
            this.ensureSessionViewportHydrated();
            // Opening a session grows the hydrated working set; bound it (coalesced sweep).
            this.sessionTranscriptRetention.scheduleSweep();
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
                const staleMessageIds = readStaleTranscriptMessageIds(this.deferredTranscriptState, sessionId);
                fireAndForget(this.repairDeferredStaleTranscriptRegion(sessionId, {
                    minSeq: staleMinSeq,
                    messageIds: staleMessageIds,
                }), {
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

            // C6/D3: reopening a session is a reactive, list-independent bottom arrival. Drain any
            // deferred-newer backlog here so newer-message catch-up never stalls waiting for a
            // ChatList scroll event.
            this.maybeDrainDeferredNewerMessages(sessionId, { isPinned: true, distanceFromBottomPx: 0 });

            // Notify voice assistant about session visibility
            const session = storage.getState().sessions[sessionId];
            if (session) {
                voiceHooks.onSessionFocus(sessionId, session.metadata || undefined);
        }
    }

        materializeExistingSessionDraft = async (sessionId: string): Promise<void> => {
            const capturedDraftScope = getActiveServerAccountScope();
            if (!capturedDraftScope) return;
            await materializeVisibleExistingSessionDraft({
                sessionId,
                capturedScope: capturedDraftScope,
                readActiveScope: getActiveServerAccountScope,
                ensureRuntimeReady: () => this.ensureSessionDraftRepositoryRuntimeReady(),
                materializeExact: materializeExactSessionDraft,
            });
        }

        refreshSessionMessages = async (sessionId: string): Promise<void> => {
            const normalized = String(sessionId ?? '').trim();
            if (!normalized) return;
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
        ensureSessionVisibleForMessageRoute = async (
            sessionId: string,
            options?: Readonly<{ forceRefresh?: boolean; serverId?: string }>,
        ): Promise<EnsureSessionVisibleForRouteResult> => {
            const normalized = String(sessionId ?? '').trim();
            if (!normalized) return createEnsureSessionVisibleMissingResult(normalized, 'not_found');
            const forceRefresh = options?.forceRefresh === true;
            const scopedServerId = resolveMessageRouteHydrationServerId(normalized, options?.serverId);
            const explicitServerId = normalizeScopedServerId(options?.serverId);
            const inFlightKey = createSessionRouteHydrationInFlightKey(normalized, scopedServerId);
            const hydrationGeneration = this.serverScopeGeneration;
            const activeServerIdAtHydrationStart = normalizeScopedServerId(getActiveServerSnapshot().serverId);
            const isRouteHydrationScopeCurrent = () => (
                this.serverScopeGeneration === hydrationGeneration
                && normalizeScopedServerId(getActiveServerSnapshot().serverId) === activeServerIdAtHydrationStart
            );

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

            // Fast-path when we already know the session exists on this server and the stored record is
            // already authoritatively hydrated (deep links can occur before the sessions snapshot bootstraps).
            const existingSession = storage.getState().sessions[normalized];
            if (!forceRefresh && this.isSessionKnownOnActiveServer(normalized) && existingSession) {
                const encryptionMode: 'e2ee' | 'plain' = existingSession.encryptionMode === 'plain' ? 'plain' : 'e2ee';
                const hasEncryption = encryptionMode === 'plain'
                    ? false
                    : Boolean(this.encryption.getSessionEncryption(normalized));
                const hasAuthoritativeSessionRouteState = hasAuthoritativeSessionRouteData(existingSession);
                if (DEBUG_SESSION_HYDRATE) {
                    log.log(`[sessionHydrate] fast-path check ${normalized} mode=${encryptionMode} hasEncryption=${hasEncryption} hasRouteState=${hasAuthoritativeSessionRouteState}`);
                }
                if (hasAuthoritativeSessionRouteState && (encryptionMode === 'plain' || hasEncryption)) {
                    if (DEBUG_SESSION_HYDRATE) {
                        log.log(`[sessionHydrate] fast-path hit ${normalized}`);
                    }
                    return createEnsureSessionVisibleAvailableResult(normalized, scopedServerId);
                }
            }

            // Sync might not be fully initialized yet (e.g. very early during app bootstrap).
            const credentials = this.credentials;
            if (!credentials) {
                if (DEBUG_SESSION_HYDRATE) {
                    log.log(`[sessionHydrate] missing credentials for ${normalized}`);
                }
                return createEnsureSessionVisibleRetryableResult(normalized, 'unknown', scopedServerId);
            }

            const existing = this.sessionByIdHydrationInFlight.get(inFlightKey);
            if (existing) {
                if (DEBUG_SESSION_HYDRATE) {
                    log.log(`[sessionHydrate] awaiting in-flight hydration for ${normalized}`);
                }
                return await existing;
            }

            const inFlight = (async () => {
                try {
                    if (DEBUG_SESSION_HYDRATE) {
                        log.log(`[sessionHydrate] fetching session by id ${normalized}`);
                    }
                    const stagedSessionDataKeys = new Map(this.sessionDataKeys);
                    const stagedSessionDataKeyEnvelopes = new Map(this.sessionDataKeyEnvelopes);
                    const result = await fetchSessionByIdWithServerScope({
                        sessionId: normalized,
                        serverId: scopedServerId,
                        activeCredentials: credentials,
                        activeEncryption: this.encryption,
                        sessionDataKeys: stagedSessionDataKeys,
                        sessionDataKeyEnvelopes: stagedSessionDataKeyEnvelopes,
                        activeRequest: (path, init) => apiSocket.request(path, init),
                        getExistingSession: (sessionId) => storage.getState().sessions[sessionId] ?? null,
                        applySessions: (sessions) => {
                            if (!isRouteHydrationScopeCurrent()) return;
                            this.applySessions(sessions);
                        },
                        log,
                        includeTurnsProjection: false,
                    });
                    if (!isRouteHydrationScopeCurrent()) {
                        return createEnsureSessionVisibleRetryableResult(normalized, 'unknown', scopedServerId);
                    }
                    if (!result.ok) {
                        const code = typeof result.errorCode === 'string' ? result.errorCode : '';
                        const missingCause = mapSessionByIdTerminalCodeToMissingCause(code);
                        if (missingCause) {
                            if (missingCause === 'unauthorized') {
                                recordTerminalAuthSyncError(new Error('Authentication required'), { serverId: scopedServerId });
                            }
                            return createEnsureSessionVisibleMissingResult(
                                normalized,
                                missingCause,
                                explicitServerId ?? undefined,
                            );
                        }
                        return createEnsureSessionVisibleRetryableResult(
                            normalized,
                            mapSessionByIdRetryableCodeToCause(code),
                            scopedServerId,
                        );
                    }
                    this.commitSessionDataKeyCacheEntry(
                        normalized,
                        stagedSessionDataKeys,
                        stagedSessionDataKeyEnvelopes,
                    );

                    // Ensure the *current* encryption instance is initialized for this session.
                    // During app bootstrap / key restoration, the sync encryption instance can change while
                    // the session-by-id hydration request is in-flight. Re-initializing here ensures
                    // subsequent message fetches can proceed immediately.
                    const hydratedSessionEncryptionMode = result.session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
                    const hydratedServerId = String(result.session?.serverId ?? '').trim();
                    if (hydratedSessionEncryptionMode === 'e2ee') {
                        const sessionDataKey = this.sessionDataKeys.get(normalized) ?? null;
                        const sessionScope = hydratedServerId
                            ? { serverId: hydratedServerId }
                            : undefined;
                        await this.encryption.initializeSessions(new Map([[normalized, sessionDataKey]]), sessionScope);
                    }
                    if (!isRouteHydrationScopeCurrent()) {
                        return createEnsureSessionVisibleRetryableResult(normalized, 'unknown', scopedServerId);
                    }

                    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
                    if (!hydratedServerId || areServerProfileIdentifiersEquivalent(hydratedServerId, activeServerId)) {
                        this.activeServerSessionIds.add(normalized);
                    }
                    if (DEBUG_SESSION_HYDRATE) {
                        const hasEncryption = hydratedSessionEncryptionMode === 'plain'
                            ? false
                            : Boolean(this.encryption.getSessionEncryption(normalized));
                        log.log(`[sessionHydrate] hydration ok ${normalized} hasEncryption=${hasEncryption}`);
                    }
                    return createEnsureSessionVisibleAvailableResult(
                        normalized,
                        hydratedServerId || scopedServerId,
                    );
                } catch (err) {
                    if (!isRouteHydrationScopeCurrent()) {
                        return createEnsureSessionVisibleRetryableResult(normalized, 'unknown', scopedServerId);
                    }
                    if (isTerminalAuthError(err)) {
                        recordTerminalAuthSyncError(err, { serverId: scopedServerId });
                        return createEnsureSessionVisibleMissingResult(normalized, 'unauthorized', scopedServerId);
                    }
                    log.log(`⚠️ ensureSessionVisibleForMessageRoute failed for ${normalized}: ${err instanceof Error ? err.message : 'unknown error'}`);
                    return createEnsureSessionVisibleRetryableResult(
                        normalized,
                        classifyRouteHydrationErrorCause(err),
                        scopedServerId,
                    );
                }
            })();

            this.sessionByIdHydrationInFlight.set(inFlightKey, inFlight);
            inFlight.finally(() => {
                if (this.sessionByIdHydrationInFlight.get(inFlightKey) === inFlight) {
                    this.sessionByIdHydrationInFlight.delete(inFlightKey);
                }
            });

            const result = await inFlight;
            if (result.kind === 'available') {
                // A message invalidation may have observed the session before this route
                // hydration committed its owner. Replay that deferred attempt now that the
                // owner is authoritative, instead of leaving the transcript permanently empty.
                this.replayDeferredMessagesFetch(normalized);
                this.getOrCreateMessagesSync(normalized).invalidateCoalesced();
            }
            return result;
        }

    private commitSessionDataKeyCacheEntry(
        sessionId: string,
        stagedSessionDataKeys: ReadonlyMap<string, Uint8Array>,
        stagedSessionDataKeyEnvelopes: ReadonlyMap<string, string>,
    ): void {
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
    }

    async sendMessage(
        sessionId: string,
        text: string,
        displayText?: string,
        metaOverrides?: Record<string, unknown>,
        options?: Readonly<{
            profileId?: string | null;
            localId?: string | null;
            bypassPendingQueueReason?: SessionMessageDirectBypassReason;
            onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void;
        }>
    ) {
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
                const metadataUpdatedAtRaw = latestSession?.metadata?.permissionModeUpdatedAt ?? null;
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
            const flavor = session.metadata?.flavor;
            const agentId = resolveAgentIdFromFlavor(flavor);
            const modelMode = session.modelMode || (agentId ? getAgentCore(agentId).model.defaultMode : 'default');

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
            const removePendingMessageCreatedForSend = () => {
                if (!pendingMessageExistedBeforeSend) {
                    storage.getState().removePendingMessage(sessionId, localId);
                }
            };

            const sentFrom = resolveSentFrom();
            const model = agentId && getAgentCore(agentId).model.supportsSelection && modelMode !== 'default' ? modelMode : undefined;
            // Create user message content with metadata
            const content: RawRecord = {
                role: 'user',
                content: {
                    type: 'text',
                    text
                },
                meta: buildSendMessageMeta({
                    sentFrom,
                    permissionMode: permissionMode || 'default',
                    model,
                    displayText,
                    agentId,
                    settings: storage.getState().settings,
                    session,
                    metaOverrides: metaOverrides as any,
                })
            };

            const messagePayload =
                sessionEncryptionMode === 'plain'
                    ? { t: 'plain' as const, v: content }
                    : await (async () => {
                        const encryption = this.encryption.getSessionEncryption(sessionId);
                        if (!encryption) {
                            throw new Error(`Session ${sessionId} encryption not found`);
                        }
                        return await encryption.encryptRawRecord(content);
                    })();

            // Track this outbound user message in the local pending queue until it is committed.
            // This prevents “ghost” optimistic transcript items when the send fails, and it lets the UI
            // show a pending bubble while we await ACK / catch-up.
            const createdAt = nowServerMs();
            storage.getState().upsertPendingMessage(sessionId, {
                id: localId,
                localId,
                createdAt,
                updatedAt: createdAt,
                source: 'local_outbound',
                text,
                displayText,
                rawRecord: content,
            });
            options?.onLocalPendingProjectionCreated?.({ localId });

            let runtimeRpcFallbackRequiresWake = false;
            if (session.active === true && canUseSessionUserMessageRuntimeRpc(session)) {
                try {
                    const rpcAck = await apiSocket.sessionRPC<SessionUserMessageSendResponse, {
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
                    storage.getState().upsertPendingMessage(sessionId, {
                        id: localId,
                        localId,
                        createdAt,
                        updatedAt: nowServerMs(),
                        source: 'local_outbound',
                        deliveryStatus: 'accepted',
                        text,
                        displayText,
                        rawRecord: content,
                    });
                    await publishNextPromptPermissionModeIfNeeded();
                    return {
                        localId,
                        persistence: 'provider_direct' as const,
                        ...(rpcAck.ok === true && rpcAck.providerAcceptancePending === true
                            ? { providerAcceptancePending: true }
                            : {}),
                    };
                } catch (error) {
                    if (isSocketIoAckTimeoutError(error)) {
                        storage.getState().upsertPendingMessage(sessionId, {
                            id: localId,
                            localId,
                            createdAt,
                            updatedAt: nowServerMs(),
                            source: 'local_outbound',
                            deliveryStatus: 'queued',
                            sendState: 'unconfirmed',
                            text,
                            displayText,
                            rawRecord: content,
                        });
                        return { localId, persistence: 'pending' as const };
                    }
                    if (!isFallbackSafeSessionUserMessageRpcError(error)) {
                        removePendingMessageCreatedForSend();
                        throw error;
                    }

                    if (options?.bypassPendingQueueReason === 'selected_direct') {
                        // A runtime-RPC readiness failure means this active runner has not accepted
                        // custody. Reuse the canonical durable pending queue with the same idempotency
                        // key so materialization/provider acceptance owns the message end to end.
                        removePendingMessageCreatedForSend();
                        const queued = await this.enqueuePendingMessage(
                            sessionId,
                            text,
                            displayText,
                            metaOverrides,
                            { localId, requestedAction: { v: 1, kind: 'enqueue' } },
                        );
                        return { localId: queued.localId, persistence: 'pending' as const };
                    }
                    runtimeRpcFallbackRequiresWake = true;
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
                    await assertActiveEndpointAuthenticated();
                    return await socketEmitWithAckFallback<MessageAckResponse>({
                        emitWithAck: (event, payload, opts) =>
                            this.messageTransport.emitWithAck<MessageAckResponse>(event, payload, opts),
                        send: (event, payload) => this.messageTransport.send(event, payload),
                        event: 'message',
                        payload,
                        timeoutMs: this.syncTuning.socketAckTimeoutMs,
                        onNoAck: () => this.schedulePendingMessageCommitRetry({ sessionId, localId }),
                        beforeFallback: () => assertActiveEndpointAuthenticated({ forceProbe: true }),
                    });
                } catch (error) {
                    storage.getState().removePendingMessage(sessionId, localId);
                    throw error;
                }
            })();

            if (!rawAck) {
                storage.getState().clearSessionOptimisticThinking(sessionId);
                return { localId, persistence: 'pending' as const };
            }

            const parsedAck = MessageAckResponseSchema.safeParse(rawAck);
            if (!parsedAck.success) {
                // Treat malformed ACKs as "no ACK": keep the pending bubble and retry later.
                this.schedulePendingMessageCommitRetry({ sessionId, localId });
                return { localId, persistence: 'pending' as const };
            }

            const ack = parsedAck.data;

            if (ack.ok !== true) {
                storage.getState().removePendingMessage(sessionId, localId);
                throw new Error(ack.error || 'Message send rejected');
            }

            // Message is committed. Insert it into the canonical transcript without waiting for
            // broadcast updates, which can be missed on backgrounded devices. `applyMessages`
            // retires the matching pending projection in the SAME store update, so the transcript
            // never publishes a frame with neither row; a standalone removal here would be a
            // second writer for the same retirement.
            const committed = normalizeRawMessage(ack.id, localId, createdAt, content, { seq: ack.seq });
            if (committed) {
                this.applyMessages(sessionId, [committed]);
            } else {
                storage.getState().removePendingMessage(sessionId, localId);
            }
            this.markSessionMaterializedMaxSeq(sessionId, ack.seq);

            // If we miss the broadcast socket update, we still need to advance session.seq so
            // catch-up (`afterSeq`) works correctly across reconnects.
            const currentSession = storage.getState().sessions[sessionId];
            if (currentSession) {
                this.applySessions([
                    {
                        ...currentSession,
                        updatedAt: nowServerMs(),
                        seq: Math.max(currentSession.seq ?? 0, ack.seq),
                    }
                ]);
            }

            // For "next prompt" apply timing, the permission mode change is intentionally not published
            // immediately when the user toggles the picker. Instead, once the user actually sends a message,
            // we publish the newer local selection as the session-wide permission mode so it propagates
	            // across devices.
	            await publishNextPromptPermissionModeIfNeeded();

            if (session.active !== true || runtimeRpcFallbackRequiresWake) {
                ensureSessionRuntimeAfterCommittedPrompt({
                    sessionId,
                    session,
                    seq: ack.seq,
                    requestId: localId,
                    tag: 'Sync.sendMessage.wakeAfterSend',
                });
            }

	            // Server ACK means the user message is committed (or idempotently confirmed).
	            // Do NOT clear optimistic thinking here: the agent can still be mid-turn (streaming / tool calls).
            // We clear optimistic thinking only when we see a terminal lifecycle marker,
            // when the session enters a permission/action-required gate, when the session is marked thinking by live
            // activity updates, or when the optimistic timeout expires.
            return { localId, seq: ack.seq, persistence: 'transcript_committed' as const };
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
            throw new Error(`Session ${sessionId} not found in storage`);
        }

        const deliveryIntent = pending.deliveryIntent ?? 'interrupt_and_send';
        this.markSessionLiveTailIntent(sessionId);
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
                permissionModeApplyTiming: state.settings.sessionPermissionModeApplyTiming,
                nonSteerableSendPrompt: state.settings.sessionNonSteerableSendPrompt,
                resumeCapabilityOptions: buildResumeCapabilityOptionsFromUiState({
                    settings: state.settings,
                    results: undefined,
                }),
                permissionOverride: getPermissionModeOverrideForSpawn(session),
                callerSurface: deliveryIntent === 'interrupt_and_send'
                    ? 'pending_message_send_now'
                    : 'pending_message_steer_now',
                requestedAction: deliveryIntent === 'interrupt_and_send'
                    ? { v: 1, kind: 'send_now' as const }
                    : { v: 1, kind: 'steer_now' as const },
                existingDurablePendingMessage: true,
            });

            if (result.type === 'send_failed' || result.type === 'rejected' || result.type === 'wake_failed') {
                storage.getState().clearSessionOptimisticThinking(sessionId);
                throw createSessionMessageSubmitFailureError(
                    result.errorCode,
                    result.errorMessage,
                    'Message send rejected',
                );
            }

            switch (result.persistence) {
                case 'pending':
                    return { type: 'retry_scheduled', persistence: 'pending' };
                case 'provider_direct':
                    return {
                        type: 'committed',
                        persistence: 'provider_direct',
                        ...(result.providerAcceptancePending === true ? { providerAcceptancePending: true } : {}),
                    };
                case 'transcript_committed':
                    return { type: 'committed', persistence: 'transcript_committed' };
                default:
                    storage.getState().clearSessionOptimisticThinking(sessionId);
                    throw createSessionMessageSubmitFailureError(
                        result.errorCode,
                        result.errorMessage,
                        'Message send rejected',
                    );
            }
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
                // If the session isn't available (e.g. session list was cleared or the app is mid-rehydrate),
                // don't leave this retry stuck. Ask for a sessions refresh and reschedule with backoff.
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

            const sessionEncryptionMode: 'e2ee' | 'plain' = session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
            const parsed = RawRecordSchema.safeParse(pending.rawRecord);
            const rawRecord: RawRecord = parsed.success ? parsed.data : {
                role: 'user',
                content: { type: 'text', text: pending.text },
                meta: {},
            };

            const messagePayload =
                sessionEncryptionMode === 'plain'
                    ? { t: 'plain' as const, v: rawRecord }
                    : await (async () => {
                        const sessionEncryption = this.encryption.getSessionEncryption(params.sessionId);
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
                    await assertActiveEndpointAuthenticated();
                    return await this.messageTransport.emitWithAck<MessageAckResponse>('message', payload, {
                        timeoutMs: this.syncTuning.socketAckTimeoutMs,
                    });
                } catch (error) {
                    let terminalError = error;
                    if (!isTerminalAuthError(terminalError)) {
                        try {
                            await assertActiveEndpointAuthenticated({ forceProbe: true });
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
                // `applyMessages` retires the matching pending projection in the same store update.
                const committed = normalizeRawMessage(ack.data.id, params.localId, pending.createdAt, rawRecord, { seq: ack.data.seq });
                if (committed) {
                    this.applyMessages(params.sessionId, [committed]);
                } else {
                    storage.getState().removePendingMessage(params.sessionId, params.localId);
                }
                this.markSessionMaterializedMaxSeq(params.sessionId, ack.data.seq);

                const currentSession = storage.getState().sessions[params.sessionId];
                if (currentSession) {
                    this.applySessions([
                        {
                            ...currentSession,
                            updatedAt: nowServerMs(),
                            seq: Math.max(currentSession.seq ?? 0, ack.data.seq),
                        }
                    ]);
                }

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

        // Automatic outbox retries never give up silently: exhaustion keeps the durable row and
        // exposes a typed failed send/cancellation state for explicit recovery.
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
                const wireMode = resolvePendingInputServerWireMode(await getServerFeaturesSnapshot({
                    serverId: params.outboxScope.serverId,
                }));
                const result = await retryPendingOutboxOperationV2({
                    sessionId: params.sessionId,
                    localId: params.localId,
                    request,
                    outboxScope: params.outboxScope,
                    wireMode,
                    onWireContractMismatch: async () => {
                        await getServerFeaturesSnapshot({
                            serverId: params.outboxScope.serverId,
                            force: true,
                        });
                    },
                });
                if (result.accepted || result.terminal || result.waitingForWireMode) {
                    clearRetry();
                    return;
                }
                scheduleRetryWithBackoff(attempt);
            } catch (error) {
                if (error instanceof PendingOutboxSessionNotHydratedError) {
                    scheduleRetryWithBackoff(attempt);
                    return;
                }
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
        requestedAction: import('@happier-dev/protocol').PendingRequestedActionV1,
    ): Promise<void> {
        assertSafePendingIdPathSegment(localId);
        const ownerContext = await this.resolvePendingQueueOwnerContext(sessionId);
        const wireMode = resolvePendingInputServerWireMode(await getServerFeaturesSnapshot({
            serverId: ownerContext.outboxScope.serverId,
        }));
        await updatePendingRequestedActionV2({
            sessionId,
            localId,
            requestedAction,
            request: ownerContext.request,
            outboxScope: ownerContext.outboxScope,
            wireMode,
        });
    }

    private createSessionSubmitPort(): SessionSubmitPort {
        const machineEncryptionReader = this.encryption as Readonly<{
            getMachineEncryption?: (machineId: string) => unknown;
        }>;
        const canWakeMachineId = typeof machineEncryptionReader.getMachineEncryption === 'function'
            ? (machineId: string) => Boolean(machineEncryptionReader.getMachineEncryption?.(machineId))
            : undefined;

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
            ...(canWakeMachineId ? { canWakeMachineId } : {}),
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

        const result = await submitSessionUserMessage(port, {
            sessionId,
            session,
            text,
            displayText,
            metaOverrides,
            configuredMode: state.settings.sessionMessageSendMode,
            busySteerSendPolicy: state.settings.sessionBusySteerSendPolicy,
            permissionModeApplyTiming: state.settings.sessionPermissionModeApplyTiming,
            // Programmatic path: never prompt here; 'ask' still hardens the decision (queue).
            nonSteerableSendPrompt: state.settings.sessionNonSteerableSendPrompt,
            resumeCapabilityOptions: buildResumeCapabilityOptionsFromUiState({
                settings: state.settings,
                results: undefined,
            }),
            permissionOverride: getPermissionModeOverrideForSpawn(session),
            ...(options?.forceImmediate === true
                ? {
                    explicitMode: 'server_pending' as const,
                    forceImmediate: true,
                }
                : {}),
            callerSurface: options?.callerSurface ?? 'sync_submit_message',
        });

        if (result.type === 'send_failed' || result.type === 'rejected' || result.type === 'wake_failed') {
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
        options?: Readonly<{ serverId?: string | null }>,
    ): Promise<void> {
        const resolvedServerIdOverride =
            typeof options?.serverId === 'string' && options.serverId.trim().length > 0
                ? options.serverId.trim()
                : null;

        const fetchLatestSession = async () => {
            if (!this.credentials) {
                throw new Error('Sync credentials not available');
            }
            await fetchSessionByIdWithServerScope({
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
            });
        };

        const resolvePatchContext = () => {
            const session = storage.getState().sessions[sessionId] ?? null;
            const sessionEncryptionMode: 'e2ee' | 'plain' = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
            const encryption = sessionEncryptionMode === 'plain' ? null : this.encryption.getSessionEncryption(sessionId);
            return { session, sessionEncryptionMode, encryption };
        };

        let patchContext = resolvePatchContext();
        if (!patchContext.session?.metadata || (patchContext.sessionEncryptionMode === 'e2ee' && !patchContext.encryption)) {
            await fetchLatestSession();
            patchContext = resolvePatchContext();
        }

        if (patchContext.sessionEncryptionMode === 'e2ee' && !patchContext.encryption) {
            throw new Error(`Session ${sessionId} not found`);
        }

        await updateSessionMetadataWithRetryRpc<Metadata>({
            sessionId,
            getSession: () => {
                const s = storage.getState().sessions[sessionId];
                if (!s?.metadata) return null;
                return { metadataVersion: s.metadataVersion, metadata: s.metadata };
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
                return await patchContext.encryption.encryptMetadata(metadata);
            },
            decryptMetadata: async (version, encrypted) => {
                if (patchContext.sessionEncryptionMode !== 'plain') {
                    if (!patchContext.encryption) {
                        throw new Error(`Session ${sessionId} not found`);
                    }
                    return await patchContext.encryption.decryptMetadata(version, encrypted);
                }
                try {
                    const parsedJson = JSON.parse(encrypted);
                    const parsed = MetadataSchema.safeParse(parsedJson);
                    return parsed.success ? parsed.data : null;
                } catch {
                    return null;
                }
            },
            emitUpdateMetadata: async (payload) => await emitSessionMetadataUpdateWithServerScope({
                sessionId,
                expectedVersion: payload.expectedVersion,
                metadata: payload.metadata,
                ...(resolvedServerIdOverride ? { serverId: resolvedServerIdOverride } : {}),
            }),
            applySessionMetadata: ({ metadataVersion, metadata }) => {
                const currentSession = storage.getState().sessions[sessionId];
                if (!currentSession) return;
                this.applySessions([{
                    ...currentSession,
                    metadata,
                    metadataVersion,
                }]);
            },
            updater,
            maxAttempts: 8,
        });
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
        const existing = session.metadata?.readStateV1;
        const existingSeq = existing?.sessionSeq ?? 0;
        const needsRepair = existingSeq > sessionSeq;
        const existingAuthoritativeSeq =
            typeof session.lastViewedSessionSeq === 'number' && Number.isFinite(session.lastViewedSessionSeq)
                ? Math.max(0, Math.trunc(session.lastViewedSessionSeq))
                : 0;
        const nextAuthoritativeSeq = Math.max(existingAuthoritativeSeq, sessionSeq);

        const early = computeNextReadStateV1({
            prev: existing,
            sessionSeq,
            pendingActivityAt,
            now: nowServerMs(),
        });

        const shouldPublishReadCursor = nextAuthoritativeSeq > existingAuthoritativeSeq;
        if (!needsRepair && !early.didChange && !shouldPublishReadCursor) return;

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

        if (!session.metadata) {
            return;
        }

        await this.updateSessionMetadataWithRetry(sessionId, (metadata) => {
            const result = computeNextReadStateV1({
                prev: metadata.readStateV1,
                sessionSeq,
                pendingActivityAt,
                now: nowServerMs(),
            });
            if (!result.didChange) return metadata;
            return { ...metadata, readStateV1: result.next };
        });
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

    async publishSessionModelOverrideToMetadata(params: {
        sessionId: string;
        modelId: string;
        updatedAt: number;
    }): Promise<void> {
        await publishModelOverrideToMetadataEngine({
            sessionId: params.sessionId,
            modelId: params.modelId,
            updatedAt: params.updatedAt,
                retireModelScopedConfigOverrides: getModelScopedConfigTombstonesV1Supported(
                storage.getState().sessions[params.sessionId]?.agentState?.capabilities,
            ),
            updateSessionMetadataWithRetry: (sessionId, updater) => this.updateSessionMetadataWithRetry(sessionId, updater),
        });
    }

    /**
     * Seed `sessionModelsV1` from the new-session wizard's preflight probe. Best-effort and
     * seed-only: providers without a static catalog publish the authoritative list once their
     * runtime starts, and that publish overwrites this seed.
     */
    async publishSessionModelsSeedToMetadata(params: {
        sessionId: string;
        serverId?: string | null;
        agentId: string;
        currentModelId: string;
        availableModels: PreflightModelList['availableModels'];
        updatedAt: number;
    }): Promise<void> {
        await publishSessionModelsSeedToMetadataEngine({
            sessionId: params.sessionId,
            serverId: params.serverId,
            provider: params.agentId,
            currentModelId: params.currentModelId,
            availableModels: params.availableModels,
            updatedAt: params.updatedAt,
            updateSessionMetadataWithRetry: (sessionId, updater, options) => this.updateSessionMetadataWithRetry(sessionId, updater, options),
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
        // Replay the durable outbox first so a message persisted before an app kill during a stalled
        // send is re-hydrated (visible + retriable) and reconciled against the server pending list.
        if (
            expectedOutboxScope
            && !areServerAccountScopesEqual(getActiveServerAccountScope(), expectedOutboxScope)
        ) {
            return;
        }
        const ownerContext = await this.resolvePendingQueueOwnerContext(sessionId);
        const outboxScope = ownerContext.outboxScope;
        if (
            expectedOutboxScope
            && !areServerAccountScopesEqual(outboxScope, expectedOutboxScope)
        ) {
            return;
        }
        const replayLocalIds = replayPersistedPendingOutboxForSession(sessionId, outboxScope);
        for (const localId of replayLocalIds) {
            this.schedulePendingOutboxOperationRetry({ sessionId, localId, outboxScope });
        }
        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: ownerContext.readEncryption,
            request: ownerContext.request,
            outboxScope,
            isOutboxScopeCurrent: () => this.isPendingQueueOwnerScopeCurrent(sessionId, outboxScope),
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
            onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void;
            requestedAction: import('@happier-dev/protocol').PendingRequestedActionV1;
        }>,
    ): Promise<PendingMessageEnqueueResultV2> {
        const ownerContext = await this.resolvePendingQueueOwnerContext(sessionId);
        const outboxScope = ownerContext.outboxScope;
        const wireMode = resolvePendingInputServerWireMode(await getServerFeaturesSnapshot({
            serverId: outboxScope.serverId,
        }));
        this.markSessionLiveTailIntent(sessionId);
        const result = await enqueuePendingMessageV2({
            sessionId,
            text,
            displayText,
            localId: options?.localId ?? undefined,
            deliveryMode: options?.deliveryMode,
            metaOverrides,
            encryption: ownerContext.enqueueEncryption,
            fetchArtifactWithBody: (artifactId) => this.fetchArtifactWithBody(artifactId),
            updateArtifact: (artifact) => storage.getState().updateArtifact(artifact),
            request: ownerContext.request,
            outboxScope,
            requestedAction: options?.requestedAction ?? { v: 1, kind: 'enqueue' },
            wireMode,
            onWireContractMismatch: async () => {
                await getServerFeaturesSnapshot({ serverId: outboxScope.serverId, force: true });
            },
            onLocalPendingProjectionCreated: options?.onLocalPendingProjectionCreated,
        });
        if (result.accepted === false && !result.terminal && !result.waitingForWireMode && readPendingLocalId(result.localId) !== null) {
            this.schedulePendingOutboxOperationRetry({ sessionId, localId: result.localId, outboxScope });
        }
        return result;
    }

    /**
     * User-initiated retry of the row's durable outbox operation. Enqueue reuses the exact body;
     * cancellation reissues idempotent DELETE. Neither substitutes the active server/account.
     */
    async retryPendingMessageSend(sessionId: string, localId: string): Promise<void> {
        const ownerContext = await this.resolvePendingQueueOwnerContext(sessionId);
        const outboxScope = ownerContext.outboxScope;
        const pending = storage.getState().sessionPending[sessionId]?.messages?.find((message) =>
            isPendingOutboxProjectionForIdentity(message, { sessionId, localId, outboxScope })
        );
        if (!pending) throw new Error('Pending retry requires its persisted server-account scope');
        this.markSessionLiveTailIntent(sessionId);
        setPendingMessageSendState(sessionId, localId, 'unconfirmed', outboxScope);
        try {
            const wireMode = resolvePendingInputServerWireMode(await getServerFeaturesSnapshot({
                serverId: outboxScope.serverId,
            }));
            const result = await retryPendingOutboxOperationV2({
                sessionId,
                localId,
                request: ownerContext.request,
                outboxScope,
                wireMode,
                onWireContractMismatch: async () => {
                    await getServerFeaturesSnapshot({ serverId: outboxScope.serverId, force: true });
                },
            });
            if (!result.accepted && !result.terminal && !result.waitingForWireMode) {
                this.schedulePendingOutboxOperationRetry({ sessionId, localId, outboxScope });
            }
        } catch (error) {
            if (isTerminalAuthError(error)) {
                recordTerminalAuthSyncError(error);
            }
            setPendingMessageSendState(sessionId, localId, 'failed', outboxScope);
        }
    }

    async updatePendingMessage(sessionId: string, pendingId: string, text: string): Promise<void> {
        const ownerContext = await this.resolvePendingQueueOwnerContext(sessionId);
        await updatePendingMessageV2({
            sessionId,
            pendingId,
            text,
            encryption: ownerContext.enqueueEncryption,
            fetchArtifactWithBody: (artifactId) => this.fetchArtifactWithBody(artifactId),
            updateArtifact: (artifact) => storage.getState().updateArtifact(artifact),
            request: ownerContext.request,
            outboxScope: ownerContext.outboxScope,
        });
    }

    async deletePendingMessage(sessionId: string, pendingId: string): Promise<void> {
        const ownerContext = await this.resolvePendingQueueOwnerContext(sessionId);
        await deletePendingMessageV2({
            sessionId,
            pendingId,
            request: ownerContext.request,
            outboxScope: ownerContext.outboxScope,
        });
    }

    async discardPendingMessage(
        sessionId: string,
        pendingId: string,
        opts?: { reason?: 'switch_to_local' | 'manual' }
    ): Promise<void> {
        const ownerContext = await this.resolvePendingQueueOwnerContext(sessionId);
        await discardPendingMessageV2({
            sessionId,
            pendingId,
            reason: opts?.reason ?? 'manual',
            encryption: ownerContext.readEncryption,
            request: ownerContext.request,
            outboxScope: ownerContext.outboxScope,
            isOutboxScopeCurrent: () => this.isPendingQueueOwnerScopeCurrent(sessionId, ownerContext.outboxScope),
        });
    }

    async markPendingDeliveryHandled(sessionId: string, pendingId: string): Promise<void> {
        const ownerContext = await this.resolvePendingQueueOwnerContext(sessionId);
        await markPendingDeliveryHandledV2({
            sessionId,
            pendingId,
            encryption: ownerContext.readEncryption,
            request: ownerContext.request,
            outboxScope: ownerContext.outboxScope,
            isOutboxScopeCurrent: () => this.isPendingQueueOwnerScopeCurrent(sessionId, ownerContext.outboxScope),
        });
    }

    async blockPendingDelivery(
        sessionId: string,
        pendingId: string,
        reason: PendingDeliveryBlockedReason,
    ): Promise<void> {
        const ownerContext = await this.resolvePendingQueueOwnerContext(sessionId);
        await blockPendingDeliveryV2({
            sessionId,
            pendingId,
            reason,
            encryption: ownerContext.readEncryption,
            request: ownerContext.request,
            outboxScope: ownerContext.outboxScope,
            isOutboxScopeCurrent: () => this.isPendingQueueOwnerScopeCurrent(
                sessionId,
                ownerContext.outboxScope,
            ),
        });
    }

    async dismissPendingDelivery(sessionId: string, pendingId: string): Promise<void> {
        const ownerContext = await this.resolvePendingQueueOwnerContext(sessionId);
        await dismissPendingDeliveryV2({
            sessionId,
            pendingId,
            encryption: ownerContext.readEncryption,
            request: ownerContext.request,
            outboxScope: ownerContext.outboxScope,
            isOutboxScopeCurrent: () => this.isPendingQueueOwnerScopeCurrent(sessionId, ownerContext.outboxScope),
        });
    }

    async sendPendingDeliveryAsNew(sessionId: string, pendingId: string): Promise<void> {
        const ownerContext = await this.resolvePendingQueueOwnerContext(sessionId);
        await sendPendingDeliveryAsNewV2({
            sessionId,
            pendingId,
            encryption: ownerContext.readEncryption,
            request: ownerContext.request,
            outboxScope: ownerContext.outboxScope,
            isOutboxScopeCurrent: () => this.isPendingQueueOwnerScopeCurrent(sessionId, ownerContext.outboxScope),
        });
    }

    async restoreDiscardedPendingMessage(sessionId: string, pendingId: string): Promise<void> {
        const ownerContext = await this.resolvePendingQueueOwnerContext(sessionId);
        await restoreDiscardedPendingMessageV2({
            sessionId,
            pendingId,
            encryption: ownerContext.readEncryption,
            request: ownerContext.request,
            outboxScope: ownerContext.outboxScope,
            isOutboxScopeCurrent: () => this.isPendingQueueOwnerScopeCurrent(sessionId, ownerContext.outboxScope),
        });
    }

    async deleteDiscardedPendingMessage(sessionId: string, pendingId: string): Promise<void> {
        const ownerContext = await this.resolvePendingQueueOwnerContext(sessionId);
        await deleteDiscardedPendingMessageV2({
            sessionId,
            pendingId,
            encryption: ownerContext.readEncryption,
            request: ownerContext.request,
            outboxScope: ownerContext.outboxScope,
            isOutboxScopeCurrent: () => this.isPendingQueueOwnerScopeCurrent(sessionId, ownerContext.outboxScope),
        });
    }

    async reorderPendingMessages(sessionId: string, orderedLocalIds: string[]): Promise<void> {
        const ownerContext = await this.resolvePendingQueueOwnerContext(sessionId);
        const pendingMessages = storage.getState().sessionPending[sessionId]?.messages ?? [];
        const canonicalOrderedLocalIds = orderedLocalIds.map((identifier) => {
            const exactScopedProjection = pendingMessages.find((message) =>
                message.id === identifier
                && message.pendingOutboxQuarantineReason === undefined
                && areServerAccountScopesEqual(message.pendingOutboxScope, ownerContext.outboxScope)
            );
            return exactScopedProjection?.localId ?? identifier;
        });
        await reorderPendingMessagesV2({
            sessionId,
            orderedLocalIds: canonicalOrderedLocalIds,
            encryption: ownerContext.readEncryption,
            request: ownerContext.request,
            outboxScope: ownerContext.outboxScope,
            isOutboxScopeCurrent: () => this.isPendingQueueOwnerScopeCurrent(sessionId, ownerContext.outboxScope),
        });
    }

    applySettings = (delta: Partial<Settings>, options?: { source?: SettingsAnalyticsSource }) => {
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
        const generation = this.serverScopeGeneration;
        const { shouldContinue } = createSyncGenerationGuard({
            capturedGeneration: generation,
            getCurrentGeneration: () => this.serverScopeGeneration,
        });
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
        const generation = this.serverScopeGeneration;
        const { shouldContinue } = createSyncGenerationGuard({
            capturedGeneration: generation,
            getCurrentGeneration: () => this.serverScopeGeneration,
        });
        return await presentPaywallEngine({
            revenueCatInitialized: this.revenueCatInitialized,
            shouldContinue,
            trackPaywallPresented,
            trackPaywallPurchased,
            trackPaywallCancelled,
            trackPaywallRestored,
            trackPaywallError,
            syncPurchases: () => shouldContinue() ? this.syncPurchases() : Promise.resolve(),
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

    private getPrioritizedSessionHydrationIds = (): string[] => {
        const activeViewingSessionId = getActiveViewingSessionId();
        const visibleSessionIds = getVisibleSessionIds();
        const viewportPriorityLimit = Math.max(0, this.syncTuning.sessionViewportHydrationPriorityMaxRows);
        const prioritizedByViewport = Array.from(this.sessionViewport.entries())
            .sort((left, right) => right[1].lastUpdatedAt - left[1].lastUpdatedAt)
            .slice(0, viewportPriorityLimit)
            .map(([sessionId]) => sessionId);

        return Array.from(new Set([
            ...(activeViewingSessionId ? [activeViewingSessionId] : []),
            ...visibleSessionIds,
            ...prioritizedByViewport,
        ]));
    }

    private fetchSessions = async (options?: FetchSessionsOptions) => {
        if (!this.credentials) return;
        const generation = this.serverScopeGeneration;
        if (canShareFetchSessionsInFlight(options)) {
            const existing = this.fetchSessionsInFlight;
            if (existing && existing.generation === generation) {
                return existing.promise;
            }
        }
        const runFetch = this.fetchSessionsOnce(options, generation);
        if (canShareFetchSessionsInFlight(options)) {
            const sharedFetch = runFetch.finally(() => {
                if (this.fetchSessionsInFlight?.promise === sharedFetch) {
                    this.fetchSessionsInFlight = null;
                }
            });
            this.fetchSessionsInFlight = { generation, promise: sharedFetch };
            return sharedFetch;
        }
        return runFetch;
    }

    private fetchSessionsOnce = async (options: FetchSessionsOptions | undefined, generation: number) => {
        const shouldContinue = () => this.serverScopeGeneration === generation;
        const initialState = storage.getState();
        const activeServerSnapshot = getActiveServerSnapshot();
        const activeServerId = String(activeServerSnapshot.serverId ?? '').trim() || null;
        const warmCacheAccountId = resolveWarmCacheAccountScope(initialState.profile?.id);
        // Reuse the entries the warm cache already holds instead of allocating a fresh
        // projection of every renderable on every fetch (including every resume); rows
        // outside the persisted window are still projected so metadata coverage is
        // unchanged.
        const cachedSessionListEntries = buildSessionListCacheEntriesFromRenderables(
            initialState.sessionListRenderables,
            readPersistedSessionListWarmCacheEntries(activeServerId, warmCacheAccountId),
        );
        const activeViewingSessionId = getActiveViewingSessionId();
        const visibleSessionIds = getVisibleSessionIds();
        const activeHydrationSessionIds = Array.from(new Set([
            ...(activeViewingSessionId ? [activeViewingSessionId] : []),
            ...visibleSessionIds,
        ]));
        const activeHydrationSessionIdSet = new Set(activeHydrationSessionIds);
        const explicitPrioritizedHydrationIds = normalizeSessionListHydrationSessionIds(options?.prioritizeSessionIds);
        const explicitPrioritizedHydrationIdSet = new Set(explicitPrioritizedHydrationIds);
        const runtimePrioritizedHydrationIds = normalizeSessionListHydrationSessionIds(this.getPrioritizedSessionHydrationIds());
        const prioritizedHydrationIds = Array.from(new Set([
            ...explicitPrioritizedHydrationIds,
            ...runtimePrioritizedHydrationIds,
        ])).filter((sessionId) => (
            !activeHydrationSessionIdSet.has(sessionId)
            || explicitPrioritizedHydrationIdSet.has(sessionId)
        ));
        const isAppend = options?.mode === 'append';
        const includeActiveSessionRows = !isAppend;
        const includeSessionListAttentionRows = !isAppend && shouldIncludeSessionListAttentionRows(initialState.settings);
        // The list paints pinned rows, folders and manual order from organization state, so a
        // boot with none of it would either wait for this round trip or rearrange itself once
        // the snapshot lands. The warm cache removes both: boot hydration restores the
        // organization the user left behind, which is what makes this a background refresh.
        // Only a scope that has never cached an organization still waits, and it has nothing
        // on screen that could move.
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
                void organizationSnapshotRefresh
                    .then(() => {
                        if (!shouldContinue()) return;
                        persistSessionOrganizationWarmCache(
                            activeServerId,
                            warmCacheAccountId,
                            buildOrganizationProjectionForServer(storage.getState(), activeServerId),
                        );
                    })
                    .catch(() => undefined);
            } else {
                await organizationSnapshotRefresh;
            }
        }
        const organizationProjection = isAppend
            ? null
            : buildOrganizationProjectionForServer(storage.getState(), activeServerId);
        const hasOrganizationSnapshot = organizationProjection?.version != null;
        // One owner for the organization rows this list must hold — pinned sessions and sessions the
        // user explicitly kept in Needs attention — so a placement the snapshot already carries can
        // never be computed against a row the cursor page left behind.
        const organizationRequiredSessionIds = listSessionOrganizationRequiredHydrationSessionIds(organizationProjection);
        if (hasOrganizationSnapshot) {
            persistSessionOrganizationWarmCache(activeServerId, warmCacheAccountId, organizationProjection);
        }
        const requiredHydrationSessionIds = Array.from(new Set([
            ...normalizeSessionListHydrationSessionIds(options?.requiredHydrationSessionIds),
            ...organizationRequiredSessionIds,
        ]));
        const awaitSessionListHydration = options?.awaitSessionListHydration === true
            || organizationRequiredSessionIds.length > 0;
        if (syncPerformanceTelemetry.isEnabled()) {
            syncPerformanceTelemetry.count(
                'sync.sessions.fetch.hydrationInputs',
                buildSessionListFetchHydrationTelemetryFields({
                    mode: options?.mode ?? 'replace',
                    awaitSessionListHydration,
                    source: options?.hydrationTelemetrySource,
                    requiredHydrationSessionIds: options?.requiredHydrationSessionIds,
                    organizationRequiredSessionIds,
                    explicitPrioritizedSessionIds: explicitPrioritizedHydrationIds,
                    runtimePrioritizedSessionIds: runtimePrioritizedHydrationIds,
                    prioritizedHydrationSessionIds: prioritizedHydrationIds,
                    activeViewingSessionId,
                    visibleSessionIds,
                    activeHydrationSessionIds,
                    includeActiveSessionRows,
                    includeSessionListAttentionRows,
                }),
            );
        }
        const result = await fetchAndApplySessions({
            serverId: activeServerId,
            sessionListCursor: isAppend ? this.sessionListNextCursor : null,
            sessionListMaxPages: 1,
            includeActiveSessionRows,
            includeSessionListAttentionRows,
            credentials: this.credentials,
            encryption: this.encryption,
            sessionDataKeys: this.sessionDataKeys,
            sessionDataKeyEnvelopes: this.sessionDataKeyEnvelopes,
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
            awaitSessionListHydration,
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
        if (!activeCredentials || !activeEncryption) return;
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
                        handleDeleteSessionSocketUpdate({
                            sessionId,
                            deleteSession: (targetSessionId) => storage.getState().deleteSession(targetSessionId),
                            removeSessionEncryption: (targetSessionId) => activeEncryption.removeSessionEncryption(targetSessionId),
                            removeProjectManagerSession: (targetSessionId) => projectManager.removeSession(targetSessionId),
                            clearScmStatusForSession: (targetSessionId) => scmStatusSync.clearForSession(targetSessionId),
                            log,
                        });
                        this.commitSessionDataKeyCacheEntry(
                            sessionId,
                            stagedSessionDataKeys,
                            stagedSessionDataKeyEnvelopes,
                        );
                        return;
                    }
                    throw new Error(
                        `Required session shell hydration failed for ${sessionId}: ${exactResult.errorCode ?? 'unknown'}`,
                    );
                }
                this.commitSessionDataKeyCacheEntry(
                    sessionId,
                    stagedSessionDataKeys,
                    stagedSessionDataKeyEnvelopes,
                );
            }),
            this.syncTuning.sessionListHydrationConcurrencyLimit,
        );
        if (!shouldContinue()) return;
        this.sessionListNextCursor = result.hasNext ? result.nextCursor : null;
        this.sessionListHasMore = result.hasNext;
    }

    public fetchMoreSessions = async (): Promise<void> => {
        if (!this.credentials || !this.sessionListHasMore || !this.sessionListNextCursor) return;
        if (this.fetchMoreSessionsInFlight) return this.fetchMoreSessionsInFlight;
        const promise = this.fetchSessions({ mode: 'append' }).finally(() => {
            if (this.fetchMoreSessionsInFlight === promise) {
                this.fetchMoreSessionsInFlight = null;
            }
        });
        this.fetchMoreSessionsInFlight = promise;
        return promise;
    }

    private fetchArchivedSessionsPage = async (options?: FetchArchivedSessionsOptions): Promise<void> => {
        if (!this.credentials) return;
        const generation = this.serverScopeGeneration;
        const shouldContinue = () => this.serverScopeGeneration === generation;
        const isAppend = options?.mode === 'append';
        const result = await fetchAndApplySessions({
            sessionListPath: '/v2/sessions/archived',
            sessionListCursor: isAppend ? this.archivedSessionListNextCursor : null,
            sessionListMaxPages: 1,
            serverId: String(getActiveServerSnapshot().serverId ?? '').trim() || null,
            credentials: this.credentials,
            encryption: this.encryption,
            sessionDataKeys: this.sessionDataKeys,
            sessionDataKeyEnvelopes: this.sessionDataKeyEnvelopes,
            getExistingSession: (sessionId) => storage.getState().sessions[sessionId] ?? null,
            shouldContinue,
            applySessions: (sessions) => {
                if (!shouldContinue()) return;
                this.applySessions(sessions);
            },
            repairInvalidReadStateV1: (params) => this.repairInvalidReadStateV1(params),
            log,
        });
        if (!shouldContinue()) return;
        this.archivedSessionListNextCursor = result.hasNext ? result.nextCursor : null;
        this.archivedSessionListHasMore = result.hasNext;
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
        if (this.isSessionKnownOnActiveServer(sessionId)) {
            return true;
        }

        const preferredServerId = resolvePreferredServerIdForSessionId(sessionId);
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        if (preferredServerId && !areServerProfileIdentifiersEquivalent(preferredServerId, activeServerId)) {
            return true;
        }
        // The active-server list snapshot is not an exhaustive session registry: archived
        // sessions and rows beyond the snapshot page are absent while still being owned by
        // the active server. A storage-present session whose resolved owner IS the active
        // server is known — this guard exists to prevent cross-server fetches, not to
        // classify snapshot membership.
        return Boolean(storage.getState().sessions[sessionId]);
    }

    private createSessionRequest = (sessionId: string): ((path: string, init?: RequestInit) => Promise<Response>) => {
        return createSessionRequestWithServerScope({
            serverId: resolvePreferredServerIdForSessionId(sessionId),
            activeRequest: (path, init) => apiSocket.request(path, init),
        });
    }

    private async resolvePendingQueueOwnerRoute(sessionId: string) {
        const preferredServerId = resolvePreferredServerIdForSessionId(sessionId);
        const context = await resolveServerScopedSessionContext({
            serverId: preferredServerId,
            timeoutMs: this.syncTuning.sessionRpcTimeoutMs,
        });
        if (context.scope === 'active') {
            return { context, outboxScope: requireActivePendingOutboxScope() } as const;
        }

        const outboxScope = createServerAccountScope(context.targetServerId, context.targetAccountId);
        if (!outboxScope) {
            throw new Error('Pending queue owner did not resolve to a server-account scope');
        }
        return { context, outboxScope } as const;
    }

    private async resolvePendingQueueOwnerContext(
        sessionId: string,
        expectedActiveScope?: ServerAccountScope,
    ): Promise<ResolvedPendingQueueOwnerContext> {
        if (expectedActiveScope) {
            const assertCapturedActiveScope = (): void => {
                if (!areServerAccountScopesEqual(getActiveServerAccountScope(), expectedActiveScope)) {
                    throw new Error('Pending queue owner scope changed');
                }
            };
            return {
                outboxScope: expectedActiveScope,
                request: async (path, init) => {
                    assertCapturedActiveScope();
                    const response = await apiSocket.request(path, init);
                    assertCapturedActiveScope();
                    return response;
                },
                enqueueEncryption: this.encryption,
                readEncryption: this.encryption,
            };
        }
        const route = await this.resolvePendingQueueOwnerRoute(sessionId);
        if (route.context.scope === 'active') {
            const assertCapturedActiveScope = (): void => {
                if (!areServerAccountScopesEqual(getActiveServerAccountScope(), route.outboxScope)) {
                    throw new Error('Pending queue owner scope changed');
                }
            };
            return {
                outboxScope: route.outboxScope,
                request: async (path, init) => {
                    // apiSocket is dynamically bound to the active account. Fence immediately
                    // before entering it, then fence again before any caller applies completion.
                    assertCapturedActiveScope();
                    const response = await apiSocket.request(path, init);
                    assertCapturedActiveScope();
                    return response;
                },
                enqueueEncryption: this.encryption,
                readEncryption: this.encryption,
            };
        }

        const session = storage.getState().sessions[sessionId] ?? null;
        const sessionEncryption = session?.encryptionMode === 'plain'
            ? null
            : await resolveScopedPendingSessionEncryption({ context: route.context, sessionId });
        const ownerEncryption = {
            getSessionEncryption: (candidateSessionId: string) =>
                candidateSessionId === sessionId ? sessionEncryption : null,
        } satisfies PendingQueueEncryption & PendingQueueReadEncryption;
        return {
            outboxScope: route.outboxScope,
            request: createSessionRequestForResolvedServerScope({
                context: route.context,
                activeRequest: async () => {
                    throw new Error('Pending queue owner unexpectedly resolved through the active request');
                },
            }),
            enqueueEncryption: ownerEncryption,
            readEncryption: ownerEncryption,
        };
    }

    private async isPendingQueueOwnerScopeCurrent(
        sessionId: string,
        expectedScope: ServerAccountScope,
    ): Promise<boolean> {
        const preferredServerId = resolvePreferredServerIdForSessionId(sessionId);
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        if (!preferredServerId || areServerProfileIdentifiersEquivalent(preferredServerId, activeServerId)) {
            return areServerAccountScopesEqual(getActiveServerAccountScope(), expectedScope);
        }
        const context = await resolveServerScopedSessionContext({
            serverId: preferredServerId,
            timeoutMs: this.syncTuning.sessionRpcTimeoutMs,
        });
        return context.scope === 'scoped'
            && areServerAccountScopesEqual(
                createServerAccountScope(context.targetServerId, context.targetAccountId),
                expectedScope,
            );
    }

    private createSessionMessagesRequest = (sessionId: string): ((path: string) => Promise<Response>) => {
        const request = this.createSessionRequest(sessionId);
        return (path: string) => request(path, { method: 'GET' });
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
              this.settingsSync.invalidateCoalesced();
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

      public resumeSync = (reason: 'app-foreground' | 'socket-reconnect' | 'manual' | 'server-reachable'): Promise<void> => {
          return runWithInFlightDedupe(
              {
                  get: () => this.resumeInFlight,
                  set: (value) => {
                      this.resumeInFlight = value;
                  },
              },
              async () => {
                  const shouldContinue = this.createServerScopeGuard();
                  if ((reason === 'socket-reconnect' || reason === 'server-reachable') && !this.isForeground) {
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

                  const accountId = String(this.serverID ?? '').trim() || null;

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

                  await this.ensureSessionDraftRepositoryRuntimeReady({
                      forceSnapshotHydration: reason === 'manual' || this.sessionDraftOfflineCatchUpPending,
                  });
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
                  await this.catchUpLoadedDirectSessionsOnResume();
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

                  // Activity/presence updates are delivered via ephemerals and are not recovered for the
                  // window in which the socket was down. Gate this on measured socket downtime rather than the
                  // resume reason: a background→foreground cycle disconnects the socket intentionally, and an
                  // intentional disconnect resets apiSocket's reconnect bookkeeping, so `socket-reconnect`
                  // never fires for it. Gating on the reason left a resuming client with stale session.active
                  // and machine-online state until the next keep-alive ephemeral (0–20s).
                  //
                  // Skip whatever the changes catch-up already refreshed in this same resume: it
                  // runs the identical full refresh (session-organization + sessions/active +
                  // /v2/sessions?includeAttention, /v1/machines) and its session refresh awaits
                  // hydration, so repeating it here fired a second complete catch-up wave seconds
                  // after the first.
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
          if (this.isBootstrapSyncRunning) {
              return;
          }
          if (this.pauseController.isPaused()) {
              return;
          }
          await this.pauseController.waitUntilResumed();
          if (!this.credentials) {
              return;
          }
          if (this.isBootstrapSyncRunning) {
              return;
          }
          this.isBootstrapSyncRunning = true;
          this.legacySessionOrganizationImportedPinnedSessionIdsForBootstrap.clear();

          const invalidateBounded = async (syncUnit: InvalidateSync, timeoutMs: number): Promise<void> => {
              syncUnit.invalidateCoalesced();
              await syncUnit.awaitQueue({ timeoutMs });
          };

          try {
              // Bootstrap concurrency is slightly higher to reduce time-to-first-render.
              const bootstrapConcurrencyLimit = this.syncTuning.bootstrapConcurrencyLimit;

              // Phase 1: load core UI state (settings/profile) while also loading sessions/machines.
              await runTasksWithLimit(
                  [
                      () => invalidateBounded(this.settingsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                      () => invalidateBounded(this.profileSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                      () => invalidateBounded(this.sessionsSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                      () => invalidateBounded(this.machinesSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                      () => invalidateBounded(this.purchasesSync, this.syncTuning.invalidateSyncAwaitTimeoutMs),
                  ],
                  bootstrapConcurrencyLimit
              );

              await this.ensureSessionDraftRepositoryRuntimeReady();

              await this.rearmPendingOutboxForActiveScope();

              const importedPinnedSessionIds = this.consumeBootstrapLegacyOrganizationImportedPinnedSessionIds();
              if (importedPinnedSessionIds.length > 0) {
                  await this.fetchSessions({
                      awaitSessionListHydration: true,
                      requiredHydrationSessionIds: importedPinnedSessionIds,
                      prioritizeSessionIds: importedPinnedSessionIds,
                      hydrationTelemetrySource: 'bootstrapImportedPins',
                  });
              }

              try {
                  storage.getState().applyReady();
              } catch {
                  // ignore
              }

              // Phase 2: load non-critical lists.
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
          } finally {
              this.isBootstrapSyncRunning = false;
              this.legacySessionOrganizationImportedPinnedSessionIdsForBootstrap.clear();
          }
        };

      private snapshotRefreshOnResume = async (opts: { mode: 'fallback' | 'long-offline'; reason: string }): Promise<void> => {
          if (this.pauseController.isPaused()) {
              return;
          }
          await this.pauseController.waitUntilResumed();
          if (!this.credentials) {
              return;
          }

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
              ],
              concurrencyLimit
          );

          await this.ensureSessionDraftRepositoryRuntimeReady({ forceSnapshotHydration: true });

          // Catch up transcripts only for sessions that are already loaded locally AND are live
          // content consumers right now. The catch-up policy already no-ops for hidden
          // non-consumers (see fetchMessages); this filter just avoids enqueueing idle
          // InvalidateSync units for every loaded-but-hidden session on each reconnect sweep.
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
            return await this.fetchSessions({ awaitSessionListHydration: true });
        }
        return this.sessionsSync.invalidateAndAwait();
    }

    /**
     * Generic session metadata patching surface for feature modules that need to
     * atomically update encrypted metadata (with version-mismatch retries).
     */
    public patchSessionMetadataWithRetry = async (
        sessionId: string,
        updater: (metadata: Metadata) => Metadata,
        options?: Readonly<{ serverId?: string | null }>,
    ): Promise<void> => {
        await this.updateSessionMetadataWithRetry(sessionId, updater, options);
    }

    public refreshAutomations = async () => {
        return this.automationsSync.invalidateAndAwait();
    }

    public async fetchAutomationRuns(automationId: string, limit: number = 20): Promise<{ nextCursor: string | null }> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const generation = this.serverScopeGeneration;
        const { shouldContinue } = createSyncGenerationGuard({
            capturedGeneration: generation,
            getCurrentGeneration: () => this.serverScopeGeneration,
        });

        return await fetchAndApplyAutomationRuns({
            credentials: this.credentials,
            automationId,
            limit,
            shouldContinue,
            setAutomationRuns: (id, runs) => storage.getState().setAutomationRuns(id, runs),
        });
    }

    public async createAutomation(input: AutomationCreateInput): Promise<Automation> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const created = await createAutomationApi(this.credentials, input);
        storage.getState().upsertAutomation(created);
        return created;
    }

    public async updateAutomation(automationId: string, input: AutomationPatchInput): Promise<Automation> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const updated = await updateAutomationApi(this.credentials, automationId, input);
        storage.getState().upsertAutomation(updated);
        return updated;
    }

    public async replaceAutomationAssignments(
        automationId: string,
        assignments: ReadonlyArray<AutomationAssignmentInput>,
    ): Promise<Automation> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const updated = await replaceAutomationAssignmentsApi(this.credentials, automationId, assignments);
        storage.getState().upsertAutomation(updated);
        return updated;
    }

    public async pauseAutomation(automationId: string): Promise<Automation> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const updated = await pauseAutomationApi(this.credentials, automationId);
        storage.getState().upsertAutomation(updated);
        return updated;
    }

    public async resumeAutomation(automationId: string): Promise<Automation> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const updated = await resumeAutomationApi(this.credentials, automationId);
        storage.getState().upsertAutomation(updated);
        return updated;
    }

    public async deleteAutomation(automationId: string): Promise<void> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        await deleteAutomationApi(this.credentials, automationId);
        storage.getState().removeAutomation(automationId);
    }

    public async runAutomationNow(automationId: string): Promise<AutomationRun> {
        if (!this.credentials) {
            throw new Error('Not authenticated');
        }
        const run = await runAutomationNowApi(this.credentials, automationId);
        storage.getState().upsertAutomationRun(run);
        return run;
    }

    public getCredentials() {
        return this.credentials;
    }

    // Artifact methods
    public fetchArtifactsList = async (): Promise<void> => {
        const generation = this.serverScopeGeneration;
        const { shouldContinue } = createSyncGenerationGuard({
            capturedGeneration: generation,
            getCurrentGeneration: () => this.serverScopeGeneration,
        });
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
        const sourceServerId = String(getActiveServerSnapshot().serverId ?? '').trim() || null;
        const shouldContinue = () => this.serverScopeGeneration === generation;
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
            machineDisplayEagerHydrationCount: this.syncTuning.machineDisplayEagerHydrationCount,
            machineDisplayBackgroundHydrationMaxRows: this.syncTuning.machineDisplayBackgroundHydrationMaxRows,
            machineDisplayBackgroundHydrationApplyBatchSize: this.syncTuning.machineDisplayBackgroundHydrationApplyBatchSize,
            applyMachines: (machines, replace) => {
                if (!shouldContinue()) return;
                storage.getState().applyMachines(machines, replace, { sourceServerId });
            },
            replace: true,
        });
    }

    private fetchFriends = async () => {
        if (!this.credentials) return;
        const generation = this.serverScopeGeneration;
        const { shouldContinue } = createSyncGenerationGuard({
            capturedGeneration: generation,
            getCurrentGeneration: () => this.serverScopeGeneration,
        });
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
        const generation = this.serverScopeGeneration;
        const { shouldContinue } = createSyncGenerationGuard({
            capturedGeneration: generation,
            getCurrentGeneration: () => this.serverScopeGeneration,
        });
        await fetchTodosEngine({ credentials: this.credentials, shouldContinue });
    }

    private fetchAutomations = async () => {
        const generation = this.serverScopeGeneration;
        const { shouldContinue } = createSyncGenerationGuard({
            capturedGeneration: generation,
            getCurrentGeneration: () => this.serverScopeGeneration,
        });
        await fetchAndApplyAutomations({
            credentials: this.credentials,
            shouldContinue,
            applyAutomations: (automations) => storage.getState().applyAutomations(automations),
            loadedAutomationRunIds: Object.keys(storage.getState().automationRunsByAutomationId),
            setAutomationRuns: (automationId, runs) => storage.getState().setAutomationRuns(automationId, runs),
        });
    }

    private applyTodoSocketUpdates = async (changes: any[]) => {
        if (!this.credentials || !this.encryption) return;
        await applyTodoSocketUpdatesEngine({
            changes,
            encryption: this.encryption,
            invalidateTodosSync: () => this.todosSync.invalidate(),
        });
    }

    private fetchFeed = async () => {
        if (!this.credentials) return;
        const generation = this.serverScopeGeneration;
        const { shouldContinue } = createSyncGenerationGuard({
            capturedGeneration: generation,
            getCurrentGeneration: () => this.serverScopeGeneration,
        });
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
        const pendingSettings = { ...this.pendingSettings };
        const generation = this.serverScopeGeneration;
        const settingsSyncParams: SyncSettingsParams = {
            credentials: this.credentials,
            encryption: this.encryption,
            settingsScope,
            pendingSettings,
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
                this.pendingSettings = nextPendingSettings;
            },
            onLegacySessionOrganizationImported: ({ pinnedSessionIds }) => {
                this.handleLegacySessionOrganizationImported({
                    generation,
                    settingsScope,
                    pinnedSessionIds,
                });
            },
        };
        await syncSettingsEngine(settingsSyncParams);
    }

    private handleLegacySessionOrganizationImported(params: Readonly<{
        generation: number;
        settingsScope: AccountSettingsScope | null;
        pinnedSessionIds: readonly string[];
    }>): void {
        if (params.generation !== this.serverScopeGeneration) return;
        if (!params.settingsScope || !areAccountSettingsScopesEqual(this.pendingSettingsScope, params.settingsScope)) return;
        const pinnedSessionIds = Array.from(new Set(
            params.pinnedSessionIds
                .map((sessionId) => String(sessionId ?? '').trim())
                .filter(Boolean),
        ));
        if (pinnedSessionIds.length === 0) return;
        if (this.isBootstrapSyncRunning) {
            for (const sessionId of pinnedSessionIds) {
                this.legacySessionOrganizationImportedPinnedSessionIdsForBootstrap.add(sessionId);
            }
            return;
        }
        fireAndForget((async () => {
            await this.sessionsSync.awaitQueue({ timeoutMs: this.syncTuning.invalidateSyncAwaitTimeoutMs });
            if (params.generation !== this.serverScopeGeneration) return;
            if (!areAccountSettingsScopesEqual(this.pendingSettingsScope, params.settingsScope)) return;
            await this.fetchSessions({
                awaitSessionListHydration: true,
                requiredHydrationSessionIds: pinnedSessionIds,
                prioritizeSessionIds: pinnedSessionIds,
                hydrationTelemetrySource: 'legacyImportedPins',
            });
        })(), { tag: 'Sync.legacySessionOrganizationImportedPins.fetchSessions' });
    }

    private consumeBootstrapLegacyOrganizationImportedPinnedSessionIds(): string[] {
        const sessionIds = [...this.legacySessionOrganizationImportedPinnedSessionIdsForBootstrap];
        this.legacySessionOrganizationImportedPinnedSessionIdsForBootstrap.clear();
        return sessionIds;
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

    private fetchProfile = async () => {
        if (!this.credentials) return;
        const generation = this.serverScopeGeneration;
        const { shouldContinue } = createSyncGenerationGuard({
            capturedGeneration: generation,
            getCurrentGeneration: () => this.serverScopeGeneration,
        });
        const scope = this.pendingSettingsScope;
        await fetchAndApplyProfile({
            credentials: this.credentials,
            shouldContinue,
            applyProfile: (profile) => {
                if (scope) {
                    storage.getState().applyProfileForScope(scope, profile);
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
            // The released client version cannot change between two foregrounds of the same app
            // process, so this fired once per foreground for an answer that was already known.
            // Gated at the owner, like `refreshMachinesThrottled`, so every invalidation path — the
            // resume tail, bootstrap, and any future caller — inherits it; the stamp advances only
            // on a successful check so a failed one is retried at the next invalidation.
            if ((Date.now() - this.lastNativeUpdateCheckAt) < NATIVE_UPDATE_CHECK_STALE_MS) {
                return;
            }

            // Use the same canonical client identity as HTTP and Socket.IO session sync.
            const declaration = readCurrentUiClientCompatibilityDeclaration();
            const version = Constants.expoConfig?.version!;
            const appId = (Platform.OS === 'ios' ? Constants.expoConfig?.ios?.bundleIdentifier! : Constants.expoConfig?.android?.package!);
            const requestBody = ClientVersionCheckRequestV1Schema.parse({
                v: 1,
                clientKind: declaration.clientKind,
                appVersion: version,
                ...(declaration.releaseChannel ? { releaseChannel: declaration.releaseChannel } : {}),
                appId,
            });

            const response = await serverFetch('/v1/version', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
            }, { includeAuth: false });

            if (!response.ok) {
                log.log(`[fetchNativeUpdate] Request failed: ${response.status}`);
                return;
            }

            const parsed = ClientVersionCheckResponseV1Schema.safeParse(await response.json());
            if (!parsed.success) {
                throw new Error('Invalid /v1/version response');
            }
            const data = parsed.data;
            this.lastNativeUpdateCheckAt = Date.now();

            // Apply update status to storage
            if (data.status === 'upgrade-required') {
                applyUiClientUpgradeRequired(data);
            } else if (data.status === 'update-available') {
                storage.getState().applyNativeUpdateStatus({
                    available: true,
                    updateUrl: data.updateUrl,
                });
            } else {
                storage.getState().applyNativeUpdateStatus({
                    available: false
                });
            }
        } catch (error) {
            logNativeUpdateFetchFailure(error, log);
            storage.getState().applyNativeUpdateStatus(null);
        }
    }

    private syncPurchases = async () => {
        const generation = this.serverScopeGeneration;
        const { shouldContinue } = createSyncGenerationGuard({
            capturedGeneration: generation,
            getCurrentGeneration: () => this.serverScopeGeneration,
        });
        await syncPurchasesEngine({
            serverID: this.serverID,
            revenueCatInitialized: this.revenueCatInitialized,
            shouldContinue,
            setRevenueCatInitialized: (next) => {
                if (!shouldContinue()) return;
                this.revenueCatInitialized = next;
            },
            applyPurchases: (customerInfo) => storage.getState().applyPurchases(customerInfo),
        });
    }

    private applySessionThinkingFromTaskLifecycle = (
        sessionId: string,
        event: TaskLifecycleEvent,
    ) => {
        // Message catch-up pages can contain historical task_started markers.
        // We only use lifecycle catch-up to clear stale thinking state.
        if (event.type === 'task_started') {
            return;
        }

        if (isTerminalTaskLifecycleEventType(event.type)) {
            const createdAt = event.createdAt || nowServerMs();
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

        if (session.thinking === nextThinking) {
            return;
        }

        this.applySessions([
            {
                ...session,
                thinking: nextThinking,
                updatedAt: nowServerMs(),
            },
        ]);
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

    private fetchMessages = async (sessionId: string) => {
        if (this.hasFetchedSessionsSnapshotForActiveServer && !this.isSessionKnownOnResolvedOwnerServer(sessionId)) {
            // Do not fetch messages when we cannot resolve the session to either the active server
            // or a locally known owner server. This avoids cross-server message fetches. The owner
            // can be transiently unresolved while a deep-link session row is being applied; do not
            // publish that race as a successful empty transcript. Route hydration / the next
            // visibility invalidation replays this deferred fetch once ownership is known.
            this.deferredMessagesFetchSessionIds.add(sessionId);
            return;
        }

        if (this.hasUserOlderLoadInFlight(sessionId)) {
            // Defer-not-drop: background catch-up must not apply messages while a user-triggered
            // older-page load is in flight for this session (it would prepend uncoordinated content
            // under the transcript viewport). Returning is a safe success for InvalidateSync; the
            // deferral is replayed from loadOlderMessagesForChain once the in-flight load settles.
            this.deferredMessagesFetchSessionIds.add(sessionId);
            return;
        }

          const session = storage.getState().sessions[sessionId] ?? null;
          const directSessionLink = readDirectSessionLink(session?.metadata);
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

          if (directSessionLink) {
              if (!hasLoadedMessages) {
                  await this.fetchDirectSessionMessages(sessionId, directSessionLink);
                  return;
              }

              await this.catchUpDirectSessionMessages(sessionId, directSessionLink);
              this.explicitSessionTailProbeIds.delete(sessionId);
              return;
          }

          const loadedTranscript = storage.getState().sessionMessages[sessionId];
          const hasMaterializedMessages = Object.keys(loadedTranscript?.messagesById ?? {}).length > 0;
          // A previous interrupted open can leave a non-empty session hint with a loaded,
          // zero-row cache. Treat that as cold so catch-up does not preserve the blank projection.
          if (!hasLoadedMessages || (!hasMaterializedMessages && sessionSeqHint > 0)) {
              this.deferredForwardLoadingSessions.delete(sessionId);
              await fetchAndApplyMessages({
                  sessionId,
                  sessionEncryptionMode,
                  limit: Platform.OS === 'web'
                      ? WEB_INITIAL_SESSION_MESSAGES_PAGE_SIZE
                      : this.getSessionMessagesPageSize(),
                  getSessionEncryption: (id) => this.encryption.getSessionEncryption(id),
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
                // Gate catch-up on the REAL live-content-consumer signal (visible OR voice/SCM
                // consumer), read at decision time — the same fan-out realtime routing consumes.
                // Hardcoding `true` here ran destructive off-screen resets on every reconnect.
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
          const applyCatchUpDecision = () => applyMessageCatchUpDecision({
              decision,
              afterSeq,
              onIncrementalExhausted: isPinned ? 'tail_reset_latest_page' : 'defer_forward_loading',
              fetchNewerPage: async (cursor) => {
                  const result = await fetchAndApplyNewerMessages({
                      sessionId,
                      sessionEncryptionMode,
                      afterSeq: cursor,
                      // Deliberately the CONFIGURED page size on every platform, not the small
                      // web first-paint page. This loop is bounded by
                      // `messageMaxIncrementalPagesOnResume` (3), so the page size decides how
                      // large a background gap can be absorbed incrementally: 3 x 150 = 450
                      // messages, versus 3 x 12 = 36. Below that, a session that advanced while
                      // backgrounded falls to `onIncrementalExhausted` -> `tail_reset_latest_page`,
                      // which REPLACES transcript content instead of extending it.
                      limit: this.getSessionMessagesPageSize(),
                      getSessionEncryption: (id) => this.encryption.getSessionEncryption(id),
                      isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
                      request: requestMessages,
                      sessionReceivedMessages: this.sessionReceivedMessages,
                      applyMessages: (sid, messages) => this.applyMessages(sid, messages),
                      onNormalizedMessages: (messages) => ingestWorkspaceMutationMessages(sessionId, messages),
                      onTaskLifecycleEvent: (event) => this.applySessionThinkingFromTaskLifecycle(sessionId, event),
                      onMessagesPage: (page) => {
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
                      limit: this.getSessionMessagesPageSize(),
                      getSessionEncryption: (id) => this.encryption.getSessionEncryption(id),
                      isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
                      request: requestMessages,
                      sessionReceivedMessages: this.sessionReceivedMessages,
                      applyMessages: (sid, messages) => this.applyMessages(sid, messages),
                      onTaskLifecycleEvent: (event) => this.applySessionThinkingFromTaskLifecycle(sessionId, event),
                      markMessagesLoaded: (sid) => storage.getState().applyMessagesLoaded(sid),
                      onMessagesPage: (page) => {
                          this.updateSessionMessagesPaginationFromPage(sessionId, { scope: 'main' }, page, { allowHasMoreInference: true });
                          this.openSessionTailDiscontinuityFromSnapshotPage(sessionId, prefixMaxSeqBeforeSnapshot, page);
                      },
                      ...this.getMessageDecryptBatchOptions(),
                      log,
                  });
              },
              markLoaded: () => storage.getState().applyMessagesLoaded(sessionId),
              setDeferredForwardLoading: (deferred) => {
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
          if (hasExplicitTailProbe) {
              this.explicitSessionTailProbeIds.delete(sessionId);
          }
          if (isCatchUpWork) {
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

      private readTargetWindowTargetSeq(target: LoadTargetWindowMessagesTarget): number | null {
          const value = target.kind === 'seq' ? target.seq : target.seqHint;
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
          return Math.trunc(value);
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

      // Stable identity for absent sessions: consumers subscribe via useSyncExternalStore
      // and referential churn would loop; window transitions also do not always coincide
      // with message-store changes, so the canonical owner must notify its own listeners.
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
          this.directSessionOlderCursorBySessionId.delete(sessionId);
          this.directSessionHasMoreOlderBySessionId.delete(sessionId);
          this.clearDirectSessionTailCursor(sessionId);
      }

      private getDirectSessionServerScope(sessionId: string): string | undefined {
          return resolvePreferredServerIdForSessionId(sessionId);
      }

      private getDirectSessionTailCursor(sessionId: string): string | null {
          const inMemory = this.directSessionTailCursorBySessionId.get(sessionId);
          if (typeof inMemory === 'string' && inMemory.trim().length > 0) {
              return inMemory;
          }
          if (inMemory === null) return null;

          const persisted = loadDirectSessionTailCursor(sessionId, this.getDirectSessionCursorScope(sessionId));
          if (persisted) {
              this.directSessionTailCursorBySessionId.set(sessionId, persisted);
              return persisted;
          }
          return null;
      }

      private setDirectSessionTailCursor(sessionId: string, cursor: string | null): void {
          const normalized = typeof cursor === 'string' && cursor.trim().length > 0 ? cursor.trim() : null;
          this.directSessionTailCursorBySessionId.set(sessionId, normalized);
          saveDirectSessionTailCursor(sessionId, normalized, this.getDirectSessionCursorScope(sessionId));
      }

      private clearDirectSessionTailCursor(sessionId: string): void {
          this.directSessionTailCursorBySessionId.delete(sessionId);
          saveDirectSessionTailCursor(sessionId, null, this.getDirectSessionCursorScope(sessionId));
      }

      private createServerScopeGuard(): () => boolean {
          const generation = this.serverScopeGeneration;
          return () => this.serverScopeGeneration === generation;
      }

      private async fetchDirectSessionMessages(
          sessionId: string,
          directSessionLink: ReturnType<typeof readDirectSessionLink> extends infer T ? Exclude<T, null> : never,
      ): Promise<void> {
          const shouldContinue = this.createServerScopeGuard();
          const page = await machineDirectSessionTranscriptPage({
              machineId: directSessionLink.machineId,
              providerId: directSessionLink.providerId,
              remoteSessionId: directSessionLink.remoteSessionId,
              source: directSessionLink.source,
              direction: 'older',
          }, { serverId: this.getDirectSessionServerScope(sessionId) });
          if (!shouldContinue()) return;

          if (!page.ok) {
              throw new Error(page.error);
          }

          const normalizedMessages = normalizeDirectTranscriptMessages(page.items);
          if (normalizedMessages.length > 0) {
              this.applyMessages(sessionId, normalizedMessages, { notifyVoice: false });
          }

          this.directSessionOlderCursorBySessionId.set(sessionId, page.nextCursor ?? null);
          this.directSessionHasMoreOlderBySessionId.set(sessionId, page.hasMore === true);
          storage.getState().applyMessagesLoaded(sessionId);

          if (typeof page.tailCursor === 'string' && page.tailCursor.trim().length > 0) {
              this.setDirectSessionTailCursor(sessionId, page.tailCursor);
              return;
          }

          const tail = await machineDirectSessionTranscriptReadAfter({
              machineId: directSessionLink.machineId,
              providerId: directSessionLink.providerId,
              remoteSessionId: directSessionLink.remoteSessionId,
              source: directSessionLink.source,
              cursor: 'tail',
          }, { serverId: this.getDirectSessionServerScope(sessionId) });
          if (!shouldContinue()) return;

          if (!tail.ok) {
              throw new Error(tail.error);
          }

          this.setDirectSessionTailCursor(sessionId, tail.nextCursor ?? null);
      }

      /**
       * §13: bracket a unit of "catching up to newer activity" work with the UI-observable
       * per-session signal (ref-counted) so the transcript shows the "Catching up…" overlay for
       * its duration. The canonical bracket for newer-catch-up that has no other co-lifecycle:
       * the on-open incremental/snapshot catch-up (`fetchMessages`), the direct-session tail
       * catch-up, and reconnect invalidation all funnel through here. (`loadNewerMessages` brackets
       * the same signal inline because its begin/end share one lifecycle with its paging-key guard.)
       * Ref-counting makes overlapping brackets safe (e.g. an on-open catch-up overlapping a drain).
       */
      private async withSessionCatchUpNewer<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
          storage.getState().beginSessionCatchUpNewer(sessionId);
          try {
              return await work();
          } finally {
              storage.getState().endSessionCatchUpNewer(sessionId);
          }
      }

      /**
       * §13: the catch-up signal describes a DELIBERATE catch-up (resume, recovery), never the
       * steady-state tail poll. `useDirectSessionRuntime` re-invalidates this path on a
       * self-rescheduling timer — 250ms while the agent is running, 2s otherwise — so bracketing
       * the probe itself raised and lowered the UI-observable signal several times a second for
       * the life of an open direct session, against the overlay's own stated contract ("never
       * around normal streaming"). The sibling incremental path gates the same signal on
       * `isCatchUpWork`; `surfaceCatchUp` is its direct-session equivalent.
       */
      private async catchUpDirectSessionMessages(
          sessionId: string,
          directSessionLink: ReturnType<typeof readDirectSessionLink> extends infer T ? Exclude<T, null> : never,
          options?: Readonly<{ surfaceCatchUp?: boolean }>,
      ): Promise<void> {
          const probeAndApply = async (): Promise<void> => {
              const shouldContinue = this.createServerScopeGuard();
              const cursor = this.getDirectSessionTailCursor(sessionId) ?? 'tail';
              const tail = await machineDirectSessionTranscriptReadAfter({
                  machineId: directSessionLink.machineId,
                  providerId: directSessionLink.providerId,
                  remoteSessionId: directSessionLink.remoteSessionId,
                  source: directSessionLink.source,
                  cursor,
              }, { serverId: this.getDirectSessionServerScope(sessionId) });
              if (!shouldContinue()) return;

              if (!tail.ok) {
                  throw new Error(tail.error);
              }

              if (tail.truncated === true) {
                  // Real catch-up whatever triggered the probe: the transcript is dropped and
                  // refetched, which is exactly the window the overlay exists to cover. The
                  // bracket is ref-counted, so nesting inside `surfaceCatchUp` is safe.
                  await this.withSessionCatchUpNewer(sessionId, async () => {
                      this.resetSessionTranscriptState(sessionId);
                      await this.fetchDirectSessionMessages(sessionId, directSessionLink);
              });
              return;
              }

              const normalizedMessages = normalizeDirectTranscriptMessages(tail.items);
              if (normalizedMessages.length > 0) {
                  this.applyMessages(sessionId, normalizedMessages, { notifyVoice: false });
              }
              this.setDirectSessionTailCursor(sessionId, tail.nextCursor ?? null);
          };

          if (options?.surfaceCatchUp === true) {
              await this.withSessionCatchUpNewer(sessionId, probeAndApply);
              return;
          }
          await probeAndApply();
      }

      private collectLoadedDirectSessionsForResume(): Array<{ sessionId: string; directSessionLink: DirectSessionLink }> {
          const state = storage.getState();
          const loadedDirectSessions: Array<{ sessionId: string; directSessionLink: DirectSessionLink }> = [];
          for (const [sessionId, messages] of Object.entries(state.sessionMessages)) {
              if (messages?.isLoaded !== true) continue;
              const directSessionLink = readDirectSessionLink(state.sessions[sessionId]?.metadata);
              if (!directSessionLink) continue;
              loadedDirectSessions.push({ sessionId, directSessionLink });
          }
          return loadedDirectSessions;
      }

      private async catchUpLoadedDirectSessionsOnResume(): Promise<void> {
          const loadedDirectSessions = this.collectLoadedDirectSessionsForResume();
          if (loadedDirectSessions.length === 0) return;

          await runTasksWithLimit(
              loadedDirectSessions.map(({ sessionId, directSessionLink }) => async () => {
                  try {
                      // Resume IS the deliberate catch-up the overlay describes: the app was away
                      // and the transcript may be far behind, unlike the steady-state tail poll.
                      await this.catchUpDirectSessionMessages(sessionId, directSessionLink, { surfaceCatchUp: true });
                  } catch (error) {
                      syncReliabilityTelemetry.recordCritical('sync.directSession.resumeCatchUpFailed', {
                          sessionId,
                          message: error instanceof Error ? error.message : String(error),
                      });
                  }
              }),
              this.syncTuning.messageCatchUpConcurrencyLimit,
          );
      }

      private async applyDirectSessionTranscriptItems(
          sessionId: string,
          items: ReadonlyArray<DirectTranscriptRawMessageV1>,
          options?: Readonly<{
              nextCursor?: string | null;
          }>,
      ): Promise<void> {
          const session = storage.getState().sessions[sessionId] ?? null;
          if (!readDirectSessionLink(session?.metadata)) {
              return;
          }

          const normalizedMessages = normalizeDirectTranscriptMessages(items);
          if (normalizedMessages.length > 0) {
              const applied = this.applyMessages(sessionId, normalizedMessages, { notifyVoice: false, notifyActivity: true });
              if (!applied.hasReadyEvent) {
                  const sessionMessages = storage.getState().sessionMessages[sessionId];
                  const changedMessages = applied.changed
                      .map((messageId) => sessionMessages?.messagesMap[messageId] ?? null)
                      .filter((message): message is Message => Boolean(message) && message.kind === 'agent-text');
                  if (changedMessages.length > 0) {
                      notifyActivityReady(sessionId, changedMessages);
                  }
              }
          }

          if (Object.prototype.hasOwnProperty.call(options ?? {}, 'nextCursor')) {
              this.setDirectSessionTailCursor(sessionId, options?.nextCursor ?? null);
          }
      }

      private resolveDirectSessionTranscriptDeltaCursor(ephemeralUpdate: Readonly<{
          sessionId: string;
          fromCursor?: string | null;
          nextCursor?: string | null;
          tailCursor?: string | null;
      }>): string | null | undefined {
          const fromCursor = Object.prototype.hasOwnProperty.call(ephemeralUpdate, 'fromCursor')
              ? (
                  typeof ephemeralUpdate.fromCursor === 'string' && ephemeralUpdate.fromCursor.trim().length > 0
                      ? ephemeralUpdate.fromCursor
                      : null
              )
              : undefined;
          if (fromCursor === undefined) {
              return undefined;
          }
          if (fromCursor === null) {
              return undefined;
          }

          const currentCursor = this.getDirectSessionTailCursor(ephemeralUpdate.sessionId);
          if (currentCursor !== fromCursor) {
              return undefined;
          }

          if (typeof ephemeralUpdate.nextCursor === 'string' || ephemeralUpdate.nextCursor === null) {
              return ephemeralUpdate.nextCursor;
          }
          if (typeof ephemeralUpdate.tailCursor === 'string' || ephemeralUpdate.tailCursor === null) {
              return ephemeralUpdate.tailCursor;
          }
          return undefined;
      }

      private async handleDirectSessionTranscriptEphemeralUpdate(ephemeralUpdate: Readonly<{
          sessionId: string;
          items: ReadonlyArray<DirectTranscriptRawMessageV1>;
          fromCursor?: string | null;
          nextCursor?: string | null;
          tailCursor?: string | null;
          truncated?: boolean;
      }>): Promise<void> {
          const session = storage.getState().sessions[ephemeralUpdate.sessionId] ?? null;
          const directSessionLink = readDirectSessionLink(session?.metadata);
          if (!directSessionLink) {
              return;
          }

          if (ephemeralUpdate.truncated === true) {
              this.directSessionOlderCursorBySessionId.delete(ephemeralUpdate.sessionId);
              this.directSessionHasMoreOlderBySessionId.delete(ephemeralUpdate.sessionId);
              this.clearDirectSessionTailCursor(ephemeralUpdate.sessionId);
              await this.fetchDirectSessionMessages(ephemeralUpdate.sessionId, directSessionLink);
              return;
          }

          const resolvedCursor = this.resolveDirectSessionTranscriptDeltaCursor(ephemeralUpdate);
          await this.applyDirectSessionTranscriptItems(
              ephemeralUpdate.sessionId,
              ephemeralUpdate.items,
              resolvedCursor !== undefined ? { nextCursor: resolvedCursor } : undefined,
          );
      }

      private async loadOlderMessagesForChain(params: Readonly<{
          sessionId: string;
          scope: SessionMessagesScope;
          sidechainId?: string | null;
          beforeSeqOverride?: number;
          limit?: number;
      }>): Promise<{
          loaded: number;
          hasMore: boolean;
          status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
      }> {
          if (params.scope === 'main') {
              const session = storage.getState().sessions[params.sessionId] ?? null;
              const directSessionLink = readDirectSessionLink(session?.metadata);
              if (directSessionLink) {
                  const loadingKey = `${params.sessionId}:direct`;
                  if (this.sessionMessagesLoadingOlderByKey.has(loadingKey)) {
                      return {
                          loaded: 0,
                          hasMore: this.directSessionHasMoreOlderBySessionId.get(params.sessionId) ?? true,
                          status: 'in_flight',
                      };
                  }

                  const knownHasMore = this.directSessionHasMoreOlderBySessionId.get(params.sessionId);
                  if (knownHasMore === false) {
                      return { loaded: 0, hasMore: false, status: 'no_more' };
                  }

                  const cursor = this.directSessionOlderCursorBySessionId.get(params.sessionId) ?? null;
                  if (!cursor) {
                      return { loaded: 0, hasMore: knownHasMore ?? false, status: 'not_ready' };
                  }

                  this.sessionMessagesLoadingOlderByKey.add(loadingKey);
                  try {
                      const shouldContinue = this.createServerScopeGuard();
                      const requestedLimit =
                          typeof params.limit === 'number' && Number.isFinite(params.limit)
                              ? this.getSessionMessagesPageSize({ limit: params.limit })
                              : null;
                      const page = await machineDirectSessionTranscriptPage({
                          machineId: directSessionLink.machineId,
                          providerId: directSessionLink.providerId,
                          remoteSessionId: directSessionLink.remoteSessionId,
                          source: directSessionLink.source,
                          direction: 'older',
                          cursor,
                          ...(requestedLimit !== null ? { maxItems: requestedLimit } : {}),
                      }, { serverId: this.getDirectSessionServerScope(params.sessionId) });
                      if (!shouldContinue()) {
                          return { loaded: 0, hasMore: knownHasMore ?? true, status: 'not_ready' };
                      }

                      if (!page.ok) {
                          throw new Error(page.error);
                      }

                      if (page.truncated === true) {
                          this.resetSessionTranscriptState(params.sessionId);
                          await this.fetchDirectSessionMessages(params.sessionId, directSessionLink);
                          return {
                              loaded: 0,
                              hasMore:
                                  this.directSessionHasMoreOlderBySessionId.get(params.sessionId)
                                  ?? knownHasMore
                                  ?? true,
                              status: 'not_ready',
                          };
                      }

                      const normalizedMessages = normalizeDirectTranscriptMessages(page.items);
                      if (normalizedMessages.length > 0) {
                          this.applyMessages(params.sessionId, normalizedMessages, { notifyVoice: false });
                      }

                      this.directSessionOlderCursorBySessionId.set(params.sessionId, page.nextCursor ?? null);
                      this.directSessionHasMoreOlderBySessionId.set(params.sessionId, page.hasMore === true);

                      return {
                          loaded: normalizedMessages.length,
                          hasMore: page.hasMore === true,
                          status: page.hasMore === true ? 'loaded' : 'no_more',
                      };
                  } catch (error) {
                      console.error('Failed to load older direct session messages:', error);
                      return { loaded: 0, hasMore: knownHasMore ?? true, status: 'loaded' };
                  } finally {
                      this.sessionMessagesLoadingOlderByKey.delete(loadingKey);
                      this.replayDeferredMessagesFetch(params.sessionId);
                  }
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
                  limit: this.getSessionMessagesPageSize({ limit: params.limit }),
                  scope: params.scope,
                  sidechainId: params.sidechainId ?? null,
                  getSessionEncryption: (id) => this.encryption.getSessionEncryption(id),
                  isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
                  request: requestMessages,
                  sessionReceivedMessages: this.sessionReceivedMessages,
                  applyMessages: (sid, messages) => this.applyMessages(sid, messages, { notifyVoice: false }),
                  ...this.getMessageDecryptBatchOptions(),
                  log,
              });

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
              return { loaded: 0, hasMore: knownHasMore ?? true, status: 'loaded' };
          } finally {
              this.sessionMessagesLoadingOlderByKey.delete(pagingKey);
              this.replayDeferredMessagesFetch(params.sessionId);
          }
      }

      public async loadOlderMessages(sessionId: string, options?: LoadOlderMessagesOptions): Promise<{
          loaded: number;
          hasMore: boolean;
          status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
      }> {
          return this.loadOlderMessagesForChain({ sessionId, scope: 'main', limit: options?.limit });
      }

      public async loadOlderMessagesFromCursor(sessionId: string, beforeSeq: number, options?: LoadOlderMessagesOptions): Promise<{
          loaded: number;
          hasMore: boolean;
          status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
      }> {
          return this.loadOlderMessagesForChain({ sessionId, scope: 'main', beforeSeqOverride: beforeSeq, limit: options?.limit });
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
          if (readDirectSessionLink(session?.metadata)) {
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
                  limit: this.getSessionMessagesPageSize({ limit: options?.limit }),
                  scope: 'main',
                  sessionEncryptionMode,
                  getSessionEncryption: (id) => this.encryption.getSessionEncryption(id),
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

      public async fetchUserMessageHistoryPage(
          sessionId: string,
          options?: Readonly<{ beforeSeq?: number | null; limit?: number; turnProjection?: boolean }>,
      ): Promise<FetchUserMessageHistoryPageResult> {
          const normalizedSessionId = String(sessionId ?? '').trim();
          if (!normalizedSessionId) return { status: 'not_ready' };

          const session = storage.getState().sessions[normalizedSessionId] ?? null;
          const sessionEncryptionMode = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
          return fetchUserMessageHistoryPage({
              sessionId: normalizedSessionId,
              sessionEncryptionMode,
              beforeSeq: options?.beforeSeq ?? null,
              limit: options?.limit ?? USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE,
              ...(options?.turnProjection === true ? { turnProjection: true } : {}),
              request: this.createSessionMessagesRequest(normalizedSessionId),
              getSessionEncryption: (id) => this.encryption.getSessionEncryption(id),
          });
      }

      public async ensureSidechainMessagesLoaded(sessionId: string, sidechainId: string): Promise<'loaded' | 'not_ready' | 'in_flight'> {
          const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
          const normalizedSidechainId = typeof sidechainId === 'string' ? sidechainId.trim() : '';
          if (!normalizedSessionId || !normalizedSidechainId) return 'not_ready';

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
                  // The same configured page size the main initial fetch uses: this is the
                  // sidechain's initial transcript load, so it must not silently keep the
                  // server default when an account configures a different page size.
                  limit: this.getSessionMessagesPageSize(),
                  getSessionEncryption: (id) => this.encryption.getSessionEncryption(id),
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

      public async loadOlderSidechainMessages(sessionId: string, sidechainId: string): Promise<{
          loaded: number;
          hasMore: boolean;
          status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
      }> {
          const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
          const normalizedSidechainId = typeof sidechainId === 'string' ? sidechainId.trim() : '';
          if (!normalizedSessionId || !normalizedSidechainId) {
              return { loaded: 0, hasMore: true, status: 'not_ready' };
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

        public async loadOlderMessagesForkAware(childSessionId: string, options?: LoadOlderMessagesOptions): Promise<{
            loaded: number;
            hasMore: boolean;
            status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
        }> {
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
            const attemptedSessionIds = new Set<string>();
            while (true) {
                const fork = getForkedTranscriptSnapshotCached(storage.getState() as any, childSessionId);
                if (!fork) return;

                let nextSegment: (typeof fork.segments)[number] | null = null;
                // Segments are ordered root -> child. Load the nearest missing ancestor first,
                // then rebuild the snapshot and eligibility after that request settles. A
                // nearer page can exhaust its segment and make the next ancestor eligible in
                // this same prefetch call.
                for (let index = fork.segments.length - 1; index >= 0; index -= 1) {
                    const seg = fork.segments[index];
                    if (
                        !seg ||
                        attemptedSessionIds.has(seg.sessionId) ||
                        seg.isReadOnlyContext !== true ||
                        typeof seg.cutoffSeqInclusive !== 'number' ||
                        !Number.isFinite(seg.cutoffSeqInclusive) ||
                        seg.cutoffSeqInclusive < 0 ||
                        (seg.messageIdsOldestFirst?.length ?? 0) > 0
                    ) {
                        continue;
                    }

                    let allCloserSegmentsExhausted = true;
                    for (let closerIndex = index + 1; closerIndex < fork.segments.length; closerIndex += 1) {
                        const closerSegment = fork.segments[closerIndex];
                        if (!closerSegment) continue;
                        const key = this.buildSessionMessagesPaginationKey({
                            sessionId: closerSegment.sessionId,
                            scope: 'main',
                        });
                        if (this.sessionMessagesHasMoreOlderByKey.get(key) !== false) {
                            allCloserSegmentsExhausted = false;
                            break;
                        }
                    }
                    if (allCloserSegmentsExhausted) {
                        nextSegment = seg;
                        break;
                    }
                }
                if (!nextSegment) return;

                attemptedSessionIds.add(nextSegment.sessionId);
                const seg = nextSegment;
                const hydration = await this.ensureSessionVisibleForMessageRoute(seg.sessionId);
                if (hydration.kind !== 'available') return;

                const cutoff = Math.max(0, Math.trunc(seg.cutoffSeqInclusive as number));
                const result = await this.loadOlderMessagesFromCursor(seg.sessionId, cutoff + 1).catch(() => null);
                if (!result || result.status === 'not_ready' || result.status === 'in_flight') return;
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
          // Live-tail intent beats any stale persisted anchor across restarts
          // (mirrors messageCatchUpPolicy precedence): absence of a persisted
          // record IS the durable live-tail default.
          this.persistedSessionViewportIds.delete(sessionId);
          // This delete is intentionally unconditional. Another tab can write
          // the same session after this instance hydrated, so the in-memory ID
          // set is only a cache and cannot authorize skipping durable live-tail.
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
          // N2b.5: passive observation emits carry no anchor field — merge by
          // preserving the stored identity anchor and updating only the offset
          // metadata. Only an explicit capture outcome (anchor object or null)
          // or live-tail intent (above) may replace/clear the identity.
          const prevViewport = this.sessionViewport.get(sessionId);
          const anchor = state.anchor === undefined
              ? prevViewport?.anchor ?? null
              : sanitizeSessionViewportAnchor(state.anchor);
          // Position-unknown detach emits (offsetY omitted or non-finite) flip the pin
          // state only; the previously observed offset metadata remains authoritative.
          // Without a prior observation the live-tail geometry (0) is the default —
          // a detach that never measured a position must not invent one.
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

      /**
       * Hydrates persisted per-session viewport anchors (N2b.1) into the
       * in-memory map once per active server-account scope. The map stays the
       * hot path; persistence is write-through on capture and delete-through
       * on live-tail intent.
       */
      private ensureSessionViewportHydrated(): void {
          const scope = getActiveServerAccountScope();
          const storageKey = sessionViewportStorageKey(scope);
          if (this.sessionViewportHydratedStorageKey === storageKey) return;
          this.sessionViewportHydratedStorageKey = storageKey;
          const persisted = loadPersistedSessionViewports(scope);
          this.persistedSessionViewportIds = new Set(Object.keys(persisted));
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
              // Identity-first: the persistence layer drops identity-less
              // anchors, keeping offsetY as degraded fallback metadata only.
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
          this.persistedSessionViewportIds.add(sessionId);
      }

      /**
       * Rendered transcript message ids are runtime-local (reducer-allocated),
       * so the durable anchor identity is the server message id (`realID`)
       * plus the transcript `seq`. Accepts either a rendered id or a server id.
       */
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
          // §13: bracket inline (mirrors `withSessionCatchUpNewer`) — the catch-up signal shares
          // this method's exact begin/finally lifecycle with the paging-key in-flight guard.
          storage.getState().beginSessionCatchUpNewer(sessionId);
          const requestMessages = this.createSessionMessagesRequest(sessionId);
          const session = storage.getState().sessions[sessionId] ?? null;
          const sessionEncryptionMode = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
          try {
              const result = await fetchAndApplyNewerMessages({
                  sessionId,
                  sessionEncryptionMode,
                  afterSeq,
                  limit: this.getSessionMessagesPageSize(),
                  getSessionEncryption: (id) => this.encryption.getSessionEncryption(id),
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

      /**
       * C6/D2a: re-materialize the stale (edited-while-hidden) region and merge it in place.
       *
       * Fetches newer messages from just below the lowest stale seq so the edited rows are
       * re-pulled and upserted by applyMessages without dropping any other materialized row.
       * Falls back to a coalesced catch-up invalidate when the stale seq is unknown (the
       * catch-up policy then fetches-and-merges; it is non-destructive after D2b).
       */
      private async fetchStaleTranscriptRegion(
          sessionId: string,
          staleSnapshot: Readonly<{ minSeq: number | null; messageIds: readonly string[] }>,
      ): Promise<ReadonlySet<string>> {
          const staleMinSeq = staleSnapshot.minSeq;
          if (typeof staleMinSeq !== 'number' || !Number.isFinite(staleMinSeq) || staleMinSeq <= 0) {
              this.getOrCreateMessagesSync(sessionId).invalidateCoalesced();
              return new Set();
          }
          if (this.hasFetchedSessionsSnapshotForActiveServer && !this.isSessionKnownOnResolvedOwnerServer(sessionId)) {
              return new Set();
          }
          let afterSeq = Math.max(0, Math.trunc(staleMinSeq) - 1);
          const requestMessages = this.createSessionMessagesRequest(sessionId);
          const session = storage.getState().sessions[sessionId] ?? null;
          const sessionEncryptionMode = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
          const unresolvedMessageIds = new Set(staleSnapshot.messageIds);
          const resolvedMessageIds = new Set<string>();
          try {
              while (unresolvedMessageIds.size > 0) {
                  const result = await fetchAndApplyNewerMessages({
                      sessionId,
                      sessionEncryptionMode,
                      afterSeq,
                      limit: this.getSessionMessagesPageSize(),
                      getSessionEncryption: (id) => this.encryption.getSessionEncryption(id),
                      isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
                      request: requestMessages,
                      sessionReceivedMessages: this.sessionReceivedMessages,
                      applyMessages: (sid, messages) => this.applyMessages(sid, messages, { notifyVoice: false }),
                      onNormalizedMessages: (messages) => {
                          ingestWorkspaceMutationMessages(sessionId, messages);
                          for (const message of messages) {
                              if (!unresolvedMessageIds.delete(message.id)) continue;
                              resolvedMessageIds.add(message.id);
                          }
                      },
                      onTaskLifecycleEvent: (event) => this.applySessionThinkingFromTaskLifecycle(sessionId, event),
                      onMessagesPage: (page) => {
                          this.updateSessionMessagesPaginationFromPage(sessionId, { scope: 'main' }, page, { allowHasMoreInference: true, direction: 'newer' });
                      },
                      ...this.getMessageDecryptBatchOptions(),
                      log,
                  });
                  const nextAfterSeq = result.page.nextAfterSeq;
                  if (!nextAfterSeq || result.page.messages.length === 0) break;
                  afterSeq = nextAfterSeq;
              }
          } catch (error) {
              console.error('Failed to refetch stale transcript region:', error);
          }
          return resolvedMessageIds;
      }

      private async repairDeferredStaleTranscriptRegion(
          sessionId: string,
          staleSnapshot: Readonly<{ minSeq: number | null; messageIds: readonly string[] }>,
      ): Promise<void> {
          const resolvedMessageIds = await this.fetchStaleTranscriptRegion(sessionId, staleSnapshot);
          if (!staleSnapshot.messageIds.every((messageId) => resolvedMessageIds.has(messageId))) return;
          this.deferredTranscriptState = acknowledgeStaleTranscriptRepair(
              this.deferredTranscriptState,
              sessionId,
              { messageIds: staleSnapshot.messageIds, minSeq: staleSnapshot.minSeq },
          );
      }

      private async repairSessionTranscriptRevision(
          repair: Readonly<{ sessionId: string; minSeq: number; messageIds: readonly string[] }>,
      ): Promise<void> {
          const resolvedMessageIds = await this.fetchStaleTranscriptRegion(repair.sessionId, {
              minSeq: repair.minSeq,
              messageIds: repair.messageIds,
          });
          if (!repair.messageIds.every((messageId) => resolvedMessageIds.has(messageId))) {
              throw new Error('Durable transcript revision could not be materialized');
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
              fireAndForget(this.resumeSync('socket-reconnect'), { tag: 'Sync.resumeSync.socket-reconnect' });
          });
      }

      /**
       * Eviction eligibility guard: sessions that must NEVER lose their transcript —
       * any mounted transcript surface (SessionView anywhere in the nav stack, detail
       * routes) plus every live full-content consumer (visible / voice / SCM / explicit)
       * per the canonical resolveSessionLiveConsumption fan-out.
       */
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
       * clearSessionTranscriptDerivedCachesForSession) and resets sync-side per-session
       * transcript state, so re-opening runs the first-open page-limited load pipeline.
       */
      private evictSessionTranscript(sessionId: string): void {
          storage.getState().evictSessionMessages(sessionId);
          this.resetSessionTranscriptState(sessionId);
          syncPerformanceTelemetry.count('sync.sessions.transcript.evicted', { evicted: 1 });
      }

      private resetSessionTranscriptState(sessionId: string): void {
          storage.getState().resetSessionMessages(sessionId);

          this.sessionReceivedMessages.delete(sessionId);
          this.deleteSessionMessagesPaginationStateForSession(sessionId);
          this.deferredForwardLoadingSessions.delete(sessionId);
          this.explicitSessionTailProbeIds.delete(sessionId);
          this.deferredTranscriptState = clearDeferredTranscriptStateForSession(this.deferredTranscriptState, sessionId);
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
        const shouldContinue = this.createServerScopeGuard();
        if (debounceMs <= 0) {
            if (!this.isForeground) {
                if (!shouldContinue()) return;
                this.flushBackgroundSyncCheckpointsNow();
            }
            return;
        }
        this.nativeInactiveCheckpointTimer = setTimeout(() => {
            this.nativeInactiveCheckpointTimer = null;
            if (!this.isForeground) {
                if (!shouldContinue()) return;
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
                            // The in-memory map is the owner this scope's storage record was
                            // just flushed from, so re-reading and re-parsing the whole record
                            // per changes page would only reconstruct what we already hold —
                            // and would be the one reader of this fact that can go stale.
                            loadSessionMaterializedMaxSeqById: () => this.sessionMaterializedMaxSeqById,
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
                onUnsupportedChanges: (unsupportedChanges) => {
                    for (const unsupportedChange of unsupportedChanges) {
                        syncReliabilityTelemetry.recordCritical('sync.changes.unsupportedKind', {
                            cursor: unsupportedChange.cursor,
                            kind: unsupportedChange.kind,
                            entityId: unsupportedChange.entityId,
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
                },
                applyPlanned: async (planned) => {
                    return await applyPlannedChangeActions({
                        planned,
                        credentials: this.credentials,
                        isSessionMessagesLoaded: (sessionId) => storage.getState().sessionMessages[sessionId]?.isLoaded === true,
                        getSessionMaterializedMaxSeq: (sessionId) => this.sessionMaterializedMaxSeqById[sessionId] ?? 0,
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
                            pets: () => fetchAndApplyAccountPets({
                                credentials: this.credentials,
                                readScope: () => storage.getState().petsScope,
                                applyAccountPets: (pets) => storage.getState().applyAccountPets(pets),
                                applyAccountPetsForScope: (scope, pets) =>
                                    storage.getState().applyAccountPetsForScope(scope, pets),
                            }),
                            sessions: async ({ requiredHydrationSessionIds, prioritizeSessionIds }) => {
                                await this.fetchSessions({
                                    awaitSessionListHydration: true,
                                    requiredHydrationSessionIds,
                                    prioritizeSessionIds,
                                    hydrationTelemetrySource: 'changesCatchUp',
                                });
                                refreshedByCatchUp.sessions = true;
                            },
                            todos: () => this.todosSync.invalidateAndAwait(),
                        },
                        invalidateMessagesForSession: async (sessionId) => {
                            await this.withSessionCatchUpNewer(sessionId, () =>
                                this.getOrCreateMessagesSync(sessionId).invalidateAndAwait());
                        },
                        repairSessionTranscriptRevision: (repair) => this.repairSessionTranscriptRevision(repair),
                        invalidateScmStatusForSession: (sessionId) => scmStatusSync.invalidate(sessionId),
                        applyTodoSocketUpdates: (changes) => this.applyTodoSocketUpdates(changes),
                        kvBulkGet,
                        refreshSessionFolderAssignments: async (plan) => {
                            const serverId = String(getActiveServerSnapshot().serverId ?? '').trim();
                            if (!serverId) {
                                throw new Error('Cannot refresh session folder assignments without an active server');
                            }
                            const sessionIds = plan.mode === 'sessions'
                                ? plan.sessionIds
                                : Object.values(storage.getState().sessions)
                                    .filter((session) => !session.serverId || areServerProfileIdentifiersEquivalent(session.serverId, serverId))
                                    .map((session) => session.id);
                            await fetchAndApplySessionFolderAssignments({
                                credentials: this.credentials,
                                serverId,
                                sessionIds,
                            });
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
                  return finish('fallback');
              }
              this.changesCursor = checkpoint.cursor;
              this.safeCursorLagState = null;
          }

          return finish('ok');
      }

    private hydrateSessionShellByIdFromSocket(
        sessionId: string,
        reason: string,
        sourceServerId: string | null,
        shouldContinue: () => boolean,
    ): void {
        const normalized = String(sessionId ?? '').trim();
        if (!normalized) return;
        const credentials = this.credentials;
        if (!credentials) {
            this.sessionsSync.invalidate();
            return;
        }
        const scopedServerId = sourceServerId ?? resolvePreferredServerIdForSessionId(normalized);
        const stagedSessionDataKeys = new Map(this.sessionDataKeys);
        const stagedSessionDataKeyEnvelopes = new Map(this.sessionDataKeyEnvelopes);
        fireAndForget((async () => {
            const result = await fetchSessionByIdWithServerScope({
                sessionId: normalized,
                serverId: scopedServerId,
                activeCredentials: credentials,
                activeEncryption: this.encryption,
                sessionDataKeys: stagedSessionDataKeys,
                sessionDataKeyEnvelopes: stagedSessionDataKeyEnvelopes,
                activeRequest: (path, init) => apiSocket.request(path, init),
                getExistingSession: (targetSessionId) => storage.getState().sessions[targetSessionId] ?? null,
                applySessions: (sessions) => {
                    if (!shouldContinue()) return;
                    this.applySessions(sessions);
                },
                log,
                includeTurnsProjection: reason === 'socket-update-turn-projection',
            });
            if (!shouldContinue()) return;
            if (!result.ok) {
                log.log(`[Sync.socketHydrateSession] ${reason} failed for ${normalized}: ${result.errorCode ?? 'unknown'}`);
                this.sessionsSync.invalidate();
                return;
            }
            this.commitSessionDataKeyCacheEntry(
                normalized,
                stagedSessionDataKeys,
                stagedSessionDataKeyEnvelopes,
            );
            const hydratedServerId = String(result.session?.serverId ?? '').trim();
            const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
            if (!hydratedServerId || areServerProfileIdentifiersEquivalent(hydratedServerId, activeServerId)) {
                this.activeServerSessionIds.add(normalized);
            }
        })(), {
            tag: `Sync.socketHydrateSession.${reason}`,
            logToConsole: false,
            onError: (error) => {
                const message = error instanceof Error ? error.message : String(error);
                log.log(`[Sync.socketHydrateSession] ${reason} failed for ${normalized}: ${message}`);
                this.sessionsSync.invalidate();
            },
        });
    }

    private handleUpdate = async (update: unknown) => {
          const sourceServerId = String(getActiveServerSnapshot().serverId ?? '').trim() || null;
          const { shouldContinue } = createSyncGenerationGuard({
              getCurrentGeneration: () => this.serverScopeGeneration,
              capturedGeneration: this.serverScopeGeneration,
          });
          await handleSocketUpdate({
              update,
              encryption: this.encryption,
              settingsScope: this.pendingSettingsScope,
              getPendingSettings: () => this.pendingSettings,
              sourceServerId,
              shouldContinue,
              artifactDataKeys: this.artifactDataKeys,
              applySessions: (sessions) => this.applySessions(sessions),
              fetchSessions: () => {
                  fireAndForget(this.fetchSessions(), {
                      tag: 'Sync.handleUpdate.fetchSessions',
                      logToConsole: false,
                      onError: (error) => {
                          const message = error instanceof Error ? error.message : String(error);
                          log.log(`[Sync.handleUpdate.fetchSessions] background refresh failed: ${message}`);
                      },
                  });
              },
              hydrateSessionById: (sessionId, reason) => {
                  this.hydrateSessionShellByIdFromSocket(sessionId, reason, sourceServerId, shouldContinue);
              },
              applyMessages: (sessionId, messages) => this.applyMessages(sessionId, messages),
                onSessionVisible: (sessionId) => this.onSessionVisible(sessionId),
                isSessionMessagesLoaded: (sessionId) => storage.getState().sessionMessages[sessionId]?.isLoaded === true,
                getSessionMaterializedMaxSeq: (sessionId) => this.sessionMaterializedMaxSeqById[sessionId] ?? 0,
              markSessionMaterializedMaxSeq: (sessionId, seq) => this.markSessionMaterializedMaxSeq(sessionId, seq),
              onMessageGapDetected: (sessionId, _info) => {
                  this.getOrCreateMessagesSync(sessionId).invalidateCoalesced();
              },
              markSessionKnownRemoteSeq: (sessionId, seq) => this.markSessionKnownRemoteSeq(sessionId, seq),
              markSessionTranscriptDeferred: (sessionId, marker) => this.markSessionTranscriptDeferred(sessionId, marker),
              markSessionTranscriptStale: (sessionId, marker) => this.markSessionTranscriptStale(sessionId, marker),
              markSessionStateHydrationDeferred: (sessionId) => this.markSessionStateHydrationDeferred(sessionId),
              onReadyProjectionAdvance: (sessionId, seq) => this.notifyReadyProjectionAdvance(sessionId, seq),
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

    private flushActivityUpdates = (updates: Map<string, ApiEphemeralActivityUpdate>, options?: ActivityUpdateAccumulatorFlushOptions) => {
        flushActivityUpdatesEngine({
            updates,
            sourceServerId: options?.sourceServerId,
            applySessions: (sessions) => this.applySessions(sessions),
        });
    }

    private flushMachineActivityUpdates = (updates: Map<string, MachineActivityUpdate>, options?: { sourceServerId?: string | null }) => {
        flushMachineActivityUpdatesEngine({
            updates,
            sourceServerId: options?.sourceServerId,
            applyMachines: (machines, applyOptions) => storage.getState().applyMachines(machines, false, applyOptions),
        });
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
        const { shouldContinue } = createSyncGenerationGuard({
            getCurrentGeneration: () => this.serverScopeGeneration,
            capturedGeneration: this.serverScopeGeneration,
        });
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
            updateDirectSessionTranscript: (ephemeralUpdate) => this.handleDirectSessionTranscriptEphemeralUpdate(ephemeralUpdate),
            applyActionOperationRevision: (ephemeralUpdate) => {
                if (!this.encryption || !shouldContinue()) return;
                const snapshot = openActionOperationRevisionEphemeral({
                    update: ephemeralUpdate,
                    machineKey: this.encryption.getContentPrivateKey(),
                });
                if (!snapshot || !shouldContinue()) return;
                actionOperationStore.merge(snapshot);
            },
        }), { tag: 'Sync.handleEphemeralUpdate' });
    }

    //
    // Apply store
    //

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

    private shouldNotifyReadyProjectionSeq(sessionId: string, seq: number | null): boolean {
        if (seq === null) return true;
        if (!Number.isFinite(seq)) return true;
        const normalizedSeq = Math.trunc(seq);
        const previous = this.readyNotificationProgressBySessionId[sessionId];
        if (previous && previous.seq >= normalizedSeq) return false;
        this.readyNotificationProgressBySessionId = {
            ...this.readyNotificationProgressBySessionId,
            [sessionId]: {
                seq: normalizedSeq,
                transcriptNotified: false,
            },
        };
        return true;
    }

    private shouldNotifyReadyFromMessages(sessionId: string, seq: number | null): boolean {
        if (seq === null) return true;
        if (!Number.isFinite(seq)) return true;
        const normalizedSeq = Math.trunc(seq);
        const previous = this.readyNotificationProgressBySessionId[sessionId];
        if (!previous || previous.seq < normalizedSeq) {
            this.readyNotificationProgressBySessionId = {
                ...this.readyNotificationProgressBySessionId,
                [sessionId]: {
                    seq: normalizedSeq,
                    transcriptNotified: true,
                },
            };
            return true;
        }
        if (previous.seq === normalizedSeq && previous.transcriptNotified === false) {
            this.readyNotificationProgressBySessionId = {
                ...this.readyNotificationProgressBySessionId,
                [sessionId]: {
                    seq: normalizedSeq,
                    transcriptNotified: true,
                },
            };
            return true;
        }
        return false;
    }

    private notifyReadyProjectionAdvance(sessionId: string, seq: number): void {
        if (!this.shouldNotifyReadyProjectionSeq(sessionId, seq)) return;
        voiceHooks.onReady(sessionId, []);
    }

    private applyMessages = (
        sessionId: string,
        messages: NormalizedMessage[],
        options?: { notifyVoice?: boolean; notifyActivity?: boolean }
    ) => {
        const result = storage.getState().applyMessages(sessionId, messages);
        const notifyVoice = options?.notifyVoice !== false;
        const notifyActivity = options?.notifyActivity ?? notifyVoice;
        if (notifyVoice || notifyActivity) {
            let m: Message[] = [];
            for (let messageId of result.changed) {
                const message = storage.getState().sessionMessages[sessionId].messagesMap[messageId];
                if (message) {
                    m.push(message);
                }
            }
            const liveEffectMessages = m.filter((message) => (
                !isRecoveredHistoryTranscriptObservationProvenance(message.transcriptObservationProvenance)
            ));
            if (notifyVoice && liveEffectMessages.length > 0) {
                voiceHooks.onMessages(sessionId, liveEffectMessages);
            }
            if (result.hasReadyEvent && this.shouldNotifyReadyFromMessages(sessionId, result.latestReadyEventSeq)) {
                if (notifyVoice) {
                    voiceHooks.onReady(sessionId, liveEffectMessages);
                }
                if (notifyActivity) {
                    notifyActivityReady(sessionId, liveEffectMessages);
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
            pageSize: this.getSessionMessagesPageSize(),
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
        storage.getState().setSessionTailContiguousFloorSeq(
            sessionId,
            record ? record.walkCursor : null,
        );
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

        // When multi-server mode is enabled, we use `activeServerSessionIds` as a conservative
        // guard to avoid cross-server message fetches after the initial session snapshot. Ensure
        // that any newly-applied sessions (via socket updates, create flows, etc.) are treated as
        // "known" on the active server too, otherwise message fetches can be incorrectly skipped.
        for (const session of sessions) {
            if (session?.id) {
                this.activeServerSessionIds.add(session.id);
            }
        }
        storage.getState().applySessions(sessions);
        const newActive = storage.getState().getActiveSessions();
        this.applySessionDiff(active, newActive);
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
    const encryption = await createEncryptionFromAuthCredentials(credentials);

    // Initialize tracking
    initializeTracking(encryption.anonID);

    // Initialize socket connection
    apiSocket.initialize({ endpoint: getActiveServerSnapshot().serverUrl, token: credentials.token }, encryption);

    // Wire socket status to storage
    apiSocket.onStatusChange((status) => {
        storage.getState().setSocketStatus(status);
    });
    apiSocket.onError((error) => {
        if (!error) {
            storage.getState().setSocketError(null);
            return;
        }
        const msg = error.message || 'Connection error';
        storage.getState().setSocketError(msg);

        // Prefer explicit status if provided by the socket error (depends on server implementation).
        const status = (error as any)?.data?.status;
        const statusNum = typeof status === 'number' ? status : null;
        const kind: 'auth' | 'config' | 'network' | 'server' | 'unknown' =
            statusNum === 401 || statusNum === 403 ? 'auth' : 'unknown';
        const retryable = kind !== 'auth';

        storage.getState().setSyncError({ message: msg, retryable, kind, at: Date.now() });
    });

    // Initialize sessions engine
    if (restore) {
        await sync.restore(credentials, encryption);
    } else {
        await sync.create(credentials, encryption);
    }
}

import Constants from 'expo-constants';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { resumeSession } from '@/sync/ops';
import { type AuthCredentials } from '@/auth/storage/tokenStorage';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
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
import { applyInitialAppStateConnectivityGate } from '@/sync/runtime/connectivity/appStateConnectivityGate';
import { loadSyncTuning, type SyncTuning } from '@/sync/runtime/syncTuning';
import {
    computeSessionMessagesPaginationUpdateFromPage,
    type SessionMessagesPaginationState,
} from '@/sync/runtime/sessionMessagesPagination';
import { ActivityUpdateAccumulator } from './reducer/activityUpdateAccumulator';
import { MachineActivityAccumulator, type MachineActivityUpdate } from './reducer/machineActivityAccumulator';
import { randomUUID } from '@/platform/randomUUID';
import { Platform, AppState } from 'react-native';
import type { ManagedEndpointSupervisor, ManagedEndpointSupervisorState } from '@happier-dev/connection-supervisor';
import { resolveSentFrom } from './domains/messages/sentFrom';
import { NormalizedMessage, normalizeRawMessage, RawRecord, RawRecordSchema } from './typesRaw';
import { applySettings, Settings, settingsDefaults, settingsParse, SUPPORTED_SCHEMA_VERSION } from './domains/settings/settings';
import { Profile, profileDefaults } from './domains/profiles/profile';
import {
    loadPendingSettings,
    savePendingSettings,
    loadSessionMaterializedMaxSeqById,
    saveSessionMaterializedMaxSeqById,
    loadChangesCursor,
    saveChangesCursor,
    loadProfile as loadPersistedProfile,
} from './domains/state/persistence';
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
import { initializeTracking, tracking } from '@/track';
import { applyCrashReportsOptOut } from '@/utils/system/sentry';
import { parseToken } from '@/utils/auth/parseToken';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { RevenueCat } from './domains/purchases';
import { trackPaywallPresented, trackPaywallPurchased, trackPaywallCancelled, trackPaywallRestored, trackPaywallError } from '@/track';
import { getActiveServerSnapshot } from './domains/server/serverRuntime';
import type { SettingsAnalyticsSource } from '@/track/settingsAnalytics/types';
import { setActiveServerSessionListCache } from './store/sessionListCache';
import { config } from '@/config';
import { log } from '@/log';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { ingestWorkspaceMutationMessages } from '@/scm/refresh/workspaceMutationIngestionRuntime';
import { projectManager } from './runtime/orchestration/projectManager';
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
import { dbgSettings, isSettingsSyncDebugEnabled, summarizeSettings, summarizeSettingsDelta } from './domains/settings/debugSettings';
import {
    decryptSecretValueWithKeys,
    deriveSettingsSecretsKeySet,
    encryptSecretString,
    sealSecretsDeep,
} from './encryption/secretSettings';
import { didControlReturnToMobile } from './domains/session/control/controlledByUserTransitions';
import { chooseSubmitMode } from './domains/session/control/submitMode';
import type { SavedSecret } from './domains/settings/savedSecretTypes';
import type { PermissionMode } from './domains/permissions/permissionTypes';
import { scheduleDebouncedPendingSettingsFlush } from './engine/pending/pendingSettings';
import {
    applySettingsLocalDelta,
    syncSettings as syncSettingsEngine,
    type SyncSettingsParams,
} from './engine/settings/syncSettings';
import { getOfferings as getOfferingsEngine, presentPaywall as presentPaywallEngine, purchaseProduct as purchaseProductEngine, syncPurchases as syncPurchasesEngine } from './engine/purchases/syncPurchases';
import { fetchChanges } from './api/session/apiChanges';
import { runWithInFlightDedupe } from '@/sync/runtime/orchestration/runWithInFlightDedupe';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import { decideMessageCatchUpPolicy } from '@/sync/runtime/orchestration/messageCatchUpPolicy';
import { applyMessageCatchUpDecision } from '@/sync/runtime/orchestration/applyMessageCatchUpDecision';
import { readDirectSessionLink } from '@/sync/domains/session/directSessions/readDirectSessionLink';
import { normalizeDirectTranscriptMessages } from '@/sync/runtime/directSessions/normalizeDirectTranscriptMessages';
import { readStoredSessionRawRecord } from '@/sync/runtime/readStoredSessionContent';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { emitSessionMetadataUpdateWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/emitSessionMetadataUpdateWithServerScope';
import { fetchSessionByIdWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope';
import { createSessionRequestWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';
import { sessionRpcWithPreferredSessionScope } from '@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope';
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
} from './engine/artifacts/syncArtifacts';
import { fetchAndApplyFeed, handleNewFeedPostUpdate, handleRelationshipUpdatedSocketUpdate, handleTodoKvBatchUpdate } from './engine/social/syncFeed';
import { fetchAndApplyFriends } from './engine/social/syncFriends';
import { fetchAndApplyProfile, handleUpdateAccountSocketUpdate, registerPushTokenIfAvailable } from './engine/account/syncAccount';
import { buildMachineFromMachineActivityEphemeralUpdate, buildUpdatedMachineFromSocketUpdate, fetchAndApplyMachines } from './engine/machines/syncMachines';
import { fetchAndApplyAutomationRuns, fetchAndApplyAutomations } from './engine/automations/syncAutomations';
import { applyTodoSocketUpdates as applyTodoSocketUpdatesEngine, fetchTodos as fetchTodosEngine } from './engine/todos/syncTodos';
import { planSyncActionsFromChanges } from './runtime/orchestration/changesPlanner';
import { applyPlannedChangeActions } from './runtime/orchestration/changesApplier';
import { runSocketReconnectCatchUpViaChanges } from './runtime/orchestration/socketReconnectViaChanges';
import { socketEmitWithAckFallback } from './engine/socket/socketEmitWithAckFallback';
import { publishPermissionModeToMetadata as publishPermissionModeToMetadataEngine } from './engine/overrides/permissionModePublish';
import { publishAcpSessionModeOverrideToMetadata as publishAcpSessionModeOverrideToMetadataEngine } from './engine/overrides/acpSessionModeOverridePublish';
import { publishModelOverrideToMetadata as publishModelOverrideToMetadataEngine } from './engine/overrides/modelOverridePublish';
import { publishAcpConfigOptionOverrideToMetadata as publishAcpConfigOptionOverrideToMetadataEngine, type AcpConfigOptionOverrideValueId } from './engine/overrides/acpConfigOptionOverridePublish';
import { RPC_ERROR_CODES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotAvailableError } from '@/sync/runtime/rpcErrors';
import { MessageAckResponseSchema, type MessageAckResponse } from '@happier-dev/protocol/updates';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
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
import { fetchAndApplySessionById } from './engine/sessions/sessionById';
import { getForkedTranscriptSnapshotCached } from './domains/sessionFork/forkedTranscriptSnapshot';
import {
    computeForkedTranscriptHasMoreOlder,
    resolveNextForkedTranscriptLoadOlderRequest,
} from './domains/sessionFork/forkedTranscriptPaging';
import {
    deleteDiscardedPendingMessageV2,
    deletePendingMessageV2,
    discardPendingMessageV2,
    enqueuePendingMessageV2,
    fetchAndApplyPendingMessagesV2,
    reorderPendingMessagesV2,
    restoreDiscardedPendingMessageV2,
    updatePendingMessageV2,
} from './engine/pending/pendingQueueV2';
import {
    flushActivityUpdates as flushActivityUpdatesEngine,
    flushMachineActivityUpdates as flushMachineActivityUpdatesEngine,
    handleEphemeralSocketUpdate,
    handleSocketUpdate,
    parseUpdateContainer,
} from './engine/socket/socket';

const SESSION_MESSAGES_PAGE_SIZE = 150;

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

function hasAuthoritativeSessionRouteData(session: Session | null | undefined): boolean {
    return Boolean(session?.metadata != null && session?.agentState != null);
}

function isFallbackSafeSessionUserMessageRpcError(error: unknown): boolean {
    // The only intended fallback here is compatibility with older daemons that don't implement
    // the active-session runtime RPC yet.
    return isRpcMethodNotAvailableError(error);
}

function readOptionalSessionMetadataString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

class Sync {

        encryption!: Encryption;
        serverID!: string;
        anonID!: string;
        private credentials!: AuthCredentials;
        private pauseController = new PauseController();
        private activeEndpointSupervisor: ManagedEndpointSupervisor | null = null;
        private detachActiveEndpointSupervisorListener: (() => void) | null = null;
        private lastObservedEndpointPhase: ManagedEndpointSupervisorState['phase'] | null = null;
        private syncTuning: SyncTuning = loadSyncTuning();
      private resumeInFlight: Promise<void> | null = null;
      private isForeground = AppState.currentState === 'active';
      public encryptionCache = new EncryptionCache();
      private sessionsSync: InvalidateSync;
    private messagesSync = new Map<string, InvalidateSync>();
    private activeServerSessionIds = new Set<string>();
    private hasFetchedSessionsSnapshotForActiveServer = false;
    private serverScopeGeneration = 0;
      private sessionByIdHydrationInFlight = new Map<string, Promise<boolean>>();
      private sessionReceivedMessages = new Map<string, Map<string, number>>();
      private sessionMessagesBeforeSeqByKey = new Map<string, number>();
      private sessionMessagesHasMoreOlderByKey = new Map<string, boolean>();
      private sessionMessagesFetchLatestInFlightByKey = new Set<string>();
      private sessionMessagesFetchedLatestByKey = new Set<string>();
      private sessionMessagesLoadingOlderByKey = new Set<string>();
      private sessionMessagesLoadingNewerByKey = new Set<string>();
      private sessionMessagesPaginationSupportedByKey = new Map<string, boolean>();
      private directSessionOlderCursorBySessionId = new Map<string, string | null>();
      private directSessionHasMoreOlderBySessionId = new Map<string, boolean>();
      private directSessionTailCursorBySessionId = new Map<string, string | null>();
      private sessionViewport = new Map<string, { isPinned: boolean; offsetY: number; lastUpdatedAt: number }>();
      private deferredForwardLoadingSessions = new Set<string>();
      private sessionDataKeys = new Map<string, Uint8Array>(); // Store session data encryption keys internally
      private machineDataKeys = new Map<string, Uint8Array>(); // Store machine data encryption keys internally
      private artifactDataKeys = new Map<string, Uint8Array>(); // Store artifact data encryption keys internally
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
    private todosSync: InvalidateSync;
    private automationsSync: InvalidateSync;
    private activityAccumulator: ActivityUpdateAccumulator;
    private machineActivityAccumulator: MachineActivityAccumulator;
    private pendingSettings: Partial<Settings> = loadPendingSettings();
    private pendingSettingsFlushTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingSettingsDirty = false;
    private sessionMaterializedMaxSeqById: Record<string, number> = loadSessionMaterializedMaxSeqById();
    private sessionMaterializedMaxSeqFlushTimer: ReturnType<typeof setTimeout> | null = null;
    private sessionMaterializedMaxSeqDirty = false;
	      private changesCursor: string | null = loadChangesCursor(String(getActiveServerSnapshot().serverId ?? '').trim() || null);
	      private changesCursorFlushTimer: ReturnType<typeof setTimeout> | null = null;
	      private changesCursorDirty = false;
	      private lastSocketDisconnectedAtMs: number | null = null;
	      private lastSocketOfflineDurationMs: number | null = null;
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
            this.settingsSync = new InvalidateSync(this.syncSettings, { onError, onSuccess, onRetry, pause, backoff });
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
            this.activityAccumulator = new ActivityUpdateAccumulator(this.flushActivityUpdates.bind(this), 500);
            this.machineActivityAccumulator = new MachineActivityAccumulator(this.flushMachineActivityUpdates.bind(this), 300);

          // Listen for app state changes to pause sync + run a single centralized resume pipeline.
          AppState.addEventListener('change', (nextAppState) => {
              if (nextAppState === 'active') {
                  this.isForeground = true;
                  setServerReachabilityNetworkAllowed(true);
                  log.log('📱 App became active');
                  this.pauseController.resume();
                  try {
                      this.activeEndpointSupervisor?.invalidate();
                  } catch {
                      // ignore
                  }
                  fireAndForget(invalidateAllServerReachabilitySupervisors(), { tag: 'Sync.invalidateAllServerReachabilitySupervisors' });
                  try {
                      apiSocket.connect();
                  } catch {
                      // ignore
                  }
                  fireAndForget(this.resumeSync('app-foreground'), { tag: 'Sync.resumeSync.app-foreground' });
              } else {
                  this.isForeground = false;
                  setServerReachabilityNetworkAllowed(false);
                  log.log(`📱 App state changed to: ${nextAppState}`);
                  this.pauseController.pause();
                  try {
                      apiSocket.disconnect();
                  } catch {
                      // ignore
                  }
                  fireAndForget(stopServerReachabilitySupervisors(), { tag: 'Sync.stopServerReachabilitySupervisors' });
                  // Reliability: ensure we persist any pending settings immediately when backgrounding.
                  // This avoids losing last-second settings changes if the OS suspends the app.
                  try {
                      if (this.pendingSettingsFlushTimer) {
                        clearTimeout(this.pendingSettingsFlushTimer);
                        this.pendingSettingsFlushTimer = null;
                    }
                    savePendingSettings(this.pendingSettings);
                } catch {
                    // ignore
                }
                  // Reliability: also flush per-session materialized message cursors.
                  try {
                      this.flushSessionMaterializedMaxSeq();
                  } catch {
                      // ignore
                  }
                  // Reliability: flush changes cursor immediately too (avoid losing catch-up position).
                  try {
                      this.flushChangesCursorNow();
                  } catch {
                      // ignore
                  }
              }
          });

          // Web: AppState events are not always reliable when tabs are backgrounded. Mirror the
          // pause/resume behavior using document visibility.
          if (Platform.OS === 'web') {
              const doc = (globalThis as unknown as { document?: any }).document;
              if (doc && typeof doc.addEventListener === 'function' && typeof doc.removeEventListener === 'function') {
                  const onVisibilityChange = () => {
                      const state = String(doc.visibilityState ?? '').trim().toLowerCase();
                      if (state === 'hidden' || state === 'visible') {
                          const nextIsForeground = state === 'visible';
                          if (this.isForeground === nextIsForeground) {
                              return;
                          }
                      }
                      if (state === 'hidden') {
                          this.isForeground = false;
                          setServerReachabilityNetworkAllowed(false);
                          this.pauseController.pause();
                          try {
                              apiSocket.disconnect();
                          } catch {
                              // ignore
                          }
                          fireAndForget(stopServerReachabilitySupervisors(), { tag: 'Sync.stopServerReachabilitySupervisors.visibility' });
                          return;
                      }
                      if (state === 'visible') {
                          this.isForeground = true;
                          setServerReachabilityNetworkAllowed(true);
                          this.pauseController.resume();
                          try {
                              this.activeEndpointSupervisor?.invalidate();
                          } catch {
                              // ignore
                          }
                          fireAndForget(invalidateAllServerReachabilitySupervisors(), { tag: 'Sync.invalidateAllServerReachabilitySupervisors.visibility' });
                          try {
                              apiSocket.connect();
                          } catch {
                              // ignore
                          }
                          fireAndForget(this.resumeSync('app-foreground'), { tag: 'Sync.resumeSync.visibility' });
                      }
                  };
                  try {
                      doc.addEventListener('visibilitychange', onVisibilityChange);
                  } catch {
                      // ignore
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

      public setActiveEndpointSupervisor(supervisor: ManagedEndpointSupervisor | null): void {
          if (this.activeEndpointSupervisor === supervisor) return;

          try {
              this.detachActiveEndpointSupervisorListener?.();
          } catch {
              // ignore
          }
          this.detachActiveEndpointSupervisorListener = null;
          this.lastObservedEndpointPhase = null;
          this.activeEndpointSupervisor = supervisor;

          if (!supervisor) return;

          // Seed phase and subscribe to online transitions so we can kick off one consolidated resume pipeline.
          try {
              this.lastObservedEndpointPhase = supervisor.getState().phase;
          } catch {
              this.lastObservedEndpointPhase = null;
          }

          this.detachActiveEndpointSupervisorListener = supervisor.subscribe((next) => {
              const prev = this.lastObservedEndpointPhase;
              this.lastObservedEndpointPhase = next.phase;
              if (prev && prev !== 'online' && next.phase === 'online') {
                  // Use a microtask so callers that publish state synchronously don't re-enter.
                  queueMicrotask(() => {
                      fireAndForget(this.resumeSync('endpoint-online'), { tag: 'Sync.resumeSync.endpoint-online' });
                  });
              }
          });
      }

    setMessageTransport(transport: SyncMessageTransport): void {
        this.messageTransport = transport;
    }

    resetMessageTransport(): void {
        this.messageTransport = createDefaultMessageTransport();
    }

    private getChangesCursorScope(): string | null {
        const scope = String(getActiveServerSnapshot().serverId ?? '').trim();
        return scope || null;
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
                savePendingSettings(this.pendingSettings);
                // Trigger server sync (can be retried later).
                this.settingsSync.invalidate();
            },
            delayMs: 900,
        });
    };

    async create(credentials: AuthCredentials, encryption: Encryption) {
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        setWarmCacheAccountScope(this.serverID);
        this.changesCursor = loadChangesCursor(this.getChangesCursorScope());
        this.changesCursorDirty = false;
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
        // NOTE: No awaiting anything here, we're restoring from a disk (ie app restarted)
        // Purchases sync is invalidated in #init() and will complete asynchronously
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        setWarmCacheAccountScope(this.serverID);
        this.changesCursor = loadChangesCursor(this.getChangesCursorScope());
        this.changesCursorDirty = false;
        try {
            const keySet = deriveSettingsSecretsKeySet(resolveAccountScopedCryptoMaterialFromCredentials(credentials));
            this.settingsSecretsKey = keySet.writeKey;
            this.settingsSecretsReadKeys = keySet.readKeys;
        } catch {
            this.settingsSecretsKey = null;
            this.settingsSecretsReadKeys = [];
        }
        this.hydrateWarmCachesForActiveServer();
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
    }

    private resetServerScopedRuntimeState = () => {
        this.serverScopeGeneration += 1;
        apiSocket.disconnect();
        this.activityAccumulator.reset();
        this.machineActivityAccumulator.reset();

        for (const timer of this.pendingMessageCommitRetryTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingMessageCommitRetryTimers.clear();

        for (const timer of this.messagesSync.values()) {
            timer.stop();
        }
        this.messagesSync.clear();
        this.sessionReceivedMessages.clear();
        this.sessionMessagesBeforeSeqByKey.clear();
        this.sessionMessagesHasMoreOlderByKey.clear();
        this.sessionMessagesFetchLatestInFlightByKey.clear();
        this.sessionMessagesFetchedLatestByKey.clear();
        this.sessionMessagesLoadingOlderByKey.clear();
        this.sessionMessagesLoadingNewerByKey.clear();
        this.sessionMessagesPaginationSupportedByKey.clear();
        this.sessionViewport.clear();
        this.deferredForwardLoadingSessions.clear();
        this.activeServerSessionIds.clear();
        this.hasFetchedSessionsSnapshotForActiveServer = false;
        this.sessionDataKeys.clear();
        this.machineDataKeys.clear();
        this.artifactDataKeys.clear();
        this.readStateV1RepairAttempted.clear();
        this.readStateV1RepairInFlight.clear();

        this.lastSocketDisconnectedAtMs = null;
        if (this.changesCursorFlushTimer) {
            clearTimeout(this.changesCursorFlushTimer);
            this.changesCursorFlushTimer = null;
        }
        this.changesCursorDirty = false;
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
            lastSyncAt: null,
        }));
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
            const prevViewport = this.sessionViewport.get(sessionId);
            if (prevViewport) {
                this.sessionViewport.set(sessionId, { ...prevViewport, lastUpdatedAt: Date.now() });
            } else {
                this.onSessionViewportChange(sessionId, { isPinned: true, offsetY: 0 });
            }
            this.getOrCreateMessagesSync(sessionId).invalidateCoalesced();

            // Notify voice assistant about session visibility
            const session = storage.getState().sessions[sessionId];
            if (session) {
                voiceHooks.onSessionFocus(sessionId, session.metadata || undefined);
        }
    }

        refreshSessionMessages = async (sessionId: string): Promise<void> => {
            const normalized = String(sessionId ?? '').trim();
            if (!normalized) return;
            await this.getOrCreateMessagesSync(normalized).invalidateAndAwait();
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
            options?: Readonly<{ forceRefresh?: boolean }>,
        ): Promise<boolean> => {
            const normalized = String(sessionId ?? '').trim();
            if (!normalized) return true;
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

            // Fast-path when we already know the session exists on this server and the stored record is
            // already authoritatively hydrated (deep links can occur before the sessions snapshot bootstraps).
            const existingSession = storage.getState().sessions[normalized];
            if (!forceRefresh && this.isSessionKnownOnActiveServer(normalized) && existingSession) {
                const encryptionMode: 'e2ee' | 'plain' = existingSession.encryptionMode === 'plain' ? 'plain' : 'e2ee';
                const hasEncryption = Boolean(this.encryption.getSessionEncryption(normalized));
                const hasAuthoritativeSessionRouteState = hasAuthoritativeSessionRouteData(existingSession);
                if (DEBUG_SESSION_HYDRATE) {
                    log.log(`[sessionHydrate] fast-path check ${normalized} mode=${encryptionMode} hasEncryption=${hasEncryption} hasRouteState=${hasAuthoritativeSessionRouteState}`);
                }
                if (hasAuthoritativeSessionRouteState && (encryptionMode === 'plain' || hasEncryption)) {
                    if (DEBUG_SESSION_HYDRATE) {
                        log.log(`[sessionHydrate] fast-path hit ${normalized}`);
                    }
                    return true;
                }
            }

            // Sync might not be fully initialized yet (e.g. very early during app bootstrap).
            const credentials = this.credentials;
            if (!credentials) {
                if (DEBUG_SESSION_HYDRATE) {
                    log.log(`[sessionHydrate] missing credentials for ${normalized}`);
                }
                return false;
            }

            const existing = this.sessionByIdHydrationInFlight.get(normalized);
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
                    const result = await fetchSessionByIdWithServerScope({
                        sessionId: normalized,
                        serverId: resolvePreferredServerIdForSessionId(normalized),
                        activeCredentials: credentials,
                        activeEncryption: this.encryption,
                        sessionDataKeys: this.sessionDataKeys,
                        activeRequest: (path, init) => apiSocket.request(path, init),
                        getExistingSession: (sessionId) => storage.getState().sessions[sessionId] ?? null,
                        applySessions: (sessions) => this.applySessions(sessions),
                        log,
                    });
                    if (!result.ok) {
                        const code = typeof result.errorCode === 'string' ? result.errorCode : '';
                        // Terminal errors should not spin forever in route hydration. Let the route render and fail closed.
                        if (code === 'not_found' || code === 'unauthorized' || code === 'forbidden') {
                            return true;
                        }
                        return false;
                    }

                    // Ensure the *current* encryption instance is initialized for this session.
                    // During app bootstrap / key restoration, the sync encryption instance can change while
                    // the session-by-id hydration request is in-flight. Re-initializing here ensures
                    // subsequent message fetches can proceed immediately.
                    const sessionDataKey = this.sessionDataKeys.get(normalized) ?? null;
                    await this.encryption.initializeSessions(new Map([[normalized, sessionDataKey]]));

                    this.activeServerSessionIds.add(normalized);
                    if (DEBUG_SESSION_HYDRATE) {
                        const hasEncryption = Boolean(this.encryption.getSessionEncryption(normalized));
                        log.log(`[sessionHydrate] hydration ok ${normalized} hasEncryption=${hasEncryption}`);
                    }
                    return true;
                } catch (err) {
                    log.log(`⚠️ ensureSessionVisibleForMessageRoute failed for ${normalized}: ${err instanceof Error ? err.message : 'unknown error'}`);
                    return false;
                }
            })();

            this.sessionByIdHydrationInFlight.set(normalized, inFlight);
            inFlight.finally(() => {
                if (this.sessionByIdHydrationInFlight.get(normalized) === inFlight) {
                    this.sessionByIdHydrationInFlight.delete(normalized);
                }
            });

            const ok = await inFlight;
            if (ok) {
                this.getOrCreateMessagesSync(normalized).invalidateCoalesced();
            }
            return ok;
        }


    async sendMessage(
        sessionId: string,
        text: string,
        displayText?: string,
        metaOverrides?: Record<string, unknown>,
        options?: Readonly<{ profileId?: string | null }>
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

            // Generate local ID
            const localId = randomUUID();

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
                text,
                displayText,
                rawRecord: content,
            });

            if (session.active === true) {
                try {
                    await apiSocket.sessionRPC<{ ok: true }, {
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
                    await publishNextPromptPermissionModeIfNeeded();
                    return;
                } catch (error) {
                    if (!isFallbackSafeSessionUserMessageRpcError(error)) {
                        storage.getState().removePendingMessage(sessionId, localId);
                        throw error;
                    }
                }
            }

            const payload = {
                sid: sessionId,
                message: messagePayload,
                localId,
                sentFrom,
                permissionMode: permissionMode || 'default'
            };

            const rawAck = await socketEmitWithAckFallback<MessageAckResponse>({
                emitWithAck: (event, payload, opts) =>
                    this.messageTransport.emitWithAck<MessageAckResponse>(event, payload, opts),
                send: (event, payload) => this.messageTransport.send(event, payload),
                event: 'message',
                payload,
                timeoutMs: this.syncTuning.socketAckTimeoutMs,
                onNoAck: () => this.schedulePendingMessageCommitRetry({ sessionId, localId }),
            });

            if (!rawAck) {
                storage.getState().clearSessionOptimisticThinking(sessionId);
                return;
            }

            const parsedAck = MessageAckResponseSchema.safeParse(rawAck);
            if (!parsedAck.success) {
                // Treat malformed ACKs as "no ACK": keep the pending bubble and retry later.
                this.schedulePendingMessageCommitRetry({ sessionId, localId });
                return;
            }

            const ack = parsedAck.data;

            if (ack.ok !== true) {
                storage.getState().removePendingMessage(sessionId, localId);
                throw new Error(ack.error || 'Message send rejected');
            }

            // Message is committed. Remove from pending and insert into the canonical transcript
            // (without waiting for broadcast updates, which can be missed on backgrounded devices).
            storage.getState().removePendingMessage(sessionId, localId);
            const committed = normalizeRawMessage(ack.id, localId, createdAt, content, { seq: ack.seq });
            if (committed) {
                this.applyMessages(sessionId, [committed]);
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

		            if (session.active !== true) {
		                const machineId = typeof session.metadata?.machineId === 'string' ? session.metadata.machineId.trim() : '';
		                const directory = typeof session.metadata?.path === 'string' ? session.metadata.path.trim() : '';
		                if (machineId && directory) {
                            const resolvedBackend = resolveSessionActionDefaultBackend({ session });
                            if (resolvedBackend) {
		                        fireAndForget(
		                            resumeSession({
		                                sessionId,
		                                machineId,
		                                directory,
                                        backendTarget: resolvedBackend.backendTarget,
		                            }),
		                            { tag: 'Sync.sendMessage.wakeAfterSend' },
		                        );
                            }
		                }
		            }

	            // Server ACK means the user message is committed (or idempotently confirmed).
	            // Do NOT clear optimistic thinking here: the agent can still be mid-turn (streaming / tool calls).
	            // We clear optimistic thinking only when we see a terminal lifecycle marker (task_complete / turn_aborted),
            // when the session enters a permission/action-required gate, when the session is marked thinking by live
            // activity updates, or when the optimistic timeout expires.
        } catch (e) {
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
    }): Promise<void> {
        storage.getState().markSessionOptimisticThinking(sessionId);

        const session = storage.getState().sessions[sessionId];
        if (!session) {
            storage.getState().clearSessionOptimisticThinking(sessionId);
            throw new Error(`Session ${sessionId} not found in storage`);
        }

        const sessionEncryptionMode: 'e2ee' | 'plain' = session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
        const sessionEncryption = sessionEncryptionMode === 'plain' ? null : this.encryption.getSessionEncryption(sessionId);
        if (sessionEncryptionMode === 'e2ee' && !sessionEncryption) {
            storage.getState().clearSessionOptimisticThinking(sessionId);
            throw new Error(`Session ${sessionId} encryption not found`);
        }

        try {
            const permissionMode = session.permissionMode || 'default';

            const parsed = RawRecordSchema.safeParse(pending.rawRecord);
            const content: RawRecord = parsed.success ? parsed.data : await (async () => {
                const flavor = session.metadata?.flavor;
                const agentId = resolveAgentIdFromFlavor(flavor);
                const modelMode = session.modelMode || (agentId ? getAgentCore(agentId).model.defaultMode : 'default');
                const model = agentId && getAgentCore(agentId).model.supportsSelection && modelMode !== 'default' ? modelMode : undefined;
                const state = storage.getState();
                return {
                    role: 'user',
                    content: { type: 'text', text: pending.text },
                    meta: buildSendMessageMeta({
                        sentFrom: resolveSentFrom(),
                        permissionMode: permissionMode || 'default',
                        model,
                        displayText: pending.displayText,
                        agentId,
                        settings: storage.getState().settings,
                        session,
                    }),
                };
            })();

            const messagePayload =
                sessionEncryptionMode === 'plain'
                    ? { t: 'plain' as const, v: content }
                    : await sessionEncryption!.encryptRawRecord(content);

            const localId = pending.localId;
            const payload = {
                sid: sessionId,
                message: messagePayload,
                localId,
                sentFrom: 'pending_send_now',
                permissionMode: permissionMode || 'default',
            };

            const rawAck = await socketEmitWithAckFallback<MessageAckResponse>({
                emitWithAck: (event, payload, opts) =>
                    this.messageTransport.emitWithAck<MessageAckResponse>(event, payload, opts),
                send: (event, payload) => this.messageTransport.send(event, payload),
                event: 'message',
                payload,
                timeoutMs: this.syncTuning.socketAckTimeoutMs,
                onNoAck: () => this.schedulePendingMessageCommitRetry({ sessionId, localId }),
            });

            if (!rawAck) {
                storage.getState().clearSessionOptimisticThinking(sessionId);
                return;
            }

            const parsedAck = MessageAckResponseSchema.safeParse(rawAck);
            if (!parsedAck.success) {
                this.schedulePendingMessageCommitRetry({ sessionId, localId });
                return;
            }

            const ack = parsedAck.data;

            if (ack.ok !== true) {
                storage.getState().removePendingMessage(sessionId, pending.localId);
                throw new Error(ack.error || 'Message send rejected');
            }

            const committed = normalizeRawMessage(ack.id, localId, pending.createdAt, content, { seq: ack.seq });
            if (committed) {
                this.applyMessages(sessionId, [committed]);
            }
            this.markSessionMaterializedMaxSeq(sessionId, ack.seq);

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

            const settingsApplyTiming = storage.getState().settings.sessionPermissionModeApplyTiming ?? 'immediate';
            if (settingsApplyTiming === 'next_prompt') {
                const latestSession = storage.getState().sessions[sessionId] ?? null;
                const localUpdatedAt = latestSession?.permissionModeUpdatedAt ?? null;
                const metadataUpdatedAtRaw = latestSession?.metadata?.permissionModeUpdatedAt ?? null;
                const metadataUpdatedAt =
                    typeof metadataUpdatedAtRaw === 'number' && Number.isFinite(metadataUpdatedAtRaw)
                        ? metadataUpdatedAtRaw
                        : 0;

                if (typeof localUpdatedAt === 'number' && Number.isFinite(localUpdatedAt) && localUpdatedAt > metadataUpdatedAt) {
                    const modeToPublish = (latestSession?.permissionMode ?? 'default') as PermissionMode;
                    try {
                        await this.publishSessionPermissionModeToMetadata({
                            sessionId,
                            permissionMode: modeToPublish,
                            permissionModeUpdatedAt: localUpdatedAt,
                        });
                    } catch {
                        // Best-effort only.
                    }
                }
            }

            // Same policy as sendMessage(): keep optimistic thinking until lifecycle clears.
        } catch (e) {
            storage.getState().clearSessionOptimisticThinking(sessionId);
            throw e;
        }
    }

    private schedulePendingMessageCommitRetry(params: { sessionId: string; localId: string }): void {
        const key = `${params.sessionId}:${params.localId}`;
        if (this.pendingMessageCommitRetryTimers.has(key)) {
            return;
        }

        const run = async (attempt: number): Promise<void> => {
            const pendingState = storage.getState().sessionPending[params.sessionId];
            const pending = pendingState?.messages?.find((m) => m.id === params.localId) ?? null;
            if (!pending) {
                const existing = this.pendingMessageCommitRetryTimers.get(key);
                if (existing) {
                    clearTimeout(existing);
                }
                this.pendingMessageCommitRetryTimers.delete(key);
                return;
            }

                  const sessionEncryption = this.encryption.getSessionEncryption(params.sessionId);
                  if (!sessionEncryption) {
                      // If the session/encryption isn't available (e.g. session list was cleared or the app is mid-rehydrate),
                      // don't leave this retry stuck. Ask for a sessions refresh and reschedule with backoff.
                      fireAndForget(this.fetchSessions(), { tag: 'Sync.pendingMessageCommitRetry.fetchSessions' });

                    const nextAttempt = attempt + 1;
                    if (nextAttempt >= 6) {
                        const existing = this.pendingMessageCommitRetryTimers.get(key);
                        if (existing) {
                        clearTimeout(existing);
                    }
                    this.pendingMessageCommitRetryTimers.delete(key);
                    return;
                }

                  const baseDelayMs = Math.min(30_000, 1_000 * Math.pow(2, nextAttempt));
                  const jitterMs = Math.floor(Math.random() * 250);
                  const timeout = setTimeout(() => {
                      fireAndForget(run(nextAttempt), { tag: `Sync.pendingMessageCommitRetry:${key}` });
                  }, baseDelayMs + jitterMs);
                  this.pendingMessageCommitRetryTimers.set(key, timeout);
                  return;
              }

            const encrypted = await sessionEncryption.encryptRawRecord(pending.rawRecord as RawRecord);
            const payload = {
                sid: params.sessionId,
                message: encrypted,
                localId: params.localId,
                sentFrom: 'retry',
                permissionMode: 'default',
            };

            const rawAck = await (async () => {
                try {
                    return await this.messageTransport.emitWithAck<MessageAckResponse>('message', payload, {
                        timeoutMs: this.syncTuning.socketAckTimeoutMs,
                    });
                } catch {
                    return null;
                }
            })();

            const ack = rawAck ? MessageAckResponseSchema.safeParse(rawAck) : null;

            if (ack?.success && ack.data.ok === true) {
                storage.getState().removePendingMessage(params.sessionId, params.localId);
                const committed = normalizeRawMessage(ack.data.id, params.localId, pending.createdAt, pending.rawRecord as RawRecord, { seq: ack.data.seq });
                if (committed) {
                    this.applyMessages(params.sessionId, [committed]);
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

                const existing = this.pendingMessageCommitRetryTimers.get(key);
                if (existing) {
                    clearTimeout(existing);
                }
                this.pendingMessageCommitRetryTimers.delete(key);
                return;
            }

            if (ack?.success && ack.data.ok === false) {
                storage.getState().removePendingMessage(params.sessionId, params.localId);
                const existing = this.pendingMessageCommitRetryTimers.get(key);
                if (existing) {
                    clearTimeout(existing);
                }
                this.pendingMessageCommitRetryTimers.delete(key);
                return;
            }

            const nextAttempt = attempt + 1;
            if (nextAttempt >= 6) {
                const existing = this.pendingMessageCommitRetryTimers.get(key);
                if (existing) {
                    clearTimeout(existing);
                }
                this.pendingMessageCommitRetryTimers.delete(key);
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

    async abortSession(sessionId: string): Promise<void> {
        await sessionRpcWithPreferredSessionScope<void, { reason: string }>({
            sessionId,
            method: 'abort',
            payload: {
            reason: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`
            },
        });
    }

    async submitMessage(sessionId: string, text: string, displayText?: string, metaOverrides?: Record<string, unknown>): Promise<void> {
        const configuredMode = storage.getState().settings.sessionMessageSendMode;
        const busySteerSendPolicy = storage.getState().settings.sessionBusySteerSendPolicy;
        const session = storage.getState().sessions[sessionId] ?? null;
        const mode = chooseSubmitMode({ configuredMode, busySteerSendPolicy, session });

        if (mode === 'interrupt') {
            try { await this.abortSession(sessionId); } catch { }
            await this.sendMessage(sessionId, text, displayText, metaOverrides);
            return;
        }
        if (mode === 'server_pending') {
            await this.enqueuePendingMessage(sessionId, text, displayText, metaOverrides);
            return;
        }
        await this.sendMessage(sessionId, text, displayText, metaOverrides);
    }

    private async updateSessionMetadataWithRetry(
        sessionId: string,
        updater: (metadata: Metadata) => Metadata,
        options?: Readonly<{ serverId?: string | null }>,
    ): Promise<void> {
        const session = storage.getState().sessions[sessionId] ?? null;
        const sessionEncryptionMode: 'e2ee' | 'plain' = session?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
        const encryption = sessionEncryptionMode === 'plain' ? null : this.encryption.getSessionEncryption(sessionId);
        if (sessionEncryptionMode === 'e2ee' && !encryption) {
            throw new Error(`Session ${sessionId} not found`);
        }

        const resolvedServerIdOverride =
            typeof options?.serverId === 'string' && options.serverId.trim().length > 0
                ? options.serverId.trim()
                : null;

        await updateSessionMetadataWithRetryRpc<Metadata>({
            sessionId,
            getSession: () => {
                const s = storage.getState().sessions[sessionId];
                if (!s?.metadata) return null;
                return { metadataVersion: s.metadataVersion, metadata: s.metadata };
            },
            refreshSessions: async () => {
                if (!this.credentials) {
                    throw new Error('Sync credentials not available');
                }
                await fetchSessionByIdWithServerScope({
                    sessionId,
                    serverId: resolvedServerIdOverride ?? resolvePreferredServerIdForSessionId(sessionId),
                    activeCredentials: this.credentials,
                    activeEncryption: this.encryption,
                    sessionDataKeys: this.sessionDataKeys,
                    activeRequest: (path, init) => apiSocket.request(path, init),
                    applySessions: (sessions) => this.applySessions(sessions),
                    getExistingSession: (targetSessionId) => storage.getState().sessions[targetSessionId] ?? null,
                    log,
                });
            },
            encryptMetadata: async (metadata) => {
                if (sessionEncryptionMode === 'plain') {
                    return JSON.stringify(metadata);
                }
                return await encryption!.encryptMetadata(metadata);
            },
            decryptMetadata: async (version, encrypted) => {
                if (sessionEncryptionMode !== 'plain') {
                    return await encryption!.decryptMetadata(version, encrypted);
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
                storage.getState().applySessions([{
                    ...session,
                    lastViewedSessionSeq: acknowledgedSeq,
                }]);
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

    async fetchPendingMessages(sessionId: string): Promise<void> {
        const request = this.createSessionRequest(sessionId);
        await fetchAndApplyPendingMessagesV2({
            sessionId,
            encryption: this.encryption,
            request,
        });
    }

    async enqueuePendingMessage(sessionId: string, text: string, displayText?: string, metaOverrides?: Record<string, unknown>): Promise<void> {
        const request = this.createSessionRequest(sessionId);
        await enqueuePendingMessageV2({
            sessionId,
            text,
            displayText,
            metaOverrides,
            encryption: this.encryption,
            fetchArtifactWithBody: (artifactId) => this.fetchArtifactWithBody(artifactId),
            updateArtifact: (artifact) => storage.getState().updateArtifact(artifact),
            request,
        });
    }

    async updatePendingMessage(sessionId: string, pendingId: string, text: string): Promise<void> {
        const request = this.createSessionRequest(sessionId);
        await updatePendingMessageV2({
            sessionId,
            pendingId,
            text,
            encryption: this.encryption,
            fetchArtifactWithBody: (artifactId) => this.fetchArtifactWithBody(artifactId),
            updateArtifact: (artifact) => storage.getState().updateArtifact(artifact),
            request,
        });
    }

    async deletePendingMessage(sessionId: string, pendingId: string): Promise<void> {
        const request = this.createSessionRequest(sessionId);
        await deletePendingMessageV2({
            sessionId,
            pendingId,
            request,
        });
    }

    async discardPendingMessage(
        sessionId: string,
        pendingId: string,
        opts?: { reason?: 'switch_to_local' | 'manual' }
    ): Promise<void> {
        const request = this.createSessionRequest(sessionId);
        await discardPendingMessageV2({
            sessionId,
            pendingId,
            reason: opts?.reason ?? 'manual',
            encryption: this.encryption,
            request,
        });
    }

    async restoreDiscardedPendingMessage(sessionId: string, pendingId: string): Promise<void> {
        const request = this.createSessionRequest(sessionId);
        await restoreDiscardedPendingMessageV2({
            sessionId,
            pendingId,
            encryption: this.encryption,
            request,
        });
    }

    async deleteDiscardedPendingMessage(sessionId: string, pendingId: string): Promise<void> {
        const request = this.createSessionRequest(sessionId);
        await deleteDiscardedPendingMessageV2({
            sessionId,
            pendingId,
            encryption: this.encryption,
            request,
        });
    }

    async reorderPendingMessages(sessionId: string, orderedLocalIds: string[]): Promise<void> {
        const request = this.createSessionRequest(sessionId);
        await reorderPendingMessagesV2({
            sessionId,
            orderedLocalIds,
            encryption: this.encryption,
            request,
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

    refreshProfile = async () => {
        await this.profileSync.invalidateAndAwait();
    }

    purchaseProduct = async (productId: string): Promise<{ success: boolean; error?: string }> => {
        return await purchaseProductEngine({
            revenueCatInitialized: this.revenueCatInitialized,
            productId,
            applyPurchases: (customerInfo) => storage.getState().applyPurchases(customerInfo),
        });
    }

    getOfferings = async (): Promise<{ success: boolean; offerings?: any; error?: string }> => {
        return await getOfferingsEngine({ revenueCatInitialized: this.revenueCatInitialized });
    }

    presentPaywall = async (): Promise<{ success: boolean; purchased?: boolean; error?: string }> => {
        return await presentPaywallEngine({
            revenueCatInitialized: this.revenueCatInitialized,
            trackPaywallPresented,
            trackPaywallPurchased,
            trackPaywallCancelled,
            trackPaywallRestored,
            trackPaywallError,
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

    private getPrioritizedSessionHydrationIds = (): string[] => {
        const prioritizedByViewport = Array.from(this.sessionViewport.entries())
            .sort((left, right) => right[1].lastUpdatedAt - left[1].lastUpdatedAt)
            .map(([sessionId]) => sessionId);

        const eagerListCount = Math.max(0, Math.trunc(this.syncTuning.sessionListEagerHydrationCount ?? 0));
        if (eagerListCount <= 0) {
            return prioritizedByViewport;
        }

        const eagerListIds: string[] = [];
        for (const item of storage.getState().sessionListViewData ?? []) {
            if (item.type !== 'session') continue;
            eagerListIds.push(item.session.id);
            if (eagerListIds.length >= eagerListCount) break;
        }

        return Array.from(new Set([...prioritizedByViewport, ...eagerListIds]));
    }

    private fetchSessions = async () => {
        if (!this.credentials) return;
        const generation = this.serverScopeGeneration;
        const shouldContinue = () => this.serverScopeGeneration === generation;
        const cachedSessionListEntries = buildSessionListCacheEntriesFromRenderables(storage.getState().sessionListRenderables);
        await fetchAndApplySessions({
            serverId: String(getActiveServerSnapshot().serverId ?? '').trim() || null,
            credentials: this.credentials,
            encryption: this.encryption,
            sessionDataKeys: this.sessionDataKeys,
            getExistingSession: (sessionId) => storage.getState().sessions[sessionId] ?? null,
            cachedSessionListEntries,
            shouldContinue,
            applySessionListRenderables: (sessions) => {
                if (!shouldContinue()) return;
                storage.getState().replaceSessionListRenderables(sessions);
            },
            onSnapshotFetched: (sessionIds) => {
                if (!shouldContinue()) return;
                this.activeServerSessionIds = new Set(sessionIds);
                this.hasFetchedSessionsSnapshotForActiveServer = true;
            },
            prioritizeSessionIds: this.getPrioritizedSessionHydrationIds(),
            sessionListEagerHydrationCount: this.syncTuning.sessionListEagerHydrationCount,
            sessionListHydrationConcurrencyLimit: this.syncTuning.sessionListHydrationConcurrencyLimit,
            applySessions: (sessions) => {
                if (!shouldContinue()) return;
                this.applySessions(sessions);
            },
            repairInvalidReadStateV1: (params) => this.repairInvalidReadStateV1(params),
            log,
        });
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
        return Boolean(preferredServerId && preferredServerId !== activeServerId);
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
          fireAndForget(this.resumeSync('manual'), { tag: 'Sync.resumeSync.manual' });
      }

      public resumeSync = (reason: 'app-foreground' | 'socket-reconnect' | 'manual' | 'endpoint-online'): Promise<void> => {
          return runWithInFlightDedupe(
              {
                  get: () => this.resumeInFlight,
                  set: (value) => {
                      this.resumeInFlight = value;
                  },
              },
              async () => {
                  if ((reason === 'socket-reconnect' || reason === 'endpoint-online') && !this.isForeground) {
                      return;
                  }
                  if (this.pauseController.isPaused()) {
                      return;
                  }
                  await this.pauseController.waitUntilResumed();
                  if (!this.credentials) {
                      return;
                  }

                  let accountId = storage.getState().profile?.id ?? null;
                  if (!accountId) {
                      this.profileSync.invalidateCoalesced();
                      await this.profileSync.awaitQueue({ timeoutMs: this.syncTuning.resumeQuickInvalidateTimeoutMs });
                      accountId = storage.getState().profile?.id ?? null;
                  }

                  if (!accountId) {
                      await this.snapshotRefreshOnResume({ mode: 'fallback', reason: 'missing-profile' });
                      return;
                  }

                  const status = await this.resumeViaChanges({ accountId });
                  if (status === 'fallback') {
                      await this.snapshotRefreshOnResume({ mode: 'fallback', reason: 'changes-fallback' });
                      return;
                  }

                  const invalidateBounded = async (syncUnit: InvalidateSync, timeoutMs: number): Promise<void> => {
                      syncUnit.invalidateCoalesced();
                      await syncUnit.awaitQueue({ timeoutMs });
                  };

                  // Activity/presence updates are delivered via ephemerals and are not guaranteed to be recovered
                  // across socket reconnects. When we reconnect without socket.io recovery, refresh the core
                  // snapshots so session.active and machine online state can't get stuck.
                  if (reason === 'socket-reconnect') {
                      await runTasksWithLimit(
                          [
                              () => invalidateBounded(this.sessionsSync, this.syncTuning.resumeQuickInvalidateTimeoutMs),
                              () => invalidateBounded(this.machinesSync, this.syncTuning.resumeQuickInvalidateTimeoutMs),
                          ],
                          this.syncTuning.resumeConcurrencyLimit
                      );
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

          const invalidateBounded = async (syncUnit: InvalidateSync, timeoutMs: number): Promise<void> => {
              syncUnit.invalidateCoalesced();
              await syncUnit.awaitQueue({ timeoutMs });
          };

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

          // Catch up transcripts only for sessions that are already loaded locally.
          const loadedSessionIds: string[] = [];
          try {
              const sessions = storage.getState().sessionMessages;
              for (const sessionId of Object.keys(sessions)) {
                  if (sessions[sessionId]?.isLoaded === true) {
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

    public refreshSessions = async () => {
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

        return await fetchAndApplyAutomationRuns({
            credentials: this.credentials,
            automationId,
            limit,
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
        await fetchAndApplyArtifactsList({
            credentials: this.credentials,
            encryption: this.encryption,
            artifactDataKeys: this.artifactDataKeys,
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
                storage.getState().replaceMachineDisplays(machines);
            },
            machineDisplayHydrationConcurrencyLimit: this.syncTuning.machineDisplayHydrationConcurrencyLimit,
            applyMachines: (machines, replace) => {
                if (!shouldContinue()) return;
                storage.getState().applyMachines(machines, replace);
            },
            replace: false,
        });
    }

    private fetchFriends = async () => {
        if (!this.credentials) return;
        await fetchAndApplyFriends({
            credentials: this.credentials,
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
        await fetchTodosEngine({ credentials: this.credentials });
    }

    private fetchAutomations = async () => {
        await fetchAndApplyAutomations({
            credentials: this.credentials,
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
        await fetchAndApplyFeed({
            credentials: this.credentials,
            getFeedItems: () => storage.getState().feedItems,
            getFeedHead: () => storage.getState().feedHead,
            assumeUsers: (userIds) => this.assumeUsers(userIds),
            getUsers: () => storage.getState().users,
            applyFeedItems: (items) => storage.getState().applyFeedItems(items),
            log,
        });
    }

    private syncSettings = async () => {
        if (!this.credentials) return;
        const settingsSyncParams: SyncSettingsParams = {
            credentials: this.credentials,
            encryption: this.encryption,
            pendingSettings: this.pendingSettings,
            settingsSecretsKey: this.settingsSecretsKey,
            settingsSecretsReadKeys: this.settingsSecretsReadKeys,
            clearPendingSettings: () => {
                this.pendingSettings = {};
                savePendingSettings({});
            },
        };
        await syncSettingsEngine(settingsSyncParams);
    }

    private fetchProfile = async () => {
        if (!this.credentials) return;
        await fetchAndApplyProfile({
            credentials: this.credentials,
            applyProfile: (profile) => storage.getState().applyProfile(profile),
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
        await syncPurchasesEngine({
            serverID: this.serverID,
            revenueCatInitialized: this.revenueCatInitialized,
            setRevenueCatInitialized: (next) => {
                this.revenueCatInitialized = next;
            },
            applyPurchases: (customerInfo) => storage.getState().applyPurchases(customerInfo),
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

        if (event.type === 'turn_aborted' || event.type === 'task_complete') {
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

    private fetchMessages = async (sessionId: string) => {
        if (this.hasFetchedSessionsSnapshotForActiveServer && !this.isSessionKnownOnResolvedOwnerServer(sessionId)) {
            // Do not fetch messages when we cannot resolve the session to either the active server
            // or a locally known owner server. This avoids cross-server message fetches while keeping
            // the UI state non-destructive during server-switch races.
            if (storage.getState().sessionMessages[sessionId]?.isLoaded !== true) {
                storage.getState().applyMessagesLoaded(sessionId);
            }
            return;
        }

          const session = storage.getState().sessions[sessionId] ?? null;
          const directSessionLink = readDirectSessionLink(session?.metadata);
          const hasLoadedMessages = storage.getState().sessionMessages[sessionId]?.isLoaded === true;
          // IMPORTANT: `session.seq` is a "latest known session message seq" hint (often coming from `/sessions`),
          // not necessarily the last message seq that *this device has materialized*. Using it here can cause gaps.
          const afterSeq = hasLoadedMessages ? (this.sessionMaterializedMaxSeqById[sessionId] ?? 0) : 0;

          const viewport = this.sessionViewport.get(sessionId) ?? null;
          const isPinned = viewport?.isPinned ?? true;
          const offlineForMs = this.lastSocketDisconnectedAtMs ? (Date.now() - this.lastSocketDisconnectedAtMs) : 0;
          const requestMessages = this.createSessionMessagesRequest(sessionId);

          if (directSessionLink) {
              if (!hasLoadedMessages) {
                  await this.fetchDirectSessionMessages(sessionId, directSessionLink);
                  return;
              }

              await this.catchUpDirectSessionMessages(sessionId, directSessionLink);
              return;
          }

          if (!hasLoadedMessages) {
              this.deferredForwardLoadingSessions.delete(sessionId);
              await fetchAndApplyMessages({
                  sessionId,
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
                  log,
              });
              return;
          }

            const decision = decideMessageCatchUpPolicy({
                isForeground: this.isForeground && !this.pauseController.isPaused(),
                isSessionVisible: true,
                isPinned,
                materializedMaxSeq: afterSeq,
                sessionSeqHint: session?.seq ?? 0,
                offlineForMs,
                thresholds: {
                    largeGapSeq: this.syncTuning.messageLargeGapSeq,
                    maxIncrementalPagesOnResume: this.syncTuning.messageMaxIncrementalPagesOnResume,
                    forceSnapshotOfflineMs: this.syncTuning.messageForceSnapshotOfflineMs,
                },
            });

          await applyMessageCatchUpDecision({
              decision,
              afterSeq,
              onIncrementalExhausted: isPinned ? 'tail_reset_latest_page' : 'defer_forward_loading',
              fetchNewerPage: async (cursor) => {
                  const result = await fetchAndApplyNewerMessages({
                      sessionId,
                      afterSeq: cursor,
                      limit: SESSION_MESSAGES_PAGE_SIZE,
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
                      log,
                  });

                  return {
                      messagesCount: result.page.messages.length,
                      nextAfterSeq: result.page.nextAfterSeq ?? null,
                  };
              },
              fetchSnapshotLatestPage: async () => {
                  await fetchAndApplyMessages({
                      sessionId,
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
                      log,
                  });
              },
              resetTranscriptState: () => this.resetSessionTranscriptState(sessionId),
              markLoaded: () => storage.getState().applyMessagesLoaded(sessionId),
              setDeferredForwardLoading: (deferred) => {
                  if (deferred) {
                      this.deferredForwardLoadingSessions.add(sessionId);
                  } else {
                      this.deferredForwardLoadingSessions.delete(sessionId);
                  }
              },
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
          this.directSessionTailCursorBySessionId.delete(sessionId);
      }

      private getDirectSessionServerScope(sessionId: string): string | undefined {
          return resolvePreferredServerIdForSessionId(sessionId);
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
              this.directSessionTailCursorBySessionId.set(sessionId, page.tailCursor);
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

          this.directSessionTailCursorBySessionId.set(sessionId, tail.nextCursor ?? null);
      }

      private async catchUpDirectSessionMessages(
          sessionId: string,
          directSessionLink: ReturnType<typeof readDirectSessionLink> extends infer T ? Exclude<T, null> : never,
      ): Promise<void> {
          const shouldContinue = this.createServerScopeGuard();
          const cursor = this.directSessionTailCursorBySessionId.get(sessionId) ?? 'tail';
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
              this.resetSessionTranscriptState(sessionId);
              await this.fetchDirectSessionMessages(sessionId, directSessionLink);
              return;
          }

          const normalizedMessages = normalizeDirectTranscriptMessages(tail.items);
          if (normalizedMessages.length > 0) {
              this.applyMessages(sessionId, normalizedMessages, { notifyVoice: false });
          }
          this.directSessionTailCursorBySessionId.set(sessionId, tail.nextCursor ?? null);
      }

      private async loadOlderMessagesForChain(params: Readonly<{
          sessionId: string;
          scope: SessionMessagesScope;
          sidechainId?: string | null;
          beforeSeqOverride?: number;
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
                      const page = await machineDirectSessionTranscriptPage({
                          machineId: directSessionLink.machineId,
                          providerId: directSessionLink.providerId,
                          remoteSessionId: directSessionLink.remoteSessionId,
                          source: directSessionLink.source,
                          direction: 'older',
                          cursor,
                      }, { serverId: this.getDirectSessionServerScope(params.sessionId) });
                      if (!shouldContinue()) {
                          return { loaded: 0, hasMore: knownHasMore ?? true, status: 'not_ready' };
                      }

                      if (!page.ok) {
                          throw new Error(page.error);
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
          if (knownHasMore === false) {
              return { loaded: 0, hasMore: false, status: 'no_more' };
          }

          const supported = this.sessionMessagesPaginationSupportedByKey.get(pagingKey);
          if (supported === false) {
              return { loaded: 0, hasMore: false, status: 'no_more' };
          }

          const normalizedBeforeSeqOverride =
              typeof params.beforeSeqOverride === 'number' && Number.isFinite(params.beforeSeqOverride)
                  ? Math.max(1, Math.trunc(params.beforeSeqOverride))
                  : null;

          const beforeSeq = normalizedBeforeSeqOverride ?? this.sessionMessagesBeforeSeqByKey.get(pagingKey) ?? null;
          if (!beforeSeq) {
              // Pagination state is initialized during the initial `/messages` fetch. If we haven't
              // seen it yet, don't permanently disable pagination on the UI side.
              return { loaded: 0, hasMore: knownHasMore ?? true, status: 'not_ready' };
          }

          this.sessionMessagesLoadingOlderByKey.add(pagingKey);
          const requestMessages = this.createSessionMessagesRequest(params.sessionId);
          try {
              const result = await fetchAndApplyOlderMessages({
                  sessionId: params.sessionId,
                  beforeSeq,
                  limit: SESSION_MESSAGES_PAGE_SIZE,
                  scope: params.scope,
                  sidechainId: params.sidechainId ?? null,
                  getSessionEncryption: (id) => this.encryption.getSessionEncryption(id),
                  isSessionKnown: (id) => this.isSessionKnownOnResolvedOwnerServer(id),
                  request: requestMessages,
                  sessionReceivedMessages: this.sessionReceivedMessages,
                  applyMessages: (sid, messages) => this.applyMessages(sid, messages, { notifyVoice: false }),
                  log,
              });

              if (result.page.messages.length === 0) {
                  this.sessionMessagesHasMoreOlderByKey.set(pagingKey, false);
                  return { loaded: 0, hasMore: false, status: 'no_more' };
              }

              this.updateSessionMessagesPaginationFromPage(
                  params.sessionId,
                  { scope: params.scope, sidechainId: params.sidechainId ?? null },
                  result.page,
                  { allowHasMoreInference: true },
              );

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
          }
      }

      public async loadOlderMessages(sessionId: string): Promise<{
          loaded: number;
          hasMore: boolean;
          status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
      }> {
          return this.loadOlderMessagesForChain({ sessionId, scope: 'main' });
      }

      public async loadOlderMessagesFromCursor(sessionId: string, beforeSeq: number): Promise<{
          loaded: number;
          hasMore: boolean;
          status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
      }> {
          return this.loadOlderMessagesForChain({ sessionId, scope: 'main', beforeSeqOverride: beforeSeq });
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
          try {
              await fetchAndApplyMessages({
                  sessionId: normalizedSessionId,
                  scope: 'sidechain',
                  sidechainId: normalizedSidechainId,
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

        public async loadOlderMessagesForkAware(childSessionId: string): Promise<{
            loaded: number;
            hasMore: boolean;
            status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
        }> {
            const fork = getForkedTranscriptSnapshotCached(storage.getState() as any, childSessionId);
            if (!fork) return this.loadOlderMessages(childSessionId);

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

            const result =
                request.kind === 'loadOlderFromCursor'
                    ? await this.loadOlderMessagesFromCursor(request.sessionId, request.beforeSeq)
                    : await this.loadOlderMessages(request.sessionId);

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
         * Prefetch fork ancestor context so forked transcripts can render immediately after:
         * - hard refresh / deep link directly into the child session
         * - storage resets where only the child session transcript has been fetched
         *
         * This does NOT materialize/copy messages into the child session. It only loads the relevant
         * ancestor session pages into the local cache (bounded by each segment's cutoff).
         */
        public async prefetchForkedTranscriptContext(childSessionId: string): Promise<void> {
            const fork = getForkedTranscriptSnapshotCached(storage.getState() as any, childSessionId);
            if (!fork) return;

            const missingSegments = fork.segments.filter((seg) =>
                seg.isReadOnlyContext === true &&
                typeof seg.cutoffSeqInclusive === 'number' &&
                Number.isFinite(seg.cutoffSeqInclusive) &&
                seg.cutoffSeqInclusive >= 0 &&
                (seg.messageIdsOldestFirst?.length ?? 0) === 0
            );
            if (missingSegments.length === 0) return;

            for (const seg of missingSegments) {
                const cutoff = Math.max(0, Math.trunc(seg.cutoffSeqInclusive as number));
                await this.loadOlderMessagesFromCursor(seg.sessionId, cutoff + 1).catch(() => {});
            }
        }

      public onSessionViewportChange(sessionId: string, state: { isPinned: boolean; offsetY: number }): void {
          if (!sessionId) return;
          this.sessionViewport.set(sessionId, { isPinned: state.isPinned === true, offsetY: state.offsetY, lastUpdatedAt: Date.now() });
      }

      public hasDeferredNewerMessages(sessionId: string): boolean {
          return this.deferredForwardLoadingSessions.has(sessionId);
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
          const requestMessages = this.createSessionMessagesRequest(sessionId);
          try {
              const result = await fetchAndApplyNewerMessages({
                  sessionId,
                  afterSeq,
                  limit: SESSION_MESSAGES_PAGE_SIZE,
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
	                  }
	                  this.lastSocketDisconnectedAtMs = null;
	                  return;
	              }
	              if (status === 'disconnected' || status === 'error') {
	                  if (this.lastSocketDisconnectedAtMs == null) {
	                      this.lastSocketDisconnectedAtMs = Date.now();
	                  }
	              }
	          });

          // Subscribe to connection state changes
          apiSocket.onReconnected(() => {
              fireAndForget(this.resumeSync('socket-reconnect'), { tag: 'Sync.resumeSync.socket-reconnect' });
          });
      }

      private resetSessionTranscriptState(sessionId: string): void {
          storage.getState().resetSessionMessages(sessionId);

          this.sessionReceivedMessages.delete(sessionId);
          this.deleteSessionMessagesPaginationStateForSession(sessionId);
          this.deferredForwardLoadingSessions.delete(sessionId);

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

    private scheduleChangesCursorFlush(): void {
        this.changesCursorDirty = true;
        if (this.changesCursorFlushTimer) return;
        this.changesCursorFlushTimer = setTimeout(() => {
            this.changesCursorFlushTimer = null;
            if (!this.changesCursorDirty) return;
            this.changesCursorDirty = false;
            if (this.changesCursor) {
                saveChangesCursor(this.changesCursor, this.getChangesCursorScope());
            }
        }, 750);
    }

    private flushChangesCursorNow(): void {
        if (this.changesCursorFlushTimer) {
            clearTimeout(this.changesCursorFlushTimer);
            this.changesCursorFlushTimer = null;
        }
        if (!this.changesCursorDirty) return;
        this.changesCursorDirty = false;
        if (this.changesCursor) {
            saveChangesCursor(this.changesCursor, this.getChangesCursorScope());
        }
    }

      private async resumeViaChanges(opts: { accountId: string }): Promise<'ok' | 'fallback'> {
          const CHANGES_PAGE_LIMIT = this.syncTuning.changesPageLimit;
          const afterCursor = this.changesCursor ?? '0';

          const offlineForMs = this.lastSocketDisconnectedAtMs ? (Date.now() - this.lastSocketDisconnectedAtMs) : 0;
          const forceSnapshotRefresh = offlineForMs >= this.syncTuning.messageForceSnapshotOfflineMs;

          const catchUp = await runSocketReconnectCatchUpViaChanges({
              credentials: this.credentials,
              accountId: opts.accountId,
              afterCursor,
              changesPageLimit: CHANGES_PAGE_LIMIT,
              forceSnapshotRefresh,
                fetchChanges,
                snapshotRefresh: async () => {
                    await this.snapshotRefreshOnResume({ mode: 'long-offline', reason: 'snapshot-refresh' });
                },
                applyPlanned: async (planned) => {
                    await applyPlannedChangeActions({
                        planned,
                        credentials: this.credentials,
                        isSessionMessagesLoaded: (sessionId) => storage.getState().sessionMessages[sessionId]?.isLoaded === true,
                        invalidate: {
                            settings: () => this.settingsSync.invalidateAndAwait(),
                            profile: () => this.profileSync.invalidateAndAwait(),
                            machines: () => this.machinesSync.invalidateAndAwait(),
                            artifacts: () => this.artifactsSync.invalidateAndAwait(),
                            friends: () => this.friendsSync.invalidateAndAwait(),
                            friendRequests: () => this.friendRequestsSync.invalidateAndAwait(),
                            feed: () => this.feedSync.invalidateAndAwait(),
                            automations: () => this.automationsSync.invalidateAndAwait(),
                            sessions: () => this.sessionsSync.invalidateAndAwait(),
                            todos: () => this.todosSync.invalidateAndAwait(),
                        },
                        invalidateMessagesForSession: (sessionId) => this.getOrCreateMessagesSync(sessionId).invalidateAndAwait(),
                        invalidateScmStatusForSession: (sessionId) => scmStatusSync.invalidate(sessionId),
                        applyTodoSocketUpdates: (changes) => this.applyTodoSocketUpdates(changes),
                        kvBulkGet,
                        concurrencyLimit: this.syncTuning.resumeConcurrencyLimit,
                    });
                },
            });

          if (catchUp.status === 'fallback') {
              return 'fallback';
          }

          if (catchUp.shouldPersistCursor) {
              this.changesCursor = catchUp.nextCursor;
              if (catchUp.flushCursorNow) {
                  this.changesCursorDirty = true;
                  this.flushChangesCursorNow();
              } else {
                  this.scheduleChangesCursorFlush();
              }
          }

          return 'ok';
      }

    private handleUpdate = async (update: unknown) => {
          await handleSocketUpdate({
              update,
              encryption: this.encryption,
              artifactDataKeys: this.artifactDataKeys,
              applySessions: (sessions) => this.applySessions(sessions),
              fetchSessions: () => {
                  fireAndForget(this.fetchSessions(), { tag: 'Sync.handleUpdate.fetchSessions' });
              },
              applyMessages: (sessionId, messages) => this.applyMessages(sessionId, messages),
                onSessionVisible: (sessionId) => this.onSessionVisible(sessionId),
                isSessionMessagesLoaded: (sessionId) => storage.getState().sessionMessages[sessionId]?.isLoaded === true,
                getSessionMaterializedMaxSeq: (sessionId) => this.sessionMaterializedMaxSeqById[sessionId] ?? 0,
              markSessionMaterializedMaxSeq: (sessionId, seq) => this.markSessionMaterializedMaxSeq(sessionId, seq),
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

    private flushActivityUpdates = (updates: Map<string, ApiEphemeralActivityUpdate>) => {
        flushActivityUpdatesEngine({ updates, applySessions: (sessions) => this.applySessions(sessions) });
    }

    private flushMachineActivityUpdates = (updates: Map<string, MachineActivityUpdate>) => {
        flushMachineActivityUpdatesEngine({ updates, applyMachines: (machines) => storage.getState().applyMachines(machines) });
    }

    private handleEphemeralUpdate = (update: unknown) => {
        handleEphemeralSocketUpdate({
            update,
            addActivityUpdate: (ephemeralUpdate) => {
                this.activityAccumulator.addUpdate(ephemeralUpdate);
            },
            addMachineActivityUpdate: (machineUpdate) => {
                this.machineActivityAccumulator.addUpdate(machineUpdate);
            },
        });
    }

    //
    // Apply store
    //

    private applyMessages = (
        sessionId: string,
        messages: NormalizedMessage[],
        options?: { notifyVoice?: boolean }
    ) => {
        const result = storage.getState().applyMessages(sessionId, messages);
        const notifyVoice = options?.notifyVoice !== false;
        if (notifyVoice) {
            let m: Message[] = [];
            for (let messageId of result.changed) {
                const message = storage.getState().sessionMessages[sessionId].messagesMap[messageId];
                if (message) {
                    m.push(message);
                }
            }
            if (m.length > 0) {
                voiceHooks.onMessages(sessionId, m);
            }
            if (result.hasReadyEvent) {
                voiceHooks.onReady(sessionId, m);
                notifyActivityReady(sessionId, m);
            }
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
        this.sessionMaterializedMaxSeqFlushTimer = setTimeout(() => {
            this.sessionMaterializedMaxSeqFlushTimer = null;
            this.flushSessionMaterializedMaxSeq();
        }, 2_000);
    }

    private flushSessionMaterializedMaxSeq(): void {
        if (this.sessionMaterializedMaxSeqFlushTimer) {
            clearTimeout(this.sessionMaterializedMaxSeqFlushTimer);
            this.sessionMaterializedMaxSeqFlushTimer = null;
        }
        if (!this.sessionMaterializedMaxSeqDirty) return;
        this.sessionMaterializedMaxSeqDirty = false;
        saveSessionMaterializedMaxSeqById(this.sessionMaterializedMaxSeqById);
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

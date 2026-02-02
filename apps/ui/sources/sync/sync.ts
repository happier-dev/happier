import Constants from 'expo-constants';
import { apiSocket } from '@/sync/apiSocket';
import { AuthCredentials } from '@/auth/tokenStorage';
import { Encryption } from '@/sync/encryption/encryption';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { storage } from './storage';
import { ApiMessage } from './apiTypes';
import type { ApiEphemeralActivityUpdate } from './apiTypes';
import { Session, Machine, type Metadata } from './storageTypes';
import { InvalidateSync } from '@/utils/sync';
import { ActivityUpdateAccumulator } from './reducer/activityUpdateAccumulator';
import { randomUUID } from '@/platform/randomUUID';
import { Platform, AppState } from 'react-native';
import { isRunningOnMac } from '@/utils/platform';
import { NormalizedMessage, normalizeRawMessage, RawRecord } from './typesRaw';
import { applySettings, Settings, settingsDefaults, settingsParse, SUPPORTED_SCHEMA_VERSION } from './settings';
import { Profile } from './profile';
import {
    loadPendingSettings,
    savePendingSettings,
    loadSessionMaterializedMaxSeqById,
    saveSessionMaterializedMaxSeqById,
    loadChangesCursor,
    saveChangesCursor,
} from './persistence';
import { initializeTracking, tracking } from '@/track';
import { parseToken } from '@/utils/parseToken';
import { RevenueCat } from './revenueCat';
import { trackPaywallPresented, trackPaywallPurchased, trackPaywallCancelled, trackPaywallRestored, trackPaywallError } from '@/track';
import { getServerUrl } from './serverConfig';
import { config } from '@/config';
import { log } from '@/log';
import { gitStatusSync } from './gitStatusSync';
import { projectManager } from './projectManager';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import { Message } from './typesMessage';
import { EncryptionCache } from './encryption/encryptionCache';
import { systemPrompt } from './prompt/systemPrompt';
import { nowServerMs } from './time';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog';
import { computePendingActivityAt } from './unread';
import { computeNextReadStateV1 } from './readStateV1';
import { updateSessionMetadataWithRetry as updateSessionMetadataWithRetryRpc, type UpdateMetadataAck } from './updateSessionMetadataWithRetry';
import type { DecryptedArtifact } from './artifactTypes';
import { getFriendsList, getUserProfile } from './apiFriends';
import { kvBulkGet } from './apiKv';
import { FeedItem } from './feedTypes';
import { UserProfile } from './friendTypes';
import { buildOutgoingMessageMeta } from './messageMeta';
import { HappyError } from '@/utils/errors';
import { dbgSettings, isSettingsSyncDebugEnabled, summarizeSettings, summarizeSettingsDelta } from './debugSettings';
import { deriveSettingsSecretsKey, decryptSecretValue, encryptSecretString, sealSecretsDeep } from './secretSettings';
import { didControlReturnToMobile } from './controlledByUserTransitions';
import { chooseSubmitMode } from './submitMode';
import type { SavedSecret } from './settings';
import { scheduleDebouncedPendingSettingsFlush } from './engine/pendingSettings';
import { applySettingsLocalDelta, syncSettings as syncSettingsEngine } from './engine/settings';
import { getOfferings as getOfferingsEngine, presentPaywall as presentPaywallEngine, purchaseProduct as purchaseProductEngine, syncPurchases as syncPurchasesEngine } from './engine/purchases';
import { fetchChanges } from './apiChanges';
import {
    createArtifactViaApi,
    fetchAndApplyArtifactsList,
    fetchArtifactWithBodyFromApi,
    handleDeleteArtifactSocketUpdate,
    handleNewArtifactSocketUpdate,
    handleUpdateArtifactSocketUpdate,
    updateArtifactViaApi,
} from './engine/artifacts';
import { fetchAndApplyFeed, handleNewFeedPostUpdate, handleRelationshipUpdatedSocketUpdate, handleTodoKvBatchUpdate } from './engine/feed';
import { fetchAndApplyProfile, handleUpdateAccountSocketUpdate, registerPushTokenIfAvailable } from './engine/account';
import { buildMachineFromMachineActivityEphemeralUpdate, buildUpdatedMachineFromSocketUpdate, fetchAndApplyMachines } from './engine/machines';
import { applyTodoSocketUpdates as applyTodoSocketUpdatesEngine, fetchTodos as fetchTodosEngine } from './engine/todos';
import { planSyncActionsFromChanges } from './changesPlanner';
import { applyPlannedChangeActions } from './changesApplier';
import { runSocketReconnectCatchUpViaChanges } from './socketReconnectViaChanges';
import { socketEmitWithAckFallback } from './engine/socketEmitWithAckFallback';
import {
    buildUpdatedSessionFromSocketUpdate,
    fetchAndApplySessions,
    fetchAndApplyMessages,
    fetchAndApplyNewerMessages,
    fetchAndApplyOlderMessages,
    fetchAndApplyPendingMessages as fetchAndApplyPendingMessagesEngine,
    handleDeleteSessionSocketUpdate,
    handleNewMessageSocketUpdate,
    enqueuePendingMessage as enqueuePendingMessageEngine,
    updatePendingMessage as updatePendingMessageEngine,
    deletePendingMessage as deletePendingMessageEngine,
    discardPendingMessage as discardPendingMessageEngine,
    restoreDiscardedPendingMessage as restoreDiscardedPendingMessageEngine,
    deleteDiscardedPendingMessage as deleteDiscardedPendingMessageEngine,
    repairInvalidReadStateV1 as repairInvalidReadStateV1Engine,
} from './engine/sessions';
import {
    flushActivityUpdates as flushActivityUpdatesEngine,
    handleEphemeralSocketUpdate,
    handleSocketReconnected,
    handleSocketUpdate,
    parseUpdateContainer,
} from './engine/socket';

const SESSION_MESSAGES_PAGE_SIZE = 150;

class Sync {
    // Spawned agents (especially in spawn mode) can take noticeable time to connect.
    private static readonly SESSION_READY_TIMEOUT_MS = 10000;
    private static readonly LONG_OFFLINE_SNAPSHOT_MS = 30 * 60 * 1000;

    encryption!: Encryption;
    serverID!: string;
    anonID!: string;
    private credentials!: AuthCredentials;
    public encryptionCache = new EncryptionCache();
    private sessionsSync: InvalidateSync;
    private messagesSync = new Map<string, InvalidateSync>();
    private sessionReceivedMessages = new Map<string, Set<string>>();
    private sessionMessagesBeforeSeq = new Map<string, number>();
    private sessionMessagesHasMoreOlder = new Map<string, boolean>();
    private sessionMessagesLoadingOlder = new Set<string>();
    private sessionMessagesPaginationSupported = new Map<string, boolean>();
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
    private activityAccumulator: ActivityUpdateAccumulator;
    private pendingSettings: Partial<Settings> = loadPendingSettings();
    private pendingSettingsFlushTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingSettingsDirty = false;
    private sessionMaterializedMaxSeqById: Record<string, number> = loadSessionMaterializedMaxSeqById();
    private sessionMaterializedMaxSeqFlushTimer: ReturnType<typeof setTimeout> | null = null;
    private sessionMaterializedMaxSeqDirty = false;
    private changesCursor: string | null = loadChangesCursor();
    private changesCursorFlushTimer: ReturnType<typeof setTimeout> | null = null;
    private changesCursorDirty = false;
    private changesSyncInFlight: Promise<void> | null = null;
    private lastSocketDisconnectedAtMs: number | null = null;
    revenueCatInitialized = false;
    private settingsSecretsKey: Uint8Array | null = null;

    // Generic locking mechanism
    private recalculationLockCount = 0;
    private lastRecalculationTime = 0;
    private machinesRefreshInFlight: Promise<void> | null = null;
    private lastMachinesRefreshAt = 0;

    constructor() {
        dbgSettings('Sync.constructor: loaded pendingSettings', {
            pendingKeys: Object.keys(this.pendingSettings).sort(),
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

        this.sessionsSync = new InvalidateSync(this.fetchSessions, { onError, onSuccess, onRetry });
        this.settingsSync = new InvalidateSync(this.syncSettings, { onError, onSuccess, onRetry });
        this.profileSync = new InvalidateSync(this.fetchProfile, { onError, onSuccess, onRetry });
        this.purchasesSync = new InvalidateSync(this.syncPurchases, { onError, onSuccess, onRetry });
        this.machinesSync = new InvalidateSync(this.fetchMachines, { onError, onSuccess, onRetry });
        this.nativeUpdateSync = new InvalidateSync(this.fetchNativeUpdate);
        this.artifactsSync = new InvalidateSync(this.fetchArtifactsList);
        this.friendsSync = new InvalidateSync(this.fetchFriends);
        this.friendRequestsSync = new InvalidateSync(this.fetchFriendRequests);
        this.feedSync = new InvalidateSync(this.fetchFeed);
        this.todosSync = new InvalidateSync(this.fetchTodos);

        const registerPushToken = async () => {
            if (__DEV__) {
                return;
            }
            await this.registerPushToken();
        }
        this.pushTokenSync = new InvalidateSync(registerPushToken);
        this.activityAccumulator = new ActivityUpdateAccumulator(this.flushActivityUpdates.bind(this), 2000);

        // Listen for app state changes to refresh purchases
        AppState.addEventListener('change', (nextAppState) => {
            if (nextAppState === 'active') {
                log.log('📱 App became active');
                this.purchasesSync.invalidate();
                this.profileSync.invalidate();
                this.machinesSync.invalidate();
                this.pushTokenSync.invalidate();
                this.sessionsSync.invalidate();
                this.nativeUpdateSync.invalidate();
                log.log('📱 App became active: Invalidating artifacts sync');
                this.artifactsSync.invalidate();
                this.friendsSync.invalidate();
                this.friendRequestsSync.invalidate();
                this.feedSync.invalidate();
                this.todosSync.invalidate();
            } else {
                log.log(`📱 App state changed to: ${nextAppState}`);
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
            }
        });
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
        // Derive a stable per-account key for field-level secret settings.
        // This is separate from the outer settings blob encryption.
        try {
            const secretKey = decodeBase64(credentials.secret, 'base64url');
            if (secretKey.length === 32) {
                this.settingsSecretsKey = await deriveSettingsSecretsKey(secretKey);
            }
        } catch {
            this.settingsSecretsKey = null;
        }
        await this.#init();

        // Await settings sync to have fresh settings
        await this.settingsSync.awaitQueue();

        // Await profile sync to have fresh profile
        await this.profileSync.awaitQueue();

        // Await purchases sync to have fresh purchases
        await this.purchasesSync.awaitQueue();
    }

    async restore(credentials: AuthCredentials, encryption: Encryption) {
        // NOTE: No awaiting anything here, we're restoring from a disk (ie app restarted)
        // Purchases sync is invalidated in #init() and will complete asynchronously
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        try {
            const secretKey = decodeBase64(credentials.secret, 'base64url');
            if (secretKey.length === 32) {
                this.settingsSecretsKey = await deriveSettingsSecretsKey(secretKey);
            }
        } catch {
            this.settingsSecretsKey = null;
        }
        await this.#init();
    }

    /**
     * Encrypt a secret value into an encrypted-at-rest container.
     * Used for transient persistence (e.g. local drafts) where plaintext must never be stored.
     */
    public encryptSecretValue(value: string): import('./secretSettings').SecretString | null {
        const v = typeof value === 'string' ? value.trim() : '';
        if (!v) return null;
        if (!this.settingsSecretsKey) return null;
        return { _isSecretValue: true, encryptedValue: encryptSecretString(v, this.settingsSecretsKey) };
    }

    /**
     * Generic secret-string decryption helper for settings-like objects.
     * Prefer this over adding per-field helpers unless a field needs special handling.
     */
    public decryptSecretValue(input: import('./secretSettings').SecretString | null | undefined): string | null {
        return decryptSecretValue(input, this.settingsSecretsKey);
    }

    async #init() {

        // Subscribe to updates
        this.subscribeToUpdates();

        // Sync initial PostHog opt-out state with stored settings
        if (tracking) {
            const currentSettings = storage.getState().settings;
            if (currentSettings.analyticsOptOut) {
                tracking.optOut();
            } else {
                tracking.optIn();
            }
        }

        // Invalidate sync
        log.log('🔄 #init: Invalidating all syncs');
        this.sessionsSync.invalidate();
        this.settingsSync.invalidate();
        this.profileSync.invalidate();
        this.purchasesSync.invalidate();
        this.machinesSync.invalidate();
        this.pushTokenSync.invalidate();
        this.nativeUpdateSync.invalidate();
        this.friendsSync.invalidate();
        this.friendRequestsSync.invalidate();
        this.artifactsSync.invalidate();
        this.feedSync.invalidate();
        this.todosSync.invalidate();
        log.log('🔄 #init: All syncs invalidated, including artifacts and todos');

        // Wait for both sessions and machines to load, then mark as ready
        Promise.all([
            this.sessionsSync.awaitQueue(),
            this.machinesSync.awaitQueue()
        ]).then(() => {
            storage.getState().applyReady();
        }).catch((error) => {
            console.error('Failed to load initial data:', error);
        });
    }


    onSessionVisible = (sessionId: string) => {
        let ex = this.messagesSync.get(sessionId);
        if (!ex) {
            ex = new InvalidateSync(() => this.fetchMessages(sessionId));
            this.messagesSync.set(sessionId, ex);
        }
        ex.invalidate();

        // Also invalidate git status sync for this session
        gitStatusSync.getSync(sessionId).invalidate();

        // Notify voice assistant about session visibility
        const session = storage.getState().sessions[sessionId];
        if (session) {
            voiceHooks.onSessionFocus(sessionId, session.metadata || undefined);
        }
    }


    async sendMessage(sessionId: string, text: string, displayText?: string) {
        storage.getState().markSessionOptimisticThinking(sessionId);

        // Get encryption
        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) { // Should never happen
            storage.getState().clearSessionOptimisticThinking(sessionId);
            console.error(`Session ${sessionId} not found`);
            return;
        }

        // Get session data from storage
        const session = storage.getState().sessions[sessionId];
        if (!session) {
            storage.getState().clearSessionOptimisticThinking(sessionId);
            console.error(`Session ${sessionId} not found in storage`);
            return;
        }

        try {
            // Read permission mode from session state
            const permissionMode = session.permissionMode || 'default';
            
            // Read model mode - default is agent-specific (Gemini needs an explicit default)
            const flavor = session.metadata?.flavor;
            const agentId = resolveAgentIdFromFlavor(flavor);
            const modelMode = session.modelMode || (agentId ? getAgentCore(agentId).model.defaultMode : 'default');

            // Generate local ID
            const localId = randomUUID();

            // Determine sentFrom based on platform
            let sentFrom: string;
            if (Platform.OS === 'web') {
                sentFrom = 'web';
            } else if (Platform.OS === 'android') {
                sentFrom = 'android';
            } else if (Platform.OS === 'ios') {
                // Check if running on Mac (Catalyst or Designed for iPad on Mac)
                if (isRunningOnMac()) {
                    sentFrom = 'mac';
                } else {
                    sentFrom = 'ios';
                }
            } else {
                sentFrom = 'web'; // fallback
            }

            const model = agentId && getAgentCore(agentId).model.supportsSelection && modelMode !== 'default' ? modelMode : undefined;
            // Create user message content with metadata
            const content: RawRecord = {
                role: 'user',
                content: {
                    type: 'text',
                    text
                },
                meta: buildOutgoingMessageMeta({
                    sentFrom,
                    permissionMode: permissionMode || 'default',
                    model,
                    appendSystemPrompt: systemPrompt,
                    displayText,
                })
            };
            const encryptedRawRecord = await encryption.encryptRawRecord(content);

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

            const ready = await this.waitForAgentReady(sessionId);
            if (!ready) {
                log.log(`Session ${sessionId} not ready after timeout, sending anyway`);
            }

            type MessageAck =
                | { ok: true; id: string; seq: number; localId: string | null }
                | { ok: false; error: string };

            const payload = {
                sid: sessionId,
                message: encryptedRawRecord,
                localId,
                sentFrom,
                permissionMode: permissionMode || 'default'
            };

            const ack = await socketEmitWithAckFallback<MessageAck>({
                emitWithAck: (event, payload, opts) => apiSocket.emitWithAck<MessageAck>(event, payload, opts),
                send: (event, payload) => apiSocket.send(event, payload),
                event: 'message',
                payload,
                timeoutMs: 7_500,
                onNoAck: () => this.schedulePendingMessageCommitRetry({ sessionId, localId }),
            });

            if (!ack) return;

            if (ack.ok !== true) {
                storage.getState().removePendingMessage(sessionId, localId);
                throw new Error(ack.error || 'Message send rejected');
            }

            // Message is committed. Remove from pending and insert into the canonical transcript
            // (without waiting for broadcast updates, which can be missed on backgrounded devices).
            storage.getState().removePendingMessage(sessionId, localId);
            const committed = normalizeRawMessage(ack.id, localId, createdAt, content);
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
                    void this.fetchSessions().catch(() => {
                        // best-effort only
                    });

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
                    void run(nextAttempt);
                }, baseDelayMs + jitterMs);
                this.pendingMessageCommitRetryTimers.set(key, timeout);
                return;
            }

            type MessageAck =
                | { ok: true; id: string; seq: number; localId: string | null }
                | { ok: false; error: string };

            const encrypted = await sessionEncryption.encryptRawRecord(pending.rawRecord as RawRecord);
            const payload = {
                sid: params.sessionId,
                message: encrypted,
                localId: params.localId,
                sentFrom: 'retry',
                permissionMode: 'default',
            };

            const ack = await (async () => {
                try {
                    return await apiSocket.emitWithAck<MessageAck>('message', payload, { timeoutMs: 7_500 });
                } catch {
                    return null;
                }
            })();

            if (ack && typeof ack === 'object' && ack.ok === true) {
                storage.getState().removePendingMessage(params.sessionId, params.localId);
                const committed = normalizeRawMessage(ack.id, params.localId, pending.createdAt, pending.rawRecord as RawRecord);
                if (committed) {
                    this.applyMessages(params.sessionId, [committed]);
                }
                this.markSessionMaterializedMaxSeq(params.sessionId, ack.seq);

                const currentSession = storage.getState().sessions[params.sessionId];
                if (currentSession) {
                    this.applySessions([
                        {
                            ...currentSession,
                            updatedAt: nowServerMs(),
                            seq: Math.max(currentSession.seq ?? 0, ack.seq),
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

            if (ack && typeof ack === 'object' && ack.ok === false) {
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
                void run(nextAttempt);
            }, baseDelayMs + jitterMs);
            this.pendingMessageCommitRetryTimers.set(key, timeout);
        };

        const timeout = setTimeout(() => {
            void run(0);
        }, 1_000);
        this.pendingMessageCommitRetryTimers.set(key, timeout);
    }

    async abortSession(sessionId: string): Promise<void> {
        await apiSocket.sessionRPC(sessionId, 'abort', {
            reason: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`
        });
    }

    async submitMessage(sessionId: string, text: string, displayText?: string): Promise<void> {
        const configuredMode = storage.getState().settings.sessionMessageSendMode;
        const session = storage.getState().sessions[sessionId] ?? null;
        const mode = chooseSubmitMode({ configuredMode, session });

        if (mode === 'interrupt') {
            try { await this.abortSession(sessionId); } catch { }
            await this.sendMessage(sessionId, text, displayText);
            return;
        }
        if (mode === 'server_pending') {
            await this.enqueuePendingMessage(sessionId, text, displayText);
            return;
        }
        await this.sendMessage(sessionId, text, displayText);
    }

    private async updateSessionMetadataWithRetry(sessionId: string, updater: (metadata: Metadata) => Metadata): Promise<void> {
        const encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) {
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
                await this.refreshSessions();
            },
            encryptMetadata: async (metadata) => encryption.encryptMetadata(metadata),
            decryptMetadata: async (version, encrypted) => encryption.decryptMetadata(version, encrypted),
            emitUpdateMetadata: async (payload) => apiSocket.emitWithAck<UpdateMetadataAck>('update-metadata', payload),
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
        if (!session?.metadata) return;

        const sessionSeq = opts?.sessionSeq ?? session.seq ?? 0;
        const pendingActivityAt = opts?.pendingActivityAt ?? computePendingActivityAt(session.metadata);
        const existing = session.metadata.readStateV1;
        const existingSeq = existing?.sessionSeq ?? 0;
        const needsRepair = existingSeq > sessionSeq;

        const early = computeNextReadStateV1({
            prev: existing,
            sessionSeq,
            pendingActivityAt,
            now: nowServerMs(),
        });
        if (!needsRepair && !early.didChange) return;

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

    async fetchPendingMessages(sessionId: string): Promise<void> {
        await fetchAndApplyPendingMessagesEngine({ sessionId, encryption: this.encryption });
    }

    async enqueuePendingMessage(sessionId: string, text: string, displayText?: string): Promise<void> {
        await enqueuePendingMessageEngine({
            sessionId,
            text,
            displayText,
            encryption: this.encryption,
            updateSessionMetadataWithRetry: (id, updater) => this.updateSessionMetadataWithRetry(id, updater),
        });
    }

    async updatePendingMessage(sessionId: string, pendingId: string, text: string): Promise<void> {
        await updatePendingMessageEngine({
            sessionId,
            pendingId,
            text,
            encryption: this.encryption,
            updateSessionMetadataWithRetry: (id, updater) => this.updateSessionMetadataWithRetry(id, updater),
        });
    }

    async deletePendingMessage(sessionId: string, pendingId: string): Promise<void> {
        await deletePendingMessageEngine({
            sessionId,
            pendingId,
            updateSessionMetadataWithRetry: (id, updater) => this.updateSessionMetadataWithRetry(id, updater),
        });
    }

    async discardPendingMessage(
        sessionId: string,
        pendingId: string,
        opts?: { reason?: 'switch_to_local' | 'manual' }
    ): Promise<void> {
        await discardPendingMessageEngine({
            sessionId,
            pendingId,
            opts,
            encryption: this.encryption,
            updateSessionMetadataWithRetry: (id, updater) => this.updateSessionMetadataWithRetry(id, updater),
        });
    }

    async restoreDiscardedPendingMessage(sessionId: string, pendingId: string): Promise<void> {
        await restoreDiscardedPendingMessageEngine({
            sessionId,
            pendingId,
            encryption: this.encryption,
            updateSessionMetadataWithRetry: (id, updater) => this.updateSessionMetadataWithRetry(id, updater),
        });
    }

    async deleteDiscardedPendingMessage(sessionId: string, pendingId: string): Promise<void> {
        await deleteDiscardedPendingMessageEngine({
            sessionId,
            pendingId,
            encryption: this.encryption,
            updateSessionMetadataWithRetry: (id, updater) => this.updateSessionMetadataWithRetry(id, updater),
        });
    }

    applySettings = (delta: Partial<Settings>) => {
        applySettingsLocalDelta({
            delta,
            settingsSecretsKey: this.settingsSecretsKey,
            getPendingSettings: () => this.pendingSettings,
            setPendingSettings: (next) => {
                this.pendingSettings = next;
            },
            schedulePendingSettingsFlush: () => this.schedulePendingSettingsFlush(),
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
        
        log.log(`👤 Fetching ${missingIds.length} missing users...`);
        
        // Fetch missing users in parallel
        const results = await Promise.all(
            missingIds.map(async (id) => {
                try {
                    const profile = await getUserProfile(this.credentials!, id);
                    return { id, profile };  // profile is null if 404
                } catch (error) {
                    console.error(`Failed to fetch user ${id}:`, error);
                    return { id, profile: null };  // Treat errors as 404
                }
            })
        );
        
        // Convert to Record<string, UserProfile | null>
        const usersMap: Record<string, UserProfile | null> = {};
        results.forEach(({ id, profile }) => {
            usersMap[id] = profile;
        });
        
        storage.getState().applyUsers(usersMap);
        log.log(`👤 Applied ${results.length} users to cache (${results.filter(r => r.profile).length} found, ${results.filter(r => !r.profile).length} not found)`);
    }

    //
    // Private
    //

    private fetchSessions = async () => {
        if (!this.credentials) return;
        await fetchAndApplySessions({
            credentials: this.credentials,
            encryption: this.encryption,
            sessionDataKeys: this.sessionDataKeys,
            applySessions: (sessions) => this.applySessions(sessions),
            repairInvalidReadStateV1: (params) => this.repairInvalidReadStateV1(params),
            log,
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
        this.sessionsSync.invalidate();
        this.settingsSync.invalidate();
        this.profileSync.invalidate();
        this.machinesSync.invalidate();
        this.purchasesSync.invalidate();
        this.artifactsSync.invalidate();
        this.friendsSync.invalidate();
        this.friendRequestsSync.invalidate();
        this.feedSync.invalidate();
        this.todosSync.invalidate();
    }

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

    private fetchMachines = async () => {
        if (!this.credentials) return;

        await fetchAndApplyMachines({
            credentials: this.credentials,
            encryption: this.encryption,
            machineDataKeys: this.machineDataKeys,
            applyMachines: (machines, replace) => storage.getState().applyMachines(machines, replace),
        });
    }

    private fetchFriends = async () => {
        if (!this.credentials) return;
        
        try {
            log.log('👥 Fetching friends list...');
            const friendsList = await getFriendsList(this.credentials);
            storage.getState().applyFriends(friendsList);
            log.log(`👥 fetchFriends completed - processed ${friendsList.length} friends`);
        } catch (error) {
            console.error('Failed to fetch friends:', error);
            // Silently handle error - UI will show appropriate state
        }
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
        await syncSettingsEngine({
            credentials: this.credentials,
            encryption: this.encryption,
            pendingSettings: this.pendingSettings,
            clearPendingSettings: () => {
                this.pendingSettings = {};
                savePendingSettings({});
            },
        });
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

            const serverUrl = getServerUrl();

            // Get platform and app identifiers
            const platform = Platform.OS;
            const version = Constants.expoConfig?.version!;
            const appId = (Platform.OS === 'ios' ? Constants.expoConfig?.ios?.bundleIdentifier! : Constants.expoConfig?.android?.package!);

            const response = await fetch(`${serverUrl}/v1/version`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    platform,
                    version,
                    app_id: appId,
                }),
            });

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

    private fetchMessages = async (sessionId: string) => {
        const session = storage.getState().sessions[sessionId] ?? null;
        const hasLoadedMessages = storage.getState().sessionMessages[sessionId]?.isLoaded === true;
        // IMPORTANT: `session.seq` is a "latest known session message seq" hint (often coming from `/sessions`),
        // not necessarily the last message seq that *this device has materialized*. Using it here can cause gaps.
        const afterSeq = hasLoadedMessages ? (this.sessionMaterializedMaxSeqById[sessionId] ?? 0) : 0;

        // If we already have a transcript snapshot, prefer incremental catch-up.
        // This avoids refetching the latest page on every visibility ping.
        if (afterSeq > 0) {
            let cursor = afterSeq;
            let pages = 0;
            while (pages < 50) {
                pages += 1;
                const result = await fetchAndApplyNewerMessages({
                    sessionId,
                    afterSeq: cursor,
                    limit: SESSION_MESSAGES_PAGE_SIZE,
                    getSessionEncryption: (id) => this.encryption.getSessionEncryption(id),
                    request: (path) => apiSocket.request(path),
                    sessionReceivedMessages: this.sessionReceivedMessages,
                    applyMessages: (sid, messages) => this.applyMessages(sid, messages),
                    onMessagesPage: (page) => {
                        this.updateSessionMessagesPaginationFromPage(sessionId, page, { allowHasMoreInference: true });
                    },
                    log,
                });

                const next = result.page.nextAfterSeq;
                if (!next) {
                    storage.getState().applyMessagesLoaded(sessionId);
                    return;
                }
                cursor = next;
            }

            // If we hit the page cap, fall back to snapshot refresh for this session.
            // This is a slow-path for extreme offline gaps.
            log.log(`💬 fetchMessages hit catch-up page cap; falling back to snapshot refresh for session ${sessionId}`);
        }

        await fetchAndApplyMessages({
            sessionId,
            getSessionEncryption: (id) => this.encryption.getSessionEncryption(id),
            request: (path) => apiSocket.request(path),
            sessionReceivedMessages: this.sessionReceivedMessages,
            applyMessages: (sid, messages) => this.applyMessages(sid, messages),
            markMessagesLoaded: (sid) => storage.getState().applyMessagesLoaded(sid),
            onMessagesPage: (page) => {
                this.updateSessionMessagesPaginationFromPage(sessionId, page, { allowHasMoreInference: true });
            },
            log,
        });
    }

    public async loadOlderMessages(sessionId: string): Promise<{
        loaded: number;
        hasMore: boolean;
        status: 'loaded' | 'no_more' | 'not_ready' | 'in_flight';
    }> {
        if (this.sessionMessagesLoadingOlder.has(sessionId)) {
            return {
                loaded: 0,
                hasMore: this.sessionMessagesHasMoreOlder.get(sessionId) ?? true,
                status: 'in_flight',
            };
        }

        const knownHasMore = this.sessionMessagesHasMoreOlder.get(sessionId);
        if (knownHasMore === false) {
            return { loaded: 0, hasMore: false, status: 'no_more' };
        }

        const supported = this.sessionMessagesPaginationSupported.get(sessionId);
        if (supported === false) {
            return { loaded: 0, hasMore: false, status: 'no_more' };
        }

        const beforeSeq = this.sessionMessagesBeforeSeq.get(sessionId);
        if (!beforeSeq) {
            // Pagination state is initialized during the initial `/messages` fetch. If we haven't
            // seen it yet, don't permanently disable pagination on the UI side.
            return { loaded: 0, hasMore: knownHasMore ?? true, status: 'not_ready' };
        }

        this.sessionMessagesLoadingOlder.add(sessionId);
        try {
            const result = await fetchAndApplyOlderMessages({
                sessionId,
                beforeSeq,
                limit: SESSION_MESSAGES_PAGE_SIZE,
                getSessionEncryption: (id) => this.encryption.getSessionEncryption(id),
                request: (path) => apiSocket.request(path),
                sessionReceivedMessages: this.sessionReceivedMessages,
                applyMessages: (sid, messages) => this.applyMessages(sid, messages, { notifyVoice: false }),
                log,
            });

            if (result.page.messages.length === 0) {
                this.sessionMessagesHasMoreOlder.set(sessionId, false);
                return { loaded: 0, hasMore: false, status: 'no_more' };
            }

            this.updateSessionMessagesPaginationFromPage(sessionId, result.page, { allowHasMoreInference: true });

            const hasMore = this.sessionMessagesHasMoreOlder.get(sessionId) ?? false;
            if (hasMore === false) {
                return { loaded: result.applied, hasMore: false, status: 'no_more' };
            }

            return { loaded: result.applied, hasMore, status: 'loaded' };
        } catch (error) {
            console.error('Failed to load older messages:', error);
            return { loaded: 0, hasMore: knownHasMore ?? true, status: 'loaded' };
        } finally {
            this.sessionMessagesLoadingOlder.delete(sessionId);
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
            if (status === 'disconnected') {
                this.lastSocketDisconnectedAtMs = Date.now();
            }
        });

        // Subscribe to connection state changes
        apiSocket.onReconnected(() => {
            void this.handleSocketReconnectedViaChanges({
                fallback: () => {
                    handleSocketReconnected({
                        log,
                        invalidateSessions: () => this.sessionsSync.invalidate(),
                        invalidateMachines: () => this.machinesSync.invalidate(),
                        invalidateArtifacts: () => this.artifactsSync.invalidate(),
                        invalidateFriends: () => this.friendsSync.invalidate(),
                        invalidateFriendRequests: () => this.friendRequestsSync.invalidate(),
                        invalidateFeed: () => this.feedSync.invalidate(),
                        getLoadedSessionIdsForMessages: () => {
                            const loadedSessionIds: string[] = []
                            const sessions = storage.getState().sessionMessages
                            for (const sessionId of Object.keys(sessions)) {
                                if (sessions[sessionId]?.isLoaded === true) {
                                    loadedSessionIds.push(sessionId)
                                }
                            }
                            return loadedSessionIds
                        },
                        invalidateMessagesForSession: (sessionId) => this.messagesSync.get(sessionId)?.invalidate(),
                        invalidateGitStatusForSession: (sessionId) => gitStatusSync.invalidate(sessionId),
                    });
                },
            });
        });
    }

    private getOrCreateMessagesSync(sessionId: string): InvalidateSync {
        let ex = this.messagesSync.get(sessionId);
        if (!ex) {
            ex = new InvalidateSync(() => this.fetchMessages(sessionId));
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
                saveChangesCursor(this.changesCursor);
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
            saveChangesCursor(this.changesCursor);
        }
    }

    private async handleSocketReconnectedViaChanges(opts: { fallback: () => void }): Promise<void> {
        if (!this.credentials) {
            opts.fallback();
            return;
        }

        const accountId = storage.getState().profile?.id;
        if (!accountId) {
            opts.fallback();
            return;
        }

        if (this.changesSyncInFlight) {
            await this.changesSyncInFlight.catch(() => {});
            return;
        }

        const p = (async () => {
            const CHANGES_PAGE_LIMIT = 200;
            const afterCursor = this.changesCursor ?? '0';

            const offlineForMs = this.lastSocketDisconnectedAtMs ? (Date.now() - this.lastSocketDisconnectedAtMs) : 0;
            const forceSnapshotRefresh = offlineForMs >= Sync.LONG_OFFLINE_SNAPSHOT_MS;

            const catchUp = await runSocketReconnectCatchUpViaChanges({
                credentials: this.credentials,
                accountId,
                afterCursor,
                changesPageLimit: CHANGES_PAGE_LIMIT,
                forceSnapshotRefresh,
                fetchChanges,
                snapshotRefresh: async () => {
                    // Long-offline snapshot mode: rebuild core lists first, then catch up transcripts.
                    await this.sessionsSync.invalidateAndAwait();

                    // Catch up messages for sessions that have been materialized locally (avoid fetching full
                    // transcripts for every session in the list).
                    const sessionIdsToCatchUp = Array.from(this.messagesSync.keys());
                    for (const sessionId of sessionIdsToCatchUp) {
                        await this.getOrCreateMessagesSync(sessionId).invalidateAndAwait();
                        gitStatusSync.invalidate(sessionId);
                    }

                    // Refresh artifacts/machines after sessions.
                    await Promise.all([
                        this.artifactsSync.invalidateAndAwait(),
                        this.machinesSync.invalidateAndAwait(),
                    ]);

                    // Refresh kv-backed/UI lists last.
                    await Promise.all([
                        this.todosSync.invalidateAndAwait(),
                        this.friendsSync.invalidateAndAwait(),
                        this.friendRequestsSync.invalidateAndAwait(),
                        this.feedSync.invalidateAndAwait(),
                        this.settingsSync.invalidateAndAwait(),
                        this.profileSync.invalidateAndAwait(),
                    ]);
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
                            sessions: () => this.sessionsSync.invalidateAndAwait(),
                            todos: () => this.todosSync.invalidateAndAwait(),
                        },
                        invalidateMessagesForSession: (sessionId) => this.getOrCreateMessagesSync(sessionId).invalidateAndAwait(),
                        invalidateGitStatusForSession: (sessionId) => gitStatusSync.invalidate(sessionId),
                        applyTodoSocketUpdates: (changes) => this.applyTodoSocketUpdates(changes),
                        kvBulkGet,
                    });
                },
            });

            if (catchUp.status === 'fallback') {
                opts.fallback();
                return;
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
        })();

        this.changesSyncInFlight = p;
        try {
            await p;
        } finally {
            this.changesSyncInFlight = null;
        }
    }

    private handleUpdate = async (update: unknown) => {
        await handleSocketUpdate({
            update,
            encryption: this.encryption,
            artifactDataKeys: this.artifactDataKeys,
            applySessions: (sessions) => this.applySessions(sessions),
            fetchSessions: () => {
                void this.fetchSessions();
            },
            applyMessages: (sessionId, messages) => this.applyMessages(sessionId, messages),
            onSessionVisible: (sessionId) => this.onSessionVisible(sessionId),
            isSessionMessagesLoaded: (sessionId) => storage.getState().sessionMessages[sessionId]?.isLoaded === true,
            getSessionMaterializedMaxSeq: (sessionId) => this.sessionMaterializedMaxSeqById[sessionId] ?? 0,
            markSessionMaterializedMaxSeq: (sessionId, seq) => this.markSessionMaterializedMaxSeq(sessionId, seq),
            invalidateMessagesForSession: (sessionId) => {
                const ex = this.messagesSync.get(sessionId);
                if (ex) {
                    ex.invalidate();
                }
            },
            assumeUsers: (userIds) => this.assumeUsers(userIds),
            applyTodoSocketUpdates: (changes) => this.applyTodoSocketUpdates(changes),
            invalidateSessions: () => this.sessionsSync.invalidate(),
            invalidateArtifacts: () => this.artifactsSync.invalidate(),
            invalidateFriends: () => this.friendsSync.invalidate(),
            invalidateFriendRequests: () => this.friendRequestsSync.invalidate(),
            invalidateFeed: () => this.feedSync.invalidate(),
            invalidateTodos: () => this.todosSync.invalidate(),
            log,
        });
    }

    private flushActivityUpdates = (updates: Map<string, ApiEphemeralActivityUpdate>) => {
        flushActivityUpdatesEngine({ updates, applySessions: (sessions) => this.applySessions(sessions) });
    }

    private handleEphemeralUpdate = (update: unknown) => {
        handleEphemeralSocketUpdate({
            update,
            addActivityUpdate: (ephemeralUpdate) => {
                this.activityAccumulator.addUpdate(ephemeralUpdate);
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
                voiceHooks.onReady(sessionId);
            }
        }
    }

    private updateSessionMessagesPaginationFromPage(
        sessionId: string,
        page: { messages: Array<{ seq: number }>; hasMore?: boolean; nextBeforeSeq?: number | null },
        options?: { allowHasMoreInference?: boolean }
    ) {
        if (!Array.isArray(page.messages) || page.messages.length === 0) {
            return;
        }

        const maxSeq = Math.max(...page.messages.map((m) => m.seq));
        if (Number.isFinite(maxSeq)) {
            this.markSessionMaterializedMaxSeq(sessionId, maxSeq);
        }

        const supportsPagination = page.hasMore !== undefined || page.nextBeforeSeq !== undefined;
        if (supportsPagination) {
            this.sessionMessagesPaginationSupported.set(sessionId, true);
        } else if (!this.sessionMessagesPaginationSupported.has(sessionId)) {
            this.sessionMessagesPaginationSupported.set(sessionId, false);
        }

        const prevCursor = this.sessionMessagesBeforeSeq.get(sessionId);
        const minSeq = Math.min(...page.messages.map((m) => m.seq));
        const nextCursorCandidate =
            typeof page.nextBeforeSeq === 'number' ? page.nextBeforeSeq : minSeq;
        const nextCursor = prevCursor === undefined ? nextCursorCandidate : Math.min(prevCursor, nextCursorCandidate);
        this.sessionMessagesBeforeSeq.set(sessionId, nextCursor);

        const prevHasMore = this.sessionMessagesHasMoreOlder.get(sessionId);
        if (typeof page.hasMore === 'boolean') {
            this.sessionMessagesHasMoreOlder.set(sessionId, page.hasMore);
            return;
        }
        if (prevHasMore === false) {
            return;
        }
        if (options?.allowHasMoreInference) {
            const inferredHasMore = page.messages.length >= SESSION_MESSAGES_PAGE_SIZE;
            // If the server doesn't send `hasMore`, treat a short page as a definitive "no more".
            if (!inferredHasMore) {
                this.sessionMessagesHasMoreOlder.set(sessionId, false);
                return;
            }
            if (prevHasMore === undefined) {
                this.sessionMessagesHasMoreOlder.set(sessionId, true);
            }
        }
    }

    private applySessions = (sessions: (Omit<Session, "presence"> & {
        presence?: "online" | number;
    })[]) => {
        const active = storage.getState().getActiveSessions();
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

    /**
     * Waits for the CLI agent to be ready by watching agentStateVersion.
     *
     * When a session is created, agentStateVersion starts at 0. Once the CLI
     * connects and sends its first state update (via updateAgentState()), the
     * version becomes > 0. This serves as a reliable signal that the CLI's
     * WebSocket is connected and ready to receive messages.
     */
    private waitForAgentReady(sessionId: string, timeoutMs: number = Sync.SESSION_READY_TIMEOUT_MS): Promise<boolean> {
        const startedAt = Date.now();

        return new Promise((resolve) => {
            const done = (ready: boolean, reason: string) => {
                clearTimeout(timeout);
                unsubscribe();
                const duration = Date.now() - startedAt;
                log.log(`Session ${sessionId} ${reason} after ${duration}ms`);
                resolve(ready);
            };

            const check = () => {
                const s = storage.getState().sessions[sessionId];
                if (s && s.agentStateVersion > 0) {
                    done(true, `ready (agentStateVersion=${s.agentStateVersion})`);
                }
            };

            const timeout = setTimeout(() => done(false, 'ready wait timed out'), timeoutMs);
            const unsubscribe = storage.subscribe(check);
            check(); // Check current state immediately
        });
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

async function syncInit(credentials: AuthCredentials, restore: boolean) {

    // Initialize sync engine
    const secretKey = decodeBase64(credentials.secret, 'base64url');
    if (secretKey.length !== 32) {
        throw new Error(`Invalid secret key length: ${secretKey.length}, expected 32`);
    }
    const encryption = await Encryption.create(secretKey);

    // Initialize tracking
    initializeTracking(encryption.anonID);

    // Initialize socket connection
    const API_ENDPOINT = getServerUrl();
    apiSocket.initialize({ endpoint: API_ENDPOINT, token: credentials.token }, encryption);

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

import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import axios from 'axios';
import { Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, MessageAckResponseSchema, MessageContent, Metadata, ServerToClientEvents, Session, SessionMessageContentSchema, Update, UserMessage, UserMessageSchema, Usage } from '../types'
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../encryption';
import { backoff } from '@/utils/time';
import { configuration } from '@/configuration';
import type { RawJSONLines } from '@/backends/claude/types';
import { randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import { addDiscardedCommittedMessageLocalIds } from '../queue/discardedCommittedMessageLocalIds';
import { fetchSessionSnapshotUpdateFromServer, shouldSyncSessionSnapshotOnConnect } from './snapshotSync';
import { createSessionScopedSocket, createUserScopedSocket } from './sockets';
import { isToolTraceEnabled, recordAcpToolTraceEventIfNeeded, recordClaudeToolTraceEvents, recordCodexToolTraceEventIfNeeded } from './toolTrace';
import { updateSessionAgentStateWithAck, updateSessionMetadataWithAck } from './stateUpdates';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { calculateCost } from '@/utils/pricing';
import { buildAcpAgentMessageEnvelope, shouldTraceAcpMessageType } from './acpMessageEnvelope';
import { normalizeAcpSessionMessageBody, normalizeCodexSessionMessageBody } from './sessionOutboundMessageNormalization';
import {
    fetchLatestUserPermissionIntentFromEncryptedTranscript,
    fetchRecentTranscriptTextItemsForAcpImportFromServer,
} from './transcriptQueries';
import {
    discardPendingQueueV2Messages,
    listPendingQueueV2LocalIdsFromServer,
    materializeNextPendingQueueV2Message,
} from './pendingQueueV2Transport';
import { waitForTranscriptEncryptedMessageByLocalId } from './transcriptMessageLookup';
import { catchUpSessionMessagesAfterSeq } from './sessionMessageCatchUp';
import { isV2ChangesSyncEnabled, runSessionChangesSyncOnConnect } from './sessionChangesSyncOnConnect';
import { handleSessionNewMessageUpdate } from './sessionNewMessageUpdate';
import { handleSessionStateUpdate } from './sessionStateUpdateHandling';
import type { ACPMessageData, ACPProvider, SessionEventMessage } from './sessionMessageTypes';

export class ApiSessionClient extends EventEmitter {
    private readonly token: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private userSocket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
    readonly rpcHandlerManager: RpcHandlerManager;
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    private disconnectedSendLogged = false;
    private readonly pendingMaterializedLocalIds = new Set<string>();
    private readonly pendingQueueMaterializedLocalIds = new Set<string>();
    private pendingWakeSeq = 0;
    private readonly pendingCommitRetryAttemptsByLocalId = new Map<string, number>();
    private userSocketDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private closed = false;
    private snapshotSyncInFlight: Promise<void> | null = null;
    private readonly toolCallCanonicalNameByProviderAndId = new Map<string, { rawToolName: string; canonicalToolName: string }>();
    private readonly permissionToolCallRawInputByProviderAndId = new Map<string, unknown>();
    private readonly toolCallInputByProviderAndId = new Map<string, unknown>();
    private readonly receivedMessageIds = new Set<string>();
    private lastObservedMessageSeq = 0;
    private hasConnectedOnce = false;
    private changesSyncInFlight: Promise<void> | null = null;
    private accountIdPromise: Promise<string> | null = null;

    /**
     * Returns the latest known agentState (may be stale if socket is disconnected).
     * Useful for rebuilding in-memory caches (e.g. permission allowlists) without server changes.
     */
    getAgentStateSnapshot(): AgentState | null {
        return this.agentState;
    }

    private logSendWhileDisconnected(context: string, details?: Record<string, unknown>): void {
        if (this.socket.connected || this.disconnectedSendLogged) return;
        this.disconnectedSendLogged = true;
        logger.debug(
            `[API] Socket not connected; emitting ${context} anyway (socket.io should buffer until reconnection).`,
            details
        );
    }

    constructor(token: string, session: Session) {
        super()
        this.token = token;
        this.sessionId = session.id;
        this.metadata = session.metadata;
        this.metadataVersion = session.metadataVersion;
        this.agentState = session.agentState;
        this.agentStateVersion = session.agentStateVersion;
        this.encryptionKey = session.encryptionKey;
        this.encryptionVariant = session.encryptionVariant;

        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });
        registerSessionHandlers(this.rpcHandlerManager, this.metadata.path, { flavor: (this.metadata as any)?.flavor });

        //
        // Create socket
        //

        this.socket = createSessionScopedSocket({ token: this.token, sessionId: this.sessionId });

        // A user-scoped socket is used to observe our own materialized pending-queue messages.
        //
        // Server-side broadcasting skips the sender connection, so a session-scoped agent that emits a
        // transcript message will not receive its own "new-message" update. Without observing the
        // materialized message, the agent can't enqueue it for processing.
        //
        // A second (user-scoped) connection will still receive the broadcast, letting us safely
        // drive the normal update pipeline without server changes.
        this.userSocket = createUserScopedSocket({ token: this.token });

        //
        // Handlers
        //

        this.socket.on('connect', () => {
            logger.debug('Socket connected successfully');
            this.disconnectedSendLogged = false;
            this.rpcHandlerManager.onSocketConnect(this.socket);

            const isReconnect = this.hasConnectedOnce;
            this.hasConnectedOnce = true;
            void this.syncChangesOnConnect({ reason: isReconnect ? 'reconnect' : 'connect' });

            // Resumed sessions (inactive-session-resume) start with metadataVersion/agentStateVersion = -1.
            // If the user performed session mutations before this agent connected, the corresponding
            // updates happened "in the past" and won't be replayed over the socket. Syncing a snapshot
            // here ensures we start from a consistent metadata/agentState baseline.
            if (shouldSyncSessionSnapshotOnConnect({ metadataVersion: this.metadataVersion, agentStateVersion: this.agentStateVersion })) {
                void this.syncSessionSnapshotFromServer({ reason: 'connect' });
            }
        })

        // Set up global RPC request handler
        this.socket.on(SOCKET_RPC_EVENTS.REQUEST, async (data: { method: string, params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data));
        })

        this.socket.on('disconnect', (reason) => {
            logger.debug('[API] Socket disconnected:', reason);
            this.rpcHandlerManager.onSocketDisconnect();
        })

        this.socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error:', error);
            this.rpcHandlerManager.onSocketDisconnect();
        })

        // Server events
        this.socket.on('update', (data: Update) => this.handleUpdate(data, { source: 'session-scoped' }));
        this.userSocket.on('update', (data: Update) => this.handleUpdate(data, { source: 'user-scoped' }));
        // Broadcast-safe session events are optional hints; ignore unless explicitly used.
        this.socket.on('session', () => {});
        this.userSocket.on('session', () => {});

        // DEATH
        this.socket.on('error', (error) => {
            logger.debug('[API] Socket error:', error);
        });

        //
        // Connect (after short delay to give a time to add handlers)
        //

        this.socket.connect();
    }

    private syncSessionSnapshotFromServer(opts: { reason: 'connect' | 'waitForMetadataUpdate' }): Promise<void> {
        if (this.closed) return Promise.resolve();
        if (this.snapshotSyncInFlight) return this.snapshotSyncInFlight;

        const p = (async () => {
            try {
                const update = await fetchSessionSnapshotUpdateFromServer({
                    token: this.token,
                    sessionId: this.sessionId,
                    encryptionKey: this.encryptionKey,
                    encryptionVariant: this.encryptionVariant,
                    currentMetadataVersion: this.metadataVersion,
                    currentAgentStateVersion: this.agentStateVersion,
                });

                if (this.closed) return;

                if (update.metadata) {
                    this.metadata = update.metadata.metadata;
                    this.metadataVersion = update.metadata.metadataVersion;
                    this.emit('metadata-updated');
                }

                if (update.agentState) {
                    this.agentState = update.agentState.agentState;
                    this.agentStateVersion = update.agentState.agentStateVersion;
                }
            } catch (error) {
                logger.debug('[API] Failed to sync session snapshot from server', { reason: opts.reason, error });
            }
        })();

        this.snapshotSyncInFlight = p.finally(() => {
            if (this.snapshotSyncInFlight === p) {
                this.snapshotSyncInFlight = null;
            }
        });

        return this.snapshotSyncInFlight;
    }

    private kickUserSocketConnect(): void {
        if (this.closed) return;
        if (this.userSocketDisconnectTimer) {
            clearTimeout(this.userSocketDisconnectTimer);
            this.userSocketDisconnectTimer = null;
        }
        if (this.userSocket.connected) return;
        try {
            this.userSocket.connect();
        } catch {
            // ignore; transcript recovery will handle missed updates
        }
    }

    private maybeScheduleUserSocketDisconnect(): void {
        if (this.closed) return;
        if (this.pendingMaterializedLocalIds.size > 0) return;
        if (this.pendingQueueMaterializedLocalIds.size > 0) return;
        if (!this.userSocket.connected) return;
        if (this.userSocketDisconnectTimer) return;

        // Short idle grace to avoid thrashing if multiple pending items get materialized back-to-back.
        this.userSocketDisconnectTimer = setTimeout(() => {
            this.userSocketDisconnectTimer = null;
            if (this.pendingMaterializedLocalIds.size > 0) return;
            if (this.pendingQueueMaterializedLocalIds.size > 0) return;
            if (!this.userSocket.connected) return;
            try {
                this.userSocket.disconnect();
            } catch {
                // ignore
            }
        }, 2_000);
        this.userSocketDisconnectTimer.unref?.();
    }

    private hasMaterializedLocalId(localId: string): boolean {
        return this.pendingMaterializedLocalIds.has(localId) || this.pendingQueueMaterializedLocalIds.has(localId);
    }

    private deleteMaterializedLocalId(localId: string): void {
        this.pendingMaterializedLocalIds.delete(localId);
        this.pendingQueueMaterializedLocalIds.delete(localId);
        this.maybeScheduleUserSocketDisconnect();
    }

    private handleUpdate(data: Update, opts: { source: 'session-scoped' | 'user-scoped' }): void {
        try {
            logger.debugLargeJson(`[SOCKET] [UPDATE:${opts.source}] Received update:`, data);

            if (!data.body) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                return;
            }

            const newMessageHandlingResult = handleSessionNewMessageUpdate({
                update: data,
                sessionId: this.sessionId,
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
                receivedMessageIds: this.receivedMessageIds,
                lastObservedMessageSeq: this.lastObservedMessageSeq,
                hasMaterializedLocalId: (localId) => this.hasMaterializedLocalId(localId),
                deleteMaterializedLocalId: (localId) => this.deleteMaterializedLocalId(localId),
                pendingMessageCallback: this.pendingMessageCallback,
                pendingMessages: this.pendingMessages,
                emit: (event, payload) => this.emit(event, payload),
                debugLargeJson: (message, payload) => logger.debugLargeJson(message, payload),
            });
            if (newMessageHandlingResult.handled) {
                this.lastObservedMessageSeq = newMessageHandlingResult.lastObservedMessageSeq;
                return;
            }

            const stateUpdateResult = handleSessionStateUpdate({
                update: data,
                sessionId: this.sessionId,
                metadata: this.metadata,
                metadataVersion: this.metadataVersion,
                agentState: this.agentState,
                agentStateVersion: this.agentStateVersion,
                pendingWakeSeq: this.pendingWakeSeq,
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
                onMetadataUpdated: () => this.emit('metadata-updated'),
                onWarning: (message) => logger.debug(message),
            });
            if (stateUpdateResult.handled) {
                this.metadata = stateUpdateResult.metadata;
                this.metadataVersion = stateUpdateResult.metadataVersion;
                this.agentState = stateUpdateResult.agentState;
                this.agentStateVersion = stateUpdateResult.agentStateVersion;
                this.pendingWakeSeq = stateUpdateResult.pendingWakeSeq;
                return;
            }

            // If not a user message, it might be a permission response or other message type
            this.emit('message', data.body);
        } catch (error) {
            logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', { error });
        }
    }

    private async getAccountId(): Promise<string | null> {
        if (this.accountIdPromise) {
            try {
                return await this.accountIdPromise;
            } catch {
                this.accountIdPromise = null;
                return null;
            }
        }

        const p = (async () => {
            const response = await axios.get(`${configuration.serverUrl}/v1/account/profile`, {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json',
                },
                timeout: 15_000,
            });
            const id = (response?.data as any)?.id;
            if (typeof id !== 'string' || id.length === 0) {
                throw new Error('Invalid /v1/account/profile response');
            }
            return id;
        })();

        this.accountIdPromise = p;
        try {
            return await p;
        } catch {
            this.accountIdPromise = null;
            return null;
        }
    }

    private async catchUpSessionMessages(afterSeq: number): Promise<void> {
        await catchUpSessionMessagesAfterSeq({
            token: this.token,
            sessionId: this.sessionId,
            afterSeq,
            onUpdate: (update) => this.handleUpdate(update, { source: 'session-scoped' }),
        });
    }

    private async syncChangesOnConnect(opts: { reason: 'connect' | 'reconnect' }): Promise<void> {
        const enabled = isV2ChangesSyncEnabled(process.env.HAPPY_ENABLE_V2_CHANGES);
        if (!enabled) {
            return;
        }

        if (this.closed) return;
        if (this.changesSyncInFlight) {
            await this.changesSyncInFlight.catch(() => {});
            return;
        }

        const p = runSessionChangesSyncOnConnect({
            reason: opts.reason,
            token: this.token,
            sessionId: this.sessionId,
            lastObservedMessageSeq: this.lastObservedMessageSeq,
            getAccountId: () => this.getAccountId(),
            catchUpSessionMessages: (afterSeq) => this.catchUpSessionMessages(afterSeq),
            syncSessionSnapshotFromServer: (syncOpts) => this.syncSessionSnapshotFromServer(syncOpts),
            onDebug: (message, data) => logger.debug(message, data),
        });

        this.changesSyncInFlight = p;
        try {
            await p;
        } finally {
            this.changesSyncInFlight = null;
        }
    }

    private async recoverMaterializedLocalId(localId: string, opts?: { maxWaitMs?: number }): Promise<boolean> {
        const found = await waitForTranscriptEncryptedMessageByLocalId({
            token: this.token,
            sessionId: this.sessionId,
            localId,
            maxWaitMs: opts?.maxWaitMs,
            onError: (error) => {
                logger.debug('[API] Failed to fetch transcript messages for pending-queue recovery', { error });
            },
        });
        if (!found) return false;

        // Prevent later user-scoped updates from double-processing this localId.
        this.deleteMaterializedLocalId(localId);

        const update: Update = {
            id: `recovered-${localId}`,
            seq: 0,
            createdAt: Date.now(),
            body: {
                t: 'new-message',
                sid: this.sessionId,
                message: {
                    id: found.id,
                    seq: found.seq,
                    localId: found.localId ?? undefined,
                    content: found.content,
                },
            },
        } as Update;

        this.handleUpdate(update, { source: 'session-scoped' });
        return true;
    }

    private scheduleMaterializationRecovery(localId: string): void {
        // Belt-and-suspenders: if we fail to observe the user-scoped update (connect race, brief disconnect),
        // recover by scanning the transcript and re-injecting the message into the normal update pipeline.
        const timer = setTimeout(() => {
            if (!this.hasMaterializedLocalId(localId)) return;
            void this.recoverMaterializedLocalId(localId, { maxWaitMs: 7_500 });
        }, 500);
        timer.unref?.();
    }

    onUserMessage(callback: (data: UserMessage) => void) {
        this.pendingMessageCallback = callback;
        while (this.pendingMessages.length > 0) {
            callback(this.pendingMessages.shift()!);
        }
    }

    waitForMetadataUpdate(abortSignal?: AbortSignal): Promise<boolean> {
        if (abortSignal?.aborted) {
            return Promise.resolve(false);
        }

        const startMetadataVersion = this.metadataVersion;
        const startAgentStateVersion = this.agentStateVersion;
        const startPendingWakeSeq = this.pendingWakeSeq;
        if (startMetadataVersion < 0 || startAgentStateVersion < 0) {
            void this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
        }
        return new Promise((resolve) => {
            let cleanedUp = false;
            const shouldWatchConnect = !this.userSocket.connected;
            const onUpdate = () => {
                cleanup();
                resolve(true);
            };
            const onConnect = () => {
                void (async () => {
                    // If we just connected the user-scoped socket, we may have missed "update-session" broadcasts
                    // while it was disconnected. Sync a snapshot once so callers can reliably observe the latest
                    // metadata/agentState immediately after this wakeup.
                    await this.syncSessionSnapshotFromServer({ reason: 'connect' });
                    cleanup();
                    resolve(true);
                })();
            };
            const onAbort = () => {
                cleanup();
                resolve(false);
            };
            const onDisconnect = () => {
                cleanup();
                resolve(false);
            };
            const cleanup = () => {
                if (cleanedUp) return;
                cleanedUp = true;
                this.off('metadata-updated', onUpdate);
                abortSignal?.removeEventListener('abort', onAbort);
                if (shouldWatchConnect) {
                    this.userSocket.off('connect', onConnect);
                }
                this.userSocket.off('disconnect', onDisconnect);
                this.maybeScheduleUserSocketDisconnect();
            };

            this.on('metadata-updated', onUpdate);
            if (shouldWatchConnect) {
                this.userSocket.on('connect', onConnect);
            }
            abortSignal?.addEventListener('abort', onAbort, { once: true });
            this.userSocket.on('disconnect', onDisconnect);

            // Ensure we can observe metadata updates even when the server broadcasts them only to user-scoped clients.
            // This keeps idle agents wakeable without requiring server changes.
            this.kickUserSocketConnect();

            if (abortSignal?.aborted) {
                onAbort();
                return;
            }

            // Avoid lost wakeups if a snapshot sync or socket event raced with handler registration.
            if (
                this.metadataVersion !== startMetadataVersion ||
                this.agentStateVersion !== startAgentStateVersion ||
                this.pendingWakeSeq !== startPendingWakeSeq
            ) {
                onUpdate();
                return;
            }
            if (shouldWatchConnect && this.userSocket.connected) {
                onConnect();
                return;
            }
        });
    }

    /**
     * Ensure we have a decrypted metadata snapshot from the server.
     *
     * Unlike waitForMetadataUpdate(), this does not resolve early just because the socket connected.
     * It resolves only once metadataVersion is >= 0 and metadata is available (or times out).
     */
    async ensureMetadataSnapshot(opts?: { timeoutMs?: number; abortSignal?: AbortSignal }): Promise<Metadata | null> {
        const abortSignal = opts?.abortSignal;
        if (abortSignal?.aborted) return null;

        if (this.metadataVersion >= 0 && this.metadata) {
            return this.metadata;
        }

        const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : 15_000;

        if (this.metadataVersion < 0) {
            void this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
        }

        return await new Promise((resolve) => {
            let cleanedUp = false;
            const onAbort = () => {
                cleanup();
                resolve(null);
            };
            const onDisconnect = () => {
                cleanup();
                resolve(null);
            };
            const onUpdate = () => {
                if (this.metadataVersion >= 0 && this.metadata) {
                    cleanup();
                    resolve(this.metadata);
                }
            };

            const timer = setTimeout(() => {
                cleanup();
                resolve(this.metadataVersion >= 0 ? this.metadata : null);
            }, timeoutMs);
            timer.unref?.();

            const cleanup = () => {
                if (cleanedUp) return;
                cleanedUp = true;
                clearTimeout(timer);
                this.off('metadata-updated', onUpdate);
                abortSignal?.removeEventListener('abort', onAbort);
                this.userSocket.off('disconnect', onDisconnect);
                this.maybeScheduleUserSocketDisconnect();
            };

            this.on('metadata-updated', onUpdate);
            this.userSocket.on('disconnect', onDisconnect);
            abortSignal?.addEventListener('abort', onAbort, { once: true });

            // Avoid lost wakeups if the snapshot sync raced with handler registration.
            onUpdate();
        });
    }

    private async commitEncryptedSessionMessage(
        params: { encryptedMessage: string; localId: string; requireCommit: boolean },
    ): Promise<void> {
        const localId = params.localId;
        if (localId.length === 0) {
            if (params.requireCommit) {
                throw new Error('localId is required');
            }
            return;
        }

        if (!this.socket.connected) {
            if (params.requireCommit) {
                throw new Error('Socket not connected');
            }
            this.pendingMaterializedLocalIds.add(localId);
            this.socket.emit('message', {
                sid: this.sessionId,
                message: params.encryptedMessage,
                localId,
            });
            this.scheduleMaterializationRecovery(localId);
            this.scheduleCommitRetry({ encryptedMessage: params.encryptedMessage, localId });
            return;
        }

        this.pendingMaterializedLocalIds.add(localId);
        const ack = await (async () => {
            try {
                const raw = await this.socket
                    .timeout(7_500)
                    .emitWithAck('message', {
                        sid: this.sessionId,
                        message: params.encryptedMessage,
                        localId,
                    }) as unknown;

                const parsed = MessageAckResponseSchema.safeParse(raw);
                return parsed.success ? parsed.data : null;
            } catch {
                return null;
            }
        })();

        if (ack && ack.ok === true) {
            this.pendingCommitRetryAttemptsByLocalId.delete(localId);
            this.deleteMaterializedLocalId(localId);
            // ACK confirms persistence. Do not inject a synthetic update here: outbound sends are not prompts.
            this.lastObservedMessageSeq = Math.max(this.lastObservedMessageSeq, ack.seq);
            return;
        }

        if (ack && ack.ok === false) {
            this.pendingCommitRetryAttemptsByLocalId.delete(localId);
            this.deleteMaterializedLocalId(localId);
            if (params.requireCommit) {
                throw new Error(ack.error);
            }
            return;
        }

        if (params.requireCommit) {
            const recovered = await this.recoverMaterializedLocalId(localId, { maxWaitMs: 12_000 });
            if (!recovered) {
                throw new Error('Message commit not confirmed (ACK timed out and transcript recovery failed)');
            }
            return;
        }

        this.scheduleMaterializationRecovery(localId);
        this.scheduleCommitRetry({ encryptedMessage: params.encryptedMessage, localId });
    }

    private scheduleCommitRetry(params: { encryptedMessage: string; localId: string }): void {
        const localId = params.localId;
        if (!localId) return;
        if (!this.pendingMaterializedLocalIds.has(localId)) return;

        const current = this.pendingCommitRetryAttemptsByLocalId.get(localId) ?? 0;
        const next = current + 1;
        if (next > 3) {
            return;
        }
        this.pendingCommitRetryAttemptsByLocalId.set(localId, next);

        const delayMs = 1_000 * next;
        const timer = setTimeout(() => {
            if (!this.pendingMaterializedLocalIds.has(localId)) {
                this.pendingCommitRetryAttemptsByLocalId.delete(localId);
                return;
            }
            void this.commitEncryptedSessionMessage({
                encryptedMessage: params.encryptedMessage,
                localId,
                requireCommit: false,
            }).catch(() => {
                // Best-effort retry only.
            });
        }, delayMs);
        timer.unref?.();
    }

    private encryptSessionContent(content: unknown): string {
        return encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content as any));
    }

    private commitEncryptedSessionMessageBestEffort(params: {
        encryptedMessage: string;
        localId: string;
        logErrorMessage: string;
    }): void {
        void this.commitEncryptedSessionMessage({
            encryptedMessage: params.encryptedMessage,
            localId: params.localId,
            requireCommit: false,
        }).catch((error) => {
            logger.debug(params.logErrorMessage, { error });
        });
    }

    private buildUserTextMessageContent(text: string, meta?: Record<string, unknown>): MessageContent {
        return {
            role: 'user',
            content: { type: 'text', text },
            meta: {
                sentFrom: 'cli',
                source: 'cli',
                ...(meta && typeof meta === 'object' ? meta : {}),
            },
        };
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendClaudeSessionMessage(body: RawJSONLines) {
        if (isToolTraceEnabled()) {
            recordClaudeToolTraceEvents({ sessionId: this.sessionId, body });
        }

        let content: MessageContent;

        // Check if body is already a MessageContent (has role property)
        if (
            body.type === 'user' &&
            typeof body.message.content === 'string' &&
            body.isSidechain !== true &&
            body.isMeta !== true
        ) {
            content = {
                role: 'user',
                content: {
                    type: 'text',
                    text: body.message.content
                },
                meta: {
                    sentFrom: 'cli',
                    source: 'cli',
                }
            }
        } else {
            // Wrap Claude messages in the expected format
            content = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: body  // This wraps the entire Claude message
                },
                meta: {
                    sentFrom: 'cli',
                    source: 'cli',
                }
            };
        }

        logger.debugLargeJson('[SOCKET] Sending message through socket:', content)

        this.logSendWhileDisconnected('Claude session message', { type: body.type });

        const encrypted = this.encryptSessionContent(content);
        const localId = randomUUID();
        this.commitEncryptedSessionMessageBestEffort({
            encryptedMessage: encrypted,
            localId,
            logErrorMessage: '[SOCKET] Failed to commit Claude session message (non-fatal)',
        });

        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message?.usage) {
            try {
                this.sendUsageData(body.message.usage, body.message.model);
            } catch (error) {
                logger.debug('[SOCKET] Failed to send usage data:', error);
            }
        }

        // Update metadata with summary if this is a summary message
        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            this.updateMetadata((metadata) => ({
                ...metadata,
                summary: {
                    text: body.summary,
                    updatedAt: Date.now()
                }
            }));
        }
    }

    sendCodexMessage(body: any) {
        const normalizedBody = normalizeCodexSessionMessageBody({
            body,
            toolCallCanonicalNameByProviderAndId: this.toolCallCanonicalNameByProviderAndId,
            debug: (message, data) => logger.debug(message, data),
        });

        let content = {
            role: 'agent',
            content: {
                type: 'codex',
                data: normalizedBody  // This wraps the entire Codex message
            },
            meta: {
                sentFrom: 'cli',
                source: 'cli',
            }
        };

        recordCodexToolTraceEventIfNeeded({ sessionId: this.sessionId, body: normalizedBody });
        
        this.logSendWhileDisconnected('Codex message', { type: normalizedBody?.type });

        const encrypted = this.encryptSessionContent(content);
        const localId = randomUUID();
        this.commitEncryptedSessionMessageBestEffort({
            encryptedMessage: encrypted,
            localId,
            logErrorMessage: '[SOCKET] Failed to commit Codex message (non-fatal)',
        });
    }

    private prepareAcpAgentMessage(params: {
        provider: ACPProvider;
        body: ACPMessageData;
        meta?: Record<string, unknown>;
        localId?: string;
    }): {
        normalizedBody: ACPMessageData;
        content: ReturnType<typeof buildAcpAgentMessageEnvelope>;
        localId: string;
    } {
        const normalizedBody = normalizeAcpSessionMessageBody({
            provider: params.provider,
            body: params.body,
            toolCallCanonicalNameByProviderAndId: this.toolCallCanonicalNameByProviderAndId,
            permissionToolCallRawInputByProviderAndId: this.permissionToolCallRawInputByProviderAndId,
            toolCallInputByProviderAndId: this.toolCallInputByProviderAndId,
        });
        const localId = typeof params.localId === 'string' && params.localId.length > 0 ? params.localId : randomUUID();
        const content = buildAcpAgentMessageEnvelope({
            provider: params.provider,
            body: normalizedBody,
            meta: params.meta,
        });
        return { normalizedBody, content, localId };
    }

    /**
     * Send a generic agent message to the session using ACP (Agent Communication Protocol) format.
     * Works for any agent type (Gemini, Codex, Claude, etc.) - CLI normalizes to unified ACP format.
     * 
     * @param provider - The agent provider sending the message (e.g., 'gemini', 'codex', 'claude')
     * @param body - The message payload (type: 'message' | 'reasoning' | 'tool-call' | 'tool-result')
     */
    sendAgentMessage(
        provider: ACPProvider,
        body: ACPMessageData,
        opts?: { localId?: string; meta?: Record<string, unknown> },
    ) {
        const { normalizedBody, content, localId } = this.prepareAcpAgentMessage({
            provider,
            body,
            meta: opts?.meta,
            localId: opts?.localId,
        });

        if (shouldTraceAcpMessageType(normalizedBody.type, { includeTaskComplete: true })) {
            recordAcpToolTraceEventIfNeeded({
                sessionId: this.sessionId,
                provider,
                body: normalizedBody,
                localId,
            });
        }
        
        logger.debug(`[SOCKET] Sending ACP message from ${provider}:`, { type: normalizedBody.type, hasMessage: 'message' in normalizedBody });
        this.logSendWhileDisconnected(`${provider} ACP message`, { type: normalizedBody.type });
        const encrypted = this.encryptSessionContent(content);
        this.commitEncryptedSessionMessageBestEffort({
            encryptedMessage: encrypted,
            localId,
            logErrorMessage: '[SOCKET] Failed to commit agent message (non-fatal)',
        });
    }

    sendUserTextMessage(text: string, opts?: { localId?: string; meta?: Record<string, unknown> }) {
        const content = this.buildUserTextMessageContent(text, opts?.meta);

        this.logSendWhileDisconnected('User text message', { length: text.length });
        const encrypted = this.encryptSessionContent(content);
        const localId = typeof opts?.localId === 'string' && opts.localId.length > 0 ? opts.localId : randomUUID();
        this.commitEncryptedSessionMessageBestEffort({
            encryptedMessage: encrypted,
            localId,
            logErrorMessage: '[SOCKET] Failed to commit user message (non-fatal)',
        });
    }

    async sendUserTextMessageCommitted(
        text: string,
        opts: { localId: string; meta?: Record<string, unknown> },
    ): Promise<void> {
        const content = this.buildUserTextMessageContent(text, opts.meta);
        const encrypted = this.encryptSessionContent(content);
        await this.commitEncryptedSessionMessage({ encryptedMessage: encrypted, localId: opts.localId, requireCommit: true });
    }

    async sendAgentMessageCommitted(
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown> },
    ): Promise<void> {
        const { normalizedBody, content, localId } = this.prepareAcpAgentMessage({
            provider,
            body,
            meta: opts?.meta,
            localId: opts.localId,
        });

        if (shouldTraceAcpMessageType(normalizedBody.type)) {
            recordAcpToolTraceEventIfNeeded({ sessionId: this.sessionId, provider, body: normalizedBody, localId });
        }

        const encrypted = this.encryptSessionContent(content);
        await this.commitEncryptedSessionMessage({ encryptedMessage: encrypted, localId, requireCommit: true });
    }

    async fetchRecentTranscriptTextItemsForAcpImport(opts?: { take?: number }): Promise<Array<{ role: 'user' | 'agent'; text: string }>> {
        return fetchRecentTranscriptTextItemsForAcpImportFromServer({
            token: this.token,
            sessionId: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            take: opts?.take,
        });
    }

    async fetchLatestUserPermissionIntentFromTranscript(opts?: { take?: number }): Promise<{ intent: import('../types').PermissionMode; updatedAt: number } | null> {
        return fetchLatestUserPermissionIntentFromEncryptedTranscript({
            token: this.token,
            sessionId: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            take: opts?.take,
        });
    }

    sendSessionEvent(event: SessionEventMessage, id?: string) {
        const content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
        };

        this.logSendWhileDisconnected('session event', { eventType: event.type });

        const encrypted = this.encryptSessionContent(content);
        const localId = randomUUID();
        this.commitEncryptedSessionMessageBestEffort({
            encryptedMessage: encrypted,
            localId,
            logErrorMessage: '[SOCKET] Failed to commit session event (non-fatal)',
        });
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        if (process.env.DEBUG) { // too verbose for production
            logger.debug(`[API] Sending keep alive message: ${thinking}`);
        }
        this.socket.volatile.emit('session-alive', {
            sid: this.sessionId,
            time: Date.now(),
            thinking,
            mode
        });
    }

    /**
     * Send session death message
     */
    sendSessionDeath() {
        this.socket.emit('session-end', { sid: this.sessionId, time: Date.now() });
    }

    /**
     * Send usage data to the server
     */
    sendUsageData(usage: Usage, model?: string) {
        // Calculate total tokens
        const totalTokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

        const costs = calculateCost(usage, model);

        // Transform Claude usage format to backend expected format
        const usageReport = {
            key: 'claude-session',
            sessionId: this.sessionId,
            tokens: {
                total: totalTokens,
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_creation: usage.cache_creation_input_tokens || 0,
                cache_read: usage.cache_read_input_tokens || 0
            },
            cost: {
                total: costs.total,
                input: costs.input,
                output: costs.output
            }
        }
        logger.debugLargeJson('[SOCKET] Sending usage data:', usageReport)
        this.socket.emit('usage-report', usageReport);
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    updateMetadata(handler: (metadata: Metadata) => Metadata) {
        this.metadataLock.inLock(async () => {
            await updateSessionMetadataWithAck({
                socket: this.socket as any,
                sessionId: this.sessionId,
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
                getMetadata: () => this.metadata,
                setMetadata: (metadata) => {
                    this.metadata = metadata;
                },
                getMetadataVersion: () => this.metadataVersion,
                setMetadataVersion: (version) => {
                    this.metadataVersion = version;
                },
                syncSessionSnapshotFromServer: () => this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' }),
                handler,
            });
        });
    }

    /**
     * Update session agent state
     * @param handler - Handler function that returns the updated agent state
     */
    updateAgentState(handler: (metadata: AgentState) => AgentState) {
        logger.debugLargeJson('Updating agent state', this.agentState);
        this.agentStateLock.inLock(async () => {
            await updateSessionAgentStateWithAck({
                socket: this.socket as any,
                sessionId: this.sessionId,
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
                getAgentState: () => this.agentState,
                setAgentState: (agentState) => {
                    this.agentState = agentState;
                },
                getAgentStateVersion: () => this.agentStateVersion,
                setAgentStateVersion: (version) => {
                    this.agentStateVersion = version;
                },
                syncSessionSnapshotFromServer: () => this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' }),
                handler,
            });
        });
    }

    /**
     * Wait for socket buffer to flush
     */
    async flush(): Promise<void> {
        if (!this.socket.connected) {
            return;
        }
        return new Promise((resolve) => {
            this.socket.emit('ping', () => {
                resolve();
            });
            setTimeout(() => {
                resolve();
            }, 10000);
        });
    }

    /**
     * Read-only snapshot of the currently known session metadata (decrypted).
     *
     * This is useful for spawn-time decisions that depend on previous metadata values
     * (e.g. session-scoped feature toggles) without requiring a metadata write.
     */
    getMetadataSnapshot(): Metadata | null {
        return this.metadata;
    }

    async close() {
        logger.debug('[API] socket.close() called');
        this.closed = true;
        if (this.userSocketDisconnectTimer) {
            clearTimeout(this.userSocketDisconnectTimer);
            this.userSocketDisconnectTimer = null;
        }
        this.pendingMaterializedLocalIds.clear();
        this.pendingQueueMaterializedLocalIds.clear();
        this.pendingCommitRetryAttemptsByLocalId.clear();
        try {
            this.userSocket.close();
        } catch {
            // ignore
        }
        this.socket.close();
    }

    async listPendingMessageQueueV2LocalIds(): Promise<string[]> {
        return listPendingQueueV2LocalIdsFromServer({
            token: this.token,
            sessionId: this.sessionId,
        });
    }

    async peekPendingMessageQueueV2Count(): Promise<number> {
        const localIds = await this.listPendingMessageQueueV2LocalIds();
        // Include materialized-but-not-yet-observed messages as "pending-ish" work.
        // These are messages we already removed from the server pending queue but haven't
        // seen broadcast into the transcript yet; switching modes during this window can
        // silently drop user intent in non-interactive (no TTY) flows.
        return localIds.length + this.pendingQueueMaterializedLocalIds.size;
    }

    async discardPendingMessageQueueV2All(opts: { reason: 'switch_to_local' | 'manual' }): Promise<number> {
        const localIds = await this.listPendingMessageQueueV2LocalIds();
        if (localIds.length === 0) return 0;
        return discardPendingQueueV2Messages({
            token: this.token,
            sessionId: this.sessionId,
            localIds,
            reason: opts.reason,
        });
    }

    async discardCommittedMessageLocalIds(opts: { localIds: string[]; reason: 'switch_to_local' | 'manual' }): Promise<number> {
        if (!this.socket.connected) {
            return 0;
        }
        if (!this.metadata) {
            return 0;
        }

        const localIds = opts.localIds.filter((id) => typeof id === 'string' && id.length > 0);
        if (localIds.length === 0) {
            return 0;
        }

        let addedCount = 0;

        await this.metadataLock.inLock(async () => {
            await backoff(async () => {
                const current = this.metadata as unknown as Record<string, unknown>;

                const existingRaw = (current as any).discardedCommittedMessageLocalIds;
                const existing = Array.isArray(existingRaw) ? existingRaw.filter((v) => typeof v === 'string') : [];
                const existingSet = new Set(existing);
                const uniqueNew = localIds.filter((id) => !existingSet.has(id));
                if (uniqueNew.length === 0) {
                    addedCount = 0;
                    return;
                }

                const nextMetadata = addDiscardedCommittedMessageLocalIds(current, uniqueNew);
                const answer = await this.socket.emitWithAck('update-metadata', {
                    sid: this.sessionId,
                    expectedVersion: this.metadataVersion,
                    metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, nextMetadata)),
                });

                if (answer.result === 'success') {
                    this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    this.metadataVersion = answer.version;
                    addedCount = uniqueNew.length;
                    return;
                }

                if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        this.metadataVersion = answer.version;
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    }
                    throw new Error('Metadata version mismatch');
                }

                // Hard error - ignore
                addedCount = 0;
            });
        });

        return addedCount;
    }

    /**
     * Materialize one server-backed queued message (pending queue V2) into the normal session transcript.
     *
     * The server atomically:
     * - selects the next queued pending message,
     * - commits it into SessionMessage (idempotent via (sessionId, localId)),
     * - removes it from the pending queue.
     */
    async popPendingMessage(): Promise<boolean> {
        const materializeResult = await materializeNextPendingQueueV2Message({
            token: this.token,
            sessionId: this.sessionId,
            socket: this.socket,
        });
        if (!materializeResult || !materializeResult.didMaterialize) {
            return false;
        }

        if (materializeResult.didWrite && materializeResult.localId) {
            // Best-effort: recover if we miss socket broadcasts for the committed transcript row.
            this.pendingQueueMaterializedLocalIds.add(materializeResult.localId);
            this.scheduleMaterializationRecovery(materializeResult.localId);
        }

        return true;
    }
}

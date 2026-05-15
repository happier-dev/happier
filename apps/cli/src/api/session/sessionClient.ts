import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, Metadata, ServerToClientEvents, Session, UserMessage } from '../types'
import { AsyncLock } from '@/utils/lock';
import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { shouldSyncSessionSnapshotOnConnect } from './snapshotSync';
import { updateSessionAgentStateWithAck, updateSessionMetadataWithAck } from './stateUpdates';
import { readAuthenticationStatus } from '@/api/client/httpStatusError';
import type { ACPMessageData, ACPProvider, SessionEventMessage } from './sessionMessageTypes';
import { consumeDaemonInitialPromptFromEnv } from '@/agent/runtime/daemonInitialPrompt';
import {
    type ManagedConnectionState,
    type ManagedConnectionSupervisor,
    type ReadinessProbeResult,
} from '@happier-dev/connection-supervisor';
import type { HappyMcpExecutionRunService } from '@/mcp/startHappyServer';
import { createEventShapeLoggerForLog } from '@/diagnostics/eventShapeForLog';
import { mergeVoiceAgentRunMetadataFromExecutionRun } from './voiceAgentRunMetadataV1';
import {
    createSessionClientTranscriptApi,
    type SessionClientTranscriptApi,
} from './client/transcript/sessionClientTranscriptApi';
import type { SendAgentSessionMediaCommittedRequest } from './client/transcript/sessionMediaBridge';
import type { TurnAssistantTextSnapshotStore } from './turns/assistantTextSnapshot';
import { createTurnAssistantTextSnapshotStore } from './turns/assistantTextSnapshotStore';
import {
    registerSessionClientRuntimeHandlers,
} from './client/executionRuns/registerSessionClientRuntimeHandlers';
import {
    createSessionClientExecutionRunService,
} from './client/executionRuns/createSessionClientExecutionRunService';
import {
    initializeSessionClientConnection,
} from './client/transport/initializeSessionClientConnection';
import {
    createSessionClientInteractionApi,
    type SessionClientInteractionApi,
} from './client/transport/sessionClientInteractionApi';
import { syncSessionSnapshotFromServer } from './client/transport/syncSessionSnapshotFromServer';
import { createSessionClientUsageObservationPublisher } from './client/createSessionClientUsageObservationPublisher';
import {
    createSessionClientRecoveryRuntime,
    type SessionClientRecoveryRuntime,
} from './client/lifecycle/createSessionClientRecoveryRuntime';
import { createSessionClientMaterializationRuntime } from './client/lifecycle/createSessionClientMaterializationRuntime';
import { createSessionClientCommitQueueRuntime } from './client/transport/createSessionClientCommitQueueRuntime';
import { createSessionClientUpdateRuntime } from './client/transport/createSessionClientUpdateRuntime';
import {
    attachSessionUserMessageHandler,
    catchUpSessionMessagesViaPort,
    scheduleNextStartupCatchUpRetryViaPort,
} from './client/lifecycle/startupCatchUpRuntime';
import type { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import type { PrimaryTurnStatusV1, SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import { configuration } from '@/configuration';

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function classifySessionTransportErrorToProbeResult(
    error: unknown,
): Exclude<ReadinessProbeResult, Readonly<{ status: 'ready' }>> | null {
    const statusCode = readAuthenticationStatus(error);
    if (!statusCode) return null;
    return {
        status: 'auth_failed',
        statusCode,
        errorMessage: error instanceof Error ? error.message : 'Authentication failed',
    };
}

export class ApiSessionClient extends EventEmitter {
    private static readonly STARTUP_MESSAGE_CATCH_UP_RETRY_DELAYS_MS = [250, 1_000, 2_500] as const;

    private readonly token: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateRequestStore: AgentStateRequestStore | null = null;
    private agentStateVersion: number;
    private socket!: Socket<ServerToClientEvents, ClientToServerEvents>;
    private userSocket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessages: UserMessage[] = [];
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null;
    private userMessageCallbackAttachedAtMs: number | null = null;
    readonly rpcHandlerManager: RpcHandlerManager;
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';
    private readonly outboundShapeLogger = createEventShapeLoggerForLog({ logger, scope: 'session-out' });
    private sessionConnectionSupervisor: ManagedConnectionSupervisor | null = null;
    private currentConnectionState: ManagedConnectionState = {
        phase: 'idle',
        reason: null,
        attempt: 0,
        nextRetryAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastErrorMessage: null,
    };
    private readonly sessionEncryptionMode: 'e2ee' | 'plain';
    private disconnectedSendLogged = false;
    private userSocketDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private closed = false;
    private snapshotSyncInFlight: Promise<void> | null = null;
    private readonly toolCallCanonicalNameByProviderAndId = new Map<string, { rawToolName: string; canonicalToolName: string }>();
    private readonly permissionToolCallRawInputByProviderAndId = new Map<string, unknown>();
    private readonly toolCallInputByProviderAndId = new Map<string, unknown>();
    private hasConnectedOnce = false;
    private daemonInitialPrompt: string | null = null;
    private daemonInitialPromptSeeded = false;
    private startupMessageCatchUpStarted = false;
    private startupMessageCatchUpRetryIndex = 0;
    private startupMessageCatchUpInitialAfterSeq = 0;
    private readonly startedByDaemonProcess: boolean;
    private readonly transcriptStorage: 'persisted' | 'direct';
    private readonly usageObservationPublisher: ReturnType<typeof createSessionClientUsageObservationPublisher>;
    private readonly transcriptApi: SessionClientTranscriptApi;
    readonly turnAssistantTextSnapshotStore: TurnAssistantTextSnapshotStore;
    private readonly interactionApi: SessionClientInteractionApi;
    private readonly recoveryRuntime: SessionClientRecoveryRuntime;
    private readonly materializationRuntime: ReturnType<typeof createSessionClientMaterializationRuntime>;
    private readonly commitQueueRuntime: ReturnType<typeof createSessionClientCommitQueueRuntime>;
    private readonly updateRuntime: ReturnType<typeof createSessionClientUpdateRuntime>;
    readonly executionRuns: HappyMcpExecutionRunService;

    /**
     * Returns the latest known agentState (may be stale if socket is disconnected).
     * Useful for rebuilding in-memory caches (e.g. permission allowlists) without server changes.
     */
    getAgentStateSnapshot(): AgentState | null {
        return this.agentState;
    }

    bindAgentStateRequestStore(store: AgentStateRequestStore): void {
        this.agentStateRequestStore = store;
    }

    getAgentStateRequestStore(): AgentStateRequestStore | null {
        return this.agentStateRequestStore;
    }

    // Keep the historical test-touch points wired to the extracted owners on the live snapshot.
    private get pendingMaterializedLocalIds(): ReadonlySet<string> {
        return this.materializationRuntime.pendingMaterializedLocalIds;
    }

    private get committedLocalIdsAwaitingEcho(): ReadonlySet<string> {
        return this.materializationRuntime.committedLocalIdsAwaitingEcho;
    }

    private get queuedDisconnectedSessionMessages(): ReadonlyMap<string, { message: string | { t: 'plain'; v: unknown }; localId: string; sidechainId: string | null }> {
        return this.commitQueueRuntime?.queuedDisconnectedSessionMessages ?? new Map();
    }

    private get messageCommitQueueTail(): Promise<unknown> {
        return this.commitQueueRuntime?.getMessageCommitQueueTail() ?? Promise.resolve();
    }

    private get lastObservedMessageSeq(): number {
        return this.updateRuntime?.getLastObservedMessageSeq()
            ?? ((this as unknown as { __legacyLastObservedMessageSeq?: number }).__legacyLastObservedMessageSeq ?? 0);
    }

    private set lastObservedMessageSeq(value: number) {
        if (this.updateRuntime) {
            this.updateRuntime.setLastObservedMessageSeq(value);
            return;
        }
        (this as unknown as { __legacyLastObservedMessageSeq?: number }).__legacyLastObservedMessageSeq = value;
    }

    private get lastObservedUserMessageSeq(): number {
        return this.updateRuntime?.getLastObservedUserMessageSeq()
            ?? ((this as unknown as { __legacyLastObservedUserMessageSeq?: number }).__legacyLastObservedUserMessageSeq ?? 0);
    }

    private logSendWhileDisconnected(context: string, details?: Record<string, unknown>): void {
        if (this.socket.connected || this.disconnectedSendLogged) return;
        this.disconnectedSendLogged = true;
        logger.debug(
            `[API] Socket not connected; queueing ${context} until supervised reconnect.`,
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
            this.usageObservationPublisher = createSessionClientUsageObservationPublisher({
                token: this.token,
                getSocket: () => ({
                    connected: this.socket?.connected ?? false,
                    emit: (event, report) => {
                        this.socket?.emit?.(event, report as never);
                    },
                }),
            });
            this.executionRuns = createSessionClientExecutionRunService({
                token: this.token,
                sessionId: this.sessionId,
                getSessionEncryptionMode: () => this.sessionEncryptionMode,
                getEncryptionContext: () => ({
                    encryptionKey: this.encryptionKey,
                    encryptionVariant: this.encryptionVariant,
                }),
            });
            this.turnAssistantTextSnapshotStore = createTurnAssistantTextSnapshotStore({
                maxTextChars: configuration.readyNotificationAssistantTextMaxChars,
            });
	        if (session.encryptionMode === 'plain') {
	            this.sessionEncryptionMode = 'plain';
	            // Plaintext sessions should not require encryption materials. Keep dummy values for
	            // legacy surfaces that still accept encryption key args; they must branch on
	            // `sessionEncryptionMode` and never encrypt/decrypt.
	            this.encryptionKey = new Uint8Array(32);
	            this.encryptionVariant = 'dataKey';
	        } else {
	            this.sessionEncryptionMode = 'e2ee';
	            this.encryptionKey = session.encryptionKey;
	            this.encryptionVariant = session.encryptionVariant;
	        }
	        this.transcriptStorage = (() => {
	            const raw = typeof process.env.HAPPIER_TRANSCRIPT_STORAGE === 'string'
	                ? process.env.HAPPIER_TRANSCRIPT_STORAGE.trim().toLowerCase()
	                : '';
	            return raw === 'direct' ? 'direct' : 'persisted';
	        })();
	        this.daemonInitialPrompt = consumeDaemonInitialPromptFromEnv();
        this.startedByDaemonProcess = (() => {
            const idx = process.argv.indexOf('--started-by');
            if (idx < 0) return false;
            const value = process.argv[idx + 1];
            return value === 'daemon';
        })();
        this.materializationRuntime = createSessionClientMaterializationRuntime({
            forgetMaterializationRecovery: (localId) => this.recoveryRuntime.forgetMaterializationRecovery(localId),
            onKeepAliveStateMayHaveChanged: () => this.maybeScheduleUserSocketDisconnect(),
        });
        this.updateRuntime = createSessionClientUpdateRuntime({
            sessionId: this.sessionId,
            sessionEncryptionMode: this.sessionEncryptionMode,
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
            getAgentState: () => this.agentState,
            setAgentState: (agentState) => {
                this.agentState = agentState;
            },
            getAgentStateVersion: () => this.agentStateVersion,
            setAgentStateVersion: (version) => {
                this.agentStateVersion = version;
            },
            getPendingMessages: () => this.pendingMessages,
            getPendingMessageCallback: () => this.pendingMessageCallback,
            getUserMessageCallbackAttachedAtMs: () => this.userMessageCallbackAttachedAtMs,
            emit: (event, payload) => this.emit(event, payload),
            hasSelfEchoSuppressedLocalId: (localId) => this.materializationRuntime.hasSelfEchoSuppressedLocalId(localId),
            hasAgentQueueEchoSuppressedLocalId: (localId) => this.materializationRuntime.hasAgentQueueEchoSuppressedLocalId(localId),
            markAgentQueueEchoSuppressedLocalId: (localId) => this.materializationRuntime.markAgentQueueEchoSuppressedLocalId(localId),
            hasPendingQueueMaterializedLocalId: (localId) => this.materializationRuntime.hasPendingQueueMaterializedLocalId(localId),
            deleteMaterializedLocalId: (localId) => this.materializationRuntime.deleteMaterializedLocalId(localId),
            turnAssistantTextSnapshotStore: this.turnAssistantTextSnapshotStore,
            initialLastObservedMessageSeq:
                typeof session.seq === 'number' && Number.isFinite(session.seq) && session.seq >= 0
                    ? Math.trunc(session.seq)
                    : 0,
        });
        this.recoveryRuntime = createSessionClientRecoveryRuntime({
            startupMessageCatchUpRetryDelaysMs: ApiSessionClient.STARTUP_MESSAGE_CATCH_UP_RETRY_DELAYS_MS,
            token: this.token,
            sessionId: this.sessionId,
            getClosed: () => this.closed,
            getSessionConnectionSupervisor: () => this.sessionConnectionSupervisor,
            getCurrentConnectionState: () => this.currentConnectionState,
            getStartedByDaemonProcess: () => this.startedByDaemonProcess,
            getMetadataStartedBy: () => this.metadata?.startedBy ?? null,
            getMetadataStartedFromDaemon: () => this.metadata?.startedFromDaemon ?? null,
            getStartupMessageCatchUpRetryIndex: () => this.startupMessageCatchUpRetryIndex,
            setStartupMessageCatchUpRetryIndex: (value) => {
                this.startupMessageCatchUpRetryIndex = value;
            },
            getStartupMessageCatchUpInitialAfterSeq: () => this.startupMessageCatchUpInitialAfterSeq,
            getLastObservedMessageSeq: () => this.updateRuntime.getLastObservedMessageSeq(),
            getHasMaterializedLocalId: (localId) => this.materializationRuntime.hasMaterializedLocalId(localId),
            deleteMaterializedLocalId: (localId) => this.materializationRuntime.deleteMaterializedLocalId(localId),
            handleUpdate: (update, opts) => this.updateRuntime.handleUpdate(update, opts),
            syncSessionSnapshotFromServer: (opts) => this.syncSessionSnapshotFromServer(opts),
        });
        this.commitQueueRuntime = createSessionClientCommitQueueRuntime({
            sessionId: this.sessionId,
            transcriptStorage: this.transcriptStorage,
            sessionEncryptionMode: this.sessionEncryptionMode,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            getSocket: () => this.socket,
            getClosed: () => this.closed,
            addPendingMaterializedLocalId: (localId) => this.materializationRuntime.addPendingMaterializedLocalId(localId),
            hasPendingMaterializedLocalId: (localId) => this.materializationRuntime.hasMaterializedLocalId(localId),
            markCommittedLocalIdAwaitingEcho: (localId) => this.materializationRuntime.markCommittedLocalIdAwaitingEcho(localId),
            deleteMaterializedLocalId: (localId) => this.materializationRuntime.deleteMaterializedLocalId(localId),
            scheduleMaterializationRecovery: (localId) => {
                this.materializationRuntime.markPendingQueueMaterializedLocalId(localId);
                this.recoveryRuntime.scheduleMaterializationRecovery(localId);
            },
            recoverMaterializedLocalId: (localId, opts) => this.recoveryRuntime.recoverMaterializedLocalId(localId, opts),
            observeCommittedAck: (params) => this.updateRuntime.observeCommittedAck(params),
            requestReconnect: (localId) => {
                const supervisor = this.sessionConnectionSupervisor;
                if (!supervisor) return;
                void supervisor.start().catch((error) => {
                    logger.debug('[API] Failed to restart session socket for queued message', {
                        localId,
                        error,
                    });
                });
            },
        });
        this.transcriptApi = createSessionClientTranscriptApi({
            token: this.token,
            sessionId: this.sessionId,
            turnAssistantTextSnapshotStore: this.turnAssistantTextSnapshotStore,
            outboundShapeLogger: this.outboundShapeLogger,
            getSocket: () => ({
                connected: this.socket?.connected ?? false,
                emit: (event, payload) => {
                    this.socket?.emit?.(event, payload as never);
                },
                volatile: this.socket?.volatile
                    ? {
                        emit: (event, payload) => {
                            this.socket.volatile?.emit?.(event, payload as never);
                        },
                    }
                    : undefined,
            }),
            getSessionConnectionSupervisor: () => this.sessionConnectionSupervisor,
            getMetadataSnapshot: () => this.getMetadataSnapshot(),
            updateAgentState: (handler) => this.updateAgentState(handler),
            updateMetadata: (handler) => this.updateMetadata(handler),
            usageObservationPublisher: this.usageObservationPublisher,
            buildOutboundSessionMessagePayload: (content) => this.commitQueueRuntime.buildOutboundSessionMessagePayload(content),
            commitSessionMessageBestEffort: (params) => this.commitQueueRuntime.commitSessionMessageBestEffort(params),
            enqueueMessageCommit: (fn) => this.commitQueueRuntime.enqueueMessageCommit(fn),
            commitSessionMessage: (params) => this.commitQueueRuntime.commitSessionMessage(params),
            logSendWhileDisconnected: (context, details) => this.logSendWhileDisconnected(context, details),
            markAgentQueueEchoSuppressedLocalId: (localId) => this.materializationRuntime.markAgentQueueEchoSuppressedLocalId(localId),
            toolCallCanonicalNameByProviderAndId: this.toolCallCanonicalNameByProviderAndId,
            permissionToolCallRawInputByProviderAndId: this.permissionToolCallRawInputByProviderAndId,
            toolCallInputByProviderAndId: this.toolCallInputByProviderAndId,
            deliverUserMessageToAgentQueue: (prompt) => {
                if (this.pendingMessageCallback) {
                    this.pendingMessageCallback(prompt);
                } else {
                    this.pendingMessages.push(prompt);
                }
            },
            getTranscriptQueryContext: () => ({
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
            }),
        });

        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            encryptionMode: this.sessionEncryptionMode,
            logger: (msg, data) => logger.debug(msg, data)
        });
        registerSessionClientRuntimeHandlers({
            rpcHandlerManager: this.rpcHandlerManager,
            token: this.token,
            metadataPath: this.metadata?.path ?? process.cwd(),
            metadata: this.metadata,
            sessionId: this.sessionId,
            getSessionMetadata: () => this.getMetadataSnapshot(),
            enqueueSessionUserMessage: (request) => this.enqueueSessionUserMessage(request),
            sendUserTextMessage: (text, opts) => this.sendUserTextMessage(text, opts),
            sendAgentMessage: (provider, body, opts) => this.sendAgentMessage(provider, body, opts),
            sendUserTextMessageCommitted: (text, opts) => this.sendUserTextMessageCommitted(text, opts),
            sendAgentMessageCommitted: (provider, body, opts) => this.sendAgentMessageCommitted(provider, body, opts),
            sendAgentMessageEphemeral: (provider, body, opts) => this.sendAgentMessageEphemeral(provider, body, opts),
            getTranscriptQueryContext: () => ({
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
            }),
            getAgentStateRequestStore: () => this.getAgentStateRequestStore(),
            persistVoiceAgentRunMetadataFromPublicRun: (run, welcomedEpoch) =>
                this.persistVoiceAgentRunMetadataFromPublicRun(run, welcomedEpoch),
            socketEmitExecutionRunUpdated: (run) => {
                if (!this.socket?.connected) {
                    return;
                }
                this.socket.emit('execution-run-updated', { sid: this.sessionId, run } as never);
            },
        });

        this.interactionApi = createSessionClientInteractionApi({
            sessionId: this.sessionId,
            token: this.token,
            getClosed: () => this.closed,
            setClosed: (value) => {
                this.closed = value;
            },
            getSocket: () => this.socket,
            getUserSocket: () => this.userSocket,
            getSessionConnectionSupervisor: () => this.sessionConnectionSupervisor,
            getRpcHandlerManager: () => this.rpcHandlerManager,
            getMetadata: () => this.metadata,
            setMetadata: (metadata) => {
                this.metadata = metadata;
            },
            getMetadataVersion: () => this.metadataVersion,
            setMetadataVersion: (version) => {
                this.metadataVersion = version;
            },
            onMetadataUpdated: (handler) => {
                this.on('metadata-updated', handler);
            },
            offMetadataUpdated: (handler) => {
                this.off('metadata-updated', handler);
            },
            getAgentStateVersion: () => this.agentStateVersion,
            getPendingWakeSeq: () => this.updateRuntime.getPendingWakeSeq(),
            getPendingMessages: () => this.pendingMessages,
            getPendingMessageCallback: () => this.pendingMessageCallback,
            setPendingMessageCallback: (callback) => {
                this.pendingMessageCallback = callback;
            },
            getUserMessageCallbackAttachedAtMs: () => this.userMessageCallbackAttachedAtMs,
            setUserMessageCallbackAttachedAtMs: (value) => {
                this.userMessageCallbackAttachedAtMs = value;
            },
            clearUserSocketDisconnectTimer: () => {
                if (this.userSocketDisconnectTimer) {
                    clearTimeout(this.userSocketDisconnectTimer);
                    this.userSocketDisconnectTimer = null;
                }
            },
            kickUserSocketConnect: () => this.kickUserSocketConnect(),
            catchUpSessionMessages: (afterSeq) => this.recoveryRuntime.catchUpSessionMessages(afterSeq),
            scheduleNextStartupMessageCatchUpRetry: () => this.recoveryRuntime.scheduleNextStartupMessageCatchUpRetry(),
            getLastObservedMessageSeq: () => this.updateRuntime.getLastObservedMessageSeq(),
            getStartedByDaemonProcess: () => this.startedByDaemonProcess,
            getMetadataStartedBy: () => this.metadata?.startedBy ?? null,
            getMetadataStartedFromDaemon: () => this.metadata?.startedFromDaemon ?? null,
            getStartupMessageCatchUpStarted: () => this.startupMessageCatchUpStarted,
            setStartupMessageCatchUpStarted: (value) => {
                this.startupMessageCatchUpStarted = value;
            },
            setStartupMessageCatchUpRetryIndex: (value) => {
                this.startupMessageCatchUpRetryIndex = value;
            },
            setStartupMessageCatchUpInitialAfterSeq: (value) => {
                this.startupMessageCatchUpInitialAfterSeq = value;
            },
            getDaemonInitialPrompt: () => this.daemonInitialPrompt,
            setDaemonInitialPrompt: (value) => {
                this.daemonInitialPrompt = value;
            },
            getDaemonInitialPromptSeeded: () => this.daemonInitialPromptSeeded,
            setDaemonInitialPromptSeeded: (value) => {
                this.daemonInitialPromptSeeded = value;
            },
            enqueueSessionUserMessage: (params) => this.enqueueSessionUserMessage(params),
            syncSessionSnapshotFromServer: (opts) => this.syncSessionSnapshotFromServer(opts),
            maybeScheduleUserSocketDisconnect: () => this.maybeScheduleUserSocketDisconnect(),
            handleSessionScopedUpdate: (data) => this.updateRuntime.handleUpdate(data, { source: 'session-scoped' }),
            clearStartupMessageCatchUpRetryTimer: () => this.recoveryRuntime.clearStartupMessageCatchUpRetryTimer(),
            clearCommittedLocalIdCleanupTimers: () => this.materializationRuntime.clearCommittedLocalIdCleanupTimers(),
            clearAgentQueueEchoSuppressedLocalIdCleanupTimers: () =>
                this.materializationRuntime.clearAgentQueueEchoSuppressedLocalIdCleanupTimers(),
            clearPendingMaterializedState: () => {
                this.materializationRuntime.clearPendingMaterializedState();
                this.commitQueueRuntime.clearState();
            },
            getPendingQueueMaterializedLocalIdsSize: () => this.materializationRuntime.getPendingQueueMaterializedLocalIdsSize(),
            scheduleMaterializationRecovery: (localId) => {
                this.materializationRuntime.markPendingQueueMaterializedLocalId(localId);
                this.recoveryRuntime.scheduleMaterializationRecovery(localId);
            },
            getMetadataLock: () => this.metadataLock,
            getSessionEncryptionMode: () => this.sessionEncryptionMode,
            getEncryptionKey: () => this.encryptionKey,
            getEncryptionVariant: () => this.encryptionVariant,
        });

        const { userSocket, sessionConnectionSupervisor } = initializeSessionClientConnection({
            token: this.token,
            sessionId: this.sessionId,
            getMetadataSnapshot: () => this.metadata,
            setSessionSocket: (socket) => {
                this.socket = socket;
            },
            rpcHandlerManager: this.rpcHandlerManager,
            handleUserScopedUpdate: (data) => this.updateRuntime.handleUpdate(data, { source: 'user-scoped' }),
            installSessionSocketEventHandlers: (socket) => this.interactionApi.installSessionSocketEventHandlers(socket),
            classifyTransportErrorToProbeResult: classifySessionTransportErrorToProbeResult,
            onStateChange: (state) => {
                this.currentConnectionState = state;
            },
            shouldKeepUserSocketConnected: () =>
                this.materializationRuntime.shouldKeepUserSocketConnected({
                    hasPendingMessageCallback: this.pendingMessageCallback !== null,
                    hasQueuedDisconnectedSessionMessages: this.commitQueueRuntime.queuedDisconnectedSessionMessages.size > 0,
                }),
            kickUserSocketConnect: () => this.kickUserSocketConnect(),
            syncChangesOnConnect: (opts) => this.recoveryRuntime.syncChangesOnConnect(opts),
            shouldSyncSessionSnapshotOnConnect: () =>
                shouldSyncSessionSnapshotOnConnect({ metadataVersion: this.metadataVersion, agentStateVersion: this.agentStateVersion }),
            syncSessionSnapshotFromServer: (opts) => this.syncSessionSnapshotFromServer(opts),
            flushQueuedSessionMessagesOnReconnect: () => this.commitQueueRuntime.flushQueuedSessionMessagesOnReconnect(),
            markConnected: () => {
                this.disconnectedSendLogged = false;
                const reason = this.hasConnectedOnce ? 'reconnect' : 'connect';
                this.hasConnectedOnce = true;
                return reason;
            },
        });
        this.userSocket = userSocket;
        this.sessionConnectionSupervisor = sessionConnectionSupervisor;
        void this.sessionConnectionSupervisor.start();
    }

    private syncSessionSnapshotFromServer(opts: { reason: 'connect' | 'waitForMetadataUpdate' | 'primaryTurnRuntimeState' }): Promise<void> {
        if (this.closed) return Promise.resolve();
        if (this.snapshotSyncInFlight) return this.snapshotSyncInFlight;

        const p = (async () => {
            try {
                await syncSessionSnapshotFromServer({
                    token: this.token,
                    sessionId: this.sessionId,
                    encryptionKey: this.encryptionKey,
                    encryptionVariant: this.encryptionVariant,
                    currentMetadataVersion: this.metadataVersion,
                    currentAgentStateVersion: this.agentStateVersion,
                    currentMetadata: this.metadata,
                    currentAgentState: this.agentState,
                    sessionConnectionSupervisor: this.sessionConnectionSupervisor,
                    isClosed: () => this.closed,
                    setMetadataSnapshot: (metadata, version) => {
                        this.metadata = metadata;
                        this.metadataVersion = version;
                        this.emit('metadata-updated');
                    },
                    setAgentStateSnapshot: (agentState, version) => {
                        this.agentState = agentState;
                        this.agentStateVersion = version;
                    },
                });
            } catch (error) {
                logger.debug('[API] Failed to sync session snapshot from server', { reason: opts.reason, error });
            }
        })();

        const inFlight = p.finally(() => {
            if (this.snapshotSyncInFlight === inFlight) {
                this.snapshotSyncInFlight = null;
            }
        });
        this.snapshotSyncInFlight = inFlight;

        return this.snapshotSyncInFlight;
    }

    private kickUserSocketConnect(): void {
        if (this.closed) return;
        if (
            !this.socket?.connected
            && this.currentConnectionState.phase !== 'online'
            && this.currentConnectionState.phase !== 'connecting'
        ) {
            return;
        }
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
        if (this.materializationRuntime.shouldKeepUserSocketConnected({
            hasPendingMessageCallback: this.pendingMessageCallback !== null,
            hasQueuedDisconnectedSessionMessages: this.commitQueueRuntime.queuedDisconnectedSessionMessages.size > 0,
        })) return;
        if (!this.userSocket.connected) return;
        if (this.userSocketDisconnectTimer) return;

        // Short idle grace to avoid thrashing if multiple pending items get materialized back-to-back.
        this.userSocketDisconnectTimer = setTimeout(() => {
            this.userSocketDisconnectTimer = null;
            if (this.materializationRuntime.shouldKeepUserSocketConnected({
                hasPendingMessageCallback: this.pendingMessageCallback !== null,
                hasQueuedDisconnectedSessionMessages: this.commitQueueRuntime.queuedDisconnectedSessionMessages.size > 0,
            })) return;
            if (!this.userSocket.connected) return;
            try {
                this.userSocket.disconnect();
            } catch {
                // ignore
            }
        }, 2_000);
        this.userSocketDisconnectTimer.unref?.();
    }

    private shouldRunStartupTranscriptCatchUp(): boolean {
        return this.startedByDaemonProcess
            || this.metadata?.startedBy === 'daemon'
            || this.metadata?.startedFromDaemon === true;
    }

    private async catchUpSessionMessages(afterSeq: number): Promise<void> {
        await catchUpSessionMessagesViaPort({
            closed: this.closed,
            token: this.token,
            sessionId: this.sessionId,
            sessionConnectionSupervisor: this.sessionConnectionSupervisor,
            recoveryRuntime: this.recoveryRuntime,
            startupMessageCatchUpInitialAfterSeq: this.startupMessageCatchUpInitialAfterSeq,
            startupMessageCatchUpRetryIndex: this.startupMessageCatchUpRetryIndex,
            startupMessageCatchUpRetryTimer: null,
            pendingMessages: this.pendingMessages,
            pendingMessageCallback: this.pendingMessageCallback,
            userMessageCallbackAttachedAtMs: this.userMessageCallbackAttachedAtMs,
            startupMessageCatchUpStarted: this.startupMessageCatchUpStarted,
            daemonInitialPrompt: this.daemonInitialPrompt,
            daemonInitialPromptSeeded: this.daemonInitialPromptSeeded,
            lastObservedMessageSeq: this.lastObservedMessageSeq,
            enqueueSessionUserMessage: (params) => this.enqueueSessionUserMessage(params),
            catchUpSessionMessages: (nextAfterSeq) => this.catchUpSessionMessages(nextAfterSeq),
            scheduleNextStartupMessageCatchUpRetry: () => this.scheduleNextStartupMessageCatchUpRetry(),
            shouldRunStartupTranscriptCatchUp: () => this.shouldRunStartupTranscriptCatchUp(),
            kickUserSocketConnect: () => this.kickUserSocketConnect(),
            classifyTransportErrorToProbeResult: (error) => classifySessionTransportErrorToProbeResult(error),
            handleCatchUpUpdate: (update) =>
                (this as unknown as {
                    handleUpdate: (data: unknown, opts: { source: 'session-scoped' | 'user-scoped' }) => void;
                }).handleUpdate(update, { source: 'session-scoped' }),
        }, afterSeq);
    }

    private scheduleNextStartupMessageCatchUpRetry(): void {
        scheduleNextStartupCatchUpRetryViaPort(this as unknown as Parameters<typeof scheduleNextStartupCatchUpRetryViaPort>[0], ApiSessionClient.STARTUP_MESSAGE_CATCH_UP_RETRY_DELAYS_MS);
    }

    onUserMessage(callback: (data: UserMessage) => void) {
        if (this.interactionApi) {
            this.interactionApi.onUserMessage(callback);
            return;
        }
        attachSessionUserMessageHandler(this as unknown as Parameters<typeof attachSessionUserMessageHandler>[0], callback);
    }

    waitForMetadataUpdate(abortSignal?: AbortSignal): Promise<boolean> {
        return this.interactionApi.waitForMetadataUpdate(abortSignal);
    }

    /**
     * Ensure we have a decrypted metadata snapshot from the server.
     *
     * Unlike waitForMetadataUpdate(), this does not resolve early just because the socket connected.
     * It resolves only once metadataVersion is >= 0 and metadata is available (or times out).
     */
    async ensureMetadataSnapshot(opts?: { timeoutMs?: number; abortSignal?: AbortSignal }): Promise<Metadata | null> {
        return await this.interactionApi.ensureMetadataSnapshot(opts);
    }

    /**
     * Force a session snapshot sync from the server.
     *
     * This is useful when metadata/agentState may have been updated by another client (e.g. daemon RPC)
     * and this runner needs the latest snapshot before making turn decisions (e.g. replaySeedV1).
     */
    async refreshSessionSnapshotFromServerBestEffort(opts?: { reason?: 'connect' | 'waitForMetadataUpdate' | 'primaryTurnRuntimeState' }): Promise<void> {
        await this.interactionApi.refreshSessionSnapshotFromServerBestEffort(opts);
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendProviderMessage(request: Parameters<SessionClientTranscriptApi['sendProviderMessage']>[0]) {
        this.transcriptApi.sendProviderMessage(request);
    }

    // Compat-only wrapper for existing Claude-owned callers. New callers should use sendProviderMessage().
    sendClaudeSessionMessage(body: import('@/backends/claude/contracts/rawJsonLines').RawJSONLines, meta?: Record<string, unknown>) {
        this.sendProviderMessage({ provider: 'claude', body, meta });
    }

    // Compat-only wrapper for existing Codex-owned callers. New callers should use sendProviderMessage().
    sendCodexMessage(body: any) {
        this.sendProviderMessage({ provider: 'codex', body });
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
        this.transcriptApi.sendAgentMessage(provider, body, opts);
    }

    sendUserTextMessage(text: string, opts?: { localId?: string; meta?: Record<string, unknown> }) {
        this.transcriptApi.sendUserTextMessage(text, opts);
    }

    async sendUserTextMessageCommitted(
        text: string,
        opts: { localId: string; meta?: Record<string, unknown> },
    ): Promise<void> {
        await this.transcriptApi.sendUserTextMessageCommitted(text, opts);
    }

    private enqueueSessionUserMessage(params: Readonly<{
        text: string;
        localId?: string;
        meta?: Record<string, unknown>;
    }>): void {
        this.transcriptApi.enqueueSessionUserMessage(params);
    }

    async sendAgentMessageCommitted(
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown> },
    ): Promise<void> {
        await this.transcriptApi.sendAgentMessageCommitted(provider, body, opts);
    }

    async sendAgentSessionMediaCommitted(
        provider: ACPProvider,
        request: SendAgentSessionMediaCommittedRequest,
    ): Promise<void> {
        await this.transcriptApi.sendAgentSessionMediaCommitted(provider, request);
    }

    sendAgentMessageEphemeral(
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> },
    ): void {
        this.transcriptApi.sendAgentMessageEphemeral(provider, body, opts);
    }

    async fetchRecentTranscriptTextItemsForAcpImport(opts?: { take?: number }): Promise<Array<{ role: 'user' | 'agent'; text: string }>> {
        return this.transcriptApi.fetchRecentTranscriptTextItemsForAcpImport(opts);
    }

    async fetchLatestUserPermissionIntentFromTranscript(opts?: { take?: number }): Promise<{ intent: import('../types').PermissionMode; updatedAt: number } | null> {
        return this.transcriptApi.fetchLatestUserPermissionIntentFromTranscript(opts);
    }

    sendSessionEvent(event: SessionEventMessage, id?: string) {
        this.transcriptApi.sendSessionEvent(event, id);
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        this.transcriptApi.keepAlive(thinking, mode);
    }

    /**
     * Send session death message
     */
    sendSessionDeath() {
        this.transcriptApi.sendSessionDeath();
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    updateMetadata(handler: (metadata: Metadata) => Metadata): Promise<void> {
        return this.metadataLock.inLock(async () => {
            await updateSessionMetadataWithAck({
                socket: this.socket as any,
                sessionId: this.sessionId,
                sessionEncryptionMode: this.sessionEncryptionMode,
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

    private persistVoiceAgentRunMetadataFromPublicRun(run: unknown, welcomedEpoch?: number): void {
        if (!run || typeof run !== 'object' || (run as any).intent !== 'voice_agent') {
            return;
        }
        void this.updateMetadata((metadata) => {
            const next = mergeVoiceAgentRunMetadataFromExecutionRun({
                metadata: isRecord(metadata) ? metadata : {},
                run: run as any,
                ...(typeof welcomedEpoch === 'number' ? { welcomedEpoch } : {}),
            });
            return (next ?? {}) as Metadata;
        }).catch((error) => {
            logger.debug('[API] Failed to persist voiceAgentRunV1 metadata (non-fatal)', {
                runId: typeof (run as any)?.runId === 'string' ? (run as any).runId : null,
                error,
            });
        });
    }

    /**
     * Update session agent state
     * @param handler - Handler function that returns the updated agent state
     */
    updateAgentState(handler: (metadata: AgentState) => AgentState): Promise<void> {
        logger.debugLargeJson('Updating agent state', this.agentState);
        return this.agentStateLock.inLock(async () => {
            await updateSessionAgentStateWithAck({
                socket: this.socket as any,
                sessionId: this.sessionId,
                sessionEncryptionMode: this.sessionEncryptionMode,
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

    updatePrimaryTurnRuntimeState(state: {
        latestTurnStatus: PrimaryTurnStatusV1;
        lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
    }): Promise<void> {
        return this.agentStateLock.inLock(async () => {
            await updateSessionAgentStateWithAck({
                socket: this.socket as any,
                sessionId: this.sessionId,
                sessionEncryptionMode: this.sessionEncryptionMode,
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
                syncSessionSnapshotFromServer: () => this.syncSessionSnapshotFromServer({ reason: 'primaryTurnRuntimeState' }),
                handler: (agentState) => agentState,
                runtimeIssueSummaryV1: state,
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

    /**
     * Read-only snapshot of the last transcript message seq observed by this client.
     *
     * Used for provider integrations that need to distinguish "fresh" sessions from sessions that
     * already contain imported history or prior user prompts (e.g. resume history import).
     */
    getLastObservedMessageSeq(): number {
        return this.lastObservedMessageSeq;
    }

    getLastObservedUserMessageSeq(): number {
        return this.lastObservedUserMessageSeq;
    }

    getTurnAssistantTextSnapshotStore(): TurnAssistantTextSnapshotStore {
        return this.turnAssistantTextSnapshotStore;
    }

    async close() {
        await this.interactionApi.close();
    }

    async listPendingMessageQueueV2LocalIds(): Promise<string[]> {
        return await this.interactionApi.listPendingMessageQueueV2LocalIds();
    }

    async peekPendingMessageQueueV2Count(): Promise<number> {
        return await this.interactionApi.peekPendingMessageQueueV2Count();
    }

    async discardPendingMessageQueueV2All(opts: { reason: 'switch_to_local' | 'manual' }): Promise<number> {
        return await this.interactionApi.discardPendingMessageQueueV2All(opts);
    }

    async discardCommittedMessageLocalIds(opts: { localIds: string[]; reason: 'switch_to_local' | 'manual' }): Promise<number> {
        return await this.interactionApi.discardCommittedMessageLocalIds(opts);
    }

    async popPendingMessage(): Promise<boolean> {
        return await this.interactionApi.popPendingMessage();
    }
}

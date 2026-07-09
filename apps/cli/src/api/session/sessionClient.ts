import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, Metadata, ServerToClientEvents, Session, UserMessage } from '../types'
import { AsyncLock } from '@/utils/lock';
import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { shouldSyncSessionSnapshotOnConnect } from './snapshotSync';
import {
    updateSessionAgentStateWithAck,
    updateSessionMetadataWithAck,
    updateSessionRuntimeActivityProjectionWithAck,
} from './stateUpdates';
import { readAuthenticationStatus } from '@/api/client/httpStatusError';
import type { ACPMessageData, ACPProvider, SessionEventMessage } from './sessionMessageTypes';
import {
    canReceiveDaemonInitialPrompt,
    consumeDaemonInitialPromptFromEnv,
} from '@/agent/runtime/daemonInitialPrompt';
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
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import type { BrowserContextRoutes } from '@/daemon/browser/context/routes';
import type { BrowserAutomationRoutes } from '@/daemon/browser/automation/routes';
import type { BrowserDiagnosticsActionRoutes } from '@/daemon/browser/diagnostics/actionRoutes';
import type { BrowserRecordingRoutes } from '@/daemon/browser/recording/routes';
import type {
    BrowserRecordingComposerAttachInput,
    BrowserRecordingComposerAttachResult,
} from '@/daemon/browser/recording/attachToComposer';
import type { LocalServicesRuntimeActionRoutes } from '@/daemon/local/services/actions/runtimeActionExecutor';
import type { DaemonPeerMediationObservabilityRuntimeActionContext } from '@/daemon/peer/mediation/observability/runtimeActionExecutor';
import type { SimulatorPreviewRoutes } from '@/daemon/devices/simulator/previewRoutes.types';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
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
import {
    readSessionCatchUpAuthorization,
    type SessionCatchUpAuthorization,
    type SessionCatchUpRequest,
} from './sessionChangesSyncOnConnect';
import { createSessionClientMaterializationRuntime } from './client/lifecycle/createSessionClientMaterializationRuntime';
import { createSessionClientCommitQueueRuntime } from './client/transport/createSessionClientCommitQueueRuntime';
import { createSessionClientUpdateRuntime } from './client/transport/createSessionClientUpdateRuntime';
import {
    createSessionClientDurableMutationOutbox,
    type SessionClientDurableMutationOutbox,
} from './client/transport/mutations/createSessionClientDurableMutationOutbox';
import { applySessionRuntimeControls } from './sessionRuntimeControls';
import {
    createSessionEndMutation,
    createTranscriptMessageAppendMutation,
    type RegisteredSessionStateFieldMutationV1,
    type SessionClientDurableMutationSocket,
    type SessionEndMutationV1,
} from './client/transport/mutations/sessionClientDurableMutationTypes';
import { applyRegisteredSessionStateFieldMutationToMetadata } from './client/transport/mutations/applyRegisteredSessionStateFieldMutation';
import {
    CommittedUserMessageSeqTracker,
    type CommittedUserMessageSeqWaitOptions,
} from './committedUserMessageSeqTracker';
import {
    mergeDeliveredUserMessageSeqV1,
    mergeLocallyConsumedUserMessageSeqsV1,
    mergeProviderAcceptedUserMessageSeqV1,
    mergeUserMessageDeliveryWatermarkModeV1,
    readDeliveredUserMessageSeqV1,
    readLocallyConsumedUserMessageSeqsV1,
    readProviderAcceptedUserMessageSeqV1,
} from './deliveredUserMessageSeq';
import {
    catchUpSessionMessagesViaPort,
    scheduleNextStartupCatchUpRetryViaPort,
} from './client/lifecycle/startupCatchUpRuntime';
import type { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import type {
    SessionRuntimeActivitySourceClassV1,
    SessionSystemRecord,
    SessionSystemRecordNamespace,
    SessionSystemRecordUpsertRequest,
    SessionTurnMutationV1,
} from '@happier-dev/protocol';
import { SessionRuntimeActivityProjectionV1Schema } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { countMaterializablePendingRows, readKnownPendingQueueState, UNKNOWN_PENDING_QUEUE_STATE, type KnownPendingQueueState, type PendingQueueState } from './pendingQueueState';
import type { SessionSnapshotRefreshReason } from './sessionSnapshotRefreshReason';
import type {
    PendingMaterializationActiveTurnPolicy,
    ProviderAcceptancePendingMaterializationPolicy,
} from './pendingMaterializationActiveTurnPolicy';
import {
    normalizeProviderAcceptancePendingMaterializationPolicy,
    recoversProviderDeliveryAttachBeforeMaterialization,
} from './pendingMaterializationActiveTurnPolicy';
import type {
    LocallyConsumedUserMessageConfirmation,
    MaterializeNextPendingResult,
    ProviderUserMessageDeliveryAcceptance,
    UserMessageLocalConsumptionQuery,
    UserMessageProviderAcceptanceQuery,
} from './sessionClientPort';
import { isSessionContinuationRecoveryBlockingPendingDrain } from '@happier-dev/protocol';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import {
    fetchSessionSystemRecord as fetchSessionSystemRecordHttp,
    upsertSessionSystemRecord as upsertSessionSystemRecordHttp,
} from '@/session/transport/http/sessionSystemRecordsHttp';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { serializeAxiosErrorForLog } from '../client/serializeAxiosErrorForLog';
import { notifyDaemonConnectedServiceTurnLifecycle as notifyDaemonConnectedServiceTurnLifecycleViaControl } from '@/daemon/controlClient';
import { readLatestTurnStatusSnapshot } from './sessionTurnStatusSnapshot';
import {
    blockPendingQueueV2ProviderDeliveriesOnAttach,
    blockPendingQueueV2Delivery,
    listPendingQueueV2LocalIdsFromServer,
    listPendingQueueV2ProviderDeliveryLocalIdsFromServer,
    reconcileAcceptedPendingQueueV2DeliveriesThroughSeq,
    resolveAcceptedPendingQueueV2Delivery,
    retryPendingQueueV2Delivery,
    type PendingMaterializationDeliveryState,
    type PendingMaterializationDeliveryTiming,
    type PendingQueueDeliveryBlockedReason,
} from './pendingQueueV2Transport';
import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import {
    shouldDeferPendingQueueDrainForRuntimeActivity,
    type PendingQueueRuntimeActivityProjection,
} from '@/agent/runtime/session/input/pendingQueueDrainPolicy';

const SESSION_CLIENT_TOOL_CALL_CACHE_MAX_ENTRIES = 1_000;

type DurableMutationSocketTransport = Readonly<{
    connected: boolean;
    emit(event: string, payload: unknown, callback?: (answer: unknown) => void): unknown;
    emitWithAck?: (event: string, ...args: unknown[]) => Promise<unknown>;
    timeout?: (ms: number) => DurableMutationSocketTransport;
}>;

function adaptDurableMutationSocket(
    socket: Socket<ServerToClientEvents, ClientToServerEvents> | null | undefined,
): SessionClientDurableMutationSocket | null {
    if (!socket) return null;
    const durableSocket = socket as unknown as DurableMutationSocketTransport;
    return {
        connected: durableSocket.connected,
        emit: (event, payload, callback) => {
            if (callback) {
                durableSocket.emit(event, payload, callback);
                return;
            }
            durableSocket.emit(event, payload);
        },
        emitWithAck: typeof durableSocket.emitWithAck === 'function'
            ? (event, ...args) => durableSocket.emitWithAck!(event, ...args)
            : undefined,
        timeout: typeof durableSocket.timeout === 'function'
            ? (ms) => adaptDurableMutationSocket(durableSocket.timeout!(ms) as unknown as Socket<ServerToClientEvents, ClientToServerEvents>)!
            : undefined,
    };
}

type RuntimeActivityProjectionWrite = Readonly<{
    runtimeActivityActiveCount: number;
    runtimeActivityObservedAt: number | null;
    runtimeActivityExpiresAt: number | null;
    runtimeActivitySourceClass: SessionRuntimeActivitySourceClassV1 | null;
}>;

type RuntimeActivityProjectionForPendingDrain = PendingQueueRuntimeActivityProjection;

function clearRuntimeActivityProjectionWrite(): RuntimeActivityProjectionWrite {
    return {
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: null,
        runtimeActivityExpiresAt: null,
        runtimeActivitySourceClass: null,
    };
}

function readRuntimeActivityProjectionForPendingDrain(value: unknown): RuntimeActivityProjectionForPendingDrain {
    if (!value || typeof value !== 'object') return {};
    const record = value as Record<string, unknown>;
    return {
        runtimeActivityActiveCount: record.runtimeActivityActiveCount,
        runtimeActivityObservedAt: record.runtimeActivityObservedAt,
        runtimeActivityExpiresAt: record.runtimeActivityExpiresAt,
        runtimeActivitySourceClass: record.runtimeActivitySourceClass,
    };
}

function readRuntimeActivityProjectionWriteFromRegisteredMutation(
    mutation: RegisteredSessionStateFieldMutationV1,
): RuntimeActivityProjectionWrite | null {
    if (mutation.fieldId !== 'runtime.activity') {
        return null;
    }
    if (mutation.op.kind === 'clear') {
        return clearRuntimeActivityProjectionWrite();
    }

    const parsed = SessionRuntimeActivityProjectionV1Schema.safeParse(mutation.op.value);
    if (!parsed.success) {
        return clearRuntimeActivityProjectionWrite();
    }
    return {
        runtimeActivityActiveCount: parsed.data.activeCount,
        runtimeActivityObservedAt: parsed.data.observedAtMs,
        runtimeActivityExpiresAt: parsed.data.expiresAtMs,
        runtimeActivitySourceClass: parsed.data.sourceClass,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readRecordProperty(value: unknown, key: string): unknown {
    return isRecord(value) ? value[key] : undefined;
}

function readHttpErrorResponseStatus(error: unknown): number | null {
    const status = readRecordProperty(readRecordProperty(error, 'response'), 'status');
    return typeof status === 'number' && Number.isSafeInteger(status) ? status : null;
}

function readHttpErrorResponseErrorCode(error: unknown): string | null {
    const raw = readRecordProperty(readRecordProperty(readRecordProperty(error, 'response'), 'data'), 'error');
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function isTerminalPendingDeliveryNotFound(error: unknown): boolean {
    return readHttpErrorResponseStatus(error) === 404
        && readHttpErrorResponseErrorCode(error) === 'not-found';
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

const SESSION_CONNECTION_STATE_EVENT = 'session-connection-state';
const PENDING_QUEUE_MATERIALIZE_RETRY_INITIAL_DELAY_MS = 250;
const PENDING_QUEUE_MATERIALIZE_RETRY_MAX_DELAY_MS = 15_000;

function resolvePendingQueueMaterializeRetryDelayMs(attempt: number): number {
    const boundedAttempt = Math.max(0, Math.min(16, Math.trunc(attempt)));
    return Math.min(
        PENDING_QUEUE_MATERIALIZE_RETRY_MAX_DELAY_MS,
        PENDING_QUEUE_MATERIALIZE_RETRY_INITIAL_DELAY_MS * (2 ** boundedAttempt),
    );
}

type SessionSocketAckWriteEvent = 'update-metadata' | 'update-state' | 'update-runtime-activity';

type SessionSocketNotReadyError = Error & Readonly<{
    code: 'socket_not_connected' | 'socket_auth_failed' | 'session_closed';
    event: SessionSocketAckWriteEvent;
    retryable: boolean;
}>;

function createSessionSocketNotReadyError(params: Readonly<{
    code: SessionSocketNotReadyError['code'];
    event: SessionSocketAckWriteEvent;
    message: string;
    retryable: boolean;
}>): SessionSocketNotReadyError {
    const error = new Error(params.message) as SessionSocketNotReadyError;
    Object.defineProperty(error, 'code', { value: params.code, enumerable: true });
    Object.defineProperty(error, 'event', { value: params.event, enumerable: true });
    Object.defineProperty(error, 'retryable', { value: params.retryable, enumerable: true });
    return error;
}

export type ApiSessionClientOptions = Readonly<{
    getBrowserDaemonControlRoutes?: (() => BrowserDaemonControlRoutes | null) | null;
    getBrowserDaemonContextRoutes?: (() => BrowserContextRoutes | null) | null;
    getBrowserDaemonAutomationRoutes?: (() => BrowserAutomationRoutes | null) | null;
    getBrowserDiagnosticsActionRoutes?: (() => BrowserDiagnosticsActionRoutes | null) | null;
    getBrowserRecordingRoutes?: (() => BrowserRecordingRoutes | null) | null;
    attachBrowserRecordingToComposer?: (
        input: BrowserRecordingComposerAttachInput,
    ) => Promise<BrowserRecordingComposerAttachResult>;
    getLocalServicesRuntimeActionRoutes?: (() => LocalServicesRuntimeActionRoutes | null) | null;
    getSimulatorPreviewRoutes?: (() => SimulatorPreviewRoutes | null) | null;
    getPeerMediationObservabilityRuntimeActionContext?: (() => DaemonPeerMediationObservabilityRuntimeActionContext | null) | null;
    getServerFeaturesSnapshot?: (() => CliServerFeaturesSnapshot | undefined) | null;
    transformSessionInputBeforeCommit?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
    localMachineId?: string | null;
}>;

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
    private pendingMessageCallback: ((message: UserMessage) => boolean | void) | null = null;
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
    private snapshotSyncInFlight: Promise<boolean> | null = null;
    private readonly toolCallCanonicalNameByProviderAndId = new Map<string, { rawToolName: string; canonicalToolName: string }>();
    private readonly permissionToolCallRawInputByProviderAndId = new Map<string, unknown>();
    private readonly toolCallInputByProviderAndId = new Map<string, unknown>();
    private hasConnectedOnce = false;
    /** Bumped on every session socket connect; lets the streamed transcript writer resync after reconnects. */
    private ephemeralStreamConnectionEpoch = 0;
    private daemonInitialPrompt: string | null = null;
    private daemonInitialPromptSeeded = false;
    private startupMessageCatchUpStarted = false;
    private startupMessageCatchUpRetryIndex = 0;
    private startupMessageCatchUpInitialAfterSeq = 0;
    private startupMessageCatchUpInitialAfterSeqIsExplicit = false;
    private startupMessageCatchUpInitialAuthorization: SessionCatchUpAuthorization = 'startup_recovery';
    private readonly startupMessageCatchUpExplicitAfterSeq: number | null;
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
    private readonly durableMutationOutbox: SessionClientDurableMutationOutbox;
    private readonly committedUserMessageSeqTracker = new CommittedUserMessageSeqTracker();
    private readonly providerAcceptedUserMessageLocalIdsAwaitingSeq = new Set<string>();
    private readonly providerAcceptedUserMessageLocalIdCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly locallyConsumedUserMessageSeqs = new Set<number>();
    private readonly locallyConsumedUserMessageLocalIdsAwaitingSeq = new Set<string>();
    private readonly locallyConsumedUserMessageLocalIdCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private providerDeliveryAttachRecoveryCompleted = false;
    private providerDeliveryAttachRecoveryInFlight: Promise<void> | null = null;
    private pendingMaterializeRetryWakeTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingMaterializeRetryAttempt = 0;
    private providerAcceptancePendingMaterializationPolicy: ProviderAcceptancePendingMaterializationPolicy = 'claimUntilProviderAccept';
    private runtimeActivityProjection: RuntimeActivityProjectionForPendingDrain = {};
    private highestDeliveredUserMessageSeq: number | null = null;
    private highestProviderAcceptedUserMessageSeq: number | null = null;
    private deliveredUserMessageSeqPersistInFlight = false;
    /**
     * HF-1 (A3-HIGH-1): when a launcher with a provider-acceptance seam opts in, the queue-handoff
     * leg stops persisting the owed-delivery watermark; only `confirmUserMessageDeliveredToProvider`
     * (provider acceptance) advances it. Unconfirmed rows keep the watermark behind: at-least-once
     * redelivery on resume, never silent loss. Echo-proven legs keep persist-at-echo (their custody
     * chain never carries the seq through the queue).
     */
    private deferDeliveredUserMessageWatermark = false;
    private readonly canonicalPendingDeliveryByLocalId = new Map<string, PendingMaterializationDeliveryState>();
    private readonly acceptedCanonicalPendingDeliveryRetryLocalIds = new Set<string>();
    private owedUserMessageCatchUpInFlight = false;
    private lastOwedUserMessageCatchUpAt = 0;
    private readonly pendingSessionTurnMutationUpdates = new Set<Promise<void>>();
    private readonly pendingSessionEndMutationUpdates = new Set<Promise<void>>();
    private readonly pendingTranscriptMessageUpdates = new Set<Promise<unknown>>();
    private readonly pendingProviderTranscriptDispatches = new Set<Promise<unknown>>();
    private readonly pendingRegisteredSessionStateFieldUpdates = new Set<Promise<void>>();
    private readonly sessionRuntimeControls: Partial<SessionRuntimeControls> = {};
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

    private get providerTranscriptDispatchTail(): Promise<unknown> {
        return Promise.all([...this.pendingProviderTranscriptDispatches].map((update) =>
            update.catch(() => undefined),
        ));
    }

    private isSessionSocketOnlineForAckWrite(): boolean {
        return (this.socket as Socket<ServerToClientEvents, ClientToServerEvents> | undefined)?.connected === true
            || this.currentConnectionState.phase === 'online';
    }

    private async waitForSessionSocketOnlineForAckWrite(event: SessionSocketAckWriteEvent): Promise<void> {
        if (this.isSessionSocketOnlineForAckWrite()) return;
        if (this.closed) {
            throw createSessionSocketNotReadyError({
                code: 'session_closed',
                event,
                message: `${event} session is closed`,
                retryable: false,
            });
        }

        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) return;

        const timeoutMs = resolveSessionControlSocketConnectTimeoutMs();
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | null = null;
            const cleanup = () => {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                this.off(SESSION_CONNECTION_STATE_EVENT, onStateChange);
            };
            const settle = (fn: () => void) => {
                if (settled) return;
                settled = true;
                cleanup();
                fn();
            };
            const check = () => {
                if (this.isSessionSocketOnlineForAckWrite()) {
                    settle(() => resolve());
                    return;
                }
                if (this.closed) {
                    settle(() => reject(createSessionSocketNotReadyError({
                        code: 'session_closed',
                        event,
                        message: `${event} session is closed`,
                        retryable: false,
                    })));
                    return;
                }
                if (this.currentConnectionState.phase === 'auth_failed') {
                    settle(() => reject(createSessionSocketNotReadyError({
                        code: 'socket_auth_failed',
                        event,
                        message: `${event} session socket authentication failed`,
                        retryable: false,
                    })));
                }
            };
            const onStateChange = () => check();

            this.on(SESSION_CONNECTION_STATE_EVENT, onStateChange);
            timer = setTimeout(() => {
                settle(() => reject(createSessionSocketNotReadyError({
                    code: 'socket_not_connected',
                    event,
                    message: `${event} socket is not connected`,
                    retryable: true,
                })));
            }, timeoutMs);
            timer.unref?.();

            void supervisor.start().catch((error) => {
                settle(() => reject(error));
            });
            check();
        });
    }

    private readDeliveredUserMessageWatermarkState(): Readonly<{
        persisted: number | null;
        inMemory: number | null;
        effective: number | null;
        providerAccepted: number | null;
    }> {
        const persisted = readDeliveredUserMessageSeqV1(this.metadata as unknown as Record<string, unknown> | null);
        const persistedProviderAccepted = readProviderAcceptedUserMessageSeqV1(this.metadata as unknown as Record<string, unknown> | null);
        const inMemory = this.highestDeliveredUserMessageSeq;
        const providerAccepted = Math.max(
            persistedProviderAccepted ?? -1,
            this.highestProviderAcceptedUserMessageSeq ?? -1,
        );
        const effective = this.deferDeliveredUserMessageWatermark
            ? providerAccepted
            : Math.max(persisted ?? -1, inMemory ?? -1);
        return {
            persisted,
            inMemory,
            effective: effective >= 0 ? effective : null,
            providerAccepted: providerAccepted >= 0 ? providerAccepted : null,
        };
    }

    getDeliveredUserMessageSeq(): number | null {
        return this.readDeliveredUserMessageWatermarkState().effective;
    }

    getProviderAcceptedUserMessageSeq(): number | null {
        return this.readDeliveredUserMessageWatermarkState().providerAccepted;
    }

    private applyPendingDeliveryActionQueueState(state: KnownPendingQueueState | null | undefined): void {
        if (!state) return;
        if (this.materializationRuntime.applyPendingQueueState(state)) {
            this.emit('metadata-updated');
        }
    }

    private clearCanonicalPendingDeliveryLocalState(localId: string): boolean {
        let didClear = false;
        if (this.canonicalPendingDeliveryByLocalId.delete(localId)) didClear = true;
        if (this.acceptedCanonicalPendingDeliveryRetryLocalIds.delete(localId)) didClear = true;
        if (didClear) {
            this.materializationRuntime.deleteMaterializedLocalId(localId);
            this.clearProviderAcceptedUserMessageLocalIdAwaitingSeq(localId);
        }
        return didClear;
    }

    private async retireStaleCanonicalPendingDeliveryAfterTerminalMiss(
        localId: string,
        operation: 'accepted' | 'block',
        error: unknown,
    ): Promise<boolean> {
        if (!isTerminalPendingDeliveryNotFound(error)) return false;

        const didClear = this.clearCanonicalPendingDeliveryLocalState(localId);
        if (!didClear) return true;

        logger.debug('[pendingQueue] retired stale provider delivery claim after server not-found', {
            sessionId: this.sessionId,
            localId,
            operation,
        });

        let reconciled = false;
        try {
            reconciled = await this.interactionApi.reconcilePendingQueueState({ force: true });
        } catch (reconcileError) {
            logger.debug('[pendingQueue] stale provider delivery claim reconcile failed after terminal miss', {
                sessionId: this.sessionId,
                localId,
                operation,
                error: serializeAxiosErrorForLog(reconcileError),
            });
        }

        if (!reconciled && !this.closed) {
            this.emit('metadata-updated');
        }
        return true;
    }

    private shouldRequestProviderDeliveryState(): boolean {
        return this.deferDeliveredUserMessageWatermark
            && recoversProviderDeliveryAttachBeforeMaterialization(this.providerAcceptancePendingMaterializationPolicy);
    }

    private readAcceptedUserMessageDeliverySeqForPendingReconciliation(): number | null {
        const watermarkState = this.readDeliveredUserMessageWatermarkState();
        return this.deferDeliveredUserMessageWatermark
            ? watermarkState.providerAccepted
            : watermarkState.effective;
    }

    private async reconcileAcceptedPendingDeliveriesThroughSeq(
        maxAcceptedSeq: number,
    ): Promise<Readonly<{ pendingQueueState?: KnownPendingQueueState; resolvedLocalIds: string[] }>> {
        if (this.closed || !Number.isSafeInteger(maxAcceptedSeq) || maxAcceptedSeq <= 0) {
            return { resolvedLocalIds: [] };
        }
        const request = async () => await reconcileAcceptedPendingQueueV2DeliveriesThroughSeq({
            token: this.token,
            sessionId: this.sessionId,
            maxAcceptedSeq,
        });
        const supervisor = this.sessionConnectionSupervisor;
        const result = supervisor
            ? await runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request,
            })
            : await request();
        for (const localId of this.normalizeUserMessageDeliveryLocalIds(result.resolvedLocalIds)) {
            this.finishAcceptedCanonicalPendingDeliveryResolution(localId);
        }
        this.applyPendingDeliveryActionQueueState(result.pendingQueueState ?? null);
        return result;
    }

    private observeMaterializedPendingDeliveryState(params: Readonly<{
        localId: string;
        deliveryState: PendingMaterializationDeliveryState | null;
        malformed?: boolean;
    }>): void {
        const localId = params.localId.trim();
        if (!localId || params.malformed) return;
        if (params.deliveryState?.unresolved === true) {
            this.canonicalPendingDeliveryByLocalId.set(localId, params.deliveryState);
            return;
        }
        this.canonicalPendingDeliveryByLocalId.delete(localId);
    }

    hasUserMessageProviderAcceptance(query: UserMessageProviderAcceptanceQuery): boolean {
        const providerAcceptedSeq = this.readDeliveredUserMessageWatermarkState().providerAccepted;
        const explicitSeqs = this.normalizeUserMessageDeliverySeqs(query);
        if (providerAcceptedSeq !== null) {
            if (explicitSeqs.length > 0) {
                return explicitSeqs.every((seq) => seq <= providerAcceptedSeq);
            } else {
                const scalarSeqs = this.normalizeUserMessageDeliverySeqs(query, { includeScalarFallback: true });
                if (scalarSeqs.some((seq) => seq <= providerAcceptedSeq)) {
                    return true;
                }
            }
        } else if (explicitSeqs.length > 0) {
            return false;
        }
        const localIds = this.normalizeUserMessageDeliveryLocalIds(query.localIds);
        for (const localId of localIds) {
            if (this.providerAcceptedUserMessageLocalIdsAwaitingSeq.has(localId)) {
                return true;
            }
            const committedSeq = this.committedUserMessageSeqTracker.get(localId);
            if (committedSeq !== null && providerAcceptedSeq !== null && committedSeq <= providerAcceptedSeq) {
                return true;
            }
        }
        return false;
    }

    hasUserMessageLocalConsumption(query: UserMessageLocalConsumptionQuery): boolean {
        const consumedSeqs = new Set([
            ...readLocallyConsumedUserMessageSeqsV1(this.metadata as unknown as Record<string, unknown> | null),
            ...this.locallyConsumedUserMessageSeqs,
        ]);
        const explicitSeqs = this.normalizeUserMessageDeliverySeqs(query);
        if (explicitSeqs.length > 0) {
            return explicitSeqs.every((seq) => consumedSeqs.has(seq));
        }

        const scalarSeqs = this.normalizeUserMessageDeliverySeqs(query, { includeScalarFallback: true });
        if (scalarSeqs.some((seq) => consumedSeqs.has(seq))) {
            return true;
        }

        const localIds = this.normalizeUserMessageDeliveryLocalIds(query.localIds);
        for (const localId of localIds) {
            if (this.locallyConsumedUserMessageLocalIdsAwaitingSeq.has(localId)) {
                return true;
            }
            const committedSeq = this.committedUserMessageSeqTracker.get(localId);
            if (committedSeq !== null && consumedSeqs.has(committedSeq)) {
                return true;
            }
        }
        return false;
    }

    hasPendingQueueMaterializedLocalId(localId: string): boolean {
        return this.materializationRuntime.hasPendingQueueMaterializedLocalId(localId);
    }

    hasCanonicalPendingDeliveryLocalId(localId: string): boolean {
        return this.canonicalPendingDeliveryByLocalId.has(localId);
    }

    private trackPendingUpdate<T>(updates: Set<Promise<T>>, update: Promise<T>): void {
        updates.add(update);
        void update.finally(() => {
            updates.delete(update);
        }).catch(() => undefined);
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

	    constructor(token: string, session: Session, options: ApiSessionClientOptions = {}) {
	        super()
	        this.token = token;
	        this.sessionId = session.id;
	        this.metadata = session.metadata;
	        this.metadataVersion = session.metadataVersion;
	        this.agentState = session.agentState;
	        this.agentStateVersion = session.agentStateVersion;
            this.applyRuntimeActivityProjectionFromServer(session);
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
            this.startupMessageCatchUpExplicitAfterSeq =
                typeof session.initialTranscriptAfterSeq === 'number'
                && Number.isFinite(session.initialTranscriptAfterSeq)
                && session.initialTranscriptAfterSeq >= 0
                    ? Math.trunc(session.initialTranscriptAfterSeq)
                    : null;
            this.startupMessageCatchUpInitialAuthorization =
                readSessionCatchUpAuthorization((session as { initialTranscriptCatchUpAuthorization?: unknown }).initialTranscriptCatchUpAuthorization)
                ?? (this.startupMessageCatchUpExplicitAfterSeq !== null ? 'explicit_cursor' : 'startup_recovery');
        this.startedByDaemonProcess = (() => {
            const idx = process.argv.lastIndexOf('--started-by');
            if (idx < 0) return false;
            const value = process.argv[idx + 1];
            return value === 'daemon';
        })();
	        this.daemonInitialPrompt = canReceiveDaemonInitialPrompt({
            metadata: session.metadata,
            startedByDaemonProcess: this.startedByDaemonProcess,
        })
            ? consumeDaemonInitialPromptFromEnv()
            : null;
        this.materializationRuntime = createSessionClientMaterializationRuntime({
            forgetMaterializationRecovery: (localId) => this.recoveryRuntime.forgetMaterializationRecovery(localId),
            onKeepAliveStateMayHaveChanged: () => this.maybeScheduleUserSocketDisconnect(),
            initialPendingQueueState: readKnownPendingQueueState(session) ?? UNKNOWN_PENDING_QUEUE_STATE,
            initialLatestTurnStatus: readLatestTurnStatusSnapshot((session as { latestTurnStatus?: unknown }).latestTurnStatus),
            isPendingQueueMaterializationBlocked: () =>
                isSessionContinuationRecoveryBlockingPendingDrain(this.metadata),
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
            getLatestTurnStatus: () => this.materializationRuntime.getLatestTurnStatus(),
            getPendingQueueState: () => this.materializationRuntime.getPendingQueueState(),
            applyPendingQueueState: (state) => this.materializationRuntime.applyPendingQueueState(state),
            onPendingChangedDrainTrigger: (state) => {
                logger.debug('[pendingQueue] pending-changed drain trigger', {
                    sessionId: this.sessionId,
                    pendingCount: state.pendingCount,
                    pendingBlockedCount: state.pendingBlockedCount,
                    pendingVersion: state.pendingVersion,
                });
                this.schedulePendingMaterializeRetryWake('pending-changed', state);
            },
            getPendingMessages: () => this.pendingMessages,
            getPendingMessageCallback: () => this.pendingMessageCallback,
            getUserMessageCallbackAttachedAtMs: () => this.userMessageCallbackAttachedAtMs,
            onConnectedServiceTurnLifecycleEvent: (event) => {
                void this.notifyDaemonConnectedServiceTurnLifecycle(event);
            },
            emit: (event, payload) => this.emit(event, payload),
            hasSelfEchoSuppressedLocalId: (localId) => this.materializationRuntime.hasSelfEchoSuppressedLocalId(localId),
            hasAgentQueueEchoSuppressedLocalId: (localId) => this.materializationRuntime.hasAgentQueueEchoSuppressedLocalId(localId),
            hasAgentQueueDeliveredLocalId: (localId) => this.materializationRuntime.hasAgentQueueDeliveredLocalId(localId),
            markAgentQueueEchoSuppressedLocalId: (localId) => this.materializationRuntime.markAgentQueueEchoSuppressedLocalId(localId),
            markAgentQueueDeliveredLocalId: (localId) => this.materializationRuntime.markAgentQueueDeliveredLocalId(localId),
            clearAgentQueueEchoSuppressedLocalId: (localId) => this.materializationRuntime.clearAgentQueueEchoSuppressedLocalId(localId),
            clearAgentQueueDeliveredLocalId: (localId) => this.materializationRuntime.clearAgentQueueDeliveredLocalId(localId),
            hasPendingQueueMaterializedLocalId: (localId) => this.materializationRuntime.hasPendingQueueMaterializedLocalId(localId),
            deleteMaterializedLocalId: (localId) => this.materializationRuntime.deleteMaterializedLocalId(localId),
            hasCanonicalPendingDeliveryLocalId: (localId) => this.canonicalPendingDeliveryByLocalId.has(localId),
            turnAssistantTextSnapshotStore: this.turnAssistantTextSnapshotStore,
            observeCommittedUserMessageSeq: ({ localId, seq }) => {
                this.recordCommittedUserMessageSeq(localId, seq);
            },
            onUserMessageDeliveredToAgentQueue: (seq) => this.recordDeliveredUserMessageSeq(seq),
            onUserMessageDeliveryProvenByLocalEcho: (seq) => this.persistDeliveredUserMessageWatermarkSeq(seq),
            getDeliveredUserMessageSeq: () => this.readDeliveredUserMessageWatermarkState().effective,
            onRuntimeActivityProjectionFromServer: (projection) => {
                this.applyRuntimeActivityProjectionFromServer(projection);
            },
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
            getStartupMessageCatchUpInitialAfterSeqIsExplicit: () => this.startupMessageCatchUpInitialAfterSeqIsExplicit,
            getStartupMessageCatchUpInitialAuthorization: () => this.startupMessageCatchUpInitialAuthorization,
            getLastObservedMessageSeq: () => this.updateRuntime.getLastObservedMessageSeq(),
            getHasMaterializedLocalId: (localId) => this.materializationRuntime.hasMaterializedLocalId(localId),
            deleteMaterializedLocalId: (localId) => this.materializationRuntime.deleteMaterializedLocalId(localId),
            handleUpdate: (update, opts) => this.updateRuntime.handleUpdate(update, opts),
            syncSessionSnapshotFromServer: async (opts) => {
                await this.syncSessionSnapshotFromServer(opts);
            },
            applyPendingQueueState: (state) => {
                if (this.materializationRuntime.applyPendingQueueState(state)) {
                    this.emit('metadata-updated');
                }
            },
        });
        this.commitQueueRuntime = createSessionClientCommitQueueRuntime({
            token: this.token,
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
                        error: serializeAxiosErrorForLog(error),
                    });
                });
            },
        });
        this.durableMutationOutbox = createSessionClientDurableMutationOutbox({
            token: this.token,
            sessionId: this.sessionId,
            getSocket: () => adaptDurableMutationSocket(this.socket),
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                const runtimeActivityProjection = readRuntimeActivityProjectionWriteFromRegisteredMutation(mutation);
                if (runtimeActivityProjection) {
                    await this.updateRuntimeActivityProjection(runtimeActivityProjection);
                    return true;
                }
                await this.updateMetadata((metadata) => applyRegisteredSessionStateFieldMutationToMetadata(
                    metadata,
                    mutation,
                ));
                this.emit('metadata-updated');
                return true;
            },
            requestReconnect: (reason) => {
                const supervisor = this.sessionConnectionSupervisor;
                if (!supervisor) return;
                void supervisor.start().catch((error) => {
                    logger.debug('[API] Failed to restart session socket for queued durable mutation', {
                        reason,
                        error: serializeAxiosErrorForLog(error),
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
            enqueueSessionEndMutation: (mutation) => this.enqueueSessionEndMutation(mutation),
            createSessionEndMutation: (observedAt) => createSessionEndMutation({ sessionId: this.sessionId, observedAt }),
            enqueueCommittedTranscriptMessage: (params) =>
                this.durableMutationOutbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
                    sessionId: this.sessionId,
                    localId: params.localId,
                    content: params.message,
                    sidechainId: params.sidechainId,
                    messageRole: params.messageRole,
                    sessionEventType: params.sessionEventType,
                    createdAt: params.createdAt,
                    updatedAt: params.updatedAt,
                })),
            usageObservationPublisher: this.usageObservationPublisher,
            buildOutboundSessionMessagePayload: (content) => this.commitQueueRuntime.buildOutboundSessionMessagePayload(content),
            commitSessionMessageBestEffort: (params) => this.commitQueueRuntime.commitSessionMessageBestEffort(params),
            enqueueMessageCommit: (fn) => this.commitQueueRuntime.enqueueMessageCommit(fn),
            trackProviderTranscriptDispatch: (update) => {
                this.trackPendingUpdate(this.pendingProviderTranscriptDispatches, update);
            },
            commitSessionMessage: (params) => this.commitQueueRuntime.commitSessionMessage(params),
            logSendWhileDisconnected: (context, details) => this.logSendWhileDisconnected(context, details),
            hasAgentQueueEchoSuppressedLocalId: (localId) => this.materializationRuntime.hasAgentQueueEchoSuppressedLocalId(localId),
            markAgentQueueEchoSuppressedLocalId: (localId) => this.materializationRuntime.markAgentQueueEchoSuppressedLocalId(localId),
            clearAgentQueueEchoSuppressedLocalId: (localId) => this.materializationRuntime.clearAgentQueueEchoSuppressedLocalId(localId),
            markAgentQueueDeliveredLocalId: (localId) => this.materializationRuntime.markAgentQueueDeliveredLocalId(localId),
            clearAgentQueueDeliveredLocalId: (localId) => this.materializationRuntime.clearAgentQueueDeliveredLocalId(localId),
            getCommittedUserMessageSeq: (localId) => this.getCommittedUserMessageSeq(localId),
            recordUserMessageDeliveredToAgentQueue: (seq) => this.recordDeliveredUserMessageSeq(seq),
            toolCallCanonicalNameByProviderAndId: this.toolCallCanonicalNameByProviderAndId,
            permissionToolCallRawInputByProviderAndId: this.permissionToolCallRawInputByProviderAndId,
            toolCallInputByProviderAndId: this.toolCallInputByProviderAndId,
            maxToolCallCacheEntries: SESSION_CLIENT_TOOL_CALL_CACHE_MAX_ENTRIES,
            transformSessionInputBeforeCommit: options.transformSessionInputBeforeCommit,
            deliverUserMessageToAgentQueue: (prompt) => {
                const localId = typeof prompt.localId === 'string' ? prompt.localId : '';
                if (localId.length > 0) {
                    this.materializationRuntime.markAgentQueueEchoSuppressedLocalId(localId);
                    this.materializationRuntime.markAgentQueueDeliveredLocalId(localId);
                }
                if (this.pendingMessageCallback) {
                    const delivered = this.pendingMessageCallback(prompt) !== false;
                    if (!delivered && localId.length > 0) {
                        this.materializationRuntime.clearAgentQueueEchoSuppressedLocalId(localId);
                        this.materializationRuntime.clearAgentQueueDeliveredLocalId(localId);
                    }
                    return delivered;
                }
                this.pendingMessages.push(prompt);
                return true;
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
            sessionRuntimeControls: this.sessionRuntimeControls,
            enqueueSessionUserMessage: (request) => this.enqueueSessionUserMessage(request),
            sendUserTextMessage: (text, opts) => this.sendUserTextMessage(text, opts),
            sendAgentMessage: (provider, body, opts) => this.sendAgentMessage(provider, body, opts),
            sendUserTextMessageCommitted: (text, opts) => this.sendUserTextMessageCommitted(text, opts),
            enqueueAgentMessageCommitted: (provider, body, opts) =>
                this.enqueueAgentMessageCommitted(provider, body, opts),
            sendAgentMessageCommitted: (provider, body, opts) => this.sendAgentMessageCommitted(provider, body, opts),
            sendAgentMessageEphemeral: (provider, body, opts) => this.sendAgentMessageEphemeral(provider, body, opts),
            sendAgentMessageEphemeralDelta: (provider, body, opts) => this.sendAgentMessageEphemeralDelta(provider, body, opts),
            getEphemeralStreamConnectionEpoch: () => this.getEphemeralStreamConnectionEpoch(),
            enqueueRegisteredSessionStateFieldMutation: (mutation) =>
                this.enqueueRegisteredSessionStateFieldMutation(mutation),
            getTranscriptQueryContext: () => ({
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
            }),
            getAgentStateRequestStore: () => this.getAgentStateRequestStore(),
            getBrowserDaemonControlRoutes: options.getBrowserDaemonControlRoutes ?? null,
            getBrowserDaemonContextRoutes: options.getBrowserDaemonContextRoutes ?? null,
            getBrowserDaemonAutomationRoutes: options.getBrowserDaemonAutomationRoutes ?? null,
            getBrowserDiagnosticsActionRoutes: options.getBrowserDiagnosticsActionRoutes ?? null,
            getBrowserRecordingRoutes: options.getBrowserRecordingRoutes ?? null,
            attachBrowserRecordingToComposer: options.attachBrowserRecordingToComposer,
            getLocalServicesRuntimeActionRoutes: options.getLocalServicesRuntimeActionRoutes ?? null,
            getSimulatorPreviewRoutes: options.getSimulatorPreviewRoutes ?? null,
            getPeerMediationObservabilityRuntimeActionContext:
                options.getPeerMediationObservabilityRuntimeActionContext ?? null,
            getServerFeaturesSnapshot: options.getServerFeaturesSnapshot ?? null,
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
            catchUpSessionMessages: (request) => this.recoveryRuntime.catchUpSessionMessages(request),
            scheduleNextStartupMessageCatchUpRetry: () => this.recoveryRuntime.scheduleNextStartupMessageCatchUpRetry(),
            getLastObservedMessageSeq: () => this.updateRuntime.getLastObservedMessageSeq(),
            getStartupMessageCatchUpExplicitAfterSeq: () => this.startupMessageCatchUpExplicitAfterSeq,
            getStartupMessageCatchUpInitialAuthorization: () => this.startupMessageCatchUpInitialAuthorization,
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
                this.startupMessageCatchUpInitialAfterSeqIsExplicit =
                    this.startupMessageCatchUpInitialAuthorization === 'explicit_cursor';
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
            syncSessionSnapshotFromServer: async (opts) => {
                await this.syncSessionSnapshotFromServer(opts);
            },
            reconcileTurnStatusBeforePendingMaterialization: () =>
                this.reconcileTurnStatusBeforePendingMaterializationIfNeeded(),
            logPendingMaterializationSkip: (stage) => this.logPendingMaterializationSkip(stage),
            maybeScheduleUserSocketDisconnect: () => this.maybeScheduleUserSocketDisconnect(),
            handleSessionScopedUpdate: (data, opts) => this.updateRuntime.handleUpdate(data, {
                source: 'session-scoped',
                pendingMaterializationActiveTurnPolicy: opts?.pendingMaterializationActiveTurnPolicy,
            }),
            clearStartupMessageCatchUpRetryTimer: () => this.recoveryRuntime.clearStartupMessageCatchUpRetryTimer(),
            stopStaleSafety: () => this.recoveryRuntime.stopStaleSafety(),
            clearCommittedLocalIdCleanupTimers: () => this.materializationRuntime.clearCommittedLocalIdCleanupTimers(),
            clearPendingMaterializedState: () => {
                this.canonicalPendingDeliveryByLocalId.clear();
                this.acceptedCanonicalPendingDeliveryRetryLocalIds.clear();
                this.materializationRuntime.clearPendingMaterializedState();
                this.commitQueueRuntime.clearState();
            },
            blockProviderDeliveriesBeforeClose: () => this.blockProviderDeliveriesBeforeClose(),
            getPendingQueueMaterializedLocalIdsSize: () => this.materializationRuntime.getPendingQueueMaterializedLocalIdsSize(),
            markPendingQueueMaterializedLocalId: (localId) =>
                this.materializationRuntime.markPendingQueueMaterializedLocalId(localId),
            shouldAttemptPendingMaterialization: (opts) => this.materializationRuntime.shouldAttemptPendingMaterialization(opts),
            shouldDeferPendingQueueDrainForRuntimeActivity: ({ deliveryTiming }) =>
                shouldDeferPendingQueueDrainForRuntimeActivity({
                    settings: { sessionPendingQueueDeliveryTiming: deliveryTiming },
                    activity: this.runtimeActivityProjection,
                    nowMs: Date.now(),
                }),
            getPendingQueueState: () => this.materializationRuntime.getPendingQueueState(),
            applyPendingQueueState: (state) => this.materializationRuntime.applyPendingQueueState(state),
            observePendingMaterializeResult: (params) => this.materializationRuntime.observeMaterializeResult(params),
            shouldRequestProviderDeliveryState: () => this.shouldRequestProviderDeliveryState(),
            getAcceptedUserMessageDeliverySeqForPendingReconciliation: () =>
                this.readAcceptedUserMessageDeliverySeqForPendingReconciliation(),
            reconcileAcceptedPendingDeliveriesThroughSeq: (maxAcceptedSeq) =>
                this.reconcileAcceptedPendingDeliveriesThroughSeq(maxAcceptedSeq),
            retryAcceptedCanonicalPendingDeliveryResolutions: () =>
                this.retryAcceptedCanonicalPendingDeliveryResolutions(),
            getUnresolvedCanonicalPendingDeliveryCount: () => this.canonicalPendingDeliveryByLocalId.size,
            recoverInheritedProviderDeliveryClaimsBeforeMaterialization: () =>
                this.recoverInheritedProviderDeliveryClaimsBeforeMaterialization(),
            blockMalformedPendingDelivery: async (params) => {
                await this.blockPendingQueueDeliveryLocalId(params.localId, params.reason, {
                    canonicalOnly: false,
                });
                return {};
            },
            observeMaterializedPendingDeliveryState: (params) =>
                this.observeMaterializedPendingDeliveryState(params),
            onPendingQueueStateChanged: () => {
                this.resetPendingMaterializeRetryWakeIfDrained();
                this.emit('metadata-updated');
            },
            onPendingMaterializeFailure: () => this.schedulePendingMaterializeRetryWake('materialize-failure'),
            scheduleMaterializationRecovery: (localId) => {
                this.materializationRuntime.markPendingQueueMaterializedLocalId(localId);
                this.recoveryRuntime.scheduleMaterializationRecovery(localId);
            },
            getMetadataLock: () => this.metadataLock,
            getSessionEncryptionMode: () => this.sessionEncryptionMode,
            getEncryptionKey: () => this.encryptionKey,
            getEncryptionVariant: () => this.encryptionVariant,
        });
        this.sessionRuntimeControls.materializeNextPendingMessageSafely = (opts) =>
            this.materializeNextPendingMessageSafely(opts);

        const { userSocket, sessionConnectionSupervisor } = initializeSessionClientConnection({
            token: this.token,
            sessionId: this.sessionId,
            localMachineId: options.localMachineId,
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
                this.emit(SESSION_CONNECTION_STATE_EVENT, state);
            },
            shouldKeepUserSocketConnected: () =>
                this.materializationRuntime.shouldKeepUserSocketConnected({
                    hasPendingMessageCallback: this.pendingMessageCallback !== null,
                    hasQueuedDisconnectedSessionMessages: this.commitQueueRuntime.queuedDisconnectedSessionMessages.size > 0,
                }),
            kickUserSocketConnect: () => this.kickUserSocketConnect(),
            syncChangesOnConnect: async (opts) => {
                await this.retryAcceptedCanonicalPendingDeliveryResolutions();
                await this.recoveryRuntime.syncChangesOnConnect(opts);
            },
            shouldSyncSessionSnapshotOnConnect: () =>
                shouldSyncSessionSnapshotOnConnect({ metadataVersion: this.metadataVersion, agentStateVersion: this.agentStateVersion }),
            syncSessionSnapshotFromServer: async (opts) => {
                await this.syncSessionSnapshotFromServer(opts);
            },
            flushQueuedSessionMessagesOnReconnect: () => this.commitQueueRuntime.flushQueuedSessionMessagesOnReconnect(),
            flushDurableSessionMutationsOnReconnect: () => this.durableMutationOutbox.flush('connect'),
            replayLatestSessionPresenceOnReconnect: () => this.transcriptApi.replayLatestPresence(),
            markConnected: () => {
                this.disconnectedSendLogged = false;
                this.ephemeralStreamConnectionEpoch += 1;
                const reason = this.hasConnectedOnce ? 'reconnect' : 'connect';
                this.hasConnectedOnce = true;
                return reason;
            },
        });
        this.userSocket = userSocket;
        this.sessionConnectionSupervisor = sessionConnectionSupervisor;
        void this.sessionConnectionSupervisor.start();
    }

    setSessionRuntimeControls(controls: SessionRuntimeControls | null): void {
        applySessionRuntimeControls(this.sessionRuntimeControls, controls);
    }

    private syncSessionSnapshotFromServer(opts: { reason: SessionSnapshotRefreshReason }): Promise<boolean> {
        if (this.closed) return Promise.resolve(false);
        if (this.snapshotSyncInFlight) return this.snapshotSyncInFlight;

        const p = (async (): Promise<boolean> => {
            try {
                return await syncSessionSnapshotFromServer({
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
                    applyPendingQueueState: (state) => {
                        if (this.materializationRuntime.applyPendingQueueState(state)) {
                            this.emit('metadata-updated');
                        }
                    },
                    applyLatestTurnStatus: (status) => {
                        this.materializationRuntime.applyLatestTurnStatus(status);
                    },
                    reason: opts.reason,
                });
            } catch (error) {
                logger.debug('[API] Failed to sync session snapshot from server', {
                    reason: opts.reason,
                    error: serializeAxiosErrorForLog(error),
                });
                return false;
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

    /**
     * Canonical local turn mutations are the truthful local turn lifecycle: keep the cached
     * latest-turn-status snapshot in sync immediately. Terminal drain/catch-up side effects run
     * only after the matching turn mutation is durable.
     */
    private observeSessionTurnMutationForCachedTurnStatus(mutation: SessionTurnMutationV1): Readonly<{ isTerminal: boolean }> {
        return this.materializationRuntime.observeSessionTurnMutationAction(mutation.action);
    }

    private clearPendingMaterializeRetryWake(): void {
        if (this.pendingMaterializeRetryWakeTimer) {
            clearTimeout(this.pendingMaterializeRetryWakeTimer);
            this.pendingMaterializeRetryWakeTimer = null;
        }
        this.pendingMaterializeRetryAttempt = 0;
    }

    private resetPendingMaterializeRetryWakeIfDrained(): void {
        if (countMaterializablePendingRows(this.materializationRuntime.getPendingQueueState()) > 0) return;
        this.clearPendingMaterializeRetryWake();
    }

    private schedulePendingMaterializeRetryWake(
        reason: 'pending-changed' | 'materialize-failure' | 'retry-timer',
        triggerState?: KnownPendingQueueState,
    ): void {
        const pendingQueueState = triggerState ?? this.materializationRuntime.getPendingQueueState();
        if (this.closed || countMaterializablePendingRows(pendingQueueState) <= 0) {
            this.clearPendingMaterializeRetryWake();
            return;
        }
        if (this.pendingMaterializeRetryWakeTimer) return;

        const attempt = this.pendingMaterializeRetryAttempt;
        const delayMs = resolvePendingQueueMaterializeRetryDelayMs(attempt);
        logger.debug('[pendingQueue] materialize retry wake scheduled', {
            sessionId: this.sessionId,
            reason,
            attempt: attempt + 1,
            delayMs,
            pendingCount: pendingQueueState.known ? pendingQueueState.pendingCount : null,
            pendingVersion: pendingQueueState.known ? pendingQueueState.pendingVersion : null,
        });
        this.pendingMaterializeRetryWakeTimer = setTimeout(() => {
            this.pendingMaterializeRetryWakeTimer = null;
            const currentState = this.materializationRuntime.getPendingQueueState();
            if (this.closed || countMaterializablePendingRows(currentState) <= 0) {
                this.clearPendingMaterializeRetryWake();
                return;
            }
            this.pendingMaterializeRetryAttempt += 1;
            logger.debug('[pendingQueue] materialize retry wake', {
                sessionId: this.sessionId,
                attempt: this.pendingMaterializeRetryAttempt,
                pendingCount: currentState.known ? currentState.pendingCount : null,
                pendingVersion: currentState.known ? currentState.pendingVersion : null,
            });
            this.emit('metadata-updated');
            this.schedulePendingMaterializeRetryWake('retry-timer');
        }, delayMs);
        this.pendingMaterializeRetryWakeTimer.unref?.();
    }

    /**
     * On durable terminal turns, wake the pending consumer and run a throttled pending-queue
     * reconcile (recovers lost pending-count nudges). Without this a stale 'in_progress' snapshot
     * can keep blocking pending-queue materialization until a manual "Send now" (fail-safe: a
     * duplicate wake/reconcile is harmless; a missing one strands queued messages).
     */
    private observeDurableTerminalSessionTurnMutationForPendingDrain(mutation: SessionTurnMutationV1): void {
        if (this.closed) return;
        const observed = this.materializationRuntime.observeSessionTurnMutationAction(mutation.action);
        if (!observed.isTerminal) return;
        const pendingQueueState = this.materializationRuntime.getPendingQueueState();
        logger.debug('[pendingQueue] turn-end drain trigger', {
            sessionId: this.sessionId,
            action: mutation.action,
            pendingCount: pendingQueueState.known ? pendingQueueState.pendingCount : null,
        });
        this.emit('metadata-updated');
        void this.reconcilePendingQueueState({ force: false }).catch(() => undefined);
        void this.catchUpOwedUserMessagesAfterTurnEnd().catch(() => undefined);
    }

    /**
     * Owed-delivery recovery at turn end (ported QA C-F2/A-F3 family): a user row committed into
     * the transcript while the provider turn was running can miss its socket broadcast, and
     * nothing replays it later — it stays invisible to the agent loop forever. Re-pull the
     * transcript window after the delivered/observed user-row cursor; echo suppression and the
     * deliveredUserMessageSeqV1 watermark absorb duplicates (at-least-once, never silently stuck).
     */
    private async catchUpOwedUserMessagesAfterTurnEnd(): Promise<void> {
        if (this.owedUserMessageCatchUpInFlight) return;
        if (this.acceptedCanonicalPendingDeliveryRetryLocalIds.size > 0) {
            await this.retryAcceptedCanonicalPendingDeliveryResolutions();
        }
        if (this.canonicalPendingDeliveryByLocalId.size > 0) {
            logger.debug('[pendingQueue] owed user-message turn-end catch-up skipped while canonical pending delivery is unresolved', {
                sessionId: this.sessionId,
                unresolvedCanonicalPendingDeliveryCount: this.canonicalPendingDeliveryByLocalId.size,
            });
            return;
        }
        const now = Date.now();
        if (
            this.lastOwedUserMessageCatchUpAt > 0
            && now - this.lastOwedUserMessageCatchUpAt < configuration.pendingQueueStateReconcileThrottleMs
        ) {
            return;
        }
        this.lastOwedUserMessageCatchUpAt = now;
        const watermarkState = this.readDeliveredUserMessageWatermarkState();
        const afterSeq = Math.max(0, Math.min(
            watermarkState.effective ?? Number.MAX_SAFE_INTEGER,
            this.lastObservedUserMessageSeq,
        ));
        this.owedUserMessageCatchUpInFlight = true;
        logger.debug('[pendingQueue] owed user-message turn-end catch-up', {
            sessionId: this.sessionId,
            afterSeq,
            deliveredWatermark: watermarkState.effective,
            persistedDeliveredWatermark: watermarkState.persisted,
            inMemoryDeliveredWatermark: watermarkState.inMemory,
            lastObservedUserMessageSeq: this.lastObservedUserMessageSeq,
        });
        try {
            // Explicit cursor: a deliberate owed-delivery replay (the watermark/observed cursor
            // authorizes delivery of rows beyond it to the agent queue).
            await this.catchUpSessionMessages({
                afterSeq,
                authorization: 'explicit_cursor',
            });
        } catch (error) {
            logger.debug('[pendingQueue] owed user-message turn-end catch-up failed (non-fatal)', {
                sessionId: this.sessionId,
                afterSeq,
                error: serializeAxiosErrorForLog(error),
            });
        } finally {
            this.owedUserMessageCatchUpInFlight = false;
        }
    }

    /**
     * Materialization-skip observability: a known-positive pending count with no materialize
     * attempt is the silent-stuck shape — emit a structured log with the gate inputs.
     */
    private logPendingMaterializationSkip(stage: string): void {
        const pendingQueueState = this.materializationRuntime.getPendingQueueState();
        if (!pendingQueueState.known || pendingQueueState.pendingCount <= 0) return;
        logger.debug('[pendingQueue] materialization skipped', {
            sessionId: this.sessionId,
            stage,
            pendingCount: pendingQueueState.pendingCount,
            pendingVersion: pendingQueueState.pendingVersion,
            latestTurnStatus: this.materializationRuntime.getLatestTurnStatus() ?? null,
            hasActiveLocalTurn: this.materializationRuntime.hasActiveLocalTurn(),
        });
    }

    private async reconcileTurnStatusBeforePendingMaterializationIfNeeded(): Promise<boolean> {
        if (this.materializationRuntime.shouldForceRefreshStaleBlockedTurnStatus()) {
            await this.syncSessionSnapshotFromServer({ reason: 'explicit-drain' });
        }
        if (!this.materializationRuntime.shouldRefreshTurnStatusBeforePendingMaterialization()) {
            return true;
        }
        const refreshed = await this.syncSessionSnapshotFromServer({ reason: 'explicit-drain' });
        if (!refreshed) {
            return false;
        }
        this.materializationRuntime.markTurnStatusRefreshPendingVersion();
        return true;
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

    private async catchUpSessionMessages(catchUpRequest: SessionCatchUpRequest): Promise<void> {
        await catchUpSessionMessagesViaPort({
            closed: this.closed,
            token: this.token,
            sessionId: this.sessionId,
            sessionConnectionSupervisor: this.sessionConnectionSupervisor,
            recoveryRuntime: this.recoveryRuntime,
            startupMessageCatchUpInitialAfterSeq: this.startupMessageCatchUpInitialAfterSeq,
            startupMessageCatchUpInitialAfterSeqIsExplicit: this.startupMessageCatchUpInitialAfterSeqIsExplicit,
            startupMessageCatchUpInitialAuthorization: this.startupMessageCatchUpInitialAuthorization,
            startupMessageCatchUpRetryIndex: this.startupMessageCatchUpRetryIndex,
            startupMessageCatchUpRetryTimer: null,
            catchUpSessionMessages: (nextRequest) => this.catchUpSessionMessages(nextRequest),
            scheduleNextStartupMessageCatchUpRetry: () => this.scheduleNextStartupMessageCatchUpRetry(),
            shouldRunStartupTranscriptCatchUp: () => this.shouldRunStartupTranscriptCatchUp(),
            classifyTransportErrorToProbeResult: (error) => classifySessionTransportErrorToProbeResult(error),
            handleCatchUpUpdate: (update, updateOpts) =>
                (this as unknown as {
                    handleUpdate: (data: unknown, opts: { source: 'session-scoped' | 'user-scoped'; catchUpAfterSeq?: number; catchUpAuthorization?: SessionCatchUpRequest['authorization'] }) => void;
                }).handleUpdate(update, {
                    source: 'session-scoped',
                    catchUpAfterSeq: updateOpts.catchUpAfterSeq,
                    catchUpAuthorization: updateOpts.catchUpAuthorization,
                }),
        }, catchUpRequest);
    }

    private scheduleNextStartupMessageCatchUpRetry(): void {
        scheduleNextStartupCatchUpRetryViaPort(this as unknown as Parameters<typeof scheduleNextStartupCatchUpRetryViaPort>[0], ApiSessionClient.STARTUP_MESSAGE_CATCH_UP_RETRY_DELAYS_MS);
    }

    onUserMessage(callback: (data: UserMessage) => boolean | void) {
        this.interactionApi.onUserMessage(callback);
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
    async refreshSessionSnapshotFromServerBestEffort(opts?: { reason?: SessionSnapshotRefreshReason }): Promise<void> {
        await this.interactionApi.refreshSessionSnapshotFromServerBestEffort(opts);
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendProviderMessage(request: Parameters<SessionClientTranscriptApi['sendProviderMessage']>[0]) {
        this.transcriptApi.sendProviderMessage(request);
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

    private async notifyDaemonConnectedServiceTurnLifecycle(
        event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled',
    ): Promise<void> {
        if (!this.startedByDaemonProcess) return;
        try {
            const result = await notifyDaemonConnectedServiceTurnLifecycleViaControl({
                sessionId: this.sessionId,
                event,
            });
            if (result?.error) {
                logger.debug('[SESSION CLIENT] Failed to notify daemon connected-service turn lifecycle (non-fatal)', {
                    sessionId: this.sessionId,
                    event,
                    error: result.error,
                });
            }
        } catch (error) {
            logger.debug('[SESSION CLIENT] Connected-service turn lifecycle notify threw (non-fatal)', {
                sessionId: this.sessionId,
                event,
                error: serializeAxiosErrorForLog(error),
            });
        }
    }

    private enqueueSessionUserMessage(params: Readonly<{
        text: string;
        localId?: string;
        meta?: Record<string, unknown>;
    }>): Promise<void> {
        void this.notifyDaemonConnectedServiceTurnLifecycle('prompt_or_steer');
        return this.transcriptApi.enqueueSessionUserMessage(params);
    }

    async sendAgentMessageCommitted(
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown> },
    ): Promise<void> {
        await this.transcriptApi.sendAgentMessageCommitted(provider, body, opts);
    }

    enqueueAgentMessageCommitted(
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown> },
    ): Promise<Readonly<{ persisted: boolean; delivered: boolean }>> {
        const update = this.transcriptApi.enqueueAgentMessageCommitted(provider, body, opts);
        this.trackPendingUpdate(this.pendingTranscriptMessageUpdates, update);
        return update;
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
        opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown>; tick?: number },
    ): void {
        this.transcriptApi.sendAgentMessageEphemeral(provider, body, opts);
    }

    /**
     * Emit a live transcript delta tick: `body` carries ONLY the text appended since the previous
     * live emission for this segment. Full-snapshot checkpoints still flow through
     * `sendAgentMessageEphemeral`; receivers that cannot chain a delta drop it and resync on the
     * next checkpoint.
     */
    sendAgentMessageEphemeralDelta(
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; tick: number; baseLength: number; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> },
    ): void {
        this.transcriptApi.sendAgentMessageEphemeralDelta(provider, body, opts);
    }

    getEphemeralStreamConnectionEpoch(): number {
        return this.ephemeralStreamConnectionEpoch;
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
    /**
     * Owed-delivery watermark persistence (A-F2/D15b). Best-effort: failures keep the watermark
     * behind, which only widens redelivery (never loses messages).
     */
    private recordDeliveredUserMessageSeq(seq: number): void {
        if (!Number.isInteger(seq) || seq < 0) return;
        this.highestDeliveredUserMessageSeq = Math.max(this.highestDeliveredUserMessageSeq ?? -1, seq);
        // Deferred launchers keep this in-memory only: same-process reconnect/catch-up must not
        // duplicate a prompt already handed to the provider loop, while restart still redelivers
        // until provider acceptance persists the durable watermark.
        if (this.deferDeliveredUserMessageWatermark) return;
        void this.persistDeliveredUserMessageSeq();
    }

    private normalizeUserMessageDeliveryLocalIds(localIds: readonly string[] | null | undefined): string[] {
        const normalized: string[] = [];
        for (const value of localIds ?? []) {
            const localId = typeof value === 'string' ? value.trim() : '';
            if (!localId || normalized.includes(localId)) continue;
            normalized.push(localId);
        }
        return normalized;
    }

    private normalizeUserMessageDeliverySeqs(
        acceptance: Readonly<{ userMessageSeq?: number | null; userMessageSeqs?: readonly number[] | null }>,
        options?: Readonly<{ includeScalarFallback?: boolean }>,
    ): number[] {
        const normalized: number[] = [];
        const append = (value: unknown) => {
            if (!Number.isSafeInteger(value) || (value as number) < 0) return;
            if (normalized.includes(value as number)) return;
            normalized.push(value as number);
        };
        for (const seq of acceptance.userMessageSeqs ?? []) {
            append(seq);
        }
        if (options?.includeScalarFallback) {
            append(acceptance.userMessageSeq);
        }
        return normalized;
    }

    private markProviderAcceptedUserMessageLocalIdAwaitingSeq(localId: string): void {
        if (!localId) return;
        this.providerAcceptedUserMessageLocalIdsAwaitingSeq.add(localId);
        const existingTimer = this.providerAcceptedUserMessageLocalIdCleanupTimers.get(localId) ?? null;
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        const timer = setTimeout(() => {
            this.providerAcceptedUserMessageLocalIdCleanupTimers.delete(localId);
            this.providerAcceptedUserMessageLocalIdsAwaitingSeq.delete(localId);
        }, configuration.transcriptRecoveryMaxWaitMs);
        timer.unref?.();
        this.providerAcceptedUserMessageLocalIdCleanupTimers.set(localId, timer);
    }

    private clearProviderAcceptedUserMessageLocalIdAwaitingSeq(localId: string): void {
        this.providerAcceptedUserMessageLocalIdsAwaitingSeq.delete(localId);
        const timer = this.providerAcceptedUserMessageLocalIdCleanupTimers.get(localId) ?? null;
        if (!timer) return;
        clearTimeout(timer);
        this.providerAcceptedUserMessageLocalIdCleanupTimers.delete(localId);
    }

    private markLocallyConsumedUserMessageLocalIdAwaitingSeq(localId: string): void {
        if (!localId) return;
        this.locallyConsumedUserMessageLocalIdsAwaitingSeq.add(localId);
        const existingTimer = this.locallyConsumedUserMessageLocalIdCleanupTimers.get(localId) ?? null;
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        const timer = setTimeout(() => {
            this.locallyConsumedUserMessageLocalIdCleanupTimers.delete(localId);
            this.locallyConsumedUserMessageLocalIdsAwaitingSeq.delete(localId);
        }, configuration.transcriptRecoveryMaxWaitMs);
        timer.unref?.();
        this.locallyConsumedUserMessageLocalIdCleanupTimers.set(localId, timer);
    }

    private clearLocallyConsumedUserMessageLocalIdAwaitingSeq(localId: string): void {
        this.locallyConsumedUserMessageLocalIdsAwaitingSeq.delete(localId);
        const timer = this.locallyConsumedUserMessageLocalIdCleanupTimers.get(localId) ?? null;
        if (!timer) return;
        clearTimeout(timer);
        this.locallyConsumedUserMessageLocalIdCleanupTimers.delete(localId);
    }

    private persistProviderAcceptedCommittedUserMessageSeq(localId: string, seq: number | null): void {
        if (!localId || seq === null || !this.providerAcceptedUserMessageLocalIdsAwaitingSeq.has(localId)) return;
        if (this.canonicalPendingDeliveryByLocalId.has(localId)) return;
        this.clearProviderAcceptedUserMessageLocalIdAwaitingSeq(localId);
        this.persistDeliveredUserMessageWatermarkSeq(seq);
    }

    private persistLocallyConsumedCommittedUserMessageSeq(localId: string, seq: number | null): void {
        if (!localId || seq === null || !this.locallyConsumedUserMessageLocalIdsAwaitingSeq.has(localId)) return;
        this.clearLocallyConsumedUserMessageLocalIdAwaitingSeq(localId);
        this.persistLocallyConsumedUserMessageSeqs([seq]);
    }

    private recordCommittedUserMessageSeq(localId: unknown, seq: unknown): number | null {
        const normalizedLocalId = typeof localId === 'string' ? localId : null;
        const committedSeq = this.committedUserMessageSeqTracker.record(normalizedLocalId, seq);
        if (normalizedLocalId) {
            this.persistProviderAcceptedCommittedUserMessageSeq(normalizedLocalId, committedSeq);
            this.persistLocallyConsumedCommittedUserMessageSeq(normalizedLocalId, committedSeq);
        }
        return committedSeq;
    }

    private async resolveAcceptedCanonicalPendingDeliveries(
        localIds: readonly string[],
        acceptedSeqByLocalId?: ReadonlyMap<string, number>,
    ): Promise<void> {
        const acceptedLocalIds = this.normalizeUserMessageDeliveryLocalIds(localIds)
            .filter((localId) => this.canonicalPendingDeliveryByLocalId.has(localId));
        if (acceptedLocalIds.length === 0) return;

        for (const localId of acceptedLocalIds) {
            try {
                const request = async () => await resolveAcceptedPendingQueueV2Delivery({
                    token: this.token,
                    sessionId: this.sessionId,
                    localId,
                });
                const supervisor = this.sessionConnectionSupervisor;
                const result = supervisor
                    ? await runSupervisedRequest({
                        supervisor,
                        requireAuth: true,
                        requireOnline: false,
                        request,
                    })
                    : await request();
                if (!this.canonicalPendingDeliveryByLocalId.has(localId)) continue;
                const committedSeq = result.message?.localId === localId && result.message.seq !== null
                    ? result.message.seq
                    : acceptedSeqByLocalId?.get(localId) ?? null;
                this.finishAcceptedCanonicalPendingDeliveryResolution(localId, committedSeq);
                this.applyPendingDeliveryActionQueueState(result.pendingQueueState ?? null);
            } catch (error) {
                logger.debug('[pendingQueue] failed to resolve accepted pending delivery', {
                    sessionId: this.sessionId,
                    localId,
                    error: serializeAxiosErrorForLog(error),
                });
                if (await this.retireStaleCanonicalPendingDeliveryAfterTerminalMiss(localId, 'accepted', error)) {
                    continue;
                }
                if (this.canonicalPendingDeliveryByLocalId.has(localId)) {
                    this.acceptedCanonicalPendingDeliveryRetryLocalIds.add(localId);
                } else {
                    this.acceptedCanonicalPendingDeliveryRetryLocalIds.delete(localId);
                }
            }
        }
    }

    private finishAcceptedCanonicalPendingDeliveryResolution(localId: string, committedSeq: number | null = null): void {
        this.canonicalPendingDeliveryByLocalId.delete(localId);
        this.acceptedCanonicalPendingDeliveryRetryLocalIds.delete(localId);
        this.materializationRuntime.deleteMaterializedLocalId(localId);
        const resolvedSeq = committedSeq ?? this.committedUserMessageSeqTracker.get(localId);
        if (resolvedSeq !== null) {
            this.recordCommittedUserMessageSeq(localId, resolvedSeq);
        }
    }

    private async pruneResolvedAcceptedCanonicalPendingDeliveryRetries(
        localIds: readonly string[],
    ): Promise<string[]> {
        if (localIds.length === 0 || this.closed) {
            return [];
        }
        try {
            const request = async () => await listPendingQueueV2LocalIdsFromServer({
                token: this.token,
                sessionId: this.sessionId,
            });
            const supervisor = this.sessionConnectionSupervisor;
            const pendingLocalIds = supervisor
                ? await runSupervisedRequest({
                    supervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request,
                })
                : await request();
            const pendingLocalIdSet = new Set(pendingLocalIds);
            const stillPending: string[] = [];
            for (const localId of localIds) {
                if (pendingLocalIdSet.has(localId)) {
                    stillPending.push(localId);
                    continue;
                }
                this.finishAcceptedCanonicalPendingDeliveryResolution(localId);
            }
            return stillPending;
        } catch (error) {
            logger.debug('[pendingQueue] failed to list pending rows before accepted-delivery retry', {
                sessionId: this.sessionId,
                localIds,
                error: serializeAxiosErrorForLog(error),
            });
            return [...localIds];
        }
    }

    private async retryAcceptedCanonicalPendingDeliveryResolutions(): Promise<void> {
        if (this.acceptedCanonicalPendingDeliveryRetryLocalIds.size === 0) return;
        const retryLocalIds = [...this.acceptedCanonicalPendingDeliveryRetryLocalIds]
            .filter((localId) => this.canonicalPendingDeliveryByLocalId.has(localId));
        for (const localId of this.acceptedCanonicalPendingDeliveryRetryLocalIds) {
            if (!this.canonicalPendingDeliveryByLocalId.has(localId)) {
                this.acceptedCanonicalPendingDeliveryRetryLocalIds.delete(localId);
            }
        }
        const localIds = await this.pruneResolvedAcceptedCanonicalPendingDeliveryRetries(retryLocalIds);
        if (localIds.length === 0) return;
        await this.resolveAcceptedCanonicalPendingDeliveries(localIds);
    }

    async blockPendingMessageDelivery(params: Readonly<{
        localIds?: readonly string[] | null;
        reason: PendingQueueDeliveryBlockedReason;
    }>): Promise<boolean> {
        const localIds = this.normalizeUserMessageDeliveryLocalIds(params.localIds)
            .filter((localId) => this.canonicalPendingDeliveryByLocalId.has(localId));
        if (localIds.length === 0) return false;

        let didBlock = false;
        for (const localId of localIds) {
            didBlock = await this.blockPendingQueueDeliveryLocalId(localId, params.reason, {
                canonicalOnly: true,
            }) || didBlock;
        }
        return didBlock;
    }

    private async blockPendingQueueDeliveryLocalId(
        localId: string,
        reason: PendingQueueDeliveryBlockedReason,
        opts: Readonly<{ canonicalOnly: boolean }>,
    ): Promise<boolean> {
        if (this.closed) return false;
        const wasCanonical = this.canonicalPendingDeliveryByLocalId.has(localId);
        if (opts.canonicalOnly && !wasCanonical) return false;

        try {
            const request = async () => await blockPendingQueueV2Delivery({
                token: this.token,
                sessionId: this.sessionId,
                localId,
                reason,
            });
            const supervisor = this.sessionConnectionSupervisor;
            const result = supervisor
                ? await runSupervisedRequest({
                    supervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request,
                })
                : await request();
            if (wasCanonical && this.canonicalPendingDeliveryByLocalId.has(localId)) {
                this.canonicalPendingDeliveryByLocalId.delete(localId);
                this.materializationRuntime.deleteMaterializedLocalId(localId);
            }
            this.applyPendingDeliveryActionQueueState(result.pendingQueueState ?? null);
            logger.debug('[pendingQueue] provider delivery block succeeded', {
                sessionId: this.sessionId,
                localId,
                reason,
                canonical: wasCanonical,
                ...(result.pendingQueueState
                    ? {
                        pendingCount: result.pendingQueueState.pendingCount,
                        pendingBlockedCount: result.pendingQueueState.pendingBlockedCount,
                        pendingVersion: result.pendingQueueState.pendingVersion,
                    }
                    : {}),
            });
            return true;
        } catch (error) {
            logger.debug('[pendingQueue] failed to block pending delivery', {
                sessionId: this.sessionId,
                localId,
                reason,
                error: serializeAxiosErrorForLog(error),
            });
            await this.retireStaleCanonicalPendingDeliveryAfterTerminalMiss(localId, 'block', error);
        }
        return false;
    }

    async retryPendingMessageDelivery(params: Readonly<{ localId: string }>): Promise<boolean> {
        const localId = typeof params.localId === 'string' ? params.localId.trim() : '';
        if (this.closed || localId.length === 0) return false;

        try {
            const request = async () => await retryPendingQueueV2Delivery({
                token: this.token,
                sessionId: this.sessionId,
                localId,
            });
            const supervisor = this.sessionConnectionSupervisor;
            const result = supervisor
                ? await runSupervisedRequest({
                    supervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request,
                })
                : await request();
            this.applyPendingDeliveryActionQueueState(result.pendingQueueState ?? null);
            logger.debug('[pendingQueue] provider delivery retry succeeded', {
                sessionId: this.sessionId,
                localId,
                ...(result.pendingQueueState
                    ? {
                        pendingCount: result.pendingQueueState.pendingCount,
                        pendingBlockedCount: result.pendingQueueState.pendingBlockedCount,
                        pendingVersion: result.pendingQueueState.pendingVersion,
                    }
                    : {}),
            });
            return true;
        } catch (error) {
            logger.debug('[pendingQueue] failed to retry pending delivery', {
                sessionId: this.sessionId,
                localId,
                error: serializeAxiosErrorForLog(error),
            });
        }
        return false;
    }

    private async blockProviderDeliveriesBeforeClose(): Promise<void> {
        if (!this.shouldRequestProviderDeliveryState()) return;

        for (const localId of [...this.canonicalPendingDeliveryByLocalId.keys()]) {
            if (this.acceptedCanonicalPendingDeliveryRetryLocalIds.has(localId)) {
                logger.debug('[pendingQueue] skipping provider-accepted delivery block during close after resolution retry failed', {
                    sessionId: this.sessionId,
                    localId,
                });
                continue;
            }
            await this.blockPendingQueueDeliveryLocalId(localId, 'runtime_disposed_before_delivery', {
                canonicalOnly: true,
            });
        }

        const pendingQueueState = this.materializationRuntime.getPendingQueueState();
        if (!pendingQueueState.known || countMaterializablePendingRows(pendingQueueState) <= 0) return;

        let durableProviderLocalIds: string[];
        try {
            const request = async () => await listPendingQueueV2ProviderDeliveryLocalIdsFromServer({
                token: this.token,
                sessionId: this.sessionId,
            });
            const supervisor = this.sessionConnectionSupervisor;
            durableProviderLocalIds = supervisor
                ? await runSupervisedRequest({
                    supervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request,
                })
                : await request();
        } catch (error) {
            logger.debug('[pendingQueue] provider delivery close recovery lookup failed', {
                sessionId: this.sessionId,
                error: serializeAxiosErrorForLog(error),
            });
            return;
        }

        for (const localId of durableProviderLocalIds) {
            if (this.acceptedCanonicalPendingDeliveryRetryLocalIds.has(localId)) {
                logger.debug('[pendingQueue] skipping durable provider delivery block during close after accepted resolution retry failed', {
                    sessionId: this.sessionId,
                    localId,
                });
                continue;
            }
            await this.blockPendingQueueDeliveryLocalId(localId, 'runtime_disposed_before_delivery', {
                canonicalOnly: false,
            });
        }
    }

    /**
     * Opt-in (HF-1): the active runtime has a provider-acceptance seam; stop persisting the
     * watermark at queue handoff and wait for `confirmUserMessageDeliveredToProvider`.
     */
    deferDeliveredUserMessageWatermarkToProviderAcceptance(opts: {
        pendingMaterialization?: ProviderAcceptancePendingMaterializationPolicy;
    } = {}): void {
        this.deferDeliveredUserMessageWatermark = true;
        this.providerAcceptancePendingMaterializationPolicy =
            normalizeProviderAcceptancePendingMaterializationPolicy(opts.pendingMaterialization);
        void this.updateMetadata((metadata) =>
            mergeUserMessageDeliveryWatermarkModeV1(metadata, 'providerAcceptance').metadata,
        ).catch((error) => {
            logger.debug('[API] Failed to persist user-message delivery watermark mode (best-effort)', error);
        });
        if (recoversProviderDeliveryAttachBeforeMaterialization(this.providerAcceptancePendingMaterializationPolicy)) {
            void this.blockInheritedProviderDeliveryClaimsOnAttach();
        }
    }

    private async blockInheritedProviderDeliveryClaimsOnAttach(): Promise<void> {
        if (this.closed || this.providerDeliveryAttachRecoveryCompleted) return;
        if (this.providerDeliveryAttachRecoveryInFlight) {
            await this.providerDeliveryAttachRecoveryInFlight;
            if (this.closed || this.providerDeliveryAttachRecoveryCompleted) return;
        }
        const run = async (): Promise<void> => {
            const request = async () => await blockPendingQueueV2ProviderDeliveriesOnAttach({
                token: this.token,
                sessionId: this.sessionId,
            });
            const supervisor = this.sessionConnectionSupervisor;
            const result = supervisor
                ? await runSupervisedRequest({
                    supervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request,
                })
                : await request();
            this.applyPendingDeliveryActionQueueState(result.pendingQueueState ?? null);
            this.providerDeliveryAttachRecoveryCompleted = true;
        };

        const recovery = run().catch((error) => {
            logger.debug('[pendingQueue] provider delivery attach recovery failed', {
                sessionId: this.sessionId,
                error: serializeAxiosErrorForLog(error),
            });
        }).finally(() => {
            if (this.providerDeliveryAttachRecoveryInFlight === recovery) {
                this.providerDeliveryAttachRecoveryInFlight = null;
            }
        });
        this.providerDeliveryAttachRecoveryInFlight = recovery;
        await recovery;
    }

    private async recoverInheritedProviderDeliveryClaimsBeforeMaterialization(): Promise<void> {
        if (!this.shouldRequestProviderDeliveryState()) return;
        if (this.providerDeliveryAttachRecoveryCompleted) return;
        const pendingQueueState = this.materializationRuntime.getPendingQueueState();
        if (!pendingQueueState.known || pendingQueueState.pendingCount <= 0) return;
        await this.blockInheritedProviderDeliveryClaimsOnAttach();
    }

    private persistLocallyConsumedUserMessageSeqs(seqs: readonly number[]): void {
        const normalizedSeqs = this.normalizeUserMessageDeliverySeqs({ userMessageSeqs: seqs });
        if (normalizedSeqs.length === 0) return;
        for (const seq of normalizedSeqs) {
            this.locallyConsumedUserMessageSeqs.add(seq);
        }
        void this.updateMetadata((metadata) =>
            mergeLocallyConsumedUserMessageSeqsV1(metadata, normalizedSeqs).metadata,
        ).catch((error) => {
            logger.debug('[API] Failed to persist locally consumed user-message seqs (best-effort)', error);
        });
    }

    /**
     * Local prompt-loop consumption: the CLI host completed this user row without sending it to
     * the provider. This keeps replayed local slash commands from being handled again while keeping
     * provider-accepted custody metadata reserved for rows accepted by the provider runtime.
     */
    confirmUserMessageLocallyConsumed(confirmation: LocallyConsumedUserMessageConfirmation): void {
        const localIds = this.normalizeUserMessageDeliveryLocalIds(confirmation.localIds);
        const exactSeqs = this.normalizeUserMessageDeliverySeqs(confirmation);
        const seqs = exactSeqs.length > 0
            ? exactSeqs
            : localIds.length === 0
                ? []
                : this.normalizeUserMessageDeliverySeqs(confirmation, { includeScalarFallback: true });

        for (const localId of localIds) {
            const committedSeq = this.committedUserMessageSeqTracker.get(localId);
            if (committedSeq !== null) {
                this.clearLocallyConsumedUserMessageLocalIdAwaitingSeq(localId);
                if (!seqs.includes(committedSeq)) {
                    seqs.push(committedSeq);
                }
            } else {
                this.markLocallyConsumedUserMessageLocalIdAwaitingSeq(localId);
            }
        }

        this.persistLocallyConsumedUserMessageSeqs(seqs);
    }

    /**
     * Provider-acceptance confirmation (HF-1): the runtime proved provider custody for these
     * exact local row identities. Seq-only callers must provide exact seqs; local ids let this
     * join acceptance with a later server echo when provider acceptance wins the race.
     */
    confirmUserMessageDeliveredToProvider(acceptance: ProviderUserMessageDeliveryAcceptance): void {
        const localIds = this.normalizeUserMessageDeliveryLocalIds(acceptance.localIds);
        const exactSeqs = this.normalizeUserMessageDeliverySeqs(acceptance);
        const seqs = exactSeqs.length > 0
            ? exactSeqs
            : localIds.length === 0
                ? []
                : this.normalizeUserMessageDeliverySeqs(acceptance, { includeScalarFallback: true });
        let highestAcceptedSeq = localIds.length === 0 && seqs.length > 0 ? Math.max(...seqs) : null;
        const acceptedCanonicalPendingLocalIds = new Set<string>();
        const acceptedCanonicalSeqByLocalId = new Map<string, number>();
        const exactSingleLocalIdSeq = localIds.length === 1 && seqs.length === 1 ? seqs[0] : null;
        let sawCanonicalPendingLocalId = false;

        for (const localId of localIds) {
            if (this.canonicalPendingDeliveryByLocalId.has(localId)) {
                sawCanonicalPendingLocalId = true;
                acceptedCanonicalPendingLocalIds.add(localId);
                const committedSeq = this.committedUserMessageSeqTracker.get(localId);
                if (committedSeq !== null) {
                    acceptedCanonicalSeqByLocalId.set(localId, committedSeq);
                } else if (exactSingleLocalIdSeq !== null) {
                    this.recordCommittedUserMessageSeq(localId, exactSingleLocalIdSeq);
                    acceptedCanonicalSeqByLocalId.set(localId, exactSingleLocalIdSeq);
                }
                this.markProviderAcceptedUserMessageLocalIdAwaitingSeq(localId);
                continue;
            } else {
                this.materializationRuntime.deleteMaterializedLocalId(localId);
            }
            const committedSeq = this.committedUserMessageSeqTracker.get(localId);
            if (committedSeq !== null) {
                highestAcceptedSeq = Math.max(highestAcceptedSeq ?? -1, committedSeq);
                this.clearProviderAcceptedUserMessageLocalIdAwaitingSeq(localId);
            } else {
                this.markProviderAcceptedUserMessageLocalIdAwaitingSeq(localId);
            }
        }

        if (!sawCanonicalPendingLocalId && highestAcceptedSeq === null && seqs.length > 0) {
            highestAcceptedSeq = Math.max(...seqs);
        }

        if (highestAcceptedSeq !== null) {
            this.persistDeliveredUserMessageWatermarkSeq(highestAcceptedSeq);
        }

        if (acceptedCanonicalPendingLocalIds.size > 0) {
            void this.resolveAcceptedCanonicalPendingDeliveries([...acceptedCanonicalPendingLocalIds], acceptedCanonicalSeqByLocalId);
        }
    }

    private persistDeliveredUserMessageWatermarkSeq(seq: number): void {
        if (!Number.isInteger(seq) || seq < 0) return;
        this.highestProviderAcceptedUserMessageSeq = Math.max(this.highestProviderAcceptedUserMessageSeq ?? -1, seq);
        this.highestDeliveredUserMessageSeq = Math.max(this.highestDeliveredUserMessageSeq ?? -1, seq);
        void this.persistDeliveredUserMessageSeq();
    }

    private readDeliveredUserMessagePersistTarget(): number | null {
        const target = this.deferDeliveredUserMessageWatermark
            ? this.highestProviderAcceptedUserMessageSeq
            : this.highestDeliveredUserMessageSeq;
        return target !== null && Number.isInteger(target) && target >= 0 ? target : null;
    }

    private canPersistDeliveredUserMessageTarget(target: number): boolean {
        if (!this.deferDeliveredUserMessageWatermark) return true;
        return (this.highestProviderAcceptedUserMessageSeq ?? -1) >= target;
    }

    private async persistDeliveredUserMessageSeq(): Promise<void> {
        if (this.deliveredUserMessageSeqPersistInFlight) return;
        const target = this.readDeliveredUserMessagePersistTarget();
        if (target === null) return;
        if (!this.canPersistDeliveredUserMessageTarget(target)) return;
        this.deliveredUserMessageSeqPersistInFlight = true;
        let persistedTarget = false;
        try {
            await this.updateMetadata((metadata) => {
                if (!this.canPersistDeliveredUserMessageTarget(target)) return metadata;
                persistedTarget = true;
                const delivered = mergeDeliveredUserMessageSeqV1(metadata, target).metadata;
                if ((this.highestProviderAcceptedUserMessageSeq ?? -1) < target) {
                    return delivered;
                }
                return mergeProviderAcceptedUserMessageSeqV1(delivered, target).metadata;
            });
        } catch (error) {
            logger.debug('[API] Failed to persist delivered user-message watermark (best-effort)', error);
            return;
        } finally {
            this.deliveredUserMessageSeqPersistInFlight = false;
        }
        // A newer delivery, or provider acceptance for the same delivery, may have arrived while
        // the write was in flight; converge only when the current custody policy allows it.
        const nextTarget = this.readDeliveredUserMessagePersistTarget();
        if (
            nextTarget !== null
            && this.canPersistDeliveredUserMessageTarget(nextTarget)
            && (nextTarget > target || (nextTarget === target && !persistedTarget))
        ) {
            void this.persistDeliveredUserMessageSeq();
        }
    }

    updateMetadata(handler: (metadata: Metadata) => Metadata): Promise<void> {
        return this.metadataLock.inLock(async () => {
            await this.waitForSessionSocketOnlineForAckWrite('update-metadata');
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
                syncSessionSnapshotFromServer: async () => {
                    await this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
                },
                handler,
            });
        });
    }

    getStoredContentEncryptionContext(): Readonly<{
        mode: 'e2ee' | 'plain';
        ctx?: Readonly<{
            encryptionKey: Uint8Array;
            encryptionVariant: 'legacy' | 'dataKey';
        }>;
    }> {
        if (this.sessionEncryptionMode === 'plain') {
            return { mode: 'plain' };
        }
        return {
            mode: 'e2ee',
            ctx: {
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
            },
        };
    }

    async updateRuntimeActivityProjection(projection: Readonly<{
        runtimeActivityActiveCount: number;
        runtimeActivityObservedAt: number | null;
        runtimeActivityExpiresAt: number | null;
        runtimeActivitySourceClass: SessionRuntimeActivitySourceClassV1 | null;
    }>): Promise<void> {
        await this.waitForSessionSocketOnlineForAckWrite('update-runtime-activity');
        await updateSessionRuntimeActivityProjectionWithAck({
            socket: this.socket as any,
            sessionId: this.sessionId,
            runtimeActivityActiveCount: projection.runtimeActivityActiveCount,
            runtimeActivityObservedAt: projection.runtimeActivityObservedAt,
            runtimeActivityExpiresAt: projection.runtimeActivityExpiresAt,
            runtimeActivitySourceClass: projection.runtimeActivitySourceClass,
        });
        this.runtimeActivityProjection = projection;
    }

    private applyRuntimeActivityProjectionFromServer(projectionLike: unknown): void {
        const projection = readRuntimeActivityProjectionForPendingDrain(projectionLike);
        this.runtimeActivityProjection = projection;
    }

    async upsertSessionSystemRecord(request: SessionSystemRecordUpsertRequest): Promise<void> {
        await upsertSessionSystemRecordHttp({
            token: this.token,
            sessionId: this.sessionId,
            namespace: request.namespace,
            kind: request.kind,
            localId: request.localId,
            content: request.content,
        });
    }

    async fetchSessionSystemRecord(params: Readonly<{
        namespace: SessionSystemRecordNamespace;
        localId: string;
    }>): Promise<SessionSystemRecord | null> {
        return fetchSessionSystemRecordHttp({
            token: this.token,
            sessionId: this.sessionId,
            namespace: params.namespace,
            localId: params.localId,
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
                error: serializeAxiosErrorForLog(error),
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
            await this.waitForSessionSocketOnlineForAckWrite('update-state');
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
                syncSessionSnapshotFromServer: async () => {
                    await this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
                },
                handler,
            });
        });
    }

    enqueueSessionTurnMutation(mutation: SessionTurnMutationV1): Promise<void> {
        const observed = this.observeSessionTurnMutationForCachedTurnStatus(mutation);
        const persistedUpdate = this.durableMutationOutbox.enqueueSessionTurnMutation(mutation);
        const update = observed.isTerminal
            ? persistedUpdate.then(async () => {
                await this.durableMutationOutbox.flush('flush');
            }).finally(() => {
                this.observeDurableTerminalSessionTurnMutationForPendingDrain(mutation);
            })
            : persistedUpdate;
        this.trackPendingUpdate(this.pendingSessionTurnMutationUpdates, update);
        return update;
    }

    enqueueRegisteredSessionStateFieldMutation(mutation: RegisteredSessionStateFieldMutationV1): Promise<void> {
        const update = this.durableMutationOutbox.enqueueRegisteredSessionStateFieldMutation(mutation);
        this.trackPendingUpdate(this.pendingRegisteredSessionStateFieldUpdates, update);
        return update;
    }

    private enqueueSessionEndMutation(mutation: SessionEndMutationV1): Promise<void> {
        const update = this.durableMutationOutbox.enqueueSessionEnd(mutation);
        this.trackPendingUpdate(this.pendingSessionEndMutationUpdates, update);
        return update;
    }

    private async drainBestEffortSessionWrites(): Promise<void> {
        await Promise.all([
            this.providerTranscriptDispatchTail.catch(() => undefined),
            this.messageCommitQueueTail.catch(() => undefined),
            this.durableMutationOutbox.flush('flush').catch(() => undefined),
            ...[...this.pendingSessionTurnMutationUpdates].map((update) => update.catch(() => undefined)),
            ...[...this.pendingTranscriptMessageUpdates].map((update) => update.catch(() => undefined)),
            ...[...this.pendingRegisteredSessionStateFieldUpdates].map((update) => update.catch(() => undefined)),
        ]);
        await this.messageCommitQueueTail.catch(() => undefined);
    }

    private async drainPendingLifecycleWritesBeforeClose(): Promise<void> {
        await Promise.all([
            this.providerTranscriptDispatchTail.catch(() => undefined),
            ...[...this.pendingSessionTurnMutationUpdates].map((update) => update.catch(() => undefined)),
            ...[...this.pendingSessionEndMutationUpdates].map((update) => update.catch(() => undefined)),
            ...[...this.pendingTranscriptMessageUpdates].map((update) => update.catch(() => undefined)),
            ...[...this.pendingRegisteredSessionStateFieldUpdates].map((update) => update.catch(() => undefined)),
        ]);
        await this.messageCommitQueueTail.catch(() => undefined);
    }

    /**
     * Wait for socket buffer to flush
     */
    async flush(): Promise<void> {
        await this.drainBestEffortSessionWrites();
        if (!this.socket.connected) {
            return;
        }
        return new Promise((resolve) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | null = null;
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer) {
                    clearTimeout(timer);
                }
                resolve();
            };
            this.socket.emit('ping', () => {
                finish();
            });
            timer = setTimeout(() => {
                finish();
            }, 10000);
            timer.unref?.();
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

    getCommittedUserMessageSeq(localId: string): number | null {
        return this.committedUserMessageSeqTracker.get(localId);
    }

    waitForCommittedUserMessageSeq(
        localId: string,
        options?: CommittedUserMessageSeqWaitOptions,
    ): Promise<number | null> {
        return this.committedUserMessageSeqTracker.wait(localId, options);
    }

    getTurnAssistantTextSnapshotStore(): TurnAssistantTextSnapshotStore {
        return this.turnAssistantTextSnapshotStore;
    }

    async close() {
        this.clearPendingMaterializeRetryWake();
        await this.interactionApi.close();
        this.clearPendingMaterializeRetryWake();
        await this.drainPendingLifecycleWritesBeforeClose();
        await this.durableMutationOutbox.close();
    }

    async listPendingMessageQueueV2LocalIds(): Promise<string[]> {
        return await this.interactionApi.listPendingMessageQueueV2LocalIds();
    }

    async peekPendingMessageQueueV2Count(): Promise<number> {
        return await this.interactionApi.peekPendingMessageQueueV2Count();
    }

    shouldAttemptPendingMaterialization(opts: {
        activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
    } = {}): boolean {
        return this.materializationRuntime.shouldAttemptPendingMaterialization(opts);
    }

    getPendingQueueState(): PendingQueueState {
        return this.materializationRuntime.getPendingQueueState();
    }

    async reconcilePendingQueueState(opts?: { force?: boolean }): Promise<boolean> {
        return await this.interactionApi.reconcilePendingQueueState(opts);
    }

    async materializeNextPendingMessageSafely(opts: {
        reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
        activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
        deliveryTiming?: PendingMaterializationDeliveryTiming;
    } = {}): Promise<MaterializeNextPendingResult> {
        return await this.interactionApi.materializeNextPendingMessageSafely(opts);
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

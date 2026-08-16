import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import axios from 'axios';
import { Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, MessageAckResponseSchema, MessageContent, Metadata, ServerToClientEvents, Session, SessionMessageContent, SessionMessageContentSchema, Update, UserMessage, UserMessageSchema, Usage } from '../types'
import { decodeBase64, decrypt, encodeBase64, encrypt } from '../encryption';
import { backoff, delayUnrefAbortable } from '@/utils/time';
import { LruSet } from '@/utils/collections/lru';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import { createSerializedWorkQueueDiagnostics, type SerializedWorkDiagnosticContext } from '@/utils/serializedWorkQueueDiagnostics';
import { readPendingLocalId } from '@happier-dev/protocol';
import { inferAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { configuration } from '@/configuration';
import type { RawJSONLines } from '@/backends/claude/types';
import {
    buildClaudeJsonlLocalId,
    buildClaudeJsonlLocalIdFromMessageKey,
    buildClaudeJsonlMessageKey,
    extractClaudeJsonlMessageKeyFromLocalId,
    extractClaudeJsonlMessageKeyFromSessionContent,
    type CommittedClaudeJsonlMessageBaseline,
} from '@/backends/claude/utils/claudeJsonlMessageKey';
import { randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerSessionHandlers } from '@/rpc/handlers/registerSessionHandlers';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import {
    clearSessionRuntimeControls,
    copyCallableSessionRuntimeControls,
} from './sessionRuntimeControls';
import { registerExecutionRunHandlers } from '@/rpc/handlers/executionRuns';
import { createExecutionRunTranscriptWriter } from '@/api/session/executionRunTranscriptWriter';
import { registerEphemeralTaskHandlers } from '@/rpc/handlers/ephemeralTasks';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import {
    fetchSessionSystemRecord as fetchSessionSystemRecordHttp,
    fetchSessionSystemRecordsPage as fetchSessionSystemRecordsPageHttp,
    upsertSessionSystemRecord as upsertSessionSystemRecordHttp,
} from '@/session/transport/http/sessionSystemRecordsHttp';
import { createExecutionRunBackend } from '@/agent/executionRuns/runtime/createExecutionRunBackend';
import { ExecutionBudgetRegistry } from '@/daemon/executionBudget/ExecutionBudgetRegistry';
import { readCredentials, readAccountChangesCursor } from '@/persistence';
import {
    applyAccountSettingsV2Update,
    bootstrapAccountSettingsContext,
    refreshActiveAccountSettingsFromServer,
} from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol';
import {
    getActiveAccountSettingsSnapshot,
    subscribeActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveSessionPendingQueueDeliveryTiming } from '@/agent/runtime/sessionInput/pendingQueueDrainPolicy';
import type { CatalogAgentId } from '@/backends/types';
import { addDiscardedCommittedMessageLocalIds } from '../queue/discardedCommittedMessageLocalIds';
import { fetchSessionSnapshotUpdateFromServer, shouldSyncSessionSnapshotOnConnect } from './snapshotSync';
import { createUserScopedSocket } from './sockets';
import { isToolTraceEnabled, recordAcpToolTraceEventIfNeeded, recordClaudeToolTraceEvents, recordCodexToolTraceEventIfNeeded } from './toolTrace';
import type {
    SessionRuntimeActivityContributionHandle,
    SessionRuntimeActivitySnapshotPublisher,
} from '@/session/runtimeActivity/types';
import {
    RUNTIME_ACTIVITY_DESIRED_REOFFER_REQUEST,
    createRuntimeActivitySnapshotSessionMutationPublisher,
    type RuntimeActivitySnapshotSessionMutationPublisher,
} from './mutations/runtimeActivitySnapshotSessionMutationPublisher';
import {
    createSessionSyncPendingInputServerContractController,
    supportsPendingInputV1,
    supportsRuntimeActivityV2,
    type SessionSyncPendingInputServerContractResult,
} from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import type { SessionMessageCommitResult } from './sessionMessageCommitResult';

export type SessionRuntimeActivityClientConfig = Readonly<{
    executionRunContributionHandle: SessionRuntimeActivityContributionHandle;
}>;

type SessionMessageCommitObservation = Readonly<{
    localId: string;
    messageId: string;
    seq: number;
    didWrite: boolean | null;
}>;

function requireExactCommitLocalId(localId: unknown): string {
    const exactLocalId = readPendingLocalId(localId);
    if (!exactLocalId) {
        throw new Error('Exact message commit requires a caller-supplied non-blank localId');
    }
    return exactLocalId;
}

function requireExactCommitResult(
    result: SessionMessageCommitObservation | null,
    localId: string,
): SessionMessageCommitResult {
    if (!result || result.localId !== localId || typeof result.didWrite !== 'boolean') {
        throw new Error(`Exact message commit for ${localId} did not return durable didWrite acknowledgement`);
    }
    return {
        localId: result.localId,
        messageId: result.messageId,
        seq: result.seq,
        didWrite: result.didWrite,
    };
}

type ExplicitUserRecoveryDecision =
    | Readonly<{ status: 'ready' }>
    | Readonly<{
        status: 'waiting' | 'action_required' | 'unavailable';
        errorCode: string;
    }>;

function readExplicitUserRecoveryStatus(metadata: Metadata | null) {
    if (!metadata || typeof metadata !== 'object') return null;
    const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(
        (metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
    );
    return parsed.success ? parsed.data.status : null;
}

function hasBlockingExplicitUserRecoveryEvidence(metadata: Metadata | null): boolean {
    const status = readExplicitUserRecoveryStatus(metadata);
    return status === 'waiting' || status === 'armed' || status === 'checking';
}

function hasClearedConnectedServiceTransitionConstraint(metadata: Metadata | null): boolean {
    return readExplicitUserRecoveryStatus(metadata) === 'paused';
}
import {
    updateSessionAgentStateWithAck,
    updateSessionMetadataWithAck,
    updateSessionMetadataWithAckResult,
} from './stateUpdates';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import {
    SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
    SessionUsageLimitRecoveryV1Schema,
    SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT,
    SessionRuntimeActivityCloseAckSchema,
    SessionRuntimeActivityCloseRequestSchema,
    SessionTranscriptObservationProvenanceV1Schema,
} from '@happier-dev/protocol';
import {
    readSessionRuntimeActivityProjectionBoundary,
    type SessionRuntimeActivityProjectionBoundary,
} from './runtimeActivityProjection';
import type {
    PrimaryTurnStatusV1,
    SessionMessageRole,
    SessionPendingQueueDeliveryTiming,
    PendingRequestedActionV1,
    SessionRuntimeActivityProjection,
    SessionSystemRecord,
    SessionSystemRecordKind,
    SessionSystemRecordNamespace,
    SessionSystemRecordUpsertRequest,
    SessionTranscriptObservationProvenanceV1,
} from '@happier-dev/protocol';
import { calculateCost } from '@/utils/pricing';
import { buildAcpAgentMessageEnvelope, shouldTraceAcpMessageType } from './acpMessageEnvelope';
import { normalizeAcpSessionMessageBody, normalizeCodexSessionMessageBody } from './sessionOutboundMessageNormalization';
import {
    resolveAcpSessionMessageRole,
    resolveClaudeSessionMessageRole,
    resolveCodexSessionMessageRole,
    resolveSessionEventMessageRole,
} from './messageRole';
import { buildUsageReportFromAcpTokenCount } from './acpTokenCountUsageReport';
import {
    fetchLatestUserPermissionIntentFromEncryptedTranscript,
    fetchRecentTranscriptTextItemsForAcpImportFromServer,
} from './transcriptQueries';
import {
    discardPendingQueueV2Messages,
    enqueuePendingQueueV2MessageViaHttp,
    listPendingQueueV2DeliveryStatusesFromServer,
    listPendingQueueV2LocalIdsFromServer,
    listPendingQueueV2ProviderDeliveryLocalIdsFromServer,
    materializeNextPendingQueueV2Message,
    blockPendingQueueV2Delivery,
    PendingQueueAcceptedSettlementError,
    PendingQueueMaterializationTransportAmbiguousError,
    isAcceptedPendingQueueV2DeliveryNotFound,
    readAcceptedPendingQueueV2DeliveryRetryDirective,
    resolveAcceptedPendingQueueV2Delivery,
    type PendingMaterializationDeliveryState,
    type PendingQueueDeliveryBlockedReason,
    type PendingQueueMaterializedMessage,
    type PendingQueueMaterializeNextResult,
} from './pendingQueueV2Transport';
import {
    resolvePendingQueueReconcileWhenEmpty,
    type PendingQueueReadOptions,
} from './pendingQueueReadPolicy';
import { waitForTranscriptEncryptedMessageByLocalId } from './transcriptMessageLookup';
import { continuePendingQueueV2OnReleasedServer } from './pendingQueueV2ReleasedServerAdapter';
import { catchUpSessionMessagesAfterSeq } from './sessionMessageCatchUp';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import {
    isV2ChangesSyncEnabled,
    runSessionChangesSyncOnConnect,
    type SessionCatchUpRequest,
    type SessionChangesSyncReason,
} from './sessionChangesSyncOnConnect';
import { fetchChangesAccountId } from '../changes';
import { handleSessionNewMessageUpdate } from './sessionNewMessageUpdate';
import {
    applyAcknowledgedRuntimeActivityProjection as reduceAcknowledgedRuntimeActivityProjection,
    handleSessionStateUpdate,
} from './sessionStateUpdateHandling';
import type { SessionSnapshotRefreshReasonInput } from './sessionSnapshotRefreshReason';
import {
    isActiveLatestTurnStatus,
    isTerminalTurnLifecycleEvent,
    latestTurnStatusForTurnLifecycleEvent,
    readLatestTurnStatusSnapshot,
    type LatestTurnStatusSnapshot,
    type SessionTurnLifecycleObserverEvent,
} from './sessionTurnStatusSnapshot';
import type { ACPMessageData, ACPProvider, SessionEventMessage } from './sessionMessageTypes';
import {
    createTurnAssistantTextSnapshotStore,
    extractTurnAssistantTextFromSessionContent,
    type TurnAssistantTextCandidate,
    type TurnAssistantTextSnapshot,
} from './turnAssistantTextSnapshot';
import {
    createManagedConnectionSupervisor,
    DEFAULT_MANAGED_CONNECTION_POLICY,
    type ManagedConnectionState,
    type ManagedConnectionSupervisor,
    type ReadinessProbeResult,
} from '@happier-dev/connection-supervisor';
import { createLoopbackReadinessProbe } from '@/api/connection/createLoopbackReadinessProbe';
import { createSessionSocketTransport } from './connection/createSessionSocketTransport';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import {
    createAuthenticationHttpStatusError,
    isAuthenticationError,
    readAuthenticationStatus,
} from '@/api/client/httpStatusError';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import {
    createDisconnectedEphemeralSendOutcome,
    type EphemeralSendOutcome,
} from './ephemeralSendOutcome';
import { serializeOutboundError } from './outboundErrorSerialization';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import {
    executeExecutionRunAction,
    getExecutionRun,
    listExecutionRuns,
    sendExecutionRunMessage,
    startExecutionRun,
    stopExecutionRun,
    waitForExecutionRun,
} from '@/session/services/executionRuns';
import { normalizeExecutionRunWaitTimeoutMs } from '@/session/services/executionRunWaitTiming';
import { createEventShapeLoggerForLog } from '@/diagnostics/eventShapeForLog';
import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import { updateAgentStateBestEffort, updateMetadataBestEffort } from './sessionWritesBestEffort';
import { readCliClientUpgradeRequired } from '@/api/clientCompatibility/cliClientCompatibility';
import { normalizeAgentPromptPayload } from '@/agent/core/AgentPromptPayload';
import type {
    MaterializeNextPendingResult,
    SessionUserMessageDeliveryInfo,
} from './sessionClientPort';
import {
    CommittedUserMessageSeqTracker,
    type CommittedUserMessageSeqWaitOptions,
} from './committedUserMessageSeqTracker';
import {
    createSessionMutationOutbox,
    type RuntimeActivitySnapshotTail,
    type SessionMutationOutbox,
} from './mutations/createSessionMutationOutbox';
import {
    createSessionMessageCommitRetry,
    type SessionMessageCommitRetryToken,
} from './sessionMessageCommitRetry';
import {
    createTranscriptMessageAppendMutation,
} from './mutations/sessionMutationTypes';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { observeAcpLifecycleMarker } from '@/agent/runtime/session/turn/lifecycleMarkerAdapter';
import type { SessionTurnLifecycleControllerWithActiveTurnWitness } from '@/agent/runtime/session/turn/types';
import { createSessionTurnMutationWriter } from '@/agent/runtime/session/turn/writer';
import { notifyDaemonConnectedServiceTurnLifecycle, notifyDaemonConnectedServiceUsageLimitWaitResumeCancel } from '@/daemon/controlClient';
import {
    ConnectedServiceTurnLifecycleResultSchema,
    type ConnectedServiceTurnLifecycleResult,
} from '@/daemon/connectedServices/connectedServiceTurnLifecycleContract';
import {
    applyKnownPendingQueueState,
    countMaterializablePendingRows,
    derivePendingQueueStateAfterMaterializeResult,
    readKnownPendingQueueState,
    UNKNOWN_PENDING_QUEUE_STATE,
    type KnownPendingQueueState,
    type PendingQueueState,
} from './pendingQueueState';
import type { PendingForegroundSteerability } from './pendingForegroundSteerability';
import {
    type PendingQueueRuntimeActivityProjection,
} from '@/agent/runtime/sessionInput/pendingQueueDrainPolicy';
import type { ProviderOwnedUserMessageEchoClassifier } from './providerOwnedUserMessageEcho';

export type SessionProviderInputOutcomeProducer = Readonly<{
    providerId: CatalogAgentId;
    mode: string;
    /** Provider-owned proof that this producer is the active runtime tuple for this session. */
    matchesCurrentSession: (session: Readonly<{ metadata: Metadata | null }>) => boolean;
}>;

type SessionProviderInputOutcomeIdentity = Readonly<{
    localId: string;
}>;

export type SessionProviderInputRejectedBeforeEffectReason = Extract<
    PendingQueueDeliveryBlockedReason,
    | 'terminal_composer_draft'
    | 'runtime_config_blocked'
    | 'provider_unavailable_before_acceptance'
    | 'runtime_disposed_before_delivery'
    | 'invalid_prompt_text'
    | 'attempt_expired_before_write'
    | 'provider_rejected_before_acceptance'
    | 'steering_unavailable'
    | 'payload_too_large'
>;

const PROVIDER_INPUT_REJECTED_BEFORE_EFFECT_REASONS = new Set<PendingQueueDeliveryBlockedReason>([
    'terminal_composer_draft',
    'runtime_config_blocked',
    'provider_unavailable_before_acceptance',
    'runtime_disposed_before_delivery',
    'invalid_prompt_text',
    'attempt_expired_before_write',
    'provider_rejected_before_acceptance',
    'steering_unavailable',
    'payload_too_large',
]);

const REVERSIBLE_PROVIDER_INPUT_BLOCK_REASONS = new Set<PendingQueueDeliveryBlockedReason>([
    'terminal_composer_draft',
    'runtime_config_blocked',
    'provider_unavailable_before_acceptance',
]);

function isReversibleProviderInputBlockReason(
    reason: PendingQueueDeliveryBlockedReason,
): boolean {
    return REVERSIBLE_PROVIDER_INPUT_BLOCK_REASONS.has(reason);
}

function isSessionProviderInputRejectedBeforeEffectReason(
    value: unknown,
): value is SessionProviderInputRejectedBeforeEffectReason {
    return typeof value === 'string'
        && PROVIDER_INPUT_REJECTED_BEFORE_EFFECT_REASONS.has(value as PendingQueueDeliveryBlockedReason);
}

export type SessionProviderInputOutcome =
    | (SessionProviderInputOutcomeIdentity & Readonly<{
        kind: 'accepted';
        providerRequestId?: string;
        providerTurnId?: string;
        /** Model captured for this new provider prompt before dispatch. Omitted for in-flight steer. */
        appliedModelId?: string;
    }>)
    | (SessionProviderInputOutcomeIdentity & Readonly<{
        kind: 'rejected_before_effect';
        reason: SessionProviderInputRejectedBeforeEffectReason;
    }>)
    | (SessionProviderInputOutcomeIdentity & Readonly<{ kind: 'effect_may_have_occurred' }>)
    | (SessionProviderInputOutcomeIdentity & Readonly<{ kind: 'custody_observed' }>);

export type SessionProviderInputOutcomeObserver = (outcome: SessionProviderInputOutcome) => void;

function resolveSessionCatalogAgentId(metadata: unknown): CatalogAgentId {
    return inferAgentIdFromSessionMetadata(metadata, 'claude');
}

type RpcLifecycleRegistration = Readonly<{
    dispose: () => Promise<void>;
}>;

const STALE_LOCAL_ACTIVE_TURN_RECONCILE_MS = 5 * 60 * 1000;

function isProviderProgressTranscriptBody(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const role = (value as { role?: unknown }).role;
    return role !== 'user';
}

function readPlannedServerRestartRetryAfterMs(payload: unknown): number | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const raw = (payload as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
    return Math.trunc(raw);
}

function arePendingQueueStatesEqual(left: PendingQueueState, right: PendingQueueState): boolean {
    if (left.known !== right.known) return false;
    if (!left.known || !right.known) return true;
    return left.pendingCount === right.pendingCount
        && left.pendingBlockedCount === right.pendingBlockedCount
        && left.pendingVersion === right.pendingVersion;
}

type RuntimeActivityProjectionForPendingDrain = PendingQueueRuntimeActivityProjection & Readonly<{
    runtimeActivityObservedAt?: unknown;
}>;

function readRuntimeActivityProjectionForPendingDrain(value: unknown): RuntimeActivityProjectionForPendingDrain {
    return readSessionRuntimeActivityProjectionBoundary(value);
}

function resolveSessionSocketMachineIdForBootstrap(metadata: Metadata | null): string | undefined {
    if (!metadata || typeof metadata.machineId !== 'string') {
        return undefined;
    }
    const machineId = metadata.machineId.trim();
    return machineId.length > 0 ? machineId : undefined;
}

function readUnknownRecordProperty(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[key];
}

function isTerminalPendingDeliveryNotFound(
    operation: 'accepted' | 'block',
    error: unknown,
): boolean {
    if (operation === 'accepted') {
        return isAcceptedPendingQueueV2DeliveryNotFound(error);
    }
    return axios.isAxiosError(error) && error.response?.status === 404;
}

function serializeAcceptedPendingSettlementErrorForLog(error: unknown): Record<string, unknown> {
    const serialized = serializeAxiosErrorForLog(error);
    if (!(error instanceof PendingQueueAcceptedSettlementError)) return serialized;
    return {
        ...serialized,
        settlementError: error.settlementError,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
        ...(error.correlationId ? { correlationId: error.correlationId } : {}),
    };
}

export function classifySessionTransportErrorToProbeResult(
    error: unknown,
): Exclude<ReadinessProbeResult, Readonly<{ status: 'ready' }>> | null {
    if (readCliClientUpgradeRequired(error)) {
        return {
            status: 'auth_failed',
            statusCode: 426,
            errorMessage: 'This Happier session runner must be upgraded before it can sync sessions.',
        };
    }
    const statusCode = readAuthenticationStatus(error);
    if (!statusCode) return null;
    return {
        status: 'auth_failed',
        statusCode,
        errorMessage: error instanceof Error ? error.message : 'Authentication failed',
    };
}

const SESSION_CONNECTION_STATE_EVENT = 'session-connection-state';
const SESSION_PRESENCE_RECONNECT_REASSERT_DELAY_MS = 2_000;
// How long a `thinking=true` keepalive may persist against an already-terminal turn status
// before the publisher self-heals it to idle. Comfortably longer than a new turn's
// status-update lag, well under the UI's ~120s thinking-freshness window.
const STUCK_THINKING_TERMINAL_KEEPALIVE_GUARD_MS = 15_000;
const SESSION_CLIENT_RECEIVED_MESSAGE_ID_CACHE_MAX_ENTRIES = 1_000;
const SESSION_CLIENT_TOOL_CALL_CACHE_MAX_ENTRIES = 1_000;
type SessionSocketAckWriteEvent = 'update-metadata' | 'update-state';
type SessionAliveMode = 'local' | 'remote';
type SessionAlivePayload = Readonly<{
    sid: string;
    time: number;
    thinking: boolean;
    mode: SessionAliveMode;
    latestTurnStatus?: PrimaryTurnStatusV1;
    latestTurnStatusObservedAt?: number;
}>;
type SessionPresenceSnapshot = Readonly<{
    thinking: boolean;
    mode: SessionAliveMode;
}>;
type AcceptedCanonicalPendingDeliveryOperationAuthority = Readonly<{
    producerGeneration: number;
    sessionConnectionEpoch: number;
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    abortSignal: AbortSignal;
}>;

function readFiniteTimestampMs(value: unknown): number | null {
    if (typeof value !== 'number' && typeof value !== 'bigint') return null;
    const numeric = typeof value === 'bigint' ? Number(value) : value;
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    return Math.trunc(numeric);
}

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

export class ApiSessionClient extends EventEmitter {
    private static readonly STARTUP_MESSAGE_CATCH_UP_RETRY_DELAYS_MS = [250, 1_000, 2_500] as const;

    private readonly token: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private sessionSocketMachineId: string | undefined;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket!: Socket<ServerToClientEvents, ClientToServerEvents>;
    private userSocket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessages: UserMessage[] = [];
    private readonly bufferedPendingMessageDeliveryInfoByLocalId = new Map<string, SessionUserMessageDeliveryInfo>();
    private pendingMessageCallback: ((message: UserMessage, info?: SessionUserMessageDeliveryInfo) => unknown | Promise<unknown>) | null = null;
    readonly rpcHandlerManager: RpcHandlerManager;
    private readonly rpcLifecycleRegistrations: RpcLifecycleRegistration[] = [];
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
    private queuedDisconnectedSessionMessages = new Map<string, { message: string | { t: 'plain'; v: unknown }; localId: string; sidechainId: string | null; messageRole?: SessionMessageRole; sessionEventType?: 'ready'; retryToken?: SessionMessageCommitRetryToken }>();
    private readonly sessionEncryptionMode: 'e2ee' | 'plain';
    private disconnectedSendLogged = false;
    private latestSessionPresence: SessionPresenceSnapshot = { thinking: false, mode: 'remote' };
    private reconnectPresenceReassertTimer: ReturnType<typeof setTimeout> | null = null;
    // LocalId registries are intentionally phase-specific:
    // pendingMaterializedLocalIds: optimistic UI rows awaiting materialization.
    // committedLocalIdsAwaitingEcho: committed outbound rows awaiting socket echo.
    // pendingQueueMaterializedLocalIds: pending queue rows already emitted locally.
    // agentQueueEchoSuppressedLocalIds: local prompt echoes already handled for the live queue.
    // agentQueueDeliveredLocalIds: prompt attempts already handed to the live agent queue.
    // explicitUserRecoveryDecisionsByLocalId: one provider-neutral pre-delivery decision for each
    //   fresh direct prompt id. The result, including a blocking result, is replayed exactly once.
    private readonly pendingMaterializedLocalIds = new Set<string>();
    private readonly committedLocalIdsAwaitingEcho = new Set<string>();
    private readonly pendingQueueMaterializedLocalIds = new Set<string>();
    private readonly canonicalPendingDeliveryByLocalId = new Map<string, PendingMaterializationDeliveryState>();
    // Generic reversible provider-path blocks retain identity so exact late provider evidence can
    // still settle the row. A proven pre-provider lifecycle failure retires it after durable block.
    private readonly serverBlockedCanonicalPendingDeliveryLocalIds = new Set<string>();
    // A source-cutover deferral has proven no Provider effect. Preserve the server's delivering
    // claim through predecessor shutdown so the successor can rejoin its ordinary first delivery.
    private readonly sourceCutoverDeferredPendingLocalIds = new Set<string>();
    private readonly agentQueueEchoSuppressedLocalIds = new Set<string>();
    private readonly agentQueueDeliveredLocalIds = new Set<string>();
    private readonly explicitUserRecoveryDecisionsByLocalId = new Map<string, Promise<ExplicitUserRecoveryDecision>>();
    private readonly acceptedProviderInputLocalIds = new Set<string>();
    private providerInputOutcomeProducerGeneration = 0;
    private readonly providerInputTerminalOutcomeByLocalId = new Map<string, 'accepted' | 'rejected_before_effect'>();
    private readonly providerInputUncertainLocalIds = new Set<string>();
    private readonly acceptedCanonicalPendingDeliveryResolutionWrites = new Set<Promise<void>>();
    private readonly acceptedCanonicalPendingDeliveryResolutionLocalIdsInFlight = new Set<string>();
    private readonly acceptedCanonicalPendingDeliveryOperationAbortController = new AbortController();
    private readonly committedLocalIdCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly agentQueueEchoSuppressedLocalIdCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly agentQueueDeliveredLocalIdCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly explicitUserRecoveryCheckedLocalIdCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private pendingWakeSeq = 0;
    private pendingQueueState: PendingQueueState = UNKNOWN_PENDING_QUEUE_STATE;
    private pendingQueueStateReconcileInFlight: Promise<boolean> | null = null;
    private lastPendingQueueStateReconcileAt = 0;
    private latestTurnStatus: LatestTurnStatusSnapshot | undefined = undefined;
    private latestTurnStatusObservedAtMs: number | null = null;
    // Defense-in-depth against a stuck `thinking=true` keepalive that no live turn backs:
    // when the latest turn status is already terminal but `thinking` stays latched, the 2s
    // keepalive would otherwise republish thinking=true with fresh timestamps forever
    // (stuck "working"/"online"). We tolerate a brief window (a new turn's status update can
    // lag its thinking flip) then self-heal to idle, emitting one-shot telemetry.
    private thinkingLatchTerminalSinceMs: number | null = null;
    private reportedStuckThinkingSelfHeal = false;
    private localActiveTurnStartedAtMs: number | null = null;
    private lastLocalActiveTurnProgressAtMs: number | null = null;
    private runtimeActivityProjection: RuntimeActivityProjectionForPendingDrain = {};
    private lastTurnStatusRefreshPendingVersion: number | null = null;
    private lastBlockedTurnStatusRefreshAt = 0;
    private readonly sessionMessageCommitRetry = createSessionMessageCommitRetry<{
        message: string | { t: 'plain'; v: unknown };
        sidechainId: string | null;
        messageRole?: SessionMessageRole;
        sessionEventType?: 'ready';
    }, ReturnType<typeof setTimeout>>({
        maxAttempts: 3,
        resolveDelayMs: (attempt) => 1_000 * attempt,
        scheduleTimer: (callback, delayMs) => {
            const timer = setTimeout(callback, delayMs);
            timer.unref?.();
            return timer;
        },
        clearTimer: (timer) => clearTimeout(timer),
    });
    private userSocketDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private closed = false;
    private runtimeTerminationStarted = false;
    private snapshotSyncInFlight: Promise<boolean> | null = null;
    private readonly toolCallCanonicalNameByProviderAndId = new Map<string, { rawToolName: string; canonicalToolName: string }>();
    private readonly permissionToolCallRawInputByProviderAndId = new Map<string, unknown>();
    private readonly toolCallInputByProviderAndId = new Map<string, unknown>();
    private readonly receivedMessageIds = new LruSet(SESSION_CLIENT_RECEIVED_MESSAGE_ID_CACHE_MAX_ENTRIES);
    private lastObservedMessageSeq = 0;
    private lastObservedUserMessageSeq = 0;
    private readonly turnAssistantTextSnapshotStore = createTurnAssistantTextSnapshotStore({
        maxTextChars: configuration.readyNotificationAssistantTextMaxChars,
    });
    private hasConnectedOnce = false;
    /**
     * Increments on every session socket connect. Live-stream writers use this to detect
     * reconnects and resync receivers with a full snapshot before resuming delta emissions.
     */
    private sessionConnectionEpoch = 0;
    private sessionSyncPendingInputServerContract: SessionSyncPendingInputServerContractResult | null = null;
    private pendingInputReadinessAbortController: AbortController | null = null;
    private changesSyncInFlight: Promise<void> | null = null;
    private readonly sessionChangesCursorByAccountId = new Map<string, number>();
    private accountIdPromise: Promise<string> | null = null;
    private accountSettingsSyncBarrier: Promise<boolean> | null = null;
    private accountSettingsSyncBarrierState: 'applying' | 'failed' | null = null;
    private accountSettingsPendingEligibilityWakeWithheld = false;
    private accountSettingsEventRevision = 0;
    private accountSettingsHighestObservedVersion = -1;
    private userSocketSettingsConnectionEpoch = 0;
    private userSocketSettingsConvergedEpoch = -1;
    private userSocketSettingsConvergenceInFlight: Promise<void> | null = null;
    private startupMessageCatchUpStarted = false;
    private startupMessageCatchUpRetryIndex = 0;
    private startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null = null;
    private startupMessageCatchUpInitialAfterSeq = 0;
    private readonly startupMessageCatchUpExplicitAfterSeq: number | null;
    private readonly startedByDaemonProcess: boolean;
    private readonly transcriptStorage: 'persisted' | 'direct';
    private readonly transcriptRecoveryErrorStateByLocalId = new Map<string, { lastLoggedAt: number; suppressed: number }>();
    private messageCommitQueueTail: Promise<unknown> = Promise.resolve();
    private bestEffortMessageCommitQueueTail: Promise<unknown> = Promise.resolve();
    private requiredMessageCommitQueueTail: Promise<unknown> = Promise.resolve();
    private readonly messageCommitQueueDiagnostics = createSerializedWorkQueueDiagnostics({
        queueName: 'session-message-commit',
        slowAfterMs: 30_000,
        report: (report) => {
            logger.infoFile('[SOCKET] Serialized message commit queue diagnostic', {
                sessionId: this.sessionId,
                ...report,
            });
        },
    });
    private daemonTurnLifecycleNotifyTail: Promise<void> = Promise.resolve();
    private readonly pendingSessionTurnWrites = new Set<Promise<void>>();
    private readonly committedUserMessageSeqTracker = new CommittedUserMessageSeqTracker();
    private readonly sessionMutationOutbox: SessionMutationOutbox;
    private readonly runtimeActivitySnapshotPublisher: RuntimeActivitySnapshotSessionMutationPublisher;
    readonly sessionTurnLifecycle: SessionTurnLifecycleControllerWithActiveTurnWitness;
    private readonly sessionRuntimeControls: Partial<SessionRuntimeControls> = {};
    private readonly baseSessionRuntimeControls: Partial<SessionRuntimeControls> = {};
    private readonly sessionRuntimeControlRegistrations = new Set<Partial<SessionRuntimeControls>>();
    private providerOwnedUserMessageEchoClassifier: ProviderOwnedUserMessageEchoClassifier | null = null;
    readonly executionRuns = {
        start: async (request: unknown) =>
            await startExecutionRun({
                ...this.getExecutionRunServiceContext(),
                request,
            }),
        list: async (request: unknown) =>
            await listExecutionRuns({
                ...this.getExecutionRunServiceContext(),
                request,
            }),
        get: async (request: unknown) =>
            await getExecutionRun({
                ...this.getExecutionRunServiceContext(),
                request,
            }),
        send: async (request: unknown) =>
            await sendExecutionRunMessage({
                ...this.getExecutionRunServiceContext(),
                request,
            }),
        stop: async (request: unknown) =>
            await stopExecutionRun({
                ...this.getExecutionRunServiceContext(),
                request,
            }),
        action: async (request: unknown) =>
            await executeExecutionRunAction({
                ...this.getExecutionRunServiceContext(),
                request,
            }),
        wait: async (request: unknown) => {
            const rawTimeoutSeconds = readUnknownRecordProperty(request, 'timeoutSeconds');

            const rawPollIntervalMs = readUnknownRecordProperty(request, 'pollIntervalMs');
            const requestPollIntervalMs =
                typeof rawPollIntervalMs === 'number' && Number.isFinite(rawPollIntervalMs) && rawPollIntervalMs > 0
                    ? Math.min(60_000, rawPollIntervalMs)
                    : null;
            const envPollIntervalRaw = (process.env.HAPPIER_SESSION_RUN_WAIT_POLL_INTERVAL_MS ?? '').trim();
            const envPollIntervalParsed = envPollIntervalRaw ? Number.parseInt(envPollIntervalRaw, 10) : NaN;
            const envPollIntervalMs =
                Number.isFinite(envPollIntervalParsed) && envPollIntervalParsed > 0 ? Math.min(60_000, envPollIntervalParsed) : 1_000;

            return await waitForExecutionRun({
                ...this.getExecutionRunServiceContext(),
                runId: String(readUnknownRecordProperty(request, 'runId') ?? ''),
                timeoutMs: normalizeExecutionRunWaitTimeoutMs(rawTimeoutSeconds),
                pollIntervalMs: requestPollIntervalMs ?? envPollIntervalMs,
            });
        },
    } as const;

    /**
     * Returns the latest known agentState (may be stale if socket is disconnected).
     * Useful for rebuilding in-memory caches (e.g. permission allowlists) without server changes.
     */
    getAgentStateSnapshot(): AgentState | null {
        return this.agentState;
    }

    beginTurnAssistantTextSnapshot(params?: {
        turnToken?: string;
        startSeqExclusive?: number | null;
    }): string {
        return this.turnAssistantTextSnapshotStore.beginTurn(params);
    }

    getTurnAssistantTextSnapshot(params: {
        turnToken?: string | null;
        startSeqExclusive?: number | null;
    }): TurnAssistantTextSnapshot | null {
        return this.turnAssistantTextSnapshotStore.getForTurn(params);
    }

    private getExecutionRunServiceContext() {
        return {
            token: this.token,
            sessionId: this.sessionId,
            mode: this.sessionEncryptionMode,
            ctx: {
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
            },
        } as const;
    }

    private logSendWhileDisconnected(context: string, details?: Record<string, unknown>): void {
        if (this.socket.connected || this.disconnectedSendLogged) return;
        this.disconnectedSendLogged = true;
        logger.debug(
            `[API] Socket not connected; queueing ${context} until supervised reconnect.`,
            details
        );
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
                    settle(resolve);
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

    private observeTurnAssistantTextFromSessionContent(
        content: unknown,
        params: Omit<TurnAssistantTextCandidate, 'text' | 'provider' | 'sidechainId'> & {
            provider?: string | null;
            sidechainId?: string | null;
        },
    ): void {
        const extracted = extractTurnAssistantTextFromSessionContent(content);
        if (!extracted) return;
        this.turnAssistantTextSnapshotStore.observe({
            ...params,
            text: extracted.text,
            provider: params.provider ?? extracted.provider,
            sidechainId: params.sidechainId ?? extracted.sidechainId,
        });
    }

        constructor(
            token: string,
            session: Session,
            runtimeActivity?: SessionRuntimeActivityClientConfig,
        ) {
	        super()
	        this.token = token;
	        this.sessionId = session.id;
	        this.metadata = session.metadata;
	        this.metadataVersion = session.metadataVersion;
            this.sessionSocketMachineId = resolveSessionSocketMachineIdForBootstrap(session.metadata);
            this.agentState = session.agentState;
	        this.agentStateVersion = session.agentStateVersion;
            this.pendingQueueState = readKnownPendingQueueState(session) ?? UNKNOWN_PENDING_QUEUE_STATE;
            const initialLatestTurnStatus = readLatestTurnStatusSnapshot(
                (session as { latestTurnStatus?: unknown }).latestTurnStatus,
            );
            if (initialLatestTurnStatus !== undefined) {
                this.applyLatestTurnStatusProjection(
                    initialLatestTurnStatus,
                    (session as { latestTurnStatusObservedAt?: unknown }).latestTurnStatusObservedAt,
                );
            }
            this.runtimeActivityProjection = readRuntimeActivityProjectionForPendingDrain(session);
            this.lastObservedMessageSeq =
                typeof session.seq === 'number' && Number.isFinite(session.seq) && session.seq >= 0
                    ? Math.trunc(session.seq)
                    : 0;
            this.startupMessageCatchUpExplicitAfterSeq =
                typeof session.initialTranscriptAfterSeq === 'number'
                && Number.isFinite(session.initialTranscriptAfterSeq)
                && session.initialTranscriptAfterSeq >= 0
                    ? Math.trunc(session.initialTranscriptAfterSeq)
                    : null;
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
        this.startedByDaemonProcess = (() => {
            const idx = process.argv.indexOf('--started-by');
            if (idx < 0) return false;
            const value = process.argv[idx + 1];
            return value === 'daemon';
        })();

        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            encryptionMode: this.sessionEncryptionMode,
            logger: (msg, data) => logger.debug(msg, data),
            onRegistrationError: (error) => {
                const probe = classifySessionTransportErrorToProbeResult(error);
                if (probe) {
                    this.sessionConnectionSupervisor?.reportProbeResult?.(probe);
                }
            },
        });
        const parentProvider = resolveSessionCatalogAgentId(this.metadata);

        this.rebuildSessionRuntimeControls();
        this.rpcLifecycleRegistrations.push(registerSessionHandlers(this.rpcHandlerManager, this.metadata?.path, {
            getSessionMetadata: () => this.getMetadataSnapshot(),
            updateSessionMetadata: (handler) => this.updateMetadata(handler),
            updateSessionMetadataWithResult: (handler) => this.updateMetadataWithResult(handler),
            enqueueSessionUserMessage: (request) => this.enqueueSessionUserMessage(request),
            revalidateExplicitUserRequest: async ({ localId }) => {
                const requestId = readPendingLocalId(localId);
                if (requestId) {
                    return await this.revalidateUsageLimitRecoveryForExplicitUserPrompt(requestId);
                }
                return { status: 'ready' };
            },
            sessionRuntimeControls: this.sessionRuntimeControls,
            // QAE-1: a user "Stop waiting" handled session-side (provider runtime
            // control or metadata fallback) must also cancel the daemon's durable
            // recovery wait state, or it resumes the session involuntarily later.
            notifyUsageLimitWaitResumeCancelled: async (request) =>
                await notifyDaemonConnectedServiceUsageLimitWaitResumeCancel(request),
        }));

        const transcriptWriter = createExecutionRunTranscriptWriter({
            parentProvider,
            randomId: randomUUID,
            sendUserTextMessage: (text, options) => this.sendUserTextMessage(text, options),
            sendAgentMessage: (provider, body, options) => this.sendAgentMessage(provider, body, options),
            sendUserTextMessageCommitted: async (text, options) => {
                await this.sendUserTextMessageCommitted(text, options);
            },
            sendAgentMessageCommitted: async (provider, body, options) => {
                await this.sendAgentMessageCommitted(provider, body, options);
            },
        });

        const hasBudgetCaps =
            configuration.executionRunsMaxConcurrentPerSession !== null
            || configuration.ephemeralTasksMaxConcurrentPerSession !== null
            || typeof configuration.executionBudgetMaxConcurrentTotalPerSession === 'number'
            || (configuration.executionBudgetMaxConcurrentByClass && Object.keys(configuration.executionBudgetMaxConcurrentByClass).length > 0);
        const executionBudgetRegistry = hasBudgetCaps
            ? new ExecutionBudgetRegistry({
                maxConcurrentExecutionRuns: configuration.executionRunsMaxConcurrentPerSession,
                maxConcurrentEphemeralTasks: configuration.ephemeralTasksMaxConcurrentPerSession,
                ...(typeof configuration.executionBudgetMaxConcurrentTotalPerSession === 'number'
                    ? { maxConcurrentTotal: configuration.executionBudgetMaxConcurrentTotalPerSession }
                    : {}),
                ...(configuration.executionBudgetMaxConcurrentByClass
                    && Object.keys(configuration.executionBudgetMaxConcurrentByClass).length > 0
                    ? { maxConcurrentByClass: configuration.executionBudgetMaxConcurrentByClass }
                    : {}),
            })
            : undefined;

        // Runtime-activity authority must exist before producer/RPC composition registers its
        // immutable expected owners. Registering producers first silently returned null and left
        // an authorized v2 session with no execution-run owner.
        this.userSocket = createUserScopedSocket({ token: this.token });
        this.sessionMutationOutbox = createSessionMutationOutbox({
            token: this.token,
            sessionId: this.sessionId,
            getSocket: () => this.socket as any,
            requestReconnect: (reason) => this.kickSessionSocketReconnectForDurableMutation(reason),
        });
        this.runtimeActivitySnapshotPublisher = createRuntimeActivitySnapshotSessionMutationPublisher({
            sessionId: this.sessionId,
            journal: this.sessionMutationOutbox,
        });
        // Always register execution-run RPC methods so callers never see "RPC method not available".
        // Feature gating is enforced inside the handler implementations.
        const streamedTranscriptSession = {
            enqueueAgentMessageCommitted: (provider: ACPProvider, body: ACPMessageData, opts: { localId: string; meta?: Record<string, unknown>; provenance: SessionTranscriptObservationProvenanceV1 }) =>
                this.enqueueAgentMessageCommitted(provider, body, opts),
            sendAgentMessageCommitted: (provider: ACPProvider, body: ACPMessageData, opts: { localId: string; meta?: Record<string, unknown> }) =>
                this.sendAgentMessageCommitted(provider, body, opts),
            sendAgentMessageEphemeral: (provider: ACPProvider, body: ACPMessageData, opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown>; tick?: number }) =>
                this.sendAgentMessageEphemeral(provider, body, opts),
            sendAgentMessageEphemeralDelta: (
                provider: ACPProvider,
                body: ACPMessageData,
                opts: { localId: string; tick: number; baseLength: number; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> },
            ) => this.sendAgentMessageEphemeralDelta(provider, body, opts),
            getEphemeralStreamConnectionEpoch: () => this.getEphemeralStreamConnectionEpoch(),
        };

        registerExecutionRunHandlers(this.rpcHandlerManager, {
            sessionId: this.sessionId,
            cwd: this.metadata?.path ?? process.cwd(),
            serverUrl: configuration.serverUrl,
            parentProvider,
            createBackend: ({ runId, backendId, backendTarget, permissionMode, modelId, sessionConfigOptionOverrides, accountSettings, start, connectedServicesEnv, connectedServicesCleanup }) =>
                createExecutionRunBackend({
                    cwd: this.metadata?.path ?? process.cwd(),
                    ...(runId ? { runId } : {}),
                    backendId,
                    backendTarget,
                    permissionMode,
                    modelId,
                    ...(sessionConfigOptionOverrides ? { sessionConfigOptionOverrides } : {}),
                    accountSettings,
                    start,
                    ...(connectedServicesEnv ? { connectedServicesEnv } : {}),
                    ...(connectedServicesCleanup ? { connectedServicesCleanup } : {}),
                }),
            sendAcp: (provider, body, opts) => this.sendAgentMessage(provider as any, body as any, opts),
            streamedTranscriptSession,
            transcriptWriter,
            runtimeActivityContributionHandle: runtimeActivity?.executionRunContributionHandle ?? null,
            budgetRegistry: executionBudgetRegistry,
            onExecutionRunPublicStateUpdated: (run) => {
                try {
                    if (!this.socket.connected) {
                        return;
                    }
                    this.socket.emit('execution-run-updated', { sid: this.sessionId, run });
                } catch {
                    // best effort
                }
            },
            policy: {
                maxConcurrentRuns: configuration.executionRunsMaxConcurrentPerSession,
                boundedTimeoutMs: configuration.executionRunsBoundedTimeoutMs,
                reviewBoundedTimeoutMs: configuration.executionRunsReviewBoundedTimeoutMs,
                maxTurns: configuration.executionRunsMaxTurns,
                maxDepth: configuration.executionRunsMaxDepth,
            },
            resolveAccountSettings: async () => {
                const activeSettings = getActiveAccountSettingsSnapshot()?.settings ?? null;
                if (activeSettings) return activeSettings;
                const credentials = await readCredentials();
                if (!credentials) return null;
                const context = await bootstrapAccountSettingsContext({ credentials, mode: 'fast' });
                return context.settings ?? null;
            },
        });

        registerEphemeralTaskHandlers(this.rpcHandlerManager, {
          workingDirectory: this.metadata?.path ?? process.cwd(),
          createBackend: ({ backendId, permissionMode, backendTarget }) =>
            createExecutionRunBackend({
              cwd: this.metadata?.path ?? process.cwd(),
              backendId,
              permissionMode,
              ...(backendTarget ? { backendTarget } : {}),
            }),
          budgetRegistry: executionBudgetRegistry,
        });

        //
        // Create socket
        //

        this.sessionTurnLifecycle = createSessionTurnLifecycle({
            sessionId: this.sessionId,
            enqueueSessionTurn: createSessionTurnMutationWriter(this.sessionMutationOutbox).enqueueSessionTurn,
            onTurnLifecycleEvent: (event, terminalStatus, turnId) => {
                this.observeTurnLifecycleForPendingDrain(event, terminalStatus);
                void this.notifyDaemonConnectedServiceTurnLifecycle(event, terminalStatus, turnId);
            },
        });

        //
        // Handlers
        //
        this.userSocket.on('update', (data: Update) => this.handleLiveUpdate(data, {
            source: 'user-scoped',
            socket: this.userSocket,
        }));
        this.userSocket.on('connect', () => {
            this.userSocketSettingsConnectionEpoch += 1;
            this.userSocketSettingsConvergenceInFlight = null;
        });
        // Broadcast-safe session events are optional hints; ignore unless explicitly used.
        this.userSocket.on('session', () => {});

        let currentTransportSocket: typeof this.socket | null = null;
        let currentTransportMachineId: string | undefined;
        const serverContractController = createSessionSyncPendingInputServerContractController({
            serverUrl: resolveServerHttpBaseUrl(),
            token: this.token,
        });
        const invalidateServerContract = async () => {
            const invalidatedContract = serverContractController.invalidate({
                sessionConnectionEpoch: this.sessionConnectionEpoch,
                socket: currentTransportSocket ?? undefined,
            });
            if (!invalidatedContract) return;
            this.sessionSyncPendingInputServerContract = invalidatedContract;
            await this.sessionMutationOutbox.setSessionSyncPendingInputServerContract(invalidatedContract);
        };
        this.sessionConnectionSupervisor = createManagedConnectionSupervisor({
            ...DEFAULT_MANAGED_CONNECTION_POLICY,
            createTransport: () => {
                const machineId =
                    this.sessionSocketMachineId
                    ?? resolveSessionSocketMachineIdForBootstrap(this.metadata);
                if (machineId) {
                    this.sessionSocketMachineId = machineId;
                }
                const { socket, transport } = createSessionSocketTransport({
                    token: this.token,
                    sessionId: this.sessionId,
                    machineId,
                });
                this.socket = socket;
                currentTransportSocket = socket;
                currentTransportMachineId = machineId;
                this.installSessionSocketEventHandlers(socket);
                return transport;
            },
            classifyTransportErrorToProbeResult: classifySessionTransportErrorToProbeResult,
            probeReadiness: createLoopbackReadinessProbe({
                serverUrl: resolveServerHttpBaseUrl(),
                token: this.token,
            }),
            onStateChange: (state) => {
                this.currentConnectionState = state;
                this.emit(SESSION_CONNECTION_STATE_EVENT, state);
            },
            onConnected: async () => {
                logger.debug('Socket connected successfully');
                this.disconnectedSendLogged = false;
                connectionState.recover();
                this.rpcHandlerManager.onSocketConnect(this.socket);

                const isReconnect = this.hasConnectedOnce;
                this.hasConnectedOnce = true;
                this.sessionConnectionEpoch += 1;
                const serverContract = await serverContractController.resolve({
                    sessionConnectionEpoch: this.sessionConnectionEpoch,
                    socket: this.socket,
                    machineId: currentTransportMachineId,
                });
                if (
                    serverContract.sessionConnectionEpoch !== this.sessionConnectionEpoch
                    || serverContract.socket !== this.socket
                    || this.socket !== currentTransportSocket
                    || this.socket.connected !== true
                ) {
                    return;
                }
                this.pendingInputReadinessAbortController?.abort();
                const pendingInputReadinessAbortController = new AbortController();
                this.pendingInputReadinessAbortController = pendingInputReadinessAbortController;
                const isResolvedContractCurrent = () => (
                    serverContract.sessionConnectionEpoch === this.sessionConnectionEpoch
                    && serverContract.socket === this.socket
                    && this.socket === currentTransportSocket
                    && this.socket.connected === true
                    && !this.closed
                    && !this.runtimeTerminationStarted
                );
                const clearPendingInputReadiness = () => {
                    if (this.pendingInputReadinessAbortController === pendingInputReadinessAbortController) {
                        this.pendingInputReadinessAbortController = null;
                    }
                };
                await this.sessionMutationOutbox.setSessionSyncPendingInputServerContract(serverContract);
                if (serverContract.mode === 'auth_failed') {
                    this.sessionSyncPendingInputServerContract = serverContract;
                    clearPendingInputReadiness();
                    this.sessionConnectionSupervisor?.reportProbeResult?.({
                        status: 'auth_failed',
                        statusCode: 401,
                        errorMessage: 'Authentication failed while resolving session compatibility',
                    });
                    return;
                }

                const requiresRuntimeActivityPublisherReadiness = (
                    supportsRuntimeActivityV2(serverContract)
                    && supportsPendingInputV1(serverContract)
                );
                if (!requiresRuntimeActivityPublisherReadiness) {
                    this.sessionSyncPendingInputServerContract = serverContract;
                    clearPendingInputReadiness();
                }

                if (this.shouldKeepUserSocketConnected()) {
                    this.kickUserSocketConnect();
                }

                if (isReconnect) {
                    this.reassertSessionPresenceAfterReconnect();
                }
                if (supportsRuntimeActivityV2(serverContract)) {
                    await this.runtimeActivitySnapshotPublisher[RUNTIME_ACTIVITY_DESIRED_REOFFER_REQUEST]().catch((error) => {
                        logger.debug('[API] Failed to reoffer Runtime Activity snapshot on reconnect', {
                            error: serializeAxiosErrorForLog(error),
                        });
                    });
                }

                await this.sessionMutationOutbox.flush('connect').catch((error) => {
                    logger.debug('[API] Failed to flush durable session mutations on reconnect', {
                        error: serializeAxiosErrorForLog(error),
                    });
                });
                if (requiresRuntimeActivityPublisherReadiness) {
                    while (
                        isResolvedContractCurrent()
                        && this.pendingInputReadinessAbortController === pendingInputReadinessAbortController
                    ) {
                        const tail = this.sessionMutationOutbox.readRuntimeActivitySnapshotTail();
                        if (tail.custody === null && tail.settlement !== null) {
                            this.sessionSyncPendingInputServerContract = serverContract;
                            clearPendingInputReadiness();
                            break;
                        }
                        const changed = await this.sessionMutationOutbox.waitForRuntimeActivitySnapshotTailChange(
                            tail.sequence,
                            pendingInputReadinessAbortController.signal,
                        );
                        if (!changed) return;
                    }
                    if (!isResolvedContractCurrent()) return;
                }

                await this.syncChangesOnConnect({ reason: isReconnect ? 'reconnect' : 'connect' }).catch((error) => {
                    logger.debug('[API] Session changes sync on connect failed (non-fatal)', {
                        error: serializeAxiosErrorForLog(error),
                    });
                });
                if (shouldSyncSessionSnapshotOnConnect({ metadataVersion: this.metadataVersion, agentStateVersion: this.agentStateVersion })) {
                    void this.syncSessionSnapshotFromServer({ reason: 'connect' });
                }

                await this.flushQueuedSessionMessagesOnReconnect().catch((error) => {
                    logger.debug('[API] Failed to replay queued session messages on reconnect', {
                        error: serializeAxiosErrorForLog(error),
                    });
                });
            },
            onDisconnected: async ({ event }) => {
                logger.debug('[API] Socket disconnected:', event.reason ?? 'unknown');
                this.clearReconnectPresenceReassertTimer();
                this.pendingInputReadinessAbortController?.abort();
                this.pendingInputReadinessAbortController = null;
                await invalidateServerContract();
                if (this.socket === currentTransportSocket) {
                    this.rpcHandlerManager.onSocketDisconnect();
                    try {
                        this.userSocket.disconnect();
                    } catch {
                        // ignore
                    }
                }
            },
            onAuthFailed: async () => {
                this.clearReconnectPresenceReassertTimer();
                this.pendingInputReadinessAbortController?.abort();
                this.pendingInputReadinessAbortController = null;
                await invalidateServerContract();
                if (this.socket === currentTransportSocket) {
                    this.rpcHandlerManager.onSocketDisconnect();
                    try {
                        this.userSocket.disconnect();
                    } catch {
                        // ignore
                    }
                }
            },
        });

        void this.sessionConnectionSupervisor.start();
        this.publishSessionGoalControlCapabilities();
    }

    private rebuildSessionRuntimeControls(): void {
        clearSessionRuntimeControls(this.sessionRuntimeControls);
        copyCallableSessionRuntimeControls(this.sessionRuntimeControls, this.baseSessionRuntimeControls);
        for (const registration of this.sessionRuntimeControlRegistrations) {
            copyCallableSessionRuntimeControls(this.sessionRuntimeControls, registration);
        }
        this.sessionRuntimeControls.wakePendingMaterialization = () => this.wakePendingMaterialization();
        this.sessionRuntimeControls.isPendingMaterializationAvailable = () => (
            !this.closed && !this.runtimeTerminationStarted
        );
    }

    private publishSessionGoalControlCapabilities(): void {
        const sessionGoalSetSupported = typeof this.sessionRuntimeControls.setGoal === 'function';
        const sessionGoalClearSupported = typeof this.sessionRuntimeControls.clearGoal === 'function';
        const currentCapabilities = this.agentState?.capabilities;
        if (
            currentCapabilities?.sessionGoalSetSupported === sessionGoalSetSupported
            && currentCapabilities?.sessionGoalClearSupported === sessionGoalClearSupported
        ) {
            return;
        }
        // Missing fields already mean unsupported to new clients. Avoid an extra write for every
        // older session, while still clearing a stale positive snapshot left by a previous runner.
        if (
            !sessionGoalSetSupported
            && !sessionGoalClearSupported
            && currentCapabilities?.sessionGoalSetSupported === undefined
            && currentCapabilities?.sessionGoalClearSupported === undefined
        ) {
            return;
        }
        updateAgentStateBestEffort(
            this,
            (currentState) => ({
                ...currentState,
                capabilities: {
                    ...(currentState.capabilities && typeof currentState.capabilities === 'object'
                        ? currentState.capabilities
                        : {}),
                    sessionGoalSetSupported,
                    sessionGoalClearSupported,
                },
            }),
            '[session]',
            'goal_runtime_control_capabilities',
        );
    }

    wakePendingMaterialization(): void {
        if (this.closed) return;
        void this.reconcilePendingQueueState({ force: true })
            .catch((error) => {
                logger.debug('[pendingQueue] explicit wake reconciliation failed; publishing the wake with retained state', {
                    sessionId: this.sessionId,
                    error: serializeAxiosErrorForLog(error),
                });
            })
            .finally(() => {
                if (this.closed) return;
                this.publishPendingEligibilityWake();
            });
    }


    setSessionRuntimeControls(controls: SessionRuntimeControls | null): void {
        clearSessionRuntimeControls(this.baseSessionRuntimeControls);
        copyCallableSessionRuntimeControls(this.baseSessionRuntimeControls, controls);
        this.rebuildSessionRuntimeControls();
        this.publishSessionGoalControlCapabilities();
    }

    registerSessionRuntimeControls(controls: Partial<SessionRuntimeControls> | null): () => void {
        const registration: Partial<SessionRuntimeControls> = {};
        copyCallableSessionRuntimeControls(registration, controls);
        if (Object.keys(registration).length === 0) {
            return () => {};
        }
        this.sessionRuntimeControlRegistrations.add(registration);
        this.rebuildSessionRuntimeControls();
        this.publishSessionGoalControlCapabilities();
        let disposed = false;
        return () => {
            if (disposed) return;
            disposed = true;
            this.sessionRuntimeControlRegistrations.delete(registration);
            this.rebuildSessionRuntimeControls();
            this.publishSessionGoalControlCapabilities();
        };
    }

    setProviderOwnedUserMessageEchoClassifier(classifier: ProviderOwnedUserMessageEchoClassifier | null): void {
        this.providerOwnedUserMessageEchoClassifier = classifier;
    }

    private debugTranscriptRecoveryFetchError(localId: string, error: unknown): void {
        const now = Date.now();
        const throttleMs = configuration.transcriptRecoveryErrorLogThrottleMs;
        const state = this.transcriptRecoveryErrorStateByLocalId.get(localId) ?? { lastLoggedAt: 0, suppressed: 0 };

        if (state.lastLoggedAt === 0 || now - state.lastLoggedAt >= throttleMs) {
            const suppressed = state.suppressed;
            state.lastLoggedAt = now;
            state.suppressed = 0;
            this.transcriptRecoveryErrorStateByLocalId.set(localId, state);
            logger.debug('[API] Failed to fetch transcript messages for pending-queue recovery', {
                localId,
                suppressedSinceLastLog: suppressed,
                error: serializeAxiosErrorForLog(error),
            });
            return;
        }

        state.suppressed += 1;
        this.transcriptRecoveryErrorStateByLocalId.set(localId, state);
    }

    private applyPendingQueueState(state: KnownPendingQueueState, opts?: { emit?: boolean }): boolean {
        const applied = applyKnownPendingQueueState(this.pendingQueueState, state);
        this.pendingQueueState = applied.state;
        if (applied.changed) {
            this.pendingWakeSeq += 1;
            if (!this.closed) {
                this.emitPendingEligibilityUpdated();
            }
            if (opts?.emit === true && !this.closed) {
                this.emit('metadata-updated');
            }
        }
        return applied.changed;
    }

    private normalizeAcceptedCanonicalPendingDeliverySeq(seq: unknown): number | null {
        return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
    }

    private clearCanonicalPendingDeliveryLocalState(
        localId: string,
    ): boolean {
        let didClear = false;
        if (this.canonicalPendingDeliveryByLocalId.delete(localId)) didClear = true;
        if (this.serverBlockedCanonicalPendingDeliveryLocalIds.delete(localId)) didClear = true;
        if (this.sourceCutoverDeferredPendingLocalIds.delete(localId)) didClear = true;
        if (this.providerInputTerminalOutcomeByLocalId.delete(localId)) didClear = true;
        if (this.providerInputUncertainLocalIds.delete(localId)) didClear = true;
        const hadMaterializedLocalId = this.hasMaterializedLocalId(localId);
        if (didClear || hadMaterializedLocalId) {
            this.deleteMaterializedLocalId(localId);
        }
        return didClear || hadMaterializedLocalId;
    }

    private clearCanonicalPendingDeliveryLocalStates(localIds: readonly string[]): boolean {
        let didClear = false;
        for (const localId of this.normalizeProviderAcceptedUserMessageLocalIds(localIds)) {
            didClear = this.clearCanonicalPendingDeliveryLocalState(localId) || didClear;
        }
        return didClear;
    }

    private async retireStaleCanonicalPendingDeliveryAfterTerminalMiss(
        localId: string,
        operation: 'accepted' | 'block',
        error: unknown,
    ): Promise<boolean> {
        if (!isTerminalPendingDeliveryNotFound(operation, error)) return false;

        logger.debug('[pendingQueue] retained terminally absent canonical pending delivery without exact committed proof', {
            sessionId: this.sessionId,
            localId,
            operation,
        });
        if (operation === 'accepted' && this.canonicalPendingDeliveryByLocalId.has(localId)) {
            this.acceptedProviderInputLocalIds.add(localId);
        }
        return true;
    }

    private isAcceptedCanonicalPendingDeliveryOperationCurrent(
        authority: AcceptedCanonicalPendingDeliveryOperationAuthority,
    ): boolean {
        return !this.closed
            && !this.runtimeTerminationStarted
            && !authority.abortSignal.aborted
            && authority.producerGeneration === this.providerInputOutcomeProducerGeneration
            && authority.sessionConnectionEpoch === this.sessionConnectionEpoch
            && authority.socket === this.socket
            && authority.socket.connected === true;
    }

    private captureAcceptedCanonicalPendingDeliveryOperationAuthority(
        producerGeneration = this.providerInputOutcomeProducerGeneration,
    ): AcceptedCanonicalPendingDeliveryOperationAuthority | null {
        const authority: AcceptedCanonicalPendingDeliveryOperationAuthority = {
            producerGeneration,
            sessionConnectionEpoch: this.sessionConnectionEpoch,
            socket: this.socket,
            abortSignal: this.acceptedCanonicalPendingDeliveryOperationAbortController.signal,
        };
        return this.isAcceptedCanonicalPendingDeliveryOperationCurrent(authority) ? authority : null;
    }

    private async resolveAcceptedCanonicalPendingDelivery(
        localId: string,
        authority: AcceptedCanonicalPendingDeliveryOperationAuthority,
    ): Promise<void> {
        if (this.acceptedCanonicalPendingDeliveryResolutionLocalIdsInFlight.has(localId)) return;
        this.acceptedCanonicalPendingDeliveryResolutionLocalIdsInFlight.add(localId);
        try {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                if (
                    !this.isAcceptedCanonicalPendingDeliveryOperationCurrent(authority)
                    || !this.canonicalPendingDeliveryByLocalId.has(localId)
                    || this.providerInputTerminalOutcomeByLocalId.get(localId) !== 'accepted'
                ) {
                    return;
                }
            try {
                const result = await resolveAcceptedPendingQueueV2Delivery({
                    socket: authority.socket,
                    sessionId: this.sessionId,
                    localId,
                });
                if (!this.isAcceptedCanonicalPendingDeliveryOperationCurrent(authority)) return;
                if (!this.canonicalPendingDeliveryByLocalId.has(localId)) continue;
                if (result.pendingQueueState) {
                    this.applyPendingQueueState(result.pendingQueueState, { emit: true });
                } else if (!this.closed) {
                    this.pendingWakeSeq += 1;
                    this.emit('metadata-updated');
                    this.emitPendingEligibilityUpdated();
                }
                const hasExactCommittedReplay = result.didResolve === false
                    && result.message?.localId === localId
                    && typeof result.message.seq === 'number';
                if (result.didResolve !== true && !hasExactCommittedReplay) {
                    // A live no-op cannot prove that this exact accepted row committed. Keep its
                    // claim visible for reconciliation; unrelated wakes must not become retry authority.
                    return;
                }
                // This mutation targets one exact localId. A successful server settlement is the
                // authoritative sequence result; the provider callback sequence was only a hint
                // available before the durable mutation completed.
                const resolvedSeq = typeof result.message?.seq === 'number' ? result.message.seq : null;
                this.acceptedProviderInputLocalIds.add(localId);
                this.clearCanonicalPendingDeliveryLocalState(localId);
                this.recordCommittedUserMessageSeq(localId, resolvedSeq);
                return;
            } catch (error) {
                logger.debug('[pendingQueue] accepted provider delivery resolution failed', {
                    sessionId: this.sessionId,
                    localId,
                    error: serializeAcceptedPendingSettlementErrorForLog(error),
                });
                if (!this.isAcceptedCanonicalPendingDeliveryOperationCurrent(authority)) return;
                if (await this.retireStaleCanonicalPendingDeliveryAfterTerminalMiss(localId, 'accepted', error)) return;
                if (this.canonicalPendingDeliveryByLocalId.has(localId)) {
                    const retryDirective = readAcceptedPendingQueueV2DeliveryRetryDirective(error);
                    const isResponseLoss = Boolean(
                        error
                        && typeof error === 'object'
                        && 'code' in error
                        && (error as { code?: unknown }).code === 'socket_ack_timeout'
                        && 'retryable' in error
                        && (error as { retryable?: unknown }).retryable === true,
                    );
                    if ((!retryDirective && !isResponseLoss) || attempt > 0) return;
                    const retryAfterMs = retryDirective
                        ? Math.min(60_000, Math.max(250, retryDirective.retryAfterMs))
                        : 1_000;
                    await delayUnrefAbortable(retryAfterMs, authority.abortSignal);
                } else {
                    return;
                }
            }
        }
        } finally {
            this.acceptedCanonicalPendingDeliveryResolutionLocalIdsInFlight.delete(localId);
        }
    }

    private trackAcceptedCanonicalPendingDeliveryResolution(resolution: Promise<void>): void {
        const tracked = resolution.catch((error) => {
            logger.debug('[pendingQueue] accepted provider delivery resolution crashed', {
                sessionId: this.sessionId,
                error: serializeAxiosErrorForLog(error),
            });
        });
        this.acceptedCanonicalPendingDeliveryResolutionWrites.add(tracked);
        void tracked.finally(() => {
            this.acceptedCanonicalPendingDeliveryResolutionWrites.delete(tracked);
        });
    }

    private async drainAcceptedCanonicalPendingDeliveryResolutionsBeforeClose(): Promise<void> {
        while (this.acceptedCanonicalPendingDeliveryResolutionWrites.size > 0) {
            await Promise.all([...this.acceptedCanonicalPendingDeliveryResolutionWrites]);
        }
    }

    async blockPendingMessageDelivery(params: Readonly<{
        localIds: readonly string[] | null | undefined;
        reason: PendingQueueDeliveryBlockedReason;
    }>): Promise<boolean> {
        return await this.blockCanonicalPendingDeliveries(params.localIds, params.reason);
    }

    private async blockCanonicalPendingDeliveries(
        localIds: readonly string[] | null | undefined,
        reason: PendingQueueDeliveryBlockedReason,
    ): Promise<boolean> {
        if (this.closed) return false;
        const pendingLocalIds = this.normalizeProviderAcceptedUserMessageLocalIds(localIds)
            .filter((localId) => this.canonicalPendingDeliveryByLocalId.has(localId));
        if (pendingLocalIds.length === 0) return false;

        let didBlock = false;
        for (const localId of pendingLocalIds) {
            didBlock = await this.blockPendingQueueDeliveryLocalId(localId, reason, {
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

        const supervisor = this.sessionConnectionSupervisor;
        try {
            const request = () => blockPendingQueueV2Delivery({
                token: this.token,
                sessionId: this.sessionId,
                localId,
                reason,
            });
            const result = supervisor
                ? await runSupervisedRequest({
                    supervisor,
                    purpose: 'durable_write',
                    requireAuth: true,
                    requireOnline: false,
                    request,
                })
                : await request();

            if (wasCanonical && this.canonicalPendingDeliveryByLocalId.has(localId)) {
                if (
                    reason !== 'ambiguous_terminal_delivery'
                    && reason !== 'delivery_outcome_uncertain'
                    && !isReversibleProviderInputBlockReason(reason)
                ) {
                    this.clearCanonicalPendingDeliveryLocalState(localId);
                } else {
                    this.serverBlockedCanonicalPendingDeliveryLocalIds.add(localId);
                }
            }
            if (result.pendingQueueState) {
                this.applyPendingQueueState(result.pendingQueueState, { emit: true });
            } else if (!this.closed) {
                this.pendingWakeSeq += 1;
                this.emit('metadata-updated');
                this.emitPendingEligibilityUpdated();
            }
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
            logger.debug('[pendingQueue] provider delivery block failed', {
                sessionId: this.sessionId,
                localId,
                reason,
                    error: serializeAxiosErrorForLog(error),
                });
            if (await this.retireStaleCanonicalPendingDeliveryAfterTerminalMiss(localId, 'block', error)) {
                return false;
            }
            return opts.canonicalOnly && wasCanonical;
        }
    }

    private async reconcileCanonicalPendingDeliveriesBeforeMaterialization(): Promise<boolean> {
        const blockingLocalIds = [...this.canonicalPendingDeliveryByLocalId.keys()]
            .filter((localId) => (
                this.providerInputTerminalOutcomeByLocalId.get(localId) === 'accepted'
                || !this.serverBlockedCanonicalPendingDeliveryLocalIds.has(localId)
            ));
        if (blockingLocalIds.length === 0) return true;

        try {
            const statuses = await listPendingQueueV2DeliveryStatusesFromServer({
                token: this.token,
                sessionId: this.sessionId,
            });
            const statusByLocalId = new Map(statuses.map((entry) => [entry.localId, entry.status]));
            for (const localId of blockingLocalIds) {
                const status = statusByLocalId.get(localId);
                if (status !== undefined && status !== 'discarded') continue;
                if (!this.canonicalPendingDeliveryByLocalId.has(localId)) continue;
                logger.debug('[pendingQueue] exact terminal server truth retired local provider custody', {
                    sessionId: this.sessionId,
                    localId,
                    serverStatus: status ?? 'absent',
                });
                // Unlike successful settlement or an exact committed replay, authoritative
                // absence/discard proves there is no remaining Pending row whose acceptance
                // this session client should expose.
                this.acceptedProviderInputLocalIds.delete(localId);
                this.clearCanonicalPendingDeliveryLocalState(localId);
            }
        } catch (error) {
            logger.debug('[pendingQueue] exact local provider custody reconciliation failed closed', {
                sessionId: this.sessionId,
                localIds: blockingLocalIds,
                error: serializeAxiosErrorForLog(error),
            });
        }

        return !this.hasMaterializationBlockingCanonicalPendingDelivery();
    }

    private hasMaterializationBlockingCanonicalPendingDelivery(): boolean {
        for (const localId of this.canonicalPendingDeliveryByLocalId.keys()) {
            if (
                this.providerInputTerminalOutcomeByLocalId.get(localId) === 'accepted'
                || !this.serverBlockedCanonicalPendingDeliveryLocalIds.has(localId)
            ) {
                return true;
            }
        }
        return false;
    }

    async reconcilePendingQueueState(opts?: { force?: boolean }): Promise<boolean> {
        if (this.closed) return false;
        // Keep the public queue reconciliation hook authoritative for both server projection and
        // exact local provider custody. Generic input consumers call this hook when their cheap
        // eligibility preflight is blocked; without this step, a server-resolved delivery can
        // permanently hide a later queued row before the safe materialization owner gets a chance
        // to run its own identical reconciliation.
        await this.reconcileCanonicalPendingDeliveriesBeforeMaterialization();
        if (!opts?.force && this.pendingQueueState.known && this.pendingQueueState.pendingCount > 0) {
            return false;
        }

        const now = Date.now();
        if (
            !opts?.force
            && this.lastPendingQueueStateReconcileAt > 0
            && now - this.lastPendingQueueStateReconcileAt < configuration.pendingQueueStateReconcileThrottleMs
        ) {
            return false;
        }

        if (this.pendingQueueStateReconcileInFlight) {
            return await this.pendingQueueStateReconcileInFlight;
        }

        const run = async (): Promise<boolean> => {
            this.lastPendingQueueStateReconcileAt = Date.now();
            const before = this.pendingQueueState;
            await this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
            return !arePendingQueueStatesEqual(before, this.pendingQueueState);
        };

        const reconcile = run().finally(() => {
            if (this.pendingQueueStateReconcileInFlight === reconcile) {
                this.pendingQueueStateReconcileInFlight = null;
            }
        });
        this.pendingQueueStateReconcileInFlight = reconcile;
        return await reconcile;
    }

    shouldAttemptPendingMaterialization(opts: {
        activeTurnSteerability?: PendingForegroundSteerability;
        pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
    } = {}): boolean {
        if (this.hasMaterializationBlockingCanonicalPendingDelivery()) return false;
        return countMaterializablePendingRows(this.pendingQueueState) > 0;
    }

    private resolvePendingForegroundState(
        activeTurnSteerability?: PendingForegroundSteerability,
    ): 'ready' | 'active_steerable' | 'active_unsteerable' {
        const hasActiveForegroundTurn = (
            this.sessionTurnLifecycle.hasActiveTurn()
            && !this.canBypassStaleLocalActiveTurnBlock()
        ) || isActiveLatestTurnStatus(this.latestTurnStatus);
        if (!hasActiveForegroundTurn) return 'ready';
        return activeTurnSteerability === 'steerable'
            ? 'active_steerable'
            : 'active_unsteerable';
    }

    /**
     * True when the canonical pending queue holds rows but every one of them is blocked
     * (undeliverable), i.e. there is no genuinely-deliverable pending work that a completed turn
     * should defer its ready/notification to. Consumers (the Claude ready handler) gate on this so
     * a stuck/blocked row cannot suppress the `ready` session event + push forever. Read-only;
     * distinct from the keepalive/self-healing thinking guard.
     */
    hasOnlyBlockedPendingWork(): boolean {
        const state = this.pendingQueueState;
        if (!state.known || state.pendingCount <= 0) return false;
        return countMaterializablePendingRows(state) === 0;
    }

    private canBypassStaleLocalActiveTurnBlock(now = Date.now()): boolean {
        if (!this.sessionTurnLifecycle.hasActiveTurn()) return false;
        if (this.latestTurnStatus === undefined || isActiveLatestTurnStatus(this.latestTurnStatus)) return false;
        return this.hasStaleLocalActiveTurnWithoutProgress(now);
    }

    private hasStaleLocalActiveTurnWithoutProgress(now = Date.now()): boolean {
        if (!this.sessionTurnLifecycle.hasActiveTurn()) return false;
        const startedAt = this.localActiveTurnStartedAtMs;
        if (startedAt === null) return false;
        const lastProgressAt = this.lastLocalActiveTurnProgressAtMs ?? startedAt;
        return now - lastProgressAt >= STALE_LOCAL_ACTIVE_TURN_RECONCILE_MS;
    }

    /**
     * Canonical turn lifecycle → pending-queue drain trigger.
     *
     * Turns recorded through the canonical session turn lifecycle (e.g. Claude unified
     * terminal turns) do not flow through ACP lifecycle markers, so without this the
     * locally cached latest-turn-status snapshot can stay 'in_progress' forever after a
     * turn ends — permanently blocking pending-queue materialization until a manual
     * "Send now". Keep the snapshot truthful and, on terminal events, wake pending
     * consumers and recover a possibly lost pending-count nudge (fail-safe: a duplicate
     * wake/reconcile is harmless; a missing one strands queued messages).
     */
    private observeTurnLifecycleForPendingDrain(
        event: SessionTurnLifecycleObserverEvent,
        terminalStatus?: 'completed' | 'failed',
    ): void {
        const observedAtMs = Date.now();
        if (event === 'prompt_or_steer' || event === 'task_started') {
            if (this.localActiveTurnStartedAtMs === null || !this.sessionTurnLifecycle.hasActiveTurn()) {
                this.localActiveTurnStartedAtMs = observedAtMs;
            }
            this.lastLocalActiveTurnProgressAtMs = observedAtMs;
        }
        const mapped = latestTurnStatusForTurnLifecycleEvent(event, terminalStatus);
        if (mapped !== undefined) {
            this.applyLatestTurnStatusProjection(mapped, observedAtMs);
        }
        if (!isTerminalTurnLifecycleEvent(event) || this.closed) return;
        this.localActiveTurnStartedAtMs = null;
        this.lastLocalActiveTurnProgressAtMs = null;
        logger.debug('[pendingQueue] turn-end drain trigger', {
            sessionId: this.sessionId,
            event,
            terminalStatus: terminalStatus ?? null,
            pendingCount: this.pendingQueueState.known ? this.pendingQueueState.pendingCount : null,
        });
        this.publishPendingEligibilityWake();
        void this.reconcilePendingQueueState({ force: false }).catch(() => undefined);
    }

    /**
     * Self-heal a stale 'in_progress' snapshot status: when ONLY the snapshot status
     * blocks materialization (no canonical active turn locally — e.g. a respawned
     * runner that never began the turn, or a lost turn-end signal), re-fetch the
     * server snapshot on a throttle so queued messages can never starve forever.
     */
    private async refreshStaleBlockedTurnStatusIfNeeded(): Promise<void> {
        const hasLocalActiveTurn = this.sessionTurnLifecycle.hasActiveTurn();
        const localActiveTurnIsStale = hasLocalActiveTurn && this.hasStaleLocalActiveTurnWithoutProgress();
        if (hasLocalActiveTurn && !localActiveTurnIsStale) return;
        if (!isActiveLatestTurnStatus(this.latestTurnStatus)) return;
        const now = Date.now();
        if (
            this.lastBlockedTurnStatusRefreshAt > 0
            && now - this.lastBlockedTurnStatusRefreshAt < configuration.pendingQueueStateReconcileThrottleMs
        ) {
            return;
        }
        this.lastBlockedTurnStatusRefreshAt = now;
        if (localActiveTurnIsStale) {
            logger.debug('[pendingQueue] stale local active turn snapshot reconcile', {
                sessionId: this.sessionId,
                latestTurnStatus: this.latestTurnStatus ?? null,
                localActiveTurnStartedAtMs: this.localActiveTurnStartedAtMs,
                lastLocalActiveTurnProgressAtMs: this.lastLocalActiveTurnProgressAtMs,
                staleAfterMs: STALE_LOCAL_ACTIVE_TURN_RECONCILE_MS,
            });
        }
        await this.syncSessionSnapshotFromServer({ reason: 'explicit-drain' });
    }

    private async reconcileTurnStatusBeforePendingMaterializationIfNeeded(opts: {
        activeTurnSteerability?: PendingForegroundSteerability;
    } = {}): Promise<boolean> {
        if (!this.pendingQueueState.known || countMaterializablePendingRows(this.pendingQueueState) <= 0) return true;
        if (
            (this.sessionTurnLifecycle.hasActiveTurn() && !this.canBypassStaleLocalActiveTurnBlock())
            || isActiveLatestTurnStatus(this.latestTurnStatus)
        ) {
            await this.refreshStaleBlockedTurnStatusIfNeeded();
            return true;
        }
        if (this.latestTurnStatus === undefined) return true;

        const pendingVersion = this.pendingQueueState.pendingVersion;
        if (
            this.lastTurnStatusRefreshPendingVersion === pendingVersion
        ) {
            return true;
        }

        const refreshed = await this.syncSessionSnapshotFromServer({ reason: 'explicit-drain' });
        if (!refreshed) {
            return false;
        }

        if (this.pendingQueueState.known && this.latestTurnStatus !== undefined) {
            this.lastTurnStatusRefreshPendingVersion = this.pendingQueueState.pendingVersion;
        }
        return true;
    }

    private syncSessionSnapshotFromServer(opts: { reason: SessionSnapshotRefreshReasonInput }): Promise<boolean> {
        if (this.closed) return Promise.resolve(false);
        if (this.snapshotSyncInFlight) return this.snapshotSyncInFlight;

        const p = (async (): Promise<boolean> => {
            try {
                const request = () => fetchSessionSnapshotUpdateFromServer({
                    token: this.token,
                    sessionId: this.sessionId,
                    encryptionKey: this.encryptionKey,
                    encryptionVariant: this.encryptionVariant,
                    currentMetadataVersion: this.metadataVersion,
                    currentAgentStateVersion: this.agentStateVersion,
                    currentMetadata: this.metadata,
                    currentAgentState: this.agentState,
                    reason: opts.reason,
                });
                const supervisor = this.sessionConnectionSupervisor;
                const update = supervisor
                    ? await runSupervisedRequest({
                        supervisor,
                        requireAuth: true,
                        requireOnline: false,
                        request,
                    })
                    : await request();

                if (this.closed) return false;

                if (update.metadata) {
                    this.metadata = update.metadata.metadata;
                    this.metadataVersion = update.metadata.metadataVersion;
                    this.emit('metadata-updated');
                }

                if (update.agentState) {
                    this.agentState = update.agentState.agentState;
                    this.agentStateVersion = update.agentState.agentStateVersion;
                }

                const latestTurnStatus = update.latestTurnStatus;
                if (latestTurnStatus !== undefined) {
                    this.applyLatestTurnStatusProjection(
                        latestTurnStatus,
                        update.latestTurnStatusObservedAt,
                    );
                }

                if (update.runtimeActivityProjection) {
                    this.applyRuntimeActivityProjectionFromServer(update.runtimeActivityProjection);
                }

                if (update.pendingQueueState) {
                    this.applyPendingQueueState(update.pendingQueueState, { emit: true });
                }
                return true;
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
        if (this.shouldKeepUserSocketConnected()) return;
        if (!this.userSocket.connected) return;
        if (this.userSocketDisconnectTimer) return;

        // Short idle grace to avoid thrashing if multiple pending items get materialized back-to-back.
        this.userSocketDisconnectTimer = setTimeout(() => {
            this.userSocketDisconnectTimer = null;
            if (this.shouldKeepUserSocketConnected()) return;
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
        return this.pendingMaterializedLocalIds.has(localId)
            || this.committedLocalIdsAwaitingEcho.has(localId)
            || this.pendingQueueMaterializedLocalIds.has(localId);
    }

    private shouldKeepUserSocketConnected(): boolean {
        return this.pendingMessageCallback !== null
            || this.pendingMaterializedLocalIds.size > 0
            || this.committedLocalIdsAwaitingEcho.size > 0
            || this.pendingQueueMaterializedLocalIds.size > 0
            || this.queuedDisconnectedSessionMessages.size > 0;
    }

    private queueSessionMessageUntilReconnect(params: { message: string | { t: 'plain'; v: unknown }; localId: string; sidechainId: string | null; messageRole?: SessionMessageRole; sessionEventType?: 'ready'; retryToken?: SessionMessageCommitRetryToken }): void {
        if (this.closed) return;
        this.queuedDisconnectedSessionMessages.set(params.localId, params);
        this.kickSessionSocketReconnectForQueuedMessage(params.localId);
    }

    private kickSessionSocketReconnectForQueuedMessage(localId: string): void {
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) return;
        void supervisor.start().catch((error) => {
            logger.debug('[API] Failed to restart session socket for queued message', {
                localId,
                error: serializeAxiosErrorForLog(error),
            });
        });
    }

    private kickSessionSocketReconnectForDurableMutation(reason: string): void {
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) return;
        void supervisor.start().catch((error) => {
            logger.debug('[API] Failed to restart session socket for durable mutation', {
                reason,
                error: serializeAxiosErrorForLog(error),
            });
        });
    }

    private async flushQueuedSessionMessagesOnReconnect(): Promise<void> {
        if (this.closed) return;
        if (!this.socket.connected) return;
        if (this.queuedDisconnectedSessionMessages.size === 0) return;

        const queued = [...this.queuedDisconnectedSessionMessages.values()];
        this.queuedDisconnectedSessionMessages.clear();
        for (const params of queued) {
            if (params.retryToken && !this.sessionMessageCommitRetry.readCurrent(params.retryToken)) {
                continue;
            }
            await this.enqueueMessageCommit('best-effort', {
                operation: 'reconnect-flush',
                details: {
                    localId: params.localId,
                    requireCommit: false,
                    connectionEpoch: this.userSocketSettingsConnectionEpoch,
                },
            }, () =>
                this.commitSessionMessage({
                    message: params.message,
                    localId: params.localId,
                    sidechainId: params.sidechainId,
                    messageRole: params.messageRole,
                    sessionEventType: params.sessionEventType,
                    requireCommit: false,
                    ...(params.retryToken ? { retryToken: params.retryToken } : {}),
                }),
            );
        }
    }

    private hasSelfEchoSuppressedLocalId(localId: string): boolean {
        return this.pendingMaterializedLocalIds.has(localId)
            || this.committedLocalIdsAwaitingEcho.has(localId);
    }

    private hasAgentQueueEchoSuppressedLocalId(localId: string): boolean {
        return this.agentQueueEchoSuppressedLocalIds.has(localId);
    }

    private hasAgentQueueDeliveredLocalId(localId: string): boolean {
        return this.agentQueueDeliveredLocalIds.has(localId);
    }

    private hasPendingQueueMaterializedLocalId(localId: string): boolean {
        return this.pendingQueueMaterializedLocalIds.has(localId);
    }

    private markAgentQueueEchoSuppressedLocalId(localId: string): void {
        if (!localId) return;
        this.agentQueueEchoSuppressedLocalIds.add(localId);
        const existingTimer = this.agentQueueEchoSuppressedLocalIdCleanupTimers.get(localId) ?? null;
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        const timer = setTimeout(() => {
            this.agentQueueEchoSuppressedLocalIdCleanupTimers.delete(localId);
            this.agentQueueEchoSuppressedLocalIds.delete(localId);
        }, configuration.transcriptRecoveryMaxWaitMs);
        timer.unref?.();
        this.agentQueueEchoSuppressedLocalIdCleanupTimers.set(localId, timer);
    }

    private markAgentQueueDeliveredLocalId(localId: string): void {
        if (!localId) return;
        this.agentQueueDeliveredLocalIds.add(localId);
        const existingTimer = this.agentQueueDeliveredLocalIdCleanupTimers.get(localId) ?? null;
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        const timer = setTimeout(() => {
            this.agentQueueDeliveredLocalIdCleanupTimers.delete(localId);
            this.agentQueueDeliveredLocalIds.delete(localId);
        }, configuration.transcriptRecoveryMaxWaitMs);
        timer.unref?.();
        this.agentQueueDeliveredLocalIdCleanupTimers.set(localId, timer);
    }

    private retainExplicitUserRecoveryDecision(localId: string, decision: Promise<ExplicitUserRecoveryDecision>): void {
        const existingTimer = this.explicitUserRecoveryCheckedLocalIdCleanupTimers.get(localId) ?? null;
        if (existingTimer) clearTimeout(existingTimer);
        const timer = setTimeout(() => {
            this.explicitUserRecoveryCheckedLocalIdCleanupTimers.delete(localId);
            this.explicitUserRecoveryDecisionsByLocalId.delete(localId);
        }, configuration.transcriptRecoveryMaxWaitMs);
        timer.unref?.();
        this.explicitUserRecoveryCheckedLocalIdCleanupTimers.set(localId, timer);
    }

    private async revalidateUsageLimitRecoveryForExplicitUserPrompt(localId: string): Promise<ExplicitUserRecoveryDecision> {
        const existing = this.explicitUserRecoveryDecisionsByLocalId.get(localId);
        if (existing) return await existing;

        const decision = (async (): Promise<ExplicitUserRecoveryDecision> => {
            if (hasClearedConnectedServiceTransitionConstraint(this.metadata)) {
                return { status: 'ready' };
            }
            const checkNow = this.sessionRuntimeControls.checkUsageLimitRecoveryNow;
            if (typeof checkNow !== 'function') {
                return hasBlockingExplicitUserRecoveryEvidence(this.metadata)
                    ? {
                        status: 'unavailable',
                        errorCode: 'session_user_message_recovery_control_unavailable',
                    }
                    : { status: 'ready' };
            }
            try {
                let deadline: ReturnType<typeof setTimeout> | null = null;
                const timeoutResult = new Promise<null>((resolve) => {
                    deadline = setTimeout(() => resolve(null), configuration.transcriptRecoveryMaxWaitMs);
                    deadline.unref?.();
                });
                const result = await Promise.race([
                    Promise.resolve(checkNow({
                        sessionId: this.sessionId,
                        operation: 'check_now',
                    })),
                    timeoutResult,
                ]).finally(() => {
                    if (deadline) clearTimeout(deadline);
                });
                if (!result || typeof result !== 'object' || Array.isArray(result)) {
                    return {
                        status: 'unavailable',
                        errorCode: 'session_user_message_recovery_control_unavailable',
                    };
                }
                const record = result as Record<string, unknown>;
                if (record.ok === true) {
                    const status = typeof record.status === 'string' ? record.status : '';
                    if (status === 'ready' || status === 'resumed' || status === 'cancelled') {
                        return { status: 'ready' };
                    }
                    if (status === 'waiting' || status === 'checking' || status === 'armed') {
                        return { status: 'waiting', errorCode: 'session_user_message_recovery_pending' };
                    }
                }
                return {
                    status: 'action_required',
                    errorCode: typeof record.errorCode === 'string' && record.errorCode.trim().length > 0
                        ? record.errorCode
                        : 'session_user_message_recovery_action_required',
                };
            } catch (error) {
                logger.debug('[SESSION CLIENT] Explicit user-request recovery check failed; blocking prompt delivery', {
                    sessionId: this.sessionId,
                    error: serializeAxiosErrorForLog(error),
                });
                return {
                    status: 'unavailable',
                    errorCode: 'session_user_message_recovery_control_unavailable',
                };
            }
        })();
        this.explicitUserRecoveryDecisionsByLocalId.set(localId, decision);
        this.retainExplicitUserRecoveryDecision(localId, decision);
        return await decision;
    }

    private recordCommittedUserMessageSeq(localId: unknown, seq: unknown): number | null {
        const pendingLocalId = readPendingLocalId(localId);
        const exactSeq = this.normalizeAcceptedCanonicalPendingDeliverySeq(seq);
        const committedSeq = this.committedUserMessageSeqTracker.record(
            pendingLocalId,
            exactSeq,
        );
        return committedSeq;
    }

    private markCommittedLocalIdAwaitingEcho(localId: string): void {
        this.pendingMaterializedLocalIds.delete(localId);
        this.committedLocalIdsAwaitingEcho.add(localId);
        const existingTimer = this.committedLocalIdCleanupTimers.get(localId) ?? null;
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        const timer = setTimeout(() => {
            this.committedLocalIdCleanupTimers.delete(localId);
            this.committedLocalIdsAwaitingEcho.delete(localId);
            this.maybeScheduleUserSocketDisconnect();
        }, configuration.transcriptRecoveryMaxWaitMs);
        timer.unref?.();
        this.committedLocalIdCleanupTimers.set(localId, timer);
    }

    private deleteMaterializedLocalId(localId: string): void {
        this.sessionMessageCommitRetry.completeCurrent(localId);
        this.pendingMaterializedLocalIds.delete(localId);
        this.committedLocalIdsAwaitingEcho.delete(localId);
        this.pendingQueueMaterializedLocalIds.delete(localId);
        const cleanupTimer = this.committedLocalIdCleanupTimers.get(localId) ?? null;
        if (cleanupTimer) {
            clearTimeout(cleanupTimer);
            this.committedLocalIdCleanupTimers.delete(localId);
        }
        this.transcriptRecoveryErrorStateByLocalId.delete(localId);
        this.maybeScheduleUserSocketDisconnect();
    }

    private handleLiveUpdate(data: Update, opts: {
        source: 'session-scoped' | 'user-scoped';
        socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    }): void {
        if (
            this.closed
            || (opts.source === 'session-scoped' && opts.socket !== this.socket)
            || (opts.source === 'user-scoped' && opts.socket !== this.userSocket)
        ) {
            return;
        }
        const isAccountSettingsUpdate = opts.source === 'user-scoped'
            && data.body?.t === 'update-account'
            && data.body.settingsV2 !== null
            && data.body.settingsV2 !== undefined;
        const isAccountSettingsHint = opts.source === 'user-scoped'
            && data.body?.t === 'account-settings-changed';
        const parsedAccountSettingsUpdate = isAccountSettingsUpdate
            ? AccountSettingsV2GetResponseSchema.safeParse(data.body.settingsV2)
            : null;
        const accountSettingsUpdate = parsedAccountSettingsUpdate?.success
            ? parsedAccountSettingsUpdate.data
            : null;

        if (!isAccountSettingsUpdate && !isAccountSettingsHint) {
            this.handleUpdate(data, opts);
            return;
        }

        const rawSettingsVersion = isAccountSettingsUpdate
            ? (data.body.settingsV2 as { version?: unknown }).version
            : data.body.t === 'account-settings-changed'
                ? data.body.settingsVersion
                : null;
        const settingsVersion = typeof rawSettingsVersion === 'number'
            && Number.isSafeInteger(rawSettingsVersion)
            && rawSettingsVersion >= 0
            ? rawSettingsVersion
            : null;
        const activeSettingsVersion = getActiveAccountSettingsSnapshot()?.settingsVersion ?? -1;
        const highestKnownSettingsVersion = Math.max(
            activeSettingsVersion,
            this.accountSettingsHighestObservedVersion,
        );
        if (settingsVersion !== null && settingsVersion < highestKnownSettingsVersion) {
            logger.debug('[accountSettings] Ignoring an older live account settings version', {
                settingsVersion,
                highestKnownSettingsVersion,
            });
            return;
        }
        if (settingsVersion !== null) {
            this.accountSettingsHighestObservedVersion = Math.max(
                this.accountSettingsHighestObservedVersion,
                settingsVersion,
            );
        }

        // Settings envelopes carry no session projection themselves. Other envelopes continue
        // through handleUpdate immediately; only their Pending-eligibility effect is withheld.
        const revision = ++this.accountSettingsEventRevision;
        const sourceUserSocketConnectionEpoch = this.userSocketSettingsConnectionEpoch;
        const deliveryTimingBeforeUpdate = resolveSessionPendingQueueDeliveryTiming(
            getActiveAccountSettingsSnapshot()?.settings ?? null,
        );

        if (isAccountSettingsUpdate && !accountSettingsUpdate) {
            logger.debug('[accountSettings] Ignoring malformed live account settings update and withholding pending eligibility wakes');
            this.accountSettingsSyncBarrier = Promise.resolve(false);
            this.accountSettingsSyncBarrierState = 'failed';
            this.userSocketSettingsConvergedEpoch = -1;
            return;
        }

        const current = (async () => {
            const credentials = await readCredentials();
            if (!credentials || credentials.token !== this.token) {
                throw new Error('Account settings update cannot be applied without active credentials');
            }
            const sourceIsCurrent = () => (
                !this.closed
                && opts.socket === this.userSocket
                && opts.socket.connected === true
                && sourceUserSocketConnectionEpoch === this.userSocketSettingsConnectionEpoch
                && revision === this.accountSettingsEventRevision
            );
            if (accountSettingsUpdate && data.body.t === 'update-account') {
                const accountId = await this.getAccountId();
                if (!accountId || accountId !== data.body.id) {
                    throw new Error('Account settings update does not belong to the authenticated account');
                }
                await applyAccountSettingsV2Update({
                    credentials,
                    update: accountSettingsUpdate,
                    shouldCommit: sourceIsCurrent,
                });
            } else if (data.body.t === 'account-settings-changed') {
                await refreshActiveAccountSettingsFromServer({
                    credentials,
                    minSettingsVersion: data.body.settingsVersion,
                    shouldCommit: sourceIsCurrent,
                });
            }
            if (!sourceIsCurrent()) {
                throw new Error('Account settings source closed before convergence completed');
            }
            return true;
        })().catch((error) => {
            logger.debug('[accountSettings] Failed to apply live account settings update; withholding pending eligibility wakes', {
                settingsVersion: accountSettingsUpdate?.version
                    ?? (data.body.t === 'account-settings-changed' ? data.body.settingsVersion : null),
                error: serializeAxiosErrorForLog(error),
            });
            return false;
        });
        this.accountSettingsSyncBarrier = current;
        this.accountSettingsSyncBarrierState = 'applying';
        void current.then((didApply) => {
            if (
                this.closed
                || opts.socket !== this.userSocket
                || opts.socket.connected !== true
                || revision !== this.accountSettingsEventRevision
                || this.accountSettingsSyncBarrier !== current
            ) return;
            if (!didApply) {
                this.accountSettingsSyncBarrierState = 'failed';
                this.userSocketSettingsConvergedEpoch = -1;
                if (this.accountSettingsPendingEligibilityWakeWithheld) {
                    this.accountSettingsPendingEligibilityWakeWithheld = false;
                    this.publishPendingEligibilityWake();
                }
                return;
            }
            this.accountSettingsSyncBarrier = null;
            this.accountSettingsSyncBarrierState = null;
            this.userSocketSettingsConvergedEpoch = this.userSocketSettingsConnectionEpoch;
            const deliveryTimingAfterUpdate = resolveSessionPendingQueueDeliveryTiming(
                getActiveAccountSettingsSnapshot()?.settings ?? null,
            );
            const didBroadenEligibility = deliveryTimingBeforeUpdate === 'after_runtime_idle'
                && deliveryTimingAfterUpdate === 'after_foreground_ready';
            const hadWithheldWake = this.accountSettingsPendingEligibilityWakeWithheld;
            this.accountSettingsPendingEligibilityWakeWithheld = false;
            if (didBroadenEligibility || hadWithheldWake) {
                this.publishPendingEligibilityWake();
            }
        });
    }

    private handleUpdate(data: Update, opts: {
        source: 'session-scoped' | 'user-scoped';
        catchUpAfterSeq?: number;
        replayPreviouslyObservedMessageIdsForObservation?: boolean;
    }): void {
        try {
            logger.debugLargeJson(`[SOCKET] [UPDATE:${opts.source}] Received update:`, data);

            if (!data.body) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                return;
            }

            if (
                (data.body as any)?.t === 'message-updated'
                && (data.body as any)?.sid === this.sessionId
            ) {
                const updatedLocalId = typeof (data.body as any)?.message?.localId === 'string'
                    ? (data.body as any).message.localId
                    : null;
                if (updatedLocalId && this.hasSelfEchoSuppressedLocalId(updatedLocalId)) {
                    this.deleteMaterializedLocalId(updatedLocalId);
                }
            }

            this.recordCommittedUserMessageSeqFromUpdate(data);

            const newMessageHandlingResult = handleSessionNewMessageUpdate({
                update: data,
                sessionId: this.sessionId,
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
                receivedMessageIds: this.receivedMessageIds,
                replayPreviouslyObservedMessageIdsForObservation:
                    opts.replayPreviouslyObservedMessageIdsForObservation,
                lastObservedMessageSeq: this.lastObservedMessageSeq,
                lastObservedUserMessageSeq: this.lastObservedUserMessageSeq,
                hasSelfEchoSuppressedLocalId: (localId) => this.hasSelfEchoSuppressedLocalId(localId),
                hasPendingQueueMaterializedLocalId: (localId) => this.hasPendingQueueMaterializedLocalId(localId),
                deleteMaterializedLocalId: (localId) => this.deleteMaterializedLocalId(localId),
                onObservedMessage: (message) => {
                    if (isProviderProgressTranscriptBody(message.body) && this.sessionTurnLifecycle.hasActiveTurn()) {
                        this.lastLocalActiveTurnProgressAtMs = message.createdAt ?? Date.now();
                    }
                    this.observeTurnAssistantTextFromSessionContent(message.body, {
                        source: 'transcript',
                        seq: message.seq,
                        localId: message.localId,
                        sidechainId: message.sidechainId,
                        observedAtMs: message.createdAt ?? Date.now(),
                    });
                },
                emit: (event, payload) => this.emit(event, payload),
                debug: (message, payload) => logger.debug(message, payload),
                debugLargeJson: (message, payload) => logger.debugLargeJson(message, payload),
            });
            if (newMessageHandlingResult.handled) {
                this.lastObservedMessageSeq = newMessageHandlingResult.lastObservedMessageSeq;
                this.lastObservedUserMessageSeq = Math.max(
                    this.lastObservedUserMessageSeq,
                    newMessageHandlingResult.lastObservedUserMessageSeq,
                );
                return;
            }

            let shouldEmitMetadataUpdated = false;
            const stateUpdateResult = handleSessionStateUpdate({
                update: data,
                updateSource: opts.source,
                sessionId: this.sessionId,
                sessionEncryptionMode: this.sessionEncryptionMode,
                metadata: this.metadata,
                metadataVersion: this.metadataVersion,
                agentState: this.agentState,
                agentStateVersion: this.agentStateVersion,
                pendingWakeSeq: this.pendingWakeSeq,
                pendingQueueState: this.pendingQueueState,
                runtimeActivityProjection: this.runtimeActivityProjection,
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
                onMetadataUpdated: () => {
                    shouldEmitMetadataUpdated = true;
                },
                onPendingChangedDrainTrigger: (snapshot) => {
                    logger.debug('[pendingQueue] pending-changed drain trigger', {
                        sessionId: this.sessionId,
                        updateSource: opts.source,
                        pendingCount: snapshot.pendingCount,
                        pendingBlockedCount: snapshot.pendingBlockedCount,
                        pendingVersion: snapshot.pendingVersion,
                    });
                },
                onRuntimeActivityResyncRequired: () => {
                    void this.syncSessionSnapshotFromServer({ reason: 'runtime-activity-conflict' });
                },
                onWarning: (message) => logger.debug(message),
            });
            if (stateUpdateResult.handled) {
                const pendingWakeSeqBefore = this.pendingWakeSeq;
                const shouldWithholdPendingEligibility = this.accountSettingsSyncBarrierState === 'applying';
                const runtimeActivityWasIdle = this.runtimeActivityProjection.runtimeActivityState === 'idle'
                    && this.runtimeActivityProjection.runtimeActivityActiveCount === 0;
                this.metadata = stateUpdateResult.metadata;
                this.metadataVersion = stateUpdateResult.metadataVersion;
                this.agentState = stateUpdateResult.agentState;
                this.agentStateVersion = stateUpdateResult.agentStateVersion;
                this.pendingWakeSeq = shouldWithholdPendingEligibility
                    ? pendingWakeSeqBefore
                    : stateUpdateResult.pendingWakeSeq;
                this.pendingQueueState = stateUpdateResult.pendingQueueState;
                this.applyRuntimeActivityProjectionFromServer(stateUpdateResult.runtimeActivityProjection, {
                    // handleSessionStateUpdate is the one wake-sequence owner for this envelope.
                    // The projection applier updates local Activity state without publishing a
                    // second wake for the same accepted idle transition.
                    emitPendingEligibility: false,
                });
                const runtimeActivityBecameIdle = !runtimeActivityWasIdle
                    && this.runtimeActivityProjection.runtimeActivityState === 'idle'
                    && this.runtimeActivityProjection.runtimeActivityActiveCount === 0;
                if (
                    shouldWithholdPendingEligibility
                    && (
                        stateUpdateResult.pendingWakeSeq !== pendingWakeSeqBefore
                        || runtimeActivityBecameIdle
                    )
                ) {
                    this.accountSettingsPendingEligibilityWakeWithheld = true;
                }
                if (
                    !shouldWithholdPendingEligibility
                    && stateUpdateResult.pendingWakeSeq !== pendingWakeSeqBefore
                ) {
                    this.emitPendingEligibilityUpdated();
                }
                if (
                    shouldEmitMetadataUpdated
                    || (
                        shouldWithholdPendingEligibility
                        && stateUpdateResult.pendingWakeSeq !== pendingWakeSeqBefore
                    )
                ) {
                    this.emit('metadata-updated');
                }
                return;
            }

            // If not a user message, it might be a permission response or other message type
            this.emit('message', data.body);
        } catch (error) {
            logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', {
                error: serializeAxiosErrorForLog(error),
            });
        }
    }

    private recordCommittedUserMessageSeqFromUpdate(data: Update): void {
        const body = data.body as any;
        if (
            body?.sid !== this.sessionId
            || (body?.t !== 'new-message' && body?.t !== 'message-updated')
        ) {
            return;
        }
        const message = body.message;
        const messageRole =
            message?.messageRole
            ?? message?.content?.v?.role
            ?? message?.content?.role
            ?? null;
        if (messageRole !== 'user') {
            return;
        }
        const localId = readPendingLocalId(message.localId);
        const committedSeq = this.recordCommittedUserMessageSeq(localId, message.seq);
        if (
            localId === null
            || committedSeq === null
            || this.providerInputTerminalOutcomeByLocalId.get(localId) !== 'accepted'
            || !this.canonicalPendingDeliveryByLocalId.has(localId)
        ) {
            return;
        }

        // The server-authored user transcript row is exact committed proof for this localId.
        // It may arrive even when the accepted-settlement ACK was lost. Retire only local
        // custody bookkeeping; transcript observation never invokes provider input or writes
        // Pending state.
        logger.debug('[pendingQueue] exact committed transcript retired accepted local custody', {
            sessionId: this.sessionId,
            localId,
            seq: committedSeq,
        });
        this.clearCanonicalPendingDeliveryLocalState(localId);
    }

    private async getAccountId(): Promise<string | null> {
        if (this.accountIdPromise) {
            try {
                return await this.accountIdPromise;
            } catch (error) {
                this.accountIdPromise = null;
                if (isAuthenticationError(error)) {
                    if (this.sessionConnectionSupervisor) {
                        return null;
                    }
                    throw error;
                }
                return null;
            }
        }

        const request = () => fetchChangesAccountId({ token: this.token });
        const supervisor = this.sessionConnectionSupervisor;
        const p = supervisor
            ? runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request,
            })
            : request();

        this.accountIdPromise = p;
        try {
            return await p;
        } catch (error) {
            this.accountIdPromise = null;
            if (isAuthenticationError(error)) {
                if (supervisor) {
                    return null;
                }
                throw error;
            }
            return null;
        }
    }

    private async catchUpSessionMessages(catchUpRequest: SessionCatchUpRequest): Promise<void> {
        const request = () => catchUpSessionMessagesAfterSeq({
            token: this.token,
            sessionId: this.sessionId,
            afterSeq: catchUpRequest.afterSeq,
            onUpdate: (update) => this.handleUpdate(update, {
                source: 'session-scoped',
                catchUpAfterSeq: catchUpRequest.afterSeq,
                replayPreviouslyObservedMessageIdsForObservation:
                    catchUpRequest.replayPreviouslyObservedMessageIdsForObservation,
            }),
        });
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            await request();
            return;
        }
        await runSupervisedRequest({
            supervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        });
    }

    private shouldRunStartupTranscriptCatchUp(): boolean {
        return (
            this.startedByDaemonProcess ||
            this.metadata?.startedBy === 'daemon' ||
            this.metadata?.startedFromDaemon === true
        );
    }

    private resolveStartupTranscriptCatchUpInitialCursor(): SessionCatchUpRequest {
        if (this.startupMessageCatchUpExplicitAfterSeq !== null) {
            return {
                afterSeq: this.startupMessageCatchUpExplicitAfterSeq,
                replayPreviouslyObservedMessageIdsForObservation: true,
            };
        }

        const base = Math.max(0, Math.trunc(this.lastObservedMessageSeq));
        if (!this.shouldRunStartupTranscriptCatchUp()) {
            return { afterSeq: base };
        }
        const rewind = Math.max(0, Math.trunc(configuration.startupTranscriptCatchUpSeqRewind));
        if (rewind <= 0) {
            return { afterSeq: base };
        }
        return { afterSeq: Math.max(0, base - rewind) };
    }

    private scheduleNextStartupMessageCatchUpRetry(): void {
        if (this.closed) return;
        if (this.startupMessageCatchUpRetryTimer) return;
        if (!this.shouldRunStartupTranscriptCatchUp()) return;
        if (this.currentConnectionState?.phase === 'auth_failed') return;

        const delayMs = ApiSessionClient.STARTUP_MESSAGE_CATCH_UP_RETRY_DELAYS_MS[this.startupMessageCatchUpRetryIndex];
        if (typeof delayMs !== 'number') return;

        logger.debug('[API] Scheduling startup transcript catch-up retry', {
            delayMs,
            retryIndex: this.startupMessageCatchUpRetryIndex,
            startupMessageCatchUpInitialAfterSeq: this.startupMessageCatchUpInitialAfterSeq,
            lastObservedMessageSeq: this.lastObservedMessageSeq,
        });
        this.startupMessageCatchUpRetryTimer = setTimeout(() => {
            this.startupMessageCatchUpRetryTimer = null;
            if (this.closed) return;

            this.startupMessageCatchUpRetryIndex += 1;
            logger.debug('[API] Running startup transcript catch-up retry', {
                retryIndex: this.startupMessageCatchUpRetryIndex,
                afterSeq: this.startupMessageCatchUpInitialAfterSeq,
            });
            void this.catchUpSessionMessages({
                afterSeq: this.startupMessageCatchUpInitialAfterSeq,
                replayPreviouslyObservedMessageIdsForObservation:
                    this.startupMessageCatchUpExplicitAfterSeq !== null,
            })
                .catch((error) => {
                    if (isAuthenticationError(error)) {
                        logger.debug('[API] Startup transcript catch-up retry failed with terminal auth', {
                            error: serializeAxiosErrorForLog(error),
                        });
                        return false;
                    }
                    logger.debug('[API] Startup transcript catch-up retry failed (non-fatal)', {
                        error: serializeAxiosErrorForLog(error),
                    });
                    return true;
                })
                .then((shouldContinue) => {
                    if (shouldContinue !== false) {
                        this.scheduleNextStartupMessageCatchUpRetry();
                    }
                });
        }, delayMs);
        this.startupMessageCatchUpRetryTimer.unref?.();
    }

    private async syncChangesOnConnect(opts: { reason: SessionChangesSyncReason }): Promise<void> {
        const enabled = isV2ChangesSyncEnabled(process.env.HAPPY_ENABLE_V2_CHANGES);
        if (!enabled) {
            return;
        }

        if (this.closed) return;
        if (this.changesSyncInFlight) {
            await this.changesSyncInFlight.catch(() => {});
        }

        const p = runSessionChangesSyncOnConnect({
            reason: opts.reason,
            token: this.token,
            sessionId: this.sessionId,
            lastObservedMessageSeq: this.lastObservedMessageSeq,
            getAccountId: () => this.getAccountId(),
            readChangesCursor: (accountId) => this.readSessionChangesCursor(accountId),
            writeChangesCursor: (accountId, cursor) => this.writeSessionChangesCursor(accountId, cursor),
            catchUpSessionMessages: (request) => this.catchUpSessionMessages(request),
            syncSessionSnapshotFromServer: (syncOpts) => this.syncSessionSnapshotFromServer(syncOpts),
            applyPendingQueueState: (state) => this.applyPendingQueueState(state, { emit: true }),
            refreshAccountSettingsForMinimumVersion: (settingsVersion) => (
                this.refreshAccountSettingsFromChangesHint(settingsVersion)
            ),
            connectionSupervisor: this.sessionConnectionSupervisor,
            onDebug: (message, data) => logger.debug(message, data),
        });

        this.changesSyncInFlight = p;
        try {
            await p;
        } finally {
            if (this.changesSyncInFlight === p) {
                this.changesSyncInFlight = null;
            }
        }
    }

    private refreshAccountSettingsFromChangesHint(
        settingsVersion: number | null,
        opts: Readonly<{
            sourceSocket?: Socket<ServerToClientEvents, ClientToServerEvents>;
            publishPendingEligibilityWake?: boolean;
        }> = {},
    ): Promise<void> {
        const existingConvergence = this.accountSettingsSyncBarrierState === 'applying'
            ? this.accountSettingsSyncBarrier
            : null;
        if (existingConvergence) {
            return existingConvergence.then((didApply) => {
                if (!didApply) {
                    throw new Error('Account settings reconnect convergence failed');
                }
            });
        }

        const revision = ++this.accountSettingsEventRevision;
        const sourceUserSocketConnectionEpoch = opts.sourceSocket === this.userSocket
            ? this.userSocketSettingsConnectionEpoch
            : null;
        let failure: unknown = null;
        const sourceIsCurrent = () => (
            !this.closed
            && revision === this.accountSettingsEventRevision
            && (
                !opts.sourceSocket
                || (
                    opts.sourceSocket === this.userSocket
                    && opts.sourceSocket.connected === true
                    && sourceUserSocketConnectionEpoch === this.userSocketSettingsConnectionEpoch
                )
            )
        );
        // Construct and publish the barrier before the first credential/account await. A Pending
        // hint delivered in the same socket turn must observe fail-closed convergence immediately.
        const current = (async () => {
            const credentials = await readCredentials();
            if (!credentials || credentials.token !== this.token) {
                throw new Error('Account settings reconnect refresh requires the active session credentials');
            }
            const accountId = await this.getAccountId();
            if (!accountId) {
                throw new Error('Account settings reconnect refresh requires an authenticated account');
            }
            await refreshActiveAccountSettingsFromServer({
                credentials,
                minSettingsVersion: settingsVersion,
                shouldCommit: sourceIsCurrent,
            });
            if (!sourceIsCurrent()) {
                throw new Error('Account settings reconnect source closed before convergence completed');
            }
            return true;
        })().catch((error) => {
            failure = error;
            logger.debug('[accountSettings] Failed request-only reconnect convergence; withholding pending eligibility wakes', {
                settingsVersion,
                error: serializeAxiosErrorForLog(error),
            });
            return false;
        });
        this.accountSettingsSyncBarrier = current;
        this.accountSettingsSyncBarrierState = 'applying';
        return current.then((didApply) => {
            if (!didApply) {
                if (this.accountSettingsSyncBarrier === current) {
                    this.accountSettingsSyncBarrierState = 'failed';
                    this.userSocketSettingsConvergedEpoch = -1;
                    if (this.accountSettingsPendingEligibilityWakeWithheld) {
                        this.accountSettingsPendingEligibilityWakeWithheld = false;
                        this.publishPendingEligibilityWake();
                    }
                }
                throw failure instanceof Error ? failure : new Error('Account settings reconnect convergence failed');
            }
            if (!sourceIsCurrent() || this.accountSettingsSyncBarrier !== current) return;
            this.accountSettingsSyncBarrier = null;
            this.accountSettingsSyncBarrierState = null;
            this.accountSettingsHighestObservedVersion = Math.max(
                this.accountSettingsHighestObservedVersion,
                getActiveAccountSettingsSnapshot()?.settingsVersion ?? -1,
            );
            this.accountSettingsPendingEligibilityWakeWithheld = false;
            if (opts.publishPendingEligibilityWake !== false) {
                this.publishPendingEligibilityWake();
            }
        });
    }

    private convergeAccountSettingsForUserSocketConnection(): Promise<void> {
        const epoch = this.userSocketSettingsConnectionEpoch;
        if (this.userSocketSettingsConvergedEpoch === epoch) return Promise.resolve();
        if (this.userSocketSettingsConvergenceInFlight) {
            return this.userSocketSettingsConvergenceInFlight;
        }
        const current = this.refreshAccountSettingsFromChangesHint(null, {
            sourceSocket: this.userSocket,
            publishPendingEligibilityWake: false,
        }).then(() => {
            if (
                !this.closed
                && this.userSocket.connected
                && this.userSocketSettingsConnectionEpoch === epoch
            ) {
                this.userSocketSettingsConvergedEpoch = epoch;
            }
        });
        const tracked = current.finally(() => {
            if (this.userSocketSettingsConvergenceInFlight === tracked) {
                this.userSocketSettingsConvergenceInFlight = null;
            }
        });
        this.userSocketSettingsConvergenceInFlight = tracked;
        return tracked;
    }

    private async readSessionChangesCursor(accountId: string): Promise<number> {
        const existing = this.sessionChangesCursorByAccountId.get(accountId);
        if (typeof existing === 'number' && Number.isSafeInteger(existing) && existing >= 0) {
            return existing;
        }

        let initialCursor = 0;
        try {
            initialCursor = await readAccountChangesCursor(accountId);
        } catch {
            initialCursor = 0;
        }
        const normalized = Number.isSafeInteger(initialCursor) && initialCursor >= 0 ? initialCursor : 0;
        this.sessionChangesCursorByAccountId.set(accountId, normalized);
        return normalized;
    }

    private async writeSessionChangesCursor(accountId: string, cursor: number): Promise<void> {
        const normalized = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
        const existing = this.sessionChangesCursorByAccountId.get(accountId) ?? 0;
        if (normalized > existing) {
            this.sessionChangesCursorByAccountId.set(accountId, normalized);
        }
    }

    private async recoverMaterializedLocalId(
        localId: string,
        opts?: { maxWaitMs?: number },
    ): Promise<
        | { status: 'recovered' }
        | { status: 'not_found' }
        | { status: 'unsupported'; error: unknown }
    > {
        let unsupportedLookupError: unknown = null;
        const found = await waitForTranscriptEncryptedMessageByLocalId({
            token: this.token,
            sessionId: this.sessionId,
            localId,
            supervisor: this.sessionConnectionSupervisor ?? undefined,
            maxWaitMs: opts?.maxWaitMs,
            onError: (error) => {
                this.debugTranscriptRecoveryFetchError(localId, error);
            },
            onUnsupported: (error) => {
                unsupportedLookupError = error;
            },
        });
        if (unsupportedLookupError) {
            return { status: 'unsupported', error: unsupportedLookupError };
        }
        if (!found) return { status: 'not_found' };

        // Transcript recovery proves durable observation only. Provider input is
        // handed off exclusively from the claimed Pending row returned by the
        // materialization owner; transcript/history must never replay it.
        this.deleteMaterializedLocalId(localId);
        return { status: 'recovered' };
    }

    private readPendingQueueUserMessage(
        message: PendingQueueMaterializedMessage | null | undefined,
    ): UserMessage | null {
        if (!message?.content) return null;
        if (message.messageRole !== null && message.messageRole !== 'user') return null;
        let body: unknown;
        try {
            body = this.decodeStoredSessionMessageContent(message.content);
        } catch (error) {
            logger.debug('[pendingQueue] failed to decode provider-claimed pending message content', {
                sessionId: this.sessionId,
                localId: message.localId ?? null,
                error: serializeAxiosErrorForLog(error),
            });
            return null;
        }

        const bodyRecord = body && typeof body === 'object' ? body as Record<string, unknown> : {};
        const localId = readPendingLocalId(message.localId);
        const bodyWithTransportFields = {
            ...bodyRecord,
            ...(localId ? { localId } : {}),
            ...(typeof message.createdAt === 'number' ? { createdAt: message.createdAt } : {}),
        };
        const parsed = UserMessageSchema.safeParse(bodyWithTransportFields);
        if (!parsed.success) {
            logger.debug('[pendingQueue] provider-claimed pending message is not a user prompt', {
                sessionId: this.sessionId,
                localId,
                issues: parsed.error.issues.map((issue) => ({
                    code: issue.code,
                    path: issue.path,
                })),
            });
            return null;
        }
        return parsed.data;
    }

    private async deliverPendingQueueMessage(
        message: PendingQueueMaterializedMessage | null | undefined,
        opts: Readonly<{ providerAcceptancePending: boolean }>,
    ): Promise<boolean> {
        const userMessage = this.readPendingQueueUserMessage(message);
        if (!userMessage) return false;
        const localId = readPendingLocalId(userMessage.localId);
        if (localId) {
            if (this.hasAgentQueueDeliveredLocalId(localId)) {
                return true;
            }
            this.markAgentQueueEchoSuppressedLocalId(localId);
            this.markAgentQueueDeliveredLocalId(localId);
        }
        if (this.pendingMessageCallback) {
            await this.pendingMessageCallback(userMessage, {
                seq: typeof message?.seq === 'number' && Number.isFinite(message.seq) ? message.seq : null,
                ...(opts.providerAcceptancePending ? { providerAcceptancePending: true } : {}),
                ...(message?.providerAction ? { pendingProviderAction: message.providerAction } : {}),
            });
        } else {
            if (localId) {
                this.bufferedPendingMessageDeliveryInfoByLocalId.set(localId, {
                    seq: typeof message?.seq === 'number' && Number.isFinite(message.seq) ? message.seq : null,
                    ...(opts.providerAcceptancePending ? { providerAcceptancePending: true } : {}),
                    ...(message?.providerAction ? { pendingProviderAction: message.providerAction } : {}),
                });
            }
            this.pendingMessages.push(userMessage);
        }
        return true;
    }

    onUserMessage(callback: (data: UserMessage, info?: SessionUserMessageDeliveryInfo) => unknown | Promise<unknown>) {
        logger.debug('[API] onUserMessage callback attached', {
            sessionId: this.sessionId,
            startedByDaemonProcess: this.startedByDaemonProcess,
            metadataStartedBy: this.metadata?.startedBy ?? null,
            metadataStartedFromDaemon: this.metadata?.startedFromDaemon ?? null,
        });
        this.pendingMessageCallback = callback;
        if (this.userSocketDisconnectTimer) {
            clearTimeout(this.userSocketDisconnectTimer);
            this.userSocketDisconnectTimer = null;
        }
        this.kickUserSocketConnect();
        while (this.pendingMessages.length > 0) {
            // Only live provider-claim handoffs enter this process-local buffer while no
            // callback is attached; transcript catch-up never populates it. Preserve the
            // recorded delivery info, including seq=null for an uncommitted provider claim.
            // Publisher replacement/re-registration contracts any surviving claim to durable
            // uncertainty server-side, so draining this buffer is not a resume/replay path.
            const message = this.pendingMessages.shift()!;
            const localId = typeof message.localId === 'string' ? message.localId : null;
            const deliveryInfo = localId
                ? this.bufferedPendingMessageDeliveryInfoByLocalId.get(localId)
                : undefined;
            if (localId) this.bufferedPendingMessageDeliveryInfoByLocalId.delete(localId);
            void Promise.resolve(callback(message, deliveryInfo ?? { seq: null })).catch((error) => {
                logger.debug('[pendingQueue] buffered provider-input callback failed', {
                    sessionId: this.sessionId,
                    localId,
                    error: serializeAxiosErrorForLog(error),
                });
            });
        }
        if (!this.startupMessageCatchUpStarted) {
            this.startupMessageCatchUpStarted = true;
            this.startupMessageCatchUpRetryIndex = 0;
            const startupCursor = this.resolveStartupTranscriptCatchUpInitialCursor();
            this.startupMessageCatchUpInitialAfterSeq = startupCursor.afterSeq;
            void this.catchUpSessionMessages({
                afterSeq: this.startupMessageCatchUpInitialAfterSeq,
                replayPreviouslyObservedMessageIdsForObservation:
                    startupCursor.replayPreviouslyObservedMessageIdsForObservation,
            })
                .catch((error) => {
                    if (isAuthenticationError(error)) {
                        logger.debug('[API] Initial transcript catch-up failed with terminal auth', {
                            error: serializeAxiosErrorForLog(error),
                        });
                        return false;
                    }
                    logger.debug('[API] Initial transcript catch-up failed (non-fatal)', {
                        error: serializeAxiosErrorForLog(error),
                    });
                    return true;
                })
                .then((shouldContinue) => {
                    if (shouldContinue !== false) {
                        this.scheduleNextStartupMessageCatchUpRetry();
                    }
                });
        }
    }

    private publishPendingEligibilityWake(): void {
        this.pendingWakeSeq += 1;
        this.emit('metadata-updated');
        this.emit('pending-eligibility-updated');
    }

    private emitPendingEligibilityUpdated(): void {
        this.emit('pending-eligibility-updated');
    }

    waitForPendingEligibilityUpdate(abortSignal?: AbortSignal): Promise<boolean> {
        if (abortSignal?.aborted) return Promise.resolve(false);
        const startPendingWakeSeq = this.pendingWakeSeq;
        return new Promise((resolve) => {
            let cleanedUp = false;
            const finish = (value: boolean) => {
                cleanup();
                resolve(value);
            };
            const onUpdate = () => finish(true);
            const onAbort = () => finish(false);
            let connectConvergenceStarted = false;
            const onConnect = () => {
                if (connectConvergenceStarted) return;
                connectConvergenceStarted = true;
                void this.convergeAccountSettingsForUserSocketConnection().then(
                    () => finish(true),
                    () => finish(false),
                );
            };
            const onDisconnect = () => finish(false);
            const cleanup = () => {
                if (cleanedUp) return;
                cleanedUp = true;
                this.off('pending-eligibility-updated', onUpdate);
                abortSignal?.removeEventListener('abort', onAbort);
                this.userSocket.off('connect', onConnect);
                this.userSocket.off('disconnect', onDisconnect);
                this.maybeScheduleUserSocketDisconnect();
            };
            this.on('pending-eligibility-updated', onUpdate);
            abortSignal?.addEventListener('abort', onAbort, { once: true });
            this.userSocket.on('connect', onConnect);
            this.userSocket.on('disconnect', onDisconnect);
            this.kickUserSocketConnect();
            if (abortSignal?.aborted) {
                onAbort();
            } else if (
                this.userSocket.connected
                && this.userSocketSettingsConvergedEpoch !== this.userSocketSettingsConnectionEpoch
            ) {
                onConnect();
            } else if (this.pendingWakeSeq !== startPendingWakeSeq) {
                onUpdate();
            }
        });
    }

    waitForMetadataUpdate(abortSignal?: AbortSignal): Promise<boolean> {
        if (abortSignal?.aborted) {
            return Promise.resolve(false);
        }

        const startMetadataVersion = this.metadataVersion;
        const startAgentStateVersion = this.agentStateVersion;
        const startPendingWakeSeq = this.pendingWakeSeq;
        const startPendingQueueDeliveryTiming = resolveSessionPendingQueueDeliveryTiming(
            getActiveAccountSettingsSnapshot()?.settings ?? null,
        );
        if (startMetadataVersion < 0 || startAgentStateVersion < 0) {
            void this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
        }
        return new Promise((resolve) => {
            let cleanedUp = false;
            let unsubscribeAccountSettings = () => {};
            const onUpdate = () => {
                cleanup();
                resolve(true);
            };
            const onAbort = () => {
                cleanup();
                resolve(false);
            };
            const onConnect = () => {
                cleanup();
                resolve(true);
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
                this.userSocket.off('connect', onConnect);
                this.userSocket.off('disconnect', onDisconnect);
                unsubscribeAccountSettings();
                this.maybeScheduleUserSocketDisconnect();
            };

            this.on('metadata-updated', onUpdate);
            abortSignal?.addEventListener('abort', onAbort, { once: true });
            this.userSocket.on('connect', onConnect);
            this.userSocket.on('disconnect', onDisconnect);
            unsubscribeAccountSettings = subscribeActiveAccountSettingsSnapshot((previous, next) => {
                if (
                    this.accountSettingsSyncBarrier === null
                    &&
                    resolveSessionPendingQueueDeliveryTiming(previous?.settings ?? null) === 'after_runtime_idle'
                    && resolveSessionPendingQueueDeliveryTiming(next.settings) === 'after_foreground_ready'
                ) {
                    onUpdate();
                }
            });

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
                this.pendingWakeSeq !== startPendingWakeSeq ||
                (
                    startPendingQueueDeliveryTiming === 'after_runtime_idle'
                    && resolveSessionPendingQueueDeliveryTiming(
                        getActiveAccountSettingsSnapshot()?.settings ?? null,
                    ) === 'after_foreground_ready'
                )
            ) {
                onUpdate();
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

    /**
     * Force a session snapshot sync from the server.
     *
     * This is useful when metadata/agentState may have been updated by another client (e.g. daemon RPC)
     * and this runner needs the latest snapshot before making turn decisions (e.g. replaySeedV1).
     */
    async refreshSessionSnapshotFromServerBestEffort(opts?: { reason?: 'connect' | 'waitForMetadataUpdate' }): Promise<void> {
        const reason = opts?.reason ?? 'waitForMetadataUpdate';
        await this.syncSessionSnapshotFromServer({ reason });
    }

    private async commitSessionMessage(
        params: {
            message: string | { t: 'plain'; v: unknown };
            localId: string;
            sidechainId: string | null;
            messageRole?: SessionMessageRole;
            sessionEventType?: 'ready';
            requireCommit: boolean;
            requireWriteDisposition?: boolean;
            markAsUserMessage?: boolean;
            retryToken?: SessionMessageCommitRetryToken;
        },
    ): Promise<SessionMessageCommitObservation | null> {
        const localId = params.localId;
        if (localId.length === 0) {
            if (params.requireCommit) {
                throw new Error('localId is required');
            }
            return null;
        }
        if (!this.socket.connected) {
            if (params.requireCommit) {
                throw new Error('Socket not connected');
            }
            this.queueSessionMessageUntilReconnect({
                message: params.message,
                localId,
                sidechainId: params.sidechainId,
                messageRole: params.messageRole,
                sessionEventType: params.sessionEventType,
                ...(params.retryToken ? { retryToken: params.retryToken } : {}),
            });
            return null;
        }
        const retryToken = params.retryToken ?? this.sessionMessageCommitRetry.beginIntent(localId, {
            message: params.message,
            sidechainId: params.sidechainId,
            ...(params.messageRole ? { messageRole: params.messageRole } : {}),
            ...(params.sessionEventType ? { sessionEventType: params.sessionEventType } : {}),
        });
        if (this.transcriptStorage === 'direct') {

            if (!params.requireCommit) {
                this.pendingMaterializedLocalIds.add(localId);
            }

            const ack = await (async () => {
                try {
                    const raw = await emitSocketWithAck({
                        socket: this.socket as any,
                        event: 'message',
                        payload: {
                            sid: this.sessionId,
                            message: params.message,
                            localId,
                            echoToSender: true,
                            sidechainId: params.sidechainId,
                            ...(params.messageRole ? { messageRole: params.messageRole } : {}),
                            ...(params.sessionEventType ? { sessionEventType: params.sessionEventType } : {}),
                        },
                    });

                    const parsed = MessageAckResponseSchema.safeParse(raw);
                    return parsed.success ? parsed.data : null;
                } catch (error) {
                    logger.debug('[SOCKET] Direct transcript commit ack failed', {
                        localId,
                        sidechainId: params.sidechainId,
                        requireCommit: params.requireCommit,
                        error: serializeAxiosErrorForLog(error),
                    });
                    return null;
                }
            })();

            if (ack && ack.ok === true) {
                if (params.requireWriteDisposition === true) {
                    if (ack.localId !== localId) {
                        this.sessionMessageCommitRetry.complete(retryToken);
                        throw new Error(`Exact message commit ACK localId mismatch for ${localId}`);
                    }
                    if (typeof ack.didWrite !== 'boolean') {
                        this.sessionMessageCommitRetry.complete(retryToken);
                        throw new Error(`Exact message commit ACK for ${localId} omitted didWrite`);
                    }
                }
                if (this.sessionMessageCommitRetry.complete(retryToken)) {
                    if (params.markAsUserMessage === true) {
                        this.markAgentQueueEchoSuppressedLocalId(ack.localId ?? localId);
                        this.markAgentQueueDeliveredLocalId(ack.localId ?? localId);
                    }
                    this.markCommittedLocalIdAwaitingEcho(localId);
                    this.lastObservedMessageSeq = Math.max(this.lastObservedMessageSeq, ack.seq);
                    if (params.markAsUserMessage === true) {
                        this.lastObservedUserMessageSeq = Math.max(this.lastObservedUserMessageSeq, ack.seq);
                        this.recordCommittedUserMessageSeq(ack.localId ?? localId, ack.seq);
                    }
                }
                return {
                    localId: ack.localId ?? localId,
                    messageId: ack.id,
                    seq: ack.seq,
                    didWrite: ack.didWrite ?? null,
                };
            }
            if (ack && ack.ok === false) {
                if (this.sessionMessageCommitRetry.complete(retryToken) && !params.requireCommit) {
                    this.deleteMaterializedLocalId(localId);
                }
                logger.debug('[SOCKET] Direct transcript commit rejected', {
                    localId,
                    sidechainId: params.sidechainId,
                    requireCommit: params.requireCommit,
                    error: ack.error,
                });
                throw new Error(ack.error);
            }
            if (!this.sessionMessageCommitRetry.readCurrent(retryToken)) return null;
            if (!params.requireCommit) {
                this.scheduleCommitRetry(retryToken);
                return null;
            }
            logger.debug('[SOCKET] Direct transcript commit was not confirmed', {
                localId,
                sidechainId: params.sidechainId,
                requireCommit: params.requireCommit,
            });
            this.sessionMessageCommitRetry.complete(retryToken);
            throw new Error('Message send not confirmed');
        }

        this.pendingMaterializedLocalIds.add(localId);
        const ack = await (async () => {
            try {
                const raw = await emitSocketWithAck({
                    socket: this.socket as any,
                    event: 'message',
                    payload: {
                        sid: this.sessionId,
                        message: params.message,
                        localId,
                        echoToSender: true,
                        sidechainId: params.sidechainId,
                        ...(params.messageRole ? { messageRole: params.messageRole } : {}),
                        ...(params.sessionEventType ? { sessionEventType: params.sessionEventType } : {}),
                    },
                });

                const parsed = MessageAckResponseSchema.safeParse(raw);
                return parsed.success ? parsed.data : null;
            } catch (error) {
                logger.debug('[SOCKET] Persisted transcript commit ack failed', {
                    localId,
                    sidechainId: params.sidechainId,
                    requireCommit: params.requireCommit,
                    error: serializeAxiosErrorForLog(error),
                });
                return null;
            }
        })();

        if (ack && ack.ok === true) {
            if (params.requireWriteDisposition === true) {
                if (ack.localId !== localId) {
                    this.sessionMessageCommitRetry.complete(retryToken);
                    throw new Error(`Exact message commit ACK localId mismatch for ${localId}`);
                }
                if (typeof ack.didWrite !== 'boolean') {
                    this.sessionMessageCommitRetry.complete(retryToken);
                    throw new Error(`Exact message commit ACK for ${localId} omitted didWrite`);
                }
            }
            if (this.sessionMessageCommitRetry.complete(retryToken)) {
                if (params.markAsUserMessage === true) {
                    this.markAgentQueueEchoSuppressedLocalId(ack.localId ?? localId);
                    this.markAgentQueueDeliveredLocalId(ack.localId ?? localId);
                }
                this.markCommittedLocalIdAwaitingEcho(localId);
                // ACK confirms persistence. Do not inject a synthetic update here: outbound sends are not prompts.
                this.lastObservedMessageSeq = Math.max(this.lastObservedMessageSeq, ack.seq);
                if (params.markAsUserMessage === true) {
                    this.lastObservedUserMessageSeq = Math.max(this.lastObservedUserMessageSeq, ack.seq);
                    this.recordCommittedUserMessageSeq(ack.localId ?? localId, ack.seq);
                }
            }
            return {
                localId: ack.localId ?? localId,
                messageId: ack.id,
                seq: ack.seq,
                didWrite: ack.didWrite ?? null,
            };
        }

        if (ack && ack.ok === false) {
            if (this.sessionMessageCommitRetry.complete(retryToken)) {
                this.deleteMaterializedLocalId(localId);
            }
            logger.debug('[SOCKET] Persisted transcript commit rejected', {
                localId,
                sidechainId: params.sidechainId,
                requireCommit: params.requireCommit,
                error: ack.error,
            });
            if (params.requireCommit) {
                throw new Error(ack.error);
            }
            return null;
        }

        if (!this.sessionMessageCommitRetry.readCurrent(retryToken)) return null;
        if (params.requireCommit) {
            if (params.requireWriteDisposition === true) {
                this.sessionMessageCommitRetry.complete(retryToken);
                throw new Error(`Exact message commit ACK for ${localId} did not provide durable didWrite disposition`);
            }
            const recovered = await this.recoverMaterializedLocalId(localId, { maxWaitMs: 12_000 });
            if (recovered.status === 'unsupported') {
                this.scheduleCommitRetry(retryToken);
                logger.debug('[SOCKET] Persisted transcript commit confirmation unsupported by server after ACK timeout', {
                    localId,
                    sidechainId: params.sidechainId,
                    requireCommit: params.requireCommit,
                    error: serializeAxiosErrorForLog(recovered.error),
                });
                throw new Error('Message commit confirmation unsupported by server (ACK timed out and transcript lookup route is unavailable)');
            }
            if (recovered.status !== 'recovered') {
                logger.debug('[SOCKET] Persisted transcript commit was not confirmed after ACK timeout and recovery miss', {
                    localId,
                    sidechainId: params.sidechainId,
                    requireCommit: params.requireCommit,
                });
                this.sessionMessageCommitRetry.complete(retryToken);
                throw new Error('Message commit not confirmed (ACK timed out and transcript recovery failed)');
            }
            this.sessionMessageCommitRetry.complete(retryToken);
            return null;
        }

        this.scheduleCommitRetry(retryToken);
        return null;
    }

    private enqueueMessageCommit<T>(
        delivery: 'best-effort' | 'required',
        context: SerializedWorkDiagnosticContext,
        fn: () => Promise<T>,
    ): Promise<T> {
        const tracked = this.messageCommitQueueDiagnostics.track(context);
        const laneTail = delivery === 'required'
            ? this.requiredMessageCommitQueueTail
            : this.bestEffortMessageCommitQueueTail;
        // Keep each class ordered and paced, but do not make a slow/lost best-effort ACK the
        // dispatch gate for required transcript and lifecycle commits. The relay remains the
        // canonical per-socket mutation-order owner when the two lanes meet.
        const dispatched = laneTail.then(
            () => tracked.run(fn),
            () => tracked.run(fn),
        );
        const settledLane = dispatched.then(
            () => undefined,
            () => undefined,
        );
        if (delivery === 'required') {
            this.requiredMessageCommitQueueTail = settledLane;
        } else {
            this.bestEffortMessageCommitQueueTail = settledLane;
        }
        // Retain every bounded ACK settlement for flush()/close() without coupling dispatch.
        this.messageCommitQueueTail = Promise.allSettled([
            this.messageCommitQueueTail,
            dispatched,
        ]).then(() => undefined);
        return dispatched;
    }

    private scheduleCommitRetry(retryToken: SessionMessageCommitRetryToken): void {
        if (!this.pendingMaterializedLocalIds.has(retryToken.localId)) return;
        const scheduled = this.sessionMessageCommitRetry.schedule(retryToken, (readyToken) => {
            void this.enqueueMessageCommit('best-effort', {
                operation: 'best-effort-retry',
                details: {
                    localId: readyToken.localId,
                    requireCommit: false,
                    connectionEpoch: this.userSocketSettingsConnectionEpoch,
                },
            }, async () => {
                const current = this.sessionMessageCommitRetry.readCurrent(readyToken);
                if (!current || !this.pendingMaterializedLocalIds.has(readyToken.localId)) return null;
                return await this.commitSessionMessage({
                    ...current.payload,
                    localId: readyToken.localId,
                    requireCommit: false,
                    retryToken: readyToken,
                });
            }).catch(() => {
                // Best-effort retry only.
            });
        });
        if (!scheduled) {
            this.sessionMessageCommitRetry.complete(retryToken);
        }
    }

    private encryptSessionContent(content: unknown): string {
        return encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content as any));
    }

    private buildOutboundSessionMessagePayload(content: unknown): string | { t: 'plain'; v: unknown } {
        if (this.sessionEncryptionMode === 'plain') {
            return { t: 'plain', v: content };
        }
        return this.encryptSessionContent(content);
    }

    private decodeStoredSessionMessageContent(content: SessionMessageContent): unknown {
        if (content.t === 'plain') return content.v;
        return decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(content.c));
    }

    private commitSessionMessageBestEffort(params: {
        message: string | { t: 'plain'; v: unknown };
        localId: string;
        sidechainId: string | null;
        messageRole?: SessionMessageRole;
        sessionEventType?: 'ready';
        logErrorMessage: string;
        markAsUserMessage?: boolean;
    }): void {
        void this.enqueueMessageCommit('best-effort', {
            operation: 'best-effort-commit',
            details: {
                localId: params.localId,
                messageRole: params.messageRole ?? null,
                sessionEventType: params.sessionEventType ?? null,
                requireCommit: false,
                connectionEpoch: this.userSocketSettingsConnectionEpoch,
            },
        }, () =>
            this.commitSessionMessage({
                message: params.message,
                localId: params.localId,
                sidechainId: params.sidechainId,
                messageRole: params.messageRole,
                sessionEventType: params.sessionEventType,
                requireCommit: false,
                markAsUserMessage: params.markAsUserMessage,
            }),
        ).catch((error) => {
            logger.debug(params.logErrorMessage, {
                localId: params.localId,
                error: serializeAxiosErrorForLog(error),
            });
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

    private buildPendingQueueUserTextMessageBody(params: {
        text: string;
        localId: string;
        meta: Record<string, unknown>;
        requestedAction: PendingRequestedActionV1;
    }): Parameters<typeof enqueuePendingQueueV2MessageViaHttp>[0]['body'] {
        const content = this.buildUserTextMessageContent(params.text, params.meta);
        const payload = this.buildOutboundSessionMessagePayload(content);
        if (typeof payload === 'string') {
            return {
                localId: params.localId,
                ciphertext: payload,
                messageRole: 'user',
                requestedAction: params.requestedAction,
            };
        }
        return {
            localId: params.localId,
            content: payload,
            messageRole: 'user',
            requestedAction: params.requestedAction,
        };
    }

    private async enqueueProviderAcceptedUserPrompt(params: {
        text: string;
        localId: string;
        meta: Record<string, unknown>;
        requestedAction: PendingRequestedActionV1;
    }): Promise<void> {
        const body = this.buildPendingQueueUserTextMessageBody(params);
        await this.persistPendingQueueUserMessageBody(body);

        // This RPC means "send now", but provider-acceptance sessions must still commit
        // through the pending claim/accept path. The direct materialize attempt keeps the
        // existing immediacy while leaving the row durable if the runtime cannot accept it yet.
        if (!await this.reconcileCanonicalPendingDeliveriesBeforeMaterialization()) return;
        await this.runMaterializeNextPendingMessageInner();
    }

    private async persistPendingQueueUserMessageBody(
        body: Parameters<typeof enqueuePendingQueueV2MessageViaHttp>[0]['body'],
    ): Promise<Awaited<ReturnType<typeof enqueuePendingQueueV2MessageViaHttp>>> {
        const request = () => enqueuePendingQueueV2MessageViaHttp({
            token: this.token,
            sessionId: this.sessionId,
            body,
        });
        const supervisor = this.sessionConnectionSupervisor;
        return supervisor
            ? await runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request,
            })
            : await request();
    }

    private prepareClaudeSessionMessage(body: RawJSONLines, meta?: Record<string, unknown>): {
        content: MessageContent;
        localId: string;
        sidechainId: string | null;
    } {
        this.outboundShapeLogger.log('claude:raw-jsonl', body);

        const sidechainId = (() => {
            const raw = (body as any)?.sidechainId;
            return readNonBlankOpaqueIdentifier(raw);
        })();

        let content: MessageContent;

        // Check if body is already a MessageContent (has role property)
        if (
            body.type === 'user' &&
            typeof body.message.content === 'string' &&
            body.isSidechain !== true &&
            body.isMeta !== true
        ) {
            content = this.buildUserTextMessageContent(body.message.content, meta);
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
                    ...(meta && typeof meta === 'object' ? meta : {}),
                }
            };
        }

        this.outboundShapeLogger.log('claude:session-content', content);
        logger.debugLargeJson('[SOCKET] Sending message through socket:', content)

        return {
            content,
            localId: buildClaudeJsonlLocalId(body),
            sidechainId,
        };
    }

    private applyClaudeSessionMessageAuxiliaryEffects(body: RawJSONLines): void {
        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message?.usage) {
            try {
                this.sendUsageData(body.message.usage, body.message.model);
            } catch (error) {
                logger.debug('[SOCKET] Failed to send usage data:', serializeAxiosErrorForLog(error));
            }
        }

        // Update metadata with summary if this is a summary message
        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            updateMetadataBestEffort(
                this,
                (metadata) => ({
                    ...metadata,
                    summary: {
                        text: body.summary,
                        updatedAt: Date.now()
                    }
                }),
                '[SOCKET]',
                'summary_message',
            );
        }
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendClaudeSessionMessage(body: RawJSONLines, meta?: Record<string, unknown>) {
        if (isToolTraceEnabled()) {
            recordClaudeToolTraceEvents({ sessionId: this.sessionId, body });
        }
        const { content, localId, sidechainId } = this.prepareClaudeSessionMessage(body, meta);

        this.logSendWhileDisconnected('Claude session message', { type: body.type });

        const payload = this.buildOutboundSessionMessagePayload(content);
        this.observeTurnAssistantTextFromSessionContent(content, {
            source: 'ephemeral',
            localId,
            sidechainId,
            provider: 'claude',
        });
        this.commitSessionMessageBestEffort({
            message: payload,
            localId,
            sidechainId,
            messageRole: resolveClaudeSessionMessageRole(body),
            logErrorMessage: '[SOCKET] Failed to commit Claude session message (non-fatal)',
        });

        this.applyClaudeSessionMessageAuxiliaryEffects(body);
    }

    async sendClaudeSessionMessageCommitted(
        body: RawJSONLines,
        opts: Readonly<{
            createdAt: number;
            updatedAt?: number;
            provenance: SessionTranscriptObservationProvenanceV1;
            meta?: Record<string, unknown>;
        }>,
    ): Promise<Readonly<{ persisted: boolean; delivered: boolean }>> {
        const { content, localId, sidechainId } = this.prepareClaudeSessionMessage(body, opts.meta);
        requireExactCommitLocalId(localId);

        this.logSendWhileDisconnected('Claude session message', { type: body.type });
        return await this.sessionMutationOutbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: this.sessionId,
            localId,
            content: this.buildOutboundSessionMessagePayload(content),
            sidechainId,
            messageRole: resolveClaudeSessionMessageRole(body),
            createdAt: opts.createdAt,
            updatedAt: opts.updatedAt ?? opts.createdAt,
            provenance: opts.provenance,
        }));
    }

    recordClaudeJsonlMessageConsumed(body: RawJSONLines, meta?: Record<string, unknown>): void {
        const key = buildClaudeJsonlMessageKey(body);
        if (!key) return;
        const sidechainId = readNonBlankOpaqueIdentifier((body as Record<string, unknown>).sidechainId);
        const content = {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'progress',
                    marker: 'claude_jsonl_consumed_marker',
                    reason: 'prompt_echo_suppressed',
                },
            },
            meta: {
                sentFrom: 'cli',
                source: 'cli',
                happier: { kind: 'claude_jsonl_consumed_marker.v1' },
                ...(meta && typeof meta === 'object' ? meta : {}),
            },
        };

        this.commitSessionMessageBestEffort({
            message: this.buildOutboundSessionMessagePayload(content),
            localId: buildClaudeJsonlLocalIdFromMessageKey(key),
            sidechainId,
            messageRole: 'event',
            logErrorMessage: '[SOCKET] Failed to commit Claude JSONL consumed marker (non-fatal)',
        });
    }

    private prepareCodexMessage(body: any) {
        const normalizedBody = normalizeCodexSessionMessageBody({
            body,
            toolCallCanonicalNameByProviderAndId: this.toolCallCanonicalNameByProviderAndId,
            maxToolCallCacheEntries: SESSION_CLIENT_TOOL_CALL_CACHE_MAX_ENTRIES,
            debug: (message, data) => logger.debug(message, data),
        });

        const content = {
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

        return { normalizedBody, content };
    }

    sendCodexMessage(body: any) {
        const { normalizedBody, content } = this.prepareCodexMessage(body);

        recordCodexToolTraceEventIfNeeded({ sessionId: this.sessionId, body: normalizedBody });
        
        this.logSendWhileDisconnected('Codex message', { type: normalizedBody?.type });

        const payload = this.buildOutboundSessionMessagePayload(content);
        const localId = randomUUID();
        this.observeTurnAssistantTextFromSessionContent(content, {
            source: 'ephemeral',
            localId,
            sidechainId: null,
            provider: 'codex',
        });
        this.commitSessionMessageBestEffort({
            message: payload,
            localId,
            sidechainId: null,
            messageRole: resolveCodexSessionMessageRole(normalizedBody),
            logErrorMessage: '[SOCKET] Failed to commit Codex message (non-fatal)',
        });

        // Best-effort: allow ACP providers to report token usage via a token_count message.
        if (normalizedBody?.type === 'token_count') {
            try {
                const report = buildUsageReportFromAcpTokenCount({
                    provider: 'codex',
                    sessionId: this.sessionId,
                    body: normalizedBody,
                });
                if (report && this.socket.connected) {
                    this.socket.emit('usage-report', report);
            }
            } catch (error) {
                logger.debug('[SOCKET] Failed to send token_count usage report (non-fatal)', serializeAxiosErrorForLog(error));
            }
        }
    }

    async sendCodexMessageCommitted(
        body: any,
        opts: { localId: string },
    ): Promise<SessionMessageCommitResult> {
        const localId = requireExactCommitLocalId(opts?.localId);
        const { normalizedBody, content } = this.prepareCodexMessage(body);

        recordCodexToolTraceEventIfNeeded({ sessionId: this.sessionId, body: normalizedBody });
        this.logSendWhileDisconnected('Codex message', { type: normalizedBody?.type });

        const result = requireExactCommitResult(await this.enqueueMessageCommit('required', {
            operation: 'codex-message-commit',
            details: {
                localId,
                messageType: typeof normalizedBody?.type === 'string' ? normalizedBody.type : null,
                requireCommit: true,
                connectionEpoch: this.userSocketSettingsConnectionEpoch,
            },
        }, () =>
            this.commitSessionMessage({
                message: this.buildOutboundSessionMessagePayload(content),
                localId,
                sidechainId: null,
                messageRole: resolveCodexSessionMessageRole(normalizedBody),
                requireCommit: true,
                requireWriteDisposition: true,
            }),
        ), localId);
        this.observeTurnAssistantTextFromSessionContent(content, {
            source: 'committed',
            seq: result.seq,
            localId,
            sidechainId: null,
            provider: 'codex',
        });
        return result;
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
        sidechainId: string | null;
    } {
        const normalizedBody = normalizeAcpSessionMessageBody({
            provider: params.provider,
            body: params.body,
            toolCallCanonicalNameByProviderAndId: this.toolCallCanonicalNameByProviderAndId,
            permissionToolCallRawInputByProviderAndId: this.permissionToolCallRawInputByProviderAndId,
            toolCallInputByProviderAndId: this.toolCallInputByProviderAndId,
            maxToolCallCacheEntries: SESSION_CLIENT_TOOL_CALL_CACHE_MAX_ENTRIES,
        });
        if (params.localId !== undefined && readPendingLocalId(params.localId) === null) {
            throw new Error('Pending localId must not be blank');
        }
        const localId = readPendingLocalId(params.localId) ?? randomUUID();
        const sidechainId = (() => {
            const raw = normalizedBody.sidechainId;
            return readNonBlankOpaqueIdentifier(raw);
        })();
        const content = buildAcpAgentMessageEnvelope({
            provider: params.provider,
            body: normalizedBody,
            meta: params.meta,
        });
        return { normalizedBody, content, localId, sidechainId };
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
        const lifecycleMarker = observeAcpLifecycleMarker({
            lifecycle: this.sessionTurnLifecycle,
            provider,
            body,
        });
        if (lifecycleMarker.pendingWrite) {
            this.trackSessionTurnWrite(
                lifecycleMarker.pendingWrite,
                lifecycleMarker.body.type === 'task_started'
                    ? { latestTurnStatus: 'in_progress' }
                    : {},
            );
        }
        const { normalizedBody, content, localId, sidechainId } = this.prepareAcpAgentMessage({
            provider,
            body: lifecycleMarker.body,
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

        this.outboundShapeLogger.log(`acp:${provider}:${normalizedBody.type}`, normalizedBody);
        
        logger.debug(`[SOCKET] Sending ACP message from ${provider}:`, { type: normalizedBody.type, hasMessage: 'message' in normalizedBody });
        this.logSendWhileDisconnected(`${provider} ACP message`, { type: normalizedBody.type });
        const payload = this.buildOutboundSessionMessagePayload(content);
        this.observeTurnAssistantTextFromSessionContent(content, {
            source: 'ephemeral',
            localId,
            sidechainId,
            provider,
        });
        this.commitSessionMessageBestEffort({
            message: payload,
            localId,
            sidechainId,
            messageRole: resolveAcpSessionMessageRole(normalizedBody),
            logErrorMessage: '[SOCKET] Failed to commit agent message (non-fatal)',
        });

        // Best-effort: allow ACP providers to report token usage via a token_count message.
        if (normalizedBody.type === 'token_count') {
            try {
                const report = buildUsageReportFromAcpTokenCount({
                    provider,
                    sessionId: this.sessionId,
                    body: normalizedBody,
                });
                if (report && this.socket.connected) {
                    this.socket.emit('usage-report', report);
            }
            } catch (error) {
                logger.debug('[SOCKET] Failed to send token_count usage report (non-fatal)', serializeAxiosErrorForLog(error));
            }
        }
    }

    sendAgentMessageEphemeral(
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown>; tick?: number },
    ): EphemeralSendOutcome {
        if (!this.socket.connected) {
            return createDisconnectedEphemeralSendOutcome(this.sessionConnectionEpoch);
        }
        try {
            const { normalizedBody, content, localId, sidechainId } = this.prepareAcpAgentMessage({
                provider,
                body,
                meta: opts.meta,
                localId: opts.localId,
            });
            const payload = this.buildOutboundSessionMessagePayload(content);
            const createdAt =
                typeof opts.createdAt === 'number' && Number.isFinite(opts.createdAt)
                    ? Math.max(0, Math.trunc(opts.createdAt))
                    : Date.now();
            const streamSegmentMeta = opts.meta?.happierStreamSegmentV1;
            const metaUpdatedAt =
                streamSegmentMeta
                && typeof streamSegmentMeta === 'object'
                && typeof (streamSegmentMeta as Record<string, unknown>).updatedAtMs === 'number'
                && Number.isFinite((streamSegmentMeta as Record<string, unknown>).updatedAtMs)
                    ? Math.trunc((streamSegmentMeta as Record<string, unknown>).updatedAtMs as number)
                    : undefined;
            const updatedAt =
                typeof opts.updatedAt === 'number' && Number.isFinite(opts.updatedAt)
                    ? Math.max(createdAt, Math.trunc(opts.updatedAt))
                    : typeof metaUpdatedAt === 'number'
                        ? Math.max(createdAt, metaUpdatedAt)
                        : Math.max(createdAt, Date.now());
            this.observeTurnAssistantTextFromSessionContent(content, {
                source: 'ephemeral',
                localId,
                sidechainId,
                provider,
                observedAtMs: updatedAt,
            });
            if (!this.socket.connected) {
                return createDisconnectedEphemeralSendOutcome(this.sessionConnectionEpoch);
            }
            this.socket.emit('transcript-stream-segment', {
                sid: this.sessionId,
                message: {
                    localId,
                    messageRole: resolveAcpSessionMessageRole(normalizedBody),
                    ...(sidechainId ? { sidechainId } : {}),
                    ...(typeof opts.tick === 'number' && Number.isFinite(opts.tick) && opts.tick >= 0
                        ? { tick: Math.trunc(opts.tick) }
                        : {}),
                    content: payload,
                    createdAt,
                    updatedAt,
                },
            });
            return { accepted: true, epoch: this.sessionConnectionEpoch };
        } catch (error) {
            return {
                accepted: false,
                epoch: this.sessionConnectionEpoch,
                reason: {
                    code: 'local_failure',
                    error: serializeOutboundError(error),
                },
            };
        }
    }

    /**
     * Emit a live transcript delta tick: `body` carries ONLY the text appended since the previous
     * live emission for this segment. Full-snapshot checkpoints still flow through
     * `sendAgentMessageEphemeral`; receivers that cannot chain a delta drop it and resync on the
     * next checkpoint. The delta content goes through the same envelope/encryption choke point as
     * snapshots (`prepareAcpAgentMessage` + `buildOutboundSessionMessagePayload`).
     */
    sendAgentMessageEphemeralDelta(
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; tick: number; baseLength: number; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> },
    ): EphemeralSendOutcome {
        if (!this.socket.connected) {
            return createDisconnectedEphemeralSendOutcome(this.sessionConnectionEpoch);
        }
        try {
            const { normalizedBody, content, localId, sidechainId } = this.prepareAcpAgentMessage({
                provider,
                body,
                meta: opts.meta,
                localId: opts.localId,
            });
            const payload = this.buildOutboundSessionMessagePayload(content);
            const createdAt =
                typeof opts.createdAt === 'number' && Number.isFinite(opts.createdAt)
                    ? Math.max(0, Math.trunc(opts.createdAt))
                    : Date.now();
            const updatedAt =
                typeof opts.updatedAt === 'number' && Number.isFinite(opts.updatedAt)
                    ? Math.max(createdAt, Math.trunc(opts.updatedAt))
                    : Math.max(createdAt, Date.now());

            // Intentionally no observeTurnAssistantTextFromSessionContent here: delta bodies carry
            // only appended chars. Periodic full checkpoints keep the turn snapshot fresh.
            if (!this.socket.connected) {
                return createDisconnectedEphemeralSendOutcome(this.sessionConnectionEpoch);
            }
            this.socket.emit('transcript-stream-segment-delta', {
                sid: this.sessionId,
                message: {
                    localId,
                    messageRole: resolveAcpSessionMessageRole(normalizedBody),
                    ...(sidechainId ? { sidechainId } : {}),
                    tick: Math.max(1, Math.trunc(opts.tick)),
                    baseLength: Math.max(0, Math.trunc(opts.baseLength)),
                    content: payload,
                    createdAt,
                    updatedAt,
                },
            });
            return { accepted: true, epoch: this.sessionConnectionEpoch };
        } catch (error) {
            return {
                accepted: false,
                epoch: this.sessionConnectionEpoch,
                reason: {
                    code: 'local_failure',
                    error: serializeOutboundError(error),
                },
            };
        }
    }

    getEphemeralStreamConnectionEpoch(): number {
        return this.sessionConnectionEpoch;
    }

    sendUserTextMessage(text: string, opts?: { localId?: string; meta?: Record<string, unknown> }) {
        const content = this.buildUserTextMessageContent(text, opts?.meta);

        this.logSendWhileDisconnected('User text message', { length: text.length });
        const payload = this.buildOutboundSessionMessagePayload(content);
        const localId = typeof opts?.localId === 'string' && opts.localId.length > 0 ? opts.localId : randomUUID();
        const meta = opts?.meta ?? null;
        const metaSource = typeof (meta as any)?.source === 'string' ? String((meta as any).source) : null;
        const metaSentFrom = typeof (meta as any)?.sentFrom === 'string' ? String((meta as any).sentFrom) : null;
        const shouldSuppressAgentQueueEcho =
            metaSource === 'cli'
            || metaSentFrom === 'cli';
        if (shouldSuppressAgentQueueEcho) {
            // Prevent our own CLI-originating outbound user messages from being treated as inbound prompts
            // if/when the server echoes the transcript update back to this runner.
            this.markAgentQueueEchoSuppressedLocalId(localId);
        }
        this.commitSessionMessageBestEffort({
            message: payload,
            localId,
            sidechainId: null,
            messageRole: 'user',
            markAsUserMessage: true,
            logErrorMessage: '[SOCKET] Failed to commit user message (non-fatal)',
        });
    }

    async sendUserTextMessageCommitted(
        text: string,
        opts: { localId: string; meta?: Record<string, unknown>; provenance?: SessionTranscriptObservationProvenanceV1 },
    ): Promise<void> {
        const content = this.buildUserTextMessageContent(text, opts.meta);
        const payload = this.buildOutboundSessionMessagePayload(content);
        await this.enqueueMessageCommit('required', {
            operation: 'user-message-commit',
            details: {
                localId: opts.localId,
                requireCommit: true,
                connectionEpoch: this.userSocketSettingsConnectionEpoch,
            },
        }, () =>
            this.commitSessionMessage({
                message: payload,
                localId: opts.localId,
                sidechainId: null,
                messageRole: 'user',
                requireCommit: true,
                markAsUserMessage: true,
            }),
        );
    }

    private async notifyDaemonConnectedServiceTurnLifecycle(
        event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled',
        terminalStatus?: 'completed' | 'failed',
        turnId?: string,
        requestedAction?: PendingRequestedActionV1,
    ): Promise<ConnectedServiceTurnLifecycleResult | null> {
        if (!this.startedByDaemonProcess) return null;
        let lifecycleResult: ConnectedServiceTurnLifecycleResult | null = null;
        const notify = async (): Promise<void> => {
            try {
                const result = await notifyDaemonConnectedServiceTurnLifecycle({
                    sessionId: this.sessionId,
                    event,
                    ...(terminalStatus ? { terminalStatus } : {}),
                    ...(turnId ? { turnId } : {}),
                    ...(requestedAction
                        ? {
                            requestedAction,
                            // Sample runner-local custody inside the serialized operation,
                            // immediately before the predecessor daemon boundary.
                            activeTurnId: this.sessionTurnLifecycle.getActiveTurnId(),
                        }
                        : {}),
                });
                const parsedResult = ConnectedServiceTurnLifecycleResultSchema.safeParse(result);
                if (parsedResult.success) {
                    lifecycleResult = parsedResult.data;
                    return;
                }
                const resultError =
                    result
                    && typeof result === 'object'
                    && 'error' in result
                    && typeof result.error === 'string'
                        ? result.error
                        : 'connected_service_turn_lifecycle_invalid_response';
                if (resultError) {
                    logger.debug('[SESSION CLIENT] Failed to notify daemon connected-service turn lifecycle (non-fatal)', {
                        sessionId: this.sessionId,
                        event,
                        error: resultError,
                    });
                }
            } catch (error) {
                logger.debug('[SESSION CLIENT] Connected-service turn lifecycle notify threw (non-fatal)', {
                    sessionId: this.sessionId,
                    event,
                    error: serializeAxiosErrorForLog(error),
                });
            }
        };
        const pending = this.daemonTurnLifecycleNotifyTail.then(notify, notify);
        this.daemonTurnLifecycleNotifyTail = pending;
        await pending;
        return lifecycleResult;
    }

    async enqueueSessionUserMessage(params: Readonly<{
        text: string;
        localId?: string;
        meta?: Record<string, unknown>;
        requestedAction?: PendingRequestedActionV1;
    }>): Promise<Readonly<{
        providerAcceptancePending?: boolean;
        recoveryBlocked?: Exclude<ExplicitUserRecoveryDecision, Readonly<{ status: 'ready' }>>;
    }> | void> {
        const text = String(params.text ?? '');
        if (text.length === 0) return;
        if (params.localId !== undefined && readPendingLocalId(params.localId) === null) {
            throw new Error('Pending localId must not be blank');
        }
        const localId = readPendingLocalId(params.localId) ?? randomUUID();

        const rawMeta: Record<string, unknown> = params.meta && typeof params.meta === 'object' ? { ...params.meta } : {};
        const normalizedPayload = normalizeAgentPromptPayload({ text, meta: rawMeta });
        const meta: Record<string, unknown> = normalizedPayload.meta && typeof normalizedPayload.meta === 'object'
            ? { ...normalizedPayload.meta }
            : {};
        if (typeof meta.source !== 'string' || meta.source.trim().length === 0) {
            meta.source = 'ui';
        }
        if (typeof meta.sentFrom !== 'string' || meta.sentFrom.trim().length === 0) {
            meta.sentFrom = 'ui';
        }

        const recoveryDecision = await this.revalidateUsageLimitRecoveryForExplicitUserPrompt(localId);
        if (recoveryDecision.status !== 'ready') {
            return { recoveryBlocked: recoveryDecision };
        }

        const providerAcceptancePending = this.isCurrentPendingInputServerContract();
        await this.enqueueProviderAcceptedUserPrompt({
            text,
            localId,
            meta,
            requestedAction: params.requestedAction ?? { v: 1, kind: 'enqueue' },
        });
        if (providerAcceptancePending) {
            return { providerAcceptancePending: true };
        }
    }

    async enqueueAgentMessageCommitted(
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown>; provenance: SessionTranscriptObservationProvenanceV1 },
    ): Promise<Readonly<{ persisted: boolean; delivered: boolean }>> {
        const { normalizedBody, content, localId, sidechainId } = this.prepareAcpAgentMessage({
            provider,
            body,
            meta: opts?.meta,
            localId: opts.localId,
        });

        if (shouldTraceAcpMessageType(normalizedBody.type)) {
            recordAcpToolTraceEventIfNeeded({ sessionId: this.sessionId, provider, body: normalizedBody, localId });
        }

        const payload = this.buildOutboundSessionMessagePayload(content);
        const streamSegmentMeta = opts.meta?.happierStreamSegmentV1;
        const metaRecord = streamSegmentMeta && typeof streamSegmentMeta === 'object'
            ? streamSegmentMeta as Record<string, unknown>
            : null;
        const createdAt =
            metaRecord && typeof metaRecord.startedAtMs === 'number' && Number.isFinite(metaRecord.startedAtMs)
                ? Math.max(0, Math.trunc(metaRecord.startedAtMs))
                : Date.now();
        const updatedAt =
            metaRecord && typeof metaRecord.updatedAtMs === 'number' && Number.isFinite(metaRecord.updatedAtMs)
                ? Math.max(createdAt, Math.trunc(metaRecord.updatedAtMs))
                : createdAt;
        const provenance = SessionTranscriptObservationProvenanceV1Schema.parse(opts.provenance);
        const result = await this.sessionMutationOutbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
            sessionId: this.sessionId,
            localId,
            content: payload,
            sidechainId,
            messageRole: resolveAcpSessionMessageRole(normalizedBody),
            createdAt,
            updatedAt,
            provenance,
        }));
        if (result.delivered) {
            this.observeTurnAssistantTextFromSessionContent(content, {
                source: 'committed',
                localId,
                sidechainId,
                provider,
            });
        }
        return result;
    }

    async sendAgentMessageCommitted(
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown> },
    ): Promise<void> {
        const { normalizedBody, content, localId, sidechainId } = this.prepareAcpAgentMessage({
            provider,
            body,
            meta: opts?.meta,
            localId: opts.localId,
        });

        if (shouldTraceAcpMessageType(normalizedBody.type)) {
            recordAcpToolTraceEventIfNeeded({ sessionId: this.sessionId, provider, body: normalizedBody, localId });
        }

        const payload = this.buildOutboundSessionMessagePayload(content);
        const commitResult = await this.enqueueMessageCommit('required', {
            operation: 'agent-message-commit',
            details: {
                localId,
                provider,
                messageType: normalizedBody.type,
                requireCommit: true,
                connectionEpoch: this.userSocketSettingsConnectionEpoch,
            },
        }, () =>
            this.commitSessionMessage({ message: payload, localId, sidechainId, messageRole: resolveAcpSessionMessageRole(normalizedBody), requireCommit: true }),
        );
        this.observeTurnAssistantTextFromSessionContent(content, {
            source: 'committed',
            seq: commitResult?.seq ?? null,
            localId,
            sidechainId,
            provider,
        });
    }

    async sendAgentMessageCommittedExact(
        provider: ACPProvider,
        body: ACPMessageData,
        opts: { localId: string; meta?: Record<string, unknown> },
    ): Promise<SessionMessageCommitResult> {
        const requestedLocalId = requireExactCommitLocalId(opts?.localId);
        const { normalizedBody, content, localId, sidechainId } = this.prepareAcpAgentMessage({
            provider,
            body,
            meta: opts?.meta,
            localId: requestedLocalId,
        });

        if (shouldTraceAcpMessageType(normalizedBody.type)) {
            recordAcpToolTraceEventIfNeeded({ sessionId: this.sessionId, provider, body: normalizedBody, localId });
        }

        const result = requireExactCommitResult(await this.enqueueMessageCommit('required', {
            operation: 'agent-message-exact-commit',
            details: {
                localId,
                provider,
                messageType: normalizedBody.type,
                requireCommit: true,
                connectionEpoch: this.userSocketSettingsConnectionEpoch,
            },
        }, () =>
            this.commitSessionMessage({
                message: this.buildOutboundSessionMessagePayload(content),
                localId,
                sidechainId,
                messageRole: resolveAcpSessionMessageRole(normalizedBody),
                requireCommit: true,
                requireWriteDisposition: true,
            }),
        ), localId);
        this.observeTurnAssistantTextFromSessionContent(content, {
            source: 'committed',
            seq: result.seq,
            localId,
            sidechainId,
            provider,
        });
        return result;
    }

    async fetchRecentTranscriptTextItemsForAcpImport(opts?: { take?: number }): Promise<Array<{ role: 'user' | 'agent'; text: string }>> {
        const request = () => fetchRecentTranscriptTextItemsForAcpImportFromServer({
            token: this.token,
            sessionId: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            take: opts?.take,
        });
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            return request();
        }
        return runSupervisedRequest({
            supervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        });
    }

    async fetchCommittedClaudeJsonlMessageBaseline(opts?: { take?: number }): Promise<CommittedClaudeJsonlMessageBaseline> {
        const take = typeof opts?.take === 'number' && Number.isFinite(opts.take) && opts.take > 0
            ? Math.trunc(opts.take)
            : 5_000;
        const request = async (): Promise<CommittedClaudeJsonlMessageBaseline> => {
            const keys = new Set<string>();
            let remaining = take;
            let beforeSeq: number | undefined;
            let complete = true;
            let oldestCoveredAtMs: number | null = null;
            const observeRowCoverage = (createdAt: unknown): void => {
                const createdAtMs = typeof createdAt === 'number' && Number.isFinite(createdAt)
                    ? createdAt
                    : typeof createdAt === 'string'
                        ? Date.parse(createdAt)
                        : Number.NaN;
                if (!Number.isFinite(createdAtMs)) return;
                if (oldestCoveredAtMs === null || createdAtMs < oldestCoveredAtMs) {
                    oldestCoveredAtMs = createdAtMs;
                }
            };
            while (remaining > 0) {
                const page = await fetchEncryptedTranscriptMessagesPage({
                    token: this.token,
                    sessionId: this.sessionId,
                    limit: Math.min(500, remaining),
                    ...(typeof beforeSeq === 'number' ? { beforeSeq } : {}),
                    scope: 'all',
                    roles: ['user', 'agent', 'event'],
                });
                for (const row of page.messages) {
                    observeRowCoverage(row.createdAt);
                    const keyFromLocalId = typeof row.localId === 'string'
                        ? extractClaudeJsonlMessageKeyFromLocalId(row.localId)
                        : null;
                    if (keyFromLocalId) {
                        keys.add(keyFromLocalId);
                        continue;
                    }
                    const parsedContent = SessionMessageContentSchema.safeParse(row.content);
                    if (!parsedContent.success) continue;
                    try {
                        const decoded = this.decodeStoredSessionMessageContent(parsedContent.data);
                        const keyFromContent = extractClaudeJsonlMessageKeyFromSessionContent(decoded);
                        if (keyFromContent) keys.add(keyFromContent);
                    } catch (error) {
                        logger.debug('[API] Failed to decode committed Claude transcript row for resume dedupe', {
                            seq: row.seq,
                            error: serializeAxiosErrorForLog(error),
                        });
                    }
                }
                remaining -= page.messages.length;
                if (!page.hasMore || page.nextBeforeSeq === null || page.messages.length === 0) break;
                if (remaining <= 0) {
                    // The take budget ran out while the server still had older rows: the baseline
                    // window is PARTIAL, and rows older than `oldestCoveredAtMs` cannot be proven
                    // uncommitted (Lane N4).
                    complete = false;
                    break;
                }
                beforeSeq = page.nextBeforeSeq;
            }
            return { keys, complete, oldestCoveredAtMs };
        };
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            return request();
        }
        return runSupervisedRequest({
            supervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        });
    }

    async fetchLatestUserPermissionIntentFromTranscript(opts?: { take?: number }): Promise<{ intent: import('../types').PermissionMode; updatedAt: number } | null> {
        const request = () => fetchLatestUserPermissionIntentFromEncryptedTranscript({
            token: this.token,
            sessionId: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            sessionEncryptionMode: this.sessionEncryptionMode,
            take: opts?.take,
        });
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            return request();
        }
        return runSupervisedRequest({
            supervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        });
    }

    private buildSessionEventContent(event: SessionEventMessage, id: string) {
        return {
            role: 'agent',
            content: {
                id,
                type: 'event',
                data: event
            }
        };
    }

    sendSessionEvent(event: SessionEventMessage, id?: string) {
        const content = this.buildSessionEventContent(event, id ?? randomUUID());

        this.logSendWhileDisconnected('session event', { eventType: event.type });

        const payload = this.buildOutboundSessionMessagePayload(content);
        // A caller-supplied event id is also the transcript insertion identity,
        // making retry delivery idempotent at the existing message boundary.
        const localId = id ?? randomUUID();
        this.commitSessionMessageBestEffort({
            message: payload,
            localId,
            sidechainId: null,
            messageRole: resolveSessionEventMessageRole(),
            sessionEventType: event.type === 'ready' ? 'ready' : undefined,
            logErrorMessage: '[SOCKET] Failed to commit session event (non-fatal)',
        });
    }

    async sendSessionEventCommitted(
        event: SessionEventMessage,
        opts: { localId: string },
    ): Promise<SessionMessageCommitResult> {
        const localId = requireExactCommitLocalId(opts?.localId);
        const content = this.buildSessionEventContent(event, localId);

        this.logSendWhileDisconnected('session event', { eventType: event.type });

        return requireExactCommitResult(await this.enqueueMessageCommit('required', {
            operation: 'session-event-commit',
            details: {
                localId,
                eventType: event.type,
                requireCommit: true,
                connectionEpoch: this.userSocketSettingsConnectionEpoch,
            },
        }, () =>
            this.commitSessionMessage({
                message: this.buildOutboundSessionMessagePayload(content),
                localId,
                sidechainId: null,
                messageRole: resolveSessionEventMessageRole(),
                sessionEventType: event.type === 'ready' ? 'ready' : undefined,
                requireCommit: true,
                requireWriteDisposition: true,
            }),
        ), localId);
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: SessionAliveMode) {
        if (process.env.DEBUG) { // too verbose for production
            logger.debug(`[API] Sending keep alive message: ${thinking}`);
        }
        const effectiveThinking = this.resolveKeepAliveThinkingWithTerminalGuard(thinking, Date.now());
        this.latestSessionPresence = { thinking: effectiveThinking, mode };
        const payload = this.createSessionAlivePayload(this.latestSessionPresence);

        if (effectiveThinking) {
            void this.sessionTurnLifecycle.touchActiveTurn({ observedAt: payload.time }).catch((error) => {
                logger.debug('[API] Failed to touch active session turn from keepalive (non-fatal)', {
                    error: serializeAxiosErrorForLog(error),
                });
            });
        }

        // Presence remains reliable for an open canonical turn even when the provider's foreground
        // thinking projection is idle (for example while Codex subagents/background work continue).
        // This changes only transport reliability: the original thinking value stays authoritative.
        this.emitSessionAlive(payload, { volatileWhenIdle: true });
    }

    /**
     * Enforce the invariant that a terminal turn status wins over a latched `thinking=true`
     * keepalive. If a runtime path ever fails to reset `thinking` after the turn terminated,
     * the 2s keepalive would republish thinking=true with fresh timestamps forever — the
     * "stuck working/online" signature. This bounds that: a terminal-status-with-latched-thinking
     * that persists past the guard window self-heals to idle (one-shot telemetry). A short window
     * is tolerated because a fresh turn flips `thinking` before its status update lands.
     */
    private resolveKeepAliveThinkingWithTerminalGuard(thinking: boolean, nowMs: number): boolean {
        if (!thinking) {
            this.thinkingLatchTerminalSinceMs = null;
            this.reportedStuckThinkingSelfHeal = false;
            return false;
        }
        if (
            this.latestTurnStatus === undefined
            || isActiveLatestTurnStatus(this.latestTurnStatus)
            || (
                this.sessionTurnLifecycle.hasActiveTurn()
                && !this.hasStaleLocalActiveTurnWithoutProgress(nowMs)
            )
        ) {
            this.thinkingLatchTerminalSinceMs = null;
            return true;
        }
        if (this.thinkingLatchTerminalSinceMs === null) {
            this.thinkingLatchTerminalSinceMs = nowMs;
            return true;
        }
        const latchedForMs = nowMs - this.thinkingLatchTerminalSinceMs;
        if (latchedForMs < STUCK_THINKING_TERMINAL_KEEPALIVE_GUARD_MS) {
            return true;
        }
        if (!this.reportedStuckThinkingSelfHeal) {
            this.reportedStuckThinkingSelfHeal = true;
            logger.info('[API] Self-healing stuck thinking keepalive: latched thinking against a terminal turn status', {
                sid: this.sessionId,
                latestTurnStatus: this.latestTurnStatus ?? null,
                latchedForMs,
            });
        }
        return false;
    }

    private createSessionAlivePayload(presence: SessionPresenceSnapshot): SessionAlivePayload {
        const payload: SessionAlivePayload = {
            sid: this.sessionId,
            time: Date.now(),
            thinking: presence.thinking,
            mode: presence.mode,
        };
        if (this.latestTurnStatus !== undefined && this.latestTurnStatus !== null) {
            return {
                ...payload,
                latestTurnStatus: this.latestTurnStatus,
                latestTurnStatusObservedAt: this.latestTurnStatusObservedAtMs ?? payload.time,
            };
        }
        return payload;
    }

    private emitSessionAlive(
        payload: SessionAlivePayload,
        options: Readonly<{ volatileWhenIdle: boolean }>,
    ): boolean {
        if ((this.socket as Socket<ServerToClientEvents, ClientToServerEvents> | undefined)?.connected !== true) {
            return false;
        }

        if (
            payload.thinking
            || isActiveLatestTurnStatus(payload.latestTurnStatus)
            || !options.volatileWhenIdle
        ) {
            this.socket.emit('session-alive', payload);
            return true;
        }

        const volatileEmit = (this.socket as any)?.volatile?.emit;
        if (typeof volatileEmit === 'function') {
            volatileEmit.call((this.socket as any).volatile, 'session-alive', payload);
            return true;
        }

        this.socket.emit('session-alive', payload);
        return true;
    }

    private replayLatestSessionPresenceAfterReconnect(): boolean {
        return this.emitSessionAlive(this.createSessionAlivePayload(this.latestSessionPresence), {
            volatileWhenIdle: false,
        });
    }

    private reassertSessionPresenceAfterReconnect(): void {
        this.clearReconnectPresenceReassertTimer();
        this.replayLatestSessionPresenceAfterReconnect();
        this.reconnectPresenceReassertTimer = setTimeout(() => {
            this.reconnectPresenceReassertTimer = null;
            if (this.closed) return;
            this.replayLatestSessionPresenceAfterReconnect();
        }, SESSION_PRESENCE_RECONNECT_REASSERT_DELAY_MS);
        this.reconnectPresenceReassertTimer.unref?.();
    }

    private clearReconnectPresenceReassertTimer(): void {
        if (!this.reconnectPresenceReassertTimer) return;
        clearTimeout(this.reconnectPresenceReassertTimer);
        this.reconnectPresenceReassertTimer = null;
    }

    /**
     * Whether the canonical session turn lifecycle currently has an open (non-terminal) turn.
     * Used by terminal-runtime arbiters to bound their own turn-state heuristics (Lane N2).
     */
    hasActiveCanonicalTurn(): boolean {
        return this.sessionTurnLifecycle.hasActiveTurn();
    }

    /**
     * Send session death message
     */
    sendSessionDeath(): Promise<void> {
        this.trackSessionTurnWrite(
            this.sessionTurnLifecycle.endSession(),
            { latestTurnStatus: 'cancelled' },
        );
        return Promise.resolve();
    }

    private async closeRegisteredRuntimeActivityPublisher(): Promise<void> {
        await this.sessionMutationOutbox.flush('flush');
        if (!this.socket.connected) return;
        const request = SessionRuntimeActivityCloseRequestSchema.parse({ sessionId: this.sessionId });
        let raw: unknown;
        try {
            raw = await emitSocketWithAck({
                socket: this.socket as any,
                event: SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT,
                payload: request,
            });
        } catch (error) {
            try {
                const authoritativeSession = await fetchSessionByIdCompat({
                    token: this.token,
                    sessionId: this.sessionId,
                    reason: 'legacy-compat-proof',
                });
                if (authoritativeSession?.active === false) return;
            } catch {
                // Preserve the socket close failure when the authoritative read is unavailable.
            }
            throw error;
        }
        const acknowledgement = SessionRuntimeActivityCloseAckSchema.safeParse(raw);
        if (!acknowledgement.success
            || ('sessionId' in acknowledgement.data && acknowledgement.data.sessionId !== this.sessionId)) {
            throw new Error('Runtime Activity clean-close acknowledgement is invalid');
        }
        if (acknowledgement.data.status !== 'closed'
            && acknowledgement.data.status !== 'already_inactive') {
            throw new Error(`Runtime Activity clean-close was not confirmed (${acknowledgement.data.status})`);
        }
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
        if (!this.socket.connected) {
            return;
        }
        this.socket.emit('usage-report', usageReport);
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    private isCurrentPendingInputServerContract(): boolean {
        return supportsPendingInputV1(this.sessionSyncPendingInputServerContract);
    }

    private normalizeProviderAcceptedUserMessageLocalIds(localIds: readonly string[] | null | undefined): string[] {
        const seen = new Set<string>();
        const normalized: string[] = [];
        for (const value of localIds ?? []) {
            const localId = readPendingLocalId(value);
            if (!localId || seen.has(localId)) continue;
            seen.add(localId);
            normalized.push(localId);
        }
        return normalized;
    }

    /**
     * Bind one provider-owned exact-input evidence producer to this live session generation.
     * Rebinding fences every older observer, so a replaced runtime cannot settle current Queue
     * custody even when its final callback arrives late.
     */
    bindProviderInputOutcomeProducer(
        producer: SessionProviderInputOutcomeProducer,
    ): SessionProviderInputOutcomeObserver {
        const currentProviderId = resolveSessionCatalogAgentId(this.metadata);
        const mode = readNonBlankOpaqueIdentifier(producer.mode);
        let matchesCurrentSession = producer.providerId === currentProviderId
            && mode !== null
            && typeof producer.matchesCurrentSession === 'function';
        if (matchesCurrentSession) {
            try {
                matchesCurrentSession = producer.matchesCurrentSession({ metadata: this.metadata });
            } catch {
                matchesCurrentSession = false;
            }
        }
        if (!matchesCurrentSession || !mode) return () => {};

        // Only a valid canonical producer may advance the generation. Invalid bind attempts must
        // not fence the currently active runtime observer.
        const generation = ++this.providerInputOutcomeProducerGeneration;

        return (outcome) => {
            if (
                this.closed
                || this.runtimeTerminationStarted
                || generation !== this.providerInputOutcomeProducerGeneration
            ) {
                return;
            }
            this.observeProviderInputOutcome(
                outcome,
                { providerId: producer.providerId, mode },
                generation,
            );
        };
    }

    /** Exact accepted/rejected outcomes are terminal and monotonic per Queue localId. */
    private observeProviderInputOutcome(
        outcome: SessionProviderInputOutcome,
        producer: Pick<SessionProviderInputOutcomeProducer, 'providerId' | 'mode'>,
        producerGeneration: number,
    ): void {
        const localId = readPendingLocalId(outcome.localId);
        if (!localId) return;

        for (const trackedLocalId of this.providerInputTerminalOutcomeByLocalId.keys()) {
            if (!this.canonicalPendingDeliveryByLocalId.has(trackedLocalId)) {
                this.providerInputTerminalOutcomeByLocalId.delete(trackedLocalId);
            }
        }
        for (const trackedLocalId of this.providerInputUncertainLocalIds) {
            if (!this.canonicalPendingDeliveryByLocalId.has(trackedLocalId)) {
                this.providerInputUncertainLocalIds.delete(trackedLocalId);
            }
        }

        if (outcome.kind === 'custody_observed' || outcome.kind === 'effect_may_have_occurred') {
            logger.debug('[pendingQueue] observed nonterminal provider-input outcome', {
                sessionId: this.sessionId,
                providerId: producer.providerId,
                providerMode: producer.mode,
                localId,
                outcomeKind: outcome.kind,
            });
            if (outcome.kind === 'effect_may_have_occurred') {
                if (this.providerInputUncertainLocalIds.has(localId)) return;
                this.providerInputUncertainLocalIds.add(localId);
                void this.blockPendingMessageDelivery({
                    localIds: [localId],
                    reason: 'delivery_outcome_uncertain',
                });
            }
            return;
        }

        if (
            outcome.kind === 'rejected_before_effect'
            && !isSessionProviderInputRejectedBeforeEffectReason(outcome.reason)
        ) {
            logger.warn('[pendingQueue] ignored invalid pre-effect provider rejection reason', {
                sessionId: this.sessionId,
                providerId: producer.providerId,
                providerMode: producer.mode,
                localId,
                reason: outcome.reason,
            });
            return;
        }

        const terminalOutcome = outcome.kind;
        const existingTerminalOutcome = this.providerInputTerminalOutcomeByLocalId.get(localId);
        if (existingTerminalOutcome) {
            if (existingTerminalOutcome !== terminalOutcome) {
                logger.warn('[pendingQueue] ignored conflicting provider-input terminal outcome', {
                    sessionId: this.sessionId,
                    providerId: producer.providerId,
                    providerMode: producer.mode,
                    localId,
                    acceptedOutcome: existingTerminalOutcome,
                    ignoredOutcome: terminalOutcome,
                });
            }
            return;
        }

        if (outcome.kind === 'accepted') {
            const appliedModelId = readNonBlankOpaqueIdentifier(outcome.appliedModelId);
            if (appliedModelId) {
                updateMetadataBestEffort(
                    this,
                    (metadata) => {
                        const existing = metadata.sessionAppliedModelV1;
                        if (
                            existing?.provider === producer.providerId
                            && existing.modelId === appliedModelId
                        ) {
                            return metadata;
                        }
                        return {
                            ...metadata,
                            sessionAppliedModelV1: {
                                v: 1,
                                provider: producer.providerId,
                                updatedAt: Date.now(),
                                modelId: appliedModelId,
                            },
                        };
                    },
                    '[pendingQueue]',
                    'provider_prompt_applied_model',
                );
            }
        }

        if (!this.canonicalPendingDeliveryByLocalId.has(localId)) return;
        this.providerInputUncertainLocalIds.delete(localId);
        this.providerInputTerminalOutcomeByLocalId.set(localId, terminalOutcome);

        if (terminalOutcome === 'accepted') {
            // Exact provider acceptance supersedes any earlier ambiguity/pre-effect block write
            // that failed and was parked for retry. A late failure must not resurrect that block.
            this.acceptedProviderInputLocalIds.add(localId);
            const authority = this.captureAcceptedCanonicalPendingDeliveryOperationAuthority(producerGeneration);
            if (!authority) return;
            this.trackAcceptedCanonicalPendingDeliveryResolution(
                this.resolveAcceptedCanonicalPendingDelivery(localId, authority),
            );
            return;
        }

        void this.blockPendingMessageDelivery({
            localIds: [localId],
            reason: outcome.reason,
        });
    }

    hasPendingProviderInputAcceptance(localId: string): boolean {
        const exactLocalId = readPendingLocalId(localId);
        return exactLocalId !== null && this.acceptedProviderInputLocalIds.has(exactLocalId);
    }

    hasCanonicalPendingProviderInputDelivery(localId: string): boolean {
        const exactLocalId = readPendingLocalId(localId);
        return exactLocalId !== null && this.canonicalPendingDeliveryByLocalId.has(exactLocalId);
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

    updateMetadataWithResult<TResult>(
        handler: (metadata: Metadata) => Readonly<{ metadata: Metadata; result: TResult }>,
    ): Promise<TResult> {
        return this.metadataLock.inLock(async () => {
            await this.waitForSessionSocketOnlineForAckWrite('update-metadata');
            return await updateSessionMetadataWithAckResult({
                socket: this.socket as any,
                sessionId: this.sessionId,
                sessionEncryptionMode: this.sessionEncryptionMode,
                encryptionKey: this.encryptionKey,
                encryptionVariant: this.encryptionVariant,
                getMetadata: () => this.metadata,
                setMetadata: (metadata) => { this.metadata = metadata; },
                getMetadataVersion: () => this.metadataVersion,
                setMetadataVersion: (version) => { this.metadataVersion = version; },
                syncSessionSnapshotFromServer: async () => {
                    await this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
                },
                handler,
            });
        });
    }

    getRuntimeActivitySnapshotPublisher(): SessionRuntimeActivitySnapshotPublisher {
        return this.runtimeActivitySnapshotPublisher;
    }

    readRuntimeActivitySnapshotTail(): RuntimeActivitySnapshotTail {
        return this.sessionMutationOutbox.readRuntimeActivitySnapshotTail();
    }

    async waitForRuntimeActivitySnapshotTailChange(sequence: number, signal?: AbortSignal): Promise<boolean> {
        return await this.sessionMutationOutbox.waitForRuntimeActivitySnapshotTailChange(sequence, signal);
    }

    private applyRuntimeActivityProjectionFromServer(
        projectionLike: unknown,
        opts?: { emitPendingEligibility?: boolean },
    ): void {
        const boundary = readRuntimeActivityProjectionForPendingDrain(projectionLike);
        if (
            boundary.runtimeActivityState === undefined
            || boundary.runtimeActivityActiveCount === undefined
            || boundary.runtimeActivityObservedAt === undefined
            || boundary.runtimeActivityRevision === undefined
        ) return;
        this.applyAcknowledgedRuntimeActivityProjection({
            state: boundary.runtimeActivityState ?? 'unknown',
            activeCount: boundary.runtimeActivityActiveCount,
            observedAt: boundary.runtimeActivityObservedAt ?? null,
            revision: boundary.runtimeActivityRevision,
        }, opts);
    }

    private applyAcknowledgedRuntimeActivityProjection(
        projection: SessionRuntimeActivityProjection,
        opts?: { emitPendingEligibility?: boolean },
    ): void {
        const applied = reduceAcknowledgedRuntimeActivityProjection({
            current: this.runtimeActivityProjection,
            projection,
        });
        this.runtimeActivityProjection = applied.projection;
        if (!applied.didBecomeIdle || opts?.emitPendingEligibility === false) return;
        this.pendingWakeSeq += 1;
        this.emit('metadata-updated');
        this.emitPendingEligibilityUpdated();
    }

    getStoredContentEncryptionContext(): Readonly<{
        mode: 'e2ee' | 'plain';
        ctx?: Readonly<{ encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }>;
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

    async fetchSessionSystemRecordsPage(params: Readonly<{
        namespace: SessionSystemRecordNamespace;
        kind: SessionSystemRecordKind;
        cursor?: string;
    }>) {
        return fetchSessionSystemRecordsPageHttp({
            token: this.token,
            sessionId: this.sessionId,
            namespace: params.namespace,
            kind: params.kind,
            ...(params.cursor ? { cursor: params.cursor } : {}),
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

    private trackSessionTurnWrite(
        update: Promise<void>,
        record: Readonly<{ latestTurnStatus?: PrimaryTurnStatusV1 }>,
    ): void {
        if (record.latestTurnStatus !== undefined) {
            this.applyLatestTurnStatusProjection(record.latestTurnStatus, Date.now());
        }
        const tracked = update.catch((error) => {
            logger.debug('[API] Failed to update primary turn runtime state (non-fatal)', {
                latestTurnStatus: record.latestTurnStatus ?? null,
                error: serializeAxiosErrorForLog(error),
            });
        });
        this.pendingSessionTurnWrites.add(tracked);
        void tracked.finally(() => {
            this.pendingSessionTurnWrites.delete(tracked);
        });
    }

    private applyLatestTurnStatusProjection(
        status: LatestTurnStatusSnapshot,
        observedAt: unknown,
    ): void {
        const observedAtMs = readFiniteTimestampMs(observedAt);
        if (observedAtMs === null) {
            // A status without observation time may seed an unknown projection, but it cannot
            // replace timestamped local/server evidence or manufacture freshness for itself.
            if (this.latestTurnStatusObservedAtMs !== null) return;
        } else if (
            this.latestTurnStatusObservedAtMs !== null
            && observedAtMs < this.latestTurnStatusObservedAtMs
        ) {
            return;
        }

        this.latestTurnStatus = status;
        this.latestTurnStatusObservedAtMs = observedAtMs;
    }

    private async drainBestEffortSessionWrites(): Promise<void> {
        await Promise.all([
            this.messageCommitQueueTail.catch(() => undefined),
            this.sessionMutationOutbox.flush('flush').catch(() => undefined),
            ...[...this.pendingSessionTurnWrites].map((update) => update.catch(() => undefined)),
        ]);
    }

    private async drainPendingLifecycleWritesBeforeClose(): Promise<void> {
        await Promise.all([
            ...[...this.pendingSessionTurnWrites].map((update) => update.catch(() => undefined)),
        ]);
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

    async close() {
        logger.debug('[API] socket.close() called');
        this.pendingInputReadinessAbortController?.abort();
        this.pendingInputReadinessAbortController = null;
        this.acceptedCanonicalPendingDeliveryOperationAbortController.abort();
        this.sessionMessageCommitRetry.dispose();
        if (this.startupMessageCatchUpRetryTimer) {
            clearTimeout(this.startupMessageCatchUpRetryTimer);
            this.startupMessageCatchUpRetryTimer = null;
        }
        if (this.userSocketDisconnectTimer) {
            clearTimeout(this.userSocketDisconnectTimer);
            this.userSocketDisconnectTimer = null;
        }
        this.clearReconnectPresenceReassertTimer();
        await this.drainPendingLifecycleWritesBeforeClose();
        await this.rpcHandlerManager.waitForIdle();
        await this.disposeRpcLifecycleRegistrations();
        await this.drainAcceptedCanonicalPendingDeliveryResolutionsBeforeClose();
        await this.blockUnresolvedCanonicalPendingDeliveriesBeforeClose();
        await this.blockDurableProviderDeliveriesBeforeClose();
        await this.closeRegisteredRuntimeActivityPublisher().catch((error) => {
            logger.debug('[API] Failed to close registered runtime Activity publisher (non-fatal)', {
                error: serializeAxiosErrorForLog(error),
            });
        });
        this.closed = true;
        this.pendingMaterializedLocalIds.clear();
        this.committedLocalIdsAwaitingEcho.clear();
        this.pendingQueueMaterializedLocalIds.clear();
        this.canonicalPendingDeliveryByLocalId.clear();
        this.serverBlockedCanonicalPendingDeliveryLocalIds.clear();
        this.sourceCutoverDeferredPendingLocalIds.clear();
        this.committedUserMessageSeqTracker.clear();
        this.agentQueueEchoSuppressedLocalIds.clear();
        this.agentQueueDeliveredLocalIds.clear();
        this.explicitUserRecoveryDecisionsByLocalId.clear();
        this.acceptedProviderInputLocalIds.clear();
        this.providerInputTerminalOutcomeByLocalId.clear();
        this.providerInputUncertainLocalIds.clear();
        this.acceptedCanonicalPendingDeliveryResolutionWrites.clear();
        this.acceptedCanonicalPendingDeliveryResolutionLocalIdsInFlight.clear();
        this.queuedDisconnectedSessionMessages.clear();
        for (const timer of this.committedLocalIdCleanupTimers.values()) {
            clearTimeout(timer);
        }
        this.committedLocalIdCleanupTimers.clear();
        for (const timer of this.agentQueueEchoSuppressedLocalIdCleanupTimers.values()) {
            clearTimeout(timer);
        }
        this.agentQueueEchoSuppressedLocalIdCleanupTimers.clear();
        for (const timer of this.agentQueueDeliveredLocalIdCleanupTimers.values()) {
            clearTimeout(timer);
        }
        this.agentQueueDeliveredLocalIdCleanupTimers.clear();
        for (const timer of this.explicitUserRecoveryCheckedLocalIdCleanupTimers.values()) {
            clearTimeout(timer);
        }
        this.explicitUserRecoveryCheckedLocalIdCleanupTimers.clear();
        await this.runtimeActivitySnapshotPublisher.close();
        await this.sessionMutationOutbox.close();
        try {
            this.userSocket.close();
        } catch {
            // ignore
        }
        await this.sessionConnectionSupervisor?.stop();
    }

    beginRuntimeTermination(): void {
        if (this.runtimeTerminationStarted) return;
        this.runtimeTerminationStarted = true;
        this.providerInputOutcomeProducerGeneration += 1;
        this.acceptedCanonicalPendingDeliveryOperationAbortController.abort();
    }

    hasRuntimeTerminationStarted(): boolean {
        return this.runtimeTerminationStarted;
    }

    private async blockUnresolvedCanonicalPendingDeliveriesBeforeClose(): Promise<void> {
        const localIds = [...this.canonicalPendingDeliveryByLocalId.keys()];
        for (const localId of localIds) {
            if (this.sourceCutoverDeferredPendingLocalIds.has(localId)) {
                logger.debug('[pendingQueue] preserving source-cutover delivery for successor custody during close', {
                    sessionId: this.sessionId,
                    localId,
                });
                continue;
            }
            if (this.providerInputUncertainLocalIds.has(localId)) {
                await this.blockPendingQueueDeliveryLocalId(localId, 'delivery_outcome_uncertain', {
                    canonicalOnly: true,
                });
                continue;
            }
            if (this.providerInputTerminalOutcomeByLocalId.get(localId) === 'accepted') {
                logger.debug('[pendingQueue] preserving provider-accepted delivery during close for exact reconciliation', {
                    sessionId: this.sessionId,
                    localId,
                });
                continue;
            }
            await this.blockPendingQueueDeliveryLocalId(localId, 'runtime_disposed_before_delivery', {
                canonicalOnly: true,
            });
        }
    }

    private async blockDurableProviderDeliveriesBeforeClose(): Promise<void> {
        if (!this.isCurrentPendingInputServerContract()) return;
        if (countMaterializablePendingRows(this.pendingQueueState) <= 0) return;

        let localIds: string[];
        const supervisor = this.sessionConnectionSupervisor;
        try {
            const request = () => listPendingQueueV2ProviderDeliveryLocalIdsFromServer({
                token: this.token,
                sessionId: this.sessionId,
            });
            localIds = supervisor
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

        for (const localId of localIds) {
            if (this.sourceCutoverDeferredPendingLocalIds.has(localId)) {
                logger.debug('[pendingQueue] preserving durable source-cutover delivery for successor custody during close', {
                    sessionId: this.sessionId,
                    localId,
                });
                continue;
            }
            if (this.providerInputUncertainLocalIds.has(localId)) {
                await this.blockPendingQueueDeliveryLocalId(localId, 'delivery_outcome_uncertain', {
                    canonicalOnly: false,
                });
                continue;
            }
            if (this.providerInputTerminalOutcomeByLocalId.get(localId) === 'accepted') {
                logger.debug('[pendingQueue] preserving durable provider-accepted delivery during close for exact reconciliation', {
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

    private async disposeRpcLifecycleRegistrations(): Promise<void> {
        const registrations = this.rpcLifecycleRegistrations.splice(0);
        await Promise.all(registrations.map(async (registration) => {
            try {
                await registration.dispose();
            } catch (error) {
                logger.debug('[API] Failed to dispose RPC lifecycle registration', {
                    error: serializeAxiosErrorForLog(error),
                });
            }
        }));
    }

    private installSessionSocketEventHandlers(socket: Socket<ServerToClientEvents, ClientToServerEvents>): void {
        socket.on('server:restarting', (payload: unknown) => {
            this.sessionConnectionSupervisor?.reportProbeResult?.({
                status: 'retry_later',
                retryAfterMs: readPlannedServerRestartRetryAfterMs(payload),
                reason: 'server_restarting',
                errorMessage: 'Server restart in progress',
            });
        });

        socket.on(SOCKET_RPC_EVENTS.REQUEST, async (data: { method: string, params: unknown }, callback: (response: unknown) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data));
        });

        socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error:', {
                error: serializeAxiosErrorForLog(error),
            });
        });

        socket.on('update', (data: Update) => this.handleLiveUpdate(data, {
            source: 'session-scoped',
            socket,
        }));
        socket.on('session', () => {});
        socket.on('error', (error) => {
            logger.debug('[API] Socket error:', {
                error: serializeAxiosErrorForLog(error),
            });
        });
    }

    async listPendingMessageQueueV2LocalIds(): Promise<string[]> {
        const request = () => listPendingQueueV2LocalIdsFromServer({
            token: this.token,
            sessionId: this.sessionId,
        });
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            return request();
        }
        return runSupervisedRequest({
            supervisor,
            requireAuth: true,
            requireOnline: false,
            request,
        });
    }

    async peekPendingMessageQueueV2Count(opts?: PendingQueueReadOptions): Promise<number> {
        const policy = resolvePendingQueueReconcileWhenEmpty(opts, 'force');
        if (!this.pendingQueueState.known) {
            await this.reconcilePendingQueueState({ force: true });
        } else if (this.pendingQueueState.pendingCount <= 0) {
            if (policy === 'force') {
                await this.reconcilePendingQueueState({ force: true });
            } else if (policy === 'throttled') {
                await this.reconcilePendingQueueState({ force: false });
            }
        }

        if (this.pendingQueueState.known && this.pendingQueueState.pendingCount <= 0) {
            return this.pendingQueueMaterializedLocalIds.size;
        }

        if (!this.pendingQueueState.known) {
            return this.pendingQueueMaterializedLocalIds.size;
        }

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
        const request = () => discardPendingQueueV2Messages({
            token: this.token,
            sessionId: this.sessionId,
            localIds,
            reason: opts.reason,
        });
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            return request();
        }
        return runSupervisedRequest({
            supervisor,
            requireAuth: true,
            requireOnline: false,
            request,
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
                const metadataPayload =
                    this.sessionEncryptionMode === 'plain'
                        ? JSON.stringify(nextMetadata)
                        : encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, nextMetadata));
                const answer = await emitSocketWithAck<any>({
                    socket: this.socket as any,
                    event: 'update-metadata',
                    payload: {
                        sid: this.sessionId,
                        expectedVersion: this.metadataVersion,
                        metadata: metadataPayload,
                    },
                });

                if (answer.result === 'success') {
                    this.metadata =
                        this.sessionEncryptionMode === 'plain'
                            ? JSON.parse(String(answer.metadata ?? 'null'))
                            : decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    this.metadataVersion = answer.version;
                    addedCount = uniqueNew.length;
                    return;
                }

                if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        this.metadataVersion = answer.version;
                        this.metadata =
                            this.sessionEncryptionMode === 'plain'
                                ? JSON.parse(String(answer.metadata ?? 'null'))
                                : decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
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
     * Drain one server-backed queued message (pending queue V2).
     *
     * Legacy queue-handoff rows are committed into SessionMessage before delivery. Provider-
     * acceptance rows are claimed without a transcript commit, delivered directly to the runtime,
     * and resolved into the transcript only when the provider proves custody.
     */
    private async runMaterializeNextPendingMessageInner(opts: {
        expectedPendingVersion?: number;
        expectedRuntimeActivityRevision?: number;
        pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
        foregroundState?: 'ready' | 'active_steerable' | 'active_unsteerable';
    } = {}): Promise<{
        didMaterialize: boolean;
        result: MaterializeNextPendingResult;
    }> {
        if (this.closed || this.runtimeTerminationStarted) {
            return { didMaterialize: false, result: { type: 'retryable_transport' } };
        }
        if (this.closed || this.runtimeTerminationStarted) {
            return { didMaterialize: false, result: { type: 'retryable_transport' } };
        }
        const supervisor = this.sessionConnectionSupervisor;
        if (!supervisor) {
            return { didMaterialize: false, result: { type: 'retryable_transport' } };
        }
        const serverContract = this.sessionSyncPendingInputServerContract;
        if (!serverContract) {
            return { didMaterialize: false, result: { type: 'retryable_transport' } };
        }
        const isServerContractCurrent = () => (
            this.sessionSyncPendingInputServerContract === serverContract
            && serverContract.sessionConnectionEpoch === this.sessionConnectionEpoch
            && serverContract.socket === this.socket
            && serverContract.socket.connected === true
            && !this.closed
            && !this.runtimeTerminationStarted
        );
        if (!isServerContractCurrent()) {
            return { didMaterialize: false, result: { type: 'retryable_transport' } };
        }
        if (serverContract.mode === 'auth_failed') {
            return { didMaterialize: false, result: { type: 'auth_failure', statusCode: 401 } };
        }
        if (
            serverContract.pendingInput === 'indeterminate'
            || serverContract.pendingInput === 'unsupported'
        ) {
            return { didMaterialize: false, result: { type: 'retryable_transport' } };
        }
        let materializeResult: PendingQueueMaterializeNextResult;
        if (serverContract.pendingInput === 'released_server_v0_2_1') {
            const releasedResult = await continuePendingQueueV2OnReleasedServer({
                contract: serverContract,
                getServerContract: () => this.sessionSyncPendingInputServerContract,
                token: this.token,
                serverUrl: resolveServerHttpBaseUrl(),
                sessionId: this.sessionId,
                getSessionConnectionEpoch: () => this.sessionConnectionEpoch,
                getSocket: () => this.socket,
                hasCurrentLocalRuntimeAuthority: () => !this.closed && !this.runtimeTerminationStarted,
                decodeStoredContent: (content) => this.decodeStoredSessionMessageContent(content),
            });
            if (releasedResult.type === 'auth_failed') {
                return {
                    didMaterialize: false,
                    result: { type: 'auth_failure', statusCode: releasedResult.statusCode },
                };
            }
            if (releasedResult.type === 'no_pending' || releasedResult.type === 'zero_effect') {
                return { didMaterialize: false, result: { type: 'no_pending' } };
            }
            materializeResult = {
                didMaterialize: true,
                localId: releasedResult.message.localId,
                didWrite: true,
                message: releasedResult.message,
            };
        } else {
            try {
                materializeResult = await runSupervisedRequest({
                    supervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request: async () => materializeNextPendingQueueV2Message({
                        token: this.token,
                        sessionId: this.sessionId,
                        socket: this.socket,
                        expectedPendingVersion: opts.expectedPendingVersion,
                        expectedRuntimeActivityRevision: opts.expectedRuntimeActivityRevision,
                        ...(
                            opts.expectedPendingVersion === undefined && this.pendingQueueState.known
                                ? { knownPendingVersion: this.pendingQueueState.pendingVersion }
                                : {}
                        ),
                        // Current-contract materialization has one canonical custody shape. Provider
                        // selection cannot opt this invariant in or out.
                        deliveryStateOptIn: true,
                        deliveryTiming: this.accountSettingsSyncBarrier !== null
                            ? 'after_runtime_idle'
                            : getActiveAccountSettingsSnapshot()
                            ? resolveSessionPendingQueueDeliveryTiming(
                                getActiveAccountSettingsSnapshot()?.settings ?? null,
                            )
                            : opts.pendingQueueDeliveryTiming
                                ?? resolveSessionPendingQueueDeliveryTiming(null),
                        foregroundState: opts.foregroundState ?? this.resolvePendingForegroundState(),
                    }),
                });
            } catch (error) {
                if (!isServerContractCurrent()) {
                    return { didMaterialize: false, result: { type: 'retryable_transport' } };
                }
                if (isAuthenticationError(error)) {
                    return {
                        didMaterialize: false,
                        result: {
                            type: 'auth_failure',
                            statusCode: readAuthenticationStatus(error) ?? 401,
                        },
                    };
                }
                logger.infoFile('[pendingQueue] materialize request failed', {
                    sessionId: this.sessionId,
                    error: {
                        ...serializeOutboundError(error),
                        ...(error instanceof PendingQueueMaterializationTransportAmbiguousError
                            ? {
                                diagnosticCode: error.diagnosticCode,
                                classification: error.classification,
                                ...(error.serverError ? { serverError: error.serverError } : {}),
                                ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
                            }
                            : {}),
                    },
                });
                return {
                    didMaterialize: false,
                    result: {
                        type: 'retryable_transport',
                        // A timed-out socket acknowledgement may have committed the exact frozen
                        // claim on the server. Ask the consumer to rejoin that same claim after a
                        // short delay; other transport failures remain connection-event driven.
                        ...(error instanceof PendingQueueMaterializationTransportAmbiguousError
                            ? { retryAfterMs: error.retryAfterMs ?? 250 }
                            : {}),
                    },
                };
            }
        }
        if (!isServerContractCurrent()) {
            return {
                didMaterialize: false,
                result: {
                    type: serverContract.pendingInput === 'released_server_v0_2_1'
                        ? 'no_pending'
                        : 'retryable_transport',
                },
            };
        }
        const pendingStateUpdate = derivePendingQueueStateAfterMaterializeResult({
            current: this.pendingQueueState,
            didMaterialize: materializeResult.didMaterialize,
            authoritativeState: materializeResult.pendingQueueState ?? null,
        });
        this.pendingQueueState = pendingStateUpdate.state;
        if (pendingStateUpdate.changed) {
            this.pendingWakeSeq += 1;
        }
        if (this.closed || this.runtimeTerminationStarted) {
            return { didMaterialize: false, result: { type: 'retryable_transport' } };
        }

        if (!materializeResult.didMaterialize) {
            if (
                materializeResult.deferredReason === 'waiting_for_runtime_activity'
                || materializeResult.deferredReason === 'runtime_activity_unknown'
            ) {
                return {
                    didMaterialize: false,
                    result: {
                        type: 'deferred',
                        reason: materializeResult.deferredReason,
                        ...(materializeResult.retryAfterMs !== undefined
                            ? { retryAfterMs: materializeResult.retryAfterMs }
                            : {}),
                    },
                };
            }
            if (materializeResult.deferredReason === 'pending_version_mismatch') {
                return { didMaterialize: false, result: { type: 'deferred', reason: 'pending_version_mismatch' } };
            }
            if (materializeResult.deferredReason === 'waiting_for_predecessor') {
                return { didMaterialize: false, result: { type: 'deferred', reason: 'waiting_for_predecessor' } };
            }
            if (materializeResult.deferredReason === 'waiting_for_foreground_turn') {
                return { didMaterialize: false, result: { type: 'deferred', reason: 'waiting_for_foreground_turn' } };
            }
            logger.debug('[pendingQueue] materialize result', {
                sessionId: this.sessionId,
                didMaterialize: false,
                pendingCount: this.pendingQueueState.known ? this.pendingQueueState.pendingCount : undefined,
                pendingVersion: this.pendingQueueState.known ? this.pendingQueueState.pendingVersion : undefined,
            });
            return { didMaterialize: false, result: { type: 'no_pending' } };
        }

        if (materializeResult.runtimeActivityNotice) {
            this.sendSessionEvent(
                { type: 'message', message: materializeResult.runtimeActivityNotice.message },
                materializeResult.runtimeActivityNotice.id,
            );
        }

        const materializedLocalId = materializeResult.message?.localId ?? materializeResult.localId ?? null;
        const materializedMessage = materializeResult.message && !materializeResult.message.localId && materializedLocalId
            ? { ...materializeResult.message, localId: materializedLocalId }
            : materializeResult.message ?? null;
        const materializedProviderClaimState =
            materializeResult.didWrite === false
            && materializedMessage
            && materializedMessage.deliveryStateMalformed !== true
            && readPendingLocalId(materializedMessage.localId) !== null
            && materializedMessage.seq === null
                ? { mode: 'provider' as const, unresolved: true as const }
                : null;
        const explicitUnresolvedProviderDeliveryState =
            materializedMessage?.deliveryState?.unresolved === true
                ? materializedMessage.deliveryState
                : null;
        const inferredProviderDeliveryState =
            materializedProviderClaimState
            && !explicitUnresolvedProviderDeliveryState
                ? materializedProviderClaimState
                : null;
        const unresolvedProviderDeliveryState =
            explicitUnresolvedProviderDeliveryState
                ? explicitUnresolvedProviderDeliveryState
                : inferredProviderDeliveryState;

        if (materializedMessage?.deliveryStateMalformed) {
            logger.debug('[pendingQueue] materialize result ignored malformed pending delivery state', {
                sessionId: this.sessionId,
                localId: materializedLocalId,
                messageSeq: materializedMessage?.seq ?? null,
            });
            if (materializedLocalId) {
                await this.blockPendingQueueDeliveryLocalId(materializedLocalId, 'unknown', {
                    canonicalOnly: false,
                });
            }
            return { didMaterialize: false, result: { type: 'no_pending' } };
        }

        if (
            materializedMessage
            && unresolvedProviderDeliveryState
            && materializedMessage.localId
        ) {
            if (this.canonicalPendingDeliveryByLocalId.has(materializedMessage.localId)) {
                logger.debug('[pendingQueue] materialize result suppressed for already-unresolved provider delivery state', {
                    sessionId: this.sessionId,
                    localId: materializedMessage.localId,
                    messageSeq: materializedMessage.seq,
                });
                return { didMaterialize: false, result: { type: 'no_pending' } };
            }
            this.canonicalPendingDeliveryByLocalId.set(
                materializedMessage.localId,
                unresolvedProviderDeliveryState,
            );
        }

        if (materializeResult.providerDeliveryContractInvalid === true) {
            // Both materialize transports drop the message whenever they raise this flag
            // (`message: providerDeliveryContractInvalid ? null : message`), so an invalid
            // provider contract is always resolved by blocking the row — a visible, actionable
            // server state — never by parking it in local custody with no successor to inherit it.
            // A materialization that legitimately carries no requested action arrives through the
            // released-server contract with the flag unset and is authorized below.
            logger.debug('[pendingQueue] blocking materialized delivery with an invalid provider contract', {
                sessionId: this.sessionId,
                localId: materializedLocalId,
            });
            if (materializedLocalId) {
                await this.blockPendingQueueDeliveryLocalId(materializedLocalId, 'unsupported_action', {
                    canonicalOnly: false,
                });
            }
            return { didMaterialize: false, result: { type: 'no_pending' } };
        }

        if (
            this.startedByDaemonProcess
            && materializedMessage?.messageRole === 'user'
        ) {
            const requestedAction = materializedMessage.requestedAction;
            // The daemon owns turn custody for every prompt this runner delivers, including on a
            // server contract that carries no requested action at all (released-server v0.2.1,
            // whose materialize ack is exactly id/seq/localId). Notify unconditionally; the
            // wrapper attaches the action and the active-turn witness only when there is one.
            const lifecycleResult = await this.notifyDaemonConnectedServiceTurnLifecycle(
                'prompt_or_steer',
                undefined,
                undefined,
                requestedAction,
            );
            if (requestedAction && lifecycleResult === null) {
                // The daemon did not answer at all (control channel down, or an unparsable reply).
                // That is NOT a source cutover: no successor runner is coming to inherit the claim,
                // and nothing was handed to the Provider. Resolve the durable claim as a visible,
                // reversible pre-acceptance block. Clearing only process-local custody cannot wake
                // the Pending consumer and can strand the server row in `delivering`; a durable
                // block also preserves the existing explicit Retry path without a blind retry loop.
                logger.debug('[pendingQueue] blocking materialized claim after an unanswered connected-service turn lifecycle', {
                    sessionId: this.sessionId,
                    localId: materializedLocalId,
                });
                const didBlock = materializedLocalId
                    ? await this.blockPendingQueueDeliveryLocalId(
                        materializedLocalId,
                        'provider_unavailable_before_acceptance',
                        { canonicalOnly: false },
                    )
                    : false;
                // Only the durable block proves the server row is retryable again. Retire every
                // process-local claim then so an explicit reopen of this exact localId can be
                // materialized; a failed block keeps custody and therefore fails closed.
                if (didBlock && materializedLocalId) {
                    this.clearCanonicalPendingDeliveryLocalState(materializedLocalId);
                    logger.debug('[pendingQueue] retired unanswered pre-provider local custody after durable block', {
                        sessionId: this.sessionId,
                        localId: materializedLocalId,
                    });
                }
                return {
                    didMaterialize: false,
                    result: { type: didBlock ? 'no_pending' : 'retryable_transport' },
                };
            }
            if (lifecycleResult?.status === 'input_blocked') {
                // Retention is correct only on the daemon's explicit cutover promise: a successor
                // runner is coming and will inherit this claim. Test that positively, never as
                // "anything that is not continue" — an unanswered daemon (handled above) and a
                // materialization whose server contract has no action to authorize both have no
                // successor, so parking the row there starves it and everything behind it for the
                // life of this runner, with no server-side exit but publisher replacement.
                logger.debug('[pendingQueue] retained materialized delivery for connected-service source cutover', {
                    sessionId: this.sessionId,
                    localId: materializedLocalId,
                    lifecycleStatus: lifecycleResult.status,
                });
                if (materializedLocalId) {
                    this.sourceCutoverDeferredPendingLocalIds.add(materializedLocalId);
                }
                return {
                    didMaterialize: false,
                    result: {
                        type: 'deferred',
                        reason: 'request_auth_source_cutover',
                    },
                };
            }
        }

        const shouldClearResolvedCanonicalDelivery = (
            !unresolvedProviderDeliveryState
            && materializedMessage
            && materializedMessage.deliveryState?.unresolved === false
            && materializedMessage.localId
        );

        const isProviderDeliveryHandoff =
            unresolvedProviderDeliveryState?.unresolved === true;
        if (!isServerContractCurrent()) {
            return {
                didMaterialize: false,
                result: {
                    type: serverContract.pendingInput === 'released_server_v0_2_1'
                        ? 'no_pending'
                        : 'retryable_transport',
                },
            };
        }
        if (materializedLocalId) {
            this.pendingQueueMaterializedLocalIds.add(materializedLocalId);
        }
        const deliveredMaterializedMessage = await this.deliverPendingQueueMessage(materializedMessage, {
            providerAcceptancePending: isProviderDeliveryHandoff,
        });
        if (shouldClearResolvedCanonicalDelivery && materializedMessage?.localId) {
            this.clearCanonicalPendingDeliveryLocalState(materializedMessage.localId);
        }
        logger.debug('[pendingQueue] materialize result', {
            sessionId: this.sessionId,
            didMaterialize: true,
            localId: materializedLocalId,
            didWrite: materializeResult.didWrite,
            messageSeq: materializedMessage?.seq ?? null,
            messageSeqKind: materializedMessage
                ? materializedMessage.seq === null
                    ? 'null'
                    : typeof materializedMessage.seq
                : 'missing',
            messageRole: materializedMessage?.messageRole ?? null,
            deliveredMaterializedMessage,
            providerDeliveryStateUnresolved: materializedMessage?.deliveryState?.unresolved ?? null,
            providerDeliveryStateMalformed: materializedMessage?.deliveryStateMalformed === true,
            providerDeliveryStateInferred: inferredProviderDeliveryState !== null,
            pendingCount: this.pendingQueueState.known ? this.pendingQueueState.pendingCount : undefined,
            pendingVersion: this.pendingQueueState.known ? this.pendingQueueState.pendingVersion : undefined,
        });

        if (
            isProviderDeliveryHandoff
            && materializedMessage?.localId
            && !deliveredMaterializedMessage
        ) {
            await this.blockCanonicalPendingDeliveries([materializedMessage.localId], 'invalid_prompt_text');
        }

        if (
            materializeResult.didWrite
            && materializedMessage?.messageRole === 'user'
            && materializedMessage.localId
        ) {
            this.recordCommittedUserMessageSeq(
                materializedMessage.localId,
                materializedMessage.seq,
            );
        }

        const message = materializedMessage;
        const messageLocalId = readPendingLocalId(message?.localId);
        if (
            message
            && messageLocalId !== null
            && (
                (
                    typeof message.seq === 'number'
                    && Number.isSafeInteger(message.seq)
                    && message.seq >= 0
                )
                || (
                    isProviderDeliveryHandoff
                    && message.seq === null
                    && deliveredMaterializedMessage
                )
            )
        ) {
            return {
                didMaterialize: true,
                result: {
                    type: 'materialized',
                    localId: messageLocalId,
                    seq: typeof message.seq === 'number' ? message.seq : null,
                    content: message.content ?? null,
                    ...(typeof message.createdAt === 'number' ? { createdAt: message.createdAt } : {}),
                    ...(typeof message.updatedAt === 'number' ? { updatedAt: message.updatedAt } : {}),
                    ...(unresolvedProviderDeliveryState ? { deliveryState: unresolvedProviderDeliveryState } : {}),
                },
            };
        }

        return { didMaterialize: true, result: { type: 'no_pending' } };
    }

    async materializeNextPendingMessageSafely(opts: {
        expectedPendingVersion?: number;
        expectedRuntimeActivityRevision?: number;
        reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
        activeTurnSteerability?: PendingForegroundSteerability;
        pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
    } = {}): Promise<MaterializeNextPendingResult> {
        const supervisorState = this.sessionConnectionSupervisor?.getState();
        if (supervisorState?.phase === 'auth_failed') {
            return { type: 'auth_failure', statusCode: 401 };
        }
        if (supervisorState && supervisorState.phase === 'shutting_down') {
            return { type: 'deferred', reason: 'supervisor_offline' };
        }
        if (supervisorState && supervisorState.phase !== 'online') {
            // Supervisor state may lag an exact still-connected session socket. Do not hard-defer
            // here; the server-contract result and exact socket identity are rechecked by the
            // canonical materialization owner below. A disconnected or replaced socket fails closed.
            logger.debug('[pendingQueue] materializing with degraded session socket supervisor', {
                sessionId: this.sessionId,
                phase: supervisorState.phase,
            });
        }
        if (!await this.reconcileCanonicalPendingDeliveriesBeforeMaterialization()) {
            return { type: 'no_pending' };
        }

        const policy = resolvePendingQueueReconcileWhenEmpty(opts, 'skip');
        if (!this.pendingQueueState.known) {
            await this.reconcilePendingQueueState({ force: true });
        } else if (countMaterializablePendingRows(this.pendingQueueState) <= 0) {
            if (policy === 'force') {
                await this.reconcilePendingQueueState({ force: true });
            } else if (policy === 'throttled') {
                await this.reconcilePendingQueueState({ force: false });
            }
        }
        if (!this.pendingQueueState.known) {
            return { type: 'retryable_transport' };
        }
        if (countMaterializablePendingRows(this.pendingQueueState) <= 0) {
            return { type: 'no_pending' };
        }
        const refreshedTurnStatus = await this.reconcileTurnStatusBeforePendingMaterializationIfNeeded({
            activeTurnSteerability: opts.activeTurnSteerability,
        });
        if (!refreshedTurnStatus) {
            this.logPendingMaterializationSkip('turn_status_refresh_failed');
            return { type: 'retryable_transport' };
        }
        if (countMaterializablePendingRows(this.pendingQueueState) <= 0) {
            return { type: 'no_pending' };
        }
        opts.expectedPendingVersion ??= this.pendingQueueState.pendingVersion;

        const inner = await this.runMaterializeNextPendingMessageInner({
            expectedPendingVersion: opts.expectedPendingVersion,
            expectedRuntimeActivityRevision: opts.expectedRuntimeActivityRevision,
            pendingQueueDeliveryTiming: opts.pendingQueueDeliveryTiming,
            foregroundState: this.resolvePendingForegroundState(opts.activeTurnSteerability),
        });
        return inner.result;
    }

    /**
     * Known-positive pending count with no materialization attempt is the silent-stuck
     * shape (QA A-F3/C-F2); log why the drain was skipped so it is diagnosable from
     * runner logs without instrumented builds.
     */
    private logPendingMaterializationSkip(
        reason: 'blocked' | 'waiting_for_runtime_activity' | 'runtime_activity_unknown' | 'turn_status_refresh_failed',
        opts: { activeTurnSteerability?: PendingForegroundSteerability } = {},
    ): void {
        logger.debug('[pendingQueue] materialization skipped', {
            sessionId: this.sessionId,
            reason,
            activeTurnSteerability: opts.activeTurnSteerability ?? 'unsteerable',
            hasCanonicalActiveTurn: this.sessionTurnLifecycle.hasActiveTurn(),
            latestTurnStatus: this.latestTurnStatus ?? null,
            pendingCount: this.pendingQueueState.known ? this.pendingQueueState.pendingCount : null,
            pendingVersion: this.pendingQueueState.known ? this.pendingQueueState.pendingVersion : null,
        });
    }

    async popPendingMessage(): Promise<boolean> {
        if (!await this.reconcileCanonicalPendingDeliveriesBeforeMaterialization()) {
            return false;
        }
        if (countMaterializablePendingRows(this.pendingQueueState) <= 0) {
            await this.reconcilePendingQueueState({ force: !this.pendingQueueState.known });
        }
        if (countMaterializablePendingRows(this.pendingQueueState) <= 0) {
            return false;
        }
        const refreshedTurnStatus = await this.reconcileTurnStatusBeforePendingMaterializationIfNeeded();
        if (!refreshedTurnStatus) {
            return false;
        }
        if (countMaterializablePendingRows(this.pendingQueueState) <= 0) {
            return false;
        }
        const inner = await this.runMaterializeNextPendingMessageInner({
            foregroundState: this.resolvePendingForegroundState(),
        });
        if (inner.result.type === 'auth_failure') {
            throw createAuthenticationHttpStatusError(
                inner.result.statusCode,
                'Pending queue materialization authentication failed',
            );
        }
        return inner.didMaterialize;
    }
}

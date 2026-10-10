import { logger } from '@/ui/logger'
import { registerPluginCatalogSignal } from './client/registerPluginCatalogSignal';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { createExternalActionAuthorizedRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { randomUUID } from 'node:crypto'
import {
    createSessionActionConfirmationAdapter,
    retireRecoveredSessionActionConfirmations,
    type SessionActionConfirmationRuntimeBinding,
} from '@/session/actions/approvals/sessionActionConfirmation';
import { EventEmitter } from 'node:events'
import { Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, Metadata, ServerToClientEvents, Session, Update, UserMessage } from '../types'
import { AsyncLock } from '@/utils/lock';
import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { shouldSyncSessionSnapshotOnConnect, type OpenedSessionStateSnapshot, type OpenedSessionStateVersions } from './snapshotSync';
import { createSessionTranscriptStoredContentUnavailableError } from './sessionTranscriptStoredContentUnavailable';
import { TranscriptOpenedAgentStateV1Schema, TranscriptOpenedSharedMetadataV1Schema } from '@happier-dev/protocol/actions/actionSpecs';
import { projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { TranscriptOpenedSharedMetadataV1 } from '@happier-dev/protocol';
import { isExecutionRunActive } from '@happier-dev/protocol/execution/runs/responseSchemas';
import {
    updateSessionAgentStateWithAck,
    updateSessionMetadataWithAck,
    updateSessionRuntimeActivityProjectionWithAck,
} from './stateUpdates';
import {
    readSessionMetadataSharedEditorTupleSnapshot,
    readSessionMetadataTupleWriterSnapshot,
    updateSessionMetadataEnvelopeTupleWithRetry,
    type SessionMetadataEnvelopeTupleSnapshot,
    type SessionMetadataLegacyOwnerSnapshot,
    type SessionMetadataSharedEditorSnapshot,
    type SessionMetadataTupleWriterSnapshot,
} from '@/session/metadata/updateSessionMetadataWithRetry';
import type {
    SessionMetadataLegacyOwnerMutationRequestV1,
} from '@happier-dev/cli-common/sessionMetadata';
import { classifyTransportErrorToProbeResult } from '@/api/connection/classifyTransportErrorToProbeResult';
import type { ACPMessageData, ACPProvider, SessionEventMessage } from './sessionMessageTypes';
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
    type SessionInputTransformBeforeCommitResult,
} from './client/transcript/sessionClientTranscriptApi';
import { findPersistedSessionUserMessageAdmission } from './client/transcript/sessionUserMessageAdmissionRejoin';
import type { SendAgentSessionMediaCommittedRequest } from './client/transcript/sessionMediaBridge';
import type { SessionStructuredInputAdmissionPolicyV1 } from '@/session/services/admitSessionStructuredInputV1';
import type { EphemeralSendOutcome } from './client/transcript/ephemeralSendOutcome';
import type { CommittedTranscriptMessageOptions } from './transcriptPort';
import type { TurnAssistantTextSnapshotStore } from './turns/assistantTextSnapshot';
import { createTurnAssistantTextSnapshotStore } from './turns/assistantTextSnapshotStore';
import {
    registerSessionClientRuntimeHandlers,
} from './client/executionRuns/registerSessionClientRuntimeHandlers';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import type { BrowserContextRoutes } from '@/daemon/browser/context/routes';
import type { BrowserAutomationRoutes } from '@/daemon/browser/automation/routes';
import type { BrowserUiAutomationRouteOwner } from '@/daemon/runtimeActionExecutor';
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
import type { SessionClientConnectionContractResult } from './client/transport/sessionClientConnectionContract';
import { ensureSessionConnectionSupervisionActive } from './connection/ensureSessionConnectionSupervisionActive';
import {
    createSessionClientInteractionApi,
    type ExecutionRunPendingInputBinding,
    type SessionClientInteractionApi,
} from './client/transport/sessionClientInteractionApi';
import { syncSessionSnapshotFromServer } from './client/transport/syncSessionSnapshotFromServer';
import { createSessionClientUsageObservationPublisher } from './client/createSessionClientUsageObservationPublisher';
import type {
    SessionClientServerBinding,
    SessionClientTransport,
} from './client/transport/sessionClientTransport';
import {
    createSessionClientRecoveryRuntime,
    type SessionClientRecoveryRuntime,
} from './client/lifecycle/createSessionClientRecoveryRuntime';
import type { SessionCatchUpRequest } from './sessionChangesSyncOnConnect';
import { createSessionClientMaterializationRuntime } from './client/lifecycle/createSessionClientMaterializationRuntime';
import { createSessionClientCommitQueueRuntime } from './client/transport/createSessionClientCommitQueueRuntime';
import { createSessionClientUpdateRuntime } from './client/transport/createSessionClientUpdateRuntime';
import {
    createRuntimeSessionClientDurableMutationOutbox,
    type RuntimeSessionClientDurableMutationOutbox,
    type RuntimeSessionTurnMutationV1,
} from './client/transport/mutations/createRuntimeSessionClientDurableMutationOutbox';
import { applySessionRuntimeControls } from './sessionRuntimeControls';
import { updateAgentStateBestEffort } from './sessionWritesBestEffort';
import {
    createTranscriptMessageAppendMutation,
    createVoiceAgentTranscriptTurnMutation,
    resolveRuntimeActivitySnapshotMutationId,
    type RegisteredSessionStateFieldMutationV1,
    type SessionClientDurableMutationSocket,
} from './client/transport/mutations/sessionClientDurableMutationTypes';
import {
    applyRegisteredSessionStateFieldMutationToMetadata,
    resolveRegisteredSessionStateFieldMutationSettlement,
} from './client/transport/mutations/applyRegisteredSessionStateFieldMutation';
import {
    CommittedUserMessageSeqTracker,
    type CommittedUserMessageSeqListener,
} from './committedUserMessageSeqTracker';
import { loadCommittedTranscriptLocalIdBaseline } from './client/transcript/committedTranscriptLocalIdBaseline';
import { fetchCommittedTranscriptIdentitySnapshot } from './transcriptQueries';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { findTranscriptEncryptedMessageByLocalIdV2 } from './transcriptMessageLookup';
import {
    mergeLocallyConsumedUserMessageSeqsV1,
    readLocallyConsumedUserMessageSeqsV1,
} from './deliveredUserMessageSeq';
import {
    catchUpSessionMessagesViaPort,
    scheduleNextStartupCatchUpRetryViaPort,
} from './client/lifecycle/startupCatchUpRuntime';
import {
    AgentStateRequestStore,
    AgentStateResponseTargetDispatcher,
    type PermissionResponseClaim,
} from '@/agent/permissions/agentStateRequestStore';
import { HAPPIER_ACTION_REQUEST_SOURCE } from '@/agent/permissions/requestKind';
import type {
    LegacyHostSessionSystemRecord as SessionSystemRecord,
    LegacyHostSessionSystemRecordUpsertRequest as SessionSystemRecordUpsertRequest,
    SessionTurnMutationV1,
    SessionOwnerMetadataV1,
    SessionMetadataPublisherPreconditionV1,
    AccountEncryptionCurrentnessResponse,
    SessionPermissionMediationRecordIdentityV1,
    SessionPermissionMediationRecordListQuery,
    SessionPermissionMediationRecordPruneRequest,
    SessionPermissionMediationRecordStored,
    SessionPermissionMediationRecordWriteRequest,
    ComposerAttachmentInputV1,
} from '@happier-dev/protocol';
import {
    notifyComposerAttachmentsAfterMessageAccepted,
    type ComposerAttachmentMessageAcceptedNotifier,
} from '@/session/composer/notifyComposerAttachmentsAfterMessageAccepted';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { readPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { SESSION_PUBLISHER_AUTHORITY_CHECK_EVENT, SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT, SessionPublisherAuthorityCheckAckSchema, SessionPublisherAuthorityCheckRequestSchema, SessionRuntimeActivityCloseAckSchema, SessionRuntimeActivityCloseRequestSchema } from '@happier-dev/protocol/sessions/runtime/activity/transport';
import { SESSION_METADATA_LAYOUT_VERSION_V1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionActionConfirmationsV1Schema, SessionActionConfirmationResponseTargetV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionActionConfirmationsV1';
import { SessionAppliedModelV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { SessionMessageAcceptedDeliveryFactsV1Schema, type SessionMessageAcceptedDeliveryContentV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';
import { SessionRuntimeActivitySnapshotSchema } from '@happier-dev/protocol/sessions/runtime/activity/sessionRuntimeActivity';
import { SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1, SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1, SessionFollowObservePendingRequestV1Schema, SessionFollowObservePendingResponseV1Schema, SessionFollowAcknowledgeRequestV1Schema, SessionFollowAcknowledgeResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { ACCOUNT_VOICE_FOLLOW_OBSERVE_PENDING_EVENT_V1, ACCOUNT_VOICE_FOLLOW_ACKNOWLEDGE_EVENT_V1, AccountVoiceFollowObservePendingRequestV1Schema, AccountVoiceFollowObservePendingResponseV1Schema, AccountVoiceFollowAcknowledgeRequestV1Schema, AccountVoiceFollowAcknowledgeResponseV1Schema } from '@happier-dev/protocol/sessions/follow/accountVoiceFollowTransportV1';
import { SESSION_DISCUSSION_AGENT_POST_EVENT_V1, SessionDiscussionAgentPostRequestV1Schema, SessionDiscussionAgentPostResponseV1Schema } from '@happier-dev/protocol/sessions/discussions/api';
import type { SessionFollowAcknowledgeRequestV1, AccountVoiceFollowAcknowledgeRequestV1, SessionDiscussionAgentPostRequestV1 } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import type {
    SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
    applyAccountSettingsV2Update,
    refreshActiveAccountSettingsFromServer,
} from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
    supportsRuntimeActivityV2,
    supportsSessionPublisherAuthorityCheckV1,
    supportsSessionSyncPendingInputV1,
    type SessionSyncPendingInputServerContractResult,
} from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import { countMaterializablePendingRows, readKnownPendingQueueState, readPendingExecutionRunIds, UNKNOWN_PENDING_QUEUE_STATE, type KnownPendingQueueState, type PendingQueueState } from './pendingQueueState';
import type { SessionSnapshotRefreshReason } from './sessionSnapshotRefreshReason';
import type {
    LocallyConsumedUserMessageConfirmation,
    MaterializeNextPendingOptions,
    MaterializeNextPendingResult,
    RuntimeActivitySnapshotTail,
    UserMessageLocalConsumptionQuery,
} from './sessionClientPort';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import { readSessionMetadataLayoutVersion } from '@/session/metadata/sessionMetadataLayout';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import {
    fetchSessionByIdCompat,
    fetchSessionTurnsProjection,
} from '@/session/transport/http/sessionsHttp';
import { buildTrustedHostSessionInputAdmissionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { isPendingDeliveryArchivedUncertaintyReasonV1, isPendingDeliveryProviderEffectPossibleV1 } from '@happier-dev/protocol/sessions/messages/pendingDeliveryStatusV1';
import type { SessionTurnsProjectionV1 } from '@happier-dev/protocol';
import {
    fetchSessionSystemRecord as fetchSessionSystemRecordHttp,
    upsertSessionSystemRecord as upsertSessionSystemRecordHttp,
} from '@/session/transport/http/sessionSystemRecordsHttp';
import {
    listPermissionMediationRecordsHttp,
    prunePermissionMediationRecordHttp,
    readPermissionMediationRecordHttp,
    writePermissionMediationRecordHttp,
} from '@/session/transport/http/sessionPermissionMediationRecordsHttp';
import { serializeAxiosErrorForLog } from '../client/serializeAxiosErrorForLog';
import { notifyDaemonConnectedServiceTurnLifecycle as notifyDaemonConnectedServiceTurnLifecycleViaControl } from '@/daemon/controlClient';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { isActiveLatestTurnStatus, readLatestTurnStatusSnapshot } from './sessionTurnStatusSnapshot';
import {
    blockPendingQueueV2Delivery,
    blockPendingExecutionRunDelivery,
    isAcceptedPendingQueueV2DeliveryAckResponseLoss,
    listPendingQueueV2DeliveryStatusesFromServer,
    PendingQueueAcceptedSettlementError,
    readAcceptedPendingQueueV2DeliveryRetryDirective,
    resolveAcceptedPendingQueueV2Delivery,
    resolveAcceptedPendingExecutionRunDelivery,
    type PendingQueueV2DeliveryStatusEntry,
} from './pendingQueueV2Transport';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { delayUnrefAbortable } from '@/utils/time';
import type { SessionProviderInputConsumerSession } from '@/agent/runtime/session/input/_types';
import {
    isReversibleSessionProviderInputBlockReason,
    type DurableProviderInputAcceptanceV1,
    type SessionProviderInputOutcome,
} from '@/agent/runtime/session/input/providerInputOutcome';
import { updateMetadataBestEffort } from './sessionWritesBestEffort';
import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import {
    type PendingQueueRuntimeActivityProjection,
} from '@/agent/runtime/session/input/pendingQueueDrainPolicy';

const SESSION_CLIENT_TOOL_CALL_CACHE_MAX_ENTRIES = 1_000;
const SESSION_CLIENT_TRANSCRIPT_OBSERVATION_LOCAL_ID_MAX_ENTRIES = 1_000;

type AcceptedPendingSettlementOperationAuthority = Readonly<{
    sessionConnectionEpoch: number;
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    providerInputConsumer: ((message: UserMessage) => boolean | void) | null;
    abortSignal: AbortSignal;
    executionRun?: ExecutionRunPendingInputBinding;
}>;

function serializeAcceptedPendingSettlementErrorForLog(error: unknown): Record<string, unknown> {
    const serialized = serializeAxiosErrorForLog(error);
    if (!(error instanceof PendingQueueAcceptedSettlementError)) return serialized;
    return {
        ...serialized,
        code: error.code,
        settlementError: error.settlementError,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
        ...(error.correlationId ? { correlationId: error.correlationId } : {}),
    };
}

export type ExecutionRunPendingInputPort = SessionProviderInputConsumerSession & Readonly<{
    observeProviderInputSettlement: (outcome: SessionProviderInputOutcome) => Promise<boolean>;
    readDurableProviderInputAcceptanceV1: (localId: string, runId?: string) => Promise<DurableProviderInputAcceptanceV1>;
    dispose: () => void;
}>;

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
    runtimeActivityState: 'active' | 'idle' | 'unknown';
    runtimeActivityActiveCount: number;
}>;
export type StartupSessionPublisherAuthorityClaimResult =
    | Readonly<{ status: 'claimed' }>
    | Readonly<{
        status: 'unsupported';
        reason: 'publisher_authority_check_unsupported';
    }>;
type RuntimeActivityProjectionSettlement = Readonly<{
    disposition: 'applied' | 'unchanged';
    projection: Readonly<{
        runtimeActivityState: 'active' | 'idle' | 'unknown';
        runtimeActivityActiveCount: number;
        runtimeActivityObservedAt: number | null;
        runtimeActivityRevision: number;
    }>;
}>;

type RuntimeActivityProjectionForPendingDrain = PendingQueueRuntimeActivityProjection;

function clearRuntimeActivityProjectionWrite(): RuntimeActivityProjectionWrite {
    return {
        runtimeActivityState: 'unknown',
        runtimeActivityActiveCount: 0,
    };
}

function readRuntimeActivityProjectionForPendingDrain(value: unknown): RuntimeActivityProjectionForPendingDrain {
    if (!value || typeof value !== 'object') return {};
    const record = value as Record<string, unknown>;
    return {
        runtimeActivityState: record.runtimeActivityState,
        runtimeActivityActiveCount: record.runtimeActivityActiveCount,
        runtimeActivityObservedAt: record.runtimeActivityObservedAt,
        runtimeActivityRevision: record.runtimeActivityRevision,
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

    const parsed = SessionRuntimeActivitySnapshotSchema.safeParse(mutation.op.value);
    if (!parsed.success) {
        throw new Error('Malformed runtime.activity registered session state field mutation');
    }
    return {
        runtimeActivityState: parsed.data.state,
        runtimeActivityActiveCount: parsed.data.activeCount,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readRecordProperty(value: unknown, key: string): unknown {
    return isRecord(value) ? value[key] : undefined;
}

const SESSION_CONNECTION_STATE_EVENT = 'session-connection-state';
const SESSION_SYNC_SERVER_CONTRACT_EVENT = 'session-sync-server-contract';
const EXECUTION_RUN_WORKER_UPDATE_SOURCE_EVENT = 'execution-run-worker-update-source';
type SessionSocketAckWriteEvent =
    | 'session-publisher-authority-check'
    | 'session-runtime-activity-snapshot'
    | 'update-metadata'
    | 'update-state';

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

/**
 * The explicit Session metadata authority this client was constructed with.
 *
 * `owner` is the ordinary CLI/daemon composition: it holds the Account
 * credentials required to open and reseal the layout-1 owner envelope and to
 * write owner Agent state. `shared_editor` is the restricted runtime
 * composition (Lane 13 Happier Runner): it holds only the Session data key and
 * a Session-scoped runtime token, so it writes the shared projection through
 * the server's `shared_editor` tuple mode, never discovers stored Account
 * credentials, and never reaches owner metadata, owner Agent state, or
 * Account-wide surfaces.
 */
export type SessionMetadataAuthority =
    | Readonly<{
        kind: 'owner';
        credentials: StoredCredentials;
        readCurrentCredentials?: () => Promise<StoredCredentials | null>;
    }>
    | Readonly<{ kind: 'shared_editor' }>;

export class SessionOwnerAuthorityUnavailableError extends Error {
    readonly code = 'session_owner_authority_required' as const;
    readonly retryable = false as const;

    constructor(operation: string) {
        super(`${operation} requires owner Session authority`);
        this.name = 'SessionOwnerAuthorityUnavailableError';
    }
}

export type ApiSessionClientOptions = Readonly<{
    metadataAuthority: SessionMetadataAuthority;
    /** Stable execution Account from a verified restricted-runtime principal. */
    runtimePrincipalAccountId?: string;
    actionsSettingsProvider?: import('@/settings/actionsSettingsProvider').RuntimeActionSettingsProvider;
    transport: SessionClientTransport;
    getAccountEncryptionCurrentness?: () => Promise<AccountEncryptionCurrentnessResponse>;
    getBrowserDaemonControlRoutes?: (() => BrowserDaemonControlRoutes | null) | null;
    getBrowserDaemonContextRoutes?: (() => BrowserContextRoutes | null) | null;
    getBrowserDaemonAutomationRoutes?: (() => BrowserAutomationRoutes | null) | null;
    getBrowserUiAutomation?: (() => BrowserUiAutomationRouteOwner | null) | null;
    getBrowserDiagnosticsActionRoutes?: (() => BrowserDiagnosticsActionRoutes | null) | null;
    getBrowserRecordingRoutes?: (() => BrowserRecordingRoutes | null) | null;
    attachBrowserRecordingToComposer?: (
        input: BrowserRecordingComposerAttachInput,
    ) => Promise<BrowserRecordingComposerAttachResult>;
    getLocalServicesRuntimeActionRoutes?: (() => LocalServicesRuntimeActionRoutes | null) | null;
    getSimulatorPreviewRoutes?: (() => SimulatorPreviewRoutes | null) | null;
    getPeerMediationObservabilityRuntimeActionContext?: (() => DaemonPeerMediationObservabilityRuntimeActionContext | null) | null;
    getServerFeaturesSnapshot?: (() => CliServerFeaturesSnapshot | undefined) | null;
    createCapabilitiesApiClient?: NonNullable<
        Parameters<typeof registerSessionClientRuntimeHandlers>[0]
    >['createCapabilitiesApiClient'];
    transformSessionInputBeforeCommit?: (
        payload: Record<string, unknown>,
    ) => Promise<SessionInputTransformBeforeCommitResult> | SessionInputTransformBeforeCommitResult;
    afterComposerAttachmentMessageAccepted?: ComposerAttachmentMessageAcceptedNotifier;
    machineAdmissionTransport?: NonNullable<
        Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']
    >;
    localMachineId?: string | null;
    initialRegisteredSessionStateFieldMutations?: readonly RegisteredSessionStateFieldMutationV1[];
    durableMutationDeliveryInitiallyActive?: boolean;
    /** Exact destination Session update/reconnect hint for the shared host Follow reconciler. */
    onSessionFollowInvalidated?: () => void;
    /** Publishes Runner wake support only for the lifetime of the installed Session receiver. */
    installSessionFollowWakeReceiver?: () => () => void;
}>;

export class ApiSessionClient extends EventEmitter {
    private static readonly STARTUP_MESSAGE_CATCH_UP_RETRY_DELAYS_MS = [250, 1_000, 2_500] as const;

    private readonly token: string;
    readonly sessionId: string;
    private readonly workDepth: number;
    private rolePromptOrganization: Pick<import('@happier-dev/protocol').V2SessionByIdResponse['session'], 'reportsTo' | 'origin'>;
    private hostCurrentTurnFacts: Readonly<{ turnId: string; facts: import('@happier-dev/protocol').SessionTurnFactsV1 }> | null = null;
    private metadata: Metadata | null;
    private metadataLayoutVersion: number;
    private metadataVersion: number;
    /** Exact recipient-safe component of the incumbent materialized tuple. */
    private openedSharedMetadata: TranscriptOpenedSharedMetadataV1 | null = null;
    private ownerMetadata: SessionOwnerMetadataV1 | null;
    private readonly metadataAuthorityKind: SessionMetadataAuthority['kind'];
    private readonly runtimePrincipalAccountId: string | null;
    private readonly ownerCredentials: StoredCredentials | null;
    private readonly transport: SessionClientTransport;
    private readonly serverBinding: SessionClientServerBinding;
    private readonly machineAdmissionTransport: ApiSessionClientOptions['machineAdmissionTransport'];
    private readonly readInjectedOwnerCredentials: (() => Promise<StoredCredentials | null>) | null;
    private readonly getAccountEncryptionCurrentness: () => Promise<AccountEncryptionCurrentnessResponse>;
    private agentState: AgentState | null;
    private agentStateRequestStore: AgentStateRequestStore | null = null;
    private sessionActionConfirmationRequestStore: AgentStateRequestStore | null = null;
    private readonly agentStateResponseTargetDispatcher = new AgentStateResponseTargetDispatcher();
    private agentStateVersion: number;
    private ownerActivityDelivery: 'rich_sender' | 'home_required' = 'home_required';
    private socket!: Socket<ServerToClientEvents, ClientToServerEvents>;
    private userSocket: Socket<ServerToClientEvents, ClientToServerEvents> | null;
    private providerInputBacklog: UserMessage[] = [];
    private providerInputConsumer: ((message: UserMessage) => boolean | void) | null = null;
    private providerInputConsumerAttachedAtMs: number | null = null;
    readonly rpcHandlerManager: RpcHandlerManager;
    private metadataLock = new AsyncLock();
    private readonly storedContentCrypto: SessionStoredContentCryptoContext;
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
    private userSocketDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private closed = false;
    private pendingWakeSeq = 0;
    private accountSettingsSyncBarrier: Promise<boolean> | null = null;
    private accountSettingsEventRevision = 0;
    private accountSettingsHighestObservedVersion = -1;
    private snapshotSyncInFlight: Promise<boolean> | null = null;
    private readonly toolCallCanonicalNameByProviderAndId = new Map<string, { rawToolName: string; canonicalToolName: string }>();
    private readonly permissionToolCallRawInputByProviderAndId = new Map<string, unknown>();
    private readonly toolCallInputByProviderAndId = new Map<string, unknown>();
    private hasConnectedOnce = false;
    /** Bumped on every session socket connect; lets the streamed transcript writer resync after reconnects. */
    private sessionConnectionEpoch = 0;
    private sessionSyncPendingInputServerContractResult: SessionClientConnectionContractResult | null = null;
    private startupMessageCatchUpStarted = false;
    private startupMessageCatchUpRetryIndex = 0;
    private startupMessageCatchUpInitialAfterSeq = 0;
    private startupMessageCatchUpInitialAfterSeqIsExplicit = false;
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
    private readonly durableMutationOutbox: RuntimeSessionClientDurableMutationOutbox;
    private durableMutationDeliveryActive: boolean;
    private readonly initialRegisteredSessionStateFieldMutations: readonly RegisteredSessionStateFieldMutationV1[];
    private readonly committedUserMessageSeqTracker = new CommittedUserMessageSeqTracker();
    private readonly locallyConsumedUserMessageSeqs = new Set<number>();
    private runtimeActivityProjection: RuntimeActivityProjectionForPendingDrain = {};
    private readonly activeExecutionRunIds = new Set<string>();
    private readonly executionRunActivityListeners = new Set<(activeCount: number) => void>();
    private executionRunWorkerUpdateSource: Pick<import('@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge').ExecutionRunHostBridge,
        'takeWorkerUpdate' | 'waitForWorkerUpdateChange' | 'prepareWorkerUpdates'> | null = null;
    private readonly pendingSessionTurnMutationUpdates = new Set<Promise<void>>();
    private readonly pendingTranscriptMessageUpdates = new Set<Promise<unknown>>();
    private readonly locallyAuthoredTranscriptObservationUserLocalIds = new Set<string>();
    private readonly pendingProviderInputSettlementWrites = new Set<Promise<void>>();
    private readonly acceptedPendingSettlementWrites = new Set<Promise<void>>();
    // Keep witnessed detail with the existing unresolved settlement custody across reconnects.
    private readonly acceptedPendingSettlementLocalIds = new Map<string, SessionMessageAcceptedDeliveryContentV1 | undefined>();
    // Archived uncertainty is no longer eligible for queue materialization, but its exact local
    // provider custody must survive until delayed acceptance can settle the canonical server row.
    private readonly nonBlockingArchivedPendingDeliveryLocalIds = new Set<string>();
    private readonly executionRunPendingBindings = new Map<string, ExecutionRunPendingInputBinding>();
    private readonly executionRunPendingCustody = new Map<string, ExecutionRunPendingInputBinding>();
    private readonly executionRunPendingTargetListeners = new Set<(runId: string) => void | Promise<void>>();
    private readonly initialExecutionRunPendingTargetIds: readonly string[];
    private readonly acceptedPendingSettlementLocalIdsInFlight = new Set<string>();
    private readonly acceptedPendingSettlementOperationAbortController = new AbortController();
    private readonly pendingRegisteredSessionStateFieldUpdates = new Set<Promise<void>>();
    private readonly semanticSessionEndMutationId = `session-end:${randomUUID()}`;
    private endSessionAndClosePromise: Promise<void> | null = null;
    private readonly sessionRuntimeControls: Partial<SessionRuntimeControls> = {};
    readonly executionRuns: HappyMcpExecutionRunService;
    /** Existing native runtime accessor installed by applyRunnerMcpSessionContext. */
    declare getBackendTarget?: import('@/mcp/startHappyServer').HappyMcpSessionClient['getBackendTarget'];
    private sessionActionConfirmationAdapter: ReturnType<typeof createSessionActionConfirmationAdapter> | null = null;
    private sessionActionConfirmationRecovery: Promise<void> | null = null;
    private disposeSessionFollowWakeReceiver: (() => void) | null = null;
    private readonly sessionHandlersRegistration: ReturnType<typeof registerSessionClientRuntimeHandlers>;
    readonly subscribeDaemonPluginCatalogChanges: ReturnType<typeof registerPluginCatalogSignal>;

    /**
     * Returns the latest known agentState (may be stale if socket is disconnected).
     * Useful for rebuilding in-memory caches (e.g. permission allowlists) without server changes.
     */
    getAgentStateSnapshot(): AgentState | null {
        return this.agentState;
    }

    /** Refresh through the incumbent snapshot lifecycle before exposing a versioned follow projection. */
    async readOpenedSessionStateSnapshot(versions: OpenedSessionStateVersions): Promise<OpenedSessionStateSnapshot> {
        if (this.closed) {
            throw createSessionTranscriptStoredContentUnavailableError();
        }
        if (!await this.syncSessionSnapshotFromServer({ reason: 'explicit-drain' }) || this.closed) {
            throw createSessionTranscriptStoredContentUnavailableError();
        }
        const sharedMetadata = this.metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
            ? this.openedSharedMetadata
            : { version: this.metadataVersion, value: projectSessionSharedMetadataV1({ metadata: this.metadata }) };
        return {
            agentState: this.hasOwnerMetadataAuthority() && this.agentStateVersion > versions.agentStateVersion
                ? TranscriptOpenedAgentStateV1Schema.parse({ version: this.agentStateVersion, value: this.agentState }) : null,
            sharedMetadata: sharedMetadata && sharedMetadata.version > versions.sharedMetadataVersion
                ? TranscriptOpenedSharedMetadataV1Schema.parse(sharedMetadata) : null,
        };
    }

    async readSessionTurnsProjection(): Promise<SessionTurnsProjectionV1 | null> {
        return await this.runSessionRequest(async () => fetchSessionTurnsProjection({
            token: this.token,
            sessionId: this.sessionId,
        }));
    }

    getAgentStateResponseTargetDispatcher(): AgentStateResponseTargetDispatcher {
        return this.agentStateResponseTargetDispatcher;
    }

    bindAgentStateRequestStore(store: AgentStateRequestStore): void {
        this.agentStateRequestStore = store;
    }

    getAgentStateRequestStore(): AgentStateRequestStore | null {
        return this.agentStateRequestStore;
    }

    async confirmSessionAction(
        request: Parameters<ReturnType<typeof createSessionActionConfirmationAdapter>['confirm']>[0],
        binding: SessionActionConfirmationRuntimeBinding | null,
    ) {
        await this.sessionActionConfirmationRecovery;
        const adapter = this.initializeSessionActionConfirmation();
        return adapter ? await adapter.confirm(request, binding) : null;
    }

    private initializeSessionActionConfirmation() {
        const store = this.hasOwnerMetadataAuthority()
            ? this.agentStateRequestStore
            : this.getOrCreateScopedSessionActionConfirmationRequestStore();
        if (!store) return null;
        this.sessionActionConfirmationAdapter ??= createSessionActionConfirmationAdapter({
            sessionId: this.sessionId,
            store,
            sessionSignal: this.acceptedPendingSettlementOperationAbortController.signal,
            getAuthenticatedAccountId: () => this.getAuthenticatedAccountId(),
        });
        return this.sessionActionConfirmationAdapter;
    }

    private getOrCreateScopedSessionActionConfirmationRequestStore(): AgentStateRequestStore | null {
        if (this.metadataAuthorityKind !== 'shared_editor'
            || this.metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1) return null;
        this.sessionActionConfirmationRequestStore ??= new AgentStateRequestStore({
            target: {
                scopeId: this.sessionId,
                readState: () => {
                    const metadata = this.metadata && typeof this.metadata === 'object'
                        ? this.metadata as Record<string, unknown>
                        : {};
                    const parsed = SessionActionConfirmationsV1Schema.safeParse(
                        metadata.actionConfirmationsV1,
                    );
                    return parsed.success
                        ? {
                            requests: parsed.data.requests as AgentState['requests'],
                            completedRequests: parsed.data.completedRequests as AgentState['completedRequests'],
                        }
                        : { requests: {}, completedRequests: {} };
                },
                updateState: async (updater) => {
                    await this.updateMetadata((metadata) => {
                        const currentMetadata = metadata as Metadata & Record<string, unknown>;
                        const current = SessionActionConfirmationsV1Schema.safeParse(
                            currentMetadata.actionConfirmationsV1,
                        );
                        if (currentMetadata.actionConfirmationsV1 !== undefined && !current.success) {
                            throw Object.assign(new Error('Invalid Session Action confirmation projection'), {
                                code: 'metadata_privacy_upgrade_required' as const,
                                retryable: false as const,
                            });
                        }
                        const next = updater(current.success
                            ? {
                                requests: current.data.requests as AgentState['requests'],
                                completedRequests: current.data.completedRequests as AgentState['completedRequests'],
                            }
                            : { requests: {}, completedRequests: {} });
                        return {
                            ...metadata,
                            actionConfirmationsV1: SessionActionConfirmationsV1Schema.parse({
                                v: 1,
                                requests: next.requests ?? {},
                                completedRequests: next.completedRequests ?? {},
                            }),
                        } as Metadata;
                    });
                },
                getResponseTargetDispatcher: () => this.agentStateResponseTargetDispatcher,
            },
            logPrefix: '[session-action-confirmation]',
        });
        return this.sessionActionConfirmationRequestStore;
    }

    async respondToSessionActionConfirmation(
        response: Readonly<{ id: string; turnId?: string; approved: boolean; decision?: string;
            answeringClientCategory?: import('@happier-dev/protocol/sessions/permissions/respondRpcParamsV1').SessionPermissionAnsweringClientCategoryV1 }>,
        actor: import('@happier-dev/protocol').SessionPermissionAccountUserDecisionActorV1,
    ): Promise<'resolved' | 'not_found' | 'invalid'> {
        const store = this.getOrCreateScopedSessionActionConfirmationRequestStore();
        if (!store) return 'not_found';
        const responseRecord = response as unknown as Readonly<Record<string, unknown>>;
        const hasForbiddenNativeFields = ['allowedTools', 'allowTools', 'updatedPermissions', 'answers'].some(
            (key) => Object.prototype.hasOwnProperty.call(responseRecord, key),
        );
        const decision: Extract<PermissionResponseClaim, { origin: 'presentUser' }>['decision'] | null = response.approved
            ? response.decision === undefined || response.decision === 'approved' ? 'approved' : null
            : response.decision === undefined || response.decision === 'denied' ? 'denied'
                : response.decision === 'abort' ? 'abort' : null;
        const outstanding = store.readOutstandingRequest(response.id);
        if (!outstanding || outstanding.source !== HAPPIER_ACTION_REQUEST_SOURCE) {
            const completedTarget = store.readCompletedResponseTarget(response.id);
            if (!completedTarget) return 'not_found';
            if (!decision || hasForbiddenNativeFields) return 'invalid';
            const completed = store.readCompletedPermissionResponseClaim({
                requestId: response.id,
                claim: {
                    version: 1,
                    origin: 'presentUser',
                    actor,
                    ...(response.turnId ? { turnId: response.turnId } : {}),
                    decision,
                    scope: 'request',
                },
            });
            return completed.status === 'rejoined' ? 'resolved' : 'not_found';
        }
        if (hasForbiddenNativeFields) return 'invalid';
        const target = SessionActionConfirmationResponseTargetV1Schema.safeParse(outstanding.responseTarget);
        if (!target.success || !decision || response.turnId !== target.data.turnId) return 'invalid';
        if (await this.getAuthenticatedAccountId() !== target.data.runtimeAccountId) return 'not_found';
        const claim = {
            version: 1 as const,
            origin: 'presentUser' as const,
            actor,
            turnId: target.data.turnId,
            decision,
            scope: 'request' as const,
        };
        const acquired = await store.acquirePermissionResponseClaim({ requestId: response.id, claim });
        if (acquired.status === 'conflict') return 'not_found';
        if (acquired.status === 'not_pending') {
            return store.readCompletedPermissionResponseClaim({ requestId: response.id, claim }).status === 'rejoined'
                ? 'resolved'
                : 'not_found';
        }
        const runtimeStillCurrent = await this.getAuthenticatedAccountId() === target.data.runtimeAccountId;
        const completed = await store.completeRequest({
            requestId: response.id,
            status: decision === 'approved' ? 'approved' : 'denied',
            decision,
            extraCompletedFields: { permissionDecisionActorV1: actor,
                ...(response.answeringClientCategory ? { answeringClientCategory: response.answeringClientCategory } : {}) },
            isCurrent: () => runtimeStillCurrent,
        });
        if (!completed) {
            await store.releasePermissionResponseClaim({ requestId: response.id, claim });
            return 'not_found';
        }
        return 'resolved';
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

    private isSessionSocketOnlineForAckWrite(): boolean {
        return (this.socket as Socket<ServerToClientEvents, ClientToServerEvents> | undefined)?.connected === true
            || this.currentConnectionState.phase === 'online';
    }

    private markLocallyAuthoredTranscriptObservationUserLocalId(localId: string): void {
        this.locallyAuthoredTranscriptObservationUserLocalIds.delete(localId);
        this.locallyAuthoredTranscriptObservationUserLocalIds.add(localId);
        while (
            this.locallyAuthoredTranscriptObservationUserLocalIds.size
            > SESSION_CLIENT_TRANSCRIPT_OBSERVATION_LOCAL_ID_MAX_ENTRIES
        ) {
            const oldest = this.locallyAuthoredTranscriptObservationUserLocalIds.values().next().value;
            if (typeof oldest !== 'string') break;
            this.locallyAuthoredTranscriptObservationUserLocalIds.delete(oldest);
        }
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

        // The transport owns each connect attempt's budget. Offline startup
        // stays with its reconnect supervisor until online, auth failure or
        // Session disposal; it is not another failed connect attempt.
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
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

            void ensureSessionConnectionSupervisionActive(supervisor).catch((error) => {
                settle(() => reject(error));
            });
            check();
        });
    }

    private applyPendingDeliveryActionQueueState(state: KnownPendingQueueState | null | undefined): void {
        if (!state) return;
        if (this.materializationRuntime.applyPendingQueueState(state)) {
            this.emit('metadata-updated');
        }
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

    private deliverUserMessageToAgentQueue(
        prompt: UserMessage,
        providerAction?: import('@happier-dev/protocol').PendingProviderAction | null,
        requestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1,
    ): boolean {
        const localId = readPendingLocalId(prompt.localId);
        const deliveredPrompt = providerAction || requestedAction
            ? {
                ...prompt,
                ...(providerAction ? { pendingProviderAction: providerAction } : {}),
                ...(requestedAction ? { pendingRequestedAction: requestedAction } : {}),
            }
            : prompt;
        if (localId !== null) {
            this.materializationRuntime.markAgentQueueEchoSuppressedLocalId(localId);
        }
        if (this.providerInputConsumer) {
            const delivered = this.providerInputConsumer(deliveredPrompt) !== false;
            if (!delivered && localId !== null) {
                this.materializationRuntime.clearAgentQueueEchoSuppressedLocalId(localId);
            }
            return delivered;
        }
        this.providerInputBacklog.push(deliveredPrompt);
        return true;
    }

	    constructor(token: string, session: Session, options: ApiSessionClientOptions) {
	        super()
	        this.token = token;
	        this.transport = options.transport;
            this.machineAdmissionTransport = options.machineAdmissionTransport;
	        this.serverBinding = Object.freeze({
                serverId: options.transport.serverId,
                serverUrl: options.transport.serverUrl,
            });
	        this.sessionId = session.id;
            this.workDepth = session.workDepth ?? 0;
            this.rolePromptOrganization = {
                ...(session.reportsTo ? { reportsTo: session.reportsTo } : {}),
                ...(session.origin ? { origin: session.origin } : {}),
            };
	        this.initialExecutionRunPendingTargetIds = readPendingExecutionRunIds(session) ?? [];
	        this.metadata = session.metadata;
            this.metadataLayoutVersion = readSessionMetadataLayoutVersion(session.metadataLayoutVersion);
	        this.metadataVersion = session.metadataVersion;
            this.ownerMetadata = session.ownerMetadata ?? null;
            const metadataAuthority = options.metadataAuthority;
            this.metadataAuthorityKind = metadataAuthority.kind;
            this.runtimePrincipalAccountId = metadataAuthority.kind === 'shared_editor'
                ? options.runtimePrincipalAccountId || null
                : null;
            this.ownerCredentials = metadataAuthority.kind === 'owner'
                ? metadataAuthority.credentials
                : null;
            this.readInjectedOwnerCredentials = metadataAuthority.kind === 'owner'
                ? metadataAuthority.readCurrentCredentials ?? null
                : null;
            this.getAccountEncryptionCurrentness = options.getAccountEncryptionCurrentness
                ?? (async () => await this.runSessionRequest(async () => fetchAccountEncryptionCurrentness({ token: this.token })));
            this.storedContentCrypto = session.encryptionMode === 'plain'
                ? { mode: 'plain', ctx: null }
                : {
                    mode: 'e2ee',
                    ctx: {
                        encryptionKey: session.encryptionKey,
                        encryptionVariant: session.encryptionVariant,
                    },
                };
	        this.agentState = session.agentState;
	        this.agentStateVersion = session.agentStateVersion;
            this.initialRegisteredSessionStateFieldMutations = [
                ...(options.initialRegisteredSessionStateFieldMutations ?? []),
            ];
            this.durableMutationDeliveryActive = options.durableMutationDeliveryInitiallyActive !== false;
            this.applyRuntimeActivityProjectionFromServer(session);
            this.usageObservationPublisher = createSessionClientUsageObservationPublisher({
                token: this.token,
                transport: options.transport,
                getSessionMetadata: () => this.metadata,
                getSocket: () => ({
                    connected: this.socket?.connected ?? false,
                    emit: (event, report) => {
                        this.socket?.emit?.(event, report as never);
                    },
                }),
            });
            this.executionRuns = createSessionClientExecutionRunService({
            serverUrl: this.transport.serverUrl,
                token: this.token,
                sessionId: this.sessionId,
                getStoredContentCryptoContext: () => this.storedContentCrypto,
            });
            this.turnAssistantTextSnapshotStore = createTurnAssistantTextSnapshotStore({
                maxTextChars: configuration.readyNotificationAssistantTextMaxChars,
            });
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
        this.startedByDaemonProcess = (() => {
            const idx = process.argv.lastIndexOf('--started-by');
            if (idx < 0) return false;
            const value = process.argv[idx + 1];
            return value === 'daemon';
        })();
        this.materializationRuntime = createSessionClientMaterializationRuntime({
            onKeepAliveStateMayHaveChanged: () => this.maybeScheduleUserSocketDisconnect(),
            initialPendingQueueState: readKnownPendingQueueState(session) ?? UNKNOWN_PENDING_QUEUE_STATE,
            initialLatestTurnStatus: readLatestTurnStatusSnapshot((session as { latestTurnStatus?: unknown }).latestTurnStatus),
            initialLatestTurnStatusObservedAt: (() => {
                const value = (session as { latestTurnStatusObservedAt?: unknown }).latestTurnStatusObservedAt;
                return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
            })(),
        });
        this.updateRuntime = createSessionClientUpdateRuntime({
            sessionId: this.sessionId,
            ...this.storedContentCrypto,
            getMetadataLayoutVersion: () => this.metadataLayoutVersion,
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
            syncMetadataEnvelopeTupleFromServer: async () => {
                await this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
            },
            getPendingQueueState: () => this.materializationRuntime.getPendingQueueState(),
            applyPendingQueueState: (state) => this.materializationRuntime.applyPendingQueueState(state),
            onPendingChangedDrainTrigger: (state, recipient) => {
                logger.debug('[pendingQueue] pending-changed drain trigger', {
                    sessionId: this.sessionId,
                    pendingCount: state.pendingCount,
                    pendingBlockedCount: state.pendingBlockedCount,
                    pendingVersion: state.pendingVersion,
                });
                if (!recipient) {
                    void this.reconcilePendingProviderInputCustodyBeforeMaterialization();
                    return;
                }
                void this.notifyExecutionRunPendingTarget(recipient.runId).catch((error) => {
                    logger.debug('[pendingQueue] execution-run target reconciliation failed closed', {
                        sessionId: this.sessionId,
                        runId: recipient.runId,
                        error: serializeAxiosErrorForLog(error),
                    });
                });
            },
            onConnectedServiceTurnLifecycleEvent: (event) => {
                void this.notifyDaemonConnectedServiceTurnLifecycle(event);
            },
            emit: (event, payload) => this.emit(event, payload),
            markAgentQueueEchoSuppressedLocalId: (localId) => this.materializationRuntime.markAgentQueueEchoSuppressedLocalId(localId),
            turnAssistantTextSnapshotStore: this.turnAssistantTextSnapshotStore,
            observeCommittedUserMessageSeq: ({ localId, seq }) => {
                this.recordCommittedUserMessageSeq(localId, seq);
            },
            consumeLocallyAuthoredTranscriptObservationLocalId: (localId) =>
                this.locallyAuthoredTranscriptObservationUserLocalIds.delete(localId),
            onRuntimeActivityProjectionFromServer: (projection) => {
                this.applyRuntimeActivityProjectionFromServer(projection);
            },
            initialLastObservedMessageSeq:
                typeof session.seq === 'number' && Number.isFinite(session.seq) && session.seq >= 0
                    ? Math.trunc(session.seq)
                    : 0,
        });
        this.recoveryRuntime = createSessionClientRecoveryRuntime({
            ...this.storedContentCrypto,
            startupMessageCatchUpRetryDelaysMs: ApiSessionClient.STARTUP_MESSAGE_CATCH_UP_RETRY_DELAYS_MS,
            token: this.token,
            serverUrl: this.transport.serverUrl,
            accountChangesEnabled: this.hasOwnerMetadataAuthority(),
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
            getLastObservedMessageSeq: () => this.updateRuntime.getLastObservedMessageSeq(),
            handleUpdate: (update, opts) => this.updateRuntime.handleUpdate(update, opts),
            syncSessionSnapshotFromServer: (opts) => this.syncSessionSnapshotFromServer(opts),
            applyPendingQueueState: (state) => {
                if (this.materializationRuntime.applyPendingQueueState(state)) {
                    this.emit('metadata-updated');
                }
            },
            reconcilePendingExecutionRunTarget: (runId) => this.notifyExecutionRunPendingTarget(runId),
        });
        this.commitQueueRuntime = createSessionClientCommitQueueRuntime({
            serverUrl: this.transport.serverUrl,
            token: this.token,
            sessionId: this.sessionId,
            transcriptStorage: this.transcriptStorage,
            ...this.storedContentCrypto,
            getSocket: () => this.socket,
            getClosed: () => this.closed,
            addPendingMaterializedLocalId: (localId) => this.materializationRuntime.addPendingMaterializedLocalId(localId),
            hasPendingMaterializedLocalId: (localId) => this.materializationRuntime.hasMaterializedLocalId(localId),
            markCommittedLocalIdAwaitingEcho: (localId) => this.materializationRuntime.markCommittedLocalIdAwaitingEcho(localId),
            deleteMaterializedLocalId: (localId) => this.deletePendingProviderInputLocalState(localId),
            observeCommittedAck: (params) => this.updateRuntime.observeCommittedAck(params),
            requestReconnect: (localId) => {
                const supervisor = this.sessionConnectionSupervisor;
                if (!supervisor) return;
                void ensureSessionConnectionSupervisionActive(supervisor).catch((error) => {
                    logger.debug('[API] Failed to activate session socket supervision for queued message', {
                        localId,
                        error: serializeAxiosErrorForLog(error),
                    });
                });
            },
        });
        this.durableMutationOutbox = createRuntimeSessionClientDurableMutationOutbox({
            serverUrl: this.transport.serverUrl,
            token: this.token,
            sessionId: this.sessionId,
            initialRegisteredSessionStateFieldMutations: this.initialRegisteredSessionStateFieldMutations,
            flushOnReady: false,
            initiallyActive: options.durableMutationDeliveryInitiallyActive,
            getSocket: () => adaptDurableMutationSocket(this.socket),
            onTranscriptMessageDeliveryAttempt: (mutation) => {
                if (mutation.messageRole === 'user') {
                    this.markLocallyAuthoredTranscriptObservationUserLocalId(mutation.localId);
                }
            },
            deliverRegisteredSessionStateFieldMutation: async (mutation) => {
                const runtimeActivityProjection = readRuntimeActivityProjectionWriteFromRegisteredMutation(mutation);
                if (runtimeActivityProjection) {
                    const settlement =
                        await this.updateRuntimeActivityProjectionExact(
                            runtimeActivityProjection,
                            mutation.mutationId,
                        );
                    return {
                        delivered: true,
                        settlement: {
                            status: settlement.disposition,
                            committedProjection: {
                                state: settlement.projection.runtimeActivityState,
                                activeCount: settlement.projection.runtimeActivityActiveCount,
                                observedAt: settlement.projection.runtimeActivityObservedAt,
                                revision: settlement.projection.runtimeActivityRevision,
                            },
                            committedRevision: settlement.projection.runtimeActivityRevision,
                        },
                    };
                }
                await this.updateMetadata((metadata) => applyRegisteredSessionStateFieldMutationToMetadata(
                    metadata,
                    mutation,
                ), { expectedMetadataRevision: mutation.expectedMetadataRevision });
                this.emit('metadata-updated');
                return {
                    delivered: true,
                    settlement: resolveRegisteredSessionStateFieldMutationSettlement(
                        this.metadata ?? ({} as Metadata),
                        mutation,
                    ),
                };
            },
            requestReconnect: (reason) => {
                const supervisor = this.sessionConnectionSupervisor;
                if (!supervisor) return;
                void ensureSessionConnectionSupervisionActive(supervisor).catch((error) => {
                    logger.debug('[API] Failed to activate session socket supervision for queued durable mutation', {
                        reason,
                        error: serializeAxiosErrorForLog(error),
                    });
                });
            },
        });
        const notifyComposerAttachmentsAfterDurableAdmission = (params: Readonly<{
            localId: string;
            attachments: readonly ComposerAttachmentInputV1[];
        }>): void => {
            notifyComposerAttachmentsAfterMessageAccepted({
                sessionId: this.sessionId,
                localId: params.localId,
                attachments: params.attachments,
                notify: options.afterComposerAttachmentMessageAccepted,
                signal: this.acceptedPendingSettlementOperationAbortController.signal,
            });
        };
        this.transcriptApi = createSessionClientTranscriptApi({
            serverUrl: this.transport.serverUrl,
            serverId: this.serverBinding.serverId,
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
            getEphemeralStreamConnectionEpoch: () => this.getEphemeralStreamConnectionEpoch(),
            getSessionConnectionSupervisor: () => this.sessionConnectionSupervisor,
            getLatestTurnSnapshot: () => this.materializationRuntime.getLatestTurnSnapshot(),
            getActiveLocalTurnProgressAt: () => this.materializationRuntime.getActiveLocalTurnProgressAt(),
            onPresence: (presence) => this.emit('local-presence', presence),
            getMetadataSnapshot: () => this.getMetadataSnapshot(),
            updateAgentState: (handler) => this.updateAgentState(handler),
            updateMetadata: (handler) => this.updateMetadata(handler),
            enqueueCommittedTranscriptMessage: (params) =>
                this.durableMutationOutbox.enqueueTranscriptMessage(
                    createTranscriptMessageAppendMutation({
                        sessionId: this.sessionId,
                        localId: params.localId,
                        content: params.message,
                        sidechainId: params.sidechainId,
                        messageRole: params.messageRole,
                        sessionEventType: params.sessionEventType,
                        createdAt: params.createdAt,
                        updatedAt: params.updatedAt,
                        provenance: params.provenance,
                        ...(params.surfaceItemReference === undefined ? {} : { surfaceItemReference: params.surfaceItemReference }),
                    }),
                    params.admission === undefined ? undefined : { admission: params.admission },
                ),
            enqueueCommittedVoiceAgentTranscriptTurn: (params) => {
                const user = createTranscriptMessageAppendMutation({
                    sessionId: this.sessionId,
                    localId: params.user.localId,
                    content: params.user.message,
                    sidechainId: params.user.sidechainId,
                    messageRole: params.user.messageRole,
                    sessionEventType: params.user.sessionEventType,
                    createdAt: params.user.createdAt,
                    updatedAt: params.user.updatedAt,
                    provenance: params.user.provenance,
                });
                const assistant = createTranscriptMessageAppendMutation({
                    sessionId: this.sessionId,
                    localId: params.assistant.localId,
                    content: params.assistant.message,
                    sidechainId: params.assistant.sidechainId,
                    messageRole: params.assistant.messageRole,
                    sessionEventType: params.assistant.sessionEventType,
                    createdAt: params.assistant.createdAt,
                    updatedAt: params.assistant.updatedAt,
                    provenance: params.assistant.provenance,
                });
                return this.durableMutationOutbox.enqueueVoiceAgentTranscriptTurn(
                    createVoiceAgentTranscriptTurnMutation({
                        sessionId: this.sessionId,
                        turnId: params.turnId,
                        user,
                        assistant,
                        observedAt: params.observedAt,
                    }),
                );
            },
            usageObservationPublisher: this.usageObservationPublisher,
            buildOutboundSessionMessagePayload: (content) => this.commitQueueRuntime.buildOutboundSessionMessagePayload(content),
            toolCallCanonicalNameByProviderAndId: this.toolCallCanonicalNameByProviderAndId,
            permissionToolCallRawInputByProviderAndId: this.permissionToolCallRawInputByProviderAndId,
            toolCallInputByProviderAndId: this.toolCallInputByProviderAndId,
            maxToolCallCacheEntries: SESSION_CLIENT_TOOL_CALL_CACHE_MAX_ENTRIES,
            transformSessionInputBeforeCommit: options.transformSessionInputBeforeCommit,
            findPersistedSessionUserMessageAdmission: ({ localId }) =>
                this.runSessionRequest(async () => findPersistedSessionUserMessageAdmission({
                    token: this.token,
                    sessionId: this.sessionId,
                    localId,
                    queryContext: this.getTranscriptQueryContext(),
                })),
            admitSessionUserMessage: async ({
                callerInputAuthorization,
                localId,
                text,
                meta,
                composerAttachments,
                requestedAction,
                recipient,
                settlement,
                inputAdmission,
            }) => {
                const settle = async (
                    phase: 'onAccepted' | 'onDefinitiveAdmissionFailure',
                ): Promise<void> => {
                    const callback = settlement?.[phase];
                    if (!callback) return;
                    try {
                        await callback();
                    } catch (error) {
                        logger.debug('[session-input] Post-admission staged media settlement failed', {
                            localId,
                            phase,
                            error: serializeAxiosErrorForLog(error),
                        });
                    }
                };
                const credentials = await this.readCurrentOwnerCredentials();
                if (!credentials) {
                    // No admission request can be made without the current
                    // Account authority. This is definitive (unlike an
                    // acknowledgement timeout), so release any staged-media
                    // custody before surfacing the failure. A shared editor
                    // never authors Session user input on the Account's behalf.
                    await settle('onDefinitiveAdmissionFailure');
                    if (!this.hasOwnerMetadataAuthority()) {
                        throw new SessionOwnerAuthorityUnavailableError(
                            'Session user-input admission',
                        );
                    }
                    throw new Error('Current Account credentials are required to admit Session user input');
                }
                const installation = callerInputAuthorization ? readInstallationIdentityIfExistsSync() : null;
                if (callerInputAuthorization && !installation) {
                    await settle('onDefinitiveAdmissionFailure');
                    return { status: 'rejected', code: 'session_input_unauthorized' };
                }
                const resolveAuthorizationHeaders = callerInputAuthorization && installation
                    ? (request: Readonly<{ method: string; path: string; body?: unknown }>) =>
                        createExternalActionAuthorizedRequestHeaders({
                            authorization: callerInputAuthorization, effectActionId: 'session.message.send',
                            target: { kind: 'session', sessionId: this.sessionId },
                            installationId: installation.installationId, privateKey: installation.privateKey,
                            ...request,
                        })
                    : undefined;
                const result = await this.runSessionRequest(async () => sendSessionMessage({
                    ...(callerInputAuthorization ? { callerInputAuthorization } : {}),
                    ...(resolveAuthorizationHeaders ? { resolveAuthorizationHeaders } : {}),
                    credentials,
                    idOrPrefix: this.sessionId,
                    message: text,
                    messageMeta: meta,
                    localId,
                    requestedAction: requestedAction ?? { v: 1, kind: 'enqueue' },
                    ...(recipient ? { recipient } : {}),
                    inputAdmission: inputAdmission ?? buildTrustedHostSessionInputAdmissionV1('ui'),
                    wait: false,
                    timeoutMs: 30_000,
                    ...(options.machineAdmissionTransport
                        ? {
                            machineAdmissionTransport:
                                options.machineAdmissionTransport,
                        }
                        : {}),
                    signal:
                        this.acceptedPendingSettlementOperationAbortController
                            .signal,
                }));
                const admissionResult = result.admissionResult;
                if (
                    admissionResult.status === 'accepted'
                    || admissionResult.status === 'alreadyAccepted'
                ) {
                    // Durable acceptance is the contractual trigger. The
                    // acceptance notification is best effort and starts here,
                    // ahead of the staged-media settlement round trip whose
                    // budget is minutes; neither failure reverses acceptance.
                    notifyComposerAttachmentsAfterDurableAdmission({
                        localId,
                        attachments: composerAttachments,
                    });
                    // Releasing the transfer stage is cleanup after the
                    // canonical persisted fact. Start it best-effort, but do
                    // not make an already accepted Message wait for the daemon
                    // cleanup round trip before its caller can observe success.
                    void settle('onAccepted');
                    return admissionResult;
                }
                if (admissionResult.status === 'outcomeUnknown') {
                    // The machine may already have admitted this exact local id. Preserve both
                    // the transfer stage and any just-created durable media for reconciliation;
                    // only an explicit rejected result is a safe cleanup boundary.
                    return admissionResult;
                }
                await settle('onDefinitiveAdmissionFailure');
                return admissionResult;
            },
            getTranscriptQueryContext: () =>
                this.getTranscriptQueryContext(),
        });

        // Initialize RPC handler manager
        const rpcTransportConfig = this.storedContentCrypto.mode === 'plain'
            ? { encryptionMode: 'plain' as const }
            : {
                encryptionMode: 'e2ee' as const,
                encryptionKey: this.storedContentCrypto.ctx.encryptionKey,
                encryptionVariant: this.storedContentCrypto.ctx.encryptionVariant,
            };
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            localMachineId: options.localMachineId,
            ...rpcTransportConfig,
            logger: (msg, data) => logger.debug(msg, data),
            onRegistrationError: (error) => {
                const probe = classifyTransportErrorToProbeResult(error);
                const supervisor = this.sessionConnectionSupervisor;
                const scope = supervisor?.captureProbeReportScope?.();
                if (probe && scope) {
                    supervisor?.reportProbeResult?.(probe, scope);
                }
            },
        });
        this.subscribeDaemonPluginCatalogChanges = registerPluginCatalogSignal({ rpcHandlerManager: this.rpcHandlerManager, events: this });
        this.sessionHandlersRegistration = registerSessionClientRuntimeHandlers({
            rpcHandlerManager: this.rpcHandlerManager,
            token: this.token,
            ...this.serverBinding,
            ...(this.runtimePrincipalAccountId
                ? { runtimePrincipalAccountId: this.runtimePrincipalAccountId }
                : {}),
            readOwnerAccountCredentials: () => this.readCurrentOwnerCredentials(),
            ...(options.actionsSettingsProvider ? { actionsSettingsProvider: options.actionsSettingsProvider } : {}),
            metadataPath: this.metadata?.path ?? process.cwd(),
            metadata: this.metadata,
            sessionId: this.sessionId,
            session: this,
            getSessionMetadata: () => this.getMetadataSnapshot(),
            sessionRuntimeControls: this.sessionRuntimeControls,
            enqueueSessionUserMessage: (request) => this.enqueueSessionUserMessage(request),
            enqueueUserTextMessageCommitted: (text, opts) => this.enqueueUserTextMessageCommitted(text, opts),
            enqueueAgentMessageCommitted: (provider, body, opts) =>
                this.enqueueAgentMessageCommitted(provider, body, opts),
            enqueueVoiceAgentTranscriptTurnCommitted: (provider, params) =>
                this.enqueueVoiceAgentTranscriptTurnCommitted(provider, params),
            sendAgentMessageEphemeral: (provider, body, opts) => this.sendAgentMessageEphemeral(provider, body, opts),
            sendAgentMessageEphemeralDelta: (provider, body, opts) => this.sendAgentMessageEphemeralDelta(provider, body, opts),
            getEphemeralStreamConnectionEpoch: () => this.getEphemeralStreamConnectionEpoch(),
            enqueueRegisteredSessionStateFieldMutation: (mutation) =>
                this.enqueueRegisteredSessionStateFieldMutation(mutation),
            getTranscriptQueryContext: () =>
                this.getTranscriptQueryContext(),
            getAgentStateRequestStore: () => this.getAgentStateRequestStore(),
            getBrowserDaemonControlRoutes: options.getBrowserDaemonControlRoutes ?? null,
            getBrowserDaemonContextRoutes: options.getBrowserDaemonContextRoutes ?? null,
            getBrowserDaemonAutomationRoutes: options.getBrowserDaemonAutomationRoutes ?? null,
            getBrowserUiAutomation: options.getBrowserUiAutomation ?? null,
            getBrowserDiagnosticsActionRoutes: options.getBrowserDiagnosticsActionRoutes ?? null,
            getBrowserRecordingRoutes: options.getBrowserRecordingRoutes ?? null,
            attachBrowserRecordingToComposer: options.attachBrowserRecordingToComposer,
            getLocalServicesRuntimeActionRoutes: options.getLocalServicesRuntimeActionRoutes ?? null,
            getSimulatorPreviewRoutes: options.getSimulatorPreviewRoutes ?? null,
            getPeerMediationObservabilityRuntimeActionContext:
                options.getPeerMediationObservabilityRuntimeActionContext ?? null,
            getServerFeaturesSnapshot: options.getServerFeaturesSnapshot ?? null,
            createCapabilitiesApiClient: options.createCapabilitiesApiClient,
            persistVoiceAgentRunMetadataFromPublicRun: (run, welcomedEpoch) =>
                this.persistVoiceAgentRunMetadataFromPublicRun(run, welcomedEpoch),
            observeExecutionRunPublicState: (run) => this.observeExecutionRunPublicState(run),
            socketEmitExecutionRunUpdated: (run) => {
                if (!this.socket?.connected) {
                    return;
                }
                this.socket.emit('execution-run-updated', { sid: this.sessionId, run } as never);
            },
        });

        this.interactionApi = createSessionClientInteractionApi({
            serverUrl: this.transport.serverUrl,
            sessionId: this.sessionId,
            token: this.token,
            getClosed: () => this.closed,
            setClosed: (value) => {
                this.closed = value;
            },
            getSocket: () => this.socket,
            getSessionConnectionEpoch: () => this.sessionConnectionEpoch,
            getSessionSyncPendingInputServerContractResult: () =>
                this.sessionSyncPendingInputServerContractResult,
            getUserSocket: () => this.userSocket,
            getSessionConnectionSupervisor: () => this.sessionConnectionSupervisor,
            getRpcHandlerManager: () => this.rpcHandlerManager,
            getMetadata: () => this.metadata,
            updateMetadata: (updater) => this.updateMetadata(updater),
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
            getRuntimeActivityRevision: () => typeof this.runtimeActivityProjection.runtimeActivityRevision === 'number'
                ? this.runtimeActivityProjection.runtimeActivityRevision
                : null,
            getPendingWakeSeq: () => this.updateRuntime.getPendingWakeSeq() + this.pendingWakeSeq,
            getProviderInputBacklog: () => this.providerInputBacklog,
            setProviderInputConsumer: (callback) => {
                this.providerInputConsumer = callback;
            },
            getProviderInputConsumerAttachedAtMs: () => this.providerInputConsumerAttachedAtMs,
            setProviderInputConsumerAttachedAtMs: (value) => {
                this.providerInputConsumerAttachedAtMs = value;
            },
            wakePendingMaterialization: () => this.wakePendingMaterialization(),
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
                this.startupMessageCatchUpInitialAfterSeqIsExplicit = this.startupMessageCatchUpExplicitAfterSeq !== null;
            },
            enqueueSessionUserMessage: (params) => this.enqueueSessionUserMessage(params),
            syncSessionSnapshotFromServer: (opts) =>
                this.syncSessionSnapshotFromServer(opts),
            reconcileTurnStatusBeforePendingMaterialization: () =>
                this.reconcileTurnStatusBeforePendingMaterializationIfNeeded(),
            logPendingMaterializationSkip: (stage) => this.logPendingMaterializationSkip(stage),
            maybeScheduleUserSocketDisconnect: () => this.maybeScheduleUserSocketDisconnect(),
            handleSessionScopedUpdate: (data) => this.updateRuntime.handleUpdate(data, {
                source: 'session-scoped',
            }),
            onSessionFollowInvalidated: () => {
                // The existing exact-Session hint also invalidates its live
                // worker relation. Keep immutable origin, but never use a
                // detached relation while the existing snapshot owner refreshes.
                this.rolePromptOrganization = {
                    ...(this.rolePromptOrganization.origin ? { origin: this.rolePromptOrganization.origin } : {}),
                };
                // Snapshot failures are already logged by the owner. A prompt
                // reader awaiting the in-flight refresh still sees typed
                // privacy failures; the socket hint itself has no awaiter.
                void this.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' }).catch(() => undefined);
                options.onSessionFollowInvalidated?.();
            },
            deliverMaterializedUserMessageToAgentQueue: (message, providerAction, requestedAction) =>
                this.deliverUserMessageToAgentQueue(message, providerAction, requestedAction),
            clearStartupMessageCatchUpRetryTimer: () => this.recoveryRuntime.clearStartupMessageCatchUpRetryTimer(),
            clearCommittedLocalIdCleanupTimers: () => this.materializationRuntime.clearCommittedLocalIdCleanupTimers(),
            clearPendingMaterializedState: () => {
                this.materializationRuntime.clearPendingMaterializedState();
                this.nonBlockingArchivedPendingDeliveryLocalIds.clear();
                this.commitQueueRuntime.clearState();
            },
            getPendingQueueMaterializedLocalIdsSize: () => [...this.materializationRuntime.pendingQueueMaterializedLocalIds]
                .filter((localId) => !this.executionRunPendingCustody.has(localId)).length,
            markPendingQueueMaterializedLocalId: (localId) =>
                this.materializationRuntime.markPendingQueueMaterializedLocalId(localId),
            shouldAttemptPendingMaterialization: () => this.materializationRuntime.shouldAttemptPendingMaterialization(),
            resolvePendingClaimDeliveryTiming: (requested) =>
                this.accountSettingsSyncBarrier !== null ? 'after_runtime_idle' : requested,
            getPendingQueueState: () => this.materializationRuntime.getPendingQueueState(),
            applyPendingQueueState: (state) => this.materializationRuntime.applyPendingQueueState(state),
            observePendingMaterializeResult: (params) => this.materializationRuntime.observeMaterializeResult(params),
            onPendingQueueStateChanged: () => {
                this.emit('metadata-updated');
            },
            getStoredContentCryptoContext: () => this.storedContentCrypto,
        });
        this.sessionRuntimeControls.wakePendingMaterialization = () => this.wakePendingMaterialization();
        this.sessionRuntimeControls.preparePendingMessageComposerAdmission = async (request) => (
            await this.transcriptApi.preparePendingMessageComposerAdmission(request)
        );

        const { userSocket, sessionConnectionSupervisor } = initializeSessionClientConnection({
            token: this.token,
            transport: options.transport,
            sessionId: this.sessionId,
            localMachineId: options.localMachineId,
            userScopedAccountUpdates: this.hasOwnerMetadataAuthority(),
            getMetadataSnapshot: () => this.metadata,
            setSessionSocket: (socket) => {
                this.socket = socket;
            },
            rpcHandlerManager: this.rpcHandlerManager,
            handleUserScopedUpdate: (data, socket) => this.handleUserScopedUpdate(data, socket),
            installSessionSocketEventHandlers: (socket) => this.interactionApi.installSessionSocketEventHandlers(socket),
            classifyTransportErrorToProbeResult,
            onStateChange: (state) => {
                this.currentConnectionState = state;
                this.emit(SESSION_CONNECTION_STATE_EVENT, state);
            },
            shouldKeepUserSocketConnected: () =>
                this.materializationRuntime.shouldKeepUserSocketConnected({
                    hasProviderInputConsumer: this.providerInputConsumer !== null,
                    hasQueuedDisconnectedSessionMessages: this.commitQueueRuntime.queuedDisconnectedSessionMessages.size > 0,
                }),
            kickUserSocketConnect: () => this.kickUserSocketConnect(),
            syncChangesOnConnect: async (opts) => {
                await this.recoveryRuntime.syncChangesOnConnect(opts);
            },
            shouldSyncSessionSnapshotOnConnect: () =>
                shouldSyncSessionSnapshotOnConnect({ metadataVersion: this.metadataVersion, agentStateVersion: this.agentStateVersion }),
            syncSessionSnapshotFromServer: async (opts) => {
                await this.syncSessionSnapshotFromServer(opts);
            },
            flushQueuedSessionMessagesOnReconnect: () => this.commitQueueRuntime.flushQueuedSessionMessagesOnReconnect(),
            flushDurableSessionMutationsOnReconnect: () => this.durableMutationOutbox.flush('connect'),
            reofferAcceptedProviderInputSettlementsAfterConnection: () => {
                this.reofferAcceptedProviderInputSettlementsAfterConnection();
            },
            replayLatestSessionPresenceOnReconnect: () => this.transcriptApi.replayLatestPresence(),
            markConnected: () => {
                this.sessionConnectionEpoch += 1;
                const reason = this.hasConnectedOnce ? 'reconnect' : 'connect';
                this.hasConnectedOnce = true;
                return { reason, epoch: this.sessionConnectionEpoch };
            },
            prepareSessionSyncPendingInputServerContractResult: async (result) => {
                await this.durableMutationOutbox.setSessionSyncPendingInputServerContract(result);
                if (
                    !this.durableMutationDeliveryActive
                    || !supportsRuntimeActivityV2(result)
                    || !supportsSessionSyncPendingInputV1(result)
                ) {
                    return;
                }
                const tail = this.durableMutationOutbox.readRuntimeActivitySnapshotTail();
                const desired = tail.custody?.value ?? tail.settlement?.desiredValue ?? (() => {
                    for (const mutation of this.initialRegisteredSessionStateFieldMutations) {
                        const projection = readRuntimeActivityProjectionWriteFromRegisteredMutation(mutation);
                        if (projection) {
                            return {
                                state: projection.runtimeActivityState,
                                activeCount: projection.runtimeActivityActiveCount,
                            } as const;
                        }
                    }
                    return null;
                })();
                if (!desired) return;
                await this.durableMutationOutbox.enqueueRegisteredSessionStateFieldMutation({
                    v: 1,
                    sessionId: this.sessionId,
                    mutationId: resolveRuntimeActivitySnapshotMutationId(this.sessionId),
                    fieldId: 'runtime.activity',
                    deliveryClass: 'durable_best_effort',
                    op: { kind: 'set', value: desired },
                    source: 'runtime',
                    observedAt: Date.now(),
                });
            },
            waitForRuntimeActivityPublisherReadiness: async (abortSignal) => {
                if (!this.durableMutationDeliveryActive) return true;
                while (!abortSignal.aborted) {
                    const tail = this.durableMutationOutbox.readRuntimeActivitySnapshotTail();
                    if (tail.custody === null && tail.settlement !== null) return true;
                    const changed = await this.durableMutationOutbox.waitForRuntimeActivitySnapshotTailChange(
                        tail.sequence,
                        abortSignal,
                    );
                    if (!changed) return false;
                }
                return false;
            },
            setSessionSyncPendingInputServerContractResult: async (result) => {
                this.sessionSyncPendingInputServerContractResult = result;
                this.emit(SESSION_SYNC_SERVER_CONTRACT_EVENT);
                if (
                    result !== null
                    && this.sessionSyncPendingInputServerContractResult === result
                    && result.mode !== 'auth_failed'
                    && result.pendingInput !== 'indeterminate'
                    && result.pendingInput !== 'unsupported'
                    && this.providerInputConsumer !== null
                    && this.materializationRuntime.shouldAttemptPendingMaterialization()
                ) {
                    this.wakePendingMaterialization();
                }
            },
            onSessionFollowInvalidated: options.onSessionFollowInvalidated,
        });
        this.userSocket = userSocket;
        this.sessionConnectionSupervisor = sessionConnectionSupervisor;
        void this.sessionConnectionSupervisor.start();
        // A recovered request has no in-process Action continuation. Retire it
        // during owner startup, even if the user never invokes another Action.
        const recoveredActionStore = this.hasOwnerMetadataAuthority()
            ? this.agentStateRequestStore
            : this.getOrCreateScopedSessionActionConfirmationRequestStore();
        if (recoveredActionStore?.listOutstandingRequests().some((request) => request.source === HAPPIER_ACTION_REQUEST_SOURCE)) {
            this.sessionActionConfirmationRecovery = retireRecoveredSessionActionConfirmations(recoveredActionStore);
            void this.sessionActionConfirmationRecovery?.catch((error) => {
                logger.debug('[API] Failed to retire recovered Action confirmations', {
                    error: serializeAxiosErrorForLog(error),
                });
            });
        }
        if (options.onSessionFollowInvalidated && options.installSessionFollowWakeReceiver) {
            this.disposeSessionFollowWakeReceiver = options.installSessionFollowWakeReceiver();
        }
    }

    private handleUserScopedUpdate(
        data: Update,
        socket: Socket<ServerToClientEvents, ClientToServerEvents>,
    ): void {
        if (this.closed || socket !== this.userSocket) return;

        const body = data.body;
        const bodyRecord = body && typeof body === 'object' && !Array.isArray(body)
            ? body as Record<string, unknown>
            : null;
        const isSettingsEnvelope = bodyRecord?.t === 'update-account'
            && bodyRecord.settingsV2 !== null
            && bodyRecord.settingsV2 !== undefined;
        const isSettingsHint = bodyRecord?.t === 'account-settings-changed';
        if (!isSettingsEnvelope && !isSettingsHint) {
            this.updateRuntime.handleUpdate(data, { source: 'user-scoped' });
            return;
        }

        const rawSettingsVersion = isSettingsEnvelope
            && bodyRecord?.settingsV2
            && typeof bodyRecord.settingsV2 === 'object'
            && !Array.isArray(bodyRecord.settingsV2)
            ? (bodyRecord.settingsV2 as Record<string, unknown>).version
            : bodyRecord?.settingsVersion;
        const settingsVersion = typeof rawSettingsVersion === 'number'
            && Number.isSafeInteger(rawSettingsVersion)
            && rawSettingsVersion >= 0
            ? rawSettingsVersion
            : null;
        const highestKnownSettingsVersion = Math.max(
            getActiveAccountSettingsSnapshot()?.settingsVersion ?? -1,
            this.accountSettingsHighestObservedVersion,
        );
        if (settingsVersion !== null && settingsVersion < highestKnownSettingsVersion) {
            logger.debug('[accountSettings] Ignoring an older live settings version', {
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

        const revision = ++this.accountSettingsEventRevision;
        const parsedUpdate = isSettingsEnvelope
            ? AccountSettingsV2GetResponseSchema.safeParse(bodyRecord?.settingsV2)
            : null;
        const parsedSettingsHintVersion = isSettingsHint
            && typeof bodyRecord?.settingsVersion === 'number'
            && Number.isSafeInteger(bodyRecord.settingsVersion)
            && bodyRecord.settingsVersion >= 0
            ? bodyRecord.settingsVersion
            : null;
        if ((parsedUpdate && !parsedUpdate.success) || (isSettingsHint && parsedSettingsHintVersion === null)) {
            logger.debug('[accountSettings] Ignoring malformed live settings envelope; ordinary Pending remains conservative');
            this.accountSettingsSyncBarrier = Promise.resolve(false);
            return;
        }

        const current = (async (): Promise<boolean> => {
            const credentials = await this.readCurrentOwnerCredentials();
            if (!credentials || credentials.token !== this.token) {
                throw new Error('Live account settings require the active session credentials');
            }
            const sourceIsCurrent = (): boolean => (
                !this.closed
                && socket === this.userSocket
                && socket.connected === true
                && revision === this.accountSettingsEventRevision
            );

            if (parsedUpdate?.success && bodyRecord?.t === 'update-account') {
                const accountId = await this.recoveryRuntime.getAccountId();
                if (!accountId || accountId !== bodyRecord.id) {
                    throw new Error('Live account settings do not belong to the authenticated account');
                }
                await applyAccountSettingsV2Update({
                    credentials,
                    update: parsedUpdate.data,
                    shouldCommit: sourceIsCurrent,
                });
            } else if (bodyRecord?.t === 'account-settings-changed') {
                await refreshActiveAccountSettingsFromServer({
                    credentials,
                    minSettingsVersion: parsedSettingsHintVersion,
                    shouldCommit: sourceIsCurrent,
                });
            }
            if (!sourceIsCurrent()) {
                throw new Error('Live account settings source closed before convergence completed');
            }
            return true;
        })().catch((error) => {
            logger.debug('[accountSettings] Live settings convergence failed; ordinary Pending remains conservative', {
                error: serializeAxiosErrorForLog(error),
            });
            return false;
        });

        this.accountSettingsSyncBarrier = current;
        void current.then((didApply) => {
            if (
                !didApply
                || this.closed
                || socket !== this.userSocket
                || socket.connected !== true
                || revision !== this.accountSettingsEventRevision
                || this.accountSettingsSyncBarrier !== current
            ) return;
            this.accountSettingsSyncBarrier = null;
            this.wakePendingMaterialization();
        });
    }

    private async refreshAccountSettingsForMinimumVersion(settingsVersion: number | null): Promise<void> {
        // Account settings are Account-owner state. A shared editor neither
        // reads nor persists them, so reconnect stays a transport concern.
        if (!this.hasOwnerMetadataAuthority()) {
            throw new SessionOwnerAuthorityUnavailableError('Account settings convergence');
        }
        if (settingsVersion !== null) {
            this.accountSettingsHighestObservedVersion = Math.max(
                this.accountSettingsHighestObservedVersion,
                settingsVersion,
            );
        }
        const revision = ++this.accountSettingsEventRevision;
        const socket = this.socket;
        const connectionEpoch = this.sessionConnectionEpoch;
        let failure: unknown = null;
        const sourceIsCurrent = (): boolean => (
            !this.closed
            && revision === this.accountSettingsEventRevision
            && socket === this.socket
            && socket.connected === true
            && connectionEpoch === this.sessionConnectionEpoch
        );
        const current = (async (): Promise<boolean> => {
            const credentials = await this.readCurrentOwnerCredentials();
            if (!credentials || credentials.token !== this.token) {
                throw new Error('Reconnect account settings require the active session credentials');
            }
            const accountId = await this.recoveryRuntime.getAccountId();
            if (!accountId) {
                throw new Error('Reconnect account settings require an authenticated account');
            }
            await refreshActiveAccountSettingsFromServer({
                credentials,
                minSettingsVersion: settingsVersion,
                shouldCommit: sourceIsCurrent,
            });
            if (!sourceIsCurrent()) {
                throw new Error('Reconnect account settings source became stale');
            }
            return true;
        })().catch((error) => {
            failure = error;
            logger.debug('[accountSettings] Request-only reconnect convergence failed; ordinary Pending remains conservative', {
                settingsVersion,
                error: serializeAxiosErrorForLog(error),
            });
            return false;
        });

        this.accountSettingsSyncBarrier = current;
        const didApply = await current;
        if (!didApply) {
            throw failure instanceof Error ? failure : new Error('Reconnect account settings convergence failed');
        }
        if (!sourceIsCurrent() || this.accountSettingsSyncBarrier !== current) return;
        this.accountSettingsSyncBarrier = null;
        this.accountSettingsHighestObservedVersion = Math.max(
            this.accountSettingsHighestObservedVersion,
            getActiveAccountSettingsSnapshot()?.settingsVersion ?? -1,
        );
        this.wakePendingMaterialization();
    }

    setSessionRuntimeControls(controls: SessionRuntimeControls | null): void {
        const hadGoalControls = typeof this.sessionRuntimeControls.setGoal === 'function'
            || typeof this.sessionRuntimeControls.clearGoal === 'function';
        applySessionRuntimeControls(this.sessionRuntimeControls, controls);
        this.sessionRuntimeControls.preparePendingMessageComposerAdmission = async (request) => (
            await this.transcriptApi.preparePendingMessageComposerAdmission(request)
        );
        this.publishSessionGoalControlCapabilities({ forceUnsupportedWrite: hadGoalControls });
    }

    private publishSessionGoalControlCapabilities(options?: Readonly<{ forceUnsupportedWrite?: boolean }>): void {
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
            && options?.forceUnsupportedWrite !== true
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

    hasOwnerMetadataAuthority(): boolean {
        return this.metadataAuthorityKind === 'owner';
    }

    private runSessionRequest<T>(request: () => T): T {
        return runWithServerHttpBaseUrl(this.transport.serverUrl, request);
    }

    private async readCurrentOwnerCredentials(): Promise<StoredCredentials | null> {
        // A shared editor must never discover globally stored Account
        // credentials: an unrelated signed-in Account on the endpoint machine
        // is not this Session's owner and cannot retarget this client.
        if (!this.hasOwnerMetadataAuthority()) return null;
        const active = await this.readInjectedOwnerCredentials?.().catch(() => null);
        if (active?.token === this.token) return active;
        return this.ownerCredentials?.token === this.token
            ? this.ownerCredentials
            : null;
    }

    private syncSessionSnapshotFromServer(opts: { reason: SessionSnapshotRefreshReason }): Promise<boolean> {
        if (this.closed) return Promise.resolve(false);
        if (this.snapshotSyncInFlight) return this.snapshotSyncInFlight;

        const p = (async (): Promise<boolean> => {
            try {
                const credentials = this.metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
                    ? await this.readCurrentOwnerCredentials()
                    : this.ownerCredentials;
                const accountEncryptionCurrentness = this.hasOwnerMetadataAuthority()
                    ? await this.runSessionRequest(() => this.getAccountEncryptionCurrentness())
                    : null;
                return await this.runSessionRequest(async () => syncSessionSnapshotFromServer({
                    token: this.token,
                    sessionId: this.sessionId,
                    credentials,
                    metadataAuthority: this.metadataAuthorityKind,
                    accountEncryptionCurrentness,
                    ...this.storedContentCrypto,
                    currentMetadataLayoutVersion: this.metadataLayoutVersion,
                    currentMetadataVersion: this.metadataVersion,
                    currentAgentStateVersion: this.agentStateVersion,
                    currentMetadata: this.metadata,
                    currentAgentState: this.agentState,
                    sessionConnectionSupervisor: this.sessionConnectionSupervisor,
                    isClosed: () => this.closed,
                    setOrganizationSnapshot: (organization) => {
                        this.rolePromptOrganization = organization;
                    },
                    setMetadataSnapshot: (metadata, version, layoutVersion) => {
                        this.openedSharedMetadata = null;
                        this.metadata = metadata;
                        this.metadataLayoutVersion = layoutVersion;
                        this.metadataVersion = version;
                        this.emit('metadata-updated');
                    },
                    setAgentStateSnapshot: (agentState, version) => {
                        this.agentState = agentState;
                        this.agentStateVersion = version;
                    },
                    setMetadataEnvelopeTupleSnapshot: (snapshot) => {
                        this.applyMetadataEnvelopeTupleSnapshot(snapshot);
                        this.emit('metadata-updated');
                    },
                    setSharedMetadataTupleSnapshot: (snapshot) => {
                        this.applySharedMetadataSnapshot(snapshot);
                        this.emit('metadata-updated');
                    },
                    applyPendingQueueState: (state) => {
                        if (this.materializationRuntime.applyPendingQueueState(state)) {
                            this.emit('metadata-updated');
                        }
                    },
                    reconcilePendingExecutionRunTarget: (runId) => this.notifyExecutionRunPendingTarget(runId),
                    applyLatestTurnStatus: (status, observedAt) => {
                        this.materializationRuntime.applyLatestTurnStatus(status, observedAt);
                    },
                    reason: opts.reason,
                }));
            } catch (error) {
                logger.debug('[API] Failed to sync session snapshot from server', {
                    reason: opts.reason,
                    error: serializeAxiosErrorForLog(error),
                });
                if (
                    error
                    && typeof error === 'object'
                    && (error as { code?: unknown }).code
                      === 'metadata_privacy_upgrade_required'
                ) {
                    throw error;
                }
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
        return this.materializationRuntime.observeSessionTurnMutationAction(mutation.action, mutation.observedAt);
    }

    /**
     * On durable terminal turns, wake the pending consumer and run a throttled pending-queue
     * reconcile (recovers lost pending-count nudges). Without this a stale 'in_progress' snapshot
     * can keep blocking pending-queue materialization until a manual "Send now" (fail-safe: a
     * duplicate wake/reconcile is harmless; a missing one strands queued messages).
     */
    private observeDurableTerminalSessionTurnMutationForPendingDrain(mutation: SessionTurnMutationV1): void {
        if (this.closed) return;
        const observed = this.materializationRuntime.observeSessionTurnMutationAction(mutation.action, mutation.observedAt);
        if (!observed.isTerminal) return;
        const pendingQueueState = this.materializationRuntime.getPendingQueueState();
        logger.debug('[pendingQueue] turn-end drain trigger', {
            sessionId: this.sessionId,
            action: mutation.action,
            pendingCount: pendingQueueState.known ? pendingQueueState.pendingCount : null,
        });
        this.emit('metadata-updated');
        void this.reconcilePendingQueueState({ force: false }).catch(() => undefined);
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
        if (!this.userSocket || this.userSocket.connected) return;
        try {
            this.userSocket.connect();
        } catch {
            // ignore; transcript recovery will handle missed updates
        }
    }

    private maybeScheduleUserSocketDisconnect(): void {
        if (this.closed) return;
        if (this.materializationRuntime.shouldKeepUserSocketConnected({
            hasProviderInputConsumer: this.providerInputConsumer !== null,
            hasQueuedDisconnectedSessionMessages: this.commitQueueRuntime.queuedDisconnectedSessionMessages.size > 0,
        })) return;
        if (!this.userSocket?.connected) return;
        if (this.userSocketDisconnectTimer) return;

        // Short idle grace to avoid thrashing if multiple pending items get materialized back-to-back.
        this.userSocketDisconnectTimer = setTimeout(() => {
            this.userSocketDisconnectTimer = null;
            if (this.materializationRuntime.shouldKeepUserSocketConnected({
                hasProviderInputConsumer: this.providerInputConsumer !== null,
                hasQueuedDisconnectedSessionMessages: this.commitQueueRuntime.queuedDisconnectedSessionMessages.size > 0,
            })) return;
            if (!this.userSocket?.connected) return;
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
            recoveryRuntime: this.recoveryRuntime,
        }, catchUpRequest);
    }

    private scheduleNextStartupMessageCatchUpRetry(): void {
        scheduleNextStartupCatchUpRetryViaPort({ recoveryRuntime: this.recoveryRuntime });
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
     * Force and observe an authoritative session snapshot sync.
     *
     * Startup authority handoff uses this fail-closed surface after the publisher claim. Callers
     * must not substitute the cached `ensureMetadataSnapshot` or the best-effort refresh.
     */
    async refreshSessionSnapshotFromServerRequired(opts?: { reason?: SessionSnapshotRefreshReason }): Promise<void> {
        await this.interactionApi.refreshSessionSnapshotFromServerRequired(opts);
    }

    publishUsageObservation(
        input: Omit<
            Parameters<ReturnType<typeof createSessionClientUsageObservationPublisher>['publish']>[0],
            'sessionId'
        >,
    ): ReturnType<ReturnType<typeof createSessionClientUsageObservationPublisher>['publish']> {
        return this.usageObservationPublisher.publish({
            sessionId: this.sessionId,
            ...input,
        });
    }

    enqueueUserTextMessageCommitted(
        text: string,
        opts: CommittedTranscriptMessageOptions,
    ): Promise<Readonly<{ persisted: boolean; delivered: boolean }>> {
        const update = this.transcriptApi.enqueueUserTextMessageCommitted(text, opts);
        this.trackPendingUpdate(this.pendingTranscriptMessageUpdates, update);
        return update;
    }

    private async notifyDaemonConnectedServiceTurnLifecycle(
        event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled',
    ): Promise<void> {
        if (!this.startedByDaemonProcess) return;
        try {
            const result = await notifyDaemonConnectedServiceTurnLifecycleViaControl({
                sessionId: this.sessionId,
                event,
                ...(process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]
                    ? {
                        connectedServiceSelectionsEnvRaw:
                            process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY],
                    }
                    : {}),
            });
            const resultError =
                result
                && typeof result === 'object'
                && 'error' in result
                && typeof result.error === 'string'
                    ? result.error
                    : null;
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
    }

    async enqueueSessionUserMessage(params: Readonly<{
        callerInputAuthorization?: import('@happier-dev/protocol').ExternalActionExecutionAuthorizationV1;
        text: string;
        localId?: string;
        meta?: Record<string, unknown>;
        requestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
        recipient?: import('@happier-dev/protocol').ParticipantRecipientV1;
        structuredInputAdmissionPolicy?: SessionStructuredInputAdmissionPolicyV1;
        inputAdmission?: Readonly<{
            provenance: import('@happier-dev/protocol').SessionMessageProvenance;
            request: import('@happier-dev/protocol').SessionInputRequest;
        }>;
    }>): Promise<void> {
        void this.notifyDaemonConnectedServiceTurnLifecycle('prompt_or_steer');
        await this.transcriptApi.enqueueSessionUserMessage(params);
    }

    async enqueueSessionUserMessageWithDisposition(params: Readonly<{
        callerInputAuthorization?: import('@happier-dev/protocol').ExternalActionExecutionAuthorizationV1;
        text: string;
        localId: string;
        meta?: Record<string, unknown>;
        requestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
        recipient?: import('@happier-dev/protocol').ParticipantRecipientV1;
        structuredInputAdmissionPolicy?: SessionStructuredInputAdmissionPolicyV1;
        inputAdmission?: Readonly<{
            provenance: import('@happier-dev/protocol').SessionMessageProvenance;
            request: import('@happier-dev/protocol').SessionInputRequest;
        }>;
    }>): Promise<import('@happier-dev/protocol').SessionInputAdmissionResultV1> {
        void this.notifyDaemonConnectedServiceTurnLifecycle('prompt_or_steer');
        return await this.transcriptApi.enqueueSessionUserMessageWithDisposition(params);
    }

    enqueueAgentMessageCommitted(
        provider: ACPProvider,
        body: ACPMessageData,
        opts: CommittedTranscriptMessageOptions,
    ): Promise<Readonly<{ persisted: boolean; delivered: boolean }>> {
        const update = this.transcriptApi.enqueueAgentMessageCommitted(provider, body, opts);
        this.trackPendingUpdate(this.pendingTranscriptMessageUpdates, update);
        return update;
    }

    async fetchCommittedTranscriptIdentitySnapshot(opts?: Readonly<{ signal?: AbortSignal }>) {
        const request = async () => await this.runSessionRequest(async () => fetchCommittedTranscriptIdentitySnapshot({
            token: this.token, sessionId: this.sessionId, ...this.getTranscriptQueryContext(),
            ...(opts?.signal ? { signal: opts.signal } : {}),
        }));
        return this.sessionConnectionSupervisor
            ? await runSupervisedRequest({ supervisor: this.sessionConnectionSupervisor, requireAuth: true, requireOnline: false, request })
            : await request();
    }

    async fetchCommittedTranscriptLocalIdBaseline(opts?: {
        take?: number;
        signal?: AbortSignal;
        deadlineAtMs?: number;
    }) {
        const request = async () => await this.runSessionRequest(async () => loadCommittedTranscriptLocalIdBaseline({
            ...(opts?.take === undefined ? {} : { take: opts.take }),
            ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
            ...(opts?.deadlineAtMs === undefined
                ? {}
                : { deadlineAtMs: opts.deadlineAtMs }),
            fetchPage: async ({ limit, beforeSeq, signal, deadlineAtMs }) =>
                await fetchEncryptedTranscriptMessagesPage({
                    token: this.token,
                    sessionId: this.sessionId,
                    limit,
                    scope: 'all',
                    roles: ['user', 'agent', 'event'],
                    ...(beforeSeq === undefined ? {} : { beforeSeq }),
                    ...(signal === undefined ? {} : { signal }),
                    ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
                }),
        }));
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

    enqueueSessionEventCommitted(
        event: SessionEventMessage,
        id?: string,
    ): Promise<Readonly<{ persisted: boolean; delivered: boolean; localId?: string; committedSequence?: number }>> {
        const update = this.transcriptApi.enqueueSessionEventCommitted(event, id);
        this.trackPendingUpdate(this.pendingTranscriptMessageUpdates, update);
        return update;
    }

    setOwnerActivityDelivery(delivery: 'rich_sender' | 'home_required'): void {
        this.ownerActivityDelivery = delivery;
    }

    enqueueVoiceAgentTranscriptTurnCommitted(
        provider: ACPProvider,
        params: Parameters<SessionClientTranscriptApi['enqueueVoiceAgentTranscriptTurnCommitted']>[1],
    ): Promise<Readonly<{ persisted: boolean; delivered: boolean }>> {
        const update = this.transcriptApi.enqueueVoiceAgentTranscriptTurnCommitted(provider, params);
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
    ): EphemeralSendOutcome {
        return this.transcriptApi.sendAgentMessageEphemeral(provider, body, opts);
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
    ): EphemeralSendOutcome {
        return this.transcriptApi.sendAgentMessageEphemeralDelta(provider, body, opts);
    }

    getEphemeralStreamConnectionEpoch(): number {
        return this.sessionConnectionEpoch;
    }

    isDaemonPluginCatalogSignalReady(): boolean {
        return this.rpcHandlerManager.isHandlerRegistrationAcknowledged(SESSION_RPC_METHODS.SESSION_PLUGIN_CATALOG_INVALIDATE_V1);
    }

    async fetchRecentTranscriptTextItemsForAcpImport(opts?: { take?: number }): Promise<Array<{ role: 'user' | 'agent'; text: string }>> {
        return this.transcriptApi.fetchRecentTranscriptTextItemsForAcpImport(opts);
    }

    async fetchLatestUserPermissionIntentFromTranscript(opts?: { take?: number }): Promise<{ intent: import('../types').PermissionMode; updatedAt: number } | null> {
        return this.transcriptApi.fetchLatestUserPermissionIntentFromTranscript(opts);
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        this.transcriptApi.keepAlive(thinking, mode);
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    private normalizeUserMessageDeliveryLocalIds(localIds: readonly string[] | null | undefined): string[] {
        const normalized: string[] = [];
        for (const value of localIds ?? []) {
            const localId = readPendingLocalId(value);
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

    private recordCommittedUserMessageSeq(localId: unknown, seq: unknown): number | null {
        const normalizedLocalId = readPendingLocalId(localId);
        const committedSeq = this.committedUserMessageSeqTracker.record(normalizedLocalId, seq);
        return committedSeq;
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
                if (!seqs.includes(committedSeq)) {
                    seqs.push(committedSeq);
                }
            }
        }

        this.persistLocallyConsumedUserMessageSeqs(seqs);
    }

    private async mutateLegacySessionTuple(
        request: SessionMetadataLegacyOwnerMutationRequestV1<
            Metadata,
            AgentState
        >,
    ): Promise<SessionMetadataLegacyOwnerSnapshot> {
        if (request.kind === 'metadata') {
            await this.waitForSessionSocketOnlineForAckWrite(
                'update-metadata',
            );
            let usePreparedValue = true;
            const result = await updateSessionMetadataWithAck({
                socket: this.socket as any,
                sessionId: this.sessionId,
                ...(this.storedContentCrypto.mode === 'plain'
                    ? { sessionEncryptionMode: 'plain' as const }
                    : {
                        sessionEncryptionMode: 'e2ee' as const,
                        encryptionKey: this.storedContentCrypto.ctx.encryptionKey,
                        encryptionVariant: this.storedContentCrypto.ctx.encryptionVariant,
                    }),
                getMetadata: () => this.metadata,
                setMetadata: (metadata) => {
                    this.metadata = metadata;
                },
                getMetadataVersion: () => this.metadataVersion,
                setMetadataVersion: (version) => {
                    this.metadataVersion = version;
                },
                syncSessionSnapshotFromServer: async () => {
                    await this.syncSessionSnapshotFromServer({
                        reason: 'waitForMetadataUpdate',
                    });
                },
                handler: (metadata) => {
                    if (request.mutation.expectedMetadataRevision !== undefined && this.metadataVersion !== request.mutation.expectedMetadataRevision) {
                        throw Object.assign(new Error('Session context changed after review'), { code: 'metadata_tuple_conflict', retryable: false });
                    }
                    if (usePreparedValue) {
                        usePreparedValue = false;
                        return request.updatedMetadata;
                    }
                    const reapplied = request.mutation.update(metadata);
                    if (
                        reapplied
                        && typeof (reapplied as Promise<Metadata>).then
                            === 'function'
                    ) {
                        throw new Error(
                            'Legacy socket metadata mutations must be synchronous',
                        );
                    }
                    return reapplied as Metadata;
                },
            });
            return {
                ...request.current,
                metadataVersion: result.version,
                metadataCiphertext: result.ciphertext,
                value: {
                    metadata: result.metadata,
                    agentState: this.agentState,
                },
            };
        }

        await this.waitForSessionSocketOnlineForAckWrite('update-state');
        let usePreparedValue = true;
        const result = await updateSessionAgentStateWithAck({
            socket: this.socket as any,
            sessionId: this.sessionId,
            ownerActivityDelivery: this.ownerActivityDelivery,
            ...(this.storedContentCrypto.mode === 'plain'
                ? { sessionEncryptionMode: 'plain' as const }
                : {
                    sessionEncryptionMode: 'e2ee' as const,
                    encryptionKey: this.storedContentCrypto.ctx.encryptionKey,
                    encryptionVariant: this.storedContentCrypto.ctx.encryptionVariant,
                }),
            getAgentState: () => this.agentState,
            setAgentState: (agentState) => {
                this.agentState = agentState;
            },
            getAgentStateVersion: () => this.agentStateVersion,
            setAgentStateVersion: (version) => {
                this.agentStateVersion = version;
            },
            syncSessionSnapshotFromServer: async () => {
                await this.syncSessionSnapshotFromServer({
                    reason: 'waitForMetadataUpdate',
                });
            },
            handler: (agentState) => {
                if (usePreparedValue) {
                    usePreparedValue = false;
                    return request.updatedAgentState;
                }
                const reapplied = request.mutation.update(agentState);
                if (
                    reapplied
                    && typeof (reapplied as Promise<AgentState>).then
                        === 'function'
                ) {
                    throw new Error(
                        'Legacy socket Agent-state mutations must be synchronous',
                    );
                }
                return reapplied as AgentState;
            },
        });
        return {
            ...request.current,
            agentStateVersion: result.version,
            agentStateCiphertext: result.ciphertext,
            value: {
                metadata: this.metadata ?? request.current.value.metadata,
                agentState: result.agentState,
            },
        };
    }

    updateMetadata(handler: (metadata: Metadata) => Metadata, options?: Readonly<{ expectedMetadataRevision?: number }>): Promise<void> {
        return this.metadataLock.inLock(async () =>
            await this.updateMetadataLocked(handler, undefined, options?.expectedMetadataRevision));
    }

    updateMetadataAsCurrentPublisher(
        handler: (metadata: Metadata) => Metadata,
    ): Promise<void> {
        // The current-publisher precondition is an owner tuple-write condition.
        // Refuse before the authority-check round trip rather than emitting it.
        if (!this.hasOwnerMetadataAuthority()) {
            return Promise.reject(new SessionOwnerAuthorityUnavailableError(
                'Current-publisher Session metadata authority',
            ));
        }
        return this.metadataLock.inLock(async () => {
            const publisherPrecondition =
                await this.readCurrentPublisherPrecondition();
            if (!publisherPrecondition) {
                throw Object.assign(
                    new Error('Session publisher authority was superseded'),
                    {
                        code: 'session_publisher_authority_lost' as const,
                        retryable: false as const,
                    },
                );
            }
            await this.updateMetadataLocked(
                handler,
                publisherPrecondition,
            );
        });
    }

    private async updateMetadataLocked(
        handler: (metadata: Metadata) => Metadata,
        publisherPrecondition?: SessionMetadataPublisherPreconditionV1,
        expectedMetadataRevision?: number,
    ): Promise<void> {
        if (
            this.metadataLayoutVersion !== 0
            && this.metadataLayoutVersion
                !== SESSION_METADATA_LAYOUT_VERSION_V1
        ) {
            throw Object.assign(new Error('Unsupported session metadata layout'), {
                code: 'metadata_privacy_upgrade_required',
                retryable: false,
            });
        }
        if (!this.hasOwnerMetadataAuthority()) {
            await this.updateSharedMetadataLocked(handler, publisherPrecondition);
            return;
        }
        const credentials = await this.readCurrentOwnerCredentials();
        if (!credentials || credentials.token !== this.token) {
            throw Object.assign(
                new Error('Owner session metadata encryption material is unavailable'),
                {
                    code: 'metadata_privacy_upgrade_required',
                    retryable: false,
                },
            );
        }
        const accountEncryptionCurrentness = await this.runSessionRequest(() => this.getAccountEncryptionCurrentness());
        const updated = await this.runSessionRequest(async () => updateSessionMetadataEnvelopeTupleWithRetry({
            token: this.token,
            sessionId: this.sessionId,
            authority: {
                kind: 'owner',
                credentials,
                accountEncryptionCurrentness,
            },
            ...this.getMetadataTupleCryptoContext(),
            initialSnapshot:
                await this.acquireMetadataTupleWriterSnapshot(
                    credentials,
                    accountEncryptionCurrentness,
                ),
            mutation: {
                kind: 'metadata',
                ...(expectedMetadataRevision !== undefined ? { expectedMetadataRevision } : {}),
                update: handler,
            },
            ...(publisherPrecondition
                ? { publisherPrecondition }
                : {}),
            mutateLegacy: async (request) =>
                await this.mutateLegacySessionTuple(request),
        }));
        if (updated.mode === 'shared_editor') {
            throw Object.assign(
                new Error('Owner session metadata mutation changed to shared-editor authority'),
                {
                    code: 'metadata_privacy_upgrade_required',
                    retryable: false,
                },
            );
        }
        if (updated.metadataLayoutVersion === 1) {
            this.applyMetadataEnvelopeTupleSnapshot(updated);
        }
    }

    /**
     * Writes the shared projection under the server's `shared_editor` tuple
     * mode. Owner-only metadata fields are rejected by the canonical shared
     * metadata schema rather than being silently dropped or escalated.
     */
    private async updateSharedMetadataLocked(
        handler: (metadata: Metadata) => Metadata,
        publisherPrecondition?: SessionMetadataPublisherPreconditionV1,
    ): Promise<void> {
        if (publisherPrecondition) {
            throw new SessionOwnerAuthorityUnavailableError(
                'Current-publisher Session metadata authority',
            );
        }
        if (this.metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1) {
            throw Object.assign(
                new Error('Shared-editor Session metadata requires the layout-1 tuple'),
                {
                    code: 'metadata_privacy_upgrade_required',
                    retryable: false,
                },
            );
        }
        const updated = await this.runSessionRequest(async () => updateSessionMetadataEnvelopeTupleWithRetry({
            token: this.token,
            sessionId: this.sessionId,
            authority: { kind: 'shared_editor' },
            ...this.getMetadataTupleCryptoContext(),
            initialSnapshot: await this.acquireSharedMetadataSnapshot(),
            mutation: {
                kind: 'metadata',
                update: handler,
            },
        }));
        if (updated.mode !== 'shared_editor') {
            throw Object.assign(
                new Error('Shared-editor session metadata mutation changed authority'),
                {
                    code: 'metadata_privacy_upgrade_required',
                    retryable: false,
                },
            );
        }
        this.applySharedMetadataSnapshot(updated);
    }

    private async acquireSharedMetadataSnapshot(): Promise<SessionMetadataSharedEditorSnapshot> {
        const rawSession = await this.runSessionRequest(async () => fetchSessionByIdCompat({
            token: this.token,
            sessionId: this.sessionId,
            reason: 'waitForMetadataUpdate',
        }));
        if (!rawSession) {
            throw Object.assign(new Error('Session not found'), {
                code: 'session_not_found' as const,
                retryable: false as const,
            });
        }
        return readSessionMetadataSharedEditorTupleSnapshot({
            rawSession,
            ...this.getMetadataTupleCryptoContext(),
        });
    }

    private applySharedMetadataSnapshot(
        snapshot: SessionMetadataSharedEditorSnapshot,
    ): void {
        this.openedSharedMetadata = TranscriptOpenedSharedMetadataV1Schema.parse({ version: snapshot.metadataVersion, value: snapshot.value.sharedMetadata });
        this.metadataLayoutVersion = snapshot.metadataLayoutVersion;
        this.metadata = snapshot.value.metadata;
        this.metadataVersion = snapshot.metadataVersion;
    }

    private async acquireMetadataTupleWriterSnapshot(
        credentials: StoredCredentials,
        accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse,
    ): Promise<SessionMetadataTupleWriterSnapshot> {
        const rawSession = await this.runSessionRequest(async () => fetchSessionByIdCompat({
            token: this.token,
            sessionId: this.sessionId,
            reason: 'waitForMetadataUpdate',
        }));
        if (!rawSession) {
            throw Object.assign(new Error('Session not found'), {
                code: 'session_not_found' as const,
                retryable: false as const,
            });
        }
        return readSessionMetadataTupleWriterSnapshot({
            credentials,
            rawSession,
            accountEncryptionCurrentness,
        });
    }

    private applyMetadataEnvelopeTupleSnapshot(
        snapshot: SessionMetadataEnvelopeTupleSnapshot,
    ): void {
        this.openedSharedMetadata = TranscriptOpenedSharedMetadataV1Schema.parse({ version: snapshot.metadataVersion, value: snapshot.value.sharedMetadata });
        this.metadataLayoutVersion = snapshot.metadataLayoutVersion;
        this.metadata = snapshot.value.metadata;
        this.metadataVersion = snapshot.metadataVersion;
        this.ownerMetadata = snapshot.value.ownerMetadata;
        this.agentState = snapshot.value.agentState;
        this.agentStateVersion = snapshot.agentStateVersion;
    }

    private getTranscriptQueryContext(): Readonly<
        | { encryptionMode: 'plain' }
        | {
            encryptionMode: 'e2ee';
            encryptionKey: Uint8Array;
            encryptionVariant: 'legacy' | 'dataKey';
        }
    > {
        return this.storedContentCrypto.mode === 'plain'
            ? { encryptionMode: 'plain' }
            : {
                encryptionMode: 'e2ee',
                encryptionKey: this.storedContentCrypto.ctx.encryptionKey,
                encryptionVariant: this.storedContentCrypto.ctx.encryptionVariant,
            };
    }

    getStoredContentEncryptionContext(): Readonly<
        | { mode: 'plain' }
        | {
            mode: 'e2ee';
            ctx: Readonly<{
                encryptionKey: Uint8Array;
                encryptionVariant: 'legacy' | 'dataKey';
            }>;
        }
    > {
        if (this.storedContentCrypto.mode === 'plain') {
            return { mode: 'plain' };
        }
        return {
            mode: 'e2ee',
            ctx: this.storedContentCrypto.ctx,
        };
    }

    getServerBinding(): SessionClientServerBinding {
        return this.serverBinding;
    }

    getMachineAdmissionTransport(): ApiSessionClientOptions['machineAdmissionTransport'] {
        return this.machineAdmissionTransport;
    }

    getWorkDepth(): number {
        return this.workDepth;
    }

    /** Current server-owned worker/origin projection, never role metadata lineage. */
    async readRolePromptOrganization(signal?: AbortSignal): Promise<Pick<import('@happier-dev/protocol').V2SessionByIdResponse['session'], 'reportsTo' | 'origin'>> {
        signal?.throwIfAborted();
        if (this.snapshotSyncInFlight) await this.snapshotSyncInFlight;
        signal?.throwIfAborted();
        return this.rolePromptOrganization;
    }

    /** Projection of the host lifecycle's exact begin facts for Action/MCP callers. */
    observeHostTurnFacts(input: Readonly<{ turnId: string; facts: import('@happier-dev/protocol').SessionTurnFactsV1 | null }>): void {
        if (input.facts) this.hostCurrentTurnFacts = { turnId: input.turnId, facts: input.facts };
        else if (this.hostCurrentTurnFacts?.turnId === input.turnId) this.hostCurrentTurnFacts = null;
    }

    getHostTurnWorkDepth(turnId: string): number | undefined {
        return this.hostCurrentTurnFacts?.turnId === turnId ? this.hostCurrentTurnFacts.facts.workDepth : undefined;
    }

    async getAuthenticatedAccountId(): Promise<string | null> {
        return this.runtimePrincipalAccountId ?? await this.recoveryRuntime.getAccountId();
    }

    private getMetadataTupleCryptoContext(): SessionStoredContentCryptoContext {
        const context = this.getStoredContentEncryptionContext();
        return context.mode === 'plain'
            ? { mode: 'plain', ctx: null }
            : context;
    }

    private async updateRuntimeActivityProjectionExact(projection: Readonly<{
        runtimeActivityState: 'active' | 'idle' | 'unknown';
        runtimeActivityActiveCount: number;
    }>, mutationId = resolveRuntimeActivitySnapshotMutationId(
        this.sessionId,
    )): Promise<RuntimeActivityProjectionSettlement> {
        await this.waitForSessionSocketOnlineForAckWrite(
            'session-runtime-activity-snapshot',
        );
        const acknowledged =
            await this.updateRuntimeActivityProjectionOnSocketExact(
                projection,
                this.socket,
                mutationId,
            );
        this.applyRuntimeActivityProjectionFromServer(acknowledged.projection);
        return acknowledged;
    }

    private async updateRuntimeActivityProjectionOnSocketExact(
        projection: RuntimeActivityProjectionWrite,
        socket: Socket<ServerToClientEvents, ClientToServerEvents>,
        mutationId = resolveRuntimeActivitySnapshotMutationId(this.sessionId),
    ): Promise<RuntimeActivityProjectionSettlement> {
        return await updateSessionRuntimeActivityProjectionWithAck({
            socket:
                socket as unknown as Parameters<
                    typeof updateSessionRuntimeActivityProjectionWithAck
                >[0]['socket'],
            sessionId: this.sessionId,
            mutationId,
            state: projection.runtimeActivityState,
            runtimeActivityActiveCount: projection.runtimeActivityActiveCount,
        });
    }

    private isCurrentPublisherClaimServerContract(
        expected: SessionSyncPendingInputServerContractResult,
    ): boolean {
        const current = this.sessionSyncPendingInputServerContractResult;
        return (
            current === expected
            && current.socket === expected.socket
            && current.sessionConnectionEpoch
                === expected.sessionConnectionEpoch
            && this.socket === expected.socket
            && expected.socket.connected === true
        );
    }

    private async waitForPublisherClaimServerContract(): Promise<
        SessionSyncPendingInputServerContractResult
    > {
        while (true) {
            await this.waitForSessionSocketOnlineForAckWrite(
                'session-runtime-activity-snapshot',
            );
            const result = this.sessionSyncPendingInputServerContractResult;
            if (
                result?.socket === this.socket
                && result.publisherAuthority !== 'indeterminate'
            ) {
                return result;
            }
            if (
                result?.socket === this.socket
                && result.mode === 'auth_failed'
            ) {
                throw createSessionSocketNotReadyError({
                    code: 'socket_auth_failed',
                    event: 'session-runtime-activity-snapshot',
                    message:
                        'Runtime Activity publisher authority requires an authenticated current-server contract',
                    retryable: false,
                });
            }

            await new Promise<void>((resolve) => {
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    this.off(
                        SESSION_SYNC_SERVER_CONTRACT_EVENT,
                        onContractResult,
                    );
                    this.off(SESSION_CONNECTION_STATE_EVENT, onStateChange);
                    resolve();
                };
                const onContractResult = () => finish();
                const onStateChange = () => finish();
                this.on(
                    SESSION_SYNC_SERVER_CONTRACT_EVENT,
                    onContractResult,
                );
                this.on(SESSION_CONNECTION_STATE_EVENT, onStateChange);

                const currentResult =
                    this.sessionSyncPendingInputServerContractResult;
                if (
                    this.closed
                    || this.currentConnectionState.phase !== 'online'
                    || (
                        currentResult?.socket === this.socket
                        && (
                            currentResult.mode === 'auth_failed'
                            || currentResult.publisherAuthority !== 'indeterminate'
                        )
                    )
                ) {
                    finish();
                }
            });
        }
    }

    async claimCurrentSessionPublisherAuthorityForStartup(): Promise<
        StartupSessionPublisherAuthorityClaimResult
    > {
        let projection: RuntimeActivityProjectionWrite | null = null;
        while (true) {
            const contract = await this.waitForPublisherClaimServerContract();
            if (!supportsSessionPublisherAuthorityCheckV1(contract)) {
                if (!this.isCurrentPublisherClaimServerContract(contract)) {
                    continue;
                }
                // Released v0.2.1 and the moving session-sync-v2 predecessor
                // predate the exact current-publisher check. Ordinary startup
                // remains compatible, while transition/process effects fail
                // closed before attempting the absent socket operation.
                return {
                    status: 'unsupported',
                    reason: 'publisher_authority_check_unsupported',
                };
            }
            if (!this.isCurrentPublisherClaimServerContract(contract)) {
                continue;
            }
            if (!projection) {
                for (
                    const mutation
                    of this.initialRegisteredSessionStateFieldMutations
                ) {
                    const candidate =
                        readRuntimeActivityProjectionWriteFromRegisteredMutation(
                            mutation,
                        );
                    if (candidate) projection = candidate;
                }
                if (!projection) {
                    throw new Error(
                        'Startup publisher authority requires an initial Runtime Activity snapshot',
                    );
                }
            }

            let acknowledged: RuntimeActivityProjectionSettlement;
            try {
                acknowledged =
                    await this.updateRuntimeActivityProjectionOnSocketExact(
                        projection,
                        contract.socket as Socket<
                            ServerToClientEvents,
                            ClientToServerEvents
                        >,
                    );
            } catch (error) {
                if (!this.isCurrentPublisherClaimServerContract(contract)) {
                    continue;
                }
                throw error;
            }
            if (!this.isCurrentPublisherClaimServerContract(contract)) {
                continue;
            }
            this.applyRuntimeActivityProjectionFromServer(
                acknowledged.projection,
            );
            return { status: 'claimed' };
        }
    }

    async updateRuntimeActivityProjection(projection: Readonly<{
        runtimeActivityState: 'active' | 'idle' | 'unknown';
        runtimeActivityActiveCount: number;
    }>): Promise<void> {
        await this.updateRuntimeActivityProjectionExact(projection);
    }

    private observeExecutionRunPublicState(run: unknown): void {
        if (!run || typeof run !== 'object' || Array.isArray(run)) return;
        const record = run as Record<string, unknown>;
        const runId = typeof record.runId === 'string' ? record.runId.trim() : '';
        if (!runId) return;
        if (isExecutionRunActive({
            status: typeof record.status === 'string' ? record.status : undefined,
            runClass: typeof record.runClass === 'string' ? record.runClass : undefined,
            turnInFlight: typeof record.turnInFlight === 'boolean' ? record.turnInFlight : undefined,
        })) this.activeExecutionRunIds.add(runId);
        else this.activeExecutionRunIds.delete(runId);
        for (const listener of this.executionRunActivityListeners) {
            listener(this.activeExecutionRunIds.size);
        }
    }

    subscribeExecutionRunActivitySnapshots(listener: (activeCount: number) => void): () => void {
        this.executionRunActivityListeners.add(listener);
        listener(this.activeExecutionRunIds.size);
        return () => this.executionRunActivityListeners.delete(listener);
    }

    setExecutionRunWorkerUpdateSource(source: NonNullable<ApiSessionClient['executionRunWorkerUpdateSource']>): void {
        this.executionRunWorkerUpdateSource = source;
        this.emit(EXECUTION_RUN_WORKER_UPDATE_SOURCE_EVENT);
    }

    async takeExecutionRunWorkerUpdate(signal: AbortSignal): Promise<Extract<import('@/agent/runtime/session/contextOnly/hostContextOnlyInput').HostContextOnlySourceInput, { kind: 'worker_update' }> | null> {
        return await this.executionRunWorkerUpdateSource?.takeWorkerUpdate(this.sessionId, signal) ?? null;
    }

    async waitForExecutionRunWorkerUpdateChange(signal: AbortSignal): Promise<boolean> {
        if (signal.aborted) return false;
        if (!this.executionRunWorkerUpdateSource) {
            const installed = await new Promise<boolean>((resolve) => {
                const finish = (ready: boolean) => {
                    this.off(EXECUTION_RUN_WORKER_UPDATE_SOURCE_EVENT, onSource);
                    signal.removeEventListener('abort', onAbort);
                    resolve(ready);
                };
                const onSource = () => finish(true);
                const onAbort = () => finish(false);
                this.on(EXECUTION_RUN_WORKER_UPDATE_SOURCE_EVENT, onSource);
                signal.addEventListener('abort', onAbort, { once: true });
                if (signal.aborted) finish(false);
                else if (this.executionRunWorkerUpdateSource) finish(true);
            });
            if (!installed || signal.aborted) return false;
        }
        return await this.executionRunWorkerUpdateSource?.waitForWorkerUpdateChange(this.sessionId, signal) ?? false;
    }

    async prepareExecutionRunWorkerUpdates(input: Readonly<{ signal: AbortSignal }>): Promise<readonly import('@/agent/runtime/session/contextOnly/hostContextOnlyInput').PreparedWorkerContextItem[]> {
        return await this.executionRunWorkerUpdateSource?.prepareWorkerUpdates(this.sessionId, input) ?? [];
    }

    private applyRuntimeActivityProjectionFromServer(projectionLike: unknown): void {
        const projection = readRuntimeActivityProjectionForPendingDrain(projectionLike);
        const currentRevision = typeof this.runtimeActivityProjection.runtimeActivityRevision === 'number'
            ? this.runtimeActivityProjection.runtimeActivityRevision
            : -1;
        const nextRevision = typeof projection.runtimeActivityRevision === 'number'
            ? projection.runtimeActivityRevision
            : -1;
        if (nextRevision < currentRevision) return;
        this.runtimeActivityProjection = projection;
    }

    readRuntimeActivitySnapshotTail(): RuntimeActivitySnapshotTail {
        return this.durableMutationOutbox.readRuntimeActivitySnapshotTail();
    }

    async waitForRuntimeActivitySnapshotTailChange(
        sequence: number,
        abortSignal?: AbortSignal,
    ): Promise<boolean> {
        return await this.durableMutationOutbox.waitForRuntimeActivitySnapshotTailChange(
            sequence,
            abortSignal,
        );
    }

    async upsertSessionSystemRecord(request: SessionSystemRecordUpsertRequest): Promise<void> {
        await this.runSessionRequest(async () => upsertSessionSystemRecordHttp({
            token: this.token,
            sessionId: this.sessionId,
            namespace: request.namespace,
            kind: request.kind,
            localId: request.localId,
            content: request.content,
        }));
    }

    async fetchSessionSystemRecord(params: Readonly<{
        namespace: SessionSystemRecord['namespace'];
        localId: string;
    }>): Promise<SessionSystemRecord | null> {
        return this.runSessionRequest(async () => fetchSessionSystemRecordHttp({
            token: this.token,
            sessionId: this.sessionId,
            namespace: params.namespace,
            localId: params.localId,
        }));
    }

    async readPermissionMediationRecord(params: Readonly<{
        identity: SessionPermissionMediationRecordIdentityV1;
        signal?: AbortSignal;
    }>): Promise<SessionPermissionMediationRecordStored | null> {
        if (params.identity.sessionId !== this.sessionId) {
            throw new Error("Permission mediation identity session does not match this client");
        }
        return await this.runSessionRequest(async () => readPermissionMediationRecordHttp({
            token: this.token,
            identity: params.identity,
            ...(params.signal ? { signal: params.signal } : {}),
        }));
    }

    async writePermissionMediationRecord(params: Readonly<{
        identity: SessionPermissionMediationRecordIdentityV1;
        request: SessionPermissionMediationRecordWriteRequest;
        signal?: AbortSignal;
    }>): Promise<SessionPermissionMediationRecordStored> {
        if (params.identity.sessionId !== this.sessionId) {
            throw new Error("Permission mediation identity session does not match this client");
        }
        return await this.runSessionRequest(async () => writePermissionMediationRecordHttp({
            token: this.token,
            identity: params.identity,
            request: params.request,
            ...(params.signal ? { signal: params.signal } : {}),
        }));
    }

    async prunePermissionMediationRecord(params: Readonly<{
        identity: SessionPermissionMediationRecordIdentityV1;
        request: SessionPermissionMediationRecordPruneRequest;
        signal?: AbortSignal;
    }>): Promise<void> {
        if (params.identity.sessionId !== this.sessionId) {
            throw new Error("Permission mediation identity session does not match this client");
        }
        await this.runSessionRequest(async () => prunePermissionMediationRecordHttp({
            token: this.token,
            identity: params.identity,
            request: params.request,
            ...(params.signal ? { signal: params.signal } : {}),
        }));
    }

    async listPermissionMediationRecords(params?: Readonly<{
        query?: SessionPermissionMediationRecordListQuery;
        signal?: AbortSignal;
    }>): Promise<Readonly<{
        records: readonly SessionPermissionMediationRecordStored[];
        nextCursor: string | null;
        hasNext: boolean;
    }>> {
        return await this.runSessionRequest(async () => listPermissionMediationRecordsHttp({
            token: this.token,
            sessionId: this.sessionId,
            ...(params?.query ? { query: params.query } : {}),
            ...(params?.signal ? { signal: params.signal } : {}),
        }));
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
        // Full Agent state is owner-only in every supported layout: the server
        // neither serves nor accepts it for a shared editor. Refuse before any
        // fetch or socket effect instead of emulating owner credentials.
        if (!this.hasOwnerMetadataAuthority()) {
            return Promise.reject(
                new SessionOwnerAuthorityUnavailableError('Session Agent-state write'),
            );
        }
        logger.debugLargeJson('Updating agent state', this.agentState);
        return this.metadataLock.inLock(async () => {
            if (
                this.metadataLayoutVersion !== 0
                && this.metadataLayoutVersion
                    !== SESSION_METADATA_LAYOUT_VERSION_V1
            ) {
                throw Object.assign(new Error('Unsupported session metadata layout'), {
                    code: 'metadata_privacy_upgrade_required',
                    retryable: false,
                });
            }
            const credentials = await this.readCurrentOwnerCredentials();
            if (!credentials || credentials.token !== this.token) {
                throw Object.assign(
                    new Error('Owner session metadata encryption material is unavailable'),
                    {
                        code: 'metadata_privacy_upgrade_required',
                        retryable: false,
                    },
                );
            }
            const accountEncryptionCurrentness = await this.runSessionRequest(() => this.getAccountEncryptionCurrentness());
            const updated = await this.runSessionRequest(async () => updateSessionMetadataEnvelopeTupleWithRetry({
                token: this.token,
                sessionId: this.sessionId,
                authority: {
                    kind: 'owner',
                    credentials,
                    accountEncryptionCurrentness,
                },
                ...this.getMetadataTupleCryptoContext(),
                initialSnapshot:
                    await this.acquireMetadataTupleWriterSnapshot(
                        credentials,
                        accountEncryptionCurrentness,
                    ),
                mutation: {
                    kind: 'agentState',
                    update: handler,
                },
                mutateLegacy: async (request) =>
                    await this.mutateLegacySessionTuple(request),
            }));
            if (updated.mode === 'shared_editor') {
                throw Object.assign(
                    new Error('Owner session Agent-state mutation changed to shared-editor authority'),
                    {
                        code: 'metadata_privacy_upgrade_required',
                        retryable: false,
                    },
                );
            }
            if (updated.metadataLayoutVersion === 1) {
                this.applyMetadataEnvelopeTupleSnapshot(updated);
            }
        });
    }

    enqueueSessionTurnMutation(mutation: RuntimeSessionTurnMutationV1): Promise<void> {
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
        const update = mutation.fieldId === 'runtime.activity'
            ? this.enqueueRuntimeActivityAndWaitForPublisherAuthority(mutation)
            : this.durableMutationOutbox.enqueueRegisteredSessionStateFieldMutation(mutation);
        this.trackPendingUpdate(this.pendingRegisteredSessionStateFieldUpdates, update);
        return update;
    }

    private async enqueueRuntimeActivityAndWaitForPublisherAuthority(
        mutation: RegisteredSessionStateFieldMutationV1,
    ): Promise<void> {
        const settlement =
            await this.durableMutationOutbox.enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery(mutation);
        if (settlement.status === 'applied' || settlement.status === 'unchanged') {
            return;
        }
        if (
            settlement.status === 'failed'
            && this.sessionSyncPendingInputServerContractResult?.runtimeActivity === 'legacy'
        ) {
            // The immutable server-v0.2.1 adapter has no Runtime Activity publisher contract.
            // Its exact pending ACK + transcript lookup path remains the authority in that mode.
            return;
        }
        throw new Error(`Runtime Activity publisher authority did not settle: ${settlement.status}`);
    }

    async activateDurableMutationDelivery(): Promise<void> {
        await this.durableMutationOutbox.activateDelivery();
        this.durableMutationDeliveryActive = true;
    }

    deactivateDurableMutationDelivery(): void {
        this.durableMutationDeliveryActive = false;
        this.durableMutationOutbox.deactivateDelivery();
    }

    async stageInitialDurableMutationSnapshots(): Promise<void> {
        for (const mutation of this.initialRegisteredSessionStateFieldMutations) {
            await this.durableMutationOutbox.enqueueRegisteredSessionStateFieldMutation(mutation);
        }
    }

    async flushDurableMutationDelivery(): Promise<void> {
        await this.durableMutationOutbox.flush('flush');
    }

    private async drainBestEffortSessionWrites(): Promise<void> {
        await Promise.all([
            ...[...this.pendingProviderInputSettlementWrites].map((update) => update.catch(() => undefined)),
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
            ...[...this.pendingProviderInputSettlementWrites].map((update) => update.catch(() => undefined)),
            ...[...this.pendingSessionTurnMutationUpdates].map((update) => update.catch(() => undefined)),
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

    subscribeCommittedUserMessageSeq(listener: CommittedUserMessageSeqListener): () => void {
        return this.committedUserMessageSeqTracker.subscribe(listener);
    }

    subscribePendingProviderInputRetirement(listener: (localId: string) => void): () => void {
        const observe = (localId: string): void => {
            try {
                listener(localId);
            } catch (error) {
                logger.warn('[pendingQueue] provider-input retirement observer failed', { localId, error });
            }
        };
        this.on('pending-provider-input-retired', observe);
        return () => { this.off('pending-provider-input-retired', observe); };
    }

    getTurnAssistantTextSnapshotStore(): TurnAssistantTextSnapshotStore {
        return this.turnAssistantTextSnapshotStore;
    }

    private async readCurrentPublisherPrecondition():
        Promise<SessionMetadataPublisherPreconditionV1 | null> {
        while (true) {
            const contract = await this.waitForPublisherClaimServerContract();
            if (!this.isCurrentPublisherClaimServerContract(contract)) {
                continue;
            }
            if (!supportsSessionPublisherAuthorityCheckV1(contract)) {
                return null;
            }
            const raw = await emitSocketWithAck({
                socket: contract.socket as any,
                event: SESSION_PUBLISHER_AUTHORITY_CHECK_EVENT,
                payload: SessionPublisherAuthorityCheckRequestSchema.parse({
                    sessionId: this.sessionId,
                }),
            });
            if (!this.isCurrentPublisherClaimServerContract(contract)) {
                return null;
            }
            const acknowledgement =
                SessionPublisherAuthorityCheckAckSchema.safeParse(raw);
            return acknowledgement.success
                && acknowledgement.data.status === 'current'
                && acknowledgement.data.sessionId === this.sessionId
                    ? acknowledgement.data.publisherPrecondition
                    : null;
        }
    }

    /**
     * Reads the exact current-publisher fence after startup has claimed and
     * refreshed the Session. Transition admissions carry this value to their
     * single server transaction; ordinary runtime work uses the narrower
     * boolean check below.
     */
    async readCurrentPublisherPreconditionForStartup():
        Promise<SessionMetadataPublisherPreconditionV1 | null> {
        return await this.readCurrentPublisherPrecondition();
    }

    /**
     * Checks the cached publisher registration on this exact authenticated
     * session socket against the server's committed DB fence.
     */
    async checkCurrentPublisherAuthority(): Promise<boolean> {
        return (await this.readCurrentPublisherPrecondition()) !== null;
    }

    /** Observe content-free Follow progress for this authenticated destination Session. */
    async observePendingSessionFollow() {
        const request = SessionFollowObservePendingRequestV1Schema.parse({
            v: 1,
            sessionId: this.sessionId,
            includeReportsTo: true,
        });
        const raw = await emitSocketWithAck<unknown>({
            socket: this.socket as any,
            event: SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1,
            payload: request,
        });
        return SessionFollowObservePendingResponseV1Schema.parse(raw);
    }

    /**
     * Runs a Follow source read against this exact Session client's Home.
     *
     * The daemon can hold Sessions from several Homes at once, while the
     * legacy HTTP helpers resolve their base URL from async context. Keep that
     * ambient detail inside the Session transport owner and reject credentials
     * that do not belong to this authenticated client before any source read.
     */
    runSessionFollowSourceRequest<T>(input: Readonly<{
        credentials: Pick<StoredCredentials, 'token'>;
        request: () => T;
    }>): T {
        if (input.credentials.token !== this.token) {
            throw new Error('Session Follow source credentials do not belong to the destination Session Home');
        }
        return this.runSessionRequest(input.request);
    }

    /** Acknowledge one exact Follow frontier after provider acceptance. */
    async acknowledgeSessionFollow(input: Omit<SessionFollowAcknowledgeRequestV1, 'v' | 'destinationSessionId'>) {
        const request = SessionFollowAcknowledgeRequestV1Schema.parse({
            ...input,
            v: 1,
            destinationSessionId: this.sessionId,
        });
        const raw = await emitSocketWithAck<unknown>({
            socket: this.socket as any,
            event: SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1,
            payload: request,
        });
        return SessionFollowAcknowledgeResponseV1Schema.parse(raw);
    }

    /** Observe Account Follow sources selected for this bound Voice Session. */
    async observePendingAccountVoiceFollow(input: Readonly<{ executionRunId: string }>) {
        const request = AccountVoiceFollowObservePendingRequestV1Schema.parse({
            v: 1,
            voiceSessionId: this.sessionId,
            executionRunId: input.executionRunId,
        });
        const raw = await emitSocketWithAck<unknown>({
            socket: this.socket as any,
            event: ACCOUNT_VOICE_FOLLOW_OBSERVE_PENDING_EVENT_V1,
            payload: request,
        });
        return AccountVoiceFollowObservePendingResponseV1Schema.parse(raw);
    }

    /** Advance one Account Voice frontier after the exact provider input is accepted. */
    async acknowledgeAccountVoiceFollow(input: Omit<AccountVoiceFollowAcknowledgeRequestV1, 'v' | 'voiceSessionId'>) {
        const request = AccountVoiceFollowAcknowledgeRequestV1Schema.parse({
            ...input,
            v: 1,
            voiceSessionId: this.sessionId,
        });
        const raw = await emitSocketWithAck<unknown>({
            socket: this.socket as any,
            event: ACCOUNT_VOICE_FOLLOW_ACKNOWLEDGE_EVENT_V1,
            payload: request,
        });
        return AccountVoiceFollowAcknowledgeResponseV1Schema.parse(raw);
    }

    /**
     * Posts through this exact authenticated current-publisher socket. The
     * server derives Agent provenance after rechecking publisher authority;
     * callers cannot supply a producer projection.
     */
    async postAgentDiscussionMessage(
        input: Omit<SessionDiscussionAgentPostRequestV1, 'v' | 'sessionId'>,
        options?: Readonly<{ signal?: AbortSignal }>,
    ) {
        options?.signal?.throwIfAborted();
        const request = SessionDiscussionAgentPostRequestV1Schema.parse({
            ...input,
            v: 1,
            sessionId: this.sessionId,
        });
        const raw = await emitSocketWithAck<unknown>({
            socket: this.socket as any,
            event: SESSION_DISCUSSION_AGENT_POST_EVENT_V1,
            payload: request,
            ...(options?.signal ? { signal: options.signal } : {}),
        });
        options?.signal?.throwIfAborted();
        return SessionDiscussionAgentPostResponseV1Schema.parse(raw);
    }

    private async closeRegisteredRuntimeActivityPublisher(): Promise<void> {
        await this.durableMutationOutbox.flush('flush');
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
                const authoritativeSession = await this.runSessionRequest(async () => fetchSessionByIdCompat({
                    token: this.token,
                    sessionId: this.sessionId,
                    reason: 'legacy-compat-proof',
                }));
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

    async endSessionAndClose(): Promise<void> {
        if (this.endSessionAndClosePromise) {
            await this.endSessionAndClosePromise;
            return;
        }
        if (this.closed) {
            throw new Error('Cannot author semantic session end after transport disposal');
        }
        const attempt = (async () => {
            const mutationId = this.semanticSessionEndMutationId;
            await this.durableMutationOutbox.enqueueSessionEnd({
                v: 1,
                sessionId: this.sessionId,
                mutationId,
                source: 'session_end',
                observedAt: Date.now(),
            });
            await this.close();
        })();
        this.endSessionAndClosePromise = attempt;
        try {
            await attempt;
        } catch (error) {
            if (this.endSessionAndClosePromise === attempt) {
                this.endSessionAndClosePromise = null;
            }
            throw error;
        }
    }

    async close() {
        await this.sessionHandlersRegistration.dispose();
        const disposeSessionFollowWakeReceiver = this.disposeSessionFollowWakeReceiver;
        this.disposeSessionFollowWakeReceiver = null;
        disposeSessionFollowWakeReceiver?.();
        this.acceptedPendingSettlementOperationAbortController.abort();
        await this.sessionActionConfirmationRecovery;
        await this.sessionActionConfirmationAdapter?.dispose();
        this.agentStateResponseTargetDispatcher.dispose();
        this.committedUserMessageSeqTracker.clear();
        this.executionRunPendingTargetListeners.clear();
        await this.drainPendingLifecycleWritesBeforeClose();
        await this.closeRegisteredRuntimeActivityPublisher().catch((error) => {
            logger.debug('[API] Failed to close registered runtime Activity publisher (non-fatal)', {
                error: serializeAxiosErrorForLog(error),
            });
        });
        await this.interactionApi.close();
        await this.durableMutationOutbox.close();
        this.emit('local-closed');
    }

    async listPendingMessageQueueV2LocalIds(): Promise<string[]> {
        return await this.interactionApi.listPendingMessageQueueV2LocalIds();
    }

    async peekPendingMessageQueueV2Count(): Promise<number> {
        return await this.interactionApi.peekPendingMessageQueueV2Count();
    }

    shouldAttemptPendingMaterialization(): boolean {
        return this.materializationRuntime.shouldAttemptPendingMaterialization();
    }

    getPendingQueueState(): PendingQueueState {
        return this.materializationRuntime.getPendingQueueState();
    }

    async reconcilePendingQueueState(opts?: { force?: boolean }): Promise<boolean> {
        const changed = await this.interactionApi.reconcilePendingQueueState(opts);
        await this.reconcilePendingProviderInputCustodyBeforeMaterialization();
        return changed;
    }

    async materializeNextPendingMessageSafely(opts: MaterializeNextPendingOptions = {}): Promise<MaterializeNextPendingResult> {
        return await this.interactionApi.materializeNextPendingMessageSafely(opts);
    }

    bindExecutionRunPendingInput(options: ExecutionRunPendingInputBinding): ExecutionRunPendingInputPort {
        const { runId } = options.recipient;
        let disposed = false;
        const binding: ExecutionRunPendingInputBinding = {
            ...options,
            isCurrent: () => !disposed && !this.closed
                && this.executionRunPendingBindings.get(runId) === binding && options.isCurrent(),
        };
        this.executionRunPendingBindings.set(runId, binding);
        const ownsLocalId = (localId: string): boolean => this.executionRunPendingCustody.get(localId) === binding;
        return {
            getMetadataSnapshot: options.getMetadataSnapshot,
            waitForMetadataUpdate: (signal) => this.waitForMetadataUpdate(signal),
            shouldAttemptPendingMaterialization: () => binding.isCurrent(),
            reconcilePendingProviderInputCustodyBeforeMaterialization: async () => binding.isCurrent()
                && ![...this.materializationRuntime.pendingQueueMaterializedLocalIds].some(ownsLocalId),
            materializeNextPendingMessageSafely: (opts) => this.interactionApi.materializeNextExecutionRunPendingMessageSafely({
                ...binding,
                hasCustody: (localId) => this.hasPendingProviderInput(localId),
                markCustody: (localId) => {
                    const incumbent = this.executionRunPendingCustody.get(localId);
                    if (incumbent && incumbent !== binding) throw new Error('Pending input already belongs to another run binding');
                    this.executionRunPendingCustody.set(localId, binding);
                    this.materializationRuntime.markPendingQueueMaterializedLocalId(localId);
                    this.materializationRuntime.markAgentQueueEchoSuppressedLocalId(localId);
                },
            }, opts),
            observeProviderInputSettlement: (outcome) => binding.isCurrent() && ownsLocalId(outcome.localId)
                ? this.observeProviderInputSettlement(outcome) : Promise.resolve(false),
            // Rejoin reads are scoped by the exact current Run binding and the
            // persisted recipient anchor; local in-memory custody is not required
            // after an acknowledgement loss or process restart.
            readDurableProviderInputAcceptanceV1: (localId) => binding.isCurrent()
                ? this.readDurableProviderInputAcceptanceV1(localId, runId) : Promise.resolve('unknown'),
            dispose: () => {
                disposed = true;
                if (this.executionRunPendingBindings.get(runId) === binding) this.executionRunPendingBindings.delete(runId);
            },
        };
    }

    private async notifyExecutionRunPendingTarget(runId: string): Promise<void> {
        const binding = this.executionRunPendingBindings.get(runId);
        if (binding?.isCurrent()) binding.wake?.();
        await Promise.all([...this.executionRunPendingTargetListeners].map(async (listener) => {
            await listener(runId);
        }));
    }

    subscribeExecutionRunPendingTarget(
        listener: (runId: string) => void | Promise<void>,
    ): () => void {
        this.executionRunPendingTargetListeners.add(listener);
        for (const runId of this.initialExecutionRunPendingTargetIds) {
            void Promise.resolve().then(() => listener(runId)).catch((error) => {
                logger.debug('[pendingQueue] initial execution-run target reconciliation failed closed', {
                    sessionId: this.sessionId,
                    runId,
                    error: serializeAxiosErrorForLog(error),
                });
            });
        }
        return () => this.executionRunPendingTargetListeners.delete(listener);
    }

    async listExecutionRunPendingDeliveryStatuses(
        runId: string,
    ): Promise<PendingQueueV2DeliveryStatusEntry[]> {
        return await this.runSessionRequest(async () => listPendingQueueV2DeliveryStatusesFromServer({
            token: this.token,
            sessionId: this.sessionId,
            recipient: { kind: 'execution_run', runId },
        }));
    }

    async blockExecutionRunPendingDelivery(runId: string, localId: string): Promise<boolean> {
        const result = await blockPendingExecutionRunDelivery({
            socket: this.socket,
            sessionId: this.sessionId,
            recipient: { kind: 'execution_run', runId },
            localId,
            reason: 'session_input_target_unavailable',
        });
        if (result.pendingQueueState && this.materializationRuntime.applyPendingQueueState(result.pendingQueueState)) {
            this.emit('metadata-updated');
        }
        return result.didUpdate;
    }

    hasPendingProviderInput(localId: string): boolean {
        const normalizedLocalId = readPendingLocalId(localId);
        return normalizedLocalId !== null
            && this.materializationRuntime.hasPendingQueueMaterializedLocalId(normalizedLocalId);
    }

    private deletePendingProviderInputLocalState(localId: string): void {
        this.materializationRuntime.deleteMaterializedLocalId(localId);
        this.nonBlockingArchivedPendingDeliveryLocalIds.delete(localId);
    }

    /**
     * The durable, restart-surviving accepted-delivery status for one exact Pending localId.
     *
     * This adds no acceptance fact. It reads the two the Pending owner already keeps: the
     * committed transcript row a resolved delivery produces, and the server's own pending
     * projection. A row whose status proves no provider effect is `not_accepted`; any live or
     * archived status for which a provider effect remains possible is `unknown`. The process-local
     * tracker is only a fast path: after restart, the existing exact transcript lookup recovers the
     * committed row before Pending absence is interpreted. A failed exact lookup stays `unknown` so
     * no caller may read an unavailable acceptance fact as either outcome.
     */
    async readDurableProviderInputAcceptanceV1(
        localId: string,
        runId?: string,
    ): Promise<DurableProviderInputAcceptanceV1> {
        const normalizedLocalId = readPendingLocalId(localId);
        if (!normalizedLocalId) return 'unknown';
        const targetRecipient = runId === undefined
            ? undefined
            : { kind: 'execution_run' as const, runId };
        if (this.getCommittedUserMessageSeq(normalizedLocalId) !== null) return 'accepted';
        try {
            const transcriptLookup = await findTranscriptEncryptedMessageByLocalIdV2({
                token: this.token,
                serverUrl: this.transport.serverUrl,
                sessionId: this.sessionId,
                localId: normalizedLocalId,
            });
            if (transcriptLookup.type === 'found') {
                return transcriptLookup.message.localId === normalizedLocalId
                    ? 'accepted'
                    : 'unknown';
            }
            if (transcriptLookup.type !== 'not_found') return 'unknown';
            // Main pending absence is not evidence about an execution-run row. For the main
            // route, local provider custody also remains ambiguous; target reads use their
            // exact route so a restart/reconnect can recover a definitive pre-effect outcome.
            if (!targetRecipient && this.executionRunPendingCustody.has(normalizedLocalId)) return 'unknown';

            const statuses = await this.runSessionRequest(async () => listPendingQueueV2DeliveryStatusesFromServer({
                token: this.token,
                sessionId: this.sessionId,
                includeDiscarded: true,
                ...(targetRecipient ? { recipient: targetRecipient } : {}),
            }));
            const entry = statuses.find((candidate) => candidate.localId === normalizedLocalId);
            if (!entry) return 'unknown';
            return isPendingDeliveryProviderEffectPossibleV1(entry.deliveryStatus)
                || (entry.deliveryStatus.status === 'discarded'
                    && isPendingDeliveryArchivedUncertaintyReasonV1(entry.deliveryStatus.reason))
                ? 'unknown'
                : 'not_accepted';
        } catch (error) {
            logger.debug('[pendingQueue] durable provider-input acceptance read failed', {
                sessionId: this.sessionId,
                localId: normalizedLocalId,
                error: serializeAxiosErrorForLog(error),
            });
            return 'unknown';
        }
    }

    async reconcilePendingProviderInputCustodyBeforeMaterialization(): Promise<boolean> {
        if (this.closed) return false;
        const localIds = [...this.materializationRuntime.pendingQueueMaterializedLocalIds]
            .filter((localId) => (
                !this.executionRunPendingCustody.has(localId)
            ));
        if (localIds.length === 0) return true;

        try {
            const statuses = await this.runSessionRequest(async () => listPendingQueueV2DeliveryStatusesFromServer({
                token: this.token,
                sessionId: this.sessionId,
                includeDiscarded: true,
            }));
            const statusByLocalId = new Map(statuses.map((entry) => [entry.localId, entry.deliveryStatus]));
            for (const localId of localIds) {
                const status = statusByLocalId.get(localId);
                if (
                    status?.status === 'discarded'
                    && isPendingDeliveryArchivedUncertaintyReasonV1(status.reason)
                ) {
                    this.nonBlockingArchivedPendingDeliveryLocalIds.add(localId);
                    continue;
                }
                if (status !== undefined && status.status !== 'discarded') continue;
                if (!this.materializationRuntime.hasPendingQueueMaterializedLocalId(localId)) continue;
                // Provider acceptance may have begun while the Pending snapshot was read.
                if (this.acceptedPendingSettlementLocalIdsInFlight.has(localId)) continue;
                if (status === undefined) {
                    // Protected admission commits the user transcript and removes the Pending row
                    // before the provider accepts the input. Absence alone cannot retire its custody.
                    const transcript = await findTranscriptEncryptedMessageByLocalIdV2({
                        token: this.token,
                        serverUrl: this.transport.serverUrl,
                        sessionId: this.sessionId,
                        localId,
                    });
                    if (transcript.type === 'found' && transcript.message.localId === localId) continue;
                    if (transcript.type !== 'not_found') continue;
                }
                if (!this.materializationRuntime.hasPendingQueueMaterializedLocalId(localId)) continue;
                // Acceptance may also start while the transcript lookup is in flight.
                if (this.acceptedPendingSettlementLocalIdsInFlight.has(localId)) continue;
                logger.debug('[pendingQueue] exact terminal server truth retired local provider custody', {
                    sessionId: this.sessionId,
                    localId,
                    serverStatus: status?.status ?? 'absent',
                });
                this.deletePendingProviderInputLocalState(localId);
                this.acceptedPendingSettlementLocalIds.delete(localId);
                this.emit('pending-provider-input-retired', localId);
            }
        } catch (error) {
            logger.debug('[pendingQueue] exact local provider custody reconciliation failed closed', {
                sessionId: this.sessionId,
                localIds,
                error: serializeAxiosErrorForLog(error),
            });
        }

        return ![...this.materializationRuntime.pendingQueueMaterializedLocalIds]
            .some((localId) => (
                !this.executionRunPendingCustody.has(localId)
                && !this.nonBlockingArchivedPendingDeliveryLocalIds.has(localId)
            ));
    }

    /**
     * Persists the host-normalized outcome for one exact claimed Pending row. Provider-specific
     * evidence classification and terminal monotonicity stay in the host normalizer.
     */
    private isAcceptedPendingSettlementOperationCurrent(
        authority: AcceptedPendingSettlementOperationAuthority,
        localId: string,
    ): boolean {
        return !this.closed
            && !authority.abortSignal.aborted
            && authority.socket === this.socket
            && authority.socket.connected === true
            && authority.sessionConnectionEpoch === this.sessionConnectionEpoch
            && (authority.executionRun
                ? authority.executionRun.isCurrent() && this.executionRunPendingCustody.get(localId) === authority.executionRun
                : authority.providerInputConsumer === this.providerInputConsumer)
            && this.materializationRuntime.hasPendingQueueMaterializedLocalId(localId);
    }

    private async resolveAcceptedPendingDeliveryOperation(
        localId: string,
        authority: AcceptedPendingSettlementOperationAuthority,
    ): Promise<void> {
        if (this.acceptedPendingSettlementLocalIdsInFlight.has(localId)) return;
        this.acceptedPendingSettlementLocalIdsInFlight.add(localId);
        try {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                if (!this.isAcceptedPendingSettlementOperationCurrent(authority, localId)) return;
                try {
                    const acceptedDelivery = this.acceptedPendingSettlementLocalIds.get(localId);
                    const result = authority.executionRun ? await resolveAcceptedPendingExecutionRunDelivery({
                        socket: authority.socket, sessionId: this.sessionId, localId,
                        recipient: authority.executionRun.recipient, sidechainId: authority.executionRun.sidechainId,
                        ...(acceptedDelivery === undefined ? {} : { acceptedDelivery }),
                    }) : await resolveAcceptedPendingQueueV2Delivery({
                        socket: authority.socket,
                        sessionId: this.sessionId,
                        localId,
                        ...(acceptedDelivery === undefined ? {} : { acceptedDelivery }),
                    });
                    if (!this.isAcceptedPendingSettlementOperationCurrent(authority, localId)) return;
                    if (!authority.executionRun && result.pendingQueueState && this.materializationRuntime.applyPendingQueueState(result.pendingQueueState)) {
                        this.emit('metadata-updated');
                    }
                    const hasExactCommittedMessage = result.message?.localId === localId
                        && typeof result.message.seq === 'number'
                        && Number.isSafeInteger(result.message.seq)
                        && result.message.seq >= 0;
                    const hasExactCommittedReplay = result.didResolve === false
                        && hasExactCommittedMessage;
                    if (result.didResolve !== true && !hasExactCommittedReplay) {
                        logger.infoFile('[pendingQueue] accepted provider-input settlement remains unresolved', {
                            sessionId: this.sessionId,
                            localId,
                            reason: 'settlement_noop_without_exact_commit',
                        });
                        return;
                    }
                    if (hasExactCommittedMessage) {
                        this.recordCommittedUserMessageSeq(localId, result.message!.seq);
                    }
                    this.deletePendingProviderInputLocalState(localId);
                    if (authority.executionRun) {
                        this.executionRunPendingCustody.delete(localId);
                    }
                    this.acceptedPendingSettlementLocalIds.delete(localId);
                    return;
                } catch (error) {
                    const serializedError = serializeAcceptedPendingSettlementErrorForLog(error);
                    logger.debug('[pendingQueue] accepted provider-input settlement failed', {
                        sessionId: this.sessionId,
                        localId,
                        error: serializedError,
                    });
                    if (!this.isAcceptedPendingSettlementOperationCurrent(authority, localId)) return;
                    if (attempt > 0) {
                        logger.infoFile('[pendingQueue] accepted provider-input settlement remains unresolved', {
                            sessionId: this.sessionId,
                            localId,
                            reason: 'settlement_error',
                            attempt: attempt + 1,
                            error: serializedError,
                        });
                        return;
                    }
                    const retryDirective = readAcceptedPendingQueueV2DeliveryRetryDirective(error);
                    const isResponseLoss = isAcceptedPendingQueueV2DeliveryAckResponseLoss(error);
                    if (!retryDirective && !isResponseLoss) {
                        logger.infoFile('[pendingQueue] accepted provider-input settlement remains unresolved', {
                            sessionId: this.sessionId,
                            localId,
                            reason: 'settlement_error',
                            attempt: attempt + 1,
                            error: serializedError,
                        });
                        return;
                    }
                    const retryAfterMs = retryDirective
                        ? Math.min(60_000, Math.max(250, retryDirective.retryAfterMs))
                        : 1_000;
                    await delayUnrefAbortable(retryAfterMs, authority.abortSignal);
                }
            }
        } finally {
            this.acceptedPendingSettlementLocalIdsInFlight.delete(localId);
        }
    }

    private trackAcceptedPendingSettlement(
        localId: string,
        authority: AcceptedPendingSettlementOperationAuthority,
    ): Promise<void> {
        const settlement = this.resolveAcceptedPendingDeliveryOperation(localId, authority)
            .catch((error) => {
                logger.infoFile('[pendingQueue] accepted provider-input settlement resolution crashed', {
                    sessionId: this.sessionId,
                    localId,
                    error: serializeAxiosErrorForLog(error),
                });
                throw error;
            });
        this.pendingProviderInputSettlementWrites.add(settlement);
        this.acceptedPendingSettlementWrites.add(settlement);
        return settlement.finally(() => {
            this.pendingProviderInputSettlementWrites.delete(settlement);
            this.acceptedPendingSettlementWrites.delete(settlement);
        });
    }

    private reofferAcceptedProviderInputSettlementsAfterConnection(): void {
        const sessionConnectionEpoch = this.sessionConnectionEpoch;
        const socket = this.socket;
        const precedingSettlements = [...this.acceptedPendingSettlementWrites];
        void (async () => {
            await Promise.all(precedingSettlements.map((settlement) => settlement.catch(() => undefined)));
            if (
                this.closed
                || sessionConnectionEpoch !== this.sessionConnectionEpoch
                || socket !== this.socket
                || socket.connected !== true
            ) {
                return;
            }
            const authority: AcceptedPendingSettlementOperationAuthority = {
                sessionConnectionEpoch,
                socket,
                providerInputConsumer: this.providerInputConsumer,
                abortSignal: this.acceptedPendingSettlementOperationAbortController.signal,
            };
            for (const localId of this.acceptedPendingSettlementLocalIds.keys()) {
                if (!this.hasPendingProviderInput(localId)) {
                    this.acceptedPendingSettlementLocalIds.delete(localId);
                    continue;
                }
                const executionRun = this.executionRunPendingCustody.get(localId);
                void this.trackAcceptedPendingSettlement(localId, { ...authority, ...(executionRun ? { executionRun } : {}) }).catch((error) => {
                    logger.debug('[pendingQueue] accepted provider-input settlement reoffer failed', {
                        sessionId: this.sessionId,
                        localId,
                        error: serializeAxiosErrorForLog(error),
                    });
                });
            }
        })().catch((error) => {
            logger.debug('[pendingQueue] accepted provider-input settlement reoffer crashed', {
                sessionId: this.sessionId,
                error: serializeAxiosErrorForLog(error),
            });
        });
    }

    observeProviderInputSettlement(outcome: SessionProviderInputOutcome): Promise<boolean> {
        const localId = readPendingLocalId(outcome.localId);
        if (!localId || this.closed || !this.hasPendingProviderInput(localId)) return Promise.resolve(false);
        if (outcome.kind === 'custody_observed') return Promise.resolve(false);
        const executionRun = this.executionRunPendingCustody.get(localId);
        if (executionRun && !executionRun.isCurrent()) return Promise.resolve(false);

        let didRetireExactPreProviderCustody = false;
        const settlement = (async () => {
            if (outcome.kind === 'accepted') {
                if (!this.acceptedPendingSettlementLocalIds.has(localId)) {
                    const facts = SessionMessageAcceptedDeliveryFactsV1Schema.safeParse({
                        v: 1,
                        acceptedAtMs: outcome.acceptedAtMs,
                        delivery: { kind: outcome.providerDeliveryKind, turnId: outcome.providerTurnId },
                    });
                    let acceptedDelivery: SessionMessageAcceptedDeliveryContentV1 | undefined;
                    if (facts.success) {
                        const payload = this.commitQueueRuntime.buildOutboundSessionMessagePayload(facts.data);
                        acceptedDelivery = typeof payload === 'string'
                            ? { t: 'encrypted', c: payload }
                            : { t: 'plain', v: facts.data };
                    }
                    this.acceptedPendingSettlementLocalIds.set(localId, acceptedDelivery);
                }
                if (outcome.appliedModel && !executionRun) {
                    const appliedModel = SessionAppliedModelV1Schema.parse({
                        v: 1,
                        provider: outcome.appliedModel.provider,
                        updatedAt: Date.now(),
                        modelId: outcome.appliedModel.selection.modelId,
                        selection: outcome.appliedModel.selection,
                    });
                    updateMetadataBestEffort(
                        this,
                        (metadata) => {
                            const existing = metadata.sessionAppliedModelV1;
                            return existing?.provider === appliedModel.provider
                                && existing.modelId === appliedModel.modelId
                                && existing.selection?.agentTargetKey === appliedModel.selection?.agentTargetKey
                                && existing.selection?.providerConnectionId === appliedModel.selection?.providerConnectionId
                                && existing.selection?.modelId === appliedModel.selection?.modelId
                                ? metadata
                                : { ...metadata, sessionAppliedModelV1: appliedModel };
                        },
                        '[pendingQueue]',
                        'provider_prompt_applied_model',
                    );
                }
                const authority: AcceptedPendingSettlementOperationAuthority = {
                    sessionConnectionEpoch: this.sessionConnectionEpoch,
                    socket: this.socket,
                    providerInputConsumer: this.providerInputConsumer,
                    abortSignal: this.acceptedPendingSettlementOperationAbortController.signal,
                    ...(executionRun ? { executionRun } : {}),
                };
                await this.trackAcceptedPendingSettlement(localId, authority);
                return;
            }

            const reason = outcome.kind === 'rejected_before_effect'
                ? outcome.reason
                : 'delivery_outcome_uncertain';
            const result = executionRun ? await blockPendingExecutionRunDelivery({
                socket: this.socket, sessionId: this.sessionId, localId, recipient: executionRun.recipient, reason,
            }) : await this.runSessionRequest(async () => blockPendingQueueV2Delivery({
                token: this.token,
                sessionId: this.sessionId,
                localId,
                reason,
            }));
            const didRequeueConditionalSteer =
                reason === 'conditional_steer_unavailable'
                && (!('usedLegacySteeringUnavailableFallback' in result) || result.usedLegacySteeringUnavailableFallback !== true);
            if (executionRun && !executionRun.isCurrent()) return;
            if (!executionRun && result.pendingQueueState && this.materializationRuntime.applyPendingQueueState(result.pendingQueueState)) {
                this.emit('metadata-updated');
            }
            if (didRequeueConditionalSteer) {
                this.deletePendingProviderInputLocalState(localId);
                if (executionRun) this.executionRunPendingCustody.delete(localId);
                this.materializationRuntime.clearAgentQueueEchoSuppressedLocalId(localId);
            }
            if (
                outcome.kind === 'rejected_before_effect'
                && (
                    !isReversibleSessionProviderInputBlockReason(outcome.reason)
                    || outcome.retireLocalCustodyAfterDurableBlock === true
                )
            ) {
                this.deletePendingProviderInputLocalState(localId);
                if (executionRun) this.executionRunPendingCustody.delete(localId);
                didRetireExactPreProviderCustody =
                    outcome.reason === 'provider_unavailable_before_acceptance'
                    && outcome.retireLocalCustodyAfterDurableBlock === true;
            }
        })();
        if (outcome.kind !== 'accepted') {
            this.pendingProviderInputSettlementWrites.add(settlement);
        }
        return settlement
            .then(
                () => didRetireExactPreProviderCustody,
                (error: unknown) => {
                    logger.debug('[pendingQueue] provider-input settlement failed', {
                        sessionId: this.sessionId,
                        localId,
                        outcomeKind: outcome.kind,
                        error: serializeAxiosErrorForLog(error),
                    });
                    return false;
                },
            )
            .finally(() => {
                if (outcome.kind !== 'accepted') {
                    this.pendingProviderInputSettlementWrites.delete(settlement);
                }
            });
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
                this.pendingWakeSeq += 1;
                this.emit('metadata-updated');
            });
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

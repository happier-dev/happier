import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';
import type { Socket } from 'socket.io-client';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import { resolveServerHttpBaseUrl } from '../client/serverHttpBaseUrl';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import {
    ACCEPTED_PENDING_SETTLEMENT_EVENT_V1,
    AcceptedPendingSettlementRequestV1Schema,
    AcceptedPendingSettlementResponseV1Schema,
    normalizePendingDeliveryBlockedReason,
    normalizePendingDeliveryStatusV1,
    normalizePendingRequestedActionV1,
    PendingProviderActionSchema,
    SessionInputAdmissionReceiptV1Schema,
    SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1,
    SessionPendingAdmissionSettlementRequestV1Schema,
    SessionPendingAdmissionSettlementResponseV1Schema,
    parsePendingDeliveryStatusV1,
    readPendingLocalId,
    SessionMessageRoleSchema,
    type PendingDeliveryBlockedReason,
    type PendingDeliveryStatusV1,
    type PendingProviderAction,
    type SessionInputRequestEqualityEvidenceV1,
    type SessionInputAdmissionReceiptV1,
    type SessionPendingAdmissionSettlementRequestV1,
    type SessionMessageRole,
} from '@happier-dev/protocol';
import { SessionMessageContentSchema, type SessionMessageContent } from '../types';
import { readKnownPendingQueueState, type KnownPendingQueueState } from './pendingQueueState';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';

export type PendingMaterializationDeliveryTiming = 'after_foreground_ready' | 'after_runtime_idle';
export type PendingClaimForegroundState = 'ready' | 'active_steerable' | 'active_unsteerable';
export type { PendingProviderAction } from '@happier-dev/protocol';

export type PendingMaterializationProviderDeliveryState = Readonly<{
    mode: 'provider';
    unresolved: boolean;
}>;

export type PendingMaterializationDeliveryState = PendingMaterializationProviderDeliveryState;

export type PendingQueueMaterializedMessage = {
    id: string | null;
    seq: number | null;
    localId: string | null;
    messageRole: SessionMessageRole | null;
    content: SessionMessageContent | null;
    createdAt: number | null;
    updatedAt: number | null;
    requestedAction: ReturnType<typeof normalizePendingRequestedActionV1>;
    providerAction: PendingProviderAction | null;
    inputAdmissionReceipt: SessionInputAdmissionReceiptV1 | null;
    deliveryState?: PendingMaterializationDeliveryState | null;
    deliveryStateMalformed?: boolean;
};

export type PendingQueueMaterializeNextResult = {
    didMaterialize: boolean;
    localId: string | null;
    didWrite: boolean;
    pendingQueueState: KnownPendingQueueState | null;
    message: PendingQueueMaterializedMessage | null;
    deliveryState?: PendingMaterializationDeliveryState | null;
    deferredReason?: 'waiting_for_foreground_turn' | 'waiting_for_runtime_activity' | 'runtime_activity_unknown' | 'waiting_for_predecessor' | 'steering_unavailable';
};

export type PendingQueueMaterializationTransportClassification =
    | 'server_rejected'
    | 'server_retryable'
    | 'socket_disconnected'
    | 'ack_timeout'
    | 'malformed_ack'
    | 'transport_failure';

export type PendingQueueMaterializationTransportDiagnosticCode =
    | 'pending_queue_materialization_server_rejected'
    | 'pending_queue_materialization_server_retryable'
    | 'pending_queue_materialization_socket_disconnected'
    | 'pending_queue_materialization_ack_timeout'
    | 'pending_queue_materialization_ack_malformed'
    | 'pending_queue_materialization_transport_failure';

export type PendingQueueMaterializationTransportDiagnostic = Readonly<{
    classification: PendingQueueMaterializationTransportClassification;
    diagnosticCode: PendingQueueMaterializationTransportDiagnosticCode;
    serverError?: string;
    retryAfterMs?: number;
}>;

const PENDING_QUEUE_MATERIALIZATION_TRANSPORT_DIAGNOSTIC_CODES = {
    server_rejected: 'pending_queue_materialization_server_rejected',
    server_retryable: 'pending_queue_materialization_server_retryable',
    socket_disconnected: 'pending_queue_materialization_socket_disconnected',
    ack_timeout: 'pending_queue_materialization_ack_timeout',
    malformed_ack: 'pending_queue_materialization_ack_malformed',
    transport_failure: 'pending_queue_materialization_transport_failure',
} as const satisfies Record<
    PendingQueueMaterializationTransportClassification,
    PendingQueueMaterializationTransportDiagnosticCode
>;

function readErrorCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
}

function classifyPendingQueueMaterializationTransportError(
    error: unknown,
): PendingQueueMaterializationTransportClassification {
    const code = readErrorCode(error);
    if (code === 'socket_ack_timeout') return 'ack_timeout';
    if (code === 'socket_not_connected') return 'socket_disconnected';
    return 'transport_failure';
}

function addPendingQueueMaterializationTransportDiagnostic(
    error: unknown,
    classification: PendingQueueMaterializationTransportClassification = classifyPendingQueueMaterializationTransportError(error),
    serverError?: string,
    retryAfterMs?: number,
): Error & PendingQueueMaterializationTransportDiagnostic {
    const target = error instanceof Error
        ? error
        : new Error('Connected pending queue materialization transport failed', { cause: error });
    Object.defineProperties(target, {
        classification: { value: classification, enumerable: true, configurable: true },
        diagnosticCode: {
            value: PENDING_QUEUE_MATERIALIZATION_TRANSPORT_DIAGNOSTIC_CODES[classification],
            enumerable: true,
            configurable: true,
        },
        ...(serverError === undefined
            ? {}
            : { serverError: { value: serverError, enumerable: true, configurable: true } }),
        ...(retryAfterMs === undefined
            ? {}
            : { retryAfterMs: { value: retryAfterMs, enumerable: true, configurable: true } }),
    });
    return target as Error & PendingQueueMaterializationTransportDiagnostic;
}

export function readPendingQueueMaterializationTransportDiagnostic(
    error: unknown,
): PendingQueueMaterializationTransportDiagnostic | null {
    if (!error || typeof error !== 'object') return null;
    const record = error as Record<string, unknown>;
    const classification = record.classification;
    if (
        (classification !== 'server_rejected'
            && classification !== 'server_retryable'
            && classification !== 'socket_disconnected'
            && classification !== 'ack_timeout'
            && classification !== 'malformed_ack'
            && classification !== 'transport_failure')
    ) return null;
    const diagnosticCode = PENDING_QUEUE_MATERIALIZATION_TRANSPORT_DIAGNOSTIC_CODES[classification];
    if (record.diagnosticCode !== diagnosticCode) return null;
    const serverError = readSafePendingMaterializeServerError(record.serverError) ?? undefined;
    const retryAfterMs = typeof record.retryAfterMs === 'number'
        && Number.isSafeInteger(record.retryAfterMs)
        && record.retryAfterMs >= 0
        ? record.retryAfterMs
        : undefined;
    return {
        classification,
        diagnosticCode,
        ...(serverError ? { serverError } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
}

export type ReleasedServerPendingQueueMaterializeResult =
    | Readonly<{
        type: 'materialized';
        didWrite: boolean;
        message: Readonly<{ id: string; seq: number; localId: string }>;
    }>
    | Readonly<{ type: 'no_pending' }>
    | Readonly<{ type: 'error'; error: string }>;

export type PendingQueueWriteBody = Readonly<(
    | { localId: string; ciphertext: string; messageRole?: SessionMessageRole; requestedAction: ReturnType<typeof normalizePendingRequestedActionV1> }
    | { localId: string; content: { t: 'plain'; v: unknown }; messageRole?: SessionMessageRole; requestedAction: ReturnType<typeof normalizePendingRequestedActionV1> }
) & Readonly<{
    deliveryMode?: 'continuation_if_no_queued_user_input';
    /** Host-derived only. Account/plugin authors never receive this value. */
    requestEqualityEvidenceV1?: SessionInputRequestEqualityEvidenceV1;
}>>;

type PendingQueueSocketMaterializeResult =
    | { ok: true; didMaterialize: true; localId: string | null; didWrite: boolean; pendingQueueState: KnownPendingQueueState | null; message: PendingQueueMaterializedMessage | null }
    | { ok: true; didMaterialize: false; pendingQueueState: KnownPendingQueueState | null; deliveryState: PendingMaterializationDeliveryState | null; localId: string | null; deferredReason?: PendingQueueMaterializeNextResult['deferredReason'] };

type PendingQueueHttpMaterializeResult =
    | { ok: true; didMaterialize: true; localId: string | null; didWrite: boolean; pendingQueueState: KnownPendingQueueState | null; message: PendingQueueMaterializedMessage | null }
    | { ok: true; didMaterialize: false; pendingQueueState: KnownPendingQueueState | null; deliveryState: PendingMaterializationDeliveryState | null; localId: string | null; deferredReason?: PendingQueueMaterializeNextResult['deferredReason'] };

type AckSocket = Parameters<typeof emitSocketWithAck>[0]['socket'];

type PendingMaterializePayload = Readonly<{
    sid: string;
    pendingVersion?: number;
    deliveryState?: 'provider';
    deliveryTiming?: PendingMaterializationDeliveryTiming;
    foregroundState?: PendingClaimForegroundState;
    expectedRuntimeActivityRevision?: number;
}>;

export type PendingQueueDeliveryBlockedReason = PendingDeliveryBlockedReason;

export type AcceptedPendingQueueV2DeliveryRetryDirective = Readonly<{
    retryAfterMs: number;
    correlationId?: string;
}>;

export class PendingQueueAcceptedSettlementError extends Error {
    readonly code = 'pending_queue_accepted_settlement_failed' as const;

    constructor(
        readonly settlementError: string,
        readonly retryAfterMs?: number,
        readonly correlationId?: string,
    ) {
        super(`Pending delivery accepted settlement failed: ${settlementError}`);
        this.name = 'PendingQueueAcceptedSettlementError';
    }
}

export function readAcceptedPendingQueueV2DeliveryRetryDirective(
    error: unknown,
): AcceptedPendingQueueV2DeliveryRetryDirective | null {
    if (
        error instanceof PendingQueueAcceptedSettlementError
        && error.settlementError === 'transaction-unavailable'
        && typeof error.retryAfterMs === 'number'
        && Number.isSafeInteger(error.retryAfterMs)
        && error.retryAfterMs >= 0
    ) {
        return {
            retryAfterMs: error.retryAfterMs,
            ...(error.correlationId ? { correlationId: error.correlationId } : {}),
        };
    }
    return null;
}

export function isAcceptedPendingQueueV2DeliveryAckResponseLoss(error: unknown): boolean {
    return Boolean(
        error
        && typeof error === 'object'
        && 'code' in error
        && (error as { code?: unknown }).code === 'socket_ack_timeout'
        && 'retryable' in error
        && (error as { retryable?: unknown }).retryable === true,
    );
}

export type PendingQueueBlockedDelivery = Readonly<{
    localId: string;
    reason: PendingQueueDeliveryBlockedReason;
}>;

function readResolvedLocalIds(value: unknown): string[] {
    if (!value || typeof value !== 'object') return [];
    const rawLocalIds = (value as Record<string, unknown>).resolvedLocalIds;
    if (!Array.isArray(rawLocalIds)) return [];
    const resolvedLocalIds: string[] = [];
    for (const rawLocalId of rawLocalIds) {
        const localId = readPendingLocalId(rawLocalId);
        if (!localId || resolvedLocalIds.includes(localId)) continue;
        resolvedLocalIds.push(localId);
    }
    return resolvedLocalIds;
}

function readPendingDeliveryStatusFromRecord(record: Record<string, unknown>) {
    return parsePendingDeliveryStatusV1(record.deliveryStatus)
        ?? normalizePendingDeliveryStatusV1({
            status: record.status,
            deliveryState: record.deliveryState,
            deliveryBlockedReason: record.deliveryBlockedReason,
            discardedReason: record.discardedReason,
        });
}

function readPendingMaterializePayload(payload: unknown): PendingMaterializePayload {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid pending queue materialize payload');
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.sid !== 'string') {
        throw new Error('Invalid pending queue materialize session id');
    }
    const pendingVersion = record.pendingVersion;
    return {
        sid: record.sid,
        ...(typeof pendingVersion === 'number' && Number.isSafeInteger(pendingVersion) && pendingVersion >= 0
            ? { pendingVersion }
            : {}),
        ...(record.deliveryState === 'provider' ? { deliveryState: 'provider' } : {}),
        ...(record.deliveryTiming === 'after_runtime_idle' || record.deliveryTiming === 'after_foreground_ready'
            ? { deliveryTiming: record.deliveryTiming }
            : {}),
        ...(record.foregroundState === 'ready' || record.foregroundState === 'active_steerable' || record.foregroundState === 'active_unsteerable'
            ? { foregroundState: record.foregroundState }
            : {}),
    };
}

function createPendingMaterializeAckSocket(socket: Socket<ServerToClientEvents, ClientToServerEvents>): AckSocket {
    const build = (target: Socket<ServerToClientEvents, ClientToServerEvents>): AckSocket => ({
        connected: target.connected,
        emitWithAck: async (event, payload) => {
            if (event !== 'pending-materialize-next') {
                throw new Error(`Unexpected pending queue socket ACK event: ${event}`);
            }
            return await target.emitWithAck('pending-materialize-next', readPendingMaterializePayload(payload));
        },
        timeout: (ms) => build(target.timeout(ms)),
    });
    return build(socket);
}

function createAcceptedPendingSettlementAckSocket(
    socket: Socket<ServerToClientEvents, ClientToServerEvents>,
): AckSocket {
    const build = (target: Socket<ServerToClientEvents, ClientToServerEvents>): AckSocket => ({
        connected: target.connected,
        emitWithAck: async (event, payload) => {
            if (event !== ACCEPTED_PENDING_SETTLEMENT_EVENT_V1) {
                throw new Error(`Unexpected accepted pending settlement socket ACK event: ${event}`);
            }
            return await target.emitWithAck(
                ACCEPTED_PENDING_SETTLEMENT_EVENT_V1,
                AcceptedPendingSettlementRequestV1Schema.parse(payload),
            );
        },
        timeout: (ms) => build(target.timeout(ms)),
    });
    return build(socket);
}

function createPendingAdmissionSettlementAckSocket(
    socket: Socket<ServerToClientEvents, ClientToServerEvents>,
): AckSocket {
    const build = (target: Socket<ServerToClientEvents, ClientToServerEvents>): AckSocket => ({
        connected: target.connected,
        emitWithAck: async (event, payload) => {
            if (event !== SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1) {
                throw new Error(`Unexpected Session input settlement socket ACK event: ${event}`);
            }
            return await target.emitWithAck(
                SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1,
                SessionPendingAdmissionSettlementRequestV1Schema.parse(payload),
            );
        },
        timeout: (ms) => build(target.timeout(ms)),
    });
    return build(socket);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(record);
    return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function readSafePendingMaterializeServerError(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const error = value.trim();
    return /^[A-Za-z0-9_.:-]{1,160}$/u.test(error) ? error : null;
}

const RELEASED_SERVER_MATERIALIZE_ERRORS = new Set([
    'invalid-params',
    'session-not-found',
    'forbidden',
    'internal',
]);

function parseReleasedServerPendingQueueMaterializeAck(rawAck: unknown): ReleasedServerPendingQueueMaterializeResult {
    if (!rawAck || typeof rawAck !== 'object' || Array.isArray(rawAck)) {
        return { type: 'error', error: 'malformed_ack' };
    }
    const ack = rawAck as Record<string, unknown>;
    if (
        hasExactKeys(ack, ['ok', 'didMaterialize'])
        && ack.ok === true
        && ack.didMaterialize === false
    ) {
        return { type: 'no_pending' };
    }
    if (
        hasExactKeys(ack, ['ok', 'error'])
        && ack.ok === false
        && typeof ack.error === 'string'
        && RELEASED_SERVER_MATERIALIZE_ERRORS.has(ack.error)
    ) {
        return { type: 'error', error: ack.error };
    }
    if (
        !hasExactKeys(ack, ['ok', 'didMaterialize', 'didWrite', 'message'])
        || ack.ok !== true
        || ack.didMaterialize !== true
        || typeof ack.didWrite !== 'boolean'
        || !ack.message
        || typeof ack.message !== 'object'
        || Array.isArray(ack.message)
    ) {
        return { type: 'error', error: 'malformed_ack' };
    }
    const message = ack.message as Record<string, unknown>;
    if (
        !hasExactKeys(message, ['id', 'seq', 'localId'])
        || readNonBlankOpaqueIdentifier(message.id) === null
        || readPendingLocalId(message.localId) === null
        || typeof message.seq !== 'number'
        || !Number.isSafeInteger(message.seq)
        || message.seq < 0
    ) {
        return { type: 'error', error: 'malformed_ack' };
    }
    return {
        type: 'materialized',
        didWrite: ack.didWrite,
        message: { id: message.id as string, seq: message.seq, localId: message.localId as string },
    };
}

export async function materializeNextPendingQueueV2MessageViaReleasedServerSocket(params: Readonly<{
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    sessionId: string;
}>): Promise<ReleasedServerPendingQueueMaterializeResult> {
    const rawAck = await emitSocketWithAck<unknown>({
        socket: params.socket as AckSocket,
        event: 'pending-materialize-next',
        payload: { sid: params.sessionId },
    });
    return parseReleasedServerPendingQueueMaterializeAck(rawAck);
}

function parseMaterializedMessageTimestamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return value;
    }
    if (typeof value === 'string' && value.length > 0) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }
    return null;
}

function parseDeliveryState(value: unknown): {
    deliveryState: PendingMaterializationDeliveryState | null;
    malformed: boolean;
} {
    if (value === null || value === undefined) {
        return { deliveryState: null, malformed: false };
    }
    if (!value || typeof value !== 'object') {
        return { deliveryState: null, malformed: true };
    }
    const record = value as Record<string, unknown>;
    if (record.mode !== 'provider' || typeof record.unresolved !== 'boolean') {
        return { deliveryState: null, malformed: true };
    }
    return {
        deliveryState: {
            mode: 'provider',
            unresolved: record.unresolved,
        },
        malformed: false,
    };
}

function parseMaterializedMessage(value: unknown): PendingQueueMaterializedMessage | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const seq = record.seq === null
        ? null
        : typeof record.seq === 'number' && Number.isSafeInteger(record.seq) && record.seq >= 0
            ? record.seq
            : undefined;
    if (seq === undefined) return null;
    const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : null;
    const localId = readPendingLocalId(record.localId);
    const parsedRole = SessionMessageRoleSchema.nullable().safeParse(record.messageRole ?? null);
    const parsedContent = SessionMessageContentSchema.safeParse(record.content);
    const parsedInputAdmissionReceipt = SessionInputAdmissionReceiptV1Schema.safeParse(
        record.inputAdmissionReceipt,
    );
    const deliveryState = parseDeliveryState(record.deliveryState);
    const parsedProviderAction = PendingProviderActionSchema.safeParse(record.providerAction);
    return {
        id,
        seq,
        localId,
        messageRole: parsedRole.success ? parsedRole.data : null,
        content: parsedContent.success ? parsedContent.data : null,
        createdAt: parseMaterializedMessageTimestamp(record.createdAt),
        updatedAt: parseMaterializedMessageTimestamp(record.updatedAt),
        requestedAction: normalizePendingRequestedActionV1(record.requestedAction),
        providerAction: parsedProviderAction.success ? parsedProviderAction.data : null,
        inputAdmissionReceipt: parsedInputAdmissionReceipt.success
            ? parsedInputAdmissionReceipt.data
            : null,
        deliveryState: deliveryState.deliveryState,
        ...(deliveryState.malformed ? { deliveryStateMalformed: true } : {}),
    };
}

function readMaterializedMessageFromAck(value: unknown): PendingQueueMaterializedMessage | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const parsedMessage = parseMaterializedMessage(record.message);
    const topLevelDeliveryState = parseDeliveryState(record.deliveryState);
    if (parsedMessage) {
        return {
            ...parsedMessage,
            deliveryState: parsedMessage.deliveryState ?? topLevelDeliveryState.deliveryState,
            ...(parsedMessage.deliveryStateMalformed || topLevelDeliveryState.malformed
                ? { deliveryStateMalformed: true }
                : {}),
        };
    }
    return parseMaterializedMessage(record);
}

function readMaterializedLocalIdFromAck(value: unknown, message: PendingQueueMaterializedMessage | null): string | null {
    if (message?.localId) return message.localId;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const localId = readPendingLocalId(record.localId);
    if (localId !== null) return localId;
    const nested = record.message;
    if (!nested || typeof nested !== 'object') return null;
    const nestedLocalId = (nested as Record<string, unknown>).localId;
    return readPendingLocalId(nestedLocalId);
}

function readPendingMaterializeDeferredReason(value: unknown): PendingQueueMaterializeNextResult['deferredReason'] {
    return value === 'waiting_for_foreground_turn'
        || value === 'waiting_for_runtime_activity'
        || value === 'runtime_activity_unknown'
        || value === 'waiting_for_predecessor'
        || value === 'steering_unavailable'
        ? value
        : undefined;
}

export class PendingProviderDeliveryMaterializationContractError extends Error {
    readonly localId: string | null;

    constructor(localId: string | null) {
        super('Invalid pending provider delivery materialize response');
        this.name = 'PendingProviderDeliveryMaterializationContractError';
        this.localId = localId;
    }
}

function readProviderClaimLocalId(message: PendingQueueMaterializedMessage | null, fallbackLocalId: string | null): string | null {
    return readPendingLocalId(message?.localId) ?? readPendingLocalId(fallbackLocalId);
}

function assertProviderDeliveryClaimMaterialization(params: {
    didWrite: boolean;
    message: PendingQueueMaterializedMessage | null;
    localId: string | null;
}): void {
    const message = params.message;
    const localId = readProviderClaimLocalId(message, params.localId);
    if (
        params.didWrite === true
        && message
        && typeof message.id === 'string'
        && message.id.length > 0
        && typeof message.seq === 'number'
        && Number.isSafeInteger(message.seq)
        && message.seq >= 0
        && localId !== null
        && message.deliveryStateMalformed !== true
        && message.deliveryState?.mode === 'provider'
        && message.deliveryState.unresolved === true
        && message.providerAction !== null
    ) {
        return;
    }
    if (
        params.didWrite === false
        && message
        && typeof message.id === 'string'
        && message.id.length > 0
        && typeof message.seq === 'number'
        && Number.isSafeInteger(message.seq)
        && message.seq >= 0
        && localId !== null
        && message.deliveryStateMalformed !== true
        && message.deliveryState?.mode === 'provider'
        && message.deliveryState.unresolved === true
        && message.providerAction !== null
    ) {
        return;
    }
    if (
        params.didWrite === false
        && message
        && message.seq === null
        && localId !== null
        && message.deliveryStateMalformed === true
        && message.providerAction !== null
    ) {
        return;
    }
    if (
        params.didWrite === false
        && message
        && message.seq === null
        && localId !== null
        && message.deliveryStateMalformed !== true
        && message.providerAction !== null
        && (
            !message.deliveryState
            || message.deliveryState.mode === 'provider'
        )
    ) {
        return;
    }
    throw new PendingProviderDeliveryMaterializationContractError(localId);
}

export async function listPendingQueueV2LocalIdsFromServer(params: {
    token: string;
    sessionId: string;
}): Promise<string[]> {
    try {
        const serverUrl = resolveServerHttpBaseUrl();
        const response = await axios.get(`${serverUrl}/v2/sessions/${params.sessionId}/pending`, {
            headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${params.token}` },
            timeout: 10_000,
        });
        const data = response?.data as { pending?: unknown } | null | undefined;
        const pending = Array.isArray(data?.pending) ? data.pending : [];
        return pending
            .map((row: unknown) => {
                if (!row || typeof row !== 'object') return null;
                const localId = (row as Record<string, unknown>).localId;
                return typeof localId === 'string' ? localId : null;
            })
            .filter((value: string | null): value is string => typeof value === 'string' && value.length > 0);
    } catch (error) {
        if (isAuthenticationError(error)) {
            throw error;
        }
        throw error;
    }
}

export type PendingQueueV2DeliveryStatusEntry = Readonly<{
    localId: string;
    status: PendingDeliveryStatusV1['status'];
}>;

/**
 * Projects the server-owned delivery status for each current pending row. A canonical local claim
 * whose id is absent from this projection has reached a terminal outcome and must be retired.
 */
export async function listPendingQueueV2DeliveryStatusesFromServer(params: {
    token: string;
    sessionId: string;
}): Promise<PendingQueueV2DeliveryStatusEntry[]> {
    const serverUrl = resolveServerHttpBaseUrl();
    const response = await axios.get(`${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending`, {
        headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${params.token}` },
        timeout: 10_000,
    });
    const data = response?.data as { pending?: unknown } | null | undefined;
    const pending = Array.isArray(data?.pending) ? data.pending : [];
    const seen = new Set<string>();
    const entries: PendingQueueV2DeliveryStatusEntry[] = [];
    for (const row of pending) {
        if (!row || typeof row !== 'object') continue;
        const record = row as Record<string, unknown>;
        const localId = readPendingLocalId(record.localId);
        if (!localId || seen.has(localId)) continue;
        seen.add(localId);
        entries.push({ localId, status: readPendingDeliveryStatusFromRecord(record).status });
    }
    return entries;
}

export async function listPendingQueueV2ProviderDeliveryLocalIdsFromServer(params: {
    token: string;
    sessionId: string;
}): Promise<string[]> {
    try {
        const serverUrl = resolveServerHttpBaseUrl();
        const response = await axios.get(`${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending`, {
            headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${params.token}` },
            timeout: 10_000,
        });
        const data = response?.data as { pending?: unknown } | null | undefined;
        const pending = Array.isArray(data?.pending) ? data.pending : [];
        const seen = new Set<string>();
        const localIds: string[] = [];
        for (const row of pending) {
            if (!row || typeof row !== 'object') continue;
            const record = row as Record<string, unknown>;
            const localId = readPendingLocalId(record.localId);
            const deliveryStatus = readPendingDeliveryStatusFromRecord(record);
            if (
                localId === null
                || seen.has(localId)
                || record.status === 'discarded'
                || deliveryStatus.status !== 'delivering'
            ) {
                continue;
            }
            seen.add(localId);
            localIds.push(localId);
        }
        return localIds;
    } catch (error) {
        if (isAuthenticationError(error)) {
            throw error;
        }
        throw error;
    }
}

export async function readBlockedPendingQueueV2DeliveryByLocalIdFromServer(params: {
    token: string;
    sessionId: string;
    localId: string;
}): Promise<PendingQueueBlockedDelivery | null> {
    try {
        const serverUrl = resolveServerHttpBaseUrl();
        const response = await axios.get(`${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending`, {
            headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${params.token}` },
            timeout: 10_000,
        });
        const data = response?.data as { pending?: unknown } | null | undefined;
        const pending = Array.isArray(data?.pending) ? data.pending : [];
        for (const row of pending) {
            if (!row || typeof row !== 'object') continue;
            const record = row as Record<string, unknown>;
            const localId = record.localId;
            const deliveryStatus = readPendingDeliveryStatusFromRecord(record);
            if (
                localId !== params.localId
                || record.status === 'discarded'
                || deliveryStatus.status !== 'blocked'
            ) {
                continue;
            }
            const reason = deliveryStatus.reason ?? normalizePendingDeliveryBlockedReason(record.deliveryBlockedReason);
            return reason ? { localId: params.localId, reason } : null;
        }
        return null;
    } catch (error) {
        if (isAuthenticationError(error)) {
            throw error;
        }
        throw error;
    }
}

export async function discardPendingQueueV2Messages(params: {
    token: string;
    sessionId: string;
    localIds: string[];
    reason: 'switch_to_local' | 'manual' | 'session_input_cancelled';
}): Promise<number> {
    let discarded = 0;
    const serverUrl = resolveServerHttpBaseUrl();
    for (const localId of params.localIds) {
        try {
            await axios.post(
                `${serverUrl}/v2/sessions/${params.sessionId}/pending/${encodeURIComponent(localId)}/discard`,
                { reason: params.reason },
                { headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${params.token}` }, timeout: 10_000 },
            );
            discarded += 1;
        } catch (error) {
            if (isAuthenticationError(error)) {
                throw error;
            }
            throw error;
        }
    }
    return discarded;
}

export async function enqueuePendingQueueV2MessageViaHttp(params: {
    token: string;
    sessionId: string;
    body: PendingQueueWriteBody;
    signal?: AbortSignal;
}): Promise<Readonly<{ didWrite: boolean | null; terminal: boolean; suppressed: boolean }>> {
    const serverUrl = resolveServerHttpBaseUrl();
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending`,
        params.body,
        {
            headers: {
                ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                Authorization: `Bearer ${params.token}`,
                'Content-Type': 'application/json',
            },
            timeout: 10_000,
            ...(params.signal ? { signal: params.signal } : {}),
        },
    );
    const data = response?.data;
    return {
        didWrite: data && typeof data === 'object' && typeof (data as { didWrite?: unknown }).didWrite === 'boolean'
            ? (data as { didWrite: boolean }).didWrite
            : null,
        terminal: data && typeof data === 'object' && (data as { terminal?: unknown }).terminal === true,
        suppressed: data && typeof data === 'object' && (data as { suppressed?: unknown }).suppressed === true,
    };
}

export async function resolveAcceptedPendingQueueV2Delivery(params: {
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    sessionId: string;
    localId: string;
}): Promise<{ didResolve: boolean; pendingQueueState?: KnownPendingQueueState; message?: PendingQueueMaterializedMessage | null }> {
    const localId = readPendingLocalId(params.localId);
    if (localId === null) throw new Error('Invalid pending delivery accepted local id');
    const raw = await emitSocketWithAck<Record<string, unknown>>({
        socket: createAcceptedPendingSettlementAckSocket(params.socket),
        event: ACCEPTED_PENDING_SETTLEMENT_EVENT_V1,
        payload: { v: 1, sessionId: params.sessionId, localId },
    });
    const parsed = AcceptedPendingSettlementResponseV1Schema.safeParse(raw);
    if (!parsed.success) throw new Error('Invalid pending delivery accepted settlement acknowledgement');
    const result = parsed.data;
    if (!result.ok) {
        throw new PendingQueueAcceptedSettlementError(
            result.error,
            result.error === 'transaction-unavailable' ? result.retryAfterMs : undefined,
            result.error === 'transaction-unavailable' ? result.correlationId : undefined,
        );
    }
    const pendingQueueState = readKnownPendingQueueState(result);
    const message = 'message' in result ? readMaterializedMessageFromAck(result) : null;
    if ((result.didResolve || 'message' in result) && message?.localId !== localId) {
        throw new Error('Invalid pending delivery accepted settlement acknowledgement');
    }
    return {
        didResolve: result.didResolve === true,
        ...(pendingQueueState ? { pendingQueueState } : {}),
        ...('message' in result ? { message } : { message: null }),
    };
}

export async function settlePendingQueueV2Admission(params: Readonly<{
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    sessionId: string;
    localId: string;
    decision: SessionPendingAdmissionSettlementRequestV1['decision'];
}>): Promise<import('@happier-dev/protocol').SessionInputAdmissionResultV1> {
    const request = SessionPendingAdmissionSettlementRequestV1Schema.parse({
        v: 1,
        sessionId: params.sessionId,
        localId: params.localId,
        decision: params.decision,
    });
    const raw = await emitSocketWithAck<Record<string, unknown>>({
        socket: createPendingAdmissionSettlementAckSocket(params.socket),
        event: SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1,
        payload: request,
    });
    return SessionPendingAdmissionSettlementResponseV1Schema.parse(raw).result;
}

export async function blockPendingQueueV2Delivery(params: {
    token: string;
    sessionId: string;
    localId: string;
    reason: PendingQueueDeliveryBlockedReason;
}): Promise<{ pendingQueueState?: KnownPendingQueueState }> {
    return postPendingQueueV2DeliveryAction({
        ...params,
        action: 'block',
        body: { reason: params.reason },
    });
}

export async function markPendingQueueV2DeliveryHandled(params: {
    token: string;
    sessionId: string;
    localId: string;
}): Promise<{ pendingQueueState?: KnownPendingQueueState }> {
    return postPendingQueueV2DeliveryAction({
        ...params,
        action: 'handled',
        body: {},
    });
}

async function postPendingQueueV2DeliveryAction(params: {
    token: string;
    sessionId: string;
    localId: string;
    action: 'block' | 'handled';
    body: Record<string, unknown>;
}): Promise<{ pendingQueueState?: KnownPendingQueueState }> {
    const serverUrl = resolveServerHttpBaseUrl();
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending/${encodeURIComponent(params.localId)}/delivery/${params.action}`,
        params.body,
        {
            headers: {
                ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                Authorization: `Bearer ${params.token}`,
                'Content-Type': 'application/json',
            },
            timeout: 10_000,
        },
    );
    const data = response?.data;
    if (!data || typeof data !== 'object') {
        throw new Error(`Invalid pending delivery ${params.action} response`);
    }
    if ((data as Record<string, unknown>).ok !== true) {
        const error = (data as Record<string, unknown>).error;
        throw new Error(`Pending delivery ${params.action} failed: ${typeof error === 'string' ? error : 'unknown'}`);
    }
    const pendingQueueState = readKnownPendingQueueState(data);
    return {
        ...(pendingQueueState ? { pendingQueueState } : {}),
    };
}

async function tryMaterializeNextViaSocket(params: {
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    sessionId: string;
    knownPendingVersion?: number;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: PendingMaterializationDeliveryTiming;
    foregroundState?: PendingClaimForegroundState;
    expectedRuntimeActivityRevision?: number;
}): Promise<PendingQueueSocketMaterializeResult> {
    try {
        const rawAck = await emitSocketWithAck<Record<string, unknown>>({
            socket: createPendingMaterializeAckSocket(params.socket),
            event: 'pending-materialize-next',
            payload: {
                sid: params.sessionId,
                ...(typeof params.knownPendingVersion === 'number' ? { pendingVersion: params.knownPendingVersion } : {}),
                ...(params.deliveryStateOptIn === true ? { deliveryState: 'provider' } : {}),
                ...(params.deliveryTiming ? { deliveryTiming: params.deliveryTiming } : {}),
                ...(params.foregroundState ? { foregroundState: params.foregroundState } : {}),
                ...(typeof params.expectedRuntimeActivityRevision === 'number'
                    ? { expectedRuntimeActivityRevision: params.expectedRuntimeActivityRevision }
                    : {}),
            },
        });
        if (!rawAck || typeof rawAck !== 'object') {
            throw addPendingQueueMaterializationTransportDiagnostic(
                new Error('Invalid pending queue socket materialize response'),
                'malformed_ack',
            );
        }
        if (rawAck.ok === false) {
            const serverError = readSafePendingMaterializeServerError(rawAck.error);
            if (serverError) {
                const retryAfterMs = serverError === 'transaction-unavailable'
                    && typeof rawAck.retryAfterMs === 'number'
                    && Number.isSafeInteger(rawAck.retryAfterMs)
                    && rawAck.retryAfterMs >= 0
                    ? rawAck.retryAfterMs
                    : undefined;
                throw addPendingQueueMaterializationTransportDiagnostic(
                    new Error(`Pending queue socket materialize failed: ${serverError}`),
                    retryAfterMs === undefined ? 'server_rejected' : 'server_retryable',
                    serverError,
                    retryAfterMs,
                );
            }
        }
        if (rawAck.ok !== true) {
            throw addPendingQueueMaterializationTransportDiagnostic(
                new Error('Pending queue socket materialize failed: unknown'),
                'malformed_ack',
            );
        }
        const pendingQueueState = readKnownPendingQueueState(rawAck);
        if (rawAck.didMaterialize !== true) {
            const deferredReason = readPendingMaterializeDeferredReason(rawAck.deferredReason);
            return {
                ok: true,
                didMaterialize: false,
                pendingQueueState,
                deliveryState: parseDeliveryState(rawAck.deliveryState).deliveryState,
                localId: deferredReason ? readPendingLocalId(rawAck.localId) : null,
                ...(deferredReason ? { deferredReason } : {}),
            };
        }
        const parsedMessage = readMaterializedMessageFromAck(rawAck);
        const localId = readMaterializedLocalIdFromAck(rawAck, parsedMessage);
        const didWrite = rawAck.didWrite === true;
        if (params.deliveryStateOptIn === true) {
            assertProviderDeliveryClaimMaterialization({ didWrite, message: parsedMessage, localId });
        }
        return { ok: true, didMaterialize: true, localId, didWrite, pendingQueueState, message: parsedMessage };
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        throw readPendingQueueMaterializationTransportDiagnostic(error)
            ? error
            : addPendingQueueMaterializationTransportDiagnostic(error);
    }
}

async function tryMaterializeNextViaHttp(params: {
    token: string;
    sessionId: string;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: PendingMaterializationDeliveryTiming;
    foregroundState?: PendingClaimForegroundState;
    expectedRuntimeActivityRevision?: number;
}): Promise<PendingQueueHttpMaterializeResult> {
    const serverUrl = resolveServerHttpBaseUrl();
    const body = {
        ...(params.deliveryStateOptIn === true ? { deliveryState: 'provider' } : {}),
        ...(params.deliveryTiming ? { deliveryTiming: params.deliveryTiming } : {}),
        ...(params.foregroundState ? { foregroundState: params.foregroundState } : {}),
    };
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending/materialize-next`,
        body,
        {
            headers: {
                ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                Authorization: `Bearer ${params.token}`,
                'Content-Type': 'application/json',
            },
            timeout: 10_000,
        },
    );
    const data = response?.data;
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid pending queue materialize response');
    }
    if (data.ok !== true) {
        throw new Error(`Pending queue materialize failed: ${typeof data.error === 'string' ? data.error : 'unknown'}`);
    }
    const pendingQueueState = readKnownPendingQueueState(data);
    if (data.didMaterialize !== true) {
        const deferredReason = readPendingMaterializeDeferredReason(data.deferredReason);
        return {
            ok: true,
            didMaterialize: false,
            pendingQueueState,
            deliveryState: parseDeliveryState(data.deliveryState).deliveryState,
            localId: deferredReason ? readPendingLocalId(data.localId) : null,
            ...(deferredReason ? { deferredReason } : {}),
        };
    }
    const message = readMaterializedMessageFromAck(data);
    const localId = readMaterializedLocalIdFromAck(data, message);
    const didWrite = data.didWrite === true || data.didWriteMessage === true;
    if (params.deliveryStateOptIn === true) {
        assertProviderDeliveryClaimMaterialization({ didWrite, message, localId });
    }
    return { ok: true, didMaterialize: true, localId, didWrite, pendingQueueState, message };
}

export async function materializeNextPendingQueueV2MessageViaHttp(params: {
    token: string;
    sessionId: string;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: PendingMaterializationDeliveryTiming;
    foregroundState?: PendingClaimForegroundState;
}): Promise<PendingQueueMaterializeNextResult> {
    const res = await tryMaterializeNextViaHttp({
        ...params,
        deliveryStateOptIn: params.deliveryStateOptIn === true,
    });
    if (!res.didMaterialize) {
        return {
            didMaterialize: false,
            localId: null,
            didWrite: false,
            pendingQueueState: res.pendingQueueState,
            message: null,
            deliveryState: res.deliveryState,
            ...(res.deferredReason ? { deferredReason: res.deferredReason } : {}),
            ...(res.localId ? { localId: res.localId } : {}),
        };
    }
    return {
        didMaterialize: true,
        localId: res.localId,
        didWrite: res.didWrite,
        pendingQueueState: res.pendingQueueState,
        message: res.message,
    };
}

export async function materializeNextPendingQueueV2Message(params: {
    token: string;
    sessionId: string;
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    knownPendingVersion?: number;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: PendingMaterializationDeliveryTiming;
    foregroundState?: PendingClaimForegroundState;
    expectedRuntimeActivityRevision?: number;
}): Promise<PendingQueueMaterializeNextResult> {
    const requiresBoundSessionSocket = Boolean(params.deliveryStateOptIn);
    const socketRes = params.socket.connected
        ? await tryMaterializeNextViaSocket({
            socket: params.socket,
            sessionId: params.sessionId,
            knownPendingVersion: params.knownPendingVersion,
            deliveryStateOptIn: params.deliveryStateOptIn === true,
            deliveryTiming: params.deliveryTiming,
            foregroundState: params.foregroundState,
            expectedRuntimeActivityRevision: params.expectedRuntimeActivityRevision,
        })
        : null;
    let res: PendingQueueSocketMaterializeResult | PendingQueueHttpMaterializeResult;
    if (socketRes) {
        res = socketRes;
    } else if (requiresBoundSessionSocket) {
        throw addPendingQueueMaterializationTransportDiagnostic(
            new Error('Provider pending materialization requires the bound session socket'),
            'socket_disconnected',
        );
    } else {
        res = await tryMaterializeNextViaHttp({
            token: params.token,
            sessionId: params.sessionId,
            deliveryStateOptIn: params.deliveryStateOptIn === true,
            deliveryTiming: params.deliveryTiming,
            foregroundState: params.foregroundState,
        });
    }
    if (!res.didMaterialize) {
        return {
            didMaterialize: false,
            localId: null,
            didWrite: false,
            pendingQueueState: res.pendingQueueState,
            message: null,
            deliveryState: res.deliveryState,
            ...(res.deferredReason ? { deferredReason: res.deferredReason } : {}),
            ...(res.localId ? { localId: res.localId } : {}),
        };
    }
    return {
        didMaterialize: true,
        localId: res.localId,
        didWrite: res.didWrite,
        pendingQueueState: res.pendingQueueState,
        message: res.message,
    };
}

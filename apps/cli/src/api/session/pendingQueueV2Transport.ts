import axios from 'axios';
import type { Socket } from 'socket.io-client';

import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import type { ClientToServerEvents, ServerToClientEvents } from '../types';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import {
    ACCEPTED_PENDING_SETTLEMENT_EVENT_V1,
    AcceptedPendingSettlementRequestV1Schema,
    AcceptedPendingSettlementResponseV1Schema,
    normalizePendingDeliveryStatusV1,
    parsePendingDeliveryStatusV1,
    PendingProviderActionSchema,
    SessionMessageRoleSchema,
    type PendingDeliveryBlockedReason,
    type PendingDeliveryStatusV1,
    PendingRequestedActionV1Schema,
    readPendingLocalId,
    type PendingProviderAction,
    type PendingRequestedActionV1,
    type SessionPendingQueueDeliveryTiming,
    type SessionMessageRole,
} from '@happier-dev/protocol';
import { SessionMessageContentSchema, type SessionMessageContent } from '../types';
import { readKnownPendingQueueState, type KnownPendingQueueState } from './pendingQueueState';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';

export type PendingMaterializationDeliveryState = Readonly<{
    mode: 'provider';
    unresolved: boolean;
}>;

export type PendingQueueMaterializedMessage = {
    id: string | null;
    seq: number | null;
    localId: string | null;
    messageRole: SessionMessageRole | null;
    content: SessionMessageContent | null;
    createdAt: number | null;
    updatedAt: number | null;
    deliveryState?: PendingMaterializationDeliveryState | null;
    deliveryStateMalformed?: boolean;
    requestedAction?: PendingRequestedActionV1;
    providerAction?: PendingProviderAction;
};

export type PendingQueueMaterializeNextResult = {
    didMaterialize: boolean;
    localId: string | null;
    didWrite: boolean;
    message?: PendingQueueMaterializedMessage | null;
    pendingQueueState?: KnownPendingQueueState;
    deferredReason?: PendingQueueMaterializeDeferredReason;
    retryAfterMs?: number;
    runtimeActivityNotice?: Readonly<{ id: string; message: string }>;
    deliveryState?: PendingMaterializationDeliveryState | null;
    providerDeliveryContractInvalid?: boolean;
};

export type PendingQueueMaterializeDeferredReason =
    | 'waiting_for_runtime_activity'
    | 'runtime_activity_unknown'
    | 'pending_version_mismatch'
    | 'waiting_for_predecessor'
    | 'waiting_for_foreground_turn';

export type PendingQueueMaterializationTransportClassification =
    | 'server_rejected'
    | 'server_retryable'
    | 'socket_disconnected'
    | 'ack_timeout'
    | 'malformed_ack'
    | 'transport_failure';

export type PendingQueueMaterializationTransportErrorCode =
    | 'pending_queue_materialization_server_rejected'
    | 'pending_queue_materialization_server_retryable'
    | 'pending_queue_materialization_socket_disconnected'
    | 'pending_queue_materialization_ack_timeout'
    | 'pending_queue_materialization_ack_malformed'
    | 'pending_queue_materialization_transport_failure';

const PENDING_QUEUE_MATERIALIZATION_TRANSPORT_ERROR_CODES = {
    server_rejected: 'pending_queue_materialization_server_rejected',
    server_retryable: 'pending_queue_materialization_server_retryable',
    socket_disconnected: 'pending_queue_materialization_socket_disconnected',
    ack_timeout: 'pending_queue_materialization_ack_timeout',
    malformed_ack: 'pending_queue_materialization_ack_malformed',
    transport_failure: 'pending_queue_materialization_transport_failure',
} as const satisfies Record<
    PendingQueueMaterializationTransportClassification,
    PendingQueueMaterializationTransportErrorCode
>;

function readSafePendingQueueMaterializationDiagnosticValue(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const diagnosticValue = value.trim();
    return /^[A-Za-z0-9_.:-]{1,160}$/u.test(diagnosticValue) ? diagnosticValue : undefined;
}

function readErrorCode(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const code = (value as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
}

function classifyPendingQueueMaterializationTransportCause(
    cause: unknown,
): PendingQueueMaterializationTransportClassification {
    const code = readErrorCode(cause);
    if (code === 'socket_ack_timeout') return 'ack_timeout';
    if (code === 'socket_not_connected') return 'socket_disconnected';
    return 'transport_failure';
}

export class PendingQueueMaterializationTransportAmbiguousError extends Error {
    readonly code = 'pending_queue_materialization_transport_ambiguous' as const;
    readonly diagnosticCode: PendingQueueMaterializationTransportErrorCode;
    readonly classification: PendingQueueMaterializationTransportClassification;
    readonly serverError?: string;
    readonly retryAfterMs?: number;

    constructor(
        cause: unknown,
        classification: PendingQueueMaterializationTransportClassification = classifyPendingQueueMaterializationTransportCause(cause),
        serverError?: string,
        retryAfterMs?: number,
    ) {
        super('Connected pending queue materialization did not return a valid acknowledgement');
        this.name = 'PendingQueueMaterializationTransportAmbiguousError';
        this.diagnosticCode = PENDING_QUEUE_MATERIALIZATION_TRANSPORT_ERROR_CODES[classification];
        this.classification = classification;
        const safeServerError = readSafePendingQueueMaterializationDiagnosticValue(serverError);
        if (safeServerError !== undefined) this.serverError = safeServerError;
        if (typeof retryAfterMs === 'number' && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0) {
            this.retryAfterMs = retryAfterMs;
        }
        (this as Error & { cause?: unknown }).cause = cause;
    }
}

type PendingQueueWriteBody = Readonly<(
    | { localId: string; ciphertext: string; messageRole?: SessionMessageRole; requestedAction: PendingRequestedActionV1 }
    | { localId: string; content: { t: 'plain'; v: unknown }; messageRole?: SessionMessageRole; requestedAction: PendingRequestedActionV1 }
) & Readonly<{
    deliveryMode?: 'continuation_if_no_queued_user_input';
}>>;

type PendingQueueSocketMaterializeResult =
    | { ok: true; didMaterialize: true; localId: string | null; didWrite: boolean; message: PendingQueueMaterializedMessage | null; providerDeliveryContractInvalid?: boolean; pendingQueueState?: KnownPendingQueueState; runtimeActivityNotice?: Readonly<{ id: string; message: string }> }
    | { ok: true; didMaterialize: false; pendingQueueState?: KnownPendingQueueState; deferredReason?: PendingQueueMaterializeDeferredReason; retryAfterMs?: number; deliveryState?: PendingMaterializationDeliveryState | null }
    | { ok: false; error: unknown };

type PendingQueueHttpMaterializeResult =
    | { ok: true; didMaterialize: true; localId: string | null; didWrite: boolean; message: PendingQueueMaterializedMessage | null; providerDeliveryContractInvalid?: boolean; pendingQueueState?: KnownPendingQueueState; runtimeActivityNotice?: Readonly<{ id: string; message: string }> }
    | { ok: true; didMaterialize: false; pendingQueueState?: KnownPendingQueueState; deferredReason?: PendingQueueMaterializeDeferredReason; retryAfterMs?: number; deliveryState?: PendingMaterializationDeliveryState | null };

type PendingMaterializeAckSocket = Parameters<typeof emitSocketWithAck>[0]['socket'];

export type ReleasedServerV021MaterializeAck =
    | Readonly<{ ok: true; didMaterialize: false }>
    | Readonly<{
        ok: true;
        didMaterialize: true;
        didWrite: boolean;
        message: Readonly<{ id: string; seq: number; localId: string }>;
    }>
    | Readonly<{
        ok: false;
        error: 'invalid-params' | 'session-not-found' | 'forbidden' | 'internal';
    }>;

type PendingMaterializePayload = Readonly<{
    sid: string;
    pendingVersion?: number;
    expectedPendingVersion?: number;
    expectedRuntimeActivityRevision?: number;
    deliveryState?: 'provider';
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
    foregroundState?: 'ready' | 'active_steerable' | 'active_unsteerable';
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

export function isAcceptedPendingQueueV2DeliveryNotFound(error: unknown): boolean {
    return error instanceof PendingQueueAcceptedSettlementError && error.settlementError === 'not-found';
}

export type PendingQueueBlockedDelivery = Readonly<{
    localId: string;
    reason: PendingQueueDeliveryBlockedReason;
}>;

function buildSessionRunnerHttpHeaders(token: string, contentType?: 'application/json') {
    return {
        Authorization: `Bearer ${token}`,
        ...(contentType ? { 'Content-Type': contentType } : {}),
    };
}

/**
 * Reads the accepted-settlement overload contract without turning ordinary endpoint failures into
 * retry cadence. The typed response delay is authoritative; Retry-After is a compatibility fallback.
 */
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
    if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
    const response = (error as { response?: unknown }).response;
    if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
    const responseRecord = response as Record<string, unknown>;
    if (responseRecord.status !== 503) return null;
    const data = responseRecord.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const dataRecord = data as Record<string, unknown>;
    if (dataRecord.error !== 'transaction-unavailable') return null;

    const typedRetryAfterMs = dataRecord.retryAfterMs;
    const retryAfterMs = typeof typedRetryAfterMs === 'number'
        && Number.isSafeInteger(typedRetryAfterMs)
        && typedRetryAfterMs >= 0
        ? typedRetryAfterMs
        : classifyServerEndpointError(error).retryAfterMs;
    if (retryAfterMs === undefined) return null;

    const correlationId = typeof dataRecord.correlationId === 'string'
        && /^[A-Za-z0-9_.:-]{1,160}$/u.test(dataRecord.correlationId)
        ? dataRecord.correlationId
        : undefined;
    return {
        retryAfterMs,
        ...(correlationId ? { correlationId } : {}),
    };
}

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

function readPendingMaterializePayload(payload: unknown): PendingMaterializePayload {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Invalid pending queue materialize payload');
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.sid !== 'string') {
        throw new Error('Invalid pending queue materialize session id');
    }
    const pendingVersion = record.pendingVersion;
    const expectedPendingVersion = record.expectedPendingVersion;
    const expectedRuntimeActivityRevision = record.expectedRuntimeActivityRevision;
    return {
        sid: record.sid,
        ...(typeof pendingVersion === 'number' && Number.isSafeInteger(pendingVersion) && pendingVersion >= 0
            ? { pendingVersion }
            : {}),
        ...(typeof expectedPendingVersion === 'number'
            && Number.isSafeInteger(expectedPendingVersion)
            && expectedPendingVersion >= 0
            ? { expectedPendingVersion }
            : {}),
        ...(typeof expectedRuntimeActivityRevision === 'number'
            && Number.isSafeInteger(expectedRuntimeActivityRevision)
            && expectedRuntimeActivityRevision >= 0
            ? { expectedRuntimeActivityRevision }
            : {}),
        ...(record.deliveryState === 'provider' ? { deliveryState: 'provider' } : {}),
        ...(record.deliveryTiming === 'after_foreground_ready' || record.deliveryTiming === 'after_runtime_idle'
            ? { deliveryTiming: record.deliveryTiming }
            : {}),
        ...(record.foregroundState === 'ready' || record.foregroundState === 'active_steerable' || record.foregroundState === 'active_unsteerable'
            ? { foregroundState: record.foregroundState }
            : {}),
    };
}

function readPendingMaterializeDeferredReason(value: unknown): PendingQueueMaterializeDeferredReason | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const reason = (value as { deferredReason?: unknown }).deferredReason;
    return reason === 'waiting_for_runtime_activity'
        || reason === 'runtime_activity_unknown'
        || reason === 'pending_version_mismatch'
        || reason === 'waiting_for_predecessor'
        || reason === 'waiting_for_foreground_turn'
        ? reason
        : undefined;
}

function readPendingMaterializeRetryAfterMs(value: unknown): number | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const retryAfterMs = (value as { retryAfterMs?: unknown }).retryAfterMs;
    return typeof retryAfterMs === 'number' && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0
        ? retryAfterMs
        : undefined;
}

function readRuntimeActivityNotice(value: unknown): Readonly<{ id: string; message: string }> | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const notice = (value as { runtimeActivityNotice?: unknown }).runtimeActivityNotice;
    if (!notice || typeof notice !== 'object') return undefined;
    const { id, message } = notice as { id?: unknown; message?: unknown };
    return typeof id === 'string' && id.length > 0 && typeof message === 'string' && message.length > 0
        ? { id, message }
        : undefined;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(record).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function readSafePendingMaterializeServerError(value: unknown): string | null {
    return readSafePendingQueueMaterializationDiagnosticValue(value) ?? null;
}

function requirePendingLocalId(value: unknown): string {
    const localId = readPendingLocalId(value);
    if (localId === null) {
        throw new Error('Pending localId must not be blank');
    }
    return localId;
}

function parseReleasedServerV021MaterializeAck(value: unknown): ReleasedServerV021MaterializeAck | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.ok === false) {
        if (!hasExactKeys(record, ['ok', 'error'])) return null;
        const error = record.error;
        return error === 'invalid-params'
            || error === 'session-not-found'
            || error === 'forbidden'
            || error === 'internal'
            ? { ok: false, error }
            : null;
    }
    if (record.ok !== true || typeof record.didMaterialize !== 'boolean') return null;
    if (record.didMaterialize === false) {
        return hasExactKeys(record, ['ok', 'didMaterialize'])
            ? { ok: true, didMaterialize: false }
            : null;
    }
    if (!hasExactKeys(record, ['ok', 'didMaterialize', 'didWrite', 'message'])) return null;
    if (typeof record.didWrite !== 'boolean') return null;
    if (!record.message || typeof record.message !== 'object' || Array.isArray(record.message)) return null;
    const message = record.message as Record<string, unknown>;
    if (!hasExactKeys(message, ['id', 'seq', 'localId'])) return null;
    const id = readNonBlankOpaqueIdentifier(message.id);
    const localId = readPendingLocalId(message.localId);
    const seq = message.seq;
    if (!id || !localId || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null;
    return {
        ok: true,
        didMaterialize: true,
        didWrite: record.didWrite,
        message: { id, seq, localId },
    };
}

function arePendingDeliveryStatusesEqual(
    left: PendingDeliveryStatusV1,
    right: PendingDeliveryStatusV1,
): boolean {
    if (left.status !== right.status) return false;
    if (left.status === 'blocked' && right.status === 'blocked') return left.reason === right.reason;
    if (left.status === 'discarded' && right.status === 'discarded') return left.reason === right.reason;
    return true;
}

function parseLegacyPendingRowDeliveryStatus(record: Record<string, unknown>): PendingDeliveryStatusV1 | null {
    if (record.status !== 'queued' && record.status !== 'discarded') return null;
    if (record.status === 'discarded') {
        if (record.deliveryState !== undefined && record.deliveryState !== null) return null;
        if (record.deliveryBlockedReason !== undefined && record.deliveryBlockedReason !== null) return null;
        if (
            record.discardedReason !== undefined
            && record.discardedReason !== null
            && typeof record.discardedReason !== 'string'
        ) return null;
        return normalizePendingDeliveryStatusV1({
            status: record.status,
            deliveryState: record.deliveryState,
            deliveryBlockedReason: record.deliveryBlockedReason,
            discardedReason: record.discardedReason,
        });
    }

    if (
        record.deliveryState !== undefined
        && record.deliveryState !== null
        && record.deliveryState !== 'delivering'
        && record.deliveryState !== 'blocked'
    ) return null;
    if (
        record.deliveryState !== 'blocked'
        && record.deliveryBlockedReason !== undefined
        && record.deliveryBlockedReason !== null
    ) return null;
    if (record.discardedReason !== undefined && record.discardedReason !== null) return null;
    return normalizePendingDeliveryStatusV1({
        status: record.status,
        deliveryState: record.deliveryState,
        deliveryBlockedReason: record.deliveryBlockedReason,
        discardedReason: record.discardedReason,
    });
}

function readPendingRowDeliveryStatus(record: Record<string, unknown>): PendingDeliveryStatusV1 | null {
    const hasTypedStatus = hasOwn(record, 'deliveryStatus');
    const hasLegacyStatus = hasOwn(record, 'status')
        || hasOwn(record, 'deliveryState')
        || hasOwn(record, 'deliveryBlockedReason')
        || hasOwn(record, 'discardedReason');
    if (!hasTypedStatus && !hasLegacyStatus) return null;

    const typedStatus = hasTypedStatus ? parsePendingDeliveryStatusV1(record.deliveryStatus) : null;
    if (hasTypedStatus && typedStatus === null) return null;
    const legacyStatus = hasLegacyStatus ? parseLegacyPendingRowDeliveryStatus(record) : null;
    if (hasLegacyStatus && legacyStatus === null) return null;
    if (typedStatus && legacyStatus && !arePendingDeliveryStatusesEqual(typedStatus, legacyStatus)) return null;
    return typedStatus ?? legacyStatus;
}

type PendingQueueV2ProjectionEntry = Readonly<{
    localId: string;
    deliveryStatus: PendingDeliveryStatusV1;
}>;

function parsePendingQueueV2Projection(value: unknown): PendingQueueV2ProjectionEntry[] {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    if (!record || !Array.isArray(record.pending)) {
        throw new Error('Invalid pending queue delivery status projection');
    }

    const seenLocalIds = new Set<string>();
    const entries: PendingQueueV2ProjectionEntry[] = [];
    for (const row of record.pending) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new Error('Invalid pending queue delivery status projection');
        }
        const pendingRecord = row as Record<string, unknown>;
        const localId = readPendingLocalId(pendingRecord.localId);
        const deliveryStatus = readPendingRowDeliveryStatus(pendingRecord);
        if (
            localId === null
            || seenLocalIds.has(localId)
            || deliveryStatus === null
        ) {
            throw new Error('Invalid pending queue delivery status projection');
        }
        seenLocalIds.add(localId);
        entries.push({ localId, deliveryStatus });
    }
    return entries;
}

async function fetchPendingQueueV2Projection(params: {
    token: string;
    sessionId: string;
}): Promise<PendingQueueV2ProjectionEntry[]> {
    const serverUrl = resolveServerHttpBaseUrl();
    const response = await axios.get(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending`,
        {
            headers: buildSessionRunnerHttpHeaders(params.token),
            timeout: 10_000,
        },
    );
    return parsePendingQueueV2Projection(response?.data);
}

function buildPendingMaterializeBody(params: {
    expectedPendingVersion?: number;
    expectedRuntimeActivityRevision?: number;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
    foregroundState?: 'ready' | 'active_steerable' | 'active_unsteerable';
}): Record<string, unknown> {
    return {
        ...(typeof params.expectedPendingVersion === 'number'
            ? { expectedPendingVersion: params.expectedPendingVersion }
            : {}),
        ...(typeof params.expectedRuntimeActivityRevision === 'number'
            ? { expectedRuntimeActivityRevision: params.expectedRuntimeActivityRevision }
            : {}),
        ...(params.deliveryStateOptIn === true ? { deliveryState: 'provider' } : {}),
        ...(params.deliveryTiming === 'after_foreground_ready' || params.deliveryTiming === 'after_runtime_idle'
            ? { deliveryTiming: params.deliveryTiming }
            : {}),
        ...(params.foregroundState ? { foregroundState: params.foregroundState } : {}),
    };
}

function createPendingMaterializeAckSocket(socket: Socket<ServerToClientEvents, ClientToServerEvents>): PendingMaterializeAckSocket {
    const build = (target: Socket<ServerToClientEvents, ClientToServerEvents>): PendingMaterializeAckSocket => ({
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
): PendingMaterializeAckSocket {
    const build = (target: Socket<ServerToClientEvents, ClientToServerEvents>): PendingMaterializeAckSocket => ({
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
    const id = typeof record.id === 'string' && record.id.length > 0
        ? record.id
        : null;
    const seq = typeof record.seq === 'number' && Number.isSafeInteger(record.seq) && record.seq >= 0
        ? record.seq
        : record.seq === null
            ? null
            : null;
    const localId = readPendingLocalId(record.localId);
    const parsedRole = SessionMessageRoleSchema.nullable().safeParse(record.messageRole ?? null);
    const parsedContent = SessionMessageContentSchema.safeParse(record.content);
    const parsedRequestedAction = PendingRequestedActionV1Schema.safeParse(record.requestedAction);
    const parsedProviderAction = PendingProviderActionSchema.safeParse(record.providerAction);
    const deliveryState = parseDeliveryState(record.deliveryState);
    return {
        id,
        seq,
        localId,
        messageRole: parsedRole.success ? parsedRole.data : null,
        content: parsedContent.success ? parsedContent.data : null,
        createdAt: parseMaterializedMessageTimestamp(record.createdAt),
        updatedAt: parseMaterializedMessageTimestamp(record.updatedAt),
        ...(parsedRequestedAction.success ? { requestedAction: parsedRequestedAction.data } : {}),
        ...(parsedProviderAction.success ? { providerAction: parsedProviderAction.data } : {}),
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
    const materializedLocalId = readPendingLocalId(message?.localId);
    if (materializedLocalId !== null) return materializedLocalId;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const topLevelLocalId = readPendingLocalId(record.localId);
    if (topLevelLocalId !== null) return topLevelLocalId;
    const nested = record.message;
    if (!nested || typeof nested !== 'object') return null;
    const nestedLocalId = (nested as Record<string, unknown>).localId;
    return readPendingLocalId(nestedLocalId);
}

function readRawMaterializedMessageRecordFromAck(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const nested = record.message;
    if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
    return record;
}

function isProviderDeliveryMaterializationValid(params: {
    didWrite: boolean;
    didWriteExplicitFalse: boolean;
    message: PendingQueueMaterializedMessage | null;
    localId: string | null;
    rawMessageRecord: Record<string, unknown> | null;
}): boolean {
    const message = params.message;
    const localId = readPendingLocalId(message?.localId) ?? readPendingLocalId(params.localId);
    const rawMessageId = params.rawMessageRecord?.id;
    const hasValidEnvelope =
        !!message
        && params.rawMessageRecord !== null
        && localId !== null
        && message.requestedAction !== undefined
        && message.providerAction !== undefined
        && message.deliveryStateMalformed !== true
        && (rawMessageId === null || typeof rawMessageId === 'string');
    const isLegacyProviderClaim =
        hasValidEnvelope
        && params.didWrite === false
        && params.didWriteExplicitFalse === true
        && message.seq === null
        && params.rawMessageRecord?.seq === null;
    const isRowFirstProviderDelivery =
        hasValidEnvelope
        && params.didWrite === true
        && typeof message.id === 'string'
        && message.id.length > 0
        && typeof message.seq === 'number'
        && typeof rawMessageId === 'string'
        && rawMessageId.length > 0
        && typeof params.rawMessageRecord?.seq === 'number'
        && Number.isSafeInteger(params.rawMessageRecord.seq)
        && params.rawMessageRecord.seq >= 0
        && message.deliveryState?.mode === 'provider'
        && message.deliveryState.unresolved === true;
    return isLegacyProviderClaim || isRowFirstProviderDelivery;
}

export async function listPendingQueueV2LocalIdsFromServer(params: {
    token: string;
    sessionId: string;
}): Promise<string[]> {
    const pending = await fetchPendingQueueV2Projection(params);
    return pending.map((entry) => entry.localId);
}

export type PendingQueueV2DeliveryStatusEntry = Readonly<{
    localId: string;
    status: PendingDeliveryStatusV1['status'];
}>;

/**
 * Canonical per-row delivery status projection for every row currently in the server pending
 * queue. Terminal outcomes (a row resolved/delivered — e.g. user "mark delivered" — or removed)
 * are represented by the row's ABSENCE from the returned list; a lingering row explicitly reports
 * its `discarded` status. This is the single delivery-truth source used to retire local canonical
 * provider-delivery claims whose server row has gone terminal.
 */
export async function listPendingQueueV2DeliveryStatusesFromServer(params: {
    token: string;
    sessionId: string;
}): Promise<PendingQueueV2DeliveryStatusEntry[]> {
    const pending = await fetchPendingQueueV2Projection(params);
    return pending.map((entry) => ({
        localId: entry.localId,
        status: entry.deliveryStatus.status,
    }));
}

export async function listPendingQueueV2ProviderDeliveryLocalIdsFromServer(params: {
    token: string;
    sessionId: string;
}): Promise<string[]> {
    const pending = await fetchPendingQueueV2Projection(params);
    return pending
        .filter((entry) => entry.deliveryStatus.status === 'delivering')
        .map((entry) => entry.localId);
}

export async function readBlockedPendingQueueV2DeliveryByLocalIdFromServer(params: {
    token: string;
    sessionId: string;
    localId: string;
}): Promise<PendingQueueBlockedDelivery | null> {
    const localId = requirePendingLocalId(params.localId);
    const pending = await fetchPendingQueueV2Projection(params);
    const entry = pending.find((candidate) => candidate.localId === localId);
    return entry?.deliveryStatus.status === 'blocked'
        ? { localId, reason: entry.deliveryStatus.reason }
        : null;
}

export async function discardPendingQueueV2Messages(params: {
    token: string;
    sessionId: string;
    localIds: string[];
    reason: 'switch_to_local' | 'manual';
}): Promise<number> {
    let discarded = 0;
    const serverUrl = resolveServerHttpBaseUrl();
    const localIds = params.localIds.map(requirePendingLocalId);
    for (const localId of localIds) {
        try {
            await axios.post(
                `${serverUrl}/v2/sessions/${params.sessionId}/pending/${encodeURIComponent(localId)}/discard`,
                { reason: params.reason },
                { headers: buildSessionRunnerHttpHeaders(params.token), timeout: 10_000 },
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
}): Promise<Readonly<{ didWrite: boolean | null; terminal: boolean; suppressed: boolean }>> {
    const localId = requirePendingLocalId(params.body.localId);
    const serverUrl = resolveServerHttpBaseUrl();
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending`,
        params.body,
        {
            headers: buildSessionRunnerHttpHeaders(params.token, 'application/json'),
            timeout: 10_000,
        },
    );
    const data = response?.data;
    const terminal = data && typeof data === 'object' && (data as { terminal?: unknown }).terminal === true;
    if (terminal) {
        const message = data && typeof data === 'object'
            ? (data as { message?: unknown }).message
            : null;
        const record = message && typeof message === 'object' && !Array.isArray(message)
            ? message as Record<string, unknown>
            : null;
        const proofAction = PendingRequestedActionV1Schema.safeParse(record?.requestedAction);
        if (
            !record
            || readNonBlankOpaqueIdentifier(record.id) === null
            || typeof record.seq !== 'number'
            || !Number.isSafeInteger(record.seq)
            || record.seq < 0
            || readPendingLocalId(record.localId) !== localId
            || !proofAction.success
            || proofAction.data.kind !== params.body.requestedAction.kind
        ) {
            throw new Error('Invalid Pending enqueue terminal proof');
        }
    }
    return {
        didWrite: data && typeof data === 'object' && typeof (data as { didWrite?: unknown }).didWrite === 'boolean'
            ? (data as { didWrite: boolean }).didWrite
            : null,
        terminal,
        suppressed: data && typeof data === 'object' && (data as { suppressed?: unknown }).suppressed === true,
    };
}

export async function resolveAcceptedPendingQueueV2Delivery(params: {
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    sessionId: string;
    localId: string;
}): Promise<{ didResolve: boolean; pendingQueueState?: KnownPendingQueueState; message?: PendingQueueMaterializedMessage | null }> {
    const localId = requirePendingLocalId(params.localId);
    const raw = await emitSocketWithAck<Record<string, unknown>>({
        socket: createAcceptedPendingSettlementAckSocket(params.socket),
        event: ACCEPTED_PENDING_SETTLEMENT_EVENT_V1,
        payload: {
            v: 1,
            sessionId: params.sessionId,
            localId,
        },
    });
    const parsedAck = AcceptedPendingSettlementResponseV1Schema.safeParse(raw);
    if (!parsedAck.success) {
        throw new Error('Invalid pending delivery accepted settlement acknowledgement');
    }
    const ack = parsedAck.data;
    if (!ack.ok) {
        throw new PendingQueueAcceptedSettlementError(
            ack.error,
            ack.error === 'transaction-unavailable' ? ack.retryAfterMs : undefined,
            ack.error === 'transaction-unavailable' ? ack.correlationId : undefined,
        );
    }
    const pendingQueueState = readKnownPendingQueueState(ack);
    const didResolve = ack.didResolve;
    const message = 'message' in ack ? readMaterializedMessageFromAck(ack) : null;
    if ((didResolve || 'message' in ack) && message?.localId !== localId) {
        throw new Error('Invalid pending delivery accepted settlement acknowledgement');
    }
    return {
        didResolve,
        ...(pendingQueueState ? { pendingQueueState } : {}),
        ...('message' in ack ? { message } : { message: null }),
    };
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
}): Promise<{ pendingQueueState?: KnownPendingQueueState; message?: PendingQueueMaterializedMessage | null; didResolve?: boolean }> {
    const localId = requirePendingLocalId(params.localId);
    const serverUrl = resolveServerHttpBaseUrl();
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending/${encodeURIComponent(localId)}/delivery/${params.action}`,
        params.body,
        {
            headers: buildSessionRunnerHttpHeaders(params.token, 'application/json'),
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
    expectedPendingVersion?: number;
    expectedRuntimeActivityRevision?: number;
    knownPendingVersion?: number;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
    foregroundState?: 'ready' | 'active_steerable' | 'active_unsteerable';
}): Promise<PendingQueueSocketMaterializeResult> {
    try {
        const rawAck = await emitSocketWithAck<Record<string, unknown>>({
            socket: createPendingMaterializeAckSocket(params.socket),
            event: 'pending-materialize-next',
            payload: {
                sid: params.sessionId,
                ...(typeof params.expectedPendingVersion === 'number'
                    ? { expectedPendingVersion: params.expectedPendingVersion }
                    : typeof params.knownPendingVersion === 'number'
                        ? { pendingVersion: params.knownPendingVersion }
                        : {}),
                ...(typeof params.expectedRuntimeActivityRevision === 'number'
                    ? { expectedRuntimeActivityRevision: params.expectedRuntimeActivityRevision }
                    : {}),
                ...(params.deliveryStateOptIn === true ? { deliveryState: 'provider' } : {}),
                ...(params.deliveryTiming === 'after_foreground_ready' || params.deliveryTiming === 'after_runtime_idle'
                    ? { deliveryTiming: params.deliveryTiming }
                    : {}),
                ...(params.foregroundState ? { foregroundState: params.foregroundState } : {}),
            },
        });
        if (!rawAck || typeof rawAck !== 'object' || Array.isArray(rawAck)) {
            return {
                ok: false,
                error: new PendingQueueMaterializationTransportAmbiguousError(
                    new Error('Invalid pending queue materialize socket acknowledgement'),
                    'malformed_ack',
                ),
            };
        }
        if (rawAck.ok === false) {
            const serverError = readSafePendingMaterializeServerError(rawAck.error);
            if (serverError) {
                const retryAfterMs = serverError === 'transaction-unavailable'
                    ? readPendingMaterializeRetryAfterMs(rawAck)
                    : undefined;
                return {
                    ok: false,
                    error: new PendingQueueMaterializationTransportAmbiguousError(
                        new Error(`Pending queue materialize server acknowledgement: ${serverError}`),
                        retryAfterMs === undefined ? 'server_rejected' : 'server_retryable',
                        serverError,
                        retryAfterMs,
                    ),
                };
            }
        }
        if (rawAck.ok !== true) {
            return {
                ok: false,
                error: new PendingQueueMaterializationTransportAmbiguousError(
                    new Error('Invalid pending queue materialize socket acknowledgement'),
                    'malformed_ack',
                ),
            };
        }
        const pendingQueueState = readKnownPendingQueueState(rawAck);
        if (rawAck.didMaterialize !== true) {
            const deferredReason = readPendingMaterializeDeferredReason(rawAck);
            const retryAfterMs = readPendingMaterializeRetryAfterMs(rawAck);
            const deliveryState = parseDeliveryState(rawAck.deliveryState).deliveryState;
            return {
                ok: true,
                didMaterialize: false,
                ...(pendingQueueState ? { pendingQueueState } : {}),
                ...(deferredReason ? { deferredReason } : {}),
                ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
                ...(deliveryState ? { deliveryState } : {}),
            };
        }
        const message = readMaterializedMessageFromAck(rawAck);
        const localId = readMaterializedLocalIdFromAck(rawAck, message);
        const didWrite = rawAck.didWrite === true;
        const didWriteExplicitFalse = rawAck.didWrite === false;
        const providerDeliveryContractInvalid = !isProviderDeliveryMaterializationValid({
                didWrite,
                didWriteExplicitFalse,
                message,
                localId,
                rawMessageRecord: readRawMaterializedMessageRecordFromAck(rawAck),
            });
        const runtimeActivityNotice = readRuntimeActivityNotice(rawAck);
        return { ok: true, didMaterialize: true, localId, didWrite, message: providerDeliveryContractInvalid ? null : message, ...(providerDeliveryContractInvalid ? { providerDeliveryContractInvalid: true } : {}), ...(pendingQueueState ? { pendingQueueState } : {}), ...(runtimeActivityNotice ? { runtimeActivityNotice } : {}) };
    } catch (error) {
        if (isAuthenticationError(error)) {
            throw error;
        }
        return {
            ok: false,
            error: error instanceof PendingQueueMaterializationTransportAmbiguousError
                ? error
                : new PendingQueueMaterializationTransportAmbiguousError(error),
        };
    }
}

async function tryMaterializeNextViaHttp(params: {
    token: string;
    sessionId: string;
    expectedPendingVersion?: number;
    expectedRuntimeActivityRevision?: number;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
    foregroundState?: 'ready' | 'active_steerable' | 'active_unsteerable';
}): Promise<PendingQueueHttpMaterializeResult> {
    const serverUrl = resolveServerHttpBaseUrl();
    const response = await axios.post(
        `${serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending/materialize-next`,
        buildPendingMaterializeBody(params),
        {
            headers: buildSessionRunnerHttpHeaders(params.token, 'application/json'),
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
        const deferredReason = readPendingMaterializeDeferredReason(data);
        const retryAfterMs = readPendingMaterializeRetryAfterMs(data);
        const deliveryState = parseDeliveryState(data.deliveryState).deliveryState;
        return {
            ok: true,
            didMaterialize: false,
            ...(pendingQueueState ? { pendingQueueState } : {}),
            ...(deferredReason ? { deferredReason } : {}),
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            ...(deliveryState ? { deliveryState } : {}),
        };
    }
    const message = readMaterializedMessageFromAck(data);
    const localId = readMaterializedLocalIdFromAck(data, message);
    const didWrite = data.didWrite === true || data.didWriteMessage === true;
    const didWriteExplicitFalse = data.didWrite === false || data.didWriteMessage === false;
    const runtimeActivityNotice = readRuntimeActivityNotice(data);
    const providerDeliveryContractInvalid = !isProviderDeliveryMaterializationValid({
            didWrite,
            didWriteExplicitFalse,
            message,
            localId,
            rawMessageRecord: readRawMaterializedMessageRecordFromAck(data),
        });
    return {
        ok: true,
        didMaterialize: true,
        localId,
        didWrite,
        message: providerDeliveryContractInvalid ? null : message,
        ...(providerDeliveryContractInvalid ? { providerDeliveryContractInvalid: true } : {}),
        ...(pendingQueueState ? { pendingQueueState } : {}),
        ...(runtimeActivityNotice ? { runtimeActivityNotice } : {}),
    };
}

export async function materializeNextPendingQueueV2MessageViaHttp(params: {
    token: string;
    sessionId: string;
    expectedPendingVersion?: number;
    expectedRuntimeActivityRevision?: number;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
    foregroundState?: 'ready' | 'active_steerable' | 'active_unsteerable';
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
            ...(res.pendingQueueState ? { pendingQueueState: res.pendingQueueState } : {}),
            ...(res.deferredReason ? { deferredReason: res.deferredReason } : {}),
            ...(res.retryAfterMs !== undefined ? { retryAfterMs: res.retryAfterMs } : {}),
            ...(res.deliveryState ? { deliveryState: res.deliveryState } : {}),
        };
    }
    return {
        didMaterialize: true,
        localId: res.localId,
        didWrite: res.didWrite,
        message: res.message,
        ...(res.providerDeliveryContractInvalid ? { providerDeliveryContractInvalid: true } : {}),
        ...(res.pendingQueueState ? { pendingQueueState: res.pendingQueueState } : {}),
        ...(res.runtimeActivityNotice ? { runtimeActivityNotice: res.runtimeActivityNotice } : {}),
    };
}

export async function materializeNextPendingQueueV2MessageOnReleasedServer(params: Readonly<{
    sessionId: string;
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
}>): Promise<ReleasedServerV021MaterializeAck> {
    if (params.socket.connected !== true) {
        throw new Error('Released server pending materialize socket is disconnected');
    }
    const rawAck = await emitSocketWithAck<unknown>({
        socket: createPendingMaterializeAckSocket(params.socket),
        event: 'pending-materialize-next',
        payload: { sid: params.sessionId },
    });
    const ack = parseReleasedServerV021MaterializeAck(rawAck);
    if (!ack) {
        throw new Error('Invalid released server pending materialize acknowledgement');
    }
    return ack;
}

export async function materializeNextPendingQueueV2Message(params: {
    token: string;
    sessionId: string;
    socket?: Socket<ServerToClientEvents, ClientToServerEvents> | null;
    expectedPendingVersion?: number;
    expectedRuntimeActivityRevision?: number;
    knownPendingVersion?: number;
    deliveryStateOptIn?: boolean;
    deliveryTiming?: SessionPendingQueueDeliveryTiming;
    foregroundState?: 'ready' | 'active_steerable' | 'active_unsteerable';
}): Promise<PendingQueueMaterializeNextResult> {
    // Strict by default: callers that want best-effort suppression must do so explicitly.
    if (params.socket && params.socket.connected !== true) {
        throw new PendingQueueMaterializationTransportAmbiguousError(
            new Error('Selected pending queue materialize socket is disconnected'),
            'socket_disconnected',
        );
    }
    const connectedSocket = params.socket?.connected === true ? params.socket : null;
    const socketRes = connectedSocket
        ? await tryMaterializeNextViaSocket({
            socket: connectedSocket,
            sessionId: params.sessionId,
            expectedPendingVersion: params.expectedPendingVersion,
            expectedRuntimeActivityRevision: params.expectedRuntimeActivityRevision,
            knownPendingVersion: params.knownPendingVersion,
            deliveryStateOptIn: params.deliveryStateOptIn === true,
            deliveryTiming: params.deliveryTiming,
            foregroundState: params.foregroundState,
        })
        : null;
    let res: PendingQueueSocketMaterializeResult | PendingQueueHttpMaterializeResult;
    if (socketRes?.ok) {
        res = socketRes;
    } else if (connectedSocket) {
        throw socketRes?.error instanceof PendingQueueMaterializationTransportAmbiguousError
            ? socketRes.error
            : new PendingQueueMaterializationTransportAmbiguousError(socketRes?.error);
    } else {
        res = await tryMaterializeNextViaHttp({
            token: params.token,
            sessionId: params.sessionId,
            expectedPendingVersion: params.expectedPendingVersion,
            expectedRuntimeActivityRevision: params.expectedRuntimeActivityRevision,
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
            ...(res.pendingQueueState ? { pendingQueueState: res.pendingQueueState } : {}),
            ...(res.deferredReason ? { deferredReason: res.deferredReason } : {}),
            ...(res.retryAfterMs !== undefined ? { retryAfterMs: res.retryAfterMs } : {}),
            ...(res.deliveryState ? { deliveryState: res.deliveryState } : {}),
        };
    }
    return {
        didMaterialize: true,
        localId: res.localId,
        didWrite: res.didWrite,
        message: res.message,
        ...(res.providerDeliveryContractInvalid ? { providerDeliveryContractInvalid: true } : {}),
        ...(res.pendingQueueState ? { pendingQueueState: res.pendingQueueState } : {}),
        ...(res.runtimeActivityNotice ? { runtimeActivityNotice: res.runtimeActivityNotice } : {}),
    };
}

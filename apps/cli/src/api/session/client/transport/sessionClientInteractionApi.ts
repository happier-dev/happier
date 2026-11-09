import { logger } from '@/ui/logger';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { projectUsageSessionMessageTimingV1 } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { DEFAULT_MANAGED_CONNECTION_POLICY } from '@happier-dev/connection-supervisor';
import { Socket } from 'socket.io-client';
import { configuration } from '@/configuration';
import { resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';

import type {
    ClientToServerEvents,
    Metadata,
    ServerToClientEvents,
    Update,
    UserMessage,
} from '../../../types';
import { UserMessageSchema } from '../../../types';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import {
    SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT,
    SESSION_HUMAN_PRESENCE_VISIBLE_REPLACE_EVENT,
    SessionHumanPresenceSnapshotV1Schema,
    SessionHumanPresenceVisibleReplaceResultV1Schema,
} from '@happier-dev/protocol/sessions';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import {
    discardPendingQueueV2Messages,
    listPendingQueueV2LocalIdsFromServer,
    materializeNextPendingQueueV2Message,
    materializeNextPendingExecutionRunMessage,
    readPendingQueueMaterializationTransportDiagnostic,
    settlePendingQueueV2Admission,
    type PendingMaterializationDeliveryTiming,
    type PendingClaimForegroundState,
    type PendingQueueMaterializedMessage,
    type PendingQueueMaterializeNextResult,
} from '../../pendingQueueV2Transport';
import { runPendingQueueV2ReleasedServerAdapter } from '../../pendingQueueV2ReleasedServerAdapter';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { SessionSyncPendingInputServerContractResult } from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import { addDiscardedCommittedMessageLocalIds } from '../../../queue/discardedCommittedMessageLocalIds';
import type { KnownPendingQueueState, PendingQueueState } from '../../pendingQueueState';
import type {
    MaterializeNextPendingOptions,
    MaterializeNextPendingResult,
    PendingMaterializationDiagnosticPhase,
    SessionProviderInputConsumer,
} from '../../sessionClientPort';
import { serializeAxiosErrorForLog } from '../../../client/serializeAxiosErrorForLog';
import { serializeEphemeralSendError } from '../transcript/ephemeralSendOutcome';
import type { SessionSnapshotRefreshReason } from '../../sessionSnapshotRefreshReason';
import {
    openSessionMessageContent,
    deriveSessionInputEqualityTagV1,
    encryptSessionPayload,
    type SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type { SessionCatchUpRequest } from '../../sessionChangesSyncOnConnect';
import { coerceSessionUserPromptV1 } from '@happier-dev/protocol/sessions/messages/coerceSessionUserPromptV1';
import { SessionInputAdmissionReceiptV1Schema, SessionInputRequestSchema, assertSessionInputAdmissionReceiptForAuthorityV1, assertSessionInputAdmissionReceiptForRequest, SESSION_INPUT_REQUEST_META_KEY, SESSION_INPUT_AUTHORITY_META_KEY, SESSION_MESSAGE_PROVENANCE_META_KEY, readSessionInputRequest, readSessionInputAuthority, readSessionInputSenderSessionIdV1, readSessionMessageProvenance, settleSessionInputRequestV2, settleSessionMessageProvenanceV1, settleSessionMessageProvenanceV2, withSessionInputAuthority } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { PENDING_INPUT_PROTOCOL_VERSION_V3, PENDING_INPUT_PROTOCOL_VERSION_V5 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { settleSessionInputRequestV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionBroadcastContainerSchema } from '@happier-dev/protocol/updates';
import type { SessionInputRequest, SessionInputAuthority, SessionInputSettlementValidationV1, SessionInputAdmissionRejectionCodeV1 } from '@happier-dev/protocol';
import { buildImmutableSessionInputEqualityEnvelopeV1 } from '@/session/services/sessionInputEqualityEnvelope';
import { deriveSessionInputActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { isFollowDeliveryMutedV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { readSessionDeliveryMutedScopes } from '@/api/sessionDeliveryMuteTransport';
import { findTranscriptEncryptedMessageByLocalIdV2 } from '../../transcriptMessageLookup';
import type { DiscussionAddressingV1, DiscussionAddressV1 } from '@happier-dev/protocol/discussions/references';

export type SessionInputProviderDispatchReconciliation = Readonly<{
    localId: string;
    discussionAddressing?: DiscussionAddressingV1;
    signal: AbortSignal;
}>;

export type SessionInputProviderDispatchAdmission = 'admitted' | 'withdrawn' | 'rejected' | 'held' | 'outcomeUnknown';

/**
 * The exact admission/custody facts this owner hands to one target-bound runtime
 * consumer. Runtime code composes this type; it must not publish a second
 * admitted-input schema or re-derive these facts from the pending row.
 */
export type ExecutionRunAdmittedPendingInputV1 = {
    [Key in keyof UserMessage as Key extends 'inputAdmissionReceipt' ? never : Key]: UserMessage[Key];
} & Readonly<{
    authorAccountId: string | null;
    inputAdmissionReceipt: PendingQueueMaterializedMessage['inputAdmissionReceipt'] | null;
    pendingProviderAction: PendingQueueMaterializedMessage['providerAction'] | null;
    pendingRequestedAction?: PendingQueueMaterializedMessage['requestedAction'];
}>;

export type ExecutionRunPendingInputBinding = Readonly<{
    recipient: Readonly<{ kind: 'execution_run'; runId: string }>;
    sidechainId: string;
    isCurrent: () => boolean;
    foregroundState: () => PendingClaimForegroundState;
    getMetadataSnapshot: () => Metadata | null;
    consume: (message: ExecutionRunAdmittedPendingInputV1) => boolean;
    /** Existing Session pending-version wake, projected to this exact target. */
    wake?: () => void;
}>;

type ExecutionRunPendingMaterialization = ExecutionRunPendingInputBinding & Readonly<{
    hasCustody: (localId: string) => boolean;
    markCustody: (localId: string) => void;
}>;

function arePendingQueueStatesEqual(left: PendingQueueState, right: PendingQueueState): boolean {
    if (left.known !== right.known) return false;
    if (!left.known || !right.known) return true;
    return left.pendingCount === right.pendingCount
        && left.pendingBlockedCount === right.pendingBlockedCount
        && left.pendingVersion === right.pendingVersion;
}

function createMaterializedPendingQueueUpdate(params: {
    sessionId: string;
    message: PendingQueueMaterializedMessage | null | undefined;
}): Update | null {
    const { message, sessionId } = params;
    if (!message?.content) return null;
    const createdAt = message.createdAt ?? Date.now();
    const updatedAt = message.updatedAt ?? createdAt;
    const syntheticMessageId = message.id
        ?? (message.localId ? `pending-claim:${message.localId}:${updatedAt}` : null);
    if (!syntheticMessageId) return null;
    return {
        id: `pending-materialized-${syntheticMessageId}`,
        seq: 0,
        createdAt,
        body: {
            t: 'new-message', delivery: 'full' as const,
            sid: sessionId,
            message: {
                id: syntheticMessageId,
                seq: message.seq,
                content: message.content,
                inputAdmissionReceipt: message.inputAdmissionReceipt,
                localId: message.localId,
                createdAt,
                updatedAt,
                ...(typeof message.messageRole === 'string' ? { messageRole: message.messageRole } : {}),
            },
        },
    } as Update;
}

function readMaterializedPendingUserMessage(params: Readonly<{
    message: PendingQueueMaterializedMessage | null | undefined;
    sessionId: string;
    serverId: string | null;
}> & SessionStoredContentCryptoContext): UserMessage | null {
    const message = params.message;
    if (!message?.content) return null;
    const inputAdmissionReceipt = SessionInputAdmissionReceiptV1Schema.safeParse(message.inputAdmissionReceipt);
    if (message.inputAdmissionReceipt != null && !inputAdmissionReceipt.success) return null;
    let body: unknown;
    try {
        body = openSessionMessageContent({ ...params, content: message.content });
    } catch {
        return null;
    }
    const bodyWithTransportFields = {
        ...(body && typeof body === 'object' && !Array.isArray(body) ? body : {}),
        inputAdmissionReceipt: inputAdmissionReceipt.success ? inputAdmissionReceipt.data : undefined,
        callerInputConstraints: inputAdmissionReceipt.success ? inputAdmissionReceipt.data.callerInputConstraints : undefined,
        actionRequestAttributionV1: deriveSessionInputActionRequestAttributionV1({
            requestRef: message.localId ?? null,
            persona: params.serverId ? { serverId: params.serverId, sessionId: params.sessionId } : null,
            messageRole: message.messageRole,
            inputAdmissionReceipt: message.inputAdmissionReceipt,
            inputAuthority: readSessionInputAuthority(body && typeof body === 'object' && 'meta' in body ? body.meta : undefined, 'stored'),
            origin: params.serverId && message.id && message.seq !== null
                ? { kind: 'session', session: { serverId: params.serverId, sessionId: params.sessionId }, messageId: message.id }
                : null,
        }),
        ...(message.localId ? { localId: message.localId } : {}),
        ...(typeof message.createdAt === 'number' ? { createdAt: message.createdAt } : {}),
    };
    const parsed = UserMessageSchema.safeParse(bodyWithTransportFields);
    if (parsed.success) return parsed.data;
    const coerced = coerceSessionUserPromptV1(bodyWithTransportFields);
    if (!coerced) return null;
    const candidate = UserMessageSchema.safeParse({
        role: 'user',
        inputAdmissionReceipt: bodyWithTransportFields.inputAdmissionReceipt,
        callerInputConstraints: bodyWithTransportFields.callerInputConstraints,
        actionRequestAttributionV1: bodyWithTransportFields.actionRequestAttributionV1,
        content: { type: 'text', text: coerced.text },
        ...(message.localId ? { localId: message.localId } : {}),
        ...(typeof message.createdAt === 'number' ? { createdAt: message.createdAt } : {}),
        meta: (bodyWithTransportFields as Record<string, unknown>).meta,
    });
    return candidate.success ? candidate.data : null;
}

type ReconciledPendingInput =
    | Readonly<{ status: 'legacy'; message: PendingQueueMaterializedMessage }>
    | Readonly<{ status: 'admitted'; message: PendingQueueMaterializedMessage }>
    | Readonly<{ status: 'rejected'; code?: SessionInputAdmissionRejectionCodeV1 }>
    | Readonly<{ status: 'held' }>
    | Readonly<{ status: 'outcomeUnknown' }>;

function readPendingStoredPayload(
    message: PendingQueueMaterializedMessage,
    crypto: SessionStoredContentCryptoContext,
): Record<string, unknown> | null {
    if (!message.content) return null;
    let payload: unknown;
    try {
        payload = openSessionMessageContent({ ...crypto, content: message.content });
    } catch {
        return null;
    }
    return payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
}

function readProtectedPendingInputAdmission(meta: unknown, inputAdmissionReceipt: unknown): Readonly<{
    request: SessionInputRequest;
    settledAuthority?: SessionInputAuthority;
}> | null {
    const request = readSessionInputRequest(meta, 'stored');
    if (request) return { request };
    const authority = readSessionInputAuthority(meta, 'stored');
    if (!authority) return null;
    try {
        assertSessionInputAdmissionReceiptForAuthorityV1({ authority, inputAdmissionReceipt });
        // Materialization replaces the request with immutable authority. Recover
        // its request-shaped facts only for the same receiver revalidation;
        // never persist the request again or replace the original authority.
        const { admittedPermissionCeiling: _ceiling, ...permission } = authority.permission;
        return { request: SessionInputRequestSchema.parse({ ...authority, permission }), settledAuthority: authority };
    } catch {
        return null;
    }
}

function buildInputSettlementValidation(
    request: SessionInputRequest,
    autonomousCheckIn?: Readonly<{ afterTurns: number | null }>,
): SessionInputSettlementValidationV1 | undefined {
    const validation = {
        ...(request.sourceSession
            ? { sourceSession: request.sourceSession }
            : {}),
        ...(request.v === 1 && request.automation ? { automation: request.automation } : {}),
        ...(request.replyIntent ? { reply: { mode: request.replyIntent.mode,
            ...(request.replyIntent.humanOrigin ? { humanOrigin: request.replyIntent.humanOrigin } : {}),
            ...(request.discussionAddressing ? { discussion: request.discussionAddressing } : {}),
            ...(request.v === 2 ? { workflow: request.workflow } : {}),
            ...(request.actionRequestAttributionV1 ? { actionRequestAttributionV1: request.actionRequestAttributionV1 } : {}),
            ...(request.sourceSession ? { sourceSession: request.sourceSession } : {}) } } : {}),
        ...(request.v === 1 && request.returnedAnswer ? { returnedAnswer: request.returnedAnswer } : {}),
        ...(request.v === 1 && autonomousCheckIn ? { autonomousCheckIn } : {}),
    };
    return Object.keys(validation).length > 0 ? validation : undefined;
}

async function reconcileProtectedPendingInput(params: Readonly<{
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    serverId: string;
    sessionId: string;
    token: string;
    message: PendingQueueMaterializedMessage;
    metadata: Metadata | null;
    crypto: SessionStoredContentCryptoContext;
    executionRun?: boolean;
    signal?: AbortSignal;
    readCurrentAutonomousCheckIn?: (origin?: DiscussionAddressV1) => Promise<Readonly<{ afterTurns: number | null }> | null>;
}>): Promise<ReconciledPendingInput> {
    const localId = params.message.localId;
    const payload = readPendingStoredPayload(params.message, params.crypto);
    if (!localId || !payload || !params.message.content) return { status: 'outcomeUnknown' };
    const meta = payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta)
        ? payload.meta as Record<string, unknown>
        : {};
    const admission = readProtectedPendingInputAdmission(meta, params.message.inputAdmissionReceipt);
    const request = admission?.request;
    const settledAuthority = admission?.settledAuthority;
    const requestEqualityEvidenceV1 = params.executionRun && params.crypto.mode === 'e2ee'
        ? {
            kind: 'e2eeTag' as const,
            tag: deriveSessionInputEqualityTagV1({
                ctx: params.crypto.ctx,
                sessionId: params.sessionId,
                requestEnvelope: buildImmutableSessionInputEqualityEnvelopeV1({ localId, record: payload }),
                requestedAction: params.message.requestedAction ?? { v: 1, kind: 'enqueue' },
            }),
        }
        : undefined;
    if (!Object.hasOwn(meta, SESSION_INPUT_REQUEST_META_KEY) && !Object.hasOwn(meta, SESSION_INPUT_AUTHORITY_META_KEY)) {
        const retainedReceipt = createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).safeParse(params.message.inputAdmissionReceipt);
        if (retainedReceipt.success && retainedReceipt.data.issuer === 'authenticatedMachine'
            && retainedReceipt.data.discussionAddressing?.participantSessionId === params.sessionId) {
            // Unresolved Discussion custody has no permission authority. Even
            // after an ordinary restore it must re-enter the Pending owner,
            // which alone can retain its hold, before any provider delivery.
            const result = await settlePendingQueueV2Admission({ signal: params.signal, socket: params.socket,
                sessionId: params.sessionId, localId, decision: { kind: 'reject', code: 'session_input_untrusted_assertion' } });
            return result.status === 'held' ? { status: 'held' }
                : result.status === 'rejected' ? { status: 'rejected', code: result.code } : { status: 'outcomeUnknown' };
        }
        const retainedFollowInput = retainedReceipt.success && retainedReceipt.data.followDeliveryV1 !== undefined;
        if ((!params.executionRun && params.message.seq === null) || requestEqualityEvidenceV1 || retainedFollowInput) {
            const result = await settlePendingQueueV2Admission({
                signal: params.signal,
                socket: params.socket, sessionId: params.sessionId, localId,
                decision: { kind: 'admit', finalContent: params.message.content,
                    usageTimingV1: projectUsageSessionMessageTimingV1({ sessionId: params.sessionId,
                        message: { id: params.message.id ?? localId, localId, content: payload,
                            ...(params.message.createdAt === null ? {} : { createdAt: params.message.createdAt }) } }),
                    ...(requestEqualityEvidenceV1 ? { requestEqualityEvidenceV1 } : {}) },
            });
            if (result.status === 'rejected') return { status: 'rejected', code: result.code };
            if (result.status === 'held') return { status: 'held' };
            if (result.status === 'outcomeUnknown' || result.localId !== localId) return { status: 'outcomeUnknown' };
            if (retainedFollowInput) return { status: 'admitted', message: params.message };
        }
        return { status: 'legacy', message: params.message };
    }
    if (!request) {
        const result = await settlePendingQueueV2Admission({
            signal: params.signal,
            socket: params.socket,
            sessionId: params.sessionId,
            localId,
            decision: { kind: 'reject', code: 'session_input_invalid' },
        });
        return result.status === 'outcomeUnknown'
            ? { status: 'outcomeUnknown' }
            : { status: 'rejected', ...(result.status === 'rejected' ? { code: result.code } : {}) };
    }

    let inputAdmissionReceipt: ReturnType<typeof assertSessionInputAdmissionReceiptForRequest>;
    try {
        inputAdmissionReceipt = assertSessionInputAdmissionReceiptForRequest({
            request,
            inputAdmissionReceipt: createStoredReadSchema(SessionInputAdmissionReceiptV1Schema).parse(params.message.inputAdmissionReceipt),
        });
    } catch {
        const validation = buildInputSettlementValidation(request);
        const result = await settlePendingQueueV2Admission({
            signal: params.signal,
            socket: params.socket,
            sessionId: params.sessionId,
            localId,
            decision: {
                kind: 'reject',
                code: 'session_input_untrusted_assertion',
                ...(validation ? { validation } : {}),
            },
        });
        return result.status === 'outcomeUnknown'
            ? { status: 'outcomeUnknown' }
            : { status: 'rejected', ...(result.status === 'rejected' ? { code: result.code } : {}) };
    }

    const senderSessionId = readSessionInputSenderSessionIdV1(request);
    const discussionAddressing = request.discussionAddressing;
    if (!settledAuthority && (senderSessionId || discussionAddressing)) {
        const scopes = await readSessionDeliveryMutedScopes({
            receiver: { kind: 'session', sessionId: params.sessionId }, token: params.token,
            ...(params.signal ? { signal: params.signal } : {}),
        });
        if (scopes === null) return { status: 'outcomeUnknown' };
        if (isFollowDeliveryMutedV1(scopes, { ...(senderSessionId ? { senderSessionId } : {}),
            source: discussionAddressing ? { kind: 'discussion', discussionId: discussionAddressing.discussionId }
                : { kind: 'session', sessionId: senderSessionId! } })) {
            const validation = buildInputSettlementValidation(request);
            const result = await settlePendingQueueV2Admission({
                signal: params.signal, socket: params.socket, sessionId: params.sessionId, localId,
                decision: { kind: 'reject', code: 'session_input_muted', ...(validation ? { validation } : {}) },
            });
            return result.status === 'outcomeUnknown' ? { status: 'outcomeUnknown' }
                : { status: 'rejected', ...(result.status === 'rejected' ? { code: result.code } : {}) };
        }
    }

    let authority: SessionInputAuthority;
    try {
        if (settledAuthority) {
            authority = settledAuthority;
        } else {
            const currentSessionPermissionCeiling = resolvePermissionIntentFromSessionMetadata(params.metadata)?.intent
                ?? 'default';
            authority = request.v === 2
                ? settleSessionInputRequestV2({ request, currentSessionPermissionCeiling, inputAdmissionReceipt })
                : settleSessionInputRequestV1({ request, currentSessionPermissionCeiling, inputAdmissionReceipt });
        }
    } catch {
        const result = await settlePendingQueueV2Admission({
            signal: params.signal,
            socket: params.socket,
            sessionId: params.sessionId,
            localId,
            decision: {
                kind: 'reject',
                code: 'session_input_permission_ceiling_rejected',
                ...(buildInputSettlementValidation(request)
                    ? { validation: buildInputSettlementValidation(request) }
                    : {}),
            },
        });
        return result.status === 'outcomeUnknown'
            ? { status: 'outcomeUnknown' }
            : { status: 'rejected', ...(result.status === 'rejected' ? { code: result.code } : {}) };
    }
    // Protected attribution retains the originating Discussion across later
    // addressed inputs; the current addressed Discussion is otherwise the root.
    const causeOrigin = request.actionRequestAttributionV1?.origin;
    const originatingDiscussion = causeOrigin?.kind === 'discussion' ? causeOrigin.discussion
        : request.discussionAddressing ? { serverId: params.serverId, discussionId: request.discussionAddressing.discussionId }
        : undefined;
    const autonomousCheckIn = settledAuthority
        ? undefined
        : await params.readCurrentAutonomousCheckIn?.(originatingDiscussion);
    // A missing current preference must not block a person's input or an
    // informational returned answer. Their later autonomous child can initialize
    // the original root when current Account authority becomes available.
    if (!settledAuthority && request.sourceSession && !(request.v === 1 && request.returnedAnswer) && !autonomousCheckIn) {
        return { status: 'outcomeUnknown' };
    }
    const finalPayload = settledAuthority ? payload : {
        ...payload,
        meta: {
            ...withSessionInputAuthority(meta, authority),
            [SESSION_MESSAGE_PROVENANCE_META_KEY]: request.v === 2
                ? settleSessionMessageProvenanceV2({
                    request,
                    requestedProvenance: readSessionMessageProvenance(meta, 'stored'),
                    inputAdmissionReceipt,
                })
                : settleSessionMessageProvenanceV1({
                    request,
                    requestedProvenance: readSessionMessageProvenance(meta, 'stored'),
                    inputAdmissionReceipt,
                }),
        },
    };
    const finalContent = settledAuthority ? params.message.content : params.message.content.t === 'plain'
        ? { t: 'plain' as const, v: finalPayload }
        : params.crypto.mode === 'e2ee'
            ? {
                t: 'encrypted' as const,
                c: encryptSessionPayload({ ctx: params.crypto.ctx, payload: finalPayload }),
            }
            : null;
    if (!finalContent) return { status: 'outcomeUnknown' };
    const validation = buildInputSettlementValidation(request, autonomousCheckIn ?? undefined);
    const result = await settlePendingQueueV2Admission({
        signal: params.signal,
        socket: params.socket,
        sessionId: params.sessionId,
        localId,
        decision: {
            kind: 'admit',
            finalContent,
            usageTimingV1: projectUsageSessionMessageTimingV1({ sessionId: params.sessionId,
                message: { id: params.message.id ?? localId, localId, content: finalPayload,
                    ...(params.message.createdAt === null ? {} : { createdAt: params.message.createdAt }) } }),
            ...(requestEqualityEvidenceV1 ? { requestEqualityEvidenceV1 } : {}),
            ...(validation ? { validation } : {}),
        },
    });
    if (result.status === 'rejected') return { status: 'rejected', code: result.code };
    if (result.status === 'held') return { status: 'held' };
    if (result.status === 'outcomeUnknown') return { status: 'outcomeUnknown' };
    if (result.localId !== localId) return { status: 'outcomeUnknown' };
    return {
        status: 'admitted',
        message: { ...params.message, content: finalContent },
    };
}

function readPlannedServerRestartRetryAfterMs(payload: unknown): number | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const raw = (payload as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
    return Math.trunc(raw);
}

function reportPendingMaterializationDiagnosticPhase(
    observer: ((phase: PendingMaterializationDiagnosticPhase) => void) | undefined,
    phase: PendingMaterializationDiagnosticPhase,
): void {
    try {
        observer?.(phase);
    } catch {
        // Diagnostics must never alter materialization or provider-custody behavior.
    }
}

export type SessionClientInteractionApi = Readonly<{
    getPendingMessageEditHoldIds: () => readonly string[] | null;
    hasMetadataWaiters: () => boolean;
    reconcileSessionInputForProviderDispatch: (input: SessionInputProviderDispatchReconciliation) => Promise<SessionInputProviderDispatchAdmission>;
    onUserMessage: (callback: SessionProviderInputConsumer) => void;
    waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
    ensureMetadataSnapshot: (opts?: { timeoutMs?: number; abortSignal?: AbortSignal }) => Promise<Metadata | null>;
    refreshSessionSnapshotFromServerBestEffort: (opts?: { reason?: SessionSnapshotRefreshReason }) => Promise<void>;
    refreshSessionSnapshotFromServerRequired: (opts?: { reason?: SessionSnapshotRefreshReason }) => Promise<void>;
    close: () => Promise<void>;
    installSessionSocketEventHandlers: (socket: Socket<ServerToClientEvents, ClientToServerEvents>) => void;
    listPendingMessageQueueV2LocalIds: () => Promise<string[]>;
    peekPendingMessageQueueV2Count: () => Promise<number>;
    reconcilePendingQueueState: (opts?: { force?: boolean }) => Promise<boolean>;
    discardPendingMessageQueueV2All: (opts: { reason: 'switch_to_local' | 'manual' }) => Promise<number>;
    discardCommittedMessageLocalIds: (opts: { localIds: string[]; reason: 'switch_to_local' | 'manual' }) => Promise<number>;
    materializeNextPendingMessageSafely: (opts?: MaterializeNextPendingOptions) => Promise<MaterializeNextPendingResult>;
    materializeNextExecutionRunPendingMessageSafely: (target: ExecutionRunPendingMaterialization, opts?: MaterializeNextPendingOptions) => Promise<MaterializeNextPendingResult>;
    popPendingMessage: () => Promise<boolean>;
}>;

export function createSessionClientInteractionApi(
    deps: Readonly<{
        serverId: string;
        getServerIdentityId: () => string | null | undefined;
        sessionId: string;
        token: string;
        readCurrentAutonomousCheckIn?: (origin?: DiscussionAddressV1) => Promise<Readonly<{ afterTurns: number | null }> | null>;
        serverUrl?: string;
        signal?: AbortSignal;
        getClosed: () => boolean;
        setClosed: (value: boolean) => void;
        getSocket: () => Socket<ServerToClientEvents, ClientToServerEvents>;
        getSessionConnectionEpoch: () => number;
        getSessionSyncPendingInputServerContractResult: () => SessionSyncPendingInputServerContractResult | null;
        getUserSocket: () => Socket<ServerToClientEvents, ClientToServerEvents> | null;
        getSessionConnectionSupervisor: () => import('@happier-dev/connection-supervisor').ManagedConnectionSupervisor | null;
        getRpcHandlerManager: () => Pick<RpcHandlerManager, 'handleRequest'>;
        getMetadata: () => Metadata | null;
        updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void>;
        setMetadata: (metadata: Metadata | null) => void;
        getMetadataVersion: () => number;
        setMetadataVersion: (version: number) => void;
        onMetadataUpdated: (handler: () => void) => void;
        offMetadataUpdated: (handler: () => void) => void;
        onPendingMessageEditHoldIdsChanged?: () => void;
        getAgentStateVersion: () => number;
        getRuntimeActivityRevision?: () => number | null;
        getPendingWakeSeq: () => number;
        getProviderInputBacklog: () => UserMessage[];
        setProviderInputConsumer: (callback: SessionProviderInputConsumer | null) => void;
        readRetainedContextLocalIds?: () => readonly string[];
        getProviderInputConsumerAttachedAtMs: () => number | null;
        setProviderInputConsumerAttachedAtMs: (value: number | null) => void;
        wakePendingMaterialization: () => void;
        kickUserSocketConnect: () => void;
        catchUpSessionMessages: (request: SessionCatchUpRequest) => Promise<void>;
        getLastObservedMessageSeq: () => number;
        getStartupMessageCatchUpExplicitAfterSeq: () => number | null;
        getStartedByDaemonProcess: () => boolean;
        getMetadataStartedBy: () => string | null;
        getMetadataStartedFromDaemon: () => boolean | null;
        getStartupMessageCatchUpStarted: () => boolean;
        setStartupMessageCatchUpStarted: (value: boolean) => void;
        enqueueSessionUserMessage: (params: Readonly<{ text: string; localId?: string; meta?: Record<string, unknown> }>) => Promise<void> | void;
        syncSessionSnapshotFromServer: (opts: { reason: SessionSnapshotRefreshReason }) => Promise<boolean>;
        reconcileTurnStatusBeforePendingMaterialization: () => Promise<boolean>;
        logPendingMaterializationSkip?: (stage: string) => void;
        maybeScheduleUserSocketDisconnect: () => void;
        handleSessionScopedUpdate: (data: Update) => void;
        onSessionFollowInvalidated?: () => void;
        deliverMaterializedUserMessageToAgentQueue?: (
            message: UserMessage,
            providerAction: PendingQueueMaterializedMessage['providerAction'],
            requestedAction?: PendingQueueMaterializedMessage['requestedAction'],
        ) => boolean;
        clearPendingMaterializedState: () => void;
        getPendingQueueMaterializedLocalIdsSize: () => number;
        markPendingQueueMaterializedLocalId: (localId: string) => void;
        shouldAttemptPendingMaterialization: () => boolean;
        getPendingClaimForegroundState: () => PendingClaimForegroundState;
        resolvePendingClaimDeliveryTiming?: (
            requested: PendingMaterializationDeliveryTiming | undefined,
        ) => PendingMaterializationDeliveryTiming | undefined;
        /** @deprecated The server Pending claim is the only Activity timing owner. */
        shouldDeferPendingQueueDrainForRuntimeActivity?: (opts: Readonly<{
            deliveryTiming?: PendingMaterializationDeliveryTiming;
        }>) => boolean;
        getPendingQueueState: () => PendingQueueState;
        applyPendingQueueState: (state: KnownPendingQueueState) => boolean;
        onPendingQueueStateChanged: () => void;
        getStoredContentCryptoContext: () => SessionStoredContentCryptoContext;
    }>,
): SessionClientInteractionApi {
    let pendingMessageEditHoldIds: readonly string[] | null = null;
    const replacePendingMessageEditHoldIds = (ids: readonly string[] | null): void => {
        if (pendingMessageEditHoldIds === ids || (pendingMessageEditHoldIds !== null && ids !== null
            && pendingMessageEditHoldIds.length === ids.length
            && pendingMessageEditHoldIds.every((id, index) => id === ids[index]))) return;
        pendingMessageEditHoldIds = ids;
        deps.onPendingMessageEditHoldIdsChanged?.();
    };
    const serverUrl = deps.serverUrl ?? resolveServerHttpBaseUrl();
    const metadataWaitAbortController = new AbortController();
    let activeMetadataWaiters = 0;
    const pendingRpcResponses = new Set<Promise<void>>();
    let pendingQueueStateReconcileInFlight: Promise<boolean> | null = null;
    let lastPendingQueueStateReconcileAt = 0;

    const runMaterializeNextPendingMessageInner = async (opts: MaterializeNextPendingOptions = {}, target?: ExecutionRunPendingMaterialization): Promise<{
        didMaterialize: boolean;
        result: MaterializeNextPendingResult;
    }> => {
        const deliveryTiming = target ? opts.deliveryTiming
            : deps.resolvePendingClaimDeliveryTiming?.(opts.deliveryTiming) ?? opts.deliveryTiming;
        const contractResult = deps.getSessionSyncPendingInputServerContractResult();
        const socket = deps.getSocket();
        const hasCurrentContractAuthority = (): boolean => (
            deps.getSessionSyncPendingInputServerContractResult() === contractResult
            && contractResult !== null
            && contractResult.sessionConnectionEpoch === deps.getSessionConnectionEpoch()
            && contractResult.socket === socket
            && deps.getSocket() === socket
            && socket.connected === true
            && !deps.getClosed()
            && (!target || target.isCurrent())
        );
        if (!contractResult || !hasCurrentContractAuthority()) {
            return { didMaterialize: false, result: { type: 'retryable_transport' } };
        }
        if (contractResult.mode === 'auth_failed') {
            return { didMaterialize: false, result: { type: 'auth_failure' } };
        }
        if (contractResult.pendingInput === 'indeterminate') {
            return { didMaterialize: false, result: { type: 'retryable_transport' } };
        }
        const serverIdentityId = deps.getServerIdentityId();
        if (serverIdentityId === undefined) {
            return { didMaterialize: false, result: { type: 'retryable_transport' } };
        }
        const retainedContextLocalIds = target ? [] : [...deps.readRetainedContextLocalIds?.() ?? []];
        if (retainedContextLocalIds.length > 0
            && (contractResult.pendingInputProtocolVersion ?? 0) < PENDING_INPUT_PROTOCOL_VERSION_V5) {
            return { didMaterialize: false, result: { type: 'unsupported', code: 'session_input_target_update_required' } };
        }
        if (target && (contractResult.pendingInputProtocolVersion ?? 0) < PENDING_INPUT_PROTOCOL_VERSION_V3) {
            return {
                didMaterialize: false,
                result: { type: 'unsupported', code: 'session_input_target_update_required' },
            };
        }
        const supervisor = deps.getSessionConnectionSupervisor();
        if (!supervisor) {
            return { didMaterialize: false, result: { type: 'retryable_transport' } };
        }
        const reportDiagnosticPhase = (phase: PendingMaterializationDiagnosticPhase): void => {
            reportPendingMaterializationDiagnosticPhase(opts.onDiagnosticPhase, phase);
        };
        if (contractResult.pendingInput === 'released_server_v0_2_1') {
            try {
                const result = await runSupervisedRequest({
                    supervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request: () => runPendingQueueV2ReleasedServerAdapter({
                        signal: deps.signal ?? metadataWaitAbortController.signal,
                        token: deps.token,
                        serverUrl,
                        sessionId: deps.sessionId,
                        contractResult,
                        getContractResult: deps.getSessionSyncPendingInputServerContractResult,
                        getSessionConnectionEpoch: deps.getSessionConnectionEpoch,
                        getSocket: deps.getSocket,
                        isRuntimeAuthorityCurrent: () => (
                            deps.getSessionConnectionSupervisor() === supervisor
                            && !deps.getClosed()
                            && supervisor.getState().phase !== 'auth_failed'
                        ),
                        ...deps.getStoredContentCryptoContext(),
                        deliverMaterializedUserMessageToAgentQueue: (message, providerAction) =>
                            deps.deliverMaterializedUserMessageToAgentQueue?.(message, providerAction) ?? false,
                        reportDiagnosticPhase,
                    }),
                });
                return { didMaterialize: result.type === 'materialized', result };
            } catch (error) {
                if (isAuthenticationError(error)) throw error;
                return { didMaterialize: false, result: { type: 'retryable_transport' } };
            }
        }
        let materializeResult: PendingQueueMaterializeNextResult;
        let targetAuthorAccountId: string | null = null;
        try {
            reportDiagnosticPhase('materialize.server_claim');
            materializeResult = await runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request: async () => {
                    if (target) {
                        const result = await materializeNextPendingExecutionRunMessage({
                            signal: deps.signal ?? metadataWaitAbortController.signal,
                            socket, sessionId: deps.sessionId, recipient: target.recipient,
                            sidechainId: target.sidechainId,
                            deliveryTiming: deliveryTiming ?? 'after_foreground_ready',
                            foregroundState: target.foregroundState(),
                        });
                        targetAuthorAccountId = result.authorAccountId;
                        return result;
                    }
                    const pendingQueueState = deps.getPendingQueueState();
                    return await runWithServerHttpBaseUrl(serverUrl, async () => materializeNextPendingQueueV2Message({
                        signal: deps.signal ?? metadataWaitAbortController.signal,
                        token: deps.token,
                        sessionId: deps.sessionId,
                        socket,
                        knownPendingVersion: pendingQueueState.known ? pendingQueueState.pendingVersion : undefined,
                        deliveryStateOptIn: true,
                        deliveryTiming: deliveryTiming ?? 'after_foreground_ready',
                        foregroundState: deps.getPendingClaimForegroundState(),
                        ...(retainedContextLocalIds.length ? { retainedContext: { localIds: retainedContextLocalIds } } : {}),
                        ...(deliveryTiming === 'after_runtime_idle' && opts.expectedRuntimeActivityRevision !== undefined
                            ? { expectedRuntimeActivityRevision: opts.expectedRuntimeActivityRevision }
                            : {}),
                    }));
                },
            });
        } catch (error) {
            if (isAuthenticationError(error)) {
                throw error;
            }
            const diagnostic = readPendingQueueMaterializationTransportDiagnostic(error);
            logger.infoFile('[pendingQueue] materialize request failed', {
                sessionId: deps.sessionId,
                error: {
                    ...serializeEphemeralSendError(error),
                    ...(diagnostic ?? {}),
                },
            });
            // The bound socket request may have committed its exact frozen claim even when
            // its acknowledgement was lost. Rejoin that claim after the requested delay;
            // failures before a current socket request remain connection-event driven.
            return {
                didMaterialize: false,
                result: { type: 'retryable_transport', retryAfterMs: diagnostic?.retryAfterMs
                    ?? DEFAULT_MANAGED_CONNECTION_POLICY.backoffMinMs },
            };
        }
        if (!hasCurrentContractAuthority()) {
            return { didMaterialize: false, result: { type: 'retryable_transport' } };
        }
        const pendingStateChanged = !target && materializeResult.pendingQueueState
            ? deps.applyPendingQueueState(materializeResult.pendingQueueState)
            : false;
        if (pendingStateChanged) {
            deps.onPendingQueueStateChanged();
        }
        if (!materializeResult.didMaterialize) {
            const state = deps.getPendingQueueState();
            logger.debug('[pendingQueue] materialize result', {
                sessionId: deps.sessionId,
                didMaterialize: false,
                deliveryStateMode: materializeResult.deliveryState?.mode ?? null,
                pendingCount: state.known ? state.pendingCount : undefined,
                pendingVersion: state.known ? state.pendingVersion : undefined,
            });
            if (materializeResult.deferredReason === 'runtime_activity_unknown') {
                return { didMaterialize: false, result: { type: 'deferred', reason: 'runtime_activity_unknown' } };
            }
            if (materializeResult.deferredReason === 'waiting_for_runtime_activity') {
                return { didMaterialize: false, result: { type: 'deferred', reason: 'runtime_activity_active' } };
            }
            if (materializeResult.deferredReason === 'waiting_for_quota_reset') {
                return { didMaterialize: false, result: { type: 'deferred', reason: 'waiting_for_quota_reset' } };
            }
            return { didMaterialize: false, result: { type: 'no_pending' } };
        }
        const materializedLocalId = materializeResult.message?.localId ?? materializeResult.localId ?? null;
        const materializedMessageWithLocalId =
            materializeResult.message && !materializeResult.message.localId && materializedLocalId
                ? { ...materializeResult.message, localId: materializedLocalId }
                : materializeResult.message;
        let materializedMessage: PendingQueueMaterializedMessage | null | undefined = materializedMessageWithLocalId;
        if (materializedMessage) {
            reportDiagnosticPhase('materialize.input_admission');
            const messageToReconcile = materializedMessage;
            const reconciled = await runWithServerHttpBaseUrl(serverUrl, () => reconcileProtectedPendingInput({
                signal: deps.signal ?? metadataWaitAbortController.signal,
                socket,
                serverId: deps.serverId,
                sessionId: deps.sessionId,
                token: deps.token,
                message: messageToReconcile,
                metadata: target ? target.getMetadataSnapshot() : deps.getMetadata(),
                crypto: deps.getStoredContentCryptoContext(),
                ...(deps.readCurrentAutonomousCheckIn
                    ? { readCurrentAutonomousCheckIn: deps.readCurrentAutonomousCheckIn } : {}),
                ...(target ? { executionRun: true } : {}),
            }));
            if (reconciled.status === 'outcomeUnknown') {
                return {
                    didMaterialize: false,
                    result: { type: 'retryable_transport', retryAfterMs: DEFAULT_MANAGED_CONNECTION_POLICY.backoffMinMs },
                };
            }
            if (reconciled.status === 'rejected' || reconciled.status === 'held') {
                return { didMaterialize: false, result: { type: 'no_pending' } };
            }
            materializedMessage = reconciled.message;
        }
        if (!hasCurrentContractAuthority()) {
            return { didMaterialize: false, result: { type: 'retryable_transport' } };
        }
        const materializedUpdate = createMaterializedPendingQueueUpdate({
            sessionId: deps.sessionId,
            message: materializedMessage,
        });
        const alreadyInTargetCustody = target && materializedLocalId ? target.hasCustody(materializedLocalId) : false;
        if (materializedLocalId && target) {
            target.markCustody(materializedLocalId);
        } else if (materializedLocalId) {
            deps.markPendingQueueMaterializedLocalId(materializedLocalId);
        }
        if (materializedUpdate && !target) {
            deps.handleSessionScopedUpdate(materializedUpdate);
        }
        const materializedUserMessage = readMaterializedPendingUserMessage({
            message: materializedMessage,
            sessionId: deps.sessionId,
            serverId: serverIdentityId,
            ...deps.getStoredContentCryptoContext(),
        });
        const deliveredMaterializedMessage = target
            ? Boolean(materializedUserMessage && !alreadyInTargetCustody && target.consume({
                ...materializedUserMessage,
                authorAccountId: targetAuthorAccountId,
                inputAdmissionReceipt: materializedMessage?.inputAdmissionReceipt ?? null,
                pendingProviderAction: materializedMessage?.providerAction ?? null,
                pendingRequestedAction: materializedMessage?.requestedAction,
            }))
            : materializedUserMessage
            ? (deps.deliverMaterializedUserMessageToAgentQueue?.(
                materializedUserMessage,
                materializedMessage?.providerAction ?? null,
                materializedMessage?.requestedAction,
            ) ?? false)
            : false;
        const state = deps.getPendingQueueState();
        logger.debug('[pendingQueue] materialize result', {
            sessionId: deps.sessionId,
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
            pendingCount: state.known ? state.pendingCount : undefined,
            pendingVersion: state.known ? state.pendingVersion : undefined,
        });
        const message = materializedMessage;
        if (
            message
            && typeof message.localId === 'string'
            && message.localId.length > 0
            && (
                message.seq === null
                || (
                    typeof message.seq === 'number'
                    && Number.isSafeInteger(message.seq)
                    && message.seq >= 0
                )
            )
        ) {
            return {
                didMaterialize: true,
                result: {
                    type: 'materialized',
                    localId: message.localId,
                    seq: message.seq,
                    content: message.content ?? null,
                    ...(typeof message.createdAt === 'number' ? { createdAt: message.createdAt } : {}),
                    ...(typeof message.updatedAt === 'number' ? { updatedAt: message.updatedAt } : {}),
                },
            };
        }

        return { didMaterialize: true, result: { type: 'no_pending' } };
    };

    return {
        getPendingMessageEditHoldIds: () => pendingMessageEditHoldIds,
        hasMetadataWaiters: () => activeMetadataWaiters > 0,
        async materializeNextExecutionRunPendingMessageSafely(target, opts = {}) {
            if (!target.isCurrent() || deps.getClosed()) return { type: 'no_pending' };
            return (await runMaterializeNextPendingMessageInner(opts, target)).result;
        },
        onUserMessage(callback) {
            logger.debug('[API] onUserMessage callback attached', {
                sessionId: deps.sessionId,
                startedByDaemonProcess: deps.getStartedByDaemonProcess(),
                metadataStartedBy: deps.getMetadataStartedBy(),
                metadataStartedFromDaemon: deps.getMetadataStartedFromDaemon(),
            });
            deps.setProviderInputConsumer(callback);
            if (deps.getProviderInputConsumerAttachedAtMs() === null) {
                deps.setProviderInputConsumerAttachedAtMs(Date.now());
            }
            if (deps.shouldAttemptPendingMaterialization()) {
                deps.wakePendingMaterialization();
            }
            deps.kickUserSocketConnect();
            const explicitStartupAfterSeq = deps.getStartupMessageCatchUpExplicitAfterSeq();
            const startupCatchUpInitialAfterSeq =
                explicitStartupAfterSeq !== null
                    ? explicitStartupAfterSeq
                    : deps.getLastObservedMessageSeq();
            const providerInputBacklog = deps.getProviderInputBacklog();
            while (providerInputBacklog.length > 0) {
                callback(providerInputBacklog.shift()!);
            }
            const shouldStartStartupCatchUp = !deps.getStartupMessageCatchUpStarted();
            if (shouldStartStartupCatchUp) {
                deps.setStartupMessageCatchUpStarted(true);
            }
            if (shouldStartStartupCatchUp) {
                void deps.catchUpSessionMessages({
                    afterSeq: startupCatchUpInitialAfterSeq,
                })
                    .catch((error) => {
                        if (isAuthenticationError(error)) {
                            logger.debug('[API] Initial transcript catch-up failed with terminal auth', {
                                error: serializeAxiosErrorForLog(error),
                            });
                            return;
                        }
                        logger.debug('[API] Initial transcript catch-up failed (non-fatal)', {
                            error: serializeAxiosErrorForLog(error),
                        });
                    });
            }
        },

        waitForMetadataUpdate(abortSignal) {
            if (deps.getClosed() || abortSignal?.aborted) {
                return Promise.resolve(false);
            }

            const startMetadataVersion = deps.getMetadataVersion();
            const startAgentStateVersion = deps.getAgentStateVersion();
            const startPendingWakeSeq = deps.getPendingWakeSeq();
            activeMetadataWaiters += 1;
            return new Promise((resolve) => {
                let cleanedUp = false;
                const onUpdate = () => {
                    cleanup();
                    resolve(true);
                };
                const onAbort = () => {
                    cleanup();
                    resolve(false);
                };
                const onConnect = () => {
                    void deps.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' })
                        .catch((error) => {
                            logger.debug('[API] Session snapshot sync on user-socket connect failed (non-fatal)', {
                                error: serializeAxiosErrorForLog(error),
                            });
                        })
                        .finally(() => {
                            onUpdate();
                        });
                };
                const cleanup = () => {
                    if (cleanedUp) return;
                    cleanedUp = true;
                    activeMetadataWaiters -= 1;
                    deps.offMetadataUpdated(onUpdate);
                    abortSignal?.removeEventListener('abort', onAbort);
                    metadataWaitAbortController.signal.removeEventListener('abort', onAbort);
                    deps.getUserSocket()?.off('connect', onConnect);
                    deps.maybeScheduleUserSocketDisconnect();
                };

                deps.onMetadataUpdated(onUpdate);
                deps.getUserSocket()?.on('connect', onConnect);
                abortSignal?.addEventListener('abort', onAbort, { once: true });
                metadataWaitAbortController.signal.addEventListener('abort', onAbort, { once: true });
                deps.kickUserSocketConnect();

                if (deps.getClosed() || abortSignal?.aborted) {
                    onAbort();
                    return;
                }
                if (
                    deps.getMetadataVersion() !== startMetadataVersion
                    || deps.getAgentStateVersion() !== startAgentStateVersion
                    || deps.getPendingWakeSeq() !== startPendingWakeSeq
                ) {
                    onUpdate();
                    return;
                }
            });
        },

        async ensureMetadataSnapshot(opts) {
            const abortSignal = opts?.abortSignal;
            if (abortSignal?.aborted) return null;
            const currentMetadata = deps.getMetadata();
            if (deps.getMetadataVersion() >= 0 && currentMetadata) {
                return currentMetadata;
            }

            const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : 15_000;
            if (deps.getMetadataVersion() < 0) {
                void deps.syncSessionSnapshotFromServer({ reason: 'waitForMetadataUpdate' });
            }

            activeMetadataWaiters += 1;
            return await new Promise((resolve) => {
                let cleanedUp = false;
                const timer = setTimeout(() => {
                    cleanup();
                    resolve(deps.getMetadataVersion() >= 0 ? deps.getMetadata() : null);
                }, timeoutMs);
                timer.unref?.();
                const onAbort = () => {
                    cleanup();
                    resolve(null);
                };
                const onDisconnect = () => {
                    cleanup();
                    resolve(null);
                };
                const onUpdate = () => {
                    const metadata = deps.getMetadata();
                    if (deps.getMetadataVersion() >= 0 && metadata) {
                        cleanup();
                        resolve(metadata);
                    }
                };
                const cleanup = () => {
                    if (cleanedUp) return;
                    cleanedUp = true;
                    activeMetadataWaiters -= 1;
                    clearTimeout(timer);
                    deps.offMetadataUpdated(onUpdate);
                    abortSignal?.removeEventListener('abort', onAbort);
                    deps.getUserSocket()?.off('disconnect', onDisconnect);
                    deps.maybeScheduleUserSocketDisconnect();
                };

                deps.onMetadataUpdated(onUpdate);
                deps.getUserSocket()?.on('disconnect', onDisconnect);
                abortSignal?.addEventListener('abort', onAbort, { once: true });
                onUpdate();
            });
        },

        async refreshSessionSnapshotFromServerBestEffort(opts) {
            const reason = opts?.reason ?? 'waitForMetadataUpdate';
            if (
                reason === 'waitForMetadataUpdate'
                && deps.getMetadataVersion() >= 0
            ) {
                return;
            }
            await deps.syncSessionSnapshotFromServer({ reason });
        },

        async refreshSessionSnapshotFromServerRequired(opts) {
            const reason = opts?.reason ?? 'startup-drain';
            const refreshed = await deps.syncSessionSnapshotFromServer({ reason });
            if (refreshed !== true) {
                throw new Error(
                    `Required authoritative session snapshot refresh failed for ${deps.sessionId}`,
                );
            }
        },

        async close() {
            logger.debug('[API] socket.close() called');
            deps.setClosed(true);
            metadataWaitAbortController.abort();
            deps.clearPendingMaterializedState();
            // Drain actual socket acknowledgements, including their callback
            // continuations, before destroying their connection.
            try {
                await Promise.all(pendingRpcResponses);
            } finally {
                try {
                    deps.getUserSocket()?.close();
                } catch {
                    // ignore
                }
                await deps.getSessionConnectionSupervisor()?.stop();
            }
        },

        installSessionSocketEventHandlers(socket) {
            replacePendingMessageEditHoldIds(null);
            const isCurrentSocket = () => !deps.getClosed() && deps.getSocket() === socket;
            socket.on('connect', () => {
                if (!isCurrentSocket()) return;
                socket.emit(SESSION_HUMAN_PRESENCE_VISIBLE_REPLACE_EVENT, {
                    v: 1, sessionIds: [deps.sessionId], pendingMessageEdits: [],
                }, (raw) => {
                    if (!isCurrentSocket() || !socket.connected || pendingMessageEditHoldIds !== null) return;
                    const result = SessionHumanPresenceVisibleReplaceResultV1Schema.safeParse(raw);
                    // Older strict presence servers refuse the additive opt-in.
                    // No edit can have been admitted there; ordinary Pending stays usable.
                    if (result.success && !result.data.ok
                        && (result.data.errorCode === 'INVALID_REQUEST' || result.data.errorCode === 'UNSUPPORTED_VERSION')) {
                        replacePendingMessageEditHoldIds([]);
                    }
                });
            });
            socket.on('disconnect', () => {
                if (isCurrentSocket()) replacePendingMessageEditHoldIds(null);
            });
            socket.on(SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT, (raw) => {
                if (!isCurrentSocket() || !socket.connected) return;
                const parsed = SessionHumanPresenceSnapshotV1Schema.safeParse(raw);
                if (!parsed.success || parsed.data.sessionId !== deps.sessionId
                    || parsed.data.pendingMessageEditHoldIds === undefined) return;
                replacePendingMessageEditHoldIds(parsed.data.pendingMessageEditHoldIds);
            });
            socket.on('server:restarting', (payload: unknown) => {
                deps.getSessionConnectionSupervisor()?.reportProbeResult?.({
                    status: 'retry_later',
                    retryAfterMs: readPlannedServerRestartRetryAfterMs(payload),
                    reason: 'server_restarting',
                    errorMessage: 'Server restart in progress',
                });
            });

            socket.on(SOCKET_RPC_EVENTS.REQUEST, async (data: { method: string; params: unknown }, callback: (response: unknown) => void) => {
                if (deps.getClosed()) {
                    // A typed pre-dispatch refusal is valid for both plain and
                    // bound E2EE RPCs; it conveys no Session content.
                    callback({ error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
                    return;
                }
                const response = runWithServerHttpBaseUrl(serverUrl, async () => {
                    await deps.getRpcHandlerManager().handleRequest(data, callback, 'authenticated_home_socket');
                });
                pendingRpcResponses.add(response);
                try {
                    await response;
                } finally {
                    pendingRpcResponses.delete(response);
                }
            });
            socket.on('connect_error', (error) => {
                logger.debug('[API] Socket connection error:', {
                    error: serializeAxiosErrorForLog(error),
                });
            });
            socket.on('update', (data: Update) => deps.handleSessionScopedUpdate(data));
            socket.on('session', (raw: unknown) => {
                if (!deps.onSessionFollowInvalidated) return;
                const parsed = SessionBroadcastContainerSchema.safeParse(raw);
                if (!parsed.success) return;
                if (parsed.data.body.t !== 'session-changed') return;
                if (parsed.data.body.sessionId !== deps.sessionId) return;
                deps.onSessionFollowInvalidated();
            });
            socket.on('error', (error) => {
                logger.debug('[API] Socket error:', {
                    error: serializeAxiosErrorForLog(error),
                });
            });
        },

        async listPendingMessageQueueV2LocalIds() {
            const request = () => runWithServerHttpBaseUrl(serverUrl, async () => listPendingQueueV2LocalIdsFromServer({
                token: deps.token,
                sessionId: deps.sessionId,
            }));
            const supervisor = deps.getSessionConnectionSupervisor();
            if (!supervisor) {
                return request();
            }
            try {
                return await runSupervisedRequest({
                    supervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request,
                });
            } catch (error) {
                if (isAuthenticationError(error)) {
                    throw error;
                }
                throw error;
            }
        },

        async peekPendingMessageQueueV2Count() {
            const materializedCount = deps.getPendingQueueMaterializedLocalIdsSize();
            if (!deps.shouldAttemptPendingMaterialization()) {
                if (!deps.getPendingQueueState().known) {
                    await this.reconcilePendingQueueState({ force: true });
                }
                const pendingQueueState = deps.getPendingQueueState();
                if (pendingQueueState.known) {
                    return pendingQueueState.pendingCount + materializedCount;
                }
                if (!deps.shouldAttemptPendingMaterialization()) {
                    return materializedCount;
                }
            }
            const localIds = await this.listPendingMessageQueueV2LocalIds();
            return localIds.length + materializedCount;
        },

        async reconcilePendingQueueState(opts) {
            if (deps.getClosed()) return false;
            if (!opts?.force && deps.shouldAttemptPendingMaterialization()) {
                return false;
            }

            const now = Date.now();
            if (
                !opts?.force
                && lastPendingQueueStateReconcileAt > 0
                && now - lastPendingQueueStateReconcileAt < configuration.pendingQueueStateReconcileThrottleMs
            ) {
                return false;
            }

            if (pendingQueueStateReconcileInFlight) {
                return await pendingQueueStateReconcileInFlight;
            }

            const run = async (): Promise<boolean> => {
                lastPendingQueueStateReconcileAt = Date.now();
                const before = deps.getPendingQueueState();
                await deps.syncSessionSnapshotFromServer({
                    reason: opts?.force ? 'startup-drain' : 'waitForMetadataUpdate',
                });
                return !arePendingQueueStatesEqual(before, deps.getPendingQueueState());
            };

            const reconcile = run().finally(() => {
                if (pendingQueueStateReconcileInFlight === reconcile) {
                    pendingQueueStateReconcileInFlight = null;
                }
            });
            pendingQueueStateReconcileInFlight = reconcile;
            return await reconcile;
        },

        async discardPendingMessageQueueV2All(opts) {
            const pendingQueueState = deps.getPendingQueueState();
            if (pendingQueueState.known && pendingQueueState.pendingCount <= 0) return 0;
            const localIds = await this.listPendingMessageQueueV2LocalIds();
            if (localIds.length === 0) return 0;
            const request = () => runWithServerHttpBaseUrl(serverUrl, async () => discardPendingQueueV2Messages({
                token: deps.token,
                sessionId: deps.sessionId,
                localIds,
                reason: opts.reason,
            }));
            const supervisor = deps.getSessionConnectionSupervisor();
            if (!supervisor) {
                return request();
            }
            try {
                return await runSupervisedRequest({
                    supervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request,
                });
            } catch (error) {
                if (isAuthenticationError(error)) {
                    throw error;
                }
                throw error;
            }
        },

        async discardCommittedMessageLocalIds(opts) {
            const socket = deps.getSocket();
            if (!socket.connected) {
                return 0;
            }
            if (!deps.getMetadata()) {
                return 0;
            }

            const localIds = opts.localIds.filter((id) => typeof id === 'string' && id.length > 0);
            if (localIds.length === 0) {
                return 0;
            }

            let addedCount = 0;
            await deps.updateMetadata((current) => {
                const existingRaw = (current as { discardedCommittedMessageLocalIds?: unknown })
                    .discardedCommittedMessageLocalIds;
                const existing = Array.isArray(existingRaw)
                    ? existingRaw.filter((value): value is string => typeof value === 'string')
                    : [];
                const existingSet = new Set(existing);
                const uniqueNew = localIds.filter((id) => !existingSet.has(id));
                addedCount = uniqueNew.length;
                return uniqueNew.length > 0
                    ? addDiscardedCommittedMessageLocalIds(current, uniqueNew) as Metadata
                    : current;
            });
            return addedCount;
        },

        async materializeNextPendingMessageSafely(opts: MaterializeNextPendingOptions = {}) {
            const supervisorState = deps.getSessionConnectionSupervisor()?.getState();
            if (supervisorState?.phase === 'auth_failed') {
                return { type: 'deferred', reason: 'supervisor_auth_failed' };
            }
            if (supervisorState && supervisorState.phase !== 'online') {
                logger.debug('[pendingQueue] materializing with degraded session supervisor', {
                    sessionId: deps.sessionId,
                    phase: supervisorState.phase,
                });
            }

            const policy = opts.reconcileWhenEmpty ?? 'force';
            const pendingQueueState = deps.getPendingQueueState();
            if (!pendingQueueState.known) {
                reportPendingMaterializationDiagnosticPhase(opts.onDiagnosticPhase, 'materialize.pending_snapshot');
                await this.reconcilePendingQueueState({ force: true });
            } else if (pendingQueueState.pendingCount <= 0) {
                if (policy === 'force') {
                    reportPendingMaterializationDiagnosticPhase(opts.onDiagnosticPhase, 'materialize.pending_snapshot');
                    await this.reconcilePendingQueueState({ force: true });
                } else if (policy === 'throttled') {
                    reportPendingMaterializationDiagnosticPhase(opts.onDiagnosticPhase, 'materialize.pending_snapshot');
                    await this.reconcilePendingQueueState({ force: false });
                }
            }
            const materializeOpts = {
                deliveryTiming: opts.deliveryTiming,
                expectedRuntimeActivityRevision: opts.expectedRuntimeActivityRevision,
                onDiagnosticPhase: opts.onDiagnosticPhase,
            };
            if (!deps.shouldAttemptPendingMaterialization()) {
                // The gate may be blocked by a stale turn-status snapshot: reconcile (which can
                // self-heal a stale busy gate) before concluding there is nothing to drain.
                reportPendingMaterializationDiagnosticPhase(opts.onDiagnosticPhase, 'materialize.turn_status');
                const healedTurnStatus = await deps.reconcileTurnStatusBeforePendingMaterialization();
                if (!healedTurnStatus || !deps.shouldAttemptPendingMaterialization()) {
                    deps.logPendingMaterializationSkip?.('materialize_safely_gate');
                    return { type: 'no_pending' };
                }
            } else {
                reportPendingMaterializationDiagnosticPhase(opts.onDiagnosticPhase, 'materialize.turn_status');
                const refreshedTurnStatus = await deps.reconcileTurnStatusBeforePendingMaterialization();
                if (!refreshedTurnStatus) {
                    deps.logPendingMaterializationSkip?.('materialize_safely_turn_status_refresh');
                    return { type: 'no_pending' };
                }
                if (!deps.shouldAttemptPendingMaterialization()) {
                    deps.logPendingMaterializationSkip?.('materialize_safely_post_refresh_gate');
                    return { type: 'no_pending' };
                }
            }

            const inner = await runMaterializeNextPendingMessageInner(materializeOpts);
            return inner.result;
        },

        async reconcileSessionInputForProviderDispatch(input) {
            if (deps.getClosed() || input.signal.aborted) return 'outcomeUnknown';
            const socket = deps.getSocket();
            const epoch = deps.getSessionConnectionEpoch();
            if (!socket.connected) return 'outcomeUnknown';
            const original = await findTranscriptEncryptedMessageByLocalIdV2({ token: deps.token,
                serverUrl, sessionId: deps.sessionId, localId: input.localId, signal: input.signal });
            if (original.type !== 'found') return 'outcomeUnknown';
            const message: PendingQueueMaterializedMessage = { ...original.message,
                messageRole: original.message.messageRole ?? null,
                inputAdmissionReceipt: original.message.inputAdmissionReceipt ?? null,
                providerAction: null, requestedAction: { v: 1, kind: 'enqueue' } };
            const crypto = deps.getStoredContentCryptoContext();
            const payload = readPendingStoredPayload(message, crypto);
            const request = readProtectedPendingInputAdmission(payload?.meta, message.inputAdmissionReceipt)?.request;
            const originalAddress = request?.discussionAddressing;
            const address = input.discussionAddressing;
            if (address && (!originalAddress || originalAddress.discussionId !== address.discussionId
                || originalAddress.messageId !== address.messageId || originalAddress.throughSeq !== address.throughSeq
                || originalAddress.participantSessionId !== address.participantSessionId
                || address.participantSessionId !== deps.sessionId)) return 'rejected';
            const result = await runWithServerHttpBaseUrl(serverUrl, () => reconcileProtectedPendingInput({
                socket, serverId: deps.serverId, sessionId: deps.sessionId, token: deps.token, message, metadata: deps.getMetadata(), crypto,
                signal: input.signal, ...(deps.readCurrentAutonomousCheckIn
                    ? { readCurrentAutonomousCheckIn: deps.readCurrentAutonomousCheckIn } : {}),
            }));
            if (deps.getClosed() || input.signal.aborted || deps.getSocket() !== socket
                || !socket.connected || deps.getSessionConnectionEpoch() !== epoch) return 'outcomeUnknown';
            // Pending has already retired this exact original. A definite
            // withdrawal is neither a provider failure nor a new settlement.
            if (result.status === 'rejected' && result.code === 'session_input_cancelled') return 'withdrawn';
            return result.status === 'legacy' ? 'rejected' : result.status;
        },

        async popPendingMessage() {
            if (!deps.shouldAttemptPendingMaterialization()) {
                await this.reconcilePendingQueueState({ force: !deps.getPendingQueueState().known });
            }
            const refreshedTurnStatus = await deps.reconcileTurnStatusBeforePendingMaterialization();
            if (!refreshedTurnStatus) {
                deps.logPendingMaterializationSkip?.('pop_pending_turn_status_refresh');
                return false;
            }
            if (!deps.shouldAttemptPendingMaterialization()) {
                deps.logPendingMaterializationSkip?.('pop_pending_gate');
                return false;
            }
            const inner = await runMaterializeNextPendingMessageInner();
            return inner.didMaterialize;
        },
    };
}

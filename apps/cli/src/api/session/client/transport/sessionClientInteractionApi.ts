import { logger } from '@/ui/logger';
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
import { isAuthenticationError } from '@/api/client/httpStatusError';
import {
    discardPendingQueueV2Messages,
    listPendingQueueV2LocalIdsFromServer,
    materializeNextPendingQueueV2Message,
    readPendingQueueMaterializationTransportDiagnostic,
    settlePendingQueueV2Admission,
    type PendingMaterializationDeliveryTiming,
    type PendingQueueMaterializedMessage,
    type PendingQueueMaterializeNextResult,
} from '../../pendingQueueV2Transport';
import { runPendingQueueV2ReleasedServerAdapter } from '../../pendingQueueV2ReleasedServerAdapter';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { SessionSyncPendingInputServerContractResult } from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import { addDiscardedCommittedMessageLocalIds } from '../../../queue/discardedCommittedMessageLocalIds';
import type { KnownPendingQueueState, PendingQueueState } from '../../pendingQueueState';
import type { MaterializeNextPendingResult } from '../../sessionClientPort';
import { serializeAxiosErrorForLog } from '../../../client/serializeAxiosErrorForLog';
import { serializeEphemeralSendError } from '../transcript/ephemeralSendOutcome';
import type { SessionSnapshotRefreshReason } from '../../sessionSnapshotRefreshReason';
import {
    decryptSessionPayload,
    encryptSessionPayload,
    type SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type { SessionCatchUpRequest } from '../../sessionChangesSyncOnConnect';
import {
    coerceSessionUserPromptV1,
    assertSessionInputAdmissionReceiptForRequestV1,
    readSessionInputRequestV1,
    settleSessionInputRequestV1,
    withSessionInputAuthorityV1,
    type SessionInputSettlementValidationV1,
} from '@happier-dev/protocol';

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
            t: 'new-message',
            sid: sessionId,
            message: {
                id: syntheticMessageId,
                seq: message.seq,
                content: message.content,
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
}> & SessionStoredContentCryptoContext): UserMessage | null {
    const message = params.message;
    if (!message?.content) return null;
    let body: unknown;
    if (message.content.t === 'plain') {
        body = message.content.v;
    } else {
        if (params.mode !== 'e2ee') return null;
        try {
            body = decryptSessionPayload({
                ctx: params.ctx,
                ciphertextBase64: message.content.c,
            });
        } catch {
            return null;
        }
    }
    const bodyWithTransportFields = {
        ...(body && typeof body === 'object' && !Array.isArray(body) ? body : {}),
        ...(message.localId ? { localId: message.localId } : {}),
        ...(typeof message.createdAt === 'number' ? { createdAt: message.createdAt } : {}),
    };
    const parsed = UserMessageSchema.safeParse(bodyWithTransportFields);
    if (parsed.success) return parsed.data;
    const coerced = coerceSessionUserPromptV1(bodyWithTransportFields);
    if (!coerced) return null;
    const candidate = UserMessageSchema.safeParse({
        role: 'user',
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
    | Readonly<{ status: 'rejected' }>
    | Readonly<{ status: 'outcomeUnknown' }>;

function readPendingStoredPayload(
    message: PendingQueueMaterializedMessage,
    crypto: SessionStoredContentCryptoContext,
): Record<string, unknown> | null {
    if (!message.content) return null;
    let payload: unknown;
    if (message.content.t === 'plain') {
        payload = message.content.v;
    } else {
        if (crypto.mode !== 'e2ee') return null;
        try {
            payload = decryptSessionPayload({ ctx: crypto.ctx, ciphertextBase64: message.content.c });
        } catch {
            return null;
        }
    }
    return payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
}

function buildInputSettlementValidation(
    request: NonNullable<ReturnType<typeof readSessionInputRequestV1>>,
): SessionInputSettlementValidationV1 | undefined {
    const validation = {
        ...(request.sourceSession
            ? {
                sourceSession: {
                    sourceSessionId: request.sourceSession.sourceSessionId,
                    sourceTurnId: request.sourceSession.sourceTurnId,
                    via: request.sourceSession.via,
                },
            }
            : {}),
        ...(request.automation ? { automation: request.automation } : {}),
    };
    return Object.keys(validation).length > 0 ? validation : undefined;
}

async function reconcileProtectedPendingInput(params: Readonly<{
    socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    sessionId: string;
    message: PendingQueueMaterializedMessage;
    metadata: Metadata | null;
    crypto: SessionStoredContentCryptoContext;
}>): Promise<ReconciledPendingInput> {
    const localId = params.message.localId;
    const payload = readPendingStoredPayload(params.message, params.crypto);
    if (!localId || !payload || !params.message.content) return { status: 'outcomeUnknown' };
    const meta = payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta)
        ? payload.meta as Record<string, unknown>
        : {};
    const request = readSessionInputRequestV1(meta);
    if (!Object.hasOwn(meta, 'happierInputRequestV1')) {
        return { status: 'legacy', message: params.message };
    }
    if (!request) {
        const result = await settlePendingQueueV2Admission({
            socket: params.socket,
            sessionId: params.sessionId,
            localId,
            decision: { kind: 'reject', code: 'session_input_invalid' },
        });
        return result.status === 'outcomeUnknown'
            ? { status: 'outcomeUnknown' }
            : { status: 'rejected' };
    }

    let inputAdmissionReceipt: ReturnType<typeof assertSessionInputAdmissionReceiptForRequestV1>;
    try {
        inputAdmissionReceipt = assertSessionInputAdmissionReceiptForRequestV1({
            request,
            inputAdmissionReceipt: params.message.inputAdmissionReceipt,
        });
    } catch {
        const validation = buildInputSettlementValidation(request);
        const result = await settlePendingQueueV2Admission({
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
            : { status: 'rejected' };
    }

    const currentSessionPermissionCeiling = resolvePermissionIntentFromSessionMetadata(params.metadata)?.intent
        ?? 'default';
    let authority: ReturnType<typeof settleSessionInputRequestV1>;
    try {
        authority = settleSessionInputRequestV1({
            request,
            currentSessionPermissionCeiling,
            inputAdmissionReceipt,
        });
    } catch {
        const result = await settlePendingQueueV2Admission({
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
            : { status: 'rejected' };
    }
    const finalPayload = {
        ...payload,
        meta: withSessionInputAuthorityV1(meta, authority),
    };
    const finalContent = params.message.content.t === 'plain'
        ? { t: 'plain' as const, v: finalPayload }
        : params.crypto.mode === 'e2ee'
            ? {
                t: 'encrypted' as const,
                c: encryptSessionPayload({ ctx: params.crypto.ctx, payload: finalPayload }),
            }
            : null;
    if (!finalContent) return { status: 'outcomeUnknown' };
    const validation = buildInputSettlementValidation(request);
    const result = await settlePendingQueueV2Admission({
        socket: params.socket,
        sessionId: params.sessionId,
        localId,
        decision: {
            kind: 'admit',
            finalContent,
            ...(validation ? { validation } : {}),
        },
    });
    if (result.status === 'rejected') return { status: 'rejected' };
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

export type SessionClientInteractionApi = Readonly<{
    onUserMessage: (callback: (data: UserMessage) => boolean | void) => void;
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
    materializeNextPendingMessageSafely: (opts?: {
        reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
        deliveryTiming?: PendingMaterializationDeliveryTiming;
        expectedRuntimeActivityRevision?: number;
    }) => Promise<MaterializeNextPendingResult>;
    popPendingMessage: () => Promise<boolean>;
}>;

export function createSessionClientInteractionApi(
    deps: Readonly<{
        sessionId: string;
        token: string;
        getClosed: () => boolean;
        setClosed: (value: boolean) => void;
        getSocket: () => Socket<ServerToClientEvents, ClientToServerEvents>;
        getSessionConnectionEpoch: () => number;
        getSessionSyncPendingInputServerContractResult: () => SessionSyncPendingInputServerContractResult | null;
        getUserSocket: () => Socket<ServerToClientEvents, ClientToServerEvents>;
        getSessionConnectionSupervisor: () => import('@happier-dev/connection-supervisor').ManagedConnectionSupervisor | null;
        getRpcHandlerManager: () => { handleRequest: (data: { method: string; params: unknown }) => Promise<unknown> };
        getMetadata: () => Metadata | null;
        updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void>;
        setMetadata: (metadata: Metadata | null) => void;
        getMetadataVersion: () => number;
        setMetadataVersion: (version: number) => void;
        onMetadataUpdated: (handler: () => void) => void;
        offMetadataUpdated: (handler: () => void) => void;
        getAgentStateVersion: () => number;
        getRuntimeActivityRevision?: () => number | null;
        getPendingWakeSeq: () => number;
        getProviderInputBacklog: () => UserMessage[];
        setProviderInputConsumer: (callback: ((message: UserMessage) => boolean | void) | null) => void;
        getProviderInputConsumerAttachedAtMs: () => number | null;
        setProviderInputConsumerAttachedAtMs: (value: number | null) => void;
        wakePendingMaterialization: () => void;
        clearUserSocketDisconnectTimer: () => void;
        kickUserSocketConnect: () => void;
        catchUpSessionMessages: (request: SessionCatchUpRequest) => Promise<void>;
        scheduleNextStartupMessageCatchUpRetry: () => void;
        getLastObservedMessageSeq: () => number;
        getStartupMessageCatchUpExplicitAfterSeq: () => number | null;
        getStartedByDaemonProcess: () => boolean;
        getMetadataStartedBy: () => string | null;
        getMetadataStartedFromDaemon: () => boolean | null;
        getStartupMessageCatchUpStarted: () => boolean;
        setStartupMessageCatchUpStarted: (value: boolean) => void;
        setStartupMessageCatchUpRetryIndex: (value: number) => void;
        setStartupMessageCatchUpInitialAfterSeq: (value: number) => void;
        enqueueSessionUserMessage: (params: Readonly<{ text: string; localId?: string; meta?: Record<string, unknown> }>) => Promise<void> | void;
        syncSessionSnapshotFromServer: (opts: { reason: SessionSnapshotRefreshReason }) => Promise<boolean>;
        reconcileTurnStatusBeforePendingMaterialization: () => Promise<boolean>;
        logPendingMaterializationSkip?: (stage: string) => void;
        maybeScheduleUserSocketDisconnect: () => void;
        handleSessionScopedUpdate: (data: Update) => void;
        deliverMaterializedUserMessageToAgentQueue?: (
            message: UserMessage,
            providerAction: PendingQueueMaterializedMessage['providerAction'],
            requestedAction?: PendingQueueMaterializedMessage['requestedAction'],
        ) => boolean;
        clearStartupMessageCatchUpRetryTimer: () => void;
        clearCommittedLocalIdCleanupTimers: () => void;
        clearPendingMaterializedState: () => void;
        getPendingQueueMaterializedLocalIdsSize: () => number;
        markPendingQueueMaterializedLocalId: (localId: string) => void;
        shouldAttemptPendingMaterialization: () => boolean;
        resolvePendingClaimDeliveryTiming?: (
            requested: PendingMaterializationDeliveryTiming | undefined,
        ) => PendingMaterializationDeliveryTiming | undefined;
        /** @deprecated The server Pending claim is the only Activity timing owner. */
        shouldDeferPendingQueueDrainForRuntimeActivity?: (opts: Readonly<{
            deliveryTiming?: PendingMaterializationDeliveryTiming;
        }>) => boolean;
        getPendingQueueState: () => PendingQueueState;
        applyPendingQueueState: (state: KnownPendingQueueState) => boolean;
        observePendingMaterializeResult: (params: Readonly<{ didMaterialize: boolean; pendingQueueState?: KnownPendingQueueState | null }>) => boolean;
        onPendingQueueStateChanged: () => void;
        getStoredContentCryptoContext: () => SessionStoredContentCryptoContext;
    }>,
): SessionClientInteractionApi {
    let pendingQueueStateReconcileInFlight: Promise<boolean> | null = null;
    let lastPendingQueueStateReconcileAt = 0;

    const runMaterializeNextPendingMessageInner = async (opts: {
        deliveryTiming?: PendingMaterializationDeliveryTiming;
        expectedRuntimeActivityRevision?: number;
    } = {}): Promise<{
        didMaterialize: boolean;
        result: MaterializeNextPendingResult;
    }> => {
        const deliveryTiming = deps.resolvePendingClaimDeliveryTiming?.(opts.deliveryTiming) ?? opts.deliveryTiming;
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
        const supervisor = deps.getSessionConnectionSupervisor();
        if (!supervisor) {
            return { didMaterialize: false, result: { type: 'retryable_transport' } };
        }
        if (contractResult.pendingInput === 'released_server_v0_2_1') {
            try {
                const result = await runSupervisedRequest({
                    supervisor,
                    requireAuth: true,
                    requireOnline: false,
                    request: () => runPendingQueueV2ReleasedServerAdapter({
                        token: deps.token,
                        serverUrl: resolveServerHttpBaseUrl(),
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
                    }),
                });
                return { didMaterialize: result.type === 'materialized', result };
            } catch (error) {
                if (isAuthenticationError(error)) throw error;
                return { didMaterialize: false, result: { type: 'retryable_transport' } };
            }
        }
        let materializeResult: PendingQueueMaterializeNextResult;
        try {
            materializeResult = await runSupervisedRequest({
                supervisor,
                requireAuth: true,
                requireOnline: false,
                request: async () => {
                    const pendingQueueState = deps.getPendingQueueState();
                    return await materializeNextPendingQueueV2Message({
                        token: deps.token,
                        sessionId: deps.sessionId,
                        socket,
                        knownPendingVersion: pendingQueueState.known ? pendingQueueState.pendingVersion : undefined,
                        deliveryStateOptIn: true,
                        deliveryTiming: deliveryTiming ?? 'after_foreground_ready',
                        foregroundState: 'ready',
                        ...(deliveryTiming === 'after_runtime_idle' && opts.expectedRuntimeActivityRevision !== undefined
                            ? { expectedRuntimeActivityRevision: opts.expectedRuntimeActivityRevision }
                            : {}),
                    });
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
            // its acknowledgement was lost. Rejoin that claim once after a short delay;
            // failures before a current socket request remain connection-event driven.
            return {
                didMaterialize: false,
                result: { type: 'retryable_transport', retryAfterMs: diagnostic?.retryAfterMs ?? 250 },
            };
        }
        if (!hasCurrentContractAuthority()) {
            return { didMaterialize: false, result: { type: 'retryable_transport' } };
        }
        const pendingStateChanged = deps.observePendingMaterializeResult({
            didMaterialize: materializeResult.didMaterialize,
            pendingQueueState: materializeResult.pendingQueueState,
        });
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
            return { didMaterialize: false, result: { type: 'no_pending' } };
        }
        const materializedLocalId = materializeResult.message?.localId ?? materializeResult.localId ?? null;
        const materializedMessageWithLocalId =
            materializeResult.message && !materializeResult.message.localId && materializedLocalId
                ? { ...materializeResult.message, localId: materializedLocalId }
                : materializeResult.message;
        let materializedMessage: PendingQueueMaterializedMessage | null | undefined = materializedMessageWithLocalId;
        if (materializedMessage) {
            const reconciled = await reconcileProtectedPendingInput({
                socket,
                sessionId: deps.sessionId,
                message: materializedMessage,
                metadata: deps.getMetadata(),
                crypto: deps.getStoredContentCryptoContext(),
            });
            if (reconciled.status === 'outcomeUnknown') {
                return {
                    didMaterialize: false,
                    result: { type: 'retryable_transport', retryAfterMs: 250 },
                };
            }
            if (reconciled.status === 'rejected') {
                return { didMaterialize: false, result: { type: 'no_pending' } };
            }
            materializedMessage = reconciled.message;
        }
        const materializedUpdate = createMaterializedPendingQueueUpdate({
            sessionId: deps.sessionId,
            message: materializedMessage,
        });
        if (materializedLocalId) {
            deps.markPendingQueueMaterializedLocalId(materializedLocalId);
        }
        if (materializedUpdate) {
            deps.handleSessionScopedUpdate(materializedUpdate);
        }
        const materializedUserMessage = readMaterializedPendingUserMessage({
            message: materializedMessage,
            ...deps.getStoredContentCryptoContext(),
        });
        const deliveredMaterializedMessage = materializedUserMessage
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
            deps.clearUserSocketDisconnectTimer();
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
                deps.setStartupMessageCatchUpRetryIndex(0);
                deps.setStartupMessageCatchUpInitialAfterSeq(startupCatchUpInitialAfterSeq);
            }
            if (shouldStartStartupCatchUp) {
                void deps.catchUpSessionMessages({
                    afterSeq: startupCatchUpInitialAfterSeq,
                })
                    .then(() => true, (error) => {
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
                        if (shouldContinue === true) {
                            deps.scheduleNextStartupMessageCatchUpRetry();
                        }
                    });
            }
        },

        waitForMetadataUpdate(abortSignal) {
            if (abortSignal?.aborted) {
                return Promise.resolve(false);
            }

            const startMetadataVersion = deps.getMetadataVersion();
            const startAgentStateVersion = deps.getAgentStateVersion();
            const startPendingWakeSeq = deps.getPendingWakeSeq();
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
                const onDisconnect = () => {
                    cleanup();
                    resolve(false);
                };
                const cleanup = () => {
                    if (cleanedUp) return;
                    cleanedUp = true;
                    deps.offMetadataUpdated(onUpdate);
                    abortSignal?.removeEventListener('abort', onAbort);
                    deps.getUserSocket().off('connect', onConnect);
                    deps.getUserSocket().off('disconnect', onDisconnect);
                    deps.maybeScheduleUserSocketDisconnect();
                };

                deps.onMetadataUpdated(onUpdate);
                deps.getUserSocket().on('connect', onConnect);
                deps.getUserSocket().on('disconnect', onDisconnect);
                abortSignal?.addEventListener('abort', onAbort, { once: true });
                deps.kickUserSocketConnect();

                if (abortSignal?.aborted) {
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
                    clearTimeout(timer);
                    deps.offMetadataUpdated(onUpdate);
                    abortSignal?.removeEventListener('abort', onAbort);
                    deps.getUserSocket().off('disconnect', onDisconnect);
                    deps.maybeScheduleUserSocketDisconnect();
                };

                deps.onMetadataUpdated(onUpdate);
                deps.getUserSocket().on('disconnect', onDisconnect);
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
            deps.clearStartupMessageCatchUpRetryTimer();
            deps.clearUserSocketDisconnectTimer();
            try {
            } catch (error) {
                logger.debug('[pendingQueue] provider delivery close cleanup failed', {
                    sessionId: deps.sessionId,
                    error: serializeAxiosErrorForLog(error),
                });
            }
            deps.setClosed(true);
            deps.clearPendingMaterializedState();
            deps.clearCommittedLocalIdCleanupTimers();
            try {
                deps.getUserSocket().close();
            } catch {
                // ignore
            }
            await deps.getSessionConnectionSupervisor()?.stop();
        },

        installSessionSocketEventHandlers(socket) {
            socket.on('server:restarting', (payload: unknown) => {
                deps.getSessionConnectionSupervisor()?.reportProbeResult?.({
                    status: 'retry_later',
                    retryAfterMs: readPlannedServerRestartRetryAfterMs(payload),
                    reason: 'server_restarting',
                    errorMessage: 'Server restart in progress',
                });
            });

            socket.on(SOCKET_RPC_EVENTS.REQUEST, async (data: { method: string; params: unknown }, callback: (response: unknown) => void) => {
                callback(await deps.getRpcHandlerManager().handleRequest(data));
            });
            socket.on('connect_error', (error) => {
                logger.debug('[API] Socket connection error:', {
                    error: serializeAxiosErrorForLog(error),
                });
            });
            socket.on('update', (data: Update) => deps.handleSessionScopedUpdate(data));
            socket.on('session', () => {});
            socket.on('error', (error) => {
                logger.debug('[API] Socket error:', {
                    error: serializeAxiosErrorForLog(error),
                });
            });
        },

        async listPendingMessageQueueV2LocalIds() {
            const request = () => listPendingQueueV2LocalIdsFromServer({
                token: deps.token,
                sessionId: deps.sessionId,
            });
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
            const request = () => discardPendingQueueV2Messages({
                token: deps.token,
                sessionId: deps.sessionId,
                localIds,
                reason: opts.reason,
            });
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

        async materializeNextPendingMessageSafely(opts: {
            reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
            deliveryTiming?: PendingMaterializationDeliveryTiming;
            expectedRuntimeActivityRevision?: number;
        } = {}) {
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
                await this.reconcilePendingQueueState({ force: true });
            } else if (pendingQueueState.pendingCount <= 0) {
                if (policy === 'force') {
                    await this.reconcilePendingQueueState({ force: true });
                } else if (policy === 'throttled') {
                    await this.reconcilePendingQueueState({ force: false });
                }
            }
            const materializeOpts = {
                deliveryTiming: opts.deliveryTiming,
                expectedRuntimeActivityRevision: opts.expectedRuntimeActivityRevision,
            };
            if (!deps.shouldAttemptPendingMaterialization()) {
                // The gate may be blocked by a stale turn-status snapshot: reconcile (which can
                // self-heal a stale busy gate) before concluding there is nothing to drain.
                const healedTurnStatus = await deps.reconcileTurnStatusBeforePendingMaterialization();
                if (!healedTurnStatus || !deps.shouldAttemptPendingMaterialization()) {
                    deps.logPendingMaterializationSkip?.('materialize_safely_gate');
                    return { type: 'no_pending' };
                }
            } else {
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

import { socketMessageAckCounter, websocketEventsCounter } from "@/app/monitoring/metrics2";
import {
    buildMessageUpdatedUpdate,
    buildNewMessageUpdate,
    buildPendingChangedUpdate,
    buildUpdateSessionUpdate,
    ClientConnection,
    eventRouter,
} from "@/app/events/eventRouter";
import { AsyncLock, isLockAdmissionDeadlineExceededError } from "@/utils/runtime/lock";
import { log } from "@/utils/logging/log";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { Socket } from "socket.io";
import {
    applySessionReadCursorOperation,
    applySessionTurnMutation,
    createSessionMessage,
    updateSessionAgentState,
    updateSessionMetadata,
} from "@/app/session/sessionWriteService";
import {
    mapPendingMaterializationError,
    materializeNextPendingMessageForCurrentPublisherInTx,
} from "@/app/session/pending/pendingMessageService";
import {
    resolvePendingMaterializeDeliveryStateOptIn,
    parsePendingMaterializeDeliveryTiming,
} from "@/app/session/pending/pendingMaterializationRequest";
import { serializePendingMaterializedMessage } from "@/app/session/pending/serializePendingMaterializedMessage";
import { normalizeIncomingSessionMessageContent } from "@/app/session/messageContent/normalizeIncomingSessionMessageContent";
import { parseSessionMessageSidechainId } from "@/app/session/parseSessionMessageSidechainId";
import {
    ACCEPTED_PENDING_SETTLEMENT_EVENT_V1,
    AcceptedPendingSettlementRequestV1Schema,
    AcceptedPendingSettlementResponseV1Schema,
    readPendingLocalId,
    ExecutionRunPublicStateSchema,
    SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT,
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1,
    SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
    isRecoveredHistoryTranscriptObservationProvenance,
    SessionTranscriptObservationV1Schema,
    SessionTurnMutationV1Schema,
} from "@happier-dev/protocol";
import {
    TranscriptStreamSegmentDeltaEphemeralMessageSchema,
    TranscriptStreamSegmentEphemeralMessageSchema,
} from "@happier-dev/protocol/updates";
import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { didSessionActivityBadgeContributionChange } from "@/app/activity/accountActivityBadge";
import { authorizeSessionRelayPublish } from "./sessionRelayAuthCache";
import { publishSessionReadCursorUpdate } from "@/app/session/readCursor/publishSessionReadCursorUpdate";
import { publishSessionTurnUpdate } from "@/app/session/turns/publishSessionTurnUpdate";
import { publishSessionReadyProjectionUpdate } from "@/app/session/ready/publishSessionReadyProjectionUpdate";
import { db } from "@/storage/db";
import type { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { coordinateAcceptedPendingSettlement } from "@/app/session/pending/acceptedPendingSettlementCoordinator";
import {
    isTransactionAcquisitionUnavailableError,
    isTransactionDeadlineExceededError,
} from "@/storage/inTx";

const PENDING_MATERIALIZATION_REQUEST_BUDGET_MS = 9_000;
const PENDING_MATERIALIZATION_RETRY_AFTER_MS = 1_000;

const RELEASED_UI_V0_2_0_DIRECT_USER_MESSAGE_SENT_FROM = new Set(["web", "ios", "android", "mac", "pending_send_now", "retry"]);

// Hoisted stripped-schema instances: `.strip()` builds a new Zod schema object on every call, and
// these run on the 25Hz relay hot path.
const StrippedExecutionRunPublicStateSchema = ExecutionRunPublicStateSchema.strip();
const StrippedTranscriptStreamSegmentSchema = TranscriptStreamSegmentEphemeralMessageSchema.strip();
const StrippedTranscriptStreamSegmentDeltaSchema = TranscriptStreamSegmentDeltaEphemeralMessageSchema.strip();

function shouldLogSocketMessageDiagnostics(): boolean {
    return process.env.HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS === "1"
        || process.env.HAPPY_SOCKET_MESSAGE_DIAGNOSTIC_LOGS === "1";
}

function isReleasedUiV020DirectUserMessagePayload(data: unknown): boolean {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const record = data as Record<string, unknown>;
    if ("messageRole" in record) return false;
    if (readPendingLocalId(record.localId) === null) return false;
    const sentFrom = typeof record.sentFrom === "string" ? record.sentFrom : "";
    if (!RELEASED_UI_V0_2_0_DIRECT_USER_MESSAGE_SENT_FROM.has(sentFrom)) return false;
    if (typeof record.permissionMode !== "string" || record.permissionMode.trim().length === 0) return false;
    if (typeof record.sessionEventType === "string" && record.sessionEventType.trim().length > 0) return false;
    if (typeof record.sidechainId === "string" && record.sidechainId.trim().length > 0) return false;
    return true;
}

function resolveSocketSuppliedMessageRole(data: unknown): unknown {
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    if ("messageRole" in data) return (data as { messageRole?: unknown }).messageRole;
    return undefined;
}

function canMutateSocketSession(connection: ClientConnection, sessionId: string): boolean {
    return connection.connectionType !== "session-scoped" || connection.sessionId === sessionId;
}

function scheduleSessionParticipantBadgeRefresh(params: Parameters<typeof refreshSessionParticipantBadgePushes>[0]): void {
    void refreshSessionParticipantBadgePushes(params).catch((error) => {
        log({ module: "websocket", level: "warn" }, `Error scheduling badge push refresh: ${error}`);
    });
}

type TrustedTranscriptObservationPublisher = Readonly<{
    presence: Pick<ReturnType<typeof createSessionPublisherPresence>, "resolveCurrentPublisher">
        & Partial<Pick<ReturnType<typeof createSessionPublisherPresence>, "runAsCurrentPublisher" | "runAsCurrentPublisherInTx">>;
    binding: Readonly<{ accountId: string; machineId: string; sessionId: string }>;
}>;

export function sessionUpdateHandler(
    userId: string,
    socket: Socket,
    connection: ClientConnection,
    trustedTranscriptObservationPublisher?: TrustedTranscriptObservationPublisher,
) {
    socket.on(SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1, async (data: unknown, callback?: (response: unknown) => void) => {
        try {
        const parsed = data && typeof data === "object" && !Array.isArray(data)
            ? data as Record<string, unknown>
            : null;
        const sessionId = parsed?.v === 1 && typeof parsed.sessionId === "string"
            ? parsed.sessionId
            : null;
        if (!sessionId || !canMutateSocketSession(connection, sessionId)) {
            callback?.({ ok: false, error: "invalid_session" });
            return;
        }
        const authorized = await authorizeSessionRelayPublish({ socket, connection, userId, sessionId });
        if (!authorized || !trustedTranscriptObservationPublisher || trustedTranscriptObservationPublisher.binding.sessionId !== sessionId) {
            callback?.({ ok: false, error: "forbidden" });
            return;
        }
        const publisher = await trustedTranscriptObservationPublisher.presence.resolveCurrentPublisher({
            socket,
            binding: trustedTranscriptObservationPublisher.binding,
        });
        callback?.(publisher.status === "current"
            ? { ok: true, capability: SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1 }
            : { ok: false, error: "forbidden" });
        } catch (error) {
            log({ module: "websocket", level: "warn" }, `Transcript observation capability negotiation failed: ${error}`);
            callback?.({ ok: false, error: "internal" });
        }
    });

    socket.on(SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1, async (data: unknown, callback?: (response: unknown) => void) => {
        try {
        const parsed = SessionTranscriptObservationV1Schema.safeParse(data);
        if (!parsed.success) {
            callback?.({ ok: false, error: "invalid_observation" });
            return;
        }
        const observation = parsed.data;
        const isRecoveredHistory = isRecoveredHistoryTranscriptObservationProvenance(observation.provenance);
        if (!canMutateSocketSession(connection, observation.sessionId)) {
            callback?.({ ok: false, error: "forbidden" });
            return;
        }
        const authorized = await authorizeSessionRelayPublish({
            socket,
            connection,
            userId,
            sessionId: observation.sessionId,
        });
        if (!authorized) {
            callback?.({ ok: false, error: "forbidden" });
            return;
        }
        if (
            !trustedTranscriptObservationPublisher
            || trustedTranscriptObservationPublisher.binding.sessionId !== observation.sessionId
        ) {
            callback?.({ ok: false, error: "forbidden" });
            return;
        }
        const publisher = await trustedTranscriptObservationPublisher.presence.resolveCurrentPublisher({
            socket,
            binding: trustedTranscriptObservationPublisher.binding,
        });
        if (publisher.status !== "current") {
            callback?.({ ok: false, error: "forbidden" });
            return;
        }

        const result = typeof observation.content === "string"
            ? await createSessionMessage({
                actorUserId: userId,
                sessionId: observation.sessionId,
                ciphertext: observation.content,
                localId: observation.localId,
                sidechainId: observation.sidechainId,
                messageRole: observation.messageRole,
                trustedPublisherFence: {
                    ...trustedTranscriptObservationPublisher.binding,
                    committedFence: publisher.committedFence,
                },
                trustedSourceTimestamps: { createdAt: observation.createdAt, updatedAt: observation.updatedAt },
                trustedTranscriptObservationProvenance: observation.provenance,
                ...(isRecoveredHistory
                    ? { trustedAttentionImpact: SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT }
                    : {}),
                ...(observation.sessionEventType && !isRecoveredHistory
                    ? { trustedSessionEventType: observation.sessionEventType }
                    : {}),
            })
            : await createSessionMessage({
                actorUserId: userId,
                sessionId: observation.sessionId,
                content: observation.content,
                localId: observation.localId,
                sidechainId: observation.sidechainId,
                messageRole: observation.messageRole,
                trustedPublisherFence: {
                    ...trustedTranscriptObservationPublisher.binding,
                    committedFence: publisher.committedFence,
                },
                trustedSourceTimestamps: { createdAt: observation.createdAt, updatedAt: observation.updatedAt },
                trustedTranscriptObservationProvenance: observation.provenance,
                ...(isRecoveredHistory
                    ? { trustedAttentionImpact: SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT }
                    : {}),
                ...(observation.sessionEventType && !isRecoveredHistory
                    ? { trustedSessionEventType: observation.sessionEventType }
                    : {}),
            });
        if (!result.ok) {
            callback?.({ ok: false, error: result.error === "forbidden" ? "forbidden" : result.error === "internal" ? "internal" : "invalid_observation" });
            return;
        }

        callback?.({
            ok: true,
            status: "observed",
            id: result.message.id,
            seq: result.message.seq,
            localId: result.message.localId,
            didWrite: result.didWrite,
            ...(result.didUpdate ? { didUpdate: true } : {}),
            ingestedAt: Date.now(),
        });

        if (!result.didWrite && !result.didUpdate) return;
        await Promise.all(result.participantCursors.map(async ({ accountId: participantUserId, cursor }) => {
            const options = result.attentionImpact ? { attentionImpact: result.attentionImpact } : undefined;
            const payload = result.didWrite
                ? (options
                    ? buildNewMessageUpdate(result.message, observation.sessionId, cursor, randomKeyNaked(12), options)
                    : buildNewMessageUpdate(result.message, observation.sessionId, cursor, randomKeyNaked(12)))
                : (options
                    ? buildMessageUpdatedUpdate(result.message, observation.sessionId, cursor, randomKeyNaked(12), options)
                    : buildMessageUpdatedUpdate(result.message, observation.sessionId, cursor, randomKeyNaked(12)));
            eventRouter.emitUpdate({
                userId: participantUserId,
                payload,
                recipientFilter: { type: "all-interested-in-session", sessionId: observation.sessionId },
            });
        }));
        if (result.didWrite) {
            await publishSessionReadyProjectionUpdate({
                sessionId: observation.sessionId,
                readyProjection: result.readyProjection,
            });
        }
        scheduleSessionParticipantBadgeRefresh({
            badgeAttentionChanged: result.badgeAttentionChanged,
            participantCursors: result.participantCursors,
        });
        } catch (error) {
            log({ module: "websocket", level: "warn" }, `Transcript observation failed: ${error}`);
            callback?.({ ok: false, error: "internal" });
        }
    });

    socket.on('update-metadata', async (data: any, callback: (response: any) => void) => {
        try {
            const { sid, metadata, expectedVersion } = data;
            const dataRecord = data && typeof data === "object" ? data as Record<string, unknown> : null;
            const readCursorHintV1Raw = dataRecord?.readCursorHintV1;
            const readCursorHintV1 = readCursorHintV1Raw && typeof readCursorHintV1Raw === "object"
                ? readCursorHintV1Raw as Record<string, unknown>
                : null;
            const lastViewedSessionSeqHint =
                typeof readCursorHintV1?.lastViewedSessionSeq === "number" && Number.isFinite(readCursorHintV1.lastViewedSessionSeq)
                    ? Math.max(0, Math.floor(readCursorHintV1.lastViewedSessionSeq))
                    : null;

            // Validate input
            if (!sid || typeof metadata !== 'string' || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }

            if (!canMutateSocketSession(connection, sid)) {
                callback?.({ result: 'forbidden' });
                return;
            }

            const result = await updateSessionMetadata({
                actorUserId: userId,
                sessionId: sid,
                expectedVersion,
                metadataCiphertext: metadata,
                ...(typeof lastViewedSessionSeqHint === "number"
                    ? { readCursorHintV1: { lastViewedSessionSeq: lastViewedSessionSeqHint } }
                    : {}),
            });

            if (!result.ok) {
                if (result.error === 'forbidden') {
                    callback?.({ result: 'forbidden' });
                    return;
                }
                if (result.error === 'version-mismatch') {
                    if (!result.current) {
                        log({ module: 'websocket', level: 'error' }, `update-metadata version-mismatch without current state (sid=${sid})`);
                        callback?.({ result: 'error' });
                        return;
                    }
                    callback?.({ result: 'version-mismatch', version: result.current.version, metadata: result.current.metadata });
                    return;
                }
                callback?.({ result: 'error' });
                return;
            }

            const metadataUpdate = { value: result.metadata, version: result.version };
            await Promise.all(result.participantCursors.map(async ({ accountId, cursor }) => {
                const payload = buildUpdateSessionUpdate(
                    sid,
                    cursor,
                    randomKeyNaked(12),
                    metadataUpdate,
                    undefined,
                    typeof result.lastViewedSessionSeq === 'number'
                        ? { lastViewedSessionSeq: result.lastViewedSessionSeq }
                        : undefined,
                );
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                    skipSenderConnection: accountId === userId ? connection : undefined,
                });
            }));
            scheduleSessionParticipantBadgeRefresh({
                badgeAttentionChanged: result.badgeAttentionChanged,
                participantCursors: result.participantCursors,
            });

            callback?.({ result: 'success', version: result.version, metadata: result.metadata });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in update-metadata: ${error}`);
            if (callback) {
                callback({ result: 'error' });
            }
        }
    });

    socket.on('update-state', async (data: any, callback: (response: any) => void) => {
        try {
            const { sid, agentState, expectedVersion } = data;
            const dataRecord = data && typeof data === "object" ? data as Record<string, unknown> : null;
            const activitySummaryV1Raw = dataRecord?.activitySummaryV1;
            const activitySummaryV1 = activitySummaryV1Raw && typeof activitySummaryV1Raw === "object"
                ? activitySummaryV1Raw as Record<string, unknown>
                : null;
            const pendingPermissionRequestCount =
                typeof activitySummaryV1?.pendingPermissionRequestCount === "number" && Number.isFinite(activitySummaryV1.pendingPermissionRequestCount)
                    ? Math.max(0, Math.floor(activitySummaryV1.pendingPermissionRequestCount))
                    : undefined;
            const pendingUserActionRequestCount =
                typeof activitySummaryV1?.pendingUserActionRequestCount === "number" && Number.isFinite(activitySummaryV1.pendingUserActionRequestCount)
                    ? Math.max(0, Math.floor(activitySummaryV1.pendingUserActionRequestCount))
                    : undefined;
            // Validate input
            if (!sid || (typeof agentState !== 'string' && agentState !== null) || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }

            if (!canMutateSocketSession(connection, sid)) {
                callback?.({ result: 'forbidden' });
                return;
            }

            const result = await updateSessionAgentState({
                actorUserId: userId,
                sessionId: sid,
                expectedVersion,
                agentStateCiphertext: agentState,
                ...(typeof pendingPermissionRequestCount === "number" ? { pendingPermissionRequestCount } : {}),
                ...(typeof pendingUserActionRequestCount === "number" ? { pendingUserActionRequestCount } : {}),
            });

            if (!result.ok) {
                if (result.error === 'forbidden') {
                    callback?.({ result: 'forbidden' });
                    return;
                }
                if (result.error === 'version-mismatch') {
                    if (!result.current) {
                        log({ module: 'websocket', level: 'error' }, `update-state version-mismatch without current state (sid=${sid})`);
                        callback?.({ result: 'error' });
                        return;
                    }
                    callback?.({ result: 'version-mismatch', version: result.current.version, agentState: result.current.agentState });
                    return;
                }
                callback?.({ result: 'error' });
                return;
            }

            const agentStateUpdate = { value: result.agentState, version: result.version };
            await Promise.all(result.participantCursors.map(async ({ accountId, cursor }) => {
                const payload = buildUpdateSessionUpdate(
                    sid,
                    cursor,
                    randomKeyNaked(12),
                    undefined,
                    agentStateUpdate,
                    (
                        typeof result.pendingPermissionRequestCount === 'number'
                        || typeof result.pendingUserActionRequestCount === 'number'
                        || result.pendingRequestObservedAt !== undefined
                    )
                        ? {
                            ...(typeof result.pendingPermissionRequestCount === 'number'
                                ? { pendingPermissionRequestCount: result.pendingPermissionRequestCount }
                                : {}),
                            ...(typeof result.pendingUserActionRequestCount === 'number'
                                ? { pendingUserActionRequestCount: result.pendingUserActionRequestCount }
                                : {}),
                            ...(result.pendingRequestObservedAt !== undefined
                                ? { pendingRequestObservedAt: result.pendingRequestObservedAt }
                                : {}),
                        }
                        : undefined,
                );
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                    skipSenderConnection: accountId === userId ? connection : undefined,
                });
            }));
            scheduleSessionParticipantBadgeRefresh({
                badgeAttentionChanged: result.badgeAttentionChanged,
                participantCursors: result.participantCursors,
            });

            callback?.({ result: 'success', version: result.version, agentState: result.agentState });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in update-state: ${error}`);
            if (callback) {
                callback({ result: 'error' });
            }
        }
    });

    socket.on("session-turn-mutation", async (data: unknown, callback: (response: any) => void) => {
        try {
            const parsed = SessionTurnMutationV1Schema.safeParse(data);
            if (!parsed.success) {
                callback?.({ result: "error" });
                return;
            }

            if (!canMutateSocketSession(connection, parsed.data.sessionId)) {
                callback?.({ result: "forbidden" });
                return;
            }

            const result = await applySessionTurnMutation({
                actorUserId: userId,
                mutation: parsed.data,
            });

            if (!result.ok) {
                if (result.error === "forbidden") {
                    callback?.({ result: "forbidden" });
                    return;
                }
                if (result.error === "session-not-found") {
                    callback?.({ result: "not-found" });
                    return;
                }
                callback?.({ result: "error" });
                return;
            }

            await publishSessionTurnUpdate({
                sessionId: parsed.data.sessionId,
                actorUserId: userId,
                connection,
                result,
            });
            callback?.({
                result: "success",
                applied: result.didApply,
                ...(result.reason ? { reason: result.reason } : {}),
                receipt: result.receipt,
            });
        } catch (error) {
            log({ module: "websocket", level: "error" }, `Error in session-turn-mutation: ${error}`);
            callback?.({ result: "error" });
        }
    });
    socket.on('update-read-cursor', async (data: any, callback: (response: any) => void) => {
        try {
            const sid = typeof data?.sid === 'string' ? data.sid : '';
            const operationRaw = data?.operation;
            const hasOperation = operationRaw !== undefined;
            const manualOperation =
                operationRaw === "mark-read" || operationRaw === "mark-unread"
                    ? { kind: operationRaw }
                    : null;
            const lastViewedSessionSeq =
                !hasOperation && typeof data?.lastViewedSessionSeq === 'number' && Number.isFinite(data.lastViewedSessionSeq)
                    ? Math.max(0, Math.floor(data.lastViewedSessionSeq))
                    : null;

            if (!sid || (hasOperation && !manualOperation) || (!manualOperation && typeof lastViewedSessionSeq !== "number")) {
                callback?.({ result: 'error' });
                return;
            }

            if (!canMutateSocketSession(connection, sid)) {
                callback?.({ result: 'forbidden' });
                return;
            }

            const operation = (() => {
                if (manualOperation) {
                    return manualOperation;
                }
                if (typeof lastViewedSessionSeq !== "number") {
                    return null;
                }
                return { kind: "advance" as const, lastViewedSessionSeq };
            })();
            if (!operation) {
                callback?.({ result: 'error' });
                return;
            }
            const result = await applySessionReadCursorOperation({
                actorUserId: userId,
                sessionId: sid,
                operation,
            });

            if (!result.ok) {
                if (result.error === 'forbidden') {
                    callback?.({ result: 'forbidden' });
                    return;
                }
                callback?.({ result: 'error' });
                return;
            }

            await publishSessionReadCursorUpdate({
                sessionId: sid,
                lastViewedSessionSeq: result.lastViewedSessionSeq,
                badgeAttentionChanged: result.badgeAttentionChanged,
                participantCursors: result.participantCursors,
                skipSenderConnection: connection,
                skipSenderAccountId: userId,
            });

            callback?.({
                result: 'success',
                ...(typeof result.lastViewedSessionSeq === "number" ? { lastViewedSessionSeq: result.lastViewedSessionSeq } : {}),
                ...(manualOperation ? { didChange: result.didChange, readState: result.readState } : {}),
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in update-read-cursor: ${error}`);
            callback?.({ result: 'error' });
        }
    });
    socket.on('execution-run-updated', async (data: any) => {
        try {
            websocketEventsCounter.inc({ event_type: 'execution-run-updated' });

            const sid = typeof data?.sid === 'string' ? String(data.sid).trim() : '';
            const runRaw = data?.run;
            if (!sid) return;

            const participantUserIds = await authorizeSessionRelayPublish({
                socket,
                connection,
                userId,
                sessionId: sid,
            });
            if (!participantUserIds) return;

            // Strip unknown fields before rebroadcasting (clients treat this as a hint; keep the payload tight).
            const parsedRun = StrippedExecutionRunPublicStateSchema.safeParse(runRaw);
            if (!parsedRun.success) {
                return;
            }

            const payload = {
                type: 'execution-run-updated' as const,
                sessionId: sid,
                run: parsedRun.data,
            };

            // Broadcast to all participants. Execution runs are a UI optimization; clients must still treat this as a hint.
            for (const participantUserId of participantUserIds) {
                eventRouter.emitEphemeral({
                    userId: participantUserId,
                    payload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                    skipSenderConnection: participantUserId === userId ? connection : undefined,
                });
            }
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in execution-run-updated handler: ${error}`);
        }
    });

    socket.on('transcript-stream-segment', async (data: any) => {
        try {
            websocketEventsCounter.inc({ event_type: 'transcript-stream-segment' });

            const sid = typeof data?.sid === 'string' ? String(data.sid).trim() : '';
            if (!sid) return;

            const participantUserIds = await authorizeSessionRelayPublish({
                socket,
                connection,
                userId,
                sessionId: sid,
            });
            if (!participantUserIds) return;

            const parsedMessage = StrippedTranscriptStreamSegmentSchema.safeParse(data?.message);
            if (!parsedMessage.success) {
                return;
            }

            const payload = {
                type: 'transcript-stream-segment' as const,
                sessionId: sid,
                message: parsedMessage.data,
            };

            for (const participantUserId of participantUserIds) {
                eventRouter.emitEphemeral({
                    userId: participantUserId,
                    payload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                    skipSenderConnection: participantUserId === userId ? connection : undefined,
                });
            }
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in transcript-stream-segment handler: ${error}`);
        }
    });

    socket.on('transcript-stream-segment-delta', async (data: any) => {
        try {
            websocketEventsCounter.inc({ event_type: 'transcript-stream-segment-delta' });

            const sid = typeof data?.sid === 'string' ? String(data.sid).trim() : '';
            if (!sid) return;

            const participantUserIds = await authorizeSessionRelayPublish({
                socket,
                connection,
                userId,
                sessionId: sid,
            });
            if (!participantUserIds) return;

            const parsedMessage = StrippedTranscriptStreamSegmentDeltaSchema.safeParse(data?.message);
            if (!parsedMessage.success) {
                return;
            }

            const payload = {
                type: 'transcript-stream-segment-delta' as const,
                sessionId: sid,
                message: parsedMessage.data,
            };

            for (const participantUserId of participantUserIds) {
                eventRouter.emitEphemeral({
                    userId: participantUserId,
                    payload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                    skipSenderConnection: participantUserId === userId ? connection : undefined,
                });
            }
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in transcript-stream-segment-delta handler: ${error}`);
        }
    });

    const receiveMessageLock = new AsyncLock();
    socket.on('message', async (data: any, callback?: (response: any) => void) => {
        await receiveMessageLock.inLock(async () => {
            const respond = (response: any) => {
                if (typeof callback === 'function') {
                    callback(response);
                }
            };

            try {
                websocketEventsCounter.inc({ event_type: 'message' });
                const sid = typeof data?.sid === 'string' ? data.sid : null;
                const content = normalizeIncomingSessionMessageContent(data?.message);
                const localId = typeof data?.localId === 'string' ? data.localId : null;
                const trustedSessionEventType = data?.sessionEventType === 'ready' ? 'ready' : undefined;
                const echoToSender = data?.echoToSender === true;
                const parsedSidechainId = parseSessionMessageSidechainId(data?.sidechainId, { emptyString: "invalid" });
                if (!parsedSidechainId.ok) {
                    socketMessageAckCounter.inc({ result: 'error', error: 'invalid-params' });
                    respond({ ok: false, error: 'invalid-params' });
                    return;
                }
                const sidechainId = parsedSidechainId.sidechainId;

                if (!sid || sid.trim().length === 0 || !content) {
                    socketMessageAckCounter.inc({ result: 'error', error: 'invalid-params' });
                    respond({ ok: false, error: 'invalid-params' });
                    return;
                }

                if (!canMutateSocketSession(connection, sid)) {
                    socketMessageAckCounter.inc({ result: 'error', error: 'forbidden' });
                    respond({ ok: false, error: 'forbidden' });
                    return;
                }

                // Immutable old UIs wrote user prompts directly to the transcript. The Pending
                // Queue is now the only user-input ingress, so reject this exact release-proven shape
                // before any transcript or provider-visible effect.
                if (isReleasedUiV020DirectUserMessagePayload(data)) {
                    socketMessageAckCounter.inc({ result: 'error', error: 'client-upgrade-required' });
                    respond({ ok: false, error: 'client-upgrade-required' });
                    return;
                }

                const messageRole = resolveSocketSuppliedMessageRole(data);

                if (shouldLogSocketMessageDiagnostics()) {
                    const loggedLength = (() => {
                        if (content.t === "encrypted") return content.c.length;
                        try {
                            return JSON.stringify(content.v ?? null).length;
                        } catch {
                            return 0;
                        }
                    })();
                    log(
                        { module: 'websocket' },
                        `Received message from socket ${socket.id}: sessionId=${sid}, messageLength=${loggedLength} bytes, connectionType=${connection.connectionType}, connectionSessionId=${connection.connectionType === 'session-scoped' ? connection.sessionId : 'N/A'}`
                    );
                }

                const result = await createSessionMessage({
                    actorUserId: userId,
                    sessionId: sid,
                    content,
                    localId,
                    sidechainId,
                    messageRole,
                    ...(trustedSessionEventType ? { trustedSessionEventType } : {}),
                });

                if (!result.ok) {
                    socketMessageAckCounter.inc({ result: 'error', error: result.error });
                    respond({ ok: false, error: result.error });
                    return;
                }

                socketMessageAckCounter.inc({ result: 'ok', error: 'none' });
                respond({
                    ok: true,
                    id: result.message.id,
                    seq: result.message.seq,
                    localId: result.message.localId,
                    didWrite: result.didWrite,
                    ...(result.didUpdate ? { didUpdate: true } : {}),
                });

                if (!result.didWrite && !result.didUpdate) {
                    return;
                }

                await Promise.all(result.participantCursors.map(async ({ accountId: participantUserId, cursor }) => {
                    const options = result.attentionImpact ? { attentionImpact: result.attentionImpact } : undefined;
                    const payload = result.didWrite
                        ? (
                            options
                                ? buildNewMessageUpdate(result.message, sid, cursor, randomKeyNaked(12), options)
                                : buildNewMessageUpdate(result.message, sid, cursor, randomKeyNaked(12))
                        )
                        : (
                            options
                                ? buildMessageUpdatedUpdate(result.message, sid, cursor, randomKeyNaked(12), options)
                                : buildMessageUpdatedUpdate(result.message, sid, cursor, randomKeyNaked(12))
                        );
                    eventRouter.emitUpdate({
                        userId: participantUserId,
                        payload,
                        recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                        skipSenderConnection: participantUserId === userId && !echoToSender ? connection : undefined,
                    });
                }));
                if (result.didWrite) {
                    await publishSessionReadyProjectionUpdate({
                        sessionId: sid,
                        readyProjection: result.readyProjection,
                        skipSenderAccountId: userId,
                        skipSenderConnection: echoToSender ? undefined : connection,
                    });
                }
                scheduleSessionParticipantBadgeRefresh({
                    badgeAttentionChanged: result.badgeAttentionChanged,
                    participantCursors: result.participantCursors,
                });
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in message handler: ${error}`);
                socketMessageAckCounter.inc({ result: 'error', error: 'internal' });
                respond({ ok: false, error: 'internal' });
            }
        });
    });

    socket.on(ACCEPTED_PENDING_SETTLEMENT_EVENT_V1, async (data: unknown, callback?: (response: unknown) => void) => {
        await receiveMessageLock.inLock(async () => {
            const respond = (response: unknown) => {
                callback?.(AcceptedPendingSettlementResponseV1Schema.parse(response));
            };
            const parsed = AcceptedPendingSettlementRequestV1Schema.safeParse(data);
            if (!parsed.success || !canMutateSocketSession(connection, parsed.data.sessionId)) {
                respond({ ok: false, error: "invalid-params" });
                return;
            }
            const { sessionId, localId } = parsed.data;
            const trusted = trustedTranscriptObservationPublisher;
            if (
                connection.connectionType !== "session-scoped"
                || !trusted
                || !trusted.presence.runAsCurrentPublisher
                || trusted.binding.accountId !== userId
                || trusted.binding.sessionId !== sessionId
                || !await authorizeSessionRelayPublish({ socket, connection, userId, sessionId })
            ) {
                respond({ ok: false, error: "forbidden" });
                return;
            }
            const current = await trusted.presence.runAsCurrentPublisher({
                socket,
                binding: trusted.binding,
                action: async (publisher) => await coordinateAcceptedPendingSettlement({
                    actorUserId: userId,
                    sessionId,
                    localId,
                    trustedPublisherFence: {
                        ...trusted.binding,
                        committedFence: publisher.committedFence,
                    },
                }),
            });
            if (current.status !== "current") {
                respond({ ok: false, error: "forbidden" });
                return;
            }
            const result = current.value;
            if (!result.ok) {
                respond({
                    ok: false,
                    error: result.error,
                    ...(result.error === "transaction-unavailable" ? { retryAfterMs: result.retryAfterMs } : {}),
                    ...(result.error === "transaction-unavailable" && result.correlationId
                        ? { correlationId: result.correlationId }
                        : {}),
                });
                return;
            }
            respond({
                ok: true,
                didResolve: result.didResolve,
                pendingCount: result.pendingCount,
                pendingBlockedCount: result.pendingBlockedCount,
                pendingVersion: result.pendingVersion,
                ...(result.message ? { message: serializePendingMaterializedMessage(result.message) } : {}),
            });
        });
    });

    socket.on('pending-materialize-next', async (data: any, callback?: (response: any) => void) => {
        const respond = (response: any) => {
            if (typeof callback === 'function') {
                callback(response);
            }
        };
        const deadlineAtMs = Date.now() + PENDING_MATERIALIZATION_REQUEST_BUDGET_MS;
        try {
            await receiveMessageLock.inLock(async () => {
            try {
                const sid = typeof data?.sid === 'string' ? data.sid : null;
                if (!sid) {
                    respond({ ok: false, error: 'invalid-params' });
                    return;
                }

                if (!canMutateSocketSession(connection, sid)) {
                    respond({ ok: false, error: 'invalid-params' });
                    return;
                }

                const expectedPendingVersion = typeof data?.expectedPendingVersion === 'number'
                    && Number.isSafeInteger(data.expectedPendingVersion)
                    && data.expectedPendingVersion >= 0
                    ? data.expectedPendingVersion
                    : undefined;
                const deliveryState = resolvePendingMaterializeDeliveryStateOptIn(data);
                if (deliveryState !== "provider") {
                    respond({ ok: false, error: "forbidden" });
                    return;
                }
                const deliveryTimingParseResult = parsePendingMaterializeDeliveryTiming(data);
                const foregroundState = data?.foregroundState;
                const expectedRuntimeActivityRevision = typeof data?.expectedRuntimeActivityRevision === "number"
                    && Number.isSafeInteger(data.expectedRuntimeActivityRevision)
                    && data.expectedRuntimeActivityRevision >= 0
                    ? data.expectedRuntimeActivityRevision
                    : undefined;
                if (deliveryTimingParseResult.status !== "valid") {
                    respond({ ok: false, error: 'invalid-params' });
                    return;
                }
                const deliveryTiming = deliveryTimingParseResult.value;
                if (
                    foregroundState !== "ready"
                    && foregroundState !== "active_steerable"
                    && foregroundState !== "active_unsteerable"
                ) {
                    respond({ ok: false, error: 'invalid-params' });
                    return;
                }
                const commonMaterializeParams = {
                    actorUserId: userId,
                    sessionId: sid,
                    ...(expectedPendingVersion !== undefined ? { expectedPendingVersion } : {}),
                    deliveryTiming,
                    foregroundState,
                    ...(expectedRuntimeActivityRevision !== undefined ? { expectedRuntimeActivityRevision } : {}),
                };
                const trusted = trustedTranscriptObservationPublisher;
                if (
                    connection.connectionType !== "session-scoped"
                    || !trusted
                    || !trusted.presence.runAsCurrentPublisherInTx
                    || trusted.binding.accountId !== userId
                    || trusted.binding.sessionId !== sid
                ) {
                    respond({ ok: false, error: "forbidden" });
                    return;
                }
                const current = await trusted.presence.runAsCurrentPublisherInTx({
                    socket,
                    binding: trusted.binding,
                    deadlineAtMs,
                    action: async (publisher, tx) => await materializeNextPendingMessageForCurrentPublisherInTx({
                        ...commonMaterializeParams,
                        tx,
                        trustedPublisherFence: {
                            ...trusted.binding,
                            committedFence: publisher.committedFence,
                        },
                    }),
                });
                if (current.status !== "current") {
                    respond({ ok: false, error: "forbidden" });
                    return;
                }
                const result = current.value;

                if (!result.ok) {
                    respond({
                        ok: false,
                        error: result.error,
                        ...(result.error === "transaction-unavailable" ? { retryAfterMs: result.retryAfterMs } : {}),
                    });
                    return;
                }

                if (!result.didMaterialize) {
                    const response = {
                        ok: true,
                        didMaterialize: false,
                        pendingCount: result.pendingCount,
                        pendingBlockedCount: result.pendingBlockedCount,
                        pendingVersion: result.pendingVersion,
                        ...(result.deliveryState ? { deliveryState: result.deliveryState } : {}),
                        ...(result.deferredReason ? { deferredReason: result.deferredReason } : {}),
                        ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
                    };
                    respond(response);
                    if (result.pendingStateChanged === true) {
                        const participantCursorsPending = result.participantCursorsPending ?? [];
                        await Promise.all(
                            participantCursorsPending.map(async ({ accountId, cursor }) => {
                                const payload = buildPendingChangedUpdate(
                                    {
                                        sessionId: sid,
                                        pendingCount: result.pendingCount,
                                        pendingBlockedCount: result.pendingBlockedCount,
                                        pendingVersion: result.pendingVersion,
                                        changedByAccountId: userId,
                                    },
                                    cursor,
                                    randomKeyNaked(12),
                                );
                                eventRouter.emitUpdate({
                                    userId: accountId,
                                    payload,
                                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                                });
                            }),
                        );
                        scheduleSessionParticipantBadgeRefresh({
                            badgeAttentionChanged: result.badgeAttentionChanged ?? false,
                            participantCursors: participantCursorsPending,
                        });
                    }
                    return;
                }

                respond({
                    ok: true,
                    didMaterialize: true,
                    didWrite: result.didWriteMessage,
                    pendingCount: result.pendingCount,
                    pendingBlockedCount: result.pendingBlockedCount,
                    pendingVersion: result.pendingVersion,
                    ...(result.deliveryState ? { deliveryState: result.deliveryState } : {}),
                    message: serializePendingMaterializedMessage(result.message),
                });

                await Promise.all(
                    result.participantCursorsPending.map(async ({ accountId, cursor }) => {
                        const payload = buildPendingChangedUpdate(
                            {
                                sessionId: sid,
                                pendingCount: result.pendingCount,
                                pendingBlockedCount: result.pendingBlockedCount,
                                pendingVersion: result.pendingVersion,
                                changedByAccountId: userId,
                            },
                            cursor,
                            randomKeyNaked(12),
                        );
                        eventRouter.emitUpdate({
                            userId: accountId,
                            payload,
                            recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                        });
                    }),
                );
                scheduleSessionParticipantBadgeRefresh({
                    badgeAttentionChanged: result.badgeAttentionChanged,
                    participantCursors: result.participantCursorsPending,
                });
            } catch (error) {
                if (
                    isLockAdmissionDeadlineExceededError(error)
                    || isTransactionDeadlineExceededError(error)
                    || isTransactionAcquisitionUnavailableError(error)
                ) {
                    throw error;
                }
                log({ module: 'websocket', level: 'error' }, `Error in pending-materialize-next: ${error}`);
                const failure = mapPendingMaterializationError(error);
                respond({
                    ok: false,
                    error: failure.ok ? "internal" : failure.error,
                    ...(!failure.ok && failure.error === "transaction-unavailable"
                        ? { retryAfterMs: failure.retryAfterMs }
                        : {}),
                });
            }
            }, { deadlineAtMs });
        } catch (error) {
            if (
                isLockAdmissionDeadlineExceededError(error)
                || isTransactionDeadlineExceededError(error)
                || isTransactionAcquisitionUnavailableError(error)
            ) {
                respond({
                    ok: false,
                    error: "transaction-unavailable",
                    retryAfterMs: PENDING_MATERIALIZATION_RETRY_AFTER_MS,
                });
                return;
            }
            log({ module: 'websocket', level: 'error' }, `Error admitting pending-materialize-next: ${error}`);
            respond({ ok: false, error: 'internal' });
        }
    });

}

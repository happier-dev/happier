import { sessionAliveEventsCounter, socketMessageAckCounter, websocketEventsCounter } from "@/app/monitoring/metrics/index";
import {
    buildMessageUpdatedUpdate,
    buildNewMessageUpdate,
    buildPendingResolvedMessageUpdate,
    buildPendingChangedUpdate,
    buildSessionActivityEphemeral,
    buildUpdateSessionUpdate,
    ClientConnection,
    eventRouter,
} from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { AsyncLock, isLockAdmissionDeadlineExceededError } from "@/utils/runtime/lock";
import { debug, error as logError, log } from "@/utils/logging/log";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { Socket } from "socket.io";
import {
    applySessionTurnMutation,
    applySessionReadCursorOperation,
    createSessionMessage,
    updateSessionAgentState,
    updateSessionMetadata,
} from "@/app/session/sessionWriteService";
import { publishSessionReadyProjectionUpdate } from "@/app/session/ready/publishSessionReadyProjectionUpdate";
import { publishSessionTurnMutationUpdate } from "@/app/session/turns/publishSessionTurnMutationUpdate";
import { publishSessionReadCursorUpdate } from "@/app/session/readCursor/publishSessionReadCursorUpdate";
import { recordSessionAlive } from "@/app/presence/presenceRecorder";
import {
    mapPendingMaterializationError,
    materializeNextPendingMessageInTx,
    readSessionPendingState,
    resolveAcceptedPendingDelivery,
    settlePendingInputAdmission,
    type ResolveAcceptedPendingDeliveryResult,
    type SettlePendingInputAdmissionResult,
} from "@/app/session/pending/pendingMessageService";
import { serializePendingMaterializedMessage } from "@/app/session/pending/serializePendingMaterializedMessage";
import { normalizeIncomingSessionMessageContent } from "@/app/session/messageContent/normalizeIncomingSessionMessageContent";
import { checkSessionAccess, requireAccessLevel } from "@/app/share/accessControl";
import { getSessionParticipantUserIds } from "@/app/share/sessionParticipants";
import { parseSessionMessageSidechainId } from "@/app/session/parseSessionMessageSidechainId";
import {
    ACCEPTED_PENDING_SETTLEMENT_EVENT_V1,
    AcceptedPendingSettlementRequestV1Schema,
    AcceptedPendingSettlementResponseV1Schema,
    ExecutionRunPublicStateSchema,
    isRecoveredHistoryTranscriptObservationProvenance,
    PrimaryTurnStatusV1Schema,
    parseSessionRuntimeActivityProjectionFields,
    isSessionAgentTransitionDividerLocalId,
    readPendingLocalId,
    SessionMessageRoleSchema,
    SESSION_PUBLISHER_AUTHORITY_CHECK_EVENT,
    SessionTurnMutationV1Schema,
    SessionPublisherAuthorityCheckAckSchema,
    SessionPublisherAuthorityCheckRequestSchema,
    SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT,
    SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1,
    SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT,
    SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT,
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1,
    SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
    SessionTranscriptObservationAckV1Schema,
    SessionTranscriptObservationCapabilityAckV1Schema,
    SessionTranscriptObservationV1Schema,
    SessionRuntimeActivityCloseAckSchema,
    SessionRuntimeActivityCloseRequestSchema,
    SessionRuntimeActivitySnapshotAckSchema,
    SessionRuntimeActivitySnapshotRequestSchema,
    SessionPendingAdmissionSettlementRequestV1Schema,
    SessionPendingAdmissionSettlementResponseV1Schema,
} from "@happier-dev/protocol";
import { TranscriptStreamSegmentDeltaEphemeralMessageSchema, TranscriptStreamSegmentEphemeralMessageSchema } from "@happier-dev/protocol/updates";
import type { SessionEndAckResponse } from "@happier-dev/protocol/updates";
import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { didSessionActivityBadgeContributionChange } from "@/app/activity/accountActivityBadge";
import { canPublishFromSessionScopedSocket, canTargetSessionFromSocket } from "./sessionScopedBinding";
import type { createSessionPublisherPresence, SessionPublisherBinding } from "@/app/presence/sessionPublisherPresence";
import { publishSessionPublisherClose } from "@/app/presence/publishSessionPublisherClose";
import {
    loadSessionTranscriptPublicationRecipientProjection,
    projectSessionTranscriptPublicationPendingProjection,
    projectSessionTranscriptPublicationRealtimeProjection,
    projectSessionTranscriptPublicationUnanchoredProjection,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import {
    isTransactionAcquisitionUnavailableError,
    isTransactionDeadlineExceededError,
} from "@/storage/inTx";

function scheduleSessionParticipantBadgeRefresh(params: Parameters<typeof refreshSessionParticipantBadgePushes>[0]): void {
    void refreshSessionParticipantBadgePushes(params).catch((error) => {
        log({ module: 'websocket', level: 'error' }, `Error in session badge refresh: ${error}`);
    });
}

const RELEASED_UI_V0_2_0_DIRECT_USER_MESSAGE_SENT_FROM = new Set(["web", "ios", "android", "mac", "pending_send_now", "retry"]);
const PENDING_MATERIALIZATION_REQUEST_BUDGET_MS = 9_000;
const PENDING_MATERIALIZATION_RETRY_AFTER_MS = 1_000;
const ExecutionRunPublicStateSocketSchema = ExecutionRunPublicStateSchema.strip();
const TranscriptStreamSegmentEphemeralSocketMessageSchema = TranscriptStreamSegmentEphemeralMessageSchema.strip();
const TranscriptStreamSegmentDeltaEphemeralSocketMessageSchema = TranscriptStreamSegmentDeltaEphemeralMessageSchema.strip();

function shouldLogSocketMessageDiagnostics(): boolean {
    return process.env.HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS === "1"
        || process.env.HAPPY_SOCKET_MESSAGE_DIAGNOSTIC_LOGS === "1";
}

function isReleasedUiV020DirectUserMessagePayload(data: unknown): boolean {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const record = data as Record<string, unknown>;
    if (readPendingLocalId(record.localId) === null) return false;
    if ("messageRole" in record) return false;
    const sentFrom = typeof record.sentFrom === "string" ? record.sentFrom : "";
    if (!RELEASED_UI_V0_2_0_DIRECT_USER_MESSAGE_SENT_FROM.has(sentFrom)) return false;
    if (typeof record.permissionMode !== "string" || record.permissionMode.trim().length === 0) return false;
    if (typeof record.sessionEventType === "string" && record.sessionEventType.trim().length > 0) return false;
    if (typeof record.sidechainId === "string" && record.sidechainId.trim().length > 0) return false;
    return true;
}

function resolveSocketSuppliedMessageRole(data: unknown): unknown {
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    return "messageRole" in data ? (data as { messageRole?: unknown }).messageRole : undefined;
}

function readSocketPayloadRecordField(data: unknown, field: string): Readonly<Record<string, unknown>> | null {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const value = (data as Record<string, unknown>)[field];
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

type SessionEndSocketPayload = Readonly<{
    sid?: unknown;
    time?: unknown;
}>;

function readExpectedRuntimeActivityRevision(data: unknown): number | null {
    if (!data || typeof data !== 'object') return null;
    const revision = (data as Record<string, unknown>).expectedRuntimeActivityRevision;
    return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
        ? revision
        : null;
}

function resolvePendingMaterializeDeliveryStateOptIn(data: unknown): "provider" | undefined {
    if (!data || typeof data !== "object") return undefined;
    const deliveryState = (data as { deliveryState?: unknown }).deliveryState;
    return deliveryState === "provider" ? "provider" : undefined;
}

function resolvePendingMaterializeDeliveryTiming(data: unknown): "after_foreground_ready" | "after_runtime_idle" | undefined {
    if (!data || typeof data !== "object") return undefined;
    const deliveryTiming = (data as { deliveryTiming?: unknown }).deliveryTiming;
    return deliveryTiming === "after_runtime_idle" || deliveryTiming === "after_foreground_ready" ? deliveryTiming : undefined;
}

function resolvePendingMaterializeForegroundState(data: unknown): "ready" | "active_steerable" | "active_unsteerable" | undefined {
    if (!data || typeof data !== "object") return undefined;
    const foregroundState = (data as { foregroundState?: unknown }).foregroundState;
    return foregroundState === "ready" || foregroundState === "active_steerable" || foregroundState === "active_unsteerable"
        ? foregroundState
        : undefined;
}

function toPendingSocketState(value: { pendingCount: number; pendingBlockedCount?: number; pendingVersion: number }) {
    return {
        pendingCount: value.pendingCount,
        ...(typeof value.pendingBlockedCount === "number" ? { pendingBlockedCount: value.pendingBlockedCount } : {}),
        pendingVersion: value.pendingVersion,
    };
}

async function emitPublicationSafePendingChanged(params: Readonly<{
    data: Parameters<typeof buildPendingChangedUpdate>[0];
    participantCursors: readonly Readonly<{ accountId: string; cursor: number }>[];
}>): Promise<void> {
    const { sessionId, ...rawProjection } = params.data;
    const session = await loadSessionTranscriptPublicationRecipientProjection(sessionId);
    if (!session) return;
    await Promise.all(params.participantCursors.map(async ({ accountId, cursor }) => {
        const projection = projectSessionTranscriptPublicationPendingProjection(
            rawProjection,
            session,
            accountId,
        );
        if (projection.kind === "suppress") return;
        eventRouter.emitUpdate({
            userId: accountId,
            payload: buildPendingChangedUpdate(
                { sessionId, ...projection.value },
                cursor,
                randomKeyNaked(12),
            ),
            recipientFilter: { type: "all-interested-in-session", sessionId },
        });
    }));
}

async function publishAcceptedPendingSettlement(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    result: ResolveAcceptedPendingDeliveryResult;
}>): Promise<void> {
    const { result } = params;
    if (!result.ok) {
        if (result.error !== "transcript-conflict" || result.pendingStateChanged !== true) return;
        const participantCursors = result.participantCursors ?? [];
        await emitPublicationSafePendingChanged({
            data: {
                sessionId: params.sessionId,
                pendingCount: result.pendingCount ?? 0,
                ...(typeof result.pendingBlockedCount === "number" ? { pendingBlockedCount: result.pendingBlockedCount } : {}),
                pendingVersion: result.pendingVersion ?? 0,
                changedByAccountId: params.actorUserId,
            },
            participantCursors,
        });
        await refreshSessionParticipantBadgePushes({
            badgeAttentionChanged: result.badgeAttentionChanged ?? false,
            participantCursors,
        });
        return;
    }
    if (result.didResolve !== true || !result.message) return;

    const participantCursorsMessage = result.participantCursorsMessage ?? [];
    const participantCursorsPending = result.participantCursorsPending ?? result.participantCursors;
    await Promise.all(participantCursorsMessage.map(async ({ accountId, cursor }) => {
        eventRouter.emitUpdate({
            userId: accountId,
            payload: buildPendingResolvedMessageUpdate(
                result.message!,
                params.sessionId,
                cursor,
                randomKeyNaked(12),
                result.didUpdate === true && result.didWrite !== true
                    ? "message-updated"
                    : "new-message",
            ),
            recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
        });
    }));
    await publishSessionReadyProjectionUpdate({
        sessionId: params.sessionId,
        readyProjection: result.readyProjection,
    });
    await emitPublicationSafePendingChanged({
        data: {
            sessionId: params.sessionId,
            pendingCount: result.pendingCount,
            pendingBlockedCount: result.pendingBlockedCount,
            pendingVersion: result.pendingVersion,
            changedByAccountId: params.actorUserId,
        },
        participantCursors: participantCursorsPending,
    });
    await refreshSessionParticipantBadgePushes({
        badgeAttentionChanged: result.badgeAttentionChanged,
        participantCursors: [...participantCursorsMessage, ...participantCursorsPending],
    });
}

async function publishPendingInputAdmissionSettlement(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    result: SettlePendingInputAdmissionResult;
}>): Promise<void> {
    const { result } = params;
    if (!result.ok) return;
    await Promise.all(result.participantCursorsMessage.map(async ({ accountId, cursor }) => {
        if (!result.message) return;
        eventRouter.emitUpdate({
            userId: accountId,
            payload: buildPendingResolvedMessageUpdate(
                result.message,
                params.sessionId,
                cursor,
                randomKeyNaked(12),
            ),
            recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
        });
    }));
    await publishSessionReadyProjectionUpdate({
        sessionId: params.sessionId,
        readyProjection: result.readyProjection,
    });
    await emitPublicationSafePendingChanged({
        data: {
            sessionId: params.sessionId,
            pendingCount: result.pendingCount,
            pendingBlockedCount: result.pendingBlockedCount,
            pendingVersion: result.pendingVersion,
            changedByAccountId: params.actorUserId,
        },
        participantCursors: result.participantCursorsPending,
    });
    await refreshSessionParticipantBadgePushes({
        badgeAttentionChanged: result.badgeAttentionChanged,
        participantCursors: [...result.participantCursorsMessage, ...result.participantCursorsPending],
    });
}

type TrustedSessionPublisher = Readonly<{
    presence: ReturnType<typeof createSessionPublisherPresence>;
    binding: SessionPublisherBinding;
}>;

const releasedAliveOperationTails = new WeakMap<object, Promise<void>>();
const RELEASED_ALIVE_PERSISTENCE_INTERVAL_MS = 60_000;
const RELEASED_ALIVE_FAILURE_BACKOFF_BASE_MS = 2_000;

/**
 * How long the alive persistence throttle holds after a settled failure. The first failure holds
 * for nothing, so a one-off contention is still retried on the very next heartbeat; consecutive
 * failures back off exponentially up to the ordinary persistence interval, so a saturated database
 * stops being answered with more write pressure (heartbeats arrive every 2s while thinking).
 */
function resolveReleasedAliveFailureHoldMs(failureStreak: number): number {
    if (failureStreak <= 1) return 0;
    return Math.min(
        RELEASED_ALIVE_PERSISTENCE_INTERVAL_MS,
        RELEASED_ALIVE_FAILURE_BACKOFF_BASE_MS * 2 ** (failureStreak - 2),
    );
}

async function serializeReleasedAlivePersistence<T>(
    presence: TrustedSessionPublisher["presence"],
    operation: () => Promise<T>,
): Promise<T> {
    const prior = releasedAliveOperationTails.get(presence) ?? Promise.resolve();
    const result = prior.catch(() => {}).then(operation);
    releasedAliveOperationTails.set(presence, result.then(() => {}, () => {}));
    return await result;
}

export function sessionUpdateHandler(
    userId: string,
    socket: Socket,
    connection: ClientConnection,
    trustedSessionPublisher?: TrustedSessionPublisher,
) {
    let legacyAliveInFlight = false;
    // The alive persistence throttle is armed on every settled attempt, not only on success, so a
    // failing session cannot fall back to attempting a write on every heartbeat.
    let legacyAliveThrottledAtMs: number | null = null;
    let legacyAliveThrottleHoldMs = 0;
    let legacyAliveFailureStreak = 0;

    const armLegacyAliveThrottle = (holdMs: number): void => {
        legacyAliveThrottledAtMs = Date.now();
        legacyAliveThrottleHoldMs = holdMs;
    };

    socket.on(
        SESSION_PUBLISHER_AUTHORITY_CHECK_EVENT,
        async (data: unknown, callback?: (response: unknown) => void) => {
            const respond = (response: unknown) =>
                callback?.(SessionPublisherAuthorityCheckAckSchema.parse(response));
            const request =
                SessionPublisherAuthorityCheckRequestSchema.safeParse(data);
            if (
                !request.success
                || !trustedSessionPublisher
                || trustedSessionPublisher.binding.sessionId
                    !== request.data.sessionId
                || !canTargetSessionFromSocket({
                    socket,
                    connection,
                    sessionId: request.data.sessionId,
                })
            ) {
                respond({ status: "rejected", reason: "invalid_request" });
                return;
            }
            try {
                const publisherPrecondition =
                    await trustedSessionPublisher.presence
                        .readCurrentPublisherPrecondition({
                        socket,
                    });
                respond(publisherPrecondition
                    ? {
                        status: "current",
                        sessionId: request.data.sessionId,
                        publisherPrecondition,
                    }
                    : {
                        status: "superseded",
                        sessionId: request.data.sessionId,
                    });
            } catch {
                respond({
                    status: "retryable",
                    sessionId: request.data.sessionId,
                    reason: "internal",
                });
            }
        },
    );

    const publishRuntimeActivitySnapshotResult = async (
        sid: string,
        result: Exclude<Awaited<ReturnType<TrustedSessionPublisher["presence"]["publishSnapshot"]>>, { status: "rejected" }>,
    ): Promise<{ didWrite: boolean }> => {
        const didWrite = result.status === "applied";
        const registrationActiveAt = "activeAt" in result ? result.activeAt.getTime() : null;
        if (didWrite || registrationActiveAt !== null) {
            const session = await loadSessionTranscriptPublicationRecipientProjection(sid);
            if (session) await Promise.all(result.participantCursors.map(async ({ accountId, cursor }) => {
                const projection = projectSessionTranscriptPublicationRealtimeProjection(
                    {
                        ...(didWrite ? result.projection : {}),
                        ...(registrationActiveAt !== null ? { active: true, activeAt: registrationActiveAt } : {}),
                    },
                    session,
                    accountId,
                );
                if (projection.kind === "suppress") return;
                const payload = buildUpdateSessionUpdate(
                    sid,
                    cursor,
                    randomKeyNaked(12),
                    undefined,
                    undefined,
                    projection.value,
                );
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload,
                    recipientFilter: { type: "all-interested-in-session", sessionId: sid },
                    skipSenderConnection: accountId === userId ? connection : undefined,
                });
            }));
        }
        if (result.status === "applied" && result.becameIdle === true) {
            const pendingState = await readSessionPendingState({ actorUserId: userId, sessionId: sid });
            if (pendingState.ok) {
                const session = await loadSessionTranscriptPublicationRecipientProjection(sid);
                if (session) await Promise.all(result.participantCursors.map(async ({ accountId, cursor }) => {
                    const pendingProjection = projectSessionTranscriptPublicationPendingProjection(
                        {
                            pendingCount: pendingState.pendingCount,
                            pendingBlockedCount: pendingState.pendingBlockedCount,
                            pendingVersion: pendingState.pendingVersion,
                            changedByAccountId: userId,
                        },
                        session,
                        accountId,
                    );
                    if (pendingProjection.kind === "suppress") return;
                    const payload = buildPendingChangedUpdate(
                        {
                            sessionId: sid,
                            ...pendingProjection.value,
                        },
                        cursor,
                        randomKeyNaked(12),
                    );
                    eventRouter.emitUpdate({
                        userId: accountId,
                        payload,
                        recipientFilter: { type: "all-interested-in-session", sessionId: sid },
                    });
                }));
            }
        }
        if ("badgeAttentionChanged" in result && result.badgeAttentionChanged) {
            scheduleSessionParticipantBadgeRefresh({
                badgeAttentionChanged: true,
                participantCursors: result.participantCursors,
            });
        }
        return { didWrite };
    };

    socket.on(SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1, async (data: unknown, callback?: (response: unknown) => void) => {
        const respond = (response: unknown) => callback?.(SessionTranscriptObservationCapabilityAckV1Schema.parse(response));
        try {
            const record = data && typeof data === "object" && !Array.isArray(data)
                ? data as Record<string, unknown>
                : null;
            const sessionId = record?.v === 1 && typeof record.sessionId === "string" ? record.sessionId : null;
            if (!sessionId || !canTargetSessionFromSocket({ socket, connection, sessionId })) {
                respond({ ok: false, error: "invalid_session" });
                return;
            }
            if (!trustedSessionPublisher || trustedSessionPublisher.binding.sessionId !== sessionId) {
                respond({ ok: false, error: "forbidden" });
                return;
            }
            respond({
                ok: true,
                capability: SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1,
            });
        } catch (error) {
            log({ module: "websocket", level: "warn" }, `Transcript observation capability negotiation failed: ${error}`);
            respond({ ok: false, error: "internal" });
        }
    });

    socket.on(SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1, async (data: unknown, callback?: (response: unknown) => void) => {
        const respond = (response: unknown) => callback?.(SessionTranscriptObservationAckV1Schema.parse(response));
        try {
            const parsed = SessionTranscriptObservationV1Schema.safeParse(data);
            if (!parsed.success) {
                respond({ ok: false, error: "invalid_observation" });
                return;
            }
            const observation = parsed.data;
            // Reserved Agent-transition divider namespace. Even a trusted session
            // publisher may not mint or overwrite a divider row: the owner-only
            // transition service is its sole writer.
            if (isSessionAgentTransitionDividerLocalId(observation.localId)) {
                respond({ ok: false, error: "invalid_observation" });
                return;
            }
            const isRecoveredHistory = isRecoveredHistoryTranscriptObservationProvenance(
                observation.provenance,
            );
            if (
                !canTargetSessionFromSocket({ socket, connection, sessionId: observation.sessionId })
                || !trustedSessionPublisher
                || trustedSessionPublisher.binding.sessionId !== observation.sessionId
            ) {
                respond({ ok: false, error: "forbidden" });
                return;
            }
            const result = await trustedSessionPublisher.presence.runAsCurrentPublisher({
                socket,
                operation: async (publisherAuthority) => await createSessionMessage({
                    actorUserId: userId,
                    sessionId: observation.sessionId,
                    localId: observation.localId,
                    sidechainId: observation.sidechainId,
                    messageRole: observation.messageRole,
                    ...(typeof observation.content === "string"
                        ? { ciphertext: observation.content }
                        : { content: observation.content }),
                    publisherAuthority,
                    trustedSourceTimestamps: { createdAt: observation.createdAt, updatedAt: observation.updatedAt },
                    trustedTranscriptObservationProvenance: observation.provenance,
                    ...(isRecoveredHistory
                        ? { trustedAttentionImpact: SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT }
                        : {}),
                    ...(observation.sessionEventType && !isRecoveredHistory
                        ? { trustedSessionEventType: observation.sessionEventType }
                        : {}),
                }),
            });
            if (result === null || !result.ok) {
                respond({
                    ok: false,
                    error: result === null || result.error === "forbidden"
                        ? "forbidden"
                        : result.error === "internal" ? "internal" : "invalid_observation",
                });
                return;
            }
            respond({
                ok: true,
                status: "observed",
                id: result.message.id,
                seq: result.message.seq,
                localId: result.message.localId,
                didWrite: result.didWrite,
                ...(result.didUpdate ? { didUpdate: true } : {}),
                ingestedAt: result.message.createdAt.getTime(),
            });
            if (!result.didWrite && !result.didUpdate) return;
            await Promise.all(result.participantCursors.map(async ({ accountId, cursor }) => {
                const options = result.attentionImpact ? { attentionImpact: result.attentionImpact } : undefined;
                const payload = result.didWrite
                    ? buildNewMessageUpdate(result.message, observation.sessionId, cursor, randomKeyNaked(12), options)
                    : buildMessageUpdatedUpdate(result.message, observation.sessionId, cursor, randomKeyNaked(12), options);
                eventRouter.emitUpdate({
                    userId: accountId,
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
            respond({ ok: false, error: "internal" });
        }
    });

    socket.on('update-metadata', async (data: any, callback: (response: any) => void) => {
        try {
            if (data?.mode === "owner" || data?.mode === "shared_editor") {
                callback?.({ result: "metadata_privacy_upgrade_required" });
                return;
            }
            const { sid, metadata, expectedVersion } = data;
            const readCursorHintV1Raw = readSocketPayloadRecordField(data, "readCursorHintV1");
            const lastViewedSessionSeqHint =
                typeof readCursorHintV1Raw?.lastViewedSessionSeq === "number" && Number.isFinite(readCursorHintV1Raw.lastViewedSessionSeq)
                    ? Math.max(0, Math.floor(readCursorHintV1Raw.lastViewedSessionSeq))
                    : null;

            // Validate input
            if (!sid || typeof metadata !== 'string' || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }
            if (!canTargetSessionFromSocket({ socket, connection, sessionId: sid })) {
                callback?.({ result: 'forbidden' });
                return;
            }

            const updateMetadata = async (
                publisherAuthority?: Parameters<typeof updateSessionMetadata>[0]["publisherAuthority"],
            ) => await updateSessionMetadata({
                actorUserId: userId,
                sessionId: sid,
                expectedVersion,
                metadataCiphertext: metadata,
                ...(typeof lastViewedSessionSeqHint === "number"
                    ? { readCursorHintV1: { lastViewedSessionSeq: lastViewedSessionSeqHint } }
                    : {}),
                ...(publisherAuthority ? { publisherAuthority } : {}),
            });
            const result = (
                trustedSessionPublisher
                && trustedSessionPublisher.binding.sessionId === sid
            )
                ? await trustedSessionPublisher.presence.runAsCurrentPublisher({
                    socket,
                    operation: updateMetadata,
                })
                : await updateMetadata();
            if (result === null) {
                callback?.({ result: "publisher-superseded" });
                return;
            }

            if (!result.ok) {
                if (result.error === 'forbidden') {
                    callback?.({ result: 'forbidden' });
                    return;
                }
                if (result.error === "publisher-superseded") {
                    callback?.({ result: "publisher-superseded" });
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
                if (result.error === "metadata_privacy_upgrade_required") {
                    callback?.({ result: "metadata_privacy_upgrade_required" });
                    return;
                }
                callback?.({ result: 'error' });
                return;
            }

            const metadataUpdate = {
                value: result.metadata,
                version: result.version,
            };
            await Promise.all(result.participantCursors
                .filter(({ accountId }) => accountId === userId)
                .map(async ({
                accountId,
                cursor,
            }) => {
                const payload = buildUpdateSessionUpdate(
                    sid,
                    cursor,
                    randomKeyNaked(12),
                    metadataUpdate,
                    undefined,
                    typeof result.lastViewedSessionSeq === "number"
                        ? { lastViewedSessionSeq: result.lastViewedSessionSeq }
                        : undefined,
                );
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload,
                    recipientFilter: {
                        type: "all-interested-in-session",
                        sessionId: sid,
                    },
                    skipSenderConnection:
                        accountId === userId ? connection : undefined,
                });
            }));
            scheduleSessionParticipantBadgeRefresh({
                badgeAttentionChanged: result.badgeAttentionChanged,
                participantCursors: result.participantCursors,
            });
            callback?.({
                result: "success",
                version: result.version,
                metadata: result.metadata,
            });
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
            const activitySummaryV1 = readSocketPayloadRecordField(data, "activitySummaryV1");
            const pendingPermissionRequestCount =
                typeof activitySummaryV1?.pendingPermissionRequestCount === "number" && Number.isFinite(activitySummaryV1.pendingPermissionRequestCount)
                    ? Math.max(0, Math.floor(activitySummaryV1.pendingPermissionRequestCount))
                    : undefined;
            const pendingUserActionRequestCount =
                typeof activitySummaryV1?.pendingUserActionRequestCount === "number" && Number.isFinite(activitySummaryV1.pendingUserActionRequestCount)
                    ? Math.max(0, Math.floor(activitySummaryV1.pendingUserActionRequestCount))
                    : undefined;
            const pendingRequestNewestCreatedAt =
                activitySummaryV1?.pendingRequestNewestCreatedAt === null
                    ? null
                    : typeof activitySummaryV1?.pendingRequestNewestCreatedAt === "number" && Number.isFinite(activitySummaryV1.pendingRequestNewestCreatedAt)
                        ? Math.max(0, Math.floor(activitySummaryV1.pendingRequestNewestCreatedAt))
                        : undefined;
            // Validate input
            if (!sid || (typeof agentState !== 'string' && agentState !== null) || typeof expectedVersion !== 'number') {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }
            if (!canTargetSessionFromSocket({ socket, connection, sessionId: sid })) {
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
                ...(pendingRequestNewestCreatedAt !== undefined ? { pendingRequestNewestCreatedAt } : {}),
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
                if (result.error === "metadata_privacy_upgrade_required") {
                    callback?.({ result: "metadata_privacy_upgrade_required" });
                    return;
                }
                callback?.({ result: 'error' });
                return;
            }

            const agentStateUpdate = {
                value: result.agentState,
                version: result.version,
            };
            const rawRealtimeProjection = (
                typeof result.pendingPermissionRequestCount === "number"
                || typeof result.pendingUserActionRequestCount === "number"
                || result.pendingRequestObservedAt !== undefined
            )
                ? {
                    ...(typeof result.pendingPermissionRequestCount === "number"
                        ? {
                            pendingPermissionRequestCount:
                                result.pendingPermissionRequestCount,
                        }
                        : {}),
                    ...(typeof result.pendingUserActionRequestCount === "number"
                        ? {
                            pendingUserActionRequestCount:
                                result.pendingUserActionRequestCount,
                        }
                        : {}),
                    ...(result.pendingRequestObservedAt !== undefined
                        ? {
                            pendingRequestObservedAt:
                                result.pendingRequestObservedAt,
                        }
                        : {}),
                }
                : undefined;
            await Promise.all(result.participantCursors
                .filter(({ accountId }) => accountId === userId)
                .map(async ({
                accountId,
                cursor,
            }) => {
                const payload = buildUpdateSessionUpdate(
                    sid,
                    cursor,
                    randomKeyNaked(12),
                    undefined,
                    agentStateUpdate,
                    rawRealtimeProjection,
                );
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload,
                    recipientFilter: {
                        type: "all-interested-in-session",
                        sessionId: sid,
                    },
                    skipSenderConnection:
                        accountId === userId ? connection : undefined,
                });
            }));
            scheduleSessionParticipantBadgeRefresh({
                badgeAttentionChanged: result.badgeAttentionChanged,
                participantCursors: result.participantCursors,
            });
            callback?.({
                result: "success",
                version: result.version,
                agentState: result.agentState,
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in update-state: ${error}`);
            if (callback) {
                callback({ result: 'error' });
            }
        }
    });

    socket.on(SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT, async (value: unknown, acknowledge?: (response: unknown) => void) => {
        const request = SessionRuntimeActivitySnapshotRequestSchema.safeParse(value);
        if (!request.success || !trustedSessionPublisher || trustedSessionPublisher.binding.sessionId !== request.data.sessionId) {
            acknowledge?.(SessionRuntimeActivitySnapshotAckSchema.parse({
                status: "rejected",
                reason: "invalid_request",
            }));
            return;
        }

        try {
            const result = await trustedSessionPublisher.presence.publishSnapshot({
                socket,
                binding: trustedSessionPublisher.binding,
                completeSnapshot: request.data.snapshot,
            });
            if (result.status === "rejected") {
                if (result.reason === "invalid-params") {
                    acknowledge?.(SessionRuntimeActivitySnapshotAckSchema.parse({
                        status: "rejected",
                        reason: "invalid_request",
                    }));
                    return;
                }
                if (
                    result.reason === "not_found"
                    || result.reason === "unauthorized"
                    || result.reason === "archived"
                    || result.reason === "superseded"
                    || result.reason === "revision_overflow"
                ) {
                    acknowledge?.(SessionRuntimeActivitySnapshotAckSchema.parse({
                        status: "rejected",
                        sessionId: request.data.sessionId,
                        mutationId: request.data.mutationId,
                        reason: result.reason,
                    }));
                    return;
                }
                acknowledge?.(SessionRuntimeActivitySnapshotAckSchema.parse({
                    status: "retryable",
                    sessionId: request.data.sessionId,
                    mutationId: request.data.mutationId,
                    reason: "internal",
                }));
                return;
            }

            await publishRuntimeActivitySnapshotResult(request.data.sessionId, result);
            const parsedProjection = parseSessionRuntimeActivityProjectionFields(result.projection);
            if (parsedProjection.kind !== "valid") {
                throw new Error("Runtime Activity snapshot produced an invalid projection");
            }
            acknowledge?.(SessionRuntimeActivitySnapshotAckSchema.parse({
                status: result.status,
                sessionId: request.data.sessionId,
                mutationId: request.data.mutationId,
                projection: parsedProjection.projection,
            }));
        } catch (error) {
            log({ module: "websocket", level: "error" }, `Error in ${SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT}: ${error}`);
            acknowledge?.(SessionRuntimeActivitySnapshotAckSchema.parse({
                status: "retryable",
                sessionId: request.data.sessionId,
                mutationId: request.data.mutationId,
                reason: "internal",
            }));
        }
    });

    socket.on("session-turn-mutation", async (data: unknown, callback: (response: any) => void) => {
        try {
            const parsed = SessionTurnMutationV1Schema.safeParse(data);
            if (!parsed.success) {
                callback?.({ result: "error" });
                return;
            }
            if (!canTargetSessionFromSocket({ socket, connection, sessionId: parsed.data.sessionId })) {
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

            await publishSessionTurnMutationUpdate({
                sessionId: parsed.data.sessionId,
                actorUserId: userId,
                connection,
                result,
            });
            callback?.({
                result: "success",
                applied: result.didApply,
                receipt: result.receipt,
                ...(result.reason ? { reason: result.reason } : {}),
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
            if (!canTargetSessionFromSocket({ socket, connection, sessionId: sid })) {
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
    socket.on('session-alive', async (data: {
        sid: string;
        time: number;
        thinking?: boolean;
        latestTurnStatus?: unknown;
        latestTurnStatusObservedAt?: unknown;
    }) => {
        let ownsLegacyAliveAttempt = false;
        let legacyAlivePersisted = false;
        try {
            // Track metrics
            websocketEventsCounter.inc({ event_type: 'session-alive' });
            sessionAliveEventsCounter.inc();

            // Basic validation
            if (!data || typeof data.time !== 'number' || !data.sid) {
                return;
            }
            if (!trustedSessionPublisher || trustedSessionPublisher.binding.sessionId !== data.sid) {
                return;
            }

            let t = data.time;
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) {
                return;
            }

            const { sid } = data;
            const latestTurnStatus = PrimaryTurnStatusV1Schema.safeParse(data.latestTurnStatus);
            const latestTurnStatusObservedAt = typeof data.latestTurnStatusObservedAt === "number"
                && Number.isFinite(data.latestTurnStatusObservedAt)
                && data.latestTurnStatusObservedAt >= 0
                ? Math.trunc(data.latestTurnStatusObservedAt)
                : null;

            if (legacyAliveInFlight) return;
            const nowMs = Date.now();
            if (
                legacyAliveThrottledAtMs !== null
                && nowMs >= legacyAliveThrottledAtMs
                && nowMs - legacyAliveThrottledAtMs < legacyAliveThrottleHoldMs
            ) return;
            legacyAliveInFlight = true;
            ownsLegacyAliveAttempt = true;

            const presenceResult = await serializeReleasedAlivePersistence(
                trustedSessionPublisher.presence,
                async () => {
                    const touched = await trustedSessionPublisher.presence.touchPublisher({ socket });
                    return touched.status === "unregistered"
                        ? await trustedSessionPublisher.presence.registerPublisher({
                            socket,
                            binding: trustedSessionPublisher.binding,
                            completeActivitySnapshot: { state: "unknown", activeCount: 0 },
                        })
                        : touched;
                },
            );
            if (presenceResult.status !== "touched" && presenceResult.status !== "registered") {
                return;
            }
            legacyAlivePersisted = true;
            legacyAliveFailureStreak = 0;
            armLegacyAliveThrottle(RELEASED_ALIVE_PERSISTENCE_INTERVAL_MS);

            await recordSessionAlive({
                accountId: userId,
                sessionId: sid,
                timestamp: t,
                ...(latestTurnStatus.success && latestTurnStatusObservedAt !== null
                    ? {
                        latestTurnStatus: latestTurnStatus.data,
                        latestTurnStatusObservedAt,
                    }
                    : {}),
            });

            const session = await loadSessionTranscriptPublicationRecipientProjection(sid);
            if (session) await Promise.all(
                presenceResult.participantCursors.map(async ({ accountId, cursor }) => {
                    const realtimeProjection = projectSessionTranscriptPublicationRealtimeProjection(
                        {
                            active: true,
                            activeAt: presenceResult.activeAt.getTime(),
                            ...(presenceResult.status === "registered" && presenceResult.activity.status === "applied"
                                ? presenceResult.activity.projection
                                : {}),
                        },
                        session,
                        accountId,
                    );
                    const pendingProjection = presenceResult.status === "registered" && presenceResult.pendingState
                        ? projectSessionTranscriptPublicationPendingProjection({
                            ...presenceResult.pendingState,
                            changedByAccountId: userId,
                        }, session, accountId)
                        : null;
                    if (realtimeProjection.kind === "publish") {
                        eventRouter.emitUpdate({
                            userId: accountId,
                            payload: buildUpdateSessionUpdate(
                                sid,
                                cursor,
                                randomKeyNaked(12),
                                undefined,
                                undefined,
                                realtimeProjection.value,
                            ),
                            recipientFilter: { type: "all-interested-in-session", sessionId: sid },
                            skipSenderConnection: accountId === userId ? connection : undefined,
                        });
                    }
                    if (pendingProjection?.kind === "publish") {
                        eventRouter.emitUpdate({
                            userId: accountId,
                            payload: buildPendingChangedUpdate(
                                { sessionId: sid, ...pendingProjection.value },
                                cursor,
                                randomKeyNaked(12),
                            ),
                            recipientFilter: { type: "all-interested-in-session", sessionId: sid },
                        });
                    }
                }),
            );
            if (presenceResult.badgeAttentionChanged) {
                scheduleSessionParticipantBadgeRefresh({
                    badgeAttentionChanged: true,
                    participantCursors: presenceResult.participantCursors,
                });
            }
            const sessionActivity = buildSessionActivityEphemeral(sid, true, presenceResult.activeAt.getTime(), false);
            eventRouter.emitEphemeral({
                userId,
                payload: sessionActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in session-alive: ${error}`);
        } finally {
            if (ownsLegacyAliveAttempt) {
                if (!legacyAlivePersisted) {
                    legacyAliveFailureStreak += 1;
                    armLegacyAliveThrottle(resolveReleasedAliveFailureHoldMs(legacyAliveFailureStreak));
                }
                legacyAliveInFlight = false;
            }
        }
    });

    socket.on('execution-run-updated', async (data: any) => {
        try {
            websocketEventsCounter.inc({ event_type: 'execution-run-updated' });

            const sid = typeof data?.sid === 'string' ? String(data.sid).trim() : '';
            const runRaw = data?.run;
            if (!sid) return;

            if (!await canPublishFromSessionScopedSocket({
                socket,
                connection,
                sessionId: sid,
                requireMachineBinding: true,
            })) {
                return;
            }

            const access = await checkSessionAccess(userId, sid);
            if (!access) return;
            if (!requireAccessLevel(access, 'edit')) {
                return;
            }
            if (!access.isOwner) {
                return;
            }

            // Strip unknown fields before rebroadcasting (clients treat this as a hint; keep the payload tight).
            const parsedRun = ExecutionRunPublicStateSocketSchema.safeParse(runRaw);
            if (!parsedRun.success) {
                return;
            }

            const participantUserIds = await getSessionParticipantUserIds({ sessionId: sid });
            if (!participantUserIds || participantUserIds.length === 0) return;
            const publication = await loadSessionTranscriptPublicationRecipientProjection(sid);
            if (!publication) return;

            const payload = {
                type: 'execution-run-updated' as const,
                sessionId: sid,
                run: parsedRun.data,
            };

            // Live execution-run facts carry no sequence anchor, so every
            // recipient is resolved through the canonical publication ceiling:
            // the owner and hosted-session participants receive the live hint,
            // while a finite collaborator is suppressed until the run's
            // transcript output is published to them.
            for (const participantUserId of participantUserIds) {
                const recipientPayload = projectSessionTranscriptPublicationUnanchoredProjection(
                    payload,
                    publication,
                    participantUserId,
                );
                if (recipientPayload.kind === "suppress") continue;
                eventRouter.emitEphemeral({
                    userId: participantUserId,
                    payload: recipientPayload.value,
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

            if (!await canPublishFromSessionScopedSocket({
                socket,
                connection,
                sessionId: sid,
                requireMachineBinding: true,
            })) {
                return;
            }

            const access = await checkSessionAccess(userId, sid);
            if (!access) return;
            if (!requireAccessLevel(access, 'edit')) {
                return;
            }
            if (!access.isOwner) {
                return;
            }

            const parsedMessage = TranscriptStreamSegmentEphemeralSocketMessageSchema.safeParse(data?.message);
            if (!parsedMessage.success) {
                return;
            }

            const participantUserIds = await getSessionParticipantUserIds({ sessionId: sid });
            if (!participantUserIds || participantUserIds.length === 0) return;
            const publication = await loadSessionTranscriptPublicationRecipientProjection(sid);
            if (!publication) return;

            const payload = {
                type: 'transcript-stream-segment' as const,
                sessionId: sid,
                message: parsedMessage.data,
            };

            for (const participantUserId of participantUserIds) {
                const recipientPayload = projectSessionTranscriptPublicationUnanchoredProjection(
                    payload,
                    publication,
                    participantUserId,
                );
                if (recipientPayload.kind === "suppress") continue;
                eventRouter.emitEphemeral({
                    userId: participantUserId,
                    payload: recipientPayload.value,
                    recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                    skipSenderConnection: participantUserId === userId ? connection : undefined,
                });
            }
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in transcript-stream-segment handler: ${error}`);
        }
    });

    // Delta form of the live transcript segment stream: carries ONLY appended text plus
    // tick/baseLength chaining fields. Mirrors the snapshot handler exactly (session-scoped-socket
    // proof, edit+owner access, per-event schema validation with `.strip()`).
    socket.on('transcript-stream-segment-delta', async (data: any) => {
        try {
            websocketEventsCounter.inc({ event_type: 'transcript-stream-segment-delta' });

            const sid = typeof data?.sid === 'string' ? String(data.sid).trim() : '';
            if (!sid) return;

            if (!await canPublishFromSessionScopedSocket({
                socket,
                connection,
                sessionId: sid,
                requireMachineBinding: true,
            })) {
                return;
            }

            const access = await checkSessionAccess(userId, sid);
            if (!access) return;
            if (!requireAccessLevel(access, 'edit')) {
                return;
            }
            if (!access.isOwner) {
                return;
            }

            const parsedMessage = TranscriptStreamSegmentDeltaEphemeralSocketMessageSchema.safeParse(data?.message);
            if (!parsedMessage.success) {
                return;
            }

            const participantUserIds = await getSessionParticipantUserIds({ sessionId: sid });
            if (!participantUserIds || participantUserIds.length === 0) return;
            const publication = await loadSessionTranscriptPublicationRecipientProjection(sid);
            if (!publication) return;

            const payload = {
                type: 'transcript-stream-segment-delta' as const,
                sessionId: sid,
                message: parsedMessage.data,
            };

            for (const participantUserId of participantUserIds) {
                const recipientPayload = projectSessionTranscriptPublicationUnanchoredProjection(
                    payload,
                    publication,
                    participantUserId,
                );
                if (recipientPayload.kind === "suppress") continue;
                eventRouter.emitEphemeral({
                    userId: participantUserId,
                    payload: recipientPayload.value,
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
                if (!canTargetSessionFromSocket({ socket, connection, sessionId: sid })) {
                    socketMessageAckCounter.inc({ result: 'error', error: 'forbidden' });
                    respond({ ok: false, error: 'forbidden' });
                    return;
                }
                if (isReleasedUiV020DirectUserMessagePayload(data)) {
                    socketMessageAckCounter.inc({ result: 'error', error: 'client-upgrade-required' });
                    respond({ ok: false, error: 'client-upgrade-required' });
                    return;
                }
                // Reserved Agent-transition divider namespace: only the owner-only
                // transition service may write one.
                if (isSessionAgentTransitionDividerLocalId(localId)) {
                    socketMessageAckCounter.inc({ result: 'error', error: 'invalid-params' });
                    respond({ ok: false, error: 'invalid-params' });
                    return;
                }

                const messageRole = resolveSocketSuppliedMessageRole(data);
                const parsedMessageRole =
                    messageRole !== undefined
                        ? SessionMessageRoleSchema.safeParse(messageRole)
                        : null;
                const trustedSessionEventType = data?.sessionEventType === "ready" ? "ready" : undefined;
                if (parsedMessageRole !== null && !parsedMessageRole.success) {
                    socketMessageAckCounter.inc({ result: 'error', error: 'invalid-params' });
                    respond({ ok: false, error: 'invalid-params' });
                    return;
                }

                if (shouldLogSocketMessageDiagnostics()) {
                    const loggedLength = (() => {
                        if (content.t === "encrypted") return content.c.length;
                        try {
                            return JSON.stringify(content.v ?? null).length;
                        } catch {
                            return 0;
                        }
                    })();
                    debug(
                        { module: 'websocket' },
                        `Received message from socket ${socket.id}: sessionId=${sid}, messageLength=${loggedLength} bytes, connectionType=${connection.connectionType}, connectionSessionId=${connection.connectionType === 'session-scoped' ? connection.sessionId : 'N/A'}`
                    );
                }

                const result = await createSessionMessage({
                    actorUserId: userId,
                    sessionId: sid,
                    content,
                    localId,
                    messageRole: parsedMessageRole?.data,
                    sidechainId,
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
                    ...(typeof result.message.messageRole === "string" ? { messageRole: result.message.messageRole } : {}),
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

    socket.on(
        SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1,
        async (data: unknown, callback?: (response: unknown) => void) => {
            await receiveMessageLock.inLock(async () => {
                const respond = (response: unknown) => callback?.(
                    SessionPendingAdmissionSettlementResponseV1Schema.parse(response),
                );
                const parsed = SessionPendingAdmissionSettlementRequestV1Schema.safeParse(data);
                if (!parsed.success) {
                    respond({
                        v: 1,
                        result: { status: "rejected", code: "session_input_invalid" },
                    });
                    return;
                }
                const { sessionId, localId, decision } = parsed.data;
                if (
                    !canTargetSessionFromSocket({ socket, connection, sessionId })
                    || !trustedSessionPublisher
                    || trustedSessionPublisher.binding.sessionId !== sessionId
                ) {
                    respond({
                        v: 1,
                        result: { status: "rejected", code: "session_input_unauthorized" },
                    });
                    return;
                }
                try {
                    const result = await trustedSessionPublisher.presence.runAsCurrentPublisher({
                        socket,
                        operation: async (publisherAuthority) => await settlePendingInputAdmission({
                            actorUserId: userId,
                            sessionId,
                            localId,
                            publisherAuthority,
                            decision,
                        }),
                    });
                    if (result === null) {
                        respond({
                            v: 1,
                            result: { status: "rejected", code: "session_input_unauthorized" },
                        });
                        return;
                    }
                    try {
                        await publishPendingInputAdmissionSettlement({
                            actorUserId: userId,
                            sessionId,
                            result,
                        });
                    } catch (error) {
                        log(
                            { module: "session-input-admission-settlement", level: "warn", sessionId, localId },
                            "Session input settlement committed but publication failed",
                            error,
                        );
                    }
                    if (result.ok) {
                        respond({ v: 1, result: result.result });
                        return;
                    }
                    if (result.error === "internal") {
                        respond({
                            v: 1,
                            result: {
                                status: "outcomeUnknown",
                                localId,
                                code: "session_input_settlement_outcome_unknown",
                            },
                        });
                        return;
                    }
                    const code = result.error === "forbidden"
                        ? "session_input_unauthorized"
                        : result.error === "not-found"
                            ? "session_input_target_unavailable"
                            : result.error === "conflict"
                                ? "session_input_source_authority_mismatch"
                                : "session_input_invalid";
                    respond({ v: 1, result: { status: "rejected", code } });
                } catch (error) {
                    log(
                        { module: "session-input-admission-settlement", level: "error", sessionId, localId },
                        "Error settling Session input admission",
                        error,
                    );
                    respond({
                        v: 1,
                        result: {
                            status: "outcomeUnknown",
                            localId,
                            code: "session_input_settlement_outcome_unknown",
                        },
                    });
                }
            });
        },
    );

    socket.on(ACCEPTED_PENDING_SETTLEMENT_EVENT_V1, async (data: unknown, callback?: (response: unknown) => void) => {
        await receiveMessageLock.inLock(async () => {
            const respond = (response: unknown) => callback?.(AcceptedPendingSettlementResponseV1Schema.parse(response));
            try {
                const parsed = AcceptedPendingSettlementRequestV1Schema.safeParse(data);
                if (!parsed.success) {
                    respond({ ok: false, error: "invalid-params" });
                    return;
                }
                const { sessionId, localId } = parsed.data;
                const diagnosticCorrelationId = `accepted-settlement:${randomKeyNaked(12)}`;
                if (!canTargetSessionFromSocket({ socket, connection, sessionId })) {
                    respond({ ok: false, error: "forbidden" });
                    return;
                }
                const publisher = trustedSessionPublisher;
                if (!publisher || publisher.binding.sessionId !== sessionId) {
                    respond({ ok: false, error: "forbidden" });
                    return;
                }
                const result = await publisher.presence.runAsCurrentPublisher({
                    socket,
                    operation: async (publisherAuthority) => await resolveAcceptedPendingDelivery({
                        actorUserId: userId,
                        sessionId,
                        localId,
                        publisherAuthority,
                        diagnosticCorrelationId,
                    }),
                });
                if (result === null) {
                    respond({ ok: false, error: "forbidden" });
                    return;
                }
                try {
                    await publishAcceptedPendingSettlement({ actorUserId: userId, sessionId, result });
                } catch (error) {
                    log(
                        { module: "accepted-pending-settlement", level: "warn", sessionId, localId },
                        "accepted pending settlement committed but publication failed",
                        error,
                    );
                }
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
            } catch (error) {
                logError(
                    { module: "websocket", event: ACCEPTED_PENDING_SETTLEMENT_EVENT_V1, err: error },
                    "Error settling accepted pending delivery",
                );
                respond({ ok: false, error: "internal" });
            }
        });
    });

    socket.on('pending-materialize-next', async (data: any, callback?: (response: any) => void) => {
        const respond = (response: any) => {
            if (typeof callback === 'function') callback(response);
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

                if (!canTargetSessionFromSocket({ socket, connection, sessionId: sid })) {
                    respond({ ok: false, error: 'forbidden' });
                    return;
                }

                const deliveryState = resolvePendingMaterializeDeliveryStateOptIn(data);
                if (Object.prototype.hasOwnProperty.call(data, "deliveryState") && !deliveryState) {
                    respond({ ok: false, error: "invalid-params" });
                    return;
                }
                if (deliveryState !== "provider") {
                    respond({ ok: false, error: "forbidden" });
                    return;
                }
                const deliveryTiming = resolvePendingMaterializeDeliveryTiming(data);
                if (!deliveryTiming) {
                    respond({ ok: false, error: "invalid-params" });
                    return;
                }
                const foregroundState = resolvePendingMaterializeForegroundState(data);
                if (!foregroundState) {
                    respond({ ok: false, error: "invalid-params" });
                    return;
                }
                const expectedRuntimeActivityRevision = readExpectedRuntimeActivityRevision(data);
                const materialize = (
                    publisherAuthority: import("@/app/presence/sessionPublisherPresence").CurrentSessionPublisherAuthority,
                    tx: import("@/storage/inTx").Tx,
                ) => materializeNextPendingMessageInTx({
                        actorUserId: userId,
                        sessionId: sid,
                        deliveryState,
                        deliveryTiming,
                        foregroundState,
                        ...(expectedRuntimeActivityRevision !== null ? { expectedRuntimeActivityRevision } : {}),
                        publisherAuthority,
                        tx,
                    });
                const publisher = trustedSessionPublisher;
                const result = !publisher || publisher.binding.sessionId !== sid
                    ? null
                    : await publisher.presence.runAsCurrentPublisherInTx({
                        socket,
                        deadlineAtMs,
                        operation: materialize,
                    });

                if (result === null) {
                    respond({ ok: false, error: "forbidden" });
                    return;
                }

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
                        ...toPendingSocketState(result),
                        ...(result.deferredReason ? { deferredReason: result.deferredReason } : {}),
                        ...(result.localId ? { localId: result.localId } : {}),
                        ...(result.deliveryState ? { deliveryState: result.deliveryState } : {}),
                    } as const;
                    respond(response);
                    if (result.pendingStateChanged === true) {
                        const participantCursorsPending = result.participantCursorsPending ?? [];
                        await emitPublicationSafePendingChanged({
                            data: {
                                sessionId: sid,
                                pendingCount: result.pendingCount,
                                pendingBlockedCount: result.pendingBlockedCount,
                                pendingVersion: result.pendingVersion,
                                changedByAccountId: userId,
                            },
                            participantCursors: participantCursorsPending,
                        });
                        await refreshSessionParticipantBadgePushes({
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
                    message: serializePendingMaterializedMessage(result.message),
                    ...toPendingSocketState(result),
                    ...(result.deliveryState ? { deliveryState: result.deliveryState } : {}),
                });

                const committedMessage = result.message.id !== null && result.message.seq !== null
                    ? { ...result.message, id: result.message.id, seq: result.message.seq }
                    : null;
                if (result.didWriteMessage && committedMessage) {
                    await Promise.all(
                        result.participantCursorsMessage.map(async ({ accountId, cursor }) => {
                            const payload = buildPendingResolvedMessageUpdate(
                                committedMessage,
                                sid,
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
                    await publishSessionReadyProjectionUpdate({
                        sessionId: sid,
                        readyProjection: result.readyProjection,
                    });
                }

                await emitPublicationSafePendingChanged({
                    data: {
                        sessionId: sid,
                        pendingCount: result.pendingCount,
                        pendingBlockedCount: result.pendingBlockedCount,
                        pendingVersion: result.pendingVersion,
                        changedByAccountId: userId,
                        meaningfulActivityAt: result.meaningfulActivityAt,
                    },
                    participantCursors: result.participantCursorsPending,
                });
                scheduleSessionParticipantBadgeRefresh({
                    badgeAttentionChanged: result.badgeAttentionChanged,
                    participantCursors: [...result.participantCursorsMessage, ...result.participantCursorsPending],
                });
            } catch (error) {
                if (
                    isLockAdmissionDeadlineExceededError(error)
                    || isTransactionDeadlineExceededError(error)
                    || isTransactionAcquisitionUnavailableError(error)
                ) throw error;
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

    if (connection.connectionType !== "user-scoped") {
    socket.on('session-end', async (data: SessionEndSocketPayload, callback?: (response: SessionEndAckResponse) => void) => {
        const respond = (response: SessionEndAckResponse): void => {
            callback?.(response);
        };
        try {
            const { sid, time } = data;
            if (typeof sid !== "string" || sid.trim().length === 0 || typeof time !== "number") {
                respond({ ok: false, error: "invalid-params" });
                return;
            }
            if (!trustedSessionPublisher || trustedSessionPublisher.binding.sessionId !== sid) {
                respond({ ok: false, error: "forbidden" });
                return;
            }
            let t = time;
            if (t > Date.now()) {
                t = Date.now();
            }
            if (t < Date.now() - 1000 * 60 * 10) { // Ignore if time is in the past 10 minutes
                respond({ ok: false, error: "invalid-params" });
                return;
            }

            const closed = await serializeReleasedAlivePersistence(
                trustedSessionPublisher.presence,
                async () => await trustedSessionPublisher.presence.closePublisher({ socket }),
            );
            if (closed.status !== "closed" && closed.status !== "closed_replay") {
                respond({ ok: false, error: "forbidden" });
                return;
            }
            if (closed.status === "closed") {
                await publishSessionPublisherClose({
                    sessionId: sid,
                    publisherAccountId: userId,
                    closed,
                    skipSenderConnection: connection,
                });
            }
            respond({
                ok: true,
                applied: closed.status === "closed",
                active: false,
                activeAt: closed.activeAt.getTime(),
                projection: { active: false, activeAt: closed.activeAt.getTime() },
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in session-end: ${error}`);
            respond({ ok: false, error: "internal" });
        }
    });
    }

    socket.on(SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT, async (value: unknown, acknowledge?: (response: unknown) => void) => {
        const request = SessionRuntimeActivityCloseRequestSchema.safeParse(value);
        if (!request.success || !trustedSessionPublisher || trustedSessionPublisher.binding.sessionId !== request.data.sessionId) {
            acknowledge?.(SessionRuntimeActivityCloseAckSchema.parse({
                status: 'rejected',
                reason: 'invalid_request',
            }));
            return;
        }

        try {
            const closed = await serializeReleasedAlivePersistence(
                trustedSessionPublisher.presence,
                async () => await trustedSessionPublisher.presence.closePublisher({ socket }),
            );
            if (closed.status === 'closed') {
                await publishSessionPublisherClose({
                    sessionId: request.data.sessionId,
                    publisherAccountId: userId,
                    closed,
                    skipSenderConnection: connection,
                });
            }

            if (closed.status === 'closed' || closed.status === 'closed_replay') {
                acknowledge?.(SessionRuntimeActivityCloseAckSchema.parse({
                    status: 'closed',
                    sessionId: request.data.sessionId,
                }));
                return;
            }
            if (closed.status === 'already_inactive') {
                acknowledge?.(SessionRuntimeActivityCloseAckSchema.parse({
                    status: 'already_inactive',
                    sessionId: request.data.sessionId,
                }));
                return;
            }
            if (closed.status === 'superseded') {
                acknowledge?.(SessionRuntimeActivityCloseAckSchema.parse({
                    status: 'rejected',
                    sessionId: request.data.sessionId,
                    reason: 'superseded',
                }));
                return;
            }
            if (closed.status === 'rejected') {
                acknowledge?.(SessionRuntimeActivityCloseAckSchema.parse({
                    status: 'rejected',
                    sessionId: request.data.sessionId,
                    reason: closed.reason,
                }));
                return;
            }
            throw new Error(`Unhandled Runtime Activity close result: ${closed.status}`);
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in ${SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT}: ${error}`);
            acknowledge?.(SessionRuntimeActivityCloseAckSchema.parse({
                status: 'retryable',
                sessionId: request.data.sessionId,
                reason: 'internal',
            }));
        }
    });

}

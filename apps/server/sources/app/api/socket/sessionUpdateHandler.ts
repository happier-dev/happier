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
import { resolveSessionMessageAccountActor } from "@/app/session/messages/projectSessionMessageAccountActors";
import { db } from "@/storage/db";
import {
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1,
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V2,
    SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
    SessionTranscriptObservationAckV1Schema,
    SessionTranscriptObservationCapabilityAckSchema,
    SessionTranscriptObservationCapabilityRequestSchema,
    SessionTranscriptObservationInputSchema,
} from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import { AsyncLock, isLockAdmissionDeadlineExceededError } from "@/utils/runtime/lock";
import { debug, error as logError, log } from "@/utils/logging/log";
import { readHomeConfigEnv } from '@/app/home/settings/homeSettings';
import { readServerConfig, SERVER_CONFIG } from '@happier-dev/protocol';
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { Socket } from "socket.io";
import type { VerifiedEphemeralSessionRunnerPrincipal } from "@happier-dev/protocol/ephemeralRunner/principal";
import type { VerifiedApiTokenPrincipal } from "@/app/auth/auth";
import { admitApiTokenSessionOperation } from "@/app/api/utils/apiTokenRouteAdmission";
import { API_TOKEN_SOCKET_EVENT_ACTIONS } from "@happier-dev/protocol/rpc";
import { hasCurrentSocketCredential } from "./socketCredentialCurrentness";
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
import { resolvePresenceTimeoutConfig } from "@/app/presence/timeout";
import {
    blockPendingDelivery,
    mapPendingMaterializationError,
    materializeNextPendingMessageInTx,
    readSessionPendingState,
    resolveAcceptedPendingDelivery,
    settlePendingInputAdmission,
    type ResolveAcceptedPendingDeliveryResult,
    type SettlePendingInputAdmissionResult,
} from "@/app/session/pending/pendingMessageService";
import { serializePendingMaterializedMessage } from "@/app/session/pending/serializePendingMaterializedMessage";
import { loadPendingActivationPublication } from "@/app/session/pending/publishPendingMutation";
import { normalizeIncomingSessionMessageContent } from "@/app/session/messageContent/normalizeIncomingSessionMessageContent";
import { resolveStructuralSessionAccess } from "@/app/session/access/sessionAccess";
import { readSessionAccessAuthenticationFromSocket } from "@/app/session/access/sessionAccessAuthentication";
import { resolveCurrentSessionRecipientAccountIds } from "@/app/session/access/sessionRecipients";
import { parseSessionMessageSidechainId } from "@/app/session/parseSessionMessageSidechainId";
import {
    SESSION_PENDING_EXECUTION_RUN_MATERIALIZE_NEXT_EVENT_V2,
    SESSION_PENDING_EXECUTION_RUN_ACCEPTED_EVENT_V2,
    SESSION_PENDING_EXECUTION_RUN_BLOCK_EVENT_V2,
    SessionPendingExecutionRunMaterializeNextRequestV2Schema,
    SessionPendingExecutionRunMaterializeNextResponseV2Schema,
    SessionPendingExecutionRunAcceptedRequestV2Schema,
    SessionPendingExecutionRunAcceptedResponseV2Schema,
    SessionPendingExecutionRunBlockRequestV2Schema,
    SessionPendingExecutionRunBlockResponseV2Schema,
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
    SessionRuntimeActivityCloseAckSchema,
    SessionRuntimeActivityCloseRequestSchema,
    SessionRuntimeActivitySnapshotAckSchema,
    SessionRuntimeActivitySnapshotRequestSchema,
    SessionPendingAdmissionSettlementRequestV1Schema,
    SessionPendingAdmissionSettlementResponseV1Schema,
    SessionUserActionRequiredOccurrenceV1Schema,
    SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1,
    SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1,
    SessionFollowObservePendingRequestV1Schema,
    SessionFollowObservePendingResponseV1Schema,
    SessionFollowAcknowledgeRequestV1Schema,
    SessionFollowAcknowledgeResponseV1Schema,
    ACCOUNT_VOICE_FOLLOW_OBSERVE_PENDING_EVENT_V1,
    ACCOUNT_VOICE_FOLLOW_ACKNOWLEDGE_EVENT_V1,
    AccountVoiceFollowObservePendingRequestV1Schema,
    AccountVoiceFollowObservePendingResponseV1Schema,
    AccountVoiceFollowAcknowledgeRequestV1Schema,
    AccountVoiceFollowAcknowledgeResponseV1Schema,
    supportsMachineSessionFollowContextV1,
    SESSION_DISCUSSION_AGENT_POST_EVENT_V1,
    SessionDiscussionAgentPostRequestV1Schema,
    SessionDiscussionAgentPostResponseV1Schema,
    isSessionDiscussionRequestWithinTransportBudgetV1,
} from "@happier-dev/protocol";
import { TranscriptStreamSegmentDeltaEphemeralMessageSchema, TranscriptStreamSegmentEphemeralMessageSchema } from "@happier-dev/protocol/updates";
import type { SessionEndAckResponse } from "@happier-dev/protocol/updates";
import { refreshTrackedSessionAccountBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { didSessionActivityBadgeSignalChange } from "@/app/activity/accountActivityBadge";
import { canPublishFromSessionScopedSocket, canTargetSessionFromSocket } from "./sessionScopedBinding";
import { hasExactCurrentPublisherAuthorityInTx } from "@/app/session/pending/hasExactCurrentPublisherAuthorityInTx";
import {
    acknowledgeSessionFollowFrontierInTx,
    observePendingSessionFollowForDestinationInTx,
} from "@/app/session/follow/sessionFollowEdgeService";
import {
    acknowledgeAccountVoiceFollowInTx,
    observePendingAccountVoiceFollowInTx,
} from "@/app/session/follow/accountFollowService";
import { postSessionDiscussionMessageInTx } from "@/app/session/discussions/mutations";
import type { createSessionPublisherPresence, CurrentSessionPublisherAuthority, SessionPublisherBinding } from "@/app/presence/sessionPublisherPresence";
import type { TeamCredentialExecutionRunCurrentnessResolver } from "@/app/teams/credentials/providerBrokerAdmission";
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

function resolveReadyOwnerActivityDelivery(localId: unknown): "rich_sender" | "home_required" {
    if (typeof localId === "string" && localId.startsWith("activity-ready-home_required:")) {
        return "home_required";
    }
    // Supported predecessor runtimes used opaque local ids and the rich owner
    // sender. Current runtimes explicitly encode sender absence in that already
    // backward-compatible id field.
    return "rich_sender";
}

function scheduleTrackedSessionBadgeRefresh(params: Parameters<typeof refreshTrackedSessionAccountBadgePushes>[0]): void {
    void refreshTrackedSessionAccountBadgePushes(params).catch((error) => {
        log({ module: 'websocket', level: 'error' }, `Error in session badge refresh: ${error}`);
    });
}

const RELEASED_UI_V0_2_0_DIRECT_USER_MESSAGE_SENT_FROM = new Set(["web", "ios", "android", "mac", "pending_send_now", "retry"]);
const PENDING_MATERIALIZATION_REQUEST_BUDGET_MS = 9_000;
const PENDING_MATERIALIZATION_RETRY_AFTER_MS = 1_000;
const ExecutionRunPublicStateSocketSchema = ExecutionRunPublicStateSchema.strip();
const TranscriptStreamSegmentEphemeralSocketMessageSchema = TranscriptStreamSegmentEphemeralMessageSchema.strip();
const TranscriptStreamSegmentDeltaEphemeralSocketMessageSchema = TranscriptStreamSegmentDeltaEphemeralMessageSchema.strip();

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
    recipientCursors: readonly Readonly<{ accountId: string; cursor: number }>[];
}>): Promise<void> {
    const { sessionId, ...rawProjection } = params.data;
    const [session, pendingActivationAuthorization] = await Promise.all([
        loadSessionTranscriptPublicationRecipientProjection(sessionId),
        loadPendingActivationPublication(sessionId),
    ]);
    if (!session) return;
    await Promise.all(params.recipientCursors.map(async ({ accountId, cursor }) => {
        const projection = projectSessionTranscriptPublicationPendingProjection(
            { ...rawProjection, pendingActivationAuthorization },
            session,
            accountId,
        );
        if (projection.kind === "suppress") return;
        await eventRouter.emitUpdate({
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
        const recipientCursors = result.recipientCursors ?? [];
        await emitPublicationSafePendingChanged({
            data: {
                sessionId: params.sessionId,
                pendingCount: result.pendingCount ?? 0,
                ...(typeof result.pendingBlockedCount === "number" ? { pendingBlockedCount: result.pendingBlockedCount } : {}),
                pendingVersion: result.pendingVersion ?? 0,
                changedByAccountId: params.actorUserId,
            },
            recipientCursors,
        });
        await refreshTrackedSessionAccountBadgePushes({
            badgeAttentionChanged: result.badgeAttentionChanged ?? false,
            sessionId: params.sessionId,
        });
        return;
    }
    if (result.didResolve !== true || !result.message) return;

    const recipientCursorsMessage = result.recipientCursorsMessage ?? [];
    const recipientCursorsPending = result.recipientCursorsPending ?? result.recipientCursors;
    const resolvedMessage = {
        ...result.message,
        accountActor: await resolveSessionMessageAccountActor(result.message),
    };
    await Promise.all(recipientCursorsMessage.map(async ({ accountId, cursor }) => {
        await eventRouter.emitUpdate({
            userId: accountId,
            payload: buildPendingResolvedMessageUpdate(
                resolvedMessage,
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
        recipientCursors: recipientCursorsPending,
    });
    await refreshTrackedSessionAccountBadgePushes({
        badgeAttentionChanged: result.badgeAttentionChanged,
        sessionId: params.sessionId,
    });
}

async function publishPendingInputAdmissionSettlement(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    result: SettlePendingInputAdmissionResult;
}>): Promise<void> {
    const { result } = params;
    if (!result.ok) return;
    const settledMessage = result.message
        ? {
            ...result.message,
            accountActor: await resolveSessionMessageAccountActor(result.message),
        }
        : null;
    await Promise.all(result.recipientCursorsMessage.map(async ({ accountId, cursor }) => {
        if (!settledMessage) return;
        await eventRouter.emitUpdate({
            userId: accountId,
            payload: buildPendingResolvedMessageUpdate(
                settledMessage,
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
        recipientCursors: result.recipientCursorsPending,
    });
    await refreshTrackedSessionAccountBadgePushes({
        badgeAttentionChanged: result.badgeAttentionChanged,
        sessionId: params.sessionId,
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
function resolveReleasedAliveFailureHoldMs(failureStreak: number, maxBackoffMs: number): number {
    if (failureStreak <= 1) return 0;
    return Math.min(
        maxBackoffMs,
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
    admission?: Readonly<{
        principalKind: "ephemeral-session-runner";
        principal: VerifiedEphemeralSessionRunnerPrincipal;
    }> | Readonly<{
        principalKind: "api-token-session-viewer";
        principal: VerifiedApiTokenPrincipal;
        resolveSessionMachine?: (input: Readonly<{ accountId: string; sessionId: string }>) => Promise<string | null>;
    }>,
    dependencies?: Readonly<{
        resolveExecutionRunCurrentness: TeamCredentialExecutionRunCurrentnessResolver;
    }>,
) {
    const registerSessionEvent = (event: Parameters<Socket["on"]>[0], listener: Parameters<Socket["on"]>[1]) => {
        if (admission?.principalKind === "api-token-session-viewer" && event !== "disconnect"
            && !Object.prototype.hasOwnProperty.call(API_TOKEN_SOCKET_EVENT_ACTIONS, event)) return socket;
        return socket.on(event, listener);
    };
    let legacyAliveInFlight = false;
    // Bound retained observations by expiry without changing the default settled-write cadence.
    const observationRefreshWindowMs = resolvePresenceTimeoutConfig().sessionTimeoutMs / 2;
    let nextLegacyAliveAttemptAtMs: number | null = null;
    let legacyAliveFailureStreak = 0;
    let pendingLegacyAlive: Readonly<{
        observedAtMs: number;
        record: Parameters<typeof recordSessionAlive>[0];
    }> | null = null;
    let legacyAliveTimer: ReturnType<typeof setTimeout> | null = null;
    let legacyAliveStopped = false;
    const clearPendingLegacyAlive = (): void => {
        pendingLegacyAlive = null;
        if (legacyAliveTimer !== null) clearTimeout(legacyAliveTimer);
        legacyAliveTimer = null;
    };
    const stopLegacyAlive = (): void => {
        legacyAliveStopped = true;
        clearPendingLegacyAlive();
    };
    registerSessionEvent("disconnect", stopLegacyAlive);
    // The authenticated publisher reports whether it owns rich delivery to the
    // Account owner. Keep that fact with this exact socket/publisher authority so
    // later committed turn failures use the same centralized Activity routing
    // decision. Released persistent publishers omitted the field but did own
    // the rich sender; ephemeral Runner Machines are still rejected as rich
    // senders by the Activity owner after it validates the exact current
    // publisher authority and Machine kind.
    let ownerActivityDelivery: "rich_sender" | "home_required" | undefined;

    const resolveSessionActivityRuntimeComposition = async (
        sessionId: string,
        delivery: "rich_sender" | "home_required",
    ): Promise<Readonly<{
        publisherAuthority: CurrentSessionPublisherAuthority;
        ownerActivityDelivery: "rich_sender" | "home_required";
    }> | undefined> => {
        const publisher = trustedSessionPublisher;
        if (!publisher || publisher.binding.sessionId !== sessionId) return undefined;
        const publisherAuthority = await publisher.presence.runAsCurrentPublisher({
            socket,
            operation: async (authority) => authority,
        });
        return publisherAuthority ? { publisherAuthority, ownerActivityDelivery: delivery } : undefined;
    };

    registerSessionEvent(
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

    registerSessionEvent(SESSION_DISCUSSION_AGENT_POST_EVENT_V1, async (data: unknown, callback?: (response: unknown) => void) => {
        const respond = (response: unknown) => callback?.(SessionDiscussionAgentPostResponseV1Schema.parse(response));
        const request = SessionDiscussionAgentPostRequestV1Schema.safeParse(data);
        if (!await isServerFeatureEnabledForHome("sessions.conversations")) {
            respond({ ok: false, v: 1, error: "session_discussions_unavailable" });
            return;
        }
        if (!request.success) {
            respond({ ok: false, v: 1, error: "session_discussion_invalid_content" });
            return;
        }
        // The trusted publisher carrier accepts exactly the same stored
        // Discussion request budget as the canonical HTTP route. Provenance
        // stamping is a transport distinction, not a larger body allowance.
        if (!isSessionDiscussionRequestWithinTransportBudgetV1(request.data.request)) {
            respond({ ok: false, v: 1, error: "session_discussion_invalid_content" });
            return;
        }
        if (
            !trustedSessionPublisher
            || trustedSessionPublisher.binding.sessionId !== request.data.sessionId
            || !canTargetSessionFromSocket({ socket, connection, sessionId: request.data.sessionId })
        ) {
            respond({ ok: false, v: 1, error: "session_discussion_post_denied" });
            return;
        }
        try {
            const result = await trustedSessionPublisher.presence.runAsCurrentPublisherInTx({
                socket,
                deadlineAtMs: Date.now() + 5_000,
                operation: async (authority, tx) => {
                    if (!await hasExactCurrentPublisherAuthorityInTx(
                        tx,
                        authority,
                        userId,
                        request.data.sessionId,
                    )) {
                        return null;
                    }
                    return await postSessionDiscussionMessageInTx(tx, {
                        actorAccountId: userId,
                        sessionId: request.data.sessionId,
                        discussionId: request.data.discussionId,
                        request: request.data.request,
                        producer: {
                            v: 1,
                            kind: "agent",
                            sessionId: request.data.sessionId,
                            ...(request.data.runId ? { runId: request.data.runId } : {}),
                            ...(request.data.toolCallId ? { toolCallId: request.data.toolCallId } : {}),
                        },
                        authentication: readSessionAccessAuthenticationFromSocket(socket),
                    });
                },
            });
            if (result === null) {
                respond({ ok: false, v: 1, error: "session_discussion_post_denied" });
                return;
            }
            if (!result.ok) {
                respond({ ok: false, v: 1, error: result.error });
                return;
            }
            respond({ ok: true, v: 1, value: result.value });
        } catch (error) {
            log({ module: "websocket", level: "warn" }, `Session Discussion Agent post failed: ${error}`);
            respond({ ok: false, v: 1, error: "session_discussions_unavailable" });
        }
    });

    registerSessionEvent(SESSION_FOLLOW_OBSERVE_PENDING_EVENT_V1, async (data: unknown, callback?: (response: unknown) => void) => {
        const respond = (response: unknown) => callback?.(SessionFollowObservePendingResponseV1Schema.parse(response));
        const request = SessionFollowObservePendingRequestV1Schema.safeParse(data);
        if (!await isServerFeatureEnabledForHome("sessions.following")) {
            respond({ ok: false, v: 1, error: "unsupported" });
            return;
        }
        if (!request.success || !trustedSessionPublisher || trustedSessionPublisher.binding.sessionId !== request.data.sessionId || !canTargetSessionFromSocket({ socket, connection, sessionId: request.data.sessionId })) {
            respond({ ok: false, v: 1, error: request.success ? "forbidden" : "invalid_request" });
            return;
        }
        try {
            const result = await trustedSessionPublisher.presence.runAsCurrentPublisherInTx({
                socket, deadlineAtMs: Date.now() + 5_000,
                operation: async (authority, tx) => {
                    if (!await hasExactCurrentPublisherAuthorityInTx(tx, authority, userId, request.data.sessionId)) return null;
                    const machine = await tx.machine.findUnique({
                        where: { id: authority.machineId },
                        select: { operationProtocolCapabilities: true },
                    });
                    if (!supportsMachineSessionFollowContextV1(machine?.operationProtocolCapabilities)) {
                        return { unsupported: true as const };
                    }
                    const session = await tx.session.findUnique({ where: { id: request.data.sessionId }, select: { publisherGeneration: true } });
                    if (!session) return null;
                    const observation = await observePendingSessionFollowForDestinationInTx(tx, {
                        includeReportsTo: request.data.includeReportsTo,
                        principal: admission?.principalKind === "ephemeral-session-runner"
                            ? admission.principal
                            : {
                            kind: "destination_runtime",
                            destinationRuntimeAccountId: userId,
                            authentication: readSessionAccessAuthenticationFromSocket(socket),
                        },
                        destinationSessionId: request.data.sessionId,
                    });
                    return { publisherGeneration: session.publisherGeneration, ...observation };
                },
            });
            if (result === null) { respond({ ok: false, v: 1, error: "forbidden" }); return; }
            if ('unsupported' in result) { respond({ ok: false, v: 1, error: "unsupported" }); return; }
            respond({ ok: true, v: 1, sessionId: request.data.sessionId, publisherGeneration: result.publisherGeneration.toString(), currentSourceSessionIds: result.currentSourceSessionIds, observations: result.observations });
        } catch (error) {
            log({ module: "websocket", level: "warn" }, `Session Follow observation failed: ${error}`);
            respond({ ok: false, v: 1, error: "internal" });
        }
    });

    registerSessionEvent(SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1, async (data: unknown, callback?: (response: unknown) => void) => {
        const respond = (response: unknown) => callback?.(SessionFollowAcknowledgeResponseV1Schema.parse(response));
        const request = SessionFollowAcknowledgeRequestV1Schema.safeParse(data);
        if (!await isServerFeatureEnabledForHome("sessions.following")) {
            respond({ ok: false, v: 1, error: "unsupported" });
            return;
        }
        if (!request.success) { respond({ ok: false, v: 1, error: "invalid_request" }); return; }
        const destinationSessionId = request.data.destinationSessionId;
        if (!trustedSessionPublisher || trustedSessionPublisher.binding.sessionId !== destinationSessionId || !canTargetSessionFromSocket({ socket, connection, sessionId: destinationSessionId })) {
            respond({ ok: false, v: 1, error: "forbidden" }); return;
        }
        try {
            const result = await trustedSessionPublisher.presence.runAsCurrentPublisherInTx({
                socket, deadlineAtMs: Date.now() + 5_000,
                operation: async (authority, tx) => {
                    if (!await hasExactCurrentPublisherAuthorityInTx(tx, authority, userId, destinationSessionId)) return { ok: false as const, rejection: "stale_publisher_generation" as const };
                    const machine = await tx.machine.findUnique({
                        where: { id: authority.machineId },
                        select: { operationProtocolCapabilities: true },
                    });
                    if (!supportsMachineSessionFollowContextV1(machine?.operationProtocolCapabilities)) {
                        return { ok: false as const, rejection: "unsupported" as const };
                    }
                    return await acknowledgeSessionFollowFrontierInTx(tx, {
                        principal: admission?.principalKind === "ephemeral-session-runner"
                            ? admission.principal
                            : {
                            kind: "destination_runtime",
                            destinationRuntimeAccountId: userId,
                            authentication: readSessionAccessAuthenticationFromSocket(socket),
                        },
                        destinationSessionId, sourceSessionId: request.data.sourceSessionId,
                        edgeKind: request.data.edgeKind, attachedAt: request.data.attachedAt,
                        expectedPublisherGeneration: BigInt(request.data.expectedPublisherGeneration),
                        expected: request.data.expected, observed: request.data.observed, consumed: request.data.consumed,
                        acceptance: request.data.acceptance,
                    });
                },
            });
            if (result === null) { respond({ ok: false, v: 1, error: "forbidden" }); return; }
            if (!result.ok) { respond({ ok: false, v: 1, error: result.rejection }); return; }
            respond({ ok: true, v: 1, destinationSessionId, sourceSessionId: request.data.sourceSessionId, delivered: result.delivered });
        } catch (error) {
            log({ module: "websocket", level: "warn" }, `Session Follow acknowledgment failed: ${error}`);
            respond({ ok: false, v: 1, error: "internal" });
        }
    });

    registerSessionEvent(ACCOUNT_VOICE_FOLLOW_OBSERVE_PENDING_EVENT_V1, async (data: unknown, callback?: (response: unknown) => void) => {
        const respond = (response: unknown) => callback?.(AccountVoiceFollowObservePendingResponseV1Schema.parse(response));
        if (admission?.principalKind === "ephemeral-session-runner") {
            respond({ ok: false, v: 1, error: "forbidden" });
            return;
        }
        const request = AccountVoiceFollowObservePendingRequestV1Schema.safeParse(data);
        if (!await isServerFeatureEnabledForHome("sessions.following")) {
            respond({ ok: false, v: 1, error: "unsupported" });
            return;
        }
        if (!request.success || !trustedSessionPublisher || trustedSessionPublisher.binding.sessionId !== request.data.voiceSessionId
            || !canTargetSessionFromSocket({ socket, connection, sessionId: request.data.voiceSessionId })) {
            respond({ ok: false, v: 1, error: request.success ? "forbidden" : "invalid_request" });
            return;
        }
        try {
            const currentRun = await dependencies?.resolveExecutionRunCurrentness({
                executionRunId: request.data.executionRunId,
                requestingAccountId: userId,
                workerMachineId: trustedSessionPublisher.binding.machineId,
                expectedIntent: 'voice_agent',
                expectedOccurrenceId: null,
            });
            if (!currentRun?.ok || currentRun.intent !== 'voice_agent'
                || currentRun.parentSessionId !== request.data.voiceSessionId) {
                respond({ ok: false, v: 1, error: "forbidden" });
                return;
            }
            const result = await trustedSessionPublisher.presence.runAsCurrentPublisherInTx({
                socket, deadlineAtMs: Date.now() + 5_000,
                operation: async (authority, tx) => {
                    if (!await hasExactCurrentPublisherAuthorityInTx(tx, authority, userId, request.data.voiceSessionId)) return null;
                    const machine = await tx.machine.findUnique({
                        where: { id: authority.machineId },
                        select: { operationProtocolCapabilities: true },
                    });
                    if (!supportsMachineSessionFollowContextV1(machine?.operationProtocolCapabilities)) {
                        return { unsupported: true as const };
                    }
                    const session = await tx.session.findUnique({ where: { id: request.data.voiceSessionId }, select: { publisherGeneration: true } });
                    if (!session) return null;
                    const observations = await observePendingAccountVoiceFollowInTx(tx, {
                        accountId: userId,
                        voiceSessionId: request.data.voiceSessionId,
                        authentication: readSessionAccessAuthenticationFromSocket(socket),
                        runtimeAuthority: {
                            executionRunId: request.data.executionRunId,
                            occurrenceId: currentRun.occurrenceId,
                            parentSessionId: request.data.voiceSessionId,
                            intent: 'voice_agent',
                            runtimeState: currentRun.runtimeState,
                        },
                    });
                    if (observations === null) return null;
                    return {
                        publisherGeneration: session.publisherGeneration,
                        executionRunOccurrenceId: currentRun.occurrenceId,
                        observations,
                    };
                },
            });
            if (result === null) { respond({ ok: false, v: 1, error: "forbidden" }); return; }
            if ('unsupported' in result) { respond({ ok: false, v: 1, error: "unsupported" }); return; }
            respond({ ok: true, v: 1, voiceSessionId: request.data.voiceSessionId,
                publisherGeneration: result.publisherGeneration.toString(),
                executionRunOccurrenceId: result.executionRunOccurrenceId,
                observations: result.observations });
        } catch (error) {
            log({ module: "websocket", level: "warn" }, `Account Voice Follow observation failed: ${error}`);
            respond({ ok: false, v: 1, error: "internal" });
        }
    });

    registerSessionEvent(ACCOUNT_VOICE_FOLLOW_ACKNOWLEDGE_EVENT_V1, async (data: unknown, callback?: (response: unknown) => void) => {
        const respond = (response: unknown) => callback?.(AccountVoiceFollowAcknowledgeResponseV1Schema.parse(response));
        if (admission?.principalKind === "ephemeral-session-runner") {
            respond({ ok: false, v: 1, error: "forbidden" });
            return;
        }
        const request = AccountVoiceFollowAcknowledgeRequestV1Schema.safeParse(data);
        if (!await isServerFeatureEnabledForHome("sessions.following")) {
            respond({ ok: false, v: 1, error: "unsupported" });
            return;
        }
        if (!request.success || !trustedSessionPublisher || trustedSessionPublisher.binding.sessionId !== request.data.voiceSessionId
            || !canTargetSessionFromSocket({ socket, connection, sessionId: request.data.voiceSessionId })) {
            respond({ ok: false, v: 1, error: request.success ? "forbidden" : "invalid_request" });
            return;
        }
        try {
            const currentRun = await dependencies?.resolveExecutionRunCurrentness({
                executionRunId: request.data.executionRunId,
                requestingAccountId: userId,
                workerMachineId: trustedSessionPublisher.binding.machineId,
                expectedIntent: 'voice_agent',
                expectedOccurrenceId: request.data.expectedExecutionRunOccurrenceId,
            });
            if (!currentRun?.ok || currentRun.intent !== 'voice_agent'
                || currentRun.parentSessionId !== request.data.voiceSessionId) {
                respond({ ok: false, v: 1, error: "forbidden" });
                return;
            }
            const result = await trustedSessionPublisher.presence.runAsCurrentPublisherInTx({
                socket, deadlineAtMs: Date.now() + 5_000,
                operation: async (authority, tx) => {
                    if (!await hasExactCurrentPublisherAuthorityInTx(tx, authority, userId, request.data.voiceSessionId)) return null;
                    const machine = await tx.machine.findUnique({
                        where: { id: authority.machineId },
                        select: { operationProtocolCapabilities: true },
                    });
                    if (!supportsMachineSessionFollowContextV1(machine?.operationProtocolCapabilities)) {
                        return { ok: false as const, rejection: "unsupported" as const };
                    }
                    const session = await tx.session.findUnique({ where: { id: request.data.voiceSessionId }, select: { publisherGeneration: true } });
                    if (!session || session.publisherGeneration !== BigInt(request.data.expectedPublisherGeneration)) {
                        return { ok: false as const, rejection: 'stale_publisher_generation' as const };
                    }
                    return await acknowledgeAccountVoiceFollowInTx(tx, {
                        accountId: userId,
                        voiceSessionId: request.data.voiceSessionId,
                        sourceSessionId: request.data.sourceSessionId,
                        expected: request.data.expected,
                        observed: request.data.observed,
                        consumed: request.data.consumed,
                        acceptance: request.data.acceptance,
                        authentication: readSessionAccessAuthenticationFromSocket(socket),
                        runtimeAuthority: {
                            executionRunId: request.data.executionRunId,
                            occurrenceId: currentRun.occurrenceId,
                            parentSessionId: request.data.voiceSessionId,
                            intent: 'voice_agent',
                            runtimeState: currentRun.runtimeState,
                        },
                    });
                },
            });
            if (result === null) { respond({ ok: false, v: 1, error: "forbidden" }); return; }
            if (!result.ok) { respond({ ok: false, v: 1, error: result.rejection }); return; }
            respond({ ok: true, v: 1, voiceSessionId: request.data.voiceSessionId,
                sourceSessionId: request.data.sourceSessionId, delivered: result.delivered });
        } catch (error) {
            log({ module: "websocket", level: "warn" }, `Account Voice Follow acknowledgment failed: ${error}`);
            respond({ ok: false, v: 1, error: "internal" });
        }
    });

    const publishRuntimeActivitySnapshotResult = async (
        sid: string,
        result: Exclude<Awaited<ReturnType<TrustedSessionPublisher["presence"]["publishSnapshot"]>>, { status: "rejected" }>,
    ): Promise<{ didWrite: boolean }> => {
        const didWrite = result.status === "applied";
        const registrationActiveAt = "activeAt" in result ? result.activeAt.getTime() : null;
        if (didWrite || registrationActiveAt !== null) {
            const session = await loadSessionTranscriptPublicationRecipientProjection(sid);
            if (session) await Promise.all(result.recipientCursors.map(async ({ accountId, cursor }) => {
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
                await eventRouter.emitUpdate({
                    userId: accountId,
                    payload,
                    recipientFilter: { type: "all-interested-in-session", sessionId: sid },
                    skipSenderConnection: accountId === userId ? connection : undefined,
                });
            }));
        }
        if (result.status === "applied" && result.becameIdle === true) {
            const pendingState = await readSessionPendingState({
                actorUserId: userId,
                sessionId: sid,
                authentication: readSessionAccessAuthenticationFromSocket(socket),
            });
            if (pendingState.ok) {
                const session = await loadSessionTranscriptPublicationRecipientProjection(sid);
                if (session) await Promise.all(result.recipientCursors.map(async ({ accountId, cursor }) => {
                    const pendingProjection = projectSessionTranscriptPublicationPendingProjection(
                        {
                            pendingCount: pendingState.pendingCount,
                            pendingBlockedCount: pendingState.pendingBlockedCount,
                            pendingVersion: pendingState.pendingVersion,
                            changedByAccountId: userId,
                            pendingActivationAuthorization: await loadPendingActivationPublication(sid),
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
                    await eventRouter.emitUpdate({
                        userId: accountId,
                        payload,
                        recipientFilter: { type: "all-interested-in-session", sessionId: sid },
                    });
                }));
            }
        }
        if ("badgeAttentionChanged" in result && result.badgeAttentionChanged) {
            scheduleTrackedSessionBadgeRefresh({
                badgeAttentionChanged: true,
                sessionId: sid,
            });
        }
        return { didWrite };
    };

    registerSessionEvent(SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1, async (data: unknown, callback?: (response: unknown) => void) => {
        const respond = (response: unknown) => callback?.(SessionTranscriptObservationCapabilityAckSchema.parse(response));
        try {
            const request = SessionTranscriptObservationCapabilityRequestSchema.safeParse(data);
            const sessionId = request.success ? request.data.sessionId : null;
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
                capability: request.success && request.data.v === 2
                    ? SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V2 : SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1,
            });
        } catch (error) {
            log({ module: "websocket", level: "warn" }, `Transcript observation capability negotiation failed: ${error}`);
            respond({ ok: false, error: "internal" });
        }
    });

    registerSessionEvent(SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1, async (data: unknown, callback?: (response: unknown) => void) => {
        const respond = (response: unknown) => callback?.(SessionTranscriptObservationAckV1Schema.parse(response));
        try {
            const parsed = SessionTranscriptObservationInputSchema.safeParse(data);
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
                    inputAdmission: "transcriptOnly",
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
                    ...(observation.v === 2 && observation.surfaceItemReference !== undefined
                        ? { trustedSurfaceItemReference: observation.surfaceItemReference } : {}),
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
            // Runtime observation never infers a human actor from `actorUserId`
            // or `messageRole`; the receipt-derived projector answers, and it
            // answers explicit null for machine-observed rows.
            const observedMessage = {
                ...result.message,
                accountActor: await resolveSessionMessageAccountActor(result.message),
            };
            await Promise.all(result.recipientCursors.map(async ({ accountId, cursor }) => {
                const options = result.attentionImpact ? { attentionImpact: result.attentionImpact } : undefined;
                const payload = result.didWrite
                    ? buildNewMessageUpdate(observedMessage, observation.sessionId, cursor, randomKeyNaked(12), options)
                    : buildMessageUpdatedUpdate(observedMessage, observation.sessionId, cursor, randomKeyNaked(12), options);
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload,
                    recipientFilter: { type: "all-interested-in-session", sessionId: observation.sessionId },
                });
            }));
            if (result.didWrite) {
                const runtimeComposition = await resolveSessionActivityRuntimeComposition(
                    observation.sessionId,
                    resolveReadyOwnerActivityDelivery(observation.localId),
                );
                await publishSessionReadyProjectionUpdate({
                    sessionId: observation.sessionId,
                    readyProjection: result.readyProjection,
                    ...(runtimeComposition ? { runtimeComposition } : {}),
                });
            }
            scheduleTrackedSessionBadgeRefresh({
                badgeAttentionChanged: result.badgeAttentionChanged,
                sessionId: observation.sessionId,
            });
        } catch (error) {
            log({ module: "websocket", level: "warn" }, `Transcript observation failed: ${error}`);
            respond({ ok: false, error: "internal" });
        }
    });

    registerSessionEvent('update-metadata', async (data: any, callback: (response: any) => void) => {
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
                authentication: readSessionAccessAuthenticationFromSocket(socket),
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

            if (result.privateReadCursor) {
                await publishSessionReadCursorUpdate({
                    sessionId: sid,
                    ...result.privateReadCursor,
                    authentication: readSessionAccessAuthenticationFromSocket(socket),
                    skipSenderConnection: connection,
                });
            }
            const metadataUpdate = {
                value: result.metadata,
                version: result.version,
            };
            await Promise.all(result.recipientCursors
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
            scheduleTrackedSessionBadgeRefresh({
                badgeAttentionChanged: result.badgeAttentionChanged,
                sessionId: sid,
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

    registerSessionEvent('update-state', async (data: any, callback: (response: any) => void) => {
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
            const reportedOwnerActivityDelivery =
                activitySummaryV1?.ownerActivityDelivery === "rich_sender"
                || activitySummaryV1?.ownerActivityDelivery === "home_required"
                    ? activitySummaryV1.ownerActivityDelivery
                    : undefined;
            const rawUserActionRequiredOccurrences =
                activitySummaryV1?.newUserActionRequiredOccurrences;
            const parsedUserActionRequiredOccurrences =
                rawUserActionRequiredOccurrences === undefined
                    ? null
                    : SessionUserActionRequiredOccurrenceV1Schema.array().safeParse(
                        rawUserActionRequiredOccurrences,
                    );
            // Validate input
            if (
                !sid
                || (typeof agentState !== 'string' && agentState !== null)
                || typeof expectedVersion !== 'number'
                || (parsedUserActionRequiredOccurrences !== null
                    && !parsedUserActionRequiredOccurrences.success)
            ) {
                if (callback) {
                    callback({ result: 'error' });
                }
                return;
            }
            if (!canTargetSessionFromSocket({ socket, connection, sessionId: sid })) {
                callback?.({ result: 'forbidden' });
                return;
            }

            const runtimeComposition = reportedOwnerActivityDelivery
                ? await resolveSessionActivityRuntimeComposition(sid, reportedOwnerActivityDelivery)
                : undefined;
            const updateAgentState = async (
                publisherAuthority?: import("@/app/presence/sessionPublisherPresence").CurrentSessionPublisherAuthority,
            ) => await updateSessionAgentState({
                    actorUserId: userId,
                    sessionId: sid,
                    expectedVersion,
                    agentStateCiphertext: agentState,
                    ...(typeof pendingPermissionRequestCount === "number" ? { pendingPermissionRequestCount } : {}),
                    ...(typeof pendingUserActionRequestCount === "number" ? { pendingUserActionRequestCount } : {}),
                    ...(pendingRequestNewestCreatedAt !== undefined ? { pendingRequestNewestCreatedAt } : {}),
                    ...(parsedUserActionRequiredOccurrences?.success
                        ? { userActionRequiredOccurrences: parsedUserActionRequiredOccurrences.data }
                        : {}),
                    ...(runtimeComposition ? { runtimeComposition } : {}),
                    ...(admission?.principalKind === "ephemeral-session-runner" && publisherAuthority
                        ? {
                            restrictedRuntimePrecondition: {
                                publisherAuthority,
                                principal: admission.principal,
                            },
                        }
                        : {}),
                });
            const publisher = trustedSessionPublisher;
            const result = admission?.principalKind === "ephemeral-session-runner"
                ? publisher && publisher.binding.sessionId === sid
                    ? await publisher.presence.runAsCurrentPublisher({
                        socket,
                        operation: updateAgentState,
                    })
                    : null
                : await updateAgentState();

            if (result === null) {
                callback?.({ result: "forbidden" });
                return;
            }

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

            if (trustedSessionPublisher?.binding.sessionId === sid) {
                ownerActivityDelivery = reportedOwnerActivityDelivery ?? "rich_sender";
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
            await Promise.all(result.recipientCursors
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
            scheduleTrackedSessionBadgeRefresh({
                badgeAttentionChanged: result.badgeAttentionChanged,
                sessionId: sid,
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

    registerSessionEvent(SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT, async (value: unknown, acknowledge?: (response: unknown) => void) => {
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

    registerSessionEvent("session-turn-mutation", async (data: unknown, callback: (response: any) => void) => {
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

            const runtimeComposition = await resolveSessionActivityRuntimeComposition(
                parsed.data.sessionId,
                ownerActivityDelivery ?? "rich_sender",
            );
            const result = await applySessionTurnMutation({
                actorUserId: userId,
                mutation: parsed.data,
                authentication: readSessionAccessAuthenticationFromSocket(socket),
                ...(runtimeComposition ? { runtimeComposition } : {}),
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

    registerSessionEvent('update-read-cursor', async (data: any, callback: (response: any) => void) => {
        if (admission?.principalKind === "ephemeral-session-runner") {
            callback?.({ result: 'forbidden' });
            return;
        }
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
                authentication: readSessionAccessAuthenticationFromSocket(socket),
            });

            if (!result.ok) {
                if (result.error === 'forbidden') {
                    callback?.({ result: 'forbidden' });
                    return;
                }
                callback?.({ result: 'error' });
                return;
            }

            const viewer = await publishSessionReadCursorUpdate({
                sessionId: sid,
                ...result,
                authentication: readSessionAccessAuthenticationFromSocket(socket),
                skipSenderConnection: connection,
            });

            callback?.({
                result: 'success',
                ...(viewer ? { viewer } : {}),
                ...(typeof result.lastViewedSessionSeq === "number" ? { lastViewedSessionSeq: result.lastViewedSessionSeq } : {}),
                ...(manualOperation ? { didChange: result.didChange, readState: result.readState } : {}),
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in update-read-cursor: ${error}`);
            callback?.({ result: 'error' });
        }
    });
    const flushLegacyAlive = async (): Promise<void> => {
        const publisher = trustedSessionPublisher;
        if (!publisher || legacyAliveStopped || legacyAliveInFlight || pendingLegacyAlive === null) return;
        if (nextLegacyAliveAttemptAtMs !== null && Date.now() < nextLegacyAliveAttemptAtMs) {
            if (legacyAliveTimer === null) {
                legacyAliveTimer = setTimeout(async () => {
                    legacyAliveTimer = null;
                    await flushLegacyAlive();
                }, nextLegacyAliveAttemptAtMs - Date.now());
                legacyAliveTimer.unref();
            }
            return;
        }
        const observation = pendingLegacyAlive;
        const sid = observation.record.sessionId;
        clearPendingLegacyAlive();
        legacyAliveInFlight = true;
        let legacyAlivePersisted = false;
        try {
            const presenceResult = await serializeReleasedAlivePersistence(
                publisher.presence,
                async () => {
                    if (legacyAliveStopped) return { status: "superseded" } as const;
                    const observedAt = new Date(observation.observedAtMs);
                    const touched = await publisher.presence.touchPublisher({ socket, observedAt });
                    return touched.status === "unregistered" && !legacyAliveStopped
                        ? await publisher.presence.registerPublisher({
                            socket,
                            binding: publisher.binding,
                            completeActivitySnapshot: { state: "unknown", activeCount: 0 },
                            observedAt,
                        })
                        : touched;
                },
            );
            if (presenceResult.status !== "touched" && presenceResult.status !== "registered") {
                return;
            }
            legacyAlivePersisted = true;
            legacyAliveFailureStreak = 0;
            nextLegacyAliveAttemptAtMs = Math.min(
                Date.now() + RELEASED_ALIVE_PERSISTENCE_INTERVAL_MS,
                observation.observedAtMs + observationRefreshWindowMs,
            );

            await recordSessionAlive(observation.record);

            const session = await loadSessionTranscriptPublicationRecipientProjection(sid);
            if (session) await Promise.all(
                presenceResult.recipientCursors.map(async ({ accountId, cursor }) => {
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
                            pendingActivationAuthorization: null,
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
                scheduleTrackedSessionBadgeRefresh({
                    badgeAttentionChanged: true,
                    sessionId: sid,
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
            if (!legacyAlivePersisted) {
                legacyAliveFailureStreak += 1;
                nextLegacyAliveAttemptAtMs = Date.now() + resolveReleasedAliveFailureHoldMs(
                    legacyAliveFailureStreak,
                    Math.min(RELEASED_ALIVE_PERSISTENCE_INTERVAL_MS, observationRefreshWindowMs),
                );
            }
            legacyAliveInFlight = false;
            await flushLegacyAlive();
        }
    };

    registerSessionEvent('session-alive', async (data: {
        sid: string;
        time: number;
        thinking?: boolean;
        latestTurnStatus?: unknown;
        latestTurnStatusObservedAt?: unknown;
    }) => {
        websocketEventsCounter.inc({ event_type: 'session-alive' });
        sessionAliveEventsCounter.inc();
        if (!data || typeof data.time !== 'number' || !data.sid || legacyAliveStopped) return;
        if (!trustedSessionPublisher || trustedSessionPublisher.binding.sessionId !== data.sid) return;
        const observedAtMs = Date.now();
        const timestamp = Math.min(data.time, observedAtMs);
        if (timestamp < observedAtMs - 1000 * 60 * 10) return;
        const latestTurnStatus = PrimaryTurnStatusV1Schema.safeParse(data.latestTurnStatus);
        const latestTurnStatusObservedAt = typeof data.latestTurnStatusObservedAt === "number"
            && Number.isFinite(data.latestTurnStatusObservedAt)
            && data.latestTurnStatusObservedAt >= 0
            ? Math.trunc(data.latestTurnStatusObservedAt)
            : null;
        pendingLegacyAlive = {
            observedAtMs,
            record: {
                accountId: userId,
                sessionId: data.sid,
                timestamp,
                ...(latestTurnStatus.success && latestTurnStatusObservedAt !== null
                    ? { latestTurnStatus: latestTurnStatus.data, latestTurnStatusObservedAt }
                    : {}),
            },
        };
        await flushLegacyAlive();
    });

    registerSessionEvent('execution-run-updated', async (data: any) => {
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

            const access = await resolveStructuralSessionAccess(db, { accountId: userId, sessionId: sid });
            if (access?.level !== 'owner') return;

            // Strip unknown fields before rebroadcasting (clients treat this as a hint; keep the payload tight).
            const parsedRun = ExecutionRunPublicStateSocketSchema.safeParse(runRaw);
            if (!parsedRun.success) {
                return;
            }

            const recipientAccountIds = await resolveCurrentSessionRecipientAccountIds({ sessionId: sid });
            if (!recipientAccountIds || recipientAccountIds.length === 0) return;
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
            for (const participantUserId of recipientAccountIds) {
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

    registerSessionEvent('transcript-stream-segment', async (data: any) => {
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

            const access = await resolveStructuralSessionAccess(db, { accountId: userId, sessionId: sid });
            if (access?.level !== 'owner') return;

            const parsedMessage = TranscriptStreamSegmentEphemeralSocketMessageSchema.safeParse(data?.message);
            if (!parsedMessage.success) {
                return;
            }

            const recipientAccountIds = await resolveCurrentSessionRecipientAccountIds({ sessionId: sid });
            if (!recipientAccountIds || recipientAccountIds.length === 0) return;
            const publication = await loadSessionTranscriptPublicationRecipientProjection(sid);
            if (!publication) return;

            const payload = {
                type: 'transcript-stream-segment' as const,
                sessionId: sid,
                message: parsedMessage.data,
            };

            for (const participantUserId of recipientAccountIds) {
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
    registerSessionEvent('transcript-stream-segment-delta', async (data: any) => {
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

            const access = await resolveStructuralSessionAccess(db, { accountId: userId, sessionId: sid });
            if (access?.level !== 'owner') return;

            const parsedMessage = TranscriptStreamSegmentDeltaEphemeralSocketMessageSchema.safeParse(data?.message);
            if (!parsedMessage.success) {
                return;
            }

            const recipientAccountIds = await resolveCurrentSessionRecipientAccountIds({ sessionId: sid });
            if (!recipientAccountIds || recipientAccountIds.length === 0) return;
            const publication = await loadSessionTranscriptPublicationRecipientProjection(sid);
            if (!publication) return;

            const payload = {
                type: 'transcript-stream-segment-delta' as const,
                sessionId: sid,
                message: parsedMessage.data,
            };

            for (const participantUserId of recipientAccountIds) {
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
    registerSessionEvent('message', async (data: any, callback?: (response: any) => void) => {
        await receiveMessageLock.inLock(async () => {
            const respond = (response: any) => {
                if (typeof callback === 'function') {
                    callback(response);
                }
            };

            try {
                websocketEventsCounter.inc({ event_type: 'message' });
                // Runner transcript writes use the canonical observation event,
                // which carries exact publisher authority. The released legacy
                // message event has only Account-shaped transcript admission and
                // must never reinterpret a restricted runtime as that authority.
                if (admission?.principalKind === "ephemeral-session-runner") {
                    socketMessageAckCounter.inc({ result: 'error', error: 'forbidden' });
                    respond({ ok: false, error: 'forbidden' });
                    return;
                }
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
                if (admission?.principalKind === "api-token-session-viewer") {
                    if (!await hasCurrentSocketCredential(userId, socket)) {
                        respond({ ok: false, error: "forbidden" }); return;
                    }
                    const principal: VerifiedApiTokenPrincipal | undefined = socket.data.apiTokenPrincipal;
                    if (!principal) { respond({ ok: false, error: "forbidden" }); return; }
                    const admitted = await admitApiTokenSessionOperation({
                        principal, sessionId: sid, actionId: API_TOKEN_SOCKET_EVENT_ACTIONS.message,
                        capability: "submitAgentInput",
                        authentication: readSessionAccessAuthenticationFromSocket(socket),
                        targetMachineId: await admission.resolveSessionMachine?.({ accountId: userId, sessionId: sid }),
                    });
                    if (!admitted.ok) { respond({ ok: false, error: admitted.error }); return; }
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
                if (admission?.principalKind === "api-token-session-viewer"
                    && ((messageRole !== undefined && messageRole !== "user") || trustedSessionEventType)) {
                    respond({ ok: false, error: "forbidden" }); return;
                }
                if (parsedMessageRole !== null && !parsedMessageRole.success) {
                    socketMessageAckCounter.inc({ result: 'error', error: 'invalid-params' });
                    respond({ ok: false, error: 'invalid-params' });
                    return;
                }

                if (readServerConfig(await readHomeConfigEnv(), SERVER_CONFIG.HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS)) {
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

                const inputAdmission = connection.connectionType === "user-scoped" || admission?.principalKind === "api-token-session-viewer"
                    ? {
                        inputAdmission: "authenticatedAccount" as const,
                        authentication: readSessionAccessAuthenticationFromSocket(socket),
                    }
                    : { inputAdmission: "transcriptOnly" as const };
                const writeMessage = async (
                    publisherAuthority?: CurrentSessionPublisherAuthority,
                ) => await createSessionMessage({
                        ...inputAdmission,
                        actorUserId: userId,
                        sessionId: sid,
                        content,
                        localId,
                        messageRole: admission?.principalKind === "api-token-session-viewer" ? "user" : parsedMessageRole?.data,
                        sidechainId,
                        ...(trustedSessionEventType ? { trustedSessionEventType } : {}),
                        ...(publisherAuthority ? { publisherAuthority } : {}),
                    });
                const publisher = trustedSessionPublisher;
                const result = publisher && publisher.binding.sessionId === sid
                    ? await publisher.presence.runAsCurrentPublisher({
                        socket,
                        operation: writeMessage,
                    })
                    : await writeMessage();
                if (result === null) {
                    socketMessageAckCounter.inc({ result: 'error', error: 'forbidden' });
                    respond({ ok: false, error: 'forbidden' });
                    return;
                }

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

                // Retained legacy socket adapter: it delegates to the same
                // canonical writer and projector rather than deriving a second
                // actor of its own.
                const legacySocketMessage = {
                    ...result.message,
                    accountActor: await resolveSessionMessageAccountActor(result.message),
                };

                await Promise.all(result.recipientCursors.map(async ({ accountId: participantUserId, cursor }) => {
                    const options = result.attentionImpact ? { attentionImpact: result.attentionImpact } : undefined;
                    const payload = result.didWrite
                        ? (
                            options
                                ? buildNewMessageUpdate(legacySocketMessage, sid, cursor, randomKeyNaked(12), options)
                                : buildNewMessageUpdate(legacySocketMessage, sid, cursor, randomKeyNaked(12))
                        )
                        : (
                            options
                                ? buildMessageUpdatedUpdate(legacySocketMessage, sid, cursor, randomKeyNaked(12), options)
                                : buildMessageUpdatedUpdate(legacySocketMessage, sid, cursor, randomKeyNaked(12))
                        );
                    eventRouter.emitUpdate({
                        userId: participantUserId,
                        payload,
                        recipientFilter: { type: 'all-interested-in-session', sessionId: sid },
                        skipSenderConnection: participantUserId === userId && !echoToSender ? connection : undefined,
                    });
                }));
                if (result.didWrite) {
                    const runtimeComposition = await resolveSessionActivityRuntimeComposition(
                        sid,
                        resolveReadyOwnerActivityDelivery(localId),
                    );
                    await publishSessionReadyProjectionUpdate({
                        sessionId: sid,
                        readyProjection: result.readyProjection,
                        skipSenderAccountId: userId,
                        skipSenderConnection: echoToSender ? undefined : connection,
                        ...(runtimeComposition ? { runtimeComposition } : {}),
                    });
                }
                scheduleTrackedSessionBadgeRefresh({
                    badgeAttentionChanged: result.badgeAttentionChanged,
                    sessionId: sid,
                });
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error in message handler: ${error}`);
                socketMessageAckCounter.inc({ result: 'error', error: 'internal' });
                respond({ ok: false, error: 'internal' });
            }
        });
    });

    registerSessionEvent(
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

    registerSessionEvent(SESSION_PENDING_EXECUTION_RUN_BLOCK_EVENT_V2, async (data: unknown, callback?: (response: unknown) => void) => {
        await receiveMessageLock.inLock(async () => {
            const parsed = SessionPendingExecutionRunBlockRequestV2Schema.safeParse(data);
            if (!parsed.success) {
                callback?.({ v: 2, result: { ok: false, error: "invalid-params" } });
                return;
            }
            const { sessionId, recipient, localId, reason } = parsed.data;
            const respond = (result: unknown) => callback?.(SessionPendingExecutionRunBlockResponseV2Schema.parse({ v: 2, recipient, localId, result }));
            const publisher = trustedSessionPublisher;
            if (!canTargetSessionFromSocket({ socket, connection, sessionId }) || !publisher || publisher.binding.sessionId !== sessionId) {
                respond({ ok: false, error: "forbidden" });
                return;
            }
            try {
                const result = await publisher.presence.runAsCurrentPublisher({
                    socket,
                    operation: (publisherAuthority) => blockPendingDelivery({
                        authentication: readSessionAccessAuthenticationFromSocket(socket),
                        actorUserId: userId, sessionId, localId, reason,
                        targetExecutionRunId: recipient.runId, publisherAuthority,
                    }),
                });
                if (!result) { respond({ ok: false, error: "forbidden" }); return; }
                if (!result.ok) { respond({ ok: false, error: result.error }); return; }
                try {
                    await emitPublicationSafePendingChanged({
                        data: { sessionId, changedByAccountId: userId, ...toPendingSocketState(result) },
                        recipientCursors: result.recipientCursors,
                    });
                    scheduleTrackedSessionBadgeRefresh({ sessionId, badgeAttentionChanged: result.badgeAttentionChanged });
                } catch (error) {
                    logError({ module: "websocket", event: SESSION_PENDING_EXECUTION_RUN_BLOCK_EVENT_V2, err: error }, "Target pending block committed but publication failed");
                }
                respond({ ok: true, didUpdate: result.didUpdate, ...toPendingSocketState(result.targetPendingState!) });
            } catch (error) {
                logError({ module: "websocket", event: SESSION_PENDING_EXECUTION_RUN_BLOCK_EVENT_V2, err: error }, "Error blocking target pending delivery");
                respond({ ok: false, error: "internal" });
            }
        });
    });

    for (const executionRunTarget of [false, true]) {
        registerSessionEvent(executionRunTarget ? SESSION_PENDING_EXECUTION_RUN_ACCEPTED_EVENT_V2 : ACCEPTED_PENDING_SETTLEMENT_EVENT_V1, async (data: unknown, callback?: (response: unknown) => void) => {
            await receiveMessageLock.inLock(async () => {
                const parsed = (executionRunTarget ? SessionPendingExecutionRunAcceptedRequestV2Schema : AcceptedPendingSettlementRequestV1Schema).safeParse(data);
                const respond = (response: unknown) => {
                    const result = AcceptedPendingSettlementResponseV1Schema.parse(response);
                    if (!executionRunTarget) { callback?.(result); return; }
                    if (!parsed.success || !("recipient" in parsed.data)) {
                        callback?.({ v: 2, result });
                        return;
                    }
                    callback?.(SessionPendingExecutionRunAcceptedResponseV2Schema.parse({ v: 2, recipient: parsed.data.recipient, sidechainId: parsed.data.sidechainId, result }));
                };
                try {
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
                            ...(parsed.data.acceptedDelivery === undefined ? {} : { acceptedDelivery: parsed.data.acceptedDelivery }),
                            ...("recipient" in parsed.data ? { targetExecutionRunId: parsed.data.recipient.runId, expectedSidechainId: parsed.data.sidechainId } : {}),
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
                    const acceptedMessage = result.message ? serializePendingMaterializedMessage(result.message) : undefined;
                    // V1 accepted settlement predates admission receipts; the target V2 wrapper
                    // reuses that exact closed message shape. The receipt was already returned at claim.
                    if (acceptedMessage) delete acceptedMessage.inputAdmissionReceipt;
                    respond({
                        ok: true,
                        didResolve: result.didResolve,
                        ...toPendingSocketState(executionRunTarget ? result.targetPendingState! : result),
                        ...(acceptedMessage ? { message: acceptedMessage } : {}),
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
    }

    for (const executionRunTarget of [false, true]) {
        registerSessionEvent(executionRunTarget ? SESSION_PENDING_EXECUTION_RUN_MATERIALIZE_NEXT_EVENT_V2 : 'pending-materialize-next', async (data: unknown, callback?: (response: unknown) => void) => {
            const targetRequest = executionRunTarget ? SessionPendingExecutionRunMaterializeNextRequestV2Schema.safeParse(data) : null;
            const respond = (response: Record<string, unknown>) => {
                if (!executionRunTarget) { callback?.(response); return; }
                callback?.(SessionPendingExecutionRunMaterializeNextResponseV2Schema.parse({
                    ...response, v: 2,
                    ...(response.ok === true && targetRequest?.success ? { recipient: targetRequest.data.recipient, sidechainId: targetRequest.data.sidechainId } : {}),
                }));
            };
            const deadlineAtMs = Date.now() + PENDING_MATERIALIZATION_REQUEST_BUDGET_MS;
            try {
                await receiveMessageLock.inLock(async () => {
                try {
                    if (targetRequest && !targetRequest.success) { respond({ ok: false, error: "invalid-params" }); return; }
                    const raw = data && typeof data === "object" ? data as Record<string, unknown> : {};
                    const sid = targetRequest?.success ? targetRequest.data.sessionId : typeof raw.sid === 'string' ? raw.sid : null;
                    if (!sid) {
                        respond({ ok: false, error: 'invalid-params' });
                        return;
                    }

                    if (!canTargetSessionFromSocket({ socket, connection, sessionId: sid })) {
                        respond({ ok: false, error: 'forbidden' });
                        return;
                    }

                    const deliveryState = executionRunTarget ? "provider" : resolvePendingMaterializeDeliveryStateOptIn(data);
                    if (Object.prototype.hasOwnProperty.call(raw, "deliveryState") && !deliveryState) {
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
                            targetExecutionRunId: targetRequest?.success ? targetRequest.data.recipient.runId : null,
                            expectedSidechainId: targetRequest?.success ? targetRequest.data.sidechainId : null,
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
                            ...(executionRunTarget ? { authorAccountId: result.authorAccountId ?? null } : {}),
                            ...toPendingSocketState(result),
                            ...(result.deferredReason ? { deferredReason: result.deferredReason } : {}),
                            ...(result.localId ? { localId: result.localId } : {}),
                            ...(result.deliveryState ? { deliveryState: result.deliveryState } : {}),
                        } as const;
                        respond(response);
                        if (result.pendingStateChanged === true) {
                            const recipientCursorsPending = result.recipientCursorsPending ?? [];
                            await emitPublicationSafePendingChanged({
                                data: {
                                    sessionId: sid,
                                    pendingCount: executionRunTarget ? result.sessionPendingStateForPublication!.pendingCount : result.pendingCount,
                                    pendingBlockedCount: executionRunTarget ? result.sessionPendingStateForPublication!.pendingBlockedCount : result.pendingBlockedCount,
                                    pendingVersion: result.pendingVersion,
                                    changedByAccountId: userId,
                                },
                                recipientCursors: recipientCursorsPending,
                            });
                            await refreshTrackedSessionAccountBadgePushes({
                                badgeAttentionChanged: result.badgeAttentionChanged ?? false,
                                sessionId: sid,
                            });
                        }
                        return;
                    }

                    respond({
                        ok: true,
                        didMaterialize: true,
                        didWrite: result.didWriteMessage,
                        ...(executionRunTarget ? { authorAccountId: result.authorAccountId ?? null } : {}),
                        message: serializePendingMaterializedMessage(result.message),
                        ...toPendingSocketState(result),
                        ...(result.deliveryState ? { deliveryState: result.deliveryState } : {}),
                    });

                    const committedMessage = result.message.id !== null && result.message.seq !== null
                        ? {
                            ...result.message,
                            id: result.message.id,
                            seq: result.message.seq,
                            accountActor: await resolveSessionMessageAccountActor(result.message),
                        }
                        : null;
                    if (result.didWriteMessage && committedMessage) {
                        await Promise.all(
                            result.recipientCursorsMessage.map(async ({ accountId, cursor }) => {
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
                            pendingCount: executionRunTarget ? result.sessionPendingStateForPublication!.pendingCount : result.pendingCount,
                            pendingBlockedCount: executionRunTarget ? result.sessionPendingStateForPublication!.pendingBlockedCount : result.pendingBlockedCount,
                            pendingVersion: result.pendingVersion,
                            changedByAccountId: userId,
                            meaningfulActivityAt: result.meaningfulActivityAt,
                        },
                        recipientCursors: result.recipientCursorsPending,
                    });
                    scheduleTrackedSessionBadgeRefresh({
                        badgeAttentionChanged: result.badgeAttentionChanged,
                        sessionId: sid,
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
    }

    if (connection.connectionType !== "user-scoped") {
    registerSessionEvent('session-end', async (data: SessionEndSocketPayload, callback?: (response: SessionEndAckResponse) => void) => {
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

            clearPendingLegacyAlive();
            const closed = await serializeReleasedAlivePersistence(
                trustedSessionPublisher.presence,
                async () => await trustedSessionPublisher.presence.closePublisher({ socket }),
            );
            if (closed.status !== "closed" && closed.status !== "closed_replay") {
                respond({ ok: false, error: "forbidden" });
                return;
            }
            stopLegacyAlive();
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

    registerSessionEvent(SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT, async (value: unknown, acknowledge?: (response: unknown) => void) => {
        const request = SessionRuntimeActivityCloseRequestSchema.safeParse(value);
        if (!request.success || !trustedSessionPublisher || trustedSessionPublisher.binding.sessionId !== request.data.sessionId) {
            acknowledge?.(SessionRuntimeActivityCloseAckSchema.parse({
                status: 'rejected',
                reason: 'invalid_request',
            }));
            return;
        }

        clearPendingLegacyAlive();
        try {
            const closed = await serializeReleasedAlivePersistence(
                trustedSessionPublisher.presence,
                async () => await trustedSessionPublisher.presence.closePublisher({ socket }),
            );
            if (closed.status === 'closed' || closed.status === 'closed_replay') stopLegacyAlive();
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

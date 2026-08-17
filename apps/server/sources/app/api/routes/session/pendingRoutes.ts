import { z } from "zod";
import { type Fastify } from "../../types";
import { buildMessageUpdatedUpdate, buildNewMessageUpdate, buildPendingChangedUpdate, eventRouter } from "@/app/events/eventRouter";
import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { serializePendingMaterializedMessage } from "@/app/session/pending/serializePendingMaterializedMessage";
import {
    deletePendingMessage,
    dismissPendingDelivery,
    discardPendingMessage,
    enqueuePendingMessage,
    listPendingMessages,
    blockPendingDelivery,
    markPendingDeliveryHandled,
    reorderPendingMessages,
    sendPendingDeliveryAsNew,
    restorePendingMessage,
    updatePendingRequestedAction,
    updatePendingMessage,
    type PendingMessageRow,
} from "@/app/session/pending/pendingMessageService";
import { publishSessionReadyProjectionUpdate } from "@/app/session/ready/publishSessionReadyProjectionUpdate";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { log } from "@/utils/logging/log";
import {
    isSessionAgentTransitionDividerLocalId,
    PendingDeliveryBlockedReasonSchema,
    PendingLocalIdSchema,
    PendingMessageMutationFingerprintV1Schema,
    PendingRequestedActionV1Schema,
    SessionStoredMessageContentSchema,
} from "@happier-dev/protocol";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import {
    loadSessionTranscriptPublicationRecipientProjection,
    projectSessionTranscriptPublicationPendingProjection,
} from "@/app/session/sessionTranscriptPublicationPolicy";

type SessionStoredMessageContent = z.infer<typeof SessionStoredMessageContentSchema>;

function toPendingJson(row: PendingMessageRow) {
    return {
        localId: row.localId,
        ...(typeof row.messageRole === "string" ? { messageRole: row.messageRole } : {}),
        content: row.content,
        ...(row.requestedAction ? { requestedAction: row.requestedAction } : {}),
        ...(row.requestedActionMalformed ? { requestedActionMalformed: true } : {}),
        status: row.status,
        deliveryStatus: row.deliveryStatus,
        ...(row.deliveryState ? { deliveryState: row.deliveryState } : {}),
        ...(row.deliveryBlockedReason ? { deliveryBlockedReason: row.deliveryBlockedReason } : {}),
        position: row.position,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
        discardedAt: row.discardedAt ? row.discardedAt.getTime() : null,
        discardedReason: row.discardedReason,
        authorAccountId: row.authorAccountId,
    };
}

function getOptionalErrorCode(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    if (!("code" in value)) return undefined;
    const code = (value as { code?: unknown }).code;
    return typeof code === "string" && code.length > 0 ? code : undefined;
}

function toPendingStateJson(value: { pendingCount: number; pendingBlockedCount?: number; pendingVersion: number }) {
    return {
        pendingCount: value.pendingCount,
        ...(typeof value.pendingBlockedCount === "number" ? { pendingBlockedCount: value.pendingBlockedCount } : {}),
        pendingVersion: value.pendingVersion,
    };
}

async function emitPendingChanged(params: {
    sessionId: string;
    changedByAccountId: string;
    pendingCount: number;
    pendingBlockedCount?: number;
    pendingVersion: number;
    meaningfulActivityAt?: Date;
    participantCursors: Array<{ accountId: string; cursor: number }>;
    activationTarget?: Readonly<{ accountId: string; requestId: string }>;
}): Promise<void> {
    const rawProjection = {
        pendingCount: params.pendingCount,
        ...(typeof params.pendingBlockedCount === "number" ? { pendingBlockedCount: params.pendingBlockedCount } : {}),
        pendingVersion: params.pendingVersion,
        changedByAccountId: params.changedByAccountId,
        ...(params.meaningfulActivityAt ? { meaningfulActivityAt: params.meaningfulActivityAt } : {}),
        ...(params.activationTarget
            ? { pendingActivationRequestId: params.activationTarget.requestId }
            : {}),
    };
    const session = await loadSessionTranscriptPublicationRecipientProjection(params.sessionId);
    if (!session) return;
    const results = await Promise.allSettled(
        params.participantCursors.map(async ({ accountId, cursor }) => {
            const projection = projectSessionTranscriptPublicationPendingProjection(
                rawProjection,
                session,
                accountId,
            );
            if (projection.kind === "suppress") return;
            const payload = buildPendingChangedUpdate(
                {
                    sessionId: params.sessionId,
                    ...projection.value,
                },
                cursor,
                randomKeyNaked(12),
            );
            eventRouter.emitUpdate({
                userId: accountId,
                payload,
                recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
            });
        }),
    );
    results.forEach((result, index) => {
        if (result.status === "fulfilled") return;
        const accountId = params.participantCursors[index]?.accountId ?? "unknown";
        log(
            { module: "session-pending-routes", level: "warn", sessionId: params.sessionId, accountId },
            "failed to emit pending-changed update",
            result.reason,
        );
    });
    if (params.activationTarget) {
        const ownerCursor = params.participantCursors.find(
            ({ accountId }) => accountId === params.activationTarget!.accountId,
        )?.cursor;
        if (typeof ownerCursor === "number") {
            const projection = projectSessionTranscriptPublicationPendingProjection(
                rawProjection,
                session,
                params.activationTarget.accountId,
            );
            if (projection.kind === "suppress") return;
            const payload = buildPendingChangedUpdate(
                {
                    sessionId: params.sessionId,
                    ...projection.value,
                },
                ownerCursor,
                randomKeyNaked(12),
            );
            eventRouter.emitUpdate({
                userId: params.activationTarget.accountId,
                payload,
                recipientFilter: { type: "user-machine-scoped-only" },
            });
        }
    }
}

async function emitCommittedPendingDeliveryMessage(params: {
    sessionId: string;
    message?: Parameters<typeof buildNewMessageUpdate>[0];
    eventKind?: "new-message" | "message-updated";
    participantCursors?: Array<{ accountId: string; cursor: number }>;
    readyProjection?: Parameters<typeof publishSessionReadyProjectionUpdate>[0]["readyProjection"];
}): Promise<void> {
    if (!params.message || !params.participantCursors || params.participantCursors.length === 0) return;
    const buildMessageUpdate = params.eventKind === "message-updated"
        ? buildMessageUpdatedUpdate
        : buildNewMessageUpdate;
    const results = await Promise.allSettled(
        params.participantCursors.map(async ({ accountId, cursor }) => {
            const payload = buildMessageUpdate(params.message!, params.sessionId, cursor, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId: accountId,
                payload,
                recipientFilter: { type: "all-interested-in-session", sessionId: params.sessionId },
            });
        }),
    );
    results.forEach((result, index) => {
        if (result.status === "fulfilled") return;
        const accountId = params.participantCursors?.[index]?.accountId ?? "unknown";
        log(
            { module: "session-pending-routes", level: "warn", sessionId: params.sessionId, accountId },
            params.eventKind === "message-updated"
                ? "failed to emit message-updated update after pending delivery resolution"
                : "failed to emit new-message update after pending delivery resolution",
            result.reason,
        );
    });
    await publishSessionReadyProjectionUpdate({
        sessionId: params.sessionId,
        readyProjection: params.readyProjection,
    });
}

export function sessionPendingRoutes(app: Fastify) {
    app.get(
        "/v2/sessions/:sessionId/pending",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string() }),
                querystring: z
                    .object({
                        includeDiscarded: z
                            .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
                            .optional(),
                    })
                    .optional(),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId } = request.params;
            const includeDiscardedRaw = request.query?.includeDiscarded;
            const includeDiscarded = includeDiscardedRaw === "true" || includeDiscardedRaw === "1";

            const res = await listPendingMessages({
                actorUserId: request.userId,
                sessionId,
                includeDiscarded,
            });

            if (!res.ok) {
                if (res.error === "invalid-params") {
                    const payload: { error: string; code?: string } = { error: res.error };
                    const code = getOptionalErrorCode(res);
                    if (code) payload.code = code;
                    return reply.code(400).send(payload);
                }
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            return reply.send({ pending: res.pending.map(toPendingJson) });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string() }),
                body: z.union([
                    z.object({
                        ciphertext: z.string().min(1),
                        localId: PendingLocalIdSchema,
                        messageRole: z.unknown().optional(),
                        deliveryMode: z.union([
                            z.literal("external_handoff"),
                            z.literal("continuation_if_no_queued_user_input"),
                        ]).optional(),
                        requestedAction: PendingRequestedActionV1Schema.optional(),
                    }).strict(),
                    z.object({
                        content: SessionStoredMessageContentSchema,
                        localId: PendingLocalIdSchema,
                        messageRole: z.unknown().optional(),
                        deliveryMode: z.union([
                            z.literal("external_handoff"),
                            z.literal("continuation_if_no_queued_user_input"),
                        ]).optional(),
                        requestedAction: PendingRequestedActionV1Schema.optional(),
                    }).strict(),
                ]),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId } = request.params;
            const body = request.body as unknown;
            if (
                body
                && typeof body === "object"
                && Object.prototype.hasOwnProperty.call(body, "requestEqualityEvidenceV1")
            ) {
                return reply.code(400).send({ error: "invalid-params" });
            }
            const localId =
                body && typeof body === "object" && "localId" in body && typeof (body as { localId?: unknown }).localId === "string"
                    ? (body as { localId: string }).localId
                    : "";
            // The reserved Agent-transition divider namespace is ENFORCED by the
            // shared Pending admission owner, which every adapter funnels
            // through. This early refusal is kept only because the account
            // adapter resolves session edit access before reaching that owner,
            // so deleting it would turn this 400 into a 403/404 for a caller
            // without edit access. It cannot disagree with the owner: same
            // protocol predicate, same `invalid-params` 400.
            if (isSessionAgentTransitionDividerLocalId(localId)) {
                return reply.code(400).send({ error: "invalid-params" });
            }
            const ciphertext =
                body && typeof body === "object" && "ciphertext" in body && typeof (body as { ciphertext?: unknown }).ciphertext === "string"
                    ? (body as { ciphertext: string }).ciphertext
                    : null;
            const content =
                body && typeof body === "object" && "content" in body
                    ? ((body as { content: SessionStoredMessageContent }).content ?? null)
                    : null;
            const messageRole =
                body && typeof body === "object" && "messageRole" in body
                    ? (body as { messageRole?: unknown }).messageRole
                    : null;
            const requestedDeliveryMode = body && typeof body === "object" && "deliveryMode" in body
                ? (body as { deliveryMode?: unknown }).deliveryMode
                : undefined;
            const deliveryMode = requestedDeliveryMode === "external_handoff" ? "external_handoff" as const : undefined;
            const admissionMode = requestedDeliveryMode === "continuation_if_no_queued_user_input"
                ? "continuation_if_no_queued_user_input" as const
                : undefined;
            const requestedAction =
                body && typeof body === "object" && "requestedAction" in body
                    ? PendingRequestedActionV1Schema.parse((body as { requestedAction?: unknown }).requestedAction)
                    : PendingRequestedActionV1Schema.parse({ v: 1, kind: "enqueue" });
            const res = await (content
                ? enqueuePendingMessage({
                      actorUserId: request.userId,
                      sessionId,
                      localId,
                      content,
                      messageRole,
                      ...(deliveryMode ? { deliveryMode } : {}),
                      ...(admissionMode ? { admissionMode } : {}),
                      requestedAction,
                  })
                : enqueuePendingMessage({
                      actorUserId: request.userId,
                      sessionId,
                      localId,
                      ciphertext: ciphertext ?? "",
                      messageRole,
                      ...(deliveryMode ? { deliveryMode } : {}),
                      ...(admissionMode ? { admissionMode } : {}),
                      requestedAction,
                  }));

            if (!res.ok) {
                if (res.error === "invalid-params") {
                    const payload: { error: string; code?: string } = { error: res.error };
                    const code = getOptionalErrorCode(res);
                    if (code) payload.code = code;
                    return reply.code(400).send(payload);
                }
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            if (res.suppressed === true) {
                return reply.send({
                    didWrite: false,
                    suppressed: true,
                    ...toPendingStateJson(res),
                });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                meaningfulActivityAt: res.terminal === true ? undefined : res.meaningfulActivityAt,
                participantCursors: res.participantCursors,
                ...("activationTarget" in res && res.activationTarget
                    ? { activationTarget: res.activationTarget }
                    : {}),
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });

            return reply.send({
                didWrite: res.didWrite,
                ...(res.terminal === true
                    ? {
                        terminal: true as const,
                        message: serializePendingMaterializedMessage(res.message),
                    }
                    : { pending: toPendingJson(res.pending) }),
                ...(res.terminal === true
                    ? { requestedAction: res.message.requestedAction }
                    : res.pending.requestedAction
                        ? { requestedAction: res.pending.requestedAction }
                        : {}),
                ...toPendingStateJson(res),
            });
        },
    );

    app.patch(
        "/v2/sessions/:sessionId/pending/:localId/action",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string(), localId: PendingLocalIdSchema }),
                body: z.object({ requestedAction: PendingRequestedActionV1Schema }).strict(),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await updatePendingRequestedAction({
                actorUserId: request.userId,
                sessionId,
                localId,
                requestedAction: request.body.requestedAction,
            });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found" || res.error === "not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "action-conflict") return reply.code(409).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            if (res.didUpdate) {
                await emitPendingChanged({
                    sessionId,
                    changedByAccountId: request.userId,
                    pendingCount: res.pendingCount,
                    pendingBlockedCount: res.pendingBlockedCount,
                    pendingVersion: res.pendingVersion,
                    participantCursors: res.participantCursors,
                });
            }
            return reply.send({ ok: true, didUpdate: res.didUpdate, requestedAction: res.requestedAction, ...toPendingStateJson(res) });
        },
    );

    app.patch(
        "/v2/sessions/:sessionId/pending/:localId",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string(), localId: PendingLocalIdSchema }),
                body: z.union([
                    z.object({
                        ciphertext: z.string().min(1),
                        replacementLocalId: PendingLocalIdSchema.optional(),
                        replacementMutationFingerprint: PendingMessageMutationFingerprintV1Schema.optional(),
                        messageRole: z.unknown().optional(),
                    }),
                    z.object({
                        content: SessionStoredMessageContentSchema,
                        replacementLocalId: PendingLocalIdSchema.optional(),
                        replacementMutationFingerprint: PendingMessageMutationFingerprintV1Schema.optional(),
                        messageRole: z.unknown().optional(),
                    }),
                ]),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const body = request.body as unknown;
            const ciphertext =
                body && typeof body === "object" && "ciphertext" in body && typeof (body as { ciphertext?: unknown }).ciphertext === "string"
                    ? (body as { ciphertext: string }).ciphertext
                    : null;
            const content =
                body && typeof body === "object" && "content" in body
                    ? ((body as { content: SessionStoredMessageContent }).content ?? null)
                    : null;
            const messageRole =
                body && typeof body === "object" && "messageRole" in body
                    ? (body as { messageRole?: unknown }).messageRole
                    : null;
            const replacementLocalId =
                body && typeof body === "object"
                    && "replacementLocalId" in body
                    && typeof (body as { replacementLocalId?: unknown }).replacementLocalId === "string"
                    ? (body as { replacementLocalId: string }).replacementLocalId
                    : undefined;
            const replacementMutationFingerprint =
                body && typeof body === "object"
                    && "replacementMutationFingerprint" in body
                    && typeof (body as { replacementMutationFingerprint?: unknown }).replacementMutationFingerprint === "string"
                    ? (body as { replacementMutationFingerprint: string }).replacementMutationFingerprint
                    : undefined;

            const res = await (content
                ? updatePendingMessage({ actorUserId: request.userId, sessionId, localId, content, replacementLocalId, replacementMutationFingerprint, messageRole })
                : updatePendingMessage({ actorUserId: request.userId, sessionId, localId, ciphertext: ciphertext ?? "", replacementLocalId, replacementMutationFingerprint, messageRole }));
            if (!res.ok) {
                if (res.error === "invalid-params") {
                    const payload: { error: string; code?: string } = { error: res.error };
                    const code = getOptionalErrorCode(res);
                    if (code) payload.code = code;
                    return reply.code(400).send(payload);
                }
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "local-id-conflict") return reply.code(409).send({ error: res.error });
                if (res.error === "pending-mutation-conflict") return reply.code(409).send({ error: res.error });
                if (res.error === "delivery-settlement-conflict") return reply.code(409).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                meaningfulActivityAt: res.meaningfulActivityAt,
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, localId: res.localId, ...toPendingStateJson(res) });
        },
    );

    app.delete(
        "/v2/sessions/:sessionId/pending/:localId",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string(), localId: PendingLocalIdSchema }),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await deletePendingMessage({ actorUserId: request.userId, sessionId, localId });
            if (!res.ok) {
                if (res.error === "invalid-params") {
                    const payload: { error: string; code?: string } = { error: res.error };
                    const code = getOptionalErrorCode(res);
                    if (code) payload.code = code;
                    return reply.code(400).send(payload);
                }
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "delivery-settlement-conflict") return reply.code(409).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                meaningfulActivityAt: res.meaningfulActivityAt,
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, ...toPendingStateJson(res) });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/:localId/discard",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string(), localId: PendingLocalIdSchema }),
                body: z.object({ reason: z.string().optional() }).optional(),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const reason = request.body?.reason;

            const res = await discardPendingMessage({ actorUserId: request.userId, sessionId, localId, reason });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found" || res.error === "not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "delivery-settlement-conflict") return reply.code(409).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                meaningfulActivityAt: res.meaningfulActivityAt,
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, ...toPendingStateJson(res) });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/:localId/restore",
        {
            preHandler: app.authenticate,
            schema: { params: z.object({ sessionId: z.string(), localId: PendingLocalIdSchema }) },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await restorePendingMessage({ actorUserId: request.userId, sessionId, localId });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found" || res.error === "not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "delivery-settlement-conflict") return reply.code(409).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                meaningfulActivityAt: res.meaningfulActivityAt,
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, ...toPendingStateJson(res) });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/reorder",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string() }),
                body: z.object({ orderedLocalIds: z.array(z.string().min(1)).min(1) }),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId } = request.params;
            const res = await reorderPendingMessages({ actorUserId: request.userId, sessionId, orderedLocalIds: request.body.orderedLocalIds });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, ...toPendingStateJson(res) });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/:localId/delivery/block",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string(), localId: PendingLocalIdSchema }),
                body: z.object({ reason: PendingDeliveryBlockedReasonSchema }),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending.materialize"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await blockPendingDelivery({
                actorUserId: request.userId,
                sessionId,
                localId,
                reason: request.body.reason,
            });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found" || res.error === "not-found") return reply.code(404).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, ...toPendingStateJson(res) });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/:localId/delivery/dismiss",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string(), localId: PendingLocalIdSchema }),
                body: z.object({}).optional(),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending.materialize"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await dismissPendingDelivery({ actorUserId: request.userId, sessionId, localId });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found" || res.error === "not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "delivery-settlement-conflict") return reply.code(409).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, didDismiss: res.didDismiss, ...toPendingStateJson(res) });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/:localId/delivery/send-as-new",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string(), localId: PendingLocalIdSchema }),
                body: z.object({}),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending.materialize"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await sendPendingDeliveryAsNew({
                actorUserId: request.userId,
                sessionId,
                localId,
            });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found" || res.error === "not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "delivery-settlement-conflict" || res.error === "identity-conflict") {
                    return reply.code(409).send({ error: res.error });
                }
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, newLocalId: res.newLocalId, ...toPendingStateJson(res) });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/:localId/delivery/handled",
        {
            preHandler: app.authenticate,
            schema: { params: z.object({ sessionId: z.string(), localId: PendingLocalIdSchema }) },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending.materialize"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await markPendingDeliveryHandled({ actorUserId: request.userId, sessionId, localId });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                if (res.error === "transcript-conflict") {
                    if (res.pendingStateChanged === true) {
                        const participantCursors = res.participantCursors ?? [];
                        await emitPendingChanged({
                            sessionId,
                            changedByAccountId: request.userId,
                            pendingCount: res.pendingCount ?? 0,
                            pendingBlockedCount: res.pendingBlockedCount,
                            pendingVersion: res.pendingVersion ?? 0,
                            participantCursors,
                        });
                        await refreshSessionParticipantBadgePushes({
                            badgeAttentionChanged: res.badgeAttentionChanged ?? false,
                            participantCursors,
                        });
                    }
                    return reply.code(409).send({ error: res.error });
                }
                return reply.code(500).send({ error: res.error });
            }

            await emitCommittedPendingDeliveryMessage({
                sessionId,
                message: res.message,
                eventKind: res.didUpdate === true && res.didWrite !== true ? "message-updated" : "new-message",
                participantCursors: res.participantCursorsMessage,
                readyProjection: res.readyProjection,
            });
            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursorsPending ?? res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: [...(res.participantCursorsMessage ?? []), ...(res.participantCursorsPending ?? res.participantCursors)],
            });
            return reply.send({ ok: true, ...toPendingStateJson(res) });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/materialize-next",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string() }),
                body: z.object({
                    deliveryState: z.literal("provider").optional(),
                    deliveryTiming: z.enum(["after_foreground_ready", "after_runtime_idle"]).optional(),
                    foregroundState: z.enum(["ready", "active_steerable", "active_unsteerable"]).optional(),
                }).optional(),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending.materialize"),
            },
        },
        async (_request, reply) => {
            return reply.code(403).send({ error: "forbidden" });
        },
    );
}

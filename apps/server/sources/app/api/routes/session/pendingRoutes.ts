import { z } from "zod";
import { type Fastify } from "../../types";
import { eventRouter } from "@/app/events/eventRouter";
import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { serializePendingMaterializedMessage } from "@/app/session/pending/serializePendingMaterializedMessage";
import {
    blockPendingDelivery,
    deletePendingMessage,
    discardPendingMessage,
    dismissPendingDelivery,
    enqueuePendingMessage,
    listPendingMessages,
    markPendingDeliveryHandled,
    reorderPendingMessages,
    sendPendingDeliveryAsNew,
    restorePendingMessage,
    updatePendingMessage,
    updatePendingRequestedAction,
    type PendingMessageRow,
} from "@/app/session/pending/pendingMessageService";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { log } from "@/utils/logging/log";
import {
    isSessionAgentTransitionDividerLocalId,
    PendingDeliveryBlockedReasonSchema,
    PendingLocalIdSchema,
    PendingRequestedActionV1Schema,
    SessionStoredMessageContentSchema,
} from "@happier-dev/protocol";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import {
    emitPendingChanged,
    emitPendingResolvedMessage,
} from "@/app/session/pending/publishPendingMutation";

type SessionStoredMessageContent = z.infer<typeof SessionStoredMessageContentSchema>;

function toPendingJson(row: PendingMessageRow) {
    return {
        localId: row.localId,
        ...(typeof row.messageRole === "string" ? { messageRole: row.messageRole } : {}),
        content: row.content,
        ...(row.requestedAction ? { requestedAction: row.requestedAction } : {}),
        ...(row.requestedActionMalformed ? { requestedActionMalformed: true } : {}),
        status: row.status,
        ...(row.deliveryState ? { deliveryState: row.deliveryState } : {}),
        ...(row.deliveryBlockedReason ? { deliveryBlockedReason: row.deliveryBlockedReason } : {}),
        deliveryStatus: row.deliveryStatus,
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
                    }),
                    z.object({
                        content: SessionStoredMessageContentSchema,
                        localId: PendingLocalIdSchema,
                        messageRole: z.unknown().optional(),
                        deliveryMode: z.union([
                            z.literal("external_handoff"),
                            z.literal("continuation_if_no_queued_user_input"),
                        ]).optional(),
                        requestedAction: PendingRequestedActionV1Schema.optional(),
                    }),
                ]),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId } = request.params;
            const body = request.body as unknown;
            const localId =
                body && typeof body === "object" && "localId" in body && typeof (body as { localId?: unknown }).localId === "string"
                    ? (body as { localId: string }).localId
                    : "";
            // A Pending row materializes into a transcript row under its own localId, so
            // this is a generic client message ingress too: the reserved Agent-transition
            // divider namespace is refused here as well as on the direct message routes.
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
            const requestedAction = body && typeof body === "object" && "requestedAction" in body
                ? PendingRequestedActionV1Schema.parse((body as { requestedAction?: unknown }).requestedAction)
                : ({ v: 1, kind: "enqueue" } as const);

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
                if (res.error === "requested-action-conflict") return reply.code(409).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }

            if (res.suppressed === true) {
                return reply.send({
                    didWrite: false,
                    suppressed: true,
                    pendingCount: res.pendingCount,
                    pendingBlockedCount: res.pendingBlockedCount,
                    pendingVersion: res.pendingVersion,
                });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                meaningfulActivityAt: res.didWrite ? res.meaningfulActivityAt : undefined,
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
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
            });
        },
    );

    app.patch(
        "/v2/sessions/:sessionId/pending/:localId",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string(), localId: PendingLocalIdSchema }),
                body: z.union([
                    z.object({ ciphertext: z.string().min(1), messageRole: z.unknown().optional() }),
                    z.object({ content: SessionStoredMessageContentSchema, messageRole: z.unknown().optional() }),
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

            const res = await (content
                ? updatePendingMessage({ actorUserId: request.userId, sessionId, localId, content, messageRole })
                : updatePendingMessage({ actorUserId: request.userId, sessionId, localId, ciphertext: ciphertext ?? "", messageRole }));
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
            return reply.send({ ok: true, pendingCount: res.pendingCount, pendingBlockedCount: res.pendingBlockedCount, pendingVersion: res.pendingVersion });
        },
    );

    app.delete(
        "/v2/sessions/:sessionId/pending/:localId",
        {
            preHandler: app.authenticate,
            schema: { params: z.object({ sessionId: z.string(), localId: PendingLocalIdSchema }) },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending"),
            },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await deletePendingMessage({
                actorUserId: request.userId,
                sessionId,
                localId,
                ...(typeof request.id === "string" ? { diagnosticCorrelationId: request.id } : {}),
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
                if (res.error === "delivery-settlement-conflict") return reply.code(409).send({ error: res.error });
                if (res.error === "transaction-unavailable") {
                    reply.header("Retry-After", String(Math.max(1, Math.ceil(res.retryAfterMs / 1_000))));
                    return reply.code(503).send({
                        error: res.error,
                        retryAfterMs: res.retryAfterMs,
                        ...(res.correlationId ? { correlationId: res.correlationId } : {}),
                    });
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
            return reply.send({ ok: true, pendingCount: res.pendingCount, pendingBlockedCount: res.pendingBlockedCount, pendingVersion: res.pendingVersion });
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
                await refreshSessionParticipantBadgePushes({
                    badgeAttentionChanged: res.badgeAttentionChanged,
                    participantCursors: res.participantCursors,
                });
            }
            return reply.send({
                ok: true,
                didUpdate: res.didUpdate,
                requestedAction: request.body.requestedAction,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
            });
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
            return reply.send({ ok: true, pendingCount: res.pendingCount, pendingBlockedCount: res.pendingBlockedCount, pendingVersion: res.pendingVersion });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/:localId/delivery/handled",
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
            const res = await markPendingDeliveryHandled({
                actorUserId: request.userId,
                sessionId,
                localId,
            });
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

            const participantCursorsMessage = res.participantCursorsMessage ?? [];
            const participantCursorsPending = res.participantCursorsPending ?? res.participantCursors;
            await emitPendingResolvedMessage({
                sessionId,
                message: res.message,
                eventKind: res.didUpdate === true && res.didWrite !== true ? "message-updated" : "new-message",
                readyProjection: res.readyProjection,
                participantCursors: participantCursorsMessage,
                logContext: "failed to emit new-message update after handled pending delivery",
            });

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                participantCursors: participantCursorsPending,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: [...participantCursorsMessage, ...participantCursorsPending],
            });
            return reply.send({
                ok: true,
                pendingCount: res.pendingCount,
                pendingBlockedCount: res.pendingBlockedCount,
                pendingVersion: res.pendingVersion,
                ...(res.message ? { message: serializePendingMaterializedMessage(res.message) } : {}),
            });
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
            return reply.send({ ok: true, didDismiss: res.didDismiss, pendingCount: res.pendingCount, pendingBlockedCount: res.pendingBlockedCount, pendingVersion: res.pendingVersion });
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
                if (res.error === "delivery-settlement-conflict" || res.error === "identity-conflict") return reply.code(409).send({ error: res.error });
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
            return reply.send({ ok: true, didWrite: res.didWrite, pendingCount: res.pendingCount, pendingBlockedCount: res.pendingBlockedCount, pendingVersion: res.pendingVersion });
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
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, pendingCount: res.pendingCount, pendingBlockedCount: res.pendingBlockedCount, pendingVersion: res.pendingVersion });
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
                participantCursors: res.participantCursors,
            });
            await refreshSessionParticipantBadgePushes({
                badgeAttentionChanged: res.badgeAttentionChanged,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, pendingCount: res.pendingCount, pendingBlockedCount: res.pendingBlockedCount, pendingVersion: res.pendingVersion });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/reorder",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string() }),
                body: z.object({ orderedLocalIds: z.array(PendingLocalIdSchema).min(1) }),
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
            return reply.send({ ok: true, pendingCount: res.pendingCount, pendingBlockedCount: res.pendingBlockedCount, pendingVersion: res.pendingVersion });
        },
    );

    // Provider materialization requires the exact current machine-bound publisher socket.
    // Keep this released route shape fail-closed so an old HTTP caller cannot commit Pending.
    app.post(
        "/v2/sessions/:sessionId/pending/materialize-next",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string() }),
                body: z
                    .object({
                        expectedPendingVersion: z.number().int().nonnegative().optional(),
                        deliveryState: z.literal("provider").optional(),
                        deliveryTiming: z
                            .union([z.literal("after_foreground_ready"), z.literal("after_runtime_idle")])
                            .optional(),
                        foregroundState: z.enum(["ready", "active_steerable", "active_unsteerable"]).optional(),
                    })
                    .optional(),
            },
            config: {
                rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.pending.materialize"),
            },
        },
        async (_request, reply) => reply.code(403).send({ error: "forbidden" }),
    );
}

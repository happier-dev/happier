import { z } from "zod";
import { type Fastify } from "../../types";
import { buildNewMessageUpdate, buildPendingChangedUpdate, eventRouter } from "@/app/events/eventRouter";
import {
    deletePendingMessage,
    discardPendingMessage,
    enqueuePendingMessage,
    listPendingMessages,
    materializeNextPendingMessage,
    reorderPendingMessages,
    restorePendingMessage,
    updatePendingMessage,
    type PendingMessageRow,
} from "@/app/session/pending/pendingMessageService";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { log } from "@/utils/logging/log";
import { SessionStoredMessageContentSchema } from "@happier-dev/protocol";
import { resolveRouteRateLimit } from "@/app/api/utils/apiRateLimitPolicy";

function toPendingJson(row: PendingMessageRow) {
    return {
        localId: row.localId,
        content: row.content,
        status: row.status,
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

async function emitPendingChanged(params: {
    sessionId: string;
    changedByAccountId: string;
    pendingCount: number;
    pendingVersion: number;
    participantCursors: Array<{ accountId: string; cursor: number }>;
}): Promise<void> {
    const results = await Promise.allSettled(
        params.participantCursors.map(async ({ accountId, cursor }) => {
            const payload = buildPendingChangedUpdate(
                {
                    sessionId: params.sessionId,
                    pendingCount: params.pendingCount,
                    pendingVersion: params.pendingVersion,
                    changedByAccountId: params.changedByAccountId,
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
                rateLimit: resolveRouteRateLimit(process.env, {
                    maxEnvKey: "HAPPIER_SESSION_PENDING_RATE_LIMIT_MAX",
                    windowEnvKey: "HAPPIER_SESSION_PENDING_RATE_LIMIT_WINDOW",
                    defaultMax: 600,
                    defaultWindow: "1 minute",
                }),
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
                        localId: z.string().min(1),
                    }),
                    z.object({
                        content: SessionStoredMessageContentSchema,
                        localId: z.string().min(1),
                    }),
                ]),
            },
        },
        async (request, reply) => {
            const { sessionId } = request.params;
            const body = request.body as unknown;
            const localId =
                body && typeof body === "object" && "localId" in body && typeof (body as { localId?: unknown }).localId === "string"
                    ? (body as { localId: string }).localId
                    : "";
            const ciphertext =
                body && typeof body === "object" && "ciphertext" in body && typeof (body as { ciphertext?: unknown }).ciphertext === "string"
                    ? (body as { ciphertext: string }).ciphertext
                    : null;
            const content =
                body && typeof body === "object" && "content" in body
                    ? ((body as { content: PrismaJson.SessionPendingMessageContent }).content ?? null)
                    : null;

            const res = await (content
                ? enqueuePendingMessage({
                      actorUserId: request.userId,
                      sessionId,
                      localId,
                      content,
                  })
                : enqueuePendingMessage({
                      actorUserId: request.userId,
                      sessionId,
                      localId,
                      ciphertext: ciphertext ?? "",
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

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursors,
            });

            return reply.send({
                didWrite: res.didWrite,
                pending: toPendingJson(res.pending),
                pendingCount: res.pendingCount,
                pendingVersion: res.pendingVersion,
            });
        },
    );

    app.patch(
        "/v2/sessions/:sessionId/pending/:localId",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string(), localId: z.string() }),
                body: z.union([
                    z.object({ ciphertext: z.string().min(1) }),
                    z.object({ content: SessionStoredMessageContentSchema }),
                ]),
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
                    ? ((body as { content: PrismaJson.SessionPendingMessageContent }).content ?? null)
                    : null;

            const res = await (content
                ? updatePendingMessage({ actorUserId: request.userId, sessionId, localId, content })
                : updatePendingMessage({ actorUserId: request.userId, sessionId, localId, ciphertext: ciphertext ?? "" }));
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

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, pendingCount: res.pendingCount, pendingVersion: res.pendingVersion });
        },
    );

    app.delete(
        "/v2/sessions/:sessionId/pending/:localId",
        {
            preHandler: app.authenticate,
            schema: { params: z.object({ sessionId: z.string(), localId: z.string() }) },
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
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, pendingCount: res.pendingCount, pendingVersion: res.pendingVersion });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/:localId/discard",
        {
            preHandler: app.authenticate,
            schema: {
                params: z.object({ sessionId: z.string(), localId: z.string() }),
                body: z.object({ reason: z.string().optional() }).optional(),
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
                return reply.code(500).send({ error: res.error });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, pendingCount: res.pendingCount, pendingVersion: res.pendingVersion });
        },
    );

    app.post(
        "/v2/sessions/:sessionId/pending/:localId/restore",
        {
            preHandler: app.authenticate,
            schema: { params: z.object({ sessionId: z.string(), localId: z.string() }) },
        },
        async (request, reply) => {
            const { sessionId, localId } = request.params;
            const res = await restorePendingMessage({ actorUserId: request.userId, sessionId, localId });
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
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, pendingCount: res.pendingCount, pendingVersion: res.pendingVersion });
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
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursors,
            });
            return reply.send({ ok: true, pendingCount: res.pendingCount, pendingVersion: res.pendingVersion });
        },
    );

    // Optional: HTTP materialize helper (debug/fallback when socket RPC isn't available).
    app.post(
        "/v2/sessions/:sessionId/pending/materialize-next",
        {
            preHandler: app.authenticate,
            schema: { params: z.object({ sessionId: z.string() }) },
            config: {
                rateLimit: resolveRouteRateLimit(process.env, {
                    maxEnvKey: "HAPPIER_SESSION_PENDING_MATERIALIZE_RATE_LIMIT_MAX",
                    windowEnvKey: "HAPPIER_SESSION_PENDING_MATERIALIZE_RATE_LIMIT_WINDOW",
                    defaultMax: 120,
                    defaultWindow: "1 minute",
                }),
            },
        },
        async (request, reply) => {
            const { sessionId } = request.params;
            const res = await materializeNextPendingMessage({ actorUserId: request.userId, sessionId });
            if (!res.ok) {
                if (res.error === "invalid-params") return reply.code(400).send({ error: res.error });
                if (res.error === "forbidden") return reply.code(403).send({ error: res.error });
                if (res.error === "session-not-found") return reply.code(404).send({ error: res.error });
                return reply.code(500).send({ error: res.error });
            }
            if (!res.didMaterialize) return reply.send({ ok: true, didMaterialize: false });

            if (res.didWriteMessage) {
                const messageResults = await Promise.allSettled(
                    res.participantCursorsMessage.map(async ({ accountId, cursor }) => {
                        const payload = buildNewMessageUpdate(res.message, sessionId, cursor, randomKeyNaked(12));
                        eventRouter.emitUpdate({
                            userId: accountId,
                            payload,
                            recipientFilter: { type: "all-interested-in-session", sessionId },
                        });
                    }),
                );
                messageResults.forEach((result, index) => {
                    if (result.status === "fulfilled") return;
                    const accountId = res.participantCursorsMessage[index]?.accountId ?? "unknown";
                    log(
                        { module: "session-pending-routes", level: "warn", sessionId, accountId },
                        "failed to emit new-message update after materialize-next",
                        result.reason,
                    );
                });
            }

            await emitPendingChanged({
                sessionId,
                changedByAccountId: request.userId,
                pendingCount: res.pendingCount,
                pendingVersion: res.pendingVersion,
                participantCursors: res.participantCursorsPending,
            });

            return reply.send({
                ok: true,
                didMaterialize: true,
                didWriteMessage: res.didWriteMessage,
                message: { id: res.message.id, seq: res.message.seq, localId: res.message.localId },
            });
        },
    );
}

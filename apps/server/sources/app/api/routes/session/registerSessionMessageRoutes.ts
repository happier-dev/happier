import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { buildMessageUpdatedUpdate, buildNewMessageUpdate, eventRouter } from "@/app/events/eventRouter";
import { catchupFollowupFetchesCounter, catchupFollowupReturnedCounter } from "@/app/monitoring/metrics2";
import { SessionStoredMessageContentSchema } from "@happier-dev/protocol";
import { createSessionMessage } from "@/app/session/sessionWriteService";
import { parseSessionMessageSidechainId } from "@/app/session/parseSessionMessageSidechainId";
import { checkSessionAccess } from "@/app/share/accessControl";
import { db } from "@/storage/db";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { type Fastify } from "../../types";

type SessionStoredMessageContent = z.infer<typeof SessionStoredMessageContentSchema>;

export function registerSessionMessageRoutes(app: Fastify) {
    app.get('/v2/sessions/:sessionId/messages/by-local-id/:localId', {
        schema: {
            params: z.object({
                sessionId: z.string(),
                localId: z.string().min(1),
            }),
            response: {
                200: z.object({
                    message: z.object({
                        id: z.string(),
                        seq: z.number().int().min(0),
                        localId: z.string().nullable(),
                        sidechainId: z.string().nullable().optional(),
                        content: SessionStoredMessageContentSchema,
                        createdAt: z.number().int().min(0),
                        updatedAt: z.number().int().min(0),
                    }).passthrough(),
                }).passthrough(),
                404: z.object({ error: z.string() }).passthrough(),
            },
        },
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.messages.byLocalId"),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, localId } = request.params;

        const access = await checkSessionAccess(userId, sessionId);
        if (!access) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const row = await db.sessionMessage.findUnique({
            where: { sessionId_localId: { sessionId, localId } },
            select: {
                id: true,
                seq: true,
                localId: true,
                sidechainId: true,
                content: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        if (!row) {
            return reply.code(404).send({ error: 'Message not found' });
        }

        return reply.send({
            message: {
                id: row.id,
                seq: row.seq,
                localId: row.localId,
                ...(typeof row.sidechainId === "string" && row.sidechainId ? { sidechainId: row.sidechainId } : {}),
                content: row.content,
                createdAt: row.createdAt.getTime(),
                updatedAt: row.updatedAt.getTime(),
            },
        });
    });

    app.get('/v1/sessions/:sessionId/messages', {
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            querystring: z.object({
                scope: z.enum(["main", "sidechain", "all"]).optional(),
                sidechainId: z.string().min(1).optional(),
                limit: z.coerce.number().int().min(1).max(500).default(150),
                beforeSeq: z.coerce.number().int().min(1).optional(),
                afterSeq: z.coerce.number().int().min(0).optional(),
            }).superRefine((value, ctx) => {
                if (value.beforeSeq !== undefined && value.afterSeq !== undefined) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: 'beforeSeq and afterSeq are mutually exclusive',
                    });
                }
                if (value.scope === "sidechain" && typeof value.sidechainId !== "string") {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: "sidechainId is required when scope=sidechain",
                    });
                }
            }).optional(),
        },
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.messages"),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const query = request.query as
            | Readonly<{
                  scope?: unknown;
                  sidechainId?: unknown;
                  limit?: number;
                  beforeSeq?: number;
                  afterSeq?: number;
              }>
            | undefined;
        const { limit = 150, beforeSeq, afterSeq } = query ?? {};

        const scope = (() => {
            const raw = query?.scope;
            if (raw === "all" || raw === "sidechain" || raw === "main") return raw;
            return "main";
        })();

        const parsedSidechainId = parseSessionMessageSidechainId(query?.sidechainId, { emptyString: "null" });
        const sidechainId = parsedSidechainId.ok ? parsedSidechainId.sidechainId : null;

        if (scope === "sidechain" && sidechainId === null) {
            return reply.code(400).send({ error: "Invalid parameters", code: "missing-sidechain-id" });
        }

        const access = await checkSessionAccess(userId, sessionId);
        if (!access) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        if (afterSeq !== undefined) {
            catchupFollowupFetchesCounter.inc({ type: 'session-messages-afterSeq' });
        }

        const where: Prisma.SessionMessageWhereInput = { sessionId };
        if (scope === "main") where.sidechainId = null;
        if (scope === "sidechain") where.sidechainId = sidechainId;
        if (beforeSeq !== undefined) {
            where.seq = { lt: beforeSeq };
        }
        if (afterSeq !== undefined) {
            where.seq = { gt: afterSeq };
        }

        const messages = await db.sessionMessage.findMany({
            where,
            orderBy: { seq: afterSeq !== undefined ? 'asc' : 'desc' },
            take: limit + 1,
            select: {
                id: true,
                seq: true,
                localId: true,
                sidechainId: true,
                content: true,
                createdAt: true,
                updatedAt: true
            }
        });

        const hasMore = messages.length > limit;
        const resultMessages = hasMore ? messages.slice(0, limit) : messages;
        if (afterSeq !== undefined) {
            catchupFollowupReturnedCounter.inc({ type: 'session-messages-afterSeq' }, resultMessages.length);
        }
        const nextBeforeSeq =
            afterSeq !== undefined
                ? null
                : hasMore && resultMessages.length > 0
                    ? resultMessages[resultMessages.length - 1].seq
                    : null;

        const nextAfterSeq =
            afterSeq !== undefined
                ? hasMore && resultMessages.length > 0
                    ? resultMessages[resultMessages.length - 1].seq
                    : null
                : null;

        return reply.send({
            messages: resultMessages.map((v) => ({
                id: v.id,
                seq: v.seq,
                content: v.content,
                localId: v.localId,
                ...(typeof v.sidechainId === "string" && v.sidechainId ? { sidechainId: v.sidechainId } : {}),
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime()
            })),
            hasMore,
            nextBeforeSeq,
            nextAfterSeq,
        });
    });

    app.post('/v2/sessions/:sessionId/messages', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            body: z.union([
                z.object({
                    ciphertext: z.string().min(1),
                    localId: z.string().optional(),
                    sidechainId: z.string().min(1).nullable().optional(),
                }),
                z.object({
                    content: SessionStoredMessageContentSchema,
                    localId: z.string().optional(),
                    sidechainId: z.string().min(1).nullable().optional(),
                }),
            ]),
            response: {
                200: z
                    .object({
                        didWrite: z.boolean(),
                        didUpdate: z.boolean().optional(),
                        message: z.object({
                            id: z.string(),
                            seq: z.number().int().min(0),
                            localId: z.string().nullable(),
                            createdAt: z.number().int().min(0),
                        }),
                    })
                    .passthrough(),
                400: z.object({ error: z.literal('Invalid parameters'), code: z.string().optional() }).passthrough(),
                403: z.object({ error: z.literal('Forbidden') }),
                404: z.object({ error: z.literal('Session not found') }),
                500: z.object({ error: z.literal('Failed to create message') }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const body = request.body as Readonly<{ localId?: string; sidechainId?: string | null } & ({ ciphertext: string } | { content: SessionStoredMessageContent })>;
        const localId = typeof body.localId === "string" ? body.localId : undefined;
        const parsedSidechainId = parseSessionMessageSidechainId(body.sidechainId, { emptyString: "invalid" });
        if (!parsedSidechainId.ok) {
            return reply.code(400).send({ error: "Invalid parameters", code: "invalid-sidechain-id" });
        }
        const sidechainId = parsedSidechainId.sidechainId;

        const headerKey = request.headers["idempotency-key"];
        const idempotencyKey =
            typeof headerKey === "string"
                ? headerKey
                : Array.isArray(headerKey) && typeof headerKey[0] === "string"
                    ? headerKey[0]
                    : null;

        const effectiveLocalId = localId ?? idempotencyKey ?? null;

        const result =
            "content" in body
                ? await createSessionMessage({
                      actorUserId: userId,
                      sessionId,
                      content: body.content,
                      localId: effectiveLocalId,
                      sidechainId,
                  })
                : await createSessionMessage({
                      actorUserId: userId,
                      sessionId,
                      ciphertext: body.ciphertext,
                      localId: effectiveLocalId,
                      sidechainId,
                  });

        if (!result.ok) {
            if (result.error === "invalid-params") {
                const payload: { error: "Invalid parameters"; code?: string } = { error: "Invalid parameters" };
                if ("code" in result && typeof result.code === "string") payload.code = result.code;
                return reply.code(400).send(payload);
            }
            if (result.error === "forbidden") return reply.code(403).send({ error: "Forbidden" });
            if (result.error === "session-not-found") return reply.code(404).send({ error: "Session not found" });
            return reply.code(500).send({ error: "Failed to create message" });
        }

        if (result.didWrite) {
            await Promise.all(result.participantCursors.map(async ({ accountId, cursor }) => {
                const payload = buildNewMessageUpdate(result.message, sessionId, cursor, randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId },
                });
            }));
        } else if (result.didUpdate) {
            await Promise.all(result.participantCursors.map(async ({ accountId, cursor }) => {
                const payload = buildMessageUpdatedUpdate(result.message, sessionId, cursor, randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId },
                });
            }));
        }

        await refreshSessionParticipantBadgePushes({
            badgeAttentionChanged: result.badgeAttentionChanged,
            participantCursors: result.participantCursors,
        });

        return reply.send({
            didWrite: result.didWrite,
            ...(result.didUpdate ? { didUpdate: true } : {}),
            message: {
                id: result.message.id,
                seq: result.message.seq,
                localId: result.message.localId,
                createdAt: result.message.createdAt.getTime(),
            },
        });
    });
}

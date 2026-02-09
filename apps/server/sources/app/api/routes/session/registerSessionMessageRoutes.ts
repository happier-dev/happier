import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { buildNewMessageUpdate, eventRouter } from "@/app/events/eventRouter";
import { catchupFollowupFetchesCounter, catchupFollowupReturnedCounter } from "@/app/monitoring/metrics2";
import { createSessionMessage } from "@/app/session/sessionWriteService";
import { checkSessionAccess } from "@/app/share/accessControl";
import { db } from "@/storage/db";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { type Fastify } from "../../types";

export function registerSessionMessageRoutes(app: Fastify) {
    app.get('/v1/sessions/:sessionId/messages', {
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            querystring: z.object({
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
            }).optional(),
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { limit = 150, beforeSeq, afterSeq } = request.query || {};

        const access = await checkSessionAccess(userId, sessionId);
        if (!access) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        if (afterSeq !== undefined) {
            catchupFollowupFetchesCounter.inc({ type: 'session-messages-afterSeq' });
        }

        const where: Prisma.SessionMessageWhereInput = { sessionId };
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
            body: z.object({
                ciphertext: z.string(),
                localId: z.string().optional(),
            }),
            response: {
                200: z.object({
                    didWrite: z.boolean(),
                    message: z.object({
                        id: z.string(),
                        seq: z.number(),
                        localId: z.string().nullable(),
                        createdAt: z.number(),
                    }),
                }),
                400: z.object({ error: z.literal('Invalid parameters') }),
                403: z.object({ error: z.literal('Forbidden') }),
                404: z.object({ error: z.literal('Session not found') }),
                500: z.object({ error: z.literal('Failed to create message') }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { ciphertext, localId } = request.body;

        const headerKey = request.headers["idempotency-key"];
        const idempotencyKey =
            typeof headerKey === "string"
                ? headerKey
                : Array.isArray(headerKey) && typeof headerKey[0] === "string"
                    ? headerKey[0]
                    : null;

        const effectiveLocalId = localId ?? idempotencyKey ?? null;

        const result = await createSessionMessage({
            actorUserId: userId,
            sessionId,
            ciphertext,
            localId: effectiveLocalId,
        });

        if (!result.ok) {
            if (result.error === "invalid-params") return reply.code(400).send({ error: "Invalid parameters" });
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
        }

        return reply.send({
            didWrite: result.didWrite,
            message: {
                id: result.message.id,
                seq: result.message.seq,
                localId: result.message.localId,
                createdAt: result.message.createdAt.getTime(),
            },
        });
    });
}

import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { buildMessageUpdatedUpdate, buildNewMessageUpdate, eventRouter } from "@/app/events/eventRouter";
import { catchupFollowupFetchesCounter, catchupFollowupReturnedCounter } from "@/app/monitoring/metrics2";
import {
    SessionMessageDeliveryResolutionV1Schema,
    SessionMessageRoleSchema,
    SessionStoredMessageContentSchema,
    SessionTranscriptObservationProvenanceV1Schema,
    isSessionAgentTransitionDividerLocalId,
    type SessionMessageRole,
} from "@happier-dev/protocol";
import { parseSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import { createSessionMessage } from "@/app/session/sessionWriteService";
import { parseSessionMessageSidechainId } from "@/app/session/parseSessionMessageSidechainId";
import { publishSessionReadyProjectionUpdate } from "@/app/session/ready/publishSessionReadyProjectionUpdate";
import { checkSessionAccess, requireAccessLevel } from "@/app/share/accessControl";
import { db } from "@/storage/db";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { type Fastify } from "../../types";

type SessionStoredMessageContent = z.infer<typeof SessionStoredMessageContentSchema>;

function parseSessionMessageRoleCsv(value: unknown): { ok: true; roles: string[] } | { ok: false } {
    if (typeof value !== "string") return { ok: false };

    const roles = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    if (roles.length === 0) return { ok: false };

    return { ok: true, roles };
}

function resolveRequestedMessageRoles(query: Readonly<{ role?: unknown; roles?: unknown }> | undefined): { ok: true; roles: SessionMessageRole[] } | { ok: false } {
    if (!query || (query.role === undefined && query.roles === undefined)) return { ok: true, roles: [] };
    if (Array.isArray(query.role) || Array.isArray(query.roles)) return { ok: false };

    const roles: SessionMessageRole[] = [];
    if (query.role !== undefined) {
        const parsed = SessionMessageRoleSchema.safeParse(query.role);
        if (!parsed.success) return { ok: false };
        roles.push(parsed.data);
    }

    if (query.roles !== undefined) {
        const csv = parseSessionMessageRoleCsv(query.roles);
        if (!csv.ok) return { ok: false };
        for (const rawRole of csv.roles) {
            const parsed = SessionMessageRoleSchema.safeParse(rawRole);
            if (!parsed.success) return { ok: false };
            roles.push(parsed.data);
        }
    }

    return { ok: true, roles: Array.from(new Set(roles)) };
}

function buildRequestedMessageRoleWhere(roles: readonly SessionMessageRole[]): Prisma.SessionMessageWhereInput | null {
    if (roles.length === 0) return null;

    const concreteRoleFilter = roles.length === 1 ? roles[0] : { in: [...roles] };
    if (!roles.includes("user")) {
        return { messageRole: concreteRoleFilter };
    }

    return {
        OR: [
            { messageRole: concreteRoleFilter },
            { messageRole: null },
        ],
    };
}

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
                        messageRole: SessionMessageRoleSchema.nullable().optional(),
                        content: SessionStoredMessageContentSchema,
                        createdAt: z.number().int().min(0),
                        updatedAt: z.number().int().min(0),
                        sourceCreatedAt: z.number().int().min(0).optional(),
                        sourceUpdatedAt: z.number().int().min(0).optional(),
                        transcriptObservationProvenance: SessionTranscriptObservationProvenanceV1Schema.optional(),
                        deliveryResolution: SessionMessageDeliveryResolutionV1Schema.optional(),
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
                messageRole: true,
                createdAt: true,
                updatedAt: true,
                sourceCreatedAt: true,
                sourceUpdatedAt: true,
                transcriptObservationProvenance: true,
                deliveryResolution: true,
            },
        });
        if (!row) {
            return reply.code(404).send({ error: 'Message not found' });
        }

        const messageRole = parseSessionMessageRole(row.messageRole);
        const transcriptObservationProvenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(
            row.transcriptObservationProvenance,
        );
        const deliveryResolution = SessionMessageDeliveryResolutionV1Schema.safeParse(row.deliveryResolution);
        return reply.send({
            message: {
                id: row.id,
                seq: row.seq,
                localId: row.localId,
                ...(typeof row.sidechainId === "string" && row.sidechainId ? { sidechainId: row.sidechainId } : {}),
                ...(messageRole ? { messageRole } : {}),
                content: row.content,
                createdAt: row.createdAt.getTime(),
                updatedAt: row.updatedAt.getTime(),
                ...(row.sourceCreatedAt ? { sourceCreatedAt: row.sourceCreatedAt.getTime() } : {}),
                ...(row.sourceUpdatedAt ? { sourceUpdatedAt: row.sourceUpdatedAt.getTime() } : {}),
                ...(transcriptObservationProvenance.success
                    ? { transcriptObservationProvenance: transcriptObservationProvenance.data }
                    : {}),
                ...(deliveryResolution.success ? { deliveryResolution: deliveryResolution.data } : {}),
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
                role: SessionMessageRoleSchema.optional(),
                roles: z.string().optional(),
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
                  role?: unknown;
                  roles?: unknown;
              }>
            | undefined;
        const { limit = 150, beforeSeq, afterSeq } = query ?? {};
        const parsedRoles = resolveRequestedMessageRoles(query);
        if (!parsedRoles.ok) {
            return reply.code(400).send({ error: "Invalid parameters", code: "invalid-role" });
        }
        const roles = parsedRoles.roles;

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
        const roleWhere = buildRequestedMessageRoleWhere(roles);
        if (roleWhere) Object.assign(where, roleWhere);
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
                messageRole: true,
                content: true,
                createdAt: true,
                updatedAt: true,
                sourceCreatedAt: true,
                sourceUpdatedAt: true,
                transcriptObservationProvenance: true,
                deliveryResolution: true,
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
                ...(() => {
                    const messageRole = parseSessionMessageRole(v.messageRole);
                    return messageRole ? { messageRole } : {};
                })(),
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                ...(v.sourceCreatedAt ? { sourceCreatedAt: v.sourceCreatedAt.getTime() } : {}),
                ...(v.sourceUpdatedAt ? { sourceUpdatedAt: v.sourceUpdatedAt.getTime() } : {}),
                ...(() => {
                    const provenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(
                        v.transcriptObservationProvenance,
                    );
                    return provenance.success ? { transcriptObservationProvenance: provenance.data } : {};
                })(),
                ...(() => {
                    const resolution = SessionMessageDeliveryResolutionV1Schema.safeParse(v.deliveryResolution);
                    return resolution.success ? { deliveryResolution: resolution.data } : {};
                })(),
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
                    messageRole: z.unknown().optional(),
                    sessionEventType: z.literal("ready").optional(),
                }),
                z.object({
                    content: SessionStoredMessageContentSchema,
                    localId: z.string().optional(),
                    sidechainId: z.string().min(1).nullable().optional(),
                    messageRole: z.unknown().optional(),
                    sessionEventType: z.literal("ready").optional(),
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
        const body = request.body as Readonly<{
            localId?: string;
            sidechainId?: string | null;
            messageRole?: unknown;
            sessionEventType?: "ready";
        } & ({ ciphertext: string } | { content: SessionStoredMessageContent })>;
        const localId = typeof body.localId === "string" ? body.localId : undefined;
        const trustedSessionEventType = body.sessionEventType === "ready" ? "ready" : undefined;
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
        // The Agent-transition divider namespace is reserved for the owner-only
        // cutover command. The check is on `effectiveLocalId` because the
        // `idempotency-key` header is a second injection path for a localId.
        if (isSessionAgentTransitionDividerLocalId(effectiveLocalId)) {
            return reply.code(400).send({ error: "Invalid parameters", code: "reserved-local-id" });
        }
        const result =
            "content" in body
                ? await createSessionMessage({
                      actorUserId: userId,
                      sessionId,
                      content: body.content,
                      localId: effectiveLocalId,
                      sidechainId,
                      messageRole: body.messageRole,
                      ...(trustedSessionEventType ? { trustedSessionEventType } : {}),
                  })
                : await createSessionMessage({
                      actorUserId: userId,
                      sessionId,
                      ciphertext: body.ciphertext,
                      localId: effectiveLocalId,
                      sidechainId,
                      messageRole: body.messageRole,
                      ...(trustedSessionEventType ? { trustedSessionEventType } : {}),
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
                const options = result.attentionImpact ? { attentionImpact: result.attentionImpact } : undefined;
                const payload = options
                    ? buildNewMessageUpdate(result.message, sessionId, cursor, randomKeyNaked(12), options)
                    : buildNewMessageUpdate(result.message, sessionId, cursor, randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId },
                });
            }));
            await publishSessionReadyProjectionUpdate({
                sessionId,
                readyProjection: result.readyProjection,
            });
        } else if (result.didUpdate) {
            await Promise.all(result.participantCursors.map(async ({ accountId, cursor }) => {
                const options = result.attentionImpact ? { attentionImpact: result.attentionImpact } : undefined;
                const payload = options
                    ? buildMessageUpdatedUpdate(result.message, sessionId, cursor, randomKeyNaked(12), options)
                    : buildMessageUpdatedUpdate(result.message, sessionId, cursor, randomKeyNaked(12));
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

import { eventRouter, buildNewMessageUpdate, buildNewSessionUpdate, buildUpdateSessionUpdate } from "@/app/events/eventRouter";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { sessionDelete } from "@/app/session/sessionDelete";
import { checkSessionAccess } from "@/app/share/accessControl";
import { PROFILE_SELECT, toShareUserProfile } from "@/app/share/types";
import { inTx, afterTx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { createSessionMessage, patchSession } from "@/app/session/sessionWriteService";
import { catchupFollowupFetchesCounter, catchupFollowupReturnedCounter } from "@/app/monitoring/metrics2";

export function sessionRoutes(app: Fastify) {

    // Sessions API
    app.get('/v1/sessions', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;

        const [ownedSessions, shares] = await Promise.all([
            db.session.findMany({
                where: { accountId: userId },
                orderBy: { updatedAt: 'desc' },
                take: 150,
                select: {
                    id: true,
                    seq: true,
                    createdAt: true,
                    updatedAt: true,
                    metadata: true,
                    metadataVersion: true,
                    agentState: true,
                    agentStateVersion: true,
                    dataEncryptionKey: true,
                    active: true,
                    lastActiveAt: true,
                }
            }),
            db.sessionShare.findMany({
                where: { sharedWithUserId: userId },
                orderBy: { session: { updatedAt: 'desc' } },
                take: 150,
                select: {
                    accessLevel: true,
                    canApprovePermissions: true,
                    encryptedDataKey: true,
                    sharedByUserId: true,
                    sharedByUser: { select: PROFILE_SELECT },
                    session: {
                        select: {
                            id: true,
                            seq: true,
                            createdAt: true,
                            updatedAt: true,
                            metadata: true,
                            metadataVersion: true,
                            agentState: true,
                            agentStateVersion: true,
                            active: true,
                            lastActiveAt: true,
                        }
                    }
                }
            }),
        ]);

        const sessions = [
            ...ownedSessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
                lastMessage: null,
            })),
            ...shares.map((share) => {
                const v = share.session;
                return {
                    id: v.id,
                    seq: v.seq,
                    createdAt: v.createdAt.getTime(),
                    updatedAt: v.updatedAt.getTime(),
                    active: v.active,
                    activeAt: v.lastActiveAt.getTime(),
                    metadata: v.metadata,
                    metadataVersion: v.metadataVersion,
                    agentState: v.agentState,
                    agentStateVersion: v.agentStateVersion,
                    // Important: for shared sessions, return the recipient-wrapped DEK.
                    dataEncryptionKey: Buffer.from(share.encryptedDataKey).toString('base64'),
                    lastMessage: null,
                    owner: share.sharedByUserId,
                    ownerProfile: toShareUserProfile(share.sharedByUser),
                    accessLevel: share.accessLevel,
                    canApprovePermissions: share.canApprovePermissions,
                };
            }),
        ]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 150);

        return reply.send({ sessions });
    });

    // V2 Sessions API - Active sessions only
    app.get('/v2/sessions/active', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(500).default(150)
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const limit = request.query?.limit || 150;

        const sessions = await db.session.findMany({
            where: {
                accountId: userId,
                active: true,
                lastActiveAt: { gt: new Date(Date.now() - 1000 * 60 * 15) /* 15 minutes */ }
            },
            orderBy: { lastActiveAt: 'desc' },
            take: limit,
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
            }
        });

        return reply.send({
            sessions: sessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
            }))
        });
    });

    // V2 Sessions API - Cursor-based pagination with change tracking
    app.get('/v2/sessions', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                cursor: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(200).default(50),
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { cursor, limit = 50 } = request.query || {};

        // Decode cursor - simple ID-based cursor
        let cursorSessionId: string | undefined;
        if (cursor) {
            if (cursor.startsWith('cursor_v1_')) {
                cursorSessionId = cursor.substring(10);
            } else {
                return reply.code(400).send({ error: 'Invalid cursor format' });
            }
        }

        // Build where clause:
        // Return every session the account can access (owned + shared).
        const where: Prisma.SessionWhereInput = {
            OR: [
                { accountId: userId },
                { shares: { some: { sharedWithUserId: userId } } },
            ]
        };

        // Add cursor pagination - always by ID descending (most recent first)
        if (cursorSessionId) {
            where.id = {
                lt: cursorSessionId  // Get sessions with ID less than cursor (for desc order)
            };
        }

        // Always sort by ID descending for consistent pagination
        const orderBy = { id: 'desc' as const };

        const sessions = await db.session.findMany({
            where,
            orderBy,
            take: limit + 1, // Fetch one extra to determine if there are more
            select: {
                id: true,
                seq: true,
                accountId: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
                shares: {
                    where: { sharedWithUserId: userId },
                    select: {
                        encryptedDataKey: true,
                        accessLevel: true,
                        canApprovePermissions: true,
                    }
                }
            }
        });

        // Check if there are more results
        const hasNext = sessions.length > limit;
        const resultSessions = hasNext ? sessions.slice(0, limit) : sessions;

        // Generate next cursor - simple ID-based cursor
        let nextCursor: string | null = null;
        if (hasNext && resultSessions.length > 0) {
            const lastSession = resultSessions[resultSessions.length - 1];
            nextCursor = `cursor_v1_${lastSession.id}`;
        }

        return reply.send({
            sessions: resultSessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                // For owned sessions, return the raw session DEK stored on the session row.
                // For shared sessions, return the per-recipient encrypted DEK from the share row.
                dataEncryptionKey: v.accountId === userId
                    ? (v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null)
                    : (v.shares[0]?.encryptedDataKey ? Buffer.from(v.shares[0].encryptedDataKey).toString('base64') : null),
                // Best-effort share info for shared sessions (owner sessions return null here).
                share: v.accountId === userId
                    ? null
                    : (v.shares[0]
                        ? {
                            accessLevel: v.shares[0].accessLevel,
                            canApprovePermissions: v.shares[0].canApprovePermissions,
                        }
                        : null),
            })),
            nextCursor,
            hasNext
        });
    });

    // V2 - Fetch a single session by id (used by CLI/app snapshot sync paths)
    app.get('/v2/sessions/:sessionId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            response: {
                200: z.object({
                    session: z.object({
                        id: z.string(),
                        seq: z.number(),
                        createdAt: z.number(),
                        updatedAt: z.number(),
                        active: z.boolean(),
                        activeAt: z.number(),
                        metadata: z.string(),
                        metadataVersion: z.number(),
                        agentState: z.string().nullable(),
                        agentStateVersion: z.number(),
                        dataEncryptionKey: z.string().nullable(),
                        share: z
                            .object({
                                accessLevel: z.string(),
                                canApprovePermissions: z.boolean(),
                            })
                            .nullable(),
                    }),
                }),
                404: z.object({ error: z.literal('Session not found') }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                OR: [
                    { accountId: userId },
                    { shares: { some: { sharedWithUserId: userId } } },
                ],
            },
            select: {
                id: true,
                seq: true,
                accountId: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
                shares: {
                    where: { sharedWithUserId: userId },
                    select: {
                        encryptedDataKey: true,
                        accessLevel: true,
                        canApprovePermissions: true,
                    },
                },
            },
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        return reply.send({
            session: {
                id: session.id,
                seq: session.seq,
                createdAt: session.createdAt.getTime(),
                updatedAt: session.updatedAt.getTime(),
                active: session.active,
                activeAt: session.lastActiveAt.getTime(),
                metadata: session.metadata,
                metadataVersion: session.metadataVersion,
                agentState: session.agentState,
                agentStateVersion: session.agentStateVersion,
                dataEncryptionKey: session.accountId === userId
                    ? (session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null)
                    : (session.shares[0]?.encryptedDataKey ? Buffer.from(session.shares[0].encryptedDataKey).toString('base64') : null),
                share: session.accountId === userId
                    ? null
                    : (session.shares[0]
                        ? { accessLevel: session.shares[0].accessLevel, canApprovePermissions: session.shares[0].canApprovePermissions }
                        : null),
            },
        });
    });

    // Create or load session by tag
    app.post('/v1/sessions', {
        schema: {
            body: z.object({
                tag: z.string(),
                metadata: z.string(),
                agentState: z.string().nullish(),
                dataEncryptionKey: z.string().nullish()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { tag, metadata, dataEncryptionKey } = request.body;

        const session = await db.session.findFirst({
            where: {
                accountId: userId,
                tag: tag
            }
        });
        if (session) {
            log({ module: 'session-create', sessionId: session.id, userId, tag }, `Found existing session: ${session.id} for tag ${tag}`);
            return reply.send({
                session: {
                    id: session.id,
                    seq: session.seq,
                    metadata: session.metadata,
                    metadataVersion: session.metadataVersion,
                    agentState: session.agentState,
                    agentStateVersion: session.agentStateVersion,
                    dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
                    active: session.active,
                    activeAt: session.lastActiveAt.getTime(),
                    createdAt: session.createdAt.getTime(),
                    updatedAt: session.updatedAt.getTime(),
                    lastMessage: null
                }
            });
        } else {
            log({ module: 'session-create', userId, tag }, `Creating new session for user ${userId} with tag ${tag}`);
            const session = await inTx(async (tx) => {
                const created = await tx.session.create({
                    data: {
                        accountId: userId,
                        tag,
                        metadata,
                        dataEncryptionKey: dataEncryptionKey ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64')) : undefined,
                    },
                });

                const cursor = await markAccountChanged(tx, { accountId: userId, kind: 'session', entityId: created.id });

                afterTx(tx, () => {
                    const updatePayload = buildNewSessionUpdate(created, cursor, randomKeyNaked(12));
                    log({
                        module: 'session-create',
                        userId,
                        sessionId: created.id,
                        updateType: 'new-session',
                        updateId: updatePayload.id,
                        updateSeq: updatePayload.seq,
                    }, 'Emitting new-session update to user-scoped connections');
                    eventRouter.emitUpdate({
                        userId,
                        payload: updatePayload,
                        recipientFilter: { type: 'user-scoped-only' },
                    });
                });

                return created;
            });

            log({ module: 'session-create', sessionId: session.id, userId }, `Session created: ${session.id}`);

            return reply.send({
                session: {
                    id: session.id,
                    seq: session.seq,
                    metadata: session.metadata,
                    metadataVersion: session.metadataVersion,
                    agentState: session.agentState,
                    agentStateVersion: session.agentStateVersion,
                    dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
                    active: session.active,
                    activeAt: session.lastActiveAt.getTime(),
                    createdAt: session.createdAt.getTime(),
                    updatedAt: session.updatedAt.getTime(),
                    lastMessage: null
                }
            });
        }
    });

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

    // V2 - Create session message (durable write)
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
            message: {
                id: result.message.id,
                seq: result.message.seq,
                localId: result.message.localId,
                createdAt: result.message.createdAt.getTime(),
            },
        });
    });

    // V2 - Patch session fields (durable write)
    app.patch('/v2/sessions/:sessionId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.object({
                metadata: z.object({
                    ciphertext: z.string(),
                    expectedVersion: z.number().int().min(0),
                }).optional(),
                agentState: z.object({
                    ciphertext: z.string().nullable(),
                    expectedVersion: z.number().int().min(0),
                }).optional(),
            }),
            response: {
                200: z.union([
                    z.object({
                        success: z.literal(true),
                        metadata: z.object({ version: z.number() }).optional(),
                        agentState: z.object({ version: z.number() }).optional(),
                    }),
                    z.object({
                        success: z.literal(false),
                        error: z.literal("version-mismatch"),
                        metadata: z.object({ version: z.number(), value: z.string().nullable() }).optional(),
                        agentState: z.object({ version: z.number(), value: z.string().nullable() }).optional(),
                    }),
                ]),
                400: z.object({ error: z.literal("Invalid parameters") }),
                403: z.object({ error: z.literal("Forbidden") }),
                404: z.object({ error: z.literal("Session not found") }),
                500: z.object({ error: z.literal("Failed to update session") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { metadata, agentState } = request.body;

        const result = await patchSession({
            actorUserId: userId,
            sessionId,
            metadata: metadata ? { ciphertext: metadata.ciphertext, expectedVersion: metadata.expectedVersion } : undefined,
            agentState: agentState ? { ciphertext: agentState.ciphertext, expectedVersion: agentState.expectedVersion } : undefined,
        });

        if (!result.ok) {
            if (result.error === "invalid-params") return reply.code(400).send({ error: "Invalid parameters" });
            if (result.error === "forbidden") return reply.code(403).send({ error: "Forbidden" });
            if (result.error === "session-not-found") return reply.code(404).send({ error: "Session not found" });
            if (result.error === "version-mismatch") {
                if (!result.current) {
                    return reply.code(500).send({ error: "Failed to update session" });
                }
                return reply.send({
                    success: false as const,
                    error: "version-mismatch" as const,
                    ...(result.current?.metadata ? { metadata: result.current.metadata } : {}),
                    ...(result.current?.agentState ? { agentState: result.current.agentState } : {}),
                });
            }
            return reply.code(500).send({ error: "Failed to update session" });
        }

        const metadataUpdate = result.metadata ? { value: result.metadata.value, version: result.metadata.version } : undefined;
        const agentStateUpdate = result.agentState ? { value: result.agentState.value, version: result.agentState.version } : undefined;

        await Promise.all(result.participantCursors.map(async ({ accountId, cursor }) => {
            const payload = buildUpdateSessionUpdate(sessionId, cursor, randomKeyNaked(12), metadataUpdate, agentStateUpdate);
            eventRouter.emitUpdate({
                userId: accountId,
                payload,
                recipientFilter: { type: "all-interested-in-session", sessionId },
            });
        }));

        return reply.send({
            success: true as const,
            ...(result.metadata ? { metadata: { version: result.metadata.version } } : {}),
            ...(result.agentState ? { agentState: { version: result.agentState.version } } : {}),
        });
    });

    // Delete session
    app.delete('/v1/sessions/:sessionId', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const deleted = await sessionDelete({ uid: userId }, sessionId);

        if (!deleted) {
            return reply.code(404).send({ error: 'Session not found or not owned by user' });
        }

        return reply.send({ success: true });
    });
}

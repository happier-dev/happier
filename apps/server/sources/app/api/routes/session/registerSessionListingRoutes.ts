import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { PROFILE_SELECT, toShareUserProfile } from "@/app/share/types";
import { db } from "@/storage/db";
import { type Fastify } from "../../types";

function encodeDataEncryptionKey(value: Uint8Array | null): string | null {
    return value ? Buffer.from(value).toString("base64") : null;
}

export function registerSessionListingRoutes(app: Fastify) {
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
                    archivedAt: true,
                    metadata: true,
                    metadataVersion: true,
                    agentState: true,
                    agentStateVersion: true,
                    dataEncryptionKey: true,
                    pendingCount: true,
                    pendingVersion: true,
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
                            archivedAt: true,
                            metadata: true,
                            metadataVersion: true,
                            agentState: true,
                            agentStateVersion: true,
                            pendingCount: true,
                            pendingVersion: true,
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
                archivedAt: v.archivedAt?.getTime() ?? null,
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                pendingCount: v.pendingCount,
                pendingVersion: v.pendingVersion,
                dataEncryptionKey: encodeDataEncryptionKey(v.dataEncryptionKey),
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
                    archivedAt: v.archivedAt?.getTime() ?? null,
                    metadata: v.metadata,
                    metadataVersion: v.metadataVersion,
                    agentState: v.agentState,
                    agentStateVersion: v.agentStateVersion,
                    pendingCount: v.pendingCount,
                    pendingVersion: v.pendingVersion,
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
                lastActiveAt: { gt: new Date(Date.now() - 1000 * 60 * 15) },
            },
            orderBy: { lastActiveAt: 'desc' },
            take: limit,
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                archivedAt: true,
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
                archivedAt: v.archivedAt?.getTime() ?? null,
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                dataEncryptionKey: encodeDataEncryptionKey(v.dataEncryptionKey),
            }))
        });
    });

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

        let cursorSessionId: string | undefined;
        if (cursor) {
            if (cursor.startsWith('cursor_v1_')) {
                cursorSessionId = cursor.substring(10);
            } else {
                return reply.code(400).send({ error: 'Invalid cursor format' });
            }
        }

        const where: Prisma.SessionWhereInput = {
            OR: [
                { accountId: userId },
                { shares: { some: { sharedWithUserId: userId } } },
            ]
        };
        if (cursorSessionId) {
            where.id = { lt: cursorSessionId };
        }

        const sessions = await db.session.findMany({
            where,
            orderBy: { id: 'desc' as const },
            take: limit + 1,
            select: {
                id: true,
                seq: true,
                accountId: true,
                createdAt: true,
                updatedAt: true,
                archivedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                pendingCount: true,
                pendingVersion: true,
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

        const hasNext = sessions.length > limit;
        const resultSessions = hasNext ? sessions.slice(0, limit) : sessions;
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
                archivedAt: v.archivedAt?.getTime() ?? null,
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                pendingCount: v.pendingCount,
                pendingVersion: v.pendingVersion,
                dataEncryptionKey: v.accountId === userId
                    ? encodeDataEncryptionKey(v.dataEncryptionKey)
                    : (v.shares[0]?.encryptedDataKey ? Buffer.from(v.shares[0].encryptedDataKey).toString('base64') : null),
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

    app.get('/v2/sessions/archived', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                cursor: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(200).default(50),
            }).optional(),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { cursor, limit = 50 } = request.query || {};

        let cursorSessionId: string | undefined;
        if (cursor) {
            if (cursor.startsWith('cursor_v1_')) {
                cursorSessionId = cursor.substring(10);
            } else {
                return reply.code(400).send({ error: 'Invalid cursor format' });
            }
        }

        const where: Prisma.SessionWhereInput = {
            archivedAt: { not: null },
            OR: [
                { accountId: userId },
                { shares: { some: { sharedWithUserId: userId } } },
            ],
        };
        if (cursorSessionId) {
            where.id = { lt: cursorSessionId };
        }

        const sessions = await db.session.findMany({
            where,
            orderBy: { id: 'desc' as const },
            take: limit + 1,
            select: {
                id: true,
                seq: true,
                accountId: true,
                createdAt: true,
                updatedAt: true,
                archivedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                pendingCount: true,
                pendingVersion: true,
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

        const hasNext = sessions.length > limit;
        const resultSessions = hasNext ? sessions.slice(0, limit) : sessions;
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
                archivedAt: v.archivedAt?.getTime() ?? null,
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                pendingCount: v.pendingCount,
                pendingVersion: v.pendingVersion,
                dataEncryptionKey: v.accountId === userId
                    ? encodeDataEncryptionKey(v.dataEncryptionKey)
                    : (v.shares[0]?.encryptedDataKey ? Buffer.from(v.shares[0].encryptedDataKey).toString('base64') : null),
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
            hasNext,
        });
    });

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
                        archivedAt: z.number().nullable(),
                        metadata: z.string(),
                        metadataVersion: z.number(),
                        agentState: z.string().nullable(),
                        agentStateVersion: z.number(),
                        pendingCount: z.number().int().min(0),
                        pendingVersion: z.number().int().min(0),
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
                archivedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                pendingCount: true,
                pendingVersion: true,
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
                archivedAt: session.archivedAt?.getTime() ?? null,
                metadata: session.metadata,
                metadataVersion: session.metadataVersion,
                agentState: session.agentState,
                agentStateVersion: session.agentStateVersion,
                pendingCount: session.pendingCount,
                pendingVersion: session.pendingVersion,
                dataEncryptionKey: session.accountId === userId
                    ? encodeDataEncryptionKey(session.dataEncryptionKey)
                    : (session.shares[0]?.encryptedDataKey ? Buffer.from(session.shares[0].encryptedDataKey).toString('base64') : null),
                share: session.accountId === userId
                    ? null
                    : (session.shares[0]
                        ? { accessLevel: session.shares[0].accessLevel, canApprovePermissions: session.shares[0].canApprovePermissions }
                        : null),
            },
        });
    });
}

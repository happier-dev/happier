import type { Prisma } from "@prisma/client";
import { z } from "zod";

import {
  V2SessionByIdNotFoundSchema,
  V2SessionByIdResponseSchema,
  V2SessionListResponseSchema,
  decodeV2SessionListCursorV1,
  encodeV2SessionListCursorV1,
} from "@happier-dev/protocol";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { PROFILE_SELECT, toShareUserProfile } from "@/app/share/types";
import { db } from "@/storage/db";
import { type Fastify } from "../../types";
import {
    createV2SessionListRowSelect,
    createV2SessionListVisibilityWhere,
    encodeSessionDataEncryptionKey,
    mapV2SessionListRow,
    type V2SessionListRow,
} from "./v2SessionListRows";

const V2_ACTIVE_SESSION_LIST_QUERYSTRING_SCHEMA = z.object({
    limit: z.coerce.number().int().min(1).max(500).default(150),
}).optional();

const V2_PAGED_SESSION_LIST_QUERYSTRING_SCHEMA = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
}).optional();

const ACTIVE_SESSION_WINDOW_MS = 1000 * 60 * 15;

async function findV2SessionListRows(params: Readonly<{
    userId: string;
    orderBy: Prisma.SessionOrderByWithRelationInput;
    take: number;
    where?: Prisma.SessionWhereInput;
}>): Promise<V2SessionListRow[]> {
    const { userId, orderBy, take, where } = params;

    return await db.session.findMany({
        where: {
            ...createV2SessionListVisibilityWhere({ userId }),
            ...(where ?? {}),
        },
        orderBy,
        take,
        select: createV2SessionListRowSelect({ userId }),
    });
}

function mapV2SessionListRows(params: Readonly<{ rows: ReadonlyArray<V2SessionListRow>; userId: string }>) {
    return params.rows.map((row) => mapV2SessionListRow({ row, userId: params.userId }));
}

function createV2SessionListPage(params: Readonly<{
    rows: ReadonlyArray<V2SessionListRow>;
    userId: string;
    limit: number;
}>) {
    const { rows, userId, limit } = params;
    const hasNext = rows.length > limit;
    const resultRows = hasNext ? rows.slice(0, limit) : rows;
    const lastRow = resultRows[resultRows.length - 1] ?? null;

    return {
        sessions: mapV2SessionListRows({ rows: resultRows, userId }),
        nextCursor: hasNext && lastRow ? encodeV2SessionListCursorV1(lastRow.id) : null,
        hasNext,
    };
}

export function registerSessionListingRoutes(app: Fastify) {
    app.get('/v1/sessions', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "sessions.list"),
        },
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
                    encryptionMode: true,
                    metadata: true,
                    metadataVersion: true,
                    agentState: true,
                    agentStateVersion: true,
                    lastViewedSessionSeq: true,
                    pendingPermissionRequestCount: true,
                    pendingUserActionRequestCount: true,
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
                            encryptionMode: true,
                            metadata: true,
                            metadataVersion: true,
                            agentState: true,
                            agentStateVersion: true,
                            lastViewedSessionSeq: true,
                            pendingPermissionRequestCount: true,
                            pendingUserActionRequestCount: true,
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
                encryptionMode: v.encryptionMode === "plain" ? "plain" : "e2ee",
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                lastViewedSessionSeq: v.lastViewedSessionSeq ?? null,
                pendingPermissionRequestCount: v.pendingPermissionRequestCount,
                pendingUserActionRequestCount: v.pendingUserActionRequestCount,
                pendingCount: v.pendingCount,
                pendingVersion: v.pendingVersion,
                dataEncryptionKey: encodeSessionDataEncryptionKey(v.dataEncryptionKey),
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
                    encryptionMode: v.encryptionMode === "plain" ? "plain" : "e2ee",
                    metadata: v.metadata,
                    metadataVersion: v.metadataVersion,
                    agentState: v.agentState,
                    agentStateVersion: v.agentStateVersion,
                    lastViewedSessionSeq: v.lastViewedSessionSeq ?? null,
                    pendingPermissionRequestCount: v.pendingPermissionRequestCount,
                    pendingUserActionRequestCount: v.pendingUserActionRequestCount,
                    pendingCount: v.pendingCount,
                    pendingVersion: v.pendingVersion,
                    dataEncryptionKey:
                        v.encryptionMode === "plain"
                            ? null
                            : (share.encryptedDataKey ? Buffer.from(share.encryptedDataKey).toString('base64') : null),
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
            response: {
                200: V2SessionListResponseSchema,
            },
            querystring: V2_ACTIVE_SESSION_LIST_QUERYSTRING_SCHEMA,
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const limit = request.query?.limit || 150;

        const sessions = await findV2SessionListRows({
            userId,
            where: {
                active: true,
                lastActiveAt: { gt: new Date(Date.now() - ACTIVE_SESSION_WINDOW_MS) },
            },
            orderBy: { lastActiveAt: 'desc' },
            take: limit,
        });

        return reply.send({
            sessions: mapV2SessionListRows({ rows: sessions, userId }),
        });
    });

    app.get('/v2/sessions', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: V2SessionListResponseSchema,
                400: z.object({ error: z.literal('Invalid cursor format') }),
            },
            querystring: V2_PAGED_SESSION_LIST_QUERYSTRING_SCHEMA,
        },
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "sessions.list"),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { cursor, limit = 50 } = request.query || {};

        let cursorSessionId: string | undefined;
        if (cursor) {
            const decoded = decodeV2SessionListCursorV1(cursor);
            if (!decoded) {
                return reply.code(400).send({ error: 'Invalid cursor format' });
            }
            cursorSessionId = decoded;
        }

        const where: Prisma.SessionWhereInput = {};
        if (cursorSessionId) {
            where.id = { lt: cursorSessionId };
        }

        const sessions = await findV2SessionListRows({
            userId,
            where,
            orderBy: { id: 'desc' as const },
            take: limit + 1,
        });

        return reply.send(createV2SessionListPage({ rows: sessions, userId, limit }));
    });

    app.get('/v2/sessions/archived', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: V2SessionListResponseSchema,
                400: z.object({ error: z.literal('Invalid cursor format') }),
            },
            querystring: V2_PAGED_SESSION_LIST_QUERYSTRING_SCHEMA,
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { cursor, limit = 50 } = request.query || {};

        let cursorSessionId: string | undefined;
        if (cursor) {
            const decoded = decodeV2SessionListCursorV1(cursor);
            if (!decoded) {
                return reply.code(400).send({ error: 'Invalid cursor format' });
            }
            cursorSessionId = decoded;
        }

        const where: Prisma.SessionWhereInput = {
            archivedAt: { not: null },
        };
        if (cursorSessionId) {
            where.id = { lt: cursorSessionId };
        }

        const sessions = await findV2SessionListRows({
            userId,
            where,
            orderBy: { id: 'desc' as const },
            take: limit + 1,
        });

        return reply.send(createV2SessionListPage({ rows: sessions, userId, limit }));
    });

    app.get('/v2/sessions/:sessionId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            response: {
                200: V2SessionByIdResponseSchema,
                404: V2SessionByIdNotFoundSchema,
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
                encryptionMode: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                lastViewedSessionSeq: true,
                pendingPermissionRequestCount: true,
                pendingUserActionRequestCount: true,
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
                encryptionMode: session.encryptionMode === "plain" ? "plain" : "e2ee",
                metadata: session.metadata,
                metadataVersion: session.metadataVersion,
                agentState: session.agentState,
                agentStateVersion: session.agentStateVersion,
                lastViewedSessionSeq: session.lastViewedSessionSeq ?? null,
                pendingPermissionRequestCount: session.pendingPermissionRequestCount,
                pendingUserActionRequestCount: session.pendingUserActionRequestCount,
                pendingCount: session.pendingCount,
                pendingVersion: session.pendingVersion,
                dataEncryptionKey: session.accountId === userId
                    ? encodeSessionDataEncryptionKey(session.dataEncryptionKey)
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

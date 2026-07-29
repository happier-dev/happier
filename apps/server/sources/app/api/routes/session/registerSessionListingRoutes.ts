import type { Prisma } from "@prisma/client";
import { z } from "zod";

import {
  V2SessionByIdNotFoundSchema,
  V2SessionByIdResponseSchema,
  V2SessionListResponseSchema,
} from "@happier-dev/protocol";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { PROFILE_SELECT, toShareUserProfile } from "@/app/share/types";
import { fetchSessionOrganizationPinnedSessionIds } from "@/app/session/organization/organizationQueries";
import { db } from "@/storage/db";
import { type Fastify } from "../../types";
import {
    createSessionRollbackEligibleTurnsSelect,
    encodeSessionDataEncryptionKey,
    parseStoredSessionLatestTurnStatus,
    parseStoredSessionRuntimeIssue,
    readSessionTranscriptAuthorityFields,
    readSessionTurnRollbackEligibleStarts,
} from "./v2SessionListRows";
import {
    createV2SessionListCursorWhere,
    createV2SessionListPage,
    findV2SessionListRows,
    isMissingAttentionProjectionColumnError,
    mapV2SessionListRows,
    resolveV2SessionListCursorForVisibleRows,
    V2_ACTIVE_SESSION_LIST_ORDER_BY,
    V2_SESSION_LIST_ORDER_BY,
} from "./v2SessionListPage";
import {
    createV2SessionAttentionPage,
    createV2SessionListInitialPage,
} from "./v2SessionListInitialPage";
import { createV2SessionListServerTiming } from "./v2SessionListServerTiming";
import {
    applySessionTranscriptPublicationCeilingToProjection,
    collectSessionTranscriptVisibleRowsBeforeTake,
    createSessionTranscriptShareableRecencyQueryBranches,
    isSessionTranscriptShareable,
    resolveSessionTranscriptNonOwnerRecencyMs,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import {
    createSessionMetadataPrivacyUpgradeRequiredResponse,
    isSessionMetadataPrivacyUpgradeRequiredError,
    projectSessionMetadataForRecipient,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";

const SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_RESPONSE_SCHEMA = z.object({
    error: z.literal("Session metadata privacy upgrade required"),
    code: z.literal("metadata_privacy_upgrade_required"),
}).strict();

const V2_ACTIVE_SESSION_LIST_QUERYSTRING_SCHEMA = z.object({
    limit: z.coerce.number().int().min(1).max(500).default(150),
}).optional();

const OPTIONAL_BOOLEAN_QUERY_PARAM_SCHEMA = z.preprocess((value) => {
    if (value === true || value === "true" || value === "1") return true;
    if (value === false || value === "false" || value === "0") return false;
    return value;
}, z.boolean()).optional();

const V2_PAGED_SESSION_LIST_QUERYSTRING_SCHEMA = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
}).optional();

const V2_SESSION_LIST_QUERYSTRING_SCHEMA = z.object({
    cursor: z.string().optional(),
    attentionCursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    includeAttention: OPTIONAL_BOOLEAN_QUERY_PARAM_SCHEMA,
}).refine(
    (value) => !(value.cursor && value.attentionCursor),
    { message: "cursor and attentionCursor cannot be combined" },
).optional();

const ACTIVE_SESSION_WINDOW_MS = 1000 * 60 * 15;

function parseInitialIncludeAttention(value: unknown): boolean {
    return value === true || value === "true" || value === "1";
}

function readLatestTurnStatusObservedAt(value: bigint | number | null | undefined): number | null {
    if (typeof value === "bigint") return Number(value);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const SESSION_ROLLBACK_ELIGIBLE_TURNS_SELECT = createSessionRollbackEligibleTurnsSelect();

const V1_SESSION_ROW_SELECT = {
    id: true,
    seq: true,
    accountId: true,
    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    createdAt: true,
    updatedAt: true,
    meaningfulActivityAt: true,
    archivedAt: true,
    encryptionMode: true,
    metadata: true,
    metadataVersion: true,
    metadataLayoutVersion: true,
    ownerMetadata: true,
    agentState: true,
    agentStateVersion: true,
    lastViewedSessionSeq: true,
    pendingPermissionRequestCount: true,
    pendingUserActionRequestCount: true,
    latestTurnId: true,
    latestTurnStatus: true,
    latestTurnStatusObservedAt: true,
    lastRuntimeIssue: true,
    turns: SESSION_ROLLBACK_ELIGIBLE_TURNS_SELECT,
    dataEncryptionKey: true,
    pendingCount: true,
    pendingBlockedCount: true,
    pendingVersion: true,
    active: true,
    lastActiveAt: true,
} as const satisfies Prisma.SessionSelect;

const {
    turns: _v1SessionRowLegacyTurns,
    ...V1_SESSION_ROW_LEGACY_SELECT
} = V1_SESSION_ROW_SELECT;

function createV1SessionRowSelect(params: Readonly<{ includeRollbackTurns: boolean }>): Prisma.SessionSelect {
    return params.includeRollbackTurns ? V1_SESSION_ROW_SELECT : V1_SESSION_ROW_LEGACY_SELECT;
}

function createV1SessionShareSelect(params: Readonly<{ includeRollbackTurns: boolean }>): Prisma.SessionShareSelect {
    return {
        accessLevel: true,
        canApprovePermissions: true,
        encryptedDataKey: true,
        sharedByUserId: true,
        sharedByUser: { select: PROFILE_SELECT },
        session: {
            select: createV1SessionRowSelect(params),
        },
    };
}

async function findV1SessionListRows(userId: string) {
    const query = async (includeRollbackTurns: boolean) => {
        const [ownedSessions, ...shareBranches] = await Promise.all([
            db.session.findMany({
                where: { accountId: userId, archivedAt: null },
                orderBy: { updatedAt: 'desc' },
                take: 150,
                select: createV1SessionRowSelect({ includeRollbackTurns }),
            }),
            ...createSessionTranscriptShareableRecencyQueryBranches().map((branch) =>
                collectSessionTranscriptVisibleRowsBeforeTake({
                    take: 150,
                    fetchPage: async (page) =>
                        await db.sessionShare.findMany({
                            where: {
                                sharedWithUserId: userId,
                                session: {
                                    archivedAt: null,
                                    AND: [branch.where],
                                },
                            },
                            orderBy: branch.orderBy.map((orderBy) => ({ session: orderBy })),
                            ...(page.skip === undefined ? {} : { skip: page.skip }),
                            ...(page.take === undefined ? {} : { take: page.take }),
                            select: createV1SessionShareSelect({ includeRollbackTurns }),
                        }),
                    isOwner: () => false,
                    readPublication: (share) => share.session,
                }),
            ),
        ]);
        const sharesBySessionId = new Map(
            shareBranches
                .flat()
                .map((share) => [share.session.id, share] as const),
        );
        return [ownedSessions, [...sharesBySessionId.values()]] as const;
    };

    try {
        return await query(true);
    } catch (error) {
        if (!isMissingAttentionProjectionColumnError(error)) {
            throw error;
        }
        return await query(false);
    }
}

const V2_SESSION_BY_ID_SELECT = {
    id: true,
    seq: true,
    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    accountId: true,
    createdAt: true,
    updatedAt: true,
    meaningfulActivityAt: true,
    archivedAt: true,
    encryptionMode: true,
    metadata: true,
    metadataVersion: true,
    metadataLayoutVersion: true,
    ownerMetadata: true,
    agentState: true,
    agentStateVersion: true,
    lastViewedSessionSeq: true,
    pendingPermissionRequestCount: true,
    pendingUserActionRequestCount: true,
    latestTurnId: true,
    latestTurnStatus: true,
    latestTurnStatusObservedAt: true,
    lastRuntimeIssue: true,
    turns: SESSION_ROLLBACK_ELIGIBLE_TURNS_SELECT,
    dataEncryptionKey: true,
    pendingCount: true,
    pendingBlockedCount: true,
    pendingVersion: true,
    active: true,
    lastActiveAt: true,
    shares: {
        select: {
            encryptedDataKey: true,
            accessLevel: true,
            canApprovePermissions: true,
        },
    },
} as const satisfies Prisma.SessionSelect;

const {
    turns: _v2SessionByIdLegacyTurns,
    ...V2_SESSION_BY_ID_LEGACY_SELECT
} = V2_SESSION_BY_ID_SELECT;

function createV2SessionByIdSelect(params: Readonly<{ userId: string; includeRollbackTurns: boolean }>): Prisma.SessionSelect {
    const baseSelect = params.includeRollbackTurns ? V2_SESSION_BY_ID_SELECT : V2_SESSION_BY_ID_LEGACY_SELECT;
    return {
        ...baseSelect,
        shares: {
            where: { sharedWithUserId: params.userId },
            select: {
                encryptedDataKey: true,
                accessLevel: true,
                canApprovePermissions: true,
            },
        },
    };
}

async function findV2SessionByIdRow(params: Readonly<{ userId: string; sessionId: string }>) {
    const query = (includeRollbackTurns: boolean) => db.session.findFirst({
        where: {
            id: params.sessionId,
            OR: [
                { accountId: params.userId },
                { shares: { some: { sharedWithUserId: params.userId } } },
            ],
        },
        select: createV2SessionByIdSelect({ userId: params.userId, includeRollbackTurns }),
    });

    let row: Awaited<ReturnType<typeof query>>;
    try {
        row = await query(true);
    } catch (error) {
        if (!isMissingAttentionProjectionColumnError(error)) {
            throw error;
        }
        row = await query(false);
    }
    if (
        row
        && row.accountId !== params.userId
        && !isSessionTranscriptShareable(row)
    ) {
        return null;
    }
    return row;
}

export function registerSessionListingRoutes(app: Fastify) {
    app.get('/v1/sessions', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "sessions.list"),
        },
    }, async (request, reply) => {
        const userId = request.userId;

        const [ownedSessions, shares] = await findV1SessionListRows(userId);

        let sessions;
        try {
            sessions = [
            ...ownedSessions.map((v) => {
                const publicationProjection = applySessionTranscriptPublicationCeilingToProjection({
                    seq: v.seq,
                    lastViewedSessionSeq: v.lastViewedSessionSeq,
                }, v);
                return {
                    id: v.id,
                    seq: publicationProjection.seq,
                    createdAt: v.createdAt.getTime(),
                    updatedAt: v.updatedAt.getTime(),
                    meaningfulActivityAt: (v.meaningfulActivityAt ?? v.createdAt).getTime(),
                    active: v.active,
                    activeAt: v.lastActiveAt.getTime(),
                    archivedAt: v.archivedAt?.getTime() ?? null,
                    encryptionMode: v.encryptionMode === "plain" ? "plain" : "e2ee",
                    ...projectSessionMetadataForRecipient({
                        session: v,
                        recipientAccountId: userId,
                    }),
                    lastViewedSessionSeq: publicationProjection.lastViewedSessionSeq ?? null,
                    pendingPermissionRequestCount: v.pendingPermissionRequestCount,
                    pendingUserActionRequestCount: v.pendingUserActionRequestCount,
                    latestTurnId: v.latestTurnId ?? null,
                    latestTurnStatus: parseStoredSessionLatestTurnStatus(v.latestTurnStatus),
                    latestTurnStatusObservedAt: readLatestTurnStatusObservedAt(v.latestTurnStatusObservedAt),
                    lastRuntimeIssue: parseStoredSessionRuntimeIssue(v.lastRuntimeIssue),
                    rollbackEligibleTurnStarts: readSessionTurnRollbackEligibleStarts(v),
                    ...readSessionTranscriptAuthorityFields(v),
                    pendingCount: v.pendingCount,
                    pendingBlockedCount: v.pendingBlockedCount,
                    pendingVersion: v.pendingVersion,
                    dataEncryptionKey: encodeSessionDataEncryptionKey(v.dataEncryptionKey),
                    lastMessage: null,
                };
            }),
            ...shares.filter((share) => isSessionTranscriptShareable(share.session)).map((share) => {
                const v = share.session;
                const publicationProjection = applySessionTranscriptPublicationCeilingToProjection({
                    seq: v.seq,
                    lastViewedSessionSeq: v.lastViewedSessionSeq,
                }, v);
                return {
                    id: v.id,
                    seq: publicationProjection.seq,
                    createdAt: v.createdAt.getTime(),
                    updatedAt: resolveSessionTranscriptNonOwnerRecencyMs(v, v.updatedAt),
                    meaningfulActivityAt: (v.meaningfulActivityAt ?? v.createdAt).getTime(),
                    active: v.active,
                    activeAt: v.lastActiveAt.getTime(),
                    archivedAt: v.archivedAt?.getTime() ?? null,
                    encryptionMode: v.encryptionMode === "plain" ? "plain" : "e2ee",
                    ...projectSessionMetadataForRecipient({
                        session: v,
                        recipientAccountId: userId,
                    }),
                    lastViewedSessionSeq: publicationProjection.lastViewedSessionSeq ?? null,
                    pendingPermissionRequestCount: v.pendingPermissionRequestCount,
                    pendingUserActionRequestCount: v.pendingUserActionRequestCount,
                    latestTurnId: v.latestTurnId ?? null,
                    latestTurnStatus: parseStoredSessionLatestTurnStatus(v.latestTurnStatus),
                    latestTurnStatusObservedAt: readLatestTurnStatusObservedAt(v.latestTurnStatusObservedAt),
                    lastRuntimeIssue: parseStoredSessionRuntimeIssue(v.lastRuntimeIssue),
                    rollbackEligibleTurnStarts: readSessionTurnRollbackEligibleStarts(v),
                    ...readSessionTranscriptAuthorityFields(v),
                    pendingCount: v.pendingCount,
                    pendingBlockedCount: v.pendingBlockedCount,
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
        } catch (error) {
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
            }
            throw error;
        }

        return reply.send({ sessions });
    });

    app.get('/v2/sessions/active', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: V2SessionListResponseSchema,
                409: SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_RESPONSE_SCHEMA,
            },
            querystring: V2_ACTIVE_SESSION_LIST_QUERYSTRING_SCHEMA,
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const timing = createV2SessionListServerTiming(request);
        const limit = request.query?.limit || 150;

        const sessions = await timing.measureAsync("query", async () => findV2SessionListRows({
            userId,
            where: {
                active: true,
                archivedAt: null,
                lastActiveAt: { gt: new Date(Date.now() - ACTIVE_SESSION_WINDOW_MS) },
            },
            orderBy: V2_ACTIVE_SESSION_LIST_ORDER_BY,
            take: limit,
        }));

        let payload;
        try {
            payload = timing.measure("page", () => ({
                sessions: mapV2SessionListRows({ rows: sessions, userId }),
            }));
        } catch (error) {
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
            }
            throw error;
        }
        timing.apply(reply);
        return reply.send(payload);
    });

    app.get('/v2/sessions', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: V2SessionListResponseSchema,
                400: z.object({ error: z.literal('Invalid cursor format') }),
                409: SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_RESPONSE_SCHEMA,
            },
            querystring: V2_SESSION_LIST_QUERYSTRING_SCHEMA,
        },
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "sessions.list"),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const timing = createV2SessionListServerTiming(request);
        const {
            cursor,
            attentionCursor,
            limit = 50,
            includeAttention = false,
        } = request.query || {};

        if (attentionCursor) {
            const decodedAttentionCursor = await timing.measureAsync(
                "cursor",
                async () => resolveV2SessionListCursorForVisibleRows({
                    cursor: attentionCursor,
                    userId,
                    cursorRowWhere: { archivedAt: null },
                }),
            );
            if (!decodedAttentionCursor) {
                return reply.code(400).send({ error: "Invalid cursor format" });
            }

            try {
                const attentionPage = await createV2SessionAttentionPage({
                    userId,
                    cursor: decodedAttentionCursor,
                    timing: timing.initialPageTiming(),
                });
                timing.apply(reply);
                return reply.send({
                    sessions: mapV2SessionListRows({ rows: attentionPage.rows, userId }),
                    nextCursor: null,
                    hasNext: false,
                    attentionNextCursor: attentionPage.attentionNextCursor,
                    attentionHasNext: attentionPage.attentionHasNext,
                });
            } catch (error) {
                if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                    return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
                }
                throw error;
            }
        }

        const serverPinnedSessionIds = !cursor
            ? await timing.measureAsync("cursor", async () => fetchSessionOrganizationPinnedSessionIds(userId))
            : [];
        const includeInitialAttention = !cursor && parseInitialIncludeAttention(includeAttention);

        let decodedCursor: { sessionId: string; meaningfulActivityAt: number } | undefined;
        if (cursor) {
            const decoded = await timing.measureAsync("cursor", async () => resolveV2SessionListCursorForVisibleRows({
                cursor,
                userId,
                cursorRowWhere: { archivedAt: null },
            }));
            if (!decoded) {
                return reply.code(400).send({ error: 'Invalid cursor format' });
            }
            decodedCursor = decoded;
        }

        const where: Prisma.SessionWhereInput = {
            archivedAt: null,
            ...createV2SessionListCursorWhere(decodedCursor),
        };

        const sessions = await timing.measureAsync("query", async () => findV2SessionListRows({
            userId,
            where,
            orderBy: V2_SESSION_LIST_ORDER_BY,
            take: limit + 1,
        }));

        let payload;
        try {
            if (!cursor && (serverPinnedSessionIds.length > 0 || includeInitialAttention)) {
                payload = await createV2SessionListInitialPage({
                    userId,
                    pageRows: sessions,
                    limit,
                    pinnedSessionIds: serverPinnedSessionIds,
                    includeAttentionRows: includeInitialAttention,
                    timing: timing.initialPageTiming(),
                });
            } else {
                payload = timing.measure("page", () => createV2SessionListPage({ rows: sessions, userId, limit }));
            }
        } catch (error) {
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
            }
            throw error;
        }

        timing.apply(reply);
        return reply.send(payload);
    });

    app.get('/v2/sessions/archived', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: V2SessionListResponseSchema,
                400: z.object({ error: z.literal('Invalid cursor format') }),
                409: SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_RESPONSE_SCHEMA,
            },
            querystring: V2_PAGED_SESSION_LIST_QUERYSTRING_SCHEMA,
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const timing = createV2SessionListServerTiming(request);
        const { cursor, limit = 50 } = request.query || {};

        let decodedCursor: { sessionId: string; meaningfulActivityAt: number } | undefined;
        if (cursor) {
            const decoded = await timing.measureAsync("cursor", async () => resolveV2SessionListCursorForVisibleRows({
                cursor,
                userId,
                cursorRowWhere: { archivedAt: { not: null } },
            }));
            if (!decoded) {
                return reply.code(400).send({ error: 'Invalid cursor format' });
            }
            decodedCursor = decoded;
        }

        const where: Prisma.SessionWhereInput = {
            archivedAt: { not: null },
            ...createV2SessionListCursorWhere(decodedCursor),
        };

        const sessions = await timing.measureAsync("query", async () => findV2SessionListRows({
            userId,
            where,
            orderBy: V2_SESSION_LIST_ORDER_BY,
            take: limit + 1,
        }));

        let payload;
        try {
            payload = timing.measure("page", () => createV2SessionListPage({ rows: sessions, userId, limit }));
        } catch (error) {
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
            }
            throw error;
        }
        timing.apply(reply);
        return reply.send(payload);
    });

    app.get('/v2/sessions/:sessionId', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.detail"),
        },
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            response: {
                200: V2SessionByIdResponseSchema,
                404: V2SessionByIdNotFoundSchema,
                409: SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_RESPONSE_SCHEMA,
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const session = await findV2SessionByIdRow({ userId, sessionId });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }
        const publicationProjection = applySessionTranscriptPublicationCeilingToProjection({
            seq: session.seq,
            lastViewedSessionSeq: session.lastViewedSessionSeq,
        }, session);
        let metadataProjection;
        try {
            metadataProjection = projectSessionMetadataForRecipient({
                session,
                recipientAccountId: userId,
            });
        } catch (error) {
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
            }
            throw error;
        }

        return reply.send({
            session: {
                id: session.id,
                seq: publicationProjection.seq,
                createdAt: session.createdAt.getTime(),
                updatedAt: session.accountId === userId
                    ? session.updatedAt.getTime()
                    : resolveSessionTranscriptNonOwnerRecencyMs(session, session.updatedAt),
                meaningfulActivityAt: (session.meaningfulActivityAt ?? session.createdAt).getTime(),
                active: session.active,
                activeAt: session.lastActiveAt.getTime(),
                archivedAt: session.archivedAt?.getTime() ?? null,
                encryptionMode: session.encryptionMode === "plain" ? "plain" : "e2ee",
                ...metadataProjection,
                lastViewedSessionSeq: publicationProjection.lastViewedSessionSeq ?? null,
                pendingPermissionRequestCount: session.pendingPermissionRequestCount,
                pendingUserActionRequestCount: session.pendingUserActionRequestCount,
                latestTurnId: session.latestTurnId ?? null,
                latestTurnStatus: parseStoredSessionLatestTurnStatus(session.latestTurnStatus),
                latestTurnStatusObservedAt: readLatestTurnStatusObservedAt(session.latestTurnStatusObservedAt),
                lastRuntimeIssue: parseStoredSessionRuntimeIssue(session.lastRuntimeIssue),
                rollbackEligibleTurnStarts: readSessionTurnRollbackEligibleStarts(session),
                ...readSessionTranscriptAuthorityFields(session),
                pendingCount: session.pendingCount,
                pendingBlockedCount: session.pendingBlockedCount,
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

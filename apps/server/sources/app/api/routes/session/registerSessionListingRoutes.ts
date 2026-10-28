import { z } from "zod";
import type { Prisma } from "@prisma/client";

import {
  V2SessionByIdNotFoundSchema,
  V2SessionByIdResponseSchema,
  V2SessionListResponseSchema,
  CONNECTED_SERVICE_READER_SUPPORT_QUERY_KEY,
  readConnectedServiceReaderSupport,
} from "@happier-dev/protocol";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { PROFILE_SELECT, toShareUserProfile } from "@/app/share/types";
import { db } from "@/storage/db";
import { fetchSessionOrganizationPinnedSessionIds } from "@/app/session/organization/organizationQueries";
import { type Fastify } from "../../types";
import {
    encodeSessionDataEncryptionKey,
    mapStoredSessionRuntimeActivityProjection,
    omitSessionListProjectionFallbackColumns,
    parseStoredSessionLatestTurnStatus,
    parseStoredSessionRuntimeIssue,
    projectSessionRowsForReader,
} from "./v2SessionListRows";
import { mapPendingActivationAuthorization } from "@/app/session/pending/pendingActivationAuthorization";
import {
    createV2ActiveSessionListRowsWhere,
    createV2SessionListCursorWhere,
    createV2SessionListPage,
    createV2SessionListVisibilityArmsReader,
    findV2SessionListRowById,
    findV2SessionListRows,
    mapV2SessionListRows,
    resolveV2SessionListCursorForVisibleRows,
    runWithSessionListProjectionFallback,
    V2_ACTIVE_SESSION_LIST_ORDER_BY,
    V2_ACTIVE_SESSION_LIST_ROW_LIMIT,
    V2_SESSION_LIST_ORDER_BY,
} from "./v2SessionListPage";
import { createV2SessionListInitialPage } from "./v2SessionListInitialPage";
import { createV2SessionListServerTiming } from "./v2SessionListServerTiming";
import {
    createSessionRollbackEligibleTurnsSelect,
    readSessionTurnRollbackEligibleStarts,
} from "@/app/session/turns/sessionRollbackEligibilityProjection";

const V2_ACTIVE_SESSION_LIST_QUERYSTRING_SCHEMA = z.object({
    [CONNECTED_SERVICE_READER_SUPPORT_QUERY_KEY]: z.unknown().optional(),
    limit: z.coerce.number().int().min(1)
        .max(V2_ACTIVE_SESSION_LIST_ROW_LIMIT)
        .default(V2_ACTIVE_SESSION_LIST_ROW_LIMIT),
}).optional();

const OPTIONAL_BOOLEAN_QUERY_PARAM_SCHEMA = z.preprocess((value) => {
    if (value === true || value === "true" || value === "1") return true;
    if (value === false || value === "false" || value === "0") return false;
    return value;
}, z.boolean()).optional();

const OPTIONAL_SESSION_IDS_QUERY_PARAM_SCHEMA = z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return value;
    }
}, z.array(z.string().min(1))).optional();

const V2_PAGED_SESSION_LIST_QUERYSTRING_SCHEMA = z.object({
    [CONNECTED_SERVICE_READER_SUPPORT_QUERY_KEY]: z.unknown().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    includeAttention: OPTIONAL_BOOLEAN_QUERY_PARAM_SCHEMA,
    /**
     * Merge the active-session family into this response instead of leaving the client to fetch it
     * from `GET /v2/sessions/active`. Additive and optional: a server that predates it simply drops
     * the key, which is why a client only stops issuing the separate call once the server advertises
     * the capability.
     */
    includeActive: OPTIONAL_BOOLEAN_QUERY_PARAM_SCHEMA,
    requiredSessionIds: OPTIONAL_SESSION_IDS_QUERY_PARAM_SCHEMA,
    requiredOnly: OPTIONAL_BOOLEAN_QUERY_PARAM_SCHEMA,
}).optional();

function parseInitialIncludeFlag(value: unknown): boolean {
    return value === true || value === "true" || value === "1";
}

function readLatestTurnStatusObservedAt(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") return Number(value);
    return null;
}

const V1_SESSION_LIST_ROW_SELECT = {
    id: true,
    seq: true,
    createdAt: true,
    updatedAt: true,
    meaningfulActivityAt: true,
    archivedAt: true,
    encryptionMode: true,
    metadata: true,
    metadataVersion: true,
    agentState: true,
    agentStateVersion: true,
    lastViewedSessionSeq: true,
    unreadSince: true,
    pendingPermissionRequestCount: true,
    pendingUserActionRequestCount: true,
    latestTurnId: true,
    latestTurnStatus: true,
    latestTurnStatusObservedAt: true,
    lastRuntimeIssue: true,
    runtimeActivityState: true,
    runtimeActivityRevision: true,
    runtimeActivityActiveCount: true,
    runtimeActivityObservedAt: true,
    dataEncryptionKey: true,
    pendingCount: true,
    pendingBlockedCount: true,
    pendingVersion: true,
    pendingActivationRequestId: true,
    pendingActivationRequestedAt: true,
    pendingActivationStatus: true,
    pendingActivationFailureCode: true,
    turns: createSessionRollbackEligibleTurnsSelect(),
    active: true,
    lastActiveAt: true,
} as const satisfies Prisma.SessionSelect;

function createV1SessionShareSelect(sessionSelect: Prisma.SessionSelect): Prisma.SessionShareSelect {
    return {
        accessLevel: true,
        canApprovePermissions: true,
        encryptedDataKey: true,
        sharedByUserId: true,
        sharedByUser: { select: PROFILE_SELECT },
        session: { select: sessionSelect },
    };
}

const V1_SESSION_LIST_ROW_LEGACY_SELECT = omitSessionListProjectionFallbackColumns(V1_SESSION_LIST_ROW_SELECT);

/**
 * The legacy list shares the v2 projection-fallback seam: a binary running ahead of
 * `prisma migrate deploy` asks the old schema for a column it does not have, and the old-schema-safe
 * projection answers instead of the request failing outright.
 */
async function findV1SessionListRows(userId: string) {
    return await runWithSessionListProjectionFallback(
        () => findV1SessionListRowsWithSelect({
            userId,
            sessionSelect: V1_SESSION_LIST_ROW_SELECT,
            shareSessionSelect: V1_SESSION_LIST_ROW_SELECT,
        }),
        () => findV1SessionListRowsWithSelect({
            userId,
            sessionSelect: V1_SESSION_LIST_ROW_LEGACY_SELECT,
            shareSessionSelect: V1_SESSION_LIST_ROW_LEGACY_SELECT,
        }),
    );
}

async function findV1SessionListRowsWithSelect(params: Readonly<{
    userId: string;
    sessionSelect: Prisma.SessionSelect;
    shareSessionSelect: Prisma.SessionSelect;
}>) {
    const { userId, sessionSelect, shareSessionSelect } = params;
    return await Promise.all([
        db.session.findMany({
            where: { accountId: userId, archivedAt: null },
            orderBy: { updatedAt: 'desc' },
            take: 150,
            select: sessionSelect,
        }),
        db.sessionShare.findMany({
            where: { sharedWithUserId: userId, session: { archivedAt: null } },
            orderBy: { session: { updatedAt: 'desc' } },
            take: 150,
            select: createV1SessionShareSelect(shareSessionSelect),
        }),
    ]);
}

export function registerSessionListingRoutes(app: Fastify) {
    app.get('/v1/sessions', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({ [CONNECTED_SERVICE_READER_SUPPORT_QUERY_KEY]: z.unknown().optional() }).optional(),
        },
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "sessions.list"),
        },
    }, async (request, reply) => {
        const userId = request.userId;

        const [ownedSessions, shares] = await findV1SessionListRows(userId);

        const sessions = [
            ...ownedSessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                meaningfulActivityAt: (v.meaningfulActivityAt ?? v.createdAt).getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                archivedAt: v.archivedAt?.getTime() ?? null,
                encryptionMode: v.encryptionMode === "plain" ? "plain" : "e2ee",
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                lastViewedSessionSeq: v.lastViewedSessionSeq ?? null,
                unreadSince: v.unreadSince?.getTime() ?? null,
                pendingPermissionRequestCount: v.pendingPermissionRequestCount,
                pendingUserActionRequestCount: v.pendingUserActionRequestCount,
                latestTurnId: v.latestTurnId ?? null,
                latestTurnStatus: parseStoredSessionLatestTurnStatus(v.latestTurnStatus),
                latestTurnStatusObservedAt: readLatestTurnStatusObservedAt(v.latestTurnStatusObservedAt),
                lastRuntimeIssue: parseStoredSessionRuntimeIssue(v.lastRuntimeIssue),
                ...mapStoredSessionRuntimeActivityProjection(v),
                pendingCount: v.pendingCount,
                pendingBlockedCount: v.pendingBlockedCount,
                pendingVersion: v.pendingVersion,
                pendingActivationAuthorization: mapPendingActivationAuthorization(v),
                rollbackEligibleTurnStarts: readSessionTurnRollbackEligibleStarts(v),
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
                    meaningfulActivityAt: (v.meaningfulActivityAt ?? v.createdAt).getTime(),
                    active: v.active,
                    activeAt: v.lastActiveAt.getTime(),
                    archivedAt: v.archivedAt?.getTime() ?? null,
                    encryptionMode: v.encryptionMode === "plain" ? "plain" : "e2ee",
                    metadata: v.metadata,
                    metadataVersion: v.metadataVersion,
                    agentState: v.agentState,
                    agentStateVersion: v.agentStateVersion,
                    lastViewedSessionSeq: v.lastViewedSessionSeq ?? null,
                    unreadSince: v.unreadSince?.getTime() ?? null,
                    pendingPermissionRequestCount: v.pendingPermissionRequestCount,
                    pendingUserActionRequestCount: v.pendingUserActionRequestCount,
                    latestTurnId: v.latestTurnId ?? null,
                    latestTurnStatus: parseStoredSessionLatestTurnStatus(v.latestTurnStatus),
                    latestTurnStatusObservedAt: readLatestTurnStatusObservedAt(v.latestTurnStatusObservedAt),
                    lastRuntimeIssue: parseStoredSessionRuntimeIssue(v.lastRuntimeIssue),
                    ...mapStoredSessionRuntimeActivityProjection(v),
                    pendingCount: v.pendingCount,
                    pendingBlockedCount: v.pendingBlockedCount,
                    pendingVersion: v.pendingVersion,
                    pendingActivationAuthorization: mapPendingActivationAuthorization(v),
                    rollbackEligibleTurnStarts: readSessionTurnRollbackEligibleStarts(v),
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

        return reply.send({ sessions: projectSessionRowsForReader(sessions,
            readConnectedServiceReaderSupport(request.query?.[CONNECTED_SERVICE_READER_SUPPORT_QUERY_KEY])) });
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
        const limit = request.query?.limit || V2_ACTIVE_SESSION_LIST_ROW_LIMIT;
        const timing = createV2SessionListServerTiming(request);

        const sessions = await timing.measureAsync("query", async () => findV2SessionListRows({
            userId,
            where: createV2ActiveSessionListRowsWhere(),
            orderBy: V2_ACTIVE_SESSION_LIST_ORDER_BY,
            take: limit,
        }));

        const payload = timing.measure("page", () => ({
            sessions: projectSessionRowsForReader(mapV2SessionListRows({ rows: sessions, userId }),
                readConnectedServiceReaderSupport(request.query?.[CONNECTED_SERVICE_READER_SUPPORT_QUERY_KEY])),
        }));
        timing.apply(reply);
        return reply.send(payload);
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
        const timing = createV2SessionListServerTiming(request);
        const {
            cursor,
            limit = 50,
            includeAttention = false,
            includeActive = false,
            requiredSessionIds = [],
            requiredOnly = false,
        } = request.query || {};
        const onlyRequiredRows = parseInitialIncludeFlag(requiredOnly);
        const initialPinnedSessionIds = !cursor && !onlyRequiredRows
            ? await timing.measureAsync("cursor", async () => fetchSessionOrganizationPinnedSessionIds(userId))
            : [];
        const includeInitialAttention = !cursor && !onlyRequiredRows && parseInitialIncludeFlag(includeAttention);
        const includeInitialActive = !cursor && !onlyRequiredRows && parseInitialIncludeFlag(includeActive);

        let decodedCursor: { sessionId: string; meaningfulActivityAt: number } | undefined;
        if (cursor && !onlyRequiredRows) {
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

        const where = {
            archivedAt: null,
            ...createV2SessionListCursorWhere(decodedCursor),
        };

        // One reader for the whole request: the viewer's shared-session ids are the same for the page
        // read and for every family read the initial page issues, and resolving them per read cost a
        // `SessionShare` statement each.
        const visibilityArms = createV2SessionListVisibilityArmsReader(userId);
        const sessions = onlyRequiredRows ? [] : await timing.measureAsync("query", async () => findV2SessionListRows({
            userId,
            where,
            orderBy: V2_SESSION_LIST_ORDER_BY,
            take: limit + 1,
            visibilityArms,
        }));

        let payload;
        if (onlyRequiredRows || (!cursor && (initialPinnedSessionIds.length > 0 || includeInitialAttention || includeInitialActive || requiredSessionIds.length > 0))) {
            payload = await createV2SessionListInitialPage({
                userId,
                pageRows: sessions,
                limit,
                pinnedSessionIds: initialPinnedSessionIds,
                includeAttentionRows: includeInitialAttention,
                includeActiveRows: includeInitialActive,
                requiredSessionIds,
                visibilityArms,
                timing: timing.initialPageTiming(),
            });
        } else {
            payload = timing.measure("page", () => createV2SessionListPage({ rows: sessions, userId, limit,
                supportedConnectedServiceIds: readConnectedServiceReaderSupport(request.query?.[CONNECTED_SERVICE_READER_SUPPORT_QUERY_KEY]) }));
        }
        timing.apply(reply);
        return reply.send({ ...payload, sessions: projectSessionRowsForReader(payload.sessions,
            readConnectedServiceReaderSupport(request.query?.[CONNECTED_SERVICE_READER_SUPPORT_QUERY_KEY])) });
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

        const where = {
            archivedAt: { not: null },
            ...createV2SessionListCursorWhere(decodedCursor),
        };

        const sessions = await timing.measureAsync("query", async () => findV2SessionListRows({
            userId,
            where,
            orderBy: V2_SESSION_LIST_ORDER_BY,
            take: limit + 1,
        }));

        const payload = timing.measure("page", () => createV2SessionListPage({ rows: sessions, userId, limit,
            supportedConnectedServiceIds: readConnectedServiceReaderSupport(request.query?.[CONNECTED_SERVICE_READER_SUPPORT_QUERY_KEY]) }));
        timing.apply(reply);
        return reply.send({ ...payload, sessions: projectSessionRowsForReader(payload.sessions,
            readConnectedServiceReaderSupport(request.query?.[CONNECTED_SERVICE_READER_SUPPORT_QUERY_KEY])) });
    });

    app.get('/v2/sessions/:sessionId', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.detail"),
        },
        schema: {
            querystring: z.object({ [CONNECTED_SERVICE_READER_SUPPORT_QUERY_KEY]: z.unknown().optional() }).optional(),
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

        const session = await findV2SessionListRowById({ userId, sessionId });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        return reply.send({
            session: projectSessionRowsForReader(mapV2SessionListRows({ rows: [session], userId }),
                readConnectedServiceReaderSupport(request.query?.[CONNECTED_SERVICE_READER_SUPPORT_QUERY_KEY]))[0],
        });
    });
}

import type { Prisma } from "@prisma/client";
import { z } from "zod";

import {
  SESSION_METADATA_LAYOUT_VERSION_V1,
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
    collectSessionTranscriptVisibleRowsBeforeTake,
    createSessionTranscriptPublicationLiveFactsWhere,
    createSessionTranscriptPublicationRecencyQueryBranches,
    createSessionTranscriptShareableRecencyQueryBranches,
    filterSessionTranscriptPublicationSequenceFacts,
    isSessionTranscriptShareable,
    projectSessionTranscriptPublicationPreview,
    resolveSessionTranscriptNonOwnerRecencyMs,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import {
    createSessionMetadataPrivacyUpgradeRequiredResponse,
    isSessionMetadataPrivacyUpgradeRequiredError,
    projectSessionMetadataForRecipient,
    readSessionMetadataOwnerAccountMode,
    readSessionMetadataOwnerAccountModes,
    requiresSessionMetadataOwnerAccountMode,
    type SessionMetadataOwnerAccountMode,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import {
    enforceCurrentAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";

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

async function readSessionOwnerAccountModesForRows(
    rows: readonly Readonly<{
        accountId: string;
        metadataLayoutVersion?: number | null;
    }>[],
): Promise<ReadonlyMap<string, SessionMetadataOwnerAccountMode>> {
    return await readSessionMetadataOwnerAccountModes(
        db,
        rows
            .filter((session) =>
                requiresSessionMetadataOwnerAccountMode({
                    session,
                }))
            .map((session) => session.accountId),
    );
}

function parseInitialIncludeAttention(value: unknown): boolean {
    return value === true || value === "true" || value === "1";
}

function readLatestTurnStatusObservedAt(value: bigint | number | null | undefined): number | null {
    if (typeof value === "bigint") return Number(value);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function projectSessionListingPublicationPreview<T extends Readonly<{
    seq: number;
    lastViewedSessionSeq?: number | null;
    createdAt: Date;
    updatedAt: Date;
    meaningfulActivityAt?: Date | null;
    lastActiveAt: Date;
}>>(session: T) {
    return projectSessionTranscriptPublicationPreview({
        seq: session.seq,
        lastViewedSessionSeq: session.lastViewedSessionSeq,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        meaningfulActivityAt: session.meaningfulActivityAt,
        lastActiveAt: session.lastActiveAt,
    }, session);
}

const SESSION_ROLLBACK_ELIGIBLE_TURNS_SELECT = createSessionRollbackEligibleTurnsSelect();

const V1_SESSION_ROW_SELECT = {
    id: true,
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

function createV1SessionShareSelect(): Prisma.SessionShareSelect {
    return {
        accessLevel: true,
        canApprovePermissions: true,
        encryptedDataKey: true,
        sharedByUserId: true,
        sharedByUser: { select: PROFILE_SELECT },
        session: {
            select: V1_SESSION_ROW_SELECT,
        },
    };
}

async function findV1SessionListRows(userId: string) {
    const [ownedBranches, shareBranches] = await Promise.all([
            Promise.all(createSessionTranscriptPublicationRecencyQueryBranches().map((branch) =>
                collectSessionTranscriptVisibleRowsBeforeTake({
                    take: 150,
                    fetchPage: async (page) =>
                        await db.session.findMany({
                            where: {
                                accountId: userId,
                                archivedAt: null,
                                AND: [branch.where],
                            },
                            orderBy: [...branch.orderBy],
                            ...(page.skip === undefined ? {} : { skip: page.skip }),
                            ...(page.take === undefined ? {} : { take: page.take }),
                            select: V1_SESSION_ROW_SELECT,
                        }),
                    isOwner: () => true,
                    readPublication: (session) => session,
                }),
            )),
            Promise.all(createSessionTranscriptShareableRecencyQueryBranches().map((branch) =>
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
                            select: createV1SessionShareSelect(),
                        }),
                    isOwner: () => false,
                    readPublication: (share) => share.session,
                }),
            )),
        ]);
        const ownedBySessionId = new Map(
            ownedBranches
                .flat()
                .map((session) => [session.id, session] as const),
        );
        const sharesBySessionId = new Map(
            shareBranches
                .flat()
                .map((share) => [share.session.id, share] as const),
        );
    return [[...ownedBySessionId.values()], [...sharesBySessionId.values()]] as const;
}

const V2_SESSION_BY_ID_SELECT = {
    id: true,
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
        const emittedRows = [
            ...ownedSessions.map((session) => ({
                recipient: "owner" as const,
                session,
                updatedAt: projectSessionListingPublicationPreview(session).updatedAt,
            })),
            ...shares
                .filter((share) =>
                    isSessionTranscriptShareable(share.session))
                .map((share) => ({
                    recipient: "shared" as const,
                    session: share.session,
                    share,
                    updatedAt: resolveSessionTranscriptNonOwnerRecencyMs(
                        share.session,
                        share.session.updatedAt,
                    ),
                })),
        ]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 150);
        if (
            emittedRows.some((row) =>
                row.session.metadataLayoutVersion
                    === SESSION_METADATA_LAYOUT_VERSION_V1)
            && !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                request,
                reply,
            )
        ) {
            return;
        }

        let sessions;
        try {
            const ownerAccountModes =
                await readSessionOwnerAccountModesForRows(
                    emittedRows.map((row) => row.session),
                );
            sessions = emittedRows.map((row) => {
                const v = row.session;
                if (row.recipient === "owner") {
                    const publicationProjection = projectSessionListingPublicationPreview(v);
                    const hasLiveFacts = publicationProjection.hasLiveFacts;
                    return {
                        id: v.id,
                        seq: publicationProjection.seq,
                        createdAt: v.createdAt.getTime(),
                        updatedAt: publicationProjection.updatedAt,
                        meaningfulActivityAt: publicationProjection.meaningfulActivityAt,
                        active: hasLiveFacts && v.active,
                        activeAt: publicationProjection.activeAt,
                        archivedAt: v.archivedAt?.getTime() ?? null,
                        encryptionMode: v.encryptionMode === "plain" ? "plain" : "e2ee",
                        ...projectSessionMetadataForRecipient({
                            session: v,
                            recipient:
                                requiresSessionMetadataOwnerAccountMode({
                                    session: v,
                                }) && ownerAccountModes.has(v.accountId)
                                    ? {
                                        type: "owner",
                                        accountId: userId,
                                        accountMode: ownerAccountModes.get(v.accountId)!,
                                      }
                                    : {
                                        type: "legacy_owner",
                                        accountId: userId,
                                      },
                        }),
                        lastViewedSessionSeq: publicationProjection.lastViewedSessionSeq ?? null,
                        pendingPermissionRequestCount: hasLiveFacts ? v.pendingPermissionRequestCount : 0,
                        pendingUserActionRequestCount: hasLiveFacts ? v.pendingUserActionRequestCount : 0,
                        latestTurnId: hasLiveFacts ? v.latestTurnId ?? null : null,
                        latestTurnStatus: hasLiveFacts ? parseStoredSessionLatestTurnStatus(v.latestTurnStatus) : null,
                        latestTurnStatusObservedAt: hasLiveFacts
                            ? readLatestTurnStatusObservedAt(v.latestTurnStatusObservedAt)
                            : null,
                        lastRuntimeIssue: hasLiveFacts ? parseStoredSessionRuntimeIssue(v.lastRuntimeIssue) : null,
                        rollbackEligibleTurnStarts: filterSessionTranscriptPublicationSequenceFacts(
                            readSessionTurnRollbackEligibleStarts(v),
                            v,
                        ),
                        ...readSessionTranscriptAuthorityFields(v),
                        acceptedThroughServerSeq: publicationProjection.acceptedThroughServerSeq,
                        pendingCount: hasLiveFacts ? v.pendingCount : 0,
                        pendingBlockedCount: hasLiveFacts ? v.pendingBlockedCount : 0,
                        pendingVersion: hasLiveFacts ? v.pendingVersion : 0,
                        dataEncryptionKey: encodeSessionDataEncryptionKey(v.dataEncryptionKey),
                        lastMessage: null,
                    };
                }

                const share = row.share;
                const publicationProjection = projectSessionListingPublicationPreview(v);
                const hasLiveFacts = publicationProjection.hasLiveFacts;
                return {
                    id: v.id,
                    seq: publicationProjection.seq,
                    createdAt: v.createdAt.getTime(),
                    updatedAt: publicationProjection.updatedAt,
                    meaningfulActivityAt: publicationProjection.meaningfulActivityAt,
                    active: hasLiveFacts && v.active,
                    activeAt: publicationProjection.activeAt,
                    archivedAt: v.archivedAt?.getTime() ?? null,
                    encryptionMode: v.encryptionMode === "plain" ? "plain" : "e2ee",
                    ...projectSessionMetadataForRecipient({
                        session: v,
                        recipient: {
                            type: "shared",
                            accountId: userId,
                            ownerAccountMode: ownerAccountModes.get(v.accountId),
                        },
                    }),
                    lastViewedSessionSeq: publicationProjection.lastViewedSessionSeq ?? null,
                    pendingPermissionRequestCount: hasLiveFacts ? v.pendingPermissionRequestCount : 0,
                    pendingUserActionRequestCount: hasLiveFacts ? v.pendingUserActionRequestCount : 0,
                    latestTurnId: hasLiveFacts ? v.latestTurnId ?? null : null,
                    latestTurnStatus: hasLiveFacts ? parseStoredSessionLatestTurnStatus(v.latestTurnStatus) : null,
                    latestTurnStatusObservedAt: hasLiveFacts
                        ? readLatestTurnStatusObservedAt(v.latestTurnStatusObservedAt)
                        : null,
                    lastRuntimeIssue: hasLiveFacts ? parseStoredSessionRuntimeIssue(v.lastRuntimeIssue) : null,
                    rollbackEligibleTurnStarts: filterSessionTranscriptPublicationSequenceFacts(
                        readSessionTurnRollbackEligibleStarts(v),
                        v,
                    ),
                    ...readSessionTranscriptAuthorityFields(v),
                    acceptedThroughServerSeq: publicationProjection.acceptedThroughServerSeq,
                    pendingCount: hasLiveFacts ? v.pendingCount : 0,
                    pendingBlockedCount: hasLiveFacts ? v.pendingBlockedCount : 0,
                    pendingVersion: hasLiveFacts ? v.pendingVersion : 0,
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
            });
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
                426: z.unknown(),
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
                ...createSessionTranscriptPublicationLiveFactsWhere(),
                active: true,
                archivedAt: null,
                lastActiveAt: { gt: new Date(Date.now() - ACTIVE_SESSION_WINDOW_MS) },
            },
            orderBy: V2_ACTIVE_SESSION_LIST_ORDER_BY,
            take: limit,
        }));
        if (
            sessions.some((session) =>
                session.metadataLayoutVersion
                    === SESSION_METADATA_LAYOUT_VERSION_V1)
            && !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                request,
                reply,
            )
        ) {
            return;
        }

        let payload;
        try {
            const ownerAccountModes =
                await readSessionOwnerAccountModesForRows(
                    sessions,
                );
            payload = timing.measure("page", () => ({
                sessions: mapV2SessionListRows({
                    rows: sessions,
                    userId,
                    ownerAccountModes,
                }),
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
                426: z.unknown(),
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
                if (
                    attentionPage.rows.some((session) =>
                        session.metadataLayoutVersion
                            === SESSION_METADATA_LAYOUT_VERSION_V1)
                    && !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                        request,
                        reply,
                    )
                ) {
                    return;
                }
                const ownerAccountModes =
                    await readSessionOwnerAccountModesForRows(
                        attentionPage.rows,
                    );
                timing.apply(reply);
                return reply.send({
                    sessions: mapV2SessionListRows({
                        rows: attentionPage.rows,
                        userId,
                        ownerAccountModes,
                    }),
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
                    admitFinalRows: async (rows) =>
                        !rows.some((session) =>
                            session.metadataLayoutVersion
                                === SESSION_METADATA_LAYOUT_VERSION_V1)
                        || await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                            request,
                            reply,
                        ),
                    readOwnerAccountModes: async (accountIds) =>
                        await readSessionMetadataOwnerAccountModes(
                            db,
                            accountIds,
                        ),
                    pageRows: sessions,
                    limit,
                    pinnedSessionIds: serverPinnedSessionIds,
                    includeAttentionRows: includeInitialAttention,
                    timing: timing.initialPageTiming(),
                });
                if (!payload) {
                    return;
                }
            } else {
                const emittedRows = sessions.slice(0, limit);
                if (
                    emittedRows.some((session) =>
                        session.metadataLayoutVersion
                            === SESSION_METADATA_LAYOUT_VERSION_V1)
                    && !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                        request,
                        reply,
                    )
                ) {
                    return;
                }
                const ownerAccountModes =
                    await readSessionOwnerAccountModesForRows(
                        emittedRows,
                    );
                payload = timing.measure("page", () => createV2SessionListPage({
                    rows: sessions,
                    userId,
                    ownerAccountModes,
                    limit,
                }));
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
                426: z.unknown(),
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
        const emittedRows = sessions.slice(0, limit);
        if (
            emittedRows.some((session) =>
                session.metadataLayoutVersion
                    === SESSION_METADATA_LAYOUT_VERSION_V1)
            && !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                request,
                reply,
            )
        ) {
            return;
        }

        let payload;
        try {
            const ownerAccountModes =
                await readSessionOwnerAccountModesForRows(
                    emittedRows,
                );
            payload = timing.measure("page", () => createV2SessionListPage({
                rows: sessions,
                userId,
                ownerAccountModes,
                limit,
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
                426: z.unknown(),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const session = await findV2SessionByIdRow({ userId, sessionId });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }
        if (
            session.metadataLayoutVersion
                === SESSION_METADATA_LAYOUT_VERSION_V1
            && !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                request,
                reply,
            )
        ) {
            return;
        }
        const publicationProjection = projectSessionListingPublicationPreview(session);
        const hasLiveFacts = publicationProjection.hasLiveFacts;
        let metadataProjection;
        try {
            const ownerAccountMode =
                requiresSessionMetadataOwnerAccountMode({
                    session,
                })
                    ? await readSessionMetadataOwnerAccountMode(
                        db,
                        session.accountId,
                    )
                    : undefined;
            const recipient = session.accountId !== userId
                ? {
                    type: "shared" as const,
                    accountId: userId,
                    ownerAccountMode,
                  }
                : requiresSessionMetadataOwnerAccountMode({
                    session,
                  })
                    ? {
                        type: "owner" as const,
                        accountId: userId,
                        accountMode: ownerAccountMode!,
                      }
                    : {
                        type: "legacy_owner" as const,
                        accountId: userId,
                      };
            metadataProjection = projectSessionMetadataForRecipient({
                session,
                recipient,
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
                updatedAt: publicationProjection.updatedAt,
                meaningfulActivityAt: publicationProjection.meaningfulActivityAt,
                active: hasLiveFacts && session.active,
                activeAt: publicationProjection.activeAt,
                archivedAt: session.archivedAt?.getTime() ?? null,
                encryptionMode: session.encryptionMode === "plain" ? "plain" : "e2ee",
                ...metadataProjection,
                lastViewedSessionSeq: publicationProjection.lastViewedSessionSeq ?? null,
                pendingPermissionRequestCount: hasLiveFacts ? session.pendingPermissionRequestCount : 0,
                pendingUserActionRequestCount: hasLiveFacts ? session.pendingUserActionRequestCount : 0,
                latestTurnId: hasLiveFacts ? session.latestTurnId ?? null : null,
                latestTurnStatus: hasLiveFacts
                    ? parseStoredSessionLatestTurnStatus(session.latestTurnStatus)
                    : null,
                latestTurnStatusObservedAt: hasLiveFacts
                    ? readLatestTurnStatusObservedAt(session.latestTurnStatusObservedAt)
                    : null,
                lastRuntimeIssue: hasLiveFacts ? parseStoredSessionRuntimeIssue(session.lastRuntimeIssue) : null,
                rollbackEligibleTurnStarts: filterSessionTranscriptPublicationSequenceFacts(
                    readSessionTurnRollbackEligibleStarts(session),
                    session,
                ),
                ...readSessionTranscriptAuthorityFields(session),
                acceptedThroughServerSeq: publicationProjection.acceptedThroughServerSeq,
                pendingCount: hasLiveFacts ? session.pendingCount : 0,
                pendingBlockedCount: hasLiveFacts ? session.pendingBlockedCount : 0,
                pendingVersion: hasLiveFacts ? session.pendingVersion : 0,
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

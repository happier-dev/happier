import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { buildMessageUpdatedUpdate, buildNewMessageUpdate, eventRouter } from "@/app/events/eventRouter";
import { catchupFollowupFetchesCounter, catchupFollowupReturnedCounter } from "@/app/monitoring/metrics/index";
import {
    SessionMessageDeliveryResolutionV1Schema,
    SessionMessageRoleSchema,
    MessageActionDurableResolutionV1Schema,
    MessageActionReferenceV1Schema,
    ExternalShareableActorV1Schema,
    EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1,
    EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1,
    EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SNAPSHOT_TURNS_V1,
    ExternalShareableTranscriptSnapshotV1Schema,
    SessionStoredMessageContentSchema,
    SessionTranscriptObservationProvenanceV1Schema,
    deriveExternalShareableActorFromAdmissionReceiptV1,
    isRecoveredHistoryTranscriptObservationProvenance,
    parseSessionMessageDeliveryResolutionV1,
    type SessionMessageRole,
} from "@happier-dev/protocol";
import { isSessionAgentTransitionDividerLocalId } from "@happier-dev/protocol";
import { parseSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import {
    importHistoricalSessionTranscript,
    type HistoricalSessionTranscriptImportItem,
} from "@/app/session/importHistoricalSessionTranscript";
import { createSessionMessage } from "@/app/session/sessionWriteService";
import { parseSessionMessageSidechainId } from "@/app/session/parseSessionMessageSidechainId";
import {
    issueSessionMessageActionReference,
    resolveSessionMessageActionLookup,
} from "@/app/session/sessionMessageActionLookup";
import {
    buildSessionMessagePublicationWhere,
    buildShareableSessionMessagePublicationWhere,
    isExternalShareableSessionTurnVisible,
    isSessionTranscriptPublicationBlocked,
    loadSessionTranscriptPublication,
    resolveExternalShareableTranscriptBlockedFromSeq,
    resolveExternalShareableTranscriptTurnSettlementBlockedFromSeq,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import { parseStoredSessionTurns } from "@/app/session/turns/parseSessionTurnState";
import { isSessionTurnTranscriptAnchorProjectionCurrent } from "@/app/session/turns/sessionTurnTranscriptAnchorProjection";
import { isSessionTurnTranscriptAnchorProjectionProtocolActive } from "@/app/session/turns/sessionTurnTranscriptAnchorProjectionProtocolContract";
import {
    resolveSessionTurnProjectionSeqs,
    type SessionTurnProjectionSeqs,
} from "./resolveSessionTurnProjectionSeqs";
import { publishSessionReadyProjectionUpdate } from "@/app/session/ready/publishSessionReadyProjectionUpdate";
import { buildCurrentSessionParticipantWhere, checkSessionAccess } from "@/app/share/accessControl";
import { db } from "@/storage/db";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { inTx } from "@/storage/inTx";
import { type Fastify } from "../../types";

type SessionStoredMessageContent = z.infer<typeof SessionStoredMessageContentSchema>;

const SessionTranscriptStoredContentUnavailableResponseSchema = z.object({
    error: z.literal("session_transcript_stored_content_unavailable"),
}).strict();

const SessionTranscriptMessagePageResponseSchema = z.object({
    messages: z.array(z.object({
        id: z.string(),
        seq: z.number().int().min(0),
        content: SessionStoredMessageContentSchema,
        localId: z.string().nullable(),
        sidechainId: z.string().min(1).optional(),
        messageRole: SessionMessageRoleSchema.optional(),
        deliveryResolution: SessionMessageDeliveryResolutionV1Schema.optional(),
        createdAt: z.number().int().min(0),
        updatedAt: z.number().int().min(0),
        sourceCreatedAt: z.number().int().min(0).optional(),
        sourceUpdatedAt: z.number().int().min(0).optional(),
        transcriptObservationProvenance: SessionTranscriptObservationProvenanceV1Schema.optional(),
        externalShareableActor: ExternalShareableActorV1Schema.optional(),
        messageActionReference: MessageActionReferenceV1Schema.optional(),
    }).strict()),
    hasMore: z.boolean(),
    nextBeforeSeq: z.number().int().min(0).nullable(),
    nextAfterSeq: z.number().int().min(0).nullable(),
    publicationBlocked: z.boolean().optional(),
    externalShareableSnapshot: ExternalShareableTranscriptSnapshotV1Schema.optional(),
}).strict();

function deriveExternalShareableActor(params: Readonly<{
    inputAdmissionReceipt: unknown;
    messageRole: unknown;
    transcriptObservationProvenance: unknown;
}>) {
    const admittedActor = deriveExternalShareableActorFromAdmissionReceiptV1(
        params.inputAdmissionReceipt,
    );
    if (admittedActor) return admittedActor;
    if (parseSessionMessageRole(params.messageRole) !== "user") return null;
    return isRecoveredHistoryTranscriptObservationProvenance(
        params.transcriptObservationProvenance,
    ) ? "machine" : null;
}

type ExternalShareableReferencedUserSourceRow = Readonly<{
    id: unknown;
    seq: unknown;
    localId: unknown;
    messageRole: unknown;
    sidechainId: unknown;
    content: unknown;
    createdAt: unknown;
    updatedAt: unknown;
    inputAdmissionReceipt: unknown;
    transcriptObservationProvenance: unknown;
}>;

function readExternalShareableSequence(value: unknown): number | null {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
}

/**
 * The server snapshot is the disclosure boundary for out-of-page consumed
 * inputs. Keep the database-only receipt behind this projection even though
 * it is needed briefly to derive the coarse actor.
 */
function projectExternalShareableReferencedUserRow(
    row: ExternalShareableReferencedUserSourceRow,
) {
    const seq = readExternalShareableSequence(row.seq);
    const content = SessionStoredMessageContentSchema.safeParse(row.content);
    if (
        typeof row.id !== "string"
        || !row.id
        || seq === null
        || typeof row.localId !== "string"
        || !row.localId
        || parseSessionMessageRole(row.messageRole) !== "user"
        || row.sidechainId !== null
        || !content.success
        || !(row.createdAt instanceof Date)
        || !(row.updatedAt instanceof Date)
    ) {
        return null;
    }
    const externalShareableActor = deriveExternalShareableActor({
        inputAdmissionReceipt: row.inputAdmissionReceipt,
        messageRole: row.messageRole,
        transcriptObservationProvenance: row.transcriptObservationProvenance,
    });
    return {
        id: row.id,
        seq,
        localId: row.localId,
        messageRole: "user" as const,
        content: content.data,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
        ...(externalShareableActor ? { externalShareableActor } : {}),
    };
}

function parseSessionMessageRoleCsv(value: unknown): { ok: true; roles: string[] } | { ok: false } {
    if (typeof value !== "string") return { ok: false };
    const roles = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    return roles.length > 0 ? { ok: true, roles } : { ok: false };
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
        const parsedCsv = parseSessionMessageRoleCsv(query.roles);
        if (!parsedCsv.ok) return { ok: false };
        for (const rawRole of parsedCsv.roles) {
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
    app.post('/v1/sessions/:sessionId/messages/action-reference/resolve', {
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            body: MessageActionReferenceV1Schema,
            response: {
                200: MessageActionDurableResolutionV1Schema,
            },
        },
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.messages"),
        },
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const reference = request.body;

        // The caller supplies one opaque reference only. A mismatched route
        // segment never becomes a second Message identity or an existence
        // oracle.
        if (reference.sessionId !== sessionId) {
            return reply.send({ status: "unavailable" });
        }

        const resolution = await inTx(async (tx) => await resolveSessionMessageActionLookup({
            actorUserId: request.userId,
            sessionId,
            messageId: reference.messageId,
            reference,
            readAccess: async (actorUserId, ownedSessionId) =>
                (await checkSessionAccess(actorUserId, ownedSessionId, tx)) !== null,
            readMessage: async (ownedSessionId, messageId) => await tx.sessionMessage.findFirst({
                where: {
                    id: messageId,
                    sessionId: ownedSessionId,
                    session: buildCurrentSessionParticipantWhere({
                        userId: request.userId,
                        sessionId: ownedSessionId,
                    }),
                },
                select: {
                    id: true,
                    sessionId: true,
                    seq: true,
                    messageRole: true,
                    updatedAt: true,
                },
            }),
            readPublication: async (ownedSessionId) => {
                if (!await checkSessionAccess(request.userId, ownedSessionId, tx)) return null;
                return await tx.session.findFirst({
                    where: buildCurrentSessionParticipantWhere({
                        userId: request.userId,
                        sessionId: ownedSessionId,
                    }),
                    select: SESSION_TRANSCRIPT_PUBLICATION_SELECT,
                });
            },
        }));
        return reply.send(resolution);
    });

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
                        deliveryResolution: SessionMessageDeliveryResolutionV1Schema.optional(),
                        content: SessionStoredMessageContentSchema,
                        createdAt: z.number().int().min(0),
                        updatedAt: z.number().int().min(0),
                        sourceCreatedAt: z.number().int().min(0).optional(),
                        sourceUpdatedAt: z.number().int().min(0).optional(),
                        transcriptObservationProvenance: SessionTranscriptObservationProvenanceV1Schema.optional(),
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

        const { row, currentlyAccessible } = await inTx(async (tx) => {
            const publication = await loadSessionTranscriptPublication(tx, sessionId);
            const row = await tx.sessionMessage.findFirst({
                where: buildSessionMessagePublicationWhere({
                    where: {
                        sessionId,
                        localId,
                        session: buildCurrentSessionParticipantWhere({ userId, sessionId }),
                    },
                    publication,
                }),
                select: {
                    id: true,
                    seq: true,
                    localId: true,
                    sidechainId: true,
                    messageRole: true,
                    content: true,
                    deliveryResolution: true,
                    createdAt: true,
                    updatedAt: true,
                    sourceCreatedAt: true,
                    sourceUpdatedAt: true,
                    transcriptObservationProvenance: true,
                },
            });
            return {
                row,
                currentlyAccessible: (await checkSessionAccess(userId, sessionId, tx)) !== null,
            };
        });
        if (!currentlyAccessible) {
            return reply.code(404).send({ error: 'Session not found' });
        }
        if (!row) {
            return reply.code(404).send({ error: 'Message not found' });
        }

        const messageRole = parseSessionMessageRole(row.messageRole);
        return reply.send({
            message: {
                id: row.id,
                seq: row.seq,
                localId: row.localId,
                ...(typeof row.sidechainId === "string" && row.sidechainId ? { sidechainId: row.sidechainId } : {}),
                ...(messageRole ? { messageRole } : {}),
                content: row.content,
                ...(() => {
                    const deliveryResolution = parseSessionMessageDeliveryResolutionV1(row.deliveryResolution);
                    return deliveryResolution ? { deliveryResolution } : {};
                })(),
                createdAt: row.createdAt.getTime(),
                updatedAt: row.updatedAt.getTime(),
                ...(row.sourceCreatedAt ? { sourceCreatedAt: row.sourceCreatedAt.getTime() } : {}),
                ...(row.sourceUpdatedAt ? { sourceUpdatedAt: row.sourceUpdatedAt.getTime() } : {}),
                ...(() => {
                    const provenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(row.transcriptObservationProvenance);
                    return provenance.success ? { transcriptObservationProvenance: provenance.data } : {};
                })(),
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
                limit: z.coerce.number().int().min(1).max(500).optional(),
                beforeSeq: z.coerce.number().int().min(1).optional(),
                afterSeq: z.coerce.number().int().min(0).optional(),
                role: SessionMessageRoleSchema.optional(),
                roles: z.string().optional(),
                projection: z.enum(["externalShareableV1", "turns"]).optional(),
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
                if (value.projection === "turns" && value.afterSeq !== undefined) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: "projection=turns pages backwards only",
                    });
                }
                if (value.projection === "turns" && value.scope === "all") {
                    // A turn is an ordering within ONE chain; interleaving chains would pair a
                    // prompt with a reply from a different conversation.
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: "projection=turns requires a single chain scope",
                    });
                }
                if (
                    value.projection === "externalShareableV1"
                    && value.limit !== undefined
                    && value.limit > EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1
                ) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        path: ["limit"],
                        message: `externalShareableV1 pages are limited to ${EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1} rows`,
                    });
                }
            }).optional(),
            response: {
                200: SessionTranscriptMessagePageResponseSchema,
                400: z.object({
                    error: z.string(),
                    code: z.string(),
                }).passthrough(),
                404: z.object({ error: z.string() }).strict(),
                503: SessionTranscriptStoredContentUnavailableResponseSchema,
            },
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
                  projection?: unknown;
              }>
            | undefined;
        const externalShareableProjection = query?.projection === "externalShareableV1";
        // Served from the MATERIALISED turn anchors, and only once the anchor projection has
        // been operator-activated — before that, `SessionTurn` rows may still be v0 and their
        // anchors cannot be trusted to describe turn boundaries.
        const turnProjection = query?.projection === "turns"
            && isSessionTurnTranscriptAnchorProjectionProtocolActive();
        const { beforeSeq, afterSeq } = query ?? {};
        const limit = query?.limit ?? (externalShareableProjection
            ? EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1
            : 150);
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

        const {
            messages: resultMessages,
            hasMore,
            publicationBlocked,
            externalShareableSnapshot,
            currentlyAccessible,
            turnProjectionNextBeforeSeq,
        } = await inTx(async (tx) => {
            const publication = await loadSessionTranscriptPublication(tx, sessionId);
            const currentParticipantWhere = buildCurrentSessionParticipantWhere({ userId, sessionId });

            // TURN PROJECTION: each prompt plus that turn's final reply, read from the anchors
            // `SessionTurn` already materialises. Constraining `where` HERE (rather than
            // querying messages directly) is what keeps the publication filter below applying
            // to this projection exactly as it does to an ordinary page.
            let turnProjectionPaging: SessionTurnProjectionSeqs | null = null;
            if (turnProjection) {
                const turnRows = await tx.sessionTurn.findMany({
                    where: {
                        sessionId,
                        session: currentParticipantWhere,
                        transcriptAnchorProjectionVersion: 1,
                        ...(beforeSeq !== undefined
                            ? { transcriptAnchorMinSeq: { lt: beforeSeq } }
                            : {}),
                    },
                    // Uses SessionTurn_transcript_anchor_range_idx.
                    orderBy: { transcriptAnchorMaxSeq: 'desc' },
                    // One extra turn so `hasMore` is observed rather than guessed.
                    take: limit + 1,
                    select: {
                        transcriptAnchorsJson: true,
                        transcriptAnchorMinSeq: true,
                        transcriptAnchorMaxSeq: true,
                    },
                });
                turnProjectionPaging = resolveSessionTurnProjectionSeqs({ turnRows, turnLimit: limit });
                where.seq = { in: [...turnProjectionPaging.seqs] };
            }
            const publicationWhere = externalShareableProjection
                ? buildShareableSessionMessagePublicationWhere({
                    where,
                    publication,
                    additionalSessionWhere: currentParticipantWhere,
                })
                : buildSessionMessagePublicationWhere({
                    where: {
                        ...where,
                        session: currentParticipantWhere,
                    },
                    publication,
                });
            const fetchedMessages = await tx.sessionMessage.findMany({
                where: publicationWhere,
                orderBy: { seq: afterSeq !== undefined ? 'asc' : 'desc' },
                // The turn projection is already bounded by the seq set it resolved; a row take
                // would truncate a turn's reply away from its prompt.
                ...(turnProjectionPaging === null ? { take: limit + 1 } : {}),
                select: {
                    id: true,
                    seq: true,
                    localId: true,
                    sidechainId: true,
                    messageRole: true,
                    content: true,
                    deliveryResolution: true,
                    createdAt: true,
                    updatedAt: true,
                    sourceCreatedAt: true,
                    sourceUpdatedAt: true,
                    transcriptObservationProvenance: true,
                    inputAdmissionReceipt: true,
                },
            });
            const hasMore = turnProjectionPaging !== null
                ? turnProjectionPaging.hasMore
                : fetchedMessages.length > limit;
            const messages = turnProjectionPaging !== null
                ? fetchedMessages
                : hasMore ? fetchedMessages.slice(0, limit) : fetchedMessages;
            let externalShareableSnapshot: ReturnType<typeof ExternalShareableTranscriptSnapshotV1Schema.parse> | undefined;
            let turnSettlementBlockedFromSeq: number | null = null;
            let publicationBlockedFromSeq: number | null = null;

            if (externalShareableProjection) {
                const pageSeqs = messages
                    .map((message) => readExternalShareableSequence(message.seq))
                    .filter((seq): seq is number => seq !== null);
                const firstPageSeq = pageSeqs.length > 0 ? Math.min(...pageSeqs) : null;
                const lastPageSeq = pageSeqs.length > 0 ? Math.max(...pageSeqs) : null;
                const transcriptAnchorProjectionActive =
                    isSessionTurnTranscriptAnchorProjectionProtocolActive();
                let hasLegacyTurnProjection = false;
                let turnSnapshotExhausted = false;
                let hasInconsistentTurnProjection = false;
                let turnRows: Awaited<ReturnType<typeof tx.sessionTurn.findMany>> = [];

                if (
                    transcriptAnchorProjectionActive
                    && firstPageSeq !== null
                    && lastPageSeq !== null
                ) {
                    const legacyTurn = await tx.sessionTurn.findFirst({
                        where: {
                            sessionId,
                            session: currentParticipantWhere,
                            transcriptAnchorProjectionVersion: 0,
                        },
                        select: { id: true },
                    });
                    turnRows = await tx.sessionTurn.findMany({
                        where: {
                            sessionId,
                            session: currentParticipantWhere,
                            transcriptAnchorProjectionVersion: 1,
                            OR: [
                                {
                                    transcriptAnchorMinSeq: { lte: lastPageSeq },
                                    transcriptAnchorMaxSeq: { gte: firstPageSeq },
                                },
                                // An in-progress turn can have no range yet while its
                                // admitted input is already publication-visible. Keep
                                // that bounded unknown in the same snapshot rather than
                                // allowing a client to cross it and guess later.
                                {
                                    status: "in_progress",
                                    OR: [
                                        { transcriptAnchorMinSeq: null },
                                        { transcriptAnchorMaxSeq: null },
                                    ],
                                },
                            ],
                        },
                        orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
                        take: EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SNAPSHOT_TURNS_V1,
                    });
                    hasLegacyTurnProjection = legacyTurn !== null;
                    turnSnapshotExhausted = turnRows.length >= EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SNAPSHOT_TURNS_V1;
                    hasInconsistentTurnProjection = turnRows.some((row) =>
                        !isSessionTurnTranscriptAnchorProjectionCurrent(row));
                }

                const consistentTurnRows = turnRows.filter((row) =>
                    isSessionTurnTranscriptAnchorProjectionCurrent(row));

                if (!transcriptAnchorProjectionActive) {
                    // EXPAND/backfill has not crossed its final writer floor.
                    // A page-local barrier keeps all public consumers from
                    // claiming an irreversible external cursor on v0 facts.
                    turnSettlementBlockedFromSeq = firstPageSeq;
                } else {
                    publicationBlockedFromSeq = resolveExternalShareableTranscriptBlockedFromSeq({
                        rows: consistentTurnRows,
                        publication,
                    });
                    turnSettlementBlockedFromSeq = resolveExternalShareableTranscriptTurnSettlementBlockedFromSeq({
                        messages,
                        turns: consistentTurnRows,
                        hasLegacyTurnProjection,
                        turnSnapshotExhausted,
                        hasInconsistentTurnProjection,
                    });
                }
                const visibleTurns = parseStoredSessionTurns(consistentTurnRows.filter((row) =>
                    isExternalShareableSessionTurnVisible({ row, publication })));
                const pageSeqSet = new Set(pageSeqs);
                const referencedUserSeqs = new Set<number>();
                let exactInputWitnessBlockedFromSeq: number | null = null;
                const completedPageFinals = visibleTurns.flatMap((turn) => {
                    const finalAssistantMessageSeq = turn.transcriptAnchors?.finalAssistantMessageSeq;
                    return turn.status === "completed"
                        && typeof finalAssistantMessageSeq === "number"
                        && pageSeqSet.has(finalAssistantMessageSeq)
                        ? [{ turn, finalAssistantMessageSeq }]
                        : [];
                }).sort((left, right) => left.finalAssistantMessageSeq - right.finalAssistantMessageSeq);
                for (const { turn, finalAssistantMessageSeq } of completedPageFinals) {
                    const outOfPageUserMessageSeqs = (turn.transcriptAnchors?.userMessageSeqs ?? [])
                        .filter((userMessageSeq) => !pageSeqSet.has(userMessageSeq));
                    const newlyReferencedUserSeqs = new Set(outOfPageUserMessageSeqs.filter((userMessageSeq) =>
                        !referencedUserSeqs.has(userMessageSeq)));
                    if (
                        outOfPageUserMessageSeqs.length > EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1
                        || referencedUserSeqs.size + newlyReferencedUserSeqs.size
                            > EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1
                    ) {
                        exactInputWitnessBlockedFromSeq = exactInputWitnessBlockedFromSeq === null
                            ? finalAssistantMessageSeq
                            : Math.min(exactInputWitnessBlockedFromSeq, finalAssistantMessageSeq);
                        break;
                    }
                    for (const userMessageSeq of newlyReferencedUserSeqs) {
                        referencedUserSeqs.add(userMessageSeq);
                    }
                }
                const canReadReferencedUsers = !turnSnapshotExhausted
                    && referencedUserSeqs.size <= EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1;
                const referencedRows = canReadReferencedUsers && referencedUserSeqs.size > 0
                    ? await tx.sessionMessage.findMany({
                        where: buildShareableSessionMessagePublicationWhere({
                            where: {
                                sessionId,
                                seq: { in: [...referencedUserSeqs] },
                            },
                            publication,
                            additionalSessionWhere: currentParticipantWhere,
                        }),
                        orderBy: { seq: "asc" },
                        take: EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1,
                        select: {
                            id: true,
                            seq: true,
                            localId: true,
                            sidechainId: true,
                            messageRole: true,
                            content: true,
                            createdAt: true,
                            updatedAt: true,
                            transcriptObservationProvenance: true,
                            inputAdmissionReceipt: true,
                        },
                    })
                    : [];
                const referencedUserRows = referencedRows.flatMap((row) => {
                    const projected = projectExternalShareableReferencedUserRow(row);
                    return projected ? [projected] : [];
                });
                if (
                    exactInputWitnessBlockedFromSeq !== null
                    && (
                        turnSettlementBlockedFromSeq === null
                        || exactInputWitnessBlockedFromSeq < turnSettlementBlockedFromSeq
                    )
                ) {
                    turnSettlementBlockedFromSeq = exactInputWitnessBlockedFromSeq;
                }
                externalShareableSnapshot = ExternalShareableTranscriptSnapshotV1Schema.parse({
                    turns: visibleTurns,
                    ...(publicationBlockedFromSeq !== null ? { publicationBlockedFromSeq } : {}),
                    ...(turnSettlementBlockedFromSeq !== null ? { turnSettlementBlockedFromSeq } : {}),
                    ...(referencedUserRows.length > 0 ? { referencedUserRows } : {}),
                });
            }
            return {
                messages,
                hasMore,
                publicationBlocked: externalShareableProjection
                    && isSessionTranscriptPublicationBlocked(publication),
                externalShareableSnapshot,
                currentlyAccessible: (await checkSessionAccess(userId, sessionId, tx)) !== null,
                turnProjectionNextBeforeSeq: turnProjectionPaging?.nextBeforeSeq ?? null,
            };
        });
        if (!currentlyAccessible) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const parsedResultContents: SessionStoredMessageContent[] = [];
        for (const message of resultMessages) {
            const parsedContent = SessionStoredMessageContentSchema.safeParse(message.content);
            if (!parsedContent.success) {
                return reply.code(503).send({
                    error: "session_transcript_stored_content_unavailable",
                });
            }
            parsedResultContents.push(parsedContent.data);
        }
        if (afterSeq !== undefined) {
            catchupFollowupReturnedCounter.inc({ type: 'session-messages-afterSeq' }, resultMessages.length);
        }
        const nextBeforeSeq =
            afterSeq !== undefined
                ? null
                // The turn projection pages by TURN, so its cursor is the oldest prompt kept —
                // the last ROW returned is a reply, and paging below that would skip its prompt.
                : turnProjection
                    ? turnProjectionNextBeforeSeq
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
            messages: resultMessages.map((v, index) => ({
                id: v.id,
                seq: v.seq,
                content: parsedResultContents[index]!,
                ...(() => {
                    const reference = issueSessionMessageActionReference({
                        sessionId,
                        messageId: v.id,
                        updatedAt: v.updatedAt,
                    });
                    return reference ? { messageActionReference: reference } : {};
                })(),
                ...(() => {
                    const deliveryResolution = parseSessionMessageDeliveryResolutionV1(v.deliveryResolution);
                    return deliveryResolution ? { deliveryResolution } : {};
                })(),
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
                    const provenance = SessionTranscriptObservationProvenanceV1Schema.safeParse(v.transcriptObservationProvenance);
                    return provenance.success ? { transcriptObservationProvenance: provenance.data } : {};
                })(),
                ...(() => {
                    if (!externalShareableProjection) return {};
                    const externalShareableActor = deriveExternalShareableActor({
                        inputAdmissionReceipt: v.inputAdmissionReceipt,
                        messageRole: v.messageRole,
                        transcriptObservationProvenance: v.transcriptObservationProvenance,
                    });
                    return externalShareableActor ? { externalShareableActor } : {};
                })(),
            })),
            hasMore: hasMore
                || publicationBlocked
                || externalShareableSnapshot?.publicationBlockedFromSeq !== undefined
                || externalShareableSnapshot?.turnSettlementBlockedFromSeq !== undefined,
            nextBeforeSeq,
            nextAfterSeq,
            ...(externalShareableProjection ? { publicationBlocked, externalShareableSnapshot } : {}),
        });
    });

    app.post('/v2/sessions/:sessionId/transcript/import', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            body: z.object({
                items: z.array(z.object({
                    localId: z.string().trim().min(1),
                    content: SessionStoredMessageContentSchema,
                    messageRole: SessionMessageRoleSchema.optional(),
                })).min(1).max(500),
            }),
            response: {
                200: z.object({
                    imported: z.number().int().min(0),
                    cursor: z.number().int().min(0).nullable(),
                }).strict(),
                400: z.object({ error: z.literal("Invalid parameters"), code: z.string().optional() }).strict(),
                403: z.object({ error: z.literal("Forbidden") }).strict(),
                404: z.object({ error: z.literal("Session not found") }).strict(),
                500: z.object({ error: z.literal("Failed to import transcript") }).strict(),
            },
        },
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const body = request.body as Readonly<{
            items: readonly HistoricalSessionTranscriptImportItem[];
        }>;
        const result = await importHistoricalSessionTranscript({
            actorUserId: request.userId,
            sessionId,
            items: body.items,
        });
        if (!result.ok) {
            if (result.error === "forbidden") {
                return reply.code(403).send({ error: "Forbidden" });
            }
            if (result.error === "session-not-found") {
                return reply.code(404).send({ error: "Session not found" });
            }
            if (result.error === "internal") {
                return reply.code(500).send({ error: "Failed to import transcript" });
            }
            return reply.code(400).send({
                error: "Invalid parameters",
                ...(result.code ? { code: result.code } : {}),
            });
        }
        return reply.send({
            imported: result.imported,
            cursor: result.cursor,
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
        const trustedSessionEventType = body.sessionEventType === "ready" ? "ready" : undefined;
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

        // The Agent-transition divider local-ID namespace is reserved. Only the
        // owner-only transition service may pass one to `createSessionMessage`;
        // a generic client ingress must never mint or overwrite a divider row.
        if (isSessionAgentTransitionDividerLocalId(effectiveLocalId)) {
            return reply.code(400).send({
                error: "Invalid parameters",
                code: "session_message_reserved_local_id",
            });
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

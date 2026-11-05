import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { Prisma } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { z } from "zod/mini";
import { catchupFollowupFetchesCounter } from "@/app/monitoring/metrics/index";
import { EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1, EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1, EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_SNAPSHOT_TURNS_V1, ExternalShareableTranscriptSnapshotV1Schema } from '@happier-dev/protocol/sessions/messages/sessionExternalShareableTranscriptV1';
import { projectSessionMessageAccountActors } from "@/app/session/messages/projectSessionMessageAccountActors";
import { parseSessionMessageSidechainId } from "@/app/session/parseSessionMessageSidechainId";
import { buildSessionMessagePublicationWhere, buildShareableSessionMessagePublicationWhere, isExternalShareableSessionTurnVisible, isSessionTranscriptPublicationBlocked, loadSessionTranscriptPublication, resolveExternalShareableTranscriptBlockedFromSeq, resolveExternalShareableTranscriptTurnSettlementBlockedFromSeq } from "@/app/session/sessionTranscriptPublicationPolicy";
import { parseStoredSessionTurns } from "@/app/session/turns/parseSessionTurnState";
import { isSessionTurnTranscriptAnchorProjectionCurrent } from "@/app/session/turns/sessionTurnTranscriptAnchorProjection";
import { resolveSessionTurnProjectionSeqs, type SessionTurnProjectionSeqs } from "./resolveSessionTurnProjectionSeqs";
import { resolveSessionAccessForOperation } from '@/app/session/access/sessionAccess';
import { captureReadSnapshot } from '@/storage/captureReadSnapshot';
import { PRESENT_USER_REQUIRED_ERROR } from "@/app/api/utils/apiTokenRouteAdmission";
import { SessionTranscriptMessagePageResponseSchema, type SessionListPreviewQuery, isAdmittedSessionListPreviewRequest, readExternalShareableSequence, projectExternalShareableReferencedUserRow, resolveRequestedMessageRoles, buildRequestedMessageRoleWhere, SESSION_MESSAGE_PAGE_ROW_SELECT, projectSessionMessagePage, SESSION_MESSAGE_PAGE_DEFAULT_LIMIT } from './sessionMessagePageProjection';
/** Paginated projections share admission and row projection with first-page batches. */
export async function readSessionMessagePage(input: Readonly<{
    userId: string;
    sessionId: string;
    authentication: SessionAccessAuthentication;
    query?: SessionListPreviewQuery;
    previewRequest?: Pick<FastifyRequest, "externalActionExecutionAuthorized" | "externalActionEffectActionId" | "externalActionExecutionTarget">;
}>): Promise<{
    status: 200;
    body: z.input<typeof SessionTranscriptMessagePageResponseSchema>;
} | {
    status: 400 | 403 | 404 | 503;
    body: {
        error: string;
        code?: string;
    };
}> {
    const { userId, sessionId, authentication, query } = input;
    const previewRequest = input.previewRequest ?? {};
    if (!isAdmittedSessionListPreviewRequest({ request: previewRequest, sessionId, query })) {
        return { status: 403, body: { error: PRESENT_USER_REQUIRED_ERROR } };
    }
    const sessionListPreviewProjection = previewRequest.externalActionExecutionAuthorized === true
        && previewRequest.externalActionEffectActionId === "session.list";
    const externalShareableProjection = query?.projection === "externalShareableV1";
    const turnProjection = query?.projection === "turns";
    const { beforeSeq, afterSeq } = query ?? {};
    const limit = query?.limit ?? (externalShareableProjection
        ? EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_PAGE_ROWS_V1
        : SESSION_MESSAGE_PAGE_DEFAULT_LIMIT);
    const parsedRoles = resolveRequestedMessageRoles(query);
    if (!parsedRoles.ok) {
        return { status: 400, body: { error: "Invalid parameters", code: "invalid-role" } };
    }
    const roles = parsedRoles.roles;
    const scope = (() => {
        const raw = query?.scope;
        if (raw === "all" || raw === "sidechain" || raw === "main")
            return raw;
        return "main";
    })();
    const parsedSidechainId = parseSessionMessageSidechainId(query?.sidechainId, { emptyString: "null" });
    const sidechainId = parsedSidechainId.ok ? parsedSidechainId.sidechainId : null;
    if (scope === "sidechain" && sidechainId === null) {
        return { status: 400, body: { error: "Invalid parameters", code: "missing-sidechain-id" } };
    }
    if (afterSeq !== undefined) {
        catchupFollowupFetchesCounter.inc({ type: 'session-messages-afterSeq' });
    }
    const where: Prisma.SessionMessageWhereInput = {
        sessionId,
        ...(query?.messageId === undefined ? {} : { id: query.messageId }),
    };
    if (scope === "main")
        where.sidechainId = null;
    if (scope === "sidechain")
        where.sidechainId = sidechainId;
    const roleWhere = buildRequestedMessageRoleWhere(roles);
    if (roleWhere)
        Object.assign(where, roleWhere);
    if (beforeSeq !== undefined) {
        where.seq = { lt: beforeSeq };
    }
    if (afterSeq !== undefined) {
        where.seq = { gt: afterSeq };
    }
    const { messages: resultMessages, hasMore, publicationBlocked, externalShareableSnapshot, accessDecision: snapshotAccessDecision, turnProjectionNextBeforeSeq, pageAccountActors, } = await captureReadSnapshot(async (tx) => {
        const accessDecision = await resolveSessionAccessForOperation(tx, { accountId: userId,
            sessionId, authentication, capability: 'readTranscript' });
        if (accessDecision.status !== 'allowed')
            return { messages: [], hasMore: false,
                publicationBlocked: false, externalShareableSnapshot: undefined, accessDecision,
                turnProjectionNextBeforeSeq: null, pageAccountActors: [] };
        const publication = await loadSessionTranscriptPublication(tx, sessionId);
        const currentParticipantWhere = { id: sessionId };
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
            select: SESSION_MESSAGE_PAGE_ROW_SELECT,
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
            let hasLegacyTurnProjection = false;
            let turnSnapshotExhausted = false;
            let hasInconsistentTurnProjection = false;
            let turnRows: Awaited<ReturnType<typeof tx.sessionTurn.findMany>> = [];
            if (firstPageSeq !== null
                && lastPageSeq !== null) {
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
                                status: { in: ["in_progress", "waiting"] },
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
                hasInconsistentTurnProjection = turnRows.some((row) => !isSessionTurnTranscriptAnchorProjectionCurrent(row));
            }
            const consistentTurnRows = turnRows.filter((row) => isSessionTurnTranscriptAnchorProjectionCurrent(row));
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
            const visibleTurns = parseStoredSessionTurns(consistentTurnRows.filter((row) => isExternalShareableSessionTurnVisible({ row, publication })));
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
                const newlyReferencedUserSeqs = new Set(outOfPageUserMessageSeqs.filter((userMessageSeq) => !referencedUserSeqs.has(userMessageSeq)));
                if (outOfPageUserMessageSeqs.length > EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1
                    || referencedUserSeqs.size + newlyReferencedUserSeqs.size
                        > EXTERNAL_SHAREABLE_TRANSCRIPT_MAX_REFERENCED_USER_ROWS_V1) {
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
            if (exactInputWitnessBlockedFromSeq !== null
                && (turnSettlementBlockedFromSeq === null
                    || exactInputWitnessBlockedFromSeq < turnSettlementBlockedFromSeq)) {
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
            accessDecision,
            turnProjectionNextBeforeSeq: turnProjectionPaging?.nextBeforeSeq ?? null,
            // Keep the whole read off SQLite's write pool, including actor profiles.
            pageAccountActors: externalShareableProjection || sessionListPreviewProjection
                ? messages.map(() => null)
                : await projectSessionMessageAccountActors(tx, messages.map((v) => ({
                    messageRole: v.messageRole,
                    inputAdmissionReceipt: v.inputAdmissionReceipt,
                    authorAccountId: v.authorAccountId,
                }))),
        };
    });
    const accessDecision = snapshotAccessDecision;
    if (accessDecision.status === "authentication_required") {
        return { status: 403, body: { error: "team_authentication_required" } };
    }
    if (accessDecision.status === "authentication_unavailable") {
        return { status: 503, body: { error: "team_authentication_unavailable" } };
    }
    if (accessDecision.status !== "allowed") {
        return { status: 404, body: { error: 'Session not found' } };
    }
    return projectSessionMessagePage({ sessionId, resultMessages, hasMore, publicationBlocked, externalShareableSnapshot,
        turnProjectionNextBeforeSeq, pageAccountActors, sessionListPreviewProjection, externalShareableProjection, turnProjection, afterSeq });
}

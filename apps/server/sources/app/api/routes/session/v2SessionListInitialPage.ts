import type { Prisma } from "@prisma/client";

import { db } from "@/storage/db";
import {
    requiresSessionMetadataOwnerAccountMode,
    type SessionMetadataOwnerAccountMode,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";

import {
    createV2SessionListCursorWhere,
    createV2SessionListRowPage,
    findV2SessionListRows,
    mapV2SessionListRows,
    mergeSessionWhereInputs,
    V2_SESSION_LIST_ORDER_BY,
} from "./v2SessionListPage";
import {
    parseStoredSessionLatestTurnStatus,
    parseStoredSessionRuntimeIssue,
    type V2SessionListRowCompat,
} from "./v2SessionListRows";
import {
    resolveV2SessionListInitialAttentionRowLimit,
} from "./v2SessionHotReadLimits";
import type { V2SessionListInitialPageTiming } from "./v2SessionListServerTiming";
import {
    createSessionTranscriptPublicationLiveFactsWhere,
    createSessionTranscriptPublicationReadyEventWhere,
    projectSessionTranscriptPublicationPreview,
} from "@/app/session/sessionTranscriptPublicationPolicy";

type V2SessionListInitialPageParams = Readonly<{
    userId: string;
    admitFinalRows: (
        rows: ReadonlyArray<V2SessionListRowCompat>,
    ) => Promise<boolean>;
    readOwnerAccountModes: (
        accountIds: readonly string[],
    ) => Promise<ReadonlyMap<string, SessionMetadataOwnerAccountMode>>;
    pageRows: ReadonlyArray<V2SessionListRowCompat>;
    limit: number;
    pinnedSessionIds: readonly string[];
    includeAttentionRows: boolean;
    attentionRowsLimit?: number;
    timing?: V2SessionListInitialPageTiming;
}>;

function readNumberField(row: V2SessionListRowCompat, field: string): number | null {
    const value = (row as Record<string, unknown>)[field];
    if (typeof value === "bigint") return Number(value);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readAttentionPublicationProjection(row: V2SessionListRowCompat) {
    return projectSessionTranscriptPublicationPreview({
        seq: readNumberField(row, "seq") ?? 0,
        lastViewedSessionSeq: readNumberField(row, "lastViewedSessionSeq"),
        latestReadyEventSeq: readNumberField(row, "latestReadyEventSeq"),
        latestReadyEventAt: null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        meaningfulActivityAt: row.meaningfulActivityAt,
        lastActiveAt: row.lastActiveAt,
    }, row);
}

type AttentionPublicationProjection = ReturnType<typeof readAttentionPublicationProjection>;

function hasUnreadSessionActivity(projection: AttentionPublicationProjection): boolean {
    return projection.seq > (projection.lastViewedSessionSeq ?? 0);
}

function hasUnreadReadyEvent(projection: AttentionPublicationProjection): boolean {
    const latestReadyEventSeq = projection.latestReadyEventSeq;
    if (typeof latestReadyEventSeq !== "number") return false;
    return latestReadyEventSeq > (projection.lastViewedSessionSeq ?? 0);
}

function hasPrimarySessionFailure(
    row: V2SessionListRowCompat,
    projection: AttentionPublicationProjection,
): boolean {
    if (!projection.hasLiveFacts) return false;
    if (parseStoredSessionLatestTurnStatus(row.latestTurnStatus) !== "failed") return false;
    const issue = parseStoredSessionRuntimeIssue(row.lastRuntimeIssue);
    return issue?.v === 1
        && issue.scope === "primary_session"
        && issue.status === "failed"
        && (row.active === true || hasUnreadSessionActivity(projection));
}

/**
 * The canonical read cursor decides durable attention, not the ready-event cursor alone: a session
 * whose provider kept working after its last ready event was read is unread, and hydrating the
 * initial page from the ready-event cursor left it out of the first paint entirely. The generic
 * arm sits with the other live-work facts because a finite publication's session sequence belongs
 * to an operation-private state; such a row still reaches attention through the ready-event arm,
 * which carries its own publication admission.
 */
function isDurableAttentionRow(row: V2SessionListRowCompat): boolean {
    const publicationProjection = readAttentionPublicationProjection(row);
    return (publicationProjection.hasLiveFacts && (
        row.pendingPermissionRequestCount > 0
        || row.pendingUserActionRequestCount > 0
        || hasPrimarySessionFailure(row, publicationProjection)
        || hasUnreadSessionActivity(publicationProjection)
    ))
        || hasUnreadReadyEvent(publicationProjection);
}

/**
 * Candidate arm for `hasUnreadReadyEvent`, expressed as a column-to-column comparison so a session
 * that was ready once and has since been read stops occupying a candidate slot forever.
 *
 * Superset proof against the confirmation step. `hasUnreadReadyEvent` reads the publication-ceiling
 * projection, where a published `latestReadyEventSeq` keeps its stored value and
 * `lastViewedSessionSeq` is only ever lowered (to `min(stored, ceiling)`, or read as `0` when it is
 * absent). A confirmed row therefore satisfies `stored latestReadyEventSeq > min(stored
 * lastViewedSessionSeq, ceiling)`; since publication requires `latestReadyEventSeq <= ceiling`, the
 * `ceiling` side can never be the smaller term, so `latestReadyEventSeq > lastViewedSessionSeq`
 * holds on the stored columns. The second disjunct covers the one case SQL cannot express through
 * that comparison: a never-viewed session, where `lastViewedSessionSeq` is NULL and the projection
 * reads it as `0`.
 */
function createV2SessionListUnreadReadyEventWhere(): Prisma.SessionWhereInput {
    return {
        OR: [
            { latestReadyEventSeq: { gt: db.session.fields.lastViewedSessionSeq } },
            { lastViewedSessionSeq: null, latestReadyEventSeq: { gt: 0 } },
        ],
    };
}

function createV2SessionListPublishedUnreadReadyEventWhere(): Prisma.SessionWhereInput {
    return {
        AND: [
            createSessionTranscriptPublicationReadyEventWhere(),
            createV2SessionListUnreadReadyEventWhere(),
        ],
    };
}

/**
 * Candidate arm for the generic unread-activity comparison, expressed as a column-to-column
 * comparison so a session the reader has caught up with stops occupying a candidate slot.
 *
 * Superset proof against the confirmation step. The arm is conjoined with the live-facts predicate,
 * and a live-facts row has no publication ceiling, so `applySessionTranscriptPublicationCeilingToProjection`
 * leaves both `seq` and `lastViewedSessionSeq` at their stored values: the projected comparison
 * `seq > (lastViewedSessionSeq ?? 0)` is exactly the stored one. The second disjunct covers the one
 * case SQL cannot express through the column comparison: a never-viewed session, where
 * `lastViewedSessionSeq` is NULL and the projection reads it as `0`.
 */
function createV2SessionListLiveUnreadSessionActivityWhere(): Prisma.SessionWhereInput {
    return {
        AND: [
            createSessionTranscriptPublicationLiveFactsWhere(),
            {
                OR: [
                    { seq: { gt: db.session.fields.lastViewedSessionSeq } },
                    { lastViewedSessionSeq: null, seq: { gt: 0 } },
                ],
            },
        ],
    };
}

/**
 * Candidate predicate for the durable-attention arm. `isDurableAttentionRow` is the confirmation
 * step, so this only has to be a superset of the rows that can qualify.
 *
 */
export function createV2SessionListAttentionRowsWhere(): Prisma.SessionWhereInput {
    return {
        archivedAt: null,
        AND: [{
            OR: [
                {
                    AND: [
                        createSessionTranscriptPublicationLiveFactsWhere(),
                        { latestTurnStatus: "failed" },
                    ],
                },
                createV2SessionListPublishedUnreadReadyEventWhere(),
                createV2SessionListLiveUnreadSessionActivityWhere(),
                {
                    AND: [
                        createSessionTranscriptPublicationLiveFactsWhere(),
                        { pendingPermissionRequestCount: { gt: 0 } },
                    ],
                },
                {
                    AND: [
                        createSessionTranscriptPublicationLiveFactsWhere(),
                        { pendingUserActionRequestCount: { gt: 0 } },
                    ],
                },
            ],
        }],
    };
}

export async function createV2SessionAttentionPage(params: Readonly<{
    userId: string;
    cursor?: Readonly<{ sessionId: string; meaningfulActivityAt: number }>;
    candidateLimit?: number;
    timing?: V2SessionListInitialPageTiming;
}>) {
    const candidateLimit = params.candidateLimit ?? resolveV2SessionListInitialAttentionRowLimit();
    const measureQuery = params.timing?.measureQuery ?? (<T>(fn: () => Promise<T>) => fn());
    const measurePage = params.timing?.measurePage ?? (<T>(fn: () => T) => fn());
    // Merged, not nested: `findV2SessionListRows` extracts the cursor from the top-level `AND`
    // and re-expresses it through each publication-recency branch. Nesting it would leave the
    // finite creation-time branch conjoined with the raw activity predicate that it must ignore.
    const createAttentionWhere = (): Prisma.SessionWhereInput =>
        mergeSessionWhereInputs(
            createV2SessionListAttentionRowsWhere(),
            createV2SessionListCursorWhere(params.cursor),
        );
    const candidateRows = await measureQuery(() => findV2SessionListRows({
        userId: params.userId,
        where: createAttentionWhere(),
        orderBy: V2_SESSION_LIST_ORDER_BY,
        take: candidateLimit + 1,
    }));
    const candidatePage = measurePage(() => createV2SessionListRowPage({
        rows: candidateRows,
        limit: candidateLimit,
    }));
    const attentionRows = measurePage(() => candidatePage.rows.filter(isDurableAttentionRow));

    return measurePage(() => ({
        rows: attentionRows,
        attentionNextCursor: candidatePage.nextCursor,
        attentionHasNext: candidatePage.hasNext,
    }));
}

function mergeInitialRows(params: Readonly<{
    pinnedSessionIds: readonly string[];
    pinnedRows: ReadonlyArray<V2SessionListRowCompat>;
    attentionRows: ReadonlyArray<V2SessionListRowCompat>;
    pageRows: ReadonlyArray<V2SessionListRowCompat>;
}>): V2SessionListRowCompat[] {
    const pinnedRowsById = new Map(params.pinnedRows.map((row) => [row.id, row]));
    const seen = new Set<string>();
    const rows: V2SessionListRowCompat[] = [];
    const appendRow = (row: V2SessionListRowCompat | undefined): void => {
        if (!row || seen.has(row.id)) return;
        seen.add(row.id);
        rows.push(row);
    };

    for (const sessionId of params.pinnedSessionIds) {
        appendRow(pinnedRowsById.get(sessionId));
    }
    for (const row of params.attentionRows) {
        if (isDurableAttentionRow(row)) appendRow(row);
    }
    for (const row of params.pageRows) {
        appendRow(row);
    }
    return rows;
}

export async function createV2SessionListInitialPage(params: V2SessionListInitialPageParams) {
    const attentionRowsLimit = params.attentionRowsLimit ?? resolveV2SessionListInitialAttentionRowLimit();
    const pinnedSessionIds = params.pinnedSessionIds;
    const measureQuery = params.timing?.measureQuery ?? (<T>(fn: () => Promise<T>) => fn());
    const measurePage = params.timing?.measurePage ?? (<T>(fn: () => T) => fn());
    const [pinnedRows, attentionPage] = await Promise.all([
        pinnedSessionIds.length > 0
            ? measureQuery(() => findV2SessionListRows({
                userId: params.userId,
                where: { archivedAt: null, id: { in: [...pinnedSessionIds] } },
                orderBy: { id: "desc" },
                take: pinnedSessionIds.length,
            }))
            : Promise.resolve([]),
        params.includeAttentionRows
            ? createV2SessionAttentionPage({
                userId: params.userId,
                candidateLimit: attentionRowsLimit,
                timing: params.timing,
            })
            : Promise.resolve({
                rows: [] as V2SessionListRowCompat[],
                attentionNextCursor: null,
                attentionHasNext: false,
            }),
    ]);
    const page = measurePage(() => createV2SessionListRowPage({
        rows: params.pageRows,
        limit: params.limit,
    }));
    const pageRows = params.pageRows.slice(0, params.limit);
    const mergedRows = measurePage(() => mergeInitialRows({
        pinnedSessionIds,
        pinnedRows,
        attentionRows: attentionPage.rows,
        pageRows,
    }));

    if (!await params.admitFinalRows(mergedRows)) {
        return null;
    }

    const ownerAccountModes = await params.readOwnerAccountModes(
        mergedRows
            .filter((row) => requiresSessionMetadataOwnerAccountMode({
                session: row,
            }))
            .map((row) => row.accountId),
    );

    return measurePage(() => ({
        sessions: mapV2SessionListRows({
            rows: mergedRows,
            userId: params.userId,
            ownerAccountModes,
        }),
        nextCursor: page.nextCursor,
        hasNext: page.hasNext,
        attentionNextCursor: attentionPage.attentionNextCursor,
        attentionHasNext: attentionPage.attentionHasNext,
    }));
}

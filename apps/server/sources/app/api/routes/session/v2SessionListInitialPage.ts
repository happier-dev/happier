import type { Prisma } from "@prisma/client";

import {
    createV2SessionListCursorWhere,
    createV2SessionListPage,
    createV2SessionListRowPage,
    findV2SessionListRows,
    mapV2SessionListRows,
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
    applySessionTranscriptPublicationCeilingToProjection,
} from "@/app/session/sessionTranscriptPublicationPolicy";

type V2SessionListInitialPageParams = Readonly<{
    userId: string;
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
    return applySessionTranscriptPublicationCeilingToProjection({
        seq: readNumberField(row, "seq") ?? 0,
        lastViewedSessionSeq: readNumberField(row, "lastViewedSessionSeq"),
        latestReadyEventSeq: readNumberField(row, "latestReadyEventSeq"),
        latestReadyEventAt: null,
    }, row);
}

type AttentionPublicationProjection = ReturnType<typeof readAttentionPublicationProjection>;

function hasUnreadSessionActivity(projection: AttentionPublicationProjection): boolean {
    return projection.seq > (projection.lastViewedSessionSeq ?? 0);
}

function hasUnreadReadyEvent(projection: AttentionPublicationProjection): boolean {
    const latestReadyEventSeq = projection.latestReadyEventSeq;
    if (latestReadyEventSeq === null) return false;
    return latestReadyEventSeq > (projection.lastViewedSessionSeq ?? 0);
}

function hasPrimarySessionFailure(
    row: V2SessionListRowCompat,
    projection: AttentionPublicationProjection,
): boolean {
    if (parseStoredSessionLatestTurnStatus(row.latestTurnStatus) !== "failed") return false;
    const issue = parseStoredSessionRuntimeIssue(row.lastRuntimeIssue);
    return issue?.v === 1
        && issue.scope === "primary_session"
        && issue.status === "failed"
        && (row.active === true || hasUnreadSessionActivity(projection));
}

function isDurableAttentionRow(row: V2SessionListRowCompat): boolean {
    const publicationProjection = readAttentionPublicationProjection(row);
    return row.pendingPermissionRequestCount > 0
        || row.pendingUserActionRequestCount > 0
        || hasPrimarySessionFailure(row, publicationProjection)
        || hasUnreadReadyEvent(publicationProjection);
}

function createAttentionRowsWhere(): Prisma.SessionWhereInput {
    return {
        archivedAt: null,
        AND: [{
            OR: [
                { latestTurnStatus: "failed" },
                { latestReadyEventSeq: { not: null } },
                { pendingPermissionRequestCount: { gt: 0 } },
                { pendingUserActionRequestCount: { gt: 0 } },
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
    const candidateRows = await measureQuery(() => findV2SessionListRows({
        userId: params.userId,
        where: {
            AND: [
                createAttentionRowsWhere(),
                createV2SessionListCursorWhere(params.cursor),
            ],
        },
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
    const page = measurePage(() => createV2SessionListPage({
        rows: params.pageRows,
        userId: params.userId,
        limit: params.limit,
    }));
    const pageRows = params.pageRows.slice(0, params.limit);
    const mergedRows = measurePage(() => mergeInitialRows({
        pinnedSessionIds,
        pinnedRows,
        attentionRows: attentionPage.rows,
        pageRows,
    }));

    return measurePage(() => ({
        ...page,
        sessions: mapV2SessionListRows({ rows: mergedRows, userId: params.userId }),
        attentionNextCursor: attentionPage.attentionNextCursor,
        attentionHasNext: attentionPage.attentionHasNext,
    }));
}

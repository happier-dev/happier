import type { Prisma } from "@prisma/client";

import {
    createSessionPersonalAttentionQueryInTx,
} from "@/app/session/personal/queries";
import { SESSION_PERSONAL_ATTENTION_SCAN_BATCH_SIZE } from "@/app/session/personal/attentionQuery";
import { inTx } from "@/storage/inTx";
import { resolveEffectiveSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import {
    requiresSessionMetadataOwnerAccountMode,
    type SessionMetadataOwnerAccountMode,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";

import {
    createV2SessionListRowPage,
    findV2SessionListRows,
    mapV2SessionListRows,
    type SessionListReadSource,
    type SessionListRowAdmission,
    V2_ACTIVE_SESSION_LIST_ORDER_BY,
    V2_ACTIVE_SESSION_LIST_ROW_LIMIT,
    V2_SESSION_LIST_ORDER_BY,
} from "./page";
import {
    type V2SessionListRowCompat,
} from "./rows";
import type { SessionPersonalDiscussionFacts } from "@/app/session/personal/discussionFacts";
import {
    resolveV2SessionListInitialAttentionRowLimit,
} from "./readLimits";
import {
    conjoinSessionListWhereInputs,
    createLegacyActiveSessionListWhere,
} from "./query";
import type { V2SessionListInitialPageTiming } from "./timing";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";


type V2SessionListInitialPageParams = Readonly<{
    userId: string;
    authentication: SessionAccessAuthentication;
    where: Prisma.SessionWhereInput;
    readOwnerAccountModes: (
        accountIds: readonly string[],
    ) => Promise<ReadonlyMap<string, SessionMetadataOwnerAccountMode>>;
    /** Loads this viewer's Lane 05 conversation facts for the merged rows. */
    readViewerDiscussionFacts: (
        rows: ReadonlyArray<Readonly<{ id: string }>>,
    ) => Promise<ReadonlyMap<string, SessionPersonalDiscussionFacts>>;
    readOtherNamedCollaboratorFacts?: (
        rows: ReadonlyArray<Readonly<{ id: string; accountId: string }>>,
    ) => Promise<ReadonlyMap<string, boolean>>;
    pageRows: ReadonlyArray<V2SessionListRowCompat>;
    limit: number;
    pinnedSessionIds: readonly string[];
    includeAttentionRows: boolean;
    attentionRowsLimit?: number;
    includeActiveRows?: boolean;
    activeRowsLimit?: number;
    source?: SessionListReadSource;
    attentionWhere?: Prisma.SessionWhereInput;
    rowAdmission?: SessionListRowAdmission;
    attentionRowAdmission?: SessionListRowAdmission;
    now?: number;
    timing?: V2SessionListInitialPageTiming;
}>;

export async function createV2SessionAttentionPage(params: Readonly<{
    userId: string;
    authentication: SessionAccessAuthentication;
    where: Prisma.SessionWhereInput;
    cursor?: Readonly<{ sessionId: string; meaningfulActivityAt: number }>;
    candidateLimit?: number;
    source?: SessionListReadSource;
    attentionWhere?: Prisma.SessionWhereInput;
    rowAdmission?: SessionListRowAdmission;
    now?: number;
    timing?: V2SessionListInitialPageTiming;
}>): Promise<Readonly<{
    rows: V2SessionListRowCompat[];
    attentionNextCursor: string | null;
    attentionHasNext: boolean;
}>> {
    if (!params.source) {
        return await inTx(async (tx) => {
            const access = await resolveEffectiveSessionAccessWhere({
                tx,
                accountId: params.userId,
                capability: "readTranscript",
                mode: "effective_access_v1",
                authentication: params.authentication,
            });
            const now = params.now ?? Date.now();
            const attention = createSessionPersonalAttentionQueryInTx(tx, {
                accountId: params.userId,
                qualifiedTeamIds: access.qualifiedTeamIds,
                now,
            });
            return await createV2SessionAttentionPage({
                ...params,
                source: {
                    kind: "effective",
                    reader: tx,
                    baseWhere: access.where,
                    accessMode: "effective_access_v1",
                    allowProjectionFallback: false,
                    qualifiedTeamIds: access.qualifiedTeamIds,
                    discussionReader: tx,
                },
                attentionWhere: params.attentionWhere ?? attention.candidateWhere,
                rowAdmission: params.rowAdmission ?? attention.admitRows,
                now,
            });
        }, { readOnly: true });
    }
    const candidateLimit = params.candidateLimit ?? resolveV2SessionListInitialAttentionRowLimit();
    const examinationLimit = Math.max(candidateLimit, SESSION_PERSONAL_ATTENTION_SCAN_BATCH_SIZE);
    const measureQuery = params.timing?.measureQuery ?? (<T>(fn: () => Promise<T>) => fn());
    const measurePage = params.timing?.measurePage ?? (<T>(fn: () => T) => fn());
    const attentionWhere = params.attentionWhere;
    const rowAdmission = params.rowAdmission;
    // Supplemental attention is a bounded candidate scan, not an output-row
    // limit. Read one extra candidate to keep incompleteness explicit, advance
    // the continuation over every examined row, and only then run the canonical
    // projector. The ordinary `needs_my_attention` corpus path separately scans
    // through rejected candidates until its requested output page is complete.
    const candidateRows = await measureQuery(() => findV2SessionListRows({
        userId: params.userId,
        where: conjoinSessionListWhereInputs(params.where, attentionWhere),
        cursor: params.cursor,
        orderBy: V2_SESSION_LIST_ORDER_BY,
        take: examinationLimit + 1,
        ...(params.source
            ? { source: params.source }
            : { authentication: params.authentication }),
    }));
    const candidatePage = measurePage(() => createV2SessionListRowPage({
        rows: candidateRows,
        limit: examinationLimit,
    }));
    const admittedRows = rowAdmission
        ? [...await rowAdmission(candidatePage.rows)]
        : candidatePage.rows;
    const attentionRows = admittedRows.slice(0, candidateLimit);

    if (admittedRows.length > candidateLimit) {
        const lastEmittedId = attentionRows[attentionRows.length - 1]?.id;
        const lastEmittedIndex = candidateRows.findIndex((row) => row.id === lastEmittedId);
        const overflowPage = measurePage(() => createV2SessionListRowPage({
            rows: candidateRows,
            limit: lastEmittedIndex + 1,
        }));
        return {
            rows: attentionRows,
            attentionNextCursor: overflowPage.nextCursor,
            attentionHasNext: overflowPage.hasNext,
        };
    }

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
    activeRows: ReadonlyArray<V2SessionListRowCompat>;
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
        appendRow(row);
    }
    for (const row of params.activeRows) {
        appendRow(row);
    }
    for (const row of params.pageRows) {
        appendRow(row);
    }
    return rows;
}

export async function createV2SessionListInitialPage(params: V2SessionListInitialPageParams) {
    const attentionRowsLimit = params.attentionRowsLimit ?? resolveV2SessionListInitialAttentionRowLimit();
    const activeRowsLimit = params.activeRowsLimit ?? V2_ACTIVE_SESSION_LIST_ROW_LIMIT;
    const includeActiveRows = params.includeActiveRows === true;
    const pinnedSessionIds = params.pinnedSessionIds;
    const measureQuery = params.timing?.measureQuery ?? (<T>(fn: () => Promise<T>) => fn());
    const measurePage = params.timing?.measurePage ?? (<T>(fn: () => T) => fn());
    const readAdmission = params.source
        ? { source: params.source }
        : { authentication: params.authentication };
    const [pinnedRows, attentionPage, activeRows] = await Promise.all([
        pinnedSessionIds.length > 0
            ? measureQuery(() => findV2SessionListRows({
                userId: params.userId,
                where: conjoinSessionListWhereInputs(
                    params.where,
                    { id: { in: [...pinnedSessionIds] } },
                ),
                orderBy: { id: "desc" },
                take: pinnedSessionIds.length,
                rowAdmission: params.rowAdmission,
                ...readAdmission,
            }))
            : Promise.resolve([]),
        params.includeAttentionRows
            ? createV2SessionAttentionPage({
                userId: params.userId,
                where: params.where,
                candidateLimit: attentionRowsLimit,
                authentication: params.authentication,
                ...(params.source ? { source: params.source } : {}),
                attentionWhere: params.attentionWhere,
                rowAdmission: params.attentionRowAdmission,
                timing: params.timing,
            })
            : Promise.resolve({
                rows: [] as V2SessionListRowCompat[],
                attentionNextCursor: null,
                attentionHasNext: false,
            }),
        includeActiveRows
            ? measureQuery(() => findV2SessionListRows({
                userId: params.userId,
                where: conjoinSessionListWhereInputs(
                    params.where,
                    createLegacyActiveSessionListWhere(params.now ?? Date.now()),
                ),
                orderBy: V2_ACTIVE_SESSION_LIST_ORDER_BY,
                take: activeRowsLimit,
                rowAdmission: params.rowAdmission,
                ...readAdmission,
            }))
            : Promise.resolve([]),
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
        activeRows,
        pageRows,
    }));

    const ownerAccountModes = await params.readOwnerAccountModes(
        mergedRows
            .filter((row) => requiresSessionMetadataOwnerAccountMode({
                session: row,
            }))
            .map((row) => row.accountId),
    );

    const discussionFacts = await params.readViewerDiscussionFacts(mergedRows);
    const otherNamedCollaboratorFacts = params.readOtherNamedCollaboratorFacts
        ? await params.readOtherNamedCollaboratorFacts(mergedRows)
        : undefined;

    return measurePage(() => ({
        ...mapV2SessionListRows({
            rows: mergedRows,
            userId: params.userId,
            ownerAccountModes,
            discussionFacts,
            otherNamedCollaboratorFacts,
            qualifiedTeamIds: params.source?.qualifiedTeamIds,
            accessMode: params.source?.accessMode,
            now: params.now,
        }),
        nextCursor: page.nextCursor,
        hasNext: page.hasNext,
        attentionNextCursor: attentionPage.attentionNextCursor,
        attentionHasNext: attentionPage.attentionHasNext,
        ...(includeActiveRows ? { includedActive: true } : {}),
    }));
}

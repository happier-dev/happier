import type { Prisma } from "@prisma/client";

import {
    createSessionPersonalAttentionQueryInTx,
} from "@/app/session/personal/queries";
import { captureReadSnapshot } from "@/storage/captureReadSnapshot";
import { resolveEffectiveSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import {
    requiresSessionMetadataOwnerAccountMode,
    type SessionMetadataOwnerAccountMode,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";

import {
    createV2SessionListRowPage,
    findV2SessionListCandidatePage,
    findV2SessionListRows,
    mapV2SessionListRows,
    type SessionListReadSource,
    type SessionListRowAdmission,
    V2_ACTIVE_SESSION_LIST_ORDER_BY,
    V2_ACTIVE_SESSION_LIST_ROW_LIMIT,
    V2_SESSION_LIST_ORDER_BY,
} from "./page";
import {
    type V2SessionCompactListRow as V2SessionListRowCompat,
} from "./rows";
import type { SessionPersonalDiscussionFacts } from "@/app/session/personal/discussionFacts";
import type { SessionRuleReadStates } from "@/app/session/personal/readState";
import {
    resolveV2SessionListInitialAttentionRowLimit,
    resolveV2SessionListCandidateWindowLimit,
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
    readLatestFailureSequences: (
        rows: ReadonlyArray<V2SessionListRowCompat>,
    ) => Promise<ReadonlyMap<string, number>>;
    readRuleReadStates?: (
        rows: ReadonlyArray<V2SessionListRowCompat>,
    ) => Promise<ReadonlyMap<string, SessionRuleReadStates>>;
    pageRows: ReadonlyArray<V2SessionListRowCompat>;
    page?: ReturnType<typeof createV2SessionListRowPage>;
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
        return await captureReadSnapshot(async (tx) => {
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
                    qualifiedTeamIds: access.qualifiedTeamIds,
                    collectiveAccessSnapshot: access.collectiveAccessSnapshot,
                    discussionReader: tx,
                },
                attentionWhere: params.attentionWhere ?? attention.candidateWhere,
                rowAdmission: params.rowAdmission ?? attention.admitRows,
                now,
            });
        });
    }
    const candidateLimit = params.candidateLimit ?? resolveV2SessionListInitialAttentionRowLimit();
    const examinationLimit = Math.max(candidateLimit, resolveV2SessionListCandidateWindowLimit(Boolean(params.cursor)));
    const measureQuery = params.timing?.measureQuery ?? (<T>(fn: () => Promise<T>) => fn());
    const measurePage = params.timing?.measurePage ?? (<T>(fn: () => T) => fn());
    const attentionWhere = params.attentionWhere;
    const rowAdmission = params.rowAdmission;
    const page = await measureQuery(() => findV2SessionListCandidatePage({
        userId: params.userId,
        where: conjoinSessionListWhereInputs(params.where, attentionWhere),
        cursor: params.cursor,
        orderBy: V2_SESSION_LIST_ORDER_BY,
        limit: candidateLimit,
        candidateLimit: examinationLimit,
        rowAdmission,
        onCandidatesExamined: params.timing?.recordCandidates,
        ...(params.source
            ? { source: params.source }
            : { authentication: params.authentication }),
    }));
    return measurePage(() => ({
        rows: [...page.rows],
        attentionNextCursor: page.nextCursor,
        attentionHasNext: page.hasNext,
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
    const page = params.page ?? measurePage(() => createV2SessionListRowPage({
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
    const latestFailureSequences = await params.readLatestFailureSequences(mergedRows);
    const ruleReadStates = await params.readRuleReadStates?.(mergedRows);
    const otherNamedCollaboratorFacts = params.readOtherNamedCollaboratorFacts
        ? await params.readOtherNamedCollaboratorFacts(mergedRows)
        : undefined;

    return measurePage(() => ({
        ...mapV2SessionListRows({
            rows: mergedRows,
            userId: params.userId,
            ownerAccountModes,
            discussionFacts,
            latestFailureSequences,
            ruleReadStates,
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

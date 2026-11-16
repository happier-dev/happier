import { decodeSessionStoredContent, withSessionContentSelect } from '@/storage/sessionMachineStoredContent';
import { conjoinSessionListWhereInputs } from "./query";
import { createAccountRecipientEnvelopeReadinessReadScope } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import type { Prisma } from "@prisma/client";

import { decodeV2SessionListCursorV1, decodeV2SessionListCursorV2, encodeV2SessionListCursorV2, type V2SessionListCursorV2 } from '@happier-dev/protocol/sessions/control/contract';
import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { captureReadSnapshot } from "@/storage/captureReadSnapshot";
import { buildSessionAccessWhere, resolveEffectiveSessionAccessWhere, type SessionCollectiveAccessSnapshot } from "@/app/session/access/sessionAccessWhere";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { resolveCurrentSessionRecipientAccountIdsBySessionInTx } from "@/app/session/access/sessionRecipients";
import {
    collectSessionTranscriptVisibleRowsBeforeTake,
    createSessionTranscriptPublicationActivityQueryBranches,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import type {
    SessionMetadataOwnerAccountMode,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import {
    isSessionMetadataPrivacyUpgradeRequiredError,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import { iterateBoundedSessionPersonalAttentionRows, SESSION_PERSONAL_ATTENTION_SCAN_BATCH_SIZE } from "@/app/session/personal/attentionQuery";
import type { SessionRuleReadStates } from "@/app/session/personal/readState";
import type { AccountFollowRuleProjectionRows } from "@/app/session/follow/accountFollowRuleService";
import {
    loadSessionPersonalDiscussionFactsInTx,
    QUIET_SESSION_PERSONAL_DISCUSSION_FACTS,
    type SessionPersonalDiscussionFacts,
} from "@/app/session/personal/discussionFacts";
import {
    createV2SessionCompactListRowSelect,
    getV2SessionListEffectiveActivityAt,
    mapV2SessionCompactListRow,
    type V2SessionCompactListRow as V2SessionListRowCompat,
    SESSION_LIST_PROJECTION_FALLBACK_COLUMNS,
} from "./rows";

type V2SessionListMeaningfulActivityCursor = Readonly<{
    sessionId: string;
    meaningfulActivityAt: number;
}>;

type SessionListRowSelect = ReturnType<typeof createV2SessionCompactListRowSelect>;

const SESSION_LIST_ACTIVITY_SELECT = {
    id: true,
    createdAt: true,
    meaningfulActivityAt: true,
    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} as const satisfies Prisma.SessionSelect;

type SessionListActivityRow = Prisma.SessionGetPayload<{ select: typeof SESSION_LIST_ACTIVITY_SELECT }>;

export type SessionListReadSource = Readonly<{
    kind: "effective";
    reader: Pick<Tx, "session" | "sessionPin" | "account">;
    baseWhere: Prisma.SessionWhereInput;
    /** The same predicate's compiled scope union; only ordered merges split it. */
    baseWhereBranches?: readonly Prisma.SessionWhereInput[];
    accessMode: "effective_access_v1" | "legacy_owner_or_direct";
    qualifiedTeamIds?: ReadonlySet<string>;
    collectiveAccessSnapshot?: SessionCollectiveAccessSnapshot;
    discussionReader?: Tx;
    ruleRows?: AccountFollowRuleProjectionRows;
}>;

export type SessionListRowAdmission = (
    rows: ReadonlyArray<V2SessionListRowCompat>,
) => Promise<ReadonlyArray<V2SessionListRowCompat>>;

type FindV2SessionListRowsParams = Readonly<{
    userId: string;
    orderBy: Prisma.SessionOrderByWithRelationInput | Prisma.SessionOrderByWithRelationInput[];
    take?: number;
    where?: Prisma.SessionWhereInput;
    cursor?: V2SessionListMeaningfulActivityCursor;
    rowAdmission?: SessionListRowAdmission;
}> & (
    | Readonly<{ source: SessionListReadSource }>
    | Readonly<{ source?: undefined; authentication: SessionAccessAuthentication }>
);

export async function findV2SessionListRows(params: FindV2SessionListRowsParams): Promise<V2SessionListRowCompat[]> {
    const { userId, orderBy, take, cursor } = params;
    const readFrom = async (reader: Pick<Tx, "session">, visibilityWhere: Prisma.SessionWhereInput, collectiveAccessSnapshot?: SessionCollectiveAccessSnapshot) => {
        const read = (
            select: SessionListRowSelect,
            page: Readonly<{ cursor?: V2SessionListMeaningfulActivityCursor; take?: number }> = {},
        ) => usesEffectiveActivityOrdering(orderBy)
            ? findV2SessionListRowsByEffectiveActivity({
                reader,
                select,
                visibilityWhere,
                visibilityWhereBranches: params.source?.baseWhereBranches,
                where: params.where,
                cursor: page.cursor ?? cursor,
                take: page.take ?? take,
                userId,
            })
            : findV2SessionListRowsWithSelect({ reader, orderBy, select, visibilityWhere, where: params.where, take, userId });
        const readWithAdmission = async (select: SessionListRowSelect) => {
            if (!params.rowAdmission) return await read(select);
            if (!usesEffectiveActivityOrdering(orderBy) || take === undefined) {
                return [...await params.rowAdmission(await read(select))];
            }
            if (!Number.isSafeInteger(take) || take <= 0) return [];

            const admitted: V2SessionListRowCompat[] = [];
            for await (const rows of iterateBoundedSessionPersonalAttentionRows({
                initialCursor: cursor,
                readCandidates: async (page) => await read(select, page),
                cursorAfter: (candidates) => {
                    const lastCandidate = candidates[candidates.length - 1];
                    if (!lastCandidate) throw new Error("Attention candidate scan produced an empty cursor page");
                    return {
                    sessionId: lastCandidate.id,
                    meaningfulActivityAt: getV2SessionListEffectiveActivityAt(lastCandidate).getTime(),
                    };
                },
                admitCandidates: params.rowAdmission,
            })) {
                admitted.push(...rows);
                if (admitted.length >= take) break;
            }
            return admitted.slice(0, take);
        };
        const projectionContext = { userId, mode: params.source?.accessMode, collectiveAccessSnapshot };
        return await readWithAdmission(createV2SessionCompactListRowSelect(projectionContext));
    };

    if (params.source) return await readFrom(params.source.reader, params.source.baseWhere, params.source.collectiveAccessSnapshot);
    return await captureReadSnapshot(async (tx) => {
        const access = await resolveEffectiveSessionAccessWhere({ tx, accountId: userId, capability: "readTranscript", mode: "effective_access_v1", authentication: params.authentication });
        return await readFrom(tx, access.where, access.collectiveAccessSnapshot);
    });
}

/**
 * One existing maximum-response-sized attention batch bounds admission work.
 * A short (even empty) exact page continues after the last examined candidate;
 * an output overflow instead continues after the last emitted row.
 */
export async function findV2SessionListCandidatePage(params: FindV2SessionListRowsParams & Readonly<{
    limit: number;
    candidateLimit?: number;
    onCandidatesExamined?: (count: number, limit: number) => void;
}>) {
    const candidateLimit = params.candidateLimit ?? Math.max(params.limit, SESSION_PERSONAL_ATTENTION_SCAN_BATCH_SIZE);
    const candidates = await findV2SessionListRows({ ...params, take: candidateLimit + 1, rowAdmission: undefined });
    const candidatePage = createV2SessionListRowPage({ rows: candidates, limit: candidateLimit });
    params.onCandidatesExamined?.(candidatePage.rows.length, candidateLimit);
    const admitted = params.rowAdmission ? [...await params.rowAdmission(candidatePage.rows)] : candidatePage.rows;
    if (admitted.length > params.limit) {
        const lastEmittedId = admitted[params.limit - 1]!.id;
        const lastEmittedIndex = candidates.findIndex(row => row.id === lastEmittedId);
        const continuation = createV2SessionListRowPage({ rows: candidates, limit: lastEmittedIndex + 1 });
        return { ...continuation, rows: admitted.slice(0, params.limit) };
    }
    return { ...candidatePage, rows: admitted };
}

export async function runWithSessionListProjectionFallback<T>(
    primary: () => Promise<T>,
    legacy: () => Promise<T>,
): Promise<T> {
    try {
        return await primary();
    } catch (error) {
        if (!isMissingAttentionProjectionColumnError(error)) throw error;
        return await legacy();
    }
}

async function findV2SessionListRowsWithSelect(params: Readonly<{
    reader: Pick<Tx, "session">;
    orderBy: Prisma.SessionOrderByWithRelationInput | Prisma.SessionOrderByWithRelationInput[];
    select: SessionListRowSelect;
    take?: number;
    userId: string;
    visibilityWhere: Prisma.SessionWhereInput;
    where?: Prisma.SessionWhereInput;
}>): Promise<V2SessionListRowCompat[]> {
    const { reader, orderBy, select, take, userId, visibilityWhere, where } = params;
    return await collectSessionTranscriptVisibleRowsBeforeTake({
        take,
        fetchPage: async (page) => await reader.session.findMany({
            where: conjoinSessionListWhereInputs(visibilityWhere, where),
            orderBy,
            ...(page.skip === undefined ? {} : { skip: page.skip }),
            ...(page.take === undefined ? {} : { take: page.take }),
            select: withSessionContentSelect(select),
        }).then(decodeSessionStoredContent),
        isOwner: (row) => row.accountId === userId,
        readPublication: (row) => row,
    });
}

export function mapV2SessionListRows(params: Readonly<{
    rows: ReadonlyArray<V2SessionListRowCompat>;
    userId: string;
    ownerAccountMode?: SessionMetadataOwnerAccountMode;
    ownerAccountModes?: ReadonlyMap<string, SessionMetadataOwnerAccountMode>;
    discussionFacts?: ReadonlyMap<string, SessionPersonalDiscussionFacts>;
    latestFailureSequences?: ReadonlyMap<string, number>;
    ruleReadStates?: ReadonlyMap<string, SessionRuleReadStates>;
    otherNamedCollaboratorFacts?: ReadonlyMap<string, boolean>;
    qualifiedTeamIds?: ReadonlySet<string>;
    accessMode?: "effective_access_v1" | "legacy_owner_or_direct";
    now?: number;
}>) {
    const sessions: ReturnType<typeof mapV2SessionCompactListRow>[] = [];
    const recipientReadiness = createAccountRecipientEnvelopeReadinessReadScope();
    let metadataUpgradeRequiredCount = 0;
    for (const row of params.rows) {
        try {
            sessions.push(mapV2SessionCompactListRow({
                row,
                recipientReadiness,
                userId: params.userId,
                ownerAccountMode: params.ownerAccountMode,
                ownerAccountModes: params.ownerAccountModes,
                discussionFacts: params.discussionFacts,
                latestFailureSequences: params.latestFailureSequences,
                ruleReadStates: params.ruleReadStates,
                hasOtherNamedCollaborator: params.otherNamedCollaboratorFacts?.get(row.id),
                qualifiedTeamIds: params.qualifiedTeamIds,
                accessMode: params.accessMode,
                now: params.now,
            }));
        } catch (error) {
            // A row whose owner has not migrated their metadata layout is a
            // per-row refusal, not a page-wide one: the reader's remaining rows
            // and both continuations stay usable while the count below keeps
            // the omission visible. Account-wide currentness failures are raised
            // before mapping and still refuse the request.
            if (!isSessionMetadataPrivacyUpgradeRequiredError(error)) throw error;
            metadataUpgradeRequiredCount += 1;
        }
    }
    return {
        sessions,
        ...(metadataUpgradeRequiredCount > 0 ? { metadataUpgradeRequiredCount } : {}),
    };
}

/** Projects one safe audience-existence bit; recipient identities stay server-internal. */
export async function readSessionListOtherNamedCollaboratorFacts(
    rows: ReadonlyArray<Readonly<{ id: string; accountId: string }>>,
    userId: string,
    reader: Tx = db,
): Promise<ReadonlyMap<string, boolean>> {
    const recipientsBySessionId = await resolveCurrentSessionRecipientAccountIdsBySessionInTx(reader, {
        sessionIds: rows.map((row) => row.id),
    });
    return new Map(rows.map((row) => [
        row.id,
        (recipientsBySessionId.get(row.id) ?? []).some((accountId) => accountId !== userId),
    ]));
}

/**
 * Loads this viewer's Lane 05 conversation facts for one page of rows.
 *
 * It mirrors `readSessionListOwnerAccountModes`: one bounded lookup per page,
 * composed beside the rows rather than per row, and always scoped to Sessions
 * the page reader already admitted through Lane 04 access.
 */
export async function readSessionListViewerDiscussionFacts(
    rows: ReadonlyArray<Readonly<{ id: string }>>,
    userId: string,
    reader: Tx = db,
    observedFacts?: ReadonlyMap<string, SessionPersonalDiscussionFacts>,
): Promise<ReadonlyMap<string, SessionPersonalDiscussionFacts>> {
    if (rows.length === 0) return new Map();
    const facts = new Map<string, SessionPersonalDiscussionFacts>();
    const missingRows: ReadonlyArray<Readonly<{ id: string }>> = rows.filter((row) => {
        const observed = observedFacts?.get(row.id);
        if (observed === undefined) return true;
        facts.set(row.id, observed);
        return false;
    });
    if (missingRows.length === 0) return facts;
    const loaded = await loadSessionPersonalDiscussionFactsInTx(reader, {
        accountId: userId,
        sessionIds: missingRows.map((row) => row.id),
    });
    for (const row of missingRows) {
        facts.set(row.id, loaded.get(row.id) ?? QUIET_SESSION_PERSONAL_DISCUSSION_FACTS);
    }
    return facts;
}

export const V2_SESSION_LIST_ORDER_BY = [
    { meaningfulActivityAt: "desc" as const },
    { id: "desc" as const },
] satisfies Prisma.SessionOrderByWithRelationInput[];

export const V2_ACTIVE_SESSION_LIST_ORDER_BY = [
    { lastActiveAt: "desc" as const },
    { id: "desc" as const },
] satisfies Prisma.SessionOrderByWithRelationInput[];

/**
 * Shared bound for both active-family readers. Active rows use last-active
 * ordering instead of the ordinary list cursor, so a smaller merge/default
 * bound could silently omit a live row with no later pagination path.
 */
export const V2_ACTIVE_SESSION_LIST_ROW_LIMIT = 500;

export function createV2SessionListPage(params: Readonly<{
    rows: ReadonlyArray<V2SessionListRowCompat>;
    userId: string;
    ownerAccountMode?: SessionMetadataOwnerAccountMode;
    ownerAccountModes?: ReadonlyMap<string, SessionMetadataOwnerAccountMode>;
    discussionFacts?: ReadonlyMap<string, SessionPersonalDiscussionFacts>;
    latestFailureSequences?: ReadonlyMap<string, number>;
    ruleReadStates?: ReadonlyMap<string, SessionRuleReadStates>;
    otherNamedCollaboratorFacts?: ReadonlyMap<string, boolean>;
    qualifiedTeamIds?: ReadonlySet<string>;
    accessMode?: "effective_access_v1" | "legacy_owner_or_direct";
    now?: number;
    limit: number;
}>) {
    const { userId } = params;
    const page = createV2SessionListRowPage(params);

    return {
        ...mapV2SessionListRows({
            rows: page.rows,
            userId,
            ownerAccountMode: params.ownerAccountMode,
            ownerAccountModes: params.ownerAccountModes,
            discussionFacts: params.discussionFacts,
            latestFailureSequences: params.latestFailureSequences,
            ruleReadStates: params.ruleReadStates,
            otherNamedCollaboratorFacts: params.otherNamedCollaboratorFacts,
            qualifiedTeamIds: params.qualifiedTeamIds,
            accessMode: params.accessMode,
            now: params.now,
        }),
        nextCursor: page.nextCursor,
        hasNext: page.hasNext,
    };
}

export function createV2SessionListRowPage(params: Readonly<{
    rows: ReadonlyArray<V2SessionListRowCompat>;
    limit: number;
}>) {
    const { rows, limit } = params;
    const hasNext = rows.length > limit;
    const resultRows = hasNext ? rows.slice(0, limit) : rows;
    const lastRow = resultRows[resultRows.length - 1] ?? null;
    const meaningfulActivityAt = lastRow
        ? getV2SessionListEffectiveActivityAt(lastRow).getTime()
        : 0;

    return {
        rows: resultRows,
        nextCursor: hasNext && lastRow
            ? encodeV2SessionListCursorV2({ sessionId: lastRow.id, meaningfulActivityAt })
            : null,
        hasNext,
    };
}

export function decodeV2SessionListCursor(cursor: string | null | undefined): string | null | undefined {
    if (!cursor) return undefined;
    return decodeV2SessionListCursorV1(cursor) ?? null;
}

export function decodeV2SessionListMeaningfulActivityCursor(
    cursor: string | null | undefined,
): V2SessionListCursorV2 | null | undefined {
    if (!cursor) return undefined;
    return decodeV2SessionListCursorV2(cursor) ?? null;
}

type ResolveV2SessionListCursorParams = Readonly<{
    cursor: string | null | undefined;
    userId: string;
    cursorRowWhere: Prisma.SessionWhereInput;
    rowAdmission?: SessionListRowAdmission;
}> & (
    | Readonly<{ source: SessionListReadSource }>
    | Readonly<{ source?: undefined; authentication: SessionAccessAuthentication }>
);

export async function resolveV2SessionListCursorForVisibleRows(params: ResolveV2SessionListCursorParams): Promise<V2SessionListMeaningfulActivityCursor | null | undefined> {
    const decoded = decodeV2SessionListMeaningfulActivityCursor(params.cursor);
    if (decoded !== null) return decoded;

    const legacySessionId = decodeV2SessionListCursor(params.cursor);
    if (legacySessionId === undefined || legacySessionId === null) return legacySessionId;

    const read = async (reader: Pick<Tx, "session">, visibilityWhere: Prisma.SessionWhereInput) => await reader.session.findFirst({
        where: conjoinSessionListWhereInputs(visibilityWhere, params.cursorRowWhere, { id: legacySessionId }),
        select: withSessionContentSelect({ id: true, createdAt: true, meaningfulActivityAt: true, ...SESSION_TRANSCRIPT_PUBLICATION_SELECT }),
    }).then(decodeSessionStoredContent);
    const row = params.rowAdmission
        ? (await findV2SessionListRows({
            userId: params.userId,
            where: conjoinSessionListWhereInputs(params.cursorRowWhere, { id: legacySessionId }),
            orderBy: { id: "desc" },
            take: 1,
            rowAdmission: params.rowAdmission,
            ...(params.source
                ? { source: params.source }
                : { authentication: params.authentication }),
        }))[0] ?? null
        : params.source
            ? await read(params.source.reader, params.source.baseWhere)
            : await captureReadSnapshot(async (tx) => await read(tx, await buildSessionAccessWhere({
                tx, accountId: params.userId, capability: "readTranscript", mode: "effective_access_v1", authentication: params.authentication,
            })));
    if (!row) return null;

    return {
        sessionId: row.id,
        meaningfulActivityAt: getV2SessionListEffectiveActivityAt(row).getTime(),
    };
}

async function findV2SessionListRowsByEffectiveActivity(params: Readonly<{
    reader: Pick<Tx, "session">;
    select: SessionListRowSelect;
    userId: string;
    visibilityWhere: Prisma.SessionWhereInput;
    visibilityWhereBranches?: readonly Prisma.SessionWhereInput[];
    where?: Prisma.SessionWhereInput;
    take?: number;
    cursor?: V2SessionListMeaningfulActivityCursor;
}>): Promise<V2SessionListRowCompat[]> {
    const { reader, select, userId, visibilityWhere, where, take, cursor } = params;
    const branchTake = typeof take === "number" ? take + 1 : undefined;
    const branchRows = await Promise.all(
        createSessionTranscriptPublicationActivityQueryBranches(
            cursor
                ? {
                    sessionId: cursor.sessionId,
                    activityAt: cursor.meaningfulActivityAt,
                }
                : cursor,
        ).flatMap((branch) => (params.visibilityWhereBranches ?? [visibilityWhere]).map(branchVisibility => collectSessionTranscriptVisibleRowsBeforeTake({
            take: branchTake,
            fetchPage: async (page) => await reader.session.findMany({
                where: conjoinSessionListWhereInputs(
                    branchVisibility,
                    where,
                    branch.where,
                    branch.cursorWhere,
                ),
                orderBy: [...branch.orderBy],
                ...(page.skip === undefined ? {} : { skip: page.skip }),
                ...(page.take === undefined ? {} : { take: page.take }),
                select: withSessionContentSelect(SESSION_LIST_ACTIVITY_SELECT),
            }).then(decodeSessionStoredContent),
            isOwner: (row) => row.accountId === userId,
            readPublication: (row) => row,
        }))),
    );

    const merged = mergeV2SessionListRowsByEffectiveActivity(branchRows.flat());
    const candidates = typeof take === "number" ? merged.slice(0, take) : merged;
    if (candidates.length === 0) return [];
    // The four publication/recency branches decide membership from this same
    // snapshot. Load private relations, envelopes and turns only for their
    // merged page, instead of repeating the full projection in every branch.
    const rows = await reader.session.findMany({
        where: { id: { in: candidates.map(row => row.id) } },
        select: withSessionContentSelect(select),
    }).then(decodeSessionStoredContent);
    const byId = new Map(rows.map(row => [row.id, row]));
    return candidates.map(candidate => {
        const row = byId.get(candidate.id);
        if (!row) throw new Error("Session listing snapshot lost a selected row");
        return row;
    });
}

function usesEffectiveActivityOrdering(
    orderBy: Prisma.SessionOrderByWithRelationInput | Prisma.SessionOrderByWithRelationInput[],
): boolean {
    if (!Array.isArray(orderBy) || orderBy.length !== V2_SESSION_LIST_ORDER_BY.length) {
        return false;
    }
    return orderBy[0]?.meaningfulActivityAt === "desc" && orderBy[1]?.id === "desc";
}

function mergeV2SessionListRowsByEffectiveActivity(
    rows: ReadonlyArray<SessionListActivityRow>,
): SessionListActivityRow[] {
    const merged = [...rows];
    merged.sort(compareV2SessionListRowsByEffectiveActivity);
    return merged;
}

function compareV2SessionListRowsByEffectiveActivity(a: SessionListActivityRow, b: SessionListActivityRow): number {
    const activityDiff = getV2SessionListEffectiveActivityAt(b).getTime() - getV2SessionListEffectiveActivityAt(a).getTime();
    if (activityDiff !== 0) {
        return activityDiff;
    }
    return b.id.localeCompare(a.id);
}

const MISSING_ROLLBACK_TURN_COLUMN_PATTERN = /SessionTurn|rollbackState/i;
const MISSING_SESSION_PROJECTION_COLUMN_PATTERN = SESSION_LIST_PROJECTION_FALLBACK_COLUMNS.length > 0
    ? new RegExp(SESSION_LIST_PROJECTION_FALLBACK_COLUMNS.join("|"), "i")
    : null;

export function isMissingAttentionProjectionColumnError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const record = error as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : "";
    const serialized = serializeProjectionError(error);
    if (code !== "P2022" && !/column|field|no such/i.test(serialized)) {
        return false;
    }
    return MISSING_ROLLBACK_TURN_COLUMN_PATTERN.test(serialized)
        || MISSING_SESSION_PROJECTION_COLUMN_PATTERN?.test(serialized) === true;
}

function serializeProjectionError(error: object): string {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : String(error);
    try {
        return `${message}\n${JSON.stringify(error)}`;
    } catch {
        return message;
    }
}

import type { Prisma } from "@prisma/client";

import {
    decodeV2SessionListCursorV1,
    decodeV2SessionListCursorV2,
    encodeV2SessionListCursorV2,
    type V2SessionListCursorV2,
} from "@happier-dev/protocol";
import { db } from "@/storage/db";
import {
    createV2SessionListLegacyRowSelect,
    createV2SessionListRowSelect,
    createV2SessionListVisibilityWhere,
    getV2SessionListEffectiveActivityAt,
    mapV2SessionListRow,
    type V2SessionListRowCompat,
} from "./v2SessionListRows";

type V2SessionListMeaningfulActivityCursor = Readonly<{
    sessionId: string;
    meaningfulActivityAt: number;
}>;

type V2SessionListCursorExtraction = Readonly<{
    baseWhere?: Prisma.SessionWhereInput;
    cursor?: V2SessionListMeaningfulActivityCursor;
}>;

export async function findV2SessionListRows(params: Readonly<{
    userId: string;
    orderBy: Prisma.SessionOrderByWithRelationInput | Prisma.SessionOrderByWithRelationInput[];
    take?: number;
    where?: Prisma.SessionWhereInput;
}>): Promise<V2SessionListRowCompat[]> {
    const { userId, orderBy, take, where } = params;
    const visibilityWhere = createV2SessionListVisibilityWhere({ userId });
    const select = createV2SessionListRowSelect({ userId });

    if (usesEffectiveActivityOrdering(orderBy)) {
        try {
            return await findV2SessionListRowsByEffectiveActivity({
                select,
                visibilityWhere,
                where,
                take,
                userId,
            });
        } catch (error) {
            if (!isMissingAttentionProjectionColumnError(error)) {
                throw error;
            }
            return await findV2SessionListRowsByEffectiveActivity({
                select: createV2SessionListLegacyRowSelect({ userId }),
                visibilityWhere,
                where,
                take,
                userId,
            });
        }
    }

    try {
        return await findV2SessionListRowsWithSelect({
            orderBy,
            select,
            visibilityWhere,
            where,
            take,
        });
    } catch (error) {
        if (!isMissingAttentionProjectionColumnError(error)) {
            throw error;
        }
        return await findV2SessionListRowsWithSelect({
            orderBy,
            select: createV2SessionListLegacyRowSelect({ userId }),
            visibilityWhere,
            where,
            take,
        });
    }
}

async function findV2SessionListRowsWithSelect(params: Readonly<{
    orderBy: Prisma.SessionOrderByWithRelationInput | Prisma.SessionOrderByWithRelationInput[];
    select: Prisma.SessionSelect;
    take?: number;
    visibilityWhere: Prisma.SessionWhereInput;
    where?: Prisma.SessionWhereInput;
}>): Promise<V2SessionListRowCompat[]> {
    const { orderBy, select, take, visibilityWhere, where } = params;
    return await db.session.findMany({
        where: {
            ...visibilityWhere,
            ...(where ?? {}),
        },
        orderBy,
        take,
        select,
    });
}

export function mapV2SessionListRows(params: Readonly<{ rows: ReadonlyArray<V2SessionListRowCompat>; userId: string }>) {
    return params.rows.map((row) => mapV2SessionListRow({ row, userId: params.userId }));
}

export const V2_SESSION_LIST_ORDER_BY = [
    { meaningfulActivityAt: "desc" as const },
    { id: "desc" as const },
] satisfies Prisma.SessionOrderByWithRelationInput[];

export function createV2SessionListPage(params: Readonly<{
    rows: ReadonlyArray<V2SessionListRowCompat>;
    userId: string;
    limit: number;
}>) {
    const { rows, userId, limit } = params;
    const hasNext = rows.length > limit;
    const resultRows = hasNext ? rows.slice(0, limit) : rows;
    const lastRow = resultRows[resultRows.length - 1] ?? null;
    const meaningfulActivityAt = lastRow
        ? getV2SessionListEffectiveActivityAt(lastRow).getTime()
        : 0;

    return {
        sessions: mapV2SessionListRows({ rows: resultRows, userId }),
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

export async function resolveV2SessionListCursorForVisibleRows(params: Readonly<{
    cursor: string | null | undefined;
    userId: string;
    cursorRowWhere: Prisma.SessionWhereInput;
}>): Promise<V2SessionListMeaningfulActivityCursor | null | undefined> {
    const decoded = decodeV2SessionListMeaningfulActivityCursor(params.cursor);
    if (decoded !== null) return decoded;

    const legacySessionId = decodeV2SessionListCursor(params.cursor);
    if (legacySessionId === undefined || legacySessionId === null) return legacySessionId;

    const row = await db.session.findFirst({
        where: {
            ...createV2SessionListVisibilityWhere({ userId: params.userId }),
            ...params.cursorRowWhere,
            id: legacySessionId,
        },
        select: { id: true, createdAt: true, meaningfulActivityAt: true },
    });
    if (!row) return null;

    return {
        sessionId: row.id,
        meaningfulActivityAt: getV2SessionListEffectiveActivityAt(row).getTime(),
    };
}

export function createV2SessionListCursorWhere(
    cursor: V2SessionListMeaningfulActivityCursor | null | undefined,
): Prisma.SessionWhereInput {
    if (!cursor) return {};
    const cursorActivityAt = new Date(cursor.meaningfulActivityAt);
    return {
        AND: [{
            OR: [
                { meaningfulActivityAt: { lt: cursorActivityAt } },
                { meaningfulActivityAt: cursorActivityAt, id: { lt: cursor.sessionId } },
            ],
        }],
    };
}

async function findV2SessionListRowsByEffectiveActivity(params: Readonly<{
    select: Prisma.SessionSelect;
    userId: string;
    visibilityWhere: Prisma.SessionWhereInput;
    where?: Prisma.SessionWhereInput;
    take?: number;
}>): Promise<V2SessionListRowCompat[]> {
    const { select, visibilityWhere, where, take } = params;
    const { baseWhere, cursor } = extractV2SessionListCursor(where);
    const branchTake = typeof take === "number" ? take + 1 : undefined;

    const [meaningfulRows, createdAtFallbackRows] = await Promise.all([
        db.session.findMany({
            where: mergeSessionWhereInputs(
                {
                    ...visibilityWhere,
                    ...(baseWhere ?? {}),
                    meaningfulActivityAt: { not: null },
                },
                createV2SessionListCursorWhere(cursor),
            ),
            orderBy: V2_SESSION_LIST_ORDER_BY,
            take: branchTake,
            select,
        }),
        db.session.findMany({
            where: mergeSessionWhereInputs(
                {
                    ...visibilityWhere,
                    ...(baseWhere ?? {}),
                    meaningfulActivityAt: null,
                },
                createV2SessionListCreatedAtCursorWhere(cursor),
            ),
            orderBy: V2_SESSION_LIST_CREATED_AT_FALLBACK_ORDER_BY,
            take: branchTake,
            select,
        }),
    ]);

    const merged = mergeV2SessionListRowsByEffectiveActivity(meaningfulRows, createdAtFallbackRows);
    return typeof take === "number" ? merged.slice(0, take) : merged;
}

const V2_SESSION_LIST_CREATED_AT_FALLBACK_ORDER_BY = [
    { createdAt: "desc" as const },
    { id: "desc" as const },
] satisfies Prisma.SessionOrderByWithRelationInput[];

function usesEffectiveActivityOrdering(
    orderBy: Prisma.SessionOrderByWithRelationInput | Prisma.SessionOrderByWithRelationInput[],
): boolean {
    if (!Array.isArray(orderBy) || orderBy.length !== V2_SESSION_LIST_ORDER_BY.length) {
        return false;
    }
    return orderBy[0]?.meaningfulActivityAt === "desc" && orderBy[1]?.id === "desc";
}

function createV2SessionListCreatedAtCursorWhere(
    cursor: V2SessionListMeaningfulActivityCursor | null | undefined,
): Prisma.SessionWhereInput {
    if (!cursor) return {};
    const cursorActivityAt = new Date(cursor.meaningfulActivityAt);
    return {
        AND: [{
            OR: [
                { createdAt: { lt: cursorActivityAt } },
                { createdAt: cursorActivityAt, id: { lt: cursor.sessionId } },
            ],
        }],
    };
}

function mergeV2SessionListRowsByEffectiveActivity(
    meaningfulRows: ReadonlyArray<V2SessionListRowCompat>,
    createdAtFallbackRows: ReadonlyArray<V2SessionListRowCompat>,
): V2SessionListRowCompat[] {
    const merged = [...meaningfulRows, ...createdAtFallbackRows];
    merged.sort(compareV2SessionListRowsByEffectiveActivity);
    return merged;
}

function compareV2SessionListRowsByEffectiveActivity(a: V2SessionListRowCompat, b: V2SessionListRowCompat): number {
    const activityDiff = getV2SessionListEffectiveActivityAt(b).getTime() - getV2SessionListEffectiveActivityAt(a).getTime();
    if (activityDiff !== 0) {
        return activityDiff;
    }
    return b.id.localeCompare(a.id);
}

function extractV2SessionListCursor(where?: Prisma.SessionWhereInput): V2SessionListCursorExtraction {
    if (!where) {
        return {};
    }

    const andClauses = normalizeWhereClauses(where.AND);
    const cursorClauseIndex = andClauses.findIndex((clause) => parseV2SessionListCursorClause(clause) !== undefined);
    if (cursorClauseIndex === -1) {
        return { baseWhere: where };
    }

    const cursorClause = andClauses[cursorClauseIndex];
    const cursor = cursorClause ? parseV2SessionListCursorClause(cursorClause) : undefined;
    const { AND: _ignoredAnd, ...restWhere } = where;
    const remainingAndClauses = andClauses.filter((_, index) => index !== cursorClauseIndex);

    return {
        cursor,
        baseWhere: remainingAndClauses.length > 0
            ? { ...restWhere, AND: remainingAndClauses }
            : restWhere,
    };
}

function normalizeWhereClauses(value: Prisma.SessionWhereInput["AND"]): Prisma.SessionWhereInput[] {
    if (!value) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

function parseV2SessionListCursorClause(clause: Prisma.SessionWhereInput): V2SessionListMeaningfulActivityCursor | undefined {
    const orClauses = normalizeWhereClauses(clause.OR);
    if (orClauses.length !== 2) {
        return undefined;
    }

    const lessThanClause = orClauses
        .map(readMeaningfulActivityLessThanDate)
        .find((value): value is Date => value instanceof Date);
    const equalityClause = orClauses
        .map(readMeaningfulActivityEqualityCursor)
        .find((value): value is { sessionId: string; meaningfulActivityAt: Date } => value !== undefined);

    if (!lessThanClause || !equalityClause) {
        return undefined;
    }
    if (lessThanClause.getTime() !== equalityClause.meaningfulActivityAt.getTime()) {
        return undefined;
    }

    return {
        sessionId: equalityClause.sessionId,
        meaningfulActivityAt: equalityClause.meaningfulActivityAt.getTime(),
    };
}

function readMeaningfulActivityLessThanDate(clause: Prisma.SessionWhereInput): Date | undefined {
    const meaningfulActivityAt = readObjectProperty(clause, "meaningfulActivityAt");
    if (!meaningfulActivityAt || meaningfulActivityAt instanceof Date) {
        return undefined;
    }
    const lessThan = readObjectProperty(meaningfulActivityAt, "lt");
    return lessThan instanceof Date ? lessThan : undefined;
}

function readMeaningfulActivityEqualityCursor(
    clause: Prisma.SessionWhereInput,
): { sessionId: string; meaningfulActivityAt: Date } | undefined {
    const meaningfulActivityAt = readObjectProperty(clause, "meaningfulActivityAt");
    const id = readObjectProperty(clause, "id");
    if (!(meaningfulActivityAt instanceof Date) || !id || id instanceof Date) {
        return undefined;
    }
    const sessionId = readObjectProperty(id, "lt");
    if (typeof sessionId !== "string") {
        return undefined;
    }
    return {
        sessionId,
        meaningfulActivityAt,
    };
}

function readObjectProperty(value: unknown, key: string): unknown {
    return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function mergeSessionWhereInputs(
    baseWhere: Prisma.SessionWhereInput,
    extraWhere: Prisma.SessionWhereInput,
): Prisma.SessionWhereInput {
    const baseAnd = normalizeWhereClauses(baseWhere.AND);
    const extraAnd = normalizeWhereClauses(extraWhere.AND);
    const { AND: _baseAnd, ...baseRest } = baseWhere;
    const { AND: _extraAnd, ...extraRest } = extraWhere;
    const mergedAnd = [...baseAnd, ...extraAnd];

    return mergedAnd.length > 0
        ? { ...baseRest, ...extraRest, AND: mergedAnd }
        : { ...baseRest, ...extraRest };
}

export function isMissingAttentionProjectionColumnError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const record = error as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : "";
    const message = typeof record.message === "string" ? record.message : String(error);
    if (code !== "P2022" && !/column|field|no such/i.test(message)) {
        return false;
    }
    return /pendingRequestObservedAt|latestReadyEventSeq|latestReadyEventAt|thinkingAt|thinking|SessionTurn|rollbackState|turns/i.test(message);
}

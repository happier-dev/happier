import type { Prisma } from "@prisma/client";

import {
    decodeV2SessionListCursorV1,
    decodeV2SessionListCursorV2,
    encodeV2SessionListCursorV2,
    readConnectedServiceReaderSupport,
    type ConnectedServiceId,
} from "@happier-dev/protocol";
import { db } from "@/storage/db";
import {
    createSessionSharedWithUserWhere,
    createV2SessionListVisibilityWhere,
    createV2SessionListLegacyRowSelect,
    createV2SessionListRowSelect,
    getV2SessionListEffectiveActivityAt,
    mapV2SessionListRow,
    projectSessionRowsForReader,
    SESSION_LIST_PROJECTION_FALLBACK_COLUMNS,
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

/**
 * The viewer's visibility arms, resolved at most once however many list reads ask for them.
 *
 * The arms cost a `SessionShare` statement, and they are a property of the *viewer*, not of the read:
 * every effective-activity read in one request resolves the identical set. Before this, each read
 * resolved its own — the merged initial page issued two for one request (its page read and its
 * attention read), and a request that fell back to the legacy projection issued another for the retry.
 *
 * Memoised on the promise rather than the value so concurrent reads share the one in-flight
 * statement, and lazily so a request whose reads all bind a `Session` key (pinned rows, the active
 * family) still issues none at all.
 */
export type V2SessionListVisibilityArmsReader = () => Promise<ReadonlyArray<Prisma.SessionWhereInput>>;

export function createV2SessionListVisibilityArmsReader(userId: string): V2SessionListVisibilityArmsReader {
    let inFlight: Promise<ReadonlyArray<Prisma.SessionWhereInput>> | null = null;
    return () => (inFlight ??= resolveV2SessionListVisibilityWhereArms({ userId }));
}

export async function findV2SessionListRows(params: Readonly<{
    userId: string;
    orderBy: Prisma.SessionOrderByWithRelationInput | Prisma.SessionOrderByWithRelationInput[];
    take?: number;
    where?: Prisma.SessionWhereInput;
    /**
     * The request's shared visibility-arm reader. Omitted, this read resolves its own arms, which is
     * correct but costs a statement per read.
     */
    visibilityArms?: V2SessionListVisibilityArmsReader;
    /**
     * The predicate to retry with when the primary read fails because the connected schema is older
     * than this binary. Defaults to `where`, which is correct for every read whose predicate names
     * only columns the old schema already has.
     *
     * A caller that *filters* on a column the legacy projection had to drop must supply this, or the
     * retry re-issues the same failing statement and the fallback cannot help: the legacy select
     * alone only fixes what the read asks the database to *return*, not what it asks it to *match*.
     *
     * Built on demand so the compatibility predicate stays cold: a healthy schema never constructs
     * it, and it may therefore depend on things only a real read has, such as a Prisma field
     * reference for a column-to-column comparison.
     */
    legacyWhere?: () => Prisma.SessionWhereInput;
}>): Promise<V2SessionListRowCompat[]> {
    const { userId, orderBy, take, where, legacyWhere } = params;
    const visibilityArms = params.visibilityArms ?? createV2SessionListVisibilityArmsReader(userId);

    return await runWithSessionListProjectionFallback(
        () => findV2SessionListRowsWithSelect({
            orderBy,
            select: createV2SessionListRowSelect({ userId }),
            take,
            userId,
            visibilityArms,
            where,
        }),
        () => findV2SessionListRowsWithSelect({
            orderBy,
            select: createV2SessionListLegacyRowSelect({ userId }),
            take,
            userId,
            visibilityArms,
            where: legacyWhere ? legacyWhere() : where,
        }),
    );
}

export async function runWithSessionListProjectionFallback<T>(
    primary: () => Promise<T>,
    legacy: () => Promise<T>,
): Promise<T> {
    try {
        return await primary();
    } catch (error) {
        if (!isMissingSessionProjectionColumnError(error)) {
            throw error;
        }
        return await legacy();
    }
}

/**
 * Recognise the failure a binary running ahead of `prisma migrate deploy` gets when it asks the old
 * schema for a column the primary projection added, so the legacy projection can answer instead of
 * the request failing outright.
 *
 * The column half of the match is derived from the projections themselves
 * (`SESSION_LIST_PROJECTION_FALLBACK_COLUMNS`); a hand-maintained list is what let `unreadSince`
 * enter the projection without ever being recognised here.
 */
const MISSING_SESSION_PROJECTION_COLUMN_PATTERN = SESSION_LIST_PROJECTION_FALLBACK_COLUMNS.length > 0
    ? new RegExp(SESSION_LIST_PROJECTION_FALLBACK_COLUMNS.join("|"), "i")
    : null;

export function isMissingSessionProjectionColumnError(error: unknown): boolean {
    if (!MISSING_SESSION_PROJECTION_COLUMN_PATTERN) return false;
    const text = JSON.stringify(error, (_key, value) => value instanceof Error ? { message: value.message, name: value.name } : value);
    return MISSING_SESSION_PROJECTION_COLUMN_PATTERN.test(text)
        && /column|field|P2022|no such/i.test(text);
}

export async function findV2SessionListRowById(params: Readonly<{
    userId: string;
    sessionId: string;
}>): Promise<V2SessionListRowCompat | null> {
    const { userId, sessionId } = params;
    const visibilityWhere = createV2SessionListVisibilityWhere({ userId });

    return await runWithSessionListProjectionFallback(
        () => findV2SessionListRowByIdWithSelect({
            userId,
            sessionId,
            visibilityWhere,
            select: createV2SessionListRowSelect({ userId, pendingBlockedNoEffectCountSessionId: sessionId }),
        }),
        () => findV2SessionListRowByIdWithSelect({
            userId,
            sessionId,
            visibilityWhere,
            select: createV2SessionListLegacyRowSelect({ userId, pendingBlockedNoEffectCountSessionId: sessionId }),
        }),
    );
}

async function findV2SessionListRowByIdWithSelect(params: Readonly<{
    userId: string;
    sessionId: string;
    visibilityWhere: Prisma.SessionWhereInput;
    select: Prisma.SessionSelect;
}>): Promise<V2SessionListRowCompat | null> {
    const { sessionId, visibilityWhere, select } = params;
    return await db.session.findFirst({
        where: {
            ...visibilityWhere,
            id: sessionId,
        },
        select,
    }) as V2SessionListRowCompat | null;
}

async function findV2SessionListRowsWithSelect(params: Readonly<{
    userId: string;
    orderBy: Prisma.SessionOrderByWithRelationInput | Prisma.SessionOrderByWithRelationInput[];
    select: Prisma.SessionSelect;
    take?: number;
    visibilityArms: V2SessionListVisibilityArmsReader;
    where?: Prisma.SessionWhereInput;
}>): Promise<V2SessionListRowCompat[]> {
    const { orderBy, select, take, userId, where } = params;

    if (usesEffectiveActivityOrdering(orderBy)) {
        return await findV2SessionListRowsByEffectiveActivity({
            select,
            visibilityArms: await params.visibilityArms(),
            where,
            take,
        });
    }

    // Orderings other than the effective-activity one are already selective on their own
    // (`id IN (…)` for pinned rows, the active-session window for `lastActiveAt`), so the
    // disjunction costs nothing there and the single statement stays simpler.
    return await db.session.findMany({
        where: {
            ...createV2SessionListVisibilityWhere({ userId }),
            ...(where ?? {}),
        },
        orderBy,
        take,
        select,
    }) as V2SessionListRowCompat[];
}

export function mapV2SessionListRows(params: Readonly<{ rows: ReadonlyArray<V2SessionListRowCompat>; userId: string }>) {
    return params.rows.map((row) => mapV2SessionListRow({ row, userId: params.userId }));
}

export const V2_SESSION_LIST_ORDER_BY = [
    { meaningfulActivityAt: "desc" as const },
    { id: "desc" as const },
] satisfies Prisma.SessionOrderByWithRelationInput[];

/**
 * How long after its last heartbeat a session still counts as active.
 *
 * A daemon that stops reporting leaves `active = true` behind, so the window — not the flag alone —
 * is what makes the family finite.
 */
export const ACTIVE_SESSION_WINDOW_MS = 1000 * 60 * 15;

export const V2_ACTIVE_SESSION_LIST_ORDER_BY = [
    { lastActiveAt: "desc" as const },
    { id: "desc" as const },
] satisfies Prisma.SessionOrderByWithRelationInput[];

/**
 * How many active-session rows either reader of the family may return.
 *
 * The family's real bound is `ACTIVE_SESSION_WINDOW_MS`, not a row count: a session leaves it by
 * ceasing to heartbeat. This count is the backstop on top of that window, and it belongs beside the
 * predicate for the same reason the predicate does — the two readers had already drifted apart once
 * (`archivedAt`), and they had drifted apart again here: the merged initial page took 500 while this
 * endpoint silently truncated an unqualified request at 150.
 *
 * It is deliberately far above any plausible active count (66 on the reference account, against
 * ~2,900 sessions) rather than tuned down toward what a screen paints. The client renders **every**
 * active session in the list's top "Active" section — there is no client-side cap, and no path that
 * backfills a row this family omitted, because the cursor page is ordered by `meaningfulActivityAt`
 * and a session can be live on a machine with its last meaningful activity weeks old. So a bound
 * below the account's true active count does not ship fewer bytes for a normal account; it deletes a
 * live session from the list of the one account large enough to reach it.
 */
export const V2_ACTIVE_SESSION_LIST_ROW_LIMIT = 500;

/**
 * The active-session-row predicate, defined once for both readers of the family: the standalone
 * `GET /v2/sessions/active` endpoint and the `includeActive` branch of the initial session-list page.
 * Two copies is exactly how the endpoint lost its `archivedAt` conjunct while every other list read
 * kept it, which injected archived sessions into the client's session list.
 *
 * `archivedAt IS NULL` is the same visibility conjunct the paged, attention and pinned reads carry:
 * archiving removes a session from the list, and being live on a machine does not undo that.
 */
export function createV2ActiveSessionListRowsWhere(
    now: Date = new Date(),
): Prisma.SessionWhereInput {
    return {
        archivedAt: null,
        active: true,
        lastActiveAt: { gt: resolveActiveSessionHeartbeatFloor(now) },
    };
}

function resolveActiveSessionHeartbeatFloor(now: Date): Date {
    return new Date(now.getTime() - ACTIVE_SESSION_WINDOW_MS);
}

/**
 * The same membership test, asked of a row this request already holds instead of of the database.
 *
 * It exists so the merged initial page can recognise the family rows its page read already returned
 * and stop the active read from fetching them a second time. Sharing
 * `resolveActiveSessionHeartbeatFloor` with the predicate above is what keeps the two spellings from
 * being two answers: the window is defined once, and the caller passes one `now` to both, so an
 * in-flight heartbeat cannot land between them and put a row in one half and not the other.
 * `v2SessionListInitialPage.activeRows.sqlite.integration.spec.ts` pins the agreement against a real
 * database — an archived, aged-out or inactive row would break it.
 */
export function isV2ActiveSessionListRow(
    row: Pick<V2SessionListRowCompat, "archivedAt" | "active" | "lastActiveAt">,
    now: Date,
): boolean {
    return row.archivedAt === null
        && row.active
        && row.lastActiveAt.getTime() > resolveActiveSessionHeartbeatFloor(now).getTime();
}

/**
 * `V2_ACTIVE_SESSION_LIST_ORDER_BY` as an in-memory comparator, for the same reason: the merged page
 * concatenates the family rows it already held with the ones it read, and the result must be the
 * sequence the single read produced. Kept beside the ordering it mirrors so they cannot drift.
 */
export function compareV2ActiveSessionListRows(
    a: Pick<V2SessionListRowCompat, "id" | "lastActiveAt">,
    b: Pick<V2SessionListRowCompat, "id" | "lastActiveAt">,
): number {
    const heartbeatOrder = b.lastActiveAt.getTime() - a.lastActiveAt.getTime();
    if (heartbeatOrder !== 0) return heartbeatOrder;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Where a page ends and how the next one is asked for — the paging contract on its own, with no wire
 * records built.
 *
 * The initial-page branch needs exactly this and not the mapped rows: its response body carries the
 * *merged* row set, so any records built from the page rows here would be discarded. Separating the
 * two keeps one owner of `hasNext`/`nextCursor` while letting that caller map each row once.
 */
export function resolveV2SessionListPageBounds(params: Readonly<{
    rows: ReadonlyArray<V2SessionListRowCompat>;
    limit: number;
}>): Readonly<{
    resultRows: ReadonlyArray<V2SessionListRowCompat>;
    nextCursor: string | null;
    hasNext: boolean;
}> {
    const { rows, limit } = params;
    const hasNext = rows.length > limit;
    const resultRows = hasNext ? rows.slice(0, limit) : rows;
    const lastRow = resultRows[resultRows.length - 1] ?? null;
    const meaningfulActivityAt = lastRow
        ? getV2SessionListEffectiveActivityAt(lastRow).getTime()
        : 0;

    return {
        resultRows,
        nextCursor: hasNext && lastRow
            ? encodeV2SessionListCursorV2({ sessionId: lastRow.id, meaningfulActivityAt })
            : null,
        hasNext,
    };
}

export function createV2SessionListPage(params: Readonly<{
    rows: ReadonlyArray<V2SessionListRowCompat>;
    userId: string;
    limit: number;
    supportedConnectedServiceIds?: readonly ConnectedServiceId[];
}>) {
    const { resultRows, nextCursor, hasNext } = resolveV2SessionListPageBounds(params);

    return {
        sessions: projectSessionRowsForReader(mapV2SessionListRows({ rows: resultRows, userId: params.userId }),
            params.supportedConnectedServiceIds ?? readConnectedServiceReaderSupport(undefined)),
        nextCursor,
        hasNext,
    };
}

export function decodeV2SessionListCursor(cursor: string | null | undefined): string | null | undefined {
    if (!cursor) return undefined;
    return decodeV2SessionListCursorV1(cursor) ?? null;
}

export function decodeV2SessionListMeaningfulActivityCursor(
    cursor: string | null | undefined,
): V2SessionListMeaningfulActivityCursor | null | undefined {
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

/**
 * How many shared session ids one visibility arm may bind.
 *
 * The shared arm is a keyed read, so each id is a bind parameter, and every engine caps how many one
 * statement may carry. Prisma's SQLite budget is the tightest at 999 per statement and is shared
 * with the caller's own predicate, which is why this leaves half of it free. Prisma normally splits
 * an oversized `IN` itself, but the session-list branches carry `meaningfulActivityAt: { not: null }`
 * and a negation filter makes that split impossible — the read then fails outright rather than
 * degrading (reproduced on SQLite: 999 ids succeed, 1,000 raise
 * "Query parameter limit exceeded … the negation filters used prevent the query from being split").
 *
 * Spreading the ids over several arms costs nothing, because the arms are *already* a union that
 * `findV2SessionListRowsByEffectiveActivity` merges, de-duplicates and re-slices to the caller's
 * limit: any partition of the shared set yields the same page. Pinned by
 * `v2SessionListPage.visibilityArms.sqlite.integration.spec.ts`.
 */
const SHARED_SESSION_ID_ARM_CHUNK_SIZE = 500;

/**
 * The session-list visibility predicate for an ordered list read, as the independent arms it is the
 * union of. `createV2SessionListVisibilityWhere` is the same predicate OR'd back together, for
 * callers that already bind a `Session` key.
 *
 * Splitting the disjunction is only half of it: a `shares` relation filter binds no `Session` key
 * either, so the shared arm was a whole-table read even after the split. Prisma emits it as a
 * correlated `EXISTS (SELECT … FROM SessionShare WHERE sessionId = Session.id AND
 * sharedWithUserId = ?)`, which SQLite answers with `SCAN Session` plus `USE TEMP B-TREE FOR ORDER
 * BY` — every session on the server read and sorted to find the handful shared with one viewer.
 * PostgreSQL and MySQL hide it (`relationJoins` lets them drive from the tiny `SessionShare` side),
 * so it was visible only on the SQLite deployments, which is where it hurt most.
 *
 * Resolving the shared ids from `SessionShare(sharedWithUserId)` first inverts that: the small,
 * selective side drives and `Session` is then read by primary key. It also lets the arm disappear
 * entirely for a viewer with no shares — the overwhelmingly common case — instead of issuing a
 * statement that can only scan and return nothing.
 *
 * Share membership itself is defined once, by `createSessionSharedWithUserWhere`, so this and the
 * relation filter cannot drift apart.
 */
export async function resolveV2SessionListVisibilityWhereArms(
    params: Readonly<{ userId: string }>,
): Promise<Prisma.SessionWhereInput[]> {
    const shares = await db.sessionShare.findMany({
        where: createSessionSharedWithUserWhere(params.userId),
        select: { sessionId: true },
    });

    const arms: Prisma.SessionWhereInput[] = [{ accountId: params.userId }];
    for (let start = 0; start < shares.length; start += SHARED_SESSION_ID_ARM_CHUNK_SIZE) {
        arms.push({
            id: { in: shares.slice(start, start + SHARED_SESSION_ID_ARM_CHUNK_SIZE).map((share) => share.sessionId) },
        });
    }
    return arms;
}

/**
 * Answer an effective-activity-ordered list read as one index-seekable statement per
 * (visibility arm x activity branch), merged in memory.
 *
 * **Why the split is safe.** The branches partition nothing away: their union is exactly the rows
 * the single OR'd statement matched, and the ordering (`meaningfulActivityAt`/`createdAt` desc, then
 * `id` desc) is total because `id` is unique. Every branch is therefore a subset of that union and
 * is asked for its own top-`take`, so any row inside the *global* top-`take` is also inside its own
 * branch's top-`take` and cannot be missed. Merging, de-duplicating and re-slicing to `take` yields
 * exactly the global top-`take`.
 *
 * That identity is what makes the merged page the same page the single statement returned, so the
 * attention read is complete up to its limit rather than short by a branch's budget.
 *
 * De-duplication is required now that the arms can overlap — a session owned by the viewer can also
 * be shared with the viewer — where the activity branches alone were disjoint.
 */
async function findV2SessionListRowsByEffectiveActivity(params: Readonly<{
    visibilityArms: ReadonlyArray<Prisma.SessionWhereInput>;
    select: Prisma.SessionSelect;
    where?: Prisma.SessionWhereInput;
    take?: number;
}>): Promise<V2SessionListRowCompat[]> {
    const { select, visibilityArms, where, take } = params;
    const { baseWhere, cursor } = extractV2SessionListCursor(where);
    const branchTake = typeof take === "number" ? take + 1 : undefined;

    // The visibility arm is AND-nested rather than spread, so a caller-supplied `where` can never
    // silently overwrite it the way a top-level key collision would.
    const branchWhere = (
        activityWhere: Prisma.SessionWhereInput,
        cursorWhere: Prisma.SessionWhereInput,
        visibilityArm: Prisma.SessionWhereInput,
    ): Prisma.SessionWhereInput => mergeSessionWhereInputs(
        { ...(baseWhere ?? {}), ...activityWhere },
        mergeSessionWhereInputs({ AND: [visibilityArm] }, cursorWhere),
    );

    const branches = visibilityArms.flatMap((visibilityArm) => [
        {
            where: branchWhere(
                { meaningfulActivityAt: { not: null } },
                createV2SessionListCursorWhere(cursor),
                visibilityArm,
            ),
            orderBy: V2_SESSION_LIST_ORDER_BY,
        },
        {
            where: branchWhere(
                { meaningfulActivityAt: null },
                createV2SessionListCreatedAtCursorWhere(cursor),
                visibilityArm,
            ),
            orderBy: V2_SESSION_LIST_CREATED_AT_FALLBACK_ORDER_BY,
        },
    ]);

    const branchRows = await Promise.all(branches.map(async (branch) => {
        const rows = await db.session.findMany({
            where: branch.where,
            orderBy: branch.orderBy,
            take: branchTake,
            select,
        });
        return rows as V2SessionListRowCompat[];
    }));

    const merged = mergeV2SessionListRowsByEffectiveActivity(branchRows);
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
    branchRows: ReadonlyArray<ReadonlyArray<V2SessionListRowCompat>>,
): V2SessionListRowCompat[] {
    const rowsById = new Map<string, V2SessionListRowCompat>();
    for (const rows of branchRows) {
        for (const row of rows) {
            if (!rowsById.has(row.id)) rowsById.set(row.id, row);
        }
    }
    const merged = [...rowsById.values()];
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
        baseWhere: remainingAndClauses.length > 0 ? { ...restWhere, AND: remainingAndClauses } : restWhere,
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

/**
 * Conjoin two session predicates without either losing an `AND` clause the other also carries — the
 * silent overwrite a plain object spread produces when both sides hold one.
 */
export function mergeSessionWhereInputs(
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

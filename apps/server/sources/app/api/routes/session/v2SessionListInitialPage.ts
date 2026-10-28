import type { Prisma } from "@prisma/client";

import { db } from "@/storage/db";
import {
    isSessionUnread,
    reconcileObservedSessionUnreadSince,
} from "@/app/session/attention/sessionAttentionFacts";
import {
    compareV2ActiveSessionListRows,
    createV2ActiveSessionListRowsWhere,
    createV2SessionListCursorWhere,
    findV2SessionListRows,
    isV2ActiveSessionListRow,
    mapV2SessionListRows,
    mergeSessionWhereInputs,
    resolveV2SessionListPageBounds,
    V2_ACTIVE_SESSION_LIST_ORDER_BY,
    V2_ACTIVE_SESSION_LIST_ROW_LIMIT,
    V2_SESSION_LIST_ORDER_BY,
    type V2SessionListVisibilityArmsReader,
} from "./v2SessionListPage";
import {
    getV2SessionListEffectiveActivityAt,
    parseStoredSessionLatestTurnStatus,
    parseStoredSessionRuntimeIssue,
    type V2SessionListRowCompat,
} from "./v2SessionListRows";
import type { V2SessionListInitialPageTiming } from "./v2SessionListServerTiming";

type V2SessionListInitialPageParams = Readonly<{
    userId: string;
    pageRows: ReadonlyArray<V2SessionListRowCompat>;
    limit: number;
    pinnedSessionIds: readonly string[];
    requiredSessionIds?: readonly string[];
    includeAttentionRows: boolean;
    attentionRowsLimit?: number;
    includeActiveRows?: boolean;
    activeRowsLimit?: number;
    visibilityArms?: V2SessionListVisibilityArmsReader;
    timing?: V2SessionListInitialPageTiming;
}>;

/**
 * How many attention rows the initial page carries.
 *
 * Unlike the active family's bound, this one *binds*: the reference account has 938 sessions with an
 * attention reason against ~2,900 sessions. It is nonetheless a bound and not a truncation, and the
 * difference is the ordering. The attention family is read with `V2_SESSION_LIST_ORDER_BY` — the
 * list page's own key — so it is a filtered subsequence of the list itself, and the rows above the
 * cap are exactly the rows the cursor page reaches at a later position. Ordinary pagination
 * backfills every one of them, which is why the family needs no cursor and no has-next of its own.
 *
 * The active family has no such property (`lastActiveAt` orders it, and a session can be live with
 * its last meaningful activity weeks old), so a row *it* omits has no other path into the list and
 * its limit is set above any plausible count instead. Pinned by
 * `v2SessionListInitialPage.attentionRows.sqlite.integration.spec.ts`, which fails if the attention
 * read ever stops sharing the page's ordering — at which point this cap becomes silent data loss.
 *
 * The cap counts the rows the *response* carries as attention rows, so attention rows the page
 * already holds spend it too: it bounds the family, not the number of statements' worth of rows read.
 */
export const DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT = 100;

function readNumberField(row: V2SessionListRowCompat, field: string): number | null {
    const value = (row as Record<string, unknown>)[field];
    if (typeof value === "bigint") return Number(value);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasUnreadSessionActivity(row: V2SessionListRowCompat): boolean {
    const sessionSeq = readNumberField(row, "seq");
    if (sessionSeq === null) return false;
    return isSessionUnread({ seq: sessionSeq, lastViewedSessionSeq: readNumberField(row, "lastViewedSessionSeq") });
}

/**
 * A failure needs the user while the session is still live, or while its output is still unread.
 * Once it is read and idle it is history: the user has already seen it and the session is not going
 * to do anything else about it.
 *
 * `latestTurnStatus = 'failed'` is otherwise a *permanent* property of the row — a session that
 * failed once carries it until it runs again — so the unscoped arm accumulated forever. Measured on
 * the reference account (2,352 non-archived sessions): 583 attention rows, 261 of them from this
 * arm, of which 257 were already read and not active and 254 qualified through this arm and nothing
 * else. Forty-four percent of "needs attention" was a failure the user had already looked at.
 *
 * This is the rule the client already applies (`sessionListPlacementProjection.ts`
 * `#shouldPromoteFailedSessionAttention`), so before this the two disagreed and the server shipped
 * ~254 rows per refresh that the client then refused to place in the attention lane — spending the
 * family's budget, and each row's e2ee metadata blob, on rows nobody would show.
 *
 * The unread arm is deliberately untouched: a session that produced output while the user was away
 * is unread whatever its turn status, including mid-turn. Only the *failure* reason is scoped here.
 */
function hasPrimarySessionFailure(row: V2SessionListRowCompat): boolean {
    if (parseStoredSessionLatestTurnStatus(row.latestTurnStatus) !== "failed") return false;
    const issue = parseStoredSessionRuntimeIssue(row.lastRuntimeIssue);
    return issue?.v === 1
        && issue.scope === "primary_session"
        && issue.status === "failed"
        && (row.active === true || hasUnreadSessionActivity(row));
}

/**
 * The product rule, and the single answer to "is this row in attention" on this side of the wire.
 *
 * It is *stricter* than the `needsAttention` seek that produced the candidate rows, and that split
 * is deliberate rather than a second opinion: the strict rule needs a JSON scope test on
 * `lastRuntimeIssue` and a cross-column comparison, and a generated column may reference only
 * same-row columns and has no JSON accessor that is portable across PostgreSQL, MySQL and SQLite.
 * So the database owns the cheap indexable **superset** and this function owns the answer —
 * candidate + confirm, the same shape `../dev` runs. Every path that admits a row into the attention
 * family goes through here (`planAttentionRowsRead` for the rows the page already holds,
 * `mergeInitialRows` for the rows read beyond it), so the confirmation cannot be bypassed.
 */
function isDurableAttentionRow(row: V2SessionListRowCompat): boolean {
    return row.pendingPermissionRequestCount > 0
        || row.pendingUserActionRequestCount > 0
        || hasPrimarySessionFailure(row)
        || hasUnreadSessionActivity(row);
}

/**
 * Which shape of the attention predicate the database is asked for.
 *
 * - `materialized` — the indexed `Session.needsAttention` fact. The only shape a current schema is
 *   ever asked for.
 * - `derived` — the predicate this column replaced, used *only* by the projection fallback when the
 *   connected schema predates the `needsAttention` migration
 *   (`20260808120000_add_session_needs_attention`). It names neither materialized column, so it also
 *   answers a schema predating `20260807120000_add_session_unread_since`. Remove it once neither
 *   schema is supported.
 */
type SessionAttentionPredicateSource = "materialized" | "derived";

/**
 * The attention predicate.
 *
 * `materialized` is one indexable conjunct. The predicate it replaces is a four-way disjunction over
 * four different columns — an unread comparison, a turn status and two counters — and a row can
 * qualify through any of them, so no index on any engine can serve it: every engine drops the whole
 * OR into a residual filter and reads the account's sessions. `Session.needsAttention` materializes
 * the same answer as a single **equality** key, so
 * `[accountId, needsAttention, meaningfulActivityAt desc, id desc]` serves this predicate *and* the
 * `V2_SESSION_LIST_ORDER_BY` this read is issued with, leaving the `take` to bound the work. Serving
 * the ordering is the load-bearing half: a filter-only fact makes the engine sort every matched row,
 * which costs more than the filter saves for an account with more attention rows than the limit.
 *
 * The column is **database-generated** from the four raw columns, so no writer of any version can
 * leave it stale and this seek is complete on its own: it needs no dual read and no reader repair.
 * `isDurableAttentionRow` still narrows the result in memory — the failed-turn arm additionally
 * requires a primary-session runtime issue *and* a session that is still active or still unread —
 * which is a stricter product rule layered on top of the predicate, not a second answer to it. It
 * has to be layered rather than folded in: a generated column may reference only same-row columns
 * and cannot parse the `lastRuntimeIssue` JSON portably across PostgreSQL, MySQL and SQLite.
 *
 * `archivedAt IS NULL` deliberately stays its own conjunct rather than becoming a fifth arm of the
 * generation expression: it filters an already-tiny matched set, and folding it in would make every
 * archive/unarchive rewrite the generated value and, on PostgreSQL, the row.
 *
 * `derived` is that predecessor predicate, kept for exactly one reader: a binary that is ahead of
 * `prisma migrate deploy` and whose primary read already failed because the column does not exist.
 * Its unindexable scan is not a regression there — it is what that schema's own binary did, and no
 * `[accountId, needsAttention, …]` index exists on it to lose. This is not a dual read: the hot path
 * never issues it, and it answers a *missing column*, never a stale one. It must name no column the
 * legacy projection had to drop, which `v2SessionListPage.projectionFallback.spec.ts` pins against
 * the fallback column list itself.
 *
 * The two unread branches are the two halves of `seq > COALESCE(lastViewedSessionSeq, 0)`: SQL
 * compares a never-viewed session against NULL, which is not true, so it needs its own branch.
 */
export function createV2SessionListAttentionRowsWhere(
    source: SessionAttentionPredicateSource,
): Prisma.SessionWhereInput {
    if (source === "materialized") {
        return { archivedAt: null, needsAttention: true };
    }
    return {
        archivedAt: null,
        AND: [{
            OR: [
                { lastViewedSessionSeq: null, seq: { gt: 0 } },
                { seq: { gt: db.session.fields.lastViewedSessionSeq } },
                { latestTurnStatus: "failed" },
                { pendingPermissionRequestCount: { gt: 0 } },
                { pendingUserActionRequestCount: { gt: 0 } },
            ],
        }],
    };
}

/**
 * Rows this request already holds that are unread but carry no `unreadSince` edge instant — the
 * old-writer skew described in `sessionAttentionFacts.ts`, which only `unreadSince` still has,
 * because `needsAttention` is generated by the database.
 *
 * The claim is read straight off the row: unread by its own raw columns, with the instant column
 * fetched and null. It needs no query and no inference from the shape of some other result, so the
 * attention read's own completeness is irrelevant here.
 *
 * A legacy-projection row does not carry `unreadSince` at all — that is a schema on which the column
 * does not exist — so it is never a candidate. Pinned by
 * `sessionUnreadSince.sqlite.integration.spec.ts`.
 */
function collectUnstampedUnreadSessionIds(
    observedRows: ReadonlyArray<V2SessionListRowCompat>,
): string[] {
    const unreadSessionIds = new Set<string>();
    for (const row of observedRows) {
        if (row.archivedAt !== null) continue;
        if (!("unreadSince" in row) || row.unreadSince !== null) continue;
        if (hasUnreadSessionActivity(row)) unreadSessionIds.add(row.id);
    }
    return [...unreadSessionIds];
}

/**
 * The initial page is the union of the row families the client would otherwise have asked for
 * separately, in a fixed precedence: explicitly pinned rows, then rows in a condition, then rows
 * live on a machine, then the page itself, then explicitly required rows. De-duplication is by session id and first occurrence
 * wins, so a row belonging to several families appears once, at its strongest family's position.
 */
function mergeInitialRows(params: Readonly<{
    pinnedSessionIds: readonly string[];
    pinnedRows: ReadonlyArray<V2SessionListRowCompat>;
    attentionRows: ReadonlyArray<V2SessionListRowCompat>;
    activeRows: ReadonlyArray<V2SessionListRowCompat>;
    pageRows: ReadonlyArray<V2SessionListRowCompat>;
    requiredRows: ReadonlyArray<V2SessionListRowCompat>;
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
    for (const row of params.activeRows) {
        appendRow(row);
    }
    for (const row of params.pageRows) {
        appendRow(row);
    }
    for (const row of params.requiredRows) {
        appendRow(row);
    }
    return rows;
}

type V2SessionListAttentionRowsPlan = Readonly<{
    /** Attention rows the page read already returned, in the family's own order. */
    rowsInPage: ReadonlyArray<V2SessionListRowCompat>;
    /** The predicate that starts the family strictly after the last row of the page. */
    beyondPageWhere: Prisma.SessionWhereInput;
    beyondPageLimit: number;
}>;

/**
 * Maximum candidate batches one initial-page attention read may inspect.
 *
 * `needsAttention` is an indexed superset, so rows rejected by `isDurableAttentionRow` must not
 * consume the response's durable-row budget. Refilling indefinitely would turn malformed or stale
 * candidate-heavy accounts into unbounded request work, so the reader scans at most five family-sized
 * batches. At the public 100-row family limit that is 500 candidates and at most five refill iterations.
 */
const V2_SESSION_LIST_ATTENTION_CANDIDATE_BATCH_LIMIT = 5;

/**
 * Split the attention family into the part this request already holds and the part it must read.
 *
 * The family is read with the page's own ordering key, so the two reads overlapped by construction:
 * every attention row inside the page window was fetched, deserialized and mapped **twice** on the
 * request the client's first paint waits for — and each row carries the session's e2ee metadata blob
 * (~35.8 KB on the reference account), which the server cannot project away. Measured on the
 * integration fixture: 153 rows read for a 125-row response.
 *
 * Re-using the page's own rows for the overlap and starting the read after the page's last row makes
 * the union identical. Both halves are ordered by effective activity descending; every row of the
 * first half sorts at or above the boundary and every row of the second sorts strictly below it, so
 * concatenating them reproduces the exact sequence the single read returned — the response is the
 * same rows in the same order, which is what the merge's family precedence depends on.
 *
 * The budget is spent on the whole family, so the rows already in the page count against it; that
 * keeps the cap a bound on what the *response* carries rather than on what one statement returned.
 * When a non-empty page has no next page it is the entire visible list, so no attention row can exist
 * beyond it and the read is skipped outright. An empty supplied page is different: it gives this
 * merger no rows to reuse and can be produced by compatibility callers that still expect the
 * attention family to establish visibility, so that case reads the bounded family from its start.
 */
function planAttentionRowsRead(params: Readonly<{
    includeAttentionRows: boolean;
    /**
     * The rows the page read returned, including the extra row it takes to decide `hasNext`. That
     * probe row is not part of the page, but it is part of the family when it needs attention — and
     * counting it here is what keeps it from being the one row still read twice.
     */
    pageRows: ReadonlyArray<V2SessionListRowCompat>;
    pageHasNext: boolean;
    attentionRowsLimit: number;
}>): V2SessionListAttentionRowsPlan | null {
    if (!params.includeAttentionRows) return null;

    const rowsInPage = params.pageRows.filter(isDurableAttentionRow);
    if (params.pageRows.length === 0) {
        return {
            rowsInPage,
            beyondPageWhere: {},
            beyondPageLimit: params.attentionRowsLimit,
        };
    }
    const boundaryRow = params.pageHasNext ? params.pageRows[params.pageRows.length - 1] : undefined;
    const beyondPageLimit = Math.max(0, params.attentionRowsLimit - rowsInPage.length);
    if (!boundaryRow || beyondPageLimit === 0) {
        return rowsInPage.length > 0
            ? { rowsInPage, beyondPageWhere: {}, beyondPageLimit: 0 }
            : null;
    }

    return {
        rowsInPage,
        beyondPageWhere: createV2SessionListCursorWhere({
            sessionId: boundaryRow.id,
            meaningfulActivityAt: getV2SessionListEffectiveActivityAt(boundaryRow).getTime(),
        }),
        beyondPageLimit,
    };
}

async function findV2SessionListAttentionRows(params: Readonly<{
    userId: string;
    initialWhere: Prisma.SessionWhereInput;
    durableRowLimit: number;
    familyRowLimit: number;
    visibilityArms?: V2SessionListVisibilityArmsReader;
}>): Promise<V2SessionListRowCompat[]> {
    const durableRows: V2SessionListRowCompat[] = [];
    const candidateScanLimit = params.familyRowLimit * V2_SESSION_LIST_ATTENTION_CANDIDATE_BATCH_LIMIT;
    let candidatesScanned = 0;
    let scanWhere = params.initialWhere;

    while (durableRows.length < params.durableRowLimit && candidatesScanned < candidateScanLimit) {
        const candidatesRemaining = candidateScanLimit - candidatesScanned;
        const firstBatchLimit = params.durableRowLimit - durableRows.length;
        const batchLimit = Math.min(
            candidatesRemaining,
            candidatesScanned === 0 ? firstBatchLimit : params.familyRowLimit,
        );
        const candidates = await findV2SessionListRows({
            userId: params.userId,
            where: mergeSessionWhereInputs(createV2SessionListAttentionRowsWhere("materialized"), scanWhere),
            legacyWhere: () => mergeSessionWhereInputs(createV2SessionListAttentionRowsWhere("derived"), scanWhere),
            orderBy: V2_SESSION_LIST_ORDER_BY,
            take: batchLimit,
            visibilityArms: params.visibilityArms,
        });

        candidatesScanned += candidates.length;
        for (const row of candidates) {
            if (isDurableAttentionRow(row)) durableRows.push(row);
            if (durableRows.length >= params.durableRowLimit) break;
        }
        if (candidates.length < batchLimit) break;

        const lastCandidate = candidates[candidates.length - 1];
        if (!lastCandidate) break;
        scanWhere = createV2SessionListCursorWhere({
            sessionId: lastCandidate.id,
            meaningfulActivityAt: getV2SessionListEffectiveActivityAt(lastCandidate).getTime(),
        });
    }

    return durableRows;
}

/**
 * How many session ids the active read may exclude by id.
 *
 * The exclusion is an optimization, never a correctness requirement — a row it fails to exclude is
 * simply read twice and de-duplicated by the merge, exactly as before — so it is safe to bound, and
 * it *must* be bounded: `notIn` is a negation filter, and Prisma cannot split an oversized bind list
 * when one is present (reproduced on SQLite at 999 parameters, see `SHARED_SESSION_ID_ARM_CHUNK_SIZE`).
 * Unbounded, an account with enough pins would turn a page read into a hard failure instead of a
 * slower one. The active read binds nothing else of size — it is not an effective-activity read, so
 * it carries no shared-id arms — which is why this may take half the engine's budget rather than a
 * quarter of it. The reference account excludes ~390 ids (42 page rows in the family + 355 pins).
 */
const V2_ACTIVE_SESSION_LIST_EXCLUDED_ID_LIMIT = 500;

type V2ActiveSessionListRowsPlan = Readonly<{
    /** Active-family rows the page read already returned, in the family's own order. */
    rowsInPage: ReadonlyArray<V2SessionListRowCompat>;
    /** Ids the read may skip because this request already holds — or will hold — the row. */
    excludedSessionIds: readonly string[];
    beyondPageLimit: number;
}>;

/**
 * Split the active family into the part this request already holds and the part it must read.
 *
 * The families overlap heavily and the overlap was read twice. Measured against the reference
 * account's own database (2,876 sessions, one `limit=50&includeAttention&includeActive` request):
 * 549 session rows read for 439 distinct rows in the response — **110 rows re-read, 2,521,268 bytes
 * of `metadata`+`agentState` deserialized for nothing** on the request the client's first paint waits
 * for. Of those, 42 were active rows inside the page window and 48 were active rows that the pinned
 * read had already fetched.
 *
 * Unlike the attention family, this one is ordered by `lastActiveAt` while the page is ordered by
 * effective activity, so there is no boundary row to read past: the overlap can only be excluded by
 * id. That is affordable here because the ids are all known *before* this read is issued — the pinned
 * ids are resolved by the route before the page read, and the page rows are the caller's own input —
 * so nothing serializes that was parallel. The three family reads still go out together.
 *
 * The two halves are re-joined by `compareV2ActiveSessionListRows`, the comparator form of the
 * family's own ordering, so the merged sequence is the one the single read returned.
 *
 * **Pinned ids are excluded without being recovered here**, and that loses nothing: the merge emits
 * pinned rows at a strictly stronger precedence than active ones, so a pinned row's position in the
 * response never came from this family in the first place.
 *
 * The budget is spent on the whole family, so rows already in the page count against it, keeping the
 * cap a bound on what the *response* carries. It is a backstop far above any plausible active count
 * (500 against 67 observed), not a payload control, so the pinned rows no longer counted against it
 * cannot change a real response.
 */
function planActiveRowsRead(params: Readonly<{
    includeActiveRows: boolean;
    pageRows: ReadonlyArray<V2SessionListRowCompat>;
    pinnedSessionIds: readonly string[];
    activeRowsLimit: number;
    now: Date;
}>): V2ActiveSessionListRowsPlan | null {
    if (!params.includeActiveRows) return null;

    const rowsInPage = params.pageRows
        .filter((row) => isV2ActiveSessionListRow(row, params.now))
        .sort(compareV2ActiveSessionListRows);

    // Page rows first: they are the ids this read would otherwise return, so they are the ones worth
    // spending the bind budget on. Pins follow — the read must exclude all of them, because whether a
    // pinned row is in the family is not knowable until it is read.
    const excludedSessionIds = new Set(rowsInPage.map((row) => row.id));
    for (const sessionId of params.pinnedSessionIds) {
        if (excludedSessionIds.size >= V2_ACTIVE_SESSION_LIST_EXCLUDED_ID_LIMIT) break;
        excludedSessionIds.add(sessionId);
    }

    return {
        rowsInPage,
        excludedSessionIds: [...excludedSessionIds].slice(0, V2_ACTIVE_SESSION_LIST_EXCLUDED_ID_LIMIT),
        beyondPageLimit: Math.max(0, params.activeRowsLimit - rowsInPage.length),
    };
}

/**
 * The pinned family, split the same way — and the cheapest of the three, because pinned membership is
 * an id list rather than a predicate: a page row that is pinned needs no re-evaluation to be
 * recognised, only a lookup.
 *
 * So the read asks for the pins the page did not already return, which both shortens its `IN` list and
 * lets it disappear altogether when every pin is on the first page — the common case for a small pin
 * set, since a pinned session is usually a recently active one. On the reference account it removes 33
 * of 355 rows (854,732 bytes). `archivedAt: null` is applied to the reused rows too, because that is
 * the conjunct the read itself carries and a caller may supply any page rows it likes.
 */
function planPinnedRowsRead(params: Readonly<{
    pinnedSessionIds: readonly string[];
    pageRowsById: ReadonlyMap<string, V2SessionListRowCompat>;
}>): Readonly<{ rowsInPage: V2SessionListRowCompat[]; sessionIdsToRead: string[] }> {
    const rowsInPage: V2SessionListRowCompat[] = [];
    const sessionIdsToRead: string[] = [];
    for (const sessionId of params.pinnedSessionIds) {
        const pageRow = params.pageRowsById.get(sessionId);
        if (pageRow && pageRow.archivedAt === null) {
            rowsInPage.push(pageRow);
            continue;
        }
        sessionIdsToRead.push(sessionId);
    }
    return { rowsInPage, sessionIdsToRead };
}

export async function createV2SessionListInitialPage(params: V2SessionListInitialPageParams) {
    const attentionRowsLimit = params.attentionRowsLimit ?? DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT;
    const activeRowsLimit = params.activeRowsLimit ?? V2_ACTIVE_SESSION_LIST_ROW_LIMIT;
    const pinnedSessionIds = params.pinnedSessionIds;
    const includeActiveRows = params.includeActiveRows === true;
    const measureQuery = params.timing?.measureQuery ?? (<T>(fn: () => Promise<T>) => fn());
    const measurePage = params.timing?.measurePage ?? (<T>(fn: () => T) => fn());

    // Resolve where the page ends *before* the family reads are issued: the page rows are already in
    // hand, so this costs nothing, and the attention read below is defined relative to that boundary.
    // Only the cursor half of the page is wanted here. Asking `createV2SessionListPage` for it would
    // also map its rows into wire records — every one of which this branch then discards, because the
    // response's `sessions` is the merged set. On the initial page that is `limit` rows mapped twice
    // and thrown away once, on the request the client's first paint waits for.
    const { resultRows: pageRows, ...page } = measurePage(() => resolveV2SessionListPageBounds({
        rows: params.pageRows,
        limit: params.limit,
    }));

    const attentionPlan = measurePage(() => planAttentionRowsRead({
        includeAttentionRows: params.includeAttentionRows,
        pageRows: params.pageRows,
        pageHasNext: page.hasNext,
        attentionRowsLimit,
    }));

    // One instant for both halves of the active family: the predicate the database is asked for and
    // the test applied to the rows already in hand. Two `new Date()`s would let a heartbeat land
    // between them and put a row in neither half.
    const activeSessionsNow = new Date();
    const pageRowsById = new Map(params.pageRows.map((row) => [row.id, row]));
    const pinnedPlan = measurePage(() => planPinnedRowsRead({ pinnedSessionIds, pageRowsById }));
    const activePlan = measurePage(() => planActiveRowsRead({
        includeActiveRows,
        pageRows: params.pageRows,
        pinnedSessionIds,
        activeRowsLimit,
        now: activeSessionsNow,
    }));

    const [pinnedRowsBeyondPage, attentionRowsBeyondPage, activeRowsBeyondPage] = await Promise.all([
        pinnedPlan.sessionIdsToRead.length > 0
            ? measureQuery(() => findV2SessionListRows({
                userId: params.userId,
                where: { archivedAt: null, id: { in: pinnedPlan.sessionIdsToRead } },
                orderBy: { id: "desc" },
                take: pinnedPlan.sessionIdsToRead.length,
            }))
            : Promise.resolve([]),
        attentionPlan && attentionPlan.beyondPageLimit > 0
            ? measureQuery(() => findV2SessionListAttentionRows({
                userId: params.userId,
                initialWhere: attentionPlan.beyondPageWhere,
                durableRowLimit: attentionPlan.beyondPageLimit,
                familyRowLimit: attentionRowsLimit,
                visibilityArms: params.visibilityArms,
            }))
            : Promise.resolve([]),
        activePlan && activePlan.beyondPageLimit > 0
            ? measureQuery(() => findV2SessionListRows({
                userId: params.userId,
                where: mergeSessionWhereInputs(
                    createV2ActiveSessionListRowsWhere(activeSessionsNow),
                    activePlan.excludedSessionIds.length > 0
                        ? { id: { notIn: [...activePlan.excludedSessionIds] } }
                        : {},
                ),
                orderBy: V2_ACTIVE_SESSION_LIST_ORDER_BY,
                take: activePlan.beyondPageLimit,
                visibilityArms: params.visibilityArms,
            }))
            : Promise.resolve([]),
    ]);
    // Reuse every row already read, including the page's pagination probe. Exact requested ids can
    // include archived sessions, so this family intentionally has no archivedAt predicate. The
    // existing reader still enforces account/share visibility and selects the viewer's data key.
    const observedRowsById = new Map([
        ...params.pageRows, ...pinnedRowsBeyondPage, ...attentionRowsBeyondPage, ...activeRowsBeyondPage,
    ].map((row) => [row.id, row]));
    const requiredSessionIds = [...new Set(params.requiredSessionIds ?? [])];
    const missingRequiredIds = requiredSessionIds.filter((id) => !observedRowsById.has(id));
    const requiredRowsBeyondFamilies = missingRequiredIds.length > 0
        ? await measureQuery(() => findV2SessionListRows({
            userId: params.userId,
            where: { id: { in: missingRequiredIds } },
            orderBy: { id: "desc" },
            take: missingRequiredIds.length,
            visibilityArms: params.visibilityArms,
        }))
        : [];
    for (const row of requiredRowsBeyondFamilies) observedRowsById.set(row.id, row);

    const mergedRows = measurePage(() => mergeInitialRows({
        pinnedSessionIds,
        // Pinned rows are placed by id, so the ones the page already returned need no ordering care.
        pinnedRows: [...pinnedPlan.rowsInPage, ...pinnedRowsBeyondPage],
        // The rows the page already holds come first — they *are* the top of the family, in the same
        // order the one-query shape returned them — and the read above supplies only the tail.
        attentionRows: [...(attentionPlan?.rowsInPage ?? []), ...attentionRowsBeyondPage],
        // The active family has no such boundary: its halves interleave, so they are re-joined by the
        // comparator form of its own ordering to reproduce the sequence one read would have returned.
        activeRows: activePlan
            ? [...activePlan.rowsInPage, ...activeRowsBeyondPage].sort(compareV2ActiveSessionListRows)
            : [],
        pageRows,
        requiredRows: requiredSessionIds.flatMap((id) => {
            const row = observedRowsById.get(id);
            return row ? [row] : [];
        }),
    }));

    // Repair, from what this response already proves, the unread instants an older writer left
    // unrecorded. Visibility never depended on this — `needsAttention` is generated, so the indexed
    // seek already carried these rows — only the unread lane's ordering key was missing. In the
    // steady state the candidate set is empty and no statement is issued.
    await reconcileObservedSessionUnreadSince({
        unreadSessionIds: collectUnstampedUnreadSessionIds(mergedRows),
        now: new Date(),
    });

    return measurePage(() => ({
        ...page,
        sessions: mapV2SessionListRows({ rows: mergedRows, userId: params.userId }),
        // Advertise the merge to the client that asked for it. `includeActive` is negotiable only
        // because of this marker: an older server drops the unknown query key in its zod querystring
        // schema and answers with a valid page, and an account with no live session yields no extra
        // rows either way, so the rows themselves can never tell the client whether the flag was
        // honoured — it would keep issuing the separate `GET /v2/sessions/active` call forever.
        // It is emitted from the same `includeActiveRows` that gates the query above, and from
        // nowhere else, so it cannot claim a merge that did not happen. `V2SessionListResponseSchema`
        // is `.passthrough()`, so it rides the existing response with no format change and an older
        // client, which never reads the key, sees the response it always saw.
        ...(includeActiveRows ? { includedActive: true } : {}),
    }));
}

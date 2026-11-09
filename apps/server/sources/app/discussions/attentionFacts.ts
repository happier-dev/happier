import type { Prisma } from "@prisma/client";
import type { DiscussionAttentionFactsV1 } from '@happier-dev/protocol/discussions/models';

import { getActivePrismaRuntime } from "@/storage/db";
import { inReadSnapshot, type Tx } from "@/storage/inTx";
import { filterDiscussionsWithCurrentReadAccessInTx } from "./access";
import { countUnreadMentionsInTx, countUnreadMessagesInTx, type DiscussionCursorRow } from "./projection";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { DISCUSSION_DEFAULT_PAGE_SIZE_V1, DISCUSSION_MAX_PAGE_SIZE_V1, type DiscussionAttentionQueryV1,
    type DiscussionAttentionResponseV1 } from '@happier-dev/protocol/discussions/api';
import { discussionCandidateWhere, discussionCandidateSql, resolveDiscussionContextsInTx, hasDiscussionWithUnavailableKeyInTx } from './access';
import { DISCUSSION_SELECT, DISCUSSION_MESSAGE_SELECT, discussionUnreadMessageSql, type AdmittedDiscussionMessageRow, type DiscussionMessageRow, type DiscussionRow } from './projection';
import { projectDiscussionsForViewerInTx, projectReadableMessageGroupsInTx } from './queries';
import { decodeDiscussionListCursorV1, encodeDiscussionListCursorV1 } from './pagination';
import { admitArtifactEditProposalDecisionDocInTx } from '@/app/artifacts/artifactEditProposalService';
import { discussionFailure, discussionSuccess, type DiscussionResult } from './serviceTypes';
import { prismaRuntime as sql, getDbProviderFromEnv } from '@/storage/prisma';
import { discussionSqlName as name, discussionSqlTimestamp } from './readSql';
import type { DiscussionContext } from './access';

/**
 * One Home/Account attention page over original messages, private read cursors and
 * C5's live proposal authority. Reading is never a proposal disposition.
 */
export async function readDiscussionAttention(input: Readonly<{
    actorAccountId: string; authentication: SessionAccessAuthentication;
}> & DiscussionAttentionQueryV1): Promise<DiscussionResult<DiscussionAttentionResponseV1>> {
    const cursor = input.cursor === undefined ? null : decodeDiscussionListCursorV1(input.cursor);
    if (input.cursor !== undefined && !cursor) return discussionFailure('discussion_invalid_content');
    const afterCursor = input.afterCursor === undefined ? null : decodeDiscussionListCursorV1(input.afterCursor);
    if (input.afterCursor !== undefined && (!afterCursor || input.discussionId === undefined)) {
        return discussionFailure('discussion_invalid_content');
    }
    return inReadSnapshot(async tx => {
        let incomplete = await hasDiscussionWithUnavailableKeyInTx(tx, { accountId: input.actorAccountId,
            authentication: input.authentication, discussionId: input.discussionId });
        const take = Math.min(input.limit ?? DISCUSSION_DEFAULT_PAGE_SIZE_V1, DISCUSSION_MAX_PAGE_SIZE_V1);
        const contexts = new Map<string, DiscussionContext>();
        const discussionsById = new Map<string, DiscussionRow>();
        const rows: DiscussionMessageRow[] = [];
        let frontier = cursor;
        // Storage answers unread/open demand before any context/cursor census.
        // Denied or keyless candidates still pass through the live admission owner.
        for (;;) {
            const disposition = sql.sql`m.${name('docEditProposalDispositionV1')}`;
            const provider = getDbProviderFromEnv(process.env, 'postgres');
            const open = provider === 'sqlite' ? sql.sql`json(${disposition}) = ${JSON.stringify({ state: 'open' })}`
                : provider === 'mysql' ? sql.sql`${disposition} = CAST(${JSON.stringify({ state: 'open' })} AS JSON)`
                : sql.sql`${disposition} = ${JSON.stringify({ state: 'open' })}::jsonb`;
            const position = frontier ? discussionSqlTimestamp(new Date(frontier.at)) : sql.empty;
            const oldestPosition = afterCursor ? discussionSqlTimestamp(new Date(afterCursor.at)) : sql.empty;
            const ids: { id: string }[] = await tx.$queryRaw(sql.sql`SELECT m.${name('id')} AS id FROM ${name('DiscussionMessage')} m
                JOIN ${name('Discussion')} d ON d.${name('id')} = m.${name('discussionId')}
                WHERE ${discussionCandidateSql(input.actorAccountId)} AND d.${name('archivedAt')} IS NULL
                ${input.discussionId === undefined ? sql.empty : sql.sql`AND d.${name('id')} = ${input.discussionId}`}
                AND (${open} OR ${discussionUnreadMessageSql(input.actorAccountId)})
                ${afterCursor ? sql.sql`AND (m.${name('createdAt')} > ${oldestPosition} OR (m.${name('createdAt')} = ${oldestPosition} AND m.${name('id')} >= ${afterCursor.id}))` : sql.empty}
                ${frontier ? sql.sql`AND (m.${name('createdAt')} < ${position} OR (m.${name('createdAt')} = ${position} AND m.${name('id')} < ${frontier.id}))` : sql.empty}
                ORDER BY m.${name('createdAt')} DESC, m.${name('id')} DESC LIMIT ${take + 1 - rows.length}`);
            if (!ids.length) break;
            const messages = await tx.discussionMessage.findMany({ where: { id: { in: ids.map(row => row.id) } },
                select: DISCUSSION_MESSAGE_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
            const discussionIds = [...new Set(messages.map(row => row.discussionId))];
            const candidates = await tx.discussion.findMany({ where: { id: { in: discussionIds } }, select: DISCUSSION_SELECT });
            const current = await resolveDiscussionContextsInTx(tx, { discussionIds,
                accountId: input.actorAccountId, authentication: input.authentication, includeActorAudience: true });
            for (const row of candidates) {
                const context = current.get(row.id);
                if (context?.keyReadiness) { discussionsById.set(row.id, row); contexts.set(row.id, context); }
            }
            rows.push(...messages.filter(row => contexts.has(row.discussionId)));
            if (rows.length > take) break;
            const last = messages.at(-1)!;
            frontier = { v: 1, at: last.createdAt.getTime(), id: last.id };
        }
        const discussions = [...discussionsById.values()];
        if (!discussions.length) return discussionSuccess({ discussions: [], nextCursor: null, incomplete });
        const selected = rows.slice(0, take);
        const entries: DiscussionAttentionResponseV1['discussions'] = [];
        const active = discussions.filter(row => selected.some(message => message.discussionId === row.id));
        const docSourceAdmissions = new Map<string, DiscussionResult<void>>();
        const messageAdmissions = new Map<string, AdmittedDiscussionMessageRow>();
        const summaries = await projectDiscussionsForViewerInTx(tx, { discussions: active, contexts, docSourceAdmissions, messageAdmissions,
            viewerAccountId: input.actorAccountId, authentication: input.authentication, messages: selected });
        if (!summaries.ok) return summaries;
        const readableGroups = await projectReadableMessageGroupsInTx(tx, { ...input, docSourceAdmissions, messageAdmissions,
            groups: summaries.value.map(discussion => ({ discussionId: discussion.id, context: contexts.get(discussion.id)!,
                rows: selected.filter(row => row.discussionId === discussion.id), discussion: discussionsById.get(discussion.id)! })), unavailableDocSources: 'omit' });
        if (!readableGroups.ok) return readableGroups;
        for (const discussion of summaries.value) {
            const sourceRows = selected.filter(row => row.discussionId === discussion.id);
            const readable = readableGroups.value.get(discussion.id)!;
            incomplete ||= readable.messages.length !== sourceRows.length;
            const decisions = new Map<string, Promise<boolean>>();
            const occurrences: DiscussionAttentionResponseV1['discussions'][number]['occurrences'] = [];
            for (const message of readable.messages) {
                const disposition = message.docEditProposalDispositionV1;
                const source = readable.docSources.get(message.id);
                let decision = false;
                if (disposition?.state === 'open' && source) {
                    let admitted = decisions.get(source.ref.artifactId);
                    if (!admitted) {
                        admitted = admitArtifactEditProposalDecisionDocInTx(tx, { ...input, discussionId: discussion.id }, source).then(result => result.ok);
                        decisions.set(source.ref.artifactId, admitted);
                    }
                    decision = await admitted;
                }
                const lastRead = discussion.lastReadSeq;
                if (!decision && (lastRead === null || message.seq <= lastRead)) continue;
                occurrences.push({ message, type: decision ? 'decision' : message.mentionedAccountIds.includes(input.actorAccountId) ? 'mention' : 'update' });
            }
            if (occurrences.length) entries.push({ discussion, occurrences });
        }
        const last = selected.at(-1);
        return discussionSuccess({ discussions: entries, incomplete,
            nextCursor: rows.length > take && last ? encodeDiscussionListCursorV1({ v: 1, at: last.createdAt.getTime(), id: last.id }) : null });
    });
}

export type DiscussionAttentionByAccount =
    ReadonlyMap<string, ReadonlyMap<string, DiscussionAttentionFactsV1>>;

/**
 * The Session-anchor adapter over the one discussion-attention fact projection.
 *
 * It projects readable Discussion activity onto optional Session anchors.
 * It does not decide personal relevance, badge eligibility, or
 * notification delivery: Lane 09B consumes these facts and owns that policy.
 *
 * Unread accrues only from the Discussion's established private cursor. Session
 * ownership, Follow and source access neither enroll a reader nor authorize
 * access to the Discussion. An absent cursor never replays history as unread.
 *
 * When `sessionIds` is omitted the candidates are the Sessions where the Account
 * already holds a discussion cursor — exactly the tracked set — because there is
 * no fact to report for a Session it does not track.
 */
export async function loadDiscussionAttentionForAccounts(params: Readonly<{
    accountIds: readonly string[];
    sessionIds?: readonly string[];
}>): Promise<DiscussionAttentionByAccount> {
    return await inReadSnapshot(async (tx) => await loadDiscussionAttentionForAccountsInTx(tx, params));
}

/**
 * The transaction-local form, so a consumer already inside a transaction
 * composes one read.
 *
 * The whole candidate page is resolved set-wise: one access read, one latest
 * activity grouping, one cursor read, and two unread groupings per Account. The
 * badge count and the initial attention page both call this without a Session
 * page in hand — a per-Session loop there would issue several round trips for
 * every Session an Account tracks, on the hottest personal paths there are.
 */
export async function loadDiscussionAttentionForAccountsInTx(tx: Tx, params: Readonly<{
    accountIds: readonly string[];
    sessionIds?: readonly string[];
    authentication?: SessionAccessAuthentication;
}>): Promise<DiscussionAttentionByAccount> {
    const accountIds = [...new Set(params.accountIds)];
    const result = new Map<string, Map<string, DiscussionAttentionFactsV1>>();
    if (accountIds.length === 0) return result;

    const sessionIds = params.sessionIds
        ? [...new Set(params.sessionIds)]
        : await listSessionIdsWithDiscussionCursorsInTx(tx, { accountIds });
    if (sessionIds.length === 0) return result;

    const discussions = await tx.discussion.findMany({
        where: { anchorSessionId: { in: sessionIds }, archivedAt: null },
        select: { id: true, anchorSessionId: true, lastMessageAt: true },
    });
    return await loadDiscussionAttentionRowsForAccountsInTx(tx, { ...params, accountIds, discussions, groupBy: "session" });
}

/** First-class private attention, independent of source Session existence/access. */
export async function loadFirstClassDiscussionAttentionForAccountsInTx(tx: Tx, params: Readonly<{
    accountIds: readonly string[];
    discussions: readonly Readonly<{ id: string; anchorSessionId: string | null; lastMessageAt: Date }>[];
    authentication: SessionAccessAuthentication;
}>): Promise<DiscussionAttentionByAccount> {
    return await loadDiscussionAttentionRowsForAccountsInTx(tx, { ...params, groupBy: "discussion" });
}

async function loadDiscussionAttentionRowsForAccountsInTx(tx: Tx, params: Readonly<{
    accountIds: readonly string[];
    discussions: readonly Readonly<{ id: string; anchorSessionId: string | null; lastMessageAt: Date }>[];
    groupBy: "session" | "discussion";
    authentication?: SessionAccessAuthentication;
}>): Promise<DiscussionAttentionByAccount> {
    const { accountIds, discussions } = params;
    const result = new Map<string, Map<string, DiscussionAttentionFactsV1>>();
    if (accountIds.length === 0 || discussions.length === 0) return result;
    const readableByAccount = await filterDiscussionsWithCurrentReadAccessInTx(tx, {
        discussionIds: discussions.map(row => row.id), accountIds, authentication: params.authentication,
    });

    const cursorRows = await tx.discussionReadState.findMany({
        where: {
            accountId: { in: [...accountIds] },
            discussionId: { in: discussions.map(row => row.id) },
        },
        select: { accountId: true, discussionId: true, lastReadSeq: true },
    });

    for (const accountId of accountIds) {
        result.set(accountId, await projectDiscussionAttentionForAccountInTx(tx, {
            accountId, discussions, cursorRows, readable: readableByAccount.get(accountId) ?? new Set<string>(),
            groupBy: params.groupBy,
        }));
    }
    return result;
}

/** One cursor/access derivation, grouped by resource or by Session for its list adapter. */
async function projectDiscussionAttentionForAccountInTx(tx: Tx, input: Readonly<{
    accountId: string;
    discussions: readonly Readonly<{ id: string; anchorSessionId: string | null; lastMessageAt: Date }>[];
    cursorRows: readonly Readonly<{ accountId: string; discussionId: string; lastReadSeq: number }>[];
    readable: ReadonlySet<string>;
    groupBy?: "session" | "discussion";
}>): Promise<Map<string, DiscussionAttentionFactsV1>> {
    const targetByDiscussion = new Map<string, string>();
    const latestActivityByTarget = new Map<string, number>();
    for (const row of input.discussions) {
        const targetId = input.groupBy === "discussion" ? row.id : row.anchorSessionId;
        if (!input.readable.has(row.id) || targetId === null) continue;
        targetByDiscussion.set(row.id, targetId);
        latestActivityByTarget.set(targetId, Math.max(
            latestActivityByTarget.get(targetId) ?? 0,
            row.lastMessageAt.getTime(),
        ));
    }
    const cursors: DiscussionCursorRow[] = [];
    for (const row of input.cursorRows) {
        if (row.accountId !== input.accountId || !targetByDiscussion.has(row.discussionId)) continue;
        cursors.push({ discussionId: row.discussionId, lastReadSeq: row.lastReadSeq });
    }
    const unread = await countUnreadMessagesInTx(tx, { viewerAccountId: input.accountId, cursors });
    const mentions = await countUnreadMentionsInTx(tx, { viewerAccountId: input.accountId, cursors });

    // Each group counts unread conversations and accumulates their mentions.
    const unreadConversations = new Map<string, number>();
    const unreadMentions = new Map<string, number>();
    const add = (into: Map<string, number>, discussionId: string, amount: number) => {
        const targetId = targetByDiscussion.get(discussionId);
        if (targetId === undefined) return;
        into.set(targetId, (into.get(targetId) ?? 0) + amount);
    };
    for (const [discussionId, count] of unread) if (count > 0) add(unreadConversations, discussionId, 1);
    for (const [discussionId, count] of mentions) if (count > 0) add(unreadMentions, discussionId, count);

    const perTarget = new Map<string, DiscussionAttentionFactsV1>();
    for (const targetId of new Set(targetByDiscussion.values())) {
        perTarget.set(targetId, {
            unreadConversationCount: unreadConversations.get(targetId) ?? 0,
            unreadMentionCount: unreadMentions.get(targetId) ?? 0,
            latestActivityAt: latestActivityByTarget.get(targetId) ?? null,
        });
    }
    return perTarget;
}

/**
 * The Sessions where at least one of these Accounts already holds a discussion
 * cursor, optionally narrowed to a caller's candidate set.
 *
 * A consumer that has a page of Sessions in hand uses this first: without a
 * cursor there is no discussion attention to report, so the bounded loader above
 * never has to visit a Session the Account does not track.
 */
export async function listSessionIdsWithDiscussionCursorsInTx(tx: Tx, params: Readonly<{
    accountIds: readonly string[];
    sessionIds?: readonly string[];
}>): Promise<string[]> {
    const accountIds = [...new Set(params.accountIds)];
    if (accountIds.length === 0) return [];
    const sessionIds = params.sessionIds ? [...new Set(params.sessionIds)] : undefined;
    if (sessionIds !== undefined && sessionIds.length === 0) return [];
    const rows = await tx.discussion.findMany({
        where: {
            archivedAt: null,
            anchorSessionId: sessionIds === undefined ? { not: null } : { in: sessionIds },
            readStates: { some: { accountId: { in: accountIds } } },
        },
        select: { anchorSessionId: true },
        distinct: ["anchorSessionId"],
    });
    return rows.flatMap((row) => row.anchorSessionId === null ? [] : [row.anchorSessionId]);
}

/**
 * Human-origin discussion authorship for one Account.
 *
 * A post is human when the authenticated execution Account wrote it directly:
 * `producerV1` is the host-stamped Agent attribution, so its presence means the
 * row is Agent production recorded against that Account's runtime rather than a
 * person participating. Requested-by association carries no author column at
 * all and therefore cannot reach this predicate either.
 *
 * Archived discussions still count. Archiving hides a conversation from active
 * pressure; it does not retract the fact that somebody took part.
 */
export function createHumanDiscussionAuthorshipMessageWhere(accountId: string): Prisma.DiscussionMessageWhereInput {
    return { authorAccountId: accountId, producerV1: { equals: getActivePrismaRuntime().DbNull } };
}

/** The relational `Session` arm, applied before any list page limit. */
export async function createSessionsWithHumanDiscussionAuthorshipWhere(tx: Tx, accountId: string): Promise<Prisma.SessionWhereInput> {
    return await createAnchoredSessionParticipationWhere(tx, accountId, createHumanDiscussionAuthorshipMessageWhere(accountId));
}

/**
 * The relational `Session` arm for an existing sparse mention of this Account.
 *
 * Existence is deliberately timeless here: being named in a conversation is a
 * list-relevance fact. Whether a mention is still *actionable* is the separate
 * unread-mention fact above, which is derived from the private cursor.
 */
export async function createSessionsWithDiscussionMentionWhere(tx: Tx, accountId: string): Promise<Prisma.SessionWhereInput> {
    return await createAnchoredSessionParticipationWhere(tx, accountId, { mentions: { some: { accountId } } });
}

async function createAnchoredSessionParticipationWhere(tx: Tx, accountId: string, messageWhere: Prisma.DiscussionMessageWhereInput): Promise<Prisma.SessionWhereInput> {
    const rows = await tx.discussion.findMany({
        where: { anchorSessionId: { not: null }, messages: { some: messageWhere } },
        select: { id: true, anchorSessionId: true },
    });
    const readable = (await filterDiscussionsWithCurrentReadAccessInTx(tx, { accountIds: [accountId], discussionIds: rows.map(row => row.id) })).get(accountId);
    return { id: { in: [...new Set(rows.flatMap(row => row.anchorSessionId !== null && readable?.has(row.id) ? [row.anchorSessionId] : []))] } };
}

export type DiscussionParticipationFactsV1 = Readonly<{
    humanAuthored: boolean;
    mentioned: boolean;
}>;

/**
 * Participation and attention for one admitted Session page share candidate
 * discovery and current Discussion access admission. Archived Discussions may
 * establish participation but never current unread pressure.
 *
 * One candidate discovery serves the whole page. The admitted set supplies
 * participation existence reads, private cursors and unread groupings without
 * per-Session follow-ups or message-content reads. Callers supply Sessions they
 * have already admitted through Lane 04 access, as with the relational arms above.
 */
export async function loadDiscussionSessionFactsForAccountInTx(tx: Tx, params: Readonly<{
    accountId: string;
    sessionIds: readonly string[];
}>): Promise<Readonly<{
    participation: ReadonlyMap<string, DiscussionParticipationFactsV1>;
    attention: ReadonlyMap<string, DiscussionAttentionFactsV1>;
}>> {
    const sessionIds = [...new Set(params.sessionIds)];
    const facts = new Map<string, DiscussionParticipationFactsV1>();
    const empty = { participation: facts, attention: new Map<string, DiscussionAttentionFactsV1>() };
    if (sessionIds.length === 0) return empty;

    const discussions = await tx.discussion.findMany({
        where: { anchorSessionId: { in: sessionIds } },
        select: { id: true, anchorSessionId: true, archivedAt: true, lastMessageAt: true },
    });
    if (discussions.length === 0) return empty;
    const readable = (await filterDiscussionsWithCurrentReadAccessInTx(tx, { accountIds: [params.accountId], discussionIds: discussions.map(row => row.id) })).get(params.accountId);
    const anchorByDiscussion = new Map(discussions.filter(row => readable?.has(row.id)).map(row => [row.id, row.anchorSessionId]));
    if (anchorByDiscussion.size === 0) return empty;
    const authored = await tx.discussionMessage.findMany({
        where: { discussionId: { in: [...anchorByDiscussion.keys()] }, ...createHumanDiscussionAuthorshipMessageWhere(params.accountId) },
        select: { discussionId: true },
        distinct: ["discussionId"],
    });
    const mentioned = await tx.discussionMessage.findMany({
        where: { discussionId: { in: [...anchorByDiscussion.keys()] }, mentions: { some: { accountId: params.accountId } } },
        select: { discussionId: true },
        distinct: ["discussionId"],
    });

    const authoredIds = new Set(authored.flatMap(row => anchorByDiscussion.get(row.discussionId) ?? []));
    const mentionedIds = new Set(mentioned.flatMap(row => anchorByDiscussion.get(row.discussionId) ?? []));
    for (const sessionId of new Set([...authoredIds, ...mentionedIds])) {
        facts.set(sessionId, {
            humanAuthored: authoredIds.has(sessionId),
            mentioned: mentionedIds.has(sessionId),
        });
    }
    const activeDiscussions = discussions.filter(row => row.archivedAt === null && readable?.has(row.id));
    const cursorRows = activeDiscussions.length === 0 ? [] : await tx.discussionReadState.findMany({
        where: { accountId: params.accountId, discussionId: { in: activeDiscussions.map(row => row.id) } },
        select: { accountId: true, discussionId: true, lastReadSeq: true },
    });
    return { participation: facts, attention: await projectDiscussionAttentionForAccountInTx(tx, {
        accountId: params.accountId, discussions: activeDiscussions, cursorRows, readable: readable ?? new Set<string>(),
    }) };
}

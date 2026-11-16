import { decodeSessionStoredContent, withSessionContentSelect } from '@/storage/sessionMachineStoredContent';
import type { Prisma } from "@prisma/client";
import type { SessionListScopeV1 } from '@happier-dev/protocol/sessions/listing/query';
import { type Tx } from "@/storage/inTx";
import { db } from "@/storage/db";
import { getDbProviderFromEnv } from "@/storage/prisma";
import {
    createSessionsWithDiscussionMentionWhere,
    createSessionsWithHumanDiscussionAuthorshipWhere,
    loadDiscussionAttentionForAccountsInTx,
    loadFirstClassDiscussionAttentionForAccountsInTx,
} from "@/app/discussions/attentionFacts";
import {
    loadSessionPersonalDiscussionFactsInTx,
    projectDiscussionAttentionSignals,
    doesDiscussionViewerNeedAttention,
    QUIET_SESSION_PERSONAL_DISCUSSION_FACTS,
    type SessionPersonalDiscussionFacts,
} from "./discussionFacts";
import {
    createSessionPersonalAttentionProjectionSelectForAccounts,
    createSessionPersonalAttentionProjectionSelect,
    doesSessionViewerNeedAttention,
    loadSessionLatestFailureSequencesInTx,
    type SessionPersonalAttentionProjectionRow,
} from "./projection";
import {
    createSessionPersonalAttentionCandidateWhere,
    createSessionPersonallyTrackedWhere,
    iterateBoundedSessionPersonalAttentionRows,
} from "./attentionQuery";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";

export {
    createSessionPersonalAttentionCandidateWhere,
    createSessionPersonallyTrackedWhere,
} from "./attentionQuery";

/** Confirm one bounded candidate page through the single attention resolver. */
export async function filterSessionPersonalAttentionRowsInTx<Row extends SessionPersonalAttentionProjectionRow>(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        rows: readonly Row[];
        qualifiedTeamIds?: ReadonlySet<string>;
        now?: number;
        /** Request/transaction-local facts to reuse when admitted rows are projected. */
        observedDiscussionFacts?: Map<string, SessionPersonalDiscussionFacts>;
        observedFailureSequences?: Map<string, number | null>;
    }>,
): Promise<Row[]> {
    if (params.rows.length === 0) return [];
    const discussionFacts = await loadSessionPersonalDiscussionFactsInTx(tx, {
        accountId: params.accountId,
        sessionIds: params.rows.map((row) => row.id),
    });
    const failureSequences = await loadSessionLatestFailureSequencesInTx(tx, params.rows);
    const admittedRows = params.rows.filter((row) => doesSessionViewerNeedAttention({
        row,
        latestFailureSeq: failureSequences.get(row.id) ?? null,
        viewerAccountId: params.accountId,
        discussion: discussionFacts.get(row.id) ?? QUIET_SESSION_PERSONAL_DISCUSSION_FACTS,
        qualifiedTeamIds: params.qualifiedTeamIds,
        now: params.now,
    }));
    if (params.observedDiscussionFacts) {
        for (const row of admittedRows) {
            params.observedDiscussionFacts.set(
                row.id,
                discussionFacts.get(row.id) ?? QUIET_SESSION_PERSONAL_DISCUSSION_FACTS,
            );
        }
    }
    if (params.observedFailureSequences) {
        for (const row of admittedRows) params.observedFailureSequences.set(row.id, failureSequences.get(row.id) ?? null);
    }
    return admittedRows;
}

/**
 * One bounded candidate-query seam for list pages, continuation and exact counts.
 *
 * Prisma cannot compare a Session field with a related viewer/discussion cursor,
 * and canonical access capabilities and primary-runtime issue parsing also stay
 * at their existing typed owners. The relational predicate is therefore a
 * provider-portable Account-scoped superset. `admitRows` applies the one Protocol
 * projector to each bounded batch. Consumers must scan through rejected rows
 * before applying their output limit; exact counts exhaust the candidate domain.
 */
export function createSessionPersonalAttentionQueryInTx(tx: Tx, params: Readonly<{
    accountId: string;
    qualifiedTeamIds?: ReadonlySet<string>;
    now?: number;
    /** Retain bounded observed facts only when the same request will project rows. */
    captureObservedDiscussionFacts?: boolean;
}>) {
    const now = params.now ?? Date.now();
    const observedDiscussionFacts = params.captureObservedDiscussionFacts
        ? new Map<string, SessionPersonalDiscussionFacts>()
        : undefined;
    const observedFailureSequences = params.captureObservedDiscussionFacts ? new Map<string, number | null>() : undefined;
    return {
        candidateWhere: createSessionPersonalAttentionCandidateWhere({
            accountId: params.accountId,
            now: new Date(now),
        }),
        admitRows: async <Row extends SessionPersonalAttentionProjectionRow>(rows: readonly Row[]) =>
            await filterSessionPersonalAttentionRowsInTx(tx, {
                accountId: params.accountId,
                rows,
                qualifiedTeamIds: params.qualifiedTeamIds,
                now,
                observedDiscussionFacts,
                observedFailureSequences,
            }),
        observedDiscussionFacts,
        observedFailureSequences,
    };
}

/** Exact count: bounded reads, but no semantic candidate ceiling. */
export async function countSessionPersonalAttentionRowsInTx(tx: Tx, params: Readonly<{
    accountId: string;
    where: Prisma.SessionWhereInput;
    qualifiedTeamIds?: ReadonlySet<string>;
    now?: number;
}>): Promise<number> {
    const query = createSessionPersonalAttentionQueryInTx(tx, params);
    let count = 0;
    for await (const rows of iterateBoundedSessionPersonalAttentionRows<SessionPersonalAttentionProjectionRow, string>({
        readCandidates: async ({ cursor, take }) => await tx.session.findMany({
            // Keep the large access/audience predicate out of PostgreSQL's
            // lateral projection joins. Prisma batches relations after LIMIT
            // inside this same transaction, as the Artifact inventory does.
            ...(getDbProviderFromEnv(process.env, "postgres") === "postgres" ? { relationLoadStrategy: "query" as const } : {}),
            where: {
                AND: [
                    params.where,
                    query.candidateWhere,
                    ...(cursor ? [{ id: { gt: cursor } }] : []),
                ],
            },
            orderBy: { id: "asc" },
            take,
            select: withSessionContentSelect(createSessionPersonalAttentionProjectionSelect(params.accountId)),
        }).then(decodeSessionStoredContent),
        cursorAfter: (rows) => rows[rows.length - 1]?.id ?? "",
        admitCandidates: query.admitRows,
    })) {
        count += rows.length;
    }
    return count;
}

/**
 * One Account's credential-qualified access restriction. Both the request-bound
 * snapshot and background refresh resolve it through the same access owner, so
 * an admission without an access predicate is not a representable state.
 */
export type SessionPersonalAttentionAccountAdmission = Readonly<{
    accountId: string;
    accessWhere: Prisma.SessionWhereInput;
    qualifiedTeamIds: ReadonlySet<string>;
}>;

const SESSION_PERSONAL_ATTENTION_ACCOUNT_BATCH_SIZE = 50;

/**
 * Exact Account-grouped Session and Discussion count for badges and push refresh.
 *
 * Each bounded Account batch performs one Session-major candidate scan. The
 * canonical access projection and attention projector then admit unique
 * `(accountId, sessionId)` pairs, so overlapping ownership, Follow, direct and
 * collective access never multiply a badge. Discussion attention is loaded
 * through the Discussion fact owner for the same candidate batch. First-class
 * Discussions not represented by a counted Session use that same fact owner
 * and Protocol attention policy; no badge-local interpretation is introduced.
 */
export async function countAccountPersonalAttentionRowsForAccountsInTx(
    tx: Tx,
    params: Readonly<{
        admissions: readonly SessionPersonalAttentionAccountAdmission[];
        authentication: SessionAccessAuthentication;
        now?: number;
    }>,
): Promise<Map<string, number>> {
    const admissions = [...new Map(
        params.admissions.map((admission) => [admission.accountId, admission] as const),
    ).values()];
    const counts = new Map(admissions.map(({ accountId }) => [accountId, 0]));
    const now = params.now ?? Date.now();

    for (let offset = 0; offset < admissions.length; offset += SESSION_PERSONAL_ATTENTION_ACCOUNT_BATCH_SIZE) {
        const batch = admissions.slice(offset, offset + SESSION_PERSONAL_ATTENTION_ACCOUNT_BATCH_SIZE);
        const accountIds = batch.map(({ accountId }) => accountId);
        const countedSessionIds = new Map(accountIds.map((accountId) => [accountId, new Set<string>()]));

        for await (const rows of iterateBoundedSessionPersonalAttentionRows<SessionPersonalAttentionProjectionRow, string>({
            readCandidates: async ({ cursor, take }) => await tx.session.findMany({
                ...(getDbProviderFromEnv(process.env, "postgres") === "postgres" ? { relationLoadStrategy: "query" as const } : {}),
                where: {
                    AND: [
                        { archivedAt: null },
                        {
                            OR: batch.map((admission) => ({
                                AND: [
                                    admission.accessWhere,
                                    createSessionPersonalAttentionCandidateWhere({
                                        accountId: admission.accountId,
                                        now: new Date(now),
                                    }),
                                ],
                            })),
                        },
                        ...(cursor ? [{ id: { gt: cursor } }] : []),
                    ],
                },
                orderBy: { id: "asc" },
                take,
                select: withSessionContentSelect(createSessionPersonalAttentionProjectionSelectForAccounts(accountIds)),
            }).then(decodeSessionStoredContent),
            cursorAfter: (rows) => rows[rows.length - 1]?.id ?? "",
            admitCandidates: async (rows) => {
                const failureSequences = await loadSessionLatestFailureSequencesInTx(tx, rows);
                const discussionByAccount = await loadDiscussionAttentionForAccountsInTx(tx, {
                    accountIds,
                    sessionIds: rows.map((row) => row.id),
                    authentication: params.authentication,
                });
                for (const row of rows) {
                    for (const admission of batch) {
                        const discussionSignals = projectDiscussionAttentionSignals(
                            discussionByAccount.get(admission.accountId)?.get(row.id),
                        );
                        if (!doesSessionViewerNeedAttention({
                            row,
                            latestFailureSeq: failureSequences.get(row.id) ?? null,
                            viewerAccountId: admission.accountId,
                            discussion: {
                                ...discussionSignals,
                                authored: false,
                                mentioned: false,
                            },
                            qualifiedTeamIds: admission.qualifiedTeamIds,
                            now,
                        })) continue;
                        countedSessionIds.get(admission.accountId)?.add(row.id);
                    }
                }
                // Counting is accumulated by unique Account/Session identity;
                // the iterator only needs a nonempty marker for this batch.
                return rows;
            },
        })) {
            // The iterator owns bounded continuation; accumulation happens in
            // `admitCandidates` so one Session may contribute to several Accounts.
            void rows;
        }

        for (const accountId of accountIds) {
            counts.set(accountId, countedSessionIds.get(accountId)?.size ?? 0);
        }

        // Discussion grants and private cursors establish their own attention,
        // including when a source Session is absent, revoked or untracked. An
        // anchor already represented by a counted Session must not count twice.
        for await (const rows of iterateBoundedSessionPersonalAttentionRows<{ id: string; anchorSessionId: string | null; lastMessageAt: Date }, string>({
            readCandidates: async ({ cursor, take }) => await tx.discussion.findMany({
                where: {
                    archivedAt: null,
                    readStates: { some: { accountId: { in: accountIds } } },
                    ...(cursor ? { id: { gt: cursor } } : {}),
                },
                orderBy: { id: "asc" },
                take,
                select: { id: true, anchorSessionId: true, lastMessageAt: true },
            }),
            cursorAfter: (rows) => rows[rows.length - 1]?.id ?? "",
            admitCandidates: async (rows) => {
                const discussionByAccount = await loadFirstClassDiscussionAttentionForAccountsInTx(tx, {
                    accountIds,
                    discussions: rows,
                    authentication: params.authentication,
                });
                for (const accountId of accountIds) {
                    for (const row of rows) {
                        if (row.anchorSessionId !== null && countedSessionIds.get(accountId)?.has(row.anchorSessionId)) continue;
                        if (!doesDiscussionViewerNeedAttention(discussionByAccount.get(accountId)?.get(row.id))) continue;
                        counts.set(accountId, (counts.get(accountId) ?? 0) + 1);
                    }
                }
                return rows;
            },
        })) {
            void rows;
        }
    }

    return counts;
}

/**
 * Scope arms are resolved through their viewer-keyed relation indexes in the
 * caller's snapshot and returned as Session ids, the same way the Discussion arms
 * already are. A correlated relation arm inside the scope's OR cannot be served
 * by any Session index, so PostgreSQL scanned every Account's Sessions per list
 * branch; ids let it combine the viewer's own index with exact id lookups.
 * Membership is unchanged: each set is exactly that arm's relation predicate.
 */
async function readActiveFollowSessionIds(tx: Tx, accountId: string): Promise<string[]> {
    // Active Follow only; an explicit suppression row is never a Following member.
    const rows = await tx.accountSessionFollow.findMany({
        where: { accountId, following: true, hasPersistentFollow: true, sessionId: { not: null } },
        select: { sessionId: true },
    });
    return rows.flatMap(row => row.sessionId === null ? [] : [row.sessionId]);
}

function sessionIdsWhere(...sets: ReadonlyArray<readonly string[]>): Prisma.SessionWhereInput {
    return { id: { in: [...new Set(sets.flat())] } };
}

/**
 * The participation arms of `involving_me`: ownership, responsibility, a genuine
 * direct share, and authenticated human authorship of either the Session
 * transcript (Lane 04's derived `SessionMessage.authorAccountId` projection) or
 * a discussion (Lane 05's human-origin predicate).
 *
 * Both authorship arms are existential and human-origin only. An Agent row
 * carrying its execution Account, and a requested-by association that carries no
 * author at all, are production facts rather than participation.
 *
 * A mention is deliberately absent: being named is My work relevance, not
 * participation (§4.3).
 */
async function createSessionParticipationWhere(tx: Tx, accountId: string): Promise<readonly Prisma.SessionWhereInput[]> {
    const [shares, authored, discussionAuthorship] = await Promise.all([
        tx.sessionGrant.findMany({ where: { principalKind: 'account', accountId: accountId }, select: { sessionId: true } }),
        // Owned Sessions already match the ownership arm; transcript authorship
        // only adds another Account's Session.
        tx.sessionMessage.groupBy({
            by: ["sessionId"],
            where: { authorAccountId: accountId, session: { accountId: { not: accountId } } },
        }),
        createSessionsWithHumanDiscussionAuthorshipWhere(tx, accountId),
    ]);
    return [
        { accountId },
        { responsibleAccountId: accountId },
        sessionIdsWhere(shares.map(row => row.sessionId), authored.map(row => row.sessionId)),
        discussionAuthorship,
    ];
}

/** Lane 07 composes these personal relations with the independent access predicate. */
export async function createSessionListScopeWhere(params: Readonly<{
    accountId: string;
    scope: SessionListScopeV1;
    tx?: Tx;
}>): Promise<Prisma.SessionWhereInput> {
    const { accountId, scope } = params;
    const tx = params.tx ?? db;
    if (scope === "all_accessible") return {};
    if (scope === "assigned_to_me") return { responsibleAccountId: accountId };
    if (scope === "following") return sessionIdsWhere(await readActiveFollowSessionIds(tx, accountId));
    if (scope === "involving_me") return { OR: [...await createSessionParticipationWhere(tx, accountId)] };
    // My work is any personal relevance reason: participation plus the personal
    // interest and organization facts. An explicit attention standing may add a
    // row; a negative one only removes its own contribution, and neither changes
    // tracking (L09B-I8).
    const [participation, mentions, follows, once, pins, standings] = await Promise.all([
        createSessionParticipationWhere(tx, accountId),
        createSessionsWithDiscussionMentionWhere(tx, accountId),
        readActiveFollowSessionIds(tx, accountId),
        tx.accountSessionFollow.findMany({
            where: { accountId, notifyOnce: { not: null }, sessionId: { not: null } }, select: { sessionId: true },
        }),
        tx.sessionPin.findMany({ where: { accountId }, select: { sessionId: true } }),
        tx.sessionAttentionStanding.findMany({
            where: { accountId, OR: [{ standing: true }, { remindAt: { not: null } }] }, select: { sessionId: true },
        }),
    ]);
    return { OR: [
        ...participation,
        mentions,
        sessionIdsWhere(
            follows,
            once.flatMap(row => row.sessionId === null ? [] : [row.sessionId]),
            pins.map(row => row.sessionId),
            standings.map(row => row.sessionId),
        ),
    ] };
}

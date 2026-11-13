import { projectSessionFollowFactsV1, type SessionFollowFactsV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';

import type { Tx } from "@/storage/inTx";

/** Shared projection for batched list reads and singular Follow facts. Malformed stored choices stay quiet. */
export function projectSessionFollowFacts(row: Readonly<{
    following: boolean;
    includeInVoice?: boolean;
    followPolicy?: string | null;
    notifyOnce?: string | null;
    hasPersistentFollow?: boolean;
}> | null): SessionFollowFactsV1 {
    return projectSessionFollowFactsV1(row);
}

/**
 * The narrow Follow-fact port this module consumes (Lane 09B §4.5).
 *
 * It is an input port, not a dependency on a particular Follow table or service:
 * the personal owner never imports Follow persistence, frontier, Voice or
 * daemon-delivery internals, and tests supply facts directly.
 *
 * Account Follow supplies interest, notification breadth, and (for current
 * full viewer projections) Voice inclusion here; the personal owner keeps
 * responsibility for tracking and event eligibility.
 */
export async function resolveSessionFollowFactsInTx(
    tx: Pick<Tx, "accountSessionFollow">,
    params: Readonly<{ accountId: string; sessionId: string }>,
): Promise<SessionFollowFactsV1> {
    const row = await tx.accountSessionFollow.findUnique({
        where: { accountId_sessionId: params },
        select: { following: true, followPolicy: true, notifyOnce: true, hasPersistentFollow: true },
    });
    return projectSessionFollowFacts(row);
}

/** An active Follow: a persistent Follow or an armed one-shot. `isActiveFollowRow` is the same rule per row. */
const ACTIVE_FOLLOW_WHERE = [{ following: true, hasPersistentFollow: true }, { notifyOnce: { not: null } }];
function isActiveFollowRow(row: Readonly<{ following: boolean; hasPersistentFollow: boolean; notifyOnce: string | null }>): boolean {
    return row.following && row.hasPersistentFollow || row.notifyOnce !== null;
}

/** Accounts holding an active Follow on one Session, for exact recipient scheduling. */
export async function listActivelyFollowingAccountIdsInTx(
    tx: Pick<Tx, "accountSessionFollow">,
    params: Readonly<{ sessionId: string }>,
): Promise<readonly string[]> {
    const rows = await tx.accountSessionFollow.findMany({
        where: { sessionId: params.sessionId, OR: ACTIVE_FOLLOW_WHERE },
        select: { accountId: true },
    });
    return rows.map(row => row.accountId);
}

export type SessionFollowCandidates = Readonly<{
    ownerAccountId: string;
    /** Exactly `listActivelyFollowingAccountIdsInTx`. */
    activelyFollowingAccountIds: readonly string[];
    /** Facts of the owner and every active follower; absent rows are the canonical non-Follow facts. */
    factsByAccountId: ReadonlyMap<string, SessionFollowFactsV1>;
}>;

/** The owner and the active followers of one Session, with their Follow facts, in one read. */
export async function readSessionFollowCandidatesInTx(
    tx: Pick<Tx, "accountSessionFollow">,
    params: Readonly<{ sessionId: string; ownerAccountId: string }>,
): Promise<SessionFollowCandidates> {
    const rows = await tx.accountSessionFollow.findMany({
        where: { sessionId: params.sessionId, OR: [...ACTIVE_FOLLOW_WHERE, { accountId: params.ownerAccountId }] },
        select: { accountId: true, following: true, followPolicy: true, notifyOnce: true, hasPersistentFollow: true },
    });
    return {
        ownerAccountId: params.ownerAccountId,
        activelyFollowingAccountIds: rows.filter(isActiveFollowRow).map(row => row.accountId),
        factsByAccountId: new Map(rows.map(row => [row.accountId, projectSessionFollowFacts(row)])),
    };
}

/** One query for the complete candidate set; absent rows project to the canonical non-Follow facts. */
export async function resolveSessionFollowFactsForAccountsInTx(
    tx: Pick<Tx, "accountSessionFollow">,
    params: Readonly<{ accountIds: readonly string[]; sessionId: string }>,
): Promise<ReadonlyMap<string, SessionFollowFactsV1>> {
    const rows = params.accountIds.length === 0 ? [] : await tx.accountSessionFollow.findMany({
        where: { sessionId: params.sessionId, accountId: { in: [...params.accountIds] } },
        select: { accountId: true, following: true, followPolicy: true, notifyOnce: true, hasPersistentFollow: true },
    });
    const byAccountId = new Map(rows.map((row) => [row.accountId, projectSessionFollowFacts(row)]));
    return new Map(params.accountIds.map((accountId) => [accountId, byAccountId.get(accountId) ?? projectSessionFollowFacts(null)]));
}

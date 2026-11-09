import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID, buildSessionFollowChangeHintV1, buildSessionFollowReceiverChangeEntityIdV1 } from '@happier-dev/protocol/sessions/follow/changes';
import { markAccountChanged, markAccountProjectionChanges, type AccountChangePublication } from "@/app/changes/markAccountChanged";
import { scheduleAccountActivityBadgeRefresh } from "@/app/activity/refreshAccountActivityBadgePushes";
import { afterTx, type Tx } from "@/storage/inTx";

/** Exact Follow demand has its own cursor-relative key, using the existing feed. */
export async function markSessionFollowReceiversChangedInTx(tx: Tx,
    recipientsBySession: ReadonlyMap<string, readonly string[]>): Promise<AccountChangePublication[]> {
    return markAccountProjectionChanges(tx, 'account', new Map([...recipientsBySession].map(([sessionId, recipients]) =>
        [buildSessionFollowReceiverChangeEntityIdV1(sessionId), recipients])));
}

/**
 * Set-form Follow invalidation for the exact affected Account set.
 *
 * Reuses the existing set-oriented AccountChange owner for cursors/wakes
 * (fixed statements regardless of set size), carrying the canonical Follow
 * hint in that same write. One badge schedule for the
 * whole set coalesces with per-Account schedules through the existing
 * coalescing owner, so closed devices converge without per-Account fanout.
 * The current consumer reloads the complete exact-Home Follow snapshot, so the
 * hint deliberately carries no per-Session or preference targeting vocabulary.
 */
export async function markSessionFollowsChangedForAccountsInTx(tx: Tx, accountIds: readonly string[]): Promise<AccountChangePublication[]> {
    const unique = [...new Set(accountIds)].filter(accountId => typeof accountId === 'string' && accountId.length > 0);
    if (unique.length === 0) return [];
    // The point writer publishes the singleton hint atomically and can run
    // inside an already-declared Account operation (for example a mute merge).
    // Multi-Account fanout retains the fixed-statement set publication path.
    const publications = unique.length === 1 ? [await markAccountChanged(tx, {
        accountId: unique[0],
        entityId: ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID,
        kind: 'account',
        hint: buildSessionFollowChangeHintV1(),
    })] : await markAccountProjectionChanges(tx, 'account',
        new Map([[ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID, unique]]), buildSessionFollowChangeHintV1());
    // Connected clients reread the snapshot above. Closed devices consume the
    // existing badge transport, after the relation/read-baseline commit.
    afterTx(tx, () => scheduleAccountActivityBadgeRefresh({ badgeAttentionChanged: true, accountIds: unique }));
    return publications;
}

/**
 * Coalesced private invalidation for the authenticated Account's own Follow
 * configuration.
 *
 * Delegates to the set form so there is one decision/implementation; the
 * current consumer reloads the complete exact-Home Follow snapshot, so the
 * hint deliberately carries no per-Session or preference targeting vocabulary.
 */
export async function markSessionFollowsChangedInTx(tx: Tx, input: Readonly<{
    accountId: string;
}>): Promise<AccountChangePublication> {
    const [publication] = await markSessionFollowsChangedForAccountsInTx(tx, [input.accountId]);
    if (!publication) throw new Error('Follow publication requires its Account recipient');
    return publication;
}

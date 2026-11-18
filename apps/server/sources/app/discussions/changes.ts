import { DISCUSSION_CHANGE_HINT_V1, DISCUSSION_READ_STATE_CHANGE_HINT_V1 } from '@happier-dev/protocol/discussions';
import { assertAccountChangePublicationAudienceInTx, beforeAccountChangePublication, markAccountsChanged, type AccountChangePublication } from '@/app/changes/markAccountChanged';
import { scheduleAccountActivityBadgeRefresh } from '@/app/activity/refreshAccountActivityBadgePushes';
import { afterTx, type Tx } from '@/storage/inTx';
import { resolveDiscussionAudienceInTx, resolveDiscussionAudiencesInTx } from './access';
import { notifyDiscussionHumanPresenceAccessChanged } from '@/app/session/humanPresence/sessionHumanPresenceService';

/** First-class invalidation reaches the current resource audience after commit. */
export async function markDiscussionReadersChangedInTx(input: Readonly<{
    tx: Tx; discussionId: string; additionalAccountIds?: readonly string[]; accessChanged?: boolean;
}>): Promise<AccountChangePublication[]> {
    const audience = await resolveDiscussionAudienceInTx(input.tx, input.discussionId);
    return markDiscussionAudiencesChangedInTx(input.tx,
        new Map([[input.discussionId, [...audience, ...input.additionalAccountIds ?? []]]]), input.accessChanged);
}

/** Revalidate the current audiences together at the terminal Account publication boundary. */
export async function markDiscussionAudiencesChangedInTx(
    tx: Tx, audiences: ReadonlyMap<string, readonly string[]>, accessChanged?: boolean,
): Promise<AccountChangePublication[]> {
    if (audiences.size === 0) return [];
    const discussionIds = [...audiences.keys()];
    beforeAccountChangePublication(tx, [...audiences.values()].flat(), async publicationTx => {
        const current = await resolveDiscussionAudiencesInTx(publicationTx, discussionIds);
        assertAccountChangePublicationAudienceInTx(publicationTx, [...current.values()].flat());
    });
    const cursors: AccountChangePublication[] = [];
    for (const [discussionId, accountIds] of audiences) {
        for (const publication of await markAccountsChanged(tx, {
            accountIds, kind: 'discussion', entityId: discussionId, hint: DISCUSSION_CHANGE_HINT_V1,
        })) cursors.push(publication);
        if (accessChanged) afterTx(tx, () => { notifyDiscussionHumanPresenceAccessChanged({ discussionId }); });
    }
    return cursors;
}

/** A private cursor update never reveals another person's progress. */
export async function markDiscussionPrivateReaderChangedInTx(input: Readonly<{
    tx: Tx; discussionId: string; accountId: string;
}>): Promise<void> {
    await markAccountsChanged(input.tx, { accountIds: [input.accountId], kind: 'discussion', entityId: input.discussionId, hint: DISCUSSION_READ_STATE_CHANGE_HINT_V1 });
}

/** Badge policy remains at the Account activity owner; Discussion adds no notifier. */
export function scheduleDiscussionBadgeRefreshInTx(input: Readonly<{
    tx: Tx; accountIds: readonly string[];
}>): void {
    afterTx(input.tx, () => { scheduleAccountActivityBadgeRefresh({ badgeAttentionChanged: true, accountIds: [...input.accountIds] }); });
}

export function scheduleDiscussionReaderBadgeRefreshInTx(input: Readonly<{ tx: Tx; accountId: string }>): void {
    scheduleDiscussionBadgeRefreshInTx({ tx: input.tx, accountIds: [input.accountId] });
}

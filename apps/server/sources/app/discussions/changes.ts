import { DISCUSSION_CHANGE_HINT_V1, DISCUSSION_READ_STATE_CHANGE_HINT_V1 } from '@happier-dev/protocol/discussions';
import { assertAccountChangePublicationAudienceInTx, beforeAccountChangePublication, markAccountsChanged, type AccountChangePublication } from '@/app/changes/markAccountChanged';
import { scheduleAccountActivityBadgeRefresh } from '@/app/activity/refreshAccountActivityBadgePushes';
import { afterTx, type Tx } from '@/storage/inTx';
import { resolveDiscussionAudienceInTx } from './access';
import { notifyDiscussionHumanPresenceAccessChanged } from '@/app/session/humanPresence/sessionHumanPresenceService';

/** First-class invalidation reaches the current resource audience after commit. */
export async function markDiscussionReadersChangedInTx(input: Readonly<{
    tx: Tx; discussionId: string; additionalAccountIds?: readonly string[]; accessChanged?: boolean;
}>): Promise<AccountChangePublication[]> {
    const accountIds = [...await resolveDiscussionAudienceInTx(input.tx, input.discussionId), ...(input.additionalAccountIds ?? [])];
    beforeAccountChangePublication(input.tx, accountIds, async tx => {
        assertAccountChangePublicationAudienceInTx(tx, await resolveDiscussionAudienceInTx(tx, input.discussionId));
    });
    const cursors = await markAccountsChanged(input.tx, {
        accountIds,
        kind: 'discussion', entityId: input.discussionId, hint: DISCUSSION_CHANGE_HINT_V1,
    });
    if (input.accessChanged) afterTx(input.tx, () => { notifyDiscussionHumanPresenceAccessChanged({ discussionId: input.discussionId }); });
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

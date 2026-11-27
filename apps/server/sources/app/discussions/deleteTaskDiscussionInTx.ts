import { afterTx, type Tx } from '@/storage/inTx';
import { deletePrivateFile } from '@/storage/blob/files';
import { detachDiscussionFollowSourceInTx } from '@/app/session/follow/sessionFollowEdgeService';
import { withdrawDiscussionInputRepliesInTx } from '@/app/session/messages/sessionMessageReply';
import { markDiscussionAudiencesChangedInTx, scheduleDiscussionBadgeRefreshInTx } from './changes';
import { taskDiscussionId } from './taskDiscussionIdentity';

/**
 * Atomically deletes an internal Task's anchored Discussion thread inside the
 * Task-deletion transaction, withdrawing active follow/reply obligations and
 * publishing the content-free invalidation to the Task's prior audience.
 */
export async function deleteTaskDiscussionInTx(tx: Tx, input: Readonly<{
    taskRowId: string;
    ownerAccountId: string;
    audienceAccountIds: readonly string[];
}>): Promise<boolean> {
    const discussionId = taskDiscussionId(input.taskRowId);
    const discussion = await tx.discussion.findUnique({
        where: { id: discussionId },
        select: {
            id: true,
            ownerAccountId: true,
            messages: {
                select: {
                    attachments: {
                        where: { removedByAccountId: null },
                        select: { storageKey: true },
                    },
                },
            },
        },
    });
    if (!discussion || discussion.ownerAccountId !== input.ownerAccountId) return false;

    const attachmentStorageKeys = discussion.messages.flatMap(message =>
        message.attachments.map(attachment => attachment.storageKey));

    await withdrawDiscussionInputRepliesInTx(tx, { discussionId: discussion.id });
    await detachDiscussionFollowSourceInTx(tx, { discussionId: discussion.id });
    await tx.discussion.delete({ where: { id: discussion.id } });

    const audience = [...new Set([input.ownerAccountId, ...input.audienceAccountIds])];
    const cursors = await markDiscussionAudiencesChangedInTx(tx, new Map([[discussion.id, audience]]), true);
    scheduleDiscussionBadgeRefreshInTx({ tx, accountIds: cursors.map(row => row.accountId) });

    if (attachmentStorageKeys.length > 0) {
        afterTx(tx, async () => {
            await Promise.allSettled(attachmentStorageKeys.map(key => deletePrivateFile(key)));
        });
    }
    return true;
}

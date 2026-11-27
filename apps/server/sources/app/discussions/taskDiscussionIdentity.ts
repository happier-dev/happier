import { createHash } from 'node:crypto';
import { EXTERNAL_TASK_DISCUSSION_ID_PREFIX, isExternalTaskDiscussionId } from '@happier-dev/protocol/discussions/references';
import { internalTaskAddressFromRefV1, isInternalTaskReferenceV1, type TriageEntryRefV1 } from '@happier-dev/protocol/tasks/entryRefV1';
import type { Tx } from '@/storage/inTx';

export const TASK_DISCUSSION_ID_PREFIX = 'task-discussion-task-';

export function taskDiscussionId(taskRowId: string): string {
    return `${TASK_DISCUSSION_ID_PREFIX}${taskRowId}`;
}

export function taskRowIdForDiscussion(discussionId: string): string | null {
    return discussionId.startsWith(TASK_DISCUSSION_ID_PREFIX) ? discussionId.slice(TASK_DISCUSSION_ID_PREFIX.length) : null;
}

export function isManagedTaskDiscussionId(discussionId: string): boolean {
    return taskRowIdForDiscussion(discussionId) !== null || isExternalTaskDiscussionId(discussionId);
}

// External references are identities, not audience assertions. In the absence
// of a shared source admission the exact identity belongs to this Account.
export function personalExternalTaskDiscussionId(accountId: string, ref: TriageEntryRefV1): string {
    const identity = JSON.stringify([accountId, ref.source.pluginId, ref.source.localId, ref.kindId, ref.collisionScope, ref.entryId]);
    return `${EXTERNAL_TASK_DISCUSSION_ID_PREFIX}${createHash('sha256').update(identity).digest('hex')}`;
}

/** Address matching only. The Discussion HTTP operation retains Task grant admission. */
export async function readTaskDiscussionIdForAnchorInTx(tx: Tx, accountId: string, ref: TriageEntryRefV1): Promise<string | null> {
    if (!isInternalTaskReferenceV1(ref)) return personalExternalTaskDiscussionId(accountId, ref);
    const address = internalTaskAddressFromRefV1(ref, accountId);
    if (!address) return null;
    const row = await tx.userKVStore.findUnique({
        where: { accountId_key: { accountId: address.ownerAccountId, key: `todo.${address.taskId}` } },
        select: { id: true },
    });
    return row ? taskDiscussionId(row.id) : null;
}

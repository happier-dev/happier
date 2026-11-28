import { createHash } from 'node:crypto';
import { EXTERNAL_TASK_DISCUSSION_ID_PREFIX } from '@happier-dev/protocol/discussions/references';
import { DiscussionAnchorV1Schema } from '@happier-dev/protocol/discussions/replyTargets';
import { internalTaskAddressFromRefV1, isInternalTaskReferenceV1, type TriageEntryRefV1 } from '@happier-dev/protocol/tasks/entryRefV1';
import type { Tx } from '@/storage/inTx';

export const TASK_DISCUSSION_ID_PREFIX = 'task-discussion-task-';

export function taskDiscussionId(taskRowId: string): string {
    return `${TASK_DISCUSSION_ID_PREFIX}${taskRowId}`;
}

export function taskRowIdForDiscussion(discussionId: string): string | null {
    return discussionId.startsWith(TASK_DISCUSSION_ID_PREFIX) ? discussionId.slice(TASK_DISCUSSION_ID_PREFIX.length) : null;
}

/** Only internal Happier Task discussions inherit Task grants + Task DEK; external Internal threads use DiscussionGrant + DiscussionKeyEnvelope. */
export function isManagedTaskDiscussionId(discussionId: string): boolean {
    return taskRowIdForDiscussion(discussionId) !== null;
}

// External references are identities, not audience assertions. Each creator's
// thread id stays deterministic under EXTERNAL_TASK_DISCUSSION_ID_PREFIX so
// unshared Accounts never collide while sharing uses canonical DiscussionGrant.
export function personalExternalTaskDiscussionId(accountId: string, ref: TriageEntryRefV1): string {
    const identity = JSON.stringify([accountId, ref.source.pluginId, ref.source.localId, ref.kindId, ref.collisionScope, ref.entryId]);
    return `${EXTERNAL_TASK_DISCUSSION_ID_PREFIX}${createHash('sha256').update(identity).digest('hex')}`;
}

export function matchesExternalTaskAnchor(anchorV1: unknown, ref: TriageEntryRefV1): boolean {
    const parsed = DiscussionAnchorV1Schema.safeParse(anchorV1);
    if (!parsed.success || parsed.data.kind !== 'task') return false;
    const entry = parsed.data.entry;
    return entry.source.pluginId === ref.source.pluginId
        && entry.source.localId === ref.source.localId
        && entry.kindId === ref.kindId
        && entry.collisionScope === ref.collisionScope
        && entry.entryId === ref.entryId;
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

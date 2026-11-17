import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { DocEditProposalDispositionV1Schema, type DocEditProposalDispositionV1, type DiscussionMessageV1 } from '@happier-dev/protocol/discussions/models';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { Tx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { resolveDbSqlDialect } from '@/config/databaseProvider';
import { readDiscussionMessageInTx } from './queries';
import { resolveDiscussionDocSourcesInTx, resolveDiscussionDocTargetInTx, type DiscussionDocSource } from './docPassages';
import { markDiscussionReadersChangedInTx, scheduleDiscussionBadgeRefreshInTx } from './changes';
import { discussionFailure, discussionSuccess, type DiscussionResult } from './serviceTypes';

export interface StoredDocEditProposal {
    message: DiscussionMessageV1;
    source: DiscussionDocSource;
}

/** Discover immutable reply ancestry before C5 admits either resource's Accounts. */
export async function discoverDocEditProposalSourceInTx(tx: Tx, proposalRef: DiscussionMessageRefV1): Promise<DiscussionDocSource | null> {
    const message = await tx.discussionMessage.findFirst({ where: {
        id: proposalRef.messageId, discussionId: proposalRef.discussion.discussionId,
    }, select: { id: true, replyTargetV1: true } });
    if (!message) return null;
    const sources = await resolveDiscussionDocSourcesInTx(tx, {
        discussionId: proposalRef.discussion.discussionId, messages: [message],
    });
    return sources.ok ? sources.value.get(message.id) ?? null : null;
}

/** Lock the existing immutable message row; SQLite's containing writer transaction owns serialization. */
async function lockProposalMessageInTx(tx: Tx, proposalRef: DiscussionMessageRefV1): Promise<void> {
    const provider = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    if (provider === 'sqlite') return;
    if (provider === 'postgres') {
        await tx.$queryRawUnsafe('SELECT "id" FROM "DiscussionMessage" WHERE "id" = $1 AND "discussionId" = $2 FOR UPDATE',
            proposalRef.messageId, proposalRef.discussion.discussionId);
    } else {
        await tx.$queryRawUnsafe('SELECT `id` FROM `DiscussionMessage` WHERE `id` = ? AND `discussionId` = ? FOR UPDATE',
            proposalRef.messageId, proposalRef.discussion.discussionId);
    }
}

/** C5 owns complete Account admission before this exact message/resource lock, including settled retries. */
export async function readDocEditProposalInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; authentication: SessionAccessAuthentication; proposalRef: DiscussionMessageRefV1;
}>): Promise<DiscussionResult<StoredDocEditProposal>> {
    await lockProposalMessageInTx(tx, input.proposalRef);
    const read = await readDiscussionMessageInTx(tx, { actorAccountId: input.actorAccountId, authentication: input.authentication,
        discussionId: input.proposalRef.discussion.discussionId, messageId: input.proposalRef.messageId });
    if (!read.ok) return read;
    const source = await resolveDiscussionDocTargetInTx(tx, { discussionId: input.proposalRef.discussion.discussionId,
        replyTarget: read.value.replyTarget });
    if (!source.ok) return source;
    // The authenticated HTTP Home and exact admitted row/ancestry establish custody.
    // Client-local Home profile labels are not portable server identities.
    if (!source.value) return discussionFailure('discussion_invalid_reply_target');
    return discussionSuccess({ message: read.value, source: source.value });
}

/** Only the person-authorized C5 owner writes this same-row transition; no authored message patch can call it. */
export async function setDocEditProposalDispositionInTx(tx: Tx, input: Readonly<{
    proposalRef: DiscussionMessageRefV1; expectedDisposition: 'open';
    disposition: Exclude<DocEditProposalDispositionV1, { state: 'open' }>;
}>): Promise<boolean> {
    const disposition = DocEditProposalDispositionV1Schema.safeParse(input.disposition);
    if (!disposition.success || disposition.data.state === 'open') return false;
    const changed = await tx.discussionMessage.updateMany({
        where: { id: input.proposalRef.messageId, discussionId: input.proposalRef.discussion.discussionId,
            docEditProposalDispositionV1: { equals: { state: input.expectedDisposition } } },
        data: { docEditProposalDispositionV1: disposition.data },
    });
    if (changed.count !== 1) return false;
    const cursors = await markDiscussionReadersChangedInTx({ tx, discussionId: input.proposalRef.discussion.discussionId });
    scheduleDiscussionBadgeRefreshInTx({ tx, accountIds: cursors.map(row => row.accountId) });
    return true;
}

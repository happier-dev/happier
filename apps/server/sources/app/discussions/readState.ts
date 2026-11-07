import { DISCUSSION_NOT_TRACKED_CODE_V1 } from '@happier-dev/protocol/discussions/api';
import type { DiscussionReadCursorV1 } from '@happier-dev/protocol/discussions/models';
import { prismaRuntime as Prisma, getDbProviderFromEnv } from '@/storage/prisma';
import { inTx, type Tx } from '@/storage/inTx';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { acquireDiscussionMutationAccountsInTx, resolveDiscussionContextInTx } from './access';
import { markDiscussionPrivateReaderChangedInTx, scheduleDiscussionReaderBadgeRefreshInTx } from './changes';
import { readDiscussionRowInTx } from './queries';
import { discussionFailure, discussionSuccess, type DiscussionResult } from './serviceTypes';

/** The sole insert-only baseline writer serves first posts and later grant entry. */
export async function initializeDiscussionReadBaselinesInTx(tx: Tx, input: Readonly<{
    discussionId: string; accountIds: readonly string[]; lastReadSeq: number;
}>): Promise<number> {
    const ids = [...new Set(input.accountIds)];
    let inserted = 0;
    // Four SQLite binds per row stay within its existing 999-variable boundary.
    const chunkSize = 200;
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
        const chunk = ids.slice(offset, offset + chunkSize);
        if (getDbProviderFromEnv(process.env, 'postgres') === 'sqlite') {
            const now = new Date();
            const rows = Prisma.join(chunk.map(accountId => Prisma.sql`(${input.discussionId}, ${accountId}, ${input.lastReadSeq}, ${now})`));
            inserted += await tx.$executeRaw(Prisma.sql`INSERT INTO "DiscussionReadState" ("discussionId", "accountId", "lastReadSeq", "updatedAt") VALUES ${rows} ON CONFLICT("discussionId", "accountId") DO NOTHING`);
        } else {
            inserted += (await tx.discussionReadState.createMany({ data: chunk.map(accountId => ({ discussionId: input.discussionId, accountId, lastReadSeq: input.lastReadSeq })), skipDuplicates: true })).count;
        }
    }
    return inserted;
}

/** Explicit visible-read acknowledgements are private, monotonic and grant-admitted. */
export async function setDiscussionReadCursor(input: Readonly<{
    actorAccountId: string; discussionId: string; lastReadSeq: number; authentication: SessionAccessAuthentication;
}>): Promise<DiscussionResult<DiscussionReadCursorV1>> {
    return inTx(async tx => {
        await acquireDiscussionMutationAccountsInTx(tx, { ...input, includeDiscussionPublication: false });
        const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: input.actorAccountId, authentication: input.authentication });
        if (!context) return discussionFailure('discussion_not_found');
        // Tools may read but cannot silently acknowledge for a person.
        if (input.authentication.authority !== 'present_user' || input.authentication.sessionRuntimePrincipal) return discussionFailure('discussion_read_denied');
        const discussion = await readDiscussionRowInTx(tx, input);
        if (!discussion) return discussionFailure('discussion_not_found');
        if (!Number.isSafeInteger(input.lastReadSeq) || input.lastReadSeq < 0 || input.lastReadSeq > discussion.messageSeq) return discussionFailure('discussion_read_cursor_invalid');
        const where = { discussionId_accountId: { discussionId: discussion.id, accountId: input.actorAccountId } };
        const existing = await tx.discussionReadState.findUnique({ where, select: { lastReadSeq: true } });
        if (!existing) return discussionFailure(DISCUSSION_NOT_TRACKED_CODE_V1);
        const next = Math.max(existing.lastReadSeq, input.lastReadSeq);
        if (next === existing.lastReadSeq) return discussionSuccess({ discussionId: discussion.id, lastReadSeq: next, didChange: false });
        const updated = await tx.discussionReadState.updateMany({ where: { discussionId: discussion.id, accountId: input.actorAccountId, lastReadSeq: { lt: next } }, data: { lastReadSeq: next } });
        if (updated.count === 0) {
            const fresh = await tx.discussionReadState.findUnique({ where, select: { lastReadSeq: true } });
            return discussionSuccess({ discussionId: discussion.id, lastReadSeq: fresh?.lastReadSeq ?? existing.lastReadSeq, didChange: false });
        }
        await markDiscussionPrivateReaderChangedInTx({ tx, discussionId: discussion.id, accountId: input.actorAccountId });
        scheduleDiscussionReaderBadgeRefreshInTx({ tx, accountId: input.actorAccountId });
        return discussionSuccess({ discussionId: discussion.id, lastReadSeq: next, didChange: true });
    });
}

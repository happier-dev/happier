import { isDeepStrictEqual } from 'node:util';
import { DiscussionRoundOutcomeV1Schema, DiscussionRoundOutcomeV1StoredSchema,
    type DiscussionRoundOutcomeV1 } from '@happier-dev/protocol/discussions/models';
import type { Tx } from '@/storage/inTx';
import { acquireDiscussionMutationAccountsInTx } from './access';
import { markDiscussionReadersChangedInTx } from './changes';

/** A newly admitted built-in Run replaces the previous presentation outcome, under the existing parent lock. */
export async function initializeDiscussionRoundOutcomeInTx(tx: Tx, input: Readonly<{
    discussionId: string; runId: string; pattern: DiscussionRoundOutcomeV1['pattern'];
}>): Promise<void> {
    await acquireDiscussionMutationAccountsInTx(tx, { discussionId: input.discussionId });
    await tx.discussion.update({ where: { id: input.discussionId }, data: {
        roundOutcomeV1: DiscussionRoundOutcomeV1Schema.parse({ runId: input.runId, pattern: input.pattern,
            answerCount: 0, synthesized: false, settled: false }),
    } });
    await markDiscussionReadersChangedInTx({ tx, discussionId: input.discussionId });
}

/** Accepted workflow writes refresh only their own still-current round; superseded Runs cannot overwrite it. */
export async function updateDiscussionRoundOutcomeInTx(tx: Tx, input: Readonly<{
    discussionId: string; runId: string; answerCount: number; synthesized: boolean; settled: boolean;
}>): Promise<void> {
    await acquireDiscussionMutationAccountsInTx(tx, { discussionId: input.discussionId });
    const row = await tx.discussion.findUnique({ where: { id: input.discussionId }, select: { roundOutcomeV1: true } });
    const current = DiscussionRoundOutcomeV1StoredSchema.safeParse(row?.roundOutcomeV1);
    if (!current.success || current.data.runId !== input.runId) return;
    const next = DiscussionRoundOutcomeV1Schema.parse({ runId: current.data.runId, pattern: current.data.pattern,
        answerCount: input.answerCount, synthesized: input.synthesized, settled: input.settled });
    if (isDeepStrictEqual(current.data, next)) return;
    await tx.discussion.update({ where: { id: input.discussionId }, data: { roundOutcomeV1: next } });
    await markDiscussionReadersChangedInTx({ tx, discussionId: input.discussionId });
}

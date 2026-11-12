import type { Tx } from "@/storage/inTx";
import { portableQueryChunks } from "@/storage/portableQueryChunks";

/** Discovery and physical cleanup consume the same retained grant predicates. */
export async function readDiscussionAccessGrantsForAccountErasureInTx(tx: Tx, accountId: string): Promise<Array<{ id: string; ownerAccountId: string }>> {
    const [owned, received, authored, teams, groups] = await Promise.all([
        tx.discussion.findMany({ where: { ownerAccountId: accountId }, select: { id: true, ownerAccountId: true } }),
        tx.discussionAccountGrant.findMany({ where: { accountId }, select: { discussionId: true } }),
        tx.discussionAccountGrant.findMany({ where: { createdByAccountId: accountId }, select: { discussionId: true } }),
        tx.discussionTeamGrant.findMany({ where: { createdByAccountId: accountId }, select: { discussionId: true } }),
        tx.discussionGroupGrant.findMany({ where: { createdByAccountId: accountId }, select: { discussionId: true } }),
    ]);
    const ownedIds = new Set(owned.map(row => row.id));
    const foreignIds = [...new Set([...received, ...authored, ...teams, ...groups].map(grant => grant.discussionId))]
        .filter(id => !ownedIds.has(id));
    const rows = [...owned];
    for (const ids of portableQueryChunks({ values: foreignIds, bindingsPerValue: 1 })) {
        rows.push(...await tx.discussion.findMany({ where: { id: { in: [...ids] } }, select: { id: true, ownerAccountId: true } }));
    }
    return rows;
}

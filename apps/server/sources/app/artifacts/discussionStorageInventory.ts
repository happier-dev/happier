import type { StorageInventoryKindV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import type { DiscussionContext } from '@/app/discussions/access';
import { resolveDiscussionQuoteReadabilityInTx } from '@/app/discussions/quoteReadAdmission';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { Tx } from '@/storage/inTx';
import { readStorageInventoryInTx } from './artifactStorageService';

/** Bill the admitted owner for all files, while participants see only their readable messages. */
export async function readDiscussionStorageInventoryInTx(tx: Tx, input: Readonly<{
    accountId: string;
    authentication: SessionAccessAuthentication;
    discussion: DiscussionContext;
    kinds?: readonly StorageInventoryKindV1[];
    cursor?: string;
}>) {
    const { accountId, authentication, discussion, kinds, cursor } = input;
    const discussionId = discussion.discussionId;
    let withheldMessageIds: string[] = [];
    if (accountId !== discussion.ownerAccountId) {
        const storedTargets = await tx.discussionMessage.findMany({
            where: { discussionId, attachments: { some: { removedByAccountId: null } } },
            select: { id: true, replyTargetV1: true },
        });
        const quotes = await resolveDiscussionQuoteReadabilityInTx(tx, {
            actorAccountId: accountId, authentication, groups: [{ discussionId, storedTargets }],
        });
        if (!quotes.ok) return null;
        withheldMessageIds = [...quotes.value.failures.keys()];
    }
    return readStorageInventoryInTx(tx, accountId, { discussion: { id: discussionId, withheldMessageIds }, kinds, cursor });
}

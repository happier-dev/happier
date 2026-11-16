import { decodeSessionStoredContent, withSessionContentSelect } from '@/storage/sessionMachineStoredContent';
import type { Tx } from '@/storage/inTx';
import type { Prisma } from '@prisma/client';

/**
 * Load the Session a guarded delete is allowed to target.
 *
 * It no longer selects direct shares: recipients are resolved by the canonical
 * Session access recipient owner, which also reaches Team- and Group-granted
 * collaborators. A delete-specific recipient query would be a second, narrower
 * answer to a question access already owns.
 */
const sessionDeleteTargetSelect = {
    id: true,
    accountId: true,
    active: true,
    metadataLayoutVersion: true,
    updatedAt: true,
} satisfies Prisma.SessionSelect;

export type SessionDeleteTarget = Prisma.SessionGetPayload<{
    select: typeof sessionDeleteTargetSelect;
}>;

export async function loadSessionDeleteRecipients(
    tx: Tx,
    params: {
        sessionId: string;
        ownerAccountId?: string | null;
        sessionWhereGuard?: Prisma.SessionWhereInput;
    },
): Promise<SessionDeleteTarget | null> {
    const where = params.ownerAccountId
        ? { ...(params.sessionWhereGuard ?? {}), id: params.sessionId, accountId: params.ownerAccountId }
        : { ...(params.sessionWhereGuard ?? {}), id: params.sessionId };

    return await tx.session.findFirst({
        where,
        select: withSessionContentSelect(sessionDeleteTargetSelect),
    }).then(decodeSessionStoredContent);
}

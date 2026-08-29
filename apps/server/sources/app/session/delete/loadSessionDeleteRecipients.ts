import type { Tx } from '@/storage/inTx';
import type { Prisma } from '@prisma/client';

const sessionDeleteTargetSelect = {
    id: true,
    accountId: true,
    metadataLayoutVersion: true,
    updatedAt: true,
    shares: {
        select: {
            sharedWithUserId: true,
        },
    },
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
        select: sessionDeleteTargetSelect,
    });
}

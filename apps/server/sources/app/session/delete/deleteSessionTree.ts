import type { Tx } from '@/storage/inTx';
import type { Prisma } from '@prisma/client';

export class SessionDeleteConditionLostError extends Error {
    constructor() {
        super('Session no longer matches delete conditions');
        this.name = 'SessionDeleteConditionLostError';
    }
}

export async function deleteSessionTree(
    tx: Tx,
    params: {
        sessionId: string;
        sessionUpdatedAt: Date;
        actorAccountId: string;
        reason: 'user_request' | 'retention_policy';
        sessionDeleteWhere?: Prisma.SessionWhereInput;
        afterSessionWriteBoundary?: () => Promise<void>;
    },
): Promise<{
    deletedMessages: number;
    deletedReports: number;
    deletedAccessKeys: number;
}> {
    const sessionWhere = params.sessionDeleteWhere
        ? {
            AND: [
                { id: params.sessionId },
                params.sessionDeleteWhere,
            ],
        }
        : { id: params.sessionId };

    // Transcript writers allocate Session.seq before inserting their child row. Crossing the same
    // row-write boundary first lets earlier writers commit before the child sweep and makes later
    // writers wait until the parent has been deleted. The increment is not externally observable:
    // this row is deleted in the same transaction, or the transaction rolls it back.
    const claimedSession = await tx.session.updateMany({
        where: sessionWhere,
        data: {
            seq: { increment: 1 },
            updatedAt: params.sessionUpdatedAt,
        },
    });
    if (claimedSession.count !== 1) {
        throw new SessionDeleteConditionLostError();
    }
    await params.afterSessionWriteBoundary?.();

    const deletedMessages = await tx.sessionMessage.deleteMany({
        where: { sessionId: params.sessionId },
    });

    const deletedReports = await tx.usageReport.deleteMany({
        where: { sessionId: params.sessionId },
    });

    const deletedAccessKeys = await tx.accessKey.deleteMany({
        where: { sessionId: params.sessionId },
    });

    const deletedSession = await tx.session.deleteMany({
        where: sessionWhere,
    });
    if (deletedSession.count !== 1) {
        throw new SessionDeleteConditionLostError();
    }

    return {
        deletedMessages: deletedMessages.count,
        deletedReports: deletedReports.count,
        deletedAccessKeys: deletedAccessKeys.count,
    };
}

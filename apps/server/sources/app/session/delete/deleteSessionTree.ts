import type { Prisma } from '@prisma/client';

export class SessionDeleteConditionLostError extends Error {
    constructor() {
        super('Session no longer matches delete conditions');
        this.name = 'SessionDeleteConditionLostError';
    }
}

export async function deleteSessionTree(
    tx: {
        sessionMessage: { deleteMany: (args: { where: { sessionId: string } }) => Promise<{ count: number }> };
        usageReport: { deleteMany: (args: { where: { sessionId: string } }) => Promise<{ count: number }> };
        accessKey: { deleteMany: (args: { where: { sessionId: string } }) => Promise<{ count: number }> };
        session: { deleteMany: (args: { where: Prisma.SessionWhereInput }) => Promise<{ count: number }> };
    },
    params: {
        sessionId: string;
        actorAccountId: string;
        reason: 'user_request' | 'retention_policy';
        sessionDeleteWhere?: Prisma.SessionWhereInput;
    },
): Promise<{
    deletedMessages: number;
    deletedReports: number;
    deletedAccessKeys: number;
}> {
    const children = await deleteSessionTranscriptChildren(tx, params.sessionId);

    const deletedSession = await tx.session.deleteMany({
        where: params.sessionDeleteWhere
            ? {
                AND: [
                    { id: params.sessionId },
                    params.sessionDeleteWhere,
                ],
            }
            : { id: params.sessionId },
    });
    if (deletedSession.count !== 1) {
        throw new SessionDeleteConditionLostError();
    }

    return children;
}

export async function deleteSessionTranscriptChildren(
    tx: {
        sessionMessage: { deleteMany: (args: { where: { sessionId: string } }) => Promise<{ count: number }> };
        usageReport: { deleteMany: (args: { where: { sessionId: string } }) => Promise<{ count: number }> };
        accessKey: { deleteMany: (args: { where: { sessionId: string } }) => Promise<{ count: number }> };
    },
    sessionId: string,
) {
    const deletedMessages = await tx.sessionMessage.deleteMany({
        where: { sessionId },
    });

    const deletedReports = await tx.usageReport.deleteMany({
        where: { sessionId },
    });

    const deletedAccessKeys = await tx.accessKey.deleteMany({
        where: { sessionId },
    });

    return {
        deletedMessages: deletedMessages.count,
        deletedReports: deletedReports.count,
        deletedAccessKeys: deletedAccessKeys.count,
    };
}

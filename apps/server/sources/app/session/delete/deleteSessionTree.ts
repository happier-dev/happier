export class SessionDeleteConditionLostError extends Error {
    constructor() {
        super('Session no longer matches delete conditions');
        this.name = 'SessionDeleteConditionLostError';
    }
}

export async function deleteSessionTree(
    tx: {
        sessionMessage: { deleteMany: (args: unknown) => Promise<{ count: number }> };
        usageReport: { deleteMany: (args: unknown) => Promise<{ count: number }> };
        accessKey: { deleteMany: (args: unknown) => Promise<{ count: number }> };
        session: { deleteMany: (args: unknown) => Promise<{ count: number }> };
    },
    params: {
        sessionId: string;
        actorAccountId: string;
        reason: 'user_request' | 'retention_policy';
        sessionDeleteWhere?: Record<string, unknown>;
    },
): Promise<{
    deletedMessages: number;
    deletedReports: number;
    deletedAccessKeys: number;
}> {
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

    return {
        deletedMessages: deletedMessages.count,
        deletedReports: deletedReports.count,
        deletedAccessKeys: deletedAccessKeys.count,
    };
}

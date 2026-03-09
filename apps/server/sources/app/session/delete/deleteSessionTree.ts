import { log } from '@/utils/logging/log';

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
): Promise<void> {
    const deletedMessages = await tx.sessionMessage.deleteMany({
        where: { sessionId: params.sessionId },
    });
    log(
        { module: 'session-delete', userId: params.actorAccountId, sessionId: params.sessionId, deletedCount: deletedMessages.count, reason: params.reason },
        `Deleted ${deletedMessages.count} session messages`,
    );

    const deletedReports = await tx.usageReport.deleteMany({
        where: { sessionId: params.sessionId },
    });
    log(
        { module: 'session-delete', userId: params.actorAccountId, sessionId: params.sessionId, deletedCount: deletedReports.count, reason: params.reason },
        `Deleted ${deletedReports.count} usage reports`,
    );

    const deletedAccessKeys = await tx.accessKey.deleteMany({
        where: { sessionId: params.sessionId },
    });
    log(
        { module: 'session-delete', userId: params.actorAccountId, sessionId: params.sessionId, deletedCount: deletedAccessKeys.count, reason: params.reason },
        `Deleted ${deletedAccessKeys.count} access keys`,
    );

    const deletedSession = await tx.session.deleteMany({
        where: {
            id: params.sessionId,
            ...(params.sessionDeleteWhere ?? null),
        },
    });
    if (deletedSession.count !== 1) {
        throw new SessionDeleteConditionLostError();
    }
    log(
        { module: 'session-delete', userId: params.actorAccountId, sessionId: params.sessionId, reason: params.reason },
        'Session deleted successfully',
    );
}

import type { UsageAnalyticsQueryRequest } from "@happier-dev/protocol";
import { db } from "@/storage/db";

export type UsageMessageStats = {
    sessionCount: number;
    messageCount: number;
};

function toObservedAtFilter(request: UsageAnalyticsQueryRequest) {
    if (!request.dateRange) {
        return undefined;
    }

    return {
        gte: request.dateRange.startMs ? new Date(request.dateRange.startMs) : undefined,
        lte: request.dateRange.endMs ? new Date(request.dateRange.endMs) : undefined,
    };
}

export async function loadUsageMessageStatsForQuery(
    accountId: string,
    request: UsageAnalyticsQueryRequest,
    sessionIds: string[],
): Promise<UsageMessageStats> {
    if (sessionIds.length === 0) {
        return {
            sessionCount: 0,
            messageCount: 0,
        };
    }

    const messageCount = await db.sessionMessage.count({
        where: {
            sessionId: { in: sessionIds },
            createdAt: toObservedAtFilter(request),
            session: {
                accountId,
            },
        },
    });

    return {
        sessionCount: sessionIds.length,
        messageCount,
    };
}

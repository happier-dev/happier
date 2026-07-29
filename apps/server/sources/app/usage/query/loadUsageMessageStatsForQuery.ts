import type { UsageAnalyticsQueryRequest } from "@happier-dev/protocol";
import {
    buildSessionMessagesPublicationWhere,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import { inTx } from "@/storage/inTx";

export type UsageMessageCounts = {
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
): Promise<UsageMessageCounts> {
    if (sessionIds.length === 0) {
        return {
            messageCount: 0,
        };
    }

    const messageCount = await inTx(async (tx) => {
        const publicationRows = await tx.session.findMany({
            where: {
                id: { in: sessionIds },
                accountId,
            },
            select: {
                id: true,
                ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
            },
        });
        return await tx.sessionMessage.count({
            where: {
                ...buildSessionMessagesPublicationWhere(publicationRows),
                createdAt: toObservedAtFilter(request),
                session: {
                    accountId,
                },
            },
        });
    });

    return {
        messageCount,
    };
}

import { decodeSessionStoredContent, withSessionContentSelect } from '@/storage/sessionMachineStoredContent';
import type { UsageAnalyticsQueryRequest } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import {
    buildSessionMessagesPublicationWhere,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import { inTx, type Tx } from "@/storage/inTx";
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { TEAM_CREDENTIAL_ONLY_USAGE_SOURCES } from '../usageSourceClassifier';

export type UsageMessageCounts = {
    messageCount: number;
};

/** Only private transcript demands admit Session message counts into a query snapshot. */
export function hasUsageMessageCountDemand(request: UsageAnalyticsQueryRequest): boolean {
    return request.population !== 'public_eligible_personal' && request.filters?.execution === undefined
        && (request.includeMessageStats === true || request.includeInsights === true);
}

function toObservedAtFilter(request: UsageAnalyticsQueryRequest) {
    if (!request.dateRange) {
        return undefined;
    }

    return {
        gte: request.dateRange.startMs !== undefined ? new Date(request.dateRange.startMs) : undefined,
        lt: request.dateRange.endMs !== undefined ? new Date(request.dateRange.endMs) : undefined,
    };
}

export async function loadUsageMessageStatsForQuery(
    accountId: string,
    request: UsageAnalyticsQueryRequest,
    sessionIds: string[],
): Promise<UsageMessageCounts> {
    const counts = await inTx(tx => loadUsageMessageCountsBySessionInTx(tx, accountId, request, sessionIds), { readOnly: true });
    return { messageCount: [...counts.values()].reduce((total, count) => total + count, 0) };
}

/** Candidate Sessions can be filtered after accounting reconciliation without another DB read. */
export async function loadUsageMessageCountsBySessionInTx(
    tx: Tx,
    accountId: string,
    request: UsageAnalyticsQueryRequest,
    sessionIds?: string[],
): Promise<ReadonlyMap<string, number>> {
    if (sessionIds?.length === 0) {
        return new Map();
    }

    const dateFilter = toObservedAtFilter(request);
    const readPublications = (ids: readonly string[] | undefined) => tx.session.findMany({
        where: {
            id: ids === undefined ? undefined : { in: [...ids] },
            accountId,
            OR: [
                { usageEvents: { some: { observedAt: dateFilter,
                    source: { notIn: [...TEAM_CREDENTIAL_ONLY_USAGE_SOURCES] } } } },
                { usageReports: { some: { updatedAt: dateFilter } } },
            ],
        },
        select: withSessionContentSelect({
            id: true,
            ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
        }),
    }).then(decodeSessionStoredContent);
    // The lookup binds the Account, LIMIT/OFFSET, both date bounds per relation,
    // and the excluded sources. The candidate filter can exceed that budget too.
    const publicationIdChunks = sessionIds === undefined ? [undefined] : portableQueryChunks({
        values: [...new Set(sessionIds)], bindingsPerValue: 1,
        fixedBindings: 7 + TEAM_CREDENTIAL_ONLY_USAGE_SOURCES.length,
    });
    const counts = new Map<string, number>();
    // A distinct publication ceiling can bind both a Session id and sequence.
    // Prisma also binds LIMIT and OFFSET alongside the Account and date bounds.
    for (const ids of publicationIdChunks) {
        const publications = await readPublications(ids);
        for (const rows of portableQueryChunks({ values: publications, bindingsPerValue: 2, fixedBindings: 5 })) {
            const grouped = await tx.sessionMessage.groupBy({
                by: ['sessionId'],
                _count: { _all: true },
                where: {
                    ...buildSessionMessagesPublicationWhere(rows),
                    createdAt: dateFilter,
                    session: { accountId },
                },
            });
            for (const row of grouped) counts.set(row.sessionId, row._count._all);
        }
    }
    return counts;
}

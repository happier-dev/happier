import { db } from '@/storage/db';
import { activityCache } from '@/app/presence/sessionCache';
import { deleteOwnedSession } from '@/app/session/delete/deleteOwnedSession';

export async function pruneInactiveSessionsOnce(params: {
    cutoff: Date;
    batchSize: number;
    dryRun: boolean;
    afterSessionId?: string;
}): Promise<{
    deleted: number;
    candidatesExamined: number;
    hasMore: boolean;
    nextSessionId: string | null;
}> {
    const limit = Math.max(1, params.batchSize);
    const candidates = await db.session.findMany({
        where: {
            active: false,
            updatedAt: { lt: params.cutoff },
            lastActiveAt: { lt: params.cutoff },
            ...(params.afterSessionId ? { id: { gt: params.afterSessionId } } : null),
        },
        orderBy: { id: 'asc' },
        take: limit,
        select: {
            id: true,
        },
    });

    if (params.dryRun) {
        return {
            deleted: candidates.length,
            candidatesExamined: candidates.length,
            hasMore: candidates.length === limit,
            nextSessionId: candidates[candidates.length - 1]?.id ?? null,
        };
    }

    let deleted = 0;
    for (const candidate of candidates) {
        if (activityCache.isSessionObservedActive(candidate.id)) {
            continue;
        }
        const ok = await deleteOwnedSession({
            sessionId: candidate.id,
            reason: 'retention_policy',
            sessionWhereGuard: {
                active: false,
                updatedAt: { lt: params.cutoff },
                lastActiveAt: { lt: params.cutoff },
            },
        });
        if (ok) {
            deleted += 1;
        }
    }
    return {
        deleted,
        candidatesExamined: candidates.length,
        hasMore: candidates.length === limit,
        nextSessionId: candidates[candidates.length - 1]?.id ?? null,
    };
}

export async function runSessionRetentionRule(params: {
    cutoff: Date;
    batchSize: number;
    dryRun: boolean;
    afterSessionId?: string;
    maxDeletesPerRulePerRun: number;
}): Promise<{
    deleted: number;
    candidatesExamined: number;
    hasMore: boolean;
    nextSessionId: string | null;
}> {
    const limit = Math.max(1, Math.min(params.batchSize, params.maxDeletesPerRulePerRun));
    return await pruneInactiveSessionsOnce({
        cutoff: params.cutoff,
        batchSize: limit,
        dryRun: params.dryRun,
        afterSessionId: params.afterSessionId,
    });
}

import { db } from '@/storage/db';
import { activityCache } from '@/app/presence/sessionCache';
import { deleteOwnedSession } from '@/app/session/delete/deleteOwnedSession';

export async function pruneInactiveSessionsOnce(params: {
    cutoff: Date;
    batchSize: number;
    dryRun: boolean;
}): Promise<{ deleted: number }> {
    const candidates = await db.session.findMany({
        where: {
            active: false,
            updatedAt: { lt: params.cutoff },
            lastActiveAt: { lt: params.cutoff },
        },
        orderBy: [
            { lastActiveAt: 'asc' },
            { updatedAt: 'asc' },
        ],
        take: Math.max(1, params.batchSize),
        select: {
            id: true,
        },
    });

    if (params.dryRun) {
        return { deleted: candidates.length };
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
    return { deleted };
}

export async function runSessionRetentionRule(params: {
    cutoff: Date;
    batchSize: number;
    dryRun: boolean;
    maxDeletesPerRulePerRun: number;
}): Promise<{ deleted: number }> {
    const limit = Math.max(1, Math.min(params.batchSize, params.maxDeletesPerRulePerRun));
    return await pruneInactiveSessionsOnce({
        cutoff: params.cutoff,
        batchSize: limit,
        dryRun: params.dryRun,
    });
}

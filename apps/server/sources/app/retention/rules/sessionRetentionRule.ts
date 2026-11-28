import { db } from '@/storage/db';
import { activityCache } from '@/app/presence/sessionCache';
import { removeSessionCloudCopyInTx } from '@/app/session/delete/removeSessionCloudCopyInTx';
import { retentionEligibleSessionWhere, type RetentionSessionWhere } from '@/app/retention/retentionEligibleSessionWhere';
import { inTx } from '@/storage/inTx';

export type SessionRetentionCursor = Readonly<{ id: string; lastActiveAt: Date }>;

export async function pruneInactiveSessionsOnce(params: {
    cutoff: Date;
    batchSize: number;
    dryRun: boolean;
    after?: SessionRetentionCursor;
    tierWhere?: RetentionSessionWhere;
    now?: Date;
    shouldContinue?: () => boolean;
}): Promise<{
    deleted: number;
    candidatesExamined: number;
    hasMore: boolean;
    nextCursor: SessionRetentionCursor | null;
}> {
    const limit = Math.max(1, params.batchSize);
    const eligible = retentionEligibleSessionWhere(params.cutoff, params.tierWhere);
    const now = params.now ?? new Date();
    const candidates = await db.session.findMany({
        where: {
            AND: [
                eligible,
                ...(params.after ? [{ OR: [
                    { lastActiveAt: { gt: params.after.lastActiveAt } },
                    { lastActiveAt: params.after.lastActiveAt, id: { gt: params.after.id } },
                ] }] : []),
            ],
        },
        orderBy: [{ lastActiveAt: 'asc' }, { id: 'asc' }],
        take: limit,
        select: {
            id: true,
            lastActiveAt: true,
        },
    });

    if (params.dryRun) {
        return {
            deleted: candidates.length,
            candidatesExamined: candidates.length,
            hasMore: candidates.length === limit,
            nextCursor: candidates[candidates.length - 1] ?? null,
        };
    }

    let deleted = 0;
    let examined = 0;
    for (const candidate of candidates) {
        if (params.shouldContinue && !params.shouldContinue()) break;
        examined += 1;
        if (activityCache.isSessionObservedActive(candidate.id)) continue;
        const ok = await inTx((tx) => removeSessionCloudCopyInTx(tx, { sessionId: candidate.id, eligible, now }));
        if (ok) {
            deleted += 1;
        }
    }
    return {
        deleted,
        candidatesExamined: examined,
        hasMore: examined < candidates.length || candidates.length === limit,
        nextCursor: candidates[examined - 1] ?? params.after ?? null,
    };
}

export async function runSessionRetentionRule(params: {
    cutoff: Date;
    batchSize: number;
    dryRun: boolean;
    after?: SessionRetentionCursor;
    tierWhere?: RetentionSessionWhere;
    now?: Date;
    shouldContinue?: () => boolean;
    maxDeletesPerRulePerRun: number;
}): Promise<{
    deleted: number;
    candidatesExamined: number;
    hasMore: boolean;
    nextCursor: SessionRetentionCursor | null;
}> {
    const limit = Math.max(1, Math.min(params.batchSize, params.maxDeletesPerRulePerRun));
    return await pruneInactiveSessionsOnce({
        cutoff: params.cutoff,
        batchSize: limit,
        dryRun: params.dryRun,
        after: params.after,
        tierWhere: params.tierWhere,
        now: params.now,
        shouldContinue: params.shouldContinue,
    });
}

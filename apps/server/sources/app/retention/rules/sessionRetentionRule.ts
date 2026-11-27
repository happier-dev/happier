import { db } from '@/storage/db';
import { activityCache } from '@/app/presence/sessionCache';
import type { Prisma } from '@prisma/client';
import { removeSessionCloudCopyInTx } from '@/app/session/delete/removeSessionCloudCopyInTx';
import { retentionEligibleSessionWhere } from '@/app/retention/retentionEligibleSessionWhere';
import { inTx } from '@/storage/inTx';

export async function pruneInactiveSessionsOnce(params: {
    cutoff: Date;
    batchSize: number;
    dryRun: boolean;
    afterSessionId?: string;
    sessionWhere?: Prisma.SessionWhereInput;
    now?: Date;
}): Promise<{
    deleted: number;
    candidatesExamined: number;
    hasMore: boolean;
    nextSessionId: string | null;
}> {
    const limit = Math.max(1, params.batchSize);
    const eligible = retentionEligibleSessionWhere(params.cutoff, params.sessionWhere);
    const candidates = await db.session.findMany({
        where: {
            ...eligible,
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
        const removed = await inTx(tx => removeSessionCloudCopyInTx(tx, {
            sessionId: candidate.id, eligible, now: params.now ?? new Date(),
        }), { isolationLevel: 'ReadCommitted', transactionClass: 'session-cloud-copy-retention' });
        if (removed) {
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
    sessionWhere?: Prisma.SessionWhereInput;
    now?: Date;
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
        sessionWhere: params.sessionWhere,
        now: params.now,
    });
}

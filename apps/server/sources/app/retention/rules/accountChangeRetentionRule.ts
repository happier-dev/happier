import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';

type AccountChangeRetentionCandidate = Readonly<{
    accountId: string;
    kind: string;
    entityId: string;
    cursor: number;
}>;

async function loadAccountChangeRetentionCandidates(params: {
    cutoff: Date;
    limit: number;
    dryRunOffset?: number;
}): Promise<AccountChangeRetentionCandidate[]> {
    return await db.accountChange.findMany({
        where: {
            changedAt: { lt: params.cutoff },
            cursor: { gt: 0 },
        },
        orderBy: [
            { changedAt: 'asc' },
            { accountId: 'asc' },
            { cursor: 'asc' },
        ],
        take: Math.max(1, params.limit),
        ...(params.dryRunOffset && params.dryRunOffset > 0 ? { skip: params.dryRunOffset } : null),
        select: {
            accountId: true,
            kind: true,
            entityId: true,
            cursor: true,
        },
    });
}

export async function pruneAgedAccountChangesOnce(params: {
    cutoff: Date;
    batchSize: number;
    dryRun: boolean;
    dryRunOffset?: number;
}): Promise<{ deleted: number; candidatesExamined: number; hasMore: boolean }> {
    const limit = Math.max(1, params.batchSize);
    const candidates = await loadAccountChangeRetentionCandidates({
        cutoff: params.cutoff,
        limit,
        dryRunOffset: params.dryRun ? params.dryRunOffset : undefined,
    });

    if (params.dryRun) {
        return {
            deleted: candidates.length,
            candidatesExamined: candidates.length,
            hasMore: candidates.length === limit,
        };
    }

    let deleted = 0;
    const maxDeletedCursorByAccount = new Map<string, number>();

    for (const candidate of candidates) {
        if (!Number.isFinite(candidate.cursor) || candidate.cursor <= 0) continue;

        const result = await db.accountChange.deleteMany({
            where: {
                accountId: candidate.accountId,
                kind: candidate.kind,
                entityId: candidate.entityId,
                cursor: candidate.cursor,
                changedAt: { lt: params.cutoff },
            },
        });
        if (result.count !== 1) {
            continue;
        }

        deleted += 1;
        const previousFloor = maxDeletedCursorByAccount.get(candidate.accountId) ?? 0;
        if (candidate.cursor > previousFloor) {
            maxDeletedCursorByAccount.set(candidate.accountId, candidate.cursor);
        }
    }

    for (const [accountId, floor] of maxDeletedCursorByAccount.entries()) {
        await inTx(async (tx) => await tx.account.updateMany({
            where: {
                id: accountId,
                changesFloor: { lt: floor },
            },
            data: {
                changesFloor: floor,
            },
        }));
    }

    return {
        deleted,
        candidatesExamined: candidates.length,
        hasMore: candidates.length === limit,
    };
}

export async function runAccountChangeRetentionRule(params: {
    cutoff: Date;
    batchSize: number;
    dryRun: boolean;
    dryRunOffset?: number;
    maxDeletesPerRulePerRun: number;
}): Promise<{ deleted: number; candidatesExamined: number; hasMore: boolean }> {
    const limit = Math.max(1, Math.min(params.batchSize, params.maxDeletesPerRulePerRun));
    return await pruneAgedAccountChangesOnce({
        cutoff: params.cutoff,
        batchSize: limit,
        dryRun: params.dryRun,
        dryRunOffset: params.dryRunOffset,
    });
}

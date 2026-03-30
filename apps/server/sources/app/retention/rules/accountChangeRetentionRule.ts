import { db } from '@/storage/db';

type AccountChangeRetentionCandidate = Readonly<{
    accountId: string;
    kind: string;
    entityId: string;
    cursor: number;
}>;

async function loadAccountChangeRetentionCandidates(params: {
    cutoff: Date;
    limit: number;
}): Promise<AccountChangeRetentionCandidate[]> {
    return await db.accountChange.findMany({
        where: {
            changedAt: { lt: params.cutoff },
        },
        orderBy: [
            { changedAt: 'asc' },
            { accountId: 'asc' },
            { cursor: 'asc' },
        ],
        take: Math.max(1, params.limit),
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
}): Promise<{ deleted: number }> {
    const candidates = await loadAccountChangeRetentionCandidates({
        cutoff: params.cutoff,
        limit: params.batchSize,
    });

    if (params.dryRun) {
        return { deleted: candidates.length };
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
        await db.account.updateMany({
            where: {
                id: accountId,
                changesFloor: { lt: floor },
            },
            data: {
                changesFloor: floor,
            },
        });
    }

    return { deleted };
}

export async function runAccountChangeRetentionRule(params: {
    cutoff: Date;
    batchSize: number;
    dryRun: boolean;
    maxDeletesPerRulePerRun: number;
}): Promise<{ deleted: number }> {
    const limit = Math.max(1, Math.min(params.batchSize, params.maxDeletesPerRulePerRun));
    return await pruneAgedAccountChangesOnce({
        cutoff: params.cutoff,
        batchSize: limit,
        dryRun: params.dryRun,
    });
}

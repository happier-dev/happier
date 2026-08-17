import {
    acquireAccountSessionOwnerMetadataFenceInTx,
    AccountSessionOwnerMetadataFenceAccountNotFoundError,
} from '@/app/encryption/accountSessionOwnerMetadataFence';
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

async function deleteAgedAccountChangesAndAdvanceFloor(params: {
    accountId: string;
    candidates: readonly AccountChangeRetentionCandidate[];
    cutoff: Date;
}): Promise<number> {
    return await inTx(async (tx) => {
        // AccountChange writers allocate their cursor through Account. Take the
        // same Account-first fence before deleting a retained row so the
        // deletion and its recovery floor are one visible state transition.
        try {
            await acquireAccountSessionOwnerMetadataFenceInTx(
                tx,
                params.accountId,
            );
        } catch (error) {
            // A concurrent Account deletion cascades this candidate. That was
            // already a no-op under the conditional delete below, so preserve
            // retention's non-fatal behavior for that concurrent outcome.
            if (error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) {
                return 0;
            }
            throw error;
        }

        let deleted = 0;
        let maxDeletedCursor = 0;
        for (const candidate of params.candidates) {
            const result = await tx.accountChange.deleteMany({
                where: {
                    accountId: candidate.accountId,
                    kind: candidate.kind,
                    entityId: candidate.entityId,
                    cursor: candidate.cursor,
                    changedAt: { lt: params.cutoff },
                },
            });
            if (result.count !== 1) continue;

            deleted += 1;
            maxDeletedCursor = Math.max(maxDeletedCursor, candidate.cursor);
        }

        if (maxDeletedCursor > 0) {
            await tx.account.updateMany({
                where: {
                    id: params.accountId,
                    changesFloor: { lt: maxDeletedCursor },
                },
                data: {
                    changesFloor: maxDeletedCursor,
                },
            });
        }
        return deleted;
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

    const candidatesByAccount = new Map<string, AccountChangeRetentionCandidate[]>();
    for (const candidate of candidates) {
        if (!Number.isFinite(candidate.cursor) || candidate.cursor <= 0) continue;
        const retainedForAccount = candidatesByAccount.get(candidate.accountId) ?? [];
        retainedForAccount.push(candidate);
        candidatesByAccount.set(candidate.accountId, retainedForAccount);
    }

    let deleted = 0;
    for (const [accountId, accountCandidates] of candidatesByAccount) {
        deleted += await deleteAgedAccountChangesAndAdvanceFloor({
            accountId,
            candidates: accountCandidates,
            cutoff: params.cutoff,
        });
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

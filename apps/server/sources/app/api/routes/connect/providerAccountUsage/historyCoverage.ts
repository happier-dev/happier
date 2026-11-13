import type { Prisma } from '@prisma/client';
import type { TransactionClient } from '@/storage/prisma';

export interface ProviderAccountUsageHistoryCoverage {
    readonly observationCount: number;
    readonly frontier: Readonly<{ id: string; observedAtMs: number }> | null;
}

/** A retained document proves the exact accepted count and ordered frontier. */
export function sameProviderAccountUsageHistoryCoverage(left: ProviderAccountUsageHistoryCoverage,
    right: ProviderAccountUsageHistoryCoverage): boolean {
    return left.observationCount === right.observationCount && left.frontier?.id === right.frontier?.id
        && left.frontier?.observedAtMs === right.frontier?.observedAtMs;
}

export async function readProviderAccountUsageHistoryCoverage(where: Prisma.ProviderAccountUsageHistoryWhereInput,
    storage: Pick<TransactionClient, 'providerAccountUsageHistory'>): Promise<ProviderAccountUsageHistoryCoverage> {
    const [count, last] = await Promise.all([
        storage.providerAccountUsageHistory.count({ where }),
        storage.providerAccountUsageHistory.findFirst({ where, orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
            select: { id: true, observedAt: true } }),
    ]);
    return { observationCount: count, frontier: last ? { id: last.id, observedAtMs: last.observedAt.getTime() } : null };
}

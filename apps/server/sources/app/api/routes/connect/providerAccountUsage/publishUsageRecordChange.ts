import { enqueueAccountChangePublication, markAccountChanged } from '@/app/changes/markAccountChanged';
import type { Tx } from '@/storage/inTx';
import { buildProviderAccountUsageMaterialChangesV1, readProviderAccountUsageDayChangeV1 } from '@happier-dev/protocol/changes/providerAccountUsage';

/** Scope the coalesced publication against the preceding committed Account Change rows. */
export function publishUsageRecordChange(tx: Tx, input: Readonly<{
    accountId: string;
    recordId: string;
    dayStartAtMs?: number;
    historyFromAtMs?: number;
}>): void {
    const { accountId, recordId, dayStartAtMs, historyFromAtMs } = input;
    enqueueAccountChangePublication(tx, [accountId], async transaction => {
        const [global, exact] = buildProviderAccountUsageMaterialChangesV1(recordId);
        let changes = [global, exact];
        if (dayStartAtMs !== undefined) {
            const previous = await transaction.accountChange.findMany({
                where: { accountId, kind: 'account', entityId: { in: [global.entityId, exact.entityId] } },
                select: { cursor: true, kind: true, entityId: true, hint: true },
            });
            const day = readProviderAccountUsageDayChangeV1(previous);
            const sameDay = day?.dayStartAtMs === dayStartAtMs ? day : undefined;
            const previousCursor = Math.max(0, ...previous.map(row => row.cursor));
            changes = [...buildProviderAccountUsageMaterialChangesV1(recordId, {
                dayStartAtMs, afterCursor: sameDay?.afterCursor ?? previousCursor,
                publication: { kind: historyFromAtMs === undefined ? 'summary' : 'observation', afterCursor: previousCursor },
                history: historyFromAtMs === undefined ? sameDay?.history
                    : { fromAtMs: historyFromAtMs, afterCursor: previousCursor },
            })];
        }
        for (const change of changes) await markAccountChanged(transaction, { accountId, ...change });
    });
}

import { enqueueAccountChangePublication, markAccountChanged } from '@/app/changes/markAccountChanged';
import type { Tx } from '@/storage/inTx';
import { buildProviderAccountUsageMaterialChangesV1, readProviderAccountUsageDayChangeV1,
    readProviderAccountUsageObservationRowV1, type ProviderAccountUsageObservationV1 } from '@happier-dev/protocol/changes/providerAccountUsage';

/** Scope the coalesced publication against the preceding committed Account Change rows. */
export function publishUsageRecordChange(tx: Tx, input: Readonly<{
    accountId: string;
    recordId: string;
    dayStartAtMs?: number;
    historyFromAtMs?: number;
    observation?: ProviderAccountUsageObservationV1;
}>): void {
    const { accountId, recordId, dayStartAtMs, historyFromAtMs, observation } = input;
    enqueueAccountChangePublication(tx, [accountId], async transaction => {
        const [global, exact] = buildProviderAccountUsageMaterialChangesV1(recordId);
        const previous = dayStartAtMs !== undefined || observation ? await transaction.accountChange.findMany({
            where: { accountId, kind: 'account', entityId: { in: [global.entityId, exact.entityId] } },
            select: { cursor: true, kind: true, entityId: true, hint: true },
        }) : [];
        const day = readProviderAccountUsageDayChangeV1(previous);
        const sameDay = day?.dayStartAtMs === dayStartAtMs ? day : undefined;
        // The global row can belong to another record. Only the exact row
        // identifies the predecessor the reader may already have admitted.
        const previousExact = previous.find(row => row.entityId === exact.entityId);
        const previousCursor = previousExact?.cursor ?? 0;
        const previousObservation = previousExact && readProviderAccountUsageObservationRowV1(previousExact);
        const previousContentCursor = previousObservation?.providerAccountUsageObservation.contentChanged === false
            ? previousObservation.previousContentCursor : previousCursor;
        const changes = buildProviderAccountUsageMaterialChangesV1(recordId, dayStartAtMs === undefined ? undefined : {
            dayStartAtMs, afterCursor: sameDay?.afterCursor ?? previousCursor,
            publication: { kind: historyFromAtMs === undefined ? 'summary' : 'observation', afterCursor: previousCursor },
            history: historyFromAtMs === undefined ? sameDay?.history : { fromAtMs: historyFromAtMs, afterCursor: previousCursor },
        }, observation ? { observation, previousContentCursor } : undefined);
        for (const change of changes) await markAccountChanged(transaction, { accountId, ...change });
    });
}

import type { PileApplyResultV1, TrashEmptyResultV1, TrashRestoreResultV1 } from '@happier-dev/protocol/storage/storageV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

/** Settled entry effects, shared by page receipts and proposal receipts. Missing entries are never effects. */
export type StorageTrashReceipt<Entry extends Readonly<{ entryId: string }> = Readonly<{ entryId: string }>> = Readonly<{
    remaining: readonly Entry[];
    unknownCount: number;
    deletedCount: number;
    restoredCount: number;
    freedBytes: number;
    /** A wider Empty selection may report a measured total that cannot be attributed to this batch. */
    freedBytesKnown?: false;
    restoreOutcomes?: Readonly<Record<string, TrashRestoreResultV1['outcomes'][number]>>;
    emptyOutcomes?: Readonly<Record<string, TrashEmptyResultV1['outcomes'][number]>>;
}>;

export type StorageTrashReceiptEffect =
    | Readonly<{ kind: 'restore'; result: TrashRestoreResultV1 }>
    | Readonly<{ kind: 'empty'; result: TrashEmptyResultV1 }>;

export function createStorageTrashReceipt(result: PileApplyResultV1): StorageTrashReceipt {
    const moved = result.outcomes.filter(outcome => outcome.status === 'moved').length;
    const ids = result.trashEntryIds;
    return {
        remaining: (ids ?? []).map(entryId => ({ entryId })),
        unknownCount: ids ? 0 : moved,
        deletedCount: ids ? Math.max(0, moved - ids.length) : 0,
        restoredCount: 0,
        freedBytes: result.freedBytes,
    };
}

/** Only successful, still-outstanding entries leave the receipt; retrying a settled effect is a no-op. */
export function settleStorageTrashReceipt<Entry extends Readonly<{ entryId: string }>>(
    receipt: StorageTrashReceipt<Entry>, effect: StorageTrashReceiptEffect,
): StorageTrashReceipt<Entry> {
    const remainingIds = new Set(receipt.remaining.map(entry => entry.entryId));
    const outcomes = effect.result.outcomes.filter(outcome => remainingIds.has(outcome.entryId));
    if (outcomes.length === 0) return receipt;
    const settled = new Set(outcomes.filter(outcome => outcome.status === 'deleted' || outcome.status === 'restored').map(outcome => outcome.entryId));
    const deleted = effect.kind === 'empty' ? settled.size : 0;
    const unattributed = effect.kind === 'empty' && deleted > 0
        && effect.result.outcomes.some(outcome => outcome.status === 'deleted' && !remainingIds.has(outcome.entryId)
            && receipt.emptyOutcomes?.[outcome.entryId]?.status !== 'deleted');
    const next = {
        ...receipt,
        remaining: settled.size ? receipt.remaining.filter(entry => !settled.has(entry.entryId)) : receipt.remaining,
        deletedCount: receipt.deletedCount + deleted,
        restoredCount: receipt.restoredCount + (effect.kind === 'restore' ? settled.size : 0),
        freedBytes: receipt.freedBytes + (effect.kind === 'empty' && deleted > 0 && !unattributed ? effect.result.freedBytes : 0),
        ...(unattributed ? { freedBytesKnown: false as const } : {}),
        ...(effect.kind === 'restore'
            ? { restoreOutcomes: { ...receipt.restoreOutcomes, ...Object.fromEntries(effect.result.outcomes
                .filter(outcome => remainingIds.has(outcome.entryId)).map(outcome => [outcome.entryId, outcome])) } }
            : { emptyOutcomes: { ...receipt.emptyOutcomes, ...Object.fromEntries(effect.result.outcomes
                .filter(outcome => remainingIds.has(outcome.entryId)).map(outcome => [outcome.entryId, outcome])) } }),
    };
    return sameStrictJsonValue(receipt, next) ? receipt : next;
}

/** Per-entry allocations may overlap. A partial receipt has no measured remaining union. */
export function storageTrashReceiptBytes(result: PileApplyResultV1, receipt: StorageTrashReceipt): number | null {
    const originalCount = result.trashEntryIds?.length ?? result.outcomes.filter(outcome => outcome.status === 'moved').length;
    return receipt.remaining.length === originalCount ? result.inTrashBytes : null;
}

export function isStorageTrashReceiptSettled(receipt: StorageTrashReceipt): boolean {
    return receipt.remaining.length === 0 && receipt.unknownCount === 0;
}

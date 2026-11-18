import { isDeepStrictEqual } from 'node:util';
import {
    LocalServiceInventorySnapshotDeltaV1Schema,
    LocalServiceInventorySnapshotV1Schema,
} from '@happier-dev/protocol/local/services/inventory/v1';
import type {
    LocalServiceInventorySnapshotDeltaV1,
    LocalServiceInventorySnapshotV1,
} from '@happier-dev/protocol/local/services/inventory/v1';
import { materialEntry } from './registry';
import type { NormalizedLocalServiceInventoryEntry, NormalizedLocalServiceInventorySnapshot } from './scanner';

function projectEntry({ establishedConnections: _internalConnectionFact, ...entry }: NormalizedLocalServiceInventoryEntry) {
    return entry;
}

/** The guard's connection observations stay private on every Inventory V1 egress. */
export function projectLocalServiceInventorySnapshotV1(
    snapshot: NormalizedLocalServiceInventorySnapshot,
): LocalServiceInventorySnapshotV1 {
    return LocalServiceInventorySnapshotV1Schema.parse({
        ...snapshot,
        entries: snapshot.entries.map(projectEntry),
    });
}

/**
 * A watch answer for a caller that holds `base`: only entries whose material facts changed.
 * Consumers render material facts only, so an unchanged entry keeps the caller's held row.
 */
export function projectLocalServiceInventorySnapshotDeltaV1(
    base: NormalizedLocalServiceInventorySnapshot,
    next: NormalizedLocalServiceInventorySnapshot,
): LocalServiceInventorySnapshotDeltaV1 {
    const baseById = new Map(base.entries.map(entry => [entry.id, entry]));
    const nextIds = new Set(next.entries.map(entry => entry.id));
    const removedIds = base.entries.filter(entry => !nextIds.has(entry.id)).map(entry => entry.id);
    const upserts = next.entries.filter((entry) => {
        const held = baseById.get(entry.id);
        return !held || !isDeepStrictEqual(materialEntry(held), materialEntry(entry));
    });
    // The caller derives held order minus removals plus new ids appended; send order only when that differs.
    const derivedOrder = [...base.entries.map(entry => entry.id).filter(id => nextIds.has(id)),
        ...next.entries.filter(entry => !baseById.has(entry.id)).map(entry => entry.id)];
    const sameOrder = derivedOrder.every((id, index) => next.entries[index]?.id === id);
    return LocalServiceInventorySnapshotDeltaV1Schema.parse({
        v: 1,
        machineId: next.machineId,
        baseGeneratedAt: base.generatedAt,
        generatedAt: next.generatedAt,
        refreshState: next.refreshState,
        upserts: upserts.map(projectEntry),
        removedIds,
        ...(sameOrder ? {} : { order: next.entries.map(entry => entry.id) }),
        diagnostics: next.diagnostics,
    });
}

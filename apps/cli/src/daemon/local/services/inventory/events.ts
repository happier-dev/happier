import type {
    NormalizedLocalServiceInventoryEntry,
    NormalizedLocalServiceInventorySnapshot,
} from './scanner';

export type LocalServiceInventoryRegistryEvent =
    | Readonly<{
        v: 1;
        kind: 'snapshot';
        machineId: string;
        generatedAt: number;
        snapshot: NormalizedLocalServiceInventorySnapshot;
    }>
    | Readonly<{
        v: 1;
        kind: 'entry_upserted';
        machineId: string;
        generatedAt: number;
        entry: NormalizedLocalServiceInventoryEntry;
    }>;

export function createLocalServiceInventorySnapshotEvent(
    snapshot: NormalizedLocalServiceInventorySnapshot,
): LocalServiceInventoryRegistryEvent {
    return {
        v: 1,
        kind: 'snapshot',
        machineId: snapshot.machineId,
        generatedAt: snapshot.generatedAt,
        snapshot,
    };
}

export function createLocalServiceInventoryEntryUpsertedEvent(
    snapshot: NormalizedLocalServiceInventorySnapshot,
    entry: NormalizedLocalServiceInventoryEntry,
): LocalServiceInventoryRegistryEvent {
    return {
        v: 1,
        kind: 'entry_upserted',
        machineId: snapshot.machineId,
        generatedAt: snapshot.generatedAt,
        entry,
    };
}

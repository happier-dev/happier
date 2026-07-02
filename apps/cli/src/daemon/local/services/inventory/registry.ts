import {
    createLocalServiceInventoryEntryUpsertedEvent,
    createLocalServiceInventorySnapshotEvent,
    type LocalServiceInventoryRegistryEvent,
} from './events';
import {
    createLocalServiceInventoryLabelStore,
    type LocalServiceInventoryLabelPatchResult,
    type LocalServiceInventoryLabelSource,
} from './labels';
import type {
    NormalizedLocalServiceInventoryEntry,
    NormalizedLocalServiceInventorySnapshot,
} from './scanner';

export type LocalServiceInventorySubscriber = (event: LocalServiceInventoryRegistryEvent) => void;

export type LocalServiceInventoryRegistry = Readonly<{
    getSnapshot(): NormalizedLocalServiceInventorySnapshot;
    replaceSnapshot(snapshot: NormalizedLocalServiceInventorySnapshot): void;
    applyLabelPatch(input: Readonly<{
        inventoryId: string;
        text: string;
        source: LocalServiceInventoryLabelSource;
        updatedAt: number;
    }>): LocalServiceInventoryLabelPatchResult;
    subscribe(subscriber: LocalServiceInventorySubscriber): () => void;
}>;

function createEmptySnapshot(): NormalizedLocalServiceInventorySnapshot {
    return {
        v: 1,
        machineId: 'unknown',
        generatedAt: 0,
        refreshState: 'idle',
        entries: [],
        diagnostics: [],
    };
}

function attachStoredLabels(
    entry: NormalizedLocalServiceInventoryEntry,
    labels: ReturnType<ReturnType<typeof createLocalServiceInventoryLabelStore>['labelsFor']>,
): NormalizedLocalServiceInventoryEntry {
    return labels.length > 0 ? { ...entry, labels } : entry;
}

export function createLocalServiceInventoryRegistry(): LocalServiceInventoryRegistry {
    const subscribers = new Set<LocalServiceInventorySubscriber>();
    const labels = createLocalServiceInventoryLabelStore();
    let snapshot = createEmptySnapshot();

    const publish = (event: LocalServiceInventoryRegistryEvent) => {
        for (const subscriber of subscribers) {
            subscriber(event);
        }
    };

    return {
        getSnapshot() {
            return snapshot;
        },
        replaceSnapshot(nextSnapshot) {
            snapshot = {
                ...nextSnapshot,
                entries: nextSnapshot.entries.map((entry) => attachStoredLabels(entry, labels.labelsFor(entry))),
            };
            publish(createLocalServiceInventorySnapshotEvent(snapshot));
        },
        applyLabelPatch(input) {
            const result = labels.applyPatch({ ...input, knownEntries: snapshot.entries });
            if (!result.ok) {
                return result;
            }
            const nextEntries = snapshot.entries.map((entry) => (
                entry.id === input.inventoryId ? attachStoredLabels(entry, labels.labelsFor(entry)) : entry
            ));
            const nextEntry = nextEntries.find((entry) => entry.id === input.inventoryId);
            snapshot = {
                ...snapshot,
                entries: nextEntries,
            };
            if (nextEntry) {
                publish(createLocalServiceInventoryEntryUpsertedEvent(snapshot, nextEntry));
            }
            return result;
        },
        subscribe(subscriber) {
            subscribers.add(subscriber);
            return () => {
                subscribers.delete(subscriber);
            };
        },
    };
}

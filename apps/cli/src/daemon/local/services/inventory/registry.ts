import { processGenerationProvesReuse } from '@happier-dev/cli-common/processInstance';
import { isDeepStrictEqual } from 'node:util';

import {
    createLocalServiceInventoryEntryRemovedEvent,
    createLocalServiceInventoryEntryUpsertedEvent,
    createLocalServiceInventorySnapshotEvent,
    type LocalServiceInventoryRegistryEvent,
} from './events';
import {
    createLocalServiceInventoryLabelStore,
    type LocalServiceInventoryDurableLabelEntry,
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
    /** Native projection input, including hidden entries; never a visible inventory response. */
    readScannedEntries(): readonly NormalizedLocalServiceInventoryEntry[];
    /** Wake derived projections without replacing listener or forgotten-entry facts. */
    invalidate(): void;
    replaceSnapshot(snapshot: NormalizedLocalServiceInventorySnapshot, options?: Readonly<{
        /** A material launcher change shares this Machine's existing inventory watch. */
        invalidate?: boolean;
    }>): void;
    forgetEntry(input: Readonly<{
        inventoryId: string;
        updatedAt: number;
    }>): Readonly<{ ok: true; undoKey: string } | { ok: false; reason: 'unknown_inventory_entry' }>;
    undoForget(undoKey: string): Readonly<{ ok: true } | { ok: false; reason: 'unknown_inventory_entry' }>;
    applyLabelPatch(input: Readonly<{
        inventoryId: string;
        text: string;
        source: LocalServiceInventoryLabelSource;
        updatedAt: number;
    }>): LocalServiceInventoryLabelPatchResult;
    subscribe(subscriber: LocalServiceInventorySubscriber): () => void;
}>;

/**
 * The user-authored half of the inventory: names people gave services, and services they told us
 * to stop showing. Everything else here is rediscovered by the next scan, so this is the only
 * state a daemon restart could destroy (tunnels audit §4.8) — and it is first-class user content,
 * not a cache.
 *
 * Keyed by the stable address tuple rather than the per-scan inventory id, because an id minted by
 * one daemon run means nothing to the next one.
 */
export type LocalServiceInventoryAnnotationsV1 = Readonly<{
    v: 1;
    labelsByFallbackKey: readonly LocalServiceInventoryDurableLabelEntry[];
    forgottenFallbackKeys: readonly (readonly [string, ForgottenSuppression])[];
}>;

/**
 * Storage boundary for the annotations. A genuine system boundary (the filesystem), so the
 * registry stays pure and testable and the daemon supplies the real file-backed adapter.
 */
export type LocalServiceInventoryAnnotationStore = Readonly<{
    read(): LocalServiceInventoryAnnotationsV1 | null;
    write(annotations: LocalServiceInventoryAnnotationsV1): void;
}>;

export type LocalServiceInventoryRegistryOptions = Readonly<{
    annotations?: LocalServiceInventoryAnnotationStore;
}>;

type ForgottenSuppression = Readonly<{
    forgottenAt: number;
    runIdentity: InventoryRunIdentity;
}>;

type InventoryRunIdentity = Readonly<{
    kind: 'process';
    pid: number;
    processStartTimeMs: number | null;
}> | Readonly<{
    kind: 'unattributed';
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

function materialEntry(entry: NormalizedLocalServiceInventoryEntry) {
    // Connection counts are private Guard observations, stripped by Inventory V1 egress.
    const { lastSeenAt: _lastSeenAt, establishedConnections: _connections, endpoint, ...facts } = entry;
    if (!endpoint) return facts;
    const { probedAt: _probedAt, ...endpointFacts } = endpoint;
    return { ...facts, endpoint: endpointFacts };
}

function inventoryFallbackKey(entry: Pick<NormalizedLocalServiceInventoryEntry, 'machineId' | 'address' | 'port' | 'protocol'>): string {
    return `${entry.machineId}:${entry.protocol}:${entry.address.kind}:${entry.address.host}:${entry.port}`;
}

function inventoryRunIdentity(entry: NormalizedLocalServiceInventoryEntry): InventoryRunIdentity {
    const process = entry.provenance?.process;
    if (process) {
        const processStartTimeMs = typeof process.processStartTimeMs === 'number' && Number.isFinite(process.processStartTimeMs)
            ? Math.max(0, Math.trunc(process.processStartTimeMs))
            : null;
        return {
            kind: 'process',
            pid: process.pid,
            processStartTimeMs,
        };
    }
    return { kind: 'unattributed' };
}

function isDefinitelyDifferentRun(
    forgotten: InventoryRunIdentity,
    current: InventoryRunIdentity,
): boolean {
    if (forgotten.kind !== 'process' || current.kind !== 'process') {
        return false;
    }
    if (forgotten.pid !== current.pid) {
        return true;
    }
    return processGenerationProvesReuse(
        forgotten.processStartTimeMs ?? undefined,
        current.processStartTimeMs ?? undefined,
    );
}

export function createLocalServiceInventoryRegistry(
    options: LocalServiceInventoryRegistryOptions = {},
): LocalServiceInventoryRegistry {
    const subscribers = new Set<LocalServiceInventorySubscriber>();
    const restored = options.annotations?.read() ?? null;
    let labels = createLocalServiceInventoryLabelStore(restored?.labelsByFallbackKey ?? []);
    // One address-keyed decision survives restart and expires only on a proven new run.
    let forgottenFallbackKeys = new Map<string, ForgottenSuppression>(
        (restored?.forgottenFallbackKeys ?? []).map(([key, suppression]) => [key, suppression] as const),
    );
    let snapshot = createEmptySnapshot();
    // Keep the scan's current facts at this owner so Undo never revives an obsolete row.
    let scannedEntries = snapshot.entries;

    const persistAnnotations = (nextLabels = labels, nextForgotten = forgottenFallbackKeys): void => {
        options.annotations?.write({
            v: 1,
            labelsByFallbackKey: nextLabels.snapshotDurableLabels(),
            forgottenFallbackKeys: [...nextForgotten.entries()].map(([key, value]) => [key, value] as const),
        });
    };

    const publish = (event: LocalServiceInventoryRegistryEvent) => {
        for (const subscriber of subscribers) {
            subscriber(event);
        }
    };

    return {
        getSnapshot() {
            return snapshot;
        },
        readScannedEntries() {
            return scannedEntries;
        },
        invalidate() {
            snapshot = { ...snapshot, generatedAt: snapshot.generatedAt + 1 };
            publish(createLocalServiceInventorySnapshotEvent(snapshot));
        },
        replaceSnapshot(nextSnapshot, replaceOptions) {
            scannedEntries = nextSnapshot.entries;
            const visibleEntries = nextSnapshot.entries.filter((entry) => {
                const fallbackKey = inventoryFallbackKey(entry);
                const fallbackSuppression = forgottenFallbackKeys.get(fallbackKey);
                if (!fallbackSuppression) {
                    return true;
                }
                if (isDefinitelyDifferentRun(fallbackSuppression.runIdentity, inventoryRunIdentity(entry))) {
                    forgottenFallbackKeys.delete(fallbackKey);
                    return true;
                }
                return false;
            });
            const previousById = new Map(snapshot.entries.map(entry => [entry.id, entry]));
            let entriesChanged = snapshot.entries.length !== visibleEntries.length;
            const entries = visibleEntries.map((scanned, index) => {
                const entry = attachStoredLabels(scanned, labels.labelsFor(scanned));
                const previous = previousById.get(entry.id);
                if (snapshot.entries[index]?.id !== entry.id) entriesChanged = true;
                if (!previous || !isDeepStrictEqual(materialEntry(previous), materialEntry(entry))) {
                    entriesChanged = true;
                    return entry;
                }
                // Keep material nested identities; observations remain current for on-demand reads
                // and, critically, for the scanner's next missing-listener deadline.
                return { ...previous, lastSeenAt: entry.lastSeenAt, establishedConnections: entry.establishedConnections,
                    ...(previous.endpoint && entry.endpoint ? { endpoint: { ...previous.endpoint, probedAt: entry.endpoint.probedAt } } : {}) };
            });
            const changed = replaceOptions?.invalidate === true || entriesChanged
                || snapshot.machineId !== nextSnapshot.machineId || snapshot.refreshState !== nextSnapshot.refreshState
                || !isDeepStrictEqual(snapshot.diagnostics, nextSnapshot.diagnostics);
            snapshot = {
                ...nextSnapshot,
                generatedAt: changed ? Math.max(nextSnapshot.generatedAt, snapshot.generatedAt + 1) : snapshot.generatedAt,
                entries,
            };
            if (changed) publish(createLocalServiceInventorySnapshotEvent(snapshot));
        },
        forgetEntry(input) {
            const target = snapshot.entries.find((entry) => entry.id === input.inventoryId);
            if (!target) {
                return { ok: false, reason: 'unknown_inventory_entry' };
            }
            const suppression = {
                forgottenAt: input.updatedAt,
                runIdentity: inventoryRunIdentity(target),
            };
            const nextForgotten = new Map(forgottenFallbackKeys);
            nextForgotten.set(inventoryFallbackKey(target), suppression);
            persistAnnotations(labels, nextForgotten);
            forgottenFallbackKeys = nextForgotten;
            snapshot = {
                ...snapshot,
                generatedAt: Math.max(input.updatedAt, snapshot.generatedAt + 1),
                entries: snapshot.entries.filter((entry) => entry.id !== target.id),
            };
            publish(createLocalServiceInventoryEntryRemovedEvent(snapshot, target.id));
            return { ok: true, undoKey: inventoryFallbackKey(target) };
        },
        undoForget(undoKey) {
            if (!forgottenFallbackKeys.has(undoKey)) {
                return { ok: false, reason: 'unknown_inventory_entry' };
            }
            const nextForgotten = new Map(forgottenFallbackKeys);
            nextForgotten.delete(undoKey);
            persistAnnotations(labels, nextForgotten);
            forgottenFallbackKeys = nextForgotten;
            snapshot = {
                ...snapshot,
                generatedAt: snapshot.generatedAt + 1,
                entries: scannedEntries
                    .filter((entry) => !forgottenFallbackKeys.has(inventoryFallbackKey(entry)))
                    .map((entry) => attachStoredLabels(entry, labels.labelsFor(entry))),
            };
            publish(createLocalServiceInventorySnapshotEvent(snapshot));
            return { ok: true };
        },
        applyLabelPatch(input) {
            const nextLabels = createLocalServiceInventoryLabelStore(labels.snapshotDurableLabels());
            const result = nextLabels.applyPatch({ ...input, knownEntries: snapshot.entries });
            if (!result.ok) {
                return result;
            }
            persistAnnotations(nextLabels);
            labels = nextLabels;
            const nextEntries = snapshot.entries.map((entry) => (
                entry.id === input.inventoryId ? attachStoredLabels(entry, labels.labelsFor(entry)) : entry
            ));
            const nextEntry = nextEntries.find((entry) => entry.id === input.inventoryId);
            snapshot = {
                ...snapshot,
                generatedAt: Math.max(input.updatedAt, snapshot.generatedAt + 1),
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

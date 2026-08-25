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
    replaceSnapshot(snapshot: NormalizedLocalServiceInventorySnapshot): void;
    forgetEntry(input: Readonly<{
        inventoryId: string;
        updatedAt: number;
    }>): Readonly<{ ok: true } | { ok: false; reason: 'unknown_inventory_entry' }>;
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
    maxForgottenEntries?: number;
    forgottenEntryTtlMs?: number;
    annotations?: LocalServiceInventoryAnnotationStore;
}>;

const DEFAULT_MAX_FORGOTTEN_ENTRIES = 512;
const DEFAULT_FORGOTTEN_ENTRY_TTL_MS = 30 * 60_000;

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
    return forgotten.processStartTimeMs !== null
        && current.processStartTimeMs !== null
        && forgotten.processStartTimeMs !== current.processStartTimeMs;
}

function resolvePositiveInt(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.max(1, Math.trunc(value))
        : fallback;
}

function addSuppression(
    suppressions: Map<string, ForgottenSuppression>,
    key: string,
    value: ForgottenSuppression,
    maxEntries: number,
): void {
    suppressions.delete(key);
    suppressions.set(key, value);
    while (suppressions.size > maxEntries) {
        const oldest = suppressions.keys().next().value;
        if (oldest === undefined) break;
        suppressions.delete(oldest);
    }
}

function pruneExpiredSuppressions(
    suppressions: Map<string, ForgottenSuppression>,
    now: number,
    ttlMs: number,
): void {
    for (const [key, suppression] of suppressions) {
        if (now - suppression.forgottenAt >= ttlMs) {
            suppressions.delete(key);
        }
    }
}

export function createLocalServiceInventoryRegistry(
    options: LocalServiceInventoryRegistryOptions = {},
): LocalServiceInventoryRegistry {
    const subscribers = new Set<LocalServiceInventorySubscriber>();
    const restored = options.annotations?.read() ?? null;
    const labels = createLocalServiceInventoryLabelStore(restored?.labelsByFallbackKey ?? []);
    const maxForgottenEntries = resolvePositiveInt(options.maxForgottenEntries, DEFAULT_MAX_FORGOTTEN_ENTRIES);
    const forgottenEntryTtlMs = resolvePositiveInt(options.forgottenEntryTtlMs, DEFAULT_FORGOTTEN_ENTRY_TTL_MS);
    // Inventory ids do not survive a restart, so only the address-keyed suppressions are restored;
    // the id-keyed map is rebuilt as this run forgets things.
    const forgottenInventoryIds = new Map<string, ForgottenSuppression>();
    const forgottenFallbackKeys = new Map<string, ForgottenSuppression>(
        (restored?.forgottenFallbackKeys ?? []).map(([key, suppression]) => [key, suppression] as const),
    );
    let snapshot = createEmptySnapshot();

    const persistAnnotations = (): void => {
        options.annotations?.write({
            v: 1,
            labelsByFallbackKey: labels.snapshotDurableLabels(),
            forgottenFallbackKeys: [...forgottenFallbackKeys.entries()].map(([key, value]) => [key, value] as const),
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
        replaceSnapshot(nextSnapshot) {
            pruneExpiredSuppressions(forgottenInventoryIds, nextSnapshot.generatedAt, forgottenEntryTtlMs);
            pruneExpiredSuppressions(forgottenFallbackKeys, nextSnapshot.generatedAt, forgottenEntryTtlMs);
            const visibleEntries = nextSnapshot.entries.filter((entry) => {
                if (forgottenInventoryIds.has(entry.id)) {
                    return false;
                }
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
            snapshot = {
                ...nextSnapshot,
                entries: visibleEntries.map((entry) => attachStoredLabels(entry, labels.labelsFor(entry))),
            };
            publish(createLocalServiceInventorySnapshotEvent(snapshot));
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
            addSuppression(forgottenInventoryIds, target.id, suppression, maxForgottenEntries);
            addSuppression(forgottenFallbackKeys, inventoryFallbackKey(target), suppression, maxForgottenEntries);
            persistAnnotations();
            snapshot = {
                ...snapshot,
                generatedAt: input.updatedAt,
                entries: snapshot.entries.filter((entry) => entry.id !== target.id),
            };
            publish(createLocalServiceInventoryEntryRemovedEvent(snapshot, target.id));
            return { ok: true };
        },
        applyLabelPatch(input) {
            const result = labels.applyPatch({ ...input, knownEntries: snapshot.entries });
            if (!result.ok) {
                return result;
            }
            persistAnnotations();
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

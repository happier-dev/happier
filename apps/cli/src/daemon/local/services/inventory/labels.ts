export type LocalServiceInventoryLabelSource = 'user' | 'plugin';

export type LocalServiceInventoryStoredLabel = Readonly<{
    id: string;
    text: string;
    source: LocalServiceInventoryLabelSource;
    updatedAt: number;
}>;

export type LocalServiceInventoryLabelTarget = Readonly<{
    id: string;
    machineId: string;
    address: Readonly<{
        kind: string;
        host: string;
    }>;
    port: number;
}>;

export type LocalServiceInventoryLabelPatchResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reason: 'unknown_inventory_entry' }>;

export type LocalServiceInventoryLabelStore = Readonly<{
    /**
     * The restart-durable half of the store, keyed by the stable address tuple. Used by the
     * registry's annotation persistence; the per-run inventory-id index is rebuilt from scans.
     */
    snapshotDurableLabels(): readonly (readonly [string, readonly LocalServiceInventoryStoredLabel[]])[];
    applyPatch(input: Readonly<{
        knownEntries: readonly LocalServiceInventoryLabelTarget[];
        inventoryId: string;
        text: string;
        source: LocalServiceInventoryLabelSource;
        updatedAt: number;
    }>): LocalServiceInventoryLabelPatchResult;
    labelsFor(target: LocalServiceInventoryLabelTarget): readonly LocalServiceInventoryStoredLabel[];
}>;

function fallbackKey(target: LocalServiceInventoryLabelTarget): string {
    return `${target.machineId}:${target.address.kind}:${target.address.host}:${target.port}`;
}

export type LocalServiceInventoryDurableLabelEntry = readonly [string, readonly LocalServiceInventoryStoredLabel[]];

export function createLocalServiceInventoryLabelStore(
    restoredDurableLabels: readonly LocalServiceInventoryDurableLabelEntry[] = [],
): LocalServiceInventoryLabelStore {
    const labelsByInventoryId = new Map<string, readonly LocalServiceInventoryStoredLabel[]>();
    // Only the address-derived key survives a restart: inventory ids are minted per scan, so a
    // label stored against one would silently detach from the service the user named.
    const labelsByFallbackKey = new Map<string, readonly LocalServiceInventoryStoredLabel[]>(
        restoredDurableLabels.map(([key, labels]) => [key, Object.freeze([...labels])] as const),
    );
    return {
        snapshotDurableLabels() {
            return [...labelsByFallbackKey.entries()].map(([key, labels]) => [key, labels] as const);
        },
        applyPatch(input) {
            const target = input.knownEntries.find((entry) => entry.id === input.inventoryId);
            if (!target) {
                return { ok: false, reason: 'unknown_inventory_entry' };
            }
            const label: LocalServiceInventoryStoredLabel = Object.freeze({
                id: `${input.source}:${input.inventoryId}`,
                text: input.text,
                source: input.source,
                updatedAt: input.updatedAt,
            });
            const labels = Object.freeze([label]);
            labelsByInventoryId.set(input.inventoryId, labels);
            labelsByFallbackKey.set(fallbackKey(target), labels);
            return { ok: true };
        },
        labelsFor(target) {
            return labelsByInventoryId.get(target.id) ?? labelsByFallbackKey.get(fallbackKey(target)) ?? Object.freeze([]);
        },
    };
}

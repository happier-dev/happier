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

export function createLocalServiceInventoryLabelStore(): LocalServiceInventoryLabelStore {
    const labelsByInventoryId = new Map<string, readonly LocalServiceInventoryStoredLabel[]>();
    const labelsByFallbackKey = new Map<string, readonly LocalServiceInventoryStoredLabel[]>();
    return {
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

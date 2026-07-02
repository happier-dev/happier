import type { LocalServiceInventoryLabelSource } from './labels';
import type {
    LocalServiceInventoryRegistry,
} from './registry';
import type { NormalizedLocalServiceInventorySnapshot } from './scanner';

export type LocalServiceInventoryRoutes = Readonly<{
    getSnapshot(): Promise<NormalizedLocalServiceInventorySnapshot>;
    refreshSnapshot(): Promise<NormalizedLocalServiceInventorySnapshot>;
    patchLabel(input: Readonly<{
        inventoryId: string;
        label: Readonly<{ text: string }>;
        source: LocalServiceInventoryLabelSource;
        now: number;
    }>): Promise<Readonly<{ ok: true } | { ok: false; reason: 'unknown_inventory_entry' }>>;
}>;

export function createLocalServiceInventoryRoutes(input: Readonly<{
    registry: LocalServiceInventoryRegistry;
    refreshSnapshot?: () => Promise<NormalizedLocalServiceInventorySnapshot>;
}>): LocalServiceInventoryRoutes {
    return {
        async getSnapshot() {
            return input.registry.getSnapshot();
        },
        async refreshSnapshot() {
            return input.refreshSnapshot ? await input.refreshSnapshot() : input.registry.getSnapshot();
        },
        async patchLabel(patch) {
            return input.registry.applyLabelPatch({
                inventoryId: patch.inventoryId,
                text: patch.label.text,
                source: patch.source,
                updatedAt: patch.now,
            });
        },
    };
}

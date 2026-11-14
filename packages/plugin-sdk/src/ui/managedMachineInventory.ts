/** @moduleRealm any */
import { z } from 'zod/mini';
import { ManagedMachineReadSnapshotV1Schema, type ManagedMachineReadSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

/** The managed-list host read borrows the Account inventory after custody opening, including unopened structural rows. */
export type PluginUiManagedMachineInventory = Readonly<{ machines: readonly ManagedMachineReadSnapshotV1[] }>;

const inventorySchema = z.strictObject({ machines: z.array(ManagedMachineReadSnapshotV1Schema) });

/** Decode the host projection, which deliberately differs from the raw machines.managed.list Action result. */
export function decodePluginUiManagedMachineInventory(bytes: Uint8Array): PluginUiManagedMachineInventory {
    return inventorySchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

import {
    ManagedMachinePresetAccountEncryptionMigrationInventoryV1Schema,
    type ManagedMachinePresetAccountEncryptionMigrationInventoryV1,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';

import type { ServerFetch } from '@/sync/http/client';
import { assertAccountEncryptionMigrationScopeCurrent,
    type AccountEncryptionMigrationScope } from '@/sync/domains/settings/scope/accountSettingsScope';

/** One captured inventory request; the server owns personal-row selection and conversion CAS. */
export async function fetchAccountEncryptionMigrationManagedMachinePresetsInventory(params: Readonly<{
    request: ServerFetch;
    scope: AccountEncryptionMigrationScope;
}>): Promise<ManagedMachinePresetAccountEncryptionMigrationInventoryV1> {
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    const response = await params.request('/v1/account/encryption/migrate/managed-machine-presets/inventory', { method: 'GET' });
    if (!response.ok) throw new Error('managed_preset_migration_inventory_unavailable');
    const inventory = ManagedMachinePresetAccountEncryptionMigrationInventoryV1Schema.parse(await response.json());
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    return inventory;
}

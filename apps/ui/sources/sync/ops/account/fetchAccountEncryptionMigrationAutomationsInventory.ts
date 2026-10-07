import { AccountEncryptionMigrateAutomationsInventoryResponseSchema,
    type AccountEncryptionMigrateAutomationsInventoryResponse } from '@happier-dev/protocol/account/encryptionMigrate';
import { serverFetch } from '@/sync/http/client';

export const ACCOUNT_ENCRYPTION_MIGRATION_AUTOMATIONS_INVENTORY_PATH = '/v1/account/encryption/migrate/automations/inventory';
type MigrationInventoryRequest = (path: string, init: RequestInit,
    options: Readonly<{ includeAuth: true; retry: 'none' }>) => Promise<Response>;

export async function fetchAccountEncryptionMigrationAutomationsInventory(params: Readonly<{
    request?: MigrationInventoryRequest;
}> = {}): Promise<AccountEncryptionMigrateAutomationsInventoryResponse> {
    const response = await (params.request ?? serverFetch)(ACCOUNT_ENCRYPTION_MIGRATION_AUTOMATIONS_INVENTORY_PATH,
        { method: 'GET' }, { includeAuth: true, retry: 'none' });
    if (!response.ok) throw new Error('automations_migration_inventory_fetch_failed');
    return AccountEncryptionMigrateAutomationsInventoryResponseSchema.parse(await response.json());
}

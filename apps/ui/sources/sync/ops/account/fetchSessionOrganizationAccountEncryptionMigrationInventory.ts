import {
    SessionOrganizationAccountEncryptionMigrationInventorySchema,
    type SessionOrganizationAccountEncryptionMigrationInventory,
} from '@happier-dev/protocol';

import { serverFetch } from '@/sync/http/client';

export const SESSION_ORGANIZATION_ACCOUNT_ENCRYPTION_MIGRATION_INVENTORY_PATH =
    '/v1/account/encryption/migrate/session-organization/inventory';

type SessionOrganizationMigrationInventoryRequest = (
    path: string,
    init: RequestInit,
    options: Readonly<{ includeAuth: true; retry: 'none' }>,
) => Promise<Response>;

export async function fetchSessionOrganizationAccountEncryptionMigrationInventory(
    params: Readonly<{
        request?: SessionOrganizationMigrationInventoryRequest;
    }> = {},
): Promise<SessionOrganizationAccountEncryptionMigrationInventory> {
    const request = params.request
        ?? (serverFetch as SessionOrganizationMigrationInventoryRequest);
    const response = await request(
        SESSION_ORGANIZATION_ACCOUNT_ENCRYPTION_MIGRATION_INVENTORY_PATH,
        { method: 'GET' },
        { includeAuth: true, retry: 'none' },
    );
    if (!response.ok) {
        throw new Error(
            'session_organization_migration_inventory_fetch_failed',
        );
    }
    return SessionOrganizationAccountEncryptionMigrationInventorySchema.parse(
        await response.json(),
    );
}

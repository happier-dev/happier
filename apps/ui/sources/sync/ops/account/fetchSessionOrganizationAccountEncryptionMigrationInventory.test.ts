import { describe, expect, it, vi } from 'vitest';

import {
    fetchSessionOrganizationAccountEncryptionMigrationInventory,
    SESSION_ORGANIZATION_ACCOUNT_ENCRYPTION_MIGRATION_INVENTORY_PATH,
} from './fetchSessionOrganizationAccountEncryptionMigrationInventory';

describe('fetchSessionOrganizationAccountEncryptionMigrationInventory', () => {
    it('reads the strict complete transition inventory without retrying', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({
            version: 4,
            folders: [{
                folderId: 'archived-folder',
                display: { t: 'plain', v: { name: 'Archived' } },
            }],
            tags: [],
            labels: [],
        }), { status: 200 }));

        await expect(
            fetchSessionOrganizationAccountEncryptionMigrationInventory({
                request,
            }),
        ).resolves.toMatchObject({
            version: 4,
            folders: [{ folderId: 'archived-folder' }],
        });
        expect(request).toHaveBeenCalledWith(
            SESSION_ORGANIZATION_ACCOUNT_ENCRYPTION_MIGRATION_INVENTORY_PATH,
            { method: 'GET' },
            { includeAuth: true, retry: 'none' },
        );
    });

    it('fails closed on malformed or unavailable inventory', async () => {
        await expect(
            fetchSessionOrganizationAccountEncryptionMigrationInventory({
                request: async () => new Response('{}', { status: 200 }),
            }),
        ).rejects.toThrow();
        await expect(
            fetchSessionOrganizationAccountEncryptionMigrationInventory({
                request: async () => new Response('{}', { status: 426 }),
            }),
        ).rejects.toThrow(
            'session_organization_migration_inventory_fetch_failed',
        );
    });
});

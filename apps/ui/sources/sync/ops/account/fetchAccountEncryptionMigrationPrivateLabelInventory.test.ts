import { describe, expect, it } from 'vitest';
import {
    projectPrivateLabelForRecipientV1,
    sealPrivateLabelV1,
} from '@happier-dev/protocol/crypto/privateLabelV1';

import {
    fetchAccountEncryptionMigrationPrivateLabelInventory,
} from './fetchAccountEncryptionMigrationPrivateLabelInventory';

const accountId = 'account-a';
const scope = {
    scope: { serverId: 'home-a', accountId },
    isCurrent: () => true,
};

function projectedLabel(
    entity: 'account_api_token' | 'account_directory_home' | 'machine_pool',
    field: 'label' | 'name' | 'description',
    id: string,
    value: string,
) {
    return projectPrivateLabelForRecipientV1({
        stored: sealPrivateLabelV1({
            mode: 'plain',
            binding: { entity, field, id },
            value,
        }),
        recipientAccountId: accountId,
    });
}

describe('fetchAccountEncryptionMigrationPrivateLabelInventory', () => {
    it('reads the canonical Home migration census without requiring Directory authority', async () => {
        const items = [{ entity: 'account_directory_home' as const, field: 'label' as const,
            id: 'srv_home-a', label: projectedLabel('account_directory_home', 'label', 'srv_home-a', 'Private Home') }];
        const result = await fetchAccountEncryptionMigrationPrivateLabelInventory({
            request: async path => path === '/v1/account/encryption/migrate/private-labels/inventory'
                ? Response.json({ items })
                : Response.json({ error: 'invalid_request' }, { status: 403 }),
            scope,
        });
        expect(result).toEqual(items);
    });

    it('fails when the authenticated migration census is unavailable', async () => {
        await expect(fetchAccountEncryptionMigrationPrivateLabelInventory({
            request: async () => Response.json({ error: 'encryption_unavailable' }, { status: 400 }),
            scope,
        })).rejects.toThrow();
    });

    it('does not return a partial migration inventory after its captured Account scope retires', async () => {
        let current = true;
        await expect(fetchAccountEncryptionMigrationPrivateLabelInventory({
            request: async () => {
                current = false;
                return Response.json({ items: [] });
            },
            scope: { ...scope, isCurrent: () => current },
        })).rejects.toThrow('Account Settings request scope changed');
    });
});

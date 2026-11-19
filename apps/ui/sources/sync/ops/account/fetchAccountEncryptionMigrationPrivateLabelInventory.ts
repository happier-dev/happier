import { AccountEncryptionMigratePrivateLabelInventoryV1Schema } from '@happier-dev/protocol/account/encryptionMigrate';

import type { ServerFetch } from '@/sync/http/client';
import {
    assertAccountEncryptionMigrationScopeCurrent,
    type AccountEncryptionMigrationScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';
import type { AccountEncryptionMigrationPrivateLabelCandidate } from './buildAccountEncryptionPrivateLabelsDirective';

/** Reads the same complete Home-owned label census used by the atomic mode transition. */
export async function fetchAccountEncryptionMigrationPrivateLabelInventory(
    params: Readonly<{
        /** The request captured for this exact Home/Account transition. */
        request: ServerFetch;
        scope: AccountEncryptionMigrationScope;
    }>,
): Promise<readonly AccountEncryptionMigrationPrivateLabelCandidate[]> {
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    const response = await params.request('/v1/account/encryption/migrate/private-labels/inventory', { method: 'GET' });
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    if (!response.ok) {
        throw new Error('Account private-label migration inventory is unavailable');
    }
    const payload = await response.json();
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    return AccountEncryptionMigratePrivateLabelInventoryV1Schema.parse(payload).items;
}

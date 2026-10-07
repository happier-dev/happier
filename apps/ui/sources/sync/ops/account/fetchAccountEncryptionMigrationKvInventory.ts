import { ACCOUNT_JSON_KV_PREFIXES, classifyAccountJsonKvKey, type AccountJsonKvNamespace } from '@happier-dev/protocol/account/accountJsonKv';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { kvList, type KvItem } from '@/sync/api/account/apiKv';
import type { ServerFetch } from '@/sync/http/client';
import { assertAccountEncryptionMigrationScopeCurrent, type AccountEncryptionMigrationScope } from '@/sync/domains/settings/scope/accountSettingsScope';

export class AccountEncryptionMigrationKvInventoryUnavailableError extends Error {
    readonly code = 'account_encryption_migration_kv_inventory_unavailable';
    constructor() { super('Account migration KV inventory did not advance within its namespace'); }
}

export async function fetchAccountEncryptionMigrationKvInventory(params: Readonly<{
    namespace: AccountJsonKvNamespace;
    credentials: AuthCredentials;
    request: ServerFetch;
    scope: AccountEncryptionMigrationScope;
}>): Promise<readonly KvItem[]> {
    const items: KvItem[] = [];
    const seen = new Set<string>();
    let afterKey: string | undefined;
    // This is the public KV list's existing page boundary, not an inventory cap.
    const pageSize = 1000;
    while (true) {
        assertAccountEncryptionMigrationScopeCurrent(params.scope);
        const response = await kvList(params.credentials, { prefix: ACCOUNT_JSON_KV_PREFIXES[params.namespace], afterKey, limit: pageSize, retry: 'none', request: params.request });
        assertAccountEncryptionMigrationScopeCurrent(params.scope);
        for (const item of response.items) {
            if (classifyAccountJsonKvKey(item.key) !== params.namespace || seen.has(item.key)) {
                throw new AccountEncryptionMigrationKvInventoryUnavailableError();
            }
            seen.add(item.key);
            items.push(item);
        }
        if (response.items.length < pageSize) return items;
        afterKey = response.items[response.items.length - 1]!.key;
    }
}

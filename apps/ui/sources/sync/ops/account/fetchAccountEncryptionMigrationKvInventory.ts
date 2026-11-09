import { ACCOUNT_JSON_KV_PREFIXES, classifyAccountJsonKvKey, type AccountJsonKvNamespace } from '@happier-dev/protocol/account/accountJsonKv';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { kvList, type KvItem } from '@/sync/api/account/apiKv';
import type { ServerFetch } from '@/sync/http/client';
import { assertAccountEncryptionMigrationScopeCurrent, type AccountEncryptionMigrationScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { AccountEncryptionMigrateTodosInventoryResponseSchema, type AccountEncryptionMigrateTodosInventoryResponse } from '@happier-dev/protocol/account/encryptionMigrate';

export class AccountEncryptionMigrationKvInventoryUnavailableError extends Error {
    readonly code = 'account_encryption_migration_kv_inventory_unavailable';
    constructor() { super('Account migration KV inventory did not advance within its namespace'); }
}

export async function fetchAccountEncryptionMigrationKvInventory(params: Readonly<{
    namespace: AccountJsonKvNamespace;
    credentials: AuthCredentials;
    request: ServerFetch;
    scope: AccountEncryptionMigrationScope;
}>): Promise<readonly AccountEncryptionMigrateTodosInventoryResponse['items'][number][]> {
    if (params.namespace === 'todo') {
        assertAccountEncryptionMigrationScopeCurrent(params.scope);
        const response = await params.request('/v1/account/encryption/migrate/todos/inventory', {
            method: 'GET', headers: { Authorization: `Bearer ${params.credentials.token}` },
        });
        assertAccountEncryptionMigrationScopeCurrent(params.scope);
        if (!response.ok) throw new AccountEncryptionMigrationKvInventoryUnavailableError();
        const inventory = AccountEncryptionMigrateTodosInventoryResponseSchema.parse(await response.json());
        assertAccountEncryptionMigrationScopeCurrent(params.scope);
        const seen = new Set<string>();
        for (const item of inventory.items) {
            if (classifyAccountJsonKvKey(item.key) !== 'todo' || seen.has(item.key)
                || (item.resource && (item.key === 'todo.index' || item.resource.ownerAccountId !== params.scope.scope.accountId
                    || item.resource.access !== 'owner'))) throw new AccountEncryptionMigrationKvInventoryUnavailableError();
            seen.add(item.key);
        }
        return inventory.items;
    }
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

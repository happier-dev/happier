import { ArtifactAccountEncryptionMigrationInventoryV1Schema, isPlainArtifactDataKeyMarker, isPlainArtifactStoredContent } from '@happier-dev/protocol';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ServerFetch } from '@/sync/http/client';
import { assertAccountEncryptionMigrationScopeCurrent, type AccountEncryptionMigrationScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import type { AccountEncryptionMigrationArtifactRow } from './buildAccountEncryptionMigrationStorageDirectives';

/** Complete owner inventory, including release-qualified archives excluded from ordinary APIs. */
export async function fetchAccountEncryptionMigrationArtifactInventory(params: Readonly<{
    credentials: Pick<AuthCredentials, 'token'>;
    request: ServerFetch;
    scope: AccountEncryptionMigrationScope;
    encryptionMode: 'plain' | 'e2ee';
}>): Promise<readonly AccountEncryptionMigrationArtifactRow[]> {
    const rows: AccountEncryptionMigrationArtifactRow[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let afterId: string | null = null;
    while (true) {
        assertAccountEncryptionMigrationScopeCurrent(params.scope);
        // The existing Artifact list boundary sizes a page; it never caps the census.
        const query = new URLSearchParams({ limit: '500' });
        if (afterId !== null) query.set('afterId', afterId);
        const response = await params.request(`/v1/account/encryption/artifacts?${query}`, {
            method: 'GET', headers: { Authorization: `Bearer ${params.credentials.token}` },
        });
        assertAccountEncryptionMigrationScopeCurrent(params.scope);
        if (!response.ok) throw new Error('Account Artifact migration inventory is unavailable');
        const page = ArtifactAccountEncryptionMigrationInventoryV1Schema.parse(await response.json());
        assertAccountEncryptionMigrationScopeCurrent(params.scope);
        if (page.ownerAccountId !== params.scope.scope.accountId || page.encryptionMode !== params.encryptionMode) {
            throw new Error('Account Artifact migration inventory authority changed');
        }
        for (const row of page.items) {
            const plain = params.encryptionMode === 'plain';
            if (ids.has(row.id) || isPlainArtifactDataKeyMarker(row.dataEncryptionKey) !== plain
                || [row.header, row.body, ...row.revisions.map(revision => revision.body)].some(content => isPlainArtifactStoredContent(content) !== plain)) {
                throw new Error('Account Artifact migration inventory content is inconsistent');
            }
            ids.add(row.id);
            rows.push(row);
        }
        if (page.nextCursor === null) return rows;
        if (cursors.has(page.nextCursor) || page.items.at(-1)?.id !== page.nextCursor) {
            throw new Error('Account Artifact migration inventory cursor did not advance');
        }
        cursors.add(page.nextCursor);
        afterId = page.nextCursor;
    }
}

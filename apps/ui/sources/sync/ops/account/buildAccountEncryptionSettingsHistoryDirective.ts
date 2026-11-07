import type { AccountEncryptionMigrateSettingsHistoryDirective, AccountEncryptionMigrateSettingsHistoryInventoryPage } from '@happier-dev/protocol/account/encryptionMigrate';
import { sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { openAccountSettingsStoredContent } from '@/sync/domains/settings/accountSettingsNormalization';
import { deriveSettingsSecretsKeySet, unsealSecretsDeepWithKeysForPlainStorage } from '@/sync/encryption/secretSettings';
import { HappyError } from '@/utils/errors/errors';

export type AccountEncryptionSettingsHistoryMigrationCandidate = AccountEncryptionMigrateSettingsHistoryInventoryPage['items'][number];

export function accountEncryptionSettingsHistoryUnavailable(): HappyError {
    return new HappyError('Failed to update encryption setting', false, {
        kind: 'config', code: 'migration_inventory_changed',
    });
}

/** The current Settings builders also reseal raw snapshots, without effective-Settings normalization. */
export function buildAccountEncryptionSettingsHistoryDirective(params: Readonly<{
    candidates: readonly AccountEncryptionSettingsHistoryMigrationCandidate[];
    target: Readonly<{ mode: 'plain'; material: AccountScopedCryptoMaterial | null }>
        | Readonly<{ mode: 'e2ee'; material: AccountScopedCryptoMaterial; randomBytes(length: number): Uint8Array }>;
}>): AccountEncryptionMigrateSettingsHistoryDirective | undefined {
    if (params.candidates.length === 0) return undefined;
    const target = params.target;
    const sourceMode = target.mode === 'plain' ? 'e2ee' : 'plain';
    try {
        const readKeys = target.mode === 'plain' && target.material
            ? deriveSettingsSecretsKeySet(target.material).readKeys : [];
        return { items: params.candidates.map(row => {
            if (row.encryptionMode !== sourceMode) throw accountEncryptionSettingsHistoryUnavailable();
            const opened = openAccountSettingsStoredContent({ content: row.content, expectedMode: sourceMode,
                material: sourceMode === 'e2ee' ? target.material : null });
            return { version: row.version, expectedContent: row.content,
                content: opened.raw === null ? null : target.mode === 'plain'
                    ? { t: 'plain' as const, v: unsealSecretsDeepWithKeysForPlainStorage(opened.raw, readKeys) }
                    : { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
                        material: target.material, payload: opened.raw, randomBytes: target.randomBytes }) } };
        }) };
    } catch {
        // Content and crypto failure details must never enter the public Action result.
        throw accountEncryptionSettingsHistoryUnavailable();
    }
}

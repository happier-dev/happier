import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { AccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol';
import { requireAccountEncryptionCredentials } from '@/api/client/encryptionKey';
import type { StoredCredentials } from '@/persistence';

export { isAvailableE2eeAutomationAccountEncryptionV1, resolveValidatedAutomationAccountEncryptionV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
export type { AvailableE2eeAutomationAccountEncryptionV1, AvailableAutomationAccountEncryptionV1, ValidatedAutomationAccountEncryptionV1 } from '@happier-dev/protocol';

/**
 * Captures the Account-content owner material for one prospective Automation
 * host evidence attempt. The caller must first establish current E2EE mode;
 * this adapter never derives or caches Account mode from local credentials.
 */
export function createAutomationAccountEncryptionMaterialSnapshotV1(
    credentials: StoredCredentials,
): AccountScopedCryptoMaterialSnapshotV1 | null {
    try {
        const encryption = requireAccountEncryptionCredentials(credentials).encryption;
        return createAccountScopedCryptoMaterialSnapshotV1({
            accountEncryptionMode: 'e2ee',
            material: encryption.type === 'legacy'
                ? { type: 'legacy', secret: encryption.secret }
                : { type: 'dataKey', machineKey: encryption.machineKey },
            ...(encryption.type === 'dataKey'
                ? { dataKeyPublicKey: encryption.publicKey }
                : {}),
        });
    } catch {
        return null;
    }
}

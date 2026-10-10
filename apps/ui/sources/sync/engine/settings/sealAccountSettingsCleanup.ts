import type { AccountSettingsCleanupV1 } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';
import { sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { getRandomBytes } from '@/platform/cryptoRandom';

/** Entity-row operations seal the exact captured Settings document in the same Account mode. */
export function sealAccountSettingsCleanup(mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null,
    version: number, raw: Readonly<Record<string, unknown>>): AccountSettingsCleanupV1 {
    if (mode === 'plain') return { expectedSettingsVersion: version, nextSettings: { t: 'plain', v: raw } };
    if (!material) throw new Error('encryption-material-unavailable');
    return { expectedSettingsVersion: version, nextSettings: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
        kind: 'account_settings', material, payload: raw, randomBytes: getRandomBytes,
    }) } };
}

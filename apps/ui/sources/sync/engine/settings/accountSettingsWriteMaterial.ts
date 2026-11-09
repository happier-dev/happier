import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sameAccountEncryptionIdentity, type AccountEncryptionIdentity } from '@happier-dev/sync-client';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionIdentity } from '@/sync/api/account/apiAccountEncryptionMode';
import { resolveCurrentAccountScopedCryptoMaterialSnapshot } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { AccountSettingsStoredContentUnavailableError } from '@/sync/domains/settings/accountSettingsNormalization';
import { captureEncryptionGenerationCurrentness, type Encryption } from '@/sync/encryption/encryption';
import type { ServerFetch } from '@/sync/http/client';

type AccountSettingsWriteMaterial = Readonly<{
    identity: AccountEncryptionIdentity;
    material: AccountScopedCryptoMaterial | null;
    assertCurrent: () => void;
}>;

/** Final Settings writers consume the same persisted-binding admission as scoped material. */
export async function readAccountSettingsWriteMaterial(params: Readonly<{
    credentials: AuthCredentials;
    encryption: Encryption | null;
    request: ServerFetch;
    expectedIdentity?: AccountEncryptionIdentity;
    expectedMode?: 'plain' | 'e2ee';
}>): Promise<AccountSettingsWriteMaterial> {
    const lifetime = captureEncryptionGenerationCurrentness(params.encryption);
    const unavailable = () => new AccountSettingsStoredContentUnavailableError(
        'account_settings_encryption_material_unavailable',
        'Account settings material does not match the current Account identity',
    );
    const identity = await fetchAccountEncryptionIdentity(params.credentials, { request: params.request, usage: 'fresh-authority' });
    const assertCurrent = () => {
        if (identity.mode === 'e2ee' && (!params.encryption || !lifetime.isCurrent())) throw unavailable();
    };
    assertCurrent();
    if ((params.expectedIdentity && !sameAccountEncryptionIdentity(identity, params.expectedIdentity))
        || (params.expectedMode && identity.mode !== params.expectedMode)) throw unavailable();
    if (identity.mode === 'plain') return { identity, material: null, assertCurrent };
    const snapshot = resolveCurrentAccountScopedCryptoMaterialSnapshot({ credentials: params.credentials, accountCurrentness: identity });
    if (!snapshot) throw unavailable();
    return { identity, material: snapshot.material, assertCurrent };
}

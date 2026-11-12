import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { projectAccountEncryptionIdentity, sameAccountEncryptionIdentity, type AccountEncryptionIdentity } from '@happier-dev/sync-client';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import { resolveCurrentAccountScopedCryptoMaterialSnapshot } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { AccountSettingsStoredContentUnavailableError } from '@/sync/domains/settings/accountSettingsNormalization';
import { captureEncryptionGenerationCurrentness, type Encryption } from '@/sync/encryption/encryption';
import type { ServerFetch } from '@/sync/http/client';

type AccountSettingsWriteMaterial = Readonly<{
    identity: AccountEncryptionIdentity;
    settingsVersion: number | undefined;
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
    // The required fresh admission already carries the Settings head. Keep that fact
    // for the sync reader instead of issuing a second currentness request.
    const currentness = await fetchAccountEncryptionCurrentness(params.credentials, { request: params.request });
    const identity = projectAccountEncryptionIdentity(currentness);
    const settingsVersion = currentness.settingsVersion;
    const assertCurrent = () => {
        if (identity.mode === 'e2ee' && (!params.encryption || !lifetime.isCurrent())) throw unavailable();
    };
    assertCurrent();
    if ((params.expectedIdentity && !sameAccountEncryptionIdentity(identity, params.expectedIdentity))
        || (params.expectedMode && identity.mode !== params.expectedMode)) throw unavailable();
    if (identity.mode === 'plain') return { identity, settingsVersion, material: null, assertCurrent };
    const snapshot = resolveCurrentAccountScopedCryptoMaterialSnapshot({ credentials: params.credentials, accountCurrentness: identity });
    if (!snapshot) throw unavailable();
    return { identity, settingsVersion, material: snapshot.material, assertCurrent };
}

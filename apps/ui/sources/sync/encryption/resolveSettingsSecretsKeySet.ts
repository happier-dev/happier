import {
    isTokenOnlyAuthCredentials,
    type AuthCredentials,
} from '@/auth/storage/tokenStorage';
import { resolveDeviceLocalSettingsSecretsKey } from '@/auth/storage/deviceLocalSecretKey';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { SettingsSecretsKeySetV1 } from '@happier-dev/protocol';

import { deriveSettingsSecretsKeySet } from './secretSettings';

export async function resolveSettingsSecretsKeySet(params: Readonly<{
    credentials: AuthCredentials;
    scope: ServerAccountScope;
}>): Promise<SettingsSecretsKeySetV1 | null> {
    if (isTokenOnlyAuthCredentials(params.credentials)) {
        const key = await resolveDeviceLocalSettingsSecretsKey(params.scope);
        return key ? { writeKey: key, readKeys: [key] } : null;
    }

    return deriveSettingsSecretsKeySet(
        resolveAccountScopedCryptoMaterialFromCredentials(params.credentials),
    );
}

import {
  deriveSettingsSecretsKeySetV1,
  type AccountScopedCryptoMaterial,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';

function resolveSettingsSecretsMaterial(credentials: Credentials): AccountScopedCryptoMaterial {
  return credentials.encryption.type === 'legacy'
    ? { type: 'legacy', secret: credentials.encryption.secret }
    : { type: 'dataKey', machineKey: credentials.encryption.machineKey };
}

export function deriveSettingsSecretsKeyForCredentials(credentials: Credentials): Uint8Array {
  return deriveSettingsSecretsKeySetV1(resolveSettingsSecretsMaterial(credentials)).writeKey;
}

export function deriveSettingsSecretsReadKeysForCredentials(credentials: Credentials): readonly Uint8Array[] {
  return deriveSettingsSecretsKeySetV1(resolveSettingsSecretsMaterial(credentials)).readKeys;
}

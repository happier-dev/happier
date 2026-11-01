import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isLegacyAuthCredentials, isDataKeyAuthCredentials } from '@/auth/storage/tokenStorage';
import { EncryptionMaterialUnavailableError } from '@/sync/encryption/encryption';
import { decodeBase64 } from '@/encryption/base64';

function assert32Bytes(label: string, bytes: Uint8Array): Uint8Array {
  if (bytes.length !== 32) {
    throw new Error(`Invalid ${label} length: ${bytes.length} (expected 32)`);
  }
  return bytes;
}

export function resolveAccountScopedCryptoMaterialFromCredentials(
  credentials: AuthCredentials,
): AccountScopedCryptoMaterial {
  if (!isLegacyAuthCredentials(credentials) && !isDataKeyAuthCredentials(credentials)) throw new EncryptionMaterialUnavailableError();
  return isLegacyAuthCredentials(credentials)
    ? {
        type: 'legacy',
        secret: assert32Bytes('recovery secret', decodeBase64(credentials.secret, 'base64url')),
      }
    : {
        type: 'dataKey',
        machineKey: assert32Bytes('machine key', decodeBase64(credentials.encryption.machineKey, 'base64')),
      };
}


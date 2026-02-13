import type { Credentials } from '@/persistence';

import { decodeBase64, libsodiumDecryptForSecretKey } from '../encryption';

export function openSessionDataEncryptionKey(params: {
  credential: Credentials;
  encryptedDataEncryptionKeyBase64: string | null | undefined;
}): Uint8Array | null {
  if (params.credential.encryption.type !== 'dataKey') {
    return null;
  }

  const encryptedBase64 = params.encryptedDataEncryptionKeyBase64;
  if (typeof encryptedBase64 !== 'string' || encryptedBase64.length === 0) {
    return null;
  }

  const encrypted = decodeBase64(encryptedBase64);
  if (encrypted.length < 2) {
    return null;
  }
  if (encrypted[0] !== 0) {
    return null;
  }

  return libsodiumDecryptForSecretKey(encrypted.slice(1), params.credential.encryption.machineKey);
}


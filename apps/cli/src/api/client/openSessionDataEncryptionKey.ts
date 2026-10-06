import type { StoredCredentials } from '@/persistence';

import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { decodeBase64, encodeBase64 } from '../encryption';

export function openSessionDataEncryptionKey(params: {
  credential: StoredCredentials;
  encryptedDataEncryptionKeyBase64: unknown;
}): Uint8Array | null {
  const encryption = params.credential.encryption;
  if (!encryption) return null;
  const encryptedBase64 = params.encryptedDataEncryptionKeyBase64;
  if (typeof encryptedBase64 !== 'string' || encryptedBase64.length === 0) {
    return null;
  }

  const credentialKey = encryption.type === 'legacy' ? encryption.secret : encryption.machineKey;
  if (credentialKey.length !== 32) return null;
  try {
    const encrypted = decodeBase64(encryptedBase64);
    // The shared decoder is deliberately permissive; published envelopes are not.
    if (encodeBase64(encrypted) !== encryptedBase64) return null;
    return openEncryptedDataKeyEnvelopeV1({
      envelope: encrypted,
      recipientSecretKeyOrSeed: encryption.type === 'legacy'
        ? deriveAccountMachineKeyFromRecoverySecret(credentialKey)
        : credentialKey,
    });
  } catch {
    return null;
  }
}

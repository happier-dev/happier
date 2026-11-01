import type { StoredCredentials } from '@/persistence';

import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { readSessionKeyBoundSharedMetadataV1, type SessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { decodeBase64, decrypt, encodeBase64 } from '../encryption';

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

/**
 * Opens the Session key the Home served for a reseal and proves it is this Session's: it must
 * open the served metadata into strict layout-1 shared metadata. Every path that seals the key
 * to someone else, or states a share under it, opens it here.
 */
export function openSessionDataEncryptionKeyForReseal(params: Readonly<{
  credential: StoredCredentials;
  session: Readonly<{ dataEncryptionKey?: unknown; metadata?: unknown; metadataLayoutVersion?: unknown }>;
}>): Readonly<{ dataKey: Uint8Array; sharedMetadata: SessionSharedMetadataV1 }> | null {
  const dataKey = openSessionDataEncryptionKey({
    credential: params.credential,
    encryptedDataEncryptionKeyBase64: params.session.dataEncryptionKey,
  });
  if (!dataKey || typeof params.session.metadata !== 'string') return null;
  let decryptedMetadata: unknown;
  try {
    decryptedMetadata = decrypt(dataKey, 'dataKey', decodeBase64(params.session.metadata));
  } catch {
    return null;
  }
  const sharedMetadata = readSessionKeyBoundSharedMetadataV1({
    metadataLayoutVersion: params.session.metadataLayoutVersion,
    decryptedMetadata,
  });
  return sharedMetadata ? { dataKey, sharedMetadata } : null;
}

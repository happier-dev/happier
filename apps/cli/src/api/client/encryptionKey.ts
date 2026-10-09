import type { Credentials, StoredCredentials } from '@/persistence';
import { createMachineDataEncryptionKeyV1 } from '@happier-dev/protocol/machines/machineStoredContent';

import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { getRandomBytes } from '../encryption';

export type EncryptionContext = {
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  dataEncryptionKey: Uint8Array | null;
};

export class AccountEncryptionMaterialUnavailableError extends Error {
  readonly code = 'encryption_material_unavailable' as const;

  constructor() {
    super('Account encryption material is unavailable');
    this.name = 'AccountEncryptionMaterialUnavailableError';
  }
}

export function requireAccountEncryptionCredentials(
  credential: StoredCredentials,
): Credentials {
  if (!credential.encryption) {
    throw new AccountEncryptionMaterialUnavailableError();
  }
  return credential;
}

export function resolveSessionEncryptionContext(credential: StoredCredentials): EncryptionContext {
  const keyedCredential = requireAccountEncryptionCredentials(credential);
  // Resolve encryption key
  let dataEncryptionKey: Uint8Array | null = null;
  let encryptionKey: Uint8Array;
  let encryptionVariant: 'legacy' | 'dataKey';

  if (keyedCredential.encryption.type === 'dataKey') {
    // Use a per-session key for session message encryption (AES-256-GCM).
    encryptionKey = getRandomBytes(32);
    encryptionVariant = 'dataKey';

    // Publish the per-session key encrypted for the account's content keypair public key.
    dataEncryptionKey = sealEncryptedDataKeyEnvelopeV1({
      dataKey: encryptionKey,
      recipientPublicKey: keyedCredential.encryption.publicKey,
      randomBytes: getRandomBytes,
    });
  } else {
    encryptionKey = keyedCredential.encryption.secret;
    encryptionVariant = 'legacy';
  }

  return { encryptionKey, encryptionVariant, dataEncryptionKey };
}

export function resolveMachineEncryptionContext(credential: StoredCredentials): EncryptionContext {
  const keyedCredential = requireAccountEncryptionCredentials(credential);
  try {
    return createMachineDataEncryptionKeyV1({
      material: keyedCredential.encryption,
      ...(keyedCredential.encryption.type === 'dataKey' ? { dataKeyPublicKey: keyedCredential.encryption.publicKey } : {}),
      randomBytes: getRandomBytes,
    });
  } catch { throw new AccountEncryptionMaterialUnavailableError(); }
}

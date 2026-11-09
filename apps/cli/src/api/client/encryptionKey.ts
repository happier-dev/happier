import type { Credentials, StoredCredentials } from '@/persistence';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { createMachineDataEncryptionKeyV1 } from '@happier-dev/protocol/machines/machineStoredContent';

import { decodeBase64, getRandomBytes } from '../encryption';

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

export async function resolveSessionEncryptionContext(credential: StoredCredentials): Promise<EncryptionContext> {
  const keyedCredential = requireAccountEncryptionCredentials(credential);
  const resourceKey = await createResourceDataKey({ credentials: keyedCredential, mode: 'e2ee' });
  if (resourceKey.mode !== 'e2ee') throw new AccountEncryptionMaterialUnavailableError();

  return {
    encryptionKey: resourceKey.dataKey,
    encryptionVariant: 'dataKey',
    dataEncryptionKey: decodeBase64(resourceKey.dataEncryptionKey),
  };
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

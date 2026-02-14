import type { Credentials } from '@/persistence';

import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { decodeBase64 } from '../encryption';

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
  return openEncryptedDataKeyEnvelopeV1({
    envelope: encrypted,
    recipientSecretKeyOrSeed: params.credential.encryption.machineKey,
  });
}

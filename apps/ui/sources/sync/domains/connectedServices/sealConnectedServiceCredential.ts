import { sealConnectedServiceCredentialCiphertext, type ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { getRandomBytes } from '@/platform/cryptoRandom';

import { resolveAccountScopedCryptoMaterialFromCredentials } from './resolveAccountScopedCryptoMaterialFromCredentials';

export function sealConnectedServiceCredential(params: Readonly<{
  credentials: AuthCredentials;
  record: ConnectedServiceCredentialRecordV1;
  randomBytes?: (length: number) => Uint8Array;
}>): string {
  const randomBytes = params.randomBytes ?? getRandomBytes;

  const material = resolveAccountScopedCryptoMaterialFromCredentials(params.credentials);

  return sealConnectedServiceCredentialCiphertext({
    material,
    payload: params.record,
    randomBytes,
  });
}

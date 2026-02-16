import {
  ConnectedServiceQuotaSnapshotV1Schema,
  openConnectedServiceQuotaSnapshotCiphertext,
  type ConnectedServiceQuotaSnapshotV1,
  type SealedConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAccountScopedCryptoMaterialFromCredentials } from './resolveAccountScopedCryptoMaterialFromCredentials';

export function openConnectedServiceQuotaSnapshot(
  credentials: AuthCredentials,
  sealed: SealedConnectedServiceQuotaSnapshotV1,
): ConnectedServiceQuotaSnapshotV1 | null {
  const material = resolveAccountScopedCryptoMaterialFromCredentials(credentials);

  const opened = openConnectedServiceQuotaSnapshotCiphertext({ material, ciphertext: sealed.ciphertext });
  if (!opened || !opened.value) return null;

  const parsed = ConnectedServiceQuotaSnapshotV1Schema.safeParse(opened.value);
  return parsed.success ? parsed.data : null;
}

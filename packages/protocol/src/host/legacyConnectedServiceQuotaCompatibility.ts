import {
  sealLegacyQuotaSnapshotAccountScopedCiphertext,
  type AccountScopedCryptoMaterial,
} from '../crypto/accountScopedCipher.js';

/**
 * Host-only compatibility writer for the released old-reader direction.
 *
 * This module is deliberately absent from the protocol root and plugin SDK.
 * General account-scoped writers cannot emit the legacy kind-4 domain.
 */
export function sealLegacyConnectedServiceQuotaSnapshotCompatibilityCiphertext(
  params: Readonly<{
    material: AccountScopedCryptoMaterial;
    payload: unknown;
    randomBytes: (length: number) => Uint8Array;
  }>,
): string {
  return sealLegacyQuotaSnapshotAccountScopedCiphertext(params);
}

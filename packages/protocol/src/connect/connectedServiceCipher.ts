import {
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
  type AccountScopedOpenResult,
} from '../crypto/accountScopedCipher.js';

export function sealConnectedServiceCredentialCiphertext(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  payload: unknown;
  randomBytes: (length: number) => Uint8Array;
}>): string {
  return sealAccountScopedBlobCiphertext({
    kind: 'connected_service_credential',
    material: params.material,
    payload: params.payload,
    randomBytes: params.randomBytes,
  });
}

export function openConnectedServiceCredentialCiphertext(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  ciphertext: string;
}>): AccountScopedOpenResult {
  return openAccountScopedBlobCiphertext({
    kind: 'connected_service_credential',
    material: params.material,
    ciphertext: params.ciphertext,
  });
}

export function sealConnectedServiceQuotaSnapshotCiphertext(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  payload: unknown;
  randomBytes: (length: number) => Uint8Array;
}>): string {
  return sealAccountScopedBlobCiphertext({
    kind: 'connected_service_quota_snapshot',
    material: params.material,
    payload: params.payload,
    randomBytes: params.randomBytes,
  });
}

export function openConnectedServiceQuotaSnapshotCiphertext(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  ciphertext: string;
}>): AccountScopedOpenResult {
  return openAccountScopedBlobCiphertext({
    kind: 'connected_service_quota_snapshot',
    material: params.material,
    ciphertext: params.ciphertext,
  });
}


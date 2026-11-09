import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createAccountScopedCryptoMaterialSnapshotV1, type AccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import type { AccountEncryptionIdentity } from '@happier-dev/sync-client';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { isDataKeyAuthCredentials, isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { isHomeCredentialCurrent, subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';

function assert32Bytes(label: string, bytes: Uint8Array): Uint8Array {
  if (bytes.length !== 32) {
    throw new Error(`Invalid ${label} length: ${bytes.length} (expected 32)`);
  }
  return bytes;
}

export function resolveAccountScopedCryptoMaterialFromCredentials(
  credentials: AuthCredentials,
): AccountScopedCryptoMaterial {
  if (isLegacyAuthCredentials(credentials)) {
    return {
        type: 'legacy',
        secret: assert32Bytes('recovery secret', decodeBase64(credentials.secret, 'base64url')),
      };
  }
  if (isDataKeyAuthCredentials(credentials)) {
    return {
        type: 'dataKey',
        machineKey: assert32Bytes('machine key', decodeBase64(credentials.encryption.machineKey, 'base64')),
      };
  }
  throw new Error('Account encryption material is unavailable for token-only credentials');
}

/**
 * The key pair is a pure function of the credential's key bytes and costs one scalar multiplication
 * (tens of ms in JS), so one derivation serves every reader of the same bytes. Entries are keyed by
 * those bytes, so other credentials never reach another Account's pair. An entry is only inserted
 * while its Home still holds those exact credentials, and any Account departure drops them all: a
 * read still in flight across a sign-out or re-key derives for itself and retains nothing, so no
 * derived key outlives the Account that held it. Callers without a Home are never retained.
 * Holders must not mutate the snapshot.
 */
const derivedSnapshots = new Map<string, AccountScopedCryptoMaterialSnapshotV1>();
// Observed from module load, so a departure before the first derivation is still recorded.
subscribeHomeCredentialChange((_event, { accountLeft }) => {
  if (accountLeft) derivedSnapshots.clear();
});

function credentialKeyBytesId(credentials: AuthCredentials): string | null {
  if (isLegacyAuthCredentials(credentials)) return `legacy:${credentials.secret}`;
  if (isDataKeyAuthCredentials(credentials)) return `dataKey:${credentials.encryption.machineKey}:${credentials.encryption.publicKey}`;
  return null;
}

/**
 * The credential's E2EE key pair snapshot; throws for token-only, malformed or mismatched material.
 * `serverId` names the Home the credentials were read from; it is required for retention.
 */
export function deriveAccountScopedCryptoMaterialSnapshot(
  credentials: AuthCredentials,
  serverId?: string | null,
): AccountScopedCryptoMaterialSnapshotV1 {
  const id = credentialKeyBytesId(credentials);
  const retained = id === null ? undefined : derivedSnapshots.get(id);
  if (retained) return retained;
  const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
    accountEncryptionMode: 'e2ee',
    material: resolveAccountScopedCryptoMaterialFromCredentials(credentials),
    ...(isDataKeyAuthCredentials(credentials) ? {
      dataKeyPublicKey: decodeBase64(credentials.encryption.publicKey, 'base64'),
    } : {}),
  });
  if (id !== null && serverId && isHomeCredentialCurrent(serverId, credentials)) derivedSnapshots.set(id, snapshot);
  return snapshot;
}

/** Opening Account content requires material proved against the current Account identity. */
export function resolveCurrentAccountScopedCryptoMaterialSnapshot(params: Readonly<{
  credentials: AuthCredentials;
  accountCurrentness: Pick<AccountEncryptionIdentity, 'mode' | 'contentKeyFingerprint'>;
  /** The Home the credentials were read from; without it the pair is derived but not retained. */
  serverId?: string | null;
}>): AccountScopedCryptoMaterialSnapshotV1 | null {
  if (params.accountCurrentness.mode !== 'e2ee' || !params.accountCurrentness.contentKeyFingerprint) return null;
  try {
    const snapshot = deriveAccountScopedCryptoMaterialSnapshot(params.credentials, params.serverId);
    return convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
      snapshot.contentPublicKeyFingerprint,
    ) === params.accountCurrentness.contentKeyFingerprint ? snapshot : null;
  } catch {
    // Malformed credentials and mismatched public/private keys cannot authorize an open.
    return null;
  }
}

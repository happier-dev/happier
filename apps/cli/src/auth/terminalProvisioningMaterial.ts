import tweetnacl from 'tweetnacl';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { resolveAccountContentSecretKey } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { resolveTerminalProvisioningVariantV2 } from '@happier-dev/protocol/crypto/terminalProvisioningV2';

import type { StoredCredentials } from '@/persistence';

/**
 * The material kind actually sealed, always matching the canonical
 * `TerminalProvisioningV2Response` discriminant.
 */
export type TerminalProvisioningMaterial =
  | Readonly<{ kind: 'tokenOnly' }>
  | Readonly<{ kind: 'dataKey'; contentPrivateKey: Uint8Array }>;

function publicKeyMatchesMachineKey(publicKey: Uint8Array, machineKey: Uint8Array): boolean {
  const derived = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
  if (derived.length !== publicKey.length) return false;
  let difference = 0;
  for (let index = 0; index < derived.length; index += 1) {
    difference |= derived[index]! ^ publicKey[index]!;
  }
  return difference === 0;
}

/** Persisted authenticated Account mode controls issuance; retained keys are only custody. */
export function resolveTerminalProvisioningMaterial(
  credentials: StoredCredentials,
  currentness: Pick<AccountEncryptionCurrentnessResponse, 'mode' | 'contentKeyFingerprint'> | null,
): TerminalProvisioningMaterial {
  const encryptionMode = currentness?.mode;
  if (encryptionMode !== 'plain' && encryptionMode !== 'e2ee') {
    throw new Error('Authenticated Account encryption mode is unavailable');
  }
  const variant = resolveTerminalProvisioningVariantV2({ encryptionMode });
  if (variant === 'tokenOnly') return { kind: 'tokenOnly' };

  const encryption = credentials.encryption;
  if (!encryption) {
    throw new Error('Account encryption material is unavailable on this device');
  }
  let contentPrivateKey: Uint8Array;
  if (encryption.type === 'dataKey') {
    if (encryption.machineKey.length !== 32 || encryption.publicKey.length !== 32) {
      throw new Error('Stored account encryption material has an invalid length');
    }
    if (!publicKeyMatchesMachineKey(encryption.publicKey, encryption.machineKey)) {
      throw new Error('Stored account encryption material is inconsistent with its public key');
    }
    contentPrivateKey = encryption.machineKey;
  } else {
    if (encryption.secret.length !== 32) {
      throw new Error('Stored legacy recovery-secret material has an invalid length');
    }
    contentPrivateKey = resolveAccountContentSecretKey(encryption);
  }
  const fingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(tweetnacl.box.keyPair.fromSecretKey(contentPrivateKey).publicKey);
  if (!currentness?.contentKeyFingerprint || currentness.contentKeyFingerprint !== fingerprint) {
    throw new Error('Account encryption material does not match the current Account content key');
  }
  return { kind: 'dataKey', contentPrivateKey };
}

import tweetnacl from 'tweetnacl';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
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

/**
 * One canonical CLI material decision for authenticated terminal/QR v3
 * provisioning, owned by the shared protocol variant policy. The CLI supplies
 * only its authoritative persisted credential shape; the requester's
 * token-only capability is admission at the caller and never a mode authority.
 * Keyed credentials — data-key or legacy-secret — resolve the same Account
 * content private key; legacy secrets derive it through the protocol
 * derivation owner instead of minting a second formula.
 */
export function resolveTerminalProvisioningMaterial(credentials: StoredCredentials): TerminalProvisioningMaterial {
  const variant = resolveTerminalProvisioningVariantV2({
    encryptionMode: credentials.encryption ? 'e2ee' : 'plain',
  });
  if (variant === 'tokenOnly') return { kind: 'tokenOnly' };

  const encryption = credentials.encryption;
  if (!encryption) {
    // Unreachable with the resolver input above; kept fail-closed for
    // invariant safety rather than inferring material.
    throw new Error('Invalid E2EE provisioning policy result');
  }
  if (encryption.type === 'dataKey') {
    if (!publicKeyMatchesMachineKey(encryption.publicKey, encryption.machineKey)) {
      throw new Error('Stored account encryption material is inconsistent with its public key');
    }
    return { kind: 'dataKey', contentPrivateKey: encryption.machineKey };
  }
  if (encryption.secret.length !== 32) {
    throw new Error('Stored legacy recovery-secret material has an invalid length');
  }
  return { kind: 'dataKey', contentPrivateKey: deriveAccountMachineKeyFromRecoverySecret(encryption.secret) };
}

import tweetnacl from 'tweetnacl';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import { decodeBase64 } from '../crypto/base64.js';
import { deriveAccountMachineKeyFromRecoverySecret, type AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';

const CONTENT_KEY_BINDING_PREFIX = new TextEncoder().encode('Happy content key v1\u0000');

/** The released signing message shared by publication and verification. */
export function createAccountContentPublicKeyBindingMessage(contentPublicKey: Uint8Array): Uint8Array {
  if (contentPublicKey.length !== tweetnacl.box.publicKeyLength) throw new AccountKeyProvisioningUnavailableError();
  const message = new Uint8Array(CONTENT_KEY_BINDING_PREFIX.length + contentPublicKey.length);
  message.set(CONTENT_KEY_BINDING_PREFIX);
  message.set(contentPublicKey, CONTENT_KEY_BINDING_PREFIX.length);
  return message;
}

/** Verifies the published content key against the Account's existing signing authority. */
export function verifyAccountContentPublicKeyBinding(params: Readonly<{
  signingPublicKeyHex: string;
  contentPublicKeyB64: string;
  contentPublicKeySigB64: string;
}>): boolean {
  try {
    const signingPublicKey = hexToBytes(params.signingPublicKeyHex);
    const contentPublicKey = decodeBase64(params.contentPublicKeyB64);
    const signature = decodeBase64(params.contentPublicKeySigB64);
    if (signingPublicKey.length !== tweetnacl.sign.publicKeyLength
      || contentPublicKey.length !== tweetnacl.box.publicKeyLength
      || signature.length !== tweetnacl.sign.signatureLength) return false;
    return tweetnacl.sign.detached.verify(createAccountContentPublicKeyBindingMessage(contentPublicKey), signature, signingPublicKey);
  } catch {
    return false;
  }
}

export class AccountKeyProvisioningUnavailableError extends Error {
  readonly code = 'account_key_provisioning_unavailable';
  constructor() {
    super('The current Account encryption key could not be verified. Restore this Account before linking another device.');
    this.name = 'AccountKeyProvisioningUnavailableError';
  }
}

/** A retained credential is custody, not proof that its key is still the Account's active key. */
export function assertAccountKeyProvisioningAllowed(params: Readonly<{
  mode: 'plain' | 'e2ee';
  account: Readonly<{ id: string; publicKey: string | null; contentPublicKey?: string | null; contentPublicKeySig?: string | null }>;
  material: AccountScopedCryptoMaterial | null;
}>): void {
  if (params.mode === 'plain') return;
  const { account, material } = params;
  if (!material || !account.publicKey) throw new AccountKeyProvisioningUnavailableError();
  if (account.contentPublicKey != null || account.contentPublicKeySig != null) {
    if (!account.contentPublicKey || !account.contentPublicKeySig || !verifyAccountContentPublicKeyBinding({
      signingPublicKeyHex: account.publicKey,
      contentPublicKeyB64: account.contentPublicKey,
      contentPublicKeySigB64: account.contentPublicKeySig,
    })) throw new AccountKeyProvisioningUnavailableError();
    const machineKey = material.type === 'legacy' ? deriveAccountMachineKeyFromRecoverySecret(material.secret) : material.machineKey;
    if (machineKey.length !== tweetnacl.box.secretKeyLength) throw new AccountKeyProvisioningUnavailableError();
    const actual = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const expected = decodeBase64(account.contentPublicKey);
    if (!tweetnacl.verify(actual, expected)) throw new AccountKeyProvisioningUnavailableError();
    return;
  }
  // Released legacy Accounts may predate published content keys. Their recovery secret
  // proves the unchanged signing identity and deterministically derives the content key.
  if (material.type !== 'legacy' || material.secret.length !== tweetnacl.sign.seedLength
    || bytesToHex(tweetnacl.sign.keyPair.fromSeed(material.secret).publicKey) !== account.publicKey.toLowerCase()) {
    throw new AccountKeyProvisioningUnavailableError();
  }
}

import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { bytesToHex } from '@noble/hashes/utils';
import { encodeBase64 } from '../crypto/base64.js';
import { deriveAccountMachineKeyFromRecoverySecret } from '../crypto/accountScopedCipher.js';
import { assertAccountKeyProvisioningAllowed } from './accountKeyProvisioning.js';

function currentAccount(secret: Uint8Array) {
  const signing = tweetnacl.sign.keyPair.fromSeed(secret);
  const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);
  const content = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
  const prefix = new TextEncoder().encode('Happy content key v1\u0000');
  const binding = new Uint8Array(prefix.length + content.length);
  binding.set(prefix); binding.set(content, prefix.length);
  return { id: 'same-account', publicKey: bytesToHex(signing.publicKey),
    contentPublicKey: encodeBase64(content), contentPublicKeySig: encodeBase64(tweetnacl.sign.detached(binding, signing.secretKey)) };
}

describe('Account key provisioning authority', () => {
  const secret = new Uint8Array(32).fill(5);
  const account = currentAccount(secret);
  const machineKey = deriveAccountMachineKeyFromRecoverySecret(secret);

  it('rejects retained same-Account custody that differs from the first published E2EE content key', () => {
    expect(() => assertAccountKeyProvisioningAllowed({ mode: 'e2ee', account,
      material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) } })).toThrow();
    expect(() => assertAccountKeyProvisioningAllowed({ mode: 'e2ee', account,
      material: { type: 'dataKey', machineKey } })).not.toThrow();
    expect(() => assertAccountKeyProvisioningAllowed({ mode: 'e2ee', account,
      material: { type: 'legacy', secret } })).not.toThrow();
  });

  it('preserves released legacy signing proof when the server predates published content keys, but refuses unprovable data keys', () => {
    const legacyAccount = { id: account.id, publicKey: account.publicKey };
    expect(() => assertAccountKeyProvisioningAllowed({ mode: 'e2ee', account: legacyAccount,
      material: { type: 'legacy', secret } })).not.toThrow();
    expect(() => assertAccountKeyProvisioningAllowed({ mode: 'e2ee', account: legacyAccount,
      material: { type: 'dataKey', machineKey } })).toThrow();
    expect(() => assertAccountKeyProvisioningAllowed({ mode: 'e2ee', account: legacyAccount,
      material: { type: 'legacy', secret: new Uint8Array(32).fill(9) } })).toThrow();
  });

  it('rejects a published key without its valid binding instead of taking the legacy fallback', () => {
    for (const contentPublicKeySig of [null, encodeBase64(new Uint8Array(64))]) {
      expect(() => assertAccountKeyProvisioningAllowed({ mode: 'e2ee', account: { ...account, contentPublicKeySig },
        material: { type: 'legacy', secret } })).toThrow();
    }
  });

  it('preserves plain-Account historical custody and token-only absence without asserting a new Account key', () => {
    const plainAccount = { id: account.id, publicKey: null };
    for (const material of [null, { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) }]) {
      expect(() => assertAccountKeyProvisioningAllowed({ mode: 'plain', account: plainAccount, material })).not.toThrow();
    }
    expect(() => assertAccountKeyProvisioningAllowed({ mode: 'e2ee', account, material: null })).toThrow();
  });
});

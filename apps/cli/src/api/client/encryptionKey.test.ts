import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';

import { resolveMachineEncryptionContext, resolveSessionEncryptionContext } from './encryptionKey';

describe('resolveSessionEncryptionContext', () => {
  it('generates a per-session AES key and publishes an encrypted dataEncryptionKey bundle when credentials are dataKey', () => {
    const machineKey = new Uint8Array(32).fill(7);
    const publicKey = new Uint8Array(32).fill(3);

    const res = resolveSessionEncryptionContext({
      token: 't',
      encryption: {
        type: 'dataKey',
        publicKey,
        machineKey,
      },
    });

    expect(res.encryptionVariant).toBe('dataKey');
    expect(res.encryptionKey).toBeInstanceOf(Uint8Array);
    expect(res.encryptionKey.length).toBe(32);
    expect(res.dataEncryptionKey).not.toBeNull();
    expect(res.dataEncryptionKey![0]).toBe(0);
    expect(res.dataEncryptionKey!.length).toBeGreaterThan(1);
  });
});

describe('resolveMachineEncryptionContext', () => {
  it.each(['dataKey', 'legacy'] as const)('creates distinct resource keys sealed to the owner using %s credentials', (type) => {
    const secret = new Uint8Array(32).fill(17);
    const machineKey = type === 'legacy' ? deriveAccountMachineKeyFromRecoverySecret(secret) : secret;
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
    const credential = { token: 't', encryption: type === 'legacy'
      ? { type, secret }
      : { type, machineKey, publicKey } };
    const first = resolveMachineEncryptionContext(credential);
    const second = resolveMachineEncryptionContext(credential);
    expect(first.encryptionVariant).toBe('dataKey');
    expect(first.encryptionKey).toHaveLength(32);
    expect(first.encryptionKey).not.toEqual(second.encryptionKey);
    expect(first.encryptionKey).not.toEqual(secret);
    expect(first.encryptionKey).not.toEqual(machineKey);
    expect(openEncryptedDataKeyEnvelopeV1({
      envelope: first.dataEncryptionKey!, recipientSecretKeyOrSeed: machineKey,
    })).toEqual(first.encryptionKey);
    expect(openEncryptedDataKeyEnvelopeV1({
      envelope: second.dataEncryptionKey!, recipientSecretKeyOrSeed: machineKey,
    })).toEqual(second.encryptionKey);
  });
});

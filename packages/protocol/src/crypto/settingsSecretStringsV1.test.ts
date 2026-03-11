import { describe, expect, it } from 'vitest';

import {
  decryptSecretValueWithKeysV1,
  decryptSecretStringV1,
  decryptSecretValueV1,
  deriveSettingsSecretsKeySetV1,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
  resealSecretsDeepV1,
  sealSecretsDeepV1,
  unsealSecretsDeepV1,
} from './settingsSecretStringsV1.js';
import { deriveAccountMachineKeyFromRecoverySecret } from './accountScopedCipher.js';

function deterministicRandomBytesFactory(): (length: number) => Uint8Array {
  let counter = 1;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = counter & 0xff;
      counter++;
    }
    return out;
  };
}

describe('settingsSecretStringsV1', () => {
  it('encrypts and decrypts secret strings', () => {
    const key = new Uint8Array(32).fill(7);
    const randomBytes = deterministicRandomBytesFactory();

    const enc = encryptSecretStringV1('sk-test', key, randomBytes);
    expect(enc.t).toBe('enc-v1');
    expect(typeof enc.c).toBe('string');
    expect(enc.c.length).toBeGreaterThan(0);

    expect(decryptSecretStringV1(enc, key)).toBe('sk-test');
    expect(decryptSecretStringV1(enc, new Uint8Array(32).fill(8))).toBeNull();
  });

  it('decryptSecretValueV1 returns plaintext value when present (does not mutate input)', () => {
    const key = new Uint8Array(32).fill(7);
    const input = { _isSecretValue: true as const, value: 'sk-plain', encryptedValue: undefined };
    const out = decryptSecretValueV1(input, key);
    expect(out).toBe('sk-plain');
    expect(input.value).toBe('sk-plain');
    expect(input.encryptedValue).toBeUndefined();
  });

  it('sealSecretsDeepV1 encrypts SecretString.value into SecretString.encryptedValue and drops SecretString.value', () => {
    const key = new Uint8Array(32).fill(7);
    const randomBytes = deterministicRandomBytesFactory();
    const delta = {
      secrets: [{ id: 'k1', name: 'Key', encryptedValue: { _isSecretValue: true as const, value: 'sk-test' } }],
    };

    const sealed = sealSecretsDeepV1(delta, key, randomBytes);
    const item: any = (sealed as any).secrets[0];
    expect(item.encryptedValue?.value).toBeUndefined();
    expect(item.encryptedValue?.encryptedValue?.t).toBe('enc-v1');
    expect(typeof item.encryptedValue?.encryptedValue?.c).toBe('string');
    expect(item.encryptedValue.encryptedValue.c.length).toBeGreaterThan(0);

    // Non-mutating: the source input remains unchanged.
    expect((delta as any).secrets[0].encryptedValue.value).toBe('sk-test');
  });

  it('sealSecretsDeepV1 does not encrypt objects without secret marker', () => {
    const key = new Uint8Array(32).fill(7);
    const randomBytes = deterministicRandomBytesFactory();
    const delta = { value: 'not-a-secret', encryptedValue: undefined };
    const sealed = sealSecretsDeepV1(delta, key, randomBytes);
    expect((sealed as any).value).toBe('not-a-secret');
  });

  it('unsealSecretsDeepV1 decrypts encryptedValue into value and drops encryptedValue', () => {
    const key = new Uint8Array(32).fill(7);
    const randomBytes = deterministicRandomBytesFactory();
    const sealed = sealSecretsDeepV1({ secret: { _isSecretValue: true as const, value: 'sk-test' } }, key, randomBytes);
    const container: any = (sealed as any).secret;
    expect(container.encryptedValue?.t).toBe('enc-v1');

    const unsealed = unsealSecretsDeepV1(sealed, key);
    const out: any = (unsealed as any).secret;
    expect(out.value).toBe('sk-test');
    expect(out.encryptedValue).toBeUndefined();
  });

  it('reseals legacy settings secrets onto the canonical machine-key write key while preserving legacy reads', () => {
    const recoverySecret = new Uint8Array(32).fill(5);
    const machineKey = deriveAccountMachineKeyFromRecoverySecret(recoverySecret);
    const legacyKeySet = deriveSettingsSecretsKeySetV1({ type: 'legacy', secret: recoverySecret });
    const dataKeyKeySet = deriveSettingsSecretsKeySetV1({ type: 'dataKey', machineKey });
    const randomBytes = deterministicRandomBytesFactory();
    const legacyFallbackKey = deriveSettingsSecretsKeyV1(recoverySecret);

    const legacyEncryptedValue = encryptSecretStringV1(
      'sk-legacy',
      legacyFallbackKey,
      randomBytes,
    );

    const resealed = resealSecretsDeepV1(
      { secret: { _isSecretValue: true as const, encryptedValue: legacyEncryptedValue } },
      { readKeys: legacyKeySet.readKeys, writeKey: legacyKeySet.writeKey, randomBytes },
    );

    expect(resealed.changed).toBe(true);
    expect(decryptSecretValueWithKeysV1((resealed.value as any).secret, dataKeyKeySet.readKeys)).toBe('sk-legacy');
    expect(decryptSecretValueWithKeysV1((resealed.value as any).secret, legacyKeySet.readKeys)).toBe('sk-legacy');
  });
});

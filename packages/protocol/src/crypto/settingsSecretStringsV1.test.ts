import { describe, expect, it } from 'vitest';

import {
  type EncryptedStringV1,
  type SecretStringV1,
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

type SecretContainer = Readonly<{ secret: SecretStringV1 }>;

function readSecret(container: SecretContainer): SecretStringV1 {
  return container.secret;
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

  it('throws a clear error when the secretbox key length is invalid', () => {
    const randomBytes = deterministicRandomBytesFactory();

    expect(() => encryptSecretStringV1('sk-test', new Uint8Array(31), randomBytes)).toThrow(
      'Invalid secretbox key length: 31',
    );
  });

  it('decryptSecretValueV1 returns plaintext value when present (does not mutate input)', () => {
    const key = new Uint8Array(32).fill(7);
    const input: SecretStringV1 = { _isSecretValue: true, value: 'sk-plain' };
    const out = decryptSecretValueV1(input, key);
    expect(out).toBe('sk-plain');
    expect(input.value).toBe('sk-plain');
    expect(input.encryptedValue).toBeUndefined();
  });

  it('decryptSecretValueV1 preserves significant plaintext whitespace', () => {
    const input: SecretStringV1 = { _isSecretValue: true, value: '  sk-plain  ' };

    expect(decryptSecretValueV1(input, new Uint8Array(32).fill(7))).toBe('  sk-plain  ');
  });

  it('sealSecretsDeepV1 encrypts SecretString.value into SecretString.encryptedValue and drops SecretString.value', () => {
    const key = new Uint8Array(32).fill(7);
    const randomBytes = deterministicRandomBytesFactory();
    const delta = {
      secrets: [{ id: 'k1', name: 'Key', encryptedValue: { _isSecretValue: true, value: 'sk-test' } satisfies SecretStringV1 }],
    };

    const sealed = sealSecretsDeepV1(delta, key, randomBytes);
    const item = sealed.secrets[0]?.encryptedValue;
    expect(item?.value).toBeUndefined();
    expect(item?.encryptedValue?.t).toBe('enc-v1');
    expect(typeof item?.encryptedValue?.c).toBe('string');
    expect(item?.encryptedValue?.c.length).toBeGreaterThan(0);

    // Non-mutating: the source input remains unchanged.
    expect(delta.secrets[0]?.encryptedValue.value).toBe('sk-test');
  });

  it('sealSecretsDeepV1 drops whitespace-only plaintext values', () => {
    const key = new Uint8Array(32).fill(7);
    const randomBytes = deterministicRandomBytesFactory();
    const input: SecretContainer = {
      secret: { _isSecretValue: true, value: '   ' },
    };

    const sealed = sealSecretsDeepV1(input, key, randomBytes);

    expect(readSecret(sealed).value).toBeUndefined();
    expect(readSecret(sealed).encryptedValue).toBeUndefined();
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
    const sealed = sealSecretsDeepV1({ secret: { _isSecretValue: true, value: 'sk-test' } satisfies SecretStringV1 }, key, randomBytes);
    const container = readSecret(sealed);
    expect(container.encryptedValue?.t).toBe('enc-v1');

    const unsealed = unsealSecretsDeepV1(sealed, key);
    const out = readSecret(unsealed);
    expect(out.value).toBe('sk-test');
    expect(out.encryptedValue).toBeUndefined();
  });

  it('unsealSecretsDeepV1 drops encryptedValue even when plaintext already exists', () => {
    const key = new Uint8Array(32).fill(7);
    const randomBytes = deterministicRandomBytesFactory();
    const encryptedValue: EncryptedStringV1 = encryptSecretStringV1('sk-test', key, randomBytes);
    const input: SecretContainer = {
      secret: {
        _isSecretValue: true,
        value: 'sk-test',
        encryptedValue,
      },
    };

    const unsealed = unsealSecretsDeepV1(input, key);

    expect(readSecret(unsealed)).toEqual({
      _isSecretValue: true,
      value: 'sk-test',
    });
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
    expect(decryptSecretValueWithKeysV1(readSecret(resealed.value as SecretContainer), dataKeyKeySet.readKeys)).toBe('sk-legacy');
    expect(decryptSecretValueWithKeysV1(readSecret(resealed.value as SecretContainer), legacyKeySet.readKeys)).toBe('sk-legacy');
  });
});

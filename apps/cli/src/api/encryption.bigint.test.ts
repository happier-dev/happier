import { describe, expect, it } from 'vitest';

import { decrypt, encrypt, decryptLegacy, encryptLegacy, decryptWithDataKey, encryptWithDataKey } from '@/api/encryption';

describe('encryption BigInt handling', () => {
  it('encryptLegacy does not throw on BigInt values', () => {
    const secret = new Uint8Array(32).fill(7);
    const input = { value: BigInt(123) };

    expect(() => encryptLegacy(input, secret)).not.toThrow();
    const ciphertext = encryptLegacy(input, secret);
    expect(decryptLegacy(ciphertext, secret)).toEqual({ value: '123n' });
  });

  it('encryptWithDataKey does not throw on BigInt values', () => {
    const key = new Uint8Array(32).fill(9);
    const input = { value: BigInt(456) };

    expect(() => encryptWithDataKey(input, key)).not.toThrow();
    const ciphertext = encryptWithDataKey(input, key);
    expect(decryptWithDataKey(ciphertext, key)).toEqual({ value: '456n' });
  });

  it('encrypt() does not throw on BigInt values for both variants', () => {
    const legacyKey = new Uint8Array(32).fill(1);
    const dataKey = new Uint8Array(32).fill(2);
    const input = { value: BigInt(1) };

    expect(() => encrypt(legacyKey, 'legacy', input)).not.toThrow();
    expect(decrypt(legacyKey, 'legacy', encrypt(legacyKey, 'legacy', input))).toEqual({ value: '1n' });

    expect(() => encrypt(dataKey, 'dataKey', input)).not.toThrow();
    expect(decrypt(dataKey, 'dataKey', encrypt(dataKey, 'dataKey', input))).toEqual({ value: '1n' });
  });
});


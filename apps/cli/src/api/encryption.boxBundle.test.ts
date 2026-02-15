import { describe, expect, it } from 'vitest';

import {
  getRandomBytes,
  libsodiumDecryptForSecretKey,
  libsodiumEncryptForPublicKey,
  libsodiumPublicKeyFromSecretKey,
} from './encryption';

describe('libsodium box bundle (CLI compat)', () => {
  it('decrypts a box bundle when recipient secret is provided as a CLI-style seed', () => {
    const seed = new Uint8Array(32).fill(7);
    const publicKey = libsodiumPublicKeyFromSecretKey(seed);
    const plaintext = getRandomBytes(32);

    const bundle = libsodiumEncryptForPublicKey(plaintext, publicKey);
    const opened = libsodiumDecryptForSecretKey(bundle, seed);

    expect(opened).not.toBeNull();
    expect(Array.from(opened!)).toEqual(Array.from(plaintext));
  });

  it('returns null (and does not throw) when bundle is malformed', () => {
    const seed = new Uint8Array(32).fill(1);
    expect(libsodiumDecryptForSecretKey(new Uint8Array([1, 2, 3]), seed)).toBeNull();
  });

  it('returns null (and does not throw) when recipient key length is unexpected', () => {
    const badKey = new Uint8Array(5).fill(2);
    expect(libsodiumDecryptForSecretKey(new Uint8Array(60).fill(9), badKey)).toBeNull();
  });
});


import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';

import {
  libsodiumDecryptForSecretKey,
  libsodiumEncryptForPublicKey,
  libsodiumPublicKeyFromSecretKey,
} from './encryption';

describe('libsodiumDecryptForSecretKey', () => {
  it('decrypts a bundle encrypted for the recipient public key (secret key input)', () => {
    const recipient = tweetnacl.box.keyPair();
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);

    const bundle = libsodiumEncryptForPublicKey(plaintext, recipient.publicKey);
    const opened = libsodiumDecryptForSecretKey(bundle, recipient.secretKey);

    expect(opened).toEqual(plaintext);
  });

  it('decrypts a bundle encrypted for the public key derived from a seed (seed input)', () => {
    const seed = new Uint8Array(32).fill(9);
    const recipientPublicKey = libsodiumPublicKeyFromSecretKey(seed);
    const plaintext = new Uint8Array([7, 6, 5, 4, 3, 2, 1]);

    const bundle = libsodiumEncryptForPublicKey(plaintext, recipientPublicKey);
    const opened = libsodiumDecryptForSecretKey(bundle, seed);

    expect(opened).toEqual(plaintext);
  });

  it('returns null for an invalid bundle', () => {
    const recipient = tweetnacl.box.keyPair();
    expect(libsodiumDecryptForSecretKey(new Uint8Array([1, 2, 3]), recipient.secretKey)).toBeNull();
  });

  it('returns null for an invalid secret key', () => {
    const recipient = tweetnacl.box.keyPair();
    const plaintext = new Uint8Array([1, 2, 3]);
    const bundle = libsodiumEncryptForPublicKey(plaintext, recipient.publicKey);

    expect(libsodiumDecryptForSecretKey(bundle, new Uint8Array(10))).toBeNull();
  });
});


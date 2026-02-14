import { describe, expect, it } from 'vitest';

import { sha512 } from '@noble/hashes/sha512';
import tweetnacl from 'tweetnacl';

import { openBoxBundle, sealBoxBundle } from './boxBundle.js';

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

describe('boxBundle', () => {
  it('seals and opens a box bundle with recipient secret key', () => {
    const recipientSecretKey = new Uint8Array(32).fill(9);
    const recipientPublicKey = tweetnacl.box.keyPair.fromSecretKey(recipientSecretKey).publicKey;
    const plaintext = new Uint8Array(32).fill(3);

    const bundle = sealBoxBundle({
      plaintext,
      recipientPublicKey,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const opened = openBoxBundle({
      bundle,
      recipientSecretKeyOrSeed: recipientSecretKey,
    });

    expect(opened).not.toBeNull();
    expect(Array.from(opened!)).toEqual(Array.from(plaintext));
  });

  it('opens a box bundle when recipient secret key is provided as a seed (CLI compat)', () => {
    const seed = new Uint8Array(32).fill(11);
    const compatSecretKey = sha512(seed).slice(0, 32);
    const recipientPublicKey = tweetnacl.box.keyPair.fromSecretKey(compatSecretKey).publicKey;
    const plaintext = new Uint8Array(32).fill(7);

    const bundle = sealBoxBundle({
      plaintext,
      recipientPublicKey,
      randomBytes: deterministicRandomBytesFactory(),
    });

    const opened = openBoxBundle({
      bundle,
      recipientSecretKeyOrSeed: seed,
    });

    expect(opened).not.toBeNull();
    expect(Array.from(opened!)).toEqual(Array.from(plaintext));
  });

  it('returns null (and does not throw) when bundle is malformed', () => {
    const seed = new Uint8Array(32).fill(1);
    expect(openBoxBundle({ bundle: new Uint8Array([1, 2, 3]), recipientSecretKeyOrSeed: seed })).toBeNull();
  });

  it('returns null (and does not throw) when recipient key length is unexpected', () => {
    const publicKey = new Uint8Array(32).fill(2);
    const plaintext = new Uint8Array(32).fill(3);
    const bundle = sealBoxBundle({
      plaintext,
      recipientPublicKey: publicKey,
      randomBytes: deterministicRandomBytesFactory(),
    });
    expect(openBoxBundle({ bundle, recipientSecretKeyOrSeed: new Uint8Array(10) })).toBeNull();
  });
});


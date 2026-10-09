import { describe, expect, it } from 'vitest';

import { sha512 } from '@noble/hashes/sha512';
import tweetnacl from 'tweetnacl';

import {
  BOX_BUNDLE_MIN_BYTES,
  BOX_BUNDLE_NONCE_BYTES,
  BOX_BUNDLE_PUBLIC_KEY_BYTES,
  isValidBoxBundlePublicKey,
  openBoxBundle,
  openBoxBundleWithSecretKey,
  sealBoxBundle,
  deriveBoxSecretKeyFromSeed,
  deriveBoxPublicKeyFromEd25519PublicKey,
} from './boxBundle.js';

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

function bytesFromHex(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{2}/gu)!.map((byte) => parseInt(byte, 16)));
}

// Published low-order X25519 u-coordinates (little-endian). Each encodes a
// point of the curve's order-8 torsion subgroup (or the identity), which any
// clamped scalar annihilates. Syntactically they are canonical 32-byte keys.
const LOW_ORDER_PUBLIC_KEYS: ReadonlyArray<Readonly<{ name: string; bytes: Uint8Array }>> = [
  { name: 'all-zero (order 1)', bytes: new Uint8Array(32) },
  { name: 'u=1 (small order)', bytes: bytesFromHex('0100000000000000000000000000000000000000000000000000000000000000') },
  { name: 'order-8 point', bytes: bytesFromHex('e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800') },
  { name: 'order-8 point (negation)', bytes: bytesFromHex('5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157') },
  { name: 'p-1 (order 2)', bytes: bytesFromHex('ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f') },
];

describe('boxBundle', () => {
  it('seals to an installed Ed25519 identity without requiring its private seed', () => {
    const installed = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(37));
    const payload = new TextEncoder().encode('original SOURCE writer and exact TARGET custody');
    const bundle = sealBoxBundle({ plaintext: payload,
      recipientPublicKey: deriveBoxPublicKeyFromEd25519PublicKey(installed.publicKey),
      randomBytes: deterministicRandomBytesFactory() });
    expect(openBoxBundleWithSecretKey({ bundle,
      recipientSecretKey: deriveBoxSecretKeyFromSeed(installed.secretKey.subarray(0, 32)) })).toEqual(payload);
    expect(openBoxBundleWithSecretKey({ bundle,
      recipientSecretKey: deriveBoxSecretKeyFromSeed(new Uint8Array(32).fill(38)) })).toBeNull();
    expect(() => deriveBoxPublicKeyFromEd25519PublicKey(new Uint8Array(31))).toThrow();
    expect(() => deriveBoxPublicKeyFromEd25519PublicKey(new Uint8Array(32))).toThrow();
  });
  // The published layout sizes are stated as literals in `boxBundleFormat.ts`
  // so wire schemas can consume them without loading the box implementation.
  // A literal that drifted from the primitive would silently change the framing
  // this codec emits, so pin each one to the primitive it frames.
  it('pins the published bundle layout to the box primitive it frames', () => {
    expect(BOX_BUNDLE_PUBLIC_KEY_BYTES).toBe(tweetnacl.box.publicKeyLength);
    expect(BOX_BUNDLE_NONCE_BYTES).toBe(tweetnacl.box.nonceLength);
    expect(BOX_BUNDLE_MIN_BYTES).toBe(
      tweetnacl.box.publicKeyLength + tweetnacl.box.nonceLength + tweetnacl.box.overheadLength,
    );
  });

  it('opens only the exact raw X25519 recipient key without interpreting it as a seed', () => {
    const recipientSecretKey = new Uint8Array(32).fill(11);
    const plaintext = new TextEncoder().encode('reviewed Runner bootstrap');
    const rawBundle = sealBoxBundle({
      plaintext,
      recipientPublicKey: tweetnacl.box.keyPair.fromSecretKey(recipientSecretKey).publicKey,
      randomBytes: deterministicRandomBytesFactory(),
    });
    const seedBundle = sealBoxBundle({
      plaintext,
      recipientPublicKey: tweetnacl.box.keyPair.fromSecretKey(sha512(recipientSecretKey).slice(0, 32)).publicKey,
      randomBytes: deterministicRandomBytesFactory(),
    });

    expect(openBoxBundleWithSecretKey({ bundle: rawBundle, recipientSecretKey })).toEqual(plaintext);
    expect(openBoxBundleWithSecretKey({ bundle: seedBundle, recipientSecretKey })).toBeNull();
    expect(openBoxBundle({ bundle: seedBundle, recipientSecretKeyOrSeed: recipientSecretKey })).toEqual(plaintext);
  });

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

  it('seals reject all-zero and representative low-order recipient public keys', () => {
    const plaintext = new Uint8Array(32).fill(3);
    for (const key of LOW_ORDER_PUBLIC_KEYS) {
      expect(() => sealBoxBundle({
        plaintext,
        recipientPublicKey: key.bytes,
        randomBytes: deterministicRandomBytesFactory(),
      })).toThrowError(/recipient public key/i);
    }
  });

  it('seals reject wrong-length recipient public keys', () => {
    expect(() => sealBoxBundle({
      plaintext: new Uint8Array(32).fill(3),
      recipientPublicKey: new Uint8Array(31),
      randomBytes: deterministicRandomBytesFactory(),
    })).toThrowError(/recipient public key/i);
  });

  it('open rejects a low-order embedded ephemeral public key before any plaintext is returned', () => {
    const victimKeyPair = tweetnacl.box.keyPair();
    const lowOrderEphemeral = new Uint8Array(32);
    const attackerSecretKey = new Uint8Array(32).fill(1);
    const plaintext = new TextEncoder().encode('attacker-chosen plaintext');
    const nonce = deterministicRandomBytesFactory()(tweetnacl.box.nonceLength);
    // Attacker-side sealing against the low-order ephemeral point derives the
    // same public (all-zero) shared secret the victim will derive, so the
    // ciphertext authenticates without any victim secret material.
    const boxed = tweetnacl.box(plaintext, nonce, lowOrderEphemeral, attackerSecretKey);
    const bundle = new Uint8Array(BOX_BUNDLE_PUBLIC_KEY_BYTES + BOX_BUNDLE_NONCE_BYTES + boxed.length);
    bundle.set(lowOrderEphemeral, 0);
    bundle.set(nonce, BOX_BUNDLE_PUBLIC_KEY_BYTES);
    bundle.set(boxed, BOX_BUNDLE_PUBLIC_KEY_BYTES + BOX_BUNDLE_NONCE_BYTES);

    expect(openBoxBundle({ bundle, recipientSecretKeyOrSeed: victimKeyPair.secretKey })).toBeNull();
  });

  it('validates public keys by the cryptographic property, not syntax alone', () => {
    expect(isValidBoxBundlePublicKey(tweetnacl.box.keyPair().publicKey)).toBe(true);
    expect(isValidBoxBundlePublicKey(new Uint8Array(31))).toBe(false);
    expect(isValidBoxBundlePublicKey(new Uint8Array(33))).toBe(false);
    for (const key of LOW_ORDER_PUBLIC_KEYS) {
      expect(isValidBoxBundlePublicKey(key.bytes)).toBe(false);
    }
  });
});

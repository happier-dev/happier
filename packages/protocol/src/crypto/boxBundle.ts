import tweetnacl from 'tweetnacl';
import { sha512 } from '@noble/hashes/sha512';
import { ed25519 } from '@noble/curves/ed25519';
import { isValidEd25519PublicKey } from './ed25519.js';

import {
  BOX_BUNDLE_MIN_BYTES,
  BOX_BUNDLE_NONCE_BYTES,
  BOX_BUNDLE_PUBLIC_KEY_BYTES,
} from './boxBundleFormat.js';
import { isValidBoxBundlePublicKey } from './boxPublicKeyValidation.js';

export { BOX_BUNDLE_MIN_BYTES, BOX_BUNDLE_NONCE_BYTES, BOX_BUNDLE_PUBLIC_KEY_BYTES };
export { isValidBoxBundlePublicKey } from './boxPublicKeyValidation.js';

export function deriveBoxSecretKeyFromSeed(seed: Uint8Array): Uint8Array {
  // libsodium crypto_box_seed_keypair uses SHA-512(seed) and takes the first 32 bytes as the scalar.
  return sha512(seed).slice(0, 32);
}

export function deriveBoxPublicKeyFromSeed(seed: Uint8Array): Uint8Array {
  const secretKey = deriveBoxSecretKeyFromSeed(seed);
  return tweetnacl.box.keyPair.fromSecretKey(secretKey).publicKey;
}

/** The installed signing identity selects the same box recipient as its private seed. */
export function deriveBoxPublicKeyFromEd25519PublicKey(publicKey: Uint8Array): Uint8Array {
  if (!isValidEd25519PublicKey(publicKey)) throw new Error('Invalid Ed25519 installation public key');
  const recipient = ed25519.utils.toMontgomery(publicKey);
  if (!isValidBoxBundlePublicKey(recipient)) throw new Error('Invalid installation box recipient');
  return recipient;
}

export function sealBoxBundle(params: {
  plaintext: Uint8Array;
  recipientPublicKey: Uint8Array;
  randomBytes: (length: number) => Uint8Array;
}): Uint8Array {
  if (params.recipientPublicKey.length !== BOX_BUNDLE_PUBLIC_KEY_BYTES) {
    throw new Error(`Invalid recipient public key length: ${params.recipientPublicKey.length}`);
  }
  if (!isValidBoxBundlePublicKey(params.recipientPublicKey)) {
    throw new Error('Invalid recipient public key: low-order X25519 public keys are rejected');
  }

  const ephSecretKey = params.randomBytes(tweetnacl.box.secretKeyLength);
  if (ephSecretKey.length !== tweetnacl.box.secretKeyLength) {
    throw new Error(`Invalid ephemeral secret key length: ${ephSecretKey.length}`);
  }
  const ephKeyPair = tweetnacl.box.keyPair.fromSecretKey(ephSecretKey);

  const nonce = params.randomBytes(tweetnacl.box.nonceLength);
  if (nonce.length !== tweetnacl.box.nonceLength) {
    throw new Error(`Invalid nonce length: ${nonce.length}`);
  }

  const boxed = tweetnacl.box(params.plaintext, nonce, params.recipientPublicKey, ephSecretKey);

  const out = new Uint8Array(ephKeyPair.publicKey.length + nonce.length + boxed.length);
  out.set(ephKeyPair.publicKey, 0);
  out.set(nonce, ephKeyPair.publicKey.length);
  out.set(boxed, ephKeyPair.publicKey.length + nonce.length);
  return out;
}

export function openBoxBundleWithSecretKey(params: {
  bundle: Uint8Array;
  recipientSecretKey: Uint8Array;
}): Uint8Array | null {
  const bundle = params.bundle;
  if (bundle.length < BOX_BUNDLE_MIN_BYTES) {
    return null;
  }
  if (params.recipientSecretKey.length !== tweetnacl.box.secretKeyLength) {
    return null;
  }

  const ephemeralPublicKey = bundle.slice(0, BOX_BUNDLE_PUBLIC_KEY_BYTES);
  const nonce = bundle.slice(BOX_BUNDLE_PUBLIC_KEY_BYTES, BOX_BUNDLE_PUBLIC_KEY_BYTES + BOX_BUNDLE_NONCE_BYTES);
  const boxed = bundle.slice(BOX_BUNDLE_PUBLIC_KEY_BYTES + BOX_BUNDLE_NONCE_BYTES);

  // A low-order embedded ephemeral key forces a publicly computable shared
  // secret; reject before any plaintext could be produced.
  if (!isValidBoxBundlePublicKey(ephemeralPublicKey)) return null;

  try {
    const opened = tweetnacl.box.open(boxed, nonce, ephemeralPublicKey, params.recipientSecretKey);
    return opened ? new Uint8Array(opened) : null;
  } catch {
    return null;
  }
}

export function openBoxBundle(params: {
  bundle: Uint8Array;
  recipientSecretKeyOrSeed: Uint8Array;
}): Uint8Array | null {
  if (params.recipientSecretKeyOrSeed.length !== tweetnacl.box.secretKeyLength) return null;
  const direct = openBoxBundleWithSecretKey({
    bundle: params.bundle,
    recipientSecretKey: params.recipientSecretKeyOrSeed,
  });
  if (direct) return direct;

  // Retain the released CLI seed interpretation only at this compatibility seam.
  return openBoxBundleWithSecretKey({
    bundle: params.bundle,
    recipientSecretKey: deriveBoxSecretKeyFromSeed(params.recipientSecretKeyOrSeed),
  });
}

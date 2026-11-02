import { ed25519 } from '@noble/curves/ed25519';

export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SECRET_KEY_BYTES = 64;
export const ED25519_SIGNATURE_BYTES = 64;
const ED25519_SEED_BYTES = 32;

/** Sign with the released NaCl secret-key representation (`seed || publicKey`). */
export function signEd25519Message(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== ED25519_SECRET_KEY_BYTES) {
    throw new Error(`Invalid Ed25519 secret key length: expected ${ED25519_SECRET_KEY_BYTES} bytes`);
  }
  return ed25519.sign(message, secretKey.subarray(0, ED25519_SEED_BYTES));
}

/** Reject malformed/noncanonical encodings and small-order keys that admit forged proofs. */
export function isValidEd25519PublicKey(publicKey: Uint8Array): boolean {
  try {
    return !ed25519.Point.fromBytes(publicKey, false).isSmallOrder();
  } catch {
    return false;
  }
}

/** RFC 8032 verification preserves ordinary signatures while rejecting small-order public keys. */
export function verifyEd25519Signature(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

export function deriveEd25519KeyPair(seed: Uint8Array): Readonly<{ publicKey: Uint8Array; secretKey: Uint8Array }> {
  if (seed.length !== ED25519_SEED_BYTES) {
    throw new Error(`Invalid Ed25519 seed length: expected ${ED25519_SEED_BYTES} bytes`);
  }
  const publicKey = ed25519.getPublicKey(seed);
  const secretKey = new Uint8Array(ED25519_SECRET_KEY_BYTES);
  secretKey.set(seed);
  secretKey.set(publicKey, ED25519_SEED_BYTES);
  return { publicKey, secretKey };
}

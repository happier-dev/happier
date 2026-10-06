import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { decodeBase64 as decodeBase64Protocol, encodeBase64 as encodeBase64Protocol } from '@happier-dev/protocol/crypto/base64';
import { deriveBoxPublicKeyFromSeed, openBoxBundle, sealBoxBundle } from '@happier-dev/protocol/crypto/boxBundle';
import { packSessionDataKeyBundleV0, parseSessionDataKeyValue, readSessionDataKeyBundleV0, serializeSessionDataKeyValue, SESSION_DATA_KEY_BYTES, SESSION_DATA_KEY_NONCE_BYTES } from '@happier-dev/protocol/crypto/sessionDataKeyBundleV0';
import { parseSerializedJsonValue, stringifySerializedJsonValue } from '@happier-dev/protocol/crypto/serializedJsonValue';
import type { Base64Variant } from '@happier-dev/protocol';

/**
 * Encode a Uint8Array to base64 string
 * @param buffer - The buffer to encode
 * @param variant - The encoding variant ('base64' or 'base64url')
 */
export function encodeBase64(buffer: Uint8Array, variant: Base64Variant = 'base64'): string {
  return encodeBase64Protocol(buffer, variant);
}

/**
 * Encode a Uint8Array to base64url string (URL-safe base64)
 * Base64URL uses '-' instead of '+', '_' instead of '/', and removes padding
 */
export function encodeBase64Url(buffer: Uint8Array): string {
  return encodeBase64Protocol(buffer, 'base64url');
}

/**
 * Decode a base64 string to a Uint8Array
 * @param base64 - The base64 string to decode
 * @param variant - The encoding variant ('base64' or 'base64url')
 * @returns The decoded Uint8Array
 */
export function decodeBase64(base64: string, variant: Base64Variant = 'base64'): Uint8Array {
  return decodeBase64Protocol(base64, variant);
}



/**
 * Generate secure random bytes
 */
export function getRandomBytes(size: number): Uint8Array {
  return new Uint8Array(randomBytes(size))
}

export function libsodiumPublicKeyFromSecretKey(seed: Uint8Array): Uint8Array {
  return deriveBoxPublicKeyFromSeed(seed);
}

export function libsodiumEncryptForPublicKey(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  return sealBoxBundle({
    plaintext: data,
    recipientPublicKey,
    randomBytes: getRandomBytes,
  });
}

export function libsodiumDecryptForSecretKey(
  encryptedBundle: Uint8Array,
  recipientSecretKeyOrSeed: Uint8Array
): Uint8Array | null {
  return openBoxBundle({
    bundle: encryptedBundle,
    recipientSecretKeyOrSeed,
  });
}

/**
 * Encrypt data using the secret key
 * @param data - The data to encrypt
 * @param secret - The secret key to use for encryption
 * @returns The encrypted data
 */
function encryptLegacyWithNonce(data: any, secret: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (nonce.length !== tweetnacl.secretbox.nonceLength) {
    throw new Error(`Legacy encryption nonce must be ${tweetnacl.secretbox.nonceLength} bytes`);
  }
  const encrypted = tweetnacl.secretbox(new TextEncoder().encode(stringifySerializedJsonValue(data)), nonce, secret);
  const result = new Uint8Array(nonce.length + encrypted.length);
  result.set(nonce);
  result.set(encrypted, nonce.length);
  return result;
}

export function encryptLegacy(data: any, secret: Uint8Array): Uint8Array {
  return encryptLegacyWithNonce(data, secret, getRandomBytes(tweetnacl.secretbox.nonceLength));
}

export type DecryptionResult =
  | Readonly<{ status: 'authenticated'; value: unknown }>
  | Readonly<{ status: 'authentication_failed' | 'unsupported' | 'invalid_payload' }>;

function parseAuthenticatedContent(decrypted: Uint8Array): DecryptionResult {
  try {
    return { status: 'authenticated', value: parseSerializedJsonValue(new TextDecoder().decode(decrypted)) };
  } catch {
    return { status: 'invalid_payload' };
  }
}

/**
 * Decrypt data using the secret key
 * @param data - The data to decrypt
 * @param secret - The secret key to use for decryption
 * @returns The decrypted data
 */
export function decryptLegacy(data: Uint8Array, secret: Uint8Array): any | null {
  const result = decryptLegacyResult(data, secret);
  return result.status === 'authenticated' ? result.value : null;
}

export function decryptLegacyResult(data: Uint8Array, secret: Uint8Array): DecryptionResult {
  if (data.length < tweetnacl.secretbox.nonceLength + tweetnacl.secretbox.overheadLength
    || secret.length !== tweetnacl.secretbox.keyLength) {
    return { status: 'unsupported' };
  }
  const nonce = data.slice(0, tweetnacl.secretbox.nonceLength);
  const encrypted = data.slice(tweetnacl.secretbox.nonceLength);
  const decrypted = tweetnacl.secretbox.open(encrypted, nonce, secret);
  if (!decrypted) {
    return { status: 'authentication_failed' };
  }
  return parseAuthenticatedContent(decrypted);
}

/**
 * Encrypt data using AES-256-GCM with the data encryption key
 * @param data - The data to encrypt
 * @param dataKey - The 32-byte AES-256 key
 * @returns The encrypted data bundle (nonce + ciphertext + auth tag)
 */
function encryptWithDataKeyAndNonce(data: any, dataKey: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (nonce.length !== SESSION_DATA_KEY_NONCE_BYTES) {
    throw new Error('Data-key encryption nonce must be 12 bytes');
  }
  const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);

  const plaintext = new TextEncoder().encode(serializeSessionDataKeyValue(data));
  const encrypted = Buffer.concat([
    cipher.update(plaintext),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return packSessionDataKeyBundleV0({ nonce, ciphertext: encrypted, authTag });
}

export function encryptWithDataKey(data: any, dataKey: Uint8Array): Uint8Array {
  return encryptWithDataKeyAndNonce(data, dataKey, getRandomBytes(SESSION_DATA_KEY_NONCE_BYTES));
}

/**
 * Encrypts with a keyed, content-bound nonce derived by the caller. Never pass
 * an unkeyed or reusable nonce through this narrow idempotent-retry boundary.
 */
export function encryptWithDerivedNonce(
  key: Uint8Array,
  variant: 'legacy' | 'dataKey',
  data: any,
  nonce: Uint8Array,
): Uint8Array {
  return variant === 'legacy'
    ? encryptLegacyWithNonce(data, key, nonce)
    : encryptWithDataKeyAndNonce(data, key, nonce);
}

/**
 * Decrypt data using AES-256-GCM with the data encryption key
 * @param bundle - The encrypted data bundle
 * @param dataKey - The 32-byte AES-256 key
 * @returns The decrypted data or null if decryption fails
 */
export function decryptWithDataKey(bundle: Uint8Array, dataKey: Uint8Array): any | null {
  const result = decryptWithDataKeyResult(bundle, dataKey);
  return result.status === 'authenticated' ? result.value : null;
}

export function decryptWithDataKeyResult(bundle: Uint8Array, dataKey: Uint8Array): DecryptionResult {
  const parts = readSessionDataKeyBundleV0(bundle);
  if (parts.status !== 'ready' || dataKey.length !== SESSION_DATA_KEY_BYTES) {
    return { status: 'unsupported' };
  }
  let decrypted: Uint8Array;
  try {
    const decipher = createDecipheriv('aes-256-gcm', dataKey, parts.nonce);
    decipher.setAuthTag(parts.authTag);

    decrypted = Buffer.concat([
      decipher.update(parts.ciphertext),
      decipher.final()
    ]);

  } catch {
    return { status: 'authentication_failed' };
  }
  return parseSessionDataKeyValue(new TextDecoder().decode(decrypted));
}

export function encrypt(
  key: Uint8Array,
  variant: 'legacy' | 'dataKey',
  data: any,
): Uint8Array {
  if (variant === 'legacy') {
    return encryptLegacy(data, key);
  } else {
    return encryptWithDataKey(data, key);
  }
}

export function decrypt(key: Uint8Array, variant: 'legacy' | 'dataKey', data: Uint8Array): any | null {
  const result = decryptResult(key, variant, data);
  return result.status === 'authenticated' ? result.value : null;
}

export function decryptResult(key: Uint8Array, variant: 'legacy' | 'dataKey', data: Uint8Array): DecryptionResult {
  return variant === 'legacy' ? decryptLegacyResult(data, key) : decryptWithDataKeyResult(data, key);
}

/**
 * Generate authentication challenge response
 */
export function authChallenge(secret: Uint8Array): {
  challenge: Uint8Array
  publicKey: Uint8Array
  signature: Uint8Array
} {
  const keypair = tweetnacl.sign.keyPair.fromSeed(secret);
  const challenge = getRandomBytes(32);
  const signature = tweetnacl.sign.detached(challenge, keypair.secretKey);

  return {
    challenge,
    publicKey: keypair.publicKey,
    signature
  };
}

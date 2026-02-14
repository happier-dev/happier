import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import {
  decodeBase64 as decodeBase64Protocol,
  encodeBase64 as encodeBase64Protocol,
  deriveBoxPublicKeyFromSeed,
  openBoxBundle,
  sealBoxBundle,
  type Base64Variant,
} from '@happier-dev/protocol';

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
export function encryptLegacy(data: any, secret: Uint8Array): Uint8Array {
  const nonce = getRandomBytes(tweetnacl.secretbox.nonceLength);
  const encrypted = tweetnacl.secretbox(new TextEncoder().encode(JSON.stringify(data)), nonce, secret);
  const result = new Uint8Array(nonce.length + encrypted.length);
  result.set(nonce);
  result.set(encrypted, nonce.length);
  return result;
}

/**
 * Decrypt data using the secret key
 * @param data - The data to decrypt
 * @param secret - The secret key to use for decryption
 * @returns The decrypted data
 */
export function decryptLegacy(data: Uint8Array, secret: Uint8Array): any | null {
  const nonce = data.slice(0, tweetnacl.secretbox.nonceLength);
  const encrypted = data.slice(tweetnacl.secretbox.nonceLength);
  const decrypted = tweetnacl.secretbox.open(encrypted, nonce, secret);
  if (!decrypted) {
    // Decryption failed - returning null is sufficient for error handling
    // Callers should handle the null case appropriately
    return null;
  }
  return JSON.parse(new TextDecoder().decode(decrypted));
}

/**
 * Encrypt data using AES-256-GCM with the data encryption key
 * @param data - The data to encrypt
 * @param dataKey - The 32-byte AES-256 key
 * @returns The encrypted data bundle (nonce + ciphertext + auth tag)
 */
export function encryptWithDataKey(data: any, dataKey: Uint8Array): Uint8Array {
  const nonce = getRandomBytes(12); // GCM uses 12-byte nonces
  const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);

  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const encrypted = Buffer.concat([
    cipher.update(plaintext),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  // Bundle: version(1) + nonce (12) + ciphertext + auth tag (16)
  const bundle = new Uint8Array(12 + encrypted.length + 16 + 1);
  bundle.set([0], 0);
  bundle.set(nonce, 1);
  bundle.set(new Uint8Array(encrypted), 13);
  bundle.set(new Uint8Array(authTag), 13 + encrypted.length);

  return bundle;
}

/**
 * Decrypt data using AES-256-GCM with the data encryption key
 * @param bundle - The encrypted data bundle
 * @param dataKey - The 32-byte AES-256 key
 * @returns The decrypted data or null if decryption fails
 */
export function decryptWithDataKey(bundle: Uint8Array, dataKey: Uint8Array): any | null {
  if (bundle.length < 1) {
    return null;
  }
  if (bundle[0] !== 0) { // Only verision 0
    return null;
  }
  if (bundle.length < 12 + 16 + 1) { // Minimum: version nonce + auth tag
    return null;
  }


  const nonce = bundle.slice(1, 13);
  const authTag = bundle.slice(bundle.length - 16);
  const ciphertext = bundle.slice(13, bundle.length - 16);

  try {
    const decipher = createDecipheriv('aes-256-gcm', dataKey, nonce);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch (error) {
    // Decryption failed
    return null;
  }
}

export function encrypt(key: Uint8Array, variant: 'legacy' | 'dataKey', data: any): Uint8Array {
  if (variant === 'legacy') {
    return encryptLegacy(data, key);
  } else {
    return encryptWithDataKey(data, key);
  }
}

export function decrypt(key: Uint8Array, variant: 'legacy' | 'dataKey', data: Uint8Array): any | null {
  if (variant === 'legacy') {
    return decryptLegacy(data, key);
  } else {
    return decryptWithDataKey(data, key);
  }
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

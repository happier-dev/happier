import { createCipheriv, createDecipheriv } from 'node:crypto';

const AES_256_KEY_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_AUTH_TAG_BYTES = 16;

function validate(input: Readonly<{ key: Uint8Array; nonce: Uint8Array }>): void {
  if (input.key.byteLength !== AES_256_KEY_BYTES || input.nonce.byteLength !== AES_GCM_NONCE_BYTES) {
    throw new Error('aes_256_gcm_invalid_parameters');
  }
}

export function sealAes256GcmBytes(input: Readonly<{
  key: Uint8Array;
  nonce: Uint8Array;
  aad: Uint8Array;
  plaintext: Uint8Array;
}>): Uint8Array {
  validate(input);
  const cipher = createCipheriv('aes-256-gcm', input.key, input.nonce);
  cipher.setAAD(input.aad);
  return new Uint8Array(Buffer.concat([cipher.update(input.plaintext), cipher.final(), cipher.getAuthTag()]));
}

export function openAes256GcmBytes(input: Readonly<{
  key: Uint8Array;
  nonce: Uint8Array;
  aad: Uint8Array;
  ciphertext: Uint8Array;
}>): Uint8Array {
  validate(input);
  if (input.ciphertext.byteLength < AES_GCM_AUTH_TAG_BYTES) {
    throw new Error('aes_256_gcm_authentication_failed');
  }
  const authTagOffset = input.ciphertext.byteLength - AES_GCM_AUTH_TAG_BYTES;
  try {
    const decipher = createDecipheriv('aes-256-gcm', input.key, input.nonce);
    decipher.setAAD(input.aad);
    decipher.setAuthTag(input.ciphertext.subarray(authTagOffset));
    return new Uint8Array(Buffer.concat([
      decipher.update(input.ciphertext.subarray(0, authTagOffset)),
      decipher.final(),
    ]));
  } catch {
    throw new Error('aes_256_gcm_authentication_failed');
  }
}

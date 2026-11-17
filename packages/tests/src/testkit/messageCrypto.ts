import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { randomBytes } from 'node:crypto';
import { decryptLegacy } from '../../../../apps/cli/src/api/encryption';

export function encodeBase64(bytes: Uint8Array): string {
  return privacyKit.encodeBase64(Uint8Array.from(bytes));
}

export function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(privacyKit.decodeBase64(value));
}

export function encryptLegacyBase64(data: unknown, secret: Uint8Array): string {
  const nonce = Uint8Array.from(randomBytes(tweetnacl.secretbox.nonceLength));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const encrypted = tweetnacl.secretbox(plaintext, nonce, secret);
  const bundle = new Uint8Array(nonce.length + encrypted.length);
  bundle.set(nonce, 0);
  bundle.set(encrypted, nonce.length);
  return encodeBase64(bundle);
}

export function decryptLegacyBase64(ciphertextBase64: string, secret: Uint8Array): unknown | null {
  return decryptLegacy(decodeBase64(ciphertextBase64), secret);
}

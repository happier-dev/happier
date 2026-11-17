import { createCipheriv, randomBytes } from 'node:crypto';
import { decryptWithDataKey } from '../../../../apps/cli/src/api/encryption';

function encodeUtf8Json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

// Compatible with the CLI `encryptWithDataKey` bundle:
// [version=0][nonce(12)][ciphertext...][authTag(16)]
export function encryptDataKey(value: unknown, dataKey: Uint8Array): Uint8Array {
  if (!(dataKey instanceof Uint8Array) || dataKey.length !== 32) {
    throw new Error(`dataKey must be 32 bytes (got ${dataKey?.length ?? 'unknown'})`);
  }
  const nonce = Uint8Array.from(randomBytes(12));
  const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
  const plaintext = encodeUtf8Json(value);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const out = new Uint8Array(1 + nonce.length + encrypted.length + authTag.length);
  out[0] = 0;
  out.set(nonce, 1);
  out.set(new Uint8Array(encrypted), 1 + nonce.length);
  out.set(new Uint8Array(authTag), 1 + nonce.length + encrypted.length);
  return out;
}

export function decryptDataKey(bundle: Uint8Array, dataKey: Uint8Array): any | null {
  if (!(dataKey instanceof Uint8Array) || dataKey.length !== 32) return null;
  if (!(bundle instanceof Uint8Array)) return null;
  return decryptWithDataKey(bundle, dataKey);
}

export function encryptDataKeyBase64(value: unknown, dataKey: Uint8Array): string {
  return Buffer.from(encryptDataKey(value, dataKey)).toString('base64');
}

export function decryptDataKeyBase64(base64: string, dataKey: Uint8Array): any | null {
  if (typeof base64 !== 'string' || base64.length === 0) return null;
  try {
    return decryptDataKey(new Uint8Array(Buffer.from(base64, 'base64')), dataKey);
  } catch {
    return null;
  }
}


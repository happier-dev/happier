const UTF8 = new TextEncoder();

function stableArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function lengthPrefixedUtf8(parts: readonly string[]): Uint8Array {
  const encoded = parts.map((part) => UTF8.encode(part));
  const total = encoded.reduce((size, part) => size + 4 + part.byteLength, 0);
  const result = new Uint8Array(total);
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const part of encoded) {
    view.setUint32(offset, part.byteLength, false);
    offset += 4;
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/** Encodes opaque private row material without base64 padding. */
export function encodeUnpaddedBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

/** Decodes a base64url candidate without applying any domain-specific validation. */
export function tryDecodeBase64Url(value: string): Uint8Array | null {
  const base64 = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`;
  try {
    return Uint8Array.from(globalThis.atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Imports an already validated private row-identity key for HMAC-SHA256 signing. */
export async function importHmacSha256Key(
  subtle: SubtleCrypto,
  keyBytes: Uint8Array,
): Promise<CryptoKey> {
  return await subtle.importKey(
    'raw',
    stableArrayBuffer(keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** Signs four-byte big-endian length-prefixed UTF-8 parts as a full base64url HMAC. */
export async function signLengthPrefixedUtf8HmacSha256Base64Url(input: Readonly<{
  subtle: SubtleCrypto;
  key: CryptoKey;
  parts: readonly string[];
}>): Promise<string> {
  const signature = await input.subtle.sign(
    'HMAC',
    input.key,
    stableArrayBuffer(lengthPrefixedUtf8(input.parts)),
  );
  return encodeUnpaddedBase64Url(new Uint8Array(signature));
}

import { decodeBase64, encodeBase64 } from '../../../crypto/base64.js';

const UNPADDED_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function encodeCanonicalBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes, 'base64url');
}

export function decodeCanonicalBase64UrlFixedLength(
  value: string,
  expectedDecodedLength: number,
): Uint8Array | null {
  if (!Number.isInteger(expectedDecodedLength) || expectedDecodedLength < 1) return null;
  const expectedEncodedLength = Math.ceil((expectedDecodedLength * 8) / 6);
  if (value.length !== expectedEncodedLength || !UNPADDED_BASE64URL_PATTERN.test(value)) return null;
  try {
    const decoded = decodeBase64(value, 'base64url');
    if (decoded.length !== expectedDecodedLength) return null;
    return encodeCanonicalBase64Url(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

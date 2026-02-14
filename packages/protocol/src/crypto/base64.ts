import { fromByteArray, toByteArray } from 'base64-js';

export type Base64Variant = 'base64' | 'base64url';

function normalizeBase64ForDecoding(input: string, variant: Base64Variant): string {
  let normalized = input.replace(/\s+/g, '');
  if (variant === 'base64url') {
    normalized = normalized.replace(/-/g, '+').replace(/_/g, '/');
  }

  // Keep only canonical base64 alphabet characters. This matches the permissive
  // behavior of Node's Buffer base64 decoder, and prevents `base64-js` from
  // throwing on incidental whitespace or accidental invalid characters.
  normalized = normalized.replace(/[^A-Za-z0-9+/]/g, '');

  // base64 strings with length % 4 === 1 are not decodable; truncate the final
  // character to avoid throwing and align with Node's lenient decoder.
  if (normalized.length % 4 === 1) {
    normalized = normalized.slice(0, -1);
  }

  const padding = normalized.length % 4;
  if (padding) {
    normalized += '='.repeat(4 - padding);
  }
  return normalized;
}

export function encodeBase64(bytes: Uint8Array, variant: Base64Variant = 'base64'): string {
  const base64 = fromByteArray(bytes);
  if (variant === 'base64url') {
    return base64
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }
  return base64;
}

export function decodeBase64(base64: string, variant: Base64Variant = 'base64'): Uint8Array {
  const normalized = normalizeBase64ForDecoding(base64, variant);
  return toByteArray(normalized);
}

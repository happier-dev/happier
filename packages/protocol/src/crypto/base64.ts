import { fromByteArray, toByteArray } from 'base64-js';

export type Base64Variant = 'base64' | 'base64url';

const LARGE_CANONICAL_BASE64_FAST_PATH_MIN_CHARS = 1024;
const CANONICAL_PADDED_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isLargeCanonicalPaddedBase64(input: string): boolean {
  return input.length >= LARGE_CANONICAL_BASE64_FAST_PATH_MIN_CHARS
    && input.length % 4 === 0
    && CANONICAL_PADDED_BASE64_PATTERN.test(input);
}

function isCanonicalPaddedBase64(input: string): boolean {
  if (input.length % 4 !== 0) return false;
  let paddingStart = input.length;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    const isAlphabet =
      (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if (isAlphabet) {
      if (paddingStart !== input.length) return false;
      continue;
    }
    if (code !== 61) return false;
    if (paddingStart === input.length) {
      paddingStart = index;
    }
    if (index < input.length - 2) return false;
  }
  return true;
}

function normalizeBase64ForDecoding(input: string, variant: Base64Variant): string {
  if (variant === 'base64') {
    if (isLargeCanonicalPaddedBase64(input)) {
      return input;
    }
    if (isCanonicalPaddedBase64(input)) {
      return input;
    }
  }

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

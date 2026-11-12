import { fromByteArray, toByteArray } from 'base64-js';

// Optional Node global; browser programs deliberately have no Node ambient types.
declare const Buffer: {
  from(buffer: ArrayBufferLike, byteOffset: number, length: number): { toString(encoding: 'base64'): string };
  from(input: string, encoding: 'base64'): Uint8Array;
} | undefined;

export type Base64Variant = 'base64' | 'base64url';

const INVALID_BASE64_CHARACTER = /[^A-Za-z0-9+/]/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Structural padded-base64 grammar; unused pad bits need not be zero. */
export function readPaddedBase64DecodedLength(input: string): number | null {
  if (input.length % 4 !== 0) return null;
  const paddingLength = input.endsWith('==') ? 2 : input.endsWith('=') ? 1 : 0;
  const paddingStart = input.length - paddingLength;
  // One native alphabet scan avoids per-character JS work and ciphertext copies.
  // The first non-alphabet character must be exactly the terminal padding start.
  const invalidIndex = INVALID_BASE64_CHARACTER.exec(input)?.index ?? input.length;
  if (invalidIndex !== paddingStart) return null;
  return (input.length / 4) * 3 - paddingLength;
}

export function readCanonicalPaddedBase64DecodedLength(input: string): number | null {
  const length = readPaddedBase64DecodedLength(input);
  if (length === null) return null;
  const paddingLength = input.endsWith('==') ? 2 : input.endsWith('=') ? 1 : 0;
  const paddingStart = input.length - paddingLength;
  // Padded encodings have unused low bits in their last alphabet character.
  // Reject alternate spellings of the same bytes at the canonical boundary.
  if (paddingLength > 0) {
    const last = BASE64_ALPHABET.indexOf(input[paddingStart - 1]);
    if (paddingStart === 0 || (last & (paddingLength === 2 ? 15 : 3)) !== 0) return null;
  }
  return length;
}

function normalizeBase64ForDecoding(input: string, variant: Base64Variant): string {
  if (variant === 'base64') {
    if (readCanonicalPaddedBase64DecodedLength(input) !== null) {
      return input;
    }
  }

  let normalized = input.replace(/\s+/g, '');
  if (variant === 'base64url') {
    normalized = normalized.replace(/-/g, '+').replace(/_/g, '/');
  }

  // Preserve the existing permissive policy, including removing embedded '='
  // before decoding. Native decoders differ on malformed raw input.
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
  // Preserve the view's offset/length without copying its backing storage.
  const base64 = typeof Buffer !== 'undefined'
    ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
    : fromByteArray(bytes);
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
  const nativeBytes = Uint8Array as typeof Uint8Array & {
    fromBase64?: (input: string) => Uint8Array;
  };
  if (typeof nativeBytes.fromBase64 === 'function') return nativeBytes.fromBase64(normalized);
  // Copy out of Buffer's pool: callers receive plain, independently owned bytes,
  // preserving Uint8Array.slice and avoiding exposure of unrelated backing bytes.
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(normalized, 'base64'));
  return toByteArray(normalized);
}

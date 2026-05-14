export type DecodeSessionMediaBase64Result =
  | Readonly<{ success: true; bytes: Buffer }>
  | Readonly<{ success: false; code: 'invalid_base64' | 'media_too_large'; error: string }>;

export type DecodeSessionMediaBase64PrefixResult =
  | Readonly<{ success: true; bytes: Buffer }>
  | Readonly<{ success: false; code: 'invalid_base64'; error: string }>;

function normalizeSessionMediaBase64(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/u.test(trimmed)) return null;

  const hasStandardAlphabet = /[+/]/u.test(trimmed);
  const hasUrlSafeAlphabet = /[-_]/u.test(trimmed);
  if (hasStandardAlphabet && hasUrlSafeAlphabet) return null;

  const alphabetPattern = hasUrlSafeAlphabet
    ? /^[A-Za-z0-9_-]+={0,2}$/u
    : /^[A-Za-z0-9+/]+={0,2}$/u;
  if (!alphabetPattern.test(trimmed)) return null;
  if (/=.+[^=]/u.test(trimmed)) return null;

  const unpadded = trimmed.replace(/=+$/u, '');
  if (unpadded.length === 0 || unpadded.length % 4 === 1) return null;

  return unpadded
    .replace(/-/gu, '+')
    .replace(/_/gu, '/')
    .padEnd(Math.ceil(unpadded.length / 4) * 4, '=');
}

function decodedBase64ByteLength(normalizedBase64: string): number {
  const padding = normalizedBase64.endsWith('==') ? 2 : normalizedBase64.endsWith('=') ? 1 : 0;
  return (normalizedBase64.length / 4) * 3 - padding;
}

export function decodeSessionMediaBase64(
  value: string,
  maxBytes: number,
): DecodeSessionMediaBase64Result {
  const normalized = normalizeSessionMediaBase64(value);
  if (!normalized) {
    return { success: false, code: 'invalid_base64', error: 'Media source base64 data is invalid' };
  }
  if (decodedBase64ByteLength(normalized) > maxBytes) {
    return { success: false, code: 'media_too_large', error: 'Media exceeds the configured size limit' };
  }

  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.byteLength === 0) {
    return { success: false, code: 'invalid_base64', error: 'Media source base64 data is invalid' };
  }

  const canonical = bytes.toString('base64').replace(/=+$/u, '');
  if (canonical !== normalized.replace(/=+$/u, '')) {
    return { success: false, code: 'invalid_base64', error: 'Media source base64 data is invalid' };
  }
  if (bytes.byteLength > maxBytes) {
    return { success: false, code: 'media_too_large', error: 'Media exceeds the configured size limit' };
  }

  return { success: true, bytes };
}

export function decodeSessionMediaBase64Prefix(
  value: string,
  maxPrefixBytes: number,
): DecodeSessionMediaBase64PrefixResult {
  const normalized = normalizeSessionMediaBase64(value);
  if (!normalized) {
    return { success: false, code: 'invalid_base64', error: 'Media source base64 data is invalid' };
  }

  const chunkChars = Math.max(4, Math.ceil(maxPrefixBytes / 3) * 4);
  const prefix = normalized.slice(0, Math.min(normalized.length, chunkChars));
  const paddedPrefix = prefix.padEnd(Math.ceil(prefix.length / 4) * 4, '=');
  const bytes = Buffer.from(paddedPrefix, 'base64').subarray(0, maxPrefixBytes);
  return bytes.byteLength > 0
    ? { success: true, bytes }
    : { success: false, code: 'invalid_base64', error: 'Media source base64 data is invalid' };
}

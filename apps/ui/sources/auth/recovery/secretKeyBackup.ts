import { encodeBase64 } from '@/encryption/base64';

import {
  formatRecoveryKey,
  isValidRecoveryKey,
  normalizeRecoveryKey,
  parseRecoveryKey,
} from '@happier-dev/protocol/auth/recoveryKey';

function invalidSecretKeyError(result: ReturnType<typeof parseRecoveryKey>): Error {
  if (result.ok) return new Error('Invalid secret key format');
  if (result.reason === 'invalid_length') {
    return new Error(`Invalid key length: expected 32 bytes, got ${result.byteLength}`);
  }
  return new Error('No valid characters found');
}

/**
 * Formats a secret key for display in a user-friendly format similar to 1Password
 * Format: XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
 * Uses base32 encoding without padding for better readability
 * @param secretKey - Base64url encoded 32-byte secret key
 * @returns Formatted string like "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
 */
/**
 * The display form of a recovery secret held as base64url text or raw bytes, grouped exactly as the
 * backup disclosure shows it. The one owner of how a recovery key reads on screen and on the clipboard.
 */
export function formatRecoveryKeyForDisplay(secret: string | Uint8Array): string {
  return formatSecretKeyForBackup(typeof secret === 'string' ? secret : encodeBase64(secret, 'base64url'));
}

/** The same grouping with every character masked. It needs no secret: a recovery key is 32 bytes. */
export function maskRecoveryKeyForDisplay(formatted: string = formatRecoveryKey(new Uint8Array(32))): string {
  return formatted.replace(/[A-Za-z0-9]/g, '•');
}

export function formatSecretKeyForBackup(secretKey: string): string {
  const result = parseRecoveryKey(secretKey);
  if (!result.ok) throw new Error('Invalid secret key format');
  return formatRecoveryKey(result.bytes);
}

/**
 * Parses a user-friendly formatted secret key back to base64url
 * @param formattedKey - Formatted string like "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
 * @returns Base64url encoded secret key
 */
export function parseBackupSecretKey(formattedKey: string): string {
  const result = parseRecoveryKey(formattedKey);
  if (!result.ok) throw invalidSecretKeyError(result);
  return encodeBase64(result.bytes, 'base64url');
}

/**
 * Validates if a string is a properly formatted secret key
 * @param key - The key to validate (either base64url or formatted)
 * @returns true if valid, false otherwise
 */
export function isValidSecretKey(key: string): boolean {
  return isValidRecoveryKey(key);
}

/**
 * Normalizes a secret key to base64url format
 * @param key - The key in either format
 * @returns Base64url encoded secret key
 */
export function normalizeSecretKey(key: string): string {
  return normalizeRecoveryKey(key);
}

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { z } from 'zod';

import { decodeBase64 } from '../../crypto/base64.js';

const CONTENT_PUBLIC_KEY_FINGERPRINT_PREFIX = 'content-public-key-sha256:' as const;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

export const ContentPublicKeyFingerprintSchema = lazyZodSchema(() => z.string()
  .regex(new RegExp(`^${CONTENT_PUBLIC_KEY_FINGERPRINT_PREFIX}[a-f0-9]{64}$`, 'u')));

export type ContentPublicKeyFingerprint = z.infer<typeof ContentPublicKeyFingerprintSchema>;

export function computeContentPublicKeyFingerprint(publicKey: Uint8Array | string): string {
  const bytes = typeof publicKey === 'string'
    ? decodeBase64(publicKey, 'base64url')
    : publicKey;
  const hex = bytesToHex(sha256(bytes));
  if (!SHA256_HEX_PATTERN.test(hex)) {
    throw new Error('Failed to compute content public key fingerprint');
  }
  return `${CONTENT_PUBLIC_KEY_FINGERPRINT_PREFIX}${hex}`;
}

import { createHash, randomBytes } from 'node:crypto';

export interface PkceCodes {
  verifier: string;
  challenge: string;
}

function clampPkceVerifierBytes(bytes: number): number {
  // RFC 7636 requires code_verifier length 43..128.
  // Node's base64url encoding produces ceil(n * 4/3) chars (no padding).
  // 32 bytes -> 43 chars; 96 bytes -> 128 chars.
  const n = Number.isFinite(bytes) ? Math.floor(bytes) : 32;
  return Math.min(96, Math.max(32, n));
}

/**
 * Generate PKCE codes for OAuth flows.
 *
 * - verifier: 43-128 characters, base64url-ish
 * - challenge: SHA256(verifier), base64url
 */
export function generatePkceCodes(bytes: number = 32): PkceCodes {
  const verifier = randomBytes(clampPkceVerifierBytes(bytes)).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  return { verifier, challenge };
}

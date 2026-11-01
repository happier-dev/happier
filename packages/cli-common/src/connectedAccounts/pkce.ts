import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

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
export async function generatePkceCodes(
  crypto: Readonly<{
    randomBytes: (length: number) => Uint8Array;
    sha256: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  }>,
  bytes: number = 32,
): Promise<PkceCodes> {
  const verifier = encodeBase64(crypto.randomBytes(clampPkceVerifierBytes(bytes)), 'base64url');
  const challenge = encodeBase64(await crypto.sha256(new TextEncoder().encode(verifier)), 'base64url');

  return { verifier, challenge };
}

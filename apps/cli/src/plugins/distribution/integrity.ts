import { createHash, type Hash } from 'node:crypto';

type SupportedAlgorithm = 'sha256' | 'sha384' | 'sha512';
const STRENGTH: Readonly<Record<SupportedAlgorithm, number>> = { sha256: 1, sha384: 2, sha512: 3 };

export type StreamingIntegrityVerifier = Readonly<{
  update(chunk: Uint8Array): void;
  verify(): boolean;
}>;

/** One streaming Subresource Integrity owner shared by download and archive verification. */
export function createStreamingIntegrityVerifier(integrity: string): StreamingIntegrityVerifier {
  const entries = integrity.trim().split(/\s+/).map((token) => {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(?:\?.*)?$/.exec(token);
    if (!match) return null;
    return { algorithm: match[1] as SupportedAlgorithm, digest: match[2]! };
  }).filter((entry): entry is { algorithm: SupportedAlgorithm; digest: string } => entry !== null);
  if (entries.length === 0) throw new Error('Invalid or unsupported integrity declaration');
  const strongest = Math.max(...entries.map((entry) => STRENGTH[entry.algorithm]));
  const selected = entries.filter((entry) => STRENGTH[entry.algorithm] === strongest);
  const hashes = new Map<SupportedAlgorithm, Hash>();
  for (const entry of selected) hashes.set(entry.algorithm, createHash(entry.algorithm));

  return {
    update(chunk) { for (const hash of hashes.values()) hash.update(chunk); },
    verify() {
      const actual = new Map<SupportedAlgorithm, string>();
      for (const [algorithm, hash] of hashes) actual.set(algorithm, hash.digest('base64'));
      return selected.some((entry) => actual.get(entry.algorithm) === entry.digest);
    },
  };
}

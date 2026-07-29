import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const SHA256_SRI_PATTERN = /^sha256-([A-Za-z0-9+/]{43}=)$/u;

export function normalizeArchiveSha256Integrity(value: string): string {
  const trimmed = String(value ?? '').trim();
  const match = SHA256_SRI_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error('Archive integrity must be a canonical sha256 SRI value');
  }
  const digest = Buffer.from(match[1]!, 'base64');
  if (digest.byteLength !== 32 || digest.toString('base64') !== match[1]) {
    throw new Error('Archive integrity must be a canonical sha256 SRI value');
  }
  return trimmed;
}

export function archiveSha256IntegrityFromDigest(value: string): string {
  const trimmed = String(value ?? '').trim();
  const hex = trimmed.startsWith('sha256:') ? trimmed.slice('sha256:'.length) : trimmed;
  if (!SHA256_HEX_PATTERN.test(hex)) {
    throw new Error('Archive SHA-256 digest must contain exactly 64 lowercase hexadecimal characters');
  }
  return `sha256-${Buffer.from(hex, 'hex').toString('base64')}`;
}

export async function resolveArchiveExpectedIntegrity(params: Readonly<{
  locator: string;
  explicitIntegrity?: string | null;
}>): Promise<string | undefined> {
  if (params.explicitIntegrity) {
    return normalizeArchiveSha256Integrity(params.explicitIntegrity);
  }
  try {
    new URL(params.locator);
    return undefined;
  } catch {
    // Local pack outputs own a sibling .sha256 file. Other local archives
    // retain the ordinary review-first flow when no sidecar is present.
  }

  const archivePath = resolve(params.locator);
  const digestPath = `${archivePath}.sha256`;
  let raw: string;
  try {
    raw = await readFile(digestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
    throw error;
  }
  const match = /^sha256:([a-f0-9]{64})  ([^\r\n]+)\r?\n?$/u.exec(raw);
  if (!match || match[2] !== basename(archivePath)) {
    throw new Error(`Invalid archive SHA-256 sidecar: ${digestPath}`);
  }
  return archiveSha256IntegrityFromDigest(match[1]!);
}

import type { ModelPackManifest } from '@happier-dev/protocol';

import type { InstallerFs } from './types';

export function filePathParts(path: string): string[] {
  const raw = path.trim();
  if (!raw) throw new Error('model_pack_invalid_path');
  if (raw.startsWith('/') || raw.startsWith('\\')) throw new Error('model_pack_invalid_path');
  if (raw.includes('\\')) throw new Error('model_pack_invalid_path');
  if (raw.includes('\0')) throw new Error('model_pack_invalid_path');

  const parts = raw
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error('model_pack_invalid_path');
  for (const p of parts) {
    if (p === '.' || p === '..') throw new Error('model_pack_invalid_path');
  }
  return parts;
}

const PACK_ID_FILESYSTEM_SAFE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const PACK_ID_MAX_LENGTH = 256;

export function normalizePackId(packId: string | null): string {
  const normalized = packId && packId.trim().length > 0 ? packId.trim() : 'default';
  if (
    normalized.length === 0
    || normalized.length > PACK_ID_MAX_LENGTH
    || normalized === '.'
    || normalized === '..'
    || !PACK_ID_FILESYSTEM_SAFE_RE.test(normalized)
  ) {
    throw new Error('model_pack_invalid_pack_id');
  }
  return normalized;
}

export function getPackRootDir(fs: InstallerFs, packId: string): any {
  return new fs.Directory(fs.Paths.document, 'happier', 'voice', 'modelPacks', packId);
}

export function getMetaFile(fs: InstallerFs, rootDir: any): any {
  return new fs.File(rootDir, 'pack.json');
}

export function assertManifestPathsSafe(manifest: ModelPackManifest): void {
  for (const f of manifest.files) {
    // This will throw model_pack_invalid_path on invalid paths.
    filePathParts(f.path);
  }
}

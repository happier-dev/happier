import {
  assertManifestPathsSafe as assertProtocolManifestPathsSafe,
  assertPackIdFilesystemSafe,
  filePathParts,
  type ModelPackManifest,
} from '@happier-dev/protocol';

import type { ExpoFsDirectory, ExpoFsFile, InstallerFs } from './types';

export { filePathParts };

export function normalizePackId(packId: string | null): string {
  const candidate = packId && packId.trim().length > 0 ? packId.trim() : 'default';
  return assertPackIdFilesystemSafe(candidate, () => new Error('model_pack_invalid_pack_id'));
}

const PACKS_ROOT_SEGMENTS = ['happier', 'voice', 'modelPacks'] as const;

export function getPackRootDir(fs: InstallerFs, packId: string): ExpoFsDirectory {
  return new fs.Directory(fs.Paths.document, ...PACKS_ROOT_SEGMENTS, packId);
}

/**
 * A sibling directory of the live pack used as scratch space (staging or
 * backup) during an atomic install. Keeping it a sibling — not a child of the
 * live pack — means the live pack is never touched until the swap, and a
 * `move`/`rename` into place stays on the same filesystem.
 */
export function getPackSiblingDir(fs: InstallerFs, packId: string, suffix: string): ExpoFsDirectory {
  return new fs.Directory(fs.Paths.document, ...PACKS_ROOT_SEGMENTS, `.${packId}${suffix}`);
}

/** A sibling FILE of the live pack (e.g. the durable promote-intent marker). */
export function getPackSiblingFile(fs: InstallerFs, packId: string, suffix: string): ExpoFsFile {
  return new fs.File(fs.Paths.document, ...PACKS_ROOT_SEGMENTS, `.${packId}${suffix}`);
}

export function getMetaFile(fs: InstallerFs, rootDir: ExpoFsDirectory): ExpoFsFile {
  return new fs.File(rootDir, 'pack.json');
}

export function assertManifestPathsSafe(manifest: ModelPackManifest): void {
  assertProtocolManifestPathsSafe(manifest);
}

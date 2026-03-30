import { join, resolve, sep } from 'node:path';

import type { WorkspaceManifest } from '@happier-dev/protocol';

import { createWorkspaceReplicationCasStore } from '../cas/workspaceReplicationCasStore';

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function resolveSafeWorkspaceManifestFilePath(input: Readonly<{
  sourceRootPath: string;
  relativePath: string;
}>): string {
  const normalized = normalizeRelativePath(input.relativePath);
  if (!normalized) {
    throw new Error(`unsafe manifest relativePath: ${String(input.relativePath)}`);
  }
  if (normalized.includes('\0')) {
    throw new Error(`unsafe manifest relativePath: ${String(input.relativePath)}`);
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`unsafe manifest relativePath: ${String(input.relativePath)}`);
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`unsafe manifest relativePath: ${String(input.relativePath)}`);
  }

  const filePath = resolve(join(input.sourceRootPath, segments.join('/')));
  const rootResolved = resolve(input.sourceRootPath);
  if (filePath !== rootResolved && !filePath.startsWith(rootResolved + sep)) {
    throw new Error(`unsafe manifest relativePath: ${String(input.relativePath)}`);
  }

  return filePath;
}

function buildManifestDigestToRelativePathIndex(manifest: WorkspaceManifest): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const entry of manifest.entries) {
    if (entry.kind !== 'file') continue;
    if (!index.has(entry.digest)) {
      index.set(entry.digest, entry.relativePath);
    }
  }
  return index;
}

export async function seedWorkspaceReplicationCasBlobsFromManifest(input: Readonly<{
  activeServerDir: string;
  sourceRootPath: string;
  manifest: WorkspaceManifest;
  digests: readonly string[];
}>): Promise<void> {
  const casStore = createWorkspaceReplicationCasStore({
    activeServerDir: input.activeServerDir,
  });
  const digestIndex = buildManifestDigestToRelativePathIndex(input.manifest);

  for (const digest of input.digests) {
    if (await casStore.contains(digest)) {
      continue;
    }
    const relativePath = digestIndex.get(digest);
    if (!relativePath) {
      throw new Error(`Workspace replication digest not in manifest: ${digest}`);
    }
    const sourcePath = resolveSafeWorkspaceManifestFilePath({
      sourceRootPath: input.sourceRootPath,
      relativePath,
    });
    await casStore.commitFile({
      digest,
      sourcePath,
    });
  }
}

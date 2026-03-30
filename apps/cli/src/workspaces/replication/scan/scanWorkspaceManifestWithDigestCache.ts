import type { ScmBackendRegistry } from '@/scm/registry';
import {
  scanWorkspaceManifest,
  type ScannedWorkspaceFile,
} from '@/scm/sourceController/workspaceExportPackaging/scanWorkspaceManifest';
import type { WorkspaceManifestSafeFilterPolicy } from '@/scm/sourceController/workspaceExportPackaging/workspaceManifestSafeFilterPolicy';

import {
  createWorkspaceReplicationDigestCacheStore,
  type WorkspaceReplicationDigestCache,
} from './workspaceReplicationDigestCacheStore';

function matchesCachedDigestEntry(
  file: Readonly<{
    sizeBytes: number;
    executable: boolean;
    mtimeMs: number;
    inode?: number;
    device?: number;
  }>,
  cachedEntry: WorkspaceReplicationDigestCache['entries'][string],
): boolean {
  if (
    cachedEntry.sizeBytes !== file.sizeBytes
    || cachedEntry.executable !== file.executable
    || cachedEntry.mtimeMs !== file.mtimeMs
  ) {
    return false;
  }
  if (cachedEntry.inode !== undefined && cachedEntry.inode !== file.inode) {
    return false;
  }
  if (cachedEntry.device !== undefined && cachedEntry.device !== file.device) {
    return false;
  }
  return true;
}

function toDigestCacheEntry(file: ScannedWorkspaceFile): WorkspaceReplicationDigestCache['entries'][string] {
  return {
    sizeBytes: file.sizeBytes,
    executable: file.executable,
    mtimeMs: file.mtimeMs,
    digest: file.digest,
    ...(file.inode !== undefined ? { inode: file.inode } : {}),
    ...(file.device !== undefined ? { device: file.device } : {}),
  };
}

export async function scanWorkspaceManifestWithDigestCache(params: Readonly<{
  activeServerDir: string;
  relationshipId: string;
  workspaceRoot: string;
  safeFilterPolicy?: WorkspaceManifestSafeFilterPolicy;
  scmRegistry?: ScmBackendRegistry;
  assertCanContinue?: () => void | Promise<void>;
  onFileScanned?: (file: ScannedWorkspaceFile) => void | Promise<void>;
}>) {
  const digestCacheStore = createWorkspaceReplicationDigestCacheStore({
    activeServerDir: params.activeServerDir,
  });
  const cached = await digestCacheStore.load(params.relationshipId);
  const nextEntries: WorkspaceReplicationDigestCache['entries'] = {};

  const manifest = await scanWorkspaceManifest({
    workspaceRoot: params.workspaceRoot,
    safeFilterPolicy: params.safeFilterPolicy,
    scmRegistry: params.scmRegistry,
    assertCanContinue: params.assertCanContinue,
    resolveCachedFileDigest(file) {
      const cachedEntry = cached?.entries[file.relativePath];
      if (!cachedEntry || !matchesCachedDigestEntry(file, cachedEntry)) {
        return null;
      }
      return cachedEntry.digest;
    },
    async onFileScanned(file) {
      nextEntries[file.relativePath] = toDigestCacheEntry(file);
      await params.assertCanContinue?.();
      await params.onFileScanned?.(file);
    },
  });

  await params.assertCanContinue?.();
  await digestCacheStore.save({
    relationshipId: params.relationshipId,
    entries: nextEntries,
  });

  return manifest;
}

import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readlink,
  readdir,
  realpath,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHappierTempDir, removeHappierTempDirAsync } from '../../tempDirs/createHappierTempDir.js';

async function copyScpReadyEntry(
  sourcePath: string,
  targetPath: string,
  seenRealPaths: Set<string>,
): Promise<void> {
  const sourceInfo = await lstat(sourcePath);

  if (sourceInfo.isSymbolicLink()) {
    const linkTarget = await readlink(sourcePath);
    const resolvedTarget = resolve(dirname(sourcePath), linkTarget);
    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(resolvedTarget);
    } catch {
      return;
    }
    if (seenRealPaths.has(canonicalTarget)) {
      return;
    }
    seenRealPaths.add(canonicalTarget);
    try {
      await copyScpReadyEntry(canonicalTarget, targetPath, seenRealPaths);
    } finally {
      seenRealPaths.delete(canonicalTarget);
    }
    return;
  }

  if (sourceInfo.isDirectory()) {
    // Immutable source bundles still need writable scratch directories for copying and cleanup.
    await mkdir(targetPath, { recursive: true });
    const entries = await readdir(sourcePath);
    for (const entry of entries) {
      await copyScpReadyEntry(join(sourcePath, entry), join(targetPath, entry), seenRealPaths);
    }
    return;
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
  await chmod(targetPath, sourceInfo.mode);
}

export async function createScpReadyPayloadCopy(payloadRoot: string): Promise<Readonly<{
  payloadRoot: string;
  cleanup: () => Promise<void>;
}>> {
  const stageRoot = createHappierTempDir({ purpose: 'first-party-scp' });
  const stagedPayloadRoot = join(stageRoot, basename(payloadRoot));
  await copyScpReadyEntry(payloadRoot, stagedPayloadRoot, new Set<string>());
  return {
    payloadRoot: stagedPayloadRoot,
    cleanup: async () => {
      await removeHappierTempDirAsync(stageRoot);
    },
  };
}

import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { create } from 'tar';
import { createHappierTempDir, removeHappierTempDirAsync } from '../../tempDirs/createHappierTempDir.js';

// Name materialized entries without staging their bytes. A full installed CLI
// plus its compressed archive exceeded the managed guest's temporary quota.
async function listPayloadEntries(sourcePath: string, archivePath: string, entries: string[], seen: Set<string>): Promise<void> {
  const info = await lstat(sourcePath);
  if (info.isSymbolicLink()) {
    const linkTarget = await readlink(sourcePath);
    let target: string;
    try { target = await realpath(resolve(dirname(sourcePath), linkTarget)); }
    catch { return; }
    if (seen.has(target)) return;
    seen.add(target);
    try { await listPayloadEntries(target, archivePath, entries, seen); }
    finally { seen.delete(target); }
    return;
  }
  entries.push(archivePath);
  if (info.isDirectory()) {
    for (const name of await readdir(sourcePath)) {
      await listPayloadEntries(join(sourcePath, name), join(archivePath, name), entries, seen);
    }
  }
}

export async function createScpReadyPayloadArchive(payloadRoot: string): Promise<Readonly<{
  archiveStageRoot: string;
  archiveFileName: string;
  extractedPayloadDirName: string;
  cleanup: () => Promise<void>;
}>> {
  const archiveStageRoot = createHappierTempDir({ purpose: 'first-party-scp-archive' });
  const extractedPayloadDirName = basename(payloadRoot);
  const archiveFileName = `${extractedPayloadDirName}.tar.gz`;

  try {
    const cwd = dirname(payloadRoot);
    const entries: string[] = [];
    await listPayloadEntries(payloadRoot, relative(cwd, payloadRoot), entries, new Set());
    await create({ cwd, file: join(archiveStageRoot, archiveFileName), gzip: true,
      follow: true, noDirRecurse: true, strict: true }, entries);
    return {
      archiveStageRoot,
      archiveFileName,
      extractedPayloadDirName,
      cleanup: async () => {
        await removeHappierTempDirAsync(archiveStageRoot);
      },
    };
  } catch (error) {
    await removeHappierTempDirAsync(archiveStageRoot);
    throw error;
  }
}

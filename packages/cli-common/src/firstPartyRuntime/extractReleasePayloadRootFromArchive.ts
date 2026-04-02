import { execFile } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { planArchiveExtraction } from '@happier-dev/release-runtime';

const execFileAsync = promisify(execFile);

export async function extractReleasePayloadRootFromArchive(params: Readonly<{
  archivePath: string;
  archiveName: string;
  extractDir: string;
}>): Promise<string> {
  await mkdir(params.extractDir, { recursive: true });

  const extractionPlan = planArchiveExtraction({
    archiveName: params.archiveName,
    archivePath: params.archivePath,
    destDir: params.extractDir,
    os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux',
  });

  await execFileAsync(extractionPlan.command.cmd, extractionPlan.command.args, {
    windowsHide: true,
  });

  const entries = await readdir(params.extractDir);

  if (entries.length === 1) {
    return join(params.extractDir, entries[0]!);
  }

  // Some archives include extra top-level files (e.g. release notes) alongside the
  // actual payload directory. Prefer the single directory entry when possible.
  const directories: string[] = [];
  for (const entry of entries) {
    try {
      const info = await stat(join(params.extractDir, entry));
      if (info.isDirectory()) directories.push(entry);
    } catch {
      // ignore unreadable entries
    }
  }

  if (directories.length === 1) {
    return join(params.extractDir, directories[0]!);
  }

  throw new Error(`[first-party-runtime] expected exactly one extracted payload root for ${params.archiveName}`);
}

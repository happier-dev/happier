import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir } from 'node:fs/promises';
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

  const entries = (await readdir(params.extractDir)).filter((entry) => !entry.startsWith('.'));
  if (entries.length === 1) {
    return join(params.extractDir, entries[0]!);
  }

  const entryStats = await Promise.all(
    entries.map(async (name) => ({
      name,
      stat: await lstat(join(params.extractDir, name)),
    })),
  );

  const dirEntries = entryStats.filter((entry) => entry.stat.isDirectory()).map((entry) => entry.name);
  if (dirEntries.length === 1) {
    return join(params.extractDir, dirEntries[0]!);
  }

  const archiveStem = params.archiveName.replace(/(\.tar\.gz|\.zip)$/u, '');
  if (dirEntries.includes(archiveStem)) {
    return join(params.extractDir, archiveStem);
  }

  throw new Error(
    `[first-party-runtime] expected exactly one extracted payload root for ${params.archiveName}; found: ${entries.join(', ')}`,
  );
}

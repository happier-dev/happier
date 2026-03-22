import { execFile } from 'node:child_process';
import { chmod, mkdir, readdir, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { planArchiveExtraction } from '@happier-dev/release-runtime';

const execFileAsync = promisify(execFile);

async function moveExtractedEntryIntoPlace(params: Readonly<{
  extractDir: string;
  outputPath: string;
}>): Promise<void> {
  const entries = await readdir(params.extractDir);
  if (entries.length !== 1) {
    throw new Error('[github-release] expected exactly one extracted entry');
  }
  const extractedPath = join(params.extractDir, entries[0]!);
  await mkdir(dirname(params.outputPath), { recursive: true });
  await rename(extractedPath, params.outputPath);
}

export async function extractGitHubReleaseAsset(params: Readonly<{
  archivePath: string;
  archiveName: string;
  extractDir: string;
  outputPath: string;
}>): Promise<void> {
  const archiveName = params.archiveName.toLowerCase();
  await mkdir(params.extractDir, { recursive: true });

  if (archiveName.endsWith('.tar.gz') || archiveName.endsWith('.tar.xz') || archiveName.endsWith('.zip')) {
    const extractionPlan = planArchiveExtraction({
      archiveName: params.archiveName,
      archivePath: params.archivePath,
      destDir: params.extractDir,
      os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux',
    });
    await execFileAsync(extractionPlan.command.cmd, extractionPlan.command.args, {
      windowsHide: true,
    });
    await moveExtractedEntryIntoPlace({ extractDir: params.extractDir, outputPath: params.outputPath });
    if (process.platform !== 'win32') {
      await chmod(params.outputPath, 0o755);
    }
    return;
  }

  throw new Error(`[github-release] unsupported asset archive: ${basename(params.archiveName)}`);
}

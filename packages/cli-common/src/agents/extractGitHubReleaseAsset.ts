import { chmod, mkdir, readdir, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { extractArchivePayloadToDirectory } from '../firstPartyRuntime/extractArchivePayloadToDirectory.js';

function stripArchiveExtension(archiveName: string): string {
  const normalized = archiveName.trim();
  if (normalized.endsWith('.tar.gz')) return normalized.slice(0, -'.tar.gz'.length);
  if (normalized.endsWith('.tar.xz')) return normalized.slice(0, -'.tar.xz'.length);
  if (normalized.endsWith('.zip')) return normalized.slice(0, -'.zip'.length);
  return normalized;
}

function resolveExtractedEntryName(params: Readonly<{
  archiveName: string;
  entries: readonly string[];
  outputPath: string;
}>): string | null {
  if (params.entries.length === 1) {
    return params.entries[0] ?? null;
  }

  const archiveStem = stripArchiveExtension(params.archiveName);
  const exactArchiveStem = params.entries.find((entry) => entry === archiveStem);
  if (exactArchiveStem) return exactArchiveStem;

  const outputBasename = basename(params.outputPath);
  const exactOutputBasename = params.entries.find((entry) => entry === outputBasename);
  if (exactOutputBasename) return exactOutputBasename;

  return null;
}

async function moveExtractedEntryIntoPlace(params: Readonly<{
  archiveName: string;
  extractDir: string;
  outputPath: string;
}>): Promise<void> {
  const entries = await readdir(params.extractDir);
  const selectedEntry = resolveExtractedEntryName({
    archiveName: params.archiveName,
    entries,
    outputPath: params.outputPath,
  });
  if (!selectedEntry) {
    throw new Error('[github-release] expected exactly one extracted entry');
  }
  const extractedPath = join(params.extractDir, selectedEntry);
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

  if (archiveName.endsWith('.tar.gz') || archiveName.endsWith('.tar.xz') || archiveName.endsWith('.zip')) {
    await mkdir(params.extractDir, { recursive: true });
    await extractArchivePayloadToDirectory({
      archiveName: params.archiveName,
      archivePath: params.archivePath,
      extractDir: params.extractDir,
    });
    await moveExtractedEntryIntoPlace({
      archiveName: params.archiveName,
      extractDir: params.extractDir,
      outputPath: params.outputPath,
    });
    if (process.platform !== 'win32') {
      await chmod(params.outputPath, 0o755);
    }
    return;
  }

  await mkdir(dirname(params.outputPath), { recursive: true });
  await rename(params.archivePath, params.outputPath);
  if (process.platform !== 'win32') {
    await chmod(params.outputPath, 0o755);
  }
}

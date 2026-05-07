import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, delimiter as pathDelimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { downloadGitHubReleaseAsset } from '@happier-dev/cli-common/providers';
import { resolveWindowsCommandOnPath, runCommandStreaming } from '@happier-dev/cli-common/process';
import { fetchGitHubLatestRelease } from '@happier-dev/release-runtime/github';
import { planArchiveExtraction } from '@happier-dev/release-runtime';

import { configuration } from '@/configuration';
import { readRuntimeInstallableLastCheckAtMs } from '@/installables/runtime/runtimeInstallableUpdateState';
import { GH_GITHUB_REPO, resolveGhReleaseAsset } from '@/runtime/managedTools/providers/ghRelease';

type GhState = Readonly<{
  installedVersion: string | null;
  lastInstallLogPath: string | null;
}>;

type LatestVersionCheck =
  | Readonly<{ ok: true; latestVersion: string | null; label: string | null }>
  | Readonly<{ ok: false; errorMessage: string }>;

const githubFetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;

export const ghInstallDir = () => join(configuration.happyHomeDir, 'tools', 'gh');

export const ghBinPath = () => join(
  ghInstallDir(),
  'current',
  'bin',
  process.platform === 'win32' ? 'gh.exe' : 'gh',
);

const ghStatePath = () => join(ghInstallDir(), 'install-state.json');

function isGhManagedBinRunnable(candidatePath: string): boolean {
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    accessSync(candidatePath, accessMode);
    return true;
  } catch {
    return false;
  }
}

export function resolveExistingGhManagedBinPath(): string | null {
  const candidate = ghBinPath();
  try {
    return existsSync(candidate) && isGhManagedBinRunnable(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function resolveSystemGhBinPath(processEnv: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform === 'win32') {
    return resolveWindowsCommandOnPath('gh', processEnv) ?? null;
  }

  const pathDirs = String(processEnv.PATH ?? '')
    .split(pathDelimiter)
    .map((value) => value.trim())
    .filter(Boolean);

  for (const dir of pathDirs) {
    const candidatePath = join(dir, 'gh');
    try {
      if (existsSync(candidatePath) && isGhManagedBinRunnable(candidatePath)) {
        return candidatePath;
      }
    } catch {
      // Ignore invalid PATH entries and keep searching.
    }
  }

  return null;
}

export function resolveGithubCliCommandPath(): string {
  return resolveSystemGhBinPath() ?? resolveExistingGhManagedBinPath() ?? 'gh';
}

async function readGhState(): Promise<GhState> {
  try {
    const raw = await readFile(ghStatePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      installedVersion: typeof parsed?.installedVersion === 'string' ? parsed.installedVersion : null,
      lastInstallLogPath: typeof parsed?.lastInstallLogPath === 'string' ? parsed.lastInstallLogPath : null,
    };
  } catch {
    return { installedVersion: null, lastInstallLogPath: null };
  }
}

async function writeGhState(next: GhState): Promise<void> {
  await mkdir(ghInstallDir(), { recursive: true });
  await writeFile(ghStatePath(), JSON.stringify(next, null, 2), 'utf8');
}

async function detectLatestVersionCheck(): Promise<LatestVersionCheck> {
  try {
    const release = await fetchGitHubLatestRelease({
      githubRepo: GH_GITHUB_REPO,
      userAgent: 'happier-cli',
      githubToken: process.env.GITHUB_TOKEN,
      ...(githubFetchImpl ? { fetchImpl: githubFetchImpl } : {}),
    });
    const asset = resolveGhReleaseAsset(release);
    return { ok: true, latestVersion: asset.version, label: asset.tag };
  } catch (error) {
    return {
      ok: false,
      errorMessage: error instanceof Error ? error.message : 'Failed to resolve latest GitHub CLI release',
    };
  }
}

async function writeInstallLog(params: Readonly<{
  logPath: string;
  lines: string[];
}>): Promise<void> {
  await mkdir(dirname(params.logPath), { recursive: true });
  await writeFile(params.logPath, `${params.lines.join('\n')}\n`, 'utf8');
}

async function findExtractedGhBinary(root: string): Promise<string | null> {
  const targetName = process.platform === 'win32' ? 'gh.exe' : 'gh';
  const queue = [root];
  const matches: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(path);
        continue;
      }
      if (entry.isFile() && entry.name === targetName) {
        matches.push(path);
      }
    }
  }

  return matches.find((path) => path.split(/[\\/]/).includes('bin')) ?? matches[0] ?? null;
}

async function extractArchiveIntoDirectory(params: Readonly<{
  archivePath: string;
  archiveName: string;
  extractDir: string;
}>): Promise<void> {
  await mkdir(params.extractDir, { recursive: true });
  const extractionPlan = planArchiveExtraction({
    archiveName: params.archiveName,
    archivePath: params.archivePath,
    destDir: params.extractDir,
    os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux',
  });
  await runCommandStreaming({
    cmd: extractionPlan.command.cmd,
    args: extractionPlan.command.args,
    context: 'github-cli extract',
  });
}

async function installLatestGhRelease(logPath: string): Promise<Readonly<{ version: string | null }>> {
  const release = await fetchGitHubLatestRelease({
    githubRepo: GH_GITHUB_REPO,
    userAgent: 'happier-cli',
    githubToken: process.env.GITHUB_TOKEN,
    ...(githubFetchImpl ? { fetchImpl: githubFetchImpl } : {}),
  });
  const asset = resolveGhReleaseAsset(release);
  const scratchDir = await mkdtemp(join(tmpdir(), 'happier-gh-'));
  try {
    const archivePath = join(scratchDir, basename(asset.name));
    const extractDir = join(scratchDir, 'extract');
    const nextDir = join(ghInstallDir(), 'next');
    const nextBinPath = join(nextDir, 'bin', process.platform === 'win32' ? 'gh.exe' : 'gh');

    await downloadGitHubReleaseAsset({
      url: asset.url,
      destinationPath: archivePath,
      digest: asset.digest,
      userAgent: 'happier-cli',
    });

    await rm(nextDir, { recursive: true, force: true });
    await rm(extractDir, { recursive: true, force: true });
    await extractArchiveIntoDirectory({ archivePath, archiveName: asset.name, extractDir });

    const extractedBin = await findExtractedGhBinary(extractDir);
    if (!extractedBin) {
      throw new Error('GitHub CLI release archive did not contain a gh binary.');
    }

    await mkdir(dirname(nextBinPath), { recursive: true });
    await copyFile(extractedBin, nextBinPath);
    if (process.platform !== 'win32') {
      await chmod(nextBinPath, 0o755);
    }

    await writeInstallLog({
      logPath,
      lines: [
        '# source: github_release_binary',
        `# repo: ${GH_GITHUB_REPO}`,
        `# asset: ${asset.name}`,
        `# releaseTag: ${asset.tag ?? 'unknown'}`,
        `# version: ${asset.version ?? 'unknown'}`,
      ],
    });
    await rm(join(ghInstallDir(), 'current'), { recursive: true, force: true });
    await mkdir(ghInstallDir(), { recursive: true });
    await rename(nextDir, join(ghInstallDir(), 'current'));
    return { version: asset.version };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

export async function installGh(): Promise<
  | { ok: true; logPath: string }
  | { ok: false; errorMessage: string; logPath: string }
> {
  const logPath = join(configuration.logsDir, `install-dep-gh-${Date.now()}.log`);
  try {
    const installed = await installLatestGhRelease(logPath);
    await writeGhState({
      installedVersion: installed.version,
      lastInstallLogPath: logPath,
    });
    return { ok: true, logPath };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Install failed';
    try {
      await writeInstallLog({ logPath, lines: [errorMessage] });
      await writeGhState({
        installedVersion: (await readGhState()).installedVersion,
        lastInstallLogPath: logPath,
      });
    } catch {
    }
    return { ok: false, errorMessage, logPath };
  }
}

export type GhDepData = Readonly<{
  installed: boolean;
  installDir: string;
  binPath: string | null;
  installedVersion: string | null;
  sourceKind: 'github_release_binary';
  lastInstallLogPath: string | null;
  lastBackgroundUpdateCheckAtMs: number | null;
  latestVersionCheck?: LatestVersionCheck;
}>;

export async function getGhDepStatus(opts?: {
  includeLatestVersion?: boolean;
  onlyIfInstalled?: boolean;
}): Promise<GhDepData> {
  const installDir = ghInstallDir();
  const state = await readGhState();
  const resolvedBinPath = resolveSystemGhBinPath() ?? resolveExistingGhManagedBinPath();
  const includeLatestVersion = opts?.includeLatestVersion === true;
  const onlyIfInstalled = opts?.onlyIfInstalled === true;
  const latestVersionCheck = includeLatestVersion && (!onlyIfInstalled || resolvedBinPath !== null)
    ? await detectLatestVersionCheck()
    : undefined;
  const lastBackgroundUpdateCheckAtMs = await readRuntimeInstallableLastCheckAtMs('gh');

  return {
    installed: resolvedBinPath !== null,
    installDir,
    binPath: resolvedBinPath,
    installedVersion: state.installedVersion,
    sourceKind: 'github_release_binary',
    lastInstallLogPath: state.lastInstallLogPath,
    lastBackgroundUpdateCheckAtMs,
    ...(latestVersionCheck ? { latestVersionCheck } : {}),
  };
}

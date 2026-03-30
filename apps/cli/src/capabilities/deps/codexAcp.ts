import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { configuration } from '@/configuration';
import { resolveExistingManagedJavaScriptRuntimeCommand } from '@/runtime/js/managedJavaScriptRuntime';
import { readRuntimeInstallableLastCheckAtMs } from '@/installables/runtime/runtimeInstallableUpdateState';
import { downloadGitHubReleaseAsset, extractGitHubReleaseAsset } from '@happier-dev/cli-common/providers';
import { fetchGitHubLatestRelease } from '@happier-dev/release-runtime/github';

import { resolveCodexAcpReleaseAsset, CODEX_ACP_GITHUB_REPO } from '@/runtime/managedTools/providers/codexAcpRelease';

type CodexAcpState = Readonly<{
  installedVersion: string | null;
  lastInstallLogPath: string | null;
}>;

type LatestVersionCheck =
  | Readonly<{ ok: true; latestVersion: string | null; label: string | null }>
  | Readonly<{ ok: false; errorMessage: string }>;

const githubFetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;

export const codexAcpInstallDir = () => join(configuration.happyHomeDir, 'tools', 'codex-acp');

export const codexAcpBinPath = () => {
  const binaryName = process.platform === 'win32' ? 'codex-acp.exe' : 'codex-acp';
  return join(codexAcpInstallDir(), 'current', 'bin', binaryName);
};

export const codexAcpLegacyBinPaths = () => {
  if (process.platform === 'win32') {
    return [
      join(codexAcpInstallDir(), 'node_modules', '.bin', 'codex-acp.cmd'),
      join(codexAcpInstallDir(), 'node_modules', '.bin', 'codex-acp.exe'),
      join(codexAcpInstallDir(), 'node_modules', '.bin', 'codex-acp'),
    ] as const;
  }

  return [join(codexAcpInstallDir(), 'node_modules', '.bin', 'codex-acp')] as const;
};

function hasJavaScriptRuntimeForLegacyCodexAcpShim(processEnv: NodeJS.ProcessEnv): boolean {
  return Boolean(resolveExistingManagedJavaScriptRuntimeCommand(processEnv));
}

function isLegacyCodexAcpShimRunnable(candidatePath: string, processEnv: NodeJS.ProcessEnv): boolean {
  const legacyPaths = codexAcpLegacyBinPaths();
  if (!legacyPaths.includes(candidatePath as (typeof legacyPaths)[number])) return true;

  return hasJavaScriptRuntimeForLegacyCodexAcpShim(processEnv);
}

function isCodexAcpManagedBinRunnable(candidatePath: string, processEnv: NodeJS.ProcessEnv): boolean {
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    accessSync(candidatePath, accessMode);
  } catch {
    return false;
  }

  return isLegacyCodexAcpShimRunnable(candidatePath, processEnv);
}

export function resolveExistingCodexAcpManagedBinPath(processEnv: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [codexAcpBinPath(), ...codexAcpLegacyBinPaths()];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && isCodexAcpManagedBinRunnable(candidate, processEnv)) return candidate;
    } catch {
      // ignore invalid paths and continue scanning the compatibility list
    }
  }
  return null;
}

const codexAcpStatePath = () => join(codexAcpInstallDir(), 'install-state.json');

async function readCodexAcpState(): Promise<CodexAcpState> {
  try {
    const raw = await readFile(codexAcpStatePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      installedVersion: typeof parsed?.installedVersion === 'string' ? parsed.installedVersion : null,
      lastInstallLogPath: typeof parsed?.lastInstallLogPath === 'string' ? parsed.lastInstallLogPath : null,
    };
  } catch {
    return { installedVersion: null, lastInstallLogPath: null };
  }
}

async function writeCodexAcpState(next: CodexAcpState): Promise<void> {
  await mkdir(codexAcpInstallDir(), { recursive: true });
  await writeFile(codexAcpStatePath(), JSON.stringify(next, null, 2), 'utf8');
}

async function detectLatestVersionCheck(): Promise<LatestVersionCheck> {
  try {
    const release = await fetchGitHubLatestRelease({
      githubRepo: CODEX_ACP_GITHUB_REPO,
      userAgent: 'happier-cli',
      githubToken: process.env.GITHUB_TOKEN,
      ...(githubFetchImpl ? { fetchImpl: githubFetchImpl } : {}),
    });
    const asset = resolveCodexAcpReleaseAsset(release);
    return { ok: true, latestVersion: asset.version, label: asset.tag };
  } catch (error) {
    return {
      ok: false,
      errorMessage: error instanceof Error ? error.message : 'Failed to resolve latest codex-acp release',
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

async function installLatestCodexAcpRelease(logPath: string): Promise<Readonly<{
  version: string | null;
}>> {
  const release = await fetchGitHubLatestRelease({
    githubRepo: CODEX_ACP_GITHUB_REPO,
    userAgent: 'happier-cli',
    githubToken: process.env.GITHUB_TOKEN,
    ...(githubFetchImpl ? { fetchImpl: githubFetchImpl } : {}),
  });
  const asset = resolveCodexAcpReleaseAsset(release);

  const scratchDir = await mkdtemp(join(tmpdir(), 'happier-codex-acp-'));
  try {
    const archivePath = join(scratchDir, basename(asset.name));
    const extractDir = join(scratchDir, 'extract');
    const nextDir = join(codexAcpInstallDir(), 'next');
    const nextBinPath = join(nextDir, 'bin', process.platform === 'win32' ? 'codex-acp.exe' : 'codex-acp');

    await downloadGitHubReleaseAsset({
      url: asset.url,
      destinationPath: archivePath,
      digest: asset.digest,
      userAgent: 'happier-cli',
    });

    await rm(nextDir, { recursive: true, force: true });
    await mkdir(dirname(nextBinPath), { recursive: true });
    await extractGitHubReleaseAsset({
      archivePath,
      archiveName: asset.name,
      extractDir,
      outputPath: nextBinPath,
    });

    await writeInstallLog({
      logPath,
      lines: [
        `# source: github_release_binary`,
        `# repo: ${CODEX_ACP_GITHUB_REPO}`,
        `# asset: ${asset.name}`,
        `# releaseTag: ${asset.tag ?? 'unknown'}`,
        `# version: ${asset.version ?? 'unknown'}`,
      ],
    });
    await rm(join(codexAcpInstallDir(), 'current'), { recursive: true, force: true });
    await rm(join(codexAcpInstallDir(), 'node_modules'), { recursive: true, force: true });
    await rm(join(codexAcpInstallDir(), 'package.json'), { force: true });
    await rm(join(codexAcpInstallDir(), 'package-lock.json'), { force: true });
    await mkdir(codexAcpInstallDir(), { recursive: true });
    await rename(nextDir, join(codexAcpInstallDir(), 'current'));
    return { version: asset.version };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

export async function installCodexAcp(): Promise<
  | { ok: true; logPath: string }
  | { ok: false; errorMessage: string; logPath: string }
> {
  const logPath = join(configuration.logsDir, `install-dep-codex-acp-${Date.now()}.log`);
  try {
    const installed = await installLatestCodexAcpRelease(logPath);
    await writeCodexAcpState({
      installedVersion: installed.version,
      lastInstallLogPath: logPath,
    });
    return { ok: true, logPath };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Install failed';
    try {
      await writeInstallLog({
        logPath,
        lines: [errorMessage],
      });
      await writeCodexAcpState({
        installedVersion: (await readCodexAcpState()).installedVersion,
        lastInstallLogPath: logPath,
      });
    } catch {
    }
    return { ok: false, errorMessage, logPath };
  }
}

export type CodexAcpDepData = Readonly<{
  installed: boolean;
  installDir: string;
  binPath: string | null;
  installedVersion: string | null;
  sourceKind: 'github_release_binary';
  lastInstallLogPath: string | null;
  lastBackgroundUpdateCheckAtMs: number | null;
  latestVersionCheck?: LatestVersionCheck;
}>;

export async function getCodexAcpDepStatus(opts?: {
  includeLatestVersion?: boolean;
  onlyIfInstalled?: boolean;
}): Promise<CodexAcpDepData> {
  const installDir = codexAcpInstallDir();
  const state = await readCodexAcpState();
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  const candidatePaths = [codexAcpBinPath(), ...codexAcpLegacyBinPaths()];
  let resolvedBinPath: string | null = null;
  for (const candidatePath of candidatePaths) {
    const installed = await access(candidatePath, accessMode).then(() => true).catch(() => false);
    if (!installed) continue;
    if (!isCodexAcpManagedBinRunnable(candidatePath, process.env)) continue;
    resolvedBinPath = candidatePath;
    break;
  }
  const includeLatestVersion = opts?.includeLatestVersion === true;
  const onlyIfInstalled = opts?.onlyIfInstalled === true;
  const latestVersionCheck = includeLatestVersion && (!onlyIfInstalled || resolvedBinPath !== null)
    ? await detectLatestVersionCheck()
    : undefined;
  const lastBackgroundUpdateCheckAtMs = await readRuntimeInstallableLastCheckAtMs('codex-acp');

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

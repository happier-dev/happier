import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration } from '../../configuration';
import { resolveExistingManagedJavaScriptRuntimeCommand } from '@/packagedRuntime/js/managedJavaScriptRuntime';
import { readRuntimeInstallableLastCheckAtMs } from '@/packagedRuntime/installables/updateState';
import { fetchGitHubLatestRelease } from '@/capabilities/cliUpdate/githubReleaseLookup';
import { resolveManagedToolsRoot, selectManagedDependencyReleaseAsset } from '@happier-dev/cli-common/agents';
import { readRuntimeInstallableDescriptor } from '@/packagedRuntime/installables/descriptors';
import type { InstallableDependencyDescriptor } from '@happier-dev/protocol';

type CodexAcpState = Readonly<{
  installedVersion: string | null;
  lastInstallLogPath: string | null;
}>;

type LatestVersionCheck =
  | Readonly<{ ok: true; latestVersion: string | null; label: string | null }>
  | Readonly<{ ok: false; errorMessage: string }>;

const githubFetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined;

export const codexAcpInstallDir = (env?: NodeJS.ProcessEnv) => join(resolveManagedToolsRoot(env ?? { ...process.env, HAPPIER_HOME_DIR: configuration.happyHomeDir }), 'codex-acp');

export const codexAcpBinPath = (env?: NodeJS.ProcessEnv) => {
  const binaryName = process.platform === 'win32' ? 'codex-acp.exe' : 'codex-acp';
  return join(codexAcpInstallDir(env), 'current', 'bin', binaryName);
};

export const codexAcpLegacyBinPaths = (env?: NodeJS.ProcessEnv) => {
  if (process.platform === 'win32') {
    return [
      join(codexAcpInstallDir(env), 'node_modules', '.bin', 'codex-acp.cmd'),
      join(codexAcpInstallDir(env), 'node_modules', '.bin', 'codex-acp.exe'),
      join(codexAcpInstallDir(env), 'node_modules', '.bin', 'codex-acp'),
    ] as const;
  }

  return [join(codexAcpInstallDir(env), 'node_modules', '.bin', 'codex-acp')] as const;
};

function hasJavaScriptRuntimeForLegacyCodexAcpShim(processEnv: NodeJS.ProcessEnv): boolean {
  return Boolean(resolveExistingManagedJavaScriptRuntimeCommand(processEnv));
}

function isLegacyCodexAcpShimRunnable(candidatePath: string, processEnv?: NodeJS.ProcessEnv): boolean {
  const legacyPaths = codexAcpLegacyBinPaths(processEnv);
  if (!legacyPaths.includes(candidatePath as (typeof legacyPaths)[number])) return true;

  return hasJavaScriptRuntimeForLegacyCodexAcpShim(processEnv ?? process.env);
}

function isCodexAcpManagedBinRunnable(candidatePath: string, processEnv?: NodeJS.ProcessEnv): boolean {
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    accessSync(candidatePath, accessMode);
  } catch {
    return false;
  }

  return isLegacyCodexAcpShimRunnable(candidatePath, processEnv);
}

export function resolveExistingCodexAcpManagedBinPath(processEnv?: NodeJS.ProcessEnv): string | null {
  const candidates = [codexAcpBinPath(processEnv), ...codexAcpLegacyBinPaths(processEnv)];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && isCodexAcpManagedBinRunnable(candidate, processEnv)) return candidate;
    } catch {
      // ignore invalid paths and continue scanning the compatibility list
    }
  }
  return null;
}

const codexAcpStatePath = (env?: NodeJS.ProcessEnv) => join(codexAcpInstallDir(env), 'install-state.json');

async function readCodexAcpState(env?: NodeJS.ProcessEnv): Promise<CodexAcpState> {
  try {
    const raw = await readFile(codexAcpStatePath(env), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      installedVersion: typeof parsed?.installedVersion === 'string' ? parsed.installedVersion : null,
      lastInstallLogPath: typeof parsed?.lastInstallLogPath === 'string' ? parsed.lastInstallLogPath : null,
    };
  } catch {
    return { installedVersion: null, lastInstallLogPath: null };
  }
}

async function detectLatestVersionCheck(env?: NodeJS.ProcessEnv, descriptor?: InstallableDependencyDescriptor): Promise<LatestVersionCheck> {
  try {
    const source = (descriptor ?? readRuntimeInstallableDescriptor('codex-acp'))?.source;
    if (source?.kind !== 'github_release_binary' || !source.assetNamePrefix || !source.targetByPlatform) {
      throw new Error('Codex ACP release declaration is unavailable');
    }
    const release = await fetchGitHubLatestRelease({
      githubRepo: source.repo,
      userAgent: 'happier-cli',
      githubToken: (env ?? process.env).GITHUB_TOKEN,
      ...(githubFetchImpl ? { fetchImpl: githubFetchImpl } : {}),
    });
    const asset = selectManagedDependencyReleaseAsset(release, {
      assetNamePrefix: source.assetNamePrefix,
      targetByPlatform: source.targetByPlatform,
    });
    return { ok: true, latestVersion: asset.version, label: asset.tag };
  } catch (error) {
    return {
      ok: false,
      errorMessage: error instanceof Error ? error.message : 'Failed to resolve latest codex-acp release',
    };
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
  env?: NodeJS.ProcessEnv;
  includeLatestVersion?: boolean;
  onlyIfInstalled?: boolean;
  descriptor?: InstallableDependencyDescriptor;
}): Promise<CodexAcpDepData> {
  const installDir = codexAcpInstallDir(opts?.env);
  const state = await readCodexAcpState(opts?.env);
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  const candidatePaths = [codexAcpBinPath(opts?.env), ...codexAcpLegacyBinPaths(opts?.env)];
  let resolvedBinPath: string | null = null;
  for (const candidatePath of candidatePaths) {
    const installed = await access(candidatePath, accessMode).then(() => true).catch(() => false);
    if (!installed) continue;
    if (!isCodexAcpManagedBinRunnable(candidatePath, opts?.env)) continue;
    resolvedBinPath = candidatePath;
    break;
  }
  const includeLatestVersion = opts?.includeLatestVersion === true;
  const onlyIfInstalled = opts?.onlyIfInstalled === true;
  const latestVersionCheck = includeLatestVersion && (!onlyIfInstalled || resolvedBinPath !== null)
    ? await detectLatestVersionCheck(opts?.env, opts?.descriptor)
    : undefined;
  const lastBackgroundUpdateCheckAtMs = await readRuntimeInstallableLastCheckAtMs('codex-acp', opts?.env);

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

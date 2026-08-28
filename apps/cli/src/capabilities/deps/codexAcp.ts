import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration } from '../../configuration';
import { resolveExistingManagedJavaScriptRuntimeCommand } from '@/packagedRuntime/js/managedJavaScriptRuntime';
import { readRuntimeInstallableLastCheckAtMs } from '@/packagedRuntime/installables/updateState';
import { fetchGitHubLatestRelease } from '@happier-dev/release-runtime/github';

import {
  resolveCodexAcpReleaseAsset,
  CODEX_ACP_GITHUB_REPO,
} from '@happier-dev/plugins-codex/agent/installables/codexAcp';

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

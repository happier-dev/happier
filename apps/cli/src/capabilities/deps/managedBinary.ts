import { accessSync, constants as fsConstants } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration } from '../../configuration';
import { resolveExistingManagedJavaScriptRuntimeCommand } from '@/packagedRuntime/js/managedJavaScriptRuntime';
import { readRuntimeInstallableLastCheckAtMs } from '@/packagedRuntime/installables/updateState';
import { fetchGitHubLatestRelease } from '@/capabilities/cliUpdate/githubReleaseLookup';
import { resolveManagedToolsRoot, selectManagedDependencyReleaseAsset } from '@happier-dev/cli-common/agents';
import type { InstallableDependencyDescriptor } from '@happier-dev/protocol';
import { sessionWorkingDirectory } from '@/agent/runtime/lifecycle/hostedSessionScope';

type ManagedBinaryState = Readonly<{
  installedVersion: string | null;
  lastInstallLogPath: string | null;
}>;

type LatestVersionCheck =
  | Readonly<{ ok: true; latestVersion: string | null; label: string | null }>
  | Readonly<{ ok: false; errorMessage: string }>;

const githubFetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined;

export const managedBinaryInstallDir = (descriptor: InstallableDependencyDescriptor, env?: NodeJS.ProcessEnv) =>
  join(resolveManagedToolsRoot(env ?? { ...process.env, HAPPIER_HOME_DIR: configuration.happyHomeDir }), descriptor.key);

export function managedBinaryBinPath(descriptor: InstallableDependencyDescriptor, env?: NodeJS.ProcessEnv): string {
  const command = descriptor.binary.commands[0];
  if (!command) throw new Error(`Installable "${descriptor.key}" has no binary command`);
  const binaryName = process.platform === 'win32' && !command.endsWith('.exe') ? `${command}.exe` : command;
  return join(managedBinaryInstallDir(descriptor, env), 'current', 'bin', binaryName);
}

/** Only the selected contribution declares historical install paths and prerequisites. */
export function resolveExistingManagedBinaryPath(descriptor: InstallableDependencyDescriptor, env?: NodeJS.ProcessEnv, cwd: string = sessionWorkingDirectory()): string | null {
  const launch = descriptor.source.kind === 'github_release_binary' ? descriptor.source.launch : undefined;
  const candidates = [
    { path: managedBinaryBinPath(descriptor, env), requiresManagedJavaScriptRuntime: false },
    ...(launch?.legacyExecutables ?? [])
      .filter(candidate => !candidate.platforms || candidate.platforms.includes(process.platform))
      .map(candidate => ({
        path: join(managedBinaryInstallDir(descriptor, env), candidate.relativePath),
        requiresManagedJavaScriptRuntime: candidate.requiresManagedJavaScriptRuntime === true,
      })),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate.path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      if (candidate.requiresManagedJavaScriptRuntime && !resolveExistingManagedJavaScriptRuntimeCommand(env ?? process.env, cwd)) continue;
      return candidate.path;
    } catch {
      // Continue through the selected dependency's declared compatibility candidates.
    }
  }
  return null;
}

function managedBinaryStatePath(descriptor: InstallableDependencyDescriptor, env?: NodeJS.ProcessEnv): string {
  return join(managedBinaryInstallDir(descriptor, env), 'install-state.json');
}

export async function writeManagedBinaryState(
  descriptor: InstallableDependencyDescriptor,
  state: ManagedBinaryState,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await mkdir(managedBinaryInstallDir(descriptor, env), { recursive: true });
  await writeFile(managedBinaryStatePath(descriptor, env), JSON.stringify(state, null, 2), 'utf8');
}

export async function readManagedBinaryState(descriptor: InstallableDependencyDescriptor, env?: NodeJS.ProcessEnv): Promise<ManagedBinaryState> {
  try {
    const raw = await readFile(managedBinaryStatePath(descriptor, env), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const state: Record<string, unknown> = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    return {
      installedVersion: typeof state.installedVersion === 'string' ? state.installedVersion : null,
      lastInstallLogPath: typeof state.lastInstallLogPath === 'string' ? state.lastInstallLogPath : null,
    };
  } catch {
    return { installedVersion: null, lastInstallLogPath: null };
  }
}

async function detectLatestVersionCheck(descriptor: InstallableDependencyDescriptor, env?: NodeJS.ProcessEnv): Promise<LatestVersionCheck> {
  try {
    const source = descriptor.source;
    if (source.kind !== 'github_release_binary') {
      throw new Error(`${descriptor.display.name} release declaration is unavailable`);
    }
    const release = await fetchGitHubLatestRelease({
      githubRepo: source.repo,
      userAgent: 'happier-cli',
      githubToken: (env ?? process.env).GITHUB_TOKEN,
      ...(githubFetchImpl ? { fetchImpl: githubFetchImpl } : {}),
    });
    const asset = selectManagedDependencyReleaseAsset(release, source.assetNamePrefix && source.targetByPlatform ? {
      assetNamePrefix: source.assetNamePrefix,
      targetByPlatform: source.targetByPlatform,
    } : undefined);
    return { ok: true, latestVersion: asset.version, label: asset.tag };
  } catch (error) {
    return {
      ok: false,
      errorMessage: error instanceof Error ? error.message : `Failed to resolve latest ${descriptor.display.name} release`,
    };
  }
}

export type ManagedBinaryDepData = Readonly<{
  installed: boolean;
  installDir: string;
  binPath: string | null;
  installedVersion: string | null;
  sourceKind: 'github_release_binary';
  lastInstallLogPath: string | null;
  lastBackgroundUpdateCheckAtMs: number | null;
  latestVersionCheck?: LatestVersionCheck;
}>;

export async function getManagedBinaryDepStatus(descriptor: InstallableDependencyDescriptor, opts?: {
  env?: NodeJS.ProcessEnv;
  includeLatestVersion?: boolean;
  onlyIfInstalled?: boolean;
}): Promise<ManagedBinaryDepData> {
  const cwd = sessionWorkingDirectory();
  const installDir = managedBinaryInstallDir(descriptor, opts?.env);
  const state = await readManagedBinaryState(descriptor, opts?.env);
  const binPath = resolveExistingManagedBinaryPath(descriptor, opts?.env, cwd);
  const latestVersionCheck = opts?.includeLatestVersion === true && (opts.onlyIfInstalled !== true || binPath !== null)
    ? await detectLatestVersionCheck(descriptor, opts?.env)
    : undefined;
  const lastBackgroundUpdateCheckAtMs = await readRuntimeInstallableLastCheckAtMs(descriptor.key, opts?.env);
  return {
    installed: binPath !== null, installDir, binPath,
    installedVersion: state.installedVersion, sourceKind: 'github_release_binary',
    lastInstallLogPath: state.lastInstallLogPath, lastBackgroundUpdateCheckAtMs,
    ...(latestVersionCheck ? { latestVersionCheck } : {}),
  };
}

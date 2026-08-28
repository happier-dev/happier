import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, delimiter as PATH_DELIMITER } from 'node:path';

import {
  GH_BINARY_NAME,
  GH_DEP_ID,
  GH_GITHUB_REPO,
  GH_RUNTIME_INSTALLABLE_POLICY,
  INSTALLABLE_KEYS,
} from '@happier-dev/protocol/installables';
import { resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';
import { fetchGitHubLatestRelease } from '@happier-dev/release-runtime/github';

import { configuration } from '@/configuration';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import { readRuntimeInstallableLastCheckAtMs } from '@/packagedRuntime/installables/updateState';

type GhState = Readonly<{
  installedVersion: string | null;
  lastInstallLogPath: string | null;
}>;

type GhCommandResult = Readonly<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}>;

type LatestVersionCheck =
  | Readonly<{ ok: true; latestVersion: string | null; label: string | null }>
  | Readonly<{ ok: false; errorMessage: string }>;

type GhStatusDeps = Readonly<{
  resolveSystemGhBinPath: (env?: NodeJS.ProcessEnv) => Promise<string | null>;
  resolveManagedGhBinPath: (env?: NodeJS.ProcessEnv) => Promise<string | null>;
  runGhCommand: (params: Readonly<{ binPath: string; args: readonly string[]; timeoutMs?: number }>) => Promise<GhCommandResult>;
  readState: () => Promise<GhState>;
  readLastBackgroundUpdateCheckAtMs: () => Promise<number | null>;
}>;

const githubFetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;

export type GhDepData = Readonly<{
  installed: boolean;
  capabilityId: typeof GH_DEP_ID;
  installDir: string;
  binPath: string | null;
  managedBinPath: string | null;
  installedVersion: string | null;
  sourceKind: 'github_release_binary';
  resolvedSource: 'system' | 'managed' | null;
  authenticated: boolean | null;
  authStatus: 'authenticated' | 'missing_auth' | 'unknown';
  remediationReason: 'install_required' | 'auth_required' | 'unsupported' | null;
  lastInstallLogPath: string | null;
  lastBackgroundUpdateCheckAtMs: number | null;
  latestVersionCheck?: LatestVersionCheck;
}>;

export const ghInstallDir = () => join(configuration.happyHomeDir, 'tools', INSTALLABLE_KEYS.GH);

export const ghBinPath = () => {
  const binaryName = process.platform === 'win32' ? 'gh.exe' : GH_BINARY_NAME;
  return join(ghInstallDir(), 'current', 'bin', binaryName);
};

const ghStatePath = () => join(ghInstallDir(), 'install-state.json');

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

function parseVersionFromGhOutput(stdout: string): string | null {
  const match = /\bgh version\s+([0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?)/i.exec(stdout);
  return match?.[1] ?? null;
}

function isGhManagedInstallSupported(): boolean {
  return GH_RUNTIME_INSTALLABLE_POLICY.isRuntimeSupported({
    platform: process.platform,
    arch: process.arch,
  });
}

async function resolveCommandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const pathRaw = typeof env.PATH === 'string' ? env.PATH.trim() : '';
  if (!pathRaw) return null;

  if (process.platform === 'win32') {
    return resolveWindowsCommandOnPath(command, env);
  }

  const segments = pathRaw
    .split(PATH_DELIMITER)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const dir of segments) {
    const candidate = join(dir, command);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

async function resolveSystemGhBinPath(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return resolveCommandOnPath(GH_BINARY_NAME, env);
}

async function resolveManagedGhBinPath(): Promise<string | null> {
  const candidate = ghBinPath();
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    await access(candidate, accessMode);
    return candidate;
  } catch {
    return null;
  }
}

async function runGhCommand(params: Readonly<{ binPath: string; args: readonly string[]; timeoutMs?: number }>): Promise<GhCommandResult> {
  return runCliCommandBestEffort({
    resolvedPath: params.binPath,
    args: [...params.args],
    timeoutMs: params.timeoutMs ?? 2_000,
  });
}

async function detectLatestVersionCheck(): Promise<LatestVersionCheck> {
  try {
    const release = await fetchGitHubLatestRelease({
      githubRepo: GH_GITHUB_REPO,
      userAgent: 'happier-cli',
      githubToken: process.env.GITHUB_TOKEN,
      ...(githubFetchImpl ? { fetchImpl: githubFetchImpl } : {}),
    });
    const asset = GH_RUNTIME_INSTALLABLE_POLICY.selectReleaseAsset(release, {
      platform: process.platform,
      arch: process.arch,
    });
    return { ok: true, latestVersion: asset.version, label: asset.tag };
  } catch (error) {
    return {
      ok: false,
      errorMessage: error instanceof Error ? error.message : 'Failed to resolve latest gh release',
    };
  }
}

async function probeGh(params: Readonly<{
  binPath: string;
  source: 'system' | 'managed';
  deps: GhStatusDeps;
}>): Promise<Pick<GhDepData, 'binPath' | 'resolvedSource' | 'installedVersion' | 'authenticated' | 'authStatus' | 'remediationReason'>> {
  const versionResult = await params.deps.runGhCommand({ binPath: params.binPath, args: ['--version'] });
  const authResult = await params.deps.runGhCommand({
    binPath: params.binPath,
    args: ['auth', 'status', '--hostname', 'github.com'],
  });
  // `gh auth status` answers only when it exits. A probe the deadline killed — or one that never
  // launched — comes back `ok: false` with `exitCode: null`; reporting that as "signed out" is the
  // "sign in with gh CLI" instruction shown to an already-authenticated host.
  const authStatus: GhDepData['authStatus'] = authResult.ok
    ? 'authenticated'
    : typeof authResult.exitCode === 'number' ? 'missing_auth' : 'unknown';

  return {
    binPath: params.binPath,
    resolvedSource: params.source,
    installedVersion: parseVersionFromGhOutput(versionResult.stdout),
    authenticated: authStatus === 'unknown' ? null : authStatus === 'authenticated',
    authStatus,
    remediationReason: authStatus === 'missing_auth' ? 'auth_required' : null,
  };
}

export async function getGhDepStatus(
  opts: Readonly<{ includeLatestVersion?: boolean; onlyIfInstalled?: boolean }> = {},
  depsOverrides: Partial<GhStatusDeps> = {},
): Promise<GhDepData> {
  const deps: GhStatusDeps = {
    resolveSystemGhBinPath: depsOverrides.resolveSystemGhBinPath ?? resolveSystemGhBinPath,
    resolveManagedGhBinPath: depsOverrides.resolveManagedGhBinPath ?? resolveManagedGhBinPath,
    runGhCommand: depsOverrides.runGhCommand ?? runGhCommand,
    readState: depsOverrides.readState ?? readGhState,
    readLastBackgroundUpdateCheckAtMs:
      depsOverrides.readLastBackgroundUpdateCheckAtMs
      ?? (() => readRuntimeInstallableLastCheckAtMs(INSTALLABLE_KEYS.GH)),
  };

  const [state, systemBinPath, managedBinPath, lastBackgroundUpdateCheckAtMs] = await Promise.all([
    deps.readState(),
    deps.resolveSystemGhBinPath(process.env),
    deps.resolveManagedGhBinPath(process.env),
    deps.readLastBackgroundUpdateCheckAtMs(),
  ]);

  const systemProbe = systemBinPath
    ? await probeGh({ binPath: systemBinPath, source: 'system', deps })
    : null;
  const managedProbe = managedBinPath
    ? await probeGh({ binPath: managedBinPath, source: 'managed', deps })
    : null;
  const selected = systemProbe?.authenticated === true
    ? systemProbe
    : managedProbe?.authenticated === true
      ? managedProbe
      : systemProbe ?? managedProbe ?? null;
  const installed = selected !== null;
  const managedInstallSupported = isGhManagedInstallSupported();
  const includeLatestVersion = opts.includeLatestVersion === true;
  const onlyIfInstalled = opts.onlyIfInstalled === true;
  const latestVersionCheck = includeLatestVersion && (!onlyIfInstalled || installed)
    ? await detectLatestVersionCheck()
    : undefined;

  return {
    installed,
    capabilityId: GH_DEP_ID,
    installDir: ghInstallDir(),
    binPath: selected?.binPath ?? null,
    managedBinPath,
    installedVersion: selected?.installedVersion ?? state.installedVersion,
    sourceKind: 'github_release_binary',
    resolvedSource: selected?.resolvedSource ?? null,
    authenticated: selected?.authenticated ?? null,
    authStatus: selected?.authStatus ?? 'unknown',
    // `??` here would collapse two different facts: a probe that decided nothing is needed
    // (`null`) and no probe at all. Only the second means "install gh".
    remediationReason: selected
      ? selected.remediationReason
      : (managedInstallSupported ? 'install_required' : 'unsupported'),
    lastInstallLogPath: state.lastInstallLogPath,
    lastBackgroundUpdateCheckAtMs,
    ...(latestVersionCheck ? { latestVersionCheck } : {}),
  };
}

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GH_DEP_ID, GH_GITHUB_REPO, GH_RUNTIME_INSTALLABLE_POLICY } from '@happier-dev/protocol/installables/definitions/gh';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol/installables/codexAcp';
import { fetchGitHubLatestRelease } from '@/capabilities/cliUpdate/githubReleaseLookup';
import {
  ghInstallDir as sharedGhInstallDir, ghBinPath as sharedGhBinPath,
  resolveGhSelection, resolveSystemGhBinPath,
  resolveManagedGhBinPath as resolveSharedManagedGhBinPath, runGhCommand,
  resolveGhNativeToken as resolveSharedGhNativeToken,
  type GhCommandDeps,
} from '@happier-dev/cli-common/agents';
import { configuration } from '@/configuration';
import { readRuntimeInstallableLastCheckAtMs } from '@/packagedRuntime/installables/updateState';

export type { GhNativeTokenResult } from '@happier-dev/cli-common/agents';

export function resolveGhNativeToken(
  opts: Parameters<typeof resolveSharedGhNativeToken>[0] = {},
  depsOverrides: Partial<GhStatusDeps> = {},
) {
  return resolveSharedGhNativeToken({
    ...opts,
    env: opts.env ?? { ...process.env, HAPPIER_HOME_DIR: configuration.happyHomeDir },
  }, depsOverrides);
}

const resolveManagedGhBinPath = (env?: NodeJS.ProcessEnv) => resolveSharedManagedGhBinPath(
  env ?? { ...process.env, HAPPIER_HOME_DIR: configuration.happyHomeDir },
);

type GhState = Readonly<{
  installedVersion: string | null;
  lastInstallLogPath: string | null;
}>;

type LatestVersionCheck =
  | Readonly<{ ok: true; latestVersion: string | null; label: string | null }>
  | Readonly<{ ok: false; errorMessage: string }>;

type GhStatusDeps = GhCommandDeps & Readonly<{
  readState: (env?: NodeJS.ProcessEnv) => Promise<GhState>;
  readLastBackgroundUpdateCheckAtMs: () => Promise<number | null>;
}>;

const githubFetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined;

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

export const ghInstallDir = (env?: NodeJS.ProcessEnv) => sharedGhInstallDir(
  env ?? { ...process.env, HAPPIER_HOME_DIR: configuration.happyHomeDir },
);

export const ghBinPath = (env?: NodeJS.ProcessEnv) => sharedGhBinPath(
  env ?? { ...process.env, HAPPIER_HOME_DIR: configuration.happyHomeDir },
);

const ghStatePath = (env?: NodeJS.ProcessEnv) => join(ghInstallDir(env), 'install-state.json');

async function readGhState(env?: NodeJS.ProcessEnv): Promise<GhState> {
  try {
    const raw = await readFile(ghStatePath(env), 'utf8');
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

async function detectLatestVersionCheck(env?: NodeJS.ProcessEnv): Promise<LatestVersionCheck> {
  try {
    const release = await fetchGitHubLatestRelease({
      githubRepo: GH_GITHUB_REPO,
      userAgent: 'happier-cli',
      githubToken: (env ?? process.env).GITHUB_TOKEN,
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

async function readGhLocalStatus(params: Readonly<{
  binPath: string;
  source: 'system' | 'managed';
  deps: GhStatusDeps;
  env?: NodeJS.ProcessEnv;
  hostname?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}>): Promise<Pick<GhDepData, 'binPath' | 'resolvedSource' | 'installedVersion' | 'authenticated' | 'authStatus' | 'remediationReason'>> {
  params.signal?.throwIfAborted();
  const commandOptions = {
    binPath: params.binPath,
    ...(params.env ? { env: params.env } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  };
  const versionResult = await params.deps.runGhCommand({ ...commandOptions, args: ['--version'] });
  const authResult = await params.deps.runGhCommand({
    ...commandOptions,
    args: ['auth', 'token', '--hostname', params.hostname ?? 'github.com'],
  });
  params.signal?.throwIfAborted();
  // Detection reads local credentials only. Network validation belongs to the requested GitHub action.
  // A deadline or launch failure is unknown, rather than evidence that the user signed out.
  const authStatus: GhDepData['authStatus'] = authResult.ok
    ? (authResult.stdout.trim() ? 'authenticated' : 'missing_auth')
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

function createGhStatusDeps(env: NodeJS.ProcessEnv | undefined, depsOverrides: Partial<GhStatusDeps>): GhStatusDeps {
  return {
    resolveSystemGhBinPath: depsOverrides.resolveSystemGhBinPath ?? resolveSystemGhBinPath,
    resolveManagedGhBinPath: depsOverrides.resolveManagedGhBinPath ?? resolveManagedGhBinPath,
    runGhCommand: depsOverrides.runGhCommand ?? runGhCommand,
    readState: depsOverrides.readState ?? readGhState,
    readLastBackgroundUpdateCheckAtMs:
      depsOverrides.readLastBackgroundUpdateCheckAtMs
      ?? (() => readRuntimeInstallableLastCheckAtMs(INSTALLABLE_KEYS.GH, env)),
  };
}

export async function getGhDepStatus(
  opts: Readonly<{ includeLatestVersion?: boolean; onlyIfInstalled?: boolean; env?: NodeJS.ProcessEnv; hostname?: string; signal?: AbortSignal }> = {},
  depsOverrides: Partial<GhStatusDeps> = {},
): Promise<GhDepData> {
  const deps = createGhStatusDeps(opts.env, depsOverrides);
  const [state, { selected, managedBinPath }, lastBackgroundUpdateCheckAtMs] = await Promise.all([
    deps.readState(opts.env),
    resolveGhSelection({
      ...opts,
      deps,
      probe: (binPath, source) => readGhLocalStatus({ ...opts, deps, binPath, source, timeoutMs: 2_000 }),
      isUsable: (result) => result.authenticated === true,
    }),
    deps.readLastBackgroundUpdateCheckAtMs(),
  ]);
  const installed = selected !== null;
  const managedInstallSupported = isGhManagedInstallSupported();
  const includeLatestVersion = opts.includeLatestVersion === true;
  const onlyIfInstalled = opts.onlyIfInstalled === true;
  const latestVersionCheck = includeLatestVersion && (!onlyIfInstalled || installed)
    ? await detectLatestVersionCheck(opts.env)
    : undefined;

  return {
    installed,
    capabilityId: GH_DEP_ID,
    installDir: ghInstallDir(opts.env),
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

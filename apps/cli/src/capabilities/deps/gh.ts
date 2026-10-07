import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, delimiter as PATH_DELIMITER } from 'node:path';

import { GH_BINARY_NAME, GH_DEP_ID, GH_GITHUB_REPO, GH_RUNTIME_INSTALLABLE_POLICY } from '@happier-dev/protocol/installables/definitions/gh';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol/installables/codexAcp';
import { execFileWithDeadline, resolveWindowsCommandInvocation, resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';
import { fetchGitHubLatestRelease } from '@happier-dev/release-runtime/github';
import { resolveHappyHomeDirFromEnvironment } from '@happier-dev/cli-common/agents';

import { configuration } from '@/configuration';
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

type GhCommandParams = Readonly<{
  binPath: string;
  args: readonly string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}>;

type GhStatusDeps = Readonly<{
  resolveSystemGhBinPath: (env?: NodeJS.ProcessEnv) => Promise<string | null>;
  resolveManagedGhBinPath: (env?: NodeJS.ProcessEnv) => Promise<string | null>;
  runGhCommand: (params: GhCommandParams) => Promise<GhCommandResult>;
  readState: (env?: NodeJS.ProcessEnv) => Promise<GhState>;
  readLastBackgroundUpdateCheckAtMs: () => Promise<number | null>;
}>;

export type GhNativeTokenResult =
  | Readonly<{ ok: true; token: string }>
  | Readonly<{ ok: false; reason: 'unavailable'; remediation: 'sign in with gh CLI' }>;

export async function resolveGhNativeToken(
  opts: Readonly<{ hostname?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }> = {},
  depsOverrides: Partial<GhStatusDeps> = {},
): Promise<GhNativeTokenResult> {
  const unavailable = { ok: false, reason: 'unavailable', remediation: 'sign in with gh CLI' } as const;
  opts.signal?.throwIfAborted();
  try {
    const deps = createGhStatusDeps(opts.env, depsOverrides);
    // Materialization inherits its caller's lifetime; the capability probe's budget does not apply.
    const { selected } = await resolveGhSelection({ ...opts, deps, includeVersion: false });
    opts.signal?.throwIfAborted();
    if (!selected?.binPath || selected.authenticated !== true) return unavailable;
    const result = await deps.runGhCommand({
      binPath: selected.binPath,
      args: ['auth', 'token', '--hostname', opts.hostname ?? 'github.com'],
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    opts.signal?.throwIfAborted();
    const token = result.ok ? result.stdout.trim() : '';
    return token ? { ok: true, token } : unavailable;
  } catch {
    opts.signal?.throwIfAborted();
    // Process errors may carry token-bearing stdout/stderr. Never return or log those fields.
    return unavailable;
  }
}

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

export const ghInstallDir = (env?: NodeJS.ProcessEnv) => join(env ? resolveHappyHomeDirFromEnvironment(env) : configuration.happyHomeDir, 'tools', INSTALLABLE_KEYS.GH);

export const ghBinPath = (env?: NodeJS.ProcessEnv) => {
  const binaryName = process.platform === 'win32' ? 'gh.exe' : GH_BINARY_NAME;
  return join(ghInstallDir(env), 'current', 'bin', binaryName);
};

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

async function resolveManagedGhBinPath(env?: NodeJS.ProcessEnv): Promise<string | null> {
  const candidate = ghBinPath(env);
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    await access(candidate, accessMode);
    return candidate;
  } catch {
    return null;
  }
}

async function runGhCommand(params: GhCommandParams): Promise<GhCommandResult> {
  params.signal?.throwIfAborted();
  const invocation = process.platform === 'win32'
    ? resolveWindowsCommandInvocation({ command: params.binPath, args: [...params.args], resolveCommandOnPath: false })
    : { command: params.binPath, args: [...params.args], windowsVerbatimArguments: false };
  try {
    const { stdout, stderr } = await execFileWithDeadline(invocation.command, invocation.args, {
      encoding: 'utf8',
      env: params.env ? { ...process.env, ...params.env } : process.env,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      ...(params.timeoutMs !== undefined ? { timeout: params.timeoutMs } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    params.signal?.throwIfAborted();
    return { ok: true, stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
  } catch (error) {
    params.signal?.throwIfAborted();
    const failure = typeof error === 'object' && error !== null ? error : {};
    return {
      ok: false,
      stdout: '',
      stderr: '',
      exitCode: 'code' in failure && typeof failure.code === 'number' ? failure.code : null,
    };
  }
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

async function probeGh(params: Readonly<{
  binPath: string;
  source: 'system' | 'managed';
  deps: GhStatusDeps;
  env?: NodeJS.ProcessEnv;
  hostname?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  includeVersion: boolean;
}>): Promise<Pick<GhDepData, 'binPath' | 'resolvedSource' | 'installedVersion' | 'authenticated' | 'authStatus' | 'remediationReason'>> {
  params.signal?.throwIfAborted();
  const commandOptions = {
    binPath: params.binPath,
    ...(params.env ? { env: params.env } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  };
  const versionResult = params.includeVersion
    ? await params.deps.runGhCommand({ ...commandOptions, args: ['--version'] })
    : null;
  const authResult = await params.deps.runGhCommand({
    ...commandOptions,
    args: ['auth', 'status', '--hostname', params.hostname ?? 'github.com'],
  });
  params.signal?.throwIfAborted();
  // `gh auth status` answers only when it exits. A probe the deadline killed — or one that never
  // launched — comes back `ok: false` with `exitCode: null`; reporting that as "signed out" is the
  // "sign in with gh CLI" instruction shown to an already-authenticated host.
  const authStatus: GhDepData['authStatus'] = authResult.ok
    ? 'authenticated'
    : typeof authResult.exitCode === 'number' ? 'missing_auth' : 'unknown';

  return {
    binPath: params.binPath,
    resolvedSource: params.source,
    installedVersion: versionResult ? parseVersionFromGhOutput(versionResult.stdout) : null,
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

async function resolveGhSelection(params: Readonly<{
  deps: GhStatusDeps;
  env?: NodeJS.ProcessEnv;
  hostname?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  includeVersion: boolean;
}>) {
  params.signal?.throwIfAborted();
  const [systemBinPath, managedBinPath] = await Promise.all([
    params.deps.resolveSystemGhBinPath(params.env ?? process.env),
    params.deps.resolveManagedGhBinPath(params.env),
  ]);
  const systemProbe = systemBinPath
    ? await probeGh({ ...params, binPath: systemBinPath, source: 'system' })
    : null;
  const managedProbe = managedBinPath
    ? await probeGh({ ...params, binPath: managedBinPath, source: 'managed' })
    : null;
  const selected = systemProbe?.authenticated === true
    ? systemProbe
    : managedProbe?.authenticated === true
      ? managedProbe
      : systemProbe ?? managedProbe ?? null;
  return { selected, managedBinPath };
}

export async function getGhDepStatus(
  opts: Readonly<{ includeLatestVersion?: boolean; onlyIfInstalled?: boolean; env?: NodeJS.ProcessEnv; hostname?: string }> = {},
  depsOverrides: Partial<GhStatusDeps> = {},
): Promise<GhDepData> {
  const deps = createGhStatusDeps(opts.env, depsOverrides);
  const [state, { selected, managedBinPath }, lastBackgroundUpdateCheckAtMs] = await Promise.all([
    deps.readState(opts.env),
    resolveGhSelection({ ...opts, deps, includeVersion: true, timeoutMs: 2_000 }),
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

import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, delimiter as PATH_DELIMITER } from 'node:path';
import { GH_BINARY_NAME } from '@happier-dev/protocol/installables/definitions/gh';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol/installables/codexAcp';
import { execFileWithDeadline, resolveWindowsCommandInvocation, resolveWindowsCommandOnPath } from '../process/index.js';
import { resolveManagedToolsRoot } from './managedToolsRoot.js';

export type GhCommandResult = Readonly<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}>;

export type GhCommandParams = Readonly<{
  binPath: string;
  args: readonly string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}>;

export type GhCommandDeps = Readonly<{
  resolveSystemGhBinPath: (env?: NodeJS.ProcessEnv) => Promise<string | null>;
  resolveManagedGhBinPath: (env?: NodeJS.ProcessEnv) => Promise<string | null>;
  runGhCommand: (params: GhCommandParams) => Promise<GhCommandResult>;
}>;

export type GhNativeTokenResult =
  | Readonly<{ ok: true; token: string }>
  | Readonly<{ ok: false; reason: 'unavailable'; remediation: 'sign in with gh CLI' }>;

export async function resolveGhNativeToken(
  opts: Readonly<{ hostname?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }> = {},
  depsOverrides: Partial<GhCommandDeps> = {},
): Promise<GhNativeTokenResult> {
  const unavailable = { ok: false, reason: 'unavailable', remediation: 'sign in with gh CLI' } as const;
  opts.signal?.throwIfAborted();
  try {
    const deps = { resolveSystemGhBinPath, resolveManagedGhBinPath, runGhCommand, ...depsOverrides };
    // Read local credentials only; the consuming API request owns token validation.
    // Materialization inherits its caller's lifetime, without the capability probe's budget.
    const { selected } = await resolveGhSelection({
      ...opts,
      deps,
      probe: async (binPath) => {
        const result = await deps.runGhCommand({
          binPath,
          args: ['auth', 'token', '--hostname', opts.hostname ?? 'github.com'],
          ...(opts.env ? { env: opts.env } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        return result.ok ? result.stdout.trim() : '';
      },
      isUsable: (token) => token.length > 0,
    });
    const token = selected ?? '';
    return token ? { ok: true, token } : unavailable;
  } catch {
    opts.signal?.throwIfAborted();
    // Process errors may carry token-bearing stdout/stderr. Never return or log those fields.
    return unavailable;
  }
}

export const ghInstallDir = (env?: NodeJS.ProcessEnv) => join(resolveManagedToolsRoot(env), INSTALLABLE_KEYS.GH);

export const ghBinPath = (env?: NodeJS.ProcessEnv) => {
  const binaryName = process.platform === 'win32' ? 'gh.exe' : GH_BINARY_NAME;
  return join(ghInstallDir(env), 'current', 'bin', binaryName);
};

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

export async function resolveSystemGhBinPath(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return resolveCommandOnPath(GH_BINARY_NAME, env);
}

export async function resolveManagedGhBinPath(env?: NodeJS.ProcessEnv): Promise<string | null> {
  const candidate = ghBinPath(env);
  const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    await access(candidate, accessMode);
    return candidate;
  } catch {
    return null;
  }
}

export async function runGhCommand(params: GhCommandParams): Promise<GhCommandResult> {
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

export async function resolveGhSelection<T>(params: Readonly<{
  deps: GhCommandDeps;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  probe: (binPath: string, source: 'system' | 'managed') => Promise<T>;
  isUsable: (result: T) => boolean;
}>) {
  params.signal?.throwIfAborted();
  const [systemBinPath, managedBinPath] = await Promise.all([
    params.deps.resolveSystemGhBinPath(params.env ?? process.env),
    params.deps.resolveManagedGhBinPath(params.env),
  ]);
  params.signal?.throwIfAborted();
  const systemProbe = systemBinPath ? await params.probe(systemBinPath, 'system') : null;
  params.signal?.throwIfAborted();
  if (systemProbe !== null && params.isUsable(systemProbe)) {
    return { selected: systemProbe, managedBinPath };
  }
  const managedProbe = managedBinPath ? await params.probe(managedBinPath, 'managed') : null;
  params.signal?.throwIfAborted();
  const selected = managedProbe !== null && params.isUsable(managedProbe)
    ? managedProbe
    : systemProbe ?? managedProbe;
  return { selected, managedBinPath };
}

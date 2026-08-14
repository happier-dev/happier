import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { rm, stat } from 'node:fs/promises';
import { accessSync, constants as fsConstants } from 'node:fs';

import { commandExistsOnPath } from '../process/index.js';
import { resolveWindowsCommandInvocation } from '../process/index.js';
import { expandHomeDirPath } from '../path/expandHomeDirPath.js';

export type RunCommand = (
  cmd: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: 'inherit' | 'pipe' | 'ignore';
    input?: string;
    timeoutMs?: number;
  },
) => Promise<void> | void;

const DEFAULT_BUN_COMPILE_ATTEMPTS = 3;
const MAX_BUN_COMPILE_ATTEMPTS = 5;

export function execOrThrow(
  cmd: string,
  args: string[],
  { cwd = process.cwd(), env = process.env, stdio = 'inherit', input, timeoutMs }: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: 'inherit' | 'pipe' | 'ignore';
    input?: string;
    timeoutMs?: number;
  } = {},
): void {
  const invocation = resolveWindowsCommandInvocation({
    command: cmd,
    args,
    env,
  });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    env,
    stdio,
    encoding: 'utf-8',
    input,
    ...(typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? { timeout: timeoutMs } : {}),
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  if (result.error) {
    const wrapped = new Error(`[component-artifacts] failed to run ${cmd}: ${String(result.error.message || result.error)}`);
    const errorCode = result.error && typeof result.error === 'object' && 'code' in result.error
      ? String(result.error.code ?? '')
      : '';
    if (errorCode) {
      Object.assign(wrapped, { code: errorCode });
    }
    Object.assign(wrapped, { cause: result.error });
    throw wrapped;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    throw new Error(`[component-artifacts] ${cmd} exited with status ${result.status}${stderr ? `: ${stderr}` : ''}`);
  }
}

export function commandExists(cmd: string): boolean {
  return commandExistsOnPath(cmd);
}

function resolveBunExecutableBasename(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'bun.exe' : 'bun';
}

function isRunnableExecutablePath(pathLike: string | null | undefined, platform: NodeJS.Platform = process.platform): boolean {
  const candidate = String(pathLike ?? '').trim();
  if (!candidate) return false;
  try {
    accessSync(candidate, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveBunCommand({
  processEnv = process.env,
  commandProbe = commandExists,
  platform = process.platform,
}: {
  processEnv?: NodeJS.ProcessEnv;
  commandProbe?: (cmd: string) => boolean;
  platform?: NodeJS.Platform;
} = {}): string | null {
  const explicit = expandHomeDirPath(String(processEnv.HAPPIER_BUN_PATH ?? '').trim(), processEnv);
  if (isRunnableExecutablePath(explicit, platform)) {
    return explicit;
  }

  if (commandProbe('bun')) {
    return 'bun';
  }

  const executableName = resolveBunExecutableBasename(platform);
  const candidateDirs = [
    String(processEnv.BUN_INSTALL ?? '').trim() ? join(String(processEnv.BUN_INSTALL).trim(), 'bin') : '',
    String(processEnv.HOME ?? '').trim() ? join(String(processEnv.HOME).trim(), '.bun', 'bin') : '',
    String(processEnv.USERPROFILE ?? '').trim() ? join(String(processEnv.USERPROFILE).trim(), '.bun', 'bin') : '',
  ]
    .map((value) => value.trim())
    .filter(Boolean);

  for (const dir of new Set(candidateDirs)) {
    const candidate = join(dir, executableName);
    if (isRunnableExecutablePath(candidate, platform)) {
      return candidate;
    }
  }

  return null;
}

export function resolveYarnCommand({
  commandProbe = commandExists,
}: {
  commandProbe?: (cmd: string) => boolean;
} = {}): { cmd: string; args: string[] } {
  if (commandProbe('yarn')) return { cmd: 'yarn', args: [] };
  if (commandProbe('corepack')) return { cmd: 'corepack', args: ['yarn'] };
  throw new Error('[component-artifacts] building binary artifacts requires yarn or corepack (corepack yarn)');
}

export async function ensureFileExists(path: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) {
    throw new Error(`[component-artifacts] expected file to exist: ${path}`);
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? '');
}

function isTransientBunExecutableExtractionFailure(error: unknown): boolean {
  const message = getErrorMessage(error);
  return message.includes('Failed to extract executable')
    && message.includes('download may be incomplete');
}

function extractBunRuntimeCacheEntry(error: unknown): string | null {
  const match = getErrorMessage(error).match(/Failed to extract executable for '([^']+)'/);
  return match?.[1] ?? null;
}

function resolveBunCompileMaxAttempts(rawValue: string | undefined, override: number | undefined): number {
  const value = override ?? Number.parseInt(String(rawValue ?? ''), 10);
  if (!Number.isFinite(value)) return DEFAULT_BUN_COMPILE_ATTEMPTS;
  return Math.min(MAX_BUN_COMPILE_ATTEMPTS, Math.max(1, Math.trunc(value)));
}

async function clearTransientBunCompileArtifacts(error: unknown, outfile: string): Promise<void> {
  await rm(outfile, { force: true }).catch(() => undefined);

  const cacheEntry = extractBunRuntimeCacheEntry(error);
  if (!cacheEntry) return;

  const candidateCacheDirs = [
    String(process.env.BUN_INSTALL ?? '').trim() ? join(String(process.env.BUN_INSTALL).trim(), 'install', 'cache') : '',
    String(process.env.HOME ?? '').trim() ? join(String(process.env.HOME).trim(), '.bun', 'install', 'cache') : '',
    String(process.env.USERPROFILE ?? '').trim() ? join(String(process.env.USERPROFILE).trim(), '.bun', 'install', 'cache') : '',
  ].filter(Boolean);

  await Promise.all([...new Set(candidateCacheDirs)].map((cacheDir) => (
    rm(join(cacheDir, cacheEntry), { recursive: true, force: true }).catch(() => undefined)
  )));
}

export async function compileBunBinary({
  entrypoint,
  bunTarget,
  outfile,
  cwd = process.cwd(),
  externals = [],
  bunCommand,
  runCommand = execOrThrow,
  maxAttempts,
  buildRunnerEntrypoint,
}: {
  entrypoint: string;
  bunTarget: string;
  outfile: string;
  cwd?: string;
  externals?: string[];
  bunCommand?: string;
  runCommand?: RunCommand;
  maxAttempts?: number;
  buildRunnerEntrypoint?: string;
}): Promise<void> {
  const resolvedBunCommand = (() => {
    const candidate = String(bunCommand ?? '').trim();
    if (candidate) return candidate;
    const fallback = resolveBunCommand();
    if (fallback) return fallback;
    throw new Error('[component-artifacts] bun is required to compile binary artifacts');
  })();
  const args = buildRunnerEntrypoint
    ? [
        buildRunnerEntrypoint,
        `--target=${bunTarget}`,
        `--entrypoint=${entrypoint}`,
        `--outfile=${outfile}`,
      ]
    : ['build', '--compile', '--no-cache', `--target=${bunTarget}`, entrypoint, '--outfile', outfile];
  for (const external of externals) {
    const value = String(external ?? '').trim();
    if (!value) continue;
    if (buildRunnerEntrypoint) {
      args.push(`--external=${value}`);
    } else {
      args.push('--external', value);
    }
  }
  const attempts = resolveBunCompileMaxAttempts(process.env.HAPPIER_BUN_COMPILE_ATTEMPTS, maxAttempts);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await runCommand(resolvedBunCommand, args, { cwd });
      break;
    } catch (error) {
      if (attempt >= attempts || !isTransientBunExecutableExtractionFailure(error)) {
        throw error;
      }
      await clearTransientBunCompileArtifacts(error, outfile);
    }
  }
  const startedAt = Date.now();
  const timeoutMs = 5_000;
  while (Date.now() - startedAt < timeoutMs) {
    const info = await stat(outfile).catch(() => null);
    if (info?.isFile()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`[component-artifacts] bun build succeeded but compiled output is missing: ${outfile}`);
}

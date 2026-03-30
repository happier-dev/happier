import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { accessSync, constants as fsConstants } from 'node:fs';

import { commandExistsOnPath } from '../process/index.js';

export type RunCommand = (
  cmd: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: 'inherit' | 'pipe' | 'ignore';
    input?: string;
  },
) => void;

export function execOrThrow(
  cmd: string,
  args: string[],
  { cwd = process.cwd(), env = process.env, stdio = 'inherit', input }: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: 'inherit' | 'pipe' | 'ignore';
    input?: string;
  } = {},
): void {
  const result = spawnSync(cmd, args, {
    cwd,
    env,
    stdio,
    encoding: 'utf-8',
    input,
  });
  if (result.error) {
    throw new Error(`[component-artifacts] failed to run ${cmd}: ${String(result.error.message || result.error)}`);
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
  const explicit = String(processEnv.HAPPIER_BUN_PATH ?? '').trim();
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

export async function compileBunBinary({
  entrypoint,
  bunTarget,
  outfile,
  cwd = process.cwd(),
  externals = [],
  bunCommand,
  runCommand = execOrThrow,
}: {
  entrypoint: string;
  bunTarget: string;
  outfile: string;
  cwd?: string;
  externals?: string[];
  bunCommand?: string;
  runCommand?: RunCommand;
}): Promise<void> {
  const resolvedBunCommand = (() => {
    const candidate = String(bunCommand ?? '').trim();
    if (candidate) return candidate;
    const fallback = resolveBunCommand();
    if (fallback) return fallback;
    throw new Error('[component-artifacts] bun is required to compile binary artifacts');
  })();
  const args = ['build', '--compile', `--target=${bunTarget}`, entrypoint, '--outfile', outfile];
  for (const external of externals) {
    const value = String(external ?? '').trim();
    if (!value) continue;
    args.push('--external', value);
  }
  runCommand(resolvedBunCommand, args, { cwd });
  const startedAt = Date.now();
  const timeoutMs = 5_000;
  while (Date.now() - startedAt < timeoutMs) {
    const info = await stat(outfile).catch(() => null);
    if (info?.isFile()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`[component-artifacts] bun build succeeded but compiled output is missing: ${outfile}`);
}

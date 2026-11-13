import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, sep } from 'node:path';

import { absolutePathFromWorkingDirectory } from '../path/absolutePathFromWorkingDirectory.js';

import { resolveWindowsCommandOnPath, resolveWindowsCommandPath } from './windows/resolveWindowsCommandInvocation.js';

type ExecutableCommandOptions = Readonly<{ env?: NodeJS.ProcessEnv; cwd?: string }>;

/** Match child_process search semantics when a selected environment omits PATH. */
export function resolveExecutableSearchPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return env.PATH ?? '/usr/bin:/bin';
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  return env.PATH ?? (pathKey === undefined ? undefined : env[pathKey]) ?? process.env.PATH ?? '';
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function* commandsOnPath(command: string, options: ExecutableCommandOptions): Generator<string, void, unknown> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const path = resolveExecutableSearchPath(env);
  if (process.platform === 'win32') {
    // Preserve Windows Path spelling, PATHEXT ordering, and native npm-shim handling.
    const lookupEnv = { ...env, PATH: path.split(delimiter).map((dir) => absolutePathFromWorkingDirectory(dir, cwd)).join(delimiter) };
    const found = resolveWindowsCommandOnPath(command, lookupEnv, isExecutableFile);
    if (found && isExecutableFile(found)) yield found;
    return;
  }
  // Node's child_process contract uses /usr/bin:/bin when PATH is absent on Unix.
  // An explicitly empty PATH entry means the child's cwd; a login shell must not replace it.
  for (const dir of path.split(delimiter)) {
    const candidate = absolutePathFromWorkingDirectory(dir ? `${dir}${sep}${command}` : command, cwd);
    if (isExecutableFile(candidate)) yield candidate;
  }
}

/** Resolve the requested executable only, without acquiring or selecting replacement tooling. */
export function resolveExecutableCommand(command: string, options: ExecutableCommandOptions = {}): string | null {
  if (!command) return null;
  const hasPath = command.includes('/') || (process.platform === 'win32' && /[\\:]/.test(command));
  if (!hasPath) return commandsOnPath(command, options).next().value ?? null;
  const path = absolutePathFromWorkingDirectory(command, options.cwd ?? process.cwd());
  const resolved = process.platform === 'win32'
    ? resolveWindowsCommandPath(path, options.env ?? process.env)
    : path;
  return resolved && isExecutableFile(resolved) ? resolved : null;
}

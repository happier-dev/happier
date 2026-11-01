import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, sep } from 'node:path';

import { resolveWindowsCommandOnPath, resolveWindowsCommandPath } from './windows/resolveWindowsCommandInvocation.js';

type ExecutableCommandOptions = Readonly<{ env?: NodeJS.ProcessEnv; cwd?: string }>;

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Concatenation preserves physical symlink/.. traversal; path.join/resolve would change the selected executable.
function absoluteFromCwd(path: string, cwd: string): string {
  if (isAbsolute(path)) return path;
  const absoluteCwd = isAbsolute(cwd) ? cwd : `${process.cwd()}${sep}${cwd}`;
  return `${absoluteCwd}${sep}${path}`;
}

function* commandsOnPath(command: string, options: ExecutableCommandOptions): Generator<string, void, unknown> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  if (process.platform === 'win32') {
    // Preserve Windows Path spelling, PATHEXT ordering, and native npm-shim handling.
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
    const path = env.PATH ?? (pathKey === undefined ? undefined : env[pathKey]) ?? process.env.PATH ?? '';
    const lookupEnv = { ...env, PATH: path.split(delimiter).map((dir) => absoluteFromCwd(dir, cwd)).join(delimiter) };
    const found = resolveWindowsCommandOnPath(command, lookupEnv, isExecutableFile);
    if (found && isExecutableFile(found)) yield found;
    return;
  }
  // Node's child_process contract uses /usr/bin:/bin when PATH is absent on Unix.
  // An explicitly empty PATH entry means the child's cwd; a login shell must not replace it.
  for (const dir of (env.PATH ?? '/usr/bin:/bin').split(delimiter)) {
    const candidate = absoluteFromCwd(dir ? `${dir}${sep}${command}` : command, cwd);
    if (isExecutableFile(candidate)) yield candidate;
  }
}

export function resolveExecutableCommandsOnPath(command: string, options: ExecutableCommandOptions = {}): string[] {
  return [...commandsOnPath(command, options)];
}

/** Resolve the requested executable only, without acquiring or selecting replacement tooling. */
export function resolveExecutableCommand(command: string, options: ExecutableCommandOptions = {}): string | null {
  if (!command) return null;
  const hasPath = command.includes('/') || (process.platform === 'win32' && /[\\:]/.test(command));
  if (!hasPath) return commandsOnPath(command, options).next().value ?? null;
  const path = absoluteFromCwd(command, options.cwd ?? process.cwd());
  const resolved = process.platform === 'win32'
    ? resolveWindowsCommandPath(path, options.env ?? process.env)
    : path;
  return resolved && isExecutableFile(resolved) ? resolved : null;
}

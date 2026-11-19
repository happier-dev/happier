import path from 'node:path';

import { PluginError } from '@happier-dev/plugin-sdk/errors';

/** Workspace command overlays, never host credentials or native launch configuration. */
const TARGET_COMMAND_ENV = /^(?:GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL|DATE)|GIT_(?:INDEX_FILE|TERMINAL_PROMPT|OPTIONAL_LOCKS|NO_REPLACE_OBJECTS|NO_LAZY_FETCH|LITERAL_PATHSPECS|CONFIG_NOSYSTEM|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_COUNT|CONFIG_(?:KEY|VALUE)_\d+)|LANG|LANGUAGE|LC_[A-Z]+|TERM|NO_COLOR|COLUMNS)$/u;

export function holderWorkspaceRelativePath(rootPath: string, target: string): string {
  const root = path.posix.resolve(rootPath);
  const inside = path.posix.relative(root, path.posix.resolve(root, target));
  if (inside === '..' || inside.startsWith('../') || path.posix.isAbsolute(inside)) {
    throw new PluginError({ code: 'workspace_root_unsafe', message: 'Path is outside the Session workspace', retryable: false });
  }
  return inside;
}

export function mapHolderWorkspacePath(fromRoot: string, toRoot: string, absolutePath: string): string {
  return path.posix.join(toRoot, holderWorkspaceRelativePath(fromRoot, absolutePath));
}

/** The holder command boundary shared by workspace processes and workspace terminals. */
export function resolveHolderWorkspaceCommand(rootPath: string, request: Readonly<{
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}>, guestRootPath = rootPath): Readonly<{ argv: readonly string[]; cwd?: string; env?: Readonly<Record<string, string>> }> {
  const cwd = request.cwd === undefined ? '' : holderWorkspaceRelativePath(rootPath, request.cwd);
  // This Machine's environment is not the target's: only allowlisted entries the caller changed cross.
  const env = request.env ? Object.fromEntries(Object.entries(request.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== process.env[entry[0]]
      && TARGET_COMMAND_ENV.test(entry[0]))) : undefined;
  // Git's non-editing commit hooks receive the no-op editor in the target too.
  if (env && request.env?.GIT_EDITOR === ':') env.GIT_EDITOR = ':';
  if (env?.GIT_INDEX_FILE !== undefined) {
    const indexPath = path.posix.resolve(rootPath, cwd, env.GIT_INDEX_FILE);
    env.GIT_INDEX_FILE = mapHolderWorkspacePath(rootPath, guestRootPath, indexPath);
  }
  return { argv: [request.command, ...request.args], ...(cwd ? { cwd } : {}),
    ...(env && Object.keys(env).length ? { env } : {}) };
}

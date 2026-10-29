import { resolveExecutableCommand } from './resolveExecutableCommand.js';

import {
  resolveWindowsCommandInvocation,
} from './windows/resolveWindowsCommandInvocation.js';

export function commandExistsOnPath(
  cmd: string,
  options: Readonly<{
    env?: NodeJS.ProcessEnv;
    path?: string | undefined;
  }> = {},
): boolean {
  const name = String(cmd ?? '').trim();
  if (!name) return false;

  const env = options.env ?? process.env;
  const probeEnv = options.path === undefined ? env : { ...env, PATH: options.path };

  if (process.platform === 'win32') {
    if (/^cmd(?:\.exe)?$/i.test(name)) {
      const invocation = resolveWindowsCommandInvocation({
        command: name,
        args: [],
        env: probeEnv,
      });
      if (invocation.command.toLowerCase() !== name.toLowerCase()) {
        return true;
      }
    }

    return resolveExecutableCommand(name, { env: probeEnv }) !== null;
  }

  return resolveExecutableCommand(name, { env: probeEnv }) !== null;
}

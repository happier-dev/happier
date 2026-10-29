import { basename, win32 } from 'node:path';

import { resolveExecutableCommand } from '@happier-dev/cli-common/process';

export type NormalizedPackageRunnerInvocation = Readonly<{
  command: string;
  args: string[];
}>;

export function isPackageRunnerCommand(command: string): boolean {
  const name = (process.platform === 'win32' ? win32.basename(command) : basename(command)).toLowerCase();
  return /^(?:npx|npm|pnpm|yarn|yarnpkg|bunx)(?:\.(?:cmd|bat|exe|com))?$/.test(name);
}

/** User-configured runners keep their own package-manager semantics and installation. */
export async function normalizePackageRunnerInvocation(params: Readonly<{
  command: string;
  args: readonly string[];
  processEnv?: NodeJS.ProcessEnv;
  cwd?: string;
}>): Promise<NormalizedPackageRunnerInvocation | null> {
  const command = resolveExecutableCommand(params.command, { env: params.processEnv, cwd: params.cwd });
  if (!command) return null;
  const explicitPath = params.command.includes('/') || (process.platform === 'win32' && /[\\:]/.test(params.command));
  return {
    command: explicitPath && process.platform !== 'win32' ? params.command : command,
    args: [...params.args],
  };
}

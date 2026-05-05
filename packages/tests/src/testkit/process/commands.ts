import { spawnSync } from 'node:child_process';

import { resolveYarnCommandInvocation as resolveWorkspaceYarnCommandInvocation } from '../../../../../scripts/workspaces/execYarnCommand.mjs';

export type CommandInvocation = Readonly<{
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}>;

export function yarnCommand(): string {
  return process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
}

export function resolveYarnCommandInvocation(
  args: readonly string[] = [],
  options: Readonly<{ platform?: NodeJS.Platform; npmExecPath?: string; comspec?: string }> = {},
): CommandInvocation {
  return resolveWorkspaceYarnCommandInvocation(args, options);
}

export function which(bin: string): string | null {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(cmd, [bin], { encoding: 'utf8' });
  if (res.error) return null;
  if (res.status === null) return null;
  if (res.status !== 0) return null;
  const out = (res.stdout || '').trim().split(/\r?\n/)[0];
  return out && out.length > 0 ? out : null;
}

import type { ExecFileSyncOptions, execFileSync } from 'node:child_process';

export type YarnCommandInvocation = Readonly<{
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}>;

export type YarnCommandInvocationOptions = Readonly<{
  npmExecPath?: string | null;
  platform?: NodeJS.Platform;
  processExecPath?: string;
  comspec?: string | null;
}>;

export function buildWindowsCmdShimInvocation(
  command: string,
  args: readonly string[],
  options?: Readonly<{ comspec?: string | null }>,
): YarnCommandInvocation;

export function resolveYarnInvocation(
  npmExecPath?: string | null,
  options?: YarnCommandInvocationOptions,
): YarnCommandInvocation;

export function resolveYarnCommandInvocation(
  args?: readonly string[],
  options?: YarnCommandInvocationOptions,
): YarnCommandInvocation;

export function execYarn(
  args: readonly string[],
  options?: ExecFileSyncOptions & YarnCommandInvocationOptions & {
    execFileSync?: typeof execFileSync;
  },
): ReturnType<typeof execFileSync>;

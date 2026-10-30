export type CommandInvocation = Readonly<{
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}>;
export function isWindowsShellShimPath(pathLike: string): boolean;
export function resolveWindowsCommandPath(commandPath: string, env?: Readonly<Record<string, string | undefined>>): string | null;
export function resolveWindowsCommandOnPath(
  command: string,
  env?: Readonly<Record<string, string | undefined>>,
  accept?: (candidate: string) => boolean,
): string | null;
export function buildWindowsCmdShimInvocation(
  command: string,
  args: readonly string[],
  options?: Readonly<{ env?: Readonly<Record<string, string | undefined>>; comspec?: string | null }>,
): CommandInvocation;
export function resolveWindowsCommandInvocation(params: Readonly<{
  command: string;
  args: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  comspec?: string | null;
  resolveCommandOnPath?: boolean;
}>): CommandInvocation;

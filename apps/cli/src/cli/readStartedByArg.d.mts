export function readStartedByArg(args: readonly string[]): Readonly<{
  present: boolean;
  value: 'daemon' | 'terminal' | null;
}>;

export function isDaemonHostedCliInvocation(args: readonly string[]): boolean;

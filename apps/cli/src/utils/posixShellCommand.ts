function quoteForPosixShell(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function buildPosixShellCommand(args: readonly string[]): string {
  return args.map((arg) => quoteForPosixShell(String(arg))).join(' ');
}

export function buildPosixShellEnvironmentAssignments(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${quoteForPosixShell(value)}`)
    .join(' ');
}

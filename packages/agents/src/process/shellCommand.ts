export type ShellCommandDialect = 'posix' | 'windows_cmd';

function assertRepresentableArgument(arg: string): void {
  if (arg.includes('\0')) {
    throw new TypeError('Shell command arguments must not contain NUL');
  }
}

function quoteForPosixShell(arg: string): string {
  assertRepresentableArgument(arg);
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function buildPosixShellCommand(args: readonly string[]): string {
  return args.map((arg) => quoteForPosixShell(String(arg))).join(' ');
}

const WINDOWS_CMD_META_CHARACTER_PATTERN = /([()\][%!^"`<>&|;, *?])/g;

function escapeWindowsCmdExecutable(executable: string): string {
  assertRepresentableArgument(executable);
  return executable.replace(WINDOWS_CMD_META_CHARACTER_PATTERN, '^$1');
}

function quoteWindowsCmdArgument(arg: string): string {
  assertRepresentableArgument(arg);
  let quoted = arg
    .replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
    .replace(/(?=(\\+?)?)\1$/g, '$1$1');
  quoted = `"${quoted}"`;
  return quoted.replace(WINDOWS_CMD_META_CHARACTER_PATTERN, '^$1');
}

export function buildWindowsCmdCommand(args: readonly string[]): string {
  if (args.length === 0) {
    throw new TypeError('Windows cmd command requires an executable');
  }
  const [executable, ...rest] = args.map(String);
  return [
    escapeWindowsCmdExecutable(executable!),
    ...rest.map(quoteWindowsCmdArgument),
  ].join(' ');
}

export function buildShellCommand(
  args: readonly string[],
  dialect: ShellCommandDialect,
): string {
  switch (dialect) {
    case 'posix':
      return buildPosixShellCommand(args);
    case 'windows_cmd':
      return buildWindowsCmdCommand(args);
  }
}

export function buildPosixShellEnvironmentAssignments(
  env: Readonly<Record<string, string>>,
): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${quoteForPosixShell(value)}`)
    .join(' ');
}

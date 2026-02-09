export function readNonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = readNonNegativeIntegerEnv(name, fallback);
  return value <= 0 ? fallback : value;
}

export function resolveTmuxCommandTimeoutMs(): number {
  return readPositiveIntegerEnv('HAPPIER_CLI_TMUX_COMMAND_TIMEOUT_MS', 15_000);
}

export function isTmuxWindowIndexConflict(stderr: string | undefined): boolean {
  return /index\s+\d+\s+in\s+use/i.test(stderr ?? '');
}

export function normalizeExitCode(code: number | null): number {
  // Node passes `code === null` when the process was terminated by a signal.
  // Preserve failure semantics rather than treating it as success.
  return code ?? 1;
}

function quoteForPosixShell(arg: string): string {
  // POSIX-safe single-quote escaping: ' -> '\'' .
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function buildPosixShellCommand(args: string[]): string {
  return args.map(quoteForPosixShell).join(' ');
}

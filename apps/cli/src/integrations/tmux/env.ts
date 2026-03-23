import { buildPosixShellCommand } from '@/utils/posixShellCommand';

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

/**
 * Extract the conflicting window index from tmux error message.
 * Returns null if no index can be parsed.
 */
export function extractTmuxWindowIndexConflict(stderr: string | undefined): number | null {
  if (!stderr) return null;
  const match = /index\s+(\d+)\s+in\s+use/i.exec(stderr);
  if (!match || !match[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeExitCode(code: number | null): number {
  // Node passes `code === null` when the process was terminated by a signal.
  // Preserve failure semantics rather than treating it as success.
  return code ?? 1;
}

export { buildPosixShellCommand };

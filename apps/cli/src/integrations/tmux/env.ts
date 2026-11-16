import { buildPosixShellCommand } from '@happier-dev/agents/process/shellCommand';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';

export function readNonNegativeIntegerEnv(name: string, fallback: number, environment: NodeJS.ProcessEnv = sessionProcessEnvironment()): number {
  const raw = environment[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function readPositiveIntegerEnv(name: string, fallback: number, environment: NodeJS.ProcessEnv = sessionProcessEnvironment()): number {
  const value = readNonNegativeIntegerEnv(name, fallback, environment);
  return value <= 0 ? fallback : value;
}

export function resolveTmuxCommandTimeoutMs(environment: NodeJS.ProcessEnv = sessionProcessEnvironment()): number {
  return readPositiveIntegerEnv('HAPPIER_CLI_TMUX_COMMAND_TIMEOUT_MS', 15_000, environment);
}

export function resolveTmuxPromptSubmitDelayMs(environment: NodeJS.ProcessEnv = sessionProcessEnvironment()): number {
  return readNonNegativeIntegerEnv('HAPPIER_CLI_TMUX_PROMPT_SUBMIT_DELAY_MS', 50, environment);
}

export function resolveTmuxSendKeysChunkSize(environment: NodeJS.ProcessEnv = sessionProcessEnvironment()): number {
  return readPositiveIntegerEnv('HAPPIER_CLI_TMUX_SEND_KEYS_CHUNK_SIZE', 8192, environment);
}

export function isTmuxWindowIndexConflict(stderr: string | undefined): boolean {
  return /index\s+\d+\s+in\s+use/i.test(stderr ?? '');
}

export function normalizeExitCode(code: number | null): number {
  // Node passes `code === null` when the process was terminated by a signal.
  // Preserve failure semantics rather than treating it as success.
  return code ?? 1;
}

export { buildPosixShellCommand };

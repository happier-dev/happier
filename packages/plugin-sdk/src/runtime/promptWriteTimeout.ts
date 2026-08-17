/** @moduleRealm daemon */
import { Buffer } from 'node:buffer';

export {
  resolveTerminalPromptWriteBudget,
  resolveTerminalPromptWriteTimeoutMs,
  type TerminalPromptWriteBudget,
} from '@happier-dev/agents/runtime/terminal/promptWriteTimeout';

const TERMINAL_PROMPT_BASE_PROVIDER_ACCEPTANCE_TIMEOUT_MS = 5_000;
const TERMINAL_PROMPT_MAX_PROVIDER_ACCEPTANCE_TIMEOUT_MS = 180_000;

const PROVIDER_ACCEPTANCE_BYTES_PER_SECOND = 2_048;

export function resolveTerminalPromptProviderAcceptanceTimeoutMs(
  text: string,
  options?: Readonly<{
    baseTimeoutMs?: number | undefined;
    maxTimeoutMs?: number | undefined;
    bytesWritten?: number | undefined;
  }>,
): number {
  const baseTimeoutMs = Math.max(
    0,
    Math.trunc(options?.baseTimeoutMs ?? TERMINAL_PROMPT_BASE_PROVIDER_ACCEPTANCE_TIMEOUT_MS),
  );
  const maxTimeoutMs = Math.max(
    baseTimeoutMs,
    Math.trunc(options?.maxTimeoutMs ?? TERMINAL_PROMPT_MAX_PROVIDER_ACCEPTANCE_TIMEOUT_MS),
  );
  const byteLength = Number.isFinite(options?.bytesWritten)
    ? Math.max(0, Math.trunc(options?.bytesWritten ?? 0))
    : Buffer.byteLength(text, 'utf8');
  const baseScaleThresholdMs = Math.max(baseTimeoutMs, TERMINAL_PROMPT_BASE_PROVIDER_ACCEPTANCE_TIMEOUT_MS);
  const byteBudgetMs = Math.ceil(byteLength / PROVIDER_ACCEPTANCE_BYTES_PER_SECOND) * 1_000;
  const resolved = byteBudgetMs <= baseScaleThresholdMs ? baseTimeoutMs : Math.max(baseTimeoutMs, byteBudgetMs);
  return Math.min(maxTimeoutMs, resolved);
}

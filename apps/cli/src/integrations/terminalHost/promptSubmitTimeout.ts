const MIN_PROMPT_SUBMIT_TIMEOUT_MS = 1_000;

export function resolvePromptSubmitTimeoutMs(params: Readonly<{
  remainingTimeoutMs?: number | undefined;
  fallbackTimeoutMs?: number | undefined;
}> = {}): number {
  const candidates = [
    params.remainingTimeoutMs,
    params.fallbackTimeoutMs,
  ].filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0);
  if (candidates.length === 0) {
    return MIN_PROMPT_SUBMIT_TIMEOUT_MS;
  }
  return Math.ceil(Math.max(...candidates));
}

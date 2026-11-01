/** Select an observed clock no later than the settled turn's final model request. */
export function resolvePromptCacheLastUseAtMs(input: Readonly<{
  turnStartedAtMs?: number;
  lastNonModelItemCompletedAtMs?: number;
}>): number | undefined {
  return input.lastNonModelItemCompletedAtMs ?? input.turnStartedAtMs;
}

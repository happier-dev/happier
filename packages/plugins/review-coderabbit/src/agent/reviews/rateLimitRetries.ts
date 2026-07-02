export function parseCodeRabbitRateLimitRetryMs(text: string): number | null {
  const match = String(text ?? '').match(
    /Rate limit exceeded,\s*please try after\s+(\d+)\s+minutes?\s+and\s+(\d+)\s+seconds?/i,
  );
  if (!match?.[1] || !match[2]) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.max(1_000, ((minutes * 60) + seconds + 1) * 1_000);
}

export async function runWithCodeRabbitRateLimitRetries<
  TResult extends Readonly<{ ok: boolean; stdout: string; stderr: string }>,
>(params: Readonly<{
  maxAttempts: number;
  maxTotalRetrySleepMs?: number | null;
  runOnce: (attempt: number) => Promise<TResult>;
  sleepMs: (ms: number) => Promise<void>;
}>): Promise<TResult> {
  const maxAttempts = Number(params.maxAttempts);
  const attempts = Number.isFinite(maxAttempts) && maxAttempts > 0
    ? Math.floor(maxAttempts)
    : 1;
  const maxTotalRetrySleepMs =
    typeof params.maxTotalRetrySleepMs === 'number'
      && Number.isFinite(params.maxTotalRetrySleepMs)
      && params.maxTotalRetrySleepMs >= 0
      ? Math.floor(params.maxTotalRetrySleepMs)
      : null;

  let last: TResult | null = null;
  let totalRetrySleepMs = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await params.runOnce(attempt);
    last = result;
    if (result.ok) return result;

    const retryMs = parseCodeRabbitRateLimitRetryMs(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    if (!retryMs || attempt >= attempts) return result;
    if (maxTotalRetrySleepMs !== null && totalRetrySleepMs + retryMs > maxTotalRetrySleepMs) {
      return result;
    }
    await params.sleepMs(retryMs);
    totalRetrySleepMs += retryMs;
  }

  return last ?? params.runOnce(1);
}

export function parseCodeRabbitRateLimitRetryMs(text: string): number | null {
  const s = String(text ?? '');
  const m = s.match(/Rate limit exceeded,\s*please try after\s+(\d+)\s+minutes?\s+and\s+(\d+)\s+seconds?/i);
  if (!m) return null;
  const minutes = Number(m[1]);
  const seconds = Number(m[2]);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (!Number.isFinite(seconds) || seconds < 0) return null;

  // Add +1s padding to avoid retrying too early.
  const totalSeconds = minutes * 60 + seconds + 1;
  return Math.max(1000, totalSeconds * 1000);
}

export async function runWithCodeRabbitRateLimitRetries<T extends Readonly<{ ok: boolean; stdout: string; stderr: string }>>(_args: Readonly<{
  maxAttempts: number;
  runOnce: (attempt: number) => Promise<T>;
  sleepMs: (ms: number) => Promise<void>;
}>): Promise<T> {
  const maxAttempts = Number(_args.maxAttempts);
  if (!Number.isFinite(maxAttempts) || maxAttempts <= 0) {
    return _args.runOnce(1);
  }

  let last: T | null = null;
  for (let attempt = 1; attempt <= Math.floor(maxAttempts); attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await _args.runOnce(attempt);
    last = res;
    if (res.ok) return res;

    const retryMs = parseCodeRabbitRateLimitRetryMs(`${res.stdout ?? ''}\n${res.stderr ?? ''}`);
    if (!retryMs) return res;
    if (attempt >= maxAttempts) return res;

    // eslint-disable-next-line no-await-in-loop
    await _args.sleepMs(retryMs);
  }

  return last ?? _args.runOnce(1);
}

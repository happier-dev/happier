/**
 * Restart backoff calculator.
 *
 * The daemon already has backoff/jitter semantics; this makes them reusable and testable.
 */

export function computeExponentialBackoffMs(params: Readonly<{
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
}>): number {
  const attempt = Math.max(1, Math.trunc(params.attempt));
  const base = Math.max(0, Math.trunc(params.baseDelayMs));
  const max = Math.max(base, Math.trunc(params.maxDelayMs));
  const exponential = base * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(max, Math.max(base, exponential));
  return Math.trunc(capped);
}

export function computeJitterMs(params: Readonly<{ jitterMs: number; random: () => number }>): number {
  const jitterMs = Math.max(0, Math.trunc(params.jitterMs));
  if (jitterMs <= 0) return 0;
  const r = params.random();
  const normalized = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
  return Math.floor(normalized * (jitterMs + 1));
}

export function computeRestartDelayMs(params: Readonly<{
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
  random: () => number;
}>): number {
  return (
    computeExponentialBackoffMs({
      attempt: params.attempt,
      baseDelayMs: params.baseDelayMs,
      maxDelayMs: params.maxDelayMs,
    }) + computeJitterMs({ jitterMs: params.jitterMs, random: params.random })
  );
}


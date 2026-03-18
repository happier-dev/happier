export function computeManagedConnectionBackoffMs(params: Readonly<{
  attempt: number;
  minMs: number;
  maxMs: number;
  jitterRatio: number;
  random?: () => number;
}>): number {
  const attempt = Math.max(1, Math.trunc(params.attempt));
  const minMs = Math.max(1, Math.trunc(params.minMs));
  const maxMs = Math.max(minMs, Math.trunc(params.maxMs));
  const jitterRatio = Math.min(1, Math.max(0, params.jitterRatio));
  const baseMs = Math.min(maxMs, minMs * Math.pow(2, Math.max(0, attempt - 1)));
  if (jitterRatio === 0) return baseMs;

  const random = params.random ?? Math.random;
  const normalized = Math.min(1, Math.max(0, random()));
  const factor = (1 - jitterRatio) + normalized * (2 * jitterRatio);
  return Math.max(1, Math.trunc(baseMs * factor));
}

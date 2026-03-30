/**
 * Read a positive integer from an environment variable.
 *
 * Returns `null` when the variable is unset, empty, or not a positive integer.
 * When a `fallback` is provided the return type narrows to `number` (the
 * fallback is returned instead of `null`).
 */
export function readPositiveIntEnv(name: string, fallback: number): number;
export function readPositiveIntEnv(name: string): number | null;
export function readPositiveIntEnv(name: string, fallback?: number): number | null {
  const raw = typeof process.env[name] === 'string' ? process.env[name]!.trim() : '';
  if (!raw) return fallback ?? null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback ?? null;
  return n;
}

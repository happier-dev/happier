const DEFAULT_CHECKPOINT_INTERVAL_MS = 1_000;
const DEFAULT_CHECKPOINT_MIN_CHARS = 128;

function resolveNonNegativeIntEnv(input: unknown, fallback: number): number {
  if (typeof input === 'number' && Number.isFinite(input) && input >= 0) return Math.trunc(input);
  const raw = (input ?? '').toString().trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.trunc(parsed);
}

export function resolveCheckpointIntervalMs(input: unknown): number {
  return resolveNonNegativeIntEnv(
    input ?? process.env.HAPPIER_STREAM_CHECKPOINT_MS,
    DEFAULT_CHECKPOINT_INTERVAL_MS,
  );
}

export function resolveCheckpointMinChars(input: unknown): number {
  return resolveNonNegativeIntEnv(
    input ?? process.env.HAPPIER_STREAM_CHECKPOINT_MIN_CHARS,
    DEFAULT_CHECKPOINT_MIN_CHARS,
  );
}

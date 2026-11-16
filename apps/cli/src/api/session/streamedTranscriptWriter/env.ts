import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';

const DEFAULT_INITIAL_CHECKPOINT_DELAY_MS = 500;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 2_000;
const DEFAULT_CHECKPOINT_MIN_CHARS = 256;
const DEFAULT_LIVE_SNAPSHOT_INTERVAL_MS = 40;
const DEFAULT_LIVE_SNAPSHOT_MIN_CHARS = 1;

function resolveNonNegativeIntEnv(input: unknown, fallback: number): number {
  if (typeof input === 'number' && Number.isFinite(input) && input >= 0) return Math.trunc(input);
  const raw = (input ?? '').toString().trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.trunc(parsed);
}

export function resolveInitialCheckpointDelayMs(input: unknown): number {
  return resolveNonNegativeIntEnv(
    input ?? sessionProcessEnvironment().HAPPIER_STREAM_INITIAL_CHECKPOINT_MS,
    DEFAULT_INITIAL_CHECKPOINT_DELAY_MS,
  );
}

export function resolveCheckpointIntervalMs(input: unknown): number {
  return resolveNonNegativeIntEnv(
    input ?? sessionProcessEnvironment().HAPPIER_STREAM_CHECKPOINT_MS,
    DEFAULT_CHECKPOINT_INTERVAL_MS,
  );
}

export function resolveCheckpointMinChars(input: unknown): number {
  return resolveNonNegativeIntEnv(
    input ?? sessionProcessEnvironment().HAPPIER_STREAM_CHECKPOINT_MIN_CHARS,
    DEFAULT_CHECKPOINT_MIN_CHARS,
  );
}

export function resolveLiveSnapshotIntervalMs(input: unknown): number {
  return resolveNonNegativeIntEnv(
    input ?? sessionProcessEnvironment().HAPPIER_STREAM_LIVE_INTERVAL_MS,
    DEFAULT_LIVE_SNAPSHOT_INTERVAL_MS,
  );
}

export function resolveLiveSnapshotMinChars(input: unknown): number {
  return resolveNonNegativeIntEnv(
    input ?? sessionProcessEnvironment().HAPPIER_STREAM_LIVE_MIN_CHARS,
    DEFAULT_LIVE_SNAPSHOT_MIN_CHARS,
  );
}

/**
 * Whether live emissions after a segment's first snapshot carry only the appended text. Full
 * snapshots are sent only when a segment opens, its text is rewritten, a live send fails, or the
 * connection epoch changes; receivers recover a gap from the durable message revision instead of
 * a periodic full checkpoint. `HAPPIER_STREAM_LIVE_DELTAS=0` sends every live emission as a full
 * snapshot (the pre-delta behavior).
 */
export function resolveLiveDeltasEnabled(input: unknown): boolean {
  if (typeof input === 'boolean') return input;
  const raw = (sessionProcessEnvironment().HAPPIER_STREAM_LIVE_DELTAS ?? '').toString().trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

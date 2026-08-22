function readPositiveIntEnvMs(key: string, fallback: number, opts?: Readonly<{ min?: number; max?: number }>): number {
  const raw = String(process.env[key] ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  const min = typeof opts?.min === 'number' ? opts.min : 1;
  const max = typeof opts?.max === 'number' ? opts.max : Number.MAX_SAFE_INTEGER;
  if (parsed < min) return fallback;
  return Math.min(max, Math.trunc(parsed));
}

const DEFAULT_SOCKET_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_SOCKET_ACK_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_WAIT_IDLE_CONFIRM_MS = 250;
const DEFAULT_SESSION_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_STOP_POLL_INTERVAL_MS = 200;
const DEFAULT_SESSION_CRITICAL_METADATA_DRAIN_TIMEOUT_MS = 3_000;
const DEFAULT_SESSION_MESSAGE_ADMISSION_TIMEOUT_MS = 30_000;

export function resolveSessionControlSocketConnectTimeoutMs(): number {
  return readPositiveIntEnvMs('HAPPIER_SESSION_SOCKET_CONNECT_TIMEOUT_MS', DEFAULT_SOCKET_CONNECT_TIMEOUT_MS, { min: 1, max: 60_000 });
}

export function resolveSessionControlSocketAckTimeoutMs(): number {
  return readPositiveIntEnvMs('HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS', DEFAULT_SOCKET_ACK_TIMEOUT_MS, { min: 1, max: 60_000 });
}

export function resolveSessionControlWaitIdleConfirmMs(): number {
  return readPositiveIntEnvMs(
    'HAPPIER_SESSION_WAIT_IDLE_CONFIRM_MS',
    DEFAULT_SESSION_WAIT_IDLE_CONFIRM_MS,
    { min: 1, max: 5_000 },
  );
}

export function resolveSessionControlStopTimeoutMs(): number {
  return readPositiveIntEnvMs('HAPPIER_SESSION_STOP_TIMEOUT_MS', DEFAULT_SESSION_STOP_TIMEOUT_MS, { min: 1, max: 60_000 });
}

/**
 * Budget for taking a user message into CANONICAL DURABLE CUSTODY — the
 * enqueue/acknowledge round trip, not a provider turn and not the session-stop
 * window. Raising the stop budget for a slow machine must not silently change
 * how long admission waits, and lowering it must not truncate admission, so
 * this is its own boundary with its own override.
 *
 * When it fires the message is not in custody: the caller reports that
 * truthfully (the Agent transition returns `input_admission_failed`, whose
 * recovery is an idempotent re-admission by the same `localId`) rather than
 * assuming either outcome.
 */
export function resolveSessionMessageAdmissionTimeoutMs(): number {
  return readPositiveIntEnvMs(
    'HAPPIER_SESSION_MESSAGE_ADMISSION_TIMEOUT_MS',
    DEFAULT_SESSION_MESSAGE_ADMISSION_TIMEOUT_MS,
    { min: 1, max: 600_000 },
  );
}

export function resolveSessionControlStopPollIntervalMs(): number {
  return readPositiveIntEnvMs(
    'HAPPIER_SESSION_STOP_POLL_INTERVAL_MS',
    DEFAULT_SESSION_STOP_POLL_INTERVAL_MS,
    { min: 1, max: 5_000 },
  );
}

export function resolveSessionCriticalMetadataDrainTimeoutMs(): number {
  return readPositiveIntEnvMs(
    'HAPPIER_SESSION_CRITICAL_METADATA_DRAIN_TIMEOUT_MS',
    DEFAULT_SESSION_CRITICAL_METADATA_DRAIN_TIMEOUT_MS,
    { min: 1, max: 30_000 },
  );
}

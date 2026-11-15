import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';

function readPositiveIntEnvMs(key: string, fallback: number): number {
  const raw = String(sessionProcessEnvironment()[key] ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 1) return fallback;
  return Math.trunc(parsed);
}

const DEFAULT_SOCKET_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_SOCKET_ACK_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_WAIT_IDLE_CONFIRM_MS = 250;
const DEFAULT_SESSION_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_STOP_POLL_INTERVAL_MS = 200;
const DEFAULT_SESSION_CRITICAL_METADATA_DRAIN_TIMEOUT_MS = 3_000;
const DEFAULT_SESSION_MESSAGE_ADMISSION_TIMEOUT_MS = 30_000;

export function resolveSessionControlSocketConnectTimeoutMs(): number {
  return readPositiveIntEnvMs('HAPPIER_SESSION_SOCKET_CONNECT_TIMEOUT_MS', DEFAULT_SOCKET_CONNECT_TIMEOUT_MS);
}

export function resolveSessionControlSocketAckTimeoutMs(): number {
  return readPositiveIntEnvMs('HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS', DEFAULT_SOCKET_ACK_TIMEOUT_MS);
}

export function resolveSessionControlWaitIdleConfirmMs(): number {
  return readPositiveIntEnvMs(
    'HAPPIER_SESSION_WAIT_IDLE_CONFIRM_MS',
    DEFAULT_SESSION_WAIT_IDLE_CONFIRM_MS,
  );
}

export function resolveSessionControlStopTimeoutMs(): number {
  return readPositiveIntEnvMs('HAPPIER_SESSION_STOP_TIMEOUT_MS', DEFAULT_SESSION_STOP_TIMEOUT_MS);
}

/**
 * Budget for taking a user message into CANONICAL DURABLE CUSTODY — the
 * enqueue/acknowledge round trip, not a provider turn and not the session-stop
 * window. Raising the stop budget for a slow machine must not silently change
 * how long admission waits, and lowering it must not truncate admission, so
 * this is its own boundary with its own override.
 *
 * Expiry means custody was not confirmed; the write may already have committed.
 * Retain that unknown outcome (the Agent transition returns
 * `input_admission_failed`) and recover through the same `localId`, rather than
 * assuming the input was absent or creating a replacement.
 */
export function resolveSessionMessageAdmissionTimeoutMs(): number {
  return readPositiveIntEnvMs(
    'HAPPIER_SESSION_MESSAGE_ADMISSION_TIMEOUT_MS',
    DEFAULT_SESSION_MESSAGE_ADMISSION_TIMEOUT_MS,
  );
}

export function resolveSessionControlStopPollIntervalMs(): number {
  return readPositiveIntEnvMs(
    'HAPPIER_SESSION_STOP_POLL_INTERVAL_MS',
    DEFAULT_SESSION_STOP_POLL_INTERVAL_MS,
  );
}

export function resolveSessionCriticalMetadataDrainTimeoutMs(): number {
  return readPositiveIntEnvMs(
    'HAPPIER_SESSION_CRITICAL_METADATA_DRAIN_TIMEOUT_MS',
    DEFAULT_SESSION_CRITICAL_METADATA_DRAIN_TIMEOUT_MS,
  );
}

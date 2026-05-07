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
const DEFAULT_SESSION_ARCHIVE_METADATA_TIMEOUT_MS = 3_000;
const DEFAULT_SESSION_CRITICAL_METADATA_DRAIN_TIMEOUT_MS = 3_000;

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

export function resolveSessionControlStopPollIntervalMs(): number {
  return readPositiveIntEnvMs(
    'HAPPIER_SESSION_STOP_POLL_INTERVAL_MS',
    DEFAULT_SESSION_STOP_POLL_INTERVAL_MS,
    { min: 1, max: 5_000 },
  );
}

export function resolveSessionArchiveMetadataTimeoutMs(): number {
  return readPositiveIntEnvMs(
    'HAPPIER_SESSION_ARCHIVE_METADATA_TIMEOUT_MS',
    DEFAULT_SESSION_ARCHIVE_METADATA_TIMEOUT_MS,
    { min: 1, max: 30_000 },
  );
}

export function resolveSessionCriticalMetadataDrainTimeoutMs(): number {
  return readPositiveIntEnvMs(
    'HAPPIER_SESSION_CRITICAL_METADATA_DRAIN_TIMEOUT_MS',
    DEFAULT_SESSION_CRITICAL_METADATA_DRAIN_TIMEOUT_MS,
    { min: 1, max: 30_000 },
  );
}

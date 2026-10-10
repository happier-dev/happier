export type DaemonLockRecord = Readonly<{
  t: 'happier_daemon_lock_v2';
  pid: number;
  ownerToken: string;
  processStartedAtMs: number;
  processInstanceFingerprint?: string;
  createdAtMs: number;
}>;
export type DaemonLockSnapshot = Readonly<{
  raw: string;
  pid: number | null;
  record: DaemonLockRecord | null;
}>;

const RECORD_KEYS = new Set(['t', 'pid', 'ownerToken', 'processStartedAtMs', 'processInstanceFingerprint', 'createdAtMs']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const isNonNegativeInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function parseDaemonLockRecord(value: unknown): DaemonLockRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !RECORD_KEYS.has(key))) return null;
  if (v.t !== 'happier_daemon_lock_v2' || !isNonNegativeInt(v.pid) || v.pid === 0) return null;
  if (typeof v.ownerToken !== 'string' || !UUID.test(v.ownerToken)) return null;
  if (!isNonNegativeInt(v.processStartedAtMs) || !isNonNegativeInt(v.createdAtMs)) return null;
  const fingerprint = v.processInstanceFingerprint;
  if (fingerprint !== undefined && (typeof fingerprint !== 'string' || fingerprint.trim().length < 1 || fingerprint.trim().length > 512)) return null;
  return {
    t: v.t, pid: v.pid, ownerToken: v.ownerToken, processStartedAtMs: v.processStartedAtMs, createdAtMs: v.createdAtMs,
    ...(fingerprint === undefined ? {} : { processInstanceFingerprint: fingerprint.trim() }),
  };
}

/** Shared lock ingress; a predecessor PID never grants structured identity. */
export function parseDaemonLockSnapshot(raw: string): DaemonLockSnapshot {
  try {
    const record = parseDaemonLockRecord(JSON.parse(raw) as unknown);
    if (record) return { raw, pid: record.pid, record };
  } catch { }
  // The inspected ../0.2 persistence writer emits String(process.pid).
  const legacyPid = /^\s*[1-9]\d*\s*$/u.test(raw) ? Number(raw.trim()) : null;
  return { raw, pid: legacyPid !== null && Number.isSafeInteger(legacyPid) ? legacyPid : null, record: null };
}

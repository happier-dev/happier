import psList from 'ps-list';

export type ProcessSnapshotEntry = Awaited<ReturnType<typeof psList>>[number];

type ListProcessSnapshotOptions = Readonly<{
  ttlMs?: number;
  nowMs?: () => number;
  psListImpl?: () => Promise<readonly ProcessSnapshotEntry[]>;
}>;

const DEFAULT_PROCESS_SNAPSHOT_TTL_MS = 1_000;

let cachedSnapshot: Readonly<{ capturedAtMs: number; processes: readonly ProcessSnapshotEntry[] }> | null = null;
let inFlightSnapshot: Promise<readonly ProcessSnapshotEntry[]> | null = null;

export async function listProcessSnapshot({
  ttlMs = DEFAULT_PROCESS_SNAPSHOT_TTL_MS,
  nowMs = Date.now,
  psListImpl = psList,
}: ListProcessSnapshotOptions = {}): Promise<readonly ProcessSnapshotEntry[]> {
  const ttl = Math.max(0, Math.floor(ttlMs));
  const now = nowMs();

  if (ttl > 0 && cachedSnapshot && now - cachedSnapshot.capturedAtMs <= ttl) {
    return cachedSnapshot.processes;
  }

  if (inFlightSnapshot) {
    return await inFlightSnapshot;
  }

  const snapshot = Promise.resolve()
    .then(() => psListImpl())
    .then((processes) => {
      const capturedAtMs = nowMs();
      cachedSnapshot = { capturedAtMs, processes };
      return processes;
    });

  inFlightSnapshot = snapshot;
  try {
    return await snapshot;
  } finally {
    if (inFlightSnapshot === snapshot) {
      inFlightSnapshot = null;
    }
  }
}

export function clearProcessSnapshotCacheForTests(): void {
  cachedSnapshot = null;
  inFlightSnapshot = null;
}

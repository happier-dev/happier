/** Canonical settlement policy for accept-then-async session spawning. */

export type SpawnSessionNonceResolution =
  | { status: 'success'; sessionId: string }
  | { status: 'pending' }
  | { status: 'not_found' }
  | { status: 'unsupported' };

export type SettleSpawnSessionNonceResult =
  | { status: 'success'; sessionId: string }
  | { status: 'timeout' }
  | { status: 'not_found' }
  | { status: 'unsupported' };

const DEFAULT_NOT_FOUND_GRACE_MS = 15_000;

/** Canonical boundary reader shared by local and machine-RPC nonce settlement. */
export function normalizeSpawnSessionNonceResolution(value: unknown): SpawnSessionNonceResolution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'not_found' };
  const record = value as Readonly<Record<string, unknown>>;
  const status = typeof record.status === 'string' ? record.status.trim() : '';
  if (status === 'pending' || status === 'not_found' || status === 'unsupported') {
    return { status };
  }
  if (status === 'success') {
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
    return sessionId ? { status: 'success', sessionId } : { status: 'not_found' };
  }
  return { status: 'not_found' };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function settleSpawnSessionNonce(params: Readonly<{
  spawnNonce: string;
  resolve: (spawnNonce: string) => Promise<SpawnSessionNonceResolution>;
  timeoutMs: number;
  pollIntervalMs: number;
  notFoundGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}>): Promise<SettleSpawnSessionNonceResult> {
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? defaultSleep;
  const pollIntervalMs = Math.max(1, Math.trunc(params.pollIntervalMs));
  const notFoundGraceMs = Math.max(0, Math.trunc(params.notFoundGraceMs ?? DEFAULT_NOT_FOUND_GRACE_MS));
  const deadlineMs = now() + Math.max(0, Math.trunc(params.timeoutMs));
  let notFoundSinceMs: number | null = null;

  while (true) {
    let resolution: SpawnSessionNonceResolution;
    try {
      resolution = await params.resolve(params.spawnNonce);
    } catch {
      resolution = { status: 'not_found' };
    }

    if (resolution.status === 'success') {
      const sessionId = typeof resolution.sessionId === 'string' ? resolution.sessionId.trim() : '';
      if (sessionId) return { status: 'success', sessionId };
    }
    if (resolution.status === 'unsupported') return { status: 'unsupported' };

    const nowMs = now();
    if (resolution.status === 'not_found') {
      notFoundSinceMs ??= nowMs;
      if (nowMs - notFoundSinceMs >= notFoundGraceMs) return { status: 'not_found' };
    } else {
      notFoundSinceMs = null;
    }
    if (nowMs >= deadlineMs) return { status: 'timeout' };
    await sleep(pollIntervalMs);
  }
}

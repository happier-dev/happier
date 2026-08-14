import type { SpawnSessionNonceResolution } from '@happier-dev/protocol';

import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

type AcceptedSpawnResult = Extract<SpawnSessionResult, { type: 'success' }>;
type TerminalSpawnResult =
  | (AcceptedSpawnResult & Readonly<{ sessionId: string }>)
  | Extract<SpawnSessionResult, { type: 'error' }>;

type SpawnAttemptRecord = Readonly<{
  result: AcceptedSpawnResult | TerminalSpawnResult;
  terminal: boolean;
  expiresAtMs: number;
}>;

function normalizeSpawnNonce(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSessionId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && !/^PID-\d+$/.test(normalized) ? normalized : '';
}

function isTerminalResult(result: SpawnSessionResult): result is TerminalSpawnResult {
  return result.type === 'error'
    || (result.type === 'success' && normalizeSessionId(result.sessionId).length > 0);
}

export type DaemonSpawnAttemptRegistry = Readonly<{
  rememberAccepted: (params: Readonly<{
    spawnNonce?: string;
    result: AcceptedSpawnResult;
  }>) => void;
  settle: (spawnNonce: string, result: SpawnSessionResult) => void;
  replay: (spawnNonce: string) => SpawnSessionResult | null;
  resolve: (spawnNonce: string) => SpawnSessionNonceResolution;
}>;

/**
 * Canonical daemon-process owner for accepted spawn nonce lifecycle.
 *
 * The registry stores the first terminal webhook outcome so every in-process
 * retry and the control-server nonce resolver observe the same result. It does
 * not own webhook timeouts; the existing spawn waiter settles this owner.
 */
export function createDaemonSpawnAttemptRegistry(params: Readonly<{
  ttlMs: number;
  now?: () => number;
}>): DaemonSpawnAttemptRegistry {
  const now = params.now ?? Date.now;
  const ttlMs = Math.max(1, Math.trunc(params.ttlMs));
  const records = new Map<string, SpawnAttemptRecord>();

  const prune = (nowMs: number): void => {
    for (const [spawnNonce, record] of records) {
      if (record.expiresAtMs <= nowMs) records.delete(spawnNonce);
    }
  };

  const read = (spawnNonce: string): SpawnAttemptRecord | null => {
    const normalizedSpawnNonce = normalizeSpawnNonce(spawnNonce);
    if (!normalizedSpawnNonce) return null;
    const nowMs = now();
    prune(nowMs);
    return records.get(normalizedSpawnNonce) ?? null;
  };

  return {
    rememberAccepted: ({ spawnNonce, result }) => {
      const normalizedSpawnNonce = normalizeSpawnNonce(spawnNonce);
      if (!normalizedSpawnNonce) return;
      const nowMs = now();
      prune(nowMs);
      const current = records.get(normalizedSpawnNonce);
      if (current?.terminal) return;
      records.set(normalizedSpawnNonce, {
        result,
        terminal: isTerminalResult(result),
        expiresAtMs: nowMs + ttlMs,
      });
    },
    settle: (spawnNonce, result) => {
      const normalizedSpawnNonce = normalizeSpawnNonce(spawnNonce);
      if (!normalizedSpawnNonce || !isTerminalResult(result)) return;
      const nowMs = now();
      prune(nowMs);
      const current = records.get(normalizedSpawnNonce);
      if (!current || current.terminal) return;
      records.set(normalizedSpawnNonce, {
        ...current,
        result,
        terminal: true,
        expiresAtMs: nowMs + ttlMs,
      });
    },
    replay: (spawnNonce) => {
      const normalizedSpawnNonce = normalizeSpawnNonce(spawnNonce);
      const record = read(normalizedSpawnNonce);
      if (!record) return null;
      if (record.result.type === 'error') return record.result;
      const sessionId = normalizeSessionId(record.result.sessionId);
      return {
        type: 'success',
        ...(sessionId ? { sessionId } : { sessionIdStatus: 'pending' as const }),
        spawnNonce: normalizedSpawnNonce,
        runnerAcceptance: 'same_request_runner',
      };
    },
    resolve: (spawnNonce) => {
      const record = read(spawnNonce);
      if (!record) return { status: 'not_found' };
      if (record.result.type === 'error') {
        return {
          status: 'error',
          errorCode: record.result.errorCode,
          errorMessage: record.result.errorMessage,
          ...(record.result.errorDetail ? { errorDetail: record.result.errorDetail } : {}),
        };
      }
      const sessionId = normalizeSessionId(record.result.sessionId);
      return sessionId
        ? { status: 'success', sessionId }
        : { status: 'pending' };
    },
  };
}

import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 } from '@happier-dev/protocol/runtime';

export type AgentSessionPreAdmissionBufferResult =
  | Readonly<{ status: 'accepted' }>
  | Readonly<{ status: 'overflow'; reason: 'count' | 'bytes' }>
  | Readonly<{ status: 'invalid' }>
  | Readonly<{ status: 'disposed' }>;

export type AgentSessionPreAdmissionBuffer<T> = Readonly<{
  admit(value: T): AgentSessionPreAdmissionBufferResult;
  drain(): readonly T[];
  dispose(): Readonly<{ discardedItems: number; discardedJsonBytes: number }>;
}>;

const LIMITS = AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates;
const encoder = new TextEncoder();

function measureJsonBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : encoder.encode(serialized).byteLength;
  } catch {
    return null;
  }
}

/**
 * Host-private RA21 candidate admission shared by native Agent pre-custody queues.
 * It owns no lifecycle policy: callers still decide how overflow terminates their
 * provider operation, while this owner guarantees accepted entries are never evicted.
 */
export function createAgentSessionPreAdmissionBuffer<T>(): AgentSessionPreAdmissionBuffer<T> {
  let entries: Array<Readonly<{ value: T; jsonBytes: number }>> = [];
  let totalJsonBytes = 0;
  let disposed = false;

  return Object.freeze({
    admit(value): AgentSessionPreAdmissionBufferResult {
      if (disposed) return { status: 'disposed' };
      const jsonBytes = measureJsonBytes(value);
      if (jsonBytes === null) return { status: 'invalid' };
      if (entries.length + 1 > LIMITS.preWatchReplayBufferMaxEvents) {
        return { status: 'overflow', reason: 'count' };
      }
      if (totalJsonBytes + jsonBytes > LIMITS.preWatchReplayBufferMaxJsonBytes) {
        return { status: 'overflow', reason: 'bytes' };
      }
      entries.push(Object.freeze({ value, jsonBytes }));
      totalJsonBytes += jsonBytes;
      return { status: 'accepted' };
    },
    drain(): readonly T[] {
      if (disposed || entries.length === 0) return [];
      const values = entries.map((entry) => entry.value);
      entries = [];
      totalJsonBytes = 0;
      return values;
    },
    dispose() {
      if (disposed) return { discardedItems: 0, discardedJsonBytes: 0 };
      disposed = true;
      const result = Object.freeze({
        discardedItems: entries.length,
        discardedJsonBytes: totalJsonBytes,
      });
      entries = [];
      totalJsonBytes = 0;
      return result;
    },
  });
}

import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 } from '@happier-dev/protocol/runtime';

const COMPLETION_REPLAY_LIMITS =
  AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates;
const encoder = new TextEncoder();

function measureJsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

/**
 * Host-internal completion replay guard pending RA21 traffic/platform
 * measurement. This cache preserves exact settlements only until the daemon
 * acknowledges them; it is distinct from the pre-watch runtime event buffer.
 */
export class AgentRuntimeBridgeCompletionReplayCache<T> {
  readonly #completed = new Map<string, Readonly<{
    value: T;
    jsonBytes: number;
  }>>();
  #jsonBytes = 0;

  get(effectId: string): T | undefined {
    return this.#completed.get(effectId)?.value;
  }

  remember(effectId: string, value: T): void {
    const previous = this.#completed.get(effectId);
    if (previous) this.#jsonBytes -= previous.jsonBytes;
    const jsonBytes = measureJsonBytes(value);
    this.#completed.set(effectId, { value, jsonBytes });
    this.#jsonBytes += jsonBytes;
    while (
      this.#completed.size
        > COMPLETION_REPLAY_LIMITS.completionReplayCacheMaxEntries
      || this.#jsonBytes
        > COMPLETION_REPLAY_LIMITS.completionReplayCacheMaxJsonBytes
    ) {
      const oldest = this.#completed.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.forget(oldest);
    }
  }

  forget(effectId: string): void {
    const completion = this.#completed.get(effectId);
    if (!completion) return;
    this.#jsonBytes -= completion.jsonBytes;
    this.#completed.delete(effectId);
  }
}

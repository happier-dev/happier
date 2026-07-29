import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 } from '@happier-dev/protocol/runtime';
import { describe, expect, it } from 'vitest';

import { AgentRuntimeBridgeCompletionReplayCache } from './agentRuntimeBridgeCompletionReplayCache';

const LIMITS =
  AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates;

describe('Agent runtime bridge completion replay cache', () => {
  it('retains the exact entry capacity and evicts the oldest at +1', () => {
    const cache = new AgentRuntimeBridgeCompletionReplayCache<number>();

    for (
      let index = 0;
      index < LIMITS.completionReplayCacheMaxEntries;
      index += 1
    ) {
      cache.remember(`effect-${index}`, index);
    }
    expect(cache.get('effect-0')).toBe(0);
    expect(cache.get(
      `effect-${LIMITS.completionReplayCacheMaxEntries - 1}`,
    )).toBe(LIMITS.completionReplayCacheMaxEntries - 1);

    cache.remember('effect-overflow', 1);

    expect(cache.get('effect-0')).toBeUndefined();
    expect(cache.get('effect-1')).toBe(1);
    expect(cache.get('effect-overflow')).toBe(1);
  });

  it('does not refresh an existing settlement eviction age', () => {
    const cache = new AgentRuntimeBridgeCompletionReplayCache<number>();

    for (
      let index = 0;
      index < LIMITS.completionReplayCacheMaxEntries;
      index += 1
    ) {
      cache.remember(`effect-${index}`, index);
    }
    cache.remember('effect-0', 42);
    cache.remember('effect-overflow', 1);

    expect(cache.get('effect-0')).toBeUndefined();
    expect(cache.get('effect-1')).toBe(1);
    expect(cache.get('effect-overflow')).toBe(1);
  });

  it('retains an exact-byte settlement and evicts it at +1 byte', () => {
    const cache = new AgentRuntimeBridgeCompletionReplayCache<string>();
    const emptyJsonBytes = new TextEncoder().encode(JSON.stringify(''))
      .byteLength;
    const exact = 'x'.repeat(
      LIMITS.completionReplayCacheMaxJsonBytes - emptyJsonBytes,
    );

    cache.remember('exact', exact);
    expect(cache.get('exact')).toBe(exact);

    cache.remember('over', `${exact}x`);
    expect(cache.get('exact')).toBeUndefined();
    expect(cache.get('over')).toBeUndefined();
  });
});

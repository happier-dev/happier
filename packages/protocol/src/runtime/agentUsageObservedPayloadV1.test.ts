import { describe, expect, it } from 'vitest';
import { AgentUsageObservedPayloadV1Schema } from './agentUsageObservedPayloadV1.js';
import { AgentSessionRuntimeEventV1Schema } from './agentSessionV1.js';

describe('shared usage observation payload', () => {
  it.each([
    { scope: 'session_cumulative', accounting: { nativeSessionId: 'child-native' } },
    { scope: 'turn_delta', accounting: { nativeSessionId: 'parent-native', inferenceId: 'inference-without-cache-split' } },
  ])('retains native identity with unknown measurements: $scope', (identity) => {
    const payload = { kind: 'usage-observed', observationId: 'observation',
      source: 'muse-native-accounting', ...identity };
    const event = { ...payload, sequence: 1, sessionId: 'host-session', emittedAtMs: 10 };

    expect(AgentUsageObservedPayloadV1Schema.parse(payload)).toEqual(payload);
    expect(AgentSessionRuntimeEventV1Schema.parse(event)).toEqual(event);
    for (const parsed of [AgentUsageObservedPayloadV1Schema.parse(payload), AgentSessionRuntimeEventV1Schema.parse(event)]) {
      if (parsed.kind !== 'usage-observed') throw new Error('Expected usage observation');
      expect(parsed).not.toHaveProperty('tokens');
      expect(parsed).not.toHaveProperty('cost');
      expect(parsed).not.toHaveProperty('turnId');
      expect(parsed.accounting).not.toHaveProperty('inputIncludesCache');
      expect(parsed.accounting).not.toHaveProperty('outputIncludesReasoning');
    }
    // Carriers add their own envelope; it cannot leak into the common payload.
    expect(AgentUsageObservedPayloadV1Schema.safeParse(event).success).toBe(false);
  });

  it('rejects empty evidence and incomplete counters rather than supplying zeros', () => {
    const payload = { kind: 'usage-observed', observationId: 'observation', source: 'muse-native-accounting', scope: 'turn_delta' };
    for (const accounting of [undefined, {}, { nativeSessionId: '' }, { inferenceId: 'inference-only' }]) {
      expect(AgentUsageObservedPayloadV1Schema.safeParse({ ...payload, accounting }).success).toBe(false);
    }
    const identity = { ...payload, accounting: { nativeSessionId: 'native' } };
    expect(AgentUsageObservedPayloadV1Schema.safeParse({ ...identity, tokens: { input: 10, output: 2 } }).success).toBe(false);
    const measuredZero = { ...identity, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    expect(AgentUsageObservedPayloadV1Schema.parse(measuredZero)).toEqual(measuredZero);
  });
});

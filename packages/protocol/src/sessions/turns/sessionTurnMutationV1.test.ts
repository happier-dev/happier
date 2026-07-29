import { describe, expect, it } from 'vitest';

import {
  ExactSessionTurnEndMutationV1Schema,
  SessionTurnMutationV1Schema,
  isExactSessionTurnMutationPositiveReceiptV1,
} from './sessionTurnMutationV1.js';

const exactEnd = {
  v: 1 as const,
  sessionId: 'session-1',
  mutationId: 'daemon-exit:session-1:turn-1',
  action: 'end_session' as const,
  turnId: 'turn-1',
  observedAt: 100,
};

describe('exact session turn end mutation v1', () => {
  it('requires an exact turn and forbids agent-owned metadata', () => {
    expect(ExactSessionTurnEndMutationV1Schema.safeParse(exactEnd).success).toBe(true);
    expect(ExactSessionTurnEndMutationV1Schema.safeParse({ ...exactEnd, turnId: undefined }).success).toBe(false);
    expect(ExactSessionTurnEndMutationV1Schema.safeParse({ ...exactEnd, agentId: 'claude' }).success).toBe(false);
    expect(ExactSessionTurnEndMutationV1Schema.safeParse({ ...exactEnd, agentTurnId: 'agent-turn-1' }).success).toBe(false);

    expect(SessionTurnMutationV1Schema.safeParse({ ...exactEnd, agentId: 'claude' }).success).toBe(false);
    expect(SessionTurnMutationV1Schema.safeParse({ ...exactEnd, agentTurnId: 'agent-turn-1' }).success).toBe(false);
  });

  it('accepts only a matching positive semantic receipt', () => {
    const receipt = {
      ...exactEnd,
      decision: 'applied' as const,
      appliedAt: 101,
    };

    expect(isExactSessionTurnMutationPositiveReceiptV1(exactEnd, receipt)).toBe(true);
    expect(isExactSessionTurnMutationPositiveReceiptV1(exactEnd, { ...receipt, decision: 'duplicate-terminal' })).toBe(true);

    for (const rejected of [
      { ok: true },
      { ...receipt, sessionId: 'session-2' },
      { ...receipt, mutationId: 'other-mutation' },
      { ...receipt, turnId: 'turn-2' },
      { ...receipt, observedAt: 99 },
      { ...receipt, decision: 'duplicate-mutation' },
      { ...receipt, decision: 'missing-turn' },
      { ...receipt, decision: 'stale-in-progress' },
      { ...receipt, decision: 'stale-terminal' },
    ]) {
      expect(isExactSessionTurnMutationPositiveReceiptV1(exactEnd, rejected)).toBe(false);
    }
  });
});

describe('session turn provider checkpoint persistence contract', () => {
  const rollbackMutation = {
    v: 1 as const,
    sessionId: 'session-1',
    mutationId: 'rollback-boundary:turn-1',
    action: 'mark_rollback_eligible' as const,
    turnId: 'turn-1',
    observedAt: 100,
    transcriptAnchors: {
      startUserMessageSeq: 7,
      providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 3 },
    },
  };

  it('accepts the bounded checkpoint only at the canonical transcript-anchor owner', () => {
    expect(SessionTurnMutationV1Schema.safeParse(rollbackMutation).success).toBe(true);
    expect(SessionTurnMutationV1Schema.safeParse({
      ...rollbackMutation,
      providerCheckpoint: rollbackMutation.transcriptAnchors.providerCheckpoint,
    }).success).toBe(false);
  });

  it('rejects an oversized opaque checkpoint before persistence', () => {
    expect(SessionTurnMutationV1Schema.safeParse({
      ...rollbackMutation,
      transcriptAnchors: {
        ...rollbackMutation.transcriptAnchors,
        providerCheckpoint: { value: 'x'.repeat(4_097) },
      },
    }).success).toBe(false);
  });
});

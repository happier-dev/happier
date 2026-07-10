import { describe, expect, it } from 'vitest';

import {
  SessionTurnMutationReceiptV1Schema,
  SessionTurnMutationV1Schema,
  SessionTurnsProjectionV1Schema,
  SessionTurnV1Schema,
} from '../../index.js';

describe('SessionTurnV1 protocol', () => {
  const issue = {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'agent_status_error',
    source: 'agent_status_error',
    occurredAt: 30,
    sanitizedPreview: 'Provider reported an error',
  } as const;

  it('exports session turn schemas from the protocol root', () => {
    expect(typeof SessionTurnV1Schema.safeParse).toBe('function');
    expect(typeof SessionTurnMutationV1Schema.safeParse).toBe('function');
    expect(typeof SessionTurnMutationReceiptV1Schema.safeParse).toBe('function');
    expect(typeof SessionTurnsProjectionV1Schema.safeParse).toBe('function');
  });

  it('accepts session-owned turn ids separately from provider turn ids', () => {
    const parsed = SessionTurnMutationV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      mutationId: 'mutation-1',
      turnId: 'happier-turn-1',
      action: 'attach_agent_turn_id',
      provider: 'codex',
      agentTurnId: 'provider-turn-1',
      observedAt: 20,
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts transcript anchors on begin mutations', () => {
    const parsed = SessionTurnMutationV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      mutationId: 'mutation-1',
      turnId: 'happier-turn-1',
      action: 'begin',
      provider: 'codex',
      agentTurnId: 'provider-turn-1',
      observedAt: 20,
      transcriptAnchors: {
        startUserMessageSeq: 10,
        userMessageSeqs: [10],
        startSeqInclusive: 9,
        endSeqInclusive: null,
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts active turn touch mutations', () => {
    const parsed = SessionTurnMutationV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      mutationId: 'mutation-touch-1',
      turnId: 'happier-turn-1',
      action: 'touch_active',
      provider: 'claude',
      agentTurnId: 'provider-turn-1',
      observedAt: 250,
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects ids that exceed indexed storage width', () => {
    const oversized = 'x'.repeat(192);
    const parsed = SessionTurnMutationV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      mutationId: oversized,
      turnId: oversized,
      action: 'attach_agent_turn_id',
      provider: 'codex',
      agentTurnId: oversized,
      observedAt: 20,
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects session ids that exceed indexed storage width', () => {
    const parsed = SessionTurnMutationV1Schema.safeParse({
      v: 1,
      sessionId: 'x'.repeat(192),
      mutationId: 'mutation-1',
      turnId: 'happier-turn-1',
      action: 'begin',
      observedAt: 20,
    });

    expect(parsed.success).toBe(false);
  });

  it('bounds session turn cancel reasons', () => {
    const parsed = SessionTurnMutationV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      mutationId: 'mutation-1',
      turnId: 'happier-turn-1',
      action: 'cancel',
      reason: 'x'.repeat(257),
      observedAt: 20,
    });

    expect(parsed.success).toBe(false);
  });

  it('passes through additive transcript anchor fields', () => {
    const parsed = SessionTurnMutationV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      mutationId: 'mutation-1',
      turnId: 'happier-turn-1',
      action: 'append_transcript_anchors',
      transcriptAnchors: {
        startUserMessageSeq: 1,
        providerContinuationToken: 'anchor-v2',
      },
      observedAt: 20,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const anchors = parsed.data.transcriptAnchors as Record<string, unknown>;
      expect(anchors.providerContinuationToken).toBe('anchor-v2');
    }
  });

  it('rejects nullable provider turn ids on mutations', () => {
    const parsed = SessionTurnMutationV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      mutationId: 'mutation-1',
      turnId: 'happier-turn-1',
      action: 'attach_agent_turn_id',
      agentTurnId: null,
      observedAt: 20,
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects legacy remote-dev mutation aliases', () => {
    const parsed = SessionTurnMutationV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      mutationId: 'mutation-legacy',
      source: 'session_turn_lifecycle',
      turnId: 'happier-turn-1',
      action: 'fail',
      provider: 'codex',
      agentTurnId: 'provider-turn-1',
      lastRuntimeIssue: issue,
      observedAt: 20,
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects nested legacy rollback facts as authored input', () => {
    const parsed = SessionTurnMutationV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      mutationId: 'mutation-rollback',
      source: 'session_turn_lifecycle',
      turnId: 'happier-turn-1',
      action: 'mark_rollback_eligible',
      rollback: {
        state: 'eligible',
        reason: 'provider checkpoint',
        agentRollbackOrdinal: 2,
      },
      transcriptAnchors: {
        startUserMessageSeq: 10,
        endSeqInclusive: 20,
      },
      observedAt: 21,
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects contradictory legacy rollback state on non-rollback actions', () => {
    const parsed = SessionTurnMutationV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      mutationId: 'mutation-rollback',
      source: 'session_turn_lifecycle',
      turnId: 'happier-turn-1',
      action: 'complete',
      rollback: {
        state: 'eligible',
      },
      observedAt: 21,
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts sanitized failed turn rows with rollback facets', () => {
    const parsed = SessionTurnV1Schema.safeParse({
      turnId: 'happier-turn-1',
      provider: 'codex',
      agentTurnId: 'provider-turn-1',
      status: 'failed',
      startedAt: 10,
      updatedAt: 30,
      terminalAt: 30,
      lastRuntimeIssue: issue,
      rollback: {
        state: 'eligible',
        reason: 'provider checkpoint',
        agentRollbackOrdinal: 2,
        updatedAt: 31,
      },
      lastMutationId: 'mutation-2',
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts durable mutation receipts with observable decisions', () => {
    const parsed = SessionTurnMutationReceiptV1Schema.safeParse({
      v: 1,
      sessionId: 'session-1',
      mutationId: 'mutation-1',
      turnId: 'happier-turn-1',
      action: 'complete',
      decision: 'applied',
      observedAt: 20,
      appliedAt: 21,
    });

    expect(parsed.success).toBe(true);
  });
});

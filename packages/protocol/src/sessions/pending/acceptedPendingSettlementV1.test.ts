import { describe, expect, it } from 'vitest';

import { AcceptedPendingSettlementRequestV1Schema, AcceptedPendingSettlementResponseV1Schema } from './acceptedPendingSettlementV1';

describe('AcceptedPendingSettlementRequestV1Schema', () => {
  it('carries a clear host-stamped accepted turn identity beside encrypted delivery content', () => {
    expect(AcceptedPendingSettlementRequestV1Schema.parse({
      v: 1, sessionId: 'receiver', localId: 'input-1',
      acceptedDelivery: { t: 'encrypted', c: 'private-acceptance' },
      acceptedTurn: { kind: 'followUp', turnId: 'new-turn' },
    })).toMatchObject({ acceptedTurn: { kind: 'followUp', turnId: 'new-turn' } });
    expect(AcceptedPendingSettlementRequestV1Schema.safeParse({
      v: 1, sessionId: 'receiver', localId: 'input-1',
      acceptedTurn: { kind: 'followUp', turnId: '' },
    }).success).toBe(false);
    expect(AcceptedPendingSettlementRequestV1Schema.safeParse({
      v: 1, sessionId: 'receiver', localId: 'input-1',
      acceptedDelivery: { t: 'plain', v: { v: 1, acceptedAtMs: 1,
        delivery: { kind: 'newTurn', turnId: 'other-turn' } } },
      acceptedTurn: { kind: 'followUp', turnId: 'new-turn' },
    }).success).toBe(false);
  });
});

describe('AcceptedPendingSettlementResponseV1Schema', () => {
  it('carries an explicit publication prerequisite without inventing a transaction failure', () => {
    expect(AcceptedPendingSettlementResponseV1Schema.parse({
      ok: false, error: 'turn-publication-pending',
    })).toEqual({ ok: false, error: 'turn-publication-pending' });
  });

  it('accepts only a bounded typed transaction-unavailable retry response', () => {
    expect(AcceptedPendingSettlementResponseV1Schema.safeParse({
      ok: false,
      error: 'transaction-unavailable',
      retryAfterMs: 1_000,
      correlationId: 'accepted-settlement_1:retry',
    }).success).toBe(true);

    for (const response of [
      { ok: false, error: 'transaction-unavailable' },
      { ok: false, error: 'transaction-unavailable', retryAfterMs: -1 },
      { ok: false, error: 'transaction-unavailable', retryAfterMs: 1.5 },
      { ok: false, error: 'transaction-unavailable', retryAfterMs: 1_000, correlationId: 'contains spaces' },
      { ok: false, error: 'internal', retryAfterMs: 1_000 },
    ]) {
      expect(AcceptedPendingSettlementResponseV1Schema.safeParse(response).success).toBe(false);
    }
  });
});

import { describe, expect, it } from 'vitest';

import { AcceptedPendingSettlementResponseV1Schema } from './acceptedPendingSettlementV1';

describe('AcceptedPendingSettlementResponseV1Schema', () => {
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

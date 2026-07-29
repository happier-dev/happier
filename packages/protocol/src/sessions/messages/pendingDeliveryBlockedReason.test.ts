import { describe, expect, it } from 'vitest';

import {
  PENDING_DELIVERY_BLOCKED_REASONS,
  PendingDeliveryBlockedReasonSchema,
  normalizePendingDeliveryBlockedReason,
} from './pendingDeliveryBlockedReason.js';

describe('PendingDeliveryBlockedReasonSchema', () => {
  it('accepts every canonical pending-delivery blocked reason', () => {
    for (const reason of PENDING_DELIVERY_BLOCKED_REASONS) {
      expect(PendingDeliveryBlockedReasonSchema.safeParse(reason).success).toBe(true);
      expect(normalizePendingDeliveryBlockedReason(reason)).toBe(reason);
    }
  });

  it('includes current durable reasons for sustained terminal delivery blockers', () => {
    expect(PENDING_DELIVERY_BLOCKED_REASONS).toEqual(expect.arrayContaining([
      'terminal_composer_draft',
      'runtime_config_blocked',
      'unsupported_action',
    ]));
    expect(normalizePendingDeliveryBlockedReason('runtime_config_blocked')).toBe('runtime_config_blocked');
  });

  it('keeps capture-style rows parseable as legacy read-only blocked reasons', () => {
    expect(PENDING_DELIVERY_BLOCKED_REASONS).toContain('capture_style_unavailable');
    expect(normalizePendingDeliveryBlockedReason('capture_style_unavailable')).toBe('capture_style_unavailable');
  });

  it('accepts inherited provider claims with an uncertain outcome', () => {
    expect(PendingDeliveryBlockedReasonSchema.parse('delivery_outcome_uncertain')).toBe('delivery_outcome_uncertain');
    expect(normalizePendingDeliveryBlockedReason('delivery_outcome_uncertain')).toBe('delivery_outcome_uncertain');
  });

  it('rejects unknown or empty reason values', () => {
    expect(normalizePendingDeliveryBlockedReason('future_reason')).toBeNull();
    expect(normalizePendingDeliveryBlockedReason('')).toBeNull();
    expect(normalizePendingDeliveryBlockedReason(null)).toBeNull();
  });
});

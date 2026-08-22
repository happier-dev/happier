import { describe, expect, it } from 'vitest';

import {
  PendingDeliveryBlockedReasonSchema,
  isConditionalPendingSteerClaim,
  isPendingDeliveryBlockedReason,
  normalizePendingDeliveryBlockedReason,
  PENDING_DELIVERY_BLOCKED_REASONS,
} from './pendingDeliveryBlockedReason';

describe('pending delivery blocked reason contract', () => {
  it('accepts every published blocked reason', () => {
    for (const reason of PENDING_DELIVERY_BLOCKED_REASONS) {
      expect(PendingDeliveryBlockedReasonSchema.parse(reason)).toBe(reason);
      expect(isPendingDeliveryBlockedReason(reason)).toBe(true);
      expect(normalizePendingDeliveryBlockedReason(reason)).toBe(reason);
    }
  });

  it('accepts runtime config blockers as retryable pending delivery blocks', () => {
    expect(PendingDeliveryBlockedReasonSchema.parse('runtime_config_blocked')).toBe('runtime_config_blocked');
    expect(isPendingDeliveryBlockedReason('runtime_config_blocked')).toBe(true);
    expect(normalizePendingDeliveryBlockedReason('runtime_config_blocked')).toBe('runtime_config_blocked');
  });

  it('accepts the proven pre-effect steering-unavailable block', () => {
    expect(PendingDeliveryBlockedReasonSchema.parse('steering_unavailable')).toBe('steering_unavailable');
    expect(normalizePendingDeliveryBlockedReason('steering_unavailable')).toBe('steering_unavailable');
    expect(PendingDeliveryBlockedReasonSchema.parse('unsupported_action')).toBe('unsupported_action');
    expect(normalizePendingDeliveryBlockedReason('unsupported_action')).toBe('unsupported_action');
  });

  it('classifies only a conditional server steer claim as fallback-safe', () => {
    expect(isConditionalPendingSteerClaim({
      requestedAction: { v: 1, kind: 'steer_if_active' },
      providerAction: 'steer',
    })).toBe(true);
    expect(isConditionalPendingSteerClaim({
      requestedAction: { v: 1, kind: 'steer_now' },
      providerAction: 'steer',
    })).toBe(false);
    expect(isConditionalPendingSteerClaim({
      requestedAction: { v: 1, kind: 'steer_if_active' },
      providerAction: 'send',
    })).toBe(false);
    expect(PendingDeliveryBlockedReasonSchema.parse('conditional_steer_unavailable')).toBe(
      'conditional_steer_unavailable',
    );
  });

  it('accepts inherited provider claims with an uncertain outcome', () => {
    expect(PendingDeliveryBlockedReasonSchema.parse('delivery_outcome_uncertain')).toBe('delivery_outcome_uncertain');
    expect(normalizePendingDeliveryBlockedReason('delivery_outcome_uncertain')).toBe('delivery_outcome_uncertain');
  });

  it('rejects the retired provider-acceptance timeout reason after retained rows are contracted', () => {
    expect(PENDING_DELIVERY_BLOCKED_REASONS).not.toContain('provider_acceptance_timeout');
    expect(isPendingDeliveryBlockedReason('provider_acceptance_timeout')).toBe(false);
    expect(normalizePendingDeliveryBlockedReason('provider_acceptance_timeout')).toBeNull();
  });

  it('rejects missing and future blocked reasons', () => {
    expect(isPendingDeliveryBlockedReason('future_reason')).toBe(false);
    expect(normalizePendingDeliveryBlockedReason('future_reason')).toBeNull();
    expect(normalizePendingDeliveryBlockedReason(null)).toBeNull();
  });
});

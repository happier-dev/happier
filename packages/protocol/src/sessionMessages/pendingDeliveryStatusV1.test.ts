import { describe, expect, it } from 'vitest';

import {
  isPendingDeliveryProviderEffectPossibleV1,
  isPendingDeliveryStatusTransitionAllowedV1,
  normalizePendingDeliveryStatusV1,
  parsePendingDeliveryStatusV1,
  shouldExposePendingDeliveryInDiscardedHistoryV1,
  pendingDeliveryStatusV1ToPersistedFields,
  type PendingDeliveryStatusTransitionTargetV1,
  type PendingDeliveryStatusV1,
} from './pendingDeliveryStatusV1';

describe('pending delivery status v1 contract', () => {
  it.each([
    [
      'queued row',
      { status: 'queued', deliveryState: null, deliveryBlockedReason: null },
      { status: 'queued' },
      { status: 'queued', deliveryState: null, deliveryBlockedReason: null, discardedReason: null },
    ],
    [
      'claimed provider row',
      { status: 'queued', deliveryState: 'delivering', deliveryBlockedReason: null },
      { status: 'delivering', detail: 'awaiting_acceptance' },
      { status: 'queued', deliveryState: 'delivering', deliveryBlockedReason: null, discardedReason: null },
    ],
    [
      'external handoff row',
      { status: 'queued', deliveryState: 'external_handoff', deliveryBlockedReason: null },
      { status: 'external_handoff' },
      { status: 'queued', deliveryState: 'external_handoff', deliveryBlockedReason: null, discardedReason: null },
    ],
    [
      'blocked row',
      { status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'terminal_composer_draft' },
      { status: 'blocked', reason: 'terminal_composer_draft' },
      { status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'terminal_composer_draft', discardedReason: null },
    ],
    [
      'legacy blocked row without a valid reason',
      { status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'future_reason' },
      { status: 'blocked', reason: 'unknown' },
      { status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'unknown', discardedReason: null },
    ],
    [
      'discarded row',
      { status: 'discarded', deliveryState: 'blocked', deliveryBlockedReason: 'terminal_composer_draft', discardedReason: 'user dismissed' },
      { status: 'discarded', reason: 'user dismissed' },
      { status: 'discarded', deliveryState: null, deliveryBlockedReason: null, discardedReason: 'user dismissed' },
    ],
  ] satisfies readonly (readonly [
    string,
    Parameters<typeof normalizePendingDeliveryStatusV1>[0],
    PendingDeliveryStatusV1,
    ReturnType<typeof pendingDeliveryStatusV1ToPersistedFields>,
  ])[])('round-trips %s through the persisted column shape', (_name, fields, typed, persisted) => {
    expect(normalizePendingDeliveryStatusV1(fields)).toEqual(typed);
    expect(pendingDeliveryStatusV1ToPersistedFields(typed)).toEqual(persisted);
  });

  it('parses typed status values received from server projections', () => {
    expect(parsePendingDeliveryStatusV1({ status: 'delivering' })).toEqual({ status: 'delivering' });
    expect(parsePendingDeliveryStatusV1({ status: 'delivering', detail: 'custody_observed' })).toEqual({
      status: 'delivering',
      detail: 'custody_observed',
    });
    expect(parsePendingDeliveryStatusV1({ status: 'delivering', detail: 'awaiting_acceptance' })).toEqual({
      status: 'delivering',
      detail: 'awaiting_acceptance',
    });
    expect(parsePendingDeliveryStatusV1({ status: 'delivering', detail: 'future_detail' })).toEqual({
      status: 'delivering',
    });
    expect(parsePendingDeliveryStatusV1({ status: 'external_handoff' })).toEqual({ status: 'external_handoff' });
    expect(parsePendingDeliveryStatusV1({ status: 'blocked', reason: 'payload_too_large' })).toEqual({
      status: 'blocked',
      reason: 'payload_too_large',
    });
    expect(parsePendingDeliveryStatusV1({ status: 'blocked', reason: 'future_reason' })).toEqual({
      status: 'blocked',
      reason: 'unknown',
    });
    expect(parsePendingDeliveryStatusV1({ status: 'blocked', reason: 'provider_acceptance_timeout' })).toEqual({
      status: 'blocked',
      reason: 'unknown',
    });
    expect(parsePendingDeliveryStatusV1({ status: 'discarded', reason: '' })).toEqual({
      status: 'discarded',
      reason: null,
    });
    expect(parsePendingDeliveryStatusV1({ status: 'resolved' })).toBeNull();
  });

  it('keeps custody detail descriptive instead of persisting it as delivery authority', () => {
    const persisted = pendingDeliveryStatusV1ToPersistedFields({
      status: 'delivering',
      detail: 'custody_observed',
    });

    expect(persisted).toEqual({
      status: 'queued',
      deliveryState: 'delivering',
      deliveryBlockedReason: null,
      discardedReason: null,
    });
    expect(normalizePendingDeliveryStatusV1(persisted)).toEqual({
      status: 'delivering',
      detail: 'awaiting_acceptance',
    });
  });

  it.each([
    [{ status: 'queued' }, false],
    [{ status: 'delivering' }, true],
    [{ status: 'delivering', detail: 'custody_observed' }, true],
    [{ status: 'delivering', detail: 'awaiting_acceptance' }, true],
    [{ status: 'external_handoff' }, true],
    [{ status: 'blocked', reason: 'ambiguous_terminal_delivery' }, true],
    [{ status: 'blocked', reason: 'delivery_outcome_uncertain' }, true],
    [{ status: 'blocked', reason: 'unknown' }, true],
    [{ status: 'blocked', reason: 'provider_rejected_before_acceptance' }, false],
    [{ status: 'blocked', reason: 'payload_too_large' }, false],
    [{ status: 'discarded', reason: null }, false],
  ] satisfies readonly (readonly [PendingDeliveryStatusV1, boolean])[])(
    'classifies %# provider-effect possibility',
    (status, possible) => {
      expect(isPendingDeliveryProviderEffectPossibleV1(status)).toBe(possible);
    },
  );

  it.each([
    [{ status: 'discarded', reason: 'resent_as_new' }, false],
    [{ status: 'discarded', reason: 'dismissed_uncertain' }, true],
    [{ status: 'discarded', reason: 'user_discarded' }, true],
    [{ status: 'discarded', reason: null }, true],
    [{ status: 'queued' }, false],
  ] satisfies readonly (readonly [PendingDeliveryStatusV1, boolean])[])(
    'classifies %# discarded-history visibility',
    (status, visible) => {
      expect(shouldExposePendingDeliveryInDiscardedHistoryV1(status)).toBe(visible);
    },
  );

  it.each([
    [{ status: 'queued' }, { status: 'resolved', reason: 'provider_accepted' }, false],
    [{ status: 'delivering' }, { status: 'resolved', reason: 'provider_accepted' }, true],
    [{ status: 'delivering', detail: 'custody_observed' }, { status: 'resolved', reason: 'provider_accepted' }, true],
    [{ status: 'external_handoff' }, { status: 'resolved', reason: 'provider_accepted' }, true],
    [{ status: 'blocked', reason: 'terminal_composer_draft' }, { status: 'resolved', reason: 'provider_accepted' }, true],
    [{ status: 'queued' }, { status: 'resolved', reason: 'materialized' }, true],
    [{ status: 'blocked', reason: 'terminal_composer_draft' }, { status: 'queued' }, true],
    [{ status: 'blocked', reason: 'terminal_composer_draft' }, { status: 'blocked', reason: 'payload_too_large' }, true],
    [{ status: 'delivering' }, { status: 'discarded', reason: 'user_discarded' }, false],
    [{ status: 'external_handoff' }, { status: 'discarded', reason: 'user_discarded' }, false],
    [{ status: 'discarded', reason: null }, { status: 'delivering' }, false],
  ] satisfies readonly (readonly [PendingDeliveryStatusV1, PendingDeliveryStatusTransitionTargetV1, boolean])[])(
    'validates %# transition',
    (from, to, allowed) => {
      expect(isPendingDeliveryStatusTransitionAllowedV1(from, to)).toBe(allowed);
    },
  );
});

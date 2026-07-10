import { describe, expect, it } from 'vitest';

import {
  isPendingDeliveryStatusTransitionAllowedV1,
  normalizePendingDeliveryStatusV1,
  parsePendingDeliveryStatusV1,
  pendingDeliveryStatusV1ToPersistedFields,
} from './pendingDeliveryStatusV1.js';

describe('PendingDeliveryStatusV1', () => {
  it('round-trips typed delivery statuses through existing persisted fields', () => {
    const statuses = [
      { status: 'queued' },
      { status: 'delivering' },
      { status: 'blocked', reason: 'runtime_config_blocked' },
      { status: 'discarded', reason: 'manual' },
      { status: 'discarded', reason: null },
    ] as const;

    for (const status of statuses) {
      expect(normalizePendingDeliveryStatusV1(pendingDeliveryStatusV1ToPersistedFields(status))).toEqual(status);
      expect(parsePendingDeliveryStatusV1(status)).toEqual(status);
    }
  });

  it('normalizes malformed persisted fields fail-closed over legacy raw columns', () => {
    expect(normalizePendingDeliveryStatusV1({ status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'future' }))
      .toEqual({ status: 'blocked', reason: 'unknown' });
    expect(normalizePendingDeliveryStatusV1({ status: 'queued', deliveryState: 'delivering', deliveryBlockedReason: 'payload_too_large' }))
      .toEqual({ status: 'delivering' });
    expect(normalizePendingDeliveryStatusV1({ status: 'unknown', deliveryState: 'blocked', deliveryBlockedReason: 'payload_too_large' }))
      .toEqual({ status: 'queued' });
  });

  it('allows direct provider acceptance from delivering or blocked but never queued', () => {
    expect(isPendingDeliveryStatusTransitionAllowedV1(
      { status: 'delivering' },
      { status: 'resolved', reason: 'provider_accepted' },
    )).toBe(true);
    expect(isPendingDeliveryStatusTransitionAllowedV1(
      { status: 'blocked', reason: 'provider_acceptance_timeout' },
      { status: 'resolved', reason: 'provider_accepted' },
    )).toBe(true);
    expect(isPendingDeliveryStatusTransitionAllowedV1(
      { status: 'queued' },
      { status: 'resolved', reason: 'provider_accepted' },
    )).toBe(false);
  });

  it('allows accepted-through-seq from delivering or blocked but never queued', () => {
    expect(isPendingDeliveryStatusTransitionAllowedV1(
      { status: 'delivering' },
      { status: 'resolved', reason: 'provider_accepted', acceptedThroughSeq: true },
    )).toBe(true);
    expect(isPendingDeliveryStatusTransitionAllowedV1(
      { status: 'blocked', reason: 'provider_acceptance_timeout' },
      { status: 'resolved', reason: 'provider_accepted', acceptedThroughSeq: true },
    )).toBe(true);
    expect(isPendingDeliveryStatusTransitionAllowedV1(
      { status: 'queued' },
      { status: 'resolved', reason: 'provider_accepted', acceptedThroughSeq: true },
    )).toBe(false);
  });
});

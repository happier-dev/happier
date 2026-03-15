import { describe, expect, it } from 'vitest';

import { isAbortLikeError, normalizeExecutionRunSendDelivery, resolveInFlightDeliveryAction } from './turnDelivery';

describe('turnDelivery', () => {
  it('normalizes unknown delivery to prompt', () => {
    expect(normalizeExecutionRunSendDelivery(undefined)).toBe('prompt');
    expect(normalizeExecutionRunSendDelivery('prompt')).toBe('prompt');
    expect(normalizeExecutionRunSendDelivery('interrupt')).toBe('interrupt');
    expect(normalizeExecutionRunSendDelivery('steer_if_supported')).toBe('steer_if_supported');
    expect(normalizeExecutionRunSendDelivery('nope')).toBe('prompt');
  });

  it('resolves in-flight actions deterministically', () => {
    expect(resolveInFlightDeliveryAction({ delivery: 'prompt', hasSteer: true })).toBe('busy');
    expect(resolveInFlightDeliveryAction({ delivery: 'steer_if_supported', hasSteer: true })).toBe('steer');
    expect(resolveInFlightDeliveryAction({ delivery: 'steer_if_supported', hasSteer: false })).toBe('cancel_and_send');
    expect(resolveInFlightDeliveryAction({ delivery: 'interrupt', hasSteer: true })).toBe('cancel_and_send');
  });

  it('detects abort-like errors', () => {
    expect(isAbortLikeError(new Error('aborted'))).toBe(true);
    expect(isAbortLikeError(new Error('Cancelled by user'))).toBe(true);
    expect(isAbortLikeError(new Error('boom'))).toBe(false);

    const abortErr = Object.assign(new Error('anything'), { name: 'AbortError' });
    expect(isAbortLikeError(abortErr)).toBe(true);
  });
});


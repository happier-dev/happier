import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING,
  type AccountSettings,
} from '@happier-dev/protocol';
import {
  PENDING_QUEUE_DRAIN_ALL_MAX_POP_PER_WAKE,
  PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE,
  resolvePendingQueueRuntimeActivityDeferral,
  resolveSessionPendingQueueDeliveryTiming,
  resolveSessionPendingQueueDrainMode,
  resolveSessionPendingQueueMaxPopPerWake,
  runtimeIdleForPendingDrain,
  shouldDeferPendingQueueDrainForRuntimeActivity,
} from './pendingQueueDrainPolicy';

describe('pendingQueueDrainPolicy', () => {

  it('resolves pending queue drain mode and max pop per wake from account settings', () => {
    expect(resolveSessionPendingQueueDrainMode({ sessionPendingQueueDrainMode: 'drain_all' } as AccountSettings)).toBe('drain_all');
    expect(resolveSessionPendingQueueMaxPopPerWake({ sessionPendingQueueDrainMode: 'drain_all' } as AccountSettings)).toBe(PENDING_QUEUE_DRAIN_ALL_MAX_POP_PER_WAKE);
    expect(resolveSessionPendingQueueMaxPopPerWake({ sessionPendingQueueDrainMode: 'one_at_a_time' } as AccountSettings)).toBe(PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE);
  });

  it('defaults pending queue delivery timing to foreground-ready for missing or malformed settings', () => {
    expect(resolveSessionPendingQueueDeliveryTiming(null)).toBe(DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING);
    expect(resolveSessionPendingQueueDeliveryTiming({ sessionPendingQueueDeliveryTiming: 'invalid' } as unknown as AccountSettings)).toBe(DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING);
  });

  it('accepts after-runtime-idle pending queue delivery timing from account settings', () => {
    expect(resolveSessionPendingQueueDeliveryTiming({
      sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
    } as AccountSettings)).toBe('after_runtime_idle');
  });

  it('derives runtime-idle pending drain state from the shared runtime activity projection contract', () => {
    const activity = {
      runtimeActivityState: 'active' as const,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 500,
      runtimeActivityRevision: 2,
    };

    expect(runtimeIdleForPendingDrain(activity, 1_000)).toBe(false);
    expect(runtimeIdleForPendingDrain({
      ...activity,
      runtimeActivityState: 'idle' as const,
      runtimeActivityActiveCount: 0,
      runtimeActivityRevision: 3,
    }, 1_000)).toBe(true);
    expect(runtimeIdleForPendingDrain({ ...activity, runtimeActivityState: 'unknown' as const, runtimeActivityActiveCount: 0 }, 99_000)).toBe(false);
  });

  it('only defers queued delivery for after-runtime-idle timing with non-idle runtime activity', () => {
    const activity = {
      runtimeActivityState: 'active' as const,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 500,
      runtimeActivityRevision: 2,
    };

    expect(shouldDeferPendingQueueDrainForRuntimeActivity({
      settings: {},
      activity,
      nowMs: 1_000,
    })).toBe(false);
    expect(shouldDeferPendingQueueDrainForRuntimeActivity({
      settings: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } as AccountSettings,
      activity,
      nowMs: 1_000,
    })).toBe(true);

    expect(resolvePendingQueueRuntimeActivityDeferral({
      settings: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } as AccountSettings,
      activity,
      nowMs: 1_000,
    })).toEqual({ defer: true });
    expect(resolvePendingQueueRuntimeActivityDeferral({
      settings: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } as AccountSettings,
      activity: {
        runtimeActivityState: 'idle',
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: 2_000,
        runtimeActivityRevision: 3,
      },
      nowMs: 2_000,
    })).toEqual({ defer: false });
  });
});

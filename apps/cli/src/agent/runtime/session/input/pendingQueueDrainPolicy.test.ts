import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SESSION_PENDING_QUEUE_DELIVERY_TIMING,
  type AccountSettings,
} from '@happier-dev/protocol';
import {
  PENDING_QUEUE_DRAIN_ALL_MAX_POP_PER_WAKE,
  PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE,
  resolveSessionPendingActiveTurnDeliveryPolicy,
  resolvePendingQueueRuntimeActivityDeferral,
  resolveSessionPendingQueueDeliveryTiming,
  resolveSessionPendingQueueDrainMode,
  resolveSessionPendingQueueMaxPopPerWake,
  runtimeIdleForPendingDrain,
  shouldDeferPendingQueueDrainForRuntimeActivity,
} from './pendingQueueDrainPolicy';

describe('pendingQueueDrainPolicy', () => {
  it('allows active-turn delivery unless the user explicitly chose server-pending busy sends', () => {
    expect(resolveSessionPendingActiveTurnDeliveryPolicy(null)).toBe('allow_live_delivery');
    expect(resolveSessionPendingActiveTurnDeliveryPolicy({})).toBe('allow_live_delivery');
    expect(resolveSessionPendingActiveTurnDeliveryPolicy({
      sessionBusySteerSendPolicy: 'steer_immediately',
    })).toBe('allow_live_delivery');
    expect(resolveSessionPendingActiveTurnDeliveryPolicy({
      sessionBusySteerSendPolicy: 'server_pending',
    })).toBeUndefined();
  });

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
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 500,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task' as const,
    };

    expect(runtimeIdleForPendingDrain(activity, 1_000)).toBe(false);
    expect(runtimeIdleForPendingDrain({
      ...activity,
      runtimeActivityExpiresAt: 1_000,
    }, 1_000)).toBe(true);
    expect(runtimeIdleForPendingDrain({
      ...activity,
      runtimeActivityExpiresAt: null,
    }, 1_000)).toBe(true);
    expect(runtimeIdleForPendingDrain({
      ...activity,
      runtimeActivityExpiresAt: Number.NaN,
    }, 1_000)).toBe(true);
    expect(runtimeIdleForPendingDrain({
      ...activity,
      runtimeActivityExpiresAt: 1_000,
    }, 2_000)).toBe(true);
  });

  it('keeps expiry as the fail-open guard when the session client is the owning runner', () => {
    const expiredActivity = {
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 500,
      runtimeActivityExpiresAt: 999,
      runtimeActivitySourceClass: 'provider_detached_task' as const,
    };

    expect(runtimeIdleForPendingDrain(expiredActivity, 1_000)).toBe(true);
    expect(shouldDeferPendingQueueDrainForRuntimeActivity({
      settings: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } as AccountSettings,
      activity: expiredActivity,
      nowMs: 1_000,
    })).toBe(false);
  });

  it('only defers queued delivery for after-runtime-idle timing with non-idle runtime activity', () => {
    const activity = {
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 500,
      runtimeActivityExpiresAt: 2_000,
      runtimeActivitySourceClass: 'provider_detached_task' as const,
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
    })).toEqual({ defer: true, runtimeActivityExpiresAt: 2_000 });
    expect(resolvePendingQueueRuntimeActivityDeferral({
      settings: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } as AccountSettings,
      activity,
      nowMs: 2_000,
    })).toEqual({ defer: false, runtimeActivityExpiresAt: null });
  });
});

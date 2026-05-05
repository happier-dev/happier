import { describe, expect, it } from 'vitest';

async function loadApnsDeliveryModule() {
  return import('./apnsDelivery.js').catch(() => null);
}

describe('Live Activity APNs delivery classification', () => {
  it('classifies accepted APNs responses as successful transport acceptance', async () => {
    const apnsDelivery = await loadApnsDeliveryModule();
    expect(apnsDelivery).not.toBeNull();
    if (!apnsDelivery) return;

    expect(apnsDelivery.classifyLiveActivityApnsDeliveryResponse({
      status: 200,
    })).toEqual({
      action: 'success',
    });
  });

  it('classifies invalid or unregistered ActivityKit tokens as target drops', async () => {
    const apnsDelivery = await loadApnsDeliveryModule();
    expect(apnsDelivery).not.toBeNull();
    if (!apnsDelivery) return;

    expect(apnsDelivery.classifyLiveActivityApnsDeliveryResponse({
      status: 410,
      reason: 'Unregistered',
    })).toEqual({
      action: 'permanent_drop_target',
      reason: 'Unregistered',
    });
    expect(apnsDelivery.classifyLiveActivityApnsDeliveryResponse({
      status: 400,
      reason: 'BadDeviceToken',
    })).toEqual({
      action: 'permanent_drop_target',
      reason: 'BadDeviceToken',
    });
  });

  it('distinguishes payload defects from operator APNs configuration failures', async () => {
    const apnsDelivery = await loadApnsDeliveryModule();
    expect(apnsDelivery).not.toBeNull();
    if (!apnsDelivery) return;

    expect(apnsDelivery.classifyLiveActivityApnsDeliveryResponse({
      status: 413,
      reason: 'PayloadTooLarge',
    })).toEqual({
      action: 'permanent_fix_payload',
      reason: 'PayloadTooLarge',
    });
    expect(apnsDelivery.classifyLiveActivityApnsDeliveryResponse({
      status: 400,
      reason: 'DeviceTokenNotForTopic',
    })).toEqual({
      action: 'operator_config',
      reason: 'DeviceTokenNotForTopic',
    });
    expect(apnsDelivery.classifyLiveActivityApnsDeliveryResponse({
      status: 403,
      reason: 'InvalidProviderToken',
    })).toEqual({
      action: 'operator_config',
      reason: 'InvalidProviderToken',
    });
  });

  it('classifies throttling and server-side APNs failures as transient retries', async () => {
    const apnsDelivery = await loadApnsDeliveryModule();
    expect(apnsDelivery).not.toBeNull();
    if (!apnsDelivery) return;

    expect(apnsDelivery.classifyLiveActivityApnsDeliveryResponse({
      status: 429,
      reason: 'TooManyRequests',
    })).toEqual({
      action: 'transient_retry',
      reason: 'TooManyRequests',
    });
    expect(apnsDelivery.classifyLiveActivityApnsDeliveryResponse({
      status: 503,
      reason: 'ServiceUnavailable',
    })).toEqual({
      action: 'transient_retry',
      reason: 'ServiceUnavailable',
    });
  });

  it('derives quiet Live Activity APNs fields without allowing alert interruptions', async () => {
    const apnsDelivery = await loadApnsDeliveryModule();
    expect(apnsDelivery).not.toBeNull();
    if (!apnsDelivery) return;

    expect(apnsDelivery.deriveLiveActivityApnsDeliveryFields({
      bundleId: 'dev.happier.app',
      activityId: 'activity-1',
      event: 'update',
      template: 'quietFocus',
      nowEpochSeconds: 1_000,
      quietHoursActive: false,
      alertRequested: true,
    })).toEqual({
      pushType: 'liveactivity',
      topic: 'dev.happier.app.push-type.liveactivity',
      priority: 5,
      collapseId: 'activity-1:update:quietFocus',
      expiration: 2_800,
      allowsAlert: false,
    });
  });

  it('bounds derived collapse ids for long activity identifiers', async () => {
    const apnsDelivery = await loadApnsDeliveryModule();
    expect(apnsDelivery).not.toBeNull();
    if (!apnsDelivery) return;

    const fields = apnsDelivery.deriveLiveActivityApnsDeliveryFields({
      bundleId: 'dev.happier.app',
      activityId: `activity-${'x'.repeat(200)}`,
      event: 'update',
      template: 'urgentAttention',
      nowEpochSeconds: 1_000,
      quietHoursActive: false,
      alertRequested: false,
    });

    expect(new TextEncoder().encode(fields.collapseId).byteLength).toBeLessThanOrEqual(64);
    expect(fields.collapseId).toContain(':update:urgentAttention:');
  });

  it('derives urgent Live Activity APNs fields and suppresses alerts during quiet hours', async () => {
    const apnsDelivery = await loadApnsDeliveryModule();
    expect(apnsDelivery).not.toBeNull();
    if (!apnsDelivery) return;

    expect(apnsDelivery.deriveLiveActivityApnsDeliveryFields({
      bundleId: 'dev.happier.app',
      activityId: 'activity-1',
      event: 'update',
      template: 'urgentAttention',
      nowEpochSeconds: 1_000,
      quietHoursActive: false,
      alertRequested: true,
    })).toMatchObject({
      priority: 10,
      expiration: 1_060,
      allowsAlert: true,
    });

    expect(apnsDelivery.deriveLiveActivityApnsDeliveryFields({
      bundleId: 'dev.happier.app',
      activityId: 'activity-1',
      event: 'update',
      template: 'urgentAttention',
      nowEpochSeconds: 1_000,
      quietHoursActive: true,
      alertRequested: true,
    })).toMatchObject({
      priority: 10,
      expiration: 1_060,
      allowsAlert: false,
    });
  });
});

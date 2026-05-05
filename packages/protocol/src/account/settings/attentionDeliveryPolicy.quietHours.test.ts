import { describe, expect, it } from 'vitest';

import { parseAccountSettings, resolveAttentionDecision } from './attentionDeliveryPolicy.testkit.js';

describe('attentionDeliveryPolicyV1 quiet hours', () => {
  it('applies same-day quiet hours to interruptive notification channels', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '09:00', endLocalTime: '17:00' }],
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'local_notification',
      now: new Date('2026-05-03T12:30:00.000Z'),
    })).toMatchObject({
      delivery: 'suppress',
      reason: 'quiet_hours',
    });
  });

  it('applies midnight-wrapping quiet hours across local days', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '22:00', endLocalTime: '07:00' }],
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'expo_push',
      now: new Date('2026-05-03T23:30:00.000Z'),
    })).toMatchObject({ delivery: 'suppress', reason: 'quiet_hours' });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'expo_push',
      now: new Date('2026-05-04T06:30:00.000Z'),
    })).toMatchObject({ delivery: 'suppress', reason: 'quiet_hours' });
  });

  it('treats equal quiet-hour start and end times as a no-op window', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '09:00', endLocalTime: '09:00' }],
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'local_notification',
      now: new Date('2026-05-03T09:00:00.000Z'),
    })).toMatchObject({ delivery: 'deliver', reason: 'deliver' });
  });

  it('treats invalid quiet-hour timezones as inactive instead of throwing', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'Not/AZone',
          windows: [{ startLocalTime: '09:00', endLocalTime: '17:00' }],
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'local_notification',
      now: new Date('2026-05-03T12:30:00.000Z'),
    })).toMatchObject({ delivery: 'deliver', reason: 'deliver' });
  });

  it('uses the current device timezone for quiet-hour decisions when provided', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '09:00', endLocalTime: '10:00' }],
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'local_notification',
      now: new Date('2026-05-03T07:30:00.000Z'),
      currentTimezone: 'Europe/Zurich',
    })).toMatchObject({ delivery: 'suppress', reason: 'quiet_hours' });
  });

  it('does not suppress webhooks during quiet hours unless explicitly configured', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '09:00', endLocalTime: '17:00' }],
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'permission_request',
      channel: 'webhook',
      now: new Date('2026-05-03T12:30:00.000Z'),
    })).toMatchObject({ delivery: 'deliver', reason: 'deliver' });
  });

  it('suppresses webhooks during quiet hours when the channel opts in', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '09:00', endLocalTime: '17:00' }],
        },
        channels: {
          webhook: {
            quietHoursBehavior: 'suppress',
          },
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'permission_request',
      channel: 'webhook',
      now: new Date('2026-05-03T12:30:00.000Z'),
    })).toMatchObject({ delivery: 'suppress', reason: 'quiet_hours' });
  });

  it('removes sound from silent quiet-hour delivery decisions', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '09:00', endLocalTime: '17:00' }],
        },
        channels: {
          local_notification: {
            quietHoursBehavior: 'silent',
          },
        },
        sounds: {
          defaultSoundId: 'default',
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'local_notification',
      now: new Date('2026-05-03T12:30:00.000Z'),
    })).toMatchObject({
      delivery: 'silent',
      reason: 'quiet_hours',
      sound: { kind: 'none', volume: 1 },
    });
  });
});

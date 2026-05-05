import { describe, expect, it } from 'vitest';

import { parseAccountSettings, resolveAttentionDecision } from './attentionDeliveryPolicy.testkit.js';

describe('attentionDeliveryPolicyV1 Live Activity remote updates', () => {
  it('keeps Live Activity remote-update preference independent from APNs credential availability', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        liveActivityRemoteUpdates: {
          enabled: true,
          preferredMode: 'hosted_happier_relay',
          allowBackgroundWakeFallback: true,
          defaultStaleAfterSeconds: 1800,
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'permission_request',
      channel: 'live_activity',
      now: new Date('2026-05-03T12:00:00.000Z'),
    })).toMatchObject({
      delivery: 'deliver',
      liveActivityRemoteBehavior: {
        mode: 'hosted_happier_relay',
        freshness: 'fresh',
        staleAt: '2026-05-03T12:30:00.000Z',
        reason: 'policy',
      },
    });
  });

  it('can suppress interruptive notifications while allowing a quiet Live Activity update', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [{ startLocalTime: '09:00', endLocalTime: '17:00' }],
        },
        liveActivityRemoteUpdates: {
          enabled: true,
          preferredMode: 'local_only',
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'permission_request',
      channel: 'expo_push',
      now: new Date('2026-05-03T12:00:00.000Z'),
    })).toMatchObject({ delivery: 'suppress', reason: 'quiet_hours' });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'permission_request',
      channel: 'live_activity',
      now: new Date('2026-05-03T12:00:00.000Z'),
    })).toMatchObject({ delivery: 'silent', reason: 'quiet_hours' });
  });
});

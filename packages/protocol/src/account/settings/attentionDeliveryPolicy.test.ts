import { describe, expect, it } from 'vitest';

import { parseAccountSettings, resolveAttentionDecision } from './attentionDeliveryPolicy.testkit.js';

describe('attentionDeliveryPolicyV1 resolver', () => {
  it('delivers enabled events to enabled channels by default', () => {
    const parsed = parseAccountSettings();

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'local_notification',
      now: new Date('2026-05-03T12:00:00.000Z'),
    })).toMatchObject({
      delivery: 'deliver',
      reason: 'deliver',
      previewBehavior: 'include_preview',
      foregroundBehavior: 'full',
      sound: { kind: 'bundled', id: 'soft', volume: 1 },
    });
  });

  it('uses the bundled urgent sound for request attention by default', () => {
    const parsed = parseAccountSettings();

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'permission_request',
      channel: 'expo_push',
      now: new Date('2026-05-03T12:00:00.000Z'),
    })).toMatchObject({
      delivery: 'deliver',
      reason: 'deliver',
      sound: { kind: 'bundled', id: 'urgent', volume: 1 },
    });
  });

  it('preserves native system sounds for request attention when selected', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        sounds: {
          defaultSoundId: 'default',
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'permission_request',
      channel: 'expo_push',
      now: new Date('2026-05-03T12:00:00.000Z'),
    })).toMatchObject({
      delivery: 'deliver',
      reason: 'deliver',
      sound: { kind: 'system_default', id: 'default', volume: 1 },
    });
  });

  it('suppresses disabled events before channel-specific decisions', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        events: {
          ready: { enabled: false },
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'local_notification',
      now: new Date('2026-05-03T12:00:00.000Z'),
    })).toMatchObject({
      delivery: 'suppress',
      reason: 'event_disabled',
    });
  });

  it('keeps disabled event diagnostics ahead of transient visibility suppression', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        events: {
          permission_request: { enabled: false },
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'permission_request',
      channel: 'local_notification',
      sameSessionVisible: true,
      terminalFrontmost: true,
      now: new Date('2026-05-03T12:00:00.000Z'),
    })).toMatchObject({
      delivery: 'suppress',
      reason: 'event_disabled',
    });
  });

  it('suppresses disabled channels after event enablement is confirmed', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: {
          local_notification: { enabled: false },
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'permission_request',
      channel: 'local_notification',
      now: new Date('2026-05-03T12:00:00.000Z'),
    })).toMatchObject({
      delivery: 'suppress',
      reason: 'channel_disabled',
    });
  });

  it('suppresses unsupported channels with an unsupported surface reason', () => {
    const parsed = parseAccountSettings();

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'future_surface',
      now: new Date('2026-05-03T12:00:00.000Z'),
    })).toMatchObject({
      delivery: 'suppress',
      reason: 'unsupported_surface',
    });
  });

  it('resolves event-level sound and preview overrides', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        events: {
          permission_request: {
            soundId: 'urgent',
            previewBehavior: 'title_only',
          },
        },
        sounds: {
          defaultSoundId: 'default',
          volume: 0.35,
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'permission_request',
      channel: 'local_notification',
      now: new Date('2026-05-03T12:00:00.000Z'),
    })).toMatchObject({
      delivery: 'deliver',
      previewBehavior: 'title_only',
      sound: { kind: 'bundled', id: 'urgent', volume: 0.35 },
    });
  });

  it('classifies unknown sound ids as custom so senders do not treat them as bundled app sounds', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        sounds: {
          defaultSoundId: 'future-imported-tone',
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'expo_push',
      now: new Date('2026-05-03T12:00:00.000Z'),
    })).toMatchObject({
      delivery: 'deliver',
      sound: { kind: 'custom', id: 'future-imported-tone', volume: 1 },
    });
  });

  it('returns foreground suppression when foreground behavior is off', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        foregroundBehavior: 'off',
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'local_notification',
      foregroundState: 'foreground',
      now: new Date('2026-05-03T12:00:00.000Z'),
    })).toMatchObject({
      delivery: 'suppress',
      reason: 'foreground_suppressed',
      foregroundBehavior: 'off',
    });
  });

  it('returns badge inclusion from the resolved event and channel state', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: {
          badge: {
            events: {
              ready: { enabled: false },
            },
          },
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'badge',
      now: new Date('2026-05-03T12:00:00.000Z'),
    })).toMatchObject({
      delivery: 'suppress',
      reason: 'event_disabled',
      badgeBehavior: { include: false },
    });
  });

  it('keeps durable badge delivery when a relevant terminal is frontmost', () => {
    const parsed = parseAccountSettings();

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'permission_request',
      channel: 'badge',
      terminalFrontmost: true,
      now: new Date('2026-05-03T12:00:00.000Z'),
    })).toMatchObject({
      delivery: 'deliver',
      reason: 'deliver',
      badgeBehavior: { include: true },
    });
  });

  it('keeps webhook automation delivery when a relevant terminal is frontmost', () => {
    const parsed = parseAccountSettings({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: {
          webhook: { enabled: true },
        },
      },
    });

    expect(resolveAttentionDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'permission_request',
      channel: 'webhook',
      terminalFrontmost: true,
      now: new Date('2026-05-03T12:00:00.000Z'),
    })).toMatchObject({
      delivery: 'deliver',
      reason: 'deliver',
    });
  });
});

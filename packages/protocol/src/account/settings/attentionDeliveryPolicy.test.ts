import { describe, expect, it } from 'vitest';

import {
  AttentionDeliveryEventIdSchema,
  DEFAULT_ATTENTION_DELIVERY_POLICY_V1,
  REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS,
  type ResolveAttentionDeliveryPolicyDecisionParams,
} from './attentionDeliveryPolicy.js';
import { parseAccountSettings, resolveAttentionDecision } from './attentionDeliveryPolicy.testkit.js';
import {
  resolveAttentionDeliveryPolicyDecision,
  resolveAttentionDeliveryPreviewBehavior,
} from './attentionDeliveryPolicyDecision.js';

describe('attentionDeliveryPolicyV1 resolver', () => {
  it('keeps update and mention notices quiet while retaining their badge and respects quiet hours for needs-you', () => {
    for (const inboxItemType of ['update', 'mention'] as const) {
      const request = { policy: {}, event: 'notify_me', now: new Date('2026-05-03T12:00:00Z'), inboxItemType };
      for (const channel of ['expo_push', 'plugin', 'local_notification', 'desktop_overlay', 'webhook']) {
        expect(resolveAttentionDeliveryPolicyDecision({ ...request, channel }).delivery).toBe('suppress');
      }
      expect(resolveAttentionDeliveryPolicyDecision({ ...request, channel: 'badge' }).badgeBehavior.include).toBe(true);
    }
    const request = { event: 'user_action_request', now: new Date('2026-05-03T00:30:00Z'),
      inboxItemType: 'decision' as const, policy: { quietHours: { enabled: true, timezone: 'UTC',
        windows: [{ startLocalTime: '00:00', endLocalTime: '01:00' }] } } };
    expect(resolveAttentionDeliveryPolicyDecision({ ...request, channel: 'expo_push' }).reason).toBe('quiet_hours');
    expect(resolveAttentionDeliveryPolicyDecision({ ...request, channel: 'badge' }).badgeBehavior.include).toBe(true);
    expect(resolveAttentionDeliveryPolicyDecision({ ...request, now: new Date('2026-05-03T01:00:00Z'), channel: 'expo_push' }).delivery).toBe('deliver');
  });

  it('keeps Important completion in Inbox while allowing selected urgent events to interrupt', () => {
    const request: ResolveAttentionDeliveryPolicyDecisionParams = {
      policy: {}, event: 'ready', channel: 'expo_push', now: new Date('2026-05-03T12:00:00Z'),
      follow: { policies: [{ preset: 'important' }], event: { kind: 'finished' } },
    };
    expect(resolveAttentionDeliveryPolicyDecision(request).delivery).toBe('suppress');
    expect(resolveAttentionDeliveryPolicyDecision({ ...request, channel: 'badge' }).badgeBehavior.include).toBe(true);
    expect(resolveAttentionDeliveryPolicyDecision({ ...request, follow: {
      policies: [{ preset: 'important' }], event: { kind: 'failed_or_stopped' },
    } }).delivery).toBe('deliver');
  });

  it('keeps continue-mode and manager-handled questions quiet without losing Inbox attention', () => {
    const request: ResolveAttentionDeliveryPolicyDecisionParams = {
      policy: {}, event: 'user_action_request', channel: 'expo_push', now: new Date('2026-05-03T12:00:00Z'),
      follow: { policies: [{ preset: 'important' }], event: {
        kind: 'needs_you', type: 'decision', mode: 'continue',
      } },
    };
    expect(resolveAttentionDeliveryPolicyDecision(request).delivery).toBe('suppress');
    expect(resolveAttentionDeliveryPolicyDecision({ ...request, channel: 'badge' }).badgeBehavior.include).toBe(true);
    expect(resolveAttentionDeliveryPolicyDecision({ ...request, follow: {
      policies: [{ preset: 'everything' }], event: { kind: 'needs_you', type: 'decision', mode: 'continue' },
    } }).delivery).toBe('deliver');
    expect(resolveAttentionDeliveryPolicyDecision({ ...request, follow: {
      policies: [{ preset: 'everything' }], event: { kind: 'needs_you', type: 'decision', handling: 'manager' },
    } }).delivery).toBe('suppress');
  });

  it('resolves a large policy decision within one policy-normalization pass', () => {
    const policy = {
      events: Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [
        `extension_event_${index}`, { enabled: true, previewBehavior: 'title_only' },
      ])),
    };
    const request = { policy, event: 'ready', channel: 'badge', now: new Date('2026-05-03T12:00:00Z') };
    const measure = (operation: () => unknown) => {
      const started = performance.now();
      for (let index = 0; index < 8; index += 1) operation();
      return performance.now() - started;
    };
    // A fresh object each run: one policy object is parsed once, and this measures that first pass.
    const preview = () => resolveAttentionDeliveryPreviewBehavior({ ...request, policy: structuredClone(policy) });
    const decide = () => resolveAttentionDeliveryPolicyDecision({ ...request, policy: structuredClone(policy) });
    // Compare against the same public boundary's one-pass preview, rather than a device-time budget.
    // Alternate warm runs and use minima so unrelated executor scheduling/GC cannot be the RED cause.
    preview(); decide();
    const previewTimes: number[] = [];
    const decisionTimes: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      previewTimes.push(measure(preview));
      decisionTimes.push(measure(decide));
    }
    const ratio = Math.min(...decisionTimes) / Math.min(...previewTimes);
    console.info('[QA25 policy normalization]', JSON.stringify({ previewTimes, decisionTimes, ratio }));
    expect(decide()).toMatchObject({ delivery: 'deliver', previewBehavior: preview(), badgeBehavior: { include: true } });
    // A second full traversal costs about twice the reference; ordinary decision logic is constant work.
    expect(ratio).toBeLessThan(1.75);
  });

  it('applies Notify me event privacy and quiet hours to plugin delivery', () => {
    expect(resolveAttentionDecision({ policy: {
      events: { notify_me: { previewBehavior: 'title_only', quietHoursBehavior: 'suppress' } },
      quietHours: { enabled: true, timezone: 'UTC', windows: [{ startLocalTime: '00:00', endLocalTime: '01:00' }] },
    }, event: 'notify_me', channel: 'plugin', now: new Date('2026-05-03T00:30:00Z') }))
      .toMatchObject({ delivery: 'suppress', reason: 'quiet_hours', previewBehavior: 'title_only' });
  });
  it('owns the complete remote-alert policy event vocabulary and default projections', () => {
    expect(AttentionDeliveryEventIdSchema.safeParse('follow_update').success).toBe(true);
    expect(REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS).toEqual([
      'ready',
      'permission_request',
      'user_action_request',
      'follow_update',
      'machine_offline',
      'service_health',
    ]);

    for (const eventId of REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS) {
      expect(DEFAULT_ATTENTION_DELIVERY_POLICY_V1.events[eventId]).toEqual({ enabled: true });
      expect(DEFAULT_ATTENTION_DELIVERY_POLICY_V1.channels.expo_push.events[eventId]).toEqual({ enabled: true });
    }
  });

  it('admits production service-health attention without overriding disabled channels or quiet hours', () => {
    const request = { event: 'service_health', inboxItemType: 'blocked' as const, channel: 'expo_push',
      now: new Date('2026-05-03T00:30:00Z') };
    expect(AttentionDeliveryEventIdSchema.safeParse(request.event).success).toBe(true);
    expect(resolveAttentionDecision({ ...request, policy: {} }).delivery).toBe('deliver');
    expect(resolveAttentionDecision({ ...request, policy: { channels: { expo_push: { enabled: false } } } }).delivery).toBe('suppress');
    expect(resolveAttentionDecision({ ...request, policy: { quietHours: { enabled: true, timezone: 'UTC',
      windows: [{ startLocalTime: '00:00', endLocalTime: '01:00' }] } } }).delivery).toBe('suppress');
    expect(resolveAttentionDecision({ ...request, inboxItemType: 'update', policy: {} }).delivery).toBe('suppress');
  });

  it('shows remote request previews by default while preserving explicit policy overrides', () => {
    const decide = (policy: unknown, channel = 'expo_push', event = 'permission_request') => resolveAttentionDecision({
      policy, event, channel, now: new Date('2026-05-03T12:00:00.000Z'),
    });
    const broad = { channels: { expo_push: { previewBehavior: 'include_preview' } } };
    expect(decide(broad).previewBehavior).toBe('include_preview');
    expect(decide(broad, 'live_activity').previewBehavior).toBe('include_preview');
    expect(decide({ events: { permission_request: { previewBehavior: 'include_preview' } } }, 'live_activity').previewBehavior).toBe('include_preview');
    expect(decide(broad, 'expo_push', 'ready').previewBehavior).toBe('include_preview');
    expect(decide(broad, 'local_notification').previewBehavior).toBe('include_preview');
    expect(decide({ ...broad, events: { permission_request: { previewBehavior: 'include_preview' } } }).previewBehavior).toBe('include_preview');
    expect(decide({ events: { permission_request: { previewBehavior: 'title_only' } } }, 'live_activity').previewBehavior).toBe('title_only');
  });

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

describe('computer focus phone-push policy', () => {
  it.each(['ready', 'permission_request', 'user_action_request'])('marks only opted-in Expo %s delivery', (event) => {
    const policy = parseAccountSettings({ attentionDeliveryPolicyV1: { mutePhoneWhenComputerFocused: true } }).attentionDeliveryPolicyV1;
    expect(resolveAttentionDecision({ policy, event, channel: 'expo_push' }).suppressIfComputerFocused).toBe(true);
    expect(resolveAttentionDecision({ policy, event, channel: 'local_notification' }).suppressIfComputerFocused).toBeUndefined();
  });
  it('preserves unrelated events and defaults off', () => {
    const policy = parseAccountSettings({ attentionDeliveryPolicyV1: { mutePhoneWhenComputerFocused: true } }).attentionDeliveryPolicyV1;
    expect(resolveAttentionDecision({ policy, event: 'connected_service_quota_blocked', channel: 'expo_push' }).suppressIfComputerFocused).toBeUndefined();
    expect(resolveAttentionDecision({ policy: parseAccountSettings().attentionDeliveryPolicyV1, event: 'ready', channel: 'expo_push' }).suppressIfComputerFocused).toBeUndefined();
  });
});

describe('computer focus preference migration', () => {
  it('backfills the predecessor opt-in into an established policy without replacing canonical choices', () => {
    const migrated = parseAccountSettings({
      notificationsSettingsV1: { mutePhoneWhenComputerFocused: true, ready: true, foregroundBehavior: 'full' },
      attentionDeliveryPolicyV1: { foregroundBehavior: 'silent', events: { ready: { enabled: false } } },
    }).attentionDeliveryPolicyV1;
    expect(migrated.mutePhoneWhenComputerFocused).toBe(true);
    expect(migrated.foregroundBehavior).toBe('silent');
    expect(migrated.events.ready.enabled).toBe(false);
  });

  it('does not treat a malformed explicit canonical value as a predecessor opt-in', () => {
    const policy = parseAccountSettings({
      notificationsSettingsV1: { mutePhoneWhenComputerFocused: true },
      attentionDeliveryPolicyV1: { mutePhoneWhenComputerFocused: 'true' },
    }).attentionDeliveryPolicyV1;
    expect(policy.mutePhoneWhenComputerFocused).toBeUndefined();
  });

  it('imports the predecessor opt-in once and gives explicit canonical policy authority', () => {
    const migrated = parseAccountSettings({ notificationsSettingsV1: { mutePhoneWhenComputerFocused: true } });
    expect(migrated.attentionDeliveryPolicyV1.mutePhoneWhenComputerFocused).toBe(true);
    expect(parseAccountSettings({
      notificationsSettingsV1: { mutePhoneWhenComputerFocused: true },
      attentionDeliveryPolicyV1: { mutePhoneWhenComputerFocused: false },
    }).attentionDeliveryPolicyV1.mutePhoneWhenComputerFocused).toBe(false);
    expect(parseAccountSettings({ attentionDeliveryPolicyV1: { mutePhoneWhenComputerFocused: 'true' } }).attentionDeliveryPolicyV1.mutePhoneWhenComputerFocused).toBeUndefined();
  });
});

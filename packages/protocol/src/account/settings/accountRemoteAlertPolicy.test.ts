import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from './accountSettings.js';
import { REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS } from './attentionDeliveryPolicy.js';
import { resolveAttentionDeliveryPolicyDecision } from './attentionDeliveryPolicyDecision.js';
import * as remote from './accountRemoteAlertPolicy.js';

describe('remote alert policy projection', () => {
  it('reads only policy inputs while a genuine consent change reaches the currentness consumer', () => {
    let unrelatedReads = 0;
    const settings = new Proxy({ sessionRemoteAlertsEnabled: true,
      ...Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`unrelated${index}`, { retained: index }])),
    }, {
      get(target, key, receiver) {
        if (typeof key === 'string' && key.startsWith('unrelated')) unrelatedReads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const policy = remote.deriveAccountRemoteAlertPolicyV1(settings);
    expect(remote.resolveAccountRemoteAlertPolicyCurrentness({ settingsVersion: 3, policy }, 3))
      .toMatchObject({ status: 'current', policy: { events: { ready: { enabled: true } } } });
    expect(unrelatedReads).toBe(0);
  });

  it('preserves Follow quiet delivery in the remote Account/device adapter', () => {
    const accountPolicy = remote.deriveAccountRemoteAlertPolicyV1({ sessionRemoteAlertsEnabled: true });
    const params = { accountPolicy, devicePolicy: { v: 1, enabled: true, nativeConsumer: 'ios_service_extension_v1',
      quietHoursOverride: { mode: 'account' }, foregroundBehavior: 'account', previewCeiling: 'title_only', soundVolume: 1 },
      event: 'ready', now: new Date('2026-05-03T12:00:00Z'),
      follow: { policies: [{ preset: 'important' as const }], event: { kind: 'finished' as const } },
    };
    expect(remote.resolveRemoteAlertPolicyDecision(params)?.delivery).toBe('suppress');
  });

  it('enrolls selected machines without consenting to remote session alerts', () => {
    const policy = remote.deriveAccountRemoteAlertPolicyV1({
      sessionRemoteAlertsEnabled: false,
      machineOfflineAlertsV1: { machineIds: ['machine-one'] },
    });
    expect(policy).not.toBeNull();
    expect(policy).toMatchObject({
      machineOffline: { machineIds: ['machine-one'] },
      events: { machine_offline: { enabled: true }, ready: { enabled: false } },
      channels: { expo_push: { enabled: true, events: { machine_offline: { enabled: true }, ready: { enabled: false } } } },
    });
    expect(remote.deriveAccountRemoteAlertPolicyV1({ machineOfflineAlertsV1: { machineIds: [] } })).toBeNull();
  });
  it('reads a retained session-only projection without granting machine enrollment', () => {
    const current = remote.deriveAccountRemoteAlertPolicyV1({ sessionRemoteAlertsEnabled: true });
    if (!current) throw new Error('expected enabled session policy');
    const retained = { ...current,
      events: Object.fromEntries(Object.entries(current.events).filter(([event]) => event !== 'machine_offline')),
      channels: { expo_push: { ...current.channels.expo_push,
        events: Object.fromEntries(Object.entries(current.channels.expo_push.events).filter(([event]) => event !== 'machine_offline')),
      } },
    };
    Reflect.deleteProperty(retained, 'machineOffline');
    const parsed = remote.AccountRemoteAlertPolicyV1Schema.parse(retained);
    expect(parsed).toMatchObject({ machineOffline: { machineIds: [] }, events: { machine_offline: { enabled: false } } });
    expect(remote.resolveAccountRemoteAlertPolicyCurrentness({ settingsVersion: 4, policy: retained }, 4))
      .toMatchObject({ status: 'current', policy: { machineOffline: { machineIds: [] }, events: { machine_offline: { enabled: false } } } });
    expect(remote.resolveAccountRemoteAlertPolicyCurrentness({ settingsVersion: 4, policy: retained }, 5))
      .toEqual({ status: 'stale', policy: null });
  });
  it('carries focus muting without enabling opted-out Home OS alerts', () => {
    const policy = remote.deriveAccountRemoteAlertPolicyV1({
      sessionRemoteAlertsEnabled: false,
      attentionDeliveryPolicyV1: { mutePhoneWhenComputerFocused: true },
    });
    expect(policy?.mutePhoneWhenComputerFocused).toBe(true);
    expect(policy?.channels.expo_push.enabled).toBe(false);
    expect(remote.deriveAccountRemoteAlertPolicyV1({
      attentionDeliveryPolicyV1: { mutePhoneWhenComputerFocused: false },
    })).toBeNull();
  });
  it('derives its strict event and sound maps from the canonical supported subset', () => {
    expect(Object.keys(remote.RemoteAlertEventPolicyMapV1Schema.shape))
      .toEqual(REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS);
    const policy = remote.deriveAccountRemoteAlertPolicyV1({ sessionRemoteAlertsEnabled: true });
    expect(Object.keys(policy?.events ?? {})).toEqual(REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS);
    expect(Object.keys(policy?.channels.expo_push.events ?? {})).toEqual(REMOTE_ALERT_ATTENTION_DELIVERY_EVENT_IDS);
  });

  it('derives only explicitly enabled Account policy and preserves canonical decisions', () => {
    expect(remote.deriveAccountRemoteAlertPolicyV1({})).toBeNull();
    const settings = {
      sessionRemoteAlertsEnabled: true,
      attentionDeliveryPolicyV1: {
        events: { ready: { enabled: false }, follow_update: { enabled: true } },
        channels: { expo_push: { events: { user_action_request: { previewBehavior: 'title_only' } } } },
        quietHours: { enabled: true, timezone: 'Europe/Zurich', windows: [
          { startLocalTime: '22:00', endLocalTime: '07:00', days: ['fri', 'sat'] },
        ] },
        sounds: { eventSoundIds: { permission_request: 'urgent' }, volume: 0.4 },
      },
    };
    const policy = remote.deriveAccountRemoteAlertPolicyV1(settings);
    expect(policy).not.toBeNull();
    for (const event of ['ready', 'permission_request', 'user_action_request', 'follow_update']) {
      for (const now of ['2026-09-04T19:59:00Z', '2026-09-04T20:00:00Z', '2026-09-05T04:59:00Z', '2026-09-05T05:00:00Z']) {
        expect(resolveAttentionDeliveryPolicyDecision({ policy, event, channel: 'expo_push', now }))
          .toEqual(resolveAttentionDeliveryPolicyDecision({
            policy: accountSettingsParse(settings).attentionDeliveryPolicyV1, event, channel: 'expo_push', now,
          }));
      }
    }
  });

  it('normalizes legacy settings once and removes private/custom sound data', () => {
    const policy = remote.deriveAccountRemoteAlertPolicyV1({
      sessionRemoteAlertsEnabled: true,
      notificationsSettingsV1: { pushEnabled: false },
    });
    expect(policy?.channels.expo_push.enabled).toBe(false);
    const custom = remote.deriveAccountRemoteAlertPolicyV1({
      sessionRemoteAlertsEnabled: true,
      attentionDeliveryPolicyV1: {
        events: { ready: { soundId: '/private/ready.wav', privateField: 'secret' } },
        sounds: { defaultSoundId: '/private/default.wav' },
        channels: { webhook: { destination: 'https://secret.example' } },
      },
    });
    expect(resolveAttentionDeliveryPolicyDecision({ policy: custom, event: 'ready', channel: 'expo_push', now: new Date(0) }).sound.id).toBe('soft');
    expect(resolveAttentionDeliveryPolicyDecision({ policy: custom, event: 'task_failed', channel: 'expo_push', now: new Date(0) }).sound.id).toBe('drop');
    expect(JSON.stringify(custom)).not.toContain('private');
    expect(JSON.stringify(custom)).not.toContain('secret');
  });

  it('composes device inheritance separately from explicit remote enrollment and restricts previews', () => {
    const account = remote.deriveAccountRemoteAlertPolicyV1({ sessionRemoteAlertsEnabled: true });
    const device = {
      v: 1, enabled: true, nativeConsumer: 'ios_service_extension_v1',
      quietHoursOverride: { mode: 'account' }, foregroundBehavior: 'account',
      previewCeiling: 'status_only', soundVolume: 0.7,
    };
    const decision = remote.resolveRemoteAlertPolicyDecision({ accountPolicy: account, devicePolicy: device,
      event: 'permission_request', now: '2026-09-05T12:00:00Z' });
    expect(decision?.delivery).toBe('deliver');
    expect(decision?.previewBehavior).toBe('status_only');
    expect(decision?.sound.volume).toBe(0.7);
    expect(remote.resolveRemoteAlertPolicyDecision({ accountPolicy: account, devicePolicy: { ...device, enabled: false },
      event: 'ready', now: '2026-09-05T12:00:00Z' })).toBeNull();
    expect(remote.resolveRemoteAlertPolicyDecision({ accountPolicy: {}, devicePolicy: device,
      event: 'ready', now: '2026-09-05T12:00:00Z' })).toBeNull();
    expect(remote.resolveRemoteAlertPolicyDecision({ accountPolicy: account, devicePolicy: device,
      event: 'arbitrary_invalidation', now: '2026-09-05T12:00:00Z' })).toBeNull();
    expect(remote.resolveRemoteAlertPolicyDecision({ accountPolicy: { ...account, secret: 'private' }, devicePolicy: device,
      event: 'ready', now: '2026-09-05T12:00:00Z' })).toBeNull();
  });
});

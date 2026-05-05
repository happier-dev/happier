import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
  getNotificationsSettingsV1FromAccountSettings,
  resolveAttentionDeliveryPolicyDecision,
  resolveNotificationChannelsV1FromAccountSettings,
} from '@happier-dev/protocol';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { readAccountSettingsV1, writeAccountSettingsV1 } from '../../src/testkit/accountSettingsHttp';

const run = createRunDirs({ runLabel: 'core' });

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

describe('core e2e: account settings notifications roundtrip', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop().catch(() => {});
    server = null;
  }, 60_000);

  it('roundtrips attentionDeliveryPolicyV1 with legacy notification settings compatibility', async () => {
    const testDir = run.testDir(`account-settings-notifications-roundtrip-${randomUUID()}`);
    server = await startServerLight({ testDir });

    const auth = await createTestAuth(server.baseUrl);
    const { settingsVersion } = await readAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
    });

    const nextSettings = {
      schemaVersion: 2,
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: false },
      notificationChannelsV1: [
        {
          v: 1,
          id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
          kind: 'expo_push',
          enabled: true,
          topics: {
            ready: true,
            permissionRequest: false,
            userActionRequest: true,
          },
          readyIncludeMessageText: false,
        },
      ],
      attentionDeliveryPolicyV1: {
        v: 1,
        events: {
          ready: { enabled: true },
          permission_request: { enabled: false },
          user_action_request: { enabled: true, soundId: 'default' },
        },
        channels: {
          expo_push: {
            enabled: true,
            quietHoursBehavior: 'suppress',
            previewBehavior: 'status_only',
            events: {
              ready: { enabled: true },
              permission_request: { enabled: false },
              user_action_request: { enabled: true },
            },
          },
          webhook: {
            enabled: true,
            quietHoursBehavior: 'deliver',
            previewBehavior: 'include_preview',
            events: {
              ready: { enabled: true },
              permission_request: { enabled: false },
              user_action_request: { enabled: true },
            },
          },
          live_activity: {
            enabled: true,
            quietHoursBehavior: 'silent',
          },
        },
        quietHours: {
          enabled: true,
          timezone: 'UTC',
          windows: [
            {
              startLocalTime: '22:00',
              endLocalTime: '07:00',
            },
          ],
        },
        foregroundBehavior: 'silent',
        privacy: {
          defaultPreviewBehavior: 'title_only',
          surfaces: {
            live_activity: 'status_only',
          },
        },
        sounds: {
          defaultSoundId: 'none',
          eventSoundIds: {
            user_action_request: 'default',
          },
          volume: 0.5,
        },
        liveActivityRemoteUpdates: {
          enabled: true,
          preferredMode: 'local_only',
          allowBackgroundWakeFallback: true,
          defaultStaleAfterSeconds: 900,
          quietHoursBehavior: 'silent',
        },
        unknownPolicyKey: { keep: true },
      },
      unknownFutureKey: { nested: true },
    };

    await expect(writeAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
      settings: nextSettings,
      expectedVersion: settingsVersion,
    })).resolves.toBe(settingsVersion + 1);

    const { settings: parsed, settingsVersion: nextSettingsVersion } = await readAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
    });
    expect(nextSettingsVersion).toBe(settingsVersion + 1);

    const notifications = getNotificationsSettingsV1FromAccountSettings(parsed);
    expect(notifications.pushEnabled).toBe(true);
    expect(notifications.ready).toBe(true);
    expect(notifications.permissionRequest).toBe(false);
    expect(resolveNotificationChannelsV1FromAccountSettings(parsed)).toEqual([
      {
        v: 1,
        id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
        kind: 'expo_push',
        enabled: true,
        topics: {
          ready: true,
          permissionRequest: false,
          userActionRequest: true,
        },
        readyIncludeMessageText: false,
      },
    ]);

    expect(parsed.attentionDeliveryPolicyV1.events.permission_request.enabled).toBe(false);
    expect(parsed.attentionDeliveryPolicyV1.channels.expo_push.previewBehavior).toBe('status_only');
    expect(parsed.attentionDeliveryPolicyV1.channels.webhook.quietHoursBehavior).toBe('deliver');
    expect(parsed.attentionDeliveryPolicyV1.quietHours).toMatchObject({
      enabled: true,
      timezone: 'UTC',
      windows: [
        {
          startLocalTime: '22:00',
          endLocalTime: '07:00',
        },
      ],
    });
    expect(parsed.attentionDeliveryPolicyV1.sounds).toMatchObject({
      defaultSoundId: 'none',
      eventSoundIds: {
        user_action_request: 'default',
      },
      volume: 0.5,
    });
    expect(parsed.attentionDeliveryPolicyV1.liveActivityRemoteUpdates).toMatchObject({
      preferredMode: 'local_only',
      allowBackgroundWakeFallback: true,
      defaultStaleAfterSeconds: 900,
    });
    expect(resolveAttentionDeliveryPolicyDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'expo_push',
      now: '2026-05-03T23:30:00.000Z',
    })).toMatchObject({
      delivery: 'suppress',
      reason: 'quiet_hours',
    });
    expect(resolveAttentionDeliveryPolicyDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'ready',
      channel: 'webhook',
      now: '2026-05-03T23:30:00.000Z',
    })).toMatchObject({
      delivery: 'deliver',
      reason: 'deliver',
      previewBehavior: 'include_preview',
    });
    expect(resolveAttentionDeliveryPolicyDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'permission_request',
      channel: 'expo_push',
      now: '2026-05-03T12:00:00.000Z',
    })).toMatchObject({
      delivery: 'suppress',
      reason: 'event_disabled',
    });
    expect(resolveAttentionDeliveryPolicyDecision({
      policy: parsed.attentionDeliveryPolicyV1,
      event: 'user_action_request',
      channel: 'expo_push',
      now: '2026-05-03T12:00:00.000Z',
    })).toMatchObject({
      delivery: 'deliver',
      sound: {
        kind: 'system_default',
        id: 'default',
        volume: 0.5,
      },
    });

    // Ensure forward-compat: unknown keys survive roundtrip + parse.
    expect(asRecord(parsed)?.unknownFutureKey).toEqual({ nested: true });
    expect(parsed.attentionDeliveryPolicyV1.unknownPolicyKey).toEqual({ keep: true });
  }, 240_000);
});

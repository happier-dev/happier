import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
  accountSettingsParse,
  resolveAttentionDeliveryPolicyDecision,
  resolveNotificationChannelsV1FromAccountSettings,
} from '@happier-dev/protocol';
import { sendWebhookActivityNotificationAsync } from '../../../../apps/cli/src/notifications/activity/sendWebhookActivityNotification';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { startActivityWebhookCaptureServer } from '../../src/testkit/activityWebhookCapture';
import { readAccountSettingsV1, writeAccountSettingsV1 } from '../../src/testkit/accountSettingsHttp';
import { buildCanonicalWebhookAccountSettings } from '../../src/testkit/activityWebhookSettings';

const run = createRunDirs({ runLabel: 'core' });

async function dispatchWebhookActivity(params: {
  settings: ReturnType<typeof accountSettingsParse>;
  event:
    | Readonly<{
        topic: 'ready';
        sessionId: string;
        sessionTitle?: string | null;
        waitingForCommandLabel: string;
        assistantPreviewText?: string | null;
      }>
    | Readonly<{
        topic: 'permission_request' | 'user_action_request';
        sessionId: string;
        sessionTitle?: string | null;
        agentDisplayName?: string | null;
        requestId: string;
        toolName: string;
        toolInput?: unknown;
        toolDetails?: string | null;
      }>;
  nowIso?: string;
}): Promise<{ attemptedChannels: number; deliveredChannels: number }> {
  const now = new Date(params.nowIso ?? '2026-05-03T12:00:00.000Z');
  let attemptedChannels = 0;
  let deliveredChannels = 0;

  for (const channel of resolveNotificationChannelsV1FromAccountSettings(params.settings)) {
    if (channel.kind !== 'webhook' || channel.enabled !== true) continue;
    if (params.event.topic === 'ready' && channel.topics.ready !== true) continue;
    if (params.event.topic === 'permission_request' && channel.topics.permissionRequest !== true) continue;
    if (params.event.topic === 'user_action_request' && channel.topics.userActionRequest !== true) continue;

    const decision = resolveAttentionDeliveryPolicyDecision({
      policy: params.settings.attentionDeliveryPolicyV1,
      event: params.event.topic,
      channel: 'webhook',
      now,
    });
    if (decision.delivery === 'suppress') continue;

    attemptedChannels += 1;
    await sendWebhookActivityNotificationAsync({
      channel,
      event: params.event,
      nowMs: () => now.getTime(),
    });
    deliveredChannels += 1;
  }

  return { attemptedChannels, deliveredChannels };
}

describe('core e2e: webhook activity notifications', () => {
  let server: StartedServer | null = null;
  let webhookServer: Awaited<ReturnType<typeof startActivityWebhookCaptureServer>> | null = null;

  afterEach(async () => {
    await webhookServer?.stop().catch(() => {});
    webhookServer = null;
    await server?.stop().catch(() => {});
    server = null;
  }, 60_000);

  it('delivers ready activity to a configured webhook channel using persisted account settings', async () => {
    const testDir = run.testDir(`notifications-webhook-ready-${randomUUID()}`);
    server = await startServerLight({ testDir });
    webhookServer = await startActivityWebhookCaptureServer();

    const auth = await createTestAuth(server.baseUrl);
    await writeAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
      settings: {
        schemaVersion: 2,
        notificationsSettingsV1: {
          v: 1,
          pushEnabled: false,
          ready: true,
          readyIncludeMessageText: true,
          permissionRequest: true,
          userActionRequest: true,
          foregroundBehavior: 'full',
        },
        notificationChannelsV1: [
          {
            v: 1,
            id: BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
            kind: 'expo_push',
            enabled: false,
            topics: {
              ready: true,
              permissionRequest: true,
              userActionRequest: true,
            },
            readyIncludeMessageText: true,
          },
          {
            v: 1,
            id: 'webhook-primary',
            kind: 'webhook',
            enabled: true,
            url: webhookServer.url,
            signingSecret: {
              _isSecretValue: true,
              value: 'ready-secret',
            },
            topics: {
              ready: true,
              permissionRequest: false,
              userActionRequest: false,
            },
            readyIncludeMessageText: false,
          },
        ],
      },
    });

    const { settings } = await readAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
    });

    const dispatchResult = await dispatchWebhookActivity({
      settings,
      event: {
        topic: 'ready',
        sessionId: 'session-ready-1',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      },
    });
    expect(dispatchResult).toEqual({
      attemptedChannels: 1,
      deliveredChannels: 1,
    });

    const webhookRequest = await webhookServer.nextPayload();
    expect(webhookRequest.headers['x-happier-signature-256']).toMatch(/^sha256=[a-f0-9]{64}$/);
    const payload = webhookRequest.payload;
    expect(payload.topic).toBe('ready');
    expect(payload.navigation).toEqual({ sessionId: 'session-ready-1' });
    expect(payload.session).toEqual({
      sessionId: 'session-ready-1',
      title: 'Review branch',
    });
    expect(payload.request).toBeUndefined();
    expect(payload.content).toEqual({
      title: 'Review branch',
      body: 'Codex is waiting for your command',
    });
  }, 240_000);

  it('sends sanitized permission-request details to the configured webhook channel', async () => {
    const testDir = run.testDir(`notifications-webhook-permission-${randomUUID()}`);
    server = await startServerLight({ testDir });
    webhookServer = await startActivityWebhookCaptureServer();

    const auth = await createTestAuth(server.baseUrl);
    await writeAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
      settings: {
        schemaVersion: 2,
        notificationsSettingsV1: {
          v: 1,
          pushEnabled: false,
          ready: true,
          readyIncludeMessageText: true,
          permissionRequest: true,
          userActionRequest: true,
          foregroundBehavior: 'full',
        },
        notificationChannelsV1: [
          {
            v: 1,
            id: 'webhook-primary',
            kind: 'webhook',
            enabled: true,
            url: webhookServer.url,
            signingSecret: {
              _isSecretValue: true,
              value: 'permission-secret',
            },
            topics: {
              ready: false,
              permissionRequest: true,
              userActionRequest: false,
            },
            readyIncludeMessageText: false,
          },
        ],
      },
    });

    const { settings } = await readAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
    });

    const dispatchResult = await dispatchWebhookActivity({
      settings,
      event: {
        topic: 'permission_request',
        sessionId: 'session-perm-1',
        sessionTitle: 'Fix prod issue',
        requestId: 'request-9',
        toolName: 'Bash',
        agentDisplayName: 'Claude',
        toolInput: {
          command: 'git status --short && echo secret-token',
        },
      },
    });
    expect(dispatchResult).toEqual({
      attemptedChannels: 1,
      deliveredChannels: 1,
    });

    const webhookRequest = await webhookServer.nextPayload();
    expect(webhookRequest.headers['x-happier-signature-256']).toMatch(/^sha256=[a-f0-9]{64}$/);
    const payload = webhookRequest.payload;
    expect(payload.topic).toBe('permission_request');
    expect(payload.navigation).toEqual({
      sessionId: 'session-perm-1',
      requestId: 'request-9',
    });
    expect(payload.content).toEqual({
      title: 'Fix prod issue',
      body: 'Claude asks permission to use Bash\nCommand: git',
    });
    expect(payload.request).toEqual({
      requestId: 'request-9',
      kind: 'permission',
      toolName: 'Bash',
      toolDetails: 'Command: git',
    });
    expect(JSON.stringify(payload)).not.toContain('secret-token');
  }, 240_000);

  it('suppresses webhooks when canonical event policy disables an enabled legacy topic', async () => {
    const testDir = run.testDir(`notifications-webhook-canonical-toggle-${randomUUID()}`);
    server = await startServerLight({ testDir });
    webhookServer = await startActivityWebhookCaptureServer();

    const auth = await createTestAuth(server.baseUrl);
    await writeAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
      settings: buildCanonicalWebhookAccountSettings({
        webhookUrl: webhookServer.url,
        readyEventEnabled: false,
      }),
    });

    const { settings } = await readAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
    });

    const dispatchResult = await dispatchWebhookActivity({
      settings,
      nowIso: '2026-05-03T12:00:00.000Z',
      event: {
        topic: 'ready',
        sessionId: 'session-ready-disabled',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
      },
    });
    expect(dispatchResult).toEqual({
      attemptedChannels: 0,
      deliveredChannels: 0,
    });
    await expect(webhookServer.nextPayload(250)).rejects.toThrow('Timed out waiting for webhook payload');
  }, 240_000);

  it('keeps webhooks delivering during quiet hours unless the webhook policy opts into suppression', async () => {
    const testDir = run.testDir(`notifications-webhook-quiet-hours-${randomUUID()}`);
    server = await startServerLight({ testDir });
    webhookServer = await startActivityWebhookCaptureServer();

    const auth = await createTestAuth(server.baseUrl);
    await writeAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
      settings: buildCanonicalWebhookAccountSettings({
        webhookUrl: webhookServer.url,
      }),
    });

    const { settings: settingsDuringQuietHours } = await readAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
    });

    const deliveredDuringQuietHours = await dispatchWebhookActivity({
      settings: settingsDuringQuietHours,
      nowIso: '2026-05-03T23:30:00.000Z',
      event: {
        topic: 'ready',
        sessionId: 'session-quiet-deliver',
        sessionTitle: 'Night build',
        waitingForCommandLabel: 'Codex',
      },
    });
    expect(deliveredDuringQuietHours).toEqual({
      attemptedChannels: 1,
      deliveredChannels: 1,
    });
    const deliveredPayload = await webhookServer.nextPayload();
    expect(deliveredPayload.payload.topic).toBe('ready');
    expect(deliveredPayload.payload.navigation).toEqual({ sessionId: 'session-quiet-deliver' });

    await writeAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
      settings: buildCanonicalWebhookAccountSettings({
        webhookUrl: webhookServer.url,
        webhookQuietHoursBehavior: 'suppress',
      }),
    });

    const { settings: suppressingSettings } = await readAccountSettingsV1({
      baseUrl: server.baseUrl,
      token: auth.token,
    });

    const suppressedDuringQuietHours = await dispatchWebhookActivity({
      settings: suppressingSettings,
      nowIso: '2026-05-03T23:30:00.000Z',
      event: {
        topic: 'ready',
        sessionId: 'session-quiet-suppress',
        sessionTitle: 'Night build',
        waitingForCommandLabel: 'Codex',
      },
    });
    expect(suppressedDuringQuietHours).toEqual({
      attemptedChannels: 0,
      deliveredChannels: 0,
    });
    await expect(webhookServer.nextPayload(250)).rejects.toThrow('Timed out waiting for webhook payload');
  }, 240_000);
});

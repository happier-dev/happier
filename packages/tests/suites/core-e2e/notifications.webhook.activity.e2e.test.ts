import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

import {
  ActivityWebhookPayloadV1Schema,
  BUILT_IN_EXPO_PUSH_NOTIFICATION_CHANNEL_ID,
  accountSettingsParse,
  resolveNotificationChannelsV1FromAccountSettings,
} from '@happier-dev/protocol';
import { sendWebhookActivityNotificationAsync } from '../../../../apps/cli/src/activity/notifications/sendWebhookActivityNotification';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';

const run = createRunDirs({ runLabel: 'core' });

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function getString(record: UnknownRecord, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected string ${key}`);
  }
  return value;
}

function getNumber(record: UnknownRecord, key: string): number {
  const value = record[key];
  if (typeof value !== 'number') {
    throw new Error(`Expected number ${key}`);
  }
  return value;
}

async function writeAccountSettings(params: {
  baseUrl: string;
  token: string;
  settings: unknown;
}): Promise<void> {
  const getRes = await fetch(`${params.baseUrl}/v1/account/settings`, {
    headers: { Authorization: `Bearer ${params.token}` },
  });
  expect(getRes.ok).toBe(true);
  const getJson: unknown = await getRes.json().catch(() => null);
  const getRow = asRecord(getJson);
  if (!getRow) throw new Error('Expected account settings response object');
  const settingsVersion = getNumber(getRow, 'settingsVersion');

  const postRes = await fetch(`${params.baseUrl}/v1/account/settings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      settings: JSON.stringify(params.settings),
      expectedVersion: settingsVersion,
    }),
  });
  expect(postRes.ok).toBe(true);
}

async function readAccountSettings(params: {
  baseUrl: string;
  token: string;
}) {
  const getRes = await fetch(`${params.baseUrl}/v1/account/settings`, {
    headers: { Authorization: `Bearer ${params.token}` },
  });
  expect(getRes.ok).toBe(true);
  const getJson: unknown = await getRes.json().catch(() => null);
  const getRow = asRecord(getJson);
  if (!getRow) throw new Error('Expected account settings response object');
  return accountSettingsParse(JSON.parse(getString(getRow, 'settings')));
}

type CapturedWebhookPayload = ReturnType<typeof ActivityWebhookPayloadV1Schema.parse>;

async function startWebhookCaptureServer(): Promise<{
  url: string;
  stop: () => Promise<void>;
  nextPayload: (timeoutMs?: number) => Promise<Readonly<{
    headers: Record<string, string | undefined>;
    payload: CapturedWebhookPayload;
  }>>;
}> {
  type CapturedWebhookRequest = Readonly<{
    headers: Record<string, string | undefined>;
    payload: CapturedWebhookPayload;
  }>;

  const payloadQueue: CapturedWebhookRequest[] = [];
  const payloadWaiters: Array<(payload: CapturedWebhookRequest) => void> = [];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const parsed = ActivityWebhookPayloadV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const request = {
      headers: {
        'x-happier-signature-256': typeof req.headers['x-happier-signature-256'] === 'string'
          ? req.headers['x-happier-signature-256']
          : undefined,
      },
      payload: parsed,
    } satisfies CapturedWebhookRequest;

    const waiter = payloadWaiters.shift();
    if (waiter) {
      waiter(request);
    } else {
      payloadQueue.push(request);
    }

    res.statusCode = 202;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP webhook server address');
  }

  return {
    url: `http://127.0.0.1:${address.port}/webhook`,
    stop: async () => {
      server.close();
      await once(server, 'close');
    },
    nextPayload: async (timeoutMs = 30_000) => {
      if (payloadQueue.length > 0) {
        return payloadQueue.shift()!;
      }

      return await new Promise<CapturedWebhookRequest>((resolvePayload, rejectPayload) => {
        const timeout = setTimeout(() => {
          const index = payloadWaiters.indexOf(resolvePayload);
          if (index >= 0) {
            payloadWaiters.splice(index, 1);
          }
          rejectPayload(new Error('Timed out waiting for webhook payload'));
        }, timeoutMs);

        payloadWaiters.push((payload) => {
          clearTimeout(timeout);
          resolvePayload(payload);
        });
      });
    },
  };
}

async function dispatchWebhookActivity(params: {
  settingsJson: string;
  eventJson: string;
}): Promise<{ attemptedChannels: number; deliveredChannels: number }> {
  const settings = accountSettingsParse(JSON.parse(params.settingsJson));
  const event = JSON.parse(params.eventJson) as
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
        requestId: string;
        toolName: string;
        toolInput?: unknown;
        toolDetails?: string | null;
      }>;
  let attemptedChannels = 0;
  let deliveredChannels = 0;

  for (const channel of resolveNotificationChannelsV1FromAccountSettings(settings)) {
    if (channel.kind !== 'webhook' || channel.enabled !== true) continue;
    if (event.topic === 'ready' && channel.topics.ready !== true) continue;
    if (event.topic === 'permission_request' && channel.topics.permissionRequest !== true) continue;
    if (event.topic === 'user_action_request' && channel.topics.userActionRequest !== true) continue;

    attemptedChannels += 1;
    await sendWebhookActivityNotificationAsync({
      channel,
      event,
    });
    deliveredChannels += 1;
  }

  return { attemptedChannels, deliveredChannels };
}

describe('core e2e: webhook activity notifications', () => {
  let server: StartedServer | null = null;
  let webhookServer: Awaited<ReturnType<typeof startWebhookCaptureServer>> | null = null;

  afterEach(async () => {
    await webhookServer?.stop().catch(() => {});
    webhookServer = null;
    await server?.stop().catch(() => {});
    server = null;
  }, 60_000);

  it('delivers ready activity to a configured webhook channel using persisted account settings', async () => {
    const testDir = run.testDir(`notifications-webhook-ready-${randomUUID()}`);
    server = await startServerLight({ testDir });
    webhookServer = await startWebhookCaptureServer();

    const auth = await createTestAuth(server.baseUrl);
    await writeAccountSettings({
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

    const settings = await readAccountSettings({
      baseUrl: server.baseUrl,
      token: auth.token,
    });

    const dispatchResult = await dispatchWebhookActivity({
      settingsJson: JSON.stringify(settings),
      eventJson: JSON.stringify({
        topic: 'ready',
        sessionId: 'session-ready-1',
        sessionTitle: 'Review branch',
        waitingForCommandLabel: 'Codex',
        assistantPreviewText: 'The branch is ready to review.',
      }),
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
    webhookServer = await startWebhookCaptureServer();

    const auth = await createTestAuth(server.baseUrl);
    await writeAccountSettings({
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

    const settings = await readAccountSettings({
      baseUrl: server.baseUrl,
      token: auth.token,
    });

    const dispatchResult = await dispatchWebhookActivity({
      settingsJson: JSON.stringify(settings),
      eventJson: JSON.stringify({
        topic: 'permission_request',
        sessionId: 'session-perm-1',
        sessionTitle: 'Fix prod issue',
        requestId: 'request-9',
        toolName: 'Bash',
        toolInput: {
          command: 'git status --short && echo secret-token',
        },
      }),
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
      title: 'Permission Request',
      body: 'Approval needed for: Bash\nCommand: git',
    });
    expect(payload.request).toEqual({
      requestId: 'request-9',
      kind: 'permission',
      toolName: 'Bash',
      toolDetails: 'Command: git',
    });
    expect(JSON.stringify(payload)).not.toContain('secret-token');
  }, 240_000);
});

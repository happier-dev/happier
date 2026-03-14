import { createHmac } from 'node:crypto';

import {
  buildActivityWebhookPayload,
  decryptSecretValueWithKeysV1,
  hasConfiguredSecretStringValue,
  type WebhookNotificationChannelV1,
} from '@happier-dev/protocol';

import type { ActivityNotificationEvent } from './activityNotificationEvent';
import { buildActivityNotificationContent } from './buildActivityNotificationContent';

function readSigningSecret(
  secret: WebhookNotificationChannelV1['signingSecret'],
  settingsSecretsReadKeys: ReadonlyArray<Uint8Array | null | undefined>,
): string | null {
  if (!hasConfiguredSecretStringValue(secret)) return null;
  const value = decryptSecretValueWithKeysV1(secret, settingsSecretsReadKeys)?.trim() ?? '';
  return value.length > 0 ? value : null;
}

export async function sendWebhookActivityNotificationAsync(params: Readonly<{
  channel: WebhookNotificationChannelV1;
  event: ActivityNotificationEvent;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  nowMs?: () => number;
}>): Promise<void> {
  const built = buildActivityNotificationContent(params.event, {
    readyIncludeMessageText: params.channel.readyIncludeMessageText !== false,
  });
  const payload = buildActivityWebhookPayload({
    channelId: params.channel.id,
    createdAt: (params.nowMs ?? (() => Date.now()))(),
    topic: params.event.topic,
    content: {
      title: built.title,
      body: built.body,
    },
    session: {
      sessionId: params.event.sessionId,
      title: params.event.sessionTitle ?? null,
    },
    request: params.event.topic === 'ready'
      ? null
      : {
        requestId: params.event.requestId,
        kind: params.event.topic === 'user_action_request' ? 'user_action' : 'permission',
        toolName: params.event.toolName,
        toolDetails: built.toolDetails ?? null,
      },
  });
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  const signingSecret = readSigningSecret(
    params.channel.signingSecret,
    params.settingsSecretsReadKeys ?? [],
  );
  if (signingSecret) {
    headers['x-happier-signature-256'] = `sha256=${createHmac('sha256', signingSecret).update(body).digest('hex')}`;
  }

  const response = await fetch(params.channel.url, {
    method: 'POST',
    headers,
    body,
  });
  if (!response.ok) {
    throw new Error(`Webhook notification failed with status ${response.status}`);
  }
}

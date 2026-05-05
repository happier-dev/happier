import { describe, expect, it } from 'vitest';

import { buildActivityWebhookPayload } from '@happier-dev/protocol';

import { startActivityWebhookCaptureServer } from './activityWebhookCapture';

async function postReadyPayload(url: string, sessionId: string): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildActivityWebhookPayload({
      channelId: 'webhook-primary',
      createdAt: 123,
      topic: 'ready',
      content: {
        title: 'Ready',
        body: 'Ready',
      },
      session: {
        sessionId,
      },
    })),
  });
  expect(response.status).toBe(202);
}

describe('activityWebhookCapture', () => {
  it('removes timed-out payload waiters before accepting a later payload', async () => {
    const server = await startActivityWebhookCaptureServer();
    try {
      await expect(server.nextPayload(50)).rejects.toThrow('Timed out waiting for webhook payload');

      await postReadyPayload(server.url, 'session-after-timeout');

      await expect(server.nextPayload(1_000)).resolves.toMatchObject({
        payload: {
          navigation: {
            sessionId: 'session-after-timeout',
          },
        },
      });
    } finally {
      await server.stop();
    }
  });
});

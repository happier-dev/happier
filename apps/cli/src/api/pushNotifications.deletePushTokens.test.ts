import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { PushNotificationClient } from './pushNotifications';

type ReceivedRequest = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string };

const servers: Array<ReturnType<typeof createServer>> = [];

async function startRecordingServer(): Promise<{ baseUrl: string; received: ReceivedRequest[] }> {
  const received: ReceivedRequest[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      received.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"success":true}');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, received };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('PushNotificationClient.deletePushTokens', () => {
  it('sends a bodiless DELETE without a JSON content type', async () => {
    const { baseUrl, received } = await startRecordingServer();
    const client = new PushNotificationClient('secret', baseUrl);

    await client.deletePushToken('ExponentPushToken[abc]');

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      method: 'DELETE',
      url: `/v1/push-tokens/${encodeURIComponent('ExponentPushToken[abc]')}`,
      body: '',
    });
    expect(received[0].headers.authorization).toBe('Bearer secret');
    expect(received[0].headers['content-type']).toBeUndefined();
  });
});

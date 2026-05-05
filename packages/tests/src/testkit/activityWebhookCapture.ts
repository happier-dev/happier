import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

import {
  ActivityWebhookPayloadV1Schema,
  type ActivityWebhookPayloadV1,
} from '@happier-dev/protocol';

export type CapturedActivityWebhookRequest = Readonly<{
  headers: Record<string, string | undefined>;
  payload: ActivityWebhookPayloadV1;
}>;

export type StartedActivityWebhookCaptureServer = Readonly<{
  url: string;
  stop: () => Promise<void>;
  nextPayload: (timeoutMs?: number) => Promise<CapturedActivityWebhookRequest>;
}>;

export async function startActivityWebhookCaptureServer(): Promise<StartedActivityWebhookCaptureServer> {
  const payloadQueue: CapturedActivityWebhookRequest[] = [];
  const payloadWaiters: Array<(payload: CapturedActivityWebhookRequest) => void> = [];

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
    } satisfies CapturedActivityWebhookRequest;

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

      return await new Promise<CapturedActivityWebhookRequest>((resolvePayload, rejectPayload) => {
        const resolveWaitingPayload = (payload: CapturedActivityWebhookRequest) => {
          clearTimeout(timeout);
          resolvePayload(payload);
        };
        const timeout = setTimeout(() => {
          const index = payloadWaiters.indexOf(resolveWaitingPayload);
          if (index >= 0) {
            payloadWaiters.splice(index, 1);
          }
          rejectPayload(new Error('Timed out waiting for webhook payload'));
        }, timeoutMs);

        payloadWaiters.push(resolveWaitingPayload);
      });
    },
  };
}

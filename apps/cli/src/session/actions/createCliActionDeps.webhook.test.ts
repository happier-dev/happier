import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createCliActionDeps } from './createCliActionDeps';

describe('CLI webhook Action host', () => {
  it('reports a rejected destination as a definitive refusal before any effect', async () => {
    const deps = createCliActionDeps({ token: 'unused', sessionId: 'cli-global', mode: 'plain', ctx: null });
    await expect(deps.webhookCall!({ url: 'http://169.254.169.254/latest/meta-data/', body: {} },
      { surface: 'cli', authority: 'present_user', actionRequestId: 'run/step/0' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'webhook_destination_rejected' });
  });
  it('retains success and failure responses and sends the admitted run/step/attempt identity', async () => {
    const requests: { key: string | string[] | undefined; body: string }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({ key: request.headers['idempotency-key'], body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(request.url === '/ok' ? 299 : 302, { location: 'http://169.254.169.254/' });
      response.end(request.url === '/ok' ? 'accepted' : 'moved');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected loopback server');
      const deps = createCliActionDeps({ token: 'unused', sessionId: 'cli-global', mode: 'plain', ctx: null });
      const context = { surface: 'cli' as const, authority: 'present_user' as const, actionRequestId: 'run/step/0' };
      const url = `http://127.0.0.1:${address.port}`;
      await expect(deps.webhookCall!({ url: `${url}/ok`, body: { text: 'literal', count: 1 } }, context))
        .resolves.toEqual({ status: 299, body: 'accepted' });
      await expect(deps.webhookCall!({ url: `${url}/fail`, body: {} }, context))
        .resolves.toMatchObject({ ok: false, errorCode: 'webhook_failed', details: { status: 302, body: 'moved' } });
      expect(requests).toEqual([{ key: 'run/step/0', body: '{"text":"literal","count":1}' },
        { key: 'run/step/0', body: '{}' }]);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});

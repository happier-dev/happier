import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { waitForSessionIdle } from './waitForSessionIdle';

describe('idle observation lifetime', () => {
  it('settles its own deadline during lookup before a socket can be opened', async () => {
    let requested = false;
    const server = createServer((request) => { requested = true; request.resume(); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    try {
      await expect(runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, () => waitForSessionIdle({
        credentials: { token: 'boundary-token', encryption: null }, idOrPrefix: 'session-created', timeoutMs: 100,
      }))).resolves.toMatchObject({ ok: false, code: 'timeout' });
      expect(requested).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 4000);
});

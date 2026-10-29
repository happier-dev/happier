import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';

import { fetchNodeRuntimeReleaseAsset } from './nodeRelease.js';

describe('managed Node release metadata cancellation', () => {
  it.each(['index', 'checksums'])('cancels a stalled %s body', async (phase) => {
    const controller = new AbortController();
    const reason = new Error('stop metadata');
    const server = createServer((req, res) => {
      if (phase === 'checksums' && req.url === '/index.json') {
        res.end(JSON.stringify([{ version: 'v24.0.0', lts: 'Krypton' }]));
        return;
      }
      res.writeHead(200);
      res.write(phase === 'index' ? '[' : 'abc');
      setTimeout(() => controller.abort(reason), 25);
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
      await expect(Promise.race([
        fetchNodeRuntimeReleaseAsset({
          processEnv: {}, signal: controller.signal,
          fetchImpl: (url, init) => fetch(`http://127.0.0.1:${address.port}/${String(url).split('/').at(-1)}`, init),
        }),
        new Promise<never>((_resolve, reject) => { watchdog = setTimeout(() => reject(new Error('metadata did not cancel')), 500); }),
      ])).rejects.toBe(reason);
    } finally {
      clearTimeout(watchdog);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

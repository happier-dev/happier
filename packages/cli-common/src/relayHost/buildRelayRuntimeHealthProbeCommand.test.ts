import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { buildRelayRuntimeHealthProbeCommand } from './buildRelayRuntimeHealthProbeCommand.js';

describe('buildRelayRuntimeHealthProbeCommand', () => {
  it('produces a shell command that exits 0 once the configured health path responds', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/v1/version') {
        res.statusCode = 200;
        res.end('ok');
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Unexpected http server address');
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const command = buildRelayRuntimeHealthProbeCommand({
        baseUrl,
        path: '/v1/version',
        maxAttempts: 2,
        sleepSeconds: 0,
      });
      const child = spawn('bash', ['-c', command], { stdio: 'ignore' });
      const status = await new Promise<number | null>((resolve) => {
        child.on('exit', (code) => resolve(code));
      });
      expect(status).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('produces a shell command that exits non-zero when the health path never becomes ready', () => {
    const command = buildRelayRuntimeHealthProbeCommand({
      baseUrl: 'http://127.0.0.1:9',
      path: '/v1/version',
      maxAttempts: 1,
      sleepSeconds: 0,
    });
    const result = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
  });

  it('supports a custom health path', () => {
    const command = buildRelayRuntimeHealthProbeCommand({
      baseUrl: 'http://127.0.0.1:3005',
      path: '/v1/version',
      maxAttempts: 1,
      sleepSeconds: 0,
    });

    expect(command).toContain("HEALTH_URL='http://127.0.0.1:3005/v1/version'");
  });
});

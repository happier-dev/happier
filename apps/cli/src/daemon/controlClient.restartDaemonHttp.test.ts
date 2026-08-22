import http from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { clearDaemonStateForTestTeardown, writeDaemonState } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

function listen(server: http.Server): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('unexpected server address'));
        return;
      }
      resolve({ port: addr.port });
    });
  });
}

async function readReqBody(req: http.IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

describe('daemon control client: restartDaemonHttp', () => {
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  let tmpHomeDir: string | null = null;

  afterEach(async () => {
    await clearDaemonStateForTestTeardown();
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    reloadConfiguration();
    if (tmpHomeDir) {
      await removeTempDir(tmpHomeDir);
      tmpHomeDir = null;
    }
  });

  it('POSTs /restart with the stored daemon control token and an empty body', async () => {
    let observed: { token: string; body: string } | null = null;

    const server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/restart') {
        observed = {
          token: String(req.headers['x-happier-daemon-token'] ?? ''),
          body: await readReqBody(req),
        };
        res.statusCode = 202;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'restarting' }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    try {
      const { port } = await listen(server);
      const controlClient = await import('@/daemon/controlClient');
      const restartDaemonHttp = (controlClient as typeof controlClient & {
        restartDaemonHttp?: () => Promise<unknown>;
      }).restartDaemonHttp;

      tmpHomeDir = await createTempDir('happier-daemon-client-restart-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      expect(restartDaemonHttp).toBeTypeOf('function');
      const result = await restartDaemonHttp!();

      expect(result).toEqual({ status: 'restarting' });
      expect(observed).toEqual({
        token: 'test-token',
        body: JSON.stringify({}),
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

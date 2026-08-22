import http from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { clearDaemonStateForTestTeardown, writeDaemonState } from '@/persistence';
import { stopDaemonHttp, stopDaemonSession } from '@/daemon/controlClient';
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

function requireObserved(value: { token: string; body: string } | null): { token: string; body: string } {
  if (!value) throw new Error('expected /stop request to be observed');
  return value;
}

describe('daemon control client: stopDaemonHttp', () => {
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

  it('POSTs /stop with the requested session-stop intent', async () => {
    let observed: { token: string; body: string } | null = null;

    const server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/stop') {
        const token = String(req.headers['x-happier-daemon-token'] ?? '');
        const body = await readReqBody(req);
        observed = { token, body };
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'stopping' }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    try {
      const { port } = await listen(server);

      tmpHomeDir = await createTempDir('happier-daemon-client-stop-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      await stopDaemonHttp({
        stopSessions: true,
      });

      const req = requireObserved(observed);
      expect(req.token).toBe('test-token');
      expect(JSON.parse(req.body)).toEqual({
        stopSessions: true,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns the daemon typed physical stop outcome without boolean collapse', async () => {
    const server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/stop-session') {
        await readReqBody(req);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'incomplete', reason: 'runner_exit_timeout' }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    try {
      const { port } = await listen(server);
      tmpHomeDir = await createTempDir('happier-daemon-client-stop-session-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      await expect(stopDaemonSession('sess-1')).resolves.toEqual({
        status: 'incomplete',
        reason: 'runner_exit_timeout',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

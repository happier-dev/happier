import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { clearDaemonState, writeDaemonState } from '@/persistence';
import { stopDaemonHttp } from '@/daemon/controlClient';

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
  let tmpHomeDir: string | null = null;

  afterEach(async () => {
    await clearDaemonState();
    delete process.env.HAPPIER_HOME_DIR;
    reloadConfiguration();
    if (tmpHomeDir) {
      await rm(tmpHomeDir, { recursive: true, force: true });
      tmpHomeDir = null;
    }
  });

  it('POSTs /stop with stopSessions when requested', async () => {
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

      tmpHomeDir = await mkdtemp(`${process.env.TMPDIR ?? '/tmp'}/happier-daemon-client-stop-test-`);
      process.env.HAPPIER_HOME_DIR = tmpHomeDir;
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      await stopDaemonHttp({ stopSessions: true });

      const req = requireObserved(observed);
      expect(req.token).toBe('test-token');
      expect(JSON.parse(req.body)).toEqual({ stopSessions: true });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

import http from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { clearDaemonStateForTestTeardown, writeDaemonState } from '@/persistence';
import {
  ensureDaemonSshTunnel,
  listDaemonSshTunnels,
  probeDaemonSshTunnel,
  releaseDaemonSshTunnel,
  stopDaemonSshTunnel,
} from '@/daemon/controlClient';
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

async function readReqBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(JSON.parse(body || '{}') as Record<string, unknown>));
    req.on('error', reject);
  });
}

describe('daemon control client: SSH tunnel endpoints', () => {
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

  it('uses the local daemon control path for ensure/list/probe/release/stop', async () => {
    const observed: Array<{ url: string; token: string; body: Record<string, unknown> }> = [];
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || !req.url?.startsWith('/ssh-tunnels/')) {
        res.statusCode = 404;
        res.end();
        return;
      }
      observed.push({
        url: req.url,
        token: String(req.headers['x-happier-daemon-token'] ?? ''),
        body: await readReqBody(req),
      });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      if (req.url === '/ssh-tunnels/ensure') {
        res.end(JSON.stringify({
          ok: true,
          lease: {
            leaseId: 'lease-1',
            tunnelKey: 'ssh-tunnel:abc',
            httpBaseUrl: 'http://127.0.0.1:49152',
            localPort: 49152,
            remoteHost: '127.0.0.1',
            remotePort: 8787,
            expiresAt: null,
            status: 'available',
          },
        }));
        return;
      }
      if (req.url === '/ssh-tunnels/list') {
        res.end(JSON.stringify({ ok: true, tunnels: [] }));
        return;
      }
      if (req.url === '/ssh-tunnels/probe') {
        res.end(JSON.stringify({ ok: true, health: { state: 'healthy', checkedAt: '2026-05-06T00:00:00.000Z' } }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });

    try {
      const { port } = await listen(server);
      tmpHomeDir = await createTempDir('happier-daemon-client-ssh-tunnels-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      await expect(ensureDaemonSshTunnel({
        ssh: { target: 'dev@example.test', auth: 'agent' },
        remoteHost: '127.0.0.1',
        remotePort: 8787,
        purpose: 'remote-host-access',
      })).resolves.toEqual(expect.objectContaining({ ok: true }));
      await expect(listDaemonSshTunnels()).resolves.toEqual({ ok: true, tunnels: [] });
      await expect(probeDaemonSshTunnel('ssh-tunnel:abc')).resolves.toEqual(expect.objectContaining({ ok: true }));
      await expect(releaseDaemonSshTunnel('lease-1')).resolves.toEqual({ ok: true });
      await expect(stopDaemonSshTunnel('ssh-tunnel:abc')).resolves.toEqual({ ok: true });

      expect(observed.map((request) => request.url)).toEqual([
        '/ssh-tunnels/ensure',
        '/ssh-tunnels/list',
        '/ssh-tunnels/probe',
        '/ssh-tunnels/release',
        '/ssh-tunnels/stop',
      ]);
      expect(observed.every((request) => request.token === 'test-token')).toBe(true);
      expect(observed[0]?.body).toEqual(expect.objectContaining({
        remoteHost: '127.0.0.1',
        remotePort: 8787,
        purpose: 'remote-host-access',
      }));
      expect(observed[2]?.body).toEqual({ tunnelKey: 'ssh-tunnel:abc' });
      expect(observed[3]?.body).toEqual({ leaseId: 'lease-1' });
      expect(observed[4]?.body).toEqual({ tunnelKey: 'ssh-tunnel:abc' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

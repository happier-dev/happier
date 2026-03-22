import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { reloadConfiguration } from '@/configuration';
import { writeDaemonState, clearDaemonState } from '@/persistence';
import { spawnDaemonSession } from '@/daemon/controlClient';
import type { SpawnDaemonSessionRequest } from '@/rpc/handlers/spawnSessionOptionsContract';
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

describe('daemon control client (HTTP error responses)', () => {
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  let tmpHomeDir: string | null = null;

  afterEach(async () => {
    await clearDaemonState();
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    reloadConfiguration();
    if (tmpHomeDir) {
      await removeTempDir(tmpHomeDir);
      tmpHomeDir = null;
    }
  });

  it('returns parsed 409 payload from /spawn-session (directory approval flow)', async () => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/spawn-session') {
        res.statusCode = 409;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            success: false,
            requiresUserApproval: true,
            actionRequired: 'CREATE_DIRECTORY',
            directory: '/tmp',
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    try {
      const { port } = await listen(server);

      tmpHomeDir = await createTempDir('happier-daemon-client-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      await expect(spawnDaemonSession('/tmp')).resolves.toEqual({
        success: false,
        requiresUserApproval: true,
        actionRequired: 'CREATE_DIRECTORY',
        directory: '/tmp',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns parsed 500 payload from /spawn-session (structured daemon error)', async () => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/spawn-session') {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            success: false,
            error: 'Failed to spawn session: boom',
            errorCode: 'SPAWN_FAILED',
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    try {
      const { port } = await listen(server);

      tmpHomeDir = await createTempDir('happier-daemon-client-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      await expect(spawnDaemonSession('/tmp')).resolves.toEqual({
        success: false,
        error: 'Failed to spawn session: boom',
        errorCode: 'SPAWN_FAILED',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('posts canonical spawn request bodies to /spawn-session without rebuilding a stale field list', async () => {
    let observedBody: Record<string, unknown> | null = null;

    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/spawn-session') {
        let rawBody = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          rawBody += chunk;
        });
        req.on('end', () => {
          observedBody = JSON.parse(rawBody) as Record<string, unknown>;
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ success: true, sessionId: 'sess-1' }));
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    try {
      const { port } = await listen(server);

      tmpHomeDir = await createTempDir('happier-daemon-client-test-');
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        controlToken: 'test-token',
      });

      const spawnRequest: SpawnDaemonSessionRequest = {
        directory: '/tmp',
        existingSessionId: 'sess-existing',
        spawnNonce: 'spawn-nonce-1',
        transcriptStorage: 'direct',
        mcpSelection: {
          v: 1,
          managedServersEnabled: false,
          forceIncludeServerIds: ['server-portable'],
          forceExcludeServerIds: ['server-disabled'],
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            anthropic: { source: 'connected', profileId: 'work' },
          },
        },
      };

      await expect(spawnDaemonSession(spawnRequest)).resolves.toEqual({
        success: true,
        sessionId: 'sess-1',
      });
      expect(observedBody).toEqual(spawnRequest);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

import http from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import {
  admitDaemonForegroundAgentRuntime,
} from '@/daemon/controlClient';
import { clearDaemonState, writeDaemonState } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

function listen(server: http.Server): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('unexpected server address'));
        return;
      }
      resolve({ port: address.port });
    });
  });
}

describe('daemon control client: foreground Agent runtime admission', () => {
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

  it('normalizes an older daemon without the admission route to a typed refusal', async () => {
    const server = http.createServer((_request, response) => {
      response.statusCode = 404;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'route_not_found' }));
    });

    try {
      const { port } = await listen(server);
      tmpHomeDir = await createTempDir(
        'happier-foreground-admission-client-',
      );
      envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
      reloadConfiguration();
      writeDaemonState({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'older-test',
        controlToken: 'control-token',
      });

      await expect(admitDaemonForegroundAgentRuntime({
        v: 1,
        attemptId: 'attempt-1',
        sessionId: 'session-1',
        foregroundPid: process.pid,
        directory: '/workspace',
        agentId: 'codex',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
      })).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'provider_agent_runtime_unsupported',
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

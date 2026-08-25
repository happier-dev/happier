import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

describe('happier session list API Token timeout', () => {
  const envKeys = [
    'HAPPIER_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_HOME_DIR',
    'HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';
  let actionRequest: Record<string, unknown> | null = null;
  let resolveActionRequestClosed: (() => void) | null = null;
  let actionRequestClosed: Promise<void>;

  beforeEach(async () => {
    actionRequest = null;
    actionRequestClosed = new Promise<void>((resolve) => {
      resolveActionRequestClosed = resolve;
    });
    happyHomeDir = await createTempDir('happier-cli-session-list-pat-timeout-');
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
      if (request.method !== 'POST' || url.pathname !== '/v1/actions/session.list') {
        response.statusCode = 404;
        response.end();
        return;
      }

      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        actionRequest = JSON.parse(body) as Record<string, unknown>;
      });
      response.once('close', () => {
        resolveActionRequestClosed?.();
      });
      // Intentionally leave the request unanswered: this is the failed public
      // Action relay shape that previously kept the CLI alive indefinitely.
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve session-list API Token test server address');
    }

    envScope.patch({
      HAPPIER_SERVER_URL: `http://127.0.0.1:${address.port}`,
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000',
      HAPPIER_LOCAL_SERVER_URL: undefined,
      HAPPIER_PUBLIC_SERVER_URL: undefined,
      HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_HOME_DIR: happyHomeDir,
      HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS: '1000',
    });
    const { reloadConfiguration, configuration } = await import('@/configuration');
    reloadConfiguration();
    const { readSettings, writeSettings } = await import('@/persistence');
    const settings = await readSettings();
    await writeSettings({
      ...settings,
      machineIdByServerId: {
        ...(settings.machineIdByServerId ?? {}),
        [configuration.activeServerId]: 'machine-session-list',
      },
    });
  });

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = null;
    if (happyHomeDir) {
      await removeTempDir(happyHomeDir);
      happyHomeDir = '';
    }
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('cancels an unanswered PAT Action relay and returns a timeout envelope', async () => {
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleJsonOutput();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await handleSessionCommand(['list', '--limit', '1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'hap_v1_fixture_token',
          encryption: null,
          credentialProvenance: 'api_token',
        }),
      });

      await expect(actionRequestClosed).resolves.toBeUndefined();
      expect(actionRequest).toEqual({
        v: 1,
        target: { kind: 'machine', machineId: 'machine-session-list' },
        input: { limit: 1 },
      });
      expect(output.json()).toEqual(expect.objectContaining({
        ok: false,
        kind: 'session_list',
        error: expect.objectContaining({ code: 'timeout' }),
      }));
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });
});

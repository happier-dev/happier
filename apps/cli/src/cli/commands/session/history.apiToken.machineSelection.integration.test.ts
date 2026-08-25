import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

describe('happier session history API Token machine selection', () => {
  const envKeys = [
    'HAPPIER_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_HOME_DIR',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';
  let actionRequest: Record<string, unknown> | null = null;

  beforeEach(async () => {
    actionRequest = null;
    happyHomeDir = await createTempDir('happier-cli-session-history-pat-machine-selection-');
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
      if (request.method === 'POST' && url.pathname === '/v1/actions/session.transcript.get') {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          body += chunk;
        });
        request.on('end', () => {
          actionRequest = JSON.parse(body) as Record<string, unknown>;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({
            v: 1,
            actionId: 'session.transcript.get',
            execution: {
              ok: true,
              result: {
                ok: true,
                sessionId: 'c123456789012345678901234',
                items: [],
                nextCursor: null,
                hasMore: false,
                diagnostics: {
                  rawRowsScanned: 0,
                  pagesFetched: 1,
                  scanLimitReached: false,
                  payloadTruncations: 0,
                },
              },
            },
          }));
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve session-history API Token test server address');
    }

    envScope.patch({
      HAPPIER_SERVER_URL: `http://127.0.0.1:${address.port}`,
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:3000',
      HAPPIER_LOCAL_SERVER_URL: undefined,
      HAPPIER_PUBLIC_SERVER_URL: undefined,
      HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_HOME_DIR: happyHomeDir,
    });
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  afterEach(async () => {
    if (server) {
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

  it('reads an inactive Session transcript through the explicitly selected machine', async () => {
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand([
        'history',
        'c123456789012345678901234',
        '--machine-id',
        'machine-remote',
        '--tail',
        '10',
        '--json',
      ], {
        readCredentialsFn: async () => ({
          token: 'hap_v1_fixture_token',
          encryption: null,
          credentialProvenance: 'api_token',
        }),
      });

      expect(actionRequest).toEqual({
        v: 1,
        target: { kind: 'machine', machineId: 'machine-remote' },
        input: {
          sessionId: 'c123456789012345678901234',
          limit: 10,
          scope: 'all',
          includeTools: true,
          includeReasoning: true,
          includeEvents: true,
          includeRaw: true,
          maxRawPayloadChars: 32768,
        },
      });
      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_history',
        data: expect.objectContaining({
          sessionId: 'c123456789012345678901234',
          messages: [],
        }),
      }));
    } finally {
      output.restore();
    }
  });
});

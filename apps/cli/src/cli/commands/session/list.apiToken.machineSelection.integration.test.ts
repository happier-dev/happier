import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

describe('happier session list API Token machine selection', () => {
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
  let machineInventoryRequestCount = 0;
  let rejectMachineInventory = false;

  beforeEach(async () => {
    actionRequest = null;
    machineInventoryRequestCount = 0;
    rejectMachineInventory = false;
    happyHomeDir = await createTempDir('happier-cli-session-list-pat-machine-selection-');
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
      if (request.method === 'GET' && url.pathname === '/v1/machines') {
        machineInventoryRequestCount += 1;
        if (rejectMachineInventory) {
          response.statusCode = 503;
          response.end();
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify([{
          id: 'machine-remote',
          active: true,
          revokedAt: null,
          replacedByMachineId: null,
        }]));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/actions/session.list') {
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
            actionId: 'session.list',
            execution: {
              ok: true,
              result: { sessions: [], nextCursor: null, hasNext: false },
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
      throw new Error('Failed to resolve session-list API Token test server address');
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

  it('uses the sole current machine for the first-class list command when a PAT has no daemon-local target', async () => {
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['list', '--limit', '1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'hap_v1_fixture_token',
          encryption: null,
          credentialProvenance: 'api_token',
        }),
      });

      expect(actionRequest).toEqual({
        v: 1,
        target: { kind: 'machine', machineId: 'machine-remote' },
        input: { limit: 1 },
      });
      expect(machineInventoryRequestCount).toBe(1);
      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_list',
        data: { sessions: [], nextCursor: null, hasNext: false },
      }));
    } finally {
      output.restore();
    }
  });

  it('routes an explicit machine id to the Action when account inventory is unavailable', async () => {
    rejectMachineInventory = true;
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['list', '--machine-id', 'machine-explicit', '--limit', '1', '--json'], {
        readCredentialsFn: async () => ({
          token: 'hap_v1_fixture_token',
          encryption: null,
          credentialProvenance: 'api_token',
        }),
      });

      expect(machineInventoryRequestCount).toBe(0);
      expect(actionRequest).toEqual({
        v: 1,
        target: { kind: 'machine', machineId: 'machine-explicit' },
        input: { limit: 1 },
      });
      expect(output.json()).toEqual(expect.objectContaining({
        ok: true,
        kind: 'session_list',
        data: { sessions: [], nextCursor: null, hasNext: false },
      }));
    } finally {
      output.restore();
    }
  });
});

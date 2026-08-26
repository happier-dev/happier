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
  let actionResponder: ((actionId: string, body: Record<string, unknown>) => unknown) | null = null;

  beforeEach(async () => {
    actionRequest = null;
    actionResponder = null;
    happyHomeDir = await createTempDir('happier-cli-session-history-pat-machine-selection-');
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
      if (request.method === 'POST' && url.pathname.startsWith('/v1/actions/')) {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          body += chunk;
        });
        request.on('end', () => {
          actionRequest = JSON.parse(body) as Record<string, unknown>;
          const actionId = decodeURIComponent(url.pathname.slice('/v1/actions/'.length));
          const result = actionResponder?.(actionId, actionRequest)
            ?? (actionId === 'session.transcript.get'
              ? {
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
                }
              : null);
          if (result === null) {
            response.statusCode = 404;
            response.end();
            return;
          }
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({
            v: 1,
            actionId,
            execution: {
              ok: true,
              result,
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

  it('emits PAT-backed follow rows while the Session remains active, then drains and releases after it becomes inactive', async () => {
    const actionIds: string[] = [];
    const actionRequests: Array<Readonly<{ actionId: string; body: Record<string, unknown> }>> = [];
    let followRead = 0;
    let statusRead = 0;
    actionResponder = (actionId, body) => {
      actionIds.push(actionId);
      actionRequests.push({ actionId, body });
      if (actionId === 'transcript.follow') {
        followRead += 1;
        if (followRead === 2) {
          return {
            ok: true,
            leaseId: 'lease-live',
            items: [{
              id: 'row-1',
              seq: 1,
              createdAt: 123,
              role: 'assistant',
              kind: 'assistant_message',
              raw: { role: 'agent', content: { type: 'text', text: 'live message' } },
            }],
            nextCursor: '1',
            truncated: false,
          };
        }
        return {
          ok: true,
          leaseId: 'lease-live',
          items: [],
          nextCursor: followRead === 1 ? '0' : '1',
          truncated: false,
        };
      }
      if (actionId === 'session.status.get') {
        statusRead += 1;
        return {
          ok: true,
          session: {
            id: 'c123456789012345678901234',
            active: statusRead === 1,
          },
        };
      }
      if (actionId === 'transcript.unfollow') {
        return { ok: true, released: true };
      }
      return null;
    };

    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand([
        'history',
        'c123456789012345678901234',
        '--machine-id',
        'machine-remote',
        '--follow',
        '--jsonl',
      ], {
        readCredentialsFn: async () => ({
          token: 'hap_v1_fixture_token',
          encryption: null,
          credentialProvenance: 'api_token',
        }),
      });

      expect(output.logs.map((line) => JSON.parse(line))).toEqual([{
        id: 'row-1',
        seq: 1,
        createdAt: 123,
        role: 'agent',
        kind: 'text',
        text: 'live message',
      }]);
      expect(actionIds).toEqual([
        'transcript.follow',
        'session.status.get',
        'transcript.follow',
        'transcript.follow',
        'session.status.get',
        'transcript.follow',
        'transcript.unfollow',
      ]);
      const followRequests = actionRequests.filter(({ actionId }) => actionId === 'transcript.follow');
      const firstFollowInput = followRequests[0]?.body.input as Record<string, unknown> | undefined;
      const leaseId = firstFollowInput?.leaseId;
      expect(leaseId).toEqual(expect.any(String));
      expect(followRequests.map(({ body }) => body)).toEqual([
        {
          v: 1,
          target: { kind: 'machine', machineId: 'machine-remote' },
          input: { sessionId: 'c123456789012345678901234', cursor: 'tail', leaseId },
        },
        {
          v: 1,
          target: { kind: 'machine', machineId: 'machine-remote' },
          input: { sessionId: 'c123456789012345678901234', cursor: '0', leaseId },
        },
        {
          v: 1,
          target: { kind: 'machine', machineId: 'machine-remote' },
          input: { sessionId: 'c123456789012345678901234', cursor: '1', leaseId },
        },
        {
          v: 1,
          target: { kind: 'machine', machineId: 'machine-remote' },
          input: { sessionId: 'c123456789012345678901234', cursor: '1', leaseId },
        },
      ]);
      expect(actionRequests.at(-1)).toEqual({
        actionId: 'transcript.unfollow',
        body: {
          v: 1,
          requestId: expect.any(String),
          target: { kind: 'machine', machineId: 'machine-remote' },
          input: { sessionId: 'c123456789012345678901234', leaseId },
        },
      });
    } finally {
      output.restore();
    }
  });
});

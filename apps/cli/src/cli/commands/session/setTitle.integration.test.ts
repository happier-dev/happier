import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

const { mockIo } = vi.hoisted(() => ({
  mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

describe('happier session set-title (integration)', () => {
  const envKeys = ['HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_HOME_DIR', 'HAPPIER_ACTIONS_SETTINGS_V1'] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';
  let requireApprovalForCliSurface = false;
  let allowMetadataUpdate = true;
  const createdArtifacts: any[] = [];

  const sessionId = 'sess_integration_set_title_123';

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-set-title-');
    requireApprovalForCliSurface = false;
    allowMetadataUpdate = true;
    createdArtifacts.length = 0;

    const secret = new Uint8Array(32).fill(7);
    const { encodeBase64, encryptLegacy } = await import('@/api/encryption');
    const metadataCiphertext = encodeBase64(
      encryptLegacy({ path: '/tmp', host: 'host1', tag: 'MyTag' }, secret),
      'base64',
    );

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === '/v2/account/settings') {
        const actionsSettings = requireApprovalForCliSurface
          ? {
              v: 1,
              actions: {
                'session.title.set': {
                  enabled: true,
                  disabledSurfaces: [],
                  disabledPlacements: [],
                  approvalRequiredSurfaces: ['cli'],
                },
              },
            }
          : { v: 1, actions: {} };
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          version: 1,
          content: {
            t: 'plain',
            v: {
              schemaVersion: 2,
              actionsSettingsV1: actionsSettings,
            },
          },
        }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/artifacts') {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          try {
            createdArtifacts.push(JSON.parse(body || '{}'));
          } catch {
            createdArtifacts.push({ parseError: true, body });
          }
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ id: createdArtifacts[createdArtifacts.length - 1]?.id ?? null }));
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            session: {
              id: sessionId,
              seq: 1,
              createdAt: 1,
              updatedAt: 2,
              active: false,
              activeAt: 0,
              metadata: metadataCiphertext,
              metadataVersion: 0,
              agentState: null,
              agentStateVersion: 0,
              pendingCount: 0,
              pendingVersion: 0,
              dataEncryptionKey: null,
              share: null,
              archivedAt: null,
            },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to resolve integration server address');

    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    const socket = createApiSessionSocketStub({
      emit: async (event: string, args: unknown[]) => {
        if (event !== 'update-metadata') return;
        if (!allowMetadataUpdate) {
          const [_data, callback] = args as [any, ((value: unknown) => void) | undefined];
          if (typeof callback === 'function') {
            callback({ result: 'error' });
          }
          return;
        }
        const [data, callback] = args as [any, ((value: unknown) => void) | undefined];
        const { decodeBase64, decryptLegacy } = await import('@/api/encryption');
        const decrypted = decryptLegacy(decodeBase64(String(data?.metadata ?? ''), 'base64'), secret);
        expect(decrypted?.summary?.text).toBe('New Title');
        if (typeof callback === 'function') {
          callback({ result: 'success', version: 1, metadata: data.metadata });
        }
      },
    });
    bindApiSessionSocketMock(mockIo, socket);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
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

  it('updates session metadata title via update-metadata socket event', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['set-title', sessionId, 'New Title', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
        }),
      });

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_set_title');
      expect(parsed.data?.sessionId).toBe(sessionId);
      expect(parsed.data?.title).toBe('New Title');
    } finally {
      output.restore();
    }
  });

  it('returns approval_request_created when the CLI surface requires approval', async () => {
    requireApprovalForCliSurface = true;
    allowMetadataUpdate = false;

    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['set-title', sessionId, 'New Title', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
        }),
      });

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_set_title');
      expect(parsed.data).toEqual(expect.objectContaining({
        kind: 'approval_request_created',
        actionId: 'session.title.set',
      }));
      expect(createdArtifacts).toHaveLength(1);
    } finally {
      output.restore();
    }
  });
});

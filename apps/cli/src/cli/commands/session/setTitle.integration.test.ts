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
  const ambiguousPrefix = 'sess_ambiguous_';
  const candidateIds = [ambiguousPrefix + '1', ambiguousPrefix + '2'];
  let titled = false;

  beforeEach(async () => {
    happyHomeDir = await createTempDir('happier-cli-session-set-title-');
    requireApprovalForCliSurface = false;
    allowMetadataUpdate = true;
    titled = false;
    createdArtifacts.length = 0;
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;

    const secret = new Uint8Array(32).fill(7);
    const { encodeBase64, encryptLegacy } = await import('@/api/encryption');
    const metadataCiphertext = () => encodeBase64(
      encryptLegacy({ path: '/tmp', host: 'host1', tag: 'MyTag',
        ...(titled ? { summary: { text: 'Manual title', updatedAt: 1 } } : {}),
      }, secret),
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
      if (req.method === 'GET' && url.pathname === '/v2/sessions') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ sessions: candidateIds.map(id => ({ id, seq: 1, createdAt: 1, updatedAt: 2,
          active: false, activeAt: 0, metadata: metadataCiphertext(), metadataVersion: 0,
          agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
        })), nextCursor: null, hasNext: false }));
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
              metadata: metadataCiphertext(),
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

  it('lets the ordinary CLI replace a titled session through the metadata socket', async () => {
    titled = true;
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

  it('returns the candidate IDs for an ambiguous title target', async () => {
    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['set-title', ambiguousPrefix, 'New Title', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
        }),
      });
      expect(output.json()).toMatchObject({ ok: false, kind: 'session_set_title',
        error: { code: 'session_id_ambiguous', candidates: candidateIds } });
    } finally {
      output.restore();
    }
  });

  it.each([
    { tool: 'change_title', args: { title: 'New Title' } },
    { tool: 'action_execute', args: { actionId: 'session.title.set', input: { title: 'New Title' } } },
  ])('applies initial mode to the explicit session agent bridge through $tool only', async ({ tool, args }) => {
    titled = true;
    const { handleToolsCommand } = await import('../tools');
    const output = captureConsoleJsonOutput();
    const previousExitCode = process.exitCode;
    const command = ['call', '--source', 'happier', '--tool', tool, '--args-json', JSON.stringify(args),
      '--session-id', sessionId, '--json'];
    const deps = { readCredentials: async () => ({
      token: 'token_test',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
    }) };
    try {
      await handleToolsCommand([...command, '--session-agent-bridge'], deps);
      expect(output.json()).toMatchObject({ ok: false, error: { message: 'session_title_updates_disabled' } });
      output.logs.length = 0;
      await handleToolsCommand(command, deps);
      expect(output.json()).toMatchObject({ ok: true });
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
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

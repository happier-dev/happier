import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';

import {
  AccountEncryptionCurrentnessResponseSchema,
  deriveBoxPublicKeyFromSeed,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleJsonOutput, captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';

describe('happier session list (integration)', () => {
  const envKeys = [
    'HAPPIER_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_HOME_DIR',
    'HAPPIER_ACCOUNT_SETTINGS_MODE',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';
  let queryRequests: unknown[] = [];

  const normalSessionId = 'sess_integration_list_123';
  const systemSessionId = 'sess_integration_system_456';
  const archivedSessionId = 'sess_integration_archived_999';

  beforeEach(async () => {
    queryRequests = [];
    process.env.HAPPIER_ACCOUNT_SETTINGS_MODE = 'never';

    happyHomeDir = await createTempDir('happier-cli-session-list-');
    const dek = new Uint8Array(32).fill(3);
    const machineKeySeed = new Uint8Array(32).fill(8);
    const recipientPublicKey = deriveBoxPublicKeyFromSeed(machineKeySeed);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: dek,
      recipientPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });

    const { encodeBase64: encodeBase64Session, encryptWithDataKey } = await import('@/api/encryption');
    const normalMetadata = encodeBase64Session(
      encryptWithDataKey(
        {
          path: '/tmp/happier-session-control-integration',
          flavor: 'claude',
          claudeSessionId: 'claude_vendor_session_1',
          tag: 'MyTag',
          host: 'host1',
          summary: { text: 'My Title', updatedAt: 123 },
        },
        dek,
      ),
      'base64',
    );
    const systemMetadata = encodeBase64Session(
      encryptWithDataKey(
        {
          path: '/tmp/happier-session-control-system',
          flavor: 'claude',
          tag: 'Carrier',
          host: 'host1',
          systemSessionV1: {
            v: 1,
            key: 'voice_carrier',
            hidden: true,
          },
        },
        dek,
      ),
      'base64',
    );
    const archivedMetadata = encodeBase64Session(
      encryptWithDataKey(
        {
          path: '/tmp/happier-session-control-archived',
          flavor: 'claude',
          tag: 'ArchivedTag',
          host: 'host1',
          summary: { text: 'Archived Title', updatedAt: 456 },
        },
        dek,
      ),
      'base64',
    );
    const dataEncryptionKeyBase64 = encodeBase64Session(envelope, 'base64');

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === '/v1/account/encryption/currentness') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(AccountEncryptionCurrentnessResponseSchema.parse({
          mode: 'e2ee', version: 1, signingKeyFingerprint: null,
          contentKeyFingerprint: null, updatedAt: 1,
          recipientEnvelopeReadiness: { status: 'available' },
        })));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v2/sessions/query') {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', () => {
          queryRequests.push(JSON.parse(body));
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            sessions: [],
            nextCursor: null,
            hasNext: false,
            attentionNextCursor: 'cursor_v1_attention-next',
            attentionHasNext: true,
          }));
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === `/v2/sessions`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            sessions: [
              {
                id: normalSessionId,
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: false,
                activeAt: 0,
                metadata: normalMetadata,
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
                pendingCount: 0,
                pendingVersion: 0,
                dataEncryptionKey: dataEncryptionKeyBase64,
                share: null,
              },
              {
                id: systemSessionId,
                seq: 2,
                createdAt: 3,
                updatedAt: 4,
                active: false,
                activeAt: 3,
                metadata: systemMetadata,
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
                pendingCount: 0,
                pendingVersion: 0,
                dataEncryptionKey: dataEncryptionKeyBase64,
                share: null,
              },
            ],
            nextCursor: null,
            hasNext: false,
          }),
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v2/sessions/archived`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            sessions: [
              {
                id: archivedSessionId,
                seq: 3,
                createdAt: 10,
                updatedAt: 11,
                active: false,
                activeAt: 0,
                archivedAt: 12,
                metadata: archivedMetadata,
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
                pendingCount: 0,
                pendingVersion: 0,
                dataEncryptionKey: dataEncryptionKeyBase64,
                share: null,
              },
            ],
            nextCursor: null,
            hasNext: false,
          }),
        );
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to resolve session control integration test server address');
    }

    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;

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

  it('returns a session_list JSON envelope', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['list', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(8)),
            machineKey: new Uint8Array(32).fill(8),
          },
        }),
      });

      const parsed = output.json();
      expect(parsed.v).toBe(1);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_list');
      expect(parsed.data?.sessions?.[0]?.id).toBe('sess_integration_list_123');
      expect(parsed.data?.sessions?.[0]?.tag).toBe('MyTag');
      expect(parsed.data?.sessions?.[0]?.title).toBe('My Title');
      expect(parsed.data?.sessions?.[0]?.host).toBe('host1');
      expect(parsed.data?.sessions?.[0]?.encryption?.type).toBe('dataKey');
      expect(parsed.data?.sessions?.some((s: any) => s.id === systemSessionId)).toBe(false);
    } finally {
      output.restore();
    }
  });

  it('preserves unfinished attention paging in the summary JSON', async () => {
    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['list', '--scope', 'my_work', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });
      const result = output.json();
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(result).toMatchObject({
        ok: true,
        data: {
          sessions: [],
          nextCursor: null,
          hasNext: false,
          attentionNextCursor: 'cursor_v1_attention-next',
          attentionHasNext: true,
          queryVersion: 1,
        },
      });
    } finally {
      output.restore();
    }
  });

  it('emits the marked awareness query page with truthful attention continuation', async () => {
    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['list', '--scope', 'my_work', '--json', '--awareness'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });
      const result = output.json();
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(result.data).toEqual({
        view: 'awareness',
        projectionVersion: 1,
        sessions: [],
        nextCursor: null,
        hasNext: false,
        attentionNextCursor: 'cursor_v1_attention-next',
        attentionHasNext: true,
      });
    } finally {
      output.restore();
    }
  });

  it('continues attention paging independently through the session query endpoint', async () => {
    const { handleSessionCommand } = await import('./index');
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['list', '--attention-cursor', 'cursor_v1_attention-next', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
        }),
      });
      const result = output.json();
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, data: { attentionHasNext: true } });
      expect(queryRequests).toEqual([{
        v: 1, storage: 'active', includeInactive: false, scope: 'my_work',
        attention: 'any', audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, attentionCursor: 'cursor_v1_attention-next',
      }]);
    } finally {
      output.restore();
    }
  });

  it.each([
    ['--attention-cursor', ''],
    ['--attention-cursor', 'garbage'],
    ['--attention-cursor', 'cursor_v1_attention-next', '--cursor', 'cursor_v1_ordinary-next'],
  ])('rejects invalid attention continuation before credentials: %j', async (...flags) => {
    const { handleSessionCommand } = await import('./index');
    let credentialReads = 0;
    const output = captureConsoleJsonOutput();
    try {
      await handleSessionCommand(['list', ...flags, '--json'], {
        readCredentialsFn: async () => { credentialReads += 1; return null; },
      });
      expect(output.json()).toMatchObject({ ok: false });
      expect(credentialReads).toBe(0);
      expect(queryRequests).toEqual([]);
    } finally {
      output.restore();
    }
  });

  it('supports --archived by listing /v2/sessions/archived', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['list', '--archived', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(8)),
            machineKey: new Uint8Array(32).fill(8),
          },
        }),
      });

      const parsed = output.json();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_list');
      expect(parsed.data?.sessions?.[0]?.id).toBe(archivedSessionId);
      expect(parsed.data?.sessions?.[0]?.tag).toBe('ArchivedTag');
      expect(parsed.data?.sessions?.[0]?.title).toBe('Archived Title');
    } finally {
      output.restore();
    }
  });

  it('omits system sessions without --include-system', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleLogAndMuteStdout();

    try {
      await handleSessionCommand(['list'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(8)),
            machineKey: new Uint8Array(32).fill(8),
          },
        }),
      });

      const rendered = output.logs.join('\n');
      expect(rendered).toContain('ID');
      expect(rendered).not.toContain(systemSessionId);
      expect(rendered).toContain(normalSessionId.slice(0, 12));
    } finally {
      output.restore();
    }
  });

  it('includes system sessions with --include-system and marks them in human output', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleLogAndMuteStdout();

    try {
      await handleSessionCommand(['list', '--include-system'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(8)),
            machineKey: new Uint8Array(32).fill(8),
          },
        }),
      });

      const rendered = output.logs.join('\n');
      expect(rendered).toContain('ID');
      expect(rendered).toContain(`system:${'voice_carrier'}`);
      expect(rendered).toContain(systemSessionId.slice(0, 12));
    } finally {
      output.restore();
    }
  });

  it('supports --plain by printing the legacy one-line format', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleLogAndMuteStdout();

    try {
      await handleSessionCommand(['list', '--include-system', '--plain'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(8)),
            machineKey: new Uint8Array(32).fill(8),
          },
        }),
      });

      const rendered = output.logs.join('\n');
      expect(rendered).toContain(systemSessionId);
      expect(rendered).toContain(`system:${'voice_carrier'}`);
      expect(rendered).not.toContain('ID');
    } finally {
      output.restore();
    }
  });

  it('includes system markers in JSON when --include-system is used', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleJsonOutput();

    try {
      await handleSessionCommand(['list', '--include-system', '--json'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(8)),
            machineKey: new Uint8Array(32).fill(8),
          },
        }),
      });

      const parsed = output.json();
      const systemSession = parsed.data?.sessions?.find((session: any) => session.id === systemSessionId);
      expect(systemSession).toMatchObject({
        id: systemSessionId,
        isSystem: true,
        systemPurpose: 'voice_carrier',
      });
    } finally {
      output.restore();
    }
  });

  it('supports --resumable by filtering to vendor-resumable inactive sessions', async () => {
    const { handleSessionCommand } = await import('./index');

    const output = captureConsoleLogAndMuteStdout();

    try {
      await handleSessionCommand(['list', '--resumable'], {
        readCredentialsFn: async () => ({
          token: 'token_test',
          encryption: {
            type: 'dataKey',
            publicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(8)),
            machineKey: new Uint8Array(32).fill(8),
          },
        }),
      });

      const rendered = output.logs.join('\n');
      expect(rendered).toContain('ID');
      expect(rendered).toContain(normalSessionId.slice(0, 12));
      expect(rendered).not.toContain('system:voice_carrier');
      expect(rendered).not.toContain('ArchivedTag');
    } finally {
      output.restore();
    }
  });
});

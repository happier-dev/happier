import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deriveBoxPublicKeyFromSeed,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';

describe('happier session list (integration)', () => {
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
  let server: Server | null = null;
  let happyHomeDir = '';

  const normalSessionId = 'sess_integration_list_123';
  const systemSessionId = 'sess_integration_system_456';
  const archivedSessionId = 'sess_integration_archived_999';

  beforeEach(async () => {
    happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-session-list-'));
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
      await rm(happyHomeDir, { recursive: true, force: true });
    }

    if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = originalServerUrl;
    if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
    if (originalHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHomeDir;

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('returns a session_list JSON envelope', async () => {
    const { handleSessionCommand } = await import('./index');

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      stdout.push(args.join(' '));
    });

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

      const parsed = JSON.parse(stdout.join('\n').trim());
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
      logSpy.mockRestore();
    }
  });

  it('supports --archived by listing /v2/sessions/archived', async () => {
    const { handleSessionCommand } = await import('./index');

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      stdout.push(args.join(' '));
    });

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

      const parsed = JSON.parse(stdout.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_list');
      expect(parsed.data?.sessions?.[0]?.id).toBe(archivedSessionId);
      expect(parsed.data?.sessions?.[0]?.tag).toBe('ArchivedTag');
      expect(parsed.data?.sessions?.[0]?.title).toBe('Archived Title');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('omits system sessions without --include-system', async () => {
    const { handleSessionCommand } = await import('./index');

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      stdout.push(args.join(' '));
    });

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

      expect(stdout.join('\n')).not.toContain(systemSessionId);
      expect(stdout.join('\n')).toContain(normalSessionId);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('includes system sessions with --include-system and marks them in human output', async () => {
    const { handleSessionCommand } = await import('./index');

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      stdout.push(args.join(' '));
    });

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

      expect(stdout.join('\n')).toContain(`system:${'voice_carrier'}`);
      expect(stdout.join('\n')).toContain(systemSessionId);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('includes system markers in JSON when --include-system is used', async () => {
    const { handleSessionCommand } = await import('./index');

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      stdout.push(args.join(' '));
    });

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

      const parsed = JSON.parse(stdout.join('\n').trim());
      const systemSession = parsed.data?.sessions?.find((session: any) => session.id === systemSessionId);
      expect(systemSession).toMatchObject({
        id: systemSessionId,
        isSystem: true,
        systemPurpose: 'voice_carrier',
      });
    } finally {
      logSpy.mockRestore();
    }
  });
});

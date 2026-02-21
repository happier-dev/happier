import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deriveBoxPublicKeyFromSeed,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';

describe('happier session history (integration)', () => {
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
  let server: Server | null = null;
  let happyHomeDir = '';

  beforeEach(async () => {
    happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-session-history-'));

    const sessionId = 'sess_integration_history_123';
    const dek = new Uint8Array(32).fill(3);
    const machineKeySeed = new Uint8Array(32).fill(8);
    const recipientPublicKey = deriveBoxPublicKeyFromSeed(machineKeySeed);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: dek,
      recipientPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });

    const { encodeBase64: encodeBase64Session, encryptWithDataKey } = await import('@/api/encryption');
    const metadataCiphertext = encodeBase64Session(
      encryptWithDataKey(
        {
          path: '/tmp/happier-session-control-integration',
          flavor: 'claude',
        },
        dek,
      ),
      'base64',
    );
    const dataEncryptionKeyBase64 = encodeBase64Session(envelope, 'base64');

    const msg1Ciphertext = encodeBase64Session(
      encryptWithDataKey(
        {
          role: 'agent',
          content: { type: 'text', text: 'hello' },
          meta: {
            happier: {
              kind: 'review_findings.v1',
              payload: { findings: [{ id: 'f1', title: 't', severity: 'warning' }] },
            },
          },
        },
        dek,
      ),
      'base64',
    );

    const sessionRow = {
      id: sessionId,
      seq: 1,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      archivedAt: null,
      metadata: metadataCiphertext,
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 0,
      pendingVersion: 0,
      dataEncryptionKey: dataEncryptionKeyBase64,
      share: null,
    };

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === `/v2/sessions`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            sessions: [
              sessionRow,
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
        res.end(JSON.stringify({ sessions: [], nextCursor: null, hasNext: false }));
        return;
      }
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            session: sessionRow,
          }),
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v1/sessions/${sessionId}/messages`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            messages: [
              {
                seq: 3,
                createdAt: 1700000000000,
                content: { t: 'encrypted', c: msg1Ciphertext },
              },
            ],
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

  it('returns compact history with structuredKind hints', async () => {
    const { handleSessionCommand } = await import('./index');

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      stdout.push(args.join(' '));
    });

    try {
      await handleSessionCommand(
        ['history', 'sess_integration_history_123', '--limit', '10', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: {
              type: 'dataKey',
              publicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(8)),
              machineKey: new Uint8Array(32).fill(8),
            },
          }),
        },
      );
      const parsedDefault = JSON.parse(stdout.join('\n').trim());
      expect(parsedDefault.v).toBe(1);
      expect(parsedDefault.ok).toBe(true);
      expect(parsedDefault.kind).toBe('session_history');
      expect(parsedDefault.data?.format).toBe('compact');
      expect(parsedDefault.data?.sessionId).toBe('sess_integration_history_123');
      expect(parsedDefault.data?.messages?.[0]?.structuredKind).toBe('review_findings.v1');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('accepts <session-id-or-prefix>', async () => {
    const { handleSessionCommand } = await import('./index');

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      stdout.push(args.join(' '));
    });

    try {
      await handleSessionCommand(
        ['history', 'sess_inte', '--limit', '10', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: {
              type: 'dataKey',
              publicKey: deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(8)),
              machineKey: new Uint8Array(32).fill(8),
            },
          }),
        },
      );
      const parsed = JSON.parse(stdout.join('\n').trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('session_history');
      expect(parsed.data?.sessionId).toBe('sess_integration_history_123');
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('happier session history (plaintext integration)', () => {
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
  let server: Server | null = null;
  let happyHomeDir = '';

  beforeEach(async () => {
    happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-session-history-plain-'));

    const sessionId = 'sess_integration_history_plain_123';
    const metadataPlaintext = JSON.stringify({
      path: '/tmp/happier-session-control-integration',
      flavor: 'claude',
    });

    const sessionRow = {
      id: sessionId,
      seq: 1,
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      archivedAt: null,
      encryptionMode: 'plain',
      metadata: metadataPlaintext,
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 0,
      pendingVersion: 0,
      dataEncryptionKey: null,
      share: null,
    };

    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === `/v2/sessions`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            sessions: [
              sessionRow,
            ],
            nextCursor: null,
            hasNext: false,
          }),
        );
        return;
      }
      if (req.method === 'GET' && url.pathname === `/v2/sessions/${sessionId}`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            session: sessionRow,
          }),
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v1/sessions/${sessionId}/messages`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            messages: [
              {
                seq: 3,
                createdAt: 1700000000000,
                content: {
                  t: 'plain',
                  v: {
                    role: 'agent',
                    content: { type: 'text', text: 'hello' },
                    meta: {
                      happier: {
                        kind: 'review_findings.v1',
                        payload: { findings: [{ id: 'f1', title: 't', severity: 'warning' }] },
                      },
                    },
                  },
                },
              },
            ],
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

  it('returns compact history for plaintext sessions', async () => {
    const { handleSessionCommand } = await import('./index');

    const stdout: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      stdout.push(args.join(' '));
    });

    try {
      await handleSessionCommand(
        ['history', 'sess_integration_history_plain_123', '--limit', '10', '--json'],
        {
          readCredentialsFn: async () => ({
            token: 'token_test',
            encryption: {
              type: 'legacy',
              secret: new Uint8Array(32).fill(1),
            },
          }),
        },
      );
      const parsedDefault = JSON.parse(stdout.join('\n').trim());
      expect(parsedDefault.ok).toBe(true);
      expect(parsedDefault.kind).toBe('session_history');
      expect(parsedDefault.data?.format).toBe('compact');
      expect(parsedDefault.data?.sessionId).toBe('sess_integration_history_plain_123');
      expect(parsedDefault.data?.messages?.[0]?.structuredKind).toBe('review_findings.v1');
    } finally {
      logSpy.mockRestore();
    }
  });
});

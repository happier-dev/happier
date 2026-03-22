import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServer, type Server } from 'node:http';

import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { z } from 'zod';

import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import type { Credentials } from '@/persistence';

const { mockIo, readCredentialsMock } = vi.hoisted(() => ({
  mockIo: vi.fn(),
  readCredentialsMock: vi.fn<() => Promise<Credentials | null>>(async () => null),
}));

vi.mock('socket.io-client', () => ({
  io: mockIo,
}));

vi.mock('@/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence')>();
  return {
    ...actual,
    readCredentials: readCredentialsMock,
  };
});

describe('daemon.directSessions.link.ensure (integration)', () => {
  const envKeys = [
    'HAPPIER_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_HOME_DIR',
    'HAPPIER_CLAUDE_CONFIG_DIR',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);
  let server: Server | null = null;
  let happyHomeDir = '';

  const sessionsByTag = new Map<string, any>();
  const sessionsById = new Map<string, any>();

  beforeEach(async () => {
    sessionsByTag.clear();
    sessionsById.clear();
    envScope = createEnvKeyScope(envKeys);
    happyHomeDir = await createTempDir('happier-directSessions-linkEnsure-');

    const machineKeySeed = new Uint8Array(32).fill(7);
    readCredentialsMock.mockResolvedValue({
      token: 'token_test',
      encryption: {
        type: 'dataKey',
        publicKey: deriveBoxPublicKeyFromSeed(machineKeySeed),
        machineKey: machineKeySeed,
      },
    });

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

      if (req.method === 'GET' && url.pathname === `/v1/features`) {
        res.statusCode = 404;
        res.end();
        return;
      }

      if (req.method === 'GET' && (url.pathname === `/v2/sessions` || url.pathname === `/v2/sessions/archived`)) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        const sessions = url.pathname === `/v2/sessions` ? Array.from(sessionsByTag.values()) : [];
        res.end(JSON.stringify({ sessions, nextCursor: null, hasNext: false }));
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/v2/sessions/')) {
        const sessionId = decodeURIComponent(url.pathname.slice('/v2/sessions/'.length));
        const session = sessionsById.get(sessionId);
        if (!session) {
          res.statusCode = 404;
          res.end();
          return;
        }

        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session }));
        return;
      }

      if (req.method === 'POST' && url.pathname === `/v1/sessions`) {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const tag = String(body.tag ?? '');

        const existing = sessionsByTag.get(tag);
        if (existing) {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ session: existing }));
          return;
        }

        const session = {
          id: `sess_${sessionsByTag.size + 1}`,
          seq: 1,
          encryptionMode: 'e2ee',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          active: false,
          activeAt: 0,
          metadata: body.metadata,
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          pendingCount: 0,
          pendingVersion: 0,
          dataEncryptionKey: body.dataEncryptionKey ?? null,
          share: null,
        };
        sessionsByTag.set(tag, session);
        sessionsById.set(session.id, session);

        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ session }));
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
      throw new Error('Failed to resolve test server address');
    }

    process.env.HAPPIER_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3000';
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    process.env.HAPPIER_CLAUDE_CONFIG_DIR = '/tmp';

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    mockIo.mockReset();
    bindApiSessionSocketMock(
      mockIo,
      createApiSessionSocketStub({
        emit: async (event, args) => {
          if (event !== 'update-metadata') return;
          const [data, callback] = args;
          const sessionId = String((data as { sid?: unknown })?.sid ?? '');
          const expectedVersion = Number((data as { expectedVersion?: unknown })?.expectedVersion ?? Number.NaN);
          const nextMetadata = String((data as { metadata?: unknown })?.metadata ?? '');
          const session = sessionsById.get(sessionId);
          if (!session || !Number.isFinite(expectedVersion) || typeof callback !== 'function') {
            return;
          }

          session.metadata = nextMetadata;
          session.metadataVersion = Math.max(Number(session.metadataVersion ?? 0), expectedVersion) + 1;
          callback({
            result: 'success',
            version: session.metadataVersion,
            metadata: session.metadata,
          });
        },
      }),
    );
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
    }

    envScope.restore();
    envScope = createEnvKeyScope(envKeys);

    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();
  });

  it('creates a linked direct session row and returns created=true on first call', async () => {
    const { registerMachineDirectSessionsRpcHandlers } = await import('./rpcHandlers.directSessions');

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'machine_1',
      providerId: 'claude',
      remoteSessionId: 'remote_123',
      titleHint: 'Linked Claude Session',
      directoryHint: '/tmp/project-a',
      source: { kind: 'claudeConfig', configDir: '/tmp', projectId: 'proj-a' },
    });

    expect(res.ok).toBe(true);
    expect(res.created).toBe(true);
    expect(typeof res.sessionId).toBe('string');

    const createdSession = Array.from(sessionsByTag.values())[0];
    const creds = await readCredentialsMock();
    const meta = tryDecryptSessionMetadata({ credentials: creds!, rawSession: createdSession });
    const parsedMeta = z.object({
      tag: z.string().min(1),
      path: z.string(),
      name: z.string(),
      directSessionV1: z.object({
        providerId: z.string().min(1),
        remoteSessionId: z.string().min(1),
        machineId: z.string().min(1),
      }).passthrough(),
    }).passthrough().safeParse(meta);
    if (!parsedMeta.success) {
      throw new Error('Expected direct session metadata payload');
    }

    expect(parsedMeta.data.tag).toMatch(/^direct:v1:/);
    expect(parsedMeta.data.name).toBe('Linked Claude Session');
    expect(parsedMeta.data.path).toBe('/tmp/project-a');
    expect(parsedMeta.data.directSessionV1.providerId).toBe('claude');
    expect(parsedMeta.data.directSessionV1.remoteSessionId).toBe('remote_123');
    expect(parsedMeta.data.directSessionV1.machineId).toBe('machine_1');
  });

  it('persists codex backend affinity when linking a codex direct session', async () => {
    const { registerMachineDirectSessionsRpcHandlers } = await import('./rpcHandlers.directSessions');

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'machine_1',
      providerId: 'codex',
      remoteSessionId: 'remote_codex_123',
      titleHint: 'Linked Codex Session',
      directoryHint: '/tmp/project-codex',
      codexBackendMode: 'appServer',
      source: { kind: 'codexHome', home: 'user' },
    });

    expect(res.ok).toBe(true);

    const createdSession = sessionsById.get(res.sessionId);
    const creds = await readCredentialsMock();
    const meta = tryDecryptSessionMetadata({ credentials: creds!, rawSession: createdSession });
    const parsedMeta = z.object({
      codexBackendMode: z.enum(['mcp', 'acp', 'appServer']),
      directSessionV1: z.object({
        providerId: z.literal('codex'),
        codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
      }).passthrough(),
    }).passthrough().safeParse(meta);
    if (!parsedMeta.success) {
      throw new Error('Expected codex direct session metadata payload');
    }

    expect(parsedMeta.data.codexBackendMode).toBe('appServer');
    expect(parsedMeta.data.directSessionV1.codexBackendMode).toBe('appServer');
  });

  it('returns created=false and the same sessionId on repeat calls', async () => {
    const { registerMachineDirectSessionsRpcHandlers } = await import('./rpcHandlers.directSessions');

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE);
    expect(handler).toBeDefined();

    const first = await handler!({
      machineId: 'machine_1',
      providerId: 'claude',
      remoteSessionId: 'remote_123',
      titleHint: 'Linked Claude Session',
      directoryHint: '/tmp/project-a',
      source: { kind: 'claudeConfig', configDir: '/tmp', projectId: 'proj-a' },
    });
    const second = await handler!({
      machineId: 'machine_1',
      providerId: 'claude',
      remoteSessionId: 'remote_123',
      titleHint: 'Linked Claude Session',
      directoryHint: '/tmp/project-a',
      source: { kind: 'claudeConfig', configDir: '/tmp', projectId: 'proj-a' },
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.sessionId).toBe(second.sessionId);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });

  it('refreshes stale missing metadata on repeat link.ensure without creating a new session', async () => {
    const { registerMachineDirectSessionsRpcHandlers } = await import('./rpcHandlers.directSessions');

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE);
    expect(handler).toBeDefined();

    const first = await handler!({
      machineId: 'machine_1',
      providerId: 'claude',
      remoteSessionId: 'remote_123',
      source: { kind: 'claudeConfig', configDir: '/tmp', projectId: 'proj-a' },
    });
    const second = await handler!({
      machineId: 'machine_1',
      providerId: 'claude',
      remoteSessionId: 'remote_123',
      titleHint: 'Recovered Claude Session',
      directoryHint: '/tmp/project-a',
      source: { kind: 'claudeConfig', configDir: '/tmp', projectId: 'proj-a' },
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.sessionId).toBe(second.sessionId);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    const updatedSession = sessionsById.get(first.sessionId);
    const creds = await readCredentialsMock();
    const meta = tryDecryptSessionMetadata({ credentials: creds!, rawSession: updatedSession });
    const parsedMeta = z.object({
      path: z.string(),
      name: z.string(),
    }).passthrough().safeParse(meta);
    if (!parsedMeta.success) {
      throw new Error('Expected updated direct session metadata payload');
    }

    expect(parsedMeta.data.name).toBe('Recovered Claude Session');
    expect(parsedMeta.data.path).toBe('/tmp/project-a');
  });

  it('does not overwrite an existing meaningful title on repeat link.ensure', async () => {
    const { registerMachineDirectSessionsRpcHandlers } = await import('./rpcHandlers.directSessions');

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE);
    expect(handler).toBeDefined();

    const first = await handler!({
      machineId: 'machine_1',
      providerId: 'claude',
      remoteSessionId: 'remote_456',
      titleHint: 'Original Claude Session',
      source: { kind: 'claudeConfig', configDir: '/tmp', projectId: 'proj-b' },
    });
    const second = await handler!({
      machineId: 'machine_1',
      providerId: 'claude',
      remoteSessionId: 'remote_456',
      titleHint: 'Replacement Title Should Not Win',
      directoryHint: '/tmp/project-b',
      source: { kind: 'claudeConfig', configDir: '/tmp', projectId: 'proj-b' },
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.sessionId).toBe(second.sessionId);
    expect(second.created).toBe(false);

    const updatedSession = sessionsById.get(first.sessionId);
    const creds = await readCredentialsMock();
    const meta = tryDecryptSessionMetadata({ credentials: creds!, rawSession: updatedSession });
    const parsedMeta = z.object({
      path: z.string(),
      name: z.string(),
    }).passthrough().safeParse(meta);
    if (!parsedMeta.success) {
      throw new Error('Expected preserved direct session metadata payload');
    }

    expect(parsedMeta.data.name).toBe('Original Claude Session');
    expect(parsedMeta.data.path).toBe('/tmp/project-b');
  });

  it('replaces an existing fallback remote-session title on repeat link.ensure', async () => {
    const { registerMachineDirectSessionsRpcHandlers } = await import('./rpcHandlers.directSessions');

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE);
    expect(handler).toBeDefined();

    const first = await handler!({
      machineId: 'machine_1',
      providerId: 'claude',
      remoteSessionId: 'remote_789',
      titleHint: 'remote_789',
      source: { kind: 'claudeConfig', configDir: '/tmp', projectId: 'proj-c' },
    });

    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);

    const firstSession = sessionsById.get(first.sessionId);
    const creds = await readCredentialsMock();
    const firstMeta = tryDecryptSessionMetadata({ credentials: creds!, rawSession: firstSession });
    const firstParsedMeta = z.object({ name: z.string() }).safeParse(firstMeta);
    if (!firstParsedMeta.success) {
      throw new Error('Expected initial direct session metadata payload');
    }
    expect(firstParsedMeta.data.name).toBe('remote_789');

    const second = await handler!({
      machineId: 'machine_1',
      providerId: 'claude',
      remoteSessionId: 'remote_789',
      titleHint: 'Recovered Claude Session',
      source: { kind: 'claudeConfig', configDir: '/tmp', projectId: 'proj-c' },
    });

    expect(second.ok).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.created).toBe(false);

    const updatedSession = sessionsById.get(first.sessionId);
    const updatedMeta = tryDecryptSessionMetadata({ credentials: creds!, rawSession: updatedSession });
    const updatedParsedMeta = z.object({ name: z.string() }).safeParse(updatedMeta);
    if (!updatedParsedMeta.success) {
      throw new Error('Expected refreshed direct session metadata payload');
    }

    expect(updatedParsedMeta.data.name).toBe('Recovered Claude Session');
  });
});

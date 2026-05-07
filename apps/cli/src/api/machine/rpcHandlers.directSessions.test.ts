import { appendFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { writeFakeCodexAppServerThreadListScript } from '@/backends/codex/appServer/testkit/fakeCodexAppServer';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

const readCredentialsMock = vi.fn();
const fetchSessionByIdMock = vi.fn();
const commitSessionStoredMessageMock = vi.fn();
const updateSessionMetadataWithRetryMock = vi.fn();

vi.mock('@/configuration', () => ({
  configuration: {
    activeServerDir: '/tmp/happier-test-active-server',
    happyHomeDir: '/tmp/happier-test-home',
    logsDir: '/tmp',
    isDaemonProcess: false,
  },
}));

vi.mock('@/persistence', () => ({
  readCredentials: (...args: unknown[]) => readCredentialsMock(...args),
}));

vi.mock('@/session/transport/http/sessionsHttp', async () => {
  const actual = await vi.importActual<typeof import('@/session/transport/http/sessionsHttp')>('@/session/transport/http/sessionsHttp');
  return {
    ...actual,
    fetchSessionById: (...args: unknown[]) => fetchSessionByIdMock(...args),
    commitSessionStoredMessage: (...args: unknown[]) => commitSessionStoredMessageMock(...args),
  };
});

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: (...args: unknown[]) => updateSessionMetadataWithRetryMock(...args),
}));

import { registerMachineDirectSessionsRpcHandlers } from './rpcHandlers.directSessions';

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('registerMachineDirectSessionsRpcHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('takes over a direct claude session using provider cwd and config dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-directSessions-rpc-takeover-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-a', 'sess-claude-direct.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-a'), { recursive: true });
    const resolvedConfigDir = await realpath(configDir).catch(() => configDir);
    await writeFile(
      sessionFile,
      [
        jsonlLine({
          type: 'queue-operation',
          operation: 'enqueue',
          sessionId: 'sess-claude-direct',
        }),
        jsonlLine({
          type: 'queue-operation',
          operation: 'dequeue',
          sessionId: 'sess-claude-direct',
        }),
        jsonlLine({
          type: 'user',
          uuid: 'u1',
          cwd: '/tmp/direct-claude-worktree',
          message: { content: 'hello' },
        }),
      ].join(''),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_happy_direct',
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        claudeSessionId: 'sess-claude-direct',
        directSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-claude-direct',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
          linkedAtMs: Date.now(),
        },
      }),
    });

    const spawnSession = vi.fn(async (_options: SpawnSessionOptions): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'sess_happy_direct',
    }));
    const stopSession = vi.fn(async () => true);
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager, spawnSession, stopSession });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_direct',
    });

    expect(res).toEqual({ ok: true });
    expect(stopSession).not.toHaveBeenCalled();
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: '/tmp/direct-claude-worktree',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        existingSessionId: 'sess_happy_direct',
        resume: 'sess-claude-direct',
        approvedNewDirectoryCreation: true,
        transcriptStorage: 'direct',
        environmentVariables: { CLAUDE_CONFIG_DIR: resolvedConfigDir },
      }),
    );
  });

  it('requires forceStop before taking over when a trusted local runner still owns the provider session', async () => {
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '/tmp/claude-direct');
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_happy_direct_force',
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '/tmp/direct-claude-worktree',
        machineId: 'm1',
        flavor: 'claude',
        claudeSessionId: 'remote_force_stop',
        directSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'remote_force_stop',
          source: { kind: 'claudeConfig', configDir: '/tmp/claude-direct', projectId: null },
          linkedAtMs: Date.now(),
        },
      }),
    });

    const markerDir = join('/tmp/happier-test-home', 'tmp', 'daemon-sessions');
    const markerPath = join(markerDir, `pid-${process.pid}.json`);
    await mkdir(markerDir, { recursive: true });
    await writeFile(markerPath, JSON.stringify({
      pid: process.pid,
      happySessionId: 'sess_other_runner',
      happyHomeDir: '/tmp/happier-test-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      flavor: 'claude',
      metadata: { flavor: 'claude', claudeSessionId: 'remote_force_stop' },
    }), 'utf8');

    const spawnSession = vi.fn(async (_options: SpawnSessionOptions): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'sess_happy_direct_force',
    }));
    const stopSession = vi.fn(async () => true);
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    try {
      registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager, spawnSession, stopSession });

      const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER);
      expect(handler).toBeDefined();

      const res = await handler!({
        machineId: 'm1',
        sessionId: 'sess_happy_direct_force',
      });

      expect(res.ok).toBe(false);
      expect(res.errorCode).toBe('invalid_request');
      expect(String(res.error)).toContain('force');
      expect(stopSession).not.toHaveBeenCalled();
      expect(spawnSession).not.toHaveBeenCalled();
    } finally {
      await rm(markerPath, { force: true });
    }
  });

  it('converts a direct session to persisted mode by importing transcript, then respawning before flipping persisted metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-directSessions-rpc-persist-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-persist', 'sess-claude-persist.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-persist'), { recursive: true });
    await writeFile(
      sessionFile,
      [
        jsonlLine({
          type: 'queue-operation',
          operation: 'enqueue',
          sessionId: 'sess-claude-persist',
        }),
        jsonlLine({
          type: 'queue-operation',
          operation: 'dequeue',
          sessionId: 'sess-claude-persist',
        }),
        jsonlLine({
          type: 'user',
          uuid: 'u1',
          cwd: '/tmp/direct-claude-persist-worktree',
          message: { content: 'hello' },
        }),
        jsonlLine({
          type: 'assistant',
          uuid: 'a1',
          cwd: '/tmp/direct-claude-persist-worktree',
          message: { model: 'm', content: [] },
        }),
      ].join(''),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

    const metadata = {
      path: '',
      machineId: 'm1',
      flavor: 'claude',
      claudeSessionId: 'sess-claude-persist',
      directSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: 'm1',
        remoteSessionId: 'sess-claude-persist',
        source: { kind: 'claudeConfig', configDir, projectId: 'proj-persist' },
        linkedAtMs: Date.now(),
      },
    };

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_happy_persist',
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify(metadata),
    });
    commitSessionStoredMessageMock.mockResolvedValue({
      didWrite: true,
      messageId: 'msg-1',
      seq: 1,
      createdAt: Date.now(),
    });
    updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: { updater: (current: Record<string, unknown>) => Record<string, unknown> }) => ({
      version: 2,
      metadata: updater(metadata),
    }));

    const spawnSession = vi.fn(async (_options: SpawnSessionOptions): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'sess_happy_persist',
    }));
    const stopSession = vi.fn(async () => true);
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager, spawnSession, stopSession });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_persist',
    });

    expect(res).toEqual({ ok: true, converted: true });
    expect(commitSessionStoredMessageMock).toHaveBeenCalledTimes(2);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    expect(spawnSession.mock.invocationCallOrder[0]).toBeLessThan(updateSessionMetadataWithRetryMock.mock.invocationCallOrder[0]);
    expect(spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: '/tmp/direct-claude-persist-worktree',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        existingSessionId: 'sess_happy_persist',
        resume: 'sess-claude-persist',
        approvedNewDirectoryCreation: true,
      }),
    );
    expect(spawnSession).toHaveBeenCalledWith(
      expect.not.objectContaining({
        transcriptStorage: 'direct',
      }),
    );
    const metadataUpdateArgs = updateSessionMetadataWithRetryMock.mock.calls[0]?.[0];
    const updatedMetadata = metadataUpdateArgs?.updater?.(metadata);
    expect(updatedMetadata.directSessionV1).toBeUndefined();
    expect(updatedMetadata.path).toBe('/tmp/direct-claude-persist-worktree');
    expect(updatedMetadata.externalHistoryImportV1).toMatchObject({
      v: 1,
      providerId: 'claude',
      remoteSessionId: 'sess-claude-persist',
      source: { kind: 'claudeConfig', projectId: 'proj-persist' },
    });
  });

  it('does not remove direct-session metadata when persisted respawn fails after import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-directSessions-rpc-persist-fail-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-persist', 'sess-claude-persist.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-persist'), { recursive: true });
    await writeFile(
      sessionFile,
      [
        jsonlLine({ type: 'user', uuid: 'u1', cwd: '/tmp/direct-claude-persist-worktree', message: { content: 'hello' } }),
        jsonlLine({ type: 'assistant', uuid: 'a1', cwd: '/tmp/direct-claude-persist-worktree', message: { model: 'm', content: [] } }),
      ].join(''),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

    const metadata = {
      path: '',
      machineId: 'm1',
      flavor: 'claude',
      claudeSessionId: 'sess-claude-persist',
      directSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: 'm1',
        remoteSessionId: 'sess-claude-persist',
        source: { kind: 'claudeConfig', configDir, projectId: 'proj-persist' },
        linkedAtMs: Date.now(),
      },
    };

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_happy_persist',
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify(metadata),
    });
    commitSessionStoredMessageMock.mockResolvedValue({
      didWrite: true,
      messageId: 'msg-1',
      seq: 1,
      createdAt: Date.now(),
    });

    const spawnSession = vi.fn(async (_options: SpawnSessionOptions): Promise<SpawnSessionResult> => ({
      type: 'error',
      errorCode: 'UNEXPECTED',
      errorMessage: 'persisted_spawn_failed',
    }));
    const stopSession = vi.fn(async () => true);
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager, spawnSession, stopSession });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_persist',
    });

    expect(res).toEqual({ ok: false, errorCode: 'internal_error', error: 'persisted_spawn_failed' });
    expect(commitSessionStoredMessageMock).toHaveBeenCalledTimes(2);
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(updateSessionMetadataWithRetryMock).not.toHaveBeenCalled();
  });

  it('dispatches candidates.list to the claude adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-directSessions-rpc-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-a', 'sess-1.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-a'), { recursive: true });
    await writeFile(sessionFile, jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }), 'utf8');
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      providerId: 'claude',
      source: { kind: 'claudeConfig', configDir, projectId: null },
      limit: 10,
    });

    expect(res.ok).toBe(true);
    expect(res.candidates.map((c: any) => c.remoteSessionId)).toEqual(['sess-1']);
  });

  it('dispatches transcript.page to the claude adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-directSessions-rpc-page-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-a', 'sess-1.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-a'), { recursive: true });
    await writeFile(
      sessionFile,
      [jsonlLine({ type: 'user', uuid: 'u1', message: { content: 'hello' } }), jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } })].join(''),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      providerId: 'claude',
      remoteSessionId: 'sess-1',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
      direction: 'older',
      maxItems: 10,
      maxBytes: 1024 * 1024,
    });

    expect(res.ok).toBe(true);
    expect(res.items.length).toBeGreaterThanOrEqual(2);
    expect(res.items[0].raw.role).toBe('user');
    expect(res.tailCursor).toBeTruthy();
  });

  it('rejects provider/source mismatches as invalid_request', async () => {
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      providerId: 'codex',
      source: { kind: 'claudeConfig', configDir: '/tmp', projectId: null },
      limit: 10,
    });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('invalid_request');
  });

  it('rejects claude source overrides outside the configured config dir', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '/safe/.claude');

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      providerId: 'claude',
      source: { kind: 'claudeConfig', configDir: '/tmp/rogue-claude', projectId: null },
      limit: 10,
    });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('invalid_request');
    expect(String(res.error)).toContain('source');
  });

  it('rejects taking over a linked claude direct session when metadata points at an unconfigured config dir', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '/safe/.claude');

    const root = await mkdtemp(join(tmpdir(), 'happier-directSessions-rpc-takeover-rogue-'));
    const rogueConfigDir = join(root, '.claude-rogue');
    const sessionFile = join(rogueConfigDir, 'projects', 'proj-rogue', 'sess-rogue.jsonl');
    await mkdir(join(rogueConfigDir, 'projects', 'proj-rogue'), { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({
        type: 'user',
        uuid: 'u-rogue',
        cwd: '/tmp/rogue-claude-worktree',
        message: { content: 'hello from rogue source' },
      }),
      'utf8',
    );

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_happy_rogue',
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        claudeSessionId: 'sess-rogue',
        directSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-rogue',
          source: { kind: 'claudeConfig', configDir: rogueConfigDir, projectId: 'proj-rogue' },
          linkedAtMs: Date.now(),
        },
      }),
    });

    const spawnSession = vi.fn(async (_options: SpawnSessionOptions): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'sess_happy_rogue',
    }));
    const stopSession = vi.fn(async () => true);
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager, spawnSession, stopSession });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_rogue',
    });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('invalid_request');
    expect(String(res.error)).toContain('source');
    expect(spawnSession).not.toHaveBeenCalled();
    expect(stopSession).not.toHaveBeenCalled();
  });

  it('reports canTakeOverPersist=false when a linked direct session cannot be resumed safely', async () => {
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '/tmp/claude-direct-status');
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_happy_direct_status',
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        claudeSessionId: 'sess-claude-status',
        directSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-claude-status',
          source: { kind: 'claudeConfig', configDir: '/tmp/claude-direct-status', projectId: 'missing-project' },
          linkedAtMs: Date.now(),
        },
      }),
    });

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_direct_status',
      providerId: 'claude',
      remoteSessionId: 'sess-claude-status',
      source: { kind: 'claudeConfig', configDir: '/tmp/claude-direct-status', projectId: 'missing-project' },
    });

    expect(res.ok).toBe(true);
    expect(res.canTakeOverPersist).toBe(false);
  });

  it('marks claude sessions with recent file activity as active_recently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-directSessions-rpc-status-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-a', 'sess-1.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-a'), { recursive: true });
    await writeFile(sessionFile, jsonlLine({ type: 'user', uuid: 'u1', message: { content: 'hello' } }), 'utf8');
    const expectedMtimeMs = Math.trunc((await stat(sessionFile)).mtimeMs);
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_1',
      providerId: 'claude',
      remoteSessionId: 'sess-1',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-a' },
    });

    expect(res.ok).toBe(true);
    expect(res.activity).toBe('active_recently');
    expect(typeof res.lastKnownActivityAtMs).toBe('number');
    expect(res.lastKnownActivityAtMs).toBe(expectedMtimeMs);
  });

  it('marks codex sessions with recent rollout activity as active_recently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-directSessions-rpc-status-codex-'));
    const codexHome = join(root, '.codex');
    const rolloutFile = join(codexHome, 'sessions', 'rollout-2026-03-05T00-00-00-remote_123.jsonl');
    await mkdir(join(codexHome, 'sessions'), { recursive: true });
    await writeFile(rolloutFile, jsonlLine({ any: 'line' }), 'utf8');
    const expectedMtimeMs = Math.trunc((await stat(rolloutFile)).mtimeMs);
    vi.stubEnv('CODEX_HOME', codexHome);

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_2',
      providerId: 'codex',
      remoteSessionId: 'remote_123',
      source: { kind: 'codexHome', home: 'user' },
    });

    expect(res.ok).toBe(true);
    expect(res.activity).toBe('active_recently');
    expect(res.lastKnownActivityAtMs).toBe(expectedMtimeMs);
  });

  it('marks app-server codex sessions as active_recently from thread metadata when no rollout file exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-directSessions-rpc-status-codex-app-server-'));
    const codexHome = join(root, '.codex');
    const nowUpdatedAtMs = Date.now();
    const nowUpdatedAtSeconds = nowUpdatedAtMs / 1000;
    await mkdir(codexHome, { recursive: true });
    const fakeAppServerPath = await writeFakeCodexAppServerThreadListScript({
      dir: root,
      nonArchivedThreads: [{
        id: 'remote_456',
        updatedAt: nowUpdatedAtSeconds,
        cwd: '/tmp/from-app-server',
      }],
    });
    vi.stubEnv('CODEX_HOME', codexHome);
    vi.stubEnv('HAPPIER_CODEX_APP_SERVER_BIN', fakeAppServerPath);

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_2_app_server',
      providerId: 'codex',
      remoteSessionId: 'remote_456',
      source: { kind: 'codexHome', home: 'user' },
    });

    expect(res.ok).toBe(true);
    expect(res.activity).toBe('active_recently');
    expect(res.lastKnownActivityAtMs).toBe(Math.trunc(nowUpdatedAtMs));
  });

  it('marks opencode sessions as running when /session/status reports busy', async () => {
    let server: Server | null = null;
    try {
      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        if (req.method === 'GET' && url.pathname === '/global/health') {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ healthy: true, version: 'test' }));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/session/status') {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ remote_123: { type: 'busy' } }));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/session') {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify([{ id: 'remote_123', updatedAtMs: Date.now() }]));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('Failed to resolve test server address');
      }
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      vi.stubEnv('HAPPIER_OPENCODE_SERVER_URL', baseUrl);

      const registered = new Map<string, (params: any) => Promise<any>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
          registered.set(method, handler);
        },
      } as any;

      registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

      const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET);
      expect(handler).toBeDefined();

      const res = await handler!({
        machineId: 'm1',
        sessionId: 'sess_happy_3',
        providerId: 'opencode',
        remoteSessionId: 'remote_123',
        source: { kind: 'opencodeServer', baseUrl, directory: null },
      });

      expect(res.ok).toBe(true);
      expect(res.activity).toBe('running');
    } finally {
      if (server) {
        await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
      }
    }
  });

  it('rejects opencode baseUrl overrides outside the configured server url', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('HAPPIER_OPENCODE_SERVER_URL', 'http://127.0.0.1:4010');

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      providerId: 'opencode',
      remoteSessionId: 'remote_123',
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4999', directory: null },
      cursor: 'tail',
    });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('invalid_request');
    expect(String(res.error)).toContain('source');
  });

  it('emits direct-session transcript deltas for an attached view and stops after detach', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-directSessions-rpc-follow-'));
    const configDir = join(root, '.claude');
    const sessionDir = join(configDir, 'projects', 'proj-follow');
    const sessionFile = join(sessionDir, 'sess-follow.jsonl');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);
    vi.stubEnv('HAPPIER_DIRECT_SESSIONS_FOLLOW_POLL_MS', '10');

    const emitDirectSessionTranscriptUpdate = vi.fn();
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({
      rpcHandlerManager,
      emitDirectSessionTranscriptUpdate,
    });

    const attachHandler = registered.get((RPC_METHODS as any).DAEMON_DIRECT_SESSION_ATTACH);
    const detachHandler = registered.get((RPC_METHODS as any).DAEMON_DIRECT_SESSION_DETACH);
    expect(attachHandler).toBeDefined();
    expect(detachHandler).toBeDefined();

    const attached = await attachHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_follow',
      providerId: 'claude',
      remoteSessionId: 'sess-follow',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-follow' },
      ttlMs: 30_000,
    });

    expect(attached.ok).toBe(true);
    const leaseId = attached.leaseId;
    expect(typeof leaseId).toBe('string');

    await appendFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'hello from push' }] } }),
      'utf8',
    );

    await vi.waitFor(() => {
      expect(emitDirectSessionTranscriptUpdate).toHaveBeenCalledWith(expect.objectContaining({
        type: 'direct-session-transcript-delta',
        sessionId: 'sess_happy_follow',
        truncated: false,
        items: expect.arrayContaining([
          expect.objectContaining({
            raw: expect.objectContaining({
              content: expect.objectContaining({
                data: expect.objectContaining({ uuid: 'a2' }),
              }),
            }),
          }),
        ]),
      }));
    }, { timeout: 1000 });

    const beforeDetachCalls = emitDirectSessionTranscriptUpdate.mock.calls.length;
    const detached = await detachHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_follow',
      leaseId,
    });

    expect(detached).toEqual({ ok: true, detached: true });

    await appendFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a3', message: { model: 'm', content: [{ type: 'text', text: 'after detach' }] } }),
      'utf8',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(emitDirectSessionTranscriptUpdate).toHaveBeenCalledTimes(beforeDetachCalls);
  });

  it('emits direct-session transcript deltas while background follow policy is enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-directSessions-rpc-background-follow-'));
    const configDir = join(root, '.claude');
    const sessionDir = join(configDir, 'projects', 'proj-background-follow');
    const sessionFile = join(sessionDir, 'sess-background-follow.jsonl');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'b1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);
    vi.stubEnv('HAPPIER_DIRECT_SESSIONS_FOLLOW_POLL_MS', '10');

    const metadata = {
      directSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: 'm1',
        remoteSessionId: 'sess-background-follow',
        source: { kind: 'claudeConfig', configDir, projectId: 'proj-background-follow' },
        linkedAtMs: 1,
      },
    };
    readCredentialsMock.mockResolvedValue({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValue({
      id: 'sess_happy_background_follow',
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify(metadata),
    });
    updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: {
      updater: (current: Record<string, unknown>) => Record<string, unknown>;
    }) => ({
      version: 2,
      metadata: updater(metadata),
    }));

    const emitDirectSessionTranscriptUpdate = vi.fn();
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({
      rpcHandlerManager,
      emitDirectSessionTranscriptUpdate,
    });

    const policyHandler = registered.get((RPC_METHODS as any).DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET);
    expect(policyHandler).toBeDefined();

    const enabled = await policyHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_background_follow',
      providerId: 'claude',
      remoteSessionId: 'sess-background-follow',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-background-follow' },
      enabled: true,
    });

    expect(enabled).toEqual(expect.objectContaining({
      ok: true,
      enabled: true,
      leaseActive: true,
    }));

    await appendFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'b2', message: { model: 'm', content: [{ type: 'text', text: 'background push' }] } }),
      'utf8',
    );

    await vi.waitFor(() => {
      expect(emitDirectSessionTranscriptUpdate).toHaveBeenCalledWith(expect.objectContaining({
        type: 'direct-session-transcript-delta',
        sessionId: 'sess_happy_background_follow',
        truncated: false,
        items: expect.arrayContaining([
          expect.objectContaining({
            raw: expect.objectContaining({
              content: expect.objectContaining({
                data: expect.objectContaining({ uuid: 'b2' }),
              }),
            }),
          }),
        ]),
      }));
    }, { timeout: 1000 });

    const callsBeforeDisable = emitDirectSessionTranscriptUpdate.mock.calls.length;
    const disabled = await policyHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_background_follow',
      providerId: 'claude',
      remoteSessionId: 'sess-background-follow',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-background-follow' },
      enabled: false,
    });

    expect(disabled).toEqual(expect.objectContaining({
      ok: true,
      enabled: false,
      leaseActive: false,
    }));

    await appendFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'b3', message: { model: 'm', content: [{ type: 'text', text: 'after disable' }] } }),
      'utf8',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(emitDirectSessionTranscriptUpdate).toHaveBeenCalledTimes(callsBeforeDisable);
  });

  it('persists background-follow policy metadata when enabling follow policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-directSessions-rpc-follow-policy-enable-'));
    const configDir = join(root, '.claude');
    const sessionDir = join(configDir, 'projects', 'proj-follow-policy-enable');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'sess-follow-policy-enable.jsonl'),
      jsonlLine({ type: 'assistant', uuid: 'p1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

    const metadata = {
      directSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: 'm1',
        remoteSessionId: 'sess-follow-policy-enable',
        source: { kind: 'claudeConfig', configDir, projectId: 'proj-follow-policy-enable' },
        linkedAtMs: 1,
      },
    };
    readCredentialsMock.mockResolvedValue({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValue({
      id: 'sess_happy_follow_policy_enable',
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify(metadata),
    });
    updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: {
      updater: (current: Record<string, unknown>) => Record<string, unknown>;
    }) => ({
      version: 2,
      metadata: updater(metadata),
    }));

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const policyHandler = registered.get((RPC_METHODS as any).DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET);
    expect(policyHandler).toBeDefined();

    const enabled = await policyHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_follow_policy_enable',
      providerId: 'claude',
      remoteSessionId: 'sess-follow-policy-enable',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-follow-policy-enable' },
      enabled: true,
    });

    expect(enabled).toEqual(expect.objectContaining({
      ok: true,
      enabled: true,
      leaseActive: true,
    }));
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    const updateArgs = updateSessionMetadataWithRetryMock.mock.calls[0]?.[0];
    const nextMetadata = updateArgs.updater(metadata);
    expect(nextMetadata.directSessionV1.followPolicyV1).toEqual({
      v: 1,
      policy: 'background_follow',
      updatedAtMs: expect.any(Number),
    });
  });

  it('persists attached-only policy metadata before disabling follow policy', async () => {
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '/tmp');
    const metadata = {
      directSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: 'm1',
        remoteSessionId: 'sess-follow-policy-disable',
        source: { kind: 'claudeConfig', configDir: '/tmp', projectId: 'proj-follow-policy-disable' },
        linkedAtMs: 1,
        followPolicyV1: {
          v: 1,
          policy: 'background_follow',
          updatedAtMs: 10,
        },
      },
    };
    readCredentialsMock.mockResolvedValue({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValue({
      id: 'sess_happy_follow_policy_disable',
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify(metadata),
    });
    updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: {
      updater: (current: Record<string, unknown>) => Record<string, unknown>;
    }) => ({
      version: 2,
      metadata: updater(metadata),
    }));

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const policyHandler = registered.get((RPC_METHODS as any).DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET);
    expect(policyHandler).toBeDefined();

    const disabled = await policyHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_follow_policy_disable',
      providerId: 'claude',
      remoteSessionId: 'sess-follow-policy-disable',
      source: { kind: 'claudeConfig', configDir: '/tmp', projectId: 'proj-follow-policy-disable' },
      enabled: false,
    });

    expect(disabled).toEqual(expect.objectContaining({
      ok: true,
      enabled: false,
      leaseActive: false,
    }));
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    const updateArgs = updateSessionMetadataWithRetryMock.mock.calls[0]?.[0];
    const nextMetadata = updateArgs.updater(metadata);
    expect(nextMetadata.directSessionV1.followPolicyV1).toEqual({
      v: 1,
      policy: 'attached_only',
      updatedAtMs: expect.any(Number),
    });
  });

  it('sets runnerActive=true and activity=running when a happy session runner is active', async () => {
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '/tmp');
    const markerDir = join('/tmp/happier-test-home', 'tmp', 'daemon-sessions');
    const markerPath = join(markerDir, `pid-${process.pid}.json`);
    await mkdir(markerDir, { recursive: true });
    await writeFile(markerPath, JSON.stringify({
      pid: process.pid,
      happySessionId: 'sess_happy_runner',
      happyHomeDir: '/tmp/happier-test-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      flavor: 'claude',
      metadata: { flavor: 'claude', claudeSessionId: 'sess-1' },
    }), 'utf8');

    try {
      const registered = new Map<string, (params: any) => Promise<any>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
          registered.set(method, handler);
        },
      } as any;

      registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

      const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET);
      expect(handler).toBeDefined();

      const res = await handler!({
        machineId: 'm1',
        sessionId: 'sess_happy_runner',
        providerId: 'claude',
        remoteSessionId: 'sess-1',
        source: { kind: 'claudeConfig', configDir: '/tmp', projectId: null },
      });

      expect(res.ok).toBe(true);
      expect(res.runnerActive).toBe(true);
      expect(res.activity).toBe('running');
      expect(res.canTakeOverDirect).toBe(false);
    } finally {
      await rm(markerPath, { force: true });
    }
  });

  it('sets canForceStop=true when a trusted happy runner pid matches the provider session id', async () => {
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '/tmp');
    const markerDir = join('/tmp/happier-test-home', 'tmp', 'daemon-sessions');
    const markerPath = join(markerDir, `pid-${process.pid}.json`);
    await mkdir(markerDir, { recursive: true });
    await writeFile(markerPath, JSON.stringify({
      pid: process.pid,
      happySessionId: 'sess_other',
      happyHomeDir: '/tmp/happier-test-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      flavor: 'claude',
      metadata: { flavor: 'claude', claudeSessionId: 'remote_force_stop' },
    }), 'utf8');

    try {
      const registered = new Map<string, (params: any) => Promise<any>>();
      const rpcHandlerManager = {
        registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
          registered.set(method, handler);
        },
      } as any;

      registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

      const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET);
      expect(handler).toBeDefined();

      const res = await handler!({
        machineId: 'm1',
        sessionId: 'sess_happy_direct',
        providerId: 'claude',
        remoteSessionId: 'remote_force_stop',
        source: { kind: 'claudeConfig', configDir: '/tmp', projectId: null },
      });

      expect(res.ok).toBe(true);
      expect(res.runnerActive).toBe(false);
      expect(res.canForceStop).toBe(true);
      expect(res.trustedPid).toBe(process.pid);
    } finally {
      await rm(markerPath, { force: true });
    }
  });
});

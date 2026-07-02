import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { writeFakeCodexAppServerThreadListScript } from '@/backends/codex/appServer/testkit/fakeCodexAppServer';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

const {
  readCredentialsMock,
  fetchSessionByIdMock,
  commitSessionStoredMessageMock,
  updateSessionMetadataWithRetryMock,
  dispatchActivityNotificationAsyncMock,
  getActiveAccountSettingsSnapshotMock,
  createManagedExternalSessionFollowLeaseMock,
} = vi.hoisted(() => ({
  readCredentialsMock: vi.fn(),
  fetchSessionByIdMock: vi.fn(),
  commitSessionStoredMessageMock: vi.fn(),
  updateSessionMetadataWithRetryMock: vi.fn(),
  dispatchActivityNotificationAsyncMock: vi.fn(async () => ({
    attemptedChannels: 1,
    deliveredChannels: 1,
  })),
  getActiveAccountSettingsSnapshotMock: vi.fn(),
  createManagedExternalSessionFollowLeaseMock: vi.fn(),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    activeServerDir: '/tmp/happier-test-active-server',
    happyHomeDir: '/tmp/happier-test-home',
    logsDir: '/tmp',
    publicReleaseRing: 'stable',
    isDaemonProcess: false,
  },
}));

vi.mock('@/persistence', () => ({
  readCredentials: readCredentialsMock,
}));

vi.mock('@/session/transport/http/sessionsHttp', async () => {
  const actual = await vi.importActual<typeof import('@/session/transport/http/sessionsHttp')>('@/session/transport/http/sessionsHttp');
  return {
    ...actual,
    fetchSessionById: fetchSessionByIdMock,
    commitSessionStoredMessage: commitSessionStoredMessageMock,
  };
});

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: updateSessionMetadataWithRetryMock,
}));

vi.mock('@/notifications/activity/dispatchActivityNotification', () => ({
  dispatchActivityNotificationAsync: dispatchActivityNotificationAsyncMock,
}));

vi.mock('@/settings/accountSettings/activeAccountSettingsSnapshot', () => ({
  getActiveAccountSettingsSnapshot: getActiveAccountSettingsSnapshotMock,
}));

vi.mock('@/api/session/external/backgroundFollow/createManagedExternalSessionFollowLease', async () => {
  const actual = await vi.importActual<typeof import('@/api/session/external/backgroundFollow/createManagedExternalSessionFollowLease')>(
    '@/api/session/external/backgroundFollow/createManagedExternalSessionFollowLease',
  );
  return {
    ...actual,
    createManagedExternalSessionFollowLease: async (
      ...args: Parameters<typeof actual.createManagedExternalSessionFollowLease>
    ) => {
      const forced = await createManagedExternalSessionFollowLeaseMock(...args);
      if (forced !== undefined) {
        return forced;
      }
      return actual.createManagedExternalSessionFollowLease(...args);
    },
  };
});

import { registerMachineExternalSessionsRpcHandlers } from '../rpcHandlers.externalSessions';

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function waitForExpectation(assertion: () => void | Promise<void>, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Expectation was not met before timeout');
}

describe('registerMachineExternalSessionsRpcHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    createManagedExternalSessionFollowLeaseMock.mockReset();
    getActiveAccountSettingsSnapshotMock.mockReturnValue({
      source: 'active',
      settings: {
        notificationsSettingsV1: {
          v: 1,
          pushEnabled: true,
          ready: true,
          permissionRequest: false,
        },
      },
      settingsSecretsReadKeys: [],
    });
  });

  it('takes over a direct claude session using provider cwd and config dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-takeover-'));
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
        externalSessionV1: {
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

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager, spawnSession, stopSession });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY);
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
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        existingSessionId: 'sess_happy_direct',
        resume: 'sess-claude-direct',
        approvedNewDirectoryCreation: true,
        transcriptStorage: 'direct',
        environmentVariables: { CLAUDE_CONFIG_DIR: resolvedConfigDir },
      }),
    );
  });

  it.each([
    {
      label: 'takeover',
      method: RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY,
      request: { machineId: 'm1', sessionId: 'sess_happy_direct_no_credentials' },
    },
    {
      label: 'takeoverPersist',
      method: RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY,
      request: { machineId: 'm1', sessionId: 'sess_happy_direct_no_credentials' },
    },
  ])('preserves legacy provider_unavailable when $label cannot read credentials', async ({ method, request }) => {
    readCredentialsMock.mockResolvedValueOnce(null);

    const spawnSession = vi.fn(async (_options: SpawnSessionOptions): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'sess_happy_direct_no_credentials',
    }));
    const stopSession = vi.fn(async () => true);
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (registeredMethod: string, handler: (params: any) => Promise<any>) => {
        registered.set(registeredMethod, handler);
      },
    } as any;

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager, spawnSession, stopSession });

    const handler = registered.get(method);
    expect(handler).toBeDefined();

    const res = await handler!(request);

    expect(res).toEqual({
      ok: false,
      errorCode: 'provider_unavailable',
      error: 'not_authenticated',
    });
    expect(fetchSessionByIdMock).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
    expect(stopSession).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'takeover',
      method: RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY,
      request: { machineId: 'm1', sessionId: 'sess_happy_direct_bad_metadata' },
    },
    {
      label: 'takeoverPersist',
      method: RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY,
      request: { machineId: 'm1', sessionId: 'sess_happy_direct_bad_metadata' },
    },
  ])('preserves legacy provider_unavailable when $label cannot decrypt linked session metadata', async ({ method, request }) => {
    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_happy_direct_bad_metadata',
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadata: '',
    });

    const spawnSession = vi.fn(async (_options: SpawnSessionOptions): Promise<SpawnSessionResult> => ({
      type: 'success',
      sessionId: 'sess_happy_direct_bad_metadata',
    }));
    const stopSession = vi.fn(async () => true);
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (registeredMethod: string, handler: (params: any) => Promise<any>) => {
        registered.set(registeredMethod, handler);
      },
    } as any;

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager, spawnSession, stopSession });

    const handler = registered.get(method);
    expect(handler).toBeDefined();

    const res = await handler!(request);

    expect(res).toEqual({
      ok: false,
      errorCode: 'provider_unavailable',
      error: 'session_metadata_unavailable',
    });
    expect(spawnSession).not.toHaveBeenCalled();
    expect(stopSession).not.toHaveBeenCalled();
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
        externalSessionV1: {
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
      registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager, spawnSession, stopSession });

      const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY);
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
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-persist-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-persist', 'sess-claude-persist.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-persist'), { recursive: true });
    const resolvedConfigDir = await realpath(configDir).catch(() => configDir);
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
      externalSessionV1: {
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

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager, spawnSession, stopSession });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY);
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
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        existingSessionId: 'sess_happy_persist',
        resume: 'sess-claude-persist',
        approvedNewDirectoryCreation: true,
        transcriptStorage: 'persisted',
        environmentVariables: { CLAUDE_CONFIG_DIR: resolvedConfigDir },
      }),
    );
    expect(spawnSession).toHaveBeenCalledWith(
      expect.not.objectContaining({
        transcriptStorage: 'direct',
      }),
    );
    const metadataUpdateArgs = updateSessionMetadataWithRetryMock.mock.calls[0]?.[0];
    const updatedMetadata = metadataUpdateArgs?.updater?.(metadata);
    expect(updatedMetadata.externalSessionV1).toBeUndefined();
    expect(updatedMetadata.path).toBe('/tmp/direct-claude-persist-worktree');
    expect(updatedMetadata.externalHistoryImportV1).toMatchObject({
      v: 1,
      providerId: 'claude',
      remoteSessionId: 'sess-claude-persist',
      source: { kind: 'claudeConfig', projectId: 'proj-persist' },
    });
  });

  it('does not remove direct-session metadata when persisted respawn fails after import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-persist-fail-'));
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
      externalSessionV1: {
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

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager, spawnSession, stopSession });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY);
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
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-'));
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

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST);
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
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-page-'));
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

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE);
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

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST);
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

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST);
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

  it('ignores a rogue persisted Claude configDir during takeover and refuses when the current configured config dir has no matching session', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '/safe/.claude');

    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-takeover-rogue-'));
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
        externalSessionV1: {
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

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager, spawnSession, stopSession });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_rogue',
    });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('invalid_request');
    expect(res.error).toBe('external_session_directory_unavailable');
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
        externalSessionV1: {
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

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET);
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

  it('reuses cached takeover readiness across repeated direct-session status polls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-status-cache-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-cache', 'sess-cache.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-cache'), { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({
        type: 'user',
        uuid: 'u-cache',
        cwd: '/tmp/direct-cache-worktree',
        message: { content: 'hello' },
      }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);
    vi.stubEnv('HAPPIER_EXTERNAL_SESSIONS_STATUS_TAKEOVER_CACHE_MS', '60000');

    readCredentialsMock.mockResolvedValue({
      token: 'token-cache',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValue({
      id: 'sess_happy_direct_cache',
      metadataVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        claudeSessionId: 'sess-cache',
        externalSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-cache',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-cache' },
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

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET);
    expect(handler).toBeDefined();

    const request = {
      machineId: 'm1',
      sessionId: 'sess_happy_direct_cache',
      providerId: 'claude',
      remoteSessionId: 'sess-cache',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-cache' },
    };

    const first = await handler!(request);
    const second = await handler!(request);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.canTakeOverPersist).toBe(true);
    expect(second.canTakeOverPersist).toBe(true);
    expect(readCredentialsMock).toHaveBeenCalledTimes(1);
    expect(fetchSessionByIdMock).toHaveBeenCalledTimes(1);
  });

  it('marks claude sessions with recent file activity as active_recently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-status-'));
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

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET);
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
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-status-codex-'));
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

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET);
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
    const root = await mkdtemp(join(tmpdir(), 'happier-externalSessions-rpc-status-codex-app-server-'));
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

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET);
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

      registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

      const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET);
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

    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER);
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

      registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

      const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET);
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

      registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager });

      const handler = registered.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET);
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

import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
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
    publicReleaseRing: 'stable',
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

describe('registerMachineDirectSessionsRpcHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('registers direct-session attach leases and detaches them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-directSessions-rpc-attach-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-attach', 'sess-attach.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-attach'), { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
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

    const attachHandler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_ATTACH);
    const detachHandler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_DETACH);
    expect(attachHandler).toBeDefined();
    expect(detachHandler).toBeDefined();

    const attached = await attachHandler!({
      machineId: 'm1',
      sessionId: 'happy-session-1',
      providerId: 'claude',
      remoteSessionId: 'sess-attach',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-attach' },
      ttlMs: 30_000,
    });

    expect(attached.ok).toBe(true);
    expect(typeof attached.leaseId).toBe('string');
    expect(attached.expiresAtMs).toBeGreaterThan(Date.now());

    const detached = await detachHandler!({
      machineId: 'm1',
      sessionId: 'happy-session-1',
      leaseId: attached.leaseId,
    });

    expect(detached).toEqual({ ok: true, detached: true });
  });

  it('writes lightweight background-follow policy metadata without transcript bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-directSessions-rpc-follow-policy-'));
    const configDir = join(root, '.claude');
    const sessionDir = join(configDir, 'projects', 'proj-policy');
    const sessionFile = join(sessionDir, 'sess-claude-policy.jsonl');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

    readCredentialsMock.mockResolvedValueOnce({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValueOnce({
      id: 'sess_happy_policy',
      metadataVersion: 7,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        directSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-claude-policy',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-policy' },
          linkedAtMs: Date.now(),
        },
      }),
    });
    updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: { updater: (current: Record<string, unknown>) => Record<string, unknown> }) => ({
      version: 8,
      metadata: updater({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        directSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-claude-policy',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-policy' },
          linkedAtMs: Date.now(),
        },
      }),
    }));

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET);
    expect(handler).toBeDefined();

    const res = await handler!({
      machineId: 'm1',
      sessionId: 'sess_happy_policy',
      providerId: 'claude',
      remoteSessionId: 'sess-claude-policy',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-policy' },
      enabled: true,
    });

    expect(res.ok).toBe(true);
    expect(res.enabled).toBe(true);
    expect(res.leaseActive).toBe(true);
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    const metadataUpdateArgs = updateSessionMetadataWithRetryMock.mock.calls[0]?.[0];
    const updatedMetadata = metadataUpdateArgs?.updater?.({
      path: '',
      machineId: 'm1',
      flavor: 'claude',
      directSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: 'm1',
        remoteSessionId: 'sess-claude-policy',
        source: { kind: 'claudeConfig', configDir, projectId: 'proj-policy' },
        linkedAtMs: Date.now(),
      },
    });
    expect(updatedMetadata.directSessionV1.followPolicyV1).toEqual({
      v: 1,
      policy: 'background_follow',
      updatedAtMs: expect.any(Number),
    });
    expect(updatedMetadata.directSessionV1.lastKnownActivityAtMs).toBeUndefined();
  });

  it('persists lightweight progress markers for detached background-follow sessions when transcript updates arrive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-directSessions-rpc-background-follow-'));
    const configDir = join(root, '.claude');
    const sessionDir = join(configDir, 'projects', 'proj-background');
    const sessionFile = join(sessionDir, 'sess-background.jsonl');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

    readCredentialsMock.mockResolvedValue({
      token: 'token-direct',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    fetchSessionByIdMock.mockResolvedValue({
      id: 'sess_happy_background',
      metadataVersion: 7,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        directSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-background',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-background' },
          linkedAtMs: Date.now(),
        },
      }),
    });
    updateSessionMetadataWithRetryMock.mockImplementation(async ({ updater }: { updater: (current: Record<string, unknown>) => Record<string, unknown> }) => ({
      version: 8,
      metadata: updater({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        directSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-background',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-background' },
          linkedAtMs: Date.now(),
        },
      }),
    }));

    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const policyHandler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET);
    expect(policyHandler).toBeDefined();

    const res = await policyHandler!({
      machineId: 'm1',
      sessionId: 'sess_happy_background',
      providerId: 'claude',
      remoteSessionId: 'sess-background',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-background' },
      enabled: true,
    });

    expect(res.ok).toBe(true);

    await writeFile(
      sessionFile,
      [
        jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
        jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'background delta' }] } }),
      ].join(''),
      'utf8',
    );

    await waitForExpectation(() => {
      expect(updateSessionMetadataWithRetryMock).toHaveBeenCalled();
      const latestCall = updateSessionMetadataWithRetryMock.mock.calls.at(-1)?.[0];
      const updated = latestCall?.updater?.({
        path: '',
        machineId: 'm1',
        flavor: 'claude',
        directSessionV1: {
          v: 1,
          providerId: 'claude',
          machineId: 'm1',
          remoteSessionId: 'sess-background',
          source: { kind: 'claudeConfig', configDir, projectId: 'proj-background' },
          linkedAtMs: Date.now(),
          followPolicyV1: {
            v: 1,
            policy: 'background_follow',
            updatedAtMs: Date.now(),
          },
        },
      });
      expect(updated.directSessionV1.followPolicyV1).toEqual(expect.objectContaining({
        policy: 'background_follow',
      }));
      expect(updated.directSessionV1.lastKnownActivityAtMs).toEqual(expect.any(Number));
      expect(updated.directSessionAttentionV1).toEqual(expect.objectContaining({
        observedProgressToken: expect.any(String),
        observedAtMs: expect.any(Number),
      }));
    });
  });

  it('pushes transcript deltas for attached direct sessions and stops after detach', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-directSessions-rpc-push-'));
    const configDir = join(root, '.claude');
    const sessionFile = join(configDir, 'projects', 'proj-push', 'sess-push.jsonl');
    await mkdir(join(configDir, 'projects', 'proj-push'), { recursive: true });
    await writeFile(
      sessionFile,
      jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
      'utf8',
    );
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

    const emitDirectSessionTranscriptUpdate = vi.fn(async () => {});
    const registered = new Map<string, (params: any) => Promise<any>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: any) => Promise<any>) => {
        registered.set(method, handler);
      },
    } as any;

    registerMachineDirectSessionsRpcHandlers({
      rpcHandlerManager,
      emitDirectSessionTranscriptUpdate,
    } as any);

    const attachHandler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_ATTACH);
    const detachHandler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_DETACH);
    expect(attachHandler).toBeDefined();
    expect(detachHandler).toBeDefined();

    const attached = await attachHandler!({
      machineId: 'm1',
      sessionId: 'happy-session-push',
      providerId: 'claude',
      remoteSessionId: 'sess-push',
      source: { kind: 'claudeConfig', configDir, projectId: 'proj-push' },
      ttlMs: 30_000,
    });

    expect(attached.ok).toBe(true);

    await writeFile(
      sessionFile,
      [
        jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
        jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'hello from push' }] } }),
      ].join(''),
      'utf8',
    );

    await waitForExpectation(() => {
      expect(emitDirectSessionTranscriptUpdate).toHaveBeenCalledWith(expect.objectContaining({
        type: 'direct-session-transcript-delta',
        sessionId: 'happy-session-push',
        items: expect.arrayContaining([
          expect.objectContaining({
            raw: expect.objectContaining({
              content: expect.objectContaining({
                data: expect.objectContaining({
                  message: expect.objectContaining({
                    content: expect.arrayContaining([
                      expect.objectContaining({ text: 'hello from push' }),
                    ]),
                  }),
                }),
              }),
            }),
          }),
        ]),
        truncated: false,
      }));
    });

    emitDirectSessionTranscriptUpdate.mockClear();

    const detached = await detachHandler!({
      machineId: 'm1',
      sessionId: 'happy-session-push',
      leaseId: attached.leaseId,
    });

    expect(detached).toEqual({ ok: true, detached: true });

    await writeFile(
      sessionFile,
      [
        jsonlLine({ type: 'assistant', uuid: 'a1', message: { model: 'm', content: [] } }),
        jsonlLine({ type: 'assistant', uuid: 'a2', message: { model: 'm', content: [{ type: 'text', text: 'hello from push' }] } }),
        jsonlLine({ type: 'assistant', uuid: 'a3', message: { model: 'm', content: [{ type: 'text', text: 'after detach' }] } }),
      ].join(''),
      'utf8',
    );

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(emitDirectSessionTranscriptUpdate).not.toHaveBeenCalled();
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

  it('reuses cached takeover readiness across repeated direct-session status polls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-directSessions-rpc-status-cache-'));
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
    vi.stubEnv('HAPPIER_DIRECT_SESSIONS_STATUS_TAKEOVER_CACHE_MS', '60000');

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
        directSessionV1: {
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

    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });

    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_STATUS_GET);
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

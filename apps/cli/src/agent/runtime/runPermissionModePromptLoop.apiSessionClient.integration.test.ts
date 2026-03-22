import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpBackend } from '@/agent/acp/AcpBackend';
import { createAcpRuntime } from '@/agent/acp/runtime/createAcpRuntime';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt } from '@/agent/runtime/permission/permissionModeQueuedPrompt';
import { createRuntimeOverrideSynchronizers } from '@/agent/runtime/createRuntimeOverrideSynchronizers';
import { runPermissionModePromptLoop } from './runPermissionModePromptLoop';
import { openCodeTransport } from '@/backends/opencode/acp/transport';
import { maybeUpdateOpenCodeSessionIdMetadata } from '@/backends/opencode/utils/opencodeSessionIdMetadata';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { configuration } from '@/configuration';

type SocketStub = {
  socket: {
    id: string;
    connected: boolean;
    on: (event: string, handler: (...args: any[]) => void) => void;
    off: (event: string, handler?: (...args: any[]) => void) => void;
    close: () => void;
    connect: () => void;
    disconnect: () => void;
    emit: (...args: any[]) => void;
    timeout: (ms: number) => any;
    emitWithAck: (event: string, payload: unknown) => Promise<unknown>;
  };
  emit: (event: string, ...args: any[]) => void;
};

function createSocketStub(params: { id: string; connected: boolean }): SocketStub {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  const state = { connected: params.connected };

  const emit = (event: string, ...args: any[]) => {
    const set = handlers.get(event);
    if (!set) return;
    for (const handler of Array.from(set)) {
      handler(...args);
    }
  };

  const socket: SocketStub['socket'] = {
    id: params.id,
    get connected() {
      return state.connected;
    },
    set connected(value: boolean) {
      state.connected = value;
    },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      const set = handlers.get(event) ?? new Set<(...args: any[]) => void>();
      set.add(handler);
      handlers.set(event, set);
      return socket;
    }),
    off: vi.fn((event: string, handler?: (...args: any[]) => void) => {
      if (!handler) {
        handlers.delete(event);
        return socket;
      }
      const set = handlers.get(event);
      set?.delete(handler);
      if (set && set.size === 0) handlers.delete(event);
      return socket;
    }),
    close: vi.fn(() => {
      state.connected = false;
      emit('disconnect', 'io client disconnect');
    }),
    connect: vi.fn(() => {
      state.connected = true;
      emit('connect');
    }),
    disconnect: vi.fn(() => {
      state.connected = false;
      emit('disconnect', 'io client disconnect');
    }),
    emit: vi.fn(),
    timeout: vi.fn(function timeout() {
      return socket;
    }),
    emitWithAck: vi.fn(async () => ({ ok: true })),
  };

  return { socket, emit };
}

let sessionSocketStub: SocketStub | null = null;
let userSocketStub: SocketStub | null = null;

vi.mock('@/api/session/sockets', () => ({
  createSessionScopedSocket: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return sessionSocketStub.socket as any;
  },
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub.socket as any;
  },
}));

vi.mock('@/api/session/sessionMessageCatchUp', () => ({
  catchUpSessionMessagesAfterSeq: vi.fn(async () => {}),
}));

function createModeQueue() {
  return new MessageQueue2<{ permissionMode: PermissionMode; appendSystemPrompt?: string | null }, PermissionModeQueuedPrompt>(
    (mode) => mode.permissionMode,
    {
      batcher: (messages) => combinePermissionModeQueuedPrompts(messages),
    },
  );
}

function writeFakeOpenCodeAcpAgentScript(params: { dir: string; modeLogPath?: string }): string {
  const scriptPath = join(params.dir, 'fake-opencode-acp-agent.mjs');
  const modeLogPath = params.modeLogPath ? JSON.stringify(params.modeLogPath) : 'null';
  const src = `
    const decoder = new TextDecoder();
    let buf = '';
    const { appendFileSync } = await import('node:fs');
    const modeLogPath = ${modeLogPath};

    function send(obj) {
      process.stdout.write(JSON.stringify(obj) + '\\n');
    }

    function ok(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    process.stdin.on('data', (chunk) => {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let req;
        try { req = JSON.parse(trimmed); } catch { continue; }
        if (!req || typeof req !== 'object') continue;

        const id = req.id;
        const method = req.method;
        const requestParams = req.params;
        if (id === undefined || id === null || typeof method !== 'string') continue;

        if (method === 'initialize') {
          ok(id, { protocolVersion: 1, authMethods: [] });
          continue;
        }

        if (method === 'session/new') {
          ok(id, {
            sessionId: 'test-session',
            modes: {
              currentModeId: 'build',
              availableModes: [
                { id: 'build', name: 'Build' },
                { id: 'plan', name: 'Plan' },
              ],
            },
          });
          continue;
        }

        if (method === 'session/prompt') {
          ok(id, {});
          setTimeout(() => {
            send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'test-session',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'hello' },
                },
              },
            });
          }, 10);
          continue;
        }

        if (method === 'session/set_mode') {
          if (modeLogPath) {
            appendFileSync(modeLogPath, JSON.stringify({ modeId: requestParams?.modeId ?? '' }) + '\\n', 'utf8');
          }
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'test-session',
              update: {
                sessionUpdate: 'current_mode_update',
                currentModeId: requestParams?.modeId ?? '',
              },
            },
          });
          ok(id, {});
          continue;
        }

        ok(id, {});
      }
    });
  `;

  writeFileSync(scriptPath, src, 'utf8');
  return scriptPath;
}

describe('runPermissionModePromptLoop with ApiSessionClient idle snapshot refresh', () => {
  const originalIdleWakePollIntervalMs = configuration.pendingQueueIdleWakePollIntervalMs;

  beforeEach(() => {
    sessionSocketStub = createSocketStub({ id: 'session-socket', connected: true });
    userSocketStub = createSocketStub({ id: 'user-socket', connected: false });
    (configuration as any).pendingQueueIdleWakePollIntervalMs = 10;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (configuration as any).pendingQueueIdleWakePollIntervalMs = originalIdleWakePollIntervalMs;
    sessionSocketStub = null;
    userSocketStub = null;
  });

  it('applies an ACP session mode override that is only observed via idle snapshot refresh', async () => {
    const encryptionKey = new Uint8Array(32).fill(7);
    const encryptMetadata = (metadata: Record<string, unknown>) =>
      encodeBase64(encrypt(encryptionKey, 'legacy', metadata));

    const initialMetadata = {
      path: '/tmp/worktree',
      host: 'test',
      flavor: 'opencode',
      startedBy: 'terminal',
    };

    let serverMetadata: Record<string, unknown> = initialMetadata;
    let serverMetadataVersion = 1;
    const servedSessionMetadataVersions: number[] = [];
    let sessionFetchCount = 0;
    let profileFetchCount = 0;
    const unexpectedGetCalls: string[] = [];

    vi.spyOn(axios, 'get').mockImplementation(async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/v2/sessions/s1')) {
        sessionFetchCount += 1;
        servedSessionMetadataVersions.push(serverMetadataVersion);
        return {
          status: 200,
          data: {
            session: createSessionRecordFixture({
              id: 's1',
              encryptionMode: 'e2ee' as any,
              metadata: encryptMetadata(serverMetadata),
              metadataVersion: serverMetadataVersion,
              agentState: null,
              agentStateVersion: 0,
            }),
          },
        } as any;
      }
      if (href.includes('/v1/account/profile')) {
        profileFetchCount += 1;
        return {
          status: 200,
          data: { id: 'u1' },
        } as any;
      }
      if (href.includes('/v2/changes')) {
        return {
          status: 200,
          data: { changes: [], nextCursor: null, hasMore: false },
        } as any;
      }
      if (href.includes('/v1/sessions/s1/messages')) {
        return {
          status: 200,
          data: { messages: [], nextAfterSeq: null },
        } as any;
      }
      unexpectedGetCalls.push(href);
      throw new Error(`Unexpected axios.get call: ${href}`);
    });

    const session = new ApiSessionClient('tok', {
      id: 's1',
      seq: 0,
      encryptionMode: 'e2ee',
      encryptionKey,
      encryptionVariant: 'legacy',
      metadata: initialMetadata as any,
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 0,
    } as any);
    session.popPendingMessage = vi.fn(async () => false);
    const waitForMetadataUpdateSpy = vi.spyOn(session, 'waitForMetadataUpdate');
    const refreshSessionSnapshotSpy = vi.spyOn(session, 'refreshSessionSnapshotFromServerBestEffort');

    const queue = createModeQueue();
    queue.push({ text: 'first', localId: 'local-1' }, { permissionMode: 'default' });

    const runtime = {
      beginTurn: vi.fn(),
      startOrLoad: vi.fn(async () => {}),
      sendPrompt: vi.fn(async () => {}),
      sendPromptWithMeta: vi.fn(async () => {}),
      flushTurn: vi.fn(),
      reset: vi.fn(async () => {}),
      getSessionId: vi.fn(() => 'remote-session-1'),
      shouldResumeAfterPermissionModeChange: vi.fn(() => true),
    } as any;

    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    const abortController = new AbortController();
    let shouldExit = false;
    let appliedModeId: string | null = null;
    let readyCount = 0;

    const appliedPromise = new Promise<void>((resolve) => {
      runtime.__setAppliedMode = (modeId: string) => {
        appliedModeId = modeId;
        shouldExit = true;
        abortController.abort();
        resolve();
      };
    });

    const loopPromise = runPermissionModePromptLoop({
      providerName: 'Test Provider',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: (isStarted) =>
        createRuntimeOverrideSynchronizers({
          session,
          runtime: {
            setSessionMode: async (modeId: string) => {
              runtime.__setAppliedMode(modeId);
            },
            setSessionModel: async () => {},
            setSessionConfigOption: async () => {},
          },
          isStarted,
        }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {
        readyCount += 1;
        if (readyCount !== 1) return;
        serverMetadata = {
          ...serverMetadata,
          acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
        };
        const currentLocalMetadataVersion =
          typeof (session as any).metadataVersion === 'number' ? (session as any).metadataVersion : 0;
        serverMetadataVersion = Math.max(serverMetadataVersion, currentLocalMetadataVersion) + 1;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    await Promise.race([
      appliedPromise,
      new Promise((_, reject) =>
        setTimeout(() => {
          reject(
            new Error(
              `Timed out waiting for idle metadata refresh (sessionFetchCount=${sessionFetchCount}, servedSessionMetadataVersions=${servedSessionMetadataVersions.join(',') || 'none'}, profileFetchCount=${profileFetchCount}, unexpectedGetCalls=${unexpectedGetCalls.join(',') || 'none'}, metadata=${JSON.stringify(session.getMetadataSnapshot())}, waitForMetadataUpdateCalls=${waitForMetadataUpdateSpy.mock.calls.length}, refreshSessionSnapshotCalls=${refreshSessionSnapshotSpy.mock.calls.length}, userSocketConnected=${String(userSocketStub?.socket.connected ?? null)}, userSocketConnectCalls=${String((userSocketStub?.socket.connect as any)?.mock?.calls?.length ?? 0)})`,
            ),
          );
        }, 2_000),
      ),
    ]);

    await loopPromise;

    expect(runtime.sendPromptWithMeta).toHaveBeenCalledTimes(1);
    expect(appliedModeId).toBe('plan');

    await session.close();
  });

  it('applies an ACP session mode override via the real ACP runtime after idle snapshot refresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-api-session-acp-runtime-'));
    const modeLogPath = join(dir, 'mode-log.jsonl');
    const scriptPath = writeFakeOpenCodeAcpAgentScript({ dir, modeLogPath });
    const backend = new AcpBackend({
      agentName: 'opencode',
      cwd: dir,
      command: process.execPath,
      args: [scriptPath],
      transportHandler: openCodeTransport,
    });

    const encryptionKey = new Uint8Array(32).fill(7);
    const encryptMetadata = (metadata: Record<string, unknown>) =>
      encodeBase64(encrypt(encryptionKey, 'legacy', metadata));

    const initialMetadata = {
      path: dir,
      host: 'test',
      flavor: 'opencode',
      startedBy: 'terminal',
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    };

    let serverMetadata: Record<string, unknown> = initialMetadata;
    let serverMetadataVersion = 1;
    let sessionFetchCount = 0;
    const servedSessionMetadataVersions: number[] = [];
    const metadataAckHistory: string[] = [];

    vi.spyOn(axios, 'get').mockImplementation(async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/v2/sessions/s1')) {
        sessionFetchCount += 1;
        servedSessionMetadataVersions.push(serverMetadataVersion);
        return {
          status: 200,
          data: {
            session: createSessionRecordFixture({
              id: 's1',
              encryptionMode: 'e2ee' as any,
              metadata: encryptMetadata(serverMetadata),
              metadataVersion: serverMetadataVersion,
              agentState: null,
              agentStateVersion: 0,
            }),
          },
        } as any;
      }
      if (href.includes('/v1/account/profile')) {
        return {
          status: 200,
          data: { id: 'u1' },
        } as any;
      }
      if (href.includes('/v2/changes')) {
        return {
          status: 200,
          data: { changes: [], nextCursor: null, hasMore: false },
        } as any;
      }
      if (href.includes('/v1/sessions/s1/messages')) {
        return {
          status: 200,
          data: { messages: [], nextAfterSeq: null },
        } as any;
      }
      throw new Error(`Unexpected axios.get call: ${href}`);
    });

    const session = new ApiSessionClient('tok', {
      id: 's1',
      seq: 0,
      encryptionMode: 'e2ee',
      encryptionKey,
      encryptionVariant: 'legacy',
      metadata: initialMetadata as any,
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 0,
    } as any);
    session.popPendingMessage = vi.fn(async () => false);
    (sessionSocketStub?.socket.emitWithAck as any)?.mockImplementation?.(async (event: string, payload: any) => {
      if (event === 'update-metadata') {
        metadataAckHistory.push(`request:${String(payload.expectedVersion)}`);
        if (Number(payload.expectedVersion) !== serverMetadataVersion) {
          metadataAckHistory.push(`mismatch:${serverMetadataVersion}`);
          return {
            result: 'version-mismatch',
            metadata: encryptMetadata(serverMetadata),
            version: serverMetadataVersion,
          };
        }
        serverMetadata = decrypt(encryptionKey, 'legacy', decodeBase64(String(payload.metadata))) as Record<string, unknown>;
        serverMetadataVersion += 1;
        metadataAckHistory.push(`success:${serverMetadataVersion}`);
        return {
          result: 'success',
          metadata: encryptMetadata(serverMetadata),
          version: serverMetadataVersion,
        };
      }
      return { ok: true };
    });

    const queue = createModeQueue();
    queue.push({ text: 'first', localId: 'local-1' }, { permissionMode: 'default' });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: dir,
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend as any,
    });
    const setSessionModeSpy = vi.spyOn(runtime, 'setSessionMode');
    const updateMetadataSpy = vi.spyOn(session, 'updateMetadata');

    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    const abortController = new AbortController();
    let shouldExit = false;
    let readyCount = 0;

    const appliedPromise = new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (setSessionModeSpy.mock.calls.length === 0) return;
        clearInterval(interval);
        shouldExit = true;
        abortController.abort();
        resolve();
      }, 10);
      interval.unref?.();
    });

    const loopPromise = runPermissionModePromptLoop({
      providerName: 'OpenCode',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: (isStarted) =>
        createRuntimeOverrideSynchronizers({
          session,
          runtime,
          isStarted,
        }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {
        readyCount += 1;
        if (readyCount !== 1) return;
        serverMetadata = {
          ...serverMetadata,
          acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
        };
        const currentLocalMetadataVersion =
          typeof (session as any).metadataVersion === 'number' ? (session as any).metadataVersion : 0;
        serverMetadataVersion = Math.max(serverMetadataVersion, currentLocalMetadataVersion) + 1;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    try {
      await Promise.race([
        appliedPromise,
        new Promise((_, reject) =>
          setTimeout(() => {
            const modeLog = (() => {
              try {
                return readFileSync(modeLogPath, 'utf8');
              } catch {
                return '';
              }
            })();
            reject(
              new Error(
                `Timed out waiting for ACP runtime mode override (readyCount=${readyCount}, sessionFetchCount=${sessionFetchCount}, servedSessionMetadataVersions=${servedSessionMetadataVersions.join(',') || 'none'}, metadata=${JSON.stringify(session.getMetadataSnapshot())}, modeLog=${JSON.stringify(modeLog)}, setSessionModeCalls=${setSessionModeSpy.mock.calls.length}, updateMetadataCalls=${updateMetadataSpy.mock.calls.length}, metadataAckHistory=${metadataAckHistory.join('|') || 'none'}, localMetadataVersion=${String((session as any).metadataVersion)})`,
              ),
            );
          }, 10_000),
        ),
      ]);
      await loopPromise;
      expect(setSessionModeSpy).toHaveBeenCalledWith('plan');
    } finally {
      await session.close();
      await runtime.reset().catch(() => {});
      await backend.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies an ACP session mode override that arrives over the socket before the first turn has fully gone idle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-api-session-acp-runtime-mid-turn-'));
    const modeLogPath = join(dir, 'mode-log.jsonl');
    const scriptPath = writeFakeOpenCodeAcpAgentScript({ dir, modeLogPath });
    const backend = new AcpBackend({
      agentName: 'opencode',
      cwd: dir,
      command: process.execPath,
      args: [scriptPath],
      transportHandler: openCodeTransport,
    });

    const encryptionKey = new Uint8Array(32).fill(7);
    const encryptMetadata = (metadata: Record<string, unknown>) =>
      encodeBase64(encrypt(encryptionKey, 'legacy', metadata));

    const initialMetadata = {
      path: dir,
      host: 'test',
      flavor: 'opencode',
      startedBy: 'terminal',
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    };

    vi.spyOn(axios, 'get').mockImplementation(async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/v1/account/profile')) {
        return {
          status: 200,
          data: { id: 'u1' },
        } as any;
      }
      if (href.includes('/v2/changes')) {
        return {
          status: 200,
          data: { changes: [], nextCursor: null, hasMore: false },
        } as any;
      }
      if (href.includes('/v1/sessions/s1/messages')) {
        return {
          status: 200,
          data: { messages: [], nextAfterSeq: null },
        } as any;
      }
      throw new Error(`Unexpected axios.get call: ${href}`);
    });

    const session = new ApiSessionClient('tok', {
      id: 's1',
      seq: 0,
      encryptionMode: 'e2ee',
      encryptionKey,
      encryptionVariant: 'legacy',
      metadata: initialMetadata as any,
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 0,
    } as any);
    session.popPendingMessage = vi.fn(async () => false);

    const queue = createModeQueue();
    queue.push({ text: 'first', localId: 'local-1' }, { permissionMode: 'default' });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: dir,
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend as any,
    });

    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    let emittedMidTurnOverride = false;
    const sendAgentMessageSpy = vi.spyOn(session, 'sendAgentMessage');
    sendAgentMessageSpy.mockImplementation(((provider: unknown, body: any, opts?: unknown) => {
      if (!emittedMidTurnOverride && body?.type === 'task_started') {
        emittedMidTurnOverride = true;
        setTimeout(() => {
          const overrideMetadata = {
            ...initialMetadata,
            acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
          };
          const update = {
            id: 'mid-turn-override',
            seq: 99,
            createdAt: Date.now(),
            body: {
              t: 'update-session',
              sid: 's1',
              id: 's1',
              metadata: {
                value: encryptMetadata(overrideMetadata),
                version: 2,
              },
            },
          };
          sessionSocketStub?.emit('update', update);
          userSocketStub?.emit('update', update);
        }, 20);
      }
      return ApiSessionClient.prototype.sendAgentMessage.call(session, provider as any, body, opts as any);
    }) as typeof session.sendAgentMessage);

    const abortController = new AbortController();
    let shouldExit = false;
    let readyCount = 0;

    const appliedPromise = new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const modeLog = (() => {
          try {
            return readFileSync(modeLogPath, 'utf8');
          } catch {
            return '';
          }
        })();
        if (!modeLog.includes('"modeId":"plan"')) return;
        clearInterval(interval);
        shouldExit = true;
        abortController.abort();
        resolve();
      }, 10);
      interval.unref?.();
    });

    const loopPromise = runPermissionModePromptLoop({
      providerName: 'OpenCode',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: (isStarted) =>
        createRuntimeOverrideSynchronizers({
          session,
          runtime,
          isStarted,
        }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {
        readyCount += 1;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    try {
      await Promise.race([
        appliedPromise,
        new Promise((_, reject) =>
          setTimeout(() => {
            const modeLog = (() => {
              try {
                return readFileSync(modeLogPath, 'utf8');
              } catch {
                return '';
              }
            })();
            reject(
              new Error(
                `Timed out waiting for mid-turn ACP runtime mode override (readyCount=${readyCount}, metadata=${JSON.stringify(session.getMetadataSnapshot())}, modeLog=${JSON.stringify(modeLog)}, localMetadataVersion=${String((session as any).metadataVersion)}, emittedMidTurnOverride=${String(emittedMidTurnOverride)})`,
              ),
            );
          }, 10_000),
        ),
      ]);
      await loopPromise;
    } finally {
      await session.close();
      await runtime.reset().catch(() => {});
      await backend.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still applies the ACP session mode override when OpenCode publishes opencodeSessionId after start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-api-session-acp-runtime-after-start-'));
    const modeLogPath = join(dir, 'mode-log.jsonl');
    const scriptPath = writeFakeOpenCodeAcpAgentScript({ dir, modeLogPath });
    const backend = new AcpBackend({
      agentName: 'opencode',
      cwd: dir,
      command: process.execPath,
      args: [scriptPath],
      transportHandler: openCodeTransport,
    });

    const encryptionKey = new Uint8Array(32).fill(7);
    const encryptMetadata = (metadata: Record<string, unknown>) =>
      encodeBase64(encrypt(encryptionKey, 'legacy', metadata));

    const initialMetadata = {
      path: dir,
      host: 'test',
      flavor: 'opencode',
      startedBy: 'terminal',
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    };

    let serverMetadata: Record<string, unknown> = initialMetadata;
    let serverMetadataVersion = 1;

    vi.spyOn(axios, 'get').mockImplementation(async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/v2/sessions/s1')) {
        return {
          status: 200,
          data: {
            session: createSessionRecordFixture({
              id: 's1',
              encryptionMode: 'e2ee' as any,
              metadata: encryptMetadata(serverMetadata),
              metadataVersion: serverMetadataVersion,
              agentState: null,
              agentStateVersion: 0,
            }),
          },
        } as any;
      }
      if (href.includes('/v1/account/profile')) {
        return {
          status: 200,
          data: { id: 'u1' },
        } as any;
      }
      if (href.includes('/v2/changes')) {
        return {
          status: 200,
          data: { changes: [], nextCursor: null, hasMore: false },
        } as any;
      }
      if (href.includes('/v1/sessions/s1/messages')) {
        return {
          status: 200,
          data: { messages: [], nextAfterSeq: null },
        } as any;
      }
      throw new Error(`Unexpected axios.get call: ${href}`);
    });

    const session = new ApiSessionClient('tok', {
      id: 's1',
      seq: 0,
      encryptionMode: 'e2ee',
      encryptionKey,
      encryptionVariant: 'legacy',
      metadata: initialMetadata as any,
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 0,
    } as any);
    session.popPendingMessage = vi.fn(async () => false);
    (sessionSocketStub?.socket.emitWithAck as any)?.mockImplementation?.(async (event: string, payload: any) => {
      if (event === 'update-metadata') {
        if (Number(payload.expectedVersion) !== serverMetadataVersion) {
          return {
            result: 'version-mismatch',
            metadata: encryptMetadata(serverMetadata),
            version: serverMetadataVersion,
          };
        }
        serverMetadata = decrypt(encryptionKey, 'legacy', decodeBase64(String(payload.metadata))) as Record<string, unknown>;
        serverMetadataVersion += 1;
        return {
          result: 'success',
          metadata: encryptMetadata(serverMetadata),
          version: serverMetadataVersion,
        };
      }
      return { ok: true };
    });

    const queue = createModeQueue();
    queue.push({ text: 'first', localId: 'local-1' }, { permissionMode: 'default' });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: dir,
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend as any,
    });

    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    const abortController = new AbortController();
    let shouldExit = false;
    let readyCount = 0;
    const lastPublished = {
      sessionId: null as string | null,
      backendMode: null as 'server' | 'acp' | null,
      serverBaseUrl: null as string | null,
      serverBaseUrlExplicit: false,
    };

    const appliedPromise = new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const modeLog = (() => {
          try {
            return readFileSync(modeLogPath, 'utf8');
          } catch {
            return '';
          }
        })();
        if (!modeLog.includes('"modeId":"plan"')) return;
        clearInterval(interval);
        shouldExit = true;
        abortController.abort();
        resolve();
      }, 10);
      interval.unref?.();
    });

    const loopPromise = runPermissionModePromptLoop({
      providerName: 'OpenCode',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: (isStarted) =>
        createRuntimeOverrideSynchronizers({
          session,
          runtime,
          isStarted,
        }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {
        readyCount += 1;
        if (readyCount !== 1) return;
        serverMetadata = {
          ...serverMetadata,
          acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
        };
        const currentLocalMetadataVersion =
          typeof (session as any).metadataVersion === 'number' ? (session as any).metadataVersion : 0;
        serverMetadataVersion = Math.max(serverMetadataVersion, currentLocalMetadataVersion) + 1;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      onAfterStart: () => {
        const openCodeSessionId = runtime.getSessionId();
        if (!openCodeSessionId) return;
        void (async () => {
          const snapshot = await session.ensureMetadataSnapshot({ timeoutMs: 60_000 });
          if (!snapshot) return;
          if (runtime.getSessionId() !== openCodeSessionId) return;
          await maybeUpdateOpenCodeSessionIdMetadata({
            getOpenCodeSessionId: () => openCodeSessionId,
            backendMode: 'acp',
            serverBaseUrl: null,
            serverBaseUrlExplicit: null,
            updateHappySessionMetadata: (updater) => session.updateMetadata(updater),
            lastPublished,
          });
        })().catch(() => {});
      },
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    try {
      await Promise.race([
        appliedPromise,
        new Promise((_, reject) =>
          setTimeout(() => {
            const modeLog = (() => {
              try {
                return readFileSync(modeLogPath, 'utf8');
              } catch {
                return '';
              }
            })();
            reject(
              new Error(
                `Timed out waiting for ACP runtime mode override with onAfterStart publish (readyCount=${readyCount}, metadata=${JSON.stringify(session.getMetadataSnapshot())}, modeLog=${JSON.stringify(modeLog)}, localMetadataVersion=${String((session as any).metadataVersion)}, serverMetadataVersion=${serverMetadataVersion})`,
              ),
            );
          }, 10_000),
        ),
      ]);
      await loopPromise;
    } finally {
      await session.close();
      await runtime.reset().catch(() => {});
      await backend.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies a socket-delivered ACP session mode override after OpenCode publishes opencodeSessionId post-start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-api-session-acp-runtime-after-start-socket-'));
    const modeLogPath = join(dir, 'mode-log.jsonl');
    const scriptPath = writeFakeOpenCodeAcpAgentScript({ dir, modeLogPath });
    const backend = new AcpBackend({
      agentName: 'opencode',
      cwd: dir,
      command: process.execPath,
      args: [scriptPath],
      transportHandler: openCodeTransport,
    });

    const encryptionKey = new Uint8Array(32).fill(7);
    const encryptMetadata = (metadata: Record<string, unknown>) =>
      encodeBase64(encrypt(encryptionKey, 'legacy', metadata));

    let serverMetadata: Record<string, unknown> = {
      path: dir,
      host: 'test',
      flavor: 'opencode',
      startedBy: 'terminal',
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
    };
    let serverMetadataVersion = 1;

    vi.spyOn(axios, 'get').mockImplementation(async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/v2/sessions/s1')) {
        return {
          status: 200,
          data: {
            session: createSessionRecordFixture({
              id: 's1',
              encryptionMode: 'e2ee' as any,
              metadata: encryptMetadata(serverMetadata),
              metadataVersion: serverMetadataVersion,
              agentState: null,
              agentStateVersion: 0,
            }),
          },
        } as any;
      }
      if (href.includes('/v1/account/profile')) {
        return {
          status: 200,
          data: { id: 'u1' },
        } as any;
      }
      if (href.includes('/v2/changes')) {
        return {
          status: 200,
          data: { changes: [], nextCursor: null, hasMore: false },
        } as any;
      }
      if (href.includes('/v1/sessions/s1/messages')) {
        return {
          status: 200,
          data: { messages: [], nextAfterSeq: null },
        } as any;
      }
      throw new Error(`Unexpected axios.get call: ${href}`);
    });

    const session = new ApiSessionClient('tok', {
      id: 's1',
      seq: 0,
      encryptionMode: 'e2ee',
      encryptionKey,
      encryptionVariant: 'legacy',
      metadata: serverMetadata as any,
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 0,
    } as any);
    session.popPendingMessage = vi.fn(async () => false);
    (sessionSocketStub?.socket.emitWithAck as any)?.mockImplementation?.(async (event: string, payload: any) => {
      if (event === 'update-metadata') {
        if (Number(payload.expectedVersion) !== serverMetadataVersion) {
          return {
            result: 'version-mismatch',
            metadata: encryptMetadata(serverMetadata),
            version: serverMetadataVersion,
          };
        }
        serverMetadata = decrypt(encryptionKey, 'legacy', decodeBase64(String(payload.metadata))) as Record<string, unknown>;
        serverMetadataVersion += 1;
        return {
          result: 'success',
          metadata: encryptMetadata(serverMetadata),
          version: serverMetadataVersion,
        };
      }
      return { ok: true };
    });

    const queue = createModeQueue();
    queue.push({ text: 'first', localId: 'local-1' }, { permissionMode: 'default' });

    const runtime = createAcpRuntime({
      provider: 'opencode',
      directory: dir,
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: createApprovedPermissionHandler(),
      onThinkingChange: () => {},
      ensureBackend: async () => backend as any,
    });

    const messageBuffer = new MessageBuffer();
    const permissionHandler = {
      setPermissionMode: vi.fn(),
      reset: vi.fn(),
    } as any;

    const abortController = new AbortController();
    let shouldExit = false;
    let readyCount = 0;
    let emittedSocketOverride = false;
    const lastPublished = {
      sessionId: null as string | null,
      backendMode: null as 'server' | 'acp' | null,
      serverBaseUrl: null as string | null,
      serverBaseUrlExplicit: false,
    };

    const appliedPromise = new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        const modeLog = (() => {
          try {
            return readFileSync(modeLogPath, 'utf8');
          } catch {
            return '';
          }
        })();
        if (!modeLog.includes('"modeId":"plan"')) return;
        clearInterval(interval);
        shouldExit = true;
        abortController.abort();
        resolve();
      }, 10);
      interval.unref?.();
    });

    const loopPromise = runPermissionModePromptLoop({
      providerName: 'OpenCode',
      agentMessageType: 'qwen',
      explicitPermissionMode: undefined,
      session,
      messageQueue: queue,
      permissionHandler,
      runtime,
      createOverrideSynchronizer: (isStarted) =>
        createRuntimeOverrideSynchronizers({
          session,
          runtime,
          isStarted,
        }),
      messageBuffer,
      shouldExit: () => shouldExit,
      getAbortSignal: () => abortController.signal,
      keepAlive: () => {},
      setThinking: () => {},
      sendReady: () => {
        readyCount += 1;
      },
      currentPermissionModeUpdatedAt: 0,
      setCurrentPermissionMode: () => {},
      setCurrentPermissionModeUpdatedAt: () => {},
      onAfterStart: () => {
        const openCodeSessionId = runtime.getSessionId();
        if (!openCodeSessionId) return;
        void (async () => {
          const snapshot = await session.ensureMetadataSnapshot({ timeoutMs: 60_000 });
          if (!snapshot) return;
          if (runtime.getSessionId() !== openCodeSessionId) return;
          const publishPromise = maybeUpdateOpenCodeSessionIdMetadata({
            getOpenCodeSessionId: () => openCodeSessionId,
            backendMode: 'acp',
            serverBaseUrl: null,
            serverBaseUrlExplicit: null,
            updateHappySessionMetadata: (updater) => session.updateMetadata(updater),
            lastPublished,
          }).catch(() => {});
          if (emittedSocketOverride) return;
          emittedSocketOverride = true;
          const update = {
            id: 'after-start-override',
            seq: 99,
            createdAt: Date.now(),
            body: {
              t: 'update-session',
              sid: 's1',
              id: 's1',
              metadata: {
                value: encryptMetadata({
                  ...serverMetadata,
                  acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
                }),
                version: serverMetadataVersion + 1,
              },
            },
          };
          serverMetadata = {
            ...serverMetadata,
            acpSessionModeOverrideV1: { v: 1, updatedAt: 10, modeId: 'plan' },
          };
          serverMetadataVersion += 1;
          sessionSocketStub?.emit('update', update);
          userSocketStub?.emit('update', update);
          await publishPromise;
        })().catch(() => {});
      },
      formatPromptErrorMessage: (error) => `Error: ${String(error)}`,
    });

    try {
      await Promise.race([
        appliedPromise,
        new Promise((_, reject) =>
          setTimeout(() => {
            const modeLog = (() => {
              try {
                return readFileSync(modeLogPath, 'utf8');
              } catch {
                return '';
              }
            })();
            reject(
              new Error(
                `Timed out waiting for ACP runtime mode override after socket delivery (readyCount=${readyCount}, metadata=${JSON.stringify(session.getMetadataSnapshot())}, modeLog=${JSON.stringify(modeLog)}, localMetadataVersion=${String((session as any).metadataVersion)}, serverMetadataVersion=${serverMetadataVersion}, emittedSocketOverride=${String(emittedSocketOverride)})`,
              ),
            );
          }, 10_000),
        ),
      ]);
      await loopPromise;
    } finally {
      await session.close();
      await runtime.reset().catch(() => {});
      await backend.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
import type { PermissionMode } from '@/api/types';

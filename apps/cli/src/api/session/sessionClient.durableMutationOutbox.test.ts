import * as fsBoundary from 'node:fs/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
  SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1,
  SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
} from '@happier-dev/protocol';

import { createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import type { ACPMessageData } from './sessionMessageTypes';
import type { StreamedTranscriptWriterSession } from './streamedTranscriptWriter';
import type { DeferredApiSessionClient, DeferredApiSessionTarget } from '@/agent/runtime/startup/DeferredApiSessionClient';
import type { AgentState } from '@/api/types';
import type { createSessionSocketTransport } from './connection/createSessionSocketTransport';
import type { createUserScopedSocket } from './sockets';

type SessionSocketTransportResult = ReturnType<typeof createSessionSocketTransport>;
type UserScopedSocket = ReturnType<typeof createUserScopedSocket>;
let sessionSocketStub: ApiSessionSocketStub | null = null;
let sessionSocketStubFactory: (() => ApiSessionSocketStub) | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
let supervisorConnect: null | (() => Promise<void>) = null;
let supervisorControl: null | Readonly<{
  start(): Promise<void>;
  getState(): Readonly<{ phase: string }>;
  stop(): Promise<void>;
}> = null;
let supervisorConnectedTransitions = 0;
let realSupervisorConnectedCompletion: Promise<void> | null = null;
let useRealSupervisor = false;
let transportCreationCount = 0;
let sessionConnectionGate: Promise<void> | null = null;
let disconnectSessionTransport: (() => void) | null = null;
let tempHomeDir: string | null = null;
const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
let pendingConsumerModules: Awaited<ReturnType<typeof loadPendingConsumerModules>> | null = null;

async function loadPendingConsumerModules() {
  const [client, queue, consumer, logging] = await Promise.all([
    import('./sessionClient'),
    import('@/agent/runtime/modeMessageQueue'),
    import('@/agent/runtime/sessionInput/SessionProviderInputConsumer'),
    import('@/ui/logger'),
  ]);
  return {
    ApiSessionClient: client.ApiSessionClient,
    MessageQueue2: queue.MessageQueue2,
    createSessionProviderInputConsumer: consumer.createSessionProviderInputConsumer,
    logger: logging.logger,
  };
}

async function createRuntimePersistenceContext(sessionId: string) {
  const { configuration } = await import('@/configuration');
  const { createSessionMutationPersistenceContext, parseQueuedSessionMutation } = await import('./mutations/sessionMutationPersistence');
  return createSessionMutationPersistenceContext({
    activeServerDir: configuration.activeServerDir,
    custody: 'runtime',
    sessionId,
    parseQueuedMutation: parseQueuedSessionMutation,
  });
}

vi.mock('axios');

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub as unknown as UserScopedSocket;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    transportCreationCount += 1;
    const transportSocketStub = sessionSocketStubFactory?.() ?? sessionSocketStub;
    if (!transportSocketStub) throw new Error('Missing session socket stub');
    sessionSocketStub = transportSocketStub;
    let connectedListener: (() => void) | null = null;
    const transportResult: SessionSocketTransportResult = {
      socket: transportSocketStub as unknown as SessionSocketTransportResult['socket'],
      transport: {
        connect: async () => {
          if (sessionConnectionGate) await sessionConnectionGate;
          transportSocketStub.connected = true;
          connectedListener?.();
        },
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => transportSocketStub.connected === true,
        onConnected: (listener) => {
          connectedListener = listener;
          return () => { connectedListener = null; };
        },
        onDisconnected: (listener) => {
          disconnectSessionTransport = () => {
            transportSocketStub.connected = false;
            listener({ reason: 'transport close' });
          };
          return () => { disconnectSessionTransport = null; };
        },
        onError: () => () => {},
      },
    };
    return transportResult;
  },
}));

vi.mock('@happier-dev/connection-supervisor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/connection-supervisor')>();
  return {
    DEFAULT_MANAGED_CONNECTION_POLICY: actual.DEFAULT_MANAGED_CONNECTION_POLICY,
    createManagedConnectionSupervisor: (params: Parameters<typeof actual.createManagedConnectionSupervisor>[0]) => {
      if (useRealSupervisor) {
        return actual.createManagedConnectionSupervisor({
          ...params,
          onConnected: (context) => {
            const completion = Promise.resolve(params.onConnected?.(context));
            realSupervisorConnectedCompletion = completion;
            return completion;
          },
        });
      }
      let phase = 'idle';
      supervisorConnect = async () => {
        params.createTransport();
        phase = 'online';
        supervisorConnectedTransitions += 1;
        await params.onConnected?.({
          state: {
            phase: 'online', reason: null, attempt: supervisorConnectedTransitions,
            nextRetryAt: null, lastConnectedAt: null, lastDisconnectedAt: null, lastErrorMessage: null,
          },
        });
      };
      supervisorControl = {
        start: async () => {
          if (phase === 'online' || phase === 'connecting') return;
          phase = 'connecting';
          await supervisorConnect?.();
        },
        getState: () => ({ phase }),
        stop: async () => {
          phase = 'shutting_down';
        },
      };
      return supervisorControl;
    },
  };
});

async function useTempHappyHome(): Promise<string> {
  tempHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-session-outbox-'));
  process.env.HAPPIER_HOME_DIR = tempHomeDir;
  return tempHomeDir;
}

async function readPersistedOutboxMutationCount(sessionId: string): Promise<number> {
  const { configuration } = await import('@/configuration');
  const filePath = join(configuration.activeServerDir, 'session-mutations', `session-${sessionId}.json`);
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { mutations?: unknown[] };
    return Array.isArray(parsed.mutations) ? parsed.mutations.length : 0;
  } catch {
    return 0;
  }
}

async function readPersistedOutboxMutations(sessionId: string): Promise<unknown[]> {
  const { configuration } = await import('@/configuration');
  const filePath = join(configuration.activeServerDir, 'session-mutations', `session-${sessionId}.json`);
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { mutations?: unknown[] };
    return Array.isArray(parsed.mutations) ? parsed.mutations : [];
  } catch {
    return [];
  }
}

function createDeferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function seedEncryptedSettlementWithFollowingTurn(sessionId: string, value: unknown, key: Uint8Array) {
  const { encrypt, encodeBase64 } = await import('@/api/encryption');
  const { saveSessionMutationOutbox } = await import('./mutations/sessionMutationPersistence');
  const { createSessionTurnMutation } = await import('./mutations/sessionMutationTypes');
  const settlement = {
    kind: 'agent_state_request_settlement',
    mutationId: 'settlement',
    payload: {
      v: 1, source: 'agent_state_request_settlement', sessionId, mutationId: 'settlement',
      content: { t: 'encrypted', c: encodeBase64(encrypt(key, 'legacy', value)) },
    },
    createdAt: 100, attempts: 0, nextAttemptAt: 0,
  } as const;
  const turn = createSessionTurnMutation({
    sessionId, mutationId: 'following-turn', action: 'begin', turnId: 'turn', observedAt: 101,
  });
  await saveSessionMutationOutbox(await createRuntimePersistenceContext(sessionId), [settlement, {
    kind: 'session_turn', mutationId: turn.mutationId, payload: turn,
    createdAt: 101, attempts: 0, nextAttemptAt: 0,
  }]);
  return settlement;
}

const taskCompleteMessage = { type: 'task_complete', id: 'turn-1' } satisfies ACPMessageData;
const reusableUnknownTurnId = ['primary', 'runtime'].join('-') + ':s1:unknown';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

describe('ApiSessionClient durable mutation outbox', () => {
  it('acknowledges a fast-start permission through the attached Deferred client before resolving its provider', async () => {
    const request = { tool: 'Write', arguments: {}, createdAt: 1 };
    let serverState: AgentState = {};
    let version = 0;
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
      if (event !== 'update-state') return { ok: true };
      const value = payload as { agentState: string };
      serverState = JSON.parse(value.agentState);
      return { result: 'success', version: ++version, agentState: value.agentState };
    } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { ApiSessionClient } = await import('./sessionClient');
    const { DeferredApiSessionClient } = await import('@/agent/runtime/startup/DeferredApiSessionClient');
    const { AgentStateRequestStore } = await import('@/agent/permissions/agentStateRequestStore');
    const { createPermissionRequestCoordinator } = await import('@/agent/permissions/permissionRequestCoordinator');
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-permission', limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    const coordinator = createPermissionRequestCoordinator<boolean>({ store: new AgentStateRequestStore({ session: deferred, logPrefix: '[Test]' }) });
    const provider = coordinator.requestDecision({ requestId: 'permission', toolName: request.tool, toolInput: request.arguments, createdAt: 1 });
    void provider.catch(() => undefined);
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's-deferred-permission' }));
    try {
      // Match the production Claude fast-start attachment boundary in runClaude.
      await deferred.attach(client as unknown as import('@/agent/runtime/startup/DeferredApiSessionClient').DeferredApiSessionTarget);
      await expect.poll(() => serverState.requests?.permission).toEqual(expect.objectContaining(request));
      await expect(coordinator.completeRpcResponse({
        context: coordinator.getResponseContext('permission')!,
        completion: { result: true, completedRequest: { status: 'approved' } },
      })).resolves.toBe(true);
      await expect(provider).resolves.toBe(true);
      expect(serverState.requests?.permission).toBeUndefined();
      expect(serverState.completedRequests?.permission.status).toBe('approved');
    } finally {
      coordinator.cancelRequest('permission', 'test cleanup');
      await client.close();
    }
  });

  it('answers a still-pending permission after reconnecting to a new real session client', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const states: AgentState[] = [{}, {}];
    const versions = [0, 0];
    let transportIndex = 0;
    sessionSocketStubFactory = () => {
      const index = transportIndex++;
      return createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
        if (event !== 'update-state') return { ok: true };
        const value = payload as { expectedVersion: number; agentState: string };
        if (value.expectedVersion !== versions[index]) {
          return { result: 'version-mismatch', version: versions[index], agentState: JSON.stringify(states[index]) };
        }
        states[index] = JSON.parse(value.agentState);
        return { result: 'success', version: ++versions[index]!, agentState: value.agentState };
      } });
    };
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { ApiSessionClient } = await import('./sessionClient');
    const { ProviderEnforcedPermissionHandler } = await import('@/agent/permissions/ProviderEnforcedPermissionHandler');
    const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol');
    const oldClient = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's-before-reconnect' }));
    const newClient = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's-after-reconnect' }));
    const handler = new ProviderEnforcedPermissionHandler(oldClient, { logPrefix: '[ReconnectTest]' });
    const input = { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] };
    const pending = handler.handleToolCall('reconnect-question', 'AskUserQuestion', input);
    void pending.catch(() => undefined);
    try {
      await expect.poll(() => states[0]?.requests?.['reconnect-question']).toBeDefined();
      const original = states[0]!.requests!['reconnect-question'];
      clock.mockReturnValue(2_000);
      handler.updateSession(newClient);
      await expect.poll(() => states[1]?.requests?.['reconnect-question']).toEqual(original);
      await newClient.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1, {
        id: 'reconnect-question', structuredAnswersV1: { 'Continue?': ['Yes'] },
      });
      await expect(pending).resolves.toMatchObject({ answers: { 'Continue?': ['Yes'] } });
      expect(states[1]?.requests?.['reconnect-question']).toBeUndefined();
      expect(states[1]?.completedRequests?.['reconnect-question']).toMatchObject({ createdAt: 1_000, status: 'approved' });
    } finally {
      clock.mockRestore();
      await handler.abortPendingRequestsAndFlush('test cleanup');
      await Promise.all([oldClient.close(), newClient.close()]);
      await pending.catch(() => undefined);
    }
  });

  it('keeps a next-turn question routable across real reset journal admission', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'reset-account' })).toString('base64url')}.sig`;
    const { writeCredentialsLegacy } = await import('@/persistence');
    await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(7), token });
    let serverState: AgentState = {};
    let version = 0;
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emit: (event, args) => {
      const acknowledge = args.at(-1);
      if (event === 'ping' && typeof acknowledge === 'function') acknowledge({ v: 1 });
    }, emitWithAck: async (event, payload) => {
      if (event !== 'update-state') return { ok: true };
      const value = payload as { expectedVersion: number; agentState: string };
      if (value.expectedVersion !== version) return { result: 'version-mismatch', version, agentState: JSON.stringify(serverState) };
      serverState = JSON.parse(value.agentState);
      return { result: 'success', version: ++version, agentState: value.agentState };
    } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { ApiSessionClient } = await import('./sessionClient');
    const { ProviderEnforcedPermissionHandler } = await import('@/agent/permissions/ProviderEnforcedPermissionHandler');
    const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol');
    const client = new ApiSessionClient(token, createPlainSessionFixture({ id: 's-real-reset-routing' }));
    const handler = new ProviderEnforcedPermissionHandler(client, { logPrefix: '[ResetTest]' });
    const enteredDiskAdmission = createDeferred<void>();
    const releaseDiskAdmission = createDeferred<void>();
    const rename = fsBoundary.rename;
    let held = false;
    const disk = vi.spyOn(fsBoundary, 'rename').mockImplementation(async (from, to) => {
      if (!held && String(to).endsWith('session-s-real-reset-routing.json')) {
        held = true;
        enteredDiskAdmission.resolve();
        await releaseDiskAdmission.promise;
      }
      await rename(from, to);
    });
    const old = handler.handleToolCall('old-turn', 'AskUserQuestion', { questions: [{ question: 'Old?', options: [{ label: 'Yes' }] }] });
    const oldRejected = expect(old).rejects.toThrow('Session reset');
    let next: Promise<unknown> | undefined;
    try {
      await expect.poll(() => serverState.requests?.['old-turn']).toBeDefined();
      handler.reset();
      await enteredDiskAdmission.promise;
      next = handler.handleToolCall('next-turn', 'AskUserQuestion', { questions: [{ question: 'Next?', options: [{ label: 'Yes' }] }] });
      void next.catch(() => undefined);
      // The normal ACK writer stays usable while the old journal's disk rename is held.
      await expect.poll(() => serverState.requests?.['next-turn']).toBeDefined();
      releaseDiskAdmission.resolve();
      await oldRejected;
      await client.flush();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(client.getAgentStateSnapshot()?.requests?.['next-turn']).toBeDefined();
      await client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1, {
        id: 'next-turn', structuredAnswersV1: { 'Next?': ['Yes'] },
      });
      await expect(next).resolves.toMatchObject({ answers: { 'Next?': ['Yes'] } });
    } finally {
      releaseDiskAdmission.resolve();
      disk.mockRestore();
      await handler.abortPendingRequestsAndFlush('test cleanup');
      await client.close();
      await oldRejected;
      await next?.catch(() => undefined);
    }
  });

  it('preserves an observed completion before later Stop when credential reads finish out of order', async () => {
    const { writeCredentialsLegacy } = await import('@/persistence');
    await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(7), token: 'tok' });
    const { configuration } = await import('@/configuration');
    const credentialBytes = await readFile(configuration.privateKeyFile, 'utf8');
    const request = { tool: 'Write', arguments: { path: '/tmp/observed' }, createdAt: 1 };
    let serverState: AgentState = { requests: { request } };
    let version = 0;
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
      if (event !== 'update-state') return { ok: true };
      const value = payload as { expectedVersion: number; agentState: string };
      if (value.expectedVersion !== version) return { result: 'version-mismatch', version, agentState: JSON.stringify(serverState) };
      serverState = JSON.parse(value.agentState);
      return { result: 'success', version: ++version, agentState: value.agentState };
    } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { ApiSessionClient } = await import('./sessionClient');
    const { AgentStateRequestStore } = await import('@/agent/permissions/agentStateRequestStore');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's-settlement-seal-order', agentState: serverState }));
    const store = new AgentStateRequestStore({ session: client, logPrefix: '[Test]' });
    await client.flush();
    const firstReadEntered = createDeferred<void>();
    const releaseFirstRead = createDeferred<void>();
    const actualReadFile = fsBoundary.readFile;
    let held = false;
    // Credential-file I/O is the genuine boundary: preserve real sealing, journal and CAS delivery.
    const disk = vi.spyOn(fsBoundary, 'readFile').mockImplementation(((...args: Parameters<typeof fsBoundary.readFile>) => {
      if (String(args[0]) === configuration.privateKeyFile) {
        if (!held) {
          held = true;
          firstReadEntered.resolve();
          return releaseFirstRead.promise.then(() => credentialBytes);
        }
        return Promise.resolve(credentialBytes);
      }
      return actualReadFile(...args);
    }) as typeof fsBoundary.readFile);
    const observed = store.completeRequest({ requestId: 'request', status: 'approved', observedCompletion: true });
    let canceled: Promise<void> | undefined;
    try {
      await firstReadEntered.promise;
      canceled = store.cancelAllRequests({ reason: 'Stopped after tool completion', decision: 'abort' });
      // This FIFO ACK write runs after both snapshots were captured, without waiting for sealing.
      await client.updateAgentState((state) => state);
      releaseFirstRead.resolve();
      await Promise.all([observed, canceled]);
      await client.flush();
      expect(serverState.requests?.request).toBeUndefined();
      expect(serverState.completedRequests?.request).toMatchObject({ ...request, status: 'approved' });
    } finally {
      releaseFirstRead.resolve();
      await Promise.allSettled([observed, ...(canceled ? [canceled] : [])]);
      disk.mockRestore();
      await client.close();
    }
  });

  it('finishes client close cleanup while returning a concurrent settlement admission failure to its caller', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { ApiSessionClient } = await import('./sessionClient');
    const request = { tool: 'Write', arguments: {}, createdAt: 1 };
    const client = new ApiSessionClient('tok', createPlainSessionFixture({
      id: 's-close-failed-admission', agentState: { requests: { request } },
    }));
    let closed = false;
    client.on('local-closed', () => { closed = true; });
    const admission = client.updateAgentStateRequestSettlement(() => ({
      requests: {}, completedRequests: { request: { ...request, completedAt: 2, status: 'canceled' } },
    }));
    const rejected = expect(admission).rejects.toThrow('requires account credentials');
    try {
      await expect(client.close()).resolves.toBeUndefined();
      await rejected;
      expect(closed).toBe(true);
      expect(userSocketStub.close).toHaveBeenCalledOnce();
      expect(supervisorControl?.getState().phase).toBe('shutting_down');
    } finally {
      await rejected;
      if (!closed) await client.close();
    }
  });

  it('quarantines an authenticated invalid settlement without blocking the following turn or replaying it after restart', async () => {
    const { writeCredentialsLegacy } = await import('@/persistence');
    const key = new Uint8Array(32).fill(7);
    await writeCredentialsLegacy({ secret: key, token: 'tok' });
    const sessionId = 's-invalid-settlement';
    const mutation = await seedEncryptedSettlementWithFollowingTurn(sessionId, { privateInvalidPayload: 'secret' }, key);
    const actions: string[] = [];
    const makeSocket = () => createApiSessionSocketStub({ connected: true, emitWithAck: async (event) => {
      if (event === 'session-turn-mutation') actions.push(event);
      return { ok: true };
    } });
    sessionSocketStub = makeSocket();
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: sessionId }));
    try {
      await expect.poll(() => readPersistedOutboxMutations(sessionId)).toEqual([]);
      expect(actions).toEqual(['session-turn-mutation']);
      const context = await createRuntimePersistenceContext(sessionId);
      const deadLetters = JSON.parse(await readFile(context.paths.deadLetterPath, 'utf8'));
      expect(deadLetters.entries).toEqual([expect.objectContaining({
        reason: 'permanent_invalid_payload',
        queuedMutation: expect.objectContaining({ payload: mutation.payload }),
      })]);
      expect(JSON.stringify(deadLetters)).not.toContain('privateInvalidPayload');
      expect(JSON.stringify(deadLetters)).not.toContain('secret');
    } finally {
      await client.close();
    }
    sessionSocketStub = makeSocket();
    const restarted = new ApiSessionClient('tok', createPlainSessionFixture({ id: sessionId }));
    try {
      await restarted.flush();
      expect(await readPersistedOutboxMutations(sessionId)).toEqual([]);
      expect(actions).toEqual(['session-turn-mutation']);
    } finally {
      await restarted.close();
    }
  });

  it('retains an undecryptable settlement and delivers it with the following turn after correct-key reconstruction', async () => {
    const { writeCredentialsLegacy } = await import('@/persistence');
    const key = new Uint8Array(32).fill(7);
    await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(8), token: 'tok' });
    const sessionId = 's-wrong-key-settlement';
    const completed = { tool: 'Write', arguments: { path: 'private' }, createdAt: 1, completedAt: 2, status: 'canceled' };
    const mutation = await seedEncryptedSettlementWithFollowingTurn(sessionId, {
      v: 1, entries: [{ requestId: 'request', completed, removeRequest: true }],
    }, key);
    let state: AgentState = { requests: { request: { tool: 'Write', arguments: { path: 'private' }, createdAt: 1 } } };
    const actions: string[] = [];
    const makeSocket = () => createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
      if (event === 'update-state') {
        const request = payload as { agentState: string };
        state = JSON.parse(request.agentState);
        return { result: 'success', version: 1, agentState: request.agentState };
      }
      if (event === 'session-turn-mutation') actions.push(event);
      return { ok: true };
    } });
    sessionSocketStub = makeSocket();
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: sessionId, agentState: state }));
    try {
      await client.flush();
      expect(await readPersistedOutboxMutations(sessionId)).toEqual([
        expect.objectContaining({ payload: mutation.payload }),
        expect.objectContaining({ kind: 'session_turn' }),
      ]);
      expect(actions).toEqual([]);
      const context = await createRuntimePersistenceContext(sessionId);
      await expect(readFile(context.paths.deadLetterPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await client.close();
    }
    await writeCredentialsLegacy({ secret: key, token: 'tok' });
    sessionSocketStub = makeSocket();
    const restarted = new ApiSessionClient('tok', createPlainSessionFixture({ id: sessionId, agentState: state }));
    try {
      await expect.poll(() => readPersistedOutboxMutations(sessionId)).toEqual([]);
      expect(state.requests).toEqual({});
      expect(state.completedRequests?.request).toEqual(completed);
      expect(actions).toEqual(['session-turn-mutation']);
    } finally {
      await restarted.close();
    }
  });

  it.each(['legacy', 'tokenOnly'] as const)('does not retain a %s pre-effect UI decision for later journal replay after acknowledgement failure', async (variant) => {
    const { writeCredentialsLegacy, writeCredentialsTokenOnly } = await import('@/persistence');
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'settlement-account' })).toString('base64url')}.sig`;
    if (variant === 'legacy') await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(7), token });
    else await writeCredentialsTokenOnly({ token });
    const request = { tool: 'Write', kind: 'permission', arguments: {}, createdAt: 1 };
    let serverState: AgentState = { requests: { ui: request } };
    let serverVersion = 0;
    let online = true;
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
      if (event === 'ping') return { v: 1 };
      if (event !== 'update-state') return { ok: true };
      if (!online) return { result: 'error' };
      const value = payload as { expectedVersion: number; agentState: string };
      if (value.expectedVersion !== serverVersion) return {
        result: 'version-mismatch', version: serverVersion, agentState: JSON.stringify(serverState),
      };
      serverState = JSON.parse(value.agentState);
      return { result: 'success', version: ++serverVersion, agentState: value.agentState };
    } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { ApiSessionClient } = await import('./sessionClient');
    const { AgentStateRequestStore } = await import('@/agent/permissions/agentStateRequestStore');
    const { createPermissionRequestCoordinator } = await import('@/agent/permissions/permissionRequestCoordinator');
    const client = new ApiSessionClient(token, createPlainSessionFixture({ id: 's-ui-failure', agentState: serverState }));
    const coordinator = createPermissionRequestCoordinator<boolean>({ store: new AgentStateRequestStore({ session: client, logPrefix: '[Test]' }) });
    const provider = coordinator.requestDecision({ requestId: 'ui', toolName: request.tool, toolInput: request.arguments, createdAt: 1 });
    let outcome = 'pending';
    void provider.then(() => { outcome = 'allowed'; }, () => { outcome = 'canceled'; });
    try {
      await expect.poll(() => serverVersion).toBeGreaterThan(0);
      online = false;
      await expect(coordinator.completeRpcResponse({
        context: coordinator.getResponseContext('ui')!,
        completion: { result: true, completedRequest: { status: 'approved' } },
      })).rejects.toThrow();
      online = true;
      await client.flush();
      expect(await readPersistedOutboxMutations('s-ui-failure')).toEqual([]);
      expect(serverState.requests?.ui).toBeDefined();
      expect(serverState.completedRequests?.ui).toBeUndefined();
      expect(outcome).toBe('pending');
    } finally {
      coordinator.cancelRequest('ui', 'test cleanup');
      await client.close();
    }
  });

  it.each(['before-handler', 'ack'] as const)('keeps automatic policy immediate and journals its history after a %s failure for restart recovery', async (failure) => {
    const { writeCredentialsLegacy } = await import('@/persistence');
    await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(7), token: 'tok' });
    let online = false;
    let serverState: AgentState = { requests: {} };
    let serverVersion = 0;
    const failAcknowledgement = createDeferred<void>();
    const automatic = { tool: 'Write', arguments: { path: 'private-automatic' }, createdAt: 1_000, completedAt: 1_000,
      kind: 'permission', status: 'approved', decision: 'approved' };
    const makeSocket = () => createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
      if (event === 'ping') return { v: 1 };
      if (event !== 'update-state') return { ok: true };
      if (!online) {
        if (failure === 'ack') await failAcknowledgement.promise;
        return { result: 'error' };
      }
      const request = payload as { expectedVersion: number; agentState: string };
      if (request.expectedVersion !== serverVersion) return {
        result: 'version-mismatch', version: serverVersion, agentState: JSON.stringify(serverState),
      };
      serverState = JSON.parse(request.agentState);
      return { result: 'success', version: ++serverVersion, agentState: request.agentState };
    } });
    const connectionReady = createDeferred<void>();
    if (failure === 'before-handler') {
      useRealSupervisor = true;
      sessionConnectionGate = connectionReady.promise;
      vi.stubEnv('HAPPIER_SESSION_SOCKET_CONNECT_TIMEOUT_MS', '5');
    }
    sessionSocketStub = makeSocket();
    sessionSocketStub.connected = failure !== 'before-handler';
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { ApiSessionClient } = await import('./sessionClient');
    const { ProviderEnforcedPermissionHandler } = await import('@/agent/permissions/ProviderEnforcedPermissionHandler');
    const first = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's-auto-history', agentState: serverState }));
    const handler = new ProviderEnforcedPermissionHandler(first, { logPrefix: '[AutomaticHistoryTest]' });
    handler.setPermissionMode('yolo');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const enteredDiskAdmission = createDeferred<void>();
    const releaseDiskAdmission = createDeferred<void>();
    const rename = fsBoundary.rename;
    let held = false;
    const disk = vi.spyOn(fsBoundary, 'rename').mockImplementation(async (from, to) => {
      if (failure === 'ack' && !held && String(to).endsWith('session-s-auto-history.json')) {
        held = true;
        enteredDiskAdmission.resolve();
        await releaseDiskAdmission.promise;
      }
      await rename(from, to);
    });
    let ordinaryAck: Promise<void> | undefined;
    try {
      await expect(handler.handleToolCall('automatic', automatic.tool, automatic.arguments))
        .resolves.toEqual({ decision: 'approved' });
      failAcknowledgement.resolve();
      if (failure === 'ack') {
        await enteredDiskAdmission.promise;
        online = true;
        ordinaryAck = first.updateAgentState((state) => ({ ...state, controlledByUser: true }));
        void ordinaryAck.catch(() => undefined);
        // Retention owns disk admission, not the unrelated acknowledged state writer.
        await expect.poll(() => serverState.controlledByUser).toBe(true);
        await ordinaryAck;
        online = false;
        releaseDiskAdmission.resolve();
      }
      await expect.poll(async () => await readPersistedOutboxMutations('s-auto-history'))
        .toEqual([expect.objectContaining({ kind: 'agent_state_request_settlement' })]);
    } finally {
      failAcknowledgement.resolve();
      connectionReady.resolve();
      releaseDiskAdmission.resolve();
      await ordinaryAck?.catch(() => undefined);
      await first.close();
      disk.mockRestore();
      clock.mockRestore();
    }
    useRealSupervisor = false;
    sessionConnectionGate = null;
    online = true;
    sessionSocketStub = makeSocket();
    const restarted = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's-auto-history', agentState: serverState }));
    try {
      await expect.poll(() => serverState.completedRequests?.automatic).toEqual(automatic);
      await expect.poll(async () => await readPersistedOutboxMutations('s-auto-history')).toEqual([]);
    } finally {
      await restarted.close();
    }
  });

  it('fails request settlement admission without credentials and drains cancellation custody during close', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { result: 'error' } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { ApiSessionClient } = await import('./sessionClient');
    const request = { tool: 'Write', arguments: { path: 'private' }, createdAt: 10 };
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's-close-settlement', agentState: {
      requests: { foreground: request, background: { ...request, createdAt: 11 } },
    } }));
    const { AgentStateRequestStore } = await import('@/agent/permissions/agentStateRequestStore');
    const store = new AgentStateRequestStore({ session: client, logPrefix: '[Test]' });
    await expect(store.completeRequest({ requestId: 'foreground', status: 'canceled' }))
      .rejects.toThrow('requires account credentials');
    const { writeCredentialsLegacy } = await import('@/persistence');
    await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(9), token: 'tok' });
    store.cancelAllRequests({ reason: 'source retired', requestIds: ['foreground'] });
    await client.close();
    const queued = await readPersistedOutboxMutations('s-close-settlement');
    expect(queued).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'agent_state_request_settlement' })]));
    expect(JSON.stringify(queued)).not.toContain('private');
  });

  it.each(['legacy', 'dataKey', 'tokenOnly'] as const)('recovers %s encrypted exact request settlement after restart and rebases on concurrent requests', async (variant) => {
    const { writeCredentialsLegacy, writeCredentialsDataKey, writeCredentialsTokenOnly, readCredentials } = await import('@/persistence');
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'settlement-account' })).toString('base64url')}.sig`;
    if (variant === 'legacy') await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(7), token });
    else if (variant === 'dataKey') await writeCredentialsDataKey({ publicKey: new Uint8Array(32).fill(8), machineKey: new Uint8Array(32).fill(9), token });
    else await writeCredentialsTokenOnly({ token });
    const foreground = { tool: 'Write', arguments: { path: 'private-foreground-path' }, createdAt: 10 };
    const background = { tool: 'Write', arguments: { path: 'private-background-path' }, createdAt: 11 };
    let serverState: AgentState = { requests: { foreground, background }, completedRequests: {} };
    let serverVersion = 0;
    let online = false;
    const publishedCounts: unknown[] = [];
    const makeSocket = () => createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event === 'ping') return { v: 1 };
        if (event !== 'update-state') return { ok: true };
        if (!online) return { result: 'error' };
        const request = payload as { expectedVersion: number; agentState: string; activitySummaryV1: unknown };
        if (request.expectedVersion !== serverVersion) {
          return { result: 'version-mismatch', version: serverVersion, agentState: JSON.stringify(serverState) };
        }
        serverState = JSON.parse(request.agentState);
        serverVersion += 1;
        publishedCounts.push(request.activitySummaryV1);
        return { result: 'success', version: serverVersion, agentState: request.agentState };
      },
    });
    sessionSocketStub = makeSocket();
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const { ApiSessionClient } = await import('./sessionClient');
    const { AgentStateRequestStore } = await import('@/agent/permissions/agentStateRequestStore');
    const first = new ApiSessionClient(token, createPlainSessionFixture({ id: 's-settlement', agentState: serverState }));
    try {
      await new AgentStateRequestStore({ session: first, logPrefix: '[Test]' }).completeRequest({
        requestId: 'foreground', status: variant === 'tokenOnly' ? 'canceled' : 'approved',
        ...(variant === 'tokenOnly' ? {} : { decision: 'approved', observedCompletion: true }),
      });
    } catch (error) {
      await first.close();
      throw error;
    }
    const saved = JSON.stringify(await readPersistedOutboxMutations('s-settlement'));
    expect(saved).toContain('agent_state_request_settlement');
    expect(saved).not.toContain('private-foreground-path');
    expect(saved).not.toContain('private-background-path');
    await first.close();

    // The new process has an older snapshot; the server also gained another request.
    serverState.requests = { ...serverState.requests, newer: { ...foreground, createdAt: 30 } };
    serverVersion += 1;
    online = true;
    if (variant === 'tokenOnly') {
      const { configuration } = await import('@/configuration');
      const identity = await readFile(configuration.installationIdentityFile, 'utf8');
      await rm(configuration.installationIdentityFile);
      sessionSocketStub = makeSocket();
      const missingIdentity = new ApiSessionClient(token, createPlainSessionFixture({
        id: 's-settlement', agentState: { requests: { foreground, background } },
      }));
      try {
        await missingIdentity.flush();
        expect(await readPersistedOutboxMutations('s-settlement')).toEqual([
          expect.objectContaining({ kind: 'agent_state_request_settlement', payload: expect.objectContaining({
            content: expect.objectContaining({ t: 'installation_encrypted_v1' }),
          }) }),
        ]);
        await expect(readFile(configuration.installationIdentityFile)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(serverState.requests?.foreground).toEqual(foreground);
      } finally {
        await missingIdentity.close();
        await writeFile(configuration.installationIdentityFile, identity, { mode: 0o600 });
      }
      // Same-account authorization refresh must not rotate the local encryption key.
      await writeCredentialsTokenOnly({ token: `header.${Buffer.from(JSON.stringify({ sub: 'settlement-account', refreshed: true })).toString('base64url')}.sig` });
      expect((await readCredentials())?.encryption).toBeNull();
    }
    sessionSocketStub = makeSocket();
    const restarted = new ApiSessionClient(token, createPlainSessionFixture({
      id: 's-settlement', agentState: { requests: { foreground, background } }, agentStateVersion: 0,
    }));
    await expect.poll(async () => await readPersistedOutboxMutations('s-settlement')).toEqual([]);
    expect(serverState.requests).toEqual({ background, newer: { ...foreground, createdAt: 30 } });
    expect(serverState.completedRequests).toMatchObject({ foreground: { status: variant === 'tokenOnly' ? 'canceled' : 'approved' } });
    expect(publishedCounts).toContainEqual({ pendingPermissionRequestCount: 2, pendingUserActionRequestCount: 0 });
    await restarted.close();
  });

  beforeEach(async () => {
    vi.resetModules();
    vi.mocked(axios.get).mockReset();
    vi.mocked(axios.post).mockReset();
    supervisorConnect = null;
    supervisorControl = null;
    supervisorConnectedTransitions = 0;
    realSupervisorConnectedCompletion = null;
    useRealSupervisor = false;
    transportCreationCount = 0;
    sessionConnectionGate = null;
    disconnectSessionTransport = null;
    sessionSocketStub = null;
    sessionSocketStubFactory = null;
    userSocketStub = null;
    pendingConsumerModules = null;
    await useTempHappyHome();
  });

  afterEach(async () => {
    // The file logger owns a buffered writer outside the client lifecycle. Drain
    // its timer before removing the test's home, so it cannot recreate the folder.
    const { logger } = await import('@/ui/logger');
    logger.flushSync();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
    if (tempHomeDir) {
      await rm(tempHomeDir, { recursive: true, force: true });
      tempHomeDir = null;
    }
  });

  it('models repeated start while online as a connection-supervisor no-op', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    await expect.poll(() => supervisorConnectedTransitions).toBe(1);
    expect(supervisorControl?.getState()).toEqual({ phase: 'online' });
    await supervisorControl?.start();

    expect(supervisorControl?.getState()).toEqual({ phase: 'online' });
    expect(supervisorConnectedTransitions).toBe(1);
    await client.close();
  });

  it.each(['offline', 'late-failure', 'discarded', 'opencode', 'deferred', 'deferred-before-attach'] as const)('publishes a streamed final after reconnect without another turn (%s)', async (scenario) => {
    useRealSupervisor = true;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      features: { sharing: { pendingQueueV2: { enabled: true } } }, capabilities: {},
    }), { status: 200 })));
    const stored = new Map<string, unknown>();
    const firstAck = createDeferred<void>();
    let messageAttempts = 0;
    let committedMessageSeq = 0;
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, payload) => {
      if (event === 'message') {
        const message = payload as { localId: string; message: unknown };
        // Deferred attachment can also publish its startup-flush warning. Track
        // only the final's identity when checking replay and duplicate delivery.
        if (message.localId === 'final-segment') {
          messageAttempts += 1;
          if (scenario === 'late-failure' && messageAttempts === 1) {
            await firstAck.promise;
            return { ok: false, error: 'write_failed' };
          }
          stored.set(message.localId, message.message);
        }
        return { ok: true, id: message.localId, localId: message.localId, seq: ++committedMessageSeq };
      }
      return { ok: true };
    } });
    userSocketStub = createApiSessionSocketStub({ connected: false });
    const { ApiSessionClient } = await import('./sessionClient');
    const { createCurrentSessionTranscriptPort } = await import('./createCurrentSessionTranscriptPort');
    const { createStreamedTranscriptWriter } = await import('./streamedTranscriptWriter');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 'offline-final' }));
    let transcriptSession: StreamedTranscriptWriterSession = scenario === 'opencode'
      ? (await import('@/backends/opencode/server/createOpenCodeTranscriptStreamSession')).createOpenCodeTranscriptStreamSession({
        session: client, baseMeta: {},
      })
      : createCurrentSessionTranscriptPort(() => client);
    let deferredToAttach: DeferredApiSessionClient | null = null;
    if (scenario === 'deferred' || scenario === 'deferred-before-attach') {
      const { DeferredApiSessionClient } = await import('@/agent/runtime/startup/DeferredApiSessionClient');
      const deferred = new DeferredApiSessionClient({
        placeholderSessionId: 'PID-final', limits: { maxEntries: 10, maxBytes: 10_000 },
      });
      if (scenario === 'deferred-before-attach') deferredToAttach = deferred;
      else await deferred.attach(client as unknown as DeferredApiSessionTarget);
      transcriptSession = (await import('@/backends/claude/remote/createClaudeRemoteStreamedTranscriptSession'))
        .createClaudeRemoteStreamedTranscriptSession(deferred);
    }
    const writer = createStreamedTranscriptWriter({
      provider: scenario === 'opencode' ? 'opencode' : 'codex', session: transcriptSession,
      makeLocalId: () => 'final-segment', initialCheckpointDelayMs: 60_000,
    });
    const reconnect = createDeferred<void>();
    try {
      await expect.poll(() => realSupervisorConnectedCompletion).not.toBeNull();
      await realSupervisorConnectedCompletion;
      let inFlightFlush: Promise<unknown> | null = null;
      if (scenario === 'late-failure') {
        writer.appendAssistantDelta('FINAL-offline');
        inFlightFlush = writer.flushAll({ reason: 'turn-end' });
        await expect.poll(() => messageAttempts).toBe(1);
      }
      sessionConnectionGate = reconnect.promise;
      disconnectSessionTransport?.();
      if (scenario !== 'late-failure') {
        writer.appendAssistantDelta('FINAL-offline');
        const flush = writer.flushAll({ reason: 'turn-end' });
        if (deferredToAttach) {
          await expect.poll(() => deferredToAttach?.getBufferStats().entryCount).toBeGreaterThan(0);
          await deferredToAttach.attach(client as unknown as DeferredApiSessionTarget);
        }
        expect((await flush).assistant.didDurablyFlush).toBe(false);
      }
      expect(stored.size).toBe(0);
      if (scenario === 'discarded') writer.discard();
      reconnect.resolve();
      await expect.poll(() => client.getEphemeralStreamConnectionEpoch(), { timeout: 10_000 }).toBe(2);
      firstAck.resolve();
      await inFlightFlush;
      if (scenario === 'discarded') {
        expect(messageAttempts).toBe(0);
        return;
      }
      await expect.poll(() => stored.get('final-segment')).toMatchObject({
        t: 'plain', v: { content: { data: { type: 'message', message: 'FINAL-offline' } },
          meta: { happierStreamSegmentV1: { segmentState: 'complete' } } },
      });
      await expect.poll(() => writer.hasPendingSegments()).toBe(false);
      expect(stored.size).toBe(1);
      disconnectSessionTransport?.();
      await expect.poll(() => client.getEphemeralStreamConnectionEpoch(), { timeout: 10_000 }).toBe(3);
      await realSupervisorConnectedCompletion;
      expect(messageAttempts).toBe(scenario === 'late-failure' ? 2 : 1);
    } finally {
      reconnect.resolve();
      firstAck.resolve();
      writer.discard();
      await client.close();
    }
  });

  it.each([
    { recoverFeatures: false, bindLifecycleBeforeConnection: false, replaceSocketOnReconnect: false },
    { recoverFeatures: true, bindLifecycleBeforeConnection: false, replaceSocketOnReconnect: false },
    { recoverFeatures: false, bindLifecycleBeforeConnection: true, replaceSocketOnReconnect: false },
    { recoverFeatures: false, bindLifecycleBeforeConnection: true, replaceSocketOnReconnect: true },
  ])('withholds pending materialization until Runtime Activity acknowledgement ($recoverFeatures transient failure, $bindLifecycleBeforeConnection early lifecycle, $replaceSocketOnReconnect replacement socket)', async ({ recoverFeatures, bindLifecycleBeforeConnection, replaceSocketOnReconnect }) => {
    useRealSupervisor = true;
    const connectionReady = createDeferred<void>();
    if (bindLifecycleBeforeConnection) sessionConnectionGate = connectionReady.promise;
    const featuresResponse = createDeferred<Response>();
    const fetchFeatures = vi.fn(async () => await featuresResponse.promise);
    if (recoverFeatures) fetchFeatures.mockRejectedValueOnce(new TypeError('temporary network failure'));
    vi.stubGlobal('fetch', fetchFeatures);
    const currentFeaturesResponseBody = JSON.stringify({
      features: {
        sharing: {
          pendingQueueV2: { enabled: true },
          pendingDeliveryState: { enabled: true },
        },
      },
      capabilities: {
        session: {
          runtimeActivity: { protocolVersion: 2 },
          pendingInput: { protocolVersion: bindLifecycleBeforeConnection ? 2 : 1 },
        },
      },
    });

    const runtimeActivityAck = createDeferred<void>();
    const runtimeActivityRequest = createDeferred<Readonly<{
      sessionId: string;
      mutationId: string;
      snapshot: Readonly<{ state: string; activeCount: number }>;
    }>>();
    let pendingMaterializeCount = 0;
    let publisherRegistered = false;
    let activitySnapshotCount = 0;
    const createSessionSocket = (id: string, connected: boolean) => createApiSessionSocketStub({
      id,
      connected,
      emit: (event, args) => {
        if (event !== 'ping') return;
        const callback = args[0];
        if (typeof callback === 'function') callback();
      },
      emitWithAck: async (event, payload) => {
        if (event === 'ping') return { v: 1 };
        if (event === 'session-runtime-activity-snapshot') {
          activitySnapshotCount += 1;
          const request = payload as Awaited<typeof runtimeActivityRequest.promise>;
          runtimeActivityRequest.resolve(request);
          await runtimeActivityAck.promise;
          return {
            status: activitySnapshotCount === 1 ? 'applied' : 'unchanged',
            sessionId: request.sessionId,
            mutationId: request.mutationId,
            projection: {
              ...request.snapshot,
              observedAt: 1,
              revision: 1,
            },
          };
        }
        if (event === 'pending-materialize-next') {
          pendingMaterializeCount += 1;
          if (!publisherRegistered) {
            return { ok: false, error: 'forbidden' };
          }
          return {
            ok: true,
            didMaterialize: false,
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: 2,
          };
        }
        if (event === 'session-runtime-activity-close') {
          return { status: 'closed', sessionId: 's1' };
        }
        throw new Error(`Unexpected session socket ACK event: ${event}`);
      },
    });
    const initialSessionSocketStub = createSessionSocket(
      'session-socket-initial',
      !bindLifecycleBeforeConnection,
    );
    const replacementSessionSocketStub = createSessionSocket('session-socket-replacement', false);
    sessionSocketStub = initialSessionSocketStub;
    if (replaceSocketOnReconnect) {
      sessionSocketStubFactory = () => (
        transportCreationCount === 1
          ? initialSessionSocketStub
          : replacementSessionSocketStub
      );
    }
    userSocketStub = createApiSessionSocketStub({ id: 'user-socket', connected: false });

    const { ApiSessionClient } = await import('./sessionClient');
    const lifecycle = bindLifecycleBeforeConnection
      ? await (await import('@/agent/runtime/initializeBackendRunSession')).createBackendRunRuntimeActivityLifecycle(undefined)
      : null;
    const fixture = createPlainSessionFixture({
      id: 's1',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    });
    const client = new ApiSessionClient('tok', {
      ...fixture,
      metadata: { ...fixture.metadata, machineId: 'machine-1' },
    }, lifecycle?.clientConfig());

    if (lifecycle) {
      await lifecycle.attachSession(client);
      expect(fetchFeatures).not.toHaveBeenCalled();
      connectionReady.resolve();
    } else {
      await expect.poll(() => fetchFeatures).toHaveBeenCalledTimes(1);
      await client.getRuntimeActivitySnapshotPublisher().publish({ state: 'idle', activeCount: 0 });
    }
    await expect.poll(() => fetchFeatures).toHaveBeenCalledTimes(1);
    if (recoverFeatures) {
      await expect.poll(() => (
        (client as unknown as {
          sessionSyncPendingInputServerContract: { mode?: unknown } | null;
        }).sessionSyncPendingInputServerContract?.mode
      )).toBe('indeterminate');
    }
    featuresResponse.resolve(new Response(currentFeaturesResponseBody, { status: 200 }));
    const recoveryMaterialization = recoverFeatures
      ? client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })
      : null;
    await expect.poll(() => sessionSocketStub?.emitWithAck.mock.calls.map((call) => call[0]), {
      timeout: 5_000,
    }).toContain('session-runtime-activity-snapshot');
    await runtimeActivityRequest.promise;
    const beforePublisherAck = recoverFeatures
      ? null
      : await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    const materializationsBeforePublisherAck = pendingMaterializeCount;

    publisherRegistered = true;
    runtimeActivityAck.resolve();
    await expect.poll(() => (
      (client as unknown as {
        sessionSyncPendingInputServerContract: { mode?: unknown } | null;
      }).sessionSyncPendingInputServerContract?.mode
    )).toBe('session_sync_v2_pending_input_v1');
    if (lifecycle) {
      const axiosBoundary = (await import('axios')).default;
      vi.mocked(axiosBoundary.get).mockResolvedValue({ status: 200, data: {} });
      fetchFeatures.mockImplementation(async () => new Response(currentFeaturesResponseBody, { status: 200 }));
      expect(disconnectSessionTransport).not.toBeNull();
      disconnectSessionTransport?.();
      await expect.poll(() => activitySnapshotCount, { timeout: 10_000 }).toBe(2);
      await expect.poll(() => (
        (client as unknown as {
          sessionSyncPendingInputServerContract: { sessionConnectionEpoch?: number } | null;
        }).sessionSyncPendingInputServerContract?.sessionConnectionEpoch
      ), { timeout: 10_000 }).toBe(2);
      expect((client as unknown as { sessionMutationOutbox: {
        readRuntimeActivitySnapshotTail(): unknown;
      } }).sessionMutationOutbox.readRuntimeActivitySnapshotTail()).toMatchObject({
        custody: null,
        settlement: { result: 'unchanged', committedRevision: 1 },
      });
      expect(await readPersistedOutboxMutationCount('s1')).toBe(0);
    }
    await expect(recoveryMaterialization ?? client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toEqual({ type: 'no_pending' });

    await lifecycle?.dispose();
    await client.close();
    if (!recoverFeatures) expect(beforePublisherAck).toMatchObject({ type: 'retryable_transport' });
    expect(materializationsBeforePublisherAck).toBe(0);
    expect(pendingMaterializeCount).toBe(1);
    expect(transportCreationCount).toBe(lifecycle ? 2 : 1);
  });

  describe('Pending consumer convergence', () => {
    beforeEach(async () => {
      pendingConsumerModules = await loadPendingConsumerModules();
    });

    it.each([
      'publisher readiness',
      'version-mismatch acknowledgement and matching hint',
      'version-mismatch acknowledgement without another hint',
    ] as const)('delivers Pending through the real consumer after %s without another queue mutation', async (contract) => {
      const versionMismatch = contract !== 'publisher readiness';
      const withoutSecondHint = contract === 'version-mismatch acknowledgement without another hint';
      useRealSupervisor = true;
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        features: { sharing: { pendingQueueV2: { enabled: true }, pendingDeliveryState: { enabled: true } } },
        capabilities: { session: { runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 1 } } },
      }), { status: 200 })));

      const activityRequest = createDeferred<void>();
      const activityAck = createDeferred<void>();
      const metadata = { ...createPlainSessionFixture().metadata, machineId: 'machine-1' };
      let pendingClaims = 0;
      sessionSocketStub = createApiSessionSocketStub({
        connected: true,
        emit: (event, args) => {
          if (event === 'ping' && typeof args[0] === 'function') args[0]();
        },
        emitWithAck: async (event, payload) => {
          if (event === 'ping') return { v: 1 };
          if (event === 'session-runtime-activity-snapshot') {
            activityRequest.resolve();
            await activityAck.promise;
            const request = payload as Readonly<{
              sessionId: string;
              mutationId: string;
              snapshot: Readonly<{ state: string; activeCount: number }>;
            }>;
            return {
              status: 'applied', sessionId: request.sessionId, mutationId: request.mutationId,
              projection: { ...request.snapshot, observedAt: 1, revision: 1 },
            };
          }
          if (event === 'pending-materialize-next') {
            pendingClaims += 1;
            if (versionMismatch) {
              expect(payload).toMatchObject({
                sid: 's1',
                expectedPendingVersion: pendingClaims === 1 ? 1 : 2,
              });
            }
            if (versionMismatch && pendingClaims === 1) {
              return {
                ok: true, didMaterialize: false, deferredReason: 'pending_version_mismatch',
                pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2,
              };
            }
            return {
              ok: true, didMaterialize: true, didWrite: false,
              pendingCount: 1, pendingBlockedCount: 0, pendingVersion: versionMismatch ? 3 : 2,
              message: {
                id: null, seq: null, localId: 'early-pending', messageRole: 'user',
                providerAction: 'send', requestedAction: { v: 1, kind: 'enqueue' },
                deliveryState: { mode: 'provider', unresolved: true },
                content: { t: 'plain', v: {
                  role: 'user', localId: 'early-pending',
                  content: { type: 'text', text: 'prompt accepted before publisher readiness' },
                  meta: { source: 'ui', sentFrom: 'e2e' },
                } },
                createdAt: 1, updatedAt: 1,
              },
            };
          }
          if (event === 'session-runtime-activity-close') return { status: 'closed', sessionId: 's1' };
          throw new Error(`Unexpected session socket ACK event: ${event}`);
        },
      });
      userSocketStub = createApiSessionSocketStub({ connected: false });
      // The optional user-scoped transport stays offline; delivery must use the exact session socket.
      userSocketStub.connect.mockImplementation(() => userSocketStub);
      vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { session: createSessionRecordFixture({
        id: 's1', encryptionMode: 'plain', metadataVersion: 0, metadata: JSON.stringify(metadata),
        pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1, latestTurnStatus: null,
      }) } });

      if (!pendingConsumerModules) throw new Error('Missing real Pending consumer test preparation');
      const { ApiSessionClient, MessageQueue2, createSessionProviderInputConsumer, logger } = pendingConsumerModules;
      const decisions = vi.spyOn(logger, 'infoFile');
      const client = new ApiSessionClient('tok', createPlainSessionFixture({
        id: 's1', pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 0,
        metadata,
      }));
      const controller = new AbortController();
      const queue = new MessageQueue2<null>(() => 'mode');
      const consumer = createSessionProviderInputConsumer({ messageQueue: queue, session: client });
      let publication: Promise<void> | null = null;
      try {
        client.onUserMessage((message, info) => queue.push(message.content.text, null, {
          userMessageLocalId: message.localId,
          userMessageSeq: info?.seq ?? null,
          providerAcceptancePending: info?.providerAcceptancePending,
        }));
        publication = client.getRuntimeActivitySnapshotPublisher().publish({ state: 'idle', activeCount: 0 });
        await activityRequest.promise;
        if (versionMismatch) {
          activityAck.resolve();
          await publication;
          // Finish the real connection callback so its readiness wake cannot rescue a later lost ACK wake.
          expect(realSupervisorConnectedCompletion).not.toBeNull();
          await realSupervisorConnectedCompletion;
        }
        sessionSocketStub.trigger('update', {
          id: 'early-pending-hint', seq: 1, createdAt: 1,
          body: { t: 'pending-changed', sid: 's1', pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 },
        });
        const batch = consumer.waitForNextInput({ abortSignal: controller.signal });
        const received: Array<Awaited<typeof batch>> = [];
        void batch.then((value) => { received.push(value); });
        if (!versionMismatch) {
          // Observe the real consumer's bounded pre-readiness rejoin before releasing the OS/network ACK.
          await expect.poll(() => decisions.mock.calls.filter(([label, detail]) => (
            label === '[pendingQueue] input consumer materialization decision'
            && detail !== null && typeof detail === 'object'
            && 'resultType' in detail && detail.resultType === 'retryable_transport'
          )).length).toBeGreaterThanOrEqual(2);
          expect(pendingClaims).toBe(0);
          activityAck.resolve();
        } else {
          await expect.poll(() => decisions.mock.calls.filter(([label, detail]) => (
            label === '[pendingQueue] input consumer materialization decision'
            && detail !== null && typeof detail === 'object'
            && 'deferredReason' in detail && detail.deferredReason === 'pending_version_mismatch'
          )).length).toBe(1);
          expect(pendingClaims).toBeGreaterThanOrEqual(1);
          if (!withoutSecondHint) {
            // The ordinary hint may arrive after the ACK taught us this same projection.
            // Deduplicating that hint must not strand the newly learned deliverable row.
            sessionSocketStub.trigger('update', {
              id: 'matching-pending-hint', seq: 2, createdAt: 2,
              body: { t: 'pending-changed', sid: 's1', pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
            });
          }
        }
        await expect.poll(() => received).toEqual([expect.objectContaining({
          message: 'prompt accepted before publisher readiness',
          userMessageLocalIds: ['early-pending'], providerAcceptancePending: true,
        })]);
        await batch;
        expect(pendingClaims).toBe(versionMismatch ? 2 : 1);
        expect(queue.size()).toBe(0);
      } finally {
        controller.abort();
        activityAck.resolve();
        await publication;
        await consumer.closeProviderInputAdmissionAndWaitForDispatches();
        await client.close();
        decisions.mockRestore();
      }
    });
  });

  it('does not queue a terminal session turn mutation when no turn is active', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    const deliveredEvents: string[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emit: (event: string, args: unknown[]) => {
        if (event === 'ping') {
          const callback = args[0];
          if (typeof callback === 'function') callback();
        }
      },
      emitWithAck: async (event: string) => {
        deliveredEvents.push(event);
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('codex', taskCompleteMessage);

    await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(0);

    sessionSocketStub.connected = true;
    await client.flush();

    expect(deliveredEvents).not.toContain('session-turn-mutation');
    await client.close();
  });

  it('delivers queued terminal session turn mutations for an active turn after reconnect', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    const deliveredEvents: string[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emit: (event: string, args: unknown[]) => {
        if (event === 'ping') {
          const callback = args[0];
          if (typeof callback === 'function') callback();
        }
      },
      emitWithAck: async (event: string) => {
        deliveredEvents.push(event);
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('codex', { type: 'task_started', id: 'turn-1' });
    client.sendAgentMessage('codex', taskCompleteMessage);

    await expect.poll(async () => (await readPersistedOutboxMutationCount('s1')) > 0).toBe(true);

    sessionSocketStub.connected = true;
    await client.flush();

    expect(deliveredEvents).toContain('session-turn-mutation');
    await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(0);
    await client.close();
  });

  it('delivers a queued runtime Activity snapshot before following canonical turn and transcript mutations', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    const deliveredEvents: string[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async (event: string, payload: unknown) => {
        if (
          event === 'session-runtime-activity-snapshot'
          || event === 'session-turn-mutation'
          || event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1
        ) {
          deliveredEvents.push(event);
        }
        if (event === 'ping') {
          return { ok: true };
        }
        if (event === 'session-runtime-activity-snapshot') {
          const request = payload as {
            sessionId: string;
            mutationId: string;
            snapshot: { state: string; activeCount: number };
          };
          return {
            status: 'applied',
            sessionId: request.sessionId,
            mutationId: request.mutationId,
            projection: {
              ...request.snapshot,
              observedAt: 1,
              revision: 1,
            },
          };
        }
        if (event === 'session-runtime-activity-close') {
          return { status: 'closed', sessionId: 's1' };
        }
        if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
          return { ok: true, capability: SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_V1 };
        }
        if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
          return {
            ok: true,
            status: 'observed',
            id: 'message-1',
            seq: 1,
            localId: (payload as { localId?: string }).localId ?? 'assistant-1',
            didWrite: true,
            ingestedAt: 1,
          };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { createSessionMutationOutbox } = await import('./mutations/createSessionMutationOutbox');
    const { createRuntimeActivitySnapshotSessionMutationPublisher } = await import('./mutations/runtimeActivitySnapshotSessionMutationPublisher');
    const {
      createSessionTurnMutation,
      createTranscriptMessageAppendMutation,
    } = await import('./mutations/sessionMutationTypes');
    const outbox = createSessionMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub!,
      requestReconnect: () => {},
    });
    await outbox.awaitReady();
    await outbox.setSessionSyncPendingInputServerContract({
      mode: 'session_sync_v2_pending_input_v1',
      runtimeActivity: 'v2',
      pendingInput: 'v1',
      sessionConnectionEpoch: 1,
      socket: sessionSocketStub,
    });
    const publisher = createRuntimeActivitySnapshotSessionMutationPublisher({ sessionId: 's1', journal: outbox });

    await publisher.publish({
      state: 'active',
      activeCount: 1,
    });
    expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({
      sequence: 1,
      custody: {
        identity: {
          mutationKey: 'runtime-activity-snapshot:s1',
          admissionOrder: 1,
        },
        value: { state: 'active', activeCount: 1 },
      },
      settlement: null,
    });
    await outbox.enqueueSessionTurn(createSessionTurnMutation({
      sessionId: 's1',
      mutationId: 'turn-begin',
      action: 'begin',
      turnId: 'turn-1',
      provider: 'codex',
      providerTurnId: 'provider-turn-1',
      observedAt: 1,
    }));
    await outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
      sessionId: 's1',
      localId: 'assistant-1',
      content: JSON.stringify({ type: 'message', message: 'authoritative assistant reply' }),
      provenance: { kind: 'non_dependent', source: 'external' },
      createdAt: 2,
      updatedAt: 2,
    }));
    await outbox.enqueueSessionTurn(createSessionTurnMutation({
      sessionId: 's1',
      mutationId: 'turn-complete',
      action: 'complete',
      turnId: 'turn-1',
      provider: 'codex',
      providerTurnId: 'provider-turn-1',
      observedAt: 3,
    }));

    await expect.poll(async () => (await readPersistedOutboxMutations('s1')).map((mutation) => (
      (mutation as { kind?: unknown }).kind
    ))).toEqual([
      'runtime_activity_snapshot',
      'session_turn',
      'transcript_message_append',
      'session_turn',
    ]);
    expect(deliveredEvents).toEqual([]);

    sessionSocketStub.connected = true;
    await outbox.flush('connect');

    expect(deliveredEvents).toEqual([
      'session-runtime-activity-snapshot',
      'session-turn-mutation',
      SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
      'session-turn-mutation',
    ]);
    await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(0);
    expect(outbox.readRuntimeActivitySnapshotTail()).toMatchObject({
      sequence: 2,
      custody: null,
      settlement: {
        identity: {
          mutationKey: 'runtime-activity-snapshot:s1',
          admissionOrder: 1,
        },
        desiredValue: { state: 'active', activeCount: 1 },
        result: 'applied',
        committedProjection: {
          state: 'active',
          activeCount: 1,
          observedAt: 1,
          revision: 1,
        },
        committedRevision: 1,
      },
    });
    await publisher.close();
    await outbox.close();
  });

  it('keeps undelivered terminal session turn mutations persisted when the client closes', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('codex', { type: 'task_started', id: 'turn-1' });
    client.sendAgentMessage('codex', taskCompleteMessage);

    await expect.poll(async () => (await readPersistedOutboxMutationCount('s1')) > 0).toBe(true);
    await client.close();

    expect(await readPersistedOutboxMutationCount('s1')).toBe(2);
  });

  it('uses HTTP fallback for session turn mutations when the socket is disconnected', async () => {
    vi.mocked(axios.post).mockResolvedValue({ status: 200, data: { ok: true } } as never);
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('codex', { type: 'task_started', id: 'turn-1' });
    client.sendAgentMessage('codex', taskCompleteMessage);

    await expect.poll(() => vi.mocked(axios.post).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(axios.post).mock.calls[0]?.[0]).toContain('/v1/sessions/s1/turns/mutations');
    expect(vi.mocked(axios.post).mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      v: 1,
      sessionId: 's1',
      action: 'begin',
      turnId: expect.any(String),
    }));
    await client.close();
  });

  it('delivers disconnected terminal turn mutations after their begin mutation when the begin delivery is still in flight', async () => {
    const firstHttpAttempt = createDeferred<never>();
    const httpActions: string[] = [];
    let isFirstHttpAttempt = true;
    vi.mocked(axios.post).mockImplementation(async (_url, body) => {
      const action = (body as { action?: unknown }).action;
      httpActions.push(typeof action === 'string' ? action : 'unknown');
      if (isFirstHttpAttempt) {
        isFirstHttpAttempt = false;
        return await firstHttpAttempt.promise;
      }
      return { status: 200, data: { ok: true } } as never;
    });
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    await client.sessionTurnLifecycle.beginTurn({ provider: 'codex', providerTurnId: 'turn-1' });
    await expect.poll(() => httpActions).toEqual(['begin']);

    await client.sessionTurnLifecycle.completeTurn({ provider: 'codex', providerTurnId: 'turn-1' });
    await expect.poll(() => readPersistedOutboxMutations('s1')).toEqual([
      expect.objectContaining({
        kind: 'session_turn',
        payload: expect.objectContaining({ action: 'begin' }),
      }),
      expect.objectContaining({
        kind: 'session_turn',
        payload: expect.objectContaining({ action: 'complete' }),
      }),
    ]);
    firstHttpAttempt.reject(new Error('server offline'));

    await client.flush();
    await expect.poll(() => httpActions).toEqual(['begin', 'begin', 'complete']);
    await client.close();
  });

  it('keeps terminal turn mutations queued behind a failed begin retry', async () => {
    const originalBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
    const originalJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';

    const httpActions: string[] = [];
    let beginAttempts = 0;
    let outbox: {
      flush(reason: 'connect' | 'timer' | 'flush' | 'startup' | 'enqueue'): Promise<void>;
      close(): Promise<void>;
    } | null = null;
    vi.mocked(axios.post).mockImplementation(async (_url, body) => {
      const action = (body as { action?: unknown }).action;
      const normalizedAction = typeof action === 'string' ? action : 'unknown';
      httpActions.push(normalizedAction);
      if (normalizedAction === 'begin') {
        beginAttempts += 1;
        if (beginAttempts === 1) {
          throw new Error(`server offline for begin attempt ${beginAttempts}`);
        }
      }
      return { status: 200, data: { ok: true } } as never;
    });
    const socket = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });

    try {
      const { createSessionMutationOutbox } = await import('./mutations/createSessionMutationOutbox');
      const { createSessionTurnMutation } = await import('./mutations/sessionMutationTypes');
      const { saveSessionMutationOutbox } = await import('./mutations/sessionMutationPersistence');
      const begin = createSessionTurnMutation({
        sessionId: 's1',
        action: 'begin',
        turnId: 'session-turn:turn-1',
        provider: 'codex',
        providerTurnId: 'turn-1',
        mutationId: 'mutation-begin',
        observedAt: 100,
      });
      const complete = createSessionTurnMutation({
        sessionId: 's1',
        action: 'complete',
        turnId: 'session-turn:turn-1',
        provider: 'codex',
        providerTurnId: 'turn-1',
        mutationId: 'mutation-complete',
        observedAt: 200,
      });
      await saveSessionMutationOutbox(await createRuntimePersistenceContext('s1'), [
        {
          kind: 'session_turn',
          mutationId: begin.mutationId,
          payload: begin,
          createdAt: 100,
          attempts: 0,
          nextAttemptAt: 0,
        },
        {
          kind: 'session_turn',
          mutationId: complete.mutationId,
          payload: complete,
          createdAt: 200,
          attempts: 0,
          nextAttemptAt: 0,
        },
      ]);

      outbox = createSessionMutationOutbox({
        token: 'tok',
        sessionId: 's1',
        getSocket: () => socket,
        requestReconnect: () => {},
      });

      await expect.poll(() => httpActions).toEqual(['begin']);
      await expect.poll(() => readPersistedOutboxMutations('s1')).toEqual([
        expect.objectContaining({
          kind: 'session_turn',
          payload: expect.objectContaining({ action: 'begin' }),
        }),
        expect.objectContaining({
          kind: 'session_turn',
          payload: expect.objectContaining({ action: 'complete' }),
        }),
      ]);

      await outbox.flush('flush');

      expect(httpActions).toEqual(['begin', 'begin', 'complete']);
      await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(0);
    } finally {
      await outbox?.close().catch(() => {});
      if (originalBaseRetryMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = originalBaseRetryMs;
      }
      if (originalJitterMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = originalJitterMs;
      }
    }
  });

  it('keeps disconnected session turn mutations queued when HTTP fallback reports an unsupported route', async () => {
    const originalBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
    const originalJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });
    const { logger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const socket = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });
    let outbox: {
      flush(reason: 'connect' | 'timer' | 'flush' | 'startup' | 'enqueue'): Promise<void>;
      close(): Promise<void>;
    } | null = null;

    try {
      const { createSessionMutationOutbox } = await import('./mutations/createSessionMutationOutbox');
      const { createSessionTurnMutation } = await import('./mutations/sessionMutationTypes');
      const { saveSessionMutationOutbox } = await import('./mutations/sessionMutationPersistence');
      const begin = createSessionTurnMutation({
        sessionId: 's1',
        action: 'begin',
        turnId: 'session-turn:turn-1',
        provider: 'codex',
        providerTurnId: 'turn-1',
        mutationId: 'mutation-begin',
        observedAt: 100,
      });
      await saveSessionMutationOutbox(await createRuntimePersistenceContext('s1'), [
        {
          kind: 'session_turn',
          mutationId: begin.mutationId,
          payload: begin,
          createdAt: 100,
          attempts: 0,
          nextAttemptAt: Date.now() + 60_000,
        },
      ]);

      outbox = createSessionMutationOutbox({
        token: 'tok',
        sessionId: 's1',
        getSocket: () => socket,
        requestReconnect: () => {},
      });

      await outbox.flush('flush');
      await expect.poll(() => vi.mocked(axios.post).mock.calls.length).toBe(1);
      await expect.poll(() => readPersistedOutboxMutations('s1')).toEqual([
        expect.objectContaining({
          kind: 'session_turn',
          payload: expect.objectContaining({ action: 'begin' }),
          attempts: 1,
        }),
      ]);
      expect(debugSpy.mock.calls.some(([message]) =>
        message === '[API] Session turn mutation unsupported by server; keeping durable outbox mutation queued'
      )).toBe(false);
    } finally {
      await outbox?.close();
      debugSpy.mockRestore();
      if (originalBaseRetryMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = originalBaseRetryMs;
      }
      if (originalJitterMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = originalJitterMs;
      }
    }
  });

  it('keeps durable outbox authentication errors queued without consuming retry attempts', async () => {
    const originalBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
    const originalJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    const authError = Object.assign(new Error('authentication required'), { response: { status: 401 } });
    vi.mocked(axios.post).mockRejectedValue(authError);
    const socket = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });
    let outbox: {
      flush(reason: 'connect' | 'timer' | 'flush' | 'startup' | 'enqueue'): Promise<void>;
      close(): Promise<void>;
    } | null = null;

    try {
      const { createSessionMutationOutbox } = await import('./mutations/createSessionMutationOutbox');
      const { createSessionTurnMutation } = await import('./mutations/sessionMutationTypes');
      const { saveSessionMutationOutbox } = await import('./mutations/sessionMutationPersistence');
      const begin = createSessionTurnMutation({
        sessionId: 's1',
        action: 'begin',
        turnId: 'session-turn:turn-1',
        provider: 'codex',
        providerTurnId: 'turn-1',
        mutationId: 'mutation-begin',
        observedAt: 100,
      });
      await saveSessionMutationOutbox(await createRuntimePersistenceContext('s1'), [
        {
          kind: 'session_turn',
          mutationId: begin.mutationId,
          payload: begin,
          createdAt: 100,
          attempts: 0,
          nextAttemptAt: 0,
        },
      ]);

      outbox = createSessionMutationOutbox({
        token: 'tok',
        sessionId: 's1',
        getSocket: () => socket,
        requestReconnect: () => {},
      });

      await outbox.flush('flush');
      await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([
        expect.objectContaining({
          kind: 'session_turn',
          mutationId: 'mutation-begin',
          attempts: 0,
        }),
      ]);
    } finally {
      await outbox?.close();
      if (originalBaseRetryMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = originalBaseRetryMs;
      }
      if (originalJitterMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = originalJitterMs;
      }
    }
  });

  it('drains in-flight durable session mutations before close returns', async () => {
    const httpDelivery = createDeferred<{ status: number; data: { ok: true } }>();
    const httpActions: string[] = [];
    let closeSettled = false;
    let outbox: {
      enqueueSessionTurn(mutation: Awaited<ReturnType<typeof import('./mutations/sessionMutationTypes').createSessionTurnMutation>>): Promise<void>;
      close(): Promise<void>;
    } | null = null;
    vi.mocked(axios.post).mockImplementation(async (_url, body) => {
      const action = (body as { action?: unknown }).action;
      httpActions.push(typeof action === 'string' ? action : 'unknown');
      return await httpDelivery.promise as never;
    });
    const socket = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });

    try {
      const { createSessionMutationOutbox } = await import('./mutations/createSessionMutationOutbox');
      const { createSessionTurnMutation } = await import('./mutations/sessionMutationTypes');
      outbox = createSessionMutationOutbox({
        token: 'tok',
        sessionId: 's1',
        getSocket: () => socket,
        requestReconnect: () => {},
      });
      await outbox.enqueueSessionTurn(createSessionTurnMutation({
        sessionId: 's1',
        action: 'begin',
        turnId: 'session-turn:turn-1',
        provider: 'codex',
        providerTurnId: 'turn-1',
        mutationId: 'mutation-begin',
        observedAt: 100,
      }));

      await expect.poll(() => httpActions).toEqual(['begin']);
      const closePromise = outbox.close().then(() => {
        closeSettled = true;
      });
      await expect.poll(() => closeSettled, { timeout: 50 }).toBe(false);

      httpDelivery.resolve({ status: 200, data: { ok: true } });
      await closePromise;

      await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(0);
    } finally {
      httpDelivery.resolve({ status: 200, data: { ok: true } });
      await outbox?.close();
    }
  });

  it('reuses one session-owned turn id across begin and terminal markers', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    const turnMutations: Array<Record<string, unknown>> = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event === 'session-turn-mutation') {
          turnMutations.push(payload as Record<string, unknown>);
          return { ok: true };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('opencode', { type: 'task_started', id: 'provider-start' });
    client.sendAgentMessage('opencode', { type: 'task_complete', id: 'random-terminal' });

    await expect.poll(() => turnMutations).toEqual([
      expect.objectContaining({ action: 'begin' }),
      expect.objectContaining({ action: 'complete' }),
    ]);
    expect(turnMutations[0]?.turnId).toBe(turnMutations[1]?.turnId);
    expect(turnMutations[0]?.turnId).not.toBe('provider-start');
    expect(turnMutations[1]?.turnId).not.toBe('random-terminal');
    expect(JSON.stringify(turnMutations)).not.toContain(reusableUnknownTurnId);
    await client.close();
  });

  it('commits compatibility lifecycle markers with the lifecycle turn id', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    const turnMutations: Array<Record<string, unknown>> = [];
    const lifecycleBodies: Array<Record<string, unknown>> = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event === 'session-turn-mutation') {
          turnMutations.push(payload as Record<string, unknown>);
          return { ok: true };
        }
        if (event === 'message') {
          const message = (payload as { message?: unknown }).message;
          const plainValue = message && typeof message === 'object' && (message as { t?: unknown }).t === 'plain'
            ? (message as { v?: unknown }).v
            : null;
          const data = plainValue && typeof plainValue === 'object'
            ? ((plainValue as { content?: { data?: unknown } }).content?.data)
            : null;
          if (
            data
            && typeof data === 'object'
            && ['task_started', 'turn_aborted'].includes(String((data as { type?: unknown }).type))
          ) {
            lifecycleBodies.push(data as Record<string, unknown>);
          }
          return { ok: true, id: 'm1', seq: lifecycleBodies.length || 1, localId: (payload as { localId?: string }).localId ?? 'l1' };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('opencode', { type: 'task_started', id: 'provider-start' }, { localId: 'start-marker' });
    client.sendAgentMessage('opencode', { type: 'turn_aborted', id: 'random-abort-id' }, { localId: 'abort-marker' });

    await expect.poll(() => turnMutations).toEqual([
      expect.objectContaining({ action: 'begin' }),
      expect.objectContaining({ action: 'cancel' }),
    ]);
    await expect.poll(() => lifecycleBodies).toEqual([
      expect.objectContaining({ type: 'task_started', id: turnMutations[0]?.turnId }),
      expect.objectContaining({ type: 'turn_aborted', id: turnMutations[0]?.turnId }),
    ]);
    await client.close();
  });

  it('closes the active turn when a terminal marker has no trusted id', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    const turnMutations: Array<Record<string, unknown>> = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event === 'session-turn-mutation') {
          turnMutations.push(payload as Record<string, unknown>);
          return { ok: true };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('opencode', { type: 'task_started', id: 'provider-start' });
    client.sendAgentMessage('opencode', { type: 'turn_cancelled', id: '' });

    await expect.poll(() => turnMutations).toEqual([
      expect.objectContaining({ action: 'begin' }),
      expect.objectContaining({ action: 'cancel' }),
    ]);
    expect(turnMutations[1]?.turnId).toBe(turnMutations[0]?.turnId);
    expect(JSON.stringify(turnMutations)).not.toContain(reusableUnknownTurnId);
    await client.close();
  });

  it('does not let a random terminal marker replace the active turn id', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    const turnMutations: Array<Record<string, unknown>> = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event === 'session-turn-mutation') {
          turnMutations.push(payload as Record<string, unknown>);
          return { ok: true };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    client.sendAgentMessage('opencode', { type: 'task_started', id: 'provider-start' });
    client.sendAgentMessage('opencode', { type: 'turn_aborted', id: 'random-abort-id' });

    await expect.poll(() => turnMutations).toEqual([
      expect.objectContaining({ action: 'begin' }),
      expect.objectContaining({ action: 'cancel' }),
    ]);
    expect(turnMutations[1]?.turnId).toBe(turnMutations[0]?.turnId);
    expect(turnMutations[1]?.turnId).not.toBe('random-abort-id');
    await client.close();
  });

  it('does not erase recorded runtime issue details when a bare failed marker follows', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    const issue = {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'auth_error',
      source: 'auth_error',
      occurredAt: 123,
      sanitizedPreview: 'Authentication failed',
    } as const;
    const turnMutations: Array<Record<string, unknown>> = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event === 'session-turn-mutation') {
          turnMutations.push(payload as Record<string, unknown>);
          return { ok: true };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    expect('updatePrimaryTurnRuntimeState' in client).toBe(false);

    await client.sessionTurnLifecycle.beginTurn({ provider: 'codex' });
    await client.sessionTurnLifecycle.failTurn({
      provider: 'codex',
      issue,
    });
    client.sendAgentMessage('codex', { type: 'turn_failed', id: '' });

    await expect.poll(() => turnMutations.length).toBeGreaterThan(0);
    expect(turnMutations.filter((mutation) => mutation.action === 'fail')).toEqual([
      expect.objectContaining({ issue }),
    ]);
    expect(JSON.stringify(turnMutations)).not.toContain(reusableUnknownTurnId);
    await client.close();
  });

  it('allocates a session turn id for an active turn instead of falling back to a reusable unknown id', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    const turnMutations: Array<Record<string, unknown>> = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event === 'session-turn-mutation') {
          turnMutations.push(payload as Record<string, unknown>);
          return { ok: true };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    expect('updatePrimaryTurnRuntimeState' in client).toBe(false);

    await client.sessionTurnLifecycle.beginTurn({});
    await client.sessionTurnLifecycle.completeTurn();

    await expect.poll(() => turnMutations).toEqual([
      expect.objectContaining({ action: 'begin', turnId: expect.any(String) }),
      expect.objectContaining({ action: 'complete', turnId: expect.any(String) }),
    ]);
    expect(turnMutations[0]?.turnId).toBe(turnMutations[1]?.turnId);
    expect(turnMutations[0]?.turnId).not.toBe(reusableUnknownTurnId);
    await client.close();
  });

  it('keeps unsupported old-preview session turn mutations queued without a lifecycle state fallback', async () => {
    const originalBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
    const originalJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    vi.mocked(axios.post).mockRejectedValue({ response: { status: 404 } });
    const deliveredEvents: string[] = [];
    const agentStateUpdates: unknown[] = [];
    const questionCapability = { capabilities: { structuredQuestionAnswersV1Supported: true } };
    let sessionTurnMutationAttempts = 0;
    const { logger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event !== 'update-state') deliveredEvents.push(event);
        if (event === 'session-turn-mutation') {
          sessionTurnMutationAttempts += 1;
          if (sessionTurnMutationAttempts === 1) return { ok: true };
          return { ok: false, errorCode: 'unsupported' };
        }
        if (event === 'update-state') {
          const updateStatePayload = payload as { agentState: unknown; expectedVersion: number };
          const agentState: unknown = JSON.parse(String(updateStatePayload.agentState));
          agentStateUpdates.push(agentState);
          // Session permission setup independently publishes this capability. Every
          // other state write remains forbidden by the lifecycle fallback assertion.
          if (!isDeepStrictEqual(agentState, questionCapability)) deliveredEvents.push(event);
          return {
            result: 'success',
            agentState: updateStatePayload.agentState,
            version: updateStatePayload.expectedVersion + 1,
          };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    let client: {
      close(): Promise<void>;
      flush(): Promise<void>;
      sessionTurnLifecycle: {
        beginTurn(input: object): Promise<unknown>;
        failTurn(input: object): Promise<unknown>;
      };
    } | null = null;

    try {
      const { ApiSessionClient } = await import('./sessionClient');
      client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      await expect.poll(() => supervisorControl?.getState().phase).toBe('online');
      await client.flush();

      await client.sessionTurnLifecycle.beginTurn({});
      await client.sessionTurnLifecycle.failTurn({});

      await expect.poll(() => deliveredEvents).toEqual([
        'session-turn-mutation',
        'session-turn-mutation',
      ]);
      await expect.poll(() => readPersistedOutboxMutations('s1')).toSatisfy((mutations) => {
        return (
          mutations.length === 1
          && mutations[0]?.kind === 'session_turn'
          && (mutations[0]?.payload as { action?: unknown })?.action === 'fail'
          && typeof mutations[0]?.attempts === 'number'
          && mutations[0].attempts >= 1
        );
      });
      expect(agentStateUpdates).toEqual([questionCapability]);
      const unsupportedDiagnostics = debugSpy.mock.calls.filter(([message]) =>
        message === '[API] Session turn mutation unsupported by server; keeping durable outbox mutation queued'
      );
      expect(unsupportedDiagnostics).toHaveLength(1);
      expect(unsupportedDiagnostics[0]?.[1]).toEqual(expect.objectContaining({
        sessionId: 's1',
        mutationId: expect.any(String),
        action: 'fail',
        turnId: expect.any(String),
        serverOrigin: expect.any(String),
        socket: expect.objectContaining({ transport: 'socket', evidence: 'unsupported_ack' }),
        http: expect.objectContaining({ transport: 'http', evidence: 'unsupported_status', status: 404 }),
      }));
    } finally {
      debugSpy.mockRestore();
      await client?.close();
      if (originalBaseRetryMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = originalBaseRetryMs;
      }
      if (originalJitterMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = originalJitterMs;
      }
    }
  });

  it('keeps 400 session turn mutation rejections queued without emitting update-state', async () => {
    const originalBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
    const originalJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    vi.mocked(axios.post).mockRejectedValue({ response: { status: 400 } });
    const deliveredEvents: string[] = [];
    const { logger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const socket = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string) => {
        deliveredEvents.push(event);
        if (event === 'session-turn-mutation') {
          return { result: 'error' };
        }
        if (event === 'update-state') {
          throw new Error('400 session turn mutation rejection must not fall back to update-state');
        }
        return { ok: true };
      },
    });
    let outbox: {
      close(): Promise<void>;
    } | null = null;

    try {
      const { createSessionMutationOutbox } = await import('./mutations/createSessionMutationOutbox');
      const { createSessionTurnMutation } = await import('./mutations/sessionMutationTypes');
      const { saveSessionMutationOutbox } = await import('./mutations/sessionMutationPersistence');
      const fail = createSessionTurnMutation({
        sessionId: 's1',
        action: 'fail',
        turnId: 'session-turn:turn-1',
        provider: 'codex',
        providerTurnId: 'turn-1',
        issue: {
          v: 1,
          scope: 'primary_session',
          status: 'failed',
          code: 'provider_turn_failed',
          source: 'unknown',
          occurredAt: 200,
          provider: 'codex',
          providerTurnId: 'turn-1',
          sanitizedPreview: 'Provider reported turn failure',
        },
        mutationId: 'mutation-fail',
        observedAt: 200,
      });
      await saveSessionMutationOutbox(await createRuntimePersistenceContext('s1'), [
        {
          kind: 'session_turn',
          mutationId: fail.mutationId,
          payload: fail,
          createdAt: 200,
          attempts: 0,
          nextAttemptAt: 0,
        },
      ]);

      outbox = createSessionMutationOutbox({
        token: 'tok',
        sessionId: 's1',
        getSocket: () => socket,
        requestReconnect: () => {},
      });

      await expect.poll(() => deliveredEvents).toEqual(['session-turn-mutation']);
      await expect.poll(() => readPersistedOutboxMutations('s1')).toEqual([
        expect.objectContaining({
          kind: 'session_turn',
          payload: expect.objectContaining({ action: 'fail' }),
          attempts: 1,
        }),
      ]);
      expect(socket.emitWithAck).not.toHaveBeenCalledWith(
        'update-state',
        expect.anything(),
      );
      expect(debugSpy.mock.calls.some(([message]) =>
        message === '[API] Session turn mutation unsupported by server; keeping durable outbox mutation queued'
      )).toBe(false);
    } finally {
      await outbox?.close();
      debugSpy.mockRestore();
      if (originalBaseRetryMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = originalBaseRetryMs;
      }
      if (originalJitterMs === undefined) {
        delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
      } else {
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = originalJitterMs;
      }
    }
  });

});

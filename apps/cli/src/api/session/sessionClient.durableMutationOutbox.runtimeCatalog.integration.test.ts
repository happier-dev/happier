import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
  createSessionTurnMutationAppliedHttpResponse,
  createSessionTurnMutationAppliedSocketAck,
  createSessionTranscriptHomeStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { createKeyedStreamedTranscriptBridge } from './createKeyedStreamedTranscriptBridge';
import { createRuntimeTranscriptProjector } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1, SessionTranscriptObservationAckV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import type { SessionTurnMutationV1 } from '@happier-dev/protocol';
import type { createSessionSocketTransport } from './connection/createSessionSocketTransport';
import type { RegisteredSessionStateFieldMutationV1 } from './client/transport/mutations/sessionClientDurableMutationTypes';
import type { createUserScopedSocket } from './sockets';

import axios from 'axios';

import { reloadConfiguration } from '@/configuration';
import { logger } from '@/ui/logger';
import { createRuntimeSessionClientDurableMutationOutbox } from './client/transport/mutations/createRuntimeSessionClientDurableMutationOutbox';
import { resetSessionClientDurableMutationOutboxStateForTests } from './client/transport/mutations/createSessionClientDurableMutationOutbox';
import {
  appendSessionClientDurableMutationDeadLetters,
  loadSessionClientDurableMutationOutbox,
  resolveSessionClientDurableMutationDeadLetterPath,
  resolveSessionClientDurableMutationOutboxPath,
  saveSessionClientDurableMutationOutbox,
} from './client/transport/mutations/sessionClientDurableMutationPersistence';
import { ApiSessionClient } from './sessionClient';

type SessionSocketTransportResult = ReturnType<typeof createSessionSocketTransport>;
type UserScopedSocket = ReturnType<typeof createUserScopedSocket>;

function serverContract(
  mode:
    | 'session_sync_v3_publisher_authority_check_v1'
    | 'session_sync_v2_pending_input_v1'
    | 'released_server_v0_2_1',
) {
  return {
    mode,
    runtimeActivity: mode === 'released_server_v0_2_1' ? 'legacy' : 'v2',
    pendingInput: mode === 'released_server_v0_2_1' ? 'released_server_v0_2_1' : 'v1',
    publisherAuthority: mode === 'session_sync_v3_publisher_authority_check_v1'
      ? 'v1'
      : 'indeterminate',
    sessionConnectionEpoch: 1,
    socket: {},
    transcriptTransport: mode === 'released_server_v0_2_1'
      ? { mode: 'released_server_v0_2_1' as const }
      : { mode: 'session_transcript_observation_v1' as const },
  } as const;
}

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
let tempHomeDir: string | null = null;
const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
const originalSocketAckTimeoutMs = process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS;
const originalOutboxBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
const originalOutboxMaxRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS;
const originalOutboxJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
const originalOutboxMaxAttempts = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
const originalOutboxTranscriptFlushBatchLimit = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_TRANSCRIPT_FLUSH_BATCH_LIMIT;
const originalOutboxDeliveryConcurrency = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY;
const originalOutboxDeadLetterMaxEntries = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DEAD_LETTER_MAX_ENTRIES;
const originalOutboxReferencedPrerequisiteMaxEntries = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_REFERENCED_PREREQUISITE_MAX_ENTRIES;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

vi.mock('axios');

/**
 * Persistence is a real module here: every export delegates to the real one
 * unless a test installs an exact override. That keeps this file on one module
 * instance (the whole `sessionClient` graph) while still letting the
 * save-serialization case observe and block individual persistence calls.
 */
const persistenceOverrides = vi.hoisted(() => new Map<string, unknown>());

vi.mock('./client/transport/mutations/sessionClientDurableMutationPersistence', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('./client/transport/mutations/sessionClientDurableMutationPersistence')
  >();
  return Object.fromEntries(Object.entries(actual).map(([name, value]) => [
    name,
    typeof value === 'function'
      ? (...args: unknown[]) => {
          const override = persistenceOverrides.get(name) ?? value;
          return (override as (...callArgs: unknown[]) => unknown)(...args);
        }
      : value,
  ]));
});

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub as unknown as UserScopedSocket;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    const transportResult: SessionSocketTransportResult = {
      socket: sessionSocketStub as unknown as SessionSocketTransportResult['socket'],
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => sessionSocketStub?.connected === true,
        onConnected: () => () => {},
        onDisconnected: () => () => {},
        onError: () => () => {},
      },
    };
    return transportResult;
  },
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      params.createTransport();
      if (sessionSocketStub?.connected === true) {
        await params.onConnected?.();
      }
    },
    getState: () => ({ phase: 'online' }),
    stop: async () => {},
  }),
}));

async function useTempHappyHome(): Promise<void> {
  tempHomeDir = await mkdtemp(join(tmpdir(), 'happier-cli-session-outbox-'));
  process.env.HAPPIER_HOME_DIR = tempHomeDir;
  // `configuration` is a module singleton built at import time, and the outbox
  // path owner reads `configuration.activeServerDir`
  // (`sessionClientDurableMutationPersistence.ts:150-156`). Without this the
  // suite would keep writing under the real home and the temporary-home reset
  // below would clean nothing, leaking durable state between tests.
  reloadConfiguration();
}

async function resetTempHappyHome(): Promise<void> {
  if (!tempHomeDir) throw new Error('Missing durable mutation outbox test home');
  await rm(tempHomeDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
  await mkdir(tempHomeDir, { recursive: true });
  reloadConfiguration();
}

function restoreDurableMutationOutboxTestEnv(): void {
  restoreEnvValue('HAPPIER_HOME_DIR', originalHappyHomeDir);
  restoreEnvValue('HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS', originalSocketAckTimeoutMs);
  restoreEnvValue('HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS', originalOutboxBaseRetryMs);
  restoreEnvValue('HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS', originalOutboxMaxRetryMs);
  restoreEnvValue('HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS', originalOutboxJitterMs);
  restoreEnvValue('HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS', originalOutboxMaxAttempts);
  restoreEnvValue('HAPPIER_SESSION_MUTATION_OUTBOX_TRANSCRIPT_FLUSH_BATCH_LIMIT', originalOutboxTranscriptFlushBatchLimit);
  restoreEnvValue('HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY', originalOutboxDeliveryConcurrency);
  restoreEnvValue('HAPPIER_SESSION_MUTATION_OUTBOX_DEAD_LETTER_MAX_ENTRIES', originalOutboxDeadLetterMaxEntries);
  restoreEnvValue('HAPPIER_SESSION_MUTATION_OUTBOX_REFERENCED_PREREQUISITE_MAX_ENTRIES', originalOutboxReferencedPrerequisiteMaxEntries);
}

async function resetSharedDurableMutationOutboxes(): Promise<void> {
  await resetSessionClientDurableMutationOutboxStateForTests();
}

// `axios` is auto-mocked for this file, so the spies are the module's own
// exports. The suite instantiates the production module graph once, like its
// `createDaemonSessionClientDurableMutationOutbox` sibling: every outbox knob
// this file drives is read from `process.env` per call, and the temporary home
// directory keeps one stable path, so nothing here needs a fresh module
// registry per test.
async function getAxiosPostMock() {
  return vi.mocked(axios.post);
}

async function getAxiosGetMock() {
  return vi.mocked(axios.get);
}

async function readPersistedOutboxMutationCount(sessionId: string): Promise<number> {
  const filePath = resolveSessionClientDurableMutationOutboxPath(sessionId);
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { mutations?: unknown[] };
    return Array.isArray(parsed.mutations) ? parsed.mutations.length : 0;
  } catch {
    return 0;
  }
}

async function readPersistedOutboxMutations(sessionId: string): Promise<unknown[]> {
  const filePath = resolveSessionClientDurableMutationOutboxPath(sessionId);
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { mutations?: unknown[] };
    return Array.isArray(parsed.mutations) ? parsed.mutations : [];
  } catch {
    return [];
  }
}

async function readPersistedOutboxDeadLetters(sessionId: string): Promise<unknown[]> {
  const filePath = resolveSessionClientDurableMutationDeadLetterPath(sessionId);
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { entries?: unknown[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
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

async function drainAsyncWork(cycles = 5): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

const ASYNC_CONDITION_TIMEOUT_MS = 10_000;

/**
 * Waits on a real-time deadline rather than a fixed number of `setImmediate`
 * cycles: the outbox reaches these states through real filesystem persistence,
 * so a cycle count measures host contention instead of the outbox's progress
 * and turns a contended run into a false failure. `process.hrtime` is the clock
 * because cases here install fake `Date`/`setTimeout`. The budget stays well
 * inside the suite's 30 s test timeout so the failure names the condition.
 */
async function waitForAsyncCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = ASYNC_CONDITION_TIMEOUT_MS,
): Promise<void> {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
  for (;;) {
    if (await predicate()) return;
    if (process.hrtime.bigint() >= deadline) {
      throw new Error(`Timed out waiting for async condition after ${timeoutMs}ms`);
    }
    await drainAsyncWork(1);
  }
}

function createFailTurnMutation(params: Readonly<{
  sessionId?: string;
  mutationId?: string;
  turnId?: string;
}> = {}): Extract<SessionTurnMutationV1, Readonly<{ action: 'fail' }>> {
  return {
    v: 1,
    sessionId: params.sessionId ?? 's1',
    mutationId: params.mutationId ?? 'mutation-fail',
    action: 'fail',
    turnId: params.turnId ?? 'turn-1',
    issue: {
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'provider_turn_failed',
      source: 'unknown',
      occurredAt: 200,
      sanitizedPreview: 'Provider reported turn failure',
    },
    observedAt: 200,
  };
}

function createTranscriptAppendMutation(params: Readonly<{
  sessionId?: string;
  localId?: string;
  text?: string;
  messageRole?: 'user' | 'agent';
  sidechainId?: string | null;
  createdAt?: number;
  updatedAt?: number;
}> = {}) {
  const sessionId = params.sessionId ?? 's1';
  const localId = params.localId ?? 'segment-1';
  const text = params.text ?? 'snapshot';
  const messageRole = params.messageRole ?? 'agent';
  return {
    v: 1,
    sessionId,
    mutationId: `transcript:${sessionId}:${localId}`,
    source: 'transcript_message_append',
    localId,
    sidechainId: params.sidechainId ?? null,
    messageRole,
    content: {
      t: 'plain',
      v: {
        role: messageRole,
        content: {
          id: localId,
          type: 'message',
          data: { type: 'message', message: text },
        },
      },
    },
    createdAt: params.createdAt ?? 100,
    updatedAt: params.updatedAt ?? 100,
    provenance: { kind: 'non_dependent', source: 'external' },
  } as const;
}

async function saveQueuedSessionTurnMutation(mutation: SessionTurnMutationV1): Promise<void> {
  await saveSessionClientDurableMutationOutbox(mutation.sessionId, [{
    kind: 'session_turn_mutation',
    mutationId: mutation.mutationId,
    payload: mutation,
    createdAt: mutation.observedAt,
    attempts: 0,
    nextAttemptAt: 0,
  }]);
}

function createQueuedRegisteredFieldMutation(
  mutation: RegisteredSessionStateFieldMutationV1,
) {
  return {
    kind: 'registered_session_state_field' as const,
    mutationId: mutation.mutationId,
    payload: mutation,
    createdAt: mutation.observedAt,
    attempts: 0,
    nextAttemptAt: 0,
  };
}

function createRuntimeActivityMutation(params: Readonly<{
  sessionId?: string;
  mutationId: string;
  observedAt: number;
  state: 'active' | 'unknown';
}>): RegisteredSessionStateFieldMutationV1 {
  return {
    v: 1,
    sessionId: params.sessionId ?? 's-startup-overlay',
    mutationId: params.mutationId,
    fieldId: 'runtime.activity',
    deliveryClass: 'durable_best_effort',
    op: {
      kind: 'set',
      value: params.state === 'active'
        ? { state: 'active', activeCount: 1 }
        : { state: 'unknown', activeCount: 0 },
    },
    source: 'runtime',
    observedAt: params.observedAt,
  };
}

function createWorkStateMutation(): RegisteredSessionStateFieldMutationV1 {
  return {
    v: 1,
    sessionId: 's-startup-overlay',
    mutationId: 'current-work-state',
    fieldId: 'runtime.workState',
    deliveryClass: 'durable_required',
    op: {
      kind: 'set',
      value: { v: 1, backendId: 'codex-app-server', updatedAt: 200, items: [] },
    },
    source: 'runtime',
    observedAt: 200,
  };
}

describe('ApiSessionClient durable mutation outbox', () => {
  it.each([false, true])('joins streamed final Home receipts before an immediately following turn completion (checkpoint=%s)', async (checkpoint) => {
    const home = createSessionTranscriptHomeStub();
    const firstWrite = createDeferred<void>();
    const acknowledge = createDeferred<void>();
    let first = true;
    let finalAssistantSequence: number | undefined;
    sessionSocketStub = createApiSessionSocketStub({ connected: false,
      emitWithAck: async (event, payload) => {
        const answer = home.answer(event, payload);
        if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
          const receipt = SessionTranscriptObservationAckV1Schema.parse(answer);
          if (receipt.ok && receipt.localId === 'native-final') finalAssistantSequence = receipt.seq;
          if (first) {
            first = false;
            firstWrite.resolve();
            await acknowledge.promise;
          }
        }
        return answer ?? { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 'streamed-final-ack' }));
    // Model an established Home connection without unrelated reconnect recovery.
    sessionSocketStub.connected = true;
    const contract = { ...serverContract('session_sync_v2_pending_input_v1'), socket: sessionSocketStub };
    const internals = client as unknown as {
      sessionSyncPendingInputServerContractResult: typeof contract;
      durableMutationOutbox: { setSessionSyncPendingInputServerContract: (result: typeof contract) => Promise<void> };
    };
    internals.sessionSyncPendingInputServerContractResult = contract;
    await internals.durableMutationOutbox.setSessionSyncPendingInputServerContract(contract);
    const bridge = createKeyedStreamedTranscriptBridge({ provider: 'opencode', createSessionForStream: () => client,
      ...(checkpoint ? { initialCheckpointDelayMs: 0, checkpointMinChars: 1 } : {}),
    });
    const project = createRuntimeTranscriptProjector();
    let serial = Promise.resolve();
    let sequence = 0;
    const emit = (event: Record<string, unknown>) => {
      const result = project({ session: client, provider: 'opencode', runtimeMessageDeltaBridge: bridge,
        priorProjection: serial, event: AgentSessionRuntimeEventSchema.parse({
          sessionId: client.sessionId, emittedAtMs: Date.now(), sequence: ++sequence, ...event,
        }) });
      serial = result.then(() => undefined);
      return result;
    };
    try {
      emit({ kind: 'message-delta', turnId: 'turn-final', channel: 'reasoning', text: 'Working' });
      emit({ kind: 'message-delta', turnId: 'turn-final', channel: 'assistant', messageId: 'native-final', text: 'Exact final answer' });
      let completed = false;
      const terminal = emit({ kind: 'turn-complete', turnId: 'turn-final' }).then(result => { completed = true; return result; });
      await firstWrite.promise;
      await drainAsyncWork();
      expect(completed).toBe(false);
      acknowledge.resolve();
      await expect(terminal).resolves.toMatchObject({
        projected: true, kind: 'turn-complete', finalAssistantMessageSeq: expect.any(Number),
      });
      expect((await terminal).projected && finalAssistantSequence).toBeTypeOf('number');
      expect(await terminal).toMatchObject({ finalAssistantMessageSeq: finalAssistantSequence });
    } finally {
      acknowledge.resolve();
      await serial.catch(() => undefined);
      bridge.clear();
      sessionSocketStub.connected = false;
      await client.close();
    }
  });

  beforeAll(async () => {
    await useTempHappyHome();
  });

  beforeEach(async () => {
    persistenceOverrides.clear();
    await resetTempHappyHome();
    restoreDurableMutationOutboxTestEnv();
    if (!tempHomeDir) throw new Error('Missing durable mutation outbox test home');
    process.env.HAPPIER_HOME_DIR = tempHomeDir;
    reloadConfiguration();
    process.env.HAPPIER_SESSION_SOCKET_ACK_TIMEOUT_MS = '50';

    const axiosPost = await getAxiosPostMock();
    axiosPost.mockReset();
    const axiosGet = await getAxiosGetMock();
    axiosGet.mockReset();
    axiosGet.mockRejectedValue(new Error('session-end proof unavailable'));
    sessionSocketStub = null;
    userSocketStub = null;
  });

  afterEach(async () => {
    try {
      await resetSharedDurableMutationOutboxes();
    } finally {
      sessionSocketStub?.close();
      userSocketStub?.close();
      sessionSocketStub = null;
      userSocketStub = null;
      vi.useRealTimers();
      vi.restoreAllMocks();
      persistenceOverrides.clear();
      restoreDurableMutationOutboxTestEnv();
      await resetTempHappyHome();
    }
  });

  afterAll(async () => {
    restoreDurableMutationOutboxTestEnv();
    if (tempHomeDir) {
      await rm(tempHomeDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
      tempHomeDir = null;
    }
  });

  it('persists and delivers the current construction snapshot instead of a newer-timestamp stale loaded row', async () => {
    const oldActivity = createRuntimeActivityMutation({
      mutationId: 'old-active',
      observedAt: 1_000,
      state: 'active',
    });
    const freshActivity = createRuntimeActivityMutation({
      mutationId: 'fresh-unknown',
      observedAt: 500,
      state: 'unknown',
    });
    const workState = createWorkStateMutation();
    await saveSessionClientDurableMutationOutbox('s-startup-overlay', [
      createQueuedRegisteredFieldMutation(oldActivity),
      createQueuedRegisteredFieldMutation(workState),
    ]);

    const deliveries: Array<Readonly<{
      mutationId: string;
      persistedMutationIds: readonly string[];
    }>> = [];
    const outboxParams = {
      token: 'tok',
      sessionId: 's-startup-overlay',
      initialRegisteredSessionStateFieldMutations: [freshActivity],
      getSocket: () => createApiSessionSocketStub({ connected: true }),
      requestReconnect: () => {},
      deliverRegisteredSessionStateFieldMutation: async (mutation: RegisteredSessionStateFieldMutationV1) => {
        deliveries.push({
          mutationId: mutation.mutationId,
          persistedMutationIds: (await readPersistedOutboxMutations('s-startup-overlay'))
            .flatMap((queued) => (
              queued && typeof queued === 'object' && 'mutationId' in queued
                ? [String(queued.mutationId)]
                : []
            )),
        });
        if (mutation.fieldId === 'runtime.activity') {
          return {
            delivered: true,
            settlement: {
              status: 'applied' as const,
              committedProjection: {
                state: 'unknown' as const,
                activeCount: 0,
                observedAt: 500,
                revision: 1,
              },
              committedRevision: 1,
            },
          };
        }
        return true;
      },
    } satisfies Parameters<typeof createRuntimeSessionClientDurableMutationOutbox>[0];
    const outbox = createRuntimeSessionClientDurableMutationOutbox(outboxParams);
    await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));

    await vi.waitFor(() => expect(deliveries.map((entry) => entry.mutationId)).toEqual([
      'current-work-state',
      'runtime-activity-snapshot:s-startup-overlay',
    ]));

    await outbox.flush('connect');
    await outbox.flush('flush');
    expect(deliveries.map((entry) => entry.mutationId)).toEqual([
      'current-work-state',
      'runtime-activity-snapshot:s-startup-overlay',
    ]);
    expect(deliveries[1]?.persistedMutationIds).toContain('runtime-activity-snapshot:s-startup-overlay');
    expect(deliveries[1]?.persistedMutationIds).not.toContain('old-active');

    await outbox.flush('connect');
    expect(deliveries.map((entry) => entry.mutationId)).toEqual([
      'current-work-state',
      'runtime-activity-snapshot:s-startup-overlay',
    ]);
    await outbox.close();
  });

  it('delivers queued session turn mutations after reconnect', async () => {
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockRejectedValue(new Error('server offline'));
    const deliveredEvents: string[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async (event: string, payload: unknown) => {
        deliveredEvents.push(event);
        if (event === 'session-turn-mutation') {
          return createSessionTurnMutationAppliedSocketAck(payload as SessionTurnMutationV1);
        }
        return { ok: true };
      },
    });

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });
    await outbox.enqueueSessionTurnMutation({
      v: 1,
      sessionId: 's1',
      mutationId: 'mutation-turn-1',
      action: 'complete',
      turnId: 'turn-1',
      observedAt: 123,
    });

    expect(await readPersistedOutboxMutationCount('s1')).toBe(1);

    sessionSocketStub.connected = true;
    await outbox.flush('flush');

    expect(deliveredEvents).toContain('session-turn-mutation');
    await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(0);
    await outbox.close();
  });

  it('never writes durable state again after the outbox is closed', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockRejectedValue(new Error('server offline'));
    sessionSocketStub = createApiSessionSocketStub({ connected: false });

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 'closed-outbox',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });
    await outbox.enqueueSessionTurnMutation({
      v: 1,
      sessionId: 'closed-outbox',
      mutationId: 'mutation-after-close',
      action: 'complete',
      turnId: 'turn-1',
      observedAt: 125,
    });
    expect(await readPersistedOutboxMutationCount('closed-outbox')).toBe(1);

    // Closing the shared instance does not close the handles still holding it,
    // which is how a later flush used to resurrect a Session this process no
    // longer owns — and, in this suite, wrote one test's mutation into the next
    // test's home.
    await resetSharedDurableMutationOutboxes();
    await rm(resolveSessionClientDurableMutationOutboxPath('closed-outbox'), { force: true });
    await outbox.flush('flush');

    expect(await readPersistedOutboxMutationCount('closed-outbox')).toBe(0);
  });

  it('retains ordinary session turn custody after generic socket and HTTP success', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockResolvedValue({ status: 200, data: { success: true } } as never);
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async () => ({ result: 'success' }),
    });

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });
    await outbox.enqueueSessionTurnMutation({
      v: 1,
      sessionId: 's1',
      mutationId: 'mutation-generic-ack',
      action: 'complete',
      turnId: 'turn-1',
      observedAt: 124,
    });

    await expect.poll(() => readPersistedOutboxMutations('s1')).toEqual([
      expect.objectContaining({
        kind: 'session_turn_mutation',
        mutationId: 'mutation-generic-ack',
        attempts: 1,
        lastAttempt: expect.objectContaining({ reason: 'delivery_not_confirmed' }),
      }),
    ]);
    await outbox.close();
  });

  it('keeps transport disposal distinct from semantic session termination', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: false });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 'transport-disposal' }));

    await client.close();

    await expect(readPersistedOutboxMutationCount('transport-disposal')).resolves.toBe(0);
  });

  it('carries a proven ready original through the actual outbox commit wait without holding publication', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: false });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 'ready-commit-wait' }));
    try {
      const publication = await client.enqueueSessionEventCommitted({ type: 'ready', completedTurnId: 'completed-turn' }, 'ready-original');
      expect(publication).toMatchObject({ persisted: true, delivered: false, localId: expect.any(String) });
      expect(publication.whenCommitted).toBeInstanceOf(Promise);
      let settled = false;
      void publication.whenCommitted!.then(() => { settled = true; });
      await drainAsyncWork();
      expect(settled).toBe(false);
      await client.close();
      await expect(publication.whenCommitted).resolves.toBeNull();
      await expect(readPersistedOutboxMutations('ready-commit-wait')).resolves.toContainEqual(expect.objectContaining({
        kind: 'transcript_message_append', payload: expect.objectContaining({ localId: publication.localId }),
      }));
    } finally { await client.close(); }
  });

  it.each(['delivered', 'resumed'] as const)('persists one semantic session end before close and settles it after restart (%s)', async (outcome) => {
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockRejectedValue(new Error('server offline'));
    sessionSocketStub = createApiSessionSocketStub({ connected: false });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 'semantic-session-end' }));

    await Promise.all([
      client.endSessionAndClose(),
      client.endSessionAndClose(),
    ]);

    const persisted = await loadSessionClientDurableMutationOutbox('semantic-session-end');
    expect(persisted).toEqual([
      expect.objectContaining({
        kind: 'session_end',
        mutationId: expect.stringMatching(/^session-end:/),
        payload: expect.objectContaining({
          sessionId: 'semantic-session-end',
          source: 'session_end',
        }),
      }),
    ]);
    const persistedSessionEnd = persisted[0];
    if (persistedSessionEnd?.kind !== 'session_end') {
      throw new Error('Expected a persisted semantic session-end mutation');
    }
    expect(persistedSessionEnd.payload).toEqual(expect.objectContaining({
      mutationId: persistedSessionEnd.mutationId,
    }));

    let resumedPublisherActive = true;
    if (outcome === 'resumed') {
      axiosPost.mockRejectedValue({ response: { status: 404 } });
      const axiosGet = await getAxiosGetMock();
      axiosGet.mockResolvedValue({ status: 200, data: { session: {
        id: 'semantic-session-end', active: true,
        activeAt: persistedSessionEnd.payload.observedAt + 1,
      } } } as never);
      sessionSocketStub = createApiSessionSocketStub({
        connected: true,
        emitWithAck: async (event: string) => {
          if (event === 'session-end') resumedPublisherActive = false;
          return { ok: true, applied: true };
        },
      });
    } else {
      axiosPost.mockResolvedValue({ status: 200, data: { ok: true } } as never);
    }
    const restarted = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 'semantic-session-end',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => undefined,
    });
    await restarted.awaitReady();
    await restarted.flush('startup');

    await expect.poll(() => readPersistedOutboxMutationCount('semantic-session-end')).toBe(0);
    expect(resumedPublisherActive).toBe(true);
    await restarted.close();
  });

  it('persists disconnected transcript commits and flushes them through socket ack on reconnect', async () => {
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockRejectedValue(new Error('server offline'));
    const deliveredMessages: unknown[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event === 'message') {
          deliveredMessages.push(payload);
        }
        return { ok: true, id: 'message-1', seq: 7, localId: 'stream-1' };
      },
    });

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });

    await (outbox as any).enqueueTranscriptMessage(createTranscriptAppendMutation({
      localId: 'stream-1',
      text: 'committed while offline',
    }));

    await expect.poll(() => readPersistedOutboxMutations('s1')).toEqual([
      expect.objectContaining({
        kind: 'transcript_message_append',
        payload: expect.objectContaining({
          localId: 'stream-1',
        }),
      }),
    ]);

    sessionSocketStub.connected = true;
    await outbox.setSessionSyncPendingInputServerContract(
      serverContract('released_server_v0_2_1'),
    );
    await outbox.flush('flush');

    expect(deliveredMessages).toEqual([
      expect.objectContaining({
        sid: 's1',
        localId: 'stream-1',
        sidechainId: null,
        messageRole: 'agent',
        message: expect.objectContaining({ t: 'plain' }),
      }),
    ]);
    await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(0);
    await outbox.close();
  });

  it('coalesces repeated transcript snapshots by session and local id', async () => {
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockRejectedValue(new Error('server offline'));
    sessionSocketStub = createApiSessionSocketStub({ connected: false });

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });

    await (outbox as any).enqueueTranscriptMessage(createTranscriptAppendMutation({
      localId: 'stream-1',
      text: 'older snapshot',
      updatedAt: 100,
    }));
    await (outbox as any).enqueueTranscriptMessage(createTranscriptAppendMutation({
      localId: 'stream-1',
      text: 'newer snapshot',
      updatedAt: 200,
    }));

    const persisted = await readPersistedOutboxMutations('s1');
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted[0])).toContain('newer snapshot');
    expect(JSON.stringify(persisted[0])).not.toContain('older snapshot');
    await outbox.close();
  });

  it('keeps the newest transcript snapshot when an older snapshot is enqueued later', async () => {
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockRejectedValue(new Error('server offline'));
    sessionSocketStub = createApiSessionSocketStub({ connected: false });

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });

    await (outbox as any).enqueueTranscriptMessage(createTranscriptAppendMutation({
      localId: 'stream-1',
      text: 'newer snapshot',
      updatedAt: 300,
    }));
    await (outbox as any).enqueueTranscriptMessage(createTranscriptAppendMutation({
      localId: 'stream-1',
      text: 'older snapshot',
      updatedAt: 200,
    }));

    const persisted = await readPersistedOutboxMutations('s1');
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted[0])).toContain('newer snapshot');
    expect(JSON.stringify(persisted[0])).not.toContain('older snapshot');
    await outbox.close();
  });

  it('keeps the newest transcript snapshot when duplicate persisted records load stale last', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockRejectedValue(new Error('server offline'));
    sessionSocketStub = createApiSessionSocketStub({ connected: false });

    const newer = createTranscriptAppendMutation({
      localId: 'stream-1',
      text: 'newer persisted snapshot',
      updatedAt: 300,
    });
    const older = createTranscriptAppendMutation({
      localId: 'stream-1',
      text: 'older persisted snapshot',
      updatedAt: 200,
    });
    await saveSessionClientDurableMutationOutbox('s1', [newer, older].map((mutation) => ({
      kind: 'transcript_message_append',
      mutationId: mutation.mutationId,
      payload: mutation,
      createdAt: mutation.createdAt,
      attempts: 0,
      nextAttemptAt: 0,
    } as any)));

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });

    await expect.poll(() => readPersistedOutboxMutations('s1')).toEqual([
      expect.objectContaining({
        kind: 'transcript_message_append',
        payload: expect.objectContaining({
          updatedAt: 300,
        }),
      }),
    ]);
    const persisted = await readPersistedOutboxMutations('s1');
    expect(JSON.stringify(persisted[0])).toContain('newer persisted snapshot');
    expect(JSON.stringify(persisted[0])).not.toContain('older persisted snapshot');
    await outbox.close();
  });

  it('rejects transcript coalescing across sidechains', async () => {
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockRejectedValue(new Error('server offline'));
    sessionSocketStub = createApiSessionSocketStub({ connected: false });

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });

    await (outbox as any).enqueueTranscriptMessage(createTranscriptAppendMutation({
      localId: 'stream-1',
      sidechainId: 'tool-a',
    }));

    await expect((outbox as any).enqueueTranscriptMessage(createTranscriptAppendMutation({
      localId: 'stream-1',
      sidechainId: 'tool-b',
    }))).rejects.toThrow(/sidechain/i);

    await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([
      expect.objectContaining({
        kind: 'transcript_message_append',
        payload: expect.objectContaining({ sidechainId: 'tool-a' }),
      }),
    ]);
    await outbox.close();
  });

  it('reports closed transcript enqueues as non-persisted', async () => {
    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => createApiSessionSocketStub({ connected: false }),
      requestReconnect: () => {},
    });

    await outbox.close();
    await expect(outbox.enqueueTranscriptMessage(createTranscriptAppendMutation({
      localId: 'stream-after-close',
      text: 'dropped after close',
    }))).resolves.toEqual({ persisted: false, delivered: false });
  });

  it('dead-letters malformed persisted transcript append records', async () => {
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockResolvedValue({ status: 200, data: { ok: true } } as never);
    sessionSocketStub = createApiSessionSocketStub({ connected: false });

    await saveSessionClientDurableMutationOutbox('s1', [{
      kind: 'transcript_message_append',
      mutationId: 'custom-transcript-id',
      payload: {
        ...createTranscriptAppendMutation({ localId: 'stream-1' }),
        mutationId: 'custom-transcript-id',
      },
      createdAt: 100,
      attempts: 0,
      nextAttemptAt: 0,
    } as any]);

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });

    await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(0);
    await expect.poll(() => readPersistedOutboxDeadLetters('s1')).toEqual([
      expect.objectContaining({
        kind: 'transcript_message_append',
        reason: expect.stringMatching(/transcript/i),
        mutationId: 'custom-transcript-id',
      }),
    ]);
    await outbox.close();
  });

  it('caps durable outbox dead letters while retaining the terminal-failure ledger', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DEAD_LETTER_MAX_ENTRIES = '2';

    await appendSessionClientDurableMutationDeadLetters('s1', [
      {
        v: 1,
        kind: 'session_turn_mutation',
        sessionId: 's1',
        mutationId: 'dead-1',
        reason: 'retry_exhausted',
        deadLetteredAt: 101,
      },
      {
        v: 1,
        kind: 'session_turn_mutation',
        sessionId: 's1',
        mutationId: 'dead-2',
        reason: 'retry_exhausted',
        deadLetteredAt: 102,
      },
      {
        v: 1,
        kind: 'session_turn_mutation',
        sessionId: 's1',
        mutationId: 'dead-3',
        reason: 'retry_exhausted',
        deadLetteredAt: 103,
      },
    ]);

    await expect(readPersistedOutboxDeadLetters('s1')).resolves.toEqual([
      expect.objectContaining({ mutationId: 'dead-2' }),
      expect.objectContaining({ mutationId: 'dead-3' }),
    ]);

    await expect(readPersistedOutboxDeadLetters('s1')).resolves.toHaveLength(2);
  });

  it('keeps dead-letter prerequisites referenced by queued dependents beyond the ordinary cap', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DEAD_LETTER_MAX_ENTRIES = '2';

    await saveSessionClientDurableMutationOutbox('s1', [{
      kind: 'registered_session_state_field',
      mutationId: 'dependent-referencing-retained-prerequisite',
      payload: {
        v: 1,
        sessionId: 's1',
        mutationId: 'dependent-referencing-retained-prerequisite',
        fieldId: 'runtime.workState',
        deliveryClass: 'durable_required',
        op: {
          kind: 'set',
          value: {
            v: 1,
            backendId: 'codex-app-server',
            updatedAt: 200,
            items: [],
          },
        },
        source: 'runtime',
        observedAt: 200,
        dependsOn: [{
          mutationId: 'retained-prerequisite',
          relationship: 'same_turn_prerequisite',
        }],
      },
      dependsOn: [{
        mutationId: 'retained-prerequisite',
        relationship: 'same_turn_prerequisite',
      }],
      createdAt: 200,
      attempts: 0,
      nextAttemptAt: 0,
    }]);
    await appendSessionClientDurableMutationDeadLetters('s1', [
      {
        v: 1,
        kind: 'session_turn_mutation',
        sessionId: 's1',
        mutationId: 'retained-prerequisite',
        reason: 'retry_exhausted',
        deadLetteredAt: 100,
      },
      {
        v: 1,
        kind: 'session_turn_mutation',
        sessionId: 's1',
        mutationId: 'unreferenced-dead-1',
        reason: 'retry_exhausted',
        deadLetteredAt: 101,
      },
      {
        v: 1,
        kind: 'session_turn_mutation',
        sessionId: 's1',
        mutationId: 'unreferenced-dead-2',
        reason: 'retry_exhausted',
        deadLetteredAt: 102,
      },
      {
        v: 1,
        kind: 'session_turn_mutation',
        sessionId: 's1',
        mutationId: 'unreferenced-dead-3',
        reason: 'retry_exhausted',
        deadLetteredAt: 103,
      },
    ]);

    await expect(readPersistedOutboxDeadLetters('s1')).resolves.toEqual([
      expect.objectContaining({ mutationId: 'retained-prerequisite' }),
      expect.objectContaining({ mutationId: 'unreferenced-dead-2' }),
      expect.objectContaining({ mutationId: 'unreferenced-dead-3' }),
    ]);
  });

  it('keeps an old referenced prerequisite outside the dead-letter load window', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DEAD_LETTER_MAX_ENTRIES = '2';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_REFERENCED_PREREQUISITE_MAX_ENTRIES = '2';

    await saveSessionClientDurableMutationOutbox('s1', [{
      kind: 'registered_session_state_field',
      mutationId: 'dependent-referencing-ancient-prerequisite',
      payload: {
        v: 1,
        sessionId: 's1',
        mutationId: 'dependent-referencing-ancient-prerequisite',
        fieldId: 'runtime.workState',
        deliveryClass: 'durable_required',
        op: {
          kind: 'set',
          value: {
            v: 1,
            backendId: 'codex-app-server',
            updatedAt: 200,
            items: [],
          },
        },
        source: 'runtime',
        observedAt: 200,
        dependsOn: [{
          mutationId: 'ancient-prerequisite',
          relationship: 'same_turn_prerequisite',
        }],
      },
      dependsOn: [{
        mutationId: 'ancient-prerequisite',
        relationship: 'same_turn_prerequisite',
      }],
      createdAt: 200,
      attempts: 0,
      nextAttemptAt: 0,
    }]);

    const deadLetterPath = resolveSessionClientDurableMutationDeadLetterPath('s1');
    await mkdir(dirname(deadLetterPath), { recursive: true });
    await writeFile(deadLetterPath, JSON.stringify({
      v: 1,
      entries: [
        {
          v: 1,
          kind: 'session_turn_mutation',
          sessionId: 's1',
          mutationId: 'ancient-prerequisite',
          reason: 'retry_exhausted',
          deadLetteredAt: 100,
        },
        ...Array.from({ length: 5 }, (_, index) => ({
          v: 1,
          kind: 'session_turn_mutation',
          sessionId: 's1',
          mutationId: `unreferenced-window-${index + 1}`,
          reason: 'retry_exhausted',
          deadLetteredAt: 101 + index,
        })),
      ],
    }), 'utf8');

    await appendSessionClientDurableMutationDeadLetters('s1', [{
      v: 1,
      kind: 'session_turn_mutation',
      sessionId: 's1',
      mutationId: 'new-unreferenced-dead-letter',
      reason: 'retry_exhausted',
      deadLetteredAt: 200,
    }]);

    await expect(readPersistedOutboxDeadLetters('s1')).resolves.toEqual([
      expect.objectContaining({ mutationId: 'ancient-prerequisite' }),
      expect.objectContaining({ mutationId: 'unreferenced-window-5' }),
      expect.objectContaining({ mutationId: 'new-unreferenced-dead-letter' }),
    ]);
  });

  it('preserves the sibling dead-letter ledger when saving an empty durable outbox', async () => {
    const mutation = createFailTurnMutation({
      mutationId: 'mutation-to-clear',
    });
    const outboxPath = resolveSessionClientDurableMutationOutboxPath('s1');
    const deadLetterPath = resolveSessionClientDurableMutationDeadLetterPath('s1');

    await saveSessionClientDurableMutationOutbox('s1', [{
      kind: 'session_turn_mutation',
      mutationId: mutation.mutationId,
      payload: mutation,
      createdAt: mutation.observedAt,
      attempts: 0,
      nextAttemptAt: 0,
    }]);
    await appendSessionClientDurableMutationDeadLetters('s1', [{
      v: 1,
      kind: 'session_turn_mutation',
      sessionId: 's1',
      mutationId: 'mutation-dead-letter',
      reason: 'retry_exhausted',
      deadLetteredAt: 123,
    }]);

    await expect(readFile(outboxPath, 'utf8')).resolves.toContain('mutation-to-clear');
    await expect(readFile(deadLetterPath, 'utf8')).resolves.toContain('mutation-dead-letter');

    await saveSessionClientDurableMutationOutbox('s1', []);

    await expect(readFile(outboxPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(deadLetterPath, 'utf8')).resolves.toContain('mutation-dead-letter');
  });

  it('delivers the newest transcript snapshot after a stale in-flight retry fails', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '10';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS = '10';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    const firstAttempt = createDeferred<unknown>();
    const deliveredBodies: unknown[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (_event, body) => {
        deliveredBodies.push(body);
        if (deliveredBodies.length === 1) {
          return await firstAttempt.promise;
        }
        const localId = typeof body === 'object'
          && body !== null
          && 'localId' in body
          && typeof body.localId === 'string'
          ? body.localId
          : null;
        return {
          ok: true,
          status: 'observed',
          id: `message-${deliveredBodies.length}`,
          seq: deliveredBodies.length,
          localId,
          didWrite: true,
          ingestedAt: Date.now(),
        };
      },
    });

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });
    await outbox.setSessionSyncPendingInputServerContract(
      serverContract('session_sync_v2_pending_input_v1'),
    );

    const oldEnqueue = (outbox as any).enqueueTranscriptMessage(createTranscriptAppendMutation({
      localId: 'stream-1',
      text: 'stale snapshot',
      updatedAt: 100,
    }));
    await expect.poll(() => deliveredBodies).toHaveLength(1);

    const newestEnqueue = (outbox as any).enqueueTranscriptMessage(createTranscriptAppendMutation({
      localId: 'stream-1',
      text: 'fresh snapshot',
      updatedAt: 200,
    }));
    firstAttempt.reject(new Error('first attempt failed'));

    await oldEnqueue;
    await newestEnqueue;
    await waitForAsyncCondition(async () => deliveredBodies.length >= 2);

    expect(JSON.stringify(deliveredBodies[1])).toContain('fresh snapshot');
    expect(JSON.stringify(deliveredBodies[1])).not.toContain('stale snapshot');
    await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(0);
    await outbox.close();
  });

  it('caps transcript deliveries during reconnect flushes', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_TRANSCRIPT_FLUSH_BATCH_LIMIT = '1';
    const deliveredLocalIds: string[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (_event: string, payload: any) => {
        deliveredLocalIds.push(String(payload?.localId ?? ''));
        return {
          ok: true,
          status: 'observed',
          id: `message-${deliveredLocalIds.length}`,
          seq: deliveredLocalIds.length,
          localId: String(payload?.localId ?? ''),
          didWrite: true,
          ingestedAt: 400,
        };
      },
    });

    await saveSessionClientDurableMutationOutbox('s1', [
      createTranscriptAppendMutation({ localId: 'stream-1', text: 'one', updatedAt: 100 }),
      createTranscriptAppendMutation({ localId: 'stream-2', text: 'two', updatedAt: 200 }),
      createTranscriptAppendMutation({ localId: 'stream-3', text: 'three', updatedAt: 300 }),
    ].map((mutation) => ({
      kind: 'transcript_message_append',
      mutationId: mutation.mutationId,
      payload: mutation,
      createdAt: mutation.createdAt,
      attempts: 0,
      nextAttemptAt: 0,
    } as any)));

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      flushOnReady: false,
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });
    await outbox.setSessionSyncPendingInputServerContract(
      serverContract('session_sync_v2_pending_input_v1'),
    );

    await expect.poll(() => deliveredLocalIds).toEqual(['stream-1']);
    await expect.poll(() => readPersistedOutboxMutations('s1')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ localId: 'stream-2' }) }),
      expect.objectContaining({ payload: expect.objectContaining({ localId: 'stream-3' }) }),
    ]);
    await outbox.close();
  });

  it('drains in-flight durable session mutations before close returns', async () => {
    const axiosPost = await getAxiosPostMock();
    const httpDelivery = createDeferred<unknown>();
    const httpActions: string[] = [];
    let closeSettled = false;
    axiosPost.mockImplementation(async (_url, body) => {
      const action = (body as { action?: unknown }).action;
      httpActions.push(typeof action === 'string' ? action : 'unknown');
      return await httpDelivery.promise as never;
    });
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });
    await outbox.enqueueSessionTurnMutation({
      v: 1,
      sessionId: 's1',
      mutationId: 'mutation-turn-1',
      action: 'begin',
      turnId: 'turn-1',
      observedAt: 123,
    });

    await expect.poll(() => httpActions).toEqual(['begin']);
    const closePromise = outbox.close().then(() => {
      closeSettled = true;
    });
    await expect.poll(() => closeSettled, { timeout: 50 }).toBe(false);

    httpDelivery.resolve(createSessionTurnMutationAppliedHttpResponse({
      v: 1,
      sessionId: 's1',
      mutationId: 'mutation-turn-1',
      action: 'begin',
      turnId: 'turn-1',
      observedAt: 123,
    }));
    await closePromise;

    await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(0);
  });

  it('serializes durable outbox persistence so older saves cannot overwrite newer queued mutations', async () => {
    const saveCalls: Array<{
      mutations: readonly unknown[];
      deferred: ReturnType<typeof createDeferred<void>>;
    }> = [];
    let persistedSnapshot: readonly unknown[] = [];
    persistenceOverrides.set('resolveSessionClientDurableMutationReferencedPrerequisiteMaxEntries', () => 1_000);
    persistenceOverrides.set('loadSessionClientDurableMutationOutbox', async () => []);
    persistenceOverrides.set('loadSessionClientDurableMutationDeadLetters', async () => []);
    persistenceOverrides.set('recoverAuthoritativeSessionClientDurableMutationDeadLetters', async () => []);
    persistenceOverrides.set('markAuthoritativeSessionClientDurableMutationDeadLettersRecovered', async () => undefined);
    persistenceOverrides.set(
      'saveSessionClientDurableMutationOutbox',
      async (_sessionId: string, mutations: readonly unknown[]) => {
        const deferred = createDeferred<void>();
        saveCalls.push({ mutations, deferred });
        if (saveCalls.length > 2) {
          persistedSnapshot = mutations;
          return;
        }
        await deferred.promise;
        persistedSnapshot = mutations;
      },
    );
    persistenceOverrides.set('appendSessionClientDurableMutationDeadLetters', async () => ({
      cappedDeadLetterCount: 0,
      referencedRetainedEntryCount: 0,
      referencedPrerequisiteOverflowCount: 0,
      prunedEntryCount: 0,
    }));
    persistenceOverrides.set('createSessionClientDurableMutationDeadLetterEntry', (input: unknown) => input);
    const axiosPost = await getAxiosPostMock();
    const blockedDelivery = createDeferred<never>();
    axiosPost.mockImplementation(async () => await blockedDelivery.promise);

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => createApiSessionSocketStub({ connected: false }),
      requestReconnect: () => {},
    });

    try {
      const olderEnqueue = outbox.enqueueSessionTurnMutation({
        v: 1,
        sessionId: 's1',
        mutationId: 'older-turn',
        action: 'begin',
        turnId: 'turn-older',
        observedAt: 1_000,
      });
      await expect.poll(() => saveCalls).toHaveLength(1);
      const newerEnqueue = outbox.enqueueSessionTurnMutation({
        v: 1,
        sessionId: 's1',
        mutationId: 'newer-turn',
        action: 'complete',
        turnId: 'turn-newer',
        observedAt: 2_000,
      });
      await drainAsyncWork();
      expect(saveCalls).toHaveLength(1);

      saveCalls[0]?.deferred.resolve();
      await olderEnqueue;
      await expect.poll(() => saveCalls).toHaveLength(2);
      saveCalls[1]?.deferred.resolve();
      await newerEnqueue;

      expect(JSON.stringify(persistedSnapshot)).toContain('newer-turn');
      expect(JSON.stringify(persistedSnapshot)).toContain('older-turn');
    } finally {
      blockedDelivery.reject(new Error('stop background delivery'));
      await outbox.close().catch(() => {});
      persistenceOverrides.clear();
    }
  });

  it('does not expose the legacy primary turn runtime state writer', { timeout: 60_000 }, async () => {
    expect(ApiSessionClient.prototype).not.toHaveProperty('updatePrimaryTurnRuntimeState');
  });

  it('keeps unsupported old-preview session turn mutations queued without consuming retry budget or emitting update-state', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockRejectedValue({ response: { status: 404 } });
    const deliveredEvents: string[] = [];
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string) => {
        deliveredEvents.push(event);
        if (event === 'session-turn-mutation') return { ok: false, errorCode: 'unsupported' };
        if (event === 'update-state') {
          throw new Error('unsupported session turn mutations must not fall back to update-state');
        }
        return { ok: true };
      },
    });

    const mutation = createFailTurnMutation();
    await saveQueuedSessionTurnMutation(mutation);
    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });

    await expect.poll(() => deliveredEvents).toEqual(['session-turn-mutation']);
    await expect.poll(() => readPersistedOutboxMutations('s1')).toEqual([
      expect.objectContaining({
        kind: 'session_turn_mutation',
        mutationId: 'mutation-fail',
        attempts: 0,
      }),
    ]);
    await expect(readPersistedOutboxDeadLetters('s1')).resolves.toEqual([]);
    const unsupportedDiagnostics = debugSpy.mock.calls.filter(([message]) =>
      message === '[API] Session turn mutation unsupported by server; keeping durable outbox mutation queued'
    );
    expect(unsupportedDiagnostics).toHaveLength(1);
    expect(unsupportedDiagnostics[0]?.[1]).toEqual(expect.objectContaining({
      sessionId: 's1',
      mutationId: 'mutation-fail',
      action: 'fail',
      turnId: 'turn-1',
      serverOrigin: expect.any(String),
      socket: expect.objectContaining({ transport: 'socket', evidence: 'unsupported_ack' }),
      http: expect.objectContaining({ transport: 'http', evidence: 'unsupported_status', status: 404 }),
    }));
    debugSpy.mockRestore();
    await outbox.close();
  });

  it('retains typed 400 session turn rejections without active retry custody, fallback or replay', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockRejectedValue({ response: { status: 400 } });
    const deliveredEvents: string[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string) => {
        deliveredEvents.push(event);
        if (event === 'session-turn-mutation') return { result: 'error' };
        if (event === 'update-state') {
          throw new Error('400 session turn mutation rejection must not fall back to update-state');
        }
        return { ok: true };
      },
    });

    const mutation = createFailTurnMutation();
    await saveQueuedSessionTurnMutation(mutation);
    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });

    await expect.poll(() => deliveredEvents).toEqual(['session-turn-mutation']);
    await expect.poll(() => readPersistedOutboxDeadLetters('s1')).toEqual([
      expect.objectContaining({
        mutationId: mutation.mutationId,
        kind: 'session_turn_mutation',
        reason: 'session_turn_mutation_rejected',
        queuedMutation: expect.objectContaining({
          payload: expect.objectContaining({ action: 'fail' }),
        }),
        attempts: 1,
        firstFailedAt: expect.any(Number),
        lastAttempt: {
          v: 1,
          reason: 'session_turn_mutation_rejected',
          attemptedAt: expect.any(Number),
        },
      }),
    ]);
    await expect.poll(() => readPersistedOutboxMutations('s1')).toEqual([]);
    await outbox.flush('flush');
    await outbox.close();
    const reopened = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });
    try {
      await reopened.awaitReady();
      await reopened.flush('startup');
      expect(deliveredEvents).toEqual(['session-turn-mutation']);
      await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([]);
      await expect(readPersistedOutboxDeadLetters('s1')).resolves.toEqual([
        expect.objectContaining({ mutationId: mutation.mutationId, reason: 'session_turn_mutation_rejected' }),
      ]);
    } finally {
      await reopened.close();
    }
    expect(sessionSocketStub.emitWithAck).not.toHaveBeenCalledWith(
      'update-state',
      expect.anything(),
    );
  });

  it('keeps authoritative session turn mutations queued after retry exhaustion', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockRejectedValue(new Error('server offline'));
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });

    const mutation = createFailTurnMutation();
    await saveQueuedSessionTurnMutation(mutation);
    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });

    await expect.poll(() => axiosPost.mock.calls.length).toBe(1);
    await expect.poll(() => readPersistedOutboxMutations('s1')).toEqual([
      expect.objectContaining({
        kind: 'session_turn_mutation',
        mutationId: 'mutation-fail',
        attempts: 1,
        firstFailedAt: expect.any(Number),
        lastAttempt: {
          v: 1,
          reason: 'delivery_not_confirmed',
          attemptedAt: expect.any(Number),
        },
      }),
    ]);
    await expect(readPersistedOutboxDeadLetters('s1')).resolves.toEqual([]);
    await outbox.close();
  });

  it('redrives authoritative mutations on reconnect even when their retry backoff is in the future', async () => {
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockRejectedValue(new Error('server offline'));
    const deliveredMutationIds: string[] = [];
    const socket = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async (event, payload) => {
        if (event === 'session-turn-mutation') {
          deliveredMutationIds.push((payload as { mutationId: string }).mutationId);
        }
        return event === 'session-turn-mutation'
          ? createSessionTurnMutationAppliedSocketAck(payload as SessionTurnMutationV1)
          : { ok: true };
      },
    });
    const mutation = createFailTurnMutation({ mutationId: 'redrive-after-connect' });
    await saveSessionClientDurableMutationOutbox('s1', [{
      kind: 'session_turn_mutation',
      mutationId: mutation.mutationId,
      payload: mutation,
      createdAt: mutation.observedAt,
      attempts: 3,
      nextAttemptAt: Date.now() + 60_000,
    }]);

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => socket,
      requestReconnect: () => {},
    });
    await drainAsyncWork();
    expect(deliveredMutationIds).toEqual([]);

    socket.connected = true;
    await outbox.flush('connect');

    expect(deliveredMutationIds).toEqual(['redrive-after-connect']);
    await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(0);
    await outbox.close();
  });

  it('recovers runtime-admitted authoritative dead letters once and leaves broad terminal and lossy rows untouched', async () => {
    const deliveredActions: string[] = [];
    const socket = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event === 'session-turn-mutation') {
          deliveredActions.push((payload as { action: string }).action);
        }
        return event === 'session-turn-mutation'
          ? createSessionTurnMutationAppliedSocketAck(payload as SessionTurnMutationV1)
          : { ok: true };
      },
    });
    const deadLetterPath = resolveSessionClientDurableMutationDeadLetterPath('s1');
    const recoveredMutation = createFailTurnMutation({ mutationId: 'recover-queued-mutation' });
    await mkdir(dirname(deadLetterPath), { recursive: true });
    await writeFile(deadLetterPath, JSON.stringify({
      v: 1,
      entries: [
        {
          v: 1,
          kind: 'session_turn_mutation',
          sessionId: 's1',
          mutationId: recoveredMutation.mutationId,
          reason: 'retry_exhausted',
          attempts: 4,
          createdAt: recoveredMutation.observedAt,
          deadLetteredAt: 300,
          queuedMutation: {
            kind: 'session_turn_mutation',
            mutationId: recoveredMutation.mutationId,
            payload: recoveredMutation,
            createdAt: recoveredMutation.observedAt,
            attempts: 4,
            nextAttemptAt: 60_000,
          },
        },
        {
          v: 1,
          kind: 'session_turn_mutation',
          sessionId: 's1',
          mutationId: 'recover-legacy-complete',
          reason: 'retry_exhausted',
          attempts: 4,
          createdAt: 250,
          deadLetteredAt: 300,
          payloadSummary: {
            sessionId: 's1',
            mutationId: 'recover-legacy-complete',
            action: 'complete',
          },
        },
        {
          v: 1,
          kind: 'transcript_message_append',
          sessionId: 's1',
          mutationId: 'transcript:s1:lossy',
          reason: 'retry_exhausted',
          deadLetteredAt: 300,
        },
      ],
    }), 'utf8');

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => socket,
      requestReconnect: () => {},
    });

    await expect.poll(() => deliveredActions).toEqual(['fail']);
    const deadLetters = await readPersistedOutboxDeadLetters('s1') as Array<Record<string, unknown>>;
    expect(deadLetters[0]).toEqual(expect.objectContaining({ recoveryAttemptedAt: expect.any(Number) }));
    expect(deadLetters[1]).not.toHaveProperty('recoveryAttemptedAt');
    expect(deadLetters[2]).not.toHaveProperty('recoveryAttemptedAt');
    await outbox.flush('startup');
    expect(deliveredActions).toEqual(['fail']);
    await outbox.close();
  });

  it('shares one ref-counted outbox owner across same-session handles', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockRejectedValue(new Error('server offline'));
    const deliveredMutationIds: string[] = [];
    const firstSocket = createApiSessionSocketStub({ connected: false });
    const secondSocket = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async (event, payload) => {
        if (event === 'session-turn-mutation') {
          deliveredMutationIds.push((payload as { mutationId: string }).mutationId);
        }
        return event === 'session-turn-mutation'
          ? createSessionTurnMutationAppliedSocketAck(payload as SessionTurnMutationV1)
          : { ok: true };
      },
    });
    const first = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => firstSocket,
      requestReconnect: () => {},
    });
    const second = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => secondSocket,
      requestReconnect: () => {},
    });

    await Promise.all([
      first.enqueueSessionTurnMutation(createFailTurnMutation({ mutationId: 'same-session-first' })),
      second.enqueueSessionTurnMutation(createFailTurnMutation({ mutationId: 'same-session-second' })),
    ]);
    await expect.poll(async () => (
      (await readPersistedOutboxMutations('s1')) as Array<{ mutationId?: string }>
    ).map((entry) => entry.mutationId).sort()).toEqual([
      'same-session-first',
      'same-session-second',
    ]);

    await first.close();
    secondSocket.connected = true;
    await second.flush('connect');
    expect(deliveredMutationIds.sort()).toEqual(['same-session-first', 'same-session-second']);
    await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(0);
    await second.close();
  });

  it('redacts durable outbox delivery errors before logging', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockRejectedValue(Object.assign(
      new Error(
        'delivery failed for https://alice:SUPER_SECRET_PASSWORD@api.example.test/v1/sessions/s1/turns/mutations?token=secret Authorization: Bearer OUTBOX_SECRET',
      ),
      { response: { status: 401 } },
    ));
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });

    try {
      const mutation = createFailTurnMutation();
      await saveQueuedSessionTurnMutation(mutation);
      const outbox = createRuntimeSessionClientDurableMutationOutbox({
        token: 'tok',
        sessionId: 's1',
        getSocket: () => sessionSocketStub,
        requestReconnect: () => {},
      });

      await expect.poll(() => axiosPost.mock.calls.length).toBe(1);
      const [, logged] = debugSpy.mock.calls.find(([message]) =>
        message === '[API] Durable session mutation delivery failed'
      ) ?? [];
      expect(logged).toEqual(expect.objectContaining({
        error: expect.objectContaining({
          name: 'Error',
          message: expect.stringContaining('delivery failed for https://api.example.test/v1/sessions/s1/turns/mutations'),
        }),
      }));
      expect(JSON.stringify(logged)).not.toContain('SUPER_SECRET_PASSWORD');
      expect(JSON.stringify(logged)).not.toContain('token=secret');
      expect(JSON.stringify(logged)).not.toContain('OUTBOX_SECRET');
      expect(JSON.stringify(logged)).not.toContain('alice');
      await outbox.close();
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('ignores persisted legacy primary turn projection outbox records', async () => {
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockRejectedValue(new Error('canonical delivery should not run'));
    const deliveredEvents: string[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event: string) => {
        deliveredEvents.push(event);
        return { ok: true };
      },
    });

    const filePath = resolveSessionClientDurableMutationOutboxPath('s1');
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({
      v: 1,
      mutations: [{
        kind: 'primary_turn_projection',
        mutationId: 'legacy-projection-1',
        payload: {
          v: 1,
          sessionId: 's1',
          mutationId: 'legacy-projection-1',
          status: 'failed',
          observedAt: 200,
        },
        createdAt: 200,
        attempts: 0,
        nextAttemptAt: 0,
      }],
    }), 'utf8');

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });
    await outbox.flush('flush');

    expect(deliveredEvents).toEqual([]);
    await outbox.close();
    await expect(readPersistedOutboxMutationCount('s1')).resolves.toBe(0);
  });

  it('keeps later turn mutations queued behind a failed begin mutation until backoff expires', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(0);
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '100';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS = '200';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';

    const firstHttpAttempt = createDeferred<never>();
    const httpActions: string[] = [];
    let isFirstHttpAttempt = true;
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockImplementation(async (_url, body) => {
      const action = (body as { action?: unknown }).action;
      httpActions.push(typeof action === 'string' ? action : 'unknown');
      if (isFirstHttpAttempt) {
        isFirstHttpAttempt = false;
        return await firstHttpAttempt.promise;
      }
      return createSessionTurnMutationAppliedHttpResponse(body as SessionTurnMutationV1) as never;
    });
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });
    const reconnectReasons: string[] = [];

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: (reason) => {
        reconnectReasons.push(reason);
      },
    });

    await outbox.enqueueSessionTurnMutation({
      v: 1,
      sessionId: 's1',
      mutationId: 'mutation-begin',
      action: 'begin',
      turnId: 'turn-1',
      agentId: 'codex',
      agentTurnId: 'turn-1',
      observedAt: 100,
    });
    // Wait for the first delivery attempt on a deadline, then assert it was the
    // only one: a fixed drain count races the outbox's real persistence I/O.
    await waitForAsyncCondition(async () => httpActions.length > 0);
    expect(httpActions).toEqual(['begin']);

    await outbox.enqueueSessionTurnMutation({
      v: 1,
      sessionId: 's1',
      mutationId: 'mutation-complete',
      action: 'complete',
      turnId: 'turn-1',
      agentId: 'codex',
      agentTurnId: 'turn-1',
      observedAt: 200,
    });
    await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([
      expect.objectContaining({
        kind: 'session_turn_mutation',
        payload: expect.objectContaining({ action: 'begin' }),
      }),
      expect.objectContaining({
        kind: 'session_turn_mutation',
        payload: expect.objectContaining({ action: 'complete' }),
      }),
    ]);

    firstHttpAttempt.reject(new Error('server offline'));

    await waitForAsyncCondition(async () => {
      const [head] = await readPersistedOutboxMutations('s1');
      const attempts = typeof head === 'object' && head !== null && 'attempts' in head
        ? head.attempts
        : undefined;
      return httpActions.length > 1 || attempts === 1;
    });
    expect(httpActions).toEqual(['begin']);
    await expect(readPersistedOutboxMutations('s1')).resolves.toEqual([
      expect.objectContaining({
        attempts: 1,
        nextAttemptAt: 200,
        firstFailedAt: 0,
        lastAttempt: {
          v: 1,
          reason: 'delivery_not_confirmed',
          attemptedAt: 0,
        },
        kind: 'session_turn_mutation',
        payload: expect.objectContaining({ action: 'begin' }),
      }),
      expect.objectContaining({
        attempts: 0,
        kind: 'session_turn_mutation',
        payload: expect.objectContaining({ action: 'complete' }),
      }),
    ]);

    await vi.advanceTimersToNextTimerAsync();
    expect(Date.now()).toBe(200);
    expect(reconnectReasons).not.toContain('timer');
    // The automatic timer delivery crosses real filesystem persistence. Wait
    // for that boundary without forcing a flush or advancing the fake clock.
    await waitForAsyncCondition(async () => httpActions.length >= 3);
    expect(httpActions).toEqual(['begin', 'begin', 'complete']);
    await outbox.flush('flush');
    await expect(readPersistedOutboxMutationCount('s1')).resolves.toBe(0);
    await outbox.close();
  });

  it('keeps disconnected session turn mutations queued without consuming retry budget when HTTP fallback reports an unsupported route', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockRejectedValue({ response: { status: 404 } });
    const deliveredEvents: string[] = [];
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async (event: string) => {
        deliveredEvents.push(event);
        throw new Error('socket emit should not be reached while disconnected');
      },
    });

    const mutation = createFailTurnMutation();
    await saveQueuedSessionTurnMutation(mutation);
    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });

    await expect.poll(() => deliveredEvents).toEqual([]);
    await expect.poll(() => readPersistedOutboxMutations('s1')).toEqual([
      expect.objectContaining({
        kind: 'session_turn_mutation',
        payload: expect.objectContaining({ action: 'fail' }),
        attempts: 0,
      }),
    ]);
    expect(debugSpy.mock.calls.some(([message]) =>
      message === '[API] Session turn mutation unsupported by server; dropping durable outbox mutation'
    )).toBe(false);
    debugSpy.mockRestore();
    await outbox.close();
  });

  it('drops old-server touch_active incompatibility and continues later turn mutations in the same batch', async () => {
    const axiosPost = await getAxiosPostMock();
    const httpActions: string[] = [];
    axiosPost.mockImplementation(async (_url, body) => {
      const action = (body as { action?: unknown }).action;
      httpActions.push(typeof action === 'string' ? action : 'unknown');
      if (action === 'touch_active') {
        throw { response: { status: 400 } };
      }
      return createSessionTurnMutationAppliedHttpResponse(body as SessionTurnMutationV1) as never;
    });
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });
    const touchActive: SessionTurnMutationV1 = {
      v: 1,
      sessionId: 's1',
      mutationId: 'mutation-touch-active',
      action: 'touch_active',
      turnId: 'turn-1',
      agentId: 'codex',
      agentTurnId: 'turn-1',
      observedAt: 100,
    };
    const complete: SessionTurnMutationV1 = {
      v: 1,
      sessionId: 's1',
      mutationId: 'mutation-complete',
      action: 'complete',
      turnId: 'turn-1',
      agentId: 'codex',
      agentTurnId: 'turn-1',
      observedAt: 200,
    };
    await saveSessionClientDurableMutationOutbox('s1', [touchActive, complete].map((mutation) => ({
      kind: 'session_turn_mutation',
      mutationId: mutation.mutationId,
      payload: mutation,
      createdAt: mutation.observedAt,
      attempts: 0,
      nextAttemptAt: 0,
    })));

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });

    await waitForAsyncCondition(async () => httpActions.includes('complete'));
    expect(httpActions).toEqual(['touch_active', 'complete']);
    await expect(readPersistedOutboxMutationCount('s1')).resolves.toBe(0);
    await outbox.close();
  });

  it('routes durable runtime activity field mutations through the public projection socket event', async () => {
    const deliveredEvents: Array<{ event: string; payload: unknown }> = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async (event: string, payload: unknown) => {
        deliveredEvents.push({ event, payload });
        if (event === 'session-runtime-activity-snapshot') {
          const request = payload as {
            sessionId: string;
            mutationId: string;
            snapshot: {
              state: 'active' | 'idle' | 'unknown';
              activeCount: number;
            };
          };
          return {
            status: 'applied',
            sessionId: request.sessionId,
            mutationId: request.mutationId,
            projection: {
              state: request.snapshot.state,
              activeCount: request.snapshot.activeCount,
              observedAt: 1_000,
              revision: 2,
            },
          };
        }
        if (event === 'update-metadata') {
          throw new Error('runtime.activity must not be delivered through metadata');
        }
        if (event === 'session-runtime-activity-close') {
          return {
            status: 'closed',
            sessionId: 's-runtime-activity',
          };
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's-runtime-activity' }));
    await drainAsyncWork();
    sessionSocketStub.connected = true;
    const currentServerContract = {
      ...serverContract('session_sync_v3_publisher_authority_check_v1'),
      socket: sessionSocketStub,
    };
    const clientInternals = client as unknown as {
      sessionSyncPendingInputServerContractResult: typeof currentServerContract;
      durableMutationOutbox: {
        setSessionSyncPendingInputServerContract: (result: typeof currentServerContract) => Promise<void>;
      };
    };
    clientInternals.sessionSyncPendingInputServerContractResult = currentServerContract;
    await clientInternals.durableMutationOutbox.setSessionSyncPendingInputServerContract(currentServerContract);

    await client.enqueueRegisteredSessionStateFieldMutation({
      v: 1,
      sessionId: 's-runtime-activity',
      mutationId: 'runtime-activity-set',
      fieldId: 'runtime.activity',
      deliveryClass: 'durable_best_effort',
      op: {
        kind: 'set',
        value: {
          state: 'active',
          activeCount: 1,
        },
      },
      source: 'runtime',
      observedAt: 1_000,
    });

    await expect.poll(() => client.readRuntimeActivitySnapshotTail()).toMatchObject({
      sequence: 2,
      custody: null,
      settlement: {
        identity: {
          mutationKey: 'runtime-activity-snapshot:s-runtime-activity',
          admissionOrder: 1,
        },
        desiredValue: { state: 'active', activeCount: 1 },
        result: 'applied',
        committedProjection: {
          state: 'active',
          activeCount: 1,
          observedAt: 1_000,
          revision: 2,
        },
        committedRevision: 2,
      },
    });
    expect(deliveredEvents).toContainEqual({
      event: 'session-runtime-activity-snapshot',
      payload: {
        sessionId: 's-runtime-activity',
        mutationId: 'runtime-activity-snapshot:s-runtime-activity',
        snapshot: { state: 'active', activeCount: 1 },
      },
    });
    expect(deliveredEvents.map((entry) => entry.event)).not.toContain('update-metadata');

    await client.close();
    sessionSocketStub?.close();
    userSocketStub?.close();
  });

  it('runs terminal turn pending drain even when the durable flush rejects', async () => {
    const flushFailure = new Error('durable flush failed');

    sessionSocketStub = createApiSessionSocketStub({ connected: false });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    try {
      const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
      const durableMutationOutbox: {
        enqueueSessionTurnMutation: (mutation: SessionTurnMutationV1) => Promise<void>;
        enqueueRegisteredSessionStateFieldMutation: () => Promise<void>;
        flush: () => Promise<void>;
        close: () => Promise<void>;
      } = {
        enqueueSessionTurnMutation: async () => undefined,
        enqueueRegisteredSessionStateFieldMutation: async () => undefined,
        flush: async () => {
          throw flushFailure;
        },
        close: async () => undefined,
      };
      (client as unknown as { durableMutationOutbox: typeof durableMutationOutbox }).durableMutationOutbox = durableMutationOutbox;
      const catchUpSessionMessages = vi.fn(async () => undefined);
      (client as unknown as { catchUpSessionMessages: typeof catchUpSessionMessages }).catchUpSessionMessages = catchUpSessionMessages;
      const reconcilePendingQueueState = vi.fn(async () => false);
      (client as unknown as { reconcilePendingQueueState: typeof reconcilePendingQueueState }).reconcilePendingQueueState = reconcilePendingQueueState;

      let metadataUpdateCount = 0;
      client.on('metadata-updated', () => {
        metadataUpdateCount += 1;
      });

      const terminalTurnUpdate = client.enqueueSessionTurnMutation({
        v: 1,
        sessionId: 's1',
        mutationId: 'mutation-cancel',
        action: 'cancel',
        turnId: 'turn-1',
        agentId: 'codex',
        agentTurnId: 'turn-1',
        observedAt: 100,
      });

      await expect(terminalTurnUpdate).rejects.toThrow('durable flush failed');
      await drainAsyncWork();

      expect(metadataUpdateCount).toBeGreaterThan(0);
      expect(reconcilePendingQueueState).toHaveBeenCalledWith({ force: false });
      expect(catchUpSessionMessages).not.toHaveBeenCalled();

      sessionSocketStub?.close();
      userSocketStub?.close();
    } finally {
      sessionSocketStub?.close();
      userSocketStub?.close();
    }
  });

  it('retains an undelivered semantic session end despite a later local turn begin', async () => {
    const axiosPost = await getAxiosPostMock();
    const postCalls: string[] = [];
    axiosPost.mockImplementation(async (url) => {
      const requestUrl = String(url);
      postCalls.push(requestUrl);
      if (requestUrl.includes('/end')) {
        throw new Error('session-end delivery unavailable');
      }
      return { status: 200, data: { ok: true } } as never;
    });
    const socket = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });

    const staleEnd = {
      v: 1 as const,
      sessionId: 's1',
      mutationId: 'pending-session-end',
      source: 'session_end' as const,
      observedAt: 1_000,
    };
    const newerBegin: SessionTurnMutationV1 = {
      v: 1,
      sessionId: 's1',
      mutationId: 'begin-new',
      action: 'begin',
      turnId: 'session-turn:new',
      agentId: 'codex',
      observedAt: 2_000,
    };
    await saveSessionClientDurableMutationOutbox('s1', [
      {
        kind: 'session_end',
        mutationId: staleEnd.mutationId,
        payload: staleEnd,
        createdAt: 1_000,
        attempts: 3,
        nextAttemptAt: 0,
      },
      {
        kind: 'session_turn_mutation',
        mutationId: newerBegin.mutationId,
        payload: newerBegin,
        createdAt: 2_000,
        attempts: 0,
        nextAttemptAt: 0,
      },
    ]);

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => socket,
      requestReconnect: () => {},
    });

    await expect.poll(() => postCalls.some((url) => url.includes('/end'))).toBe(true);
    await outbox.enqueueSessionEnd({
      v: 1,
      sessionId: 's1',
      mutationId: 'later-session-end',
      source: 'session_end',
      observedAt: 3_000,
    });
    await expect.poll(async () => (
      await readPersistedOutboxMutations('s1')
    ).map((mutation) => (
      typeof mutation === 'object'
      && mutation !== null
      && 'mutationId' in mutation
      && typeof mutation.mutationId === 'string'
        ? mutation.mutationId
        : null
    ))).toEqual([
      'pending-session-end',
      'begin-new',
      'later-session-end',
    ]);
    await expect(readPersistedOutboxDeadLetters('s1')).resolves.toEqual([]);
    await outbox.close();
  });

  it('limits durable deliveries globally across reattached session outboxes', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY = '1';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    const releases: Array<() => void> = [];
    const startedUrls: string[] = [];
    let activeDeliveries = 0;
    let maxActiveDeliveries = 0;
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        startedUrls.push(event);
        activeDeliveries += 1;
        maxActiveDeliveries = Math.max(maxActiveDeliveries, activeDeliveries);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        activeDeliveries -= 1;
        const localId = typeof payload === 'object'
          && payload !== null
          && 'localId' in payload
          && typeof payload.localId === 'string'
          ? payload.localId
          : null;
        return {
          ok: true,
          status: 'observed',
          id: `message-${startedUrls.length}`,
          seq: startedUrls.length,
          localId,
          didWrite: true,
          ingestedAt: Date.now(),
        };
      },
    });

    for (const sessionId of ['s1', 's2']) {
      const mutation = createTranscriptAppendMutation({ sessionId, localId: 'stream-1' });
      await saveSessionClientDurableMutationOutbox(sessionId, [{
        kind: 'transcript_message_append',
        mutationId: mutation.mutationId,
        payload: mutation,
        createdAt: mutation.createdAt,
        attempts: 0,
        nextAttemptAt: 0,
      }]);
    }

    const outbox1 = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      flushOnReady: false,
      initiallyActive: false,
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });
    const outbox2 = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's2',
      flushOnReady: false,
      initiallyActive: false,
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });
    await Promise.all([
      outbox1.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1')),
      outbox2.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1')),
    ]);
    const flushes = [outbox1.activateDelivery(), outbox2.activateDelivery()];

    try {
      await waitForAsyncCondition(async () => startedUrls.length >= 1);
      expect(startedUrls).toHaveLength(1);
      expect(maxActiveDeliveries).toBe(1);

      releases.shift()?.();
      await waitForAsyncCondition(async () => startedUrls.length >= 2);
      expect(maxActiveDeliveries).toBe(1);

      releases.shift()?.();
      await Promise.all(flushes);
      await expect.poll(() => readPersistedOutboxMutationCount('s1')).toBe(0);
      await expect.poll(() => readPersistedOutboxMutationCount('s2')).toBe(0);
    } finally {
      while (releases.length > 0) releases.shift()?.();
      await Promise.allSettled(flushes);
      await outbox1.close();
      await outbox2.close();
    }
  });

  it('loads persisted registered session-state field mutations as durable outbox entries', async () => {
    const filePath = resolveSessionClientDurableMutationOutboxPath('s1');
    const fieldMutation = {
      kind: 'registered_session_state_field',
      mutationId: 'field-work-state-1',
      payload: {
        v: 1,
        sessionId: 's1',
        mutationId: 'field-work-state-1',
        fieldId: 'runtime.workState',
        deliveryClass: 'durable_required',
        op: {
          kind: 'set',
          value: {
            v: 1,
            backendId: 'codex-app-server',
            updatedAt: 100,
            items: [],
          },
        },
        source: 'runtime',
        observedAt: 100,
      },
      createdAt: 100,
      attempts: 0,
      nextAttemptAt: 0,
    };
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({ v: 1, mutations: [fieldMutation] }), 'utf8');

    await expect(loadSessionClientDurableMutationOutbox('s1')).resolves.toEqual([
      expect.objectContaining({
        kind: 'registered_session_state_field',
        mutationId: 'field-work-state-1',
        payload: expect.objectContaining({
          fieldId: 'runtime.workState',
          source: 'runtime',
        }),
      }),
    ]);
  });

  it('dead-letters lossy dependent mutations when their prerequisite exhausts retry attempts', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    const attemptedMutationIds: string[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });

    await saveSessionClientDurableMutationOutbox('s1', [
      {
        kind: 'registered_session_state_field',
        mutationId: 'mutation-begin',
        payload: {
          v: 1,
          sessionId: 's1',
          mutationId: 'mutation-begin',
          fieldId: 'display.title',
          deliveryClass: 'durable_best_effort',
          op: { kind: 'set', value: 'Retry-exhaustible prerequisite' },
          source: 'runtime',
          observedAt: 100,
        },
        createdAt: 100,
        attempts: 0,
        nextAttemptAt: 0,
      },
      {
        kind: 'registered_session_state_field',
        mutationId: 'mutation-complete',
        payload: {
          v: 1,
          sessionId: 's1',
          mutationId: 'mutation-complete',
          fieldId: 'runtime.activity',
          deliveryClass: 'durable_best_effort',
          op: {
            kind: 'set',
            value: {
              state: 'active',
              activeCount: 1,
            },
          },
          source: 'runtime',
          observedAt: 200,
          dependsOn: [{ mutationId: 'mutation-begin', relationship: 'same_turn_prerequisite' }],
        },
        dependsOn: [{
          mutationId: 'mutation-begin',
          relationship: 'same_turn_prerequisite',
        }],
        createdAt: 200,
        attempts: 0,
        nextAttemptAt: 0,
      },
    ]);

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
      deliverRegisteredSessionStateFieldMutation: async (mutation) => {
        attemptedMutationIds.push(mutation.mutationId);
        return false;
      },
    });
    await outbox.setSessionSyncPendingInputServerContract(serverContract('session_sync_v2_pending_input_v1'));

    await waitForAsyncCondition(async () => (await readPersistedOutboxDeadLetters('s1')).length >= 2);
    expect(attemptedMutationIds).toEqual(['mutation-begin']);
    await expect(readPersistedOutboxDeadLetters('s1')).resolves.toEqual([
      expect.objectContaining({
        kind: 'registered_session_state_field',
        mutationId: 'mutation-begin',
        reason: 'retry_exhausted',
      }),
      expect.objectContaining({
        kind: 'registered_session_state_field',
        mutationId: 'runtime-activity-snapshot:s1',
        reason: 'failed_prerequisite',
        diagnostic: expect.objectContaining({
          prerequisiteMutationId: 'mutation-begin',
        }),
      }),
    ]);
    await expect(readPersistedOutboxMutationCount('s1')).resolves.toBe(0);
    await outbox.close();
  });

  it('dead-letters lossy dependents whose prerequisite failed in an earlier flush', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });

    await saveSessionClientDurableMutationOutbox('s1', [{
      kind: 'registered_session_state_field',
      mutationId: 'mutation-prerequisite',
      payload: {
        v: 1,
        sessionId: 's1',
        mutationId: 'mutation-prerequisite',
        fieldId: 'display.title',
        deliveryClass: 'durable_best_effort',
        op: { kind: 'set', value: 'Retry-exhaustible prerequisite' },
        source: 'runtime',
        observedAt: 100,
      },
      createdAt: 100,
      attempts: 0,
      nextAttemptAt: 0,
    }]);

    const firstOutbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
      deliverRegisteredSessionStateFieldMutation: async () => false,
    });
    await waitForAsyncCondition(async () => (
      (await readPersistedOutboxDeadLetters('s1'))
        .some((entry) => (
          Boolean(entry)
          && typeof entry === 'object'
          && (entry as Record<string, unknown>).mutationId === 'mutation-prerequisite'
          && (entry as Record<string, unknown>).reason === 'retry_exhausted'
        ))
    ));
    await firstOutbox.close();

    await saveSessionClientDurableMutationOutbox('s1', [{
      kind: 'registered_session_state_field',
      mutationId: 'field-after-dead-prerequisite',
      payload: {
        v: 1,
        sessionId: 's1',
        mutationId: 'field-after-dead-prerequisite',
        fieldId: 'runtime.workState',
        deliveryClass: 'durable_required',
        op: {
          kind: 'set',
          value: {
            v: 1,
            backendId: 'codex-app-server',
            updatedAt: 200,
            items: [],
          },
        },
        source: 'runtime',
        observedAt: 200,
        dependsOn: [{
          mutationId: 'mutation-prerequisite',
          relationship: 'same_turn_prerequisite',
        }],
      },
      dependsOn: [{
        mutationId: 'mutation-prerequisite',
        relationship: 'same_turn_prerequisite',
      }],
      createdAt: 200,
      attempts: 0,
      nextAttemptAt: 0,
    }]);

    const deliveredFields: string[] = [];
    const secondOutbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
      deliverRegisteredSessionStateFieldMutation: async (mutation) => {
        deliveredFields.push(mutation.mutationId);
        return true;
      },
    });

    await expect.poll(async () => {
      const [deadLetters, queuedMutationCount] = await Promise.all([
        readPersistedOutboxDeadLetters('s1'),
        readPersistedOutboxMutationCount('s1'),
      ]);
      return {
        queuedMutationCount,
        hasFailedPrerequisiteDeadLetter: deadLetters.some((entry) => (
          Boolean(entry)
          && typeof entry === 'object'
          && (entry as Record<string, unknown>).mutationId === 'field-after-dead-prerequisite'
          && (entry as Record<string, unknown>).reason === 'failed_prerequisite'
        )),
      };
    }, { timeout: 10_000 }).toEqual({
      queuedMutationCount: 0,
      hasFailedPrerequisiteDeadLetter: true,
    });

    expect(deliveredFields).toEqual([]);
    await expect(readPersistedOutboxMutationCount('s1')).resolves.toBe(0);
    await secondOutbox.close();
  });

  it('does not deliver a restarted dependent after the dead-letter cap evicts its prerequisite marker', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DEAD_LETTER_MAX_ENTRIES = '2';
    await appendSessionClientDurableMutationDeadLetters('s1', [
      {
        v: 1,
        kind: 'session_turn_mutation',
        sessionId: 's1',
        mutationId: 'evicted-prerequisite',
        reason: 'retry_exhausted',
        deadLetteredAt: 100,
      },
      {
        v: 1,
        kind: 'session_turn_mutation',
        sessionId: 's1',
        mutationId: 'unrelated-dead-1',
        reason: 'retry_exhausted',
        deadLetteredAt: 101,
      },
      {
        v: 1,
        kind: 'session_turn_mutation',
        sessionId: 's1',
        mutationId: 'unrelated-dead-2',
        reason: 'retry_exhausted',
        deadLetteredAt: 102,
      },
    ]);
    await expect(readPersistedOutboxDeadLetters('s1')).resolves.not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mutationId: 'evicted-prerequisite' }),
      ]),
    );

    await saveSessionClientDurableMutationOutbox('s1', [{
      kind: 'registered_session_state_field',
      mutationId: 'dependent-after-evicted-prerequisite',
      payload: {
        v: 1,
        sessionId: 's1',
        mutationId: 'dependent-after-evicted-prerequisite',
        fieldId: 'runtime.workState',
        deliveryClass: 'durable_required',
        op: {
          kind: 'set',
          value: {
            v: 1,
            backendId: 'codex-app-server',
            updatedAt: 200,
            items: [],
          },
        },
        source: 'runtime',
        observedAt: 200,
        dependsOn: [{
          mutationId: 'evicted-prerequisite',
          relationship: 'same_turn_prerequisite',
        }],
      },
      dependsOn: [{
        mutationId: 'evicted-prerequisite',
        relationship: 'same_turn_prerequisite',
      }],
      createdAt: 200,
      attempts: 0,
      nextAttemptAt: 0,
    }]);

    const deliveredFields: string[] = [];
    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => createApiSessionSocketStub({ connected: false }),
      requestReconnect: () => {},
      deliverRegisteredSessionStateFieldMutation: async (mutation) => {
        deliveredFields.push(mutation.mutationId);
        return true;
      },
    });

    await waitForAsyncCondition(async () => (
      deliveredFields.length > 0
      || (await readPersistedOutboxDeadLetters('s1')).some((entry) => (
        Boolean(entry)
        && typeof entry === 'object'
        && (entry as Record<string, unknown>).mutationId === 'dependent-after-evicted-prerequisite'
      ))
    ));

    expect(deliveredFields).toEqual([]);
    await expect(readPersistedOutboxDeadLetters('s1')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'registered_session_state_field',
        mutationId: 'dependent-after-evicted-prerequisite',
        reason: 'failed_prerequisite',
        diagnostic: expect.objectContaining({
          prerequisiteMutationId: 'evicted-prerequisite',
          prerequisiteReason: 'missing_prerequisite_evidence',
        }),
      }),
    ]));
    await expect(readPersistedOutboxMutationCount('s1')).resolves.toBe(0);
    await outbox.close();
  });

  it('prunes terminal failed-prerequisite reasons after dependents leave the outbox', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });

    await saveSessionClientDurableMutationOutbox('s1', [
      {
        kind: 'registered_session_state_field',
        mutationId: 'terminal-prerequisite',
        payload: {
          v: 1,
          sessionId: 's1',
          mutationId: 'terminal-prerequisite',
          fieldId: 'display.title',
          deliveryClass: 'durable_best_effort',
          op: { kind: 'set', value: 'Retry-exhaustible prerequisite' },
          source: 'runtime',
          observedAt: 100,
        },
        createdAt: 100,
        attempts: 0,
        nextAttemptAt: 0,
      },
      {
        kind: 'registered_session_state_field',
        mutationId: 'terminal-dependent',
        payload: {
          v: 1,
          sessionId: 's1',
          mutationId: 'terminal-dependent',
          fieldId: 'runtime.workState',
          deliveryClass: 'durable_required',
          op: {
            kind: 'set',
            value: {
              v: 1,
              backendId: 'codex-app-server',
              updatedAt: 200,
              items: [],
            },
          },
          source: 'runtime',
          observedAt: 200,
          dependsOn: [{
            mutationId: 'terminal-prerequisite',
            relationship: 'same_turn_prerequisite',
          }],
        },
        dependsOn: [{
          mutationId: 'terminal-prerequisite',
          relationship: 'same_turn_prerequisite',
        }],
        createdAt: 200,
        attempts: 0,
        nextAttemptAt: 0,
      },
    ]);

    const deliveredFields: string[] = [];
    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
      deliverRegisteredSessionStateFieldMutation: async (mutation) => {
        if (mutation.mutationId === 'terminal-prerequisite') return false;
        deliveredFields.push(mutation.mutationId);
        return true;
      },
    });

    await waitForAsyncCondition(async () => (
      (await readPersistedOutboxDeadLetters('s1')).some((entry) => (
        Boolean(entry)
        && typeof entry === 'object'
        && (entry as Record<string, unknown>).mutationId === 'terminal-dependent'
        && (entry as Record<string, unknown>).reason === 'failed_prerequisite'
      ))
    ));

    await outbox.enqueueRegisteredSessionStateFieldMutation({
      v: 1,
      sessionId: 's1',
      mutationId: 'later-dependent-after-prune',
      fieldId: 'runtime.workState',
      deliveryClass: 'durable_required',
      op: {
        kind: 'set',
        value: {
          v: 1,
          backendId: 'codex-app-server',
          updatedAt: 300,
          items: [],
        },
      },
      source: 'runtime',
      observedAt: 300,
      dependsOn: [{
        mutationId: 'terminal-dependent',
        relationship: 'same_turn_prerequisite',
      }],
    });

    await waitForAsyncCondition(async () => (
      (await readPersistedOutboxDeadLetters('s1')).some((entry) => (
        Boolean(entry)
        && typeof entry === 'object'
        && (entry as Record<string, unknown>).mutationId === 'later-dependent-after-prune'
      ))
    ));

    expect(deliveredFields).toEqual([]);
    await expect(readPersistedOutboxDeadLetters('s1')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'registered_session_state_field',
        mutationId: 'later-dependent-after-prune',
        reason: 'failed_prerequisite',
        diagnostic: expect.objectContaining({
          prerequisiteMutationId: 'terminal-dependent',
          prerequisiteReason: 'missing_prerequisite_evidence',
        }),
      }),
    ]));
    await outbox.close();
  });

  it('pauses authentication failures without consuming retry attempts', async () => {
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockRejectedValue(Object.assign(new Error('expired bearer secret-token'), {
      response: { status: 401 },
    }));
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async () => {
        throw new Error('socket emit should not be reached while disconnected');
      },
    });

    await saveQueuedSessionTurnMutation({
      v: 1,
      sessionId: 's1',
      mutationId: 'mutation-auth',
      action: 'begin',
      turnId: 'turn-auth',
      observedAt: 100,
    });

    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'tok',
      sessionId: 's1',
      getSocket: () => sessionSocketStub,
      requestReconnect: () => {},
    });

    await waitForAsyncCondition(async () => {
      const mutations = await readPersistedOutboxMutations('s1');
      const first = mutations[0];
      return Boolean(
        first
        && typeof first === 'object'
        && !Array.isArray(first)
        && (first as Record<string, unknown>).paused !== undefined,
      );
    });

    const [queued] = await readPersistedOutboxMutations('s1');
    expect(queued).toMatchObject({
      mutationId: 'mutation-auth',
      attempts: 0,
      paused: {
        reason: 'session_auth_recovery',
      },
    });
    expect(JSON.stringify(queued)).not.toContain('secret-token');
    await expect(readPersistedOutboxDeadLetters('s1')).resolves.toEqual([]);
    await outbox.close();
  });

});

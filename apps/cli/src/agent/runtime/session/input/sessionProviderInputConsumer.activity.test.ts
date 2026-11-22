import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { RuntimeActivitySnapshotTail } from '@/api/session/sessionClientPort';
import { createDeferred } from '@/testkit/async/deferred';
import { createSessionProviderInputConsumer } from './sessionProviderInputConsumer';
import { buildSessionAgentActivityHeadline } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityHeadlineBuild';
import { createHostSubagentStore } from '@/session/subagents/hostSubagentStore';
import type { AgentState } from '@/api/types';
import type { SessionAgentActivityEntryV1 } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityEntryV1';
import { publishSessionFollowWakeInvalidation, readSessionFollowWakeInvalidationGeneration, waitForSessionFollowWakeInvalidation } from '../follow/sessionFollowWakeSignal';

function idleTail(): RuntimeActivitySnapshotTail {
  return { sequence: 1, custody: null, settlement: {
    identity: { mutationKey: 'runtime-activity:s1', admissionOrder: 1 },
    desiredValue: { state: 'idle', activeCount: 0 }, result: 'applied',
    committedProjection: { state: 'idle', activeCount: 0, observedAt: 1, revision: 2 }, committedRevision: 2,
  } };
}

describe('Session input live-work observation', () => {
  it('counts workflow agents without counting their containing run as another subagent', async () => {
    const entries: SessionAgentActivityEntryV1[] = [
      { entryId: 'run', kind: 'workflow_run', title: 'Run', status: 'running', updatedAt: 1 },
      { entryId: 'a', parentId: 'run', kind: 'workflow_agent', title: 'A', status: 'running', updatedAt: 1 },
      { entryId: 'b', parentId: 'run', kind: 'workflow_agent', title: 'B', status: 'running', updatedAt: 1 },
    ];
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: async () => false, getAgentStateSnapshot: () => ({}),
      getMetadataSnapshot: () => ({ sessionAgentActivityHeadlineV1: buildSessionAgentActivityHeadline({ backendId: 'test', updatedAt: 1, entries }) }),
      readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }), readRuntimeActivitySnapshotTail: idleTail,
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    expect(await consumer.readLiveWork()).toMatchObject({ agents: 'active', agentsActiveCount: 2 });
    entries.splice(1);
    expect(await consumer.readLiveWork()).toMatchObject({ agents: 'active', agentsActiveCount: 0 });
  });
  it('keeps unavailable Agent state unknown and derives pending requests despite nullable capabilities', async () => {
    let agentState: AgentState | null = null;
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: async () => false, getMetadataSnapshot: () => ({}),
      getAgentStateSnapshot: () => agentState,
      readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }), readRuntimeActivitySnapshotTail: idleTail,
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    expect(await consumer.readLiveWork()).toMatchObject({ attention: 'unknown' });
    expect((await consumer.readLiveWork()).settledAt).toBeUndefined();
    agentState = { capabilities: { inFlightSteer: null, askUserQuestionAnswersInPermission: null } };
    expect(await consumer.readLiveWork()).toMatchObject({ attention: 'settled', settledAt: expect.any(Number) });
    agentState = { ...agentState, requests: {
      question: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 1 },
    } };
    expect(await consumer.readLiveWork()).toMatchObject({ attention: 'active' });
    agentState = { ...agentState, completedRequests: {
      question: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 1, completedAt: 2, status: 'approved' },
    } };
    expect(await consumer.readLiveWork()).toMatchObject({ attention: 'settled', settledAt: expect.any(Number) });
  });
  it('does not retain a settlement anchor through a malformed idle observation', async () => {
    let tail = idleTail();
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: async () => false, getMetadataSnapshot: () => ({}), getAgentStateSnapshot: () => ({}),
      readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }), readRuntimeActivitySnapshotTail: () => tail,
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    expect((await consumer.readLiveWork()).settledAt).toBe(1);
    tail = { ...tail, settlement: { ...tail.settlement!, committedProjection: { ...tail.settlement!.committedProjection, observedAt: NaN } } };
    expect((await consumer.readLiveWork()).settledAt).toBeUndefined();
  });
  it('observes live host subagents, fails closed on malformed headlines, and releases the host subscription', async () => {
    const store = createHostSubagentStore({ maxListResults: 1 });
    let metadata: unknown = {};
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: async () => false, getMetadataSnapshot: () => metadata, getAgentStateSnapshot: () => ({}),
      readSubagentLiveWork: () => store.readLiveWork('parent'), subscribeSubagentLiveWork: listener => store.subscribeLiveWork('parent', listener),
      readRuntimeActivitySnapshotTail: idleTail,
      getPendingQueueState: () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    const reads: Array<ReturnType<typeof consumer.readLiveWork>> = [];
    const unsubscribe = consumer.subscribeLiveWork(() => reads.push(consumer.readLiveWork()));
    await store.upsert({ actor: { kind: 'host' }, input: { id: 'child', parentSessionId: 'parent', origin: 'agent', kind: 'native' } });
    expect(await reads.at(-1)).toMatchObject({ agents: 'active', agentsActiveCount: 1 });
    await store.complete({ actor: { kind: 'host' }, id: 'child', parentSessionId: 'parent' });
    expect(await reads.at(-1)).toMatchObject({ agents: 'settled', settledAt: expect.any(Number) });
    metadata = { sessionAgentActivityHeadlineV1: { v: 1, backendId: 'test', updatedAt: 1, activeEntries: [{}] } };
    expect(await consumer.readLiveWork()).toMatchObject({ agents: 'unknown' });
    unsubscribe();
    const length = reads.length;
    await store.upsert({ actor: { kind: 'host' }, input: { id: 'next', parentSessionId: 'parent', origin: 'agent', kind: 'native' } });
    expect(reads).toHaveLength(length);
  });
  it('requires fresh known Pending state and an exact committed idle tail', async () => {
    let tail = idleTail();
    let pendingCount = 0;
    let pendingBlockedCount = 0;
    let known = false;
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<string>(() => 'mode'),
      session: {
        waitForMetadataUpdate: async () => false,
        readRuntimeActivitySnapshotTail: () => tail,
        readPendingQueueStateForLiveWork: async () => known
          ? { known: true, pendingCount, pendingBlockedCount, pendingVersion: 1 }
          : { known: false },
      },
    });
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ session: 'settled', input: 'unknown', agents: 'unknown', attention: 'unknown' });
    known = true;
    pendingCount = 1;
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ session: 'settled', input: 'active' });
    // Held rows wait for their person (for example after Machine access was withdrawn), not for this runner.
    pendingBlockedCount = 1;
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ session: 'settled', input: 'settled' });
    pendingBlockedCount = 0;
    pendingCount = 0;
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ session: 'settled', input: 'settled' });
    tail = { ...tail, custody: { identity: { mutationKey: 'runtime-activity:s1', admissionOrder: 2 },
      value: { state: 'idle', activeCount: 0 } } };
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ session: 'unknown', input: 'settled' });
    tail = { ...idleTail(), settlement: { ...idleTail().settlement!, committedRevision: 3 } };
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ session: 'unknown', input: 'settled' });
  });

  it('keeps preparation and held input busy through real dispatch settlement', async () => {
    const queue = new MessageQueue2<string>(() => 'mode');
    const dispatch = createDeferred<void>();
    const consumer = createSessionProviderInputConsumer({ messageQueue: queue, session: {
      waitForMetadataUpdate: async () => false,
      readRuntimeActivitySnapshotTail: idleTail,
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    queue.pushImmediate('accepted input', 'mode');
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'active' });
    await consumer.enforceProviderInputAdmission({ kind: 'action_required', reason: 'group_unavailable', serviceId: 'service', groupId: 'group' });
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'active' });
    await consumer.clearProviderInputAdmission({ serviceId: 'service', groupId: 'group' });
    await consumer.waitForNextInput({ abortSignal: new AbortController().signal });
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'active' });
    const running = consumer.runProviderInputDispatch({ abortSignal: new AbortController().signal, dispatch: () => dispatch.promise });
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'active' });
    dispatch.resolve();
    await running;
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'active' });
    consumer.releaseInputBatch();
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'settled' });
  });

  it('cannot turn a failed fresh Pending query into settled input', async () => {
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: async () => false,
      readRuntimeActivitySnapshotTail: idleTail,
      readPendingQueueStateForLiveWork: async () => { throw new Error('transport unavailable'); },
    } });
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'unknown' });
  });

  it('transfers queue custody before notifying observers and releases the last subscription', async () => {
    const queue = new MessageQueue2<string>(() => 'mode');
    const consumer = createSessionProviderInputConsumer({ messageQueue: queue, session: {
      waitForMetadataUpdate: async () => false,
      readRuntimeActivitySnapshotTail: idleTail,
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    const reads: Array<ReturnType<typeof consumer.readLiveWork>> = [];
    const unsubscribe = consumer.subscribeLiveWork(() => { reads.push(consumer.readLiveWork()); });
    queue.pushImmediate('accepted', 'mode');
    await consumer.waitForNextInput({ abortSignal: new AbortController().signal });
    expect((await Promise.all(reads)).every(read => read.input === 'active')).toBe(true);
    consumer.releaseInputBatch();
    await expect(reads.at(-1)).resolves.toMatchObject({ input: 'settled' });
    unsubscribe();
    const lastRead = reads.at(-1);
    queue.pushImmediate('next', 'mode');
    expect(reads.at(-1)).toBe(lastRead);
  });

  it('does not notify live-work observers for an empty pending drain', async () => {
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: async () => false,
      getPendingQueueState: () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
      readRuntimeActivitySnapshotTail: idleTail,
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    let notifications = 0;
    const unsubscribe = consumer.subscribeLiveWork(() => { notifications += 1; });

    await consumer.drainPending();

    expect(notifications).toBe(0);
    unsubscribe();
  });
});

describe('Session input live-work notification stability', () => {
  afterEach(() => { vi.useRealTimers(); });
  it.each([false, true])('publishes settlement when an observer saw an empty context preparation as active after the settled report (later invalidation: %s)', async (afterLaterInvalidation) => {
    const controller = new AbortController();
    const preparing = createDeferred<void>();
    const context = createDeferred<null>();
    let contextTakes = 0;
    let observedContextGeneration = readSessionFollowWakeInvalidationGeneration();
    const pending = { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 } as const;
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<string>(() => 'mode'),
      session: {
        waitForMetadataUpdate: signal => new Promise<boolean>(resolve => {
          signal?.addEventListener('abort', () => resolve(false), { once: true });
        }),
        getMetadataSnapshot: () => ({}), getAgentStateSnapshot: () => ({}),
        readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }),
        readRuntimeActivitySnapshotTail: idleTail,
        getPendingQueueState: () => pending,
        readPendingQueueStateForLiveWork: async () => pending,
        materializeNextPendingMessageSafely: async () => ({ type: 'no_pending' as const }),
      },
      takeContextOnlyInput: async () => {
        observedContextGeneration = readSessionFollowWakeInvalidationGeneration();
        contextTakes += 1;
        if (afterLaterInvalidation && contextTakes === 1) return null;
        preparing.resolve();
        return await context.promise;
      },
      waitForContextOnlyInputChange: signal => waitForSessionFollowWakeInvalidation(observedContextGeneration, signal),
    });
    const reports: Array<ReturnType<typeof consumer.readLiveWork>> = [];
    const unsubscribe = consumer.subscribeLiveWork(() => { reports.push(consumer.readLiveWork()); });
    // The daemon has the runner's settled push before a content-free follow edge rereads it.
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'settled' });
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal });
    try {
      if (afterLaterInvalidation) {
        await vi.waitFor(() => expect(contextTakes).toBe(1));
        publishSessionFollowWakeInvalidation();
      }
      await preparing.promise;
      await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'active' });
      context.resolve(null);
      await new Promise<void>(resolve => setImmediate(resolve));
      // Settlement must arrive by push, before another direct read can repair the observer.
      expect((await Promise.all(reports)).map(report => report.input)).toEqual(['settled']);
      await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'settled' });
    } finally {
      context.resolve(null);
      controller.abort();
      await waiting;
      unsubscribe();
    }
  });
  it.each([
    ['an empty take settles input', null, 'settled'],
    ['a taken context item stays held work', { message: 'host context', mode: 'mode', isolate: true, hash: 'context' }, 'active'],
  ] as const)('parks a context preparation behind held Pending rows: %s', async (_name, taken, input) => {
    // Live W21-A-GUEST r2: a startup pass began a context take before Pending was known; a wake
    // won the race, then the guest's two rows were held (blocked). Held rows keep every later
    // pass off the context path, so no pass retains the settled take.
    const controller = new AbortController();
    const context = createDeferred<typeof taken>();
    const preparing = createDeferred<void>();
    const metadataWaiters = new Set<() => void>();
    let pending: { known: true; pendingCount: number; pendingBlockedCount: number; pendingVersion: number } =
      { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 };
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: signal => new Promise<boolean>(resolve => {
        const wake = () => { metadataWaiters.delete(wake); resolve(true); };
        metadataWaiters.add(wake);
        signal?.addEventListener('abort', () => { metadataWaiters.delete(wake); resolve(false); }, { once: true });
      }),
      getMetadataSnapshot: () => ({}), getAgentStateSnapshot: () => ({}),
      readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }), readRuntimeActivitySnapshotTail: idleTail,
      getPendingQueueState: () => pending,
      readPendingQueueStateForLiveWork: async () => pending,
      hasPendingProviderInput: () => pending.pendingCount > 0,
      materializeNextPendingMessageSafely: async () => ({ type: 'no_pending' as const }),
    }, takeContextOnlyInput: async () => {
      preparing.resolve();
      return await context.promise;
    } });
    const reports: Array<ReturnType<typeof consumer.readLiveWork>> = [];
    const unsubscribe = consumer.subscribeLiveWork(() => { reports.push(consumer.readLiveWork()); });
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal });
    try {
      await preparing.promise;
      await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'active' });
      pending = { known: true, pendingCount: 2, pendingBlockedCount: 2, pendingVersion: 7 };
      for (const wake of [...metadataWaiters]) wake();
      await new Promise<void>(resolve => setImmediate(resolve));
      context.resolve(taken);
      await new Promise<void>(resolve => setImmediate(resolve));
      await expect(consumer.readLiveWork()).resolves.toMatchObject({ input });
      // The daemon's access-loss end waits on pushes only: settlement must be pushed.
      expect((await Promise.all(reports)).map(report => report.input).at(-1) ?? 'active').toBe(input);
    } finally {
      context.resolve(null);
      controller.abort();
      await waiting;
      unsubscribe();
    }
  });
  it('keeps settled input parked across metadata wakes until its context source changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100);
    const metadataWaiters = new Set<() => void>();
    const controller = new AbortController();
    let probes = 0;
    let contextReady = false;
    let observedContextGeneration = readSessionFollowWakeInvalidationGeneration();
    const waitForMetadataUpdate = (signal?: AbortSignal) => new Promise<boolean>(resolve => {
      const finish = (changed: boolean) => {
        metadataWaiters.delete(wake);
        signal?.removeEventListener('abort', abort);
        resolve(changed);
      };
      const wake = () => finish(true);
      const abort = () => finish(false);
      metadataWaiters.add(wake);
      signal?.addEventListener('abort', abort, { once: true });
    });
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate, getMetadataSnapshot: () => ({}), getAgentStateSnapshot: () => ({}),
      readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }), readRuntimeActivitySnapshotTail: idleTail,
      getPendingQueueState: () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
      materializeNextPendingMessageSafely: async () => ({ type: 'no_pending' as const }),
    }, takeContextOnlyInput: async () => {
      probes += 1;
      observedContextGeneration = readSessionFollowWakeInvalidationGeneration();
      return contextReady ? { message: 'new host context', mode: 'mode', isolate: true, hash: 'context-change' } : null;
    },
    waitForContextOnlyInputChange: signal => waitForSessionFollowWakeInvalidation(observedContextGeneration, signal) });
    const unsubscribe = consumer.subscribeLiveWork(() => {});
    const waiting = consumer.waitForNextInput({ abortSignal: controller.signal,
      onMetadataUpdate: () => {
        // Publish between passes, after the old context waiter was retired.
        if (contextReady) publishSessionFollowWakeInvalidation();
      },
    });
    try {
      await vi.waitFor(() => {
        expect(probes).toBe(1);
        expect(metadataWaiters.size).toBe(2);
      });
      const settledAt = (await consumer.readLiveWork()).settledAt;
      for (let update = 0; update < 20; update += 1) {
        vi.setSystemTime(1000 + update);
        for (const wake of [...metadataWaiters]) wake();
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      // A Guard notice changes metadata, not the context source. Neither its
      // own warning nor an activity observation may start another empty probe.
      expect(probes).toBe(1);
      expect((await consumer.readLiveWork()).settledAt).toBe(settledAt);
      contextReady = true;
      for (const wake of [...metadataWaiters]) wake();
      await vi.waitFor(() => expect(probes).toBe(2));
      await expect(waiting).resolves.toMatchObject({ message: 'new host context' });
    } finally { controller.abort(); await waiting; unsubscribe(); }
  });
  it('does not re-notify the observer that only re-read an unchanged host', async () => {
    // The daemon re-reads live work on every notification, and each Session snapshot
    // refresh wakes the metadata observer. A read the pending drain could not prove
    // (`known: false`) must not make the next unchanged observation look like new work.
    vi.useFakeTimers({ toFake: ['Date'] });
    const metadataWaiters: Array<() => void> = [];
    const wakeMetadata = () => { for (const wake of metadataWaiters.splice(0)) wake(); };
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: signal => new Promise<boolean>(resolve => {
        metadataWaiters.push(() => resolve(true));
        signal?.addEventListener('abort', () => resolve(false), { once: true });
      }),
      getMetadataSnapshot: () => ({}), getAgentStateSnapshot: () => ({}),
      readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }), readRuntimeActivitySnapshotTail: idleTail,
      getPendingQueueState: () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
      readPendingQueueStateForLiveWork: async () => ({ known: false }),
    } });
    let notifications = 0;
    const unsubscribe = consumer.subscribeLiveWork(() => {
      notifications += 1;
      if (notifications > 20) return;
      vi.setSystemTime(Date.now() + 500);
      void consumer.readLiveWork().then(wakeMetadata);
    });
    await consumer.readLiveWork();
    wakeMetadata();
    for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
    unsubscribe();
    expect(notifications).toBeLessThanOrEqual(1);
  });

  it('does not notify observers when a context wake finds no context-only input', async () => {
    // Every content-free Account change wakes each idle Session. A wake whose take comes back
    // empty held no custody, so it cannot be new work for the daemon that re-reads on each notice.
    const controller = new AbortController();
    let wakes = 0;
    const takeContextOnlyInput = vi.fn(async () => {
      await Promise.resolve();
      if (takeContextOnlyInput.mock.calls.length >= 5) controller.abort();
      return null;
    });
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: signal => new Promise<boolean>(resolve => {
        signal?.addEventListener('abort', () => resolve(false), { once: true });
      }),
      getMetadataSnapshot: () => ({}), getAgentStateSnapshot: () => ({}),
      readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }), readRuntimeActivitySnapshotTail: idleTail,
      getPendingQueueState: () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
      materializeNextPendingMessageSafely: async () => ({ type: 'no_pending' as const }),
    }, takeContextOnlyInput,
    waitForContextOnlyInputChange: signal => new Promise<boolean>(resolve => {
      wakes += 1;
      if (wakes <= 5) resolve(true);
      else signal.addEventListener('abort', () => resolve(false), { once: true });
    }) });
    let notifications = 0;
    const unsubscribe = consumer.subscribeLiveWork(() => { notifications += 1; });
    await consumer.waitForNextInput({ abortSignal: controller.signal });
    unsubscribe();
    expect(takeContextOnlyInput.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(notifications).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { registerSessionProviderInputAdmissionRpc, requestSessionInputLiveWork } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import type { RpcHandler } from '@/api/rpc/types';
import type { TrackedSession } from '../types';
import { createManagedActivityInventory } from './managedActivity';
import { createSessionLiveWorkProducer } from './sessionLiveWorkProducer';
import { createSpawnRequestCoalescer, computeDaemonSpawnRequestKey } from '../spawn/spawnRequestCoalescer';
import { createDeferred } from '@/testkit/async/deferred';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';

describe('live Session producer at the host input RPC boundary', () => {
  it('keeps accepted startup preparation busy before any runner PID exists', async () => {
    const startup = createSpawnRequestCoalescer({ recentSuccessTtlMs: 0 });
    const source = createSessionLiveWorkProducer({ startup, readSessions: () => [], readActivity: async () => {
      throw new Error('no runner exists');
    } });
    const inventory = createManagedActivityInventory({ producers: [source] });
    const work = createDeferred<SpawnSessionResult>();
    const admitted = startup.run(computeDaemonSpawnRequestKey({ directory: '/tmp/project' }), () => work.promise);
    expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['setup'] });
    work.resolve({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'canceled before launch' });
    await admitted;
    expect((await inventory.readDecision()).kind).toBe('idle');
    inventory.dispose();
  });
  it('uses real committed runtime/Pending facts and preserves launch attribution through the private census', async () => {
    const queue = new MessageQueue2<string>(() => 'mode');
    const consumer = createSessionProviderInputConsumer({ messageQueue: queue, session: {
      waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
      readRuntimeActivitySnapshotTail: () => ({ sequence: 1, custody: null, settlement: {
        identity: { mutationKey: 'runtime:s1', admissionOrder: 1 }, desiredValue: { state: 'idle', activeCount: 0 },
        result: 'applied', committedProjection: { state: 'idle', activeCount: 0, observedAt: 1, revision: 1 }, committedRevision: 1,
      } }),
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    const handlers = new Map<string, RpcHandler>();
    registerSessionProviderInputAdmissionRpc({ consumer, rpcHandlerRegistrar: {
      registerHandler: (method, handler) => { handlers.set(method, handler); },
    } });
    const attribution = { serverId: 'home', accountId: 'requester', machineId: 'machine', installationId: 'installation' };
    const tracked: TrackedSession = { pid: 1, startedBy: 'daemon', happySessionId: 'session', requesterWorkAttributionV1: attribution };
    const source = createSessionLiveWorkProducer({ readSessions: () => [tracked], readActivity: async () =>
      requestSessionInputLiveWork({ callRpc: async (method, request) => handlers.get(method)!(request) }),
    });
    const inventory = createManagedActivityInventory({ producers: [source] });
    expect((await inventory.read()).items).toEqual([
      { category: 'session', ownerRef: tracked, attribution, state: 'settled' },
      { category: 'input', ownerRef: tracked, attribution, state: 'settled' },
    ]);
    expect((await inventory.readDecision()).kind).toBe('idle');
    queue.pushImmediate('private prompt', 'mode');
    source.notifyChanged();
    expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['input'] });
    queue.discardMatching(() => true);
    source.notifyChanged();
    expect((await inventory.readDecision()).kind).toBe('idle');
    inventory.dispose();
  });

  it('keeps unreported startup and failed live transport unknown even when activeTurnId is absent', async () => {
    const tracked: TrackedSession = { pid: 1, startedBy: 'daemon', happySessionId: 'session' };
    const source = createSessionLiveWorkProducer({ readSessions: () => [tracked], readActivity: async () => { throw new Error('unreachable'); } });
    await expect(source.read()).resolves.toMatchObject({ coverage: 'unknown', items: [
      { category: 'session', state: 'unknown' }, { category: 'input', state: 'unknown' },
    ] });
    tracked.happySessionId = undefined;
    await expect(source.read()).resolves.toMatchObject({ coverage: 'unknown' });
  });

  it('does not apply a reply after its exact tracked process has been retired', async () => {
    const tracked: TrackedSession = { pid: 1, startedBy: 'daemon', happySessionId: 'session' };
    let sessions = [tracked];
    const source = createSessionLiveWorkProducer({ readSessions: () => sessions, readActivity: async () => {
      sessions = [];
      return { session: 'settled', input: 'settled' };
    } });
    await expect(source.read()).resolves.toEqual({ coverage: 'complete', items: [] });
  });

  it('keeps a process replacement arriving during the read unknown until its own live query succeeds', async () => {
    const original: TrackedSession = { pid: 1, startedBy: 'daemon', happySessionId: 'session' };
    const replacement: TrackedSession = { pid: 2, startedBy: 'daemon', happySessionId: 'session' };
    let sessions = [original];
    const source = createSessionLiveWorkProducer({ readSessions: () => sessions, readActivity: async () => {
      sessions = [replacement];
      return { session: 'settled', input: 'settled' };
    } });
    await expect(source.read()).resolves.toMatchObject({ coverage: 'unknown', items: [
      { ownerRef: replacement, state: 'unknown' }, { ownerRef: replacement, state: 'unknown' },
    ] });
    await expect(source.read()).resolves.toMatchObject({ coverage: 'complete' });
  });
});

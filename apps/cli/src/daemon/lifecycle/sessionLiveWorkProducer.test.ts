import { describe, expect, it } from 'vitest';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { registerSessionProviderInputAdmissionRpc, requestSessionInputLiveWork } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import type { RpcHandler } from '@/api/rpc/types';
import type { TrackedSession } from '../types';
import { createLiveWorkProducerGroup, createManagedActivityInventory, readWorkspaceSessionIdle } from './managedActivity';
import { createSessionLiveWorkProducer } from './sessionLiveWorkProducer';
import { createSpawnRequestCoalescer, computeDaemonSpawnRequestKey } from '../spawn/spawnRequestCoalescer';
import { createDeferred } from '@/testkit/async/deferred';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { buildSessionAgentActivityHeadline } from '@happier-dev/protocol/sessions/work/agentActivity/agentActivityHeadlineBuild';
import type { AgentState } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

describe('live Session producer at the host input RPC boundary', () => {
  it.each([
    { locationMachineId: 'machine', expectedWorkspacePath: '/repos/project', expectedIdle: false },
    { locationMachineId: 'replaced-machine', expectedWorkspacePath: '/agent/repo', expectedIdle: true },
  ])('uses the published same-machine workspace mapping for $locationMachineId', async ({ locationMachineId, expectedWorkspacePath, expectedIdle }) => {
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(1), pid: 1, startedBy: 'daemon', happySessionId: 'session',
      requesterWorkAttributionV1: { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' },
      happySessionMetadataFromLocalWebhook: createTestMetadata({ path: '/agent/repo', host: 'host', machineId: 'machine',
        sessionWorkspaceLocationV1: { v: 1, machineId: locationMachineId, agentPath: '/agent/repo', machinePath: '/repos/project' } }),
    };
    const source = createSessionLiveWorkProducer({ readSessions: () => [tracked], readActivity: async () => ({
      session: 'settled', input: 'settled', agents: 'active', attention: 'settled', agentsActiveCount: 1,
    }) });
    const inventory = await source.read();
    expect(inventory.items.every(item => item.workspacePath === expectedWorkspacePath)).toBe(true);
    expect(readWorkspaceSessionIdle(inventory, { workspacePath: '/repos/project', workspaceId: 'project' })).toBe(expectedIdle);
  });
  it('keeps background agents and waiting questions busy, and retains the runner settlement across daemon inventories', async () => {
    let entries: Parameters<typeof buildSessionAgentActivityHeadline>[0]['entries'] = [{
      entryId: 'background', kind: 'workflow_agent', title: 'Background work', status: 'running', updatedAt: 20,
    }];
    let agentState: AgentState = {};
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: async () => false,
      getMetadataSnapshot: () => ({ sessionAgentActivityHeadlineV1: buildSessionAgentActivityHeadline({
        backendId: 'test', updatedAt: 20, entries,
      }) }),
      getAgentStateSnapshot: () => agentState,
      readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }),
      readRuntimeActivitySnapshotTail: () => ({ sequence: 1, custody: null, settlement: {
        identity: { mutationKey: 'runtime:s1', admissionOrder: 1 }, desiredValue: { state: 'idle', activeCount: 0 },
        result: 'applied', committedProjection: { state: 'idle', activeCount: 0, observedAt: 10, revision: 1 }, committedRevision: 1,
      } }),
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    const handlers = new Map<string, RpcHandler>();
    registerSessionProviderInputAdmissionRpc({ consumer, rpcHandlerRegistrar: {
      registerHandler: (method, handler) => { handlers.set(method, handler); },
    } });
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(1), pid: 1, startedBy: 'daemon', happySessionId: 'session', spawnOptions: { directory: '/repo' } };
    const source = createSessionLiveWorkProducer({ readSessions: () => [tracked], readActivity: () =>
      requestSessionInputLiveWork({ callRpc: async (method, request) => handlers.get(method)!(request) }),
    });
    let inventory = createManagedActivityInventory({ producers: [source] });
    expect((await inventory.read()).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'session', ownerRef: tracked, workspacePath: '/repo' }),
      expect.objectContaining({ category: 'agents', ownerRef: tracked, workspacePath: '/repo', state: 'active' }),
    ]));
    expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['agents'] });
    entries = [];
    agentState = { requests: { question: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 30 } } };
    expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['attention'] });
    agentState = {};
    const settled = (await inventory.read()).items.find(item => item.category === 'session')?.settledAt;
    expect(settled).toEqual(expect.any(Number));
    inventory.dispose();
    inventory = createManagedActivityInventory({ producers: [source] });
    expect((await inventory.read()).items.find(item => item.category === 'session')?.settledAt).toBe(settled);
    expect((await inventory.readDecision()).kind).toBe('idle');
    inventory.dispose();
  });
  it('keeps accepted startup preparation busy before any runner PID exists', async () => {
    const startup = createSpawnRequestCoalescer();
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
      getMetadataSnapshot: () => ({}),
      getAgentStateSnapshot: () => ({}),
      readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }),
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
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(1), pid: 1, startedBy: 'daemon', happySessionId: 'session', requesterWorkAttributionV1: attribution };
    const source = createSessionLiveWorkProducer({ readSessions: () => [tracked], readActivity: async () =>
      requestSessionInputLiveWork({ callRpc: async (method, request) => handlers.get(method)!(request) }),
    });
    const inventory = createManagedActivityInventory({ producers: [source] });
    expect((await inventory.read()).items).toEqual([
      { category: 'session', ownerRef: tracked, attribution, state: 'settled', settledAt: 1 },
      { category: 'input', ownerRef: tracked, attribution, state: 'settled' },
      { category: 'agents', ownerRef: tracked, attribution, state: 'settled', activeCount: 0 },
      { category: 'attention', ownerRef: tracked, attribution, state: 'settled' },
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

  it('rereads only the Session whose runner reported a change, while explicit confirmations still read every runner', async () => {
    const sessions: TrackedSession[] = ['s1', 's2', 's3'].map((id, index) => ({ trackingKey: legacyPidSessionTrackingKey(index + 1), pid: index + 1, startedBy: 'daemon', happySessionId: id }));
    const reads: string[] = [];
    let s2Input: 'active' | 'settled' = 'settled';
    const source = createSessionLiveWorkProducer({ readSessions: () => sessions, readActivity: async tracked => {
      reads.push(tracked.happySessionId!);
      return { session: 'settled', input: tracked.happySessionId === 's2' ? s2Input : 'settled',
        agents: 'settled', attention: 'settled', settledAt: 1 };
    } });
    // Production shape: the daemon wraps the owner in a late-bound group under the managed inventory.
    const group = createLiveWorkProducerGroup(() => [source]);
    const inventory = createManagedActivityInventory({ producers: [group] });
    expect((await inventory.readDecision()).kind).toBe('idle');
    expect(reads.sort()).toEqual(['s1', 's2', 's3']);
    const decisions: string[] = [];
    inventory.subscribe(decision => decisions.push(decision.kind));
    reads.length = 0;
    s2Input = 'active';
    source.notifySessionChanged('s2');
    for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
    // One runner reported a change: the passive refresh reads that runner only.
    expect({ reads: [...reads].sort(), decisions }).toEqual({ reads: ['s2'], decisions: ['busy'] });
    reads.length = 0;
    // An unattributed (structural) change and an explicit confirmation still read every runner.
    source.notifyChanged();
    for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect([...reads].sort()).toEqual(['s1', 's2', 's3']);
    reads.length = 0;
    expect(await inventory.readDecision()).toEqual({ kind: 'busy', reasons: ['input'] });
    expect([...reads].sort()).toEqual(['s1', 's2', 's3']);
    inventory.dispose();
    group.dispose();
  });

  it('keeps unreported startup and failed live transport unknown even when activeTurnId is absent', async () => {
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(1), pid: 1, startedBy: 'daemon', happySessionId: 'session' };
    const source = createSessionLiveWorkProducer({ readSessions: () => [tracked], readActivity: async () => { throw new Error('unreachable'); } });
    await expect(source.read()).resolves.toMatchObject({ coverage: 'unknown', items: [
      { category: 'session', state: 'unknown' }, { category: 'input', state: 'unknown' },
      { category: 'agents', state: 'unknown' }, { category: 'attention', state: 'unknown' },
    ] });
    tracked.happySessionId = undefined;
    await expect(source.read()).resolves.toMatchObject({ coverage: 'unknown' });
  });

  it('does not apply a reply after its exact tracked process has been retired', async () => {
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(1), pid: 1, startedBy: 'daemon', happySessionId: 'session' };
    let sessions = [tracked];
    const source = createSessionLiveWorkProducer({ readSessions: () => sessions, readActivity: async () => {
      sessions = [];
      return { session: 'settled', input: 'settled', agents: 'settled', attention: 'settled' };
    } });
    await expect(source.read()).resolves.toEqual({ coverage: 'complete', items: [] });
  });

  it('keeps a process replacement arriving during the read unknown until its own live query succeeds', async () => {
    const original: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(1), pid: 1, startedBy: 'daemon', happySessionId: 'session' };
    const replacement: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(2), pid: 2, startedBy: 'daemon', happySessionId: 'session' };
    let sessions = [original];
    const source = createSessionLiveWorkProducer({ readSessions: () => sessions, readActivity: async () => {
      sessions = [replacement];
      return { session: 'settled', input: 'settled', agents: 'settled', attention: 'settled' };
    } });
    await expect(source.read()).resolves.toMatchObject({ coverage: 'unknown', items: [
      { ownerRef: replacement, state: 'unknown' }, { ownerRef: replacement, state: 'unknown' },
      { ownerRef: replacement, state: 'unknown' }, { ownerRef: replacement, state: 'unknown' },
    ] });
    await expect(source.read()).resolves.toMatchObject({ coverage: 'complete' });
  });
});

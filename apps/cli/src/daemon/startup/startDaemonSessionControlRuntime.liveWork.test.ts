import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE } from '@happier-dev/protocol';
import type { ActivityDecisionV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import { registerSessionProviderInputAdmissionRpc } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { daemonPost } from '../controlHttp';
import { startAutomationWorker } from '../automation/automationWorker';
import { createLiveWorkProducerGroup, createManagedActivityInventory } from '../lifecycle/managedActivity';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import type { TrackedSession } from '../types';
import type { SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

it('keeps simulated 300s healthy-runner and Automation observations off Session Home reads while activity hints and explicit reads remain fresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-healthy-live-work-'));
  const network = await createRequesterCurrentnessSocketHarness();
  const ids = ['c1234567890123456789012345', 'c2234567890123456789012345'];
  const sessions = new Map<SessionTrackingKey, TrackedSession>(ids.map((happySessionId, index) => [index + 1, {
    pid: index + 1, startedBy: 'daemon', happySessionId,
  }]));
  const queues = ids.map(() => new MessageQueue2<string>(() => 'mode'));
  const runners = new Map(ids.map((sessionId, index) => {
    const consumer = createSessionProviderInputConsumer({ messageQueue: queues[index], session: {
      waitForMetadataUpdate: async () => false,
      getMetadataSnapshot: () => ({}), getAgentStateSnapshot: () => ({}),
      readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }),
      readRuntimeActivitySnapshotTail: () => ({ sequence: 1, custody: null, settlement: {
        identity: { mutationKey: `runtime:${sessionId}`, admissionOrder: 1 }, desiredValue: { state: 'idle', activeCount: 0 },
        result: 'applied', committedProjection: { state: 'idle', activeCount: 0, observedAt: 1, revision: 1 }, committedRevision: 1,
      } }),
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    const manager = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger: () => {} });
    registerSessionProviderInputAdmissionRpc({ consumer, rpcHandlerRegistrar: manager });
    return [sessionId, manager] as const;
  }));
  let activityRequests = 0;
  network.server.on('connection', socket => {
    socket.on(SOCKET_RPC_EVENTS.CALL, async (request: SocketRpcRequestPayload, ack: (reply: unknown) => void) => {
      activityRequests += 1;
      const manager = runners.get(request.method.split(':')[0]);
      if (!manager) throw new Error('Unexpected Session RPC target');
      ack({ ok: true, result: await manager.handleRequest(request) });
    });
  });
  const homeRequests: string[] = [];
  const claimRequests: string[] = [];
  let assignmentRequests = 0;
  let homeUnavailable = false;
  // Only Home HTTP and its network socket endpoint are substituted. Startup,
  // control IPC, inventory, Session transport, RPC codec and host input stay real.
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v3/automations/worker/assignments') {
      assignmentRequests += 1;
      return { status: 200, data: {
        assignments: [], settings: { maxActiveRunsPerMachine: DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE },
      } };
    }
    if (path === '/v3/automations/worker/run-lifecycle') return { status: 200, data: { sources: [] } };
    homeRequests.push(path);
    if (homeUnavailable) throw new Error('Fixture Home unavailable');
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } };
    const sessionId = path.split('/').at(-1);
    if (sessionId && ids.includes(sessionId)) return { status: 200, data: { session: createSessionRecordFixture({
      id: sessionId, metadata: JSON.stringify({ machineId: 'machine', path: directory }), metadataLayoutVersion: 0,
      dataEncryptionKey: null, encryptionMode: 'plain',
    }) } };
    throw new Error(`Unexpected Home read: ${path}`);
  });
  const post = axios.post.bind(axios);
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
    const path = new URL(String(url)).pathname;
    if (path !== '/v3/automations/runs/claim') return post(url, body, config);
    claimRequests.push(path);
    return { status: 200, data: { run: null, automation: null, accountCurrentness: null } };
  });
  let fixture: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | undefined;
  let worker: ReturnType<typeof startAutomationWorker> | undefined;
  let automation: ReturnType<typeof createLiveWorkProducerGroup> | undefined;
  let inventory: ReturnType<typeof createManagedActivityInventory> | undefined;
  let unsubscribeDecisions = () => {};
  const decisions: ActivityDecisionV1[] = [];
  try {
    fixture = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: join(directory, 'home'),
      activeServerDir: join(directory, 'home', 'servers', 'healthy-home'), serverId: 'healthy-home',
      serverHttpBaseUrl: 'https://healthy-home.invalid', machineId: 'machine', custodianAccountId: 'owner',
      credentials: { token: 'healthy-fixture', encryption: null },
      connectedServicesMaterializationBaseDir: join(directory, 'connected-services'),
      registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: sessions,
      getRequester: () => null, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    worker = startAutomationWorker({ token: 'healthy-fixture', credentials: { token: 'healthy-fixture', encryption: null }, machineId: 'machine' });
    automation = createLiveWorkProducerGroup(() => [worker!.liveWorkProducer]);
    await worker.refreshAssignments();
    expect(assignmentRequests).toBeGreaterThan(0);
    inventory = createManagedActivityInventory({ producers: [fixture.runtime.sessionLiveWorkProducer, automation] });
    const initial = await inventory.read();
    expect(initial).toMatchObject({ coverage: 'complete', idleSince: expect.any(Number) });
    expect(initial.items).toHaveLength(8);
    expect(initial.items.every(item => item.state === 'settled')).toBe(true);
    expect(activityRequests).toBe(2);
    // Establish the real Socket.IO connection before virtualizing the worker's
    // scheduler. Pause/resume transfers its existing timer to the fake clock.
    worker.pause();
    const startedAt = Date.now();
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(startedAt);
    worker.resume();
    await worker.refreshAssignments();
    unsubscribeDecisions = inventory.subscribe(decision => { decisions.push(decision); });
    const waitFor = async (check: () => boolean) => {
      const deadline = performance.now() + 2_000;
      while (!check()) {
        if (performance.now() > deadline) throw new Error(`Automation observation did not settle: ${JSON.stringify({
          assignmentRequests, claims: claimRequests.length, publications: decisions.length,
          sessionReads: homeRequests.filter(path => ids.some(id => path === `/v2/sessions/${id}`)).length,
          activityRequests, timers: vi.getTimerCount(),
        })}`);
        await pause(1);
      }
    };
    homeRequests.length = 0;
    activityRequests = 0;
    claimRequests.length = 0;
    // Each step crosses the real worker's 45–60s reconciliation (including jitter). The
    // publication is the passive completion boundary, not a fresh inventory read.
    for (let elapsed = 60_000; elapsed <= 300_000; elapsed += 60_000) {
      const beforeClaims = claimRequests.length;
      const beforePublications = decisions.length;
      await vi.advanceTimersByTimeAsync(60_000);
      for (const tracked of sessions.values()) await fixture.runtime.onTrackedSessionHealthy(tracked);
      await waitFor(() => claimRequests.length > beforeClaims);
      // Assert the cost before joining publication: the broken owner starts
      // unnecessary Session transports that need not have settled to violate it.
      expect(homeRequests.filter(path => ids.some(id => path === `/v2/sessions/${id}`))).toEqual([]);
      await waitFor(() => decisions.length > beforePublications);
    }
    expect(claimRequests).toHaveLength(5);
    expect(homeRequests.filter(path => ids.some(id => path === `/v2/sessions/${id}`))).toEqual([]);
    expect(homeRequests).toEqual([]);
    expect(activityRequests).toBe(0);

    worker.pause();
    const observedAt = Date.now();
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(observedAt);
    const beforeExplicit = activityRequests;
    const explicit = await inventory.read();
    expect(explicit).toMatchObject({ coverage: 'complete', idleSince: initial.idleSince });
    expect(activityRequests - beforeExplicit).toBe(2);
    for (const id of ids) expect(homeRequests).toContain(`/v2/sessions/${id}`);
    homeRequests.length = 0;
    activityRequests = 0;

    const hint = async () => {
      const beforePublications = decisions.length;
      const response = await daemonPost('/session-activity-changed', { sessionId: ids[0] }, {
        timeoutMs: null, target: { pid: process.pid, httpPort: fixture!.runtime.controlPort, controlToken: fixture!.runtime.controlToken },
      });
      expect(response).toEqual({ ok: true });
      await waitFor(() => decisions.length > beforePublications);
      return decisions.at(-1)!;
    };
    queues[0].pushImmediate('fixture input', 'mode');
    const busy = await hint();
    expect(busy).toMatchObject({ kind: 'busy', reasons: expect.arrayContaining(['input']) });
    expect(activityRequests).toBe(2);
    expect(homeRequests.length).toBeGreaterThan(0);

    queues[0].discardMatching(() => true);
    homeUnavailable = true;
    expect(await hint()).toMatchObject({ kind: 'unknown' });
    homeUnavailable = false;
    const beforeRecovery = activityRequests;
    const recovered = await inventory.read();
    expect(recovered).toMatchObject({ coverage: 'complete', idleSince: expect.any(Number) });
    expect(recovered.items.every(item => item.state === 'settled')).toBe(true);
    expect(activityRequests - beforeRecovery).toBe(2);
  } finally {
    unsubscribeDecisions();
    worker?.stop();
    inventory?.dispose();
    automation?.dispose();
    vi.useRealTimers();
    try { await fixture?.dispose(); }
    finally {
      try { await network.close(); }
      finally { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); }
    }
  }
});

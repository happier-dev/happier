import axios from 'axios';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RpcHandler } from '@/api/rpc/types';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import { registerSessionProviderInputAdmissionRpc } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import type { AdmittedRequesterSessionBootstrap } from '../sessionEncryption/requesterSessionCredentials';
import type { TrackedSession } from '../types';
import { createSessionLiveWorkProducer } from './sessionLiveWorkProducer';
import { readTrackedSessionInputLiveWork } from './readTrackedSessionInputLiveWork';
import { readCurrentSessionEligibility } from '../guard/sessionEligibility';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => { runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
  runtimeOptions: { pluginIds: ['happier.agent.codex'] } }); });
afterAll(async () => {
  try { await runtime?.dispose(); }
  finally { await pluginReloadController.shutdown(); }
});

afterEach(() => vi.restoreAllMocks());

describe('requester-qualified live Session network observation', () => {
  it('queries Bob at the admitted Home, finishes admitted observations, and refuses the next call after access loss', async () => {
    const sessionId = 'c1234567890123456789012345';
    const attribution = { serverId: 'bob-home', accountId: 'bob', machineId: 'machine', installationId: 'installation' };
    const tracked: TrackedSession = { pid: 1, startedBy: 'daemon', happySessionId: sessionId,
      requesterWorkAttributionV1: attribution };
    let current = true;
    let loseAdmissionDuringRpc = false;
    const resumableMetadata = { machineId: 'machine', path: '/project', flavor: 'codex', codexSessionId: 'native-bob-session',
      runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } } };
    let metadata: Record<string, unknown> = resumableMetadata;
    const requesterBootstrap: Pick<AdmittedRequesterSessionBootstrap,
      'credentials' | 'attribution' | 'serverHttpBaseUrl' | 'getBoundSessionId' | 'isCurrent'> = {
      credentials: { token: 'bob-ordinary', encryption: null }, attribution,
      serverHttpBaseUrl: 'https://bob-home.test', getBoundSessionId: () => sessionId,
      // This port is the signed Home current-admission network boundary.
      isCurrent: async () => current,
    };
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId,
        metadata: JSON.stringify(metadata), metadataLayoutVersion: 0, dataEncryptionKey: null, encryptionMode: 'plain' }) } };
    });
    const queue = new MessageQueue2<string>(() => 'mode');
    const consumer = createSessionProviderInputConsumer({ messageQueue: queue, session: {
      waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
      getMetadataSnapshot: () => ({}), getAgentStateSnapshot: () => ({}),
      readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }),
      readRuntimeActivitySnapshotTail: () => ({ sequence: 1, custody: null, settlement: {
        identity: { mutationKey: 'runtime:bob', admissionOrder: 1 }, desiredValue: { state: 'idle', activeCount: 0 },
        result: 'applied', committedProjection: { state: 'idle', activeCount: 0, observedAt: 1, revision: 1 }, committedRevision: 1,
      } }),
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    const handlers = new Map<string, RpcHandler>();
    registerSessionProviderInputAdmissionRpc({ consumer, rpcHandlerRegistrar: {
      registerHandler: (method, handler) => { handlers.set(method, handler); },
    } });
    const rpcTokens: string[] = [];
    const input = { tracked, credentials: { token: 'alice-ordinary', encryption: null },
      requesterBootstrap, custodianAccountId: 'alice', serverId: 'bob-home', machineId: 'machine',
      serverHttpBaseUrl: 'https://alice-home.test', isTrackedCurrent: () => true,
      // Only the Session network transport is replaced; host/RPC parsing and producer logic are real.
      callRpc: async (request: Parameters<NonNullable<Parameters<typeof readTrackedSessionInputLiveWork>[0]['callRpc']>>[0]) => {
        rpcTokens.push(request.token);
        const response = await handlers.get(request.method)!(request.request);
        if (loseAdmissionDuringRpc) current = false;
        return response;
      },
    };
    const source = createSessionLiveWorkProducer({ readSessions: () => [tracked],
      readActivity: async () => await readTrackedSessionInputLiveWork(input) });
    // Characterize the genuine HTTP fixture before asserting composed activity;
    // a fixture/schema failure must not masquerade as an inventory assertion RED.
    const transport = await runWithServerHttpBaseUrl(requesterBootstrap.serverHttpBaseUrl,
      () => resolveSessionTransportContext({ reason: 'session-control', credentials: requesterBootstrap.credentials, idOrPrefix: sessionId }));
    expect(transport).toMatchObject({ ok: true, sessionId, mode: 'plain' });
    expect(await source.read()).toMatchObject({ coverage: 'complete', items: [
      { category: 'session', attribution, state: 'settled' }, { category: 'input', attribution, state: 'settled' },
      { category: 'agents', state: 'settled' }, { category: 'attention', state: 'settled' },
    ] });
    expect(rpcTokens).toEqual(['bob-ordinary']);
    expect(reads.mock.calls.every(([url, config]) => String(url).startsWith('https://bob-home.test/')
      && config?.headers?.Authorization === 'Bearer bob-ordinary')).toBe(true);
    const posts = vi.spyOn(axios, 'post').mockResolvedValue({ data: { items: [{
      address: { kind: 'session', sessionId }, content: { t: 'encrypted', c: 'opaque' }, revision: 1, createdAt: 1, updatedAt: 30,
    }] } });
    expect(await readCurrentSessionEligibility({ access: input })).toMatchObject({ eligible: false, reasons: [{ kind: 'unsent_draft' }] });
    expect(posts.mock.calls.every(([url, , config]) => String(url).startsWith('https://bob-home.test/')
      && config?.headers?.Authorization === 'Bearer bob-ordinary')).toBe(true);
    posts.mockClear();
    expect(await readCurrentSessionEligibility({ access: { ...input, requesterBootstrap: undefined } }))
      .toMatchObject({ eligible: false });
    expect(posts).not.toHaveBeenCalled();
    posts.mockResolvedValue({ data: { items: [] } });
    metadata = resumableMetadata;
    expect(await readCurrentSessionEligibility({ access: input }))
      .toMatchObject({ eligible: true, resumeOptions: { existingSessionId: sessionId, directory: '/project' } });
    posts.mockImplementationOnce(async () => {
      queue.pushImmediate('input received during draft read', 'mode');
      return { data: { items: [] } };
    });
    expect(await readCurrentSessionEligibility({ access: input }))
      .toMatchObject({ eligible: false, reasons: expect.arrayContaining([{ kind: 'working' }]) });
    queue.discardMatching(() => true);
    metadata = { machineId: 'machine', path: '/project' };
    expect(await readCurrentSessionEligibility({ access: input }))
      .toMatchObject({ eligible: false, reasons: expect.arrayContaining([{ kind: 'not_resumable' }]) });
    queue.pushImmediate('private input', 'mode');
    expect(await source.read()).toMatchObject({ coverage: 'complete', items: [
      { category: 'session', state: 'settled' }, { category: 'input', state: 'active' },
      { category: 'agents', state: 'settled' }, { category: 'attention', state: 'settled' },
    ] });
    queue.discardMatching(() => true);
    metadata = resumableMetadata;
    const ownInventory = await source.read();
    const inventory = { coverage: 'unknown' as const, items: [...ownInventory.items,
      { category: 'session' as const, ownerRef: {}, attribution: { kind: 'unknown' as const }, state: 'unknown' as const }] };
    const beforeDecision = rpcTokens.length;
    expect(await readCurrentSessionEligibility({ access: input, inventory })).toMatchObject({ eligible: true });
    // The first facts already came from this exact admitted Session. The final
    // post-draft RPC remains fresh; repeating the preliminary RPC adds another
    // full requester proof without protecting a distinct decision boundary.
    expect(rpcTokens.length - beforeDecision).toBe(1);
    posts.mockImplementationOnce(async () => {
      queue.pushImmediate('new input after the supplied settled observation', 'mode');
      return { data: { items: [] } };
    });
    expect(await readCurrentSessionEligibility({ access: input, inventory }))
      .toMatchObject({ eligible: false, reasons: expect.arrayContaining([{ kind: 'working' }]) });
    queue.discardMatching(() => true);
    const beforeIncomplete = rpcTokens.length;
    expect(await readCurrentSessionEligibility({ access: input,
      inventory: { ...inventory, items: inventory.items.filter(item => item.category !== 'attention') } }))
      .toMatchObject({ eligible: true });
    expect(rpcTokens.length - beforeIncomplete).toBe(2);
    loseAdmissionDuringRpc = true;
    expect(await readCurrentSessionEligibility({ access: input, inventory })).toMatchObject({ eligible: true });
    expect(await readCurrentSessionEligibility({ access: input, inventory })).toMatchObject({ eligible: false });
    expect(await source.read()).toMatchObject({ coverage: 'unknown', items: [
      { category: 'session', state: 'unknown' }, { category: 'input', state: 'unknown' },
      { category: 'agents', state: 'unknown' }, { category: 'attention', state: 'unknown' },
    ] });
    reads.mockClear();
    const callsBefore = rpcTokens.length;
    expect(await readTrackedSessionInputLiveWork({ ...input, requesterBootstrap: undefined }))
      .toEqual({ session: 'unknown', input: 'unknown' });
    expect(reads).not.toHaveBeenCalled();
    expect(rpcTokens.length).toBe(callsBefore);
  });

  const createIdleRunnerFixture = (pending: () => Readonly<{ pendingCount: number; pendingVersion: number }>) => {
    const sessionId = 'c9234567890123456789012345';
    const tracked: TrackedSession = { pid: 2, startedBy: 'daemon', happySessionId: sessionId };
    let metadata: Record<string, unknown> = { machineId: 'machine', path: '/project', flavor: 'codex', codexSessionId: 'native-session',
      runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } } };
    let serverPending = { pendingCount: 0, pendingVersion: 1 };
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, metadata: JSON.stringify(metadata),
        metadataLayoutVersion: 0, dataEncryptionKey: null, encryptionMode: 'plain', ...serverPending }) } };
    });
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: () => new Promise<boolean>(() => {}),
      getMetadataSnapshot: () => ({}), getAgentStateSnapshot: () => ({}),
      readSubagentLiveWork: () => ({ state: 'settled', activeCount: 0 }),
      readRuntimeActivitySnapshotTail: () => ({ sequence: 1, custody: null, settlement: {
        identity: { mutationKey: 'runtime:idle', admissionOrder: 1 }, desiredValue: { state: 'idle', activeCount: 0 },
        result: 'applied', committedProjection: { state: 'idle', activeCount: 0, observedAt: 1, revision: 1 }, committedRevision: 1,
      } }),
      // The runner's socket-maintained projection (no Session read of its own).
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingBlockedCount: 0, ...pending() }),
    } });
    const handlers = new Map<string, RpcHandler>();
    registerSessionProviderInputAdmissionRpc({ consumer, rpcHandlerRegistrar: {
      registerHandler: (method, handler) => { handlers.set(method, handler); },
    } });
    let failNextRpc = false;
    const input = { tracked, credentials: { token: 'owner-token', encryption: null }, custodianAccountId: 'owner',
      serverId: 'home', machineId: 'machine', serverHttpBaseUrl: 'https://home.test', isTrackedCurrent: () => true,
      // Only the Session network transport is replaced; RPC parsing and the host consumer are real.
      callRpc: async (request: Parameters<NonNullable<Parameters<typeof readTrackedSessionInputLiveWork>[0]['callRpc']>>[0]) => {
        if (failNextRpc) { failNextRpc = false; throw new Error('rpc_decrypt_failed'); }
        return await handlers.get(request.method)!(request.request);
      },
    };
    const sessionReads = () => reads.mock.calls.filter(([url]) => String(url).endsWith(`/v2/sessions/${sessionId}`)).length;
    return { input, sessionReads, failNextRpc: () => { failNextRpc = true; },
      setServerPending: (next: typeof serverPending) => { serverPending = next; },
      setMetadata: (next: Record<string, unknown>) => { metadata = next; } };
  };

  it('observes idle runner activity without a Session read per observation and rebuilds once after an RPC failure', async () => {
    const fixture = createIdleRunnerFixture(() => ({ pendingCount: 0, pendingVersion: 1 }));
    expect(await readTrackedSessionInputLiveWork(fixture.input)).toMatchObject({ session: 'settled', input: 'settled' });
    const afterFirst = fixture.sessionReads();
    expect(afterFirst).toBe(1);
    for (let tick = 0; tick < 10; tick += 1) {
      expect(await readTrackedSessionInputLiveWork(fixture.input)).toMatchObject({ input: 'settled' });
    }
    expect(fixture.sessionReads()).toBe(afterFirst);
    // A re-keyed or migrated Session surfaces through the existing RPC failure path.
    fixture.failNextRpc();
    expect(await readTrackedSessionInputLiveWork(fixture.input)).toEqual({ session: 'unknown', input: 'unknown' });
    expect(await readTrackedSessionInputLiveWork(fixture.input)).toMatchObject({ input: 'settled' });
    expect(fixture.sessionReads()).toBe(afterFirst + 1);
    for (let tick = 0; tick < 5; tick += 1) await readTrackedSessionInputLiveWork(fixture.input);
    expect(fixture.sessionReads()).toBe(afterFirst + 1);
  });

  it('refuses an idle stop when Pending committed just after the runner projection was last updated', async () => {
    // The runner has not yet received `pending-changed`; its projection still says empty.
    const fixture = createIdleRunnerFixture(() => ({ pendingCount: 0, pendingVersion: 1 }));
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { items: [] } });
    expect(await readCurrentSessionEligibility({ access: fixture.input })).toMatchObject({ eligible: true });
    fixture.setServerPending({ pendingCount: 1, pendingVersion: 2 });
    // The stop actuator's fresh decision sees the committed Pending row: no stop, the live runner keeps it.
    expect(await readCurrentSessionEligibility({ access: fixture.input }))
      .toEqual({ eligible: false, reasons: [{ kind: 'working' }] });
  });

  it('sees a vendor resume id written after spawn on the next Guard tick while activity reads stay record-free', async () => {
    const fixture = createIdleRunnerFixture(() => ({ pendingCount: 0, pendingVersion: 1 }));
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { items: [] } });
    // At spawn the vendor has not reported its native Session id yet.
    fixture.setMetadata({ machineId: 'machine', path: '/project', flavor: 'codex',
      runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } } });
    expect(await readTrackedSessionInputLiveWork(fixture.input)).toMatchObject({ session: 'settled', input: 'settled' });
    // The Guard's per-minute eligibility read (startDaemon `readSessionEligibility`).
    const guardTick = () => readCurrentSessionEligibility({ access: fixture.input });
    expect(await guardTick()).toMatchObject({ eligible: false, reasons: expect.arrayContaining([{ kind: 'not_resumable' }]) });
    fixture.setMetadata({ machineId: 'machine', path: '/project', flavor: 'codex', codexSessionId: 'native-written-later',
      runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } } });
    for (let tick = 0; tick < 3; tick += 1) await readTrackedSessionInputLiveWork(fixture.input);
    expect(await guardTick()).toMatchObject({ eligible: true, resumeOptions: { existingSessionId: expect.any(String) } });
    const before = fixture.sessionReads();
    for (let tick = 0; tick < 5; tick += 1) await readTrackedSessionInputLiveWork(fixture.input);
    expect(fixture.sessionReads()).toBe(before);
  });
});

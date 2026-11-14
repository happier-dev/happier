import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachineUpdateStateRequestSchema, type MachineUpdateStateRequest } from '@happier-dev/protocol/machines/metadataUpdate';
import { decodePlainMachineStoredContent, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, MachineUpdateOperationProtocolCapabilitiesRequestV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import type { DaemonState, Machine } from './types';
import { ApiMachineClient } from './apiMachine';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createSessionLiveWorkProducer } from '@/daemon/lifecycle/sessionLiveWorkProducer';
import type { TrackedSession } from '@/daemon/types';
import { projectMachineWorkSummary } from '@/daemon/machines/machineWorkSummary';
import { createEmptyMachineSetupDesiredV1, type MachineSetupSourceV1 } from '@happier-dev/protocol';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}

function createPublicationBoundary(answer: (write: MachineUpdateStateRequest) => unknown | Promise<unknown>) {
  const machine: Machine = { id: 'daemon-publication', encryptionMode: 'plain', metadata: null,
    metadataVersion: 0, daemonState: { status: 'running' }, daemonStateVersion: 0 };
  const attempts: MachineUpdateStateRequest[] = [];
  const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
    if (event !== 'machine-update-state') throw new Error(`Unexpected publication: ${event}`);
    const write = MachineUpdateStateRequestSchema.parse(payload);
    attempts.push(write);
    return answer(write);
  } });
  const client = new ApiMachineClient(String(1), machine);
  Reflect.set(client, 'socket', socket);
  return { client, machine, attempts };
}

describe('daemon state publication cost contract', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('publishes ordered attached preset references with writes proportional to attachment changes, not preset count', async () => {
    const boundary = createPublicationBoundary(write => ({ result: 'success',
      version: write.expectedVersion + 1, daemonState: write.daemonState }));
    const count = 1024;
    const sources: MachineSetupSourceV1 = Array.from({ length: count }, (_, index) => ({
      kind: 'accountPreset', presetId: `preset-${index}`, presetRevision: 1, setup: {},
    }));
    sources.splice(1, 0, { kind: 'direct', setup: {} }, { kind: 'bundledPreset',
      ref: { pluginId: 'example.machine', localId: 'base', revision: 'v2' }, setup: {} });
    const desired = { ...createEmptyMachineSetupDesiredV1(), sources };
    boundary.machine.metadata = { host: 'worker', platform: 'linux', happyCliVersion: 'test',
      homeDir: '/home/worker', happyHomeDir: '/home/worker/.happier', setup: desired };
    const updates = { status: 'satisfied' as const, pendingAll: 4, pendingSecurity: 2 };
    try {
      await boundary.client.publishMachineSetupUpdates(updates);
      const expected: unknown[] = [];
      for (const source of sources) {
        if (source.kind === 'accountPreset') expected.push({ kind: source.kind,
          presetId: source.presetId, presetRevision: source.presetRevision });
        if (source.kind === 'bundledPreset') expected.push({ kind: source.kind, ref: source.ref });
      }
      expect(boundary.machine.daemonState?.setup).toMatchObject({ attachedPresets: expected });
      expect(boundary.attempts).toHaveLength(1);
      for (let repeat = 0; repeat < 20; repeat++) {
        expect(await boundary.client.publishMachineSetupUpdates(updates)).toBe('unchanged');
      }
      // Desired revision and private source bodies are not public attachment facts.
      desired.revision++;
      sources[1] = { kind: 'direct', setup: { items: [] } };
      expect(await boundary.client.publishMachineSetupUpdates(updates)).toBe('unchanged');
      sources[0] = { kind: 'accountPreset', presetId: 'preset-0', presetRevision: 2, setup: {} };
      await boundary.client.publishMachineSetupUpdates(updates);
      expect(boundary.attempts).toHaveLength(2);
      [sources[0], sources[2]] = [sources[2]!, sources[0]!];
      await boundary.client.publishMachineSetupUpdates(updates);
      expect(boundary.attempts).toHaveLength(3);
      sources.splice(0, 1);
      await boundary.client.publishMachineSetupUpdates(updates);
      expect(boundary.attempts).toHaveLength(4);
      desired.sources = [{ kind: 'direct', setup: {} }];
      await boundary.client.publishMachineSetupUpdates(updates);
      expect(boundary.machine.daemonState?.setup).toMatchObject({ attachedPresets: [] });
      for (let repeat = 0; repeat < 20; repeat++) await boundary.client.publishMachineSetupUpdates(updates);
      // Socket publication boundary: initial frame + K=4 real changes for N=1025 attached presets.
      expect(boundary.attempts).toHaveLength(1 + 4);
      await boundary.client.publishMachineSetupUpdates({ status: 'unavailable' });
      expect(boundary.machine.daemonState?.setup).toMatchObject({ attachedPresets: [],
        updates: { status: 'unavailable', pendingAll: 4, pendingSecurity: 2 } });
    } finally { await boundary.client.shutdown(); }
  });

  it('pushes changed work facts when a second Session leaves the aggregate busy decision unchanged', async () => {
    const target = { serverId: 'home', machineId: 'work-facts', installationId: 'installation' };
    const attribution = { ...target, accountId: 'bob' };
    let sessions: TrackedSession[] = [{ trackingKey: legacyPidSessionTrackingKey(1), pid: 1, startedBy: 'daemon', happySessionId: 'first',
      requesterWorkAttributionV1: attribution }];
    // Only the Session runtime RPC boundary supplies observed work; the Session
    // producer, inventory and API publication binding all remain real.
    const source = createSessionLiveWorkProducer({ readSessions: () => sessions, readActivity: async () => ({
      session: 'active', input: 'settled', agents: 'settled', attention: 'settled',
    }) });
    const activity = createManagedActivityInventory({ producers: [source] });
    const summary = async () => projectMachineWorkSummary({ target, custodianAccountId: 'alice',
      inventory: await activity.read(), requesterIdentities: new Map([['bob', { accountId: 'bob', displayName: 'Bob' }]]) });
    const machine: Machine = { id: 'work-facts', encryptionMode: 'plain', metadata: null,
      metadataVersion: 0, daemonState: { status: 'running' }, daemonStateVersion: 0 };
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
      if (event !== 'machine-update-state') return { result: 'success', revision: 1 };
      const write = MachineUpdateStateRequestSchema.parse(payload);
      return { result: 'success', version: write.expectedVersion + 1, daemonState: write.daemonState };
    } });
    const client = new ApiMachineClient('token', machine, undefined,
      { managedActivity: { activity, admissionDrain: createDaemonAdmissionDrain() } });
    Reflect.set(client, 'socket', socket);
    try {
      client.setRPCHandlers({ spawnSession: async () => ({ type: 'success', sessionId: 'session' }),
        stopSession: async () => true, requestShutdown: () => {} });
      expect(await activity.readDecision()).toEqual({ kind: 'busy', reasons: ['session'] });
      expect(await summary()).toEqual({ kind: 'current', requesters: [
        { accountId: 'bob', displayName: 'Bob', sessions: 1, tasks: 0, terminals: 0 },
      ] });
      socket.emit.mockClear();
      for (let index = 0; index < 10; index++) await activity.read();
      expect(socket.emit.mock.calls.filter(([event, payload]) => event === 'machine-alive'
        && (payload as { workSummaryChanged?: unknown }).workSummaryChanged === true)).toHaveLength(0);
      sessions = [...sessions, { trackingKey: legacyPidSessionTrackingKey(2), pid: 2, startedBy: 'daemon', happySessionId: 'second',
        requesterWorkAttributionV1: attribution }];
      source.notifyChanged();
      expect(await activity.readDecision()).toEqual({ kind: 'busy', reasons: ['session'] });
      expect(socket.emit.mock.calls.filter(([event, payload]) => event === 'machine-alive'
        && (payload as { workSummaryChanged?: unknown }).workSummaryChanged === true)).toHaveLength(1);
      expect(await summary()).toEqual({ kind: 'current', requesters: [
        { accountId: 'bob', displayName: 'Bob', sessions: 2, tasks: 0, terminals: 0 },
      ] });
      expect(machine.daemonState).not.toHaveProperty('workSummaryChanged');
      await client.shutdown();
      socket.emit.mockClear();
      sessions = [];
      source.notifyChanged();
      await activity.read();
      expect(socket.emit).not.toHaveBeenCalled();
    } finally { activity.dispose(); await client.shutdown(); }
  });

  it.each([false, true])('withdraws a sanitized persisted Iroh endpoint through both receipts (capability failure: %s)', async failCapabilityReceipt => {
    const initialState: DaemonState = { status: 'running', peerMediation: { iroh: { endpoint: { endpointId: 'b'.repeat(64) } } } };
    const machine: Machine = { id: 'stale-iroh', encryptionMode: 'plain', metadata: null, metadataVersion: 0,
      daemonState: initialState, daemonStateVersion: 0 };
    let storedState = encodePlainMachineStoredContent(initialState);
    const writes: MachineUpdateStateRequest[] = [];
    let capabilityWrites = 0;
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
      if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) {
        const request = MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.parse(payload);
        expect(request.capabilities).not.toHaveProperty('irohMachineEndpoint');
        capabilityWrites++;
        if (failCapabilityReceipt && capabilityWrites === 2) throw new Error('Capability receipt unavailable');
        return { v: 1, result: 'success', revision: capabilityWrites };
      }
      if (event !== 'machine-update-state') throw new Error(`Unexpected publication: ${event}`);
      const request = MachineUpdateStateRequestSchema.parse(payload);
      writes.push(request);
      storedState = request.daemonState;
      return { result: 'success', version: request.expectedVersion + 1, daemonState: storedState };
    } });
    const client = new ApiMachineClient(String(1), machine);
    Reflect.set(client, 'socket', socket);
    const reconcile = () => client.updateDaemonState(state => ({ ...state, status: 'running' }));
    try {
      expect(machine.daemonState?.peerMediation?.iroh).toBeUndefined();
      expect(decodePlainMachineStoredContent(storedState)).toHaveProperty('peerMediation.iroh');
      // Capability readiness alone must not retire the outstanding content withdrawal.
      await client.publishOperationProtocolCapabilities({});
      if (failCapabilityReceipt) {
        await expect(reconcile()).rejects.toThrow('Capability receipt unavailable');
        expect(writes).toHaveLength(1);
      }
      await reconcile();
      expect(writes).toHaveLength(1);
      expect(decodePlainMachineStoredContent(storedState)).not.toHaveProperty('peerMediation.iroh');
      expect(capabilityWrites).toBe(failCapabilityReceipt ? 3 : 2);
      expect(await reconcile()).toBe('unchanged');
      expect(writes).toHaveLength(1);
    } finally { await client.shutdown(); }
  });

  it('joins concurrent equal changes and publishes only the latest pending state while retaining other fields', async () => {
    const first = deferred<void>();
    const boundary = createPublicationBoundary(async write => {
      if (write.expectedVersion === 0) await first.promise;
      return { result: 'success', version: write.expectedVersion + 1, daemonState: write.daemonState };
    });
    const { client, machine, attempts } = boundary;
    const update = (pid: number) => client.updateDaemonState(state => ({ ...state, status: 'running', pid }));
    try {
      const initial = update(1);
      await vi.waitFor(() => expect(attempts).toHaveLength(1));
      const equal = Array.from({ length: 32 }, () => update(1));
      await Promise.resolve();
      expect(attempts).toHaveLength(1);
      first.resolve();
      await Promise.all([initial, ...equal]);
      expect(attempts.map(write => write.expectedVersion)).toEqual([0]);
      const hold = deferred<void>();
      // Replace only the network boundary; all state reducers and codecs stay real.
      const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, payload) => {
        const write = MachineUpdateStateRequestSchema.parse(payload);
        attempts.push(write);
        if (write.expectedVersion === 1) await hold.promise;
        return { result: 'success', version: write.expectedVersion + 1, daemonState: write.daemonState };
      } });
      Reflect.set(client, 'socket', socket);
      const pending = [update(2)];
      await vi.waitFor(() => expect(attempts).toHaveLength(2));
      pending.push(update(3), update(4), client.updateDaemonState(state => ({ ...state, status: 'running', httpPort: 4321 })));
      await Promise.resolve();
      expect(attempts).toHaveLength(2);
      hold.resolve();
      await Promise.all(pending);
      expect(attempts.map(write => write.expectedVersion)).toEqual([0, 1, 2]);
      expect(machine.daemonState).toMatchObject({ pid: 4, httpPort: 4321 });
    } finally { first.resolve(); await client.shutdown(); }
  });

  it('rebases a conflict on the server version and preserves peer mediation alongside the latest local facts', async () => {
    const remote: DaemonState = { status: 'running', httpPort: 7654 };
    const { client, machine, attempts } = createPublicationBoundary(write => write.expectedVersion === 0
      ? { result: 'version-mismatch', version: 9, daemonState: encodePlainMachineStoredContent(remote) }
      : { result: 'success', version: write.expectedVersion + 1, daemonState: write.daemonState });
    try {
      const peerMediation = { loopback: {} };
      await Promise.all(Array.from({ length: 12 }, () => client.updateDaemonState(state => ({
        ...state, status: 'running', peerMediation,
      }))));
      expect(attempts.map(write => write.expectedVersion)).toEqual([0, 9]);
      expect(machine.daemonState).toMatchObject({ ...remote, peerMediation });
    } finally { await client.shutdown(); }
  });

  it('settles a failed attempt without retrying the same version and accepts a later explicit change', async () => {
    let failing = true;
    const { client, machine, attempts } = createPublicationBoundary(write => {
      if (failing) throw new Error('Publication transport unavailable');
      return { result: 'success', version: write.expectedVersion + 1, daemonState: write.daemonState };
    });
    try {
      const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => client.updateDaemonState(state => ({
        ...state, status: 'running', pid: 1,
      }))));
      expect(outcomes.every(result => result.status === 'rejected')).toBe(true);
      expect(attempts).toHaveLength(1);
      expect(machine.daemonStateVersion).toBe(0);
      failing = false;
      await client.updateDaemonState(state => ({ ...state, status: 'running', pid: 2 }));
      expect(machine.daemonState).toMatchObject({ pid: 2 });
    } finally { await client.shutdown(); }
  });

  it('publishes zero updates over a settled minute of inventory observations and one per real decision change', async () => {
    let now = 1000;
    const operations = createActionOperationStore({ now: () => now });
    const scope = { accountId: 'owner', machineId: 'daemon-publication' };
    operations.create({ operationId: 'waiting', actionId: 'machines.managed.power.set', scope,
      title: 'Waiting', cancellation: 'supported', inputIdentity: '{}' });
    operations.updateProgress('waiting', { kind: 'phase', phase: 'managed.intent.waiting-idle', label: 'Waiting' });
    const inventory = createManagedActivityInventory({ now: () => now, producers: [{
      read: operations.readLiveWork, subscribe: operations.subscribe,
    }] });
    const { client, machine, attempts } = createPublicationBoundary(write => ({
      result: 'success', version: write.expectedVersion + 1, daemonState: write.daemonState,
    }));
    const pending: Promise<unknown>[] = [];
    const unsubscribe = inventory.subscribe(decision => {
      pending.push(client.updateDaemonState(state => ({ ...state, status: 'running', managedActivity: decision })));
    });
    try {
      await inventory.readDecision();
      await Promise.all(pending);
      const settled = attempts.length;
      const settledDecisions = pending.length;
      for (let second = 1; second <= 60; second += 1) {
        now += 1000;
        operations.updateProgress('waiting', { kind: 'phase', phase: 'managed.intent.waiting-idle', label: `Waiting ${second}` });
        await inventory.readDecision();
        await Promise.all(pending);
      }
      expect(attempts.length - settled).toBe(0);
      expect(pending.length - settledDecisions).toBe(0);
      operations.create({ operationId: 'finite', actionId: 'projects.compute.exec', scope,
        title: 'Work', cancellation: 'supported', inputIdentity: '{}' });
      await inventory.readDecision(); await Promise.all(pending);
      expect(attempts.length - settled).toBe(1);
      expect(machine.daemonState?.managedActivity).toEqual({ kind: 'busy', reasons: ['finite'] });
      operations.succeed('finite', {});
      await inventory.readDecision(); await Promise.all(pending);
      expect(attempts.length - settled).toBe(2);
      expect(machine.daemonState?.managedActivity).toEqual({ kind: 'idle', since: now });
    } finally { unsubscribe(); inventory.dispose(); await client.shutdown(); }
  });
});


it('publishes setup updates only on real fact changes and preserves sibling observations', async () => {
    const f = createPublicationBoundary(write => ({ result: 'success', version: write.expectedVersion + 1, daemonState: write.daemonState }));
    const recipes = [{ ref: { pluginId: 'happier.machine.test', recipeId: 'fixture', revision: '1' }, status: 'satisfied' as const, steps: [] }];
    f.machine.metadata = { host: 'guest', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier',
      setup: { version: 1, revision: 3, sources: [{ kind: 'direct', setup: {} }], exclusions: [] } };
    f.machine.daemonState = { status: 'running', setup: { version: 1, desiredRevision: 3, status: 'satisfied', recipes } };
    try {
        const updates = { status: 'satisfied' as const, backend: 'apt', pendingSecurity: 2, pendingAll: 4, rebootNeeded: true };
        expect(await f.client.publishMachineSetupUpdates(updates)).toBe('published');
        for (let index = 0; index < 32; index++) {
            expect(await f.client.publishMachineSetupUpdates({ ...updates })).toBe('unchanged');
        }
        expect(f.attempts).toHaveLength(1);
        expect(f.machine.daemonState?.setup).toEqual({ version: 1, desiredRevision: 3, status: 'satisfied', recipes,
            attachedPresets: [], updates });
        expect(await f.client.publishMachineSetupUpdates({ ...updates, pendingSecurity: 0, pendingAll: 0 })).toBe('published');
        expect(f.attempts).toHaveLength(2);
        expect(f.machine.daemonState?.setup?.updates).toMatchObject({ pendingSecurity: 0, pendingAll: 0, rebootNeeded: true });
    } finally { await f.client.shutdown(); }
});

it('retains last-known update facts when a native check becomes unavailable without republishing equal failures', async () => {
    const f = createPublicationBoundary(write => ({ result: 'success', version: write.expectedVersion + 1, daemonState: write.daemonState }));
    const unavailable = { status: 'unavailable' as const, reason: 'required_fact_unavailable' as const };
    try {
        await f.client.publishMachineSetupUpdates(unavailable);
        for (let index = 0; index < 16; index++) await f.client.publishMachineSetupUpdates({ ...unavailable });
        expect(f.attempts).toHaveLength(1);
        expect(f.machine.daemonState?.setup?.updates).toEqual(unavailable);
        const known = { status: 'drifted' as const, backend: 'apt', pendingAll: 4, pendingSecurity: 0, rebootNeeded: false, checkedAt: 1_794_686_700_000 };
        await f.client.publishMachineSetupUpdates(known);
        await f.client.publishMachineSetupUpdates(unavailable);
        expect(f.machine.daemonState?.setup?.updates).toEqual({ ...unavailable,
            pendingAll: 4, pendingSecurity: 0, rebootNeeded: false, checkedAt: known.checkedAt });
        for (let index = 0; index < 16; index++) await f.client.publishMachineSetupUpdates({ ...unavailable });
        expect(f.attempts).toHaveLength(3);
        await f.client.publishMachineSetupUpdates(known);
        expect(f.machine.daemonState?.setup?.updates).toEqual(known);
        expect(f.attempts).toHaveLength(4);
    } finally { await f.client.shutdown(); }
});

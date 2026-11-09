import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { publishMachineMetadataOnce, readOpenedMachineMetadataSnapshot } from './machine/machineMetadataPublication';
import { createMachineContentCodec } from './machine/machineStoredContent';
import type { Machine } from './types';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { ApiMachineClient } from './apiMachine';
import { createApiMachineServicesBinding } from './machine/machineServicesBinding';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

const metadata = { host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: '/users/worker', happyHomeDir: '/users/worker/.happier' };
describe('ApiMachine resources policy CAS', () => {
  it('publishes typed watch changes only when admitted metadata changes that field', async () => {
    let watchChanges = 0;
    const watches = { v: 1 as const, watches: Array.from({ length: 1_000 }, (_, index) => ({ v: 1 as const,
      watchId: `watch-${index}`, name: `Worker ${index}`, adapter: { pluginId: 'acme.services', localId: 'native' },
      nativeResourceId: `unit-${index}`, lifecyclePurpose: 'infrastructure' as const })) };
    const machine: Machine = { id: 'machine', encryptionMode: 'plain', metadata: { ...metadata, serviceWatchesV1: watches },
      metadataVersion: 1, daemonState: null, daemonStateVersion: 0 };
    const serverUrl = 'https://watch-publication.example.test';
    const profile = await addServerProfile({ name: 'watch-publication', serverUrl, webappUrl: serverUrl });
    const serverId = 'srv_watch_publication';
    await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact',
      descriptor: { v: 1, homeServerIdentityId: serverId, canonicalServerUrl: serverUrl,
        revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] } });
    const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: [] } });
    let reads = 0;
    const binding = createApiMachineServicesBinding({ profileId: profile.id, machineId: machine.id,
      readMetadata() { reads++; return readOpenedMachineMetadataSnapshot(machine, true); },
      captureMetadataPort() { throw new Error('Read-only watch publication'); } });
    const notify = binding.notifyMetadataChanged;
    const detail = () => binding.execute({ actionId: 'machines.services.detail',
      context: { surface: 'cli', authority: 'present_user' }, input: { machineId: machine.id, serverId, serviceId: 'watch-17' },
      requesterAccountId: null, canReadEnvironments: async () => new Set(),
      observeEnvironmentAccessChanges: async () => ({ dispose: async () => {} }) });
    let nextMetadata = machine.metadata!;
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async () => ({ result: 'success',
      version: machine.metadataVersion + 1, metadata: encodePlainMachineStoredContent(nextMetadata) }) });
    const context = { getMachine: () => machine, socket, codec: createMachineContentCodec(machine), expectedDataEncryptionKey: null,
      isContentCurrent: () => true, retireAndRefreshContent: async () => {},
      notifyMetadataChanged(change?: Readonly<{ serviceWatchesChanged: boolean }>) {
        if (change?.serviceWatchesChanged !== false) watchChanges++;
        notify(change ?? { serviceWatchesChanged: true });
      } };
    try {
    expect(await detail()).toMatchObject({ kind: 'service', service: { name: 'Worker 17' } });
    reads = 0;
    for (let index = 0; index < 100; index++) {
      nextMetadata = { ...metadata, displayName: `Name ${index}`, serviceWatchesV1: structuredClone(watches) };
      await publishMachineMetadataOnce(context, { metadata: nextMetadata, expectedMetadataVersion: machine.metadataVersion });
    }
    expect(watchChanges).toBe(0);
    expect(reads).toBe(0);
    expect(machine.metadata?.serviceWatchesV1).toBe(watches);
    nextMetadata = { ...nextMetadata, serviceWatchesV1: { ...watches,
      watches: watches.watches.map((watch, index) => index === 17 ? { ...watch, name: 'Renamed worker' } : watch) } };
    await publishMachineMetadataOnce(context, { metadata: nextMetadata, expectedMetadataVersion: machine.metadataVersion });
    expect(watchChanges).toBe(1);
    expect(machine.metadata?.serviceWatchesV1).not.toBe(watches);
    expect(machine.metadata?.serviceWatchesV1).toMatchObject({ watches: expect.arrayContaining([{ ...watches.watches[17], name: 'Renamed worker' }]) });
    expect(await detail()).toMatchObject({ kind: 'service', service: { name: 'Renamed worker' } });
    } finally { await binding.dispose(); await fixture.dispose(); }
  });
  it('returns locked when a pending CAS loses its admitted content codec even if replacement content is ready', async () => {
    const machine: Machine = { id: 'machine', encryptionMode: 'e2ee', encryptionKey: new Uint8Array(32).fill(7),
      encryptionVariant: 'dataKey', dataEncryptionKey: 'old-owner-envelope', metadata, metadataVersion: 1,
      daemonState: null, daemonStateVersion: 0 };
    const refreshed: Machine = { ...machine, encryptionKey: new Uint8Array(32).fill(8), dataEncryptionKey: 'new-owner-envelope' };
    const client = new ApiMachineClient('token', machine, undefined, { loadMachine: async () => refreshed });
    const initialCodec = Reflect.get(client, 'machineContentCodec');
    const admittedCodec = createMachineContentCodec(machine);
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async () => {
      // Only the network load is fake; run the incumbent key/codec refresh itself.
      await Reflect.apply(Reflect.get(client, 'refreshMachineFromServer'), client, []);
      expect(Reflect.get(client, 'machineContentCodec')).not.toBe(initialCodec);
      expect(Reflect.get(client, 'machineContentReady')).toBe(true);
      return { result: 'success', version: 2, metadata: admittedCodec.encodeStored({ ...metadata, displayName: 'Old key result' }) };
    } });
    Reflect.set(client, 'socket', socket);
    expect(await client.compareAndSwapMachineMetadata({ metadata: { ...metadata, displayName: 'Old key result' }, expectedMetadataVersion: 1 }))
      .toEqual({ status: 'locked' });
    expect(machine.metadataVersion).toBe(1);
  });
  it('keeps a metadata CAS pending beyond the generic ACK deadline and applies its committed revision', async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const machine: Machine = { id: 'machine', encryptionMode: 'plain', metadata, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 };
    const changed = { ...metadata, displayName: 'Accepted' };
    let acknowledge!: (answer: unknown) => void;
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: () => new Promise(resolve => { acknowledge = resolve; }) });
    let outcome = 'pending';
    const pending = publishMachineMetadataOnce({ getMachine: () => machine, socket, codec: createMachineContentCodec(machine),
      expectedDataEncryptionKey: null, isContentCurrent: () => true, retireAndRefreshContent: async () => {}, notifyMetadataChanged: () => {} },
      { metadata: changed, expectedMetadataVersion: 1 });
    void pending.then(() => { outcome = 'applied'; }, () => { outcome = 'failed'; });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(outcome).toBe('pending');
    expect(machine.metadataVersion).toBe(1);
    acknowledge({ result: 'success', version: 2, metadata: encodePlainMachineStoredContent(changed) });
    await expect(pending).resolves.toMatchObject({ status: 'applied', metadata: changed, metadataVersion: 2 });
    expect(socket.emitWithAck).toHaveBeenCalledOnce();
  });

  it('returns a concurrent metadata revision without retrying the write', async () => {
    const machine: Machine = { id: 'machine', encryptionMode: 'plain', metadata, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 };
    const changed = { ...metadata, displayName: 'Concurrent' };
    const socket = createApiSessionSocketStub({ emitWithAckResult: { result: 'version-mismatch', version: 2, metadata: encodePlainMachineStoredContent(changed) } });
    socket.connected = true;
    const context = { getMachine: () => machine, socket, codec: createMachineContentCodec(machine), expectedDataEncryptionKey: null,
      isContentCurrent: () => true, retireAndRefreshContent: async () => {}, notifyMetadataChanged: () => {} };
      expect(await publishMachineMetadataOnce(context, { metadata: { ...metadata, displayName: 'Mine' }, expectedMetadataVersion: 1 }))
        .toEqual({ status: 'conflict', metadata: changed, metadataVersion: 2 });
      expect(readOpenedMachineMetadataSnapshot(machine, true)).toEqual({ status: 'ready', metadata: changed, metadataVersion: 2 });
      expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
      expect(await publishMachineMetadataOnce(context, { metadata, expectedMetadataVersion: 1 })).toMatchObject({ status: 'conflict', metadataVersion: 2 });
      expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
  });

  it('updates the current same-key cache after a pending ACK, not the replaced snapshot', async () => {
    let current: Machine = { id: 'machine', encryptionMode: 'plain', metadata, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 };
    const admitted = current;
    const changed = { ...metadata, displayName: 'Accepted' };
    const socket = createApiSessionSocketStub();
    socket.connected = true;
    socket.emitWithAck.mockImplementation(async () => {
      current = { ...current };
      return { result: 'success', version: 2, metadata: encodePlainMachineStoredContent(changed) };
    });
    expect(await publishMachineMetadataOnce({ getMachine: () => current, socket,
      codec: createMachineContentCodec(current), expectedDataEncryptionKey: null, isContentCurrent: () => true,
      retireAndRefreshContent: async () => {}, notifyMetadataChanged: () => {} }, { metadata: changed, expectedMetadataVersion: 1 }))
      .toMatchObject({ status: 'applied', metadataVersion: 2 });
    expect(readOpenedMachineMetadataSnapshot(current, true)).toMatchObject({ status: 'ready', metadata: changed, metadataVersion: 2 });
    expect(admitted.metadataVersion).toBe(1);
  });

  it('uses the E2EE codec and rejects a key change during ACK without advancing the cache', async () => {
    const machine: Machine = { id: 'machine', encryptionMode: 'e2ee', encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'dataKey',
      metadata, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 };
    const codec = createMachineContentCodec(machine);
    const changed = { ...metadata, displayName: 'Encrypted' };
    const socket = createApiSessionSocketStub();
    socket.connected = true;
    let contentCurrent = true;
    socket.emitWithAck.mockImplementation(async (_event, payload) => {
      expect(payload).toMatchObject({ expectedDataEncryptionKey: 'owner-envelope', expectedVersion: 1 });
      const content = typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'metadata') : undefined;
      expect(typeof content).toBe('string');
      expect(codec.decodeStored(String(content))).toEqual(changed);
      contentCurrent = false;
      return { result: 'success', version: 2, metadata: codec.encodeStored(changed) };
    });
    await expect(publishMachineMetadataOnce({ getMachine: () => machine, socket, codec, expectedDataEncryptionKey: 'owner-envelope',
      isContentCurrent: () => contentCurrent, retireAndRefreshContent: async () => {}, notifyMetadataChanged: () => {} },
      { metadata: changed, expectedMetadataVersion: 1 })).rejects.toMatchObject({ retryable: false });
    expect(machine.metadataVersion).toBe(1);
    expect(machine.metadata).toEqual(metadata);
    expect(readOpenedMachineMetadataSnapshot(machine, false)).toEqual({ status: 'locked' });
  });
});

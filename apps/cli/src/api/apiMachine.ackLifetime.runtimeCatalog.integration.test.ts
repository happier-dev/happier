import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import type { Machine } from './types';
import { ApiMachineClient } from './apiMachine';

const metadata = { host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: '/users/worker', happyHomeDir: '/users/worker/.happier' };
const machine = (): Machine => ({ id: 'machine-1', encryptionMode: 'plain', metadata, metadataVersion: 1, daemonState: null, daemonStateVersion: 0 });

describe('ApiMachine operation-owned ACK lifetimes', () => {
  it.each(['metadata', 'metadata-default-watches', 'state'] as const)('settles committed %s CAS transport loss without applying its mutation twice', async kind => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const current = machine();
    const client = new ApiMachineClient('token', current);
    const isMetadata = kind !== 'state';
    let committed: string | null = null;
    let version = isMetadata ? current.metadataVersion : current.daemonStateVersion;
    let lost = false;
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (_event, raw) => {
      const request = raw as { expectedVersion: number; metadata?: string; daemonState?: string };
      const content = request.metadata ?? request.daemonState;
      if (content === undefined) throw new Error('Missing publication content');
      const result = request.expectedVersion === version ? 'success' : 'version-mismatch';
      if (result === 'success') { committed = content; version += 1; }
      if (!lost) { lost = true; throw new Error('socket has been disconnected'); }
      return { result, version, [isMetadata ? 'metadata' : 'daemonState']: committed };
    } });
    Reflect.set(client, 'socket', socket);
    const pending = isMetadata
      ? client.updateMachineMetadata(previous => ({ ...previous!, displayName: `${previous?.displayName ?? ''}!`,
        ...(kind === 'metadata-default-watches' ? { serviceWatchesV1: { v: 1 as const, watches: [] } } : {}) }))
      : client.updateDaemonState(previous => ({ ...previous, status: previous?.status ?? 'running', contributionRegistryProjectionRevision: (previous?.contributionRegistryProjectionRevision ?? 0) + 1 }));
    // Observe rejection immediately while fake time advances; the assertion below
    // still owns whether the operation should resolve or reject.
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(10_000);
    if (!isMetadata) {
      // ISO-PROVISION (2026-11-01 14:05 UTC) preserves rejection on uncertain transport failure without replay.
      await expect(pending).rejects.toThrow('socket has been disconnected');
      expect(current.daemonState).toBeNull();
      expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
      return;
    }
    await expect(pending).resolves.toBe('published');
    expect(current.metadata?.displayName).toBe('!');
    if (kind === 'metadata-default-watches') expect(current.metadata?.serviceWatchesV1).toEqual({ v: 1, watches: [] });
    expect(socket.emitWithAck).toHaveBeenCalledTimes(2);
    expect(socket.emitWithAck.mock.calls[1]?.[1]).toEqual(socket.emitWithAck.mock.calls[0]?.[1]);
  });

  it('rebases a lost metadata ACK only after a newer foreign commit', async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const current = machine();
    const client = new ApiMachineClient('token', current);
    let version = current.metadataVersion;
    const foreign = { ...metadata, displayName: 'Foreign', host: 'new-worker' };
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (_event, raw) => {
      const request = raw as { expectedVersion: number; metadata: string };
      if (version === 1) {
        // Our first commit and a foreign commit both precede reconnect.
        version += 2;
        throw new Error('socket has been disconnected');
      }
      if (request.expectedVersion !== version) {
        return { result: 'version-mismatch', version, metadata: encodePlainMachineStoredContent(foreign) };
      }
      version += 1;
      return { result: 'success', version, metadata: request.metadata };
    } });
    Reflect.set(client, 'socket', socket);
    const pending = client.updateMachineMetadata(previous => ({ ...previous!, displayName: `${previous?.displayName ?? ''}!` }));
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBe('published');
    expect(current.metadata).toEqual({ ...foreign, displayName: 'Foreign!' });
    expect(current.metadataVersion).toBe(4);
    expect(socket.emitWithAck).toHaveBeenCalledTimes(3);
    expect(socket.emitWithAck.mock.calls[1]?.[1]).toEqual(socket.emitWithAck.mock.calls[0]?.[1]);
    expect(socket.emitWithAck.mock.calls[2]?.[1]).toMatchObject({ expectedVersion: 3 });
  });

  it.each([
    { event: 'machine-update-state', run: (client: ApiMachineClient) => client.updateDaemonState(() => ({ status: 'running' })),
      answer: { result: 'success', version: 1, daemonState: encodePlainMachineStoredContent({ status: 'running' }) }, result: 'published' },
  ])('awaits $event through delayed server settlement without replay', async ({ event, run, answer, result }) => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const client = new ApiMachineClient('token', machine());
    let acknowledge!: (answer: unknown) => void;
    const socket = createApiSessionSocketStub({ connected: true,
      emitWithAck: () => new Promise(resolve => { acknowledge = resolve; }),
    });
    Reflect.set(client, 'socket', socket);
    let outcome = 'pending';
    const pending = run(client);
    void pending.then(() => { outcome = 'settled'; }, () => { outcome = 'failed'; });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(outcome).toBe('pending');
    acknowledge(answer);
    await expect(pending).resolves.toEqual(result);
    const emitted = socket.emitWithAck.mock.calls.filter(([name]) => name === event);
    expect(emitted).toHaveLength(1);
  });
});
